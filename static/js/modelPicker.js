// 模型选择器 — 聊天框模型选择下拉菜单
// 从 sessions.js 提取

import { providerLogo } from './providers.js';
import uiModule from './ui.js';
import settingsModule from './settings.js';
import { sortModelObjects } from './modelSort.js';

const API_BASE = window.location.origin;

// ── Recent + Favorites persistence ──
// Recent is auto-tracked (last 5 picks, most-recent-first) and lives in its
// own key. Favorites is the SAME key the sidebar Models section uses, so a
// favorite toggled here shows up there and vice-versa.
const RECENT_KEY = 'odysseus-model-recent';
const FAVORITES_KEY = 'odysseus-model-favorites';
const RECENT_MAX = 5;
// Catalogs at or below this size are small enough that hiding everything
// behind search would be a regression — keep listing them in browse mode.
const BROWSE_ALL_LIMIT = 12;

function _loadList(key) {
  try {
    const a = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function _saveList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* quota / private mode */ }
}
function _loadRecent() { return _loadList(RECENT_KEY); }
function _pushRecent(mid) {
  if (!mid) return;
  const next = _loadRecent().filter(x => x !== mid);
  next.unshift(mid);
  _saveList(RECENT_KEY, next.slice(0, RECENT_MAX));
}
function _loadFavorites() { return _loadList(FAVORITES_KEY); }
function _toggleFavorite(mid) {
  const favs = _loadFavorites();
  const i = favs.indexOf(mid);
  if (i >= 0) favs.splice(i, 1);
  else favs.push(mid);
  _saveList(FAVORITES_KEY, favs);
  // 保持侧边栏模型区域同步（相同 key）如果它已挂载。
  try {
    if (window.modelsModule && typeof window.modelsModule.refreshModels === 'function') {
      window.modelsModule.refreshModels();
    }
  } catch { /* sidebar not present */ }
  return i < 0; // true when now favorited
}

// ── 模型选择器共享键盘导航 ──
function _handlePickerKeydown(e, listEl, itemSelector, closeFn) {
  if (e.key === 'Escape') { closeFn(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    const active = listEl.querySelector(itemSelector + '.kb-active') || listEl.querySelector(itemSelector);
    if (active) active.click();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...listEl.querySelectorAll(itemSelector)].filter(el => el.style.display !== 'none');
    if (!items.length) return;
    const cur = items.findIndex(el => el.classList.contains('kb-active'));
    items.forEach(el => el.classList.remove('kb-active'));
    let next;
    if (e.key === 'ArrowDown') next = cur < items.length - 1 ? cur + 1 : 0;
    else next = cur > 0 ? cur - 1 : items.length - 1;
    items[next].classList.add('kb-active');
    items[next].scrollIntoView({ block: 'nearest' });
  }
}

// 通过 initModelPicker() 注入的依赖
let _deps = null;
let _autoSelectingDefault = false;
let _defaultChatPickInFlight = false;

function _modelExists(modelId, url) {
  if (!modelId || !window.modelsModule || !window.modelsModule.getCachedItems) return false;
  const items = window.modelsModule.getCachedItems() || [];
  if (!items.length) return true;
  const targetUrl = (url || '').replace(/\/+$/, '');
  return items.some(item => {
    if (item.offline) return false;
    const itemUrl = (item.url || '').replace(/\/+$/, '');
    const models = (item.models || []).concat(item.models_extra || []);
    return models.includes(modelId) && (!targetUrl || itemUrl === targetUrl);
  });
}

async function _ensureDefaultPendingChat() {
  if (!_deps || _defaultChatPickInFlight) return;
  if (_deps.getCurrentSessionId && _deps.getCurrentSessionId()) return;
  const pending = _deps.getPendingChat && _deps.getPendingChat();
  if (pending && pending.modelId) return;
  _defaultChatPickInFlight = true;
  try {
    let dc = null;
    try {
      const res = await fetch(`${API_BASE}/api/default-chat`, { credentials: 'same-origin' });
      if (res.ok) dc = await res.json();
    } catch (_) {}
    if (dc && dc.endpoint_url && dc.model) {
      _deps.setPendingChat({
        url: dc.endpoint_url,
        modelId: dc.model,
        endpointId: dc.endpoint_id || '',
      });
      try { window.__odysseusDefaultChat = dc; } catch (_) {}
      updateModelPicker();
      return;
    }
    // No configured default: preserve the old convenience fallback.
    if (window.modelsModule && window.modelsModule.getCachedItems) {
      const items = window.modelsModule.getCachedItems();
      const first = items.find(item => !item.offline && ((item.models || []).length || (item.models_extra || []).length));
      if (first) {
        const models = (first.models || []).concat(first.models_extra || []);
        _deps.setPendingChat({ url: first.url, modelId: models[0], endpointId: first.endpoint_id });
        updateModelPicker();
      }
    }
  } finally {
    _defaultChatPickInFlight = false;
  }
}

/**
 * 初始化模型选择器下拉菜单。
 * @param {Object} deps
 * @param {function} deps.getCurrentSessionId - 返回当前会话 ID
 * @param {function} deps.getSessions - 返回会话数组
 * @param {function} deps.getPendingChat - 返回 _pendingChat 对象
 * @param {function} deps.setPendingChat - 设置 _pendingChat 对象
 * @param {function} deps.createDirectChat - 创建新的直接聊天会话
 */
export function initModelPicker(deps) {
  _deps = deps;
  _initModelPickerDropdown();
}

function _initModelPickerDropdown() {
  const wrap = document.getElementById('model-picker-wrap');
  const btn = document.getElementById('model-picker-btn');
  const menu = document.getElementById('model-picker-menu');
  const search = document.getElementById('model-picker-search');
  const listEl = document.getElementById('model-picker-list');
  const searchRow = menu ? menu.querySelector('.model-picker-search-row') : null;
  const refreshBtn = document.getElementById('model-picker-refresh-btn');
  if (!wrap || !btn || !menu || !search || !listEl) return;

  function _close() {
    if (menu.classList.contains('hidden')) return;
    // 恢复滚动按钮
    const _scrollBtn = document.getElementById('scroll-bottom-btn');
    if (_scrollBtn) _scrollBtn.style.display = '';
    menu.classList.add('closing');
    menu.addEventListener('animationend', function _onDone() {
      menu.removeEventListener('animationend', _onDone);
      menu.classList.remove('closing');
      menu.classList.add('hidden');
      search.value = '';
    }, { once: true });
    // 如果 animationend 未触发时的回退方案
    setTimeout(() => {
      if (!menu.classList.contains('hidden')) {
        menu.classList.remove('closing');
        menu.classList.add('hidden');
        search.value = '';
      }
    }, 200);
  }

  function _openPickerShortcut(kind) {
    _close();
    try {
      if (kind === 'cookbook') {
        if (window.cookbookModule && typeof window.cookbookModule.open === 'function') {
          window.cookbookModule.open();
        } else {
          const btn = document.getElementById('tool-cookbook-btn') || document.getElementById('rail-cookbook');
          if (btn) btn.click();
          else location.hash = '#cookbook';
        }
      } else if (kind === 'settings') {
        if (settingsModule && typeof settingsModule.open === 'function') settingsModule.open();
      } else if (window.adminModule && typeof window.adminModule.open === 'function') {
        window.adminModule.open('services');
      } else if (settingsModule && typeof settingsModule.open === 'function') {
        settingsModule.open('services');
      }
    } catch (_) {}
  }

  // Local endpoint health — only probed for LOCAL endpoints, since
  // cloud APIs are essentially always up. Cached briefly on the
  // server side too (8s TTL). Picker opens trigger a refresh.
  let _localProbe = {};            // {endpoint_id: {alive, latency_ms, error}}
  let _localProbeFetchedAt = 0;
  const _LOCAL_PROBE_TTL_MS = 5000;

  async function _refreshLocalProbe() {
    const now = Date.now();
    if (now - _localProbeFetchedAt < _LOCAL_PROBE_TTL_MS) return;
    _localProbeFetchedAt = now;
    try {
      const r = await fetch('/api/model-endpoints/probe-local', { credentials: 'same-origin' });
      if (r.ok) _localProbe = (await r.json()) || {};
    } catch (_) { /* leave stale data; picker still works */ }
  }

  function _getAllModels() {
    const items = (window.modelsModule && window.modelsModule.getCachedItems) ? window.modelsModule.getCachedItems() : [];
    const result = [];
    const seen = new Set();
    items.forEach(item => {
      // Previously: offline endpoints were skipped entirely, so a server
      // that briefly went down disappeared from the picker — confusing
      // when the user can still see it (offline-tagged) in Settings.
      // Now: include offline-endpoint models too but flag them
      // `stale: true` so the row renderer dims them + shows the offline
      // pill. The user can still click and try anyway (matches the
      // existing "local server appears offline" path on line 301).
      const epOffline = !!item.offline;
      const allModels = (item.models || []).concat(item.models_extra || []);
      const allDisplay = (item.models_display || []).concat(item.models_extra_display || []);
      // 标记实时探测失败的本地端点。
      const probeResult = item.endpoint_id ? _localProbe[item.endpoint_id] : null;
      const isLocalDead = !!(probeResult && probeResult.alive === false);
      allModels.forEach((mid, i) => {
        // Deduplicate by model ID — prefer ONLINE endpoint entries over
        // offline duplicates so the user gets a working endpoint first
        // when the same model is exposed by both.
        if (seen.has(mid)) return;
        seen.add(mid);
        result.push({
          mid,
          display: (allDisplay[i] || mid).split('/').pop(),
          url: item.url,
          endpointId: item.endpoint_id,
          epName: item.endpoint_name || '',
          providerText: [
            item.endpoint_name || '',
            item.category || '',
            item.host || '',
            item.url || '',
          ].filter(Boolean).join(' '),
          stale: isLocalDead || epOffline,
          staleReason: epOffline
            ? (item.ping_error || t('models.endpoint_offline'))
            : (isLocalDead ? (probeResult.error || t('models.not_responding')) : ''),
          offline: epOffline,
        });
      });
    });
    return sortModelObjects(result);
  }

  // ── 提供者显示名称和分组 ──
  const _PROVIDER_NAMES = {
    '01-ai': 'Yi', 'abacusai': 'Abacus AI', 'adept': 'Adept',
    'ai21': 'AI21 Labs', 'ai21labs': 'AI21 Labs', 'aion-labs': 'Aion Labs',
    'aisingapore': 'AI Singapore', 'allenai': 'Allen AI', 'amazon': 'Amazon',
    'anthracite-org': 'Anthracite', 'anthropic': 'Anthropic', 'arcee-ai': 'Arcee AI',
    'baai': 'BAAI', 'baidu': 'Baidu', 'bigcode': 'BigCode',
    'black-forest-labs': 'Black Forest Labs', 'bytedance': 'ByteDance',
    'bytedance-seed': 'ByteDance', 'cognitivecomputations': 'Cognitive Computations',
    'cohere': 'Cohere', 'databricks': 'Databricks', 'deepcogito': 'DeepCogito',
    'deepseek': 'DeepSeek', 'deepseek-ai': 'DeepSeek', 'essentialai': 'Essential AI',
    'google': 'Google', 'gryphe': 'Gryphe', 'ibm': 'IBM',
    'ibm-granite': 'IBM Granite', 'inception': 'Inception',
    'inclusionai': 'Inclusion AI', 'inflection': 'Inflection',
    'kwaipilot': 'KwaiPilot', 'liquid': 'Liquid AI', 'mancer': 'Mancer',
    'meta': 'Llama', 'meta-llama': 'Llama', 'microsoft': 'Microsoft',
    'minimax': 'MiniMax', 'minimaxai': 'MiniMax', 'mistralai': 'Mistral',
    'moonshotai': 'Moonshot', 'morph': 'Morph', 'nex-agi': 'Nex AGI',
    'nousresearch': 'Nous Research', 'nv-mistralai': 'NVIDIA x Mistral',
    'nvidia': 'NVIDIA', 'openai': 'OpenAI', 'openrouter': 'OpenRouter',
    'perceptron': 'Perceptron', 'perplexity': 'Perplexity', 'poolside': 'Poolside',
    'prime-intellect': 'Prime Intellect', 'qwen': 'Qwen', 'rekaai': 'Reka',
    'relace': 'Relace', 'sao10k': 'Sao10k', 'sarvamai': 'Sarvam AI',
    'snowflake': 'Snowflake', 'stepfun': 'StepFun', 'stepfun-ai': 'StepFun',
    'stockmark': 'Stockmark', 'switchpoint': 'SwitchPoint', 'tencent': 'Tencent',
    'thedrummer': 'TheDrummer', 'undi95': 'Undi95', 'upstage': 'Upstage',
    'writer': 'Writer', 'x-ai': 'xAI', 'xiaomi': 'Xiaomi',
    'z-ai': 'Zhipu', 'zyphra': 'Zyphra',
    '~anthropic': 'Anthropic', '~google': 'Google',
    '~moonshotai': 'Moonshot', '~openai': 'OpenAI',
  };
  const _PROVIDER_ALIAS = {
    'meta-llama': 'meta', 'deepseek': 'deepseek-ai', 'minimaxai': 'minimax',
    'stepfun-ai': 'stepfun', 'ai21labs': 'ai21', 'ibm-granite': 'ibm',
    'bytedance-seed': 'bytedance', '~anthropic': 'anthropic',
    '~google': 'google', '~moonshotai': 'moonshotai', '~openai': 'openai',
  };
  function _providerDisplayName(slug) {
    return _PROVIDER_NAMES[slug] || slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ');
  }
  function _providerSlug(mid) {
    const slash = mid.indexOf('/');
    let slug = slash > 0 ? mid.substring(0, slash) : 'other';
    return _PROVIDER_ALIAS[slug] || slug;
  }
  const _collapsedProviders = new Set(_loadList('odysseus-model-collapsed'));
  let _justExpandedProvider = null;

  function _populate(filter) {
    listEl.innerHTML = '';
    const all = _getAllModels();
    const q = (filter || '').trim().toLowerCase();
    const hasAnyModel = all.length > 0;
    listEl.classList.toggle('is-empty', !hasAnyModel);
    menu.classList.toggle('no-models', !hasAnyModel);
    if (search) {
      search.placeholder = hasAnyModel ? t('models.search_placeholder') : t('models.no_models_connected');
    }
    if (searchRow) {
      searchRow.classList.toggle('searching', !!q);
    }

    if (!hasAnyModel) return; // 空列表已折叠 — 无需渲染

    // 唯一查找表，使得 Recent/Favorites（存储为裸模型 ID）可以
    // 解析回完整的模型对象；丢弃不再提供的条目。
    const byId = new Map();
    all.forEach(m => { if (!byId.has(m.mid)) byId.set(m.mid, m); });

    const favs = _loadFavorites();

    function _addSection(label) {
      const el = document.createElement('div');
      el.className = 'mp-section-label';
      el.textContent = label;
      listEl.appendChild(el);
    }
    function _addEmpty(text) {
      const empty = document.createElement('div');
      empty.className = 'model-switch-empty';
      empty.textContent = text;
      listEl.appendChild(empty);
    }
    function _addRow(m) {
      const row = document.createElement('div');
      row.className = 'model-switch-item';
      if (m.stale) {
        row.classList.add('model-switch-stale');
        row.style.opacity = '0.45';
        row.title = t('models.local_server_offline', { reason: m.staleReason });
      }
      const _mlogo = providerLogo(m.mid);
      if (_mlogo) {
        const logoSpan = document.createElement('span');
        logoSpan.className = 'provider-logo';
        logoSpan.style.opacity = '0.6';
        logoSpan.innerHTML = _mlogo;
        row.appendChild(logoSpan);
      }
      const nameSpan = document.createElement('span');
      nameSpan.className = 'mp-model-name';
      nameSpan.textContent = m.display;
      // 过长的模型名称会被省略号截断 — 悬停时显示完整名称，以便
      // 后缀/变体标签仍可被查看 (#1982)。
      nameSpan.title = m.display;
      row.appendChild(nameSpan);
      // 离线状态已通过行的降低不透明度来传达 —
      // 在此之上再加一个冗余的"离线"标签只会增加杂乱。
      // (Class kept on `row` so the opacity rule still applies; the text
      // badge is gone.)
      const epSpan = document.createElement('span');
      epSpan.className = 'model-switch-ep';
      // 如果端点名称与模型名称匹配（本地自托管），则不显示端点名称
      const _epDisplay = m.epName && !m.display.toLowerCase().includes(m.epName.toLowerCase().split('/').pop()) ? m.epName : '';
      epSpan.textContent = _epDisplay;
      row.appendChild(epSpan);

      // 行内收藏圆点 — 切换收藏，不会选择模型。
      const favDot = document.createElement('button');
      favDot.type = 'button';
      favDot.className = 'mp-fav-dot' + (favs.includes(m.mid) ? ' active' : '');
      favDot.textContent = '●';
      const _setFavState = (on) => {
        favDot.classList.toggle('active', on);
        favDot.title = on ? t('models.remove_from_favorites') : t('models.add_to_favorites');
        favDot.setAttribute('aria-label', on ? t('models.remove_from_favorites') : t('models.add_to_favorites'));
        favDot.setAttribute('aria-pressed', on ? 'true' : 'false');
      };
      _setFavState(favs.includes(m.mid));
      favDot.addEventListener('click', (e) => {
        e.stopPropagation();
        const nowFav = _toggleFavorite(m.mid);
        _setFavState(nowFav);
        favDot.classList.remove('pulse');
        void favDot.offsetWidth;
        favDot.classList.add('pulse');
        // 保持内存副本同步，以便后续重新渲染正确。
        const idx = favs.indexOf(m.mid);
        if (nowFav && idx < 0) favs.push(m.mid);
        else if (!nowFav && idx >= 0) favs.splice(idx, 1);
        if (uiModule && uiModule.showToast) uiModule.showToast(nowFav ? t('models.favorited') : t('models.unfavorited'));
        // 浏览模式下，收藏部分成员发生了变化 — 重建列表
        // （开销很低：仅 Recent + Favorites）。搜索模式下行保持原位，
        // 所以上述原地收藏更新就足够了。
        if (!q) {
          const st = listEl.scrollTop;
          _populate('');
          listEl.scrollTop = st;
        }
      });
      row.appendChild(favDot);

      row.addEventListener('click', () => _pick(m));
      listEl.appendChild(row);
    }

    // ── 搜索模式：整个目录的扁平化过滤结果 ──
    if (q) {
      const matches = all.filter(m => {
        const provName = _providerDisplayName(_providerSlug(m.mid)).toLowerCase();
        return [m.mid, m.display, m.epName, m.providerText, provName]
          .filter(Boolean).join(' ').toLowerCase().includes(q);
      });
      if (matches.length === 0) _addEmpty(t('models.no_matching_models'));
      else matches.forEach(_addRow);
      return;
    }

    // ── Browse mode: Favorites (manual) + Recent (auto), with dedupe. ──
    // 规则：
    //   1. Never list the same model twice in the dropdown. Favorites
    //      win over Recent (if you favorited it, that's where it
    //      belongs — Recent shouldn't show it again as duplicate).
    //   2. 小型目录（≤ BROWSE_ALL_LIMIT）完全跳过最近使用部分 —
    //      section entirely — when there's only ~10 models, the whole
    //      list fits below as "All models" and a separate Recent
    //      section just duplicates rows.
    const shown = new Set();
    const favModels = favs.map(id => byId.get(id)).filter(Boolean);
    if (favModels.length) {
      _addSection(t('models.favorites'));
      favModels.forEach(m => { shown.add(m.mid); _addRow(m); });
    }
    // Recent: only render when the catalog is big enough that surfacing
    // a recency shortlist is actually useful, AND only models that
    // aren't already in Favorites (dedupe).
    if (all.length > BROWSE_ALL_LIMIT) {
      const recentModels = _loadRecent()
        .map(id => byId.get(id))
        .filter(Boolean)
        .filter(m => !shown.has(m.mid))
        .slice(0, RECENT_MAX);
      if (recentModels.length) {
        _addSection(t('models.recent'));
        recentModels.forEach(m => { shown.add(m.mid); _addRow(m); });
      }
    }

    // 小型目录：仍然列出所有内容，避免强迫用户只能搜索。
    if (all.length <= BROWSE_ALL_LIMIT) {
      const rest = all.filter(m => !shown.has(m.mid));
      if (rest.length) {
        if (shown.size) _addSection(t('models.all_models'));
        rest.forEach(_addRow);
      }
    } else {
      // 大型目录：显示带有可折叠分组的提供者分组。
      const rest = all.filter(m => !shown.has(m.mid));
      const groups = new Map();
      rest.forEach(m => {
        const slug = _providerSlug(m.mid);
        if (!groups.has(slug)) groups.set(slug, []);
        groups.get(slug).push(m);
      });
      const sorted = [...groups.keys()].sort((a, b) =>
        _providerDisplayName(a).localeCompare(_providerDisplayName(b)));

      sorted.forEach(provider => {
        const models = groups.get(provider);
        const isCollapsed = _collapsedProviders.has(provider);
        const header = document.createElement('div');
        header.className = 'mp-provider-header';
        header.innerHTML =
          `<svg class="mp-provider-chevron${isCollapsed ? ' collapsed' : ''}" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`
          + `<span class="mp-provider-name">${_providerDisplayName(provider)}</span>`
          + `<span class="mp-provider-count">${models.length}</span>`;
        header.addEventListener('click', (e) => {
          e.stopPropagation();
          if (_collapsedProviders.has(provider)) {
            _collapsedProviders.delete(provider);
            _justExpandedProvider = provider;
          } else {
            _collapsedProviders.add(provider);
            _justExpandedProvider = null;
          }
          _saveList('odysseus-model-collapsed', [..._collapsedProviders]);
          const st = listEl.scrollTop;
          _populate('');
          listEl.scrollTop = st;
        });
        listEl.appendChild(header);
        if (!isCollapsed) {
          const group = document.createElement('div');
          group.className = 'mp-provider-group' + (_justExpandedProvider === provider ? ' mp-just-expanded' : '');
          models.forEach(m => {
            _addRow(m);
            // 将刚追加的行移动到分组容器中
            group.appendChild(listEl.lastElementChild);
          });
          listEl.appendChild(group);
          if (_justExpandedProvider === provider) _justExpandedProvider = null;
        }
      });
    }
  }

  async function _pick(m) {
    const currentSessionId = _deps.getCurrentSessionId();
    const _pendingChat = _deps.getPendingChat();

    // 记住此次选择，以便下次打开选择器时在"最近使用"中显示 —
    // 这正是快速切换的全部意义。
    if (m && m.mid) _pushRecent(m.mid);

    // 立即广播，以便监听者（例如导览）无需等待后续的异步
    // session-create/PATCH 即可继续。
    try { document.dispatchEvent(new CustomEvent('odysseus:model-picked', { detail: m })); } catch {}

    // 关闭前取消搜索输入的焦点，以在移动设备上收起键盘
    if (document.activeElement) document.activeElement.blur();
    _close();
    // 重新聚焦主文本框 — 在移动设备上跳过以避免键盘弹跳
    if (window.innerWidth >= 768) {
      const _ta = document.getElementById('message');
      if (_ta) setTimeout(() => _ta.focus(), 50);
    }
    if (!currentSessionId && _pendingChat) {
      // 已有延迟会话 — 仅更新模型
      _deps.setPendingChat({ url: m.url, modelId: m.mid, endpointId: m.endpointId });
      // Header 保留为会话名称 — 模型切换仅更新选择器
      updateModelPicker();
      uiModule.showToast(t('models.using_model', { model: m.display }));;
      return;
    } else if (!currentSessionId) {
      // 尚无会话 — 使用此模型创建一个
      await _deps.createDirectChat(m.url, m.mid, m.endpointId);
    } else {
      // 已有会话但无模型 — PATCH 更新
      const fd = new FormData();
      fd.append('model', m.mid);
      fd.append('endpoint_url', m.url);
      if (m.endpointId) fd.append('endpoint_id', m.endpointId);
      try {
        const res = await fetch(`${API_BASE}/api/session/${currentSessionId}`, { method: 'PATCH', body: fd });
        if (!res.ok) {
          uiModule.showError(t('models.failed_to_set_model'));
          return;
        }
        const sessions = _deps.getSessions();
        const s = sessions.find(x => x.id === currentSessionId);
        if (s) { s.model = m.mid; s.endpoint_url = m.url; }
        // Header 保留为会话名称 — 模型信息仅在选择器中显示
      } catch (e) {
        uiModule.showError(t('models.failed_to_set_model') + ': ' + e);
        return;
      }
    }
    // 更新选择器可见性 — 模型已设置
    updateModelPicker();
    uiModule.showToast(`Using ${m.display}`);
  }

  document.addEventListener('odysseus:auto-select-model', async (e) => {
    const detail = (e && e.detail) || {};
    const currentSessionId = _deps.getCurrentSessionId();
    const sessions = _deps.getSessions();
    const current = sessions.find(x => x.id === currentSessionId);
    const pending = _deps.getPendingChat();
    if ((current && current.model) || (pending && pending.modelId)) return;

    if (window.modelsModule && window.modelsModule.refreshModels) {
      try { await window.modelsModule.refreshModels(true); } catch (_) {}
    }
    const items = window.modelsModule && window.modelsModule.getCachedItems ? window.modelsModule.getCachedItems() : [];
    const targetEndpointId = detail.endpointId ? String(detail.endpointId) : '';
    const targetModel = detail.modelId || '';
    let match = null;
    for (const item of items) {
      if (item.offline) continue;
      if (targetEndpointId && String(item.endpoint_id || '') !== targetEndpointId) continue;
      const models = (item.models || []).concat(item.models_extra || []);
      const displays = (item.models_display || []).concat(item.models_extra_display || []);
      const idx = targetModel ? models.indexOf(targetModel) : (models.length ? 0 : -1);
      if (idx >= 0) {
        match = {
          mid: models[idx],
          display: (displays[idx] || models[idx]).split('/').pop(),
          url: item.url || detail.url || '',
          endpointId: item.endpoint_id || detail.endpointId || '',
          epName: item.endpoint_name || detail.endpointName || '',
          providerText: [item.endpoint_name || detail.endpointName || '', item.url || detail.url || ''].filter(Boolean).join(' '),
        };
        break;
      }
    }
    if (!match && detail.modelId && detail.url) {
      match = {
        mid: detail.modelId,
        display: String(detail.modelId).split('/').pop(),
        url: detail.url,
        endpointId: detail.endpointId || '',
        epName: detail.endpointName || '',
        providerText: [detail.endpointName || '', detail.url || ''].filter(Boolean).join(' '),
      };
    }
    if (match) await _pick(match);
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden') || menu.classList.contains('closing')) {
      // 强制清除任何正在进行的关闭动画
      menu.classList.remove('closing', 'hidden');
      _populate('');
      if (window.modelsModule && window.modelsModule.refreshModels) {
        window.modelsModule.refreshModels().then(() => {
          if (!menu.classList.contains('hidden')) _populate(search.value || '');
          updateModelPicker();
        }).catch(() => {});
      }
      // Kick off a local-endpoint probe — when it returns, re-render
      // the list so stale local servers get dimmed. Cloud entries
      // aren't probed; they stay visible.
      _refreshLocalProbe().then(() => {
        if (!menu.classList.contains('hidden')) _populate(search.value || '');
      });
      if (window.innerWidth >= 768) search.focus();
      // 隐藏滚动按钮以避免重叠
      const _scrollBtn = document.getElementById('scroll-bottom-btn');
      if (_scrollBtn) _scrollBtn.style.display = 'none';
    } else {
      _close();
    }
  });

  search.addEventListener('input', () => _populate(search.value));
  search.addEventListener('click', (e) => e.stopPropagation());
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      refreshBtn.disabled = true;
      refreshBtn.classList.add('spinning');
      try {
        if (window.modelsModule && window.modelsModule.refreshModels) {
          await window.modelsModule.refreshModels(true);
        }
        await _refreshLocalProbe();
        if (!menu.classList.contains('hidden')) _populate(search.value || '');
        updateModelPicker();
      } catch (_) {
        uiModule.showToast('Model refresh failed');
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('spinning');
      }
    });
  }
  search.addEventListener('keydown', (e) => {
    _handlePickerKeydown(e, listEl, '.model-switch-item', _close);
  });
  const addModelsBtn = document.getElementById('model-picker-add-models-btn');
  if (addModelsBtn) {
    addModelsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _openPickerShortcut('models');
    });
  }
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn) {
      _close();
    }
  });
}

/**
 * 更新模型选择器标签以显示当前模型。
 * 始终可见 — 显示当前模型名称，如果没有则显示"选择模型"。
 * 在 selectSession、createDirectChat 和模型切换后调用。
 */
export function updateModelPicker() {
  if (!_deps) return;
  const label = document.getElementById('model-picker-label');
  if (!label) return;
  // 群聊激活时隐藏模型选择器
  const wrap = document.getElementById('model-picker-wrap');
  if (window.groupModule && window.groupModule.isActive()) {
    if (wrap) { wrap.style.display = 'none'; }
    return;
  }
  // 重置内联可见性（可能被之前会话中的输入隐藏了）
  if (wrap) {
    wrap.style.display = '';
    wrap.style.opacity = '';
    wrap.style.pointerEvents = '';
  }
  const currentSessionId = _deps.getCurrentSessionId();
  const sessions = _deps.getSessions();
  const _pendingChat = _deps.getPendingChat();
  const s = sessions.find(x => x.id === currentSessionId);
  let modelId = null;
  if (s && s.model) {
    modelId = s.model;
    if (!_modelExists(modelId, s.endpoint_url || '')) {
      modelId = null;
    }
  } else if (_pendingChat && _pendingChat.modelId) {
    modelId = _pendingChat.modelId;
    if (!_modelExists(modelId, _pendingChat.url || '')) {
      _deps.setPendingChat(null);
      modelId = null;
    }
  }
  // 安全：故意不在此处自动注入 `odysseus-model-favorites[0]`。
  // here. localStorage favorites are per-browser, not per-user, so on a
  // shared browser the previous account's first favorited model would
  // silently pre-populate the chatbox of the next user that signed in. If
  // we have no session model and no pending-chat pick, fall through to
  // the "Select model" placeholder below.

  // 检查所选模型是否仍然可用 — 仅对没有用户选择的待处理聊天进行回退
  // 绝不要覆盖已有会话的模型 — 那是用户明确选择的
  if (modelId && !currentSessionId && _pendingChat && window.modelsModule && window.modelsModule.getCachedItems) {
    const items = window.modelsModule.getCachedItems();
    const allAvailable = [];
    items.forEach(item => {
      if (item.offline) return;
      (item.models || []).concat(item.models_extra || []).forEach(m => allAvailable.push(m));
    });
    if (allAvailable.length > 0 && !allAvailable.includes(modelId)) {
      // 模型不再可用 — 切换到第一个可用的
      const fallback = items.find(item => !item.offline && (item.models || []).length > 0);
      if (fallback) {
        modelId = fallback.models[0];
        _deps.setPendingChat({ url: fallback.url, modelId, endpointId: fallback.endpoint_id });
      }
    }
  }
  if (!modelId && !_autoSelectingDefault && window.modelsModule && window.modelsModule.getCachedItems) {
    _ensureDefaultPendingChat();
  }

  const displayName = modelId ? modelId.split('/').pop() : t('models.select_model');
  // Header 指示器用省略号截断长名称；悬停时显示完整模型
  // 标识符 (#1982)。"选择模型"占位符上不显示提示。
  label.title = modelId || '';
  const logo = modelId ? providerLogo(modelId) : null;
  if (logo) {
    label.innerHTML = '<span class="model-picker-logo">' + logo + '</span> ' + displayName;
  } else {
    label.textContent = displayName;
  }
}
