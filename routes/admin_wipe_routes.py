"""管理员危险区域 — 按类别清理数据。

每个端点仅限管理员访问，精确截断一个数据域，
用户可以按需重置记忆/技能/笔记等，而不会一键清空所有数据。
`chats` 端点统一映射到已有的 /api/sessions/all，
使危险区域遵循一致的 URL 模式。

URL 格式: DELETE /api/admin/wipe/{kind}
类别: chats, memory, skills, notes, tasks, documents, gallery, calendar。
"""

import json
import logging
import os
import shutil
from fastapi import APIRouter, HTTPException, Request

from core.middleware import require_admin
from core.database import (
    SessionLocal,
    Session as DbSession,
    ChatMessage as DbChatMessage,
    Memory,
    Note,
    ScheduledTask,
    TaskRun,
    Document,
    DocumentVersion,
    GalleryImage,
    GalleryAlbum,
    CalendarEvent,
    CalendarCal,
)
from src.constants import DATA_DIR, SKILLS_DIR, SKILLS_FILE, GALLERY_DIR, GALLERY_UPLOADS_DIR

logger = logging.getLogger(__name__)


def _wipe_memory_files():
    """清空 memory.json + 删除每个用户的整理状态附属文件，
    避免下次审计时对已删除的记忆做差异比较。"""
    for name in ("memory.json", "memory_tidy_state.json"):
        p = os.path.join(DATA_DIR, name)
        if not os.path.exists(p):
            continue
        try:
            if name == "memory.json":
                with open(p, "w", encoding="utf-8") as f:
                    json.dump([], f)
            else:
                os.remove(p)
        except OSError as e:
            logger.warning(f"Could not reset {name}: {e}")


def _rmtree_quiet(path: str):
    """rmtree，路径不存在时不报错。"""
    if os.path.isdir(path):
        try:
            shutil.rmtree(path)
        except OSError as e:
            logger.warning(f"Could not remove {path}: {e}")


def setup_admin_wipe_routes(session_manager):