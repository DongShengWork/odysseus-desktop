"""外向 webhook 管理器 — 当事件发生时触发 HTTP POST。"""

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import re
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx

from src.database import SessionLocal, Webhook

logger = logging.getLogger(__name__)

ALLOWED_EVENTS = frozenset({
    "session.created",
    "chat.completed",
    "chat.message",
    "webhook.test",
})

# 阻止对私有/内部网络的请求
_PRIVATE_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def _utcnow() -> datetime:
    """返回朴素 UTC 时间，用于现有 DB 列，同时避免 datetime.utcnow()。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _ip_is_private(addr: ipaddress._BaseAddress) -> bool:
    # 如果地址是 IPv4 映射的 IPv6，提取并评估嵌入的 IPv4
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped

    if (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    ):
        return True

    return any(addr in net for net in _PRIVATE_NETWORKS)


def _resolve_hostname_ips(hostname: str) -> list:
    """将主机名解析为其所有 A/AAAA 记录。失败时返回空列表。"""
    import socket
    try:
        infos = socket.getaddrinfo(hostname, None)
    except Exception:
        return []
    out = []
    for info in infos:
        sockaddr = info[4]
        try:
            out.append(ipaddress.ip_address(sockaddr[0]))
        except ValueError:
            continue
    return out


def _is_private_url(url: str) -> bool:
    """检查 URL 是否指向私有/内部地址。

    解析 DNS 名称，这样攻击者无法将内部 IP 隐藏在
    `internal.lan` 或 `127.0.0.1.nip.io` 后面。在发送时也会重新检查，
    作为对 DNS rebinding 的部分防御。
    """
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").strip()
        if not hostname:
            return True
        # 阻止常见的内部主机名 + 解析器可能无法捕获的后缀。
        h_lower = hostname.lower()
        if h_lower in ("localhost", "0.0.0.0", "metadata.google.internal", "metadata"):
            return True
        if h_lower.endswith((".local", ".internal", ".lan", ".intranet", ".localhost")):
            return True
        # IP 字面量？直接短路判断。
        try:
            return _ip_is_private(ipaddress.ip_address(hostname))
        except ValueError:
            pass
        # DNS 主机名 — 解析并检查每条记录。
        addrs = _resolve_hostname_ips(hostname)
        if not addrs:
            # 无法解析 → 安全起见拒绝通过；让验证拒绝该 URL。
            return True
        return any(_ip_is_private(a) for a in addrs)
    except ValueError:
        return True


def validate_webhook_url(url: str) -> str:
    """验证并规范化 webhook URL。无效时抛出 ValueError。"""
    url = url.strip()
    if len(url) > 2048:
        raise ValueError("URL too long (max 2048 characters)")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("URL must use http or https")
    if not parsed.hostname:
        raise ValueError("URL must have a hostname")
    if _is_private_url(url):
        raise ValueError("URL must not point to private/internal addresses")
    return url


def validate_events(events_str: str) -> str:
    """验证逗号分隔的事件名称。返回清理后的字符串。"""
    events = [e.strip() for e in events_str.split(",") if e.strip()]
    if not events:
        raise ValueError("At least one event is required")
    invalid = set(events) - ALLOWED_EVENTS
    if invalid:
        raise ValueError(f"Invalid events: {', '.join(sorted(invalid))}. Allowed: {', '.join(sorted(ALLOWED_EVENTS - {'webhook.test'}))}")
    return ",".join(events)


# IP 脱敏处理用的宽泛候选匹配器。故意设计得宽松：
# 带可选 :port 的方括号主机授权（[fe80::1%eth0]:8080 等），
# 或裸 IPv6 — 由冒号连接的十六进制组，可选的尾随
# 点分十进制表示 IPv4 映射形式（::ffff:192.168.0.1），以及可选的 %zone。
# 它不编码 IPv6 语法；ipaddress.ip_address() 是真正的
# 验证器（参见 _redact_ip_candidate），因此任何它拒绝的带冒号的字符串
# （时钟时间、MAC 地址、"std::vector"）将被保留。每个分支都是单个
# 贪婪字符类或强制 ':'/'.' 分隔符上的重复，因此不存在
# 嵌套量词回溯（ReDoS 安全）。
_IP_CANDIDATE = re.compile(
    r'\[[^\[\]\s]*\](?::\d+)?'
    r'|(?<![\w.:%])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,}'
    r'(?:(?:\.[0-9]{1,3}){3})?(?:%[0-9A-Za-z._-]+)?'
)


def _redact_ip_candidate(match: re.Match) -> str:
    """脱敏一个标准库确认为 IP 地址的候选标记。

    裸标记仅在解析为 IPv6 时才脱敏 — 裸 IPv4 留给
    专用的 IPv4 处理。方括号标记是主机授权，因此 [] 中的
    v4 或 v6 字面量整体脱敏。这使输出保持一致（一个
    [redacted]，不会嵌套或部分脱敏），适用于带作用域/映射/端口的格式。
    """
    token = match.group(0)
    bracketed = token.startswith('[')
    candidate = token
    if bracketed:
        # 仅保留 [...] 内部的内容；尾随的 :port 被丢弃。
        candidate = candidate[1:candidate.index(']')]
    # zone id（fe80::1%eth0）不是 ipaddress 解析的地址的一部分。
    candidate = candidate.split('%', 1)[0]
    # 宽松的裸模式可能尾随一个多余的 ':'（例如 "host ::1: down"）；
    # 除非是 "::" 压缩标记，否则丢弃它。
    if candidate.endswith(':') and not candidate.endswith('::'):
        candidate = candidate[:-1]
    try:
        addr = ipaddress.ip_address(candidate)
    except ValueError:
        return token
    if bracketed or isinstance(addr, ipaddress.IPv6Address):
        return '[redacted]'
    return token


def sanitize_error(error: str, max_len: int = 200) -> str:
    """从错误消息中剥离潜在敏感信息。"""
    # 首先脱敏 IPv6（和方括号授权）地址，这样像 ::ffff:192.168.0.1
    # 的 IPv4 映射形式会作为一个单元被擦除，而不是先移除
    # 其嵌入的 IPv4 并留下一个冗余的 "::ffff:"。宽泛的
    # 候选由 ipaddress.ip_address() 验证，因此误报
    # 防护（时钟时间、MAC 地址、C++ "::"）来自标准库，而非正则表达式。
    cleaned = _IP_CANDIDATE.sub(_redact_ip_candidate, error)
    # 移除剩余的裸 IPv4 地址和端口。
    cleaned = re.sub(r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?', '[redacted]', cleaned)
    # 移除 URL 中的主机名。
    cleaned = re.sub(r'https?://[^\s/]+', '[redacted-url]', cleaned)
    return cleaned[:max_len]


class WebhookManager:
    def __init__(self, api_key_manager=None):
        # 禁用重定向以防止通过重定向链进行 SSRF
        self._client = httpx.AsyncClient(timeout=10, follow_redirects=False)
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._api_key_manager = api_key_manager
        # Strong references to in-flight fire-and-forget tasks. asyncio only
        # keeps weak references to tasks, so without this the GC can collect a
        # delivery task mid-flight and the webhook is silently never sent.
        self._bg_tasks: set = set()

    def _spawn_tracked(self, coro):
        """Schedule a background task and hold a strong reference until it
        finishes, so it can't be garbage-collected before delivery completes."""
        task = asyncio.ensure_future(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)
        return task

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    def _decrypt_secret(self, encrypted: Optional[str]) -> Optional[str]:
        """从 DB 存储中解密 webhook 签名密钥。"""
        if not encrypted:
            return None
        if self._api_key_manager:
            try:
                return self._api_key_manager.decrypt_api_key(encrypted)
            except Exception:
                # 如果解密失败，假设它以明文存储（旧格式）
                return encrypted
        return encrypted

    def fire_and_forget(self, event: str, payload: dict):
        """从任何上下文（同步或异步）调度 webhook 触发。永不阻塞。"""
        if event not in ALLOWED_EVENTS:
            return
        try:
            asyncio.get_running_loop()
            self._spawn_tracked(self.fire(event, payload))
        except RuntimeError:
            # 从同步线程调用（例如线程池中的同步 FastAPI 路由）
            if self._loop and self._loop.is_running():
                asyncio.run_coroutine_threadsafe(self.fire(event, payload), self._loop)

    async def fire(self, event: str, payload: dict):
        """触发匹配给定事件的 webhooks。"""
        if event not in ALLOWED_EVENTS:
            return
        db = SessionLocal()
        try:
            webhooks = db.query(Webhook).filter(Webhook.is_active == True).all()
            matching = [w for w in webhooks if event in w.events.split(",")]
        finally:
            db.close()

        for wh in matching:
            decrypted_secret = self._decrypt_secret(wh.secret)
            self._spawn_tracked(self._deliver(wh.id, wh.url, decrypted_secret, event, payload))

    async def deliver_test(self, webhook_id: str, url: str, encrypted_secret: Optional[str]):
        """用于测试 webhook 路由的公共方法。"""
        decrypted = self._decrypt_secret(encrypted_secret)
        await self._deliver(webhook_id, url, decrypted, "webhook.test", {"message": "Test ping from Odysseus"})

    async def _deliver(self, webhook_id: str, url: str, secret: Optional[str], event: str, payload: dict):
        """内部发送。切勿从该类外部直接调用（请使用 deliver_test）。"""
        # 在发送时重新验证 URL，以防 DB 被篡改
        try:
            validate_webhook_url(url)
        except ValueError as e:
            logger.warning(f"Webhook {webhook_id} has invalid URL, skipping: {e}")
            return

        body = json.dumps({"event": event, "timestamp": _utcnow().isoformat(), "data": payload})
        headers = {
            "Content-Type": "application/json",
            "X-Odysseus-Event": event,
            "User-Agent": "Odysseus-Webhook/1.0",
        }
        if secret:
            sig = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
            headers["X-Odysseus-Signature"] = sig

        db = SessionLocal()
        try:
            resp = await self._client.post(url, content=body, headers=headers)
            db.query(Webhook).filter(Webhook.id == webhook_id).update({
                "last_triggered_at": _utcnow(),
                "last_status_code": resp.status_code,
                "last_error": None,
            })
            db.commit()
        except Exception as e:
            logger.warning(f"Webhook delivery failed for {webhook_id}")
            try:
                db.query(Webhook).filter(Webhook.id == webhook_id).update({
                    "last_triggered_at": _utcnow(),
                    "last_status_code": None,
                    "last_error": sanitize_error(str(e)),
                })
                db.commit()
            except Exception:
                db.rollback()
        finally:
            db.close()

    async def close(self):
        await self._client.aclose()
