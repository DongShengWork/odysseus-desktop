/**
 * emailInbox.js — 侧边栏中的电子邮件收件箱列表。
 * 遵循会话列表模式：列表项、点击作为文档打开、归档等。
 */

import spinnerModule from './spinner.js';
import sessionModule from './sessions.js';
import { initEmailLibrary, openEmailLibrary, closeEmailLibrary, isOpen as isLibOpen, prewarmEmailLibrary } from './emailLibrary.js';
import * as Modals from './modalManager.js';
import { applyEdgeDock } from './modalSnap.js';
import { buildReplyAllCc } from './emailLibrary/replyRecipients.js';

const API_BASE = window.location.origin;
const _acct = () => window.__odysseusActiveEmailAccount
  ? `&account_id=${encodeURIComponent(window.__odysseusActiveEmailAccount)}`
  : '';

const _emailSetupHint = () => '<div style="margin-top:6px;opacity:0.72;font-size:11px;">Setup: <span style="color:var(--accent,var(--red));">Settings &rsaquo; Integrations</span></div>';

// 与 sessions.js 下拉菜单风格匹配的 SVG 图标
const _replyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
const _archiveIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
const _deleteIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
const _unreadIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
const _starIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
const _starFilledIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
const _bellIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
const _icon = (svg) => `<span class="dropdown-icon">${svg}</span>`;
const _replySeparator = '---------- Previous message ----------';

function _cleanAiReplyText(text) {
  if (!text) return '';
  let t = String(text);
  const open = /<<<\s*(?:REPLY|SUMMARY|OUTPUT)\s*>>+/i;
  const close = /<<<\s*END\s*>>+/i;
  const m = open.exec(t);
  if (m) {
    const rest = t.slice(m.index + m[0].length);
    const c = close.exec(rest);
    t = c ? rest.slice(0, c.index) : rest;
  }
  return t
    .replace(/<<<\s*(?:REPLY|SUMMARY|OUTPUT)\s*>>+/gi, '')
    .replace(/<<<\s*END\s*>>+/gi, '')
    .trim();
}

function _shouldUseFastAiReply(data) {
  const body = String(data?.body || data?.body_html || '');
  const subject = String(data?.subject || '');
  const atts = Array.isArray(data?.attachments) ? data.attachments : [];
  if (atts.length > 0) return false;
  const text = `${subject}\n${body}`.toLowerCase();
  if (/\b(attach(?:ed|ment)?|pdf|document|contract|invoice|receipt|quote|estimate|proposal|question|questions|details|schedule|booking|reservation|meeting|calendar|availability|confirm|confirmation|review|sign|signature)\b/.test(text)) {
    return false;
  }
  return body.length < 2500;
}

let _emails = [];
let _currentFolder = 'INBOX';
let _offset = 0;
let _total = 0;

// 回复邮件会在服务端标记源邮件为 \Answered 并触发
// `email-answered` 事件。在收件箱列表中实时反映，以便立即显示
// 为已完成（无需手动刷新）。
window.addEventListener('email-answered', (e) => {
  const uid = e.detail && e.detail.uid;
  if (uid == null) return;
  const em = _emails.find(x => String(x.uid) === String(uid));
  if (em) { em.is_answered = true; em.is_read = true; }
  document.querySelectorAll('.email-item[data-uid="' + CSS.escape(String(uid)) + '"]').forEach(item => {
    item.classList.remove('email-unread');
    const check = item.querySelector('.email-done-check');
    if (check) check.classList.add('active');
    // Auto-mark from sending a reply — flash the row so the user sees the
    // state change without staring at it. Class self-removes after the
    // animation so it doesn't replay on re-renders.
    item.classList.add('email-auto-done-flash');
    setTimeout(() => item.classList.remove('email-auto-done-flash'), 1200);
  });
});
let _loading = false;
let _expanded = false;
let _docModule = null;
let _listSpinner = null;
let _senderFilter = null;       // 要过滤的电子邮件地址（小写），或 null
let _senderFilterLabel = null;  // 活动过滤芯片的显示标签

export function init(documentModule) {
  _docModule = documentModule;
  _bindEvents();
  // 使用打开邮件的回调初始化库弹窗
  initEmailLibrary({
    documentModule,
    onEmailClick: async (opts) => {
      // Reply / AI Reply / Compose open a draft in the doc editor.
      //  - Desktop: dock the email to the LEFT so it stays visible beside the
      //    reply draft (which opens on the right) — read-while-you-reply.
      //  - Mobile: there's no room for a split, so minimize the email modal;
      //    the draft comes to the front and the inbox stays a tap away as a
      //    minimized chip.
      // 此处永远不要调用 closeEmailLibrary() — 那样会销毁状态。
      try {
        if (Modals.isRegistered('email-lib-modal')) {
          const emailModal = document.getElementById('email-lib-modal');
          if (window.innerWidth > 768 && emailModal && !emailModal.classList.contains('hidden')) {
            applyEdgeDock(emailModal, 'left');
          }
          // Mobile: do NOT pre-mount the pane here. The load path (open/inject)
          // mounts it exactly once when the doc is ready; the doc-view z-index
          // rule slides it up OVER the email (which stays behind). Pre-mounting
          // here caused a double-mount — the early pane was torn down by the
          // compose session-switch, then remounted, which looked like a doc
          // flashing before the smooth slide.
        }
      } catch (_) {}
      if (opts.compose) { _composeNew(); return; }
      if (opts.email) {
        await _openEmail(opts.email, null, opts.emailData, opts.mode || 'reply', opts.noteHint || '');
      }
    },
  });
  _watchDocOpenToReDockEmail();
}

export async function openReplyDraft(uid, folder = 'INBOX', mode = 'reply', prefilledBody = '') {
  if (!uid) return;
  const previousFolder = _currentFolder;
  _currentFolder = folder || 'INBOX';
  try {
    await _openEmail({ uid: String(uid), subject: '' }, null, null, mode || 'reply', '', prefilledBody || '');
  } finally {
    _currentFolder = previousFolder || _currentFolder;
  }
}

// When the document editor pane opens (body.doc-view turns on), make sure the
// email modal is on the LEFT — even if it was previously docked RIGHT or
// floating — so the email and the doc always end up side-by-side. The actual
// width math lives in modalSnap.js (`_anchorLeftDock` shrinks the email when
// the doc is rendered to the right).
let _docOpenObs = null;
function _watchDocOpenToReDockEmail() {
  if (_docOpenObs) return;
  if (typeof MutationObserver === 'undefined') return;
  let last = document.body.classList.contains('doc-view');
  _docOpenObs = new MutationObserver(() => {
    const cur = document.body.classList.contains('doc-view');
    if (cur && !last) {
      if (window.innerWidth > 768) {
        const emailModal = document.getElementById('email-lib-modal');
        if (emailModal && !emailModal.classList.contains('hidden')) {
          // 已经左停靠 → 无需操作（modalSnap 自行重新锚定）。
          if (!emailModal.classList.contains('modal-left-docked')) {
            try { applyEdgeDock(emailModal, 'left'); } catch (_) {}
          }
        }
        // 同样处理打开的邮件阅读器模态框（单独打开特定邮件 —
        // 典型的"点击邮件，点击文档"流程）。
        document.querySelectorAll('.modal[id^="email-reader-"]').forEach(m => {
          if (m.classList.contains('hidden')) return;
          if (m.classList.contains('modal-left-docked')) return;
          try { applyEdgeDock(m, 'left'); } catch (_) {}
        });
      }
    }
    last = cur;
  });
  _docOpenObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

function _bindEvents() {
  // 点击邮件节标题的任意位置打开弹窗
  //（撰写按钮除外，它有自己的处理程序）
  const section = document.getElementById('email-section');
  const header = section?.querySelector('.section-header-flex');
  if (header) {
    header.style.cursor = 'pointer';
    header.addEventListener('click', (e) => {
      if (e.target.closest('#email-compose-btn')) return;
      openEmailLibrary();
      markInboxAsSeen();
    });
  }

  // 撰写按钮创建新的电子邮件文档
  const composeBtn = document.getElementById('email-compose-btn');
  if (composeBtn) {
    composeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _composeNew();
    });
  }

  // 初始未读计数检查，每 60 秒刷新
  _refreshUnreadCount();
  setInterval(_refreshUnreadCount, 60000);
  prewarmEmailLibrary({ delay: 3000 });

  // 深度链接: #email=<folder>:<uid> 打开库并展开该卡片
  _maybeOpenFromHash();
  window.addEventListener('hashchange', _maybeOpenFromHash);
}

function _maybeOpenFromHash() {
  const h = window.location.hash || '';
  const m = h.match(/^#email=([^:]+):(\d+)/);
  if (!m) return;
  const folder = decodeURIComponent(m[1]);
  const uid = m[2];
  try { openEmailLibrary({ folder, uid }); } catch (e) { console.error(e); }
  // 清除哈希值以防止重新加载时重新打开
  try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_) {}
}

// 色调辅助函数 — 将紧急邮件扫描器的 max_score 转换为圆点颜色。
// 当扫描器关闭或无紧急邮件时，回退到默认值（蓝色 / 未设置）。
function _urgencyColor(score) {
  if (score >= 3) return 'var(--color-error, #e06c75)';   // 红色 — 立即紧急
  if (score === 2) return '#f0ad4e';                       // 橙色 — 尽快回复
  return '';                                                // 默认（蓝色 / 主题）
}

async function _refreshUnreadCount() {
  // 默认将圆点设为隐藏 — 只有下方验证过的"阈值以上新邮件"
  // 路径才应将其打开。否则，fetch 错误或后端返回格式错误的数据
  // 会保留来自上一个账户/会话的过期圆点。
  const dot = document.getElementById('email-unread-dot');
  if (dot && !dot._stickyState) dot.style.display = 'none';
  try {
    // 并行：未读列表 + 紧急状态。
    const [listRes, urgRes] = await Promise.all([
      fetch(`${API_BASE}/api/email/list?folder=INBOX&limit=50&filter=unread${_acct()}`),
      fetch(`${API_BASE}/api/email/urgency-state`, { credentials: 'same-origin' }).catch(() => null),
    ]);
    if (!listRes || !listRes.ok) return;
    const data = await listRes.json();
    if (!dot) return;

    const emails = data.emails || [];
    if (emails.length === 0) {
      dot.style.display = 'none';
      return;
    }

    // 将最高未读 UID 与 localStorage 中最后看到的阈值进行比对
    const lastSeen = parseInt(localStorage.getItem('odysseus-email-last-seen-uid') || '0', 10);
    const maxUid = Math.max(...emails.map(e => parseInt(e.uid, 10) || 0));

    // 仅当有超过阈值的新邮件时才显示圆点
    dot.style.display = maxUid > lastSeen ? '' : 'none';

    // 按紧急级别为圆点着色。缓存每个 UID 的映射以便每行渲染器
    // 可以复用它而无需第二次 fetch。
    if (dot.style.display !== 'none' && urgRes && urgRes.ok) {
      try {
        const ud = await urgRes.json();
        window._emailUrgencyState = ud;
        const tint = _urgencyColor(ud.max_score || 0);
        if (tint) dot.style.backgroundColor = tint;
        else dot.style.backgroundColor = '';
      } catch (_) {}
    } else if (dot.style.display !== 'none') {
      dot.style.backgroundColor = '';
    }
  } catch (e) {
    // 网络/解析错误 — 保持圆点隐藏（顶部默认值）。
    if (dot) dot.style.display = 'none';
  }
}

export function markInboxAsSeen() {
  // 当用户打开收件箱弹窗时调用 — 清除通知圆点
  try {
    // 找出当前最大 UID，以便后续到达的邮件触发圆点
    fetch(`${API_BASE}/api/email/list?folder=INBOX&limit=1${_acct()}`)
      .then(r => r.json())
      .then(data => {
        const emails = data.emails || [];
        if (emails.length > 0) {
          const maxUid = Math.max(...emails.map(e => parseInt(e.uid, 10) || 0));
          localStorage.setItem('odysseus-email-last-seen-uid', String(maxUid));
        }
        const dot = document.getElementById('email-unread-dot');
        if (dot) dot.style.display = 'none';
      })
      .catch(() => {});
  } catch (e) {}
}

export async function loadEmails(append = false) {
  if (_loading) return;
  _loading = true;

  const list = document.getElementById('email-list');
  if (!list) { _loading = false; return; }

  if (!append) {
    list.innerHTML = '';
    // 显示漩涡旋转器
    if (_listSpinner) { _listSpinner.destroy(); _listSpinner = null; }
    const sp = spinnerModule.createWhirlpool(20);
    _listSpinner = sp;
    list.appendChild(sp.element);
  }

  try {
    const fromQS = _senderFilter ? `&from=${encodeURIComponent(_senderFilter)}` : '';
    const res = await fetch(`${API_BASE}/api/email/list?folder=${encodeURIComponent(_currentFolder)}&limit=50&offset=${_offset}${fromQS}${_acct()}&_=${Date.now()}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (!append) _emails = [];
    _emails.push(...(data.emails || []));
    _total = data.total || 0;

    // 移除旋转器
    if (_listSpinner) { _listSpinner.destroy(); _listSpinner = null; }

    _renderList();

    const unreadCount = _emails.filter(e => !e.is_read).length;
    const dot = document.getElementById('email-unread-dot');
    if (dot) dot.style.display = unreadCount > 0 ? '' : 'none';
  } catch (e) {
    console.error('Failed to load emails:', e);
    if (_listSpinner) { _listSpinner.destroy(); _listSpinner = null; }
    if (!append && list) {
      const msg = e && e.message ? `Failed to load: ${e.message}` : 'Failed to load';
      list.innerHTML = `<div class="email-loading">${msg.replace(/&/g, '&amp;').replace(/</g, '&lt;')}${_emailSetupHint()}</div>`;
    }
  } finally {
    _loading = false;
  }
}

async function loadFolders() {
  try {
    const res = await fetch(`${API_BASE}/api/email/folders?_=1${_acct()}`);
    const data = await res.json();
    const select = document.getElementById('email-folder-select');
    if (!select || !data.folders) return;
    _populateFolderSelect(select, data.folders);
  } catch (e) {
    console.error('Failed to load folders:', e);
  }
}

export function sortedFolders(folders) {
  const roleOf = (folder) => {
    const f = String(folder || '').toLowerCase();
    if (f === 'inbox') return 'inbox';
    if (f.includes('sent')) return 'sent';
    if (f.includes('starred') || f.includes('flagged')) return 'starred';
    if (f.includes('draft')) return 'drafts';
    if (f.includes('all mail') || f.includes('archive')) return 'archive';
    if (f.includes('spam') || f.includes('junk')) return 'junk';
    if (f.includes('trash') || f.includes('bin') || f.includes('deleted')) return 'trash';
    return '';
  };
  const roleOrder = ['inbox', 'sent', 'starred', 'archive', 'junk', 'trash', 'drafts'];
  const found = new Map();
  const others = [];
  for (const f of folders) {
    const role = roleOf(f);
    if (role && !found.has(role)) found.set(role, f);
    else others.push(f);
  }
  return { priority: roleOrder.map(role => found.get(role)).filter(Boolean), others };
}

export function folderDisplayName(folder) {
  const raw = String(folder || '');
  const f = raw.toLowerCase();
  if (f === 'inbox') return 'INBOX';
  if (f.includes('all mail')) return 'Archive / All Mail';
  if (f.includes('archive')) return 'Archive';
  if (f.includes('spam')) return 'Spam';
  if (f.includes('junk')) return 'Junk';
  if (f.includes('trash') || f.includes('bin') || f.includes('deleted')) return 'Trash';
  if (f.includes('sent')) return 'Sent';
  if (f.includes('draft')) return 'Drafts';
  return raw;
}

function _populateFolderSelect(select, folders) {
  select.innerHTML = '';
  const { priority, others } = sortedFolders(folders);

  for (const folder of priority) {
    const opt = document.createElement('option');
    opt.value = folder;
    opt.textContent = folderDisplayName(folder);
    if (folder === _currentFolder) opt.selected = true;
    select.appendChild(opt);
  }

  if (priority.length > 0 && others.length > 0) {
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '─────────';
    select.appendChild(sep);
  }

  for (const folder of others) {
    const opt = document.createElement('option');
    opt.value = folder;
    opt.textContent = folderDisplayName(folder);
    if (folder === _currentFolder) opt.selected = true;
    select.appendChild(opt);
  }
}

function _renderList() {
  const list = document.getElementById('email-list');
  if (!list) return;
  list.innerHTML = '';

  if (_senderFilter) {
    const chip = document.createElement('div');
    chip.className = 'email-filter-chip';
    chip.innerHTML = `<span class="email-filter-chip-label">From: ${_esc(_senderFilterLabel || _senderFilter)}</span><button class="email-filter-chip-clear" title="${t('email.clear_filter')}">&times;</button>`;
    chip.querySelector('.email-filter-chip-clear').addEventListener('click', () => _clearSenderFilter());
    list.appendChild(chip);
  }

  if (_emails.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'email-loading';
    empty.textContent = _senderFilter ? `No emails from ${_senderFilterLabel || _senderFilter}` : 'No emails';
    list.appendChild(empty);
    return;
  }

  for (const em of _emails) {
    list.appendChild(_createEmailItem(em));
  }

  const loadMore = document.getElementById('email-load-more');
  if (loadMore) {
    loadMore.style.display = (_emails.length < _total) ? '' : 'none';
  }
}

function _setSenderFilter(addr, label) {
  _senderFilter = addr;
  _senderFilterLabel = label || addr;
  _offset = 0;
  loadEmails(false);
}

function _clearSenderFilter() {
  _senderFilter = null;
  _senderFilterLabel = null;
  _offset = 0;
  loadEmails(false);
}

function _createEmailItem(em) {
  const item = document.createElement('div');
  item.className = 'list-item email-item' + (em.is_spam_verdict ? ' email-item-spam' : '');
  item.setAttribute('role', 'option');
  item.setAttribute('data-uid', em.uid);

  let dateStr = '';
  if (em.date) {
    try {
      const d = new Date(em.date);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      if (isToday) {
        dateStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else {
        dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
    } catch (_) {}
  }

  const senderName = em.from_name || em.from_address;
  const initial = (senderName || '?')[0].toUpperCase();
  const color = _senderColor(senderName);

  const attachIcon = em.has_attachments
    ? '<span title="Has attachments" style="opacity:0.6;display:inline-flex;flex-shrink:0;margin-left:4px;"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span>'
    : '';

  // 每行圆点色调：如果紧急扫描器标记了此 UID，则用红色 (3) / 橙色 (2)
  // 覆盖每个发件人的柔和色。通过以 `:<uid>` 结尾的任何缓存键查找，
  // 因为 per_uid 映射的键是 `<account_id>:<uid>`，
  // 而收件箱列表每行不显示账户 ID。
  let _unreadColor = color;
  let _unreadTitle = 'Unread';
  try {
    const us = window._emailUrgencyState;
    if (us && us.per_uid && em.uid != null) {
      const suffix = ':' + String(em.uid);
      for (const k of Object.keys(us.per_uid)) {
        if (k.endsWith(suffix)) {
          const v = us.per_uid[k] || {};
          const score = v.score || 0;
          if (score >= 3) { _unreadColor = 'var(--color-error, #e06c75)'; _unreadTitle = 'Urgent — ' + (v.reason || 'needs reply now'); }
          else if (score === 2) { _unreadColor = '#f0ad4e'; _unreadTitle = 'Reply soon — ' + (v.reason || ''); }
          break;
        }
      }
    }
  } catch (_) {}
  const unreadIcon = (!em.is_read && !em.is_answered)
    ? `<span class="email-unread-dot-inline" title="${_esc(_unreadTitle)}" style="display:inline-flex;align-items:center;flex-shrink:0;margin-left:4px;color:${_unreadColor}"><svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg></span>`
    : '';

  const tags = Array.isArray(em.tags) ? em.tags : [];
  const tagPills = tags.length
    ? `<span class="email-tags">${tags.map(t => `<span class="email-tag email-tag-${_esc(t)}">${_esc(t)}</span>`).join('')}</span>`
    : '';

  const spamTag = em.is_spam_verdict
    ? `<span class="email-tag email-tag-spam" title="AI flagged as spam — click ✓ to unflag">spam <button class="email-spam-unflag" data-uid="${em.uid}" title="Not spam">\u2713</button></span>`
    : '';

  const senderAddr = (em.from_address || '').toLowerCase();
  item.innerHTML = `
    <span class="email-avatar" style="background:${color}">${initial}</span>
    <div class="email-item-content">
      <div class="email-item-top">
        <span class="email-sender email-sender-clickable" style="color:${color}" data-from-addr="${_esc(senderAddr)}" data-from-name="${_esc(senderName)}" title="Show all emails from ${_esc(senderName)}">${_esc(senderName)}</span>
        <span class="email-date">${_esc(dateStr)}</span>
      </div>
      <div class="email-subject">${_esc(em.subject)}${unreadIcon}${attachIcon}${tagPills}${spamTag}</div>
    </div>
  `;

  // 点击发件人姓名 → 按该发件人过滤列表
  const senderEl = item.querySelector('.email-sender-clickable');
  if (senderEl) {
    senderEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const addr = senderEl.dataset.fromAddr || '';
      const name = senderEl.dataset.fromName || addr;
      if (addr) _setSenderFilter(addr, name);
    });
  }

  // 连接"非垃圾邮件"按钮
  const unflagBtn = item.querySelector('.email-spam-unflag');
  if (unflagBtn) {
    unflagBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await fetch(`${API_BASE}/api/email/${em.uid}/unflag-spam`, {
          method: 'POST', credentials: 'same-origin',
        });
        em.is_spam_verdict = false;
        item.classList.remove('email-item-spam');
        const tag = item.querySelector('.email-tag-spam');
        if (tag) tag.remove();
      } catch (_) {}
    });
  }

  // 点击打开 — 不要关闭侧边栏
  item.addEventListener('click', (e) => {
    if (item.dataset.swipeBlock === '1') return;
    _openEmail(em, item);
  });

  // 向左滑动归档（移动端）。镜像 sidebar-layout.js 的滑动模式。
  if ('ontouchstart' in window) {
    let startX = 0, startY = 0, dx = 0, dy = 0, swiping = false, swiped = false;
    const HORIZ_THRESHOLD = 70; // 触发归档的像素阈值
    const VERT_CANCEL = 30;     // 垂直移动像素数取消滑动（视为滚动）

    item.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      dx = 0; dy = 0; swiping = true; swiped = false;
      item.style.transition = 'none';
    }, { passive: true });

    item.addEventListener('touchmove', (e) => {
      if (!swiping) return;
      const t = e.touches[0];
      dx = t.clientX - startX;
      dy = t.clientY - startY;
      if (Math.abs(dy) > VERT_CANCEL) {
        // 垂直滚动 — 取消滑动
        swiping = false;
        item.style.transform = '';
        return;
      }
      if (dx < 0) {
        // 仅向左滑动进行归档；限制在 -160 以避免飞出屏幕
        const offset = Math.max(dx, -160);
        item.style.transform = `translateX(${offset}px)`;
        item.style.background = `linear-gradient(to right, transparent, transparent ${100 + offset/1.6}%, var(--red) ${100 + offset/1.6}%)`;
      }
    }, { passive: true });

    item.addEventListener('touchend', () => {
      if (!swiping) return;
      swiping = false;
      item.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
      if (dx <= -HORIZ_THRESHOLD) {
        // 触发归档 — 动画移出屏幕，抑制下一次点击
        swiped = true;
        item.dataset.swipeBlock = '1';
        item.style.transform = 'translateX(-100%)';
        item.style.opacity = '0';
        setTimeout(() => {
          _archiveEmail(em);
          delete item.dataset.swipeBlock;
        }, 200);
      } else {
        // 弹回原位
        item.style.transform = '';
        item.style.background = '';
      }
    });

    item.addEventListener('touchcancel', () => {
      swiping = false;
      item.style.transition = 'transform 0.2s ease';
      item.style.transform = '';
      item.style.background = '';
    });
  }

  return item;
}

async function _openEmail(em, itemEl, preloadedData = null, mode = 'reply', noteHint = '', prefilledBody = '') {
  const aiReplyMode = mode === 'ai-reply-fast' ? 'fast' : (mode === 'ai-reply-full' ? 'full' : '');
  const wantsAiReply = mode === 'ai-reply' || !!aiReplyMode;
  // Body pre-fill from the agent's open_email_reply tool call takes the
  // same insertion slot as an AI-suggested body — both land just before
  // the quoted-original block.
  let aiSuggestedBody = (typeof prefilledBody === 'string' && prefilledBody.trim()) ? prefilledBody.trim() : null;
  if (wantsAiReply) {
    // Fall through to reply-all (not plain reply) so the generated AI
    // draft addresses everyone on the original thread. On single-
    // recipient emails this collapses to a regular reply since there's
    // no one else to CC.
    mode = 'reply-all';
  }
  // 在项目右侧显示漩涡旋转器（仅当从侧边栏打开时）
  let spinner = null;
  if (itemEl) {
    const sp = spinnerModule.createWhirlpool(16);
    spinner = sp;
    sp.element.style.cssText = 'margin:0;flex-shrink:0;';
    const menuWrap = itemEl.querySelector('.email-menu-wrap');
    if (menuWrap) menuWrap.style.display = 'none';
    itemEl.appendChild(sp.element);
  }

  try {
    let data = preloadedData;
    if (!data) {
      const res = await fetch(`${API_BASE}/api/email/read/${em.uid}?folder=${encodeURIComponent(_currentFolder)}${_acct()}`);
      data = await res.json();
    }
    if (data.error) {
      console.error('Failed to read email:', data.error);
      return;
    }
    if (wantsAiReply) {
      if (data.cached_ai_reply) {
        aiSuggestedBody = _cleanAiReplyText(data.cached_ai_reply);
      } else {
        let draftToastTimer = null;
        draftToastTimer = setTimeout(() => {
          import('./ui.js').then(m => m.showToast && m.showToast('Drafting AI reply', { duration: 3000, leadingIcon: 'spinner' })).catch(() => {});
        }, 450);
        try {
          let currentModel = '';
          let currentSessionId = '';
          try {
            currentModel = sessionModule?.getCurrentModel() || '';
            currentSessionId = sessionModule?.getCurrentSessionId() || '';
          } catch (_) {}
          const res = await fetch(`${API_BASE}/api/email/ai-reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: data.from_address,
              subject: `Re: ${data.subject}`,
              original_body: data.body,
              model: currentModel,
              session_id: currentSessionId,
              message_id: data.message_id || '',
              uid: String(em.uid || ''),
              folder: _currentFolder,
              fast: aiReplyMode ? aiReplyMode === 'fast' : _shouldUseFastAiReply(data),
              user_hint: (noteHint || '').trim() || undefined,
            }),
          });
          const result = await res.json();
          if (draftToastTimer) clearTimeout(draftToastTimer);
          if (result.success && result.reply) {
            aiSuggestedBody = _cleanAiReplyText(result.reply);
          } else {
            const _msg = result.error || 'AI reply could not be generated';
            console.error('AI reply generation failed:', _msg);
            import('./ui.js').then(m => m.showError && m.showError('AI reply failed: ' + _msg)).catch(() => {});
            return;
          }
        } catch (e) {
          if (draftToastTimer) clearTimeout(draftToastTimer);
          console.error('AI reply generation failed:', e);
          import('./ui.js').then(m => m.showError && m.showError('AI reply failed: ' + (e.message || e))).catch(() => {});
          return;
        }
      }
    }

    em.is_read = true;
    if (itemEl) itemEl.classList.remove('email-unread');

    // 要在回复全部时排除的地址。优先使用完整配置的账户集合
    //（这样多账户用户的其他邮箱也会被排除），
    // 回退到单个活动地址。空 ⇒ 不排除。
    const myAddresses = (Array.isArray(window._myEmailAddresses) && window._myEmailAddresses.length)
      ? window._myEmailAddresses
      : (window._myEmailAddress ? [window._myEmailAddress] : []);

    let toAddress = data.from_address;
    let ccAddresses = '';
    let subjectPrefix = 'Re: ';

    if (mode === 'reply-all') {
      // 构建回复全部：TO = 原始发件人，CC = 其他人（To + Cc 减去自己）
      ccAddresses = buildReplyAllCc(data, myAddresses);
    } else if (mode === 'forward') {
      toAddress = '';
      subjectPrefix = 'Fwd: ';
    }

    // 当主题已以 Re:/Fwd: 开头时，不要重复添加前缀。
    // 回复的回复会产生 `Re: Re: Re: …`，这也可能破坏
    // 某些 IMAP 服务器对很长主题行的头部解析。
    let _baseSubject = (data.subject || '').trim();
    if (subjectPrefix === 'Re: ' && /^re\s*:/i.test(_baseSubject)) subjectPrefix = '';
    else if (subjectPrefix === 'Fwd: ' && /^fwd?\s*:/i.test(_baseSubject)) subjectPrefix = '';
    let content = `To: ${toAddress}\nSubject: ${subjectPrefix}${_baseSubject}`;
    if (ccAddresses) content += `\nCc: ${ccAddresses}`;
    if (mode !== 'forward' && data.message_id) content += `\nIn-Reply-To: ${data.message_id}`;
    if (mode !== 'forward' && data.message_id) content += `\nReferences: ${data.references ? data.references + ' ' + data.message_id : data.message_id}`;
    content += `\nX-Source-UID: ${em.uid}`;
    content += `\nX-Source-Folder: ${_currentFolder}`;
    if (data.attachments && data.attachments.length > 0) {
      const attStr = data.attachments.map(a => `${a.index}:${a.filename}:${a.size}`).join('|');
      content += `\nX-Attachments: ${attStr}`;
    }
    content += '\n---\n';

    // 以人类可读的方式格式化原始日期用于引用头部
    let niceDate = data.date || '';
    try {
      if (data.date) {
        const d = new Date(data.date);
        if (!isNaN(d.getTime())) {
          niceDate = d.toLocaleString([], {
            weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          });
        }
      }
    } catch (_) {}

    // 纯文本正文，若无文本部分则使用剥离后的 HTML 回退。
    // 否则，纯 HTML 邮件会导致 data.body === null/undefined，
    // 回复文档会打开为空（data.body.split 抛出异常）。
    let _origBody = (typeof data.body === 'string' && data.body.length) ? data.body : '';
    if (!_origBody && typeof data.body_html === 'string' && data.body_html) {
      _origBody = data.body_html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    if (mode === 'forward') {
      content += `\n\n---------- Forwarded message ----------\n`;
      content += `From: ${data.from_name} <${data.from_address}>\n`;
      content += `Date: ${niceDate}\n`;
      content += `Subject: ${data.subject}\n`;
      if (data.to) content += `To: ${data.to}\n`;
      content += `\n${_origBody}`;
    } else {
      const quotedBody = _origBody.split('\n').map(l => '> ' + l).join('\n');
      // 如果有 AI 建议正文则注入。不要前导换行 — 头部块已经以
      // "---\n" 结尾，因此回复必须从第一行正文开始，
      // 而不是向下空一行。
      if (aiSuggestedBody) {
        content += `${aiSuggestedBody}\n\n`;
      } else {
        content += '\n\n';
      }
      content += `${_replySeparator}\nOn ${niceDate}, ${data.from_name} <${data.from_address}> wrote:\n${quotedBody}`;
    }

    if (_docModule) {
      // Only reuse an existing doc tab if the user really just wants to "view"
      // the email again. For reply/reply-all/forward/ai-reply, always create
      // a fresh draft — otherwise a previously-emptied doc (sent reply, AI
      // reply that came back blank, etc.) keeps coming back instead of a
      // proper pre-filled reply.
      const reuseExisting = (mode === 'view' || mode === 'open');
      const existingDocId = (reuseExisting && _docModule.findEmailDocId)
        ? _docModule.findEmailDocId(em.uid, _currentFolder)
        : null;
      if (existingDocId) {
        if (!_docModule.isPanelOpen()) _docModule.openPanel();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await _docModule.loadDocument(existingDocId);
      } else {
        // 如果用户已有一个打开的聊天会话，则复用它，
        // 而不是生成新会话。用户明确要求 — 在对话中打开回复
        // 不应将他们从上下文中拉出来。
        let activeSid = '';
        try { activeSid = sessionModule?.getCurrentSessionId?.() || ''; } catch {}
        if (!activeSid) {
          // No chat in flight — keep the old behavior of creating a scoped
          // email-thread chat, then RE-READ the now-current session id. The
          // POST below requires a session_id (backend 400s without one), and
          // the freshly-created chat is what should own the reply draft.
          await _createEmailChat(data);
          try { activeSid = sessionModule?.getCurrentSessionId?.() || ''; } catch {}
        }
        // 保证有一个会话 — 当没有启用的默认聊天端点时，
        // _createEmailChat 无法创建会话，这会导致回复 POST 发送
        // null session_id → 400。创建一个裸会话，这样无论
        // 聊天/端点配置如何，草稿始终有归属地。
        if (!activeSid) {
          try {
            const _fd = new FormData();
            _fd.append('name', `Email: ${(data.subject || '').slice(0, 60)}`);
            _fd.append('skip_validation', 'true');
            const _sres = await fetch(`${API_BASE}/api/session`, { method: 'POST', body: _fd, credentials: 'same-origin' });
            if (_sres.ok) {
              const _sdata = await _sres.json();
              if (_sdata && _sdata.id) {
                activeSid = _sdata.id;
                if (sessionModule?.loadSessions) await sessionModule.loadSessions();
                if (sessionModule?.selectSession) await sessionModule.selectSession(activeSid);
              }
            }
          } catch (e) { console.error('reply: bare session create failed', e); }
        }

        const docRes = await fetch(`${API_BASE}/api/document`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // 如果有的话，重用用户当前的聊天会话（这样回复草稿
            // 属于他们刚才的聊天）；否则为 null，
            // 由新创建的邮件聊天（上面创建的）接管。
            session_id: activeSid || null,
            title: data.subject,
            content: content,
            language: 'email',
          }),
        });
        if (!docRes.ok) {
          const errText = await docRes.text();
          console.error('[reply-debug] POST /api/document failed', docRes.status, errText);
          // uiModule 没有在这里静态导入 — 使用此文件其他地方
          // 使用的动态导入模式。（之前这里引用了裸 `uiModule`，
          // 抛出 ReferenceError，被外部 catch 吞掉了 →
          // 回复静默地什么都没做。）
          import('./ui.js').then(m => m.showError && m.showError('Failed to create reply draft (' + docRes.status + ')')).catch(() => {});
          return;
        }
        const doc = await docRes.json();
        if (doc.id) {
          const wasOpen = _docModule.isPanelOpen();
          if (!wasOpen) _docModule.openPanel();
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          // Use the doc dict from the POST directly — avoids a 404 race
          // when the GET fires before the new row is visible to the read
          // connection (or when caching is interfering). loadDocument's
          // GET path can still be used as a fallback.
          if (_docModule.injectFreshDoc) {
            _docModule.injectFreshDoc(doc);
          } else {
            await _docModule.loadDocument(doc.id);
          }
        }
      }
    }
  } catch (e) {
    console.error('Failed to open email:', e);
    // 显示失败信息，避免回复流程中的静默异常看起来像
    // "什么都没发生"。动态导入 — uiModule 不是此文件中的
    // 静态导入。
    const msg = e && e.message ? e.message : String(e);
    import('./ui.js').then(m => m.showError && m.showError('Reply failed: ' + msg)).catch(() => {});
  } finally {
    if (spinner) { spinner.destroy(); spinner.element.remove(); }
    if (itemEl) {
      const menuWrap = itemEl.querySelector('.email-menu-wrap');
      if (menuWrap) menuWrap.style.display = '';
    }
  }
}

function _showEmailMenu(em, anchor, itemEl) {
  document.querySelectorAll('.email-dropdown').forEach(d => d.remove());

  const dropdown = document.createElement('div');
  dropdown.className = 'dropdown email-dropdown show';

  const actions = [
    { label: 'Open', icon: _replyIcon, action: () => _openEmail(em, itemEl) },
    { label: 'Remind to reply', icon: _bellIcon, submenu: 'remind' },
    { label: 'Archive', icon: _archiveIcon, action: () => _archiveEmail(em) },
    { label: 'Delete', icon: _deleteIcon, danger: true, action: () => _deleteEmail(em) },
  ];

  for (const a of actions) {
    const menuItem = document.createElement('div');
    menuItem.className = 'dropdown-item-compact' + (a.danger ? ' dropdown-item-danger' : '');
    const arrow = a.submenu ? ' <span style="margin-left:auto;opacity:0.5;">›</span>' : '';
    menuItem.innerHTML = _icon(a.icon) + `<span>${a.label}</span>${arrow}`;
    menuItem.addEventListener('click', (e) => {
      e.stopPropagation();
      if (a.submenu === 'remind') {
        _showRemindSubmenu(em, dropdown);
        return;
      }
      dropdown.remove();
      a.action();
    });
    dropdown.appendChild(menuItem);
  }

  anchor.appendChild(dropdown);

  const close = (e) => {
    if (!dropdown.contains(e.target) && !anchor.contains(e.target)) {
      dropdown.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 10);
}

// ---- 提醒子菜单（为此邮件创建带提醒的笔记）----

function _showRemindSubmenu(em, parentDropdown) {
  // 用时间预设替换父下拉菜单的内容
  parentDropdown.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'dropdown-item-compact';
  header.style.cssText = 'opacity:0.5;font-size:10px;pointer-events:none;text-transform:uppercase;letter-spacing:0.5px;padding-top:6px;';
  header.innerHTML = '<span>Remind me</span>';
  parentDropdown.appendChild(header);

  const now = new Date();
  const laterToday = new Date(now);
  const sixPm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0);
  if (sixPm - now < 60*60*1000) laterToday.setTime(now.getTime() + 3 * 60 * 60 * 1000);
  else laterToday.setTime(sixPm.getTime());

  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
  const daysUntilMon = (8 - now.getDay()) % 7 || 7;
  const nextWeek = new Date(now); nextWeek.setDate(now.getDate() + daysUntilMon); nextWeek.setHours(8, 0, 0, 0);

  const presets = [
    { label: 'Later today', sub: laterToday.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), date: laterToday },
    { label: 'Tomorrow', sub: tomorrow.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), date: tomorrow },
    { label: 'Next week', sub: nextWeek.toLocaleDateString([], { weekday: 'short' }) + ' ' + nextWeek.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), date: nextWeek },
  ];
  for (const p of presets) {
    const item = document.createElement('div');
    item.className = 'dropdown-item-compact';
    item.innerHTML = `<span>${p.label}</span><span style="margin-left:auto;opacity:0.5;font-size:10px;">${p.sub}</span>`;
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      parentDropdown.remove();
      await _createReplyReminder(em, p.date);
    });
    parentDropdown.appendChild(item);
  }
  const customItem = document.createElement('div');
  customItem.className = 'dropdown-item-compact';
  customItem.innerHTML = '<span>Pick date and time…</span>';
  customItem.addEventListener('click', async (e) => {
    e.stopPropagation();
    parentDropdown.remove();
    const tmp = document.createElement('input');
    tmp.type = 'datetime-local';
    const def = new Date(tomorrow);
    const pad = n => String(n).padStart(2, '0');
    tmp.value = `${def.getFullYear()}-${pad(def.getMonth()+1)}-${pad(def.getDate())}T${pad(def.getHours())}:${pad(def.getMinutes())}`;
    tmp.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:99999;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:13px;';
    document.body.appendChild(tmp);
    tmp.focus();
    if (typeof tmp.showPicker === 'function') { try { tmp.showPicker(); } catch {} }
    // Cleanup helper — also unwires the global listeners so they don't
    // linger after dismiss.
    const _cleanup = () => {
      tmp.remove();
      document.removeEventListener('keydown', _onKey);
      document.removeEventListener('mousedown', _onDocClick, true);
    };
    const _onKey = (ev) => { if (ev.key === 'Escape') _cleanup(); };
    // Click-outside dismiss. Replaces the old blur-based auto-remove —
    // blur fires whenever the native datetime popup steals focus, so
    // the input vanished before the user could click any date. Now we
    // only dismiss when the user clicks something that is NOT the
    // input itself (the native picker popup is a browser-owned overlay
    // OUTSIDE the document, so its clicks don't fire here at all — no
    // false dismissals).
    const _onDocClick = (ev) => { if (ev.target !== tmp) _cleanup(); };
    tmp.addEventListener('change', async () => {
      if (tmp.value) {
        await _createReplyReminder(em, new Date(tmp.value));
      }
      _cleanup();
    });
    document.addEventListener('keydown', _onKey);
    // 延迟点击外部监听器，以便打开此输入框的点击
    // 不会立即关闭它。
    setTimeout(() => document.addEventListener('mousedown', _onDocClick, true), 50);
  });
  parentDropdown.appendChild(customItem);
}

async function _createReplyReminder(em, dueDate) {
  const pad = n => String(n).padStart(2, '0');
  const iso = `${dueDate.getFullYear()}-${pad(dueDate.getMonth()+1)}-${pad(dueDate.getDate())}T${pad(dueDate.getHours())}:${pad(dueDate.getMinutes())}`;
  const from = em.from || em.sender || 'someone';
  const payload = {
    title: `Reply: ${em.subject || '(no subject)'}`,
    content: `From: ${from}\n\nRemember to reply to this email.`,
    note_type: 'note',
    label: 'email',
    due_date: iso,
    source: 'email',
  };
  try {
    const res = await fetch(`${API_BASE}/api/notes`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed');
    const { showToast } = await import('./ui.js');
    const fmt = dueDate.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    showToast(`Reminder set for ${fmt}`);
    // 如果需要，请求通知权限
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch {}
    }
  } catch (e) {
    const { showError } = await import('./ui.js');
    showError('Failed to create reminder');
  }
}

async function _archiveEmail(em) {
  try {
    await fetch(`${API_BASE}/api/email/archive/${em.uid}?folder=${encodeURIComponent(_currentFolder)}${_acct()}`, { method: 'POST' });
    _emails = _emails.filter(e => e.uid !== em.uid);
    _renderList();
  } catch (e) {
    console.error('Failed to archive:', e);
  }
}

async function _deleteEmail(em) {
  const subject = em.subject || '(no subject)';
  const { styledConfirm } = await import('./ui.js');
  const ok = await styledConfirm(`Delete "${subject}"?`, { confirmText: 'Delete', cancelText: 'Cancel', danger: true });
  if (!ok) return;
  try {
    await fetch(`${API_BASE}/api/email/delete/${em.uid}?folder=${encodeURIComponent(_currentFolder)}${_acct()}`, { method: 'DELETE' });
    _emails = _emails.filter(e => e.uid !== em.uid);
    _renderList();
  } catch (e) {
    console.error('Failed to delete:', e);
  }
}

async function _toggleDone(em, itemEl) {
  const newState = !em.is_answered;
  em.is_answered = newState;
  if (newState) em.is_read = true; // 标记完成意味着标记已读
  if (itemEl) {
    if (newState) {
      itemEl.classList.remove('email-unread');
      // 同时删除渲染器可能添加的任何内联未读指示圆点
      itemEl.querySelectorAll('.email-unread-dot, [data-unread-dot]').forEach(n => n.remove());
    }
    const check = itemEl.querySelector('.email-done-check');
    if (check) check.classList.toggle('active', newState);
  }
  try {
    if (newState) {
      await fetch(`${API_BASE}/api/email/mark-answered/${em.uid}?folder=${encodeURIComponent(_currentFolder)}${_acct()}`, { method: 'POST' });
      await fetch(`${API_BASE}/api/email/mark-read/${em.uid}?folder=${encodeURIComponent(_currentFolder)}${_acct()}`, { method: 'POST' });
    } else {
      await fetch(`${API_BASE}/api/email/clear-answered/${em.uid}?folder=${encodeURIComponent(_currentFolder)}${_acct()}`, { method: 'POST' });
    }
  } catch (e) {
    console.error('Failed to toggle done:', e);
  }
}

async function _createEmailChat(emailData) {
  try {
    // 优先尝试当前会话的端点
    const current = sessionModule.getSessions?.().find(s => s.id === sessionModule.getCurrentSessionId?.());
    let url, model, endpointId;
    if (current && current.endpoint_url && current.model) {
      url = current.endpoint_url;
      model = current.model;
      endpointId = current.endpoint_id;
    } else {
      // 回退到默认聊天配置
      const dcRes = await fetch(`${API_BASE}/api/default-chat`);
      const dc = await dcRes.json();
      url = dc.endpoint_url;
      model = dc.model;
      endpointId = dc.endpoint_id;
    }

    if (url && model) {
      await sessionModule.createDirectChat(url, model, endpointId);
      // 在聊天元数据中设置有用的标题
      const meta = document.getElementById('current-meta');
      if (meta) meta.textContent = t('email.email_meta_label', { subject: (emailData.subject || '').slice(0, 60) });
    }
  } catch (e) {
    console.error('Failed to create email chat:', e);
  }
}

async function _composeNew() {
  if (!_docModule) return;
  // 注意：不要在此处打开面板。下面创建邮件作用域聊天可能
  // 会切换会话，这会拆除面板 — 因此提前打开会挂载窗格，
  // 然后被关闭，然后 injectFreshDoc 重新挂载它：可见的闪烁
  //（文档显示一帧，然后再次滑起）。
  // 在 injectFreshDoc 处，会话 + 文档存在之后挂载一次。
  try {
    // /api/document 需要 session_id（如果为 null 返回 400），因此如果有活动聊天则复用 —
    // the active chat if there is one — otherwise spin up an email-scoped
    // chat first, same pattern the reply path uses.
    let sid = '';
    try { sid = sessionModule?.getCurrentSessionId?.() || ''; } catch (_) {}
    if (!sid) {
      await _createEmailChat({ subject: 'New Email' });
      try { sid = sessionModule?.getCurrentSessionId?.() || ''; } catch (_) {}
    }
    // 保证有一个会话 — 当没有启用的默认聊天端点时，
    // _createEmailChat 无法创建会话，这导致撰写 POST 发送 null
    // session_id → 400（草稿静默地从未出现）。与回复流程使用的
    // 裸会话回退相同。
    if (!sid) {
      try {
        const _fd = new FormData();
        _fd.append('name', 'New Email');
        _fd.append('skip_validation', 'true');
        const _sres = await fetch(`${API_BASE}/api/session`, { method: 'POST', body: _fd, credentials: 'same-origin' });
        if (_sres.ok) {
          const _sdata = await _sres.json();
          if (_sdata && _sdata.id) {
            sid = _sdata.id;
            // 注意：故意不在此处调用 loadSessions()/selectSession()。
            // Re-selecting the (empty) session re-renders the chat and flashes
            // the welcome splash for a frame before the draft opens — the
            // "splash flickers like crazy then email opens" bug. The doc only
            // needs the session_id; the draft opens in the doc panel regardless.
          }
        }
      } catch (e) { console.error('compose: bare session create failed', e); }
    }
    if (!sid) {
      console.error('compose: could not obtain a session_id');
      import('./ui.js').then(m => m.showError && m.showError('Could not start a new email (no session).')).catch(() => {});
      return;
    }
    const res = await fetch(`${API_BASE}/api/document`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sid,
        title: 'New Email',
        content: 'To: \nSubject: \n---\n',
        language: 'email',
      }),
    });
    if (!res.ok) {
      console.error('compose POST failed', res.status, await res.text().catch(() => ''));
      import('./ui.js').then(m => m.showError && m.showError('Failed to create new email (' + res.status + ')')).catch(() => {});
      return;
    }
    const doc = await res.json();
    if (doc.id) {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      // 直接使用 POST 返回的 doc 字典，避免在单独读连接上
      // 访问刚创建的文档时遇到的 GET 404 竞态。
      if (_docModule.injectFreshDoc) {
        _docModule.injectFreshDoc(doc);
      } else {
        _docModule.loadDocument(doc.id);
      }
    }
  } catch (e) {
    console.error('Failed to create email:', e);
  }
}

function _esc(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function _senderColor(name) {
  if (!name) return 'hsl(220, 55%, 65%)';
  const key = name.toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 65%)`;
}
