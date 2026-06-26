/**
 * Canvas event wiring — mouse, touch (including pinch-zoom on two
 * fingers), and the canvas-area pan handler.
 *
 *   鼠标：
 *     mousedown 在画布上    → beginDraw
 *     mousemove 在 window 上 → continueDraw（在 window 上以便拖拽
 *                              可以延续到画布边缘之外）
 *     mouseup 在 window 上   → endDraw
 *     mouseenter/mouseleave  → 显示/隐藏画笔光标叠加层
 *     mousedown 在画布区域上（不在画布本身，仅套索工具）
 *                            → beginDraw（套索从画布外部开始）
 *
 *   触摸：
 *     touchstart 1 个手指    → beginDraw
 *     touchmove  1 个手指    → continueDraw
 *     touchend / touchcancel → endDraw
 *     touchstart 2 个手指    → 双指缩放 + 双指平移
 *
 *   平移（画布周围的任意空闲区域）：
 *     canvas-area 上的 pointerdown / pointermove / pointerup，
 *     跳过画布 + 变换叠加层 + 它们上方的 UI 元素。
 *     在 canvasArea.dataset.panX/Y 上设置值 + 对两个画布应用 CSS transform。
 *
 *   暴露 `canvasArea._resetPan()` 以便缩放/适配重置可以清除平移偏移。
 *   the pan offset.
 *
 * @param {{
 *   canvasArea:        HTMLDivElement,
 *   beginDraw:         (e: Event) => void,
 *   continueDraw:      (e: Event) => void,
 *   endDraw:           (e?: Event) => void,
 *   updateBrushCursor: (e: Event) => void,
 *   syncZoomControls?: () => void,
 * }} ctx
 */
import { state } from './state.js';

export function wireCanvasEvents({ canvasArea, beginDraw, continueDraw, endDraw, updateBrushCursor, syncZoomControls }) {
  // 鼠标 — mousedown 绑定在画布上；mousemove/up 绑定在
  // WINDOW 上，以便拖拽可以继续（并结束）到画布边缘之外。
  // 对于调整大小工具尤其重要，因为用户可能拖出画布范围。
  state.mainCanvas.addEventListener('mousedown', beginDraw);
  window.addEventListener('mousemove', continueDraw);
  window.addEventListener('mouseup', endDraw);
  // 套索可以从画布外部开始 — 在周围的 canvas-area 上
  // 绑定 mousedown 回退，以便用户可以在图像周围的空白区域
  // 开始套索路径。其他工具保持仅画布触发。
  canvasArea.addEventListener('mousedown', (e) => {
    if (state.tool !== 'lasso') return;
    if (e.target === state.mainCanvas) return; // 已被处理
    beginDraw(e);
  });
  state.mainCanvas.addEventListener('mouseenter', (e) => {
    if (['brush', 'eraser', 'inpaint', 'lasso', 'clone'].includes(state.tool)) updateBrushCursor(e);
  });
  state.mainCanvas.addEventListener('mouseleave', () => {
    // 仅在离开时隐藏画笔光标叠加层 — 不要结束
    // 拖拽，这样用户可以将调整大小手柄拖到画布边缘之外。
    if (state.cursorEl) state.cursorEl.style.display = 'none';
  });

  // 触摸 — 单指绘制；双指平移 + 双指缩放。
  let multiActive = false;
  let multiStartDist = 0;
  let multiStartZoom = 1;
  let multiStartCenter = { x: 0, y: 0 };
  let multiStartPan = { x: 0, y: 0 };
  const touchInfo = (e) => {
    const t1 = e.touches[0], t2 = e.touches[1];
    const cx = (t1.clientX + t2.clientX) / 2;
    const cy = (t1.clientY + t2.clientY) / 2;
    const dx = t2.clientX - t1.clientX;
    const dy = t2.clientY - t1.clientY;
    return { cx, cy, dist: Math.hypot(dx, dy) };
  };
  const applyCanvasOffset = (x, y) => {
    canvasArea.dataset.panX = String(x);
    canvasArea.dataset.panY = String(y);
    const t = `translate3d(${x}px, ${y}px, 0)`;
    state.mainCanvas.style.transform = t;
    if (state.transformOverlay) state.transformOverlay.style.transform = t;
  };
  state.mainCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (e.touches.length >= 2) {
      // 在切换模式之前结束任何进行中的单指绘制。
      if (!multiActive) endDraw();
      multiActive = true;
      const info = touchInfo(e);
      multiStartDist = info.dist;
      multiStartZoom = state.zoom;
      multiStartCenter = { x: info.cx, y: info.cy };
      multiStartPan = {
        x: parseFloat(canvasArea.dataset.panX || '0') || 0,
        y: parseFloat(canvasArea.dataset.panY || '0') || 0,
      };
      return;
    }
    if (multiActive) return;
    beginDraw(e);
  }, { passive: false });
  state.mainCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (multiActive && e.touches.length >= 2) {
      const info = touchInfo(e);
      const ratio = info.dist / Math.max(1, multiStartDist);
      const newZoom = Math.max(0.1, Math.min(5, multiStartZoom * ratio));
      if (Math.abs(newZoom - state.zoom) > 0.001) {
        state.zoom = newZoom;
        state.mainCanvas.style.width = (state.imgWidth * state.zoom) + 'px';
        state.mainCanvas.style.height = (state.imgHeight * state.zoom) + 'px';
        const label = state.container.querySelector('.ge-zoom-label');
        if (label) label.textContent = Math.round(state.zoom * 100) + '%';
        syncZoomControls?.();
      }
      const dx = info.cx - multiStartCenter.x;
      const dy = info.cy - multiStartCenter.y;
      applyCanvasOffset(multiStartPan.x + dx, multiStartPan.y + dy);
      return;
    }
    if (multiActive) return;
    continueDraw(e);
  }, { passive: false });
  state.mainCanvas.addEventListener('touchend', (e) => {
    if (multiActive) {
      if (e.touches.length < 2) multiActive = false;
      return;
    }
    endDraw(e);
  });
  state.mainCanvas.addEventListener('touchcancel', () => {
    multiActive = false;
    endDraw();
  });

  // Press-and-drag in the empty space AROUND the canvas pans the
  // canvas + overlay via CSS transform. Works even when the 镜像
  // fits the viewport (no scroll needed). Skips presses on the canvas
  // itself (the canvas owns its own drawing input) or on UI elements
  // above it.
  let panning = false;
  let pid = null;
  let startX = 0, startY = 0;
  const getOffset = () => {
    const v = canvasArea.dataset.panX || '0';
    const u = canvasArea.dataset.panY || '0';
    return { x: parseFloat(v) || 0, y: parseFloat(u) || 0 };
  };
  const applyOffset = (x, y) => {
    canvasArea.dataset.panX = String(x);
    canvasArea.dataset.panY = String(y);
    const t = `translate3d(${x}px, ${y}px, 0)`;
    state.mainCanvas.style.transform = t;
    if (state.transformOverlay) state.transformOverlay.style.transform = t;
  };
  canvasArea.addEventListener('pointerdown', (e) => {
    if (state.tool === 'lasso') return;
    if (e.target === state.mainCanvas || e.target === state.transformOverlay) return;
    if (e.target.closest('button, input, .ge-adj-popup, .ge-transform-popup, .ge-fx-popup, .ge-inpaint-popup, .ge-controls, .ge-right-panel, .ge-fx-menu')) return;
    // 在活动变换期间，角/旋转手柄渲染在画布外部
    // （在周围区域上方），而叠加层是 pointer-events:none — 
    // 因此对外部手柄的抓取会落在此处。
    // 将其路由到变换工具（getHandleAt 在图像空间中工作，
    // 即使对于超出画布的点也可以），而不是平移画布。
    if (state.transformActive) {
      beginDraw(e);
      // Only swallow the event (skip pan) if a handle was grabbed OR the
      // layer-move 回退 engaged; otherwise let the pan logic below
      // run so empty space still pans while the transform tool is open.
      if (state.transformHandle || state.moving) return;
    }
    const off = getOffset();
    panning = true;
    pid = e.pointerId;
    startX = e.clientX - off.x;
    startY = e.clientY - off.y;
    try { canvasArea.setPointerCapture(pid); } catch {}
    canvasArea.style.cursor = 'grabbing';
    e.preventDefault();
  });
  canvasArea.addEventListener('pointermove', (e) => {
    if (!panning || e.pointerId !== pid) return;
    applyOffset(e.clientX - startX, e.clientY - startY);
  });
  const endPan = () => {
    if (!panning) return;
    panning = false;
    try { canvasArea.releasePointerCapture(pid); } catch {}
    pid = null;
    canvasArea.style.cursor = '';
  };
  canvasArea.addEventListener('pointerup', endPan);
  canvasArea.addEventListener('pointercancel', endPan);
  // 每当缩放/适配改变画布大小时重置偏移。
  canvasArea._resetPan = () => applyOffset(0, 0);
}
