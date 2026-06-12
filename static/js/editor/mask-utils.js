/**
 * 修复管道使用的遮罩画布辅助函数。
 *
 * 纯工具函数 — 接收画布（或图层形状）作为输入，返回新画布，
 * 无模块级状态。
 */

/**
 * 膨胀（正 `px`）或腐蚀（负 `px`）一个二进制 alpha 遮罩。
 *
 * 策略：以 `|px|` 模糊源图像，然后重新阈值化结果。
 * - 膨胀保留模糊 alpha 非零的任何内容（低截止值）。
 * - 腐蚀仅保留模糊后 alpha 仍然接近 255 的像素。
 *
 * @param {HTMLCanvasElement} src   源遮罩画布。
 * @param {number}            px    膨胀（>0）或腐蚀（<0）的像素数。0 = 复制。
 * @returns {HTMLCanvasElement}     具有相同尺寸的新画布。
 */
export function dilateMask(src, px) {
  const w = src.width, h = src.height;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const ctx = tmp.getContext('2d');
  if (px === 0) {
    ctx.drawImage(src, 0, 0);
    return tmp;
  }
  const dilate = px > 0;
  const radius = Math.abs(px);
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
  const img = ctx.getImageData(0, 0, w, h);
  const threshold = dilate ? 8 : 247;
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3];
    const keep = dilate ? a > threshold : a >= threshold;
    if (keep) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    } else {
      img.data[i + 3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return tmp;
}


/**
 * 从缓存的 AI 图像和硬遮罩重新推导修复结果图层的 alpha，
 * 应用羽化和可选的膨胀/腐蚀边界。通过 `layer.ctx` 就地修改
 * `layer.canvas`。
 *
 * 图层必须携带来自原始修复调用的 `inpaintSource = { ai, mask }` 缓存，
 * 以便能够低成本地重新塑造 alpha（无需第二次模型调用）。
 *
 * @param {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
 *          inpaintSource?: {ai: CanvasImageSource, mask: HTMLCanvasElement}}} layer
 * @param {number} featherPx     应用于遮罩 alpha 的高斯模糊半径。
 * @param {number} [edgeShiftPx] 模糊前膨胀（+）或腐蚀（-）遮罩。
 */
export function applyInpaintFeather(layer, featherPx, edgeShiftPx = 0) {
  if (!layer || !layer.inpaintSource) return;
  const { ai, mask } = layer.inpaintSource;
  const w = layer.canvas.width;
  const h = layer.canvas.height;
  // 1) 可选的膨胀/腐蚀，然后可选模糊，生成新遮罩。
  let shaped = mask;
  if (edgeShiftPx !== 0) shaped = dilateMask(mask, edgeShiftPx);
  const softMask = document.createElement('canvas');
  softMask.width = w; softMask.height = h;
  const smCtx = softMask.getContext('2d');
  if (featherPx > 0) {
    smCtx.filter = `blur(${featherPx}px)`;
    smCtx.drawImage(shaped, 0, 0, w, h);
    smCtx.filter = 'none';
  } else {
    smCtx.drawImage(shaped, 0, 0, w, h);
  }
  // 2) 重新绘制 AI 图像，然后将 alpha 乘以软遮罩。
  const ctx = layer.ctx;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(ai, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(softMask, 0, 0);
  ctx.restore();
}
