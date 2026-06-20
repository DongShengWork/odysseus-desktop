"""
tool_parsing.py

从 LLM 响应文本中进行基于正则的工具调用解析。
支持围栏代码块、[TOOL_CALL] 块和 XML 风格 <invoke> 块。
"""

import ast
import json
import logging
import re
from typing import List, Optional

from src.agent_tools import ToolBlock, TOOL_TAGS

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 正则模式
# ---------------------------------------------------------------------------

# 模式 1：```bash ... ``` 围栏代码块
_TOOL_BLOCK_RE = re.compile(
    r"```(" + "|".join(TOOL_TAGS) + r")\s*\n([\s\S]*?)```",
    re.IGNORECASE,
)

# 模式 2：[TOOL_CALL] ... [/TOOL_CALL] 块（一些模型使用此格式）
# 匹配：{tool => "shell", args => {--command "ls -la"}} 等。
_TOOL_CALL_RE = re.compile(
    r"\[TOOL_CALL\]\s*\{([\s\S]*?)\}\s*\[/TOOL_CALL\]",
    re.IGNORECASE,
)

# 模式 3：XML 风格工具调用（Minimax 及一些其他模型）
# <minimax:tool_call><invoke name="bash"><parameter name="command">...</parameter></invoke></minimax:tool_call>
# 也处理：<tool_call><invoke ...>、<function_call><invoke ...>、纯 <invoke ...>
_XML_TOOL_CALL_RE = re.compile(
    r"<(?:[\w]+:)?(?:tool_call|function_call)>\s*([\s\S]*?)</(?:[\w]+:)?(?:tool_call|function_call)>",
    re.IGNORECASE,
)
_XML_INVOKE_RE = re.compile(
    r'<invoke\s+name=["\'](\w+)["\']>\s*([\s\S]*?)</invoke>',
    re.IGNORECASE,
)
_XML_PARAM_RE = re.compile(
    r'<parameter\s+name=["\'](\w+)["\']>([\s\S]*?)</parameter>',
    re.IGNORECASE,
)

# 模式 4：<tool_code> 块（MiniMax-M2.5 风格）
# {tool => 'tool_name', args => '<param>value</param>'}
_TOOL_CODE_RE = re.compile(
    r"<tool_code>\s*\{([\s\S]*?)\}\s*</tool_code>",
    re.IGNORECASE,
)

# Pattern 5: DeepSeek DSML markup leaking into content. When deepseek
# models can't emit structured tool_calls (e.g. we sent no tool schemas
# that round, or the API didn't parse them), they fall back to raw
# markup using fullwidth-pipe delimiters:
#   <｜｜DSML｜｜tool_calls>
#     <｜｜DSML｜｜invoke name="web_search">
#       <｜｜DSML｜｜parameter name="query" string="true">QUERY</｜｜DSML｜｜parameter>
#     </｜｜DSML｜｜invoke>
#   </｜｜DSML｜｜tool_calls>
# We normalize it into the standard <invoke>/<parameter> form so the
# existing XML parser + stripper handle it (parse → execute; strip →
# never show the garbage to the user). The pipe run is tolerant of
# fullwidth (U+FF5C) and ascii '|' in any count.
_DSML_PIPES = r"[｜|]+"
def _normalize_dsml(text: str) -> str:
    if not isinstance(text, str):
        return ""
    if "DSML" not in text:
        return text
    t = text
    t = re.sub(rf"<\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*tool_calls\s*>", "<tool_call>", t, flags=re.IGNORECASE)
    t = re.sub(rf"<\s*/\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*tool_calls\s*>", "</tool_call>", t, flags=re.IGNORECASE)
    t = re.sub(rf"<\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*invoke\s+name=", "<invoke name=", t, flags=re.IGNORECASE)
    t = re.sub(rf"<\s*/\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*invoke\s*>", "</invoke>", t, flags=re.IGNORECASE)
    # parameter 打开标签——丢弃任何额外属性（例如 string="true"）。
    t = re.sub(rf'<\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*parameter\s+name=(["\'][^"\']+["\'])[^>]*>',
               r"<parameter name=\1>", t, flags=re.IGNORECASE)
    t = re.sub(rf"<\s*/\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*parameter\s*>", "</parameter>", t, flags=re.IGNORECASE)
    return t

# 将模型工具名称映射到我们的工具类型
_TOOL_NAME_MAP = {
    "shell": "bash",
    "bash": "bash",
    "terminal": "bash",
    "command": "bash",
    "execute": "bash",
    "run": "bash",
    "python": "python",
    "code": "python",
    "search": "web_search",
    "web_search": "web_search",
    "websearch": "web_search",
    "google_search": "web_search",
    "google_search_retrieval": "web_search",
    "google_search_grounding": "web_search",
    "web_fetch": "web_fetch",
    "webfetch": "web_fetch",
    "fetch_url": "web_fetch",
    "fetch": "web_fetch",
    "read": "read_file",
    "read_file": "read_file",
    "cat": "read_file",
    "write": "write_file",
    "write_file": "write_file",
    "save": "write_file",
    "document": "update_document",
    "update_document": "update_document",
    "create_document": "create_document",
    "edit": "edit_document",
    "edit_document": "edit_document",
    "search_chats": "search_chats",
    "search_conversations": "search_chats",
    "find_chat": "search_chats",
    "chat_with_model": "chat_with_model",
    "ask_model": "chat_with_model",
    "chat_model": "chat_with_model",
    "create_session": "create_session",
    "new_session": "create_session",
    "list_sessions": "list_sessions",
    "send_to_session": "send_to_session",
    "message_session": "send_to_session",
    "pipeline": "pipeline",
    "chain": "pipeline",
    "manage_session": "manage_session",
    "session_control": "manage_session",
    "manage_memory": "manage_memory",
    "memory": "manage_memory",
    "manage_tasks": "manage_tasks",
    "tasks": "manage_tasks",
    "schedule": "manage_tasks",
    "list_models": "list_models",
    "models": "list_models",
    "available_models": "list_models",
    "ui_control": "ui_control",
    "ui": "ui_control",
    "control": "ui_control",
    "api_call": "api_call",
    "api": "api_call",
    "integration": "api_call",
    "ask_teacher": "ask_teacher",
    "teacher": "ask_teacher",
    "manage_skills": "manage_skills",
    "skills": "manage_skills",
    "skill": "manage_skills",
    "suggest_document": "suggest_document",
    "suggest": "suggest_document",
    "review_document": "suggest_document",
    "manage_endpoints": "manage_endpoints",
    "endpoints": "manage_endpoints",
    "manage_mcp": "manage_mcp",
    "mcp_servers": "manage_mcp",
    "manage_webhooks": "manage_webhooks",
    "webhooks": "manage_webhooks",
    "manage_tokens": "manage_tokens",
    "tokens": "manage_tokens",
    "manage_documents": "manage_documents",
    "documents": "manage_documents",
    "manage_research": "manage_research",
    "list_research": "manage_research",
    "read_research": "manage_research",
    "open_research": "manage_research",
    "delete_research": "manage_research",
    "manage_settings": "manage_settings",
    "settings": "manage_settings",
    "preferences": "manage_settings",
    "manage_notes": "manage_notes",
    "notes": "manage_notes",
    "todo": "manage_notes",
    "todos": "manage_notes",
}

_MISFENCED_WEB_TOOL_NAMES = {
    "web_search": "web_search",
    "websearch": "web_search",
    "google_search": "web_search",
    "google_search_retrieval": "web_search",
    "google_search_grounding": "web_search",
    "web_fetch": "web_fetch",
    "webfetch": "web_fetch",
    "fetch_url": "web_fetch",
}

_RAW_WEB_JSON_TOOL_RE = re.compile(
    r"\b(?:web_search|websearch|google_search|google_search_retrieval|google_search_grounding)\b",
    re.IGNORECASE,
)
_RAW_WEB_JSON_ALLOWED_KEYS = {"query", "queries", "time_filter", "freshness", "max_pages"}


# ---------------------------------------------------------------------------
# 解析函数
# ---------------------------------------------------------------------------

def _literal_string(value) -> Optional[str]:
    """从小型字面量 AST 节点返回字符串，或返回 None。"""
    try:
        parsed = ast.literal_eval(value)
    except (ValueError, SyntaxError, TypeError):
        return None
    if isinstance(parsed, str):
        return parsed.strip()
    if isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, str) and item.strip():
                return item.strip()
    return None


def _parse_misfenced_web_lookup(content: str) -> Optional[ToolBlock]:
    """恢复包裹在 python/bash 围栏中的简单 web_search/web_fetch 调用。

    一些本地围栏工具模型写出：

        ```python
        web_search("latest python release")
        ```

    这是一个预期的工具调用，不是 Python 代码。有意保持
    狭窄范围：只有对已知 web 工具别名的单个裸函数调用才会转换。
    """
    try:
        module = ast.parse(content.strip(), mode="exec")
    except SyntaxError:
        return None
    if len(module.body) != 1 or not isinstance(module.body[0], ast.Expr):
        return None
    call = module.body[0].value
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name):
        return None

    mapped = _MISFENCED_WEB_TOOL_NAMES.get(call.func.id.lower())
    if mapped not in ("web_search", "web_fetch"):
        return None
    if len(call.args) > 1:
        return None

    args = {}
    if call.args:
        key = "url" if mapped == "web_fetch" else "query"
        value = _literal_string(call.args[0])
        if not value:
            return None
        args[key] = value

    allowed = {"query", "queries", "url", "time_filter", "freshness", "max_pages"}
    for keyword in call.keywords:
        if keyword.arg not in allowed:
            return None
        key = "query" if keyword.arg == "queries" else keyword.arg
        value = _literal_string(keyword.value)
        if value is not None:
            args[key] = value
            continue
        try:
            parsed = ast.literal_eval(keyword.value)
        except (ValueError, SyntaxError, TypeError):
            return None
        if key == "max_pages" and isinstance(parsed, int):
            args[key] = parsed
            continue
        return None

    if mapped == "web_search":
        query = args.get("query")
        if not query:
            return None
        payload = {"query": query}
        for key in ("time_filter", "freshness", "max_pages"):
            if key in args:
                payload[key] = args[key]
        if len(payload) == 1:
            return ToolBlock("web_search", query)
        return ToolBlock("web_search", json.dumps(payload))

    url = args.get("url")
    if not url:
        return None
    return ToolBlock("web_fetch", url)


def _coerce_raw_web_query(value) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str) and item.strip():
                return item.strip()
    return None


def _raw_web_json_to_tool_block(payload) -> Optional[ToolBlock]:
    if not isinstance(payload, dict):
        return None
    if set(payload) - _RAW_WEB_JSON_ALLOWED_KEYS:
        return None

    query = _coerce_raw_web_query(payload.get("query"))
    if not query:
        query = _coerce_raw_web_query(payload.get("queries"))
    if not query:
        return None

    content = {"query": query}
    for key in ("time_filter", "freshness"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip().lower() in ("day", "week", "month", "year"):
            content[key] = value.strip().lower()

    max_pages = payload.get("max_pages")
    if isinstance(max_pages, int) and 1 <= max_pages <= 10:
        content["max_pages"] = max_pages

    if len(content) == 1:
        return ToolBlock("web_search", query)
    return ToolBlock("web_search", json.dumps(content))


def _parse_raw_web_json_lookup(text: str) -> Optional[tuple[ToolBlock, tuple[int, int]]]:
    """Recover local text-model web_search calls emitted as prose + bare JSON.

    Some non-native tool models leak the intended call as:

        Need to do web_search for ...
        {"query": "...", "time_filter": "week"}

    Keep this narrower than fenced/tool markup: it only runs when a known web
    tool name appears shortly before a JSON object shaped like web_search args.
    """
    if not isinstance(text, str):
        return None

    decoder = json.JSONDecoder()
    for mention in _RAW_WEB_JSON_TOOL_RE.finditer(text):
        search_start = mention.end()
        search_end = min(len(text), search_start + 1200)
        for brace in re.finditer(r"\{", text[search_start:search_end]):
            start = search_start + brace.start()
            try:
                parsed, end = decoder.raw_decode(text[start:])
            except json.JSONDecodeError:
                continue
            block = _raw_web_json_to_tool_block(parsed)
            if block:
                return block, (start, start + end)
    return None

def _parse_tool_call_block(raw: str) -> Optional[ToolBlock]:
    """将 [TOOL_CALL] 块解析为 ToolBlock。

    处理以下格式：
      {tool => "shell", args => {--command "ls -la"}}
      {tool: "shell", command: "ls -la"}
    """
    # 尝试提取工具名称
    tool_match = re.search(r'tool\s*(?:=>|:|=)\s*["\']?(\w+)["\']?', raw, re.IGNORECASE)
    if not tool_match:
        return None

    tool_name = tool_match.group(1).lower()
    # 当它是真正的工具但不在别名映射中时，回退到原始名称，
    # 这样已知工具（例如 manage_calendar）就不会被默默丢弃。
    mapped = _TOOL_NAME_MAP.get(tool_name) or (tool_name if tool_name in TOOL_TAGS else None)
    if not mapped:
        return None

    # 提取命令/内容——尝试多种模式
    content = None

    # 模式：--command "value" 或 --command 'value'
    cmd_match = re.search(r'--command\s+["\'](.+?)["\']', raw, re.DOTALL)
    if cmd_match:
        content = cmd_match.group(1)

    # 模式：command => "value" 或 command: "value"
    if not content:
        cmd_match = re.search(r'command\s*(?:=>|:|=)\s*["\'](.+?)["\']', raw, re.DOTALL)
        if cmd_match:
            content = cmd_match.group(1)

    # 模式：args => {content}——提取嵌套大括号内的所有内容
    if not content:
        args_match = re.search(r'args\s*(?:=>|:|=)\s*\{([\s\S]*)\}', raw, re.DOTALL)
        if args_match:
            inner = args_match.group(1).strip()
            # 剥离引号和键前缀
            inner = re.sub(r'^--?\w+\s+', '', inner)
            inner = inner.strip('\'"')
            if inner:
                content = inner

    # 模式：query/path/code => "value"
    if not content:
        for key in ("query", "path", "code", "content", "text", "file"):
            m = re.search(rf'{key}\s*(?:=>|:|=)\s*["\'](.+?)["\']', raw, re.DOTALL)
            if m:
                content = m.group(1)
                break

    # 最后手段：取工具声明之后的所有内容
    if not content:
        rest = raw[tool_match.end():].strip()
        rest = re.sub(r'^[,;]\s*', '', rest)
        rest = rest.strip('{} \t\n\'"')
        if rest:
            content = rest

    if content:
        return ToolBlock(mapped, content.strip())
    return None


def _parse_xml_invoke(inv_match) -> Optional[ToolBlock]:
    """解析 <invoke name="tool"><parameter ...>...</parameter></invoke> 匹配。

    将内容塑造委托给 function_call_to_tool_block——与
    原生函数调用使用的相同转换器——因此完整的工具集（TOOL_TAGS
    中的每个名称，加上 email + MCP 工具）和正确的每工具
    内容格式在一个地方处理。之前的版本重复了一个
    部分的、手工维护的工具名称映射加上一个 `key: value` 序列化器：
    任何在该映射中缺失的工具（例如 `manage_calendar`）都会被默默
    丢弃，JSON 参数工具会得到不可解析的 `k: v` blob。这两个 bug
    导致 deepseek 的 DSML `create_event` 调用消失且无执行。
    """
    # 将工具名称转为小写：模型经常发出大写 invoke 名称
    #（例如 <invoke name="Bash">），而 function_call_to_tool_block 对
    # 小写的 _TOOL_NAME_MAP / TOOL_TAGS 进行大小写敏感的匹配，因此
    # 原始大写名称会被默默丢弃。
    tool_name = inv_match.group(1).lower()
    body = inv_match.group(2)
    params = {}
    for pm in _XML_PARAM_RE.finditer(body):
        params[pm.group(1)] = pm.group(2).strip()
    # 模块加载时的本地导入以避免循环导入。
    from src.tool_schemas import function_call_to_tool_block
    return function_call_to_tool_block(tool_name, json.dumps(params))


def _parse_tool_code_block(raw: str) -> Optional[ToolBlock]:
    """解析 <tool_code>{tool => 'name', args => '...'}</tool_code> 块（MiniMax 风格）。"""
    # 提取工具名称
    tool_match = re.search(r"tool\s*=>\s*['\"](\S+?)['\"]", raw)
    if not tool_match:
        return None
    tool_name = tool_match.group(1).lower().replace('-', '_')
    # 剥离 "mcp__server__" 或 "cli-mcp-server-" 等 MCP 前缀
    for prefix in ("mcp__", "cli_mcp_server_", "desktop_commander_", "mcp_code_executor_"):
        if tool_name.startswith(prefix):
            tool_name = tool_name[len(prefix):]
            break

    mapped = _TOOL_NAME_MAP.get(tool_name)

    # 提取 args 内容
    args_match = re.search(r"args\s*=>\s*['\"]?\s*([\s\S]*?)\s*['\"]?\s*$", raw, re.DOTALL)
    args_body = args_match.group(1).strip().strip("'\"") if args_match else ""

    # 解析 args 内的 XML 参数（例如 <command>ls</command>）
    xml_params = {}
    for pm in re.finditer(r"<(\w+)>([\s\S]*?)</\1>", args_body):
        xml_params[pm.group(1)] = pm.group(2).strip()

    # 当模型给出了结构化参数时，将它们交给
    # 标准转换器（与原生调用 + <invoke> 相同），以便完整的工具集和
    # 正确的每工具内容格式适用——而不是部分映射 + k:v blob。
    if xml_params:
        from src.tool_schemas import function_call_to_tool_block
        block = function_call_to_tool_block(mapped or tool_name, json.dumps(xml_params))
        if block:
            return block

    # 没有结构化参数：args_body 是原始单个值（例如 bash
    # 命令）。保留简单工具的自由格式特殊处理。
    if mapped:
        if mapped == "bash":
            content = xml_params.get("command", args_body)
        elif mapped == "python":
            content = xml_params.get("code", args_body)
        elif mapped == "web_search":
            content = xml_params.get("query", args_body)
        elif mapped == "web_fetch":
            content = xml_params.get("url", args_body)
        elif mapped in ("read_file", "write_file"):
            content = xml_params.get("path", xml_params.get("file_path", args_body))
        else:
            content = "\n".join(f"{k}: {v}" for k, v in xml_params.items()) if xml_params else args_body
        if content:
            return ToolBlock(mapped, content.strip())
    elif tool_name and args_body:
        # 未知工具——作为 MCP 工具调用尝试
        content = "\n".join(f"{k}: {v}" for k, v in xml_params.items()) if xml_params else args_body
        return ToolBlock(tool_name, content.strip())
    return None


def parse_tool_blocks(text: str, skip_fenced: bool = False) -> List[ToolBlock]:
    """从 LLM 响应文本中提取可执行的工具块。

    支持多种格式：
    1. ```bash ... ``` 围栏代码块（标准）
    2. [TOOL_CALL] ... [/TOOL_CALL] 块（某些模型）
    3. XML 风格 <tool_call>/<invoke> 块
    4. <tool_code> 块（MiniMax-M2.5 风格）
    5. DeepSeek DSML 标记（先标准化到 <invoke>）
    6. Non-native local model fallback: prose mentioning web_search followed by
       bare JSON args, e.g. {"query":"...", "time_filter":"week"}

    `skip_fenced`：为 True 时，模式 1（围栏 ```bash/```python/```json 代码
    块）完全不匹配。原生函数调用模型（GPT/Claude/
    Grok/Qwen3/DeepSeek-V 等）经常在散文中写出说明性的围栏示例；
    对于这些模型，我们信任结构化 tool_calls 通道来执行真正的
    调用，并将裸围栏视为显示文本而非操作
    （issue #3222）。模式 2-5——作为文本泄露到内容中的显式
    [TOOL_CALL]/<invoke>/<tool_code>/DSML 标记——始终完全激活，
    因为这些标记永远不会是说明性示例，丢弃它们将
    默默丢失真正的调用（例如 DeepSeek-V 在无法发出
    结构化 tool_calls 时回退到 DSML）。
    """
    blocks = []

    # 将 DeepSeek DSML 标记标准化为标准的 <invoke> 形式，以便
    # 下面的 XML 模式能捕获。
    text = _normalize_dsml(text)

    # 模式 1：围栏代码块（当 `skip_fenced` 时跳过——参见 docstring）。
    if not skip_fenced:
        for m in _TOOL_BLOCK_RE.finditer(text):
            tag = m.group(1).lower()
            content = m.group(2).strip()
            if not content:
                continue
            # 如果代码块的内容是 <invoke> XML 调用（一些模型将
            # 工具调用包裹在 ```python 或 ```xml 围栏中），改为解析 invoke。
            if '<invoke' in content:
                for inv in _XML_INVOKE_RE.finditer(content):
                    block = _parse_xml_invoke(inv)
                    if block:
                        blocks.append(block)
                # 这个围栏块是 <invoke> 标记，不是字面代码。无论
                # 是否有调用成功转换，都绝不回退到将原始 XML 作为
                # python/bash 块追加——例如，一个连字符/命名空间化的工具名称，
                # _XML_INVOKE_RE 的 \w+ 无法匹配的，否则会被当作代码执行。
                continue
            if tag in ("python", "bash"):
                block = _parse_misfenced_web_lookup(content)
                if block:
                    blocks.append(block)
                    continue
            blocks.append(ToolBlock(tag, content))

    # 模式 2：[TOOL_CALL] 块（仅在未找到围栏块时）
    if not blocks:
        for m in _TOOL_CALL_RE.finditer(text):
            block = _parse_tool_call_block(m.group(1))
            if block:
                blocks.append(block)

    # 模式 3：XML 风格 <tool_call>/<invoke> 块
    if not blocks:
        # 尝试包装的：<tool_call><invoke ...>...</invoke></tool_call>
        for m in _XML_TOOL_CALL_RE.finditer(text):
            for inv in _XML_INVOKE_RE.finditer(m.group(1)):
                block = _parse_xml_invoke(inv)
                if block:
                    blocks.append(block)
        # 尝试不带包装的裸 <invoke>
        if not blocks:
            for inv in _XML_INVOKE_RE.finditer(text):
                block = _parse_xml_invoke(inv)
                if block:
                    blocks.append(block)

    # 模式 4：<tool_code> 块（MiniMax-M2.5 风格）
    if not blocks:
        for m in _TOOL_CODE_RE.finditer(text):
            block = _parse_tool_code_block(m.group(1))
            if block:
                blocks.append(block)

    # Pattern 6: local text-model web_search call leaked as prose + bare JSON.
    if not blocks and not skip_fenced:
        raw_web_json = _parse_raw_web_json_lookup(text)
        if raw_web_json:
            blocks.append(raw_web_json[0])

    return blocks


def strip_tool_blocks(text: str, skip_fenced: bool = False) -> str:
    """从文本中移除可执行工具块以供干净显示。

    `skip_fenced`：为 True 时，围栏 ```bash/```python/```json 代码块
    （模式 1）保持原样而非被剥离。这必须镜像
    针对同一响应调用 `parse_tool_blocks` 时传递的 `skip_fenced` 值：
    如果围栏未作为工具调用执行（因为它是一个
    来自原生函数调用模型的说明性示例），它也不应该
    从持久化/显示的文本中消失——否则示例
    流式传输一次后，重新加载时就会消失（issue #3222 的后续）。
    模式 2-5 + DSML 标记始终被剥离，因为无论是否转换为工具调用，
    这些标记都不应该展示给用户。
    """
    # 先标准化 DSML，以便其标记被下面的 <invoke>
    # / <tool_call> 移除器剥离，而不是泄漏给用户。
    text = _normalize_dsml(text)
    cleaned = text if skip_fenced else _TOOL_BLOCK_RE.sub('', text)
    cleaned = _TOOL_CALL_RE.sub('', cleaned)
    cleaned = _XML_TOOL_CALL_RE.sub('', cleaned)
    cleaned = _TOOL_CODE_RE.sub('', cleaned)
    if not skip_fenced:
        raw_web_json = _parse_raw_web_json_lookup(cleaned)
        if raw_web_json:
            _, (start, end) = raw_web_json
            cleaned = cleaned[:start] + cleaned[end:]
    # 剥离未包裹在 <tool_call> 中的裸 <invoke> 块
    cleaned = re.sub(r'<invoke\s+name=["\'].*?</invoke>', '', cleaned, flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return cleaned.strip()
