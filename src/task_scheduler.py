"""后台 ScheduledTask 执行调度器。"""

import asyncio
import json
import logging
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, Tuple

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    """返回任务数据库字段的本地 UTC 时间，不使用已弃用的 API。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ── 共享 TTL 缓存（单飞模式）──────────────────────────────────────
# 同一分钟内触发的多个计划任务通常需要相同的
# 外部数据（Miniflux 未读数、MCP 工具快照等）。此缓存
# 去重这些获取——对相同 key 的并发请求等待
# 同一个底层协程，已完成的结果在 TTL 过期前被复用。
_shared_cache: Dict[Tuple, Tuple[float, Any]] = {}
_shared_cache_pending: Dict[Tuple, asyncio.Future] = {}
_shared_cache_lock = asyncio.Lock()


async def _cached(key: Tuple, ttl: float, fetch: Callable[[], Awaitable[Any]]) -> Any:
    """如果 `key` 的缓存结果尚未过期，返回该结果，否则调用 `fetch()` 并缓存。

    对同一缺失 key 的并发调用者共享一次 `fetch()` 调用。
    异常会传播给所有等待者，不会污染缓存。
    """
    now = time.monotonic()
    async with _shared_cache_lock:
        entry = _shared_cache.get(key)
        if entry and entry[0] > now:
            return entry[1]
        fut = _shared_cache_pending.get(key)
        if fut is not None:
            pending = fut
            owner = False
        else:
            loop = asyncio.get_running_loop()
            fut = loop.create_future()
            _shared_cache_pending[key] = fut
            pending = fut
            owner = True
    if not owner:
        return await pending
    try:
        val = await fetch()
        async with _shared_cache_lock:
            _shared_cache[key] = (time.monotonic() + ttl, val)
            _shared_cache_pending.pop(key, None)
        pending.set_result(val)
        return val
    except Exception as e:
        async with _shared_cache_lock:
            _shared_cache_pending.pop(key, None)
        pending.set_exception(e)
        raise


def compute_next_run(schedule: str, scheduled_time: str,
                     scheduled_day: int = None,
                     scheduled_date: datetime = None,
                     after: datetime = None,
                     cron_expression: str = None,
                     tz_name: str = None) -> datetime | None:
    """根据计划类型计算下一个运行时间（存储为本地 UTC）。

    如果提供了 `tz_name`（IANA 时区，例如 "America/New_York"），`scheduled_time` /
    `scheduled_day` 在该时区中被解释为本地挂钟时间，并且
    结果被转换为本地 UTC 用于数据库存储。如果 `tz_name` 为 None，
    则保留旧版行为（`scheduled_time` 解释为本地 UTC 挂钟），
    以便现有任务不会变化。
    """
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        ZoneInfo = None

    tz = None
    if tz_name and ZoneInfo is not None:
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = None

    # 用于比较的"now"。当设置了 tz 时，我们完全在本地 tz 中工作
    # 并在最后转换为 UTC。否则使用本地 UTC（旧版）。
    if tz is not None:
        now_utc = after or _utcnow()
        if now_utc.tzinfo is None:
            now_utc = now_utc.replace(tzinfo=timezone.utc)
        now = now_utc.astimezone(tz)
    else:
        now = after or _utcnow()

    def _to_utc_naive(dt: datetime) -> datetime:
        """将带时区的 datetime 转换为本地 UTC 用于数据库存储。"""
        if dt.tzinfo is None:
            return dt
        return dt.astimezone(timezone.utc).replace(tzinfo=None)

    if schedule == "cron" and cron_expression:
        try:
            from croniter import croniter
            cron = croniter(cron_expression, now)
            nxt = cron.get_next(datetime)
            if tz is not None and nxt.tzinfo is None:
                nxt = nxt.replace(tzinfo=tz)
            return _to_utc_naive(nxt) if tz is not None else nxt
        except Exception as e:
            logger.warning(f"Invalid cron expression '{cron_expression}': {e}")
            return None

    if schedule == "once":
        if scheduled_date and scheduled_date > (_to_utc_naive(now) if tz is not None else now):
            return scheduled_date
        return None

    if not scheduled_time:
        return None

    # 解析 HH:MM——对格式错误的输入（无冒号、非数字、
    # 超出范围）安全失败，与上面对无效 cron 表达式的处理
    # 方式相同，因此 "9" 或 "9am" 这样的错误值会返回 None 而不是从
    # create 路由中抛出 IndexError/ValueError（返回 500）或在调度器循环中崩溃。
    parts = scheduled_time.split(":")
    try:
        hour, minute = int(parts[0]), int(parts[1])
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError("hour/minute out of range")
    except (ValueError, IndexError):
        logger.warning(f"Invalid scheduled_time '{scheduled_time}'")
        return None

    if schedule == "daily":
        candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        return _to_utc_naive(candidate) if tz is not None else candidate

    if schedule == "weekly":
        day = scheduled_day if scheduled_day is not None else 0  # 0=Monday
        candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        days_ahead = day - candidate.weekday()
        if days_ahead < 0 or (days_ahead == 0 and candidate <= now):
            days_ahead += 7
        candidate += timedelta(days=days_ahead)
        return _to_utc_naive(candidate) if tz is not None else candidate

    if schedule == "monthly":
        day = scheduled_day if scheduled_day is not None else 1
        try:
            candidate = now.replace(day=day, hour=hour, minute=minute, second=0, microsecond=0)
        except ValueError:
            # 短月份：钳制到该月最后一天（镜像下个月
            # 的钳制逻辑），而不是默默跳过整个月。
            if now.month == 12:
                last = now.replace(year=now.year + 1, month=1, day=1) - timedelta(days=1)
            else:
                last = now.replace(month=now.month + 1, day=1) - timedelta(days=1)
            candidate = last.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= now:
            if now.month == 12:
                next_month = now.replace(year=now.year + 1, month=1, day=1)
            else:
                next_month = now.replace(month=now.month + 1, day=1)
            try:
                candidate = next_month.replace(day=day, hour=hour, minute=minute, second=0, microsecond=0)
            except ValueError:
                if next_month.month == 12:
                    last = next_month.replace(year=next_month.year + 1, month=1, day=1) - timedelta(days=1)
                else:
                    last = next_month.replace(month=next_month.month + 1, day=1) - timedelta(days=1)
                candidate = last.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return _to_utc_naive(candidate) if tz is not None else candidate

    return None


def _resolve_task_timezone(db, task) -> str | None:
    """通过任务关联的 CrewMember 查找其 IANA 时区名称（如果存在）。"""
    if not getattr(task, "crew_member_id", None):
        return None
    try:
        from core.database import CrewMember
        cm = db.query(CrewMember).filter(CrewMember.id == task.crew_member_id).first()
        if cm and cm.timezone:
            return cm.timezone
    except Exception:
        pass
    return None


# 为每个所有者创建的内置"维护"任务，按操作索引。
# 这些是标准默认值——既用于创建，也用于还原
# 用户修改过的内置任务。schedule "daily" 使用 scheduled_time；
# "cron" 使用 cron_expression。
HOUSEKEEPING_DEFAULTS = {
    "tidy_sessions":        {"name": "Chat Sessions Tidy",       "trigger_type": "event", "trigger_event": "session_created", "trigger_count": 5, "schedule": None, "scheduled_time": None, "cron_expression": None, "legacy_names": ["Tidy Chat Sessions"]},
    "tidy_documents":       {"name": "Documents Tidy",           "trigger_type": "event", "trigger_event": "document_created", "trigger_count": 5, "schedule": None, "scheduled_time": None, "cron_expression": None, "legacy_names": ["Tidy Documents"]},
    "consolidate_memory":   {"name": "Memory Tidy",              "trigger_type": "event", "trigger_event": "memory_added", "trigger_count": 5, "schedule": None, "scheduled_time": None, "cron_expression": None, "legacy_names": ["Tidy Memory"]},
    "tidy_research":        {"name": "Research Tidy",            "trigger_type": "event", "trigger_event": "research_completed", "trigger_count": 5, "schedule": None, "scheduled_time": None, "cron_expression": None, "legacy_names": ["Tidy Research"]},
    "summarize_emails":     {"name": "Email (Summary)",          "schedule": "cron",  "scheduled_time": None,    "cron_expression": "0 */2 * * *", "ship_paused": True, "legacy_names": ["Tidy Email (Summary)"]},
    "draft_email_replies":  {"name": "Email AI Auto Reply",      "schedule": "cron",  "scheduled_time": None,    "cron_expression": "0 */2 * * *", "ship_paused": True, "legacy_names": ["Tidy Email (Replies)", "AI Auto Reply"]},
    "extract_email_events": {"name": "Email Calendar Events",    "schedule": "cron",  "scheduled_time": None,    "cron_expression": "0 */1 * * *", "ship_paused": True, "legacy_names": ["Email → Calendar Events"]},
    "classify_events":      {"name": "Calendar Classify Events", "schedule": "cron",  "scheduled_time": None,    "cron_expression": "0 6,18 * * *", "ship_paused": True, "legacy_names": ["Classify Calendar Events"]},
    "check_email_urgency":   {"name": "Email Tags",               "schedule": "cron",  "scheduled_time": None,    "cron_expression": "0 * * * *", "ship_paused": True, "old_cron_expressions": ["*/15 * * * *"], "legacy_names": ["Email Triage", "Urgent Email"]},
    "audit_skills":          {"name": "Skills Audit",             "trigger_type": "event", "trigger_event": "skill_added", "trigger_count": 5, "schedule": None, "scheduled_time": None, "cron_expression": None, "legacy_names": ["Audit Skills"]},
}

RETIRED_HOUSEKEEPING_ACTIONS = frozenset({
    "tidy_calendar",
    "tidy_email_inbox",
    "mark_email_boundaries",
})


def _digest_windows(now):
    """日历签到摘要的 (label, start, end) 时间段。

    时间段是连续的，这样不会有时段间隙遗漏事件——
    早期版本 30 天窗口从 now+8d 开始而周窗口
    在 now+7d 结束，导致约 7-8 天后的事件落入任何时段。
    """
    return [
        ("today_tomorrow", now, now + timedelta(days=2)),
        ("this_week", now + timedelta(days=2), now + timedelta(days=7)),
        ("next_30_days", now + timedelta(days=7), now + timedelta(days=30)),
    ]


class TaskScheduler:
    def __init__(self, session_manager):
        self._session_manager = session_manager
        self._running = False
        self._task = None
        self._executing = set()  # 当前正在运行或排队等待信号量的任务 ID
        # 保护 _executing 的变更。_check_due_tasks 在循环
        # 协程中运行；trigger_task() 可从请求处理器调用；
        # 事件总线从后台任务触发。没有此锁，长时间运行
        # 的任务可能被重复分发。
        self._executing_lock = asyncio.Lock()
        self._pending_notifications = []  # 已完成任务的通知
        self._task_defer_counts = {}
        # 严格串行执行——一次仅运行一个任务。其他任何操作
        #（手动触发、计划分发、任务链）在
        # 信号量后面以"已排队"状态等待，当前运行完成时开始。
        # 这是硬性保证，不可配置。
        self._run_semaphore = asyncio.Semaphore(1)
        self._concurrency_cap = 1
        self._task_handles = {}

    def _set_run_progress(self, run_id: str, message: str):
        """在运行期间持久化 Activity 的简短实时进度文本。"""
        if not run_id:
            return
        try:
            from core.database import SessionLocal, TaskRun
            db = SessionLocal()
            try:
                run = db.query(TaskRun).filter(TaskRun.id == run_id).first()
                if run and run.status in ("queued", "running"):
                    run.result = (message or "")[:4000]
                    db.commit()
            finally:
                db.close()
        except Exception:
            logger.debug("Task progress update failed", exc_info=True)

    def _mark_run_aborted(self, task_id: str, run_id: str | None = None, message: str = "Stopped by user") -> bool:
        """将运行中的任务标记为已中止。由停止/取消路径使用。"""
        try:
            from core.database import SessionLocal, TaskRun
            db = SessionLocal()
            try:
                q = db.query(TaskRun)
                if run_id:
                    q = q.filter(TaskRun.id == run_id)
                else:
                    q = q.filter(
                        TaskRun.task_id == task_id,
                        TaskRun.status.in_(("queued", "running")),
                    ).order_by(TaskRun.started_at.desc())
                run = q.first()
                if not run or run.status not in ("queued", "running"):
                    return False
                run.status = "aborted"
                run.error = message
                run.result = run.result or message
                run.finished_at = _utcnow()
                db.commit()
                return True
            finally:
                db.close()
        except Exception:
            logger.debug("Task abort marker failed for %s", task_id, exc_info=True)
            return False

    def add_notification(self, task_name: str, status: str, task_id: str = None, owner: str = None, body: str = None):
        """存储已完成任务运行的通知。标记了任务的
        所有者，因此 `pop_notifications` 只能返回该用户的
        通知，防止跨租户泄漏。`body` 是结果
        文本——当 output_target='notification' 时填充，以便客户端可以
        显示丰富的浏览器 Notification，而不仅仅是一个 toast。"""
        self._pending_notifications.append({
            "task_name": task_name,
            "status": status,
            "task_id": task_id,
            "owner": owner,
            "body": (body[:500] + "…") if body and len(body) > 500 else body,
            "timestamp": _utcnow().isoformat() + "Z",
        })
        # 限制在 50 条以内，避免无限增长
        if len(self._pending_notifications) > 50:
            self._pending_notifications = self._pending_notifications[-50:]

    def pop_notifications(self, owner: str = None) -> list:
        """返回并清除待处理的通知。

        当 `owner` 被设置时，仅返回（并清除）匹配的通知。
        在所有者标记出现之前存储的通知（或来自无所有者
        任务的通知）在调用者为匿名或未提供所有者过滤器时
        被包含——保留旧版单用户部署的向后兼容行为。
        """
        if owner is None:
            notes = self._pending_notifications[:]
            self._pending_notifications.clear()
            return notes
        # 严格所有者范围——之前为了"旧版单用户"兼容性而
        # 混入无所有者通知，但这会在存在第二个账户后将
        # 通知正文泄漏给任何已认证用户。
        keep, take = [], []
        for n in self._pending_notifications:
            if n.get("owner") == owner:
                take.append(n)
            else:
                keep.append(n)
        self._pending_notifications = keep
        return take

    async def start(self):
        # 启动时，将任何残留的 "running" 状态的 task_runs 标记为已中止。
        # 没有此操作，服务器崩溃会导致行永久卡在运行状态，而
        # _executing 内存集合会忘记它们，导致 UI 显示幽灵任务。
        try:
            from core.database import SessionLocal, TaskRun
            db = SessionLocal()
            try:
                # 来自先前服务器崩溃的僵尸任务。标记为 "aborted"（不是
                # "error"），这样 Activity 视图和错误率统计不会
                # 错误地将基础设施事件归咎于任务。
                stale = db.query(TaskRun).filter(
                    TaskRun.status.in_(("running", "queued"))
                ).all()
                if stale:
                    now = _utcnow()
                    for r in stale:
                        old_status = r.status or "running"
                        r.status = "aborted"
                        r.error = "Server restarted while task was " + old_status
                        r.finished_at = now
                    db.commit()
                    logger.info(f"已清除上次运行遗留的 {len(stale)} 个过期 task_runs")
            finally:
                db.close()
        except Exception as e:
            logger.warning(f"启动时无法清除过期 task_runs：{e}")

        # 将已过期的活跃任务的 next_run 向前推进。
        # 没有此操作，重启时 _check_due_tasks() 遇到空的
        # 进程内 _executing 集合，同一过期任务将在每次
        # 轮询时触发一次直到完成。
        try:
            from core.database import SessionLocal as _SL, ScheduledTask as _ST
            db = _SL()
            try:
                now = _utcnow()
                overdue = db.query(_ST).filter(
                    _ST.status == "active",
                    _ST.next_run.isnot(None),
                    _ST.next_run < now,
                ).all()
                if overdue:
                    for t in overdue:
                        t.next_run = now + timedelta(seconds=60)
                    db.commit()
                    logger.info(
                        "启动时已将 %d 个过期活跃任务的 next_run 向前推进 60 秒",
                        len(overdue),
                    )
            finally:
                db.close()
        except Exception as e:
            logger.warning(f"启动时无法推进过期 next_run：{e}")

        # 纵深防御去重扫描：对于拥有 >1 行 is_default_assistant=True
        # 记录的任何所有者，保留最旧的一条并删除其余的
        # 以及它们孤立的签到任务。这是针对
        # 合成所有者创建 bug 的安全网（我们清理了手动实例，
        # 但过时的代码路径或数据库导入可能会重现它）。
        try:
            from core.database import SessionLocal, CrewMember, ScheduledTask
            db = SessionLocal()
            try:
                from sqlalchemy import func
                groups = db.query(CrewMember.owner, func.count(CrewMember.id).label("n")).filter(
                    CrewMember.is_default_assistant == True,  # noqa: E712
                ).group_by(CrewMember.owner).having(func.count(CrewMember.id) > 1).all()
                for owner, n in groups:
                    rows = db.query(CrewMember).filter(
                        CrewMember.owner == owner,
                        CrewMember.is_default_assistant == True,  # noqa: E712
                    ).order_by(CrewMember.created_at.asc()).all()
                    keep = rows[0]
                    losers = rows[1:]
                    loser_ids = [r.id for r in losers]
                    # 删除与淘汰 crew 关联的孤立任务——它们
                    # 是保留者签到的重复项。
                    n_tasks = db.query(ScheduledTask).filter(
                        ScheduledTask.crew_member_id.in_(loser_ids)
                    ).delete(synchronize_session=False)
                    for r in losers:
                        db.delete(r)
                    db.commit()
                    logger.warning(
                        "默认助手去重：owner=%r 有 %d 行，保留了 %s，"
                        "删除了 %d 个 crew + %d 个孤立任务",
                        owner, n, keep.id, len(losers), n_tasks,
                    )
            finally:
                db.close()
        except Exception as e:
            logger.warning(f"启动时无法去重默认助手行：{e}")

        self._running = True
        self._task = asyncio.create_task(self._loop())
        # 内部后台扫描器，不是面向用户的"任务"——纯
        # 基础设施（无 LLM），不应在任务 UI 中显示，按自己的
        # 频率在调度器进程内触发。
        #
        # 日历事件提醒在日历 UI 中表现为 Notes，
        # 因此 Notes 扫描器是唯一的提醒分发路径。同时运行
        # 旧的事件扫描器会导致同一日历事件
        # 发送重复邮件/通知。
        self._note_pings_task = asyncio.create_task(self._note_pings_loop())
        logger.info(f"任务调度器已启动（并发上限：{self._concurrency_cap})")
        # 审计集群：显示一天中任何分钟有 >1 个活跃计划
        # 任务落定时段。帮助发现用户可能需要
        # 分散开的"所有任务在 9 点触发"模式。
        try:
            from core.database import SessionLocal, ScheduledTask
            db = SessionLocal()
            try:
                rows = db.query(ScheduledTask).filter(
                    ScheduledTask.status == "active",
                    ScheduledTask.trigger_type == "schedule",
                    ScheduledTask.next_run.isnot(None),
                ).all()
                buckets: Dict[str, list] = {}
                for r in rows:
                    if not r.next_run:
                        continue
                    key = r.next_run.strftime("%H:%M")
                    buckets.setdefault(key, []).append(r.name or r.id)
                clusters = {k: v for k, v in buckets.items() if len(v) > 1}
                if clusters:
                    summary = ", ".join(f"{k} ({len(v)})" for k, v in sorted(clusters.items()))
                    logger.info(f"任务调度集群（>1 个任务/分钟）：{summary}")
            finally:
                db.close()
        except Exception as e:
            logger.debug(f"群集审计已跳过：{e}")

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        for attr in ("_note_pings_task", "_event_pings_task"):
            t = getattr(self, attr, None)
            if t:
                t.cancel()
                try: await t
                except asyncio.CancelledError: pass
        logger.info("任务调度器已停止")

    async def _note_pings_loop(self):
        """内置笔记到期扫描器——在调度器内每 60 秒触发一次。
        纯基础设施（无 LLM），不会显示在任务 UI 中。逐所有者
        迭代，以便 `action_ping_notes` 中的缓存清理（移除
        不在当前扫描 seen_ids 中的笔记缓存条目）不会
        跨用户删除其他用户的条目（见 review C4）。
        """
        await asyncio.sleep(30)
        from src.builtin_actions import action_ping_notes, TaskNoop
        while self._running:
            owners = self._known_task_owners()
            for ow in (owners or [""]):
                try:
                    await action_ping_notes(owner=ow)
                except TaskNoop:
                    pass
                except Exception as e:
                    logger.warning(f"ping_notes background scanner errored for owner={ow!r}: {e}")
            await asyncio.sleep(60)  # 1 分钟

    async def _event_pings_loop(self):
        """内置日历事件扫描器——与笔记提醒相同的方案。每
        10 分钟运行一次，通过 dispatch_reminder 触发提醒。不是用户任务。
        逐所有者迭代，使每个用户只收到自己的日历提醒
        （全局传递 owner="" 会将用户 B 的事件通过用户 A
        配置的 SMTP "from" 地址发送——见 review C3）。
        """
        await asyncio.sleep(90)
        from src.builtin_actions import action_ping_events, TaskNoop
        while self._running:
            owners = self._known_task_owners()
            for ow in (owners or [""]):
                try:
                    await action_ping_events(owner=ow)
                except TaskNoop:
                    pass
                except Exception as e:
                    logger.warning(f"ping_events background scanner errored for owner={ow!r}: {e}")
            await asyncio.sleep(600)  # 10 分钟

    def _known_task_owners(self) -> list:
        """后台扫描器应访问的所有不同非空所有者。

        计划任务曾经是唯一的用户来源。但日历提醒
        存储为 Notes，因此拥有到期笔记但没有任务
        行的账户可能收到浏览器提醒，而后台邮件/ntfy
        扫描器从未为该用户运行。
        """
        from core.database import SessionLocal, ScheduledTask, Note
        db = SessionLocal()
        try:
            owners = set()
            for r in db.query(ScheduledTask.owner).distinct().all():
                if r[0]:
                    owners.add(r[0])
            note_q = db.query(Note.owner).filter(
                Note.due_date.isnot(None),
                Note.due_date != "",
                Note.archived == False,  # noqa: E712
            ).distinct()
            for r in note_q.all():
                if r[0]:
                    owners.add(r[0])
            return sorted(owners)
        except Exception:
            return []
        finally:
            db.close()

    async def _loop(self):
        await asyncio.sleep(10)
        while self._running:
            try:
                await self._check_due_tasks()
            except Exception:
                logger.exception("Error in task scheduler loop")
            # 休眠到下次计划运行，最多 60 秒。之前的 `* * * * *`
            # cron 任务可能延迟最多约 60 秒触发，因为总是
            # 休眠完整的一分钟；现在循环会在边界附近唤醒。
            sleep_for = 60.0
            try:
                from core.database import SessionLocal as _SL, ScheduledTask as _ST
                _db = _SL()
                try:
                    next_run = _db.query(_ST.next_run).filter(
                        _ST.status == "active",
                        _ST.next_run.isnot(None),
                    ).order_by(_ST.next_run.asc()).first()
                    if next_run and next_run[0]:
                        delta = (next_run[0] - _utcnow()).total_seconds()
                        sleep_for = max(1.0, min(60.0, delta))
                finally:
                    _db.close()
            except Exception:
                pass
            await asyncio.sleep(sleep_for)

    async def _check_due_tasks(self):
        from core.database import SessionLocal, ScheduledTask
        db = SessionLocal()
        try:
            now = _utcnow()
            async with self._executing_lock:
                # 在锁内做快照，避免与迭代中途的添加操作竞争。
                executing_snapshot = set(self._executing)
                # 计划任务和延迟事件任务都使用 next_run。
                due = db.query(ScheduledTask).filter(
                    ScheduledTask.status == "active",
                    ScheduledTask.next_run <= now,
                    ScheduledTask.id.notin_(executing_snapshot) if executing_snapshot else True,
                ).all()
                to_dispatch = []
                for task in due:
                    if task.id in self._executing:
                        continue
                    self._executing.add(task.id)
                    to_dispatch.append(task.id)
            for task_id in to_dispatch:
                asyncio.create_task(self._execute_task(task_id))
        finally:
            db.close()

    async def _execute_task(self, task_id: str, *, bypass_model_slot: bool = False, release_executing: bool = True):
        # 在等待信号量之前创建 status="queued" 的运行记录，
        # 以便 UI 能显示手动触发的任务正在排队等待。
        # 获取到信号量后，翻转为 "running" 
        # 并转交给 _execute_task_locked。
        from core.database import SessionLocal, TaskRun
        current = asyncio.current_task()
        if current:
            self._task_handles[task_id] = current
        run_id = str(uuid.uuid4())
        _q_db = SessionLocal()
        try:
            run = TaskRun(
                id=run_id,
                task_id=task_id,
                started_at=_utcnow(),
                status="queued",
                result="已排队——等待空闲槽位…",
            )
            _q_db.add(run)
            _q_db.commit()
        except Exception:
            logger.exception(f"无法为任务 {task_id} 创建排队运行行")
        finally:
            _q_db.close()

        try:
            if bypass_model_slot or not self._task_needs_model_slot(task_id):
                await self._execute_task_locked(task_id, run_id, release_executing=release_executing)
                return

            async with self._run_semaphore:
                await self._execute_task_locked(task_id, run_id, release_executing=release_executing)
        except asyncio.CancelledError:
            # 如果取消发生在排队等待信号量的过程中，
            # _execute_task_locked 永远不会运行，无法更新 Activity 行。
            self._mark_run_aborted(task_id, run_id)
            raise
        finally:
            handle = self._task_handles.get(task_id)
            if handle is current:
                self._task_handles.pop(task_id, None)
            if release_executing:
                async with self._executing_lock:
                    self._executing.discard(task_id)

    async def _execute_task_locked(self, task_id: str, run_id: str, *, release_executing: bool = True):
        from core.database import SessionLocal, ScheduledTask, TaskRun

        db = SessionLocal()
        try:
            task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
            if not task or task.status != "active":
                # 任务在排队期间被暂停/删除——记录此结果
                # 以使运行行不会永远停留在 "queued" 状态。
                stale = db.query(TaskRun).filter(TaskRun.id == run_id).first()
                if stale and stale.status == "queued":
                    stale.status = "skipped"
                    stale.finished_at = _utcnow()
                    stale.error = f"任务不再活跃（status={task.status if task else '已删除'})"
                    db.commit()
                return

            # 将运行从 queued 翻转为 running。重置 started_at 为
            # 实际执行开始时间，以便排队等待时间
            # 可在 created_at 与 started_at 之间体现。
            run = db.query(TaskRun).filter(TaskRun.id == run_id).first()
            if run:
                run.status = "running"
                run.started_at = _utcnow()
                run.result = "开始…"
                db.commit()
            else:
                # 防御性：行可能已被清除；重新创建以使代码
                # 其余部分可以通过 run_id 查找而不会崩溃。
                run = TaskRun(
                    id=run_id,
                    task_id=task.id,
                    started_at=_utcnow(),
                    status="running",
                    result="Starting…",
                )
                db.add(run)
                db.commit()

            task_type = task.task_type or "llm"

            from src.builtin_actions import TaskDeferred, TaskNoop

            # 每次运行清空，这样 action 任务（无模型）不会继承上次
            # llm/research 运行的模型。一旦模型解析完成，
            # 执行器会设置它。
            self._last_run_model = None
            try:
                if task_type == "action":
                    result, success = await self._execute_action(task, run_id=run_id)
                    run.status = "success" if success else "error"
                    run.result = result
                    if not success:
                        run.error = result
                elif task_type == "research":
                    result = await self._execute_research_task(task, db)
                    run.status = "success"
                    run.result = result
                else:
                    # LLM 任务——使用代理循环获取工具访问
                    result = await self._execute_llm_task(task, db)
                    run.status = "success"
                    run.result = result
                # 记录实际运行的模型（在执行器内部解析）。
                if getattr(self, "_last_run_model", None):
                    run.model = self._last_run_model
                if run.status == "success":
                    await self._deliver_task_result(task, result, db, model=getattr(self, "_last_run_model", None))
            except TaskDeferred as defer:
                count = self._task_defer_counts.get(task_id, 0) + 1
                self._task_defer_counts[task_id] = count
                delay_seconds = int(getattr(defer, "delay_seconds", 20 * 60) or (20 * 60))
                if count > 2:
                    delay_seconds = max(delay_seconds, 40 * 60)
                when = _utcnow() + timedelta(seconds=delay_seconds)
                logger.info(
                    "Task '%s' deferred for %ss after %s quiet-window hit(s): %s",
                    task.name, delay_seconds, count, defer,
                )
                run_obj = db.query(TaskRun).filter(TaskRun.id == run_id).first()
                if run_obj:
                    db.delete(run_obj)
                task.next_run = when
                db.commit()
                return
            except asyncio.CancelledError:
                logger.info("任务 '%s' 已被用户停止", task.name)
                run_obj = db.query(TaskRun).filter(TaskRun.id == run_id).first()
                if run_obj:
                    run_obj.status = "aborted"
                    run_obj.error = "已被用户停止"
                    run_obj.result = run_obj.result or "已被用户停止"
                    run_obj.finished_at = _utcnow()
                task.last_run = _utcnow()
                if (task.trigger_type or "schedule") == "schedule":
                    task.next_run = compute_next_run(
                        task.schedule, task.scheduled_time,
                        task.scheduled_day, task.scheduled_date,
                        after=_utcnow(),
                        cron_expression=task.cron_expression,
                        tz_name=_resolve_task_timezone(db, task),
                    )
                else:
                    task.next_run = None
                db.commit()
                return
            except TaskNoop as noop:
                # 操作报告"无操作"。将运行状态标记为 `skipped`，
                # 并将原因放入 `result`，使其在活动记录中显示为
                # 简洁的"已跳过 — <原因>"行，而不是默默消失。
                #（之前的行为是 `db.delete(run)`，使用户
                # 以为排队的任务被丢弃了。）
                logger.info(f"Task '{task.name}' no-op: {noop}")
                run.status = "skipped"
                run.result = str(noop)
                run.finished_at = _utcnow()
                task.last_run = _utcnow()
                if (task.trigger_type or "schedule") == "schedule":
                    task.next_run = compute_next_run(
                        task.schedule, task.scheduled_time,
                        task.scheduled_day, task.scheduled_date,
                        after=_utcnow(),
                        cron_expression=task.cron_expression,
                        tz_name=_resolve_task_timezone(db, task),
                    )
                else:
                    task.next_run = None
                db.commit()
                return

            run.finished_at = _utcnow()

            # 更新任务
            task.last_run = _utcnow()
            task.run_count = (task.run_count or 0) + 1
            self._task_defer_counts.pop(task_id, None)

            # 仅对计划触发的任务计算下次运行时间
            if (task.trigger_type or "schedule") == "schedule":
                task.next_run = compute_next_run(
                    task.schedule, task.scheduled_time,
                    task.scheduled_day, task.scheduled_date,
                    after=_utcnow(),
                    cron_expression=task.cron_expression,
                    tz_name=_resolve_task_timezone(db, task),
                )
                if task.next_run is None and task.schedule == "once":
                    task.status = "completed"
            else:
                task.next_run = None

            db.commit()
            logger.info(f"Task '{task.name}' completed (run {run_id})")
            output = task.output_target or "session"
            # 每任务通知门控。默认 True（notifications_enabled
            # 在列级别默认为 True），但当用户
            # 明确为此任务关闭时跳过——静默嘈杂的
            # 日常维护 cron 任务，而无需完全禁用它们。
            should_notify = (
                (task.task_type or "llm") in {"llm", "research"}
                and getattr(task, "notifications_enabled", True)
            )
            if should_notify:
                self.add_notification(
                    task.name,
                    run.status,
                    task_id,
                    owner=task.owner,
                    body=run.result if output == "notification" else None,
                )

            # 将结果记录到助手聊天中，使所有任务活动可见。
            # 跳过 skipped/error 行——用户不应看到 "skipped: …" 噪音，
            # 或是已经触发错误通知的任务的重复错误。
            if run.status == "success":
                self._log_to_assistant(db, task, run.result or "[success]")

            # 任务链——成功后触发下一个任务
            if run.status == "success" and task.then_task_id:
                chain_id = task.then_task_id
                chain_task = db.query(ScheduledTask).filter(ScheduledTask.id == chain_id).first()
                if not chain_task or chain_task.owner != task.owner:
                    logger.warning(
                        "跳过来自 %r 的任务链：目标任务 %s 不存在或不属于 %r",
                        task.name, chain_id, task.owner,
                    )
                elif not self._has_chain_cycle(db, chain_id, owner=task.owner):
                    logger.info(f"Chaining: '{task.name}' → task {chain_id}")
                    asyncio.create_task(self._run_chained(chain_id))
                else:
                    logger.warning(f"Skipping chain from '{task.name}': cycle detected")

        except Exception as exec_exc:
            logger.exception(f"任务 {task_id} 执行出错")
            # 获取任务的所有者，以便错误通知能够
            # 到达成功通知本应发送的同一用户。
            _owner = None
            try:
                _t = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
                _owner = _t.owner if _t else None
            except Exception:
                pass
            _should_notify_error = False
            try:
                _t_for_notify = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
                _should_notify_error = (
                    bool(_t_for_notify)
                    and (_t_for_notify.task_type or "llm") in {"llm", "research"}
                    and getattr(_t_for_notify, "notifications_enabled", True)
                )
            except Exception:
                _should_notify_error = False
            if _should_notify_error:
                self.add_notification(f"Task {task_id}", "error", task_id, owner=_owner)
            try:
                # 持久化实际的异常消息，以便 UI 能够显示
                err_text = f"{type(exec_exc).__name__}: {exec_exc}"
                run_obj = db.query(TaskRun).filter(TaskRun.id == run_id).first()
                if run_obj and run_obj.status in ("running", "success"):
                    run_obj.status = "error"
                    run_obj.error = err_text[:2000]
                    run_obj.finished_at = _utcnow()
                # 即使在失败时也推进 next_run，这样损坏的任务就不会
                # 以过期的过去日期在每次 tick 时忙循环调度器。
                task_obj = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
                if task_obj and (task_obj.trigger_type or "schedule") == "schedule":
                    task_obj.last_run = _utcnow()
                    try:
                        task_obj.next_run = compute_next_run(
                            task_obj.schedule, task_obj.scheduled_time,
                            task_obj.scheduled_day, task_obj.scheduled_date,
                            after=_utcnow(),
                            cron_expression=task_obj.cron_expression,
                            tz_name=_resolve_task_timezone(db, task_obj),
                        )
                    except Exception:
                        pass
                try:
                    db.commit()
                except Exception as commit_err:
                    # 提交失败——没有后备时，运行行保持
                    # "running" 永远，且 next_run 停留在过去，因此
                    # 调度器在每个 tick 都会忙循环分发同一任务
                    # 直到重启。在新的会话中强制执行恢复。
                    logger.warning("任务 %s 错误路径提交失败：%s——执行后备", task_id, commit_err)
                    try:
                        db.rollback()
                    except Exception:
                        pass
                    from datetime import timedelta as _td
                    _recover_db = SessionLocal()
                    try:
                        _r = _recover_db.query(TaskRun).filter(TaskRun.id == run_id).first()
                        if _r and _r.status in ("running", "queued"):
                            _r.status = "aborted"
                            _r.error = f"提交失败：{type(commit_err).__name__}：{commit_err}"[:2000]
                            _r.finished_at = _utcnow()
                        _t = _recover_db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
                        if _t and (_t.trigger_type or "schedule") == "schedule":
                            # 向前推进 next_run 5 分钟作为安全停顿，使
                            # 调度器不会立即重新分发。
                            _t.next_run = _utcnow() + _td(minutes=5)
                            _t.last_run = _utcnow()
                        _recover_db.commit()
                    except Exception as recover_err:
                        logger.error("任务 %s 恢复提交也失败了：%s", task_id, recover_err)
                    finally:
                        _recover_db.close()
            except Exception:
                logger.exception("任务 %s 错误路径意外失败", task_id)
        finally:
            db.close()
            handle = self._task_handles.get(task_id)
            if handle is asyncio.current_task():
                self._task_handles.pop(task_id, None)
            if release_executing:
                async with self._executing_lock:
                    self._executing.discard(task_id)



    # 输出是纯基础设施（无面向用户的内容）的内置维护操作
    # ——不要用其摘要污染助手聊天会话。
    # 活动日志 + 提醒邮件已经包含用户所需的所有内容。
    _SILENT_ACTIONS = frozenset({
        "check_email_urgency",
        "learn_sender_signatures",
        "summarize_emails",
        "draft_email_replies",
        "extract_email_events",
        "classify_events",
        "tidy_sessions",
        "tidy_documents",
        "consolidate_memory",
        "tidy_research",
        "test_skills",
        "audit_skills",
    })

    _MODEL_BACKED_ACTIONS = frozenset({
        "summarize_emails",
        "draft_email_replies",
        "extract_email_events",
        "classify_events",
        "learn_sender_signatures",
        "check_email_urgency",
        "test_skills",
        "audit_skills",
        "consolidate_memory",
    })

    def _task_needs_model_slot(self, task_id: str) -> bool:
        """仅 LLM/research/模型驱动的操作应在模型队列中等待。
        纯维护操作可以立即运行。"""
        from core.database import SessionLocal, ScheduledTask

        db = SessionLocal()
        try:
            task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
            if not task:
                return True
            task_type = getattr(task, "task_type", "") or "llm"
            if task_type != "action":
                return True
            return (getattr(task, "action", "") or "") in self._MODEL_BACKED_ACTIONS
        finally:
            db.close()

    def _log_to_assistant(self, db, task, result_text: str):
        """将任务结果记录到助手的聊天会话中。"""
        # 不要重复记录签到（它们已直接保存）
        if "check-in" in (task.name or "").lower():
            return
        # 内置维护噪音不进入聊天。
        if (getattr(task, "action", "") or "") in self._SILENT_ACTIONS:
            return
        from src.assistant_log import log_to_assistant
        log_to_assistant(
            task.owner,
            result_text[:1000],
            category=(task.name or "Task"),
        )

    async def _execute_action(self, task, run_id: str | None = None) -> tuple:
        """执行内置操作（不需要 LLM）。"""
        from src.builtin_actions import BUILTIN_ACTIONS

        action_fn = BUILTIN_ACTIONS.get(task.action)
        if not action_fn:
            return f"未知操作：{task.action}", False

        from src.builtin_actions import TaskNoop
        try:
            # 将任务 prompt 作为脚本/命令传递给 ssh_command/run_script 操作。
            def _progress(message: str):
                self._set_run_progress(run_id, message)

            kwargs = {"owner": task.owner, "task_name": task.name, "progress_cb": _progress}
            if task.action in ("run_script", "run_local", "ssh_command") and task.prompt:
                kwargs["script" if task.action in ("run_script", "run_local") else "command"] = task.prompt
            # cookbook_serve 在 task.prompt 中携带其 JSON 配置——通过
            # `command` 参数传递，以便 action_cookbook_serve 可以 json.loads 它。
            elif task.action == "cookbook_serve" and task.prompt:
                kwargs["command"] = task.prompt
            result, success = await action_fn(**kwargs)
            return result, success
        except TaskNoop:
            # 向上抛出以便 _execute_task_locked 可以默默删除运行行。
            raise
        except Exception as e:
            logger.error(f"Action '{task.action}' failed: {e}")
            return str(e), False

    # ── 签到数据源发现 ──
    # 基于模式：如果 MCP 服务器包含匹配模式的特征工具，它就成为一个
    # 签到数据源。在此添加新模式即可支持新的集成——
    # 无需修改其他代码。
    CHECKIN_MCP_PATTERNS = [
        {"detect": "list_emails",   "section": "Email",    "tool": "list_emails",
         "args": {"mailbox": "INBOX", "limit": 10, "unread_only": True},
         "label_from_identity": True,
         "formatter": "_format_email_output"},
        {"detect": "search_emails", "section": "Email",    "tool": "search_emails",
         "args": {"query": "is:unread", "limit": 10},
         "label_from_identity": True,
         "formatter": "_format_email_output"},
        {"detect": "get_feed",      "section": "RSS",      "tool": "get_feed",
         "args": {},
         "label_from_identity": False},
        {"detect": "list_feeds",    "section": "RSS",      "tool": "list_feeds",
         "args": {},
         "label_from_identity": False},
        {"detect": "list_messages", "section": "Messages", "tool": "list_messages",
         "args": {"limit": 10},
         "label_from_identity": True},
    ]

    @staticmethod
    def _format_email_output(raw: str) -> str:
        """将原始 MCP 邮件列表输出整理为可读格式。"""
        import re as _re
        lines = []
        for line in raw.split("\n"):
            line = line.strip()
            if not line:
                continue
            # 跳过标题行，如 "📬 [INBOX] 856 emails..."
            if line.startswith(("\U0001f4ec", "📬", "No emails", "---", "Page ")):
                continue
            # 跳过 "more pages available" 等
            if "page" in line.lower() and "/" in line:
                continue
            # 解析：[1778] Re: Subject From: Name | Date
            m = _re.match(r'\[?\d+\]?\s*(?:↩️\s*|📎\s*|🔵\s*|⭐\s*)?(.+?)(?:\s*From:\s*(.+?))?(?:\s*\|\s*(\S+))?$', line)
            if m:
                subject = m.group(1).strip().rstrip('|').strip()
                sender = (m.group(2) or "").strip().rstrip('|').strip()
                if sender:
                    lines.append(f"- {sender} — {subject}")
                else:
                    lines.append(f"- {subject}")
            elif line.startswith("[") or line.startswith("-"):
                # 通用清理
                cleaned = _re.sub(r'^\[?\d+\]?\s*(?:↩️\s*|📎\s*)?', '', line.lstrip('- '))
                if cleaned.strip():
                    lines.append(f"- {cleaned.strip()}")
        if not lines:
            return "无未读邮件"
        return "\n".join(lines[:10])

    async def _execute_checkin(self, task, crew, db, session_id: str,
                               endpoint_url: str, model: str) -> str:
        """从所有集成收集原始数据，交给 LLM 生成签到报告。"""
        from src.tool_implementations import do_manage_notes
        from src.tool_utils import get_mcp_manager

        tz_name = _resolve_task_timezone(db, task)
        try:
            if tz_name:
                from zoneinfo import ZoneInfo
                from datetime import timezone, timedelta
                now = _utcnow().replace(tzinfo=timezone.utc).astimezone(ZoneInfo(tz_name))
            else:
                from datetime import timedelta
                now = _utcnow()
            time_str = now.strftime("%A, %B %d %Y, %H:%M")
        except Exception:
            from datetime import timedelta
            now = _utcnow()
            time_str = now.strftime("%H:%M UTC")

        raw = {}

        # 日历：今明两天、本周、未来一个月
        # 直接从数据库拉取，以便包含 event_type 和 importance。
        try:
            from core.database import SessionLocal as _SL, CalendarEvent as _CE
            _db = _SL()
            try:
                for label, start, end in _digest_windows(now):
                    # 去掉时区信息用于本地数据库比较
                    _s = start.replace(tzinfo=None) if start.tzinfo else start
                    _e = end.replace(tzinfo=None) if end.tzinfo else end
                    evs = _db.query(_CE).filter(
                        _CE.dtstart >= _s,
                        _CE.dtstart <= _e,
                        _CE.status != "cancelled",
                    ).order_by(_CE.dtstart).all()
                    if not evs:
                        continue
                    # 按重要性分组以获得更丰富的输出
                    by_imp = {"critical": [], "high": [], "normal": [], "low": []}
                    for ev in evs:
                        imp = (ev.importance or "normal").lower()
                        by_imp.setdefault(imp, []).append(ev)
                    lines = []
                    for tier in ("critical", "high", "normal", "low"):
                        items = by_imp.get(tier, [])
                        if not items:
                            continue
                        marker = {"critical": "[!!]", "high": "[!]", "normal": "  ", "low": " ·"}[tier]
                        for ev in items:
                            t = ev.dtstart.strftime("%a %b %d %H:%M")
                            tag = f" ({ev.event_type})" if ev.event_type else ""
                            loc = f" @ {ev.location}" if ev.location else ""
                            lines.append(f"{marker} {t} — {ev.summary}{tag}{loc}")
                    if lines:
                        raw[f"calendar_{label}"] = "\n".join(lines)
            finally:
                _db.close()
        except Exception as e:
            raw["calendar"] = f"Error: {e}"

        # 笔记/任务
        try:
            r = await do_manage_notes(json.dumps({"action": "list"}), owner=task.owner)
            raw["notes_tasks"] = r.get("results") or r.get("response") or "没有笔记"
        except Exception as e:
            raw["notes_tasks"] = f"Error: {e}"

        # 自动发现 API 集成（Miniflux RSS 等）。
        try:
            import httpx
            from src.integrations import load_integrations
            for integ in load_integrations():
                if not integ.get("enabled"):
                    continue
                preset = integ.get("preset", "")
                base_url = integ.get("base_url", "").rstrip("/")
                api_key = integ.get("api_key", "")
                if not base_url:
                    continue

                # 构建认证头
                headers = {}
                if integ.get("auth_type") == "header" and api_key:
                    headers[integ.get("auth_header", "X-Auth-Token")] = api_key
                elif integ.get("auth_type") == "bearer" and api_key:
                    headers["Authorization"] = f"Bearer {api_key}"

                # Miniflux：获取未读条目（跨任务缓存 3 分钟）
                if preset == "miniflux":
                    async def _fetch_miniflux(_base=base_url, _headers=dict(headers)):
                        async with httpx.AsyncClient(timeout=10) as client:
                            resp = await client.get(
                                f"{_base}/v1/entries",
                                params={"status": "unread", "limit": 15, "order": "published_at", "direction": "desc"},
                                headers=_headers,
                            )
                            if resp.status_code != 200:
                                return None
                            entries = resp.json().get("entries", []) or []
                            if not entries:
                                return None
                            lines = []
                            for e in entries[:15]:
                                title = e.get("title", "?")
                                feed = (e.get("feed") or {}).get("title", "?")
                                url = e.get("url", "")
                                lines.append(f"- [{feed}] {title} — {url}")
                            return "\n".join(lines)
                    try:
                        val = await _cached(("miniflux_unread", base_url), 180, _fetch_miniflux)
                        if val:
                            raw["rss_miniflux_unread"] = val
                    except Exception as e:
                        logger.warning(f"Miniflux 获取失败：{e}")
        except Exception as e:
            logger.warning(f"集成发现失败：{e}")

        # 自动发现 MCP 数据源
        mcp = get_mcp_manager()
        if mcp:
            discovered = set()
            for server_id, tools in mcp._tools.items():
                if mcp.is_builtin(server_id):
                    continue
                conn = mcp._connections.get(server_id, {})
                if conn.get("status") != "connected":
                    continue
                identity = conn.get("identity", "")
                tool_names = {t["name"] for t in tools}
                for pattern in self.CHECKIN_MCP_PATTERNS:
                    if pattern["detect"] not in tool_names:
                        continue
                    key = f"{pattern['section']}_{server_id}"
                    if key in discovered:
                        continue
                    discovered.add(key)
                    label = f"{pattern['section']} ({identity})" if identity else pattern["section"]
                    qualified = f"mcp__{server_id}__{pattern['tool']}"
                    args = dict(pattern.get("args", {}))
                    args["account"] = "default"
                    try:
                        # 缓存 3 分钟：不同计划任务在同一分钟
                        # 触发时可共享同一份 MCP 快照。
                        async def _call_mcp(_q=qualified, _args=args):
                            return await mcp.call_tool(_q, _args)
                        cache_key = ("mcp_snapshot", qualified, json.dumps(args, sort_keys=True))
                        result = await _cached(cache_key, 180, _call_mcp)
                        if result.get("exit_code", 0) != 0:
                            continue
                        content = result.get("stdout") or result.get("output") or ""
                        if content.strip():
                            raw[label] = content[:3000]
                    except Exception:
                        pass

        # 构建数据转储并交给 LLM
        data_dump = f"Current time: {time_str}\n\n"
        for key, val in raw.items():
            data_dump += f"--- {key} ---\n{val}\n\n"

        context = (
            data_dump +
            f"---\n\n{task.prompt}\n\n"
            "编写签到报告。由你来决定哪些内容重要、哪些跳过、如何格式化。 "
            "只显示未来事件。日历事件已预先标记重要性： "
            "[!!] 紧急, [!] 高, 无标记 = 普通, ' ·' = 低。 "
            "按重要性分组输出——先展示紧急/高优先级，然后是普通， "
            "除非明确相关，否则完全跳过低优先级。注明事件类型（工作/健康/出行/等） "
            "以增加上下文（例如'因出行提前 1 小时离开'）。 "
            "标记需要准备的即将发生事项（生日、截止日期、节假日）。 "
            "如有需要，使用工具采取行动。保持简洁——不要输出原始数据转储。"
        )

        return await self._run_agent_loop(
            endpoint_url, model, task, session_id,
            system_prompt=(crew.personality or "").strip() if crew else None,
            disabled_tools=None, relevant_tools=None,
            override_user_message=context,
        )

    async def _execute_llm_task(self, task, db) -> str:
        """通过代理循环执行具有完整工具访问权限的 LLM 任务。"""
        from core.database import Session as DbSession, ChatMessage, CrewMember

        # 如果此任务绑定到 CrewMember（个人助手、自定义
        # crew），优先使用 crew 成员的角色/模型/端点作为覆盖。
        crew = None
        if getattr(task, "crew_member_id", None):
            try:
                crew = db.query(CrewMember).filter(CrewMember.id == task.crew_member_id).first()
            except Exception:
                crew = None

        # 确定端点 + 模型
        endpoint_url = task.endpoint_url
        model = task.model
        if (not endpoint_url or not model) and crew:
            endpoint_url = endpoint_url or crew.endpoint_url
            model = model or crew.model
        if not endpoint_url or not model:
            endpoint_url, model = self._resolve_defaults(db, task.owner)
        if not endpoint_url or not model:
            raise RuntimeError("No model/endpoint configured")
        # 记录解析后的模型，以便 _execute_task_locked 将其持久化到
        # 运行记录中（任务很少固定模型，因此这是
        # 实际产生输出的模型的唯一记录）。
        self._last_run_model = model

        # 确保输出有对应的会话
        session_id = task.session_id
        if not session_id:
            session_id = str(uuid.uuid4())
            sess = DbSession(
                id=session_id,
                name=f"[任务] {task.name}",
                endpoint_url=endpoint_url,
                model=model,
                owner=task.owner,
                folder="Tasks",
                created_at=_utcnow(),
                updated_at=_utcnow(),
            )
            db.add(sess)
            task.session_id = session_id
            db.commit()
            if self._session_manager:
                try:
                    self._session_manager.sessions[session_id] = self._session_manager._db_to_session(sess)
                except Exception:
                    pass

        # 对于助手签到：直接调用每个工具并将结果
        # 作为单独消息发布。比指望模型调用工具更可靠。
        is_checkin = crew and crew.is_default_assistant and "check-in" in (task.name or "").lower()
        if is_checkin:
            return await self._execute_checkin(task, crew, db, session_id, endpoint_url, model)

        # 构建系统提示词：crew 成员角色覆盖默认值。
        system_prompt = (
            (crew.personality or "").strip()
            if crew and crew.personality
            else "你是一个执行计划任务的有用助手。请使用可用工具来彻底完成任务。"
        )
        # 注入当前时间，以便模型知道过去和未来的情况
        tz_name = _resolve_task_timezone(db, task)
        try:
            if tz_name:
                from zoneinfo import ZoneInfo
                from datetime import timezone
                now_local = _utcnow().replace(tzinfo=timezone.utc).astimezone(ZoneInfo(tz_name))
                time_str = now_local.strftime("%A, %B %d %Y, %H:%M %Z")
            else:
                time_str = _utcnow().strftime("%A, %B %d %Y, %H:%M UTC")
        except Exception:
            time_str = _utcnow().strftime("%A, %B %d %Y, %H:%M UTC")
        system_prompt = f"Current time: {time_str}\n\n{system_prompt}"

        # 从 CrewMember.enabled_tools 计算工具过滤器（如果已设置）
        disabled_tools = None
        if crew and crew.enabled_tools:
            try:
                enabled = json.loads(crew.enabled_tools)
                if isinstance(enabled, list) and enabled:
                    from src.tool_index import BUILTIN_TOOL_DESCRIPTIONS
                    all_tools = set(BUILTIN_TOOL_DESCRIPTIONS.keys())
                    disabled_tools = all_tools - set(enabled)
            except Exception:
                pass

        # 为此提示词进行 RAG 工具选择 + 始终可用的助手工具。
        # 没有此步骤，所有 40+ 个工具都会被发送，模型会达到工具上限。
        relevant_tools = None
        try:
            from src.tool_index import get_tool_index, ASSISTANT_ALWAYS_AVAILABLE
            tool_idx = get_tool_index()
            if tool_idx:
                rag_tools = tool_idx.get_tools_for_query(task.prompt or "", k=8)
                relevant_tools = (rag_tools | ASSISTANT_ALWAYS_AVAILABLE)
                if disabled_tools:
                    relevant_tools -= disabled_tools
                logger.info(f"[assistant] RAG selected {len(rag_tools)} tools + {len(ASSISTANT_ALWAYS_AVAILABLE)} always-available = {len(relevant_tools)} total for '{task.name}'")
        except Exception as e:
            logger.warning(f"[assistant] RAG 工具选择失败，使用全部：{e}")

        # 尝试使用代理循环获得完整工具访问
        try:
            result = await self._run_agent_loop(
                endpoint_url, model, task, session_id,
                system_prompt=system_prompt, disabled_tools=disabled_tools,
                relevant_tools=relevant_tools,
            )
        except Exception as e:
            logger.warning(f"Agent loop failed for task '{task.name}', falling back to simple call: {e}")
            from src.llm_core import llm_call_async
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": task.prompt},
            ]
            result = await llm_call_async(url=endpoint_url, model=model, messages=messages, timeout=120)

        # 在保存/交付前剥离模型的链式思考。任务
        # 输出仅为 LLM，因此 prose=True（也会移除未标记的
        # "The user wants me to…" 推理）在这里是安全的——没有此操作
        # 思考内容会泄漏到保存的结果中。
        try:
            from src.text_helpers import strip_think
            result = strip_think(result or "", prose=True, prompt_echo=True).strip() or result
        except Exception:
            pass

        return result

    async def _deliver_task_result(self, task, result: str, db, model: str = None):
        """根据 output_target 交付已完成任务的运行结果。

        此函数被 LLM/research/action 三类任务共享使用，以确保内置
        action 不会偏离到与任务指定输出目标不一致的
        隐藏递送路径上。
        """
        from core.database import Session as DbSession, ChatMessage, CrewMember

        output = task.output_target or "session"
        if (
            output == "session"
            and (getattr(task, "task_type", "") or "") == "action"
            and (getattr(task, "action", "") or "") in self._SILENT_ACTIONS
        ):
            return
        if output.startswith("mcp__"):
            await self._deliver_via_mcp(output, task, result)
            return

        if self._is_email_output_target(output):
            await self._deliver_via_email(output, task, result)
            return

        if output != "session":
            return

        endpoint_url = task.endpoint_url
        model_name = model or task.model
        crew = None
        if getattr(task, "crew_member_id", None):
            try:
                crew = db.query(CrewMember).filter(CrewMember.id == task.crew_member_id).first()
            except Exception:
                crew = None
        if (not endpoint_url or not model_name) and crew:
            endpoint_url = endpoint_url or crew.endpoint_url
            model_name = model_name or crew.model
        if not endpoint_url or not model_name:
            try:
                resolved_url, resolved_model = self._resolve_defaults(db, task.owner)
                endpoint_url = endpoint_url or resolved_url
                model_name = model_name or resolved_model
            except Exception:
                pass

        session_id = task.session_id
        if not session_id:
            session_id = str(uuid.uuid4())
            sess = DbSession(
                id=session_id,
                name=f"[任务] {task.name}",
                endpoint_url=endpoint_url or "",
                model=model_name or "",
                owner=task.owner,
                folder="Tasks",
                created_at=_utcnow(),
                updated_at=_utcnow(),
            )
            db.add(sess)
            task.session_id = session_id
            db.commit()
            if self._session_manager:
                try:
                    self._session_manager.sessions[session_id] = self._session_manager._db_to_session(sess)
                except Exception:
                    pass

        meta = {}
        if model_name:
            meta["model"] = model_name
        if crew and crew.is_default_assistant:
            meta.update({"source": "cron", "task_id": task.id, "task_name": task.name})
        msg_meta = json.dumps(meta)
        user_content = task.prompt or f"[任务] {task.name}"
        user_msg = ChatMessage(
            id=str(uuid.uuid4()),
            session_id=session_id,
            role="user",
            content=user_content,
            timestamp=_utcnow(),
            meta_data=msg_meta,
        )
        assistant_msg = ChatMessage(
            id=str(uuid.uuid4()),
            session_id=session_id,
            role="assistant",
            content=result or "",
            timestamp=_utcnow(),
            meta_data=msg_meta,
        )
        db.add(user_msg)
        db.add(assistant_msg)
        db.commit()

        if self._session_manager:
            try:
                from core.models import ChatMessage as MemMsg
                sess_obj = self._session_manager.get_session(session_id)
                sess_obj.history.append(MemMsg(role="user", content=user_msg.content, metadata=meta))
                sess_obj.history.append(MemMsg(role="assistant", content=assistant_msg.content, metadata=meta))
            except Exception:
                pass

    @staticmethod
    def _is_email_output_target(output: str) -> bool:
        target = (output or "").strip()
        if target in {"email", "email:self"}:
            return True
        if target.startswith("email:"):
            return True
        return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", target))

    async def _deliver_via_email(self, output: str, task, result: str):
        """通过应用配置的 SMTP 账户发送任务输出。

        支持的 output_target 值：
        - email / email:self：发送到账户的 From 地址
        - email:name@example.com 或原始 name@example.com：发送到该地址
        """
        from email.message import EmailMessage

        target = (output or "").strip()
        explicit = ""
        if target.startswith("email:"):
            explicit = target.split(":", 1)[1].strip()
        elif "@" in target:
            explicit = target

        try:
            from routes.email_routes import _resolve_send_config
            from routes.email_helpers import _send_smtp_message

            cfg = _resolve_send_config(owner=task.owner or "")
            to_addr = explicit or cfg.get("from_address") or cfg.get("smtp_user") or ""
            if not to_addr:
                raise RuntimeError("无法为任务输出解析邮件收件人")

            from_addr = cfg.get("from_address") or cfg.get("smtp_user") or to_addr
            msg = EmailMessage()
            msg["From"] = from_addr
            msg["To"] = to_addr
            msg["Subject"] = f"[Task] {task.name}"
            msg["X-Odysseus-Origin"] = "odysseus-ui"
            msg["X-Odysseus-Kind"] = "task"
            msg["X-Odysseus-Ref"] = str(task.id)
            msg.set_content(result or "")
            _send_smtp_message(cfg, from_addr, [to_addr], msg.as_string(), timeout=30)
            logger.info("任务 %s 已将结果通过邮件发送到 %s (%sb)", task.id, to_addr, len(result or ""))
        except Exception as e:
            logger.error("任务 %s 邮件交付失败：%s", task.id, e, exc_info=True)
            raise

    async def _run_agent_loop(self, endpoint_url: str, model: str, task, session_id: str,
                              system_prompt: str | None = None,
                              disabled_tools: set | None = None,
                              relevant_tools: set | None = None,
                              override_user_message: str | None = None) -> str:
        """运行完整的代理循环，具有工具访问权限，收集最终文本。"""
        from src.agent_loop import stream_agent_loop

        system_content = system_prompt or "你是一个执行计划任务的有用助手。请使用可用工具来彻底完成任务。"
        user_content = override_user_message or task.prompt
        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]

        # 从端点的 API key 解析请求头
        headers = {}
        try:
            from core.database import SessionLocal, ModelEndpoint
            from src.endpoint_resolver import normalize_base, build_headers
            from src.auth_helpers import owner_filter
            db2 = SessionLocal()
            try:
                ep_q = db2.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)
                ep_q = owner_filter(ep_q, ModelEndpoint, task.owner or None)
                eps = ep_q.all()
                for ep in eps:
                    if normalize_base(ep.base_url) in endpoint_url or endpoint_url in normalize_base(ep.base_url):
                        headers = build_headers(ep.api_key, normalize_base(ep.base_url))
                        break
            finally:
                db2.close()
        except Exception:
            pass
        full_text = ""
        tool_results = []

        # 遵守每任务的 max_steps（防止代理循环失控）。
        # 如果未设置则回退到 20——历史默认值。
        _task_max_rounds = task.max_steps if task.max_steps and task.max_steps > 0 else 20
        # 任务是后台工作负载——它们共享 Utility 模型的
        # 回退链（设置 → 工具模型 → 回退列表）。宕机的
        # 主端点不会默默返回 `(no output)`——与
        # 聊天使用相同的方案，但使用工具列表（`utility_model_fallbacks`）。
        try:
            from src.endpoint_resolver import resolve_utility_fallback_candidates
            _task_fallbacks = resolve_utility_fallback_candidates(owner=task.owner or None)
        except Exception:
            _task_fallbacks = []
        async for event_str in stream_agent_loop(
            endpoint_url=endpoint_url,
            model=model,
            messages=messages,
            max_rounds=_task_max_rounds,
            session_id=session_id,
            owner=task.owner,
            headers=headers,
            disabled_tools=disabled_tools,
            relevant_tools=relevant_tools,
            fallbacks=_task_fallbacks,
        ):
            if event_str.startswith("data: ") and not event_str.startswith("data: [DONE]"):
                try:
                    data = json.loads(event_str[6:])
                    # 捕获所有事件类型的文本，不仅仅是 delta
                    if "delta" in data:
                        full_text += data["delta"]
                    elif data.get("type") == "tool_output":
                        # 工具结果——捕获摘要，即使模型从未产生
                        # 最终文本响应，我们也至少有东西
                        tool_summary = data.get("stdout") or data.get("output") or data.get("result") or ""
                        if isinstance(tool_summary, str) and tool_summary.strip():
                            tool_results.append(f"[{data.get('tool', '?')}] {tool_summary[:500]}")
                except (json.JSONDecodeError, KeyError):
                    pass

        # 优雅总结——如果模型在工具调用中耗尽了轮次数
        # 而没有产生最终文本响应，做最后一次 LLM 调用
        # 让它总结做了什么。确保有输出。
        if not full_text.strip():
            try:
                from src.llm_core import llm_call_async_with_fallback
                from src.endpoint_resolver import resolve_utility_fallback_candidates
                grace_context = "You ran out of steps. "
                if tool_results:
                    grace_context += "以下是你的工具返回的内容：\n" + "\n".join(tool_results[-5:])
                else:
                    grace_context += "没有捕获到任何工具结果。"
                grace_context += "\n\n总结你完成了什么以及还有哪些待处理。保持简洁。"
                _grace_candidates = [(endpoint_url, model, headers)] + resolve_utility_fallback_candidates(owner=task.owner or None)
                full_text = await llm_call_async_with_fallback(
                    _grace_candidates,
                    messages=[
                        {"role": "system", "content": system_content},
                        {"role": "user", "content": grace_context},
                    ],
                    timeout=30,
                )
                full_text = (full_text or "").strip()
            except Exception as e:
                logger.warning(f"优雅总结失败：{e}")
                if tool_results:
                    full_text = "\n".join(tool_results[-5:])

        return full_text or "（无输出）"

    async def _execute_research_task(self, task, db) -> str:
        """使用 DeepResearcher 执行深度研究任务。"""
        from core.database import Session as DbSession, ChatMessage
        from src.deep_research import DeepResearcher
        from src.research_handler import RESEARCH_DATA_DIR, ResearchHandler
        from src.research_utils import strip_thinking
        from src.settings import get_setting

        # 解析端点/模型：研究设置 > 任务设置 > 会话默认值
        endpoint_url = task.endpoint_url
        model = task.model
        headers = {}
        headers_from_resolver = False

        if not endpoint_url or not model:
            try:
                from src.endpoint_resolver import resolve_endpoint
                ep_url, ep_model, ep_headers = resolve_endpoint(
                    "research",
                    endpoint_url or None,
                    model or None,
                    None,
                    owner=task.owner or None,
                )
                endpoint_url = ep_url or endpoint_url
                model = ep_model or model
                if ep_headers is not None:
                    headers = ep_headers
                    headers_from_resolver = True
            except Exception:
                pass

        if not endpoint_url or not model:
            endpoint_url, model = self._resolve_defaults(db, task.owner)
        if not endpoint_url or not model:
            raise RuntimeError("No model/endpoint configured for research")
        # 记录解析后的模型用于运行记录（参见 _execute_task_locked）。
        self._last_run_model = model

        # 解析请求头
        try:
            from core.database import ModelEndpoint
            from src.endpoint_resolver import normalize_base, build_headers
            from src.auth_helpers import owner_filter
            db2 = db
            if not headers_from_resolver:
                ep_q = db2.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)
                ep_q = owner_filter(ep_q, ModelEndpoint, task.owner or None)
                eps = ep_q.all()
                for ep in eps:
                    if normalize_base(ep.base_url) in endpoint_url or endpoint_url in normalize_base(ep.base_url):
                        headers = build_headers(ep.api_key, normalize_base(ep.base_url))
                        break
        except Exception:
            pass

        max_tokens = int(get_setting("research_max_tokens", 8192))
        extraction_timeout = int(get_setting("research_extraction_timeout_seconds", 90) or 90)
        extraction_concurrency = int(get_setting("research_extraction_concurrency", 3) or 3)

        researcher = DeepResearcher(
            llm_endpoint=endpoint_url,
            llm_model=model,
            llm_headers=headers,
            max_rounds=8,
            max_time=600,  # 计划研究 10 分钟
            max_report_tokens=max_tokens,
            extraction_timeout=extraction_timeout,
            extraction_concurrency=extraction_concurrency,
        )

        started_ts = time.time()
        report = await researcher.research(task.prompt)
        completed_ts = time.time()
        try:
            stats = researcher.get_stats() or {}
        except Exception:
            stats = {}

        # 确保输出有对应的会话
        session_id = task.session_id
        if not session_id:
            session_id = str(uuid.uuid4())
            sess = DbSession(
                id=session_id,
                name=f"[研究] {task.name}",
                endpoint_url=endpoint_url,
                model=model,
                owner=task.owner,
                folder="Tasks",
                created_at=_utcnow(),
                updated_at=_utcnow(),
            )
            db.add(sess)
            task.session_id = session_id
            db.commit()
            if self._session_manager:
                try:
                    self._session_manager.sessions[session_id] = self._session_manager._db_to_session(sess)
                except Exception:
                    pass

        # 使用与研究面板相同的磁盘格式持久化计划研究。
        # 没有此操作，任务研究会有 Markdown 输出，但
        # 没有库条目，也没有可视化报告路由可打开。
        try:
            RESEARCH_DATA_DIR.mkdir(parents=True, exist_ok=True)
            findings = getattr(researcher, "findings", []) or []
            payload = {
                "query": task.prompt or task.name or "Scheduled research",
                "status": "done",
                "result": report,
                "raw_report": strip_thinking(report or ""),
                "sources": ResearchHandler._extract_sources(findings),
                "raw_findings": ResearchHandler._extract_raw_findings(findings),
                "stats": stats,
                "category": "scheduled",
                "started_at": started_ts,
                "completed_at": completed_ts,
                "owner": task.owner or "",
                "task_id": task.id,
                "task_name": task.name,
            }
            (RESEARCH_DATA_DIR / f"{session_id}.json").write_text(json.dumps(payload), encoding="utf-8")
            try:
                from src.event_bus import fire_event
                fire_event("research_completed", task.owner or None)
            except Exception:
                logger.debug("research_completed 事件分发失败", exc_info=True)
        except Exception as e:
            logger.warning("持久化任务研究报告失败 %s：%s", session_id, e)

        return report

    async def _run_chained(self, task_id: str):
        """运行链式任务。以与 run_task_now 相同的方式获取 _executing 成员资格，
        使重叠的调度器 tick 不会在链式运行期间
        重复分发同一任务。"""
        async with self._executing_lock:
            if task_id in self._executing:
                return  # 已在运行中（手动触发、调度器 tick 或另一个链）
            self._executing.add(task_id)
        await self._execute_task(task_id)

    def _has_chain_cycle(self, db, start_id: str, max_depth: int = 10, owner: str | None = None) -> bool:
        """检测任务链中的循环。"""
        from core.database import ScheduledTask
        visited = set()
        current = start_id
        for _ in range(max_depth):
            if current in visited:
                return True
            visited.add(current)
            task = db.query(ScheduledTask).filter(ScheduledTask.id == current).first()
            if owner is not None and task and task.owner != owner:
                return True
            if not task or not task.then_task_id:
                return False
            current = task.then_task_id
        return True  # 太深，视为循环

    def _resolve_defaults(self, db, owner):
        """从现有会话中查找第一个可用的端点 + 模型。"""
        from core.database import Session as DbSession
        try:
            recent = db.query(DbSession).filter(
                DbSession.endpoint_url.isnot(None),
                DbSession.model.isnot(None),
                *([DbSession.owner == owner] if owner else []),
            ).order_by(DbSession.created_at.desc()).first()
            if recent:
                return recent.endpoint_url, recent.model
        except Exception:
            pass
        return None, None

    async def _deliver_via_mcp(self, tool_name: str, task, result: str):
        """通过 MCP 工具（例如 Gmail 发送）发送任务结果。

        解析收件人（使邮件风格工具有 'to' 字段），先尝试
        配置的 From 地址（`daily_brief` 模式——给自己发邮件）
        然后回退到任务所有者。常见的收件人字段名称
        （to / recipient / email / address）均会被填充，因此无需
        为每个工具的 schema 做特殊处理；MCP 工具会忽略它
        不认识的键。
        """
        from src.tool_utils import get_mcp_manager
        mcp = get_mcp_manager()
        if not mcp:
            logger.warning(f"任务 {task.id}：MCP 管理器不可用于交付")
            return

        # 解析收件人——优先使用配置的邮件 From（来自 daily_brief 的
        # 已建立的"给自己发邮件"模式），回退到 task.owner。
        # `_get_email_config()` 是处理旧版 `email_from` 设置
        # 和每账户数据库行的唯一真实来源。
        recipient = None
        try:
            from routes.email_helpers import _get_email_config
            cfg = _get_email_config() or {}
            recipient = cfg.get("from_address") or None
        except Exception as _e:
            logger.debug(f"_deliver_via_mcp：邮件配置查找失败：{_e}")
        if not recipient and task.owner and "@" in str(task.owner):
            recipient = task.owner

        args = {
            "subject": f"[Task] {task.name}",
            "body": result,
            "headers": {
                "X-Odysseus-Origin": "odysseus-ui",
                "X-Odysseus-Kind": "task",
                "X-Odysseus-Ref": str(task.id),
            },
        }
        if recipient:
            # 覆盖常见字段名称，无需为每个 MCP 服务器硬编码
            # （Gmail、通用 SMTP、Slack DM 等）。
            args["to"] = recipient
            args["recipient"] = recipient
            args["email"] = recipient
            args["address"] = recipient
        else:
            logger.warning(
                f"任务 {task.id}：无法为 MCP 交付 {tool_name} 解析收件人——"
                "请在设置中设置邮件 From 地址或为任务指定所有者邮箱。"
            )
        try:
            mcp_result = await mcp.call_tool(tool_name, args)
            stderr = mcp_result.get("stderr", "")
            stdout = mcp_result.get("stdout", "")
            body_len = len(result or "")
            exit_code = mcp_result.get("exit_code", 0)
            if exit_code != 0:
                logger.warning(
                    f"任务 {task.id} MCP 交付 {tool_name} 失败："
                    f"exit={exit_code} stderr={stderr[:400]!r} stdout={stdout[:400]!r}"
                )
            else:
                # 包含 MCP 工具自身的 stdout（例如 email_server 返回
                # "Sent email to ... with subject ..."）和正文大小，以便
                # 在日志中更容易发现静默的 SMTP 失败。
                logger.info(
                    f"任务 {task.id} 已通过 MCP 工具 {tool_name} 交付 "
                    f"（to={recipient or '<未设置>'}，body={body_len}b，reply={stdout[:200]!r}）"
                )
        except Exception as e:
            logger.error(f"任务 {task.id} MCP 交付失败：{e}")

    async def run_task_now(self, task_id: str, *, force: bool = False):
        """手动触发任务执行。"""
        if force:
            asyncio.create_task(self._execute_task(task_id, bypass_model_slot=True, release_executing=False))
            return True
        async with self._executing_lock:
            if task_id in self._executing:
                return False
            self._executing.add(task_id)
        asyncio.create_task(self._execute_task(task_id))
        return True

    async def stop_task(self, task_id: str) -> bool:
        """请求取消正在运行/排队中的任务，并将其运行标记为已中止。"""
        handle = self._task_handles.get(task_id)
        stopped = False
        if handle and not handle.done():
            handle.cancel()
            stopped = True
        async with self._executing_lock:
            if task_id in self._executing:
                self._executing.discard(task_id)
                stopped = True

        stopped = self._mark_run_aborted(task_id) or stopped
        return stopped

    async def ensure_defaults(self, owner: str):
        """为此用户创建默认维护任务（每操作幂等）。"""
        from core.database import SessionLocal, ScheduledTask
        try:
            from routes.prefs_routes import _load_for_user
            _prefs = _load_for_user(owner) or {}
        except Exception:
            _prefs = {}
        tasks_enabled = bool(_prefs.get("tasks_enabled"))
        tasks_opened = bool(_prefs.get("tasks_opened"))

        db = SessionLocal()
        try:
            # 归一化在 `task_type` / `action` 可靠之前创建的旧内置任务。
            # 按当前或旧名称匹配，以便过时
            # 行不会永远作为计划的 LLM 任务运行。
            name_to_action = {}
            for action, defs in HOUSEKEEPING_DEFAULTS.items():
                name_to_action[defs["name"]] = action
                for legacy in defs.get("legacy_names") or []:
                    name_to_action[legacy] = action
            possible_names = list(name_to_action.keys())
            legacy_named = db.query(ScheduledTask).filter(
                ScheduledTask.owner == owner,
                ScheduledTask.name.in_(possible_names),
            ).all()
            for task in legacy_named:
                action = name_to_action.get(task.name)
                if not action:
                    continue
                task.task_type = "action"
                task.action = action

            from core.database import TaskRun
            retired_ids = [
                row[0] for row in db.query(ScheduledTask.id).filter(
                    ScheduledTask.owner == owner,
                    ScheduledTask.task_type == "action",
                    ScheduledTask.action.in_(list(RETIRED_HOUSEKEEPING_ACTIONS)),
                ).all()
            ]
            if retired_ids:
                db.query(TaskRun).filter(TaskRun.task_id.in_(retired_ids)).delete(synchronize_session=False)
            retired_count = db.query(ScheduledTask).filter(
                ScheduledTask.owner == owner,
                ScheduledTask.task_type == "action",
                ScheduledTask.action.in_(list(RETIRED_HOUSEKEEPING_ACTIONS)),
            ).delete(synchronize_session=False)
            # 清理孤立的 TaskRun 行（父任务之前被删除），使
            # 已退役的操作不再显示在 Activity 中。仅在有
            # 至少一个活跃任务时运行——避免在新数据库上清除运行历史。
            try:
                live_ids = {row[0] for row in db.query(ScheduledTask.id).all()}
                if live_ids:
                    db.query(TaskRun).filter(~TaskRun.task_id.in_(list(live_ids))).delete(synchronize_session=False)
            except Exception:
                pass
            existing_actions = {
                row[0] for row in db.query(ScheduledTask.action).filter(
                    ScheduledTask.owner == owner,
                    ScheduledTask.task_type == "action",
                ).all() if row[0]
            }
            renamed = []
            builtin_tasks = db.query(ScheduledTask).filter(
                ScheduledTask.owner == owner,
                ScheduledTask.task_type == "action",
                ScheduledTask.action.in_(list(HOUSEKEEPING_DEFAULTS.keys())),
            ).all()
            by_action = {}
            for task in builtin_tasks:
                by_action.setdefault(task.action, []).append(task)
            removed_dupes = []
            kept_ids = set()
            for action, tasks in by_action.items():
                defs = HOUSEKEEPING_DEFAULTS.get(action)
                if not defs:
                    continue
                desired_trigger = defs.get("trigger_type", "schedule")

                def _score(candidate):
                    matches_default = (
                        (candidate.trigger_type or "schedule") == desired_trigger
                        and (candidate.trigger_event or None) == defs.get("trigger_event")
                        and (candidate.trigger_count or 1) == (defs.get("trigger_count") or 1)
                        and (candidate.schedule or None) == defs.get("schedule")
                        and (candidate.scheduled_time or None) == defs.get("scheduled_time")
                        and (candidate.cron_expression or None) == defs.get("cron_expression")
                    )
                    created = candidate.created_at or datetime.min
                    created_key = (created.toordinal(), created.hour, created.minute, created.second, created.microsecond)
                    return (1 if matches_default else 0, 1 if candidate.status == "active" else 0, created_key)

                keep = sorted(tasks, key=_score, reverse=True)[0]
                kept_ids.add(keep.id)
                for dupe in tasks:
                    if dupe.id == keep.id:
                        continue
                    db.delete(dupe)
                    removed_dupes.append(action)

            for task in [t for t in builtin_tasks if t.id in kept_ids]:
                defs = HOUSEKEEPING_DEFAULTS.get(task.action)
                if not defs:
                    continue
                legacy_names = set(defs.get("legacy_names") or [])
                if (task.name or "") in legacy_names:
                    task.name = defs["name"]
                    renamed.append(task.action)
                normalized = False
                desired_trigger = defs.get("trigger_type", "schedule")
                if task.action == "check_email_urgency":
                    old_crons = set(defs.get("old_cron_expressions") or [])
                    if task.schedule == "cron" and (task.cron_expression or "") in old_crons:
                        task.cron_expression = defs["cron_expression"]
                        task.next_run = compute_next_run(
                            defs["schedule"], defs["scheduled_time"], None, None,
                            after=_utcnow(), cron_expression=defs["cron_expression"],
                            tz_name=_resolve_task_timezone(db, task),
                        )
                        normalized = True
                if desired_trigger == "event" and (
                    (task.trigger_type or "schedule") != "event"
                    or task.trigger_event != defs.get("trigger_event")
                    or (task.trigger_count or 1) != (defs.get("trigger_count") or 1)
                    or task.schedule is not None
                    or task.scheduled_time is not None
                    or task.scheduled_date is not None
                    or task.cron_expression is not None
                ):
                    task.trigger_type = "event"
                    task.trigger_event = defs.get("trigger_event")
                    task.trigger_count = defs.get("trigger_count") or 1
                    task.trigger_counter = 0
                    task.schedule = defs.get("schedule")
                    task.scheduled_time = defs.get("scheduled_time")
                    task.scheduled_day = None
                    task.scheduled_date = None
                    task.cron_expression = defs.get("cron_expression")
                    normalized = True
                if normalized:
                    renamed.append(task.action)
                ships_paused = bool(defs.get("ship_paused"))
                if not tasks_enabled and not tasks_opened:
                    if ships_paused and task.status == "active":
                        task.status = "paused"
                    elif not ships_paused and task.status == "paused":
                        task.status = "active"
                        if (task.trigger_type or "schedule") == "schedule":
                            task.next_run = compute_next_run(
                                task.schedule, task.scheduled_time,
                                task.scheduled_day, task.scheduled_date,
                                after=_utcnow(), cron_expression=task.cron_expression,
                                tz_name=_resolve_task_timezone(db, task),
                            )
                # 内置维护/操作任务不应创建浏览器
                # 任务通知；用户的 AI/研究任务仍可创建。
                task.notifications_enabled = False
                if (task.output_target or "session") == "session":
                    task.output_target = defs.get("output_target", "none")
            seeded = []
            for action, defs in HOUSEKEEPING_DEFAULTS.items():
                if action in existing_actions:
                    continue
                trigger_type = defs.get("trigger_type", "schedule")
                next_run = None
                if trigger_type == "schedule":
                    next_run = compute_next_run(
                        defs["schedule"], defs["scheduled_time"], None, None,
                        after=_utcnow(), cron_expression=defs["cron_expression"],
                    )
                ships_paused = bool(defs.get("ship_paused"))
                task = ScheduledTask(
                    id=str(uuid.uuid4())[:8],
                    owner=owner,
                    name=defs["name"],
                    task_type="action",
                    action=action,
                    trigger_type=trigger_type,
                    trigger_event=defs.get("trigger_event"),
                    trigger_count=defs.get("trigger_count"),
                    trigger_counter=0,
                    schedule=defs["schedule"],
                    scheduled_time=defs["scheduled_time"],
                    cron_expression=defs["cron_expression"],
                    next_run=next_run,
                    # 大多数内置任务默认是活跃的。侵入性的
                    # AI/邮件/日历任务通过 ship_paused 
                    # 选择以暂停状态开始，以便用户可以有意识地启用它们。
                    status="paused" if ships_paused else "active",
                    output_target=defs.get("output_target", "none"),
                    notifications_enabled=False,
                )
                db.add(task)
                seeded.append(action)
            if seeded or renamed or removed_dupes or retired_count:
                logger.info(
                    "%s 的默认维护任务：新建=%s 重命名=%s 去重=%s 退役=%s",
                    owner, seeded, sorted(set(renamed)), sorted(set(removed_dupes)), retired_count,
                )
            # 始终提交——上面的孤立运行清理可能产生了
            # 待删除行，即使默认值未更改。
            db.commit()
        except Exception as e:
            logger.warning(f"创建默认任务失败：{e}")
        finally:
            db.close()
        # 始终确保个人助手存在（独立于其他任务）。
        try:
            await self.ensure_assistant_defaults(owner)
        except Exception as e:
            logger.warning(f"为 {owner} 创建助手失败：{e}")

    async def ensure_assistant_defaults(self, owner: str):
        """为此用户创建个人助手 CrewMember、其固定会话和三个
        每日签到 ScheduledTasks——基于 is_default_assistant 幂等。"""
        # 硬性拒绝合成所有者。没有此操作，AuthMiddleware 标记的
        # 如 'internal-tool'（回环代理工具回调）或 'api'
        #（bearer-token 集成）值会得到一个真实的助手 + 3 个每日
        # 签到任务，然后与人类用户的签到
        # 一起双重触发。这是导致我们必须手动清理的重复
        # 'Morning check-in' 行的根本原因。
        if not owner or owner in {"internal-tool", "api", "demo", "system"}:
            logger.info(f"ensure_assistant_defaults: skip synthetic owner {owner!r}")
            return
        from core.database import SessionLocal, CrewMember, ScheduledTask
        from core.database import Session as DbSession

        db = SessionLocal()
        try:
            existing = db.query(CrewMember).filter(
                CrewMember.owner == owner,
                CrewMember.is_default_assistant == True,  # noqa: E712
            ).first()
            if existing:
                return  # 已创建

            # 从任何现有会话解析默认模型/端点，以便
            # 助手有可调用的内容。用户以后可以更改。
            endpoint_url, model = self._resolve_defaults(db, owner)

            default_personality = (
                "You are the user's personal assistant. Concise, warm, a little dry. "
                "Never waste time with fluff. Default to English. Only match the other language when replying to a non-English email.\n\n"

                "CORE RULE: You MUST use your tools to take action — do not describe what you would do. "
                "Never say 'I would check your calendar' — actually call manage_calendar. "
                "Never say 'I can look that up' — actually call web_search or search_chats. "
                "If you have a tool for it, use it. No hypotheticals, no promises, only actions and results.\n\n"

                "DECISION FRAMEWORK — follow these rules, not just tool descriptions:\n\n"

                "CONTEXT GATHERING (before any response involving a specific person):\n"
                "1. resolve_contact if you only have a name and need their email\n"
                "2. search_chats for recent conversations mentioning them or their topic\n"
                "3. manage_memory to check stored facts about them\n"
                "Skip steps you already have answers for. Don't search for the user themselves.\n\n"

                "EMAIL HANDLING:\n"
                "- If a document is open in the editor, that IS the email. Use update_document to write the reply.\n"
                "- BEFORE drafting any reply: gather context (steps above) about the sender and topic.\n"
                "- When an email mentions a date/meeting: check calendar for conflicts, add if clear.\n"
                "- When an email asks a question you can't answer from context: say so honestly. Never fabricate.\n"
                "- Skip automated/marketing emails in check-ins. Only surface human-sent, actionable ones.\n"
                "- Never duplicate information the user already saw in a previous check-in.\n\n"

                "ESCALATION LADDER (when you need info you don't have):\n"
                "1. search_chats (fast, free)\n"
                "2. manage_memory (fast, free)\n"
                "3. web_search (medium cost)\n"
                "4. trigger_research (expensive, async — only for complex multi-source questions)\n"
                "Stop as soon as you have a sufficient answer.\n\n"

                "'SEND TO [NAME]' FLOW:\n"
                "1. resolve_contact to find their email\n"
                "2. If a document is open, use its content as the body\n"
                "3. Draft the email in a document (create_document with language='email')\n"
                "4. Tell the user to review — NEVER auto-send\n\n"

                "SELF-IMPROVEMENT — use manage_memory constantly:\n"
                "- When the user corrects you, IMMEDIATELY store the correction as a memory.\n"
                "- After every check-in or task, store new facts you learned (contacts, preferences, patterns).\n"
                "- Before responding about a person or topic, search_chats and manage_memory FIRST.\n"
                "- Build knowledge over time: who people are, what projects are active, how the user likes things done.\n"
                "- If something failed or you got corrected, store WHY so you never repeat it.\n"
                "- When you figure out a multi-step workflow that works, save it as a SKILL using manage_skills.\n"
                "  A skill is a reusable procedure. Next time, recall the skill instead of figuring it out again.\n"
                "- Before starting a complex task, check manage_skills for an existing procedure.\n\n"

                "AUTONOMY RULES:\n"
                "- Auto-add calendar events from clear meeting invitations (mention what you added)\n"
                "- Auto-draft email replies (cached for when user clicks Reply)\n"
                "- NEVER send emails without explicit user instruction\n"
                "- NEVER delete anything without explicit instruction\n"
                "- If uncertain, ask rather than guess"
            )

            # 首先创建单例会话（CrewMember.session_id 关联到它）。
            session_id = str(uuid.uuid4())
            sess = DbSession(
                id=session_id,
                name="Assistant",
                endpoint_url=endpoint_url or "",
                model=model or "",
                owner=owner,
                is_important=True,
                mode="agent",
                folder="Assistant",
                created_at=_utcnow(),
                updated_at=_utcnow(),
            )
            db.add(sess)
            db.flush()

            # 创建助手 CrewMember。
            crew_id = str(uuid.uuid4())
            assistant = CrewMember(
                id=crew_id,
                owner=owner,
                name="Assistant",
                avatar=None,
                user_name=None,
                personality=default_personality,
                model=model,
                endpoint_url=endpoint_url,
                greeting=None,
                enabled_tools=json.dumps([
                    "manage_calendar", "manage_notes", "manage_tasks", "manage_memory",
                    "list_email_accounts", "list_emails", "read_email", "send_email", "reply_to_email", "archive_email",
                    "mark_email_read", "delete_email", "resolve_contact",
                    "search_chats", "web_search", "web_fetch", "read_file",
                    "create_document", "update_document", "edit_document",
                    "generate_image", "trigger_research",
                    "download_model", "serve_model", "list_served_models", "stop_served_model",
                    "edit_image",
                ]),
                session_id=session_id,
                is_active=True,
                sort_order=0,
                is_default_assistant=True,
                timezone=None,  # 用户在设置中选择；None = 旧版 UTC 行为
            )
            db.add(assistant)

            # 将会话链接回 crew 成员，以便 UI 可以双向解析。
            sess.crew_member_id = crew_id

            # 不再自动创建签到任务。旧行为在每个新用户下
            # 创建三个每日 ScheduledTasks（Morning/Midday/Evening），
            # 这具有侵入性，并在全局标记为 is_default 的任何账户下运行。
            # 用户现在可以从任务 UI 创建自己的定期任务。

            db.commit()
            logger.info(f"已为 owner={owner} 创建个人助手（crew {crew_id})")
        except Exception as e:
            logger.exception(f"ensure_assistant_defaults({owner}) 失败：{e}")
            try:
                db.rollback()
            except Exception:
                pass
        finally:
            db.close()
