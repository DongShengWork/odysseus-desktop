// static/js/models.js

/**
 * 模型和提供商管理
 */

import Storage from './storage.js';
import uiModule from './ui.js';
import sessionModule from './sessions.js';
import dragSortModule from './dragSort.js';
import spinnerModule from './spinner.js';
import { modelColor } from './chatRenderer.js';
import { providerLogo } from './providers.js';
import { sortModelIds } from './modelSort.js';
import { t } from './i18n.js';

let API_BASE = '';
let _cachedItems = []; // 缓存的 /api/models 数据，供模型切换下拉菜单使用
let _lastFetchTime = 0;
let _fetchInflight = null;
const _FETCH_CACHE_TTL = 30000; // /api/models 的 30 秒客户端缓存
const COLLAPSE_KEY = 'odysseus-models-collapsed';
const FAVORITES_KEY = 'odysseus-model-favorites';
const USAGE_KEY = 'odysseus-model-usage';
const SORT_KEY = 'odysseus-model-sort';

export function init(apiBase) {
  API_BASE = apiBase;
}

// ── 折叠状态持久化 ──
function _loadCollapsed() {
  return Storage.getJSON(COLLAPSE_KEY, {});
}
function _saveCollapsed(state) {
  Storage.setJSON(COLLAPSE_KEY, state);
}

// ── 收藏持久化 ──
function _loadFavorites() {
  return Storage.getJSON(FAVORITES_KEY, []);
}
function _saveFavorites(list) {
  Storage.setJSON(FAVORITES_KEY, list);
}
function _isFavorite(mid) {
  return _loadFavorites().includes(mid);
}
function _toggleFavorite(mid) {
  const favs = _loadFavorites();
  const idx = favs.indexOf(mid);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push(mid);
  _saveFavorites(favs);
  return idx < 0; // 返回 true 表示当前已被收藏
}

// ── 使用统计追踪 ──
function _loadUsage() {
  return Storage.getJSON(USAGE_KEY, {});
}
function _trackUsage(mid) {
  const usage = _loadUsage();
  if (!usage[mid]) usage[mid] = { count: 0, last: 0 };
  usage[mid].count++;
  usage[mid].last = Date.now();
  Storage.setJSON(USAGE_KEY, usage);
}
function _getSortMode() {
  return Storage.get(SORT_KEY, '');
}
function _setSortMode(mode) {
  Storage.set(SORT_KEY, mode);
}

/**
 * 构建单个模型行元素。
 */
function _startChat(url, mid, endpointId) {
  // 在对比模式激活时阻止模型切换
  if (window.compareModule && window.compareModule.isActive()) return;
  _trackUsage(mid);
  if (sessionModule) {
    sessionModule.createDirectChat(url, mid, endpointId);
  } else if (uiModule) {
    uiModule.showError(t('models.session_module_not_loaded'));
  }
}

function _buildModelRow(mid, url, displayName, endpointId, offline, modelType) {
  const row = document.createElement('div');
  row.className = 'models-row' + (offline ? ' models-row-offline' : '');
  row.setAttribute('data-model-id', mid);
  if (modelType === 'image') row.setAttribute('data-model-type', 'image');

  const handle = document.createElement('span');
  handle.className = 'item-drag-handle';
  handle.textContent = '\u22EE\u22EE';
  handle.title = '拖动排序';
  row.appendChild(handle);

  // 收藏指示器 — 提供商 logo 或彩色圆点
  const fav = document.createElement('span');
  const _favColor = modelColor(mid);
  const _logo = providerLogo(mid);
  if (_logo) {
    fav.className = 'model-fav-btn provider-logo' + (_isFavorite(mid) ? ' active' : '');
    fav.innerHTML = _logo;
    fav.style.opacity = '0.4';
  } else {
    fav.className = 'model-fav-btn' + (_isFavorite(mid) ? ' active' : '');
  }
  fav.title = '切换收藏';
  fav.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowFav = _toggleFavorite(mid);
    fav.classList.toggle('active', nowFav);
    uiModule.showToast(nowFav ? t('models.favorited') : t('models.unfavorited'));
    refreshModels();
  });
  const span = document.createElement('span');
  span.className = 'grow';
  span.textContent = displayName.split('/').pop();
  if (modelType === 'image') {
    const badge = document.createElement('span');
    badge.className = 'model-type-badge';
    badge.textContent = 'IMG';
    badge.title = '图像生成模型';
    badge.style.cssText = 'font-size:0.65em;padding:1px 4px;border-radius:3px;background:var(--accent,#7c3aed);color:#fff;margin-left:6px;vertical-align:middle;';
    span.appendChild(badge);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = offline ? t('models.offline') : (modelType === 'image' ? t('models.add_image') : t('models.add_chat'));
  btn.className = 'model-chat-btn';
  btn.style.transition = 'all 0.2s ease';
  if (offline) {
    btn.disabled = true;
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
  } else {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _startChat(url, mid, endpointId);
    });
  }

  // 点击行中的任意位置（拖拽手柄和收藏按钮除外）即可开始对话
  if (!offline) {
    let _touchMoved = false;
    row.addEventListener('touchstart', () => { _touchMoved = false; }, { passive: true });
    row.addEventListener('touchmove', () => { _touchMoved = true; }, { passive: true });
    row.addEventListener('click', (e) => {
      if (e.target.closest('.item-drag-handle') || e.target.closest('.model-fav-btn')) return;
      if (_touchMoved) { _touchMoved = false; return; }
      _startChat(url, mid, endpointId);
    });
  }

  row.appendChild(fav);
  row.appendChild(span);
  row.appendChild(btn);
  return row;
}

export async function refreshModels(force = false) {
  const box = document.getElementById('models');
  if (!box) return;

  // 如果缓存未过期且不是强制刷新，跳过网络请求 — 但仍重新渲染 UI
  const now = Date.now();
  const needsFetch = force || _cachedItems.length === 0 || (now - _lastFetchTime) >= _FETCH_CACHE_TTL;

  box.innerHTML = '';
  if (needsFetch) {
    const _loadingSpinner = spinnerModule.create('', 'right', 'wave');
    box.appendChild(_loadingSpinner.createElement());
    _loadingSpinner.start();
    try {
      if (!_fetchInflight) {
        // 在强制刷新时传递 ?refresh=true，这样后端的 30 秒
        // 每用户缓存也会被绕过。否则 `force=true`
        // 只清除前端缓存，同样的过期列表还是会返回
        // — 新服务的端点不会出现，直到缓存本身过期。
        // （Bug 复现场景：启动一个模型，选择器在约 30 秒内都是空的，
        // 即使端点已在数据库中并且在线。）
        const _url = `${API_BASE}/api/models` + (force ? '?refresh=true' : '');
        _fetchInflight = fetch(_url, { credentials: 'same-origin' })
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .finally(() => { _fetchInflight = null; });
      }
      const data = await _fetchInflight;
      _lastFetchTime = Date.now();
      _cachedItems = data.items || [];
    } catch (e) {
      console.error(e);
      box.textContent = '(' + t('models.scan_failed') + ')';
      return;
    } finally {
      box.innerHTML = '';
    }
  }
  try {

    const collapseState = _loadCollapsed();
    let groupIdx = 0; // 拖拽排序容器的唯一 ID 计数器

    // 按类别 → 端点分组收集模型
    const groups = { local: {}, api: {} };
    // 同时追踪每个端点的额外（非精选）模型
    const extraGroups = { local: {}, api: {} };
    if (_cachedItems && _cachedItems.length > 0) {
      _cachedItems.forEach(item => {
        const cat = item.category === 'local' ? 'local' : 'api';
        const epName = item.endpoint_name || t('models.unknown');
        const isOffline = !!item.offline;
        if (!groups[cat][epName]) groups[cat][epName] = [];
        if (!extraGroups[cat][epName]) extraGroups[cat][epName] = [];
        const displayNames = item.models_display || item.models || [];
        const epModelType = item.model_type || 'llm';
        (item.models || []).forEach((mid, i) => {
          groups[cat][epName].push({
            mid, url: item.url,
            displayName: displayNames[i] || mid,
            endpointId: item.endpoint_id || null,
            offline: isOffline,
            modelType: epModelType,
          });
        });
        // 服务器返回的额外（非精选）模型
        const extraDisplayNames = item.models_extra_display || item.models_extra || [];
        (item.models_extra || []).forEach((mid, i) => {
          extraGroups[cat][epName].push({
            mid, url: item.url,
            displayName: extraDisplayNames[i] || mid,
            endpointId: item.endpoint_id || null,
            offline: isOffline,
            modelType: epModelType,
          });
        });
      });
    }

    // ── 在顶部渲染收藏区域 ──
    const favs = _loadFavorites();
    if (favs.length > 0) {
      const favModels = [];
      // 从所有分组中收集已收藏的模型（同时在原始分组中保留）
      for (const cat of ['local', 'api']) {
        for (const [epName, epModels] of Object.entries(groups[cat])) {
          for (const m of epModels) {
            if (favs.includes(m.mid)) {
              favModels.push(m);
            }
          }
        }
      }
      // 按当前排序模式排列收藏，默认按收藏顺序
      const favSort = _getSortMode();
      if (favSort === 'alpha') {
        favModels.sort((a, b) => a.displayName.split('/').pop().localeCompare(b.displayName.split('/').pop()));
      } else if (favSort === 'last-used') {
        const usage = _loadUsage();
        favModels.sort((a, b) => ((usage[b.mid] || {}).last || 0) - ((usage[a.mid] || {}).last || 0));
      } else if (favSort === 'most-used') {
        const usage = _loadUsage();
        favModels.sort((a, b) => ((usage[b.mid] || {}).count || 0) - ((usage[a.mid] || {}).count || 0));
      } else {
        favModels.sort((a, b) => favs.indexOf(a.mid) - favs.indexOf(b.mid));
      }

      if (favModels.length > 0) {
        const favHeader = document.createElement('div');
        favHeader.className = 'models-category-header';
        const favToggle = document.createElement('span');
        favToggle.className = 'folder-toggle';
        const favCollapsed = collapseState['cat:favorites'] === true;
        favToggle.textContent = favCollapsed ? '\u25B6' : '\u25BC';
        favHeader.appendChild(favToggle);
        const favLabel = document.createElement('span');
        favLabel.textContent = t('models.favorites');
        favHeader.appendChild(favLabel);
        const favCount = document.createElement('span');
        favCount.className = 'folder-count';
        favCount.textContent = '(' + favModels.length + ')';
        favHeader.appendChild(favCount);
        favHeader.addEventListener('click', () => {
          const s = _loadCollapsed();
          s['cat:favorites'] = !favCollapsed;
          _saveCollapsed(s);
          refreshModels();
        });
        box.appendChild(favHeader);

        if (!favCollapsed) {
          const favContainer = document.createElement('div');
          favContainer.className = 'models-group-content';
          favContainer.id = 'models-group-' + (groupIdx++);
          favModels.forEach(({ mid, url, displayName, endpointId, offline, modelType }) => {
            favContainer.appendChild(_buildModelRow(mid, url, displayName, endpointId, offline, modelType));
          });
          box.appendChild(favContainer);
        }
      }
    }

    const localCount = Object.values(groups.local).reduce((s, a) => s + a.length, 0);
    const apiCount = Object.values(groups.api).reduce((s, a) => s + a.length, 0);
    const hasMultipleCategories = localCount > 0 && apiCount > 0;
    const needsGrouping = hasMultipleCategories ||
      Object.keys(groups.local).length > 1 || Object.keys(groups.api).length > 1;

    const categoryOrder = [
      { key: 'local', label: 'Local' },
      { key: 'api', label: 'API' },
    ];

    categoryOrder.forEach(({ key, label }) => {
      const endpoints = groups[key];
      const models = Object.values(endpoints).flat();
      if (models.length === 0) return;

      const multiEndpoints = Object.keys(endpoints).length > 1;

      // --- 类别级可折叠分组 ---
      if (hasMultipleCategories) {
        const catCollapsed = collapseState['cat:' + key] === true;

        const header = document.createElement('div');
        header.className = 'models-category-header';

        const toggle = document.createElement('span');
        toggle.className = 'folder-toggle';
        toggle.textContent = catCollapsed ? '\u25B6' : '\u25BC';
        header.appendChild(toggle);

        const labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        header.appendChild(labelSpan);

        const count = document.createElement('span');
        count.className = 'folder-count';
        count.textContent = '(' + models.length + ')';
        header.appendChild(count);

        header.addEventListener('click', () => {
          const s = _loadCollapsed();
          s['cat:' + key] = !catCollapsed;
          _saveCollapsed(s);
          refreshModels();
        });

        box.appendChild(header);

        if (catCollapsed) return;
      }

      // --- 端点子分组 ---
      const extraEndpoints = extraGroups[key];
      Object.entries(endpoints).forEach(([epName, epModels]) => {
        const epExtra = extraEndpoints[epName] || [];
        const totalCount = epModels.length + epExtra.length;
        const isOfflineEndpoint = epModels.length > 0 && epModels[0].offline;

        if (multiEndpoints) {
          const epKey = 'ep:' + key + ':' + epName;
          const epCollapsed = collapseState[epKey] === true;

          const sub = document.createElement('div');
          sub.className = 'models-endpoint-label';

          const epToggle = document.createElement('span');
          epToggle.className = 'folder-toggle';
          epToggle.textContent = epCollapsed ? '\u25B6' : '\u25BC';
          sub.appendChild(epToggle);

          const epLabel = document.createElement('span');
          epLabel.textContent = epName;
          sub.appendChild(epLabel);

          if (isOfflineEndpoint) {
            const badge = document.createElement('span');
            badge.className = 'endpoint-offline-badge';
            badge.textContent = '(' + t('models.offline') + ')';
            sub.appendChild(badge);
          }

          const epCount = document.createElement('span');
          epCount.className = 'folder-count';
          epCount.textContent = '(' + totalCount + ')';
          sub.appendChild(epCount);

          sub.addEventListener('click', () => {
            const s = _loadCollapsed();
            s[epKey] = !epCollapsed;
            _saveCollapsed(s);
            refreshModels();
          });

          box.appendChild(sub);

          if (epCollapsed) return;
        }

        // 将模型行渲染到容器中
        let target;
        if (needsGrouping) {
          target = document.createElement('div');
          target.className = 'models-group-content';
          target.id = 'models-group-' + (groupIdx++);
          if (multiEndpoints) target.classList.add('indented');
        } else {
          target = box;
        }

        // 应用排序模式
        const sortMode = _getSortMode();
        if (sortMode === 'alpha') {
          epModels.sort((a, b) => a.displayName.split('/').pop().localeCompare(b.displayName.split('/').pop()));
        } else if (sortMode === 'last-used') {
          const usage = _loadUsage();
          epModels.sort((a, b) => ((usage[b.mid] || {}).last || 0) - ((usage[a.mid] || {}).last || 0));
        } else if (sortMode === 'most-used') {
          const usage = _loadUsage();
          epModels.sort((a, b) => ((usage[b.mid] || {}).count || 0) - ((usage[a.mid] || {}).count || 0));
        }

        // 显示最多 MAX_VISIBLE 个模型，其余的通过"显示更多"折叠
        const MAX_VISIBLE = 5;
        const visible = epModels.slice(0, MAX_VISIBLE);
        const overflow = epModels.slice(MAX_VISIBLE);
        const allHidden = [...overflow, ...epExtra];

        visible.forEach(({ mid, url, displayName, endpointId, offline, modelType }) => {
          target.appendChild(_buildModelRow(mid, url, displayName, endpointId, offline, modelType));
        });

        if (allHidden.length > 0) {
          const showMoreBtn = document.createElement('div');
          showMoreBtn.className = 'models-show-all-btn';
          showMoreBtn.style.cssText = 'text-align:center;padding:6px;opacity:0.5;cursor:pointer;font-size:0.82em;';
          showMoreBtn.textContent = t('models.show_more', { count: allHidden.length });
          showMoreBtn._target = target;
          showMoreBtn.addEventListener('click', () => {
            showMoreBtn.remove();
            allHidden.forEach(({ mid, url, displayName, endpointId, offline, modelType }) => {
              target.appendChild(_buildModelRow(mid, url, displayName, endpointId, offline, modelType));
            });
          });
          target.appendChild(showMoreBtn);
        }

        if (needsGrouping) box.appendChild(target);
      });
    });

    // 在启用拖拽排序之前，恢复扁平列表的保存排序
    if (!needsGrouping) {
      const savedModelOrder = Storage.getJSON('models-order', []);
      if (savedModelOrder.length) {
        const rowMap = new Map();
        box.querySelectorAll('.models-row').forEach(r => {
          const mid = r.dataset.modelId;
          if (mid) rowMap.set(mid, r);
        });
        const ordered = [];
        savedModelOrder.forEach(mid => {
          if (rowMap.has(mid)) {
            ordered.push(rowMap.get(mid));
            rowMap.delete(mid);
          }
        });
        // 将未在保存顺序中的剩余行追加到最后
        rowMap.forEach(r => ordered.push(r));
        ordered.forEach(r => box.appendChild(r));
      }
    }

    // 启用拖拽排序
    if (dragSortModule) {
      if (!needsGrouping) {
        // 扁平列表 — 对整个 #models 容器排序
        dragSortModule.enable('models', '.models-row', {
          handleSelector: '.item-drag-handle',
          storageKey: 'models-order',
        });
      } else {
        // 分组模式 — 在每个分组容器内启用排序
        box.querySelectorAll('.models-group-content').forEach(gc => {
          dragSortModule.enable(gc.id, '.models-row', {
            handleSelector: '.item-drag-handle',
          });
        });
      }
    }

    // ── 搜索框（当总模型数 >= 5 时显示，包括隐藏的溢出模型）──
    const totalModelCount = (_cachedItems || []).reduce((n, item) => {
      if (item.offline) return n;
      return n + (item.models || []).length + (item.models_extra || []).length;
    }, 0);
    if (totalModelCount >= 10) {
      const searchBox = document.createElement('input');
      searchBox.type = 'text';
      searchBox.placeholder = '搜索模型…';
      searchBox.className = 'model-search-input';
      searchBox.addEventListener('click', (e) => e.stopPropagation());
      searchBox.addEventListener('touchstart', (e) => e.stopPropagation());
      // 扁平搜索结果容器（从 _cachedItems 渲染，忽略折叠状态）
      const searchResults = document.createElement('div');
      searchResults.className = 'models-search-results';
      searchResults.style.display = 'none';
      box.appendChild(searchResults);

      searchBox.addEventListener('input', () => {
        const q = searchBox.value.toLowerCase().trim();
        if (!q) {
          // 清除搜索：隐藏搜索结果，恢复正常分组
          searchResults.style.display = 'none';
          searchResults.innerHTML = '';
          for (const ch of box.children) {
            if (ch !== searchBox && ch !== searchResults) ch.style.display = '';
          }
          return;
        }
        // 隐藏所有正常分组/标题，显示扁平搜索结果
        for (const ch of box.children) {
          if (ch !== searchBox && ch !== searchResults) ch.style.display = 'none';
        }
        searchResults.innerHTML = '';
        searchResults.style.display = '';
        // 从所有缓存模型构建扁平结果
        (_cachedItems || []).forEach(item => {
          if (item.offline) return;
          const allModels = (item.models || []).concat(item.models_extra || []);
          const allDisplay = (item.models_display || []).concat(item.models_extra_display || item.models_extra || []);
          allModels.forEach((mid, i) => {
            const display = allDisplay[i] || mid;
            if (!mid.toLowerCase().includes(q) && !display.toLowerCase().includes(q)) return;
            searchResults.appendChild(
              _buildModelRow(mid, item.url, display, item.endpoint_id || null, false, item.model_type || 'llm')
            );
          });
        });
        if (searchResults.children.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'text-align:center;padding:12px;opacity:0.4;';
          empty.textContent = t('models.no_models_match', { query: searchBox.value.trim() });
          searchResults.appendChild(empty);
        }
      });
      box.insertBefore(searchBox, box.firstChild);
    }

    if (!_cachedItems || _cachedItems.length === 0) {
      const noModels = document.createElement('div');
      noModels.className = 'models-empty-state';
      if (window._isAdmin) {
        noModels.innerHTML = '<span class="muted">' + t('models.no_models_found') + '</span><br>'
          + '<a href="#" onclick="document.getElementById(\'user-bar-admin\')?.click();return false;" class="accent-link">' + t('models.open_admin_add_endpoints') + '</a>'
          + '<br><span class="muted-sm">' + t('models.type_setup_hint') + '</span>';
      } else {
        noModels.innerHTML = '<span class="muted">' + t('models.no_models_available') + '</span><br>'
          + '<span class="muted-sm">' + t('models.ask_admin_configure') + '</span>';
      }
      box.appendChild(noModels);
      // 还没有端点：让欢迎界面聚焦于首次设置。
      const welcomeSub = document.getElementById('welcome-sub');
      if (welcomeSub) welcomeSub.innerHTML = t('models.welcome_setup_html');
      const welcomeTip = document.getElementById('welcome-tip');
      if (welcomeTip) welcomeTip.textContent = t('models.welcome_tip_setup');
    } else {
      // 已配置的安装应该感觉就绪，而不是卡在入门引导中。
      const welcomeSub = document.getElementById('welcome-sub');
      if (welcomeSub) welcomeSub.textContent = t('models.welcome_voyage');
      const welcomeTip = document.getElementById('welcome-tip');
      if (welcomeTip) {
        const tips = window.innerWidth <= 768
          ? [
              t('models.tip_long_press_session'),
              t('models.tip_nobody_mode'),
              t('models.tip_agent_mode'),
              t('models.tip_attach_button'),
            ]
          : [
              t('models.tip_ctrl_k_search'),
              t('models.tip_ctrl_b_sidebar'),
              t('models.tip_shift_click_sidebar'),
              t('models.tip_drag_drop_files'),
              t('models.tip_right_click_session'),
            ];
        welcomeTip.textContent = tips[Math.floor(Math.random() * tips.length)];
      }
    }
  } catch (e) {
    console.error(e);
    box.textContent = '(' + t('models.render_failed') + ': ' + e.message + ')';
  }
}

/**
 * 刷新并显示 OpenAI 提供商
 */
export async function refreshProviders() {
  const sel = document.getElementById('openai-model');
  if (!sel) return; // 如果元素不存在则退出

  sel.innerHTML = '<option disabled>' + t('models.loading_providers') + '</option>';

  try {
    const res = await fetch(`${API_BASE}/api/providers`);
    const data = await res.json();
    const openai = (data.providers || []).find(p => p.provider === 'openai');

    sel.innerHTML = '';

    if (openai) {
      const models = (openai.items?.[0]?.models) || [];
      sortModelIds(models).forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        sel.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(' + t('models.openai_key_not_set') + ')';
      sel.appendChild(opt);
    }
  } catch (e) {
    console.error(e);
  }
}

export function getCachedItems() { return _cachedItems; }

const modelsModule = {
  init,
  refreshModels,
  refreshProviders,
  getCachedItems,
};

export default modelsModule;
window.modelsModule = modelsModule;
