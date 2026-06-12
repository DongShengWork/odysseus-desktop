# routes/emoji_routes.py
# 同源 emoji SVG 代理。前端将聊天中的 emoji 重写为
#   <span class="emoji" style="--em:url('/api/emoji/<codepoints>.svg')">
# 它使用返回的 SVG 作为 CSS 蒙版，着色为文本颜色，因此 emoji
# 渲染为单色线条图标（项目规则：永不使用彩色 emoji）。
# 黑色线稿 SVG 在首次使用时从 OpenMoji CDN 延迟加载并缓存到磁盘，因此：
#   - 客户端仅与自己的源通信（无需 CDN 依赖，无需 CSP 变更），
#   - 仓库不会因数千个 SVG 文件而膨胀，
#   - 一旦某个 emoji 被看过一次，离线也能正常工作。
# 未知/不可达的码点返回透明 SVG（非 404），因此 CSS
# 蒙版显示为空，而非实心的 currentColor 方块。
import logging
import re
from pathlib import Path

import httpx
from fastapi import APIRouter
from fastapi.responses import Response

from src.constants import EMOJI_CACHE_DIR

logger = logging.getLogger(__name__)

_CACHE_DIR = Path(EMOJI_CACHE_DIR)
# OpenMoji "black" set = monochrome line-art SVGs. Filenames are the codepoints
# in UPPERCASE (FE0F dropped, same as we compute), '-' joined.
_OPENMOJI_BASE = "https://cdn.jsdelivr.net/npm/openmoji@15.0.0/black/svg"
# codepoints like "1f600" or "1f468-200d-1f469-200d-1f467" (lowercase hex, '-' joined)
_CODE_RE = re.compile(r"^[0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*$")
_MAX_SVG_BYTES = 256 * 1024
_BLOCKED_SVG_RE = re.compile(
    br"<\s*(?:script|foreignObject|iframe|object|embed|image)\b|"
    br"\bon[a-z0-9_-]+\s*=",
    re.IGNORECASE,
)
_EXTERNAL_REF_RE = re.compile(
    br"\b(?:href|xlink:href)\s*=\s*['\"](?:https?:|//|data:|javascript:)",
    re.IGNORECASE,
)
_SVG_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
}
_SVG_HEADERS = {
    "Cache-Control": "public, max-age=31536000, immutable",
    **_SVG_SECURITY_HEADERS,
}
# Returned when a codepoint is unknown/unreachable: an empty (transparent) SVG,
# so the CSS mask renders nothing instead of a solid box. Not cached, so a later
# request can still pick up the real glyph once the CDN is reachable.
_BLANK_SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>'
_BLANK_HEADERS = {"Cache-Control": "no-store", **_SVG_SECURITY_HEADERS}


def _is_safe_svg(content: bytes) -> bool:
    if not isinstance(content, bytes) or not content:
        return False
    if len(content) > _MAX_SVG_BYTES:
        return False
    if b"<svg" not in content[:256].lower():
        return False
    if _BLOCKED_SVG_RE.search(content) or _EXTERNAL_REF_RE.search(content):
        return False
    return True


def setup_emoji_routes() -> APIRouter:
    router = APIRouter(prefix="/api/emoji", tags=["emoji"])

    def _blank() -> Response:
        return Response(_BLANK_SVG, media_type="image/svg+xml", headers=_BLANK_HEADERS)

    @router.get("/{code}.svg")
    async def emoji_svg(code: str):
        code = code.lower()
        if not _CODE_RE.match(code):
            return _blank()

        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        fp = _CACHE_DIR / f"{code}.svg"
        if fp.exists():
            try:
                content = fp.read_bytes()
                if _is_safe_svg(content):
                    return Response(content, media_type="image/svg+xml", headers=_SVG_HEADERS)
                fp.unlink(missing_ok=True)
            except Exception as e:
                logger.warning("emoji cache read %s failed: %s", code, e)
            return _blank()

        # First time we've seen this emoji — fetch the OpenMoji black SVG + cache
        # it. OpenMoji filenames are the codepoints uppercased.
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.get(f"{_OPENMOJI_BASE}/{code.upper()}.svg")
            if r.status_code == 200 and _is_safe_svg(r.content):
                try:
                    fp.write_bytes(r.content)
                except Exception:
                    pass  # cache write is best-effort
                return Response(r.content, media_type="image/svg+xml", headers=_SVG_HEADERS)
        except Exception as e:
            logger.warning("emoji fetch %s failed: %s", code, e)

        return _blank()

    return router
