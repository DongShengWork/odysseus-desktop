// static/js/calendar/提醒s.js
//
// 日历提醒笔记的浏览器通知轮询器。自包含：
// 模块私有的 `_notifFired` 设置 跟踪哪些笔记 ID 我们已经
// 通知过，持久化到 localStorage。每 60 秒轮询 `/api/notes?label=calendar`
// 并对于任何 `due_date` 已过去但在过期窗口内的笔记
// 触发 Notification + 提示条 通知。
//
// `start()` kicks off the poll loop + permission request. Call once from
// the calendar's entry module.

import uiModule from '../ui.js';

const API_BASE = window.location.origin;

let _notifFired = new Set(JSON.parse(localStorage.getItem('cal-notif-fired') || '[]'));

// 计算一个基于系统时钟精确的通知正文。优先尝试
// 笔记的 `event_dtstart`（由 _createEventReminder 设置）；回退到
// 清理 items[0].text 中的过时时间标记，使旧版
// 提醒不会在晚上 9 点显示“in 29 min”。
function _formatReminderBody(note) {
  const dtstartRaw = note.event_dtstart || note.eventDtstart || null;
  if (dtstartRaw) {
    const start = new Date(dtstartRaw);
    if (!isNaN(start.getTime())) {
      const now = new Date();
      const mins = Math.round((start - now) / 60000);
      const when = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      let when2 = '';
      const sameDay = start.toDateString() === now.toDateString();
      if (!sameDay) when2 = ' ' + start.toLocaleDateString([], { month: 'short', day: 'numeric' });
      if (mins >= 1 && mins <= 60) return `Starts in ${mins} min (${when}${when2})`;
      if (mins === 0) return `Starting now (${when}${when2})`;
      if (mins > 60) {
        const h = Math.round(mins / 60);
        return `Starts in ${h} hour${h === 1 ? '' : 's'} (${when}${when2})`;
      }
      if (mins >= -60) return `Started ${Math.abs(mins)} min ago (${when}${when2})`;
      return `Was scheduled for ${when}${when2}`;
    }
  }
  // 旧版笔记（无 event_dtstart）。清理过时的相对时间字符串。
  let body = (note.items || []).map(i => i.text).join('\n') || note.content || '';
  body = body.replace(/\bin\s+\d+\s*(min|minute|hour|hr|day)s?\b/gi, '').trim();
  body = body.replace(/\(\s*\d{1,2}:\d{2}\s*\)/g, '').trim();
  body = body.replace(/\s{2,}/g, ' ');
  return body;
}

// 仅当 `due` 在当前时间前这么多分钟内才触发提醒。
// 防止新浏览器（空 `cal-notif-fired` localStorage）在首次轮询时
// 对每个两周前的提醒都发送垃圾通知。任何更旧的内容会被静默
// 标记为已触发，防止其被持续拾取。
const _REMINDER_STALENESS_MIN = 5;

async function _pollReminders() {
  try {
    const res = await fetch(`${API_BASE}/api/notes?label=calendar`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const notes = await res.json();
    const now = new Date();
    const stalenessMs = _REMINDER_STALENESS_MIN * 60 * 1000;
    for (const note of notes) {
      if (!note.due_date || _notifFired.has(note.id)) continue;
      const due = new Date(note.due_date);
      if (isNaN(due)) continue;
      if (due > now) continue; // 尚未到期
      const ageMs = now - due;
      if (ageMs > stalenessMs) {
        // 太旧而无法触发 — 标记为已见，不每分钟重新检查。
        _notifFired.add(note.id);
        continue;
      }
      _notifFired.add(note.id);
      const body = _formatReminderBody(note);
      fetch(`${API_BASE}/api/notes/fire-reminder`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          note_id: note.id,
          title: note.title || 'Calendar Reminder',
          body,
        }),
      }).catch(() => {});
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(note.title || 'Calendar Reminder', {
          body,
          icon: '/static/favicon.png',
          tag: `cal-remind-${note.id}`,
        });
      }
      if (uiModule.showToast) uiModule.showToast((note.title || 'Calendar Reminder') + (body ? ' — ' + body : ''));
    }
    // 持久化已触发集合（保留最近 200 条）
    const arr = [..._notifFired].slice(-200);
    localStorage.setItem('cal-notif-fired', JSON.stringify(arr));
  } catch (_) {}
}

let _started = false;

// 幂等：多次调用安全。首次调用时启动权限请求
// 和 60 秒轮询循环。
export function startReminderPoll() {
  if (_started) return;
  _started = true;
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  _pollReminders();
  setInterval(_pollReminders, 60000);
}
