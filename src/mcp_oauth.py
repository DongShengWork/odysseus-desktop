"""mcp_oauth.py — 远程（Streamable HTTP）MCP 服务器的通用 OAuth。

将 mcp SDK 的 OAuthClientProvider（RFC 9728 discovery、Dynamic Client
Registration、authorization-code + PKCE、token refresh）桥接到 Odysseus 的
web 回调路由。Token 和动态注册信息按服务器持久化加密存储，
因此交互式流程只需执行一次。
"""
import asyncio
import json
import logging
import os
import time
from typing import Dict, Optional, Tuple
from urllib.parse import urlparse, parse_qs

logger = logging.getLogger(__name__)

# OAuth 重定向 URI，通过 DCR 在每个授权服务器注册。Loopback
# 对于原生/桌面客户端是允许的（RFC 8252）；远程用户通过粘贴回流
# 完成授权。无法在 http://localhost:7000 访问的部署（自定义
# 端口、反向代理或公网域名）必须设置 OAUTH_REDIRECT_BASE_URL（或
# APP_PUBLIC_URL）为外部可访问的地址，以便重定向回到
# Odysseus。APP_PORT 故意不使用：它只是 Docker 主机的
# 端口映射；应用在容器内始终监听 7000。
_REDIRECT_BASE = (
    os.environ.get("OAUTH_REDIRECT_BASE_URL")
    or os.environ.get("APP_PUBLIC_URL")
    or "http://localhost:7000"
).rstrip("/")
REDIRECT_URI = f"{_REDIRECT_BASE}/api/mcp/oauth/callback"

# 后台连接等待用户授权的最大秒数。
AUTH_WAIT_SECONDS = 300

_pending: Dict[str, asyncio.Future] = {}   # state -> Future[(code, state)]
_pending_ts: Dict[str, float] = {}         # state -> monotonic 时间戳，用于清理
_auth_urls: Dict[str, str] = {}            # server_id -> 授权 URL


def _prune_stale() -> None:
    """Drop abandoned flows whose authorization window has elapsed so the
    module-level registries don't grow unbounded (e.g. a user who never
    finishes the browser step)."""
    now = time.monotonic()
    for state in [s for s, ts in _pending_ts.items() if now - ts > AUTH_WAIT_SECONDS]:
        fut = _pending.pop(state, None)
        _pending_ts.pop(state, None)
        if fut is not None and not fut.done():
            fut.cancel()


def _discard_pending(state: Optional[str]) -> None:
    if state is None:
        return
    _pending.pop(state, None)
    _pending_ts.pop(state, None)


def register_pending(state: str) -> asyncio.Future:
    _prune_stale()
    fut = asyncio.get_running_loop().create_future()
    _pending[state] = fut
    _pending_ts[state] = time.monotonic()
    return fut


def resolve_pending(state: str, code: str) -> bool:
    fut = _pending.get(state)
    if fut is not None and not fut.done():
        fut.set_result((code, state))
        return True
    return False


def pop_auth_url(server_id: str) -> Optional[str]:
    return _auth_urls.get(server_id)


def clear_auth_url(server_id: str) -> None:
    _auth_urls.pop(server_id, None)


class DbTokenStorage:
    """基于加密的 McpServer.oauth_tokens 列的 SDK TokenStorage 实现。"""

    def __init__(self, server_id: str, session_factory=None):
        self.server_id = server_id
        if session_factory is None:
            from core.database import SessionLocal
            session_factory = SessionLocal
        self._sf = session_factory

    def _load(self) -> dict:
        from core.database import McpServer
        db = self._sf()
        try:
            srv = db.query(McpServer).filter(McpServer.id == self.server_id).first()
            if srv and srv.oauth_tokens:
                return json.loads(srv.oauth_tokens)
        finally:
            db.close()
        return {}

    def _update(self, key: str, value: dict) -> None:
        """在单个 session/commit 中加载、设置一个键并持久化 oauth_tokens JSON
        （避免每次写的 load+save 双重往返）。"""
        from core.database import McpServer
        db = self._sf()
        try:
            srv = db.query(McpServer).filter(McpServer.id == self.server_id).first()
            if srv is None:
                return
            data = json.loads(srv.oauth_tokens) if srv.oauth_tokens else {}
            data[key] = value
            srv.oauth_tokens = json.dumps(data)
            db.commit()
        finally:
            db.close()

    async def get_tokens(self):
        from mcp.shared.auth import OAuthToken
        data = self._load().get("tokens")
        return OAuthToken.model_validate(data) if data else None

    async def set_tokens(self, tokens) -> None:
        self._update("tokens", json.loads(tokens.model_dump_json()))

    async def get_client_info(self):
        from mcp.shared.auth import OAuthClientInformationFull
        data = self._load().get("client_info")
        return OAuthClientInformationFull.model_validate(data) if data else None

    async def set_client_info(self, client_info) -> None:
        self._update("client_info", json.loads(client_info.model_dump_json()))


def build_provider(server_id: str, url: str, on_redirect=None):
    """Construct an OAuthClientProvider that drives the browser flow via the
    Odysseus callback route.

    on_redirect(authorization_url): 可选同步回调，在授权 URL 已知时
    the authorization URL is known (after discovery + DCR). The manager uses it
    to publish 'needs_auth' + auth_url to connection state regardless of how
    + auth_url 到连接状态，无论 discovery/DCR 耗时多久。
    """
    from mcp.client.auth import OAuthClientProvider
    from mcp.shared.auth import OAuthClientMetadata

    client_metadata = OAuthClientMetadata(
        client_name="Odysseus",
        redirect_uris=[REDIRECT_URI],
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
        # 不设置 权限范围：SDK 应用 MCP 权限范围 选择策略，并在构建
        # auth URL 之前从服务器的 WWW-Authenticate / protected-resource
        # 元数据中覆盖此值。在这里硬编码 OIDC 权限范围 会破坏许多
        # 非 OpenID provider 的 MCP 服务器。
        scope=None,
        token_endpoint_auth_method="none",
    )

    async def redirect_handler(authorization_url: str) -> None:
        state = (parse_qs(urlparse(authorization_url).query).get("state") or [None])[0]
        if state:
            register_pending(state)
        _auth_urls[server_id] = authorization_url
        if on_redirect is not None:
            try:
                on_redirect(authorization_url)
            except Exception as e:
                logger.warning(f"MCP OAuth on_redirect callback failed: {e}")
        logger.info(f"MCP OAuth: server {server_id} awaiting authorization (state={state})")

    async def callback_handler() -> Tuple[str, Optional[str]]:
        auth_url = _auth_urls.get(server_id)
        state = (parse_qs(urlparse(auth_url).query).get("state") or [None])[0] if auth_url else None
        fut = _pending.get(state)
        if fut is None:
            raise RuntimeError("No pending OAuth flow for this server")
        try:
            code, ret_state = await asyncio.wait_for(fut, timeout=AUTH_WAIT_SECONDS)
            return code, ret_state
        finally:
            _discard_pending(state)
            _auth_urls.pop(server_id, None)

    return OAuthClientProvider(
        server_url=url,
        client_metadata=client_metadata,
        storage=DbTokenStorage(server_id),
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
    )
