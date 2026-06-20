"""Odysseus companion 桥接 — 附加式 LAN 端点。

读取端点 (/api/companion/ping, /info, owner-scoped /models) 让 LAN
客户端可以发现服务器提供的内容，以及仅限管理员的配对功能
(/api/companion/pair)，在 POST 时生成一次性的聊天作用域令牌。不包含新的 LLM
逻辑；认证由现有的 AuthMiddleware 强制执行。参见 companion/README.md。
"""

from companion.routes import setup_companion_routes

__all__ = ["setup_companion_routes"]
