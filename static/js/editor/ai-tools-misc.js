/**
 * 杂项 AI 工具绑定 — 三个不共享
 * 修复流程的 AI 工具：
 *
 *   Harmonize：在身体遮罩上进行 Reinhard 颜色迁移（无 AI 重绘）
 *              + 如果"接缝修复"滑块 > 0，则在接缝遮罩上
 *              进行可选的窄范围修复。
 *   Canvas 2×/4× 放大：浏览器内双三次重采样，无需服务器。
 *   AI 放大：通过 /api/image/upscale-local 使用 Real-ESRGAN。
 *   风格迁移：通过 /api/gallery/style-transfer 进行 img2img。
 *
 * 外加小型 `_addEmptyLayer` 辅助函数及其工具栏绑定，
 * 因为它紧邻这些功能。
 *
 * @param {{
 *   apiBase:             string,
 *   buildLayerBodyMask:  (featherPx: number) => string | null,
 *   buildSeamMask:       (featherPx: number) => string | null,
 *   applyImageTool:      (endpoint, payload, layerName, btn, opts?) => Promise<void>,
 *   flatten:             () => HTMLCanvasElement,
 *   saveState:           (label?: string) => void,
 *   fitZoom:             () => void,
 *   composite:           () => void,
 *   createLayer:         (name, w, h) => object,
 *   renderLayerPanel:    () => void,
 *   spinnerModule:       object,
 *   uiModule:            object,
 * }} deps
 *
 * @returns {{ addEmptyLayer: () => void }}
 */
import { state } from './state.js';

export function wireAIToolsMisc({
  apiBase, buildLayerBodyMask, buildSeamMask, applyImageTool,
  flatten, saveState, fitZoom, composite, createLayer, renderLayerPanel,
  spinnerModule, uiModule,
}) {
  // ── 协调滑块 — 颜色匹配 + 接缝修复 ──
  const harmColorPrev = document.getElementById('ge-harmonize-color-preview');
  const harmSeamPrev = document.getElementById('ge-harmonize-seam-preview');
  document.getElementById('ge-harmonize-color')?.addEventListener('input', (e) => {
    document.getElementById('ge-harmonize-color-label').textContent = (e.target.value / 100).toFixed(2);
    if (harmColorPrev) harmColorPrev.style.opacity = (parseInt(e.target.value, 10) / 100).toFixed(2);
  });
  document.getElementById('ge-harmonize-seam')?.addEventListener('input', (e) => {
    document.getElementById('ge-harmonize-seam-label').textContent = (e.target.value / 100).toFixed(2);
    if (harmSeamPrev) harmSeamPrev.style.opacity = (parseInt(e.target.value, 10) / 100).toFixed(2);
  });

  // 协调按钮 — 两阶段：
  //   1) 在身体遮罩上进行 Reinhard 颜色迁移（无 AI 重绘）
  //   2) 如果 seam_fix > 0，在接缝遮罩上进行可选的窄范围修复
  document.getElementById('ge-harmonize-run')?.addEventListener('click', () => {
    const prompt = document.getElementById('ge-harmonize-prompt')?.value?.trim() || 'photorealistic, natural lighting, seamless blend';
    const color_match = (parseInt(document.getElementById('ge-harmonize-color')?.value || '65')) / 100;
    const seam_fix = (parseInt(document.getElementById('ge-harmonize-seam')?.value || '0')) / 100;
    const bodyFeather = Math.max(6, Math.round(Math.min(state.imgWidth, state.imgHeight) * 0.012));
    const seamFeather = Math.max(8, Math.round(Math.min(state.imgWidth, state.imgHeight) * 0.015));
    const body_mask = buildLayerBodyMask(bodyFeather);
    const seam_mask = seam_fix > 0.01 ? buildSeamMask(seamFeather) : null;
    // 协调需要一个非基础图层来与背景进行
    // 颜色匹配。如果没有，服务器将回退到传统的
    // 全图 img2img — 即重新生成整张照片。阻止
    // 该行为并告知用户缺少什么。
    if (!body_mask) {
      if (uiModule) uiModule.showToast('协调需要在基础照片上粘贴/导入第二个图层 — 没有可颜色匹配的目标。', 6000);
      return;
    }
    const payload = { prompt, color_match, seam_fix, body_mask };
    if (seam_mask) payload.seam_mask = seam_mask;
    applyImageTool('/api/image/harmonize', payload, '协调完成', document.getElementById('ge-harmonize-run'));
  });

  // ── 画布放大（双三次）──
  function canvasUpscale(factor) {
    saveState(`放大 ${factor}×`);
    const newW = state.imgWidth * factor;
    const newH = state.imgHeight * factor;
    state.layers.forEach(l => {
      const tmp = document.createElement('canvas');
      tmp.width = newW; tmp.height = newH;
      const tCtx = tmp.getContext('2d');
      tCtx.imageSmoothingEnabled = true;
      tCtx.imageSmoothingQuality = 'high';
      tCtx.drawImage(l.canvas, 0, 0, newW, newH);
      l.canvas.width = newW; l.canvas.height = newH;
      l.ctx.drawImage(tmp, 0, 0);
    });
    if (state.maskCanvas) { state.maskCanvas.width = newW; state.maskCanvas.height = newH; }
    state.imgWidth = newW; state.imgHeight = newH;
    state.mainCanvas.width = newW; state.mainCanvas.height = newH;
    const sizeLabel = document.getElementById('ge-canvas-size');
    if (sizeLabel) sizeLabel.textContent = `${newW}×${newH}`;
    fitZoom();
    composite();
    uiModule.showToast(`${t('editor.upscaled_to', { factor: factor, w: newW, h: newH })}`);
  }
  document.getElementById('ge-upscale-2x')?.addEventListener('click', () => canvasUpscale(2));
  document.getElementById('ge-upscale-4x')?.addEventListener('click', () => canvasUpscale(4));

  // ── AI 放大（Real-ESRGAN，无需 diffusion 服务器）──
  document.getElementById('ge-upscale-ai')?.addEventListener('click', async () => {
    const btn = document.getElementById('ge-upscale-ai');
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    let upWp = null;
    try {
      upWp = spinnerModule.createWhirlpool(14);
      upWp.element.style.cssText = 'display:inline-block;vertical-align:middle;position:relative;top:1px;margin-right:6px;width:14px;height:14px;';
      btn.innerHTML = '';
      btn.appendChild(upWp.element);
      const lbl = document.createElement('span');
      lbl.textContent = '正在放大…';
      btn.appendChild(lbl);
    } catch (_) { btn.textContent = '正在放大…'; }
    try {
      const flat = flatten();
      const imageB64 = flat.toDataURL('image/png').split(',')[1];
      const res = await fetch('/api/image/upscale-local', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageB64, scale: 2 }),
      });
      if (!res.ok) throw new Error('服务器返回 ' + res.status);
      const data = await res.json();
      if (data.image) {
        const img = new Image();
        img.onload = () => {
          if (!state.editorOpen) return;
          saveState();
          const newW = img.width, newH = img.height;
          const layer = createLayer('AI 放大完成', newW, newH);
          layer.ctx.drawImage(img, 0, 0);
          state.layers.push(layer);
          state.activeLayerId = layer.id;
          state.imgWidth = newW; state.imgHeight = newH;
          state.mainCanvas.width = newW; state.mainCanvas.height = newH;
          if (state.maskCanvas) { state.maskCanvas.width = newW; state.maskCanvas.height = newH; }
          const sizeLabel = document.getElementById('ge-canvas-size');
          if (sizeLabel) sizeLabel.textContent = `${newW}×${newH}`;
          fitZoom();
          composite();
          renderLayerPanel();
          uiModule.showToast(`${t('editor.ai_upscaled_to', { w: newW, h: newH })}`);
        };
        img.src = 'data:image/png;base64,' + data.image;
      } else {
        throw new Error(data.error || '未返回图像');
      }
    } catch (e) {
      uiModule.showToast('AI 放大失败: ' + e.message);
    }
    try { upWp?.destroy(); } catch (_) {}
    btn.disabled = false;
    btn.innerHTML = origHTML;
  });

  // ── 风格迁移 ──
  document.getElementById('ge-style-strength')?.addEventListener('input', (e) => {
    document.getElementById('ge-style-strength-label').textContent = (parseInt(e.target.value) / 100).toFixed(2);
  });
  document.getElementById('ge-style-run')?.addEventListener('click', async () => {
    const btn = document.getElementById('ge-style-run');
    const prompt = document.getElementById('ge-style-prompt').value.trim();
    if (!prompt) { uiModule.showToast('请输入风格提示词'); return; }
    const strength = parseInt(document.getElementById('ge-style-strength').value) / 100;
    btn.disabled = true; btn.textContent = '正在应用...';
    try {
      const flat = flatten();
      const blob = await new Promise(r => flat.toBlob(r, 'image/png'));
      const fd = new FormData();
      fd.append('image', blob, 'style.png');
      fd.append('prompt', prompt);
      fd.append('strength', String(strength));
      const res = await fetch(`${apiBase}/api/gallery/style-transfer`, { method: 'POST', credentials: 'same-origin', body: fd });
      if (!res.ok) throw new Error('服务器返回 ' + res.status);
      const data = await res.json();
      if (data.image) {
        const img = new Image();
        img.onload = () => {
          if (!state.editorOpen) return;
          saveState();
          const layer = createLayer('风格: ' + prompt.substring(0, 20), state.imgWidth, state.imgHeight);
          layer.ctx.drawImage(img, 0, 0, state.imgWidth, state.imgHeight);
          state.layers.push(layer);
          state.activeLayerId = layer.id;
          composite();
          renderLayerPanel();
          uiModule.showToast('风格已应用');
        };
        img.src = 'data:image/png;base64,' + data.image;
      } else {
        throw new Error(data.error || '未返回图像');
      }
    } catch (e) {
      uiModule.showToast('风格迁移失败: ' + e.message);
    }
    btn.disabled = false; btn.textContent = '应用风格';
  });

  // ── 添加空白图层（由图层面板标题按钮 + Ctrl+Alt+J
  // 键盘快捷键使用）。返回以便 keyboard-shortcuts.js
  // 可以通过相同路径调用。──
  function addEmptyLayer() {
    saveState('添加图层');
    const layer = createLayer('图层 ' + state.layers.length, state.imgWidth, state.imgHeight);
    state.layers.push(layer);
    state.activeLayerId = layer.id;
    renderLayerPanel();
    composite();
  }
  document.getElementById('ge-add-layer')?.addEventListener('click', addEmptyLayer);

  return { addEmptyLayer };
}
