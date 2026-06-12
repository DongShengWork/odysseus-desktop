/**
 * emailLibrary.js — 电子邮件库弹窗模态框。
 * 与 documentLibrary.js 模式相似。以对网格形式显示邮件，支持搜索/过滤。
 */

import spinnerModule from './spinner.js';
import { styledConfirm, showToast, emptyStateIcon } from './ui.js';
import { folderDisplayName, sortedFolders } from './emailInbox.js';
import settingsModule from './settings.js';
import * as Modals from './modalManager.js';
import { makeWindowDraggable } from './windowDrag.js';
import {
  _esc, _escLinkify, _extractName, _parseTurnMeta,
  _formatBubbleDate, _formatRecipients, _senderColor, _initials,
  _sanitizeHtml,
  _TALON_WROTE, _TALON_FROM, _TALON_SENT, _TALON_SUBJ, _TALON_TO,
  _TALON_ORIG_RE, _SIG_BLOAT_MIN_CHARS,
} from './emailLibrary/utils.js';
import {
  _looksLikeSignature, _harvestAttribution, _extractTurnMetaFromBlockquote,
  _foldSummary, _extractQuoteMeta, _peelSigNameLine, _isBloatedSig,
  _tryFoldHintSig, _foldSignature, _SIG_ICON, _QUOTE_ICON,
} from './emailLibrary/signatureFold.js';
import { state } from './emailLibrary/state.js';
import { t } from './i18n.js';

const API_BASE = window.location.origin;
let _emailUnreadChipClickWired = false;
let _libLoadSeq = 0;
let _libFolderSeq = 0;
let _libSearchSeq = 0;
let _libSearchHadResults = false;
let _activeEmailReaderForSelectAll = null;

function _isEmailTypingTarget(t) {
  return !!(t && (
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable
  ));
}

function _selectEmailReaderContents(reader) {
  if (!reader || !reader.isConnected) return false;
  const hiddenModal = reader.closest('.modal.hidden');
  if (hiddenModal) return false;
  const range = document.createRange();
  range.selectNodeContents(reader);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return true;
}

function _markEmailReaderActive(reader) {
  if (!reader) return;
  _activeEmailReaderForSelectAll = reader;
  if (reader.dataset.selectAllWired === '1') return;
  reader.dataset.selectAllWired = '1';
  reader.addEventListener('pointerdown', () => { _activeEmailReaderForSelectAll = reader; }, true);
  reader.addEventListener('focusin', () => { _activeEmailReaderForSelectAll = reader; }, true);
}

const _COPY_EMAIL_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function _decodeAttrValue(v) {
  const tmp = document.createElement('textarea');
  tmp.innerHTML = v || '';
  return tmp.value;
}

function _emailAddressFromRecipientText(text) {
  const raw = String(text || '').trim();
  const angle = raw.match(/<\s*([^<>@\s]+@[^<>\s]+)\s*>/);
  if (angle) return angle[1].trim();
  const any = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return any ? any[0].trim() : raw;
}

function _splitRecipientList(raw) {
  const out = [];
  let cur = '';
  let quote = false;
  let angle = false;
  const s = String(raw || '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== '\\') quote = !quote;
    else if (ch === '<' && !quote) angle = true;
    else if (ch === '>' && !quote) angle = false;

    if (ch === ',' && !quote && !angle) {
      const part = cur.trim();
      if (part) out.push(part);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

async function _copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
}

function _recipientChipHtml(full, label, extraClass = '') {
  const fullText = String(full || '').trim();
  const addr = _emailAddressFromRecipientText(fullText);
  const labelText = String(label || addr || fullText || '').trim();
  const cls = `recipient-chip${extraClass ? ` ${extraClass}` : ''}`;
  return `<span class="${cls}" data-full="${_esc(fullText || labelText)}" data-email="${_esc(addr)}" title="Click for details"><span class="recipient-chip-label">${_esc(labelText)}</span><button type="button" class="recipient-chip-copy" title="Copy email" aria-label="Copy email" hidden>${_COPY_EMAIL_ICON}</button></span>`;
}

function _wireRecipientChips(root) {
  if (!root || root.dataset.recipientChipsWired === '1') return;
  root.dataset.recipientChipsWired = '1';
  root.addEventListener('click', async (ev) => {
    const copyBtn = ev.target.closest?.('.recipient-chip-copy');
    if (copyBtn && root.contains(copyBtn)) {
      ev.stopPropagation();
      ev.preventDefault();
      const chip = copyBtn.closest('.recipient-chip');
      const email = chip?.dataset.email || _emailAddressFromRecipientText(_decodeAttrValue(chip?.dataset.full || ''));
      if (!email) return;
      try {
        const copied = await _copyTextToClipboard(email);
        if (!copied) throw new Error('copy failed');
        copyBtn.classList.add('copied');
        copyBtn.title = t('email.copied');
        showToast?.('Email copied');
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.title = t('email.copy_email');
        }, 900);
      } catch (_) {
        showToast?.('Copy failed');
      }
      return;
    }

    const chip = ev.target.closest?.('.recipient-chip');
    if (!chip || !root.contains(chip)) return;
    ev.stopPropagation();
    ev.preventDefault();
    const label = chip.querySelector('.recipient-chip-label');
    const copy = chip.querySelector('.recipient-chip-copy');
    if (chip.classList.contains('expanded')) {
      chip.classList.remove('expanded');
      if (label) label.textContent = chip.dataset.name || label.textContent;
      if (copy) copy.hidden = true;
    } else {
      if (!chip.dataset.name && label) chip.dataset.name = label.textContent.trim();
      chip.classList.add('expanded');
      const expandedText = _decodeAttrValue(chip.dataset.full || '').trim()
        || chip.dataset.name
        || chip.dataset.email
        || label?.textContent?.trim()
        || '';
      if (label && expandedText) label.textContent = expandedText;
      if (copy) copy.hidden = false;
    }
  });
}

function _emailReaderForSelectAllTarget(target) {
  if (_isEmailTypingTarget(target)) return null;
  const direct = target?.closest?.('.email-card-reader, #email-lib-modal .doclib-card.doclib-card-expanded');
  if (direct) return direct.querySelector?.('.email-card-reader') || direct;
  const expanded = document.querySelector('#email-lib-modal:not(.hidden) .doclib-card.doclib-card-expanded .email-card-reader');
  if (expanded) return expanded;
  return _activeEmailReaderForSelectAll;
}

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || String(e.key || '').toLowerCase() !== 'a') return;
  const reader = _emailReaderForSelectAllTarget(e.target);
  if (!_selectEmailReaderContents(reader)) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation?.();
}, true);

function _syncEmailReadState(uid, isRead = true) {
  if (uid == null) return;
  const uidStr = String(uid);
  const read = !!isRead;
  const match = (state._libEmails || []).find(x => String(x.uid) === uidStr);
  if (match) match.is_read = read;

  document.querySelectorAll('.doclib-card[data-uid="' + CSS.escape(uidStr) + '"]').forEach(card => {
    card.classList.toggle('email-card-unread', !read);
    const titleRow = card.querySelector('.email-card-titlerow');
    if (read) {
      card.querySelectorAll('.email-card-unread-dot, [data-unread-dot]').forEach(n => n.remove());
      if (titleRow) {
        titleRow.querySelectorAll('span').forEach(s => {
          const st = s.getAttribute('style') || '';
          if (/width:\s*6px/.test(st) && /border-radius:\s*50%/.test(st)) s.remove();
        });
      }
      return;
    }

    if (!titleRow || titleRow.querySelector('.email-card-unread-dot, [data-unread-dot]')) return;
    const isSentFolder = /sent/i.test(state._libFolder || '');
    if (isSentFolder) return;
    const senderName = match ? (match.from_name || match.from_address || '') : '';
    const dot = document.createElement('span');
    dot.className = 'email-card-unread-dot';
    dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${_senderColor(senderName)};flex-shrink:0;margin-left:2px;`;
    const done = titleRow.querySelector('.email-card-done');
    const rightCluster = titleRow.querySelector('.email-card-header-menu')?.parentElement;
    if (done) done.insertAdjacentElement('afterend', dot);
    else if (rightCluster) titleRow.insertBefore(dot, rightCluster);
    else titleRow.appendChild(dot);
  });
}

  // 回复从文档编辑器发送时，源邮件在服务端标记为
  // \Answered 并触发 `email-answered` 事件。实时反映该状态，
  // 使邮件显示为已完成，无需等待手动刷新。
  window.addEventListener('email-answered', (e) => {
  const uid = e.detail && e.detail.uid;
  if (uid == null) return;
  const em = (state._libEmails || []).find(x => String(x.uid) === String(uid));
  if (em) { em.is_answered = true; em.is_read = true; }
  _syncEmailReadState(uid, true);
  document.querySelectorAll('.doclib-card[data-uid="' + CSS.escape(String(uid)) + '"]').forEach(card => {
    card.classList.add('email-card-answered');
    card.classList.remove('email-card-unread');
    const check = card.querySelector('.email-card-done');
    if (check) check.classList.add('active');
  });
});

function _toggleUnreadEmails() {
  if (state._libFolder === '__scheduled__') state._libFolder = 'INBOX';
  state._libFilter = state._libFilter === 'unread' ? 'all' : 'unread';
  _syncUnreadWindowGlow();
  const folderEl = document.getElementById('email-lib-folder');
  const filterEl = document.getElementById('email-lib-filter');
  if (folderEl) folderEl.value = state._libFolder || 'INBOX';
  if (filterEl) filterEl.value = state._libFilter;
  document.getElementById('email-undone-btn')?.classList.remove('active');
  document.getElementById('email-reminder-btn')?.classList.remove('active');
  _loadEmailsFresh();
}

function _syncUnreadTabBadge(count) {
  const label = count > 999 ? '999+ unread' : `${count} unread`;
  document.querySelectorAll('.minimized-dock-chip[data-modal-id="email-lib-modal"]').forEach(chip => {
    if (count > 0) {
      chip.dataset.emailUnreadLabel = label;
      chip.title = `Open ${label}`;
    } else {
      delete chip.dataset.emailUnreadLabel;
      chip.title = t('email.restore_email');
    }
  });
}

function _syncUnreadWindowGlow() {
  document.getElementById('email-lib-modal')?.classList.toggle('email-lib-unread-active', state._libFilter === 'unread');
}

function _syncReminderClearButton() {
  document.getElementById('email-reminders-clear-btn')?.classList.toggle('hidden', state._libFilter !== 'reminders');
}

function _renderAccountsLoading() {
  const strip = document.getElementById('email-lib-accounts');
  if (!strip) return;
  strip.style.display = 'flex';
  strip.innerHTML = '';
  try {
    const wp = spinnerModule.createWhirlpool(14);
    wp.element.classList.add('email-accounts-loading-whirlpool');
    const label = document.createElement('span');
    label.className = 'email-accounts-loading-label';
    label.textContent = t('email.accounts');
    strip.appendChild(wp.element);
    strip.appendChild(label);
  } catch (_) {
    strip.textContent = t('email.accounts') + '...';
  }
}

function _syncEmailReminderBellVisibility(enabled) {
  const btn = document.getElementById('email-reminder-btn');
  const wrap = document.querySelector('#email-lib-modal .email-search-wrap');
  btn?.classList.toggle('hidden', !enabled);
  wrap?.classList.toggle('email-reminder-bell-hidden', !enabled);
}

async function _loadEmailReminderBellVisibility() {
  try {
    const res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    const settings = await res.json();
    _syncEmailReminderBellVisibility(settings.reminder_channel === 'email');
  } catch (_) {
    _syncEmailReminderBellVisibility(false);
  }
}

function _readCssPx(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function _emailSplitLeftEdge() {
  return _readCssPx('--icon-rail-w') + _readCssPx('--sidebar-w');
}

function _setEmailDocumentSplit(leftEdge, emailWidth) {
  if (window.innerWidth <= 768) return;
  // 句点间隙为零，使文档窗格紧贴邮件右边缘。
  // modalSnap.js 的左停靠路径以 0 间隙发布相同的变量 — 两个系统
  // 在紧贴上达成一致，因此它们之间的切换不会导致文档
  // "跳动"侧移。每侧 1px 的模态边框就是视觉接缝。
  const splitGap = 0;
  const left = Math.max(0, Math.round(leftEdge || 0));
  const width = Math.max(320, Math.round(emailWidth || 420));
  const x = left + width + splitGap;
  document.body.classList.add('email-doc-split-active');
  document.documentElement.style.setProperty('--email-doc-split-left-x', `${left}px`);
  document.documentElement.style.setProperty('--email-doc-split-email-w', `${width}px`);
  document.documentElement.style.setProperty('--email-doc-split-right-x', `${x}px`);
}

function _measureEmailDocumentSplit(modal) {
  if (window.innerWidth <= 768 || !document.body.classList.contains('email-doc-split-active')) return;
  const content = modal?.querySelector?.('.modal-content');
  const rect = content?.getBoundingClientRect?.();
  if (!rect || !rect.width) return;
  const splitGap = 0;
  document.documentElement.style.setProperty('--email-doc-split-right-x', `${Math.ceil(rect.right + splitGap)}px`);
  try {
    modal.style.setProperty('z-index', '150', 'important');
    if (content) {
      content.style.setProperty('position', 'absolute', 'important');
      content.style.setProperty('left', '0px', 'important');
      content.style.setProperty('right', 'auto', 'important');
      content.style.setProperty('width', `${Math.ceil(rect.width)}px`, 'important');
      content.style.setProperty('max-width', `${Math.ceil(rect.width)}px`, 'important');
    }
    const docPane = document.getElementById('doc-editor-pane');
    if (docPane) {
      docPane.style.setProperty('position', 'fixed', 'important');
      docPane.style.setProperty('left', `${Math.ceil(rect.right + splitGap)}px`, 'important');
      docPane.style.setProperty('right', '0px', 'important');
      docPane.style.setProperty('top', '0px', 'important');
      docPane.style.setProperty('bottom', '0px', 'important');
      docPane.style.setProperty('width', 'auto', 'important');
      docPane.style.setProperty('max-width', 'none', 'important');
      docPane.style.setProperty('height', '100vh', 'important');
      docPane.style.setProperty('z-index', '260', 'important');
    }
  } catch (_) {}
}

function _scheduleEmailDocumentSplitMeasure(modal) {
  requestAnimationFrame(() => {
    _measureEmailDocumentSplit(modal);
    requestAnimationFrame(() => _measureEmailDocumentSplit(modal));
  });
  setTimeout(() => _measureEmailDocumentSplit(modal), 260);
  setTimeout(() => _measureEmailDocumentSplit(modal), 700);
}

function _clearEmailDocumentSplit() {
  document.body.classList.remove('email-doc-split-active');
  document.documentElement.style.removeProperty('--email-doc-split-left-x');
  document.documentElement.style.removeProperty('--email-doc-split-email-w');
  document.documentElement.style.removeProperty('--email-doc-split-right-x');
  const docPane = document.getElementById('doc-editor-pane');
  if (!docPane) return;
  [
    'position', 'left', 'right', 'top', 'bottom', 'width', 'max-width',
    'height', 'z-index', 'transform',
  ].forEach(prop => docPane.style.removeProperty(prop));
}

function _hasDesktopRoomForEmailAndDocument(modal) {
  if (window.innerWidth <= 768) return false;
  if (window.innerWidth >= 1100) return true;
  const content = modal?.querySelector?.('.modal-content');
  const rect = content?.getBoundingClientRect?.();
  const isFullscreen = modal?.classList?.contains('email-lib-fullscreen')
    || modal?.classList?.contains('email-window-fullscreen');
  const emailWidth = isFullscreen
    ? Math.min(440, Math.max(360, Math.round(window.innerWidth * 0.30)))
    : Math.max(360, Math.round(rect?.width || 440));
  const docMinWidth = 560;
  const breathingRoom = 72;
  const leftEdge = isFullscreen ? _emailSplitLeftEdge() : Math.max(0, Math.round(rect?.left || _emailSplitLeftEdge()));
  return (window.innerWidth - leftEdge - emailWidth) >= (docMinWidth + breathingRoom);
}

function _prepareEmailWindowForDocument(modal) {
  if (window.innerWidth <= 768) return true;
  if (!modal) return false;
  if (!_hasDesktopRoomForEmailAndDocument(modal)) {
    _clearEmailDocumentSplit();
    return true;
  }
  if (modal.classList.contains('modal-left-docked')) {
    const content = modal.querySelector('.modal-content');
    const rect = content?.getBoundingClientRect?.();
    if (content?._leftDockNavObs) {
      try { content._leftDockNavObs.navObs.disconnect(); } catch (_) {}
      try { content._leftDockNavObs.bodyObs && content._leftDockNavObs.bodyObs.disconnect(); } catch (_) {}
      try { content._leftDockNavObs.disconnectDocObs && content._leftDockNavObs.disconnectDocObs(); } catch (_) {}
      try { window.removeEventListener('resize', content._leftDockNavObs.reanchor); } catch (_) {}
      delete content._leftDockNavObs;
    }
    modal.classList.remove('modal-left-docked');
    modal.classList.add('email-snap-left');
    document.body.classList.remove('left-dock-active');
    document.documentElement.style.removeProperty('--left-dock-w');
    if (content) {
      delete content._dockSide;
      content.style.position = 'fixed';
      content.style.left = Math.round(rect?.left || _emailSplitLeftEdge()) + 'px';
      content.style.top = '0';
      content.style.right = 'auto';
      content.style.bottom = '0';
      content.style.width = Math.round(rect?.width || 440) + 'px';
      content.style.maxWidth = Math.round(rect?.width || 440) + 'px';
      content.style.height = '100vh';
      content.style.maxHeight = '100vh';
      content.style.borderRadius = '0';
      content.style.transform = 'none';
      content.style.margin = '0';
    }
  }
  if (modal.classList.contains('email-snap-left') || modal.classList.contains('modal-left-docked')) {
    const rect = modal.querySelector('.modal-content')?.getBoundingClientRect?.();
    _setEmailDocumentSplit(rect?.left || _emailSplitLeftEdge(), rect?.width || 420);
    _scheduleEmailDocumentSplitMeasure(modal);
    return false;
  }
  // 如果 Email 是全屏且空间足够，将其停靠到左侧而不是最小化，
  // 这样文档/撰写窗格可以在旁边打开。
  _snapEmailModalToLeftSidebar(modal);
  return false;
}

function _wireUnreadTabClick() {
  if (_emailUnreadChipClickWired) return;
  _emailUnreadChipClickWired = true;
  document.addEventListener('click', (e) => {
    const chip = e.target?.closest?.('.minimized-dock-chip[data-modal-id="email-lib-modal"][data-email-unread-label]');
    if (!chip || e.target?.classList?.contains('minimized-dock-x')) return;
    setTimeout(_toggleUnreadEmails, 0);
  });
}

async function _deleteEmailAndAdvance(em, card, opts = {}) {
  if (!em || em.uid == null) return;
  if (opts.confirm !== false) {
    const subject = em.subject || '(no subject)';
    const ok = await styledConfirm(`Delete "${subject}"?`, { confirmText: 'Delete', cancelText: 'Cancel', danger: true });
    if (!ok) return;
  }
  const wasExpanded = !!card?.classList?.contains('doclib-card-expanded');
  const sibling = wasExpanded
    ? (_findSiblingEmailCard(card, +1) || _findSiblingEmailCard(card, -1))
    : null;
  const nextUid = sibling ? sibling.dataset.uid : null;
  try {
    await fetch(`${API_BASE}/api/email/delete/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'DELETE' });
  } catch (err) {
    console.error('Failed to delete email:', err);
    showToast('Failed to delete email');
    return;
  }
  await _animateEmailCardRemoval([em.uid]);
  state._libEmails = state._libEmails.filter(e => String(e.uid) !== String(em.uid));
  state._selectedUids.delete(em.uid);
  _updateBulkBar();
  _renderGrid();
  _libCacheWriteBack();
  showToast('Moved to Trash');
  if (!wasExpanded || !nextUid) return;
  const grid = document.getElementById('email-lib-grid');
  const nextCard = grid?.querySelector(`.doclib-card[data-uid="${CSS.escape(String(nextUid))}"]`);
  const nextEm = state._libEmails.find(e => String(e.uid) === String(nextUid));
  if (nextCard && nextEm) {
    await _toggleCardPreview(nextCard, nextEm);
    nextCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    document.getElementById('email-lib-modal')?.classList.remove('email-reading');
  }
}

function _animateEmailCardRemoval(uids, opts = {}) {
  const uidSet = new Set((uids || []).map(uid => String(uid)));
  if (!uidSet.size) return Promise.resolve();
  const grid = document.getElementById('email-lib-grid');
  if (!grid) return Promise.resolve();
  const cards = Array.from(grid.querySelectorAll('.doclib-card[data-uid]'))
    .filter(card => uidSet.has(String(card.dataset.uid)));
  if (!cards.length) return Promise.resolve();
  const duration = Number(opts.duration || 230);

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--email-remove-h', `${Math.max(rect.height, card.scrollHeight)}px`);
    card.style.maxHeight = 'var(--email-remove-h)';
    card.style.overflow = 'hidden';
    card.classList.add('email-card-removing');
  }

  return new Promise(resolve => {
    window.setTimeout(resolve, duration + 35);
  });
}


// 当账户被主动选中时，附加 &account_id=... 的 URL 后缀辅助函数。
// 此文件中的每个邮件路由调用都经过这里，因此切换账户
// 只是单个变量的翻转。
// 打开设置模态框并激活特定标签页。用于电子邮件/日历等中的空状态
// "设置于：设置 › X" 链接。
function _openSettingsTab(tab) {
  if (tab === 'integrations' && window.adminModule && typeof window.adminModule.open === 'function') {
    window.adminModule.open('integrations');
    return;
  }
  if (settingsModule && typeof settingsModule.open === 'function') {
    settingsModule.open(tab || 'services');
    return;
  }
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const tabBtn = modal.querySelector(`[data-settings-tab="${tab || 'services'}"]`);
  if (tabBtn) tabBtn.click();
}

function _emailSetupHintHtml() {
  return '<div style="margin-top:6px;opacity:0.72;font-size:11px;">' +
    'Setup: <a href="#" data-open-settings="integrations" style="color:var(--accent,var(--red));text-decoration:underline;">Settings &rsaquo; Integrations</a>' +
    '</div>';
}

function _wireEmailSetupHint(root) {
  root?.querySelectorAll?.('[data-open-settings]').forEach(link => {
    if (link.dataset.emailSetupBound === '1') return;
    link.dataset.emailSetupBound = '1';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      _openSettingsTab(link.dataset.openSettings || 'integrations');
    });
  });
}

function _acct() {
  return state._libAccountId ? `&account_id=${encodeURIComponent(state._libAccountId)}` : '';
}

// 每个（账户、文件夹、过滤器、附件）第一页列表响应的缓存。
// 允许关闭后重新打开时立即显示之前的列表，而网络刷新在后台运行 —
// 以前模态框每次打开都会清空其 DOM 并从空状态显示旋转器，
// 即使相同的视图仅一秒前还可见。
//
// 会话级别（存在于模块作用域中，硬刷新时清除）。
// 搜索结果和 __scheduled__ 特意不缓存。
const _libListCache = new Map();
const _LIB_CACHE_MAX = 24;
let _libPrewarmTimer = null;
let _libPrewarmPromise = null;
let _libLastPrewarmAt = 0;

function _libCacheKeyFor(accountId, folder, filter, hasAttachments) {
  return [
    accountId || '',
    folder || '',
    filter || '',
    hasAttachments ? 1 : 0,
  ].join('|');
}
function _libCacheKey() {
  return _libCacheKeyFor(
    state._libAccountId || '',
    state._libFolder || '',
    state._libFilter || '',
    state._libHasAttachments
  );
}
function _libCacheGet(key) { return _libListCache.get(key) || null; }
function _libCachePut(key, value) {
  // 重新插入以提升 LRU 最近性。
  _libListCache.delete(key);
  _libListCache.set(key, value);
  if (_libListCache.size > _LIB_CACHE_MAX) {
    const oldest = _libListCache.keys().next().value;
    _libListCache.delete(oldest);
  }
}

function _resetEmailListForFreshLoad() {
  state._libOffset = 0;
  state._libEmails = [];
  state._libTotal = 0;
  _libLoadSeq += 1;
  const grid = document.getElementById('email-lib-grid');
  if (grid) _renderEmailLoading(grid);
  const stats = document.getElementById('email-lib-stats');
  if (stats) stats.textContent = t('email.loading');
}

function _loadEmailsFresh() {
  _resetEmailListForFreshLoad();
  return _loadEmails({ force: true, useCache: false });
}

export function prewarmEmailLibrary({ delay = 2500 } = {}) {
  if (_libPrewarmTimer || _libPrewarmPromise) return;
  const elapsed = Date.now() - _libLastPrewarmAt;
  if (elapsed >= 0 && elapsed < 60000) return;
  _libPrewarmTimer = setTimeout(() => {
    _libPrewarmTimer = null;
    _libPrewarmPromise = _prewarmDefaultEmailView()
      .catch(() => {})
      .finally(() => { _libPrewarmPromise = null; });
  }, Math.max(0, Number(delay) || 0));
}

async function _prewarmDefaultEmailView() {
  if (state._libOpen) return;
  _libLastPrewarmAt = Date.now();
  const folder = 'INBOX';
  const filter = 'all';
  const accountId = state._libAccountId || '';
  const ck = _libCacheKeyFor(accountId, folder, filter, false);
  if (_libCacheGet(ck)) return;

  // 账户请求成本低，为首次打开预热账户条。
  // 然后列表请求同时预热客户端缓存和后端 IMAP/读缓存。
  // 故障保持静默：未配置邮件不应在应用启动时烦扰用户。
  try {
    const accountsRes = await fetch(`${API_BASE}/api/email/accounts`, { credentials: 'same-origin' });
    if (accountsRes.ok) {
      const accountsData = await accountsRes.json().catch(() => ({}));
      if (Array.isArray(accountsData.accounts)) state._libAccounts = accountsData.accounts;
    }
  } catch (_) {}

  const accountQS = accountId ? `&account_id=${encodeURIComponent(accountId)}` : '';
  const res = await fetch(`${API_BASE}/api/email/list?folder=${encodeURIComponent(folder)}${accountQS}&limit=100&offset=0&filter=${filter}`, {
    credentials: 'same-origin',
  });
  if (!res.ok) return;
  const data = await res.json().catch(() => null);
  if (!data || data.error) return;
  _libCachePut(ck, { emails: data.emails || [], total: data.total || 0 });
}
function _libCacheWriteBack() {
  // 在本地变更已更新 state._libEmails 后
  //（删除/归档/批量操作），将更改同步到缓存中，以便
  // 下次重新打开时在重新 fetch 成功前不会短暂显示变更前的状态。
  // 在搜索期间跳过（结果不是真实列表），
  // 以及计划的虚拟文件夹。
  if (state._libSearch) return;
  if (state._libFolder === '__scheduled__') return;
  const ck = _libCacheKey();
  if (_libListCache.has(ck)) {
    _libCachePut(ck, { emails: state._libEmails.slice(), total: state._libTotal });
  }
}

// 将活动账户 ID 暴露给其他模块（document.js 发送邮件时使用此值）。
// 使用简单的全局变量而非跨模块导入，以保持耦合最小。
function _publishActiveAccount() {
  try { window.__odysseusActiveEmailAccount = state._libAccountId || null; } catch (_) {}
  // 发布活动账户的自身地址，以便回复全部可以将我们从
  // 收件人列表中排除。此全局变量在 emailInbox.js 中被读取但从未被设置。
  try {
    const accts = state._libAccounts || [];
    const active = accts.find(a => a && a.id === state._libAccountId)
      || accts.find(a => a && a.is_default)
      || accts[0];
    window._myEmailAddress = (active && (active.from_address || active.imap_user)) || '';
    // 同时发布所有已配置的地址，以便回复全部可以排除用户的
    // 所有邮箱，而不仅仅是活动账户（多账户用户的其他地址
    // 之前被添加到了抄送中）。
    const all = [];
    for (const a of accts) {
      if (a && a.from_address) all.push(a.from_address);
      if (a && a.imap_user) all.push(a.imap_user);
    }
    window._myEmailAddresses = all;
  } catch (_) {}
}

export function initEmailLibrary(config) {
  state._docModule = config.documentModule;
  state._onEmailClick = config.onEmailClick;
}

export function isOpen() { return state._libOpen; }

export function openEmailLibrary(opts = {}) {
  // 强行清理之前尝试的任何陈旧状态
  const existing = document.getElementById('email-lib-modal');
  if (existing) existing.remove();
  if (state._libEscHandler) {
    document.removeEventListener('keydown', state._libEscHandler, true);
    state._libEscHandler = null;
  }
  state._libOpen = true;
  // 在移动端侧边栏覆盖内容 — 关闭它，以免邮件视图在后面打开
  //（与会话切换/删除相同的模式）。
  if (window.innerWidth <= 768) {
    const _sb = document.getElementById('sidebar');
    if (_sb) _sb.classList.add('hidden');
    const _bd = document.getElementById('sidebar-backdrop');
    if (_bd) _bd.classList.remove('visible');
    // 邮件最后打开 → 将邮件窗口置于任何打开文档之前
    //（它们交替：最后打开的那个胜出）。文档在背后保持打开；
    // 重新打开文档会将其翻回顶部。
    document.body.classList.add('email-front');
  }
  state._libEmails = [];
  state._libOffset = 0;
  state._libSearch = '';
  state._libFilter = 'all';
  state._libHasAttachments = false;
  // 以多米诺级联动画渲染第一张卡片（与侧边栏 section-domino-in
  // 关键帧相同）。在动画排队后由 _renderGrid 重置，以便后续的
  // 过滤器/排序重新渲染是即时的。
  state._libJustOpened = true;
  if (Object.prototype.hasOwnProperty.call(opts, 'account_id')) {
    state._libAccountId = opts.account_id || null;
    _publishActiveAccount();
  }
  if (opts.folder) state._libFolder = opts.folder;
  state._libPendingExpandUid = opts.uid || null;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'email-lib-modal';
  modal.innerHTML = `
    <div class="modal-content doclib-modal-content" style="width:min(720px, 92vw);max-height:85vh;background:var(--bg);">
      <div class="modal-header">
        <h4>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
          </svg>
          Email
          <span id="email-lib-unread-badge" class="email-lib-unread-badge" role="button" tabindex="0" title="Show unread emails" style="display:none"></span>
          <span id="email-lib-stats" class="memory-count" style="font-size:0.6em;opacity:0.6;font-weight:normal;margin-left:8px;position:relative;top:-2px"></span>
        </h4>
        <div class="email-lib-header-actions" style="display:flex;align-items:center;gap:8px;">
          <button class="close-btn" id="email-lib-close">\u2716</button>
        </div>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:10px;overflow:hidden;">
        <div class="admin-card" style="flex:1;flex-direction:column;display:flex;overflow:hidden;">
          <p class="memory-desc doclib-desc">All emails. Click to open as a document.</p>
          <div class="email-accounts-row">
            <div id="email-lib-accounts" style="display:flex;gap:4px;flex:1;min-width:0;"></div>
            <button class="memory-toolbar-btn email-compose-jiggle" id="email-lib-compose-btn">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px;"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
              New
            </button>
          </div>
          <div class="memory-toolbar">
            <div class="memory-category-filters">
              <select class="memory-sort-select" id="email-lib-folder" style="flex:1;min-width:0;text-overflow:ellipsis;">
                <option value="INBOX">Inbox</option>
              </select>
              <select class="memory-sort-select" id="email-lib-filter" style="flex:1;min-width:0;">
                <option value="all">All</option>
                <option value="unread">Unread</option>
                <option value="favorites">Favorites</option>
                <option value="undone">Undone</option>
                <option value="reminders">Reminders</option>
                <option value="unanswered">Unanswered</option>
                <option value="pending_30d">Pending · 30d</option>
                <option value="stale_30d">Stale · &gt;30d</option>
                <optgroup label="Tags">
                  <option value="tag:urgent">Urgent</option>
                  <option value="tag:reply-soon">Reply soon</option>
                  <option value="tag:spam">Spam</option>
                  <option value="tag:newsletter">Newsletter</option>
                  <option value="tag:marketing">Marketing</option>
                </optgroup>
              </select>
              <button class="memory-toolbar-btn email-filter-select-btn" id="email-lib-select-btn">Select</button>
              <button class="memory-toolbar-btn email-filter-refresh-btn" id="email-lib-refresh-btn" title="Refresh">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
              </button>
              <button class="memory-toolbar-btn email-reminders-clear-btn hidden" id="email-reminders-clear-btn" title="Permanently delete Odysseus reminder emails">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>
                Clear
              </button>
            </div>
            <div class="email-search-row" style="display:flex;gap:6px;align-items:flex-start;">
            <div class="email-search-wrap" style="position:relative;flex:1;min-width:140px;">
              <input type="text" id="email-lib-search" placeholder="Search emails\u2026" class="memory-search-input" style="width:100%;padding-right:96px;" />
              <button class="memory-toolbar-btn email-undone-toggle email-undone-toggle-inline" id="email-undone-btn" title="Show only emails not marked as done (undone)">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </button>
              <button class="memory-toolbar-btn email-reminder-toggle-inline hidden" id="email-reminder-btn" title="Show Odysseus reminder emails">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>
              </button>
              <button class="memory-toolbar-btn email-attach-toggle email-attach-toggle-inline" id="email-attach-btn" title="Show only emails with attachments">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              </button>
            </div>
            </div>
          </div>
          <div id="email-lib-bulk" class="memory-bulk-bar hidden" style="margin-bottom:5px;">
            <label class="memory-bulk-check-all" style="position:relative;top:2px;"><input type="checkbox" id="email-lib-select-all"> All</label>
            <span id="email-lib-selected-count" style="position:relative;top:1px;">0 Selected</span>
            <button class="memory-toolbar-btn" id="email-lib-bulk-actions" style="position:relative;top:-2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>Actions <span style="opacity:0.55;font-size:9px;">▼</span></button>
            <button class="memory-toolbar-btn" id="email-lib-bulk-delete" style="position:relative;top:-2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>Delete</button>
            <button class="memory-toolbar-btn" id="email-lib-bulk-cancel" title="Cancel (Esc)" style="margin-left:4px;padding:3px 6px;position:relative;top:-2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div id="email-lib-grid" class="doclib-grid"></div>
          <button class="email-lib-fab" id="email-lib-fab" type="button" aria-label="New email">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M3 6.5l9 6 9-6"/></svg>
            <span class="email-lib-fab-label">New</span>
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.style.display = 'block';
  // 使模态背景非阻塞，以便用户可以与应用的其余部分交互
  modal.style.cssText += 'pointer-events:none;background:transparent;';

  // 注册以便芯片带有正确的标签/图标。restoreFn 留空 —
  // 只需取消最小化模态框就足够了；其中展开的任何邮件
  // 保持展开状态。
  try {
    Modals.register('email-lib-modal', {
      label: 'Email',
      icon: 'M2 4h20v16H2zM22 7l-9.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7',
      closeFn: () => {
        const m = document.getElementById('email-lib-modal');
        if (m) m.classList.add('hidden');
      },
      restoreFn: () => {
        // 最后重新打开 → 将邮件窗口置于任何打开文档之前。
        document.body.classList.add('email-front');
        // 移动端：点击库芯片会将任何打开的邮件阅读器芯片收起，
        // 以便库是唯一可见的窗口。与每个阅读器的 restoreFn 配对，
        // 当阅读器被调出时将库芯片收起。
        if (window.innerWidth <= 768) {
          document.querySelectorAll('.modal[id^="email-reader-"]').forEach(other => {
            try {
              if (Modals.isRegistered(other.id) && !Modals.isMinimized(other.id)) {
                Modals.minimize(other.id);
              }
            } catch {}
          });
        }
      },
    });
  } catch (_) {}
  _wireUnreadTabClick();
  const unreadBadge = document.getElementById('email-lib-unread-badge');
  unreadBadge?.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleUnreadEmails();
  });
  unreadBadge?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    _toggleUnreadEmails();
  });
  const content = modal.querySelector('.modal-content');
  if (content) {
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
      // 移动端底部锚定面板
      content.style.position = 'fixed';
      content.style.pointerEvents = 'auto';
      content.style.left = '0';
      content.style.right = '0';
      content.style.bottom = '0';
      content.style.top = 'auto';
      content.style.transform = 'none';
    } else {
      // 使用固定定位 + 计算偏移量在屏幕上居中
      content.style.position = 'fixed';
      content.style.pointerEvents = 'auto';
      // 等待一帧以便尺寸稳定，然后居中。根据模态框的 max-height (85vh)
      // 居中 — 不是根据实时的 offsetHeight，后者在邮件列表仍在加载时
      // 很小，会将窗口放在约 1/3 的位置（然后随着列表填充向下增长到超出底部）。
      requestAnimationFrame(() => {
        const w = content.offsetWidth;
        const refH = window.innerHeight * 0.85;
        content.style.left = Math.max(20, (window.innerWidth - w) / 2) + 'px';
        content.style.top = Math.max(20, (window.innerHeight - refH) / 2) + 'px';
        content.style.transform = 'none';
      });
    }
  }

  // 连线事件
  document.getElementById('email-lib-close').addEventListener('click', closeEmailLibrary);

  // 点击模态框头部（按钮/输入框除外）会折叠当前展开的邮件卡片
  // 并返回收件箱列表视图。作为"返回邮件菜单"的手势。
  const libHeader = modal.querySelector('.modal-header');
  if (libHeader) {
    libHeader.style.cursor = 'pointer';
    libHeader.addEventListener('click', (ev) => {
      if (ev.target.closest('button, input, select, a')) return;
      const g = document.getElementById('email-lib-grid');
      if (!g) return;
      g.querySelectorAll('.doclib-card.doclib-card-expanded').forEach(c => {
        const uid = c.dataset.uid;
        const liveEm = state._libEmails.find(e => String(e.uid) === String(uid));
        if (liveEm) _toggleCardPreview(c, liveEm);
      });
    });
  }

  // 拖拽到顶部边缘 → 吸附到全屏（Aero Snap）。在全屏时拖离
  // 顶部边缘则取消吸附回居中窗口。
  _makeDraggable(content, modal, 'email-lib-fullscreen');

  document.getElementById('email-lib-folder').addEventListener('change', (e) => {
    state._libFolder = e.target.value;
    _loadEmailsFresh();
  });
  document.getElementById('email-lib-filter').addEventListener('change', (e) => {
    state._libFilter = e.target.value;
    _syncUnreadWindowGlow();
    _syncReminderClearButton();
    _loadEmailsFresh();
    // 同步快速切换的激活状态，使其与下拉菜单匹配。
    document.getElementById('email-undone-btn')?.classList.toggle('active', state._libFilter === 'undone');
    document.getElementById('email-reminder-btn')?.classList.toggle('active', state._libFilter === 'reminders');
  });
  document.getElementById('email-attach-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('email-attach-btn');
    state._libHasAttachments = !state._libHasAttachments;
    btn?.classList.toggle('active', state._libHasAttachments);
    _syncReminderClearButton();
    _loadEmailsFresh();
  });
  document.getElementById('email-reminders-clear-btn')?.addEventListener('click', async () => {
    const ok = await styledConfirm('Permanently delete all Odysseus reminder emails?', {
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API_BASE}/api/email/odysseus/reminders?permanent=1${_acct()}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      showToast(`Deleted ${data.deleted || 0} reminder email${(data.deleted || 0) === 1 ? '' : 's'}`);
      if ((data.deleted || 0) > 0) {
        const visibleUids = Array.from(document.querySelectorAll('#email-lib-grid .doclib-card[data-uid]'))
          .map(card => card.dataset.uid)
          .filter(Boolean);
        await _animateEmailCardRemoval(visibleUids);
      }
      state._libFilter = 'all';
      const filterEl = document.getElementById('email-lib-filter');
      if (filterEl) filterEl.value = 'all';
      document.getElementById('email-reminder-btn')?.classList.remove('active');
      _syncReminderClearButton();
      _loadEmailsFresh();
    } catch (err) {
      console.error(err);
      showToast('Failed to clear reminder emails');
    }
  });
  document.getElementById('email-undone-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('email-undone-btn');
    const filterEl = document.getElementById('email-lib-filter');
    if (state._libFilter === 'undone') {
      state._libFilter = 'all';
      filterEl.value = 'all';
      btn.classList.remove('active');
    } else {
      state._libFilter = 'undone';
      filterEl.value = 'undone';
      btn.classList.add('active');
      document.getElementById('email-reminder-btn')?.classList.remove('active');
    }
    _syncUnreadWindowGlow();
    _syncReminderClearButton();
    _loadEmailsFresh();
  });
  document.getElementById('email-reminder-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('email-reminder-btn');
    const filterEl = document.getElementById('email-lib-filter');
    if (state._libFilter === 'reminders') {
      state._libFilter = 'all';
      filterEl.value = 'all';
      btn.classList.remove('active');
    } else {
      state._libFilter = 'reminders';
      filterEl.value = 'reminders';
      btn.classList.add('active');
      document.getElementById('email-undone-btn')?.classList.remove('active');
    }
    _syncUnreadWindowGlow();
    _syncReminderClearButton();
    _loadEmailsFresh();
  });
  // 旧的"排序"下拉菜单（最新/未读优先/收藏优先）已合并到上面的过滤器
  // 下拉菜单中 — "收藏夹"现在是一个过滤器（服务端 \Flagged 搜索）。
  // _libSort 保持其 'recent' 默认值，以便网格保持 API 的最新优先顺序。

  let searchTimer = null;
  document.getElementById('email-lib-search').addEventListener('input', (e) => {
    state._libSearch = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(_doSearch, 350);
  });

  document.getElementById('email-lib-refresh-btn').addEventListener('click', async () => {
    const btn = document.getElementById('email-lib-refresh-btn');
    btn?.classList.add('email-lib-refreshing');
    state._libOffset = 0;
    // 不要擦除 state._libEmails — _loadEmails 将在强制重新 fetch 时
    // 绘制缓存列表，这样网格在刷新中不会变为空白。
    // `force: true` 添加缓存破坏器，以绕过服务端的 8 秒列表缓存，获取实际新鲜结果。
    try {
      await _loadEmails({ force: true });
    } finally {
      btn?.classList.remove('email-lib-refreshing');
      // 闪烁显示对勾约 900ms，以便用户获得清晰的"完成"提示。
      if (btn) {
        const orig = btn.innerHTML;
        btn.classList.add('email-lib-refresh-done');
        btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;"><polyline points="20 6 9 17 4 12"/></svg>';
        setTimeout(() => {
          if (btn.classList.contains('email-lib-refresh-done')) {
            btn.classList.remove('email-lib-refresh-done');
            btn.innerHTML = orig;
          }
        }, 900);
      }
    }
  });


  const _composeNew = () => {
    // 桌面端：当有足够空间容纳邮件和撰写/文档窗格时，保持 Email 打开。
    // 移动端仍然收起标签页，以便文档拥有整个屏幕。
    if (_prepareEmailWindowForDocument(document.getElementById('email-lib-modal'))) {
      if (!Modals.minimize('email-lib-modal')) closeEmailLibrary();
    }
    if (state._onEmailClick) state._onEmailClick({ compose: true });
    if (document.body.classList.contains('email-doc-split-active')) {
      _scheduleEmailDocumentSplitMeasure(document.getElementById('email-lib-modal'));
    }
  };
  document.getElementById('email-lib-compose-btn').addEventListener('click', _composeNew);

  // 移动端 FAB：与（桌面端）新建按钮相同的操作，另外在列表滚动时收缩为图标，
  // 并在滚动停止时弹回扩展为 "New"。
  const _fab = document.getElementById('email-lib-fab');
  if (_fab) {
    _fab.addEventListener('click', _composeNew);
    const _grid = document.getElementById('email-lib-grid');
    if (_grid) {
      let _fabIdle = null;
      _grid.addEventListener('scroll', () => {
        _fab.classList.add('collapsed');
        clearTimeout(_fabIdle);
        _fabIdle = setTimeout(() => _fab.classList.remove('collapsed'), 280);
        _positionFab();   // Firefox 的工具栏在滚动时显示/隐藏
      }, { passive: true });
    }

    // 将 FAB 保持在浏览器底部工具栏之上。env(safe-area-inset)
    // 不覆盖 Android 版 Firefox 的 URL 栏，且其 100dvh 处理不可靠，
    // 因此测量面板延伸到 *可见*（visualViewport）区域之下的程度，
    // 并将按钮上移相应的量。
    function _positionFab() {
      if (!_fab.isConnected) {       // 模态框被重建/关闭 — 停止监听
        window.visualViewport?.removeEventListener('resize', _positionFab);
        window.visualViewport?.removeEventListener('scroll', _positionFab);
        window.removeEventListener('resize', _positionFab);
        return;
      }
      const card = _fab.parentElement;            // .admin-card (positioned)
      const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      const overflowBelow = card ? Math.max(0, Math.round(card.getBoundingClientRect().bottom - vh)) : 0;
      _fab.style.bottom = `calc(18px + env(safe-area-inset-bottom, 0px) + ${overflowBelow}px)`;
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', _positionFab);
      window.visualViewport.addEventListener('scroll', _positionFab);
    }
    window.addEventListener('resize', _positionFab);
    // 在布局稳定后运行（模态框打开带有动画）。
    requestAnimationFrame(() => requestAnimationFrame(_positionFab));
    setTimeout(_positionFab, 300);

    // 仅在邮件列表已渲染后（窗口"完全加载"），以从中心缩放弹出的
    // 方式显示 FAB — 先在不可见时定位它，这样它不会在顶部闪烁然后滑下来。
    let _revealed = false;
    const _revealFab = () => {
      if (_revealed || !_fab.isConnected) return;
      _revealed = true;
      _positionFab();
      // FAB 是 .modal-content 的绝对子元素，它在打开时向上滑入（sheet-enter）。
      // 等待该入场动画完成后再弹出 FAB，否则它会随着滑动运动
      //（"跟随窗口滑下"）。
      const content = _fab.closest('.modal-content');
      const pop = () => { _positionFab(); requestAnimationFrame(() => _fab.classList.add('fab-revealed')); };
      if (!content || content.classList.contains('sheet-ready')) {
        pop();
      } else {
        let done = false;
        const onEnd = () => {
          if (done) return; done = true;
          content.removeEventListener('animationend', onEnd);
          pop();
        };
        content.addEventListener('animationend', onEnd);
        setTimeout(onEnd, 450);  // 如果 animationend 未触发则作为回退
      }
    };
    if (_grid) {
      if (_grid.children.length) {
        _revealFab();
      } else {
        const _gobs = new MutationObserver(() => {
          if (_grid.children.length) { _gobs.disconnect(); _revealFab(); }
        });
        _gobs.observe(_grid, { childList: true });
        // 安全网 — 如果列表仍然为空，永远不要让 FAB 隐藏。
        setTimeout(() => { _gobs.disconnect(); _revealFab(); }, 1600);
      }
    } else {
      setTimeout(_revealFab, 400);
    }
  }

  // 选择模式切换
  document.getElementById('email-lib-select-btn').addEventListener('click', () => {
    state._selectMode = !state._selectMode;
    state._selectedUids.clear();
    _updateBulkBar();
    _renderGrid();
  });
  document.getElementById('email-lib-select-all').addEventListener('change', (e) => {
    if (e.target.checked) {
      state._libEmails.forEach(em => state._selectedUids.add(em.uid));
    } else {
      state._selectedUids.clear();
    }
    _updateBulkBar();
    _renderGrid();
  });

  // 批量取消 — 以与通过切换的新取消相同的拆除方式接线。
  // 让全局 Esc 处理程序（keyboard-shortcuts.js）通过点击可见的
  // [id$="-bulk-cancel"] 按钮来关闭选择模式。
  document.getElementById('email-lib-bulk-cancel')?.addEventListener('click', () => {
    state._selectMode = false;
    state._selectedUids.clear();
    _updateBulkBar();
    _renderGrid();
  });

  // 批量操作
  document.getElementById('email-lib-bulk-actions').addEventListener('click', (e) => {
    e.stopPropagation();
    if (state._selectedUids.size === 0) {
      showToast('Select emails first');
      return;
    }
    _showBulkActionsMenu(e.currentTarget);
  });
  document.getElementById('email-lib-bulk-delete')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state._selectedUids.size === 0) {
      showToast('Select emails first');
      return;
    }
    _bulkAction('delete');
  });

  const selectExpandedEmailText = () => {
    const expanded = document.querySelector('#email-lib-modal .doclib-card.doclib-card-expanded');
    const reader = expanded?.querySelector('.email-card-reader') || expanded;
    return _selectEmailReaderContents(reader);
  };

  // ESC 关闭 + 箭头导航 + 删除所选/当前展开的邮件。
  state._libEscHandler = (e) => {
    const modal = document.getElementById('email-lib-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'a') {
      const t = e.target;
      if (_isEmailTypingTarget(t)) return;
      if (selectExpandedEmailText()) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      if (state._selectMode) {
        state._selectMode = false;
        state._selectedUids.clear();
        _updateBulkBar();
        _renderGrid();
        return;
      }
      closeEmailLibrary();
      return;
    }
    // 当用户正在某处输入时，不要劫持箭头/删除键。
    const t = e.target;
    if (_isEmailTypingTarget(t)) return;
    const isDeleteKey = e.key === 'Delete' || e.key === 'Backspace';
    if (isDeleteKey && state._selectMode && state._selectedUids.size > 0) {
      e.preventDefault();
      _bulkAction('delete');
      return;
    }
    const expanded = document.querySelector('#email-lib-modal .doclib-card.doclib-card-expanded');
    if (!expanded) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowLeft' ? '-1' : '1';
      const btn = expanded.querySelector(`.email-card-nav-btn[data-nav-dir="${dir}"]`);
      if (btn) { e.preventDefault(); btn.click(); }
    } else if (isDeleteKey) {
      const em = state._libEmails.find(x => String(x.uid) === String(expanded.dataset.uid));
      if (em) {
        e.preventDefault();
        _deleteEmailAndAdvance(em, expanded);
      }
    }
  };
  document.addEventListener('keydown', state._libEscHandler, true);

  _renderAccountsLoading();
  _loadAccounts();
  _loadFolders();
  _loadEmailReminderBellVisibility();
  _loadEmails();
}

async function _loadAccounts() {
  try {
    const r = await fetch(`${API_BASE}/api/email/accounts`);
    if (!r.ok) return;
    const d = await r.json();
    state._libAccounts = d.accounts || [];
  } catch (_) { state._libAccounts = []; }
  _renderAccountsStrip();
}

function _renderAccountsStrip() {
  const strip = document.getElementById('email-lib-accounts');
  if (!strip) return;
  strip.style.display = 'flex';
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const allActive = !state._libAccountId ? ' active' : '';
  let html = `<button class="memory-toolbar-btn gallery-chip${allActive}" data-acc-id="">All (default)</button>`;
  for (const a of state._libAccounts) {
    const active = state._libAccountId === a.id ? ' active' : '';
    const label = a.name || a.from_address || a.imap_user || 'account';
    html += `<button class="memory-toolbar-btn gallery-chip${active}" data-acc-id="${esc(a.id)}" title="${esc(a.from_address || a.imap_user || '')}${a.is_default ? ' (default)' : ''}">${esc(label)}</button>`;
  }
  strip.innerHTML = html;
  strip.querySelectorAll('button[data-acc-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      state._libAccountId = btn.dataset.accId || null;
      _publishActiveAccount();
      _resetEmailListForFreshLoad();
      _renderAccountsStrip();
      await _loadFolders({ resetMissing: true });
      _loadEmails({ force: true, useCache: false });
    });
  });
  _publishActiveAccount();
}

export function closeEmailLibrary() {
  const modal = document.getElementById('email-lib-modal');
  if (modal) modal.remove();
  _clearEmailDocumentSplit();
  if (state._libEscHandler) {
    document.removeEventListener('keydown', state._libEscHandler, true);
    state._libEscHandler = null;
  }
  state._libOpen = false;
  // 如果 /email 路由折叠了宽侧边栏以为全屏模态框腾出空间，
  // 现在模态框消失后重新展开它。
  try { window._restoreSidebarIfRouteCollapsed?.(); } catch (_) {}
}

// 通过其头部使模态框可拖拽。如果提供了 `modal` 和 `fsClass`，
// 拖拽到视口顶部边缘会吸附到全屏（Aero Snap）。
// 在全屏时从顶部拖离则取消吸附。
function _makeDraggable(content, modal, fsClass) {
  if (!content) return;
  const header = content.querySelector('.modal-header');
  if (!header) return;
  // 每个模态框的全屏行为 — 调用方提供 fsClass，我们应用
  // email-lib 和 email-window 都使用的相同内联样式全屏模式。
  // exitFullscreen 恢复默认窗口大小 (min(720px, 92vw) × 85vh)
  // 并围绕光标居中。
  const enterFullscreen = () => {
    if (!fsClass || modal.classList.contains(fsClass)) return;
    modal.classList.add(fsClass);
    content.style.position = 'fixed';
    content.style.left = '0';
    content.style.top = '0';
    content.style.right = '0';
    content.style.bottom = '0';
    content.style.width = '100vw';
    content.style.maxWidth = '100vw';
    content.style.height = '100vh';
    content.style.maxHeight = '100vh';
    content.style.borderRadius = '0';
    content.style.transform = 'none';
  };
  const exitFullscreen = (cx, cy) => {
    if (!fsClass || !modal.classList.contains(fsClass)) return;
    modal.classList.remove(fsClass);
    content.style.width = 'min(720px, 92vw)';
    content.style.maxWidth = '';
    content.style.height = '';
    content.style.maxHeight = '85vh';
    content.style.borderRadius = '';
    content.style.right = '';
    content.style.bottom = '';
    const w = Math.min(720, window.innerWidth * 0.92);
    content.style.left = Math.max(8, cx - w / 2) + 'px';
    content.style.top = Math.max(8, cy - 20) + 'px';
  };
  makeWindowDraggable(modal, {
    content,
    header,
    fsClass,
    skipSelector: '.close-btn, .modal-close',
    enableLeftDock: true,  // 在右侧回复时将邮件停靠在左侧
    onDragStart: ({ rect }) => {
      if (!modal.classList.contains('email-snap-left')) return;
      modal.classList.remove('email-snap-left');
      _clearEmailDocumentSplit();
      content.style.position = 'fixed';
      content.style.left = `${Math.round(rect.left)}px`;
      content.style.top = `${Math.round(rect.top)}px`;
      content.style.right = '';
      content.style.bottom = '';
      content.style.width = `${Math.max(420, Math.round(rect.width || 560))}px`;
      content.style.maxWidth = '';
      content.style.height = `${Math.max(320, Math.round(rect.height || 620))}px`;
      content.style.maxHeight = '85vh';
      content.style.borderRadius = '';
      content.style.transform = 'none';
      content.style.margin = '0';
    },
    onEnterFullscreen: fsClass ? enterFullscreen : null,
    onExitFullscreen: fsClass ? exitFullscreen : null,
  });
}

// 当用户在全屏邮件视图上点击 Reply 时，将邮件模态框停靠到左侧
// 作为狭窄侧边栏，以便文档面板（在聊天区域右侧打开）可以并排可见。
// 仅当视口足够宽以真正值得分屏时触发。返回 true 表示吸附已应用，false 表示未应用。
function _snapEmailModalToLeftSidebar(modal) {
  if (!modal) return false;
  if (window.innerWidth < 900) return false;
  const content = modal.querySelector('.modal-content');
  if (!content) return false;
  // 仅在全屏时才停靠 — 对于手动调整大小的窗口，
  // 用户已经选择了其布局；不要通过吸附来意外改变它。
  const wasLibFs = modal.classList.contains('email-lib-fullscreen');
  const wasWinFs = modal.classList.contains('email-window-fullscreen');
  if (!wasLibFs && !wasWinFs) return false;
  modal.classList.remove('email-lib-fullscreen');
  modal.classList.remove('email-window-fullscreen');
  modal.classList.add('email-snap-left');
  const W = Math.min(440, Math.max(360, Math.round(window.innerWidth * 0.30)));
  const left = _emailSplitLeftEdge();
  content.style.position = 'fixed';
  content.style.left = '0';
  content.style.top = '0';
  content.style.right = '';
  content.style.bottom = '0';
  content.style.width = W + 'px';
  content.style.maxWidth = W + 'px';
  content.style.height = '100vh';
  content.style.maxHeight = '100vh';
  content.style.borderRadius = '0';
  content.style.transform = 'none';
  content.style.margin = '0';
  _setEmailDocumentSplit(left, W);
  _scheduleEmailDocumentSplitMeasure(modal);
  return true;
}

async function _loadFolders({ resetMissing = false } = {}) {
  const seq = ++_libFolderSeq;
  const accountAtStart = state._libAccountId || '';
  try {
    const res = await fetch(`${API_BASE}/api/email/folders?_=${Date.now()}${_acct()}`);
    const data = await res.json();
    if (seq !== _libFolderSeq || accountAtStart !== (state._libAccountId || '')) return;
    const sel = document.getElementById('email-lib-folder');
    if (!sel || !data.folders) return;
    state._libFolders = data.folders;
    if (resetMissing && state._libFolder !== '__scheduled__' && !data.folders.includes(state._libFolder)) {
      state._libFolder = data.folders.includes('INBOX') ? 'INBOX' : (data.folders[0] || 'INBOX');
      state._libFilter = 'all';
      state._libSearch = '';
      state._libHasAttachments = false;
      _libListCache.clear();
      const searchEl = document.getElementById('email-lib-search');
      const filterEl = document.getElementById('email-lib-filter');
      const attachEl = document.getElementById('email-attachments-btn');
      if (searchEl) searchEl.value = '';
      if (filterEl) filterEl.value = 'all';
      if (attachEl) attachEl.classList.remove('active');
      _syncUnreadWindowGlow();
      _syncReminderClearButton();
    }
    sel.innerHTML = '';
    const { priority, others } = sortedFolders(data.folders);
    for (const f of priority) {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = folderDisplayName(f);
      if (f === state._libFolder) opt.selected = true;
      sel.appendChild(opt);
    }
    if (priority.length > 0 && others.length > 0) {
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = '─────────';
      sel.appendChild(sep);
    }
    for (const f of others) {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = folderDisplayName(f);
      if (f === state._libFolder) opt.selected = true;
      sel.appendChild(opt);
    }
    // Scheduled（特殊虚拟文件夹）
    const sep2 = document.createElement('option');
    sep2.disabled = true;
    sep2.textContent = '─────────';
    sel.appendChild(sep2);
    const schedOpt = document.createElement('option');
    schedOpt.value = '__scheduled__';
    schedOpt.textContent = t('email.scheduled');
    if (state._libFolder === '__scheduled__') schedOpt.selected = true;
    sel.appendChild(schedOpt);
    sel.value = state._libFolder;
  } catch (e) {}
}

function _crossFolderCandidates() {
  const available = Array.isArray(state._libFolders) ? state._libFolders.filter(Boolean) : [];
  const lower = new Map(available.map(f => [String(f).toLowerCase(), f]));
  const pick = (patterns, fallback) => {
    for (const p of patterns) {
      const direct = lower.get(String(p).toLowerCase());
      if (direct) return direct;
    }
    const match = available.find(f => patterns.some(p => String(f).toLowerCase().includes(String(p).toLowerCase())));
    return match || fallback;
  };
  const candidates = [
    pick(['INBOX'], 'INBOX'),
    pick(['[Gmail]/Sent Mail', 'Sent Mail', 'Sent Items', 'INBOX.Sent', 'Sent'], '[Gmail]/Sent Mail'),
    pick(['Archive', '[Gmail]/All Mail', 'All Mail'], '[Gmail]/All Mail'),
  ];
  return Array.from(new Set(candidates.filter(Boolean)));
}

async function _doSearch() {
  const seq = ++_libSearchSeq;
  const q = state._libSearch.trim();
  if (q.length < 2) {
    // 空或太短 — 如果之前的搜索替换了网格内容，则恢复普通文件夹。
    if (_libSearchHadResults) {
      _libSearchHadResults = false;
      state._libOffset = 0;
      await _loadEmails({ useCache: true });
      return;
    }
    _renderGrid();
    return;
  }
  const grid = document.getElementById('email-lib-grid');
  if (!grid) return;
  const sp = _renderEmailLoading(grid);
  const accountAtStart = state._libAccountId || '';
  const folderAtStart = state._libFolder || 'INBOX';

  try {
    const accountQS = accountAtStart ? `&account_id=${encodeURIComponent(accountAtStart)}` : '';
    const res = await fetch(`${API_BASE}/api/email/search?folder=${encodeURIComponent(folderAtStart)}${accountQS}&q=${encodeURIComponent(q)}&limit=100`);
    const data = await res.json();
    sp.destroy();
    if (
      seq !== _libSearchSeq ||
      q !== state._libSearch.trim() ||
      accountAtStart !== (state._libAccountId || '') ||
      folderAtStart !== (state._libFolder || 'INBOX')
    ) {
      return;
    }
    if (data.error) throw new Error(data.error);

    const results = data.emails || [];
    _libSearchHadResults = true;
    state._libEmails = results;  // 临时替换为搜索结果
    _renderGrid();

    const stats = document.getElementById('email-lib-stats');
    if (stats) stats.textContent = `${data.total || results.length} match${(data.total || results.length) === 1 ? '' : 'es'}`;
  } catch (e) {
    sp.destroy();
    grid.innerHTML = '<div class="email-loading">Search failed</div>';
  }
}

function _renderEmailLoading(grid) {
  if (!grid) return null;
  grid.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'email-loading email-loading-with-label';
  let sp = null;
  try {
    sp = spinnerModule.createWhirlpool(28);
    wrap.appendChild(sp.element);
  } catch (_) {}
  const label = document.createElement('div');
  label.className = 'email-loading-label';
  label.textContent = t('email.loading_emails');
  wrap.appendChild(label);
  grid.appendChild(wrap);
  return sp;
}

// 使用当前文件夹的未读计数刷新模态框标题中的小强调药丸。
// 当收件箱当前过滤到未读时，药丸翻转为显示总邮件数 + "all" 标签，
// 因为点击它会关闭过滤器 — 因此标签需要展示将要执行的操作，
// 而非当前视图。两个小侧载 fetch（limit=1，仅总数）；失败时静默 —
// 如果请求出错，徽章仅保持隐藏。
async function _refreshUnreadBadge() {
  const badge = document.getElementById('email-lib-unread-badge');
  if (!badge) return;
  try {
    const folder = state._libFolder || 'INBOX';
    if (folder === '__scheduled__') { badge.style.display = 'none'; return; }
    const res = await fetch(`${API_BASE}/api/email/list?folder=${encodeURIComponent(folder)}${_acct()}&limit=1&filter=unread`);
    const data = await res.json();
    const n = data.total || 0;
    _syncUnreadTabBadge(n);
    if (state._libFilter === 'unread') {
      // 当前正在查看未读邮件 — 显示点击后将带来的视图。
      try {
        const allRes = await fetch(`${API_BASE}/api/email/list?folder=${encodeURIComponent(folder)}${_acct()}&limit=1&filter=all`);
        const allData = await allRes.json();
        const t = allData.total || 0;
        badge.textContent = `${t} all`;
        badge.title = t('email.show_all_emails');
        badge.style.display = '';
      } catch (_) {
        badge.textContent = t('email.show_all');
        badge.title = t('email.show_all_emails');
        badge.style.display = '';
      }
    } else if (n > 0) {
      badge.textContent = n > 999 ? '999+ unread' : `${n} unread`;
      badge.title = t('email.show_unread');
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  } catch (_) { _syncUnreadTabBadge(0); }
}

async function _loadEmails({ force = false, useCache = true } = {}) {
  const seq = ++_libLoadSeq;
  state._libLoading = true;
  const accountAtStart = state._libAccountId || '';
  const folderAtStart = state._libFolder;
  const filterAtStart = state._libFilter;
  const offsetAtStart = state._libOffset;
  const searchAtStart = state._libSearch;
  const hasAttachmentsAtStart = state._libHasAttachments;

  const grid = document.getElementById('email-lib-grid');
  if (!grid) { if (seq === _libLoadSeq) state._libLoading = false; return; }

  // SWR：当加载真实文件夹的第一页且无搜索时，立即绘制缓存列表
  //（无旋转器，无空白网格），然后在背后悄悄重新 fetch。
  // 分页、搜索和计划虚拟文件夹跳过缓存并使用旧的旋转器路径。
  // `force`（刷新按钮）仍可查询缓存以保持感知连续性，但添加
  // 缓存破坏器以同时绕过服务端的 8 秒列表缓存。
  // 账户/文件夹/过滤器更改传递 `useCache: false`，
  // 以便前一视图的陈旧行永远不会闪现。
  const cacheable =
    offsetAtStart === 0 &&
    !searchAtStart &&
    folderAtStart !== '__scheduled__';
  const ck = cacheable ? _libCacheKey() : null;
  const cached = (useCache && cacheable) ? _libCacheGet(ck) : null;

  let sp = null;
  if (cached) {
    state._libEmails = cached.emails || [];
    state._libTotal = cached.total || 0;
    // 从缓存绘制时抑制打开级联动画 — 数据刚刚还在屏幕上，
    // 因此每张卡片重新滑入感觉卡顿。同时防止级联动画在后台
    // refetch 在 900ms 清理窗口内到达并将新卡片节点追加到仍带有类名的
    // 网格中时重新触发。
    state._libJustOpened = false;
    const grid2 = document.getElementById('email-lib-grid');
    if (grid2) grid2.classList.remove('email-lib-just-opened');
    _renderGrid();
    const stats = document.getElementById('email-lib-stats');
    if (stats) stats.textContent = `${state._libTotal} emails`;
  } else {
    sp = _renderEmailLoading(grid);
  }

  try {
    _syncUnreadWindowGlow();
    if (folderAtStart === '__scheduled__') {
      await _loadScheduled(grid, sp);
    } else {
      const accountQS = accountAtStart ? `&account_id=${encodeURIComponent(accountAtStart)}` : '';
      const attQS = hasAttachmentsAtStart ? '&has_attachments=1' : '';
      // `&_=Date.now()` 绕过服务端的 8 秒列表缓存。默认打开
      // 省略它以允许快速关闭/重新打开立即返回；刷新按钮传递
      // `force: true` 来添加它。
      const buster = force ? `&_=${Date.now()}` : '';
      const res = await fetch(`${API_BASE}/api/email/list?folder=${encodeURIComponent(folderAtStart)}${accountQS}&limit=100&offset=${offsetAtStart}&filter=${filterAtStart}${attQS}${buster}`);
      const data = await res.json();
      if (seq !== _libLoadSeq || accountAtStart !== (state._libAccountId || '')) return;
      if (data.error) throw new Error(data.error);
      state._libEmails = data.emails || [];
      state._libTotal = data.total || 0;
      if (sp) sp.destroy();
      _renderGrid();
      const stats = document.getElementById('email-lib-stats');
      if (stats) stats.textContent = `${state._libTotal} emails`;
      _refreshUnreadBadge();
      if (cacheable) _libCachePut(ck, { emails: state._libEmails.slice(), total: state._libTotal });
    }
  } catch (e) {
    if (seq !== _libLoadSeq || accountAtStart !== (state._libAccountId || '')) return;
    if (sp) sp.destroy();
    // 如果我们已绘制了缓存列表，保留在屏幕上 — 比擦除它显示
    // "加载失败"更好，因为仍有可读内容。
    if (!cached) {
      const msg = e && e.message ? `Failed to load: ${e.message}` : 'Failed to load';
      grid.innerHTML = `<div class="email-loading">${_esc(msg)}${_emailSetupHintHtml()}</div>`;
      _wireEmailSetupHint(grid);
    }
  } finally {
    if (seq === _libLoadSeq) state._libLoading = false;
  }
}

async function _loadScheduled(grid, sp) {
  const res = await fetch(`${API_BASE}/api/email/scheduled`);
  const data = await res.json();
  if (sp) sp.destroy();
  const items = data.scheduled || [];
  grid.innerHTML = '';
  const stats = document.getElementById('email-lib-stats');
  if (stats) stats.textContent = `${items.length} scheduled`;

  if (items.length === 0) {
    grid.innerHTML = '<div class="email-loading">No scheduled emails</div>';
    return;
  }

  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'doclib-card memory-item';

    const sendDate = new Date(it.send_at);
    const dateStr = sendDate.toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;';
    const subject = it.subject || '(no subject)';
    const toDisplay = it.to || '(no recipient)';

    content.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="memory-item-title">${_esc(subject)}</span>
        ${it.status === 'failed' ? '<span style="font-size:9px;color:var(--red);border:1px solid var(--red);padding:1px 4px;border-radius:4px;">FAILED</span>' : '<span style="font-size:9px;opacity:0.6;border:1px solid var(--border);padding:1px 4px;border-radius:4px;">PENDING</span>'}
      </div>
      <div style="font-size:10px;opacity:0.7;margin-top:2px;">
        To: ${_esc(toDisplay)} · Sends ${_esc(dateStr)}
      </div>
      ${it.error ? `<div style="font-size:10px;color:var(--red);margin-top:2px;">${_esc(it.error)}</div>` : ''}
    `;
    card.appendChild(content);

    // 取消按钮
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'memory-item-btn';
    cancelBtn.title = t('email.cancel_scheduled');
    cancelBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    cancelBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { styledConfirm } = await import('./ui.js');
      const ok = await styledConfirm(`Cancel scheduled email "${subject}"?`, { confirmText: 'Cancel Send', cancelText: 'Keep', danger: true });
      if (!ok) return;
      try {
        await fetch(`${API_BASE}/api/email/scheduled/${it.id}`, { method: 'DELETE' });
        _loadEmails();
      } catch (err) { console.error(err); }
    });
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'memory-item-actions';
    actionsWrap.appendChild(cancelBtn);
    card.appendChild(actionsWrap);

    grid.appendChild(card);
  }
}

function _renderGrid() {
  const grid = document.getElementById('email-lib-grid');
  if (!grid) return;
  grid.innerHTML = '';

  let filtered = state._libEmails;

  // 应用排序
  if (state._libSort === 'unread') {
    filtered = [...filtered].sort((a, b) => Number(a.is_read) - Number(b.is_read));
  } else if (state._libSort === 'favorites') {
    filtered = [...filtered].sort((a, b) => Number(b.is_flagged) - Number(a.is_flagged));
  }
  // 'recent' is the default order from the API

  if (filtered.length === 0) {
    // 收件箱清零是一种成功 — 将消息与笑脸配对，
    // 使空状态读作"全部处理完毕"，而不是"某些东西坏了"。
    const _smileyIco = '<span style="vertical-align:-3px;margin-left:6px;">' + emptyStateIcon('smiley') + '</span>';
    // 仅当收件箱真正为空时才显示"在设置 › 集成中配置"提示 —
    // 没有过滤器、没有搜索、没有源邮件。恰好为空的子过滤器
    //（提醒、未读等）不是配置问题；那里的链接读起来毫无意义。
    const _isTrulyEmpty = (
      state._libEmails.length === 0
      && (!state._libFilter || state._libFilter === 'all')
      && !(state._libSearch || '').trim()
    );
    if (_isTrulyEmpty) {
      grid.innerHTML =
        '<div class="email-loading" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;text-align:center;">' +
          '<span>No emails' + _smileyIco + '</span>' +
          '<span style="opacity:0.7;font-size:11px;">' +
            'Set up at: <a href="#" data-open-settings="integrations" style="color:var(--accent,var(--red));text-decoration:underline;">Settings &rsaquo; Integrations</a>' +
          '</span>' +
        '</div>';
      const _link = grid.querySelector('[data-open-settings]');
      if (_link) _link.addEventListener('click', (e) => {
        e.preventDefault();
        _openSettingsTab(_link.dataset.openSettings || 'integrations');
      });
    } else {
      grid.innerHTML =
        '<div class="email-loading" style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;">' +
          '<span>No emails' + _smileyIco + '</span>' +
        '</div>';
    }
    return;
  }

  // 打开时级联：触发侧边栏章节使用的相同 domino-in 动画。
  // 仅在库打开后的第一次网格渲染时触发 — 后续的重新渲染
  //（过滤器/排序/搜索）需要即时完成。
  if (state._libJustOpened) {
    grid.classList.add('email-lib-just-opened');
    state._libJustOpened = false;
    // 级联后剥离类名，以免限制后续动画
    //（如归档时的 FLIP 重排）。最坏情况持续时间与下面关键帧
    // 集合中最长延迟匹配。
    setTimeout(() => grid.classList.remove('email-lib-just-opened'), 900);
  }
  for (const em of filtered) {
    grid.appendChild(_createCard(em));
  }

  // 如果深度链接要求展开特定邮件，现在执行并清除。
  if (state._libPendingExpandUid) {
    const target = filtered.find(e => String(e.uid) === String(state._libPendingExpandUid));
    const wantUid = state._libPendingExpandUid;
    state._libPendingExpandUid = null;
    if (target) {
      const cards = grid.querySelectorAll('.doclib-card');
      const targetCard = Array.from(cards).find(c => c.dataset.uid === String(wantUid));
      if (targetCard) {
        requestAnimationFrame(() => _toggleCardPreview(targetCard, target));
      }
    }
  }
}

function _createCard(em) {
  const card = document.createElement('div');
  let cls = 'doclib-card memory-item';
  if (em.is_answered) cls += ' email-card-answered';
  else if (!em.is_read) cls += ' email-card-unread';
  card.className = cls;
  card.dataset.uid = String(em.uid);
  if (state._selectMode && state._selectedUids.has(em.uid)) card.classList.add('selected');

  // 选择模式下的复选框
  if (state._selectMode) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'memory-select-cb';
    cb.checked = state._selectedUids.has(em.uid);
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) state._selectedUids.add(em.uid);
      else state._selectedUids.delete(em.uid);
      card.classList.toggle('selected', cb.checked);
      _updateBulkBar();
    });
    card.appendChild(cb);
  }

  // 在"已发送"文件夹中，显示收件人 — 发件人始终是你，
  // 这会隐藏实际有用的信息。在"已发送"之外，像以前一样显示发件人。
  const isSentFolderEarly = /sent/i.test(state._libFolder);
  let senderName;
  if (isSentFolderEarly) {
    senderName = _formatRecipients(em.to) || em.to || '(no recipient)';
  } else {
    senderName = em.from_name || em.from_address;
  }
  const color = _senderColor(senderName);

  let dateStr = '';
  if (em.date) {
    try {
      const d = new Date(em.date);
      const now = new Date();
      const sameYear = d.getFullYear() === now.getFullYear();
      const dateOpts = sameYear
        ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
        : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
      dateStr = d.toLocaleString([], dateOpts);
    } catch (_) {}
  }

  const content = document.createElement('div');
  content.style.cssText = 'flex:1;min-width:0;';

  const titleRow = document.createElement('div');
  titleRow.className = 'email-card-titlerow';
  titleRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

  const titleEl = document.createElement('span');
  titleEl.className = 'memory-item-title';
  titleEl.textContent = em.subject || '(no subject)';
  // 悬停预览：通过原生浏览器工具提示直接在标题上显示缓存的 AI 摘要 —
  // 无需打开邮件即可浏览。
  if (em.cached_summary) {
    titleEl.title = em.cached_summary;
    titleEl.classList.add('email-card-has-summary');
  }
  titleRow.appendChild(titleEl);

  if (em.has_attachments) {
    const att = document.createElement('span');
    att.title = t('email.has_attachments');
    att.style.cssText = 'opacity:0.6;flex-shrink:0;display:inline-flex;';
    att.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
    titleRow.appendChild(att);
  }

  // 完成对勾 + 未读圆点保持在左侧的主题旁。
  const isSentFolder = /sent/i.test(state._libFolder);
  if (!isSentFolder) {
    const doneCheck = document.createElement('span');
    doneCheck.className = 'email-card-done' + (em.is_answered ? ' active' : '');
    doneCheck.title = em.is_answered ? 'Mark not done' : 'Mark done';
    doneCheck.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    const _toggleDone = async (e) => {
      if (e) e.stopPropagation();
        // 使用可见类作为真实来源 — em.is_answered 可能由于后台同步而过期，
        // 这会导致用户点击却看不到 UI 变化。
      const wasActive = doneCheck.classList.contains('active');
      const newState = !wasActive;
      em.is_answered = newState;
      doneCheck.classList.toggle('active', newState);
      doneCheck.title = newState ? 'Mark not done' : 'Mark done';
      // 在两个方向都进行动画，以便用户在取消对勾时也能获得明确反馈 —
      // 否则悬停状态和激活状态看起来相同，点击感觉像是无效操作。
      doneCheck.classList.remove('just-checked', 'just-unchecked');
      void doneCheck.offsetWidth; // 重新启动动画
      doneCheck.classList.add(newState ? 'just-checked' : 'just-unchecked');
      setTimeout(() => doneCheck.classList.remove('just-checked', 'just-unchecked'), 500);
      if (newState) {
        _syncEmailReadState(em.uid, true);
      }
      try {
        if (newState) {
          await fetch(`${API_BASE}/api/email/mark-answered/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
          await fetch(`${API_BASE}/api/email/mark-read/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
        } else {
          await fetch(`${API_BASE}/api/email/clear-answered/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
        }
      } catch (err) { console.error(err); }
    };
    doneCheck.addEventListener('click', _toggleDone);
    titleRow.appendChild(doneCheck);
    if (!em.is_read) {
      const dot = document.createElement('span');
      dot.className = 'email-card-unread-dot';
      dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0;margin-left:2px;`;
      titleRow.appendChild(dot);
    }
  }

  if (em.is_flagged) {
    const star = document.createElement('span');
    star.title = t('email.favorited_email');
    star.style.cssText = 'color:var(--accent, var(--red));opacity:0.85;flex-shrink:0;display:inline-flex;';
    star.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    titleRow.appendChild(star);
  }

  // 上一页/下一页箭头 — 仅在此卡片为展开状态时可见
  //（通过 CSS 控制，折叠的卡片保持干净）。点击通过折叠
  // 当前卡片并展开相邻卡片来导航。
  const navArrows = document.createElement('span');
  navArrows.className = 'email-card-nav-arrows';
  navArrows.innerHTML = `
    <button type="button" class="email-card-nav-btn" data-nav-dir="-1" title="Previous email"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
    <button type="button" class="email-card-nav-btn" data-nav-dir="1" title="Next email"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
  `;
  navArrows.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.email-card-nav-btn');
    if (!btn || btn.disabled) return;
    ev.stopPropagation();
    const card = navArrows.closest('.doclib-card');
    if (!card) return;
    const dir = parseInt(btn.dataset.navDir, 10);
    const sibling = _findSiblingEmailCard(card, dir);
    if (!sibling) return;
    const nextEm = state._libEmails.find(e => String(e.uid) === String(sibling.dataset.uid));
    if (!nextEm) return;
    await _toggleCardPreview(card, em);
    await _toggleCardPreview(sibling, nextEm);
    sibling.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  // 右侧群组：展开状态下的操作菜单 + 导航箭头。普通的
  // `.memory-item-actions` 菜单在展开时隐藏，因此这将在
  // 上一页/下一页控件旁边保持相同的邮件操作可用。
  const rightCluster = document.createElement('span');
  rightCluster.style.cssText = 'margin-left:auto;display:inline-flex;align-items:center;gap:6px;';
  const headerMenuBtn = document.createElement('button');
  headerMenuBtn.type = 'button';
  headerMenuBtn.className = 'email-card-header-menu';
  headerMenuBtn.title = t('email.actions');
  headerMenuBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
  headerMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _showCardMenu(em, headerMenuBtn);
  });
  // .email-card-nav-arrows 上的 CSS 规则仍然设置 margin-left:auto
  //（当箭头单独在标题行中时需要）。在此包装器内部，
  // 需要群组的 gap 来应用，因此取消该 auto。
  navArrows.style.marginLeft = '0';
  rightCluster.appendChild(headerMenuBtn);
  rightCluster.appendChild(navArrows);
  titleRow.appendChild(rightCluster);

  content.appendChild(titleRow);

  const meta = document.createElement('div');
  meta.className = 'memory-item-meta';
  meta.style.cssText = 'font-size:10px;opacity:0.7;margin-top:2px;';
  const senderPrefix = isSentFolderEarly ? 'to ' : '';
  meta.innerHTML = `<span class="email-meta-sender"><span style="opacity:0.55">${senderPrefix}</span><span style="color:${color};font-weight:600">${_esc(senderName)}</span></span><span class="email-meta-sep"> · </span><span class="email-meta-date">${_esc(dateStr)}</span>`;
  content.appendChild(meta);

  card.appendChild(content);

  // 每张卡片菜单按钮（...菜单）
  if (!state._selectMode) {
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'memory-item-actions';
    const menuBtn = document.createElement('button');
    menuBtn.className = 'memory-item-btn';
    menuBtn.title = t('email.actions');
    menuBtn.style.position = 'relative';
    menuBtn.style.top = '-1px';
    menuBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _showCardMenu(em, menuBtn);
    });
    actionsWrap.appendChild(menuBtn);
    card.appendChild(actionsWrap);

    // 长按行任意位置打开相同的操作菜单 — 与
    // 聊天 / 归档 / 研究 / 文档标签页的长按 UX 匹配。
    let _hold = null, _holdStart = null;
    const _cancelHold = () => { if (_hold) { clearTimeout(_hold); _hold = null; } _holdStart = null; };
    card.addEventListener('pointerdown', (e) => {
      if (card.classList.contains('email-card-expanded') || card.classList.contains('doclib-card-expanded')) return;
      if (e.target.closest('button, .email-card-done, .recipient-chip, .memory-select-cb, .email-card-nav-btn')) return;
      _holdStart = { x: e.clientX, y: e.clientY };
      _hold = setTimeout(() => {
        _hold = null;
        if (card.classList.contains('email-card-expanded') || card.classList.contains('doclib-card-expanded')) return;
        card._suppressNextClick = true;
        setTimeout(() => { card._suppressNextClick = false; }, 400);
        if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
        _showCardMenu(em, menuBtn);
      }, 500);
    });
    card.addEventListener('pointermove', (e) => {
      if (!_holdStart) return;
      if (Math.hypot(e.clientX - _holdStart.x, e.clientY - _holdStart.y) > 10) _cancelHold();
    });
    card.addEventListener('pointerup', _cancelHold);
    card.addEventListener('pointercancel', _cancelHold);
  }

  // 点击处理器 — 切换预览展开
  card.addEventListener('click', async (e) => {
    if (card._suppressNextClick) { card._suppressNextClick = false; return; }
    if (state._selectMode) {
      if (state._selectedUids.has(em.uid)) state._selectedUids.delete(em.uid);
      else state._selectedUids.add(em.uid);
      card.classList.toggle('selected', state._selectedUids.has(em.uid));
      const cb = card.querySelector('.memory-select-cb');
      if (cb) cb.checked = state._selectedUids.has(em.uid);
      _updateBulkBar();
      return;
    }
    await _toggleCardPreview(card, em);
  });

  return card;
}

function _findSiblingEmailCard(card, dir) {
  const grid = card.closest('.doclib-grid');
  if (!grid) return null;
  const cards = [...grid.querySelectorAll('.doclib-card[data-uid]')];
  const idx = cards.indexOf(card);
  if (idx === -1) return null;
  return cards[idx + dir] || null;
}

function _syncCardNavArrows(card) {
  const prev = card.querySelector('.email-card-nav-btn[data-nav-dir="-1"]');
  const next = card.querySelector('.email-card-nav-btn[data-nav-dir="1"]');
  if (prev) prev.disabled = !_findSiblingEmailCard(card, -1);
  if (next) next.disabled = !_findSiblingEmailCard(card, 1);
}

const _emailReadPrefetching = new Set();
let _emailReadPrefetchTimer = null;

function _prefetchAdjacentEmails(card, count = 1) {
  if (!card || state._libFolder === '__scheduled__') return;
  const grid = card.closest('.doclib-grid');
  if (!grid) return;
  const cards = [...grid.querySelectorAll('.doclib-card[data-uid]')];
  const idx = cards.indexOf(card);
  if (idx === -1) return;
  const targets = [];
  for (let i = 1; i <= count; i++) {
    if (cards[idx + i]) targets.push(cards[idx + i]);
  }
  if (targets.length < count) {
    for (let i = 1; targets.length < count && cards[idx - i]; i++) targets.push(cards[idx - i]);
  }
  const target = targets.find(t => t?.dataset?.uid);
  const uid = target?.dataset?.uid;
  if (!uid) return;
  const key = `${state._libAccountId || ''}|${state._libFolder}|${uid}`;
  if (_emailReadPrefetching.has(key) || _emailReadPrefetching.size > 0) return;
  if (_emailReadPrefetchTimer) clearTimeout(_emailReadPrefetchTimer);
  _emailReadPrefetchTimer = setTimeout(() => {
    _emailReadPrefetchTimer = null;
    _emailReadPrefetching.add(key);
    fetch(`${API_BASE}/api/email/read/${encodeURIComponent(uid)}?folder=${encodeURIComponent(state._libFolder)}${_acct()}&mark_seen=false`)
      .catch(() => {})
      .finally(() => _emailReadPrefetching.delete(key));
  }, 900);
}

async function _toggleCardPreview(card, em) {
  const accountAtStart = state._libAccountId || '';
  const folderAtStart = state._libFolder || 'INBOX';
  const uidAtStart = String(em?.uid || card?.dataset?.uid || '');
  const grid = card.closest('.doclib-grid');
  const gridRect = grid?.getBoundingClientRect?.();
  const modal = document.getElementById('email-lib-modal');
  const modalContent = card.closest('.modal-content');
  const modalRect = modalContent?.getBoundingClientRect?.();
  const currentRect = card.getBoundingClientRect();
  const stableOpenHeight = Math.max(
    currentRect.height || 0,
    (modalRect?.height || 0) - 84,
    Math.min(Math.max(260, window.innerHeight * 0.56), gridRect?.height || window.innerHeight)
  );

  // 已展开 — 折叠
  if (card.classList.contains('email-card-expanded')) {
    card.classList.remove('email-card-expanded');
    card.classList.remove('doclib-card-expanded');
    card.style.minHeight = '';
    modal?.classList.remove('email-reading');
    modal?.style.removeProperty('--email-reading-modal-min-h');
    const reader = card.querySelector('.email-card-reader');
    if (reader) reader.remove();
    return;
  }

  // 折叠其他已展开的卡片
  if (grid) {
    grid.querySelectorAll('.email-card-expanded').forEach(c => {
      c.classList.remove('email-card-expanded');
      c.classList.remove('doclib-card-expanded');
      c.style.minHeight = '';
      const r = c.querySelector('.email-card-reader');
      if (r) r.remove();
    });
  }

  card.classList.add('email-card-expanded');
  card.classList.add('doclib-card-expanded');
  card.style.minHeight = `${Math.round(stableOpenHeight)}px`;
  if (!em.is_read) {
    _syncEmailReadState(em.uid, true);
    fetch(`${API_BASE}/api/email/mark-read/${em.uid}?folder=${encodeURIComponent(folderAtStart)}${_acct()}`, { method: 'POST' })
      .catch(err => console.error('Failed to mark email read:', err));
  }
  // 模态框上的类钩子，使头部隐藏/填充规则在不支持 :has()
  // 的浏览器（Firefox 移动版）上也能工作 — 下面的 :has() 版本
  // 保留为桌面路径。
  if (modal && modalRect?.height) {
    modal.style.setProperty('--email-reading-modal-min-h', `${Math.round(modalRect.height)}px`);
  }
  modal?.classList.add('email-reading');

  // 使用旋转器显示加载阅读器
  const reader = document.createElement('div');
  reader.className = 'email-card-reader email-card-reader-loading';
  reader.style.minHeight = `${Math.max(180, Math.round(stableOpenHeight - 70))}px`;
  const loadingWrap = document.createElement('div');
  loadingWrap.style.cssText = 'padding:20px;display:flex;justify-content:center;align-items:center;flex:1;';
  const sp = spinnerModule.createWhirlpool(28);
  loadingWrap.appendChild(sp.element);
  reader.appendChild(loadingWrap);
  card.appendChild(reader);
  _markEmailReaderActive(reader);

  try {
    const res = await fetch(`${API_BASE}/api/email/read/${em.uid}?folder=${encodeURIComponent(folderAtStart)}${_acct()}`);
    const data = await res.json();
    if (
      accountAtStart !== (state._libAccountId || '') ||
      folderAtStart !== (state._libFolder || 'INBOX') ||
      uidAtStart !== String(card?.dataset?.uid || '') ||
      !card.isConnected ||
      !card.classList.contains('email-card-expanded')
    ) {
      return;
    }
    if (data.error) {
      reader.innerHTML = `<div style="padding:20px;color:var(--red,#e55)">Error: ${_esc(data.error)}</div>`;
      return;
    }

    // 本地标记为已读
    _syncEmailReadState(em.uid, true);
    _prefetchAdjacentEmails(card);

    // 使用共享辅助函数构建附件包裹，以便签名图像过滤器
    //（小内联 PNG/JPG、Outlook image001 占位符、logo/banner 文件）
    // 在此处也适用。当所有附件都被过滤掉时回退到 ''。
    const attsHtml = _buildAttsHtmlFor(em.uid, data);

    // 格式化日期为简洁形式："Mar 21, 2026 14:32"
    let dateDisplay = data.date || '';
    try {
      if (data.date) {
        const d = new Date(data.date);
        if (!isNaN(d.getTime())) {
          dateDisplay = d.toLocaleString([], {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          });
        }
      }
    } catch (_) {}

    // 从逗号分隔的地址列表构建收件人芯片组
    const buildRecipients = (str) => {
      if (!str) return '';
      const addrs = _splitRecipientList(str);
      if (addrs.length === 0) return '';
      return addrs.map(a => {
        const name = _extractName(a);
        return _recipientChipHtml(a, name);
      }).join('');
    };

    // 构建 From 芯片 — 单个芯片带有姓名，点击显示地址
    const fromChip = _recipientChipHtml(`${data.from_name || ''} <${data.from_address || ''}>`, data.from_name || data.from_address, 'from-chip');

    reader.innerHTML = `
      <div class="email-reader-header">
        <div class="email-reader-meta">
          <div class="email-reader-meta-row"><strong>From:</strong><span class="recipient-chips">${fromChip}</span></div>
          ${data.to ? `<div class="email-reader-meta-row"><strong>To:</strong><span class="recipient-chips">${buildRecipients(data.to)}</span></div>` : ''}
          ${data.cc ? `<div class="email-reader-meta-row"><strong>Cc:</strong><span class="recipient-chips">${buildRecipients(data.cc)}</span></div>` : ''}
        </div>
        <div class="email-reader-actions">
          <div class="email-reader-actions-row email-reader-actions-row-primary">
            <button class="memory-toolbar-btn reader-icon-btn" data-act="reply" title="Reply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg><span class="reader-btn-label">Reply</span></button>
            ${_hasMultipleRecipients(data) ? `<button class="memory-toolbar-btn reader-icon-btn" data-act="reply-all" title="Reply All"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/></svg><span class="reader-btn-label">Reply all</span></button>` : ''}
            <button class="memory-toolbar-btn reader-icon-btn" data-act="forward" title="Forward"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg><span class="reader-btn-label">Forward</span></button>
          </div>
          <div class="email-reader-actions-row email-reader-actions-row-secondary">
            <button class="memory-toolbar-btn reader-icon-btn" data-act="ai-reply" title="${data.cached_ai_reply ? 'AI Reply (cached draft ready)' : 'AI Reply (suggest a draft)'}">${_aiReplyIcon(data)}<span class="reader-btn-label">AI reply</span></button>
            <button class="memory-toolbar-btn reader-icon-btn" data-act="summarize" title="Summarize">${_summaryIcon(data)}<span class="reader-btn-label">Summary</span></button>
            <button class="memory-toolbar-btn reader-icon-btn" data-act="from-sender" title="Search text in this thread"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span class="reader-btn-label">Search</span></button>
            <div class="email-reader-more-wrap" style="position:relative">
              <button class="memory-toolbar-btn reader-icon-btn" data-act="more" title="More actions"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg><span class="reader-btn-label">More</span></button>
            </div>
          </div>
        </div>
      </div>
      ${attsHtml}
      <div class="email-reader-body${data.body_html ? ' html-body' : ''}">${_safeRenderEmailBody(data)}</div>
    `;
    _markEmailReaderActive(reader);
    reader.classList.remove('email-card-reader-loading');
    reader.style.minHeight = '';

    // 附件头部点击切换折叠/展开（与摘要相同的 UX）。
    const attsWrap = reader.querySelector('.email-reader-atts-wrap');
    if (attsWrap) {
      const attsToggle = attsWrap.querySelector('.email-reader-atts-header');
      if (attsToggle) {
        attsToggle.addEventListener('click', (ev) => {
          ev.stopPropagation();
          attsWrap.classList.toggle('collapsed');
        });
        attsToggle.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            attsWrap.classList.toggle('collapsed');
          }
        });
      }
    }

    // 附件芯片点击：在移动端和桌面端都可用。iOS Safari 忽略
    // 实际 DOM 中 <a> 之外的编程 <a download>。在移动端打开新标签页中的 URL，
    // 以便操作系统选择操作；在桌面端 fetch + blob 下载以保留文件名且不触发
    // 弹出窗口拦截器。
    const _isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    _wireAttachmentHandlers(reader, state._libFolder);

    reader.querySelector('[data-act="reply"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      _snapEmailModalToLeftSidebar(ev.currentTarget.closest('.modal'));
      if (state._onEmailClick) await state._onEmailClick({ email: em, emailData: data, mode: 'reply' });
    });
    reader.querySelector('[data-act="reply-all"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      _snapEmailModalToLeftSidebar(ev.currentTarget.closest('.modal'));
      if (state._onEmailClick) await state._onEmailClick({ email: em, emailData: data, mode: 'reply-all' });
    });
    reader.querySelector('[data-act="ai-reply"]')?.addEventListener('click', (ev) => _handleAiReplyButton(ev, em, data));
    reader.querySelector('[data-act="forward"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (state._onEmailClick) await state._onEmailClick({ email: em, emailData: data, mode: 'forward' });
    });
    reader.querySelector('[data-act="close"]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _toggleCardPreview(card, em);
    });
    reader.querySelector('[data-act="more"]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _showReaderMoreMenu(em, card, reader, ev.currentTarget);
    });
    reader.querySelector('[data-act="summarize"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await _summarizeEmail(reader, data, ev.currentTarget);
    });
    // from-sender / thread-search 搜索按钮暂时禁用 —
    // 搜索 + 线程侧边栏 UX 太不稳定无法发布。从每个阅读器渲染路径中
    // 物理移除此按钮。通过删除这些 .remove() 行 + CSS 规则可重新启用。
    reader.querySelector('[data-act="from-sender"]')?.remove();
    reader.querySelector('[data-act="from-sender"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await _toggleFromSenderPanel(reader, data, ev.currentTarget);
    });

    // 刷新此新展开卡片的标题行上一页/下一页箭头。
    _syncCardNavArrows(card);

    // 在阅读器上水平滑动切换到上一封/下一封邮件 — 但
    // 仅当底层内容无法在滑动方向上进一步滚动时才切换。
    // 如果邮件正文比视口宽（带表格的 HTML 邮件、嵌入图片），
    // 正常水平滚动优先；导航仅在用户到达边缘后才会触发。
    {
      let _sx = 0, _sy = 0, _swiping = false, _intent = null;
      let _scrollEl = null;
      let _startScrollLeft = 0;
      const SWIPE_THRESHOLD = 60;
      const VERT_ABORT = 14;
      const findHScroller = (el) => {
        while (el && el !== reader) {
          if (el.scrollWidth - el.clientWidth > 2) return el;
          el = el.parentElement;
        }
        return null;
      };
      reader.addEventListener('touchstart', (ev) => {
        if (ev.touches.length !== 1) { _swiping = false; return; }
        if (ev.target.closest('button, a, .recipient-chip, .email-attachment-chip, .email-reader-more-wrap')) { _swiping = false; return; }
        _sx = ev.touches[0].clientX;
        _sy = ev.touches[0].clientY;
        _scrollEl = findHScroller(ev.target);
        _startScrollLeft = _scrollEl ? _scrollEl.scrollLeft : 0;
        _swiping = true;
        _intent = null;
      }, { passive: true });
      reader.addEventListener('touchmove', (ev) => {
        if (!_swiping) return;
        const dx = ev.touches[0].clientX - _sx;
        const dy = ev.touches[0].clientY - _sy;
        if (!_intent) {
          if (Math.abs(dy) > VERT_ABORT && Math.abs(dy) > Math.abs(dx)) {
            _intent = 'scroll';
            _swiping = false;
            return;
          }
          if (Math.abs(dx) > 12) _intent = 'swipe';
        }
      }, { passive: true });
      reader.addEventListener('touchend', (ev) => {
        if (!_swiping) return;
        _swiping = false;
        const t = (ev.changedTouches && ev.changedTouches[0]) || null;
        if (!t || _intent !== 'swipe') return;
        const dx = t.clientX - _sx;
        const dy = t.clientY - _sy;
        if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;
        // 如果可水平滚动元素捕获了滑动，让它滚动而非切换邮件 —
        // 除非用户已经处于边缘（scrollLeft 无法在该方向进一步移动）。
        if (_scrollEl) {
          const max = _scrollEl.scrollWidth - _scrollEl.clientWidth;
          const atLeftEdge = _scrollEl.scrollLeft <= 2;
          const atRightEdge = _scrollEl.scrollLeft >= max - 2;
          // 向左滑动(dx<0)显示右侧内容 → 如果不在右边缘，
          // 这是滚动而非导航。
          if (dx < 0 && !atRightEdge) return;
          // 向右滑动(dx>0)显示左侧内容 → 如果不在左边缘，
          // 这是滚动而非导航。
          if (dx > 0 && !atLeftEdge) return;
          // 如果浏览器在此手势期间已经滚动，无条件视为滚动
          //（用户显然想要平移）。
          if (_scrollEl.scrollLeft !== _startScrollLeft) return;
        }
        const dir = dx < 0 ? 1 : -1;
        const navBtn = card.querySelector(`.email-card-nav-btn[data-nav-dir="${dir}"]`);
        if (navBtn && !navBtn.disabled) navBtn.click();
      }, { passive: true });
    }

    // 如果邮件有预缓存的摘要，立即显示。折叠状态通过渲染器中的
    // _summaryCollapsedPref 持久化。
    if (data.cached_summary) {
      const sumBtn = reader.querySelector('[data-act="summarize"]');
      _showCachedSummary(reader, data.cached_summary, sumBtn);
    }

    _wireRecipientChips(reader);
    // 始终停止冒泡，以便在读邮件时卡的点击不会触发。
    reader.addEventListener('click', (ev) => { ev.stopPropagation(); });
  } catch (e) {
    reader.innerHTML = `<div style="padding:20px;color:var(--red,#e55)">Failed to load email</div>`;
  }
}

/**
 * 将可能的签名块包裹在折叠的 <details> 中，以防止其占据整个阅读器。
 * 我们按优先级顺序尝试：
 *   1. 邮件客户端签名包裹器 — Gmail 的 `gmail_signature` div 是显式的，
 *      无需猜测。Apple Mail 的 data-smartmail 同理。
 *   2. 标准的 "-- " RFC 3676 签名分隔符。
 *   3. 常见的落款短语（"Best regards"、"Cheers" 等）在自己的行上 —
 *      较模糊，但能捕获没有破折号标记的签名。
 *   4. "Sent from my iPhone/Android" / "Get Outlook for ..." 移动客户端
 *      样板文本。
 * 任何匹配的内容从标记处到正文末尾都被包裹起来。
 */
/**
 * 渲染带签名/引用折叠的邮件正文。如果后端缓存了 LLM 检测到的
 * 边界偏移量（data.boundaries），使用它们进行基于纯文本位置的精确折叠。
 * 否则回退到正则检测器。当边界存在时纯文本分支始终优先，
 * 因为偏移量是基于纯文本计算的。
 */
// 全局逃生舱口 — 当服务端的线程解析器出错时（偶尔会将单个回复
// 拆分成两个虚假的"轮次"，将签名/免责声明当作独立消息处理），
// 用户可以关闭此选项以回退到普通渲染。重启后仍然保留。
const _BUBBLES_DISABLED_KEY = 'odysseus.email.bubblesDisabled';
// 线程化聊天气泡邮件视图目前已禁用 — 太不稳定无法发布。
// 通过始终返回 true 来强制使用纯文本渲染。
// 重新启用需恢复 localStorage 支持的主体 + 阅读器
// 更多菜单中的切换菜单项。
function _bubblesDisabled() {
  return true;
}
function _setBubblesDisabled(v) {
  try { localStorage.setItem(_BUBBLES_DISABLED_KEY, v ? '1' : '0'); } catch {}
}

function _renderEmailBody(data) {
  const plain = (typeof data?.body === 'string' && data.body.length) ? data.body : '';
  const folder = String(data?.folder || '').toLowerCase();
  const isSentFolder = folder.includes('sent');
  const fromAddr = String(data?.from_address || '').toLowerCase().trim();
  const isMine = !!fromAddr && _meEmailAddrs().has(fromAddr);

  // 用户撰写的消息（已发送文件夹或收件箱中的自己发送副本）
  // 是当前撰写的文本。不要让缓存的边界或 HTML 引用解析
  // 将整个内容隐藏在"较早回复"后面。
  if ((isSentFolder || isMine) && plain) {
    const plainTurns = _renderPlaintextThread(plain);
    if (plainTurns && !/^\s*<details\b/i.test(plainTurns.trim())) {
      return _foldSignature(plainTurns, null);
    }
    return _foldSignature(_escLinkify(plain).replace(/\n/g, '<br>'), null);
  }

  // 优先使用服务端缓存的线程解析 — 这是最丰富的结构，
  // 也是聊天气泡布局的基础。当用户手动禁用
  // 气泡渲染时跳过。
  if (!_bubblesDisabled() && Array.isArray(data && data.thread_turns) && data.thread_turns.length) {
    return _foldSignature(
      _renderTurnsAsBubbles(data.thread_turns, data),
      data && data.sender_signature || null,
    );
  }
  const b = data && data.boundaries;
  // 当存在缓存边界且有纯文本来切分时使用缓存边界
  if (b && plain && (b.sig_start >= 0 || b.quote_start >= 0)) {
    // 选择两者中较早的作为"此点以下的所有内容都是可折叠的"的切分点，
    // 但分别用各自的标签渲染签名和引用。
    let sig = (typeof b.sig_start === 'number' && b.sig_start >= 0) ? b.sig_start : -1;
    let quote = (typeof b.quote_start === 'number' && b.quote_start >= 0) ? b.quote_start : -1;
    // Clamp
    if (sig >= plain.length) sig = -1;
    if (quote >= plain.length) quote = -1;
    let head = plain;
    let sigSection = '';
    let quoteSection = '';
    if (sig >= 0 && quote >= 0) {
      const earlier = Math.min(sig, quote);
      head = plain.slice(0, earlier);
      if (sig < quote) {
        sigSection = plain.slice(sig, quote);
        quoteSection = plain.slice(quote);
      } else {
        quoteSection = plain.slice(quote, sig);
        sigSection = plain.slice(sig);
      }
    } else if (sig >= 0) {
      head = plain.slice(0, sig);
      sigSection = plain.slice(sig);
    } else {
      head = plain.slice(0, quote);
      quoteSection = plain.slice(quote);
    }
    const fmt = (s) => _escLinkify(s).replace(/\n/g, '<br>');
    let out = fmt(head);
    if (quoteSection) {
      out += '<details class="email-quote-fold">'
           + _foldSummary('Earlier thread', _QUOTE_ICON, _extractQuoteMeta(quoteSection))
           + fmt(quoteSection) + '</details>';
    }
    if (sigSection) {
      const sigHtml = fmt(sigSection);
      if (_isBloatedSig(sigHtml)) {
        out += '<details class="email-sig-fold">' + _foldSummary('Signature', _SIG_ICON)
             + sigHtml + '</details>';
      } else {
        // 短落款 — 保持内联；折叠只会增加样板。
        out += sigHtml;
      }
    }
    return out;
  }
  // 回退：客户端解析（HTML 或纯文本）。
  const hintSig = (data && data.sender_signature) || null;
  const isHtml = !!data.body_html;
  let rendered;
  if (isHtml) {
    rendered = _sanitizeHtml(data.body_html);
  } else {
    const plainTurns = _renderPlaintextThread(data.body || '');
    if (plainTurns) return _foldSignature(plainTurns, hintSig);
    rendered = _escLinkify(data.body || '').replace(/\n/g, '<br>');
  }
  const threaded = _renderThreadStructure(rendered);
  if (threaded) return _foldSignature(threaded, hintSig);
  return _foldSignature(_foldQuotedReplies(rendered), hintSig);
}

function _safeRenderEmailBody(data) {
  try {
    return _renderEmailBody(data);
  } catch (e) {
    console.error('email body render failed:', e);
    const plain = (typeof data?.body === 'string') ? data.body : '';
    if (plain) return _escLinkify(plain).replace(/\n/g, '<br>');
    if (data?.body_html) return _sanitizeHtml(data.body_html);
    return '<span style="opacity:.65">No body</span>';
  }
}

// ── 邮件线程的聊天气泡渲染 ──
// 每个解析的轮次渲染为一个聊天气泡。活动账户的
// 发出的回复气泡右对齐；其他人的气泡左对齐。
// 顺序颠倒，使最旧的消息位于对话顶部，
// 最新的（当前正在阅读的消息）位于底部 —
// 符合人们对聊天的心理模型。

function _meEmailAddrs() {
  const set = new Set();
  for (const a of (state._libAccounts || [])) {
    if (a && a.from_address) set.add(String(a.from_address).toLowerCase().trim());
    if (a && a.imap_user) set.add(String(a.imap_user).toLowerCase().trim());
  }
  return set;
}

// _parseTurnMeta / _formatBubbleDate / _formatRecipients / _senderColor /
// _initials 位于 ./emailLibrary/utils.js

function _renderTurnsAsBubbles(turns, data) {
  if (!Array.isArray(turns) || !turns.length) return '';
  const mineSet = _meEmailAddrs();
  const lvl0Email = String(data && data.from_address || '').toLowerCase().trim();
  const lvl0Mine = !!lvl0Email && mineSet.has(lvl0Email);
  const lvl0Author = (data && (data.from_name || data.from_address)) || '';
  const lvl0Date = _formatBubbleDate(data && data.date);

  // 最新回复在顶部，较旧的历史记录在下方。轮次按浅→深排列
  //（级别 0 = 当前回复，更深级别 = 较早的引用材料），因此我们
  // 按源顺序渲染而不反转。
  const ordered = turns.slice();

  // 收集每个轮次的发件人身份 + 频率，用于下面的无自我情况。
  const turnIdentity = ordered.map((t) => {
    if (t.level === 0) {
      return { email: lvl0Email, author: lvl0Author };
    }
    const p = _parseTurnMeta(t.meta || '');
    return { email: p.email, author: p.author };
  });
  const anyMine = turnIdentity.some(x => x.email && mineSet.has(x.email));
  // 当用户不是此线程的参与者时（转发链、历史档案等），
  // 将两个最频繁的发件人分配到相反的两侧，以便对话仍能左右阅读。
  // 第三及更多参与方退回到哈希取模 2。
  const sideForKey = (() => {
    if (anyMine) return null;
    const freq = new Map();
    const firstSeen = new Map();
    turnIdentity.forEach((x, i) => {
      const key = (x.email || x.author || '').toLowerCase();
      if (!key) return;
      freq.set(key, (freq.get(key) || 0) + 1);
      if (!firstSeen.has(key)) firstSeen.set(key, i);
    });
    const sorted = [...freq.entries()]
      .sort((a, b) => (b[1] - a[1]) || (firstSeen.get(a[0]) - firstSeen.get(b[0])));
    const leftKey  = sorted[0] && sorted[0][0];
    const rightKey = sorted[1] && sorted[1][0];
    return (key) => {
      if (!key) return 'theirs';
      if (key === leftKey)  return 'theirs';
      if (key === rightKey) return 'mine';
      // 为第三及以上参与方使用稳定哈希。
      let h = 0;
      for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
      return (h & 1) ? 'mine' : 'theirs';
    };
  })();

  const rows = ordered.map((t, i) => {
    let isMine, author, date;
    if (t.level === 0) {
      isMine = lvl0Mine;
      author = lvl0Author || 'Me';
      date = lvl0Date;
    } else {
      const p = _parseTurnMeta(t.meta || '');
      isMine = !!p.email && mineSet.has(p.email);
      author = p.author || (t.meta || 'Earlier reply');
      date = p.date;
    }
    // 无自我回退：按每个发件人侧边映射路由。
    if (sideForKey) {
      const id = turnIdentity[i];
      const key = (id.email || id.author || '').toLowerCase();
      isMine = sideForKey(key) === 'mine';
    }
    const side = isMine ? 'mine' : 'theirs';
    const initials = _initials(author);
    const color = _senderColor(author || (t.level === 0 ? lvl0Email : ''));
    const head =
      `<div class="email-bubble-head">`
      + `<span class="email-bubble-author" style="color:${color}">${_esc(author)}</span>`
      + (date ? `<span class="email-bubble-date">${_esc(date)}</span>` : '')
      + `</div>`;
    const avatar = `<div class="email-bubble-avatar" aria-hidden="true" style="background:${color}">${_esc(initials)}</div>`;
    return (
      `<div class="email-bubble-row email-bubble-${side}" style="--bubble-accent:${color}">`
      + (isMine ? '' : avatar)
      + `<div class="email-bubble">`
      +   head
      +   `<div class="email-bubble-body">${_sanitizeHtml(t.body_html || '')}</div>`
      + `</div>`
      + (isMine ? avatar : '')
      + `</div>`
    );
  });
  return `<div class="email-bubbles">${rows.join('')}</div>`;
}

/**
 * 将服务端缓存的线程轮次（{level, body_html, meta} 列表）
 * 渲染为客户端解析器产生的相同嵌套卡片结构。
 */
function _renderTurnsFromServer(turns) {
  if (!Array.isArray(turns) || !turns.length) return '';
  let out = '';
  const stack = []; // [{ level, html }]
  const wrap = (t) =>
    `<details class="email-thread-turn email-quote-fold" open>`
    + _foldSummary('Earlier reply', _QUOTE_ICON, t.meta || '')
    + `<div class="email-thread-turn-body">${t.html}</div>`
    + '</details>';

  for (const t of turns) {
    if (t.level === 0) {
      while (stack.length) {
        const top = stack.pop();
        const w = wrap(top);
        if (stack.length) stack[stack.length - 1].html += w; else out += w;
      }
      out += _sanitizeHtml(t.body_html || '');
    } else {
      while (stack.length && stack[stack.length - 1].level > t.level) {
        const top = stack.pop();
        const w = wrap(top);
        if (stack.length) stack[stack.length - 1].html += w; else out += w;
      }
      if (!stack.length || stack[stack.length - 1].level < t.level) {
        stack.push({ level: t.level, meta: t.meta, html: _sanitizeHtml(t.body_html || '') });
      } else {
        stack[stack.length - 1].html += _sanitizeHtml(t.body_html || '');
        if (t.meta && !stack[stack.length - 1].meta) {
          stack[stack.length - 1].meta = t.meta;
        }
      }
    }
  }
  while (stack.length) {
    const top = stack.pop();
    const w = wrap(top);
    if (stack.length) stack[stack.length - 1].html += w; else out += w;
  }
  // 为底部折叠标记圆角。
  const lastIdx = out.lastIndexOf('<details class="email-thread-turn email-quote-fold"');
  if (lastIdx >= 0) {
    out = out.slice(0, lastIdx)
        + out.slice(lastIdx).replace(
            'email-thread-turn email-quote-fold"',
            'email-thread-turn email-quote-fold last-fold"'
          );
  }
  return out;
}

/**
 * 将邮件正文的回复链解析为轮次卡片堆栈。
 * 每个轮次 = { author, date, bodyHtml, nested[] }，其中 body 是
 * 在下一个引用边界之前的全部内容，`nested` 是内部的子线程
 *（递归解析）。如果邮件没有引用线程可解析（单条消息，无需折叠），
 * 返回 null。
 */
// ── 受 Talon 启发的多语言引用检测模式 ──
// 来源：
//   github.com/mailgun/talon（HTML/文本引用检测）
//   github.com/crisp-oss/email-reply-parser（语言环境列表）
//
// _TALON_* / _SIG_BLOAT_MIN_CHARS 位于 ./emailLibrary/utils.js
// _SIG_ICON / _QUOTE_ICON 位于 ./emailLibrary/signatureFold.js

function _renderThreadStructure(html) {
  if (!html || typeof html !== 'string' || html.length > 200000) return null;
  let doc;
  try { doc = new DOMParser().parseFromString(`<div id="__t">${html}</div>`, 'text/html'); }
  catch { return null; }
  const root = doc.getElementById('__t');
  if (!root) return null;

  // 找到顶级 blockquote（不在另一个 blockquote 内部嵌套的）。
  const tops = Array.from(root.querySelectorAll('blockquote')).filter(b =>
    !b.parentElement.closest('blockquote')
  );
  if (!tops.length) return null;

  // 构建当前消息正文：根目录中在第一个顶级 blockquote
  // 之前的所有内容，减去引入它的 "On <date>, <author> wrote:" 归属行。
  const head = doc.createElement('div');
  let cursor = root.firstChild;
  while (cursor && cursor !== tops[0]) {
    const next = cursor.nextSibling;
    head.appendChild(cursor);
    cursor = next;
  }
  // 从 `head` 中剥离尾部的 "On <date>, <name> wrote:" / Outlook 风格归属，
  // 因为相同的信息会出现在轮次头部中。
  let attribution = _harvestAttribution(head);

  // 递归解析每个顶级 blockquote 为一个轮次（及其嵌套链）。
  const turnsHtml = [];
  for (let i = 0; i < tops.length; i++) {
    const bq = tops[i];
    // blockquote 可能在内部第一个文本中包含 Outlook 风格的
    // "From: / Sent: / Subject:" 头部。将其提取为轮次元数据。
    const meta = _extractTurnMetaFromBlockquote(bq) || attribution || _extractQuoteMeta(bq.innerHTML);
    const innerHtml = bq.innerHTML;

    // 启发式：如果一个 blockquote 没有可检测的归属（无 "From:"，
    // 无 "On <date>... wrote:"）且其内容匹配签名风格模式
    //（公司免责声明、"registered in"、法律声明、仅姓名 + 职位），
    // 将其视为签名折叠而非较早回复。这阻止了将签名包裹在
    // <blockquote> 中的邮件客户端使签名显示为幻影先前邮件。
    if (!meta && _looksLikeSignature(innerHtml)) {
      turnsHtml.push(
        '<details class="email-sig-fold">'
        + _foldSummary('Signature', _SIG_ICON)
        + `<div class="email-sig-body">${innerHtml}</div>`
        + '</details>'
      );
      attribution = null;
      continue;
    }

    // 递归渲染此 blockquote 内部（可能包含其自己的
    // 嵌套 blockquote，表示更早的回复）。
    const nested = _renderThreadStructure(innerHtml);
    const bodyHtml = nested || innerHtml;
    const isLast = i === tops.length - 1;
    turnsHtml.push(
      `<details class="email-thread-turn email-quote-fold${isLast ? ' last-fold' : ''}" ${i === 0 ? '' : 'open'}>`
        + _foldSummary('Earlier reply', _QUOTE_ICON, meta || '')
        + `<div class="email-thread-turn-body">${bodyHtml}</div>`
      + '</details>'
    );
    // 只有第一个轮次使用提取的归属；更深层次的轮次
    // 从 blockquote 内部获取自己的归属。
    attribution = null;
  }

  return head.innerHTML + turnsHtml.join('');
}

// 看起来像签名/公司免责声明而非引用邮件。
// 用于将一些发件人包裹其签名+免责声明的无归属 blockquote
//（Outlook、EY、大公司）从"较早回复"降级为适当的签名折叠。
// 保守 — 仅当没有引用回复标记且匹配强烈的公司噪音短语时才触发。
// _looksLikeSignature / _harvestAttribution / _extractTurnMetaFromBlockquote
// 位于 ./emailLibrary/signatureFold.js

/**
 * 将任何引用的回复链包裹在折叠的 <details> 中，以免深度邮件线程
 * 主导阅读器。检测：
 *   - <blockquote> 标签（Gmail / 本地引用回复）
 *   - Outlook 风格 "From: ... Sent: ... To: ... Subject: ..." 头部
 * 每个都获得自己的"较早线程"切换。
 */
/**
 * 将纯文本邮件正文解析为堆叠的轮次卡片，通过遍历
 * `> ` 引用前缀级别和 Outlook 风格 "On X wrote:" / Original-Message
 * 边界。返回渲染后的 HTML，或在没有引用内容时返回 null
 *（调用方回退到扁平渲染）。
 *
 * 镜像 talon 的 `extract_from_plain` 和 email-reply-parser 片段：
 *   1. 以一个或多个 `>` 字符开头的行是引用的（级别 = > 的数量）。
 *   2. 增加级别打开更深层次的轮次（嵌套回复）。
 *   3. `-----Original Message-----` 和 `On <date>, <name> wrote:` 即使
 *      没有 `>` 也启动新轮次。
 *   4. 前导的非引用段是当前消息。
 */
function _renderPlaintextThread(text) {
  if (!text || typeof text !== 'string' || text.length > 200000) return null;
  const lines = text.split(/\r?\n/);
  const levels = lines.map(l => {
    const m = l.match(/^((?:>\s?)+)/);
    return m ? (m[1].match(/>/g) || []).length : 0;
  });
  const hasQuotes = levels.some(l => l > 0);
  const attribLineRe = new RegExp(`(?:^|\\n)\\s*On\\s.+?\\s${_TALON_WROTE}\\s*:\\s*$`, 'im');
  const hasAttrib = attribLineRe.test(text) || _TALON_ORIG_RE.test(text);
  if (!hasQuotes && !hasAttrib) return null;

  const turns = [];
  let buf = [];
  let curLevel = 0;
  let pendingMeta = null;
  const flush = () => {
    if (!buf.length) return;
    const t = buf.join('\n').trimEnd();
    if (t || curLevel > 0) turns.push({ level: curLevel, text: t, meta: pendingMeta });
    buf = [];
    pendingMeta = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const lvl = levels[i];
    const raw = lines[i];
    const stripped = lvl > 0 ? raw.replace(/^(?:>\s?)+/, '') : raw;
    const isSeparatorLine = lvl === 0 && /^-{5,}\s*Previous message\s*-{5,}$/i.test(raw.trim());
    const isAttribLine = lvl === 0
      && (new RegExp(`^\\s*On\\s.+?\\s${_TALON_WROTE}\\s*:\\s*$`, 'i').test(raw)
          || _TALON_ORIG_RE.test('\n' + raw));
    if (isSeparatorLine || isAttribLine) {
      flush();
      pendingMeta = isSeparatorLine ? null : (_extractQuoteMeta(raw) || raw.trim());
      curLevel = 1;
      continue;
    }
    if (lvl !== curLevel) {
      flush();
      curLevel = lvl;
    }
    buf.push(stripped);
  }
  flush();

  if (!turns.length || (turns.length === 1 && turns[0].level === 0)) return null;

  const fmt = s => _escLinkify(s).replace(/\n/g, '<br>');
  let out = '';
  const stack = [];
  const wrapTurn = (t) =>
    `<details class="email-thread-turn email-quote-fold" open>`
    + _foldSummary('Earlier reply', _QUOTE_ICON, t.meta || '')
    + `<div class="email-thread-turn-body">${t.html}</div>`
    + '</details>';

  for (const t of turns) {
    if (t.level === 0) {
      while (stack.length) {
        const top = stack.pop();
        const wrapped = wrapTurn(top);
        if (stack.length) stack[stack.length - 1].html += wrapped; else out += wrapped;
      }
      out += fmt(t.text);
    } else {
      while (stack.length && stack[stack.length - 1].level > t.level) {
        const top = stack.pop();
        const wrapped = wrapTurn(top);
        if (stack.length) stack[stack.length - 1].html += wrapped; else out += wrapped;
      }
      if (!stack.length || stack[stack.length - 1].level < t.level) {
        stack.push({ level: t.level, meta: t.meta, html: fmt(t.text) });
      } else {
        stack[stack.length - 1].html += '<br>' + fmt(t.text);
        if (t.meta && !stack[stack.length - 1].meta) stack[stack.length - 1].meta = t.meta;
      }
    }
  }
  while (stack.length) {
    const top = stack.pop();
    const wrapped = wrapTurn(top);
    if (stack.length) stack[stack.length - 1].html += wrapped; else out += wrapped;
  }
  const lastIdx = out.lastIndexOf('<details class="email-thread-turn email-quote-fold"');
  if (lastIdx >= 0) {
    out = out.slice(0, lastIdx)
        + out.slice(lastIdx).replace(
            'email-thread-turn email-quote-fold"',
            'email-thread-turn email-quote-fold last-fold"'
          );
  }
  return out;
}

// _foldSummary / _extractQuoteMeta / _SIG_ICON / _QUOTE_ICON
// 位于 ./emailLibrary/signatureFold.js

function _foldQuotedReplies(html) {
  if (!html || typeof html !== 'string') return html;
  if (html.length > 200000) return html;
  const before = html;
  // 使用 DOMParser 进行正确的嵌套 blockquote 处理。针对 HTML 的正则
  // 错误处理嵌套并留下孤立的闭合标签，浏览器重新平衡这些标签，
  // 产生两种视觉上不一致的折叠样式。
  try {
    const doc = new DOMParser().parseFromString(`<div id="__r">${html}</div>`, 'text/html');
    const root = doc.getElementById('__r');
    if (root) {
      const tops = Array.from(root.querySelectorAll('blockquote')).filter(b =>
        !b.parentElement.closest('blockquote')
      );
      if (tops.length) {
        for (const bq of tops) {
          const det = doc.createElement('details');
          det.className = 'email-quote-fold';
          // 将摘要构建为原始 HTML — 比手动构建 DOM 更容易。
          const summary = _foldSummary('Earlier thread', _QUOTE_ICON, _extractQuoteMeta(bq.innerHTML));
          det.innerHTML = summary;
          bq.parentNode.insertBefore(det, bq);
          det.appendChild(bq); // 将原始 blockquote（及任何嵌套的）移入 details
        }
        // 仅标记最后一个折叠，以便 CSS 可以为其添加圆角底边。
        const allFolds = root.querySelectorAll('.email-quote-fold');
        if (allFolds.length) allFolds[allFolds.length - 1].classList.add('last-fold');
        return root.innerHTML;
      }
    }
  } catch (e) {
    // 如果 DOMParser 失败，回退到下面的旧正则路径
  }
  // 如果 DOM 路径已经包裹了某些内容，我们上面已返回。否则
  // 未找到 blockquote — 尝试 Outlook 头部启发式。
  if (html !== before) return html;
  // Outlook 风格引用回复头部 — 多语言。从第一个
  // "From: ... Sent: ... Subject: ..." 块折叠到正文末尾，
  // 所有先前的线程级别一起折叠。
  const FROM = '(?:From|Från|Von|De|De\\s|Da|От|Od|Van)';
  const SENT = '(?:Sent|Skickat|Gesendet|Envoyé|Inviato|Enviado|Verzonden|Отправлено|Wysłane)';
  const SUBJ = '(?:Subject|Ämne|Betreff|Objet|Oggetto|Asunto|Onderwerp|Тема|Temat)';
  const outlookRe = new RegExp(
    `(<br\\s*/?>|</p>|</div>|<p[^>]*>|<div[^>]*>|\\n)\\s*((?:<[^>]+>\\s*)*${FROM}\\s*:\\s*[^<\\n]+(?:<[^>]+>\\s*|\\s)*${SENT}\\s*:[\\s\\S]+?${SUBJ}\\s*:[\\s\\S]+)$`,
    'i'
  );
  const m = html.match(outlookRe);
  if (m) {
    const idx = html.lastIndexOf(m[0]);
    // Outlook 回退最终只产生一个折叠，因此将其标记为最后一个。
    html = html.slice(0, idx) + m[1]
      + '<details class="email-quote-fold last-fold">'
      + _foldSummary('Earlier thread', _QUOTE_ICON, _extractQuoteMeta(m[2]))
      + m[2] + '</details>';
  }
  return html;
}


// 全局偏好：一旦用户折叠某个 AI 摘要面板，所有邮件都保持折叠状态；
// 一旦展开，保持展开状态。存储在 localStorage 中，
// 以便选择在重新加载后仍然保留。
const _SUMMARY_COLLAPSED_KEY = 'odysseus.email.summaryCollapsed';
function _summaryCollapsedPref() {
  try { return localStorage.getItem(_SUMMARY_COLLAPSED_KEY) === '1'; } catch { return false; }
}
function _setSummaryCollapsedPref(v) {
  try { localStorage.setItem(_SUMMARY_COLLAPSED_KEY, v ? '1' : '0'); } catch {}
}

function _showCachedSummary(reader, summary, btn) {
  const body = reader.querySelector('.email-reader-body');
  if (!body) return;
  if (body.querySelector('.email-summary-panel')) return;
  const panel = document.createElement('div');
  panel.className = 'email-summary-panel';
  if (_summaryCollapsedPref()) panel.classList.add('collapsed');
  panel.innerHTML =
    '<div class="email-summary-header email-summary-toggle" role="button" tabindex="0">'
    +   '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg>'
    +   '<span>Summary</span>'
    +   '<svg class="email-summary-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;transition:transform .15s ease;"><polyline points="6 9 12 15 18 9"/></svg>'
    + '</div>'
    + '<div class="email-summary-content"></div>';
  panel.querySelector('.email-summary-content').textContent = summary;
  body.insertBefore(panel, body.firstChild);
  const toggle = panel.querySelector('.email-summary-toggle');
  // 头部点击折叠/展开。持久化以便下一封邮件以相同状态打开。
  const _flip = () => {
    panel.classList.toggle('collapsed');
    _setSummaryCollapsedPref(panel.classList.contains('collapsed'));
  };
  if (toggle) {
    toggle.addEventListener('click', (ev) => { ev.stopPropagation(); _flip(); });
    toggle.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); _flip(); }
    });
  }
  if (btn) {
    btn.classList.add('active');
    const label = btn.querySelector('.btn-label');
    if (label) label.textContent = t('email.summary');
  }
}

// "此发件人的其他邮件" — 阅读器内的滑出面板，列出同一地址的最近邮件。
// 点击项目可原地加载。
async function _toggleFromSenderPanel(reader, data, btn) {
  const body = reader.querySelector('.email-reader-body');
  if (!body) return;

  // 在模态框大小改变后重新居中（CSS 在 from-sender 面板挂载/卸载时放宽 + 增高
  // modal-content）。否则模态框只向右/下增长，在窄/短窗口上会溢出视口。
  const _recenterModal = () => {
    const modal = document.getElementById('email-lib-modal');
    const content = modal?.querySelector('.modal-content');
    if (!content) return;
    requestAnimationFrame(() => {
      const w = content.offsetWidth;
      const h = content.offsetHeight;
      const newLeft = Math.max(20, (window.innerWidth - w) / 2);
      const newTop  = Math.max(20, (window.innerHeight - h) / 2);
      content.style.left = newLeft + 'px';
      content.style.top  = newTop + 'px';
    });
  };

  // 已打开？关闭它。
  const existing = reader.querySelector('.from-sender-panel');
  if (existing) {
    existing.remove();
    reader.classList.remove('from-sender-open');
    if (btn) btn.classList.remove('active');
    _recenterModal();
    return;
  }

  const fromAddr = String(data.from_address || '').trim();
  if (!fromAddr) {
    if (typeof showError === 'function') showError('No sender address available');
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'from-sender-panel';
  const displayName = (data.from_name && data.from_name.trim()) || fromAddr;
  const firstName = displayName.split(' ')[0] || displayName;
  panel.innerHTML = `
    <div class="from-sender-header">
      <span class="from-sender-chips"></span>
      <span class="from-sender-header-empty" hidden>All senders</span>
      <button type="button" class="from-sender-toggle" data-toggle="attachments" title="Show only emails with attachments" aria-pressed="false">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
      </button>
      <button type="button" class="from-sender-close" title="Close" aria-label="Close sender panel">&times;</button>
    </div>
    <div class="from-sender-search-wrap">
      <input type="text" class="from-sender-search" placeholder="Search ${_esc(firstName)}…" autocomplete="off" />
      <div class="from-sender-suggest" hidden></div>
    </div>
    <div class="from-sender-list">
      <div class="from-sender-loading"></div>
    </div>
  `;
  reader.appendChild(panel);
  reader.classList.add('from-sender-open');
  if (btn) btn.classList.add('active');
  _recenterModal();

  // 头部关闭 — 与工具栏漏斗按钮相同，因此关闭路径保持单一来源
  //（面板移除 + 激活类删除）。
  const headerClose = panel.querySelector('.from-sender-close');
  if (headerClose) {
    headerClose.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const toolbarBtn = reader.querySelector('[data-act="from-sender"]');
      if (toolbarBtn) toolbarBtn.click();
      else { panel.remove(); reader.classList.remove('from-sender-open'); }
    });
  }

  const listEl = panel.querySelector('.from-sender-list');
  // 提升以便 panel._originalEmails（稍后赋值，在 try 外部）可以看到它。
  let emails = [];

  // 多标签模型 — 头部现在是 {name, address} 芯片列表。
  // 过滤逻辑：当每个标签的地址都出现在 from/to/cc 中（在连接的头部字符串上
  // 进行不区分大小写的子串匹配）时，邮件匹配。
  panel._tags = [{ name: displayName, address: fromAddr }];
  panel._attachmentsOnly = false;
  const searchEl = panel.querySelector('.from-sender-search');
  const chipsContainer = panel.querySelector('.from-sender-chips');
  const emptyLabel = panel.querySelector('.from-sender-header-empty');
  const suggestEl = panel.querySelector('.from-sender-suggest');
  const attToggle = panel.querySelector('[data-toggle="attachments"]');

  const _renderChips = () => {
    chipsContainer.innerHTML = panel._tags.map((t, i) => `
      <span class="from-sender-chip" title="${_esc(t.address)}" data-tag-index="${i}">
        <span class="from-sender-chip-name">${_esc(t.name || t.address)}</span>
        <button class="from-sender-chip-x" type="button" title="Remove" aria-label="Remove ${_esc(t.name || t.address)}">&times;</button>
      </span>
    `).join('');
    if (emptyLabel) emptyLabel.hidden = panel._tags.length > 0;
    chipsContainer.querySelectorAll('.from-sender-chip-x').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const idx = Number(btn.closest('.from-sender-chip')?.dataset.tagIndex || -1);
        if (idx < 0) return;
        panel._tags.splice(idx, 1);
        _renderChips();
        _refreshList();
      });
    });
  };
  // 按每个活动标签过滤已加载的邮件（或最近邮件）。
  const _matchesTags = (em) => {
    if (!panel._tags.length) return true;
    const haystack = [
      String(em.from_address || ''),
      String(em.to || ''),
      String(em.cc || ''),
    ].join(' ').toLowerCase();
    return panel._tags.every(t => haystack.includes(String(t.address || '').toLowerCase()));
  };
  const _applyToggles = () => {
    const base = panel._lastResults || [];
    let view = base.filter(_matchesTags);
    if (panel._attachmentsOnly) view = view.filter(e => e.has_attachments);
    if (!view.length) {
      const why = panel._attachmentsOnly
        ? 'No emails with attachments in this view.'
        : (panel._tags.length > 1 ? 'No emails involve all those people.' : 'No matches.');
      listEl.innerHTML = `<div class="from-sender-empty">${why}</div>`;
    } else {
      _renderFromSenderRows(view, listEl, reader, { showFolder: !!panel._lastShowFolder });
    }
  };
  panel._setResults = (rows, opts = {}) => {
    panel._lastResults = rows || [];
    panel._lastShowFolder = !!opts.showFolder;
    _applyToggles();
  };
  // 重新运行当前标签集/查询的相应获取路径。
  // 提前声明以便上面的芯片移除处理程序可以调用它。
  let _refreshList = () => {};
  if (attToggle) {
    attToggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      panel._attachmentsOnly = !panel._attachmentsOnly;
      attToggle.classList.toggle('is-active', panel._attachmentsOnly);
      attToggle.setAttribute('aria-pressed', panel._attachmentsOnly ? 'true' : 'false');
      _applyToggles();
    });
  }

  try {
    const sp = spinnerModule.createWhirlpool(20);
    const loading = panel.querySelector('.from-sender-loading');
    loading.appendChild(sp.element);

    const params = new URLSearchParams({
      q: fromAddr,
      folder: state._libFolder || 'INBOX',
      limit: '25',
    });
    const acct = _acct();
    const acctSuffix = acct ? acct.replace(/^&?/, '&') : '';
    const res = await fetch(`${API_BASE}/api/email/search?${params.toString()}${acctSuffix}`);
    const j = await res.json();
    let raw = Array.isArray(j.emails) ? j.emails : [];
    const target = fromAddr.toLowerCase();
    raw = raw.filter(e => String(e.from_address || '').toLowerCase() === target);
    raw = raw.filter(e => String(e.uid) !== String(data.uid));
    emails = raw;

    if (!emails.length) {
      listEl.innerHTML = `<div class="from-sender-empty">${t('email.no_other_emails', { folder: _esc(state._libFolder || 'INBOX') })}</div>`;
    } else {
      panel._setResults(emails, { showFolder: false });
    }
  } catch (err) {
    listEl.innerHTML = `<div class="from-sender-empty" style="color:var(--red, #e55)">Failed to load: ${_esc(String(err))}</div>`;
  }
  const updatePlaceholder = () => {
    if (!searchEl) return;
    searchEl.placeholder = panel._tags.length
      ? 'Add another person…'
      : 'Search people or emails…';
  };
  updatePlaceholder();
  _renderChips();

  // 当芯片变化以及用户清除查询时都使用。
  // 拉取跨常见文件夹的最新邮件，以便用户着陆到有用的内容，
  // 然后 _applyToggles 按标签缩小范围。
  let _recentToken = 0;
  const _loadRecentAcross = async () => {
    const myToken = ++_recentToken;
    const folders = _crossFolderCandidates();
    const acct = _acct();
    const acctSuffix = acct ? acct.replace(/^&?/, '&') : '';
    listEl.innerHTML = `<div class="from-sender-loading"></div>`;
    try {
      const sp = spinnerModule.createWhirlpool(18);
      listEl.querySelector('.from-sender-loading')?.appendChild(sp.element);
      const results = await Promise.all(folders.map(async (f) => {
        const params = new URLSearchParams({ folder: f, limit: '40', offset: '0', filter: 'all' });
        const res = await fetch(`${API_BASE}/api/email/list?${params.toString()}${acctSuffix}`);
        const j = await res.json();
        return (j.emails || []).map(em => ({ ...em, _folder: f }));
      }));
      if (myToken !== _recentToken) return;
      let merged = [].concat(...results);
      merged.sort((a, b) => {
        const da = a.date ? Date.parse(a.date) : 0;
        const db = b.date ? Date.parse(b.date) : 0;
        return db - da;
      });
      // 预先取更宽的切片；标签/附件过滤器会进一步修剪。
      merged = merged.slice(0, 80);
      panel._setResults(merged, { showFolder: true });
      updatePlaceholder();
    } catch (err) {
      if (myToken !== _recentToken) return;
      listEl.innerHTML = `<div class="from-sender-empty" style="color:var(--red, #e55)">Failed to load: ${_esc(String(err))}</div>`;
    }
  };

  // 添加联系人作为标签，清除输入，刷新列表。
  const _addTag = (contact) => {
    if (!contact || !contact.address) return;
    const addr = String(contact.address).toLowerCase();
    if (panel._tags.some(t => String(t.address).toLowerCase() === addr)) return;
    panel._tags.push({ name: contact.name || contact.address, address: contact.address });
    _renderChips();
    if (searchEl) { searchEl.value = ''; }
    if (suggestEl) { suggestEl.hidden = true; suggestEl.innerHTML = ''; }
    updatePlaceholder();
    _refreshList();
  };

  // 跨文件夹搜索 — 当用户输入时，如果发件人芯片仍然活跃，也尊重它。
  // 芯片活跃时的空输入恢复原始的"此发件人邮件"视图；
  // 芯片被移除时的空输入显示提示。
  if (searchEl) {
    let searchToken = 0;
    let debounceTimer = null;
    let suggestToken = 0;
    let highlightedIdx = -1;

    // 跨文件夹的自由文本邮件搜索。标签过滤通过
    // panel._setResults 中的 _applyToggles 应用。
    const runSearch = async (q) => {
      const myToken = ++searchToken;
      const folders = _crossFolderCandidates();
      const acct = _acct();
      const acctSuffix = acct ? acct.replace(/^&?/, '&') : '';
      try {
        const results = await Promise.all(folders.map(async (f) => {
          const params = new URLSearchParams({ q, folder: f, limit: '15' });
          const res = await fetch(`${API_BASE}/api/email/search?${params.toString()}${acctSuffix}`);
          const j = await res.json();
          return (j.emails || []).map(em => ({ ...em, _folder: f }));
        }));
        if (myToken !== searchToken) return;
        let merged = [].concat(...results);
        merged.sort((a, b) => {
          const da = a.date ? Date.parse(a.date) : 0;
          const db = b.date ? Date.parse(b.date) : 0;
          return db - da;
        });
        if (!merged.length) {
          listEl.innerHTML = `<div class="from-sender-empty">No matches for "${_esc(q)}".</div>`;
          return;
        }
        panel._setResults(merged, { showFolder: true });
      } catch (err) {
        if (myToken !== searchToken) return;
        listEl.innerHTML = `<div class="from-sender-empty" style="color:var(--red, #e55)">Search failed: ${_esc(String(err))}</div>`;
      }
    };

    // 连接 _refreshList 以便芯片移除/标签添加可以重新运行匹配
    // 当前输入状态的路径。
    _refreshList = () => {
      const q = (searchEl.value || '').trim();
      if (q.length >= 2) runSearch(q);
      else _loadRecentAcross();
    };

    // 联系人建议 — 从 /api/email/contacts 获取。在输入框下方渲染
    // 一个小的绝对定位下拉菜单。上/下/回车/ESC 键在下面的
    // keydown 监听器中处理。
    const _renderSuggestions = (items) => {
      if (!suggestEl) return;
      if (!items || !items.length) {
        suggestEl.hidden = true;
        suggestEl.innerHTML = '';
        highlightedIdx = -1;
        return;
      }
      highlightedIdx = 0;
      suggestEl.innerHTML = items.map((c, i) => `
        <div class="from-sender-suggest-item${i === 0 ? ' active' : ''}" data-idx="${i}" data-addr="${_esc(c.address)}" data-name="${_esc(c.name || c.address)}">
          <span class="suggest-name">${_esc(c.name || c.address)}</span>
          <span class="suggest-addr">${_esc(c.address)}</span>
        </div>
      `).join('');
      suggestEl.hidden = false;
      suggestEl.querySelectorAll('.from-sender-suggest-item').forEach(item => {
        item.addEventListener('mouseenter', () => {
          suggestEl.querySelectorAll('.from-sender-suggest-item').forEach(n => n.classList.remove('active'));
          item.classList.add('active');
          highlightedIdx = Number(item.dataset.idx);
        });
        item.addEventListener('mousedown', (ev) => {
          // mousedown 以便我们在 blur 夺走焦点之前添加芯片
          ev.preventDefault();
          _addTag({ name: item.dataset.name, address: item.dataset.addr });
        });
      });
    };
    const _fetchSuggestions = async (q) => {
      const myToken = ++suggestToken;
      try {
        // 使用与电子邮件撰写器 To/Cc 字段相同的联系人源
        // (/api/contacts/search → {results: [{name, emails:[...]}]})。
        // 展平为 {name, address} 对并删除任何已标记的地址。
        const res = await fetch(`${API_BASE}/api/contacts/search?q=${encodeURIComponent(q)}`);
        const j = await res.json();
        if (myToken !== suggestToken) return;
        const tagged = new Set(panel._tags.map(t => String(t.address).toLowerCase()));
        const items = [];
        for (const c of (j.results || [])) {
          for (const addr of (c.emails || [])) {
            if (tagged.has(String(addr).toLowerCase())) continue;
            items.push({ name: c.name || addr, address: addr });
            if (items.length >= 8) break;
          }
          if (items.length >= 8) break;
        }
        _renderSuggestions(items);
      } catch {}
    };

    searchEl.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const q = searchEl.value.trim();
      if (q.length < 2) {
        searchToken++;
        suggestToken++;
        if (suggestEl) { suggestEl.hidden = true; suggestEl.innerHTML = ''; }
        _loadRecentAcross();
        return;
      }
      // 立即触发建议（廉价的 SQL）并延迟邮件搜索。
      _fetchSuggestions(q);
      debounceTimer = setTimeout(() => runSearch(q), 220);
    });

    searchEl.addEventListener('keydown', (ev) => {
      const items = suggestEl && !suggestEl.hidden
        ? [...suggestEl.querySelectorAll('.from-sender-suggest-item')]
        : [];
      if (ev.key === 'ArrowDown' && items.length) {
        ev.preventDefault();
        highlightedIdx = (highlightedIdx + 1) % items.length;
        items.forEach((n, i) => n.classList.toggle('active', i === highlightedIdx));
      } else if (ev.key === 'ArrowUp' && items.length) {
        ev.preventDefault();
        highlightedIdx = (highlightedIdx - 1 + items.length) % items.length;
        items.forEach((n, i) => n.classList.toggle('active', i === highlightedIdx));
      } else if (ev.key === 'Enter') {
        if (items.length && highlightedIdx >= 0) {
          ev.preventDefault();
          const item = items[highlightedIdx];
          _addTag({ name: item.dataset.name, address: item.dataset.addr });
        }
      } else if (ev.key === 'Escape') {
        if (suggestEl && !suggestEl.hidden) {
          ev.preventDefault();
          suggestEl.hidden = true;
        }
      } else if (ev.key === 'Backspace' && searchEl.value === '' && panel._tags.length) {
        // 空输入 + 退格键弹出最右边的芯片 — 常见的芯片输入习惯。
        ev.preventDefault();
        panel._tags.pop();
        _renderChips();
        _refreshList();
      }
    });

    searchEl.addEventListener('blur', () => {
      // 在 blur 时隐藏建议，带有微小延迟以便点击建议有机会触发
      //（mousedown-add 在大多数情况下已涵盖）。
      setTimeout(() => { if (suggestEl) suggestEl.hidden = true; }, 120);
    });
  }
  // 存储发件人的邮件，以便在搜索被清除后恢复。
  panel._originalEmails = (typeof emails !== 'undefined') ? emails : [];
}

const _ATT_ICON = '<svg class="from-sender-att" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Has attachments"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

function _renderFromSenderRows(emails, listEl, reader, opts = {}) {
  const { showFolder = false } = opts;
  listEl.innerHTML = emails.map(em => {
    const subj = em.subject || '(no subject)';
    const date = em.date ? new Date(em.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : (em.date_display || '');
    const unread = em.is_read ? '' : ' from-sender-unread';
    const att = em.has_attachments ? _ATT_ICON : '';
    const folder = em._folder || state._libFolder || 'INBOX';
    const folderChip = showFolder ? `<span class="from-sender-folder">${_esc(folder)}</span>` : '';
    return `<div class="from-sender-row${unread}" data-uid="${_esc(em.uid)}" data-folder="${_esc(folder)}">
      <button class="from-sender-row-main" type="button">
        <span class="from-sender-row-top">
          <span class="from-sender-subj">${_esc(subj)}</span>
          ${att}
        </span>
        <span class="from-sender-row-bottom">
          <span class="from-sender-date">${_esc(date)}</span>
          ${folderChip}
        </span>
      </button>
      <button class="from-sender-row-more" type="button" title="More actions" aria-label="More actions">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
      </button>
    </div>`;
  }).join('');
  listEl.querySelectorAll('.from-sender-row').forEach(row => {
    const main = row.querySelector('.from-sender-row-main');
    const more = row.querySelector('.from-sender-row-more');
    main?.addEventListener('click', async () => {
      const uid = row.dataset.uid;
      const folder = row.dataset.folder || state._libFolder;
      if (!uid) return;
      await _swapReaderToUid(reader, uid, folder);
    });
    more?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const uid = row.dataset.uid;
      const folder = row.dataset.folder || state._libFolder;
      if (!uid) return;
      // 在我们知道的任何缓存中查找行的邮件；菜单仅需要
      // uid + subject + folder 来进行操作。
      const em = (typeof emails !== 'undefined' ? emails : []).find(e => String(e.uid) === String(uid))
        || state._libEmails.find(e => String(e.uid) === String(uid))
        || { uid, subject: row.querySelector('.from-sender-subj')?.textContent || '' };
      const card = reader.closest('.doclib-card');
      if (card) _showReaderMoreMenu(em, card, reader, more);
    });
  });
}

// 为阅读器内的附件芯片 + "在编辑器中打开"子按钮连接点击处理程序。
// 可以安全地多次调用 — 使用 dataset.wired 标志跳过已有监听器的节点。
function _wireAttachmentHandlers(reader, folder) {
  const useFolder = folder || state._libFolder;
  // 在此处检测移动端，以便当从没有 _isMobileUA 作用域的上下文
  //（如 _openEmailAsTab、_openEmailWindow）调用此函数时，
  // 附件芯片处理程序不会因 ReferenceError 而崩溃。
  const _isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  reader.querySelectorAll('.email-attachment-open').forEach(openBtn => {
    if (openBtn.dataset.wired === '1') return;
    openBtn.dataset.wired = '1';
    openBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const uid = openBtn.dataset.openUid;
      const index = openBtn.dataset.openIndex;
      const name = openBtn.dataset.openName || `attachment-${index}`;
      if (!uid || index == null) return;
      const orig = openBtn.style.opacity;
      openBtn.style.opacity = '0.4';
      try {
        const folderQs = encodeURIComponent(useFolder);
        const res = await fetch(
          `${API_BASE}/api/email/attachment-as-doc/${encodeURIComponent(uid)}/${encodeURIComponent(index)}?folder=${folderQs}${_acct()}`,
          { method: 'POST', credentials: 'same-origin' }
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.doc_id) {
          const msg = (json && json.error) || `HTTP ${res.status}`;
          try { const { showError } = await import('./ui.js'); showError(`Couldn't open ${name}: ${msg}`); } catch (_) { alert(`Couldn't open ${name}: ${msg}`); }
          return;
        }
        try {
          // 仅在视口无法同时容纳邮件和文档窗格时收起邮件模态框。
          // 桌面端有空间时保持并排布局；移动端仍将屏幕交给文档。
          const ownerModal = openBtn.closest('.modal');
          if (ownerModal && ownerModal.id && _prepareEmailWindowForDocument(ownerModal)) {
            try {
              const ok = Modals.minimize(ownerModal.id);
              if (!ok) ownerModal.classList.add('hidden');
            } catch (_) {
              ownerModal.classList.add('hidden');
            }
          }
          const docMod = await import('./document.js');
          const load = (docMod && docMod.loadDocument) || (docMod && docMod.default && docMod.default.loadDocument);
          if (typeof load === 'function') {
            await load(json.doc_id);
          } else {
            location.href = `/?doc=${encodeURIComponent(json.doc_id)}`;
          }
        } catch (e) {
          console.error('Open document failed:', e);
          try { const { showError } = await import('./ui.js'); showError('Document opened but panel could not mount'); } catch (_) {}
        }
      } catch (e) {
        console.error('attachment-as-doc error', e);
        try { const { showError } = await import('./ui.js'); showError(`Couldn't open ${name}`); } catch (_) {}
      } finally {
        openBtn.style.opacity = orig;
      }
    });
  });

  reader.querySelectorAll('.email-attachment-chip').forEach(chip => {
    if (chip.dataset.wired === '1') return;
    chip.dataset.wired = '1';
    chip.addEventListener('click', async (ev) => {
      if (ev.target.closest('.email-attachment-open')) return;
      ev.stopPropagation();
      ev.preventDefault();
      const uid = chip.dataset.attUid;
      const index = chip.dataset.attIndex;
      const name = chip.dataset.attName || `attachment-${index}`;
      if (!uid || index == null) return;
      const url = `${API_BASE}/api/email/attachment/${encodeURIComponent(uid)}/${encodeURIComponent(index)}?folder=${encodeURIComponent(useFolder)}${_acct()}`;
      if (_isMobileUA) {
        window.open(url, '_blank');
        return;
      }
      const orig = chip.style.opacity;
      chip.style.opacity = '0.6';
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) {
          console.error('attachment download failed', res.status, await res.text().catch(() => ''));
          location.href = url;
          return;
        }
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      } catch (e) {
        console.error('attachment download error', e);
        location.href = url;
      } finally {
        chip.style.opacity = orig;
      }
    });
  });
}

// 启发式：跳过明显是签名/引用回复头部使用的内联图片的"附件"
//（小图片文件、Outlook 风格的 image001.png 占位符、logo*.png 等）。
// 它们不是真正的用户共享附件，将它们添加到芯片中会让每封邮件
// 看起来像有需要用户处理的内容。
function _isLikelySignatureImage(a) {
  if (!a || !a.filename) return false;
  const name = String(a.filename).toLowerCase();
  const isImage = /\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(name);
  if (!isImage) return false;
  const size = Number(a.size) || 0;
  // Outlook / Gmail 内联图片占位符总是看起来像这样。
  if (/^image\d{3,}\.(png|jpe?g|gif)$/i.test(name)) return true;
  if (/^(signature|logo|sig|footer|banner)[-_\d]*\.(png|jpe?g|gif|svg)$/i.test(name)) return true;
  // 大多数签名 logo / 内联缩略图 < 30 KB。真正的用户共享图片
  //（截图、照片）通常是 50 KB+。
  if (size > 0 && size < 30 * 1024) return true;
  return false;
}

// 为邮件读取响应构建附件头部+芯片 HTML。提取出来以便初始打开
// 和交换阅读器路径都可以渲染它。
function _buildAttsHtmlFor(uid, data) {
  if (!data || !data.attachments || !data.attachments.length) return '';
  const _OPENABLE_RE = /\.(pdf|docx|txt|md|markdown)$/i;
  const visible = data.attachments.filter(a => !_isLikelySignatureImage(a));
  if (!visible.length) return '';
  const chips = visible.map(a => {
    const openable = _OPENABLE_RE.test(a.filename || '');
    const openBtn = openable
      ? `<span class="email-attachment-open" title="Open in document editor" data-open-uid="${_esc(uid)}" data-open-index="${a.index}" data-open-name="${_esc(a.filename)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/><line x1="8" y1="9" x2="10" y2="9"/></svg><span class="email-attachment-open-label">Open</span></span>`
      : '';
    return `<button type="button" class="email-attachment-chip" data-att-uid="${_esc(uid)}" data-att-index="${a.index}" data-att-name="${_esc(a.filename)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg><span>${_esc(a.filename)}</span><span class="att-size">${Math.round((a.size||0)/1024)} KB</span>${openBtn}</button>`;
  }).join('');
  return (
    '<div class="email-reader-atts-wrap collapsed">'
    +   '<div class="email-reader-atts-header email-summary-toggle" role="button" tabindex="0">'
    +     '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>'
    +     `<span>Attachments (${data.attachments.length})</span>`
    +     '<svg class="email-summary-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;transition:transform .15s ease;"><polyline points="6 9 12 15 18 9"/></svg>'
    +   '</div>'
    +   '<div class="email-reader-atts">' + chips + '</div>'
    + '</div>'
  );
}

// "在新标签页中打开" — 邮件在库中打开（内联展开）
// 并创建一个单独的浮动"邮件查看器"覆盖模态框。覆盖层以
// 停靠栏中最小化芯片的形式启动；点击芯片将查看器调出到库之上。
// 多个标签页 = 多个覆盖模态框 + 芯片，每个独立。
const _EMAIL_ICON_PATH = 'M2 4h20v16H2zM22 7l-9.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7';
let _emailTabSeq = 0;
// 每个阅读器 modalId 的持久槽位号。一旦阅读器是"标签页 2"，
// 它将保持"标签页 2"直到关闭 — 即使标签页 1 先关闭，剩余的
// 阅读器也不会重新编号为 1。新标签页占用最小的未使用槽位。
const _emailReaderSlots = new Map(); // modalId -> 槽位 (1, 2, 3, ...)
function _allocReaderSlot(modalId) {
  if (_emailReaderSlots.has(modalId)) return _emailReaderSlots.get(modalId);
  const used = new Set(_emailReaderSlots.values());
  let n = 1;
  while (used.has(n)) n++;
  _emailReaderSlots.set(modalId, n);
  return n;
}
function _freeReaderSlot(modalId) {
  _emailReaderSlots.delete(modalId);
}

// JS 驱动的门：在 <body> 上设置 [data-email-tabs="N"]，以便 CSS 可以
// 仅在 2+ 标签页存在时显示每个芯片的数字徽章。
function _syncEmailTabsCount() {
  const tabs = document.querySelectorAll('.minimized-dock-chip[data-modal-id^="email-view-"]');
  document.body.dataset.emailTabs = String(tabs.length);
}

// 每当停靠栏内容变化时重新计算邮件菜单芯片的标签页计数。
// 统计 #minimized-dock 内部和 body 级别（移动端自由定位芯片）的
// "email-view-*" 芯片。结果写入 email-lib-modal 芯片的
// data-tab-count 属性；CSS 通过 attr() 读取以渲染徽章。
function _syncEmailTabBadge() {
  const readers = document.querySelectorAll('.minimized-dock-chip[data-modal-id^="email-reader-"]');
  document.body.dataset.emailReaders = String(readers.length);
  // 为每个芯片标记其持久槽位号。CSS 通过 attr() 读取
  // data-tab-num 而不是使用计数器，这样当其他标签页关闭时
  // 数字保持稳定。
  readers.forEach(chip => {
    const slot = _emailReaderSlots.get(chip.dataset.modalId);
    if (slot) chip.dataset.tabNum = String(slot);
  });
}
let _emailTabObserverWired = false;
let _badgeSyncScheduled = false;
function _ensureEmailTabObserver() {
  if (_emailTabObserverWired) return;
  _emailTabObserverWired = true;
  // 防抖，使一次突变爆发（如 _renderDock 在一次遍历中重建整个停靠栏）
  // 合并为每个动画帧的单个同步。否则芯片徽章可能会在停靠栏重渲染期间
  // 观察者重复触发时闪烁。
  const handler = () => {
    if (_badgeSyncScheduled) return;
    _badgeSyncScheduled = true;
    requestAnimationFrame(() => {
      _badgeSyncScheduled = false;
      _syncEmailTabBadge();
    });
  };
  const tryWire = () => {
    const dock = document.getElementById('minimized-dock');
    if (!dock) { setTimeout(tryWire, 200); return; }
    // 只关注我们关心的：停靠栏中的芯片添加/移除。
    const obs = new MutationObserver(handler);
    obs.observe(dock, { childList: true });
    // 监听库网格，以便卡片展开/折叠的切换实时更新库芯片的
    // "has-expanded" 徽章。
    const wireGridObs = () => {
      const grid = document.getElementById('email-lib-grid');
      if (!grid) { setTimeout(wireGridObs, 500); return; }
      const gridObs = new MutationObserver(handler);
      gridObs.observe(grid, { subtree: true, attributes: true, attributeFilter: ['class'] });
    };
    wireGridObs();
    handler();
  };
  tryWire();
}
// 混合模型：
//   - email-lib-modal（收件箱库）是唯一的。其芯片仅恢复它。
//   - 每个"在新标签页中打开"创建一个单独的每邮件阅读器模态框
//     （id "email-reader-{uid}-{seq}"），具有与库内联阅读器相同的
//     结构和类，因此它们看起来相同。每个阅读器注册自己的停靠栏芯片
//     并带有数字徽章。
async function _openEmailAsTab(em, folder) {
  const useFolder = folder || state._libFolder || 'INBOX';
  _emailTabSeq += 1;
  const modalId = `email-reader-${em.uid}-${_emailTabSeq}`;
  _allocReaderSlot(modalId);

  // 构建模态框外壳。使用与邮件库相同的 doclib-modal-content 尺寸，
  // 使其感觉像是兄弟窗口。内部的阅读器主体使用内联阅读器完全相同的
  // email-card-reader / email-reader-* 类 → 样式相同。
  const modal = document.createElement('div');
  modal.className = 'modal email-reader-tab-modal';
  modal.id = modalId;
  modal.innerHTML = `
    <div class="modal-content doclib-modal-content email-reader-tab-content" style="background:var(--bg);width:min(720px, 92vw);max-height:85vh;display:flex;flex-direction:column;">
      <div class="modal-header">
        <h4 style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:8px;">${_esc(em.subject || '(no subject)')}</span>
        </h4>
        <button class="minimize-btn" type="button" title="Minimize">_</button>
        <button class="close-btn" type="button" title="Close">&#x2716;</button>
      </div>
      <div class="modal-body email-reader-tab-body" style="display:flex;flex-direction:column;overflow:hidden;flex:1;min-height:0;padding:0;">
        <div class="email-card-reader email-card-expanded" style="flex:1;min-height:0;display:flex;flex-direction:column;">
          <div class="email-reader-tab-loading" style="padding:24px;display:flex;justify-content:center;"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  // 继承 .modal 的显示（flex-center）。z-index 高于库
  //（库使用默认 .modal z-index 250），以便新标签页位于顶部。
  modal.style.zIndex = '270';
  // 最后打开 → 邮件窗口在已打开文档之前（交替标志）。
  document.body.classList.add('email-front');

  Modals.register(modalId, {
    label: 'Email',
    icon: _EMAIL_ICON_PATH,
    closeFn: () => {
      modal.remove();
      _freeReaderSlot(modalId);
      Promise.resolve().then(_syncEmailTabBadge);
    },
    restoreFn: () => {
      // 最后重新打开 → 将邮件窗口置于任何已打开文档之前。
      document.body.classList.add('email-front');
      // 移动端：一次只有一个邮件窗口可见。点击此芯片
      // 收起库 + 任何其他阅读器，这样用户通过停靠栏在它们之间切换
      // 而不是堆叠。
      if (window.innerWidth <= 768) {
        try {
          if (Modals.isRegistered('email-lib-modal') && !Modals.isMinimized('email-lib-modal')) {
            Modals.minimize('email-lib-modal');
          }
        } catch {}
        document.querySelectorAll('.modal[id^="email-reader-"]').forEach(other => {
          if (other.id === modalId) return;
          try {
            if (Modals.isRegistered(other.id) && !Modals.isMinimized(other.id)) {
              Modals.minimize(other.id);
            }
          } catch {}
        });
      }
    },
  });
  // 通过 modalManager 连接 `_` 最小化按钮（它看到我们的 .minimize-btn
  // 已经存在，只需绑定点击处理程序）。
  try { Modals.injectMinimizeButton(modal, modalId); } catch {}
  // X 按钮完全关闭标签页（拆卸并取消注册）。
  modal.querySelector('.close-btn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    Modals.close(modalId);
  });

  // 在 header 上接线拖拽（仅桌面端）。匹配 app.js initUIVisibility 中的
  // 全局模式，但那只在启动时运行一次，看不到动态创建的模态框 —
  // 因此我们在此复制它。
  const content = modal.querySelector('.modal-content');
  const mh = modal.querySelector('.modal-header');
  if (mh && content) {
    let dragX = 0, dragY = 0, startLeft = 0, startTop = 0, dragging = false;
    const startDrag = (clientX, clientY) => {
      dragging = true;
      const rect = content.getBoundingClientRect();
      dragX = clientX; dragY = clientY;
      startLeft = rect.left; startTop = rect.top;
      content.style.position = 'fixed';
      content.style.left = startLeft + 'px';
      content.style.top = startTop + 'px';
      content.style.margin = '0';
    };
    const onDrag = (e) => {
      if (!dragging) return;
      content.style.left = (startLeft + e.clientX - dragX) + 'px';
      content.style.top = (startTop + e.clientY - dragY) + 'px';
    };
    const stopDrag = () => {
      dragging = false;
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', stopDrag);
    };
    mh.addEventListener('mousedown', (e) => {
      if (e.target.closest('.close-btn, .minimize-btn, .modal-minimize-btn')) return;
      e.preventDefault();
      startDrag(e.clientX, e.clientY);
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', stopDrag);
    });
  }

  // 在前面打开新标签页，位于邮件库之上。用户可以点击 `_`
  // 将其收起为芯片，阅读完成后使用。
  //
  // 移动端：底部面板窗口填满视口，因此堆叠多个阅读器
  // 会令人困惑 — 一次只有一个窗口可以有意义地可见。因此当新标签页
  // 打开时，收起库和任何其他当前打开的 email-reader-* 标签页。
  // 用户获得一组迷你芯片来在它们之间切换。
  if (window.innerWidth <= 768) {
    try {
      if (Modals.isRegistered('email-lib-modal') && !Modals.isMinimized('email-lib-modal')) {
        Modals.minimize('email-lib-modal');
      }
    } catch {}
    document.querySelectorAll('.modal[id^="email-reader-"]').forEach(other => {
      if (other.id === modalId) return;
      try {
        if (Modals.isRegistered(other.id) && !Modals.isMinimized(other.id)) {
          Modals.minimize(other.id);
        }
      } catch {}
    });
  }
  _ensureEmailTabObserver();
  _syncEmailTabBadge();

  // 使用与 _toggleCardPreview 完全相同的模板获取 + 渲染邮件正文，
  // 使视觉效果完全匹配。
  const reader = modal.querySelector('.email-card-reader');
  _markEmailReaderActive(reader);
  const sp = spinnerModule.createWhirlpool(28);
  const loading = modal.querySelector('.email-reader-tab-loading');
  if (loading) loading.appendChild(sp.element);
  try {
    const res = await fetch(`${API_BASE}/api/email/read/${em.uid}?folder=${encodeURIComponent(useFolder)}${_acct()}`);
    const data = await res.json();
    if (data.error) {
      reader.innerHTML = `<div style="padding:20px;color:var(--red,#e55)">Error: ${_esc(data.error)}</div>`;
      return;
    }
    _syncEmailReadState(em.uid, true);
    const buildChips = (str) => {
      if (!str) return '';
      return _splitRecipientList(str).map(a => {
        const name = _extractName(a);
        return _recipientChipHtml(a, name);
      }).join('');
    };
    const fromChip = _recipientChipHtml(`${data.from_name || ''} <${data.from_address || ''}>`, data.from_name || data.from_address, 'from-chip');
    let attsHtml = '';
    try { attsHtml = _buildAttsHtmlFor(em.uid, data); } catch {}
    reader.innerHTML = `
      <div class="email-reader-header">
        <div class="email-reader-meta">
          <div class="email-reader-meta-row"><strong>From:</strong><span class="recipient-chips">${fromChip}</span></div>
          ${data.to ? `<div class="email-reader-meta-row"><strong>To:</strong><span class="recipient-chips">${buildChips(data.to)}</span></div>` : ''}
          ${data.cc ? `<div class="email-reader-meta-row"><strong>Cc:</strong><span class="recipient-chips">${buildChips(data.cc)}</span></div>` : ''}
        </div>
        <div class="email-reader-actions">
          <div class="email-reader-actions-row email-reader-actions-row-primary">
            <button class="memory-toolbar-btn reader-icon-btn" data-act="reply" title="Reply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg><span class="reader-btn-label">Reply</span></button>
            ${_hasMultipleRecipients(data) ? `<button class="memory-toolbar-btn reader-icon-btn" data-act="reply-all" title="Reply All"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/></svg><span class="reader-btn-label">Reply all</span></button>` : ''}
            <button class="memory-toolbar-btn reader-icon-btn" data-act="forward" title="Forward"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg><span class="reader-btn-label">Forward</span></button>
          </div>
          <div class="email-reader-actions-row email-reader-actions-row-secondary">
            <button class="memory-toolbar-btn reader-icon-btn" data-act="ai-reply" title="${data.cached_ai_reply ? 'AI Reply (cached draft ready)' : 'AI Reply'}">${_aiReplyIcon(data)}<span class="reader-btn-label">AI reply</span></button>
            <button class="memory-toolbar-btn reader-icon-btn" data-act="summarize" title="Summarize">${_summaryIcon(data)}<span class="reader-btn-label">Summary</span></button>
            <button class="memory-toolbar-btn reader-icon-btn" data-act="from-sender" title="Search text in this thread"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span class="reader-btn-label">Search</span></button>
            <div class="email-reader-more-wrap" style="position:relative">
              <button class="memory-toolbar-btn reader-icon-btn" data-act="more" title="More actions"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg><span class="reader-btn-label">More</span></button>
            </div>
          </div>
        </div>
      </div>
      ${attsHtml}
      <div class="email-reader-body${data.body_html ? ' html-body' : ''}">${_safeRenderEmailBody(data)}</div>
    `;
    _markEmailReaderActive(reader);
    _wireRecipientChips(reader);
    try { _wireAttachmentHandlers(reader, useFolder); } catch {}
    const attsWrap = reader.querySelector('.email-reader-atts-wrap');
    if (attsWrap) {
      const attsToggle = attsWrap.querySelector('.email-reader-atts-header');
      if (attsToggle) attsToggle.addEventListener('click', (ev) => { ev.stopPropagation(); attsWrap.classList.toggle('collapsed'); });
    }
    reader.querySelector('[data-act="reply"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      _snapEmailModalToLeftSidebar(ev.currentTarget.closest('.modal'));
      if (state._onEmailClick) await state._onEmailClick({ email: em, emailData: data, mode: 'reply' });
    });
    reader.querySelector('[data-act="reply-all"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      _snapEmailModalToLeftSidebar(ev.currentTarget.closest('.modal'));
      if (state._onEmailClick) await state._onEmailClick({ email: em, emailData: data, mode: 'reply-all' });
    });
    reader.querySelector('[data-act="ai-reply"]')?.addEventListener('click', (ev) => _handleAiReplyButton(ev, em, data));
    reader.querySelector('[data-act="forward"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (state._onEmailClick) await state._onEmailClick({ email: em, emailData: data, mode: 'forward' });
    });
    reader.querySelector('[data-act="summarize"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try { await _summarizeEmail(reader, data, ev.currentTarget); } catch {}
    });
    reader.querySelector('[data-act="from-sender"]')?.remove();
    reader.querySelector('[data-act="from-sender"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try { await _toggleFromSenderPanel(reader, data, ev.currentTarget); } catch {}
    });
    reader.querySelector('[data-act="more"]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      try { _showReaderMoreMenu(em, modal, reader, ev.currentTarget); } catch {}
    });
  } catch (err) {
    reader.innerHTML = `<div style="padding:20px;color:var(--red,#e55)">Failed to load: ${_esc(String(err))}</div>`;
  }
}


// "在新窗口中打开" — 生成一个仅显示邮件内容的浮动可拖拽模态框。
// 多个窗口可以堆叠；每个有自己的 DOM id 和关闭按钮。
// 使用 `_makeDraggable`，因此拖拽头部可在周围平移窗口。
// 通过 _renderEmailBody 渲染正文，与展开的阅读器保持一致。
let _emailWindowSeq = 0;
async function _openEmailWindow(em, folder) {
  const useFolder = folder || state._libFolder || 'INBOX';
  _emailWindowSeq += 1;
  const winId = `email-window-${em.uid}-${_emailWindowSeq}`;
  const modal = document.createElement('div');
  modal.className = 'modal email-window-modal';
  modal.id = winId;
  modal.style.cssText = 'pointer-events:none;background:transparent;';
  modal.innerHTML = `
    <div class="modal-content email-window-content" style="width:min(640px, 92vw);max-height:80vh;display:flex;flex-direction:column;background:var(--bg);">
      <div class="modal-header">
        <h4 style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
          <span class="email-window-subject" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(em.subject || '(no subject)')}</span>
        </h4>
        <button class="close-btn" type="button" title="Close">&#x2716;</button>
      </div>
      <div class="modal-body email-window-body" style="overflow:auto;padding:14px 16px;flex:1;min-height:0;">
        <div class="email-window-loading" style="display:flex;justify-content:center;padding:24px;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.style.display = 'block';
  const content = modal.querySelector('.modal-content');
  // 位置从屏幕中心偏移，以便连续窗口形成级联。
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    content.style.position = 'fixed';
    content.style.pointerEvents = 'auto';
    content.style.left = '0';
    content.style.right = '0';
    content.style.bottom = '0';
    content.style.top = 'auto';
  } else {
    content.style.position = 'fixed';
    content.style.pointerEvents = 'auto';
    requestAnimationFrame(() => {
      const w = content.offsetWidth, h = content.offsetHeight;
      const off = (_emailWindowSeq % 6) * 28;
      content.style.left = Math.max(20, (window.innerWidth  - w) / 2 + off) + 'px';
      content.style.top  = Math.max(20, (window.innerHeight - h) / 3 + off) + 'px';
    });
  }
  modal.querySelector('.close-btn')?.addEventListener('click', () => modal.remove());
  try { _makeDraggable(content, modal, 'email-window-fullscreen'); } catch {}

  // 加载 + 渲染
  const bodyEl = modal.querySelector('.email-window-body');
  const loading = modal.querySelector('.email-window-loading');
  try {
    const sp = spinnerModule.createWhirlpool(24);
    loading.appendChild(sp.element);
    const res = await fetch(`${API_BASE}/api/email/read/${em.uid}?folder=${encodeURIComponent(useFolder)}${_acct()}`);
    const data = await res.json();
    if (data.error) {
      bodyEl.innerHTML = `<div style="color:var(--red,#e55);padding:16px;">${_esc(data.error)}</div>`;
      return;
    }
    _syncEmailReadState(em.uid, true);
    const subjEl = modal.querySelector('.email-window-subject');
    if (subjEl && data.subject) subjEl.textContent = data.subject;
    // 以与内联阅读器相同的方式构建收件人芯片，
    // 使独立查看器看起来/感觉起来与真实邮件视图完全相同。
    const _chipsFor = (addrs) => {
      if (!addrs) return '';
      const list = _splitRecipientList(addrs);
      return list.map(a => {
        const name = _extractName(a);
        return _recipientChipHtml(a, name);
      }).join('');
    };
    const fromChip = _recipientChipHtml(`${data.from_name || ''} <${data.from_address || ''}>`, data.from_name || data.from_address, 'from-chip');
    let attsHtml = '';
    try { attsHtml = _buildAttsHtmlFor(em.uid, data); } catch {}
    // 重新将 bodyEl 用作完整的 email-card-reader，以便内联阅读器的
    // CSS 适用（有尺寸的头部、两行操作按钮等）。
    bodyEl.classList.add('email-card-reader');
    _markEmailReaderActive(bodyEl);
    bodyEl.style.padding = '0';
    bodyEl.innerHTML = `
      <div class="email-reader-header">
        <div class="email-reader-meta">
          <div class="email-reader-meta-row"><strong>From:</strong><span class="recipient-chips">${fromChip}</span></div>
          ${data.to ? `<div class="email-reader-meta-row"><strong>To:</strong><span class="recipient-chips">${_chipsFor(data.to)}</span></div>` : ''}
          ${data.cc ? `<div class="email-reader-meta-row"><strong>Cc:</strong><span class="recipient-chips">${_chipsFor(data.cc)}</span></div>` : ''}
        </div>
        <div class="email-reader-actions">
          <div class="email-reader-actions-row email-reader-actions-row-primary">
            <button class="memory-toolbar-btn reader-icon-btn" data-act="reply" title="Reply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg><span class="reader-btn-label">Reply</span></button>
            ${_hasMultipleRecipients(data) ? `<button class="memory-toolbar-btn reader-icon-btn" data-act="reply-all" title="Reply All"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/></svg><span class="reader-btn-label">Reply all</span></button>` : ''}
            <button class="memory-toolbar-btn reader-icon-btn" data-act="forward" title="Forward"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg><span class="reader-btn-label">Forward</span></button>
          </div>
          <div class="email-reader-actions-row email-reader-actions-row-secondary">
            <button class="memory-toolbar-btn reader-icon-btn" data-act="ai-reply" title="${data.cached_ai_reply ? 'AI Reply (cached draft ready)' : 'AI Reply (suggest a draft)'}">${_aiReplyIcon(data)}<span class="reader-btn-label">AI reply</span></button>
            <button class="memory-toolbar-btn reader-icon-btn" data-act="summarize" title="Summarize">${_summaryIcon(data)}<span class="reader-btn-label">Summary</span></button>
            <button class="memory-toolbar-btn reader-icon-btn" data-act="from-sender" title="Search text in this thread"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span class="reader-btn-label">Search</span></button>
            <div class="email-reader-more-wrap" style="position:relative">
              <button class="memory-toolbar-btn reader-icon-btn" data-act="more" title="More actions"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg><span class="reader-btn-label">More</span></button>
            </div>
          </div>
        </div>
      </div>
      ${attsHtml}
      <div class="email-reader-body${data.body_html ? ' html-body' : ''}">${_safeRenderEmailBody(data)}</div>
    `;
    _markEmailReaderActive(bodyEl);
    _wireRecipientChips(bodyEl);
    // 连接内联阅读器拥有的所有相同操作处理程序。
    try { _wireAttachmentHandlers(bodyEl, useFolder); } catch {}
    const attsWrap = bodyEl.querySelector('.email-reader-atts-wrap');
    if (attsWrap) {
      const attsToggle = attsWrap.querySelector('.email-reader-atts-header');
      if (attsToggle) attsToggle.addEventListener('click', (ev) => { ev.stopPropagation(); attsWrap.classList.toggle('collapsed'); });
    }
    bodyEl.querySelector('[data-act="reply"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      _snapEmailModalToLeftSidebar(ev.currentTarget.closest('.modal'));
      if (state._onEmailClick) await state._onEmailClick({ email: em, emailData: data, mode: 'reply' });
    });
    bodyEl.querySelector('[data-act="reply-all"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      _snapEmailModalToLeftSidebar(ev.currentTarget.closest('.modal'));
      if (state._onEmailClick) await state._onEmailClick({ email: em, emailData: data, mode: 'reply-all' });
    });
    bodyEl.querySelector('[data-act="ai-reply"]')?.addEventListener('click', (ev) => _handleAiReplyButton(ev, em, data));
    bodyEl.querySelector('[data-act="forward"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (state._onEmailClick) await state._onEmailClick({ email: em, emailData: data, mode: 'forward' });
    });
    bodyEl.querySelector('[data-act="summarize"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try { await _summarizeEmail(bodyEl, data, ev.currentTarget); } catch {}
    });
    bodyEl.querySelector('[data-act="from-sender"]')?.remove();
    bodyEl.querySelector('[data-act="from-sender"]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try { await _toggleFromSenderPanel(bodyEl, data, ev.currentTarget); } catch {}
    });
    bodyEl.querySelector('[data-act="more"]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // 使用合成的"卡片" — more 菜单只需要锚点元素和邮件数据。
      // card 参数主要用于查找下一个兄弟；独立窗口没有，所以我们只需
      // 传递 bodyEl 作为替代。
      try { _showReaderMoreMenu(em, modal, bodyEl, ev.currentTarget); } catch {}
    });
  } catch (err) {
    bodyEl.innerHTML = `<div style="color:var(--red,#e55);padding:16px;">Failed to load: ${_esc(String(err))}</div>`;
  }
}

// 获取新邮件的内容并用其替换当前阅读器正文
//（保留 from-sender 面板）。用于在同一发件人的邮件之间进行原地导航 —
// `folder` 默认为库的当前文件夹，但可以覆盖，
// 以便跨文件夹搜索结果可以打开正确的文件夹。
async function _swapReaderToUid(reader, uid, folder) {
  const body = reader.querySelector('.email-reader-body');
  if (!body) return;
  body.innerHTML = '';
  const sp = spinnerModule.createWhirlpool(24);
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:20px;display:flex;justify-content:center';
  wrap.appendChild(sp.element);
  body.appendChild(wrap);
  const useFolder = folder || state._libFolder;
  try {
    const res = await fetch(`${API_BASE}/api/email/read/${uid}?folder=${encodeURIComponent(useFolder)}${_acct()}`);
    const data = await res.json();
    if (data.error) {
      body.innerHTML = `<div style="padding:20px;color:var(--red,#e55)">${_esc(data.error)}</div>`;
      return;
    }
    _syncEmailReadState(uid, true);
    // 更新头部元数据（From/To/Subject）以匹配新邮件。
    const headerMeta = reader.querySelector('.email-reader-meta');
    if (headerMeta) {
      const subj = data.subject || '(no subject)';
      const date = data.date ? new Date(data.date).toLocaleString() : '';
      const chipsFor = (addrs) => {
        if (!addrs) return '';
        return _splitRecipientList(addrs).map(a => {
          const name = _extractName(a);
          return _recipientChipHtml(a, name);
        }).join('');
      };
      const fromChip = _recipientChipHtml(`${data.from_name || ''} <${data.from_address || ''}>`, data.from_name || data.from_address, 'from-chip');
      headerMeta.innerHTML = `
        <div class="email-reader-meta-row"><strong>Subject:</strong> ${_esc(subj)}</div>
        <div class="email-reader-meta-row"><strong>From:</strong><span class="recipient-chips">${fromChip}</span></div>
        ${data.to ? `<div class="email-reader-meta-row"><strong>To:</strong><span class="recipient-chips">${chipsFor(data.to)}</span></div>` : ''}
        ${data.cc ? `<div class="email-reader-meta-row"><strong>Cc:</strong><span class="recipient-chips">${chipsFor(data.cc)}</span></div>` : ''}
        ${date ? `<div class="email-reader-meta-row"><strong>Date:</strong> ${_esc(date)}</div>` : ''}
      `;
      _wireRecipientChips(reader);
    }
    // 刷新附件块以匹配新邮件。构建新的 HTML，
    // 并替换现有块、移除它（如果新邮件没有附件），
    // 或在正文前插入一个（如果之前的邮件没有附件但新邮件有）。
    const newAttsHtml = _buildAttsHtmlFor(uid, data);
    const oldAtts = reader.querySelector('.email-reader-atts-wrap');
    if (newAttsHtml) {
      if (oldAtts) {
        const tmp = document.createElement('div');
        tmp.innerHTML = newAttsHtml;
        oldAtts.replaceWith(tmp.firstChild);
      } else {
        body.insertAdjacentHTML('beforebegin', newAttsHtml);
      }
      const newWrap = reader.querySelector('.email-reader-atts-wrap');
      if (newWrap) {
        const hdr = newWrap.querySelector('.email-reader-atts-header');
        if (hdr) {
          hdr.addEventListener('click', (ev) => {
            ev.stopPropagation();
            newWrap.classList.toggle('collapsed');
          });
          hdr.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              newWrap.classList.toggle('collapsed');
            }
          });
        }
      }
    } else if (oldAtts) {
      oldAtts.remove();
    }
    body.innerHTML = _safeRenderEmailBody(data);
    body.classList.toggle('html-body', !!data.body_html);
    // 为新渲染的附件芯片连接点击处理程序。否则在
    // 通过侧边栏切换到不同邮件后，点击附件芯片不会产生任何效果。
    _wireAttachmentHandlers(reader, useFolder);
  } catch (err) {
    body.innerHTML = `<div style="padding:20px;color:var(--red,#e55)">${_esc(String(err))}</div>`;
  }
}

async function _summarizeEmail(reader, data, btn) {
  const body = reader.querySelector('.email-reader-body');
  if (!body) return;

  // 如果摘要面板已存在，切换：隐藏/显示
  const existing = body.querySelector('.email-summary-panel');
  if (existing) {
    if (existing.style.display === 'none') {
      existing.style.display = '';
      if (btn) {
        btn.classList.add('active');
        btn.querySelector('.btn-label').textContent = t('email.summary');
      }
    } else {
      existing.style.display = 'none';
      if (btn) {
        btn.classList.remove('active');
        btn.querySelector('.btn-label').textContent = t('email.summary');
      }
    }
    return;
  }

  // 还没有面板。如果邮件没有缓存的 AI 摘要，显示占位符
  // "未生成 — 立即创建？"提示，而不是立即触发 LLM。
  // 这避免了意外的 LLM 花费，并使状态对用户明确。
  if (!data.cached_summary) {
    const prompt = document.createElement('div');
    prompt.className = 'email-summary-panel';
    prompt.innerHTML = `
      <div class="email-summary-header">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg>
        <span>Summary</span>
      </div>
      <div class="email-summary-content" style="white-space:normal;display:flex;align-items:center;flex-wrap:wrap;gap:6px;"><span style="opacity:0.65">No AI summary generated.</span><button class="memory-toolbar-btn" data-act="summary-generate" style="font-size:10px;margin-left:auto;">Generate now</button></div>`;
    body.insertBefore(prompt, body.firstChild);
    if (btn) {
      btn.classList.add('active');
      const label = btn.querySelector('.btn-label');
      if (label) label.textContent = t('email.summary');
    }
    // 没有取消按钮 — 再次切换摘要按钮会隐藏此面板
    //（由上面的现有面板分支处理），所以它是多余的。
    prompt.querySelector('[data-act="summary-generate"]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      prompt.remove();
      await _generateSummary(reader, data, btn);
    });
    return;
  }

  // 缓存的摘要存在 — 立即显示它。
  await _generateSummary(reader, data, btn);
}

async function _generateSummary(reader, data, btn) {
  const body = reader.querySelector('.email-reader-body');
  if (!body) return;

  const panel = document.createElement('div');
  panel.className = 'email-summary-panel';
  panel.innerHTML =
    '<div class="email-summary-header email-summary-toggle" role="button" tabindex="0">'
    +   '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg>'
    +   '<span>Summary</span>'
    +   '<svg class="email-summary-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;transition:transform .15s ease;"><polyline points="6 9 12 15 18 9"/></svg>'
    + '</div>'
    + '<div class="email-summary-content"></div>';
  if (_summaryCollapsedPref()) panel.classList.add('collapsed');
  body.insertBefore(panel, body.firstChild);
  const _genToggle = panel.querySelector('.email-summary-toggle');
  if (_genToggle) {
    const _genFlip = () => {
      panel.classList.toggle('collapsed');
      _setSummaryCollapsedPref(panel.classList.contains('collapsed'));
    };
    _genToggle.addEventListener('click', (ev) => { ev.stopPropagation(); _genFlip(); });
    _genToggle.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); _genFlip(); }
    });
  }

  const sp = spinnerModule.createWhirlpool(18);
  const content = panel.querySelector('.email-summary-content');
  content.appendChild(sp.element);

  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/email/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: data.body,
        subject: data.subject,
        from: `${data.from_name} <${data.from_address}>`,
        // 发送标识符以便后端可以获取原始消息并
        // 提取附件文本用于摘要（PDF、发票等）。
        uid: data.uid || '',
        folder: state._libFolder || 'INBOX',
        message_id: data.message_id || '',
        account_id: data.account_id || '',
      }),
    });
    const result = await res.json();
    sp.destroy();
    content.innerHTML = '';
    if (result.success && result.summary) {
      content.textContent = result.summary;
      if (btn) {
        btn.classList.add('active');
        const label = btn.querySelector('.btn-label');
        if (label) label.textContent = t('email.summary');
      }
    } else {
      content.innerHTML = `<span style="color:var(--red)">${_esc(result.error || t('email.failed_to_summarize'))}</span>`;
      panel.remove();
    }
  } catch (e) {
    sp.destroy();
    panel.remove();
    if (uiModule) uiModule.showError?.('Failed to summarize');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 将邮件 ⋮ 下拉菜单保持在视口内：当它会超出底部时
//（例如手机屏幕上位置较低的邮件），如果上方有更多空间就翻转到锚点之上，
// 如果仍然溢出则限制高度并滚动。
function _fitEmailDropdown(dropdown, rect) {
  requestAnimationFrame(() => {
    const margin = 8;
    // 水平约束 — 无论通过左还是右锚定，都将下拉菜单保持在视口内。
    // 因为现在一些触发器（例如右对齐的批量"操作"按钮）靠近
    // 右边缘，左锚定的菜单会溢出屏幕。
    const dw = dropdown.offsetWidth;
    const curLeft = dropdown.getBoundingClientRect().left;
    if (curLeft + dw > window.innerWidth - margin) {
      dropdown.style.left = Math.max(margin, window.innerWidth - margin - dw) + 'px';
      dropdown.style.right = 'auto';
    } else if (curLeft < margin) {
      dropdown.style.left = margin + 'px';
      dropdown.style.right = 'auto';
    }
    // 垂直适应 — 如果下方空间不足，则向上翻转或限制高度+滚动。
    const dh = dropdown.offsetHeight;
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    if (dh <= below) return;                 // 在下方合适
    if (above > below) {                     // 向上翻转
      dropdown.style.top = 'auto';
      dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      if (dh > above) { dropdown.style.maxHeight = above + 'px'; dropdown.style.overflowY = 'auto'; }
    } else {                                 // 保持在下方，限制高度+滚动
      dropdown.style.maxHeight = below + 'px';
      dropdown.style.overflowY = 'auto';
    }
  });
}

function _showReaderMoreMenu(em, card, reader, anchor) {
  // 切换：如果此锚点对应的下拉菜单已打开，关闭它。
  const existing = document.querySelector('.email-card-dropdown');
  if (existing && existing._anchor === anchor) {
    existing.remove();
    anchor.classList.remove('reader-more-active');
    return;
  }
  // 否则在打开新下拉菜单之前关闭任何其他打开的下拉菜单
  //（并清除其锚点的激活状态）。
  document.querySelectorAll('.email-card-dropdown').forEach(d => {
    if (d._anchor) d._anchor.classList.remove('reader-more-active');
    d.remove();
  });

  const dropdown = document.createElement('div');
  dropdown.className = 'email-card-dropdown';
  dropdown._anchor = anchor;
  anchor.classList.add('reader-more-active');
  const rect = anchor.getBoundingClientRect();
  dropdown.style.cssText = `position:fixed;z-index:10001;min-width:180px;background:var(--panel,var(--bg));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.3);padding:4px;font-size:12px;top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;`;

  const _icon = (svg) => `<span class="dropdown-icon">${svg}</span>`;
  const _unreadIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
  const _archIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
  const _spamIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  const _trashIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
  const _deleteForeverIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="14" y2="15"/><line x1="14" y1="11" x2="10" y2="15"/></svg>';
  const _bellIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  const _newTabIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
  const _checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  const closeAndRemove = async () => {
    // 在重新渲染之前选择下一个邻居，以便知道要跳转到哪个邮件。
    // 优先选择下一张卡片；如果这是最后一张则回退到上一张。
    const sibling = _findSiblingEmailCard(card, +1) || _findSiblingEmailCard(card, -1);
    const nextUid = sibling ? sibling.dataset.uid : null;
    await _animateEmailCardRemoval([em.uid]);
    state._libEmails = state._libEmails.filter(e => String(e.uid) !== String(em.uid));
    _renderGrid();
    _libCacheWriteBack();
    if (!nextUid) return;
    // _renderGrid 之后，卡片节点是新鲜的 — 重新解析并展开。
    const grid = document.getElementById('email-lib-grid');
    const nextCard = grid?.querySelector(`.doclib-card[data-uid="${CSS.escape(String(nextUid))}"]`);
    const nextEm = state._libEmails.find(e => String(e.uid) === String(nextUid));
    if (nextCard && nextEm) {
      _toggleCardPreview(nextCard, nextEm);
      nextCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const _bubblesIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  const _contactIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>';
  const actions = [
    {
      label: 'Open in new tab',
      icon: _newTabIcon,
      action: async () => {
        const folder = state._libFolder || 'INBOX';
        await _openEmailAsTab(em, folder);
      },
    },
    {
      // 将发件人保存到 CardDAV 联系人。从列表项 (em) 中提取姓名 + 地址；
      // 回退到拆分本地部分作为姓名。
      label: 'Save sender to contacts',
      icon: _contactIcon,
      action: async () => {
        const email = (em.from_address || em.from || '').trim();
        if (!email) {
          import('./ui.js').then(m => m.showError && m.showError('No sender address')).catch(() => {});
          return;
        }
        const name = (em.from_name || '').trim() || email.split('@')[0];
        try {
          const r = await fetch(`${API_BASE}/api/contacts/add`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email }),
          });
          const d = await r.json();
          import('./ui.js').then(m => {
            if (!m.showToast) return;
            if (d.success && d.message === 'Already exists') m.showToast('Already in contacts');
            else if (d.success) m.showToast('Saved to contacts');
            else m.showError && m.showError('Failed to save contact');
          }).catch(() => {});
        } catch (_) {
          import('./ui.js').then(m => m.showError && m.showError('Failed to save contact')).catch(() => {});
        }
      },
    },
    // 线程化 ⇄ 纯文本视图切换已移除 — 线程化视图目前禁用
    //（太不稳定）。邮件始终以纯文本渲染。恢复此项及
    // _bubblesDisabled() localStorage 逻辑可重新启用。
    {
      label: em.is_read ? 'Mark Unread' : 'Mark Read',
      icon: _unreadIcon,
      action: async () => {
        const newRead = !em.is_read;
        _syncEmailReadState(em.uid, newRead);
        try {
          if (newRead) {
            await fetch(`${API_BASE}/api/email/mark-read/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
          } else {
            await fetch(`${API_BASE}/api/email/mark-unread/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
          }
        } catch (e) { console.error(e); }
        _renderGrid();
      },
    },
    {
      label: em.is_answered ? 'Not Done' : 'Done',
      icon: _checkIcon,
      action: async () => {
        const newState = !em.is_answered;
        em.is_answered = newState;
        if (newState) _syncEmailReadState(em.uid, true);
        try {
          if (newState) {
            await fetch(`${API_BASE}/api/email/mark-answered/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
            await fetch(`${API_BASE}/api/email/mark-read/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
          } else {
            await fetch(`${API_BASE}/api/email/clear-answered/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
          }
        } catch (e) { console.error('Failed to toggle done:', e); }
        _renderGrid();
      },
    },
    {
      label: 'Archive',
      icon: _archIcon,
      action: async () => {
        try {
          await fetch(`${API_BASE}/api/email/archive/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
        } catch (e) { console.error(e); }
        await closeAndRemove();
      },
    },
    {
      label: 'Remind to reply',
      icon: _bellIcon,
      submenu: 'remind',
    },
    {
      label: 'Move to Spam',
      icon: _spamIcon,
      action: async () => {
        try {
          await fetch(`${API_BASE}/api/email/move/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}&dest=Junk`, { method: 'POST' });
        } catch (e) { console.error(e); }
        await closeAndRemove();
      },
    },
    {
      label: 'Move to Trash',
      icon: _trashIcon,
      action: async () => {
        try {
          await fetch(`${API_BASE}/api/email/delete/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'DELETE' });
        } catch (e) { console.error(e); }
        await closeAndRemove();
      },
    },
    {
      label: 'Delete Permanently',
      icon: _deleteForeverIcon,
      danger: true,
      action: async () => {
        const subject = em.subject || '(no subject)';
        const ok = await styledConfirm(
          `Permanently delete "${subject}"? This cannot be undone.`,
          { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
        );
        if (!ok) return;
        try {
          await fetch(`${API_BASE}/api/email/delete-permanent/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'DELETE' });
        } catch (e) { console.error(e); }
        await closeAndRemove();
      },
    },
  ];

  for (const a of actions) {
    const item = document.createElement('div');
    item.className = 'dropdown-item-compact' + (a.danger ? ' dropdown-item-danger' : '');
    const arrow = a.submenu ? '<span style="margin-left:auto;opacity:0.5;">›</span>' : '';
    item.innerHTML = _icon(a.icon) + `<span>${a.label}</span>${arrow}`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (a.submenu === 'remind') {
        _showLibRemindSubmenu(em, dropdown);
        return;
      }
      dropdown.remove();
      anchor.classList.remove('reader-more-active');
      a.action();
    });
    dropdown.appendChild(item);
  }
  // 仅移动端的取消项 — 触摸用户的显式关闭。CSS 在桌面端隐藏它，
  // 因为桌面端外部点击已经能干净地关闭。
  const _cancelIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const cancelItem = document.createElement('div');
  cancelItem.className = 'dropdown-item-compact dropdown-cancel-mobile';
  cancelItem.innerHTML = _icon(_cancelIco) + '<span>Cancel</span>';
  cancelItem.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.remove();
    anchor.classList.remove('reader-more-active');
  });
  dropdown.appendChild(cancelItem);

  document.body.appendChild(dropdown);
  _fitEmailDropdown(dropdown, rect);
  const close = (ev) => {
    if (!dropdown.contains(ev.target) && ev.target !== anchor) {
      dropdown.remove();
      anchor.classList.remove('reader-more-active');
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 10);
}

function _showCardMenu(em, anchor) {
  document.querySelectorAll('.email-card-dropdown').forEach(d => d.remove());

  const dropdown = document.createElement('div');
  dropdown.className = 'email-card-dropdown';
  const rect = anchor.getBoundingClientRect();
  dropdown.style.cssText = `position:fixed;z-index:10001;min-width:140px;background:var(--panel,var(--bg));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.3);padding:4px;font-size:12px;top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;`;

  const _icon = (svg) => `<span class="dropdown-icon">${svg}</span>`;
  const _replyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
  const _archIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
  const _delIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
  const _unreadIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
  const _checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const _cardBellIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

  const isSentFolder = /sent/i.test(state._libFolder);

  const _newTabIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
  const actions = [
    { label: 'Open', icon: _replyIcon, action: async () => {
      // 仅内联展开（与点击行相同）。
      const card = anchor.closest('.doclib-card');
      if (card && !card.classList.contains('doclib-card-expanded')) {
        await _toggleCardPreview(card, em);
      }
    }},
    { label: 'Open in new tab', icon: _newTabIcon, action: async () => {
      // 将邮件作为自己的应用内模态框打开，注册停靠栏芯片 —
      // 可以同时打开多封邮件，每个在最小化停靠栏中有自己的芯片。
      const folder = state._libFolder || 'INBOX';
      await _openEmailAsTab(em, folder);
    }},
    { label: 'Remind to reply', icon: _cardBellIcon, submenu: 'remind' },
  ];

  if (!isSentFolder) {
    // 真实来源 = 卡片完成对勾上的可见 "active" 类，
    // 以确保菜单标签和实际切换行为不会与用户所见不符。
    const _cardForLabel = anchor.closest('.doclib-card');
    const _checkForLabel = _cardForLabel ? _cardForLabel.querySelector('.email-card-done') : null;
    const _currentlyDone = _checkForLabel ? _checkForLabel.classList.contains('active') : !!em.is_answered;
    actions.push({
      label: _currentlyDone ? 'Not Done' : 'Done',
      icon: _checkIcon,
      action: async () => {
        const card = anchor.closest('.doclib-card');
        const check = card ? card.querySelector('.email-card-done') : null;
        const wasActive = check ? check.classList.contains('active') : !!em.is_answered;
        const newState = !wasActive;
        em.is_answered = newState;
        if (newState) _syncEmailReadState(em.uid, true); // 标记完成意味着标记已读
        try {
          if (newState) {
            await fetch(`${API_BASE}/api/email/mark-answered/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
            await fetch(`${API_BASE}/api/email/mark-read/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
          } else {
            await fetch(`${API_BASE}/api/email/clear-answered/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
          }
        } catch (e) { console.error('Failed to toggle done:', e); }
        if (card) {
          if (check) check.classList.toggle('active', newState);
          if (newState) _syncEmailReadState(em.uid, true);
        }
      },
    });
    actions.push({
      label: 'Archive',
      icon: _archIcon,
      action: async () => {
        await fetch(`${API_BASE}/api/email/archive/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
        await _animateEmailCardRemoval([em.uid]);
        state._libEmails = state._libEmails.filter(e => String(e.uid) !== String(em.uid));
        _renderGrid();
        _libCacheWriteBack();
      },
    });
  } else {
    actions.push({
      label: 'Archive',
      icon: _archIcon,
      action: async () => {
        await fetch(`${API_BASE}/api/email/archive/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
        await _animateEmailCardRemoval([em.uid]);
        state._libEmails = state._libEmails.filter(e => String(e.uid) !== String(em.uid));
        _renderGrid();
        _libCacheWriteBack();
      },
    });
  }

  // "选择" — 切换为多选模式，并将此邮件预选中，
  // 以便用户可以快速通过批量栏扩展到相邻邮件。
  // 匹配聊天侧边栏的选择图标 — 粗点字符视觉上比小的 SVG 圆更厚重。
  // 上移 2px 以确保其视觉中心与上方的 SVG 图标对齐（它们稍高一些）。
  const _selectIcon = '<span style="font-size:16px;line-height:1;position:relative;top:-2px;">●</span>';
  actions.push({
    label: 'Select',
    icon: _selectIcon,
    action: () => {
      state._selectMode = true;
      state._selectedUids.add(em.uid);
      _updateBulkBar();
      _renderGrid();
    },
  });

  actions.push(
    { label: 'Delete', icon: _delIcon, danger: true, action: async () => {
      const subject = em.subject || '(no subject)';
      const ok = await styledConfirm(`Delete "${subject}"?`, { confirmText: 'Delete', cancelText: 'Cancel', danger: true });
      if (!ok) return;
      await fetch(`${API_BASE}/api/email/delete/${em.uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'DELETE' });
      await _animateEmailCardRemoval([em.uid]);
      state._libEmails = state._libEmails.filter(e => String(e.uid) !== String(em.uid));
      _renderGrid();
      _libCacheWriteBack();
    }},
  );

  for (const a of actions) {
    const item = document.createElement('div');
    item.className = 'dropdown-item-compact' + (a.danger ? ' dropdown-item-danger' : '');
    const arrow = a.submenu ? '<span style="margin-left:auto;opacity:0.5;">›</span>' : '';
    item.innerHTML = _icon(a.icon) + `<span>${a.label}</span>${arrow}`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (a.submenu === 'remind') {
        _showLibRemindSubmenu(em, dropdown);
        return;
      }
      dropdown.remove();
      anchor.classList.remove('reader-more-active');
      a.action();
    });
    dropdown.appendChild(item);
  }
  // 仅移动端的取消项 — 触摸用户的显式关闭。CSS 在桌面端隐藏它，
  // 因为桌面端外部点击已经能干净地关闭。 (卡片菜单)
  const _cancelIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const cancelItem = document.createElement('div');
  cancelItem.className = 'dropdown-item-compact dropdown-cancel-mobile';
  cancelItem.innerHTML = _icon(_cancelIco) + '<span>Cancel</span>';
  cancelItem.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.remove();
    anchor.classList.remove('reader-more-active');
  });
  dropdown.appendChild(cancelItem);

  document.body.appendChild(dropdown);
  _fitEmailDropdown(dropdown, rect);
  const close = (ev) => {
    if (!dropdown.contains(ev.target) && ev.target !== anchor) {
      dropdown.remove();
      anchor.classList.remove('reader-more-active');
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 10);
}

// 选择模式的批量"操作"下拉菜单 — 删除按钮是单独的可见按钮。
function _showBulkActionsMenu(anchor) {
  document.querySelectorAll('.email-card-dropdown').forEach(d => d.remove());
  const dropdown = document.createElement('div');
  dropdown.className = 'email-card-dropdown email-bulk-menu';
  const rect = anchor.getBoundingClientRect();
  dropdown.style.cssText = `position:fixed;z-index:10001;min-width:160px;background:var(--panel,var(--bg));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.3);padding:4px;font-size:12px;top:${rect.bottom + 4}px;left:${rect.left}px;`;
  const _readIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg>';
  const _unreadIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
  const _doneIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const items = [
    { label: 'Done', icon: _doneIco, action: () => _bulkAction('done') },
    { label: 'Mark Read', icon: _readIco, action: () => _bulkAction('read') },
    { label: 'Mark Unread', icon: _unreadIco, action: () => _bulkAction('unread') },
  ];
  for (const a of items) {
    const it = document.createElement('div');
    it.className = 'dropdown-item-compact' + (a.danger ? ' dropdown-item-danger' : '');
    it.innerHTML = `<span class="dropdown-icon">${a.icon}</span><span>${a.label}</span>`;
    it.addEventListener('click', (e) => { e.stopPropagation(); dropdown.remove(); a.action(); });
    dropdown.appendChild(it);
  }
  // 仅移动端取消 — 与每张卡片和侧边栏下拉菜单匹配。
  const _cancelIco2 = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const cancelIt = document.createElement('div');
  cancelIt.className = 'dropdown-item-compact dropdown-cancel-mobile';
  cancelIt.innerHTML = `<span class="dropdown-icon">${_cancelIco2}</span><span>Cancel</span>`;
  cancelIt.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.remove();
    // 批量操作菜单中的取消也退出选择模式 — 与文档批量下拉菜单匹配。
    state._selectMode = false;
    state._selectedUids.clear();
    _updateBulkBar();
    _renderGrid();
  });
  dropdown.appendChild(cancelIt);
  document.body.appendChild(dropdown);
  _fitEmailDropdown(dropdown, rect);
  const close = (ev) => {
    if (!dropdown.contains(ev.target) && ev.target !== anchor) {
      dropdown.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 10);
}

function _updateBulkBar() {
  const bar = document.getElementById('email-lib-bulk');
  const selectBtn = document.getElementById('email-lib-select-btn');
  if (bar) bar.classList.toggle('hidden', !state._selectMode);
  if (selectBtn) {
    selectBtn.textContent = state._selectMode ? 'Cancel' : 'Select';
    selectBtn.classList.toggle('active', state._selectMode);
  }
  const count = document.getElementById('email-lib-selected-count');
  if (count) count.textContent = `${state._selectedUids.size} Selected`;
  const all = document.getElementById('email-lib-select-all');
  if (all) all.checked = state._libEmails.length > 0 && state._libEmails.every(e => state._selectedUids.has(e.uid));
  // 当有选中项时，将操作按钮亮化为与"N 项已选"计数相同的完整 --fg 颜色
  //（按钮默认为暗淡的 60% --fg）。
  const actions = document.getElementById('email-lib-bulk-actions');
  if (actions) actions.style.color = state._selectedUids.size > 0 ? 'var(--fg)' : '';
  const deleteBtn = document.getElementById('email-lib-bulk-delete');
  if (deleteBtn) deleteBtn.style.color = state._selectedUids.size > 0 ? 'var(--red)' : '';
}

async function _bulkAction(action) {
  const uids = Array.from(state._selectedUids);
  if (uids.length === 0) return;
  let failedReadSync = 0;
  if (action === 'delete') {
    const ok = await styledConfirm(
      `Delete ${uids.length} selected email${uids.length === 1 ? '' : 's'}?`,
      { confirmText: 'Delete', cancelText: 'Cancel', danger: true },
    );
    if (!ok) return;
  }

  const deleteBtn = action === 'delete' ? document.getElementById('email-lib-bulk-delete') : null;
  const actionsBtn = document.getElementById('email-lib-bulk-actions');
  const cancelBtn = document.getElementById('email-lib-bulk-cancel');
  const selectAll = document.getElementById('email-lib-select-all');
  const countEl = document.getElementById('email-lib-selected-count');
  const originalDeleteHtml = deleteBtn?.innerHTML || '';
  const originalCountText = countEl?.textContent || '';
  let busySpinner = null;
  if (action === 'delete') {
    if (deleteBtn) {
      deleteBtn.disabled = true;
      deleteBtn.classList.add('email-bulk-loading');
      deleteBtn.innerHTML = '<span class="email-bulk-loading-label">Deleting</span>';
      busySpinner = spinnerModule.create('', 'clean', 'whirlpool');
      const spEl = busySpinner.createElement();
      spEl.classList.add('email-bulk-whirlpool');
      deleteBtn.appendChild(spEl);
      busySpinner.start();
    }
    if (actionsBtn) actionsBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (selectAll) selectAll.disabled = true;
    if (countEl) countEl.textContent = t('email.deleting', { n: uids.length });
  }

  try {
    for (const uid of uids) {
      try {
        if (action === 'archive') {
          await fetch(`${API_BASE}/api/email/archive/${uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
        } else if (action === 'delete') {
          await fetch(`${API_BASE}/api/email/delete/${uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'DELETE' });
        } else if (action === 'done') {
          const em = state._libEmails.find(e => e.uid === uid);
          if (em) {
            em.is_answered = true;
            em.is_read = true;
          }
          await fetch(`${API_BASE}/api/email/mark-answered/${uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
          await fetch(`${API_BASE}/api/email/mark-read/${uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
        } else if (action === 'read' || action === 'unread') {
          const endpoint = action === 'read' ? 'mark-read' : 'mark-unread';
          const res = await fetch(`${API_BASE}/api/email/${endpoint}/${uid}?folder=${encodeURIComponent(state._libFolder)}${_acct()}`, { method: 'POST' });
          let data = null;
          try { data = await res.json(); } catch (_) {}
          if (!res.ok || data?.success === false) {
            throw new Error(data?.error || `HTTP ${res.status}`);
          }
          _syncEmailReadState(uid, action === 'read');
        }
      } catch (e) {
        if (action === 'read' || action === 'unread') failedReadSync += 1;
        console.error(`Failed to ${action} ${uid}:`, e);
      }
    }

    if (action === 'archive' || action === 'delete') {
      await _animateEmailCardRemoval(uids);
      const removed = new Set(uids.map(uid => String(uid)));
      state._libEmails = state._libEmails.filter(e => !removed.has(String(e.uid)));
    }
  } finally {
    if (busySpinner) busySpinner.destroy();
    if (deleteBtn) {
      deleteBtn.disabled = false;
      deleteBtn.classList.remove('email-bulk-loading');
      deleteBtn.innerHTML = originalDeleteHtml;
    }
    if (actionsBtn) actionsBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    if (selectAll) selectAll.disabled = false;
    if (countEl) countEl.textContent = originalCountText;
  }
  state._selectedUids.clear();
  state._selectMode = false;
  _updateBulkBar();
  _renderGrid();
  if (failedReadSync > 0) {
    showToast(`Failed to update ${failedReadSync} email${failedReadSync === 1 ? '' : 's'}`);
  }
  // 将成功的本地变更同步到 SWR 缓存中，以便重新打开时不会简短显示批量操作前的状态。
  _libCacheWriteBack();
}

// _extractName lives in ./emailLibrary/utils.js

function _aiReplyIcon(data) {
  const cachedSpark = data?.cached_ai_reply
    ? '<path d="M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" fill="var(--accent-primary, var(--red))" stroke="none" transform="translate(2 0)"/>'
    : '';
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>${cachedSpark}</svg>`;
}

function _summaryIcon(data) {
  const fill = data?.cached_summary ? 'var(--accent-primary, var(--red))' : 'currentColor';
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="${fill}"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg>`;
}

async function _runAiReplyFromButton(btn, em, data, mode) {
  _snapEmailModalToLeftSidebar(btn.closest('.modal'));
  btn.disabled = true;
  const orig = btn.innerHTML;
  let wp = null;
  try {
    wp = spinnerModule.createWhirlpool(14);
    wp.element.style.cssText = 'width:14px;height:14px;display:inline-block;vertical-align:middle;position:relative;top:-2px;';
    btn.innerHTML = '';
    btn.appendChild(wp.element);
  } catch (_) {}
  try {
    if (state._onEmailClick) await state._onEmailClick({ email: em, emailData: data, mode });
  } finally {
    try { wp && wp.stop(); } catch (_) {}
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function _closeAiReplyChoice() {
  document.querySelectorAll('.email-ai-reply-choice').forEach(el => el.remove());
  document.removeEventListener('click', _closeAiReplyChoice, true);
}

function _showAiReplyChoice(btn, em, data) {
  _closeAiReplyChoice();
  const rect = btn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'email-ai-reply-choice';
  menu.style.cssText = [
    'position:fixed',
    `left:${Math.max(8, Math.min(rect.left, window.innerWidth - 190))}px`,
    `top:${Math.min(window.innerHeight - 96, rect.bottom + 6)}px`,
    'z-index:10060',
    'display:flex',
    'gap:6px',
    'padding:6px',
    'background:var(--bg,#111)',
    'border:1px solid var(--border,#333)',
    'border-radius:7px',
    'box-shadow:0 8px 24px rgba(0,0,0,.28)',
  ].join(';');
  menu.innerHTML = `
    <button class="memory-toolbar-btn" data-mode="ai-reply-fast" title="Shorter, faster draft">Fast</button>
    <button class="memory-toolbar-btn" data-mode="ai-reply-full" title="Uses the fuller reply context">Full</button>
  `;
  menu.addEventListener('click', async (ev) => {
    const choice = ev.target.closest('[data-mode]');
    if (!choice) return;
    ev.preventDefault();
    ev.stopPropagation();
    const mode = choice.getAttribute('data-mode') || 'ai-reply';
    _closeAiReplyChoice();
    await _runAiReplyFromButton(btn, em, data, mode);
  });
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', _closeAiReplyChoice, true), 0);
}

function _handleAiReplyButton(ev, em, data) {
  ev.stopPropagation();
  const btn = ev.currentTarget;
  if (data?.cached_ai_reply) {
    _runAiReplyFromButton(btn, em, data, 'ai-reply');
    return;
  }
  _showAiReplyChoice(btn, em, data);
}

function _hasMultipleRecipients(data) {
  // 统计 To + Cc 中的不同地址（减去当前用户）。当用户地址尚未知时，
  // 空回退 — 不排除任何人。
  const myAddress = (window._myEmailAddress || '').toLowerCase();
  const extractEmails = (str) => {
    if (!str) return [];
    return str.split(',')
      .map(s => {
        const m = s.match(/<([^>]+)>/);
        return (m ? m[1] : s).trim().toLowerCase();
      })
      .filter(e => e && e !== myAddress);
  };
  const recipients = new Set([
    ...extractEmails(data.to),
    ...extractEmails(data.cc),
  ]);
  // 发件人也算作另一个其他人
  if (data.from_address && data.from_address.toLowerCase() !== myAddress) {
    recipients.add(data.from_address.toLowerCase());
  }
  return recipients.size > 1;
}

// _esc lives in ./emailLibrary/utils.js

// ---- Reminder submenu (used by both email menus) ----
function _showLibRemindSubmenu(em, parentDropdown) {
  parentDropdown.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'dropdown-item-compact';
  header.style.cssText = 'opacity:0.5;font-size:10px;pointer-events:none;text-transform:uppercase;letter-spacing:0.5px;padding-top:6px;';
  header.innerHTML = '<span>Remind me</span>';
  parentDropdown.appendChild(header);

  const now = new Date();
  const laterToday = new Date(now);
  const sixPm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0);
  if (sixPm - now < 60*60*1000) laterToday.setTime(now.getTime() + 3*60*60*1000);
  else laterToday.setTime(sixPm.getTime());
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate()+1); tomorrow.setHours(8,0,0,0);
  const daysUntilMon = (8 - now.getDay()) % 7 || 7;
  const nextWeek = new Date(now); nextWeek.setDate(now.getDate()+daysUntilMon); nextWeek.setHours(8,0,0,0);

  const presets = [
    { label: 'Later today', sub: laterToday.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }), date: laterToday },
    { label: 'Tomorrow', sub: tomorrow.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }), date: tomorrow },
    { label: 'Next week', sub: nextWeek.toLocaleDateString([], { weekday:'short' }) + ' ' + nextWeek.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }), date: nextWeek },
  ];
  for (const p of presets) {
    const item = document.createElement('div');
    item.className = 'dropdown-item-compact';
    item.innerHTML = `<span>${p.label}</span><span style="margin-left:auto;opacity:0.5;font-size:10px;">${p.sub}</span>`;
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      parentDropdown.remove();
      await _createEmailReplyReminder(em, p.date);
    });
    parentDropdown.appendChild(item);
  }
  const customItem = document.createElement('div');
  customItem.className = 'dropdown-item-compact';
  customItem.innerHTML = '<span>Pick date and time…</span>';
  customItem.addEventListener('click', (e) => {
    e.stopPropagation();
    parentDropdown.remove();
    const tmp = document.createElement('input');
    tmp.type = 'datetime-local';
    const def = new Date(tomorrow);
    const pad = n => String(n).padStart(2,'0');
    tmp.value = `${def.getFullYear()}-${pad(def.getMonth()+1)}-${pad(def.getDate())}T${pad(def.getHours())}:${pad(def.getMinutes())}`;
    tmp.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:99999;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:13px;';
    document.body.appendChild(tmp);
    tmp.focus();
    if (typeof tmp.showPicker === 'function') { try { tmp.showPicker(); } catch {} }
    tmp.addEventListener('change', async () => {
      if (tmp.value) await _createEmailReplyReminder(em, new Date(tmp.value));
      tmp.remove();
    });
    tmp.addEventListener('blur', () => setTimeout(() => tmp.remove(), 200));
  });
  parentDropdown.appendChild(customItem);
}

async function _createEmailReplyReminder(em, dueDate) {
  const pad = n => String(n).padStart(2,'0');
  const iso = `${dueDate.getFullYear()}-${pad(dueDate.getMonth()+1)}-${pad(dueDate.getDate())}T${pad(dueDate.getHours())}:${pad(dueDate.getMinutes())}`;
  const fullFrom = em.from || em.sender || '';
  // 仅从 "First Last <email@x>" 中提取名字，或回退到电子邮件本地部分
  let from = 'someone';
  if (fullFrom) {
    const fullName = _extractName(fullFrom);
    if (fullName) {
      // 剥离引号，取第一个空格分隔的词，首字母大写
      const first = fullName.replace(/^["']|["']$/g, '').trim().split(/[\s,]+/)[0] || '';
      if (first) from = first.charAt(0).toUpperCase() + first.slice(1);
    }
  }
  const subject = em.subject || '(no subject)';
  const folder = state._libFolder || 'INBOX';
  const deepLink = `${window.location.origin}/#email=${encodeURIComponent(folder)}:${em.uid}`;
  const payload = {
    title: `Reply: ${subject}`,
    note_type: 'todo',
    items: [
      { text: `Reply to ${from}: ${subject}`, checked: false },
    ],
    content: `Open email: ${deepLink}`,
    label: 'email reminder',
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
    const fmt = dueDate.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    showToast(`Todo reminder set for ${fmt}`);
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch {}
    }
  } catch (e) {
    const { showError } = await import('./ui.js');
    showError('Failed to create reminder');
  }
}

// 在通过 innerHTML 注入之前消毒不受信任的 HTML 邮件正文。
//
// 拒绝列表消毒器 — 必须阻止所有已知的 XSS 攻击入口：
//   - <script>, <iframe>, <object>, <embed>, <form>, <style>, <link>
//   - 完全移除 SVG（事件处理器、<use href="javascript:">、<foreignObject>、
//     <animate>、<set> 等）。邮件客户端不需要 SVG。
//   - <math>（MathML 可以携带处理器）。
//   - <base href="...">, <meta http-equiv="refresh">, <noscript>, <frame>,
//     <frameset>, <applet>, <portal>。
//   - on* 属性；href/src/srcset/formaction/action/background/poster/data
//     属性中的 javascript:/vbscript:/data: URL。
//   - srcdoc（防御性 — iframe 已被移除）。
//   - 包含 javascript: 或 expression() 的内联 `style` 声明。
// _sanitizeHtml / _escLinkify live in ./emailLibrary/utils.js
