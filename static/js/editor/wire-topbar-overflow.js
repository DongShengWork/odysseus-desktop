/**
 * 顶栏溢出处理 — 保持轻量级标签更新，并在编辑器窗口
 * 变窄时仅隐藏低优先级的 AI 模型控件。
 *
 * 加上小型画布尺寸显示标签更新器（因为它也位于
 * 顶栏中）。
 *
 * 导入和画布保持为真正的顶栏按钮；这里有意
 * 没有"更多"溢出菜单。
 *
 * @param {{
 *   container:            HTMLElement,
 *   registerDocClickAway: (handler: (e: Event) => void) => void,
 * }} deps
 */
import { state } from './state.js';

export function wireTopbarOverflow({ container }) {
  // 画布尺寸标记更新器（保持简单 — 它位于顶栏中）。
  const sizeLabel = document.getElementById('ge-canvas-size');
  function updateSizeLabel() {
    if (sizeLabel) sizeLabel.textContent = `${state.imgWidth}×${state.imgHeight}`;
  }
  updateSizeLabel();

  const topbar = container.querySelector('.ge-topbar');
  // Gen 控件及其 "Gen" 标签 span — 窗口变窄时作为一组折叠。
  // Inpaint 模型选择器已移至侧边面板。
  const aiGroup = [
    container.querySelector('#ge-ai-model'),
    ...container.querySelectorAll('.ge-topbar span[style*="font-size:9px"]'),
  ].filter(Boolean);

  function syncOverflow() {
    if (!topbar) return;
    aiGroup.forEach(el => { el.style.display = ''; });
    if (topbar.scrollWidth > topbar.clientWidth) {
      // 首先隐藏 AI 组 — 在窄宽度下最占空间且最不重要。
      aiGroup.forEach(el => { el.style.display = 'none'; });
    }
  }

  if (topbar && window.ResizeObserver) {
    const ro = new ResizeObserver(() => syncOverflow());
    ro.observe(topbar);
  }
  // 布局稳定后进行初次检测。
  requestAnimationFrame(syncOverflow);
}
