/**
 * Inpaint panel controls — the non-AI side-panel UI for the inpaint
 * tool (the AI Generate/Remove/Outpaint buttons live in
 * （AI 生成/移除/外扩按钮在 editor/ai-inpaint.js 中）。
 *
 *   生成前滑块（羽化 + 强度色块预览）：
 *     #ge-strength-slider     仅更新标签和色块
 *
 *   Post-gen live edge tuners — alpha-blur + dilate/erode on the most
 *   recent Inpaint Result layer, rAF-throttled so dragging stays
 *   smooth on big canvases:
 *     #ge-feather-slider       调用 applyInpaintFeather + composite
 *     #ge-edgestroke-slider    同上
 *
 *   蒙版控件：
 *     #ge-mask-vis             切换红色覆盖层可见性
 *     #ge-inpaint-invert       反转活动蒙版子图层
 *     #ge-inpaint-clear        清除活动蒙版
 *     #ge-inpaint-mode-paint   设置持久涂抹模式
 *     #ge-inpaint-mode-erase   设置持久擦除模式
 *
 *   蒙版颜色选择器（保持两者视觉同步）：
 *     .ge-inpaint-mask-color   （修复区域）
 *     #ge-topbar-mask-color    （顶部栏色块 — 附带了 HSV 颜色选择器）
 *
 * @param {{
 *   composite:                () => void,
 *   applyInpaintFeather:      (layer: object, featherPx: number, edgeShiftPx: number) => void,
 *   syncToolClearIndicators:  () => void,
 *   attachColorPicker:        (el: HTMLInputElement) => void,
 *   uiModule:                 object,
 * }} deps
 */
import { state } from './state.js';

const EYE_OPEN_SM = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SM  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/></svg>';

export function wireInpaintControls({
  composite, applyInpaintFeather, syncToolClearIndicators,
  attachColorPicker, uiModule,
}) {
  // ── 羽化 + 强度预览色块 ──
  const featherPrev = document.getElementById('ge-feather-preview');
  const strengthPrev = document.getElementById('ge-strength-preview');
  function syncFeatherPreview(v) {
    if (!featherPrev) return;
    const inner = Math.max(0, 50 - v * 1.25);
    featherPrev.style.background = `radial-gradient(circle, var(--fg) 0%, var(--fg) ${inner}%, transparent 75%)`;
  }
  function syncStrengthPreview(v) {
    if (!strengthPrev) return;
    strengthPrev.style.opacity = (v / 100).toFixed(2);
  }

  // ── 修复后实时边缘调节器 ──
  // Alpha 模糊（羽化）+ 膨胀/腐蚀（边缘描边）作用于最近的
  // 修复结果图层。通过 rAF 节流使拖动保持流畅。
  let featherRafPending = false;
  function scheduleInpaintEdgeRefresh() {
    if (featherRafPending) return;
    featherRafPending = true;
    requestAnimationFrame(() => {
      featherRafPending = false;
      const layer = state.layers.find(l => l.id === state.lastInpaintLayerId);
      if (!layer || !layer.inpaintSource) return;
      const feather = parseInt(document.getElementById('ge-feather-slider')?.value || '0', 10);
      const edge = parseInt(document.getElementById('ge-edgestroke-slider')?.value || '0', 10);
      applyInpaintFeather(layer, feather, edge);
      composite();
    });
  }
  document.getElementById('ge-feather-slider')?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    document.getElementById('ge-feather-label').textContent = v + 'px';
    syncFeatherPreview(v);
    scheduleInpaintEdgeRefresh();
  });
  document.getElementById('ge-edgestroke-slider')?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    const label = document.getElementById('ge-edgestroke-label');
    if (label) label.textContent = (v > 0 ? '+' : '') + v + 'px';
    const prev = document.getElementById('ge-edgestroke-preview');
    if (prev) {
      // 可视化方向：膨胀（+）→ 绿色，腐蚀（−）→ 红色。
      const dir = v === 0 ? 'transparent' : (v > 0 ? 'rgba(120,200,120,0.5)' : 'rgba(200,120,120,0.5)');
      prev.style.background = dir;
      prev.style.opacity = Math.min(1, Math.abs(v) / 80).toFixed(2);
    }
    scheduleInpaintEdgeRefresh();
  });
  document.getElementById('ge-strength-slider')?.addEventListener('input', (e) => {
    document.getElementById('ge-strength-label').textContent = (e.target.value / 100).toFixed(2);
    syncStrengthPreview(parseInt(e.target.value, 10));
  });
  syncFeatherPreview(0);
  syncStrengthPreview(75);

  // ── 蒙版可见性 / 反转 / 清除 ──
  document.getElementById('ge-mask-vis')?.addEventListener('click', () => {
    state.maskVisible = !state.maskVisible;
    const btn = document.getElementById('ge-mask-vis');
    if (!btn) { composite(); return; }
    btn.innerHTML = `${state.maskVisible ? EYE_OPEN_SM : EYE_OFF_SM}<span id="ge-mask-vis-label">${state.maskVisible ? 'Hide' : 'Show'}</span>`;
    btn.title = state.maskVisible ? 'Hide mask' : 'Show mask';
    btn.classList.toggle('visible', state.maskVisible);
    composite();
  });
  document.getElementById('ge-inpaint-invert')?.addEventListener('click', () => {
    if (!state.maskCtx || !state.maskCanvas) return;
    const imgData = state.maskCtx.getImageData(0, 0, state.maskCanvas.width, state.maskCanvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const alpha = d[i + 3];
      if (alpha > 0) {
        d[i] = 0; d[i+1] = 0; d[i+2] = 0; d[i+3] = 0;
      } else {
        d[i] = 255; d[i+1] = 255; d[i+2] = 255; d[i+3] = 255;
      }
    }
    state.maskCtx.putImageData(imgData, 0, 0);
    composite();
    syncToolClearIndicators();
    uiModule.showToast('Mask inverted');
  });
  document.getElementById('ge-inpaint-clear')?.addEventListener('click', () => {
    if (state.maskCtx) { state.maskCtx.clearRect(0, 0, state.maskCanvas.width, state.maskCanvas.height); composite(); }
    syncToolClearIndicators();
  });

  // ── 涂抹 / 擦除分段切换 ──
  function setInpaintMode(eraseMode) {
    state.inpaintEraseMode = !!eraseMode;
    const paintBtn = document.getElementById('ge-inpaint-mode-paint');
    const eraseBtn = document.getElementById('ge-inpaint-mode-erase');
    if (paintBtn) paintBtn.classList.toggle('active', !state.inpaintEraseMode);
    if (eraseBtn) eraseBtn.classList.toggle('active', state.inpaintEraseMode);
  }
  document.getElementById('ge-inpaint-mode-paint')?.addEventListener('click', () => setInpaintMode(false));
  document.getElementById('ge-inpaint-mode-erase')?.addEventListener('click', () => setInpaintMode(true));

  // ── 蒙版颜色选择器 ──
  // 实时更新 state.maskTintColor，让用户可以选择与照片
  // 形成对比的颜色。同时连接顶部栏选择器和修复区域选择器，
  // 使更改一个即可同步另一个。
  function applyMaskTintFromHex(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    state.maskTintColor = `rgba(${r}, ${g}, ${b}, 1)`;
    const inpaintPicker = document.querySelector('.ge-inpaint-mask-color');
    const topbarPicker = document.getElementById('ge-topbar-mask-color');
    if (inpaintPicker && inpaintPicker.value !== hex) inpaintPicker.value = hex;
    if (topbarPicker && topbarPicker.value !== hex) topbarPicker.value = hex;
    composite();
  }
  document.querySelector('.ge-inpaint-mask-color')?.addEventListener('input', (e) => applyMaskTintFromHex(e.target.value));
  document.getElementById('ge-topbar-mask-color')?.addEventListener('input', (e) => applyMaskTintFromHex(e.target.value));
  // 使用内置 HSV 颜色选择器来处理顶部栏色块。
  const topbarMaskColor = document.getElementById('ge-topbar-mask-color');
  if (topbarMaskColor) {
    try { attachColorPicker(topbarMaskColor); topbarMaskColor.value = topbarMaskColor.value; } catch {}
  }
}
