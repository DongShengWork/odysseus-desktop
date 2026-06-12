# routes/compare_routes.py
"""模型 A/B 对比路由。"""
import json
import uuid
import random
from datetime import datetime
from fastapi import APIRouter, Form, HTTPException, Request
from typing import List
from pydantic import BaseModel
import logging

from core.database import Comparison, SessionLocal
from core.session_manager import SessionManager
from src.auth_helpers import get_current_user
from routes.session_routes import _reject_raw_endpoint_url_for_non_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/compare", tags=["compare"])


def _owned_endpoint_by_url(db, base_url, owner):
    """base_url == `base_url` 且对 `owner` 可见（自己的行 + 历史空 owner 的"共享"行）的 ModelEndpoint；否则为 None。

    有意按 owner 限定范围。ModelEndpoint 是每个用户私有的（core/database.py：非空
    owner = 私有，"模型选择器只对该用户显示该 endpoint"），
    且持有解密后的 `api_key`。start_comparison 会将匹配行的 api_key
    复制到调用者拥有的 [CMP] 会话的 headers 中，然后该 headers 会驱动对应会话的
    /api/chat_stream 调用 — 因此如果 base_url 匹配不做 owner 限定，
    调用者就能创建一个绑定到其他用户私有 endpoint 的对比，
    并消耗该 owner 的 api_key / 访问该 owner 配置的任意 base_url。镜像
    session_routes._owned_endpoint。空 owner 视为无操作（单用户/历史模式）。
    """
    from core.database import ModelEndpoint
    from src.auth_helpers import owner_filter
    q = db.query(ModelEndpoint).filter(ModelEndpoint.base_url == base_url)
    return owner_filter(q, ModelEndpoint, owner).first()


def _owned_endpoint_by_id(db, endpoint_id, owner):
    """id == `endpoint_id` 且对 `owner` 可见（自己的行 + 历史空 owner 的"共享"行）的 ModelEndpoint；否则为 None。

    凭证解析优先于 _owned_endpoint_by_url：两个可见的 endpoint 可能共享相同的 base_url
    但持有不同的 api_key（例如同一服务商的不同账号）。仅按 base_url 匹配会返回排序最先的
    行，因此可能将错误的 owner 限定 key 复制到 [CMP] 会话中。id 可以精确指定已注册的
    endpoint，因此 /api/compare/start 优先采用它，仅在历史/管理员原始 URL 调用时才回退到
    URL 匹配。Owner 限定逻辑与 _owned_endpoint_by_url 相同（空 owner 视为无操作）。
    """
    from core.database import ModelEndpoint
    from src.auth_helpers import owner_filter
    q = db.query(ModelEndpoint).filter(ModelEndpoint.id == endpoint_id)
    return owner_filter(q, ModelEndpoint, owner).first()


class RecordVoteRequest(BaseModel):
    prompt: str
    models: List[str]
    winner: str           # 模型名称或 "tie"
    is_blind: bool = True


def setup_compare_routes(session_manager: SessionManager):
    """设置对比路由。"""

    @router.post("/start")
    def start_comparison(
        request: Request,
        prompt: str = Form(...),
        model_a: str = Form(...),
        model_b: str = Form(...),
        endpoint_a: str = Form(""),
        endpoint_b: str = Form(""),
        endpoint_a_id: str = Form(""),
        endpoint_b_id: str = Form(""),
        is_blind: str = Form("true"),
    ):
        """创建两个临时会话和一个对比记录。

        返回对比 ID 和两个会话 ID，客户端可以据此发起两个独立的 SSE 流到 /api/chat_stream。
        """
        user = getattr(request.state, 'current_user', None)
        comp_id = str(uuid.uuid4())
        sid_a = str(uuid.uuid4())
        sid_b = str(uuid.uuid4())

        # 盲测映射：随机分配左/右
        blind = str(is_blind).lower() == "true"
        if blind:
            mapping = {"left": "a", "right": "b"}
            if random.random() > 0.5:
                mapping = {"left": "b", "right": "a"}
        else:
            mapping = {"left": "a", "right": "b"}

        # 基于盲测映射将会话 ID 映射到左/右
        session_left = sid_a if mapping["left"] == "a" else sid_b
        session_right = sid_a if mapping["right"] == "a" else sid_b

        # 在盲测模式下，用中性槽位名（"Model A" / "Model B"）而非真实模型名
        # 命名辅助会话。否则会话名会在侧边栏和 GET /api/sessions 中泄露模型，
        # 在用户投票前将对比去匿名化（issue #1285）。
        slot_name = {session_left: "Model A", session_right: "Model B"}

        # 安全：在创建任何会话之前，先解析并验证 BOTH 个 endpoint。
        # Compare 会将已注册 endpoint 的 Authorization header 复制到 [CMP] 会话中，
        # 所以如果在创建一个 endpoint 的会话之后才拒绝另一个，
        # 会留下一个携带该 header 的不完整对比会话。
        # 在开头完成所有 owner 限定解析和原始 URL 拒绝，意味着
        # 任意一个 endpoint 的 403 都会中止整个请求，不会创建任何内容，也不会复制任何 header。
        from src.endpoint_resolver import build_chat_url, build_headers, normalize_base
        resolved = []
        db = SessionLocal()
        try:
            for sid, model, endpoint, endpoint_id in [
                (sid_a, model_a, endpoint_a, endpoint_a_id),
                (sid_b, model_b, endpoint_b, endpoint_b_id),
            ]:
                # 优先使用显式的 endpoint id：它可以精确指定已注册的
                # endpoint（及其 api_key），即使调用者可见的两个 endpoint
                # 共享相同的 base_url 但持有不同的 key —— 仅 URL 匹配
                # 会返回排序最先的行，即可能是错误的 key。
                # 仅限于历史/管理员原始 URL 调用者（不传 id 的）才会回退到 URL 匹配。
                eid = endpoint_id.strip() if isinstance(endpoint_id, str) else ""
                if eid:
                    ep = _owned_endpoint_by_id(db, eid, user)
                    if ep is None:
                        # 调用者看不到的 id（错误的 owner / 已删除）必须
                        # 不能静默回退到相同 URL 但持有不同 key 的行
                        # —— 这正是 id 机制要防止的混淆情况。
                        raise HTTPException(404, "Model endpoint not found")
                    # 该 id 已解析了 endpoint；忽略调用者也传入的原始 URL，
                    # 改用存储的配置进行拨号。
                    endpoint = ep.base_url
                elif not endpoint:
                    raise HTTPException(
                        422, "endpoint_a/endpoint_b or endpoint_a_id/endpoint_b_id is required"
                    )
                else:
                    # 将传入的 URL 解析为调用者拥有的 ModelEndpoint
                    # （自己的行 + 历史空 owner 的共享行），限定范围以防止
                    # 对比借用其他用户的私有 endpoint key。
                    base = normalize_base(endpoint)
                    ep = _owned_endpoint_by_url(db, base, user)
                # 拒绝已登录非管理员的*未注册*原始 URL；匹配到的已注册 endpoint
                # 提供 id，调用者仍然可以对比自己拥有的 endpoint。在此处做全量拒绝
                # 锁定了非管理员的对比功能，因为 compare 依赖 URL 解析 endpoint 而无
                # endpoint_id。镜像 gallery 的 inpaint/harmonize 检查。
                # 在此处（阶段 1，会话创建之前）触发错误。
                _reject_raw_endpoint_url_for_non_admin(
                    request, user, str(ep.id) if ep is not None else None, endpoint
                )
                # 将 [CMP] 会话绑定到已解析的 endpoint，而非调用者传入的原始字符串。
                # 当 URL 匹配到调用者可用的已注册 endpoint 时，使用该行自己的标准化
                # base URL（与 owner 限定的 endpoint 验证相同的值）以便会话精确地拨号到
                # 存储的配置所指向的位置。原始 `endpoint` 仅对允许传入原始 URL 的
                # 调用者有效 — 管理员 / 单用户模式，此时
                # `_reject_raw_endpoint_url_for_non_admin` 为无操作且 `ep` 为 None。
                # 镜像 session_routes 中已注册 endpoint 的处理路径。
                session_endpoint_url = (
                    build_chat_url(normalize_base(ep.base_url)) if ep is not None else endpoint
                )
                # Headers 仅来自匹配到的 endpoint 的 key；当
                # `ep` 为 None（管理员原始 URL 或无匹配）时为 None，因此对比
                # 绝不会继承其他用户的 key/headers。
                headers = build_headers(ep.api_key, ep.base_url) if (ep and ep.api_key) else None
                resolved.append((sid, model, session_endpoint_url, headers))
        finally:
            db.close()

        # 两个 endpoint 均已验证 — 现在才创建临时 [CMP]
        # 会话并复制已解析的 headers。
        for sid, model, session_endpoint_url, headers in resolved:
            name = f"[CMP] {slot_name[sid]}" if blind else f"[CMP] {model.split('/')[-1]}"
            session_manager.create_session(
                session_id=sid,
                name=name,
                endpoint_url=session_endpoint_url,
                model=model,
                rag=False,
                owner=user,
            )
            if headers:
                s = session_manager.sessions.get(sid)
                if s:
                    s.headers = headers

        # 存储对比记录
        db = SessionLocal()
        try:
            comp = Comparison(
                id=comp_id,
                prompt=prompt,
                model_a=model_a,
                model_b=model_b,
                # 记录会话实际拨号的 URL。对于 URL 调用者，这是他们的原始输入；
                # 对于只传 id 的调用者（endpoint_a/_b 为空），
                # 回退到已解析的 endpoint URL，以确保该列有实际意义且非空。
                # resolved 的顺序为 [a, b]。
                endpoint_a=endpoint_a or resolved[0][2],
                endpoint_b=endpoint_b or resolved[1][2],
                is_blind=blind,
                blind_mapping=json.dumps(mapping),
                owner=user,
            )
            db.add(comp)
            db.commit()
        finally:
            db.close()

        # 在盲测模式下，不在响应中返回模型标识和左/右
        # 映射。客户端已经知道 model_a/model_b（它自己传的），
        # 所以返回任意一个都会破坏盲测模式。这些信息会在
        # 用户投票后通过 POST /api/compare/{id}/vote 揭示 (#1285)。
        return {
            "id": comp_id,
            "session_left": session_left,
            "session_right": session_right,
            "model_left": None if blind else (model_a if mapping["left"] == "a" else model_b),
            "model_right": None if blind else (model_a if mapping["right"] == "a" else model_b),
            "is_blind": blind,
            "mapping": None if blind else mapping,
        }

    @router.post("/{comp_id}/vote")
    def vote_comparison(
        request: Request,
        comp_id: str,
        winner: str = Form(...),  # "left"、"right" 或 "tie"
    ):
        """记录用户的投票，如果是盲测模式则揭示模型名称。"""
        user = get_current_user(request)
        db = SessionLocal()
        try:
            comp = db.query(Comparison).filter(Comparison.id == comp_id).first()
            if not comp:
                raise HTTPException(404, "Comparison not found")
            # 安全：严格的 ownership 检查 — 空 owner 的 Comparison 之前
            # 对所有用户都可见。
            if user and comp.owner != user:
                raise HTTPException(404, "Comparison not found")
            if comp.winner:
                raise HTTPException(400, "Already voted")

            mapping = json.loads(comp.blind_mapping) if comp.blind_mapping else {"left": "a", "right": "b"}

            if winner == "tie":
                comp.winner = "tie"
            elif winner == "left":
                comp.winner = mapping["left"]
            elif winner == "right":
                comp.winner = mapping["right"]
            else:
                raise HTTPException(400, "winner must be 'left', 'right', or 'tie'")

            comp.voted_at = datetime.utcnow()
            db.commit()

            return {
                "winner": comp.winner,
                "model_a": comp.model_a,
                "model_b": comp.model_b,
                "revealed": {
                    "left": comp.model_a if mapping["left"] == "a" else comp.model_b,
                    "right": comp.model_a if mapping["right"] == "a" else comp.model_b,
                },
            }
        finally:
            db.close()

    @router.post("/record")
    def record_comparison(request: Request, body: RecordVoteRequest):
        """从前端记录对比投票的轻量端点。"""
        user = get_current_user(request)
        comp_id = str(uuid.uuid4())

        model_a = body.models[0] if len(body.models) > 0 else ""
        model_b = body.models[1] if len(body.models) > 1 else ""

        # 对于超过 2 个模型的情况，将完整列表以 JSON 存储在 blind_mapping 中
        if len(body.models) > 2:
            blind_mapping = json.dumps({"models": body.models})
        else:
            blind_mapping = None

        db = SessionLocal()
        try:
            comp = Comparison(
                id=comp_id,
                prompt=body.prompt[:500],
                model_a=model_a,
                model_b=model_b,
                endpoint_a="",
                endpoint_b="",
                winner=body.winner,
                is_blind=body.is_blind,
                blind_mapping=blind_mapping,
                voted_at=datetime.utcnow(),
                owner=user,
            )
            db.add(comp)
            db.commit()
        finally:
            db.close()

        return {"status": "ok", "id": comp_id}

    @router.get("/history")
    def list_comparisons(request: Request):
        """列出历史对比记录。"""
        user = get_current_user(request)
        db = SessionLocal()
        try:
            q = db.query(Comparison)
            if user:
                q = q.filter(Comparison.owner == user)
            comps = q.order_by(Comparison.created_at.desc()).limit(50).all()
            return [
                {
                    "id": c.id,
                    "prompt": c.prompt[:100],
                    "model_a": c.model_a,
                    "model_b": c.model_b,
                    "winner": c.winner,
                    "is_blind": c.is_blind,
                    "voted_at": c.voted_at.isoformat() if c.voted_at else None,
                    "created_at": c.created_at.isoformat() if c.created_at else None,
                }
                for c in comps
            ]
        finally:
            db.close()

    @router.delete("/{comp_id}")
    def delete_comparison(request: Request, comp_id: str):
        """删除对比及其临时会话。"""
        user = get_current_user(request)
        db = SessionLocal()
        try:
            comp = db.query(Comparison).filter(Comparison.id == comp_id).first()
            if not comp:
                raise HTTPException(404, "Comparison not found")
            # 安全：严格的 ownership 检查 — 空 owner 的 Comparison 之前
            # 对所有用户都可见。
            if user and comp.owner != user:
                raise HTTPException(404, "Comparison not found")
            db.delete(comp)
            db.commit()
            return {"status": "deleted"}
        finally:
            db.close()

    return router
