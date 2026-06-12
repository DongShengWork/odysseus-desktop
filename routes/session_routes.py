# routes/session_routes.py
import re
import html
import json
import uuid
from datetime import datetime
from fastapi import APIRouter, Form, HTTPException, Response, Request
import logging

from core.session_manager import SessionManager
from core.models import ChatMessage
from src.request_models import SessionResponse
from core.database import Session as DbSession, SessionLocal, Document, GalleryImage, utcnow_naive
from src.auth_helpers import get_current_user, effective_user, _auth_disabled
from src.session_actions import is_session_recently_active


def _sanitize_export_filename(name: str) -> str:
    """返回一个安全的导出文件名，适用于 Content-Disposition 头。"""
    name = name if isinstance(name, str) else ""
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    return name[:128]


# 盲比辅助会话使用此前缀名称创建。其真实模型
# 绝不能出现在会话列表/侧边栏中 — 否则盲比会在用户
# 投票之前被去匿名化（issue #1285）。
COMPARE_SESSION_PREFIX = "[CMP] "


def _public_model(name: str, model: str) -> str:
    """隐藏盲比辅助会话的真实模型，使会话列表无法用于
    将中性面板标签（"Model A"）映射回其模型。Compare UI 在客户端
    跟踪模型，所以在此隐藏不会对侧边栏造成任何损失。参见 issue #1285。"""
    if (name or "").startswith(COMPARE_SESSION_PREFIX):
        return ""
    return model


def _content_to_text(content) -> str:
    """将消息的 content 展平为纯文本，用于基于文本的导出。

    历史记录条目有三种形式：纯字符串、多模态内容块列表
    （vision/image 附件），或 None（仅持久化了原生 tool_calls 的
    assistant 轮次）。txt/html/md 导出器对这些值进行 join 和
    字符串处理，因此列表会导致导出崩溃（join 时 TypeError，
    .replace 时 AttributeError），而 None 会渲染为字面量 "None"。
    强制转换为文本块，对无文本的内容返回 ""。
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("text")
        )
    return ""


def _message_role(message) -> str:
    if isinstance(message, ChatMessage):
        return message.role or ""
    if isinstance(message, dict):
        return message.get("role", "") or ""
    return getattr(message, "role", "") or ""


def _message_text(message) -> str:
    if isinstance(message, ChatMessage):
        content = message.content
    elif isinstance(message, dict):
        content = message.get("content")
    else:
        content = getattr(message, "content", None)
    return _content_to_text(content)


def _message_metadata(message) -> dict:
    if isinstance(message, ChatMessage):
        metadata = message.metadata
    elif isinstance(message, dict):
        metadata = message.get("metadata")
    else:
        metadata = getattr(message, "metadata", None)
    return metadata if isinstance(metadata, dict) else {}


def _reject_compact_during_active_run(session_id: str) -> None:
    from src import agent_runs
    if agent_runs.is_active(session_id):
        raise HTTPException(409, "Session has an active run; try compacting after it finishes")


def _verify_session_owner(request: Request, session_id: str, session_manager=None):
    """验证当前用户拥有该会话，并适配单用户模式。

    认证请求必须匹配存储的 DB 或内存中的所有者。当认证禁用
    且没有用户时，将应用视为单用户模式：验证会话存在，
    但不比较其存储的所有者。这使得 AUTH_ENABLED=false 的
    QA/开发实例不会拒绝之前在认证启用时创建的
    被所有者标记的行。
    """
    user = effective_user(request)
    if not user and not _auth_disabled():
        raise HTTPException(401, "Authentication required")
    db = SessionLocal()
    try:
        row = db.query(DbSession.owner).filter(DbSession.id == session_id).first()
    finally:
        db.close()
    if row is not None:
        if user and row.owner != user:
            raise HTTPException(404, f"Session {session_id} not found")
        return
    # 无数据库行 — 允许调用方操作其拥有的内存中的幽灵会话。
    if session_manager is not None:
        ghost = getattr(session_manager, "sessions", {}).get(session_id)
        if ghost is not None and (not user or getattr(ghost, "owner", None) == user):
            return
    raise HTTPException(404, f"Session {session_id} not found")

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["sessions"])

def _current_user_is_admin(request: Request, user: str | None) -> bool:
    if not user:
        return False
    auth_mgr = getattr(request.app.state, "auth_manager", None)
    is_admin = getattr(auth_mgr, "is_admin", None)
    if not callable(is_admin):
        return False
    try:
        return bool(is_admin(user))
    except Exception:
        return False


def _reject_raw_endpoint_url_for_non_admin(
    request: Request,
    user: str | None,
    endpoint_id: str | None,
    endpoint_url: str | None,
) -> None:
    """要求非管理员用户在更改会话时使用已注册的端点。"""
    if endpoint_id and endpoint_id.strip():
        return
    if not endpoint_url:
        return
    # 原始 URL 使服务器连接请求中提供的任意主机。对于
    # 非管理员用户，需要已保存的端点行，以确保正常的所有者作用域和
    # 端点验证已经完成。
    if user and not _current_user_is_admin(request, user):
        raise HTTPException(403, "Choose a registered model endpoint")


def _persist_session_headers(session_id: str, headers: dict | None) -> None:
    """为基于 DB 的会话元数据持久化端点认证头。"""
    db = SessionLocal()
    try:
        db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
        if db_session:
            db_session.headers = headers or {}
            db_session.updated_at = datetime.utcnow()
            db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


_HIDDEN_SYSTEM_SESSION_NAMES = {
    "[Task] Chat Sessions Tidy",
    "[Task] Documents Tidy",
    "[Task] Memory Tidy",
    "[Task] Research Tidy",
    "[Task] Email Mark Boundaries",
    "[Task] Email Tags",
    "[Task] Skills Audit",
}


def _pick_endpoint_for_sort(owner=None):
    """为自动排序 LLM 调用选择模型端点 — 使用工具端点设置，回退到默认端点。"""
    from src.endpoint_resolver import resolve_endpoint
    # 首先尝试工具端点（用户为后台任务配置的）
    url, model, headers = resolve_endpoint("utility", owner=owner)
    if url and model:
        return url, model, headers
    # 回退到任务端点
    try:
        from src.task_endpoint import resolve_task_endpoint
        url, model, headers = resolve_task_endpoint(owner=owner)
        if url and model:
            return url, model, headers
    except Exception:
        pass
    # 回退到默认端点
    url, model, headers = resolve_endpoint("default", owner=owner)
    if url and model:
        return url, model, headers
    return None, None, None

def setup_session_routes(session_manager: SessionManager, config: dict, webhook_manager=None):
    """使用提供的管理器设置会话路由和配置"""

    REQUEST_TIMEOUT = config.get("REQUEST_TIMEOUT", 20)
    OPENAI_API_KEY = config.get("OPENAI_API_KEY")
    SESSIONS_FILE = config.get("SESSIONS_FILE")
    
    @router.get("/sessions")
    def list_sessions(request: Request):
        user = effective_user(request)
        # 延迟清除：匿名会话按设计是临时的 — 清除数据库中
        # 和 session_manager 中的残留项，以便在下次页面刷新时消失。
        # 但是：跳过最近 10 分钟内创建的会话。
        # 如果没有此保护，清除操作会在首次 /api/sessions 调用时
        # 就删除刚创建的活跃 "Nobody" 会话，从而破坏正在进行的
        # 聊天。前端的 _cleanupIncognitoSessions 处理器知道哪个
        # 会话是当前会话，不会删除活跃会话 — 此服务器端清除
        # 仅用于捕获前端遗漏的残留会话（标签页关闭、崩溃）。
        # 只清除足够旧、确定是孤立会话的行。
        try:
            from datetime import datetime as _dt, timedelta as _td
            _cutoff = _dt.utcnow() - _td(minutes=10)
            _purge_db = SessionLocal()
            try:
                from core.database import ChatMessage as _DbMsg
                _ghosts = _purge_db.query(DbSession).filter(
                    DbSession.name.in_(("Nobody", "Incognito")),
                    DbSession.created_at < _cutoff,
                ).all()
                for _g in _ghosts:
                    _purge_db.query(_DbMsg).filter(_DbMsg.session_id == _g.id).delete()
                    _purge_db.delete(_g)
                    if hasattr(session_manager, "delete_session"):
                        try:
                            session_manager.delete_session(_g.id)
                        except Exception:
                            pass
                if _ghosts:
                    _purge_db.commit()
            finally:
                _purge_db.close()
        except Exception:
            pass
        user_sessions = session_manager.get_sessions_for_user(user)
        # 从数据库中获取每个会话的文件夹信息
        db = SessionLocal()
        try:
            folder_map = {}
            token_map = {}
            important_map = {}
            created_map = {}
            updated_map = {}
            last_msg_map = {}
            mode_map = {}
            msg_count_map = {}
            rows = db.query(DbSession.id, DbSession.folder, DbSession.total_input_tokens, DbSession.total_output_tokens, DbSession.is_important, DbSession.created_at, DbSession.updated_at, DbSession.last_message_at, DbSession.mode, DbSession.message_count).filter(DbSession.archived == False, DbSession.owner == user).all()
            for row in rows:
                folder_map[row.id] = row.folder
                token_map[row.id] = (row.total_input_tokens or 0) + (row.total_output_tokens or 0)
                important_map[row.id] = row.is_important or False
                created_map[row.id] = row.created_at.isoformat() if row.created_at else None
                updated_map[row.id] = row.updated_at.isoformat() if row.updated_at else None
                # 回退到 updated_at，再回退到 created_at，使早于
                # 该列（或无消息）的会话仍然能合理排序。
                last_msg_map[row.id] = (
                    row.last_message_at.isoformat() if row.last_message_at
                    else (row.updated_at.isoformat() if row.updated_at
                          else (row.created_at.isoformat() if row.created_at else None))
                )
                mode_map[row.id] = row.mode
                msg_count_map[row.id] = row.message_count or 0
            # 有活跃内容文档的会话
            from sqlalchemy import func
            doc_session_ids = set(
                r[0] for r in db.query(Document.session_id)
                .filter(Document.is_active == True,
                        Document.current_content != None,
                        func.trim(Document.current_content) != "",
                        Document.owner == user)
                .distinct().all()
            )
            img_session_ids = set(
                r[0] for r in db.query(GalleryImage.session_id)
                .filter(GalleryImage.session_id != None,
                        GalleryImage.owner == user)
                .distinct().all()
            )
        finally:
            db.close()

        sessions = [{"id": s.id, "name": s.name, "model": _public_model(s.name, s.model),
                     "endpoint_url": s.endpoint_url, "rag": s.rag,
                     "archived": s.archived, "folder": folder_map.get(s.id),
                     "total_tokens": token_map.get(s.id, 0),
                     "is_important": important_map.get(s.id, False),
                     "created_at": created_map.get(s.id),
                     "updated_at": updated_map.get(s.id),
                     "last_message_at": last_msg_map.get(s.id),
                     "has_documents": s.id in doc_session_ids,
                     "has_images": s.id in img_session_ids,
                     "mode": mode_map.get(s.id),
                     "message_count": msg_count_map.get(s.id, 0)}
                    for s in user_sessions.values()
                    if not s.archived
                    and (s.name or "").strip() not in ("Nobody", "Incognito")
                    and (s.name or "").strip() not in _HIDDEN_SYSTEM_SESSION_NAMES]

        return sessions
    
    @router.post("/session", response_model=SessionResponse)
    def create_session(
        request: Request,
        name: str = Form(""),
        endpoint_url: str = Form(""),
        model: str = Form(""),
        rag: str = Form(None),
        skip_validation: str = Form(None),
        api_key: str = Form(""),
        endpoint_id: str = Form(""),
    ):
        skip_val = str(skip_validation).lower() == "true"
        user = get_current_user(request)
        endpoint_api_key = ""
        endpoint_base_url = ""
        _reject_raw_endpoint_url_for_non_admin(request, user, endpoint_id, endpoint_url)
        if endpoint_id and endpoint_id.strip():
            from core.database import ModelEndpoint
            from src.auth_helpers import owner_filter
            from src.endpoint_resolver import build_chat_url, normalize_base
            _db = SessionLocal()
            try:
                q = _db.query(ModelEndpoint).filter(
                    ModelEndpoint.id == endpoint_id.strip(),
                    ModelEndpoint.is_enabled == True,
                )
                if user:
                    q = owner_filter(q, ModelEndpoint, user)
                endpoint_row = q.first()
                if not endpoint_row:
                    raise HTTPException(400, "Model endpoint no longer exists")
                endpoint_base_url = endpoint_row.base_url or ""
                endpoint_api_key = endpoint_row.api_key or ""
                endpoint_url = build_chat_url(normalize_base(endpoint_base_url))
            finally:
                _db.close()

        if not endpoint_url and not skip_val:
            raise HTTPException(400, "endpoint_url is required (choose from /api/models)")

        model_to_use = model
        request_api_key = api_key.strip() if api_key else ""
        effective_api_key = request_api_key or endpoint_api_key
        validation_headers = None
        if effective_api_key:
            from src.endpoint_resolver import build_headers
            validation_headers = build_headers(effective_api_key, endpoint_base_url or endpoint_url)

        if skip_val:
            # skip_validation = 信任调用方，不探测 /v1/models。
            # 用于自定义端点以及完全没有模型的裸占位会话
            # （例如邮件回复草稿只需要一个会话容器）。
            # 之前此处探测会因 "Cannot reach /v1/models" 而 400 报错。
            pass
        elif not model_to_use:
            from src.llm_core import list_model_ids
            ids = list_model_ids(
                endpoint_url,
                timeout=REQUEST_TIMEOUT,
                headers=validation_headers,
                owner=user,
                endpoint_id=endpoint_id.strip() if endpoint_id else None,
            )
            if not ids:
                raise HTTPException(400, "Cannot reach /v1/models")
            # 默认选择第一个 CHAT 模型 — 端点通常会先列出 embedding/
            # tts/whisper 模型（例如 text-embedding-ada-002），这些
            # 无法进行对话。
            _NON_CHAT = ("text-embedding", "embedding", "tts-", "whisper",
                         "text-moderation", "moderation-", "dall-e", "rerank")
            chat_ids = [m for m in ids if not any(p in m.lower() for p in _NON_CHAT)]
            model_to_use = (chat_ids or ids)[0]
        else:
            from src.llm_core import list_model_ids
            import os as _os
            req_base = _os.path.basename(model_to_use.rstrip("/"))
            avail = list_model_ids(
                endpoint_url,
                timeout=REQUEST_TIMEOUT,
                headers=validation_headers,
                owner=user,
                endpoint_id=endpoint_id.strip() if endpoint_id else None,
            )
            if not avail:
                raise HTTPException(400, "Cannot reach /v1/models")
            if model_to_use not in avail:
                found = None
                for a in avail:
                    if _os.path.basename(a.rstrip("/")) == req_base:
                        found = a
                        break
                if not found:
                    raise HTTPException(400,
                                        f"Model not found at server. Available: {', '.join(avail)}")
                model_to_use = found
        
        sid = str(uuid.uuid4())
        user = effective_user(request)
        session = session_manager.create_session(
            session_id=sid,
            name=name or "",
            endpoint_url=endpoint_url or "",
            model=model_to_use,
            rag=str(rag).lower() == "true" if rag else False,
            owner=user,
        )
        # 为自定义 API 密钥端点设置认证头
        resolved_key = request_api_key
        resolved_base = endpoint_url
        if not resolved_key and endpoint_api_key:
            resolved_key = endpoint_api_key
            resolved_base = endpoint_base_url
        if resolved_key:
            from src.endpoint_resolver import build_headers
            session.headers = build_headers(resolved_key, resolved_base)
            _persist_session_headers(sid, session.headers)
        # 触发 webhook（同步安全）
        if webhook_manager:
            webhook_manager.fire_and_forget("session.created", {
                "session_id": sid, "name": session.name, "model": model_to_use,
            })
        # 触发事件供自动化任务使用
        from src.event_bus import fire_event
        fire_event("session_created", user)
        return SessionResponse(
            id=sid,
            name=session.name,
            model=model_to_use,
            rag=str(rag).lower() == "true" if rag else False,
            archived=False
        )    
    @router.patch("/session/{sid}")
    def rename_session(
        request: Request, sid: str,
        name: str = Form(None), folder: str = Form(None),
        model: str = Form(None), endpoint_url: str = Form(None),
        endpoint_id: str = Form(None),
    ):
        _verify_session_owner(request, sid)
        try:
            session = session_manager.get_session(sid)
        except KeyError:
            raise HTTPException(404, f"Session {sid} not found")
        result = {"id": sid}
        if name is not None:
            session_manager.update_session_name(sid, name)
            result["name"] = name
        # 更新文件夹分配
        if folder is not None:
            db = SessionLocal()
            try:
                db_session = db.query(DbSession).filter(DbSession.id == sid).first()
                if db_session:
                    db_session.folder = folder if folder else None
                    db_session.updated_at = datetime.utcnow()
                    db.commit()
                    result["folder"] = folder if folder else None
            finally:
                db.close()
        # 会话中切换模型/端点
        if model is not None and endpoint_url is not None:
            user = get_current_user(request)
            _reject_raw_endpoint_url_for_non_admin(request, user, endpoint_id, endpoint_url)
            endpoint_api_key = ""
            endpoint_base_url = ""
            if endpoint_id:
                from core.database import ModelEndpoint
                from src.auth_helpers import owner_filter
                from src.endpoint_resolver import build_chat_url, normalize_base
                _db = SessionLocal()
                try:
                    q = _db.query(ModelEndpoint).filter(
                        ModelEndpoint.id == endpoint_id,
                        ModelEndpoint.is_enabled == True,
                    )
                    if user:
                        q = owner_filter(q, ModelEndpoint, user)
                    ep = q.first()
                    if not ep:
                        raise HTTPException(400, "Model endpoint no longer exists")
                    endpoint_base_url = ep.base_url or ""
                    endpoint_api_key = ep.api_key or ""
                    endpoint_url = build_chat_url(normalize_base(endpoint_base_url))
                finally:
                    _db.close()
            session.model = model
            session.endpoint_url = endpoint_url
            # 从端点存储的 API 密钥更新认证头
            if endpoint_api_key:
                from src.endpoint_resolver import build_headers
                session.headers = build_headers(endpoint_api_key, endpoint_base_url)
            else:
                session.headers = {}
            # 持久化到数据库
            db = SessionLocal()
            try:
                db_session = db.query(DbSession).filter(DbSession.id == sid).first()
                if db_session:
                    db_session.model = model
                    db_session.endpoint_url = endpoint_url
                    db_session.headers = session.headers or {}
                    db_session.updated_at = datetime.utcnow()
                    db.commit()
            finally:
                db.close()
            result["model"] = model
            result["endpoint_url"] = endpoint_url
        return result
    
    @router.post("/session/{sid}/inject_messages")
    async def inject_messages(request: Request, sid: str):
        """批量注入消息到会话历史中（用于群聊同步）。"""
        _verify_session_owner(request, sid)
        try:
            sess = session_manager.get_session(sid)
        except KeyError:
            raise HTTPException(404, f"Session {sid} not found")
        body = await request.json()
        messages = body.get("messages", [])
        from core.models import ChatMessage
        for m in messages:
            sess.add_message(ChatMessage(m["role"], m["content"], metadata=m.get("metadata")))
        session_manager.save_sessions()
        return {"ok": True, "count": len(messages)}

    @router.post("/session/{sid}/delete")
    def delete_session_beacon(request: Request, sid: str):
        """通过 POST 删除会话（用于页面关闭时的 navigator.sendBeacon）。"""
        return delete_session(request, sid)

    @router.post("/sessions/bulk-delete")
    async def bulk_delete_sessions(request: Request):
        """删除多个会话（用于 compare 清理的 sendBeacon）。"""
        from core.database import ChatMessage as _CM
        try:
            body = await request.json()
            ids = body.get("ids", [])
        except Exception:
            ids = []
        deleted_count = 0
        for sid in ids:
            try:
                _verify_session_owner(request, sid, session_manager)
                
                # 强制"收藏"保护，与单会话删除保持一致
                db = SessionLocal()
                try:
                    db_sess = db.query(DbSession).filter(DbSession.id == sid).first()
                    if db_sess and db_sess.is_important:
                        continue
                finally:
                    db.close()

                if session_manager.delete_session(sid):
                    deleted_count += 1
            except Exception:
                pass
        return {"deleted": deleted_count}

    @router.delete("/session/{sid}")
    def delete_session(request: Request, sid: str):
        """永久删除会话及其所有消息。"""
        _verify_session_owner(request, sid, session_manager)
        try:
            # 阻止删除标星/收藏的会话
            db = SessionLocal()
            try:
                db_sess = db.query(DbSession).filter(DbSession.id == sid).first()
                if db_sess and db_sess.is_important:
                    raise HTTPException(
                        status_code=403,
                        detail={"error": "SESSION_STARRED", "message": "Unstar the session before deleting it"}
                    )
            finally:
                db.close()

            # 删除会话及其所有消息
            if session_manager.delete_session(sid):
                return {"status": "deleted"}
            else:
                raise HTTPException(404, "Session not found")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error deleting session {sid}: {e}")
            raise HTTPException(
                status_code=500,
                detail={
                    "error": "SESSION_DELETE_ERROR",
                    "message": "Failed to delete session"
                }
            )
    
    @router.delete("/sessions/all")
    def delete_all_sessions(request: Request):
        """仅限管理员：永久删除所有会话及其消息。"""
        from core.middleware import require_admin
        require_admin(request)

        db = SessionLocal()
        try:
            from core.database import ChatMessage as DbChatMessage
            count = db.query(DbSession).count()
            db.query(DbChatMessage).delete()
            db.query(DbSession).delete()
            db.commit()
            session_manager.sessions.clear()
            logger.info(f"Admin deleted all {count} sessions")
            return {"status": "deleted", "count": count}
        except Exception as e:
            db.rollback()
            logger.error(f"Error deleting all sessions: {e}")
            raise HTTPException(500, "Failed to delete sessions")
        finally:
            db.close()

    @router.post("/session/{sid}/archive")
    def archive_session(request: Request, sid: str):
        """归档会话，保留数据但从活跃会话列表中移除。"""
        _verify_session_owner(request, sid)
        try:
            # 首先检查会话是否存在
            session_manager.get_session(sid)
            
            # 归档会话
            db = SessionLocal()
            try:
                db_session = db.query(DbSession).filter(DbSession.id == sid).first()
                if db_session:
                    db_session.archived = True
                    db_session.updated_at = datetime.utcnow()
                    db.commit()
                    
                    # 如果存在于内存中也更新
                    if sid in session_manager.sessions:
                        session_manager.sessions[sid].archived = True
                        
                    logger.info(f"Archived session {sid}")
                    return {"status": "archived"}
                else:
                    raise HTTPException(404, f"Session {sid} not found")
                    
            except HTTPException:
                raise
            except Exception as e:
                db.rollback()
                logger.error(f"Error archiving session {sid}: {e}")
                raise HTTPException(500, "Failed to archive session")
            finally:
                db.close()

        except KeyError:
            raise HTTPException(404, f"Session '{sid}' not found")
    
    @router.post("/session/{sid}/unarchive")
    def unarchive_session(request: Request, sid: str):
        """将已归档的会话恢复到活跃会话列表。"""
        _verify_session_owner(request, sid)
        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == sid).first()
            if not db_session:
                raise HTTPException(404, f"Session {sid} not found")
            db_session.archived = False
            db_session.updated_at = datetime.utcnow()
            db.commit()
            # 重新加载到 session manager 以便出现在活跃列表中
            try:
                if sid in session_manager.sessions:
                    session_manager.sessions[sid].archived = False
                else:
                    session_manager._load_session_from_db(sid)
            except Exception:
                pass  # 非致命 — 会话将在下次访问时加载
            return {"status": "unarchived"}
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Error unarchiving session {sid}: {e}")
            raise HTTPException(500, "Failed to unarchive session")
        finally:
            db.close()

    @router.get("/sessions/archived")
    def list_archived_sessions(request: Request, search: str = "", offset: int = 0, limit: int = 20, sort: str = "recent", model: str = ""):
        """列出已归档会话供归档浏览器查看。"""
        user = effective_user(request)
        db = SessionLocal()
        try:
            q = db.query(DbSession).filter(DbSession.archived == True)
            if not user:
                raise HTTPException(403, "Authentication required")
            q = q.filter(DbSession.owner == user)
            if search:
                safe_search = search.replace('%', r'\%').replace('_', r'\_')
                q = q.filter(DbSession.name.ilike(f"%{safe_search}%", escape='\\'))
            if model:
                # 包含匹配（镜像上面的名称过滤）。旧的
                # f"%{model}" 是后缀匹配，所以过滤 "gpt-4"
                # 会漏掉 "gpt-4o"，并在共享后缀上过度匹配；它还会
                # 让用户值中的 LIKE 通配符不转义。
                safe_model = model.replace('%', r'\%').replace('_', r'\_')
                q = q.filter(DbSession.model.ilike(f"%{safe_model}%", escape='\\'))
            total = q.count()
            sort_map = {
                "recent": DbSession.updated_at.desc(),
                "oldest": DbSession.updated_at.asc(),
                "most-messages": DbSession.message_count.desc().nulls_last(),
                "alpha": DbSession.name.asc(),
            }
            order = sort_map.get(sort, DbSession.updated_at.desc())
            rows = q.order_by(order).offset(offset).limit(limit).all()
            sessions = []
            for s in rows:
                sessions.append({
                    "id": s.id,
                    "name": s.name,
                    "model": s.model,
                    "message_count": s.message_count or 0,
                    "created_at": s.created_at.isoformat() if s.created_at else None,
                    "updated_at": s.updated_at.isoformat() if s.updated_at else None,
                    "is_important": s.is_important,
                })
            return {"sessions": sessions, "total": total}
        finally:
            db.close()

    @router.get("/history/{sid}")
    def get_history(request: Request, sid: str):
        _verify_session_owner(request, sid)
        try:
            session = session_manager.get_session(sid)
        except KeyError:
            raise HTTPException(404, f"Session {sid} not found")
        return {"history": [msg.to_dict() for msg in session.history]}
    
    @router.get("/session/{sid}/export")
    def export_session(request: Request, sid: str, fmt: str = "md", filename: str = ""):
        """将会话历史导出为可下载文件。

        支持的格式：md (markdown)、txt (纯文本)、json、html
        """
        _verify_session_owner(request, sid)
        try:
            session = session_manager.get_session(sid)
        except KeyError:
            raise HTTPException(404, f"Session {sid} not found")

        safe_name = re.sub(r'[^\w\-_]', '_', session.name)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = _sanitize_export_filename(filename)

        if fmt == "json":
            import json as _json
            data = {
                "name": session.name,
                "model": session.model,
                "exported": datetime.now().isoformat(),
                "messages": [{"role": m.role, "content": m.content} for m in session.history],
            }
            out_name = filename or f"conversation_{safe_name}_{timestamp}.json"
            return Response(
                content=_json.dumps(data, indent=2, ensure_ascii=False),
                media_type="application/json",
                headers={"Content-Disposition": f"attachment; filename={out_name}"},
            )

        if fmt == "txt":
            lines = []
            for m in session.history:
                lines.append(f"[{m.role.upper()}]")
                lines.append(_content_to_text(m.content))
                lines.append("")
            out_name = filename or f"conversation_{safe_name}_{timestamp}.txt"
            return Response(
                content="\n".join(lines),
                media_type="text/plain",
                headers={"Content-Disposition": f"attachment; filename={out_name}"},
            )

        if fmt == "html":
            safe_title = html.escape(session.name or "")
            html_parts = [
                "<!DOCTYPE html><html><head>",
                f"<meta charset='utf-8'><title>{safe_title}</title>",
                "<style>body{font-family:monospace;max-width:800px;margin:2rem auto;padding:0 1rem;background:#111;color:#ddd}",
                ".msg{margin:1rem 0;padding:0.8rem;border-radius:6px;border:1px solid #333}",
                ".user{background:#1a1a2e}.ai{background:#1a2e1a}",
                ".role{font-weight:bold;margin-bottom:0.4rem;opacity:0.7;text-transform:uppercase;font-size:0.85em}",
                "pre{background:#000;padding:0.5rem;border-radius:4px;overflow-x:auto}</style></head><body>",
                f"<h1>{safe_title}</h1>",
            ]
            for m in session.history:
                cls = "user" if m.role == "user" else "ai"
                content = _content_to_text(m.content).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                content = content.replace("\n", "<br>")
                html_parts.append(f'<div class="msg {cls}"><div class="role">{m.role}</div>{content}</div>')
            html_parts.append("</body></html>")
            out_name = filename or f"conversation_{safe_name}_{timestamp}.html"
            return Response(
                content="\n".join(html_parts),
                media_type="text/html",
                headers={"Content-Disposition": f"attachment; filename={out_name}"},
            )

        # 默认格式：markdown
        markdown_lines = []
        markdown_lines.append(f"# Conversation: {session.name}")
        markdown_lines.append(f"*Exported on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*")
        markdown_lines.append(f"*Model: {session.model}*")
        markdown_lines.append("\n---\n")
        for message in session.history:
            role = message.role.upper()
            content = _content_to_text(message.content)
            markdown_lines.append(f"### {role}")
            markdown_lines.append(f"{content}\n")
            markdown_lines.append("---\n")
        if len(markdown_lines) > 3:
            markdown_lines.pop()
        out_name = filename or f"conversation_{safe_name}_{timestamp}.md"
        return Response(
            content="\n".join(markdown_lines),
            media_type="text/markdown",
            headers={"Content-Disposition": f"attachment; filename={out_name}"},
        )
    
    @router.post("/sessions/save")
    def sessions_save_now(request: Request):
        user = effective_user(request)
        if not user:
            raise HTTPException(401, "Not authenticated")
        session_manager.save_sessions()
        return {"ok": True, "path": SESSIONS_FILE}
    
    @router.post("/session/openai")
    def create_session_openai(
        request: Request,
        name: str = Form("New Chat (OpenAI)"),
        model: str = Form("gpt-4o"),
        rag: str = Form(None)
    ):
        if not OPENAI_API_KEY:
            raise HTTPException(400, "Server missing OPENAI_API_KEY")
        sid = str(uuid.uuid4())
        user = effective_user(request)
        session = session_manager.create_session(
            session_id=sid,
            name="",
            endpoint_url="https://api.openai.com/v1/chat/completions",
            model=model,
            rag=str(rag).lower() == "true",
            owner=user,
        )
        session.headers = {"Authorization": f"Bearer {OPENAI_API_KEY}"}
        session_manager.save_sessions()
        from src.event_bus import fire_event
        fire_event("session_created", user)
        return {"id": sid, "name": "", "model": model}
    
    @router.post("/session/{session_id}/important")
    async def mark_session_important(request: Request, session_id: str, important: bool = Form(True)):
        """标记会话为重要，防止自动清理删除。"""
        _verify_session_owner(request, session_id)
        try:
            # 验证会话存在
            session_manager.get_session(session_id)

            # 在数据库中更新
            db = SessionLocal()
            try:
                db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
                if db_session:
                    db_session.is_important = important
                    db_session.updated_at = datetime.utcnow()
                    db.commit()

                    # 如果存在于内存中也更新
                    if session_id in session_manager.sessions:
                        session_manager.sessions[session_id].is_important = important

                    return {"status": "success", "is_important": important}
                else:
                    raise HTTPException(404, f"Session {session_id} not found")

            except HTTPException:
                raise
            except Exception as e:
                db.rollback()
                logger.error(f"Error updating session {session_id} importance: {e}")
                raise HTTPException(500, "Failed to update session importance")
            finally:
                db.close()

        except KeyError:
            raise HTTPException(404, f"Session {session_id} not found")

    @router.post("/session/{session_id}/compact")
    async def compact_session(request: Request, session_id: str):
        """将较早的消息摘要为一条压缩的历史记录条目。"""
        _verify_session_owner(request, session_id)
        try:
            session = session_manager.get_session(session_id)
        except KeyError:
            raise HTTPException(404, f"Session {session_id} not found")
        _reject_compact_during_active_run(session_id)

        history = list(session.history or [])
        if len(history) < 6:
            raise HTTPException(400, "Not enough messages to compact")

        # 保留少量最近的消息原样。旧的半聊天/20条消息
        # 的尾部使手动压缩在正常聊天中看起来毫无效果。
        recent_keep = min(8, max(4, len(history) // 4))
        older = history[:-recent_keep]
        recent = history[-recent_keep:]
        if not older:
            raise HTTPException(400, "Nothing old enough to compact")

        from src.context_compactor import SELF_SUMMARY_SYSTEM_PROMPT
        from src.endpoint_resolver import resolve_endpoint
        from src.llm_core import llm_call_async

        owner = getattr(session, "owner", None) or effective_user(request)
        url, model, headers = resolve_endpoint("utility", owner=owner)
        if not url or not model:
            url, model, headers = session.endpoint_url, session.model, session.headers
        if not url or not model:
            raise HTTPException(400, "No model configured for compaction")

        prior_compactions = sum(
            1 for m in history
            if _message_metadata(m).get("compacted") or "[Conversation summary" in _message_text(m)
        )
        prompt = SELF_SUMMARY_SYSTEM_PROMPT.replace(
            "{count}", str(len(older))
        ).replace(
            "{n}", str(prior_compactions + 1)
        )
        convo_text = "\n".join(
            f"{_message_role(m).upper()}: {_message_text(m)[:2000]}"
            for m in older
        )
        try:
            summary = await llm_call_async(
                url,
                model,
                [{"role": "system", "content": prompt}, {"role": "user", "content": convo_text}],
                temperature=0.2,
                max_tokens=1024,
                headers=headers,
                timeout=60,
            )
        except Exception as e:
            logger.error("Manual compaction failed: %s", e)
            raise HTTPException(500, "Compaction failed")

        summary_msg = ChatMessage(
            role="system",
            content=f"[Conversation summary]\n{summary}",
            metadata={
                "compacted": True,
                "summarized_count": len(older),
                "timestamp": datetime.utcnow().isoformat(),
            },
        )
        new_history = [summary_msg] + recent
        if not session_manager.replace_messages(session_id, new_history):
            raise HTTPException(500, "Failed to save compacted history")

        return {
            "ok": True,
            "summarized": len(older),
            "kept": len(recent),
            "message_count": len(new_history),
        }

    @router.post("/sessions/auto-sort")
    def auto_sort_sessions(request: Request, skip_llm: bool = False):
        """使用 AI 将所有会话分类到文件夹中。

        第一阶段删除空/临时会话，第二阶段让 LLM
        分配文件夹。当 `skip_llm=true` 时，端点在
        第一阶段后返回 — 用于"整理（无 AI）"UI 操作，
        让用户在不消耗 token 的情况下清理垃圾。
        """
        from src.llm_core import llm_call
        user = effective_user(request)
        user_sessions = session_manager.get_sessions_for_user(user)

        # 排序前删除空会话和临时会话
        from core.database import ChatMessage as DbMsg
        db = SessionLocal()
        deleted_empty = 0
        deleted_throwaway = 0
        # 表示临时/测试会话的名称（不区分大小写的精确匹配或前缀匹配）
        _THROWAWAY_NAMES = {
            "test", "testing", "asdf", "asd", "hello", "hi", "hey",
            "yo", "sup", "hola", "hii", "hiii", "heyo",
            "foo", "bar", "baz", "tmp", "temp", "scratch", "untitled",
            "new chat", "delete", "remove", "junk", "trash", "xxx",
            "abc", "qwerty", "blah", "stuff", "whatever", "idk",
            "ok", "lol", "bruh", "hmm", "hm", "meh",
        }
        _THROWAWAY_MAX_MESSAGES = 4  # only delete if <= this many messages
        try:
            rows = db.query(DbSession).filter(DbSession.archived == False, DbSession.owner == user).limit(2000).all()
            folder_map = {r.id: r.folder for r in rows}
            # 使用两个聚合查询预计算每个会话的消息数
            # 而不是每个会话 1-3 次查询 — 会话较多时，
            # 逐行循环会进行数千次往返并超时。
            from sqlalchemy import func as _sa_func
            _counts = dict(db.query(DbMsg.session_id, _sa_func.count(DbMsg.id)).group_by(DbMsg.session_id).all())
            _asst_counts = dict(
                db.query(DbMsg.session_id, _sa_func.count(DbMsg.id))
                .filter(DbMsg.role == "assistant").group_by(DbMsg.session_id).all()
            )
            cleanup_now = utcnow_naive()
            for row in rows:
                # 绝不删除重要的会话
                if getattr(row, 'is_important', False):
                    continue
                # 清理过程中始终删除匿名会话
                if (row.name or "").strip() == "Incognito":
                    should_delete = True
                    deleted_throwaway += 1
                    db.delete(row)
                    if hasattr(session_manager, 'delete_session'):
                        session_manager.delete_session(row.id)
                    continue
                if is_session_recently_active(row, now=cleanup_now):
                    continue
                msg_count = _counts.get(row.id, 0)
                should_delete = False
                if msg_count == 0:
                    should_delete = True
                    deleted_empty += 1
                elif msg_count <= _THROWAWAY_MAX_MESSAGES:
                    name = (row.name or "").strip().lower()
                    # 检查第一条用户消息内容（AI 会重命名会话，所以
                    # "hi" 变成 "Casual Greeting Exchange" — 仅靠名称无法匹配）
                    first_msg = db.query(DbMsg.content).filter(
                        DbMsg.session_id == row.id, DbMsg.role == "user"
                    ).order_by(DbMsg.timestamp).first()
                    first_text = (first_msg[0] or "").strip().lower() if first_msg else ""
                    # 统计 assistant 消息数 — 如果用户发了消息但 AI 从未回复，则是死会话
                    assistant_count = _asst_counts.get(row.id, 0)
                    if name in _THROWAWAY_NAMES or name.startswith("chat:") or first_text in _THROWAWAY_NAMES:
                        should_delete = True
                        deleted_throwaway += 1
                    # 仅一条用户消息且无 AI 响应 = 死会话
                    elif msg_count == 1 and assistant_count == 0:
                        should_delete = True
                        deleted_throwaway += 1
                    # 短短语（1-3 个单词）且无真正的 AI 对话（<=2 条消息）
                    elif msg_count <= 2 and first_text and len(first_text.split()) <= 3 and len(first_text) <= 40:
                        should_delete = True
                        deleted_throwaway += 1
                if should_delete:
                    db.delete(row)
                    if hasattr(session_manager, 'delete_session'):
                        session_manager.delete_session(row.id)
            if deleted_empty or deleted_throwaway:
                db.commit()
                logger.info(f"Auto-sort: deleted {deleted_empty} empty + {deleted_throwaway} throwaway sessions")
        finally:
            db.close()

        # 清理后重新获取
        if deleted_empty or deleted_throwaway:
            user_sessions = session_manager.get_sessions_for_user(user)

        # 当调用方仅需要清理阶段时短路返回
        # （"整理（无 AI）"路径）。格式镜像下方的第一阶段后
        # 分支，以便前端渲染相同的提示。
        if skip_llm:
            return {
                "status": "ok",
                "updated": 0,
                "folders": [],
                "deleted_empty": deleted_empty,
                "deleted_throwaway": deleted_throwaway,
                "unfiled_remaining": 0,
                "skipped_llm": True,
            }

        # 整理分批进行：仅处理尚未分配文件夹的会话，
        # 上限为 TIDY_BATCH_SIZE（最新的优先）。将所有 100+ 个
        # 聊天发给一次 LLM 调用会超出上下文窗口，使
        # 请求变慢，并为已排序的聊天重复收取 tokens 费用。
        # 跳过有 `current_folder` 的会话意味着每次按"整理"
        # 仅处理新的未分类聊天。
        TIDY_BATCH_SIZE = 15
        all_candidates = []
        for s in user_sessions.values():
            if s.archived or s.name == "Incognito":
                continue
            if folder_map.get(s.id):
                # 已在文件夹中 — 本轮跳过。
                continue
            name = s.name or "(unnamed)"
            all_candidates.append({
                "id": s.id,
                "name": name,
                "updated_at": getattr(s, "updated_at", None) or getattr(s, "created_at", None) or "",
                "current_folder": None,
            })

        # 最新优先，然后取前 N 个用于本轮处理。
        all_candidates.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
        unfiled_total = len(all_candidates)
        session_list = all_candidates[:TIDY_BATCH_SIZE]

        if len(session_list) < 2:
            if deleted_empty or deleted_throwaway:
                return {
                    "status": "ok",
                    "updated": 0,
                    "folders": [],
                    "deleted_empty": deleted_empty,
                    "deleted_throwaway": deleted_throwaway,
                    "unfiled_remaining": unfiled_total,
                }
            return {"status": "skipped", "reason": "No unfiled sessions to sort"}

        # 选择端点 — 优先使用管理员配置的任务端点
        from src.task_endpoint import resolve_task_endpoint
        url, model, headers = resolve_task_endpoint(owner=user)
        if not url:
            url, model, headers = _pick_endpoint_for_sort(owner=user)
        if not url:
            raise HTTPException(503, "No available model endpoint for auto-sort")

        # 构建提示词
        names_text = "\n".join(f'  "{s["id"][:8]}": "{s["name"]}"' for s in session_list)
        prompt = (
            "You are a session organizer. Group these chat sessions into folders by topic.\n\n"
            "Rules:\n"
            "- Be aggressive about grouping — put EVERY session in a folder\n"
            "- Use short folder names (2-4 words max)\n"
            "- Use the 8-char ID prefixes exactly as given\n"
            "- Output ONLY raw JSON, no markdown fences, no explanation\n\n"
            "Required JSON format:\n"
            '{"folders": {"Folder Name": ["id_prefix1", "id_prefix2"], "Other Folder": ["id_prefix3"]}}\n\n'
            f"Sessions (id_prefix: name):\n{{\n{names_text}\n}}"
        )

        try:
            logger.info(f"Auto-sort: using model={model} at {url}")
            # 16384 (was 4096): with many chats the folder JSON is large, and a
            # reasoning model spends tokens thinking first — 4096 truncated the
            # JSON mid-output, so it never parsed ("invalid JSON for auto-sort").
            raw = llm_call(url, model, [{"role": "user", "content": prompt}],
                           temperature=0.3, max_tokens=16384, headers=headers, timeout=120)
            logger.info(f"Auto-sort raw response ({len(raw)} chars): {raw[:300]}")
            # 从响应中提取 JSON — 处理 markdown 围栏、前导文本、
            # 推理模型的 <think> 块和尾部逗号。
            text = raw.strip()
            # 推理模型在答案前会输出 <think>…</think>（通常包含 { }，
            # 会干扰括号扫描）— 先将其删除。
            text = re.sub(r'<think(?:ing)?>[\s\S]*?</think(?:ing)?>', '', text, flags=re.I).strip()

            def _loads_lenient(s):
                """解析 JSON，如失败则重试一次并去除尾部逗号。"""
                if not s:
                    return None
                for cand in (s, re.sub(r',(\s*[}\]])', r'\1', s)):
                    try:
                        return json.loads(cand)
                    except json.JSONDecodeError:
                        continue
                return None

            result = _loads_lenient(text)
            # Markdown 代码围栏
            if result is None:
                fence_match = re.search(r'```(?:json)?\s*\n?([\s\S]*?)```', text)
                if fence_match:
                    result = _loads_lenient(fence_match.group(1).strip())
            # 首 { … 末 } 块
            if result is None:
                brace_start = text.find('{')
                brace_end = text.rfind('}')
                if brace_start >= 0 and brace_end > brace_start:
                    result = _loads_lenient(text[brace_start:brace_end + 1])
            if result is None:
                logger.error(f"Auto-sort: could not parse JSON from: {text[:500]}")
                raise HTTPException(502, "AI returned invalid JSON for auto-sort — the model may not follow JSON instructions; try a different utility model in Settings.")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Auto-sort LLM call failed: {e}")
            raise HTTPException(502, f"Auto-sort failed: {str(e)}")

        folders = result.get("folders", {})
        if not folders:
            return {"status": "skipped", "reason": "AI found no groupings"}

        # 构建 id → 文件夹 映射
        id_prefix_map = {s["id"][:8]: s["id"] for s in session_list}
        assignments = {}
        for folder_name, ids in folders.items():
            for sid_or_prefix in ids:
                # 按完整 ID 或前缀匹配
                full_id = None
                if sid_or_prefix in id_prefix_map.values():
                    full_id = sid_or_prefix
                else:
                    # 尝试前缀匹配
                    prefix = sid_or_prefix.rstrip(".").rstrip(" ")
                    if prefix in id_prefix_map:
                        full_id = id_prefix_map[prefix]
                    else:
                        # 模糊前缀匹配
                        for p, fid in id_prefix_map.items():
                            if fid.startswith(prefix) or prefix.startswith(p):
                                full_id = fid
                                break
                if full_id:
                    assignments[full_id] = folder_name

        # 应用文件夹分配
        updated = 0
        db = SessionLocal()
        try:
            for sid, folder_name in assignments.items():
                db_session = db.query(DbSession).filter(DbSession.id == sid, DbSession.owner == user).first()
                if db_session:
                    db_session.folder = folder_name
                    db_session.updated_at = datetime.utcnow()
                    updated += 1
            db.commit()
        except Exception as e:
            db.rollback()
            logger.error(f"Auto-sort DB update failed: {e}")
            raise HTTPException(500, "Failed to apply folder assignments")
        finally:
            db.close()

        # 本轮之后还剩下多少未分类的聊天 —
        # 前端用它来决定是显示"继续整理"还是
        # "全部已分类！"在提示中。
        unfiled_remaining_after = max(0, unfiled_total - updated)
        return {
            "status": "ok",
            "folders": list(folders.keys()),
            "updated": updated,
            "deleted_empty": deleted_empty,
            "deleted_throwaway": deleted_throwaway,
            "unfiled_remaining": unfiled_remaining_after,
        }

    @router.get("/session/{session_id}/context_info")
    async def get_context_info(request: Request, session_id: str):
        """从端点获取会话模型的真实上下文长度。"""
        _verify_session_owner(request, session_id)
        session = session_manager.get_session(session_id)
        if not session:
            raise HTTPException(404, "Session not found")
        if not session.endpoint_url or not session.model:
            return {"context_length": None}
        try:
            from src.model_context import get_context_length
            ctx = get_context_length(session.endpoint_url, session.model)
            return {"context_length": ctx, "model": session.model}
        except Exception:
            return {"context_length": None}

    return router
