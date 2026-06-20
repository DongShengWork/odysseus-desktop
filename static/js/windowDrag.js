// 共享的窗口拖拽辅助函数。替换了在 calendar.js、tasks.js、
// gallery.js、emailLibrary.js、documentLibrary.js、theme.js 中
// 重复复制的 mousedown / mousemove / mouseup + 吸附到顶部全屏 +
// 左/右边缘停靠模式。行为与旧的逐文件副本完全相同 —
// 每个调用处提供自己的进入/退出全屏回调，因为不同模态框的
// CSS class 和内联样式各不相同。
//
// 接口：
//   makeWindowDraggable(modal, { content, header, ...options })
//     modal:           包裹的 .modal 元素（或独立面板）
//     content:         被移动的元素（通常是 .modal-content）
//     header:          拖拽手柄（通常是 .modal-header）
//     fsClass:         可选的表示"全屏"状态的 class 名称
//     onEnterFullscreen: 可选 () => void — 当光标在靠近顶部边缘
//                        （向下 > UNSNAP_PX 或在停靠吸附范围内
//                        添加 fsClass 并应用产生全屏布局的内联样式。
//                        默认 true，前提是提供了 onEnterFullscreen。
//     onExitFullscreen:  可选 (cx, cy) => void — 拖拽过程中当光标
//                        默认 true，前提是提供了 onEnterFullscreen。
//                        （向下 > UNSNAP_PX 或在停靠吸附范围内
//                        默认 true。
//                        默认 true。
//     skipSelector:    header 内元素的 CSS 选择器，这些元素上的
//                        默认 true。
//                        表单字段等）。默认: 'button, input, select'
//     onDragEnd:       可选 (state) => void — 在 mouseup 后且
//                        没有触发吸附时触发。state = { rect }，
//                        默认 true。
//     enableTouch:     bool — 也绑定 touchstart/touchmove/touchend，
//                        默认 true，前提是提供了 onEnterFullscreen。
//                        桌面端默认为 true，移动端无关（mobileSkip）。
//     mobileSkip:      drag is disabled below this viewport width.
//                        默认 768。设为 0 永不跳过。
//     enableDock:      bool — 启用左 + 右边缘停靠。
//                        默认 true。
//     enableFullscreen: bool — 启用顶部边缘全屏吸附。
//                        默认 true，前提是提供了 onEnterFullscreen。

import { makeEdgeDockController } from './modalSnap.js';
import { makeWindowResizable } from './windowResize.js';

const SNAP_PX = 6;        // 光标距离顶部边缘的距离触发全屏吸附
const UNSNAP_PX = 24;     // 光标距离顶部的距离触发全屏退出
const DOCK_EDGE_PX = 60;  // 光标距离左/右边缘的距离，在全屏状态
                          // 下触发停靠退出

// CSS-var lookup for the rail+sidebar width — used to decide where the
// "left edge" effectively is during a fullscreen drag-out (the cursor
// has to pass the rail to count as "near left").
function _leftNavWidth() {
  const rs = getComputedStyle(document.documentElement);
  const rail = parseInt(rs.getPropertyValue('--icon-rail-w') || '48', 10) || 0;
  const sb = parseInt(rs.getPropertyValue('--sidebar-w') || '0', 10) || 0;
  return rail + sb;
}

export function makeWindowDraggable(modal, options = {}) {
  const content = options.content;
  const header = options.header;
  if (!content || !header) return;
  const fsClass = options.fsClass || null;
  const onEnterFullscreen = options.onEnterFullscreen || null;
  const onExitFullscreen = options.onExitFullscreen || null;
  const enableFullscreen = false;
  const onDragEnd = options.onDragEnd || null;
  const onDragStart = options.onDragStart || null;
  const skipSelector = options.skipSelector || 'button, input, select';
  const mobileSkip = (typeof options.mobileSkip === 'number') ? options.mobileSkip : 768;
  const enableTouch = options.enableTouch !== false;
  const enableDock = options.enableDock !== false && !!modal;

  header.style.cursor = 'move';
  header.style.userSelect = 'none';

  // 边缘/角落调整大小。每个可拖拽窗口也变为可调整大小 — 与
  // 原生桌面窗口相同的手势（抓住边缘或角落，拖动）。
  // 在移动端跳过（窗口是全屏面板）以及窗口处于
  // 全屏吸附或停靠状态时跳过。在此绑定，这样所有约 12 个调用处
  // 无需逐文件修改即可获得此功能。
  if (options.enableResize !== false) {
    const _dockClasses = ['modal-right-docked', 'modal-left-docked'];
    makeWindowResizable(content, {
      modal,
      mobileSkip,
      minWidth: options.minWidth,
      minHeight: options.minHeight,
      isLocked: () => (fsClass && modal && modal.classList.contains(fsClass))
        || (modal && _dockClasses.some((c) => modal.classList.contains(c))),
      storageKey: options.resizeStorageKey
        || (modal && modal.id ? 'winsize-' + modal.id
          : (content.id ? 'winsize-' + content.id : null)),
    });
  }

  const rightDock = enableDock ? makeEdgeDockController(modal, 'right') : null;
  // Left dock is enabled by default too. modalSnap collapses the wide sidebar
  // and anchors the panel beside the icon rail, so it no longer collides with
  // the navigation. Callers can still pass enableLeftDock:false for a special
  // modal that should only dock right.
  const leftDock = (enableDock && options.enableLeftDock !== false) ? makeEdgeDockController(modal, 'left') : null;

  // 每次拖拽的状态，在 mousedown 时重置。
  let dragging = false;
  let startX = 0, startY = 0;
  let startLeft = 0, startTop = 0;
  let snapHint = null;
  // 本次拖拽中指针是否实际移动超过小阈值。
  // 用于抑制浏览器在 mouseup 后触发的合成点击 —
  // header 的点击处理器（例如"折叠展开的卡片 / 返回列表"）
  // 否则会在拖拽后触发并折叠模态框内容。
  let movedDuringDrag = false;
  const MOVE_THRESHOLD = 4;

  const _showSnapHint = (on) => {
    // 顶部边缘全屏提示。侧边提示来自停靠控制器。
    if (!on) {
      if (snapHint) { snapHint.remove(); snapHint = null; }
      return;
    }
    if (snapHint) return;
    snapHint = document.createElement('div');
    snapHint.className = 'modal-snap-hint';
    snapHint.style.cssText =
      'position:fixed;left:0;top:0;right:0;bottom:0;' +
      'background:color-mix(in srgb, var(--accent-primary, #60a5fa) 12%, transparent);' +
      'border:2px dashed color-mix(in srgb, var(--accent-primary, #60a5fa) 60%, transparent);' +
      'z-index:9998;pointer-events:none;';
    document.body.appendChild(snapHint);
  };

  const _enterFs = () => {
    if (!onEnterFullscreen) return;
    if (fsClass && modal && modal.classList.contains(fsClass)) return;
    onEnterFullscreen();
  };
  const _exitFs = (cx, cy) => {
    if (!onExitFullscreen) return;
    if (fsClass && modal && !modal.classList.contains(fsClass)) return;
    onExitFullscreen(cx, cy);
    // 退出后，将拖拽偏移重新锚定到新的窗口化矩形，
    // 使拖拽从光标位置流畅继续。
    const r = content.getBoundingClientRect();
    startX = cx; startY = cy;
    startLeft = r.left; startTop = r.top;
  };

  const _isFullscreen = () => fsClass && modal && modal.classList.contains(fsClass);

  const _startDrag = (cx, cy) => {
    dragging = true;
    if (modal) modal.classList.add('modal-dragging');
    // 取消任何正在进行的打开动画，以免我们固定一个动画中间
    // 的矩形，然后在动画完成后跳转。
    try {
      content.getAnimations()
        .filter(a => a.playState !== 'finished')
        .forEach(a => a.cancel());
    } catch (_) {}
    const rect = content.getBoundingClientRect();
    if (onDragStart) {
      try { onDragStart({ rect, cx, cy }); } catch (_) {}
    }
    startX = cx; startY = cy;
    startLeft = rect.left; startTop = rect.top;
    // 固定位置使拖拽跟随光标而不是与
    // 居中变换 / 边距对抗。内联样式优先，除非 CSS 使用
    // `!important`（全屏规则设计上使用了 !important）。
    content.style.position = 'fixed';
    content.style.left = startLeft + 'px';
    content.style.top = startTop + 'px';
    content.style.transform = 'none';
    content.style.margin = '0';
  };

  const _onMove = (cx, cy) => {
    if (!dragging) return;
    // 全屏状态：向下拖拽或向任一水平边缘拖拽时取消吸附。
    // 退出后立即更新停靠悬停状态，以便快速释放提交停靠
    // 而不是把模态框丢在半空中。
    if (_isFullscreen()) {
      // Corner guard: ignore the side edges while the cursor is still in the
      // top fullscreen band, so dragging across the top corners keeps
      // fullscreen instead of flipping into a corner dock.
      const inTopBand = cy <= SNAP_PX;
      const nearRight = !inTopBand && (window.innerWidth - cx) <= DOCK_EDGE_PX;
      const nearLeft = !inTopBand && (cx - _leftNavWidth()) <= DOCK_EDGE_PX;
      // Dragging a fullscreen window to a SIDE edge → keep it fullscreen and
      // just arm the side-dock hint; releasing there docks it (handled in
      // _onEnd, which drops the fullscreen class). Previously this exited
      // fullscreen first, which re-CENTERED the window — so it looked like
      // it "centered instead of docking". Only a downward drag unsnaps to a
      // windowed (centered) modal.
      if (nearRight && rightDock) {
        if (leftDock) leftDock.release();
        rightDock.onMove(cx, cy);
        return;
      }
      if (nearLeft && leftDock) {
        if (rightDock) rightDock.release();
        leftDock.onMove(cx, cy);
        return;
      }
      if (cy > UNSNAP_PX) {
        _exitFs(cx, cy);
        if (rightDock) rightDock.onMove(cx, cy);
        if (leftDock) leftDock.onMove(cx, cy);
      } else {
        if (rightDock) rightDock.release();
        if (leftDock) leftDock.release();
      }
      return;
    }
    // 右停靠：拖离右边缘取消停靠。左边同理。
    if (rightDock && modal && modal.classList.contains('modal-right-docked')) {
      if (rightDock.onMove(cx, cy)) {
        const r = content.getBoundingClientRect();
        startX = cx; startY = cy;
        startLeft = r.left; startTop = r.top;
      }
      return;
    }
    if (leftDock && modal && modal.classList.contains('modal-left-docked')) {
      if (leftDock.onMove(cx, cy)) {
        const r = content.getBoundingClientRect();
        startX = cx; startY = cy;
        startLeft = r.left; startTop = r.top;
      }
      return;
    }
    // 窗口化：直接跟随光标。
    if (Math.abs(cx - startX) > MOVE_THRESHOLD || Math.abs(cy - startY) > MOVE_THRESHOLD) {
      movedDuringDrag = true;
    }
    content.style.left = (startLeft + cx - startX) + 'px';
    content.style.top = (startTop + cy - startY) + 'px';
    // 角落守卫：在顶部全屏条带内，侧边停靠保持关闭，所以
    // 顶部角落只吸附到全屏 — 永远不会是角落混合。
    const inTopBand = cy <= SNAP_PX;
    _showSnapHint(enableFullscreen && inTopBand);
    if (inTopBand) {
      if (rightDock) rightDock.release();
      if (leftDock) leftDock.release();
    } else {
      if (rightDock) rightDock.onMove(cx, cy);
      if (leftDock) leftDock.onMove(cx, cy);
    }
  };

  const _onEnd = (cx, cy) => {
    if (!dragging) return;
    dragging = false;
    if (modal) modal.classList.remove('modal-dragging');
    _showSnapHint(false);
    // 顶部边缘优先于侧边边缘 — 全屏是更常见的手势。
    if (enableFullscreen && typeof cy === 'number' && cy <= SNAP_PX) {
      if (rightDock) rightDock.release();
      if (leftDock) leftDock.release();
      _enterFs();
      return;
    }
    if (rightDock && rightDock.hovering()) {
      if (leftDock) leftDock.release();
      if (fsClass && modal) modal.classList.remove(fsClass);  // 停靠接管全屏
      rightDock.commit();
      return;
    }
    if (leftDock && leftDock.hovering()) {
      if (rightDock) rightDock.release();
      if (fsClass && modal) modal.classList.remove(fsClass);
      leftDock.commit();
      return;
    }
    if (rightDock) rightDock.release();
    if (leftDock) leftDock.release();
    if (onDragEnd) {
      const r = content.getBoundingClientRect();
      try { onDragEnd({ rect: r }); } catch (_) {}
    }
  };

  header.addEventListener('mousedown', (e) => {
    if (mobileSkip > 0 && window.innerWidth <= mobileSkip) return;
    if (skipSelector && e.target.closest(skipSelector)) return;
    e.preventDefault();
    movedDuringDrag = false;
    _startDrag(e.clientX, e.clientY);
    const onMove = (ev) => _onMove(ev.clientX, ev.clientY);
    const onUp = (ev) => {
      _onEnd(ev.clientX, ev.clientY);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // 如果指针实际移动了，吞掉浏览器接下来触发的
      // 合成点击 — 否则 header 的点击处理器（折叠展开的卡片 /
      // "返回列表"）会运行并撤销拖拽意图。
      if (movedDuringDrag) {
        const swallow = (clickEv) => {
          clickEv.stopPropagation();
          clickEv.preventDefault();
        };
        header.addEventListener('click', swallow, { capture: true, once: true });
        // 安全措施：如果没有点击触发（某些浏览器），移除监听器。
        setTimeout(() => header.removeEventListener('click', swallow, { capture: true }), 50);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  if (enableTouch) {
    header.addEventListener('touchstart', (e) => {
      if (mobileSkip > 0 && window.innerWidth <= mobileSkip) return;
      if (skipSelector && e.target.closest(skipSelector)) return;
      const t = e.touches[0];
      if (!t) return;
      movedDuringDrag = false;
      _startDrag(t.clientX, t.clientY);
      const onMove = (ev) => {
        const tt = ev.touches[0];
        if (tt) _onMove(tt.clientX, tt.clientY);
      };
      const onEnd = (ev) => {
        const tt = (ev.changedTouches && ev.changedTouches[0]) || null;
        _onEnd(tt ? tt.clientX : null, tt ? tt.clientY : null);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
      };
      document.addEventListener('touchmove', onMove, { passive: true });
      document.addEventListener('touchend', onEnd);
      document.addEventListener('touchcancel', onEnd);
    }, { passive: true });
  }
}
