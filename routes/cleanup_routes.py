# routes/清理_routes.py
"""清理操作的路由。"""
import logging
from fastapi import APIRouter, HTTPException, Request
from src.cleanup_service import get_cleanup_preview, cleanup_sessions
from src.auth_helpers import get_current_user

logger = logging.getLogger(__name__)

def setup_cleanup_routes(session_manager):
    """
    设置清理相关的路由。

    参数:
        session_manager: SessionManager 实例

    返回:
        带有清理路由的 APIRouter 实例
    """
    router = APIRouter(prefix="/api/cleanup")

    @router.get("/preview")
    async def cleanup_preview(request: Request):
        """
        在不做任何更改的情况下预览将被清理的内容。

        返回:
            JSON 响应，包含将被归档/删除的会话列表和预计节省的空间
        """
        user = get_current_user(request)
        try:
            preview = await get_cleanup_preview(owner=user)
            return preview
        except Exception as e:
            logger.error(f"Cleanup preview failed: {e}")
            raise HTTPException(500, "Cleanup preview generation failed")

    @router.post("")
    async def cleanup_endpoint(request: Request):
        """
        执行清理操作：
        1. 归档不活跃的会话（7 天未访问）
        2. 删除旧会话（已归档、不重要、14 天以上未访问、消息少于 10 条）

        返回:
            JSON 响应，包含已删除和已归档的会话数量及释放的空间
        """
        user = get_current_user(request)
        try:
            archived_count, deleted_count, space_freed_mb = await cleanup_sessions(session_manager, owner=user)
            return {
                "archived_count": archived_count,
                "deleted_count": deleted_count,
                "space_freed_mb": round(space_freed_mb, 2)
            }
        except Exception as e:
            logger.error(f"Cleanup failed: {e}")
            raise HTTPException(500, "Cleanup operation failed")

    return router
