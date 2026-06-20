// static/js/group.js
// 群聊 — 多模型对话（并行或轮询）

import uiModule from './ui.js';
import markdownModule from './markdown.js';
import chatRenderer from './chatRenderer.js';
import spinnerModule from './spinner.js';
import { providerLogo } from './providers.js';
import { PROMPT_TEMPLATES, getAllPresets } from './presets.js';
import { sortModelObjects } from './modelSort.js';
import Storage from './storage.js';

let API_BASE = '';
let _active = false;
let _models = [];          // [{mid, display, url, endpointId}]
let _participantSessions = [];  // 每个模型的会话 ID
const _groupParticipants = [];  // 模块级别的参与者列表
let _abortControllers = [];
let _mode = 'round-robin';    // 'parallel' 或 'round-robin'
let _roundRobinIdx = 0;
let _parentSessionId = null;
const GROUP_STATE_KEY = 'odysseus-group-state';

export function init(apiBase) {
  API_BASE = apiBase;
  // 在角色模态框内初始化群组标签页
  setTimeout(_initGroupTab, 500);
}

function _initGroupTab() {
  const participantsEl = document.getElementById('group-participants');
  const addBtn = document.getElementById('group-add-btn');
  const startBtn = document.getElementById('save-custom-preset'); // 主底部"开始"按钮
  const modeBtn = document.getElementById('group-mode-btn');
  if (!participantsEl || !addBtn) return;

  // _groupParticipants 位于模块作用域
  let _modelsCache = null;

  async function _getModels() {
    if (_modelsCache) return _modelsCache;
    let items = (window.modelsModule && window.modelsModule.getCachedItems) ? window.modelsModule.getCachedItems() : [];
    if (!items || items.length === 0) {
      try {
        const res = await fetch(API_BASE + '/api/models', { credentials: 'same-origin' });
        items = (await res.json()).items || [];
      } catch (e) {}
    }
    const result = [];
    const seen = new Set();
    items.forEach(item => {
      if (item.offline) return;
      (item.models || []).concat(item.models_extra || []).forEach((mid, i) => {
        if (seen.has(mid)) return;
        seen.add(mid);
        const display = ((item.models_display || []).concat(item.models_extra_display || []))[i] || mid;
        result.push({ mid, display: display.split('/').pop(), url: item.url, endpointId: item.endpoint_id });
      });
    });
    _modelsCache = sortModelObjects(result);
    return _modelsCache;
  }

  function _render() {
    participantsEl.innerHTML = '';
    _groupParticipants.forEach((p, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;background:color-mix(in srgb, var(--fg) 3%, transparent);border-radius:6px;';
      const label = p.character ? p.character.name : (p.model ? p.model.display : '?');
      const sublabel = p.model ? p.model.display : '';
      row.innerHTML = `
        <span style="flex:1;min-width:0;">
          <span style="font-size:12px;font-weight:500;">${uiModule.esc(label)}</span>
          ${sublabel && sublabel !== label ? '<span style="font-size:10px;opacity:0.35;margin-left:4px;">' + uiModule.esc(sublabel) + '</span>' : ''}
        </span>
        <button style="background:none;border:none;color:var(--fg);opacity:0.5;cursor:pointer;font-size:16px;padding:0 4px;line-height:1;position:relative;top:-4px;" data-idx="${idx}" title="${t('group.remove')}">&times;</button>
      `;
      row.querySelector('button').addEventListener('click', () => { _groupParticipants.splice(idx, 1); _render(); });
      participantsEl.appendChild(row);
    });
    // startBtn 是共享的 — 不禁用它
  }

  addBtn.addEventListener('click', async () => {
    const [models, characters] = await Promise.all([_getModels(), _getCharacterList()]);

    const picker = document.createElement('div');
    picker.style.cssText = 'display:flex;gap:4px;align-items:center;';

    const charSel = document.createElement('select');
    charSel.className = 'preset-input';
    charSel.style.cssText = 'font-size:11px;flex:1;height:26px;';
    charSel.innerHTML = '<option value="">' + t('group.none_placeholder') + '</option>' +
      characters.map(c => '<option value="' + c.id + '">' + uiModule.esc(c.name) + '</option>').join('');

    const modelSel = document.createElement('select');
    modelSel.className = 'preset-input';
    modelSel.style.cssText = 'font-size:11px;flex:1;height:26px;';
    modelSel.innerHTML = '<option value="">' + t('group.model_placeholder') + '</option>' +
      models.map(m => '<option value="' + m.mid + '">' + uiModule.esc(m.display) + '</option>').join('');

    // 选择模型时自动添加
    modelSel.addEventListener('change', () => {
      if (!modelSel.value) return;
      if (_groupParticipants.length >= 8) { uiModule.showToast(t('group.max_participants')); return; }
      const entry = { character: null, model: null };
      entry.model = models.find(m => m.mid === modelSel.value) || null;
      if (charSel.value) entry.character = characters.find(c => c.id === charSel.value) || null;
      _groupParticipants.push(entry);
      picker.remove();
      _render();
    });

    picker.appendChild(charSel);
    picker.appendChild(modelSel);
    participantsEl.appendChild(picker);
  });

  // 模式切换 — 与对比功能的并行按钮样式相同
  if (modeBtn) {
    const ICON_PAR = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>';
    const ICON_SEQ = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/></svg>';
    modeBtn.addEventListener('click', () => {
      _mode = _mode === 'parallel' ? 'round-robin' : 'parallel';
      modeBtn.classList.toggle('active', _mode === 'parallel');
      modeBtn.innerHTML = (_mode === 'parallel' ? ICON_PAR : ICON_SEQ) + '<span class="compare-toggle-label">' + (_mode === 'parallel' ? t('group.parallel') : t('group.sequential')) + '</span>';
    });
  }

  // 钩子主"开始"按钮 — 仅在群组标签页激活时生效
  if (startBtn) startBtn.addEventListener('click', async () => {
    const activeTab = document.querySelector('.preset-tab.active');
    if (!activeTab || activeTab.dataset.chartab !== 'group') return;
    // 从当前会话获取默认模型作为后备
    const _defaultModel = (window.sessionModule && window.sessionModule.getSessions) ?
      (() => {
        const s = window.sessionModule.getSessions().find(x => x.id === window.sessionModule.getCurrentSessionId());
        if (s) return { mid: s.model, display: s.model.split('/').pop(), url: s.endpoint_url, endpointId: '' };
        return null;
      })() : null;

    const picked = _groupParticipants.map(p => {
      let m = p.model ? { ...p.model } : (_defaultModel ? { ..._defaultModel } : null);
      if (!m || !m.url) {
        console.warn('[group] 参与者没有有效模型:', p);
        return null;
      }
      if (p.character) m.character = { characterId: p.character.id, characterName: p.character.name, characterPrompt: p.character.prompt };
      return m;
    }).filter(Boolean);

    if (picked.length < 2) { uiModule.showToast(t('group.need_two_participants')); return; }

    const modal = document.getElementById('custom-preset-modal');
    if (modal) modal.classList.add('hidden');

    setActive(true);
    if (window._syncGroupIndicator) window._syncGroupIndicator(true);
    if (window.sessionModule) window.sessionModule.setCurrentSessionId(null);
    const box = document.getElementById('chat-history');
    if (box) box.innerHTML = '';

    await startGroup(picked, 'group-' + Date.now());

    // 如果有 2+ 个参与者，自动保存为预设
    if (picked.length >= 2) {
      const presetData = {
        id: 'grp-' + Date.now(),
        name: picked.map(p => p._groupName || p.character?.characterName || p.display).join(' & '),
        mode: _mode,
        participants: picked.map(p => ({
          modelId: p.mid,
          modelDisplay: p.display,
          characterId: p.character?.characterId || null,
          characterName: p.character?.characterName || null,
        })),
      };
      try {
        const existing = await fetch(API_BASE + '/api/presets/groups', { credentials: 'same-origin' }).then(r => r.json());
        const groups = existing.groups || [];
        // 如果参与者相同则不重复添加
        const sig = presetData.participants.map(p => p.modelId + ':' + (p.characterId || '')).sort().join(',');
        const exists = groups.some(g => (g.participants || []).map(p => p.modelId + ':' + (p.characterId || '')).sort().join(',') === sig);
        if (!exists) {
          groups.push(presetData);
          await fetch(API_BASE + '/api/presets/groups', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groups }),
          });
        }
      } catch (e) {}
    }

    uiModule.showToast(t('group.group_ready', { n: picked.length }));
  });

  const groupTab = document.querySelector('.preset-tab[data-chartab="group"]');
  if (groupTab) groupTab.addEventListener('click', () => {
    _modelsCache = null;
    if (startBtn) startBtn.textContent = t('group.start_group_chat');
    _loadGroupPresets();
    if (_groupParticipants.length === 0) {
      setTimeout(() => addBtn.click(), 100);
    }
  });

  // 加载并渲染已保存的群组预设
  async function _loadGroupPresets() {
    try {
      const res = await fetch(API_BASE + '/api/presets/groups', { credentials: 'same-origin' });
      const data = await res.json();
      const groups = data.groups || [];
      // 在参与者列表上方渲染预设
      let presetsDiv = document.getElementById('group-presets-list');
      if (!presetsDiv) {
        presetsDiv = document.createElement('div');
        presetsDiv.id = 'group-presets-list';
        presetsDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;';
        participantsEl.parentNode.insertBefore(presetsDiv, participantsEl);
      }
      presetsDiv.innerHTML = '';
      if (groups.length === 0) return;
      groups.forEach((g, idx) => {
        const chip = document.createElement('button');
        chip.className = 'preset-save-btn';
        chip.style.cssText = 'padding:3px 10px;font-size:11px;background:color-mix(in srgb, var(--fg) 5%, transparent);border:1px solid var(--border);';
        const chipLabel = document.createElement('span');
        chipLabel.textContent = g.name || t('group.group_n', { n: idx + 1 });
        chip.appendChild(chipLabel);
        const chipX = document.createElement('span');
        chipX.textContent = ' \u00d7';
        chipX.style.cssText = 'opacity:0.4;margin-left:4px;cursor:pointer;';
        chipX.addEventListener('click', (ev) => {
          ev.stopPropagation();
          groups.splice(idx, 1);
          fetch(API_BASE + '/api/presets/groups', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groups }),
          }).then(() => _loadGroupPresets());
        });
        chip.appendChild(chipX);
        chip.title = (g.participants || []).map(p => p.characterName || p.modelDisplay || '?').join(', ');
        chip.addEventListener('click', async () => {
          // 加载预设参与者
          const [models, chars] = await Promise.all([_getModels(), _getCharacterList()]);
          _groupParticipants.length = 0;
          (g.participants || []).forEach(p => {
            const model = models.find(m => m.mid === p.modelId) || models[0];
            const entry = { model: model || null, character: null };
            if (p.characterId) {
              entry.character = chars.find(c => c.id === p.characterId) || null;
            }
            if (entry.model) _groupParticipants.push(entry);
          });
          _mode = g.mode || 'parallel';
          _render();
        });
        // 长按/右键删除
        chip.addEventListener('contextmenu', async (e) => {
          e.preventDefault();
          if (await window.styledConfirm(t('group.delete_preset_confirm', { name: g.name || '群组' }), { confirmText: t('common.delete'), danger: true })) {
            groups.splice(idx, 1);
            fetch(API_BASE + '/api/presets/groups', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ groups }),
            }).then(() => _loadGroupPresets());
          }
        });
        presetsDiv.appendChild(chip);
      });
    } catch (e) { console.warn('[group] 加载预设失败:', e); }
  }
  // 切换到其他标签页时恢复按钮文本
  document.querySelectorAll('.preset-tab[data-chartab]').forEach(tab => {
    if (tab.dataset.chartab !== 'group') {
      tab.addEventListener('click', () => {
        if (startBtn) startBtn.textContent = t('group.start');
      });
    }
  });
}

async function _getCharacterList() {
  // 来自 PROMPT_TEMPLATES 的内置角色
  const chars = PROMPT_TEMPLATES.filter(t => t.isCharacter).map(t => ({
    id: t.id, name: t.name, prompt: t.prompt,
  }));
  // 来自预设的用户创建的角色
  try {
    const allPresets = getAllPresets();
    if (allPresets && allPresets.custom && allPresets.custom.character_name) {
      chars.push({
        id: 'custom',
        name: allPresets.custom.character_name,
        prompt: allPresets.custom.system_prompt || allPresets.custom.prompt || '',
      });
    }
  } catch (e) {}
  // 加载用户模板并等待返回。
  // 端点直接返回 JSON 数组（不是 {templates:[...]}）。
  // 所有用户模板都是角色 — 无需 isCharacter 过滤。
  try {
    const r = await fetch(API_BASE + '/api/presets/templates', { credentials: 'same-origin' });
    const data = await r.json();
    const templates = Array.isArray(data) ? data : (data.templates || []);
    templates.forEach(t => {
      if (t.id && t.name && !chars.find(c => c.id === t.id)) {
        chars.push({ id: t.id, name: t.name, prompt: t.system_prompt || t.prompt || '' });
      }
    });
  } catch (e) {}
  return chars;
}

export function isActive() { return _active; }
export function setActive(v) { _active = v; }
export function getMode() { return _mode; }
export function setMode(m) { _mode = m; }

// ── 模型选择器 ─────────────────────────────────────

export async function showModelPicker() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.id = 'group-model-picker';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.width = 'min(480px, 92vw)';

    // 标题
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = '<h4>' + t('group.pick_models_title') + '</h4>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.innerHTML = '&#x2716;';
    closeBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
    header.appendChild(closeBtn);

    // 内容区
    const body = document.createElement('div');
    body.className = 'modal-body';

    // 模式切换
    const modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;align-items:center;font-size:12px;';
    modeRow.innerHTML = `
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
        <input type="radio" name="group-mode" value="parallel" ${_mode === 'parallel' ? 'checked' : ''}> ${t('group.all_respond')}
      </label>
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
        <input type="radio" name="group-mode" value="round-robin" ${_mode === 'round-robin' ? 'checked' : ''}> ${t('group.round_robin')}
      </label>
    `;
    body.appendChild(modeRow);

    // 搜索
    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = t('group.filter_models');
    search.className = 'memory-search-input';
    search.style.marginBottom = '8px';
    body.appendChild(search);

    // 模型列表
    const list = document.createElement('div');
    list.style.cssText = 'max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;';
    body.appendChild(list);

    // 已选计数 + 开始按钮
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-top:10px;';
    footer.innerHTML = `
      <span id="group-selected-count" style="font-size:11px;opacity:0.5;">${t('group.selected_n', { n: 0 })}</span>
      <button id="group-start-btn" class="btn-primary" disabled style="padding:6px 16px;font-size:12px;">${t('group.start_group_chat')}</button>
    `;
    body.appendChild(footer);

    content.appendChild(header);
    content.appendChild(body);
    overlay.appendChild(content);
    overlay.style.display = 'flex';
    document.body.appendChild(overlay);

    // 获取所有可用模型 — 先尝试缓存，为空则获取
    const selected = new Set();
    let _cachedModels = null;
    async function getAllModels() {
      if (_cachedModels) return _cachedModels;
      let items = (window.modelsModule && window.modelsModule.getCachedItems) ? window.modelsModule.getCachedItems() : [];
      // 降级方案：如果缓存为空则从 API 获取
      if (!items || items.length === 0) {
        try {
          const res = await fetch(API_BASE + '/api/models', { credentials: 'same-origin' });
          const data = await res.json();
          items = data.items || [];
        } catch (e) { console.warn('[group] 获取模型失败:', e); }
      }
      const result = [];
      const seen = new Set();
      items.forEach(item => {
        if (item.offline) return;
        (item.models || []).concat(item.models_extra || []).forEach((mid, i) => {
          if (seen.has(mid)) return;
          seen.add(mid);
          const display = ((item.models_display || []).concat(item.models_extra_display || []))[i] || mid;
          result.push({ mid, display: display.split('/').pop(), url: item.url, endpointId: item.endpoint_id, epName: item.endpoint_name || '' });
        });
      });
      _cachedModels = sortModelObjects(result);
      return _cachedModels;
    }

    async function render(filter) {
      list.innerHTML = '<div style="opacity:0.4;padding:8px;font-size:12px;">' + t('group.loading_models') + '</div>';
      const all = await getAllModels();
      const q = (filter || '').toLowerCase();
      all.forEach(m => {
        if (q && !m.mid.toLowerCase().includes(q) && !m.display.toLowerCase().includes(q) && !m.epName.toLowerCase().includes(q)) return;
        const row = document.createElement('div');
        row.className = 'memory-item';
        row.style.cssText = 'padding:6px 8px;cursor:pointer;' + (selected.has(m.mid) ? 'background:color-mix(in srgb, var(--accent, var(--red)) 12%, transparent);' : '');
        const logo = providerLogo(m.mid);
        row.innerHTML = `
          <input type="checkbox" ${selected.has(m.mid) ? 'checked' : ''} style="margin-right:6px;">
          ${logo ? '<span style="opacity:0.5;margin-right:4px;">' + logo + '</span>' : ''}
          <span style="flex:1;font-size:12px;">${uiModule.esc(m.display)}</span>
          <span style="font-size:10px;opacity:0.3;">${uiModule.esc(m.epName)}</span>
        `;
        row.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return;
          const cb = row.querySelector('input[type=checkbox]');
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        });
        row.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) {
            if (selected.size >= 8) { e.target.checked = false; uiModule.showToast(t('group.max_8_models')); return; }
            selected.add(m.mid);
          } else {
            selected.delete(m.mid);
          }
          document.getElementById('group-selected-count').textContent = t('group.selected_n', { n: selected.size });
          document.getElementById('group-start-btn').disabled = selected.size < 2;
          row.style.background = selected.has(m.mid) ? 'color-mix(in srgb, var(--accent, var(--red)) 12%, transparent)' : '';
        });
        list.appendChild(row);
      });
    }

    search.addEventListener('input', () => render(search.value));
    render();

    // 模式切换
    modeRow.querySelectorAll('input[name=group-mode]').forEach(r => {
      r.addEventListener('change', () => { _mode = r.value; });
    });

    // 开始按钮
    document.getElementById('group-start-btn').addEventListener('click', async () => {
      const all = await getAllModels();
      const picked = all.filter(m => selected.has(m.mid));

      // 步骤 2：角色分配
      body.innerHTML = '';
      const stepTitle = document.createElement('div');
      stepTitle.style.cssText = 'font-size:12px;opacity:0.5;margin-bottom:8px;';
      stepTitle.textContent = t('group.assign_role_optional');
      body.appendChild(stepTitle);

      // 构建角色选项
      const characters = await _getCharacterList();
      const assignments = {}; // mid -> {characterId, characterName, characterPrompt}

      for (const m of picked) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);';
        const logo = providerLogo(m.mid);
        row.innerHTML = `
          ${logo ? '<span style="opacity:0.5;">' + logo + '</span>' : ''}
          <span style="flex:1;font-size:12px;font-weight:500;">${uiModule.esc(m.display)}</span>
        `;
        const sel = document.createElement('select');
        sel.style.cssText = 'font-size:11px;padding:3px 6px;border-radius:4px;border:1px solid var(--border);background:var(--bg);color:var(--fg);max-width:140px;';
        let optsHtml = '<option value="">' + t('group.no_role') + '</option>';
        characters.forEach(c => {
          optsHtml += `<option value="${c.id}">${uiModule.esc(c.name)}</option>`;
        });
        sel.innerHTML = optsHtml;
        sel.addEventListener('change', () => {
          if (sel.value) {
            const ch = characters.find(c => c.id === sel.value);
            assignments[m.mid] = { characterId: ch.id, characterName: ch.name, characterPrompt: ch.prompt };
          } else {
            delete assignments[m.mid];
          }
        });
        row.appendChild(sel);
        body.appendChild(row);
      }

      // 开始按钮
      const goBtn = document.createElement('button');
      goBtn.className = 'btn-primary';
      goBtn.style.cssText = 'margin-top:10px;padding:6px 16px;font-size:12px;width:100%;';
      goBtn.textContent = t('group.start_group_chat');
      goBtn.addEventListener('click', () => {
        // 将角色信息附加到选中的模型
        picked.forEach(m => {
          if (assignments[m.mid]) {
            m.character = assignments[m.mid];
          }
        });
        overlay.remove();
        resolve(picked);
      });
      body.appendChild(goBtn);
    });

    // 点击外部关闭
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    search.focus();
  });
}

// ── 开始 / 停止 ─────────────────────────────────────

export async function startGroup(models, parentSessionId) {
  _models = models;
  _active = true;
  _roundRobinIdx = 0;
  _participantSessions = [];

  // 创建一个真实的父会话以持久化
  const groupName = '[GRP] ' + models.map(m => m._groupName || m.character?.characterName || m.display).join(', ');
  try {
    const pfd = new FormData();
    pfd.append('name', groupName);
    pfd.append('endpoint_url', models[0].url);
    pfd.append('model', models[0].mid);
    pfd.append('skip_validation', 'true');
    if (models[0].endpointId) pfd.append('endpoint_id', models[0].endpointId);
    const pres = await fetch(`${API_BASE}/api/session`, { method: 'POST', body: pfd, credentials: 'same-origin' });
    const pdata = await pres.json();
    _parentSessionId = pdata.id;
    // 注册为群组会话以便侧边栏图标显示
    try {
      const storedGroupSessions = Storage.getJSON('odysseus-group-sessions', []);
      const gids = Array.isArray(storedGroupSessions) ? storedGroupSessions : [];
      if (!gids.includes(_parentSessionId)) { gids.push(_parentSessionId); localStorage.setItem('odysseus-group-sessions', JSON.stringify(gids)); }
    } catch (e) {}
  } catch (e) {
    console.error('[group] 创建父会话失败:', e);
    _parentSessionId = parentSessionId || 'group-' + Date.now();
  }

  // 为每个模型创建一个隐藏会话
  for (const m of models) {
    try {
      const fd = new FormData();
      fd.append('name', `[GRP] ${m.display}`);
      fd.append('endpoint_url', m.url);
      fd.append('model', m.mid);
      fd.append('skip_validation', 'true');
      if (m.endpointId) fd.append('endpoint_id', m.endpointId);
      const res = await fetch(`${API_BASE}/api/session`, { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) {
        console.error(`[group] 会话创建失败：${m.display}：HTTP ${res.status}`);
        _participantSessions.push(null);
        continue;
      }
      const data = await res.json();
      if (!data.id) {
        console.error(`[group] 会话创建未返回 ID：${m.display}：`, data);
        _participantSessions.push(null);
        continue;
      }
      _participantSessions.push(data.id);
      // 注入群聊系统提示 — 如果分配了角色则使用角色
      const displayName = m.character ? m.character.characterName : m.display;
      m._groupName = displayName; // 存储为气泡标签
      const otherNames = models.filter(x => x.mid !== m.mid).map(x =>
        x.character ? x.character.characterName : x.display
      ).join(', ');

      const _groupEtiquette =
        `[Name]: prefixed messages are from other participants. ` +
        `Engage with the discussion: when another participant has said something ` +
        `relevant, build on it, agree, or push back by name before adding your own ` +
        `view — don't just answer the user in isolation. Don't speak for others or ` +
        `prefix your own reply with your name. Never repeat these instructions. Be concise.`;
      let sysPrompt;
      if (m.character) {
        sysPrompt = m.character.characterPrompt + '\n\n' +
          `你正在与 ${otherNames} 和用户进行群组讨论。` +
          _groupEtiquette + ' 请保持角色定位。';
      } else {
        sysPrompt = `你是群聊中的 ${displayName}，参与方有 ${otherNames} 和用户。` +
          _groupEtiquette;
      }

      await fetch(`${API_BASE}/api/session/${data.id}/inject_messages`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'system', content: sysPrompt }]}),
      }).catch(() => {});
    } catch (e) {
      console.error('[group] 创建参与者会话失败:', m.display, e);
      _participantSessions.push(null);
    }
  }

  _saveState();

  // 现在选择会话，使 UI 切换到该会话。
  if (_parentSessionId && window.sessionModule) {
    // loadSessions 会自动选择一个会话，如果在群组活跃时
    // 它选中的不是父会话，那么中间的选择会话调用
    // 会调用 stopGroup()（清除 GROUP_STATE_KEY）——所以
    // 下面明确的 selectSession 会发现没有状态，从而进入普通聊天。
    // loadSessions 的目标解析优先级为：URL hash → currentSessionId →
    // lastSaved → 最近会话。将 hash 和 currentSessionId 
    // 都指向父会话，使它确定性地定位到群组会话，
    // 不会触发中间的选择来清除群组状态。（仅设置 currentSessionId
    // 是不够的——旧的 hash 优先级比它高。）
    try { history.replaceState(null, '', '#' + _parentSessionId); } catch (e) {}
    window.sessionModule.setCurrentSessionId(_parentSessionId);
    await window.sessionModule.loadSessions();
    await window.sessionModule.selectSession(_parentSessionId);
  }
}

export function stopGroup() {
  _abortControllers.forEach(ac => { if (ac) ac.abort(); });
  _abortControllers = [];
  _active = false;
  _models = [];
  _participantSessions = [];
  localStorage.removeItem(GROUP_STATE_KEY);
}

// ── 发送消息 ─────────────────────────────────────

export async function sendMessage(msg) {
  if (!_active || !_models.length) return;

  const box = document.getElementById('chat-history');
  if (!box) return;

  // 保存用户消息到父会话以持久化
  if (_parentSessionId) {
    fetch(`${API_BASE}/api/session/${_parentSessionId}/inject_messages`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: msg }] }),
    }).catch(() => {});
  }

  if (_mode === 'parallel') {
    await _sendParallel(msg, box);
  } else {
    await _sendRoundRobin(msg, box);
  }
}

function _createGroupBubble(model, box) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-ai msg-group';
  wrap.style.position = 'relative';

  // 角色标签 — 如果分配了角色则使用角色名称，否则使用模型名称
  const roleLabel = model._groupName || (model.character ? model.character.characterName : chatRenderer.shortModel(model.mid));
  const roleTs = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  wrap.innerHTML = `<div class="role">${uiModule.esc(roleLabel)} <span class="role-timestamp">${roleTs}</span></div><div class="body"></div>`;
  chatRenderer.applyModelColor(wrap.querySelector('.role'), model.mid);

  // 加载指示器 — 与 chat.js 第 3062 行相同
  const spinner = spinnerModule.create(t('group.generating_reply'), 'right');
  const bodyDiv = wrap.querySelector('.body');
  bodyDiv.appendChild(spinner.createElement());
  spinner.start();
  wrap._spinner = spinner;

  box.appendChild(wrap);
  return wrap;
}

async function _sendParallel(msg, box) {
  const holders = _models.map(m => _createGroupBubble(m, box));
  uiModule.scrollHistory();

  // 并行流式传输所有模型
  _abortControllers = _models.map(() => new AbortController());
  const results = await Promise.allSettled(_models.map((m, i) =>
    _streamToHolder(i, _participantSessions[i], msg, holders[i], _abortControllers[i])
  ));
  _abortControllers = [];

  // 它们同时回应，所以本轮无法相互反应，但将
  // 每个回复注入到其他会话中，让它们在下一条消息时
  // 互相知道对方说了什么，并能对此发表评论。
  await _syncAllResponses(holders);
}

async function _sendRoundRobin(msg, box) {
  // Randomize who goes first each message — shuffle participant indices
  // (Fisher–Yates) instead of a fixed rotation, so the order varies turn to
  // turn. Each model still takes its turn seeing all responses already given
  // this round (and prior rounds, via the cross-session injection below), so
  // later responders can react to earlier ones.
  const order = _models.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let turn = 0; turn < order.length; turn++) {
    const idx = order[turn];
    const m = _models[idx];

    const wrap = _createGroupBubble(m, box);
    uiModule.scrollHistory();

    const ac = new AbortController();
    _abortControllers = [ac];
    await _streamToHolder(idx, _participantSessions[idx], msg, wrap, ac);
    _abortControllers = [];

    // 在每次回复后，将其注入到所有其他参与者会话中
    const response = wrap.dataset.raw || '';
    if (response) {
      for (let j = 0; j < _participantSessions.length; j++) {
        if (j === idx || !_participantSessions[j]) continue;
        try {
          await fetch(`${API_BASE}/api/session/${_participantSessions[j]}/inject_messages`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{
              role: 'user',
              content: `[${m._groupName || m.display}]: ${response}`
            }]}),
          });
        } catch (e) { console.warn('[group] 同步失败:', e); }
      }
    }
  }
  // 排序现在是每条消息随机化，所以 _roundRobinIdx 不再驱动
  // 轮次顺序；仅保留在状态中用于向后兼容。
  _saveState();
}

/** 并行回复后，将每个模型的回复注入所有其他会话。 */
async function _syncAllResponses(holders) {
  for (let i = 0; i < holders.length; i++) {
    const response = holders[i].dataset.raw || '';
    if (!response) continue;
    const model = _models[i];
    for (let j = 0; j < _participantSessions.length; j++) {
      if (j === i || !_participantSessions[j]) continue;
      try {
        await fetch(`${API_BASE}/api/session/${_participantSessions[j]}/inject_messages`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{
            role: 'user',
            content: `[${model._groupName || model.display}]: ${response}`
          }]}),
        });
      } catch (e) { /* 静默处理 */ }
    }
  }
}

async function _streamToHolder(modelIdx, sessionId, msg, holderEl, abortCtrl) {
  if (!sessionId) {
    holderEl.querySelector('.body').innerHTML = '<i style="opacity:0.5;">' + t('group.session_create_failed') + '</i>';
    return;
  }

  const fd = new FormData();
  fd.append('message', msg);
  fd.append('session', sessionId);

  let accumulated = '';
  let _buffer = '';
  let _firstToken = true;
  const bodyEl = holderEl.querySelector('.body');

  try {
    const res = await fetch(`${API_BASE}/api/chat_stream`, {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
      signal: abortCtrl.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      _buffer += decoder.decode(value, { stream: true });

      // 处理完成的行
      const lines = _buffer.split('\n');
      _buffer = lines.pop(); // 保留不完整的最后一行

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        if (line === 'data: [DONE]') continue;

        try {
          const json = JSON.parse(line.slice(6));

          // 文本增量（OpenAI 格式）
          if (json.choices?.[0]?.delta?.content) {
            if (_firstToken) { _firstToken = false; if (holderEl._spinner) { holderEl._spinner.destroy(); delete holderEl._spinner; } bodyEl.innerHTML = ''; }
            accumulated += json.choices[0].delta.content;
            bodyEl.innerHTML = markdownModule.processWithThinking(
              markdownModule.squashOutsideCode(accumulated)
            );
            uiModule.scrollHistory();
          }
          // 文本增量（Odysseus 格式）
          else if (json.delta !== undefined) {
            if (_firstToken) { _firstToken = false; if (holderEl._spinner) { holderEl._spinner.destroy(); delete holderEl._spinner; } bodyEl.innerHTML = ''; }
            // 处理 vLLM 的思考标签
            let _d = json.delta;
            if (json.thinking) {
              if (!accumulated.includes('<think>')) _d = '<think>' + _d;
            } else if (accumulated.includes('<think>') && !accumulated.includes('</think>')) {
              _d = '</think>' + _d;
            }
            accumulated += _d;
            bodyEl.innerHTML = markdownModule.processWithThinking(
              markdownModule.squashOutsideCode(accumulated)
            );
            uiModule.scrollHistory();
          }
          // 代理工具事件
          else if (json.type === 'tool_start') {
            const toolDiv = document.createElement('div');
            toolDiv.className = 'agent-tool-event';
            toolDiv.style.cssText = 'font-size:11px;opacity:0.5;padding:2px 0;font-family:monospace;';
            toolDiv.textContent = `⚙ ${json.tool || t('group.tool_fallback')}${json.command ? ': ' + json.command.substring(0, 60) : ''}`;
            bodyEl.appendChild(toolDiv);
          }
          else if (json.type === 'tool_output') {
            const outDiv = document.createElement('div');
            outDiv.className = 'agent-tool-output';
            outDiv.style.cssText = 'font-size:10px;opacity:0.4;padding:2px 0;font-family:monospace;max-height:60px;overflow:hidden;';
            outDiv.textContent = (json.output || '').substring(0, 200);
            bodyEl.appendChild(outDiv);
          }
          // 生成的图片
          else if (json.type === 'generated_image' && json.url) {
            const safeImageUrl = chatRenderer.safeDisplayImageSrc(json.url);
            if (safeImageUrl) {
              const img = document.createElement('img');
              img.src = safeImageUrl;
              img.style.cssText = 'max-width:100%;border-radius:8px;margin:8px 0;';
              img.loading = 'lazy';
              bodyEl.appendChild(img);
            }
          }
          // 错误
          else if (json.error) {
            const errDiv = document.createElement('div');
            errDiv.style.cssText = 'color:var(--color-error);font-style:italic;padding:4px 0;';
            errDiv.textContent = t('group.error_prefix', { msg: json.error });
            bodyEl.appendChild(errDiv);
          }
        } catch (e) { /* 跳过无法解析的内容 */ }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('[group] 流错误:', e);
    bodyEl.innerHTML += '<div style="color:var(--color-error);font-style:italic;">' + t('group.stream_error') + '</div>';
  }

  // 最终渲染，带页脚
  if (accumulated) {
    bodyEl.innerHTML = markdownModule.processWithThinking(
      markdownModule.squashOutsideCode(accumulated)
    );
    if (window.hljs) holderEl.querySelectorAll('pre code').forEach(b => window.hljs.highlightElement(b));
    if (markdownModule.renderMermaid) markdownModule.renderMermaid(holderEl);
    holderEl.appendChild(chatRenderer.createMsgFooter(holderEl));
  } else if (!bodyEl.querySelector('.agent-tool-event') && !bodyEl.querySelector('img')) {
    bodyEl.innerHTML = '<i style="opacity:0.5;">' + t('group.no_reply') + '</i>';
  }

  holderEl.dataset.raw = accumulated;
  holderEl.dataset.groupModel = _models[modelIdx].mid;

  // 保存回复到父会话以持久化
  if (accumulated && _parentSessionId) {
    const gName = _models[modelIdx]._groupName || _models[modelIdx].display;
    fetch(`${API_BASE}/api/session/${_parentSessionId}/inject_messages`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{
        role: 'assistant', content: accumulated,
        metadata: { group_model: gName, model: _models[modelIdx].mid }
      }]}),
    }).catch(() => {});
  }
}

// ── 状态持久化 ────────────────────────────────

function _saveState() {
  try {
    localStorage.setItem(GROUP_STATE_KEY, JSON.stringify({
      active: _active,
      mode: _mode,
      models: _models,
      participantSessions: _participantSessions,
      parentSessionId: _parentSessionId,
      roundRobinIdx: _roundRobinIdx,
    }));
  } catch (e) {}
}

export function restoreState(sessionId) {
  try {
    const s = JSON.parse(localStorage.getItem(GROUP_STATE_KEY) || 'null');
    if (s && s.active && s.parentSessionId === sessionId) {
      _active = true;
      _mode = s.mode || 'parallel';
      _models = s.models || [];
      _participantSessions = s.participantSessions || [];
      _parentSessionId = s.parentSessionId;
      _roundRobinIdx = s.roundRobinIdx || 0;
      return true;
    }
  } catch (e) {}
  return false;
}

export function getModels() { return _models; }
export function getModelCount() { return _models.length; }

const groupModule = {
  init, isActive, setActive, getMode, setMode, showModelPicker,
  startGroup, stopGroup, sendMessage, restoreState,
  getModels, getModelCount,
};

export default groupModule;
window.groupModule = groupModule;
