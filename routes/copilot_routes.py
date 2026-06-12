# routes/copilot_routes.py
"""GitHub Copilot 设备流登录。

驱动 GitHub OAuth *设备流*，成功后创建（或刷新）
一个按 owner 限定的 ``ModelEndpoint`` 指向 Copilot API，
设备流访问令牌存储为其（加密的）``api_key``。之后该
端点行为与其他 OpenAI 兼容供应商相同 — Copilot
特定的请求头由 ``build_headers`` /
``_provider_headers`` 集中注入（见 :mod:`src.copilot`）。

流程：
  1. ``POST /api/copilot/device/start`` → 返回 ``poll_id`` 以及
     要展示给用户的 ``user_code`` + ``verification_uri``。密钥
     ``device_code`` 保留在服务端，从不发给浏览器。
  2. 浏览器用 ``poll_id`` 轮询 ``POST /api/copilot/device/poll``。
     等待中返回 ``{status: "pending"}``；一旦用户授权
     配置端点并返回 ``{status: "authorized", ...}``。

所有路由都需要管理员权限（端点/提供商管理是管理员操作）。
"""

import json
import uuid
import logging
from typing import Dict, Optional

import httpx
from fastapi import HTTPException, Request

from core.database import SessionLocal, ModelEndpoint
from routes.device_flow import (
    DeviceFlowPoll,
    DeviceFlowStart,
    PendingDeviceFlowStore,
    create_device_flow_router,
)
from src.auth_helpers import get_current_user
from src import copilot

logger = logging.getLogger(__name__)

_DEVICE_FLOW_STORE = PendingDeviceFlowStore()


def _provision_endpoint(token: str, base: str, owner: Optional[str]) -> Dict:
    """Create or update the owner's Copilot endpoint with a fresh token."""
    try:
        models = copilot.fetch_models(base, token)
    except Exception as e:
        logger.warning(f"Copilot model fetch failed during provisioning: {e}")
        models = []
    model_ids = [m["id"] for m in models]
    # Copilot 选择器模型支持 OpenAI 风格的工具调用；将端点标记为
    # 工具兼容，使 agent 循环发送原生工具 schema。
    # 任一选择器模型声明 tool_calls 则工具兼容。当模型
    # 获取失败（空列表）时默认为 True，因为 Copilot 选择器模型
    # 支持 OpenAI 风格的工具调用。
    supports_tools = bool(not models or any(m.get("tool_calls") for m in models))

    db = SessionLocal()
    try:
        ep = (
            db.query(ModelEndpoint)
            .filter(ModelEndpoint.base_url == base)
            .filter((ModelEndpoint.owner.is_(None)) | (ModelEndpoint.owner == owner))
            .order_by(ModelEndpoint.owner.desc())
            .first()
        )
        if ep is None:
            ep = ModelEndpoint(
                id=str(uuid.uuid4())[:8],
                name="GitHub Copilot",
                base_url=base,
                model_type="llm",
                owner=owner,
            )
            db.add(ep)
        ep.api_key = token
        ep.is_enabled = True
        ep.supports_tools = supports_tools
        if model_ids:
            ep.cached_models = json.dumps(model_ids)
        db.commit()
        result = {
            "id": ep.id,
            "name": ep.name,
            "base_url": ep.base_url,
            "models": model_ids,
        }
    finally:
        db.close()

    # 尽力刷新模型缓存，使新端点显示出来。
    try:
        from routes.model_routes import _invalidate_models_cache
        _invalidate_models_cache()
    except Exception:
        pass
    return result


def _start_device_flow(request: Request, form) -> DeviceFlowStart:
    host = copilot.GITHUB_HOST
    ent = str(form.get("enterprise_url") or "").strip()
    if ent:
        host = copilot.normalize_domain(ent)
    try:
        data = copilot.request_device_code(host)
    except httpx.HTTPStatusError as e:
        status = e.response.status_code if e.response is not None else "unknown"
        raise HTTPException(502, f"GitHub device-code request failed (HTTP {status})")
    except Exception as e:
        raise HTTPException(502, f"GitHub device-code request failed: {e}")

    device_code = data.get("device_code")
    if not device_code:
        raise HTTPException(502, "GitHub did not return a device code")

    # verification_uri_complete 嵌入了用户码，因此打开的浏览器标签页
    # open lands the user straight on GitHub's "Authorize" screen with the
    # 代码已预填 — 一键完成，无需手动输入代码。
    return DeviceFlowStart(
        pending={
            "device_code": device_code,
            "host": host,
            "enterprise_url": ent,
            "owner": get_current_user(request) or None,
        },
        response={
            "user_code": data.get("user_code"),
            "verification_uri": data.get("verification_uri"),
            "verification_uri_complete": data.get("verification_uri_complete"),
        },
        interval=int(data.get("interval") or 5),
        expires_in=int(data.get("expires_in") or 900),
    )


def _poll_device_flow(_request: Request, pending: Dict) -> DeviceFlowPoll:
    try:
        data = copilot.poll_access_token(pending["host"], pending["device_code"])
    except Exception as e:
        return DeviceFlowPoll.pending(f"poll error: {e}")

    token = data.get("access_token")
    if token:
        base = copilot.enterprise_base(pending["enterprise_url"]) if pending["enterprise_url"] else copilot.COPILOT_BASE
        try:
            result = _provision_endpoint(token, base, pending["owner"])
        except Exception as e:
            logger.exception("Copilot endpoint provisioning failed")
            raise HTTPException(500, f"Login succeeded but provisioning failed: {e}")
        return DeviceFlowPoll.authorized(result)

    err = data.get("error")
    if err == "authorization_pending":
        return DeviceFlowPoll.pending()
    if err == "slow_down":
        return DeviceFlowPoll.slow_down(int(data.get("interval") or 0) or None)
    if err in ("expired_token", "access_denied"):
        return DeviceFlowPoll.failed(err)
    # 未知错误 — 显示出来但保留会话供再次尝试。
    return DeviceFlowPoll.pending(err or "unknown")


def setup_copilot_routes():
    return create_device_flow_router(
        prefix="/api/copilot",
        tags=["copilot"],
        store=_DEVICE_FLOW_STORE,
        start_flow=_start_device_flow,
        poll_flow=_poll_device_flow,
    )
