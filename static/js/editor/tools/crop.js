/**
 * 裁剪工具 — 拖拽矩形选区，让用户将画布裁切为
 * 更小的区域。支持 Shift 锁定宽高比和点击矩形内部
 * 重新定位已有裁剪框而不重绘。
 *
 * 拥有自己的 begin/drag/end 处理器，读写共享状态。
 * 工厂函数接受一个小的依赖包，用于仍在
 * galleryEditor.js 中的功能 — `composite` 重绘画布，
 * `showCropApply` 在用户完成拖拽后挂载浮动的
 * W×H + 应用面板。
 *
 * @param {{
 *   composite: () => void,
 *   showCropApply: () => void,
 * }} deps
 */
import { state } from '../state.js';
import { canvasCoords } from '../canvas-coords.js';
import { drawCheckerboard } from '../checkerboard.js';

export function createCropTool({ composite, showCropApply }) {
  return {
    begin(e) {
      const coords = canvasCoords(e, state.mainCanvas);
      // 点击已有裁剪矩形内部 → 切换到移动模式，
      // 让用户可以重新定位而无需重绘。
      if (state.cropRect &&
          coords.x >= state.cropRect.x && coords.x <= state.cropRect.x + state.cropRect.w &&
          coords.y >= state.cropRect.y && coords.y <= state.cropRect.y + state.cropRect.h) {
        state.cropMoving = true;
        state.cropMoveStart = { x: coords.x, y: coords.y, rx: state.cropRect.x, ry: state.cropRect.y };
        return;
      }
      state.cropping = true;
      state.cropStart = coords;
      state.cropEnd = { ...state.cropStart };
      state.cropRect = null;
      state.cropAspectLock = null;
      // 用户绘制新矩形时移除尺寸面板。
      const old = state.container?.querySelector('.ge-crop-apply');
      if (old) old.remove();
    },

    drag(e) {
      // 移动模式：在画布上拖拽已有矩形。
      if (state.cropMoving && state.cropRect && state.cropMoveStart) {
        e.preventDefault();
        const c = canvasCoords(e, state.mainCanvas);
        const dx = c.x - state.cropMoveStart.x;
        const dy = c.y - state.cropMoveStart.y;
        let nx = state.cropMoveStart.rx + dx;
        let ny = state.cropMoveStart.ry + dy;
        // 限制在画布边界内，矩形保持完全可见。
        nx = Math.max(0, Math.min(nx, state.mainCanvas.width - state.cropRect.w));
        ny = Math.max(0, Math.min(ny, state.mainCanvas.height - state.cropRect.h));
        state.cropRect = { ...state.cropRect, x: nx, y: ny };
        composite();
        return;
      }
      if (!state.cropping) return;
      e.preventDefault();
      state.cropEnd = canvasCoords(e, state.mainCanvas);
      // Shift 按住 = 锁定宽高比。拖拽过程中第一次按下 Shift
      // 会快照当前比例；后续移动保持锁定。
      // 释放 Shift 重置，用户可以重新锁定新比例。
      if (e.shiftKey) {
        const rawDx = state.cropEnd.x - state.cropStart.x;
        const rawDy = state.cropEnd.y - state.cropStart.y;
        if (state.cropAspectLock == null) {
          const rawW = Math.abs(rawDx) || 1;
          const rawH = Math.abs(rawDy) || 1;
          state.cropAspectLock = rawW / rawH;
        }
        const absDx = Math.abs(rawDx);
        const absDy = Math.abs(rawDy);
        // 用户移动更多的轴（相对于锁定比例）为主导轴；
        // 缩放另一轴以保持比例。
        let dx, dy;
        if (absDx >= absDy * state.cropAspectLock) {
          dx = rawDx;
          dy = Math.sign(rawDy || 1) * (absDx / state.cropAspectLock);
        } else {
          dy = rawDy;
          dx = Math.sign(rawDx || 1) * (absDy * state.cropAspectLock);
        }
        state.cropEnd = { x: state.cropStart.x + dx, y: state.cropStart.y + dy };
      } else {
        state.cropAspectLock = null;
      }
      composite();
      // 绘制裁剪覆盖层。
      const x = Math.min(state.cropStart.x, state.cropEnd.x);
      const y = Math.min(state.cropStart.y, state.cropEnd.y);
      const w = Math.abs(state.cropEnd.x - state.cropStart.x);
      const h = Math.abs(state.cropEnd.y - state.cropStart.y);
      state.mainCtx.fillStyle = 'rgba(0,0,0,0.4)';
      state.mainCtx.fillRect(0, 0, state.mainCanvas.width, state.mainCanvas.height);
      state.mainCtx.clearRect(x, y, w, h);
      // 重绘裁剪矩形内的图层（外部全部变暗）。
      state.mainCtx.save();
      state.mainCtx.beginPath();
      state.mainCtx.rect(x, y, w, h);
      state.mainCtx.clip();
      drawCheckerboard(state.mainCtx, state.mainCanvas.width, state.mainCanvas.height);
      for (const layer of state.layers) {
        if (!layer.visible) continue;
        state.mainCtx.globalAlpha = layer.opacity;
        const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
        state.mainCtx.drawImage(layer.canvas, off.x, off.y);
      }
      state.mainCtx.globalAlpha = 1;
      state.mainCtx.restore();
      // 保留区域周围的虚线边框。
      state.mainCtx.strokeStyle = '#fff';
      state.mainCtx.lineWidth = 1;
      state.mainCtx.setLineDash([4, 4]);
      state.mainCtx.strokeRect(x, y, w, h);
      state.mainCtx.setLineDash([]);
      state.cropRect = { x, y, w, h };
    },

    end() {
      // 移动模式收尾：刷新浮动面板，使"应用"按钮
      // 跟随矩形到新位置。
      if (state.cropMoving) {
        state.cropMoving = false;
        state.cropMoveStart = null;
        if (state.cropRect) showCropApply();
        return;
      }
      state.cropping = false;
      if (state.cropRect && state.cropRect.w > 5 && state.cropRect.h > 5) {
        showCropApply();
      }
    },
  };
}
