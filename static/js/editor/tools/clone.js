/**
 * 克隆工具 — Alt-点击（桌面端）或双击（移动端）设置采样源；
 * 普通点击+拖拽从该源采样到当前图层。源点随画笔移动，
 * 使偏移量在笔划过程中保持不变。
 *
 * begin() 处理源选取和笔划开始分支；
 * 实际的逐采样点绘制通过共享的笔划管线（`_strokeTo`）继续，
 * 该管线内部了解克隆模式。
 *
 * @param {{
 *   activeLayer: () => object | null,
 *   saveState:   (label?: string) => void,
 *   strokeTo:    (x: number, y: number) => void,
 *   showToast:   (msg: string) => void,
 * }} deps
 */
import { state } from '../state.js';
import { canvasCoords } from '../canvas-coords.js';

export function createCloneTool({ activeLayer, saveState, strokeTo, showToast }) {
  return {
    begin(e) {
      const layer = activeLayer();
      const coords = canvasCoords(e, state.mainCanvas);
      // 移动端等效于 Alt-点击：屏幕像素中的双击。
      // 比桌面端更宽松的容差（500 毫秒，40 像素），
      // 因为手指点击比鼠标点击漂移更多。
      const isTouchEvt = e.type && e.type.startsWith('touch');
      let isDoubleTap = false;
      if (isTouchEvt) {
        const t = e.touches ? e.touches[0] : null;
        const cx = t ? t.clientX : 0;
        const cy = t ? t.clientY : 0;
        const now = Date.now();
        const dt = now - state.cloneLastTapTime;
        const dx = cx - state.cloneLastTapX;
        const dy = cy - state.cloneLastTapY;
        if (dt < 500 && Math.hypot(dx, dy) < 40) {
          isDoubleTap = true;
          state.cloneLastTapTime = 0; // 消费该双击对
        } else {
          state.cloneLastTapTime = now;
          state.cloneLastTapX = cx;
          state.cloneLastTapY = cy;
        }
      }
      if (e.altKey || isDoubleTap) {
        state.cloneSourceX = coords.x;
        state.cloneSourceY = coords.y;
        state.cloneSourceLayerId = (layer && layer.id) || state.activeLayerId;
        state.cloneSourceSnapshot = null; // 在第一次笔划时捕获
        showToast('Clone source set');
        return;
      }
      if (state.cloneSourceX === null || state.cloneSourceY === null) {
        showToast(isTouchEvt
          ? 'Double-tap first to set a clone source'
          : 'Alt-click first to set a clone source');
        return;
      }
      if (!layer || layer.locked) return;
      saveState('Clone stroke');
      // 在笔划开始时快照源图层的像素，这样画笔在已绘制过的
      // 区域仍能采样到干净的源像素。否则会造成级联克隆同一区域。
      const srcLayer = state.layers.find(l => l.id === state.cloneSourceLayerId) || layer;
      const snap = document.createElement('canvas');
      snap.width = srcLayer.canvas.width;
      snap.height = srcLayer.canvas.height;
      snap.getContext('2d').drawImage(srcLayer.canvas, 0, 0);
      state.cloneSourceSnapshot = snap;
      state.cloneStrokeStartX = coords.x;
      state.cloneStrokeStartY = coords.y;
      state.drawing = true;
      state.lastX = coords.x;
      state.lastY = coords.y;
      strokeTo(coords.x, coords.y);
    },
  };
}
