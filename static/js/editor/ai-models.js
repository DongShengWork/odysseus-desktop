/**
 * AI 模型下拉加载器 — 从后端获取可用的模型端点，
 * 并填充编辑器的三个模型选择界面：
 *
 *   #ge-ai-model     — 全局生成选择器
 *   #ge-ai-inpaint   — inpaint 选择器
 *   select.ge-tool-model[data-ge-tool-model="…"]
 *                    — 工具级选择器（harmonize / upscale / style /
 *                      sharpen / 等）
 *
 * 每个模型通过一个小型能力分类器过滤，因此：
 * 生成下拉只看到文本到图像模型，inpaint 下拉只看到
 * 图像+蒙版编辑模型，工具级下拉获取所有支持 img2img 的模型。
 *
 * 每个选择器末尾都有一个"+ 在 Cookbook 中 Serve 模型…"哨兵 —
 * 选择它会打开 Cookbook → Serve 并过滤到图像模型，
 * 然后将选择器恢复到之前的值（所以它是一个操作，而非可选模型）。
 *
 * @param {{
 *   container:              HTMLElement,
 *   apiBase:                string,
 *   openCookbookForImg2img: () => void,
 * }} deps
 */
import { state } from './state.js';
import { sortModelIds } from '../modelSort.js';

// 对模型 ID + 端点名称进行启发式分类。模型可以是：
//   - gen: 文本到图像生成
//   - inpaint: 图像+蒙版编辑（inpaint / img2img）
// 某些模型只做一种（例如 dall-e-3 = 仅生成，无编辑 API）。
function modelCaps(modelId, endpointName, endpointType) {
  const id = (modelId || '').toLowerCase();
  const name = (endpointName || '').toLowerCase();
  const type = (endpointType || '').toLowerCase();
  // 拒绝明显的纯文本模型。
  const textOnly = /(?:^|[/\-_:])(gpt-?[345]|gpt-oss|claude|llama|qwen[^-]*chat|chat$|instruct$|coder)/i;
  if (textOnly.test(id) && !/image/i.test(id)) return { gen: false, inpaint: false };
  // OpenAI 图像家族。
  if (/dall-e-3/.test(id))    return { gen: true,  inpaint: false };
  if (/dall-e-2/.test(id))    return { gen: true,  inpaint: true  };
  if (/gpt-image/.test(id))   return { gen: true,  inpaint: true  };
  // Diffusion 家族 — 大多数通用 SD/SDXL/Flux 基础模型
  // 通过 diffusers 同时支持两者。
  if (/(?:^|[/\-_])(?:sd-?xl|sdxl|sd3|sd-|stable[\s-]*diffusion|flux|playground|pixart|kandinsky)/i.test(id)) {
    const isInpaintModel = /inpaint|edit|fill/i.test(id) || /inpaint|edit|fill/i.test(name);
    return { gen: !isInpaintModel || /base/i.test(id), inpaint: true };
  }
  // 自托管 diffusion 服务器：模型 ID 通常匹配仓库名称；
  // 信任端点名称提示。
  if (type === 'image') {
    if (/inpaint|edit|fill/i.test(name)) return { gen: false, inpaint: true };
    return { gen: true, inpaint: true };
  }
  if (/inpaint|edit|fill/i.test(name)) return { gen: false, inpaint: true };
  if (/diffus|flux|sd|image/i.test(name)) return { gen: true, inpaint: true };
  // 编辑器图像工具应该保守。未知的 LLM/chat 模型
  // 不应出现在图像生成或 inpaint 选择器中。
  return { gen: false, inpaint: false };
}

export function wireAIModelSelectors({ container, apiBase, openCookbookForImg2img }) {
  // "+ 在 Cookbook 中 Serve 模型…"哨兵选项的委托处理 —
  // 无论 loadAIModels 是否已重新连接各个 select，
  // 都能捕获点击，并且在后续 innerHTML 重置后仍然存活。
  container.addEventListener('change', (e) => {
    const sel = e.target.closest('select');
    if (!sel) return;
    if (sel.value !== '__serve_cookbook__') return;
    // 恢复到之前的选择，以免哨兵"卡住"。
    const prev = sel._prevServeValue ?? '';
    sel.value = prev;
    openCookbookForImg2img();
  });
  // 跟踪先前值以便哨兵触发后可以恢复。
  container.addEventListener('focus', (e) => {
    const sel = e.target.closest('select');
    if (sel && sel.value !== '__serve_cookbook__') sel._prevServeValue = sel.value;
  }, true);

  const aiGenSelect = document.getElementById('ge-ai-model');
  const aiInpaintSelect = document.getElementById('ge-ai-inpaint');
  // 全局生成模型下拉已从编辑器顶栏移除；
  // 仅当完全没有任何内容可填充时才退出（既没有生成
  // select 也没有 inpaint select 也没有任何工具级 select）。
  if (!aiGenSelect && !aiInpaintSelect &&
      !document.querySelector('select.ge-tool-model')) return;

  async function loadAIModels(opts = {}) {
    try {
      const selectBaseUrl = opts.selectBaseUrl || '';
      const prevGenValue = aiGenSelect?.value || '';
      const prevInpaintValue = aiInpaintSelect?.value || '';
      const res = await fetch(`${apiBase}/api/model-endpoints`);
      const endpoints = await res.json();
      if (aiGenSelect) aiGenSelect.innerHTML = '<option value="">无</option>';
      if (aiInpaintSelect) aiInpaintSelect.innerHTML = '<option value="">自动</option>';
      const perToolSelects = Array.from(document.querySelectorAll('select.ge-tool-model'));
      for (const ts of perToolSelects) ts.innerHTML = '<option value="">自动</option>';
      let firstGen = null;
      let firstInpaint = null;
      let selectedGen = null;
      let selectedInpaint = null;
      for (const ep of endpoints) {
        if (!ep.is_enabled) continue;
        const hasListedModels = Array.isArray(ep.models) && ep.models.length;
        const models = hasListedModels ? sortModelIds(ep.models) : [''];
        const isImageEndpoint = (ep.model_type || '').toLowerCase() === 'image';
        // 图像/inpaint 端点即使其 /models 缓存仍为空
        // 也可以通过 URL 调用，所以不要让刚 Serve 的
        // Cookbook 模型在编辑器选择器中显示为"(离线)"。
        const epUsable = !!ep.online || isImageEndpoint;
        for (const modelId of models) {
          const caps = modelCaps(modelId || ep.name, ep.name, ep.model_type);
          if (!caps.gen && !caps.inpaint) continue;
          // 编码 "<base_url>::<model_id>" 以便值携带两部分信息。
          const value = `${ep.base_url}::${modelId}`;
          const shortModel = modelId ? String(modelId).split('/').pop() : (ep.name || ep.base_url);
          const epHint = modelId && ep.name && ep.name !== modelId ? ` · ${ep.name}` : '';
          const label = `${shortModel}${epHint}${epUsable ? '' : ' (离线)'}`;
          if (caps.gen && aiGenSelect) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            opt.disabled = !epUsable;
            aiGenSelect.appendChild(opt);
            if (epUsable && !firstGen) firstGen = value;
            if (epUsable && selectBaseUrl && ep.base_url === selectBaseUrl && !selectedGen) selectedGen = value;
          }
          if (caps.inpaint && aiInpaintSelect) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            opt.disabled = !epUsable;
            aiInpaintSelect.appendChild(opt);
            if (epUsable && selectBaseUrl && ep.base_url === selectBaseUrl && !selectedInpaint) selectedInpaint = value;
            // 优先选择专用的 inpaint/edit 模型作为默认选项。
            if (epUsable && !firstInpaint && (!modelId || /inpaint|edit|fill|gpt-image/i.test(modelId) || /inpaint|edit|fill/i.test(ep.name || ''))) {
              firstInpaint = value;
            }
          }
          // 工具级选择器获取所有支持 img2img 的条目。
          // 同时具有 caps.inpaint 和 caps.gen 的模型
          // 都适用于 harmonize / style / upscale
          // （任何可以做 img2img 的都可以）。
          if (caps.inpaint || caps.gen) {
            for (const ts of perToolSelects) {
              const opt = document.createElement('option');
              opt.value = value;
              opt.textContent = label;
              opt.disabled = !epUsable;
              ts.appendChild(opt);
            }
          }
        }
      }
      const hasValue = (sel, value) => !!value && [...sel.options].some(o => o.value === value);
      if (aiGenSelect) {
        if (selectedGen) aiGenSelect.value = selectedGen;
        else if (hasValue(aiGenSelect, prevGenValue)) aiGenSelect.value = prevGenValue;
        else if (firstGen) aiGenSelect.value = firstGen;
      }
      if (aiInpaintSelect) {
        if (selectedInpaint) aiInpaintSelect.value = selectedInpaint;
        else if (hasValue(aiInpaintSelect, prevInpaintValue)) aiInpaintSelect.value = prevInpaintValue;
        else if (firstInpaint) aiInpaintSelect.value = firstInpaint;
      }
      // 在每个模型下拉底部追加"+ 在 Cookbook 中 Serve 模型…"哨兵。
      const appendServeSentinel = (sel) => {
        const sep = document.createElement('option');
        sep.disabled = true;
        sep.textContent = '──────────';
        sel.appendChild(sep);
        const serveOpt = document.createElement('option');
        serveOpt.value = '__serve_cookbook__';
        serveOpt.textContent = '+ 在 Cookbook 中 Serve 模型…';
        sel.appendChild(serveOpt);
      };
      for (const ts of perToolSelects) appendServeSentinel(ts);
      if (aiGenSelect) appendServeSentinel(aiGenSelect);
      if (aiInpaintSelect) appendServeSentinel(aiInpaintSelect);
      // 同样在生成 + Inpaint select 上连接哨兵。
      const wireServeSentinel = (sel) => {
        if (!sel) return;
        let prev = sel.value;
        sel.addEventListener('change', () => {
          if (sel.value === '__serve_cookbook__') {
            sel.value = prev;
            openCookbookForImg2img();
            return;
          }
          prev = sel.value;
        });
      };
      wireServeSentinel(aiGenSelect);
      wireServeSentinel(aiInpaintSelect);
      // 从 localStorage 恢复每个工具级选择。
      for (const ts of perToolSelects) {
        const key = 'ge-tool-model-' + ts.dataset.geToolModel;
        try {
          const saved = localStorage.getItem(key);
          if (saved && [...ts.options].some(o => o.value === saved)) {
            ts.value = saved;
          }
        } catch {}
        let prevValue = ts.value;
        ts.addEventListener('change', () => {
          if (ts.value === '__serve_cookbook__') {
            ts.value = prevValue;
            openCookbookForImg2img();
            return;
          }
          prevValue = ts.value;
          try { localStorage.setItem(key, ts.value); } catch {}
        });
      }
    } catch (e) {
      // 获取失败 — 仍然给用户设置模型的入口。
      // 否则下拉只显示"自动"，没有任何下一步提示。
      const fallback = '<option value="">自动</option><option value="" disabled>──────────</option><option value="__serve_cookbook__">+ 在 Cookbook 中 Serve 模型…</option>';
      if (aiGenSelect) aiGenSelect.innerHTML = fallback;
      if (aiInpaintSelect) aiInpaintSelect.innerHTML = fallback;
      document.querySelectorAll('select.ge-tool-model').forEach(ts => { ts.innerHTML = fallback; });
      const wireServe = (sel) => {
        if (!sel) return;
        let prev = sel.value;
        sel.addEventListener('change', () => {
          if (sel.value === '__serve_cookbook__') {
            sel.value = prev;
            openCookbookForImg2img();
            return;
          }
          prev = sel.value;
        });
      };
      wireServe(aiGenSelect);
      wireServe(aiInpaintSelect);
      document.querySelectorAll('select.ge-tool-model').forEach(wireServe);
    }
  }
  loadAIModels();
  const onModelEndpointsUpdated = (e) => {
    if (!container.isConnected) {
      window.removeEventListener('ge:model-endpoints-updated', onModelEndpointsUpdated);
      return;
    }
    loadAIModels({ selectBaseUrl: e.detail?.baseUrl || '' });
  };
  window.addEventListener('ge:model-endpoints-updated', onModelEndpointsUpdated);
  // 当用户打开 inpaint 下拉时重新获取模型列表，
  // 以便通过 Cookbook Serve 的模型在编辑中就能显示，
  // 无需关闭并重新打开编辑器。节流为每 3 秒刷新一次，
  // 以免快速开关对端点造成压力。重新加载期间保留当前选择。
  let _lastModelRefresh = 0;
  const refreshOnOpen = (e) => {
    const sel = e.target.closest('#ge-ai-inpaint, select.ge-tool-model');
    if (!sel) return;
    const now = Date.now();
    if (now - _lastModelRefresh < 3000) return;
    _lastModelRefresh = now;
    const keep = sel.value;
    loadAIModels().then(() => {
      // 如果先前选择仍然存在则恢复。
      if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
    });
  };
  container.addEventListener('mousedown', refreshOnOpen, true);
}
