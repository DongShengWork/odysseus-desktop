"""
builtin_mcp.py

启动时自动注册内置 MCP 服务器。
每个服务器作为 stdio 子进程运行，由 McpManager 管理。
"""

import logging
import os
import shutil
import sys
import asyncio

from core.platform_compat import IS_WINDOWS, which_tool

logger = logging.getLogger(__name__)


def _find_npx() -> str:
    """查找 npx 二进制文件，如果不在 PATH 中则检查常见位置。

    在 Windows 上 shim 是 `npx.cmd`，`which_tool` 通过 PATHEXT 解析。
    """
    npx = which_tool("npx")
    if npx:
        return npx
    if IS_WINDOWS:
        # 最小 PATH 回退：npm 的全局 bin 在 %APPDATA%\npm 下，
        # node 的安装目录在 node.exe 旁边带有 npx.cmd。
        appdata = os.environ.get("APPDATA", os.path.expanduser("~"))
        for candidate in (
            os.path.join(appdata, "npm", "npx.cmd"),
            r"C:\Program Files\nodejs\npx.cmd",
        ):
            if os.path.isfile(candidate):
                return candidate
        node = which_tool("node")
        if node:
            cand = os.path.join(os.path.dirname(node), "npx.cmd")
            if os.path.isfile(cand):
                return cand
        return "npx.cmd"  # 回退，会以清晰的错误失败
    # PATH 最小化时的常见 POSIX 位置（例如 systemd）
    for candidate in [
        os.path.expanduser("~/.npm-global/bin/npx"),
        os.path.expanduser("~/.local/bin/npx"),
        "/usr/local/bin/npx",
        "/usr/bin/npx",
    ]:
        if os.path.isfile(candidate):
            return candidate
    # 尝试查找 node 并使用相同目录下的 npx
    node = shutil.which("node")
    if node:
        npx_candidate = os.path.join(os.path.dirname(node), "npx")
        if os.path.isfile(npx_candidate):
            return npx_candidate
    return "npx"  # 回退，会以清晰的错误失败

# 服务器定义：id -> (相对于项目根的脚本路径, 显示名称)
#
# bash / python / filesystem / web_search 已折叠到原生进程内
# 执行（src/tool_execution.py:_direct_fallback）。这些简单的子进程
# 包装器已移除。
#
# image_gen / memory / rag / email 仍然作为 stdio MCP 服务器运行 — 每个
# 包含数百行独特的 IMAP / HTTP / 管理器逻辑，当前不值得复制到原生路径。
_BUILTIN_SERVERS = {
    "image_gen":  ("mcp_servers/image_gen_server.py",  "Built-in: Image Generation"),
    "memory":     ("mcp_servers/memory_server.py",     "Built-in: Memory"),
    "rag":        ("mcp_servers/rag_server.py",        "Built-in: RAG"),
    "email":      ("mcp_servers/email_server.py",      "Built-in: Email"),
}

# 基于 NPX 的内置服务器（通过 npx 运行，不是 Python）
_BUILTIN_NPX_SERVERS = {
    "builtin_browser": {
        "name": "Built-in: Browser",
        "command": "npx",
        "args": ["-y", "@playwright/mcp@latest", "--headless", "--caps", "vision"],
    },
}

# 全局标志，如果存在兼容性问题则禁用 MCP
MCP_DISABLED = os.environ.get("ODYSSEUS_DISABLE_MCP", "").lower() in ("1", "true", "yes")


async def register_builtin_servers(mcp_manager):
    """将所有内置 MCP 服务器连接到管理器。"""
    if MCP_DISABLED:
        logger.info("Built-in MCP servers disabled via ODYSSEUS_DISABLE_MCP")
        return

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    python = sys.executable

    async def _connect_python_server(server_id: str, script_path: str, name: str):
        try:
            ok = await mcp_manager.connect_server(
                server_id=server_id,
                name=name,
                transport="stdio",
                command=python,
                args=[script_path],
                env={"PYTHONPATH": base_dir},
            )
            if ok:
                logger.info(f"Built-in MCP server registered: {name}")
            else:
                logger.warning(f"Built-in MCP server failed to connect: {name}")
        except asyncio.CancelledError:
            logger.warning(f"Built-in MCP server {name} cancelled")
            raise
        except BaseException as e:
            logger.warning(f"Built-in MCP server {name} error: {type(e).__name__}: {e}")

    for server_id, (script, name) in _BUILTIN_SERVERS.items():
        script_path = os.path.join(base_dir, script)
        if not os.path.exists(script_path):
            logger.warning(f"Built-in MCP server script not found: {script_path}")
            continue
        asyncio.create_task(_connect_python_server(server_id, script_path, name))

    # 在后台注册基于 NPX 的服务器（它们启动需要更长时间）
    npx_path = _find_npx()
    logger.info(f"NPX binary resolved to: {npx_path}")

    async def _start_npx_servers():
        await asyncio.sleep(3)  # 让 Python 服务器先完成
        for server_id, cfg in _BUILTIN_NPX_SERVERS.items():
            # 如果 npx 包未缓存则跳过此服务器。没有此检查，
            # npx 会在首次使用时尝试下载/安装包，这在没有
            # Playwright 系统依赖的新安装上可能需要数分钟（或挂起）。
            # 将其包装在 asyncio.wait_for 中以限制等待时间听起来合理，
            # 但 mcp.client.stdio 使用内部 anyio 任务组，该组无法
            # 承受由此产生的跨任务取消：它会在兄弟任务中引发
            # "Attempted to exit cancel scope in a different task than
            # it was entered in"，这将级联取消事件循环的其余部分
            # 并使应用崩溃。预先检测已安装状态让我们能在接触
            # stdio_client 之前以有用的警告退出。
            args = cfg["args"]
            pkg_spec = _npx_package_from_args(args)
            if pkg_spec and not await _is_npx_package_cached(npx_path, pkg_spec):
                logger.warning(
                    f"{cfg['name']} is not available.\n"
                    f"  Reason: npm package {pkg_spec!r} is not installed in the npx cache.\n"
                    f"  Impact: tools provided by this MCP server will be unavailable.\n"
                    f"  Fix:    {os.path.basename(npx_path)} -y {pkg_spec} --version\n"
                    f"          (run once, then restart Odysseus)\n"
                    f"  Notes:  this server is optional; see README.md "
                    f"'Built-in MCP servers' for details."
                )
                continue

            logger.info(f"Starting NPX server: {cfg['name']} ({npx_path} {' '.join(args)})")
            try:
                ok = await mcp_manager.connect_server(
                    server_id=server_id,
                    name=cfg["name"],
                    transport="stdio",
                    command=npx_path,
                    args=args,
                )
                if ok:
                    logger.info(f"Built-in NPX server registered: {cfg['name']}")
                else:
                    logger.warning(f"Built-in NPX server failed to connect: {cfg['name']}")
            except asyncio.CancelledError:
                raise
            except BaseException as e:
                logger.warning(f"Built-in NPX server {cfg['name']} error: {type(e).__name__}: {e}")

    asyncio.create_task(_start_npx_servers())


def _npx_package_from_args(args):
    """从形如 ['-y', '<package@version>', ...flags] 的 npx args
    列表中提取包名。如果约定不匹配则返回 None（此时跳过缓存检查，
    直接尝试连接）。"""
    if not args:
        return None
    if "-y" in args:
        idx = args.index("-y") + 1
        if idx < len(args) and not args[idx].startswith("-"):
            return args[idx]
    # 没有 -y 前缀：第一个非标志参数就是包
    for a in args:
        if not a.startswith("-"):
            return a
    return None


async def _is_npx_package_cached(npx_path, package_spec, timeout_s=5):
    """探测 npx 包是否已在本地缓存中。

    运行 `npx --no-install <pkg> --version`。--no-install 告诉 npx
    失败而不是下载，因此缓存未命中会快速返回。我们将 "以 0 退出并
    带有非空 stdout" 视为缓存副本可用的证据。其他任何情况（非零
    退出、空 stdout、超时、缺少 npx、网络错误）意味着应跳过此服务器。
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            npx_path, "--no-install", package_spec, "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (OSError, ValueError):
        return False
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        try:
            proc.kill()
            await proc.wait()
        except Exception:
            pass
        return False
    return proc.returncode == 0 and bool(stdout.strip())
