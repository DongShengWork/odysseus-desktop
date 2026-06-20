/**
 * Notes 模块 — Google Keep 风格的笔记和待办事项。
 * 以侧边栏面板形式渲染（类似文档编辑器），而非模态框。
 */

import uiModule from './ui.js';
import { spawnConfetti } from './compare/vote.js';
import * as Modals from './modalManager.js';
import { attachColorPicker } from './colorPicker.js';
import { makeWindowDraggable } from './windowDrag.js';
import { snapModalToZone } from './tileManager.js';
import { applyEdgeDock, clearDockSide } from './modalSnap.js';

const API_BASE = window.location.origin;
let _open = false;
let _notes = [];
let _editingId = null;
let _selectedIds = new Set();
let _activeLabel = null;
let _activeFilter = null; // null | 'default' | 'reminders' | 'no-reminders'（默认提醒、无提醒）
// Reminders 标签的循环顺序：每次点击在 reminders 之间切换 →
// null → no-reminders → null → reminders → ... 此变量记录经过 null 后，
// 下一次点击应进入哪个非 null 状态。
let _reminderChipNext = 'reminders';
let _searchQuery = '';
let _viewMode = (typeof localStorage !== 'undefined' && localStorage.getItem('odysseus-notes-view')) || 'list'; // 'list' 列表或 'grid' 网格
let _showingArchived = false;
let _selectMode = false;
let _reminderTimer = null;
// 跟踪全局 keydown 监听器，以便 closePanel 可以移除它
// （之前每次 openPanel 都会泄漏一个监听器，在多次打开会话中
// 会堆积数十个相同的处理器）。
let _notesKeydownHandler = null;
// 文档上的捕获阶段"Esc 取消选择模式"监听器 — 跟踪以便
// 关闭时移除，避免每次打开/关闭面板都泄漏一个处理器。
let _notesSelectEscHandler = null;
const REMINDER_FIRED_KEY = 'odysseus-notes-reminder-fired';
// 已显示过一次提醒发光效果的笔记 ID。当用户重新安排提醒时重置，
// 以便下次打开时新触发的提醒再次发光。
const REMINDER_GLOWED_KEY = 'odysseus-notes-reminder-glowed';
// 在笔记面板关闭期间触发了提醒的笔记 ID。下次打开面板时，
// 我们会短暂高亮这些卡片，以便用户发现它们。
const REMINDER_PENDING_HIGHLIGHT_KEY = 'odysseus-notes-reminder-pending-highlight';
const REMINDER_ACTIVE_HIGHLIGHT_KEY = 'odysseus-notes-reminder-active-highlight';
// 用户上次打开笔记面板的时间戳 — 用于控制导航栏"已触发"徽章，
// 避免每次页面重新加载时旧提醒重新触发。
const REMINDER_DISMISSED_AT_KEY = 'odysseus-notes-reminder-dismissed-at';
const NOTES_FIRST_OPEN_HINT_KEY = 'odysseus-notes-first-open-hint-v1';

function _forceCloseNotesPanel() {
  _open = false;
  _editingId = null;
  try { _commitOpenInPlaceEditor(); } catch {}
  try { _closeMobileFullscreenEdit({ save: true }); } catch {}
  try { _clearViewedReminderGlows(); } catch {}
  if (_notesKeydownHandler) {
    document.removeEventListener('keydown', _notesKeydownHandler);
    _notesKeydownHandler = null;
  }
  if (_notesSelectEscHandler) {
    document.removeEventListener('keydown', _notesSelectEscHandler, true);
    _notesSelectEscHandler = null;
  }
  if (_reminderTimer) {
    clearInterval(_reminderTimer);
    _reminderTimer = null;
  }
  document.body.classList.remove('notes-view', 'notes-mobile-mode', 'notes-drag-mode');
  document.getElementById('tool-notes-btn')?.classList.remove('active');
  try { Modals.unregister('notes-panel'); } catch {}
  try { document.getElementById('notes-pane')?.remove(); } catch {}
  try { document.getElementById('notes-pane-backdrop')?.remove(); } catch {}
  try { window._restoreSidebarIfRouteCollapsed?.(); } catch {}
}

function _showNotesFirstOpenHint(pane) {
  if (!pane || typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(NOTES_FIRST_OPEN_HINT_KEY)) return;
    localStorage.setItem(NOTES_FIRST_OPEN_HINT_KEY, '1');
  } catch {
    return;
  }

  document.getElementById('notes-first-open-hint')?.remove();
  const hint = document.createElement('div');
  hint.id = 'notes-first-open-hint';
  hint.className = 'tour-hint';
  hint.innerHTML = `
    <div class="tour-hint-text"><b>Notes</b> is your basic todo list, and also where reminders are managed.</div>
    <button type="button" class="tour-hint-dismiss">OK</button>
  `;
  document.body.appendChild(hint);

  const place = () => {
    const r = pane.getBoundingClientRect();
    const hw = hint.offsetWidth || 260;
    hint.style.top = Math.max(12, r.top + 58) + 'px';
    hint.style.left = Math.min(window.innerWidth - hw - 12, Math.max(12, r.left + 18)) + 'px';
  };
  const close = () => {
    window.removeEventListener('resize', place);
    hint.classList.add('tour-hint-out');
    setTimeout(() => hint.remove(), 180);
  };

  requestAnimationFrame(() => {
    place();
    hint.classList.add('tour-hint-in');
  });
  window.addEventListener('resize', place);
  hint.querySelector('.tour-hint-dismiss')?.addEventListener('click', close);
  setTimeout(close, 6500);
}

function _notesFullscreenSafeRect() {
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  let left = 0;
  let right = vw;

  const sidebar = document.getElementById('sidebar');
  const rail = document.getElementById('icon-rail');
  const hamburgerRight = document.body.classList.contains('hamburger-right')
    || sidebar?.classList.contains('right-side')
    || rail?.classList.contains('right-side');

  const reserve = (el) => {
    if (!el || getComputedStyle(el).display === 'none') return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (hamburgerRight) right = Math.min(right, rect.left);
    else left = Math.max(left, rect.right);
  };

  if (sidebar && !sidebar.classList.contains('hidden')) reserve(sidebar);
  reserve(rail);

  // 固定的汉堡菜单按钮可能在侧边栏/导航栏折叠时仍然可见。
  // 也为其保留空间，避免全屏笔记被其遮挡。
  const hamburger = document.getElementById('hamburger-btn');
  if (hamburger && getComputedStyle(hamburger).display !== 'none') {
    const rect = hamburger.getBoundingClientRect();
    const pad = 8;
    if (hamburgerRight) right = Math.min(right, rect.left - pad);
    else left = Math.max(left, rect.right + pad);
  }

  left = Math.max(0, Math.min(left, vw - 80));
  right = Math.max(left + 80, Math.min(right, vw));
  return { left, top: 0, width: right - left, height: vh };
}

function _wireNotesWindow(pane) {
  if (!pane || pane.dataset.windowDragWired === '1') return;
  const header = pane.querySelector('.notes-pane-header');
  if (!header) return;
  pane.dataset.windowDragWired = '1';
  makeWindowDraggable(pane, {
    content: pane,
    header,
    fsClass: 'notes-window-fullscreen',
    skipSelector: 'button, input, select, textarea, label, .notes-mobile-grabber',
    enableDock: true,
    enableLeftDock: true,
    onEnterFullscreen: () => {
      pane.classList.add('notes-window-fullscreen');
      snapModalToZone(pane, {
        name: 'fullscreen',
        rect: _notesFullscreenSafeRect(),
      });
    },
    onExitFullscreen: () => {
      _restoreNotesSidebarDock(pane);
    },
  });
}

function _clearNotesSnapStyles(pane) {
  if (!pane) return;
  const hadLeft = pane.classList.contains('modal-left-docked');
  const hadRight = pane.classList.contains('modal-right-docked');
  pane.classList.remove('notes-window-fullscreen', 'modal-left-docked', 'modal-right-docked');
  if (hadLeft) clearDockSide('left', pane);
  if (hadRight) clearDockSide('right', pane);
  ['position', 'left', 'top', 'right', 'bottom', 'width', 'max-width', 'height',
    'max-height', 'margin', 'transform', 'border-radius']
    .forEach((prop) => pane.style.removeProperty(prop));
  delete pane.dataset._tilePreSnap;
  delete pane.dataset._tileZone;
  delete pane._preDockSnapshot;
  delete pane._dockSide;
  delete pane._dockSuspended;
}

function _restoreNotesSidebarDock(pane) {
  if (!pane || window.innerWidth <= 768) return;
  _clearNotesSnapStyles(pane);
  if (!pane.isConnected) return;
  applyEdgeDock(pane, 'right');
}

function _loadPendingHighlights() {
  try { return new Set(JSON.parse(localStorage.getItem(REMINDER_PENDING_HIGHLIGHT_KEY) || '[]')); }
  catch { return new Set(); }
}
function _loadGlowedReminders() {
  try { return new Set(JSON.parse(localStorage.getItem(REMINDER_GLOWED_KEY) || '[]')); }
  catch { return new Set(); }
}
function _saveGlowedReminders(set) {
  try { localStorage.setItem(REMINDER_GLOWED_KEY, JSON.stringify([...set])); } catch {}
}
function _loadActiveHighlights() {
  try { return new Set(JSON.parse(localStorage.getItem(REMINDER_ACTIVE_HIGHLIGHT_KEY) || '[]')); }
  catch { return new Set(); }
}
function _saveActiveHighlights(set) {
  try { localStorage.setItem(REMINDER_ACTIVE_HIGHLIGHT_KEY, JSON.stringify([...set])); } catch {}
}
function _clearViewedReminderGlows() {
  const active = _loadActiveHighlights();
  if (!active.size) return;
  _saveActiveHighlights(new Set());
  document.querySelectorAll('.note-card-reminder-fired-sticky').forEach(card => {
    card.classList.remove('note-card-reminder-fired-sticky');
  });
}
function _setReminderCardGlow(noteId, on = true) {
  if (!noteId) return;
  const active = _loadActiveHighlights();
  if (on) active.add(noteId);
  else active.delete(noteId);
  _saveActiveHighlights(active);
  document.querySelectorAll(`.note-card[data-note-id="${noteId}"]`).forEach(card => {
    card.classList.toggle('note-card-reminder-fired-sticky', on);
  });
}
// A note has an active reminder when its due time has passed and the user
// hasn't archived or fully completed it. Used for both sorting (bumped above
// the rest of the unpinned section) and the entry-glow flush.
function _hasActiveReminder(n) {
  if (!n || n.archived || _isNoteFullyDone(n)) return false;
  if (!n.due_date) return false;
  const t = new Date(n.due_date).getTime();
  return !isNaN(t) && t <= Date.now();
}
function _savePendingHighlights(set) {
  try { localStorage.setItem(REMINDER_PENDING_HIGHLIGHT_KEY, JSON.stringify([...set])); }
  catch {}
}
function _queuePendingHighlight(noteId) {
  const set = _loadPendingHighlights();
  set.add(noteId);
  _savePendingHighlights(set);
}
function _flushPendingHighlights() {
  // 面板关闭期间由后台循环排队的新触发提醒 — 无条件发光，
  // 因为通知已经告诉用户发生了某事，我们始终指向该笔记，
  // 即使它之前曾经发光过。
  const queued = _loadPendingHighlights();
  const glowed = _loadGlowedReminders();
  const toGlow = new Set(queued);
  // 对于仅在打开时已过期但无新触发事件的笔记，
  // 只对尚未显示过的发光 — 否则每次重新打开面板
  // 都会一直高亮旧提醒。
  for (const n of _notes) {
    if (!_hasActiveReminder(n) || !_hasTimeComponent(n.due_date)) continue;
    if (queued.has(n.id) || !glowed.has(n.id)) toGlow.add(n.id);
  }
  // 始终消费队列。
  _savePendingHighlights(new Set());
  if (!toGlow.size) return;
  let firstCard = null;
  for (const id of toGlow) {
    const card = document.querySelector(`.note-card[data-note-id="${id}"]`);
    if (!card) continue;
    _setReminderCardGlow(id, true);
    if (!firstCard) firstCard = card;
    glowed.add(id);
  }
  _saveGlowedReminders(glowed);
  // 将第一个卡片滚动到视图中，避免被折叠区域遮挡。
  if (firstCard) {
    requestAnimationFrame(() => {
      try { firstCard.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      catch { firstCard.scrollIntoView(); }
    });
  }
}

const COLORS = [
  { name: 'none',    value: '' },
  { name: 'red',     value: 'red' },
  { name: 'orange',  value: 'orange' },
  { name: 'yellow',  value: 'yellow' },
  { name: 'green',   value: 'green' },
  { name: 'blue',    value: 'blue' },
  { name: 'purple',  value: 'purple' },
  { name: 'custom',  value: 'custom' },  // 标记 — 点击打开原生颜色选择器
];

const _CUSTOM_GRADIENT = 'conic-gradient(from 0deg, #e06c75, #d19a66, #e5c07b, #98c379, #61afef, #c678dd, #e06c75)';

// 笔记的颜色可能是：''（无）、预设名称（red/orange/…），或
// 标记 "bg:<image-url>" 表示用户上传的自定义背景图片。
function _isBgImage(c) { return typeof c === 'string' && c.startsWith('bg:'); }
function _bgImageUrl(c) { return _isBgImage(c) ? c.slice(3) : ''; }

function _dotBg(value, noteColor) {
  if (value === 'custom') {
    const url = _bgImageUrl(noteColor);
    return url ? `center/cover no-repeat url('${url}')` : _CUSTOM_GRADIENT;
  }
  return COLOR_HEX[value];
}

function _dotIsActive(value, noteColor) {
  if (value === 'custom') return _isBgImage(noteColor);
  return value === (noteColor || '');
}

// 当颜色为自定义背景图片时，笔记卡片/表单的内联样式。
function _customColorStyle(c) {
  if (!_isBgImage(c)) return '';
  const url = _bgImageUrl(c);
  return `background-image: linear-gradient(color-mix(in srgb, var(--panel) 60%, transparent), color-mix(in srgb, var(--panel) 60%, transparent)), url('${url}'); background-size: cover; background-position: center; border-color: color-mix(in srgb, var(--fg) 25%, var(--border));`;
}

// 打开文件选择器，上传所选图片，并返回 URL。
function _pickCustomBgImage() {
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
    // 尽力清理，以防用户关闭对话框。
    setTimeout(() => { if (!done && !input.files?.length) finish(null); }, 30000);
    input.click();
  });
}

const COLOR_HEX = {
  '':       'var(--border)',
  // 柔和/粉彩调色板 — 与日历事件颜色选择器匹配。
  red:      '#f0b5ba',
  orange:   '#e8ccb2',
  yellow:   '#f2dfbd',
  green:    '#cce0bc',
  blue:     '#b0d7f7',
  purple:   '#e2bcee',
};

// ---- API 接口 ----

let _loading = false;
// 撤销栈 — 最近的操作在末尾。我们限制其大小，因为面板重新加载后
// 唯一能保留的条目只在内存中。
const _undoStack = [];
function _pushUndo(entry) {
  _undoStack.push(entry);
  if (_undoStack.length > 20) _undoStack.shift();
}
function _popAndRunUndo() {
  const entry = _undoStack.pop();
  if (entry) entry.run();
  return !!entry;
}

function _undoArchive(note, prevIdx) {
  // 在原始位置重新插入并在服务器上清除归档标记。
  const safeIdx = Math.min(Math.max(prevIdx, 0), _notes.length);
  _notes.splice(safeIdx, 0, { ...note, archived: false });
  _renderNotes();
  _patchNote(note.id, { archived: false }).catch(() => {
    // 如果服务器拒绝则回滚本地插入
    const i = _notes.findIndex(n => n.id === note.id);
    if (i >= 0) _notes.splice(i, 1);
    _renderNotes();
    uiModule.showError(t('notes.undo_failed'));
  });
}

async function _fetchNotes() {
  _loading = true;
  try {
    const url = `${API_BASE}/api/notes${_showingArchived ? '?archived=true' : ''}`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) { _notes = []; return; }
    const data = await res.json();
    _notes = data.notes || data || [];
  } catch (e) {
    console.error('Failed to fetch notes:', e);
    _notes = [];
  } finally {
    _loading = false;
  }
}

async function _saveNote(note) {
  const method = note.id ? 'PUT' : 'POST';
  const url = note.id ? `${API_BASE}/api/notes/${note.id}` : `${API_BASE}/api/notes`;
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(note),
  });
  if (!res.ok) throw new Error('Failed to save note');
  return await res.json();
}

async function _deleteNoteApi(id) {
  // v2 审查 — 之前静默吞掉 4xx/5xx 错误。现在抛出异常使调用方
  // 可以区分成功和失败，并相应地弹出提示。
  const r = await fetch(`${API_BASE}/api/notes/${id}`, { method: 'DELETE', credentials: 'same-origin' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}

async function _patchNote(id, patch) {
  const res = await fetch(`${API_BASE}/api/notes/${id}`, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('Failed to update note');
  return await res.json();
}

// ---- 辅助函数 ----

function _esc(s) { return uiModule.esc ? uiModule.esc(s || '') : (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function _attrEsc(s) {
  return String(s || '')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;');
}
// 图片 src 防护 — 拒绝任何不是相对路径、http(s) 或
// 栅格 data URL 的内容，防止 AI 保存的笔记在渲染的 <img> 中
// 插入可执行脚本的媒体。
function _safeImgSrc(s) {
  const v = (s || '').trim();
  if (!v) return '';
  if (v.startsWith('/') || v.startsWith('./') || v.startsWith('../')) return v;
  if (/^https?:\/\//i.test(v) || /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(v)) return v;
  return '';
}

// 先转义，然后将 http(s)://... URL 转换为可点击的锚点。XSS 安全。
// 允许 URL 中的平衡 `(...)` （如 Wikipedia、MD 链接），在主体中接受 `(`，
// 然后在之后裁剪尾部不匹配的 `)`。
function _linkify(s) {
  const escaped = _esc(s);
  const urlRe = /\b((?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?\]])/g;
  return escaped.replace(urlRe, (m) => {
    let url = m;
    // 裁剪尾部没有匹配 '(' 的 ')'
    if (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
      url = url.slice(0, -1);
    }
    const href = url.startsWith('www.') ? `https://${url}` : url;
    return `<a href="${_attrEsc(href)}" class="note-link" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${url}</a>` + (url !== m ? m.slice(url.length) : '');
  });
}
function _uid() { return Math.random().toString(36).slice(2, 10); }

// 移动端滑动关闭笔记面板。与文档面板手势一致
// （手指跟随、基于速度的关闭、橡皮筋效果、弹回），
// 使两者体验一致；通过 notes closePanel('down') 关闭。
function _wireNotesSwipeDismiss(el, pane) {
  if (!el || !pane) return;
  const DISMISS_THRESHOLD = 50, VELOCITY_THRESHOLD = 0.3, RUBBER = 0.35;
  let startY = 0, startX = 0, lastY = 0, lastT = 0, velocity = 0;
  let dragging = false, cancelled = false;

  el.addEventListener('touchstart', (e) => {
    if (window.innerWidth > 768 || e.touches.length !== 1) return;
    if (e.target.closest('button, input, select, label, textarea')) return;
    const t = e.touches[0];
    startY = t.clientY; startX = t.clientX; lastY = startY; lastT = e.timeStamp;
    velocity = 0; dragging = false; cancelled = false;
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (cancelled || window.innerWidth > 768) return;
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - startX);
    const dy = t.clientY - startY;
    if (!dragging) {
      if (dx > 40 && dx > Math.abs(dy) * 2) { cancelled = true; return; }
      if (Math.abs(dy) > 8) {
        dragging = true;
        pane.style.animation = 'none';
        pane.style.transition = 'none';
        pane.style.willChange = 'transform';
      } else return;
    }
    const dt = e.timeStamp - lastT;
    if (dt > 0) velocity = velocity * 0.6 + ((t.clientY - lastY) / dt) * 0.4;
    lastY = t.clientY; lastT = e.timeStamp;
    e.preventDefault();
    pane.style.transform = dy > 0 ? `translateY(${dy}px)` : `translateY(${dy * RUBBER}px)`;
  }, { passive: false });

  const endSwipe = () => {
    if (!dragging) return;
    dragging = false;
    pane.style.willChange = '';
    const dy = lastY - startY;
    if (dy > DISMISS_THRESHOLD || (dy > 20 && velocity > VELOCITY_THRESHOLD)) {
      // 滑动完全离开屏幕，然后最小化。保持向下平移（不重置），
      // 避免在 closePanel 移除前闪烁回来。
      pane.style.transition = 'transform 0.2s cubic-bezier(0.2, 0, 0.4, 1)';
      pane.style.transform = 'translateY(100%)';
      setTimeout(() => closePanel('down'), 200);
    } else {
      pane.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.9, 0.3, 1.05)';
      pane.style.transform = '';
      setTimeout(() => { pane.style.transition = ''; }, 260);
    }
  };
  el.addEventListener('touchend', endSwipe, { passive: true });
  el.addEventListener('touchcancel', endSwipe, { passive: true });
}

function _hasTimeComponent(dateStr) {
  return typeof dateStr === 'string' && /T\d{2}:\d{2}/.test(dateStr);
}

function _formatDueDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  const now = new Date();
  const hasTime = _hasTimeComponent(dateStr);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((due - today) / 86400000);
  const timeStr = hasTime ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  if (hasTime && d < now) return 'overdue';
  if (!hasTime && diffDays < 0) return 'overdue';
  if (diffDays === 0) return hasTime ? timeStr : 'today';
  if (diffDays === 1) return hasTime ? `tmrw ${timeStr}` : 'tomorrow';
  const dateLabel = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return hasTime ? `${dateLabel} ${timeStr}` : dateLabel;
}

function _isDueOverdue(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  if (_hasTimeComponent(dateStr)) return d < new Date();
  return d < new Date(new Date().toDateString());
}

function _isDueTodayOrOverdue(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return due <= today;
}

function _isNoteFullyDone(note) {
  if (_hasItems(note) && Array.isArray(note.items) && note.items.length > 0) {
    return note.items.every(it => it.done);
  }
  return false;
}

// "清单笔记" — todo 或 goal — 有结构化的 items[]，卡片将其渲染为复选框，
// "完全完成"/进度逻辑从中读取。
function _hasItems(note) {
  return note && (note.note_type === 'todo' || note.note_type === 'goal');
}

// 目标清单的紧凑 " N/M" 进度字符串。当目标还没有步骤时为空
// （例如 AI 分解仍在进行中或已被取消）。
function _goalProgress(note) {
  if (!Array.isArray(note?.items) || note.items.length === 0) return '';
  const done = note.items.filter(it => it.done).length;
  return ` ${done}/${note.items.length}`;
}

// 目标中下一个未完成的步骤，如果全部完成/没有项目则返回 null。
function _nextGoalStep(note) {
  if (!Array.isArray(note?.items)) return null;
  for (let i = 0; i < note.items.length; i++) {
    if (!note.items[i].done) return { idx: i, item: note.items[i] };
  }
  return null;
}

// ---- 提醒预设 ----

function _laterTodayDate() {
  const now = new Date();
  const eight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0); // 今天下午 6 点
  // 如果距离下午 6 点不到 1 小时，则改为"3 小时后"
  if (eight - now < 60 * 60 * 1000) return new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return eight;
}
function _tomorrowDate() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(8, 0, 0, 0);
  return t;
}
function _nextWeekDate() {
  const t = new Date();
  const daysUntilMon = (8 - t.getDay()) % 7 || 7;
  t.setDate(t.getDate() + daysUntilMon);
  t.setHours(8, 0, 0, 0);
  return t;
}
function _toLocalDatetimeStr(d) {
  // 格式化为 YYYY-MM-DDTHH:MM（本地时间，不带时区）
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function _formatReminderTag(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  if (isTomorrow) return `Tomorrow, ${time}`;
  const dateLabel = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${dateLabel}, ${time}`;
}
// 为日期的第 n 个星期几构建人类可读标签，例如"第 2 个星期二"
const _ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];
const _DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function _nthWeekdayLabel(d) {
  const n = Math.ceil(d.getDate() / 7); // 1..5
  return `${_ORDINALS[n - 1] || `${n}th`} ${_DAYS[d.getDay()]}`;
}
function _isLastWeekdayOfMonth(d) {
  const test = new Date(d);
  test.setDate(d.getDate() + 7);
  return test.getMonth() !== d.getMonth();
}
// 在给定的年/月中查找 `weekday` 的第 N 次出现。n=1..5。
// 如果 n=5 且没有第 5 次出现，则返回第 4 次（这样"第 5 个星期一"仍然有效）。
function _nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  let day = 1 + offset + (n - 1) * 7;
  // 当月最后一天
  const lastDay = new Date(year, month + 1, 0).getDate();
  if (day > lastDay) day -= 7;
  return new Date(year, month, day, 0, 0, 0);
}
function _lastWeekdayOfMonth(year, month, weekday) {
  const lastDay = new Date(year, month + 1, 0);
  const back = (lastDay.getDay() - weekday + 7) % 7;
  return new Date(year, month, lastDay.getDate() - back, 0, 0, 0);
}

// Snap a chosen datetime forward to the next slot matching a normalized
// recurrence pattern (preserving time-of-day, strictly in the future).
// Anchors to the user's chosen date when it's in the future (so picking a
// recurrence on a far-future date doesn't drag it back to today); otherwise
// anchors to "now". Returns null for daily/yearly/none.
function _snapToRepeat(currentDate, normRepeat) {
  const hh = currentDate.getHours();
  const mm = currentDate.getMinutes();
  const now = Date.now();
  const anchor = currentDate.getTime() > now ? currentDate : new Date();
  const parts = normRepeat.split(':');
  const kind = parts[0];
  if (kind === 'weekly') {
    const targetWd = parseInt(parts[1], 10);
    if (isNaN(targetWd)) return null;
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), hh, mm, 0, 0);
    const delta = (targetWd - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + delta);
    if (d.getTime() <= now) d.setDate(d.getDate() + 7);
    return d;
  }
  if (kind === 'monthly') {
    const sub = parts[1];
    let y = anchor.getFullYear();
    let m = anchor.getMonth();
    // 向前最多查找 14 个月，找到下一个匹配的时间点。
    for (let tries = 0; tries < 14; tries++) {
      let target;
      if (sub === 'day') {
        const wantDay = parseInt(parts[2], 10);
        if (isNaN(wantDay)) return null;
        const lastDay = new Date(y, m + 1, 0).getDate();
        target = new Date(y, m, Math.min(wantDay, lastDay));
      } else if (sub === 'nth') {
        const n = parseInt(parts[2], 10);
        const wd = parseInt(parts[3], 10);
        if (isNaN(n) || isNaN(wd)) return null;
        target = _nthWeekdayOfMonth(y, m, wd, n);
      } else if (sub === 'last') {
        const wd = parseInt(parts[2], 10);
        if (isNaN(wd)) return null;
        target = _lastWeekdayOfMonth(y, m, wd);
      } else {
        return null;
      }
      target.setHours(hh, mm, 0, 0);
      if (target.getTime() > now && target.getTime() >= anchor.getTime()) return target;
      m++;
      if (m > 11) { m = 0; y++; }
    }
    return null;
  }
  return null;
}

// 将重复值渲染为人类可读的标签。
// originalDate 仅用于解析旧版裸值（"weekly"、"monthly" 等）。
// 所有调用处都传递了它；缺少它会导致静默错误解析旧版值。
function _formatRepeatLabel(repeat, originalDate) {
  if (!repeat || repeat === 'none') return '';
  const norm = _normalizeRepeat(repeat, originalDate);
  if (norm === 'daily') return 'Daily';
  if (norm === 'yearly') return 'Yearly';
  const parts = norm.split(':');
  if (parts[0] === 'weekly') {
    const wd = parseInt(parts[1], 10);
    if (isNaN(wd)) return 'Weekly';
    return `Weekly on ${_DAYS[wd]}s`;
  }
  if (parts[0] === 'monthly') {
    if (parts[1] === 'day') return `Monthly on day ${parts[2]}`;
    if (parts[1] === 'nth') {
      const n = parseInt(parts[2], 10);
      const wd = parseInt(parts[3], 10);
      return `Monthly on ${_ORDINALS[n - 1] || `${n}th`} ${_DAYS[wd]}`;
    }
    if (parts[1] === 'last') {
      const wd = parseInt(parts[2], 10);
      return `Monthly on last ${_DAYS[wd]}`;
    }
  }
  return norm;
}

// ---- 提醒 ----

function _loadFiredReminders() {
  try { return new Set(JSON.parse(localStorage.getItem(REMINDER_FIRED_KEY) || '[]')); }
  catch { return new Set(); }
}

function _saveFiredReminders(set) {
  try { localStorage.setItem(REMINDER_FIRED_KEY, JSON.stringify([...set])); }
  catch {}
}

async function _ensureNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { const p = await Notification.requestPermission(); return p === 'granted'; }
  catch { return false; }
}

// 重复格式：
//   无
//   每日
//   weekly:W              W = 0-6 (周日..周六)
//   monthly:day:D         D = 1-31 (日历日)
//   monthly:nth:N:W       N = 1-4 (第1..第4), W = 0-6 (星期几)
//   monthly:last:W        W = 0-6 (当月最后一个星期几)
//   每年
// 旧版 "weekly"、"monthly"、"monthly_nth_weekday"、"monthly_last_weekday"
// 使用原始 due_date 的星期几/Nth 进行标准化。
function _normalizeRepeat(repeat, originalDate) {
  if (!repeat || repeat === 'none') return 'none';
  if (repeat === 'daily' || repeat === 'yearly') return repeat;
  if (/^(weekly|monthly):/.test(repeat)) return repeat;
  // 旧版裸值 — 从原始日期推导参数
  const wd = originalDate.getDay();
  const n = Math.ceil(originalDate.getDate() / 7);
  if (repeat === 'weekly') return `weekly:${wd}`;
  if (repeat === 'monthly') return `monthly:day:${originalDate.getDate()}`;
  if (repeat === 'monthly_nth_weekday') return `monthly:nth:${n}:${wd}`;
  if (repeat === 'monthly_last_weekday') return `monthly:last:${wd}`;
  return repeat;
}

function _advanceRecurring(dateStr, repeat) {
  const orig = new Date(dateStr);
  const hh = orig.getHours();
  const mm = orig.getMinutes();
  let d = new Date(orig);
  const norm = _normalizeRepeat(repeat, orig);
  if (norm === 'none') return null;

  function step() {
    if (norm === 'daily') {
      d.setDate(d.getDate() + 1);
      return;
    }
    if (norm === 'yearly') {
      d.setFullYear(d.getFullYear() + 1);
      return;
    }
    const parts = norm.split(':');
    const kind = parts[0];
    if (kind === 'weekly') {
      // 对齐到未来 1-7 天内的目标星期几
      const targetWd = parseInt(parts[1], 10);
      let delta = (targetWd - d.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      d.setDate(d.getDate() + delta);
      d.setHours(hh, mm, 0, 0);
      return;
    }
    if (kind === 'monthly') {
      const sub = parts[1];
      const ny = d.getFullYear() + (d.getMonth() === 11 ? 1 : 0);
      const nm = (d.getMonth() + 1) % 12;
      let target;
      if (sub === 'day') {
        const wantDay = parseInt(parts[2], 10);
        const lastDay = new Date(ny, nm + 1, 0).getDate();
        target = new Date(ny, nm, Math.min(wantDay, lastDay));
      } else if (sub === 'nth') {
        const n = parseInt(parts[2], 10);
        const wd = parseInt(parts[3], 10);
        target = _nthWeekdayOfMonth(ny, nm, wd, n);
      } else if (sub === 'last') {
        const wd = parseInt(parts[2], 10);
        target = _lastWeekdayOfMonth(ny, nm, wd);
      } else {
        d = null; return;
      }
      target.setHours(hh, mm, 0, 0);
      d = target;
      return;
    }
    d = null;
  }

  step();
  if (d === null) return null;
  const now = Date.now();
  // 限制追赶以避免因格式错误/非常旧的日期而失控。
  let guard = 5000;
  while (d.getTime() <= now) {
    if (--guard <= 0) return null;
    step();
    if (d === null) return null;
  }
  return _toLocalDatetimeStr(d);
}

function _checkReminders() {
  if (!_notes.length) return;
  const now = Date.now();
  const fired = _loadFiredReminders();
  let changed = false;
  for (const note of _notes) {
    if (!note.due_date || note.archived) continue;
    if (!_hasTimeComponent(note.due_date)) continue;
    if (fired.has(note.id)) continue;
    const due = new Date(note.due_date).getTime();
    if (isNaN(due)) continue;
    if (due <= now && due > now - 60000) {
      _fireReminder(note);
      // 是重复提醒？推进 due_date 而不是标记为已触发
      if (note.repeat && note.repeat !== 'none') {
        const next = _advanceRecurring(note.due_date, note.repeat);
        if (next) {
          note.due_date = next;
          _patchNote(note.id, { due_date: next }).catch(() => {});
          // 不添加到已触发 — 新的 due_date 在未来
          continue;
        }
      }
      fired.add(note.id);
      changed = true;
    } else if (due <= now - 60000) {
      // 过去的、从未见过的 — 静默推进重复或标记为已触发
      if (note.repeat && note.repeat !== 'none') {
        const next = _advanceRecurring(note.due_date, note.repeat);
        if (next) {
          note.due_date = next;
          _patchNote(note.id, { due_date: next }).catch(() => {});
          continue;
        }
      }
      fired.add(note.id);
      changed = true;
    }
  }
  if (changed) _saveFiredReminders(fired);
  // 始终刷新徽章 — 已触发状态可能在视觉上发生了变化，但笔记未变更
  _updateRailBadge();
}

function _fireReminder(note) {
  const title = note.title || t('notes.note_reminder');
  // 包含笔记原文内容，使邮件/通知实际显示需要做什么，
  // 而不仅仅是计数。限制每项行数（最多 8 行）和总长度，
  // 使正文保持收件箱友好。
  let rawBody;
  if (_hasItems(note)) {
    const pending = (note.items || [])
      .filter(i => !i.done && !i.checked)
      .map(i => (i.text || '').trim())
      .filter(Boolean);
    if (pending.length) {
      const shown = pending.slice(0, 8).map(t => `- ${t}`).join('\n');
      const extra = pending.length > 8 ? `\n…and ${pending.length - 8} more` : '';
      rawBody = `Pending (${pending.length}):\n${shown}${extra}`;
    } else {
      rawBody = `${(note.items || []).length} item${(note.items || []).length === 1 ? '' : 's'}`;
    }
  } else {
    rawBody = (note.content || '').slice(0, 400);
  }

  // Ask the server to dispatch according to user settings. The server may
  // return an LLM-written synthesis line and/or send an email. We still show
  // a local browser notification so the user gets immediate feedback even if
  // the server path is disabled or slow.
  const showLocal = (body) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(title, { body, tag: 'note-' + note.id, icon: '/static/favicon.ico' });
        n.onclick = () => { window.focus(); openPanel(); n.close(); };
      } catch {}
    }
    if (uiModule?.showToast) uiModule.showToast(title);
  };

  // Fire-and-forget server dispatch. If synthesis comes back quickly enough,
  // use it as the notification body; otherwise the local notification has
  // already shown with the raw body.
  let shown = false;
  const timer = setTimeout(() => { if (!shown) { shown = true; showLocal(rawBody); } }, 1500);

  fetch('/api/notes/fire-reminder', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note_id: note.id, title, body: rawBody }),
  })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      clearTimeout(timer);
      if (shown) return;
      shown = true;
      const body = (data && data.synthesis) ? data.synthesis : rawBody;
      showLocal(body);
    })
    .catch(() => {
      clearTimeout(timer);
      if (!shown) { shown = true; showLocal(rawBody); }
    });

  // 如果卡片可见则闪烁它；否则排队，以便用户下次打开
  // 笔记面板时该卡片获得短暂发光效果。
  _setReminderCardGlow(note.id, true);
  const card = document.querySelector(`.note-card[data-note-id="${note.id}"]`);
  if (card) {
    card.classList.add('note-card-reminder-fired');
    setTimeout(() => card.classList.remove('note-card-reminder-fired'), 3000);
  } else {
    _queuePendingHighlight(note.id);
  }
}

function _startReminderLoop() {
  if (_reminderTimer) return;
  _reminderTimer = setInterval(_checkReminders, 30000);
  _checkReminders(); // 立即运行一次
}

function _countDueReminders() {
  return _notes.filter(n => !n.archived && _isDueTodayOrOverdue(n.due_date) && !_isNoteFullyDone(n)).length;
}

let _firedDotDismissedAt = (() => {
  try {
    const v = parseInt(localStorage.getItem(REMINDER_DISMISSED_AT_KEY) || '0', 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
})();

function _countFiredReminders() {
  // 时间实际已过去（不仅是日期为今天）且在上次用户关闭后
  // 触发的提醒。
  const now = Date.now();
  return _notes.filter(n => {
    if (n.archived || _isNoteFullyDone(n)) return false;
    if (!n.due_date || !_hasTimeComponent(n.due_date)) return false;
    const t = new Date(n.due_date).getTime();
    if (isNaN(t) || t > now) return false;
    return t > _firedDotDismissedAt;
  }).length;
}

export function dismissFiredReminderDot() {
  _firedDotDismissedAt = Date.now();
  try { localStorage.setItem(REMINDER_DISMISSED_AT_KEY, String(_firedDotDismissedAt)); } catch {}
  _updateRailBadge();
}

function _updateRailBadge() {
  const fired = _countFiredReminders();
  // 导航栏（迷你侧边栏）— 仅当提醒自上次关闭后
  // 实际触发时才显示计数（即用户尚未打开笔记）。
  // 一直显示每个过期笔记会让徽章像永久存在一样。
  const railBtn = document.getElementById('rail-notes');
  if (railBtn) {
    let badge = railBtn.querySelector('.rail-notes-badge');
    if (fired > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'rail-notes-badge';
        railBtn.appendChild(badge);
      }
      badge.textContent = fired > 99 ? '99+' : String(fired);
      badge.classList.add('fired');
    } else if (badge) {
      badge.remove();
    }
  }
  // 主侧边栏按钮
  const sidebarBtn = document.getElementById('tool-notes-btn');
  if (sidebarBtn) {
    let dot = sidebarBtn.querySelector('.tool-notes-dot');
    if (fired > 0) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'tool-notes-dot';
        sidebarBtn.appendChild(dot);
      }
    } else if (dot) {
      dot.remove();
    }
  }
  // 单独的笔记卡片 — 闪烁有已触发提醒的卡片
  document.querySelectorAll('.note-card').forEach(card => {
    const id = card.dataset.noteId;
    const note = _notes.find(n => n.id === id);
    if (!note || note.archived || _isNoteFullyDone(note)) {
      card.classList.remove('note-card-reminder-due');
      return;
    }
    if (note.due_date && _hasTimeComponent(note.due_date)) {
      const t = new Date(note.due_date).getTime();
      card.classList.toggle('note-card-reminder-due', !isNaN(t) && t <= Date.now());
    } else {
      card.classList.remove('note-card-reminder-due');
    }
  });
}

export async function refreshDueBadge(opts = {}) {
  // 通常是轻量级操作，但刚创建了笔记提醒的调用方可以
  // 强制刷新，使后台提醒循环立即看到它。
  if (opts.force || _notes.length === 0) {
    try {
      const wasArchived = _showingArchived;
      _showingArchived = false;
      await _fetchNotes();
      _showingArchived = wasArchived;
    } catch {}
  }
  _updateRailBadge();
}

// ---- 面板 ----

export function openPanel() {
  if (_open) return;
  _open = true;
  _editingId = null;
  // Reset the search filter — the rebuilt pane's search input renders empty, so a
  // stale _searchQuery would silently hide non-matching notes after a reopen.
  _searchQuery = '';
  _clearViewedReminderGlows();
  _firedDotDismissedAt = Date.now();
  try { localStorage.setItem(REMINDER_DISMISSED_AT_KEY, String(_firedDotDismissedAt)); } catch {}

  const container = document.getElementById('chat-container');
  if (!container) return;

  document.body.classList.add('notes-view');

  // 在移动端，笔记面板占满整个屏幕 — 自动关闭侧边栏，
  // 避免面板被遮挡在下方。
  if (window.innerWidth <= 768) {
    const sb = document.getElementById('sidebar');
    if (sb) sb.classList.add('hidden');
    document.body.classList.add('sidebar-collapsed');
  }
  // 移动端模式：卡片变为只读预览（不显示内联复选框/
  // 编辑/归档等操作），点击打开全屏编辑覆盖层，
  // 长按进入拖拽重新排序模式。参见 _bindCardEvents +
  // .notes-mobile-mode CSS 规则。
  if (_isNotesMobileMode()) document.body.classList.add('notes-mobile-mode');

  // 切换按钮状态
  const btn = document.getElementById('tool-notes-btn');
  if (btn) btn.classList.add('active');

  // 创建面板
  const pane = document.createElement('div');
  pane.id = 'notes-pane';
  pane.className = 'notes-pane';
  pane.innerHTML = `
    <div class="notes-mobile-grabber" id="notes-mobile-grabber" aria-hidden="true"></div>
    <div class="notes-pane-header">
      <h4 class="notes-pane-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2.5px;margin-right:6px"><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5"/><path d="M8 17.5 15.5 10l2.5 2.5L10.5 20H8z"/></svg>${t('notes.title')}</h4>
      <span style="flex:1"></span>
      <button id="notes-archive-toggle" class="doc-action-icon-btn notes-header-text-btn" title="${t('notes.view_archive')}" style="opacity:0.8;gap:5px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8"/><path d="M10 12h4"/></svg>
        <span class="notes-header-btn-label">${t('common.archive')}</span>
      </button>
      <button id="notes-view-toggle" class="doc-action-icon-btn notes-header-text-btn" title="${t('notes.toggle_view')}" style="opacity:0.8;gap:5px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        <span class="notes-header-btn-label">${t('notes.toggle_view')}</span>
      </button>
      <button id="notes-minimize-btn" class="modal-minimize-btn" title="${t('notes.minimize')}" aria-label="${t('notes.minimize_notes')}" style="position:relative;left:2px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="18" x2="18" y2="18"/></svg></button>
    </div>
    <div class="notes-search-bar">
      <input type="text" id="notes-search" class="memory-search-input" placeholder="${t('notes.search_placeholder')}" autocomplete="off" />
      <button id="notes-select-btn" class="notes-select-trigger" type="button">${t('notes.select')}</button>
    </div>
    <div id="notes-bulk-bar" class="memory-bulk-bar hidden">
      <label class="memory-bulk-check-all"><input type="checkbox" id="notes-select-all" /> ${t('notes.all')}</label>
      <span id="notes-selected-count">${t('notes.selected_count', { count: 0 })}</span>
      <span style="flex:1"></span>
      <button id="notes-bulk-archive" class="memory-toolbar-btn" disabled>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8"/><path d="M10 12h4"/></svg>${t('notes.bulk_archive')}
      </button>
      <button id="notes-bulk-delete" class="memory-toolbar-btn danger" disabled>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>${t('common.delete')}
      </button>
    </div>
    <div class="notes-pane-body"></div>
  `;

  // 在移动端以全屏底部面板（滑入）打开，而非桌面
  // 侧边面板。以内联样式设置，使其能覆盖基本 .notes-pane 规则，无论
  // 级联细节如何（CSS @media 覆盖未能可靠应用，
  // 导致它作为侧边面板挤压聊天区域）。
  if (window.innerWidth <= 768) {
    pane.style.position = 'fixed';
    pane.style.inset = '0';
    pane.style.width = '100%';
    pane.style.maxWidth = '100%';
    pane.style.zIndex = '170';
    pane.style.borderRadius = '14px 14px 0 0';
    pane.style.animation = 'sheet-enter 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) both';
    pane.style.transformOrigin = 'bottom center';
  }

  // 挂载到 body 上，使 Notes 可以像其他可拖动窗口一样行为。
  // 在桌面端，它立即通过 _restoreNotesSidebarDock 停靠到右侧。
  const backdrop = document.createElement('div');
  backdrop.className = 'notes-pane-backdrop';
  backdrop.id = 'notes-pane-backdrop';
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) closePanel('down');
  });
  backdrop.appendChild(pane);
  document.body.appendChild(backdrop);
  _wireNotesWindow(pane);
  _restoreNotesSidebarDock(pane);

  // 事件
  // （关闭箭头已移除 — 移动端下滑关闭，桌面端通过工具导航栏切换。）

  // 移动端：向下滑动抓取器/标题来关闭（最小化为标签）。
  // 与文档面板手势一致 — 手指跟随、基于速度的
  // 关闭、上拉橡皮筋效果、弹簧弹回。
  _wireNotesSwipeDismiss(pane.querySelector('.notes-mobile-grabber'), pane);
  _wireNotesSwipeDismiss(pane.querySelector('.notes-pane-header'), pane);

  const minBtn = document.getElementById('notes-minimize-btn');
  if (minBtn) minBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closePanel('down');
  });
  // 搜索
  const searchEl = document.getElementById('notes-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      _searchQuery = searchEl.value.trim().toLowerCase();
      _renderNotes();
    });
  }

  // 视图切换
  const archiveBtn = document.getElementById('notes-archive-toggle');
  if (archiveBtn) {
    const ARCHIVE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8"/><path d="M10 12h4"/></svg><span class="notes-header-btn-label">' + t('common.archive') + '</span>';
    const CLOSE_ICON   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg><span class="notes-header-btn-label">' + t('common.archive') + '</span>';
    const syncArchiveBtn = () => {
      archiveBtn.classList.toggle('active', _showingArchived);
      archiveBtn.title = _showingArchived ? t('notes.exit_archive') : t('notes.view_archive');
      archiveBtn.style.opacity = _showingArchived ? '1' : '0.8';
      // 在归档视图中切换为 X，使其兼作返回活跃
      // 笔记的切换按钮。
      archiveBtn.innerHTML = _showingArchived ? CLOSE_ICON : ARCHIVE_ICON;
      // 给整个面板上色，让用户明显感知不在活跃列表中。
      pane.classList.toggle('notes-pane-archive', _showingArchived);
    };
    syncArchiveBtn();
    archiveBtn.addEventListener('click', async () => {
      _showingArchived = !_showingArchived;
      _selectedIds.clear();
      syncArchiveBtn();
      // 短暂淡入淡出，使正文内容切换不会跳跃 — 背景色调变更
      // 已经通过 .notes-pane* 上的 CSS 过渡进行了缓和。
      const _bodyEl = document.querySelector('#notes-pane .notes-pane-body');
      if (_bodyEl) {
        _bodyEl.style.transition = 'opacity 0.18s ease';
        _bodyEl.style.opacity = '0.25';
      }
      await _fetchNotes();
      _renderNotes();
      if (_bodyEl) {
        requestAnimationFrame(() => {
          _bodyEl.style.opacity = '';
          _bodyEl.addEventListener('transitionend', () => { _bodyEl.style.transition = ''; }, { once: true });
        });
      }
    });
  }
  const viewBtn = document.getElementById('notes-view-toggle');
  if (viewBtn) {
    pane.classList.toggle('notes-view-grid', _viewMode === 'grid');
    // 标签显示你将切换到什么 — 列表视图时显示"Grid"，网格视图时显示"List"。
    const _setViewLabel = () => {
      const lbl = viewBtn.querySelector('.notes-header-btn-label');
      if (lbl) lbl.textContent = _viewMode === 'grid' ? t('notes.label_all') : t('notes.toggle_view');
    };
    _setViewLabel();
    requestAnimationFrame(() => _applyMasonry(document.querySelector('#notes-pane .notes-pane-body')));
    viewBtn.addEventListener('click', () => {
      _viewMode = _viewMode === 'grid' ? 'list' : 'grid';
      try { localStorage.setItem('odysseus-notes-view', _viewMode); } catch {}
      pane.classList.toggle('notes-view-grid', _viewMode === 'grid');
      _setViewLabel();
      requestAnimationFrame(() => _applyMasonry(document.querySelector('#notes-pane .notes-pane-body')));
    });
  }
  // 选择模式
  document.getElementById('notes-select-btn').addEventListener('click', () => {
    if (_selectMode) _exitSelectMode(); else _enterSelectMode();
  });
  // Esc 取消选择模式。Notes 使用切换"Select"按钮而非
  // *-bulk-cancel 按钮，因此 keyboard-shortcuts.js 中的全局 Esc 取消处理器
  // 无法覆盖它 — 在此处理。捕获阶段
  // + stopPropagation，使 Esc 取消选择而不是关闭面板。
  if (_notesSelectEscHandler) {
    document.removeEventListener('keydown', _notesSelectEscHandler, true);
  }
  _notesSelectEscHandler = (e) => {
    if (e.key === 'Escape' && _selectMode) {
      e.preventDefault();
      e.stopPropagation();
      _exitSelectMode();
    }
  };
  document.addEventListener('keydown', _notesSelectEscHandler, true);
  document.getElementById('notes-select-all').addEventListener('change', (e) => {
    if (e.target.checked) _notes.forEach(n => _selectedIds.add(n.id));
    else _selectedIds.clear();
    _renderNotes();
    _updateBulkBar();
  });
  document.getElementById('notes-bulk-archive').addEventListener('click', async () => {
    const ids = [..._selectedIds];
    if (!ids.length) return;
    await Promise.all(ids.map(id => _patchNote(id, { archived: true }).catch(() => {})));
    _exitSelectMode();
    await _fetchNotes();
    _renderNotes();
    uiModule.showToast(t('notes.archived_toast') + ' ' + ids.length);
  });
  document.getElementById('notes-bulk-delete').addEventListener('click', async () => {
    const ids = [..._selectedIds];
    if (!ids.length) return;
    if (uiModule && uiModule.styledConfirm) {
      const ok = await uiModule.styledConfirm(t('notes.delete_note_confirm', { n: ids.length }), { confirmText: t('common.delete'), danger: true });
      if (!ok) return;
    }
    await Promise.all(ids.map(id => _deleteNoteApi(id).catch(() => {})));
    _exitSelectMode();
    await _fetchNotes();
    _renderNotes();
    uiModule.showToast(t('notes.deleted_toast') + ' ' + ids.length);
  });
  // Escape: exit select mode first (if active), otherwise close the panel.
  // Skip when the user is editing a form field — those have their own
  // ESC-to-cancel handlers and we don't want to nuke the whole panel
  // mid-edit.
  // Idempotent: remove any previous handler from a prior openPanel so
  // re-opening doesn't stack multiple handlers.
  if (_notesKeydownHandler) {
    document.removeEventListener('keydown', _notesKeydownHandler);
    _notesKeydownHandler = null;
  }
  _notesKeydownHandler = (e) => {
    if (!_open) return;
    const t = e.target;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    // 在面板任意位置按 Ctrl/Cmd+Z — 撤销上一步笔记操作。
    // 在输入框中打字时跳过，让浏览器正常的文本撤销仍然有效。
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      if (inField) return;
      if (_undoStack.length === 0) return;
      e.preventDefault();
      _popAndRunUndo();
      return;
    }
    // 鼠标悬停在笔记卡片上时按 Ctrl/Cmd+C → 复制该笔记。
    // 当用户正在编辑或有活动的文本选择时跳过
    // （让浏览器处理真正的文本复制）。
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && !e.shiftKey && !e.altKey) {
      if (inField) return;
      const sel = window.getSelection?.();
      if (sel && sel.toString && sel.toString().length > 0) return;
      const hovered = document.querySelector('.note-card:hover');
      if (!hovered) return;
      const id = hovered.dataset.noteId;
      if (!id) return;
      e.preventDefault();
      // 闪烁 ⋯ 菜单按钮（复制功能现在在该菜单中）。
      const btn = hovered.querySelector('.note-card-corner-menu');
      _copyNote(id, btn);
      return;
    }
    if (e.key !== 'Escape') return;
    if (inField) return;
    if (_selectMode) { _exitSelectMode(); return; }
    if (_showingArchived) {
      // 镜像归档切换按钮：翻回活跃笔记。
      document.getElementById('notes-archive-toggle')?.click();
      return;
    }
    _forceCloseNotesPanel();
  };
  document.addEventListener('keydown', _notesKeydownHandler);

  // 加载 — 先显示骨架屏，然后获取数据
  _renderLoadingSkeleton();
  // 将高亮刷新延迟到下一帧，使其在卡片已提交到 DOM
  // （且所有 FLIP 动画已稳定）之后运行，
  // 让内部的 querySelector 查找能找到目标。
  _fetchNotes().then(() => {
    _renderNotes();
    requestAnimationFrame(() => _flushPendingHighlights());
    _startReminderLoop();
    _showNotesFirstOpenHint(pane);
  });
}

function _renderLoadingSkeleton() {
  const body = document.querySelector('#notes-pane .notes-pane-body');
  if (!body) return;
  body.innerHTML = '';
  _renderLabelsInto(body);
  _renderQuickAdd(body);
  const skel = document.createElement('div');
  skel.className = 'notes-skeleton';
  skel.innerHTML = `
    <div class="notes-skeleton-card"></div>
    <div class="notes-skeleton-card"></div>
    <div class="notes-skeleton-card short"></div>
    <div class="notes-skeleton-card"></div>
  `;
  body.appendChild(skel);
}

function _enterSelectMode() {
  _selectMode = true;
  _selectedIds.clear();
  const bar = document.getElementById('notes-bulk-bar');
  const btn = document.getElementById('notes-select-btn');
  if (bar) bar.classList.remove('hidden');
  if (btn) { btn.classList.add('active'); btn.textContent = t('common.cancel'); }
  _renderNotes();
  _updateBulkBar();
}

function _exitSelectMode() {
  _selectMode = false;
  _selectedIds.clear();
  const bar = document.getElementById('notes-bulk-bar');
  const btn = document.getElementById('notes-select-btn');
  const all = document.getElementById('notes-select-all');
  if (bar) bar.classList.add('hidden');
  if (btn) { btn.classList.remove('active'); btn.textContent = t('notes.select'); }
  if (all) all.checked = false;
  _renderNotes();
}

function _updateBulkBar() {
  const count = _selectedIds.size;
  const countEl = document.getElementById('notes-selected-count');
  const archiveBtn = document.getElementById('notes-bulk-archive');
  const deleteBtn = document.getElementById('notes-bulk-delete');
  const allEl = document.getElementById('notes-select-all');
  if (countEl) countEl.textContent = t('notes.selected_count', { count: count });
  if (archiveBtn) archiveBtn.disabled = count === 0;
  if (deleteBtn) deleteBtn.disabled = count === 0;
  if (allEl) allEl.checked = _notes.length > 0 && _notes.every(n => _selectedIds.has(n.id));
  // 切换选择模式样式类，使待办圆点在悬停时不响应
  const pane = document.getElementById('notes-pane');
  if (pane) pane.classList.toggle('notes-select-mode', count > 0);
}

// 笔记的标签字段可能包含多个空格分隔的标签。拆分并去重。
function _noteTags(n) {
  const tags = [];
  if (n?.label) tags.push(...n.label.trim().split(/\s+/).filter(Boolean));
  if (n?.due_date && _hasTimeComponent(n.due_date)) tags.push('reminder');
  return [...new Set(tags.map(t => t.replace(/^#+/, '').trim()).filter(Boolean))];
}

function _visibleNoteTags(n) {
  return _noteTags(n).filter(t => t !== 'reminder');
}

function _isPastReminder(n) {
  if (!n?.due_date || !_hasTimeComponent(n.due_date)) return false;
  const due = new Date(n.due_date).getTime();
  return !isNaN(due) && due <= Date.now();
}

async function _clearPastReminders() {
  const targets = _notes.filter(n => !n.archived && _isPastReminder(n));
  if (!targets.length) {
    uiModule.showToast?.(t('notes.no_past_reminders'));
    return;
  }
  const ok = uiModule?.styledConfirm
    ? await uiModule.styledConfirm(t('notes.delete_reminders_confirm', { n: targets.length }), { confirmText: t('common.delete'), danger: true })
    : confirm(t('notes.delete_reminders_confirm', { n: targets.length }));
  if (!ok) return;
  await Promise.all(targets.map(n => _deleteNoteApi(n.id).catch(() => {})));
  await _fetchNotes();
  _renderNotes();
  uiModule.showToast?.(t('notes.cleared_reminders', { n: targets.length }));
}

function _renderLabels(root = document) {
  const bar = root.querySelector?.('.notes-labels-bar') || document.querySelector('.notes-labels-bar');
  if (!bar) return;
  const labels = new Set();
  for (const n of _notes) for (const t of _visibleNoteTags(n)) labels.add(t);
  const sortedLabels = [...labels].sort();
  // 统计活跃提醒数量（未归档、带有日期时间的 due_date）
  const reminderCount = _notes.filter(n => !n.archived && n.due_date && _hasTimeComponent(n.due_date)).length;
  const pastReminderCount = _notes.filter(n => !n.archived && _isPastReminder(n)).length;
  const defaultCount = _notes.filter(n => !n.archived && _visibleNoteTags(n).length === 0).length;
  // 活跃目标 = 未归档的目标笔记。今日视图列出每个目标的待处理步骤，
  // 因此我们在标签旁显示数量。
  const goalCount = _notes.filter(n => n.note_type === 'goal' && !n.archived).length;
  const todayCount = _notes.filter(n => n.note_type === 'goal' && !n.archived && _nextGoalStep(n)).length;
  bar.style.display = '';
  const allActive = _activeLabel === null && _activeFilter === null;
  let html = `<button class="notes-label-chip${allActive ? ' active' : ''}" data-action="all">${t('notes.label_all')}</button>`;
  html += `<button class="notes-label-chip${_activeFilter === 'default' ? ' active' : ''}" data-action="default" title="${t('notes.label_default_title')}">${t('notes.label_default')} <span class="notes-label-chip-count">${defaultCount}</span></button>`;
  if (todayCount > 0) {
    const isOn = _activeFilter === 'today';
    const icon = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
    html += `<button class="notes-label-chip notes-label-chip-today${isOn ? ' active' : ''}" data-action="today" title="${t('notes.label_today_title')}">${icon}${t('notes.label_today')} <span class="notes-label-chip-count">${todayCount}</span></button>`;
  }
  if (goalCount > 0) {
    const isOn = _activeFilter === 'goals';
    const icon = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:2px"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg>';
    html += `<button class="notes-label-chip notes-label-chip-goals${isOn ? ' active' : ''}" data-action="goals" title="${t('notes.label_goals_title')}">${icon}${t('notes.label_goals')} <span class="notes-label-chip-count">${goalCount}</span></button>`;
  }
  const isReminderOn = _activeFilter === 'reminders';
  const isReminderOff = _activeFilter === 'no-reminders';
  const reminderCls = `notes-label-chip notes-label-chip-reminders${isReminderOn ? ' active' : ''}${isReminderOff ? ' active negated' : ''}`;
  const reminderIcon = isReminderOff
    // 铃铛关闭图标
    ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
    : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  html += `<button class="${reminderCls}" data-action="reminders" title="${isReminderOn ? t('notes.label_reminders_title_on') : isReminderOff ? t('notes.label_reminders_title_off') : t('notes.label_reminders_title_default')}">${reminderIcon}${t('notes.label_reminders')} <span class="notes-label-chip-count">${reminderCount}</span></button>`;
  const showingReminders = _activeFilter === 'reminders';
  if (showingReminders && pastReminderCount > 0) {
    html += `<button class="notes-label-chip notes-label-clear-past" data-action="clear-past-reminders" title="${t('notes.label_clear_past_title')}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>${t('notes.clear_past')} <span class="notes-label-chip-count">${pastReminderCount}</span></button>`;
  }
  for (const lbl of sortedLabels) {
    html += `<button class="notes-label-chip${_activeLabel === lbl ? ' active' : ''}" data-label="${_esc(lbl)}">#${_esc(lbl)}</button>`;
  }
  bar.innerHTML = html;
  bar.querySelectorAll('.notes-label-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (chip.dataset.action === 'all') {
        _activeLabel = null;
        _activeFilter = null;
      } else if (chip.dataset.action === 'today') {
        _activeLabel = null;
        _activeFilter = (_activeFilter === 'today') ? null : 'today';
      } else if (chip.dataset.action === 'goals') {
        _activeLabel = null;
        _activeFilter = (_activeFilter === 'goals') ? null : 'goals';
      } else if (chip.dataset.action === 'default') {
        _activeLabel = null;
        _activeFilter = (_activeFilter === 'default') ? null : 'default';
      } else if (chip.dataset.action === 'reminders') {
        _activeLabel = null;
        // 循环切换：null → reminders → null → no-reminders → null → reminders → ...
        if (_activeFilter === null) {
          _activeFilter = _reminderChipNext;
          _reminderChipNext = (_reminderChipNext === 'reminders') ? 'no-reminders' : 'reminders';
        } else {
          _activeFilter = null;
        }
      } else if (chip.dataset.action === 'clear-past-reminders') {
        _clearPastReminders();
        return;
      } else {
        _activeFilter = null;
        _activeLabel = chip.dataset.label || null;
      }
      _renderNotes();
    });
  });
}

function _renderLabelsInto(_body) {
  if (!_body) return;
  let bar = _body.querySelector(':scope > .notes-labels-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'notes-labels-bar';
    _body.appendChild(bar);
  }
  _renderLabels(_body);
}

function _ensureNotesChipRegistered() {
  if (Modals.isRegistered('notes-panel')) return;
  Modals.register('notes-panel', {
    railBtnId: 'rail-notes',
    sidebarBtnId: 'tool-notes-btn',
    restoreFn: () => { openPanel(); },
    closeFn: () => { _forceCloseNotesPanel(); },
  });
}

// `direction === 'down'`（移动端向下滑动）将面板最小化为
// 停靠标签，而不是完全关闭 — 点击标签可重新打开。
// 其他任何调用（关闭按钮、程序化关闭）均为完全关闭。
export function closePanel(direction) {
  if (!_open) return;
  _open = false;
  _editingId = null;
  _clearViewedReminderGlows();
  const _minimize = direction === 'down';
  if (_minimize) {
    _ensureNotesChipRegistered();
  } else if (Modals.isRegistered('notes-panel')) {
    Modals.unregister('notes-panel');
  }

  // 移除 document keydown 监听器和 30 秒提醒定时器 —
  // 这两个在 v2 审查期间会在打开/关闭周期中泄漏。
  if (_notesKeydownHandler) {
    document.removeEventListener('keydown', _notesKeydownHandler);
    _notesKeydownHandler = null;
  }
  if (_notesSelectEscHandler) {
    document.removeEventListener('keydown', _notesSelectEscHandler, true);
    _notesSelectEscHandler = null;
  }
  if (_reminderTimer) {
    clearInterval(_reminderTimer);
    _reminderTimer = null;
  }

  document.body.classList.remove('notes-view');
  document.body.classList.remove('notes-mobile-mode');
  document.body.classList.remove('notes-drag-mode');
  // 关闭面板时应保留正在进行的编辑，而不是丢弃它们。
  // 提交任何打开的就地编辑器，并以 save=true 关闭移动端全屏
  // 覆盖层，使笔记被持久化。
  try { _commitOpenInPlaceEditor(); } catch {}
  _closeMobileFullscreenEdit({ save: true });
  // /notes 路由可能已将宽侧边栏折叠为导轨；恢复它。
  try { window._restoreSidebarIfRouteCollapsed?.(); } catch (_) {}

  const btn = document.getElementById('tool-notes-btn');
  if (btn) btn.classList.remove('active');

  const pane = document.getElementById('notes-pane');
  const backdrop = document.getElementById('notes-pane-backdrop');
  if (pane) {
    // 缩放缩小 + 淡出。匹配进入动画的时长，使关闭感觉
    // 像是同一个手势反向播放。
    pane.classList.add('notes-pane-leaving');
    const _cleanup = () => {
      try { pane.remove(); } catch {}
      try { backdrop?.remove(); } catch {}
    };
    pane.addEventListener('animationend', _cleanup, { once: true });
    // 双重保险：如果动画被跳过（减少动画 / 分离的标签页），
    // 监听器不会触发；在预期时长后移除。
    setTimeout(_cleanup, 220);
  } else if (backdrop) {
    backdrop.remove();
  }
  // 对于下滑最小化显示停靠标签（点击即可重新打开）。
  if (_minimize) { try { Modals.minimize('notes-panel'); } catch {} }
}

export function togglePanel() {
  if (_open) closePanel();
  else openPanel();
}

export function isPanelOpen() { return _open; }

// ---- 渲染 ----

// FLIP 动画 — 渲染前捕获位置，渲染后动画回原位
function _captureCardPositions() {
  const body = document.querySelector('#notes-pane .notes-pane-body');
  if (!body) return null;
  const positions = new Map();
  body.querySelectorAll('.note-card').forEach(card => {
    const id = card.dataset.noteId;
    if (id) positions.set(id, card.getBoundingClientRect());
  });
  return positions;
}

function _animateReflow(prevPositions) {
  if (!prevPositions || !prevPositions.size) return;
  const body = document.querySelector('#notes-pane .notes-pane-body');
  if (!body) return;
  body.querySelectorAll('.note-card').forEach(card => {
    const id = card.dataset.noteId;
    const prev = prevPositions.get(id);
    if (!prev) return;
    const next = card.getBoundingClientRect();
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    // 反转：跳回旧位置
    card.style.transition = 'none';
    card.style.transform = `translate(${dx}px, ${dy}px)`;
    // 播放：动画到 0
    requestAnimationFrame(() => {
      card.style.transition = 'transform 0.25s cubic-bezier(0.34, 1.2, 0.64, 1)';
      card.style.transform = '';
      card.addEventListener('transitionend', () => {
        card.style.transition = '';
      }, { once: true });
    });
  });
}

function _renderNotes() {
  _updateRailBadge();
  const body = document.querySelector('#notes-pane .notes-pane-body');
  if (!body) return;
  const prevPositions = _captureCardPositions();
  const activeReminderHighlights = _loadActiveHighlights();

  let filtered = _activeLabel ? _notes.filter(n => _noteTags(n).includes(_activeLabel)) : _notes;
  if (_activeFilter === 'reminders') {
    filtered = filtered.filter(n => n.due_date && _hasTimeComponent(n.due_date));
  } else if (_activeFilter === 'no-reminders') {
    filtered = filtered.filter(n => !(n.due_date && _hasTimeComponent(n.due_date)));
  } else if (_activeFilter === 'default') {
    filtered = filtered.filter(n => _visibleNoteTags(n).length === 0);
  } else if (_activeFilter === 'goals') {
    filtered = filtered.filter(n => n.note_type === 'goal' && !n.archived);
  } else if (_activeFilter === 'today') {
    // Today 视图：仅包含仍有未完成步骤的目标。
    filtered = filtered.filter(n => n.note_type === 'goal' && !n.archived && _nextGoalStep(n));
  }
  if (_searchQuery) {
    filtered = filtered.filter(n => {
      const q = _searchQuery;
      if ((n.title || '').toLowerCase().includes(q)) return true;
      if ((n.content || '').toLowerCase().includes(q)) return true;
      if ((n.label || '').toLowerCase().includes(q)) return true;
      if (Array.isArray(n.items) && n.items.some(it => (it.text || '').toLowerCase().includes(q))) return true;
      return false;
    });
  }
  const sorted = [...filtered].sort((a, b) => {
    // 提醒视图：按截止日期升序排列（最早在前）
    if (_activeFilter === 'reminders') {
      const da = new Date(a.due_date || 0).getTime();
      const db = new Date(b.due_date || 0).getTime();
      return da - db;
    }
    // 归档视图：最新的归档在前（忽略手动 sort_order）。
    if (_showingArchived) {
      return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
    }
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    // 活跃提醒（截止日期在过去，未完成/未归档）排序
    // 紧接在固定块下方。
    const aActive = _hasActiveReminder(a);
    const bActive = _hasActiveReminder(b);
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    const so = (a.sort_order || 0) - (b.sort_order || 0);
    if (so !== 0) return so;
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  });

  let html = '';
  // Today 视图：渲染紧凑卡片，列出每个活跃目标的
  // 下一个未完成步骤。点击步骤切换完成状态
  // （与常规复选框相同的基于 idx 的连接）。点击标题打开目标笔记进行完整
  // 编辑。
  if (_activeFilter === 'today') {
    body.innerHTML = '';
    _renderLabelsInto(body);
    _renderQuickAdd(body);
    if (sorted.length === 0) {
      body.insertAdjacentHTML('beforeend', `<div class="notes-empty">${t('notes.empty_all_caught_up')}</div>`);
    } else {
      let todayHtml = `<div class="notes-today-wrap">
        <div class="notes-today-header">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <span>${t('notes.today_header')}</span>
        </div>
        <div class="notes-today-list">`;
      for (const note of sorted) {
        const next = _nextGoalStep(note);
        if (!next) continue;
        const progress = _goalProgress(note).trim();
        todayHtml += `<div class="notes-today-row" data-note-id="${note.id}">
          <span class="note-check-dot" data-note-id="${note.id}" data-idx="${next.idx}" title="${t('notes.mark_step_done')}"></span>
          <div class="notes-today-text">
            <div class="notes-today-title" data-action="edit" data-note-id="${note.id}">${_esc(note.title || t('notes.untitled_goal'))}</div>
            <div class="notes-today-step">${_linkify(next.item.text || '')}</div>
          </div>
          <span class="notes-today-progress">${_esc(progress)}</span>
        </div>`;
      }
      todayHtml += `</div></div>`;
      body.insertAdjacentHTML('beforeend', todayHtml);
    }
    _wireTodayView(body);
    return;
  }
  for (const note of sorted) {
    if (_editingId === note.id) continue; // 跳过 — 改为显示表单
    const borderColor = COLOR_HEX[note.color || ''] || 'var(--border)';
    const dueFmt = _formatDueDate(note.due_date);
    const overdue = _isDueOverdue(note.due_date);

    let contentHtml = '';
    if (_hasItems(note) && Array.isArray(note.items)) {
      // Goal 笔记可以在步骤列表上方带有自由格式的描述 —
      // todos 很少这样做，但相同的渲染对两者都有效。
      if (note.note_type === 'goal' && (note.content || '').trim()) {
        const fullText = note.content || '';
        const preview = fullText.length > 300 ? fullText.slice(0, 300) + '…' : fullText;
        contentHtml += `<div class="note-goal-desc">${_esc(preview)}</div>`;
      }
      contentHtml += '<div class="note-checklist-preview">';
      // 显示所有项目 — 预览容器可滚动（CSS 限制了
      // 其 max-height + overflow-y:auto），因此无需截断。
      for (let i = 0; i < note.items.length; i++) {
        const item = note.items[i];
        const doneClass = item.done ? ' done' : '';
        const indent = Math.min(item.indent || 0, 3);
        contentHtml += `<div class="note-checkbox${doneClass}" data-note-id="${note.id}" data-idx="${i}" style="padding-left:${indent * 16}px">
          <span class="note-check-dot" title="${t('notes.mark_done')}"></span>
          <span class="note-check-text">${_linkify(item.text)}</span>
          <button class="note-checkbox-rm" data-note-id="${note.id}" data-idx="${i}" title="${t('notes.delete_item')}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>`;
      }
      contentHtml += '</div>';
    } else {
      const fullText = note.content || '';
      const preview = fullText.length > 600 ? fullText.slice(0, 600) + '…' : fullText;
      // _linkify 已在内部调用 _esc，因此 URL 会变成可点击的
      // 锚点（例如用于"提醒我回复"邮件深层链接）。
      contentHtml = preview ? `<div class="note-content-preview">${_linkify(preview)}</div>` : '';
    }

    const isBg = _isBgImage(note.color);
    const cc = (note.color && !isBg) ? ' note-color-' + note.color : '';
    const cardStyle = isBg ? ` style="${_customColorStyle(note.color)}"` : '';
    const sel = _selectedIds.has(note.id) ? ' note-card-selected' : '';
    const reminderTagHtml = note.due_date && _hasTimeComponent(note.due_date)
      ? `<div class="note-card-reminder${overdue ? ' overdue' : ''}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          <span>${_esc(_formatReminderTag(note.due_date))}${note.repeat && note.repeat !== 'none' ? ' · ' + _esc(_formatRepeatLabel(note.repeat, new Date(note.due_date))) : ''}</span>
        </div>`
      : '';
    const noteTags = _visibleNoteTags(note);
    const dueBadge = dueFmt && !_hasTimeComponent(note.due_date) ? `<span class="note-due-inline${overdue ? ' note-due-overdue' : ''}">${dueFmt}</span>` : '';
    const colorDots = COLORS.map(c => `<span class="note-card-color-dot${_dotIsActive(c.value, note.color) ? ' active' : ''}" data-color="${c.value}" style="background:${_dotBg(c.value, note.color)}" title="${c.name || 'default'}"></span>`).join('');
    const goalClass = note.note_type === 'goal' ? ' note-card-goal' : '';
    const reminderGlowClass = activeReminderHighlights.has(note.id) && _hasActiveReminder(note) ? ' note-card-reminder-fired-sticky' : '';
    const goalPill = note.note_type === 'goal'
      ? `<span class="note-goal-pill" title="AI-broken-down goal">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg>
          Goal${_goalProgress(note)}
        </span>`
      : '';
    html += `<div class="note-card${note.pinned ? ' note-card-pinned' : ''}${cc}${sel}${goalClass}${reminderGlowClass}${_selectMode ? ' note-card-selectmode' : ''}" draggable="${(_selectMode || _isNotesMobileMode()) ? 'false' : 'true'}" data-note-id="${note.id}"${cardStyle}>
      ${_selectMode ? `<input type="checkbox" class="memory-select-cb note-card-cb" data-note-id="${note.id}" ${_selectedIds.has(note.id) ? 'checked' : ''} />` : ''}
      ${goalPill}
      <button class="note-card-pin${note.pinned ? ' active' : ''}" data-note-id="${note.id}" title="${note.pinned ? t('notes.unpin') : t('notes.pin')}">
        <svg width="16" height="16" viewBox="0 0 24 28" fill="${note.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${note.pinned ? ' style="color:var(--accent,var(--red));"' : ''}><g transform="rotate(${note.pinned ? 0 : 45} 12 14)" style="transition:transform 0.2s ease;"><line x1="12" y1="17" x2="12" y2="27"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17z"/></g></svg>
      </button>
      ${_showingArchived
        ? `<button class="note-card-corner-trash" data-note-id="${note.id}" title="${t('notes.delete_forever')}" aria-label="${t('notes.delete_forever')}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
          <button class="note-card-corner-unarchive" data-note-id="${note.id}" title="${t('common.unarchive')}" aria-label="${t('common.unarchive') + ' ' + t('notes.title').toLowerCase()}">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14l-5-5 5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9"/></svg>
          </button>`
        : `<button class="note-card-done" data-note-id="${note.id}" title="${t('notes.mark_done')}" aria-label="${t('notes.mark_done')}">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
          ${_hasItems(note) ? `<button class="note-card-copy note-card-copy-corner" data-note-id="${note.id}" title="${t('notes.copy_all_items')}" aria-label="${t('notes.copy_all_items')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>` : ''}`}
      <div class="note-card-header">
        <div class="note-card-title${note.title ? '' : ' empty'}" data-action="edit">${_esc(note.title || '')}</div>
        ${dueBadge}
      </div>
      ${_safeImgSrc(note.image_url) ? `<img class="note-card-image" src="${_esc(_safeImgSrc(note.image_url))}" alt="" draggable="false" />` : ''}
      ${contentHtml}
      ${_hasItems(note) ? `<div class="note-cl-quickadd"><input type="text" class="note-cl-quickadd-input" placeholder="+ Add item" data-note-id="${note.id}" /></div>` : ''}
      ${reminderTagHtml}
      ${noteTags.length ? `<div class="note-card-label">${noteTags.map(t => `<button type="button" class="note-card-label-chip" data-note-label-filter="${_esc(t)}" title="${t('notes.filter_by', { tag: _esc(t) })}">#${_esc(t)}</button>`).join(' ')}</div>` : ''}
      ${note.agent_session_id ? `<button class="note-agent-tag" data-note-id="${note.id}" data-session-id="${_esc(note.agent_session_id)}" title="${t('notes.open_agent_chat')}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>
        <span>Agent</span>
      </button>` : ''}
      <div class="note-card-actions">
        <div class="note-card-colors">${colorDots}</div>
        <span style="flex:1"></span>
        ${_showingArchived ? `
        <button class="note-card-action note-card-delete" data-note-id="${note.id}" title="${t('notes.delete_forever')}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
        <button class="note-card-action note-card-unarchive" data-note-id="${note.id}" title="${t('common.unarchive')}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>
        </button>` : `
        ${_hasItems(note) ? `
        <button class="note-card-action note-card-copy" data-note-id="${note.id}" title="${t('notes.copy_all_items')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>` : ''}
        <button class="note-card-action note-card-archive" data-note-id="${note.id}" title="${t('notes.save_archive')}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        </button>
        <button class="note-card-action note-card-delete" data-note-id="${note.id}" title="${t('common.delete')}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <button class="note-card-action note-card-corner-menu" data-note-id="${note.id}" title="${t('notes.more_actions')}" aria-label="${t('notes.more_actions')}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
        </button>`}
      </div>
    </div>`;
  }

  // 始终在顶部渲染快速添加（折叠状态，除非用户正在输入）
  const existingForm = body.querySelector('.note-form');
  if (existingForm && _editingId === '__new__') {
    // 保留展开的表单，替换其后的卡片
    const next = [...body.children].filter(c => c !== existingForm);
    next.forEach(c => c.remove());
    if (sorted.length === 0) {
      body.insertAdjacentHTML('beforeend', '<div class="notes-empty-msg">No notes <span style="vertical-align:-3px;margin-left:4px;">' + uiModule.emptyStateIcon('smiley') + '</span></div>');
    } else {
      existingForm.insertAdjacentHTML('afterend', html);
    }
  } else {
    body.innerHTML = '';
    _renderLabelsInto(body);
    _renderQuickAdd(body);
    if (sorted.length === 0) {
      body.insertAdjacentHTML('beforeend', '<div class="notes-empty-msg">No notes yet <span style="vertical-align:-3px;margin-left:4px;">' + uiModule.emptyStateIcon('smiley') + '</span></div>');
    } else {
      body.insertAdjacentHTML('beforeend', html);
    }
  }

  _bindCardEvents(body);
  _animateReflow(prevPositions);
  _applyMasonry(body);
}

// 在网格视图中，通过计算每张卡片从其测量高度
// 得出的 `grid-row-end: span N` 来瀑布流布局卡片
// （行高 4px + 通过 card margin-bottom 模拟的 8px 行间距）。
// 网格的 `grid-auto-flow: dense` 独立排列各列，使左/右
// 通道不再共享行高。
//
// 通过每个卡片绑定的 ResizeObserver 在影响布局的变更时重新运行。
let _masonryObserver = null;
function _applyMasonry(body) {
  if (!body) return;
  const pane = body.closest('.notes-pane');
  const isGrid = pane?.classList.contains('notes-view-grid');
  const isMobileGrid = isGrid && window.matchMedia('(max-width: 768px)').matches;
  // 拆除任何先前的观察器（防御性 — _renderNotes 会清除 body.innerHTML）。
  if (_masonryObserver) { try { _masonryObserver.disconnect(); } catch {} _masonryObserver = null; }
  if (!isGrid) {
    // 清除任何残留的内联 span，使列表视图正常布局。
    body.querySelectorAll('.note-card, .notes-labels-bar, .notes-quick-add, .note-form').forEach(c => { c.style.gridRowEnd = ''; });
    return;
  }
  const ROW_PX = 4;
  const spanForHeight = (h) => Math.max(1, Math.ceil(h / ROW_PX));
  const recomputeFullRows = () => {
    const quickAdd = body.querySelector('.notes-quick-add');
    const labelsBar = body.querySelector('.notes-labels-bar');
    if (labelsBar && getComputedStyle(labelsBar).display !== 'none') {
      const shave = isMobileGrid ? 4 : 0;
      labelsBar.style.gridRowEnd = `span ${Math.max(1, spanForHeight(labelsBar.scrollHeight) - shave)}`;
    }
    if (quickAdd) {
      const shave = isMobileGrid ? 4 : 0;
      quickAdd.style.gridRowEnd = `span ${Math.max(1, spanForHeight(quickAdd.scrollHeight + 10) - shave)}`;
    }
    body.querySelectorAll('.note-form').forEach(form => {
      form.style.gridColumn = '1 / -1';
      const isDrawForm = !!form.querySelector('.note-form-type-seg.is-draw');
      const minSpan = isMobileGrid ? (isDrawForm ? 104 : 64) : 1;
      const renderedHeight = form.getBoundingClientRect?.().height || 0;
      const drawReserve = isDrawForm && isMobileGrid ? 12 : 12;
      const measuredHeight = Math.max(form.scrollHeight, renderedHeight) + drawReserve;
      form.style.gridRowEnd = `span ${Math.max(minSpan, spanForHeight(measuredHeight))}`;
    });
  };
  const recompute = (card) => {
    // scrollHeight 返回自然内容高度 — card.getBoundingClientRect()
    // 会返回网格单元格高度（在设置 span 之前折叠为 4px，
    // 而这正是我们试图计算的值）。
    const h = card.scrollHeight + (isMobileGrid ? 6 : 8);
    if (h <= 0) return;
    card.style.gridRowEnd = `span ${spanForHeight(h)}`;
  };
  recomputeFullRows();
  body.querySelectorAll('.note-card').forEach(recompute);
  // 观察瀑布流参与者 — 内容可能增长（图片加载、待办编辑、
  // 快速添加/表单展开），过时的 span 会导致视觉合并。
  if ('ResizeObserver' in window) {
    _masonryObserver = new ResizeObserver(entries => {
      let fullRowsChanged = false;
      for (const e of entries) {
        if (e.target.classList.contains('note-card')) recompute(e.target);
        else fullRowsChanged = true;
      }
      if (fullRowsChanged) recomputeFullRows();
    });
    body.querySelectorAll('.note-card').forEach(c => _masonryObserver.observe(c));
    body.querySelectorAll('.notes-labels-bar, .notes-quick-add, .note-form').forEach(c => _masonryObserver.observe(c));
  }
}

// 连接 Today 聚合视图：点击步骤圆点切换完成状态；点击
// 目标标题打开完整笔记进行编辑。完成的步骤会淡出，
// 下一个待处理的步骤在下次渲染时轮入。
function _wireTodayView(body) {
  body.querySelectorAll('.notes-today-row .note-check-dot').forEach(dot => {
    dot.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = dot.dataset.noteId;
      const idx = parseInt(dot.dataset.idx);
      const note = _notes.find(n => n.id === id);
      if (!note || !Array.isArray(note.items) || !note.items[idx]) return;
      note.items[idx].done = !note.items[idx].done;
      const row = dot.closest('.notes-today-row');
      if (row) row.classList.add('done');
      try {
        await _patchNote(id, { items: note.items });
        // 重新渲染，使下一个待处理的步骤浮现（如果目标现已完全完成，
        // 该行完全消失）。
        _renderNotes();
        // 所有项目刚变为完成时放彩带。
        if (note.items.every(it => it.done)) {
          const r = (row || dot).getBoundingClientRect();
          spawnConfetti(r.left + r.width / 2, r.top + r.height / 2, 60);
        }
      } catch {
        note.items[idx].done = !note.items[idx].done;
      }
    });
  });
  body.querySelectorAll('.notes-today-title').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.noteId;
      if (!id) return;
      // 先移除 Today 过滤器，使常规卡片列表被渲染；
      // _editNote 需要在 DOM 中找到 .note-card 以替换为
      // 编辑器表单。
      _activeFilter = null;
      _renderNotes();
      _editNote(id);
    });
  });
}

function _renderQuickAdd(body) {
  const wrap = document.createElement('div');
  wrap.className = 'notes-quick-add';
  // 双选项 Note/Todo 切换镜像完整表单的类型分段控件（减去了 Draw —
  // 绘图在展开表单中进行）。活跃的药丸同时控制
  // 占位符文本和表单打开时的类型。
  wrap.innerHTML = `
    <div class="notes-quick-type-seg is-todo" role="group" aria-label="${t('notes.delete_note_confirm_single')}">
      <button type="button" class="notes-quick-type-pill" data-type="note" aria-label="${t('notes.note_type_note')}" aria-pressed="false" title="${t('notes.note_type_note')}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>
      </button>
      <button type="button" class="notes-quick-type-pill active" data-type="todo" aria-label="${t('notes.note_type_todo')}" aria-pressed="true" title="${t('notes.note_type_todo')}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      </button>
    </div>
    <input type="text" class="notes-quick-input" placeholder="${t('notes.add_todo_placeholder')}" />
    <button class="notes-quick-icon" data-action="photo" title="${t('notes.attach_photo')}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    </button>
  `;
  body.appendChild(wrap);

  const input = wrap.querySelector('.notes-quick-input');
  const seg = wrap.querySelector('.notes-quick-type-seg');
  let currentType = 'todo';
  const setType = (t) => {
    if (t !== 'note' && t !== 'todo') return;
    currentType = t;
    seg.classList.toggle('is-todo', t === 'todo');
    seg.classList.toggle('is-note', t === 'note');
    seg.querySelectorAll('.notes-quick-type-pill').forEach(p => {
      const on = p.dataset.type === t;
      p.classList.toggle('active', on);
      p.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    input.placeholder = t === 'note' ? t('notes.add_note_placeholder') : t('notes.add_todo_placeholder');
  };
  seg.querySelectorAll('.notes-quick-type-pill').forEach(p => {
    p.addEventListener('click', (e) => {
      e.stopPropagation();
      setType(p.dataset.type);
    });
  });
  // 点击输入框或输入 → 展开为完整表单
  const expandToForm = (initialType = 'note', initialText = '') => {
    _editingId = '__new__';
    const form = _buildForm({ note_type: initialType });
    form.classList.add('note-form-new');
    if (initialText) {
      const titleEl = form.querySelector('.note-form-title');
      if (titleEl) titleEl.value = initialText;
    }
    const mobileGrid = body.closest('.notes-pane')?.classList.contains('notes-view-grid')
      && window.matchMedia('(max-width: 768px)').matches;
    if (mobileGrid) {
      form.style.gridColumn = '1 / -1';
      form.style.gridRowEnd = 'span 64';
    }
    wrap.replaceWith(form);
    _applyMasonry(body);
    requestAnimationFrame(() => _applyMasonry(body));
    const titleEl = form.querySelector('.note-form-title');
    if (titleEl) {
      titleEl.focus();
      // 移动光标到末尾
      titleEl.setSelectionRange(titleEl.value.length, titleEl.value.length);
    }
  };
  // 仅在真正意图时展开：直接点击输入框，或实际
  // 输入。仅获取焦点 — 包括从附近误点击偷取的焦点 —
  // 不再创建空表单。
  input.addEventListener('click', () => expandToForm(currentType, input.value));
  input.addEventListener('input', () => expandToForm(currentType, input.value));
  wrap.querySelector('[data-action="photo"]').addEventListener('click', (e) => {
    e.stopPropagation();
    expandToForm(currentType);
    // 触发新表单上的照片输入
    setTimeout(() => document.querySelector('.note-form-photo-btn')?.click(), 50);
  });
}

function _bindCardEvents(body) {
  const tapToEditOrSelect = (cardEl) => {
    const id = cardEl.dataset.noteId;
    if (_selectMode) {
      const cb = cardEl.querySelector('.note-card-cb');
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      }
    } else if (_isNotesMobileMode()) {
      // 移动端：打开每个笔记的全屏编辑覆盖层，而非
      // 原地表单。移动端卡片是只读预览。
      _openMobileFullscreenEdit(id, cardEl);
    } else {
      _editNote(id);
    }
  };
  // 移动端：长按笔记卡片上的任意位置 → 进入拖拽排序模式。
  // 通过移动取消（这样不会干扰垂直滚动），
  // 或在定时器触发前抬起手指也会取消。
  if (_isNotesMobileMode()) {
    body.querySelectorAll('.note-card').forEach(card => _bindLongPressDrag(card));
  }
  body.querySelectorAll('.note-card.note-card-reminder-fired-sticky').forEach(card => {
    card.addEventListener('click', () => _setReminderCardGlow(card.dataset.noteId, false), true);
  });
  // 点击标题 — 编辑，或在选择模式下切换选择
  body.querySelectorAll('.note-card-title[data-action="edit"]').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); tapToEditOrSelect(el.closest('.note-card')); });
  });
  // 点击内容 — 编辑，或在选择模式下切换选择
  body.querySelectorAll('.note-content-preview').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); tapToEditOrSelect(el.closest('.note-card')); });
  });
  // 点击清单预览的空白区域（不在复选框/X 上）— 编辑
  body.querySelectorAll('.note-checklist-preview').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.note-checkbox, .note-checkbox-rm, .note-cl-quickadd, input')) return;
      e.stopPropagation();
      tapToEditOrSelect(el.closest('.note-card'));
    });
  });
  // 点击待办项目文本现在会切换其复选框 — 让点击冒泡到
  // 父级 .note-checkbox 行处理器。要打开编辑器，
  // 用户点击铅笔角。
  // （保留无操作块作为标记 — 完全移除监听器意味着
  // 点击会自然冒泡到下方的行切换器。）
  // 在选择模式下，点击卡片任意位置切换选择
  if (_selectMode) {
    body.querySelectorAll('.note-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.note-card-cb')) return; // 复选框自行处理
        e.stopPropagation();
        tapToEditOrSelect(card);
      });
    });
  }
  // 移动端、非选择模式：点击卡片主体上的任何位置（不在
  // 交互子元素上 — 按钮、固定、复选框、色点、提醒药丸、
  // agent 标签、链接）打开全屏编辑器。之前只有
  // 标题/内容预览触发编辑，因此内边距 + 空白区域是
  // 在移动端感觉坏掉的无响应区域。
  if (_isNotesMobileMode() && !_selectMode) {
    const _INTERACTIVE = 'button, a, input, label, .note-card-color-dot, .note-checkbox, .note-checkbox-rm, .note-cl-quickadd, .note-agent-tag, .note-card-pin, .note-card-corner-trash, .note-card-corner-menu, .note-card-corner-unarchive, .note-card-edit-corner, .note-card-reminder, .note-card-cb';
    body.querySelectorAll('.note-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest(_INTERACTIVE)) return;
        e.stopPropagation();
        tapToEditOrSelect(card);
      });
    });
  }
  // 多选复选框（仅在选择模式下）
  body.querySelectorAll('.note-card-cb').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const id = cb.dataset.noteId;
      if (cb.checked) _selectedIds.add(id);
      else _selectedIds.delete(id);
      cb.closest('.note-card').classList.toggle('note-card-selected', cb.checked);
      _updateBulkBar();
    });
  });
  // 固定切换（乐观更新）
  body.querySelectorAll('.note-card-pin').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.noteId;
      const note = _notes.find(n => n.id === id);
      if (!note) return;
      const prevPinned = note.pinned;
      const prevSortOrder = note.sort_order;
      note.pinned = !prevPinned;
      const patch = { pinned: note.pinned };
      if (note.pinned) {
        const minPinned = _notes
          .filter(n => n.pinned && n.id !== id)
          .reduce((m, n) => Math.min(m, n.sort_order || 0), 0);
        note.sort_order = minPinned - 1;
        patch.sort_order = note.sort_order;
      }
      _renderNotes();
      _patchNote(id, patch).catch(() => {
        note.pinned = prevPinned;
        note.sort_order = prevSortOrder;
        _renderNotes();
        uiModule.showError(t('notes.failed_pin'));
      });
    });
  });
  // 颜色选择器
  const _applyCardColor = async (card, id, newColor) => {
    const isBg = _isBgImage(newColor);
    COLORS.forEach(c => { if (c.value && c.value !== 'custom') card.classList.remove('note-color-' + c.value); });
    if (newColor && !isBg) card.classList.add('note-color-' + newColor);
    if (isBg) card.setAttribute('style', _customColorStyle(newColor));
    else card.removeAttribute('style');
    card.querySelectorAll('.note-card-color-dot').forEach(d => {
      d.classList.toggle('active', _dotIsActive(d.dataset.color, newColor));
      d.style.background = _dotBg(d.dataset.color, newColor);
    });
    try { await _patchNote(id, { color: newColor || null }); const note = _notes.find(n => n.id === id); if (note) note.color = newColor; }
    catch { uiModule.showError(t('notes.failed_color')); }
  };
  body.querySelectorAll('.note-card-color-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = dot.closest('.note-card');
      const id = card.dataset.noteId;
      if (dot.dataset.color === 'custom') {
        _pickCustomBgImage().then(url => { if (url) _applyCardColor(card, id, 'bg:' + url); });
        return;
      }
      _applyCardColor(card, id, dot.dataset.color);
    });
  });
  // 普通铅笔角 → 打开编辑器。取消归档角共享
  // .note-card-edit-corner 类用于样式，因此 :not() 使编辑
  // 处理器不会绑定到它。
  body.querySelectorAll('.note-card-edit-corner:not(.note-card-unarchive-corner)').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.noteId;
      if (id) _editNote(id);
    });
  });
  // 复制角 — 右下角，就在完成对勾的左边。与
   // 下方的 Ctrl/Cmd+C 快捷键共享，因此两个代码路径运行相同的
   // 序列化器 + 反馈闪烁。
  // ⋯ 角菜单 — 复制 + Agent（解决此待办）。
  body.querySelectorAll('.note-card-corner-menu').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _openNoteCornerMenu(btn);
    });
  });
  // Agent 标签 — 打开 agent 为此笔记运行的聊天会话。
  body.querySelectorAll('.note-agent-tag').forEach(tag => {
    tag.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sid = tag.dataset.sessionId;
      const _sm = window.sessionModule;
      if (sid && _sm && _sm.selectSession) { closePanel(); _sm.selectSession(sid); }
    });
  });
  body.querySelectorAll('.note-card-label-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const label = chip.dataset.noteLabelFilter;
      if (!label) return;
      if (_activeLabel === label && _activeFilter === null) {
        _activeLabel = null;
      } else {
        _activeFilter = null;
        _activeLabel = label;
      }
      _renderNotes();
    });
  });
  // 右下角的完成 (✓) — 仅在悬停时对活跃笔记可见。
  body.querySelectorAll('.note-card-done').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.noteId;
      const card = btn.closest('.note-card');
      const idx = _notes.findIndex(n => n.id === id);
      if (idx < 0) return;
      // 庆祝完成 — 与批量归档使用的相同彩带效果。
      if (card) {
        const r = card.getBoundingClientRect();
        spawnConfetti(r.left + r.width / 2, r.top + r.height / 2, 80);
      }
      const removed = _notes.splice(idx, 1)[0];
      const undo = () => _undoArchive(removed, idx);
      _pushUndo({ label: 'archive', run: undo });
      const _undoIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9"/></svg>';
      const finish = () => {
        _renderNotes();
        _patchNote(id, { archived: true }).then(() => {
          uiModule.showToast(t('notes.archived_toast'), { duration: 6000, action: t('notes.undo_action'), actionIcon: _undoIcon, onAction: undo, actionHint: 'Ctrl+Z' });
        }).catch(() => {
          _notes.splice(idx, 0, removed);
          _renderNotes();
          uiModule.showError(t('notes.failed_archive'));
        });
      };
      if (card) {
        card.classList.add('note-card-sliding-out');
        let done = false;
        const once = () => { if (done) return; done = true; finish(); };
        card.addEventListener('transitionend', once, { once: true });
        setTimeout(once, 400);
      } else {
        finish();
      }
    });
  });
  // 取消归档角 — 仅在归档视图中可见。
  body.querySelectorAll('.note-card-corner-unarchive').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.noteId;
      const idx = _notes.findIndex(n => n.id === id);
      if (idx < 0) return;
      const removed = _notes.splice(idx, 1)[0];
      _renderNotes();
      _patchNote(id, { archived: false }).then(() => uiModule.showToast(t('notes.unarchived'))).catch(() => {
        _notes.splice(idx, 0, removed);
        _renderNotes();
        uiModule.showError(t('notes.failed_unarchive'));
      });
    });
  });
  // 垃圾桶角 — 仅归档视图。永久删除，无确认。
  body.querySelectorAll('.note-card-corner-trash').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.noteId;
      const idx = _notes.findIndex(n => n.id === id);
      if (idx < 0) return;
      const removed = _notes.splice(idx, 1)[0];
      _renderNotes();
      _deleteNoteApi(id).then(() => uiModule.showToast(t('notes.deleted_toast'))).catch(() => {
        _notes.splice(idx, 0, removed);
        _renderNotes();
        uiModule.showError(t('notes.failed_delete'));
      });
    });
  });

  body.querySelectorAll('.note-card-archive').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.noteId;
      if (!id) return;
      const note = _notes.find(n => n.id === id);
      const card = btn.closest('.note-card');
      // 归档完全完成的清单（todo 或 goal）时放彩带。
      if (note && _hasItems(note) && card) {
        const undone = (note.items || []).filter(i => !i.done);
        if (undone.length === 0) {
          const r = card.getBoundingClientRect();
          spawnConfetti(r.left + r.width / 2, r.top + r.height / 2, 80);
        }
      }
      let done = false;
      const finishRemove = () => {
        if (done) return;
        done = true;
        const curIdx = _notes.findIndex(n => n.id === id);
        if (curIdx < 0) return;
        const removed = _notes.splice(curIdx, 1)[0];
        _renderNotes();
        const undo = () => _undoArchive(removed, curIdx);
        _pushUndo({ label: 'archive', run: undo });
        const _undoIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9"/></svg>';
        _patchNote(id, { archived: true }).then(() => {
          uiModule.showToast(t('notes.archived_toast'), { duration: 6000, action: t('notes.undo_action'), actionIcon: _undoIcon, onAction: undo, actionHint: 'Ctrl+Z' });
        }).catch(() => {
          _notes.splice(curIdx, 0, removed);
          _renderNotes();
          uiModule.showError(t('notes.failed_archive'));
        });
      };
      if (card) {
        card.classList.add('note-card-sliding-out');
        card.addEventListener('transitionend', finishRemove, { once: true });
        setTimeout(finishRemove, 400);
      } else {
        finishRemove();
      }
    });
  });
  // 取消归档（乐观更新）— 仅在归档视图中存在
  body.querySelectorAll('.note-card-unarchive').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.noteId;
      const idx = _notes.findIndex(n => n.id === id);
      if (idx < 0) return;
      const removed = _notes.splice(idx, 1)[0];
      _renderNotes();
      _patchNote(id, { archived: false }).then(() => uiModule.showToast(t('notes.unarchived'))).catch(() => {
        _notes.splice(idx, 0, removed);
        _renderNotes();
        uiModule.showError(t('notes.failed_unarchive'));
      });
    });
  });
  // 删除（乐观更新）
  body.querySelectorAll('.note-card-delete, .note-card-x').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.noteId;
      const idx = _notes.findIndex(n => n.id === id);
      if (idx < 0) return;
      const removed = _notes.splice(idx, 1)[0];
      _renderNotes();
      _deleteNoteApi(id).catch(() => {
        _notes.splice(idx, 0, removed);
        _renderNotes();
        uiModule.showError(t('notes.failed_delete'));
      });
    });
  });
  // 复制整个清单（标题 + 项目，markdown 风格）
  body.querySelectorAll('.note-card-copy').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const id = btn.dataset.noteId;
      const note = _notes.find(n => n.id === id);
      if (!note) return;
      const lines = [];
      if (note.title) lines.push(note.title);
      if (note.content) lines.push(note.content);
      if (lines.length) lines.push('');
      for (const it of (note.items || [])) {
        if (!it || !(it.text || '').trim()) continue;
        lines.push(`- [${it.done ? 'x' : ' '}] ${(it.text || '').trim()}`);
      }
      const text = lines.join('\n').trim();
      try {
        await navigator.clipboard.writeText(text);
        uiModule.showToast?.(`Copied ${(note.items || []).filter(i => (i?.text || '').trim()).length} items`);
      } catch {
        // 回退方案，供阻止异步 API 的浏览器使用
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); uiModule.showToast?.(t('notes.copied')); }
        catch { uiModule.showError?.(t('notes.copy_failed')); }
        ta.remove();
      }
    });
  });

  // 移除单个清单项目（悬停 X）
  body.querySelectorAll('.note-checkbox-rm').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_selectMode) return;
      const noteId = btn.dataset.noteId;
      const idx = parseInt(btn.dataset.idx);
      const note = _notes.find(n => n.id === noteId);
      if (!note || !Array.isArray(note.items) || !note.items[idx]) return;
      const removed = note.items[idx];
      note.items = note.items.filter((_, i) => i !== idx);
      _renderNotes();
      _patchNote(noteId, { items: note.items }).catch(() => {
        note.items.splice(idx, 0, removed);
        _renderNotes();
        uiModule.showError(t('notes.failed_remove_item'));
      });
    });
  });

  // 快速添加新清单项目（悬停在待办卡片底部的输入框）
  body.querySelectorAll('.note-cl-quickadd-input').forEach(input => {
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const noteId = input.dataset.noteId;
      const note = _notes.find(n => n.id === noteId);
      if (!note) return;
      const items = Array.isArray(note.items) ? [...note.items] : [];
      items.push({ id: _uid(), text, done: false });
      note.items = items;
      input.value = '';
      _renderNotes();
      // 在同一张卡片上重新聚焦输入框
      setTimeout(() => {
        const next = document.querySelector(`.note-cl-quickadd-input[data-note-id="${noteId}"]`);
        if (next) next.focus();
      }, 0);
      _patchNote(noteId, { items }).catch(() => {
        note.items = items.slice(0, -1);
        _renderNotes();
        uiModule.showError(t('notes.failed_add_item'));
      });
    });
  });

  // 复选框（圆点切换，乐观更新）— 在选择模式下禁用
  body.querySelectorAll('.note-checkbox').forEach(el => {
    el.addEventListener('click', (e) => {
      if (_selectMode) return; // 让卡片级处理器接管
      e.stopPropagation();
      const noteId = el.dataset.noteId;
      const idx = parseInt(el.dataset.idx);
      const note = _notes.find(n => n.id === noteId);
      if (!note || !note.items || !note.items[idx]) return;
      const wasAllDone = note.items.length > 0 && note.items.every(it => it.done);
      note.items[idx].done = !note.items[idx].done;
      el.classList.toggle('done', note.items[idx].done);
      const isAllDone = note.items.length > 0 && note.items.every(it => it.done);
      if (!wasAllDone && isAllDone) {
        const card = el.closest('.note-card');
        if (card) {
          const r = card.getBoundingClientRect();
          spawnConfetti(r.left + r.width / 2, r.top + r.height / 2, 60);
        }
      }
      _patchNote(noteId, { items: note.items }).catch(() => {
        note.items[idx].done = !note.items[idx].done;
        el.classList.toggle('done', note.items[idx].done);
      });
    });
  });

  // 在指针/鼠标设备上拖拽排序笔记。移动端使用自定义
  // 占位符排序器（`_bindLongPressDrag` 下方）；原生 HTML5 拖拽在
  // 触摸浏览器上不可靠，且可能与长按流程冲突。
  if (!_isNotesMobileMode()) {
    body.querySelectorAll('.note-card').forEach(card => {
      card.addEventListener('dragstart', (e) => {
        if (e.target.closest('.note-checkbox, .note-card-x, .note-card-select, .note-card-pin, .note-card-action, .note-card-color-dot, .note-card-title, .note-card-edit, .note-card-edit-corner, .note-card-done, .note-card-corner-menu, .note-agent-tag, .note-card-label-chip')) {
          e.preventDefault();
          return;
        }
        card.classList.add('dragging');
        body.classList.add('drag-active');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', card.dataset.noteId); } catch {}
      });
      card.addEventListener('dragend', async () => {
        card.classList.remove('dragging');
        body.classList.remove('drag-active');
        body.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
        const ids = [...body.querySelectorAll('.note-card')].map(c => c.dataset.noteId);
        try { await fetch(`${API_BASE}/api/notes/reorder`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }); }
        catch {}
      });
    });
  }
  // 跟踪我们最后交换的卡片，使单次悬停触发一次交换，
  // 而不是在指针继续在卡片内移动时产生抖动。
  let _lastSwapId = null;
  function _maybeSwap(dragging, clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY)?.closest('.note-card');
    if (!target || target === dragging || !body.contains(target)) return;
    const id = target.dataset.noteId;
    if (id === _lastSwapId) return;
    // 对所有兄弟元素进行 FLIP。在列表视图中只有 `target` 视觉上移动，
    // 但在网格视图（2 列）中以及当固定区域的 grid-column-start 规则
    // 变化时，多张卡片同时重新排列。捕获每张卡片交换前的矩形，
    // 执行 DOM 交换，然后对实际移动的卡片进行动画。正在拖动的卡片
    // 被排除 — 它已经通过 translate3d 跟随手指。
    const cards = [...body.querySelectorAll('.note-card')].filter(c => c !== dragging);
    const prevRects = new Map(cards.map(c => [c, c.getBoundingClientRect()]));
    const draggingNext = dragging.nextSibling === target ? dragging : dragging.nextSibling;
    body.insertBefore(dragging, target);
    body.insertBefore(target, draggingNext);
    for (const c of cards) {
      const prev = prevRects.get(c);
      const next = c.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      c.style.transition = 'none';
      c.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        c.style.transition = 'transform 0.22s cubic-bezier(0.34, 1.2, 0.64, 1)';
        c.style.transform = '';
        c.addEventListener('transitionend', () => { c.style.transition = ''; }, { once: true });
      });
    }
    _lastSwapId = id;
  }
  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = body.querySelector('.note-card.dragging');
    if (!dragging) return;
    _maybeSwap(dragging, e.clientX, e.clientY);
  });
  body.addEventListener('dragend', () => { _lastSwapId = null; });

  // 旧版触摸拖拽，仅适用于较大触摸设备。手机尺寸的笔记使用
  // 由 `_bindLongPressDrag` 连接的占位符排序器；同时运行两个流程
  // 会导致一次按压启动两个独立的拖拽会话。
  if (!_isNotesMobileMode() && 'ontouchstart' in window && !body.dataset.touchDragBound) {
    body.dataset.touchDragBound = '1';
    let dragCard = null;
    let isDragging = false;
    let longPressTimer = null;
    let startX = 0, startY = 0;
    const LONG_PRESS_MS = 350;
    const MOVE_THRESHOLD_PX = 8;
    const _selectorSkip = '.note-checkbox, .note-card-x, .note-card-select, .note-card-pin, .note-card-action, .note-card-color-dot, .note-card-title, .note-card-edit, .note-card-edit-corner, .note-card-done, .note-card-corner-menu, .note-agent-tag, .note-card-label-chip, input, textarea, button, a';

    // 手指跟随变换的锚点。每次交换后重新计算，
    // 使卡片在重新排序过程中始终保持在手指下方。
    let anchorX = 0, anchorY = 0;
    const _follow = (clientX, clientY) => {
      if (!dragCard) return;
      const dx = clientX - anchorX;
      const dy = clientY - anchorY;
      // 与 CSS .dragging 变换（缩放 + 旋转）组合。
      dragCard.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.03) rotate(-0.6deg)`;
    };
    const _reanchor = (clientX, clientY) => {
      if (!dragCard) return;
      // 清除任何先前的平移，使卡片在其自然位置中重置，
      // 然后将锚点设置在手指当前位置。后续 _follow 调用
      // 平移量为 (finger - anchor)，使手指保持在重新锚定时
      // 卡片上相同的相对位置。
      dragCard.style.transform = '';
      anchorX = clientX;
      anchorY = clientY;
    };

    const _endDrag = (committed) => {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      if (dragCard) {
        dragCard.classList.remove('dragging');
        dragCard.style.transform = '';
      }
      body.classList.remove('drag-active');
      _lastSwapId = null;
      if (isDragging) {
        document.documentElement.style.touchAction = '';
        if (committed) {
          const ids = [...body.querySelectorAll('.note-card')].map(c => c.dataset.noteId);
          fetch(`${API_BASE}/api/notes/reorder`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).catch(() => {});
        }
      }
      dragCard = null;
      isDragging = false;
    };

    body.addEventListener('touchstart', (e) => {
      if (_selectMode) return;
      const card = e.target.closest('.note-card');
      if (!card) return;
      if (e.target.closest(_selectorSkip)) return;
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      dragCard = card;
      longPressTimer = setTimeout(() => {
        if (!dragCard) return;
        isDragging = true;
        dragCard.classList.add('dragging');
        body.classList.add('drag-active');
        document.documentElement.style.touchAction = 'none';
        _reanchor(startX, startY);
        try { if (navigator.vibrate) navigator.vibrate(15); } catch {}
      }, LONG_PRESS_MS);
    }, { passive: true });

    body.addEventListener('touchmove', (e) => {
      if (!dragCard) return;
      const t = e.touches[0];
      if (!isDragging) {
        // 长按触发前移动 = 用户在滚动；取消拾取。
        if (Math.abs(t.clientX - startX) > MOVE_THRESHOLD_PX || Math.abs(t.clientY - startY) > MOVE_THRESHOLD_PX) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
          dragCard = null;
        }
        return;
      }
      e.preventDefault();
      // 首先实时跟随手指，然后检查是否交换。交换后
      // 卡片的自然位置移动了，因此我们重新锚定并重新应用偏移量。
      _follow(t.clientX, t.clientY);
      const before = dragCard.parentNode && [...dragCard.parentNode.children].indexOf(dragCard);
      _maybeSwap(dragCard, t.clientX, t.clientY);
      const after = dragCard.parentNode && [...dragCard.parentNode.children].indexOf(dragCard);
      if (before !== after) {
        _reanchor(t.clientX, t.clientY);
        _follow(t.clientX, t.clientY);
      }
    }, { passive: false });

    body.addEventListener('touchend', () => _endDrag(true));
    body.addEventListener('touchcancel', () => _endDrag(false));
  }
}

// ── 草稿自动保存 ──────────────────────────────────────────────────
// While a note is open in the editor, its form is snapshotted to
// localStorage on every change (debounced). If the connection drops, the
// tab closes, or the page reloads before Save is hit, reopening that note
// restores the unsaved text. Drafts are cleared on an explicit Save or
// Cancel. Survives offline because it never touches the network.
const _DRAFT_PREFIX = 'odysseus-note-draft-';
function _draftKey(id) { return _DRAFT_PREFIX + (id || '__new__'); }
function _loadDraft(id) {
  try { return JSON.parse(localStorage.getItem(_draftKey(id)) || 'null'); } catch { return null; }
}
function _clearDraft(id) { try { localStorage.removeItem(_draftKey(id)); } catch {} }
function _collectFormDraft(form) {
  if (!form) return null;
  const type = form.querySelector('.note-form-type-pill.active')?.dataset.type || 'note';
  const d = {
    _ts: Date.now(),
    note_type: type,
    title: form.querySelector('.note-form-title')?.value || '',
    label: form.querySelector('.note-form-label')?.value || '',
    due_date: form.querySelector('.note-form-due')?.value || null,
    repeat: form.querySelector('.note-form-repeat')?.value || 'none',
  };
  if (type === 'note') d.content = form.querySelector('.note-form-content')?.value || '';
  else if (type === 'goal') { d.content = form.querySelector('.note-form-goal-desc')?.value || ''; d.items = _collectItems(form); }
  else d.items = _collectItems(form);
  return d;
}
function _isDraftEmpty(d) {
  if (!d) return true;
  if ((d.title || '').trim()) return false;
  if ((d.content || '').trim()) return false;
  if (Array.isArray(d.items) && d.items.some(it => (it.text || '').trim())) return false;
  return true;
}
function _wireDraftAutosave(form, id) {
  let t = null;
  const save = () => {
    const d = _collectFormDraft(form);
    if (_isDraftEmpty(d)) { _clearDraft(id); return; }
    try { localStorage.setItem(_draftKey(id), JSON.stringify(d)); } catch {}
  };
  form._flushDraft = () => { clearTimeout(t); save(); };
  const sched = () => { clearTimeout(t); t = setTimeout(save, 600); };
  form.addEventListener('input', sched);
  form.addEventListener('change', sched);
}

// 提交打开的任何原地编辑器（在面板关闭或打开另一个笔记时
// 调用），以免用户在没有点击保存的情况下导航离开时
// 丢失编辑内容。空笔记会被丢弃而不是保存。
function _commitOpenInPlaceEditor() {
  const form = document.querySelector('#notes-pane .note-form');
  if (!form) return;
  const d = _collectFormDraft(form);
  if (_isDraftEmpty(d)) { form.querySelector('.note-form-cancel')?.click(); return; }
  form.querySelector('.note-form-save')?.click();
}
// 将存储的草稿合并到笔记上，使 _buildForm 渲染未保存的编辑。
function _applyDraftToNote(note, id) {
  const d = _loadDraft(id);
  if (_isDraftEmpty(d)) return { note, restored: false };
  const merged = { ...(note || {}) };
  ['note_type', 'title', 'label', 'due_date', 'repeat', 'content', 'items'].forEach(k => {
    if (d[k] !== undefined) merged[k] = d[k];
  });
  return { note: merged, restored: true };
}

// ---- 创建 / 编辑表单 ----

function _buildForm(note = null) {
  const isEdit = note && note.id;
  const type = note?.note_type || 'note';
  const color = note?.color || '';
  const items = note?.items || [{ id: _uid(), text: '', done: false }];

  const form = document.createElement('div');
  form.className = 'note-form';
  if (color && !_isBgImage(color)) form.classList.add('note-color-' + color);
  if (_isBgImage(color)) form.setAttribute('style', _customColorStyle(color));
  let currentImageUrl = _safeImgSrc(note?.image_url || '');
  form.innerHTML = `
    <div class="note-form-header">
      <input type="text" class="note-form-title" placeholder="${t('notes.form_title')}" value="${_esc(note?.title || '')}" />
      <button type="button" class="note-form-icon-btn note-form-remind-btn${note?.due_date ? ' has-date' : ''}" title="${t('notes.form_remind_me')}">
        <svg width="31" height="31" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      </button>
      <input type="hidden" class="note-form-due" value="${note?.due_date || ''}" />
      <input type="hidden" class="note-form-repeat" value="${note?.repeat || 'none'}" />
    </div>
    ${currentImageUrl && type !== 'draw' ? `<div class="note-form-image-wrap"><img class="note-form-image" src="${_esc(currentImageUrl)}" draggable="false" /><button class="note-form-image-rm" title="${t('notes.form_remove')}">&times;</button></div>` : ''}
    <div class="note-form-body">
      ${type === 'note'
        ? `<textarea class="note-form-content" placeholder="${t('notes.form_content_placeholder')}" rows="4">${_esc(note?.content || '')}</textarea>`
        : type === 'draw'
        ? _buildDrawHtml()
        : type === 'goal'
        ? _buildGoalHtml(note, items)
        : _buildChecklistHtml(items)}
    </div>
    <div class="note-form-reminder-tags"></div>
    <div class="note-form-meta">
      <div class="note-form-type-seg${type === 'todo' ? ' is-todo' : type === 'draw' ? ' is-draw' : ''}" role="group">
        <button type="button" class="note-form-type-pill${type === 'note' ? ' active' : ''}" data-type="note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>
          <span>Note</span>
        </button>
        <button type="button" class="note-form-type-pill${type === 'todo' ? ' active' : ''}" data-type="todo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          <span>Todo</span>
        </button>
        <button type="button" class="note-form-type-pill${type === 'draw' ? ' active' : ''}" data-type="draw">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
          <span>Draw</span>
        </button>
      </div>
      <button class="note-form-photo-btn" title="${t('notes.attach_photo')}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      </button>
      <input type="file" class="note-form-photo-input" accept="image/*" capture="environment" style="display:none" />
      <div class="note-color-picker">
        ${COLORS.map(c => `<span class="note-color-dot${_dotIsActive(c.value, color) ? ' active' : ''}" data-color="${c.value}" style="background:${_dotBg(c.value, color)}" title="${c.name || 'default'}"></span>`).join('')}
      </div>
      <input type="text" class="note-form-label" value="${_esc(note?.label || '')}" placeholder="${t('notes.form_tags_placeholder')}" title="${t('notes.form_tags_title')}" />
      <div class="note-form-actions-group">
        ${isEdit ? `
        <button type="button" class="note-form-text-btn note-form-archive-btn note-form-collapsible" title="${t('notes.form_archive')}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8"/><path d="M10 12h4"/></svg><span class="nft-label">Archive</span>
        </button>
        <button type="button" class="note-form-text-btn note-form-delete-btn note-form-collapsible danger" title="${t('common.delete')}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg><span class="nft-label">Delete</span>
        </button>
        ` : ''}
        <span class="note-form-actions-spacer"></span>
        <button class="note-form-cancel note-form-text-btn note-form-collapsible" title="${t('common.cancel')}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg><span class="nft-label">Cancel</span>
        </button>
        <button class="note-form-save note-form-text-btn" title="${isEdit ? t('notes.form_update') : t('notes.form_save')}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span class="nft-label">${isEdit ? t('notes.form_update') : t('notes.form_save')}</span>
        </button>
      </div>
    </div>
  `;

  let currentType = type;
  let currentColor = color;
  // Stash original-form values so round-trips (Note→Todo→Note) restore the
  // user's hand-formatted text instead of a join of generated items. Same the
  // other way: if you started in todo, switch to note, switch back, items
  // come back unchanged.
  let _stashedNoteText = (type === 'note') ? (note?.content || '') : null;
  let _stashedTodoItems = (type === 'todo' && Array.isArray(note?.items)) ? note.items.slice() : null;
  // Goal 模式保留自己的一对存储（描述 + 步骤），使
  // Todo→Goal→Todo 的往返切换不会丢失任何一方。Goal 按钮
  // 后来从类型选择器中移除了，所以现在唯一的入口点是
  // *编辑*现有的 goal 类型笔记 — 但切换处理器仍然
  // 接受 Goal→Todo/Note 的转换（降级旧版 goal），所以
  // 这些存储仍然有其存在的价值。
  let _stashedGoalDesc = (type === 'goal') ? (note?.content || '') : null;
  let _stashedGoalItems = (type === 'goal' && Array.isArray(note?.items)) ? note.items.slice() : null;

  // 绘图也会存储保存的图片 URL，使其在 Note↔Draw 切换中保持不变。
  let _stashedDrawUrl = (type === 'draw') ? (_safeImgSrc(note?.image_url) || null) : null;
  const _refreshFormLayout = () => {
    const body = form.closest('.notes-pane-body');
    if (!body) return;
    _applyMasonry(body);
    requestAnimationFrame(() => {
      _applyMasonry(body);
      requestAnimationFrame(() => _applyMasonry(body));
    });
  };

  // 类型分段控件 — Note | Todo | Draw
  form.querySelectorAll('.note-form-type-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const newType = pill.dataset.type;
      if (newType === currentType) return;
      const bodyEl = form.querySelector('.note-form-body');
      // 在切换之前将当前模式下用户输入的内容暂存，
      // 使后续切换回来时能恢复用户的工作。
      if (currentType === 'note') {
        _stashedNoteText = form.querySelector('.note-form-content')?.value || '';
      } else if (currentType === 'todo') {
        _stashedTodoItems = _collectItems(form);
      } else if (currentType === 'goal') {
        _stashedGoalDesc = form.querySelector('.note-form-goal-desc')?.value || '';
        _stashedGoalItems = _collectItems(form);
      } else if (currentType === 'draw') {
        const c = form.querySelector('.note-form-canvas');
        if (c) { try { _stashedDrawUrl = c.toDataURL('image/png'); } catch {} }
      }
      // 渲染新模式的正文并重新连接其输入。
      if (newType === 'todo') {
        let nextItems;
        if (_stashedTodoItems && _stashedTodoItems.length) {
          nextItems = _stashedTodoItems;
        } else if (_stashedGoalItems && _stashedGoalItems.length) {
          // Goal→Todo 转换保留 AI 生成的步骤作为普通清单。
          nextItems = _stashedGoalItems;
        } else if (_stashedNoteText) {
          const lines = _stashedNoteText.split('\n').map(s => s.trim()).filter(Boolean);
          nextItems = lines.length ? lines.map(t => ({ id: _uid(), text: t, done: false })) : [{ id: _uid(), text: '', done: false }];
        } else {
          nextItems = [{ id: _uid(), text: '', done: false }];
        }
        bodyEl.innerHTML = _buildChecklistHtml(nextItems);
        _wireChecklist(bodyEl);
      } else if (newType === 'draw') {
        bodyEl.innerHTML = _buildDrawHtml();
        // 如果用户刚刚通过照片按钮附加了一张照片，然后
        // 切换到绘图模式，将该照片绘制到画布上以便用户在其上
        // 绘图。如果用户在同一编辑会话中之前已经在绘图，
        // _stashedDrawUrl 优先。
        _wireCanvas(bodyEl, _stashedDrawUrl || currentImageUrl || _safeImgSrc(note?.image_url) || null);
      } else {
        const text = (_stashedNoteText !== null && _stashedNoteText !== undefined && _stashedNoteText !== '')
          ? _stashedNoteText
          : (_stashedGoalDesc && _stashedGoalDesc)
          || (_stashedTodoItems || _stashedGoalItems || []).map(i => i.text).join('\n');
        bodyEl.innerHTML = `<textarea class="note-form-content" placeholder="${t('notes.form_content_placeholder')}" rows="4">${_esc(text)}</textarea>`;
        _wireHashtag(bodyEl.querySelector('.note-form-content'));
      }
      const focusEl = newType === 'note'
        ? bodyEl.querySelector('.note-form-content')
        : newType === 'todo'
          ? bodyEl.querySelector('.note-cl-text')
          : null;
      if (focusEl) {
        requestAnimationFrame(() => {
          focusEl.focus({ preventScroll: true });
          try {
            const end = focusEl.value.length;
            focusEl.setSelectionRange(end, end);
          } catch {}
        });
      }
      currentType = newType;
      const seg = form.querySelector('.note-form-type-seg');
      seg?.classList.toggle('is-todo', newType === 'todo');
      seg?.classList.toggle('is-draw', newType === 'draw');
      form.querySelectorAll('.note-form-type-pill').forEach(p => p.classList.toggle('active', p.dataset.type === newType));
      // 独立的图片预览（form-image-wrap）和画布在编辑
      // 绘图笔记时会同时显示相同的 image_url。
      // 在绘图模式下隐藏它，离开绘图模式时恢复。
      const imgWrap = form.querySelector('.note-form-image-wrap');
      if (imgWrap) imgWrap.style.display = (newType === 'draw') ? 'none' : '';
      // 背景色圆点设置笔记卡片的背景 — 对于绘图笔记来说没有意义
      // （画布图片本身就是卡片内容），所以隐藏它们。
      const bgPicker = form.querySelector('.note-color-picker');
      if (bgPicker) bgPicker.style.display = (newType === 'draw') ? 'none' : '';
      if (form.closest('.notes-pane.notes-view-grid') && window.matchMedia('(max-width: 768px)').matches) {
        form.style.gridColumn = '1 / -1';
        form.style.gridRowEnd = newType === 'draw' ? 'span 152' : 'span 64';
      }
      _refreshFormLayout();
    });
  });

  // 用手指在 Note/Todo/Draw 控件上滑动来切换模式（移动端）。
  // 在 touchmove 时找到手指下的按钮并点击它 — 复用上面的
  // 按钮点击处理器，使正文重新渲染 + 内容暂存全部
  // 正常工作。仅在进入一个 *不同的* 按钮时触发。
  const _typeSeg = form.querySelector('.note-form-type-seg');
  if (_typeSeg) {
    let _sliding = false;
    const _activateAt = (x, y) => {
      const pill = document.elementFromPoint(x, y)?.closest?.('.note-form-type-pill');
      if (pill && !pill.classList.contains('active')) pill.click();
    };
    _typeSeg.addEventListener('touchstart', () => { _sliding = true; }, { passive: true });
    _typeSeg.addEventListener('touchmove', (e) => {
      if (_sliding && e.touches[0]) _activateAt(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    _typeSeg.addEventListener('touchend', () => { _sliding = false; });
    _typeSeg.addEventListener('touchcancel', () => { _sliding = false; });
  }

  // 色点 — 立即应用到整个表单
  const _applyFormColor = (newColor) => {
    currentColor = newColor || '';
    const isBg = _isBgImage(currentColor);
    COLORS.forEach(c => { if (c.value && c.value !== 'custom') form.classList.remove('note-color-' + c.value); });
    if (currentColor && !isBg) form.classList.add('note-color-' + currentColor);
    if (isBg) form.setAttribute('style', _customColorStyle(currentColor));
    else form.removeAttribute('style');
    form.querySelectorAll('.note-color-dot').forEach(d => {
      d.classList.toggle('active', _dotIsActive(d.dataset.color, currentColor));
      d.style.background = _dotBg(d.dataset.color, currentColor);
    });
  };
  form.querySelectorAll('.note-color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      if (dot.dataset.color === 'custom') {
        _pickCustomBgImage().then(url => { if (url) _applyFormColor('bg:' + url); });
        return;
      }
      _applyFormColor(dot.dataset.color);
    });
  });

  if (currentType === 'todo') _wireChecklist(form.querySelector('.note-form-body'));
  if (currentType === 'goal') _wireGoalForm(form, form.querySelector('.note-form-body'));
  if (currentType === 'draw') {
    _wireCanvas(form.querySelector('.note-form-body'), _safeImgSrc(note?.image_url) || null);
    // 类型切换时应用的相同隐藏 — 在初始打开时保持一致。
    const _ip = form.querySelector('.note-form-image-wrap'); if (_ip) _ip.style.display = 'none';
    const _cp = form.querySelector('.note-color-picker'); if (_cp) _cp.style.display = 'none';
  }

  // 自动扩展纯文本笔记的 textarea，使编辑较长笔记时
  // 更舒适 — 它随内容扩展（有上限），而不是
  // 保持一个狭窄的 4 行框。用户仍然可以拖拽调整大小。
  const _contentTa = form.querySelector('.note-form-content');
  if (_contentTa) {
    const _grow = () => {
      _contentTa.style.height = 'auto';
      // 内联表单：限制在 ~50vh，避免超长笔记将操作按钮
      // 挤出屏幕。全屏移动端覆盖层：正文可滚动且
      // 没有内联按钮拥挤，所以允许接近全高
      // — 在那里限制到 50vh 会截断较长的笔记（"部分消失"）。
      const inFullscreen = !!_contentTa.closest('.note-fullscreen-overlay');
      const max = Math.round(window.innerHeight * (inFullscreen ? 0.9 : 0.5));
      _contentTa.style.height = Math.min(_contentTa.scrollHeight, max) + 'px';
    };
    _contentTa.addEventListener('input', _grow);
    // 打开时扩展，使现有内容完全可见。在全屏覆盖层的
    // 打开动画完成后再次执行 — 在动画中间测量
    // （覆盖层开始时进行缩放/过渡）可能导致框尺寸过小。
    setTimeout(_grow, 0);
    setTimeout(_grow, 360);
  }

  // 提醒铃铛 — 打开下拉菜单
  const remindBtn = form.querySelector('.note-form-remind-btn');
  const dueInput = form.querySelector('.note-form-due');
  const repeatInput = form.querySelector('.note-form-repeat');
  const tagsEl = form.querySelector('.note-form-reminder-tags');

  function _renderReminderTag() {
    if (!tagsEl) return;
    const v = dueInput.value;
    const rep = repeatInput.value || 'none';
    if (!v) { tagsEl.innerHTML = ''; return; }
    const label = _formatReminderTag(v);
    const repLabel = rep !== 'none' ? ` · ${_formatRepeatLabel(rep, new Date(v))}` : '';
    tagsEl.innerHTML = `<button class="note-reminder-tag" type="button" title="${t('notes.edit_reminder')}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      <span>${_esc(label)}${_esc(repLabel)}</span>
      <span class="note-reminder-tag-x" title="${t('notes.form_remove')}">×</span>
    </button>`;
    tagsEl.querySelector('.note-reminder-tag').addEventListener('click', (e) => {
      if (e.target.classList.contains('note-reminder-tag-x')) {
        dueInput.value = '';
        repeatInput.value = 'none';
        _renderReminderTag();
        return;
      }
      _openReminderMenu(remindBtn || tagsEl, true);
    });
  }

  function _openReminderMenu(anchor, isEdit = false) {
    // 关闭任何现有菜单
    document.querySelectorAll('.note-reminder-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'note-reminder-menu';
    document.body.appendChild(menu);

    const presetItems = [
      { label: t('notes.later_today'), sub: _laterTodayDate().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), action: () => _setReminder(_toLocalDatetimeStr(_laterTodayDate())) },
      { label: t('notes.tomorrow'), sub: _tomorrowDate().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), action: () => _setReminder(_toLocalDatetimeStr(_tomorrowDate())) },
      { label: t('notes.next_week'), sub: _nextWeekDate().toLocaleDateString([], { weekday: 'short' }) + ' ' + _nextWeekDate().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), action: () => _setReminder(_toLocalDatetimeStr(_nextWeekDate())) },
      { label: t('notes.select_date_time'), sub: '', action: () => _pickCustomDate() },
    ];

    // 重复选择器的子页面状态。null = 顶层页面。
    // 'weekly' | 'monthly' | 'monthly_nth' — 子页面状态
    let subMode = null;
    // monthly_nth 的临时状态，使用户可以先点击 N 再点击星期几，或反过来，
    // 然后再提交。
    let nthDraft = { n: 0, w: -1 };

    const DAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

    function getNorm() {
      if (!dueInput.value) return 'none';
      return _normalizeRepeat(repeatInput.value || 'none', new Date(dueInput.value));
    }

    function commit(val) {
      repeatInput.value = val;
      _renderReminderTag();
      menu.remove();
    }

    // 类似 commit，但首先将 dueInput.value 向前推进到所选重复规则的
    // 下一个匹配位置。用于每周/每月变体，其中当前
    // 到期日可能与所选模式不匹配（例如，用户选择
    // "每周一" 而日期是周三）。
    function snapAndCommit(val) {
      if (dueInput.value) {
        const cur = new Date(dueInput.value);
        const norm = _normalizeRepeat(val, cur);
        const snapped = _snapToRepeat(cur, norm);
        if (snapped) {
          dueInput.value = _toLocalDatetimeStr(snapped);
          if (remindBtn) remindBtn.classList.add('has-date');
        }
      }
      commit(val);
    }

    function reposition() {
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const mw = menu.offsetWidth || 220;
      const mh = menu.offsetHeight || 280;
      let top = rect.bottom + 4;
      let left = rect.left;
      if (top + mh > vh - 8) top = Math.max(8, rect.top - mh - 4);
      if (left + mw > vw - 8) left = Math.max(8, vw - mw - 8);
      if (left < 8) left = 8;
      menu.style.top = top + 'px';
      menu.style.left = left + 'px';
    }

    function render() {
      let html = '';

      if (subMode === null) {
        html += '<div class="note-reminder-menu-title">Remind me later</div>';
        for (let i = 0; i < presetItems.length; i++) {
          const it = presetItems[i];
          html += `<button class="note-reminder-menu-item" data-action="preset" data-i="${i}"><span>${it.label}</span><span class="note-reminder-menu-sub">${it.sub}</span></button>`;
        }
        if (isEdit && dueInput.value) {
          const norm = getNorm();
          html += '<div class="note-reminder-menu-divider"></div>';
          html += '<div class="note-reminder-menu-title">Repeat</div>';
          // 无
          html += `<button class="note-reminder-menu-item${norm === 'none' ? ' active' : ''}" data-action="set" data-val="none"><span>Doesn't repeat</span>${norm === 'none' ? '<span class="note-reminder-menu-check">✓</span>' : ''}</button>`;
          // 每日
          html += `<button class="note-reminder-menu-item${norm === 'daily' ? ' active' : ''}" data-action="set" data-val="daily"><span>Daily</span>${norm === 'daily' ? '<span class="note-reminder-menu-check">✓</span>' : ''}</button>`;
          // 每周 →
          {
            const isW = norm.startsWith('weekly:');
            const wd = isW ? parseInt(norm.split(':')[1], 10) : null;
            const sub = isW && !isNaN(wd) ? `<span class="note-reminder-menu-sub">${_DAYS[wd]}</span>` : '';
            html += `<button class="note-reminder-menu-item${isW ? ' active' : ''}" data-action="sub" data-sub="weekly"><span>Weekly</span>${sub}<span class="note-reminder-menu-arrow">›</span></button>`;
          }
          // 每月 →
          {
            const isM = norm.startsWith('monthly:');
            const sub = isM ? `<span class="note-reminder-menu-sub">${_monthlyShortDescriptor(norm)}</span>` : '';
            html += `<button class="note-reminder-menu-item${isM ? ' active' : ''}" data-action="sub" data-sub="monthly"><span>Monthly</span>${sub}<span class="note-reminder-menu-arrow">›</span></button>`;
          }
          // 每年
          html += `<button class="note-reminder-menu-item${norm === 'yearly' ? ' active' : ''}" data-action="set" data-val="yearly"><span>Yearly</span>${norm === 'yearly' ? '<span class="note-reminder-menu-check">✓</span>' : ''}</button>`;
        }
      } else if (subMode === 'weekly') {
        const norm = getNorm();
        const curWd = norm.startsWith('weekly:') ? parseInt(norm.split(':')[1], 10) : -1;
        html += `<button class="note-reminder-menu-back" data-action="back"><span class="note-reminder-menu-arrow-back">‹</span> Repeat</button>`;
        html += '<div class="note-reminder-menu-title">Weekly on…</div>';
        html += '<div class="note-reminder-weekday-row">';
        for (let i = 0; i < 7; i++) {
          html += `<button class="note-reminder-day-chip${curWd === i ? ' active' : ''}" data-action="weekly-pick" data-wd="${i}" title="${_DAYS[i]}">${DAY_SHORT[i]}</button>`;
        }
        html += '</div>';
      } else if (subMode === 'monthly') {
        const norm = getNorm();
        const dueDate = new Date(dueInput.value);
        const dayN = dueDate.getDate();
        html += `<button class="note-reminder-menu-back" data-action="back"><span class="note-reminder-menu-arrow-back">‹</span> Repeat</button>`;
        html += '<div class="note-reminder-menu-title">Monthly on…</div>';
        // 第 N 天 — 使用所选日期的日。始终提供。
        const dayVal = `monthly:day:${dayN}`;
        html += `<button class="note-reminder-menu-item${norm === dayVal ? ' active' : ''}" data-action="set" data-val="${dayVal}"><span>Day ${dayN} every month</span>${norm === dayVal ? '<span class="note-reminder-menu-check">✓</span>' : ''}</button>`;
        // 第 N 个星期几 →
        {
          const isNth = norm.startsWith('monthly:nth:');
          const sub = isNth ? `<span class="note-reminder-menu-sub">${_monthlyShortDescriptor(norm)}</span>` : '';
          html += `<button class="note-reminder-menu-item${isNth ? ' active' : ''}" data-action="sub" data-sub="monthly_nth"><span>Nth weekday</span>${sub}<span class="note-reminder-menu-arrow">›</span></button>`;
        }
      } else if (subMode === 'monthly_nth') {
        // 选择序数 (1..4) 和星期几 (0..6)；两者都选择后提交。
        html += `<button class="note-reminder-menu-back" data-action="back-monthly"><span class="note-reminder-menu-arrow-back">‹</span> Monthly</button>`;
        html += '<div class="note-reminder-menu-title">Nth weekday of month</div>';
        html += '<div class="note-reminder-menu-sublabel">Which one</div>';
        html += '<div class="note-reminder-weekday-row">';
        for (let i = 1; i <= 4; i++) {
          html += `<button class="note-reminder-day-chip wide${nthDraft.n === i ? ' active' : ''}" data-action="nth-n" data-n="${i}">${_ORDINALS[i - 1]}</button>`;
        }
        html += '</div>';
        html += '<div class="note-reminder-menu-sublabel">Weekday</div>';
        html += '<div class="note-reminder-weekday-row">';
        for (let i = 0; i < 7; i++) {
          html += `<button class="note-reminder-day-chip${nthDraft.w === i ? ' active' : ''}" data-action="nth-w" data-wd="${i}" title="${_DAYS[i]}">${DAY_SHORT[i]}</button>`;
        }
        html += '</div>';
        html += '<div class="note-reminder-menu-divider"></div>';
        const ready = nthDraft.n > 0 && nthDraft.w >= 0;
        const lbl = ready ? `${t('notes.form_save')}: ${_ORDINALS[nthDraft.n - 1]} ${_DAYS[nthDraft.w]}` : t('notes.pick_week_weekday');
        html += `<button class="note-reminder-menu-item note-reminder-menu-confirm${ready ? '' : ' disabled'}" data-action="nth-save" ${ready ? '' : 'disabled'}><span>${lbl}</span></button>`;
      }

      menu.innerHTML = html;
      reposition();
      wire();
    }

    function wire() {
      menu.querySelectorAll('[data-action]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const a = el.dataset.action;
          if (a === 'preset') {
            const it = presetItems[parseInt(el.dataset.i, 10)];
            it.action();
            menu.remove();
          } else if (a === 'set') {
            snapAndCommit(el.dataset.val);
          } else if (a === 'sub') {
            subMode = el.dataset.sub;
            // 仅在首次进入时从保存的值初始化 nth 草稿 — 保留
            // 往返过程中的选择（Nth → 返回 → 再次 Nth）。
            if (subMode === 'monthly_nth' && nthDraft.n === 0 && nthDraft.w === -1) {
              const norm = getNorm();
              const m = norm.match(/^monthly:nth:(\d):(\d)$/);
              if (m) nthDraft = { n: parseInt(m[1], 10), w: parseInt(m[2], 10) };
            }
            render();
          } else if (a === 'back') {
            subMode = null;
            render();
          } else if (a === 'back-monthly') {
            subMode = 'monthly';
            render();
          } else if (a === 'weekly-pick') {
            snapAndCommit(`weekly:${el.dataset.wd}`);
          } else if (a === 'nth-n') {
            nthDraft.n = parseInt(el.dataset.n, 10);
            render();
          } else if (a === 'nth-w') {
            nthDraft.w = parseInt(el.dataset.wd, 10);
            render();
          } else if (a === 'nth-save') {
            if (nthDraft.n > 0 && nthDraft.w >= 0) {
              snapAndCommit(`monthly:nth:${nthDraft.n}:${nthDraft.w}`);
            }
          }
        });
      });
    }

    render();
    // 点击外部关闭（首次绘制后附加单个全局处理器）
    setTimeout(() => {
      const close = (e) => {
        if (!menu.isConnected) { document.removeEventListener('click', close); return; }
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
      };
      document.addEventListener('click', close);
    }, 0);
  }

  function _monthlyShortDescriptor(norm) {
    const parts = norm.split(':');
    if (parts[1] === 'day') return `Day ${parts[2]}`;
    if (parts[1] === 'nth') {
      const n = parseInt(parts[2], 10);
      const wd = parseInt(parts[3], 10);
      return `${_ORDINALS[n - 1] || `${n}th`} ${_DAYS[wd].slice(0, 3)}`;
    }
    if (parts[1] === 'last') {
      const wd = parseInt(parts[2], 10);
      return `Last ${_DAYS[wd].slice(0, 3)}`;
    }
    return '';
  }

  function _setReminder(datetimeLocalStr) {
    dueInput.value = datetimeLocalStr;
    if (remindBtn) {
      remindBtn.classList.add('has-date');
      // 摇铃铛。CSS 处理动画；先移除 + 重排 + 重新添加，
      // 使其在每次用户设置/更改提醒时重新播放。
      const _bell = remindBtn.querySelector('svg');
      if (_bell) {
        _bell.classList.remove('jingling');
        void _bell.offsetWidth;
        _bell.classList.add('jingling');
        setTimeout(() => _bell.classList.remove('jingling'), 700);
      }
    }
    _renderReminderTag();
    _ensureNotificationPermission();
  }

  function _pickCustomDate() {
    // 将下拉菜单替换为小型内联选择器
    document.querySelectorAll('.note-reminder-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'note-reminder-menu';
    const initial = dueInput.value || _toLocalDatetimeStr(_tomorrowDate());
    menu.innerHTML = `
      <div class="note-reminder-menu-title">Pick date and time</div>
      <div class="note-reminder-menu-picker">
        <input type="datetime-local" class="note-reminder-date-input" value="${initial}" />
      </div>
      <div class="note-reminder-menu-divider"></div>
      <button class="note-reminder-menu-item note-reminder-menu-confirm">
        <span>Save</span>
      </button>
    `;
    document.body.appendChild(menu);
    // 定位在铃铛按钮旁边
    const anchor = remindBtn || form.querySelector('.note-form-reminder-tags');
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mw = menu.offsetWidth || 240;
    const mh = menu.offsetHeight || 200;
    let top = rect.bottom + 4;
    let left = rect.left;
    if (top + mh > vh - 8) top = Math.max(8, rect.top - mh - 4);
    if (left + mw > vw - 8) left = Math.max(8, vw - mw - 8);
    if (left < 8) left = 8;
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    const dInput = menu.querySelector('.note-reminder-date-input');
    dInput.focus();
    if (typeof dInput.showPicker === 'function') {
      try { dInput.showPicker(); } catch {}
    }
    menu.querySelector('.note-reminder-menu-confirm').addEventListener('click', () => {
      if (dInput.value) _setReminder(dInput.value);
      menu.remove();
    });
    setTimeout(() => {
      const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
      document.addEventListener('click', close);
    }, 0);
  }

  if (remindBtn) remindBtn.addEventListener('click', (e) => { e.stopPropagation(); _openReminderMenu(remindBtn, !!dueInput.value); });
  _renderReminderTag();

  // 照片上传
  const photoBtn = form.querySelector('.note-form-photo-btn');
  const photoInput = form.querySelector('.note-form-photo-input');
  if (photoBtn && photoInput) {
    photoBtn.addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', async () => {
      const file = photoInput.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('files', file);
      try {
        const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: fd, credentials: 'same-origin' });
        const data = await res.json();
        const fileId = data.files?.[0]?.id;
        if (!fileId) throw new Error('Upload failed');
        currentImageUrl = `${API_BASE}/api/upload/${fileId}`;
        // Only ever keep the latest attached photo — drop any existing wrap
        // before inserting a fresh one. Picking a second photo replaces the
        // first instead of stacking.
        form.querySelector('.note-form-image-wrap')?.remove();
        const wrap = document.createElement('div');
        wrap.className = 'note-form-image-wrap';
        wrap.innerHTML = `<img class="note-form-image" draggable="false" /><button class="note-form-image-rm" title="${t('notes.form_remove')}">&times;</button>`;
        // 插入到整个头部之后（一个 flex-row），而不是标题
        // 输入框本身之后 — 否则图片会成为头部内标题的兄弟元素，
        // flex 会将它们并排放置。
        form.querySelector('.note-form-header').after(wrap);
        wrap.querySelector('.note-form-image-rm').addEventListener('click', () => { wrap.remove(); currentImageUrl = ''; });
        wrap.querySelector('img').src = currentImageUrl;
      } catch (err) { uiModule.showError(t('notes.image_upload_failed')); }
      photoInput.value = '';
    });
  }
  // 移除现有图片
  form.querySelector('.note-form-image-rm')?.addEventListener('click', () => {
    form.querySelector('.note-form-image-wrap')?.remove();
    currentImageUrl = '';
  });

  // 标题 Enter -> 聚焦正文（textarea 或第一个清单项目）
  form.querySelector('.note-form-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const ta = form.querySelector('.note-form-content');
      if (ta) { ta.focus(); return; }
      const firstItem = form.querySelector('.note-cl-text');
      if (firstItem) firstItem.focus();
    }
  });

  // Hashtag → 标签：在标题/正文中输入 "#foo " 会将 "foo" 追加到
  // 空格分隔的标签列表中。重复项会被去重，所以 #foo #foo 只保留一个。
  // 标签字段中已存在的标签不受影响。
  const labelInput = form.querySelector('.note-form-label');
  const _hashtagRe = /(^|\s)#([A-Za-z0-9][\w-]*)\s$/;
  function _wireHashtag(el) {
    if (!el || !labelInput) return;
    el.addEventListener('input', () => {
      const m = _hashtagRe.exec(el.value);
      if (!m) return;
      const tag = m[2];
      // 对剥离版本进行去重 — labelInput 可能已经保存了 `#tag`
      // （在 Enter 规范化后），所以在原始分割结果上使用 includes(tag)
      // 会漏掉重复项，在 `#tag` 旁边追加一个裸露的 `tag`。
      const existing = labelInput.value.trim().split(/\s+/).filter(Boolean);
      const stripped = existing.map(t => t.replace(/^#+/, ''));
      if (!stripped.includes(tag)) {
        existing.push('#' + tag);
        labelInput.value = existing.join(' ');
        labelInput.classList.add('flash-once');
        setTimeout(() => labelInput.classList.remove('flash-once'), 600);
      }
      const cut = el.value.length - m[0].length + m[1].length;
      el.value = el.value.slice(0, cut);
    });
  }
  _wireHashtag(form.querySelector('.note-form-title'));
  _wireHashtag(form.querySelector('.note-form-content'));
  // 在标签字段中按 Enter 会将当前单词作为独立标签提交，
  // 并将光标放在尾部空格之后，使下一个单词成为单独标签
  // 而不是覆盖上一个。
  labelInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    // 剥离用户输入的任何前导 #，去重，然后重新添加恰好
    // 一个 #。因此输入 "foo" 或 "#foo" 最终在输入框中都是 "#foo "；
    // 保存处理器在存储前会剥离 #，所以数据库保持干净。
    const tags = [...new Set(labelInput.value.split(/\s+/).map(t => t.replace(/^#+/, '').trim()).filter(Boolean))];
    if (!tags.length) return;
    labelInput.value = tags.map(t => '#' + t).join(' ') + ' ';
    labelInput.setSelectionRange(labelInput.value.length, labelInput.value.length);
    labelInput.classList.add('flash-once');
    setTimeout(() => labelInput.classList.remove('flash-once'), 600);
  });

  // Shift+Enter（或 Cmd/Ctrl+Enter）在表单任意位置 -> 保存
  // Escape -> 取消编辑
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      form.querySelector('.note-form-save')?.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      form.querySelector('.note-form-cancel')?.click();
    }
  });

  // 保存。防止按钮在按下时抢夺焦点：在移动端，第一次点击
  // 本来只是让已聚焦的 textarea/input 失焦（关闭键盘并
  // 改变布局），导致点击永远无法到达按钮，你需要点击
  // "完成" 两次。mousedown preventDefault 保持焦点不移动
  // 同时仍然允许 click 触发。
  const _saveBtnEl0 = form.querySelector('.note-form-save');
  _saveBtnEl0.addEventListener('mousedown', (e) => e.preventDefault());
  _saveBtnEl0.addEventListener('click', async () => {
    // 防止快速点击：绘图保存会 AWAIT 画布上传，然后
    // 乐观重新渲染才会移除表单，所以如果没有这个保护，慢速上传
    // 会让重复点击创建重复笔记。
    const _saveBtn = form.querySelector('.note-form-save');
    if (_saveBtn._saving) return;
    // 移动端：当现有笔记打开并关闭且没有编辑时，
    // Update (✓) 按钮会变形为 Archive（如下方设置）。将点击路由到
    // 隐藏的 archive 按钮，使现有的归档流程 + 撤销提示
    // 保持不变地运行。
    if (_saveBtn.classList.contains('archive-mode')) {
      form.querySelector('.note-form-archive-btn')?.click();
      return;
    }
    _saveBtn._saving = true; _saveBtn.disabled = true; _saveBtn.style.opacity = '0.5';
    try {
    const title = form.querySelector('.note-form-title').value.trim();
    // 规范化标签输入：按空白分隔，去除前导 #，去重，
    // 用单个空格重新连接。空 → null。
    const _rawLabel = form.querySelector('.note-form-label')?.value || '';
    const _tags = [...new Set(_rawLabel.split(/\s+/).map(t => t.replace(/^#+/, '').trim()).filter(Boolean))];
    if (form.querySelector('.note-form-due').value && !_tags.includes('reminder')) _tags.push('reminder');
    const labelVal = _tags.length ? _tags.join(' ') : null;
    const payload = {
      title,
      note_type: currentType,
      color: currentColor,
      label: labelVal,
      due_date: form.querySelector('.note-form-due').value || null,
      repeat: form.querySelector('.note-form-repeat')?.value || 'none',
      image_url: currentImageUrl || null,
    };
    if (currentType === 'note') {
      payload.content = form.querySelector('.note-form-content')?.value || '';
    } else if (currentType === 'draw') {
      // 保存前上传画布 PNG，使 image_url 指向持久文件。
      // 我们阻塞保存直到上传完成 — 没有 URL 的绘图
      // 无法在之后重新渲染。
      const canvas = form.querySelector('.note-form-canvas');
      const url = await _uploadCanvasAsPng(canvas);
      if (!url) { uiModule.showError('Failed to save drawing'); return; }
      payload.image_url = url;
    } else if (currentType === 'goal') {
      // 旧版：现有 goal 类型笔记仍然通过此分支编辑。
      // 无 AI 参与 — 作为带有描述 + 项目的普通笔记保存。
      payload.content = form.querySelector('.note-form-goal-desc')?.value || '';
      payload.items = _collectItems(form);
    } else {
      payload.items = _collectItems(form);
    }
    if (isEdit) payload.id = note.id;
    // 如果 due_date 变更则重置已触发提醒（使重新激活生效），同时
    // 清除 entry-glow 已见标志，以便用户下次打开面板时
    // 新触发的提醒再次发光。
    if (isEdit && note.due_date !== payload.due_date) {
      const fired = _loadFiredReminders();
      fired.delete(note.id);
      _saveFiredReminders(fired);
      const glowed = _loadGlowedReminders();
      glowed.delete(note.id);
      _saveGlowedReminders(glowed);
      _setReminderCardGlow(note.id, false);
    }
    // 编辑后的笔记移动到其区域顶部（固定笔记下方）。计算
    // sort_order = (最小未固定 sort_order) - 1，使保存的笔记排在
    // 兄弟笔记之上；固定块保持其自己在上方的顺序。
    if (!payload.pinned) {
      // Both edits AND newly-created notes anchor above the rest of the
      // unpinned section. Without this, freshly created notes sit at the
      // bottom because manually-reordered siblings already carry negative
      // 兄弟笔记已经带有负 sort_order 值。
      const minUnpinned = _notes
        .filter(n => !n.pinned && (!isEdit || n.id !== note.id))
        .reduce((m, n) => Math.min(m, n.sort_order || 0), 0);
      payload.sort_order = minUnpinned - 1;
    }
    // 乐观更新 — 先更新本地状态，渲染，然后后台保存
    _editingId = null;
    _clearDraft(isEdit ? note.id : '__new__');  // 已保存 → 丢弃草稿
    if (isEdit) {
      const idx = _notes.findIndex(n => n.id === note.id);
      if (idx >= 0) _notes[idx] = { ..._notes[idx], ...payload };
    } else {
      _notes.unshift({ ...payload, id: 'tmp_' + _uid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    }
    _renderNotes();
    // 后台保存
    _saveNote(payload).then(saved => {
      if (!isEdit && saved && saved.id) {
        // 用服务器返回的真实 ID 替换临时 ID。并重新渲染 —
        // 在 Object.assign 提升内存中的 id 后，现有卡片的 `data-note-id="tmp_xxx"` 已过时，
        // 因此所有后续点击（编辑、完成、复制、
        // 归档、删除）在 `_notes` 中静默找不到该笔记。
        const tmp = _notes.find(n => n.id.startsWith('tmp_'));
        if (tmp) Object.assign(tmp, saved);
        _renderNotes();
      }
    }).catch(err => {
      uiModule.showError(t('notes.save_failed_msg') + err.message);
      _fetchNotes().then(() => _renderNotes());
    });
    } finally {
      // 在提前返回/错误时重新启用。成功时表单已通过
      // 乐观重新渲染移除，因此重新启用已分离的按钮是无操作。
      _saveBtn._saving = false; _saveBtn.disabled = false; _saveBtn.style.opacity = '';
    }
  });

  // 仅移动端：编辑现有笔记时，Update (✓) 按钮初始处于
  // archive-mode（视觉 + 行为上），并在第一次编辑时翻转为 Update。
  // 使用户可以点击笔记浏览，然后点击 ✓ 归档，无需触碰
  // 单独的 Archive 按钮。
  if (isEdit && window.innerWidth <= 768) {
    const _saveLabelEl = _saveBtnEl0.querySelector('.nft-label');
    const _enterArchive = () => {
      _saveBtnEl0.classList.add('archive-mode');
      if (_saveLabelEl) _saveLabelEl.textContent = t('notes.form_archive');
      _saveBtnEl0.title = t('notes.form_archive');
    };
    const _enterUpdate = () => {
      if (!_saveBtnEl0.classList.contains('archive-mode')) return;
      _saveBtnEl0.classList.remove('archive-mode');
      if (_saveLabelEl) _saveLabelEl.textContent = t('notes.form_update');
      _saveBtnEl0.title = t('notes.form_update');
    };
    _enterArchive();
    form.addEventListener('input', _enterUpdate, true);
    form.addEventListener('change', _enterUpdate, true);
  }

  // 取消
  form.querySelector('.note-form-cancel').addEventListener('click', () => { _clearDraft(isEdit ? note.id : '__new__'); _editingId = null; _renderNotes(); });

  // 归档 / 删除 — 仅编辑模式下的按钮，镜像（现已被隐藏的）卡片操作。
  form.querySelector('.note-form-archive-btn')?.addEventListener('click', () => {
    if (!isEdit) return;
    const id = note.id;
    const idx = _notes.findIndex(n => n.id === id);
    if (idx < 0) return;
    const removed = _notes.splice(idx, 1)[0];
    _editingId = null;
    _renderNotes();
    const undo = () => _undoArchive(removed, idx);
    _pushUndo({ label: 'archive', run: undo });
    const _undoIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9"/></svg>';
    _patchNote(id, { archived: true }).then(() => {
      uiModule.showToast(t('notes.archived_toast'), { duration: 6000, action: t('notes.undo_action'), actionIcon: _undoIcon, onAction: undo, actionHint: 'Ctrl+Z' });
    }).catch(() => {
      _notes.splice(idx, 0, removed);
      _renderNotes();
      uiModule.showError(t('notes.failed_archive'));
    });
  });
  form.querySelector('.note-form-delete-btn')?.addEventListener('click', async () => {
    if (!isEdit) return;
    const id = note.id;
    if (uiModule.styledConfirm) {
      const ok = await uiModule.styledConfirm(t('notes.delete_note_confirm_single'), { confirmText: t('common.delete'), danger: true });
      if (!ok) return;
    } else if (!confirm(t('notes.delete_note_confirm_single'))) {
      return;
    }
    const idx = _notes.findIndex(n => n.id === id);
    if (idx >= 0) _notes.splice(idx, 1);
    _editingId = null;
    _renderNotes();
    _deleteNoteApi(id).then(() => uiModule.showToast(t('notes.deleted_toast'))).catch(() => {
      uiModule.showError(t('notes.failed_delete'));
      _fetchNotes().then(() => _renderNotes());
    });
  });

  // 每次变更时将草稿自动保存到 localStorage，使未保存的编辑
  // 能在连接丢失/重新加载/意外关闭后幸存。
  _wireDraftAutosave(form, isEdit ? note.id : '__new__');

  return form;
}

// 旧版 goal 类型笔记仍通过此分支渲染，
// 以免现有数据丢失。"Goal" 类型不再在表单选择器
// 或快速添加中暴露 — 这些笔记显示为描述 + 手动清单
// 编辑器，就像普通带有正文的 todo。
function _buildGoalHtml(note, items) {
  const desc = (note?.content || '').toString();
  return `
    <div class="note-form-goal">
      <textarea class="note-form-goal-desc" placeholder="${t('notes.description_optional')}" rows="3">${_esc(desc)}</textarea>
      ${_buildChecklistHtml(items)}
    </div>
  `;
}

function _wireGoalForm(form, container) {
  if (!container) return;
  // _wireHashtag 是 _buildForm 内的闭包 — 此处不可用。内联
  // 相同的行为（在描述中输入 "#foo " → 标签添加到
  // 表单的标签输入框），使编辑 goal 笔记不会 ReferenceError。
  const desc = container.querySelector('.note-form-goal-desc');
  const labelInput = form?.querySelector('.note-form-label');
  if (desc && labelInput) {
    const tagRe = /(^|\s)#([A-Za-z0-9][\w-]*)\s$/;
    desc.addEventListener('input', () => {
      const m = tagRe.exec(desc.value);
      if (!m) return;
      const tag = m[2];
      // 与普通笔记 hashtag 处理器相同的去除后去重修复。
      const existing = labelInput.value.trim().split(/\s+/).filter(Boolean);
      const stripped = existing.map(t => t.replace(/^#+/, ''));
      if (!stripped.includes(tag)) {
        existing.push('#' + tag);
        labelInput.value = existing.join(' ');
        labelInput.classList.add('flash-once');
        setTimeout(() => labelInput.classList.remove('flash-once'), 600);
      }
      const cut = desc.value.length - m[0].length + m[1].length;
      desc.value = desc.value.slice(0, cut);
    });
  }
  // 始终连接清单。之前对 `note-form-goal-fresh` 类的
  // 门控是死代码 — 从未设置过该类，因此编辑器
  // 从未连接添加/拖拽/Tab 处理器。
  _wireChecklist(container);
}

function _buildChecklistHtml(items) {
  let html = '<div class="note-checklist-inputs">';
  for (const item of items) {
    const indent = Math.min(item.indent || 0, 3);
    html += `<div class="note-cl-row${item.done ? ' done' : ''}" draggable="true" data-item-id="${item.id || _uid()}" data-indent="${indent}" style="padding-left:${indent * 16}px">
      <span class="note-cl-grip" title="${t('notes.drag_reorder')}">⋮⋮</span>
      <span class="note-cl-dot"></span>
      <input type="text" class="note-cl-text" value="${_esc(item.text)}" placeholder="${t('notes.item_placeholder')}" />
      <button type="button" class="note-cl-rm">&times;</button>
    </div>`;
  }
  // `type="button"` 在移动端很重要 — 没有它，某些浏览器会将
  // 裸 <button> 视为表单提交，点击处理器在某些容器内
  // 永远不会触发。还放大了点击目标，使手指不会按偏。
  html += `<button type="button" class="note-cl-add">+ Add</button></div>`;
  return html;
}

function _wireRow(row, container) {
  row.querySelector('.note-cl-rm')?.addEventListener('click', () => row.remove());
  row.querySelector('.note-cl-dot')?.addEventListener('click', () => {
    const wasDone = row.classList.contains('done');
    row.classList.toggle('done');
    const becameDone = !wasDone;  // 刚刚翻转了它
    const dot = row.querySelector('.note-cl-dot');
    const dRect = (dot || row).getBoundingClientRect();
    // 每次新勾选时放小彩带，使用户每个项目都获得
    // "做得好" 的节拍，而不仅仅是全部完成时的大结局。
    if (becameDone) {
      spawnConfetti(dRect.left + dRect.width / 2, dRect.top + dRect.height / 2, 16);
    }
    // 整个清单现在完成时放更大的彩带。
    const rows = [...container.querySelectorAll('.note-cl-row')];
    const hasText = rows.some(r => (r.querySelector('.note-cl-text')?.value || '').trim().length > 0);
    if (hasText && rows.every(r => r.classList.contains('done') || !(r.querySelector('.note-cl-text')?.value || '').trim())) {
      spawnConfetti(dRect.left + dRect.width / 2, dRect.top + dRect.height / 2, 60);
    }
  });
  const txt = row.querySelector('.note-cl-text');
  txt?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); container.querySelector('.note-cl-add')?.click(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const cur = parseInt(row.dataset.indent || '0');
      const next = e.shiftKey ? Math.max(0, cur - 1) : Math.min(3, cur + 1);
      row.dataset.indent = String(next);
      row.style.paddingLeft = (next * 16) + 'px';
    } else if (e.key === 'Backspace' && txt.value === '') {
      e.preventDefault();
      const prev = row.previousElementSibling;
      row.remove();
      if (prev && prev.classList.contains('note-cl-row')) prev.querySelector('.note-cl-text')?.focus();
    }
  });
  // 拖拽处理器
  row.addEventListener('dragstart', (e) => {
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', row.dataset.itemId); } catch {}
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    container.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
  });
}

function _wireChecklist(container) {
  if (!container) return;
  // 将 + Add 点击代理到容器上，使重新渲染 + 移动端
  // 触摸异常不会让按钮失效。之前直接在按钮上的
  // `addEventListener` 在移动端会静默失效，当
  // _wireChecklist 运行多次（或按钮尚未在 DOM 中）时。
  if (!container._addDelegated) {
    container._addDelegated = true;
    container.addEventListener('click', (ev) => {
      const addBtn = ev.target.closest('.note-cl-add');
      if (!addBtn || !container.contains(addBtn)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const inputs = container.querySelector('.note-checklist-inputs');
      if (!inputs) return;
      const row = document.createElement('div');
      row.className = 'note-cl-row';
      row.draggable = true;
      row.dataset.itemId = _uid();
      row.dataset.indent = '0';
      row.innerHTML = `<span class="note-cl-grip" title="${t('notes.drag')}">⋮⋮</span><span class="note-cl-dot"></span><input type="text" class="note-cl-text" placeholder="${t('notes.item_placeholder')}" /><button type="button" class="note-cl-rm">&times;</button>`;
      inputs.insertBefore(row, addBtn);
      row.querySelector('.note-cl-text').focus();
      _wireRow(row, container);
    });
  }
  container.querySelectorAll('.note-cl-row').forEach(row => _wireRow(row, container));

  // 输入容器上的 dragover 处理器
  const inputs = container.querySelector('.note-checklist-inputs');
  if (inputs) {
    inputs.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = inputs.querySelector('.note-cl-row.dragging');
      if (!dragging) return;
      inputs.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
      const rows = [...inputs.querySelectorAll('.note-cl-row:not(.dragging)')];
      const after = rows.find(r => {
        const box = r.getBoundingClientRect();
        return e.clientY < box.top + box.height / 2;
      });
      if (after) {
        after.classList.add('drop-before');
        inputs.insertBefore(dragging, after);
      } else if (rows.length) {
        rows[rows.length - 1].classList.add('drop-after');
        inputs.insertBefore(dragging, container.querySelector('.note-cl-add'));
      }
    });
    inputs.addEventListener('dragleave', (e) => {
      if (!inputs.contains(e.relatedTarget)) {
        inputs.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
      }
    });
  }
}

function _collectItems(form) {
  const items = [];
  form.querySelectorAll('.note-cl-row').forEach(row => {
    const text = row.querySelector('.note-cl-text')?.value?.trim();
    if (text) items.push({
      id: row.dataset.itemId || _uid(),
      text,
      done: row.classList.contains('done'),
      indent: parseInt(row.dataset.indent || '0'),
    });
  });
  return items;
}

// ---- 绘图模式 (画布) ----

function _buildDrawHtml() {
  return `
    <div class="note-form-draw-wrap">
      <canvas class="note-form-canvas" width="600" height="320"></canvas>
      <div class="note-form-draw-toolbar">
        <input type="color" class="note-form-draw-color" title="${t('notes.stroke_color')}" value="#222222" />
        <label class="note-form-draw-tool note-form-draw-size-wrap" title="${t('notes.stroke_size')}">
          <input type="range" class="note-form-draw-size" min="1" max="24" value="3" />
        </label>
        <div class="note-form-draw-be" role="group">
          <button type="button" class="note-form-draw-be-btn note-form-draw-brush active" data-mode="pen" title="${t('notes.brush')}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04 0-1.67-1.34-3.02-3-3.02z"/></svg>
          </button>
          <button type="button" class="note-form-draw-be-btn note-form-draw-eraser" data-mode="eraser" title="${t('notes.eraser')}">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>
          </button>
        </div>
        <button type="button" class="note-form-draw-text" title="${t('notes.add_text')}">T<span class="note-form-draw-text-badge"></span></button>
        <button type="button" class="note-form-draw-line" title="${t('notes.line')}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="20" x2="20" y2="4"/></svg>
          <span class="note-form-draw-shape-badge"></span>
        </button>
        <button type="button" class="note-form-draw-circle" title="${t('notes.circle')}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>
          <span class="note-form-draw-shape-badge"></span>
        </button>
        <button type="button" class="note-form-draw-undo" title="${t('notes.drawing_undo')}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9"/></svg>
        </button>
      </div>
    </div>
  `;
}

// 将绘图处理器附加到 `container` 内的画布上。可选地加载
// `initialImageUrl` 作为背景，使编辑现有绘图时保留它。
function _wireCanvas(container, initialImageUrl) {
  const canvas = container.querySelector('.note-form-canvas');
  if (!canvas) return;
  // 为 retina 显示器提高后备存储分辨率，使笔触保持
  // 清晰。只设置 style.width — style.height 保持 auto，使画布
  // 通过其固有宽高比均匀缩放。如果两个 CSS 维度
  // 都固定，max-width:100% 只缩小宽度，留下相对于屏幕上输入
  // 明显被拉伸的光栅字形。
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.width;
  const cssH = canvas.height;
  // 将容器宽度填充到逻辑宽度（不要硬 pin 为 600px，
  // 在窄屏幕上这会导致卡片宽度超过视口，
  // 将绘图推到笔记之外）。_pos() 按实际显示宽度缩放指针坐标，
  // 因此任何尺寸下精度都能保持。
  canvas.style.width = '100%';
  canvas.style.maxWidth = cssW + 'px';
  canvas.style.height = 'auto';
  canvas.style.aspectRatio = cssW + ' / ' + cssH;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 加载先前的绘图作为起点，使连续编辑能够组合。
  const safeInitialImageUrl = _safeImgSrc(initialImageUrl);
  if (safeInitialImageUrl) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { try { ctx.drawImage(img, 0, 0, cssW, cssH); } catch {} };
    img.src = safeInitialImageUrl;
    // 在画布上悬浮一个 X 按钮，用户可以将其清除并回到
    // 干净的绘制表面。点击后自动移除。
    const wrap = container.querySelector('.note-form-draw-wrap');
    if (wrap && !wrap.querySelector('.note-form-draw-bg-rm')) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'note-form-draw-bg-rm';
      rm.title = t('notes.clear_photo');
      rm.innerHTML = '&times;';
      rm.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cssW, cssH);
        rm.remove();
      });
      wrap.appendChild(rm);
    }
  }

  const colorInput = container.querySelector('.note-form-draw-color');
  // 将原生浏览器颜色对话框替换为内置的 HSV 拾色器
  //（与主题和画廊编辑器使用的相同）。现有的 `input` 事件
  // 监听器和 .value 读取仍然有效 — 参见 colorPicker.js。
  if (colorInput) attachColorPicker(colorInput);
  const sizeInput = container.querySelector('.note-form-draw-size');
  const beSeg = container.querySelector('.note-form-draw-be');
  const brushBtn = container.querySelector('.note-form-draw-brush');
  const eraserBtn = container.querySelector('.note-form-draw-eraser');
  const textBtn = container.querySelector('.note-form-draw-text');
  const lineBtn = container.querySelector('.note-form-draw-line');
  const circleBtn = container.querySelector('.note-form-draw-circle');
  const undoBtn = container.querySelector('.note-form-draw-undo');
  // 点击/拖拽行为的唯一数据源。其他布尔值由此派生，
  // 因此不会出现"同时处于橡皮擦和文本"的冲突状态
  //（即使用橡皮擦后 T 工具看起来坏掉了的那个 bug）。
  // 模式：'pen' | 'eraser' | 'text-s' | 'text-m' | 'text-l' | 'line' | 'circle'
  let mode = 'pen';
  let drawing = false;
  let last = null;
  // 文本工具有三个预设尺寸（CSS px 字体大小）。
  const TEXT_SIZES = { 's': 16, 'm': 26, 'l': 40 };
  // 线条/圆形描边宽度（逻辑像素）— 三个清晰选项。
  const SHAPE_WIDTHS = { 's': 2, 'm': 5, 'l': 10 };
  // 在形状拖拽开始时拍摄快照，使预览在每次移动时能干净地
  // 重绘，而不会累积中间笔画。
  let _shapeSnapshot = null;

  // 每个画布的撤销栈。在每次操作之前拍摄位图快照（ImageData）
  // — 包括笔画、文本提交或后续操作 — 撤销时弹出并恢复。
  // 上限 30 以控制内存使用。
  const _undoStack = [];
  const UNDO_LIMIT = 30;
  const _snapshot = () => {
    try {
      const w = canvas.width, h = canvas.height;
      _undoStack.push(ctx.getImageData(0, 0, w, h));
      if (_undoStack.length > UNDO_LIMIT) _undoStack.shift();
    } catch {}
  };
  const _undo = () => {
    const prev = _undoStack.pop();
    if (!prev) return;
    // 基于原始后备存储恢复：暂时重置活跃的
    // ctx 缩放，1:1 绘制快照，然后重新应用我们的标准变换。
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(prev, 0, 0);
    ctx.restore();
  };

  const _pos = (e) => {
    // CSS 可以缩小画布（max-width:100%）而不改变其逻辑
    // 尺寸，因此按每个轴计算显示到逻辑的比例。指针坐标
    // 以 CSS 像素为单位；经 dpr 缩放的 ctx 需要逻辑坐标 (cssW × cssH)。
    const r = canvas.getBoundingClientRect();
    const sx = cssW / r.width;
    const sy = cssH / r.height;
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * sx, y: (t.clientY - r.top) * sy };
  };
  const _begin = (e) => {
    if (mode.startsWith('text-')) {
      // 阻止事件，使浏览器不会合成一个后续点击事件
      // 导致我们即将创建的输入框失焦。
      e.preventDefault?.();
      e.stopPropagation?.();
      _openTextInput(e);
      return;
    }
    _snapshot();
    last = _pos(e);
    drawing = true;
    if (mode.startsWith('line-') || mode.startsWith('circle-')) {
      // 捕获底层像素，使预览可以从相同的起始状态
      // 重放每次移动（否则实时形状会累积）。
      try { _shapeSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch {}
      return;
    }
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
  };

  // 在点击位置放置一个 HTML 输入框，让用户可以输入文本，
  // 然后在失焦/按 Enter 时将文本光栅化到画布上。
  // 类似于文档编辑器中 PDF 表单批注的工作方式。
  let _activeTextInput = null;
  const _openTextInput = (e) => {
    // 在创建新输入框之前提交之前未完成的输入框 — 否则
    // 第一次点击会留下一个孤立的输入框，用户会以为"没反应"。
    if (_activeTextInput) { try { _activeTextInput.blur(); } catch {} }
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    // 位置以 wrap 为锚点，而非画布；由于画布是 wrap 的第一个子元素
    // 且 wrap 没有内边距，它们共享相同的原点，因此
    // 可以直接基于画布的 rect 计算偏移。
    const px = t.clientX - r.left;
    const py = t.clientY - r.top;
    const logical = _pos(e);
    // 尺寸由当前激活的 T 变体决定（S/M/L），而非笔画
    // 滑块 — 这是两个独立的控制项。
    const sizeKey = mode.startsWith('text-') ? mode.slice(-1) : 'm';
    const sizeCss = TEXT_SIZES[sizeKey] || TEXT_SIZES.m;
    const wrap = container.querySelector('.note-form-draw-wrap');
    if (!wrap) return;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'note-form-draw-textinput';
    input.placeholder = 'type then Enter';
    const color = colorInput?.value || '#222';
    const maxW = Math.max(120, Math.floor(r.width - px - 4));
    input.style.cssText = [
      'position:absolute',
      `left:${px}px`,
      `top:${Math.max(0, py - sizeCss * 0.7)}px`,
      `font:${sizeCss}px Arial, sans-serif`,
      `color:${color}`,
      'background:#ffffff',
      'border:2px solid var(--accent)',
      'border-radius:4px',
      'outline:none',
      'padding:2px 6px',
      'min-width:120px',
      `max-width:${maxW}px`,
      'z-index:1000',
      'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
      'pointer-events:auto',
    ].join(';');
    wrap.appendChild(input);
    _activeTextInput = input;
    // 同步聚焦，使调用仍算作用户手势内操作
    //（iOS/Android 上需要），然后在下帧重新聚焦，
    // 以防竞态的合成事件（touch → click）将焦点移走。
    input.focus();
    requestAnimationFrame(() => { if (document.activeElement !== input) input.focus(); });
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const text = input.value;
      if (_activeTextInput === input) _activeTextInput = null;
      input.remove();
      if (!text) return;
      // 在光栅化之前快照，使撤销一步移除文字。
      _snapshot();
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = color;
      // 画布现在使用均匀缩放（style.height: auto），因此单个
      // 比例就足以匹配用户在 HTML 输入框中看到的
      // 逻辑字体大小。
      const sx = cssW / r.width;
      const logicalSize = sizeCss * sx;
      ctx.font = `${logicalSize}px sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(text, logical.x, logical.y - logicalSize * 0.7);
      ctx.restore();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      else if (ev.key === 'Escape') { input.value = ''; input.blur(); }
    });
  };
  const _move = (e) => {
    if (!drawing) return;
    e.preventDefault?.();
    const p = _pos(e);
    if (mode.startsWith('line-') || mode.startsWith('circle-')) {
      // 恢复形状绘制前的位图，然后从
      // 锚点到当前指针重绘预览形状。
      if (_shapeSnapshot) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.putImageData(_shapeSnapshot, 0, 0);
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = colorInput?.value || '#222';
      const sizeKey = mode.slice(-1);
      ctx.lineWidth = SHAPE_WIDTHS[sizeKey] || SHAPE_WIDTHS.m;
      ctx.beginPath();
      if (mode.startsWith('line-')) {
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
      } else {
        const dx = p.x - last.x;
        const dy = p.y - last.y;
        const radius = Math.hypot(dx, dy);
        ctx.arc(last.x, last.y, radius, 0, Math.PI * 2);
      }
      ctx.stroke();
      return;
    }
    const erasing = mode === 'eraser';
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
    ctx.strokeStyle = erasing ? 'rgba(0,0,0,1)' : (colorInput?.value || '#222');
    ctx.lineWidth = Number(sizeInput?.value || 3) * (erasing ? 2.5 : 1);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  };
  const _end = () => { drawing = false; last = null; _shapeSnapshot = null; };

  canvas.addEventListener('mousedown', _begin);
  canvas.addEventListener('mousemove', _move);
  window.addEventListener('mouseup', _end);
  // 非被动模式，使文本模式可以 preventDefault — 否则跟随触摸
  // 而来的合成 mousedown/click 事件会使 iOS Safari 上刚创建
  // 的文本输入框失焦，让 T 工具看起来像无效操作。
  canvas.addEventListener('touchstart', (e) => { if (mode.startsWith('text-')) e.preventDefault(); _begin(e); }, { passive: false });
  canvas.addEventListener('touchmove', _move, { passive: false });
  canvas.addEventListener('touchend', _end);
  canvas.addEventListener('touchcancel', _end);

  // 统一的模式设置器 — 保持工具栏、色板和光标同步，
  // 确保退出橡皮擦时恢复用户选择的颜色，无论
  // 是通过点击其他工具还是关闭橡皮擦。
  let _preEraseColor = null;
  const _setMode = (next) => {
    const wasEraser = mode === 'eraser';
    mode = next;
    const isEraser = next === 'eraser';
    const isPen = next === 'pen';
    const isText = next.startsWith('text-');
    // 色板：擦除时变白，离开该模式时立即恢复。
    if (isEraser && !wasEraser && colorInput) {
      _preEraseColor = colorInput.value;
      colorInput.value = '#ffffff';
    } else if (!isEraser && wasEraser && colorInput && _preEraseColor) {
      colorInput.value = _preEraseColor;
      _preEraseColor = null;
    }
    // 画笔/橡皮擦分段按钮 — 滑动到激活的一侧。当非画笔/
    // 橡皮擦工具（T/线条/圆形）激活时，两侧都不高亮，
    // 但按钮仍指示用户上一次选择的是哪一侧，
    // 使其可以一键返回。
    const isLine = next.startsWith('line-');
    const isCircle = next.startsWith('circle-');
    beSeg?.classList.toggle('is-eraser', isEraser);
    brushBtn?.classList.toggle('active', isPen);
    eraserBtn?.classList.toggle('active', isEraser);
    textBtn?.classList.toggle('active', isText);
    lineBtn?.classList.toggle('active', isLine);
    circleBtn?.classList.toggle('active', isCircle);
    // 每个按钮的尺寸徽章 (S/M/L)，由模式后缀驱动。
    const tBadge = textBtn?.querySelector('.note-form-draw-text-badge');
    if (tBadge) tBadge.textContent = isText ? next.slice(-1).toUpperCase() : '';
    const lBadge = lineBtn?.querySelector('.note-form-draw-shape-badge');
    if (lBadge) lBadge.textContent = isLine ? next.slice(-1).toUpperCase() : '';
    const cBadge = circleBtn?.querySelector('.note-form-draw-shape-badge');
    if (cBadge) cBadge.textContent = isCircle ? next.slice(-1).toUpperCase() : '';
    // 在图标中反映所选尺寸 — M/L 加粗线条/圆形笔画，
    // M/L 加大 T 字形。CSS 规则读取 `.size-s/.size-m/.size-l`。
    const _sz = next.slice(-1);
    [textBtn, lineBtn, circleBtn].forEach(b => b?.classList.remove('size-s', 'size-m', 'size-l'));
    if (isText && /[sml]/.test(_sz)) textBtn?.classList.add('size-' + _sz);
    if (isLine && /[sml]/.test(_sz)) lineBtn?.classList.add('size-' + _sz);
    if (isCircle && /[sml]/.test(_sz)) circleBtn?.classList.add('size-' + _sz);
    canvas.style.cursor = isText ? 'text' : 'crosshair';
  };
  brushBtn?.addEventListener('click', () => _setMode('pen'));
  eraserBtn?.addEventListener('click', () => _setMode('eraser'));
  // T / 线条 / 圆形：各自循环三个尺寸，然后回到画笔。
  const _cycle = (prefix) => {
    const seq = ['s', 'm', 'l'];
    if (!mode.startsWith(prefix)) return prefix + 's';
    const cur = mode.slice(-1);
    const next = seq[seq.indexOf(cur) + 1];
    return next ? prefix + next : 'pen';
  };
  textBtn?.addEventListener('click', () => _setMode(_cycle('text-')));
  lineBtn?.addEventListener('click', () => _setMode(_cycle('line-')));
  circleBtn?.addEventListener('click', () => _setMode(_cycle('circle-')));
  undoBtn?.addEventListener('click', () => _undo());

  // 存储以便保存处理器后续可以读取，无需重新解析 DOM。
  canvas._cssW = cssW;
  canvas._cssH = cssH;
  return canvas;
}

// 将画布导出为 PNG dataURL，通过现有的 /api/upload 端点上传，
// 并返回持久 URL。失败时返回 null。
async function _uploadCanvasAsPng(canvas) {
  if (!canvas) return null;
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  if (!blob) return null;
  const fd = new FormData();
  fd.append('files', blob, 'drawing.png');
  try {
    const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = await res.json();
    const id = data.files?.[0]?.id;
    return id ? `${API_BASE}/api/upload/${id}` : null;
  } catch { return null; }
}

// ---- 创建 / 编辑 / 删除 ----

function _createNote(type = 'todo') {
  const body = document.querySelector('#notes-pane .notes-pane-body');
  if (!body || _editingId === '__new__') return;
  _editingId = '__new__';
  // 如果之前关闭/丢失后仍有未保存的新笔记草稿，则恢复。
  const { note: _n, restored } = _applyDraftToNote({ note_type: type }, '__new__');
  const form = _buildForm(_n);
  form.classList.add('note-form-new');
  body.prepend(form);
  form.querySelector('.note-form-title').focus();
  if (restored) uiModule.showToast(t('notes.restored_note'));
}

// 构建笔记的纯文本/markdown 形式以供剪贴板复制。
function _serializeNoteForCopy(note) {
  const lines = [];
  if (note.title) lines.push(note.title);
  if (note.content) lines.push(note.content);
  if (Array.isArray(note.items) && note.items.length) {
    if (lines.length) lines.push('');
    for (const it of note.items) {
      if (!it || !(it.text || '').trim()) continue;
      lines.push(`- [${it.done ? 'x' : ' '}] ${(it.text || '').trim()}`);
    }
  }
  return lines.join('\n').trim();
}

// 将笔记复制到剪贴板，短暂将 btnEl 的图标换为对勾，并
// 提示。由角复制按钮点击和 Ctrl/Cmd+C 快捷键共享。
// ── ⋯ 角菜单（复制 + Agent）───────────────────────────────────
function _openNoteCornerMenu(btn) {
  document.querySelectorAll('.note-corner-menu-dropdown').forEach(d => d.remove());
  const id = btn.dataset.noteId;
  const note = _notes.find(n => n.id === id);
  if (!note) return;
  const menu = document.createElement('div');
  menu.className = 'note-corner-menu-dropdown';
  menu.innerHTML = `
    <button type="button" class="ncm-item" data-act="copy">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      <span>Copy</span>
    </button>
    <button type="button" class="ncm-item" data-act="agent">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>
      <span>${note.agent_session_id ? t('notes.agent_rerun') : t('notes.agent_solve')}</span>
    </button>`;
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  // 右对齐到 ⋯ 按钮，限制在视口内。
  const mw = 168;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  // 默认向下展开；如果下方空间不够则向上翻转
  //（按钮现在位于卡片底部边缘）。
  const mh = menu.offsetHeight || 96;
  const below = window.innerHeight - r.bottom;
  const top = (below < mh + 8 && r.top > mh + 8) ? (r.top - mh - 4) : (r.bottom + 4);
  menu.style.cssText += `position:fixed;z-index:11000;top:${Math.round(top)}px;left:${Math.round(left)}px;`;
  const close = (ev) => {
    if (ev && menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener('click', close, true);
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
  menu.querySelector('[data-act="copy"]').addEventListener('click', () => { menu.remove(); _copyNote(id, btn); });
  menu.querySelector('[data-act="agent"]').addEventListener('click', () => { menu.remove(); _agentSolveNote(id); });
}

// 构建 agent 从笔记获取的提示：标题 + 正文，加上任何
// 尚未完成的清单项目。
function _noteToAgentPrompt(note) {
  const parts = [];
  if ((note.title || '').trim()) parts.push(note.title.trim());
  if ((note.content || '').trim()) parts.push(note.content.trim());
  if (Array.isArray(note.items)) {
    note.items.filter(it => !it.done && (it.text || '').trim())
      .forEach(it => parts.push('- ' + it.text.trim()));
  }
  const body = parts.join('\n');
  return body ? `Help me get this done:\n\n${body}` : '';
}

// Agent 解决：在服务器端创建聊天会话，在后台启动 agent 运行
// （用户留在笔记中），并通过可点击标签将会话
// 链接到笔记。稍后点击标签打开聊天。
async function _agentSolveNote(id) {
  const note = _notes.find(n => n.id === id);
  if (!note) return;
  const prompt = _noteToAgentPrompt(note);
  if (!prompt) { uiModule.showToast(t('notes.agent_nothing')); return; }
  try {
    const dc = await (await fetch(`${API_BASE}/api/default-chat`, { credentials: 'same-origin' })).json();
    if (!dc.endpoint_url || !dc.model) { uiModule.showError(t('notes.agent_no_model')); return; }

    // 1. 在服务端创建会话（不切换 UI）。skip_validation
    //    避免重复探测 — default-chat 端点已知是可用的。
    const label = (note.title || (Array.isArray(note.items) && note.items[0]?.text) || 'todo').slice(0, 40);
    const csFd = new FormData();
    csFd.append('name', 'Agent: ' + label);
    csFd.append('endpoint_url', dc.endpoint_url);
    csFd.append('model', dc.model);
    if (dc.endpoint_id) csFd.append('endpoint_id', dc.endpoint_id);
    csFd.append('skip_validation', 'true');
    const csRes = await fetch(`${API_BASE}/api/session`, { method: 'POST', credentials: 'same-origin', body: csFd });
    if (!csRes.ok) { uiModule.showError(t('notes.agent_no_session')); return; }
    const sess = await csRes.json();
    const sid = sess.id;

    // 2. 立即将会话链接到笔记，使标签出现。
    const n = _notes.find(x => x.id === id);
    if (n) n.agent_session_id = sid;
    _renderNotes();
    _patchNote(id, { agent_session_id: sid }).catch(() => {});

    // 3. 在后台启动 agent 运行。以 agent 模式 POST 到 chat_stream，
    //    并消费 SSE 使服务器运行循环直到
    //    完成并保存 — 不在聊天 UI 中渲染任何内容。
    const fd = new FormData();
    fd.append('message', prompt);
    fd.append('session', sid);
    fd.append('mode', 'agent');
    fetch(`${API_BASE}/api/chat_stream`, { method: 'POST', credentials: 'same-origin', body: fd })
      .then(async (res) => {
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        // 消费至完成（服务器完成 + 持久化运行结果）。
        while (true) { const { done } = await reader.read(); if (done) break; }
        if (window.sessionModule && window.sessionModule.markStreamComplete) {
          try { window.sessionModule.markStreamComplete(sid); } catch {}
        }
      })
      .catch(() => {});

    uiModule.showToast(t('notes.agent_working'));
  } catch (e) {
    uiModule.showError(t('notes.agent_failed') + (e.message || e));
  }
}

async function _copyNote(noteId, btnEl) {
  const note = _notes.find(n => n.id === noteId);
  if (!note) return false;
  const text = _serializeNoteForCopy(note);
  if (!text) return false;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (ok) {
    if (btnEl && !btnEl._copyFlashing) {
      const original = btnEl.innerHTML;
      btnEl._copyFlashing = true;
      btnEl.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      btnEl.classList.add('copied');
      setTimeout(() => {
        btnEl.innerHTML = original;
        btnEl.classList.remove('copied');
        btnEl._copyFlashing = false;
      }, 1200);
    }
    uiModule.showToast?.(t('notes.copied'));
  } else {
    uiModule.showError?.(t('notes.copy_failed'));
  }
  return ok;
}

function _editNote(id) {
  const note = _notes.find(n => n.id === id);
  if (!note) return;
  _editingId = id;
  const card = document.querySelector(`.note-card[data-note-id="${id}"]`);
  if (!card) return;
  // 恢复未保存的草稿（来自之前的连接丢失/关闭），
  // 覆盖已保存的笔记，让用户从上次中断的地方继续。
  const { note: _n, restored } = _applyDraftToNote(note, id);
  const form = _buildForm(_n);
  card.replaceWith(form);
  if (restored) uiModule.showToast(t('notes.restored_changes'));
  // 置顶笔记位于第一个瀑布流列 — 编辑表单有
  // column-span:all，可能导致表单渲染到折叠线以上或
  // 被邻近的置顶卡牌视觉遮挡。将其移到最前面
  //（并提升层叠上下文），使编辑置顶笔记时始终
  // 弹出到顶部。
  form.style.position = 'relative';
  form.style.zIndex = '5';
  // 网格视图：replaceWith 后表单保持 CSS 默认的 `grid-row-end: span 16` (64px)，
  // 这比实际表单短得多。重新计算
  // 瀑布流布局，使表单获得正确的行跨度，卡片不再
  // 重叠。随着用户输入/添加清单项，
  // 内部的 ResizeObserver 通过 _applyMasonry 保持同步。
  const _body = form.closest('.notes-pane-body');
  if (_body) {
    _applyMasonry(_body);
    requestAnimationFrame(() => _applyMasonry(_body));
  }
  requestAnimationFrame(() => {
    try { form.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    catch { form.scrollIntoView(); }
  });
  // 选择最有用的字段来聚焦。尤其在手机上，用户
  // 点击编辑是为了输入 — 如果已经有标题（且可能有正文要补充），
  // 落到标题字段会打断操作节奏。普通笔记优先正文 textarea，
  // 待办优先第一个清单项，均无则回退到标题。
  const _focusBest = () => {
    if (note.note_type === 'note' || !note.note_type) {
      const ta = form.querySelector('.note-form-content');
      if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {} return; }
    }
    if (note.note_type === 'todo' || note.note_type === 'goal' || note.note_type === 'checklist') {
      // 最后一个非空清单行，如果全空则为第一行。
      const rows = form.querySelectorAll('.note-cl-row .note-cl-text');
      let target = null;
      for (const inp of rows) { if ((inp.value || '').trim()) target = inp; }
      target = target || rows[0];
      if (target) { target.focus(); try { target.setSelectionRange(target.value.length, target.value.length); } catch {} return; }
    }
    const titleEl = form.querySelector('.note-form-title');
    if (titleEl) titleEl.focus();
  };
  _focusBest();
}

async function _deleteNote(id) {
  const ok = uiModule?.styledConfirm
    ? await uiModule.styledConfirm(t('notes.delete_note_confirm_single'), { confirmText: t('common.delete'), danger: true })
    : confirm(t('notes.delete_note_confirm_single'));
  if (!ok) return;
  try { await _deleteNoteApi(id); await _fetchNotes(); _renderNotes(); uiModule.showToast(t('notes.deleted_toast')); }
  catch (err) { uiModule.showError(err.message); }
}

// ────────────────────────────────────────────────────────────────────
// 移动端 NOTES UX — 全屏点击编辑 + 长按拖拽排序。
// 在宽度 ≤768px 的触摸设备上，笔记卡片变为只读预览；
// 单次点击在全出血覆盖层中打开笔记（所有真正编辑发生的地方），
// 长按将整个网格翻转为
// 重新排列模式，可以拖动卡片到新的 sort_order。
// ────────────────────────────────────────────────────────────────────

function _isNotesMobileMode() {
  return ('ontouchstart' in window) && window.innerWidth <= 768;
}

// ── 全屏单笔记编辑覆盖层 ──────────────────────────────
let _mobileFsOverlay = null;
let _mobileFsNoteId = null;

function _openMobileFullscreenEdit(id, fromCard) {
  const note = _notes.find(n => n.id === id);
  if (!note) return;
  // 拆除任何先前的覆盖层（防御性）。
  _closeMobileFullscreenEdit({ save: false });
  _mobileFsNoteId = id;
  _editingId = id;

  const overlay = document.createElement('div');
  overlay.className = 'note-fullscreen-overlay';
  overlay.innerHTML = `
    <div class="note-fullscreen-header">
      <button type="button" class="note-fullscreen-back" title="${t('notes.back')}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
      <div class="note-fullscreen-actions"></div>
    </div>
    <div class="note-fullscreen-body"></div>
  `;
  const body = overlay.querySelector('.note-fullscreen-body');
  // 重用内置流程构建的相同编辑表单。保存按钮、
  // 清单切换等均按原样工作。恢复任何未保存的草稿。
  const { note: _n, restored } = _applyDraftToNote(note, id);
  const form = _buildForm(_n);
  body.appendChild(form);
  if (restored) uiModule.showToast(t('notes.restored_changes'));
  document.body.appendChild(overlay);
  _mobileFsOverlay = overlay;

  // 从点击的卡片位置向上动画展开，使过渡看起来
  // 像缩放而非生硬的切换。
  if (fromCard) {
    const r = fromCard.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    overlay.style.transformOrigin =
      `${((r.left + r.width / 2) / vw) * 100}% ${((r.top + r.height / 2) / vh) * 100}%`;
  }
  overlay.classList.add('opening');
  requestAnimationFrame(() => overlay.classList.add('open'));

  // 连接返回按钮 — 保存表单内容并关闭。
  // mousedown preventDefault 防止首次点击时导致输入框失焦
  //（否则会吃掉点击，需要点第二次）。
  const _backBtn = overlay.querySelector('.note-fullscreen-back');
  _backBtn.addEventListener('mousedown', (e) => e.preventDefault());
  _backBtn.addEventListener('click', () => {
    _closeMobileFullscreenEdit({ save: true });
  });

  // 表单内置的取消按钮仅重置内置编辑状态；在
  // 覆盖层上下文中它没有任何可见效果。替换其处理函数，
  // 使取消真正关闭覆盖层而不保存。
  const cancelBtn = form.querySelector('.note-form-cancel');
  if (cancelBtn) {
    const fresh = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(fresh, cancelBtn);
    fresh.addEventListener('mousedown', (e) => e.preventDefault());
    fresh.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _closeMobileFullscreenEdit({ save: false });
    });
  }
  // 内置的保存处理函数执行 API 调用和刷新，但不会
  // 关闭我们的覆盖层。增强它（不要替换 — 原始处理函数是
  // 异步的，替换会丢失 API 调用），在保存和渲染
  // 完成后调度关闭。
  const saveBtn = form.querySelector('.note-form-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      setTimeout(() => _closeMobileFullscreenEdit({ save: false }), 350);
    });
  }
  // 使清单行的拖拽手柄 (⋮⋮) 在触摸设备上真正可用。
  // 表单默认使用 HTML5 原生 draggable，在
  // iOS/Android 上从不触发。为覆盖层内清单中的
  // 每一行连接基于触摸的排序。
  _wireChecklistTouchReorder(form);

  // 对于文本包含 URL 的每个待办行，将裸 <input>
  // 替换为链接化的 <span>，使 URL 可点击。点击非链接
  // 区域则切回输入框进行编辑。
  form.querySelectorAll('.note-cl-row').forEach(_addRowReadMode);

  // 将归档和删除从表单底部的操作行移至
  // 顶部标题栏（返回箭头右侧），使它们
  // 无需滚动即可触达，并释放底部空间给
  // 取消/保存。节点移动时处理函数保持不变。
  const headerActions = overlay.querySelector('.note-fullscreen-actions');
  const archiveBtn = form.querySelector('.note-form-archive-btn');
  const deleteBtn  = form.querySelector('.note-form-delete-btn');
  if (headerActions && archiveBtn) headerActions.appendChild(archiveBtn);
  if (headerActions && deleteBtn)  headerActions.appendChild(deleteBtn);
  // 内置的归档/删除处理函数会重新渲染笔记网格，但
  // 将当前覆盖层留在前面 — 看起来好像什么都没发生。
  // 添加后续监听器关闭覆盖层，使用户
  // 看到操作已生效。
  if (archiveBtn) {
    archiveBtn.addEventListener('click', () => {
      setTimeout(() => _closeMobileFullscreenEdit({ save: false }), 200);
    });
  }
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      // 删除会显示风格化确认对话框 — 给对话框留出解析时间，
      // 再尝试关闭覆盖层。
      setTimeout(() => _closeMobileFullscreenEdit({ save: false }), 500);
    });
  }

  // 将标签输入框塞进底部操作行（取消/更新），
  // 靠左对齐。释放元数据行节省一行空间，
  // 并将所有"退出"控件归为一组。
  const actionsGroup = form.querySelector('.note-form-actions-group');
  const tagsInput    = form.querySelector('.note-form-label');
  if (actionsGroup && tagsInput) {
    actionsGroup.insertBefore(tagsInput, actionsGroup.firstChild);
  }

  // 对于清单类型笔记，将照片（附加图片）按钮移入
  // 与 + 添加按钮相同的行（右侧）— 保持元数据行
  // 整洁，并将相机按钮放在编辑区域拇指触达范围内。
  const addBtn   = form.querySelector('.note-cl-add');
  const photoBtn = form.querySelector('.note-form-photo-btn');
  if (addBtn && photoBtn) {
    const addRow = document.createElement('div');
    addRow.className = 'note-cl-add-row';
    addBtn.parentNode.insertBefore(addRow, addBtn);
    addRow.appendChild(addBtn);
    addRow.appendChild(photoBtn);
    // 点击行上任意位置（空白间隙、虚线边框、
    // "+ 添加"标签）都触发添加。照片按钮保留自己的
    // 点击目标，防止附加图片功能被误触发。
    addRow.addEventListener('click', (e) => {
      if (e.target.closest('.note-form-photo-btn')) return;
      if (e.target === addBtn || addBtn.contains(e.target)) return;
      addBtn.click();
    });
    // 表单的委托"+ 添加"处理函数执行
    //   inputs.insertBefore(newRow, addBtn)
    // — 但 addBtn 已不再是 `.note-checklist-inputs` 的直接子元素，
    // 因为我们已经将它包装了。绑定一个新的处理函数，
    // 执行相同操作但在包装行之前插入，并阻止冒泡
    // 使已失效的委托函数不会运行。
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const inputs = form.querySelector('.note-checklist-inputs');
      if (!inputs) return;
      const newRow = document.createElement('div');
      newRow.className = 'note-cl-row';
      newRow.draggable = true;
      newRow.dataset.itemId = _uid();
      newRow.dataset.indent = '0';
      newRow.innerHTML = `<span class="note-cl-grip" title="${t('notes.drag')}">⋮⋮</span><span class="note-cl-dot"></span><input type="text" class="note-cl-text" placeholder="${t('notes.item_placeholder')}" /><button type="button" class="note-cl-rm">&times;</button>`;
      inputs.insertBefore(newRow, addRow);
      _wireRow(newRow, inputs);
      // 在新添加行的手柄上启用触摸重排。
      _wireChecklistTouchReorder(form);
      newRow.querySelector('.note-cl-text')?.focus();
    }, { capture: true });
  }

  // 普通笔记的阅读模式覆盖层：将内容渲染为带可点击
  // 超链接的 div，叠放在 textarea 上方。点击覆盖层中
  // 非链接区域会隐藏覆盖层并聚焦
  // textarea，让用户开始编辑。点击链接则打开它。
  const ta = form.querySelector('.note-form-content');
  if (ta && (note.content || '').trim()) {
    const reader = document.createElement('div');
    reader.className = 'note-form-content-reader';
    reader.innerHTML = _linkify(note.content || '');
    ta.style.display = 'none';
    ta.insertAdjacentElement('beforebegin', reader);
    reader.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;  // 让链接正常打开
      reader.remove();
      ta.style.display = '';
      // 让浏览器自然地放置光标 — 在 focus() 之后
      // 强制调用 setSelectionRange 会与底层
      // 点击事件产生竞争，导致移动端光标位置不一致。
      ta.focus({ preventScroll: true });
    });
  }

  // 打开已有笔记 → 阅读模式，不弹出键盘。只有
  // 全新笔记（通过 + 按钮创建）才应自动聚焦
  // 输入字段。用户可以点击内容切换到编辑模式。
  //（新笔记创建流程走 _createNote，不走此函数。）
}

function _closeMobileFullscreenEdit(opts = {}) {
  if (!_mobileFsOverlay) return;
  const overlay = _mobileFsOverlay;
  _mobileFsOverlay = null;
  // 如果表单有保存按钮，关闭时点击它，
  // 使用户使用返回箭头而非显式保存时不会丢失编辑内容。
  if (opts.save) {
    const saveBtn = overlay.querySelector('.note-form-save, [data-action="save"]');
    if (saveBtn) try { saveBtn.click(); } catch {}
  }
  overlay.classList.remove('open');
  overlay.classList.add('closing');
  setTimeout(() => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    _mobileFsNoteId = null;
    _editingId = null;
    // 刷新网格，使用户所做的任何保存都反映出来。
    if (opts.save !== false) { _fetchNotes().then(_renderNotes).catch(() => {}); }
  }, 220);
}

// ── 长按拖拽排序 ───────────────────────────────────────
function _bindLongPressDrag(card) {
  let pressTimer = null;
  let startX = 0, startY = 0;
  let armed = false;
  const CANCEL_PX = 8;
  const HOLD_MS = 450;

  card.addEventListener('touchstart', (e) => {
    // 如果触摸点位于真正的交互式子元素上，不要干扰滚动
    //（在移动模式下它们是 CSS 隐藏的，但做防御处理）。
    if (e.target.closest('button, input, a, .note-form')) return;
    if (e.touches.length !== 1) return;
    armed = true;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    // 捕获触摸对象，使定时器回调可以将其传递给
    // _enterDragMode → _beginGrab。手指仍然按着，因此
    // 拖拽在定时器触发时立即开始。
    const heldTouch = { clientX: startX, clientY: startY };
    pressTimer = setTimeout(() => {
      if (!armed) return;
      try { navigator.vibrate?.(15); } catch {}
      _enterDragMode(card, heldTouch);
    }, HOLD_MS);
  }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    if (!armed) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > CANCEL_PX || Math.abs(t.clientY - startY) > CANCEL_PX) {
      armed = false;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }
  }, { passive: true });
  const cancel = () => {
    armed = false;
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };
  card.addEventListener('touchend', cancel, { passive: true });
  card.addEventListener('touchcancel', cancel, { passive: true });
}

// Lift-and-placeholder drag implementation. The dragged card detaches
// from the grid (position:fixed, anchored to the finger) while a same-
// sized placeholder takes its slot. Only the PLACEHOLDER moves between
// siblings as the finger crosses midpoints — the card never re-parents
// during the drag, which eliminates the oscillation/jumping the
// previous swap-on-every-frame implementation had.

let _dragState = null;          // { card, placeholder, grabOffsetX, grabOffsetY, grid, prevStyle }
let _docDragHandlersBound = false;

function _enterDragMode(initialCard, initialTouch) {
  document.body.classList.add('notes-drag-mode');
  document.querySelectorAll('.note-card').forEach(_setupDragForCard);
  if (!_docDragHandlersBound) {
    document.addEventListener('touchmove', _onDocTouchMove, { passive: false });
    document.addEventListener('touchend',  _onDocTouchEnd,  { passive: true });
    document.addEventListener('touchcancel', _onDocTouchEnd, { passive: true });
    _docDragHandlersBound = true;
  }
  // 自动抓取用户长按的卡片 — 手指已经按在上面了，
  // 直接开始拖拽。松开（touchend）
  // 一次性完成排序提交和退出拖拽模式。
  if (initialCard && initialTouch) {
    _beginGrab(initialCard, initialTouch);
  }
}

function _exitDragMode() {
  document.body.classList.remove('notes-drag-mode');
  if (_dragState) {
    // 防御性处理：如果退出在拖拽进行中触发，将卡片弹回。
    _onDocTouchEnd();
  }
  // 保持 _docDragHandlersBound 为 true，使重新进入拖拽模式时重用它们。
}

function _setupDragForCard(card) {
  if (card.dataset.dragBound === '1') return;
  card.dataset.dragBound = '1';
  card.addEventListener('touchstart', (e) => {
    if (!document.body.classList.contains('notes-drag-mode')) return;
    if (e.touches.length !== 1) return;
    if (_dragState) return;
    e.preventDefault();
    e.stopPropagation();
    _beginGrab(card, e.touches[0]);
  }, { passive: false });
}

function _beginGrab(card, touch) {
  const rect = card.getBoundingClientRect();
  const prevStyle = card.getAttribute('style') || '';
  // 占位符填充卡片的旧位置，使网格布局不会重新排列。
  const placeholder = document.createElement('div');
  placeholder.className = 'note-card-placeholder';
  placeholder.style.width = rect.width + 'px';
  placeholder.style.height = rect.height + 'px';
  placeholder.style.margin = getComputedStyle(card).margin;
  if (card.style.gridRowEnd) placeholder.style.gridRowEnd = card.style.gridRowEnd;
  const grid = card.parentNode;
  grid.insertBefore(placeholder, card);

  // 视觉上分离卡片 — 固定定位，锚定到手指。
  card.classList.add('note-card-dragging');
  card.style.position = 'fixed';
  card.style.left = rect.left + 'px';
  card.style.top  = rect.top + 'px';
  card.style.width  = rect.width + 'px';
  card.style.height = rect.height + 'px';
  card.style.margin = '0';
  card.style.zIndex = '10001';
  // pointer-events:none 使 elementFromPoint 看到手指下方的卡片
  card.style.pointerEvents = 'none';

  _dragState = {
    card, placeholder, grid, prevStyle,
    grabOffsetX: touch.clientX - rect.left,
    grabOffsetY: touch.clientY - rect.top,
  };
  try { navigator.vibrate?.(8); } catch {}
}

function _onDocTouchMove(e) {
  if (!_dragState) return;
  if (e.touches.length !== 1) return;
  e.preventDefault();
  const touch = e.touches[0];
  const { card, placeholder, grid } = _dragState;
  card.style.left = (touch.clientX - _dragState.grabOffsetX) + 'px';
  const quickAdd = grid.querySelector('.notes-quick-add');
  const minTop = quickAdd ? quickAdd.getBoundingClientRect().bottom + 4 : grid.getBoundingClientRect().top;
  const maxTop = Math.max(minTop, window.innerHeight - card.getBoundingClientRect().height - 8);
  const nextTop = Math.max(minTop, Math.min(maxTop, touch.clientY - _dragState.grabOffsetY));
  card.style.top = nextTop + 'px';

  const hitY = Math.max(minTop + 1, Math.min(window.innerHeight - 1, touch.clientY));
  const under = document.elementFromPoint(touch.clientX, hitY);
  const target = under && under.closest
    ? under.closest('.note-card:not(.note-card-dragging)')
    : null;
  if (!target || target === card) return;
  if (target.parentNode !== grid) return;

  // 根据手指位于目标哪一半，将占位符（而非卡片）移到
  // 目标的上方或下方。这种迟滞
  // 可以阻止振荡 — 一旦占位符越过某张卡片，
  // 光标必须在相反方向越过该卡片的中点
  // 才能交换回去。
  const tRect = target.getBoundingClientRect();
  const targetMidY = tRect.top + tRect.height / 2;
  if (touch.clientY < targetMidY) {
    if (placeholder.nextElementSibling !== target) {
      grid.insertBefore(placeholder, target);
    }
  } else {
    if (target.nextElementSibling !== placeholder) {
      grid.insertBefore(placeholder, target.nextElementSibling);
    }
  }
}

function _onDocTouchEnd() {
  if (!_dragState) return;
  const { card, placeholder, grid, prevStyle } = _dragState;
  _dragState = null;
  // 将卡片从其当前固定位置动画移动到
  // 占位符所在位置，然后重新归属并清除内联样式。
  // 拖拽模式在动画结束后自动退出 — 释放即完成。
  const phRect = placeholder.getBoundingClientRect();
  card.style.transition = 'left 0.2s ease, top 0.2s ease';
  card.style.left = phRect.left + 'px';
  card.style.top  = phRect.top + 'px';
  setTimeout(() => {
    placeholder.parentNode.insertBefore(card, placeholder);
    placeholder.remove();
    card.classList.remove('note-card-dragging');
    // Restore the card's pre-drag inline styles. Mobile masonry stores
    // grid-row-end inline, and custom backgrounds use inline style too; wiping
    // cssText made dropped cards collapse into neighboring notes in grid view.
    if (prevStyle) card.setAttribute('style', prevStyle);
    else card.removeAttribute('style');
    _applyMasonry(grid);
    _commitNoteReorder();
    // 一次拖拽，一次退出 — 释放完全结束重排会话。
    if (document.body.classList.contains('notes-drag-mode')) {
      document.body.classList.remove('notes-drag-mode');
    }
  }, 210);
}

// 待办项目的逐行阅读模式 — 当值包含 URL 时，将纯 <input>
// 替换为带链接的 <span>，使点击链接
// 打开它而不是仅放置光标。点击非链接区域
// 恢复输入框进行编辑。
function _addRowReadMode(row) {
  const txt = row.querySelector('.note-cl-text');
  if (!txt) return;
  const val = txt.value || '';
  if (!/(https?:\/\/|www\.)/i.test(val)) return;
  if (row.querySelector('.note-cl-text-reader')) return;  // 已连接
  const span = document.createElement('span');
  span.className = 'note-cl-text-reader';
  span.innerHTML = _linkify(val);
  txt.style.display = 'none';
  txt.insertAdjacentElement('beforebegin', span);
  span.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;  // 让链接正常打开
    span.remove();
    txt.style.display = '';
    txt.focus({ preventScroll: true });
  });
}

// ── 触摸拖拽清单行排序（全屏编辑内）────────
// 默认清单拖拽使用 HTML5 `draggable="true"`，仅限桌面鼠标。
// 在每个 `.note-cl-grip` 上连接触摸处理器，
// 使用户可以长按抓取一行并将其拖到清单中的新位置。
// 使用与卡片拖拽相同的拖起-占位符模式
// （在兄弟元素间悬停时不会振荡）。

let _clDrag = null;          // { row, placeholder, container, grabOffsetX, grabOffsetY }
let _clDocBound = false;

function _wireChecklistTouchReorder(form) {
  const container = form.querySelector('.note-checklist-inputs');
  if (!container) return;
  container.querySelectorAll('.note-cl-grip').forEach(grip => {
    if (grip.dataset.touchBound === '1') return;
    grip.dataset.touchBound = '1';
    grip.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const row = grip.closest('.note-cl-row');
      if (!row) return;
      _beginChecklistGrab(row, container, e.touches[0]);
    }, { passive: false });
  });
  if (!_clDocBound) {
    document.addEventListener('touchmove', _onClTouchMove, { passive: false });
    document.addEventListener('touchend',  _onClTouchEnd,  { passive: true });
    document.addEventListener('touchcancel', _onClTouchEnd, { passive: true });
    _clDocBound = true;
  }
}

function _beginChecklistGrab(row, container, touch) {
  if (_clDrag) return;
  const rect = row.getBoundingClientRect();
  const placeholder = document.createElement('div');
  placeholder.className = 'note-cl-row-placeholder';
  placeholder.style.height = rect.height + 'px';
  container.insertBefore(placeholder, row);

  row.classList.add('note-cl-row-dragging');
  row.style.position = 'fixed';
  row.style.left = rect.left + 'px';
  row.style.top  = rect.top + 'px';
  row.style.width = rect.width + 'px';
  row.style.zIndex = '10002';
  row.style.pointerEvents = 'none';

  _clDrag = {
    row, placeholder, container,
    grabOffsetX: touch.clientX - rect.left,
    grabOffsetY: touch.clientY - rect.top,
  };
  try { navigator.vibrate?.(8); } catch {}
}

function _onClTouchMove(e) {
  if (!_clDrag) return;
  if (e.touches.length !== 1) return;
  e.preventDefault();
  const t = e.touches[0];
  const { row, placeholder, container } = _clDrag;
  row.style.left = (t.clientX - _clDrag.grabOffsetX) + 'px';
  row.style.top  = (t.clientY - _clDrag.grabOffsetY) + 'px';

  const under = document.elementFromPoint(t.clientX, t.clientY);
  const target = under && under.closest
    ? under.closest('.note-cl-row:not(.note-cl-row-dragging)')
    : null;
  if (!target || target === row) return;
  if (target.parentNode !== container) return;

  const tRect = target.getBoundingClientRect();
  const targetMidY = tRect.top + tRect.height / 2;
  if (t.clientY < targetMidY) {
    if (placeholder.nextElementSibling !== target) {
      container.insertBefore(placeholder, target);
    }
  } else {
    if (target.nextElementSibling !== placeholder) {
      container.insertBefore(placeholder, target.nextElementSibling);
    }
  }
}

function _onClTouchEnd() {
  if (!_clDrag) return;
  const { row, placeholder } = _clDrag;
  _clDrag = null;
  const phRect = placeholder.getBoundingClientRect();
  row.style.transition = 'left 0.18s ease, top 0.18s ease';
  row.style.left = phRect.left + 'px';
  row.style.top  = phRect.top + 'px';
  setTimeout(() => {
    placeholder.parentNode.insertBefore(row, placeholder);
    placeholder.remove();
    row.classList.remove('note-cl-row-dragging');
    row.style.cssText = '';
    // 顺序作为表单正常保存的一部分持久化（行通过
    // _collectItems 按 DOM 顺序重新序列化）。
  }, 200);
}

async function _commitNoteReorder() {
  const grid = document.querySelector('#notes-pane .notes-pane-body');
  if (!grid) return;
  const ids = Array.from(grid.querySelectorAll('.note-card')).map(c => c.dataset.noteId).filter(Boolean);
  if (!ids.length) return;
  try {
    await fetch(`${API_BASE}/api/notes/reorder`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    // 更新本地 sort_order，使后续渲染与服务器一致。
    ids.forEach((nid, i) => {
      const n = _notes.find(nn => nn.id === nid);
      if (n) n.sort_order = i;
    });
  } catch (e) {
    console.warn('reorder failed', e);
  }
}


// 后台提醒循环 — 无论面板是否打开都运行
async function _initReminders() {
  try {
    const res = await fetch(`${API_BASE}/api/notes`, { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      _notes = data.notes || data || [];
      _startReminderLoop();
    }
  } catch {}
}

// 打开笔记面板并滚动/闪烁匹配的笔记卡片。
// 由 chatRenderer.js 在用户点击 agent 在 manage_notes 创建后发出的
// [View note](#note-<id>) 链接时使用。当找不到卡片时
// 回退到仅打开面板（面板仍在加载中，
// 笔记在其他过滤器中，等等）。
async function openNote(noteId) {
  // 如果面板已打开，openPanel() 会短路并什么都不做
  // — 包括不重新获取 — 因此服务器端新添加的笔记
  // 永远不会显示。当已打开时先关闭强制刷新，
  // 然后重新打开。作为最后手段点击侧边栏 Notes 按钮
  // 即使模块状态失去同步（罕见，但在 HMR 或模态框卡住后见过）
  // 也能保持工作。
  try {
    if (isPanelOpen && isPanelOpen()) {
      closePanel();
      // 给关闭动画一帧的时间来稳定
      await new Promise(r => setTimeout(r, 30));
    }
  } catch (_) {}
  openPanel();
  // openPanel() 异步启动 _fetchNotes()，因此新创建笔记的卡片
  // for newly-created notes may not be in the DOM yet. Also poll the
  // _notes module array directly — if the note IS loaded but the
  // active filter (e.g. archive view) is hiding it, we can still
  // surface a confirmation toast.
  if (!noteId) return;
  let tries = 0;
  const findAndFlash = () => {
    const card = document.querySelector(`.note-card[data-note-id="${noteId}"]`)
      || document.querySelector(`.note-card[data-note-id^="${noteId.slice(0, 8)}"]`);
    if (card) {
      try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
      card.classList.add('note-card-flash');
      setTimeout(() => card.classList.remove('note-card-flash'), 1600);
      return true;
    }
    return false;
  };
  const tryNext = () => {
    if (findAndFlash()) return;
    if (++tries < 20) setTimeout(tryNext, 200);
  };
  setTimeout(tryNext, 120);
}

const notesModule = { openPanel, closePanel, togglePanel, isPanelOpen, openNote, openNotes: openPanel, closeNotes: closePanel, isNotesOpen: isPanelOpen, refreshDueBadge };
export default notesModule;
export { openPanel as openNotes, closePanel as closeNotes, isPanelOpen as isNotesOpen, openNote };
window.notesModule = notesModule;

// 模块加载时启动提醒循环（短暂延迟以便应用先加载完成）
if (typeof window !== 'undefined') {
  setTimeout(_initReminders, 3000);
}
