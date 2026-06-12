"""编辑器草稿路由 — 持久化的进行中画廊编辑器会话。

画廊编辑器（图像画布）允许用户在照片（或空白画布）上叠加编辑操作。
将这些分层会话持久化到服务器使其能够在缓存清理后存活，并在设备间漫游 —
与传统的每图像 localStorage 草稿不同。

每个草稿包含：
  - id — 不透明 uuid（客户端永远不会看到画廊图像 id
                   作为草稿 id，因此空白画布草稿也能正常工作）
  - source_image_id（可为空）— 回指指针，表示"此草稿始于
                    对 GalleryImage X 的编辑"
  - payload — 完整的 JSON 快照（图层为 base64 PNG dataURL、
                    偏移量、透明度等），编辑器知道如何还原
  - thumbnail — 用于列表网格的小型 data URL
"""

import json
import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core.database import EditorDraft, SessionLocal
from src.auth_helpers import get_current_user

logger = logging.getLogger(__name__)


class DraftCreate(BaseModel):
    name: Optional[str] = None
    source_image_id: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    payload: Dict[str, Any]
    thumbnail: Optional[str] = None


class DraftUpdate(BaseModel):
    name: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    payload: Optional[Dict[str, Any]] = None
    thumbnail: Optional[str] = None


def _owns(d: EditorDraft, user: Optional[str]) -> bool:
    if user is None:
        return True
    return (d.owner or None) == user


def _summary(d: EditorDraft) -> Dict[str, Any]:
    """List-view representation — omits the bulky payload."""
    return {
        "id": d.id,
        "name": d.name or "Untitled",
        "source_image_id": d.source_image_id,
        "width": d.width,
        "height": d.height,
        "thumbnail": d.thumbnail,
        "created_at": d.created_at.isoformat() if d.created_at else None,
        "updated_at": d.updated_at.isoformat() if d.updated_at else None,
    }


def _load_payload(raw: Optional[str]) -> Dict[str, Any]:
    try:
        payload = json.loads(raw) if raw else {}
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def setup_editor_draft_routes() -> APIRouter:
    router = APIRouter(tags=["editor-drafts"])

    @router.get("/api/editor-drafts")
    async def list_drafts(request: Request) -> Dict[str, List[Dict[str, Any]]]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            q = db.query(EditorDraft).filter(EditorDraft.is_active == True)
            if user is not None:
                q = q.filter(EditorDraft.owner == user)
            rows = q.order_by(EditorDraft.updated_at.desc()).limit(200).all()
            return {"drafts": [_summary(d) for d in rows]}
        finally:
            db.close()

    @router.get("/api/editor-drafts/{draft_id}")
    async def get_draft(request: Request, draft_id: str) -> Dict[str, Any]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            d = db.query(EditorDraft).filter(
                EditorDraft.id == draft_id, EditorDraft.is_active == True
            ).first()
            if not d or not _owns(d, user):
                raise HTTPException(404, "Draft not found")
            return {
                **_summary(d),
                "payload": _load_payload(d.payload),
            }
        finally:
            db.close()

    @router.post("/api/editor-drafts")
    async def create_draft(request: Request, body: DraftCreate) -> Dict[str, Any]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            d = EditorDraft(
                id=str(uuid.uuid4()),
                owner=user,
                name=(body.name or "Untitled")[:200],
                source_image_id=body.source_image_id,
                width=body.width,
                height=body.height,
                payload=json.dumps(body.payload or {}),
                thumbnail=body.thumbnail,
            )
            db.add(d)
            db.commit()
            db.refresh(d)
            return _summary(d)
        except Exception as e:
            db.rollback()
            logger.warning(f"editor-draft create failed: {e}")
            raise HTTPException(500, "Could not save draft")
        finally:
            db.close()

    @router.put("/api/editor-drafts/{draft_id}")
    async def update_draft(request: Request, draft_id: str, body: DraftUpdate) -> Dict[str, Any]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            d = db.query(EditorDraft).filter(
                EditorDraft.id == draft_id, EditorDraft.is_active == True
            ).first()
            if not d or not _owns(d, user):
                raise HTTPException(404, "Draft not found")
            if body.name is not None:
                d.name = body.name[:200]
            if body.width is not None:
                d.width = body.width
            if body.height is not None:
                d.height = body.height
            if body.payload is not None:
                d.payload = json.dumps(body.payload)
            if body.thumbnail is not None:
                d.thumbnail = body.thumbnail
            db.commit()
            db.refresh(d)
            return _summary(d)
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.warning(f"editor-draft update failed: {e}")
            raise HTTPException(500, "Could not update draft")
        finally:
            db.close()

    @router.delete("/api/editor-drafts/{draft_id}")
    async def delete_draft(request: Request, draft_id: str) -> Dict[str, str]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            d = db.query(EditorDraft).filter(EditorDraft.id == draft_id).first()
            if not d or not _owns(d, user):
                raise HTTPException(404, "Draft not found")
            d.is_active = False
            db.commit()
            return {"status": "deleted", "id": draft_id}
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            raise HTTPException(500, str(e))
        finally:
            db.close()

    return router
