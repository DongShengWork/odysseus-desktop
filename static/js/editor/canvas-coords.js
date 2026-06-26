/**
 * 将指针事件的客户端坐标转换为画布的
 * 内部像素坐标，考虑当前显示缩放。
 *
 * 同时处理鼠标事件和触摸事件的第一个手指。
 *
 * @param {MouseEvent|TouchEvent} e
 * @param {HTMLCanvasElement} canvas
 * @returns {{x: number, y: number}}
 */
export function canvasCoords(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const clientX = e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches && e.touches.length ? e.touches[0].clientY : e.clientY;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}
