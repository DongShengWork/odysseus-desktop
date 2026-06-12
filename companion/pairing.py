"""Companion 桥接的共享配对辅助函数。

令牌生成 + LAN 发现 + QR 渲染，在此作为小型可导入
单元保持，使路由层保持简洁且逻辑可直接测试。
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import uuid

import bcrypt

from src.constants import AUTH_FILE

PAIRING_VERSION = 1
COMPANION_SCOPE = "chat"


def default_port() -> int:
    """对服务器可访问端口的最佳猜测。知道真实请求端口的调用方
    应显式传入它。"""
    try:
        return int(os.environ.get("APP_PORT", "7000"))
    except ValueError:
        return 7000


def lan_ip_candidates() -> list[str]:
    """此主机可能的 LAN IPv4 地址，最佳候选项在前。

    UDP-connect 技巧揭示了操作系统用于到达默认网关的出口接口，
    即同一 Wi-Fi 上的手机应连接到的地址。实际上不发送任何数据包。
    回环地址被排除。
    """
    candidates: list[str] = []

    def _add(ip):
        if ip and ip not in candidates and not ip.startswith("127."):
            candidates.append(ip)

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        _add(s.getsockname()[0])
    except OSError:
        pass
    finally:
        s.close()

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            _add(info[4][0])
    except OSError:
        pass

    return candidates


def find_admin_user() -> str | None:
    """从 data/auth.json 中解析管理员用户名（schema 使用 is_admin），
    回退到第一个用户。"""
    auth_path = AUTH_FILE
    try:
        with open(auth_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    users = data.get("users") or {}
    if not isinstance(users, dict):
        return None
    for uname, udata in users.items():
        if isinstance(udata, dict) and udata.get("is_admin") is True:
            return uname
    return next(iter(users), None)


def mint_token(owner: str, name: str = "companion") -> tuple[str, str]:
    """创建一个聊天作用域的 API 令牌行，返回 (token_id, raw_token)。

    raw_token 仅返回一次 — 仅持久化其 bcrypt 哈希 + 8 字符前缀。
    与 routes/api_token_routes.py 保持一致，因此 cookie 和
    companion 生成的令牌对认证中间件不可区分。
    """
    from core.database import get_db_session, ApiToken

    raw_token = "ody_" + secrets.token_urlsafe(32)
    token_hash = bcrypt.hashpw(raw_token.encode(), bcrypt.gensalt()).decode()
    token_id = str(uuid.uuid4())[:8]

    with get_db_session() as db:
        db.add(ApiToken(
            id=token_id,
            owner=owner,
            name=name,
            token_hash=token_hash,
            token_prefix=raw_token[:8],
            scopes=COMPANION_SCOPE,
            is_active=True,
        ))
    return token_id, raw_token


def pairing_payload(host: str, port: int, token: str) -> dict:
    """客户端扫描/接受的精确 JSON。保持键名稳定。"""
    return {"v": PAIRING_VERSION, "host": host, "port": port, "token": token}


def pairing_qr_png_data_uri(payload: dict) -> str | None:
    """将配对负载渲染为 QR `data:` URI 用于 <img>。如果可选的
    qrcode 依赖不可用则返回 None。"""
    try:
        import base64
        import io

        import qrcode

        img = qrcode.make(json.dumps(payload, separators=(",", ":")))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None
