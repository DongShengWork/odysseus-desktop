/**
 * RGBA 像素数据的迭代式 4 连通区域泛洪填充。
 *
 * 纯函数 — 接收源像素数组 + 种子点 + 容差，
 * 返回一个遮罩画布，其中填充区域为白色。旧版
 * 画廊编辑器的魔棒工具委托给此函数。
 *
 * @param {Uint8ClampedArray|Uint8Array} src   RGBA 字节（长度 = w*h*4）。
 * @param {number} w                           像素宽度。
 * @param {number} h                           像素高度。
 * @param {number} seedX                       向下取整的种子 X。
 * @param {number} seedY                       向下取整的种子 Y。
 * @param {number} tolerance                   容差 0..100。内部会平方并
 *                                             缩放到 RGB+A 空间
 *                                             （100 时最大值约 195k）。
 * @returns {HTMLCanvasElement|null}           一个 `w × h` 的遮罩画布，
 *                                             访问过的单元格为不透明白色
 *                                             像素，若种子点超出边界则
 *                                             返回 null。
 */
export function floodFillMask(src, w, h, seedX, seedY, tolerance) {
  if (seedX < 0 || seedY < 0 || seedX >= w || seedY >= h) return null;

  const seedIdx = (seedY * w + seedX) * 4;
  const sr = src[seedIdx], sg = src[seedIdx + 1];
  const sb = src[seedIdx + 2], sa = src[seedIdx + 3];

  // 0..100 → 平方 RGB+A 距离阈值。单通道最大差值
  // 为 255，因此 sqrt(4 * 255²) ≈ 510；tol=100 时平方上限 ≈ 195k。
  const tol = Math.pow(tolerance * 4.42, 2);

  const visited = new Uint8Array(w * h);
  const stack = [seedX, seedY];
  visited[seedY * w + seedX] = 1;
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    const nbrs = [
      [x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1],
    ];
    for (const [nx, ny] of nbrs) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const idx = ny * w + nx;
      if (visited[idx]) continue;
      const o = idx * 4;
      const dr = src[o] - sr, dg = src[o + 1] - sg;
      const db = src[o + 2] - sb, da = src[o + 3] - sa;
      // RGB + 感知 alpha，因此点击透明像素会
      // 干净地选中透明区域。
      if (dr * dr + dg * dg + db * db + da * da <= tol) {
        visited[idx] = 1;
        stack.push(nx, ny);
      }
    }
  }

  const mask = document.createElement('canvas');
  mask.width = w;
  mask.height = h;
  const mCtx = mask.getContext('2d');
  const mData = mCtx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    if (visited[i]) {
      mData.data[i * 4]     = 255;
      mData.data[i * 4 + 1] = 255;
      mData.data[i * 4 + 2] = 255;
      mData.data[i * 4 + 3] = 255;
    }
  }
  mCtx.putImageData(mData, 0, 0);
  return mask;
}
