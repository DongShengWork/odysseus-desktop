"""
agent_tools.py — 外观模块。

重新导出工具解析、schemas、执行和实现，
以保持向后兼容。所有导入者继续无需修改即可工作。

子模块：
  - tool_parsing.py: 正则模式、解析/剥离函数
  - tool_schemas.py: FUNCTION_TOOL_SCHEMAS、function_call_to_tool_block
  - tool_execution.py: execute_tool_block、format_tool_result、MCP 辅助
  - tool_implementations.py: 所有 do_* 工具函数
"""

import logging
from collections import namedtuple

from src.tool_utils import _truncate, get_mcp_manager, set_mcp_manager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 常量（为向后兼容重新导出 — 单一事实来源
# 是 src.constants；新代码始终优先从那里导入）
# ---------------------------------------------------------------------------
MAX_AGENT_ROUNDS = 50
SHELL_TIMEOUT = 60
PYTHON_TIMEOUT = 30

# 触发执行的工具类型
TOOL_TAGS = {"bash", "python", "web_search", "web_fetch", "read_file", "write_file", "edit_file",
             "grep", "glob", "ls",
             "create_document", "update_document", "edit_document",
             "search_chats",
             "chat_with_model", "create_session", "list_sessions",
             "send_to_session",
             "pipeline",
             "manage_session", "manage_memory", "list_models",
             "ui_control", "generate_image", "ask_user", "update_plan",
             "manage_tasks", "api_call", "ask_teacher", "manage_skills",
             "suggest_document",
             "manage_endpoints", "manage_mcp", "manage_webhooks",
             "manage_tokens", "manage_documents", "manage_settings",
             "manage_notes", "manage_calendar",
             "resolve_contact", "manage_contact", "list_email_accounts", "send_email", "list_emails",
             "read_email", "reply_to_email", "bulk_email", "archive_email",
             "delete_email", "mark_email_read",
             # Cookbook 工具（LLM 服务 + 下载）。没有这些
             # 条目，对 e.g. list_served_models 的原生函数调用
             # 在到达调度器之前就会被当作 "Unknown function call" 拒绝
             # — 导致整个 cookbook 操作面静默失败。
             "download_model", "serve_model",
             "list_served_models", "stop_served_model",
             "list_downloads", "cancel_download",
             "search_hf_models", "list_cached_models",
             "list_serve_presets", "serve_preset", "adopt_served_model",
             "list_cookbook_servers",
             # agent 还会用到但之前缺失的其他工具。
             "edit_image", "trigger_research", "manage_research",
             # 通用回环到任何 UI 按钮端点（cookbook、
             # 图库、邮件文件夹等）— agent 在没有
             # 对应命名工具包装器时使用此工具。
             "app_api"}

ToolBlock = namedtuple("ToolBlock", ["tool_type", "content"])

# ---------------------------------------------------------------------------
# 从子模块重新导出
# ---------------------------------------------------------------------------

# 解析
from src.tool_parsing import (  # noqa: E402, F401
    parse_tool_blocks,
    strip_tool_blocks,
    _TOOL_NAME_MAP,
    _TOOL_BLOCK_RE,
    _TOOL_CALL_RE,
    _XML_TOOL_CALL_RE,
    _XML_INVOKE_RE,
    _XML_PARAM_RE,
)

# Schemas
from src.tool_schemas import (  # noqa: E402, F401
    FUNCTION_TOOL_SCHEMAS,
    function_call_to_tool_block,
)

# 执行
from src.tool_execution import (  # noqa: E402, F401
    execute_tool_block,
    format_tool_result,
)

# 实现
from src.tool_implementations import (  # noqa: E402, F401
    set_active_document,
    set_active_model,
    get_active_document,
    do_create_document,
    do_update_document,
    do_edit_document,
    do_suggest_document,
    do_search_chats,
    do_manage_skills,
    do_manage_tasks,
    do_manage_endpoints,
    do_manage_mcp,
    do_manage_webhooks,
    do_manage_tokens,
    do_manage_documents,
    do_manage_settings,
    do_api_call,
)
