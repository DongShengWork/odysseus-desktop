"""服务端工具安全策略。"""

from __future__ import annotations

import logging
from typing import Optional, Set

logger = logging.getLogger(__name__)


# 普通/公开用户不得直接执行的工具。这些要么暴露了
# 服务器/运行时访问、敏感用户数据、外部消息传递、持久化
# 状态更改或通用的环回/集成接口。
NON_ADMIN_BLOCKED_TOOLS = {
    "bash",
    "python",
    "manage_bg_jobs",
    "read_file",
    "write_file",
    "edit_file",
    "grep",
    "glob",
    "ls",
    "get_workspace",
    "search_chats",
    "manage_memory",
    "manage_skills",
    "manage_tasks",
    "manage_endpoints",
    "manage_mcp",
    "manage_webhooks",
    "manage_tokens",
    "manage_documents",
    "manage_settings",
    "api_call",
    "app_api",
    "send_email",
    "reply_to_email",
    "list_emails",
    "read_email",
    "resolve_contact",
    "manage_contact",
    "manage_calendar",
    "vault_search",
    "vault_get",
    "vault_unlock",
    "download_model",
    "serve_model",
    "serve_preset",
    "stop_served_model",
    "cancel_download",
    "adopt_served_model",
}


# Plan 模式：agent 可以调查但不得修改任何内容。只有这些
# 只读/检查工具保持启用；其他所有工具（写入、发送、
# manage_*、模型服务、MCP 等）被阻止。使用白名单而非黑名单，
# 以便任何新添加的工具在 plan 模式下默认被阻止——安全失败。
#
# bash/python 刻意不在此列表：shell 可以修改（写入文件、访问
# 网络）且无法在工具层面限制为只读，因此 plan
# 模式直接阻止它，而不是依赖提示来保持其行为良好。
# 代码/文件发现由下面的专用只读工具
#（read_file、grep、glob、ls）覆盖，而不是自由使用 shell。
PLAN_MODE_READONLY_TOOLS = {
    "read_file",
    "grep",
    "glob",
    "ls",
    "get_workspace",
    "web_search",
    "web_fetch",
    "search_chats",
    "list_models",
    "list_sessions",
    "list_emails",
    "read_email",
    "list_served_models",
    "list_downloads",
    "list_cached_models",
    "search_hf_models",
    "list_serve_presets",
    "list_cookbook_servers",
    "resolve_contact",
    "chat_with_model",
    "ask_teacher",
}


# Agent 的工具门控采用 DENYLIST：execute_tool_block 阻止
# 名称在 `disabled_tools` 中的任何工具。Plan 模式的策略则相反——白名单
#（PLAN_MODE_READONLY_TOOLS）。要通过拒绝列表应用白名单，plan 模式
# 返回其逆：每个已知工具名称减去白名单。
#
# 已知工具名称来自 FUNCTION_TOOL_SCHEMAS，但该来源不完善：
# 一些工具仅可通过 XML 调用（例如 manage_notes、generate_image）且从不
# 出现在其中，导入也可能完全失败。无论是哪种空缺都会让变异工具
# 从减集中漏掉并默默保持启用。此集合是两者的静态
# 后备：将其合并进去，使已知突变者始终被减去，且导入
# 失败时仍会阻止它们（失败关闭，绝不开放）。只有突变者属于
# 此处——只读工具由白名单覆盖。添加新
# 突变工具时保持同步。
_PLAN_MODE_KNOWN_MUTATORS = {
    "write_file", "create_document", "edit_document", "update_document",
    "suggest_document", "manage_documents", "create_session", "manage_session",
    "send_to_session", "pipeline", "manage_memory", "manage_skills",
    "manage_tasks", "manage_notes", "manage_endpoints", "manage_mcp",
    "manage_webhooks", "manage_tokens", "manage_settings", "manage_contact",
    "manage_calendar", "api_call", "app_api", "ui_control",
    "send_email", "reply_to_email", "bulk_email", "delete_email",
    "archive_email", "mark_email_read", "download_model", "serve_model",
    "stop_served_model", "cancel_download", "adopt_served_model", "serve_preset",
    "generate_image", "edit_image", "trigger_research", "manage_research",
    # Shell 永远不是只读安全的；显式阻止它，这样即使
    # schema 列表加载失败，它也不会进入 plan 模式。
    "bash", "python",
    # Controls shell processes (kill); plan mode can't run bash anyway.
    "manage_bg_jobs",
}


def plan_mode_disabled_tools() -> Set[str]:
    """Plan 模式下要添加到拒绝列表的工具名称。

    Plan 模式只允许 PLAN_MODE_READONLY_TOOLS。门控是拒绝列表，因此
    返回其逆：每个已知工具名称减去白名单。已知名称
    来自函数工具 schema，后备为 _PLAN_MODE_KNOWN_MUTATORS
    （见上文），以便仅 XML 的工具和失败的 schema 导入不会让突变者
    保持启用。MCP 工具单独处理——plan 模式下循环
    完全丢弃 MCP 管理器。"""
    try:
    # agent_tools / tool_parsing / tool_schemas 构成一个互相循环的
    # 集群，只有通过 agent_tools 入口才能干净解析。
    # 先导入它，以便延迟 schema 导入即使在冷导入下也能工作
    #（例如测试）——不仅是当应用已经连接好一切之后。
        import src.agent_tools  # noqa: F401
        from src.tool_schemas import FUNCTION_TOOL_SCHEMAS

        all_names = {
            (t.get("function") or {}).get("name")
            for t in FUNCTION_TOOL_SCHEMAS
        }
        all_names.discard(None)
    except Exception as exc:
        logger.warning("Unable to load tool schemas for plan-mode gating: %s", exc)
        all_names = set()
    # 从所有已知工具名称（schema 派生的加上
    # 静态突变后备）中减去白名单。失败关闭：如果上述 schema 导入失败，
    # 仅后备本身仍然阻止已知的突变工具。
    return (all_names | _PLAN_MODE_KNOWN_MUTATORS) - PLAN_MODE_READONLY_TOOLS


def is_public_blocked_tool(tool_name: Optional[str]) -> bool:
    """当非管理员/公开用户不得执行此工具时返回 True。

    这是一个安全门控，因此它失败关闭：格式错误的非字符串工具
    名称无法与阻止列表或 ``mcp__`` 命名空间匹配，因此
    被视为已阻止，而不是默默允许通过。``None`` /
    空字符串表示没有可以门控的工具。
    """
    if tool_name is None or tool_name == "":
        return False
    if not isinstance(tool_name, str):
        return True
    return tool_name in NON_ADMIN_BLOCKED_TOOLS or tool_name.startswith("mcp__")


def owner_is_admin_or_single_user(owner: Optional[str]) -> bool:
    """Return True for admins, or in intentional single-user mode.

    Single-user mode means the operator explicitly disabled auth
    (``AUTH_ENABLED=false``) — the local/self-host default where the owner has
    full access to their own box.

    The pre-setup window (auth ENABLED but no admin created yet) is treated as
    NON-admin: returning True there would hand server-execution tools
    (``bash``/``python``) to any caller before setup completes. The auth
    middleware already 401s ``/api/`` requests pre-setup, so this is
    defense-in-depth for callers that bypass it (e.g. trusted loopback).
    """
    try:
        from src.auth_helpers import _auth_disabled

        if _auth_disabled():
            return True

        from core.auth import AuthManager

        auth = AuthManager()
        if not auth.is_configured:
            return False
        return bool(owner and auth.is_admin(owner))
    except Exception as exc:
        logger.warning("Unable to evaluate owner admin status: %s", exc)
        return False


def blocked_tools_for_owner(owner: Optional[str]) -> Set[str]:
    """根据公开用户策略，为此所有者隐藏/禁用的工具。"""
    if owner_is_admin_or_single_user(owner):
        return set()
    return set(NON_ADMIN_BLOCKED_TOOLS)
