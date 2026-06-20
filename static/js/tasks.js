/**
 * 任务模块 — 定时循环执行 LLM 提示。
 */

import uiModule from './ui.js';
import markdownModule from './markdown.js';
import * as spinnerModule from './spinner.js';
import { makeWindowDraggable } from './windowDrag.js';
import { sortModelIds } from './modelSort.js';
import { ordinalSuffix } from './util/ordinal.js';

const API_BASE = window.location.origin;
let _open = false;
let _tasksCascadeNext = false;   // 下次渲染时播放多米诺骨牌入场动画
let _tasks = [];
let _tasksFetched = false;   // 首次获取标记 — `false` → 显示加载行而非"暂无任务"
let _escHandler = null;
let _viewingRuns = null; // 查看运行历史时的任务 ID
let _clockInterval = null;

const _DAYS_OF_WEEK_KEYS = ['mon','tue','wed','thu','fri','sat','sun'];

// ---- 接口层 ----

async function _fetchTasks() {
  try {
    const res = await fetch(`${API_BASE}/api/tasks`, { credentials: 'same-origin' });
    const data = await res.json();
    _tasks = data.tasks || [];
  } catch (e) {
    console.error('Failed to fetch tasks:', e);
    _tasks = [];
  }
  _tasksFetched = true;
}

async function _runFirstOpenOnboarding() {
  try {
    const res = await fetch(`${API_BASE}/api/tasks/onboarding`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const state = await res.json();
    if (state.opened) return;

    await fetch(`${API_BASE}/api/tasks/onboarding`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
  } catch (e) {
    console.warn('Tasks onboarding failed:', e);
  }
}

async function _createTask(data) {
  const res = await fetch(`${API_BASE}/api/tasks`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create task');
  return await res.json();
}

async function _updateTask(id, data) {
  const res = await fetch(`${API_BASE}/api/tasks/${id}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update task');
  return await res.json();
}

async function _deleteTask(id) {
  const res = await fetch(`${API_BASE}/api/tasks/${id}`, {
    method: 'DELETE', credentials: 'same-origin',
  });
  if (!res.ok) throw new Error('Failed to delete task');
}

function _taskCardById(id) {
  const safe = (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id).replace(/"/g, '\\"');
  return document.querySelector(`.task-card[data-id="${safe}"]`);
}

function _animateTaskRemoval(ids) {
  const cards = ids.map(_taskCardById).filter(Boolean);
  if (!cards.length) return Promise.resolve();
  for (const card of cards) {
    card.style.maxHeight = `${Math.max(card.getBoundingClientRect().height, card.scrollHeight)}px`;
    card.classList.add('memory-tidy-removing');
  }
  return new Promise(resolve => setTimeout(resolve, 520));
}

async function _pauseTask(id) {
  const res = await fetch(`${API_BASE}/api/tasks/${id}/pause`, {
    method: 'POST', credentials: 'same-origin',
  });
  if (!res.ok) throw new Error('Failed to pause task');
}

async function _resumeTask(id) {
  const res = await fetch(`${API_BASE}/api/tasks/${id}/resume`, {
    method: 'POST', credentials: 'same-origin',
  });
  if (!res.ok) throw new Error('Failed to resume task');
}

async function _runNow(id, force = false) {
  const res = await fetch(`${API_BASE}/api/tasks/${id}/run${force ? '?force=true' : ''}`, {
    method: 'POST', credentials: 'same-origin',
  });
  if (!res.ok) {
    // 暴露后端实际原因 — 409 表示"已在运行"，
    // 404 表示任务不存在等。之前每个错误都显示相同
    // 的通用"触发任务失败"消息，掩盖了实际原因。
    let msg = `Failed to trigger task (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.detail) msg = data.detail;
    } catch (_) {}
    if (res.status === 409) msg = 'Task is already running';
    throw new Error(msg);
  }
}

async function _stopTask(id) {
  const res = await fetch(`${API_BASE}/api/tasks/${id}/stop`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let msg = `Failed to stop task (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.detail) msg = data.detail;
    } catch (_) {}
    throw new Error(msg);
  }
}

async function _fetchRuns(taskId, limit = 10) {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}/runs?limit=${limit}`, {
    credentials: 'same-origin',
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.runs || [];
}

let _outputTargets = null;
async function _fetchOutputTargets() {
  if (_outputTargets) return _outputTargets;
  try {
    const res = await fetch(`${API_BASE}/api/tasks/meta/output-targets`, { credentials: 'same-origin' });
    const data = await res.json();
    _outputTargets = data.targets || [];
  } catch (e) {
    _outputTargets = [{ value: 'session', label: 'Session' }];
  }
  return _outputTargets;
}

let _builtinActions = null;
async function _fetchActions() {
  if (_builtinActions) return _builtinActions;
  try {
    const res = await fetch(`${API_BASE}/api/tasks/meta/actions`, { credentials: 'same-origin' });
    const data = await res.json();
    _builtinActions = data.actions || [];
  } catch (e) {
    _builtinActions = [];
  }
  return _builtinActions;
}

let _urgentEmailSettings = null;
async function _fetchUrgentEmailSettings() {
  if (_urgentEmailSettings) return _urgentEmailSettings;
  try {
    const res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    _urgentEmailSettings = await res.json();
  } catch (e) {
    _urgentEmailSettings = { urgent_email_prompt: '' };
  }
  return _urgentEmailSettings;
}

async function _saveUrgentEmailSettings(prompt) {
  _urgentEmailSettings = {
    ...(_urgentEmailSettings || {}),
    urgent_email_prompt: prompt || '',
  };
  await fetch('/api/auth/settings', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urgent_email_prompt: prompt || '',
    }),
  });
}

let _triggerEvents = null;
async function _fetchEvents() {
  if (_triggerEvents) return _triggerEvents;
  try {
    const res = await fetch(`${API_BASE}/api/tasks/meta/events`, { credentials: 'same-origin' });
    const data = await res.json();
    _triggerEvents = data.events || [];
  } catch (e) {
    _triggerEvents = [];
  }
  return _triggerEvents;
}

// ---- 辅助函数 ----

function _scheduleLabel(task) {
  const tt = task.trigger_type || 'schedule';
  if (tt === 'event') {
    const evtName = (task.trigger_event || 'event').replace(/_/g, ' ');
    const n = task.trigger_count || 1;
    return `Every ${n} ${evtName}${n > 1 ? 's' : ''}`;
  }
  if (tt === 'webhook') return 'Webhook';
  const t = task.scheduled_time || '00:00';
  if (task.schedule === 'cron') return `Cron: ${task.cron_expression || '?'}`;
  if (task.schedule === 'once') {
    if (task.scheduled_date) {
      const d = new Date(task.scheduled_date);
      return `Once on ${d.toLocaleDateString()} at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    return 'Once';
  }
  const localTime = _utcTimeToLocal(t);
  if (task.schedule === 'daily') return `Daily at ${localTime}`;
  if (task.schedule === 'weekly') {
    const day = DAYS_OF_WEEK[task.scheduled_day ?? 0];
    return `Weekly on ${day} at ${localTime}`;
  }
  if (task.schedule === 'monthly') {
    const d = task.scheduled_day ?? 1;
    const suffix = ordinalSuffix(d);
    return `Monthly on ${d}${suffix} at ${localTime}`;
  }
  return task.schedule || '—';
}

function _utcTimeToLocal(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setUTCHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function _localTimeToUtc(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  const uh = String(d.getUTCHours()).padStart(2, '0');
  const um = String(d.getUTCMinutes()).padStart(2, '0');
  return `${uh}:${um}`;
}

function _relativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = Date.now();
  const diff = d - now;
  const abs = Math.abs(diff);
  const past = diff < 0;
  if (abs < 60000) return past ? 'just now' : 'in a moment';
  if (abs < 3600000) {
    const m = Math.round(abs / 60000);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (abs < 86400000) {
    const h = Math.round(abs / 3600000);
    return past ? `${h}h ago` : `in ${h}h`;
  }
  const days = Math.round(abs / 86400000);
  return past ? `${days}d ago` : `in ${days}d`;
}

// 绝对本地时间 — 精确到秒。用于运行历史记录中避免
// 密集运行都显示为"刚刚"。
function _absoluteTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}:${ss}`;
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${mo}/${da} ${hh}:${mm}`;
}

function _statusDot(status) {
  const colors = { active: '#4caf50', paused: '#ff9800', completed: '#888', error: '#f44336' };
  const c = colors[status] || '#888';
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};box-shadow:0 0 6px ${c}, 0 0 3px ${c};flex-shrink:0;position:relative;top:4px;"></span>`;
}

const _TASK_ICONS = {
  // 对话
  tidy_sessions:       '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  // 文档
  tidy_documents:      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  // 记忆
  consolidate_memory:  '<path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/>',
  // 研究
  tidy_research:       '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  // 日历
  tidy_calendar:       '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  // 邮箱
  summarize_emails:    '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  draft_email_replies: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  extract_email_events:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M7 14h5"/><path d="M7 18h8"/>',
  classify_events:    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 15h.01M12 15h.01M16 15h.01"/>',
  learn_sender_signatures:'<path d="M20 6 9 17l-5-5"/><path d="M14 6h6v6"/>',
  check_email_urgency: '<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>',
  // 技能
  test_skills:         '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  audit_skills:        '<path d="M9 11l3 3L22 4"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v15H6.5A2.5 2.5 0 0 0 4 19.5z"/>',
  // 助手
  daily_brief:         '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  // 通用 action 回退
  _action_default:     '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  // LLM 任务回退
  _llm_default:        '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
};

function _taskIcon(task) {
  const action = task.action;
  let path = _TASK_ICONS[action];
  if (!path) {
    path = task.task_type === 'action' ? _TASK_ICONS._action_default : _TASK_ICONS._llm_default;
  }
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4;flex-shrink:0;position:relative;top:-4px;">${path}</svg>`;
}

const _MODEL_BACKED_ACTIONS = new Set([
  'summarize_emails',
  'draft_email_replies',
  'extract_email_events',
  'classify_events',
  'learn_sender_signatures',
  'check_email_urgency',
  'test_skills',
  'audit_skills',
  'consolidate_memory',
]);

function _taskAiMark(task) {
  const kind = task?.task_type || task?.kind || '';
  const action = task?.action || '';
  const aiAction = _MODEL_BACKED_ACTIONS.has(action);
  if (!(kind === 'llm' || kind === 'research' || task?.model || task?.endpointUrl || aiAction)) return '';
  return '<svg class="task-ai-mark" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-label="Uses model" title="Uses model"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg>';
}

// ---- 自定义选择器 ----

function _buildTimePicker(containerId, hour, minute) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap.innerHTML = '';

  const hourSel = document.createElement('select');
  hourSel.className = 'task-form-input task-time-select';
  hourSel.id = containerId + '-hour';
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = String(h).padStart(2, '0');
    if (h === hour) opt.selected = true;
    hourSel.appendChild(opt);
  }

  const sep = document.createElement('span');
  sep.className = 'task-time-sep';
  sep.textContent = ':';

  const minSel = document.createElement('select');
  minSel.className = 'task-form-input task-time-select';
  minSel.id = containerId + '-min';
  for (let m = 0; m < 60; m += 5) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = String(m).padStart(2, '0');
    if (m === minute || (m <= minute && m + 5 > minute)) opt.selected = true;
    minSel.appendChild(opt);
  }

  wrap.appendChild(hourSel);
  wrap.appendChild(sep);
  wrap.appendChild(minSel);
}

function _getTimePickerValue(containerId) {
  const h = parseInt(document.getElementById(containerId + '-hour')?.value ?? '9', 10);
  const m = parseInt(document.getElementById(containerId + '-min')?.value ?? '0', 10);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function _buildDatePicker(containerId, initialDate) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap.innerHTML = '';

  const now = initialDate || new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();

  // 年份选择
  const yearSel = document.createElement('select');
  yearSel.className = 'task-form-input task-date-select';
  yearSel.id = containerId + '-year';
  for (let y = year; y <= year + 2; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === year) opt.selected = true;
    yearSel.appendChild(opt);
  }

  // 月份选择
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthSel = document.createElement('select');
  monthSel.className = 'task-form-input task-date-select';
  monthSel.id = containerId + '-month';
  MONTHS.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = name;
    if (i === month) opt.selected = true;
    monthSel.appendChild(opt);
  });

  // 日期选择
  const daySel = document.createElement('select');
  daySel.className = 'task-form-input task-date-select';
  daySel.id = containerId + '-day';
  function populateDays() {
    const y = parseInt(yearSel.value, 10);
    const m = parseInt(monthSel.value, 10);
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cur = parseInt(daySel.value, 10) || day;
    daySel.innerHTML = '';
    for (let d = 1; d <= daysInMonth; d++) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = String(d).padStart(2, '0');
      if (d === Math.min(cur, daysInMonth)) opt.selected = true;
      daySel.appendChild(opt);
    }
  }
  populateDays();
  yearSel.addEventListener('change', populateDays);
  monthSel.addEventListener('change', populateDays);

  wrap.appendChild(yearSel);
  wrap.appendChild(monthSel);
  wrap.appendChild(daySel);
}

function _getDatePickerValue(containerId) {
  const y = parseInt(document.getElementById(containerId + '-year')?.value, 10);
  const m = parseInt(document.getElementById(containerId + '-month')?.value, 10);
  const d = parseInt(document.getElementById(containerId + '-day')?.value, 10);
  return new Date(y, m, d);
}

// ---- 渲染 ----

const _CATEGORY_MAP = {
  // action -> 分类
  tidy_sessions:        'Chats',
  tidy_documents:       'Documents',
  consolidate_memory:   'Memory',
  tidy_research:        'Research',
  tidy_calendar:        'Calendar',
  classify_events:      'Calendar',
  ping_events:          'Calendar',
  extract_email_events: 'Calendar',
  summarize_emails:           'Email',
  draft_email_replies:        'Email',
  learn_sender_signatures:    'Email',
  check_email_urgency:        'Email',
  daily_brief:                'Assistant',
  test_skills:                'Skills',
  audit_skills:               'Skills',
  ssh_command:          'System',
  run_script:           'System',
  run_local:            'System',
  cookbook_serve:       'Cookbook',
};
// Cookbook serves listed FIRST so a just-saved schedule shows at the
// top instead of scrolling off the bottom of the list. The remaining
// order is preserved for backwards-compatibility with users who've
// learned where things are.
const _CATEGORY_ORDER = ['Cookbook', 'Other', 'Calendar', 'Email', 'Chats', 'Documents', 'Memory', 'Research', 'Skills', 'Assistant', 'System'];
const _CATEGORY_ICONS = {
  Calendar:  '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  Email:     '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  Chats:     '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  Documents: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  Memory:    '<path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/>',
  Research:  '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  Skills:    '<path d="M9 11l3 3L22 4"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v15H6.5A2.5 2.5 0 0 0 4 19.5z"/>',
  Assistant: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 18a5 5 0 0 1 10 0"/>',
  System:    '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  // Cookbook 图标 — 与侧边栏使用的食谱图标匹配。
  Cookbook:  '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  Other:     '<circle cx="12" cy="12" r="3"/>',
};

function _categoryFor(task) {
  if (task.task_type === 'action' && task.action) {
    return _CATEGORY_MAP[task.action] || 'Other';
  }
  // LLM 任务 → 如果关联到成员则为助手，否则为其他
  if (task.task_type === 'llm' || !task.task_type) {
    return task.crew_member_id ? 'Assistant' : 'Other';
  }
  return 'Other';
}

// ---- 多选模式（参照文档库的 Select / 批量操作栏）----
function _taskEnterSelect() {
  _taskSelectMode = true; _taskSelected.clear();
  document.getElementById('tasks-bulk-bar')?.classList.remove('hidden');
  const _sb = document.getElementById('tasks-select-btn');
  if (_sb) { _sb.classList.add('active'); _sb.textContent = 'Cancel'; }
  _taskUpdateBulkCount();
  _renderList();
}
function _taskExitSelect() {
  _taskSelectMode = false; _taskSelected.clear();
  document.getElementById('tasks-bulk-bar')?.classList.add('hidden');
  const _sb = document.getElementById('tasks-select-btn');
  if (_sb) { _sb.classList.remove('active'); _sb.textContent = 'Select'; }
  const sa = document.getElementById('tasks-select-all'); if (sa) sa.checked = false;
  _renderList();
}
function _taskToggleSelectAll() {
  const sa = document.getElementById('tasks-select-all');
  if (!sa) return;
  if (sa.checked) _tasks.forEach(t => _taskSelected.add(t.id)); else _taskSelected.clear();
  _taskUpdateBulkCount();
  _renderList();
}
function _taskUpdateBulkCount() {
  const c = document.getElementById('tasks-selected-count');
  if (c) c.textContent = `${t('tasks.selected_n', { n: _taskSelected.size })}`;
  const del = document.getElementById('tasks-bulk-delete');
  if (del) del.disabled = _taskSelected.size === 0;
}
async function _taskBulkDelete() {
  const ids = [..._taskSelected];
  if (!ids.length) return;
  const ok = uiModule?.styledConfirm
    ? await uiModule.styledConfirm(t('tasks.delete_confirm', { n: ids.length }), { confirmText: t('common.delete'), danger: true })
    : confirm(t('tasks.delete_confirm_short', { n: ids.length }));
  if (!ok) return;
  const results = await Promise.allSettled(ids.map(id => _deleteTask(id)));
  const deletedIds = ids.filter((_, i) => results[i].status === 'fulfilled');
  await _animateTaskRemoval(deletedIds);
  if (uiModule) uiModule.showToast(t('tasks.deleted_n', { n: deletedIds.length }));
  await _fetchTasks();
  _taskExitSelect();  // 清除选择并重新渲染最新列表
}

// 分类过滤标签（文档库风格的标签）— 单选：点击一个只显示
// 该分类，再次点击取消。如果分类数 ≤1 则隐藏。
function _renderTaskChips() {
  const bar = document.getElementById('tasks-filter-chips');
  if (!bar) return;
  const counts = {};
  for (const t of _tasks) { const c = _categoryFor(t); counts[c] = (counts[c] || 0) + 1; }
  const cats = Object.keys(counts).sort((a, b) => {
    const ia = _CATEGORY_ORDER.indexOf(a), ib = _CATEGORY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  if (_taskFilter && !counts[_taskFilter]) _taskFilter = null;
  bar.innerHTML = '';
  bar.style.display = cats.length > 1 ? 'flex' : 'none';
  // 精确的文档库风格：.memory-cat-chip，一个"全部 (N)"标签，
  // 然后每个分类一个带计数的标签。点击"全部"清除过滤。
  const mkChip = (label, value, active) => {
    const b = document.createElement('button');
    b.className = 'memory-cat-chip' + (active ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => { _taskFilter = value; _renderList(); });
    bar.appendChild(b);
  };
  mkChip(`all (${_tasks.length})`, null, !_taskFilter);
  for (const c of cats) mkChip(`${c} (${counts[c]})`, c, _taskFilter === c);
}

const _TASK_CACHE_LABELS = {
  summarize_emails: 'email summaries',
  draft_email_replies: 'AI reply drafts',
  extract_email_events: 'email calendar cache',
  learn_sender_signatures: 'sender signatures',
  check_email_urgency: 'email tags',
};

function _taskClearCacheLabel(taskOrEntry) {
  return _TASK_CACHE_LABELS[taskOrEntry?.action || ''] || '';
}

function _renderList() {
  const list = document.getElementById('tasks-list');
  if (!list) return;
  list.innerHTML = '';
  // 同步计数徽章（标签页 + 标题栏）
  const _tabCount = document.getElementById('tasks-tab-count');
  if (_tabCount) _tabCount.textContent = _tasks.length;
  const _headCount = document.getElementById('tasks-head-count');
  if (_headCount) _headCount.textContent = _tasks.length ? `${_tasks.length} task${_tasks.length !== 1 ? 's' : ''}` : '';

  if (_tasks.length === 0) {
    // 区分"仍在加载"和"确实为空"，让首次渲染显示
    // 应用加载动画（与文档库一致），而不是在请求完成前
    // 显示误导性的"暂无任务"消息。
    if (!_tasksFetched) {
      list.appendChild(spinnerModule.createLoadingRow('Loading…'));
    } else {
      list.innerHTML = '<div style="opacity:0.4;font-size:12px;text-align:center;padding:24px 0;">No tasks yet. Create one to get started.</div>';
    }
    return;
  }

  _renderTaskChips();

  // 按活动分类标签 + 搜索关键词过滤，然后展平为一个
  // 列表（标签标签替代了旧的按分类分组可折叠标题）。
  const q = _taskSearch.trim().toLowerCase();
  const visible = _tasks.filter(t => {
    if (_taskFilter && _categoryFor(t) !== _taskFilter) return false;
    if (q && !(`${t.name} ${t.prompt || ''} ${t.action || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const _statusRank = { active: 0, paused: 1, completed: 2 };
  visible.sort((a, b) => {
    if (_taskSort === 'name') return (a.name || '').localeCompare(b.name || '');
    if (_taskSort === 'status') {
      const sa = _statusRank[a.status] ?? 9, sb = _statusRank[b.status] ?? 9;
      if (sa !== sb) return sa - sb;
      return (a.name || '').localeCompare(b.name || '');
    }
    // 'recent'（默认）：按分类顺序，然后按名称。
    const ia = _CATEGORY_ORDER.indexOf(_categoryFor(a)), ib = _CATEGORY_ORDER.indexOf(_categoryFor(b));
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return (a.name || '').localeCompare(b.name || '');
  });
  if (visible.length === 0) {
    list.innerHTML = '<div style="opacity:0.4;font-size:12px;text-align:center;padding:24px 0;">No matching tasks.</div>';
    return;
  }

  for (const task of visible) {
    const card = document.createElement('div');
    card.className = 'memory-item task-card' + (task.status === 'paused' ? ' task-paused' : '');
    card.dataset.id = task.id;

    // 标题行：图标 + 名称（左）；状态标签 + 箭头/操作（右）。
    // 状态标签替代旧的圆点，同时作为暂停/恢复按钮。
    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
    const statusBadge = task.status === 'paused'
      ? `<span class="task-status-badge task-state-badge task-paused-badge" data-task-status-action="resume" title="Paused - click to resume" style="position:relative;top:4px;"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="7 4 19 12 7 20 7 4"/></svg><span class="task-state-label">paused</span></span>`
      : task.status === 'active'
        ? `<span class="task-status-badge task-state-badge task-active-badge" data-task-status-action="pause" title="Active - click to pause" style="position:relative;top:4px;"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><span class="task-state-label">active</span></span>`
        : '';
    const builtinBadge = task.is_builtin
      ? `<span class="task-builtin-badge${task.is_modified ? ' modified' : ''}" title="${task.is_modified ? 'Built-in task — edited from its default' : 'Built-in task'}">built-in${task.is_modified ? ' · edited' : ''}</span>`
      : '';
    titleRow.innerHTML = `${_taskIcon(task)}<span class="memory-item-title">${_esc(task.name)}</span>${_taskAiMark(task)}${builtinBadge}<span style="flex:1;"></span>${statusBadge}`;

    // … 菜单按钮（悬停显示）
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'memory-item-actions';
    const menuBtn = document.createElement('button');
    menuBtn.className = 'memory-item-btn';
    menuBtn.title = 'Actions';
    menuBtn.style.position = 'relative';
    menuBtn.style.top = '4px';
    menuBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const items = [];
      // Run now 也保留在菜单中（以及卡片上新的 Run 按钮），
      // 方便肌肉记忆的用户 / 移动端长按。
      if (task.status !== 'completed') items.push({ label: 'Run now', icon: '<polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>', action: () => _doRunNow(task.id) });
      items.push({ label: 'Edit', icon: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>', action: () => _showForm(task) });
      if (task.status === 'active') items.push({ label: 'Pause', icon: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>', action: () => _doPause(task.id) });
      else if (task.status === 'paused') items.push({ label: 'Resume', icon: '<polygon points="5 3 19 12 5 21 5 3"/>', action: () => _doResume(task.id) });
      items.push({ label: 'History', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', action: () => _showRunHistory(task.id, task.name) });
      if (task.is_builtin && task.is_modified) {
        items.push({ label: 'Revert to default', icon: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>', action: () => _doRevert(task.id) });
      }
      if (_taskClearCacheLabel(task)) {
        items.push({ label: 'Clear cache', icon: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>', action: () => _doClearTaskCache(task.id, _taskClearCacheLabel(task)) });
      }
      items.push({ label: 'Delete', icon: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>', action: () => _doDelete(task.id), danger: true });
      _showTaskDropdown(menuBtn, items);
    });
    actionsWrap.appendChild(menuBtn);
    // Run now — 从菜单提升到卡片上，一键手动触发。
    // 已完成的任务隐藏（与之前相同的规则）。
    if (task.status !== 'completed') {
      const runBtn = document.createElement('button');
      runBtn.className = 'task-status-badge task-run-now-badge task-card-run-btn';
      runBtn.title = 'Run now';
      runBtn.style.cssText = 'position:relative;top:1px;margin-right:4px;';
      runBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg><span>Run</span>';
      runBtn.addEventListener('click', (e) => { e.stopPropagation(); _doRunNow(task.id); });
      actionsWrap.insertBefore(runBtn, menuBtn);
    }
    titleRow.appendChild(actionsWrap);

    // 内容区域
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;position:relative;top:1px;';

    content.appendChild(titleRow);

    // 精简元信息行（始终可见）：周期 · 下次运行 · 运行次数。
    const metaParts = [_scheduleLabel(task)];
    if (task.next_run && task.status === 'active') metaParts.push('Next: ' + _relativeTime(task.next_run));
    if (task.run_count > 0) metaParts.push(task.run_count + ' run' + (task.run_count !== 1 ? 's' : ''));
    const meta = document.createElement('div');
    meta.className = 'memory-item-meta';
    meta.style.cssText = 'font-size:10px;opacity:0.4;margin-top:-1px;';
    meta.textContent = metaParts.join(' · ');
    content.appendChild(meta);

    const statusPill = titleRow.querySelector('[data-task-status-action]');
    if (statusPill) {
      statusPill.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (statusPill.dataset.taskStatusAction === 'pause') await _doPause(task.id);
        else await _doResume(task.id);
      });
    }

    // 可展开详情（点击显示）— 类似文档库的文档/对话卡片：
    // 额外元信息 + 上次运行结果 + 描述。
    const detail = document.createElement('div');
    detail.style.cssText = 'display:none;margin-top:7px;padding:8px 0 2px;border-top:1px solid var(--border);';
    const extra = [];
    if (task.last_run) extra.push('Last: ' + _relativeTime(task.last_run));
    if (task.output_target && task.output_target !== 'session') extra.push('→ ' + task.output_target.replace(/^mcp__/, '').replace(/__/g, ' › '));
    if (task.model) extra.push('model: ' + (task.model.split('/').pop() || task.model));
    if (extra.length) {
      const ex = document.createElement('div');
      ex.style.cssText = 'font-size:10px;opacity:0.4;margin-bottom:6px;';
      ex.textContent = extra.join(' · ');
      detail.appendChild(ex);
    }
    if (task.last_run_status) {
      const isErr = task.last_run_status === 'error';
      const color = isErr ? 'var(--red,#e06c75)' : 'var(--green,#50fa7b)';
      const result = (task.last_run_result || '').trim();
      const prev = result.length > 200 ? result.slice(0, 200) + '…' : result;
      const lr = document.createElement('div');
      lr.style.cssText = `font-size:11px;margin-bottom:6px;padding:4px 8px;border-left:2px solid ${color};background:color-mix(in srgb, ${color} 8%, transparent);border-radius:2px;line-height:1.4;cursor:pointer;`;
      lr.innerHTML = `<span style="font-weight:600;color:${color};">${isErr ? '✗' : '✓'}</span> <span style="opacity:0.9;">${_esc(prev) || (isErr ? 'Failed (no detail)' : 'Success (no output)')}</span>`;
      lr.title = 'Open full history';
      lr.addEventListener('click', (e) => { e.stopPropagation(); _showRunHistory(task.id, task.name); });
      detail.appendChild(lr);
    }
    const taskType = task.task_type || 'llm';
    const p = task.prompt || '';
    if (p || taskType === 'action') {
      const desc = document.createElement('div');
      desc.style.cssText = 'font-size:11px;opacity:0.6;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;';
      if (taskType === 'action') {
        const am = (_builtinActions || []).find(a => a.name === task.action);
        desc.textContent = am?.description || task.action || '—';
      } else {
        desc.textContent = p;
      }
      detail.appendChild(desc);
    }
    content.appendChild(detail);

    // 选择模式复选框（参照文档库的 .memory-select-cb）。
    if (_taskSelectMode) {
      if (_taskSelected.has(task.id)) card.classList.add('selected');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'memory-select-cb';
      cb.checked = _taskSelected.has(task.id);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        if (cb.checked) _taskSelected.add(task.id); else _taskSelected.delete(task.id);
        card.classList.toggle('selected', cb.checked);
        _taskUpdateBulkCount();
        const sa = document.getElementById('tasks-select-all');
        if (sa) sa.checked = _tasks.length > 0 && _tasks.every(t => _taskSelected.has(t.id));
      });
      titleRow.insertBefore(cb, titleRow.firstChild);
    }

    // 标题行点击：选择模式下切换复选框；否则展开。
    titleRow.addEventListener('click', (e) => {
      if (card._suppressNextClick) return;  // 长按刚打开了菜单
      if (e.target.closest('.memory-item-actions')) return;
      if (_taskSelectMode) {
        if (e.target.classList.contains('memory-select-cb')) return;
        const cb = titleRow.querySelector('.memory-select-cb');
        if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
        return;
      }
      const open = detail.style.display === 'none';
      detail.style.display = open ? '' : 'none';
      card.classList.toggle('expanded', open);
    });

    // 长按（移动端）打开 ⋮ 操作菜单。
    _attachTaskLongPress(card, menuBtn);

    card.appendChild(content);
    list.appendChild(card);
  }
  // Domino-in cascade on the first render-with-cards after opening — same
  // staggered entrance the gallery / document library uses. We consume the
  // flag here OR in the early-return branches above so subsequent re-renders
  // (search, filter, edit) don't replay it. Note: opening with 0 tasks AND
  // hitting the early-return ALSO clears the flag, so creating a first task
  // afterwards won't replay the cascade — keeps the entrance scoped to the
  // very first render of the panel.
  if (_tasksCascadeNext && list.children.length) {
    list.classList.remove('tasks-just-opened');
    void list.offsetWidth;  // 强制回流，使类名在重新添加时重新触发
    list.classList.add('tasks-just-opened');
    setTimeout(() => list.classList.remove('tasks-just-opened'), 900);
  }
  _tasksCascadeNext = false;
}

function _btn(label, onClick) {
  const b = document.createElement('button');
  b.className = 'task-btn';
  b.textContent = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function _esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// 长按任务卡片（移动端）打开其 ⋮ 操作菜单。按住 500ms；
// 手指移动 >10px 或提前松开取消。与文档库保持一致。
function _attachTaskLongPress(card, menuBtn) {
  let hold = null, start = null;
  const cancel = () => { if (hold) { clearTimeout(hold); hold = null; } start = null; };
  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.memory-item-actions, .memory-select-cb, button, a, input')) return;
    start = { x: e.clientX, y: e.clientY };
    hold = setTimeout(() => {
      hold = null;
      card._suppressNextClick = true;
      setTimeout(() => { card._suppressNextClick = false; }, 400);
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
      menuBtn.click();
    }, 500);
  });
  card.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  card.addEventListener('pointerup', cancel);
  card.addEventListener('pointercancel', cancel);
}

function _showTaskDropdown(anchor, items) {
  // 移除任何已存在的下拉菜单
  document.querySelectorAll('.task-dropdown').forEach(d => d.remove());
  const dd = document.createElement('div');
  dd.className = 'task-dropdown';
  dd.style.cssText = 'position:fixed;z-index:100000;background:var(--panel);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.3);padding:4px;min-width:120px;';
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:6px 10px;border:none;background:none;color:var(--fg);font-size:11px;font-family:inherit;cursor:pointer;border-radius:4px;transition:background 0.1s;';
    if (item.danger) btn.style.color = 'var(--color-error)';
    if (item.icon) {
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6;flex-shrink:0;">${item.icon}</svg><span>${item.label}</span>`;
    } else {
      btn.textContent = item.label;
    }
    btn.addEventListener('mouseenter', () => { btn.style.background = 'color-mix(in srgb, var(--fg) 8%, transparent)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
    btn.addEventListener('click', (e) => { e.stopPropagation(); dd.remove(); item.action(); });
    dd.appendChild(btn);
  });
  document.body.appendChild(dd);
  const rect = anchor.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.right - dd.offsetWidth;
  if (left < 8) left = 8;
  if (top + dd.offsetHeight > window.innerHeight - 8) top = rect.top - dd.offsetHeight - 4;
  dd.style.top = top + 'px';
  dd.style.left = left + 'px';
  const openedAt = performance.now();
  const close = (e) => {
    // 忽略打开后 250ms 内的任何点击（防止触摸事件的
    // "幽灵点击"重复在 pointerup 后立即触发并
    // 在用户看到前移除下拉菜单）。
    if (performance.now() - openedAt < 250) return;
    if (!dd.contains(e.target)) { dd.remove(); document.removeEventListener('click', close); }
  };
  // 使用 requestAnimationFrame 确保监听器在当前
  // 指针/点击事件周期冒泡完成后再注册。
  requestAnimationFrame(() => document.addEventListener('click', close));
}

// ---- 预设模板 ----

const _TASK_PRESETS = [
  { label: 'Prompt on schedule',    desc: 'Run a prompt daily, weekly, etc.',             taskType: 'llm',      triggerType: 'schedule' },
  { label: 'Prompt on event',       desc: 'Trigger every N sessions or messages',         taskType: 'llm',      triggerType: 'event' },
  { label: 'Research on schedule',  desc: 'Run deep research on a topic',                 taskType: 'research', triggerType: 'schedule' },
  { label: 'Research on event',     desc: 'Run deep research after app events',           taskType: 'research', triggerType: 'event' },
  { label: 'Action on schedule',    desc: 'Run tidy/cleanup on a timer',                  taskType: 'action',   triggerType: 'schedule' },
  { label: 'Action on event',       desc: 'Run tidy/cleanup every N sessions or messages', taskType: 'action', triggerType: 'event' },
  { label: 'Webhook triggered',     desc: 'Trigger via external HTTP call',               taskType: 'llm',      triggerType: 'webhook' },
];

// 每个预设的图标，按任务/触发类型区分（24x24 描边 SVG）。
function _presetIcon(p) {
  const wrap = (inner) => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4;flex-shrink:0;">${inner}</svg>`;
  if (p.taskType === 'research') return wrap('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>');
  if (p.taskType === 'action') return wrap('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10z"/>'); // 闪光
  if (p.triggerType === 'webhook') return wrap('<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/>'); // 链接
  if (p.triggerType === 'event') return wrap('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'); // 活动脉冲
  return wrap('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'); // 时钟（定时任务）
}

function _showPresetPicker() {
  const modal = document.getElementById('tasks-modal');
  if (!modal) return;
  const body = modal.querySelector('.modal-body');
  if (!body) return;

  let html = '<div class="admin-card" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">';
  html += '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;"><h2 style="margin:0;padding:0;line-height:1;">Add Task</h2></div>';
  html += '<p class="memory-desc" style="position:relative;top:4px;">Describe a task for the AI to draft, or pick a type below to set one up manually.</p>';
  // flex-wrap + min-width:0 on the input lets the row collapse cleanly
  // on narrow modal widths instead of pushing the AI button past the
  // right edge. margin-left:-4px nudges the compose row 4px into the
  // description bar above so the input lines up with it visually.
  html += '<div class="task-ai-compose" style="display:flex;gap:6px;margin:6px 0 10px -4px;flex-wrap:wrap;align-items:center;">'
    + '<input type="text" id="task-ai-input" class="memory-search-input" style="flex:1 1 220px;min-width:0;" placeholder=t('tasks.ai_placeholder') />'
    + '<button class="memory-toolbar-btn active" id="task-ai-btn" title=t('tasks.draft_with_ai_title') style="white-space:nowrap;height:28px;flex:0 0 auto;"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:3px;"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg>${t('tasks.draft_with_ai')}</button>'
    + '</div>';
  html += '<div class="memory-list" style="max-height:none;flex:1;gap:0px;margin-top:2px;padding-right:8px;">';
  _TASK_PRESETS.forEach((p, i) => {
    html += `<button class="memory-item task-card" data-idx="${i}" style="cursor:pointer;text-align:left;width:100%;font-family:inherit;">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:6px;">${_presetIcon(p)}<span class="memory-item-title" style="flex:1;position:relative;top:0px;">${p.label}</span></div>
        <div style="font-size:10px;opacity:0.4;margin-top:-1px;position:relative;top:3px;">${p.desc}</div>
      </div>
    </button>`;
  });
  html += '</div>';
  html += '</div>';
  body.innerHTML = html;

  body.querySelectorAll('.memory-item[data-idx]').forEach(card => {
    card.addEventListener('click', () => {
      const p = _TASK_PRESETS[parseInt(card.dataset.idx, 10)];
      _showForm(null, p.taskType, p.triggerType);
    });
  });
  document.getElementById('task-preset-cancel')?.addEventListener('click', () => _renderMainView());

  // 用自然语言描述任务 → AI 生成结构化任务并打开表单。
  const aiInput = document.getElementById('task-ai-input');
  const aiBtn = document.getElementById('task-ai-btn');
  if (aiBtn && aiInput) {
    aiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); aiBtn.click(); } });
    aiBtn.addEventListener('click', () => _aiDraftTask(aiInput, aiBtn));
  }
}

// ---- 表单 ----

function _showForm(existing, initTaskType, initTriggerType) {
  const modal = document.getElementById('tasks-modal');
  if (!modal) return;
  const body = modal.querySelector('.modal-body');
  if (!body) return;

  const curTaskType = existing?.task_type || initTaskType || 'llm';
  const curTriggerType = existing?.trigger_type || initTriggerType || 'schedule';

  body.innerHTML = `
    <div class="admin-card" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">
        <h2 style="margin:0;padding:0;line-height:1;">${existing?.id ? 'Edit Task' : 'New Task'}</h2>
      </div>
      <p class="memory-desc">${existing?.id ? 'Update this task’s schedule, prompt, and output.' : 'Configure a prompt, research, or action to run automatically.'}</p>
    <div class="task-form" style="flex:1;overflow-y:auto;min-height:0;">
      <label class="task-form-label">Name</label>
      <input type="text" id="task-form-name" class="task-form-input" value="${_esc(existing?.name || '')}" placeholder="${existing ? '' : t('tasks.auto_generated')}" />

      <label class="task-form-label">Type</label>
      <div class="task-form-toggle" id="task-form-type-toggle">
        <button class="task-toggle-btn ${curTaskType === 'llm' ? 'active' : ''}" data-val="llm" style="position:relative;top:-4px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>Prompt</button>
        <button class="task-toggle-btn ${curTaskType === 'research' ? 'active' : ''}" data-val="research" style="position:relative;top:-4px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Research</button>
        <button class="task-toggle-btn ${curTaskType === 'action' ? 'active' : ''}" data-val="action" style="position:relative;top:-4px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Action</button>
      </div>

      <div id="task-form-type-opts"></div>

      <label class="task-form-label">Trigger</label>
      <div class="task-form-toggle" id="task-form-trigger-toggle">
        <button class="task-toggle-btn ${curTriggerType === 'schedule' ? 'active' : ''}" data-val="schedule" style="position:relative;top:-4px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Schedule</button>
        <button class="task-toggle-btn ${curTriggerType === 'event' ? 'active' : ''}" data-val="event" style="position:relative;top:-4px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>Event</button>
        <button class="task-toggle-btn ${curTriggerType === 'webhook' ? 'active' : ''}" data-val="webhook" style="position:relative;top:-4px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Webhook</button>
      </div>

      <div id="task-form-trigger-opts"></div>

      <label class="task-form-label">Output</label>
      <select id="task-form-output" class="task-form-input">
        <option value="session">Session</option>
      </select>

      <label class="task-form-label">Model <span style="opacity:0.5;font-weight:normal;font-size:10px;">(optional — overrides session default)</span></label>
      <select id="task-form-model" class="task-form-input">
        <option value="">Use session default</option>
      </select>

      <label class="task-form-label">Chain</label>
      <select id="task-form-chain" class="task-form-input">
        <option value="">None</option>
      </select>

      <label class="task-form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <input type="checkbox" id="task-form-notif" ${existing && existing.notifications_enabled === false ? '' : 'checked'} style="margin:0;cursor:pointer;">
        <span>Notifications</span>
        <span style="opacity:0.55;font-weight:normal;font-size:10px;">— uncheck to silence completion notifications for this task (helpful for chatty cron jobs)</span>
      </label>

      <div class="task-form-actions">
        <button id="task-form-cancel" class="memory-toolbar-btn"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="vertical-align:-1px;margin-right:4px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Cancel</button>
        <button id="task-form-save" class="memory-toolbar-btn active"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>${existing?.id ? 'Save' : 'Create'}</button>
      </div>
    </div>
    </div>
  `;

  // --- 任务类型切换 ---
  let taskType = curTaskType;
  const typeToggle = document.getElementById('task-form-type-toggle');
  const typeOpts = document.getElementById('task-form-type-opts');

  function renderTypeOpts() {
    typeOpts.innerHTML = '';
    if (taskType === 'llm' || taskType === 'research') {
      const placeholder = taskType === 'research' ? 'What should be researched?' : 'What should the AI do?';
      const _personaOpts = [
        ['', 'Default (no persona)'],
        ['socrates', 'Socrates'],
        ['razor', 'Razor'],
        ['nietzsche', 'Nietzsche'],
        ['spark', 'Spark'],
        ['odysseus', 'Odysseus'],
      ];
      const _curPersona = (existing?.character_id || '').toLowerCase();
      const _personaOptsHtml = _personaOpts.map(([v, label]) =>
        `<option value="${v}" ${v === _curPersona ? 'selected' : ''}>${label}</option>`).join('');
      typeOpts.innerHTML = `
        <label class="task-form-label">${taskType === 'research' ? 'Research question' : 'Prompt'}</label>
        <textarea id="task-form-prompt" class="task-form-input task-form-textarea" rows="4" placeholder="${placeholder}">${existing?.prompt || ''}</textarea>

        <label class="task-form-label">Persona <span style="opacity:0.5;font-weight:normal;font-size:10px;">(optional — biases the output voice)</span></label>
        <select id="task-form-persona" class="task-form-input">${_personaOptsHtml}</select>
      `;
    } else {
      typeOpts.innerHTML = `
        <label class="task-form-label">Action</label>
        <select id="task-form-action" class="task-form-input">
          <option value="">Loading…</option>
        </select>
        <div id="task-form-action-extra"></div>
      `;
      const syncActionExtra = async () => {
        const sel = document.getElementById('task-form-action');
        const extra = document.getElementById('task-form-action-extra');
        if (!sel || !extra) return;
        if (sel.value !== 'check_email_urgency') {
          extra.innerHTML = '';
          return;
        }
        extra.innerHTML = `
          <label class="task-form-label">Email triage rules</label>
          <textarea id="task-form-urgent-email-prompt" class="task-form-input task-form-textarea" rows="4" placeholder=t('tasks.urgent_placeholder')></textarea>
          <div class="memory-desc" style="font-size:11px;margin-top:4px;">Pause/resume and schedule are controlled by this task. It tags urgent, reply-soon, newsletter, marketing, and spam. Urgent/reply-soon emails use your reminder settings.</div>
        `;
        const settings = await _fetchUrgentEmailSettings();
        const promptEl = document.getElementById('task-form-urgent-email-prompt');
        if (promptEl && !promptEl.dataset.loaded) {
          promptEl.value = settings.urgent_email_prompt || '';
          promptEl.dataset.loaded = '1';
        }
        const notifEl = document.getElementById('task-form-notif');
        if (notifEl && !existing?.id) notifEl.checked = false;
      };
      _fetchActions().then(actions => {
        const sel = document.getElementById('task-form-action');
        if (!sel) return;
        sel.innerHTML = '';
        for (const a of actions) {
          const opt = document.createElement('option');
          opt.value = a.name;
          opt.textContent = `${a.name} — ${a.description}`;
          if (existing?.action === a.name) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', syncActionExtra);
        syncActionExtra();
      });
    }
  }

  typeToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.task-toggle-btn');
    if (!btn) return;
    taskType = btn.dataset.val;
    typeToggle.querySelectorAll('.task-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === taskType));
    renderTypeOpts();
  });
  renderTypeOpts();

  // --- 触发类型切换 ---
  let triggerType = curTriggerType;
  const triggerToggle = document.getElementById('task-form-trigger-toggle');
  const triggerOpts = document.getElementById('task-form-trigger-opts');

  function renderTriggerOpts() {
    triggerOpts.innerHTML = '';
    if (triggerType === 'schedule') {
      triggerOpts.innerHTML = `
        <label class="task-form-label">Frequency</label>
        <select id="task-form-schedule" class="task-form-input">
          <option value="daily" ${(!existing || existing.schedule === 'daily') ? 'selected' : ''}>Daily</option>
          <option value="weekly" ${existing?.schedule === 'weekly' ? 'selected' : ''}>Weekly</option>
          <option value="monthly" ${existing?.schedule === 'monthly' ? 'selected' : ''}>Monthly</option>
          <option value="once" ${existing?.schedule === 'once' ? 'selected' : ''}>Once</option>
          <option value="cron" ${existing?.schedule === 'cron' ? 'selected' : ''}>Cron</option>
        </select>
        <div id="task-form-schedule-opts"></div>
        <div id="task-form-time-section">
          <label class="task-form-label">Time</label>
          <div class="task-time-picker" id="task-form-time-wrap"></div>
        </div>
      `;

      // 构建时间选择器
      let initH = 9, initM = 0;
      if (existing && existing.scheduled_time) {
        const [uh, um] = existing.scheduled_time.split(':').map(Number);
        const d = new Date();
        d.setUTCHours(uh, um, 0, 0);
        initH = d.getHours();
        initM = d.getMinutes();
      }
      _buildTimePicker('task-form-time-wrap', initH, initM);

      const schedSelect = document.getElementById('task-form-schedule');
      const schedOpts = document.getElementById('task-form-schedule-opts');

      function updateScheduleOpts() {
        schedOpts.innerHTML = '';
        const sched = schedSelect.value;
        const timeSection = document.getElementById('task-form-time-section');
        if (timeSection) timeSection.style.display = sched === 'cron' ? 'none' : '';
        if (sched === 'weekly') {
          const label = document.createElement('label');
          label.className = 'task-form-label';
          label.textContent = 'Day of week';
          schedOpts.appendChild(label);
          const sel = document.createElement('select');
          sel.id = 'task-form-day';
          sel.className = 'task-form-input';
          DAYS_OF_WEEK.forEach((day, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = day;
            if (existing && existing.scheduled_day === i) opt.selected = true;
            sel.appendChild(opt);
          });
          schedOpts.appendChild(sel);
        } else if (sched === 'monthly') {
          const label = document.createElement('label');
          label.className = 'task-form-label';
          label.textContent = 'Day of month';
          schedOpts.appendChild(label);
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.id = 'task-form-day';
          inp.className = 'task-form-input';
          inp.min = 1; inp.max = 31;
          inp.value = existing?.scheduled_day ?? 1;
          schedOpts.appendChild(inp);
        } else if (sched === 'once') {
          const label = document.createElement('label');
          label.className = 'task-form-label';
          label.textContent = 'Date';
          schedOpts.appendChild(label);
          const dateWrap = document.createElement('div');
          dateWrap.className = 'task-date-picker';
          dateWrap.id = 'task-form-date';
          schedOpts.appendChild(dateWrap);
          _buildDatePicker('task-form-date', existing?.scheduled_date ? new Date(existing.scheduled_date) : new Date());
        } else if (sched === 'cron') {
          const label = document.createElement('label');
          label.className = 'task-form-label';
          label.textContent = 'Cron expression';
          schedOpts.appendChild(label);
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.id = 'task-form-cron';
          inp.className = 'task-form-input';
          inp.placeholder = '*/30 * * * *';
          inp.value = existing?.cron_expression || '';
          schedOpts.appendChild(inp);
          const hint = document.createElement('div');
          hint.style.cssText = 'font-size:10px;opacity:0.4;margin-top:2px;';
          hint.textContent = 'min hour day month weekday — e.g. "0 */2 * * *" = every 2 hours';
          schedOpts.appendChild(hint);
        }
      }
      schedSelect.addEventListener('change', updateScheduleOpts);
      updateScheduleOpts();

    } else if (triggerType === 'event') {
      triggerOpts.innerHTML = `
        <label class="task-form-label">Event</label>
        <select id="task-form-event" class="task-form-input">
          <option value="">Loading…</option>
        </select>
        <label class="task-form-label">Every N occurrences</label>
        <input type="number" id="task-form-trigger-count" class="task-form-input" min="1" max="1000" value="${existing?.trigger_count || 5}" />
      `;
      _fetchEvents().then(events => {
        const sel = document.getElementById('task-form-event');
        if (!sel) return;
        sel.innerHTML = '';
        for (const ev of events) {
          const opt = document.createElement('option');
          opt.value = ev.name;
          opt.textContent = `${ev.name} — ${ev.description}`;
          if (existing?.trigger_event === ev.name) opt.selected = true;
          sel.appendChild(opt);
        }
      });
    } else if (triggerType === 'webhook') {
      if (existing?.webhook_token) {
        const url = `${API_BASE}/api/tasks/${existing.id}/webhook/${existing.webhook_token}`;
        triggerOpts.innerHTML = `
          <label class="task-form-label">Webhook URL</label>
          <div style="display:flex;gap:4px;align-items:center;">
            <input type="text" class="task-form-input" value="${url}" readonly style="flex:1;font-size:11px;opacity:0.8;" id="task-form-webhook-url" />
            <button class="task-btn" id="task-form-webhook-copy" style="white-space:nowrap;">Copy</button>
          </div>
          <div style="font-size:10px;opacity:0.4;margin-top:4px;">POST this URL from any external service to trigger the task. No auth needed.</div>
        `;
        document.getElementById('task-form-webhook-copy')?.addEventListener('click', () => {
          navigator.clipboard.writeText(url);
          if (uiModule) uiModule.showToast('Copied');
        });
      } else {
        triggerOpts.innerHTML = '<div style="font-size:11px;opacity:0.5;margin-top:4px;">Webhook URL will be generated when the task is saved.</div>';
      }
    }
  }

  triggerToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.task-toggle-btn');
    if (!btn) return;
    triggerType = btn.dataset.val;
    triggerToggle.querySelectorAll('.task-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === triggerType));
    renderTriggerOpts();
  });
  renderTriggerOpts();

  // 填充输出目标列表
  _fetchOutputTargets().then(targets => {
    const outputSel = document.getElementById('task-form-output');
    if (!outputSel || targets.length <= 1) return;
    outputSel.innerHTML = '';
    let matchedOutput = false;
    for (const t of targets) {
      const opt = document.createElement('option');
      opt.value = t.value;
      opt.textContent = t.label;
      if (existing?.output_target === t.value) {
        opt.selected = true;
        matchedOutput = true;
      }
      outputSel.appendChild(opt);
    }
    if (existing?.output_target && !matchedOutput) {
      const opt = document.createElement('option');
      opt.value = existing.output_target;
      opt.textContent = existing.output_target.includes('@') ? `Email: ${existing.output_target}` : existing.output_target;
      opt.selected = true;
      outputSel.appendChild(opt);
    }
  });

  // 从 /api/models 填充模型下拉列表。值为 "endpoint_url::model"，
  // 这样单个字段同时编码模型名称和要调用的接口。
  // 空值（选项 0）= 继承会话默认值。
  fetch(`${API_BASE}/api/models`, { credentials: 'same-origin' })
    .then(r => r.json())
    .then(data => {
      const modelSel = document.getElementById('task-form-model');
      if (!modelSel) return;
      const items = (data.items || []).filter(it => (it.model_type || 'llm') === 'llm');
      const curKey = existing?.endpoint_url && existing?.model
        ? `${existing.endpoint_url}::${existing.model}`
        : '';
      for (const it of items) {
        if (it.offline || !it.models || it.models.length === 0) continue;
        const group = document.createElement('optgroup');
        group.label = it.endpoint_name || it.host || 'endpoint';
        const all = sortModelIds([...(it.models || []), ...(it.models_extra || [])]);
        for (const m of all) {
          const opt = document.createElement('option');
          opt.value = `${it.url}::${m}`;
          opt.textContent = m;
          if (opt.value === curKey) opt.selected = true;
          group.appendChild(opt);
        }
        modelSel.appendChild(group);
      }
      // 保留之前设置的配对，即使 /api/models 不再列出
      //（例如接口已禁用）。仍然显示让用户知道已设置。
      if (curKey && modelSel.value !== curKey) {
        const opt = document.createElement('option');
        opt.value = curKey;
        opt.textContent = `${existing.model} ${t('tasks.unlisted_endpoint')}`;
        opt.selected = true;
        modelSel.appendChild(opt);
      }
    })
    .catch(() => {});

  // 填充链式任务下拉列表
  const chainSel = document.getElementById('task-form-chain');
  if (chainSel) {
    const otherTasks = _tasks.filter(t => !existing || t.id !== existing.id);
    for (const t of otherTasks) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      if (existing?.then_task_id === t.id) opt.selected = true;
      chainSel.appendChild(opt);
    }
  }

  // 取消 — 返回任务标签页（保持活跃标签高亮同步）
  document.getElementById('task-form-cancel').addEventListener('click', () => {
    _switchTab('tasks');
  });

  // 表单上的 Esc 回到新建标签的预设选择器（不是任务标签 —
  // 取消按钮会处理）。使用捕获阶段 + stopImmediatePropagation，
  // 防止 app.js 的通用弹窗关闭先关掉整个任务窗口。
  if (window._tasksFormEsc) document.removeEventListener('keydown', window._tasksFormEsc, true);
  window._tasksFormEsc = (e) => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('task-form-save')) {
      // 表单不再存在于 DOM 中——分离以停止泄露
      document.removeEventListener('keydown', window._tasksFormEsc, true);
      window._tasksFormEsc = null;
      return;
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      t.blur();
      return;
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    _showPresetPicker();
  };
  document.addEventListener('keydown', window._tasksFormEsc, true);

  // 保存
  document.getElementById('task-form-save').addEventListener('click', async () => {
    const nameEl = document.getElementById('task-form-name');
    const outputTarget = document.getElementById('task-form-output')?.value || 'session';

    const payload = {
      task_type: taskType,
      trigger_type: triggerType,
      output_target: outputTarget,
    };
    if (nameEl) payload.name = nameEl.value.trim() || undefined;

    // 模型/接口覆盖。空值 = 继承会话默认值。否则值格式为
    // `endpoint_url::model_id`。
    const modelVal = document.getElementById('task-form-model')?.value || '';
    if (modelVal) {
      const idx = modelVal.indexOf('::');
      if (idx > 0) {
        payload.endpoint_url = modelVal.slice(0, idx);
        payload.model = modelVal.slice(idx + 2);
      }
    } else {
      // 显式清空，让之前固定模型的任务恢复默认值。
      payload.endpoint_url = '';
      payload.model = '';
    }

    // 链式任务
    const chainVal = document.getElementById('task-form-chain')?.value;
    payload.then_task_id = chainVal || '';

    // 通知开关 — 默认为 true。
    const notifEl = document.getElementById('task-form-notif');
    if (notifEl) payload.notifications_enabled = !!notifEl.checked;

    // 任务类型特定字段
    if (taskType === 'llm' || taskType === 'research') {
      const prompt = document.getElementById('task-form-prompt')?.value?.trim();
      if (!prompt) {
        if (uiModule) uiModule.showError('Prompt is required');
        return;
      }
      payload.prompt = prompt;
      const personaVal = document.getElementById('task-form-persona')?.value || '';
      payload.character_id = personaVal;
    } else {
      // Non-llm/research tasks: explicitly clear any persona on switch.
      payload.character_id = '';
      const action = document.getElementById('task-form-action')?.value;
      if (!action) {
        if (uiModule) uiModule.showError('Select an action');
        return;
      }
      payload.action = action;
      if (action === 'check_email_urgency') {
        const urgentPrompt = document.getElementById('task-form-urgent-email-prompt')?.value || '';
        try {
          await _saveUrgentEmailSettings(urgentPrompt);
        } catch (e) {
          if (uiModule) uiModule.showError('Failed to save urgency rules');
          return;
        }
      }
    }

    // 触发器特定参数
    if (triggerType === 'schedule') {
      const schedSelect = document.getElementById('task-form-schedule');
      payload.schedule = schedSelect?.value || 'daily';

      if (payload.schedule === 'cron') {
        const cronVal = document.getElementById('task-form-cron')?.value?.trim();
        if (!cronVal) {
          if (uiModule) uiModule.showError('Cron expression is required');
          return;
        }
        payload.cron_expression = cronVal;
      } else {
        const timeVal = _getTimePickerValue('task-form-time-wrap');
        payload.scheduled_time = _localTimeToUtc(timeVal);

        const dayInput = document.getElementById('task-form-day');
        if (dayInput) payload.scheduled_day = parseInt(dayInput.value, 10);

        if (payload.schedule === 'once' && document.getElementById('task-form-date')) {
          const pickedDate = _getDatePickerValue('task-form-date');
          const [h, m] = timeVal.split(':').map(Number);
          pickedDate.setHours(h, m, 0, 0);
          payload.scheduled_date = pickedDate.toISOString();
        }
      }
    } else if (triggerType === 'event') {
      const evSel = document.getElementById('task-form-event');
      const countInput = document.getElementById('task-form-trigger-count');
      if (!evSel?.value) {
        if (uiModule) uiModule.showError('Select an event');
        return;
      }
      payload.trigger_event = evSel.value;
      payload.trigger_count = parseInt(countInput?.value || '5', 10);
    }
    // webhook：无需额外字段，token 由服务端自动生成

    try {
      // 仅当有真实存在的任务（有 id）时才编辑。AI 预填充
      // 传入的草稿无 id → 通过 POST 创建。
      if (existing && existing.id) {
        await _updateTask(existing.id, payload);
        if (uiModule) uiModule.showToast('Task updated');
      } else {
        await _createTask(payload);
        if (uiModule) uiModule.showToast('Task created');
      }
      await _fetchTasks();
      _switchTab('tasks');
    } catch (e) {
      if (uiModule) uiModule.showError(e.message);
    }
  });
}

// ---- 运行历史 ----

async function _showRunHistory(taskId, taskName) {
  _viewingRuns = taskId;
  const modal = document.getElementById('tasks-modal');
  if (!modal) return;
  const body = modal.querySelector('.modal-body');
  if (!body) return;

  body.innerHTML = '';
  body.appendChild(spinnerModule.createLoadingRow('Loading…'));

  const runs = await _fetchRuns(taskId);

  let html = `<div class="task-history-header">
    <button id="task-history-back" class="task-btn">← Back</button>
    <span style="font-size:13px;opacity:0.7;">${_esc(taskName)} — Run history</span>
  </div>`;

  if (runs.length === 0) {
    html += '<div style="opacity:0.4;font-size:12px;text-align:center;padding:24px 0;">No runs yet.</div>';
  } else {
    html += '<div class="task-runs-list">';
    for (const run of runs) {
      const statusClass = run.status === 'success' ? 'task-run-success' : run.status === 'error' ? 'task-run-error' : 'task-run-running';
      html += `<div class="task-run-item ${statusClass}">
        <div class="task-run-item-header">
          ${_statusDot(run.status === 'success' ? 'active' : run.status)}
          <span>${run.status}</span>
          ${run.model ? `<span class="task-run-model" style="font-size:10px;opacity:0.5;">${_esc(run.model.split('/').pop())}</span>` : ''}
          <span class="task-run-time" title="${run.started_at ? _esc(_relativeTime(run.started_at)) : ''}">${run.started_at ? _absoluteTime(run.started_at) : ''}</span>
        </div>
        <div class="task-run-result">${_esc(run.result ? (run.result.length > 300 ? run.result.slice(0, 300) + '…' : run.result) : run.error || '—')}</div>
      </div>`;
    }
    html += '</div>';
  }

  body.innerHTML = html;

  document.getElementById('task-history-back').addEventListener('click', () => {
    _viewingRuns = null;
    _renderMainView();
  });

  // 点击展开/折叠结果
  body.querySelectorAll('.task-run-item').forEach((item, i) => {
    const resultEl = item.querySelector('.task-run-result');
    const run = runs[i];
    if (!run.result || run.result.length <= 300) return;
    let expanded = false;
    resultEl.style.cursor = 'pointer';
    resultEl.addEventListener('click', () => {
      expanded = !expanded;
      resultEl.textContent = expanded ? run.result : run.result.slice(0, 300) + '…';
    });
  });
}

// ---- 操作 ----

async function _doPause(id) {
  try {
    await _pauseTask(id);
    if (uiModule) uiModule.showToast('Task paused');
    await _fetchTasks();
    _renderMainView();
  } catch (e) { if (uiModule) uiModule.showError(e.message); }
}

async function _doResume(id) {
  try {
    await _resumeTask(id);
    if (uiModule) uiModule.showToast('Task resumed');
    await _fetchTasks();
    _renderMainView();
  } catch (e) { if (uiModule) uiModule.showError(e.message); }
}

async function _doRunNow(id, force = false) {
  try {
    await _runNow(id, force);
    if (uiModule) uiModule.showToast(force ? 'Task triggered in parallel' : 'Task triggered');
  } catch (e) {
    // Mirror the polling notification surface so the user sees the same kind
    // of feedback they get for finished/failed tasks — a real browser
    // Notification when permission is granted, toast fallback otherwise.
    const msg = e.message || 'Failed to trigger task';
    let fired = false;
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('Task', { body: msg, tag: 'task-runnow-' + id, icon: '/static/favicon.ico' });
        fired = true;
      }
    } catch (_) {}
    if (!fired && uiModule) uiModule.showError(msg);
  }
}

async function _doDelete(id) {
  const ok = uiModule?.styledConfirm
    ? await uiModule.styledConfirm('Delete this task and all its run history?', { confirmText: t('common.delete'), danger: true })
    : confirm('Delete this task and all its run history?');
  if (!ok) return;
  try {
    await _deleteTask(id);
    await _animateTaskRemoval([id]);
    if (uiModule) uiModule.showToast('Task deleted');
    await _fetchTasks();
    _renderMainView();
  } catch (e) { if (uiModule) uiModule.showError(e.message); }
}

async function _doRevert(id) {
  const ok = uiModule?.styledConfirm
    ? await uiModule.styledConfirm('Revert this built-in task to its default schedule and settings?', { confirmText: 'Revert' })
    : confirm('Revert this built-in task to its default?');
  if (!ok) return;
  try {
    const res = await fetch(`${API_BASE}/api/tasks/${id}/revert`, { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) throw new Error('Failed to revert task');
    if (uiModule) uiModule.showToast('Reverted to default');
    await _fetchTasks();
    _renderMainView();
  } catch (e) { if (uiModule) uiModule.showError(e.message); }
}

async function _doClearTaskCache(id, label = 'cache') {
  const ok = uiModule?.styledConfirm
    ? await uiModule.styledConfirm(`Clear cached ${label} for this task?`, { confirmText: 'Clear' })
    : confirm(`Clear cached ${label} for this task?`);
  if (!ok) return;
  try {
    const res = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(id)}/clear-cache`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
    const n = Object.values(data.cleared || {}).reduce((a, b) => a + Number(b || 0), 0) + Number(data.files || 0);
    if (uiModule) uiModule.showToast(`Cleared ${label}${n ? ` (${n})` : ''}`);
  } catch (e) {
    if (uiModule) uiModule.showError(`Clear cache failed: ${e.message || e}`);
  }
}

async function _doToggleAll() {
  // 如果有任何活动任务 → 暂停全部。否则恢复所有已暂停任务
  const hasActive = _tasks.some(t => t.status === 'active');
  const targets = _tasks.filter(t => t.status === (hasActive ? 'active' : 'paused'));
  if (targets.length === 0) {
    if (uiModule) uiModule.showToast('No tasks to ' + (hasActive ? 'pause' : 'resume'));
    return;
  }
  const verb = hasActive ? 'Pause' : 'Resume';
  let confirmed = true;
  if (uiModule?.styledConfirm) {
    confirmed = await uiModule.styledConfirm(
      `${verb} all ${targets.length} ${hasActive ? 'active' : 'paused'} task(s)?`,
      { confirmText: verb + ' all' }
    );
  } else if (typeof confirm === 'function') {
    confirmed = confirm(`${verb} ${targets.length} task(s)?`);
  }
  if (!confirmed) return;
  let ok = 0, fails = [];
  for (const t of targets) {
    try {
      if (hasActive) await _pauseTask(t.id);
      else await _resumeTask(t.id);
      ok++;
    } catch (e) {
      fails.push(t.name || t.id);
    }
  }
  if (uiModule) {
    if (fails.length === 0) uiModule.showToast(t('tasks.verb_all', { verb: verb, ok: ok }));
    else uiModule.showError(`${verb}d ${ok}/${targets.length} — failed: ${fails.slice(0, 3).join(', ')}`);
  }
  await _fetchTasks();
  _renderMainView();
}

function _syncPauseAllButton() {
  const btn = document.getElementById('tasks-pause-all-btn');
  if (!btn) return;
  const pauseIco = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:3px;"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  const playIco = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:3px;"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
  const hasActive = _tasks.some(t => t.status === 'active');
  const hasPaused = _tasks.some(t => t.status === 'paused');
  if (hasActive) {
    btn.innerHTML = pauseIco + 'Pause all';
    btn.title = 'Pause every active task';
    btn.style.opacity = '1';
    btn.disabled = false;
  } else if (hasPaused) {
    btn.innerHTML = playIco + 'Resume all';
    btn.title = 'Resume every paused task';
    btn.style.opacity = '1';
    btn.disabled = false;
  } else {
    btn.innerHTML = pauseIco + 'Pause all';
    btn.style.opacity = '0.4';
    btn.disabled = true;
  }
}

// ---- 标签页路由 ----

let _activeTab = 'tasks';

function _switchTab(tab) {
  _activeTab = tab;
  const modal = document.getElementById('tasks-modal');
  if (!modal) return;
  modal.querySelectorAll('.tasks-tab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.classList.toggle('active', on);
  });
  if (tab === 'tasks') _renderMainView();
  else if (tab === 'activity') _renderActivityView();
  else if (tab === 'new') _showPresetPicker();
}

// ---- 活动视图（助手会话日志）----

async function _renderActivityView() {
  const modal = document.getElementById('tasks-modal');
  const body = modal?.querySelector('.modal-body');
  if (!body) return;
  body.innerHTML = `
    <div class="admin-card" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">
        <h2 style="margin:0;padding:0;line-height:1;">Activity</h2>
        <button class="memory-toolbar-btn" id="tasks-activity-refresh" title="Refresh" style="margin-left:auto;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg></button>
      </div>
      <p class="memory-desc">Recent task runs across all scheduled tasks.</p>
      <div style="display:flex;align-items:center;gap:6px;margin:6px 0 8px;">
        <input type="text" id="tasks-activity-search" placeholder=t('tasks.filter_activity') class="memory-search-input" style="flex:1;" />
      </div>
      <div class="tasks-activity-filters" id="tasks-activity-chips" style="display:flex;gap:5px;margin-bottom:8px;flex-wrap:wrap;"></div>
      <div id="tasks-activity-list" class="memory-list" style="flex:1;overflow:auto;font-size:13px;"></div>
    </div>
  `;

  document.getElementById('tasks-activity-refresh').addEventListener('click', _renderActivityView);

  // 独占过滤器：点击芯片仅显示该分组（一个类别或
  // 错误）。再次点击活动芯片清除过滤器（显示全部）。
  // 一次最多一个芯片处于活动状态。_solo 保存活动键或 null
  let _afQuery = '';
  let _solo = null;  // 'cat:<分类>' | 'status:error' | null

  const _entryCat = (e) => _categoryLabel(e.taskName);
  const _entryStatus = (e) =>
    (e.status === 'success' || _classifyResult(e.result) === 'ok') ? 'ok'
    : (e.status === 'error' || _classifyResult(e.result) === 'error') ? 'error' : 'info';
  const _isNotification = (e) => e.output_target === 'notification';

  const _matchesSolo = (e) => {
    // 通知行有意从默认的"全部"视图中隐藏——
    // 它们通过专用的"notifications"标签展示，这样嘈杂的
    // 通知流不会淹没其余活动。
    if (!_solo) return !_isNotification(e);
    if (_solo === 'notifications') return _isNotification(e);
    if (_solo.startsWith('cat:')) return _entryCat(e) === _solo.slice(4);
    if (_solo === 'status:error') return _entryStatus(e) === 'error';
    return true;
  };

  const _applyFilter = () => {
    const list = document.getElementById('tasks-activity-list');
    if (!list) return;
    const q = _afQuery.trim().toLowerCase();
    const filtered = _activityEntries.filter(e => {
      if (!_matchesSolo(e)) return false;
      if (q && !(`${e.taskName} ${e.result}`.toLowerCase().includes(q))) return false;
      return true;
    });
    if (filtered.length === 0) {
      list.innerHTML = '<div style="opacity:0.5;padding:12px;">No matching activity.</div>';
      return;
    }
    list.innerHTML = _stackActivityEntries(filtered).map(_renderActivityEntry).join('');
    _wireActivityRows(list);
  };

  const _buildChips = () => {
    const chipBar = document.getElementById('tasks-activity-chips');
    if (!chipBar) return;
    // 存在的不同类别（排除通知——它们有自己
    // 的芯片，并从默认视图中隐藏）。
    const cats = [];
    for (const e of _activityEntries) {
      if (_isNotification(e)) continue;
      const c = _entryCat(e);
      if (!cats.includes(c)) cats.push(c);
    }
    const hasErrors = _activityEntries.some(e => !_isNotification(e) && _entryStatus(e) === 'error');
    // 统计在芯片下实际显示的通知数——应用
    // 当前搜索查询，使计数匹配用户实际看到的内容，而非
    // 误导性的总数。
    const _q = _afQuery.trim().toLowerCase();
    const notifCount = _activityEntries.filter(e =>
      _isNotification(e) && (!_q || `${e.taskName} ${e.result}`.toLowerCase().includes(_q))
    ).length;
    // 活动芯片高亮；当某芯片独占时其余变暗
    // 库风格的 .memory-cat-chip，带有"全部"芯片；活动芯片
    // 高亮。独占选择：点击仅显示该分组。
    const cls = (active) => 'memory-cat-chip' + (active ? ' active' : '');
    let html = `<button class="${cls(!_solo)}" data-key="">all</button>`;
    html += cats.map(c =>
      `<button class="${cls(_solo === 'cat:' + c)}" data-key="cat:${c}">${_escHtml(c)}</button>`
    ).join('');
    if (hasErrors) {
      html += `<button class="${cls(_solo === 'status:error')}" data-key="status:error">errors</button>`;
    }
    if (notifCount) {
      html += `<button class="${cls(_solo === 'notifications')}" data-key="notifications">notifications <span style="opacity:0.6;font-weight:normal;">${notifCount}</span></button>`;
    }
    chipBar.innerHTML = html;
    chipBar.querySelectorAll('.memory-cat-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const key = chip.dataset.key;
        _solo = key ? (_solo === key ? null : key) : null;  // "全部"或再次点击清除
        _buildChips();
        _applyFilter();
      });
    });
  };

  const searchEl = document.getElementById('tasks-activity-search');
  if (searchEl) searchEl.addEventListener('input', () => { _afQuery = searchEl.value; _buildChips(); _applyFilter(); });

  const _actList = document.getElementById('tasks-activity-list');
  if (_activityEntries.length) {
    _buildChips();
    _applyFilter();
  } else if (_actList) {
    _actList.appendChild(spinnerModule.createLoadingRow('Loading…'));
  }

  try {
    const res = await fetch(`${API_BASE}/api/tasks/runs/recent?limit=100`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const runs = data.runs || [];
    const list = document.getElementById('tasks-activity-list');
    if (!list) return;
    if (runs.length === 0) {
      list.innerHTML = '<div style="opacity:0.5;padding:12px;">No activity yet. Scheduled tasks will log here once they run.</div>';
      return;
    }
    _activityEntries = runs.map(r => {
      let resultText = r.result || r.error || '';
      if (!resultText) {
        if (r.status === 'queued')  resultText = '_Queued — waiting for a free slot…_';
        if (r.status === 'running') resultText = '_Running…_';
      }
      return {
        // 暴露实际的 task_type（'llm' | 'research' | 'action'），使
        // _renderActivityEntry 中的"是否值得聊天"检查能区分"在聊天中打开"
        //（llm/research）和"复制日志"（action）。之前硬编码为
        // 'task'，从未匹配，导致"在聊天中打开"成为死代码。
        kind: r.task_type || 'llm',
        taskName: r.task_name || (r.task_type === 'action' ? (r.action || 'Action') : 'Task'),
        taskId: r.task_id,
        action: r.action || '',
        result: resultText,
        prompt: '',
        ts: r.finished_at || r.started_at,
        status: r.status,
        model: r.model || '',
        endpointUrl: r.endpoint_url || '',
        sessionId: r.session_id || '',
        researchId: r.research_id || '',
        output_target: r.output_target || 'session',
      };
    });
    _buildChips();
    _applyFilter();
  } catch (e) {
    const list = document.getElementById('tasks-activity-list');
    if (list) list.innerHTML = `<div style="opacity:0.5;padding:12px;">Failed to load activity: ${_escHtml(e.message || String(e))}</div>`;
  }
}

let _activityEntries = [];

function _stackActivityEntries(entries) {
  const out = [];
  const byKey = new Map();
  const hourBucket = (ts) => {
    const d = ts ? new Date(ts) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    d.setMinutes(0, 0, 0);
    return d.toISOString();
  };
  const normalizeResult = (entry) => {
    const text = (entry.result || '').trim();
    if (/^Email\b/i.test(entry.taskName || '')) {
      if (/^skipped\s*[—-]/i.test(text) || /\bNo recent emails\b/i.test(text)) {
        return text.replace(/\d+/g, '#');
      }
      return '__email_run__';
    }
    return text;
  };
  for (const entry of entries) {
    const key = [
      entry.taskId || '',
      entry.taskName || '',
      entry.kind || '',
      entry.status || '',
      entry.output_target || '',
      normalizeResult(entry),
      /^Email\b/i.test(entry.taskName || '') ? hourBucket(entry.ts) : '',
    ].join('\u0001');
    const existing = byKey.get(key);
    if (existing && entry.status !== 'running' && entry.status !== 'queued') {
      existing.repeatCount = (existing.repeatCount || 1) + 1;
      continue;
    }
    const stacked = { ...entry, repeatCount: 1, sourceIdx: _activityEntries.indexOf(entry) };
    byKey.set(key, stacked);
    out.push(stacked);
  }
  return out;
}

// "5s" / "1分23秒" / "2时14分" — 与活动时间戳相同的紧凑阶梯格式
function _fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

// 单一 1 秒间隔时钟驱动所有运行中行的已用时间计数器
// 运行行出现时懒加载启动，没有剩余时清除
let _activityTimerInterval = null;
function _startActivityTimers(root) {
  // Tick once immediately so the freshly-rendered row jumps to the right
  // value before the interval fires.
  _tickActivityTimers(root || document);
  if (_activityTimerInterval) return;
  _activityTimerInterval = setInterval(() => {
    if (!_tickActivityTimers(document)) {
      // 不再有活跃行——停止间隔以节省时钟
      clearInterval(_activityTimerInterval);
      _activityTimerInterval = null;
    }
  }, 1000);
}
function _tickActivityTimers(root) {
  const els = (root || document).querySelectorAll('.task-log-running-elapsed[data-since]');
  if (!els.length) return false;
  const now = Date.now();
  els.forEach(el => {
    const since = parseInt(el.dataset.since, 10);
    if (since) el.textContent = _fmtElapsed(now - since);
  });
  return true;
}

// 绑定行交互：展开切换 + "在聊天中打开"
function _wireActivityRows(list) {
  // Replace the [data-spin-here] placeholders in running/queued rows with the
  // app's whirlpool spinner element (createElement, with a stop hook so the
  // poll's next render clears them cleanly).
  list.querySelectorAll('[data-spin-here]').forEach(slot => {
    try {
      const wp = spinnerModule.createWhirlpool(12);
      // Right-side placement (next to the "Running" label) — small left
      // margin to separate from the text, no right margin so the spinner
      // sits flush with the row's right edge.
      wp.element.style.cssText = 'display:inline-flex;width:12px;height:12px;margin:0 0 0 6px;vertical-align:middle;';
      slot.replaceWith(wp.element);
    } catch (_) {
      slot.textContent = '…';
    }
  });
  // 启动实时计时器间隔（仅运行中的行——排队行没有
  // 计数器）。无内容需要计时时为空操作。
  _startActivityTimers(list);
  list.querySelectorAll('.task-log-row').forEach(row => {
    // 点击行上任意位置切换展开
    // 内部按钮仍通过 stopPropagation 获得自己的处理器
    if (!row.classList.contains('is-skipped')) {
      row.addEventListener('click', () => row.classList.toggle('expanded'));
    }
    row.querySelector('.task-log-row-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      row.classList.toggle('expanded');
    });
    row.querySelector('.task-log-open-chat')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(row.dataset.entryIdx, 10);
      const entry = _activityEntries[idx];
      if (entry) _openResultInChat(entry);
    });
    row.querySelector('.task-log-open-report')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(row.dataset.entryIdx, 10);
      const entry = _activityEntries[idx];
      if (entry?.researchId) window.open(`${API_BASE}/api/research/report/${encodeURIComponent(entry.researchId)}`, '_blank');
    });
    row.querySelector('.task-log-force-run')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(row.dataset.entryIdx, 10);
      const entry = _activityEntries[idx];
      if (entry?.taskId) _doRunNow(entry.taskId, true);
    });
    row.querySelector('.task-log-stop')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(row.dataset.entryIdx, 10);
      const entry = _activityEntries[idx];
      if (!entry?.taskId) return;
      try {
        await _stopTask(entry.taskId);
        uiModule.showToast('Task stopped');
        _renderActivityView();
      } catch (err) {
        uiModule.showError(err.message || 'Failed to stop task');
      }
    });
    row.querySelector('.task-log-run-again')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(row.dataset.entryIdx, 10);
      const entry = _activityEntries[idx];
      if (entry?.taskId) _doRunNow(entry.taskId);
    });
    row.querySelector('.task-log-copy')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(row.dataset.entryIdx, 10);
      const entry = _activityEntries[idx];
      if (!entry) return;
      const txt = `${entry.taskName || ''}\n${entry.result || ''}`.trim();
      try {
        uiModule.copyToClipboard(txt);
        uiModule.showToast('Log copied');
      } catch (_) { uiModule.showError('Copy failed'); }
    });
    row.querySelector('.task-log-clear-cache')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(row.dataset.entryIdx, 10);
      const entry = _activityEntries[idx];
      if (entry?.taskId) _doClearTaskCache(entry.taskId, _taskClearCacheLabel(entry));
    });
  });
}

// 在新聊天会话中打开任务运行结果，以便全宽舒适阅读
// 且用户可以追问后续问题。
async function _openResultInChat(entry) {
  try {
    // 选择端点/模型。优先选择任务实际运行所用的模型
    //（如果当前可达），否则回退到第一个在线
    // 端点。用户可以在聊天中随时切换模型。
    let url = '', model = '', epId = '';
    const items = (() => {
      try { return (window.modelsModule && window.modelsModule.getCachedItems) ? window.modelsModule.getCachedItems() : []; }
      catch { return []; }
    })();
    if (entry.model) {
      // 查找服务于该任务模型的在线端点
      const match = items.find(it => !it.offline && (it.models || []).includes(entry.model));
      if (match) { url = match.url; model = entry.model; epId = match.endpoint_id || ''; }
      else if (entry.endpointUrl) {
        // 端点已知但不在实时列表中（如 cookbook 模型
        // 当前未提供服务）——仍尝试使用 skip_validation。
        url = entry.endpointUrl; model = entry.model;
      }
    }
    if (!url) {
      try {
        const dcRes = await fetch(`${API_BASE}/api/default-chat`, { credentials: 'same-origin' });
        const dc = dcRes.ok ? await dcRes.json() : {};
        url = dc.endpoint_url || '';
        model = dc.model || model || '';
        epId = dc.endpoint_id || '';
      } catch (_) {}
    }
    if (!url) {
      // 跳过 embedding/tts/whisper/moderation/image 模型——它们无法聊天，
      // 且端点可能将其中一个列在前面（如 text-embedding-ada-002）。
      const _isChatModel = (m) => {
        const l = (m || '').toLowerCase();
        return !!l && !['text-embedding', 'embedding', 'tts-', 'whisper', 'text-moderation', 'moderation-', 'dall-e', 'rerank'].some(p => l.includes(p));
      };
      const online = items.find(it => !it.offline && (it.models || []).some(_isChatModel))
        || items.find(it => !it.offline && (it.models || []).length);
      if (online) {
        url = online.url;
        model = (online.models || []).find(_isChatModel) || (online.models || [])[0];
        epId = online.endpoint_id || '';
      }
    }

    const fd = new FormData();
    fd.append('name', `Task: ${entry.taskName}`.slice(0, 60));
    fd.append('skip_validation', 'true');
    if (url) fd.append('endpoint_url', url);
    if (model) fd.append('model', model);
    if (epId) fd.append('endpoint_id', epId);
    const res = await fetch(`${API_BASE}/api/session`, { method: 'POST', credentials: 'same-origin', body: fd });
    if (!res.ok) { uiModule.showToast(t('tasks.couldnt_create_chat', { status: res.status })); return; }
    const sess = await res.json();
    const sid = sess.id || sess.session_id;
    if (!sid) { uiModule.showToast('Chat created but no session id returned'); return; }

    // 种子对话：一个框架用户行 + 结果作为助手
    await fetch(`${API_BASE}/api/session/${sid}/inject_messages`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [
        { role: 'user', content: `Here is the latest run of my scheduled task "${entry.taskName}". Let's review it.` },
        { role: 'assistant', content: entry.result || '(no output)' },
      ] }),
    });

    closeTasks();
    if (window.sessionModule) {
      if (window.sessionModule.loadSessions) await window.sessionModule.loadSessions();
      if (window.sessionModule.selectSession) window.sessionModule.selectSession(sid);
    }
  } catch (e) {
    uiModule.showToast(t('tasks.open_chat_failed', { msg: e.message || e }));
  }
}

function _classifyResult(text) {
  const t = (text || '').toLowerCase();
  if (/\b(error|failed|failure|exception|traceback|could not|couldn't)\b/.test(t)) return 'error';
  if (/\b(done|completed|success|ok|finished)\b/.test(t)) return 'ok';
  return 'info';
}

// Category → fixed hue. Anything that doesn't match a keyword gets a stable
// hue derived from the task name's hash, so a recurring custom task keeps
// the same color from one run to the next.
const _CATEGORY_HUES = [
  { hue: 210, kw: /\b(email|inbox|mail|smtp|imap|reply|summary|spam|urgency)\b/i },     // 蓝色   — 邮箱
  { hue: 280, kw: /\b(research|web ?search|deep[-_ ]research|sources?|investigate)\b/i },// 紫色   — 研究
  { hue:  35, kw: /\b(cookbook|model[-_ ]?(serve|download)|hf|huggingface|vllm|llama|ollama)\b/i }, // 琥珀色 — cookbook
  { hue: 150, kw: /\b(calendar|event|meeting|appointment|schedule)\b/i },                // 绿色   — 日历
  { hue: 330, kw: /\b(reminder|note|notify|alert)\b/i },                                 // 粉色   — 提醒
  { hue:  10, kw: /\b(check[-_ ]?in|morning|evening|daily|standup)\b/i },                // 红色   — 签到
  { hue: 190, kw: /\b(memory|memories|remember|recall)\b/i },                            // 青色   — 记忆
];

function _hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function _categoryHue(taskName, kind) {
  if (kind === 'you') return 220;          // 用户消息 — 中性蓝灰
  const t = (taskName || '').toLowerCase();
  for (const c of _CATEGORY_HUES) {
    if (c.kw.test(t)) return c.hue;
  }
  return _hashHue(t || 'task');
}

// 活动过滤器芯片的粗略类别标签。镜像
// 色相关键字组，使芯片颜色匹配行的条纹。
const _CATEGORY_LABELS = [
  { label: 'email',     kw: /\b(email|inbox|mail|smtp|imap|reply|spam|urgency)\b/i },
  { label: 'research',  kw: /\b(research|web ?search|deep[-_ ]research|sources?|investigate)\b/i },
  { label: 'cookbook',  kw: /\b(cookbook|model[-_ ]?(serve|download)|hf|huggingface|vllm|llama|ollama)\b/i },
  { label: 'calendar',  kw: /\b(calendar|event|meeting|appointment|schedule)\b/i },
  { label: 'reminders', kw: /\b(reminder|note|notify|alert)\b/i },
  { label: 'check-in',  kw: /\b(check[-_ ]?in|morning|evening|daily|standup)\b/i },
  { label: 'memory',    kw: /\b(memory|memories|remember|recall)\b/i },
];
function _categoryLabel(taskName) {
  const t = (taskName || '').toLowerCase();
  for (const c of _CATEGORY_LABELS) if (c.kw.test(t)) return c.label;
  return 'other';
}

function _renderActivityEntry(entry) {
  // 到 _activityEntries 的规范索引（map() 传递的是筛选后的
  // 索引，那会是错的）——由"在聊天中打开"处理器使用。
  const entryIdx = Number.isInteger(entry.sourceIdx) ? entry.sourceIdx : _activityEntries.indexOf(entry);
  const repeatBadge = entry.repeatCount > 1
    ? `<span class="task-log-repeat" title="${entry.repeatCount} similar activity rows">+${entry.repeatCount - 1} repeats</span>`
    : '';
  const tsLabel = _relativeTime(entry.ts);
  const tsAbs = entry.ts ? new Date(entry.ts).toLocaleString() : '';
  // 优先使用运行自身的状态（排队/运行中/成功/错误/已跳过）
  // 而非启发式文本分类。对于缺少 entry.status 的旧行，
  // 回退到文本扫描。
  let status;
  if (entry.status === 'queued' || entry.status === 'running' || entry.status === 'skipped' || entry.status === 'aborted') {
    status = entry.status;
  } else if (entry.status === 'error') {
    status = 'error';
  } else if (entry.status === 'success') {
    status = 'ok';
  } else {
    status = _classifyResult(entry.result);
  }
  const statusDot = `<span class="task-log-status task-log-status-${status}" title="${status}"></span>`;
  // 通过 markdown 渲染结果，使代码块、列表、链接显示正确
  let resultHtml;
  const _isRunning = entry.status === 'running' || entry.status === 'queued';
  // 跳过的（空操作）行：渲染为细窄的暗淡单行——无正文，无
  // 操作按钮，仅 `· 名称 · 跳过 — 原因 · 时间`。CSS 通过 .is-skipped 控制。
  const _isSkipped = entry.status === 'skipped';
  if (_isRunning && !(entry.result || '').trim()) {
    resultHtml = '';
  } else {
    try {
      resultHtml = markdownModule.processWithThinking(markdownModule.squashOutsideCode(entry.result || ''));
    } catch {
      resultHtml = `<pre style="white-space:pre-wrap;word-break:break-word;">${_escHtml(entry.result || '')}</pre>`;
    }
  }
  // 像 "[Default] No recent emails" 这样的方括号前缀——跨账号的展开
  // 会合并每个账号的结果。将它们样式化为紧凑的强调标签，
  // 使活动行显示为"<标签> 消息"而非大段方括号。
  // 跳过 <pre>/<code> 块：bash 输出/追踪/编号列表经常
  // 包含 "\n[N] ..." 序列，否则会被前缀正则乱码。
  {
    const tagRe = /(^|<p>|<br\s*\/?>|\n)\[([^\]\n<>]{1,40})\]\s*/g;
    const replaceTags = (s) => s.replace(tagRe, '$1<span class="task-log-account-tag">$2</span> ');
    // 在完整的 <pre>...</pre> 块上分割（每块贪婪匹配）；仅
    // 仅转换 <pre> 块之外的部分。然后对在外层文本中剩下的
    // 任何内联 <code>...</code> 跨度做同样处理。
    const parts = resultHtml.split(/(<pre[\s\S]*?<\/pre>)/i);
    resultHtml = parts.map((seg, i) => {
      if (i % 2 === 1) return seg;  // 奇数索引 = <pre>…</pre> 块，保持原样
      const codeParts = seg.split(/(<code[\s\S]*?<\/code>)/i);
      return codeParts.map((cs, j) => j % 2 === 1 ? cs : replaceTags(cs)).join('');
    }).join('');
  }
  const lineCount = (entry.result || '').split('\n').length;
  const long = (entry.result || '').length > 600 || lineCount > 8;
  const promptHtml = entry.prompt
    ? `<details class="task-log-prompt"><summary>Prompt</summary><pre>${_escHtml(entry.prompt)}</pre></details>`
    : '';
  const hue = _categoryHue(entry.taskName, entry.kind);
  // CSS 变量提供彩色标题 + 强调条纹
  const styleVars = `--cat-hue:${hue};`;
  const _runningPlaceholder = /^(Starting…|Starting\.\.\.|_Running…_|_Running\.\.\._|_Queued\b)/i.test((entry.result || '').trim());
  const hasResult = !!(entry.result && entry.result.trim() && entry.status !== 'running' && entry.status !== 'queued');
  const hasRunningProgress = !!(entry.result && entry.result.trim() && !_runningPlaceholder && (entry.status === 'running' || entry.status === 'queued'));
  // "Open in chat" only makes sense for runs whose result is a real assistant
  //（Prompt/Research 任务）。Action/event 运行只是日志行
  //（如"No recent emails"、"Tidied N memories"）——对此将其替换为
  // button with "Copy log" so you can grab the text without spawning a chat
  // with nothing useful in it.
  const _isChatWorthy = entry.kind === 'llm' || entry.kind === 'research';
  let actionBtn = '';
  if (hasResult && _isChatWorthy) {
    actionBtn = `<button class="task-log-open-chat" type="button" title="Open this result in a chat to read full-width + ask follow-ups">
         <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
         Open in chat
       </button>`;
    if (entry.kind === 'research' && entry.researchId) {
      actionBtn += `<button class="task-log-open-report" type="button" title="Open the visual research report">
         <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>
         Visual report
       </button>`;
    }
  } else if (hasResult) {
    actionBtn = `<button class="task-log-copy" type="button" title="Copy this log entry">
         <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
         Copy log
       </button>`;
  }
  const clearLabel = _taskClearCacheLabel(entry);
  if (hasResult && clearLabel && entry.taskId) {
    actionBtn += `<button class="task-log-clear-cache" type="button" title="Clear cached ${_escHtml(clearLabel)} for this task">
         <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
         Clear cache
       </button>`;
  }
  if (hasResult && entry.taskId) {
    actionBtn += `<button class="task-log-run-again" type="button" title="Run this task again">
         <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
         Run again
       </button>`;
  }
  // 运行中的行将右侧相对时间替换为"Running NN" +
  // 实时漩涡旋转器。排队显示"Queued"同理（无计时器——
  // 尚未真正开始）。行进入 DOM 后通过
  // `_startActivityTimers` 每秒更新已用时间计数器。
  let rightHtml;
  if (_isRunning) {
    const isQueued = entry.status === 'queued';
    // 首次渲染的初始已用时间；下方 1 秒间隔使其保持更新。
    const startMs = entry.ts ? new Date(entry.ts).getTime() : Date.now();
    const stale = !isQueued && (Date.now() - startMs) > 30 * 60 * 1000;
    const label = isQueued ? 'Queued' : stale ? 'Still running' : 'Running';
    const elapsedInit = isQueued ? '' : `<span class="task-log-running-elapsed" data-since="${startMs}">${_fmtElapsed(Date.now() - startMs)}</span>`;
    const forceBtn = isQueued && entry.taskId ? `<button class="task-log-force-run" type="button" title="Start now in parallel, bypassing the queue"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg><span>Start now</span></button>` : '';
    const stopBtn = entry.taskId ? `<button class="task-log-stop" type="button" title="Stop this task"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>` : '';
    rightHtml = `<span class="task-log-running-inline"><span class="task-log-running-label">${label}</span>${elapsedInit}<span data-spin-here="1"></span>${forceBtn}${stopBtn}</span>`;
  } else {
    rightHtml = `<span class="task-log-time" title="${_escHtml(tsAbs)}">${_escHtml(tsLabel)}</span>`;
  }

  // 跳过的（空操作）行细长变体——单行，无正文，无操作，
  // 变暗。原因（entry.result，如"no pings due"）内联显示，
  // 用户无需展开即可看到该行*为何*被跳过。
  if (_isSkipped) {
    const reason = (entry.result || '').trim();
    return `
      <div class="task-log-row is-skipped" data-kind="${_escHtml(entry.kind)}" data-entry-idx="${entryIdx}" style="${styleVars}">
        <div class="task-log-row-head">
          ${statusDot}
          <span class="task-log-task-icon">${_taskIcon({ action: entry.action, task_type: entry.kind })}</span>
          <span class="task-log-name">${_escHtml(entry.taskName)}</span>${_taskAiMark(entry)}
          ${repeatBadge}
          <span class="task-log-skipped-reason">skipped${reason ? ' — ' + _escHtml(reason) : ''}</span>
          <span class="task-log-time" title="${_escHtml(tsAbs)}">${_escHtml(tsLabel)}</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="task-log-row${long ? ' is-long' : ''}${_isRunning ? ' is-running' : ''}" data-kind="${_escHtml(entry.kind)}" data-entry-idx="${entryIdx}" style="${styleVars}">
      <div class="task-log-row-head">
        ${statusDot}
        <span class="task-log-task-icon">${_taskIcon({ action: entry.action, task_type: entry.kind })}</span>
        <span class="task-log-name">${_escHtml(entry.taskName)}</span>${_taskAiMark(entry)}
        ${repeatBadge}
        <span style="flex:1"></span>
        ${rightHtml}
      </div>
      ${(_isRunning && !hasRunningProgress) ? '' : `<div class="task-log-row-body">${resultHtml}</div>`}
      ${promptHtml}
      <div class="task-log-row-actions">
        ${long ? '<button class="task-log-row-toggle" type="button">Show more</button>' : '<span></span>'}
        ${actionBtn}
      </div>
    </div>
  `;
}

function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- 主视图 ----

// 任务列表视图状态——搜索查询 + 活动类别标签 + 选择模式
let _taskSearch = '';
let _taskFilter = null;
let _taskSort = 'recent';
let _taskSelectMode = false;
const _taskSelected = new Set();

async function _aiDraftTask(inputEl, btnEl) {
  const desc = (inputEl.value || '').trim();
  if (!desc) { inputEl.focus(); return; }
  const origHtml = btnEl.innerHTML;
  btnEl.disabled = true;
  btnEl.classList.add('spinning');
  btnEl.textContent = '';
  // 匹配整理按钮的静默漩涡旋转器
  const _sp = spinnerModule.create('', 'clean', 'whirlpool');
  const _spEl = _sp.createElement();
  _spEl.style.position = 'relative';
  _spEl.style.top = '1px';
  btnEl.appendChild(_spEl);
  _sp.start();
  try {
    const res = await fetch(`${API_BASE}/api/tasks/parse`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc }),
    });
    const data = await res.json();
    if (!data.success || !data.draft) {
      if (uiModule) uiModule.showError(data.message || 'Could not draft task');
      return;
    }
    const draft = data.draft;
    // 表单将 scheduled_time 视为 UTC（它将 UTC→本地转换给
    // 选择器）。AI 返回的是本地时间，所以在此将 local→UTC 转换，
    // 使往返后落在预期的本地时间。
    if (draft.scheduled_time) {
      try { draft.scheduled_time = _localTimeToUtc(draft.scheduled_time); } catch (_) {}
    }
    // 将草稿作为合成的"现有"（无 id）传递→表单预填充所有
    // 字段，但保存时仍通过 POST 创建。
    _showForm(draft, draft.task_type, draft.trigger_type || 'schedule');
  } catch (e) {
    if (uiModule) uiModule.showError('AI draft failed: ' + (e.message || e));
  } finally {
    try { _sp.stop(); } catch (_) {}
    btnEl.classList.remove('spinning');
    btnEl.disabled = false;
    btnEl.innerHTML = origHtml;
  }
}

function _renderMainView() {
  const modal = document.getElementById('tasks-modal');
  if (!modal) return;
  const body = modal.querySelector('.modal-body');
  if (!body) return;

  body.innerHTML = `
    <div class="admin-card" style="flex:1;display:flex;flex-direction:column;overflow:hidden;position:relative;top:-2px;">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">
        <h2 style="margin:0;padding:0;line-height:1;position:relative;top:-4px;">Ongoing Tasks <span id="tasks-head-count" class="memory-count" style="font-size:0.6em;opacity:0.6;font-weight:normal"></span></h2>
        <button class="memory-toolbar-btn" id="tasks-pause-all-btn" title="Pause all active tasks" style="margin-left:auto;">Pause all</button>
      </div>
      <p class="memory-desc" style="position:relative;top:-4px;">Scheduled prompts and actions that run automatically. Results appear in a dedicated session.</p>
      <div class="memory-toolbar">
        <div class="memory-category-filters" style="display:flex;align-items:center;gap:6px;">
          <select class="memory-sort-select" id="tasks-sort" aria-label="Sort tasks" title="Sort tasks" style="position:relative;top:-4px;width:86px;font-size:11px;height:24px;">
            <option value="recent">Recent</option>
            <option value="name">A–Z</option>
            <option value="status">Status</option>
          </select>
          <button class="memory-toolbar-btn" id="tasks-select-btn" title="Select tasks" style="position:relative;top:-7px;">Select</button>
        </div>
        <input type="text" id="tasks-search" placeholder=t('tasks.search_tasks') class="memory-search-input" value="${_esc(_taskSearch)}" style="position:relative;top:-4px;" />
      </div>
      <div id="tasks-bulk-bar" class="memory-bulk-bar${_taskSelectMode ? '' : ' hidden'}" style="position:relative;top:-4px;">
        <label class="memory-bulk-check-all" style="position:relative;top:0px;"><input type="checkbox" id="tasks-select-all" /> All</label>
        <span id="tasks-selected-count">0 Selected</span>
        <button id="tasks-bulk-delete" class="memory-toolbar-btn danger" style="position:relative;top:-2px;" disabled><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>Delete</button>
        <button id="tasks-bulk-cancel" class="memory-toolbar-btn" title="Cancel (Esc)" style="margin-left:4px;padding:3px 6px;position:relative;top:-2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div id="tasks-filter-chips" class="tasks-activity-filters" style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px;position:relative;top:-4px;"></div>
      <div id="tasks-list" class="memory-list" style="flex:1;gap:4px;position:relative;top:-4px;"></div>
    </div>
  `;

  const searchEl = document.getElementById('tasks-search');
  if (searchEl) searchEl.addEventListener('input', () => { _taskSearch = searchEl.value; _renderList(); });

  const sortEl = document.getElementById('tasks-sort');
  if (sortEl) { sortEl.value = _taskSort; sortEl.addEventListener('change', () => { _taskSort = sortEl.value; _renderList(); }); }

  const selectBtn = document.getElementById('tasks-select-btn');
  if (selectBtn) {
    selectBtn.classList.toggle('active', _taskSelectMode);
    selectBtn.addEventListener('click', () => _taskSelectMode ? _taskExitSelect() : _taskEnterSelect());
  }
  document.getElementById('tasks-pause-all-btn')?.addEventListener('click', () => _doToggleAll());
  document.getElementById('tasks-select-all')?.addEventListener('change', _taskToggleSelectAll);
  document.getElementById('tasks-bulk-cancel')?.addEventListener('click', _taskExitSelect);
  document.getElementById('tasks-bulk-delete')?.addEventListener('click', _taskBulkDelete);

  _renderList();
  _syncPauseAllButton();
  // 懒加载动作描述，使列表可在每个动作任务下显示它们。
  // 到达后重新渲染（如果已缓存则为空操作）。
  if (!_builtinActions) {
    _fetchActions().then(() => {
      if (document.getElementById('tasks-list')) _renderList();
    });
  }
}

// ---- 弹窗 ----

export function openTasks(focusId, opts) {
  const o = opts || {};
  if (_open) {
    // Already open — just focus the requested task / apply filter.
    if (o.filter !== undefined) { _taskFilter = o.filter; _renderList(); }
    if (focusId) _focusTask(focusId);
    return;
  }
  if (o.filter !== undefined) _taskFilter = o.filter;
  _pendingFocusTaskId = focusId || null;
  _open = true;
  _tasksCascadeNext = true;
  _viewingRuns = null;
  _outputTargets = null; // 刷新可用目标
  _builtinActions = null;
  _triggerEvents = null;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'tasks-modal';
  modal.innerHTML = `
    <div class="modal-content tasks-modal-content">
      <div class="modal-header">
        <h4 style="position:relative;top:-2px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3L2 6"/><path d="M22 6l-3-3"/></svg>Tasks</h4>
        <span style="flex:1"></span>
        <button class="close-btn" id="tasks-close">✖</button>
      </div>
      <div class="memory-tabs tasks-tabs" role="tablist">
        <button class="memory-tab tasks-tab active" data-tab="tasks" role="tab" aria-selected="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          Tasks <span id="tasks-tab-count" class="memory-count" style="font-size:0.8em;opacity:0.6;font-weight:normal;margin-left:4px">0</span>
        </button>
        <button class="memory-tab tasks-tab" data-tab="activity" role="tab" aria-selected="false">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          Activity
        </button>
        <button class="memory-tab tasks-tab" data-tab="new" role="tab" aria-selected="false">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          Add
        </button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:10px;overflow:hidden;"></div>
      <div class="tasks-clock" id="tasks-clock"></div>
    </div>
  `;
  document.body.appendChild(modal);

  // 标签路由
  modal.querySelectorAll('.tasks-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
  });

  // 实时时钟
  function _tickClock() {
    const el = document.getElementById('tasks-clock');
    if (!el) return;
    const now = new Date();
    const day = now.toLocaleDateString([], { weekday: 'long' });
    const date = now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const local = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.textContent = `${day}, ${date} · ${local}`;
  }
  _tickClock();
  _clockInterval = setInterval(_tickClock, 1000);

  // 设为可拖拽——共享辅助函数处理拖拽 + 左/右停靠 + 全屏
  {
    const content = modal.querySelector('.modal-content');
    const header = modal.querySelector('.modal-header');
    if (content && header) {
      makeWindowDraggable(modal, { content, header });
    }
  }

  // 事件
  document.getElementById('tasks-close').addEventListener('click', closeTasks);
  // "Pause all" + "Select" 现在位于主视图子标题中（在 _renderMainView 中绑定）。

  modal.addEventListener('click', (e) => {
    if (uiModule.isTouchInsideModal()) return;
    if (e.target === modal) closeTasks();
  });

  _escHandler = (e) => {
    if (e.key === 'Escape') {
      if (_viewingRuns) {
        _viewingRuns = null;
        _renderMainView();
        return;
      }
      // 如果我们在新任务表单的"添加"标签页中（预设已
      // 选定），回退到预设选择器而不是关闭弹窗。
      // 检测方式：添加标签页处于活动状态 + 表单的名称输入框已挂载
      const _modal = document.getElementById('tasks-modal');
      const _addActive = _modal?.querySelector('.tasks-tab.active[data-tab="new"]');
      const _formMounted = _modal?.querySelector('#task-form-name');
      if (_addActive && _formMounted) {
        _showPresetPicker();
        return;
      }
      closeTasks();
    }
  };
  document.addEventListener('keydown', _escHandler);

  // Paint the scaffolding immediately so the modal-enter animation reveals a
  // populated shell (header/search/sort/empty list with a spinner row) instead
  // of an empty modal-body that fills in after the fetch resolves — that delay
  // was visible as a "flicker" right after opening.
  _activeTab = 'tasks';
  _switchTab('tasks');
  _fetchTasks().then(() => {
    // 重新渲染，使列表将加载行替换为真实卡片
    _renderList();
    _syncPauseAllButton();
    if (_pendingFocusTaskId) {
      _focusTask(_pendingFocusTaskId);
      _pendingFocusTaskId = null;
    }
    _runFirstOpenOnboarding();
  });
}

let _pendingFocusTaskId = null;

// 根据 id 滚动到任务卡片并短暂高亮。用于聊天
// 锚点链接委托（[名称](#task-<id>)）。
function _focusTask(taskId) {
  if (!taskId) return;
  // 根据此 id 查找任务卡片，滚动到视图中并闪烁。后端
  // 任务 ID 是 UUID，所以未转义的选择器在实践中安全；如果
  // 改变，切换为 `[data-id="${CSS.escape(taskId)}"]`。
  setTimeout(() => {
    const card = document.querySelector(`.task-card[data-id="${taskId}"], [data-id="${taskId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('task-card-flash');
    setTimeout(() => card.classList.remove('task-card-flash'), 2000);
  }, 150);
}

export function closeTasks() {
  if (!_open) return;
  _open = false;
  _viewingRuns = null;
  const modal = document.getElementById('tasks-modal');
  if (modal) {
    const content = modal.querySelector('.modal-content');
    if (content) {
      content.classList.add('modal-closing');
      content.addEventListener('animationend', () => modal.remove(), { once: true });
      setTimeout(() => { if (modal.parentElement) modal.remove(); }, 250);
    } else {
      modal.remove();
    }
  }
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }
  if (_clockInterval) {
    clearInterval(_clockInterval);
    _clockInterval = null;
  }
  // 如果表单 Esc 捕获监听器仍存在（如用户通过 X/外部点击
  // 在表单打开时关闭了弹窗），则分离之。
  if (window._tasksFormEsc) {
    document.removeEventListener('keydown', window._tasksFormEsc, true);
    window._tasksFormEsc = null;
  }
}

export function isTasksOpen() { return _open; }

// ---- 任务运行通知轮询 ----

let _notifInterval = null;

async function _pollTaskNotifications() {
  try {
    const res = await fetch(`${API_BASE}/api/tasks/notifications`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    const notes = data.notifications || [];
    for (const n of notes) {
      const ok = n.status === 'success';
      // output_target='notification' 的任务在 `body` 中携带结果文本
      // ——将其显示为真实的浏览器通知（比 toast 更丰富）。当权限
      // 被拒绝或不可用时回退到 toast。
      if (ok && n.body) {
        const title = n.task_name || 'Task';
        let fired = false;
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(title, { body: n.body, tag: 'task-' + (n.task_id || title), icon: '/static/favicon.ico' });
            fired = true;
          }
        } catch (_) {}
        if (!fired && uiModule) uiModule.showToast(title + ': ' + n.body.slice(0, 140), { duration: 7000 });
        continue;
      }
      const msg = `Task ${ok ? 'finished' : 'failed'}: ${n.task_name}`;
      if (!uiModule) continue;
      if (ok) uiModule.showToast(msg, { duration: 5000 });
      else uiModule.showError(msg);
    }
  } catch (e) {
    // 静默忽略——服务器可能不可达
  }
}

function startNotificationPolling() {
  if (_notifInterval) return;
  _notifInterval = setInterval(_pollTaskNotifications, 30000);
}

function stopNotificationPolling() {
  if (_notifInterval) {
    clearInterval(_notifInterval);
    _notifInterval = null;
  }
}

// 模块加载时开始轮询
startNotificationPolling();

const tasksModule = { openTasks, closeTasks, isTasksOpen, startNotificationPolling, stopNotificationPolling };
export default tasksModule;
window.tasksModule = tasksModule;
