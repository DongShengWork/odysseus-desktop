"""
tool_execution.py

Agent 循环的工具调度器和结果格式化器。
将工具块路由到 MCP 服务器或原生实现。

从 agent_tools.py 提取。
"""

import asyncio
import collections
import json
import logging
import os
import pathlib
import re
import sys
import time
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple

from src.tool_security import is_public_blocked_tool, owner_is_admin_or_single_user
from src.tool_policy import ToolPolicy
from src.constants import MAX_OUTPUT_CHARS, MAX_READ_CHARS, MAX_DIFF_LINES, DATA_DIR
from src.tool_utils import _truncate, get_mcp_manager

# Agent 子进程的持久化工作目录。
# 解析为 <repo_root>/data，即 Docker 中的绑定挂载卷
# （/app/data），手动安装时为本地数据目录。
# 使用此路径作为 cwd 和 HOME，避免 agent 在临时容器层中
# 静默创建文件，这些文件在下一次重建时丢失。
_AGENT_WORKDIR = DATA_DIR


def _unified_diff(old: str, new: str, path: str) -> Optional[Dict[str, Any]]:
    """构建文件写入的 unified diff，用于在聊天中展示。

    返回 {"text": <unified diff>, "added": N, "removed": M, "new_file": bool}
    如果无文本变化则返回 None。截断非常大的 diff。
    """
    if old == new:
        return None
    import difflib

    old_lines = old.splitlines()
    new_lines = new.splitlines()
    label = path or "file"
    diff_lines = list(difflib.unified_diff(
        old_lines, new_lines,
        fromfile=f"a/{label}", tofile=f"b/{label}",
        lineterm="",
    ))
    added = sum(1 for line in diff_lines if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in diff_lines if line.startswith("-") and not line.startswith("---"))
    truncated = False
    if len(diff_lines) > MAX_DIFF_LINES:
        diff_lines = diff_lines[:MAX_DIFF_LINES]
        truncated = True
    text = "\n".join(diff_lines)
    if truncated:
        text += f"\n… diff truncated at {MAX_DIFF_LINES} lines"
    return {
        "text": text,
        "added": added,
        "removed": removed,
        "new_file": old == "",
        "file": os.path.basename(path) or (path or "file"),
    }


async def _do_edit_file(content: str, workspace: Optional[str] = None) -> Dict[str, Any]:
    """对磁盘文件的精确字符串替换编辑。

    content 为 JSON：{"path", "old_string", "new_string", "replace_all"?}。
    如果 old_string 缺失或不唯一（除非 replace_all）则失败，避免模型
    静默编辑错误的位置。为 UI 返回 unified diff。
    设置了工作区时限制在工作区内（与 write_file 策略相同）。
    """
    try:
        args = json.loads(content) if content.strip().startswith("{") else {}
    except (json.JSONDecodeError, TypeError):
        args = {}
    raw_path = (args.get("path") or "").strip()
    old = args.get("old_string", "")
    new = args.get("new_string", "")
    replace_all = bool(args.get("replace_all", False))
    if not raw_path:
        return {"error": "edit_file: path required", "exit_code": 1}
    # 设置了工作区时限制在工作区内，否则与 read/write_file
    # 一样使用白名单 + 敏感文件策略。
    try:
        path = (_resolve_tool_path_in_workspace(workspace, raw_path)
                if workspace else _resolve_tool_path(raw_path))
    except ValueError as e:
        return {"error": f"edit_file: {e}", "exit_code": 1}
    if old == "":
        return {"error": "edit_file: old_string required (use write_file to create a file)", "exit_code": 1}
    if old == new:
        return {"error": "edit_file: old_string and new_string are identical", "exit_code": 1}

    def _apply():
        with open(path, "r", encoding="utf-8") as f:
            original = f.read()
        count = original.count(old)
        if count == 0:
            return original, None, "not_found"
        if count > 1 and not replace_all:
            return original, None, f"not_unique:{count}"
        updated = original.replace(old, new) if replace_all else original.replace(old, new, 1)
        with open(path, "w", encoding="utf-8") as f:
            f.write(updated)
        return original, updated, "ok"

    try:
        original, updated, status = await asyncio.to_thread(_apply)
    except FileNotFoundError:
        return {"error": f"edit_file: {path}: not found (use write_file to create it)", "exit_code": 1}
    except (IsADirectoryError, UnicodeDecodeError):
        return {"error": f"edit_file: {path}: not an editable text file", "exit_code": 1}
    except PermissionError:
        return {"error": f"edit_file: {path}: permission denied", "exit_code": 1}
    except OSError as e:
        return {"error": f"edit_file: {path}: {e}", "exit_code": 1}

    if status == "not_found":
        return {"error": f"edit_file: old_string not found in {path}. Read the file and match it exactly.", "exit_code": 1}
    if status.startswith("not_unique"):
        n = status.split(":", 1)[1]
        return {"error": f"edit_file: old_string is not unique in {path} ({n} matches). Add surrounding context or set replace_all=true.", "exit_code": 1}

    n = original.count(old)
    result = {"output": f"Edited {path} ({n} replacement{'s' if n != 1 else ''})", "exit_code": 0}
    diff = _unified_diff(original, updated, path)
    if diff:
        result["diff"] = diff
    return result

# ---------------------------------------------------------------------------
# read_file / write_file 的路径限制
# ---------------------------------------------------------------------------
# read_file + write_file 是仅管理员工具，但 agent 提供的
# 路径由模型控制。管理员聊天中的提示注入可能
# 武器化 "read /etc/shadow" 或 "write ~/.ssh/authorized_keys"，
# 而管理员不会察觉。
#
# 策略：
#   1. 敏感子路径拒绝列表 — 首先检查。阻止 .ssh、
#      .gnupg、shell rc 文件、token/env 文件，即使它们
#      的上层根路径在白名单中。
#   2. 白名单 — 仅 agent 合法需要的目录
#      （项目 data/、系统 tmp）。$HOME 不在默认列表中。
#   3. 可选额外根路径 — 管理员可通过
#      "tool_path_extra_roots" 设置（路径字符串列表）添加。
# ---------------------------------------------------------------------------

_SENSITIVE_BASENAMES: set[str] = {
    ".ssh", ".gnupg", ".gitconfig",
    ".bashrc", ".bash_profile", ".bash_logout",
    ".zshrc", ".zprofile", ".zshenv",
    ".profile", ".tcshrc", ".cshrc",
    ".env", ".netrc",
}

_SENSITIVE_FILE_PATTERNS: tuple[str, ...] = (
    "authorized_keys", "id_rsa", "id_ed25519", "id_ecdsa",
    "known_hosts",
)


def _is_sensitive_path(resolved: str) -> bool:
    """如果 *resolved* 落入敏感目录或匹配敏感文件名，
    则返回 True — 无论其上层根路径是什么。
    """
    parts = resolved.split(os.sep)
    filenames: set[str] = {parts[-1]} if parts else set()

    # 检查路径组件中是否有敏感目录。
    for part in parts:
        if part in _SENSITIVE_BASENAMES:
            return True

    # 对文件名检查已知敏感文件。
    for pat in _SENSITIVE_FILE_PATTERNS:
        if pat in filenames:
            return True

    return False


def _tool_path_roots() -> list[str]:
    """返回 read_file / write_file 可操作的目录根路径列表。
    默认：项目 data/ + 系统临时目录。额外根路径
    从 ``tool_path_extra_roots`` 设置加载。
    """
    roots: list[str] = []

    # 项目数据目录 — agent 的主要工作区。
    from src.constants import DATA_DIR
    roots.append(DATA_DIR)

    # /tmp（及其在 macOS 上的真实路径 /private/tmp）。
    roots.append("/tmp")
    try:
        private_tmp = os.path.realpath("/tmp")
        if private_tmp != "/tmp":
            roots.append(private_tmp)
    except OSError:
        pass

    # $TMPDIR — macOS 上每个用户的临时根路径（如 /var/folders/.../T/）。
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir:
        roots.append(tmpdir)

    # 从设置中选择性的额外根路径。
    try:
        from src.settings import get_setting
        extra = get_setting("tool_path_extra_roots")
        if isinstance(extra, list):
            roots.extend(str(r) for r in extra if r)
    except Exception:
        pass

    # 去重；解析符号链接以消除包含歧义。
    seen: set[str] = set()
    out: list[str] = []
    for r in roots:
        try:
            real = os.path.realpath(r)
        except OSError:
            continue
        if real in seen:
            continue
        seen.add(real)
        out.append(real)
    return out


def _resolve_tool_path(raw_path: str) -> str:
    """解析并限制模型提供的路径。

    检查顺序：
      1. 非空路径。
      2. 敏感子路径拒绝列表（阻止 .ssh、.gnupg 等，
         即使根路径在白名单中）。
      3. 白名单包含（必须位于某个根路径下）。

    成功时返回真实路径。被拒绝时抛出 ValueError。
    比较前解析符号链接。
    """
    if raw_path is None or not str(raw_path).strip():
        raise ValueError("path is required")
    expanded = os.path.expanduser(str(raw_path).strip())
    resolved = os.path.realpath(expanded)

    if _is_sensitive_path(resolved):
        raise ValueError(
            f"path '{raw_path}' is inside a sensitive directory "
            f"(e.g. .ssh, .gnupg) or matches a sensitive filename"
        )

    for root in _tool_path_roots():
        if resolved == root:
            return resolved
        try:
            common = os.path.commonpath([resolved, root])
        except ValueError:
            continue
        if common == root:
            return resolved
    raise ValueError(
        f"path '{raw_path}' is outside the allowed roots"
    )


def _resolve_tool_path_in_workspace(workspace: str, raw_path: str) -> str:
    """将模型提供的路径限制在活动工作区内。

    叠加在上游的路径策略之上：工作区是允许的
    根目录（相对路径在其下解析；逃逸它的路径被拒绝），
    并且敏感文件拒绝列表（.ssh、.gnupg、id_rsa、…）仍然适用
    于其中。当未设置工作区时，调用者使用 _resolve_tool_path（默认的
    data/tmp 白名单）代替。
    """
    if raw_path is None or not str(raw_path).strip():
        raise ValueError("path is required")
    base = os.path.realpath(workspace)
    expanded = os.path.expanduser(str(raw_path).strip())
    candidate = expanded if os.path.isabs(expanded) else os.path.join(base, expanded)
    resolved = os.path.realpath(candidate)
    if _is_sensitive_path(resolved):
        raise ValueError(
            f"path '{raw_path}' is inside a sensitive directory "
            f"(e.g. .ssh, .gnupg) or matches a sensitive filename"
        )
    if resolved != base:
        # normcase 使大小写不敏感文件系统上的包含检查成立
        # （Windows、默认 macOS）：Windows 上小写化，POSIX 上无操作。
        # 跨 Windows 盘符（C: 对 D:）或混合绝对/相对时 commonpath 抛出
        # ValueError — 两者都表示"外部"，所以异常块拒绝它们。
        nbase = os.path.normcase(base)
        try:
            if os.path.commonpath([os.path.normcase(resolved), nbase]) != nbase:
                raise ValueError
        except ValueError:
            raise ValueError(f"path '{raw_path}' is outside the workspace ({workspace})")
    return resolved

# Bash + python 工具过去共享单个 60 秒超时。这对
# 一次性命令足够，但对真正的工作负载（pip
# install、ffmpeg 转换等）远远不够 — 更糟的是，agent 看到
# 60 秒超时后会因为没有可报告的内容而沉默。
# 新的默认值有意设置为足够长：让真实工作不会被中途
# 杀掉，但有上限以便失控进程（无限循环、挂起的连接等）
# 最终释放工作线程。
# 用户可以通过聊天停止按钮提前取消 — 当 SSE 流被断开时，
# 运行子进程的 asyncio 任务被取消，
# 子进程被 finally 块终止。
DEFAULT_BASH_TIMEOUT = 60 * 60     # 1 hour
DEFAULT_PYTHON_TIMEOUT = 60 * 60

# 长时间运行的子进程执行中推送进度事件的频率。
# 前端更关心"存活"而非"每个字节" — 2 秒是最佳选择。

PROGRESS_INTERVAL_S = 2.0
# 尾部缓冲区大小 — 保留最近 N 行 stdout +
# stderr，使进度事件包含"现在在做什么"
# 的片段，而不必携带全部输出。
PROGRESS_TAIL_LINES = 12

# 代码导航工具的 Python 回退路径忽略的目录，避免结果被
# VCS 内部/依赖树/构建缓存污染。ripgrep 已
# 遵循 .gitignore；这是无 rg 路径的对等底线（同时
# 也作为传给 rg 的显式排除列表，即使没有 .gitignore 也能跳过）。
_CODENAV_SKIP_DIRS = frozenset({
    ".git", ".hg", ".svn", "node_modules", "venv", ".venv", "__pycache__",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", "dist", "build",
    ".next", ".cache", "site-packages", ".idea", ".tox",
})
# 每个工具的结果上限（保持工具输出简洁 + 对模型友好）。
_CODENAV_MAX_HITS = 200
_CODENAV_MAX_LINE = 400


def _resolve_search_root(raw_path: str, workspace: Optional[str] = None) -> str:
    """解析并限制代码导航路径（grep/glob/ls）。

    设置了工作区时，工作区文件夹为根路径，提供的路径
    限制在其中（与 read_file 策略相同）。未设置时，空路径
    默认为 agent 的主根路径（项目数据目录），提供的路径
    受全局白名单 + 敏感文件策略限制。
    """
    raw = (raw_path or "").strip()
    if workspace:
        if not raw:
            return os.path.realpath(workspace)
        return _resolve_tool_path_in_workspace(workspace, raw)
    if not raw:
        roots = _tool_path_roots()
        return roots[0] if roots else os.path.realpath(".")
    return _resolve_tool_path(raw)

logger = logging.getLogger(__name__)


async def _run_subprocess_streaming(
    proc: asyncio.subprocess.Process,
    *,
    timeout: float,
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
) -> Tuple[str, str, Optional[int], bool]:
    """运行子进程直到完成，流式传输进度。

    按行读取 stdout + stderr 到环形缓冲区，
    使定期进度回调能发出近期输出的"尾部"
    而无需等待完整结果。返回
    (完整stdout, 完整stderr, 返回码, 是否超时)。

    `timed_out=True` 表示进程因运行超过
    `timeout` 秒而被终止。在此之前缓冲的
    输出仍然会返回。
    """
    started = time.time()
    stdout_full: list[str] = []
    stderr_full: list[str] = []
    tail = collections.deque(maxlen=PROGRESS_TAIL_LINES)

    async def _reader(stream, full_buf, label: str):
        if stream is None:
            return
        while True:
            line = await stream.readline()
            if not line:
                break
            decoded = line.decode("utf-8", errors="replace").rstrip("\n")
            full_buf.append(decoded)
            if label == "err":
                tail.append(f"! {decoded}")
            else:
                tail.append(decoded)

    async def _progress_emitter():
        # 跳过第一次推送 — 许多命令在进度间隔内就完成了，
        # 0 秒的"进度"事件只会增加 UI 噪音。

        await asyncio.sleep(PROGRESS_INTERVAL_S)
        while True:
            if progress_cb:
                try:
                    await progress_cb({
                        "elapsed_s": round(time.time() - started, 1),
                        "tail": "\n".join(list(tail)),
                    })
                except Exception:
                    # 进度是最佳努力 — 绝不让 UI 卡顿
                    # 中断底层子进程。
                    pass
            await asyncio.sleep(PROGRESS_INTERVAL_S)

    rd_out = asyncio.create_task(_reader(proc.stdout, stdout_full, "out"))
    rd_err = asyncio.create_task(_reader(proc.stderr, stderr_full, "err"))
    prog_task = asyncio.create_task(_progress_emitter()) if progress_cb else None

    timed_out = False
    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        timed_out = True
        try:
            proc.kill()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
        except Exception:
            pass
    except asyncio.CancelledError:
        # 用户点击停止/SSE 流断开。终止子进程使其
        # 不会作为孤儿进程继续运行。重新抛出使 agent 循环的
        # 取消操作按用户期望传播。
        try:
            proc.kill()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
        except Exception:
            pass
        # 尽力：重新抛出前停止读取器和发射器。
        for t in (rd_out, rd_err):
            t.cancel()
        if prog_task is not None:
            prog_task.cancel()
        raise
    finally:
        if prog_task is not None and not prog_task.done():
            prog_task.cancel()
            try:
                await prog_task
            except (asyncio.CancelledError, Exception):
                pass
        # 等待读取器完成管道排空。
        for t in (rd_out, rd_err):
            try:
                await asyncio.wait_for(t, timeout=1)
            except Exception:
                pass

    return (
        "\n".join(stdout_full),
        "\n".join(stderr_full),
        proc.returncode,
        timed_out,
    )

_ADMIN_TOOLS = {
    "app_api",
    "manage_endpoints",
    "manage_mcp",
    "manage_webhooks",
    "manage_tokens",
    "manage_settings",
    "download_model",
    "serve_model",
    "serve_preset",
    "stop_served_model",
    "cancel_download",
}


def _owner_is_admin(owner: Optional[str]) -> bool:
    """为 agent 工具执行镜像路由级别的管理员行为。"""
    return owner_is_admin_or_single_user(owner)

# ---------------------------------------------------------------------------
# MCP 支持的工具体辅助函数
# ---------------------------------------------------------------------------

# 映射旧工具名称 -> (MCP 服务器 ID, MCP 工具名称)
_MCP_TOOL_MAP = {
    "bash":           ("bash",       "bash"),
    "python":         ("python",     "python"),
    "read_file":      ("filesystem", "read_file"),
    "write_file":     ("filesystem", "write_file"),
    "web_search":     ("web_search", "web_search"),
    "web_fetch":      ("web_fetch",  "web_fetch"),
    "generate_image": ("image_gen",  "generate_image"),
}


def _parse_generate_image(content: str) -> Dict:
    lines = content.strip().split("\n")
    args = {"prompt": lines[0].strip() if lines else ""}
    for i, key in enumerate(["model", "size", "quality"], 1):
        if len(lines) > i and lines[i].strip():
            args[key] = lines[i].strip()
    return args


def _parse_manage_memory(content: str) -> Dict:
    lines = content.strip().split("\n")
    action = lines[0].strip().lower() if lines else ""
    args = {"action": action}
    if action == "add":
        args["text"] = lines[1].strip() if len(lines) > 1 else ""
        if len(lines) > 2 and lines[2].strip():
            args["category"] = lines[2].strip().lower()
    elif action == "edit":
        args["memory_id"] = lines[1].strip() if len(lines) > 1 else ""
        args["text"] = lines[2].strip() if len(lines) > 2 else ""
    elif action == "delete":
        args["memory_id"] = lines[1].strip() if len(lines) > 1 else ""
    elif action == "search":
        args["text"] = lines[1].strip() if len(lines) > 1 else ""
    elif action == "list":
        if len(lines) > 1 and lines[1].strip():
            args["category"] = lines[1].strip().lower()
    return args


def _parse_write_file(content: str) -> Dict:
    lines = content.split("\n", 1)
    return {"path": lines[0].strip(), "content": lines[1] if len(lines) > 1 else ""}


_MCP_ARG_PARSERS: Dict[str, Callable[[str], Dict[str, str]]] = {
    "bash":           lambda c: {"command": c},
    "python":         lambda c: {"code": c},
    "web_search":     lambda c: {"query": c.split("\n")[0].strip()},
    "web_fetch":      lambda c: {"url": c.split("\n")[0].strip()},
    "read_file":      lambda c: {"path": c.split("\n")[0].strip()},
    "write_file":     _parse_write_file,
    "generate_image": _parse_generate_image,
    "manage_memory":  _parse_manage_memory,
}


def _build_mcp_args(tool: str, content: str) -> Dict:
    """将代码块文本内容转换为结构化的 MCP 参数。"""
    parser = _MCP_ARG_PARSERS.get(tool)
    return parser(content) if parser else {}


async def _call_mcp_tool(
    tool: str,
    content: str,
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
    workspace: Optional[str] = None,
) -> Dict:
    """通过 MCP 管理器路由旧工具调用，带有直接回退路径。"""
    mcp = get_mcp_manager()
    if not mcp:
        return await _direct_fallback(tool, content, progress_cb=progress_cb, workspace=workspace) or {"error": f"MCP manager not available for tool '{tool}'", "exit_code": 1}

    server_id, tool_name = _MCP_TOOL_MAP[tool]
    qualified = f"mcp__{server_id}__{tool_name}"
    args = _build_mcp_args(tool, content)
    result = await mcp.call_tool(qualified, args)

    # 如果 MCP 服务器未连接，尝试直接回退
    if isinstance(result, dict) and result.get("exit_code") == 1 and "not connected" in result.get("error", ""):
        fallback = await _direct_fallback(tool, content, progress_cb=progress_cb, workspace=workspace)
        if fallback:
            return fallback

    # generate_image 作为纯文本 MCP 工具运行，所以保存的图片 URL 永远不会
    # 到达 agent 循环的结构化转发（它通过 result["image_url"]
    # 上的 buildImageBubble 渲染图片）。从工具 stdout 中提取出来，
    # 使图片确定性地渲染 — 不依赖模型在文本中回显 URL
    # （模型可能会破坏/幻觉化 URL）。
    if tool == "generate_image":
        _promote_image_fields(result)

    return result


def _promote_image_fields(result: Dict) -> None:
    """从成功的 generate_image MCP 文本结果中提取图片 URL（+ prompt/model/size）
    到结构化字段中，agent 循环已将其转发到
    buildImageBubble。仅对 exit_code 0 的字典结果操作；按模式
    匹配生成的图片 URL（绝对或相对），对
    结果的措辞具有鲁棒性。"""
    if not isinstance(result, dict) or result.get("exit_code") != 0:
        return
    out = result.get("stdout") or ""
    m = re.search(r'(?:https?://[^\s)\]]+)?/api/generated-image/[A-Za-z0-9._-]+', out)
    if not m:
        return
    result["image_url"] = m.group(0).strip()
    for field, pat in (
        ("image_prompt", r'^Generated image for:\s*(.+)$'),
        ("image_model", r'^model:\s*(.+)$'),
        ("image_size", r'^size:\s*(.+)$'),
    ):
        fm = re.search(pat, out, re.M)
        if fm:
            result[field] = fm.group(1).strip()


_BG_MARKERS = {"#!bg", "#bg", "# bg", "#background", "# background", "@background", "# @background"}


def _split_bg_marker(content: str):
    """如果 bash 内容的第一非空行是后台标记
    （如 `#!bg`），返回 (True, 去除标记的命令)；否则 (False, 内容)。"""
    lines = content.split("\n")
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i < len(lines) and lines[i].strip().lower() in _BG_MARKERS:
        del lines[i]
        return True, "\n".join(lines).strip()
    return False, content


async def _direct_fallback(
    tool: str,
    content: str,
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
    workspace: Optional[str] = None,
) -> Optional[Dict]:
    """八个曾经作为 stdio MCP 服务器存在于 mcp_servers/
    的工具的进程内执行路径。这些服务器已被删除，
    改用原生执行；此函数现在是正式路径，
    不是回退方案。保留名称以兼容调用者。

    `progress_cb` 在 bash/python 子进程运行时定期调用，
    传递 `{elapsed_s, tail}` 负载。其他工具
    忽略此参数。
    """
    # 继承环境变量 + 强制设置合理的终端，使接触
    # terminfo 的任何内容（调用 `clear`、`tput`、`os.system("clear")`、
    # 或探测 $TERM 的脚本）不会产生大量 "TERM environment variable
    # not set" 错误。Agent 的 bash/python 工具调用以 PIPE
    # stdin/stdout（无真正 TTY）运行，所以 curses/termios 仍不工作 —
    # 但至少带有附带 TERM 查找的非交互式代码
    # 不再失败。COLUMNS/LINES 给终端宽度感知工具（less、
    # rich 等）合理的默认值而非 0×0。
    _subproc_env = {
        **os.environ,
        "TERM": "xterm-256color",
        "COLUMNS": "120",
        "LINES": "40",
        "HOME": _AGENT_WORKDIR,
    }

    try:
        if tool == "bash":
            proc = await asyncio.create_subprocess_shell(
                content,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_subproc_env,
                cwd=workspace or _AGENT_WORKDIR,
            )
            stdout, stderr, rc, timed_out = await _run_subprocess_streaming(
                proc,
                timeout=DEFAULT_BASH_TIMEOUT,
                progress_cb=progress_cb,
            )
            if timed_out:
                return {"error": f"bash: timed out after {DEFAULT_BASH_TIMEOUT}s — process killed", "exit_code": 124, "stdout": _truncate(stdout, MAX_OUTPUT_CHARS), "stderr": _truncate(stderr, MAX_OUTPUT_CHARS)}
            output = stdout.rstrip()
            err = stderr.rstrip()
            if err:
                output = (output + "\nSTDERR: " + err).strip() if output else "STDERR: " + err
            output = _truncate(output, MAX_OUTPUT_CHARS)
            return {"output": output or "(no output)", "exit_code": rc or 0}

        if tool == "python":
            # 在子进程中运行用户代码，避免无限循环或崩溃
            # 拖垮整个服务器。-I = 隔离模式（跳过
            # user site，不继承 PYTHONPATH）以确保安全。
            proc = await asyncio.create_subprocess_exec(
                # 使用运行中的解释器 — Windows 上没有 `python3.exe`，
                # 这曾经导致 agent 的 `python` 工具在那里失败。
                (sys.executable or "python"), "-I", "-c", content,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_subproc_env,
                cwd=workspace or _AGENT_WORKDIR,
            )
            stdout, stderr, rc, timed_out = await _run_subprocess_streaming(
                proc,
                timeout=DEFAULT_PYTHON_TIMEOUT,
                progress_cb=progress_cb,
            )
            if timed_out:
                return {"error": f"python: timed out after {DEFAULT_PYTHON_TIMEOUT}s — process killed", "exit_code": 124, "stdout": _truncate(stdout, MAX_OUTPUT_CHARS), "stderr": _truncate(stderr, MAX_OUTPUT_CHARS)}
            output = stdout.rstrip()
            err = stderr.rstrip()
            if err:
                output = (output + "\nSTDERR: " + err).strip() if output else "STDERR: " + err
            output = _truncate(output, MAX_OUTPUT_CHARS)
            return {"output": output or "(no output)", "exit_code": rc or 0}

        if tool == "read_file":
            # 参数：第 1 行是纯路径（向后兼容）或 JSON
            # {path, offset?, limit?}，其中 offset/limit 是基于 1 的行范围。
            raw_path, offset, limit = content.split("\n", 1)[0].strip(), 0, 0
            _stripped = content.strip()
            if _stripped.startswith("{"):
                try:
                    _a = json.loads(_stripped)
                    raw_path = str(_a.get("path", "")).strip()
                    offset = int(_a.get("offset") or 0)
                    limit = int(_a.get("limit") or 0)
                except (json.JSONDecodeError, TypeError, ValueError):
                    pass
            try:
                path = (_resolve_tool_path_in_workspace(workspace, raw_path)
                        if workspace else _resolve_tool_path(raw_path))
            except ValueError as e:
                return {"error": f"read_file: {e}", "exit_code": 1}
            try:
                # 在线程中运行阻塞读取以保持循环响应。
                def _read():
                    if offset > 0 or limit > 0:
                        # 行范围读取：切片 [offset, offset+limit)。
                        start = max(offset, 1)
                        out, n, budget = [], 0, MAX_READ_CHARS
                        with open(path, "r", encoding="utf-8", errors="replace") as f:
                            for i, line in enumerate(f, 1):
                                if i < start:
                                    continue
                                if limit > 0 and n >= limit:
                                    break
                                out.append(line)
                                n += 1
                                budget -= len(line)
                                if budget <= 0:
                                    out.append(f"\n... [truncated at {MAX_READ_CHARS} chars]")
                                    break
                        return "".join(out)
                    with open(path, "r", encoding="utf-8", errors="replace") as f:
                        return f.read(MAX_READ_CHARS + 1)
                data = await asyncio.to_thread(_read)
            except FileNotFoundError:
                return {"error": f"read_file: {path}: not found", "exit_code": 1}
            except PermissionError:
                return {"error": f"read_file: {path}: permission denied", "exit_code": 1}
            except IsADirectoryError:
                return {"error": f"read_file: {path}: is a directory (use ls)", "exit_code": 1}
            except OSError as e:
                return {"error": f"read_file: {path}: {e}", "exit_code": 1}
            if not (offset > 0 or limit > 0) and len(data) > MAX_READ_CHARS:
                data = data[:MAX_READ_CHARS] + f"\n... [truncated at {MAX_READ_CHARS} chars]"
            return {"output": data, "exit_code": 0}

        if tool == "write_file":
            lines = content.split("\n", 1)
            raw_path = lines[0].strip()
            body = lines[1] if len(lines) > 1 else ""
            try:
                path = (_resolve_tool_path_in_workspace(workspace, raw_path)
                        if workspace else _resolve_tool_path(raw_path))
            except ValueError as e:
                return {"error": f"write_file: {e}", "exit_code": 1}
            try:
                def _write():
                    # 捕获先前内容（尽最大努力，文本），以便显示
                    # 编辑前后的 diff。缺失/二进制文件 → 视为空。
                    old = ""
                    try:
                        with open(path, "r", encoding="utf-8") as f:
                            old = f.read()
                    except (FileNotFoundError, IsADirectoryError, UnicodeDecodeError, OSError):
                        old = ""
                    d = os.path.dirname(path)
                    if d:
                        os.makedirs(d, exist_ok=True)
                    with open(path, "w", encoding="utf-8") as f:
                        f.write(body)
                    return old, len(body)
                old_content, size = await asyncio.to_thread(_write)
            except PermissionError:
                return {"error": f"write_file: {path}: permission denied", "exit_code": 1}
            except OSError as e:
                return {"error": f"write_file: {path}: {e}", "exit_code": 1}
            diff = _unified_diff(old_content, body, path)
            result = {"output": f"Wrote {size} bytes to {path}", "exit_code": 0}
            if diff:
                result["diff"] = diff
            return result

        if tool == "grep":
            # 参数 (JSON)：{pattern, path?, glob?, ignore_case?, max_results?}。
            # 裸字符串 → 视为 pattern。
            args: Dict[str, Any] = {}
            _s = (content or "").strip()
            if _s.startswith("{"):
                try:
                    args = json.loads(_s)
                except json.JSONDecodeError:
                    args = {}
            else:
                args = {"pattern": _s}
            pattern = str(args.get("pattern", "")).strip()
            if not pattern:
                return {"error": "grep: pattern is required", "exit_code": 1}
            ignore_case = bool(args.get("ignore_case"))
            glob_pat = str(args.get("glob", "") or "").strip()
            try:
                max_hits = int(args.get("max_results") or _CODENAV_MAX_HITS)
            except (TypeError, ValueError):
                max_hits = _CODENAV_MAX_HITS
            max_hits = max(1, min(max_hits, _CODENAV_MAX_HITS))
            try:
                root = _resolve_search_root(str(args.get("path", "")), workspace)
            except ValueError as e:
                return {"error": f"grep: {e}", "exit_code": 1}

            def _grep():
                import re as _re
                import shutil
                rg = shutil.which("rg")
                if rg:
                    cmd = [rg, "--line-number", "--no-heading", "--color=never",
                           "--max-count", str(max_hits)]
                    if ignore_case:
                        cmd.append("--ignore-case")
                    if glob_pat:
                        cmd += ["--glob", glob_pat]
                    # 即使目录树没有 .gitignore 也排除垃圾目录，
                    # 使结果与 Python 回退的跳过集合匹配。
                    for _d in _CODENAV_SKIP_DIRS:
                        cmd += ["--glob", f"!**/{_d}/**"]
                    cmd += ["--regexp", pattern, root]
                    try:
                        import subprocess
                        p = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
                        lines = [ln for ln in (p.stdout or "").splitlines() if ln][:max_hits]
                        return lines, None
                    except subprocess.TimeoutExpired:
                        return None, "grep: timed out"
                    except Exception as _e:
                        return None, f"grep: {_e}"
                # Python 回退（无 ripgrep）：遍历 + 正则。
                try:
                    rx = _re.compile(pattern, _re.IGNORECASE if ignore_case else 0)
                except _re.error as _e:
                    return None, f"grep: bad pattern: {_e}"
                import fnmatch
                hits = []
                if os.path.isfile(root):
                    file_iter = [root]
                else:
                    file_iter = []
                    for dp, dns, fns in os.walk(root):
                        dns[:] = [d for d in dns if d not in _CODENAV_SKIP_DIRS]
                        for fn in fns:
                            if glob_pat and not fnmatch.fnmatch(fn, glob_pat):
                                continue
                            file_iter.append(os.path.join(dp, fn))
                for fp in file_iter:
                    if len(hits) >= max_hits:
                        break
                    try:
                        with open(fp, "r", encoding="utf-8", errors="strict") as f:
                            for i, line in enumerate(f, 1):
                                if rx.search(line):
                                    hits.append(f"{fp}:{i}:{line.rstrip()[:_CODENAV_MAX_LINE]}")
                                    if len(hits) >= max_hits:
                                        break
                    except (UnicodeDecodeError, OSError):
                        continue  # 跳过二进制/不可读文件
                return hits, None

            lines, err = await asyncio.to_thread(_grep)
            if err:
                return {"error": err, "exit_code": 1}
            if not lines:
                return {"output": f"No matches for {pattern!r} under {root}", "exit_code": 0}
            out = "\n".join(ln[:_CODENAV_MAX_LINE] for ln in lines)
            if len(lines) >= max_hits:
                out += f"\n... [capped at {max_hits} matches]"
            return {"output": _truncate(out), "exit_code": 0}

        if tool == "glob":
            args = {}
            _s = (content or "").strip()
            if _s.startswith("{"):
                try:
                    args = json.loads(_s)
                except json.JSONDecodeError:
                    args = {}
            else:
                args = {"pattern": _s}
            pattern = str(args.get("pattern", "")).strip()
            if not pattern:
                return {"error": "glob: pattern is required", "exit_code": 1}
            try:
                root = _resolve_search_root(str(args.get("path", "")), workspace)
            except ValueError as e:
                return {"error": f"glob: {e}", "exit_code": 1}

            def _glob():
                from pathlib import Path
                base = Path(root)
                if not base.is_dir():
                    return None, f"glob: {root}: not a directory"
                matched = []
                try:
                    for p in base.rglob(pattern):
                        if set(p.relative_to(base).parts) & _CODENAV_SKIP_DIRS:
                            continue
                        try:
                            mtime = p.stat().st_mtime
                        except OSError:
                            mtime = 0
                        matched.append((mtime, str(p)))
                        if len(matched) > _CODENAV_MAX_HITS * 5:
                            break
                except (OSError, ValueError) as _e:
                    return None, f"glob: {_e}"
                matched.sort(key=lambda t: t[0], reverse=True)  # newest first
                return [pth for _, pth in matched[:_CODENAV_MAX_HITS]], None

            paths, err = await asyncio.to_thread(_glob)
            if err:
                return {"error": err, "exit_code": 1}
            if not paths:
                return {"output": f"No files matching {pattern!r} under {root}", "exit_code": 0}
            out = "\n".join(paths)
            if len(paths) >= _CODENAV_MAX_HITS:
                out += f"\n... [capped at {_CODENAV_MAX_HITS} files]"
            return {"output": _truncate(out), "exit_code": 0}

        if tool == "ls":
            raw_path = ""
            _s = (content or "").strip()
            if _s.startswith("{"):
                try:
                    raw_path = str(json.loads(_s).get("path", "")).strip()
                except json.JSONDecodeError:
                    raw_path = ""
            else:
                raw_path = _s.split("\n", 1)[0].strip()
            try:
                root = _resolve_search_root(raw_path, workspace)
            except ValueError as e:
                return {"error": f"ls: {e}", "exit_code": 1}

            def _ls():
                if not os.path.isdir(root):
                    return None, f"ls: {root}: not a directory"
                rows = []
                try:
                    with os.scandir(root) as it:
                        for entry in it:
                            if entry.name.startswith("."):
                                continue
                            try:
                                is_dir = entry.is_dir(follow_symlinks=False)
                                size = entry.stat(follow_symlinks=False).st_size if not is_dir else 0
                            except OSError:
                                continue
                            rows.append((is_dir, entry.name, size))
                except (PermissionError, OSError) as _e:
                    return None, f"ls: {_e}"
                rows.sort(key=lambda r: (not r[0], r[1].lower()))  # dirs first, then name
                lines = [f"{root}:"]
                for is_dir, name, size in rows[:_CODENAV_MAX_HITS]:
                    lines.append(f"  {name}/" if is_dir else f"  {name}  ({size} B)")
                if len(rows) > _CODENAV_MAX_HITS:
                    lines.append(f"  ... [{len(rows) - _CODENAV_MAX_HITS} more]")
                if not rows:
                    lines.append("  (empty)")
                return "\n".join(lines), None

            out, err = await asyncio.to_thread(_ls)
            if err:
                return {"error": err, "exit_code": 1}
            return {"output": _truncate(out), "exit_code": 0}

        if tool == "web_search":
            from src.search import comprehensive_web_search
            raw = content.strip()
            query = raw
            time_filter = None
            max_pages = 5
            # 允许 JSON 格式参数：{"query": "...", "time_filter": "day", "max_pages": 7}
            if raw.startswith("{"):
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict) and "query" in parsed:
                        query = str(parsed.get("query", "")).strip()
                        tf = parsed.get("time_filter") or parsed.get("freshness")
                        if isinstance(tf, str) and tf.lower() in ("day", "week", "month", "year"):
                            time_filter = tf.lower()
                        mp = parsed.get("max_pages")
                        if isinstance(mp, int) and 1 <= mp <= 10:
                            max_pages = mp
                except json.JSONDecodeError:
                    pass
            if not query:
                query = raw.split("\n")[0].strip()
            # 未明确指定时从查询措辞自动检测新鲜度
            if time_filter is None:
                q_lc = query.lower()
                if any(kw in q_lc for kw in ("today", "latest", "breaking", "this morning", "right now", "currently")):
                    time_filter = "day"
                elif any(kw in q_lc for kw in ("this week", "past week", "recent news", "last few days")):
                    time_filter = "week"
                elif any(kw in q_lc for kw in ("this month", "past month")):
                    time_filter = "month"
                elif " news" in q_lc or q_lc.startswith("news ") or q_lc.endswith(" news"):
                    time_filter = "week"
            loop = asyncio.get_running_loop()
            text, sources = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: comprehensive_web_search(
                        query,
                        max_pages=max_pages,
                        time_filter=time_filter,
                        return_sources=True,
                    ),
                ),
                timeout=30,
            )
            output = text[:MAX_OUTPUT_CHARS] if len(text) > MAX_OUTPUT_CHARS else text
            if sources:
                output += "\n\n<!-- SOURCES:" + json.dumps(sources) + " -->"
            return {"output": output, "exit_code": 0}

        if tool == "web_fetch":
            # 轻量级单 URL 获取。包装深度研究使用的 SSRF 安全获取器，
            # 因此私有/环回/元数据地址已在那里被阻止。
    
            from src.search.content import fetch_webpage_content
            raw = content.strip()
            url = ""
            # 接受 JSON 参数 ({"url": "..."}) 或纯 URL/域名。
            if raw.startswith("{"):
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict):
                        url = str(parsed.get("url") or "").strip()
                except json.JSONDecodeError:
                    url = ""
            if not url:
                # 非 JSON（或 JSON 无可用 url）：仅取第一行，
                # 使 URL 后跟评论的仍能解析。
                url = raw.split("\n")[0].strip()
            # 拒绝任何不是单个裸 URL/域名标记的内容。
            if not url or url.startswith("{") or any(c in url for c in (" ", "\t", "\n")):
                return {"error": "web_fetch: provide a single URL or domain, e.g. example.com", "exit_code": 1}
            low = url.lower()
            if "://" in low and not low.startswith(("http://", "https://")):
                return {"error": f"web_fetch: unsupported URL scheme (only http/https): {url[:80]}", "exit_code": 1}
            # 接受像 "example.com" 这样的裸域名，默认加 https。
            if not low.startswith(("http://", "https://")):
                url = "https://" + url
            loop = asyncio.get_running_loop()
            try:
                result = await asyncio.wait_for(
                    loop.run_in_executor(None, lambda: fetch_webpage_content(url, timeout=10)),
                    timeout=30,
                )
            except asyncio.TimeoutError:
                return {"error": f"web_fetch: timed out fetching {url}", "exit_code": 1}
            except Exception as e:
                # 直接 URL 获取可能遇到机器人保护/认证墙
                # （如 eBay 403）。将其视为模型可以推理的
                # 工具失败，而非未捕获的聊天流 500。
                return {"error": f"web_fetch: {url}: {e}", "exit_code": 1}
            err = result.get("error")
            text = (result.get("content") or "").strip()
            title = result.get("title") or ""

            if not text:
                if err:
                    return {"error": f"web_fetch: {url}: {err}", "exit_code": 1}
                # 无可提取文本：非 HTML 主体，或纯客户端渲染的
                # 外壳。Agent 可以回退到 builtin_browser 工具。
                return {"error": f"web_fetch: {url}: no readable text content (not HTML, or the page needs JS/login)", "exit_code": 1}

            header = (f"# {title}\n" if title else "") + f"Source: {url}\n\n"
            output = header + text
            if len(output) > MAX_OUTPUT_CHARS:
                output = output[:MAX_OUTPUT_CHARS] + "\n\n[...truncated]"
            return {"output": output, "exit_code": 0}

        # manage_memory / generate_image 仍作为 MCP 服务器存在
        # （mcp_servers/{memory,image_gen}_server.py）；上面的 MCP 路径
        # 处理它们。
    except Exception as e:
        return {"error": f"{tool}: {e}", "exit_code": 1}

    return None


# ---------------------------------------------------------------------------
# 调度器
# ---------------------------------------------------------------------------

async def execute_tool_block(
    block: Any,
    session_id: Optional[str] = None,
    disabled_tools: Optional[set] = None,
    tool_policy: Optional[ToolPolicy] = None,
    owner: Optional[str] = None,
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
    workspace: Optional[str] = None,
) -> Tuple[str, Dict]:
    """执行单个工具块。返回 (描述, 结果字典)。

    `progress_cb` 转发给长时间运行的子进程工具
    （bash、python），使 agent 循环能在命令执行中
    发送 `tool_progress` SSE 事件。其他工具忽略。
    """
    from src.tool_implementations import (
        do_create_document, do_update_document, do_edit_document,
        do_suggest_document, do_search_chats, do_manage_tasks,
        do_manage_skills, do_api_call, do_manage_endpoints,
        do_manage_mcp, do_manage_webhooks, do_manage_tokens,
        do_manage_documents, do_manage_settings, do_manage_notes,
        do_manage_calendar,
        do_download_model, do_serve_model, do_list_served_models, do_stop_served_model,
        do_tail_serve_output,
        do_list_downloads, do_cancel_download, do_search_hf_models, do_list_cached_models,
        do_list_serve_presets, do_serve_preset, do_adopt_served_model,
        do_list_cookbook_servers,
        do_edit_image, do_trigger_research, do_manage_research, do_resolve_contact,
        do_manage_contact,
        do_vault_search, do_vault_get, do_vault_unlock,
        do_app_api,
    )

    tool = block.tool_type
    content = block.content

    # 格式错误的工具调用检测：模型将 JSON 放在 ```python```（或类似）
    # 中而未命名工具。常见于 MiniMax 风格输出。
    # 返回有帮助的错误信息，使模型用正确格式重试。
    if tool in ("python", "json", "xml") and content.strip().startswith("{") and content.strip().endswith("}"):
        try:
            parsed = json.loads(content.strip())
            if isinstance(parsed, dict):
                desc = f"{tool}: misformatted tool call"
                result = {
                    "error": (
                        f"You wrote a JSON object inside a ```{tool}``` block, but that's not a tool call.\n"
                        "To call a tool, use the tool name as the fence tag, e.g.\n"
                        "```resolve_contact\n"
                        "{\"name\": \"...\"}\n"
                        "```\n"
                        "or\n"
                        "```send_email\n"
                        "{\"to\": \"...\", \"subject\": \"...\", \"body\": \"...\"}\n"
                        "```"
                    ),
                    "exit_code": 1,
                }
                return desc, result
        except (ValueError, TypeError):
            pass

    # 拒绝用户为此请求禁用的工具
    if tool_policy and tool_policy.blocks(tool):
        desc = f"{tool}: BLOCKED"
        result = {"error": tool_policy.reason_for(tool), "exit_code": 1}
        logger.info("Tool blocked by policy: %s", tool)
        return desc, result

    if disabled_tools and tool in disabled_tools:
        desc = f"{tool}: BLOCKED"
        result = {"error": f"Tool '{tool}' is disabled by user.", "exit_code": 1}
        logger.info(f"Tool blocked by user: {tool}")
        return desc, result

    if tool in _ADMIN_TOOLS and not _owner_is_admin(owner):
        desc = f"{tool}: BLOCKED"
        result = {"error": f"Tool '{tool}' requires an admin user.", "exit_code": 1}
        logger.warning("Admin tool blocked for non-admin owner=%r tool=%s", owner, tool)
        return desc, result

    if is_public_blocked_tool(tool) and not _owner_is_admin(owner):
        desc = f"{tool}: BLOCKED"
        result = {
            "error": (
                f"Tool '{tool}' is restricted to admin users on this deployment. "
                "Ask an admin to perform this action or grant the needed permission."
            ),
            "exit_code": 1,
        }
        logger.warning("Public tool policy blocked owner=%r tool=%s", owner, tool)
        return desc, result

    # ask_user：agent 向用户提出多选题以获取决定/澄清。
    # 这是纯 UI 控制标记 — 无子进程，无文件系统。
    # 返回 `ask_user` 负载，agent 循环将其转换为
    # `ask_user` SSE 事件然后结束回合，聊天等待
    # 用户选择（其选项作为下一条消息到达）。
    if tool == "ask_user":
        question, options, multi = "", [], False
        raw = (content or "").strip()
        try:
            parsed = json.loads(raw) if raw else {}
        except (ValueError, TypeError):
            parsed = {}
        if isinstance(parsed, dict):
            question = str(parsed.get("question", "")).strip()
            multi = bool(parsed.get("multi") or parsed.get("multiSelect"))
            for opt in (parsed.get("options") or []):
                if isinstance(opt, dict):
                    label = str(opt.get("label", "")).strip()
                    descr = str(opt.get("description", "")).strip()
                elif isinstance(opt, str):
                    label, descr = opt.strip(), ""
                else:
                    continue
                if label:
                    options.append({"label": label, "description": descr})
        else:
            question = raw
        if not question or len(options) < 2:
            return "ask_user: invalid", {
                "error": (
                    "ask_user needs a non-empty `question` and at least 2 `options` "
                    "(each an object with a `label`, optional `description`)."
                ),
                "exit_code": 1,
            }
        options = options[:6]  # 保持选项列表合理
        desc = f"ask_user: {question[:80]}"
        labels = ", ".join(o["label"] for o in options)
        result = {
            "ask_user": {"question": question, "options": options, "multi": multi},
            "output": f"Asked the user: {question}\nOptions: {labels}\nAwaiting their selection.",
            "exit_code": 0,
        }
        logger.info("Tool executed: %s (%d options, multi=%s)", desc, len(options), multi)
        return desc, result

    # update_plan：agent 写回活动计划 — 标记项目完成
    # 或修订步骤（如用户要求更改某些内容）。纯 UI
    # 标记：返回 `plan_update` 负载，agent 循环将其转换为
    # `plan_update` SSE 事件；前端替换存储的计划并刷新
    # 停靠的计划窗口。不结束回合。
    if tool == "update_plan":
        import json as _json
        raw = (content or "").strip()
        plan = ""
        try:
            parsed = _json.loads(raw) if raw else {}
        except (ValueError, TypeError):
            parsed = {}
        if isinstance(parsed, dict) and parsed.get("plan"):
            plan = str(parsed.get("plan", "")).strip()
        else:
            # 纯字符串调用（原始清单）或无可用 `plan` 的 JSON。
            plan = raw
        if not plan:
            return "update_plan: invalid", {
                "error": "update_plan needs a non-empty `plan` (the full updated checklist as markdown).",
                "exit_code": 1,
            }
        plan = plan[:8192]
        done = plan.count("- [x]") + plan.count("- [X]")
        total = done + plan.count("- [ ]")
        desc = f"update_plan: {done}/{total} done" if total else "update_plan"
        result = {
            "plan_update": {"plan": plan},
            "output": f"Plan updated ({done}/{total} steps complete)." if total else "Plan updated.",
            "exit_code": 0,
        }
        logger.info("Tool executed: %s", desc)
        return desc, result

    # 后台执行：`bash` 代码块，第一行为 `#!bg` 标记
    # 则分离运行 — 立即返回任务 ID，聊天流不会为
    # 数分钟的 install/ffmpeg/download 保持打开。常驻监控
    # 在任务完成时用完整输出重新调用 agent。
    if tool == "bash" and session_id:
        _is_bg, _bg_cmd = _split_bg_marker(content)
        if _is_bg and _bg_cmd:
            from src import bg_jobs
            rec = bg_jobs.launch(_bg_cmd, session_id=session_id, cwd=workspace or _AGENT_WORKDIR)
            short = _bg_cmd.strip().split(chr(10))[0][:80]
            desc = f"bash (background): {short}"
            result = {
                "output": (
                    f"Started background job `{rec['id']}`. It is running detached — "
                    f"do NOT wait for it or poll it. You will be automatically re-invoked "
                    f"with its full output when it finishes. Continue with other work, or "
                    f"end your turn now and resume when the result arrives."
                ),
                "exit_code": 0,
                "bg_job_id": rec["id"],
            }
            logger.info(f"Tool executed: {desc} -> bg job {rec['id']}")
            return desc, result

    # 通过 MCP 管理器路由 MCP 提取的工具。转发
    # 进度回调，使长时间运行的子进程工具
    # （bash、python）可以流式发送 `tool_progress` 事件到 UI。
    if tool in _MCP_TOOL_MAP:
        first_line = content.split(chr(10))[0][:80]
        desc = f"{tool}: {first_line}"
        result = await _call_mcp_tool(tool, content, progress_cb=progress_cb, workspace=workspace)
    elif tool in ("grep", "glob", "ls"):
        # 代码导航工具 — 无 MCP 服务器；运行直接实现。
        # 设置了工作区时限制在工作区内（与 read_file 策略相同）。
        first_line = content.split(chr(10))[0][:80]
        desc = f"{tool}: {first_line}"
        result = await _direct_fallback(tool, content, progress_cb=progress_cb, workspace=workspace) \
            or {"error": f"{tool}: execution failed", "exit_code": 1}
    elif tool == "create_document":
        title = content.split("\n")[0].strip()[:60]
        desc = f"create_document: {title}"
        result = await do_create_document(content, session_id=session_id, owner=owner)
    elif tool == "update_document":
        desc = f"update_document: {content.split(chr(10))[0][:60]}"
        result = await do_update_document(content, owner=owner)
    elif tool == "edit_document":
        result = await do_edit_document(content, owner=owner)
        desc = f"edit_document: {result.get('title', '')}"
    elif tool == "suggest_document":
        result = await do_suggest_document(content, owner=owner)
        desc = f"suggest_document: {result.get('count', 0)} suggestions"
    elif tool == "search_chats":
        query = content.split("\n")[0].strip()
        desc = f"search_chats: {query[:80]}"
        result = await do_search_chats(query, owner=owner)
    elif tool in ("chat_with_model", "create_session", "list_sessions",
                  "send_to_session", "pipeline",
                  "manage_session", "manage_memory", "list_models",
                  "ui_control", "ask_teacher"):
        from src.ai_interaction import dispatch_ai_tool
        desc, result = await dispatch_ai_tool(tool, content, session_id, owner=owner)
    elif tool == "manage_tasks":
        desc = "manage_tasks"
        result = await do_manage_tasks(content, owner=owner)
    elif tool == "manage_skills":
        desc = "manage_skills"
        result = await do_manage_skills(content, owner=owner)
    elif tool == "api_call":
        first_line = content.split("\n")[0].strip()[:60]
        desc = f"api_call: {first_line}"
        result = await do_api_call(content)
    elif tool == "manage_endpoints":
        desc = "manage_endpoints"
        result = await do_manage_endpoints(content, owner=owner)
    elif tool == "manage_mcp":
        desc = "manage_mcp"
        result = await do_manage_mcp(content, owner=owner)
    elif tool == "manage_webhooks":
        desc = "manage_webhooks"
        result = await do_manage_webhooks(content, owner=owner)
    elif tool == "manage_tokens":
        desc = "manage_tokens"
        result = await do_manage_tokens(content, owner=owner)
    elif tool == "manage_documents":
        desc = "manage_documents"
        result = await do_manage_documents(content, owner=owner)
    elif tool == "manage_settings":
        desc = "manage_settings"
        result = await do_manage_settings(content, owner=owner)
    elif tool == "manage_notes":
        desc = "manage_notes"
        result = await do_manage_notes(content, owner=owner)
    elif tool == "manage_calendar":
        desc = "manage_calendar"
        result = await do_manage_calendar(content, owner=owner)
    elif tool == "download_model":
        desc = "download_model"
        result = await do_download_model(content, owner=owner)
    elif tool == "serve_model":
        desc = "serve_model"
        result = await do_serve_model(content, owner=owner)
    elif tool == "list_served_models":
        desc = "list_served_models"
        result = await do_list_served_models(content, owner=owner)
    elif tool == "stop_served_model":
        desc = "stop_served_model"
        result = await do_stop_served_model(content, owner=owner)
    elif tool == "tail_serve_output":
        desc = "tail_serve_output"
        result = await do_tail_serve_output(content, owner=owner)
    elif tool == "list_downloads":
        desc = "list_downloads"
        result = await do_list_downloads(content, owner=owner)
    elif tool == "cancel_download":
        desc = "cancel_download"
        result = await do_cancel_download(content, owner=owner)
    elif tool == "search_hf_models":
        desc = "search_hf_models"
        result = await do_search_hf_models(content, owner=owner)
    elif tool == "list_cached_models":
        desc = "list_cached_models"
        result = await do_list_cached_models(content, owner=owner)
    elif tool == "app_api":
        desc = "app_api"
        result = await do_app_api(content, owner=owner)
    elif tool == "list_serve_presets":
        desc = "list_serve_presets"
        result = await do_list_serve_presets(content, owner=owner)
    elif tool == "serve_preset":
        desc = "serve_preset"
        result = await do_serve_preset(content, owner=owner)
    elif tool == "adopt_served_model":
        desc = "adopt_served_model"
        result = await do_adopt_served_model(content, owner=owner)
    elif tool == "list_cookbook_servers":
        desc = "list_cookbook_servers"
        result = await do_list_cookbook_servers(content, owner=owner)
    elif tool == "edit_image":
        desc = "edit_image"
        result = await do_edit_image(content, owner=owner)
    elif tool == "edit_file":
        result = await _do_edit_file(content, workspace=workspace)
        desc = result.get("output") or result.get("error") or "edit_file"
    elif tool == "trigger_research":
        desc = "trigger_research"
        result = await do_trigger_research(content, owner=owner)
    elif tool == "manage_research":
        desc = "manage_research"
        result = await do_manage_research(content, owner=owner)
    elif tool == "resolve_contact":
        desc = "resolve_contact"
        result = await do_resolve_contact(content, owner=owner)
    elif tool == "manage_contact":
        desc = "manage_contact"
        result = await do_manage_contact(content, owner=owner)
    elif tool == "vault_search":
        desc = "vault_search"
        result = await do_vault_search(content, owner=owner)
    elif tool == "vault_get":
        desc = "vault_get"
        result = await do_vault_get(content, owner=owner)
    elif tool == "vault_unlock":
        desc = "vault_unlock"
        result = await do_vault_unlock(content, owner=owner)
    elif tool.startswith("mcp__"):
        # MCP 工具分发
        mcp = get_mcp_manager()
        if mcp:
            try:
                args = json.loads(content) if content.strip().startswith("{") else {}
            except (json.JSONDecodeError, TypeError):
                args = {}
            desc = f"mcp: {tool}"
            result = await mcp.call_tool(tool, args)
        else:
            desc = f"mcp: {tool}"
            result = {"error": "MCP manager not available", "exit_code": 1}
    else:
        desc = f"unknown: {tool}"
        result = {"error": f"Unknown tool type: {tool}", "exit_code": 1}

    logger.info(f"Tool executed: {desc} -> exit_code={result.get('exit_code', 'n/a')}")
    return desc, result


# ---------------------------------------------------------------------------
# 结果格式化
# ---------------------------------------------------------------------------

# 下面专用分支处理的键 — 永远不要将它们回显为原始 JSON。
_FORMATTER_HANDLED_KEYS = {
    "stdout", "stderr", "exit_code", "content", "size",
    "response", "results", "session_id", "name", "model", "session_name",
    "success", "path", "action", "title", "doc_id", "version", "applied",
    "error", "output",
}


def format_tool_result(description: str, result: Dict) -> str:
    """将工具结果格式化为文本以供反馈给 LLM。"""
    parts = [f"### {description}"]

    if "stdout" in result:
        if result["stdout"]:
            parts.append(f"**stdout:**\n```\n{result['stdout']}\n```")
        if result["stderr"]:
            parts.append(f"**stderr:**\n```\n{result['stderr']}\n```")
        parts.append(f"**exit_code:** {result.get('exit_code', 'unknown')}")
    elif "output" in result:
        # bash / python 规范结果格式：{"output": ..., "exit_code": ...}
        parts.append(f"```\n{result['output']}\n```")
        if result.get("exit_code") not in (0, None):
            parts.append(f"**exit_code:** {result['exit_code']}")
    elif "content" in result:
        parts.append(f"**content ({result.get('size', '?')} chars):**\n```\n{result['content']}\n```")
    elif "response" in result:
        model = result.get("model", result.get("session_name", ""))
        if model:
            parts.append(f"**{model} responded:**\n{result['response']}")
        else:
            parts.append(result["response"])
    elif "results" in result:
        parts.append(result["results"])
    elif "session_id" in result and "name" in result:
        parts.append(f"Session created: **{result['name']}** (id: `{result['session_id']}`, model: {result.get('model', 'unknown')})")
    elif "success" in result:
        if result["success"]:
            parts.append(f"File written: {result['path']} ({result['size']} bytes)")
        else:
            parts.append(f"Error: {result.get('error', 'unknown')}")
    elif "action" in result:
        action = result["action"]
        if action == "create":
            parts.append(f"Document created: \"{result.get('title', '')}\" (id: {result['doc_id']}, v{result['version']})")
        elif action == "update":
            parts.append(f"Document updated: \"{result.get('title', '')}\" (v{result['version']})")
        elif action == "edit":
            parts.append(f'Document edited: "{result.get("title", "")}" (v{result.get("version", "?")}, {result.get("applied", 0)} edit(s) applied)')
    elif "error" in result:
        parts.append(f"**Error:** {result['error']}")

    # 暴露任何额外的结构化负载（事件、任务、笔记、日历、
    # 文档、附件等），上方专用分支不显示的。
    # 没有此操作，返回 {"response": "...", "events": [...]} 的工具会
    # 静默丢弃事件列表，模型只能看到摘要行。
    extra = {k: v for k, v in result.items() if k not in _FORMATTER_HANDLED_KEYS}
    if extra:
        try:
            extra_json = json.dumps(extra, indent=2, default=str, ensure_ascii=False)
            # 限制大小以避免超大负载撑爆上下文窗口。
            if len(extra_json) > 8000:
                extra_json = extra_json[:8000] + f"\n... (truncated, {len(extra_json)} chars total)"
            parts.append(f"**data:**\n```json\n{extra_json}\n```")
        except (TypeError, ValueError):
            pass

    return "\n".join(parts)
