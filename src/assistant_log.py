"""
assistant_log.py

全局工具函数，用于向个人助手的聊天 session 发布消息。
代码库中的任何部分都可以调用 log_to_assistant() 在助手的统一活动中
呈现事件、通知和结果。
"""

import json
import re
import uuid
import logging
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

# Session 管理器引用 — 由 app.py 在初始化后设置
_session_manager = None


def set_session_manager(sm):
    global _session_manager
    _session_manager = sm


# 调用者用于在内容中嵌入分类的模式（旧版）：
#   "**[Download]** Started downloading ..."
# 我们将其提取为结构化元数据，这样 UI 可以按类别着色
# 而无需解析 markdown。
_LEGACY_TAG_RE = re.compile(r"^\s*\*\*\[([^\]]{1,40})\]\*\*\s*")


def log_to_assistant(
    owner: str,
    content: str,
    role: str = "assistant",
    *,
    category: Optional[str] = None,
):
    """旧版空操作。

    旧版本将系统/任务活动写入收藏的助手聊天 session。
    现在活动已迁移到 Tasks/通知，因此保留此 shim 供调用者
    使用，同时阻止创建或填充侧边栏日志 session。
    """
    logger.debug("log_to_assistant ignored legacy activity category=%r owner=%r", category, owner)
    return
