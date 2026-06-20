/**
 * 在编辑器的调整滑块界面和 CSS `filter` 字符串 /
 * 画布滤镜乘数之间进行转换的纯辅助函数。
 */

/**
 * 从图层的 `adjustments` 对象构建 CSS `filter` 字符串。
 * 当每个值都是标识值时返回 ''，使合成路径
 * 可以完全跳过滤镜。
 *
 * @param {{
 *   brightness?: number, contrast?: number,
 *   saturation?: number, hue?: number,
 * }|null|undefined} adj
 */
export function layerFilterString(adj) {
  if (!adj) return '';
  const parts = [];
  if (adj.brightness !== undefined && adj.brightness !== 1) parts.push(`brightness(${adj.brightness})`);
  if (adj.contrast !== undefined && adj.contrast !== 1) parts.push(`contrast(${adj.contrast})`);
  if (adj.saturation !== undefined && adj.saturation !== 1) parts.push(`saturate(${adj.saturation})`);
  if (adj.hue !== undefined && adj.hue !== 0) parts.push(`hue-rotate(${adj.hue}deg)`);
  return parts.join(' ');
}


/**
 * 将存储的滤镜乘数（亮度/对比度/饱和度
 * 范围是 0..2，1.0 = 标识值；色相为度数，-180..+180）
 * 转换为界面滑块的 -100..+100（或色相的 -180..+180）范围。
 */
export function fxFilterToSlider(key, value) {
  if (key === 'brightness' || key === 'contrast' || key === 'saturation') {
    return Math.round(((value ?? 1) - 1) * 100);
  }
  if (key === 'hue') return Math.round(value ?? 0);
  return 0;
}
