/**
 * 共享 AI 工具运行器。用于 Sharpen / Harmonize / Upscale / Style /
 * Bg-Remove / 等 — 每个展平文档、将 PNG POST 到服务器端图像端点、
 * 然后将结果作为新图层放回的工具。
 *
 * 处理请求的所有编排：
 *
 *  - 按钮忙碌状态: 将标签替换为 "<动词>…" + 旋转动画，
 *    锁定宽度以免按钮视觉上跳动。
 *  - 从工具自己的选择器（或全局回退）获取端点+模型选择，
 *    以便后端知道要调用哪个模型。
 *  - 响应处理: 解码返回的 PNG，将其作为新图层推入，
 *    保存状态，合成，刷新图层面板。
 *  - 错误报告: 通过 toast 显示失败。检测"需要 img2img 服务器"
 *    和"包未安装"失败模式，并弹出操作 toast 打开 Cookbook 修复。
 *
 * @param {{
 *   flatten:                    () => HTMLCanvasElement,
 *   saveState:                  (label?: string) => void,
 *   createLayer:                (name: string, w: number, h: number) => object,
 *   composite:                  () => void,
 *   renderLayerPanel:           () => void,
 *   deriveBusyLabel:            (layerName: string) => string,
 *   getSelectedAIEndpoint:      (type: string | null) => { endpoint?: string, model?: string },
 *   openCookbookForDependency:  (pkg: string) => void,
 *   openCookbookForImg2img:     () => void,
 *   spinnerModule:              object,
 *   uiModule:                   object | null,
 * }} deps
 *
 * @returns {(endpoint: string, extraPayload: object, layerName: string, btn: HTMLButtonElement, opts?: { busyLabel?: string }) => Promise<void>}
 */
import { state } from './state.js';

const KNOWN_DEPS = ['realesrgan', 'rembg'];

export function createApplyImageTool({
  flatten, saveState, createLayer, composite, renderLayerPanel,
  deriveBusyLabel, getSelectedAIEndpoint,
  openCookbookForDependency, openCookbookForImg2img,
  spinnerModule, uiModule,
}) {
  return async function applyImageTool(endpoint, extraPayload, layerName, btn, opts) {
    const origHTML = btn.innerHTML;
    const origWidth = btn.offsetWidth;  // 锁定宽度以免按钮跳动
    btn.disabled = true;
    btn.classList.add('ge-btn-processing');
    btn.style.minWidth = origWidth + 'px';
    // 在请求运行期间将标签替换为"<动词>…"文本 + 旋转动画。
    // 当调用方未提供 busy label 时回退到从 layerName 推导。
    const busyLabel = (opts && opts.busyLabel) || deriveBusyLabel(layerName);
    btn.innerHTML = '';
    let btnSpinner = null;
    try {
      btnSpinner = spinnerModule.create('', 'clean', 'whirlpool');
      const sp = btnSpinner.createElement();
      btn.appendChild(sp);
      const txt = document.createElement('span');
      txt.className = 'ge-btn-busy-label';
      txt.textContent = busyLabel;
      btn.appendChild(txt);
      btnSpinner.start();
    } catch { btn.textContent = busyLabel; }
    // 工具级模型选择器 — 从工具级 select（harmonize/style）
    // 获取（如果可用），否则使用全局回退。从端点 URL 推导。
    if (!extraPayload._endpoint) {
      const m = /\/api\/image\/([\w-]+)/.exec(endpoint || '');
      const type = m ? m[1].replace('upscale-ai', 'upscale').replace('remove-bg', 'rembg') : null;
      const sel = getSelectedAIEndpoint(type);
      if (sel.endpoint) extraPayload._endpoint = sel.endpoint;
      if (sel.model && !extraPayload._model) extraPayload._model = sel.model;
    }
    try {
      const flatCanvas = flatten();
      const imageB64 = flatCanvas.toDataURL('image/png').split(',')[1];
      const body = { image: imageB64, ...extraPayload };
      const res = await fetch(endpoint, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let err = res.statusText;
        try { const e = await res.json(); err = e.detail || e.error || err; } catch {}
        throw new Error(err);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.image) throw new Error('未返回图像');
      const img = new Image();
      img.onload = () => {
        if (!state.editorOpen) return; // 用户在中途解码时关闭（v2 review HIGH-4）
        saveState();
        const layer = createLayer(layerName, state.imgWidth, state.imgHeight);
        layer.ctx.drawImage(img, 0, 0);
        state.layers.push(layer);
        state.activeLayerId = layer.id;
        composite();
        renderLayerPanel();
        if (uiModule) uiModule.showToast(layerName + ' 完成', 4500);
      };
      img.onerror = () => { if (uiModule) uiModule.showToast('加载结果失败', 6000); };
      img.src = 'data:image/png;base64,' + data.image;
    } catch (e) {
      // 检测已知的失败模式并弹出操作 toast。
      const msg = (e?.message || '').toLowerCase();
      const needsImg2Img = (
        msg.includes('img2img') ||
        msg.includes('diffusion server') ||
        msg.includes("doesn't expose")
      );
      let depMatch = null;
      for (const pkg of KNOWN_DEPS) {
        if (msg.includes(`${pkg} not installed`) || msg.includes(`no module named '${pkg}'`)) {
          depMatch = pkg; break;
        }
      }
      if (uiModule) {
        if (depMatch && uiModule.showToast.length >= 2) {
          uiModule.showToast(layerName + ' 失败: ' + depMatch + ' 未在服务器上安装。', {
            duration: 9000,
            action: `安装 ${depMatch}`,
            onAction: () => openCookbookForDependency(depMatch),
          });
        } else if (needsImg2Img && uiModule.showToast.length >= 2) {
          uiModule.showToast(layerName + ' 失败: ' + e.message, {
            duration: 9000,
            action: '打开 Cookbook',
            onAction: () => openCookbookForImg2img(),
          });
        } else {
          uiModule.showToast(layerName + ' 失败: ' + e.message, 6000);
        }
      }
    } finally {
      btn.disabled = false;
      btn.classList.remove('ge-btn-processing');
      try { btnSpinner?.destroy(); } catch {}
      btn.innerHTML = origHTML;
      btn.style.minWidth = '';
    }
  };
}
