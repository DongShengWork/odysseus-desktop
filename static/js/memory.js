// 内存管理功能
// 本模块处理所有内存相关操作

import uiModule from './ui.js';
import sessionModule from './sessions.js';
import spinnerModule from './spinner.js';
import { makeWindowDraggable } from './windowDrag.js';
import { snapModalToZone } from './tileManager.js';
import { t } from './i18n.js';

var escapeHtml = uiModule.esc;

let memories = [];
let activeCategory = 'all';
let sortOrder = 'newest';
let selectMode = false;
let selectedIds = new Set();


const MEMORY_CATEGORIES = ['fact', 'identity', 'preference', 'contact', 'project', 'goal', 'task'];

function _ensureNewMemoryCategorySelect() {
  const sel = document.getElementById('new-memory-category');
  if (!sel || sel.dataset.wired === '1') return;
  sel.dataset.wired = '1';
  MEMORY_CATEGORIES.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    if (cat === 'fact') opt.selected = true;
    sel.appendChild(opt);
  });
}

function _readNewMemoryCategory() {
  _ensureNewMemoryCategorySelect();
  const sel = document.getElementById('new-memory-category');
  const cat = sel?.value || 'fact';
  return MEMORY_CATEGORIES.includes(cat) ? cat : 'fact';
}

let _memoryDragWired = false;
function _wireMemoryDrag() {
  if (_memoryDragWired) return;
  const modal = document.getElementById('memory-modal');
  const content = modal && modal.querySelector('.modal-content');
  const header = modal && modal.querySelector('.modal-header');
  if (!modal || !content || !header) return;
  _memoryDragWired = true;
  makeWindowDraggable(modal, {
    content,
    header,
    skipSelector: 'button, input, select, label',
    enableDock: true,
    enableLeftDock: true,
    onEnterFullscreen: () => {
      snapModalToZone(modal, {
        name: 'fullscreen',
        rect: {
          left: 0,
          top: 0,
          width: window.innerWidth || document.documentElement.clientWidth || 0,
          height: window.innerHeight || document.documentElement.clientHeight || 0,
        },
      });
    },
  });
}

function relativeTime(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return t('brain.relative_just_now');
  if (diff < 3600) return t('brain.relative_m_ago', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('brain.relative_h_ago', { n: Math.floor(diff / 3600) });
  if (diff < 604800) return t('brain.relative_d_ago', { n: Math.floor(diff / 86400) });
  if (diff < 2592000) return t('brain.relative_w_ago', { n: Math.floor(diff / 604800) });
  if (diff < 31536000) return t('brain.relative_mo_ago', { n: Math.floor(diff / 2592000) });
  return t('brain.relative_y_ago', { n: Math.floor(diff / 31536000) });
}

function buildCategoryChips() {
  const container = document.getElementById('memory-category-filters');
  if (!container) return;

  // 当没有记忆时完全隐藏标签行——没有内容可筛选时显示"全部"标签没有意义。
  if (!memories.length) { container.innerHTML = ''; return; }

  const cats = new Set(memories.map(m => m.category || 'fact'));
  const sorted = ['all', ...Array.from(cats).sort()];

  container.innerHTML = '';
  sorted.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'memory-cat-chip' + (cat === activeCategory ? ' active' : '');
    btn.dataset.cat = cat;
    btn.textContent = cat;
    btn.addEventListener('click', () => {
      activeCategory = cat;
      container.querySelectorAll('.memory-cat-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderMemoryList();
      updateMemoryCount();
    });
    container.appendChild(btn);
  });
}

async function syncToggles() {
  // 设置标签页不再单独托管"上下文中的记忆"开关——头部开关现在直接管理该偏好设置。
  await syncPrefToggle('memory-enabled-header-toggle', 'memory_enabled', t('brain.memory_enabled'), t('brain.memory_disabled'), false);
  // 技能头部开关管理 'skills_enabled' 偏好设置（此前从未连线——切换它没有任何效果，所以技能一直开启）。
  // 现在它真正控制技能注入（参见 chat_helpers.py: uprefs.skills_enabled）。
  await syncPrefToggle('skills-enabled-header-toggle', 'skills_enabled', t('brain.skills_enabled_msg'), t('brain.skills_disabled_msg'), false);
  await syncPrefToggle('auto-memory-toggle', 'auto_memory', 'Auto-extract memories enabled', 'Auto-extract memories disabled', false);
  await syncPrefToggle('auto-skills-toggle', 'auto_skills', 'Auto-extract skills enabled', 'Auto-extract skills disabled', false);
  await syncPrefToggle('auto-approve-skills-toggle', 'auto_approve_skills', t('brain.auto_approve_on'), t('brain.auto_approve_off'), false);
  await syncPrefSlider('skill-confidence-slider', 'skill_min_confidence', 'skill-confidence-label', 0.85);
  await syncPrefNumber('skill-max-input', 'skill_max_injected', 3);

  // 将头部开关状态反映到侧边栏变暗 + 模态框主体透明度。
  const headerToggle = document.getElementById('memory-enabled-header-toggle');
  if (headerToggle) {
    const modalBody = document.querySelector('.memory-modal-body');
    if (modalBody) modalBody.style.opacity = headerToggle.checked ? '' : '0.3';
    reflectMemoryToggleInSidebar(headerToggle.checked);
    if (!headerToggle.dataset.boundUx) {
      headerToggle.dataset.boundUx = '1';
      headerToggle.addEventListener('change', () => {
        if (modalBody) modalBody.style.opacity = headerToggle.checked ? '' : '0.3';
        reflectMemoryToggleInSidebar(headerToggle.checked);
      });
    }
  }

  // 对技能开关采用相同的变暗处理——关闭时使技能面板变暗。
  const skillsToggle = document.getElementById('skills-enabled-header-toggle');
  if (skillsToggle) {
    const skillsPanel = document.querySelector('[data-memory-panel="skills"]');
    const applyDim = () => { if (skillsPanel) skillsPanel.style.opacity = skillsToggle.checked ? '' : '0.3'; };
    applyDim();
    if (!skillsToggle.dataset.boundUx) {
      skillsToggle.dataset.boundUx = '1';
      skillsToggle.addEventListener('change', applyDim);
    }
  }
}

function reflectMemoryToggleInSidebar(enabled) {
  const btn = document.getElementById('tool-memory-btn');
  if (btn) btn.classList.toggle('tool-disabled', !enabled);
}

function syncToggleDim(toggle) {
  const card = toggle.closest('.admin-card');
  if (!card) return;
  const toggleRow = toggle.closest('div[style*="justify-content"]');
  let sibling = toggleRow ? toggleRow.nextElementSibling : null;
  while (sibling) {
    sibling.style.opacity = toggle.checked ? '' : '0.35';
    sibling.style.pointerEvents = toggle.checked ? '' : 'none';
    sibling = sibling.nextElementSibling;
  }
}

/** 加载/保存由浮点数偏好支持的置信度滑块（0 = "全部"，否则 0.50–1.00）。
 *  滑块位置为百分比；最大位置表示"全部"（无最小值），向下滑动则设为 95%、90%、85%… */
async function syncPrefSlider(elementId, prefKey, labelId, defaultVal) {
  const slider = document.getElementById(elementId);
  if (!slider) return;
  const label = labelId ? document.getElementById(labelId) : null;
  const maxPos = Number(slider.max);
  const fmt = (pos) => (Number(pos) >= maxPos ? 'All' : `≥ ${pos}%`);
  try {
    const res = await fetch(`${window.location.origin}/api/prefs/${prefKey}`);
    if (res.ok) {
      const data = await res.json();
      let pref = (data.value === undefined || data.value === null) ? defaultVal : Number(data.value);
      // pref 0（或假值）= "All" → 最大滑块位置；否则为百分比。
      let pos = (!pref || pref <= 0) ? maxPos : Math.round(pref * 100);
      pos = Math.max(Number(slider.min), Math.min(maxPos, pos));
      slider.value = String(pos);
    }
  } catch (e) {
    console.error(`Failed to load ${prefKey} pref:`, e);
  }
  if (label) label.textContent = fmt(slider.value);
  if (!slider.dataset.bound) {
    slider.dataset.bound = '1';
    slider.addEventListener('input', () => { if (label) label.textContent = fmt(slider.value); });
    slider.addEventListener('change', async () => {
      const pos = Number(slider.value);
      const pref = pos >= maxPos ? 0 : pos / 100;
      try {
        const res = await fetch(`${window.location.origin}/api/prefs/${prefKey}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: pref })
        });
        if (!res.ok) { showError(t('brain.pref_save_failed')); return; }
        showToast(pref === 0 ? 'Skill confidence: All' : `Skill confidence ≥ ${Math.round(pref * 100)}%`);
      } catch (e) {
        console.error(`Failed to save ${prefKey} pref:`, e);
        showError(t('brain.pref_save_failed'));
      }
    });
  }
}

/** 加载/保存由 <input type="number"> 支持的整数值偏好设置。 */
async function syncPrefNumber(elementId, prefKey, defaultVal) {
  const input = document.getElementById(elementId);
  if (!input) return;
  const clamp = (raw) => {
    let v = parseInt(raw, 10);
    if (isNaN(v)) v = defaultVal;
    const lo = Number(input.min), hi = Number(input.max);
    if (!isNaN(lo)) v = Math.max(lo, v);
    if (!isNaN(hi)) v = Math.min(hi, v);
    return v;
  };
  try {
    const res = await fetch(`${window.location.origin}/api/prefs/${prefKey}`);
    if (res.ok) {
      const data = await res.json();
      input.value = String((data.value === undefined || data.value === null) ? defaultVal : clamp(data.value));
    }
  } catch (e) {
    console.error(`Failed to load ${prefKey} pref:`, e);
  }
  if (!input.dataset.bound) {
    input.dataset.bound = '1';
    input.addEventListener('change', async () => {
      const v = clamp(input.value);
      input.value = String(v);
      try {
        const res = await fetch(`${window.location.origin}/api/prefs/${prefKey}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: v })
        });
        if (!res.ok) { showError(t('brain.pref_save_failed')); return; }
        showToast(v === 0 ? t('brain.no_skills_injected') : `Max injected skills: ${v}`);
      } catch (e) {
        console.error(`Failed to save ${prefKey} pref:`, e);
        showError(t('brain.pref_save_failed'));
      }
    });
  }
}

async function syncPrefToggle(elementId, prefKey, onMsg, offMsg, dimBelow = true) {
  const toggle = document.getElementById(elementId);
  if (!toggle) return;
  try {
    const res = await fetch(`${window.location.origin}/api/prefs/${prefKey}`);
    if (res.ok) {
      const data = await res.json();
      toggle.checked = data.value !== false;
    }
  } catch (e) {
    console.error(`Failed to load ${prefKey} pref:`, e);
  }
  if (dimBelow) syncToggleDim(toggle);
  if (!toggle.dataset.bound) {
    toggle.dataset.bound = '1';
    toggle.addEventListener('change', async () => {
      if (dimBelow) syncToggleDim(toggle);
      try {
        const res = await fetch(`${window.location.origin}/api/prefs/${prefKey}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: toggle.checked })
        });
        if (!res.ok) {
          console.error(`PUT ${prefKey} returned ${res.status}`);
          toggle.checked = !toggle.checked; // 恢复原值
          if (dimBelow) syncToggleDim(toggle);
          showError(t('brain.pref_save_failed'));
          return;
        }
        showToast(toggle.checked ? onMsg : offMsg);
      } catch (e) {
        console.error(`Failed to save ${prefKey} pref:`, e);
        toggle.checked = !toggle.checked; // 恢复原值
        if (dimBelow) syncToggleDim(toggle);
        showError(t('brain.pref_save_failed'));
      }
    });
  }
}

export async function loadMemories() {
  _ensureNewMemoryCategorySelect();
  try {
    const response = await fetch(`${window.location.origin}/api/memory`);

    if (!response.ok) {
      console.error('Memory fetch failed with status:', response.status);
      memories = [];
      buildCategoryChips();
      renderMemoryList();
      updateMemoryCount();
      syncToggles();
      return;
    }

    const data = await response.json();

    if (data && data.memory) {
      memories = data.memory;
    } else if (Array.isArray(data)) {
      memories = data;
    } else {
      memories = [];
    }

    buildCategoryChips();
    renderMemoryList();
    updateMemoryCount();
  } catch (error) {
    console.error('Failed to load memories:', error);
    memories = [];
    buildCategoryChips();
    renderMemoryList();
    updateMemoryCount();
  }
  // 始终连接开关，即使内存 API 失败
  syncToggles();
}

// ---- 批量选择模式 ----

function enterSelectMode() {
  selectMode = true;
  selectedIds.clear();
  const bulkBar = document.getElementById('memory-bulk-bar');
  const selectBtn = document.getElementById('memory-select-btn');
  if (bulkBar) bulkBar.classList.remove('hidden');
  if (selectBtn) { selectBtn.classList.add('active'); selectBtn.textContent = 'Cancel'; }
  updateBulkCount();
  renderMemoryList();
}

function exitSelectMode() {
  selectMode = false;
  selectedIds.clear();
  const bulkBar = document.getElementById('memory-bulk-bar');
  const selectBtn = document.getElementById('memory-select-btn');
  const selectAll = document.getElementById('memory-select-all');
  if (bulkBar) bulkBar.classList.add('hidden');
  if (selectBtn) { selectBtn.classList.remove('active'); selectBtn.textContent = 'Select'; }
  if (selectAll) selectAll.checked = false;
  renderMemoryList();
}

function toggleSelectItem(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  updateBulkCount();
}

function updateBulkCount() {
  const countEl = document.getElementById('memory-selected-count');
  const deleteBtn = document.getElementById('memory-bulk-delete');
  if (countEl) countEl.textContent = `${t('brain.selected_n', { n: selectedIds.size })}`;
  if (deleteBtn) deleteBtn.disabled = selectedIds.size === 0;
}

function toggleSelectAll() {
  const selectAllEl = document.getElementById('memory-select-all');
  if (!selectAllEl) return;

  if (selectAllEl.checked) {
    // 选择当前所有可见/已筛选的项目
    const visible = getFilteredMemories();
    visible.forEach(m => selectedIds.add(m.id));
  } else {
    selectedIds.clear();
  }
  updateBulkCount();
  renderMemoryList();
}

async function bulkDelete() {
  if (selectedIds.size === 0) return;
  const count = selectedIds.size;
  if (!await uiModule.styledConfirm(t('brain.delete_batch_confirm', { n: count, word: count === 1 ? t('brain.memory_singular') : t('brain.memory_plural') }), { confirmText: t('common.delete'), danger: true })) return;

  let deleted = 0;
  const deletedIds = [];
  for (const id of selectedIds) {
    try {
      const res = await fetch(`${window.location.origin}/api/memory/${id}`, { method: 'DELETE' });
      if (res.ok) {
        deleted++;
        deletedIds.push(id);
      }
    } catch (e) {
      console.error('Failed to delete memory:', id, e);
    }
  }

  await animateMemoryRemoval(deletedIds);
  exitSelectMode();
  await loadMemories();
  showToast(t('brain.deleted_n', { n: deleted, word: deleted === 1 ? t('brain.memory_singular') : t('brain.memory_plural') }));
}

// ---- 整理（审计）----

export async function tidyMemories() {
  const tidyBtn = document.getElementById('memory-tidy-btn');
  let tidySpinner = null;
  if (tidyBtn) {
    tidyBtn.disabled = true;
    tidyBtn.textContent = '';
    // 旋转时去掉按钮边框——只显示旋转器，不显示外框（在下方 finally 中恢复）。
    tidyBtn.style.border = 'none';
    tidyBtn.style.background = 'none';
    tidySpinner = spinnerModule.create('', 'clean', 'whirlpool');
    const _spEl = tidySpinner.createElement();
    _spEl.style.position = 'relative';
    _spEl.style.top = '1px';
    tidyBtn.appendChild(_spEl);
    tidySpinner.start();
  }

  // 快照当前状态用于差异对比
  const beforeMap = new Map(memories.map(m => [m.id, { ...m }]));

  try {
    const res = await fetch(`${window.location.origin}/api/memory/audit`, {
      method: 'POST',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Audit failed');
    }

    const data = await res.json();
    if ((data.removed || 0) === 0) {
      if (tidySpinner) tidySpinner.destroy();
      if (tidyBtn) { tidyBtn.disabled = false; tidyBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:2px;"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg> Tidy'; }
      showToast(t('brain.tidy_already'));
      return;
    }

    // 获取新状态
    const freshRes = await fetch(`${window.location.origin}/api/memory`);
    const freshData = await freshRes.json();
    const afterList = freshData.memory || freshData || [];
    const afterMap = new Map(afterList.map(m => [m.id, m]));

    // 计算差异
    const removed = [];   // 不再存在的 ID
    const edited = [];    // 文本已更改的 ID
    for (const [id, oldMem] of beforeMap) {
      if (!afterMap.has(id)) {
        removed.push(id);
      } else if (afterMap.get(id).text !== oldMem.text) {
        edited.push({ id, oldText: oldMem.text, newText: afterMap.get(id).text });
      }
    }

    if (tidySpinner) tidySpinner.updateMessage(t('brain.tidy_running'));

    // 在当前渲染的列表上动画显示差异
    await animateTidyDiff(removed, edited);

    // 现在加载清理后的状态
    memories = afterList;
    buildCategoryChips();
    renderMemoryList();
    updateMemoryCount();

    showToast(t('brain.tidied_result', { removed: data.removed, before: data.before, after: data.after }));
  } catch (error) {
    console.error('Tidy failed:', error);
    showError(t('brain.tidy_failed'));
  } finally {
    if (tidySpinner) tidySpinner.destroy();
    if (tidyBtn) {
      tidyBtn.disabled = false;
      tidyBtn.style.border = '';
      tidyBtn.style.background = '';
      tidyBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:2px;"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg> Tidy';
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function animateMemoryRemoval(ids) {
  const idSet = new Set([...ids].map(id => String(id)));
  const memoryList = document.getElementById('memory-list');
  if (!memoryList || !idSet.size) return;
  const items = Array.from(memoryList.querySelectorAll('.memory-item[data-memory-id]'))
    .filter(el => idSet.has(String(el.dataset.memoryId)));
  if (!items.length) return;
  for (const el of items) {
    el.style.maxHeight = `${Math.max(el.getBoundingClientRect().height, el.scrollHeight)}px`;
    el.classList.add('memory-tidy-removing');
  }
  await sleep(520);
}

async function animateTidyDiff(removedIds, editedItems) {
  const memoryList = document.getElementById('memory-list');
  if (!memoryList) return;

  // 为每个渲染项目标记其内存 ID 以便查找
  const items = memoryList.querySelectorAll('.memory-item');
  const itemMap = new Map();
  const filtered = getFilteredMemories();
  items.forEach((el, i) => {
    if (filtered[i]) itemMap.set(filtered[i].id, el);
  });

  // 先动画显示编辑——展示文本变形
  for (const { id, oldText, newText } of editedItems) {
    const el = itemMap.get(id);
    if (!el) continue;

    const textEl = el.querySelector('.memory-item-text');
    if (!textEl) continue;

    el.classList.add('memory-tidy-editing');
    textEl.classList.add('memory-tidy-text-old');
    await sleep(300);

    textEl.textContent = newText;
    textEl.classList.remove('memory-tidy-text-old');
    textEl.classList.add('memory-tidy-text-new');
    await sleep(400);

    el.classList.remove('memory-tidy-editing');
    textEl.classList.remove('memory-tidy-text-new');
    await sleep(100);
  }

  // 动画显示删除——先删除线再淡出
  for (const id of removedIds) {
    const el = itemMap.get(id);
    if (!el) continue;

    el.classList.add('memory-tidy-removing');
    await sleep(200);
  }

  // 让所有删除一起动画，然后等待它们完成
  if (removedIds.length > 0) {
    await sleep(500);
  }
}

// ---- 筛选辅助函数 ----

function getFilteredMemories() {
  const searchTerm = document.getElementById('memory-search')?.value?.toLowerCase().trim() || '';

  let filtered = searchTerm
    ? memories.filter(m => m.text && m.text.toLowerCase().includes(searchTerm))
    : [...memories];

  if (activeCategory !== 'all') {
    filtered = filtered.filter(m => (m.category || 'fact') === activeCategory);
  }

  const sortSelect = document.getElementById('memory-sort');
  const sort = sortSelect ? sortSelect.value : sortOrder;
  if (sort === 'newest') {
    filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  } else if (sort === 'oldest') {
    filtered.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  } else if (sort === 'alpha') {
    filtered.sort((a, b) => (a.text || '').localeCompare(b.text || ''));
  } else if (sort === 'uses') {
    filtered.sort((a, b) => (b.uses || 0) - (a.uses || 0) || (b.timestamp || 0) - (a.timestamp || 0));
  }

  // 置顶项始终浮动到顶部
  filtered.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  return filtered;
}

// ---- 渲染 ----

export function renderMemoryList() {
  const memoryList = document.getElementById('memory-list');
  if (!memoryList) {
    console.error('Memory list element not found');
    return;
  }

  const filtered = getFilteredMemories();
  memoryList.innerHTML = '';

  if (filtered.length === 0) {
    const selectBtn = document.getElementById('memory-select-btn');
    if (selectBtn) selectBtn.disabled = true;
    if (selectMode) exitSelectMode();
    const searchTerm = document.getElementById('memory-search')?.value?.trim() || '';
    const _smiley = '<span style="vertical-align:-3px;margin-left:6px;">' + uiModule.emptyStateIcon('smiley') + '</span>';
    if (searchTerm || activeCategory !== 'all') {
      memoryList.innerHTML = `<div class="memory-empty">${t('brain.no_matches')}</div>`;
    } else {
      memoryList.innerHTML = `<div class="memory-empty" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;">
        <span>No memories yet${_smiley}</span>
        <span style="opacity:0.7;font-size:11px;display:block;">
          <a href="#" data-mem-goto-add style="color:var(--accent,var(--red));text-decoration:underline;">${t('brain.import_in_add')}</a>
        </span>
      </div>`;
      memoryList.querySelector('[data-mem-goto-add]')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelector('.memory-tab[data-memory-tab="add"]')?.click();
      });
    }
    return;
  }

  const selectBtn = document.getElementById('memory-select-btn');
  if (selectBtn) selectBtn.disabled = false;

  filtered.forEach(memory => {
    const item = document.createElement('div');
    item.className = 'memory-item';
    item.dataset.memoryId = String(memory.id);

    // 选择模式下的复选框
    if (selectMode) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'memory-select-cb';
      cb.checked = selectedIds.has(memory.id);
      cb.addEventListener('change', () => {
        toggleSelectItem(memory.id);
        const selectAllEl = document.getElementById('memory-select-all');
        if (selectAllEl) selectAllEl.checked = filtered.every(m => selectedIds.has(m.id));
      });
      item.appendChild(cb);
      item.style.cursor = 'pointer';
      item.addEventListener('click', (e) => {
        if (e.target === cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
    }

    // 内容：文本 + 元数据
    const content = document.createElement('div');
    content.className = 'memory-item-content';

    const textSpan = document.createElement('span');
    textSpan.className = 'memory-item-text';
    textSpan.textContent = memory.text;

    const meta = document.createElement('div');
    meta.className = 'memory-item-meta';

    if (memory.pinned) {
      const pinBadge = document.createElement('span');
      pinBadge.className = 'memory-cat-badge memory-cat-pinned';
      pinBadge.textContent = t('brain.pinned_badge');
      meta.appendChild(pinBadge);
    }

    const catBadge = document.createElement('span');
    const cat = memory.category || 'fact';
    catBadge.className = 'memory-cat-badge memory-cat-' + cat;
    catBadge.textContent = cat;
    meta.appendChild(catBadge);

    const srcSpan = document.createElement('span');
    srcSpan.className = 'memory-item-source';
    srcSpan.textContent = memory.source === 'auto' ? 'auto' : 'manual';
    meta.appendChild(srcSpan);

    const uses = Number(memory.uses || 0);
    if (uses > 0) {
      const useSpan = document.createElement('span');
      useSpan.className = 'memory-item-uses';
      useSpan.textContent = `${uses}×`;
      useSpan.title = t('brain.injected_count', { n: uses });
      meta.appendChild(useSpan);
    }

    if (memory.timestamp) {
      const timeSpan = document.createElement('span');
      timeSpan.className = 'memory-item-time';
      timeSpan.textContent = relativeTime(memory.timestamp);
      timeSpan.title = new Date(memory.timestamp * 1000).toLocaleString();
      meta.appendChild(timeSpan);
    }

    content.appendChild(textSpan);
    content.appendChild(meta);

    if (memory.pinned) item.classList.add('memory-pinned');

    item.appendChild(content);

    // 双击文本进行编辑（不在选择模式下）
    if (!selectMode) {
      textSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startInlineEdit(item, memory);
      });
      textSpan.style.cursor = 'text';
    }

    // 菜单按钮（在选择模式下隐藏）
    if (!selectMode) {
      const menuBtn = document.createElement('button');
      menuBtn.className = 'memory-menu-btn';
      menuBtn.innerHTML = '\u22EE';
      menuBtn.title = 'Actions';

      const dropdown = document.createElement('div');
      dropdown.className = 'memory-item-dropdown';

      // 置顶 / 取消置顶 — 书签图标与聊天会话"收藏"SVG 一致。置顶时填充，未置顶时描边。
      const _bookmarkPath = '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>';
      const _pinSvg = memory.pinned
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${_bookmarkPath}</svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${_bookmarkPath}</svg>`;
      const pinItem = document.createElement('div');
      pinItem.className = 'dropdown-item-compact';
      pinItem.innerHTML = `<span class="dropdown-icon">${_pinSvg}</span><span>${memory.pinned ? 'Unpin' : 'Pin'}</span>`;
      pinItem.addEventListener('click', () => { dropdown.style.display = 'none'; togglePin(memory.id, !memory.pinned); });

      const editItem = document.createElement('div');
      editItem.className = 'dropdown-item-compact';
      editItem.textContent = '✎ Edit';
      editItem.addEventListener('click', () => { dropdown.style.display = 'none'; startInlineEdit(item, memory); });

      const deleteItem = document.createElement('div');
      deleteItem.className = 'dropdown-item-compact memory-dropdown-delete';
      deleteItem.textContent = '✕ Delete';
      deleteItem.addEventListener('click', () => { dropdown.style.display = 'none'; deleteMemory(memory.id); });

      // 选择 — 进入批量选择模式并预选此记忆。与邮件/文档/技能的"选择"项模式相同。
      const selectItem = document.createElement('div');
      selectItem.className = 'dropdown-item-compact';
      selectItem.innerHTML = '<span class="dropdown-icon"><span style="font-size:16px;line-height:1;">●</span></span><span>' + t('brain.select') + '</span>';
      selectItem.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dropdown.parentNode) dropdown.remove();
        if (!selectMode) enterSelectMode();
        selectedIds.add(memory.id);
        updateBulkCount();
        renderMemoryList();
      });

      // 仅移动端的取消按钮 — 与邮件/文档弹出窗口模式一致。CSS 在桌面端隐藏
      // '.dropdown-cancel-mobile'，因为桌面端点击外部即可干净地关闭。
      const cancelItem = document.createElement('div');
      cancelItem.className = 'dropdown-item-compact dropdown-cancel-mobile';
      cancelItem.textContent = '✕ Cancel';
      cancelItem.addEventListener('click', (e) => { e.stopPropagation(); if (dropdown.parentNode) dropdown.remove(); });

      dropdown.appendChild(pinItem);
      dropdown.appendChild(selectItem);
      dropdown.appendChild(editItem);
      dropdown.appendChild(deleteItem);
      dropdown.appendChild(cancelItem);

      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 关闭其他已打开的下拉菜单
        document.querySelectorAll('.memory-item-dropdown').forEach(d => d.remove());
        const rect = menuBtn.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = rect.bottom + 2 + 'px';
        dropdown.style.right = (window.innerWidth - rect.right) + 'px';
        dropdown.style.left = 'auto';
        dropdown.style.zIndex = '10001';
        dropdown.style.display = 'block';
        document.body.appendChild(dropdown);
        // 保持在屏幕内（移动端）：如果超出底部则翻转到按钮上方，限制左边缘，最后手段限制高度。
        const dr = dropdown.getBoundingClientRect();
        if (dr.bottom > window.innerHeight - 6) {
          dropdown.style.top = Math.max(6, rect.top - dr.height - 2) + 'px';
        }
        if (dr.left < 6) {
          dropdown.style.right = Math.max(6, window.innerWidth - 6 - dr.width) + 'px';
        }
        const dr2 = dropdown.getBoundingClientRect();
        if (dr2.bottom > window.innerHeight - 6) {
          dropdown.style.maxHeight = Math.max(80, window.innerHeight - 12 - dr2.top) + 'px';
          dropdown.style.overflowY = 'auto';
        }

        // 下滑关闭 — 与文档库弹出窗口手势一致。将弹出窗口向下拖拽超过约 60px 后释放即可关闭；
        // 提前释放则会弹回。仅纵向；横向滑动不处理。
        let _sw = null;
        let _swDy = 0;
        const _onTS = (ev) => {
          if (ev.touches.length !== 1) return;
          _sw = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
          _swDy = 0;
          dropdown.style.transition = '';
        };
        const _onTM = (ev) => {
          if (!_sw || ev.touches.length !== 1) return;
          const dx = ev.touches[0].clientX - _sw.x;
          const dy = ev.touches[0].clientY - _sw.y;
          if (Math.abs(dy) < Math.abs(dx)) { _sw = null; return; }
          if (dy > 0) {
            _swDy = dy;
            dropdown.style.transform = 'translateY(' + dy + 'px)';
            dropdown.style.opacity = String(Math.max(0.3, 1 - dy / 240));
          }
        };
        const _onTE = () => {
          if (!_sw) return;
          _sw = null;
          if (_swDy > 60) {
            dropdown.style.transition = 'transform 0.15s ease, opacity 0.15s ease';
            dropdown.style.transform = 'translateY(120px)';
            dropdown.style.opacity = '0';
            setTimeout(() => { if (dropdown.parentNode) dropdown.remove(); }, 160);
          } else {
            dropdown.style.transition = 'transform 0.18s ease, opacity 0.18s ease';
            dropdown.style.transform = '';
            dropdown.style.opacity = '';
          }
        };
        dropdown.addEventListener('touchstart', _onTS, { passive: true });
        dropdown.addEventListener('touchmove', _onTM, { passive: true });
        dropdown.addEventListener('touchend', _onTE);
      });

      item.appendChild(menuBtn);

      // 在卡片上任意位置长按打开相同的下拉菜单 — 与文档库模式一致。
      // 当触摸从 kebob 按钮、复选框或其他按钮开始时跳过（这些有各自的点击处理器）。
      {
        let hold = null;
        let start = null;
        const _lpCancel = () => { if (hold) { clearTimeout(hold); hold = null; } start = null; };
        item.addEventListener('pointerdown', (e) => {
          if (e.target.closest('.memory-menu-btn, .memory-select-cb, button, input')) return;
          start = { x: e.clientX, y: e.clientY };
          hold = setTimeout(() => {
            hold = null;
            item._suppressNextClick = true;
            setTimeout(() => { item._suppressNextClick = false; }, 400);
            if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
            menuBtn.click();
          }, 500);
        });
        item.addEventListener('pointermove', (e) => {
          if (!start) return;
          if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) _lpCancel();
        });
        item.addEventListener('pointerup', _lpCancel);
        item.addEventListener('pointercancel', _lpCancel);
      }

      // 点击外部关闭下拉菜单
      document.addEventListener('click', () => { if (dropdown.parentNode) dropdown.remove(); }, { once: false });
    }

    memoryList.appendChild(item);
  });

}

// ---- 带类别选择器的内联编辑 ----

function startInlineEdit(item, memory) {
  item.innerHTML = '';
  item.className = 'memory-item memory-item-editing';

  const editRow = document.createElement('div');
  editRow.className = 'memory-edit-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'memory-item-edit-input';
  input.value = memory.text;

  const catSelect = document.createElement('select');
  catSelect.className = 'memory-edit-cat-select';
  MEMORY_CATEGORIES.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    if (cat === (memory.category || 'fact')) opt.selected = true;
    catSelect.appendChild(opt);
  });

  editRow.appendChild(input);
  editRow.appendChild(catSelect);

  const actions = document.createElement('div');
  actions.className = 'memory-item-actions';
  actions.style.opacity = '1';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'memory-item-btn save';
  saveBtn.textContent = 'save';
  saveBtn.addEventListener('click', () => saveInlineEdit(memory.id, input.value, catSelect.value));

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'memory-item-btn';
  cancelBtn.textContent = 'cancel';
  cancelBtn.addEventListener('click', () => renderMemoryList());

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);

  item.appendChild(editRow);
  item.appendChild(actions);

  input.focus();
  input.select();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveInlineEdit(memory.id, input.value, catSelect.value);
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.stopImmediatePropagation();
      renderMemoryList();
    }
  });
}

async function saveInlineEdit(id, newText, newCategory) {
  newText = newText.trim();
  if (!newText) return;

  const memory = memories.find(m => m.id === id);
  const catChanged = newCategory && newCategory !== (memory?.category || 'fact');
  if (!memory || (newText === memory.text && !catChanged)) {
    renderMemoryList();
    return;
  }

  try {
    const params = new URLSearchParams({ text: newText });
    if (newCategory) params.append('category', newCategory);

    const response = await fetch(`${window.location.origin}/api/memory/${id}`, {
      method: 'PUT',
      body: params
    });

    if (response.ok) {
      await loadMemories();
      showToast(t('brain.memory_updated'));
    } else {
      const errorData = await response.json();
      throw new Error(errorData.detail || t('brain.memory_update_failed'));
    }
  } catch (error) {
    console.error('Error updating memory:', error);
    showError(t('brain.memory_update_failed'));
  }
}

export function updateMemoryCount() {
  const h2Count = document.getElementById('memory-count-h2');
  const tabCount = document.getElementById('memory-count'); // 可选（可能不存在）
  if (!h2Count && !tabCount) return;

  const searchInput = document.getElementById('memory-search');
  const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

  let visible = memories;
  const scopeTotal = visible.length;
  if (searchTerm) {
    visible = visible.filter(m => m.text && m.text.toLowerCase().includes(searchTerm));
  }
  if (activeCategory !== 'all') {
    visible = visible.filter(m => (m.category || 'fact') === activeCategory);
  }

  const num = visible.length === scopeTotal ? `${scopeTotal}` : `${visible.length}/${scopeTotal}`;
  // 标题（"记忆"标题旁边）显示"N memories"，类似于文档标题。纯数字仍然会填充任何标签徽章（如果存在）。
  if (h2Count) h2Count.textContent = `${t('brain.memory_count', { n: num, word: scopeTotal === 1 && visible.length === scopeTotal ? t('brain.memory_singular') : t('brain.memory_plural') })}`;
  if (tabCount) tabCount.textContent = num;
}

export async function addNewMemory() {
  const input = document.getElementById('new-memory-input');
  const text = input.value.trim();
  const category = _readNewMemoryCategory();

  if (!text) {
    showError(t('brain.memory_text_empty'));
    return;
  }

  try {
    const response = await fetch(`${window.location.origin}/api/memory/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        category: category,
      })
    });

    if (response.ok) {
      input.value = '';
      await loadMemories();
      showToast(t('brain.memory_added'));
    } else {
      const errorData = await response.json();
      console.error('Server error details:', errorData);
      throw new Error(errorData.detail || t('brain.memory_save_failed'));
    }
  } catch (error) {
    console.error('Error adding memory:', error);
    showError(t('brain.memory_save_failed'));
  }
}

export async function editMemory(id) {
  const memory = memories.find(m => m.id === id);
  if (!memory) return;

  const newText = prompt('Edit memory:', memory.text);
  if (!newText || newText === memory.text) return;

  await saveInlineEdit(id, newText);
}

async function togglePin(id, pinned) {
  try {
    const res = await fetch(`${window.location.origin}/api/memory/${id}/pin`, {
      method: 'POST',
      body: new URLSearchParams({ pinned: pinned.toString() })
    });
    if (res.ok) {
      const mem = memories.find(m => m.id === id);
      if (mem) mem.pinned = pinned;
      renderMemoryList();
      showToast(pinned ? 'Pinned — always in context' : 'Unpinned — RAG only');
    }
  } catch (e) {
    console.error('Failed to toggle pin:', e);
    showError(t('brain.pin_update_failed'));
  }
}

export async function deleteMemory(id) {
  const memory = memories.find(m => m.id === id);
  if (!memory) return;

  if (!await uiModule.styledConfirm(t('brain.delete_confirm', { text: memory.text }), { confirmText: t('common.delete'), danger: true })) return;

  try {
    const response = await fetch(`${window.location.origin}/api/memory/${id}`, {
      method: 'DELETE'
    });

    if (response.ok) {
      await animateMemoryRemoval([id]);
      await loadMemories();
      showToast(t('brain.memory_deleted'));
    } else {
      throw new Error('Failed to delete');
    }
  } catch (error) {
    showError(t('brain.memory_delete_failed'));
  }
}

export async function extractMemory(sessionId) {
  const res = await fetch(`${window.location.origin}/api/memory/extract`, {
    method: 'POST',
    body: new URLSearchParams({ session: sessionId })
  });
  if (!res.ok) {
    showError(t('brain.extract_failed'));
    return;
  }
  const data = await res.json();
  const suggestions = data.suggestions || [];

  const modal = document.getElementById('memory-modal');
  const body = document.getElementById('memory-suggestions-body');
  if (!body) {
    console.error('memory-suggestions-body element not found');
    return;
  }

  body.innerHTML = '';
  body.classList.remove('hidden');

  const memList = document.getElementById('memory-list');
  if (memList) memList.classList.add('hidden');

  if (suggestions.length === 0) {
    body.innerHTML = '<div class="memory-empty">No useful information detected.</div>';
  } else {
    const header = document.createElement('div');
    header.className = 'memory-suggestions-header';
    header.innerHTML = `<span>${t('brain.suggested_memories')}</span>`;
    const backBtn = document.createElement('button');
    backBtn.className = 'memory-item-btn';
    backBtn.textContent = 'back';
    backBtn.addEventListener('click', () => {
      body.classList.add('hidden');
      body.innerHTML = '';
      if (memList) memList.classList.remove('hidden');
    });
    header.appendChild(backBtn);
    body.appendChild(header);

    suggestions.forEach(s => {
      const div = document.createElement('div');
      div.className = 'memory-suggestion-item';
      const txt = document.createElement('span');
      txt.className = 'memory-item-text';
      txt.textContent = s;
      const btn = document.createElement('button');
      btn.className = 'memory-item-btn save';
      btn.textContent = 'save';
      btn.addEventListener('click', async () => {
        await fetch(`${window.location.origin}/api/memory/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: s })
        });
        btn.disabled = true;
        btn.textContent = t('brain.saved_label');
        showToast(t('brain.saved_to_memory'));
      });
      div.appendChild(txt);
      div.appendChild(btn);
      body.appendChild(div);
    });
  }

  modal.classList.remove('hidden');
}

// ---- 导出 ----

export function exportMemories() {
  if (!memories || memories.length === 0) {
    showToast(t('brain.no_memories_export'));
    return;
  }
  const data = JSON.stringify(memories, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'memories.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast(t('brain.exported_n', { n: memories.length }));
}

// ---- 从文件导入 ----

export async function importMemories() {
  const fileInput = document.getElementById('memory-import-file');
  if (!fileInput) return;
  fileInput.click();
}

async function handleImportFile(file) {
  if (!file) return;

  const sessionId = sessionModule?.getCurrentSessionId?.();

  const importBtn = document.getElementById('memory-import-btn');
  const _origImportHtml = importBtn ? importBtn.innerHTML : '';
  let importSpin = null;
  if (importBtn) {
    importBtn.disabled = true;
    importBtn.innerHTML = '';
    importSpin = spinnerModule.createWhirlpool(12);
    importSpin.element.style.cssText = 'width:12px;height:12px;margin:0 5px 0 0;display:inline-flex;vertical-align:-2px;transform:translateY(-1px);';
    importBtn.appendChild(importSpin.element);
    importBtn.appendChild(document.createTextNode(t('brain.importing')));
  }

  try {
    const formData = new FormData();
    formData.append('file', file);
    if (sessionId) {
        formData.append('session', sessionId);
    }

    const res = await fetch(`${window.location.origin}/api/memory/import`, {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Import failed');
    }

    const data = await res.json();
    const suggestions = data.suggestions || [];

    // 使用现有的建议界面显示建议
    const modal = document.getElementById('memory-modal');
    const body = document.getElementById('memory-suggestions-body');
    if (!body) return;

    body.innerHTML = '';
    body.classList.remove('hidden');

    const memList = document.getElementById('memory-list');
    if (memList) memList.classList.add('hidden');

    if (suggestions.length === 0) {
      body.innerHTML = '<div class="memory-empty">No useful information found in file.</div>';
    } else {
      const reviewItems = suggestions
        .map((s) => ({
          text: typeof s === 'string' ? s : s.text,
          category: (typeof s === 'object' && s.category) || 'fact',
          active: true,
        }))
        .filter((s) => s.text);
      const header = document.createElement('div');
      header.className = 'memory-suggestions-header';
      const headerTitle = document.createElement('span');
      const updateHeaderTitle = () => {
        const remaining = reviewItems.filter((item) => item.active).length;
        headerTitle.textContent = t('brain.imported_from', { file: data.filename || file.name, remaining: remaining });
      };
      updateHeaderTitle();
      const headerActions = document.createElement('div');
      headerActions.className = 'memory-suggestions-actions';
      const backBtn = document.createElement('button');
      backBtn.className = 'memory-item-btn';
      backBtn.textContent = 'back';
      backBtn.addEventListener('click', () => {
        body.classList.add('hidden');
        body.innerHTML = '';
        if (memList) memList.classList.remove('hidden');
      });
      const saveAllBtn = document.createElement('button');
      saveAllBtn.className = 'memory-item-btn save';
      saveAllBtn.textContent = 'save all';
      saveAllBtn.addEventListener('click', async () => {
        let saved = 0;
        for (const s of reviewItems) {
          if (!s.active || !s.text) continue;
          try {
            await fetch(`${window.location.origin}/api/memory/add`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: s.text, category: s.category })
            });
            saved++;
          } catch (e) { /* skip */ }
        }
        body.classList.add('hidden');
        body.innerHTML = '';
        if (memList) memList.classList.remove('hidden');
        await loadMemories();
        document.querySelector('.memory-tab[data-memory-tab="browse"]')?.click();
        showToast(t('brain.saved_n', { n: saved }));
      });
      headerActions.appendChild(saveAllBtn);
      headerActions.appendChild(backBtn);
      header.appendChild(headerTitle);
      header.appendChild(headerActions);
      body.appendChild(header);

      reviewItems.forEach(item => {
        const div = document.createElement('div');
        div.className = 'memory-suggestion-item';

        const content = document.createElement('div');
        content.className = 'memory-item-content';
        const txt = document.createElement('span');
        txt.className = 'memory-item-text';
        txt.textContent = item.text;
        const catBadge = document.createElement('span');
        catBadge.className = 'memory-cat-badge memory-cat-' + item.category;
        catBadge.textContent = item.category;
        content.appendChild(txt);
        content.appendChild(catBadge);

        const actionWrap = document.createElement('div');
        actionWrap.className = 'memory-suggestion-actions';
        const btn = document.createElement('button');
        btn.className = 'memory-item-btn save';
        btn.textContent = 'save';
        btn.addEventListener('click', async () => {
          await fetch(`${window.location.origin}/api/memory/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: item.text, category: item.category })
          });
          item.active = false;
          div.remove();
          updateHeaderTitle();
          btn.disabled = true;
          btn.textContent = t('brain.saved_label');
          showToast(t('brain.saved_to_memory'));
        });
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'memory-item-btn delete';
        deleteBtn.textContent = 'delete';
        deleteBtn.addEventListener('click', () => {
          item.active = false;
          div.remove();
          updateHeaderTitle();
        });
        actionWrap.appendChild(btn);
        actionWrap.appendChild(deleteBtn);

        div.appendChild(content);
        div.appendChild(actionWrap);
        body.appendChild(div);
      });
    }

    modal.classList.remove('hidden');
    document.querySelector('.memory-tab[data-memory-tab="browse"]')?.click();
  } catch (error) {
    console.error('Import failed:', error);
    showError(t('brain.import_failed') + ' — ' + error.message);
  } finally {
    if (importSpin) importSpin.destroy();
    if (importBtn) {
      importBtn.disabled = false;
      importBtn.innerHTML = _origImportHtml;
    }
    // 重置文件输入以便可以重新选择相同的文件
    const fileInput = document.getElementById('memory-import-file');
    if (fileInput) fileInput.value = '';
  }
}

// 工具别名（规范实现在 uiModule 中）
var showToast = uiModule.showToast;
var showError = uiModule.showError;

// 事件监听器
document.addEventListener('DOMContentLoaded', () => {
  _wireMemoryDrag();

  // 记忆模态标签
  document.querySelectorAll('.memory-tab[data-memory-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.memoryTab;
      document.querySelectorAll('.memory-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.memory-tab-panel[data-memory-panel]').forEach(p => {
        p.classList.toggle('hidden', p.dataset.memoryPanel !== target);
      });
      // 懒加载技能标签页（cascade=true → 播放多米诺入场动画）
      if (target === 'skills') {
        import('./skills.js').then(m => { if (m.loadSkills) m.loadSkills(true); else if (m.default?.loadSkills) m.default.loadSkills(true); });
      }
    });
  });

  const sortSelect = document.getElementById('memory-sort');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      sortOrder = sortSelect.value;
      renderMemoryList();
    });
  }

  const tidyBtn = document.getElementById('memory-tidy-btn');
  if (tidyBtn) tidyBtn.addEventListener('click', tidyMemories);

  const selectBtn = document.getElementById('memory-select-btn');
  if (selectBtn) selectBtn.addEventListener('click', () => {
    if (selectMode) exitSelectMode();
    else enterSelectMode();
  });

  const selectAll = document.getElementById('memory-select-all');
  if (selectAll) selectAll.addEventListener('change', toggleSelectAll);

  const bulkBar = document.getElementById('memory-bulk-bar');
  if (bulkBar) bulkBar.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target === selectAll) return;
    selectAll.checked = !selectAll.checked;
    selectAll.dispatchEvent(new Event('change'));
  });

  const bulkDeleteBtn = document.getElementById('memory-bulk-delete');
  if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', bulkDelete);

  const bulkCancelBtn = document.getElementById('memory-bulk-cancel');
  if (bulkCancelBtn) bulkCancelBtn.addEventListener('click', exitSelectMode);

  const exportBtn = document.getElementById('memory-export-btn');
  if (exportBtn) exportBtn.addEventListener('click', exportMemories);

  const importBtn = document.getElementById('memory-import-btn');
  if (importBtn) importBtn.addEventListener('click', importMemories);

  const importFile = document.getElementById('memory-import-file');
  if (importFile) importFile.addEventListener('change', (e) => {
    if (e.target.files[0]) handleImportFile(e.target.files[0]);
  });

  window.addEventListener('memory-refresh', () => {
    loadMemories();
  });
});

const memoryModule = {
  loadMemories,
  renderMemoryList,
  updateMemoryCount,
  addNewMemory,
  editMemory,
  deleteMemory,
  extractMemory,
  buildCategoryChips,
  tidyMemories,
  importMemories,
  exportMemories
};

export default memoryModule;
window.memoryModule = memoryModule;
