"""
mcp_manager.py

管理 MCP（模型上下文协议）工具服务器的连接。
每个服务器暴露的工具可供 agent loop 使用。
"""

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Set, Tuple

from src.runtime_paths import get_app_root

logger = logging.getLogger(__name__)

def _format_mcp_connection_error(name: str, command: str = "", args: Optional[List[str]] = None, error: Exception = None) -> str:
    """返回面向用户的 MCP 连接错误消息。"""
    args = args or []
    raw_error = str(error) if error else "Unknown error"
    command_line = " ".join([command or "", *args]).strip()
    lower_command = command_line.lower()

    if "@playwright/mcp" in lower_command:
        return (
            f"{raw_error}\n\n"
            "Browser MCP could not start. On fresh installs, cache the Playwright MCP package once before connecting:\n\n"
            "npx -y @playwright/mcp@latest --version\n\n"
            "Then restart Odysseus and reconnect the Browser MCP server."
        )

    return raw_error


# 将不受信任的 MCP 工具 schema 渲染到 agent 提示词中的上限（issue #2660）。
# MCP 服务器是第三方/用户添加的，因此字段名和参数数量是
# 不受信任的输入 — 限制它们以防异常或恶意 schema 扭曲提示词。
_MCP_PARAM_MAX = 12   # 每个工具最多渲染的参数数
_MCP_TOKEN_MAX = 40   # 每个渲染的名称/类型 token 的最大字符数
_MCP_HINT_MAX = 300   # 整个提示的总长度上限


def _sanitize_schema_token(value: Any, limit: int = _MCP_TOKEN_MAX) -> str:
    """使不受信任的 JSON-Schema token 可以安全拼接到提示词中。

    将控制字符/换行符替换为空格，压缩空白，并对结果进行长度限制，
    以防止异常的字段名或类型注入换行符或无限延伸。
    正常的短标识符保持不变。
    """
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value))
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return text


def _format_mcp_params(input_schema: Any) -> str:
    """将 MCP 工具的 JSON-Schema 输入渲染为紧凑的提示文本。

    Without this the agent only sees a tool's name + description and has to
    guess its arguments (issue #2509). Produces e.g.
    ` Args (JSON): {"path": string (required), "limit": integer}` — 名称、
    coarse types, and required-ness, kept short so it stays prompt-friendly.
    Returns "" when there are no parameters.

    MCP 服务器是第三方的，因此名称/类型经过清理，且参数
    数量和总长度有上限 (issue #2660)；普通 schema 不受影响。
    """
    if not isinstance(input_schema, dict):
        return ""
    props = input_schema.get("properties")
    if not isinstance(props, dict) or not props:
        return ""
    required = set(input_schema.get("required") or [])
    parts = []
    for pname, pinfo in list(props.items())[:_MCP_PARAM_MAX]:
        pinfo = pinfo if isinstance(pinfo, dict) else {}
        ptype = pinfo.get("type") or "any"
        if isinstance(ptype, list):
            ptype = "|".join(str(x) for x in ptype)
        tag = f'"{_sanitize_schema_token(pname)}": {_sanitize_schema_token(ptype)}'
        if pname in required:
            tag += " (required)"
        parts.append(tag)
    extra = len(props) - len(parts)
    if extra > 0:
        parts.append(f"…+{extra} more")
    hint = " Args (JSON): {" + ", ".join(parts) + "}"
    if len(hint) > _MCP_HINT_MAX:
        hint = hint[:_MCP_HINT_MAX - 1].rstrip() + "…"
    return hint


# 表示只读/检查操作的工具名前缀。当服务器未提供 readOnlyHint 时，
# 用于在计划模式下分类 MCP 工具。这些是前缀而非完整单词（通过
# str.startswith 匹配），因此像 "summar" 这样的词干可以
# 覆盖 "summarise"/"summarize"/"summary"。
_MCP_READONLY_VERBS = (
    "list", "get", "read", "search", "fetch", "query", "find", "describe",
    "show", "view", "lookup", "count", "status", "info", "inspect", "summar",
)


def mcp_tool_is_readonly(tool: Dict) -> bool:
    """判断 MCP 工具是否安全（非修改操作），用于计划模式。

    优先使用服务器自身的标注（readOnlyHint / destructiveHint）。缺失时，
    absent, fall back to a tool-name verb heuristic, and FAIL CLOSED (treat as
    write) for anything that doesn't clearly read — plan mode must not run a
    write tool just because its intent is ambiguous.
    """
    ann = tool.get("annotations")
    # annotations 可能是 dict 或 pydantic model
    read_hint = None
    destructive = None
    if ann is not None:
        if isinstance(ann, dict):
            read_hint = ann.get("readOnlyHint")
            destructive = ann.get("destructiveHint")
        else:
            read_hint = getattr(ann, "readOnlyHint", None)
            destructive = getattr(ann, "destructiveHint", None)
    if read_hint is True:
        return True
    if read_hint is False or destructive is True:
        return False
    # 无可用的 hint — 基于工具名称前缀的启发式规则。
    name = (tool.get("name") or "").lower()
    return name.startswith(_MCP_READONLY_VERBS)


class McpManager:
    """管理 MCP 服务器连接和工具路由。"""

    def __init__(self):
        # server_id -> 连接状态
        self._connections: Dict[str, Dict[str, Any]] = {}
        # server_id -> 工具 schema 列表
        self._tools: Dict[str, List[Dict]] = {}
        # server_id -> MCP ClientSession
        self._sessions: Dict[str, Any] = {}
        # server_id -> 退出栈（用于清理）
        self._stacks: Dict[str, Any] = {}
        # server_id -> 后台连接任务（HTTP 传输 / OAuth）
        self._connect_tasks: Dict[str, Any] = {}
        # 跟踪工具/连接更新，用于 RAG 索引 / 提示词缓存
        self._generation = 0

    async def connect_server(
        self,
        server_id: str,
        name: str,
        transport: str,
        command: Optional[str] = None,
        args: Optional[List[str]] = None,
        env: Optional[Dict[str, str]] = None,
        url: Optional[str] = None,
    ) -> bool:
        """通过 stdio、SSE 或 Streamable HTTP 传输连接到 MCP 服务器。"""
        try:
            if transport == "stdio":
                res = await self._connect_stdio(server_id, name, command, args or [], env or {})
            elif transport == "sse":
                res = await self._connect_sse(server_id, name, url)
            elif transport == "http":
                res = await self._start_http_connect(server_id, name, url)
            else:
                logger.error(f"Unknown MCP transport: {transport}")
                res = False
            if res:
                self._generation += 1
            return res
        except Exception as e:
            logger.error(f"Failed to connect MCP server {name} ({server_id}): {e}")
            error_message = _format_mcp_connection_error(name, command or "", args or [], e)
            self._connections[server_id] = {"status": "error", "error": error_message, "name": name}
            self._generation += 1
            return False

    async def _connect_stdio(self, server_id: str, name: str, command: str, args: List[str], env: Dict[str, str]) -> bool:
        """通过 stdio 传输连接到 MCP 服务器。"""
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
            from contextlib import AsyncExitStack

            server_params = StdioServerParameters(
                command=command,
                args=args,
                env={**os.environ, **env} if env else None,
            )

            stack = AsyncExitStack()
            try:
                transport = await stack.enter_async_context(stdio_client(server_params))
                read_stream, write_stream = transport
                session = await stack.enter_async_context(ClientSession(read_stream, write_stream))

                await session.initialize()

                # 发现工具
                tools_result = await session.list_tools()
            except Exception:
                await stack.aclose()
                raise
            tools = []
            for tool in tools_result.tools:
                tools.append({
                    "name": tool.name,
                    "description": tool.description or "",
                    "input_schema": tool.inputSchema if hasattr(tool, 'inputSchema') else {},
                    # MCP 工具标注（readOnlyHint / destructiveHint）驱动
                    # 计划模式的只读门控。许多服务器不提供此标注，因此
                    # 我们在 mcp_tool_is_readonly() 中回退到名称启发式规则。
                    "annotations": getattr(tool, 'annotations', None),
                })

            self._sessions[server_id] = session
            self._stacks[server_id] = stack
            self._tools[server_id] = tools
            # 从环境变量中提取身份提示（例如邮箱地址、API 名称），
            # 以便工具描述能够区分同一 MCP 服务器的多个实例
            # （例如两个邮箱账户）。
            identity_hints = []
            for k, v in (env or {}).items():
                k_lower = k.lower()
                if any(x in k_lower for x in ['email_address', 'account', 'user', 'username']):
                    identity_hints.append(v)
            identity = ", ".join(identity_hints) if identity_hints else ""

            self._connections[server_id] = {
                "status": "connected",
                "name": name,
                "transport": "stdio",
                "tool_count": len(tools),
                "identity": identity,
            }

            logger.info(f"MCP server connected: {name} ({server_id}) - {len(tools)} tools via stdio")
            return True

        except ImportError:
            logger.warning("MCP package not installed. Install with: pip install mcp")
            self._connections[server_id] = {"status": "error", "error": "mcp package not installed", "name": name}
            return False

    async def _connect_sse(self, server_id: str, name: str, url: str) -> bool:
        """通过 SSE 传输连接到 MCP 服务器。"""
        try:
            from mcp import ClientSession
            from mcp.client.sse import sse_client
            from contextlib import AsyncExitStack

            stack = AsyncExitStack()
            try:
                transport = await stack.enter_async_context(sse_client(url))
                read_stream, write_stream = transport
                session = await stack.enter_async_context(ClientSession(read_stream, write_stream))

                await session.initialize()

                # 发现工具
                tools_result = await session.list_tools()
            except Exception:
                await stack.aclose()
                raise
            tools = []
            for tool in tools_result.tools:
                tools.append({
                    "name": tool.name,
                    "description": tool.description or "",
                    "input_schema": tool.inputSchema if hasattr(tool, 'inputSchema') else {},
                    # MCP 工具标注（readOnlyHint / destructiveHint）驱动
                    # 计划模式的只读门控。许多服务器不提供此标注，因此
                    # 我们在 mcp_tool_is_readonly() 中回退到名称启发式规则。
                    "annotations": getattr(tool, 'annotations', None),
                })

            self._sessions[server_id] = session
            self._stacks[server_id] = stack
            self._tools[server_id] = tools
            self._connections[server_id] = {
                "status": "connected",
                "name": name,
                "transport": "sse",
                "tool_count": len(tools),
            }

            logger.info(f"MCP server connected: {name} ({server_id}) - {len(tools)} tools via SSE")
            return True

        except ImportError:
            logger.warning("MCP package not installed. Install with: pip install mcp")
            self._connections[server_id] = {"status": "error", "error": "mcp package not installed", "name": name}
            return False

    async def _start_http_connect(self, server_id: str, name: str, url: str, wait: float = 8.0) -> bool:
        """在后台启动 Streamable HTTP 连接。在 `wait` 秒内返回：
        如果连接成功（缓存 token 路径）返回 True，否则
        流程正在等待浏览器授权，状态变为 'needs_auth'。"""
        import asyncio
        self._connections[server_id] = {"status": "connecting", "name": name, "transport": "http"}
        task = asyncio.create_task(self._connect_http(server_id, name, url))
        self._connect_tasks[server_id] = task
        done, _ = await asyncio.wait({task}, timeout=wait)
        if task in done:
            try:
                return task.result()
            except Exception as e:
                self._connections[server_id] = {"status": "error", "error": str(e), "name": name}
                return False
        # 仍在运行 → 要么等待授权，要么 discovery/DCR 仍在进行中。
        # 如果 _on_redirect 已经发布了 needs_auth+auth_url，保持不变；
        # 否则标记 needs_auth（auth_url 在触发后填入）。
        from src.mcp_oauth import pop_auth_url
        cur = self._connections.get(server_id, {})
        if cur.get("status") != "needs_auth":
            self._connections[server_id] = {
                "status": "needs_auth", "name": name, "transport": "http",
                "auth_url": pop_auth_url(server_id),
            }
        return False

    async def _connect_http(self, server_id: str, name: str, url: str) -> bool:
        """连接到 Streamable HTTP MCP 服务器（含自动 OAuth）。"""
        try:
            from mcp import ClientSession
            from mcp.client.streamable_http import streamablehttp_client
            from contextlib import AsyncExitStack
            from src.mcp_oauth import build_provider, clear_auth_url

            def _on_redirect(auth_url):
                # 一旦 URL 已知就发布 needs_auth，与 discovery/DCR 耗时无关
                # （可能超出有界启动等待时间）。
                self._connections[server_id] = {
                    "status": "needs_auth", "name": name, "transport": "http",
                    "auth_url": auth_url,
                }

            provider = build_provider(server_id, url, on_redirect=_on_redirect)
            stack = AsyncExitStack()
            transport = await stack.enter_async_context(streamablehttp_client(url, auth=provider))
            read_stream, write_stream, _get_session_id = transport
            session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
            await session.initialize()

            tools_result = await session.list_tools()
            tools = []
            for tool in tools_result.tools:
                tools.append({
                    "name": tool.name,
                    "description": tool.description or "",
                    "input_schema": tool.inputSchema if hasattr(tool, "inputSchema") else {},
                })

            self._sessions[server_id] = session
            self._stacks[server_id] = stack
            self._tools[server_id] = tools
            self._connections[server_id] = {
                "status": "connected", "name": name, "transport": "http",
                "tool_count": len(tools),
            }
            clear_auth_url(server_id)
            # Tools changed (this can complete after connect_server already
            # returned, via the background OAuth flow), so bump the generation
            # to invalidate the tool-prompt cache.
            self._generation += 1
            logger.info(f"MCP server connected: {name} ({server_id}) - {len(tools)} tools via http")
            return True
        except ImportError:
            logger.warning("MCP package not installed. Install with: pip install mcp")
            self._connections[server_id] = {"status": "error", "error": "mcp package not installed", "name": name}
            return False
        except Exception as e:
            logger.error(f"Failed to connect HTTP MCP server {name} ({server_id}): {e}")
            self._connections[server_id] = {"status": "error", "error": str(e), "name": name}
            return False

    async def disconnect_server(self, server_id: str):
        """断开 MCP 服务器连接。"""
        # 取消任何正在进行的 HTTP/OAuth 后台连接，阻止其
        # 为可能正在被删除的服务器发布状态。
        task = self._connect_tasks.pop(server_id, None)
        if task is not None and not task.done():
            task.cancel()
        try:
            from src.mcp_oauth import clear_auth_url
            clear_auth_url(server_id)
        except Exception:
            pass

        stack = self._stacks.pop(server_id, None)
        if stack:
            try:
                await stack.aclose()
            except Exception as e:
                logger.warning(f"Error closing MCP server {server_id}: {e}")

        self._sessions.pop(server_id, None)
        self._tools.pop(server_id, None)
        self._connections.pop(server_id, None)
        self._generation += 1
        logger.info(f"MCP server disconnected: {server_id}")

    async def disconnect_all(self):
        """断开所有 MCP 服务器连接。"""
        ids = list(self._sessions.keys())
        for sid in ids:
            await self.disconnect_server(sid)

    async def connect_all_enabled(self):
        """连接数据库中所有已启用的 MCP 服务器。"""
        from src.database import McpServer, SessionLocal

        db = SessionLocal()
        try:
            servers = db.query(McpServer).filter(McpServer.is_enabled == True).all()
            for srv in servers:
                args = json.loads(srv.args) if srv.args else []
                env = json.loads(srv.env) if srv.env else {}
                await self.connect_server(
                    server_id=srv.id,
                    name=srv.name,
                    transport=srv.transport,
                    command=srv.command,
                    args=args,
                    env=env,
                    url=srv.url,
                )
        finally:
            db.close()

    async def call_tool(self, qualified_name: str, arguments: Dict) -> Dict:
        """通过限定名称 (mcp__{server_id}__{tool_name}) 调用 MCP 工具。

        返回与 agent_tools 格式兼容的结果字典。
        """
        parts = qualified_name.split("__", 2)
        if len(parts) != 3 or parts[0] != "mcp":
            return {"error": f"Invalid MCP tool name: {qualified_name}", "exit_code": 1}

        server_id = parts[1]
        tool_name = parts[2]

        session = self._sessions.get(server_id)
        if not session:
            return {"error": f"MCP server not connected: {server_id}", "exit_code": 1}

        try:
            result = await self._do_call(session, tool_name, arguments)
        except Exception as e:
            # 为子进程可能已崩溃的内置服务器自动重连
            if self.is_builtin(server_id):
                logger.warning(f"MCP call failed for {qualified_name}, attempting reconnect: {e}")
                reconnected = await self._reconnect_builtin(server_id)
                if reconnected:
                    session = self._sessions.get(server_id)
                    if session:
                        try:
                            result = await self._do_call(session, tool_name, arguments)
                        except Exception as e2:
                            logger.error(f"MCP tool call failed after reconnect: {qualified_name}: {e2}")
                            return {"error": str(e2), "exit_code": 1}
                    else:
                        return {"error": f"Reconnected but no session for {server_id}", "exit_code": 1}
                else:
                    logger.error(f"MCP reconnect failed for {server_id}")
                    return {"error": f"MCP server crashed and reconnect failed: {server_id}", "exit_code": 1}
            else:
                logger.error(f"MCP tool call failed: {qualified_name}: {e}")
                return {"error": str(e), "exit_code": 1}

        return result

    async def _do_call(self, session, tool_name: str, arguments: Dict) -> Dict:
        """执行单个 MCP 工具调用并返回结果字典。"""
        result = await session.call_tool(tool_name, arguments)
        output_parts = []
        images = []
        for content in result.content:
            if hasattr(content, 'text'):
                output_parts.append(content.text)
            elif getattr(content, 'type', '') == 'image' and hasattr(content, 'data'):
                # 图像内容（例如 Playwright 截图）
                mime = getattr(content, 'mimeType', 'image/png')
                images.append({"data": content.data, "mimeType": mime})
                output_parts.append(f"[Screenshot captured ({mime})]")
            elif hasattr(content, 'data'):
                output_parts.append(str(content.data))

        output = "\n".join(output_parts)
        is_error = getattr(result, 'isError', False)

        result_dict = {
            "stdout": output if not is_error else "",
            "stderr": output if is_error else "",
            "exit_code": 1 if is_error else 0,
        }
        if images:
            result_dict["images"] = images
        return result_dict

    async def _reconnect_builtin(self, server_id: str) -> bool:
        """销毁并重新连接已崩溃的内置 MCP 服务器。"""
        import sys
        from src.builtin_mcp import _BUILTIN_SERVERS

        if server_id not in _BUILTIN_SERVERS:
            return False

        script_rel, name = _BUILTIN_SERVERS[server_id]
        base_dir = get_app_root()
        script_path = os.path.join(base_dir, script_rel)

        # 清理旧连接
        await self.disconnect_server(server_id)

        try:
            ok = await self.connect_server(
                server_id=server_id,
                name=name,
                transport="stdio",
                command=sys.executable,
                args=[script_path],
                env={"PYTHONPATH": base_dir},
            )
            if ok:
                logger.info(f"Reconnected builtin MCP server: {name}")
            return ok
        except Exception as e:
            logger.error(f"Failed to reconnect builtin MCP server {name}: {e}")
            return False

    def get_all_openai_schemas(self, disabled_map: Optional[Dict[str, set]] = None) -> List[Dict]:
        """以 OpenAI 函数调用格式返回所有 MCP 工具。

        工具名以 mcp__{server_id}__{tool_name} 命名空间命名。
        disabled_map: 可选的 {server_id: set_of_disabled_tool_names} 用于过滤。
        """
        schemas = []
        for server_id, tools in self._tools.items():
            # 跳过内置 Python 服务器 — 它们使用 code-block 工具格式
            # 但包含基于 NPX 的内置服务器（如 browser），它们需要函数调用
            if self.is_builtin(server_id) and server_id != "builtin_browser":
                continue
            conn = self._connections.get(server_id, {})
            server_name = conn.get("name", server_id)
            disabled = (disabled_map or {}).get(server_id, set())

            identity = conn.get("identity", "")
            label = f"{server_name} ({identity})" if identity else server_name

            for tool in tools:
                if tool["name"] in disabled:
                    continue
                qualified = f"mcp__{server_id}__{tool['name']}"
                schema = {
                    "type": "function",
                    "function": {
                        "name": qualified,
                        "description": f"[MCP:{label}] {tool['description']}",
                        "parameters": tool.get("input_schema", {"type": "object", "properties": {}}),
                    },
                }
                schemas.append(schema)

        return schemas

    def get_all_tools(self, disabled_map: Optional[Dict[str, set]] = None) -> List[Dict]:
        """返回包含服务器信息的所有已发现工具的扁平列表。"""
        result = []
        for server_id, tools in self._tools.items():
            conn = self._connections.get(server_id, {})
            disabled = (disabled_map or {}).get(server_id, set())
            for tool in tools:
                result.append({
                    "server_id": server_id,
                    "server_name": conn.get("name", server_id),
                    "name": tool["name"],
                    "qualified_name": f"mcp__{server_id}__{tool['name']}",
                    "description": tool.get("description", ""),
                    "input_schema": tool.get("input_schema") or {},
                    "is_disabled": tool["name"] in disabled,
                })
        return result

    def plan_mode_blocked_mcp(self) -> Tuple[Dict[str, Set[str]], Set[str]]:
        """计划模式：阻止所有非明确只读的 MCP 工具。

        返回 (disabled_map, qualified_names):
          - disabled_map: {server_id: {tool_name, ...}} 隐藏写入工具不让其
            出现在提示词/schema 中（合并到现有的 mcp_disabled_map）。
          - qualified_names: {"mcp__<server>__<tool>", ...} 用于在
            execute_tool_block 中进行运行时拒绝（匹配限定名称）。
        """
        disabled_map: Dict[str, Set[str]] = {}
        qualified: Set[str] = set()
        for server_id, tools in self._tools.items():
            for tool in tools:
                if not mcp_tool_is_readonly(tool):
                    disabled_map.setdefault(server_id, set()).add(tool["name"])
                    qualified.add(f"mcp__{server_id}__{tool['name']}")
        return disabled_map, qualified

    def is_builtin(self, server_id: str) -> bool:
        """检查服务器是否为内置（自动注册）服务器。"""
        return server_id.startswith("builtin_") or server_id in {
            "image_gen",
            "memory",
            "rag",
            "email",
        }

    def get_server_status(self, server_id: str) -> Dict:
        """获取服务器的连接状态。"""
        return self._connections.get(server_id, {"status": "disconnected"})

    def get_all_statuses(self) -> Dict[str, Dict]:
        """获取所有服务器的连接状态。"""
        return dict(self._connections)

    _cached_prompt_desc = None
    _cached_prompt_desc_key = None

    def get_tool_descriptions_for_prompt(self, disabled_map: Optional[Dict[str, set]] = None) -> str:
        """生成用于 agent 系统提示词的 MCP 工具描述文本。已缓存。"""
        cache_key = (
            frozenset((k, frozenset(v)) for k, v in (disabled_map or {}).items()),
            len(self._tools),
            self._generation,
        )
        if self._cached_prompt_desc is not None and self._cached_prompt_desc_key == cache_key:
            return self._cached_prompt_desc
        tools = self.get_all_tools(disabled_map)
        if not tools:
            return ""

        lines = ["\n\nYou also have access to external MCP tool servers. These tools are called via native function calling:"]
        by_server = {}
        for t in tools:
            # 跳过内置 Python 服务器 — 它们已在 agent 提示词中
            # 但包含基于 NPX 的内置服务器（如 browser），它们不是硬编码的
            if self.is_builtin(t["server_id"]) and t["server_id"] != "builtin_browser":
                continue
            if t.get("is_disabled"):
                continue
            sn = t["server_name"]
            if sn not in by_server:
                by_server[sn] = []
            by_server[sn].append(t)

        if not by_server:
            return ""

        for server_name, server_tools in by_server.items():
            # 包含身份信息（如邮箱地址），如果可用
            sid = server_tools[0]["server_id"] if server_tools else ""
            identity = self._connections.get(sid, {}).get("identity", "")
            label = f"{server_name} ({identity})" if identity else server_name
            lines.append(f"\n**{label}:**")
            for t in server_tools:
                # 截断过长的描述
                desc = t['description'][:120] + '...' if len(t['description']) > 120 else t['description']
                # Include the tool's declared inputs so the model calls it with
                # real argument names instead of guessing from the description
                # 而不是仅根据描述猜测 (issue #2509)。
                args_hint = _format_mcp_params(t.get("input_schema"))
                lines.append(f"  - {t['qualified_name']}: {desc}{args_hint}")

        result = "\n".join(lines)
        self._cached_prompt_desc = result
        self._cached_prompt_desc_key = cache_key
        return result
