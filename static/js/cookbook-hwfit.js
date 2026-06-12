// ============================================

// COOKBOOK HWFIT 子模块

// "What Fits?" 硬件模型适配 UI

// ============================================



import {

  _envState,

  _persistEnvState,

  esc,

  modelLogo,

  _detectBackend,

  _runModelDownload,

  _runPanelCmd,

  _buildDownloadCmd,

  _addTask,

  _renderRunningTab,

  _detectToolParser,

  _lastCacheHost,

  _setLastCacheHost,

  _serverByVal,

  _serverKey,

  _currentServerValue,

  _shellQuote,

  _MODELDIR_CHECK_ON,

  _MODELDIR_CHECK_OFF,

  _serverEntryHtml,

  _copyText,

  // 导入 cookbook.js 时不带 ?v= 查询参数 —— 与其他所有导入者使用相同的纯说明符。

  // 查询参数不匹配会导致 cookbook.js 作为两个独立模块加载两次（两个 _envState 对象），

  // 这会静默地将下载发送到错误的服务器。

} from './cookbook.js';

import uiModule from './ui.js';

import spinnerModule from './spinner.js';
import { t } from './i18n.js';



// ── What Fits?（硬件模型适配）──



export let _hwfitCache = null;

export let _hwfitDebounce = null;

export let _cachedModelIds = null; // 已下载的仓库 ID 列表

// 每次 _hwfitFetch 调用时递增；慢速扫描（远程 SSH 探测可能需要约 10 秒）

// 在渲染前检查此值，以防止用户切换服务器后过时的响应覆盖较新的响应。

let _hwfitFetchToken = 0;

let _dismissedHwChips = new Set();

// 永久删除（点击 X 关闭）的芯片。与 _dismissedHwChips 分开，

// 这样排序器将"关闭"和"删除"视为相同（都忽略硬件），但 UI 保持"关闭"芯片可见以便重新开启，

// 而"删除"的芯片在下一次重新扫描前完全不渲染。

let _removedHwChips = new Set();



export let _gpuToggleTotal = 0; // 来自首次扫描的真实 GPU 数量，永不被覆盖



function _firstGgufSource(model) {

  const sources = Array.isArray(model?.gguf_sources) ? model.gguf_sources : [];

  return sources.find(src => src && src.repo) || null;

}



function _looksLikeGgufRepo(model) {

  const haystack = `${model?.quant_repo || ''} ${model?.repo_id || ''} ${model?.path || ''} ${model?.name || ''}`.toLowerCase();

  return !!model?.is_gguf || haystack.includes('gguf') || haystack.includes('.gguf');

}



function _downloadSourceRepo(model, backend) {

  if (backend === 'llamacpp') {

    const ggufSource = _firstGgufSource(model);

    if (ggufSource) return { repo: ggufSource.repo, kind: 'GGUF' };

    if (_looksLikeGgufRepo(model)) {

      const repo = model?.quant_repo || model?.repo_id || model?.name;

      if (repo) return { repo, kind: 'GGUF' };

    }

  }

  return { repo: model?.quant_repo || model?.name || '', kind: '' };

}



// 重置 GPU 切换状态，使下一次扫描为（可能不同的）服务器重新渲染 RAM/GPU 按钮，

// 不清除现有标记——清除会使按钮闪烁消失再出现。旧按钮保持可见，直到

// 新扫描返回并替换它们。位于此处（而非 cookbook.js）因为 _gpuToggleTotal 是

// 模块局部绑定，无法被导入者重新赋值。

export function _resetGpuToggleState(clearDismissed = true) {

  if (clearDismissed) {

    _dismissedHwChips = new Set();

    _removedHwChips = new Set();

  }

  const tc = document.getElementById('hwfit-gpu-toggles');

  if (tc) {

    tc._originalSystem = null;

    tc._activeCount = undefined;

    tc._activeGroup = undefined;

    tc._groups = null;

    tc._builtGroup = undefined;

    delete tc.dataset.rendered;

  }

  _gpuToggleTotal = 0;

}



// 裁剪供应商前缀，使池标签显示为 "RTX 4090 D" 而非 "NVIDIA GeForce RTX 4090 D"。

function _shortGpuName(name) {

  return String(name || 'GPU')

    .replace(/^NVIDIA\s+GeForce\s+/i, '')

    .replace(/^NVIDIA\s+/i, '')

    .replace(/^AMD\s+(Radeon\s+)?/i, '')

    .trim() || 'GPU';

}



// 2 的幂次直到池大小，加上确切的池大小——这些是唯一安全的 vLLM

// --tensor-parallel-size 值（TP 必须整除 GPU 数量和模型的注意力头数）。

// 绝不提供我们实际无法服务的数量。

function _validTpCounts(poolSize) {

  const out = [1, 2, 4, 8, 16].filter(n => n <= poolSize);

  if (poolSize > 0 && !out.includes(poolSize)) out.push(poolSize);

  return out;

}



export function _renderGpuToggles(system) {

  const container = document.getElementById('hwfit-gpu-toggles');

  if (!container) return;

  const groups = Array.isArray(system.gpu_groups) ? system.gpu_groups : [];

  // 跨刷新稳定的 GPU 总数。路由在锁定活动池后将 system.gpu_count 缩小为

  // 活动池大小，因此从（不可变的）组列表或原始检测中获取总数，

  // 绝不从可能被覆盖的计数中获取。

  const total = system.detected_gpu_count

    || (groups.length ? groups.reduce((s, g) => s + (g.count || 0), 0) : (system.gpu_count || 0));

  if (total <= 0 && !system.has_gpu) {

    container.innerHTML = '';

    container._groups = null;

    _gpuToggleTotal = 0;

    return;

  }

  if (!_gpuToggleTotal) _gpuToggleTotal = total;



  container._groups = groups;

  if (container._activeGroup === undefined) container._activeGroup = 0;  // auto = largest pool

  const heterogeneous = groups.length > 1;



  // 仅在硬件配置改变或选定池改变时重新构建（计数按钮是池特定的）。

  // 否则重新扫描会导致闪烁。

  const sig = `${total}|${groups.map(g => g.count + ':' + g.vram_each).join(',')}`;

  if (container.dataset.rendered === sig && container._builtGroup === container._activeGroup) return;

  container.dataset.rendered = sig;

  container._builtGroup = container._activeGroup;



  const grp = groups[container._activeGroup] || groups[0]

    || { count: total, vram_each: 0, name: system.gpu_name || 'GPU' };

  const poolSize = grp.count || total;



  let html = '';

  if (heterogeneous) {

    html += `<select class="hwfit-gpu-group" id="hwfit-gpu-group" title="${t('cookbook.gpu_pool_title')}">`;

    groups.forEach((g, i) => {

      const lbl = `${g.count}× ${_shortGpuName(g.name)} (${Math.round(g.vram_total)} GB)`;

      html += `<option value="${i}"${i === container._activeGroup ? ' selected' : ''}>${esc(lbl)}</option>`;

    });

    html += '</select>';

  }

  const validCounts = _validTpCounts(poolSize);

  const maxGpu = validCounts.length ? validCounts[validCounts.length - 1] : 0;

  // 在初始渲染时将数据层提交到 maxGpu，使其与视觉高亮匹配。

  // 在此之前，_activeCount 保持为 undefined → 不发送 gpu_count 参数 →

  // 后端的回退可能基于 RAM 排序混合资源机器（"最紧张"按 RAM 而非 GPU 排序）。

  if (container._activeCount === undefined && validCounts.length) {

    container._activeCount = maxGpu;

  }

  html += `<button class="hwfit-gpu-btn" data-count="0" title="${t('cookbook.cpu_ram_only')}">RAM</button>`;

  const hasExplicitCount = typeof container._activeCount === 'number';

  for (const n of validCounts) {

    const text = n === 1 ? 'GPU' : n + ' GPU';

    const isActive = hasExplicitCount && n === container._activeCount;

    html += `<button class="hwfit-gpu-btn${isActive ? ' active' : ''}" data-count="${n}" title="${t('cookbook.gpu_count_hint', { n: n, n_plural: n > 1 ? 's' : '' })}">${text}</button>`;

  }

  // 当用户明确选择 RAM (0) 时，也将 RAM 按钮标记为活动状态

  // —— 上面的循环仅处理 GPU 按钮。

  if (container._activeCount === 0) {

    const ramBtn = container.querySelector('.hwfit-gpu-btn[data-count="0"]');

    // （我们刚设置了 innerHTML，因此在赋值后下面重新标记）

  }

  container.innerHTML = html;

  if (container._activeCount === 0) {

    const ramBtn = container.querySelector('.hwfit-gpu-btn[data-count="0"]');

    if (ramBtn) ramBtn.classList.add('active');

  }



  // 池下拉选择：切换池，将计数重置为新池的最大值，重新构建。

  const sel = container.querySelector('#hwfit-gpu-group');

  if (sel) {

    sel.addEventListener('change', () => {

      container._activeGroup = parseInt(sel.value) || 0;

      container._activeCount = undefined;   // default to the new pool's max

      delete container.dataset.rendered;    // force a count-button rebuild

      _renderGpuToggles(system);

      _hwfitCache = null;

      _hwfitFetch();

    });

  }



  if (!container._gpuBound) {

    container._gpuBound = true;

    container.addEventListener('click', (e) => {

      const btn = e.target.closest('.hwfit-gpu-btn');

      if (!btn) return;

      const count = parseInt(btn.dataset.count);

      const wasActive = btn.classList.contains('active') && container._activeCount === count;

      container.querySelectorAll('.hwfit-gpu-btn').forEach(b => b.classList.remove('active'));

      if (wasActive) {

        container._activeCount = null;

      } else {

        btn.classList.add('active');

        container._activeCount = count;

        // 基于硬件选择自动建议量化级别——但仅当用户已经选择了特定量化级别时。

        // 当用户在"All"（value === ""）时，保持 All：切换 GPU 不应静默地

        // 将他们从期望的 All 视图中拉出。

        const quantSel = document.getElementById('hwfit-quant');

        if (quantSel && quantSel.value !== '') {

          if (count <= 1) {

            quantSel.value = 'Q4_K_M'; // RAM 或 1 GPU → Q4 最佳点

          } else if (String(system?.backend || '').toLowerCase() === 'rocm') {

            quantSel.value = 'Q4_K_M'; // ROCm 默认保持 GGUF/本地安全；AWQ 仅显式启用

          } else {

            quantSel.value = 'AWQ-4bit'; // 多 GPU → AWQ for vLLM

          }

        }

      }

      _hwfitCache = null;

      _hwfitFetch();

    });

  }

}



// --- 扫描持久化（页面重新加载后仍存在）----------------------------

// 后端按主机缓存硬件检测结果（约 30 分钟），但服务重启后该缓存会丢失，

// 重新加载时仍会显示加载动画。将最后一次成功的 /models 结果按参数签名

// 缓存到 localStorage，以便重新加载时立即显示，然后在后台刷新并替换。

const _SCAN_CACHE_KEY = 'hwfit_scan_cache_v1';

const _MANUAL_HW_KEY = 'hwfit_manual_hardware_v1';

const _CTX_KEY = 'hwfit_target_context_v1';

const _CTX_PRESETS = [8192, 16384, 32768, 50000, 131072, 0]; // 0 = model max

const _SCAN_CACHE_MAX = 12;            // 保留最新的 N 个签名

const _SCAN_CACHE_TTL = 6 * 3600 * 1000; // 6 小时——硬件很少变化



// Ctx 滑块辅助函数（从 origin/main 移植）。滑块选择 _CTX_PRESETS 中的索引；

// _ctxValue() 将其解析为 token 数量（0 = "Max"）。滑块旁边的标签

// 重新渲染为 "8k" / "16k" / … / "Max"。

function _ctxLabel(value) {

  const n = Number(value) || 0;

  if (!n) return t('cookbook.max');

  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);

}



function _ctxValue() {

  const slider = document.getElementById('hwfit-context');

  const idx = Math.max(0, Math.min(_CTX_PRESETS.length - 1, Number(slider?.value ?? 3) || 0));

  return _CTX_PRESETS[idx] || 0;

}



function _syncCtxControl() {

  const slider = document.getElementById('hwfit-context');

  const label = document.getElementById('hwfit-context-label');

  if (!slider) return;

  const saved = localStorage.getItem(_CTX_KEY);

  const savedIdx = saved == null ? 3 : _CTX_PRESETS.indexOf(Number(saved));

  slider.value = String(savedIdx >= 0 ? savedIdx : 3);

  if (label) label.textContent = _ctxLabel(_ctxValue());

}



function _manualHwState() {

  try {

    const s = JSON.parse(localStorage.getItem(_MANUAL_HW_KEY) || '{}');

    if (s && (s.mode === 'gpu' || s.mode === 'ram')) return s;

  } catch {}

  return null;

}



function _saveManualHwState(s) {

  try {

    if (!s || !s.mode) localStorage.removeItem(_MANUAL_HW_KEY);

    else localStorage.setItem(_MANUAL_HW_KEY, JSON.stringify(s));

  } catch {}

}



function _manualHwParams() {

  const s = _manualHwState();

  if (!s) return {};

  return {

    manual_mode: s.mode,

    manual_gpu_count: s.mode === 'gpu' ? String(s.gpuCount || 1) : '',

    manual_vram_gb: s.mode === 'gpu' ? String(s.vramGb || 8) : '',

    manual_ram_gb: s.ramGb ? String(s.ramGb) : '',

    manual_backend: s.mode === 'gpu' ? (s.backend || 'cuda') : '',

  };

}



function _manualNumber(value, fallback) {

  const raw = String(value || '').replace(',', '.');

  const match = raw.match(/-?\d+(?:\.\d+)?/);

  if (!match) return fallback;

  const n = Number(match[0]);

  return Number.isFinite(n) && n > 0 ? n : fallback;

}



function _manualOptionalNumber(value) {

  const raw = String(value || '').replace(',', '.');

  const match = raw.match(/-?\d+(?:\.\d+)?/);

  if (!match) return null;

  const n = Number(match[0]);

  return Number.isFinite(n) && n > 0 ? n : null;

}



function _manualHwLabel(s) {

  if (!s) return '';

  // 手动模式是一个"假设"模拟器——值替换检测到的硬件（匹配服务器端

  // _apply_manual_hardware）。标签措辞为纯 "X GB" 而非累加的 "+X GB"，

  // 以便用户看到模拟的总计，而不是加法。

  const ram = s.ramGb ? t('cookbook.manual_ram_suffix', { ram: s.ramGb }) : '';

  if (s.mode === 'ram') return t('cookbook.manual_ram_only', { ram: s.ramGb || 0 });

  const gpuCount = s.gpuCount || 1;
  const gpus = t('cookbook.gpu_count_hint', { n: gpuCount, n_plural: gpuCount === 1 ? '' : 's' });

  return t('cookbook.manual_gpu', { gpus: gpus, vram: s.vramGb || 8, ram: ram });

}



function _manualDisplaySystem(sys, manual) {

  const base = { ...(sys || {}) };

  if (!manual) return base;

  base.manual_hardware = true;

  // 用手动总数替换检测到的 RAM。之前这是叠加在检测值之上，

  // 这 (a) 与新的服务器端"替换"行为相矛盾，(b) 使芯片显示的总量

  // 与实际排序所用的值不匹配。

  if (manual.ramGb) {

    base.available_ram_gb = Number(manual.ramGb);

    base.total_ram_gb = Number(manual.ramGb);

  }

  if (manual.mode === 'ram') {

    // 仅 RAM 模拟——清除 GPU 端，使芯片显示与服务器排序所用的内容匹配

    //（仅 CPU/RAM 路径）。

    base.has_gpu = false;

    base.gpu_name = null;

    base.gpu_vram_gb = 0;

    base.gpu_count = 0;

    return base;

  }

  if (manual.mode !== 'ram') {

    const count = Number(manual.gpuCount || 1);

    const vram = Number(manual.vramGb || 8);

    const backend = (manual.backend || 'cuda').toUpperCase();

    base.gpu_name = t('cookbook.simulated_gpu', { backend: backend }) + (count > 1 ? ` × ${count}` : '');

    base.gpu_vram_gb = Math.round(vram * count * 10) / 10;

    base.gpu_count = count;

    base.backend = manual.backend || 'cuda';

  }

  return base;

}



// 影响结果列表的所有内容的签名，确保我们永远不会在不匹配的筛选器下渲染缓存列表。

function _scanSig() {

  const sortEl = document.getElementById('hwfit-sort');

  const tc = document.getElementById('hwfit-gpu-toggles');

  return JSON.stringify({

    h: _envState.remoteHost || '',

    hk: _currentServerValue(),

    u: document.getElementById('hwfit-usecase')?.value || '',

    s: document.getElementById('hwfit-search')?.value?.trim() || '',

    o: sortEl?.value || 'score',

    r: sortEl?.dataset.reverse === '1' ? 1 : 0,

    q: document.getElementById('hwfit-quant')?.value || '',

    c: _ctxValue(),

    g: (tc && typeof tc._activeCount === 'number') ? String(tc._activeCount) : '',

    gg: (tc && tc._activeGroup) ? String(tc._activeGroup) : '',

    m: _manualHwParams(),

    d: Array.from(_dismissedHwChips).sort(),

  });

}



function _readScanCache(sig) {

  try {

    const all = JSON.parse(localStorage.getItem(_SCAN_CACHE_KEY) || '{}');

    const e = all[sig];

    if (e && (Date.now() - e.ts) < _SCAN_CACHE_TTL) return e.data;

  } catch {}

  return null;

}



function _writeScanCache(sig, data) {

  try {

    const all = JSON.parse(localStorage.getItem(_SCAN_CACHE_KEY) || '{}');

    all[sig] = { ts: Date.now(), data: { system: data.system, models: data.models } };

    const keys = Object.keys(all);

    if (keys.length > _SCAN_CACHE_MAX) {

      keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));

      for (const k of keys.slice(0, keys.length - _SCAN_CACHE_MAX)) delete all[k];

    }

    localStorage.setItem(_SCAN_CACHE_KEY, JSON.stringify(all));

  } catch {}

}



// 在模型列表中渲染一个清晰的扫描失败卡片：哪个服务器失败，底层原因（简要），

// 以及一个强制重新探测的 Retry 按钮。用于后端报告的错误（SSH/探测失败）和网络故障，

// 而不是直接转储原始单行消息。

function _hwfitShowError(list, host, detail) {

  if (!list) return;

  const where = host ? esc(host) : 'this machine';

  const div = document.createElement('div');

  div.className = 'hwfit-loading';

  div.style.cssText = 'flex-direction:column;gap:8px;text-align:center;';

  div.innerHTML =

    `<div style="color:var(--red);font-weight:600;">${t('cookbook.couldnt_scan', { host: where })}</div>`

    + (detail ? `<div style="opacity:0.6;font-size:11px;max-width:340px;line-height:1.4;">${esc(detail)}</div>` : '')

    + `<button type="button" class="hwfit-gpu-btn" id="hwfit-retry" style="margin-top:2px;height:26px;">${t('cookbook.retry')}</button>`;

  list.innerHTML = '';

  list.appendChild(div);

  const rb = div.querySelector('#hwfit-retry');

  if (rb) rb.addEventListener('click', () => { _resetGpuToggleState(); _hwfitFetch(true); });

}



// 客户端"引擎"筛选器（llama.cpp / vLLM / SGLang / Ollama）。空 = 显示全部。

// 使用 serve 命令使用的同一个 _detectBackend()，因此你筛选到的正是将会启动的内容。

// 纯视图筛选器——无需重新获取。Ollama 行合并到主列表中（参见下方的 _ensureOllamaLib +

// _ollamaToHwfitRows），因此筛选器统一处理所有引擎。

function _applyEngineFilter(models) {

  const want = document.getElementById('hwfit-engine')?.value || '';

  if (!want || !Array.isArray(models)) return models || [];

  return models.filter(m => {

    try { return _detectBackend(m).backend === want; } catch { return true; }

  });

}



// Ollama 库缓存（每页）。在首次 _hwfitFetch 时延迟填充；原始列表与

// /api/cookbook/ollama/library 返回的格式相同，然后转换为每个标签的 hwfit 行，

// 以便它们能插入到与 HF 扫描结果并排的主列表网格中。

let _ollamaLibCache = null;

async function _ensureOllamaLib() {

  if (_ollamaLibCache) return _ollamaLibCache;

  try {

    const res = await fetch('/api/cookbook/ollama/library');

    const data = await res.json();

    _ollamaLibCache = Array.isArray(data?.models) ? data.models : [];

  } catch { _ollamaLibCache = []; }

  return _ollamaLibCache;

}



// 将 Ollama 库条目的大小转换为每个标签的 hwfit 行。格式与 _hwfitRenderList 期望的

// 匹配（fit_level, parameter_count, required_gb, score, …），因此行与 HF 结果渲染相同。

function _olParseSize(s) {

  // "14b" → 14, "1.5b" → 1.5, "8x7b" → 56（粗略）, "135m" → 0.135, "latest" → null

  if (!s) return null;

  const low = s.toLowerCase();

  let m = low.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)b$/);

  if (m) return parseFloat(m[1]) * parseFloat(m[2]);

  m = low.match(/^(\d+(?:\.\d+)?)b$/);

  if (m) return parseFloat(m[1]);

  m = low.match(/^(\d+(?:\.\d+)?)m$/);

  if (m) return parseFloat(m[1]) / 1000;

  return null;

}

function _ollamaToHwfitRows(libModels, vramAvail, ramAvail) {

  const out = [];

  if (!Array.isArray(libModels)) return out;

  for (const m of libModels) {

    const sizes = (Array.isArray(m.sizes) && m.sizes.length) ? m.sizes : ['latest'];

    for (const sz of sizes) {

      const params = _olParseSize(sz);

      // Ollama 默认 GGUF 约为 Q4_K_M。粗略 VRAM 估算：每 B 参数 0.6 GB。

      const vramGb = params ? params * 0.6 : 0;

      let fitLevel = 'no_fit';

      if (vramGb && vramAvail) {

        if (vramGb <= vramAvail * 0.6) fitLevel = 'perfect';

        else if (vramGb <= vramAvail) fitLevel = 'good';

        else if (ramAvail && vramGb <= ramAvail) fitLevel = 'marginal';

        else fitLevel = 'too_tight';

      } else if (vramGb && ramAvail && vramGb <= ramAvail) {

        fitLevel = 'marginal';

      }

      const tag = `${m.name}:${sz}`;

      const paramsLabel = params

        ? (params >= 1 ? params.toFixed(params >= 10 ? 0 : 1) + 'B' : (params * 1000).toFixed(0) + 'M')

        : '?';

      // 一个适度的分数，使 Ollama 行在默认分数视图下仍能合理排序——

      // 较大的模型获得稍高的基础分数，但它们始终低于评分良好的 HF 结果。

      // 按适配度或 VRAM 排序可以将它们更突出地显示。

      const score = params ? Math.min(30 + params * 0.3, 60) : 25;

      out.push({

        name: tag,

        repo_id: tag,

        quant: 'Q4_K_M',

        parameter_count: paramsLabel,

        params_b: params || 0,

        required_gb: vramGb,

        fit_level: fitLevel,

        score,

        speed_tps: 0,

        context: 0,

        is_gguf: true,

        backend: 'ollama',

        _isOllama: true,

        _olName: m.name,

        _olSize: sz,

        _description: m.description || '',

      });

    }

  }

  return out;

}



export async function _hwfitFetch(fresh = false) {

  const _tk = ++_hwfitFetchToken;

  const useCase = document.getElementById('hwfit-usecase')?.value || '';

  const search = document.getElementById('hwfit-search')?.value?.trim() || '';

  const remoteHost = _envState.remoteHost || '';

  const list = document.getElementById('hwfit-list');

  const hw = document.getElementById('hwfit-hw');

  if (!list) return;

  const hasManualOrDismissed = !!_manualHwState() || _dismissedHwChips.size > 0;

  if (hasManualOrDismissed) fresh = true;

  // 从持久化缓存中立即渲染（强制重新扫描时跳过），因此重新加载时显示最后的结果无需加载动画。

  // 我们仍会在下方重新获取并替换。如果没有缓存命中，则回退到加载动画。

  const _sig = _scanSig();

  const _cached = fresh ? null : _readScanCache(_sig);

  const wp = spinnerModule.createWhirlpool(18);

  if (_cached) {

    _hwfitCache = _cached;

    _hwfitRenderHw(hw, _cached.system);

    if (!remoteHost && _cached.system && _cached.system.platform) {

      _envState.platform = _cached.system.platform;

    }

    _hwfitRenderList(list, _applyEngineFilter(_cached.models));

  } else {

    // 扫描时显示加载动画——将加载动画堆叠在文本标签上方

    //（.hwfit-loading 类是居中的水平 flex 布局，所以这里强制使用列布局）。

    const loadingDiv = document.createElement('div');

    loadingDiv.className = 'hwfit-loading';

    loadingDiv.style.flexDirection = 'column';

    loadingDiv.style.gap = '6px';

    loadingDiv.appendChild(wp.element);

    // 与其他 cookbook 标签页一样的文本标签："Loading…"，然后如果扫描运行时间较长

    //（远程 SSH 硬件探测），切换到 "Scanning hardware…"。

    const loadingLbl = document.createElement('div');

    loadingLbl.textContent = t('common.loading');

    loadingLbl.style.cssText = 'text-align:center;opacity:0.5;font-size:11px;';

    loadingDiv.appendChild(loadingLbl);

    setTimeout(() => { if (loadingLbl.isConnected) loadingLbl.textContent = t('cookbook.scanning_hardware'); }, 2000);

    list.innerHTML = '';

    list.appendChild(loadingDiv);

    _hwfitCache = null;   // 无即时渲染——清空直到 fetch 返回

  }

  // 仅在服务器变更时获取已缓存模型 ID，而不是每次搜索/排序时

  const remoteKey = _currentServerValue();

  if (!_cachedModelIds || _lastCacheHost() !== remoteKey) {

    _setLastCacheHost(remoteKey);

    const _cacheSrv = _serverByVal(_envState.remoteServerKey || remoteHost);

    const _cachePort = _cacheSrv?.port || '';

    const _cacheParams = new URLSearchParams();

    if (remoteHost) {

      _cacheParams.set('host', remoteHost);

      if (_cachePort) _cacheParams.set('ssh_port', _cachePort);

      if (_cacheSrv?.platform) _cacheParams.set('platform', _cacheSrv.platform);

    }

    fetch(`/api/model/cached?${_cacheParams}`, { credentials: 'same-origin' })

      .then(r => r.json())

      .then(d => {

        // 排除停滞（download-shell）条目——一个仅有 12 KB README 的文件夹

        // 不应在扫描/下载列表中计入"已下载"。

        _cachedModelIds = new Set((d.models || []).filter(m => m.status !== 'stalled').map(m => m.repo_id));

        // 如果已渲染则重新标记行

        list.querySelectorAll('.hwfit-row[data-model]').forEach(row => {

          const name = row.dataset.model;

          if (_cachedModelIds.has(name) || [..._cachedModelIds].some(id => id.endsWith('/' + name?.split('/').pop()))) {

            const nameEl = row.querySelector('.hwfit-name');

            if (nameEl && !nameEl.querySelector('.hwfit-dl-dot')) {

              nameEl.insertAdjacentHTML('beforeend', '<span class="hwfit-dl-dot" title="Downloaded">\u25CF</span>');

            }

          }

        });

      }).catch(() => {});

  }

  try {

    const sortBy = document.getElementById('hwfit-sort')?.value || 'score';

    const quantPref = document.getElementById('hwfit-quant')?.value || '';

    const targetCtx = _ctxValue();

    // 从切换控件获取活动的 GPU 计数

    const toggleContainer = document.getElementById('hwfit-gpu-toggles');

    let gpuCountOverride = '';

    if (!hasManualOrDismissed && toggleContainer && typeof toggleContainer._activeCount === 'number') {

      gpuCountOverride = String(toggleContainer._activeCount);

    }

    // 针对哪个同质 GPU 池进行排序（仅异构机器）。

    let gpuGroupOverride = '';

    if (!hasManualOrDismissed && toggleContainer && toggleContainer._activeGroup) {

      gpuGroupOverride = String(toggleContainer._activeGroup);

    }

    const params = new URLSearchParams({ limit: '80', sort: sortBy });

    if (fresh) params.set('fresh', '1');   // 绕过硬件扫描缓存

    if (search) params.set('search', search);

    if (remoteHost) {

      params.set('host', remoteHost);

      const _srv = _serverByVal(_envState.remoteServerKey || remoteHost);

      const _hp = _srv?.port || '';

      if (_hp) params.set('ssh_port', _hp);

      if (_srv?.platform) params.set('platform', _srv.platform);

    }

    if (gpuCountOverride !== '') params.set('gpu_count', gpuCountOverride);

    if (gpuGroupOverride !== '') params.set('gpu_group', gpuGroupOverride);

    if (_dismissedHwChips.has('gpu') || _dismissedHwChips.has('vram')) params.set('ignore_detected_gpu', 'true');

    if (_dismissedHwChips.has('ram')) params.set('ignore_detected_ram', 'true');

    const manualParams = _manualHwParams();

    Object.entries(manualParams).forEach(([k, v]) => {

      if (v !== '') params.set(k, v);

    });

    if (hasManualOrDismissed) params.set('_hw_override_ts', String(Date.now()));

    // 图片模型使用单独的注册表/端点

    const isImageMode = useCase === 'image_gen';

    if (!isImageMode) {

      if (useCase) params.set('use_case', useCase);

      if (quantPref) params.set('quant', quantPref);

      if (targetCtx) params.set('ctx', String(targetCtx));

      // 仅适配筛选器——由 Fit 列标题中的小圆点设置。

      const _fitOnly = (() => { try { return localStorage.getItem('hwfit_fit_only_v1') === '1'; } catch { return false; } })();

      if (_fitOnly) params.set('fit_only', '1');

    }

    const endpoint = isImageMode ? `/api/hwfit/image-models?${params}` : `/api/hwfit/models?${params}`;

    const res = await fetch(endpoint);

    // 有较新的扫描在此次进行中启动（用户在探测中途切换了服务器）——

    // 丢弃此过时响应，以免覆盖新的响应。

    if (_tk !== _hwfitFetchToken) { try { wp.destroy(); } catch {} return; }

    if (!res.ok) {

      const body = await res.text().catch(() => '');

      let msg = '';

      try {

        const payload = JSON.parse(body);

        msg = payload && (payload.detail || payload.error || payload.message);

      } catch {

        msg = body;

      }

      msg = typeof msg === 'string' ? msg.trim() : '';

      throw new Error(`HTTP ${res.status} ${res.statusText}${msg ? `: ${msg}` : ''}`);

    }

    let data = await res.json();

    if (_tk !== _hwfitFetchToken) { try { wp.destroy(); } catch {} return; }

    if (!isImageMode && quantPref && !data.error && Array.isArray(data.models) && data.models.length === 0) {

      const fallbackParams = new URLSearchParams(params);

      fallbackParams.delete('quant');

      const fallbackRes = await fetch(`/api/hwfit/models?${fallbackParams}`);

      if (_tk !== _hwfitFetchToken) { try { wp.destroy(); } catch {} return; }

      if (fallbackRes.ok) {

        const fallbackData = await fallbackRes.json();

        if (!fallbackData.error && Array.isArray(fallbackData.models) && fallbackData.models.length > 0) {

          data = fallbackData;

          const quantSel = document.getElementById('hwfit-quant');

          if (quantSel) quantSel.value = '';

        }

      }

    }

    // 将图片模型字段规范化以匹配 LLM 渲染器的期望格式

    if (isImageMode && data.models) {

      data.models = data.models.map(m => ({

        ...m,

        name: m.id || m.name,

        fit_level: m.fit || 'no_fit',

        parameter_count: m.params_b ? m.params_b + 'B' : '?',

        required_gb: m.vram_needed || 0,

        speed_tps: 0,

        context: 0,

        run_mode: m.capabilities?.[0] || 'image',

        is_image_gen: true,

        quant: m.quant || m.default_quant || 'BF16',

        quant_repo: m.quant_repo || null,

      }));

    }

    wp.destroy();

    if (data.error) {

      // 如果我们有缓存数据，保留即时渲染的结果——不要用暂时性探测失败的错误

      // 替换良好的数据（过期但仍有效）。

      if (!_cached) { _hwfitShowError(list, remoteHost, data.error); if (hw) hw.innerHTML = ''; }

      return;

    }

    // 将 Ollama 库行合并到主列表中，使它们具有与 HF 结果相同的

    // Fit/Param/Quant/VRAM/Mode 列并响应引擎筛选器。

    // 图片生成模式下跳过（Ollama 不服务 diffusers）。

    if (!isImageMode) {

      const _vramAvail = data.system?.gpu_vram_gb || 0;

      const _ramAvail = data.system?.total_ram_gb || 0;

      const _lib = await _ensureOllamaLib();

      const _olRows = _ollamaToHwfitRows(_lib, _vramAvail, _ramAvail);

      // Ollama 行上的搜索筛选：HF API 已按搜索筛选；在客户端对 Ollama 的名称

      // 和描述做同样的操作，使搜索框在两种数据源之间工作一致。

      const _s = (search || '').trim().toLowerCase();

      const _olFiltered = _s

        ? _olRows.filter(r => r.name.toLowerCase().includes(_s) || (r._description || '').toLowerCase().includes(_s))

        : _olRows;

      data.models = (data.models || []).concat(_olFiltered);

    }

    _hwfitCache = data;

    _hwfitRenderHw(hw, data.system);

    // 从硬件探测传播本地 platform，使 _isWindows(task) 适用于本地任务

    //（菜单项、shell 命令等）。

    if (!remoteHost && data.system && data.system.platform) {

      _envState.platform = data.system.platform;

    }

    // 客户端排序按活跃列进行，使最高↔最低切换具有确定性

    //（之前的 array .reverse() 不能可靠地翻转）。

    // 首次点击某列 = 最高优先；再次点击 = 最低优先。

    if (!isImageMode) {

      const sortSel = document.getElementById('hwfit-sort');

      const sortKey = sortSel?.value || 'score';

      const asc = sortSel?.dataset.reverse === '1';   // reversed → ascending (lowest first)

      if (sortKey === 'fit') {

        // fit_level 是分类的（perfect→good→marginal→too_tight），不是数值，

        // 因此显式排序，而不是回退到分数列。按分数进行次级排序，

        // 使同一适配级别内的行保持有意义的顺序。

        const fitRank = { perfect: 4, good: 3, marginal: 2, too_tight: 1, no_fit: 0 };

        data.models.sort((a, b) => {

          const ar = fitRank[a.fit_level] ?? -1, br = fitRank[b.fit_level] ?? -1;

          if (ar !== br) return asc ? ar - br : br - ar;

          const as = Number(a.score) || 0, bs = Number(b.score) || 0;

          return asc ? as - bs : bs - as;

        });

      } else {

        const field = { score: 'score', vram: 'required_gb', speed: 'speed_tps', params: 'params_b', context: 'context' }[sortKey] || 'score';

        data.models.sort((a, b) => {

          const av = Number(a[field]) || 0, bv = Number(b[field]) || 0;

          return asc ? av - bv : bv - av;

        });

      }

    }

    _hwfitRenderList(list, _applyEngineFilter(data.models));

    // 持久化此结果，以便下次页面加载时可以立即渲染。

    _writeScanCache(_sig, data);

    // 渲染 GPU 切换——仅在首次扫描时（无覆盖活动时）

    if (toggleContainer && !toggleContainer._originalSystem) {

      // 仅在应用了 GPU 覆盖时信任系统信息

      if (toggleContainer._activeCount === undefined) {

        toggleContainer._originalSystem = { ...data.system };

        _renderGpuToggles(toggleContainer._originalSystem);

      }

    }

  } catch (e) {

    wp.destroy();

    // 同样的过期但仍有效的规则：仅当屏幕上没有缓存数据时才显示错误。

    if (!_cached) _hwfitShowError(list, remoteHost, e.message);

  }

}



export function _hwfitRenderHw(el, sys) {

  if (!el || !sys) return;

  // 全局缓存系统信息，使其他模块无需重新获取即可读取 VRAM

  try { window._hwfitSystemCache = sys; } catch {}

  // 有数据时显示硬件行

  const hwRow = document.getElementById('hwfit-hw-row');

  if (hwRow) hwRow.style.display = 'flex';

  const gpuCount = sys.gpu_count || 0;

  // gpu_error = nvidia-smi 存在但失败（例如驱动/库版本不匹配）。显示它而不是误导性的 "No GPU" —— 纯文本标签，完整错误在工具提示中。

  // 芯片渲染：分为可点击的主体（切换关闭/打开）和单独的 × 按钮（从视图中完全移除 + 视为排序时已关闭）。主体的"关闭"状态仅为视觉变暗 —— 芯片保持可见，以便无需重新扫描即可重新开启。

  const chip = (key, label, title = 'Click to toggle off (X to hide)') => {

    if (_removedHwChips.has(key)) return '';

    const dim = _dismissedHwChips.has(key) ? ' hwfit-hw-chip-off' : '';

    return (

      `<span class="hwfit-hw-chip hwfit-hw-chip-row${dim}" data-hw-chip="${esc(key)}">`

      + `<button type="button" class="hwfit-hw-chip-toggle" data-hw-chip="${esc(key)}" title="${esc(title)}">${label}</button>`

      + `<button type="button" class="hwfit-hw-chip-x" data-hw-chip="${esc(key)}" title="Remove this chip" aria-label="Remove">×</button>`

      + `</span>`

    );

  };

  let gpuChip;

  if (sys.gpu_name) {

    // 混合 GPU 机器（#711）：`${gpuCount}x ${gpu_name}` 对每张卡使用 gpus[0].name，

    // 因此 4090+3060 显示为 "2x RTX 4090"。使用 gpu_groups（后端已将相同卡片分组）

    // 分别渲染每个池，并将每张卡的索引+VRAM 放入工具提示中，使其在选择 CUDA_VISIBLE_DEVICES 时真正有用。

    const groups = Array.isArray(sys.gpu_groups) ? sys.gpu_groups : [];

    // 缩短供应商前缀，使混合 GPU 标签适配芯片行且不溢出。单 GPU 标签仍显示完整名称

    //（这是用户习惯看到的内容）。工具提示无论如何都携带完整的未修改名称，因此不会丢失信息。

    const _shortGpuName = (n) => String(n || '')

      .replace(/^NVIDIA\s+GeForce\s+/i, '')

      .replace(/^NVIDIA\s+/i, '')

      .replace(/^AMD\s+Radeon\s+/i, '')

      .replace(/^AMD\s+/i, '')

      .replace(/^Intel\s+/i, '');

    let label;

    if (groups.length > 1) {

      // 异构："1× RTX 4090 + 1× RTX 3060"

      label = groups.map(g => `${g.count}× ${esc(_shortGpuName(g.name))}`).join(' + ');

    } else if (gpuCount > 1) {

      label = `${gpuCount}× ${esc(sys.gpu_name)}`;

    } else {

      label = esc(sys.gpu_name);

    }

    const gpus = Array.isArray(sys.gpus) ? sys.gpus : [];

    const tip = gpus.length

      ? gpus.map(g => `GPU ${g.index}: ${g.name} · ${(+g.vram_gb).toFixed(1)} GB`).join('\n')

      : 'Click to toggle off (X to hide)';

    gpuChip = chip('gpu', label, tip);

  } else if (sys.gpu_error) {

    gpuChip = _removedHwChips.has('gpu')

      ? ''

      : (() => {

          const dim = _dismissedHwChips.has('gpu') ? ' hwfit-hw-chip-off' : '';

          return (

            `<span class="hwfit-hw-chip hwfit-hw-chip-row hwfit-hw-chip-error${dim}" data-hw-chip="gpu">`

            + `<button type="button" class="hwfit-hw-chip-toggle" data-hw-chip="gpu" title="${esc(sys.gpu_error)}">GPU driver error</button>`

            + `<button type="button" class="hwfit-hw-chip-x" data-hw-chip="gpu" title="Remove this chip" aria-label="Remove">×</button>`

            + `</span>`

          );

        })();

  } else {

    gpuChip = chip('gpu', 'No GPU');

  }

  const vram = sys.gpu_vram_gb ? `${sys.gpu_vram_gb.toFixed(1)} GB VRAM` : '';

  const ram = `${sys.available_ram_gb?.toFixed(1) || '?'} / ${sys.total_ram_gb?.toFixed(1) || '?'} GB RAM`;

  const cores = `${sys.cpu_cores || '?'} cores`;

  const manual = _manualHwState();

  const manualChip = (sys.manual_hardware || manual)

    ? `<span class="hwfit-hw-chip hwfit-hw-chip-row hwfit-hw-chip-manual" data-hw-chip="manual">`

      + `<button type="button" class="hwfit-hw-chip-toggle" data-hw-chip="manual" title="Using manual hardware">${esc(_manualHwLabel(manual) || 'Manual hardware')}</button>`

      + `<button type="button" class="hwfit-hw-chip-x" data-hw-chip="manual" title="Clear manual hardware" aria-label="Clear">×</button>`

      + `</span>`

    : '';

  el.innerHTML = gpuChip

    + (vram ? chip('vram', vram) : '')

    + chip('ram', ram)

    + chip('cores', cores)

    + chip('backend', esc(sys.backend || ''))

    + manualChip;

  // 主体点击 → 切换"关闭"（变暗，仍然可见）。_dismissedHwChips 的成员关系

  // 是排序器读取的内容，因此此处的添加+删除也会翻转模型列表。手动芯片被排除 ——

  // 变暗 "manual" 没有排序影响（该键不被检查），因此在那里点击切换会感觉无效。使用 × 清除它。

  el.querySelectorAll('.hwfit-hw-chip-toggle').forEach(btn => {

    btn.addEventListener('click', (e) => {

      e.stopPropagation();

      const key = btn.dataset.hwChip;

      if (!key || key === 'manual') return;

      const row = btn.closest('.hwfit-hw-chip-row');

      if (_dismissedHwChips.has(key)) {

        _dismissedHwChips.delete(key);

        row?.classList.remove('hwfit-hw-chip-off');

      } else {

        _dismissedHwChips.add(key);

        row?.classList.add('hwfit-hw-chip-off');

      }

      _resetGpuToggleState(false);

      _hwfitCache = null;

      _hwfitFetch(true);

    });

  });

  // × 按钮 → 从视图中完全移除芯片，并将其视为排序时已关闭（直到下一次重新扫描）。

  el.querySelectorAll('.hwfit-hw-chip-x').forEach(btn => {

    btn.addEventListener('click', (e) => {

      e.stopPropagation();

      const key = btn.dataset.hwChip;

      if (!key) return;

      // 手动硬件芯片需要特殊的拆卸：清除保存的手动状态，

      // 使芯片不会在下次从 localStorage 获取时重新渲染。

      // 通过 clearManual() 路由，同时折叠编辑面板。

      if (key === 'manual') {

        _saveManualHwState(null);

        btn.closest('.hwfit-hw-chip-row')?.remove();

        document.getElementById('hwfit-manual-panel')?.classList.add('hidden');

        _resetGpuToggleState();

        _hwfitCache = null;

        _hwfitFetch(true);

        return;

      }

      _removedHwChips.add(key);

      _dismissedHwChips.add(key);

      btn.closest('.hwfit-hw-chip-row')?.remove();

      _resetGpuToggleState(false);

      _hwfitCache = null;

      _hwfitFetch(true);

    });

  });

  _wireManualHardwareControls(el);

}



function _wireManualHardwareControls(el) {

  const btn = document.getElementById('hwfit-hw-manual-btn');

  const panel = document.getElementById('hwfit-manual-panel');

  if (!btn || !panel) return;

  const clearManual = () => {

    _saveManualHwState(null);

    el.querySelector('.hwfit-hw-chip-manual')?.remove();

    panel.classList.add('hidden');

    _resetGpuToggleState();

    _hwfitCache = null;

    _hwfitFetch(true);

  };

  const manual = _manualHwState();

  btn.textContent = t('common.edit');

  if (manual) {

    panel.querySelector('.hwfit-manual-mode').value = manual.mode || 'gpu';

    panel.querySelector('.hwfit-manual-backend').value = manual.backend || 'cuda';

  }

  const syncMode = () => {

    const isRam = panel.querySelector('.hwfit-manual-mode')?.value === 'ram';

    panel.querySelector('.hwfit-manual-gpus')?.closest('label')?.style.setProperty('display', isRam ? 'none' : '');

    panel.querySelector('.hwfit-manual-vram')?.closest('label')?.style.setProperty('display', isRam ? 'none' : '');

    const backend = panel.querySelector('.hwfit-manual-backend');

    if (backend) backend.style.display = isRam ? 'none' : '';

  };

  if (!btn._hwfitManualBound) {

    btn._hwfitManualBound = true;

    btn.addEventListener('click', () => {

      panel.classList.toggle('hidden');

      syncMode();

    });

  }

  el.querySelector('.hwfit-hw-chip-toggle[data-hw-chip="manual"]')?.addEventListener('click', () => {

    panel.classList.remove('hidden');

    syncMode();

  });

  if (!panel._hwfitManualBound) {

    panel._hwfitManualBound = true;

    panel.querySelector('.hwfit-manual-mode')?.addEventListener('change', syncMode);

    panel.querySelector('.hwfit-hw-manual-save')?.addEventListener('click', () => {

      const mode = panel.querySelector('.hwfit-manual-mode')?.value || 'gpu';

      const gpuCount = _manualNumber(panel.querySelector('.hwfit-manual-gpus')?.value, 1);

      const vramGb = _manualNumber(panel.querySelector('.hwfit-manual-vram')?.value, 8);

      const ramGb = _manualOptionalNumber(panel.querySelector('.hwfit-manual-ram')?.value);

      const backend = panel.querySelector('.hwfit-manual-backend')?.value || 'cuda';

      const manual = { mode, gpuCount, vramGb, ramGb, backend };

      _saveManualHwState(manual);

      _resetGpuToggleState();

      _hwfitCache = null;

      panel.classList.add('hidden');

      _hwfitRenderHw(el, _manualDisplaySystem(window._hwfitSystemCache, manual));

      _hwfitFetch(true);

    });

    panel.querySelector('.hwfit-hw-manual-clear')?.addEventListener('click', clearManual);

  }

  syncMode();

}



export const _fitColors = { perfect: 'var(--green, #50fa7b)', good: 'var(--yellow, #f1fa8c)', marginal: 'var(--orange, #ffb86c)', too_tight: 'var(--red, #ff5555)' };



function _requiresAcceleratorBackend(model) {

  const q = String(model?.quant || model?.quantization || '').toUpperCase();

  const text = `${model?.name || ''} ${model?.repo_id || ''} ${model?.path || ''}`.toLowerCase();

  return /^AWQ|^GPTQ|^NVFP4/.test(q) || q === 'FP8' || /\b(awq|gptq|fp8|nvfp4)\b/i.test(text);

}



function _modeLabel(model) {

  if (model?.is_image_gen) return 'image';

  if (_requiresAcceleratorBackend(model)) return 'vLLM/SGLang';

  const detected = _detectBackend(model);

  if (detected?.label) return detected.label;

  return String(model?.run_mode || '').replace('_', '+');

}



export const _hwfitColumns = [

  { key: 'fit', label: 'Fit',    cls: 'hwfit-fit' },

  { key: null,    label: 'Model',  cls: 'hwfit-name' },

  { key: 'params',label: 'Param', cls: 'hwfit-c-params' },

  { key: null,    label: 'Quant',  cls: 'hwfit-c-quant' },

  { key: 'vram',  label: 'VRAM',   cls: 'hwfit-c-vram' },

  { key: 'context',label: 'Ctx',   cls: 'hwfit-c-ctx' },

  { key: 'speed', label: 'Speed',  cls: 'hwfit-c-speed' },

  { key: 'score', label: 'Score',  cls: 'hwfit-c-score' },

  { key: null,    label: 'Mode',   cls: 'hwfit-c-mode' },

];



export function _hwfitRenderList(el, models) {

  if (!el) return;

  models = models || [];

  if (!models.length) {

    // 解释列表为空的原因，使配置充足的服务器不会被误读为"太弱"：

    // 活跃的筛选器 vs. 可能未充分报告的探测 vs. 硬件确实不够。

    const sys = _hwfitCache?.system;

    const hasHw = sys && ((sys.gpu_vram_gb || 0) > 0 || (sys.total_ram_gb || 0) > 8);

    const hasFilters = !!(document.getElementById('hwfit-search')?.value?.trim()

      || document.getElementById('hwfit-usecase')?.value

      || document.getElementById('hwfit-quant')?.value

      || document.getElementById('hwfit-engine')?.value);

    let msg;

    if (hasFilters) msg = 'No models match these filters — try clearing the search, use-case, quant, or engine.';

    else if (hasHw) msg = 'No models fit — the hardware probe may have under-reported. Try Rescan.';

    else msg = 'No models fit your hardware';

    el.innerHTML = `<div class="hwfit-loading">${msg}</div>`;

    return;

  }

  const sortSel = document.getElementById('hwfit-sort');

  const currentSort = sortSel?.value || 'score';

  const isReversed = sortSel?.dataset.reverse === '1';

  // Fit 列标签的活动预算 —— 明确排序是基于 GPU 还是 RAM，

  // 使"最紧张"在混合资源机器上不会产生歧义。

  const tc = document.getElementById('hwfit-gpu-toggles');

  const _budget = (tc && typeof tc._activeCount === 'number')

    ? (tc._activeCount === 0 ? 'RAM' : (tc._activeCount === 1 ? 'GPU' : tc._activeCount + ' GPU'))

    : null;

  let html = '<div class="hwfit-row hwfit-header">';

  for (const col of _hwfitColumns) {

    const sortable = col.key ? ' hwfit-sortable' : '';

    const active = col.key === currentSort ? ' hwfit-sort-active' : '';

    let arrow = '';

    if (col.key === currentSort) {

      // \u25BC = 最高优先（默认），\u25B2 = 反转（最低优先）—— 所有列统一。

      arrow = isReversed ? ' \u25B2' : ' \u25BC';

    }

    const dataAttr = col.key ? ` data-sort="${col.key}"` : '';

    // Fit 列左侧小圆点切换"仅显示适配模型"
    // ——替代工具栏旁的旧 Fits On/Off 按钮。
    let label = col.label;

    if (col.cls === 'hwfit-fit') {

      const _fitOnly = (() => { try { return localStorage.getItem('hwfit_fit_only_v1') === '1'; } catch { return false; } })();

      label = `<span class="hwfit-fit-dot${_fitOnly ? ' active' : ''}" title="${_fitOnly ? 'Showing only models that fit. Click to also show too-tight rows.' : 'Click to show only models that fit your hardware.'}" data-fit-dot>●</span>${col.label}`;

      //（Budget 标签已移除——"Fit"旁的 GPU/RAM/N-GPU 后缀是噪音；
      // 切换行已显示哪个预算处于活动状态。）
    }

    html += `<span class="hwfit-col ${col.cls}${sortable}${active}"${dataAttr}>${label}${arrow}</span>`;

  }

  html += '</div>';

  for (const m of models) {

    const fitColor = _fitColors[m.fit_level] || 'var(--fg-muted)';

    const score = m.score?.toFixed?.(1) ?? m.score ?? '0';

    let tpsRaw = m.speed_tps ?? 0;

    if (tpsRaw > 9999) tpsRaw = 9999;

    const tps = tpsRaw > 0 ? (tpsRaw >= 100 ? Math.round(tpsRaw) : tpsRaw.toFixed(1)) : '?';

    const pcount = m.parameter_count || '?';

    const ctx = m.context ? (m.context >= 1024 ? (m.context / 1024).toFixed(0) + 'k' : m.context) : '?';

    const fitLabel = (m.fit_level || '').replace('_', ' ');

    const modeLabel = _modeLabel(m);

    const vramLabel = m.required_gb ? m.required_gb.toFixed(1) + 'G' : '?';

    const moeBadge = m.is_moe ? '<span class="hwfit-badge hwfit-moe">MoE</span>' : '';

    const imgBadge = m.is_image_gen ? '<span class="hwfit-badge" style="background:color-mix(in srgb, var(--red) 20%, transparent);color:var(--red);font-size:8px;padding:1px 4px;border-radius:3px;margin-left:4px;">IMG</span>' : '';

    const dlDot = (_cachedModelIds && (_cachedModelIds.has(m.name) || [..._cachedModelIds].some(id => id === m.name?.split('/').pop()))) ? '<span class="hwfit-dl-dot" title="Downloaded">\u25CF</span>' : '';

    html += `<div class="hwfit-row" data-model="${esc(m.name)}">`;

    html += `<span class="hwfit-col hwfit-fit" style="color:${fitColor}">${esc(fitLabel)}</span>`;

    // 当量化名不在仓库名中时追加到标题。后缀
    // 去掉名称已含的量化部分。
    // 如 QuantTrio/MiniMax-M2-AWQ + quant=AWQ-4bit 仅显示"(4bit)"
    // 非"(AWQ-4bit)"。DeepSeek-V4-Flash+FP4-MoE-Mixed 保留完整标签。
    
    const _short = m.name?.split('/').pop() || m.name || '';

    const _quantTag = (m.quant || '').trim();

    const _lowerShort = _short.toLowerCase();

    let _quantSuffix = '';

    if (_quantTag) {

      const _parts = _quantTag.split(/[-_]/).filter(Boolean);

      const _remaining = _parts.filter(p => !_lowerShort.includes(p.toLowerCase()));

      if (_remaining.length && _remaining.length < _parts.length + 1) {  // at least one part is new

        let _display = _remaining.join('-');

        if (_display.length > 9) _display = _display.slice(0, 9) + '…';

        _quantSuffix = ` <span class="hwfit-name-quant" title="${esc(_quantTag)} — full storage format">(${esc(_display)})</span>`;

      }

    }

    html += `<span class="hwfit-col hwfit-name">${modelLogo(m.name)}${esc(_short)}${_quantSuffix}${moeBadge}${imgBadge}${dlDot}</span>`;

    html += `<span class="hwfit-col hwfit-c-params">${esc(pcount)}</span>`;

    // Quant 单元格截断为 9 字符 + 省略号，
    // 使"FP4-MoE-Mixed"等长标签不挤压邻列。全文在 title 中。
    const _qRaw = m.quant || '?';

    const _qShort = _qRaw.length > 9 ? _qRaw.slice(0, 9) + '…' : _qRaw;

    html += `<span class="hwfit-col hwfit-c-quant" title="${esc(_qRaw)}">${esc(_qShort)}</span>`;

    html += `<span class="hwfit-col hwfit-c-vram">${vramLabel}</span>`;

    html += `<span class="hwfit-col hwfit-c-ctx">${m.is_image_gen ? '\u2014' : ctx}</span>`;

    html += `<span class="hwfit-col hwfit-c-speed">${m.is_image_gen ? '\u2014' : tps + ' t/s'}</span>`;

    html += `<span class="hwfit-col hwfit-c-score">${score}</span>`;

    html += `<span class="hwfit-col hwfit-c-mode" title="${_requiresAcceleratorBackend(m) ? 'Requires vLLM or SGLang with a visible CUDA/ROCm accelerator. llama.cpp and Ollama need GGUF files.' : ''}">${esc(modeLabel)}</span>`;

    html += `</div>`;

  }

  el.innerHTML = html;

  // 点击行 → 展开内联操作面板。例外：Ollama 行跳过
  // 展开面板（无 HF 元数据）直接将 Download 输入
  // 填入 `<name>:<size>` 标签——一键即可拉取。
  el.querySelectorAll('.hwfit-row:not(.hwfit-header)').forEach(row => {

    row.addEventListener('click', () => {

      const name = row.dataset.model;

      if (!name) return;

      const modelData = (_hwfitCache?.models || []).find(m => m.name === name);

      if (!modelData) return;

      if (modelData._isOllama) {

        // 如果 Download 卡片已经折叠，强制打开它 —— 否则填充（隐藏的）输入框会静默吮掉点击。

        const dlBody = document.getElementById('cookbook-download-card-body');

        const dlArrow = document.getElementById('cookbook-download-card-arrow');

        if (dlBody && dlBody.style.display === 'none') {

          dlBody.style.display = 'block';

          if (dlArrow) dlArrow.style.transform = 'rotate(90deg)';

        }

        const dlInput = document.getElementById('cookbook-dl-repo');

        if (dlInput) {

          dlInput.value = modelData.name;

          dlInput.focus();

          // 简短高亮，使用户即使在下载卡片远远上方（模型列表很长时）也能看到填充了什么。

          dlInput.classList.add('cookbook-dl-flash');

          setTimeout(() => dlInput.classList.remove('cookbook-dl-flash'), 800);

          dlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });

        }

        return;

      }

      _expandModelRow(row, modelData);

    });

  });

  // 可点击的表头列 → 排序（再次点击切换方向）

  el.querySelectorAll('.hwfit-header .hwfit-sortable').forEach(col => {

    col.addEventListener('click', (e) => {

      // Fit 表头中的小圆点是独立的切换（仅适配筛选器）

      // 不要让它冒泡到排序点击。

      if (e.target.closest('[data-fit-dot]')) {

        const on = !e.target.classList.contains('active');

        try { localStorage.setItem('hwfit_fit_only_v1', on ? '1' : '0'); } catch {}

        // 取消适配筛选器（关闭 → 再次显示太紧张的模型行）通常

        // 是因为用户想看到他们还无法运行的大型模型

        // —— 按 VRAM 降序重新排序，使最大的最先显示。

        if (!on) {

          const sortSel = document.getElementById('hwfit-sort');

          if (sortSel) {

            sortSel.value = 'vram';

            sortSel.dataset.reverse = '0';   // descending (biggest first)

          }

        }

        _hwfitCache = null;

        _hwfitFetch();

        return;

      }

      const sortKey = col.dataset.sort;

      if (!sortKey) return;

      const sel = document.getElementById('hwfit-sort');

      if (!sel) return;

      // 如果点击同一则切换排序方向

      if (sel.value === sortKey) {

        sel.dataset.reverse = sel.dataset.reverse === '1' ? '0' : '1';

      } else {

        sel.value = sortKey;

        sel.dataset.reverse = '0';

      }

      _hwfitFetch();

    });

  });

}



// 读取扫描下拉框中当前选中的服务器并将其设为活动主机。在下载/运行前调用

// 使操作目标是用户看到选中的服务器 —— 防止全局 remoteHost 在选择和点击之间

// 被其他地方更改（例如后台 serve-task 处理），这曾导致下载发送到错误的主机。

// 解析扫描下拉框中用户当前选中的服务器并返回其主机字符串

// (''/local 表示本地)。同时镜像到 _envState 用于命令预览。

// 返回值是传递给下载的权威数据源 —— 永远不要信任下游的 _envState.remoteHost（存在多个副本）。

function _syncHostFromScanDropdown() {

  const ss = document.getElementById('hwfit-server-select');

  if (!ss || ss.value == null) return _envState.remoteHost || '';

  let host = '';

  if (ss.value === 'local') {

    _envState.remoteHost = '';

    _envState.remoteServerKey = '';

  } else {

    const s = _serverByVal(ss.value);

    if (s) {

      host = s.host;

      _envState.remoteHost = s.host;

      _envState.remoteServerKey = _serverKey(s);

      _envState.env = s.env;

      _envState.envPath = s.envPath;

      _envState.platform = s.platform || '';

    }

  }

  try { _persistEnvState(); } catch {}

  return host;

}



export function _expandModelRow(row, modelData) {

  const list = row.closest('.hwfit-list');

  if (!list) return;



  const existingPanel = list.querySelector('.hwfit-action-panel');

  const wasActive = row.classList.contains('hwfit-row-active');



  // 移除现有面板和活动状态

  if (existingPanel) existingPanel.remove();

  list.querySelectorAll('.hwfit-row-active').forEach(r => r.classList.remove('hwfit-row-active'));



  // 切换：如果点击同一行，仅关闭

  if (wasActive) return;



  row.classList.add('hwfit-row-active');

  const { backend, label } = _detectBackend(modelData);

  const isVllm = backend === 'vllm';

  const isLlamaCpp = backend === 'llamacpp';

  const ctx = modelData.context || 8192;



  const dlSource = _downloadSourceRepo(modelData, backend);

  const hfUrl = `https://huggingface.co/${dlSource.repo}`;

  let html = `<div class="hwfit-action-panel" data-model-name="${esc(modelData.name)}">`;

  html += `<div class="hwfit-panel-header">`;

  html += `<span class="hwfit-panel-model">${esc(modelData.name)}${dlSource.kind ? ` <span style="opacity:0.5;font-size:10px;">(${esc(dlSource.kind)} ${esc(modelData.quant || '')})</span>` : (modelData.quant_repo ? ` <span style="opacity:0.5;font-size:10px;">(${esc(modelData.quant)})</span>` : '')}</span>`;

  html += `<span class="hwfit-panel-badge">${esc(label)}</span>`;

  html += `<a href="${esc(hfUrl)}" target="_blank" rel="noopener" class="hwfit-panel-hf-link" title="View download source on HuggingFace">HF \u2197</a>`;

  html += `</div>`;

  html += `<div class="hwfit-panel-actions">`;

  html += `<button class="cookbook-btn hwfit-dl-btn">Download</button>`;

  if (!modelData.is_image_gen) {

    html += `<button class="cookbook-btn cookbook-run-btn hwfit-quickrun-btn" title="Download + launch with smart defaults">Run</button>`;

    html += `<button class="cookbook-btn hwfit-serve-expand-btn" title="Configure & serve">Configure</button>`;

  }

  html += `</div>`;

  if (modelData.is_image_gen) {

    html += `<div style="font-size:10px;opacity:0.5;margin-top:4px;">${esc((modelData.capabilities || []).join(' \u00B7 ') || '')}${modelData.description ? ' \u2014 ' + esc(modelData.description) : ''}</div>`;

  } else if (_requiresAcceleratorBackend(modelData)) {

    // 仅当主机无 CUDA/ROCm 加速器时显示提示。
    // 有可见加速器时提示是噪音——用户已可服务模型，
    // 每行都读警告让面板感觉一切都坏了。
    
    const _sys = _hwfitCache?.system || {};

    const _backend = (_sys.backend || '').toLowerCase();

    const _hasGpuAccel = !!_sys.has_gpu && (_backend === 'cuda' || _backend === 'rocm');

    if (!_hasGpuAccel) {

      html += `<div class="hwfit-panel-note">This is a safetensors GPU-serving format. Use vLLM/SGLang with a visible CUDA/ROCm accelerator, or pick a GGUF download for llama.cpp/Ollama.</div>`;

    }

  }

  html += `</div>`;



  row.insertAdjacentHTML('afterend', html);

  const panel = row.nextElementSibling;



  // 绑定下载按钮

  const dlBtn = panel.querySelector('.hwfit-dl-btn');

  if (dlBtn) {

    dlBtn.addEventListener('click', () => {

      const host = _syncHostFromScanDropdown();   // host the user picked, passed explicitly

      if (backend === 'ollama') {

        _runPanelCmd(panel, _buildDownloadCmd(modelData, backend), { timeout: 0 });

      } else {

        _runModelDownload(panel, modelData, backend, host);

      }

    });

  }



  // 绑定快速运行按钮——下载 + 以智能默认值启动
  const quickRunBtn = panel.querySelector('.hwfit-quickrun-btn');

  if (quickRunBtn) {

    quickRunBtn.addEventListener('click', async () => {

      const _qrHost = _syncHostFromScanDropdown();



      // 不服务尚未下载的模型。vLLM/SGLang 会在启动时
      // 后台拉取，因此服务任务显示为"running"但
      // 实际无服务（llama.cpp 仅报"No GGUF found"）。
      // Configure 按钮和 Serve 标签页已有缓存列表门控
      // ——在此镜像。模型不存在时执行"Download"
      // 半功能启动下载，用户完成后可再次 Run。
      
      const _short = modelData.name.split('/').pop();

      const _downloaded = _cachedModelIds && (

        _cachedModelIds.has(modelData.name)

        || [..._cachedModelIds].some(id => id === modelData.name || id.endsWith('/' + _short))

      );

      if (_cachedModelIds && !_downloaded) {

        uiModule.showToast('Model not downloaded yet — starting download. Run again to serve once it finishes.');

        if (backend === 'ollama') {

          _runPanelCmd(panel, _buildDownloadCmd(modelData, backend), { timeout: 0 });

        } else {

          _runModelDownload(panel, modelData, backend, _qrHost);

        }

        return;

      }



      quickRunBtn.disabled = true;

      quickRunBtn.textContent = t('cookbook.starting');



      // 基于硬件和模型的智能默认配置

      const system = _hwfitCache?.system || {};

      // 优先使用活动的同构池——vLLM 仅能在相同 GPU 间
      // 张量并行，故固定到一个池。
      
      const grp = system.active_group || null;

      const poolCount = (grp && grp.use_count) || system.gpu_count || 1;

      const gpuMem = (grp && grp.vram_each) || (system.gpu_vram_gb / (system.gpu_count || 1)) || 20;

      const modelVram = modelData.required_gb || 10;



      // TP 必须是池内 2 的幂（加确切的池大小）——
      // 选择适配模型 VRAM 的最小值，否则整个池。
      const _tpOpts = [1, 2, 4, 8, 16].filter(n => n <= poolCount);

      if (poolCount > 0 && !_tpOpts.includes(poolCount)) _tpOpts.push(poolCount);

      let tp = _tpOpts[_tpOpts.length - 1] || 1;

      for (const n of _tpOpts) { if (n * gpuMem >= modelVram) { tp = n; break; } }



      // 固定到此池前 `tp` 个 GPU 避免 vLLM 跨界至不匹配池。
      // 尊重用户手动设置的 GPU 绑定（_envState.gpus）。
      let cudaDevices = '';

      if (grp && Array.isArray(grp.indices)) cudaDevices = grp.indices.slice(0, tp).join(',');

      // 上下文：基于可用 VRAM 余量进行缩放

      const headroom = (tp * gpuMem) - modelVram;

      let maxCtx = modelData.context_length || 8192;

      if (headroom < 4) maxCtx = Math.min(maxCtx, 4096);

      else if (headroom < 8) maxCtx = Math.min(maxCtx, 8192);

      else if (headroom < 16) maxCtx = Math.min(maxCtx, 16384);

      // GPU 内存利用率

      const gpuUtil = modelVram / (tp * gpuMem) > 0.8 ? '0.95' : '0.90';

      // 工具解析器

      const parser = _detectToolParser(modelData.name);



      const host = _envState.remoteHost || '';

      const hostIp = host.includes('@') ? host.split('@').pop() : host;

      const port = '8000';

      const detected = _detectBackend(modelData);

      const runBackend = detected.backend || 'vllm';



      // 构建 serve 命令

      let cmd = '';

      if (runBackend === 'sglang') {

        cmd = `python3 -m sglang.launch_server --model-path ${modelData.name} --host 0.0.0.0 --port ${port}`;

        if (tp > 1) cmd += ` --tp ${tp}`;

        cmd += ` --context-length ${maxCtx}`;

        cmd += ` --mem-fraction-static ${gpuUtil}`;

        cmd += ' --trust-remote-code';

      } else if (runBackend === 'llamacpp') {

        const dir = `"$HOME/.cache/huggingface/hub/models--${modelData.name.replace(/\//g, '--')}/snapshots"`;

        const ggufPath = `$({ find ${dir} -name '*-00001-of-*.gguf' 2>/dev/null | sort; find ${dir} -name '*.gguf' 2>/dev/null | sort; } | head -1)`;

        cmd = `MODEL_FILE=${ggufPath} && { [ -n "$MODEL_FILE" ] && [ -f "$MODEL_FILE" ]; } || { echo "ERROR: No GGUF found on this host. Download a GGUF quant or switch backend."; exit 1; } && llama-server --model "$MODEL_FILE" --host 0.0.0.0 --port 8080 -ngl 99 -c ${maxCtx} || python3 -m llama_cpp.server --model "$MODEL_FILE" --host 0.0.0.0 --port 8080 --n_gpu_layers 99 --n_ctx ${maxCtx}`;

      } else {

        cmd = `vllm serve ${modelData.name} --host 0.0.0.0 --port ${port}`;

        cmd += ` --tensor-parallel-size ${tp}`;

        cmd += ` --max-model-len ${maxCtx}`;

        cmd += ` --gpu-memory-utilization ${gpuUtil}`;

        cmd += ' --dtype auto';

        cmd += ' --enforce-eager';

        cmd += ' --trust-remote-code';

        cmd += ` --enable-auto-tool-choice --tool-call-parser ${parser}`;

      }



      // 构建环境前缀

      let envPrefix = '';

      if (_envState.env === 'venv' && _envState.envPath) {

        const p = _envState.envPath;

        envPrefix = 'source ' + _shellQuote(p.endsWith('/bin/activate') ? p : p + '/bin/activate');

      } else if (_envState.env === 'conda' && _envState.envPath) {

        envPrefix = 'eval "$(conda shell.bash hook)" && conda activate ' + _shellQuote(_envState.envPath);

      }



      // 通过 serve API 启动。字段名必须匹配后端 ServeRequest 模式
      //（repo_id + cmd）——发送 `command`/`model` 导致 Pydantic 验证失败（422）。
      
      const _srv = _serverByVal(_envState.remoteServerKey || host);

      const payload = {

        repo_id: modelData.name,

        cmd: cmd,

        remote_host: host || undefined,

        ssh_port: (_srv && _srv.port) || undefined,

        env_prefix: envPrefix || undefined,

        hf_token: _envState.hfToken || undefined,

        gpus: _envState.gpus || cudaDevices || undefined,

        platform: _envState.platform || undefined,

      };



      try {

        const res = await fetch('/api/model/serve', {

          method: 'POST', credentials: 'same-origin',

          headers: { 'Content-Type': 'application/json' },

          body: JSON.stringify(payload),

        });

        const data = await res.json();

        if (data.ok) {

          const shortName = modelData.name.split('/').pop();

          _addTask(data.session_id, shortName, 'serve', { _cmd: cmd, model: modelData.name, backend: runBackend, remote_host: host });

          _renderRunningTab();

          uiModule.showToast(`Launching ${shortName}...`);

          // 切换到 Running 标签页

          const runTab = document.querySelector('.cookbook-tab[data-backend="Running"]');

          if (runTab) runTab.click();

        } else {

          uiModule.showError(t('cookbook.launch_failed') + (data.error || ''));

        }

      } catch (e) {

        uiModule.showError(t('cookbook.launch_failed') + e.message);

      }

      quickRunBtn.disabled = false;

      quickRunBtn.textContent = t('cookbook.run');

    });

  }



  // 绑定配置按钮 —— 打开模型的 Serve 面板。

  const configBtn = panel.querySelector('.hwfit-serve-expand-btn');

  if (configBtn) {

    configBtn.addEventListener('click', async () => {

      const repo = modelData.name;

      const short = repo?.split('/').pop();

      // 使用与 dl-dot 相同的"已下载"来源（_cachedModelIds），
      // 非 DOM 查找 .hwfit-cached-item——那些仅在 Serve 标签页存在。
      // 从 What-Fits 标签页旧检查始终失败并错误说"先下载"。
      
      const downloaded = _cachedModelIds && (

        _cachedModelIds.has(repo)

        || [..._cachedModelIds].some(id => id === repo || id.endsWith('/' + short))

      );

      if (_cachedModelIds && !downloaded) {

        uiModule.showToast(t('cookbook.download_first'));

        return;

      }

      // 已下载（或缓存状态未知）——打开 Serve 面板，
      // 切换到 Serve 标签页，获取缓存列表并展开模型卡片。
      try {

        const { openServePanelForRepo } = await import('./cookbookServe.js');

        await openServePanelForRepo(repo);

      } catch (e) {

        uiModule.showToast('Could not open Serve: ' + (e && e.message ? e.message : e));

      }

    });

  }



}



export function _hwfitInit() {

  const uc = document.getElementById('hwfit-usecase');

  const sort = document.getElementById('hwfit-sort');

  const qpref = document.getElementById('hwfit-quant');

  const ctx = document.getElementById('hwfit-context');

  const ctxLabel = document.getElementById('hwfit-context-label');

  const search = document.getElementById('hwfit-search');

  const remote = document.getElementById('hwfit-host');

  _syncCtxControl();

  if (uc) uc.addEventListener('change', () => _hwfitFetch());

  if (sort) sort.addEventListener('change', () => _hwfitFetch());

  if (qpref) qpref.addEventListener('change', () => _hwfitFetch());

  // Engine 过滤器是纯客户端视图过滤，在已获取的
  // 列表（HF + Ollama 合并）上操作，仅从缓存重新渲染。
  const engine = document.getElementById('hwfit-engine');

  if (engine) engine.addEventListener('change', () => {

    const list = document.getElementById('hwfit-list');

    if (list && _hwfitCache && Array.isArray(_hwfitCache.models)) {

      _hwfitRenderList(list, _applyEngineFilter(_hwfitCache.models));

    } else {

      _hwfitFetch();

    }

  });

  if (ctx && !ctx.dataset.bound) {

    ctx.dataset.bound = '1';

    ctx.addEventListener('input', () => {

      if (ctxLabel) ctxLabel.textContent = _ctxLabel(_ctxValue());

    });

    ctx.addEventListener('change', () => {

      const targetCtx = _ctxValue();

      try { localStorage.setItem(_CTX_KEY, String(targetCtx)); } catch {}

      // Ctx 拖拽影响排序模式：特定 ctx 目标
      // 意味着"在此上下文长度下能运行什么"——按 VRAM 升序
      // 让最便宜适配的模型首先出现。拖回 Max
      // 解除约束 → 回到默认分数排序。
      const sortSel = document.getElementById('hwfit-sort');

      if (sortSel) {

        if (targetCtx) {

          sortSel.value = 'vram';

          sortSel.dataset.reverse = '1';   // ascending = smallest VRAM first

        } else {

          sortSel.value = 'score';

          sortSel.dataset.reverse = '';

        }

      }

      _hwfitCache = null;

      _hwfitFetch();

    });

  }

  // 重新扫描——强制进行新的硬件探测（绕过每主机缓存）。
  const rescan = document.getElementById('hwfit-rescan');

  if (rescan && !rescan.dataset.bound) {

    rescan.dataset.bound = '1';

    rescan.addEventListener('click', async () => {

      if (rescan.dataset.scanning) return;   // ignore re-clicks mid-scan

      rescan.dataset.scanning = '1';

      const orig = rescan.innerHTML;

      rescan.disabled = true;

      rescan.style.opacity = '0.85';

      // 将 ↻ 字符替换为实时漩涡使点击在缓慢 SSH
      // 硬件探测期间感觉有响应。
      const wp = spinnerModule.createWhirlpool(12);

      wp.element.style.marginRight = '4px';

      wp.element.style.position = 'relative';

      wp.element.style.top = '-2px';   // sit a touch higher, aligned with the label

      rescan.innerHTML = '';

      rescan.appendChild(wp.element);

      rescan.appendChild(document.createTextNode('RESCAN'));

      // 重置切换状态（无闪烁——按钮保留直到新扫描替换它们）。
      _resetGpuToggleState();

      try {

        await _hwfitFetch(true);

      } finally {

        try { wp.destroy(); } catch {}

        rescan.innerHTML = orig;

        rescan.disabled = false;

        rescan.style.opacity = '';

        delete rescan.dataset.scanning;

      }

    });

  }

  if (search) search.addEventListener('input', () => {

    clearTimeout(_hwfitDebounce);

    _hwfitDebounce = setTimeout(() => _hwfitFetch(), 400);

  });

  // HuggingFace Token
  const hfToken = document.getElementById('hwfit-hftoken');

  if (hfToken) {

    hfToken.addEventListener('change', () => { _envState.hfToken = hfToken.value.trim(); _persistEnvState(); });

    hfToken.addEventListener('input', () => { _envState.hfToken = hfToken.value.trim(); });

  }



  // 使用当前服务器重建所有服务器选择下拉框

  function _rebuildServerSelect() {

    const selectors = [

      document.getElementById('hwfit-server-select'),

      document.getElementById('hwfit-dl-server'),

    ];

    for (const sel of selectors) {

      if (!sel) continue;

      const currentVal = sel.value;

      let html = `<option value="local">Local</option>`;

      _envState.servers.forEach((s, i) => {

        if (!s.host) return;

        const label = s.name || s.host || `Server ${i + 1}`;

        html += `<option value="${i}">${uiModule.esc(label)}</option>`;

      });

      sel.innerHTML = html;

      sel.value = currentVal;

    }

  }



  // 服务器 — 同步更改，添加，删除

  function _syncServers() {

    const entries = document.querySelectorAll('.cookbook-server-entry');

    _envState.servers = [];

    entries.forEach(entry => {

      const row = entry.querySelector('.cookbook-server-row');

      if (!row) return;

      const nameEl = row.querySelector('.cookbook-srv-name');

      const hostEl = row.querySelector('.cookbook-srv-host');

      const name = nameEl?.value.trim() || '';

      const host = (hostEl?.disabled || hostEl?.readOnly) ? '' : (hostEl?.value.trim() || '');

      const port = row.querySelector('.cookbook-srv-port')?.value.trim() || '';

      const env = row.querySelector('.cookbook-srv-env')?.value || 'none';

      const envPath = row.querySelector('.cookbook-srv-path')?.value.trim() || '';

      // 从标签收集模型目录。读取权威 data-dir 属性
      // 而非 textContent——标签现在也包含下载目标图标，
      // textContent 会将图标/✖字符并入路径。

      const dirTags = entry.querySelectorAll('.cookbook-modeldir-tag');

      const modelDirs = [];

      dirTags.forEach(tag => {

        const d = (tag.dataset.dir || '').replaceAll('\u2715', '').replaceAll('\u2716', '').trim();

        if (d) modelDirs.push(d);

      });

      if (!modelDirs.length) modelDirs.push('~/.cache/huggingface/hub');

      // 哪个目录（如果有）被标记为下载目标。'' = HF 缓存。

      const dlEl = entry.querySelector('.cookbook-modeldir-dl.active');

      const downloadDir = dlEl ? (dlEl.dataset.dlDir || '') : '';

      const platform = entry.dataset.platform || '';

      _envState.servers.push({ name, host: host || '', port, env, envPath, modelDirs, modelDir: modelDirs.filter(d => d !== '~/.cache/huggingface/hub')[0] || modelDirs[0], downloadDir, platform });

    });

    // 此处不自动更改选定主机。_syncServers 可在
    // 服务器 DOM 渲染期间运行，禁用/只读主机字段读为空——
    // 使重建列表暂时缺失选定服务器。旧代码"回退"到
    // 第一个远程服务器并持久化，静默翻转活动主机。
    // 用户选择仅通过显式下拉选择更改。
    // 此处仅如能匹配当前主机则刷新 env/path；
    // 否则保持 remoteHost 不变。
    
    const sel = _serverByVal(_envState.remoteServerKey || _envState.remoteHost);

    if (sel) { _envState.env = sel.env; _envState.envPath = sel.envPath; }

    _persistEnvState();

  }



  async function _testServerConnection(entry) {

    const host = entry.querySelector('.cookbook-srv-host')?.value?.trim();

    const port = entry.querySelector('.cookbook-srv-port')?.value?.trim() || '';

    const dot = entry.querySelector('.cookbook-srv-status');

    const msg = entry.querySelector('.cookbook-srv-test-msg');

    const setMsg = (text, color = '') => {

      if (!msg) return;

      msg.textContent = text || '';

      msg.title = text || '';

      msg.style.color = color || '';

      msg.style.opacity = text ? '0.75' : '0.55';

    };

    if (!dot) return;

    if (!host) {

      dot.className = 'cookbook-srv-status';

      dot.title = 'Enter user@host to test';

      setMsg('');

      return;

    }

    dot.className = 'cookbook-srv-status testing';

    dot.title = 'Testing SSH…';

    setMsg('Testing SSH...');

    const pf = port && port !== '22' ? `-p ${port} ` : '';

    const cmd = `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${pf}${host} "echo ok"`;

    const t0 = Date.now();

    try {

      const res = await fetch('/api/shell/exec', {

        method: 'POST', credentials: 'same-origin',

        headers: { 'Content-Type': 'application/json' },

        body: JSON.stringify({ command: cmd, timeout: 8 }),

      });

      const data = await res.json();

      const ms = Date.now() - t0;

      const out = (data.stdout || '').trim();

      if (data.exit_code === 0 && out.startsWith('ok')) {

        dot.className = 'cookbook-srv-status ok';

        dot.title = `Reachable · ${ms} ms · use Dependencies to check tmux/HF setup`;

        setMsg(`Connected · ${ms} ms`, 'var(--green,#50fa7b)');

      } else {

        dot.className = 'cookbook-srv-status fail';

        const err = (data.stderr || data.stdout || `exit ${data.exit_code}`).toString().trim().slice(0, 240);

        dot.title = `SSH failed: ${err}`;

        setMsg(`Failed · ${err}`, 'var(--red,#e06c75)');

      }

    } catch (e) {

      dot.className = 'cookbook-srv-status fail';

      dot.title = `Test failed: ${e.message || e}`;

      setMsg(`Failed · ${e.message || e}`, 'var(--red,#e06c75)');

    }

  }



  function _singleQuote(value) {

    return `'${String(value || '').replace(/'/g, `'\"'\"'`)}'`;

  }



  function _serverKeyCommand(host, port, publicKey) {

    const pf = port && port !== '22' ? `-p ${port} ` : '';

    const remote = [

      `KEY=${_singleQuote(publicKey)}`,

      'mkdir -p ~/.ssh',

      'chmod 700 ~/.ssh',

      'touch ~/.ssh/authorized_keys',

      '(grep -qxF "$KEY" ~/.ssh/authorized_keys || printf "%s\\n" "$KEY" >> ~/.ssh/authorized_keys)',

      'chmod 600 ~/.ssh/authorized_keys',

    ].join(' && ');

    return `ssh -o StrictHostKeyChecking=accept-new ${pf}${host} ${_singleQuote(remote)}`;

  }



  async function _fetchCookbookSshKey(generate = false) {

    const res = await fetch('/api/cookbook/ssh-key', {

      method: generate ? 'POST' : 'GET',

      credentials: 'same-origin',

    });

    const data = await res.json();

    if (generate && !data.ok) throw new Error(data.error || 'Failed to generate SSH key');

    return (data.public_key || '').trim();

  }



  async function _populateServerKeyPanel(entry, generate = false) {

    const panel = entry.querySelector('.cookbook-server-key-panel');

    const cmdBox = entry.querySelector('.cookbook-server-key-command');

    const copyBtn = entry.querySelector('.cookbook-server-key-copy');

    const genBtn = entry.querySelector('.cookbook-server-key-gen');

    if (!panel || !cmdBox) return;

    const host = entry.querySelector('.cookbook-srv-host')?.value?.trim() || '';

    const port = entry.querySelector('.cookbook-srv-port')?.value?.trim() || '';

    if (!host || !host.includes('@')) {

      cmdBox.value = 'Enter the server as user@host first.';

      if (copyBtn) copyBtn.disabled = true;

      return;

    }

    if (!/^[A-Za-z0-9._~-]+@[A-Za-z0-9._:-]+$/.test(host) || (port && !/^\d{1,5}$/.test(port))) {

      cmdBox.value = t('cookbook.invalid_ssh_target');

      if (copyBtn) copyBtn.disabled = true;

      return;

    }

    if (genBtn) {

      genBtn.disabled = true;

      genBtn.textContent = generate ? t('cookbook.generating') : t('common.loading_dots');

    }

    try {

      let publicKey = await _fetchCookbookSshKey(generate);

      if (!publicKey && !generate) publicKey = await _fetchCookbookSshKey(true);

      cmdBox.value = _serverKeyCommand(host, port, publicKey);

      if (copyBtn) copyBtn.disabled = false;

      if (genBtn) genBtn.textContent = t('cookbook.key_ready');

    } catch (e) {

      cmdBox.value = e.message || String(e);

      if (copyBtn) copyBtn.disabled = true;

      if (genBtn) genBtn.textContent = t('cookbook.generate_key');

    } finally {

      if (genBtn) genBtn.disabled = false;

    }

  }



  function _wireServerEntry(entry) {

    // 幂等性保护：_hwfitInit() 可能每个面板打开期间运行多次

    // 重复绑定会在每个控件上叠加重复的事件监听器（例如

    // model-dir "+" 按钮每次点击会添加两个标签，change 处理函数

    // 执行两次）。每个条目仅绑定一次。

    if (entry.dataset.wired) return;

    entry.dataset.wired = '1';

    // 如果缺少状态圆点，注入到服务器名称旁边的卡片标头中

    //（之前是输入行的第一个子元素）。

    const row = entry.querySelector('.cookbook-server-row');

    const titleEl = entry.querySelector('.cookbook-server-title');

    if (!entry.querySelector('.cookbook-srv-status')) {

      const dot = document.createElement('span');

      dot.className = 'cookbook-srv-status';

      dot.title = '点击测试 SSH';

      dot.addEventListener('click', (e) => { e.stopPropagation(); _testServerConnection(entry); });

      if (titleEl) titleEl.insertBefore(dot, titleEl.firstChild);

      else if (row) row.insertBefore(dot, row.firstChild);

      // 本地服务器（只读主机）始终可达——显示绿色
      // 无需 SSH 测试。
      const _hostEl = entry.querySelector('.cookbook-srv-host');

      if (_hostEl && (_hostEl.readOnly || _hostEl.disabled)) {

        dot.className = 'cookbook-srv-status ok';

        dot.title = 'Local (this machine)';

      }

    }

    const checkBtn = entry.querySelector('.cookbook-server-check-btn');

    if (checkBtn && !checkBtn.dataset.bound) {

      checkBtn.dataset.bound = '1';

      checkBtn.addEventListener('click', (e) => {

        e.stopPropagation();

        _testServerConnection(entry);

      });

    }

    // 默认服务器切换：条目标题中的独占复选标记。

    // 选中的服务器是下次打开时 Cookbook 的默认选择（所有下拉框）。

    const _defBtn = entry.querySelector('.cookbook-srv-default');

    if (_defBtn && !_defBtn.dataset.bound) {

      _defBtn.dataset.bound = '1';

      _defBtn.addEventListener('click', (e) => {

        e.stopPropagation();

        const key = _defBtn.dataset.srvKey || '';

        // 如果它已经是默认则切换关闭；否则将其设为默认。

        _envState.defaultServer = (_envState.defaultServer === key) ? '' : key;

        _persistEnvState();

        document.querySelectorAll('.cookbook-srv-default').forEach(b => {

          const on = !!_envState.defaultServer && b.dataset.srvKey === _envState.defaultServer;

          b.classList.toggle('active', on);

          // 保留图标后的 "default" 标签（不要覆盖它）。

          b.innerHTML = (on ? _MODELDIR_CHECK_ON : _MODELDIR_CHECK_OFF) + '<span class="cookbook-srv-default-label">' + t('cookbook.server_default_label') + '</span>';

          b.title = on ? t('cookbook.server_default_title') : t('cookbook.server_set_default_title');

        });

        // 立即应用，使下拉框无需重新打开即可反映更改

        //（内联 —— _applyServerSelection 在 cookbook.js 中，未在此导入）。

        const _dk = _envState.defaultServer;

        if (_dk) {

          if (_dk === 'local') { _envState.remoteHost = ''; _envState.remoteServerKey = ''; _envState.env = 'none'; _envState.envPath = ''; _envState.platform = ''; }

          else { const _s = _serverByVal(_dk); if (_s) { _envState.remoteHost = _s.host; _envState.remoteServerKey = _serverKey(_s); _envState.env = _s.env || 'none'; _envState.envPath = _s.envPath || ''; _envState.platform = _s.platform || ''; } }

          _persistEnvState();

          document.querySelectorAll('#hwfit-server-select, #hwfit-dl-server, #hwfit-cache-server, #hwfit-deps-server').forEach(sel => {

            if (sel && sel.tagName === 'SELECT') sel.value = _currentServerValue();

          });

        }

        const defaultSrv = _serverByVal(_envState.defaultServer);

        uiModule.showToast(_envState.defaultServer

          ? 'Default server: ' + (_envState.defaultServer === 'local' ? 'Local' : (defaultSrv?.name || defaultSrv?.host || 'selected server'))

          : 'Default server cleared');

      });

    }

    const keyBtn = entry.querySelector('.cookbook-server-key-btn');

    if (keyBtn && !keyBtn.dataset.bound) {

      keyBtn.dataset.bound = '1';

      keyBtn.addEventListener('click', async () => {

        const panel = entry.querySelector('.cookbook-server-key-panel');

        if (!panel) return;

        const willOpen = panel.classList.contains('hidden');

        panel.classList.toggle('hidden', !willOpen);

        panel.style.display = willOpen ? 'flex' : '';

        if (willOpen) await _populateServerKeyPanel(entry, false);

      });

    }

    const keyGenBtn = entry.querySelector('.cookbook-server-key-gen');

    if (keyGenBtn && !keyGenBtn.dataset.bound) {

      keyGenBtn.dataset.bound = '1';

      keyGenBtn.addEventListener('click', () => _populateServerKeyPanel(entry, true));

    }

    const keyCopyBtn = entry.querySelector('.cookbook-server-key-copy');

    if (keyCopyBtn && !keyCopyBtn.dataset.bound) {

      keyCopyBtn.dataset.bound = '1';

      keyCopyBtn.addEventListener('click', async () => {

        const cmd = entry.querySelector('.cookbook-server-key-command')?.value?.trim() || '';

        if (!cmd || cmd.startsWith('Enter ')) return;

        await _copyText(cmd);

        uiModule.showToast('SSH setup command copied');

      });

    }

    entry.querySelectorAll('input, select').forEach(el => {

      el.addEventListener('change', () => {

        const selectedBefore = _envState.remoteHost || '';

        const entryHost = entry.querySelector('.cookbook-srv-host')?.value?.trim() || '';

        _syncServers();

        _rebuildServerSelect();

        if (selectedBefore && selectedBefore === entryHost) {

          _hwfitCache = null;

          _hwfitFetch();

        }

        if (!entry.querySelector('.cookbook-server-key-panel')?.classList.contains('hidden')) {

          _populateServerKeyPanel(entry, false);

        }

      });

    });

    // 当主机或端口失去焦点时自动测试

    entry.querySelectorAll('.cookbook-srv-host, .cookbook-srv-port').forEach(el => {

      el.addEventListener('blur', () => _testServerConnection(entry));

    });

    // 对预填充行的初始测试（标签页加载时已有的服务器）

    if (entry.querySelector('.cookbook-srv-host')?.value?.trim() && !entry.dataset.tested) {

      entry.dataset.tested = '1';

      _testServerConnection(entry);

    }

    // 全新服务器条目的取消按钮：丢弃它（无需确认 —— 未保存）

    // 并重新同步，以免丢弃的空白服务器残留。

    const cancelBtn = entry.querySelector('.cookbook-server-cancel-btn');

    if (cancelBtn && !cancelBtn.dataset.bound) {

      cancelBtn.dataset.bound = '1';

      cancelBtn.addEventListener('click', () => {

        entry.remove();

        _syncServers();

        _rebuildServerSelect();

        _hwfitCache = null;

        _hwfitFetch();

      });

    }

    // 全新服务器条目的保存按钮：持久化 + 用复选标记确认。

    const saveBtn = entry.querySelector('.cookbook-server-save-btn');

    if (saveBtn && !saveBtn.dataset.bound) {

      saveBtn.dataset.bound = '1';

      saveBtn.addEventListener('click', () => {

        _syncServers();

        _rebuildServerSelect();

        // 广播给设置标签页之外依赖服务器列表的任何内容

        //（Serve 对话框主机选择器、Running 任务等）。

        // 没有此步骤，用户必须硬刷新才能在其他地方看到新条目。

        try {

          document.dispatchEvent(new CustomEvent('cookbook:servers-changed', {

            detail: { servers: _envState.servers.slice() },

          }));

        } catch (_) {}

        saveBtn.classList.add('saved');

        saveBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#50fa7b" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;flex-shrink:0;"><polyline points="20 6 9 17 4 12"/></svg>' + t('common.saved');

      });

    }

    const rmBtn = entry.querySelector('.cookbook-server-rm');

    if (rmBtn) rmBtn.addEventListener('click', async () => {

      const name = entry.querySelector('.cookbook-srv-name')?.value?.trim()

                || entry.querySelector('.cookbook-srv-host')?.value?.trim()

                || t('cookbook.this_server');

      let ok = true;

      if (uiModule && uiModule.styledConfirm) {

        ok = await uiModule.styledConfirm(t('cookbook.confirm_remove_server', { name: name }), { confirmText: t('cookbook.remove_button'), danger: true });

      } else {

        ok = confirm(t('cookbook.confirm_remove_server', { name: name }));

      }

      if (!ok) return;

      entry.remove();

      _syncServers();

      _rebuildServerSelect();

      try {

        document.dispatchEvent(new CustomEvent('cookbook:servers-changed', {

          detail: { servers: _envState.servers.slice() },

        }));

      } catch (_) {}

      _hwfitCache = null;

      _hwfitFetch();

    });

    // Setup 由 cookbook.js 的委托处理器拥有（Settings 行为：

    // 选择服务器 + 打开 Dependencies 标签页）。不要在此也绑定内联安装

    // 处理器，否则一次点击会执行两个冲突的操作。

    const setupBtn = null;

    if (setupBtn) {

      setupBtn.addEventListener('click', async () => {

        const host = entry.querySelector('.cookbook-srv-host')?.value?.trim();

        const port = entry.querySelector('.cookbook-srv-port')?.value?.trim() || '';

        if (!host) return;

        setupBtn.disabled = true;

        const origText = setupBtn.textContent;

        setupBtn.textContent = t('cookbook.installing');

        try {

          const res = await fetch('/api/cookbook/setup', {

            method: 'POST', credentials: 'same-origin',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ host, ssh_port: port || undefined }),

          });

          const data = await res.json();

          if (data.ok) {

            setupBtn.textContent = t('cookbook.done_check');

            setupBtn.style.color = '#50fa7b';

            uiModule.showToast(t('cookbook.setup_complete', { platform: data.platform }));

            // 将检测到的平台存储在服务器条目上

            if (data.platform) {

              entry.dataset.platform = data.platform;

              _syncServers();

              // 显示平台徽章

              const existingBadge = entry.querySelector('.cookbook-platform-badge');

              if (existingBadge) existingBadge.remove();

              const badge = document.createElement('span');

              badge.className = 'cookbook-platform-badge';

              badge.style.cssText = 'font-size:8px;padding:1px 5px;border-radius:3px;border:1px solid ' + (data.platform === 'windows' ? 'var(--cyan,#56b6c2)' : 'var(--green,#98c379)') + ';color:' + (data.platform === 'windows' ? 'var(--cyan,#56b6c2)' : 'var(--green,#98c379)') + ';opacity:0.7;white-space:nowrap;flex-shrink:0;';

              badge.textContent = data.platform;

              setupBtn.parentNode.insertBefore(badge, setupBtn);

            }

            // 自动设置 Termux 模型目引

            if (data.platform === 'termux') {

              const container = entry.querySelector('.cookbook-modeldirs');

              if (container) {

                const existing = [...container.querySelectorAll('.cookbook-modeldir-tag')].map(t => t.textContent.replace('\u2716', '').replace('\u2715', '').trim());

                const termuxDir = '/data/data/com.termux/files/home/models';

                if (!existing.includes(termuxDir)) {

                  const tag = document.createElement('span');

                  tag.className = 'cookbook-modeldir-tag';

                  tag.dataset.dirIdx = existing.length;

                  tag.innerHTML = `${uiModule.esc(termuxDir)} <span class="cookbook-modeldir-rm" title="${t('common.remove')}">\u2715</span>`;

                  tag.querySelector('.cookbook-modeldir-rm').addEventListener('click', () => { tag.remove(); _syncServers(); });

                  const addBtn = container.querySelector('.cookbook-modeldir-add');

                  if (addBtn) container.insertBefore(tag, addBtn);

                  else container.appendChild(tag);

                  _syncServers();

                }

              }

            }

          } else {

            setupBtn.textContent = t('common.failed');

            setupBtn.style.color = 'var(--red)';

            uiModule.showError(data.error || data.output || t('cookbook.setup_failed'));

          }

        } catch (e) {

          setupBtn.textContent = t('common.error');

          setupBtn.style.color = 'var(--red)';

          uiModule.showError(e.message);

        }

        setTimeout(() => { setupBtn.disabled = false; setupBtn.textContent = origText; setupBtn.style.color = ''; }, 3000);

      });

    }

    // 模型目录添加/删除

    const addDirBtn = entry.querySelector('.cookbook-modeldir-add');

    if (addDirBtn) addDirBtn.addEventListener('click', () => {

      const raw = prompt('Model directory path:', '/data/models');

      if (!raw) return;

      const dir = raw.replaceAll('\u2715', '').replaceAll('\u2716', '').trim();

      if (!dir) return;

      // 不要添加重复项

      const existing = [...entry.querySelectorAll('.cookbook-modeldir-tag')].some(t => (t.dataset.dir || t.textContent.trim()) === dir);

      if (existing) return;

      const container = entry.querySelector('.cookbook-modeldirs');

      const tag = document.createElement('span');

      tag.className = 'cookbook-modeldir-tag';

      tag.dataset.dirIdx = container.querySelectorAll('.cookbook-modeldir-tag').length;

      tag.dataset.dir = dir;

      tag.innerHTML = `<span class="cookbook-modeldir-dl" title="${t('cookbook.send_downloads_here')}" data-dl-dir="${uiModule.esc(dir)}">${_MODELDIR_CHECK_OFF}</span> ${uiModule.esc(dir)} <span class="cookbook-modeldir-rm" title="${t('common.remove')}">\u2716</span>`;

      tag.querySelector('.cookbook-modeldir-rm').addEventListener('click', () => { tag.remove(); _syncServers(); });

      _wireModelDirTarget(entry, tag.querySelector('.cookbook-modeldir-dl'));

      container.insertBefore(tag, addDirBtn);

      _syncServers();

    });

    entry.querySelectorAll('.cookbook-modeldir-rm').forEach(rm => {

      rm.addEventListener('click', () => { rm.closest('.cookbook-modeldir-tag').remove(); _syncServers(); });

    });

    // 下载目标切换：点击一个使其成为此服务器的唯一目标目录

    //（如果是默认目录则为默认的 HF 缓存）。

    entry.querySelectorAll('.cookbook-modeldir-dl').forEach(dl => _wireModelDirTarget(entry, dl));

  }



  // 将模型目录标签标记为此服务器的下载目标（排他），
  // 然后持久化。点击标签任意位置（非仅对号）选择它——
  // 除了移除按钮，它有独立的处理器。

  function _wireModelDirTarget(entry, dlEl) {

    if (!dlEl) return;

    const tag = dlEl.closest('.cookbook-modeldir-tag');

    if (!tag || tag.dataset.dlBound) return;

    tag.dataset.dlBound = '1';

    tag.style.cursor = 'pointer';

    tag.addEventListener('click', (e) => {

      if (e.target.closest('.cookbook-modeldir-rm')) return;   // remove handled elsewhere

      e.stopPropagation();

      entry.querySelectorAll('.cookbook-modeldir-dl').forEach(d => {

        d.classList.remove('active');

        d.innerHTML = _MODELDIR_CHECK_OFF;          // uncheck the others

        d.closest('.cookbook-modeldir-tag')?.classList.remove('cookbook-modeldir-target');

        d.title = t('cookbook.send_downloads_here');

      });

      dlEl.classList.add('active');

      dlEl.innerHTML = _MODELDIR_CHECK_ON;           // check the chosen one

      tag.classList.add('cookbook-modeldir-target');

      dlEl.title = t('cookbook.downloads_go_here');

      _syncServers();

      uiModule.showToast((dlEl.dataset.dlDir ? t('cookbook.downloads_to', { dir: dlEl.dataset.dlDir }) : t('cookbook.downloads_default_hf')));

    });

  }



  document.querySelectorAll('.cookbook-server-entry').forEach(_wireServerEntry);



  const addBtn = document.getElementById('cookbook-server-add');

  if (addBtn && !addBtn.dataset.bound) {

    addBtn.dataset.bound = '1';

    addBtn.addEventListener('click', () => {

      const list = document.getElementById('cookbook-servers-list');

      if (!list) return;

      const idx = list.children.length;

      // 用与现有服务器相同的模板构建新条目
      //（模型目录头、默认对号、平台图标）——isNew 将删除按钮
      // 替换为 Save 按钮。forceRemote 保持可编辑。
      const blank = { host: '', name: '', port: '', env: 'none', envPath: '', platform: '', modelDirs: ['~/.cache/huggingface/hub'] };

      const wrap = document.createElement('div');

      wrap.innerHTML = _serverEntryHtml(blank, idx, _envState.defaultServer || '', true, true);

      const entry = wrap.firstElementChild;

      list.appendChild(entry);

      _wireServerEntry(entry);

      _syncServers();

      // 同时刷新服务器选择下拉框

      _rebuildServerSelect();

      entry.querySelector('.cookbook-srv-host')?.focus();

    });

  }



  // 服务器选择器下拉框

  const serverSelect = document.getElementById('hwfit-server-select');

  if (serverSelect && !serverSelect.dataset.bound) {

    serverSelect.dataset.bound = '1';

    serverSelect.addEventListener('change', () => {

      const val = serverSelect.value;

      if (val === 'local') {

        _envState.remoteHost = '';

        _envState.remoteServerKey = '';

        _envState.env = 'none';

        _envState.envPath = '';

      } else {

        const s = _serverByVal(val);

        if (s) {

          _envState.remoteHost = s.host;

          _envState.remoteServerKey = _serverKey(s);

          _envState.env = s.env;

          _envState.envPath = s.envPath;

        }

      }

      _persistEnvState();

      // 保持其他服务器下拉菜单（Download / Cache / Deps）同步。
      // download-input 按钮直接读取 #hwfit-dl-server
      // 因此无此则保持旧值，下载发往错误主机
      // 即使此处扫描已正确切换到选定服务器。
      document.querySelectorAll('#hwfit-dl-server, #hwfit-cache-server, #hwfit-deps-server').forEach(sel => {

        if (!sel || sel.tagName !== 'SELECT') return;

        sel.value = _currentServerValue();

      });

      _hwfitCache = null;

      // 重置 GPU 切换状态（无闪烁），使新服务器的硬件重新渲染。

      _resetGpuToggleState();

      _hwfitFetch();

    });

  }



}
