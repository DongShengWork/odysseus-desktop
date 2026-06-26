"""
model_context.py

从 OpenAI 兼容的 API 查询和缓存模型上下文窗口大小。
为上下文使用跟踪提供 token 估算。
"""

import ipaddress
import logging
import sys
from typing import Dict, List, Optional, Tuple

from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"}
_PRIVATE_NETWORKS = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
)

# Tailscale uses the CGNAT range 100.64.0.0/10, NOT all of 100.0.0.0/8.
# A bare "100." prefix would classify public addresses (e.g. AWS ranges
# under 100.x outside the CGNAT block) as local; routes/model_routes.py
# already narrows this the same way for endpoint classification.
_TAILSCALE_CGNAT = ipaddress.ip_network("100.64.0.0/10")


def _in_tailscale_range(host: str) -> bool:
    try:
        return ipaddress.ip_address(host) in _TAILSCALE_CGNAT
    except ValueError:
        return False


def _is_private_ip_literal(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(ip in network for network in _PRIVATE_NETWORKS)


def _normalize_base_for_compare(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    for suffix in ("/chat/completions", "/models", "/completions", "/v1/messages"):
        if url.endswith(suffix):
            url = url[: -len(suffix)].rstrip("/")
    return url


def _configured_endpoint_kind(url: str) -> Optional[str]:
    """返回可用时对话/base URL 的已配置端点类型。"""
    target = _normalize_base_for_compare(url)
    if not target:
        return None
    if "core.database" not in sys.modules:
        return None
    try:
        from core.database import SessionLocal, ModelEndpoint
        db = SessionLocal()
        try:
            rows = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True).all()
            for ep in rows:
                base = _normalize_base_for_compare(getattr(ep, "base_url", "") or "")
                if not base:
                    continue
                if target != base and not target.startswith(base + "/"):
                    continue
                kind = (getattr(ep, "endpoint_kind", None) or "auto").strip().lower()
                if kind in ("local", "api", "proxy"):
                    return kind
                if getattr(ep, "api_key", None):
                    parsed = urlparse(base)
                    host = (parsed.hostname or "").lower()
                    path = (parsed.path or "").rstrip("/")
                    if parsed.port != 11434 and "ollama" not in host and (path.endswith("/v1") or "/openai" in path):
                        return "proxy"
                return "auto"
        finally:
            db.close()
    except Exception:
        return None


def is_local_endpoint(url: str) -> bool:
    """检查 URL 是否指向本地/私有/tailscale 地址。"""
    kind = _configured_endpoint_kind(url)
    if kind in ("api", "proxy"):
        return False
    if kind == "local":
        return True
    try:
        host = urlparse(url).hostname or ""
        return host in _LOCAL_HOSTS or _is_private_ip_literal(host) or _in_tailscale_range(host)
    except Exception:
        return False

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
DEFAULT_CONTEXT = 128000
REQUEST_TIMEOUT = 5

# 主要 API 模型的已知上下文窗口（当 /models
# 端点不报告 context_length 时用作回退）。
# 子串匹配 — 使用最短的唯一前缀以捕获变体。
KNOWN_CONTEXT_WINDOWS = {
    # --- Anthropic ---
    'claude-sonnet-4-5': 200000,
    'claude-sonnet-4-6': 200000,
    'claude-sonnet-4': 200000,
    'claude-opus-4': 200000,
    'claude-haiku-4': 200000,
    'claude-haiku-3-5': 200000,
    'claude-3-5-sonnet': 200000,
    'claude-3-5-haiku': 200000,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,

    # --- OpenAI ---
    'gpt-5': 400000,
    'gpt-4.1': 1047576,
    'gpt-4.1-mini': 1047576,
    'gpt-4.1-nano': 1047576,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-4': 8192,
    'gpt-3.5-turbo': 16385,
    'o1': 200000,
    'o1-mini': 128000,
    'o1-pro': 200000,
    'o3': 200000,
    'o3-mini': 200000,
    'o4-mini': 200000,

    # --- DeepSeek ---
    'deepseek-chat': 64000,
    'deepseek-coder': 64000,
    'deepseek-reasoner': 64000,
    'deepseek-r1': 64000,
    'deepseek-v3': 64000,
    'deepseek-v2': 64000,

    # --- Google ---
    'gemini-2.5-pro': 1048576,
    'gemini-2.5-flash': 1048576,
    'gemini-2.0-flash': 1048576,
    'gemini-1.5-pro': 1048576,
    'gemini-1.5-flash': 1048576,
    'gemma-4': 262144,
    'gemma-3': 128000,
    'gemma-2': 8192,

    # --- Mistral ---
    'mistral-large': 128000,
    'mistral-medium': 32000,
    'mistral-small': 32000,
    'mistral-nemo': 128000,
    'mistral-7b': 32000,
    'mixtral': 32000,
    'codestral': 32000,
    'pixtral': 128000,

    # --- xAI ---
    'grok-4': 131072,
    'grok-3': 131072,
    'grok-2': 131072,

    # --- Meta / Llama ---
    'llama-4': 1048576,
    'llama-3.3': 131072,
    'llama-3.2': 131072,
    'llama-3.1': 131072,
    'llama-3': 131072,

    # --- Qwen ---
    'qwen3': 131072,
    'qwen2.5': 131072,
    'qwen2': 32768,
    'qwq': 32768,

    # --- Cohere ---
    'command-r-plus': 128000,
    'command-r': 128000,
    'command-a': 256000,

    # --- Perplexity ---
    'sonar-pro': 200000,
    'sonar': 128000,

    # --- MiniMax ---
    'minimax': 1000000,

    # --- Moonshot / Kimi ---
    'moonshot': 128000,
    'kimi': 128000,

    # --- Microsoft ---
    'phi-4': 16000,
    'phi-3': 128000,

    # --- Nvidia ---
    'nemotron': 131072,

    # --- Yi ---
    'yi-large': 32768,
    'yi-1.5': 16384,

    # --- 01.ai ---
    'yi-lightning': 16384,

    # --- Nous ---
    'hermes': 131072,
    'nous-hermes': 131072,

    # --- Open community ---
    'dolphin': 32768,
    'mythomax': 4096,
    'wizard': 32768,
    'openchat': 8192,
    'solar': 32768,
}

# ---------------------------------------------------------------------------
# 缓存
# ---------------------------------------------------------------------------
_context_cache: Dict[Tuple[str, str], Tuple[int, bool]] = {}


def _get_context_length_cached(endpoint_url: str, model: str) -> Tuple[int, bool]:
    """Return (context_length, known). ``known`` is False only when the value is a
    bare DEFAULT_CONTEXT fallback (no endpoint report and not in the known table)."""
    configured_kind = _configured_endpoint_kind(endpoint_url)
    is_local = is_local_endpoint(endpoint_url)
    # 键为 (endpoint_url, model)：同一个 model ID 可能由两个
    # 不同的远程端点提供服务，具有不同的实际上下文窗口（例如
    # 被限制的代理 vs 完整的提供商），因此仅按 model ID 缓存
    # 会导致一个端点的窗口值被用于另一个端点 (issue #2603)。
    cache_key = (endpoint_url, model)
    if not is_local and cache_key in _context_cache:
        return _context_cache[cache_key]

    ctx, known = _query_context_length(endpoint_url, model)
    # 仅缓存非默认值以允许下次请求重试。
    # 本地端点可以在保持相同 model ID 的情况下以不同的 --max-model-len 重启，
    # 因此始终重新查询而非提供过时缓存。
    if not is_local and (ctx != DEFAULT_CONTEXT or configured_kind in ("api", "proxy")):
        _context_cache[cache_key] = (ctx, known)
    logger.info(f"Context length for {model}: {ctx}")
    return ctx, known


def get_context_length(endpoint_url: str, model: str) -> int:
    """获取模型的上下文窗口大小。

    查询端点上的 /v1/models 并查找 context_length
    或 context_window 字段。按 (endpoint, model) 缓存结果。
    不可用时回退到 DEFAULT_CONTEXT。
    """
    return _get_context_length_cached(endpoint_url, model)[0]


def get_context_length_known(endpoint_url: str, model: str) -> Tuple[int, bool]:
    """Like ``get_context_length`` but also returns whether the window was actually
    discovered (endpoint-reported or in the known-models table) rather than the bare
    DEFAULT_CONTEXT fallback. Callers that *scale* a budget off the window must not
    trust an unknown value — a fallback 128K isn't proof the model holds 128K
    (review on #4122)."""
    return _get_context_length_cached(endpoint_url, model)


def budget_context_for_model(endpoint_url: str, model: str, *, fallback: int = 0) -> int:
    """Context window to scale the agent input budget against.

    Returns the *freshly discovered* window when it was actually proven
    (endpoint-reported / known table), else 0 so auto-scaling stays conservative.
    Crucially this binds the ``known`` flag to the value it proves — callers must
    not pair this flag with a context length from a *different* lookup (a stale
    local re-query, or a caller that didn't pass one), which would budget off an
    unproven number (review on #4122). On probe error, returns ``fallback`` (the
    caller's best-known value) to preserve prior behaviour."""
    try:
        ctx, known = get_context_length_known(endpoint_url, model)
        return ctx if known else 0
    except Exception:
        return fallback


def _lookup_known(model: str) -> Optional[int]:
    """通过子串匹配检查已知的上下文窗口。

    选择最长的匹配键，因此短键永远不会遮蔽更具体的键。
    如果不这样做，'o1' (200k) 会排在 'o1-mini' (128k) 之前，
    首次匹配返回会将 o1-mini 的窗口报告为 200k。
    """
    name = model.lower()
    basename = name.split("/")[-1] if "/" in name else name
    basename = basename.split(":")[0]  # 去除 :free, :extended 等
    best_key: Optional[str] = None
    best_ctx: Optional[int] = None
    for key, ctx in KNOWN_CONTEXT_WINDOWS.items():
        if key in basename or key in name:
            if best_key is None or len(key) > len(best_key):
                best_key, best_ctx = key, ctx
    return best_ctx


def _query_context_length(endpoint_url: str, model: str) -> Tuple[int, bool]:
    """Query the model API for context length. Returns (context_length, known) where
    ``known`` is False only for the bare DEFAULT_CONTEXT fallback."""
    known = _lookup_known(model)
    api_ctx = None
    configured_kind = _configured_endpoint_kind(endpoint_url)

    # 大型 OpenAI 兼容代理可能使 /models 变得昂贵。如果
    # 端点被明确配置为 API/proxy，优先使用已知上下文
    # 元数据（或默认值）而非下载完整目录。
    if configured_kind in ("api", "proxy"):
        if known:
            logger.info(f"Using known context window for {model}: {known}")
            return known, True
        return DEFAULT_CONTEXT, False

    # 先尝试 llama.cpp /slots 端点 — 报告实际服务的上下文
    if is_local_endpoint(endpoint_url):
        try:
            base = endpoint_url.split("/v1")[0] if "/v1" in endpoint_url else endpoint_url.rsplit("/", 1)[0]
            r = httpx.get(f"{base}/slots", timeout=REQUEST_TIMEOUT)
            if r.is_success:
                slots = r.json()
                if isinstance(slots, list) and slots:
                    n_ctx = slots[0].get("n_ctx")
                    if n_ctx and isinstance(n_ctx, int) and n_ctx > 0:
                        logger.info(f"llama.cpp /slots reports n_ctx={n_ctx} for {model}")
                        return n_ctx, True
        except Exception:
            pass

    # GitHub Copilot 的 /models 需要认证 + X-GitHub-Api-Version 头部，这些
    # 在这里不可用；未认证的探测只会 400。所有 Copilot
    # 选择器模型都是已知上下文表中涵盖的主流 API 模型，因此
    # 依赖它而非进行一次注定失败的网络调用。
    from src.copilot import is_copilot_base
    if is_copilot_base(endpoint_url):
        if known:
            logger.info(f"Using known context window for {model}: {known}")
            return known, True
        return DEFAULT_CONTEXT, False

    from src.endpoint_resolver import build_models_url

    models_url = build_models_url(endpoint_url)
    try:
        r = httpx.get(models_url, timeout=REQUEST_TIMEOUT)
        if r.is_success:
            data = r.json()
            models_list = data.get("data") or []

            for m in models_list:
                mid = m.get("id", "")
                if mid == model or mid.split("/")[-1] == model.split("/")[-1]:
                    for field in (
                        "context_length",
                        "context_window",
                        "max_model_len",
                        "max_context_length",
                        "max_seq_len",
                    ):
                        val = m.get(field)
                        if val and isinstance(val, (int, float)) and val > 0:
                            api_ctx = int(val)
                            break

                    if not api_ctx:
                        meta = m.get("meta") or m.get("model_extra") or {}
                        if isinstance(meta, dict):
                            # n_ctx 是实际服务的上下文（通过 llama.cpp 的 -c 标志设置）
                            for field in ("n_ctx", "context_length", "context_window", "max_model_len"):
                                val = meta.get(field)
                                if val and isinstance(val, (int, float)) and val > 0:
                                    api_ctx = int(val)
                                    break
                    break
    except Exception as e:
        logger.debug(f"Failed to query context length for {model}: {e}")

    # 对于本地/自托管端点，信任 API 返回值（用户设置了 --max-model-len）
    # 对于云 API，使用较大的值（API 可能报告较低的默认值）
    if api_ctx and known:
        _is_local = is_local_endpoint(endpoint_url)
        if _is_local and api_ctx < known:
            logger.info(f"Local endpoint reports {api_ctx} for {model} (known max: {known}) — using API value")
            return api_ctx, True
        result = max(api_ctx, known)
        if api_ctx < known:
            logger.info(f"API reported {api_ctx} for {model}, using known {known} instead")
        return result, True
    if api_ctx:
        return api_ctx, True
    if known:
        logger.info(f"Using known context window for {model}: {known}")
        return known, True

    return DEFAULT_CONTEXT, False


def estimate_tokens(messages: List[Dict]) -> int:
    """粗略估算消息列表的 token 数量。

    Uses chars * 0.3 which is closer to real BPE tokenizer output
    than the commonly-cited chars/4 (which underestimates by ~20-30%).
    Also adds ~4 tokens per message for role/formatting overhead, and counts
    并统计 assistant tool_calls（name + arguments）— 纯工具轮次存储时
    content=None with the real payload in tool_calls, so ignoring them made the
    estimate (and the compaction/trim gates that rely on it) blind to large
    tool arguments.
    """
    total = 0
    for msg in messages:
        total += 4  # 每条消息的开销（角色、分隔符）
        content = msg.get("content", "")
        if isinstance(content, str):
            total += int(len(content) * 0.3)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    total += int(len(item.get("text", "")) * 0.3)
        # 工具调用也有实际负载：纯工具 assistant 轮次存储时
        # content=None，实际参数（例如 create_document body）在
        # tool_calls[].function.arguments 中。忽略它们会使大型工具参数
        # 被读作约 0 token，导致压缩/裁剪门控漏掉真正的溢出。
        tool_calls = msg.get("tool_calls")
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function") if isinstance(tc.get("function"), dict) else tc
                name = fn.get("name", "") or ""
                args = fn.get("arguments", "") or ""
                if not isinstance(args, str):
                    args = str(args)  # 有些形式将 arguments 存储为 dict
                total += 4  # 每个工具调用的开销（id, type, wrapper）
                total += int((len(str(name)) + len(args)) * 0.3)
    return total
