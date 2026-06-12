/**
 * AI Harmonize 管道使用的遮罩构建器。
 *
 *  - `layerUnionAlpha` — 所有非底图图层的 alpha 并集，生成二分（0/255）遮罩。
 *                         用作间隙遮罩和本体遮罩的基底。
 *  - `seamMask`         — 沿所有非底图图层 alpha 边缘的羽化带。
 *                         白色 = "在此处融合"，黑色 = "保持不变"。
 *                         以 base64 PNG 格式返回（以便作为 JSON POST 到扩散端点）。
 *  - `layerBodyMask`    — 所有非底图图层的完整羽化形状。
 *                         白色 = "AI 可使用现有像素作为起点重绘此像素"；
 *                         黑色 = "精确保留"。以 base64 格式返回。
 *
 * 每个辅助函数接收可见图层列表 + 文档尺寸；无模块状态。
 *
 * @typedef {{ visible: boolean, id: string, canvas: HTMLCanvasElement, offset: {x: number, y: number} }} HarmLayer
 */

/**
 * 构建二进制 alpha 遮罩 = 所有非底图可见图层像素的并集。
 * 当可见图层少于 2 个或非底图层完全透明时返回 null。
 *
 * @param {number} w / h          画布尺寸（像素）。
 * @param {HarmLayer[]} layers    按堆叠顺序排列的所有图层；
 *                                第一个可见图层作为底图/背景。
 * @returns {HTMLCanvasElement|null}
 */
export function layerUnionAlpha(w, h, layers) {
  const visible = layers.filter(l => l.visible);
  if (visible.length < 2) return null;
  const bgId = visible[0].id;
  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = w; alphaCanvas.height = h;
  const actx = alphaCanvas.getContext('2d');
  let hasFg = false;
  for (const layer of visible) {
    if (layer.id === bgId) continue;
    const off = layer.offset || { x: 0, y: 0 };
    actx.drawImage(layer.canvas, off.x, off.y);
    hasFg = true;
  }
  if (!hasFg) return null;
  const src = actx.getImageData(0, 0, w, h);
  const bin = document.createElement('canvas');
  bin.width = w; bin.height = h;
  const bctx = bin.getContext('2d');
  const binImg = bctx.createImageData(w, h);
  let any = false;
  for (let i = 0; i < src.data.length; i += 4) {
    const v = src.data[i + 3] > 0 ? 255 : 0;
    if (v) any = true;
    binImg.data[i] = binImg.data[i + 1] = binImg.data[i + 2] = v;
    binImg.data[i + 3] = 255;
  }
  if (!any) return null;
  bctx.putImageData(binImg, 0, 0);
  return bin;
}


/**
 * 沿所有非底图可见图层的 alpha 边缘构建羽化间隙遮罩。
 * 返回 base64 编码的 PNG（无 `data:` 前缀），如果没有需要协调的内容则返回 null。
 */
export function seamMask(w, h, layers, featherPx = 12) {
  const bin = layerUnionAlpha(w, h, layers);
  if (!bin) return null;
  const blur = document.createElement('canvas');
  blur.width = w; blur.height = h;
  const blctx = blur.getContext('2d');
  blctx.filter = `blur(${featherPx}px)`;
  blctx.drawImage(bin, 0, 0);
  blctx.filter = 'none';
  const blurred = blctx.getImageData(0, 0, w, h);
  const mask = blctx.createImageData(w, h);
  // 三角形权重峰值在中间灰 — 提取 alpha 边缘带。
  for (let i = 0; i < blurred.data.length; i += 4) {
    const v = blurred.data[i];
    const dist = Math.abs(v - 128);
    const wt = Math.max(0, 255 - dist * 2);
    mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = wt;
    mask.data[i + 3] = 255;
  }
  blctx.putImageData(mask, 0, 0);
  const soft = document.createElement('canvas');
  soft.width = w; soft.height = h;
  const sctx = soft.getContext('2d');
  sctx.filter = `blur(${Math.max(2, Math.floor(featherPx / 4))}px)`;
  sctx.drawImage(blur, 0, 0);
  sctx.filter = 'none';
  return soft.toDataURL('image/png').split(',')[1];
}


/**
 * 构建所有非底图可见图层的羽化完整形状遮罩。
 * 返回 base64 编码的 PNG，如果没有非底图层则返回 null。
 */
export function layerBodyMask(w, h, layers, featherPx = 12) {
  const bin = layerUnionAlpha(w, h, layers);
  if (!bin) return null;
  const soft = document.createElement('canvas');
  soft.width = w; soft.height = h;
  const sctx = soft.getContext('2d');
  sctx.filter = `blur(${featherPx}px)`;
  sctx.drawImage(bin, 0, 0);
  sctx.filter = 'none';
  return soft.toDataURL('image/png').split(',')[1];
}
