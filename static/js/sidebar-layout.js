// ============================================
// 侧边栏布局 — 图标栏、汉堡菜单循环、移动端背景遮罩和滑动
// ============================================

let _syncRailSideFn = null;

/**
 * 获取当前的 syncRailSide 函数引用。
 * 需要它是因为它在初始设置后会被修补。
 */
export function syncRailSide() {
  if (_syncRailSideFn) _syncRailSideFn();
}

/**
 * 初始化侧边栏布局：图标栏、汉堡菜单循环、移动端背景遮罩、滑动手势。
 * @param {Object} Storage - 存储模块
 * @param {Object} opts
 * @param {Object} opts.documentModule - 文档模块（用于 swapSide）
 * @param {Function} opts._closeCompareIfActive
 * @param {Function} opts._deactivateIncognito
 * @param {Object} opts.presetsModule
 * @param {Object} opts.sessionModule
 * @param {Function} opts.el - 元素查找辅助函数
 * @param {*} opts._defaultChat - 默认聊天配置
 * @param {Function} opts._syncResearchIndicator
 */
export function initSidebarLayout(Storage, opts) {
  const {
    documentModule, _closeCompareIfActive, _deactivateIncognito,
    presetsModule, sessionModule, el, _defaultChat, _syncResearchIndicator
  } = opts;

  // ── 图标栏 + 侧边栏切换 ──
  const iconRail = document.getElementById('icon-rail');
  const hamburgerBtn = document.getElementById('hamburger-btn');

  function _syncRailSideCore() {
    const sidebar = document.getElementById('sidebar');
    if (!iconRail) return;
    const isRight = sidebar.classList.contains('right-side');
    const sidebarHidden = sidebar.classList.contains('hidden');
    const railHidden = iconRail.classList.contains('rail-hidden');
    const isMobileMini = iconRail.classList.contains('mobile-mini');
    iconRail.classList.toggle('right-side', isRight);
    // 在移动端迷你模式下，JS 已设置内联样式 — 不碰它
    if (isMobileMini) {
      // 只更新侧边定位
      if (isRight) {
        iconRail.style.left = 'auto';
        iconRail.style.right = '0';
      } else {
        iconRail.style.left = '0';
        iconRail.style.right = 'auto';
      }
    } else {
      iconRail.style.display = (sidebarHidden && !railHidden) ? '' : 'none';
    }
    // 汉堡菜单始终可见 — 只更新 body class 以便 CSS 布局调整
    if (hamburgerBtn) {
      document.body.classList.toggle('hamburger-right', isRight);
      document.body.classList.toggle('hamburger-left', !isRight);
      document.body.classList.toggle('hamburger-only', sidebarHidden && railHidden);
      document.body.classList.toggle('sidebar-collapsed', sidebarHidden);
    }
    // 保持隐身按钮不遮挡汉堡菜单
    const incogBtn = document.getElementById('incognito-btn');
    if (incogBtn) {
      if (isRight && sidebarHidden) {
        incogBtn.style.right = '48px';
      } else {
        incogBtn.style.right = '';
      }
    }
  }

  // 设置初始引用并全局暴露
  _syncRailSideFn = _syncRailSideCore;
  window.syncRailSide = syncRailSide;

  // 恢复侧边栏位置偏好
  if (Storage.get(Storage.KEYS.SIDEBAR_SIDE) === 'right') {
    document.getElementById('sidebar').classList.add('right-side');
  }
  syncRailSide();

  // 侧边栏内的切换按钮 — 与汉堡菜单行为相同
  const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', (e) => {
      if (hamburgerBtn) hamburgerBtn.click();
    });
  }

  // 新建聊天按钮 — 与点击品牌标志相同
  const chatNewBtn = document.getElementById('chat-new-btn');
  const sidebarNewChat = document.getElementById('sidebar-new-chat-btn');
  [chatNewBtn, sidebarNewChat].forEach(btn => {
    if (btn) btn.addEventListener('click', () => {
      const brandBtn = document.getElementById('sidebar-brand-btn');
      if (brandBtn) brandBtn.click();
    });
  });

  // 汉堡菜单循环：完整侧边栏 → 迷你 → 关闭 → 完整
  // Shift+点击切换侧边栏位置
  let _userToggledSidebar = false;
  let _wasAutoCollapsed = false;

  // 移动端滑动手势使用的"打开侧边栏"辅助函数（在
  // 模块作用域绑定）。它必须设置 _userToggledSidebar，使自动折叠
  // MutationObserver 不会立即重新隐藏它（滑动手势在打开它，
  // 然后 checkSidebarAutoCollapse 因为此标志未设置而重新添加 .hidden
  // — 看起来什么都没发生）。镜像汉堡菜单的移动端打开路径。
  window._odyOpenSidebar = function(side) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    // 移动端上，在对比功能运行时永远不打开侧边栏 — 面板
    // 占据整个屏幕，误触的手势（滑动、拖动停靠标签到关闭按钮）
    // 会弹出侧边栏。通过阻塞开放辅助函数覆盖所有路径。
    const cc = document.getElementById('chat-container');
    if (window.innerWidth < 768 && cc && cc.classList.contains('compare-active')) return;
    _userToggledSidebar = true;
    // 可选择将侧边栏放在特定边缘（滑动手势传递
    // 方向）。持久化它 + 重新锚定文档面板，与
    // Shift+点击汉堡菜单相同。
    if (side === 'left' || side === 'right') {
      const wantRight = side === 'right';
      if (sidebar.classList.contains('right-side') !== wantRight) {
        sidebar.classList.toggle('right-side', wantRight);
        try { Storage.set(Storage.KEYS.SIDEBAR_SIDE, side); } catch (_) {}
        if (documentModule && documentModule.swapSide) { try { documentModule.swapSide(); } catch (_) {} }
      }
    }
    const backdrop = document.getElementById('sidebar-backdrop');
    if (window.innerWidth < 768 && iconRail) { iconRail.classList.remove('mobile-mini'); iconRail.style.cssText = ''; }
    sidebar.classList.remove('hidden');
    if (backdrop && window.innerWidth < 768) backdrop.classList.add('visible');
    syncRailSide();
  };

  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sidebar = document.getElementById('sidebar');
      if (e.shiftKey) {
        sidebar.classList.toggle('right-side');
        Storage.set(Storage.KEYS.SIDEBAR_SIDE, sidebar.classList.contains('right-side') ? 'right' : 'left');
        syncRailSide();
        if (documentModule && documentModule.swapSide) documentModule.swapSide();
        return;
      }

      _userToggledSidebar = true;
      const isSidebarVisible = !sidebar.classList.contains('hidden');

      if (window.innerWidth < 768) {
        // 移动端：完整侧边栏 ↔ 隐藏 — 简单切换，无迷你图标栏
        const backdrop = document.getElementById('sidebar-backdrop');
        if (iconRail) { iconRail.classList.remove('mobile-mini'); iconRail.style.cssText = ''; }

        if (isSidebarVisible) {
          // 关闭侧边栏
          sidebar.classList.add('hidden');
          if (backdrop) backdrop.classList.remove('visible');
        } else {
          // 移动端：汉堡菜单始终从右侧打开侧边栏。
          // （不持久化 — 保持桌面端的侧边栏位置偏好不受影响。）
          if (!sidebar.classList.contains('right-side')) {
            sidebar.classList.add('right-side');
            if (documentModule && documentModule.swapSide) { try { documentModule.swapSide(); } catch (_) {} }
          }
          // 打开侧边栏 — 先收起键盘，等布局稳定后再打开
          if (document.activeElement && document.activeElement !== document.body
              && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
            document.activeElement.blur();
            // 等待键盘收起稳定后再打开
            setTimeout(() => {
              sidebar.classList.remove('hidden');
              if (backdrop) backdrop.classList.add('visible');
              syncRailSide();
            }, 250);
          } else {
            sidebar.classList.remove('hidden');
            if (backdrop) backdrop.classList.add('visible');
          }
        }
        syncRailSide();
        return;
      }

      // 桌面端：完整侧边栏 ↔ 迷你（图标栏）— 简单切换
      if (isSidebarVisible) {
        sidebar.classList.add('hidden');
      } else {
        _wasAutoCollapsed = false;
        iconRail.classList.remove('rail-hidden');
        sidebar.classList.remove('hidden');
      }
      syncRailSide();
    });
  }

  // 图标栏区块点击 — 打开侧边栏并滚动到对应区块
  if (iconRail) {
    iconRail.addEventListener('click', (e) => {
      const btn = e.target.closest('.icon-rail-btn');
      if (!btn || btn.id === 'rail-new-session' || btn.id === 'rail-delete-session' || btn.id === 'rail-search-btn' || btn.id === 'rail-settings' || btn.id === 'rail-admin') return;
      const sectionId = btn.dataset.section;
      if (!sectionId) return;
      const sidebar = document.getElementById('sidebar');
      sidebar.classList.remove('hidden');
      syncRailSide();
      const section = document.getElementById(sectionId);
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        section.classList.remove('collapsed');
      }
    });
  }

  // 窗口变小或聊天区域被挤压时自动折叠侧边栏
  const AUTO_COLLAPSE_WIDTH = 700;
  const MIN_CHAT_WIDTH = 380; // 聊天区域窄于此宽度时折叠侧边栏

  function checkSidebarAutoCollapse() {
    if (_userToggledSidebar) return;
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const isHidden = sidebar.classList.contains('hidden');

    // 检查聊天区域是否太窄（例如侧边栏和文档面板同时打开）。
    // 但如果存在平铺吸附的模态框，是它在使聊天变窄，
    // 而那是用户的明确选择。不要因此而自动折叠侧边栏，
    // 否则会产生响应循环：吸附 → 窄聊天 → 隐藏
    // 侧边栏 → safe-rect 变化 → 重新夹紧模态框 → 新的聊天宽度 → ...
    const chatContainer = document.querySelector('.chat-container');
    const hasTileSnapped = document.querySelector('.modal-content[data-_tile-zone], .research-pane[data-_tile-zone]');
    const chatTooNarrow = chatContainer && chatContainer.offsetWidth < MIN_CHAT_WIDTH && !isHidden && !hasTileSnapped;

    if ((window.innerWidth < AUTO_COLLAPSE_WIDTH || chatTooNarrow) && !isHidden) {
      sidebar.classList.add('hidden');
      _wasAutoCollapsed = true;
      syncRailSide();
    } else if (window.innerWidth >= AUTO_COLLAPSE_WIDTH && isHidden && _wasAutoCollapsed) {
      // 只在聊天区域不会太窄时才恢复
      sidebar.classList.remove('hidden');
      void document.body.offsetWidth; // 强制回流
      if (chatContainer && chatContainer.offsetWidth < MIN_CHAT_WIDTH) {
        sidebar.classList.add('hidden');
      } else {
        _wasAutoCollapsed = false;
      }
      syncRailSide();
    }
  }

  window.addEventListener('resize', () => {
    _userToggledSidebar = false; // 在实际调整大小时允许自动折叠
    requestAnimationFrame(checkSidebarAutoCollapse);
  });
  // 文档面板切换时也重新检查
  new MutationObserver(() => requestAnimationFrame(checkSidebarAutoCollapse))
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // 初始加载时如果窗口较小则自动折叠
  if (window.innerWidth < AUTO_COLLAPSE_WIDTH) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('hidden')) {
      sidebar.classList.add('hidden');
      _wasAutoCollapsed = true;
      syncRailSide();
    }
  }

  // ── 移动端侧边栏背景遮罩 + 滑动关闭 ──
  // 背景遮罩：点击它关闭侧边栏
  const mobileBackdrop = document.createElement('div');
  mobileBackdrop.id = 'sidebar-backdrop';
  document.body.appendChild(mobileBackdrop);

  function updateMobileBackdrop() {
    if (window.innerWidth >= 768) { mobileBackdrop.classList.remove('visible'); return; }
    const sb = document.getElementById('sidebar');
    const rail = document.getElementById('icon-rail');
    const sidebarOpen = sb && !sb.classList.contains('hidden');
    const miniOpen = rail && rail.classList.contains('mobile-mini');
    mobileBackdrop.classList.toggle('visible', sidebarOpen || miniOpen);
  }

  // 在下拉菜单操作后短暂抑制侧边栏关闭
  window._suppressSidebarClose = false;
  mobileBackdrop.addEventListener('click', (e) => {
    if (window._suppressSidebarClose) return;
    // 当会话正在内联重命名时不关闭 — 重命名输入框在侧边栏内部，
    // 而背景遮罩的点击（例如为了收起键盘）否则会在重命名中途踢出用户。
    if (document.querySelector('.session-rename-input')) return;
    // 当下拉菜单或子菜单可见时不关闭
    const openDD = document.querySelector('.session-dropdown-menu[style*="display: block"], .session-dropdown-menu[style*="display:block"]');
    const openSub = document.querySelector('.session-folder-submenu[style*="display: block"], .session-folder-submenu[style*="display:block"]');
    if (openDD || openSub) {
      if (openSub) openSub.style.display = 'none';
      if (openDD) openDD.style.display = 'none';
      return;
    }
    const sb = document.getElementById('sidebar');
    if (sb && !sb.classList.contains('hidden')) {
      sb.classList.add('hidden');
    }
    mobileBackdrop.classList.remove('visible');
    syncRailSide();
  });

  // 修补 syncRailSide 以同时更新背景遮罩
  const _origSyncRailSideCore = _syncRailSideCore;
  _syncRailSideFn = function() { _origSyncRailSideCore(); updateMobileBackdrop(); };
  window.syncRailSide = syncRailSide;

  // 向边缘滑动侧边栏以关闭
  const sidebar = document.getElementById('sidebar');
  if (sidebar && 'ontouchstart' in window) {
    let _swStartX = 0, _swStartY = 0, _swSwiping = false;
    sidebar.addEventListener('touchstart', (e) => {
      if (e.target.closest('.list-item')) { _swSwiping = false; return; }
      _swStartX = e.touches[0].clientX;
      _swStartY = e.touches[0].clientY;
      _swSwiping = true;
    }, { passive: true });
    sidebar.addEventListener('touchmove', (e) => {
      if (!_swSwiping) return;
      const dx = e.touches[0].clientX - _swStartX;
      const dy = Math.abs(e.touches[0].clientY - _swStartY);
      if (dy > 40) { _swSwiping = false; return; }
      const isRight = sidebar.classList.contains('right-side');
      if ((!isRight && dx < -60) || (isRight && dx > 60)) {
        _swSwiping = false;
        const _backdrop = document.getElementById('sidebar-backdrop');
        if (_backdrop) _backdrop.classList.remove('visible');
        sidebar.classList.add('hidden');
        syncRailSide();
      }
    }, { passive: true });
    sidebar.addEventListener('touchend', () => { _swSwiping = false; }, { passive: true });
  }

  // ── 点击侧边栏/图标栏外部关闭（仅移动端） ──
  document.addEventListener('click', (e) => {
    if (window.innerWidth >= 700) return; // 桌面端保持侧边栏打开
    const sb = document.getElementById('sidebar');
    const rail = document.getElementById('icon-rail');
    // 忽略从 DOM 中移除的元素的点击（例如文件夹切换时重新渲染的会话列表）
    if (!e.target.isConnected) return;
    // 忽略点击侧边栏、图标栏或汉堡菜单按钮本身
    if (e.target.closest('#sidebar') || e.target.closest('#icon-rail') || e.target.closest('#hamburger-btn')) return;
    // 忽略模态框或聊天输入区内的点击
    if (e.target.closest('.modal') || e.target.closest('.input-bar') || e.target.closest('#message')) return;
    // 忽略会话/文件夹下拉菜单和样式化提示浮层的点击 —
    // 它们是 body 级别的元素，逻辑上与侧边栏操作相关
    // （例如"移动到文件夹 → 新建文件夹…"），所以当用户点击它们时关闭
    // 侧边栏会导致操作中途被中断。
    if (e.target.closest('.session-dropdown, .folder-submenu, #styled-prompt-overlay, #styled-confirm-overlay')) return;
    // 如果打开的完整侧边栏（带动画）则关闭
    if (sb && !sb.classList.contains('hidden')) {
      const backdrop = document.getElementById('sidebar-backdrop');
      if (backdrop) backdrop.classList.remove('visible');
      sb.classList.add('hidden');
      syncRailSide();
      return;
    }
    // 如果打开的移动端迷你图标栏浮层则关闭
    if (rail && rail.classList.contains('mobile-mini')) {
      rail.classList.remove('mobile-mini');
      rail.style.cssText = '';
      const backdrop = document.getElementById('sidebar-backdrop');
      if (backdrop) backdrop.classList.remove('visible');
      syncRailSide();
    }
  });

  // ── 移动端：当工具按钮被点击时关闭侧边栏/图标栏 ──
  // 用户期望工具窗口打开时侧边栏立即让路 —
  // 否则在手机上模态框会落在侧边栏后面。
  // 我们记住工具被点击时的侧边栏是否打开，
  // 以便在工具的模态框被关闭时重新打开它；这样
  // 在应用中点击不会导致侧边栏永久关闭。
  let _sidebarWasOpenBeforeTool = false;
  let _railWasOpenBeforeTool = false;
  document.addEventListener('click', (e) => {
    if (window.innerWidth >= 700) return;
    const btn = e.target.closest('[id^="tool-"], [id^="rail-"]');
    if (!btn) return;
    setTimeout(() => {
      const sb = document.getElementById('sidebar');
      const rail = document.getElementById('icon-rail');
      const backdrop = document.getElementById('sidebar-backdrop');
      let changed = false;
      if (sb && !sb.classList.contains('hidden')) {
        _sidebarWasOpenBeforeTool = true;
        sb.classList.add('hidden');
        changed = true;
      }
      if (rail && rail.classList.contains('mobile-mini')) {
        _railWasOpenBeforeTool = true;
        rail.classList.remove('mobile-mini');
        rail.style.cssText = '';
        changed = true;
      }
      if (changed) {
        if (backdrop) backdrop.classList.remove('visible');
        syncRailSide();
      }
    }, 0);
  });

  // 当工具被向下滑动关闭时（ui.js 触发 `modal-dismissed`），
  // 不要反弹打开侧边栏 — 滑动手势应该只是关闭工具。
  // 按钮关闭仍会恢复之前的侧边栏状态（此时不触发事件）。
  window.addEventListener('modal-dismissed', () => {
    _sidebarWasOpenBeforeTool = false;
    _railWasOpenBeforeTool = false;
  });

  // ── 移动端：当工具模态框关闭时，将侧边栏/图标栏恢复到
  // 工具打开之前的状态。 ──
  // 我们观察每个 .modal 的 .hidden class 在添加时，如果我们的
  // 记忆"侧边栏打开"标志已设置，则撤销自动关闭。
  if (window.innerWidth < 700) {
    const _restoreSidebar = () => {
      const sb = document.getElementById('sidebar');
      const rail = document.getElementById('icon-rail');
      const backdrop = document.getElementById('sidebar-backdrop');
      // 如果有任何模态框仍然可见（.modal 没有 .hidden），则跳过 — 我们只
      // 在用户回到纯聊天页面时才恢复。向下滑动到停靠标签的工具
      // 是最小化的（通过 .modal-minimized 且 display:none），不是关闭的 —
      // 它仍然"在附近"，所以不要在它后面反弹打开侧边栏。只有
      // 完全关闭（没有最小化的模态框、没有停靠标签）才应该恢复。
      const anyOpen = [...document.querySelectorAll('.modal')]
        .some(m => (!m.classList.contains('hidden') && getComputedStyle(m).display !== 'none')
                   || m.classList.contains('modal-minimized'));
      const anyDocked = document.querySelectorAll('.minimized-dock-chip').length > 0;
      if (anyOpen || anyDocked) {
        // 还有一个工具处于最小化/停靠状态。用户已离开"从侧边栏启动"
        // 的上下文 — 丢弃恢复意图，以便稍后
        // 完全关闭工具（例如拖动其标签到垃圾桶）时不会
        // 反弹打开侧边栏。（modal-dismissed 监听器通常会
        // 清除这些标志，但被 modalManager 的 stopImmediatePropagation 阻止了。）
        _sidebarWasOpenBeforeTool = false;
        _railWasOpenBeforeTool = false;
        return;
      }
      if (_sidebarWasOpenBeforeTool && sb && sb.classList.contains('hidden')) {
        sb.classList.remove('hidden');
        if (backdrop) backdrop.classList.add('visible');
      }
      if (_railWasOpenBeforeTool && rail && !rail.classList.contains('mobile-mini')) {
        rail.classList.add('mobile-mini');
      }
      _sidebarWasOpenBeforeTool = false;
      _railWasOpenBeforeTool = false;
      if (_sidebarWasOpenBeforeTool || _railWasOpenBeforeTool) syncRailSide();
    };
    const _modalObs = new MutationObserver((muts) => {
      let triggered = false;
      for (const m of muts) {
        if (m.type !== 'attributes' || m.attributeName !== 'class') continue;
        const t = m.target;
        if (!(t instanceof HTMLElement) || !t.classList) continue;
        if (t.classList.contains('modal')) { triggered = true; break; }
      }
      if (triggered) setTimeout(_restoreSidebar, 50);
    });
    _modalObs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  // （移动端滑动打开侧边栏在模块作用域绑定 — 参见
  // 本文件底部的 _initChatSwipeToOpenSidebar() — 这样
  // 它不依赖于此初始化函数的完成。）
}

// ── 移动端：在启动画/聊天界面水平滑动打开侧边栏 ──
// 在模块作用域绑定（不在 initSidebarLayout 内），所以该初始化中
// 任何地方的异常都不会导致丢失此监听器。绑定在 `document` 上，
// 这样无论手指下的子元素是什么都能捕获触摸。touchmove 是
// 非被动模式，并在手势锁定为水平滑动后调用 preventDefault() — 
// 否则 Firefox（和其他浏览器）会将水平滑动
// 视为自己的滚动/导航手势，我们的处理器永远无法执行。
function _initChatSwipeToOpenSidebar() {
  if (window.__odySwipeWired) return;
  window.__odySwipeWired = true;

  // 水平拖动有不同含义的区域（它们自己的滚动/拖动）。
  const EXCLUDE = [
    '#sidebar', '#icon-rail', '.modal', '.input-bar', '#message',
    '#minimized-dock', '.minimized-dock-chip', '#dock-trash-zone',
    'pre', 'table', '.agent-tool-output', '.agent-thread-cmd',
    'input', 'textarea', 'select',
  ].join(', ');

  let sx = 0, sy = 0, track = false, decided = false;

  const reset = () => { track = false; decided = false; };

  document.addEventListener('touchstart', (e) => {
    reset();
    if (window.innerWidth >= 768) return;
    if (!e.touches || e.touches.length !== 1) return;
    if (window._chipDragging) return;
    const sb = document.getElementById('sidebar');
    if (sb && !sb.classList.contains('hidden')) return; // 已打开
    // 只在聊天/空白聊天视图中。不在文档或 PDF 打开时（body.doc-view），
    // 笔记打开时（body.notes-view）或工具模态框存在时。
    if (document.body.classList.contains('doc-view') ||
        document.body.classList.contains('notes-view')) return;
    // 对比功能运行时不允许 — 它接管了 #chat-container 用自己的
    // 面板/滚动，滑动打开侧边栏手势在那里会干扰。
    const cc = document.getElementById('chat-container');
    if (cc && cc.classList.contains('compare-active')) return;
    const anyModalOpen = [...document.querySelectorAll('.modal')].some(
      m => !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none');
    if (anyModalOpen) return;
    const t = e.target;
    if (t && t.closest && t.closest(EXCLUDE)) return;
    // 手势必须在聊天区域内开始。
    if (!(t && t.closest && t.closest('#chat-container'))) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    track = true;
  }, { passive: true, capture: true });

  document.addEventListener('touchmove', (e) => {
    if (!track) return;
    if (window._chipDragging) { track = false; return; }
    if (!e.touches || !e.touches.length) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (!decided) {
      if (adx < 10 && ady < 10) return;          // 移动不够，无法判断
      if (ady > adx) { track = false; return; }   // 垂直优先 → 让它滚动
      decided = true;                             // 锁定为水平滑动
    }
    // 从浏览器手中夺取手势，避免它改为滚动/导航。
    if (e.cancelable) e.preventDefault();
    if (adx >= 40) {
      track = false;
      // 方向决定位置（按用户偏好）：向左滑动 → 侧边栏在左侧，
      // 向右滑动 → 侧边栏在右侧。dx<0 表示手指向左移动；
      // 将其映射为 'right'（dx>0 映射为 'left'），这样才能让人感觉正确。
      const side = dx < 0 ? 'right' : 'left';
      // 使用主动打开的辅助函数（设置 _userToggledSidebar 以便
      // 自动折叠观察器不会立即重新隐藏它）。如果辅助函数尚未绑定则回退到
      // 简单的取消隐藏。
      if (typeof window._odyOpenSidebar === 'function') {
        window._odyOpenSidebar(side);
      } else {
        const sb = document.getElementById('sidebar');
        if (sb) { sb.classList.remove('hidden'); try { syncRailSide(); } catch (_) {} }
      }
    }
  }, { passive: false, capture: true });

  document.addEventListener('touchend', reset, { passive: true, capture: true });
  document.addEventListener('touchcancel', reset, { passive: true, capture: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initChatSwipeToOpenSidebar);
} else {
  _initChatSwipeToOpenSidebar();
}
