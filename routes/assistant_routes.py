"""个人助理路由 — 解析每个用户的单例，读写其设置，
并列出其定时签到任务。

个人助理本质上是一个带特殊标记的 CrewMember，拥有一个
固定会话和三个每日定时任务（"早上/午间/晚间签到"）。
所有属性均可由用户编辑：名称、个性、模型、
启用的工具、时区以及三个签到的时间/提示/启用开关。
"""

import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core.database import SessionLocal, CrewMember, ScheduledTask
from src.auth_helpers import get_current_user
from src.task_scheduler import compute_next_run


class CheckInUpdate(BaseModel):
    id: str                               # ScheduledTask.id
    name: Optional[str] = None
    scheduled_time: Optional[str] = None  # "HH:MM"
    prompt: Optional[str] = None
    enabled: Optional[bool] = None        # 映射到 status "active"/"paused"


class AssistantSettingsUpdate(BaseModel):
    name: Optional[str] = None
    avatar: Optional[str] = None
    personality: Optional[str] = None
    model: Optional[str] = None
    endpoint_url: Optional[str] = None
    enabled_tools: Optional[list[str]] = None
    allow_autonomous_email: Optional[bool] = None  # 便捷开关
    timezone: Optional[str] = None
    check_ins: Optional[list[CheckInUpdate]] = None


_EMAIL_TOOLS = {"send_email", "reply_to_email"}


def _crew_to_dict(c: CrewMember) -> dict:
    try:
        tools = json.loads(c.enabled_tools) if c.enabled_tools else []
    except Exception:
        tools = []
    return {
        "id": c.id,
        "name": c.name,
        "avatar": c.avatar,
        "personality": c.personality,
        "model": c.model,
        "endpoint_url": c.endpoint_url,
        "greeting": c.greeting,
        "enabled_tools": tools,
        "session_id": c.session_id,
        "is_default_assistant": bool(c.is_default_assistant),
        "timezone": c.timezone,
        "allow_autonomous_email": any(t in _EMAIL_TOOLS for t in tools),
    }


def _task_to_checkin_dict(t: ScheduledTask) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "scheduled_time": t.scheduled_time,
        "prompt": t.prompt,
        "enabled": (t.status or "active") == "active",
        "next_run": t.next_run.isoformat() + "Z" if t.next_run else None,
        "last_run": t.last_run.isoformat() + "Z" if t.last_run else None,
        "run_count": t.run_count or 0,
    }


def setup_assistant_routes(task_scheduler) -> APIRouter:
    router = APIRouter(prefix="/api/assistant", tags=["assistant"])

    def _owner(request: Request) -> str:
        owner = get_current_user(request)
        if not owner:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return owner

    # 合成的/非人类 owner，这些 owner 永远不应该被创建为助理 +
    # 签到任务。之前在任意 /assistant 路由下以这些 owner 访问
    # 会为其创建完整的 CrewMember + 早/午/晚签到任务，
    # 然后与真实用户的签到双重触发。
    _SYNTHETIC_OWNERS = frozenset({"internal-tool", "api", "demo", "system", ""})

    async def _get_or_create(owner: str) -> CrewMember:
        """返回每个用户的助手 CrewMember，按需创建。"""
        if not owner or owner in _SYNTHETIC_OWNERS:
            raise HTTPException(status_code=400, detail=f"Cannot seed assistant for {owner!r}")
        db = SessionLocal()
        try:
            crew = db.query(CrewMember).filter(
                CrewMember.owner == owner,
                CrewMember.is_default_assistant == True,  # noqa: E712
            ).first()
            if crew:
                return crew
        finally:
            db.close()
        # 延迟创建。这与启动钩子为每个用户执行的代码相同
        # —— 可以安全地再次调用，它是幂等的。
        await task_scheduler.ensure_assistant_defaults(owner)
        db = SessionLocal()
        try:
            crew = db.query(CrewMember).filter(
                CrewMember.owner == owner,
                CrewMember.is_default_assistant == True,  # noqa: E712
            ).first()
            return crew
        finally:
            db.close()

    @router.get("/session")
    async def get_assistant_session(request: Request):
        """解析（或延迟创建）该用户的固定助手会话。"""
        owner = _owner(request)
        crew = await _get_or_create(owner)
        if not crew or not crew.session_id:
            raise HTTPException(status_code=500, detail="Assistant session could not be resolved")
        return {
            "session_id": crew.session_id,
            "crew_member_id": crew.id,
            "name": crew.name,
        }

    @router.get("/settings")
    async def get_assistant_settings(request: Request):
        """返回 CrewMember 字段 + 三个签到任务行 + 用于日志的任务 ID。"""
        owner = _owner(request)
        crew = await _get_or_create(owner)
        if not crew:
            raise HTTPException(status_code=500, detail="Assistant not available")
        db = SessionLocal()
        try:
            tasks = db.query(ScheduledTask).filter(
                ScheduledTask.owner == owner,
                ScheduledTask.crew_member_id == crew.id,
            ).order_by(ScheduledTask.scheduled_time.asc()).all()
            return {
                "crew": _crew_to_dict(crew),
                "check_ins": [_task_to_checkin_dict(t) for t in tasks],
                "task_ids": [t.id for t in tasks],
            }
        finally:
            db.close()

    @router.patch("/settings")
    async def update_assistant_settings(payload: AssistantSettingsUpdate, request: Request):
        """在一次调用中更新 CrewMember 字段和/或签到任务。"""
        owner = _owner(request)
        crew = await _get_or_create(owner)
        if not crew:
            raise HTTPException(status_code=500, detail="Assistant not available")

        db = SessionLocal()
        try:
            crew_db = db.query(CrewMember).filter(CrewMember.id == crew.id).first()
            if not crew_db:
                raise HTTPException(status_code=404, detail="Assistant not found")

            # 更新 CrewMember 字段。
            if payload.name is not None:
                crew_db.name = payload.name.strip() or crew_db.name
            if payload.avatar is not None:
                crew_db.avatar = payload.avatar
            if payload.personality is not None:
                crew_db.personality = payload.personality
            if payload.model is not None:
                crew_db.model = payload.model or None
            if payload.endpoint_url is not None:
                crew_db.endpoint_url = payload.endpoint_url or None
            if payload.timezone is not None:
                crew_db.timezone = payload.timezone or None

            # 工具列表：要么是显式列表，要么是隐式开关。
            if payload.enabled_tools is not None:
                crew_db.enabled_tools = json.dumps(payload.enabled_tools)
            if payload.allow_autonomous_email is not None:
                try:
                    existing = json.loads(crew_db.enabled_tools) if crew_db.enabled_tools else []
                except Exception:
                    existing = []
                if payload.allow_autonomous_email:
                    for t in ("send_email", "reply_to_email"):
                        if t not in existing:
                            existing.append(t)
                else:
                    existing = [t for t in existing if t not in _EMAIL_TOOLS]
                crew_db.enabled_tools = json.dumps(existing)

            crew_db.updated_at = datetime.utcnow()

            # 更新签到任务。
            if payload.check_ins:
                now_utc = datetime.utcnow()
                tz_name = crew_db.timezone or None
                for ci in payload.check_ins:
                    task = db.query(ScheduledTask).filter(
                        ScheduledTask.id == ci.id,
                        ScheduledTask.owner == owner,
                        ScheduledTask.crew_member_id == crew_db.id,
                    ).first()
                    if not task:
                        continue
                    if ci.name is not None:
                        task.name = ci.name.strip() or task.name
                    time_changed = False
                    if ci.scheduled_time is not None and ci.scheduled_time != task.scheduled_time:
                        task.scheduled_time = ci.scheduled_time
                        time_changed = True
                    if ci.prompt is not None:
                        task.prompt = ci.prompt
                    if ci.enabled is not None:
                        task.status = "active" if ci.enabled else "paused"
                    if time_changed or ci.enabled is True:
                        task.next_run = compute_next_run(
                            task.schedule or "daily",
                            task.scheduled_time,
                            task.scheduled_day,
                            task.scheduled_date,
                            after=now_utc,
                            cron_expression=task.cron_expression,
                            tz_name=tz_name,
                        )
                    task.updated_at = datetime.utcnow()

            # 时区变更也会改变所有签到的下次运行时间，即使
            # 用户没有修改时间字段。
            if payload.timezone is not None:
                now_utc = datetime.utcnow()
                tz_name = crew_db.timezone or None
                tasks = db.query(ScheduledTask).filter(
                    ScheduledTask.owner == owner,
                    ScheduledTask.crew_member_id == crew_db.id,
                ).all()
                for t in tasks:
                    if t.schedule and t.scheduled_time:
                        t.next_run = compute_next_run(
                            t.schedule, t.scheduled_time, t.scheduled_day, t.scheduled_date,
                            after=now_utc, cron_expression=t.cron_expression, tz_name=tz_name,
                        )

            db.commit()

            # 重新读取 crew_db + tasks 以返回最新状态。
            crew_out = db.query(CrewMember).filter(CrewMember.id == crew.id).first()
            tasks_out = db.query(ScheduledTask).filter(
                ScheduledTask.owner == owner,
                ScheduledTask.crew_member_id == crew.id,
            ).order_by(ScheduledTask.scheduled_time.asc()).all()
            return {
                "crew": _crew_to_dict(crew_out),
                "check_ins": [_task_to_checkin_dict(t) for t in tasks_out],
                "task_ids": [t.id for t in tasks_out],
            }
        finally:
            db.close()

    @router.post("/run/{task_id}")
    async def run_check_in_now(task_id: str, request: Request):
        """立即触发一个助手签到的执行（手动测试）。"""
        owner = _owner(request)
        db = SessionLocal()
        try:
            task = db.query(ScheduledTask).filter(
                ScheduledTask.id == task_id,
                ScheduledTask.owner == owner,
            ).first()
            if not task:
                raise HTTPException(status_code=404, detail="Task not found")
            crew = db.query(CrewMember).filter(
                CrewMember.id == task.crew_member_id,
                CrewMember.is_default_assistant == True,  # noqa: E712
            ).first()
            if not crew:
                raise HTTPException(status_code=400, detail="Not an assistant task")
        finally:
            db.close()
        started = await task_scheduler.run_task_now(task_id)
        return {"started": bool(started)}

    @router.get("/run-status/{task_id}")
    async def run_status(task_id: str, request: Request):
        """检查最近一次任务执行是否已完成。"""
        from core.database import TaskRun, ScheduledTask
        user = _owner(request)
        db = SessionLocal()
        try:
            # 安全：如果任务不属于此用户则返回 404 — 没有此检查，
            # 任何已认证的用户都可以轮询任意 task_id 的状态。
            task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
            if not task:
                raise HTTPException(404, "Task not found")
            if user and task.owner != user:
                raise HTTPException(404, "Task not found")
            run = db.query(TaskRun).filter(
                TaskRun.task_id == task_id,
            ).order_by(TaskRun.started_at.desc()).first()
            if not run:
                return {"status": "unknown"}
            if run.status == "running":
                return {"status": "running"}
            return {"status": "done", "result_status": run.status}
        finally:
            db.close()

    @router.get("/available-timezones")
    async def list_timezones():
        """返回用于填充设置下拉列表的 IANA 时区名称列表。"""
        try:
            from zoneinfo import available_timezones
            zones = sorted(available_timezones())
        except Exception:
            zones = ["UTC"]
        return {"timezones": zones}

    return router
