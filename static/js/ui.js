// static/js/ui.js

/**
 * UI 工具：toast 通知、模态框、滚动和用户反馈
 */

import themeModule from './theme.js';
import * as Modals from './modalManager.js';
import spinnerModule from './spinner.js';
import { registerMenuDismiss, dismissTopMenu, dismissOrRemove } from './escMenuStack.js';
import { t } from './i18n.js';

let toastEl = null;
let autoScrollEnabled = true;
let hoveredToggleCard = null;
let hoveredToggleWindow = null;
let hoveredDockChip = null;
let _lastPointerClientX = null;
let _lastPointerClientY = null;

// 平滑滚动状态
let _scrollRafId = null;
let _scrollBox = null;

function _isTextEditingTarget(target) {
  const el = target && target.nodeType === 1 ? target : target?.parentElement;
  return !!(el && el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

function _targetEl(target) {
  return target && target.nodeType === 1 ? target : target?.parentElement || null;
}

const SPACE_CARD_SELECTOR = [
  '#email-lib-modal .doclib-card',
  '#doclib-modal .doclib-card',
  '#doclib-modal .doclib-chat-row',
  '#memory-modal .doclib-card',
  '#tasks-modal .task-card',
  '#tasks-modal .task-log-row',
  '#research-overlay [data-job-id]',
  '#cookbook-modal .doclib-card',
  '.email-reader-tab-modal .doclib-card',
  '.email-window-modal .doclib-card',
].join(', ');

const SPACE_BLOCKED_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '.recipient-chip',
  '.doclib-card-dropdown',
  '.email-card-dropdown',
  '.task-log-row-actions',
  '.modal-header',
].join(', ');

function _visibleModalForSpace(win) {
  const modal = win?.closest?.('.modal[id]');
  if (!modal || modal.classList.contains('hidden') || modal.classList.contains('modal-minimized')) return null;
  return modal;
}

function _isSpaceVisible(el) {
  if (!el || !document.contains(el)) return false;
  if (el.closest?.('.modal.hidden, .modal.modal-minimized, [hidden]')) return false;
  return true;
}

function _spaceWindowId(win) {
  if (!win || !document.contains(win)) return null;
  const modal = _visibleModalForSpace(win);
  if (modal && Modals.isRegistered(modal.id)) return modal.id;
  if (win.closest?.('.doc-editor-pane') && Modals.isRegistered('doc-panel') && !Modals.isMinimized('doc-panel')) return 'doc-panel';
  return null;
}

function _windowAtPointer() {
  if (_lastPointerClientX == null || _lastPointerClientY == null) return null;
  const x = _lastPointerClientX;
  const y = _lastPointerClientY;
  const candidates = [
    ...document.querySelectorAll('.modal:not(.hidden):not(.modal-minimized) .modal-content'),
    ...document.querySelectorAll('.doc-editor-pane'),
  ].filter(el => {
    if (!document.contains(el)) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
  if (!candidates.length) return null;
  return candidates.reduce((top, el) => {
    const mz = parseInt(getComputedStyle(el.closest('.modal') || el).zIndex, 10) || 0;
    const tz = parseInt(getComputedStyle(top.closest('.modal') || top).zIndex, 10) || 0;
    return mz >= tz ? el : top;
  });
}

function _containsPointer(el) {
  if (!el || _lastPointerClientX == null || _lastPointerClientY == null) return false;
  const r = el.getBoundingClientRect();
  return _lastPointerClientX >= r.left && _lastPointerClientX <= r.right
    && _lastPointerClientY >= r.top && _lastPointerClientY <= r.bottom;
}

function _closeHoveredWindow() {
  let win = _windowAtPointer();
  if (!win) {
    try {
      const underPointer = document.elementFromPoint(_lastPointerClientX, _lastPointerClientY);
      win = underPointer?.closest?.('.modal:not(.hidden):not(.modal-minimized) .modal-content, .doc-editor-pane') || null;
    } catch {}
  }
  if (!win) win = hoveredToggleWindow;
  if (!win || !document.contains(win)) return false;
  const modalForWin = win.closest?.('.modal[id]');
  if (modalForWin?.id === 'email-lib-modal') {
    const closeBtn = document.getElementById('email-lib-close') || modalForWin.querySelector('.close-btn');
    if (closeBtn) {
      try { closeBtn.click(); return true; } catch {}
    }
    try { modalForWin.remove(); return true; } catch {}
  }
  const id = _spaceWindowId(win);
  if (id && Modals.isRegistered(id)) {
    Modals.close(id);
    return true;
  }
  const modal = _visibleModalForSpace(win);
  if (!modal) return false;
  const closeBtn = modal.querySelector('.close-btn, .modal-close, .modal-close-btn, [data-action="close"]');
  if (closeBtn) {
    try { closeBtn.click(); return true; } catch {}
  }
  try { modal.classList.add('hidden'); return true; } catch {}
  return false;
}

function _spaceIsBlocked(e, surface) {
  const target = _targetEl(e.target);
  if (!target) return false;
  if (_isTextEditingTarget(target)) return !surface || surface.contains(target);
  const blocked = target.closest?.(SPACE_BLOCKED_SELECTOR);
  return !!(blocked && (!surface || surface.contains(blocked)));
}

function _activateSpaceCard(card) {
  if (!card || !document.contains(card)) return false;
  if (card.matches('#tasks-modal .task-card')) {
    const titleRow = card.querySelector('.memory-item-title')?.closest('div');
    if (titleRow) {
      titleRow.click();
      return true;
    }
  }
  card.dataset.spaceToggle = '1';
  card.click();
  setTimeout(() => {
    try { delete card.dataset.spaceToggle; } catch {}
  }, 0);
  return true;
}

function _initHoverCardSpaceToggle() {
  if (document._odysseusHoverCardSpaceToggle) return;
  document._odysseusHoverCardSpaceToggle = true;
  document.addEventListener('pointerover', (e) => {
    _lastPointerClientX = e.clientX;
    _lastPointerClientY = e.clientY;
    const chip = e.target?.closest?.('.minimized-dock-chip[data-modal-id]');
    if (chip) hoveredDockChip = chip;
    const card = e.target?.closest?.(SPACE_CARD_SELECTOR);
    if (card) hoveredToggleCard = card;
    const win = e.target?.closest?.('.modal:not(.hidden):not(.modal-minimized) .modal-content, .doc-editor-pane');
    if (win) hoveredToggleWindow = win;
  }, true);
  document.addEventListener('pointermove', (e) => {
    _lastPointerClientX = e.clientX;
    _lastPointerClientY = e.clientY;
  }, true);
  document.addEventListener('pointerout', (e) => {
    const next = e.relatedTarget;
    if (hoveredDockChip && (!next || !hoveredDockChip.contains(next))) hoveredDockChip = null;
    if (hoveredToggleCard && (!next || !hoveredToggleCard.contains(next))) hoveredToggleCard = null;
    if (hoveredToggleWindow && (!next || !hoveredToggleWindow.contains(next))) hoveredToggleWindow = null;
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    if (hoveredToggleCard && _isSpaceVisible(hoveredToggleCard)) {
      if (_spaceIsBlocked(e, hoveredToggleCard)) return;
      e.preventDefault();
      _activateSpaceCard(hoveredToggleCard);
      return;
    }
    if (hoveredDockChip && document.contains(hoveredDockChip)) {
      if (_spaceIsBlocked(e, hoveredDockChip)) return;
      const id = hoveredDockChip.dataset.modalId;
      if (id && Modals.isRegistered(id)) {
        e.preventDefault();
        Modals.restore(id);
      }
      return;
    }
    const id = _spaceWindowId(hoveredToggleWindow);
    if (!id) return;
    if (_spaceIsBlocked(e, hoveredToggleWindow)) return;
    e.preventDefault();
    Modals.minimize(id);
  }, true);
}

_initHoverCardSpaceToggle();

/**
 * 将文本复制到剪贴板
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t('ui.copied'));
  }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(t('ui.copied'));
  }
}

// 为共享 toast 元素绑定滑动关闭。仅在首次显示 toast 时运行一次。
// 追踪水平触摸拖动；如果用户拖动超过 DISMISS_PX 像素，
// toast 会沿拖动方向滑出并提前隐藏。不足该距离则弹回原位。
// 桌面端不受影响（触摸监听器仅从触摸屏触发——鼠标由现有的 × 按钮和自动隐藏定时器处理）。
function _wireToastSwipe(el) {
  if (!el || el._swipeWired) return;
  el._swipeWired = true;
  const DISMISS_PX = 70;
  let startX = 0, currentX = 0, swiping = false;
  el.addEventListener('touchstart', (e) => {
    if (!el.classList.contains('show')) return;
    const t = e.touches[0];
    if (!t) return;
    startX = t.clientX;
    currentX = t.clientX;
    swiping = true;
    // 终止正在进行的滑入过渡，使触摸能 1:1 跟随手指，
    // 而不是与仍在运行的动画冲突。
    el.style.transition = 'none';
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!swiping) return;
    const t = e.touches[0];
    if (!t) return;
    currentX = t.clientX;
    const dx = currentX - startX;
    el.style.transform = `translateX(${dx}px)`;
    // 当 toast 离开原位时逐渐淡出——接近消失阈值的视觉提示。
    el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 200));
  }, { passive: true });
  const endSwipe = () => {
    if (!swiping) return;
    swiping = false;
    const dx = currentX - startX;
    // 恢复过渡，以便下次变化有动画效果。
    el.style.transition = '';
    if (Math.abs(dx) > DISMISS_PX) {
      // 沿拖动方向飞出，然后隐藏。
      el.style.transform = `translateX(${dx > 0 ? '120%' : '-120%'})`;
      el.style.opacity = '0';
      clearTimeout(el._hideTimer);
      setTimeout(() => {
        el.classList.remove('show');
        el.classList.add('exiting');
        el.style.transform = '';
        el.style.opacity = '';
      }, 180);
    } else {
      // 弹回原位。
      el.style.transform = '';
      el.style.opacity = '';
    }
  };
  el.addEventListener('touchend', endSwipe);
  el.addEventListener('touchcancel', endSwipe);
}

/**
 * 显示成功 toast 消息
 */
export function showToast(msg, durationOrOpts) {
  if (!toastEl) {
    toastEl = document.getElementById('toast');
  }
  _wireToastSwipe(toastEl);
  toastEl.textContent = '';
  toastEl.classList.remove('error');

  let duration = 1200, actionLabel = null, onAction = null, actionHint = null, actionIcon = null, leadingIcon = null;
  if (typeof durationOrOpts === 'object' && durationOrOpts) {
    duration = durationOrOpts.duration || 5000;
    actionLabel = durationOrOpts.action;
    onAction = durationOrOpts.onAction;
    actionHint = durationOrOpts.actionHint || null;
    actionIcon = durationOrOpts.actionIcon || null;
    leadingIcon = durationOrOpts.leadingIcon || null;
  } else if (typeof durationOrOpts === 'number') {
    duration = durationOrOpts;
  }

  const textSpan = document.createElement('span');
  if (leadingIcon === 'check') {
    const icon = document.createElement('span');
    icon.className = 'toast-checkmark';
    icon.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
    toastEl.appendChild(icon);
  } else if (leadingIcon === 'spinner') {
    const wp = spinnerModule.createWhirlpool(14);
    const icon = wp.element;
    icon.classList.add('toast-whirlpool');
    icon.style.cssText = 'width:14px;height:14px;margin:0 8px 0 0;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;';
    toastEl.appendChild(icon);
  }
  textSpan.textContent = msg;
  toastEl.appendChild(textSpan);

  if (actionLabel && onAction) {
    // 将操作按钮包裹在一个小列中，以便在按钮下方堆叠 Ctrl-Z 风格的提示。
    const stack = document.createElement('span');
    stack.style.cssText = 'display:inline-flex;flex-direction:column;align-items:center;gap:1px;margin-left:10px;line-height:1;';

    const btn = document.createElement('button');
    // 如果调用方提供了 SVG 图标，将其前置。我们信任图标字符串
    // （仅内部设置）——否则绝不接受调用方控制的 HTML。
    if (actionIcon) {
      btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:5px;">${actionIcon}<span></span></span>`;
      btn.querySelector('span span').textContent = actionLabel;
    } else {
      btn.textContent = actionLabel;
    }
    // toast 本身是 `pointer-events: none`，因此不会阻挡下方的点击。
    // 有了操作按钮后，我们需要将 toast 和按钮都设置为可交互，
    // 以便用户能够点击撤销。该标志会在下一次普通的 showToast / showError
    // 调用时重置（这些调用会覆盖 textContent，从而移除按钮，
    // 同时我们在下方清除内联样式）。
    btn.style.cssText = 'padding:2px 10px;border:1px solid var(--fg);border-radius:4px;background:none;color:var(--fg);cursor:pointer;font-size:12px;pointer-events:auto;display:inline-flex;align-items:center;';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toastEl.classList.remove('show');
      onAction();
    });
    stack.appendChild(btn);

    // 键盘快捷键提示（Ctrl+Z / ⌘Z）在触摸设备上没有意义——
    // 在移动端跳过它们，这样 toast 只显示撤销按钮。
    if (actionHint && window.innerWidth > 768) {
      const hint = document.createElement('span');
      hint.textContent = actionHint;
      hint.style.cssText = 'font-size:9px;opacity:0.55;letter-spacing:0.4px;text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin-top:1px;pointer-events:none;';
      stack.appendChild(hint);
    }

    toastEl.appendChild(stack);

    // 小 × 按钮用于关闭 toast 而不执行操作。当用户已经执行了操作
    // （或者只是不想看到这个横幅）时非常有用。
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', t('ui.dismiss'));
    closeBtn.title = t('ui.dismiss');
    closeBtn.textContent = '\u00d7';
    closeBtn.style.cssText = 'margin-left:8px;padding:0;width:20px;height:20px;line-height:1;border:none;background:none;color:var(--fg);opacity:0.55;cursor:pointer;font-size:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;pointer-events:auto;';
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.opacity = '1'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0.55'; });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      clearTimeout(toastEl._hideTimer);
      toastEl.classList.add('exiting');
      toastEl.classList.remove('show');
    });
    toastEl.appendChild(closeBtn);

    toastEl.style.pointerEvents = 'auto';
  } else {
    // 无操作按钮——恢复默认的非阻塞行为。
    toastEl.style.pointerEvents = '';
  }

  // 通过 CSS 固定到右上角——清除任何遗留的内联覆盖，
  // 使从右侧滑入 / 向左侧滑出的过渡能够干净运行。
  toastEl.style.left = '';
  toastEl.style.transform = '';
  toastEl.classList.remove('exiting');
  toastEl.classList.add('show');
  clearTimeout(toastEl._hideTimer);
  toastEl._hideTimer = setTimeout(() => {
    // 添加 `exiting` 类，使 CSS 规则将 toast 向左滑出，
    // 而不是向右滑回（回到它来的地方）。我们复用同一个
    // .toast 基础样式；.exiting 覆盖了静态的 transform。
    toastEl.classList.add('exiting');
    toastEl.classList.remove('show');
    // 重置 pointer-events，确保带有操作按钮的 toast（之前设置为 'auto'
    // 以便按钮可点击）在滑出后不再拦截点击。之前只在
    // 下一次普通 toast 时才清除，因此残留的操作 toast 可能在右上角
    // "锁定"交互。
    toastEl.style.pointerEvents = '';
  }, duration);
}

/**
 * 显示错误 toast 消息
 */
export function showError(msg) {
  if (!toastEl) {
    toastEl = document.getElementById('toast');
  }
  _wireToastSwipe(toastEl);
  toastEl.textContent = msg;
  toastEl.classList.add('error');
  toastEl.style.left = '';
  toastEl.style.transform = '';
  toastEl.classList.remove('exiting');
  toastEl.classList.add('show');
  clearTimeout(toastEl._hideTimer);
  toastEl._hideTimer = setTimeout(() => {
    toastEl.classList.add('exiting');
    toastEl.classList.remove('show');
  }, 3000);
}

/**
 * 使用 rAF 插值平滑滚动聊天记录到底部。
 * 在流式输出期间进行节流，以免与用户滚动冲突。
 */
let _scrollThrottleTimer = null;
export function scrollHistory() {
  if (!autoScrollEnabled) return;
  if (!_scrollBox) {
    _scrollBox = document.getElementById('chat-history');
  }
  // 节流：每 500ms 最多启动一次新的滚动动画
  if (_scrollThrottleTimer) return;
  _scrollThrottleTimer = setTimeout(() => { _scrollThrottleTimer = null; }, 500);
  if (!_scrollRafId) {
    _scrollRafId = requestAnimationFrame(_smoothScrollStep);
  }
}

function _smoothScrollStep() {
  const box = _scrollBox;
  if (!box || !autoScrollEnabled) {
    _scrollRafId = null;
    return;
  }
  const target = box.scrollHeight - box.clientHeight;
  const current = box.scrollTop;
  const diff = target - current;

  // 如果用户向上滚动了很多，不要强制拉回底部
  if (diff > 300) {
    _scrollRafId = null;
    return;
  }

  if (diff <= 1) {
    box.scrollTop = target;
    _scrollRafId = null;
    return;
  }

  // 插值：温和地追赶
  const factor = window.innerWidth <= 768 ? 0.4 : 0.2;
  box.scrollTop = current + diff * factor;
  _scrollRafId = requestAnimationFrame(_smoothScrollStep);
}

/**
 * 即时滚动到底部——用于非流式场景，
 * 例如加载历史记录或切换会话。
 */
export function scrollHistoryInstant() {
  if (!_scrollBox) {
    _scrollBox = document.getElementById('chat-history');
  }
  if (_scrollBox) {
    _scrollBox.scrollTop = _scrollBox.scrollHeight;
  }
}

/**
 * 启用/禁用自动滚动
 */
export function setAutoScroll(enabled) {
  autoScrollEnabled = enabled;
}

/**
 * 获取自动滚动状态
 */
export function getAutoScroll() {
  return autoScrollEnabled;
}

/**
 * 根据内容自动调整 textarea 高度
 */
export function autoResize(textarea) {
  const lineHeight = parseInt(getComputedStyle(textarea).lineHeight);
  const isMobile = window.innerWidth <= 768;
  const maxHeight = isMobile ? 150 : lineHeight * 8;

  // 使用隐藏的克隆节点来测量，不干扰真实的 textarea
  let clone = textarea._resizeClone;
  if (!clone) {
    clone = textarea.cloneNode(false);
    clone.style.cssText = getComputedStyle(textarea).cssText;
    clone.style.position = 'absolute';
    clone.style.visibility = 'hidden';
    clone.style.height = '0';
    clone.style.transition = 'none';
    clone.style.overflow = 'hidden';
    clone.style.pointerEvents = 'none';
    clone.style.zIndex = '-1';
    textarea.parentNode.appendChild(clone);
    textarea._resizeClone = clone;
  }
  clone.style.width = textarea.offsetWidth + 'px';
  clone.value = textarea.value;
  clone.style.height = '0';
  const newHeight = Math.min(Math.max(clone.scrollHeight, lineHeight), maxHeight);
  textarea.style.height = newHeight + 'px';
  textarea.style.overflow = newHeight >= maxHeight ? 'auto' : 'hidden';
}

/**
 * 防抖函数，用于性能优化
 */
export function debounce(func, wait) {
  let timeout;
  return function(...args) {
    const later = () => {
      timeout = null;
      func.apply(this, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * 通过 ID 获取元素（工具辅助函数）
 */
export function el(id) {
  return document.getElementById(id);
}

/**
 * 带样式的确认对话框——替代原生浏览器 confirm()。
 * 返回 Promise<boolean>。
 */
export function styledConfirm(message, { confirmText = t('ui.confirm'), cancelText = t('ui.cancel'), danger = false } = {}) {
  return new Promise(resolve => {
    // 复用或创建模态框
    let overlay = document.getElementById('styled-confirm-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'styled-confirm-overlay';
      overlay.className = 'modal';
      overlay.innerHTML =
        '<div class="modal-content styled-confirm-box" role="dialog" aria-modal="true" aria-labelledby="styled-confirm-title" aria-describedby="styled-confirm-msg">' +
          '<div class="modal-header"><h4 id="styled-confirm-title">' + t('ui.confirm') + '</h4></div>' +
          '<div class="modal-body"><p id="styled-confirm-msg"></p></div>' +
          '<div class="modal-footer">' +
            '<button id="styled-confirm-cancel"></button>' +
            '<button id="styled-confirm-ok"></button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
    }

    const msgEl = document.getElementById('styled-confirm-msg');
    const okBtn = document.getElementById('styled-confirm-ok');
    const cancelBtn = document.getElementById('styled-confirm-cancel');

    msgEl.textContent = message;
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.className = danger ? 'confirm-btn confirm-btn-danger' : 'confirm-btn confirm-btn-primary';
    cancelBtn.className = 'confirm-btn confirm-btn-secondary';

    // 记住之前获得焦点的元素，以便对话框关闭时恢复。
    const _prevFocus = document.activeElement;
    overlay.classList.remove('hidden');
    overlay.style.display = '';

    function cleanup(result) {
      overlay.classList.add('hidden');
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      try { _prevFocus && _prevFocus.focus && _prevFocus.focus(); } catch {}
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === overlay) cleanup(false); }
    function onKey(e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const active = document.activeElement;
        if (active === okBtn) cancelBtn.focus();
        else okBtn.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        cleanup(false);
      } else if (e.key === 'Tab') {
        // 将焦点困在对话框内，防止 Tab 键跑到后面的页面元素。
        e.preventDefault();
        const f = [cancelBtn, okBtn];
        const i = f.indexOf(document.activeElement);
        const n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i >= f.length - 1 ? 0 : i + 1);
        f[n].focus();
      }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    okBtn.focus();
  });
}

/**
 * 带样式的文本输入提示框——替代原生 window.prompt()。
 * 返回用户输入的去除首尾空格后的字符串，取消 / Escape / 点击背景则返回 null。
 */
export function styledPrompt(message, {
  title = t('ui.name'),
  defaultValue = '',
  placeholder = '',
  confirmText = t('ui.save'),
  cancelText = t('ui.cancel'),
  maxLength = 80,
} = {}) {
  return new Promise(resolve => {
    let overlay = document.getElementById('styled-prompt-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'styled-prompt-overlay';
      overlay.className = 'modal';
      overlay.innerHTML =
        '<div class="modal-content styled-confirm-box styled-prompt-box" role="dialog" aria-modal="true" aria-labelledby="styled-prompt-title" aria-describedby="styled-prompt-msg">' +
          '<div class="modal-header"><h4 id="styled-prompt-title"></h4></div>' +
          '<div class="modal-body">' +
            '<p id="styled-prompt-msg"></p>' +
            '<input type="text" id="styled-prompt-input" class="styled-prompt-input" />' +
          '</div>' +
          '<div class="modal-footer">' +
            '<button id="styled-prompt-cancel" class="confirm-btn confirm-btn-secondary"></button>' +
            '<button id="styled-prompt-ok" class="confirm-btn confirm-btn-primary"></button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
    }

    const titleEl = document.getElementById('styled-prompt-title');
    const msgEl = document.getElementById('styled-prompt-msg');
    const input = document.getElementById('styled-prompt-input');
    const okBtn = document.getElementById('styled-prompt-ok');
    const cancelBtn = document.getElementById('styled-prompt-cancel');

    titleEl.textContent = title;
    msgEl.textContent = message || '';
    msgEl.style.display = message ? '' : 'none';
    input.value = defaultValue || '';
    input.placeholder = placeholder || '';
    input.maxLength = maxLength;
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;

    // 记住之前获得焦点的元素，以便对话框关闭时恢复。
    const _prevFocus = document.activeElement;
    overlay.classList.remove('hidden');
    overlay.style.display = '';

    function cleanup(result) {
      overlay.classList.add('hidden');
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      input.removeEventListener('keydown', onInputKey);
      try { _prevFocus && _prevFocus.focus && _prevFocus.focus(); } catch {}
      resolve(result);
    }
    function onOk() { cleanup((input.value || '').trim()); }
    function onCancel() { cleanup(null); }
    function onBackdrop(e) { if (e.target === overlay) cleanup(null); }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        cleanup(null);
      } else if (e.key === 'Tab') {
        // 将焦点困在对话框内（输入框 → 取消 → 确认 → 输入框 …）。
        e.preventDefault();
        const f = [input, cancelBtn, okBtn];
        const i = f.indexOf(document.activeElement);
        const n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i >= f.length - 1 ? 0 : i + 1);
        f[n].focus();
      }
    }
    function onInputKey(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        onOk();
      }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    input.addEventListener('keydown', onInputKey);

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

// esc() 的查找表；从 replace 回调中提升出来，
// 这样只需分配一次，而不是每个匹配字符都分配一次。
const _ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/**
 * HTML 转义字符串以防范 XSS。
 * 规范实现——其他模块应使用 uiModule.esc() 而不是本地拷贝。
 */
export function esc(s) {
  return (s || '').replace(/[&<>"']/g, (m) => _ESC_MAP[m]);
}

// ── 移动端：抑制背景上的合成 click/mousedown ──
// 当触摸在 .modal-content 内开始时，设置一个标志，
// 使背景上的合成鼠标事件被忽略。
let _touchInsideModal = false;
if ('ontouchstart' in window) {
  document.addEventListener('touchstart', (e) => {
    if (e.target.closest('.modal-content')) {
      _touchInsideModal = true;
    }
  }, { passive: true });
  document.addEventListener('touchend', () => {
    // 短暂延迟后清除——合成 click 大约在 touchend 后 300ms 触发
    setTimeout(() => { _touchInsideModal = false; }, 400);
  }, { passive: true });
}

/**
 * 检查在移动端是否应抑制背景关闭。
 * 其他模块可以调用此函数来守卫自己的背景处理程序。
 */
export function isTouchInsideModal() {
  return _touchInsideModal;
}

// 滚动时关闭浮动的下拉菜单/弹出框，防止它们漂移
function _initScrollDismiss() {
  const chatHistory = document.getElementById('chat-history');
  if (chatHistory) {
    chatHistory.addEventListener('scroll', () => {
      chatHistory.querySelectorAll('.dropdown.show').forEach(d => d.classList.remove('show'));
      document.querySelectorAll('.ctx-popup').forEach(dismissOrRemove);
    }, { passive: true });
  } else {
    // 如果元素还不存在，重试一次
    setTimeout(_initScrollDismiss, 500);
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initScrollDismiss);
} else {
  _initScrollDismiss();
}

/**
 * 返回空状态图标的 SVG 字符串。`kind` 可以是
 * 'smiley' | 'sad' | 'neutral'。返回的 <svg> 没有内联样式——
 * 调用方用 `<span style="vertical-align:-3px;margin-left:6px;">…</span>`
 * （或类似方式）包裹，以实现所需的各站点视觉微调。
 */
export function emptyStateIcon(kind) {
  const SVG_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  const SVG_CLOSE = '</svg>';
  let inner;
  switch (kind) {
    case 'sad':
      inner = '<circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>';
      break;
    case 'neutral':
      inner = '<circle cx="12" cy="12" r="10"/><line x1="8" y1="15" x2="16" y2="15"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>';
      break;
    case 'smiley':
    default:
      inner = '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>';
      break;
  }
  return SVG_OPEN + inner + SVG_CLOSE;
}

const uiModule = {
  copyToClipboard,
  showToast,
  showError,
  styledConfirm,
  styledPrompt,
  scrollHistory,
  scrollHistoryInstant,
  setAutoScroll,
  getAutoScroll,
  autoResize,
  debounce,
  el,
  esc,
  isTouchInsideModal,
  emptyStateIcon,
  registerMenuDismiss
};

export default uiModule;

// 将带样式的确认对话框暴露到全局，使任何模块都可以用带主题的对话框
// 替代原生浏览器 confirm()——即使是未导入 uiModule 的文件。
// 用法: `if (!await window.styledConfirm(msg, { danger:true })) return;`
if (typeof window !== 'undefined') {
  window.styledConfirm = styledConfirm;
}

// ── 移动端：清除进入动画，使内联 transform 能用于拖动 ──
// CSS `animation: sheet-enter ... forwards` 会保持最终的 transform，
// 阻止任何内联样式更改。动画完成后我们将其清除。
if ('ontouchstart' in window || window.innerWidth <= 768) {
  document.addEventListener('animationend', (e) => {
    if (e.animationName === 'sheet-enter' &&
        (e.target.classList.contains('modal-content') || e.target.id === 'theme-popup')) {
      e.target.classList.add('sheet-ready');
    }
  });
  // 当模态框重新显示时，移除 sheet-ready 以使进入动画再次播放
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'class') {
        const modal = m.target;
        if (modal.classList.contains('modal') && !modal.classList.contains('hidden')) {
          const content = modal.querySelector('.modal-content') || modal.querySelector('#theme-popup');
          if (content) {
            content.classList.remove('sheet-ready', 'modal-closing');
          }
        }
      }
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
}

// ── 移动端：底部弹出式模态框的下滑关闭 ──
// 手指跟随拖动，支持基于速度的关闭。
// 可以从抓取手柄、标题栏，或当内容滚动到顶部时从弹出层的任意位置触发。
if ('ontouchstart' in window) {
  const DISMISS_THRESHOLD = 50;    // px——拖动超过此距离则关闭
  const VELOCITY_THRESHOLD = 0.3;  // px/ms——快速滑动即使未达到距离阈值也关闭
  const RUBBER_RESISTANCE = 0.35;  // 向上拖动超过原点时的橡皮筋阻力

  let _swipeTarget = null;
  let _startY = 0, _startX = 0;
  let _lastY = 0, _lastT = 0;
  let _velocity = 0;
  let _dragging = false;    // 一旦确认是垂直拖动即为 true
  let _cancelled = false;   // 如果检测到水平移动则为 true

  // 关闭所有通过 position:fixed 悬挂在 body 上的浮动下拉菜单/菜单。
  // 在滑动关闭手势开始时调用，避免弹出层滑走后菜单孤立在页面上。
  function _closeFloatingDropdownsForSwipe() {
    document.querySelectorAll(
      '.email-card-dropdown, .hwfit-cached-dropdown, .cookbook-saved-menu, .cookbook-dep-menu'
    ).forEach(d => {
      if (d._anchor) d._anchor.classList.remove('cookbook-menu-active', 'reader-more-active');
      // 已注册的菜单通过自身的 dismiss 来销毁（释放 Escape 栈条目）；
      // 未注册的（email/dep）直接移除。
      dismissOrRemove(d);
    });
  }

  document.addEventListener('touchstart', (e) => {
    // 匹配 .modal-content 或 #theme-popup（它作为 modal-content 使用但有自己的 ID）
    const content = e.target.closest('.modal-content') || e.target.closest('#theme-popup');
    if (!content) return;

    // 图片编辑器拥有其容器内的所有触摸事件，以便用户
    // 可以绘画/移动图层/绘制选区，而模态框不会将其
    // 解释为滑动关闭手势。当触摸从编辑器区域内开始
    // 时，完全跳过滑动初始化。
    if (e.target.closest('.gallery-editor, .gallery-editor-container')) return;
    // 内部垂直拖动手柄（例如用于调整日程详情面板大小的
    // cal-splitter）自行处理垂直触摸。如果我们不在这里退出，
    // 滑动关闭路径也会追踪触摸，并在用户拖动手柄时将整个模态框
    // 向下滑动。[data-no-swipe-dismiss] 钩子让其他组件也能
    // 以相同方式选择退出，无需在此硬编码其选择器。
    if (e.target.closest('.cal-splitter, [data-no-swipe-dismiss]')) return;

    // 仅允许从标题栏或抓取手柄（顶部 48px）进行滑动关闭
    const isHeader = !!e.target.closest('.modal-header');
    const isButton = !!e.target.closest('button, input, select, label');
    if (isHeader && isButton) return; // 让按钮点击正常通过
    const touch = e.touches[0];
    const contentRect = content.getBoundingClientRect();
    const isGrabZone = (touch.clientY - contentRect.top) < 48;
    // 当弹出层已经滚动到顶部时，也允许从其任意位置滑动关闭——
    // 感觉自然，符合 iOS 底部弹出层的 UX。
    const isAtScrollTop = content.scrollTop <= 0;

    if (!isHeader && !isGrabZone && !isAtScrollTop) return; // 主体触摸 → 让原生滚动处理

    _swipeTarget = content;
    // 确保 CSS 动画已清除，使内联 transform 生效
    content.classList.add('sheet-ready');
    content.style.animation = 'none';
    _startY = touch.clientY;
    _startX = touch.clientX;
    _lastY = _startY;
    _lastT = e.timeStamp;
    _velocity = 0;
    _dragging = false;
    _cancelled = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!_swipeTarget || _cancelled) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - _startX);
    const dy = touch.clientY - _startY;

    // 前几个像素：判断这是水平滚动还是内容滚动
    if (!_dragging) {
      if (dx > 40 && dx > Math.abs(dy) * 2) {
        _swipeTarget.style.transform = '';
        _swipeTarget = null;
        _cancelled = true;
        return;
      }
      if (Math.abs(dy) > 8) {
        // 找到触摸点最近的滚动祖先元素
        let scrollEl = e.target;
        while (scrollEl && scrollEl !== _swipeTarget) {
          if (scrollEl.scrollHeight > scrollEl.clientHeight + 1) {
            const ov = getComputedStyle(scrollEl).overflowY;
            if (ov === 'auto' || ov === 'scroll') break;
          }
          scrollEl = scrollEl.parentElement;
        }
        const hasScroller = scrollEl && scrollEl !== _swipeTarget;
        // 如果触摸在可滚动的子元素内，让原生滚动处理
        if (hasScroller) {
          _swipeTarget.style.transform = '';
          _swipeTarget = null;
          _cancelled = true;
          return;
        }
        // 如果向上滑动且 modal-content 本身可滚动，让原生处理
        if (dy < 0 && _swipeTarget.scrollHeight > _swipeTarget.clientHeight + 1) {
          _swipeTarget.style.transform = '';
          _swipeTarget = null;
          _cancelled = true;
          return;
        }
        // 如果向下滑动但内容未在顶部，让原生滚动处理
        if (dy > 0 && _swipeTarget.scrollTop > 0) {
          _swipeTarget.style.transform = '';
          _swipeTarget = null;
          _cancelled = true;
          return;
        }
        _dragging = true;
        _swipeTarget.style.transition = 'none';
        _swipeTarget.style.willChange = 'transform';
        // 滑动开始——关闭所有浮动菜单/下拉菜单，避免弹出层
        // 滑走后它们孤立在页面上。覆盖邮件阅读器的更多菜单、
        // cookbook 的 serve kebab + 已保存配置，以及任何其他
        // 通过 _anchor 挂在 body 上的元素。
        _closeFloatingDropdownsForSwipe();
      } else {
        return;
      }
    }

    // 追踪速度（指数移动平均）
    const dt = e.timeStamp - _lastT;
    if (dt > 0) {
      const instantV = (touch.clientY - _lastY) / dt;
      _velocity = _velocity * 0.6 + instantV * 0.4;
    }
    _lastY = touch.clientY;
    _lastT = e.timeStamp;

    e.preventDefault();
    if (dy > 0) {
      _swipeTarget.style.transform = `translateY(${dy}px)`;
    } else {
      const rubberDy = dy * RUBBER_RESISTANCE;
      _swipeTarget.style.transform = `translateY(${rubberDy}px)`;
    }
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (!_swipeTarget || !_dragging) {
      _swipeTarget = null;
      return;
    }
    const el = _swipeTarget;
    _swipeTarget = null;

    const dy = _lastY - _startY;
    const shouldDismiss = dy > DISMISS_THRESHOLD || (dy > 20 && _velocity > VELOCITY_THRESHOLD);

    el.style.willChange = '';

    if (shouldDismiss) {
      // 动画滑出——用剩余距离计算时长
      const remaining = el.offsetHeight - dy;
      const speed = Math.max(Math.abs(_velocity), 0.8); // 最低速度
      const duration = Math.min(Math.max(remaining / speed, 120), 300);
      el.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0.4, 1)`;
      el.style.transform = 'translateY(100%)';
      setTimeout(() => {
        const modal = el.closest('.modal');
        if (modal) {
          modal.classList.add('hidden');
          // 某些模态框（日历、邮件库）通过内联 display 样式切换可见性，
          // 这会覆盖 .hidden——清除它以确保模态框真正被关闭。
          modal.style.display = '';
          document.querySelectorAll('#settings-menu-list .list-item.active').forEach(i => i.classList.remove('active'));
          // 通知各模块，使它们可以同步内部打开状态标志
          window.dispatchEvent(new CustomEvent('modal-dismissed', { detail: { id: modal.id } }));
          // 滑走一个工具以显示新的/空的聊天，会重播欢迎
          // "闪屏"揭示——与笔记关闭时同样的好效果。
          // 仅当欢迎屏幕已经是活跃状态（新聊天）时才触发，
          // 所以我们永远不会覆盖已有消息的聊天。
          const ws = document.getElementById('welcome-screen');
          if (ws && !ws.classList.contains('hidden')) {
            window.chatModule?.showWelcomeScreen?.();
          }
        }
        el.classList.remove('sheet-ready');
        el.style.transform = '';
        el.style.transition = '';
        el.style.animation = '';
      }, duration + 10);
    } else {
      // 用弹簧般的缓动弹回原位
      el.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.9, 0.3, 1.05)';
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; el.style.animation = ''; }, 260);
    }
  }, { passive: true });
}

// ---- 点击时将模态框提到最前 ----
{
  let topModalZ = 250;
  document.addEventListener('mousedown', (e) => {
    const modalContent = e.target.closest('.modal-content');
    if (!modalContent) return;
    const modal = modalContent.closest('.modal');
    if (!modal) return;
    topModalZ += 1;
    modal.style.zIndex = topModalZ;
  });

  // 点击背景关闭——为所有模态框统一委托处理
  document.addEventListener('mousedown', (e) => {
    if (_touchInsideModal) return; // 抑制内容滚动产生的合成事件
    if (!e.target.classList.contains('modal')) return;
    const modal = e.target;
    if (modal.classList.contains('hidden')) return;
    const content = modal.querySelector('.modal-content');
    if (content) {
      content.classList.add('modal-closing');
      content.addEventListener('animationend', () => {
        modal.classList.add('hidden');
        content.classList.remove('modal-closing');
      }, { once: true });
      setTimeout(() => {
        if (!modal.classList.contains('hidden')) {
          modal.classList.add('hidden');
          content.classList.remove('modal-closing');
        }
      }, 300);
    } else {
      modal.classList.add('hidden');
    }
  });
}

// ── 移动端：保持获得焦点的输入框在键盘上方可见 ──
// 当模态框内的输入框在移动端获得焦点时，系统键盘
// 覆盖了屏幕下半部分。浏览器本应将输入框滚动到可见区域，
// 但在底部弹出式模态框中，由于它们有自己的滚动容器，
// 这通常会失败——用户只能盲打。
// 在键盘动画显示之后，将输入框滚动到
// 仍可见的视口中部。
if ('ontouchstart' in window || window.innerWidth <= 768) {
  let _kbScrollTimer = null;
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName;
    const isText = tag === 'INPUT' || tag === 'TEXTAREA' ||
                   (tag === 'DIV' && el.isContentEditable);
    if (!isText) return;
    // button/checkbox/radio/range 等类型的 input 不会弹出键盘
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (['button','submit','reset','checkbox','radio','range','color','file','image'].includes(t)) return;
    }
    if (_kbScrollTimer) clearTimeout(_kbScrollTimer);
    // 键盘通常需要 200–300ms 弹起；在此之后执行滚动，
    // 以确保我们知道最终的可见视口高度。
    _kbScrollTimer = setTimeout(() => {
      _kbScrollTimer = null;
      // 如果输入框在当前视口中已经可见（带一个小舒适边距），
      // 则跳过滚动。否则每次重新聚焦——包括当 typeahead 输入框
      // 在每次按键时重建 DOM 导致的程序化重新聚焦——都会
      // 重新滚动模态框，导致页面在用户输入时上下跳动。
      try {
        const r = el.getBoundingClientRect();
        const vh = (window.visualViewport?.height) || window.innerHeight;
        const margin = 24;
        const fullyVisible = r.top >= margin && r.bottom <= vh - margin;
        if (fullyVisible) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch {
        try { el.scrollIntoView(); } catch {}
      }
    }, 300);
  });
}

// ── 全局 Escape 仲裁器：每次按键只关闭一个元素 ──
// 优先级：展开的库卡片 → 打开的聊天思考块 → 最顶层模态框。
// 在捕获阶段运行 + stopImmediatePropagation，使各模态框的 ESC 监听器
// 永远不会也触发（否则会同时关闭多个模态框）。
if (!window._odyEscExpandGuard) {
  window._odyEscExpandGuard = true;

  // 自动将任何变为可见的模态框提升到 z 轴最顶部。
  // 所有模态框共享基础 `.modal` 规则的 `z-index: 250`，因此视觉
  // 层叠回退到 DOM 顺序——这是不可预测的（cookbook 是静态 HTML 节点，
  // calendar 被追加一次后保持不变，compare 和 research 每次打开都重新追加）。
  // 结果：在 cookbook 之后打开 compare 可能导致 compare 渲染在其下方。
  // 每次打开时提升 z-index 保证最近打开的模态框在视觉上和 ESC 处理上都获胜。
  let _zCounter = 1000;
  const _isVisible = (m) => !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none';
  const _promote = (m) => {
    if (!m?.classList?.contains('modal') || !_isVisible(m)) return;
    // 重入保护：设置 style.zIndex 自身会触发 observer 回调。
    // 如果此元素已经固定在顶部（匹配当前计数器），
    // 则跳过，避免进入无限循环。
    const cur = parseInt(m.style.zIndex, 10) || 0;
    if (cur === _zCounter) return;
    m.style.zIndex = String(++_zCounter);
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(n => n.nodeType === 1 && _promote(n));
      else if (m.type === 'attributes' && m.target?.classList?.contains('modal')) _promote(m.target);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  document.querySelectorAll('.modal').forEach(_promote);

  const pickTopModal = () => {
    const modals = [...document.querySelectorAll('.modal')].filter(_isVisible);
    if (!modals.length) return null;
    return modals.reduce((top, m) =>
      (parseInt(getComputedStyle(m).zIndex, 10) || 0) >= (parseInt(getComputedStyle(top).zIndex, 10) || 0)
        ? m : top
    );
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;

    // 按优先级找到要关闭的单个目标，第一个匹配项获胜。
    // 重要：如果有打开的思考块，我们必须自己处理而不
    // 回退到关闭模态框——即使其标题栏缺失（实时聊天在流式传输中
    // 重建思考 DOM，所以标题栏可能短暂缺失）。直接切换 `expanded` 
    // 类作为回退方案，确保 ESC 从不会绕过思考块而命中模态框。
    if (_closeHoveredWindow()) {
      e.stopImmediatePropagation(); e.preventDefault();
      return;
    }
    // 临时的即席菜单（下拉菜单/上下文弹出框）存在于
    // .modal 系统之外，在 escMenuStack 中注册了关闭回调。优先关闭
    // 最近打开的那个——这样在模态框上打开的菜单会先于模态框关闭——
    // 并且在下方的文本输入保护之前执行，因为菜单可能拥有
    // 已获焦点的输入框（例如搜索下拉菜单）。
    if (dismissTopMenu()) {
      e.stopImmediatePropagation(); e.preventDefault();
      return;
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const expanded = document.querySelector('.doclib-card-expanded');
    const think = document.querySelector('.thinking-content.expanded');
    if (expanded) {
      e.stopImmediatePropagation(); e.preventDefault();
      try { expanded.click(); } catch {}
      return;
    }
    if (think) {
      e.stopImmediatePropagation(); e.preventDefault();
      const thinkHeader = think.closest('.thinking-section')?.querySelector('.thinking-header[data-thinking-id]');
      if (thinkHeader) { try { thinkHeader.click(); } catch {} }
      else {
        // 未找到标题栏——直接折叠内容
        try { think.classList.remove('expanded'); } catch {}
      }
      return;
    }
    const galleryEditor = document.getElementById('gallery-editor-container');
    const galleryModal = galleryEditor?.closest('.modal');
    const galleryEditing = !!(
      galleryEditor &&
      galleryModal &&
      !galleryModal.classList.contains('hidden') &&
      getComputedStyle(galleryEditor).display !== 'none' &&
      galleryEditor.querySelector('.gallery-editor')
    );
    if (galleryEditing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const settingsModal = document.getElementById('settings-modal');
    if (settingsModal && _isVisible(settingsModal)) {
      const innerForm = settingsModal.querySelector('#unified-intg-form, #set-email-accounts-form');
      if (innerForm && innerForm.style.display !== 'none' && innerForm.children.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        innerForm.style.display = 'none';
        innerForm.innerHTML = '';
        return;
      }
    }
    const topModal = pickTopModal();
    if (!topModal) return;
    const closeBtn = topModal.querySelector('.close-btn, .modal-close-btn, [data-action="close"]');
    e.stopImmediatePropagation();
    e.preventDefault();
    if (closeBtn) { try { closeBtn.click(); } catch {} }
    else { try { topModal.classList.add('hidden'); } catch {} }
  }, true);
}
