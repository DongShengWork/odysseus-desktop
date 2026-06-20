/**
 * 将亮度/对比度、色相/饱和度、色阶或色彩平衡
 * 调整应用到源画布，并返回包含结果的
 * 新画布。纯像素数学 — 无 DOM，无模块状态。
 *
 * 由编辑器的每层特效堆栈使用：每个 `adjLayer` 调用
 * `applyAdjustment(prevCanvas, adjLayer)`，结果输入
 * 堆栈中的下一层。
 *
 * 调整结构：
 *   { type: 'brightness-contrast', params: { brightness, contrast } }
 *   { type: 'hue-saturation',      params: { hue, saturation } }
 *   { type: 'levels',              params: { inBlack, inWhite, gamma, outBlack, outWhite } }
 *   { type: 'color-balance',       params: { shadows, midtones, highlights } }
 */
export function applyAdjustment(srcCanvas, adj) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');

  // 亮度/对比度和色相/饱和度可以使用快速的浏览器原生 CSS 滤镜管线。
  if (adj.type === 'brightness-contrast') {
    const p = adj.params;
    octx.filter = `brightness(${p.brightness}) contrast(${p.contrast})`;
    octx.drawImage(srcCanvas, 0, 0);
    octx.filter = 'none';
    return out;
  }
  if (adj.type === 'hue-saturation') {
    const p = adj.params;
    octx.filter = `saturate(${p.saturation}) hue-rotate(${p.hue}deg)`;
    octx.drawImage(srcCanvas, 0, 0);
    octx.filter = 'none';
    return out;
  }

  // 色阶 + 色彩平衡需要逐像素数学计算。
  octx.drawImage(srcCanvas, 0, 0);
  const img = octx.getImageData(0, 0, w, h);
  const d = img.data;

  if (adj.type === 'levels') {
    const l = adj.params;
    const inLow  = Math.max(0, Math.min(254, l.inBlack));
    const inHigh = Math.max(inLow + 1, Math.min(255, l.inWhite));
    const gamma  = Math.max(0.1, l.gamma || 1);
    const outLow  = Math.max(0, Math.min(255, l.outBlack));
    const outHigh = Math.max(outLow, Math.min(255, l.outWhite));
    const inv = 1.0 / gamma;
    const span = (outHigh - outLow);
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      let t = (v - inLow) / (inHigh - inLow);
      if (t < 0) t = 0; else if (t > 1) t = 1;
      t = Math.pow(t, inv);
      lut[v] = Math.round(t * span + outLow);
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]]; d[i+1] = lut[d[i+1]]; d[i+2] = lut[d[i+2]];
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  if (adj.type === 'color-balance') {
    const cb = adj.params;
    const scale = 0.6;
    const s = cb.shadows, m = cb.midtones, hi = cb.highlights;
    const sR = s.r*scale, sG = s.g*scale, sB = s.b*scale;
    const mR = m.r*scale, mG = m.g*scale, mB = m.b*scale;
    const hR = hi.r*scale, hG = hi.g*scale, hB = hi.b*scale;
    // 钟形曲线色调权重，使每个像素的偏移与其
    // 亮度属于"阴影"、"中间调"还是"高光"成比例。
    const wS = new Float32Array(256), wM = new Float32Array(256), wH = new Float32Array(256);
    const sig = 0.25;
    for (let v = 0; v < 256; v++) {
      const t = v / 255;
      wS[v] = Math.exp(-(t*t) / (2*sig*sig));
      wM[v] = Math.exp(-((t-0.5)*(t-0.5)) / (2*sig*sig));
      wH[v] = Math.exp(-((1-t)*(1-t)) / (2*sig*sig));
    }
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i+1], b = d[i+2];
      const Y = (0.2126*r + 0.7152*g + 0.0722*b) | 0;
      const ws = wS[Y], wm = wM[Y], wh = wH[Y];
      r += sR*ws + mR*wm + hR*wh;
      g += sG*ws + mG*wm + hG*wh;
      b += sB*ws + mB*wm + hB*wh;
      d[i]   = r < 0 ? 0 : r > 255 ? 255 : r;
      d[i+1] = g < 0 ? 0 : g > 255 ? 255 : g;
      d[i+2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  return out;
}


/**
 * 通过图层的 `layer.adjustments` 字段对图层就地应用
 * 组合的色阶 + 色彩平衡处理。结果缓存在 `layer._adjCache` 中，
 * 以 `cacheKey` 为键，使重复的合成处理不会重新计算。
 *
 * 返回缓存的输出画布。
 *
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   adjustments: object,
 *   _adjCache?: HTMLCanvasElement,
 *   _adjCacheKey?: string,
 * }} layer
 * @param {string} cacheKey  `layer.adjustments` 的稳定签名。
 */
export function renderLayerPixelAdjustments(layer, cacheKey) {
  const adj = layer.adjustments;
  if (layer._adjCache && layer._adjCacheKey === cacheKey) return layer._adjCache;
  if (!layer._adjCache) {
    layer._adjCache = document.createElement('canvas');
  }
  const out = layer._adjCache;
  out.width = layer.canvas.width;
  out.height = layer.canvas.height;
  const octx = out.getContext('2d');
  octx.clearRect(0, 0, out.width, out.height);
  octx.drawImage(layer.canvas, 0, 0);
  const img = octx.getImageData(0, 0, out.width, out.height);
  const d = img.data;

  // 色阶部分的单个 256 条目 LUT（按 R/G/B
  // 通道相同地应用 — 在色彩平衡
  // 紧随其后时，按亮度方式是不正确的，这里按通道处理即可）。
  const l = adj.levels || { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
  const inLow  = Math.max(0, Math.min(254, l.inBlack));
  const inHigh = Math.max(inLow + 1, Math.min(255, l.inWhite));
  const gamma  = Math.max(0.1, l.gamma || 1);
  const outLow  = Math.max(0, Math.min(255, l.outBlack));
  const outHigh = Math.max(outLow, Math.min(255, l.outWhite));
  const inv = 1.0 / gamma;
  const span = (outHigh - outLow);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let t = (v - inLow) / (inHigh - inLow);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    t = Math.pow(t, inv);
    lut[v] = Math.round(t * span + outLow);
  }

  // 色彩平衡钟形曲线权重（参见 applyAdjustment）。
  const cb = adj.colorBalance || { shadows: {r:0,g:0,b:0}, midtones: {r:0,g:0,b:0}, highlights: {r:0,g:0,b:0} };
  const s = cb.shadows || {r:0,g:0,b:0};
  const m = cb.midtones || {r:0,g:0,b:0};
  const h = cb.highlights || {r:0,g:0,b:0};
  const scale = 0.6;
  const sR = s.r * scale, sG = s.g * scale, sB = s.b * scale;
  const mR = m.r * scale, mG = m.g * scale, mB = m.b * scale;
  const hR = h.r * scale, hG = h.g * scale, hB = h.b * scale;

  const wS = new Float32Array(256);
  const wM = new Float32Array(256);
  const wH = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const t = v / 255;
    const dS = t, wsig = 0.25;
    const dM = t - 0.5;
    const dH = 1 - t;
    wS[v] = Math.exp(-(dS * dS) / (2 * wsig * wsig));
    wM[v] = Math.exp(-(dM * dM) / (2 * wsig * wsig));
    wH[v] = Math.exp(-(dH * dH) / (2 * wsig * wsig));
  }

  for (let i = 0; i < d.length; i += 4) {
    let r = lut[d[i]];
    let g = lut[d[i + 1]];
    let b = lut[d[i + 2]];
    const Y = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
    const ws = wS[Y], wm = wM[Y], wh = wH[Y];
    r += sR * ws + mR * wm + hR * wh;
    g += sG * ws + mG * wm + hG * wh;
    b += sB * ws + mB * wm + hB * wh;
    d[i]     = r < 0 ? 0 : r > 255 ? 255 : r;
    d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  octx.putImageData(img, 0, 0);
  layer._adjCacheKey = cacheKey;
  return out;
}


/**
 * Walk the layer's `adjLayers` stack (skipping the one currently being
 * edited, if any) plus an optional staged preview adjustment, producing
 * a final canvas the composite step can paint. The result is memoised
 * on `layer._adjFinal` keyed by a signature of all adjLayer params +
 * staged + editing id, so repeated composite passes are O(1) when
 * nothing has changed.
 *
 * 如果堆栈为空且没有暂存内容，返回图层自己的
 * 画布（无分配）。
 *
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   adjLayers?: Array<{id: string, type: string, params: object, visible: boolean, opacity: number}>,
 *   _stagedAdj?: {type: string, params: object} | null,
 *   _editingAdjId?: string | null,
 *   _adjFinal?: HTMLCanvasElement,
 *   _adjFinalKey?: string,
 * }} layer
 * @returns {HTMLCanvasElement}
 */
export function renderLayerWithAdjLayers(layer) {
  const editingId = layer._editingAdjId || null;
  const stack = (layer.adjLayers || []).filter(a => a.visible && a.id !== editingId);
  const staged = layer._stagedAdj;
  if (stack.length === 0 && !staged) {
    layer._adjFinalKey = '';
    return layer.canvas;
  }
  const sig = stack.map(a => `${a.id}:${a.visible?1:0}:${a.opacity}:${a.type}:${JSON.stringify(a.params)}`).join('|') +
    (staged ? `|S:${staged.type}:${JSON.stringify(staged.params)}` : '') +
    (editingId ? `|E:${editingId}` : '');
  if (layer._adjFinal && layer._adjFinalKey === sig) return layer._adjFinal;
  let cur = layer.canvas;
  const w = layer.canvas.width, h = layer.canvas.height;
  for (const adj of stack) {
    const adjOut = applyAdjustment(cur, adj);
    if (adj.opacity >= 0.999) {
      cur = adjOut;
    } else {
      const blend = document.createElement('canvas');
      blend.width = w; blend.height = h;
      const bctx = blend.getContext('2d');
      bctx.drawImage(cur, 0, 0);
      bctx.globalAlpha = adj.opacity;
      bctx.drawImage(adjOut, 0, 0);
      bctx.globalAlpha = 1;
      cur = blend;
    }
  }
  if (staged) {
    cur = applyAdjustment(cur, staged);
  }
  layer._adjFinal = cur;
  layer._adjFinalKey = sig;
  return cur;
}
