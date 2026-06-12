/**
 * 将图层像素的亮度直方图绘制到给定的画布上。
 * 采样上限约为 400×400，使调用在
 * 非常大的图像上保持高效。
 *
 * 如果图层有暂存的色阶调整
 * （`layer._stagedAdj.params` 带有 `inBlack` / `inWhite`），
 * 两个端点标记会绘制在柱状图上方。
 *
 * @param {HTMLCanvasElement} canvas  要渲染直方图的画布。
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   _stagedAdj?: {params?: {inBlack?: number, inWhite?: number}}
 * }} layer                            源图层。
 */
export function drawHistogram(canvas, layer) {
  if (!canvas) return;
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // 对超大图像进行降采样，使直方图在 8k+
  // 照片上保持交互性能。~400×400 足以表征分布。
  const src = layer.canvas;
  const sw = src.width, sh = src.height;
  const maxSamples = 400;
  const sampleW = Math.min(maxSamples, sw);
  const sampleH = Math.min(maxSamples, sh);
  const tmp = document.createElement('canvas');
  tmp.width = sampleW; tmp.height = sampleH;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(src, 0, 0, sampleW, sampleH);
  const img = tctx.getImageData(0, 0, sampleW, sampleH).data;

  const hist = new Uint32Array(256);
  for (let i = 0; i < img.length; i += 4) {
    if (img[i + 3] < 8) continue; // 跳过接近透明的像素
    // Rec. 709 亮度 — 照片编辑器中直方图的常见选择。
    const Y = (0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2]) | 0;
    hist[Math.min(255, Y)]++;
  }
  let peak = 1;
  for (let i = 0; i < 256; i++) if (hist[i] > peak) peak = hist[i];

  // 背景。
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(0, 0, w, h);

  // 柱状条。使用平方根缩放，使长尾
  // （高光、深阴影）在中心质量占主导时仍然可见。
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let i = 0; i < 256; i++) {
    const x = (i / 256) * w;
    const bh = Math.pow(hist[i] / peak, 0.5) * h;
    ctx.fillRect(x, h - bh, w / 256 + 0.5, bh);
  }

  // 端点标记（输入黑点 / 输入白点）来自暂存的色阶
  // 调整（如果正在进行中）。
  const p = layer._stagedAdj?.params;
  if (p) {
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect((p.inBlack / 256) * w, 0, 1, h);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect((p.inWhite / 256) * w, 0, 1, h);
  }
}
