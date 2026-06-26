/**
 * tileManager.js — 桌面端工具模态框的窗口平铺管理。
 *
 * Hooks into any modal whose `.modal-header` is dragged (each tool wires its
 * own drag; we just watch pointer moves). Shows a translucent ghost preview
 * when the cursor is near a snap zone. On release, snaps the modal-content
 * to fill that zone with a springy animation.
 *
 * Snap zones:
 *   - over top edge               → fullscreen
 *   - top strip                   → maximize
 *   - top edge                    → top half
 *   - 左侧边缘                    → 左半屏
 *   - 右侧边缘                    → 右半屏
 *   - 底部边缘                    → 下半屏
 *
 * 移动端（≤768px）排除 — 滑动关闭 UX 优先。
 *
 * Each modal-content remembers its pre-snap geometry so dragging away restores
 * the original size.
 */

const EDGE_THRESHOLD_PX = 24;     // 多近算"靠近"边缘
const TOP_FULL_STRIP_PX = 8;      // 顶部条带 → 最大化

let _ghost = null;
let _activeZone = null;
let _tracking = null; // { content, startRect }

function _isDesktop() { return window.innerWidth > 768; }

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

function _clearDockSide(side, owner = null) {
  if (side !== 'left' && side !== 'right') return;
  if (_hasOtherDockedWindow(side, owner)) return;
  document.body.classList.remove(side === 'left' ? 'left-dock-active' : 'right-dock-active');
  document.documentElement.style.removeProperty(side === 'left' ? '--left-dock-w' : '--right-dock-w');
  if (side === 'left') {
    try { window._restoreSidebarIfRouteCollapsed?.(); } catch (_) {}
  }
}

function _ensureGhost() {
  if (_ghost) return _ghost;
  _ghost = document.createElement('div');
  _ghost.id = 'tile-ghost';
  document.body.appendChild(_ghost);
  return _ghost;
}

function _hideGhost() {
  if (_ghost) _ghost.classList.remove('visible');
}

function _showGhost(rect) {
  const g = _ensureGhost();
  g.style.left = rect.left + 'px';
  g.style.top  = rect.top  + 'px';
  g.style.width  = rect.width  + 'px';
  g.style.height = rect.height + 'px';
  g.classList.add('visible');
}

function _viewportSafeRect() {
  // 考虑视口左侧的图标栏 / 侧边栏。
  const sidebar = document.getElementById('sidebar');
  const rail = document.querySelector('.icon-rail') || document.querySelector('#icon-rail');
  let leftEdge = 0;
  const sb = sidebar?.getBoundingClientRect();
  if (sb && sb.right > 0 && !sidebar.classList.contains('hidden')) leftEdge = Math.max(leftEdge, sb.right);
  const rr = rail?.getBoundingClientRect();
  if (rr && rr.right > 0) leftEdge = Math.max(leftEdge, rr.right);
  return {
    left: leftEdge + 4,
    top: 4,
    right: window.innerWidth - 4,
    bottom: window.innerHeight - 4,
  };
}

function _zoneForPointer(x, y) {
  const safe = _viewportSafeRect();
  const W = safe.right - safe.left;
  const H = safe.bottom - safe.top;

  // 拖到顶部边缘上方（光标在最顶部或超过顶部）→ 真正的全屏，
  // 覆盖所有内容，包括侧边栏。
  if (y <= 0) {
    return { name: 'fullscreen', rect: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } };
  }
  // 靠近顶部边缘（但未超过）→ "最大化"：填满安全区域，
  // 即位于侧边栏/图标栏旁边而非覆盖它们。
  if (y <= safe.top + TOP_FULL_STRIP_PX) {
    return { name: 'maximize', rect: { left: safe.left, top: safe.top, width: W, height: H } };
  }

  // Symmetric edge half-snaps. The safe rect already starts to the right of
  // the sidebar/rail, so left-half fills the left side of the workspace
  // without covering navigation.
  if (y <= safe.top + EDGE_THRESHOLD_PX)
    return { name: 'top-half', rect: { left: safe.left, top: safe.top, width: W, height: H / 2 } };
  if (x <= safe.left + EDGE_THRESHOLD_PX)
    return { name: 'left-half', rect: { left: safe.left, top: safe.top, width: W / 2, height: H } };
  if (x >= safe.right - EDGE_THRESHOLD_PX)
    return { name: 'right-half', rect: { left: safe.left + W / 2, top: safe.top, width: W / 2, height: H } };
  if (y >= safe.bottom - EDGE_THRESHOLD_PX)
    return { name: 'bottom-half', rect: { left: safe.left, top: safe.top + H / 2, width: W, height: H / 2 } };

  return null;
}

function _zoneForContent(content, x, y) {
  const modal = content && content.closest && content.closest('.modal, .research-overlay');
  const zone = _zoneForPointer(x, y);
  if (!zone) return null;
  // 设置面板有密集的双列布局；全高侧边栏式停靠会
  // 压缩它。只允许平铺到普通的右半部分，当窗口变窄时
  // 导航可通过 CSS 翻转为顶部标签页。
  if (modal && modal.id === 'settings-modal' && zone.name !== 'right-half') return null;
  if (modal && (modal.id === 'cookbook-modal'
      || modal.id === 'theme-modal')
      && zone.name !== 'fullscreen') return null;
  return zone;
}

function _clearEdgeDockResidue(modal, content) {
  const hadDockState = !!(
    (modal && (modal.classList.contains('modal-left-docked') || modal.classList.contains('modal-right-docked')))
    || (content && (content._preDockSnapshot || content._dockSide || content._dockSuspended))
  );
  if (modal) {
    const hadLeft = modal.classList.contains('modal-left-docked');
    const hadRight = modal.classList.contains('modal-right-docked');
    modal.classList.remove('modal-left-docked', 'modal-right-docked');
    if (hadLeft) _clearDockSide('left', modal);
    if (hadRight) _clearDockSide('right', modal);
    if (modal._dockCloseWatcher) {
      try { modal._dockCloseWatcher.obs && modal._dockCloseWatcher.obs.disconnect(); } catch (_) {}
      try { modal._dockCloseWatcher.parentObs && modal._dockCloseWatcher.parentObs.disconnect(); } catch (_) {}
      delete modal._dockCloseWatcher;
    }
  }
  if (!content) return;
  if (content._leftDockNavObs) {
    try { content._leftDockNavObs.navObs.disconnect(); } catch (_) {}
    try { window.removeEventListener('resize', content._leftDockNavObs.reanchor); } catch (_) {}
    delete content._leftDockNavObs;
  }
  delete content._preDockSnapshot;
  delete content._dockSide;
  delete content._dockSuspended;
  if (hadDockState) {
    ['right', 'bottom', 'max-width', 'border-radius']
      .forEach(p => content.style.removeProperty(p));
  }
}

function _applySnap(content, rect, zoneName) {
  // A tile-snap supersedes any edge-dock on this same modal. The two
  // systems (windowDrag→modalSnap edge-dock, and this tile manager) both
  // fire on a left/right-edge drag-release. If we leave modalSnap's
  // `left-dock-active` body class + `--left-dock-w` 内边距，它会在左侧
  // reserves a strip on the left AND this manager's safe-rect already
  // accounts for the sidebar's (now padding-shifted) position — the two
  // double-count and jam the window to the right behind a massive empty
  // zone, which gets worse each time the sidebar is toggled. Clear the
  // orphaned edge-dock state so only the tile-snap positions the window.
  const _modal = content.closest && content.closest('.modal, .research-overlay');
  const _fromRect = content.getBoundingClientRect();
  _clearEdgeDockResidue(_modal, content);

  // 保存一次吸附前几何信息；如果重新吸附，保留原始信息。捕获一个
  // 具体的固定位置（当内联值为空时从渲染的矩形获取）
  // 和位置本身 — 否则取消吸附恢复空的 left/top
  // + 无定位，而 .modal flex 父元素会重新居中窗口。
  if (!content.dataset._tilePreSnap) {
    content.dataset._tilePreSnap = JSON.stringify({
      position: 'fixed',
      left:   content.style.left || (Math.round(_fromRect.left) + 'px'),
      top:    content.style.top  || (Math.round(_fromRect.top)  + 'px'),
      width:  content.style.width,
      height: content.style.height,
      maxHeight: content.style.maxHeight,
      transform: content.style.transform,
    });
  }
  content.style.transition = 'left 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), top 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), width 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), height 0.22s cubic-bezier(0.34, 1.56, 0.64, 1)';
  // 使用 !important — 某些模态框（如 cookbook）带有内联宽/高
  // 和会重新居中 .modal-content 的 CSS，这会让吸附在释放时
  // "跳回中间"。
  content.style.setProperty('position', 'fixed', 'important');
  content.style.setProperty('left',   rect.left   + 'px', 'important');
  content.style.setProperty('top',    rect.top    + 'px', 'important');
  content.style.setProperty('width',  rect.width  + 'px', 'important');
  content.style.setProperty('height', rect.height + 'px', 'important');
  content.style.setProperty('max-height', rect.height + 'px', 'important');
  content.style.setProperty('margin', '0', 'important');
  content.style.setProperty('transform', 'none', 'important');
  content.dataset._tileZone = zoneName;
  setTimeout(() => { content.style.transition = ''; }, 250);
}

function _unsnap(content) {
  const pre = content.dataset._tilePreSnap;
  if (!pre) return;
  // 先清除 !important 吸附属性 — Object.as签名 无法覆盖它们。
  ['position', 'left', 'top', 'width', 'height', 'max-height', 'margin', 'transform']
    .forEach(p => content.style.removeProperty(p));
  try {
    const r = JSON.parse(pre);
    Object.assign(content.style, r);
  } catch {}
  // 保持固定浮动窗口使恢复的 left/top 真正生效 —
  // 没有 position:fixed 的话 .modal flex 父元素会重新居中它。
  if (!content.style.position) content.style.position = 'fixed';
  delete content.dataset._tilePreSnap;
  delete content.dataset._tileZone;
}

function _findDragTarget(e) {
  const header = e.target.closest('.modal-header');
  if (!header) return null;
  // 跳过标题栏按钮上的点击（关闭、最小化等）
  if (e.target.closest('button')) return null;
  const modal = header.closest('.modal, .research-overlay');
  if (!modal) return null;
  const content = modal.querySelector('.modal-content, .research-pane');
  return content || null;
}

document.addEventListener('pointerdown', (e) => {
  if (!_isDesktop()) return;
  const content = _findDragTarget(e);
  if (!content) return;

  // If we're already snapped, dragging away should unsnap immediately so the
  // user can move freely.
  if (content.dataset._tileZone) {
    // 稍微延迟使 pointermove 阈值在取消吸附前满足
    _tracking = { content, startX: e.clientX, startY: e.clientY, willUnsnap: true };
  } else {
    _tracking = { content, startX: e.clientX, startY: e.clientY, willUnsnap: false };
  }
});

document.addEventListener('pointermove', (e) => {
  if (!_tracking) return;
  if (!_isDesktop()) return;
  const dx = e.clientX - _tracking.startX;
  const dy = e.clientY - _tracking.startY;
  if (Math.hypot(dx, dy) < 6) return;

  // 首次显著移动时取消吸附
  if (_tracking.willUnsnap) {
    _unsnap(_tracking.content);
    _tracking.willUnsnap = false;
  }

  // 检测光标下的吸附区域
  const zone = _zoneForContent(_tracking.content, e.clientX, e.clientY);
  if (zone) {
    _showGhost(zone.rect);
    _activeZone = zone;
  } else {
    _hideGhost();
    _activeZone = null;
  }
});

document.addEventListener('pointerup', () => {
  if (!_tracking) return;
  const t = _tracking;
  _tracking = null;
  _hideGhost();
  if (_activeZone && _isDesktop()) {
    _applySnap(t.content, _activeZone.rect, _activeZone.name);
  }
  _activeZone = null;
});

// Re-clamp every currently-snapped window so it keeps filling its zone after
// the safe-rect changes (viewport resize, sidebar toggle, etc.).
function _reclampAll(animate = false) {
  document.querySelectorAll('.modal-content[data-_tile-zone], .research-pane[data-_tile-zone]').forEach(c => {
    const name = c.dataset._tileZone;
    if (!name) return;
    const safe = _viewportSafeRect();
    const W = safe.right - safe.left, H = safe.bottom - safe.top;
    let r;
    switch (name) {
      case 'fullscreen':     r = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }; break;
      case 'maximize':       r = { left: safe.left, top: safe.top, width: W, height: H }; break;
      case 'top-half':       r = { left: safe.left, top: safe.top, width: W, height: H/2 }; break;
      case 'left-half':      r = { left: safe.left, top: safe.top, width: W/2, height: H }; break;
      case 'right-half':     r = { left: safe.left + W/2, top: safe.top, width: W/2, height: H }; break;
      case 'bottom-half':    r = { left: safe.left, top: safe.top + H/2, width: W, height: H/2 }; break;
      case 'top-left':       r = { left: safe.left, top: safe.top, width: W/2, height: H/2 }; break;
      case 'top-right':      r = { left: safe.left + W/2, top: safe.top, width: W/2, height: H/2 }; break;
      case 'bottom-left':    r = { left: safe.left, top: safe.top + H/2, width: W/2, height: H/2 }; break;
      case 'bottom-right':   r = { left: safe.left + W/2, top: safe.top + H/2, width: W/2, height: H/2 }; break;
      default: return;
    }
    if (animate) {
      c.style.transition = 'left 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), top 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), width 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), height 0.22s cubic-bezier(0.34, 1.56, 0.64, 1)';
      setTimeout(() => { c.style.transition = ''; }, 250);
    }
    c.style.setProperty('left', r.left + 'px', 'important');
    c.style.setProperty('top',  r.top  + 'px', 'important');
    c.style.setProperty('width', r.width + 'px', 'important');
    c.style.setProperty('height', r.height + 'px', 'important');
    c.style.setProperty('max-height', r.height + 'px', 'important');
  });
}

let _reclampPending = false;
function _reclampAllThrottled(animate) {
  if (_reclampPending) return;
  _reclampPending = true;
  requestAnimationFrame(() => {
    try { _reclampAll(animate); } finally { _reclampPending = false; }
  });
}

window.addEventListener('resize', () => _reclampAllThrottled(false));

// 观察侧边栏的 class 属性，使切换 hidden/right-side 时重新平铺
// 任何锚定到旧 safe-rect 的已吸附模态框。
function _watchSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) {
    // 侧边栏可能在早期初始化时还不在 DOM 中。
    requestAnimationFrame(_watchSidebar);
    return;
  }
  const mo = new MutationObserver(() => _reclampAllThrottled(true));
  mo.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _watchSidebar);
} else {
  _watchSidebar();
}

// ── 公共 API，供其他拖拽源（例如将最小化停靠标签拖到
// 屏幕边缘）复用相同的吸附区域 + 幽灵预览 + 应用。 ──

// 对某个点显示吸附区域幽灵并返回区域（或 null）。
export function previewZoneAt(x, y, target = null) {
  if (!_isDesktop()) { _hideGhost(); _activeZone = null; return null; }
  const content = target && target.querySelector
    ? (target.querySelector('.modal-content, .research-pane') || target)
    : null;
  const zone = content ? _zoneForContent(content, x, y) : _zoneForPointer(x, y);
  if (zone) { _showGhost(zone.rect); _activeZone = zone; }
  else { _hideGhost(); _activeZone = null; }
  return zone;
}

export function clearPreview() {
  _hideGhost();
  _activeZone = null;
}

export function _zoneForPointerForTests(x, y) {
  return _zoneForPointer(x, y);
}

export function _zoneForContentForTests(content, x, y) {
  return _zoneForContent(content, x, y);
}

// 将模态框（其 .modal-content）吸附到之前检测到的区域。
export function snapModalToZone(modal, zone) {
  if (!modal || !zone) return;
  const content = modal.querySelector ? (modal.querySelector('.modal-content, .research-pane') || modal) : modal;
  if (!content) return;
  if (modal.id === 'settings-modal' && zone.name !== 'right-half') return;
  _applySnap(content, zone.rect, zone.name);
}

export {};
