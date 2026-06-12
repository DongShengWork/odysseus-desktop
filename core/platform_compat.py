"""跨平台操作系统兼容性辅助工具。

Odysseus 最初是一个仅支持 Linux/macOS/Docker 的应用。此模块集中管理
使其在 Windows 上 *原生* 运行所需的小量操作系统差异，以便
代码库的其余部分可以保持平台无关。请从此处导入，而不是在
各个模块中散布 ``os.name == "nt"`` 检查（以及仅 POSIX 的调用）。

设计规则：
  * 仅标准库 + ctypes — 不新增第三方依赖（不使用 psutil/pywinpty）。
  * POSIX 行为不变；Windows 获得一个保真等效实现或安全的、有文档说明的空操作。
"""

from __future__ import annotations

import os
import ntpath
import shutil
import subprocess
from pathlib import Path
import sys
from typing import List, Optional
import platform

IS_WINDOWS = os.name == "nt"
IS_POSIX = not IS_WINDOWS
# 允许在 Apple Silicon Mac 上使用 APFEL 支持及 ARM 原生二进制推荐。
IS_APPLE_SILICON = (
    IS_POSIX
    and platform.system() == "Darwin"
    and platform.machine().lower()
    in {
        "arm64",
        "aarch64",
    }
)


# ── 文件权限 ────────────────────────────────────────────────────────
def safe_chmod(path, mode: int) -> bool:
    """在 Windows 上为无害空操作的 ``os.chmod``。

    在 POSIX 上我们应用权限模式 — 用于将密钥/密钥文件锁定为 0o600。
    Windows 没有 POSIX 权限位；用户配置文件下的文件已经通过 ACL 限制给该用户，
    因此我们跳过而不是抛出异常。当模式实际被应用时返回 True。
    """
    if IS_WINDOWS:
        return False
    try:
        os.chmod(path, mode)
        return True
    except OSError:
        return False


# ── 进程分离 / 存活检查 / 终止 ────────────────────────────────────
def detached_popen_kwargs() -> dict:
    """返回 :class:`subprocess.Popen` 的关键字参数，使子进程完全分离，
    以便在其启动的请求/流结束后继续存活。

    POSIX: ``start_new_session=True`` (setsid) — 新会话 + 新进程组。
    Windows: ``CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`` — 子进程获得
    自己的进程组（因此父进程控制台关闭时不会终止），并且与任何控制台分离。
    """
    if IS_WINDOWS:
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200) | getattr(
            subprocess, "DETACHED_PROCESS", 0x00000008
        )
        return {"creationflags": flags}
    return {"start_new_session": True}


def pid_alive(pid: Optional[int]) -> bool:
    """如果 ``pid`` 对应的进程正在运行，返回 True。

    POSIX 使用经典的 ``os.kill(pid, 0)`` 探测。这在 Windows 上是 **不安全** 的：
    CPython 的 ``os.kill`` 对 CTRL_C/CTRL_BREAK 以外的任何信号调用
    ``TerminateProcess(handle, sig)``，因此 ``os.kill(pid, 0)`` 会 *杀死*
    正在检查的进程。我们改用 Win32 API 打开进程并读取其退出码。
    """
    if not pid:
        return False
    if IS_WINDOWS:
        import ctypes
        from ctypes import wintypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid)
        )
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return False
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def kill_process_tree(pid: Optional[int]) -> None:
    """终止 ``pid`` 及其所有后代进程。

    POSIX: 向整个进程组发信号（``killpg``），如果 pid 不是组领导则回退到
    普通 ``kill``。
    Windows: ``taskkill /T /F`` 遍历并杀死子进程树（没有进程组信号机制）。
    """
    if not pid:
        return
    if IS_WINDOWS:
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            pass
        return
    import signal

    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass


# ── Shell / 可执行文件解析 ───────────────────────────────────────────
_BASH_CACHE: Optional[str] = None
_BASH_PROBED = False

# 当 bash 不在 PATH 中时，常见的 Git-for-Windows 安装位置，用于探测。
_WINDOWS_BASH_ROOT_ENV_VARS = (
    "ProgramFiles",
    "ProgramW6432",
    "ProgramFiles(x86)",
    "LocalAppData",
)
_WINDOWS_BASH_DEFAULT_ROOTS = (
    r"C:\Program Files\Git",
    r"C:\Program Files (x86)\Git",
)
_WINDOWS_BASH_RELATIVE_PATHS = (
    ("bin", "bash.exe"),
    ("usr", "bin", "bash.exe"),
)

# 添加到远程 SSH 探测命令中的路径，用于查找可能不在 PATH 中的工具，如 nvidia-smi。
_SSH_PATH_MEMBERS = (
    "/usr/bin",
    "/usr/local/bin",
    "/usr/local/cuda/bin",
    "/usr/lib/wsl/lib"
)
# 在 WSL 和其他可能不在 PATH 中的 Linux 发行版上 nvidia-smi 的备用位置。
NVIDIA_PATH_CANDIDATES = (
    "/usr/bin/nvidia-smi",
    "/usr/local/bin/nvidia-smi",
    "/usr/local/cuda/bin/nvidia-smi",
    "/usr/lib/wsl/lib/nvidia-smi",
)


def _ssh_path_override() -> str:
    """构建用于远程 SSH Shell 探测的 PATH 导出代码片段。"""
    return f"export PATH=\"$PATH:{':'.join(_SSH_PATH_MEMBERS)}\"; "


SSH_PATH_OVERRIDE = _ssh_path_override()


def _windows_bash_fallbacks() -> List[str]:
    roots: List[str] = []
    for env_name in _WINDOWS_BASH_ROOT_ENV_VARS:
        base = os.environ.get(env_name)
        if base:
            roots.append(ntpath.join(base, "Git"))
    roots.extend(_WINDOWS_BASH_DEFAULT_ROOTS)

    paths: List[str] = []
    seen = set()
    for root in roots:
        for rel in _WINDOWS_BASH_RELATIVE_PATHS:
            path = ntpath.join(root, *rel)
            key = path.lower()
            if key not in seen:
                seen.add(key)
                paths.append(path)
    return paths


def _is_windows_bash_stub(path: str) -> bool:
    lowered = path.lower()
    return (
        "system32\\bash.exe" in lowered
        or "sysnative\\bash.exe" in lowered
        or "windowsapps\\bash.exe" in lowered
    )


def git_bash_path(path: str | Path) -> str:
    """将路径转换为适合 Windows 上 Git Bash 使用的 POSIX 风格。

    将盘符（例如 'C:\\path'）转换为 POSIX 格式 '/c/path'，
    并使用正斜杠。
    """
    p = Path(path)
    p_str = p.as_posix()
    if IS_WINDOWS and len(p_str) >= 2 and p_str[1] == ":":
        drive = p_str[0].lower()
        return f"/{drive}{p_str[2:]}"
    return p_str



def find_bash() -> Optional[str]:
    """定位真正的 ``bash`` 解释器，或返回 None。

    在 Windows 上通常是 Git Bash / WSL。许多 Odysseus 功能
    （agent ``bash`` 工具、后台作业、Cookbook 脚本）会输出 bash 语法，
    因此当存在 bash 时，我们使用它并保持与 POSIX 的完全一致性。
    结果会被缓存。
    """
    global _BASH_CACHE, _BASH_PROBED
    if _BASH_PROBED:
        return _BASH_CACHE
    _BASH_PROBED = True
    found = which_tool("bash")
    if found and IS_WINDOWS and _is_windows_bash_stub(found):
        found = None
    if not found and IS_WINDOWS:
        for cand in _windows_bash_fallbacks():
            if os.path.exists(cand):
                found = cand
                break
    _BASH_CACHE = found
    return found


def has_bash() -> bool:
    return find_bash() is not None


def which_tool(name: str) -> Optional[str]:
    """``shutil.which`` 的增强版本，同时尝试 Windows 可执行文件后缀。

    在 Windows 上，Node/npm 的快捷方式是 ``npx.cmd``/``npm.cmd``，
    二进制文件以 ``.exe`` 结尾；裸 ``which("npx")`` 可能因为 PATHEXT
    设置而错过它们。我们先尝试裸名称，然后尝试常用后缀。
    """
    found = shutil.which(name)
    if found:
        return found
    if IS_WINDOWS:
        for ext in (".cmd", ".exe", ".bat"):
            found = shutil.which(name + ext)
            if found:
                return found
    return None


def run_script_argv(script_path) -> List[str]:
    """构建执行 Shell *脚本文件* 所需的 argv。

    优先使用 bash（以便现有的 ``.sh`` 包装器可以直接工作，包括在
    Windows 上通过 Git Bash）。在 Windows 上没有 bash 时，回退到
    ``cmd.exe /c`` — 简单命令仍可运行，但 bash 特有语法不可用。
    需要保证 bash 的调用者应先检查 :func:`has_bash` 并显示清晰的
    "安装 Git Bash" 提示信息。
    """
    bash = find_bash()
    if bash:
        return [bash, str(script_path)]
    if IS_WINDOWS:
        comspec = os.environ.get("ComSpec", "cmd.exe")
        return [comspec, "/c", str(script_path)]
    return ["sh", str(script_path)]


def is_wsl() -> bool:
    """如果在 Windows Subsystem for Linux (WSL) 内运行，返回 True。"""
    import sys
    if sys.platform.startswith("linux") or os.name == "posix":
        try:
            with open("/proc/version", "r") as f:
                if "microsoft" in f.read().lower():
                    return True
        except Exception:
            pass
    return False


def translate_path(path_str: str) -> str:
    """将路径（可能为 Windows 路径）转换为当前操作系统格式。

    特别处理在 WSL 下运行时的 Windows 路径（例如 C:\\foo 或 C:/foo），
    将其转换为 /mnt/c/foo。
    同时处理标准路径规范化以避免字符串断裂。
    """
    if not path_str:
        return path_str

    if is_wsl():
        path_str = path_str.replace("\\", "/")
        import re
        m = re.match(r"^([a-zA-Z]):(.*)", path_str)
        if m:
            drive = m.group(1).lower()
            rest = m.group(2)
            if not rest.startswith("/"):
                rest = "/" + rest
            return f"/mnt/{drive}{rest}"

    try:
        return str(Path(path_str).resolve())
    except Exception:
        return path_str


def get_wsl_windows_user_profile() -> Optional[str]:
    """从 WSL 内部获取 Windows 主机的用户配置文件路径。"""
    if not is_wsl():
        return None
    try:
        r = run_wsl_windows_powershell("Write-Output $env:USERPROFILE", timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            return translate_path(r.stdout.strip())
    except Exception:
        pass

    try:
        users_dir = "/mnt/c/Users"
        if os.path.isdir(users_dir):
            for entry in os.listdir(users_dir):
                if entry not in ("All Users", "Default", "Default User", "desktop.ini", "Public"):
                    path = os.path.join(users_dir, entry)
                    if os.path.isdir(path):
                        return path
    except Exception:
        pass
    return None


def _ssh_exec_argv(
    remote: str,
    ssh_port: str | None,
    *,
    remote_cmd: str | None = None,
    connect_timeout: int | None = None,
    strict_host_key_checking: bool | None = None,
) -> list[str]:
    """构建一致的 ssh argv 以执行远程命令。"""
    argv = ["ssh"]
    if connect_timeout is not None:
        argv.extend(["-o", f"ConnectTimeout={int(connect_timeout)}"])
    if strict_host_key_checking is not None:
        argv.extend(
            [
                "-o",
                "StrictHostKeyChecking=yes"
                if strict_host_key_checking
                else "StrictHostKeyChecking=no",
            ]
        )
    if ssh_port and ssh_port != "22":
        argv.extend(["-p", str(ssh_port)])
    argv.append(remote)
    if remote_cmd is not None:
        argv.append(remote_cmd)
    return argv


def run_ssh_command(
    remote: str,
    ssh_port: str | None,
    remote_cmd: str,
    *,
    timeout: float,
    connect_timeout: int | None = None,
    strict_host_key_checking: bool | None = None,
    text: bool = True,
) -> subprocess.CompletedProcess:
    """运行 ssh 命令，使用统一的超时和 stderr/stdout 捕获。"""
    return subprocess.run(
        _ssh_exec_argv(
            remote,
            ssh_port,
            remote_cmd=remote_cmd,
            connect_timeout=connect_timeout,
            strict_host_key_checking=strict_host_key_checking,
        ),
        timeout=timeout,
        capture_output=True,
        text=text,
    )


def _windows_powershell_argv(
    command: str,
    *,
    no_profile: bool = True,
    non_interactive: bool = True,
) -> List[str]:
    argv: List[str] = ["powershell.exe"]
    if no_profile:
        argv.append("-NoProfile")
    if non_interactive:
        argv.append("-NonInteractive")
    argv.extend(["-Command", command])
    return argv


def run_wsl_windows_powershell(
    command: str,
    *,
    timeout: float = 5,
) -> subprocess.CompletedProcess[str]:
    """从 WSL 在 Windows 主机上运行 PowerShell 命令。

    在 WSL 外部调用时抛出 ``RuntimeError``。
    """

    if not is_wsl():
        raise RuntimeError("run_wsl_windows_powershell is only supported in WSL")
    return subprocess.run(
        _windows_powershell_argv(command),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
