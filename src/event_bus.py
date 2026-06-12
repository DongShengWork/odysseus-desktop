"""
event_bus.py

轻量级事件总线，用于基于事件（如会话创建、消息发送等）触发自动化任务。
"""

import asyncio
import json
import logging
import os
from datetime import datetime
from typing import Optional

from src.constants import AUTH_FILE

logger = logging.getLogger(__name__)

_task_scheduler = None


def set_task_scheduler(scheduler):
    """接入调度器引用（在 app.py 启动时调用）。"""
    global _task_scheduler
    _task_scheduler = scheduler


def get_task_scheduler():
    """返回当前任务调度器实例。"""
    return _task_scheduler


def fire_event(event_name: str, owner: Optional[str] = None):
    """触发事件 — 递增计数器并触发达到阈值的任务。

    可以在同步和异步上下文中安全调用。
    """
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_handle_event(event_name, owner))
    except RuntimeError:
        # 没有正在运行的事件循环 — 在新建的事件循环中运行（在 FastAPI 中不应发生）
        asyncio.run(_handle_event(event_name, owner))


def _resolve_event_owner(owner: Optional[str]) -> Optional[str]:
    """将无所有者的应用事件解析到主要配置用户。

    某些事件源从 localhost/内部代码路径运行，这些路径中不存在请求
    中间件，因此无法传递用户名。将其视为"所有所有者"会导致内置任务
    为每个账户各运行一次。取而代之的是将这些事件路由到
    第一个管理员账户，与旧版所有者迁移保持一致。
    """
    owner = (owner or "").strip()
    if owner:
        return owner

    try:
        auth_path = AUTH_FILE
        with open(auth_path, "r", encoding="utf-8") as f:
            users = (json.load(f).get("users") or {})
        for username, data in users.items():
            if data.get("is_admin") is True:
                return username
        if users:
            return next(iter(users))
    except Exception:
        logger.debug("Could not resolve ownerless event owner", exc_info=True)
    return None


async def _handle_event(event_name: str, owner: Optional[str] = None):
    """处理事件：递增计数器，触发达到其阈值的任务。"""
    from core.database import SessionLocal, ScheduledTask

    resolved_owner = _resolve_event_owner(owner)
    db = SessionLocal()
    try:
        filters = [
            ScheduledTask.trigger_type == "event",
            ScheduledTask.trigger_event == event_name,
            ScheduledTask.status == "active",
        ]
        if resolved_owner:
            filters.append(ScheduledTask.owner == resolved_owner)
        else:
            filters.append(ScheduledTask.owner == None)  # noqa: E711

        tasks = db.query(ScheduledTask).filter(*filters).all()
        if not tasks:
            return

        for task in tasks:
            threshold = task.trigger_count or 1
            task.trigger_counter = (task.trigger_counter or 0) + 1

            if task.trigger_counter >= threshold:
                task.trigger_counter = 0
                # 在将任务交给内存调度器之前持久化触发器。
                # 如果进程在任务排队等待模型调用时重启，`next_run <= now`
                # 使得触发器在重启后仍能存活，而不是在计数器
                # 已重置后丢失事件。
                task.next_run = datetime.utcnow()
                db.commit()
                # 触发任务
                if _task_scheduler:
                    logger.info(f"Event '{event_name}' triggered task '{task.name}' (every {threshold})")
                    await _task_scheduler.run_task_now(task.id)
                else:
                    logger.warning(f"Event triggered task '{task.name}' but no scheduler available")
            else:
                db.commit()
                logger.debug(f"Event '{event_name}': task '{task.name}' counter {task.trigger_counter}/{threshold}")

    except Exception:
        logger.exception(f"Error handling event '{event_name}'")
    finally:
        db.close()
