# src/endpoint_resolver.py
"""所有后端服务的统一端点解析。

将 4 份以上的 normalize_base / resolve_endpoint 逻辑整合到一处。
"""

import json
import logging
import socket
import subprocess
from typing import Optional, Tuple, Dict
from urllib.parse import urlparse, urlunparse

from core.database import SessionLocal, ModelEndpoint
from src.llm_core import _detect_provider, _host_match, _ollama_api_root

logger = logging.getLogger(__name__)

# 非对话/生成模型的模型名称子字符串。当端点没有配置
# 显式模型时，我们从其列表中挑选第一个 CHAT 模型 —
# 永远不选 embedding/tts 等。（OpenAI 风格的端点经常把
# `text-embedding-ada-002` 排在第一个，这会导致邮件摘要
# 和其他 resolve_endpoint 调用者静默报 "Cannot reach model" 错误）。
_NON_CHAT_MODEL = (
    "text-embedding", "embedding", "tts-", "whisper", "dall-e",
    "moderation", "rerank", "reranker", "clip", "stable-diffusion",
)


def _first_chat_model(models) -> Optional[str]:
    """返回第一个非 embedding/tts 等的模型；若无则回退到 models[0]。"""
    for m in (models or []):
        if not any(p in str(m).lower() for p in _NON_CHAT_MODEL):
            return m
    return (models[0] if models else None)


def _endpoint_cached_models(ep) -> list:
    """从当前或旧版端点字段返回缓存的模型 ID。"""
    raw = getattr(ep, "cached_models", None) or getattr(ep, "models", None)
    if not raw:
        return []
    try:
        models = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return []
    return models if isinstance(models, list) else []


def _endpoint_hidden_models(ep) -> set:
    """管理员在此端点上禁用的模型 ID（UI 中的隐藏列表）。"""
    raw = getattr(ep, "hidden_models", None)
    if not raw:
        return set()
    try:
        hidden = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return set()
    return set(hidden) if isinstance(hidden, list) else set()


def _endpoint_enabled_models(ep) -> list:
    """缓存的模型减去端点上禁用的模型，保持原始顺序。

    自动选择回退绝不能选择用户已禁用的模型 — 一个
    Groq 端点可以列出 16 个模型而只有 1 个启用，选择
    原始列表中的第一个会解析到返回 400 的模型（"requires terms acceptance"）。
    """
    hidden = _endpoint_hidden_models(ep)
    return [m for m in _endpoint_cached_models(ep) if m not in hidden]


def resolve_endpoint_runtime(ep, owner: Optional[str] = None) -> Tuple[str, Optional[str]]:
    """将 ModelEndpoint 行解析为其运行时 base URL 和 bearer/API key。

    静态密钥提供商使用 ``ModelEndpoint.api_key``。会话支持的提供商
    将可刷新凭证存储在 ProviderAuthSession 中，必须在调用时解析
    当前的 access token。
    """
    base = normalize_base(getattr(ep, "base_url", "") or "")
    api_key = getattr(ep, "api_key", None)
    auth_id = getattr(ep, "provider_auth_id", None)
    if auth_id:
        from src.chatgpt_subscription import resolve_runtime_credentials

        creds = resolve_runtime_credentials(auth_id, owner=owner)
        base = normalize_base(creds.get("base_url") or base)
        api_key = creds.get("api_key")
    return base, api_key


# Tailscale 主机名 → IP 的解析缓存
_tailscale_cache: Dict[str, Optional[str]] = {}


def _resolve_tailscale_host(hostname: str) -> Optional[str]:
    """如果 DNS 解析失败，尝试通过 'tailscale status' 解析主机名。"""
    if hostname in _tailscale_cache:
        return _tailscale_cache[hostname]

    # 首先检查普通 DNS 是否可用
    try:
        socket.getaddrinfo(hostname, None, socket.AF_INET)
        _tailscale_cache[hostname] = None  # DNS 可用，无需覆盖
        return None
    except socket.gaierror:
        pass

    # DNS 失败 — 尝试 tailscale
    try:
        result = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            import json as _json
            data = _json.loads(result.stdout)
            peers = data.get("Peer", {})
            for _id, peer in peers.items():
                peer_name = (peer.get("HostName") or "").lower()
                dns_name = (peer.get("DNSName") or "").split(".")[0].lower()
                if peer_name == hostname.lower() or dns_name == hostname.lower():
                    addrs = peer.get("TailscaleIPs", [])
                    if addrs:
                        ip = addrs[0]
                        logger.info(f"Resolved '{hostname}' via Tailscale → {ip}")
                        _tailscale_cache[hostname] = ip
                        return ip
    except Exception as e:
        logger.debug(f"Tailscale resolution failed for '{hostname}': {e}")

    _tailscale_cache[hostname] = None
    return None


def resolve_url(url: str) -> str:
    """如果 URL 的主机名无法通过 DNS 解析，尝试通过 Tailscale 解析。"""
    parsed = urlparse(url)
    hostname = parsed.hostname
    if not hostname:
        return url
    ip = _resolve_tailscale_host(hostname)
    if ip:
        # 在 URL 中将主机名替换为 IP
        netloc = ip
        if parsed.port:
            netloc = f"{ip}:{parsed.port}"
        return urlunparse(parsed._replace(netloc=netloc))
    return url


def normalize_base(url: str) -> str:
    """从 base URL 中移除已知的 API 路径后缀。"""
    url = (url or "").strip().rstrip("/")
    for suffix in ["/models", "/chat/completions", "/completions", "/v1/messages", "/responses"]:
        if url.endswith(suffix):
            url = url[: -len(suffix)].rstrip("/")
    for suffix in ["/chat", "/tags", "/generate"]:
        if url.endswith("/api" + suffix):
            url = url[: -len(suffix)].rstrip("/")
    return url


def _anthropic_api_root(base: str) -> str:
    """返回 Anthropic 的 API 根路径，对其他地方保留 /v1 以兼容 OpenAI 风格的 API。"""
    base = (base or "").strip().rstrip("/")
    if _host_match(base, "anthropic.com") and base.endswith("/v1"):
        return base[:-3].rstrip("/")
    return base


def build_chat_url(base: str) -> str:
    """返回给定 base 对应的正确对话端点 URL。"""
    base = resolve_url(base)
    provider = _detect_provider(base)
    if provider == "anthropic":
        return _anthropic_api_root(base) + "/v1/messages"
    if provider == "ollama":
        return _ollama_api_root(base) + "/chat"
    if provider == "chatgpt-subscription":
        return base.rstrip("/") + "/responses"
    return base + "/chat/completions"


def build_models_url(base: str) -> Optional[str]:
    """返回给定 base 对应的提供商特定模型列表端点 URL。"""
    base = normalize_base(resolve_url(base))
    provider = _detect_provider(base)
    if provider == "anthropic":
        return _anthropic_api_root(base) + "/v1/models"
    if provider == "ollama":
        return _ollama_api_root(base) + "/tags"
    if provider == "chatgpt-subscription":
        return None
    return base + "/models"


def build_headers(api_key: Optional[str], base: str) -> Dict[str, str]:
    """为端点构建认证头。"""
    provider = _detect_provider(base)
    headers: Dict[str, str] = {}
    if provider == "anthropic":
        if api_key:
            headers["x-api-key"] = api_key
        headers["anthropic-version"] = "2023-06-01"
        return headers
    if provider == "copilot":
        from src.copilot import copilot_headers
        return copilot_headers(api_key)
    if provider == "chatgpt-subscription":
        from src.chatgpt_subscription import chatgpt_headers
        return chatgpt_headers(api_key)
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if provider == "openrouter":
        headers.setdefault("HTTP-Referer", "https://github.com/pewdiepie-archdaemon/odysseus")
        headers.setdefault("X-OpenRouter-Title", "Odysseus")
    return headers


def resolve_endpoint(
    setting_prefix: str,
    fallback_url: Optional[str] = None,
    fallback_model: Optional[str] = None,
    fallback_headers: Optional[Dict] = None,
    owner: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str], Optional[Dict]]:
    """从设置中解析端点/模型，支持回退。

    Args:
        setting_prefix: 设置键前缀，例如 "research"、"task"、"utility"、"default"。
                       从设置中读取 ``{prefix}_endpoint_id`` 和 ``{prefix}_model``。
        fallback_url:    设置为空或端点缺失时使用的 URL。
        fallback_model:  设置为空时使用的模型。
        fallback_headers: 使用回退时使用的请求头。

    Returns:
        (endpoint_url, model, headers) — 解析后的值或回退值。
    """
    try:
        from src.settings import get_user_setting, load_settings
        settings = load_settings()
    except Exception:
        return fallback_url, fallback_model, fallback_headers

    owner_str = owner or ""
    def _stg(key: str) -> str:
        return (get_user_setting(key, owner_str, settings.get(key, "")) or "").strip()

    ep_id = _stg(f"{setting_prefix}_endpoint_id")
    model = _stg(f"{setting_prefix}_model")

    # 如果未配置特定端点，但调用方提供了有效的回退
    # （例如当前会话模型），则立即使用。
    # 这可以防止后台任务在用户正在使用其他模型进行对话时
    # 跳转到全局 default_model。
    if not ep_id and fallback_url and fallback_model:
        return fallback_url, fallback_model, fallback_headers

    # 未设置的 Utility 意味着"与默认对话模型相同"。
    if setting_prefix == "utility" and not ep_id:
        ep_id = _stg("default_endpoint_id")
        model = _stg("default_model")

    # 如果未专门配置，task/research/auto-naming 回退到 utility 模型。
    # 如果 Utility 本身也未设置，上面的块使其解析为默认对话模型。
    if not ep_id and setting_prefix != "utility":
        ep_id = _stg("utility_endpoint_id")
        model = _stg("utility_model")
        if not ep_id:
            ep_id = _stg("default_endpoint_id")
            model = _stg("default_model")

    if not ep_id:
        return fallback_url, fallback_model, fallback_headers

    db = SessionLocal()
    try:
        ep = db.query(ModelEndpoint).filter(
            ModelEndpoint.id == ep_id,
            ModelEndpoint.is_enabled == True,
        )
        if owner:
            from src.auth_helpers import owner_filter
            ep = owner_filter(ep, ModelEndpoint, owner).first()
        else:
            ep = ep.first()
        if not ep:
            return fallback_url, fallback_model, fallback_headers

        try:
            base, api_key = resolve_endpoint_runtime(ep, owner=owner)
        except Exception as e:
            logger.warning("Could not resolve endpoint runtime credentials: %s", e)
            return fallback_url, fallback_model, fallback_headers
        chat_url = build_chat_url(base)
        headers = build_headers(api_key, base)

        # 丢弃用户已在此端点上禁用的已配置模型
        # （例如过时的 `default_model` 仍指向现在被隐藏的模型）。
        # 将其视为未设置，以便下面的选择器选择可用模型
        # 而不是派发到返回 400 的已禁用模型。
        if model and model in _endpoint_hidden_models(ep):
            model = ""
        # 如果未指定（可用）模型，选择第一个启用的对话模型。
        if not model:
            model = _first_chat_model(_endpoint_enabled_models(ep)) or ""
        if not model and not fallback_model:
            logger.warning('[resolve_endpoint] no usable model (all models hidden or list empty)')

        return chat_url, model or fallback_model, headers
    except Exception as e:
        logger.debug(f"Could not resolve {setting_prefix} endpoint: {e}")
        return fallback_url, fallback_model, fallback_headers
    finally:
        db.close()


def resolve_endpoint_by_id(
    ep_id: str, model: Optional[str] = None, owner: Optional[str] = None
) -> Optional[Tuple[str, str, Dict]]:
    """将特定端点 ID（+可选模型）解析为 (chat_url, model, headers)。

    如果端点不存在或已禁用则返回 None。用于将
    已配置的回退条目 ({endpoint_id, model}) 转换为派发目标。
    """
    if not ep_id:
        return None
    db = SessionLocal()
    try:
        q = db.query(ModelEndpoint).filter(
            ModelEndpoint.id == ep_id,
            ModelEndpoint.is_enabled == True,
        )
        if owner:
            from src.auth_helpers import owner_filter
            q = owner_filter(q, ModelEndpoint, owner)
        ep = q.first()
        if not ep:
            return None
        try:
            base, api_key = resolve_endpoint_runtime(ep, owner=owner)
        except Exception as e:
            logger.warning("Could not resolve endpoint runtime credentials: %s", e)
            return None
        chat_url = build_chat_url(base)
        headers = build_headers(api_key, base)
        m = (model or "").strip()
        # 丢弃用户在端点上禁用的模型，然后选择第一个
        # 启用的对话模型而非隐藏的模型。
        if m and m in _endpoint_hidden_models(ep):
            m = ""
        if not m:
            m = _first_chat_model(_endpoint_enabled_models(ep)) or ""
        if not m:
            return None
        return chat_url, m, headers
    except Exception as e:
        logger.debug(f"Could not resolve endpoint {ep_id}: {e}")
        return None
    finally:
        db.close()


def resolve_chat_fallback_candidates(owner: Optional[str] = None) -> list:
    """构建已配置的默认对话回退链，作为 (chat_url, model, headers) 元组列表，
    跳过所有无法解析的。

    主模型不包含在内 — 调用方在列表前面添加其会话的
    当前 (url, model, headers)，以便尊重每个会话的模型覆盖。
    """
    return _resolve_fallback_candidates("default_model_fallbacks", owner=owner)


def resolve_utility_fallback_candidates(owner: Optional[str] = None) -> list:
    """Utility 模型（`utility_model_fallbacks`）的已配置回退链。"""
    try:
        from src.settings import get_user_setting, load_settings
        settings = load_settings()
        utility_ep = (get_user_setting("utility_endpoint_id", owner or "", settings.get("utility_endpoint_id", "")) or "").strip()
        if not utility_ep:
            return _resolve_fallback_candidates("default_model_fallbacks", owner=owner)
    except Exception:
        pass
    return _resolve_fallback_candidates("utility_model_fallbacks", owner=owner)


def resolve_vision_fallback_candidates(owner: Optional[str] = None) -> list:
    """Vision 模型（`vision_model_fallbacks`）的已配置回退链。"""
    return _resolve_fallback_candidates("vision_model_fallbacks", owner=owner)


def _resolve_fallback_candidates(setting_key: str, owner: Optional[str] = None) -> list:
    out = []
    try:
        from src.settings import get_user_setting, load_settings
        settings = load_settings()
        chain = get_user_setting(setting_key, owner or "", settings.get(setting_key) or []) or []
    except Exception:
        return out
    for entry in chain:
        if not isinstance(entry, dict):
            continue
        resolved = resolve_endpoint_by_id(entry.get("endpoint_id", ""), entry.get("model", ""), owner=owner)
        if resolved:
            out.append(resolved)
    return out
