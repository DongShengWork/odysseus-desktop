/**
 * 套索工具的像素和路径辅助函数。
 *
 * 所有函数都接受套索多边形 `points` 作为显式参数，
 * 以便可以独立测试。旧版画廊编辑器使用其
 * 模块级 `_lassoPoints` 数组来调用它们。
 */

/**
 * 沿外向法线将每个多边形顶点偏移 `grow` 像素。
 * 用于套索覆盖层（绘制"羽化"光晕）和
 * `buildLassoMask`（将扩大的多边形烘焙到遮罩中）。
 *
 * @param {{x: number, y: number}[]} points  按绘制顺序排列的多边形顶点。
 * @param {number} grow                      正值 = 向外扩展，负值 = 收缩。
 * @returns {{x: number, y: number}[]}       新数组（相同长度，不修改原始数组）。
 */
export function lassoOffsetPoints(points, grow) {
  const n = points.length;
  if (n < 3 || !grow) return points;
  // 多边形环绕方向（正值 = 逆时针）— 翻转法线使其
  // 指向内部之外，无论绘制方向如何。
  let area = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    area += (q.x - p.x) * (q.y + p.y);
  }
  const sign = area > 0 ? 1 : -1;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[(i - 1 + n) % n], b = points[i], c = points[(i + 1) % n];
    const e1x = b.x - a.x, e1y = b.y - a.y;
    const e2x = c.x - b.x, e2y = c.y - b.y;
    const l1 = Math.hypot(e1x, e1y) || 1;
    const l2 = Math.hypot(e2x, e2y) || 1;
    // 垂线 (dy, -dx)；通过 `sign` 翻转向外方向。
    const n1x = (e1y / l1) * sign, n1y = (-e1x / l1) * sign;
    const n2x = (e2y / l2) * sign, n2y = (-e2x / l2) * sign;
    const nx = (n1x + n2x) / 2;
    const ny = (n1y + n2y) / 2;
    const nl = Math.hypot(nx, ny) || 1;
    out[i] = { x: b.x + (nx / nl) * grow, y: b.y + (ny / nl) * grow };
  }
  return out;
}


/**
 * 在给定上下文上追踪套索多边形（move-to + line-to，闭合）。
 * 调用者负责 `stroke()` / `fill()` 的选择。
 */
export function getLassoPath(ctx, points) {
  if (!points || points.length < 1) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.closePath();
}


/**
 * 从套索多边形构建一个（可选的羽化、可选的扩展）选区遮罩。
 *
 * @param {{x: number, y: number}[]} points  多边形顶点。
 * @param {number} w / h                     输出画布尺寸。
 * @param {number} offX / offY               光栅化前将多边形平移 (offX, offY)。
 * @param {number} feather                   羽化宽度（像素）。0 = 硬边缘。
 * @param {number} grow                      正值 = 膨胀多边形，负值 = 腐蚀。
 * @returns {HTMLCanvasElement}              一个 `w × h` 画布，alpha = 选区强度。
 */
export function buildLassoMask(points, w, h, offX, offY, feather, grow) {
  // 步骤 1：绘制硬遮罩
  const hard = document.createElement('canvas');
  hard.width = w; hard.height = h;
  const hCtx = hard.getContext('2d');
  hCtx.beginPath();
  hCtx.moveTo(points[0].x - offX, points[0].y - offY);
  for (let i = 1; i < points.length; i++) {
    hCtx.lineTo(points[i].x - offX, points[i].y - offY);
  }
  hCtx.closePath();
  hCtx.fillStyle = '#fff';
  hCtx.fill();

  // 步骤 1b：扩展/收缩 — 模糊硬遮罩，低阈值用于
  // 扩展，高阈值用于收缩。与背景移除边缘
  // 调节器相同的技术。RGB 保持不变，alpha 被替换。
  if (grow && grow !== 0) {
    const blurC = document.createElement('canvas');
    blurC.width = w; blurC.height = h;
    const bctx = blurC.getContext('2d');
    bctx.filter = `blur(${Math.abs(grow)}px)`;
    bctx.drawImage(hard, 0, 0);
    bctx.filter = 'none';
    const blurred = bctx.getImageData(0, 0, w, h).data;
    const hd = hCtx.getImageData(0, 0, w, h);
    const out = hd.data;
    const thr = grow > 0 ? 32 : 200;
    for (let i = 0; i < out.length; i += 4) {
      const a = blurred[i + 3] >= thr ? 255 : 0;
      out[i] = a; out[i + 1] = a; out[i + 2] = a; out[i + 3] = a;
    }
    hCtx.putImageData(hd, 0, 0);
  }

  if (feather <= 0) return hard;

  // 步骤 2：像素数据和基于距离的羽化。
  const hardData = hCtx.getImageData(0, 0, w, h);
  const d = hardData.data;

  // 构建内部/外部映射。
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    inside[i] = d[i * 4] > 128 ? 1 : 0;
  }

  // 到边缘的距离（对于选区内的像素，到最近外部像素的距离）。
  const dist = new Float32Array(w * h);
  dist.fill(feather + 1);

  // 种子：边缘像素（与外部像素相邻的内部像素）。
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inside[i]) { dist[i] = 0; continue; }
      const hasOutside = (x > 0 && !inside[i-1]) || (x < w-1 && !inside[i+1]) ||
                         (y > 0 && !inside[(y-1)*w+x]) || (y < h-1 && !inside[(y+1)*w+x]);
      if (hasOutside) dist[i] = 1;
    }
  }

  // 两遍 Chamfer 距离变换。
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      if (x > 0) dist[i] = Math.min(dist[i], dist[i-1] + 1);
      if (y > 0) dist[i] = Math.min(dist[i], dist[(y-1)*w+x] + 1);
    }
  }
  for (let y = h-1; y >= 0; y--) {
    for (let x = w-1; x >= 0; x--) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      if (x < w-1) dist[i] = Math.min(dist[i], dist[i+1] + 1);
      if (y < h-1) dist[i] = Math.min(dist[i], dist[(y+1)*w+x] + 1);
    }
  }

  // 靠近边缘的像素获得降低的 alpha。
  const result = document.createElement('canvas');
  result.width = w; result.height = h;
  const rCtx = result.getContext('2d');
  const rData = rCtx.createImageData(w, h);

  for (let i = 0; i < w * h; i++) {
    if (!inside[i]) continue;
    const edgeDist = dist[i];
    const alpha = edgeDist >= feather ? 255 : Math.round((edgeDist / feather) * 255);
    rData.data[i*4] = alpha;
    rData.data[i*4+1] = alpha;
    rData.data[i*4+2] = alpha;
    rData.data[i*4+3] = 255;
  }
  rCtx.putImageData(rData, 0, 0);
  return result;
}
