/**
 * 笔画管道 — 将一个笔画段（上一位置 → 当前位置）
 * 绘制到活动图层（或其活动遮罩子图层）上。
 *
 * `strokeTo` 按工具分发：
 *   - clone  → cloneStrokeTo（基于印章的自定义绘制循环）
 *   - brush  → 带不透明度 × 流量 + 柔和度模糊的 source-over
 *   - eraser → 带不透明度 × 流量 + 柔和度模糊的 destination-out
 *   - inpaint → 遮罩画布上使用完整 alpha 的 source-over（绘制）或
 *               destination-out（擦除）
 *
 * 如果活动父图层有活动遮罩子图层，则 brush / eraser / inpaint
 * 绘制到遮罩画布而非图层的像素画布。
 *
 * @param {{
 *   activeLayer:          () => object | null,
 *   getActiveMaskLayer:   () => object | null,
 *   composite:            () => void,
 * }} deps
 */
import { state } from './state.js';

export function createStrokePipeline({ activeLayer, getActiveMaskLayer, composite }) {
  function cloneStrokeTo(x, y, layer) {
    if (!state.cloneSourceSnapshot) return;
    const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
    const dx = x - state.cloneStrokeStartX;
    const dy = y - state.cloneStrokeStartY;
    const srcX = state.cloneSourceX + dx;
    const srcY = state.cloneSourceY + dy;
    const ctx = layer.ctx;
    const radius = Math.max(1, state.brushSize / 2);
    // 以大约半个画笔大小的步长遍历上一位置 → 当前位置，
    // 使印章重叠形成连续的笔画轨迹。
    const lastSrcX = state.cloneSourceX + (state.lastX - state.cloneStrokeStartX);
    const lastSrcY = state.cloneSourceY + (state.lastY - state.cloneStrokeStartY);
    const dist = Math.hypot(x - state.lastX, y - state.lastY);
    const step = Math.max(1, radius * 0.5);
    const steps = Math.max(1, Math.ceil(dist / step));
    const stampSize = Math.max(2, Math.ceil(radius * 2));
    const stampRadius = stampSize / 2;
    const stamp = document.createElement('canvas');
    stamp.width = stampSize;
    stamp.height = stampSize;
    const stampCtx = stamp.getContext('2d');
    const softness = Math.max(0, Math.min(1, state.cloneSoftness / 300));
    const hardStop = stampRadius * (1 - softness);
    ctx.save();
    ctx.globalAlpha = (state.cloneOpacity / 100) * (state.cloneFlow / 100);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = state.lastX + (x - state.lastX) * t - off.x;
      const py = state.lastY + (y - state.lastY) * t - off.y;
      const sx = lastSrcX + (srcX - lastSrcX) * t;
      const sy = lastSrcY + (srcY - lastSrcY) * t;
      stampCtx.clearRect(0, 0, stampSize, stampSize);
      stampCtx.globalCompositeOperation = 'source-over';
      stampCtx.drawImage(
        state.cloneSourceSnapshot,
        sx - stampRadius, sy - stampRadius, stampSize, stampSize,
        0, 0, stampSize, stampSize,
      );
      stampCtx.globalCompositeOperation = 'destination-in';
      const mask = stampCtx.createRadialGradient(stampRadius, stampRadius, hardStop, stampRadius, stampRadius, stampRadius);
      mask.addColorStop(0, 'rgba(0,0,0,1)');
      mask.addColorStop(1, 'rgba(0,0,0,0)');
      stampCtx.fillStyle = mask;
      stampCtx.fillRect(0, 0, stampSize, stampSize);
      ctx.drawImage(stamp, px - stampRadius, py - stampRadius);
    }
    ctx.restore();
    state.lastX = x;
    state.lastY = y;
    composite();
  }

  function strokeTo(x, y) {
    const layer = activeLayer();
    if (!layer) return;
    // Clone uses a stamp-based paint loop, not the line-stroke
    // pipeline below.
    if (state.tool === 'clone') return cloneStrokeTo(x, y, layer);

    // If the active parent has an active mask sub-layer, brush /
    // eraser / inpaint paint the mask canvas instead of the layer's
    // pixel canvas. Brush adds to the mask, Eraser carves it away,
    // Inpaint still works (its mask plumbing was already pointed at
    // the same canvas).
    const activeMask = getActiveMaskLayer();
    const paintingMask = !!activeMask &&
      (state.tool === 'brush' || state.tool === 'eraser' || state.tool === 'inpaint');
    const ctx = paintingMask
      ? activeMask.ctx
      : (state.tool === 'inpaint' ? state.maskCtx : layer.ctx);
    const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };

    ctx.save();
    ctx.lineWidth = state.brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (state.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      // 有效 alpha = 不透明度 × 流量。不透明度 = 笔画能达到的最大强度；
      // 流量 = 每次擦除多少。
      ctx.globalAlpha = (state.eraserOpacity / 100) * (state.eraserFlow / 100);
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      if (state.eraserSoftness > 0) {
        const blurPx = (state.eraserSoftness / 100) * (state.brushSize / 2);
        ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
      }
    } else if (state.tool === 'brush') {
      // Brush — state.color onto the layer (or white onto an active
      // mask sub-layer). Mask painting forces full alpha so masks
      // stay a clean binary by default (a sub-100% brush would
      // silently paint partial-strength mask pixels).
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = paintingMask ? 'rgba(255,255,255,1)' : state.color;
      if (paintingMask) {
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = (state.brushOpacity / 100) * (state.brushFlow / 100);
        if (state.brushSoftness > 0) {
          const blurPx = (state.brushSoftness / 100) * (state.brushSize / 2);
          ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
        }
      }
    } else if (state.tool === 'inpaint') {
      if (state.inpaintEraseStroke) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        // 扩散服务器期望白色 = 修复区域。红色叠加在 composite() 中
        // 为用户单独渲染。
        ctx.strokeStyle = 'rgba(255,255,255,1)';
      }
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = state.color;
    }

    // Mask canvases are always full-image (no per-layer offset), so
    // painting onto a mask uses canvas-coord origin too — same as
    // 也使用画布坐标原点 — 与 inpaint 相同。
    const onMaskOrInpaint = paintingMask || state.tool === 'inpaint';
    const drawX = onMaskOrInpaint ? 0 : off.x;
    const drawY = onMaskOrInpaint ? 0 : off.y;

    ctx.beginPath();
    ctx.moveTo(state.lastX - drawX, state.lastY - drawY);
    ctx.lineTo(x - drawX, y - drawY);
    ctx.stroke();
    ctx.restore();

    state.lastX = x;
    state.lastY = y;
    composite();
  }

  return { strokeTo, cloneStrokeTo };
}
