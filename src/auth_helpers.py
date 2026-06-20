"""所有路由文件共享的 auth 辅助函数。"""

import os
from typing import Optional
from fastapi import Request, HTTPException


def get_current_user(request: Request) -> Optional[str]:
    """从请求状态中获取当前用户名（由 auth 中间件设置）。"""
    return getattr(request.state, 'current_user', None)


def effective_user(request: Request) -> Optional[str]:
    """请求背后的真正人类用户，用于所有权/归属。

    Cookie session 解析为已登录用户名。Bearer ``ody_`` 调用者
    come through as the sandboxed pseudo-user "api" so they can't wander into
    cookie/user routes by default, but their token was minted by, and belongs
    标记在 ``request.state.api_token_owner`` 上。需要将 token 操作
    should attribute a token's actions to that owner (sessions, chat history)
    call this instead of :func:`get_current_user`, so a paired client sees and
    creates the SAME data as the owner's desktop UI rather than a separate
    "api"-owned silo.

    对于 Cookie session，这与 :func:`get_current_user` 相同，因此
    swapping a route over is a no-op for browser users. A bearer token with no
    到 :func:`get_current_user`（"api" 伪用户），因此永远不会提权。
    never escalates.
    """
    if getattr(request.state, "api_token", False):
        owner = getattr(request.state, "api_token_owner", None)
        if owner:
            return owner
    return get_current_user(request)


def _is_api_token_request(request: Request) -> bool:
    """当中间件认证了 bearer API token 时返回 True。"""
    return bool(getattr(request.state, "api_token", False))


def require_authenticated_request(request: Request) -> str:
    """允许浏览器 session 或有效的 bearer API token。

    这比 :func:`require_user` 有意更窄：仅用于需要认证
    但不读取或修改所有者作用域用户数据的路由。所有者作用域
    路由应使用 ``require_user`` 用于浏览器 session 或自己的
    API token 作用域/所有者门控。
    """
    if _is_api_token_request(request):
        return effective_user(request) or ""
    return require_user(request)


def _auth_disabled() -> bool:
    """当操作员通过 .env 显式关闭了 auth 时返回 True。
    与 app.py / core/middleware.py 中的 AUTH_ENABLED 解析一致，
    以便三个调用点对"关闭"的含义达成一致。"""
    return os.getenv("AUTH_ENABLED", "true").lower() == "false"


def require_user(request: Request) -> str:
    """FastAPI dependency: reject unauthenticated callers when the upstream
    auth middleware was bypassed unexpectedly (e.g. SSRF from a sibling
    service). Returns the resolved username, or "" in single-user / anonymous
    modes where no username is available.

    The three "" cases are:
      1. AUTH_ENABLED=false — 操作员显式关闭了 auth。
         The full /login flow is skipped (issue #622), so route-level
         require_user must let the request through too instead of 401-ing
         and forcing the browser to /login.
      2. Unconfigured first-run + loopback caller — pre-setup access from
         localhost so the operator can hit the SPA before creating the
         重定向到 /login。
      3. LOCALHOST_BYPASS=true + 回环调用者 — 文档化的开发绕过。

    Use this on routes that touch user data so middleware misconfig can't
    open them up.
    """
    if _is_api_token_request(request):
        raise HTTPException(403, "API tokens must use a scope-aware API route")

    u = get_current_user(request)
    if u:
        return u
    # 操作员禁用的 auth：在路由层也遵守。没有这个，
    # 依赖 require_user 的路由会 401，前端 fetch 包装器
    # 重定向到 /login，用户看到登录页面，尽管
    # AUTH_ENABLED=false（issue #622）。Docker/反向代理部署
    # 会遇到这种情况，因为请求来自非回环的 client.host，所以
    # 下面的回环回退永远不会触发。
    if _auth_disabled():
        return ""
    auth_mgr = getattr(request.app.state, "auth_manager", None)
    client = getattr(request, "client", None)
    host = (client.host if client else "") or ""
    is_loopback = host in ("127.0.0.1", "::1", "localhost")
    # LOCALHOST_BYPASS=true 是仅供开发的"我在回环上，跳过 auth"
    # switch. Mirror the middleware so routes don't 401 the same caller
    # the middleware just let through.
    if is_loopback and os.getenv("LOCALHOST_BYPASS", "false").lower() == "true":
        return ""
    if auth_mgr is not None and getattr(auth_mgr, "is_configured", False):
        raise HTTPException(401, "Not authenticated")
    # 未配置/首次运行模式：仅允许回环调用者。
    if is_loopback:
        return ""
    raise HTTPException(401, "Not authenticated")


def require_privilege(request: Request, key: str) -> str:
    """拒绝 `auth.json` 中 `key` 权限标志为 False 的调用者。
    返回用户名以便路由处理器继续使用。

    管理员通过 `auth_manager.get_privileges` 始终拥有所有权限
    （返回完整的 ADMIN_PRIVILEGES），因此对他们来说是空操作。
    在未认证的单用户模式下（`require_user` 返回 ""），
    权限不被强制执行。
    """
    user = require_user(request)
    if not user:
        return user
    auth_mgr = getattr(request.app.state, "auth_manager", None)
    if auth_mgr is None:
        return user
    try:
        privs = auth_mgr.get_privileges(user) or {}
    except Exception:
        return user
    if not isinstance(privs, dict):
        privs = {}
    # True = 允许；缺失的 key 默认为允许（未知权限
    # 默认放行 — UI 在显示端做门控）。
    if not privs.get(key, True):
        raise HTTPException(403, f"Your account is not allowed to {key.replace('_', ' ')}.")
    return user


def owner_filter(query, model_cls, user: str, *, include_shared: bool = True):
    """过滤 `query`，只允许 `user` 拥有的行（以及可选的 null-owner
    '共享'行）通过。当 `user` 为空时（单用户模式）为无操作。
    返回修改后的 query。"""
    if not user:
        return query
    if include_shared:
        return query.filter((model_cls.owner == user) | (model_cls.owner == None))  # noqa: E711
    return query.filter(model_cls.owner == user)
