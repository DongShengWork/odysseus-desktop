/**
 * 通过两遍 Chamfer 距离变换进行边缘羽化 / 边缘删除。
 *
 * 对提供的 ImageData 进行就地操作。对于每个不透明像素，
 * 计算到最近的透明像素或画布边缘的（近似）距离。
 * 距离边界 `width` 范围内的像素要么
 * 被渐变过渡（`hardDelete=false`），要么被完全清除（`hardDelete=true`）。
 *
 * @param {ImageData} imgData
 * @param {number} width        羽化半径，单位像素。
 * @param {boolean} hardDelete  如果为 true，清除带区内的像素
 *                              而非渐变过渡。
 */
export function edgeFeather(imgData, width, hardDelete) {
  const w = imgData.width;
  const h = imgData.height;
  const d = imgData.data;
  const dist = new Float32Array(w * h);
  dist.fill(width + 1);

  // 种子：透明像素距离为 0。
  for (let i = 0; i < w * h; i++) {
    if (d[i * 4 + 3] === 0) dist[i] = 0;
  }

  // 两遍 Chamfer 距离变换。
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      let min = dist[i];
      if (x > 0) min = Math.min(min, dist[i - 1] + 1);
      if (y > 0) min = Math.min(min, dist[(y - 1) * w + x] + 1);
      dist[i] = min;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      let min = dist[i];
      if (x < w - 1) min = Math.min(min, dist[i + 1] + 1);
      if (y < h - 1) min = Math.min(min, dist[(y + 1) * w + x] + 1);
      dist[i] = min;
    }
  }

  // 将画布边框本身视为边界。
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edgeDist = Math.min(x, y, w - 1 - x, h - 1 - y);
      const i = y * w + x;
      dist[i] = Math.min(dist[i], edgeDist);
    }
  }

  // 应用。
  for (let i = 0; i < w * h; i++) {
    if (d[i * 4 + 3] === 0) continue;
    const edgeDist = dist[i];
    if (edgeDist < width) {
      if (hardDelete) {
        d[i * 4 + 3] = 0;
      } else {
        const fade = edgeDist / width;
        d[i * 4 + 3] = Math.round(d[i * 4 + 3] * fade);
      }
    }
  }
}
