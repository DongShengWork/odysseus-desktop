/**
 * 在给定画布上下文中绘制透明度棋盘格图案。
 * 编辑器在每次图层绘制通道下方使用此图案，使得文档中
 * 空白（透明）区域可见。
 *
 * 纯函数 — 仅依赖于其参数。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w  宽度，单位为画布像素。
 * @param {number} h  高度，单位为画布像素。
 */
export function drawCheckerboard(ctx, w, h) {
  const size = 10;
  ctx.fillStyle = '#ccc';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      if ((Math.floor(x / size) + Math.floor(y / size)) % 2 === 0) {
        ctx.fillRect(x, y, size, size);
      }
    }
  }
}
