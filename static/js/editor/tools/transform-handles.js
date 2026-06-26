/**
 * 变换工具手柄渲染 + 命中测试 + 覆盖层同步。
 *
 * Lives separately from `transform-drag.js` (which owns the drag
 * STATE MACHINE) because these three helpers are pure geometry that
 * happens to read shared state — they don't track in-progress drags,
 * they just paint and hit-test.
 *
 *  - `syncOverlay(margin)`  根据主画布 + 缩放来定位覆盖层画布
 *                           并调整其位图大小。
 *  - `drawHandles(margin)`  绘制旋转后的边界轮廓 + 4 个
 *                           角点手柄 + 旋转旋钮（带
 *                           悬停/激活视觉状态）。
 *  - `getHandleAt(x, y)`    返回 (x, y) 处的手柄 ID，或
 *                           null。几何计算必须与 `drawHandles`
 *                           完全一致，否则用户会抓到幽灵点。
 *
 * 此处不附加任何事件监听器 — editor/tools/transform-drag.js
 * 中的分发器调用 `getHandleAt` 并路由
 * 指针事件。
 */
import { state } from '../state.js';

/**
 * 定位变换覆盖层画布并调整其后台位图大小。
 * margin 是图像空间中每侧的富余空间，以便手柄可以
 * 渲染在主画布之外（与 galleryEditor.js 中的
 * _TRANSFORM_OVERLAY_MARGIN 匹配 — 保留为参数，
 * 这样本模块就不依赖其他地方定义的魔法数字）。
 */
export function syncOverlay(margin) {
  if (!state.transformOverlay || !state.mainCanvas) return;
  if (!state.transformActive) {
    state.transformOverlay.style.display = 'none';
    return;
  }
  const W = state.mainCanvas.width + 2 * margin;
  const H = state.mainCanvas.height + 2 * margin;
  if (state.transformOverlay.width !== W) state.transformOverlay.width = W;
  if (state.transformOverlay.height !== H) state.transformOverlay.height = H;
  // 覆盖层必须随 state.zoom 缩放，使手柄在屏幕上
  // 以与主画布内容相同的尺寸渲染。否则，叠加层以完整
  // 位图大小渲染而主画布缩小（缩小视图时），
  // 手柄会显得巨大。
  state.transformOverlay.style.display = '';
  state.transformOverlay.style.position = 'absolute';
  state.transformOverlay.style.width  = (W * state.zoom) + 'px';
  state.transformOverlay.style.height = (H * state.zoom) + 'px';
  state.transformOverlay.style.pointerEvents = 'none';
  state.transformOverlay.style.zIndex = '5';
  // 将覆盖层定位在主画布的布局位置（offsetLeft/Top —
  // 不受 CSS 变换影响），向左上偏移覆盖层的
  // `margin` 图像像素作为手柄富余空间。然后共享
  // 画布的变换（平移处理器将相同的 translate3d 写入
  // 画布和覆盖层），这样平移会同时移动它们。读取
  // 布局偏移（而非包含平移变换的 getBoundingClientRect）
  // 避免了双平移"弹跳"。
  state.transformOverlay.style.left = Math.round(state.mainCanvas.offsetLeft - margin * state.zoom) + 'px';
  state.transformOverlay.style.top  = Math.round(state.mainCanvas.offsetTop  - margin * state.zoom) + 'px';
  state.transformOverlay.style.transform = state.mainCanvas.style.transform || 'none';
}


/**
 * Compute the on-screen position of the rotation knob given the
 * layer's bbox center + rotation. The knob normally sits OUTSIDE the
 * top edge of the rotated layer; if that would land beyond the canvas
 * viewport, flip it INSIDE.
 *
 * 由 `_knobPosition` 返回，drawHandles 和 getHandleAt
 * 共享使用，确保两者计算相同的点。
 */
function knobPosition(cxh, cyh, rotRad, baseInnerR, rotOffset) {
  let rotInside = false;
  const outsideR = baseInnerR + rotOffset;
  const knobLocalX = cxh + Math.sin(rotRad) * outsideR;
  const knobLocalY = cyh - Math.cos(rotRad) * outsideR;
  // 主检查：绘制在主画布像素缓冲区之外的任何内容都是
  // 不可见的（画布操作会静默裁剪）。
  if (
    knobLocalX < 0 || knobLocalY < 0 ||
    knobLocalX > state.mainCanvas.width || knobLocalY > state.mainCanvas.height
  ) {
    rotInside = true;
  }
  // 辅助检查：即使旋钮在画布位图内，
  // 视口可能已滚动画布，使得旋钮
  // 落在可见的画布区域窗口之外。
  try {
    const area = state.container && state.container.querySelector('.ge-canvas-area');
    if (area && !rotInside) {
      const aRect = area.getBoundingClientRect();
      const mRect = state.mainCanvas.getBoundingClientRect();
      const scaleX = mRect.width / state.mainCanvas.width;
      const scaleY = mRect.height / state.mainCanvas.height;
      const knobClientX = mRect.left + knobLocalX * scaleX;
      const knobClientY = mRect.top + knobLocalY * scaleY;
      if (knobClientY < aRect.top + 6) rotInside = true;
      if (knobClientX < aRect.left + 6 || knobClientX > aRect.right - 6) rotInside = true;
    }
  } catch {}
  const innerR = rotInside ? Math.max(4, baseInnerR - rotOffset) : baseInnerR;
  const rotR = rotInside ? innerR : baseInnerR + rotOffset;
  return {
    rotInside,
    innerR,
    rotX: cxh + Math.sin(rotRad) * rotR,
    rotY: cyh - Math.cos(rotRad) * rotR,
  };
}


/**
 * 将旋转后的边界轮廓 + 4 个角点手柄 + 旋转旋钮
 * 绘制到叠加层画布上。覆盖层按 `margin` 平移，
 * 使图像 (0,0) 映射到叠加层的 (margin, margin)。
 */
export function drawHandles(margin) {
  if (!state.transformActive || !state.transformLayer) return;
  syncOverlay(margin);
  if (!state.transformOverlayCtx) return;
  const layer = state.transformLayer;
  const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
  const w = layer.canvas.width;
  const h = layer.canvas.height;
  const ctx = state.transformOverlayCtx;
  // 清除 + 按 margin 偏移绘制，使图像 (0,0) 映射到覆盖层 (M,M)。
  ctx.clearRect(0, 0, state.transformOverlay.width, state.transformOverlay.height);
  ctx.save();
  ctx.translate(margin, margin);
  // 缩放修正后的手柄尺寸 + 描边，使它们在任何缩放级别下都保持可读。
  const sz = 10 / state.zoom;
  const stroke = 1.5 / state.zoom;

  // 旋转前的矩形尺寸（用户看到的图层外观）。
  // 在弹窗值存在之前回退到图层边界框。
  const preW = state.transformPendingW || w;
  const preH = state.transformPendingH || h;
  const cxBox = off.x + w / 2;
  const cyBox = off.y + h / 2;
  const rotRadBox = ((state.transformPendingRot || 0) * Math.PI) / 180;
  const cosBox = Math.cos(rotRadBox);
  const sinBox = Math.sin(rotRadBox);
  const rotPt = (dx, dy) => ({
    x: cxBox + dx * cosBox - dy * sinBox,
    y: cyBox + dx * sinBox + dy * cosBox,
  });
  const tl = rotPt(-preW / 2, -preH / 2);
  const tr = rotPt( preW / 2, -preH / 2);
  const br = rotPt( preW / 2,  preH / 2);
  const bl = rotPt(-preW / 2,  preH / 2);

  // 旋转矩形的轮廓 — 实心白色内线 + 细黑色光晕，
  // 在浅色和深色背景上都保持对比度。
  const drawRectOutline = () => {
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.stroke();
  };
  ctx.lineWidth = 1 / state.zoom;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
  ctx.lineDashOffset = 1 / state.zoom;
  drawRectOutline();
  ctx.strokeStyle = '#fff';
  ctx.lineDashOffset = 0;
  drawRectOutline();
  ctx.setLineDash([]);

  // 角点手柄 + 旋转旋钮锚定在旋转图层的顶部中心
  // （不是边界框顶部），这样旋钮在旋转时始终
  // 附着在可见内容上。
  const rotOffset = 24 / state.zoom;
  const cxh = off.x + w / 2;
  const cyh = off.y + h / 2;
  const rotRad = ((state.transformPendingRot || 0) * Math.PI) / 180;
  const baseInnerR = (state.transformPendingH || h) / 2;
  const knob = knobPosition(cxh, cyh, rotRad, baseInnerR, rotOffset);
  // 当旋钮在图层内部时，连杆线缩为一个点。
  const drawTether = !knob.rotInside;
  const innerX = cxh + Math.sin(rotRad) * baseInnerR;
  const innerY = cyh - Math.cos(rotRad) * baseInnerR;
  const corners = [
    { x: tl.x, y: tl.y, id: 'tl' },
    { x: tr.x, y: tr.y, id: 'tr' },
    { x: br.x, y: br.y, id: 'br' },
    { x: bl.x, y: bl.y, id: 'bl' },
    { x: knob.rotX, y: knob.rotY, id: 'rot' },
  ];
  if (drawTether) {
    ctx.beginPath();
    ctx.moveTo(innerX, innerY);
    ctx.lineTo(knob.rotX, knob.rotY);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1 / state.zoom;
    ctx.stroke();
  }
  for (const c of corners) {
    const active = c.id === state.transformHandle;
    const hovered = !active && c.id === state.hoveredHandle;
    const radius = (active ? sz * 0.75 : hovered ? sz * 0.6 : sz / 2);
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#e06c75' : hovered ? '#ffd' : '#fff';
    ctx.fill();
    ctx.lineWidth = stroke;
    ctx.strokeStyle = active ? '#fff' : 'rgba(0, 0, 0, 0.5)';
    ctx.stroke();
    if (hovered) {
      // 悬停手柄周围细微的红色圆环，提供视觉反馈。
      ctx.beginPath();
      ctx.arc(c.x, c.y, radius + 2 / state.zoom, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(224, 108, 117, 0.7)';
      ctx.lineWidth = stroke;
      ctx.stroke();
    }
  }
  ctx.restore();
}


/**
 * 对变换手柄进行命中测试 (x, y)。返回手柄
 * ID（'tl' | 'tr' | 'br' | 'bl' | 'rot'）或 null。
 *
 * 几何计算必须与 `drawHandles` 完全一致，
 * 否则用户会抓到幽灵点。
 */
export function getHandleAt(x, y) {
  if (!state.transformLayer) return null;
  const layer = state.transformLayer;
  const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
  const w = layer.canvas.width;
  const h = layer.canvas.height;
  const threshold = 8 / state.zoom;
  const rotOffset = 24 / state.zoom;
  const cxh = off.x + w / 2;
  const cyh = off.y + h / 2;
  const rotRad = ((state.transformPendingRot || 0) * Math.PI) / 180;
  const baseInnerR = (state.transformPendingH || h) / 2;
  const knob = knobPosition(cxh, cyh, rotRad, baseInnerR, rotOffset);

  // 围绕中心旋转角点 — 必须与 draw处理 匹配。
  const preW = state.transformPendingW || w;
  const preH = state.transformPendingH || h;
  const cosA = Math.cos(rotRad);
  const sinA = Math.sin(rotRad);
  const rotCorner = (dx, dy) => ({
    x: cxh + dx * cosA - dy * sinA,
    y: cyh + dx * sinA + dy * cosA,
  });
  const tlH = rotCorner(-preW / 2, -preH / 2);
  const trH = rotCorner( preW / 2, -preH / 2);
  const brH = rotCorner( preW / 2,  preH / 2);
  const blH = rotCorner(-preW / 2,  preH / 2);
  const handles = [
    { x: tlH.x,    y: tlH.y,    id: 'tl' },
    { x: trH.x,    y: trH.y,    id: 'tr' },
    { x: brH.x,    y: brH.y,    id: 'br' },
    { x: blH.x,    y: blH.y,    id: 'bl' },
    { x: knob.rotX, y: knob.rotY, id: 'rot' },
  ];
  for (const c of handles) {
    if (Math.abs(x - c.x) < threshold && Math.abs(y - c.y) < threshold) return c.id;
  }
  return null;
}
