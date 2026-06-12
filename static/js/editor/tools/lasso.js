/**
 * 套索工具 — 自由手绘多边形选区。鼠标按下开始新的
 * 多边形；每次移动添加一个点并重绘虚线轮廓；
 * 鼠标松开保持选区可见（面板的操作按钮
 * 读取 `state.lassoPoints` 来对其进行操作）。
 *
 * 拥有自己的 begin/drag/end 处理器，读写共享状态。
 *
 * @param {{
 *   composite:                 () => void,
 *   drawLassoOverlay:          () => void,
 *   syncToolClearIndicators:   () => void,
 * }} deps
 */
import { state } from '../state.js';
import { canvasCoords } from '../canvas-coords.js';

export function createLassoTool({ composite, drawLassoOverlay, syncToolClearIndicators }) {
  return {
    begin(e) {
      state.lassoPoints = [];
      state.lassoActive = true;
      const coords = canvasCoords(e, state.mainCanvas);
      state.lassoPoints.push(coords);
    },

    drag(e) {
      if (!state.lassoActive) return;
      e.preventDefault();
      const coords = canvasCoords(e, state.mainCanvas);
      state.lassoPoints.push(coords);
      // 实时覆盖层：虚线白色轮廓 + 半透明红色填充。
      composite();
      if (state.lassoPoints.length > 1) {
        state.mainCtx.beginPath();
        state.mainCtx.moveTo(state.lassoPoints[0].x, state.lassoPoints[0].y);
        for (let i = 1; i < state.lassoPoints.length; i++) {
          state.mainCtx.lineTo(state.lassoPoints[i].x, state.lassoPoints[i].y);
        }
        state.mainCtx.closePath();
        state.mainCtx.strokeStyle = '#fff';
        state.mainCtx.lineWidth = 1 / state.zoom;
        state.mainCtx.setLineDash([4 / state.zoom, 4 / state.zoom]);
        state.mainCtx.stroke();
        state.mainCtx.setLineDash([]);
        state.mainCtx.fillStyle = 'rgba(255, 80, 80, 0.15)';
        state.mainCtx.fill();
      }
    },

    end() {
      state.lassoActive = false;
      if (state.lassoPoints.length < 3) {
        state.lassoPoints = [];
        composite();
        syncToolClearIndicators();
        return;
      }
      // 保持选区绘制 — 面板的操作按钮使用它。
      composite();
      drawLassoOverlay();
      syncToolClearIndicators();
    },
  };
}
