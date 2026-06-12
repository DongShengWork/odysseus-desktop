/**
 * 变换拖拽工具 — 处理变换工具（通过角点/边缘手柄调整大小，
 * 通过旋转把手旋转）的拖拽交互。
 *
 * 变换 UI 以两种模式运行：浮动弹窗（W/H/旋转数值输入，位于其他位置）
 * 和在画布手柄上的直接拖拽。两者最终都会修改
 * `state.transformPendingW/H/Rot` 并调用 `reapplyTransform()`
 * 来重绘。本模块负责拖拽分支。
 *
 * galleryEditor.js 中的分发器调用 `tryBegin/tryContinue/
 * tryEnd`，当事件属于变换工具并已被处理时返回 `true`
 * （这样分发器就可以短路）。
 *
 * @param {{
 *   beginMove:             (e: Event) => void,
 *   composite:              () => void,
 *   drawTransformHandles:   () => void,
 *   reapplyTransform:       () => void,
 *   getTransformHandle:     (x: number, y: number) => string | null,
 *   cursorForHandle:        (id: string | null) => string,
 * }} deps
 */
import { state } from '../state.js';
import { canvasCoords } from '../canvas-coords.js';

export function createTransformDragTool({
  beginMove, composite, drawTransformHandles, reapplyTransform,
  getTransformHandle, cursorForHandle,
}) {
  return {
    /**
     * 在 pointerdown 时调用。如果变换工具处理了事件
     * （分发器不应该继续传递给其他工具），则返回 true。
     */
    tryBegin(e) {
      if (!state.transformActive) return false;
      const coords = canvasCoords(e, state.mainCanvas);
      state.transformHandle = getTransformHandle(coords.x, coords.y);
      if (state.transformHandle) {
        state.transformStartX = coords.x;
        state.transformStartY = coords.y;
        // 在拖拽开始时快照偏移量和尺寸，这样每帧计算
        // "起始 + dx"（正确的增量），而不是在运行中的偏移量上累加，
        // 之前这样做会导致上/左抓取发生漂移。
        const layer = state.transformLayer;
        const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
        state.transformStartOffX = off.x;
        state.transformStartOffY = off.y;
        state.transformOrigW = layer.canvas.width;
        state.transformOrigH = layer.canvas.height;
        return true;
      }
      // 没有命中角点 — 如果点击在图层边界框内，则
      // 像移动工具一样操作，这样用户无需切换工具
      // 就可以拖拽图层。
      if (state.transformLayer) {
        const off = state.layerOffsets.get(state.transformLayer.id) || { x: 0, y: 0 };
        const w = state.transformLayer.canvas.width;
        const h = state.transformLayer.canvas.height;
        if (coords.x >= off.x && coords.x <= off.x + w &&
            coords.y >= off.y && coords.y <= off.y + h) {
          beginMove(e);
          return true;
        }
      }
      return false;
    },

    /**
     * 在 pointermove 时调用。如果已处理则返回 true。
     *
     * 当 transformActive 但未抓取手柄时，更新悬停
     * 光标。当抓取了手柄时，驱动调整大小/旋转管线。
     */
    tryContinue(e) {
      if (!state.transformActive) return false;
      // 没有正在进行的拖拽 — 仅更新悬停光标。
      if (!state.transformHandle && state.mainCanvas) {
        const coords = canvasCoords(e, state.mainCanvas);
        const hovered = getTransformHandle(coords.x, coords.y);
        state.mainCanvas.style.cursor = hovered ? cursorForHandle(hovered) : 'default';
        if (hovered !== state.hoveredHandle) {
          state.hoveredHandle = hovered;
          composite();
        }
        return false; // 没有完全消费事件
      }
      if (!state.transformHandle) return false;
      e.preventDefault();
      const coords = canvasCoords(e, state.mainCanvas);
      // 旋转把手 — 角度从图层的几何中心到光标测量。
      // 如果弹窗已打开则同步到弹窗中。
      if (state.transformHandle === 'rot') {
        const layer = state.transformLayer;
        const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
        const cx = off.x + layer.canvas.width / 2;
        const cy = off.y + layer.canvas.height / 2;
        const rad = Math.atan2(coords.y - cy, coords.x - cx) + Math.PI / 2;
        let deg = Math.round((rad * 180) / Math.PI);
        if (e.shiftKey) deg = Math.round(deg / 15) * 15; // 15° 吸附
        while (deg > 180) deg -= 360;
        while (deg <= -180) deg += 360;
        state.transformPendingRot = deg;
        reapplyTransform();
        if (state.transformPopup) {
          const rotIn = state.transformPopup.querySelector('#ge-transform-rot');
          if (rotIn) rotIn.value = String(deg);
        }
        return true;
      }
      // 通过角点/边缘手柄调整大小。
      const dx = coords.x - state.transformStartX;
      const dy = coords.y - state.transformStartY;
      const layer = state.transformLayer;
      let newW = layer.canvas.width;
      let newH = layer.canvas.height;
      if (state.transformHandle.includes('r')) newW = state.transformOrigW + dx;
      if (state.transformHandle.includes('l')) newW = state.transformOrigW - dx;
      if (state.transformHandle.includes('b')) newH = state.transformOrigH + dy;
      if (state.transformHandle.includes('t')) newH = state.transformOrigH - dy;
      // Shift = 锁定宽高比。使用移动较多的轴
      // （相对于原始值）作为主导轴。
      if (e.shiftKey && state.transformOrigW > 0 && state.transformOrigH > 0) {
        const aspect = state.transformOrigW / state.transformOrigH;
        const wDelta = Math.abs(newW - state.transformOrigW);
        const hDelta = Math.abs(newH - state.transformOrigH);
        if (wDelta >= hDelta) {
          newH = Math.max(1, Math.round(newW / aspect));
        } else {
          newW = Math.max(1, Math.round(newH * aspect));
        }
      }
      newW = Math.max(1, Math.round(newW));
      newH = Math.max(1, Math.round(newH));
      // 通过弹窗驱动的管线传递，使弹窗和拖拽保持同步。
      // 通过 transformOrigOffset 锚定对角，这样
      // 手柄就不会在用户拖拽时滑动。
      state.transformPendingW = newW;
      state.transformPendingH = newH;
      const anchorOffX = state.transformStartOffX +
        (state.transformHandle.includes('l') ? (state.transformOrigW - newW) : 0);
      const anchorOffY = state.transformStartOffY +
        (state.transformHandle.includes('t') ? (state.transformOrigH - newH) : 0);
      state.transformOrigOffset = {
        x: anchorOffX + newW / 2 - state.transformOrigW / 2,
        y: anchorOffY + newH / 2 - state.transformOrigH / 2,
      };
      reapplyTransform();
      // 如果弹窗已打开，将新的 W/H 同步到弹窗中。
      if (state.transformPopup) {
        const wIn = state.transformPopup.querySelector('#ge-transform-w');
        const hIn = state.transformPopup.querySelector('#ge-transform-h');
        if (wIn) wIn.value = String(state.transformPendingFlipH ? -newW : newW);
        if (hIn) hIn.value = String(state.transformPendingFlipV ? -newH : newH);
      }
      return true;
    },

    /**
     * 在 pointerup 时调用。如果已处理则返回 true。
     */
    tryEnd() {
      if (!(state.transformActive && state.transformHandle)) return false;
      state.transformHandle = null;
      state.transformOrigW = state.transformLayer?.canvas.width || 0;
      state.transformOrigH = state.transformLayer?.canvas.height || 0;
      composite();
      drawTransformHandles();
      return true;
    },
  };
}
