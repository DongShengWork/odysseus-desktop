/**
 * AI 修复子系统 — 生成、移除和扩图变体
 * 共享一个 `runInpaint` 核心；仅 prompt、strength 和按钮目标不同。
 * 返回一个 wireInpaintButtons() 函数，用于将处理器绑定到三个按钮
 * (#ge-inpaint-run, #ge-inpaint-remove, #ge-inpaint-outpaint)。
 *
 *   runInpaint:
 *     - 从所有可见蒙版子图层（跨所有父图层）构建联合蒙版 —
 *       模型看到的是合并后的区域，而非仅当前激活的蒙版。
 *     - 将蒙版膨胀 ~padPx，让模型填充一个缓冲区，后续
 *       生成后的羽化/边缘滑块可以过渡到这个缓冲区内。
 *     - 将展平后的画布 + 膨胀后的蒙版 POST 到 /api/image/inpaint。
 *     - 将结果作为新图层放置，在图层上快照 AI 图像 + 硬蒙版
 *       用于实时边缘调整，隐藏所有参与生成的蒙版子图层，
 *       显示生成后的羽化 + 边缘描边滑块，限制在 ±padPx。
 *
 *   Remove: 检测 OpenAI 与 SDXL 后端并切换 prompt
 *     （gpt-image-1 按语义理解 "remove …"；SDXL 需要
 *     填充描述 + strength 0.99 来提示）。
 *
 *   Outpaint: 自动生成覆盖展平合成图中空（透明）区域的蒙版，
 *     向内膨胀 12px，让模型看到相邻不透明像素作为上下文，
 *     运行 inpaint，然后恢复用户之前的蒙版绘制。
 *
 * @param {{
 *   buildMergedMaskCanvas:  () => HTMLCanvasElement | null,
 *   dilateMask:             (src: HTMLCanvasElement, px: number) => HTMLCanvasElement,
 *   applyInpaintFeather:    (layer: object, featherPx: number, edgeShiftPx: number) => void,
 *   getSelectedAIEndpoint:  (type: string) => { endpoint?: string, model?: string },
 *   ensureActiveMaskLayer:  () => object | null,
 *   saveState:              (label?: string) => void,
 *   createLayer:            (name: string, w: number, h: number) => object,
 *   composite:              () => void,
 *   renderLayerPanel:       () => void,
 *   spinnerModule:          object,
 *   uiModule:               object | null,
 * }} deps
 */
import { state } from './state.js';

export function wireInpaintButtons({
  buildMergedMaskCanvas, dilateMask, applyInpaintFeather,
  getSelectedAIEndpoint, ensureActiveMaskLayer,
  saveState, createLayer, composite, renderLayerPanel,
  spinnerModule, uiModule,
}) {
  // 共享的 inpaint 运行器 — 用于生成、移除和扩图。
  async function runInpaint({ prompt, strength, btnId, labelId, idleLabel, busyLabel }) {
    // 预检查：构建 AI 将收到的联合蒙版并验证至少有一个像素被绘制。
    const preMerged = buildMergedMaskCanvas();
    if (!preMerged) { if (uiModule) uiModule.showToast('先绘制你想要修复的区域'); return; }
    const pmCtx = preMerged.getContext('2d');
    const maskData = pmCtx.getImageData(0, 0, preMerged.width, preMerged.height).data;
    let hasMask = false;
    for (let i = 3; i < maskData.length; i += 4) { if (maskData[i] > 0) { hasMask = true; break; } }
    if (!hasMask) { if (uiModule) uiModule.showToast('先绘制你想要修复的区域'); return; }
    const btn = document.getElementById(btnId);
    const btnLabel = labelId ? document.getElementById(labelId) : null;
    btn.disabled = true;
    if (btnLabel) btnLabel.textContent = busyLabel;
    let runWp = null;
    try {
      runWp = spinnerModule.createWhirlpool(14);
      runWp.element.style.cssText = 'margin:0;flex-shrink:0;';
      btn.appendChild(runWp.element);
    } catch (_) { /* spinner 是可选的 */ }
    // 画布叠加旋转动画 — 在用户工作区域提供视觉反馈，
    // 因为运行按钮在侧面板中，高缩放时可能不在视野内。
    // 定位在蒙版质心的视口坐标上。
    let canvasWp = null;
    let canvasWpEl = null;
    try {
      const area = state.container && state.container.querySelector('.ge-canvas-area');
      const mainRect = state.mainCanvas.getBoundingClientRect();
      if (area && mainRect.width && mainRect.height) {
        // 找到蒙版的边界框以便将旋转动画居中。
        let cx = state.imgWidth / 2, cy = state.imgHeight / 2;
        try {
          const merged = buildMergedMaskCanvas();
          if (merged) {
            const d = merged.getContext('2d').getImageData(0, 0, merged.width, merged.height).data;
            let minX = merged.width, maxX = 0, minY = merged.height, maxY = 0;
            for (let y = 0; y < merged.height; y += 4) {
              for (let x = 0; x < merged.width; x += 4) {
                if (d[(y * merged.width + x) * 4 + 3] > 0) {
                  if (x < minX) minX = x; if (x > maxX) maxX = x;
                  if (y < minY) minY = y; if (y > maxY) maxY = y;
                }
              }
            }
            if (maxX >= minX) { cx = (minX + maxX) / 2; cy = (minY + maxY) / 2; }
          }
        } catch {}
        const scaleX = mainRect.width / state.mainCanvas.width;
        const scaleY = mainRect.height / state.mainCanvas.height;
        const vpX = mainRect.left + cx * scaleX;
        const vpY = mainRect.top  + cy * scaleY;
        canvasWp = spinnerModule.create('', 'clean', 'whirlpool');
        canvasWpEl = canvasWp.createElement();
        canvasWpEl.style.cssText = `position:fixed;left:${vpX}px;top:${vpY}px;transform:translate(-50%,-50%);z-index:12;pointer-events:none;`;
        document.body.appendChild(canvasWpEl);
        canvasWp.start();
      }
    } catch (_) { /* 叠加层仅为装饰 */ }
    try {
      // 展平当前图像。
      const flatCanvas = document.createElement('canvas');
      flatCanvas.width = state.imgWidth; flatCanvas.height = state.imgHeight;
      const flatCtx = flatCanvas.getContext('2d');
      for (const layer of state.layers) {
        if (!layer.visible) continue;
        flatCtx.globalAlpha = layer.opacity;
        const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
        flatCtx.drawImage(layer.canvas, off.x, off.y);
      }
      flatCtx.globalAlpha = 1;
      // 发送到模型之前膨胀用户的画笔蒙版。
      // AI 在画笔周围填充一个小缓冲区域，这样生成后的边缘
      // 羽化滑块有 AI 内容可以过渡进去，而不是直接过渡到原始
      // 内容。原始（未膨胀的）蒙版缓存在图层上 — 羽化模糊
      // 从该边界向外扩展到膨胀的 AI 区域。
      const padPx = Math.min(80, Math.max(20, Math.round(Math.min(state.imgWidth, state.imgHeight) * 0.04)));
      // 在发送到 AI 之前，将所有可见的蒙版子图层（跨所有父图层）
      // 合并到一个联合蒙版中。这样如果用户跨多个蒙版构建了
      // inpaint 区域，最终生成会看到合并后的区域，
      // 而不仅仅是当前激活的蒙版。
      const mergedMask = buildMergedMaskCanvas() || state.maskCanvas;
      const dilatedMask = dilateMask(mergedMask, padPx);
      const imageB64 = flatCanvas.toDataURL('image/png').split(',')[1];
      const maskB64 = dilatedMask.toDataURL('image/png').split(',')[1];
      const res = await fetch('/api/image/inpaint', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify((() => {
          const sel = getSelectedAIEndpoint('inpaint');
          return { image: imageB64, mask: maskB64, prompt, width: state.imgWidth, height: state.imgHeight, strength, feather: 0, _endpoint: sel.endpoint, _model: sel.model };
        })()),
      });
      if (!res.ok) {
        let errDetail = res.statusText;
        try { const errBody = await res.json(); errDetail = errBody.detail || errBody.error || errDetail; } catch {}
        throw new Error(errDetail);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.image) throw new Error('inpaint 端点未返回图像');
      // 将结果作为新图层加载，并用用户绘制的蒙版裁剪，
      // 只显示修复后的区域。在图层上缓存未羽化的
      // （AI 图像 + 硬蒙版），以便实时羽化滑块可以在每次
      // 输入事件时重新计算 alpha，而无需重新运行模型。
      const resultImg = new Image();
      resultImg.onload = () => {
        if (!state.editorOpen) return; // 用户在解码中途关闭了
        try {
          saveState('Inpaint 结果');
          // OpenAI 返回其允许的尺寸之一（1024²、1024×1536、
          // 1536×1024），这些尺寸通常与我们的画布不同。
          // 使用平滑缩放将结果缩放到画布尺寸，以便无论
          // 源尺寸如何都能无缝融合。
          const shortPrompt = (prompt || '').trim().replace(/\s+/g, ' ').slice(0, 40);
          const layerName = shortPrompt ? `Inpaint: ${shortPrompt}` : 'Inpaint 结果';
          const resultLayer = createLayer(layerName, state.imgWidth, state.imgHeight);
          resultLayer.ctx.imageSmoothingEnabled = true;
          resultLayer.ctx.imageSmoothingQuality = 'high';
          resultLayer.ctx.drawImage(resultImg, 0, 0, state.imgWidth, state.imgHeight);
          // 快照此次运行所用的 AI 结果 + 硬蒙版。
          const aiSnap = document.createElement('canvas');
          aiSnap.width = state.imgWidth; aiSnap.height = state.imgHeight;
          aiSnap.getContext('2d').drawImage(resultLayer.canvas, 0, 0);
          const maskSnap = document.createElement('canvas');
          maskSnap.width = state.maskCanvas.width;
          maskSnap.height = state.maskCanvas.height;
          maskSnap.getContext('2d').drawImage(state.maskCanvas, 0, 0);
          resultLayer.inpaintSource = { ai: aiSnap, mask: maskSnap, padPx };
          // 应用初始 alpha = 硬蒙版（无羽化，无边缘偏移）。
          applyInpaintFeather(resultLayer, 0, 0);
          state.layers.push(resultLayer);
          state.activeLayerId = resultLayer.id;
          state.lastInpaintLayerId = resultLayer.id;
          // 隐藏所有参与生成的蒙版子图层，
          // 这样红色叠加层不会覆盖结果 —
          // 但保留蒙版像素完整，并在每个子行的眼睛图标
          // 上反映"隐藏"状态。
          for (const ly of state.layers) {
            if (!ly.masks || !ly.masks.length) continue;
            for (const mk of ly.masks) mk.visible = false;
          }
          composite();
          renderLayerPanel();
          // 显示生成后的羽化 + 边缘描边滑块。
          // 边缘描边限制在 ±padPx，这样滑块不会请求超出
          // 我们生成的 AI 缓冲区范围。
          const fRow = document.getElementById('ge-inpaint-postfeather-row');
          const fSlider = document.getElementById('ge-feather-slider');
          const fLabel = document.getElementById('ge-feather-label');
          // 分隔线 + 标题始终可见；生成成功后
          // 隐藏"生成后可用"提示。
          const divEl = document.getElementById('ge-inpaint-postedge-divider');
          const titleEl = document.getElementById('ge-inpaint-postedge-title');
          const hintEl = document.getElementById('ge-inpaint-postedge-hint');
          if (divEl) divEl.style.display = '';
          if (titleEl) titleEl.style.display = '';
          if (hintEl) hintEl.style.display = 'none';
          if (fRow) fRow.style.display = '';
          if (fSlider) fSlider.value = '0';
          if (fLabel) fLabel.textContent = '0px';
          const eRow = document.getElementById('ge-inpaint-edgestroke-row');
          const eSlider = document.getElementById('ge-edgestroke-slider');
          const eLabel = document.getElementById('ge-edgestroke-label');
          if (eRow) eRow.style.display = '';
          if (eSlider) {
            eSlider.max = String(padPx);
            eSlider.min = String(-padPx);
            eSlider.value = '0';
          }
          if (eLabel) eLabel.textContent = '0px';
          if (uiModule) uiModule.showToast('Inpaint 完成 — 拖动边缘羽化 / 边缘描边来融合', 5000);
        } catch (renderErr) {
          console.error('[inpaint] 渲染错误', renderErr);
          if (uiModule) uiModule.showToast('Inpaint 渲染失败: ' + (renderErr.message || renderErr), 6000);
        }
      };
      resultImg.onerror = (e) => {
        console.error('[inpaint] base64 解码失败', e);
        if (uiModule) uiModule.showToast('Inpaint 结果解码失败', 6000);
      };
      resultImg.src = 'data:image/png;base64,' + data.image;
    } catch (e) {
      if (uiModule) uiModule.showToast('Inpaint 失败: ' + e.message, 6000);
    } finally {
      btn.disabled = false;
      if (btnLabel) btnLabel.textContent = idleLabel;
      if (runWp) { try { runWp.destroy(); } catch (_) {} }
      if (canvasWp) { try { canvasWp.destroy(); } catch (_) {} }
      if (canvasWpEl) { try { canvasWpEl.remove(); } catch (_) {} }
      window.dispatchEvent(new CustomEvent('ge:inpaint-done'));
    }
  }

  // 生成。
  document.getElementById('ge-inpaint-run').addEventListener('click', async () => {
    const prompt = document.getElementById('ge-inpaint-prompt')?.value?.trim();
    if (!prompt) { if (uiModule) uiModule.showToast('输入 inpainting 的提示词'); return; }
    const strength = (parseInt(document.getElementById('ge-strength-slider')?.value || '75')) / 100;
    await runInpaint({
      prompt, strength,
      btnId: 'ge-inpaint-run',
      labelId: 'ge-inpaint-run-label',
      idleLabel: '生成', busyLabel: '生成中',
    });
  });

  // 移除 — 检测后端类型并替换为内容感知填充 prompt。
  // gpt-image-1 按语义理解 "remove …"；
  // SDXL inpaint 管道会字面地尝试绘制 prompt，所以
  // 我们发送一个通用的环境匹配 prompt 并调高 strength。
  document.getElementById('ge-inpaint-remove').addEventListener('click', async () => {
    const sel = getSelectedAIEndpoint('inpaint');
    const ep = (sel.endpoint || '').toLowerCase();
    const isOpenAI = ep.includes('api.openai.com');
    let prompt, strength;
    if (isOpenAI) {
      const userP = document.getElementById('ge-inpaint-prompt')?.value?.trim();
      prompt = userP
        ? `Remove ${userP}. Fill seamlessly with the surrounding background, photorealistic, no objects, no people.`
        : 'Remove the masked area. Fill seamlessly with the surrounding background, photorealistic, no objects, no people.';
      strength = (parseInt(document.getElementById('ge-strength-slider')?.value || '75')) / 100;
    } else {
      // SDXL inpaint: 描述周围环境，而非描述区域内的内容。
      // 调高强度以确保模型完全覆盖蒙版区域 —
      // 低强度时会向原有内容降噪。
      prompt = 'seamless natural background, photorealistic, continuation of surrounding scene, empty area, no objects, no people, no text, clean';
      strength = 0.99;
    }
    await runInpaint({
      prompt, strength,
      btnId: 'ge-inpaint-remove',
      labelId: 'ge-inpaint-remove-label',
      idleLabel: '移除', busyLabel: '移除中',
    });
  });

  // 扩图 — 自动生成覆盖展平合成图中空（透明）区域的蒙版，
  // 然后运行 inpaint 无缝填充。蒙版膨胀 ~12px，让 AI
  // 看到相邻不透明像素作为上下文。忽略用户绘制的蒙版。
  document.getElementById('ge-inpaint-outpaint').addEventListener('click', async () => {
    // 1) 展平可见图层以检测 alpha=0（空白）区域。
    const flat = document.createElement('canvas');
    flat.width = state.imgWidth; flat.height = state.imgHeight;
    const fctx = flat.getContext('2d');
    for (const layer of state.layers) {
      if (!layer.visible) continue;
      fctx.globalAlpha = layer.opacity;
      const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
      fctx.drawImage(layer.canvas, off.x, off.y);
    }
    fctx.globalAlpha = 1;
    const flatData = fctx.getImageData(0, 0, state.imgWidth, state.imgHeight).data;
    // 2) 在合成图透明处涂白。
    const maskRaw = document.createElement('canvas');
    maskRaw.width = state.imgWidth; maskRaw.height = state.imgHeight;
    const mrCtx = maskRaw.getContext('2d');
    const mrImg = mrCtx.createImageData(state.imgWidth, state.imgHeight);
    let emptyCount = 0;
    for (let i = 0; i < flatData.length; i += 4) {
      if (flatData[i + 3] === 0) {
        mrImg.data[i] = 255;
        mrImg.data[i + 1] = 255;
        mrImg.data[i + 2] = 255;
        mrImg.data[i + 3] = 255;
        emptyCount++;
      }
    }
    if (emptyCount === 0) {
      if (uiModule) uiModule.showToast('没有空白区域可扩图 — 画布已被完全覆盖。');
      return;
    }
    mrCtx.putImageData(mrImg, 0, 0);
    // 3) 向外膨胀蒙版 12px，使其覆盖一条不透明像素带 —
    //    作为模型干净融合的上下文。
    const expanded = document.createElement('canvas');
    expanded.width = state.imgWidth; expanded.height = state.imgHeight;
    const ectx = expanded.getContext('2d');
    ectx.filter = 'blur(12px)';
    ectx.drawImage(maskRaw, 0, 0);
    ectx.filter = 'none';
    const expData = ectx.getImageData(0, 0, state.imgWidth, state.imgHeight);
    for (let i = 0; i < expData.data.length; i += 4) {
      const a = expData.data[i + 3];
      const v = a > 6 ? 255 : 0;
      expData.data[i] = v;
      expData.data[i + 1] = v;
      expData.data[i + 2] = v;
      expData.data[i + 3] = v;
    }
    ectx.putImageData(expData, 0, 0);
    // 4) 用扩图蒙版临时替换激活的蒙版子图层。
    //    保存先前的蒙版以便恢复。
    const mask = ensureActiveMaskLayer();
    if (!mask) { if (uiModule) uiModule.showToast('没有激活的图层用于扩图'); return; }
    const savedMask = mask.ctx.getImageData(0, 0, mask.canvas.width, mask.canvas.height);
    mask.ctx.clearRect(0, 0, mask.canvas.width, mask.canvas.height);
    mask.ctx.drawImage(expanded, 0, 0);
    // 5) Prompt: 优先用户输入，否则使用通用填充。
    const userP = document.getElementById('ge-inpaint-prompt')?.value?.trim();
    const prompt = userP || 'seamless natural continuation of the surrounding image, photorealistic, matching style, no objects, no people, no text';
    const strength = 0.99;
    try {
      await runInpaint({
        prompt, strength,
        btnId: 'ge-inpaint-outpaint',
        labelId: 'ge-inpaint-outpaint-label',
        idleLabel: '扩图', busyLabel: '扩图中',
      });
    } finally {
      // 恢复用户之前的蒙版绘制，以便后续生成/移除操作
      // 基于用户实际绘制的内容。
      mask.ctx.clearRect(0, 0, mask.canvas.width, mask.canvas.height);
      mask.ctx.putImageData(savedMask, 0, 0);
      composite();
    }
  });
}
