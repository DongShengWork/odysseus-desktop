/**
 * 图层面板底部的图层合并/扁平化按钮：
 *
 *   #ge-flatten     Flatten Copy — merge every visible layer into a
 *                   "Flattened" 图层，保留原始图层。
 *   #ge-merge-all   Merge All — flatten every VISIBLE layer into the
 *                   lowest visible one. Hidden layers dropped. Base
 *                   = lowest visible (not bottom of stack) so a
 *                   hidden base can't absorb the visible stack into
 *                   "Flattened" 图层，保留原始图层。
 *   #ge-merge-down  Merge active layer into the one beneath it.
 *
 * @param {{
 *   saveState:        (label?: string) => void,
 *   createLayer:      (name, w, h) => object,
 *   renderLayerPanel: () => void,
 *   composite:        () => void,
 *   uiModule:         object,
 * }} deps
 */
import { state } from './state.js';

export function mergeLayerDownAtIndex(idx) {
  if (idx < 1 || idx >= state.layers.length) return null;
  const upper = state.layers[idx];
  const lower = state.layers[idx - 1];
  const upperOff = state.layerOffsets.get(upper.id) || { x: 0, y: 0 };
  const lowerOff = state.layerOffsets.get(lower.id) || { x: 0, y: 0 };
  lower.ctx.save();
  lower.ctx.globalAlpha = upper.opacity;
  lower.ctx.drawImage(
    upper.canvas,
    upperOff.x - lowerOff.x,
    upperOff.y - lowerOff.y,
  );
  lower.ctx.restore();
  state.layers.splice(idx, 1);
  state.layerOffsets.delete(upper.id);
  state.activeLayerId = lower.id;
  return lower;
}

export function wireMergeButtons({ saveState, createLayer, renderLayerPanel, composite, uiModule }) {
  // 扁平化复制。
  document.getElementById('ge-flatten')?.addEventListener('click', () => {
    if (state.layers.length < 2) return;
    saveState('Flatten copy');
    const merged = createLayer('Flattened', state.imgWidth, state.imgHeight);
    const ctx = merged.ctx;
    for (const l of state.layers) {
      if (!l.visible) continue;
      const off = state.layerOffsets.get(l.id) || { x: 0, y: 0 };
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.canvas, off.x, off.y);
      ctx.globalAlpha = 1;
    }
    state.layers.push(merged);
    state.activeLayerId = merged.id;
    renderLayerPanel();
    composite();
    uiModule.showToast('Flattened copy created');
  });

  // 合并全部 — 丢弃隐藏图层；基图层 = 最底层可见图层。
  document.getElementById('ge-merge-all')?.addEventListener('click', () => {
    const visibleLayers = state.layers.filter(l => l.visible);
    if (visibleLayers.length < 2) {
      if (uiModule) uiModule.showToast('Need at least two visible layers to merge');
      return;
    }
    saveState('Merge all');
    const base = visibleLayers[0];
    const baseCtx = base.ctx;
    for (let i = 1; i < visibleLayers.length; i++) {
      const l = visibleLayers[i];
      const off = state.layerOffsets.get(l.id) || { x: 0, y: 0 };
      baseCtx.globalAlpha = l.opacity;
      baseCtx.drawImage(l.canvas, off.x, off.y);
      baseCtx.globalAlpha = 1;
    }
    // 释放被丢弃图层的偏移量条目；保留基图层。
    for (const l of state.layers) {
      if (l === base) continue;
      state.layerOffsets.delete(l.id);
    }
    state.layers = [base];
    state.activeLayerId = base.id;
    renderLayerPanel();
    composite();
    uiModule.showToast('Visible layers merged');
  });

  // 向下合并。
  document.getElementById('ge-merge-down')?.addEventListener('click', () => {
    const idx = state.layers.findIndex(l => l.id === state.activeLayerId);
    if (idx < 1) return; // 无法合并最底层图层
    saveState('Merge down');
    mergeLayerDownAtIndex(idx);
    renderLayerPanel();
    composite();
    uiModule.showToast('Layer merged down');
  });
}
