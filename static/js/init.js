// Odysseus UI — 初始化脚本
// ES6 模块 — 从 索引.html 内联脚本中提取

import Storage from './storage.js';

function clearFreshComposerRestore() {
  const msgInput = document.getElementById('message');
  if (!msgInput) return;
  const hasSessionTarget = !!(window.location.hash || Storage.get('lastSessionId'));
  if (hasSessionTarget) return;
  if (msgInput.value) {
    msgInput.value = '';
    msgInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

clearFreshComposerRestore();
window.addEventListener('pageshow', clearFreshComposerRestore);

// SECURITY: defense-in-depth state wipe on user switch. If the authenticated
// user is different from the one whose state is cached in this browser,
  // 与浏览器中缓存的用户不同，则清除 localStorage + sessionStorage，
// the previous user's last session id, last-used model, draft chat input,
// or cached lists. The settings-tab Logout button already wipes on
// explicit logout; this catches the cases where a different user 签名s
// in without the previous one 日志记录 out cleanly.
(async () => {
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const liveUser = (data && data.username) || '';
    if (!liveUser) return;
    const KEY = 'odysseus-auth-user';
    const cachedUser = localStorage.getItem(KEY);
    if (cachedUser && cachedUser !== liveUser) {
      const _keepKeys = new Set(['odysseus-last-user', KEY]);
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && !_keepKeys.has(k)) toRemove.push(k);
      }
      toRemove.forEach(k => localStorage.removeItem(k));
      sessionStorage.clear();
      clearFreshComposerRestore();
    }
    localStorage.setItem(KEY, liveUser);
    // Apply per-user privilege gates to the UI. The 后端 enforces these
    // independently — this is purely cosmetic / "don't dangle controls the
    // user can't actually use." Privileges come from /api/auth/status; admins
    // always get the full set so this is a no-op for them.
    try {
      const privs = (data && data.privileges) || {};
      const hideOn = (selector, allowed) => {
        if (allowed === undefined || allowed === true) return;
        document.querySelectorAll(selector).forEach(el => {
          el.style.display = 'none';
        });
      };
      // 文档编辑器 — 溢出菜单按钮 + 文档面板 rail/工具按钮。
      hideOn('#overflow-doc-btn, #tool-doc-btn', privs.can_use_documents);
      // 研究 — 侧边栏工具 + 输入框中的深度研究开关。
      hideOn('#tool-research-btn, #research-toggle-btn', privs.can_use_research);
      // 记忆 & 技能（仅 rail/工具按钮 — UI/API 入口）。
      hideOn('#tool-memory-btn', privs.can_manage_memory);
      // Agent 模式切换 — 通过隐藏 Agent 切换按钮强制设为聊天模式。
      if (privs.can_use_agent === false) {
        const _agent = document.getElementById('mode-agent-btn');
        const _chat = document.getElementById('mode-chat-btn');
        if (_agent) _agent.style.display = 'none';
        if (_chat) { _chat.classList.add('active'); _chat.click?.(); }
      }
    } catch (_) { /* DOM 未就绪或数据格式异常 — UI 权限控制失败不影响功能 */ }
  } catch (_) { /* 匿名/环回模式 — 无需处理 */ }
})();

/* 侧边栏分区默认折叠设置。点击切换处理器本身在
   js/section-management.js 中 — 在两个地方都绑定会导致每次点击
   触发两次切换，表现为"点击无反应"（偶次奇偶性抵消）。
   此处仅保留初始状态应用逻辑。 */
{
  const KEY = Storage.KEYS.SIDEBAR_COLLAPSED;
  const saved = Storage.getJSON(KEY, {});
  const _defaultCollapsed = { 'sessions-section': true };
  document.querySelectorAll('.sidebar .section').forEach((section) => {
    const id = section.id;
    if (!id) return;
    const shouldCollapse = (id in saved) ? saved[id] : !!_defaultCollapsed[id];
    if (shouldCollapse) section.classList.add('collapsed');
  });
  // Sessions-section 通知 dot: clear when the section becomes
  // expanded. Watch the class with MutationObserver so we don't need a
  // 点击处理器 (which would race the section-management one).
  const sessionsSection = document.getElementById('sessions-section');
  if (sessionsSection) {
    new MutationObserver(() => {
      if (!sessionsSection.classList.contains('collapsed')) {
        const dot = document.getElementById('chats-notif-dot');
        if (dot) dot.style.display = 'none';
      }
    }).observe(sessionsSection, { attributes: true, attributeFilter: ['class'] });
  }
}

/* Publish the icon rail's + wide sidebar's current widths as CSS vars so
   fullscreen panels can reserve space on the left for whichever is
   currently visible (the two are mutually exclusive — see
   sidebar-layout.js:57). Updates live as either resizes; toggles to 0
   when hidden so the fullscreen view reclaims the space. */
{
  const rail = document.getElementById('icon-rail');
  const sidebar = document.getElementById('sidebar');
  const root = document.documentElement;
  const _measure = (el) => {
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    const hidden = cs.display === 'none' || cs.visibility === 'hidden';
    if (hidden) return 0;
    return Math.round(el.getBoundingClientRect().width);
  };
  const _sync = () => {
    // 图标 rail 宽度
    const rw = _measure(rail);
    if (rw === null) {
      root.style.removeProperty('--icon-rail-w');
    } else if (rw > 0) {
      root.style.setProperty('--icon-rail-w', rw + 'px');
    } else {
      // 可见但尚未布局的 rail 宽度为 0：不覆盖 CSS 回退值；
      // 改为下一帧重新同步。
      const cs = rail && window.getComputedStyle(rail);
      const hidden = !cs || cs.display === 'none' || cs.visibility === 'hidden';
      if (hidden) {
        root.style.setProperty('--icon-rail-w', '0px');
      } else {
        root.style.removeProperty('--icon-rail-w');
        requestAnimationFrame(_sync);
        return;
      }
    }
    // 侧边栏宽度 — `.sidebar.hidden` 折叠为 width: 0，因此
    // 隐藏状态下的测量自然为 0。
    const sw = _measure(sidebar);
    if (sw === null) {
      root.style.removeProperty('--sidebar-w');
    } else {
      root.style.setProperty('--sidebar-w', sw + 'px');
    }
  };
  _sync();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(_sync);
    if (rail) ro.observe(rail);
    if (sidebar) ro.observe(sidebar);
  }
  // Class 切换（sidebar.hidden ↔ visible）不会立即触发 ResizeObserver，
  // 需要等到下一帧布局完成后；同时监听 class 属性，以便用户点击汉堡菜单
  // 时立即重新同步。
  if (sidebar && typeof MutationObserver !== 'undefined') {
    new MutationObserver(_sync).observe(sidebar, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  if (rail && typeof MutationObserver !== 'undefined') {
    new MutationObserver(_sync).observe(rail, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  window.addEventListener('resize', _sync);
}

/* 让最小化的工具 chips 保持在输入框上方。当前的 modalManager
   dock 和旧版回退 dock 都使用此根级间距。 */
{
  const root = document.documentElement;
  const chatBar = document.querySelector('.chat-input-bar');
  const attachStrip = document.getElementById('attach-strip');
  const chatContainer = document.getElementById('chat-container');
  const _syncComposerClearance = () => {
    let top = window.innerHeight;
    for (const el of [attachStrip, chatBar]) {
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.height > 0) top = Math.min(top, rect.top);
    }
    const clearance = Math.max(12, Math.ceil(window.innerHeight - top + 8));
    root.style.setProperty('--composer-clearance', clearance + 'px');
  };
  requestAnimationFrame(_syncComposerClearance);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(_syncComposerClearance);
    if (chatBar) ro.observe(chatBar);
    if (attachStrip) ro.observe(attachStrip);
  }
  if (chatContainer && typeof MutationObserver !== 'undefined') {
    new MutationObserver(_syncComposerClearance).observe(chatContainer, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  if (chatBar) chatBar.addEventListener('transitionend', _syncComposerClearance);
  window.addEventListener('resize', _syncComposerClearance);
}

/* ---- 可调整大小的侧边栏 — 拖拽边缘调整宽度，缩小则折叠，拖拽 rail 边缘则展开 ---- */
{
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resize-handle');
  const railHandle = document.getElementById('rail-resize-handle');
  const iconRail = document.getElementById('icon-rail');
  if (sidebar && handle) {

  const STORAGE_KEY = Storage.KEYS.SIDEBAR_WIDTH;
  const MIN_WIDTH = 200;
  const MAX_WIDTH = 700;
  const COLLAPSE_THRESHOLD = 150;

  function getSavedWidth() {
    const w = parseInt(Storage.get(STORAGE_KEY, '340'), 10);
    return (w >= MIN_WIDTH && w <= MAX_WIDTH) ? w : 340;
  }

  // 恢复已保存的宽度
  const savedWidth = Storage.get(STORAGE_KEY);
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (w >= MIN_WIDTH && w <= MAX_WIDTH) sidebar.style.width = w + 'px';
  }

  let startX, startWidth, isRight, collapsed, expanding;

  // --- 从侧边栏边缘拖拽调整大小/折叠 ---
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    expanding = false;
    isRight = sidebar.classList.contains('right-side');
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    collapsed = false;
    sidebar.classList.add('resizing');
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDrag);
  });

  // --- 从图标 rail 边缘拖拽展开侧边栏 ---
  if (railHandle) {
    railHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      expanding = true;
      isRight = sidebar.classList.contains('right-side') ||
                iconRail.classList.contains('right-side');
      startX = e.clientX;
      collapsed = false;

      // 以 0 宽度显示侧边栏，以便后续展开
      sidebar.classList.remove('hidden');
      sidebar.classList.add('resizing');
      sidebar.style.width = '0px';
      sidebar.style.opacity = '0.3';
      railHandle.classList.add('dragging');

      document.addEventListener('mousemove', onExpandDrag);
      document.addEventListener('mouseup', stopExpandDrag);
    });
  }

  function onDrag(e) {
    const delta = isRight ? (startX - e.clientX) : (e.clientX - startX);
    const rawWidth = startWidth + delta;

    if (rawWidth < COLLAPSE_THRESHOLD) {
      sidebar.style.width = Math.max(0, rawWidth) + 'px';
      sidebar.style.opacity = Math.max(0.2, rawWidth / COLLAPSE_THRESHOLD);
      collapsed = true;
    } else {
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, rawWidth));
      sidebar.style.width = newWidth + 'px';
      sidebar.style.opacity = '';
      collapsed = false;
    }
  }

  function stopDrag() {
    sidebar.classList.remove('resizing');
    handle.classList.remove('dragging');
    sidebar.style.opacity = '';
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);

    if (collapsed) {
      sidebar.style.width = '';
      sidebar.classList.add('hidden');
      if (typeof syncRailSide === 'function') syncRailSide();
    } else {
      const finalWidth = parseInt(sidebar.style.width, 10);
      if (finalWidth >= MIN_WIDTH) {
        Storage.set(STORAGE_KEY, String(finalWidth));
      }
    }
  }

  function onExpandDrag(e) {
    const delta = isRight ? (startX - e.clientX) : (e.clientX - startX);
    const rawWidth = Math.max(0, delta);

    if (rawWidth < COLLAPSE_THRESHOLD) {
      sidebar.style.width = rawWidth + 'px';
      sidebar.style.opacity = Math.max(0.3, rawWidth / COLLAPSE_THRESHOLD);
      collapsed = true;
    } else {
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, rawWidth));
      sidebar.style.width = newWidth + 'px';
      sidebar.style.opacity = '';
      collapsed = false;
    }
  }

  function stopExpandDrag() {
    sidebar.classList.remove('resizing');
    sidebar.style.opacity = '';
    if (railHandle) railHandle.classList.remove('dragging');
    document.removeEventListener('mousemove', onExpandDrag);
    document.removeEventListener('mouseup', stopExpandDrag);

    if (collapsed) {
      // 拖拽距离不够 — 回弹到图标 rail
      sidebar.style.width = '';
      sidebar.classList.add('hidden');
      if (typeof syncRailSide === 'function') syncRailSide();
    } else {
      // 已展开 — 保存宽度并同步
      const finalWidth = parseInt(sidebar.style.width, 10);
      if (finalWidth >= MIN_WIDTH) {
        Storage.set(STORAGE_KEY, String(finalWidth));
      }
      if (typeof syncRailSide === 'function') syncRailSide();
    }
  }

  } // end if (sidebar && handle)
}

/* ---- 移动端视口修复 — 虚拟键盘打开时保持聊天可见 ---- */
{
  if (window.visualViewport) {
    let _lastVVHeight = window.visualViewport.height;
    window.visualViewport.addEventListener('resize', function() {
      const vv = window.visualViewport;
      const keyboardOpened = vv.height < _lastVVHeight - 50;
      _lastVVHeight = vv.height;
      if (keyboardOpened) {
        var chatHistory = document.getElementById('chat-history');
        if (chatHistory) {
          requestAnimationFrame(function() {
            chatHistory.scrollTop = chatHistory.scrollHeight;
          });
        }
      }
    });
  }

  // 移动端键盘打开时淡出欢迎屏幕（输入框聚焦/失焦）
  if ('ontouchstart' in window) {
    document.addEventListener('DOMContentLoaded', function() {
      var _msgInput = document.getElementById('message');
      if (!_msgInput) return;
      _msgInput.addEventListener('focus', function() {
        var welcome = document.getElementById('welcome-screen');
        if (welcome && !welcome.classList.contains('hidden')) {
          welcome.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
          welcome.style.opacity = '0';
          welcome.style.transform = 'translate(-50%, -50%) scale(0.92)';
        }
      });
      _msgInput.addEventListener('blur', function() {
        var welcome = document.getElementById('welcome-screen');
        if (welcome && !welcome.classList.contains('hidden')) {
          welcome.style.transition = 'opacity 0.3s ease, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
          welcome.style.opacity = '';
          welcome.style.transform = '';
        }
      });
    });
  }
}

/* ── Release welcome-screen entrance animations once the page is settled ──
   启动画面（#welcome-screen / .welcome-name）的入场动画由 CSS
   by CSS (`body:not(.welcome-ready)`) until this runs, so they no longer play
   while fonts are loading and the layout is still shifting on first paint
   (which made the splash "go haywire"). We flip the flag after fonts are ready
   plus a couple of frames, with load + timeout fallbacks so the splash is never
   left hidden. Lives here (a network-first module) rather than inline in
   index.html so it updates in lockstep with the gating CSS. */
(function () {
  let fired = false;
  function release() {
    if (fired) return;
    fired = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => document.body.classList.add('welcome-ready'))
    );
  }
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(release); } catch (_) {}
  if (document.readyState === 'complete') release();
  else window.addEventListener('load', release);
  setTimeout(release, 1200);  // 硬回退 — 确保启动画面不会一直隐藏
})();
