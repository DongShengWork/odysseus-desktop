# src/llm_core.py
import httpx
import asyncio
import time
import json
import logging
import hashlib
import threading
import re
from fastapi import HTTPException
from typing import Optional, Dict, List, Tuple
from src.model_context import get_context_length, DEFAULT_CONTEXT
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

class LLMConfig:
    """LLM 操作的配置常量。"""
    DEFAULT_TIMEOUT = 30
    DEFAULT_TEMPERATURE = 1.0
    DEFAULT_MAX_TOKENS = 0
    MAX_RETRIES = 3
    RETRY_DELAY = 0.5
    STREAM_TIMEOUT = 300


# LLM 响应缓存
def _get_cache_key(url: str, model: str, messages: List[Dict], 
                   temperature: float, max_tokens: int) -> str:
    """生成 LLM 请求的缓存键。"""
    hashable_messages = []
    for msg in messages:
        sorted_items = tuple(sorted(msg.items()))
        hashable_messages.append(sorted_items)
    
    content = json.dumps({
        'url': url,
        'model': model, 
        'messages': hashable_messages,
        'temp': temperature,
        'max_tokens': max_tokens
    }, sort_keys=True)
    return hashlib.sha256(content.encode()).hexdigest()

_response_cache = {}

# 死主机冷却：映射主机（scheme://host:port）→ 冷却过期的 Unix 时间戳。
# 当连接到主机失败时，我们将其标记为死主机 DEAD_HOST_COOLDOWN 秒，使
# 后续调用立即失败，而不是等待连接超时。防止
# 一个不可达的上游阻塞整个应用其他部分的聊天。
#
# 但单个瞬时抖动（本地模型短暂繁忙，瞬间的
# Tailscale 中断）曾触发长达 60 秒的锁死 — 用户在 503 后以为
# 模型已死，而实际上它一秒后就恢复了。因此：
#   - 在冷却之前要求 FAIL_THRESHOLD 次连续失败
#   - 更短的冷却时间使恢复更快
#   - 任何成功立即重置失败计数器
DEAD_HOST_COOLDOWN = 20.0
_HOST_FAIL_THRESHOLD = 2
_dead_hosts: Dict[str, float] = {}
_host_fails: Dict[str, int] = {}
# 保护上面的两个映射。同步的 llm_call() 在 FastAPI 的
# 线程池中运行（同步路由如 /sessions/auto-sort），而 llm_call_async()
# 在事件循环中运行，因此这些映射从多个 OS 线程中被修改。
# 没有锁的情况下，_host_fails 的 get()+1+set 是一个读-修改-写操作，
# 会在并发连接错误下丢失失败计数（issue #659）。
_host_health_lock = threading.Lock()
_model_activity: Dict[str, float] = {}

_HARMONY_MARKER_RE = re.compile(
    r"<\|channel\|>(analysis|final)"
    r"|<\|start\|>(?:assistant|system|user|tool)?"
    r"|<\|message\|>"
    r"|<\|end\|>"
    r"|<\|return\|>"
    r"|<\|call\|>"
)
_HARMONY_MARKERS = (
    "<|channel|>analysis",
    "<|channel|>final",
    "<|start|>assistant",
    "<|start|>system",
    "<|start|>user",
    "<|start|>tool",
    "<|start|>",
    "<|message|>",
    "<|end|>",
    "<|return|>",
    "<|call|>",
)
_HARMONY_MAX_MARKER_LEN = max(len(marker) for marker in _HARMONY_MARKERS)


def _harmony_suffix_hold_len(text: str) -> int:
    """返回尾部有多少个字符可能是 harmony 标记的开头。"""
    limit = min(len(text), _HARMONY_MAX_MARKER_LEN - 1)
    for n in range(limit, 0, -1):
        suffix = text[-n:]
        if any(marker.startswith(suffix) for marker in _HARMONY_MARKERS):
            return n
    return 0


class _HarmonyStreamRouter:
    """路由 OpenAI harmony 分析/最终通道，不泄露标记。"""

    def __init__(self) -> None:
        self._buf = ""
        self._seen_harmony = False
        self._channel: Optional[str] = None
        self._in_message = False

    def feed(self, text: str) -> List[Tuple[str, bool]]:
        if not text:
            return []
        self._buf += text
        return self._drain(final=False)

    def flush(self) -> List[Tuple[str, bool]]:
        return self._drain(final=True)

    def _append_text(self, out: List[Tuple[str, bool]], text: str) -> None:
        if not text:
            return
        if not self._seen_harmony:
            out.append((text, False))
            return
        if self._in_message:
            out.append((text, self._channel == "analysis"))

    def _handle_marker(self, match: re.Match[str]) -> None:
        marker = match.group(0)
        self._seen_harmony = True
        if marker.startswith("<|channel|>"):
            self._channel = match.group(1)
            self._in_message = False
        elif marker == "<|message|>":
            self._in_message = True
        else:
            self._in_message = False
            if marker in {"<|end|>", "<|return|>", "<|call|>"}:
                self._channel = None

    def _drain(self, *, final: bool) -> List[Tuple[str, bool]]:
        out: List[Tuple[str, bool]] = []
        while True:
            match = _HARMONY_MARKER_RE.search(self._buf)
            if not match:
                break
            self._append_text(out, self._buf[:match.start()])
            self._handle_marker(match)
            self._buf = self._buf[match.end():]

        hold = 0 if final else _harmony_suffix_hold_len(self._buf)
        emit = self._buf if hold == 0 else self._buf[:-hold]
        self._buf = "" if hold == 0 else self._buf[-hold:]
        self._append_text(out, emit)
        return out


def _stream_delta_event(text: str, *, thinking: bool = False) -> str:
    payload = {"delta": text}
    if thinking:
        payload["thinking"] = True
    return f"data: {json.dumps(payload)}\n\n"

def _model_activity_key(url: str, model: str) -> str:
    return f"{(url or '').strip()}|{(model or '').strip()}"

def _same_model_identity(left: str, right: str) -> bool:
    return (left or "").strip().lower() == (right or "").strip().lower()

def note_model_activity(url: str, model: str):
    """记录一次真实的上游请求使用了此端点/模型。"""
    if not url or not model:
        return
    _model_activity[_model_activity_key(url, model)] = time.time()

def seconds_since_model_activity(url: str, model: str) -> Optional[float]:
    """自端点/模型上次在此进程中使用以来的秒数。"""
    ts = _model_activity.get(_model_activity_key(url, model))
    if not ts:
        return None
    return max(0.0, time.time() - ts)

def _host_key(url: str) -> str:
    from urllib.parse import urlsplit
    s = urlsplit(url)
    return f"{s.scheme}://{s.netloc}" if s.scheme and s.netloc else url

def _is_host_dead(url: str) -> bool:
    key = _host_key(url)
    with _host_health_lock:
        exp = _dead_hosts.get(key)
        if exp is None:
            return False
        if time.time() >= exp:
            _dead_hosts.pop(key, None)
            return False
        return True

def _mark_host_dead(url: str) -> bool:
    """记录连接失败。仅在 _HOST_FAIL_THRESHOLD 次连续失败后
    实际冷却主机。返回 True 表示主机现已冷却（调用方可据此准确记录），
    False 表示仍在允许的失败容忍期内。"""
    key = _host_key(url)
    with _host_health_lock:
        n = _host_fails.get(key, 0) + 1
        _host_fails[key] = n
        if n >= _HOST_FAIL_THRESHOLD:
            _dead_hosts[key] = time.time() + DEAD_HOST_COOLDOWN
            return True
        return False

def _clear_host_dead(url: str) -> None:
    key = _host_key(url)
    with _host_health_lock:
        _dead_hosts.pop(key, None)
        _host_fails.pop(key, None)


# 共享的异步 HTTP 客户端。复用同一客户端保持连接预热：
# 对 api.anthropic.com / api.openai.com / openrouter 的重复调用跳过
# 100-500ms 的 TCP+TLS 握手。延迟初始化以便绑定到运行中的事件循环。
_http_client: Optional[httpx.AsyncClient] = None
_http_limits = httpx.Limits(max_connections=100, max_keepalive_connections=30, keepalive_expiry=30.0)

def _get_http_client() -> httpx.AsyncClient:
    """返回进程全局的 AsyncClient。每次请求的超时在调用时传入。"""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        from src.tls_overrides import llm_verify
        _http_client = httpx.AsyncClient(
            limits=_http_limits, http2=False, verify=llm_verify(),
        )
    return _http_client

def _get_cached_response(cache_key: str) -> Optional[str]:
    """获取缓存响应（如果存在）。"""
    return _response_cache.get(cache_key)

def _set_cached_response(cache_key: str, response: str) -> None:
    """将响应存入缓存。"""
    if len(_response_cache) > 128:
        keys_to_remove = list(_response_cache.keys())[:64]
        for key in keys_to_remove:
            # pop(), not del: another thread (sync llm_call runs in FastAPI's
            # threadpool) may have already evicted the same snapshotted key,
            # and del would raise KeyError mid-eviction (issue #659).
            _response_cache.pop(key, None)
    _response_cache[cache_key] = response

# ── Anthropic 原生 API 适配器 ──

ANTHROPIC_MODELS = [
    "claude-opus-4-20250514", "claude-opus-4",
    "claude-sonnet-4-20250514", "claude-sonnet-4", "claude-sonnet-4-5-20250929", "claude-sonnet-4-5",
    "claude-haiku-4-20250514", "claude-haiku-4", "claude-haiku-3-5-20241022", "claude-haiku-3-5",
]


def _is_ollama_native_url(url: str) -> bool:
    """对原生 Ollama API URL（包括 Ollama Cloud）返回 True。"""
    try:
        parsed = urlparse(url or "")
    except Exception:
        return False
    host = parsed.hostname or ""
    path = (parsed.path or "").rstrip("/")
    if _host_match(url, "ollama.com"):
        return True
    if path.startswith("/v1"):
        return False
    local_ollama_host = host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"} or parsed.port == 11434
    return local_ollama_host and (path == "" or path == "/api" or path.startswith("/api/"))


def _ollama_api_root(url: str) -> str:
    """返回原生 Ollama API 根路径，如 https://ollama.com/api。"""
    url = (url or "").strip().rstrip("/")
    parsed = urlparse(url)
    path = (parsed.path or "").rstrip("/")
    if path.endswith("/api/chat"):
        return url[: -len("/chat")]
    if path.endswith("/api/tags"):
        return url[: -len("/tags")]
    if path.endswith("/api/generate"):
        return url[: -len("/generate")]
    if path.endswith("/api"):
        return url
    if path == "":
        return url + "/api"
    if _host_match(url, "ollama.com"):
        root = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else "https://ollama.com"
        return root.rstrip("/") + "/api"
    return url


def _normalize_ollama_url(url: str) -> str:
    """确保原生 Ollama URL 指向 /api/chat。"""
    base = _ollama_api_root(url)
    return base.rstrip("/") + "/chat"


def _ollama_normalize_tool_messages(messages: List[Dict]) -> List[Dict]:
    """将 Odysseus 标准的 OpenAI 风格消息适配到原生 Ollama /api/chat。

    Odysseus 以 OpenAI 形状携带 assistant 工具调用，其中
    ``function.arguments`` 是一个 JSON *字符串*。原生 Ollama 期望它是一个
    JSON *对象*；给定字符串会导致整个请求以 HTTP 400
    "Value looks like object, but can't find closing '}' symbol" 失败，这会中断
    每个后续（工具结果）轮次。在这里将 arguments 解析回对象，
    在浅拷贝上进行，保持非工具消息不变。不透明的
    Gemini ``extra_content``（thought_signature）被丢弃 — 它对
    Ollama 无意义，仅在对话被重放到 Gemini 时相关。
    """
    out: List[Dict] = []
    for m in messages or []:
        tcs = m.get("tool_calls") if isinstance(m, dict) else None
        if not tcs:
            out.append(m)
            continue
        new_calls = []
        for tc in tcs:
            fn = tc.get("function") or {}
            args = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args) if args.strip() else {}
                except (json.JSONDecodeError, TypeError):
                    args = {}
            call: Dict = {"function": {"name": fn.get("name", ""), "arguments": args or {}}}
            if tc.get("id"):
                call["id"] = tc["id"]
            new_calls.append(call)
        nm = dict(m)
        nm["tool_calls"] = new_calls
        out.append(nm)
    return out


def _build_ollama_payload(
    model: str,
    messages: List[Dict],
    temperature: float,
    max_tokens: int,
    stream: bool = False,
    tools: Optional[List[Dict]] = None,
    num_ctx: Optional[int] = None,
) -> Dict:
    """构建 Ollama /api/chat 端点的 JSON 负载。

    ``num_ctx`` 设置输入上下文窗口。当选项被省略时 Ollama 默认为 2048，
    因此广告窗口更大的模型会在此被静默截断，而窗口更小的模型
    会得到一个超出其服务能力的超尺寸窗口。通过 ``num_ctx`` 传递发现的
    上下文长度；此构建器仅在值可信时（非 ``DEFAULT_CONTEXT`` 回退）
    发出它，因此我们不会为未知模型猜测，但在知道真实窗口时通知
    Ollama — 即使它小于 2048。
    """
    payload: Dict = {
        "model": model,
        "messages": _ollama_normalize_tool_messages(messages),
        "stream": stream,
    }
    options: Dict = {}
    if temperature is not None:
        options["temperature"] = temperature
    if max_tokens and max_tokens > 0:
        options["num_predict"] = max_tokens
    if num_ctx is not None and num_ctx > 0 and num_ctx != DEFAULT_CONTEXT:
        options["num_ctx"] = num_ctx
    if options:
        payload["options"] = options
    if tools:
        payload["tools"] = tools
    return payload


def _parse_ollama_response(data: dict) -> str:
    message = data.get("message") or {}
    return message.get("content") or data.get("response") or ""


def _host_match(url: str, *domains: str) -> bool:
    """如果 URL 的主机名等于任何 ``domains`` 或其子域名，返回 True。

    用于像 "is this Anthropic?" / "is this OpenRouter?" 这样的检查。
    优先使用此方法而非 URL 子串匹配：子串形式对恰好
    包含域文本的不相关路径或查询字符串给出错误答案。
    """
    if not url:
        return False
    try:
        # rstrip(".") so a fully-qualified host with a trailing dot
        # ("api.anthropic.com.") still matches "anthropic.com".
        host = (urlparse(url).hostname or "").lower().rstrip(".")
    except Exception:
        return False
    if not host:
        return False
    return any(host == d or host.endswith("." + d) for d in domains)


def _detect_provider(url: str) -> str:
    """从配置的端点 URL 检测 API 提供商。

    基于主机名（精确或子域名）匹配而非子串，因此仅在其路径或
    查询中包含提供商域名的 URL — 或像 ``anthropic.com.example`` 这样
    外观相似的主机 — 不会被错误分类。
    未知主机回退到 OpenAI 兼容默认值，这也是大多数
    提供商所实现的。
    """
    if _is_ollama_native_url(url):
        return "ollama"
    if _host_match(url, "anthropic.com"):
        return "anthropic"
    if _host_match(url, "opencode.ai/zen/go"):
        return "opencode-go"
    if _host_match(url, "opencode.ai/zen"):
        return "opencode-zen"
    if _host_match(url, "openrouter.ai"):
        return "openrouter"
    if _host_match(url, "groq.com"):
        return "groq"
    from src.chatgpt_subscription import is_chatgpt_subscription_base
    if is_chatgpt_subscription_base(url):
        return "chatgpt-subscription"
    from src.copilot import is_copilot_base
    if is_copilot_base(url):
        return "copilot"
    return "openai"


def _provider_headers(provider: str, headers: Optional[Dict] = None) -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    if isinstance(headers, dict):
        h.update(headers)
    if provider == "openrouter":
        h.setdefault("HTTP-Referer", "https://github.com/pewdiepie-archdaemon/odysseus")
        h.setdefault("X-OpenRouter-Title", "Odysseus")
    if provider == "copilot":
        # Ensure the Copilot-required headers are present even when the caller
        # didn't pass pre-built headers (e.g. model listing). build_headers()
        # already injects these for the live chat path; setdefault keeps any
        # request-specific values (x-initiator/vision) the caller set.
        from src.copilot import copilot_headers
        for k, v in copilot_headers(None).items():
            h.setdefault(k, v)
    return h


def _provider_label(url: str) -> str:
    """对错误消息返回人性化的提供商名称。"""
    if not url:
        return "provider"
    if _host_match(url, "anthropic.com"): return "Anthropic"
    if _host_match(url, "ollama.com"): return "Ollama Cloud"
    if _host_match(url, "x.ai"): return "xAI"
    if _host_match(url, "openai.com"): return "OpenAI"
    if _host_match(url, "openrouter.ai"): return "OpenRouter"
    if _host_match(url, "opencode.ai/zen/go"): return "OpenCode Go"
    if _host_match(url, "opencode.ai/zen"): return "OpenCode Zen"
    if _host_match(url, "groq.com"): return "Groq"
    from src.chatgpt_subscription import is_chatgpt_subscription_base
    if is_chatgpt_subscription_base(url): return "ChatGPT Subscription"
    from src.copilot import is_copilot_base
    if is_copilot_base(url): return "GitHub Copilot"
    if _host_match(url, "mistral.ai"): return "Mistral"
    if _host_match(url, "deepseek.com"): return "DeepSeek"
    if _host_match(url, "googleapis.com"): return "Google"
    if _host_match(url, "together.xyz", "together.ai"): return "Together"
    if _host_match(url, "fireworks.ai"): return "Fireworks"
    if _is_ollama_native_url(url): return "Ollama"
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return "provider"
    if host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}:
        return "local endpoint"
    return host or "provider"


def _normalize_chatgpt_subscription_url(url: str) -> str:
    base = (url or "").strip().rstrip("/")
    if base.endswith("/responses"):
        return base
    return base + "/responses"


def _message_content_as_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                if part:
                    parts.append(str(part))
                continue
            if isinstance(part.get("text"), str):
                parts.append(part["text"])
                continue
            if isinstance(part.get("content"), str):
                parts.append(part["content"])
        return "\n".join(parts)
    return "" if content is None else str(content)


def _chatgpt_subscription_instructions(messages: List[Dict]) -> str:
    instructions = [
        _message_content_as_text(msg.get("content")).strip()
        for msg in messages or []
        if (msg.get("role") or "") == "system"
    ]
    instructions = [part for part in instructions if part]
    if instructions:
        return "\n\n".join(instructions)
    return "You are a helpful AI assistant."


def _build_chatgpt_responses_payload(
    model: str,
    messages: List[Dict],
    temperature: float,
    max_tokens: int,
    *,
    stream: bool = False,
) -> Dict:
    from src.chatgpt_subscription import build_responses_input

    conversation = [msg for msg in (messages or []) if (msg.get("role") or "") != "system"]
    payload: Dict = {
        "model": model,
        "instructions": _chatgpt_subscription_instructions(messages),
        "input": build_responses_input(conversation),
        "stream": stream,
        "store": False,
    }
    if not _restricts_temperature(model):
        payload["temperature"] = temperature
    if max_tokens and max_tokens > 0:
        payload["max_output_tokens"] = max_tokens
    return payload


def _format_chatgpt_subscription_error(status_code: int, text: str) -> str:
    if status_code in (401, 403):
        return "ChatGPT Subscription credentials expired or were rejected. Reconnect the provider."
    if status_code == 429:
        return "ChatGPT Subscription quota or rate limit was reached. Retry after the upstream limit resets."
    return _format_upstream_error(status_code, text, "https://chatgpt.com/backend-api/codex")


def _format_upstream_error(status: int, body: bytes | str, url: str) -> str:
    """将上游 HTTP 错误转换为用户可读的句子。

    认证失败（401/403）变为 'xAI 拒绝了这个 API key' 等，因此 UI
    不再显示原始 JSON 如 ``{"error":{"message":"User not found."}}``。"""
    if isinstance(body, bytes):
        try:
            body = body.decode("utf-8", errors="replace")
        except Exception:
            body = str(body)
    provider = _provider_label(url)
    # Try to pull a message out of the body
    detail = ""
    try:
        j = json.loads(body) if body else {}
        if isinstance(j, dict):
            err = j.get("error") or j
            if isinstance(err, dict):
                detail = (err.get("message") or err.get("detail") or "").strip()
            elif isinstance(err, str):
                detail = err.strip()
    except Exception:
        detail = (body or "").strip()[:240]

    if status in (401, 403):
        msg = f"{provider} rejected the API key"
        if status == 403:
            msg = f"{provider} denied access (403)"
        if detail:
            msg += f" — {detail}"
        msg += ". Check Model Endpoints → {} and re-paste the key.".format(provider)
        return msg
    if status == 404:
        return f"{provider} returned 404 — check the base URL and model name." + (f" ({detail})" if detail else "")
    if status == 429:
        return f"{provider} rate-limited the request (429)." + (f" {detail}" if detail else "")
    if status >= 500:
        return f"{provider} is having an outage (HTTP {status})." + (f" {detail}" if detail else "")
    return f"{provider} returned HTTP {status}" + (f": {detail}" if detail else "")

# Models that require max_completion_tokens instead of max_tokens
_MAX_COMPLETION_TOKENS_MODELS = {"o1", "o3", "o4", "gpt-4.5", "gpt-5"}

def _uses_max_completion_tokens(model: str) -> bool:
    """检查模型是否需要 max_completion_tokens 而非 max_tokens。"""
    if not model:
        return False
    m = model.lower()
    return any(m.startswith(p) or f"/{p}" in m for p in _MAX_COMPLETION_TOKENS_MODELS)

# OpenAI 推理模型（o1、o3、o4、gpt-5 系列）只接受默认的
# temperature。发送任何显式值 — 即使是 0.0 — 都会返回 HTTP 400
# （"Only the default (1) value is supported"）。否则会破坏聊天，当
# 预设设置了非默认温度时，并使端点探测将
# 完全正常的模型报告为失败。对于这些模型我们省略该字段，让
# API 使用其必需的默认值。（gpt-4.5 被有意识地排除 — 它不是
# 推理模型，正常接受 temperature。）
_FIXED_TEMPERATURE_MODELS = ("o1", "o3", "o4", "gpt-5")

def _restricts_temperature(model: str) -> bool:
    """检查模型是否拒绝任何非默认的 temperature。"""
    if not model:
        return False
    m = model.lower()
    return any(m.startswith(p) or f"/{p}" in m for p in _FIXED_TEMPERATURE_MODELS)

# 支持结构化思考的模型 — 可能输出 </think> 而没有开标签
_THINKING_MODEL_PATTERNS = ("qwen3", "qwq", "deepseek-r1", "deepseek-reasoner", "minimax", "m2-reap", "gemma")

def _supports_thinking(model: str) -> bool:
    """检查模型是否支持结构化思考输出。"""
    if not model:
        return False
    m = model.lower()
    return any(p in m for p in _THINKING_MODEL_PATTERNS)

def _convert_openai_content_to_anthropic(content):
    """Convert OpenAI multimodal content blocks to Anthropic format.

    Converts image_url blocks (data URI) → Anthropic image blocks.
    Passes text blocks through unchanged.
    """
    if not isinstance(content, list):
        return content
    converted = []
    for block in content:
        if not isinstance(block, dict):
            converted.append(block)
            continue
        if block.get("type") == "image_url":
            url = (block.get("image_url") or {}).get("url", "")
            # Parse data URI: data:image/<fmt>;base64,<data>
            if url.startswith("data:"):
                try:
                    header, b64_data = url.split(",", 1)
                    media_type = header.split(";")[0].replace("data:", "")
                except (ValueError, IndexError):
                    continue
                converted.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": b64_data,
                    },
                })
            else:
                # External URL — use Anthropic's URL source
                converted.append({
                    "type": "image",
                    "source": {"type": "url", "url": url},
                })
        elif block.get("type") == "text":
            converted.append(block)
        else:
            converted.append(block)
    return converted


def _build_anthropic_payload(model, messages, temperature, max_tokens, stream=False, tools=None):
    """将 OpenAI 风格的消息转换为 Anthropic 格式。"""
    system_parts = []
    chat_messages = []
    for m in messages:
        if m.get("role") == "system":
            system_parts.append(m.get("content") or "")
        elif m.get("role") == "tool":
            # Convert OpenAI tool result to Anthropic format
            chat_messages.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id", ""),
                    "content": m.get("content", ""),
                }],
            })
        elif m.get("role") == "assistant" and isinstance(m.get("tool_calls"), list):
            # Convert OpenAI assistant tool_calls to Anthropic format
            content = []
            if m.get("content"):
                content.append({"type": "text", "text": m["content"]})
            for tc in m["tool_calls"]:
                fn = tc.get("function") or {}
                args_str = fn.get("arguments") or "{}"
                try:
                    args = json.loads(args_str) if isinstance(args_str, str) else args_str
                except (json.JSONDecodeError, TypeError):
                    args = {}
                content.append({
                    "type": "tool_use",
                    "id": tc.get("id", ""),
                    "name": fn.get("name", ""),
                    "input": args,
                })
            chat_messages.append({"role": "assistant", "content": content})
        else:
            # Convert multimodal content (image_url → image) for Anthropic
            content = _convert_openai_content_to_anthropic(m["content"])
            chat_messages.append({"role": m["role"], "content": content})
    # Anthropic only accepts temperature in [0.0, 1.0] and 400s on anything above
    # 1.0. Clamp here (in the Anthropic builder only) so presets/sliders that use
    # the wider OpenAI 0.0-2.0 range — e.g. the shipped "Nietzsche" preset at 1.2
    # — don't hard-break every Claude request. OpenAI's own path is left untouched.
    if temperature is not None:
        temperature = max(0.0, min(temperature, 1.0))
    payload = {
        "model": model,
        "messages": chat_messages,
        "max_tokens": max_tokens if max_tokens and max_tokens > 0 else 4096,
        "temperature": temperature,
    }
    if system_parts:
        system_text = "\n\n".join(system_parts)
        # Send `system` as a structured text block so we can attach a prompt-cache
        # breakpoint. The agent loop re-sends this same large prefix every round;
        # caching it makes Anthropic re-read it from cache (~90% cheaper, lower TTFB)
        # instead of re-billing it. Skip caching tiny one-off prompts, where the
        # cache-WRITE premium wouldn't pay back (no reuse). Presence of `tools`
        # means an agentic/multi-round call, where the prefix is always reused.
        system_block = {"type": "text", "text": system_text}
        if tools or len(system_text) > 4000:
            system_block["cache_control"] = {"type": "ephemeral"}
        payload["system"] = [system_block]
    if stream:
        payload["stream"] = True
    # Convert OpenAI-format tools to Anthropic format
    if tools:
        anthropic_tools = []
        for t in tools:
            if t.get("type") == "function":
                fn = t["function"]
                anthropic_tools.append({
                    "name": fn["name"],
                    "description": fn.get("description", ""),
                    "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
                })
        if anthropic_tools:
            # Cache the tool schemas too — they're stable for the whole agent run.
            # The breakpoint caches all tool defs preceding it in the request.
            anthropic_tools[-1]["cache_control"] = {"type": "ephemeral"}
            payload["tools"] = anthropic_tools
    return payload

def _build_anthropic_headers(headers):
    """将 Bearer 认证转换为 Anthropic 的 x-api-key。"""
    h = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
    if headers:
        for k, v in headers.items():
            if k.lower() == "authorization" and isinstance(v, str) and v.startswith("Bearer "):
                h["x-api-key"] = v[7:]
            else:
                h[k] = v
    return h

def _parse_anthropic_response(data: dict) -> str:
    """Extract text from an Anthropic response.

    The Messages API `content` is an array that can hold more than one text
    block (e.g. text split around a tool_use block, or citation-segmented
    text). Concatenate them all instead of returning only the first, which
    silently dropped the rest of the reply.
    """
    return "".join(
        block.get("text", "")
        for block in data.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    )


def _as_content_blocks(content) -> List[Dict]:
    """Coerce a message `content` into a list of content blocks.

    A list (multimodal: text + image parts) passes through; a non-empty string
    becomes a single text block; None/empty yields no blocks. Used when merging
    consecutive user messages so multimodal content isn't str()-ed away.
    """
    if isinstance(content, list):
        return content
    if content:
        return [{"type": "text", "text": str(content)}]
    return []


def _sanitize_llm_messages(messages: List[Dict]) -> List[Dict]:
    """Strip Odysseus-only metadata before sending messages to providers.

    Per the OpenAI chat format: user/system messages must have content; a tool
    message needs content + tool_call_id; an assistant message may carry content,
    tool_calls, or both. The old guard required content on every message, which
    dropped a valid assistant message that has only tool_calls — e.g. the
    follow-up message _append_tool_results builds for a no-prose native tool call
    (content=None, since Gemini/Ollama reject tool_calls alongside ""). Dropping
    it leaves the tool result dangling and breaks the next round.
    """
    allowed = {"role", "content", "name", "tool_call_id", "tool_calls", "function_call"}
    cleaned = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        item = {k: v for k, v in msg.items() if k in allowed and v is not None}
        role = item.get("role")
        if not role:
            continue
        if role == "assistant":
            # Re-add an explicit content=None when the message is tool-calls-only
            # (the None was stripped above) so the provider gets the spec-correct
            # `content: null`, not an omitted key.
            if "content" not in item and item.get("tool_calls"):
                item["content"] = None
            if "content" in item or item.get("tool_calls"):
                cleaned.append(item)
        elif role == "tool":
            if "content" in item and "tool_call_id" in item:
                cleaned.append(item)
        elif "content" in item:
            cleaned.append(item)

    # 在发送给任何 OpenAI 兼容的提供商之前修复 tool-call 邻接关系。
    # 裁剪/压缩/重试可能导致 ``role:"tool"`` 消息
    # 没有紧邻其前的 assistant ``tool_calls`` 父消息，这会被
    # DeepSeek 拒绝并报错：
    # "Messages with role 'tool' must be a response to a preceding message with
    # 'tool_calls'"。同时去除未收到回答的 assistant tool_calls；一些提供商
    # 将其拒绝为不完整的对话。
    repaired: List[Dict] = []
    i = 0
    while i < len(cleaned):
        msg = cleaned[i]
        role = msg.get("role")

        if role == "tool":
            # 孤立工具结果。紧邻此前没有有效的 assistant tool_calls 父消息，
            # 因此不能发送。
            logger.debug("Dropping orphan tool message before provider request")
            i += 1
            continue

        tool_calls = msg.get("tool_calls") if role == "assistant" else None
        if not tool_calls:
            repaired.append(msg)
            i += 1
            continue

        call_ids = [
            str(tc.get("id"))
            for tc in tool_calls
            if isinstance(tc, dict) and tc.get("id")
        ]
        expected = set(call_ids)
        answered_ids = []
        tool_batch = []
        j = i + 1
        while j < len(cleaned) and cleaned[j].get("role") == "tool":
            tid = str(cleaned[j].get("tool_call_id") or "")
            if tid in expected and tid not in answered_ids:
                answered_ids.append(tid)
                tool_batch.append(cleaned[j])
            else:
                logger.debug("Dropping unmatched/duplicate tool message before provider request")
            j += 1

        if not tool_batch:
            plain = {k: v for k, v in msg.items() if k != "tool_calls"}
            if (plain.get("content") or "").strip():
                repaired.append(plain)
            else:
                logger.debug("Dropping unanswered assistant tool_calls before provider request")
            i = j
            continue

        answered = set(answered_ids)
        pruned_calls = [
            tc for tc in tool_calls
            if isinstance(tc, dict) and str(tc.get("id")) in answered
        ]
        fixed = dict(msg)
        fixed["tool_calls"] = pruned_calls
        if "content" not in fixed:
            fixed["content"] = None
        repaired.append(fixed)
        repaired.extend(tool_batch)
        if len(pruned_calls) != len(tool_calls):
            logger.debug("Pruned unanswered assistant tool_calls before provider request")
        i = j

    # Merge consecutive user messages to satisfy strict role alternation
    # requirements after invalid tool-call fragments have been removed.
    merged: List[Dict] = []
    for item in repaired:
        if not merged:
            merged.append(item)
            continue

        last = merged[-1]
        if last.get("role") == "user" and item.get("role") == "user":
            last_copy = dict(last)
            lc = last_copy.get("content")
            ic = item.get("content")
            if isinstance(lc, list) or isinstance(ic, list):
                # Preserve multimodal content blocks (e.g. an image part) by
                # concatenating the block lists. str()-ing a list turned an
                # image message into its Python repr and dropped the image.
                merged_blocks = _as_content_blocks(lc) + _as_content_blocks(ic)
                if merged_blocks:
                    last_copy["content"] = merged_blocks
                else:
                    last_copy.pop("content", None)
            else:
                last_str = str(lc) if lc is not None else ""
                item_str = str(ic) if ic is not None else ""
                new_content = "\n\n".join(part for part in (last_str, item_str) if part)
                if new_content:
                    last_copy["content"] = new_content
                else:
                    last_copy.pop("content", None)
            merged[-1] = last_copy
        else:
            merged.append(item)

    return merged

def _normalize_anthropic_url(url: str) -> str:
    """确保 Anthropic URL 指向 /v1/messages。"""
    url = url.rstrip("/")
    if url.endswith("/v1/messages"):
        return url
    if url.endswith("/v1"):
        return url + "/messages"
    return url + "/v1/messages"


def _model_list_base(url: str) -> str:
    """将模型/聊天 URL 规范化为已配置的端点 base。"""
    base = (url or "").strip().rstrip("/")
    for suffix in ("/models", "/chat/completions", "/completions", "/v1/messages", "/responses"):
        if base.endswith(suffix):
            base = base[: -len(suffix)].rstrip("/")
    for suffix in ("/chat", "/tags", "/generate"):
        if base.endswith("/api" + suffix):
            base = base[: -len(suffix)].rstrip("/")
    return base


def _parse_model_cache(raw) -> List[str]:
    if not raw:
        return []
    try:
        models = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return []
    if not isinstance(models, list):
        return []
    out = []
    seen = set()
    for item in models:
        mid = str(item or "").strip()
        if not mid or mid in seen:
            continue
        out.append(mid)
        seen.add(mid)
    return out


def _configured_cached_model_ids(
    endpoint_url: str,
    *,
    owner: Optional[str] = None,
    endpoint_id: Optional[str] = None,
) -> List[str]:
    """返回匹配 endpoint_url 的已配置端点的缓存模型。"""
    target = _model_list_base(endpoint_url)
    if not target:
        return []
    try:
        from src.database import SessionLocal, ModelEndpoint
    except Exception:
        return []
    db = SessionLocal()
    try:
        q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)
        if endpoint_id:
            q = q.filter(ModelEndpoint.id == endpoint_id)
        if owner:
            from src.auth_helpers import owner_filter
            q = owner_filter(q, ModelEndpoint, owner)
        rows = q.all()
        for ep in rows:
            if _model_list_base(getattr(ep, "base_url", "")) != target:
                continue
            models = _parse_model_cache(getattr(ep, "cached_models", None) or getattr(ep, "models", None))
            if not models:
                continue
            hidden = set(_parse_model_cache(getattr(ep, "hidden_models", None)))
            return [m for m in models if m not in hidden]
    except Exception:
        return []
    finally:
        try:
            db.close()
        except Exception:
            pass
    return []


def list_model_ids(
    base_chat_url: str,
    timeout: int = LLMConfig.DEFAULT_TIMEOUT,
    headers: Optional[Dict] = None,
    *,
    owner: Optional[str] = None,
    endpoint_id: Optional[str] = None,
) -> List[str]:
    """列出来自端点的可用模型 ID。"""
    cached = _configured_cached_model_ids(base_chat_url, owner=owner, endpoint_id=endpoint_id)
    if cached:
        return cached
    provider = _detect_provider(base_chat_url)
    if provider == "anthropic":
        return list(ANTHROPIC_MODELS)
    try:
        h = {}
        if headers:
            h.update(headers)
        if provider == "ollama":
            models_url = _ollama_api_root(base_chat_url) + "/tags"
        else:
            from src.endpoint_resolver import build_models_url

            models_url = build_models_url(base_chat_url)
        r = httpx.get(models_url, headers=h, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        model_ids = [m.get("id") for m in (data.get("data") or []) if m.get("id")]
        if not model_ids:
            model_ids = [
                m.get("name") or m.get("model")
                for m in (data.get("models") or [])
                if m.get("name") or m.get("model")
            ]
        return model_ids
    except Exception:
        try:
            if ":11434" in base_chat_url or "ollama" in base_chat_url.lower():
                root = base_chat_url.replace("/v1/chat/completions", "").replace("/chat/completions", "").rstrip("/")
                r = httpx.get(root + "/api/tags", timeout=timeout)
                r.raise_for_status()
                return [m.get("name") or m.get("model") for m in (r.json().get("models") or []) if m.get("name") or m.get("model")]
        except Exception:
            pass
        return []

def normalize_model_id(
    endpoint_url: str,
    requested: str,
    timeout: int = LLMConfig.DEFAULT_TIMEOUT,
    *,
    owner: Optional[str] = None,
    endpoint_id: Optional[str] = None,
) -> Optional[str]:
    """将模型 ID 规范化为与可用模型匹配。"""
    avail = list_model_ids(endpoint_url, timeout, owner=owner, endpoint_id=endpoint_id)
    if not avail:
        return None
    if requested in avail:
        return requested
    import os as _os
    req_base = _os.path.basename(requested.rstrip("/"))
    for a in avail:
        if _os.path.basename(a.rstrip("/")) == req_base:
            return a
    return None

def llm_call(url: str, model: str, messages: List[Dict], temperature: float = LLMConfig.DEFAULT_TEMPERATURE,
             max_tokens: int = LLMConfig.DEFAULT_MAX_TOKENS, headers: Optional[Dict] = None, 
             timeout: int = LLMConfig.DEFAULT_TIMEOUT, prompt_type: Optional[str] = None) -> str:
    """同步 LLM 调用，支持可选的提示类型增强。"""
    h = _provider_headers(_detect_provider(url))
    # Tolerate headers that arrive as a JSON string (some sessions stored them
    # double-encoded) — otherwise h.update() throws "dictionary update sequence
    # element #0 has length 1; 2 is required".
    if isinstance(headers, str):
        try:
            headers = json.loads(headers)
        except Exception:
            headers = None
    if isinstance(headers, dict):
        h.update(headers)

    messages_copy = _sanitize_llm_messages(messages)

    # Consolidate multiple system messages into one at the start.
    sys_parts = []
    non_sys = []
    for m in messages_copy:
        if m.get("role") == "system":
            sys_parts.append(m.get('content') or '')
        else:
            non_sys.append(m)
    if sys_parts:
        messages_copy = [{"role": "system", "content": "\n\n".join(sys_parts)}] + non_sys
    else:
        messages_copy = non_sys

    provider = _detect_provider(url)
    cache_key = _get_cache_key(url, model, messages_copy, temperature, max_tokens)
    cached_response = _get_cached_response(cache_key)
    if cached_response:
        logger.debug(f"Returning cached response for key: {cache_key}")
        return cached_response

    if provider == "anthropic":
        target_url = _normalize_anthropic_url(url)
        h = _build_anthropic_headers(headers)
        payload = _build_anthropic_payload(model, messages_copy, temperature, max_tokens)
    elif provider == "ollama":
        target_url = _normalize_ollama_url(url)
        payload = _build_ollama_payload(
            model, messages_copy, temperature, max_tokens,
            stream=False, num_ctx=get_context_length(url, model),
        )
    else:
        target_url = url
        if provider == "copilot":
            from src.copilot import apply_request_headers
            apply_request_headers(h, messages_copy)
        payload = {
            "model": model,
            "messages": messages_copy,
            "temperature": temperature,
        }
        if _restricts_temperature(model):
            payload.pop("temperature", None)
        if max_tokens and max_tokens > 0:
            tok_key = "max_completion_tokens" if _uses_max_completion_tokens(model) else "max_tokens"
            payload[tok_key] = max_tokens
    try:
        note_model_activity(target_url, model)
        r = httpx.post(target_url, headers=h, json=payload, timeout=timeout)
    except Exception as e:
        raise HTTPException(502, f"POST {target_url} failed: {e}")
    if not r.is_success:
        raise HTTPException(502, f"Upstream {target_url} -> {r.status_code}: {r.text}")
    data = r.json()
    try:
        if provider == "anthropic":
            response = _parse_anthropic_response(data)
        elif provider == "ollama":
            response = _parse_ollama_response(data)
        else:
            msg = data["choices"][0]["message"]
            response = msg.get("content") or msg.get("reasoning_content") or ""
        _set_cached_response(cache_key, response)
        return response
    except Exception:
        raise HTTPException(502, f"Unexpected schema from {target_url}: {str(data)[:400]}")


def _dedupe_candidates(candidates):
    """Filter malformed entries and drop a later repeat of an already-seen
    ``(url, model)`` route, preserving order (first occurrence wins).

    The chain is the primary target followed by the configured fallbacks, so a
    fallback that repeats the session's current model — a common misconfiguration,
    since callers prepend the live ``(url, model)`` to ``default_model_fallbacks``
    — would otherwise make the chain re-attempt the very route that just failed:
    a wasted round-trip plus a spurious ``fallback`` notice for a switch that did
    not happen. Headers are not part of the key; the first tuple (with its
    headers) is the one kept.
    """
    seen = set()
    out = []
    for c in candidates or []:
        if not c or not c[0] or not c[1]:
            continue
        key = (c[0], c[1])
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def llm_call_with_fallback(candidates, messages, **kwargs) -> str:
    """Sync `llm_call` with an ordered fallback chain.

    `candidates` is a list of (url, model, headers). The first one that returns
    without an exception wins. Connection / 5xx-style failures fall through to
    the next candidate. The dead-host cooldown inside `llm_call` makes repeat
    attempts at an offline primary effectively free.
    """
    cands = _dedupe_candidates(candidates)
    if not cands:
        raise HTTPException(503, "No model endpoint configured")
    last_err = None
    for i, (url, model, headers) in enumerate(cands):
        try:
            return llm_call(url, model, messages, headers=headers, **kwargs)
        except Exception as e:
            last_err = e
            tag = "primary" if i == 0 else "candidate"
            logger.warning(f"[fallback] {tag} {model} failed ({type(e).__name__}); trying next")
            continue
    raise last_err if last_err else HTTPException(503, "All fallback candidates failed")


async def llm_call_async_with_fallback(candidates, messages, **kwargs) -> str:
    """与 ``llm_call_with_fallback`` 的异步变体 — 相同语义。"""
    cands = _dedupe_candidates(candidates)
    if not cands:
        raise HTTPException(503, "No model endpoint configured")
    last_err = None
    for i, (url, model, headers) in enumerate(cands):
        try:
            return await llm_call_async(url, model, messages, headers=headers, **kwargs)
        except Exception as e:
            last_err = e
            tag = "primary" if i == 0 else "candidate"
            logger.warning(f"[fallback] {tag} {model} failed ({type(e).__name__}); trying next")
            continue
    raise last_err if last_err else HTTPException(503, "All fallback candidates failed")


async def llm_call_async(
    url: str,
    model: str,
    messages: List[Dict],
    temperature: float = LLMConfig.DEFAULT_TEMPERATURE,
    max_tokens: int = LLMConfig.DEFAULT_MAX_TOKENS,
    headers: Optional[Dict] = None,
    timeout: int = LLMConfig.STREAM_TIMEOUT,
    max_retries: int = LLMConfig.MAX_RETRIES,
    prompt_type: Optional[str] = None
) -> str:
    """使用 httpx 的异步 LLM 调用，支持连接池、超时、重试逻辑和性能日志。"""
    provider = _detect_provider(url)
    messages_copy = _sanitize_llm_messages(messages)

    # Consolidate multiple system messages into one at the start.
    sys_parts = []
    non_sys = []
    for m in messages_copy:
        if m.get("role") == "system":
            sys_parts.append(m.get('content') or '')
        else:
            non_sys.append(m)
    if sys_parts:
        messages_copy = [{"role": "system", "content": "\n\n".join(sys_parts)}] + non_sys
    else:
        messages_copy = non_sys

    cache_key = _get_cache_key(url, model, messages_copy, temperature, max_tokens)
    cached_response = _get_cached_response(cache_key)
    if cached_response:
        logger.debug(f"Returning cached response for key: {cache_key}")
        return cached_response

    if provider == "chatgpt-subscription":
        # ChatGPT/Codex requires streamed Responses requests even for callers
        # that want a plain string (auto-title, memory extraction, etc.).
        # Reuse stream_llm's validated Codex SSE path and collect deltas.
        parts: List[str] = []
        async for chunk in stream_llm(
            url,
            model,
            messages_copy,
            temperature=temperature,
            max_tokens=max_tokens,
            headers=headers,
            timeout=timeout,
        ):
            event_is_error = False
            for line in str(chunk).splitlines():
                if line.startswith("event:"):
                    event_is_error = line[6:].strip() == "error"
                    continue
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw:
                    continue
                if raw == "[DONE]":
                    response = "".join(parts)
                    _set_cached_response(cache_key, response)
                    return response
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if event_is_error or data.get("error") or (data.get("status") and data.get("text")):
                    status = int(data.get("status") or 502)
                    text = data.get("text") or data.get("error") or "ChatGPT Subscription request failed"
                    raise HTTPException(status, text)
                delta = data.get("delta")
                if isinstance(delta, str):
                    parts.append(delta)
        response = "".join(parts)
        _set_cached_response(cache_key, response)
        return response

    if provider == "anthropic":
        target_url = _normalize_anthropic_url(url)
        h = _build_anthropic_headers(headers)
        payload = _build_anthropic_payload(model, messages_copy, temperature, max_tokens)
    elif provider == "ollama":
        target_url = _normalize_ollama_url(url)
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        payload = _build_ollama_payload(
            model, messages_copy, temperature, max_tokens,
            stream=False, num_ctx=get_context_length(url, model),
        )
    else:
        target_url = url
        h = _provider_headers(provider, headers)
        if provider == "copilot":
            from src.copilot import apply_request_headers
            apply_request_headers(h, messages_copy)
        payload = {
            "model": model,
            "messages": messages_copy,
            "temperature": temperature,
        }
        if _restricts_temperature(model):
            payload.pop("temperature", None)
        if max_tokens and max_tokens > 0:
            tok_key = "max_completion_tokens" if _uses_max_completion_tokens(model) else "max_tokens"
            payload[tok_key] = max_tokens

    if _is_host_dead(target_url):
        raise HTTPException(503, f"Upstream {_host_key(target_url)} marked unreachable (cooldown active)")

    call_timeout = httpx.Timeout(connect=3.0, read=float(timeout), write=10.0, pool=5.0)
    attempt = 0
    while attempt < max_retries:
        attempt += 1
        start = time.time()
        try:
            note_model_activity(target_url, model)
            client = _get_http_client()
            r = await client.post(target_url, headers=h, json=payload, timeout=call_timeout)
            duration = time.time() - start
            if not r.is_success:
                friendly = _format_upstream_error(r.status_code, r.text, target_url)
                logger.warning(
                    f"LLM async call to {target_url} failed in {duration:.2f}s "
                    f"(attempt {attempt}): HTTP {r.status_code} {friendly}"
                )
                if r.status_code in (429, 502, 503, 504) and attempt < max_retries:
                    await asyncio.sleep(LLMConfig.RETRY_DELAY)
                    continue
                raise HTTPException(r.status_code, friendly)
            logger.info(f"LLM async call to {target_url} succeeded in {duration:.2f}s (attempt {attempt})")
            _clear_host_dead(target_url)
            data = r.json()
            try:
                if provider == "anthropic":
                    response = _parse_anthropic_response(data)
                elif provider == "ollama":
                    response = _parse_ollama_response(data)
                else:
                    msg = data["choices"][0]["message"]
                    response = msg.get("content") or msg.get("reasoning_content") or ""
                _set_cached_response(cache_key, response)
                return response
            except Exception:
                raise HTTPException(502, f"Unexpected schema from {target_url}: {str(data)[:400]}")
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            _cooled = _mark_host_dead(target_url)
            duration = time.time() - start
            _tail = f" — host cooled for {DEAD_HOST_COOLDOWN:.0f}s" if _cooled else " — transient, will retry"
            logger.warning(f"LLM async connect to {target_url} failed after {duration:.2f}s: {e}{_tail}")
            if _cooled or attempt >= max_retries:
                raise HTTPException(503, f"Cannot reach {_host_key(target_url)}: {e}")
            await asyncio.sleep(LLMConfig.RETRY_DELAY)
        except (httpx.RequestError, httpx.HTTPStatusError) as e:
            duration = time.time() - start
            logger.warning(f"LLM async call attempt {attempt} failed after {duration:.2f}s: {e}")
            if attempt >= max_retries:
                raise HTTPException(502, f"POST {target_url} failed after {max_retries} attempts: {e}")
            await asyncio.sleep(LLMConfig.RETRY_DELAY)

async def stream_llm(url: str, model: str, messages: List[Dict], temperature: float = LLMConfig.DEFAULT_TEMPERATURE,
                     max_tokens: int = LLMConfig.DEFAULT_MAX_TOKENS, headers: Optional[Dict] = None,
                     timeout: int = LLMConfig.STREAM_TIMEOUT, prompt_type: Optional[str] = None,
                     tools: Optional[List[Dict]] = None):
    """Stream LLM responses with improved error handling.

    Yields SSE chunks:
      - data: {"delta": "text"}           — text content
      - data: {"type": "tool_calls", ...}  — accumulated native tool calls (before DONE)
      - event: error                       — errors
      - data: [DONE]                       — end of stream
    """
    provider = _detect_provider(url)
    messages_copy = _sanitize_llm_messages(messages)

    # Consolidate multiple system messages into one at the start.
    # Some models (e.g. Qwen3.5) reject system messages that aren't first.
    sys_parts = []
    non_sys = []
    for m in messages_copy:
        if m.get("role") == "system":
            sys_parts.append(m.get('content') or '')
        else:
            non_sys.append(m)
    if sys_parts:
        messages_copy = [{"role": "system", "content": "\n\n".join(sys_parts)}] + non_sys
    else:
        messages_copy = non_sys

    if provider == "anthropic":
        target_url = _normalize_anthropic_url(url)
        h = _build_anthropic_headers(headers)
        payload = _build_anthropic_payload(model, messages_copy, temperature, max_tokens, stream=True, tools=tools)
    elif provider == "ollama":
        target_url = _normalize_ollama_url(url)
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        payload = _build_ollama_payload(
            model, messages_copy, temperature, max_tokens,
            stream=True, tools=tools, num_ctx=get_context_length(url, model),
        )
    elif provider == "chatgpt-subscription":
        target_url = _normalize_chatgpt_subscription_url(url)
        h = _provider_headers(provider, headers)
        payload = _build_chatgpt_responses_payload(model, messages_copy, temperature, max_tokens, stream=True)
    else:
        target_url = url
        payload = {
            "model": model,
            "messages": messages_copy,
            "temperature": temperature,
            "stream": True,
        }
        if _restricts_temperature(model):
            payload.pop("temperature", None)
        if provider not in {"openrouter", "groq"}:
            payload["stream_options"] = {"include_usage": True}
        if max_tokens and max_tokens > 0:
            tok_key = "max_completion_tokens" if _uses_max_completion_tokens(model) else "max_tokens"
            payload[tok_key] = max_tokens
        if tools:
            payload["tools"] = tools
        h = _provider_headers(provider, headers)
        if provider == "copilot":
            from src.copilot import apply_request_headers
            apply_request_headers(h, messages_copy)

    # Short connect timeout: a reachable peer answers SYN in <100ms even on
    # Tailscale. 3s is plenty; 30s let one dead upstream wedge the UI.
    stream_timeout = httpx.Timeout(connect=3.0, read=float(timeout), write=30.0, pool=5.0)

    if _is_host_dead(target_url):
        yield f'event: error\ndata: {json.dumps({"error": f"Upstream {_host_key(target_url)} unreachable (cooldown active)", "status": 503})}\n\n'
        return
    note_model_activity(target_url, model)

    # ── ChatGPT Subscription / Codex Responses streaming ──
    if provider == "chatgpt-subscription":
        event_name = ""
        input_tokens = 0
        output_tokens = 0
        try:
            client = _get_http_client()
            async with client.stream('POST', target_url, json=payload, headers=h, timeout=stream_timeout) as r:
                _clear_host_dead(target_url)
                if r.status_code != 200:
                    raw = (await r.aread()).decode(errors="replace")
                    friendly = _format_chatgpt_subscription_error(r.status_code, raw)
                    yield f'event: error\ndata: {json.dumps({"status": r.status_code, "text": friendly, "raw": raw[:500]})}\n\n'
                    return
                async for line in r.aiter_lines():
                    if not line:
                        continue
                    if line.startswith("event:"):
                        event_name = line[6:].strip()
                        continue
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw:
                        continue
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    evt = data.get("type") or event_name
                    if evt == "response.output_text.delta":
                        delta = data.get("delta") or ""
                        if delta:
                            yield f'data: {json.dumps({"delta": delta})}\n\n'
                    elif evt == "response.completed":
                        usage = (data.get("response") or {}).get("usage") or data.get("usage") or {}
                        input_tokens = usage.get("input_tokens") or usage.get("prompt_tokens") or input_tokens
                        output_tokens = usage.get("output_tokens") or usage.get("completion_tokens") or output_tokens
                        if input_tokens or output_tokens:
                            yield f'data: {json.dumps({"type": "usage", "data": {"input_tokens": input_tokens, "output_tokens": output_tokens}})}\n\n'
                        yield "data: [DONE]\n\n"
                        return
                    elif evt in ("response.failed", "error"):
                        err = data.get("error") or (data.get("response") or {}).get("error") or {}
                        text = err.get("message") if isinstance(err, dict) else str(err or "ChatGPT Subscription request failed")
                        yield f'event: error\ndata: {json.dumps({"status": 502, "text": text})}\n\n'
                        return
                yield "data: [DONE]\n\n"
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            _cooled = _mark_host_dead(target_url)
            _tail = f" — host cooled for {DEAD_HOST_COOLDOWN:.0f}s" if _cooled else " — transient, will retry"
            logger.warning(f"ChatGPT Subscription stream connect to {target_url} failed: {e}{_tail}")
            yield f'event: error\ndata: {json.dumps({"error": f"Cannot reach {_host_key(target_url)}", "status": 503})}\n\n'
        except httpx.ReadTimeout:
            yield f'event: error\ndata: {json.dumps({"error": "Read timeout", "status": 504})}\n\n'
        except httpx.NetworkError:
            yield f'event: error\ndata: {json.dumps({"error": "Network error", "status": 502})}\n\n'
        except Exception as e:
            logger.error(f"ChatGPT Subscription stream error: {e}")
            yield f'event: error\ndata: {json.dumps({"error": str(e), "status": 502})}\n\n'
        return

    # ── Native Ollama streaming ──
    if provider == "ollama":
        _ollama_tool_calls: List[Dict] = []
        _harmony_router = _HarmonyStreamRouter()
        try:
            client = _get_http_client()
            async with client.stream('POST', target_url, json=payload, headers=h, timeout=stream_timeout) as r:
                _clear_host_dead(target_url)
                if r.status_code != 200:
                    raw = (await r.aread()).decode(errors="replace")
                    friendly = _format_upstream_error(r.status_code, raw, target_url)
                    yield f'event: error\ndata: {json.dumps({"status": r.status_code, "text": friendly, "raw": raw[:500]})}\n\n'
                    return
                async for line in r.aiter_lines():
                    if not line:
                        continue
                    try:
                        j = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    message = j.get("message") or {}
                    thinking = message.get("thinking") or ""
                    if thinking:
                        yield _stream_delta_event(thinking, thinking=True)
                    content = message.get("content") or ""
                    if content:
                        for part, is_thinking in _harmony_router.feed(content):
                            yield _stream_delta_event(part, thinking=is_thinking)
                    for tc in message.get("tool_calls") or []:
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            _ollama_tool_calls.append({
                                "id": tc.get("id") or f"call_{len(_ollama_tool_calls)}",
                                "name": fn.get("name") or "",
                                "arguments": json.dumps(fn.get("arguments") or {}),
                            })
                    if j.get("done"):
                        for part, is_thinking in _harmony_router.flush():
                            yield _stream_delta_event(part, thinking=is_thinking)
                        if _ollama_tool_calls:
                            yield f'data: {json.dumps({"type": "tool_calls", "calls": _ollama_tool_calls})}\n\n'
                        if j.get("prompt_eval_count") is not None or j.get("eval_count") is not None:
                            yield f'data: {json.dumps({"type": "usage", "data": {"input_tokens": j.get("prompt_eval_count", 0), "output_tokens": j.get("eval_count", 0)}})}\n\n'
                        yield "data: [DONE]\n\n"
                        return
                for part, is_thinking in _harmony_router.flush():
                    yield _stream_delta_event(part, thinking=is_thinking)
                yield "data: [DONE]\n\n"
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            _cooled = _mark_host_dead(target_url)
            _tail = f" — host cooled for {DEAD_HOST_COOLDOWN:.0f}s" if _cooled else " — transient, will retry"
            logger.warning(f"Ollama stream connect to {target_url} failed: {e}{_tail}")
            yield f'event: error\ndata: {json.dumps({"error": f"Cannot reach {_host_key(target_url)}", "status": 503})}\n\n'
        except httpx.ReadTimeout:
            yield f'event: error\ndata: {json.dumps({"error": "Read timeout", "status": 504})}\n\n'
        except httpx.NetworkError:
            yield f'event: error\ndata: {json.dumps({"error": "Network error", "status": 502})}\n\n'
        except Exception as e:
            logger.error(f"Ollama stream error: {e}")
            yield f'event: error\ndata: {json.dumps({"error": str(e), "status": 502})}\n\n'
        return

    # ── Anthropic streaming ──
    if provider == "anthropic":
        _anth_input_tokens = 0
        _anth_output_tokens = 0
        # Track tool_use blocks: {index: {id, name, arguments_json}}
        _anth_tool_blocks: Dict[int, Dict] = {}
        _anth_block_idx = -1
        _anth_block_type = ""
        try:
            client = _get_http_client()
            async with client.stream('POST', target_url, json=payload, headers=h, timeout=stream_timeout) as r:
                _clear_host_dead(target_url)
                if r.status_code != 200:
                    raw = (await r.aread()).decode(errors="replace")
                    friendly = _format_upstream_error(r.status_code, raw, target_url)
                    yield f'event: error\ndata: {json.dumps({"status": r.status_code, "text": friendly, "raw": raw[:500]})}\n\n'
                    return
                async for line in r.aiter_lines():
                    # SSE allows "data:value" with no space after the colon
                    # (the space is optional per the spec). Some gateways and
                    # local servers omit it; gating on "data: " dropped their
                    # entire stream.
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or not data.startswith("{"):
                        continue
                    try:
                        j = json.loads(data)
                        evt = j.get("type", "")
                        if evt == "content_block_start":
                            _anth_block_idx = j.get("index", _anth_block_idx + 1)
                            cb = j.get("content_block") or {}
                            _anth_block_type = cb.get("type", "text")
                            if _anth_block_type == "tool_use":
                                _anth_tool_blocks[_anth_block_idx] = {
                                    "id": cb.get("id") or f"call_{_anth_block_idx}",
                                    "name": cb.get("name") or "",
                                    "arguments": "",
                                }
                        elif evt == "content_block_delta":
                            delta = j.get("delta") or {}
                            delta_type = delta.get("type", "")
                            if delta_type == "text_delta":
                                text = delta.get("text") or ""
                                if text:
                                    yield f'data: {json.dumps({"delta": text})}\n\n'
                            elif delta_type == "input_json_delta":
                                # Accumulate tool arguments JSON
                                idx = j.get("index", _anth_block_idx)
                                if idx in _anth_tool_blocks:
                                    partial = delta.get("partial_json") or ""
                                    _anth_tool_blocks[idx]["arguments"] += partial
                                    # Stream tool arg deltas for doc tools
                                    if partial and _anth_tool_blocks[idx].get("name") in ("create_document", "update_document", "edit_document"):
                                        yield f'data: {json.dumps({"type": "tool_call_delta", "index": idx, "name": _anth_tool_blocks[idx]["name"], "arg_delta": partial})}\n\n'
                        elif evt == "message_start":
                            _u = j.get("message", {}).get("usage", {})
                            _anth_input_tokens = _u.get("input_tokens", 0)
                            # Surface prompt-cache effectiveness: cache_read > 0 means the
                            # stable system+tools prefix was served from cache this round.
                            _c_read = _u.get("cache_read_input_tokens", 0)
                            _c_write = _u.get("cache_creation_input_tokens", 0)
                            if _c_read or _c_write:
                                logger.info(
                                    "[anthropic-cache] read=%s write=%s fresh_input=%s",
                                    _c_read, _c_write, _anth_input_tokens,
                                )
                        elif evt == "message_delta":
                            _anth_output_tokens = j.get("usage", {}).get("output_tokens", 0)
                        elif evt == "message_stop":
                            # Emit accumulated tool calls in OpenAI-compatible format
                            if _anth_tool_blocks:
                                calls = []
                                for idx in sorted(_anth_tool_blocks):
                                    tb = _anth_tool_blocks[idx]
                                    calls.append({
                                        "id": tb["id"],
                                        "name": tb["name"],
                                        "arguments": tb["arguments"],
                                    })
                                yield f'data: {json.dumps({"type": "tool_calls", "calls": calls})}\n\n'
                            if _anth_input_tokens or _anth_output_tokens:
                                yield f'data: {json.dumps({"type": "usage", "data": {"input_tokens": _anth_input_tokens, "output_tokens": _anth_output_tokens}})}\n\n'
                            yield "data: [DONE]\n\n"
                            return
                        elif evt == "error":
                            err_msg = j.get("error", {}).get("message", "Unknown error")
                            yield f'event: error\ndata: {json.dumps({"error": err_msg, "status": 400})}\n\n'
                            return
                    except json.JSONDecodeError:
                        continue
                yield "data: [DONE]\n\n"
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            _cooled = _mark_host_dead(target_url)
            _tail = f" — host cooled for {DEAD_HOST_COOLDOWN:.0f}s" if _cooled else " — transient, will retry"
            logger.warning(f"Anthropic stream connect to {target_url} failed: {e}{_tail}")
            yield f'event: error\ndata: {json.dumps({"error": f"Cannot reach {_host_key(target_url)}", "status": 503})}\n\n'
        except httpx.ReadTimeout:
            yield f'event: error\ndata: {json.dumps({"error": "Read timeout", "status": 504})}\n\n'
        except httpx.NetworkError:
            yield f'event: error\ndata: {json.dumps({"error": "Network error", "status": 502})}\n\n'
        except Exception as e:
            logger.error(f"Anthropic stream error: {e}")
            yield f'event: error\ndata: {json.dumps({"error": str(e), "status": 502})}\n\n'
        return

    # ── OpenAI-compatible streaming ──
    # Accumulate native tool_calls across streaming chunks
    _tc_acc: Dict[int, Dict] = {}  # index -> {id, name, arguments}
    _tc_last_idx = [-1]  # most-recently-touched slot, for providers that omit `index`
    # For thinking models: prepend <think> to first content delta so frontend
    # can detect thinking-in-progress (some models output </think> but no <think>)
    _thinking_model = _supports_thinking(model)
    _first_content_sent = False
    _in_think_tag = False        # True while consuming <think>…</think> content
    _think_open_stripped = False  # opening <think> tag already removed
    _harmony_router = _HarmonyStreamRouter()
    _harmony_active = False       # sticky: gpt-oss harmony <|channel|> stream detected
    _actual_model = ""
    _actual_model_announced = False

    def _emit_tool_calls():
        """Build the tool_calls event string if any were accumulated."""
        if not _tc_acc:
            return None
        calls = [_tc_acc[i] for i in sorted(_tc_acc)]
        return f'data: {json.dumps({"type": "tool_calls", "calls": calls})}\n\n'

    def _format_routed_content(parts: List[Tuple[str, bool]]) -> List[str]:
        nonlocal _first_content_sent
        events = []
        for part, is_thinking in parts:
            if is_thinking:
                events.append(_stream_delta_event(part, thinking=True))
                continue
            # Some thinking backends start normal content with a stray closing
            # tag. Repair only that shape; do not wrap every first token for
            # model families like MiniMax, which often stream ordinary answers.
            if _thinking_model and not _first_content_sent and part.lstrip().lower().startswith("</think"):
                part = "<think>" + part
            _first_content_sent = True
            events.append(_stream_delta_event(part))
        return events

    try:
        client = _get_http_client()
        async with client.stream('POST', target_url, json=payload, headers=h, timeout=stream_timeout) as r:
            _clear_host_dead(target_url)
            if r.status_code != 200:
                raw = (await r.aread()).decode(errors="replace")
                friendly = _format_upstream_error(r.status_code, raw, target_url)
                yield f'event: error\ndata: {json.dumps({"status": r.status_code, "text": friendly, "raw": raw[:500]})}\n\n'
                return

            async for line in r.aiter_lines():
                if not line:
                    continue

                # SSE allows "data:value" with no space after the colon; gating
                # on "data: " silently dropped content + usage from providers
                # that omit it.
                if line.startswith("data:"):
                    data = line[5:].strip()
                    if data == "[DONE]":
                        for event in _format_routed_content(_harmony_router.flush()):
                            yield event
                        tc_event = _emit_tool_calls()
                        if tc_event:
                            yield tc_event
                        yield "data: [DONE]\n\n"
                        return

                    try:
                        if data.strip():
                            if data.startswith("{"):
                                j = json.loads(data)
                                chunk_model = j.get("model")
                                if isinstance(chunk_model, str) and chunk_model.strip():
                                    _actual_model = chunk_model.strip()
                                    if (
                                        not _actual_model_announced
                                        and not _same_model_identity(_actual_model, model)
                                    ):
                                        _actual_model_announced = True
                                        yield f'data: {json.dumps({"type": "model_actual", "requested_model": model, "model": _actual_model})}\n\n'
                                # Usage chunk (from stream_options)
                                _choices = j.get("choices") or []
                                _delta0 = _choices[0].get("delta") if (_choices and _choices[0] is not None) else None
                                # Capture usage whenever the chunk carries it and
                                # the delta has no actual output. Some gateways /
                                # local servers attach usage to the FINAL delta,
                                # which also carries role/finish_reason (so it is
                                # not exactly None/{}/{"content": None}); gating on
                                # those exact shapes discarded their token counts.
                                _delta_has_output = isinstance(_delta0, dict) and (
                                    _delta0.get("content")
                                    or _delta0.get("reasoning_content")
                                    or _delta0.get("reasoning")
                                    or _delta0.get("thinking")
                                    or _delta0.get("tool_calls")
                                )
                                if "usage" in j and not _delta_has_output:
                                    u = j["usage"] or {}
                                    _usage_data = {"input_tokens": u.get("prompt_tokens", 0), "output_tokens": u.get("completion_tokens", 0)}
                                    # llama.cpp puts a `timings` block alongside `usage` with the
                                    # TRUE generation speed (predicted_per_second) — pure decode,
                                    # excluding prefill/network. Pass it through so the UI shows the
                                    # real gen t/s instead of recomputing tokens/wall-clock (which
                                    # includes prefill and reads ~20-40% low). Prefill speed too.
                                    _tm = j.get("timings")
                                    if isinstance(_tm, dict):
                                        if _tm.get("predicted_per_second"):
                                            _usage_data["gen_tps"] = round(_tm["predicted_per_second"], 2)
                                        if _tm.get("prompt_per_second"):
                                            _usage_data["prefill_tps"] = round(_tm["prompt_per_second"], 2)
                                    if _actual_model:
                                        _usage_data["model"] = _actual_model
                                        if not _same_model_identity(_actual_model, model):
                                            _usage_data["requested_model"] = model
                                    yield f'data: {json.dumps({"type": "usage", "data": _usage_data})}\n\n'
                                elif "choices" in j:
                                    _c0 = (j["choices"] or [None])[0]
                                    if _c0 is None:
                                        continue
                                    delta = _c0.get("delta") or {}
                                    if isinstance(delta, dict):
                                        # Text content
                                        # Reasoning tokens (VLLM --reasoning-parser, e.g. Qwen3/DeepSeek-R1, Nemotron). vLLM 0.20.2 / NIM emit the field as `reasoning`; older builds use `reasoning_content`. Some OpenAI-compatible Ollama builds use `thinking`.
                                        reasoning = delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking") or ""
                                        if reasoning:
                                            yield _stream_delta_event(reasoning, thinking=True)
                                        content = delta.get("content") or ""
                                        if content:
                                            stripped = content.lstrip()
                                            # gpt-oss harmony format (<|channel|>analysis/final): route via the harmony
                                            # stream router. Sticky once the first marker appears — distinct from the
                                            # <think> path below (handled in the else, preserving #2588 behaviour).
                                            if _harmony_active or "<|" in content:
                                                _harmony_active = True
                                                for event in _format_routed_content(_harmony_router.feed(content)):
                                                    yield event
                                            else:
                                                # Auto-detect <think>…</think> in content stream.
                                                # Covers Qwen3-derived models (Qwopus, QwQ forks) whose
                                                # names don't match _THINKING_MODEL_PATTERNS but still
                                                # emit literal <think> markup via llama.cpp --jinja.
                                                if not _first_content_sent and not _thinking_model and not _in_think_tag and stripped.lower().startswith("<think"):
                                                    _thinking_model = True
                                                    _in_think_tag = True
                                                if _in_think_tag:
                                                    close_idx = content.lower().find("</think>")
                                                    if close_idx != -1:
                                                        # Split: up-to-</think> → thinking, remainder → content
                                                        think_part = content[:close_idx]
                                                        if not _think_open_stripped:
                                                            # Strip the opening <think[...] > from the first chunk.
                                                            # Use a dedicated flag — _first_content_sent stays False
                                                            # throughout the think block, so it must not be reused.
                                                            tag_end = think_part.lower().find(">")
                                                            if tag_end != -1:
                                                                think_part = think_part[tag_end + 1:]
                                                            _think_open_stripped = True
                                                        regular_part = content[close_idx + len("</think>"):]
                                                        _in_think_tag = False
                                                        if think_part:
                                                            yield f'data: {json.dumps({"delta": think_part, "thinking": True})}\n\n'
                                                        if regular_part:
                                                            _first_content_sent = True
                                                            yield f'data: {json.dumps({"delta": regular_part})}\n\n'
                                                    else:
                                                        # Still inside <think>: route to thinking channel
                                                        if not _think_open_stripped:
                                                            # Strip the opening <think[...] > tag (first chunk only)
                                                            tag_end = stripped.lower().find(">")
                                                            if tag_end != -1:
                                                                content = stripped[tag_end + 1:]
                                                            _think_open_stripped = True
                                                        if content:
                                                            yield f'data: {json.dumps({"delta": content, "thinking": True})}\n\n'
                                                else:
                                                    # Some thinking backends start normal content with a
                                                    # stray closing tag. Repair only that shape; do not
                                                    # wrap every first token for model families like
                                                    # MiniMax, which often stream ordinary answers.
                                                    if _thinking_model and not _first_content_sent and stripped.lower().startswith("</think"):
                                                        content = "<think>" + content
                                                    _first_content_sent = True
                                                    yield f'data: {json.dumps({"delta": content})}\n\n'
                                        # Native tool calls — accumulate across chunks
                                        for tc in delta.get("tool_calls") or []:
                                            if tc is None:
                                                continue
                                            func = tc.get("function") or {}
                                            raw_idx = tc.get("index")
                                            if raw_idx is None:
                                                # Gemini's OpenAI-compat layer omits `index` on
                                                # parallel tool calls (every delta arrives as
                                                # index=None) and sends each call complete in one
                                                # delta. Without this, all parallel calls collide
                                                # into slot 0 — later calls overwrite the first's
                                                # name and CORRUPT its arguments by concatenation,
                                                # so only one malformed call survives and the
                                                # follow-up round 400s. A function name marks the
                                                # start of a new call → allocate a fresh slot;
                                                # an arg-only continuation attaches to the last.
                                                if func.get("name") or _tc_last_idx[0] < 0:
                                                    # Next free slot ABOVE any existing key (not
                                                    # len()), so a provider mixing integer indices
                                                    # with index=None can never collide.
                                                    idx = max(_tc_acc, default=-1) + 1
                                                else:
                                                    idx = _tc_last_idx[0]
                                            else:
                                                idx = raw_idx
                                            _tc_last_idx[0] = idx
                                            if idx not in _tc_acc:
                                                _tc_acc[idx] = {"id": "", "name": "", "arguments": ""}
                                            if tc.get("id"):
                                                _tc_acc[idx]["id"] = tc["id"]
                                            # Gemini 3 returns an opaque thought_signature in
                                            # extra_content on the function-call delta. It MUST be
                                            # echoed back on the assistant tool_call next round or the
                                            # follow-up request 400s ("Function call is missing a
                                            # thought_signature"). Preserve it verbatim; other
                                            # providers never send it, so this is a no-op for them.
                                            if tc.get("extra_content"):
                                                _tc_acc[idx]["extra_content"] = tc["extra_content"]
                                            if func.get("name"):
                                                _tc_acc[idx]["name"] = func["name"]
                                            if "arguments" in func:
                                                # Guard against a null arguments delta: `func` can be
                                                # {"arguments": None} (JSON null), and a raw `+= None`
                                                # raises TypeError that the broad except swallows,
                                                # silently dropping the rest of the chunk. Matches the
                                                # Anthropic accumulator (`partial = ... or ""`) above.
                                                _tc_acc[idx]["arguments"] += func["arguments"] or ""
                                                # Stream tool arg deltas for doc tools
                                                if func["arguments"] and _tc_acc[idx].get("name") in ("create_document", "update_document", "edit_document"):
                                                    yield f'data: {json.dumps({"type": "tool_call_delta", "index": idx, "name": _tc_acc[idx]["name"], "arg_delta": func["arguments"]})}\n\n'
                                elif "text" in j:
                                    if j["text"]:
                                        for event in _format_routed_content(_harmony_router.feed(j["text"])):
                                            yield event
                            else:
                                if data.strip():
                                    for event in _format_routed_content(_harmony_router.feed(data)):
                                        yield event
                    except Exception as e:
                        logger.error(f"Error parsing stream data: {e}")
                        continue

            # End of stream (no explicit [DONE] received)
            for event in _format_routed_content(_harmony_router.flush()):
                yield event
            tc_event = _emit_tool_calls()
            if tc_event:
                yield tc_event
            yield "data: [DONE]\n\n"

    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        _cooled = _mark_host_dead(target_url)
        _tail = f" — host cooled for {DEAD_HOST_COOLDOWN:.0f}s" if _cooled else " — transient, will retry"
        logger.warning(f"Stream connect to {target_url} failed: {e}{_tail}")
        yield f'event: error\ndata: {json.dumps({"error": f"Cannot reach {_host_key(target_url)}", "status": 503})}\n\n'
    except httpx.ReadTimeout:
        yield f'event: error\ndata: {json.dumps({"error": "Read timeout", "status": 504})}\n\n'
    except httpx.NetworkError:
        yield f'event: error\ndata: {json.dumps({"error": "Network error", "status": 502})}\n\n'
    except Exception as e:
        logger.error(f"Stream error: {e}")
        yield f'event: error\ndata: {json.dumps({"error": str(e), "status": 502})}\n\n'


def _summarize_stream_error(err_chunk: Optional[str]) -> str:
    """Pull a short human reason out of an `event: error` SSE chunk for the
    fallback notice. Returns a generic message if it can't be parsed."""
    if not err_chunk:
        return "primary model failed"
    try:
        for line in err_chunk.split("\n"):
            if line.startswith("data: "):
                j = json.loads(line[6:])
                txt = j.get("text") or j.get("error") or ""
                status = j.get("status")
                msg = (f"HTTP {status}: " if status else "") + str(txt)
                return msg[:200].strip() or "primary model failed"
    except Exception:
        pass
    return "primary model failed"


async def stream_llm_with_fallback(candidates, messages, **kwargs):
    """Wrap stream_llm with an ordered fallback chain.

    `candidates` is a list of (url, model, headers). Each is tried in order,
    but only retried on a *pre-content* failure — i.e. an ``event: error``
    that arrives before any assistant text / tool-call data has been yielded.
    Once a candidate has emitted real output we never switch (that would
    duplicate streamed tokens); a later error from that candidate passes
    through unchanged. The dead-host cooldown in stream_llm makes repeat
    attempts at an offline primary effectively instant.

    Yields the same SSE chunk protocol as stream_llm.
    """
    cands = _dedupe_candidates(candidates)
    if not cands:
        yield f'event: error\ndata: {json.dumps({"error": "No model endpoint configured", "status": 503})}\n\n'
        return

    primary_model = cands[0][1]
    last_error = None
    for i, (url, model, headers) in enumerate(cands):
        is_last = (i == len(cands) - 1)
        emitted = False
        retried = False
        async for chunk in stream_llm(url, model, messages, headers=headers, **kwargs):
            if chunk.startswith("event: error"):
                if not emitted and not is_last:
                    # Pre-content failure with fallbacks left — swallow and
                    # move to the next candidate.
                    last_error = chunk
                    retried = True
                    if i == 0:
                        logger.warning(f"[fallback] primary {model} failed before output; trying fallback")
                    else:
                        logger.warning(f"[fallback] candidate {model} failed; trying next")
                    break
                yield chunk
                continue
            # Any data chunk other than the terminal [DONE] means real output.
            if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
                try:
                    event_data = json.loads(chunk[6:])
                except Exception:
                    event_data = {}
                if event_data.get("type") == "model_actual":
                    yield chunk
                    continue
                # First real output from a NON-primary candidate: tell the client
                # the selected model failed and another answered. Without this the
                # fallback is invisible — a misconfigured provider looks like it
                # works because the reply is shown under the originally selected
                # model's name (e.g. a Bedrock/Claude endpoint that 400s every
                # request but appears fine because another model silently answered).
                if not emitted and i > 0:
                    yield ('data: ' + json.dumps({
                        "type": "fallback",
                        "selected_model": primary_model,
                        "answered_by": model,
                        "reason": _summarize_stream_error(last_error),
                    }) + '\n\n')
                emitted = True
            yield chunk
        if not retried:
            return  # candidate finished (success, or terminal error already sent)
    # Every candidate failed pre-content — surface the last error.
    if last_error:
        yield last_error
