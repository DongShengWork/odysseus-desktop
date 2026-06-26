/**
 * 日历模块 — 基于 CalDAV 的月/周/年日历。
 */

import uiModule from './ui.js';
import spinnerModule from './spinner.js';
import * as Modals from './modalManager.js';
import { makeWindowDraggable } from './windowDrag.js';
import { attachColorPicker } from './colorPicker.js';
import { bindMenuDismiss } from './escMenuStack.js';
import {
  WEEKDAYS, WEEKDAYS_SUN, MONTHS, MON_SHORT,
  CAL_PALETTE, CAL_COLORS, _CAL_CUSTOM_GRADIENT, _TYPE_PALETTE,
  _trashIcon, _moreIcon, _bellIcon,
  _isCalBgImage, _calBgImageUrl, _calBgCss,
  _calReadableTextColor,
  _ds, _addDays, _shiftDT, _tzOffset, _localDateOf,
} from './calendar/utils.js';

const API_BASE = window.location.origin;
// 打开文件选择器，上传所选图片，返回 URL 字符串。
function _pickCalBgImage() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.cssText = 'position:fixed; left:-9999px; top:-9999px;';
    document.body.appendChild(input);
    let done = false;
    const finish = (v) => { if (done) return; done = true; input.remove(); resolve(v); };
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      const fd = new FormData();
      fd.append('files', file);
      try {
        const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: fd, credentials: 'same-origin' });
        const data = await res.json();
        const fileId = data.files?.[0]?.id;
        if (!fileId) throw new Error('Upload failed');
        finish(`${API_BASE}/api/upload/${fileId}`);
      } catch { finish(null); }
    });
    setTimeout(() => { if (!done && !input.files?.length) finish(null); }, 30000);
    input.click();
  });
}

let _open = false;
// 在日历打开时设置，以便首次月视图渲染时将今天的
// 单元格滚动到可视区域 — 在移动端网格可滚动，今天可能在
// 视口下方，因此我们始终定位到当前日期。
let _scrollToTodayOnOpen = false;
let _currentDate = new Date();
let _events = [];
let _allEvents = {};
let _fetchedRanges = [];
let _calendars = [];
let _hiddenCals = new Set();
let _hiddenTypes = new Set();   // 要隐藏的 event_type 值
// "仅重要事件"筛选 — 为 true 时，只渲染 importance 为
// high/critical 的事件，不论其类别。通过"!"标签切换；
// 与 _hiddenTypes（处理 event_type 类别）相互独立。
let _onlyImportant = false;

let _filtersCollapsed = localStorage.getItem('cal-filters-collapsed') === '1';
// Week-start preference: 'mon' (default, Mon=first col) or 'sun' (Sun=first col).
let _weekStartSun = localStorage.getItem('cal-week-start') === 'sun';
let _selectedDay = null;
let _view = 'month';
let _searchQuery = '';
let _escHandler = null;
let _modal = null;

let _dragUid = null;
let _sidebarWasOpen = false;
let _slideDir = 0;  // -1 = 上一个, +1 = 下一个, 0 = 无

// （单一撤销栈位于下方更远处的 `_calUndoStack`；此处之前
// 保存的一层 `_lastUndo` 已合并到该栈中。）

function _showCalUndoToast(label, undoFn) {
  // 推送到共享撤销栈（月份拖放也在使用），这样
  // Cmd/Ctrl+Z 和提示按钮使用同一个数据源。
  _pushCalUndo({ label, run: undoFn });
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent || '');
  uiModule.showToast(label, {
    action: 'Undo',
    actionHint: isMac ? '⌘Z' : 'Ctrl+Z',
    duration: 6000,
    onAction: _popAndRunCalUndo,
  });
}

// ── API ──

function _rangeIsCached(start, end) {
  // 检查 [start, end] 是否完全被某个已获取的范围覆盖
  for (const [s, e] of _fetchedRanges) {
    if (s <= start && e >= end) return true;
  }
  return false;
}

function _filterPool(start, end) {
  // 返回事件池中与 [start, end) 重叠的所有事件
  return Object.values(_allEvents).filter(ev => {
    const evStart = ev.all_day ? ev.dtstart : _localDateOf(ev.dtstart);
    const evEnd = ev.all_day ? ev.dtend : _localDateOf(ev.dtend || ev.dtstart);
    return evStart < end && evEnd >= start;
  }).sort((a, b) => a.dtstart < b.dtstart ? -1 : 1);
}

async function _fetchEvents(start, end, force) {
  if (!force && _rangeIsCached(start, end)) {
    _events = _filterPool(start, end);
    return;
  }
  // 如果有缓存数据，立即从池中渲染
  const hasCache = Object.keys(_allEvents).length > 0;
  if (hasCache) _events = _filterPool(start, end);
  const fetchPromise = fetch(`${API_BASE}/api/calendar/events?start=${start}&end=${end}`, { credentials: 'same-origin' })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(data => {
      // 缓存加载后的首次获取时，完全替换池以避免
      // 来自之前后端的过期/重复 UID（如 CalDAV → SQLite）
      if (hasCache && _fetchedRanges.length === 0) _allEvents = {};
      (data.events || []).forEach(ev => { _allEvents[ev.uid] = ev; });
      _fetchedRanges.push([start, end]);
      _events = _filterPool(start, end);
      if (typeof _saveCache === 'function') _saveCache();
      // 新数据到达时后台重新渲染（如果日历仍处于打开状态）
      if (_open && hasCache) _render();
    })
    .catch(e => { console.error('Calendar: failed to fetch events', e); });
  // 如果有缓存，不阻塞请求 — 立即返回以便渲染即时完成
  if (hasCache) return;
  // 无缓存 — 必须等待请求完成
  await fetchPromise;
}

// 后台预取相邻月份 — 发射后不管，不阻塞
function _prefetchAdjacent() {
  const ranges = [];
  if (_view === 'month' || _view === 'week') {
    // 预取当前前后 ±2 个月
    for (let offset = -2; offset <= 2; offset++) {
      if (offset === 0) continue;
      const d = new Date(_currentDate.getFullYear(), _currentDate.getMonth() + offset, 1);
      ranges.push(_monthRange(d));
    }
  } else if (_view === 'year') {
    // 预取上一年/下一年
    ranges.push([`${_currentDate.getFullYear() - 1}-01-01`, `${_currentDate.getFullYear()}-01-01`]);
    ranges.push([`${_currentDate.getFullYear() + 1}-01-01`, `${_currentDate.getFullYear() + 2}-01-01`]);
  }
  // 并行发起所有预取，忽略失败
  for (const [s, e] of ranges) {
    if (_rangeIsCached(s, e)) continue;
    fetch(`${API_BASE}/api/calendar/events?start=${s}&end=${e}`, { credentials: 'same-origin' })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(d => {
        (d.events || []).forEach(ev => { _allEvents[ev.uid] = ev; });
        _fetchedRanges.push([s, e]);
      })
      .catch(() => {});
  }
}

let _calendarsError = null;
// 守卫变量，确保每页加载只触发一次打开时的 CalDAV 拉取 —
// 每个列表/渲染路径都调用 _fetchCalendars，但我们只想
// 在用户首次打开时惰性地访问远程服务器。
let _caldavSyncedOnce = false;
async function _fetchCalendars() {
  _calendarsError = null;
  try {
    const res = await fetch(`${API_BASE}/api/calendar/calendars`, { credentials: 'same-origin' });
    const data = await res.json();
    _calendars = data.calendars || [];
    if (data.error) _calendarsError = data.error;
    _calendars.forEach((c, i) => {
      if (!c.color || c.color.startsWith('<')) c.color = CAL_PALETTE[i % CAL_PALETTE.length];
    });
  } catch (e) { _calendars = []; _calendarsError = e.message || 'Connection failed'; }

  // 首次打开：触发后台 CalDAV 拉取。我们不等待 —
  // 初始渲染使用本地已缓存的内容，
  // 同步的写入在解析后的下一次绘制时显示。
  if (!_caldavSyncedOnce) {
    _caldavSyncedOnce = true;
    _syncCaldav(false);
  }
}

// 触发 CalDAV 拉取。`interactive=true` 等待结果并
// 刷新 UI；false 发射后不管（用于首次打开）。两者
// 在 CalDAV 未配置时静默空操作。
async function _syncCaldav(interactive) {
  try {
    const res = await fetch(`${API_BASE}/api/calendar/sync`, {
      method: 'POST', credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (interactive) return data;
    // 后台路径：如果拉取确实改变了什么，丢弃
    // 本地缓存并重新渲染，以便新事件显示。
    const changed = (data.calendars || 0) > 0 && ((data.events || 0) > 0 || (data.deleted || 0) > 0);
    if (changed) {
      _allEvents = {}; _fetchedRanges = [];
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
      await _fetchCalendars();
      _render();
    }
  } catch (e) {
    if (interactive) return { errors: [e.message || 'Sync failed'] };
  }
}

function _optimisticEvent(data, uid) {
  const cal = _calendars.find(c => c.href === data.calendar_href) || _calendars[0];
  return {
    uid,
    summary: data.summary || '',
    dtstart: data.dtstart,
    dtend: data.dtend || data.dtstart,
    all_day: !!data.all_day,
    description: data.description || '',
    location: data.location || '',
    rrule: data.rrule || '',
    calendar: cal?.name || '',
    calendar_href: data.calendar_href || cal?.href || '',
    // 每个事件的颜色覆盖（包括自定义背景的 bg:<url> 标记，
    // 优先级高于父日历的默认十六进制颜色。
    color: (data.color !== undefined && data.color !== null) ? data.color : (cal?.color || ''),
  };
}

// v2 回顾错误处理：此处之前的每个 fetch 都只检查
// `.then(r => r.json())` 而没有 `r.ok` 测试。500/404 仍然
// 会 resolve promise，乐观状态被当作成功。
// 现在三个流程都检查 `r.ok` 并在失败路径上回滚
// 乐观状态 + 显示提示信息。
async function _createEvent(data) {
  const tempUid = 'temp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  _allEvents[tempUid] = _optimisticEvent(data, tempUid);
  fetch(`${API_BASE}/api/calendar/events`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }).then(async r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(d => {
    if (d.uid) {
      delete _allEvents[tempUid];
      _allEvents[d.uid] = _optimisticEvent(data, d.uid);
      _saveCache && _saveCache();
      if (_open) _render();
    }
  }).catch((e) => {
    delete _allEvents[tempUid];
    if (_open) _render();
    if (window.uiModule) window.uiModule.showError('Failed to create event: ' + (e?.message || 'unknown'));
  });
  return { uid: tempUid };
}

async function _updateEvent(uid, data) {
  const merged = { ...(_allEvents[uid] || {}), ...data };
  const _preMergeBackup = _allEvents[uid];
  _allEvents[uid] = _optimisticEvent(merged, uid);
  // 对于重复事件，uid 是复合形式 "{base_uid}::{date}" —
  // 后端将其解析为基础系列行。更新后，
  // 同一系列的其他事件已过时。清除缓存以便
  // 重新获取能拿到最新数据（下次渲染 + 预取会处理）。
  const isRecurring = uid.includes('::');
  fetch(`${API_BASE}/api/calendar/events/${encodeURIComponent(uid)}`, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (isRecurring) {
      _fetchedRanges = [];
      localStorage.removeItem(LS_KEY);
    } else {
      _saveCache && _saveCache();
    }
  }).catch((e) => {
    if (_preMergeBackup) _allEvents[uid] = _preMergeBackup;
    else delete _allEvents[uid];
    if (_open) _render();
    if (window.uiModule) window.uiModule.showError('Failed to update event: ' + (e?.message || 'unknown'));
  });
  return { ok: true };
}

async function _deleteEvent(uid) {
  // 多个"兄弟"UID 可能需要乐观地消失：
  //   1. 用户点击的确切 uid。
  //   2. 如果用户点击了重复事件实例（uid 包含 "::"），
  //      服务器删除主记录 + 所有实例 — 因此我们也从
  //      客户端缓存中移除主 uid 和所有 "master::*" 扩展。
  //      没有这个处理，删除多天重复任务的某一天只会
  //      在视觉上删除那一天；其他天会继续渲染直到下次完全刷新。
  //
  //   3. 如果用户点击了主记录，同样移除所有 "master::*"
  //      扩展（相同前缀扫描）。
  const masterUid = uid.includes('::') ? uid.split('::')[0] : uid;
  const backups = {};
  const _matches = (k) => k === uid || k === masterUid || k.startsWith(masterUid + '::');

  for (const k of Object.keys(_allEvents)) {
    if (_matches(k)) {
      backups[k] = _allEvents[k];
      delete _allEvents[k];
    }
  }
  if (Array.isArray(_events)) {
    _events = _events.filter(e => !(e && _matches(e.uid || '')));
  }
  if (_open) _render();
  _updateBadge && _updateBadge();
  const isRecurring = uid.includes('::');
  fetch(`${API_BASE}/api/calendar/events/${encodeURIComponent(uid)}`, {
    method: 'DELETE', credentials: 'same-origin',
  }).then(r => {
    // 404 = 事件已被其他会话/设备删除。这正是
    // 我们想要的状态，因此视为成功 — 不要恢复
    // 该行，否则用户永远无法清除那些在桌面端打开时
    // 被移动端删除的过期缓存事件（反之亦然）。
    if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
    if (isRecurring) {
      _fetchedRanges = [];
      localStorage.removeItem(LS_KEY);
    } else {
      _saveCache && _saveCache();
    }
  }).catch((e) => {
    // 服务器拒绝 — 恢复我们乐观移除的每个 uid。
    for (const [k, ev] of Object.entries(backups)) {
      _allEvents[k] = ev;
      if (Array.isArray(_events)) _events.push(ev);
    }
    if (window.uiModule) window.uiModule.showError('Failed to delete event: ' + (e?.message || 'unknown'));
    if (_open) _render();
  });
  return { ok: true };
}

// ── 日期工具 ──
// _ds, _addDays, _shiftDT, _localDateOf, _tzOffset 位于 ./calendar/utils.js
// _monthRange / _weekRange / _today 依赖 _ds，因此保留在这里。

function _today() { return _ds(new Date()); }

function _monthRange(d) {
  const y = d.getFullYear(), m = d.getMonth();
  const first = new Date(y, m, 1);
  const dow = _weekStartSun ? first.getDay() : (first.getDay() + 6) % 7;
  const gs = new Date(y, m, 1 - dow);
  const ge = new Date(gs); ge.setDate(gs.getDate() + 42);
  return [_ds(gs), _ds(ge)];
}

function _weekRange(d) {
  const dow = _weekStartSun ? d.getDay() : (d.getDay() + 6) % 7;
  const s = new Date(d); s.setDate(d.getDate() - dow);
  const e = new Date(s); e.setDate(s.getDate() + 7);
  return [_ds(s), _ds(e)];
}

function _eventsForDay(dateStr) {
  return _events.filter(e => {
    if (!_eventVisible(e)) return false;
    if (e.all_day) {
      // 零时长的全天事件（dtstart == dtend）是单日事件
      if (e.dtstart === e.dtend) return e.dtstart === dateStr;
      return e.dtstart <= dateStr && e.dtend > dateStr;
    }
    // 多日定时事件：在其跨越的每一天显示
    const startDate = _localDateOf(e.dtstart);
    const endDate = _localDateOf(e.dtend);
    if (startDate !== endDate) return startDate <= dateStr && endDate >= dateStr;
    return startDate === dateStr;
  });
}

function _calColor(ev) {
  // 自定义背景图片颜色在需要纯色的位置（圆点、多日条、周视图
  // 边框等）回退到父日历的纯色十六进制值。
  // 完整图片在合适的地方（事件项行）通过 _calItemBgStyle() 显示。
  //
  if (_isCalBgImage(ev.color)) {
    const c = _calendars.find(c => c.href === ev.calendar_href);
    return c?.color || 'var(--accent)';
  }
  if (ev.color && !ev.color.startsWith('<')) return ev.color;
  const c = _calendars.find(c => c.href === ev.calendar_href);
  return c?.color || 'var(--accent)';
}

function _calEventFg(ev) {
  return _calReadableTextColor(_calColor(ev));
}

// 事件行有自定义背景图片时的额外内联样式。
// 普通纯色事件返回空字符串。
function _calItemBgStyle(ev) {
  if (!_isCalBgImage(ev.color)) return '';
  const url = _calBgImageUrl(ev.color).replace(/'/g, "\\'").replace(/"/g, "%22");
  return `background-image: linear-gradient(color-mix(in srgb, var(--bg) 70%, transparent), color-mix(in srgb, var(--bg) 70%, transparent)), url('${url}'); background-size: cover; background-position: center;`;
}

function _todayCount() {
  const t = _today();
  return _events.filter(e => {
    if (!_eventVisible(e)) return false;
    if (e.all_day) {
      if (e.dtstart === e.dtend) return e.dtstart === t;
      return e.dtstart <= t && e.dtend > t;
    }
    return _localDateOf(e.dtstart) === t;
  }).length;
}

// 每个事件的 ⋮ 菜单：提醒我 / 删除
function _wireQuickDelete(body) {
  body.querySelectorAll('.cal-event-more').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = btn.dataset.uid;
      if (!uid) return;
      const ev = _allEvents[uid];
      if (!ev) return;
      _showEventMoreMenu(ev, btn);
    });
  });
}

function _clampDropdown(dropdown, anchorRect) {
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = dropdown.getBoundingClientRect();
  const w = r.width, h = r.height;
  // 水平方向：优先与锚点右对齐，限制在视口内
  let left = anchorRect.right - w;
  if (left + w > vw - margin) left = vw - margin - w;
  if (left < margin) left = margin;
  // 垂直方向：如能容纳则放在锚点下方，否则放上方
  let top = anchorRect.bottom + 4;
  if (top + h > vh - margin) {
    const above = anchorRect.top - 4 - h;
    top = above >= margin ? above : Math.max(margin, vh - margin - h);
  }
  dropdown.style.left = `${left}px`;
  dropdown.style.top = `${top}px`;
  dropdown.style.right = 'auto';
}

function _showEventMoreMenu(ev, anchor) {
  document.querySelectorAll('.cal-event-dropdown').forEach(d => { if (typeof d._dismiss === 'function') d._dismiss(); else d.remove(); });
  const dropdown = document.createElement('div');
  dropdown.className = 'cal-event-dropdown';
  let closeMenu = () => dropdown.remove();
  const rect = anchor.getBoundingClientRect();
  dropdown.style.cssText = `position:fixed;z-index:10001;min-width:180px;background:var(--panel,var(--bg));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.3);padding:4px;font-size:12px;top:${rect.bottom + 4}px;left:0px;visibility:hidden;`;

  const _item = (icon, label, onClick, danger) => {
    const it = document.createElement('div');
    it.className = 'dropdown-item-compact' + (danger ? ' dropdown-item-danger' : '');
    it.innerHTML = `<span class="dropdown-icon">${icon}</span><span>${label}</span>`;
    it.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return it;
  };

  const _editIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

  dropdown.appendChild(_item(_editIcon, 'Edit', () => {
    closeMenu();
    _showEventForm(ev);
  }));

  dropdown.appendChild(_item(_trashIcon, 'Delete', async () => {
    closeMenu();
    const name = ev.summary ? `"${ev.summary}"` : 'this event';
    const ok = await uiModule.styledConfirm(t('calendar.delete_event_confirm', { name: name }), { confirmText: t('common.delete'), danger: true });
    if (!ok) return;
    try { await _deleteEvent(ev.uid); setTimeout(() => _render(), 100); } catch (_) {}
  }, true));

  document.body.appendChild(dropdown);
  dropdown._anchorRect = rect;
  _clampDropdown(dropdown, rect);
  dropdown.style.visibility = '';
  closeMenu = bindMenuDismiss(dropdown, () => dropdown.remove(), (ev2) => !dropdown.contains(ev2.target) && ev2.target !== anchor);}

async function _createEventReminder(ev, dueDate) {
  // Store the reminder as an absolute UTC instant (with the Z suffix) so the
  // notification poller fires at the right wall-clock moment regardless of:
  //   - the event's source timezone (CalDAV/import may carry a TZID),
  //   - the user's current local timezone differing from when the reminder
  //     was created,
  //   - any naive ISO mis-interpretation downstream.
  // notes.js 和日历轮询都已使用 `new Date(due_date)`，
  // which handles Z-suffixed ISO correctly and converts back to local time
  // when displayed.
  const iso = new Date(dueDate).toISOString();
  const startFmt = ev.all_day
    ? new Date(ev.dtstart).toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' })
    : new Date(ev.dtstart).toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  const summary = ev.summary || '(no title)';
  const loc = ev.location ? ` @ ${ev.location}` : '';
  const text = `${summary}${loc} — ${startFmt}`;
  const payload = {
    title: `Reminder: ${summary}`,
    note_type: 'todo',
    items: [{ text, done: false, checked: false }],
    label: 'calendar',
    due_date: iso,
    source: 'calendar',
    // Persist the EVENT'S absolute start so the notification body can be
    // computed live at fire time ("Starts in 5 min") instead of using a
    // stale string baked at scheduling time.
    event_dtstart: new Date(ev.dtstart).toISOString(),
  };
  try {
    const res = await fetch(`/api/notes`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed');
    const fmt = dueDate.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    if (uiModule.showToast) uiModule.showToast(t('calendar.reminder_set_for', { time: fmt }));
    try { window.notesModule?.refreshDueBadge?.({ force: true }); } catch {}
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch {}
    }
  } catch (e) {
    if (uiModule.showError) uiModule.showError('Failed to create reminder');
  }
}

// ── 侧边栏折叠 ──

function _collapseSidebar() {
  const sb = document.getElementById('sidebar');
  if (sb && !sb.classList.contains('hidden')) {
    // 仅在桌面端记住之前的状态。在移动端侧边栏是
    // 一种覆盖层，用户打开工具时会主动滑动/点击关闭 —
    // 关闭时再弹回来是不期望的行为。
    if (window.innerWidth >= 700) _sidebarWasOpen = true;
    sb.classList.add('hidden');
    if (window.syncRailSide) window.syncRailSide();
  }
}

function _restoreSidebar() {
  if (_sidebarWasOpen) {
    const sb = document.getElementById('sidebar');
    if (sb) { sb.classList.remove('hidden'); if (window.syncRailSide) window.syncRailSide(); }
    _sidebarWasOpen = false;
  }
}

// ── 角标 ──

const BADGE_SEEN_KEY = 'odysseus-calendar-badge-seen';

function _todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _isBadgeSeenToday() {
  try { return localStorage.getItem(BADGE_SEEN_KEY) === _todayStr(); } catch { return false; }
}

function _markBadgeSeen() {
  try { localStorage.setItem(BADGE_SEEN_KEY, _todayStr()); } catch {}
}

function _updateBadge() {
  const btn = document.getElementById('tool-calendar-btn');
  if (!btn) return;
  let badge = btn.querySelector('.cal-badge');
  const count = _todayCount();
  if (count > 0 && !_isBadgeSeenToday()) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'cal-badge'; btn.appendChild(badge); }
    badge.title = `${t('calendar.events_today', { n: count })}`;
  } else if (badge) badge.remove();
}

// ── 模态框 ──

function _getModal() {
  if (_modal) return _modal;
  _modal = document.createElement('div');
  _modal.id = 'calendar-modal';
  _modal.className = 'modal';
  _modal.style.display = 'none';
  _modal.innerHTML = `
    <div class="modal-content cal-modal-content">
      <div class="modal-header">
        <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Calendar</h4>
        <button class="close-btn" id="cal-close">✖</button>
      </div>
      <div class="modal-body" id="cal-body"></div>
    </div>`;
  document.body.appendChild(_modal);
  _modal.querySelector('#cal-close').addEventListener('click', closeCalendar);
  _modal.addEventListener('click', (e) => { if (e.target === _modal) closeCalendar(); });
  // 使可拖动 — 用一次共享工具函数调用替代了约 50 行内联
  // 拖放/停靠代码。日历不支持全屏吸附，因此此处无需
  // fsClass / enter/exit 回调。
  {
    const content = _modal.querySelector('.modal-content');
    const header = _modal.querySelector('.modal-header');
    if (content && header) {
      makeWindowDraggable(_modal, { content, header });
    }
  }
  return _modal;
}

// ── 渲染调度 ──

// Quick-add hint examples — the placeholder cycles through these every few
// seconds so users see different prompt shapes (events, deadlines, recurring).
const _QA_HINT_EXAMPLES = [
  'return home to Ithaca 1pm tmrw',
  'dinner with Penelope Friday 8pm',
  'coffee with Athena 9am Saturday',
  'call Telemachus tomorrow morning',
  'dentist appointment 3pm next Tuesday',
  'finish the wooden horse by Friday EOD',
  'gym 7am every weekday',
  'flight to Athens Sunday 6:30am',
  'crew muster 10am daily',
  'council on Ithaca Monday 2pm',
];
function _initQuickAddHintCycle() {
  const span = document.getElementById('qa-hint-example');
  if (!span) return;
  // Pick one random example per calendar open — no interval cycling.
  const idx = Math.floor(Math.random() * _QA_HINT_EXAMPLES.length);
  span.textContent = _QA_HINT_EXAMPLES[idx];
}

// 在重新渲染前保存快速添加输入框的状态（焦点 + 光标 + 值），
// 这样后台获取不会在用户输入中途打断。新 DOM
// 落地后由 _wireAll 恢复。
let _qaPendingRestore = null;
function _saveQuickAddState() {
  const el = document.getElementById('cal-quickadd');
  if (!el || document.activeElement !== el) { _qaPendingRestore = null; return; }
  _qaPendingRestore = {
    value: el.value,
    selStart: el.selectionStart,
    selEnd: el.selectionEnd,
  };
}

// 用户正在快速添加输入框中时为 true。在移动端，
// DOM 重建后的编程式重新聚焦无法重新打开软键盘，因此
// 我们绝对不能在有活跃的快速添加时替换日历主体 —
// 我们推迟渲染并在失焦时刷新数据。
let _renderPending = false;
let _qaSubmitting = false;
function _qaTyping() {
  const el = document.getElementById('cal-quickadd');
  return !!el && document.activeElement === el;
}

// 仅更新日详情面板的搜索结果部分，保持
// 搜索输入框元素本身在 DOM 中，这样屏幕键盘
// 不会在每次按键间收起。由搜索输入的 `input`
// 监听器使用，而非完整的 _render()。
function _updateDaySearchResults() {
  const dayDetail = document.querySelector('.cal-day-detail');
  if (!dayDetail) { _render(); return; }
  // 搜索会强制选择一个日期，这样面板始终可用
  // （与 _render 中的逻辑匹配）。
  if (_searchQuery && !_selectedDay) _selectedDay = _today();
  const ds = _selectedDay || _today();
  // 在分离的节点中构建日详情 HTML，以便提取其
  // 子元素（结果、标题等），而不触碰活跃的输入框。
  const tmp = document.createElement('div');
  tmp.innerHTML = _dayDetailHTML(ds);
  const fresh = tmp.querySelector('.cal-day-detail');
  if (!fresh) return;
  // 移除活跃日详情中除 search-wrap 外的所有子元素。
  const keep = dayDetail.querySelector('.cal-search-wrap');
  [...dayDetail.children].forEach(c => { if (c !== keep) c.remove(); });
  // 将新构建的子元素移到活跃面板中，跳过
  // 重复的 search-wrap。
  [...fresh.children].forEach(c => {
    if (!c.classList.contains('cal-search-wrap')) dayDetail.appendChild(c);
  });
  // 重新绑定新插入的事件行的点击处理。
  dayDetail.querySelectorAll('.cal-event-item').forEach(it => {
    it.addEventListener('click', (e) => {
      if (e.target.closest('.cal-event-more')) return;
      const ev = _events.find(x => x.uid === it.dataset.uid);
      if (ev) _showEventForm(ev);
    });
  });
  dayDetail.querySelector('#cal-add-day')?.addEventListener('click', () => _showEventForm(null, _selectedDay));
  _wireQuickDelete(dayDetail);
}

// 按"缩放级别"在日历视图间切换 — 捏合放大是 year→month→week，
// 捏合缩小则相反。Agenda 是独立的视图，因此被排除在外。
function _zoomView(direction) {
  const chain = ['year', 'month', 'week'];
  const idx = chain.indexOf(_view);
  if (idx < 0) return;
  const next = idx + direction;
  if (next < 0 || next >= chain.length) return;
  _view = chain[next];
  _render();
}

// 每次 _render() 调用自增的单调计数器。每个视图的异步
// 渲染函数在入口处记录该值，如果更新的渲染已经开始，
// 则在绘制 DOM 前退出，防止快速的上一页/下一页/今天点击
// 让慢速的数据获取覆盖最新布局。
let _renderToken = 0;
function _isStaleRender(t) { return t !== _renderToken; }

function _render() {
  // 用户正在快速添加中输入时不要重建 DOM — 推迟它。
  if (_qaTyping()) { _renderPending = true; return; }
  // 空状态：没有配置日历或连接失败
  if (!_calendars.length) {
    _renderEmpty();
    return;
  }
  _renderToken++;
  // 搜索现在在日详情面板内并进行就地筛选，
  // 因此查询活跃时不替换整个日历主体。
  // 在月/周视图中强制选择一个日期，确保面板（及其搜索框）
  // 始终可用。
  if (_searchQuery && (_view === 'month' || _view === 'week') && !_selectedDay) {
    _selectedDay = _today();
  }
  if (_view === 'agenda') _renderAgenda();
  else if (_view === 'year') _renderYear();
  else if (_view === 'week') _renderWeek();
  else _renderMonth();
  // 短暂延迟后在后台预取相邻数据
  setTimeout(() => _prefetchAdjacent(), 200);
}

function _renderEmpty() {
  const body = document.getElementById('cal-body');
  if (!body) return;
  const hasError = !!_calendarsError;
  body.innerHTML = `
    <div class="cal-empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3">
        <rect x="3" y="4" width="18" height="18" rx="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
      <div class="cal-empty-title">${hasError ? 'Calendar unavailable' : 'No calendars yet'}</div>
      <div class="cal-empty-msg">${hasError ? _e(_calendarsError) : 'Create a local calendar, import an .ics file, or sync via CalDAV.'}</div>
      ${hasError ? `
        <button class="cal-btn cal-btn-primary" id="cal-goto-settings">${t('calendar.open_settings')}</button>
      ` : `
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:4px;">
          <button class="cal-btn cal-btn-primary" id="cal-empty-new">${t('calendar.new_calendar')}</button>
          <button class="cal-btn" id="cal-empty-import">Import .ics</button>
        </div>
        <div style="margin-top:10px;font-size:11px;opacity:0.55;">Or <a href="#" id="cal-empty-caldav" style="color:var(--accent, var(--red));text-decoration:none;font-weight:600;">${t('calendar.setup_caldav')}</a>.</div>
      `}
    </div>`;
  document.getElementById('cal-goto-settings')?.addEventListener('click', () => {
    closeCalendar();
    const modal = document.getElementById('settings-modal');
    if (modal) {
      modal.classList.remove('hidden');
      const tab = modal.querySelector('[data-settings-tab="integrations"]');
      if (tab) tab.click();
    }
  });
  // 新建 / 导入打开日历设置面板；面板已有
  // "新建日历"按钮和 .ics 文件选择器。导入
  // 会立即触发文件选择器，实现一键流程。
  document.getElementById('cal-empty-new')?.addEventListener('click', () => {
    _showCalSettings();
    setTimeout(() => document.getElementById('cal-settings-add')?.click(), 50);
  });
  document.getElementById('cal-empty-import')?.addEventListener('click', () => {
    _showCalSettings();
    setTimeout(() => document.getElementById('cal-import-file')?.click(), 50);
  });
  document.getElementById('cal-empty-caldav')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeCalendar();
    // 集成是管理员选项卡 — settingsModule.open() 仅设置
    // 管理员选项卡的 .active 类；实际面板通过
    //
    // 模态框会显示为集成被高亮但显示的是上一个
    // 面板，用户需要再次点击选项卡才能到达目标。
    if (window.adminModule && typeof window.adminModule.open === 'function') {
      try { window.adminModule.open('integrations'); return; } catch (_) {}
    }
    if (window.settingsModule && typeof window.settingsModule.open === 'function') {
      try { window.settingsModule.open('integrations'); return; } catch (_) {}
    }
    const modal = document.getElementById('settings-modal');
    if (modal) {
      modal.classList.remove('hidden');
      const tab = modal.querySelector('[data-settings-tab="integrations"]');
      if (tab) tab.click();
    }
  });
}

// ── 标题 + 筛选器（共享） ──

function _isoWeekNumber(d) {
  // ISO 8601：周从星期一开始；第 1 周包含该年的第一个星期四。
  const tgt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // 移到本周的星期四（以便正确确定年份）。
  tgt.setDate(tgt.getDate() + 3 - ((tgt.getDay() + 6) % 7));
  const yearStart = new Date(tgt.getFullYear(), 0, 1);
  return Math.ceil(((tgt - yearStart) / 86400000 + 1) / 7);
}

function _headerHTML() {
  const weekSuffix = _view === 'week'
    ? ` <span class="cal-week-no">W${_isoWeekNumber(_currentDate)}</span>`
    : '';
  return `<div class="cal-toolbar">
    <div class="cal-toolbar-nav">
      <button class="cal-nav" id="cal-prev">&larr;</button>
      <button class="cal-nav cal-today-btn" id="cal-today">Today</button>
      <span class="cal-title">${_view === 'agenda' ? 'Upcoming' : MONTHS[_currentDate.getMonth()] + ' ' + _currentDate.getFullYear()}${weekSuffix}</span>
      <button class="cal-nav" id="cal-next">&rarr;</button>
    </div>
    <div class="cal-toolbar-right">
      <div class="cal-view-toggle">
        ${['week', 'month', 'year', 'agenda'].map(v =>
          `<button class="cal-view-btn${_view === v ? ' active' : ''}" data-view="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`
        ).join('')}
      </div>
      <button class="cal-nav" id="cal-settings" title="Calendar settings" style="position:relative;top:-3px;"><svg width="13" height="13" style="position:relative;top:2px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.68 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
      <button class="cal-nav${window._calSyncing ? ' cal-syncing' : ''}${window._calSyncDone ? ' cal-sync-done' : ''}" id="cal-sync" title="Refresh from database" style="position:relative;top:-3px;">${window._calSyncDone ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>'}</button>
      ${_filtersToggleHTML()}
      <button class="cal-add-btn cal-add-btn-text" id="cal-add" title="New event"><span class="cal-add-plus">+</span><span class="cal-add-label">${t('calendar.new_event')}</span></button>
    </div>
  </div>
  <div class="cal-quickadd-row" id="cal-quickadd-row">
    <input
      type="text"
      id="cal-quickadd"
      class="cal-quickadd-input"
      placeholder=" "
      autocomplete="off"
    />
    <span class="cal-quickadd-hint" id="cal-quickadd-hint" aria-hidden="true"><span class="qa-hint-accent">Quick add</span> — <span class="qa-hint-example" id="qa-hint-example">return home to Ithaca 1pm tmrw</span> <svg class="qa-hint-enter" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></span>
    <span class="cal-quickadd-status" id="cal-quickadd-status"></span>
  </div>`;
}

function _filtersData() {
  // 构建一次标签 HTML；被工具栏切换 + 标签行渲染器复用。
  let calFilters = '';
  if (_calendars.length > 1) {
    calFilters = _calendars.map(c => {
      const off = _hiddenCals.has(c.href);
      return `<label class="cal-filter-item${off ? ' cal-filter-off' : ''}" data-href="${_e(c.href)}">
        <span class="cal-filter-dot" style="background:${c.color}"></span>${_e(c.name)}</label>`;
    }).join('');
  }
  const presentTypes = new Set(_events.map(e => e.event_type).filter(Boolean));
  const hasUntagged = _events.some(e => !e.event_type);
  const hasImportant = _events.some(e => e.importance === 'high' || e.importance === 'critical');
  if (hasImportant) presentTypes.add('!');
  const typeOrder = ['!', 'work', 'personal', 'health', 'travel', 'meal', 'social', 'admin', 'other'];
  let typeFilters = '';
  for (const t of typeOrder) {
    if (!presentTypes.has(t)) continue;
    const off = (t === '!') ? false : _hiddenTypes.has(t);
    const active = (t === '!') && _onlyImportant;
    const label = t === '!' ? '! important' : t;
    typeFilters += `<label class="cal-filter-item${off ? ' cal-filter-off' : ''}${active ? ' cal-filter-active' : ''}${t === '!' ? ' cal-filter-important' : ''}" data-type="${t}">
      <span class="cal-filter-dot" style="background:${_TYPE_PALETTE[t]}"></span>${label}</label>`;
  }
  if (hasUntagged) {
    const off = _hiddenTypes.has('__untagged__');
    typeFilters += `<label class="cal-filter-item${off ? ' cal-filter-off' : ''}" data-type="__untagged__">
      <span class="cal-filter-dot" style="background:${_TYPE_PALETTE.untagged}"></span>${t('calendar.untagged')}</label>`;
  }
  return { calFilters, typeFilters };
}

function _filtersToggleHTML() {
  // 仅内联工具栏按钮。标签行在下方单独渲染。
  const { calFilters, typeFilters } = _filtersData();
  if (!calFilters && !typeFilters) return '';
  return `<button class="cal-filter-toggle" id="cal-filter-toggle" title="${_filtersCollapsed ? 'Show filters' : 'Hide filters'}">${_filtersCollapsed ? '+ tags' : '− tags'}</button>`;
}

function _filtersRowHTML() {
  // 工具栏下方的标签行 — 折叠时为空。
  if (_filtersCollapsed) return '';
  const { calFilters, typeFilters } = _filtersData();
  if (!calFilters && !typeFilters) return '';
  const sep = (calFilters && typeFilters) ? '<span style="opacity:0.3;margin:0 4px">·</span>' : '';
  return `<div class="cal-filters">${calFilters}${sep}${typeFilters}</div>`;
}

function _eventVisible(e) {
  if (_hiddenCals.has(e.calendar_href)) return false;
  // "仅重要事件"模式会使类别筛选器短路：不关心其他因素
  // 只关心事件本身是否为 high/critical。
  if (_onlyImportant) {
    return e.importance === 'high' || e.importance === 'critical';
  }
  if (e.event_type) {
    if (_hiddenTypes.has(e.event_type)) return false;
  } else if (_hiddenTypes.has('__untagged__')) {
    return false;
  }
  return true;
}

// ── 月视图 ──

async function _renderMonth() {
  const body = document.getElementById('cal-body');
  if (!body) return;
  const _tk = _renderToken;
  const [rs, re] = _monthRange(_currentDate);
  await _fetchEvents(rs, re);
  if (_isStaleRender(_tk)) return; // 更新的渲染已在运行中
  const today = _today();
  const y = _currentDate.getFullYear(), m = _currentDate.getMonth();

  const slideClass = _slideDir > 0 ? ' cal-slide-in-right' : _slideDir < 0 ? ' cal-slide-in-left' : '';
  _slideDir = 0;
  let h = _headerHTML() + _filtersRowHTML() + `<div class="cal-grid${slideClass}">`;
  h += '<div class="cal-week-headers">';
  for (const wd of (_weekStartSun ? WEEKDAYS_SUN : WEEKDAYS)) h += `<div class="cal-weekday">${wd}</div>`;
  h += '</div>';

  const first = new Date(y, m, 1);
  const dow = _weekStartSun ? first.getDay() : (first.getDay() + 6) % 7;
  const gs = new Date(y, m, 1 - dow);

  const multiDay = _events.filter(e => {
    if (!_eventVisible(e)) return false;
    const startD = new Date(e.dtstart), endD = new Date(e.dtend);
    return Math.round((endD - startD) / 86400000) > 1 || (!e.all_day && _localDateOf(e.dtstart) !== _localDateOf(e.dtend));
  });
  const multiUids = new Set(multiDay.map(e => e.uid));

  // 渲染 6 个周行。每行是一个定位容器，包含
  // 7 个日单元格以及任何跨越该行的多日条，作为
  // 绝对定位覆盖层绘制在单元格上方。这避免了旧的"每个
  // 条位于其起始单元格内且在单元格边缘被裁剪"
  // 的问题，使多日事件在覆盖的每一天显示为
  // 一条连续的线。
  for (let row = 0; row < 6; row++) {
    // 统计本行有多少多日条与任何列重叠，以便
    // 单元格可以为它们预留顶部内边距 — 否则这些条
    // （作为绝对覆盖层绘制）会覆盖在日期数字和
    // 下方单事件行之上。
    const rowStartCd0 = new Date(gs); rowStartCd0.setDate(gs.getDate() + row * 7);
    const rowEndCd0 = new Date(gs); rowEndCd0.setDate(gs.getDate() + row * 7 + 6);
    const rowStart0 = _ds(rowStartCd0);
    const rowEnd0 = _ds(rowEndCd0);
    const barsInRow = multiDay.filter(md => {
      const mdStart = _localDateOf(md.dtstart);
      const mdEnd = _localDateOf(md.dtend);
      return !(mdEnd < rowStart0 || mdStart > rowEnd0);
    }).length;
    h += `<div class="cal-week-row" style="--bars:${barsInRow}">`;
    // 本行的日单元格
    for (let col = 0; col < 7; col++) {
      const i = row * 7 + col;
      const cd = new Date(gs); cd.setDate(gs.getDate() + i);
      const d = _ds(cd);
      const isOther = cd.getMonth() !== m;
      const cls = 'cal-day' + (isOther ? ' cal-other' : '') + (d === today ? ' cal-today' : '') + (d === _selectedDay ? ' cal-selected' : '');
      h += `<div class="${cls}" data-date="${d}"><span class="cal-day-num">${cd.getDate()}</span>`;
      // 单日事件 — 最多显示 3 个内联行（多日事件
      // 在下方作为覆盖层单独绘制）。
      const singles = _eventsForDay(d).filter(e => !multiUids.has(e.uid));
      if (singles.length) {
        const maxInline = window.innerWidth <= 768 ? 2 : 3;
        const showInline = singles.slice(0, maxInline);
        for (const ev of showInline) {
          const t = ev.all_day ? '' : _fmtTime(ev.dtstart);
          const _impMark = ev.importance === 'critical' ? '<span style="color:var(--red);margin-right:2px" title="critical">!!</span>'
                         : ev.importance === 'high' ? '<span style="color:var(--orange,#e5a33a);margin-right:2px" title="high">!</span>' : '';
          const _typeBadge = ev.event_type ? `<span class="cal-event-type-badge" data-type="${_e(ev.event_type)}" title="${_e(ev.event_type)}"></span>` : '';
          h += `<div class="cal-event-row" draggable="true" data-uid="${_e(ev.uid)}" title="${_e(ev.summary)}${ev.event_type ? ' · ' + ev.event_type : ''}${ev.importance && ev.importance !== 'normal' ? ' · ' + ev.importance : ''}">
            <span class="cal-event-row-dot" style="background:${_calColor(ev)}"></span>
            ${_typeBadge}
            ${t ? `<span class="cal-event-row-time">${t}</span>` : ''}
            <span class="cal-event-row-name">${_impMark}${_e(ev.summary)}</span>
          </div>`;
        }
        if (singles.length > maxInline) h += `<div class="cal-event-more">+${singles.length - maxInline} more</div>`;
      }
      h += '</div>';
    }
    // 本行的多日覆盖条。每条条堆叠在前一条下方一个槽位，
    // 这样同行两个事件不会重叠。
    let barSlot = 0;
    for (const md of multiDay) {
      const mdStart = _localDateOf(md.dtstart);
      const mdEnd = _localDateOf(md.dtend);
      // 计算行的日期范围
      const rowStartCd = new Date(gs); rowStartCd.setDate(gs.getDate() + row * 7);
      const rowEndCd = new Date(gs); rowEndCd.setDate(gs.getDate() + row * 7 + 6);
      const rowStart = _ds(rowStartCd);
      const rowEnd = _ds(rowEndCd);
      if (mdEnd < rowStart || mdStart > rowEnd) continue; // 不在本行
      // 条在行内起始的列以及跨越的天数
      const startCol = mdStart < rowStart ? 0 : ((new Date(mdStart + 'T00:00:00') - rowStartCd) / 86400000);
      const endCol   = mdEnd > rowEnd     ? 6 : ((new Date(mdEnd   + 'T00:00:00') - rowStartCd) / 86400000);
      const startColInt = Math.round(startCol);
      const endColInt = Math.round(endCol);
      const span = endColInt - startColInt + 1;
      // 跨越午夜的分时段事件的按比例偏移
      // （例如 周一 8 PM → 周二 5 AM）。没有这个处理，
      // 过夜时段会视觉上填满整个第二天，即使实际上
      // 只占几个小时。全天事件保持满日形状。
      // 条在视觉上从列 (col+startFrac) 延伸到 (col+span-1+endFrac)，
      // 所以 8 PM→5 AM 显示第 1 天的 ~17% + 第 2 天的 ~21%，而非 200%。
      let startFrac = 0;
      let endFrac = 1;
      if (!md.all_day) {
        try {
          const sIso = md.dtstart || '';
          const eIso = md.dtend || '';
          const sDate = sIso ? new Date(sIso) : null;
          const eDate = eIso ? new Date(eIso) : null;
          // 首日可见比例（0 = 午夜开始）。当事件在本行之前
          // 开始时限制为 0，这样条仍然从
          // 行的左边缘开始。
          if (sDate && !isNaN(sDate) && mdStart >= rowStart) {
            const midnight = new Date(sDate); midnight.setHours(0, 0, 0, 0);
            startFrac = Math.max(0, Math.min(1, (sDate - midnight) / 86400000));
          }
          if (eDate && !isNaN(eDate) && mdEnd <= rowEnd) {
            const midnight = new Date(eDate); midnight.setHours(0, 0, 0, 0);
            endFrac = Math.max(0, Math.min(1, (eDate - midnight) / 86400000));
            // CalDAV 结束时间是排他的：在 N 日 00:00 结束
            // 的事件实际上在 N-1 日结束时结束，因此 endFrac=0
            // 会在视觉上绘制零宽度线段。设置为一个小
            // 可见最小值（一天的 5%）以便条仍然可见。
            if (endFrac === 0) endFrac = 1;
          }
        } catch (_) { startFrac = 0; endFrac = 1; }
      }
      h += `<div class="cal-multiday" style="--col:${startColInt};--span:${span};--slot:${barSlot};--start-frac:${startFrac.toFixed(4)};--end-frac:${endFrac.toFixed(4)};background:${_calColor(md)};--cal-event-fg:${_calEventFg(md)}" draggable="true" data-uid="${_e(md.uid)}" title="${_e(md.summary)}">${_e(md.summary)}</div>`;
      barSlot++;
    }
    h += '</div>';
  }
  h += '</div>';
  if (_selectedDay) h += _dayDetailHTML(_selectedDay);
  // 在 innerHTML 清除之前捕获网格的滚动位置 —
  // 选择某一天不应该让用户跳回月份顶部，
  // 那会隐藏他们刚点击的行。
  const _prevGrid = body.querySelector('.cal-grid');
  const _prevScroll = _prevGrid ? _prevGrid.scrollTop : 0;
  // 如果用户在请求进行中时抓住了快速添加字段，跳过替换（这
  // 会销毁焦点输入框 + 收起键盘）并推迟到失焦时处理。
  if (_qaTyping()) { _renderPending = true; return; }
  body.innerHTML = h;
  const _newGrid = body.querySelector('.cal-grid');
  if (_newGrid && _prevScroll) _newGrid.scrollTop = _prevScroll;
  // 打开时，将今天的单元格滚动到可视区域，以便当前日期始终
  // 可见，即使其行在视口下方（移动端滚动网格）。
  if (_scrollToTodayOnOpen) {
    _scrollToTodayOnOpen = false;
    const todayCell = body.querySelector('.cal-day.cal-today');
    if (todayCell && _newGrid) {
      requestAnimationFrame(() => {
        try { todayCell.scrollIntoView({ block: 'center', behavior: 'auto' }); }
        catch { _newGrid.scrollTop = Math.max(0, todayCell.offsetTop - _newGrid.clientHeight / 2); }
      });
    }
  }
  _wireAll(body);
  _updateBadge();
}

// ── 周视图 ──

// 小时网格周视图。每列是一天；左侧的垂直时间轨
// 标记 6AM–11PM。事件渲染为绝对定位的块。
// 在空单元格上拖动以创建该时段的新事件。
// 渲染完整的 24 小时以便任何时间的事件都能访问。
// 首次打开时网格自动滚动到 ~7 AM，以保持默认
// "早上可见"的行为；后续
// 渲染保留用户当前的 scrollTop 位置。
const WEEK_HOUR_START = 0;
const WEEK_HOUR_END   = 24;
const WK_DEFAULT_SCROLL_HOUR = 7;
let _wkScrollY = null;       // 跨渲染记住的滚动位置
let _wkScrolledOnce = false; // 追踪首次自动滚动到早上的状态
// 每小时像素高度 — 用户可缩放，持久化在 localStorage 中以便
// 偏好设置在重新加载后保持不变。边界限制确保布局合理。
const WK_PX_MIN = 28;
const WK_PX_MAX = 120;
const WK_PX_DEFAULT = 64;
let WEEK_HOUR_PX = (() => {
  const saved = parseInt(localStorage.getItem('cal-wk-hour-px') || '', 10);
  return (saved >= WK_PX_MIN && saved <= WK_PX_MAX) ? saved : WK_PX_DEFAULT;
})();
function _wkSetZoom(px) {
  // 捕获当前视口顶部的时间以便缩放引发的重新渲染
  // 后相同的时间保持原位 — 否则保存的
  // 像素 scrollTop 会在新的像素/小时比例下错位。
  const wrap = document.querySelector('.cal-wk-wrap');
  let _hourAtTop = null;
  if (wrap && WEEK_HOUR_PX) _hourAtTop = wrap.scrollTop / WEEK_HOUR_PX;
  WEEK_HOUR_PX = Math.max(WK_PX_MIN, Math.min(WK_PX_MAX, Math.round(px)));
  try { localStorage.setItem('cal-wk-hour-px', String(WEEK_HOUR_PX)); } catch {}
  if (_hourAtTop != null) _wkScrollY = Math.round(_hourAtTop * WEEK_HOUR_PX);
  if (_view === 'week') _render();
}
function _wkZoomBy(delta) { _wkSetZoom(WEEK_HOUR_PX + delta); }
function _wkHours() { return WEEK_HOUR_END - WEEK_HOUR_START; }

// 将 Y 偏移（距网格顶部的像素）四舍五入到最接近的 15 分钟槽位，
// 返回距 WEEK_HOUR_START 的分钟数。
function _wkPxToMin(y) {
  const totalMin = (y / WEEK_HOUR_PX) * 60;
  return Math.max(0, Math.round(totalMin / 15) * 15);
}
function _wkMinToHHMM(mins) {
  const t = WEEK_HOUR_START * 60 + mins;
  const h = Math.floor(t / 60), m = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function _wkFormatHourLabel(h) {
  const use12 = (new Date()).toLocaleString().toLowerCase().match(/am|pm/);
  if (!use12) return `${String(h).padStart(2, '0')}:00`;
  const ampm = h < 12 ? 'AM' : 'PM';
  const hh = ((h + 11) % 12) + 1;
  return `${hh} ${ampm}`;
}
function _wkEventTopHeight(ev, dayStr) {
  // 将事件开始/结束（本地时间）转换为相对于该日网格原点的
  // 顶部/高度的像素值。限制在可见窗口内。
  // dtstart/dtend 字符串格式如 "2026-05-11T09:00:00"（无时区），因此
  // 直接提取时间部分以避免时区数学漂移；如果字符串格式
  // 不符合预期则回退到日期数学运算。
  const _toMin = (iso, fallbackDate) => {
    if (!iso) return null;
    const mins = _timeToMin(iso);
    if (mins !== null && iso.includes('T')) {
      // 如果事件跨越到前一天/后一天，限制在今天的时间范围内。
      const evDate = _localDateOf(iso);
      if (evDate < fallbackDate) return 0;             // 事件在今天之前开始
      if (evDate > fallbackDate) return 24 * 60;       // 事件在今天之后结束
      return mins;
    }
    // 全天或仅日期 — 视作当天开始。
    return 0;
  };
  const startMin = _toMin(ev.dtstart, dayStr);
  const endMin   = _toMin(ev.dtend, dayStr) ?? (startMin + 60);
  const gridStart = WEEK_HOUR_START * 60;
  const gridEnd   = WEEK_HOUR_END * 60;
  const sMin = Math.max(gridStart, startMin);
  const eMin = Math.min(gridEnd, Math.max(endMin, sMin + 15));
  const top = (sMin - gridStart) * (WEEK_HOUR_PX / 60);
  const height = Math.max(18, (eMin - sMin) * (WEEK_HOUR_PX / 60));
  return { top, height };
}

async function _renderWeek() {
  const body = document.getElementById('cal-body');
  if (!body) return;
  const _tk = _renderToken;
  // 保存当前滚动以便在重新渲染后恢复（缩放、拖放
  // 等都会重建内容）。
  const _prevWrap = body.querySelector('.cal-wk-wrap');
  if (_prevWrap) _wkScrollY = _prevWrap.scrollTop;
  const [rs, re] = _weekRange(_currentDate);
  await _fetchEvents(rs, re);
  if (_isStaleRender(_tk)) return;
  const today = _today();
  const ws = new Date(rs + 'T00:00:00');

  // 一次性构建日期列表（供全天条和网格两者使用）。
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(ws); d.setDate(ws.getDate() + i);
    days.push({ d, ds: _ds(d), idx: i });
  }

  // 左侧的时间轨。顶部的间距区域放置缩放控件
  // （工具栏已经很拥挤 — 这个空闲的 56px 角落是个好位置）。
  let railHtml = `<div class="cal-wk-rail">
    <div class="cal-wk-rail-spacer">
      <button class="cal-wk-zoom" id="cal-wk-zoom-out" title="Zoom out (–)" aria-label="Zoom out">−</button>
      <button class="cal-wk-zoom" id="cal-wk-zoom-in" title="Zoom in (+)" aria-label="Zoom in">+</button>
    </div>`;
  for (let h = WEEK_HOUR_START; h < WEEK_HOUR_END; h++) {
    railHtml += `<div class="cal-wk-rail-cell" style="height:${WEEK_HOUR_PX}px;"><span>${_wkFormatHourLabel(h)}</span></div>`;
  }
  railHtml += '</div>';

  // 日列
  let colsHtml = '<div class="cal-wk-cols">';
  for (const { d, ds, idx } of days) {
    const isToday = ds === today;
    const allDayEvents = _eventsForDay(ds).filter(e => _eventVisible(e) && e.all_day);
    const timedEvents  = _eventsForDay(ds).filter(e => _eventVisible(e) && !e.all_day);

    const isSun = d.getDay() === 0;
    colsHtml += `<div class="cal-wk-col${isToday ? ' cal-wk-today' : ''}${isSun && !_weekStartSun ? ' cal-wk-sun' : ''}" data-date="${ds}">`;
    colsHtml += `<div class="cal-wk-col-head"><span class="cal-wk-dn">${(_weekStartSun ? WEEKDAYS_SUN : WEEKDAYS)[idx]}</span><span class="cal-wk-dt">${d.getDate()}</span></div>`;
    // 全天条
    colsHtml += `<div class="cal-wk-allday">`;
    for (const ev of allDayEvents) {
      colsHtml += `<div class="cal-wk-allday-event" data-uid="${_e(ev.uid)}" style="background:${_calColor(ev)};--cal-event-fg:${_calEventFg(ev)};" title="${_e(ev.summary)}">${_e(ev.summary)}</div>`;
    }
    colsHtml += `</div>`;
    // 小时网格主体
    colsHtml += `<div class="cal-wk-grid" data-date="${ds}" style="height:${_wkHours() * WEEK_HOUR_PX}px;">`;
    // 小时单元格线
    for (let h = WEEK_HOUR_START; h < WEEK_HOUR_END; h++) {
      colsHtml += `<div class="cal-wk-cell" data-hour="${h}" style="height:${WEEK_HOUR_PX}px;"></div>`;
    }
    // 当前时间线指示器（仅在今天显示）
    if (isToday) {
      const now = new Date();
      const minSinceStart = (now.getHours() - WEEK_HOUR_START) * 60 + now.getMinutes();
      if (minSinceStart >= 0 && minSinceStart <= _wkHours() * 60) {
        const top = minSinceStart * (WEEK_HOUR_PX / 60);
        colsHtml += `<div class="cal-wk-now" style="top:${top}px;"></div>`;
      }
    }
    // 分时段事件块。每个块带有一个 6px 底部边缘手柄
    // 用于拖放调整大小（延长持续时间而无需打开表单）。
    for (const ev of timedEvents) {
      const { top, height } = _wkEventTopHeight(ev, ds);
      const t = _fmtTime(ev.dtstart) + '–' + _fmtTime(ev.dtend);
      // 自定义背景事件使用图片作为瓷片背景；纯色
      // 事件保持原来的着色效果。
      let bgDecl;
      if (_isCalBgImage(ev.color)) {
        const _url = _calBgImageUrl(ev.color).replace(/'/g, "\\'").replace(/"/g, "%22");
        bgDecl = `background-image: linear-gradient(color-mix(in srgb, var(--bg) 55%, transparent), color-mix(in srgb, var(--bg) 55%, transparent)), url('${_url}'); background-size: cover; background-position: center;`;
      } else {
        bgDecl = `background:color-mix(in srgb, ${_calColor(ev)} 18%, var(--bg));`;
      }
      colsHtml += `<div class="cal-wk-block" data-uid="${_e(ev.uid)}" style="top:${top}px;height:${height}px;border-left-color:${_calColor(ev)};${bgDecl}">`;
      colsHtml += `<div class="cal-wk-block-name">${_e(ev.summary)}</div>`;
      colsHtml += `<div class="cal-wk-block-time">${t}</div>`;
      colsHtml += `<div class="cal-wk-block-resize" title="Drag to resize"></div>`;
      colsHtml += `</div>`;
    }
    colsHtml += `</div></div>`;  // 闭合 /cal-wk-grid /cal-wk-col
  }
  colsHtml += '</div>';

  let h = _headerHTML() + _filtersRowHTML();
  h += `<div class="cal-wk-wrap">${railHtml}${colsHtml}</div>`;
  if (_selectedDay) h += _dayDetailHTML(_selectedDay);
  // 如果用户在请求进行中时抓住了快速添加字段，跳过替换（这
  // 会销毁焦点输入框 + 收起键盘）并推迟到失焦时处理。
  if (_qaTyping()) { _renderPending = true; return; }
  body.innerHTML = h;
  _wireAll(body);

  // 单击（轻点）事件块 → 打开编辑表单。拖放移动或
  // 拖放调整大小在其 mouseup 中设置 `justResized`，这样后续
  // 的点击不会也打开表单；底部边缘调整大小手柄也被忽略。
  body.querySelectorAll('.cal-wk-block, .cal-wk-allday-event').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('cal-wk-block-resize')) return;
      if (el.dataset.justResized) { delete el.dataset.justResized; return; }
      e.stopPropagation();
      const ev = _events.find(x => x.uid === el.dataset.uid);
      if (ev) _showEventForm(ev);
    });
  });

  // 拖动块主体来重新安排（不同日期或时间）。
  // 底部边缘手柄有自己的手势（调整大小）并在此停止，
  // 因此两者不会冲突。保持相同的持续时间。
  body.querySelectorAll('.cal-wk-block').forEach(block => {
    block.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.classList.contains('cal-wk-block-resize')) return; // 调整大小优先
      e.preventDefault();
      const uid = block.dataset.uid;
      const ev = _events.find(x => x.uid === uid);
      if (!ev) return;
      const cols = Array.from(body.querySelectorAll('.cal-wk-grid'));
      if (!cols.length) return;
      // Local/display timing
      const startMin0 = _timeToMin(ev.dtstart) ?? 0;
      const endMin0   = _timeToMin(ev.dtend) ?? startMin0 + 60;

      let durationMin = endMin0 - startMin0;
      const startDs = _localDateOf(ev.dtstart);
      const endDs = ev.dtend ? _localDateOf(ev.dtend) : startDs;
      if (endDs > startDs && endMin0 <= startMin0) {
        durationMin += 24 * 60;
      }
      durationMin = Math.max(15, durationMin);

      // 光标抓取块的哪个位置？（距块顶部的像素偏移）
      const blockRect = block.getBoundingClientRect();
      const grabOffsetPx = e.clientY - blockRect.top;

      // 跟随光标跨列的幽灵块。
      const ghost = block.cloneNode(true);
      ghost.classList.add('cal-wk-block-ghost');
      ghost.style.pointerEvents = 'none';
      ghost.style.opacity = '0.85';
      ghost.querySelector('.cal-wk-block-resize')?.remove();
      // 拖动时将原始块静音（淡化）。
      block.style.opacity = '0.25';

      let nextDs = null;
      let nextStartMin = startMin0;
      let activeGrid = null;
      let moved = false;
      const _attachGhost = (grid) => {
        if (activeGrid === grid) return;
        activeGrid = grid;
        grid.appendChild(ghost);
      };
      const onMove = (mv) => {
        moved = true;
        // 选择光标下的列。如果光标落在列间
        // （间隙/边框）或刚好在网格水平外侧，
        // 吸附到最近的列而不是放弃 — 这正是
        // 之前水平跨日拖放可能感觉卡住的原因。
        let cur = cols.find(c => {
          const r = c.getBoundingClientRect();
          return mv.clientX >= r.left && mv.clientX <= r.right;
        });
        if (!cur) {
          let best = null, bestDist = Infinity;
          for (const c of cols) {
            const r = c.getBoundingClientRect();
            const cx = (r.left + r.right) / 2;
            const d = Math.abs(mv.clientX - cx);
            if (d < bestDist) { bestDist = d; best = c; }
          }
          cur = best;
        }
        if (!cur) return;
        _attachGhost(cur);
        const r = cur.getBoundingClientRect();
        const yIn = Math.max(0, Math.min(cur.clientHeight, mv.clientY - r.top));
        // 减去抓取偏移，使光标在拖动时
        // 保持在块内的相同位置。
        const blockTopY = yIn - grabOffsetPx;
        const snapMin = Math.max(0, Math.round(_wkPxToMin(blockTopY) / 15) * 15);
        nextStartMin = WEEK_HOUR_START * 60 + snapMin;
        nextDs = cur.dataset.date;
        const top = (nextStartMin - WEEK_HOUR_START * 60) * (WEEK_HOUR_PX / 60);
        const height = durationMin * (WEEK_HOUR_PX / 60);
        ghost.style.top = top + 'px';
        ghost.style.height = height + 'px';
        const hh = String(Math.floor(nextStartMin / 60)).padStart(2, '0');
        const mm = String(nextStartMin % 60).padStart(2, '0');
        const hh2 = String(Math.floor((nextStartMin + durationMin) / 60)).padStart(2, '0');
        const mm2 = String((nextStartMin + durationMin) % 60).padStart(2, '0');
        const timeEl = ghost.querySelector('.cal-wk-block-time');
        if (timeEl) timeEl.textContent = `${hh}:${mm}–${hh2}:${mm2}`;
      };
      const onUp = async (up) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        ghost.remove();
        block.style.opacity = '';
        // 仅在用户确实拖动时才抑制后续的点击打开 —
        // 普通点击（无移动）仍然必须打开事件。
        if (moved) block.dataset.justResized = '1';
        // 判断是否真的有任何移动。
        const oldDs = _localDateOf(ev.dtstart);
        if (!nextDs) return;
        if (nextDs === oldDs && nextStartMin === startMin0) return;
        // 快照原始时间以便提供撤销功能。
        const prevDtstart = ev.dtstart;
        const prevDtend = ev.dtend;
        const newEndMin = nextStartMin + durationMin;
        const hh = String(Math.floor(nextStartMin / 60)).padStart(2, '0');
        const mm = String(nextStartMin % 60).padStart(2, '0');
        const newDtstartDate = new Date(`${nextDs}T${hh}:${mm}:00`);
        const _tz = _tzOffsetForDate(newDtstartDate);
        const newDtstart = `${nextDs}T${hh}:${mm}:00${_tz}`;
        const newDtend = _addMinutesToLocalIso(newDtstart, durationMin);
        try {
          await _updateEvent(uid, { dtstart: newDtstart, dtend: newDtend });
          _render();
          _showCalUndoToast('Moved event', async () => {
            try {
              await _updateEvent(uid, { dtstart: prevDtstart, dtend: prevDtend });
              _render();
            } catch (err) { console.error('Undo failed:', err); }
          });
        } catch {
          _render();
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // 拖动分时段块的底部边缘来延长/缩短事件。
  // 吸附到 15 分钟增量；释放时通过 PUT 到 /api/calendar/events 提交。
  body.querySelectorAll('.cal-wk-block .cal-wk-block-resize').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const block = handle.closest('.cal-wk-block');
      const grid = block.parentElement;
      const ds = grid.dataset.date;
      const uid = block.dataset.uid;
      const ev = _events.find(x => x.uid === uid);
      if (!ev || !grid || !ds) return;
      const startMin = _timeToMin(ev.dtstart) ?? 0;
      const initialTop = parseFloat(block.style.top || '0');
      const gridRect = grid.getBoundingClientRect();
      let newEndMin = startMin;
      let resized = false;
      const onMove = (mv) => {
        resized = true;
        const y = Math.max(0, Math.min(grid.clientHeight, mv.clientY - gridRect.top));
        // 吸附到 15 分钟增量；强制最小持续时间为 15 分钟。
        newEndMin = Math.max(startMin + 15, Math.round(_wkPxToMin(y) / 15) * 15);
        const newHeight = Math.max(18, (newEndMin - startMin) * (WEEK_HOUR_PX / 60));
        block.style.height = newHeight + 'px';
        const timeEl = block.querySelector('.cal-wk-block-time');
        if (timeEl) {
          const hh = String(Math.floor(newEndMin / 60)).padStart(2, '0');
          const mm = String(newEndMin % 60).padStart(2, '0');
          timeEl.textContent = `${_fmtTime(ev.dtstart)}–${hh}:${mm}`;
        }
      };
      const onUp = async () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (resized) block.dataset.justResized = '1';
        if (newEndMin === startMin) return;
        const prevDtend = ev.dtend;
        const durationMin = newEndMin - startMin;
        const newDtend = _addMinutesToLocalIso(ev.dtstart, durationMin);
        try {
          await _updateEvent(uid, { dtend: newDtend });
          _render();
          _showCalUndoToast('Resized event', async () => {
            try {
              await _updateEvent(uid, { dtend: prevDtend });
              _render();
            } catch (err) { console.error('Undo failed:', err); }
          });
        } catch (err) {
          // 失败时回滚视觉效果
          _render();
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // 在空格上拖放创建：在单元格上按下鼠标，向下拖动，释放。
  body.querySelectorAll('.cal-wk-grid').forEach(grid => {
    grid.addEventListener('mousedown', (e) => {
      // 当按下位置落在已有事件上时不要开始拖放创建。
      if (e.target.closest('.cal-wk-block')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      const rect = grid.getBoundingClientRect();
      const ds = grid.dataset.date;
      const startY = e.clientY - rect.top;
      const ghost = document.createElement('div');
      ghost.className = 'cal-wk-ghost';
      grid.appendChild(ghost);
      const onMove = (mv) => {
        const y2 = Math.max(0, Math.min(grid.clientHeight, mv.clientY - rect.top));
        const y1 = Math.min(startY, y2);
        const yEnd = Math.max(startY, y2);
        const startMin = _wkPxToMin(y1);
        const endMin = Math.max(_wkPxToMin(yEnd), startMin + 15);
        ghost.style.top = (startMin / 60) * WEEK_HOUR_PX + 'px';
        ghost.style.height = ((endMin - startMin) / 60) * WEEK_HOUR_PX + 'px';
        ghost.dataset.start = _wkMinToHHMM(startMin);
        ghost.dataset.end = _wkMinToHHMM(endMin);
        ghost.textContent = `${ghost.dataset.start} – ${ghost.dataset.end}`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const startHHMM = ghost.dataset.start;
        const endHHMM = ghost.dataset.end;
        ghost.remove();
        if (!startHHMM || !endHHMM) return;
        // 打开预填此时段的自定义事件表单。
        _showEventFormForRange(ds, startHHMM, endHHMM);
      };
      onMove(e);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // 恢复滚动。首次打开周视图时默认定位在 WK_DEFAULT_SCROLL_HOUR，
  // 之后保持用户上次的位置。
  const _wrap = body.querySelector('.cal-wk-wrap');
  if (_wrap) {
    if (_wkScrollY != null) {
      _wrap.scrollTop = _wkScrollY;
    } else if (!_wkScrolledOnce) {
      _wrap.scrollTop = WK_DEFAULT_SCROLL_HOUR * WEEK_HOUR_PX;
      _wkScrolledOnce = true;
    }
  }

  // 时间轨间距角落的缩放按钮。
  document.getElementById('cal-wk-zoom-in')?.addEventListener('click', (e) => { e.stopPropagation(); _wkZoomBy(+12); });
  document.getElementById('cal-wk-zoom-out')?.addEventListener('click', (e) => { e.stopPropagation(); _wkZoomBy(-12); });

  // 键盘缩放（`+` / `-`），Ctrl/Cmd + 滚轮缩放 — 仅当
  // 处于周视图且没有文本输入框获得焦点时触发。
  if (!body._wkZoomKeysWired) {
    body._wkZoomKeysWired = true;
    document.addEventListener('keydown', (e) => {
      if (_view !== 'week') return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === '+' || e.key === '=' ) { e.preventDefault(); _wkZoomBy(+12); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); _wkZoomBy(-12); }
      else if (e.key === '0') { e.preventDefault(); _wkSetZoom(WK_PX_DEFAULT); }
    });
  }
  body.querySelector('.cal-wk-wrap')?.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    _wkZoomBy(e.deltaY < 0 ? +8 : -8);
  }, { passive: false });

  _updateBadge();
}

function _showEventFormForRange(ds, startHHMM, endHHMM) {
  // 打开新建事件表单，然后用拖出的时段预填时间输入框，
  // 并强制打开详情面板以便用户查看/调整。
  _showEventForm(null, ds, ds);
  requestAnimationFrame(() => {
    const startEl = document.getElementById('cal-f-start');
    const endEl   = document.getElementById('cal-f-end');
    if (startEl) startEl.value = startHHMM;
    if (endEl)   endEl.value   = endHHMM;
    startEl?.dispatchEvent(new Event('input'));
    // 自动展开详情，以便通过拖放创建（而非 +New 按钮）
    // 到达此处时时间字段可见。
    document.querySelector('.cal-form-bespoke')?.classList.add('is-expanded');
    const details = document.getElementById('cal-form-details');
    if (details) details.setAttribute('aria-hidden', 'false');
  });
}

// ── 日程视图 ──

async function _renderAgenda() {
  const body = document.getElementById('cal-body');
  if (!body) return;
  const _tk = _renderToken;
  // 从当前日期向前获取 3 个月
  const s = _ds(_currentDate);
  const eDate = new Date(_currentDate); eDate.setMonth(eDate.getMonth() + 3);
  const e = _ds(eDate);
  await _fetchEvents(s, e);
  if (_isStaleRender(_tk)) return;

  // 按日期筛选 + 分组
  const visible = _events.filter(ev => !!_eventVisible(ev))
    .sort((a, b) => a.dtstart < b.dtstart ? -1 : 1);

  let h = _headerHTML() + _filtersRowHTML() + '<div class="cal-agenda">';
  // 按本地日期分组事件，然后始终显示今天（当它在日程
  // 窗口范围内时），即使没有事件，这样用户可以看清"今天"。
  const byDate = new Map();
  for (const ev of visible) {
    const d = _localDateOf(ev.dtstart);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(ev);
  }
  const today = _today();
  if (today >= s && today <= e && !byDate.has(today)) byDate.set(today, []);
  const dates = [...byDate.keys()].sort();

  if (!dates.length) {
    // 空状态镜像邮件面板：简短消息 + 设置 ›
    // 集成链接来设置 CalDAV，或者快速"创建事件"操作。
    h += '<div class="cal-empty" style="display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;">' +
      '<span>${t('calendar.no_upcoming_events')}</span>' +
      '<span style="opacity:0.7;font-size:11px;">' +
        '<a href="#" data-cal-open-settings="integrations" style="color:var(--accent,var(--red));text-decoration:underline;">Settings &rsaquo; Integrations</a>' +
        ' &middot; ' +
        '<a href="#" data-cal-create-event="1" style="color:var(--accent,var(--red));text-decoration:underline;">${t('calendar.create_event')}</a>' +
      '</span>' +
    '</div>';
  } else {
    for (const date of dates) {
      const evs = byDate.get(date);
      const todayBadge = (date === today) ? ' <span class="cal-agenda-today-badge">Today</span>' : '';
      h += `<div class="cal-agenda-day${date === today ? ' is-today' : ''}"><div class="cal-agenda-date">${_fmtDate(date)}${todayBadge}</div>`;
      if (!evs.length) {
        h += '<div class="cal-agenda-empty">${t('calendar.no_events')}</div>';
      }
      for (const ev of evs) {
        const t = ev.all_day ? 'All day' : _fmtTime(ev.dtstart) + ' – ' + _fmtTime(ev.dtend);
        const _typeTag = ev.event_type
          ? `<span class="cal-event-tag" style="color:${_TYPE_PALETTE[ev.event_type] || _TYPE_PALETTE.other};border-color:${_TYPE_PALETTE[ev.event_type] || _TYPE_PALETTE.other}">#${_e(ev.event_type)}</span>`
          : '';
        const _impMark = ev.importance === 'critical' ? '<span style="color:var(--red);margin-right:4px" title="critical">!!</span>'
                       : ev.importance === 'high' ? '<span style="color:var(--orange,#e5a33a);margin-right:4px" title="high">!</span>' : '';
        h += `<div class="cal-agenda-event" data-uid="${_e(ev.uid)}">
          <div class="cal-event-dot" style="background:${_calColor(ev)}"></div>
          <div class="cal-event-info">
            <div class="cal-event-name">${_impMark}${_e(ev.summary)} ${_typeTag}</div>
            <div class="cal-event-time">${t}${ev.location ? ' · ' + _locHTML(ev.location) : ''}</div>
          </div>
          <button class="cal-event-more" data-uid="${_e(ev.uid)}" title="More">${_moreIcon}</button>
        </div>`;
      }
      h += '</div>';
    }
  }
  h += '</div>';
  // 如果用户在请求进行中时抓住了快速添加字段，跳过替换（这
  // 会销毁焦点输入框 + 收起键盘）并推迟到失焦时处理。
  if (_qaTyping()) { _renderPending = true; return; }
  body.innerHTML = h;
  _wireAll(body);
  _wireQuickDelete(body);
  body.querySelectorAll('.cal-agenda-event').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('.cal-event-more')) return;
    const ev = _events.find(e => e.uid === el.dataset.uid);
    if (ev) _showEventForm(ev);
  }));
  // 空状态链接：设置 › 集成 + 创建事件。
  body.querySelector('[data-cal-open-settings]')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeCalendar();
    const modal = document.getElementById('settings-modal');
    if (modal) {
      modal.classList.remove('hidden');
      const tab = modal.querySelector('[data-settings-tab="integrations"]');
      if (tab) tab.click();
    }
  });
  body.querySelector('[data-cal-create-event]')?.addEventListener('click', (e) => {
    e.preventDefault();
    _showEventForm(null);
  });
  _updateBadge();
}

// ── 搜索视图 ──

async function _renderSearch() {
  const body = document.getElementById('cal-body');
  if (!body) return;
  // 在池中所有事件中搜索（无需获取 — 使用已有数据）
  const q = _searchQuery.toLowerCase();
  const results = Object.values(_allEvents)
    .filter(ev => !!_eventVisible(ev))
    .filter(ev =>
      (ev.summary || '').toLowerCase().includes(q) ||
      (ev.description || '').toLowerCase().includes(q) ||
      (ev.location || '').toLowerCase().includes(q)
    )
    .sort((a, b) => a.dtstart < b.dtstart ? -1 : 1);

  let h = _headerHTML() + _filtersRowHTML() + '<div class="cal-search-results">';
  h += `<div class="cal-search-count">${results.length} result${results.length !== 1 ? 's' : ''} for "${_e(_searchQuery)}"</div>`;
  if (!results.length) {
    h += '<div class="cal-empty">${t('calendar.no_events_match')}</div>';
  } else {
    for (const ev of results) {
      const evDate = _localDateOf(ev.dtstart);
      const t = ev.all_day ? 'All day' : _fmtTime(ev.dtstart) + ' – ' + _fmtTime(ev.dtend);
      h += `<div class="cal-agenda-event" data-uid="${_e(ev.uid)}">
        <div class="cal-event-dot" style="background:${_calColor(ev)}"></div>
        <div class="cal-event-info">
          <div class="cal-event-name">${_e(ev.summary)}</div>
          <div class="cal-event-time">${_fmtDate(evDate)} · ${t}${ev.location ? ' · ' + _locHTML(ev.location) : ''}</div>
        </div>
        <button class="cal-event-more" data-uid="${_e(ev.uid)}" title="More">${_moreIcon}</button>
      </div>`;
    }
  }
  h += '</div>';
  // 如果用户在请求进行中时抓住了快速添加字段，跳过替换（这
  // 会销毁焦点输入框 + 收起键盘）并推迟到失焦时处理。
  if (_qaTyping()) { _renderPending = true; return; }
  body.innerHTML = h;
  _wireAll(body);
  _wireQuickDelete(body);
  body.querySelectorAll('.cal-agenda-event').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('.cal-event-more')) return;
    const ev = _allEvents[el.dataset.uid];
    if (ev) _showEventForm(ev);
  }));
  // 重新渲染后聚焦搜索输入框
  const searchInput = document.getElementById('cal-search');
  if (searchInput && document.activeElement !== searchInput) {
    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
  }
}

// ── 年视图 ──

async function _renderYear() {
  const body = document.getElementById('cal-body');
  if (!body) return;
  const _tk = _renderToken;
  const y = _currentDate.getFullYear();
  await _fetchEvents(`${y}-01-01`, `${y + 1}-01-01`);
  if (_isStaleRender(_tk)) return;
  const today = _today();

  let h = _headerHTML() + _filtersRowHTML() + '<div class="cal-year">';
  for (let m = 0; m < 12; m++) {
    h += `<div class="cal-year-month" data-month="${m}"><div class="cal-year-month-title">${MON_SHORT[m]}</div>`;
    h += '<div class="cal-year-grid">';
    for (const wd of (_weekStartSun ? ['S','M','T','W','T','F','S'] : ['M','T','W','T','F','S','S'])) h += `<div class="cal-year-wd">${wd}</div>`;
    const first = new Date(y, m, 1);
    const dow = _weekStartSun ? first.getDay() : (first.getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    for (let p = 0; p < dow; p++) h += '<div class="cal-year-cell"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const evs = _eventsForDay(ds);
      const isToday = ds === today;
      let cls = 'cal-year-cell cal-year-day';
      if (isToday) cls += ' cal-year-today';
      if (evs.length) cls += ' cal-year-has';
      h += `<div class="${cls}" data-date="${ds}" title="${evs.length ? evs.length + ' event' + (evs.length > 1 ? 's' : '') : ''}">${d}</div>`;
    }
    h += '</div></div>';
  }
  h += '</div>';
  // 如果用户在请求进行中时抓住了快速添加字段，跳过替换（这
  // 会销毁焦点输入框 + 收起键盘）并推迟到失焦时处理。
  if (_qaTyping()) { _renderPending = true; return; }
  body.innerHTML = h;
  _wireAll(body);
  // 月份框点击 → 跳转到月视图（但点击具体日期时不跳转）
  body.querySelectorAll('.cal-year-month').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.cal-year-day')) return;
      const m = parseInt(el.dataset.month);
      _currentDate = new Date(_currentDate.getFullYear(), m, 1);
      _view = 'month';
      _render();
    });
  });
  // 年视图中日期点击 → 跳转到月视图
  body.querySelectorAll('.cal-year-day').forEach(el => {
    el.addEventListener('click', () => {
      const d = el.dataset.date;
      _currentDate = new Date(d + 'T00:00:00');
      _selectedDay = d;
      _view = 'month';
      _render();
    });
  });
  _updateBadge();
}

// ── 共享 HTML 构建器 ──

function _dayDetailHTML(dateStr) {
  const isToday = dateStr === _today();
  // 搜索现在在日面板内 — 输入过滤面板
  // 内容为全局搜索结果，而不仅仅当天的活动。
  // 通过包裹元素 + padding-left 在搜索框内显示放大镜图标。
  const searchInput = `<div class="cal-search-wrap">
    <svg class="cal-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
    <input type="search" class="cal-search-input cal-day-search" id="cal-search" placeholder=t('calendar.search_events') value="${_e(_searchQuery)}" />
  </div>`;
  let h = `<div class="cal-splitter" role="separator" aria-orientation="horizontal" tabindex="0" title="Drag to resize"><div class="cal-splitter-grip"></div></div>
    <div class="cal-day-detail">
    ${searchInput}
    <div class="cal-detail-header">
      <span>${_fmtDate(dateStr)}${isToday ? ' <span style="color:var(--accent, var(--red));font-weight:600;">(Today)</span>' : ''}</span>
      <button class="cal-add-btn cal-add-btn-text cal-add-btn-sm" id="cal-add-day" title="New event"><span class="cal-add-plus">+</span><span class="cal-add-label">${t('calendar.new_event')}</span></button>
    </div>`;
  if (_searchQuery) {
    const q = _searchQuery.toLowerCase();
    const results = _events
      .filter(_eventVisible)
      .filter(e =>
        (e.summary || '').toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q) ||
        (e.location || '').toLowerCase().includes(q)
      )
      .sort((a, b) => (a.dtstart || '').localeCompare(b.dtstart || ''));
    h += `<div class="cal-day-search-meta">${results.length} result${results.length !== 1 ? 's' : ''}</div>`;
    if (!results.length) {
      h += '<div class="cal-empty">${t('calendar.no_events_match_short')}</div>';
    } else {
      results.forEach(ev => {
        const date = ev.all_day ? ev.dtstart : _localDateOf(ev.dtstart);
        const t = ev.all_day ? 'All day' : _fmtTime(ev.dtstart) + ' – ' + _fmtTime(ev.dtend);
        const bgStyle = _calItemBgStyle(ev);
        h += `<div class="cal-event-item${bgStyle ? ' cal-event-item-bg' : ''}" data-uid="${_e(ev.uid)}"${bgStyle ? ` style="${bgStyle}"` : ''}>
          <div class="cal-event-dot" style="background:${_calColor(ev)}"></div>
          <div class="cal-event-info">
            <div class="cal-event-name">${_e(ev.summary)}</div>
            <div class="cal-event-time">${_fmtDate(date)} · ${t}</div>
            ${ev.location ? `<div class="cal-event-loc">${_locHTML(ev.location)}</div>` : ''}
          </div>
          <button class="cal-event-more" data-uid="${_e(ev.uid)}" title="More">${_moreIcon}</button>
        </div>`;
      });
    }
    return h + '</div>';
  }
  const evs = _eventsForDay(dateStr);
  if (!evs.length) h += '<div class="cal-empty">${t('calendar.no_events')}</div>';
  else evs.forEach(ev => {
    const t = ev.all_day ? 'All day' : _fmtTime(ev.dtstart) + ' – ' + _fmtTime(ev.dtend);
    const _bgStyle = _calItemBgStyle(ev);
    h += `<div class="cal-event-item${_bgStyle ? ' cal-event-item-bg' : ''}" data-uid="${_e(ev.uid)}"${_bgStyle ? ` style="${_bgStyle}"` : ''}><div class="cal-event-dot" style="background:${_calColor(ev)}"></div><div class="cal-event-info"><div class="cal-event-name">${_e(ev.summary)}</div><div class="cal-event-time">${t}</div>${ev.location ? `<div class="cal-event-loc">${_locHTML(ev.location)}</div>` : ''}</div><button class="cal-event-more" data-uid="${_e(ev.uid)}" title="More">${_moreIcon}</button></div>`;
  });
  return h + '</div>';
}

// ── 绑定所有通用监听器 ──

function _wireAll(body) {
  // ── 日详情分割器（拖放调整大小） ────────────────────────
  // 每次渲染恢复保存的高度，以便用户的设置在
  // 月/周导航间保留。拖动调整 #cal-body 上的
  // 单个 CSS 变量 — 网格限制其高度，日详情面板
  // 通过 CSS 规则相应地扩展/收缩。
  try {
    const calBody = document.getElementById('cal-body');
    const splitter = body.querySelector('.cal-splitter');
    if (calBody && splitter) {
  // 仅在首次绑定从 localStorage 获取初始值。后续
  // 渲染（搜索中用户每次按键时的重渲染）
  // 否则会覆盖正在进行的焦点展开，导致
  // 日详情面板在每次按键时上下跳动。
      const alreadySet = calBody.style.getPropertyValue('--cal-detail-h');
      if (!alreadySet) {
        const saved = parseInt(localStorage.getItem('odysseus.cal.detailH') || '0', 10);
        if (saved && saved > 80) calBody.style.setProperty('--cal-detail-h', saved + 'px');
      }
      let startY = 0, startH = 240, dragging = false;
      const onMove = (ev) => {
        if (!dragging) return;
        const y = ev.touches ? ev.touches[0].clientY : ev.clientY;
  // 向上拖（较小的 y）→ 更大的日详情面板。允许面板扩展到
  // 可见视口的顶部，以便用户可以
  // 完全隐藏日历。我们留出约 24px 空间，以便
  // 分割器手柄本身保持可抓取，可以向下拖回。
        const vh = (window.visualViewport?.height) || window.innerHeight;
        const newH = Math.max(40, Math.min(vh - 24, startH + (startY - y)));
        calBody.style.setProperty('--cal-detail-h', newH + 'px');
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove('cal-splitter-dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        const cur = calBody.style.getPropertyValue('--cal-detail-h');
        const px = parseInt(cur, 10);
        if (px) { try { localStorage.setItem('odysseus.cal.detailH', String(px)); } catch {} }
      };
      const onDown = (ev) => {
        ev.preventDefault();
        dragging = true;
        splitter.classList.add('cal-splitter-dragging');
        startY = ev.touches ? ev.touches[0].clientY : ev.clientY;
        const detail = body.querySelector('.cal-day-detail');
        startH = detail ? detail.getBoundingClientRect().height : 240;
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp, { once: false });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
      };
      splitter.addEventListener('pointerdown', onDown);
      splitter.addEventListener('touchstart', onDown, { passive: false });

  // 双击分割器可将日详情面板重置
  // 为其 CSS 默认高度。
      let _lastTap = 0;
      const resetSplit = () => {
        calBody.style.removeProperty('--cal-detail-h');
        try { localStorage.removeItem('odysseus.cal.detailH'); } catch {}
      };
      splitter.addEventListener('dblclick', resetSplit);
      splitter.addEventListener('touchend', () => {
        const now = Date.now();
        if (now - _lastTap < 320) {
          resetSplit();
          _lastTap = 0;
        } else {
          _lastTap = now;
        }
      });
    }
  } catch {}

  // ── 快速添加输入框 ─────────────────────────────────────────────
  const _qaInput = document.getElementById('cal-quickadd');
  const _qaStatus = document.getElementById('cal-quickadd-status');
  _initQuickAddHintCycle();
  if (_qaInput && !_qaInput._wired) {
    _qaInput._wired = true;
    const _submitQA = async () => {
      const text = _qaInput.value.trim();
      if (!text || _qaSubmitting) return;
  // 使用标志位而非 `disabled` 来阻止重复提交 — 禁用
  // 输入框会使其失焦，这会触发延迟渲染并清空
  // 解析中的加载动画容器。
      _qaSubmitting = true;
  // 文本后的漩涡加载动画 — 但仅在解析运行时间足够长
  // （~250ms）时才显示，快速解析不会闪烁。
      let _qaSpin = null;
      let _qaSpinTimer = null;
      if (_qaStatus) {
        _qaStatus.textContent = '';
        try {
          const sp = (await import('./spinner.js')).default;
          _qaSpinTimer = setTimeout(() => {
            _qaSpin = sp.createWhirlpool(14);
            _qaSpin.element.style.cssText = 'display:inline-block;vertical-align:middle;position:relative;top:1px;left:-2px;margin-left:4px;';
            _qaStatus.appendChild(_qaSpin.element);
          }, 250);
        } catch {
          _qaSpinTimer = setTimeout(() => { if (_qaStatus) _qaStatus.textContent = 'parsing…'; }, 250);
        }
      }
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        const tzOffset = -new Date().getTimezoneOffset();
        const res = await fetch(`${API_BASE}/api/calendar/quick-parse`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, tz, tz_offset: tzOffset }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          if (_qaStatus) _qaStatus.textContent = '';
          uiModule.showError('Quick-add: ' + (data.error || data.detail || `HTTP ${res.status}`));
          return;
        }
        // 打开自定义事件表单，然后将解析的字段填入。
        const ev = data.event;
        const ds = (ev.dtstart || '').slice(0, 10);
        const de = (ev.dtend   || '').slice(0, 10) || ds;
        _showEventForm(null, ds, de);
        requestAnimationFrame(() => {
          const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
          set('cal-f-sum', ev.summary);
          set('cal-f-loc', ev.location);
          set('cal-f-desc', ev.description);
          if (ev.all_day) {
            const ad = document.getElementById('cal-f-allday');
            if (ad && !ad.checked) { ad.checked = true; ad.dispatchEvent(new Event('change')); }
          } else {
            const t1 = _fmtTime(ev.dtstart);
            const t2 = _fmtTime(ev.dtend);
            if (t1) set('cal-f-start', t1);
            if (t2) set('cal-f-end', t2);
            document.getElementById('cal-f-start')?.dispatchEvent(new Event('input'));
          }
          // 确保详情面板已打开，以便用户确认时间。
          document.querySelector('.cal-form-bespoke')?.classList.add('is-expanded');
          const det = document.getElementById('cal-form-details');
          if (det) det.setAttribute('aria-hidden', 'false');
          // 触发 Apple Maps 链接同步，因为位置已填入。
          document.getElementById('cal-f-loc')?.dispatchEvent(new Event('input'));
        });
        // 重置以便下次快速添加。
        _qaInput.value = '';
      } catch (e) {
        uiModule.showError('Quick-add failed: ' + e.message);
      } finally {
        _qaSubmitting = false;
        clearTimeout(_qaSpinTimer);
        if (_qaSpin) { try { _qaSpin.destroy(); } catch {} _qaSpin.element?.remove(); }
        if (_qaStatus) _qaStatus.textContent = '';
      }
    };
    _qaInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _submitQA(); }
      else if (e.key === 'Escape') { _qaInput.value = ''; _qaInput.blur(); }
    });
  // 刷新在字段获得焦点时推迟的任何渲染。
    _qaInput.addEventListener('blur', () => {
      if (_renderPending) { _renderPending = false; _render(); }
    });
  }
  // 后台重新渲染后（例如 /events 请求返回），恢复
  // 焦点 + 光标位置 + 值，让用户可以继续不间断输入。
  if (_qaInput && _qaPendingRestore) {
    _qaInput.value = _qaPendingRestore.value;
    _qaInput.focus();
    try {
      _qaInput.setSelectionRange(_qaPendingRestore.selStart, _qaPendingRestore.selEnd);
    } catch {}
    _qaPendingRestore = null;
  }
  // 在页面任意位置按 Q（当不在其他地方输入时）聚焦快速添加框。
  if (!body._qaShortcutWired) {
    body._qaShortcutWired = true;
    document.addEventListener('keydown', (e) => {
      if (!_open) return;
      if (e.key !== 'q' && e.key !== 'Q') return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const inp = document.getElementById('cal-quickadd');
      if (inp) { e.preventDefault(); inp.focus(); inp.select(); }
    });
  }

  // 在日历主体上捏合缩放改变视图粒度：
  // year ⇆ month ⇆ week。捏合放大切换到更近的视图，捏合缩小
  // 切换到更远的视图。每次手势仅触发一次，避免强力捏合直接从
  // year 跳到 week（用户每次得到一个步骤，
  // 可以释放后再捏合）。
  if (body && !body._pinchZoomWired) {
    body._pinchZoomWired = true;
    let pinchStart = 0, pinchActive = false, pinchFired = false;
    const dist = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    body.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinchStart = dist(e.touches);
        pinchActive = true;
        pinchFired = false;
      }
    }, { passive: true });
    body.addEventListener('touchmove', (e) => {
      if (!pinchActive || pinchFired || e.touches.length !== 2) return;
      const ratio = dist(e.touches) / pinchStart;
      if (ratio > 1.35)      { _zoomView(+1); pinchFired = true; }
      else if (ratio < 0.7)  { _zoomView(-1); pinchFired = true; }
    }, { passive: true });
    body.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) pinchActive = false;
    }, { passive: true });
  }

  // 在日历主体上触控滑动 ← → 切换月/周等。仅在
  // 滑动明显是水平方向时触发，避免劫持
  // 长事件列表内的垂直滚动。每次渲染通过 _wireAll
  // 重新绑定 → 现有的上一页/下一页处理器执行实际导航。
  if (body && !body._swipeWired) {
    body._swipeWired = true;
    let _sx = 0, _sy = 0, _t0 = 0, _tracking = false;
    body.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      _sx = e.touches[0].clientX;
      _sy = e.touches[0].clientY;
      _t0 = Date.now();
      _tracking = true;
    }, { passive: true });
    body.addEventListener('touchend', (e) => {
      if (!_tracking) return;
      _tracking = false;
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - _sx;
      const dy = t.clientY - _sy;
      const dt = Date.now() - _t0;
  // 阈值：至少 50px 水平移动，主轴是水平方向，
  // 并且速度合理（600ms 内）以确保意图明确。
      if (Math.abs(dx) < 50) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.3) return;
      if (dt > 600) return;
      if (dx < 0) document.getElementById('cal-next')?.click();
      else document.getElementById('cal-prev')?.click();
    }, { passive: true });
  }

  document.getElementById('cal-prev')?.addEventListener('click', () => {
    _slideDir = -1;
    if (_view === 'year') _currentDate = new Date(_currentDate.getFullYear() - 1, 0, 1);
    else if (_view === 'week') _currentDate.setDate(_currentDate.getDate() - 7);
    else if (_view === 'agenda') _currentDate.setDate(_currentDate.getDate() - 30);
    else _currentDate = new Date(_currentDate.getFullYear(), _currentDate.getMonth() - 1, 1);
  // 在月/周视图中保持一个日期被选中，这样托管搜索框的
  // 日详情面板保持可用（否则浏览会隐藏搜索）。
    _selectedDay = (_view === 'month' || _view === 'week') ? _ds(_currentDate) : null;
    _render();
  });
  document.getElementById('cal-next')?.addEventListener('click', () => {
    _slideDir = 1;
    if (_view === 'year') _currentDate = new Date(_currentDate.getFullYear() + 1, 0, 1);
    else if (_view === 'week') _currentDate.setDate(_currentDate.getDate() + 7);
    else if (_view === 'agenda') _currentDate.setDate(_currentDate.getDate() + 30);
    else _currentDate = new Date(_currentDate.getFullYear(), _currentDate.getMonth() + 1, 1);
    _selectedDay = (_view === 'month' || _view === 'week') ? _ds(_currentDate) : null;
    _render();
  });
  document.getElementById('cal-today')?.addEventListener('click', () => { _currentDate = new Date(); _selectedDay = _today(); _render(); });
  document.getElementById('cal-settings')?.addEventListener('click', () => _showCalSettings());
  document.getElementById('cal-sync')?.addEventListener('click', async () => {
  // 可见反馈：在按钮上切换 CSS 类，以便旋转动画
  // 运行即使网络往返太快无法感知。我们至少保持
  // 700ms（一个完整旋转周期）并且在实际请求进行期间
  // 保持，然后清除。之前 `await _render()`
  // 立刻 resolve 因为 _render 是同步的，所以加载动画
  // 在同一 tick 内设置→清除，用户看不到任何变化。
    const btn = document.getElementById('cal-sync');
    btn?.classList.add('cal-syncing');
    window._calSyncing = true;
    _allEvents = {};
    _fetchedRanges = [];
    localStorage.removeItem(LS_KEY);

  // 计算可见范围并强制重新获取 — _render() 会触发
  // 内部 fetch 但不返回 promise，因此我们等待自己
  // 的来实际在网络层面序列化。
    const _range = (_view === 'year')
      ? [`${_currentDate.getFullYear()}-01-01`, `${_currentDate.getFullYear() + 1}-01-01`]
      : (_view === 'week') ? _weekRange(_currentDate) : _monthRange(_currentDate);
    const minSpin = new Promise(r => setTimeout(r, 700));
    try {
      await Promise.all([
        _fetchEvents(_range[0], _range[1], /*force*/ true).catch(() => {}),
        minSpin,
      ]);
    } finally {
      window._calSyncing = false;
  // 闪现对勾约 900ms。通过工具栏模板读取的
  // 标志驱动（不是在按钮上一次性设置 innerHTML），这样偶然的
  // _render() — 日历中途重渲染 — 无法清除它。同样
  // 原因，旋转动画也是标志驱动的。
      window._calSyncDone = true;
      _render();
      setTimeout(() => {
        window._calSyncDone = false;
        if (_open) _render();
      }, 900);
      if (uiModule?.showToast) uiModule.showToast('Calendar refreshed');
    }
  });
  // 新建事件表单打开前"+"符号短暂旋转。
  // 该符号在桌面端悬停时已会旋转。移动端没有
  // 悬停效果，因此在点击时播放旋转作为快速可供性提示。
  const _addClick = (e, openFn) => {
    if (window.innerWidth <= 768) {
      const plus = e.currentTarget.querySelector('.cal-add-plus');
      if (plus) {
        plus.classList.add('cal-add-spinning');
        setTimeout(() => plus.classList.remove('cal-add-spinning'), 360);
      }
      setTimeout(openFn, 220);
    } else {
      openFn();
    }
  };
  // 如果用户在快速添加中输入但按了"+ New"而非回车，将其
  // 视为快速添加（解析文本）而非打开空白事件 — 因为
  // 两个控件并排放置，这是常见的混淆操作。
  const _tryQuickAddFromButton = () => {
    const qa = document.getElementById('cal-quickadd');
    if (qa && qa.value.trim()) {
      qa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    }
    return false;
  };
  document.getElementById('cal-add')?.addEventListener('click', (e) => _addClick(e, () => { if (!_tryQuickAddFromButton()) _showEventForm(null, _selectedDay || _today()); }));
  // 日详情标题中的独立"+"：不旋转（小圆形按钮
  // 原地旋转不好看 — 立即打开表单）。
  document.getElementById('cal-add-day')?.addEventListener('click', () => { if (!_tryQuickAddFromButton()) _showEventForm(null, _selectedDay); });

  // 移动端：重新定位工具栏的 +New 胶囊按钮，使其位于
  // 快速添加行旁边（不在内部 — 该行有自己的边框/背景
  // 使嵌入的按钮看起来像输入框的一部分）。
  // 将行和按钮包裹在 flex 容器中，使它们共享一行。
  if (window.innerWidth <= 768) {
    const addBtn = document.getElementById('cal-add');
    const qaRow = document.getElementById('cal-quickadd-row');
    if (addBtn && qaRow) {
      let wrap = qaRow.parentElement;
      if (!wrap?.classList.contains('cal-quickadd-wrap')) {
        wrap = document.createElement('div');
        wrap.className = 'cal-quickadd-wrap';
        qaRow.parentElement?.insertBefore(wrap, qaRow);
        wrap.appendChild(qaRow);
      }
      if (addBtn.parentElement !== wrap) wrap.appendChild(addBtn);
    }
  }

  // 搜索输入 — 每次按键重渲染都会重建日详情 DOM，
  // 因此重新聚焦并恢复光标位置以保持输入流畅。
  const searchInput = document.getElementById('cal-search');
  if (searchInput) {
    if (document.activeElement?.id === 'cal-search') {
  // 重渲染后的首次调用：重新聚焦并将光标放在末尾。
      searchInput.focus();
      const len = searchInput.value.length;
      try { searchInput.setSelectionRange(len, len); } catch {}
    }
    searchInput.addEventListener('input', (e) => {
      _searchQuery = e.target.value.trim();
  // 部分更新：仅替换日详情面板内的搜索结果，
  // 保留搜索输入框元素本身。完整的
  // _render() 通过 innerHTML 销毁输入框，在 iOS 上
  // 即使全新的输入框同步获得焦点键盘也会收起。
  //
  // 跨按键保持同一输入框元素是保持键盘打开的唯一方式。
      _updateDaySearchResults();
    });
    // 移动端：当搜索输入框获得焦点时，屏幕键盘
    // 弹出。将日详情面板扩展到（接近）可见视口
    // 高度，使搜索栏位于屏幕顶部，远在
    // 键盘上方，而不是被挤压在键盘后面。
    searchInput.addEventListener('focus', () => {
      if (window.innerWidth > 768) return;
      const calBody = document.getElementById('cal-body');
      if (!calBody) return;
      const vh = (window.visualViewport?.height) || window.innerHeight;
      const target = vh - 24;
      // 如果已经展开则跳过 — 每次按键都会触发重渲染
      // 重新聚焦输入框。在每次按键时重复运行此操作
      // 会在用户输入时推动布局变化。
      const cur = parseInt(calBody.style.getPropertyValue('--cal-detail-h'), 10) || 0;
      if (cur >= target - 24) return;
      calBody.style.setProperty('--cal-detail-h', target + 'px');
    });
  }

  body.querySelectorAll('.cal-view-btn').forEach(b => b.addEventListener('click', () => {
    _view = b.dataset.view;
    _searchQuery = '';
    _selectedDay = null;
    // 切换到日程视图时始终定位到今天，这样你看到的是"接下来
    // 有什么"而非你碰巧浏览到的地方。
    if (_view === 'agenda') _currentDate = new Date();
    _render();
  }));
  body.querySelector('#cal-filter-toggle')?.addEventListener('click', () => {
    _filtersCollapsed = !_filtersCollapsed;
    localStorage.setItem('cal-filters-collapsed', _filtersCollapsed ? '1' : '0');
    _render();
  });
  body.querySelectorAll('.cal-filter-item').forEach(it => it.addEventListener('click', (e) => {
    const href = it.dataset.href;
    const type = it.dataset.type;
    if (href) {
  // 单独筛选：点击 = 仅显示此日历；再次点击 = 显示全部。
  // Shift/Ctrl+点击 = 单独切换（传统隐藏/显示）。
      const allHrefs = Array.from(body.querySelectorAll('.cal-filter-item[data-href]')).map(el => el.dataset.href);
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        _hiddenCals.has(href) ? _hiddenCals.delete(href) : _hiddenCals.add(href);
      } else {
        const soloed = !_hiddenCals.has(href) && allHrefs.every(h => h === href || _hiddenCals.has(h));
        if (soloed) {
          _hiddenCals.clear();
        } else {
          _hiddenCals.clear();
          allHrefs.forEach(h => { if (h !== href) _hiddenCals.add(h); });
        }
      }
    } else if (type) {
  // "!"标签切换独立的"仅重要事件"轴 — 点击它
  // 不会像普通类型标签那样单独隐藏其他类别。
      if (type === '!') {
        _onlyImportant = !_onlyImportant;
  // 清除类别隐藏，使重要性成为活跃筛选条件。
        if (_onlyImportant) _hiddenTypes.clear();
      } else {
        const allTypes = Array.from(body.querySelectorAll('.cal-filter-item[data-type]'))
          .map(el => el.dataset.type)
          .filter(t => t !== '!');
  // 使用类别筛选器会取消"仅重要事件"模式，以免其
  // 静默地继续叠加筛选。
        _onlyImportant = false;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          _hiddenTypes.has(type) ? _hiddenTypes.delete(type) : _hiddenTypes.add(type);
        } else {
          const soloed = !_hiddenTypes.has(type) && allTypes.every(t => t === type || _hiddenTypes.has(t));
          if (soloed) {
            _hiddenTypes.clear();
          } else {
            _hiddenTypes.clear();
            allTypes.forEach(t => { if (t !== type) _hiddenTypes.add(t); });
          }
        }
      }
    }
    _render();
  }));
  body.querySelectorAll('.cal-day[data-date]').forEach(cell => cell.addEventListener('click', (e) => {
    if (e.target.closest('.cal-event-item,.cal-multiday')) return;
    const d = cell.dataset.date;
  // 首次点击某日：选中。再次点击同一已选中
  // 的日期：打开预填该日期的新建事件表单。
    if (_selectedDay === d) {
      _showEventForm(null, d);
      return;
    }
    _selectedDay = d;
    _render();
  }));
  body.querySelectorAll('.cal-event-item').forEach(it => it.addEventListener('click', (e) => {
    if (e.target.closest('.cal-event-more')) return;
    const ev = _events.find(e => e.uid === it.dataset.uid);
    if (ev) _showEventForm(ev);
  }));
  _wireQuickDelete(body);

  // 拖放
  body.querySelectorAll('[draggable="true"][data-uid]').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      _dragUid = el.dataset.uid;
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('cal-dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('cal-dragging');
      _dragUid = null;
      body.querySelectorAll('.cal-drag-over').forEach(d => d.classList.remove('cal-drag-over'));
    });
  });
  // 辅助函数 — 找到光标在 (x,y) 正下方的日单元格。从
  // 光标读取比信任触发 `drop` 事件的任何单元格更可靠：
  // 如果用户在嵌套的事件项或多日条上释放，
  // drop 事件在内部元素上触发，调用
  // 单元格的 `data-date` 可能是错误的行。
  const _cellAtPoint = (x, y) => {
    const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
    for (const el of stack) {
      if (!el || !el.closest) continue;
  // 优先月视图日单元格，回退到任意 data-date 目标
  //（例如周视图列），使周视图拖放仍然有效。
      const dayCell = el.closest('.cal-day[data-date]');
      if (dayCell) return dayCell;
      const anyCell = el.closest('[data-date]');
      if (anyCell) return anyCell;
    }
    return null;
  };
  body.querySelectorAll('[data-date]').forEach(cell => {
    cell.addEventListener('dragover', (e) => {
      if (!_dragUid) return;
      e.preventDefault();
  // 仅高亮光标真正下方的单元格 — 防止光标
  // 越过边界时两个相邻单元格闪烁。
      const target = _cellAtPoint(e.clientX, e.clientY);
      body.querySelectorAll('.cal-drag-over').forEach(c => {
        if (c !== target) c.classList.remove('cal-drag-over');
      });
      if (target) target.classList.add('cal-drag-over');
    });
    cell.addEventListener('dragleave', (e) => {
  // 仅在光标确实离开此单元格时才清除（dragleave 在进入
  // 子元素时也会触发 — 那是闪烁 bug）。
      const target = _cellAtPoint(e.clientX, e.clientY);
      if (target !== cell) cell.classList.remove('cal-drag-over');
    });
    cell.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      body.querySelectorAll('.cal-drag-over').forEach(c => c.classList.remove('cal-drag-over'));
      if (!_dragUid) return;
  // 释放目标 = 释放时光标实际所在的单元格，
  // 而不是冒泡目标。修复"在错误日期上释放"的反馈。
      const target = _cellAtPoint(e.clientX, e.clientY) || cell;
      const nd = target.dataset.date;
      const ev = _events.find(e => e.uid === _dragUid);
      if (!ev || !nd) return;
      const od = _localDateOf(ev.dtstart);
      if (od === nd) return;
      const diff = Math.round((new Date(nd + 'T00:00:00') - new Date(od + 'T00:00:00')) / 86400000);
  // 在变更之前快照原始时间以便撤销。
      const undoSnap = { uid: ev.uid, dtstart: ev.dtstart, dtend: ev.dtend };
      _pushCalUndo({ label: 'move', run: () => _updateEvent(undoSnap.uid, { dtstart: undoSnap.dtstart, dtend: undoSnap.dtend || undefined }).then(_render) });
      await _updateEvent(ev.uid, { dtstart: _shiftDT(ev.dtstart, diff), dtend: ev.dtend ? _shiftDT(ev.dtend, diff) : undefined });
      _render();
      uiModule.showToast?.('Moved', { duration: 4000, action: 'Undo', actionHint: 'Ctrl+Z', onAction: _popAndRunCalUndo });
    });
  });
}

// ── 撤销栈（日历） ──
const _calUndoStack = [];
function _pushCalUndo(entry) {
  _calUndoStack.push(entry);
  if (_calUndoStack.length > 20) _calUndoStack.shift();
}
function _popAndRunCalUndo() {
  const entry = _calUndoStack.pop();
  if (entry && typeof entry.run === 'function') {
    try { entry.run(); } catch {}
  }
}
// 在日历模态框内任意位置按 Ctrl/Cmd+Z 撤销最后一次拖放移动。
if (typeof window !== 'undefined' && !window._calUndoBound) {
  window._calUndoBound = true;
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== 'z' || e.shiftKey) return;
  // 如果用户正在实际字段中输入则跳过 — 让浏览器的文本撤销运行。
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const modal = document.getElementById('calendar-modal');
    if (!modal || modal.classList.contains('hidden') || !_calUndoStack.length) return;
    e.preventDefault();
    _popAndRunCalUndo();
  });
}

// ── 日历设置 ──

async function _showCalSettings() {
  const existing = document.getElementById('cal-settings-panel');
  if (existing) { existing.remove(); return; }

  const cals = _calendars;
  const COLORS = ['#5b8abf','#4caf50','#ff9800','#e91e63','#9c27b0','#00bcd4','#795548','#607d8b','#f44336','#7c4dff'];

  const overlay = document.createElement('div');
  overlay.id = 'cal-settings-panel';
  overlay.className = 'modal';
  overlay.style.display = 'flex';
  overlay.style.zIndex = '999';
  overlay.innerHTML = `
    <div class="modal-content" style="width:420px;max-width:92vw;">
      <div class="modal-header">
        <h4>${t('calendar.calendar_settings')}</h4>
        <button class="close-btn" id="cal-settings-close">\u2716</button>
      </div>
      <div class="modal-body" style="padding:16px;display:flex;flex-direction:column;gap:16px;">
        <div>
          <div style="font-size:11px;opacity:0.5;margin-bottom:6px;">${t('calendar.your_calendars')}</div>
          <div id="cal-settings-list" style="display:flex;flex-direction:column;gap:4px;">
            ${cals.map(c => `
              <div class="cal-settings-row" data-id="${_e(c.href)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:color-mix(in srgb, var(--fg) 4%, transparent);">
                <input type="color" value="${c.color || '#5b8abf'}" class="cal-s-color" style="width:24px;height:24px;border:none;background:none;cursor:pointer;padding:0;border-radius:50%;overflow:hidden;" />
                <input type="text" value="${_e(c.name)}" class="cal-s-name" style="flex:1;background:none;border:1px solid var(--border);border-radius:4px;padding:3px 6px;color:var(--fg);font-size:12px;" />
                <button class="cal-s-del" title="Delete calendar" style="background:none;border:none;color:var(--accent, var(--red));opacity:0.75;cursor:pointer;padding:2px;display:flex;position:relative;top:4px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>
              </div>
            `).join('')}
          </div>
          <button class="memory-toolbar-btn" id="cal-settings-add" style="margin-top:8px;">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent, var(--red))" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New calendar
          </button>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:12px;">
          <div style="font-size:11px;opacity:0.5;margin-bottom:6px;">${t('calendar.import_calendar')}</div>
          <div style="display:flex;gap:8px;align-items:center;">
            <label class="memory-toolbar-btn" style="cursor:pointer;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="position:relative;top:5px;margin-right:3px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span style="position:relative;top:4px;">Import .ics</span>
              <input type="file" accept=".ics,.ical" id="cal-import-file" style="display:none;" />
            </label>
            <span id="cal-import-status" style="font-size:11px;opacity:0.6;"></span>
          </div>
          <div style="font-size:10px;opacity:0.4;margin-top:4px;">Upload a .ics file to import events. Google Calendar, Apple Calendar, and Outlook all export .ics files.</div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:12px;">
          <div style="font-size:11px;opacity:0.5;margin-bottom:6px;">${t('calendar.export_calendar')}</div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            ${cals.map(c => `
              <button class="memory-toolbar-btn cal-s-export-chip" data-id="${_e(c.href)}" title="Download ${_e(c.name)}.ics" style="cursor:pointer;">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="position:relative;top:2px;margin-right:3px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span style="position:relative;top:1px;">${_e(c.name)}</span>
              </button>
            `).join('')}
          </div>
          <div style="font-size:10px;opacity:0.4;margin-top:4px;">Download a calendar as .ics for backup or to import into another app.</div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:12px;">
          <div style="font-size:11px;opacity:0.5;margin-bottom:6px;">Week starts on</div>
          <div style="display:flex;gap:6px;">
            <button id="cal-wstart-mon" type="button" style="font-size:12px;padding:3px 10px;border-radius:4px;border:1px solid var(--border);background:${!_weekStartSun ? 'color-mix(in srgb, var(--accent,var(--red)) 18%, var(--panel))' : 'var(--panel)'};color:var(--fg);cursor:pointer;transition:background 0.1s,border-color 0.1s;outline:none;">Monday</button>
            <button id="cal-wstart-sun" type="button" style="font-size:12px;padding:3px 10px;border-radius:4px;border:1px solid var(--border);background:${_weekStartSun ? 'color-mix(in srgb, var(--accent,var(--red)) 18%, var(--panel))' : 'var(--panel)'};color:var(--fg);cursor:pointer;transition:background 0.1s,border-color 0.1s;outline:none;">Sunday</button>
          </div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:12px;">
          <div style="font-size:11px;opacity:0.5;margin-bottom:6px;">${t('calendar.sync_calendars')}</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <button class="memory-toolbar-btn" id="cal-settings-sync-now" style="cursor:pointer;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="position:relative;top:2px;margin-right:3px;"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
              <span style="position:relative;top:1px;">${t('calendar.sync_now')}</span>
            </button>
            <span id="cal-settings-sync-status" style="font-size:11px;opacity:0.6;"></span>
          </div>
          <div style="font-size:10px;opacity:0.4;margin-top:4px;">Pulls events from your CalDAV server. To connect or change CalDAV credentials, open <a href="#" id="cal-settings-open-caldav" style="color:var(--accent, var(--red));text-decoration:none;font-weight:600;">Settings → Integrations</a>.</div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const cleanup = () => overlay.remove();
  overlay.querySelector('#cal-settings-close').addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });

  // Week-start toggle: save to localStorage, update module state, re-render.
  const _monBtn = overlay.querySelector('#cal-wstart-mon');
  const _sunBtn = overlay.querySelector('#cal-wstart-sun');
  const _activeStyle  = 'color-mix(in srgb, var(--accent,var(--red)) 18%, var(--panel))';
  const _inactiveStyle = 'var(--panel)';
  const _applyWeekStartActive = () => {
    if (_monBtn) _monBtn.style.background = _weekStartSun ? _inactiveStyle : _activeStyle;
    if (_sunBtn) _sunBtn.style.background = _weekStartSun ? _activeStyle : _inactiveStyle;
  };
  _monBtn?.addEventListener('click', () => {
    _weekStartSun = false;
    localStorage.setItem('cal-week-start', 'mon');
    _applyWeekStartActive();
    if (_open) _render();
  });
  _sunBtn?.addEventListener('click', () => {
    _weekStartSun = true;
    localStorage.setItem('cal-week-start', 'sun');
    _applyWeekStartActive();
    if (_open) _render();
  });

  // 创建新（本地）日历。默认名称 + 下一个调色板颜色，然后
  // 重新打开面板，以便用户内联重命名并选择颜色。
  overlay.querySelector('#cal-settings-add')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const color = COLORS[_calendars.length % COLORS.length];
    try {
      const r = await fetch(`${API_BASE}/api/calendar/calendars?name=${encodeURIComponent('New calendar')}&color=${encodeURIComponent(color)}`, { method: 'POST', credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || 'Failed to create calendar');
      _calendars.push({ name: d.name, href: d.id, color: d.color });
      _allEvents = {}; _fetchedRanges = []; localStorage.removeItem(LS_KEY);
      _render();
      cleanup();
      _showCalSettings();
  // 聚焦新行的名称字段以便重命名。
      setTimeout(() => {
        const rows = document.querySelectorAll('#cal-settings-list .cal-settings-row');
        const last = rows[rows.length - 1];
        const nm = last?.querySelector('.cal-s-name');
        if (nm) { nm.focus(); nm.select(); }
      }, 30);
    } catch (err) {
      btn.disabled = false;
      if (window.showError) window.showError(err.message || 'Failed to create calendar');
      else console.error(err);
    }
  });

  // 颜色 + 名称更改
  overlay.querySelectorAll('.cal-settings-row').forEach(row => {
    const id = row.dataset.id;
    const colorInput = row.querySelector('.cal-s-color');
    const nameInput = row.querySelector('.cal-s-name');
    const delBtn = row.querySelector('.cal-s-del');

    let saveTimer;
    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        await fetch(`${API_BASE}/api/calendar/calendars/${id}?name=${encodeURIComponent(nameInput.value)}&color=${encodeURIComponent(colorInput.value)}`, { method: 'PUT' });
        if (uiModule?.showToast) uiModule.showToast(t('calendar.saved_calendar', { name: nameInput.value || t('calendar.default_calendar_name') }));
  // 更新本地日历列表
        const c = _calendars.find(c => c.href === id);
        if (c) { c.name = nameInput.value; c.color = colorInput.value; }
  // 更新缓存事件的颜色
        for (const uid of Object.keys(_allEvents)) {
          if (_allEvents[uid].calendar_href === id) {
            _allEvents[uid].color = colorInput.value;
            _allEvents[uid].calendar = nameInput.value;
          }
        }
        localStorage.removeItem(LS_KEY);
        _fetchedRanges = [];
        _render();
      }, 300);
    };
    colorInput.addEventListener('input', save);
    nameInput.addEventListener('change', save);
  // 将原生颜色框升级为应用主题颜色选择器。
    try { attachColorPicker(colorInput); } catch (_) {}

    delBtn.addEventListener('click', async () => {
      const name = nameInput.value;
      if (!await window.styledConfirm(t('calendar.delete_calendar_confirm', { name: name }), { confirmText: t('common.delete'), danger: true })) return;
      await fetch(`${API_BASE}/api/calendar/calendars/${id}`, { method: 'DELETE' });
      row.remove();
      _allEvents = {}; _fetchedRanges = []; localStorage.removeItem(LS_KEY);
      _calendars = _calendars.filter(c => c.href !== id);
      _render();
    });
  });

  // ICS 导入
  overlay.querySelector('#cal-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = overlay.querySelector('#cal-import-status');
    status.textContent = 'Importing...';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_BASE}/api/calendar/import`, { method: 'POST', body: fd, credentials: 'same-origin' });
  // 先尝试 JSON；回退到文本，以便 HTML 认证墙和裸
  // 500 状态码能展示用户可操作的信息，而非
  // 通用的"导入失败"。
      let data = null, raw = '';
      try { data = await res.clone().json(); } catch (_) { raw = await res.text().catch(() => ''); }
      if (res.ok && data && data.ok) {
        status.textContent = `${t('calendar.events_imported', { n: data.imported })} "${data.calendar}"` + (data.skipped ? ` (${data.skipped} skipped)` : '');
        _allEvents = {}; _fetchedRanges = []; localStorage.removeItem(LS_KEY);
        await _fetchCalendars();
        _render();
      } else {
  // FastAPI HTTPException → {detail}；某些路由使用 {error}。
        const reason = (data && (data.detail || data.error)) || raw.slice(0, 200) || `HTTP ${res.status}`;
        status.textContent = t('calendar.import_failed', { reason: reason });
        console.error('Calendar import failed', res.status, data || raw);
      }
    } catch (err) {
      status.textContent = t('calendar.import_failed', { reason: err.message || err });
      console.error('Calendar import threw', err);
    }
    e.target.value = '';
  });

  // 导出标签 — 每个日历一个；下载该日历的 .ics 文件。
  overlay.querySelectorAll('.cal-s-export-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      window.open(`${API_BASE}/api/calendar/export/${chip.dataset.id}`, '_blank');
    });
  });

  // 立即同步 — 同步触发 CalDAV 拉取，以便显示
  // 内联结果，然后刷新面板 + 日历网格。
  overlay.querySelector('#cal-settings-sync-now')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const status = overlay.querySelector('#cal-settings-sync-status');
    btn.disabled = true;
    status.textContent = 'Syncing…';
    const data = await _syncCaldav(true) || {};
    if (data.errors && data.errors.length) {
      status.textContent = t('calendar.sync_failed', { error: data.errors[0] });
    } else {
      const parts = [];
      if (data.events) parts.push(`${data.events} events`);
      if (data.deleted) parts.push(`${data.deleted} removed`);
      status.textContent = parts.length ? `Synced — ${parts.join(', ')}` : 'Synced — no changes';
      _allEvents = {}; _fetchedRanges = [];
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
      await _fetchCalendars();
      _render();
  // 重新打开面板，使日历列表反映任何新增的日历。
      const reopenWith = !!document.getElementById('cal-settings-panel');
      cleanup();
      if (reopenWith) _showCalSettings();
    }
    btn.disabled = false;
  });

  // 集成链接 — 关闭此覆盖层并打开设置 → 集成。
  overlay.querySelector('#cal-settings-open-caldav')?.addEventListener('click', (e) => {
    e.preventDefault();
    cleanup();
    if (window.settingsModule && typeof window.settingsModule.open === 'function') {
      try { window.settingsModule.open('integrations'); return; } catch (_) {}
    }
    const modal = document.getElementById('settings-modal');
    if (modal) {
      modal.classList.remove('hidden');
      const tabBtn = modal.querySelector('[data-settings-tab="integrations"]');
      if (tabBtn) tabBtn.click();
    }
  });
}

// ── 事件表单 ──

  // 从自由文本标题中提取明确的时钟时间，以便覆盖
  // 保存时的时间选择器（例如标题"Standup 10am"胜过 9pm 的选择器）。
  // 返回 24 小时制的 {h, m}，标题无明确时间时返回 null。
function _parseTitleTime(text) {
  if (!text) return null;
  // 12 小时制 含 am/pm — "10am"、"10:30 pm"、"at 7 p.m."
  let m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\b/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    if (h < 1 || h > 12 || mm > 59) return null;
    const pm = m[3].toLowerCase() === 'p';
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { h, m: mm };
  }
  // 24 小时制 HH:MM — "15:00"、"at 9:30"（需要冒号以避免匹配
  // 裸数字，如"room 5"或年份）。
  m = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
  return null;
}

function _showEventForm(existing, defaultDate, defaultEndDate) {
  const body = document.getElementById('cal-body');
  if (!body) return;
  const isEdit = !!existing;
  const ds = existing ? _localDateOf(existing.dtstart) : (defaultDate || _today());
  const de = existing && existing.dtend ? _localDateOf(existing.dtend) : (defaultEndDate || ds);
  const isMultiDay = ds !== de;
  const st = existing && !existing.all_day ? _fmtTime(existing.dtstart) : '09:00';
  const et = existing && !existing.all_day && existing.dtend ? _fmtTime(existing.dtend) : '10:00';
  // 跨多日拖放时默认设为全天
  const ad = existing ? existing.all_day : (defaultEndDate && defaultEndDate !== defaultDate);

  let calOpts = _calendars.filter(c => !_hiddenCals.has(c.href)).map(c =>
    `<option value="${_e(c.href)}" ${existing && existing.calendar_href === c.href ? 'selected' : ''}>${_e(c.name)}</option>`
  ).join('');

  // "自定义"事件表单：一个大钟面主区域（时间 + 日期）和一个
  // 标题输入框。其他所有内容（位置、描述、重复、
  // 提醒、颜色、日历）都隐藏在点击后 — 聚焦
  // 标题或点击"添加详情"展开。空白草稿感觉像
  // 便利贴；完整详情编辑只需一次按键。
  const _hasDetails = !!(existing && (
    existing.location || existing.description || existing.rrule ||
    (existing.color && existing.color.length) ||
    isMultiDay
  ));
  const _expandedAtStart = isEdit && _hasDetails;

  body.innerHTML = `<div class="cal-form cal-form-bespoke${_expandedAtStart ? ' is-expanded' : ''}">
    <button type="button" class="cal-form-mobile-cancel" id="cal-form-mobile-cancel" title="Cancel" aria-label="Cancel event">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div class="cal-form-today" id="cal-form-today">Today is <span id="cal-form-today-text">${_clockDate(_today())} · ${_nowClock()}</span></div>
    <div class="cal-hero">
      <button type="button" class="cal-hero-time" id="cal-hero-time" title="Change time">
        <span class="cal-hero-clock" id="cal-hero-clock">${_clockFace(ad ? '' : st)}</span>
        <span class="cal-hero-ampm" id="cal-hero-ampm">${_clockAmpm(ad ? '' : st)}</span>
      </button>
      <button type="button" class="cal-hero-date" id="cal-hero-date" title="Change date">${_clockDate(ds)}</button>
    </div>

    <div class="cal-title-wrap">
      <input type="text" id="cal-f-sum" placeholder=" " value="${_e(existing?.summary || '')}" class="cal-input cal-hero-title" autocomplete="off" />
      <span class="cal-title-hint" aria-hidden="true">${isEdit ? 'Event title' : 'What’s happening?'}<svg class="cal-title-enter-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></span>
    </div>

    <div class="cal-form-details" id="cal-form-details" aria-hidden="${_expandedAtStart ? 'false' : 'true'}">
      <div class="cal-form-row">
        <input type="date" id="cal-f-date" value="${ds}" class="cal-input" />
        <span style="opacity:0.3">to</span>
        <input type="date" id="cal-f-date-end" value="${de}" class="cal-input" />
        <div class="cal-allday-ctrl">
          <span class="cal-allday-label">${t('calendar.all_day')}</span>
          <label class="admin-switch cal-allday-switch"><input type="checkbox" id="cal-f-allday" ${ad ? 'checked' : ''} /><span class="admin-slider"></span></label>
        </div>
      </div>
      <div class="cal-form-row" id="cal-time-row" style="${ad ? 'display:none' : ''}">
        <input type="time" id="cal-f-start" value="${st}" class="cal-input cal-input-time" />
        <span style="opacity:0.3">–</span>
        <input type="time" id="cal-f-end" value="${et}" class="cal-input cal-input-time" />
      </div>
      <div class="cal-loc-row">
        <input type="text" id="cal-f-loc" placeholder=t('calendar.location_label') value="${_e(existing?.location || '')}" class="cal-input" />
        <a id="cal-f-loc-map" class="cal-loc-map" href="#" target="_blank" rel="noopener noreferrer" title="Open in Maps" aria-label="Open in Apple Maps" tabindex="-1">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        </a>
      </div>
      <select id="cal-f-rrule" class="cal-input">
        <option value="" ${!existing?.rrule ? 'selected' : ''}>${t('calendar.does_not_repeat')}</option>
        <option value="FREQ=DAILY" ${existing?.rrule === 'FREQ=DAILY' ? 'selected' : ''}>${t('calendar.daily')}</option>
        <option value="FREQ=WEEKLY" ${existing?.rrule === 'FREQ=WEEKLY' ? 'selected' : ''}>${t('calendar.weekly')}</option>
        <option value="FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" ${existing?.rrule === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' ? 'selected' : ''}>${t('calendar.weekdays')}</option>
        <option value="FREQ=MONTHLY" ${existing?.rrule === 'FREQ=MONTHLY' ? 'selected' : ''}>${t('calendar.monthly')}</option>
        <option value="FREQ=YEARLY" ${existing?.rrule === 'FREQ=YEARLY' ? 'selected' : ''}>${t('calendar.yearly')}</option>
      </select>
      <textarea id="cal-f-desc" placeholder=t('calendar.description_label') class="cal-input" rows="2">${_e(existing?.description || '')}</textarea>
      ${(() => {
  // Cookbook 任务反链接。当描述包含
  // "cookbook_task_id: <id>"标记（由 cookbookSchedule.js
  // 在用户勾选"在日历中创建事件"时设置），渲染一个
  // 打开任务按钮，以便用户直接跳转到
  // 任务页签中的源任务。
        const _ct = (existing?.description || '').match(/cookbook_task_id:\s*([A-Za-z0-9_-]+)/);
        if (!_ct) return '';
        return `<div class="cal-form-row cal-form-cookbook-link" style="align-items:center;gap:8px;">
          <button type="button" id="cal-f-open-task" data-task-id="${_e(_ct[1])}"
            style="display:inline-flex;align-items:center;gap:6px;background:transparent;
                   color:var(--accent,var(--red));border:1px solid var(--border);
                   border-radius:6px;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 11l3 3L22 4"/>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
            <span>${t('calendar.open_in_tasks')}</span>
          </button>
          <span style="font-size:11px;opacity:0.5;">Linked to a Cookbook scheduled task</span>
        </div>`;
      })()}
      <div class="cal-form-row" style="align-items:center;gap:8px;">
        <label style="font-size:11px;display:flex;align-items:center;gap:4px;"><svg class="cal-remind-bell" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent, var(--red))" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><span style="opacity:0.5;">${t('calendar.reminder')}</span></label>
        <select id="cal-f-remind" class="cal-input" style="flex:1;">
          <option value="" ${isEdit ? 'selected' : ''}>${t('calendar.no_reminder')}</option>
          <option value="0">${t('calendar.at_event_time')}</option>
          <option value="5">${t('calendar.n_minutes_before')}</option>
          <option value="10">${t('calendar.n_minutes_before')}</option>
          <option value="15" ${!isEdit ? 'selected' : ''}>${t('calendar.n_minutes_before')}</option>
          <option value="30">${t('calendar.n_minutes_before')}</option>
          <option value="60">${t('calendar.one_hour_before')}</option>
          <option value="120">${t('calendar.n_hours_before')}</option>
          <option value="1440">${t('calendar.one_day_before')}</option>
          <option value="custom">Exact time...</option>
        </select>
        <input type="datetime-local" id="cal-f-remind-custom" class="cal-input" style="flex:1;display:none;" />
      </div>
      <div class="cal-form-row" style="align-items:center;gap:8px;">
        <label style="font-size:11px;opacity:0.5;">${t('calendar.color_label')}</label>
        <div class="note-color-picker" id="cal-f-colors">
          ${CAL_COLORS.map(c => {
            const cur = existing?.color || '';
            const isCustom = c.hex === 'custom';
            const isActive = isCustom ? _isCalBgImage(cur) : (cur === c.hex || (!cur && !c.hex));
            let bg;
            if (isCustom) {
              const url = _calBgImageUrl(cur);
              bg = url ? `center/cover no-repeat url('${url}')` : _CAL_CUSTOM_GRADIENT;
            } else {
              bg = c.hex || 'var(--border)';
            }
            return `<span class="note-color-dot${isActive ? ' active' : ''}" data-color="${c.hex}" style="background:${bg}" title="${c.name}"></span>`;
          }).join('')}
        </div>
      </div>
      ${_calendars.length > 1 ? `<select id="cal-f-cal" class="cal-input cal-f-cal-select">${calOpts}</select>` : ''}
    </div>

    <div class="cal-form-actions">
      ${isEdit ? `<button id="cal-f-del" class="cal-btn cal-btn-danger" style="display:inline-flex;align-items:center;gap:5px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>${t('common.delete')}</button>` : ''}
      <button id="cal-f-cancel" class="cal-btn" style="display:inline-flex;align-items:center;gap:5px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>${t('common.cancel')}</button>
      <button id="cal-f-save" class="cal-btn cal-btn-primary" style="display:inline-flex;align-items:center;gap:5px;">${isEdit
        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>Save'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Create'}</button>
    </div>
  </div>`;

  document.getElementById('cal-f-allday')?.addEventListener('change', (e) => {
    document.getElementById('cal-time-row').style.display = e.target.checked ? 'none' : '';
  });
  // 打开任务反链接按钮 — 动态导入任务模块，
  // 以便即使用户在当前会话中打开日历之前
  // 尚未访问过任务页签，链接也能正常工作。
  document.getElementById('cal-f-open-task')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const taskId = e.currentTarget?.dataset?.taskId || '';
    try {
      const m = await import('/static/js/tasks.js');
      const openTasks = m.openTasks || m.default?.openTasks;
      if (typeof openTasks === 'function') { openTasks(taskId); return; }
    } catch (_) {}
    document.getElementById('tool-tasks-btn')?.click();
  });
  // 保持结束日期 >= 开始日期
  document.getElementById('cal-f-date')?.addEventListener('change', () => {
    const s = document.getElementById('cal-f-date').value;
    const eEl = document.getElementById('cal-f-date-end');
    if (eEl && eEl.value < s) eEl.value = s;
  });
  // 颜色圆点选择器 — 也会实时为表单卡片着色（边框、焦点
  // 环、主按钮），让用户立即看到选择效果。
  const _formCard = document.querySelector('.cal-form-bespoke');
  // 在单行文本框中按 Enter 收起键盘 —
  // 标题旁的 ↵ 符号提示此操作。
  if (_formCard) {
    _formCard.querySelectorAll('input[type="text"]').forEach(inp => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      });
    });
  }
  // 用所选日历的颜色着色日历选择器下拉框，以便
  // 清楚地看到事件属于哪个日历。
  const _calSel = document.getElementById('cal-f-cal');
  if (_calSel) {
    const _tintCalSel = () => {
      const c = _calendars.find(x => x.href === _calSel.value);
      const col = (c && c.color && !_isCalBgImage(c.color)) ? c.color : 'var(--accent, var(--red))';
  // 仅柔和的全宽背景着色 — 无侧边栏/边框高亮。
      _calSel.style.background = `color-mix(in srgb, ${col} 16%, var(--bg))`;
    };
    _calSel.addEventListener('change', _tintCalSel);
    _tintCalSel();
  }
  const _applyFormTint = (hex) => {
    if (!_formCard) return;
    if (_isCalBgImage(hex)) {
  // 用上传的图片绘制表单卡片（镜像笔记表单
  // 预览自定义背景笔记的方式），加上半透明覆盖层使文本
  // 保持可读。Chrome 强调色回退到主题强调色。
      const url = _calBgImageUrl(hex);
      _formCard.style.setProperty('--ev-color', 'var(--accent)');
      _formCard.style.backgroundImage = `linear-gradient(color-mix(in srgb, var(--panel) 65%, transparent), color-mix(in srgb, var(--panel) 65%, transparent)), url('${url.replace(/'/g, "\\'")}')`;
      _formCard.style.backgroundSize = 'cover';
      _formCard.style.backgroundPosition = 'center';
      _formCard.classList.add('cal-form-bg-image');
      return;
    }
  // 清除之前任何自定义背景样式。
    _formCard.classList.remove('cal-form-bg-image');
    _formCard.style.backgroundImage = '';
    _formCard.style.backgroundSize = '';
    _formCard.style.backgroundPosition = '';
    if (hex) _formCard.style.setProperty('--ev-color', hex);
    else _formCard.style.removeProperty('--ev-color');
  };
  document.querySelectorAll('#cal-f-colors .note-color-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
  // 自定义圆点：提示上传图片。空输入 → 无操作。
      if (dot.dataset.color === 'custom') {
        const url = await _pickCalBgImage();
        if (!url) return;
        const sentinel = 'bg:' + url;
        dot.dataset.color = sentinel;
        dot.style.background = `center/cover no-repeat url('${url}')`;
        document.querySelectorAll('#cal-f-colors .note-color-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        _applyFormTint(sentinel);
        return;
      }
      document.querySelectorAll('#cal-f-colors .note-color-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      _applyFormTint(dot.dataset.color || '');
    });
  });
  // 编辑已有事件时的初始着色，使卡片在表单打开时
  // 已经反映已保存的颜色。
  _applyFormTint(existing?.color || '');
  // 当用户更改开始时间时，用相同偏移量调整结束时间，
  // 保持事件原有持续时间（如果开始==结束则默认 1 小时）。
  // 如果用户已经在打开表单后调整了结束输入框，
  // 则跳过 — 我们不想覆盖有意的编辑。
  (function _wireStartShiftsEnd() {
    const startEl = document.getElementById('cal-f-start');
    const endEl = document.getElementById('cal-f-end');
    if (!startEl || !endEl) return;

    const _toMin = (v) => {
      if (!v || !/^\d{2}:\d{2}$/.test(v)) return null;
      const [h, m] = v.split(':').map(n => parseInt(n, 10));
      return h * 60 + m;
    };

    const _toHHMM = (mins) => {
      let m = ((mins % 1440) + 1440) % 1440;
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      return `${hh}:${mm}`;
    };

    const _autoAdvanceEndDate = () => {
      const isAD = document.getElementById('cal-f-allday')?.checked;
      if (isAD) return;

      const dv = document.getElementById('cal-f-date')?.value;
      const dvEndEl = document.getElementById('cal-f-date-end');
      if (!dv || !dvEndEl || dvEndEl.value !== dv) return;

      const sVal = startEl.value;
      const eVal = endEl.value;

      if (sVal && eVal && eVal <= sVal) {
        const d = new Date(`${dv}T00:00:00`);
        d.setDate(d.getDate() + 1);

        dvEndEl.value = _ds(d);
      }
    };

    let prevStartMin = _toMin(startEl.value);

    endEl.addEventListener('input', () => {
      endEl.dataset.userEdited = '1';
    });

    endEl.addEventListener('change', _autoAdvanceEndDate);

    startEl.addEventListener('change', () => {
      const newStartMin = _toMin(startEl.value);
      const endMin = _toMin(endEl.value);

      if (newStartMin == null) {
        prevStartMin = newStartMin;
        return;
      }

      let durationMin = 60;

      if (prevStartMin != null && endMin != null && endMin > prevStartMin) {
        durationMin = endMin - prevStartMin;
      } else if (endMin != null && newStartMin != null && endMin > newStartMin && endEl.dataset.userEdited === '1') {
        prevStartMin = newStartMin;
        return;
      }

      endEl.value = _toHHMM(newStartMin + durationMin);
      prevStartMin = newStartMin;
      _autoAdvanceEndDate();
    });
  })();
  // 自定义提醒选择器
  document.getElementById('cal-f-remind')?.addEventListener('change', (e) => {
    const customInput = document.getElementById('cal-f-remind-custom');
    if (e.target.value === 'custom') {
      customInput.style.display = '';
  // 默认为事件前 1 小时
      const dv = document.getElementById('cal-f-date')?.value || _today();
      const st = document.getElementById('cal-f-start')?.value || '09:00';
      const eventDt = new Date(`${dv}T${st}:00`);
      eventDt.setHours(eventDt.getHours() - 1);
      const pad = n => String(n).padStart(2, '0');
      customInput.value = `${eventDt.getFullYear()}-${pad(eventDt.getMonth()+1)}-${pad(eventDt.getDate())}T${pad(eventDt.getHours())}:${pad(eventDt.getMinutes())}`;
      customInput.focus();
    } else {
      customInput.style.display = 'none';
    }
  // 选择非空提醒时摇铃。CSS 处理
  // 动画；我们只是切换类名使其在每次变更时重新触发。
    const _bell = document.querySelector('.cal-remind-bell');
    if (_bell && e.target.value) {
      _bell.classList.remove('jingling');
      void _bell.offsetWidth;
      _bell.classList.add('jingling');
      setTimeout(() => _bell.classList.remove('jingling'), 700);
    }
  });
  const _cancelEventForm = () => _render();
  document.getElementById('cal-f-cancel')?.addEventListener('click', _cancelEventForm);
  document.getElementById('cal-form-mobile-cancel')?.addEventListener('click', _cancelEventForm);
  document.getElementById('cal-f-save')?.addEventListener('click', async () => {
    const summary = document.getElementById('cal-f-sum').value.trim();
    if (!summary) { uiModule.showToast('Title required'); return; }
    const dv = document.getElementById('cal-f-date').value;
    const dvEnd = document.getElementById('cal-f-date-end').value || dv;
    const isAD = document.getElementById('cal-f-allday').checked;
  // 标题优先：如果标题说明了时间，应用到开始时间
  // （保持当前持续时间），使选择器不会静默不一致。
    if (!isAD) {
      const tt = _parseTitleTime(summary);
      const startEl = document.getElementById('cal-f-start');
      const endEl = document.getElementById('cal-f-end');
      const newStart = tt ? `${String(tt.h).padStart(2, '0')}:${String(tt.m).padStart(2, '0')}` : null;
      if (newStart && startEl && startEl.value !== newStart) {
        const toMin = (v) => { const p = (v || '').split(':'); return p.length === 2 ? (+p[0]) * 60 + (+p[1]) : null; };
        const s0 = toMin(startEl.value), e0 = toMin(endEl?.value);
        const dur = (s0 != null && e0 != null && e0 > s0) ? e0 - s0 : 60;
        startEl.value = newStart;
        const endMin = (tt.h * 60 + tt.m + dur) % 1440;
        if (endEl) endEl.value = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
        startEl.dispatchEvent(new Event('input'));
      }
    }
    const activeDot = document.querySelector('#cal-f-colors .note-color-dot.active');
    const colorVal = activeDot?.dataset.color || '';
  // 附加用户当前的 UTC 偏移，使后端将事件存储为
  // 正确的 UTC 时刻（is_utc=True）。没有此处理，天真的"10:00"会
  // 在其他地方被重新解释为本地时间 — 时区误伤 bug。
    const _tz = _tzOffset();
    
    if (!isAD) {
      const startVal = document.getElementById('cal-f-start').value;
      const endVal = document.getElementById('cal-f-end').value;

      const startDt = new Date(`${dv}T${startVal}:00`);
      const endDt = new Date(`${dvEnd}T${endVal}:00`);

      if (endDt <= startDt) {
        uiModule.showToast('End time must be after start time');
        return;
      }
    }

    const payload = {
      summary,
      dtstart: isAD ? dv : `${dv}T${document.getElementById('cal-f-start').value}:00${_tz}`,
      dtend: isAD ? dvEnd : `${dvEnd}T${document.getElementById('cal-f-end').value}:00${_tz}`,
      all_day: isAD,
      description: document.getElementById('cal-f-desc').value,
      location: document.getElementById('cal-f-loc').value,
      rrule: document.getElementById('cal-f-rrule').value || undefined,
      calendar_href: document.getElementById('cal-f-cal')?.value || (_calendars[0]?.href || ''),
      color: colorVal || undefined,
    };
    try {
      if (isEdit) await _updateEvent(existing.uid, payload);
      else await _createEvent(payload);
  // 如果已选择则创建提醒
      const remindVal = document.getElementById('cal-f-remind')?.value;
      if (remindVal) {
        let remindAt;
        if (remindVal === 'custom') {
          const customVal = document.getElementById('cal-f-remind-custom')?.value;
          remindAt = customVal ? new Date(customVal) : null;
        } else {
          const eventStart = isAD ? new Date(dv + 'T00:00:00') : new Date(`${dv}T${document.getElementById('cal-f-start').value}:00`);
          remindAt = new Date(eventStart.getTime() - parseInt(remindVal) * 60 * 1000);
        }
        if (remindAt && remindAt > new Date()) {
          await _createEventReminder({ summary, dtstart: payload.dtstart, all_day: isAD, location: payload.location }, remindAt);
        }
      }
      _selectedDay = dv; _render();
    } catch (e) { uiModule.showToast('Failed to save'); }
  });
  document.getElementById('cal-f-del')?.addEventListener('click', async () => {
    const name = existing && existing.summary ? `"${existing.summary}"` : 'this event';
    const ok = await uiModule.styledConfirm(t('calendar.delete_event_confirm', { name: name }), { confirmText: t('common.delete'), danger: true });
    if (!ok) return;
    try { await _deleteEvent(existing.uid); _render(); }
    catch (e) { uiModule.showToast('Failed to delete'); }
  });
  // ── 自定义表单行为 ──────────────────────────────────────────
  const formEl = body.querySelector('.cal-form');
  const detailsEl = document.getElementById('cal-form-details');
  const titleInput = document.getElementById('cal-f-sum');

  const setExpanded = (on) => {
    if (!formEl) return;
    formEl.classList.toggle('is-expanded', on);
    if (detailsEl) detailsEl.setAttribute('aria-hidden', on ? 'false' : 'true');
  };

  // 聚焦标题输入框会展开详情（新建事件）。编辑模式
  // 当有详情内容可看时打开已展开状态。
  titleInput?.addEventListener('focus', () => setExpanded(true), { once: true });

  // Live time parse: typing a time like "11pm" or "15:30" into the title
  // updates the hero clock + start input on the fly. The same parser still
  // runs again on submit, but doing it live makes the hero clock track
  // intent immediately instead of jumping at save.
  if (titleInput) {
    titleInput.addEventListener('input', () => {
      if (document.getElementById('cal-f-allday')?.checked) return;
      const tt = _parseTitleTime(titleInput.value);
      if (!tt) return;
      const startEl = document.getElementById('cal-f-start');
      const endEl = document.getElementById('cal-f-end');
      const newStart = `${String(tt.h).padStart(2, '0')}:${String(tt.m).padStart(2, '0')}`;
      if (!startEl || startEl.value === newStart) return;
      const toMin = (v) => { const p = (v || '').split(':'); return p.length === 2 ? (+p[0]) * 60 + (+p[1]) : null; };
      const s0 = toMin(startEl.value), e0 = toMin(endEl?.value);
      const dur = (s0 != null && e0 != null && e0 > s0) ? e0 - s0 : 60;
      startEl.value = newStart;
      const endMin = (tt.h * 60 + tt.m + dur) % 1440;
      if (endEl) endEl.value = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
      startEl.dispatchEvent(new Event('input'));
    });
  }

  // 位置 → Apple Maps。输入框旁边的图钉按钮仅在
  // 位置非空时启用，其 href 实时跟踪
  // 输入值。Apple 通用 URL 在 iOS/macOS 上打开原生地图应用，
  // 在其他平台上回退到网页视图。
  const locInput = document.getElementById('cal-f-loc');
  const locMap = document.getElementById('cal-f-loc-map');
  const _syncLocMap = () => {
    if (!locMap) return;
    const v = (locInput?.value || '').trim();
    if (!v) {
      locMap.classList.add('is-disabled');
      locMap.removeAttribute('href');
      locMap.setAttribute('tabindex', '-1');
      locMap.setAttribute('aria-disabled', 'true');
    } else {
      locMap.classList.remove('is-disabled');
      locMap.setAttribute('href', 'https://maps.apple.com/?q=' + encodeURIComponent(v));
      locMap.setAttribute('tabindex', '0');
      locMap.removeAttribute('aria-disabled');
    }
  };
  locInput?.addEventListener('input', _syncLocMap);
  _syncLocMap();

  // 主区域可点击 — 点击时间或日期打开匹配的
  // 原生选择器。先展开详情面板，使输入框在
  // 布局后可见（在某些浏览器中 showPicker 在 display:none /
  // 0 高度输入框上会失败）。
  const _openPicker = (inputId, { uncheckAllDay = false } = {}) => {
    setExpanded(true);
    const input = document.getElementById(inputId);
    if (!input) return;
    if (uncheckAllDay) {
      const allday = document.getElementById('cal-f-allday');
      if (allday && allday.checked) {
        allday.checked = false;
        document.getElementById('cal-time-row').style.display = '';
        _syncHero();
      }
    }
  // 等待一帧以使显示布局稳定。
    requestAnimationFrame(() => {
      input.focus();
      try { if (typeof input.showPicker === 'function') input.showPicker(); } catch {}
    });
  };
  document.getElementById('cal-hero-time')?.addEventListener('click', (e) => {
  // 检测可视时钟的哪个部分被点击（hh、mm 或
  // 其他位置），以便点击分钟数字时光标定位到
  // 选择器的分钟字段。
    const seg = e.target?.closest('[data-seg]')?.dataset?.seg;
    _openPicker('cal-f-start', { uncheckAllDay: true });
    if (seg === 'mm') {
  // `<input type="time">` 在 Chromium 中接受 setSelectionRange
  // 来选择分钟段；Firefox/Safari 是空操作但
  // 选择器仍然会打开，因此不会丢失任何功能。
      requestAnimationFrame(() => {
        const inp = document.getElementById('cal-f-start');
        if (!inp) return;
        try { inp.setSelectionRange(3, 5); } catch {}
      });
    }
  });
  document.getElementById('cal-hero-date')?.addEventListener('click', () => {
    _openPicker('cal-f-date');
  });

  // 实时主区域时钟 — 保持大号时间/日期与详情面板中
  // 用户仍可调整的输入框同步。
  const _syncHero = () => {
    const allday = document.getElementById('cal-f-allday')?.checked;
    const startVal = document.getElementById('cal-f-start')?.value || '';
    const dateVal = document.getElementById('cal-f-date')?.value || ds;
    const clockEl = document.getElementById('cal-hero-clock');
    const ampmEl = document.getElementById('cal-hero-ampm');
    const dateEl = document.getElementById('cal-hero-date');
    if (clockEl) clockEl.innerHTML = allday ? '<span class="cal-hero-clock-allday">${t('calendar.all_day')}</span>' : _clockFace(startVal);
    if (ampmEl) ampmEl.textContent = allday ? '' : _clockAmpm(startVal);
    if (dateEl) dateEl.textContent = _clockDate(dateVal);
  };
  document.getElementById('cal-f-start')?.addEventListener('input', _syncHero);
  document.getElementById('cal-f-allday')?.addEventListener('change', _syncHero);
  document.getElementById('cal-f-date')?.addEventListener('change', _syncHero);
  _syncHero();

  // 新建事件：预先展开详情（不依赖标题的 focus
  // 事件 — 编程式的 .focus() 在移动端通常是空操作，会留下
  // 仅显示标题 + 按钮的表单），然后聚焦标题。
  if (!isEdit) { setExpanded(true); titleInput?.focus(); }

  // 实时"今天是 …"计时器。每 30 秒更新一次；当标题元素消失时
  // 自动停止（任何 _render() 调用都会替换 #cal-body 的 HTML）。
  const _todayTextEl = document.getElementById('cal-form-today-text');
  if (_todayTextEl) {
    const _tick = () => {
      const el = document.getElementById('cal-form-today-text');
      if (!el) { clearInterval(_todayInterval); return; }
      el.textContent = `${_clockDate(_today())} · ${_nowClock()}`;
    };
    const _todayInterval = setInterval(_tick, 30000);
  }
}

// ── 辅助函数 ──

function _fmtDate(s) { return new Date(s + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }); }

// 主区域时钟辅助函数 — 供自定义事件表单使用。
// _clockFace 返回冒号分隔的数字（"HH : MM"），_clockAmpm
// 返回 "AM"/"PM"/""（全天事件为空），_clockDate 是长格式
// "周六 · 5月10日, 2026"。24 小时制无 AM/PM 标记。
function _clockFace(hhmm) {
  // 返回拆分为 hh / 分隔符 / mm 子 span 的时钟，使每个
  // 部分可单独点击。包裹的 #cal-hero-clock 的
  // innerHTML 由 _syncHero 重新设置，因此 span 可以干净地往返。
  if (!hhmm) {
    return '<span class="cal-hero-clock-hh" data-seg="hh">—</span><span class="cal-hero-sep"> : </span><span class="cal-hero-clock-mm" data-seg="mm">—</span>';
  }
  const [h, m] = hhmm.split(':');
  const use12 = (new Date()).toLocaleString().toLowerCase().match(/am|pm/);
  let hh = parseInt(h, 10);
  if (use12) { hh = ((hh + 11) % 12) + 1; }
  const hhStr = String(hh).padStart(2, '0');
  return `<span class="cal-hero-clock-hh" data-seg="hh">${hhStr}</span><span class="cal-hero-sep"> : </span><span class="cal-hero-clock-mm" data-seg="mm">${m}</span>`;
}
function _clockAmpm(hhmm) {
  if (!hhmm) return '';
  const use12 = (new Date()).toLocaleString().toLowerCase().match(/am|pm/);
  if (!use12) return '';
  const h = parseInt(hhmm.split(':')[0], 10);
  return h < 12 ? 'AM' : 'PM';
}
function _clockDate(ds) {
  if (!ds) return '';
  return new Date(ds + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function _nowClock() {
  // "今天是 …"标题的实时墙上时钟字符串。支持区域设置，
  // 24 小时制用户看不到 AM/PM。
  return new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function _fmtTime(s) {
  if (!s || s.length < 16) return '';
  // 来自 CalDAV/导入的时区感知时间戳存储为 UTC 时刻，
  // 序列化时带有 Z/偏移。在浏览器本地时区显示；
  // 遗留的朴素时间戳保持其书写的墙上时钟时间。
  if (/[Zz]$|[+\-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
  }
  return s.slice(11, 16);
}

function _timeToMin(iso) {
  const hm = _fmtTime(iso);
  if (!hm) return null;
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function _tzOffsetForDate(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

function _addMinutesToLocalIso(baseIso, addMinutes) {
  const d = new Date(new Date(baseIso).getTime() + addMinutes * 60000);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da}T${h}:${m}:00${_tzOffsetForDate(d)}`;
}

function _e(s) { return uiModule.esc ? uiModule.esc(s || '') : (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// 将位置字符串链接化：URL 变得可点击，普通地址获得地图链接。
function _locHTML(loc) {
  if (!loc) return '';
  const urlRe = /(https?:\/\/[^\s]+)/gi;
  if (urlRe.test(loc)) {
    return loc.replace(urlRe, (url) => {
      const safe = _e(url);
      return `<a href="${safe}" target="_blank" rel="noopener" onclick="event.stopPropagation();">${safe}</a>`;
    }).replace(/\n/g, '<br>');
  }
  // 无 URL — 将整个文本链接到 OpenStreetMap。
  const mapUrl = 'https://www.openstreetmap.org/search?query=' + encodeURIComponent(loc);
  return `<a href="${mapUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation();" title="Open in OpenStreetMap">${_e(loc)}</a>`;
}

// ── 打开 / 关闭 ──

let _wheelDebounce = 0;
function _wheelNav(e) {
  if (!_open) return;
  // 不拦截日详情面板或任何其他内部滚动区域内的滚动
  if (e.target.closest('.cal-day-detail') || e.target.closest('.cal-form')) return;
  const body = document.getElementById('cal-body');
  if (!body) return;
  const now = Date.now();
  if (now - _wheelDebounce < 300) { e.preventDefault(); return; }
  if (Math.abs(e.deltaY) < 30) return;
  _wheelDebounce = now;
  e.preventDefault();
  if (e.deltaY > 0) {
    _slideDir = 1;
    if (_view === 'year') _currentDate = new Date(_currentDate.getFullYear() + 1, 0, 1);
    else if (_view === 'week') _currentDate.setDate(_currentDate.getDate() + 7);
    else _currentDate = new Date(_currentDate.getFullYear(), _currentDate.getMonth() + 1, 1);
  } else {
    _slideDir = -1;
    if (_view === 'year') _currentDate = new Date(_currentDate.getFullYear() - 1, 0, 1);
    else if (_view === 'week') _currentDate.setDate(_currentDate.getDate() - 7);
    else _currentDate = new Date(_currentDate.getFullYear(), _currentDate.getMonth() - 1, 1);
  }
  _selectedDay = null;
  _render();
}

function openCalendar() {
  if (_open) return;
  // 如果当前已最小化 — 原地恢复，保留所有状态
  if (Modals.isMinimized('calendar-modal')) {
    Modals.restore('calendar-modal');
    _open = true;
    return;
  }
  _open = true;
  if (_todayCount() > 0) { _markBadgeSeen(); _updateBadge(); }
  _collapseSidebar();
  const modal = _getModal();
  // 清理之前滑动关闭留下的任何状态
  modal.classList.remove('hidden', 'modal-minimized');
  const _content = modal.querySelector('.modal-content');
  if (_content) {
    _content.classList.remove('modal-closing', 'sheet-ready');
    _content.style.transform = '';
    _content.style.transition = '';
    _content.style.animation = '';
    _content.style.opacity = '';
  }
  modal.style.display = 'flex';
  Modals.register('calendar-modal', {
    railBtnId: 'rail-calendar',
    sidebarBtnId: 'tool-calendar-btn',
    closeFn: () => _doCloseCalendar(),
    restoreFn: () => {},
  });
  _currentDate = new Date();
  _selectedDay = _today();  // 打开时自动显示今天的事件
  _view = 'month';
  _scrollToTodayOnOpen = true;  // 首次渲染定位到今天所在的行
  _escHandler = (e) => {
    if (e.key === 'Escape') {
  // 分层 Esc：先关闭最顶层的日历界面，只有在没有
  // 其他界面在最顶层时才进一步关闭整个日历。
      const settings = document.getElementById('cal-settings-panel');
      if (settings) { settings.remove(); return; }
      if (document.querySelector('.cal-form')) { _render(); return; }
      closeCalendar();
    }
    else if (e.key === 'ArrowLeft') document.getElementById('cal-prev')?.click();
    else if (e.key === 'ArrowRight') document.getElementById('cal-next')?.click();
    else if (e.key === 't' || e.key === 'T') document.getElementById('cal-today')?.click();
  // Cmd/Ctrl+Z 由模块级 `_calUndoBound` 监听器处理，
  // 它消费共享的 `_calUndoStack`。不要在此处重复。
  };
  document.addEventListener('keydown', _escHandler);
  const body = document.getElementById('cal-body');
  if (body) {
    body.innerHTML = '<div class="cal-loading"></div>';
    const wp = spinnerModule.createWhirlpool(28);
    wp.element.style.margin = '40px auto';
    body.querySelector('.cal-loading').appendChild(wp.element);
    body.addEventListener('wheel', _wheelNav, { passive: false });
  }
  _fetchCalendars().then(() => _render());
}

// 打开日历并定位到特定事件（通过 uid）或日期。
// 由聊天锚点链接委托使用，使 `[Wake up](#event-<uid>)`
// 打开日历到那一天并高亮该事件。
async function openCalendarTo(target) {
  openCalendar();
  if (!target) return;
  try {
    await _fetchCalendars();
  // 如果目标看起来像 ISO 日期（YYYY-MM-DD...），直接跳转。
    let dt = null;
    const isoMatch = /^\d{4}-\d{2}-\d{2}/.test(String(target));
    if (isoMatch) {
      dt = new Date(target);
    } else {
  // 视为事件 uid — 在已加载的事件中查找。
      const ev = (_events || []).find(e => e.uid === target || (e.uid || '').startsWith(target));
      if (ev && ev.dtstart) dt = new Date(ev.dtstart);
      if (ev) _highlightEventUid = ev.uid;
    }
    if (dt && !isNaN(dt.getTime())) {
      _currentDate = new Date(dt);
      _selectedDay = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
      _view = 'month';
      _render();
    }
  } catch (e) { /* 尽力定位 */ }
}

let _highlightEventUid = null;

function _doCloseCalendar() {
  _open = false;
  _restoreSidebar();
  if (_modal) {
    _modal.style.display = 'none';
    _modal.classList.add('hidden');
  }
  if (_escHandler) { document.removeEventListener('keydown', _escHandler); _escHandler = null; }
  // 丢弃任何待处理的撤销 — 闭包捕获的事件 uid/状态可能
  // 在用户重新打开时已不再有效。重新打开日历
  // 以干净状态开始。
  _calUndoStack.length = 0;
}

function closeCalendar() {
  if (!_open && !Modals.isMinimized('calendar-modal')) return;
  if (Modals.isRegistered('calendar-modal')) {
    Modals.close('calendar-modal');
  } else {
    _doCloseCalendar();
  }
}

function isCalendarOpen() {
  // 将最小化状态视为"未打开"，使切换处理器通过 Modals.toggle 恢复
  if (Modals.isMinimized('calendar-modal')) return false;
  return _open;
}

// ── 持久化缓存（localStorage） ──
const LS_KEY = 'odysseus-calendar-cache';
const LS_TTL = 10 * 60 * 1000; // 10 分钟

function _saveCache() {
  try {
    const data = {
      ts: Date.now(),
      calendars: _calendars,
      events: Object.values(_allEvents),
      ranges: _fetchedRanges,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch (e) {}
}

function _loadCache() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data.ts || Date.now() - data.ts > LS_TTL) return false;
    if (data.calendars) _calendars = data.calendars;
    if (data.events) data.events.forEach(ev => { _allEvents[ev.uid] = ev; });
  // 不恢复 _fetchedRanges — 始终从 API 重新获取以接收
  // 外部变更（例如 TimeTree 同步添加事件）
    return true;
  } catch (e) { return false; }
}

// 启动：加载缓存，刷新角标，预取当月数据
(async () => {
  _loadCache();
  _updateBadge();
  try {
    await _fetchCalendars();
    _saveCache();
    const [s, e] = _monthRange(new Date());
    await _fetchEvents(s, e);
    _saveCache();
    _updateBadge();
  } catch (e) {}
})();

// AI 代理添加/编辑/删除事件时实时刷新。chat.js 分发
// `calendar-refresh` 在 manage_calendar 工具调用后，使新事件
// 在无需用户硬刷新的情况下显示。丢弃缓存（使添加/编辑/删除
// 全部反映），重新获取可见范围，如果已打开则重新渲染，并更新角标。
window.addEventListener('calendar-refresh', () => {
  _allEvents = {};
  _fetchedRanges = [];
  const range = (_view === 'year')
    ? [`${_currentDate.getFullYear()}-01-01`, `${_currentDate.getFullYear() + 1}-01-01`]
    : (_view === 'week') ? _weekRange(_currentDate) : _monthRange(_currentDate);
  _fetchEvents(range[0], range[1], /*force*/ true)
    .then(() => { if (_open) _render(); _updateBadge(); })
    .catch(() => {});
});

// 跨会话同步：当标签页/应用再次可见时（你按 Alt+Tab
// 切回、移动应用回到前台或从另一个浏览器会话
// 切换回来），丢弃范围缓存并重新获取。没有此处理，
// 桌面端的删除或添加永远不会传到仍然打开的移动标签页
// 直到用户进行完全重新加载 — 因此过期事件在那里无法删除
// （它们在服务器上 404）。每次可见性变化时触发，但
// fetch 开销很小且已被第 ~120 行的 _fetchPromise 去重。
let _lastVisRefetchAt = 0;
const _VIS_REFETCH_MIN_MS = 10 * 1000;  // 如果用户快速切换标签页则节流
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (now - _lastVisRefetchAt < _VIS_REFETCH_MIN_MS) return;
  _lastVisRefetchAt = now;
  _fetchedRanges = [];
  const range = (_view === 'year')
    ? [`${_currentDate.getFullYear()}-01-01`, `${_currentDate.getFullYear() + 1}-01-01`]
    : (_view === 'week') ? _weekRange(_currentDate) : _monthRange(_currentDate);
  _fetchEvents(range[0], range[1], /*force*/ true)
    .then(() => { if (_open) _render(); _updateBadge(); })
    .catch(() => {});
});

// 窗口级焦点同理 — 覆盖桌面 Alt+Tab 切回一个
// 标签页已可见的浏览器（visibilitychange 不会触发）。
window.addEventListener('focus', () => {
  const now = Date.now();
  if (now - _lastVisRefetchAt < _VIS_REFETCH_MIN_MS) return;
  _lastVisRefetchAt = now;
  _fetchedRanges = [];
  const range = (_view === 'year')
    ? [`${_currentDate.getFullYear()}-01-01`, `${_currentDate.getFullYear() + 1}-01-01`]
    : (_view === 'week') ? _weekRange(_currentDate) : _monthRange(_currentDate);
  _fetchEvents(range[0], range[1], /*force*/ true)
    .then(() => { if (_open) _render(); _updateBadge(); })
    .catch(() => {});
});

// 日历提醒存储为笔记。笔记提醒循环负责
// 通知分发，因此日历提醒不会重复触发。

const calendarModule = { openCalendar, closeCalendar, isCalendarOpen };
export { openCalendar, openCalendarTo, closeCalendar, isCalendarOpen };
export default calendarModule;
