# src/middleware.py
# 共享中间件、装饰器和请求辅助函数

import os
import secrets

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


# 进程内令牌，允许应用内工具层通过 HTTP 回环
# 访问管理员门控路由（agent 的工具调用不携带
# 管理员的会话 cookie）。在导入时设置一次；工具从此模块读取
# 相同的值。绝不会被持久化或对外暴露。
INTERNAL_TOOL_TOKEN = os.environ.get("ODYSSEUS_INTERNAL_TOKEN") or secrets.token_hex(32)
INTERNAL_TOOL_HEADER = "X-Odysseus-Internal-Token"


def is_cors_preflight(method: str, headers) -> bool:
    """True for a genuine CORS preflight: an OPTIONS request carrying the
    Access-Control-Request-Method header. Such requests are credential-less by
    design and must reach CORSMiddleware to be answered -- gating them on auth
    401s the preflight and breaks every cross-origin browser/WebView client.
    Pure so it can be unit-tested without standing up the app."""
    return method == "OPTIONS" and "access-control-request-method" in headers


def require_admin(request: Request):
    """如果当前用户不是管理员则抛出 403。
    当认证被显式禁用，或请求携带回环 agent 工具使用的
    进程内内部令牌时，允许访问。
    """
    # 工具层回环调用的进程内绕过。两种路径：
    # (a) header-direct（调用者设置了 X-Odysseus-Internal-Token），或
    # (b) 认证中间件已验证令牌并将
    #     request.state.current_user 标记为 "internal-tool"。
    try:
        hdr = request.headers.get(INTERNAL_TOOL_HEADER)
        if hdr and secrets.compare_digest(hdr, INTERNAL_TOOL_TOKEN):
            return
        if getattr(request.state, "current_user", None) == "internal-tool":
            return
    except Exception:
        pass

    auth_mgr = getattr(request.app.state, "auth_manager", None)
    if os.getenv("AUTH_ENABLED", "true").lower() == "false":
        return
    if not auth_mgr or not auth_mgr.is_configured:
        raise HTTPException(403, "Admin only")
    user = getattr(request.state, "current_user", None)
    if not user or not auth_mgr.is_admin(user):
        raise HTTPException(403, "Admin only")


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """为所有响应添加标准安全头。"""

    async def dispatch(self, request: Request, call_next) -> Response:
        # 为内联脚本生成每个请求的随机数
        nonce = secrets.token_hex(16)
        request.state.csp_nonce = nonce

        response = await call_next(request)
        path = request.url.path

        # 工具渲染端点在 iframe 内提供 — 允许自身框架化
        is_tool_render = path.startswith("/api/tools/") and path.endswith("/render")
        # PDF 预览由应用内文档库嵌入。保持
        # 此例外限定在路由范围内，以便普通应用页面保持不可框架化。
        is_document_pdf_preview = path.startswith("/api/document/") and path.endswith("/render-pdf")
        # 可视化报告页面是自包含的 HTML — 需要内联脚本 + 外部图片
        is_report = path.startswith("/api/research/report/")

        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(self), geolocation=()"

        is_https = (
            request.url.scheme == "https"
            or request.headers.get("X-Forwarded-Proto") == "https"
        )
        if is_https:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

        if is_report:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; "
                "font-src 'self'; "
                "img-src 'self' data: blob: https:; "
                "connect-src 'self'; "
                "frame-ancestors 'none'"
            )
        elif is_tool_render:
            # 工具 iframe 内容：跳过所有框架化头 — iframe 的
            # sandbox="allow-scripts" 属性提供了隔离。
            # 也不要覆盖路由自身的限制性 CSP。
            pass
        elif is_document_pdf_preview:
            response.headers["X-Frame-Options"] = "SAMEORIGIN"
            response.headers["Content-Security-Policy"] = (
                "default-src 'none'; "
                "frame-ancestors 'self'"
            )
        else:
            response.headers["X-Frame-Options"] = "DENY"
            # 注意：`style-src 'unsafe-inline'` 是故意保留的。
            # `static/index.html` 和 `static/login.html` 包含内联 <style>
            # 块，并且多个 JS 模块构建运行时 `style=""` 属性。
            # 迁移到仅 nonce 需要模板化 HTML 文件 +
            # 审计每个 JS 设置的 style 属性。由于内联样式
            # 不执行脚本，残留风险仅限于视觉效果。
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; "
                f"script-src 'self' 'nonce-{nonce}' https://cdn.jsdelivr.net; "
                "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                "font-src 'self' https://cdn.jsdelivr.net; "
                "img-src 'self' data: blob:; "
                "media-src 'self' blob:; "
                "connect-src 'self'; "
                "frame-src 'self'; "
                "frame-ancestors 'none'"
            )
        return response
