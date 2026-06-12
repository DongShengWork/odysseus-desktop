# app.py — 精简编排器
import mimetypes
import os


def register_static_mime_types() -> None:
    """Force stable JS module MIME types across platforms.

    Some native Windows setups inherit stale/incorrect registry mappings for
    ``.js``/``.mjs``, which can make Starlette serve ES modules with a non-JS
    ``Content-Type`` and cause the UI to load but fail on click. Re-register the
    standard MIME types at startup so static assets are served consistently.
    """

    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("application/javascript", ".mjs")


register_static_mime_types()

# Windows：强制 HuggingFace/fastembed 复制模型文件而非使用符号链接。
# 在网络共享/UNC 数据目录中，Windows 无法跟随 HF 的符号链接（[WinError
# 1463]），导致 ONNX 嵌入模型加载失败。huggingface_hub 在导入时读取此变量，
# 因此在任何代码引入之前就要设置好。（在 src/embeddings.py 中
# 对非服务器入口点也有镜像设置。）
if os.name == "nt":
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from dotenv import load_dotenv
# encoding="utf-8-sig" 可以容忍 .env 文件中的 UTF-8 BOM —— 这是 Windows 上
# 用记事本保存文件时的常见陷阱。如果不加这个参数，第一个键会被解析为
# "﻿AUTH_ENABLED" 而非 "AUTH_ENABLED"，导致 AUTH_ENABLED=false 等配置
# 被静默忽略，用户会被意外强制要求登录（issue #142）。
# utf-8-sig 对普通 UTF-8（无 BOM）文件的读取行为完全一致，因此可安全用于所有平台。
load_dotenv(encoding="utf-8-sig")

import asyncio
import logging
import secrets
from datetime import datetime
from typing import Dict

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

# 核心模块导入
from core.constants import (
    BASE_DIR, STATIC_DIR, SESSIONS_FILE,
    REQUEST_TIMEOUT, OPENAI_API_KEY, AUTH_FILE,
)
from core.database import SessionLocal, ApiToken
from core.middleware import SecurityHeadersMiddleware, is_cors_preflight
from core.auth import AuthManager
from core.exceptions import (
    SessionNotFoundError, InvalidFileUploadError,
    LLMServiceError, WebSearchError,
)

import bcrypt as _bcrypt

from src.app_helpers import abs_join
from src.generated_images import GENERATED_IMAGE_HEADERS, resolve_generated_image_path
from starlette.responses import RedirectResponse

# ========= 日志 =========
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger(__name__)

# ========= 应用 =========
# Lifespan 在下面定义（在其引用的所有辅助函数都就位之后），
# 然后传递给 FastAPI，这样我们可以使用现代化的上下文管理器生命周期，
# 而不是已弃用的 @app.on_event("startup"/"shutdown") 装饰器。
app = FastAPI(
    title="AI Chat Application",
    description="Comprehensive AI chat with memory, research, and multi-modal capabilities",
    version="1.0.0",
)

# ========= 跨域 =========
allowed_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost,http://127.0.0.1").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=[
        "Accept",
        "Authorization",
        "Content-Type",
        "X-API-Key",
        "X-Auth-Token",
        "X-Odysseus-Internal-Token",
        "X-Odysseus-Owner",
        "X-Requested-With",
        "X-TZ-Offset",
    ],
)

# ========= 安全头中间件 =========
app.add_middleware(SecurityHeadersMiddleware)


# ========= 请求超时（挂起处理器的后备方案）=========
# 如果单个请求耗时超过 REQUEST_HARD_TIMEOUT，则中止并返回 504，
# 而不是让事件循环被卡住。白名单路径（流式传输、长时间运行的 shell 执行、
# research）被豁免，因为它们合法需要保持长连接。如果没有这个机制，
# 一个挂起的 subprocess.run 或缺少超时的 httpx 调用就会让整个服务器对所有用户都锁死。
import asyncio as _asyncio
from starlette.middleware.base import BaseHTTPMiddleware as _BaseHTTPMiddleware
from starlette.responses import JSONResponse as _JSONResponse

REQUEST_HARD_TIMEOUT = float(os.getenv("REQUEST_HARD_TIMEOUT", "45"))
_TIMEOUT_EXEMPT_PREFIXES = (
    "/api/chat",            # streaming
    "/api/shell/stream",    # SSE
    "/api/research",        # multi-minute jobs
    "/api/model/download",  # tmux setup may run pip installs
    "/api/model/probe",     # SSE; iterates models with up to 8s timeout each
    "/api/model-endpoints", # /probe sub-route also iterates models
    "/api/cookbook/setup",  # remote pacman/apt installs
    "/api/upload",          # large files
    "/api/image",           # diffusion proxies (inpaint/harmonize/upscale/etc.) — own 120s httpx timeout
)


class _RequestTimeoutMiddleware(_BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path or ""
        if any(path.startswith(p) for p in _TIMEOUT_EXEMPT_PREFIXES):
            return await call_next(request)
        try:
            return await _asyncio.wait_for(call_next(request), timeout=REQUEST_HARD_TIMEOUT)
        except _asyncio.TimeoutError:
            return _JSONResponse(
                {"detail": f"Request exceeded {REQUEST_HARD_TIMEOUT:.0f}s timeout"},
                status_code=504,
            )


app.add_middleware(_RequestTimeoutMiddleware)

# ========= 认证 =========
from routes.auth_routes import setup_auth_routes, SESSION_COOKIE

auth_manager = AuthManager()
app.state.auth_manager = auth_manager
AUTH_ENABLED = os.getenv("AUTH_ENABLED", "true").lower() != "false"
LOCALHOST_BYPASS = os.getenv("LOCALHOST_BYPASS", "false").lower() == "true"
if LOCALHOST_BYPASS:
    logger.warning("LOCALHOST_BYPASS is enabled, loopback requests bypass authentication. Do not expose this instance to a network.")

if AUTH_ENABLED:
    AUTH_EXEMPT_EXACT = {
        "/api/auth/setup",
        "/api/auth/signup",
        "/api/auth/login",
        "/api/auth/logout",
        "/api/auth/status",
        "/api/auth/features",
        "/api/auth/settings",
        "/api/auth/integrations/presets",
        "/api/health",
        "/api/version",
        "/login",
    }
    AUTH_EXEMPT_PREFIXES = ["/static"]
    # 动态路径：其处理程序通过路径内嵌的密钥来验证身份，
    # 而不依赖 session/bearer 认证。routes/task_routes.py 中的路由处理程序
    # 自行验证每个任务的 `webhook_token`，不匹配则返回 404，
    # 因此路径本身就是凭证 —— UI 将这些 URL 标注为"无需认证"，正是因为
    # 外部调用者（Zapier、n8n、curl）无法提供 session cookie。
    # 如果没有此豁免，AuthMiddleware 会在密钥被检查之前就将每个 POST 请求以 401 拒绝。
    import re as _re
    AUTH_EXEMPT_PATTERNS = [
        _re.compile(r"^/api/tasks/[^/]+/webhook/[^/]+/?$"),
    ]

    def _is_auth_exempt(path: str) -> bool:
        if path in AUTH_EXEMPT_EXACT:
            return True
        if any(path.startswith(p) for p in AUTH_EXEMPT_PREFIXES):
            return True
        return any(p.match(path) for p in AUTH_EXEMPT_PATTERNS)

    # 内存令牌缓存：前缀 → [(token_id, token_hash, owner, scopes)]。
    # 之前每个 API-bearer 请求都要查询数据库并线性扫描 bcrypt 校验。
    # 有了这个缓存后，仅在缓存版本更新时（令牌创建/撤销）才会访问数据库
    # —— 参见 app.state 中的 _token_cache_invalidate，
    # 由 routes/api_token_routes 调用。
    _token_cache: dict = {}
    _token_cache_lock = _asyncio.Lock()
    _token_cache_dirty = True

    def _token_cache_invalidate():
        nonlocal_dict = app.state.__dict__
        nonlocal_dict["_token_cache_dirty"] = True
    app.state.invalidate_token_cache = _token_cache_invalidate
    app.state._token_cache = _token_cache
    app.state._token_cache_dirty = True

    def _refresh_token_cache():
        """Rebuild the prefix→[(id,hash)] map from the DB."""
        from collections import defaultdict
        new_map = defaultdict(list)
        db = SessionLocal()
        try:
            rows = db.query(ApiToken).filter(ApiToken.is_active == True).all()
            for r in rows:
                scopes = [s.strip() for s in (getattr(r, "scopes", "") or "chat").split(",") if s.strip()]
                new_map[r.token_prefix].append((r.id, r.token_hash, getattr(r, "owner", None), scopes))
        finally:
            db.close()
        _token_cache.clear()
        _token_cache.update(new_map)
        app.state._token_cache_dirty = False

    # 这些请求头用于判断请求是否被代理/隧道转发（cloudflared、
    # nginx、Caddy、Tailscale Funnel 等）。cloudflared 从 127.0.0.1
    # 连接到应用，如果没有此检查，每个隧道转发的请求都会看起来像是
    # 本地回环，从而可能绕过认证。
    _PROXY_FWD_HEADERS = (
        "cf-connecting-ip", "cf-ray", "cf-visitor",
        "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded",
    )

    def _is_trusted_loopback(request: Request) -> bool:
        """True ONLY for a DIRECT loopback connection with no proxy/tunnel
        forwarding headers. A bare ``client.host in ('127.0.0.1','::1')`` check is
        unsafe behind a Cloudflare tunnel / reverse proxy: those connect from
        loopback, so a remote visitor would otherwise inherit local trust and
        slip past LOCALHOST_BYPASS or spoof the internal-tool path. Odysseus's own
        in-process agent loopback calls carry none of these headers, so they still
        qualify."""
        host = request.client.host if request.client else None
        if host not in ("127.0.0.1", "::1"):
            return False
        for _h in _PROXY_FWD_HEADERS:
            if request.headers.get(_h):
                return False
        return True

    class AuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            path = request.url.path
            # 真正的 CORS 预检请求（OPTIONS + Access-Control-Request-Method）
            # 设计上不携带凭证，必须到达 CORSMiddleware 才能得到响应。
            # AuthMiddleware 是最外层中间件，如果在预检阶段就要求认证，
            # 会导致 CORS 无法响应 —— 这会阻止所有跨域浏览器/WebView 客户端
            # 在发送实际请求之前就被拦截。放行真正的预检请求（仅带 ACRM
            # 头的 OPTIONS 请求；绝不是带凭证的请求）。
            if is_cors_preflight(request.method, request.headers):
                return await call_next(request)
            if _is_auth_exempt(path):
                return await call_next(request)
            # 进程内 internal-tool 令牌绕过。当 agent 工具层通过
            # HTTP 回环调用受管理员权限保护的路由时使用
            # （该上下文中没有 admin cookie 可用）。限制为
            # 回环客户端 + 匹配令牌以确保安全。
            try:
                from core.middleware import INTERNAL_TOOL_HEADER, INTERNAL_TOOL_TOKEN as _ITT
                _hdr = request.headers.get(INTERNAL_TOOL_HEADER)
                if _hdr and secrets.compare_digest(_hdr, _ITT) and _is_trusted_loopback(request):
                    # 身份模拟：当 agent 的回环调用设置了 X-Odysseus-Owner 时，
                    # 仅在该用户存在的情况下将请求归属于该用户。
                    # 授权检查保持独立；这只是用于 notes/calendar 等的所有者归属。
                    _impersonate = (request.headers.get("X-Odysseus-Owner") or "").strip()
                    _auth_mgr = getattr(request.app.state, "auth_manager", None) or auth_manager
                    if _impersonate and _impersonate in getattr(_auth_mgr, "users", {}):
                        request.state.current_user = _impersonate
                    else:
                        request.state.current_user = "internal-tool"
                    request.state.api_token = False
                    return await call_next(request)
            except Exception:
                pass
            # 允许直接 localhost 请求（来自心跳等的内部服务调用）。
            # 隧道/代理转发的请求会被 _is_trusted_loopback 排除，
            # 这样 LOCALHOST_BYPASS 就不会通过 Cloudflare 隧道/反向代理被滥用。
            # 无论如何，对于网络暴露的部署应保持 LOCALHOST_BYPASS=false。
            if LOCALHOST_BYPASS and _is_trusted_loopback(request):
                return await call_next(request)
            if not auth_manager.is_configured:
                # 暂无用户 —— 重定向到登录页进行首次设置
                if not path.startswith("/api/"):
                    return RedirectResponse(url="/login", status_code=302)
                return JSONResponse(status_code=401, content={"error": "Setup required"})

            # --- Bearer 令牌认证（供外部集成使用的 API 令牌）---
            auth_header = request.headers.get("authorization", "")
            if auth_header.startswith("Bearer ody_"):
                raw_token = auth_header[7:]
                # 合理性检查：令牌格式为 "ody_" + 43 个 base64 字符
                if len(raw_token) < 12 or len(raw_token) > 100:
                    return JSONResponse(status_code=401, content={"error": "Invalid API token"})
                prefix = raw_token[:8]
                try:
                    if app.state._token_cache_dirty:
                        async with _token_cache_lock:
                            if app.state._token_cache_dirty:
                                await _asyncio.to_thread(_refresh_token_cache)
                    candidates = list(_token_cache.get(prefix, ()))
                    matched_id = None
                    matched_owner = None
                    matched_scopes = []
                    for tid, thash, owner, scopes in candidates:
                        if _bcrypt.checkpw(raw_token.encode(), thash.encode()):
                            matched_id = tid
                            matched_owner = owner
                            matched_scopes = scopes or []
                            break
                    if matched_id:
                        # 在热路径之外更新 last_used_at。内联执行
                        # 会使请求在额外的一次提交中保持打开状态；
                        # 改为 fire-and-forget 方式。
                        async def _touch_last_used(tid: str):
                            def _do():
                                _db = SessionLocal()
                                try:
                                    _db.query(ApiToken).filter(ApiToken.id == tid).update(
                                        {"last_used_at": datetime.utcnow()}
                                    )
                                    _db.commit()
                                finally:
                                    _db.close()
                            try:
                                await _asyncio.to_thread(_do)
                            except Exception:
                                pass
                        _asyncio.create_task(_touch_last_used(matched_id))
                        # 将 bearer 令牌调用者排除在普通 cookie/user
                        # 路由之外。API 感知的路由可以读取 api_token_owner。
                        request.state.current_user = "api"
                        request.state.api_token = True
                        request.state.api_token_id = matched_id
                        request.state.api_token_owner = matched_owner
                        request.state.api_token_scopes = matched_scopes
                        return await call_next(request)
                except Exception:
                    logger.warning("API token auth error", exc_info=False)
                # 无效的 bearer 令牌 —— 立即拒绝
                return JSONResponse(status_code=401, content={"error": "Invalid API token"})

            # --- 基于 Cookie 的 session 认证 ---
            token = request.cookies.get(SESSION_COOKIE)
            if not auth_manager.validate_token(token):
                if path.startswith("/api/"):
                    return JSONResponse(status_code=401, content={"error": "Not authenticated"})
                return RedirectResponse(url="/login", status_code=302)

            # 将当前用户名附加到请求状态中，供下游路由使用
            request.state.current_user = auth_manager.get_username_for_token(token)
            request.state.api_token = False
            return await call_next(request)

    app.add_middleware(AuthMiddleware)
    logger.info("Auth middleware enabled (AUTH_ENABLED=true)")
else:
    logger.info("Auth middleware disabled (set AUTH_ENABLED=true to enable)")

# ========= 静态文件 =========
os.makedirs(STATIC_DIR, exist_ok=True)


class _RevalidatingStatic(StaticFiles):
    """Serve static assets normally, but force the browser to REVALIDATE
    source files (.js/.css/.html) on every load instead of serving a stale
    copy from disk cache. The app ships raw ES modules with no build step or
    versioned URLs, so browsers were caching modules across deploys — a code
    change wouldn't appear without a manual hard-refresh. `no-cache` keeps the
    cached bytes but requires a conditional request; unchanged files still
    return a cheap 304 (ETag/Last-Modified are preserved)."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if path.endswith((".js", ".css", ".html")):
            resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/static", _RevalidatingStatic(directory="static"), name="static")

# ========= 生成图片 =========
@app.get("/api/generated-image/{filename}")
async def serve_generated_image(filename: str, request: Request):
    """Serve generated images from the data directory."""
    img_path = resolve_generated_image_path(filename)
    # 安全性：filename 是唯一键，因此知道/猜出 12 位十六进制内容哈希
    # 的人可能会拉取到其他用户的图片数据。需要认证并通过 gallery 行
    # （如果存在）验证所有权。
    try:
        from src.auth_helpers import get_current_user
        from core.database import SessionLocal as _SL, GalleryImage as _GI
        _user = get_current_user(request)
        if _user:
            _db = _SL()
            try:
                _row = _db.query(_GI).filter(_GI.filename == filename).first()
                # 已生成但尚未导入的图片没有对应行 → 允许访问。
                # 行存在但所有者不同 → 404（不确认存在性）。
                if _row is not None and _row.owner and _row.owner != _user:
                    raise HTTPException(status_code=404, detail="Image not found")
            finally:
                _db.close()
    except HTTPException:
        raise
    except Exception:
        pass
    ext = filename.rsplit('.', 1)[-1].lower()
    mime = {
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "webp": "image/webp", "gif": "image/gif",
        "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
        "mkv": "video/x-matroska", "m4v": "video/mp4",
    }.get(ext, "application/octet-stream")
    # 生成图片的文件名是内容哈希 → 给定文件名的字节永远不会改变。
    # 将其硬缓存，这样画廊每次打开时不需要重新下载每张全尺寸图片。
    # `immutable` 告诉浏览器在 max-age 内永远不需要重新验证。
    return FileResponse(
        str(img_path),
        media_type=mime,
        headers=GENERATED_IMAGE_HEADERS,
    )

# ========= YouTube 初始化 =========
from services.youtube import init_youtube
init_youtube()

# ========= RAG（向量文档检索增强生成）=========
# VectorRAG（基于 ChromaDB 的个人文档语义搜索）。通过 get_rag_manager()
# 延迟初始化 —— 如果 ChromaDB 不可达（配置的 host:port 上没有运行服务器），
# 则返回 None，此时个人文档路由返回干净的 503 而非每次都重试。
#
# 注意：之前因为 chromadb 1.4.1 / pydantic 2.12 互不兼容而被硬编码关闭。
# 使用当前的版本约束（chromadb 1.5.x + pydantic 2.13.x）初始化正常工作，
# Personal Docs（POST /api/personal/add_directory 等）已恢复可用。
from src.rag_singleton import get_rag_manager
rag_manager = get_rag_manager()
rag_available = rag_manager is not None
if rag_available:
    logger.info("Vector document RAG initialized")
else:
    logger.info(
        "Vector document RAG not available at startup "
        "(ChromaDB may not be reachable yet — routes will retry lazily)"
    )

# ========= 导入配置 =========
from src.config import config

# ========= 组件初始化 =========
from src.app_initializer import initialize_managers

components = initialize_managers(BASE_DIR, rag_manager)

session_manager   = components["session_manager"]
from src.assistant_log import set_session_manager as _set_asst_sm
_set_asst_sm(session_manager)
memory_manager    = components["memory_manager"]
memory_vector     = components.get("memory_vector")
upload_handler    = components["upload_handler"]
personal_docs_mgr = components["personal_docs_manager"]
api_key_manager   = components["api_key_manager"]
preset_manager    = components["preset_manager"]
chat_processor    = components["chat_processor"]
research_handler  = components["research_handler"]
chat_handler      = components["chat_handler"]
model_discovery   = components["model_discovery"]
skills_manager    = components["skills_manager"]

# TTS
from services.tts import get_tts_service

tts_service = get_tts_service()
logger.info("TTS service initialized (provider managed via admin settings)")

# ========= 异常处理器 =========
@app.exception_handler(SessionNotFoundError)
async def session_not_found_handler(request: Request, exc: SessionNotFoundError):
    return JSONResponse(status_code=404, content={"error": "SESSION_NOT_FOUND", "message": str(exc)})

@app.exception_handler(InvalidFileUploadError)
async def invalid_file_upload_handler(request: Request, exc: InvalidFileUploadError):
    return JSONResponse(status_code=400, content={"error": "INVALID_FILE_UPLOAD", "message": str(exc)})

@app.exception_handler(LLMServiceError)
async def llm_service_error_handler(request: Request, exc: LLMServiceError):
    return JSONResponse(status_code=502, content={"error": "LLM_SERVICE_ERROR", "message": str(exc)})

@app.exception_handler(WebSearchError)
async def web_search_error_handler(request: Request, exc: WebSearchError):
    return JSONResponse(status_code=502, content={"error": "WEB_SEARCH_ERROR", "message": str(exc)})

# ========= Webhook 管理器 =========
from src.webhook_manager import WebhookManager

webhook_manager = WebhookManager(api_key_manager=api_key_manager)

# ========= 注册路由 =========

# Auth
auth_router = setup_auth_routes(auth_manager)
app.include_router(auth_router)

# 上传
from routes.upload_routes import setup_upload_routes
upload_router, upload_cleanup_func = setup_upload_routes(upload_handler)
app.include_router(upload_router)
upload_cleanup_task = None

# Emoji SVG 代理（同源、延迟缓存的 Twemoji）—— 让聊天中将
# emoji 渲染为扁平 SVG 而非系统彩色字形。
from routes.emoji_routes import setup_emoji_routes
app.include_router(setup_emoji_routes())

# 会话
from routes.session_routes import setup_session_routes
session_config = {"REQUEST_TIMEOUT": REQUEST_TIMEOUT, "OPENAI_API_KEY": OPENAI_API_KEY, "SESSIONS_FILE": SESSIONS_FILE}
app.include_router(setup_session_routes(session_manager, session_config, webhook_manager=webhook_manager))

# 管理员危险区域清除（设置 → 系统 → 危险区域）
from routes.admin_wipe_routes import setup_admin_wipe_routes
app.include_router(setup_admin_wipe_routes(session_manager))

# 记忆
from routes.memory_routes import setup_memory_routes
memory_router = setup_memory_routes(memory_manager, session_manager, memory_vector=memory_vector)
app.include_router(memory_router)
from routes.skills_routes import setup_skills_routes
app.include_router(setup_skills_routes(skills_manager))

# 聊天
from routes.chat_routes import setup_chat_routes
app.include_router(setup_chat_routes(
    session_manager, chat_handler, chat_processor,
    memory_manager, research_handler, upload_handler,
    memory_vector=memory_vector,
    webhook_manager=webhook_manager,
    skills_manager=skills_manager,
))

# 研究（后台深度研究任务）
from routes.research_routes import setup_research_routes
app.include_router(setup_research_routes(research_handler, session_manager=session_manager))

# 历史
from routes.history_routes import setup_history_routes
app.include_router(setup_history_routes(session_manager))

# 搜索
from routes.search_routes import setup_search_routes
app.include_router(setup_search_routes(config))

# 预设
from routes.preset_routes import setup_preset_routes
app.include_router(setup_preset_routes(preset_manager))

# 诊断
from routes.diagnostics_routes import setup_diagnostics_routes
app.include_router(setup_diagnostics_routes(rag_manager, rag_available, research_handler))

# 清理
from routes.cleanup_routes import setup_cleanup_routes
app.include_router(setup_cleanup_routes(session_manager))

# 个人文档
from routes.personal_routes import setup_personal_routes
app.include_router(setup_personal_routes(personal_docs_mgr, rag_manager, rag_available))

# 嵌入模型管理
from routes.embedding_routes import setup_embedding_routes
app.include_router(setup_embedding_routes())

# 模型
from routes.model_routes import setup_model_routes
app.include_router(setup_model_routes(model_discovery))

# GitHub Copilot 设备码登录
from routes.copilot_routes import setup_copilot_routes
app.include_router(setup_copilot_routes())

# ChatGPT 订阅设备码登录
from routes.chatgpt_subscription_routes import setup_chatgpt_subscription_routes
app.include_router(setup_chatgpt_subscription_routes())

# TTS
from routes.tts_routes import setup_tts_routes
app.include_router(setup_tts_routes(tts_service))

# STT
from services.stt import get_stt_service
stt_service = get_stt_service()
from routes.stt_routes import setup_stt_routes
app.include_router(setup_stt_routes(stt_service))
logger.info("STT service initialized (provider managed via settings)")

# 文档（artifacts/canvas）
from routes.document_routes import setup_document_routes
document_router = setup_document_routes(session_manager, upload_handler)
app.include_router(document_router)

# 签名（可复用的图片印章）
from routes.signature_routes import setup_signature_routes
app.include_router(setup_signature_routes())

# 画廊（图片库）
from routes.gallery_routes import setup_gallery_routes
app.include_router(setup_gallery_routes())

# 持久化图片编辑器草稿（基于服务器的项目）
from routes.editor_draft_routes import setup_editor_draft_routes
app.include_router(setup_editor_draft_routes())

# 定时任务 + 事件总线
from src.task_scheduler import TaskScheduler
task_scheduler = TaskScheduler(session_manager)
from src.event_bus import set_task_scheduler
set_task_scheduler(task_scheduler)
from routes.task_routes import setup_task_routes
app.include_router(setup_task_routes(task_scheduler))

from routes.assistant_routes import setup_assistant_routes
app.include_router(setup_assistant_routes(task_scheduler))

# 日历（CalDAV）
from routes.calendar_routes import setup_calendar_routes
calendar_router = setup_calendar_routes()
app.include_router(calendar_router)

# Shell（面向用户的命令执行）
from routes.shell_routes import setup_shell_routes
app.include_router(setup_shell_routes())

# Cookbook（模型下载/服务/缓存，cookbook 状态同步）
from routes.cookbook_routes import setup_cookbook_routes
app.include_router(setup_cookbook_routes())

# 硬件模型适配（cookbook "What Fits?" 标签页）
from routes.hwfit_routes import setup_hwfit_routes
app.include_router(setup_hwfit_routes())

# 模型 A/B 对比
from routes.compare_routes import setup_compare_routes
app.include_router(setup_compare_routes(session_manager))

# 用户偏好
from routes.prefs_routes import setup_prefs_routes
app.include_router(setup_prefs_routes())

# 备份（导出/导入用户数据）
from routes.backup_routes import setup_backup_routes
app.include_router(setup_backup_routes(memory_manager, preset_manager, skills_manager))

from routes.font_routes import setup_font_routes
app.include_router(setup_font_routes())


# MCP（模型上下文协议）
from src.mcp_manager import McpManager
from src.agent_tools import set_mcp_manager
from routes.mcp_routes import setup_mcp_routes

mcp_manager = McpManager()
set_mcp_manager(mcp_manager)
app.include_router(setup_mcp_routes(mcp_manager))
logger.info("MCP routes initialized")

# AI 交互工具（讨论、流水线、自管理 AI、UI 控制）
from src.ai_interaction import set_session_manager as set_ai_session_manager, set_memory_manager as set_ai_memory_manager, set_rag_manager as set_ai_rag_manager
set_ai_session_manager(session_manager)
set_ai_memory_manager(memory_manager, memory_vector)
set_ai_rag_manager(rag_manager, personal_docs_mgr)
logger.info("AI interaction tools initialized (session, memory, RAG, UI control)")

# Webhooks
from routes.webhook_routes import setup_webhook_routes
app.include_router(setup_webhook_routes(webhook_manager, auth_manager, session_manager, api_key_manager))

# API 令牌
from routes.api_token_routes import setup_api_token_routes
app.include_router(setup_api_token_routes())

logger.info("Webhook & API token routes initialized")

# 笔记（Google Keep 风格的笔记/待办事项）
from routes.note_routes import setup_note_routes
app.include_router(setup_note_routes(task_scheduler))

# 邮件
from routes.email_routes import setup_email_routes
email_router = setup_email_routes()
app.include_router(email_router)

# Codex 集成 —— Codex 插件/MCP 桥接的 HTTP 接口。复用
# api_token 作用域（todos:read|write, email:read|draft|send），
# 使外部 Codex 会话只能访问用户明确授权的数据。在 Email 之后挂载，
# 以便 codex_routes 可以借用 email router 的共享搜索/线程辅助功能。
from routes.codex_routes import setup_codex_routes, setup_claude_routes
app.include_router(setup_codex_routes(
    email_router=email_router,
    memory_router=memory_router,
    calendar_router=calendar_router,
    document_router=document_router,
))
app.include_router(setup_claude_routes())

from routes.vault_routes import setup_vault_routes
app.include_router(setup_vault_routes())

# 通讯录（CardDAV）
from routes.contacts_routes import setup_contacts_routes
app.include_router(setup_contacts_routes())

from companion import setup_companion_routes
app.include_router(setup_companion_routes())

# ========= 路由（保留在 app.py 中）=========

def _serve_html_with_nonce(request: Request, file_path: str) -> HTMLResponse:
    """Read an HTML file and inject the CSP nonce into inline <script> tags."""
    with open(file_path, "r", encoding="utf-8") as f:
        html = f.read()
    nonce = getattr(request.state, "csp_nonce", "")
    html = html.replace("{{CSP_NONCE}}", nonce)
    return HTMLResponse(html)

@app.get("/")
async def serve_index(request: Request):
    static_path = abs_join(BASE_DIR, "static/index.html")
    if os.path.exists(static_path):
        return _serve_html_with_nonce(request, static_path)
    root_path = abs_join(BASE_DIR, "index.html")
    if os.path.exists(root_path):
        return _serve_html_with_nonce(request, root_path)
    raise HTTPException(404, "index.html not found")

@app.get("/notes")
async def serve_notes(request: Request):
    return await serve_index(request)

@app.get("/calendar")
async def serve_calendar(request: Request):
    return await serve_index(request)

# 每个工具深度链接路由 —— 全部服务于同一个 SPA，JS 会根据
# window.location.pathname 自动打开对应的模态框。每个路由在 index.html 中
# 通过内联脚本获取独特的 favicon + 页面标题，使书签能显示特定工具的图标。
@app.get("/cookbook")
async def serve_cookbook(request: Request):
    return await serve_index(request)

@app.get("/email")
async def serve_email(request: Request):
    return await serve_index(request)

@app.get("/memory")
async def serve_memory(request: Request):
    return await serve_index(request)

@app.get("/gallery")
async def serve_gallery(request: Request):
    return await serve_index(request)

@app.get("/tasks")
async def serve_tasks(request: Request):
    return await serve_index(request)

@app.get("/library")
async def serve_library(request: Request):
    return await serve_index(request)

@app.get("/backgrounds")
async def serve_backgrounds(request: Request):
    """Sandbox page for prototyping background effects. No auth required."""
    return _serve_html_with_nonce(request, abs_join(BASE_DIR, "static/backgrounds.html"))

@app.get("/login")
async def serve_login(request: Request):
    if not AUTH_ENABLED:
        return RedirectResponse(url="/", status_code=302)
    return _serve_html_with_nonce(request, abs_join(BASE_DIR, "static/login.html"))

@app.get("/api/version")
async def get_version():
    from core.constants import APP_VERSION
    return {"version": APP_VERSION}

@app.get("/api/health")
async def health_check() -> Dict[str, str]:
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}

@app.get("/api/ready")
async def readiness_check() -> JSONResponse:
    """Readiness / integrity self-check — DB, data dir, local-first storage.

    Unlike /api/health (liveness), this returns 503 unless every critical
    subsystem is whole, so an orchestrator can gate traffic on real readiness.
    """
    from src.readiness import check_readiness
    result = check_readiness()
    return JSONResponse(status_code=200 if result.get("ready") else 503, content=result)

@app.get("/api/runtime")
async def runtime_info() -> Dict[str, object]:
    in_docker = os.path.exists("/.dockerenv")
    if not in_docker:
        try:
            with open("/proc/1/cgroup", "r", encoding="utf-8", errors="ignore") as fh:
                cg = fh.read()
            in_docker = any(marker in cg for marker in ("docker", "containerd", "kubepods"))
        except Exception:
            in_docker = False
    ollama_url = (
        os.getenv("OLLAMA_BASE_URL")
        or os.getenv("OLLAMA_URL")
        or ("http://host.docker.internal:11434/v1" if in_docker else "http://127.0.0.1:11434/v1")
    )
    return {
        "in_docker": in_docker,
        "ollama_base_url": ollama_url,
    }

# ========= 生命周期 =========

@asynccontextmanager
async def _lifespan(app):
    """Modern lifespan context manager replacing deprecated @app.on_event."""
    # ── 启动 ──
    await _startup_event()
    yield
    # ── 关闭 ──
    await _shutdown_event()

app.router.lifespan_context = _lifespan


async def _startup_event():
    global upload_cleanup_task
    logger.info("Application starting up...")
    webhook_manager.set_loop(asyncio.get_running_loop())
    # 清除上一个进程遗留的隐身会话 —— 它们按设计是临时的，
    # 不能存活过重启。
    try:
        from core.database import SessionLocal as _SL, Session as _DbSess, ChatMessage as _DbMsg
        _db = _SL()
        try:
            _ghosts = _db.query(_DbSess).filter(_DbSess.name.in_(("Nobody", "Incognito"))).all()
            for _g in _ghosts:
                _db.query(_DbMsg).filter(_DbMsg.session_id == _g.id).delete()
                _db.delete(_g)
            if _ghosts:
                _db.commit()
                logger.info(f"Purged {len(_ghosts)} leftover incognito session(s)")
        finally:
            _db.close()
    except Exception as e:
        logger.debug(f"Incognito purge skipped: {e}")
    # 对 fire-and-forget 启动任务的强引用。如果不这样做，Python 可能会
    # 在 `asyncio.create_task(...)` 创建的任务完成之前就将其 GC 回收。
    _startup_tasks: list[asyncio.Task] = getattr(app.state, "_startup_tasks", [])
    app.state._startup_tasks = _startup_tasks
    if upload_cleanup_func:
        upload_cleanup_task = asyncio.create_task(upload_cleanup_func())
    # 常驻监控：当后台 bash 任务（#!bg）完成时自动继续 agent
    # —— 用任务输出重新调用该轮对话。
    try:
        from src.bg_monitor import start_bg_monitor
        _startup_tasks.append(start_bg_monitor())
    except Exception as _e:
        logger.warning("Failed to start background-job monitor: %s", _e)
    # MCP 服务器可能很慢或被本地工具阻塞。在 Web 服务器接受流量
    # 之后再连接它们，而不是延迟整个 UI 的启动。
    async def _startup_mcp_connections():
        try:
            from src.builtin_mcp import register_builtin_servers
            await register_builtin_servers(mcp_manager)
        except BaseException as e:
            logger.warning(f"Built-in MCP registration failed (non-critical): {type(e).__name__}: {e}")
        try:
            await asyncio.wait_for(mcp_manager.connect_all_enabled(), timeout=20)
        except asyncio.TimeoutError:
            logger.warning("User MCP startup timed out (non-critical)")
        except BaseException as e:
            logger.warning(f"MCP startup failed (non-critical): {type(e).__name__}: {e}")

    _startup_tasks.append(asyncio.create_task(_startup_mcp_connections()))

    # 在请求路径之外预热 RAG 工具索引。加载本地嵌入模型 +
    # 打开 ChromaDB + 索引内置工具的是一次性的 ~1-3s 开销，
    # 否则会落在用户的第一个消息上（表现为巨大的 `tool_selection` 时间）。
    # 在这里完成使第一轮对话和后续一样快（预热后嵌入只需几毫秒）。
    async def _warmup_tool_index():
        try:
            from src.tool_index import get_tool_index
            idx = await asyncio.to_thread(get_tool_index)
            if idx:
                await asyncio.to_thread(idx.get_tools_for_query, "warmup", 8)
                logger.info("[startup] Tool index pre-warmed")
        except Exception as e:
            logger.warning(f"Tool index warmup failed (non-critical): {type(e).__name__}: {e}")

    _startup_tasks.append(asyncio.create_task(_warmup_tool_index()))
    # 预热：ping 所有已知的 LLM 端点以建立连接
    async def _warmup_endpoints():
        try:
            import httpx
            endpoints = model_discovery.get_endpoints() if model_discovery else []
            for ep in endpoints[:5]:
                url = ep.get("url", "").replace("/chat/completions", "/models")
                if url:
                    try:
                        async with httpx.AsyncClient(timeout=5.0) as client:
                            await client.get(url)
                        logger.info(f"Warmup ping OK: {url}")
                    except Exception as e:
                        logger.debug(f"Warmup ping failed for endpoint: {e}")
        except Exception as e:
            logger.debug(f"Warmup ping skipped: {e}")

    _startup_tasks.append(asyncio.create_task(_warmup_endpoints()))

    # 保持连接：每 60 秒 ping 一次端点以防止冷启动
    async def _keepalive_loop():
        while True:
            try:
                await asyncio.sleep(60)
                await _warmup_endpoints()
            except Exception as e:
                logger.warning(f"Keepalive loop error: {e}")
                await asyncio.sleep(300)  # 出错时退避等待

    _startup_tasks.append(asyncio.create_task(_keepalive_loop()))

    async def _ensure_default_tasks():
        # 为每个用户创建/协调默认自动化任务 + 个人助手。
        owners = set()
        try:
            import json as _json
            auth_path = AUTH_FILE
            with open(auth_path, encoding="utf-8") as f:
                users = _json.load(f).get("users", {})
            owners.update(users.keys())
        except Exception as e:
            logger.debug(f"Default task auth-owner scan: {e}")

        # 同时协调 scheduled_tasks 中已存在的所有者。这样可以清理
        # 过时的/演示/已删除用户的内置任务，这些任务已不在 auth.json 中；
        # 否则它们的旧计划行会永远触发。
        try:
            from core.database import SessionLocal, ScheduledTask
            from src.task_scheduler import HOUSEKEEPING_DEFAULTS
            builtin_names = []
            for defs in HOUSEKEEPING_DEFAULTS.values():
                builtin_names.append(defs["name"])
                builtin_names.extend(defs.get("legacy_names") or [])
            db_seed = SessionLocal()
            try:
                rows = db_seed.query(ScheduledTask.owner).filter(
                    (ScheduledTask.action.in_(list(HOUSEKEEPING_DEFAULTS.keys())))
                    | (ScheduledTask.name.in_(builtin_names))
                ).distinct().all()
                owners.update(row[0] for row in rows if row[0])
            finally:
                db_seed.close()
        except Exception as e:
            logger.debug(f"Default task existing-owner scan: {e}")

        try:
            for uname in sorted(owners):
                try:
                    await task_scheduler.ensure_defaults(uname)
                except Exception as e:
                    logger.debug(f"ensure_defaults({uname}): {e}")
        except Exception as e:
            logger.debug(f"Default tasks: {e}")

    # 在 runner 启动前协调内置任务。否则旧版计划内置任务
    # 可能会在转换为事件任务之前触发一次。
    await _ensure_default_tasks()

    # 磁盘存储的技能不受 DB 旧版所有者扫描覆盖。修复无所有者或已删除/
    # 测试所有者的 SKILL.md 文件，这样严格的所有者过滤不会在 auth/账户
    # 变更后让现有库看起来是空的。
    try:
        import json as _json
        auth_path = AUTH_FILE
        with open(auth_path, encoding="utf-8") as f:
            users = _json.load(f).get("users", {})
        primary_owner = None
        for uname, udata in users.items():
            if udata.get("is_admin") is True:
                primary_owner = uname
                break
        if not primary_owner and users:
            primary_owner = next(iter(users))
        if primary_owner:
            changed = skills_manager.backfill_owner(primary_owner, set(users.keys()))
            if changed:
                logger.info("Assigned %s legacy skill file(s) to %s", changed, primary_owner)
    except Exception as e:
        logger.debug(f"Skill owner backfill skipped: {e}")

    # 启动计划任务运行器 —— 在 cron 驱动部署中跳过，
    # 这种情况下由外部 worker 驱动任务触发。与邮件轮询器中的
    # `ODYSSEUS_INPROCESS_POLLERS` 镜像。
    _tasks_inprocess = os.environ.get("ODYSSEUS_INPROCESS_TASKS", "1").strip().lower()
    if _tasks_inprocess not in ("0", "false", "no", "off", ""):
        await task_scheduler.start()
    else:
        logger.info(
            "In-process task scheduler disabled (ODYSSEUS_INPROCESS_TASKS=0); "
            "drive task firing externally (e.g. cron)."
        )
    # 定期空所有者清扫 —— 每小时重新运行旧版所有者分配，
    # 这样在 auth 被禁用或 localhost-bypass 期间创建的任何数据
    # 都会被管理员认领，而不是保持全局可见（M19）。
    async def _null_owner_sweep_loop():
        while True:
            try:
                await asyncio.sleep(3600)
                from core.database import _migrate_assign_legacy_owner
                await asyncio.to_thread(_migrate_assign_legacy_owner)
            except Exception as e:
                logger.debug(f"Null-owner sweep skipped: {e}")
                await asyncio.sleep(3600)

    _startup_tasks.append(asyncio.create_task(_null_owner_sweep_loop()))

    # 夜间技能审计 —— 在本地时间约 02:00，测试 + 评估一组
    # 最近最少检查的技能，自动修复/升级较弱的技能（从不删除）。
    # 在库中轮流进行，每晚覆盖不同的技能。
    # 由 `skill_audit_nightly` 设置控制（默认开启）；时间通过
    # `skill_audit_hour`（默认 2），批次大小通过 `skill_audit_batch`（8）。
    async def _skill_audit_nightly_loop():
        from datetime import timedelta
        while True:
            try:
                from src.settings import get_setting
                hour = int(get_setting("skill_audit_hour", 2) or 2)
            except Exception:
                hour = 2
            now = datetime.now()
            nxt = now.replace(hour=hour % 24, minute=0, second=0, microsecond=0)
            if nxt <= now:
                nxt += timedelta(days=1)
            await asyncio.sleep(max(60, (nxt - now).total_seconds()))
            try:
                from src.settings import get_setting
                if not get_setting("skill_audit_nightly", True):
                    continue
                batch = int(get_setting("skill_audit_batch", 8) or 8)
                from routes.skills_routes import run_scheduled_skill_audit
                await run_scheduled_skill_audit(skills_manager, owner=None, max_skills=batch)
            except Exception as e:
                logger.warning(f"Nightly skill audit failed: {e}")

    _startup_tasks.append(asyncio.create_task(_skill_audit_nightly_loop()))

    # Cookbook 服务生命周期 —— 终止调度器启动的、窗口结束时间
    # 已过的服务。与 cookbook_serve 内置操作配对使用；
    # 除非计划任务实际启动了设置了 end_after_min 的服务，
    # 否则两者都是空操作。移除此行 +
    # BUILTIN_ACTIONS 中的 cookbook_serve 条目 + src/cookbook_serve_lifecycle.py
    # 即可移除此功能。
    from src.cookbook_serve_lifecycle import cookbook_serve_lifecycle_loop
    _startup_tasks.append(asyncio.create_task(cookbook_serve_lifecycle_loop()))

    logger.info("Application startup complete")

async def _shutdown_event():
    logger.info("Application shutting down...")
    if upload_cleanup_task:
        upload_cleanup_task.cancel()
        try:
            await upload_cleanup_task
        except asyncio.CancelledError:
            pass
    # 停止任务调度器（如果未在 gate 下启动则为空操作）
    try:
        await task_scheduler.stop()
    except Exception:
        pass
    # 关闭 webhook 管理器
    try:
        await webhook_manager.close()
    except Exception as e:
        logger.warning(f"Webhook manager shutdown error: {e}")
    # 断开所有 MCP 服务器
    try:
        await mcp_manager.disconnect_all()
    except Exception as e:
        logger.warning(f"MCP shutdown error: {e}")
    logger.info("Application shutdown complete")
