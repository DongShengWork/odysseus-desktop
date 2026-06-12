/**
 * 编辑器内共享的滑块 UX 接线：
 *
 *   1. 拖动滑块时应用 `is-using` 类（橡皮擦行在使用时展开到更宽的轨道）。
 *      pointerup 后 0.5 秒清除，使快速点击不会立即弹回。
 *   2. 拖动时滑块上方显示浮动数值气泡。
 *      桌面端：仅图层不透明度滑块显示气泡（橡皮擦行滑块已在右侧显示数值芯片）。
 *      移动端：编辑器中的每个滑块都显示气泡。
 *   3. 点击数值芯片直接输入数字 — 将 span 替换为内联输入框，直到 blur/Enter。
 *
 * 在编辑器打开时一次性连接；监听器通过 state.container 委托在整个会话中保持活动。
 *
 * @param {{
 *   registerDocClickAway: (handler: (e: Event) => void) => void,
 * }} deps
 */
import { state } from './state.js';

export function wireSliderUx({ registerDocClickAway }) {
  const container = state.container;
  if (!container) return;

  // ── 浮动气泡 ──
  const sliderBubble = document.createElement('div');
  sliderBubble.className = 'ge-slider-bubble';
  sliderBubble.hidden = true;
  let sliderBubbleSlider = null;

  // 查找任何滑块的容器行 — 适用于 ge-eraser-row 滑块
  // 以及每个图层项上的图层不透明度滑块。
  function bubbleRowFor(slider) {
    return slider.closest('.ge-eraser-row, .ge-layer-item, .ge-control-row, .ge-adj-row');
  }
  function bubbleText(slider) {
    const row = bubbleRowFor(slider);
    // 拉出的数值芯片（滑块之后）优先；回退到
    // 编辑器使用的各种 `<label> <span>` 样式。
    const chip = row?.querySelector('.ge-slider-value')
      || row?.querySelector('label > span[id$="-label"]')
      || row?.querySelector('label > .ge-size-label')
      || row?.querySelector('.ge-adj-value');
    if (chip) return chip.textContent;
    if (slider.classList.contains('ge-layer-opacity')) {
      return Math.round(parseFloat(slider.value)) + '%';
    }
    return slider.value;
  }
  function bubblePos(slider, cursorX) {
    // 气泡固定定位在 document.body 上，使其脱离行祖先元素上的
    // 任何 overflow:hidden / overflow:auto。气泡的 X 坐标限制在
    // 滑块的轨道范围内，不能跟随拖拽远超任一端的手指。
    const sliderRect = slider.getBoundingClientRect();
    const minX = sliderRect.left + 8;
    const maxX = sliderRect.right - 8;
    const x = Math.max(minX, Math.min(maxX, cursorX));
    sliderBubble.style.left = x + 'px';
    sliderBubble.style.top  = (sliderRect.top - 8) + 'px';
  }
  function showSliderBubble(slider, e) {
    if (sliderBubble.parentElement !== document.body) document.body.appendChild(sliderBubble);
    sliderBubble.textContent = bubbleText(slider);
    bubblePos(slider, e ? e.clientX : slider.getBoundingClientRect().left + slider.offsetWidth / 2);
    sliderBubble.hidden = false;
    sliderBubble.classList.add('visible');
    sliderBubbleSlider = slider;
  }
  function hideSliderBubble() {
    sliderBubble.classList.remove('visible');
    sliderBubble.hidden = true;
    sliderBubbleSlider = null;
  }

  const slidingTimers = new WeakMap();
  // 桌面端：仅图层不透明度滑块显示气泡（橡皮擦行有自己的芯片）。
  // 移动端：每个滑块都显示一个。
  const isMobileSliders = window.matchMedia('(max-width: 820px)').matches;
  const SLIDER_SEL = isMobileSliders
    ? '.ge-layer-opacity, .ge-eraser-row input[type="range"], .ge-control-row input[type="range"], .ge-adj-row input[type="range"]'
    : '.ge-layer-opacity';

  container.addEventListener('pointerdown', (e) => {
    const slider = e.target.closest(SLIDER_SEL);
    if (!slider) return;
    const t = slidingTimers.get(slider);
    if (t) { clearTimeout(t); slidingTimers.delete(slider); }
    slider.classList.add('is-using');
    showSliderBubble(slider, e);
    // 补偿向左扩展的橡皮擦滑块，使滑块在新的（更宽的）轨道上
    // 落在光标 X 坐标处。图层不透明度在扩展时不向左移动，
    // 因此使用浏览器默认行为。
    if (slider.matches('.ge-eraser-row input[type="range"]')) {
      const rect = slider.getBoundingClientRect();
      const valFrac = Math.max(0, Math.min(1, 1 - (rect.right - e.clientX) / 140));
      const min = parseFloat(slider.min) || 0;
      const max = parseFloat(slider.max) || 100;
      const step = parseFloat(slider.step) || 1;
      const raw = min + valFrac * (max - min);
      const stepped = Math.round(raw / step) * step;
      requestAnimationFrame(() => {
        slider.value = String(stepped);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        sliderBubble.textContent = bubbleText(slider);
      });
    } else {
      requestAnimationFrame(() => {
        sliderBubble.textContent = bubbleText(slider);
      });
    }
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!sliderBubbleSlider) return;
    bubblePos(sliderBubbleSlider, e.clientX);
    sliderBubble.textContent = bubbleText(sliderBubbleSlider);
  });
  const scheduleSliderRelease = (slider) => {
    if (!slider) return;
    const old = slidingTimers.get(slider);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      slider.classList.remove('is-using');
      slidingTimers.delete(slider);
    }, 500);
    slidingTimers.set(slider, t);
  };
  document.addEventListener('pointerup', () => {
    container.querySelectorAll('input[type="range"].is-using').forEach(scheduleSliderRelease);
    hideSliderBubble();
  });

  // ── 点击数值芯片输入数字 ──
  // 将芯片替换为小型内联输入框，直到 blur/Enter，
  // 然后写回滑块并分发 `input` 事件使预览响应。
  // 匹配旧版芯片和拉出的 `.ge-slider-value` 芯片，
  // 使编辑器中的每个滑块行都可点击输入编辑。
  registerDocClickAway((e) => {
    const chip = e.target.closest(
      '.ge-eraser-row .ge-slider-value, ' +
      '.ge-eraser-row label > span[id$="-label"], ' +
      '.ge-eraser-row > span[id$="-label"], ' +
      '.ge-adj-row .ge-adj-value'
    );
    if (!chip) return;
    const row = chip.closest('.ge-eraser-row, .ge-adj-row');
    const slider = row?.querySelector('input[type="range"]');
    if (!slider) return;
    e.preventDefault();
    e.stopPropagation();
    const numeric = (slider.value ?? '').toString();
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = numeric;
    inp.className = 'ge-slider-edit';
    chip.style.visibility = 'hidden';
    row.appendChild(inp);
    // 将输入框定位在芯片所在位置。
    const crect = chip.getBoundingClientRect();
    const rrect = row.getBoundingClientRect();
    inp.style.left = (crect.left - rrect.left) + 'px';
    inp.style.top = (crect.top - rrect.top - 1) + 'px';
    inp.style.width = Math.max(40, crect.width + 8) + 'px';
    inp.focus();
    inp.select();
    const commit = () => {
      const v = parseFloat(inp.value);
      if (!Number.isNaN(v)) {
        const min = parseFloat(slider.min) || 0;
        const max = parseFloat(slider.max) || 100;
        const clamped = Math.max(min, Math.min(max, v));
        slider.value = String(clamped);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
      cleanup();
    };
    const cleanup = () => {
      inp.remove();
      chip.style.visibility = '';
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); cleanup(); }
    });
  });
}
