/**
 * 纯合成辅助函数 — 将图层列表展平为单个画布，
 * 用于缩略图 / 合并蒙版。
 *
 * Both helpers are stateless: the caller passes everything they need
 * (layer list, canvas dimensions, an offsets lookup). The legacy
 * gallery editor's module-level functions wrap these with their own
 * state.
 */

/**
 * 从所有可见图层合成的低成本缩小预览。
 * 返回 JPEG dataURL，当没有内容可绘制时返回 null。
 *
 * @param {Array<{visible: boolean, opacity: number, id: string, canvas: HTMLCanvasElement}>} layers
 * @param {number} imgW            文档宽度，单位为画布像素。
 * @param {number} imgH            文档高度，单位为画布像素。
 * @param {Map<string,{x:number,y:number}>} offsets  图层偏移，按 id 索引。
 * @param {number} maxDim          最长边目标尺寸，单位为 CSS 像素。
 * @param {number} quality         JPEG 质量 0..1。
 * @returns {string|null}
 */
export function buildThumbnail(layers, imgW, imgH, offsets, maxDim, quality = 0.6) {
  if (!imgW || !imgH) return null;
  try {
    const scale = Math.min(1, maxDim / Math.max(imgW, imgH));
    const tw = Math.max(1, Math.round(imgW * scale));
    const th = Math.max(1, Math.round(imgH * scale));
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    const ctx = c.getContext('2d');
    for (const layer of layers) {
      if (!layer.visible) continue;
      ctx.globalAlpha = layer.opacity;
      const off = offsets.get(layer.id) || { x: 0, y: 0 };
      ctx.drawImage(
        layer.canvas,
        off.x * scale, off.y * scale,
        layer.canvas.width * scale, layer.canvas.height * scale,
      );
    }
    ctx.globalAlpha = 1;
    return c.toDataURL('image/jpeg', quality);
  } catch (_) {
    return null;
  }
}


/**
 * 所有可见蒙版子图层在整个 `layers` 中的并集，
 * 渲染为与文档尺寸相同的二值白色画布。
 *
 * `lighter` 合成模式 = 叠加 — 重叠像素保持在
 * 255 上限，因此任何蒙版绘制过的地方，结果都是纯白色。
 * 当没有蒙版图层贡献任何像素时返回 null（以便调用者可以
 * 干净地提前退出）。
 *
 * @param {Array<{masks?: Array<{visible: boolean, canvas: HTMLCanvasElement}>}>} layers
 * @param {number} imgW
 * @param {number} imgH
 * @returns {HTMLCanvasElement|null}
 */
export function buildMergedMaskCanvas(layers, imgW, imgH) {
  if (!imgW || !imgH) return null;
  const out = document.createElement('canvas');
  out.width = imgW;
  out.height = imgH;
  const ctx = out.getContext('2d');
  ctx.globalCompositeOperation = 'lighter';
  let anyMask = false;
  for (const ly of layers) {
    if (!ly.masks || !ly.masks.length) continue;
    for (const mk of ly.masks) {
      if (!mk.visible) continue;
      if (!mk.canvas || !mk.canvas.width || !mk.canvas.height) continue;
      ctx.drawImage(mk.canvas, 0, 0);
      anyMask = true;
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  return anyMask ? out : null;
}
