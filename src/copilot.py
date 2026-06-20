# src/copilot.py
"""GitHub Copilot 提供商支持。

Copilot 在 ``https://api.githubcopilot.com`` 暴露 OpenAI 兼容的 API
（``/chat/completions`` + ``/models``）。认证是 GitHub OAuth
**设备流程**：用户在浏览器中授权设备码，我们收到一个长期有效的
``access_token``，直接作为 ``Authorization: Bearer <token>`` 发送 —
没有单独的 Copilot token 交换，也没有刷新（镜像编辑器 / opencode 与
Copilot 通信的方式）。

The only provider-specific wrinkle beyond the bearer token is a handful of
required request headers (API version, intent, an editor-style User-Agent,
and ``x-initiator`` for agent-vs-user request accounting). Those live in
请求计费的 ``x-initiator``）。这些位于 :func:`copilot_headers` 中。

此模块持有常量 + 纯辅助函数；HTTP 设备流程调用位于
:mod:`routes.copilot_routes` 中，以便进行 auth 门控。
"""

import os
from typing import Dict, List, Optional
from urllib.parse import urlparse

import httpx

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

# 用于设备流程的 GitHub OAuth client id。Copilot 的 token 端点
# 仅接受 GitHub 已列入白名单以访问 Copilot 的 client id，因此
# 我们复用公开的 VS Code client id（第三方客户端实际使用的标准）。
# 如果你注册了自己的白名单应用，可通过环境变量覆盖。
COPILOT_CLIENT_ID = os.environ.get(
    "ODYSSEUS_COPILOT_CLIENT_ID", "01ab8ac9400c4e429b23"
)

# Copilot API 要求的带日期的 API 版本头（models + chat）。
COPILOT_API_VERSION = os.environ.get(
    "ODYSSEUS_COPILOT_API_VERSION", "2026-06-01"
)

# 公共 Copilot API 基础地址。GitHub Enterprise 使用 ``copilot-api.<domain>``。
COPILOT_BASE = "https://api.githubcopilot.com"

# Copilot 希望使用编辑器风格的 User-Agent + 集成 ID。这些向 GitHub
# 标识客户端；保持它们稳定。
COPILOT_USER_AGENT = os.environ.get(
    "ODYSSEUS_COPILOT_USER_AGENT", "Odysseus/1.0"
)
COPILOT_INTEGRATION_ID = os.environ.get(
    "ODYSSEUS_COPILOT_INTEGRATION_ID", "vscode-chat"
)
COPILOT_EDITOR_VERSION = os.environ.get(
    "ODYSSEUS_COPILOT_EDITOR_VERSION", "Odysseus/1.0"
)

# 设备流程中请求的 OAuth 权限范围。
COPILOT_SCOPE = "read:user"

# 设备流程的默认 GitHub 主机（公共 github.com）。
GITHUB_HOST = "github.com"


def device_code_url(host: str = GITHUB_HOST) -> str:
    return f"https://{host}/login/device/code"


def access_token_url(host: str = GITHUB_HOST) -> str:
    return f"https://{host}/login/oauth/access_token"


def normalize_domain(url: str) -> str:
    """从 GitHub Enterprise URL 或域名中去除 scheme/尾部斜杠。"""
    return (url or "").replace("https://", "").replace("http://", "").rstrip("/")


def enterprise_base(enterprise_url: Optional[str]) -> str:
    """返回部署的 Copilot API 基础地址。

    公共 github.com → ``https://api.githubcopilot.com``。
    Enterprise <domain> → ``https://copilot-api.<domain>``。
    """
    if not enterprise_url:
        return COPILOT_BASE
    return f"https://copilot-api.{normalize_domain(enterprise_url)}"


def is_copilot_base(url: Optional[str]) -> bool:
    """如果基础 URL 指向 Copilot API（公共或企业版），则返回 True。"""
    if not url:
        return False
    try:
        host = (urlparse(url).hostname or "").lower().rstrip(".")
    except Exception:
        return False
    if not host:
        return False
    # 公共：api.githubcopilot.com（或任何 *.githubcopilot.com）。
    if host == "githubcopilot.com" or host.endswith(".githubcopilot.com"):
        return True
    # 企业版：copilot-api.<domain>。
    if host.startswith("copilot-api."):
        return True
    return False


def copilot_headers(
    api_key: Optional[str],
    *,
    agent: bool = False,
    vision: bool = False,
) -> Dict[str, str]:
    """构建 Copilot 特定的请求头。

    Args:
        api_key: GitHub 设备流程 access token（作为 Bearer 发送）。
        agent:   请求来自 agent 循环（工具驱动的轮次）
                 而非直接用户消息。设置 ``x-initiator`` 用于
                 Copilot 的 agent-vs-user 请求计费。
        vision:  请求包含图片部分。
    """
    headers: Dict[str, str] = {
        "X-GitHub-Api-Version": COPILOT_API_VERSION,
        "Openai-Intent": "conversation-edits",
        "User-Agent": COPILOT_USER_AGENT,
        "Editor-Version": COPILOT_EDITOR_VERSION,
        "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
        "x-initiator": "agent" if agent else "user",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if vision:
        headers["Copilot-Vision-Request"] = "true"
    return headers


# ---------------------------------------------------------------------------
# 设备流程 OAuth（纯 HTTP；编排逻辑在 routes.copilot_routes）
# ---------------------------------------------------------------------------

def _oauth_post_headers() -> Dict[str, str]:
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": COPILOT_USER_AGENT,
    }


def request_device_code(host: str = GITHUB_HOST, *, timeout: float = 10.0) -> Dict:
    """启动设备流程。返回 GitHub 的
    ``{device_code, user_code, verification_uri, expires_in, interval}``。
    """
    r = httpx.post(
        device_code_url(host),
        headers=_oauth_post_headers(),
        json={"client_id": COPILOT_CLIENT_ID, "scope": COPILOT_SCOPE},
        timeout=timeout,
    )
    r.raise_for_status()
    return r.json()


def poll_access_token(host: str, device_code: str, *, timeout: float = 10.0) -> Dict:
    """轮询一次 access token。GitHub 在用户尚未授权时返回 HTTP 200，
    带有 ``error`` 字段（``authorization_pending``/``slow_down``），
    或在用户授权后返回 ``{access_token, ...}``。
    """
    r = httpx.post(
        access_token_url(host),
        headers=_oauth_post_headers(),
        json={
            "client_id": COPILOT_CLIENT_ID,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        },
        timeout=timeout,
    )
    r.raise_for_status()
    return r.json()


def fetch_models(base: str, token: str, *, timeout: float = 15.0) -> List[Dict]:
    """获取 Copilot 的模型目录，过滤为选择器启用的模型。

    返回 ``{id, tool_calls, vision}`` 字典列表。如果没有模型声明
    full list if no model advertises ``model_picker_enabled`` (defensive
    against API-shape drift).
    """
    url = base.rstrip("/") + "/models"
    r = httpx.get(url, headers=copilot_headers(token), timeout=timeout)
    r.raise_for_status()
    data = (r.json() or {}).get("data") or []

    def _parse(item: Dict) -> Optional[Dict]:
        mid = item.get("id")
        if not mid:
            return None
        supports = ((item.get("capabilities") or {}).get("supports")) or {}
        return {
            "id": mid,
            "tool_calls": bool(supports.get("tool_calls")),
            "vision": bool(supports.get("vision")),
            "picker": bool(item.get("model_picker_enabled")),
        }

    parsed = [p for p in (_parse(it) for it in data) if p]
    picker = [p for p in parsed if p["picker"]]
    chosen = picker or parsed
    for p in chosen:
        p.pop("picker", None)
    return chosen


# ---------------------------------------------------------------------------
# 每次请求的头部标志
# ---------------------------------------------------------------------------

_IMAGE_PART_TYPES = ("image_url", "input_image", "image")


def request_flags(messages) -> tuple:
    """从 OpenAI 风格的消息列表中推导 ``(agent, vision)``。

    镜像 opencode 的逻辑：
      * ``agent`` — 最后一条消息*不*是普通用户消息（即它是
        工具结果 / 助手后续操作），因此 Copilot 应将请求视为
        agent 发起的以进行请求计费。
      * ``vision`` — 任何消息包含图片内容部分。
    """
    msgs = messages or []
    last = msgs[-1] if msgs else None
    agent = bool(last) and last.get("role") != "user"
    vision = False
    for m in msgs:
        content = m.get("content") if isinstance(m, dict) else None
        if isinstance(content, list) and any(
            isinstance(p, dict) and p.get("type") in _IMAGE_PART_TYPES for p in content
        ):
            vision = True
            break
    return agent, vision


def apply_request_headers(headers: Dict[str, str], messages) -> Dict[str, str]:
    """根据输出消息在头部字典上设置 ``x-initiator`` / ``Copilot-Vision-Request``。
    修改并返回 ``headers``。"""
    agent, vision = request_flags(messages)
    headers["x-initiator"] = "agent" if agent else "user"
    if vision:
        headers["Copilot-Vision-Request"] = "true"
    return headers

