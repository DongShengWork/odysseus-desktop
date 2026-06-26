"""对暴露给非管理员/未认证调用者的设置进行密钥脱敏。

刻意保持依赖精简（仅标准库），并与
``routes/auth_routes.py`` 分离，以便可以独立导入和单元测试，
而无需引入 FastAPI 应用/认证/数据库的导入链。

``/api/auth/settings`` 免认证——前端（和登录前页面）
读取它来获取快捷键 + TTS 偏好，因此非管理员和未认证调用者会收到
*脱敏后* 的副本。密钥（服务商 API key、IMAP/SMTP 密码、OAuth token）
必须不能泄露给他们——当应用通过 Cloudflare
隧道/反向代理对外可达时，这一点至关重要。脱敏是深度的（递归嵌套的 dict/list），并基于
密钥形态的名称进行匹配。
"""

import re

_SECRET_KEY_PATTERNS = (
    "_api_key", "_apikey", "_password", "_passwd", "_pass", "_pwd",
    "_secret", "_client_secret", "_token", "_access_token", "_refresh_token",
    "_credential", "_credentials", "_key",
)
_SECRET_KEY_ALLOW = ("google_pse_cx",)  # public identifiers, not secrets
_SENSITIVE_KEY_EXACT = (
    # A stable global integration id is a capability handle for routes that can
    # trigger outbound Webhook sends; do not expose it to non-admin settings
    # callers even though it is not secret-shaped.
    "reminder_webhook_integration_id",
)


def _canonical_key_name(name: str) -> str:
    """Normalize common JS-style key names so secret matching is style-agnostic."""
    n = (name or "").replace("-", "_")
    n = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", n)
    n = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", n)
    return n.lower()


def is_secret_key(name: str) -> bool:
    n = _canonical_key_name(name)
    if n in _SECRET_KEY_ALLOW:
        return False
    if n in _SENSITIVE_KEY_EXACT:
        return True
    return any(n.endswith(p) or n == p.lstrip("_") for p in _SECRET_KEY_PATTERNS)


def _scrub_value(key, value):
    """遮罩密钥形态的叶子值，递归进入嵌套的 dict/list，以确保
    存储在非密钥父键下的密钥（例如
    ``{"email_account": {"smtp_password": "..."}}``）仍然被清空。仅
    清空非空的*字符串*值；保留存在性。"""
    if isinstance(value, dict):
        return {
            k: ("" if (is_secret_key(k) and isinstance(v, str) and v)
                else _scrub_value(k, v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_scrub_value(key, item) for item in value]
    if is_secret_key(key) and isinstance(value, str) and value:
        return ""
    return value


def scrub_settings(settings: dict) -> dict:
    """返回 ``settings`` 的副本，其中密钥形态的值已被遮罩（深度）。"""
    if not isinstance(settings, dict):
        return {}
    return {k: _scrub_value(k, v) for k, v in (settings or {}).items()}
