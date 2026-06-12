// 可拖动模态框的右边缘吸附停靠功能。
//
// 添加一个“拖至右侧”手势，将模态框停靠为右侧面板
//（镜像 emailLibrary.js / documentLibrary.js / galleryEditor.js 中
// _makeDraggable 使用的吸附到顶部全屏模式）。停靠时：
//   - modal-content 位于 `right: 0; top: 0; bottom: 0`，使用视口比例的宽度
//   - body 添加 `right-dock-active` + `--right-dock-w`，使下方工作区
//     为固定的侧面板预留空间
//   - 如果剩余聊天区域宽度低于 380px，则宽侧边栏自动折叠为图标栏
//     （镜像笔记视图的 UX）
//
// 从右边缘拖离则取消停靠，恢复为居中窗口 —
// 使用与吸附到顶部退出路径相同的恢复值。

import { t } from './i18n.js';

// 比顶部吸附全屏区域（6px）更宽的吸附区域 — 右边缘
// 更难精确定位，因为大多数用户会大范围向侧面拖动
// 而不是瞄准 1px 的线。60px 感觉足够慷慨，不会
// 因随意拖动而产生误触发。
const SNAP_PX = 60;
const UNSNAP_PX = 80;
const MIN_CHAT_WIDTH = 380;
const EMAIL_DOC_SPLIT_WIDTH_KEY = 'odysseus-email-doc-split-width';
const EDGE_DOCK_WIDTH_KEY_PREFIX = 'odysseus-edge-dock-width';
const MIN_EDGE_DOCK_WIDTH = 320;

let _edgeDockHandlePositioner = null;

function _positionEdgeDockResizeHandles() {
  try { _edgeDockHandlePositioner && _edgeDockHandlePositioner(); } catch (_) {}
}

function _dockClassForSide(side) {
  return side === 'left' ? 'modal-left-docked' : 'modal-right-docked';
}

function _hasOtherDockedWindow(side, owner) {
  const cls = _dockClassForSide(side);
  return Array.from(document.querySelectorAll(`.${cls}`)).some((el) => {
    if (!el || el === owner) return false;
    if (owner && el.contains && el.contains(owner)) return false;
    if (owner && owner.contains && owner.contains(el)) return false;
    return true;
  });
}

function _hasAnyOtherDockedWindow(owner) {
  return _hasOtherDockedWindow('left', owner) || _hasOtherDockedWindow('right', owner);
}

export function clearDockSide(side, owner = null) {
  if (side !== 'left' && side !== 'right') return;
  if (_hasOtherDockedWindow(side, owner)) return;
  document.body.classList.remove(side === 'left' ? 'left-dock-active' : 'right-dock-active');
  document.documentElement.style.removeProperty(side === 'left' ? '--left-dock-w' : '--right-dock-w');
  if (side === 'left') {
    try { window._restoreSidebarIfRouteCollapsed?.(); } catch (_) {}
  }
  _positionEdgeDockResizeHandles();
}

// 默认停靠宽度：约视口的 38%，限制在合理范围内。
function _defaultDockWidth() {
  return Math.min(640, Math.max(420, Math.round(window.innerWidth * 0.38)));
}

function _dockWidthStorageKey(modal, content, side) {
  const id = modal?.id || content?.id || content?.dataset?.modalId || '';
  return id ? `${EDGE_DOCK_WIDTH_KEY_PREFIX}:${side}:${id}` : null;
}

function _storedDockWidth(modal, content, side) {
  const key = _dockWidthStorageKey(modal, content, side);
  if (!key) return null;
  try {
    const n = parseFloat(localStorage.getItem(key) || '');
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

function _saveDockWidth(modal, content, side, width) {
  const key = _dockWidthStorageKey(modal, content, side);
  if (!key) return;
  try { localStorage.setItem(key, String(Math.round(width))); } catch (_) {}
}

function _minEdgeDockWidth() {
  return window.innerWidth < 900 ? 280 : MIN_EDGE_DOCK_WIDTH;
}

function _activeDockWidth(side) {
  if (side !== 'left' && side !== 'right') return 0;
  const cls = side === 'left' ? 'left-dock-active' : 'right-dock-active';
  if (!document.body.classList.contains(cls)) return 0;
  const prop = side === 'left' ? '--left-dock-w' : '--right-dock-w';
  const raw = getComputedStyle(document.documentElement).getPropertyValue(prop);
  const n = parseFloat(raw || '');
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function _clampDockWidthToSpace(width, min, max) {
  const floor = Math.min(min, Math.max(220, Math.round(max)));
  const ceiling = Math.max(floor, Math.round(max));
  return Math.min(ceiling, Math.max(floor, Math.round(width)));
}

function _clampRightDockWidth(width) {
  const min = _minEdgeDockWidth();
  const navRight = _leftNavRight();
  const leftDockW = _activeDockWidth('left');
  const maxByChat = window.innerWidth - navRight - leftDockW - MIN_CHAT_WIDTH;
  const max = Math.min(Math.round(window.innerWidth * 0.82), maxByChat);
  return _clampDockWidthToSpace(width, min, max);
}

function _clampLeftDockWidth(width, left = _leftNavRight()) {
  const min = _minEdgeDockWidth();
  const rightDockW = _activeDockWidth('right');
  const available = Math.max(0, window.innerWidth - left - rightDockW);
  const max = Math.min(Math.round(available * 0.82), available - MIN_CHAT_WIDTH);
  return _clampDockWidthToSpace(width, min, max);
}

function _resolveRightDockWidth(modal, content) {
  return _clampRightDockWidth(content?._userDockWidth || _storedDockWidth(modal, content, 'right') || _defaultDockWidth());
}

function _resolveLeftDockWidth(content, left = _leftNavRight()) {
  return _clampLeftDockWidth(content?._userDockWidth || _storedDockWidth(content?._dockOwner, content, 'left') || _resolveEmailDocSplitWidth(content, left), left);
}

function _isEmailDockOwner(owner) {
  const id = owner?.id || '';
  return id === 'email-lib-modal' || id.startsWith('email-reader-') || owner?.classList?.contains('email-window-modal');
}

function _showSnapHint(on, side = 'right') {
  const cls = side === 'left' ? 'modal-snap-hint-left' : 'modal-snap-hint-right';
  let hint = document.querySelector('.' + cls);
  if (!on) {
    if (hint) hint.remove();
    return;
  }
  if (hint) return;
  hint = document.createElement('div');
  hint.className = 'modal-snap-hint ' + cls;
  const w = _defaultDockWidth();
  const edge = side === 'left' ? 'left:0' : 'right:0';
  const borderSide = side === 'left' ? 'border-right' : 'border-left';
  hint.style.cssText = `position:fixed;${edge};top:0;bottom:0;width:${w}px;background:color-mix(in srgb, var(--accent-primary, #60a5fa) 12%, transparent);${borderSide}:2px dashed color-mix(in srgb, var(--accent-primary, #60a5fa) 60%, transparent);z-index:9998;pointer-events:none;transition:opacity 0.12s;`;
  document.body.appendChild(hint);
}

// 检查在右侧预留 dockW 像素后，body 当前聊天区域宽度是否会低于
// MIN_CHAT_WIDTH 底线。如果宽侧边栏应该折叠为图标栏则返回 true。
function _shouldAutoCollapseSidebar(dockW) {
  const sidebar = document.getElementById('sidebar');
  const rail = document.getElementById('icon-rail');
  if (!sidebar) return false;
  const sidebarHidden = sidebar.classList.contains('hidden');
  if (sidebarHidden) return false;
  const sb = sidebar.getBoundingClientRect().width || 0;
  const rl = (rail && window.getComputedStyle(rail).display !== 'none')
    ? rail.getBoundingClientRect().width
    : 0;
  const remaining = window.innerWidth - sb - rl - _activeDockWidth('left') - dockW;
  return remaining < MIN_CHAT_WIDTH;
}

// 当前显示的左侧导航的右边缘（像素）—
// 如果可见则为展开的侧边栏，否则为图标栏。用于锚定
// 左侧停靠，使其始终紧贴导航右侧。
function _leftNavRight() {
  const sidebar = document.getElementById('sidebar');
  const rail = document.getElementById('icon-rail');
  let x = 0;
  if (sidebar && !sidebar.classList.contains('hidden')) {
    const r = sidebar.getBoundingClientRect();
    if (r.width) x = Math.max(x, r.right);
  }
  if (rail && window.getComputedStyle(rail).display !== 'none') {
    const r = rail.getBoundingClientRect();
    if (r.width) x = Math.max(x, r.right);
  }
  return x;
}

function _clampEmailDocSplitWidth(width, left = _leftNavRight()) {
  const available = Math.max(0, window.innerWidth - left);
  if (!available) return 0;
  const compact = available < 760;
  const minEmail = compact ? 260 : 340;
  const minDoc = compact ? 260 : 360;
  const maxEmail = Math.max(minEmail, available - minDoc);
  return Math.min(maxEmail, Math.max(minEmail, Math.round(width)));
}

function _storedEmailDocSplitWidth() {
  try {
    const raw = localStorage.getItem(EMAIL_DOC_SPLIT_WIDTH_KEY);
    const n = parseFloat(raw || '');
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

function _saveEmailDocSplitWidth(width) {
  try { localStorage.setItem(EMAIL_DOC_SPLIT_WIDTH_KEY, String(Math.round(width))); } catch (_) {}
}

function _disconnectLeftDockObservers(content) {
  if (!content?._leftDockNavObs) return;
  const obs = content._leftDockNavObs;
  try { obs.navObs && obs.navObs.disconnect(); } catch (_) {}
  try { obs.bodyObs && obs.bodyObs.disconnect(); } catch (_) {}
  try { obs.disconnectDocObs && obs.disconnectDocObs(); } catch (_) {}
  try { window.removeEventListener('resize', obs.reanchor); } catch (_) {}
  delete content._leftDockNavObs;
}

function _applyEmailDocSplitGeometry(left, emailWidth) {
  const x = left + emailWidth;
  document.documentElement.style.setProperty('--email-doc-split-left-x', `${left}px`);
  document.documentElement.style.setProperty('--email-doc-split-email-w', `${emailWidth}px`);
  document.documentElement.style.setProperty('--email-doc-split-right-x', `${x}px`);

  // emailLibrary.js 在停靠的邮件旁边打开文档后，会使用内联 !important 样式
  // 固定文档窗格。也需要更新该内联几何信息，否则邮件调整大小了但文档位置不变。
  const docPane = document.getElementById('doc-editor-pane');
  if (!docPane || window.innerWidth <= 768) return;
  docPane.style.setProperty('position', 'fixed', 'important');
  docPane.style.setProperty('left', `${x}px`, 'important');
  docPane.style.setProperty('right', 'var(--right-dock-w, 0px)', 'important');
  docPane.style.setProperty('top', '0px', 'important');
  docPane.style.setProperty('bottom', '0px', 'important');
  docPane.style.setProperty('width', 'auto', 'important');
  docPane.style.setProperty('max-width', 'none', 'important');
  docPane.style.setProperty('height', '100vh', 'important');
  docPane.style.setProperty('z-index', '260', 'important');
  docPane.style.setProperty('transform', 'none', 'important');
}

function _clearEmailDocSplitGeometry() {
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

function _resolveEmailDocSplitWidth(content, left) {
  const available = Math.max(0, window.innerWidth - left);
  const fallback = Math.max(440, available * 0.55);
  const requested = content?._emailDocSplitUserW || _storedEmailDocSplitWidth() || fallback;
  return _clampEmailDocSplitWidth(requested, left);
}

// 将左侧停靠窗口紧贴当前左侧导航定位，覆盖聊天区域。
// 在侧边栏切换时重新运行，使窗口滑动跟随导航，而不是被导航覆盖。
//
// 另外：如果文档编辑器窗格渲染在聊天区域右侧，则将邮件右边缘限制在
// 文档之前，使两者共享同一行而不是重叠。纯几何读取 — 不更改 CSS 类
//（之前在此处翻转 body 类的尝试导致布局抖动并破坏了整个标签页）。
function _anchorLeftDock(content) {
  if (!content || content._dockSide !== 'left') return;
  const left = _leftNavRight();
  const w = document.body.classList.contains('doc-view')
    ? _resolveEmailDocSplitWidth(content, left)
    : _resolveLeftDockWidth(content, left);
  content.style.left = left + 'px';
  content.style.width = w + 'px';
  content.style.maxWidth = w + 'px';
  // 如果文档也是打开的，驱动已有的邮件/文档分屏 CSS 规则
  //（style.css 中 `body.email-doc-split-active.doc-view .doc-editor-pane`），
  // 使文档窗格变为 position:fixed，从邮件右边缘开始。
  // 不使用 flex/max-width 争夺；文档直接从邮件右边缘到视口边缘 —
  // 它们紧密相邻，无间隙。
  const docOpen = document.body.classList.contains('doc-view') && _isEmailDockOwner(content._dockOwner);
  if (docOpen) {
    if (!document.body.classList.contains('email-doc-split-active')) {
      document.body.classList.add('email-doc-split-active');
    }
    document.documentElement.style.setProperty('--left-dock-w', '0px');
    _applyEmailDocSplitGeometry(left, w);
  } else if (document.body.classList.contains('email-doc-split-active')) {
    _clearEmailDocSplitGeometry();
  } else {
    document.documentElement.style.setProperty('--left-dock-w', w + 'px');
  }
}

function _collapseSidebarToRail() {
  const sidebar = document.getElementById('sidebar');
  const rail = document.getElementById('icon-rail');
  if (!sidebar || !rail) return;
  // 将折叠标记为路由/停靠驱动，以便 app.js 中的配对恢复
  //（window._restoreSidebarIfRouteCollapsed）知道自己拥有取消折叠的权力。
  // 与 /email 和 /notes 打开器使用的标记相同 — 它们不能同时活跃，因此无冲突。
  if (!sidebar.classList.contains('hidden')) {
    document.body.dataset.routeCollapsedSidebar = '1';
  }
  sidebar.classList.add('hidden');
  rail.classList.remove('rail-hidden');
  try { window.syncRailSide && window.syncRailSide(); } catch (_) {}
}

// 解析停靠目标。对于 .modal 容器，内部 .modal-content 是我们定位的目标；
// 对于独立面板（研究、对比等），传入的元素本身既是容器也是内容。
// 返回 {modal, content}，当没有有效参数传入时返回 null。
function _resolveDockNodes(target) {
  if (!target) return null;
  const content = target.querySelector
    ? (target.querySelector('.modal-content') || target)
    : target;
  return { modal: target, content };
}

// 对模态框/面板应用边缘停靠状态。`side` 为 'right'（默认）或 'left'。
export function applyEdgeDock(modal, side = 'right', dockClass) {
  if (!dockClass) dockClass = side === 'left' ? 'modal-left-docked' : 'modal-right-docked';
  return _applyDockInternal(modal, side, dockClass);
}

// 向后兼容：现有调用者使用 applyRightDock 进行右侧吸附。
export function applyRightDock(modal, dockClass = 'modal-right-docked') {
  return _applyDockInternal(modal, 'right', dockClass);
}

function _applyDockInternal(modal, side, dockClass) {
  const nodes = _resolveDockNodes(modal);
  if (!nodes) return 0;
  const content = nodes.content;
  if (!content) return 0;
  // 如果模态框当前停靠在另一侧（例如用户手动将其停靠在右侧，
  // 然后回复将其重新停靠在左侧），先清除那一侧的类 + body 偏移。
  // 否则两侧状态共存 — 旧停靠继续偏移/重叠，回复文档在仍停靠的窗口下方打开。
  // 我们保留 _preDockSnapshot（下方的守卫跳过重新捕获），
  // 以便取消停靠时仍能恢复原始浮动几何信息。
  // 用另一侧类作为守卫，确保正常首次停靠仍能在下方捕获浮动窗口的真实 left/right 内联样式。
  const otherSide = side === 'left' ? 'right' : 'left';
  const otherClass = _dockClassForSide(otherSide);
  if (modal.classList.contains(otherClass)) {
    modal.classList.remove(otherClass);
    clearDockSide(otherSide, modal);
    // 重置边缘锚点，使新侧从干净状态开始定位
    //（右侧停靠固定 right:0；左侧停靠固定 left:<nav>）。
    content.style.left = '';
    content.style.right = '';
  }
  // 捕获实际渲染的矩形 + 内联样式，以便取消停靠时可以
  // 恢复用户之前完全相同的浮动窗口。没有这个，
  // 用户精心调整大小的窗口将弹回某个 720×85vh 的默认值 —
  // 感觉像停靠吃掉了他们的布局。
  if (!content._preDockSnapshot) {
    const r = content.getBoundingClientRect();
    content._preDockSnapshot = {
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      style: {
        position: content.style.position,
        left: content.style.left,
        top: content.style.top,
        right: content.style.right,
        bottom: content.style.bottom,
        width: content.style.width,
        maxWidth: content.style.maxWidth,
        height: content.style.height,
        maxHeight: content.style.maxHeight,
        borderRadius: content.style.borderRadius,
        transform: content.style.transform,
        margin: content.style.margin,
      },
      // 跟踪是否是我们折叠了宽侧边栏 — 仅当停靠是折叠原因时
      // 才在取消停靠时恢复它。
      collapsedSidebar: false,
    };
  }
  modal.classList.add(dockClass);
  content.style.position = 'fixed';
  content.style.top = '0';
  content.style.bottom = '0';
  content.style.height = '100vh';
  content.style.maxHeight = '100vh';
  content.style.borderRadius = '0';
  content.style.transform = 'none';
  content.style.margin = '0';
  let w;
  if (side === 'left') {
    // 左侧停靠：将侧边栏折叠为图标栏，然后将窗口固定在
    // 图标栏旁边。普通左侧停靠保留其宽度以便聊天区域收缩；
    // 邮件+文档分屏保留其现有的覆盖几何。
    _collapseSidebarToRail();
    content._preDockSnapshot.collapsedSidebar = true;
    content.style.right = 'auto';
    content._dockSide = 'left';
    content._dockOwner = modal;
    _anchorLeftDock(content);
    w = parseFloat(content.style.width) || 0;
    document.body.classList.add('left-dock-active');
    document.documentElement.style.setProperty(
      '--left-dock-w',
      document.body.classList.contains('email-doc-split-active') ? '0px' : w + 'px',
    );
    // 当侧边栏切换（展开/折叠）时重新锚定邮件，使导航滑动窗口
    // 而不是在窗口上方增长。同时当文档编辑器窗格出现/消失
    //（由 body.doc-view 触发）以及用户拖动文档分隔条调整大小
    //（ResizeObserver）时重新锚定，以便邮件反向收缩/增长，
    // 使两者干净地共享一行。
    if (!content._leftDockNavObs && typeof MutationObserver !== 'undefined') {
      const sidebar = document.getElementById('sidebar');
      const _doAnchor = () => {
        if (modal.classList.contains(dockClass)) _anchorLeftDock(content);
      };
      const reanchor = () => {
        if (!modal.classList.contains(dockClass)) return;
        _doAnchor();
        // 多阶段稳定：停靠翻转 + 侧边栏折叠 + 文档挂载各自有不同的过渡时间
        //（160ms / ~240ms / 可变）。在每个合理的稳定点重新测量，
        // 使邮件紧贴文档的最终位置，而不是过渡中快照。
        requestAnimationFrame(_doAnchor);
        setTimeout(_doAnchor, 80);
        setTimeout(_doAnchor, 250);
        setTimeout(_doAnchor, 500);
      };
      const navObs = new MutationObserver(reanchor);
      if (sidebar) navObs.observe(sidebar, { attributes: true, attributeFilter: ['class', 'style'] });
      // 仅响应 doc-view 的切换 — 不响应每个 body 属性变更。
      // 之前广泛监听导致抖动并崩溃了标签页。
      let _lastDocView = document.body.classList.contains('doc-view');
      const bodyObs = new MutationObserver(() => {
        const cur = document.body.classList.contains('doc-view');
        if (cur !== _lastDocView) {
          _lastDocView = cur;
          reanchor();
          // 重新绑定 ResizeObserver — 文档窗格在 doc-view 翻转时
          // 被创建/销毁，因此之前的目标可能已过时。
          _bindDocResizeObs();
        }
      });
      bodyObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });

      // 对当前 .doc-editor-pane 使用 ResizeObserver，使拖动其
      // 分隔条能实时回流邮件右边缘。同时观察
      // #chat-container — 其宽度在侧边栏折叠时变化、
      // 在右侧停靠填充缩减时变化、或在文档内容渲染回流行时变化，
      // 所有这些都会移动文档窗格的左边缘而不一定调整文档窗格本身大小。
      let docResizeObs = null;
      let chatResizeObs = null;
      const _bindDocResizeObs = () => {
        if (docResizeObs) { try { docResizeObs.disconnect(); } catch (_) {} docResizeObs = null; }
        if (chatResizeObs) { try { chatResizeObs.disconnect(); } catch (_) {} chatResizeObs = null; }
        if (typeof ResizeObserver === 'undefined') return;
        const docPane = document.querySelector('.doc-editor-pane');
        if (docPane) {
          docResizeObs = new ResizeObserver(reanchor);
          docResizeObs.observe(docPane);
        }
        const chatPane = document.getElementById('chat-container');
        if (chatPane) {
          chatResizeObs = new ResizeObserver(reanchor);
          chatResizeObs.observe(chatPane);
        }
      };
      _bindDocResizeObs();

      window.addEventListener('resize', reanchor);
      content._leftDockNavObs = {
        navObs,
        bodyObs,
        reanchor,
        disconnectDocObs: () => {
          try { docResizeObs && docResizeObs.disconnect(); } catch (_) {}
          try { chatResizeObs && chatResizeObs.disconnect(); } catch (_) {}
        },
      };
    }
  } else {
    w = _resolveRightDockWidth(modal, content);
    content.style.left = 'auto';
    content.style.right = '0';
    content.style.width = w + 'px';
    content.style.maxWidth = w + 'px';
    document.body.classList.add('right-dock-active');
    document.documentElement.style.setProperty('--right-dock-w', w + 'px');
    if (_shouldAutoCollapseSidebar(w)) {
      _collapseSidebarToRail();
      content._preDockSnapshot.collapsedSidebar = true;
    }
  }
  content._dockSide = side;
  content._dockOwner = modal;
  _positionEdgeDockResizeHandles();
  // 监视停靠模态框的消失（从 DOM 移除或通过 .hidden 类隐藏），
  // 并在这种情况下清理 body 填充 + 侧边栏。
  // 没有这个，关闭停靠窗口会在右侧留下一个幽灵空白条带，
  // 因为没有任何东西告诉 body 去掉其右侧内边距。
  if (!modal._dockCloseWatcher && typeof MutationObserver !== 'undefined') {
    const onGone = () => _onDockedModalGone(modal, dockClass);
    // 监视模态框的：`.hidden` 类翻转、内联
    // `display:none`（可拖动模态框 — 日历、计划、工作区等
    // 实际关闭的方式）以及父元素移除。没有 `style` 过滤器时，
    // display:none 关闭会残留 body 的停靠填充，导致
    // 停靠模态框关闭后聊天区域保持偏移。
    const _isGone = () => !modal.isConnected
      || modal.classList.contains('hidden')
      || modal.style.display === 'none';
    const obs = new MutationObserver(() => { if (_isGone()) onGone(); });
    obs.observe(modal, { attributes: true, attributeFilter: ['class', 'style'] });
    // 第二个观察器捕获 DOM 移除 — 父元素的 childList
    // 是 `.remove()` / `.removeChild()` 调用的可靠信号。
    if (modal.parentNode) {
      const parentObs = new MutationObserver(() => {
        if (!modal.isConnected) onGone();
      });
      parentObs.observe(modal.parentNode, { childList: true });
      modal._dockCloseWatcher = { obs, parentObs };
    } else {
      modal._dockCloseWatcher = { obs };
    }
  }
  return w;
}

// 内部：当停靠模态框消失（关闭按钮、X、Esc 或编程式移除）时拆除停靠状态。
// 幂等 — 如果停靠已被清除则退出，使多个观察器可以安全触发。
function _onDockedModalGone(modal, dockClass) {
  if (!modal) return;
  const watcher = modal._dockCloseWatcher;
  if (watcher) {
    try { watcher.obs && watcher.obs.disconnect(); } catch (_) {}
    try { watcher.parentObs && watcher.parentObs.disconnect(); } catch (_) {}
    delete modal._dockCloseWatcher;
  }
  const _c = modal.querySelector ? modal.querySelector('.modal-content') : null;
  _disconnectLeftDockObservers(_c);
  const hadRight = modal.classList.contains('modal-right-docked');
  const hadLeft = modal.classList.contains('modal-left-docked');
  // 仅为此模态框拥有的那一侧清除 body 级别的停靠状态，
  // 且仅当没有其他停靠窗口仍在使用该侧时才清除。
  if (hadRight) clearDockSide('right', modal);
  if (hadLeft) clearDockSide('left', modal);
  // 拆除我们在 _anchorLeftDock 中设置的邮件/文档分屏 CSS 变量，
  // 以便在邮件关闭时文档窗格恢复到其自然的 flex 布局。
  if (hadLeft && !_hasOtherDockedWindow('left', modal)) {
    _clearEmailDocSplitGeometry();
  }
  if (_c?._preDockSnapshot?.collapsedSidebar && !_hasAnyOtherDockedWindow(modal)) {
    _expandSidebarFromRail();
  }
  modal.classList.remove('modal-right-docked');
  modal.classList.remove('modal-left-docked');
  // 清除内容元素的停靠内联几何。单例模态框（计划、工作区、日历等）
  // 跨打开/关闭重用同一元素，因此如果只移除 body 偏移，
  // 元素在下次打开时仍保持定位（position:fixed; right:0; 固定宽度） —
  // 浮动在聊天上方而无偏移。我们故意不在此处恢复停靠前快照：
  // 该快照是用户将窗口拖到边缘（靠近侧边）时的拖动位置，
  // 因此恢复它会使模态框重新打开在侧边位置，仍然重叠。
  // 清除内联样式使模态框以 CSS 默认值（居中）重新打开。
  // 拖离取消停靠仍使用 clearRightDock，它确实恢复快照以实现剥离感。
  if (_c) {
    for (const prop of ['position', 'inset', 'left', 'top', 'right', 'bottom',
                        'width', 'maxWidth', 'height', 'maxHeight',
                        'borderRadius', 'transform', 'margin']) {
      _c.style[prop] = '';
    }
    delete _c._preDockSnapshot;
    delete _c._dockSide;
    delete _c._dockOwner;
  }
  _positionEdgeDockResizeHandles();
}

function _expandSidebarFromRail() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.classList.remove('hidden');
  try { window.syncRailSide && window.syncRailSide(); } catch (_) {}
}

// 取消停靠之前停靠的模态框。恢复模态框停靠前确切的渲染大小 +
// 位置。(cx, cy) 将拖动重新锚定在光标附近，使面板感觉像从边缘剥离。
export function clearRightDock(modal, cx, cy, dockClass) {
  const nodes = _resolveDockNodes(modal);
  if (!nodes) return;
  const content = nodes.content;
  if (!content) return;
  // 确定停靠在哪一侧 — 对旧调用者默认为右侧。
  const side = content._dockSide || (modal.classList.contains('modal-left-docked') ? 'left' : 'right');
  if (!dockClass) dockClass = side === 'left' ? 'modal-left-docked' : 'modal-right-docked';
  if (!modal.classList.contains(dockClass)) return;
  modal.classList.remove(dockClass);
  clearDockSide(side, modal);
  if (side === 'left' && !_hasOtherDockedWindow('left', modal)) {
    _clearEmailDocSplitGeometry();
  }
  delete content._dockSide;
  delete content._dockOwner;
  _disconnectLeftDockObservers(content);
  const snap = content._preDockSnapshot;
  // 如果我们折叠了宽侧边栏则重新展开 — 但仅当用户
  // 在停靠期间没有手动切换它时（我们不想覆盖用户的显式选择）。
  if (snap && snap.collapsedSidebar && !_hasAnyOtherDockedWindow(modal)) _expandSidebarFromRail();
  // 恢复模态框停靠前确切的內联样式值
  //（width: min(720px, 92vw), max-height: 85vh 等 —
  // 不论挂载路径设置了什么）。在此处设空字符串会从
  // 内联样式属性中移除该属性，让 CSS 规则重新接管。
  const r = snap && snap.rect;
  const sty = (snap && snap.style) || {};
  content.style.position = sty.position || 'fixed';
  content.style.right = sty.right || '';
  content.style.bottom = sty.bottom || '';
  // 原来的模态框內联 width/height 可能为空（CSS 驱动的）—
  // 但我们现在强制 position:fixed，这会破坏产生原始尺寸的
  // CSS-flex 居中布局。没有后备值的话，position:fixed + width:auto
  // 会将窗口缩小到其内容的最小宽度，用户在取消停靠后会看到一个小面板。
  // 使用捕获的渲染矩形作为备份，使浮动窗口以大致相同于停靠前的尺寸返回。
  content.style.width = sty.width || (r && r.width ? r.width + 'px' : '');
  content.style.maxWidth = sty.maxWidth || '';
  content.style.height = sty.height || (r && r.height ? r.height + 'px' : '');
  content.style.maxHeight = sty.maxHeight || '';
  content.style.borderRadius = sty.borderRadius || '';
  content.style.transform = sty.transform || '';
  content.style.margin = sty.margin || '';
  // 在光标附近重新锚定，使面板感觉像从边缘剥离。
  // 用捕获的矩形宽度作为居中参考（CSS 在这个微任务中
  // 可能还没有解析内联宽度）。没有光标坐标时回退到
  // 原始捕获的 left/top。
  const refW = (r && r.width) || content.offsetWidth || 720;
  const refH = (r && r.height) || content.offsetHeight || (window.innerHeight * 0.7);
  const targetLeft = (typeof cx === 'number')
    ? Math.max(8, cx - refW / 2)
    : (sty.left || (r ? r.left + 'px' : Math.max(8, (window.innerWidth - refW) / 2) + 'px'));
  const targetTop = (typeof cy === 'number')
    ? Math.max(8, cy - 20)
    : (sty.top || (r ? r.top + 'px' : Math.max(8, (window.innerHeight - refH) / 3) + 'px'));
  content.style.left = (typeof targetLeft === 'number') ? targetLeft + 'px' : targetLeft;
  content.style.top = (typeof targetTop === 'number') ? targetTop + 'px' : targetTop;
  delete content._preDockSnapshot;
  delete content._dockSuspended;
  _positionEdgeDockResizeHandles();
}

// 暂停停靠模态框的 body 偏移（聊天区域恢复全宽）而不取消停靠窗口 —
// 在停靠模态框被最小化时使用。模态框保留其停靠几何 + 类 + 快照，
// 以便 resumeDock() 在重新打开时能立即恢复。返回停靠侧，
// 如果模态框未停靠则返回 null。
export function suspendDock(modal) {
  const nodes = _resolveDockNodes(modal);
  if (!nodes || !nodes.content) return null;
  const content = nodes.content;
  const hadEmailSnapLeft = modal.classList.contains('email-snap-left');
  const side = content._dockSide
    || (modal.classList.contains('modal-left-docked') ? 'left'
        : modal.classList.contains('email-snap-left') ? 'left'
        : modal.classList.contains('modal-right-docked') ? 'right' : null);
  if (!side) return null;
  // 阻止关闭观察器在最小化添加 `.hidden` 时完全拆除停靠 —
  // 我们想保留停靠，只释放偏移。
  if (modal._dockCloseWatcher) {
    try { modal._dockCloseWatcher.obs && modal._dockCloseWatcher.obs.disconnect(); } catch (_) {}
    try { modal._dockCloseWatcher.parentObs && modal._dockCloseWatcher.parentObs.disconnect(); } catch (_) {}
    delete modal._dockCloseWatcher;
  }
  // 释放 body 偏移 + 恢复侧边栏，使聊天区域填满宽度。
  clearDockSide(side, modal);
  if (side === 'left') {
    _disconnectLeftDockObservers(content);
  }
  if (hadEmailSnapLeft) {
    modal.classList.remove('email-snap-left');
    _clearEmailDocSplitGeometry();
    delete content._dockSide;
    delete content._dockOwner;
    delete content._dockSuspended;
    return null;
  }
  if (side === 'left' && !_hasOtherDockedWindow('left', modal)) {
    _clearEmailDocSplitGeometry();
  }
  if (content._preDockSnapshot?.collapsedSidebar && !_hasAnyOtherDockedWindow(modal)) {
    _expandSidebarFromRail();
  }
  content._dockSuspended = side;
  _positionEdgeDockResizeHandles();
  return side;
}

// 为通过 suspendDock() 暂停的模态框重新应用 body 偏移
//（+ 侧边栏折叠 + 宽度变量 + 关闭观察器），
// 这样恢复最小化的停靠窗口会将聊天区域推回去。
// 通过 applyEdgeDock 带守卫的快照实现幂等。
// 如果恢复了暂停的停靠则返回 true。
export function resumeDock(modal) {
  const nodes = _resolveDockNodes(modal);
  if (!nodes || !nodes.content) return false;
  const content = nodes.content;
  const side = content._dockSuspended;
  if (!side) return false;
  delete content._dockSuspended;
  try { applyEdgeDock(modal, side); } catch (_) {}
  return true;
}

// 将右边缘吸附检测接入拖动会话。为每个应支持停靠的模态框
// 调用一次。返回调用者的拖动处理程序可以轮询的对象：
// { hovering(): boolean, commit(): void, release(): void }。
// 拖动处理程序负责在 mousemove 期间调用 onMove(clientX, clientY)，
// 并在 mouseup 时如果 hovering() 则调用 commit()。
export function makeRightDockController(modal, dockClass = 'modal-right-docked') {
  return makeEdgeDockController(modal, 'right', dockClass);
}

// 读取当前可见的左侧导航边缘用于吸附检测。使用测量的
// 几何值而不是 CSS 变量，因为在停靠操作期间侧边栏可能自动折叠
// 而 --sidebar-w 仍在稳定中。
function _leftNavWidth() {
  return _leftNavRight();
}

// 通用边缘吸附控制器。`side` 为 'left' 或 'right'。与原始
// 仅右侧控制器模式相同：调用者在 mousemove 期间驱动 onMove，
// 然后根据 hovering() 在 mouseup 时调用 commit()/release()。
export function makeEdgeDockController(modal, side = 'right', dockClass) {
  if (!dockClass) dockClass = side === 'left' ? 'modal-left-docked' : 'modal-right-docked';
  let _hoveringSnap = false;
  const _distFromEdge = (cx) => {
    if (side === 'left') return cx - _leftNavWidth();
    return window.innerWidth - cx;
  };
  return {
    onMove(cx, cy) {
      if (modal.classList.contains(dockClass)) {
        if (_distFromEdge(cx) > UNSNAP_PX) {
          clearRightDock(modal, cx, cy, dockClass);
          return true;
        }
        return false;
      }
      const nearEdge = _distFromEdge(cx) <= SNAP_PX;
      if (nearEdge !== _hoveringSnap) {
        _hoveringSnap = nearEdge;
        _showSnapHint(nearEdge, side);
      }
      return false;
    },
    hovering() { return _hoveringSnap; },
    side() { return side; },
    commit() {
      _showSnapHint(false, side);
      _hoveringSnap = false;
      _applyDockInternal(modal, side, dockClass);
    },
    release() {
      _showSnapHint(false, side);
      _hoveringSnap = false;
    },
  };
}

(function _initEdgeDockResizeHandles() {
  if (typeof document === 'undefined') return;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', _initEdgeDockResizeHandles, { once: true });
    return;
  }

  const handles = {
    left: document.createElement('div'),
    right: document.createElement('div'),
  };
  const _setStyle = (el, prop, value) => {
    if (el.style[prop] !== value) el.style[prop] = value;
  };
  const _hideHandle = (handle) => _setStyle(handle, 'display', 'none');

  for (const side of ['left', 'right']) {
    const handle = handles[side];
    handle.className = `edge-dock-resize-handle edge-dock-resize-handle-${side}`;
    handle.style.position = 'fixed';
    handle.style.top = '0';
    handle.style.bottom = '0';
    handle.style.width = '10px';
    handle.style.cursor = 'col-resize';
    handle.style.background = 'linear-gradient(to right, transparent 0 3px, color-mix(in srgb, var(--accent, var(--red)) 35%, transparent) 3px 7px, transparent 7px 10px)';
    handle.style.pointerEvents = 'auto';
    handle.style.touchAction = 'none';
    handle.style.display = 'none';
    handle.title = t('modal.drag_to_resize_window');
    document.body.appendChild(handle);
  }

  const _isUsableDockOwner = (owner) => {
    if (!owner || !owner.isConnected) return false;
    if (owner.classList?.contains('hidden')) return false;
    if (owner.style?.display === 'none') return false;
    const nodes = _resolveDockNodes(owner);
    const content = nodes?.content;
    if (!content || !content.isConnected) return false;
    if (content.classList?.contains('hidden')) return false;
    if (content.style?.display === 'none') return false;
    const r = content.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const _activeDockOwner = (side) => {
    const cls = _dockClassForSide(side);
    const all = Array.from(document.querySelectorAll(`.${cls}`));
    for (const owner of all.reverse()) {
      if (_isUsableDockOwner(owner)) return owner;
    }
    return null;
  };

  const _zIndexFor = (el, fallback = 250) => {
    const raw = el ? window.getComputedStyle(el).zIndex : '';
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  const _hasVisibleFloatingModal = (owner) => {
    const all = Array.from(document.querySelectorAll('.modal:not(.hidden):not(.modal-minimized)'));
    return all.some((modal) => {
      if (!modal || modal === owner) return false;
      if (owner?.contains?.(modal) || modal.contains?.(owner)) return false;
      if (modal.classList.contains('modal-left-docked')
          || modal.classList.contains('modal-right-docked')
          || modal.classList.contains('email-snap-left')) return false;
      if (modal.style.display === 'none') return false;
      const content = _resolveDockNodes(modal)?.content;
      const r = content?.getBoundingClientRect?.();
      return !!r && r.width > 0 && r.height > 0;
    });
  };

  const _setWidth = (owner, side, clientX) => {
    const nodes = _resolveDockNodes(owner);
    const content = nodes?.content;
    if (!content) return 0;
    let w = 0;
    if (side === 'right') {
      w = _clampRightDockWidth(window.innerWidth - clientX);
      content._userDockWidth = w;
      content.style.left = 'auto';
      content.style.right = '0';
      content.style.width = w + 'px';
      content.style.maxWidth = w + 'px';
      document.body.classList.add('right-dock-active');
      document.documentElement.style.setProperty('--right-dock-w', w + 'px');
      if (_shouldAutoCollapseSidebar(w)) {
        _collapseSidebarToRail();
        if (content._preDockSnapshot) content._preDockSnapshot.collapsedSidebar = true;
      }
    } else {
      const left = _leftNavRight();
      w = _clampLeftDockWidth(clientX - left, left);
      content._userDockWidth = w;
      content._emailDocSplitUserW = w;
      content.style.left = left + 'px';
      content.style.right = 'auto';
      content.style.width = w + 'px';
      content.style.maxWidth = w + 'px';
      document.body.classList.add('left-dock-active');
      document.documentElement.style.setProperty(
        '--left-dock-w',
        document.body.classList.contains('email-doc-split-active') ? '0px' : w + 'px',
      );
    }
    _positionEdgeDockResizeHandles();
    return w;
  };

  _edgeDockHandlePositioner = () => {
    const splitOwnsLeftSeam = document.body.classList.contains('email-doc-split-active')
      && document.body.classList.contains('doc-view')
      && window.innerWidth > 768;
    for (const side of ['left', 'right']) {
      const handle = handles[side];
      if (window.innerWidth <= 768 || (side === 'left' && splitOwnsLeftSeam)) {
        _hideHandle(handle);
        continue;
      }
      const owner = _activeDockOwner(side);
      const content = owner && _resolveDockNodes(owner)?.content;
      if (!content) {
        _hideHandle(handle);
        continue;
      }
      if (_hasVisibleFloatingModal(owner)) {
        _hideHandle(handle);
        continue;
      }
      const r = content.getBoundingClientRect();
      const x = side === 'right' ? r.left : r.right;
      if (!Number.isFinite(x) || x <= 0 || x >= window.innerWidth) {
        _hideHandle(handle);
        continue;
      }
      _setStyle(handle, 'display', 'block');
      _setStyle(handle, 'left', (x - 5) + 'px');
      _setStyle(handle, 'zIndex', String(_zIndexFor(owner) + 1));
    }
  };

  for (const side of ['left', 'right']) {
    const handle = handles[side];
    handle.addEventListener('pointerdown', (e) => {
      if (handle.style.display === 'none') return;
      const owner = _activeDockOwner(side);
      if (!owner) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture?.(e.pointerId);
      const nodes = _resolveDockNodes(owner);
      const content = nodes?.content;
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.body.classList.add('edge-dock-resizing');
      _setWidth(owner, side, e.clientX);
      const onMove = (ev) => {
        ev.preventDefault();
        _setWidth(owner, side, ev.clientX);
      };
      const onUp = (ev) => {
        try { handle.releasePointerCapture?.(e.pointerId); } catch (_) {}
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onUp, true);
        document.body.classList.remove('edge-dock-resizing');
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        const finalW = side === 'right'
          ? parseFloat(document.documentElement.style.getPropertyValue('--right-dock-w')) || content?.getBoundingClientRect?.().width || 0
          : content?.getBoundingClientRect?.().width || 0;
        if (finalW) _saveDockWidth(owner, content, side, finalW);
        ev.preventDefault();
      };
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
    });
  }

  new MutationObserver(_positionEdgeDockResizeHandles).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(_positionEdgeDockResizeHandles).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  let raf = 0;
  const schedulePosition = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      _positionEdgeDockResizeHandles();
    });
  };
  new MutationObserver(schedulePosition).observe(document.body, { childList: true });
  window.addEventListener('resize', _positionEdgeDockResizeHandles);
  window.addEventListener('odysseus:modal-opened', _positionEdgeDockResizeHandles);
  _positionEdgeDockResizeHandles();
})();

(function _initSplitSeamIndicator() {
  if (typeof document === 'undefined') return;
  const stripe = document.createElement('div');
  stripe.id = 'email-doc-split-seam';
  stripe.style.position = 'fixed';
  stripe.style.top = '0';
  stripe.style.bottom = '0';
  stripe.style.width = '10px';
  stripe.style.cursor = 'col-resize';
  stripe.style.zIndex = '9999';
  stripe.style.background = 'linear-gradient(to right, transparent 0 3px, color-mix(in srgb, var(--accent, var(--red)) 35%, transparent) 3px 7px, transparent 7px 10px)';
  stripe.style.pointerEvents = 'auto';
  stripe.style.touchAction = 'none';
  stripe.style.display = 'none';
  stripe.title = t('modal.drag_to_resize_email');

  const _activeLeftDockContent = () => {
    const modal = document.querySelector(
      '#email-lib-modal.modal-left-docked:not(.hidden), ' +
      '#email-lib-modal.email-snap-left:not(.hidden), ' +
      '.modal[id^="email-reader-"].modal-left-docked:not(.hidden), ' +
      '.modal[id^="email-reader-"].email-snap-left:not(.hidden)'
    );
    return modal?.querySelector?.('.modal-content') || null;
  };

  const _position = () => {
    const splitActive = document.body.classList.contains('email-doc-split-active')
      && document.body.classList.contains('doc-view')
      && window.innerWidth > 768;
    if (!splitActive) { stripe.style.display = 'none'; return; }
    const x = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--email-doc-split-right-x')) || 0;
    if (!x) { stripe.style.display = 'none'; return; }
    stripe.style.display = 'block';
    stripe.style.left = (x - 5) + 'px';
  };

  const _dragTo = (clientX) => {
    const content = _activeLeftDockContent();
    if (!content) return;
    const left = _leftNavRight();
    const w = _clampEmailDocSplitWidth(clientX - left, left);
    content._emailDocSplitUserW = w;
    content.style.left = left + 'px';
    content.style.width = w + 'px';
    content.style.maxWidth = w + 'px';
    _applyEmailDocSplitGeometry(left, w);
    _position();
  };

  stripe.addEventListener('pointerdown', (e) => {
    if (stripe.style.display === 'none') return;
    e.preventDefault();
    stripe.setPointerCapture?.(e.pointerId);
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.body.classList.add('email-doc-split-resizing');
    _dragTo(e.clientX);
    const onMove = (ev) => {
      ev.preventDefault();
      _dragTo(ev.clientX);
    };
    const onUp = (ev) => {
      try { stripe.releasePointerCapture?.(e.pointerId); } catch (_) {}
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      document.body.classList.remove('email-doc-split-resizing');
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      const rightX = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--email-doc-split-right-x')) || 0;
      const left = _leftNavRight();
      if (rightX > left) _saveEmailDocSplitWidth(rightX - left);
      ev.preventDefault();
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
  });

  document.body.appendChild(stripe);
  new MutationObserver(_position).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(_position).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  window.addEventListener('resize', _position);
  _position();
})();
