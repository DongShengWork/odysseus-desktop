"""CalDAV 写回：将本地创建/更新/删除推送到远程（#800）。

``src/caldav_sync.py`` 是单向拉取（远程 → 本地）。因此在 CalDAV 支持的
日历上，在 Odysseus 中创建、编辑或删除的事件仅更改了本地 SQLite 副本，
并且永远不会到达服务器（iCloud/Nextcloud/Radicale/Fastmail）——它们会在
下一次拉取时静默消失，并且永远不会显示在用户的手机上。

This adds the missing write half. The remote calendar URL isn't stored locally
(the local calendar id is a one-way hash of it), so we re-discover the remote
calendar by matching that same hash, then PUT/DELETE the VEVENT by its UID via
the `caldav` lib. Writes are best-effort: the local DB stays the source of truth,
and a remote failure is reported, never fatal to the local operation.

纯函数部分（``build_event_ical``、``find_remote_calendar``、
``push_event``）通过参数接收输入，因此可以用无网络的假客户端进行
单元测试。
"""

import asyncio
import logging
from datetime import timezone

logger = logging.getLogger(__name__)


def _stable_cal_id(remote_url: str, owner: str = "", account_id: str = "") -> str:
    # 复用同步模块的哈希，使 owner+account_id 作用域保持一致。
    from src.caldav_sync import _stable_cal_id as _sync_id
    return _sync_id(remote_url, owner=owner, account_id=account_id)


def build_event_ical(ev: dict) -> str:
    """将本地事件字典序列化为 VCALENDAR/VEVENT iCalendar 字符串。

    ``ev`` 键：uid、summary、description、location、dtstart（datetime）、
    dtend（datetime）、all_day（bool）、is_utc（bool）、rrule（str）。
    镜像拉取路径解释 is_utc/all_day 的方式，确保往返稳定。
    """
    from icalendar import Calendar, Event as iEvent
    from icalendar.prop import vRecur

    cal = Calendar()
    cal.add("prodid", "-//Odysseus//CalDAV write-back//EN")
    cal.add("version", "2.0")

    ve = iEvent()
    ve.add("uid", ev["uid"])
    ve.add("summary", ev.get("summary") or "")
    if ev.get("description"):
        ve.add("description", ev["description"])
    if ev.get("location"):
        ve.add("location", ev["location"])

    dtstart = ev["dtstart"]
    dtend = ev["dtend"]
    if ev.get("all_day"):
        ve.add("dtstart", dtstart.date())
        ve.add("dtend", dtend.date())
    elif ev.get("is_utc"):
        # 存储为朴素 UTC 时刻 — 重新附加 UTC 使服务器获得 Z 时间。
        ve.add("dtstart", dtstart.replace(tzinfo=timezone.utc))
        ve.add("dtend", dtend.replace(tzinfo=timezone.utc))
    else:
        # 旧版朴素本地（"浮动"）时间 — 不带时区发出。
        ve.add("dtstart", dtstart)
        ve.add("dtend", dtend)

    if ev.get("rrule"):
        try:
            ve.add("rrule", vRecur.from_ical(ev["rrule"]))
        except Exception:
            logger.debug("CalDAV write-back: skipping unparseable rrule %r", ev.get("rrule"))

    cal.add_component(ve)
    return cal.to_ical().decode("utf-8")


def find_remote_calendar(calendars, local_cal_id: str, owner: str = "", account_id: str = ""):
    """找到 URL 哈希等于 ``local_cal_id`` 的远程日历，或返回 None。

    ``owner`` 和 ``account_id`` 必须与 ``_sync_blocking`` 中最初计算
    本地日历 id 时使用的值匹配，以确保哈希往返正确。"""
    for cal in calendars:
        try:
            if _stable_cal_id(str(cal.url), owner=owner, account_id=account_id) == local_cal_id:
                return cal
        except Exception:
            continue
    return None


def _resource_href(obj) -> str:
    try:
        return str(getattr(obj, "url", "") or "")
    except Exception:
        return ""


def _resource_etag(obj) -> str:
    try:
        etag = getattr(obj, "etag", None)
        if callable(etag):
            etag = etag()
        return str(etag or "")
    except Exception:
        return ""


def push_event(calendars, local_cal_id: str, ev: dict, *, delete: bool = False,
               owner: str = "", account_id: str = "") -> dict:
    """在匹配的远程日历上创建/更新（或删除）``ev``。

    返回 ``{"ok": bool, ...}``。``calendars`` 是已发现的 caldav
    日历列表（注入参数以便用假对象进行单元测试）。
    ``owner`` 和 ``account_id`` 转发给 ``find_remote_calendar``
    以使 URL 哈希正确往返（#2765）。
    """
    uid = (ev or {}).get("uid") if isinstance(ev, dict) else None
    if not uid:
        return {"ok": False, "error": "event uid is required"}

    remote = find_remote_calendar(calendars, local_cal_id, owner=owner, account_id=account_id)
    if remote is None:
        return {"ok": False, "error": "remote calendar not found"}
    remote_url = str(getattr(remote, "url", "") or "")

    try:
        existing = remote.event_by_uid(uid)
    except Exception:
        existing = None

    if delete:
        if existing is None:
            return {"ok": True, "note": "already absent on remote", "calendar_url": remote_url}
        existing.delete()
        return {
            "ok": True,
            "calendar_url": remote_url,
            "remote_href": _resource_href(existing),
            "remote_etag": _resource_etag(existing),
        }

    ical = build_event_ical(ev)
    if existing is not None:
        existing.data = ical
        existing.save()
        return {
            "ok": True,
            "updated": True,
            "calendar_url": remote_url,
            "remote_href": _resource_href(existing),
            "remote_etag": _resource_etag(existing),
        }
    created = remote.save_event(ical)
    return {
        "ok": True,
        "created": True,
        "calendar_url": remote_url,
        "remote_href": _resource_href(created),
        "remote_etag": _resource_etag(created),
    }


def _discover_calendars(client):
    """Discover the principal's calendars, falling back to the URL itself —
    same strategy as the pull path."""
    from caldav.lib.error import AuthorizationError, NotFoundError
    try:
        return client.principal().calendars()
    except (AuthorizationError, NotFoundError):
        raise
    except Exception:
        try:
            return [client.calendar(url=str(client.url))]
        except Exception:
            return []


def _writeback_blocking(local_cal_id, ev, delete, url, username, password,
                        owner="", account_id="") -> dict:
    from src.caldav_sync import _build_dav_client
    # 此处也禁用重定向：写回路径打开自己的 DAVClient，
    # 因此需要与拉取路径相同的 SSRF-via-redirect 保护。
    client = _build_dav_client(url, username, password)
    calendars = _discover_calendars(client)
    if not calendars:
        return {"ok": False, "error": "no remote calendars discovered"}
    return push_event(calendars, local_cal_id, ev, delete=delete,
                      owner=owner, account_id=account_id)


def _persist_writeback_result(owner: str, calendar_id: str, uid: str, result: dict, *, delete: bool) -> None:
    from core.database import CalendarCal, CalendarDeletedEvent, CalendarEvent, SessionLocal

    if not uid or not isinstance(result, dict):
        return

    db = SessionLocal()
    try:
        calendar = db.query(CalendarCal).filter(
            CalendarCal.id == calendar_id,
            CalendarCal.owner == owner,
        ).first()
        if calendar and result.get("calendar_url"):
            calendar.caldav_base_url = result.get("calendar_url")

        if delete:
            tombstone = db.query(CalendarDeletedEvent).filter(
                CalendarDeletedEvent.uid == uid,
                CalendarDeletedEvent.owner == owner,
            ).first()
            if result.get("ok"):
                if tombstone:
                    db.delete(tombstone)
            elif tombstone:
                tombstone.last_error = str(result.get("error") or result)[:500]
            db.commit()
            return

        event = (
            db.query(CalendarEvent)
            .join(CalendarCal)
            .filter(CalendarEvent.uid == uid, CalendarCal.owner == owner)
            .first()
        )
        if event and result.get("ok"):
            if result.get("remote_href"):
                event.remote_href = result.get("remote_href")
            if result.get("remote_etag"):
                event.remote_etag = result.get("remote_etag")
            event.caldav_sync_pending = None
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("CalDAV write-back metadata persistence failed")
    finally:
        db.close()


async def writeback_event(owner: str, calendar_source: str, calendar_id: str,
                          ev: dict, *, delete: bool = False) -> dict:
    """尽力将本地更改推送到远程 CalDAV 服务器。

    当日历不是 CalDAV 支持的或未配置凭据时无操作
    （``{"skipped": ...}``）。绝不抛出异常 — 远程失败会被记录并返回，
    本地数据库保持为事实来源。
    """
    if calendar_source != "caldav":
        return {"skipped": "not a caldav calendar"}
    try:
        from src.caldav_sync import _load_caldav_accounts
        from src.secret_storage import decrypt
        from core.database import CalendarCal, SessionLocal

        accounts = _load_caldav_accounts(owner)
        if not accounts:
            return {"skipped": "caldav not configured"}

        # 查找哪个帐户拥有此日历。
        acc = None
        if len(accounts) > 1:
            db = SessionLocal()
            try:
                cal_row = db.query(CalendarCal).filter(CalendarCal.id == calendar_id).first()
                cal_account_id = cal_row.account_id if cal_row else None
            finally:
                db.close()
            if cal_account_id:
                acc = next((a for a in accounts if a.get("id") == cal_account_id), None)
        # Fall back to first account (covers single-account and legacy rows with
        # 回退到第一个帐户（覆盖单帐户和没有 account_id 标记的旧数据行）。
        if acc is None:
            acc = accounts[0]

        url = (acc.get("url") or "").strip()
        user = (acc.get("username") or "").strip()
        pw = decrypt(acc.get("password") or "")
        if not (url and user and pw):
            return {"skipped": "caldav account credentials incomplete"}
        from src.caldav_sync import validate_caldav_url
        try:
            url = validate_caldav_url(url)
        except ValueError as e:
            logger.warning("CalDAV write-back URL rejected: %s", e)
            return {"ok": False, "error": str(e)[:200]}
        acc_id = acc.get("id") or ""
        result = await asyncio.to_thread(
            _writeback_blocking, calendar_id, ev, delete, url, user, pw, owner, acc_id
        )
        _persist_writeback_result(owner, calendar_id, (ev or {}).get("uid", ""), result, delete=delete)
        if not result.get("ok"):
            logger.warning("CalDAV write-back did not apply: %s", result.get("error") or result)
        return result
    except Exception as e:
        logger.exception("CalDAV write-back raised")
        result = {"ok": False, "error": str(e)[:200]}
        _persist_writeback_result(owner, calendar_id, (ev or {}).get("uid", ""), result, delete=delete)
        return result
