// compare/selector.js — 模型选择弹窗
import state from './state.js';
import Storage from '../storage.js';
import { fetchModels, _persistSelections, getExcludedModels } from './models.js';
import { showScoreboard } from './scoreboard.js';
import { EYE_OPEN, EYE_CLOSED, ICON_DICE, ICON_PARALLEL, ICON_SEQUENTIAL, SAVE_ICON, WAVE_FRAMES, CHAT_ICON } from './icons.js';
import { _clearProbeWaves } from './probe.js';
import uiModule from '../ui.js';
import spinnerModule from '../spinner.js';
import themeModule from '../theme.js';
import { t } from '../i18n.js';

const escapeHtml = uiModule.esc;

// 匹配 Deep Research 的"Start"按钮（播放图标 + "Start"，由 .research-start-btn 样式化），
// 使两个主要操作看起来完全一致。
const _CMP_PLAY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
const _CMP_START_LABEL = _CMP_PLAY_ICON + ' Start';

/** 槽位标签：并行用字母（A、B），顺序用数字（1、2） */
function _slotChar(i) { return state._parallel ? String.fromCharCode(65 + i) : String(i + 1); }

/** 同步 Compare 工具栏指示器按钮状态。 */
function _syncToolbarIndicator(active) {
  // 旧的红色高亮"Compare active — click to deactivate"芯片不再显示 —
  // Compare 从自己的标题栏退出，因此输入栏工具指示器是多余的。无论状态如何都保持隐藏。
  const indicator = document.getElementById('compare-indicator-btn');
  if (indicator) {
    indicator.style.display = 'none';
    indicator.classList.remove('active');
  }
  // 通知 app.js 更新加号点指示器
  document.dispatchEvent(new CustomEvent('overflow-state-change'));
}

/** 禁用工具开关（web、bash、RAG、research）以进行纯净对比。 */
function disableToolToggles() {
  const ids = ['web-toggle', 'bash-toggle', 'rag-toggle', 'research-toggle'];
  state._savedToggles = {};
  ids.forEach(id => {
    const chk = document.getElementById(id);
    if (chk) {
      state._savedToggles[id] = chk.checked;
      if (chk.checked) { chk.checked = false; chk.dispatchEvent(new Event('change')); }
    }
  });
}

/** 将工具开关恢复到对比前的状态。 */
function restoreToolToggles() {
  if (!state._savedToggles) return;
  Object.entries(state._savedToggles).forEach(([id, wasChecked]) => {
    const chk = document.getElementById(id);
    if (chk && wasChecked && !chk.checked) { chk.checked = true; chk.dispatchEvent(new Event('change')); }
  });
  state._savedToggles = null;
}

/** 显示带有动态模型列表和开关的模型选择弹窗。 */
async function showModelSelector() {
  return new Promise((resolve) => {
    let models = [];
    let _modelsLoaded = false;

    const overlay = document.createElement('div');
    overlay.id = 'compare-model-overlay';
    overlay.className = 'modal';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.width = 'min(520px, 92vw)';

    // ── 标题栏（可拖拽） ──
    const header = document.createElement('div');
    header.className = 'modal-header';

    const title = document.createElement('h4');
    title.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></svg>Model Comparison';
    // 吸收空闲空间，使注入的最小化 (_) 和关闭 (✕) 按钮聚集在右侧，
    // 而不是被 space-between 分散开。
    title.style.marginRight = 'auto';
    header.appendChild(title);

    // 最小化 (_) + 关闭 (✕) 分组在一个容器中，使它们始终紧靠在右侧
    // （自动注入的最小化按钮原本会漂离关闭按钮）。最小化按钮带有
    // .minimize-btn 类名，使弹窗管理器连接它而不是注入第二个。
    const headerCtrls = document.createElement('div');
    headerCtrls.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';

    const headerMinBtn = document.createElement('button');
    headerMinBtn.type = 'button';
    headerMinBtn.className = 'modal-minimize-btn minimize-btn';
    headerMinBtn.title = t('modal.minimize');
    headerMinBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="18" x2="19" y2="18"/></svg>';
    headerMinBtn.style.margin = '0';

    const headerCloseBtn = document.createElement('button');
    headerCloseBtn.className = 'close-btn';
    headerCloseBtn.innerHTML = '&#x2716;';
    headerCloseBtn.style.cssText = 'flex-shrink:0;margin:0;';
    headerCloseBtn.addEventListener('click', () => cleanup(false));

    headerCtrls.appendChild(headerMinBtn);
    headerCtrls.appendChild(headerCloseBtn);

    // 开关图标容器
    const toggleRow = document.createElement('div');
    toggleRow.style.cssText = 'display:flex;gap:4px;align-items:flex-start;margin-left:auto;margin-right:8px;';

    function _toggleLabel(text) {
      return '<span class="compare-toggle-label">' + text + '</span>';
    }

    state._blindMode = true;
    const blindBtn = document.createElement('button');
    blindBtn.type = 'button';
    blindBtn.className = 'compare-blind-toggle active';
    blindBtn.title = t('compare.blind_title');
    blindBtn.innerHTML = EYE_CLOSED + _toggleLabel(t('compare.blind'));
    blindBtn.addEventListener('click', () => {
      state._blindMode = !state._blindMode;
      blindBtn.classList.toggle('active', state._blindMode);
      blindBtn.innerHTML = (state._blindMode ? EYE_CLOSED : EYE_OPEN) + _toggleLabel(t('compare.blind'));
      // 关闭盲评模式会显示已随机排列的模型
      if (!state._blindMode && _shuffled) {
        _shuffled = false;
        diceBtn.classList.remove('active');
      }
      renderModelRows();
      // 移动端隐藏按钮标签 — 通过 toast 显示新状态。
      uiModule.showToast(state._blindMode ? t('compare.blind_on') : t('compare.blind_off'));
      _updateModeLabel();
      _setModeHint(state._blindMode
        ? '<span style="color:var(--color-blind-orange)">Blind mode</span>: model names stay hidden until you vote.'
        : '<span style="color:var(--color-blind-orange)">Blind mode off</span>: model names are shown.');
    });
    toggleRow.appendChild(blindBtn);

    // 并行 / 顺序切换 — 紧挨盲评按钮右侧
    state._parallel = true;
    const parallelBtn = document.createElement('button');
    parallelBtn.type = 'button';
    parallelBtn.className = 'compare-parallel-toggle active';
    parallelBtn.title = t('compare.parallel_title');
    parallelBtn.innerHTML = ICON_PARALLEL + _toggleLabel(t('compare.parallel'));
    parallelBtn.addEventListener('click', () => {
      state._parallel = !state._parallel;
      parallelBtn.classList.toggle('active', state._parallel);
      parallelBtn.innerHTML = (state._parallel ? ICON_PARALLEL : ICON_SEQUENTIAL) + _toggleLabel(state._parallel ? t('compare.parallel') : t('compare.sequential'));
      parallelBtn.title = state._parallel ? 'Switch to one at a time' : 'Run side by side';
      renderModelRows();
      uiModule.showToast((state._parallel ? t('compare.mode_parallel') : t('compare.mode_sequential')));
      _updateModeLabel();
      _setModeHint(state._parallel
        ? '<span style="color:#5b8def">Parallel</span>: all models answer at once, side by side.'
        : '<span style="color:#e0a050">Sequential</span>: models answer one at a time.');
    });
    toggleRow.appendChild(parallelBtn);

    // 骰子 / 随机排列按钮 — 紧挨盲评切换右侧
    const diceBtn = document.createElement('button');
    diceBtn.type = 'button';
    diceBtn.className = 'compare-dice-toggle';
    diceBtn.title = t('compare.shuffle_title');
    diceBtn.innerHTML = ICON_DICE + _toggleLabel(t('compare.shuffle'));
    diceBtn.addEventListener('click', () => {
      if (!_modelsLoaded) return;
      // 如果已经随机排列，则关闭
      if (_shuffled) {
        _shuffled = false;
        diceBtn.classList.remove('active');
        renderModelRows();
        uiModule.showToast(t('compare.mode_shuffle_off'));
        _updateModeLabel();
        _setModeHint('<span style="color:var(--red)">Shuffle off</span>: choose the models yourself.');
        return;
      }
      // 从筛选列表中为每个槽位随机选择模型
      const excluded = getExcludedModels();
      const pool = filteredModels().filter(m => !excluded.includes(m.id)).slice();
      if (pool.length === 0) return;
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (let i = 0; i < selections.length; i++) {
        const m = pool[i % pool.length];
        selections[i] = { model: m.id, endpoint: m.url, endpointId: m.endpointId, name: m.name, endpointName: m.endpointName || '' };
      }
      _shuffled = true;
      // 自动启用盲评模式，使选择保持隐藏
      if (!state._blindMode) {
        state._blindMode = true;
        blindBtn.classList.add('active');
        blindBtn.innerHTML = EYE_CLOSED + _toggleLabel(t('compare.blind'));
      }
      renderModelRows();
      uiModule.showToast(state._blindMode ? 'Mode: Shuffle on · Blind on' : 'Mode: Shuffle on');
      _updateModeLabel();
      _setModeHint('<span style="color:var(--red)">Shuffle</span>: random models picked for each slot (auto-hidden).');
      // 显示激活状态 + 仅旋转骰子图标
      diceBtn.classList.add('active');
      const diceSvg = diceBtn.querySelector('svg');
      if (diceSvg) {
        diceSvg.style.transition = 'transform 0.3s ease';
        diceSvg.style.transform = 'rotate(360deg)';
        setTimeout(() => { diceSvg.style.transition = ''; diceSvg.style.transform = ''; }, 300);
      }
    });
    toggleRow.appendChild(diceBtn);

    // （回合前"Shuffle models?"提示已在用户要求下移除 —
    // 运行状态的窗格仍会显示自己的随机排列提示。）
    function _remindShuffle() { /* 选择器中的空操作 */ }

    state._continueChat = false;

    state._saveOnClose = false;
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'compare-save-toggle';
    saveBtn.title = t('compare.save_title');
    saveBtn.innerHTML = SAVE_ICON + _toggleLabel(t('compare.save'));
    saveBtn.addEventListener('click', () => {
      state._saveOnClose = !state._saveOnClose;
      saveBtn.classList.toggle('active', state._saveOnClose);
      uiModule.showToast(state._saveOnClose ? t('compare.save_on') : t('compare.save_off'));
      _updateModeLabel();
      _setModeHint(state._saveOnClose
        ? '<span style="color:var(--color-save-green)">Save</span>: keep these sessions after you close Compare.'
        : '<span style="color:var(--color-save-green)">Save off</span>: sessions are discarded when you close Compare.');
    });
    toggleRow.appendChild(saveBtn);

    // Reset 按钮
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'compare-reset-toggle';
    resetBtn.title = t('compare.reset_title');
    resetBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>' + _toggleLabel(t('compare.reset'));
    resetBtn.addEventListener('click', () => {
      state._blindMode = true;
      blindBtn.classList.add('active');
      blindBtn.innerHTML = EYE_CLOSED + _toggleLabel(t('compare.blind'));
      _shuffled = false;
      diceBtn.classList.remove('active');
      state._continueChat = false;
      state._saveOnClose = false;
      saveBtn.classList.remove('active');
      state._parallel = true;
      parallelBtn.classList.add('active');
      parallelBtn.innerHTML = ICON_PARALLEL + _toggleLabel(t('compare.parallel'));
      selections = [null, null];
      renderModelRows();
    });
    toggleRow.appendChild(resetBtn);

    header.appendChild(headerCtrls);

    content.appendChild(header);

    // ── 正文 ──
    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.padding = '12px 16px';

    const desc = document.createElement('p');
    desc.style.cssText = 'color:color-mix(in srgb, var(--fg) 55%, transparent);font-size:0.85em;margin:0 0 12px;';
    desc.textContent = t('compare.description');
    body.appendChild(desc);

    // 选项行
    toggleRow.style.cssText = 'display:flex;gap:4px;align-items:flex-start;flex-wrap:wrap;';
    const modeWrap = document.createElement('div');
    modeWrap.className = 'compare-section';
    const modeLabel = document.createElement('div');
    modeLabel.className = 'compare-section-label';
    // 仅在移动端显示活跃模式（+颜色），以 span 追加，因为图标文字标签在移动端被隐藏，仅靠图标会难以辨识。
    modeLabel.innerHTML = 'Mode: <span class="compare-mode-current"></span>';
    modeWrap.appendChild(modeLabel);
    modeWrap.appendChild(toggleRow);
    // 描述你刚刚切换的模式的一句话提示。
    const modeHint = document.createElement('div');
    modeHint.className = 'compare-mode-hint';
    modeWrap.appendChild(modeHint);
    function _setModeHint(html) { modeHint.innerHTML = html || ''; }
    body.appendChild(modeWrap);

    // 在"Mode:"标签中反映活跃模式，每种模式用其图标的颜色显示。
    function _updateModeLabel() {
      const cur = modeLabel.querySelector('.compare-mode-current');
      if (!cur) return;
      const parts = [];
      if (state._blindMode) parts.push('<span style="color:var(--color-blind-orange)">Blind</span>');
      parts.push(state._parallel
        ? '<span style="color:#5b8def">Parallel</span>'
        : '<span style="color:#e0a050">Sequential</span>');
      if (_shuffled) parts.push('<span style="color:var(--red)">Shuffle</span>');
      if (state._saveOnClose) parts.push('<span style="color:var(--color-save-green)">Save</span>');
      cur.innerHTML = parts.join(', ');
    }

    // ── 类型标签页（Chat / Agent / Search / Research） ──
    state._compareMode = 'chat';
    const typeWrap = document.createElement('div');
    typeWrap.className = 'compare-section';
    const typeLabel = document.createElement('div');
    typeLabel.className = 'compare-section-label';
    // 仅在移动端以 span 显示活跃类型名称（+图标），因为标签文字在移动端被隐藏，仅靠图标会难以辨识。
    typeLabel.innerHTML = 'Type: <span class="compare-type-current"></span>';
    typeWrap.appendChild(typeLabel);
    const tabBar = document.createElement('div');
    tabBar.className = 'compare-mode-tabs compare-type-tabs';
    // Agent — shell 提示符 `>_`（匹配编辑器中的 bash-toggle-btn 图标）
    const _ICON_AGENT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
    const _ICON_SEARCH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    // Research — 带 `+` 的放大镜（匹配侧边栏 Deep Research 图标）
    const _ICON_RESEARCH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
    const _modes = [
      { id: 'chat', label: 'Chat', icon: CHAT_ICON },
      { id: 'agent', label: 'Agent', icon: _ICON_AGENT },
      { id: 'search', label: 'Search', icon: _ICON_SEARCH },
      { id: 'research', label: 'Research', icon: _ICON_RESEARCH },
    ];
    _modes.forEach(m => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'compare-mode-tab' + (m.id === 'chat' ? ' active' : '');
      tab.innerHTML = m.icon + '<span class="compare-toggle-label">' + m.label + '</span>';
      tab.dataset.mode = m.id;
      tab.addEventListener('click', () => setModeTab(m.id));
      tabBar.appendChild(tab);
    });
    // 在"Type:"标签中反映活跃类型（图标 + 名称），用于移动端。
    function _updateTypeLabel(mode) {
      const cur = typeLabel.querySelector('.compare-type-current');
      const m = _modes.find(x => x.id === mode);
      if (cur && m) cur.innerHTML = m.icon + '<span>' + m.label + '</span>';
    }
    _updateTypeLabel('chat');
    typeWrap.appendChild(tabBar);
    body.appendChild(typeWrap);

    // 每个标签页的选择记忆
    const _tabSelections = { chat: null, agent: null, search: null, research: null };

    function setModeTab(mode) {
      if (!_modelsLoaded) return;
      // 在切换前保存当前标签页的选择
      _tabSelections[state._compareMode] = selections.map(s => s ? { ...s } : null);
      state._compareMode = mode;
      tabBar.querySelectorAll('.compare-mode-tab').forEach(t => t.classList.remove('active'));
      const activeTab = tabBar.querySelector(`[data-mode="${mode}"]`);
      if (activeTab) activeTab.classList.add('active');
      _updateTypeLabel(mode);
      _shuffled = false;
      diceBtn.classList.remove('active');
      // Search 和 Research 默认顺序执行；其他默认并行执行
      if (mode === 'search' || mode === 'research') {
        state._parallel = false;
        parallelBtn.classList.remove('active');
        parallelBtn.innerHTML = ICON_SEQUENTIAL + _toggleLabel(t('compare.sequential'));
      } else {
        state._parallel = true;
        parallelBtn.classList.add('active');
        parallelBtn.innerHTML = ICON_PARALLEL + _toggleLabel(t('compare.parallel'));
      }
      // 恢复此标签页的已保存选择，或使用默认值
      selections = _tabSelections[mode] ? _tabSelections[mode].slice() : [null, null];
      _updateModeLabel();
      _setModeHint('');
      renderModelRows();
    }
    // 标签页点击监听器在上面的循环中设置

    // ── 模型列表 ──
    const listContainer = document.createElement('div');
    body.appendChild(listContainer);

    // 立即显示带 Spinner 的加载状态
    const _loadingDiv = document.createElement('div');
    _loadingDiv.style.cssText = 'color:color-mix(in srgb, var(--fg) 40%, transparent);font-size:0.85em;padding:12px 0;text-align:left;';
    if (spinnerModule) {
      const _loadSpinner = spinnerModule.create('Loading models', 'right');
      _loadingDiv.appendChild(_loadSpinner.createElement());
      _loadSpinner.start();
    } else {
      _loadingDiv.textContent = t('compare.loading_models');
    }
    listContainer.appendChild(_loadingDiv);

    // 从存储中恢复上次使用的选择（按模式区分）
    const _selKey = 'odysseus-compare-selections-' + (state._compareMode || 'chat');
    let selections = Storage.getJSON(_selKey) || Storage.getJSON('odysseus-compare-selections') || [];
    // 为 search/research 恢复合成模型
    if (state._compareMode === 'search' || state._compareMode === 'research') {
      const savedSynth = Storage.getJSON('odysseus-compare-synth-' + state._compareMode);
      if (savedSynth) state._searchSynthModels = savedSynth;
    }
    // 根据可用模型验证已保存的选择（模型加载后完成）
    let _needsValidation = selections.length > 0;
    let addBtn = null;
    let _shuffled = false;
    _updateModeLabel(); // 初始显示（默认为 Blind + Parallel 开启）

    function filteredModels() {
      // Agent 和 Research 模式使用聊天模型
      const effectiveType = (state._compareMode === 'agent' || state._compareMode === 'research') ? 'chat' : state._compareMode;
      return models.filter(m => m.type === effectiveType);
    }

    function buildOption(m) {
      return {
        val: JSON.stringify({ model: m.id, endpoint: m.url, endpointId: m.endpointId, name: m.name, endpointName: m.endpointName || '' }),
        label: m.endpointName ? `${m.name} (${m.endpointName})` : m.name,
      };
    }

    /** 构建可搜索的模型选择器（当 >5 个模型时使用） */
    function _buildSearchablePicker(modelList, currentSel, slotIdx, onSelect) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'flex:1;position:relative;';

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Search models\u2026';
      input.className = 'cmp-form-control';
      input.style.cssText = 'width:100%;box-sizing:border-box;';
      // 移动端：禁止屏幕键盘，使点击选择器时打开下拉菜单但
      // 不会弹出键盘遮挡列表。（匹配 +Model 下拉菜单的移动端行为。）
      if (window.innerWidth <= 768) {
        input.setAttribute('inputmode', 'none');
        input.setAttribute('readonly', 'readonly');
      }
      if (currentSel) {
        const m = modelList.find(m => m.id === currentSel.model && m.url === currentSel.endpoint)
          || modelList.find(m => m.id === currentSel.model);
        if (m) input.value = buildOption(m).label;
      } else {
        const fallback = modelList[Math.min(slotIdx, modelList.length - 1)];
        if (fallback) input.value = buildOption(fallback).label;
      }
      wrap.appendChild(input);

      const dropdown = document.createElement('div');
      dropdown.className = 'cmp-picker-dropdown';
      // 追加到 document.body（而非 wrap）并使用 position:fixed，以避开
      // 弹窗的 overflow 裁剪和 modal-content 上的任何 transform
      // （变换后的祖先会使 position:fixed 相对于它裁剪 — 这就是为什么
      // 下拉菜单一直被下一行裁剪的原因）。坐标在 _placeDropdown 中设置。
      dropdown.style.cssText = 'display:none;position:fixed;max-height:200px;overflow-y:auto;background:var(--panel);border:1px solid var(--border);border-radius:6px;z-index:100000;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
      document.body.appendChild(dropdown);

      function renderItems(query) {
        dropdown.innerHTML = '';
        const q = (query || '').toLowerCase();
        const matches = modelList.filter(m => {
          const label = buildOption(m).label.toLowerCase();
          return !q || label.includes(q);
        });
        if (matches.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:8px 12px;color:color-mix(in srgb, var(--fg) 40%, transparent);font-size:0.82em;font-style:italic;';
          empty.textContent = t('compare.no_matches');
          dropdown.appendChild(empty);
          return;
        }
        matches.forEach(m => {
          const opt = buildOption(m);
          const item = document.createElement('div');
          item.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:0.85em;transition:background 0.08s;';
          item.textContent = opt.label;
          const isSelected = currentSel && currentSel.model === m.id && (currentSel.endpoint === m.url || !modelList.some(o => o.id === m.id && o !== m));
          if (isSelected) item.style.background = 'color-mix(in srgb, var(--fg) 8%, transparent)';
          item.addEventListener('mouseenter', () => { item.style.background = 'color-mix(in srgb, var(--fg) 10%, transparent)'; });
          item.addEventListener('mouseleave', () => { item.style.background = isSelected ? 'color-mix(in srgb, var(--fg) 8%, transparent)' : ''; });
          item.addEventListener('click', () => {
            const chosen = { model: m.id, endpoint: m.url, endpointId: m.endpointId, name: m.name, endpointName: m.endpointName || '' };
            input.value = opt.label;
            currentSel = chosen;
            onSelect(chosen);
            dropdown.style.display = 'none';
            input.blur();
          });
          dropdown.appendChild(item);
        });
      }

      // 根据上下两侧的空间大小将下拉菜单定位在输入框的下方或上方 —
      // 否则在移动端底部面板中，靠近屏幕底部的选择器会向下弹出并
      // 被弹窗裁剪或超出视口边界。
      const _placeDropdown = () => {
        const inRect = input.getBoundingClientRect();
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        const below = vh - inRect.bottom;
        const above = inRect.top;
        const flipUp = below < 220 && above > below;
        // 水平：对齐输入框但约束在视口内，使移动端不会超出屏幕边缘。
        const width = Math.min(inRect.width, vw - 16);
        let left = inRect.left;
        if (left + width > vw - 8) left = vw - 8 - width;
        if (left < 8) left = 8;
        dropdown.style.left = left + 'px';
        dropdown.style.width = width + 'px';
        // 垂直：根据可用空间上下翻转（使用固定坐标）。
        if (flipUp) {
          dropdown.style.top = 'auto';
          dropdown.style.bottom = (vh - inRect.top + 2) + 'px';
          dropdown.style.maxHeight = Math.max(120, Math.min(280, above - 16)) + 'px';
        } else {
          dropdown.style.bottom = 'auto';
          dropdown.style.top = (inRect.bottom + 2) + 'px';
          dropdown.style.maxHeight = Math.max(120, Math.min(280, below - 16)) + 'px';
        }
      };
      input.addEventListener('focus', () => {
        input.value = '';
        renderItems('');
        dropdown.style.display = '';
        _placeDropdown();
      });
      input.addEventListener('input', () => {
        renderItems(input.value);
        dropdown.style.display = '';
        _placeDropdown();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = dropdown.querySelector('div[style*="cursor:pointer"]');
          if (first) first.click();
        }
      });
      // 通过外部点击关闭。下拉菜单位于 document.body 中，因此检查
      // wrap 和 dropdown；当选器行从 DOM 中移除（重建）时销毁下拉菜单，
      // 使其不会在 body 中孤立。
      function _closeHandler(e) {
        if (!wrap.contains(e.target) && !dropdown.contains(e.target)) {
          dropdown.style.display = 'none';
          if (currentSel) {
            const m = modelList.find(m => m.id === currentSel.model && m.url === currentSel.endpoint);
            if (m) input.value = buildOption(m).label;
          }
          if (!wrap.isConnected) {
            dropdown.remove();
            document.removeEventListener('click', _closeHandler, true);
          }
        }
      }
      setTimeout(() => document.addEventListener('click', _closeHandler, true), 0);

      return wrap;
    }

    function renderModelRows() {
      if (!_modelsLoaded) return;
      // 选择器下拉菜单位于 document.body 中（以避开弹窗裁剪）；
      // 在重建行之前清除任何残留，以免孤立。
      document.querySelectorAll('.cmp-picker-dropdown').forEach(d => d.remove());

      // ── 搜索模式：显示提供商下拉菜单 ──
      if (state._compareMode === 'search') {
        listContainer.innerHTML = '';
        if (!state._cachedProviders) {
          listContainer.innerHTML = '<div style="color:color-mix(in srgb, var(--fg) 40%, transparent);font-size:0.85em;padding:12px 0;text-align:left;">Loading search providers\u2026</div>';
          fetch(`${state.API_BASE}/api/search/providers`).then(r => r.json()).then(providers => {
            state._cachedProviders = providers;
            renderModelRows();
          }).catch(() => {
            listContainer.innerHTML = '<div style="color:var(--color-error);font-size:0.85em;padding:12px 0;">Failed to load search providers</div>';
          });
          return;
        }
        const available = state._cachedProviders.filter(p => p.available);
        if (available.length === 0) {
          listContainer.innerHTML = '<div style="color:color-mix(in srgb, var(--fg) 40%, transparent);font-size:0.85em;padding:12px 0;text-align:center;font-style:italic;">No search providers configured</div>';
          if (addBtn) addBtn.style.display = 'none';
          return;
        }
        // 确保每个窗格的合成模型数组与选择数量匹配
        if (!state._searchSynthModels) state._searchSynthModels = [];
        while (state._searchSynthModels.length < selections.length) state._searchSynthModels.push(null);

        const chatModels = state._cachedModels.filter(m => m.type === 'chat');
        const _seqStepS = !state._parallel ? Math.min(20, Math.floor(80 / Math.max(selections.length, 1))) : 0;

        selections.forEach((sel, idx) => {
          const row = document.createElement('div');
          row.className = 'cmp-model-row';
          if (_seqStepS) row.style.marginLeft = (idx * _seqStepS) + 'px';

          // 左侧标签：数字/字母 或 盲评眼睛图标
          const lbl = document.createElement('span');
          lbl.className = 'cmp-row-label';
          if (state._blindMode) {
            lbl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/></svg>';
          } else {
            lbl.textContent = _slotChar(idx);
          }
          row.appendChild(lbl);

          // 模型选择器（合成 LLM）— 大型列表使用可搜索选择器
          if (!state._searchSynthModels[idx] && chatModels.length > 0) {
            const fb = chatModels[Math.min(idx, chatModels.length - 1)];
            state._searchSynthModels[idx] = { model: fb.id, endpoint: fb.url, endpointId: fb.endpointId, name: fb.name };
          }
          if (chatModels.length >= 5) {
            const picker = _buildSearchablePicker(chatModels, state._searchSynthModels[idx], idx, (chosen) => {
              state._searchSynthModels[idx] = chosen;
            });
            row.appendChild(picker);
          } else {
            const modelSelect = document.createElement('select');
            modelSelect.className = 'cmp-form-control';
            modelSelect.style.flex = '1';
            chatModels.forEach(m => {
              const opt = document.createElement('option');
              opt.value = JSON.stringify({ model: m.id, endpoint: m.url, endpointId: m.endpointId, name: m.name, endpointName: m.endpointName || '' });
              opt.textContent = m.endpointName ? `${m.name} (${m.endpointName})` : m.name;
              if (state._searchSynthModels[idx] && state._searchSynthModels[idx].model === m.id) opt.selected = true;
              modelSelect.appendChild(opt);
            });
            modelSelect.addEventListener('change', () => {
              try { state._searchSynthModels[idx] = JSON.parse(modelSelect.value); } catch (e) {}
            });
            try { if (!state._searchSynthModels[idx]) state._searchSynthModels[idx] = JSON.parse(modelSelect.value); } catch (e) {}
            row.appendChild(modelSelect);
          }

          // 搜索提供商选择器（较小）
          const provSelect = document.createElement('select');
          provSelect.className = 'cmp-form-control cmp-prov-select';
          available.forEach((p, pi) => {
            const optEl = document.createElement('option');
            optEl.value = JSON.stringify({ model: p.id, endpoint: '', endpointId: null, name: p.label, searchProvider: p.id });
            optEl.textContent = p.label;
            if (sel && sel.model === p.id) optEl.selected = true;
            else if (!sel && pi === Math.min(idx, available.length - 1)) optEl.selected = true;
            provSelect.appendChild(optEl);
          });
          provSelect.addEventListener('change', () => {
            try { selections[idx] = JSON.parse(provSelect.value); } catch (e) {}
          });
          try { if (!selections[idx]) selections[idx] = JSON.parse(provSelect.value); } catch (e) {}
          row.appendChild(provSelect);

          // X 移除按钮（当槽位 >2 时显示）
          if (selections.length > 2) {
            const rmBtn = document.createElement('button');
            rmBtn.type = 'button';
            rmBtn.textContent = '\u00d7';
            rmBtn.className = 'cmp-rm-btn';
            rmBtn.addEventListener('mouseenter', () => { rmBtn.style.opacity = '1'; rmBtn.style.color = 'var(--color-error)'; });
            rmBtn.addEventListener('mouseleave', () => { rmBtn.style.opacity = '0.3'; rmBtn.style.color = 'var(--fg)'; });
            rmBtn.addEventListener('click', () => { selections.splice(idx, 1); state._searchSynthModels.splice(idx, 1); renderModelRows(); });
            row.appendChild(rmBtn);
          }

          listContainer.appendChild(row);
        });
        if (addBtn) addBtn.style.display = selections.length >= 8 ? 'none' : '';
        return;
      }

      // ── Chat / Image / Agent / Research 模式：显示模型下拉菜单 ──
      const filtered = filteredModels();
      listContainer.innerHTML = '';

      // Research 模式也需要搜索提供商 — 如果尚未缓存则获取
      const needsProviders = state._compareMode === 'research';
      if (needsProviders && !state._cachedProviders) {
        listContainer.innerHTML = '<div style="color:color-mix(in srgb, var(--fg) 40%, transparent);font-size:0.85em;padding:12px 0;">Loading search providers\u2026</div>';
        fetch(`${state.API_BASE}/api/search/providers`).then(r => r.json()).then(providers => {
          state._cachedProviders = providers;
          renderModelRows();
        }).catch(() => {
          state._cachedProviders = [];
          renderModelRows();
        });
        return;
      }

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:color-mix(in srgb, var(--fg) 40%, transparent);font-size:0.85em;padding:12px 0;text-align:center;font-style:italic;';
        empty.textContent = t('compare.no_models_available', { mode: state._compareMode });
        listContainer.appendChild(empty);
        if (addBtn) addBtn.style.display = 'none';
        return;
      }

      // Research：确保每个窗格的提供商数组
      const researchProviders = needsProviders && state._cachedProviders ? state._cachedProviders.filter(p => p.available) : [];
      if (!state._searchSynthModels) state._searchSynthModels = [];
      while (state._searchSynthModels.length < selections.length) state._searchSynthModels.push(null);

      const _seqStep = !state._parallel ? Math.min(20, Math.floor(80 / Math.max(selections.length, 1))) : 0;
      selections.forEach((sel, idx) => {
        const row = document.createElement('div');
        row.className = 'cmp-model-row';
        if (_seqStep) row.style.marginLeft = (idx * _seqStep) + 'px';

        // 左侧标签：数字/字母 或 盲评眼睛图标
        const lbl = document.createElement('span');
        lbl.className = 'cmp-row-label';
        if (state._blindMode) {
          lbl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/></svg>';
        } else {
          lbl.textContent = _slotChar(idx);
        }
        row.appendChild(lbl);

        if (_shuffled) {
          const mask = document.createElement('div');
          mask.className = 'cmp-form-control';
          mask.style.cssText = 'flex:1;opacity:0.4;font-style:italic;';
          mask.textContent = t('compare.hidden');
          row.appendChild(mask);
        } else if (filtered.length >= 5) {
          const picker = _buildSearchablePicker(filtered, sel, idx, (chosen) => {
            selections[idx] = chosen;
            _remindShuffle();
          });
          if (!selections[idx]) {
            const fallback = filtered[Math.min(idx, filtered.length - 1)];
            selections[idx] = { model: fallback.id, endpoint: fallback.url, endpointId: fallback.endpointId, name: fallback.name };
          }
          row.appendChild(picker);
        } else {
          const select = document.createElement('select');
          select.className = 'cmp-form-control';
          select.style.flex = '1';
          filtered.forEach((m, mi) => {
            const opt = buildOption(m);
            const optEl = document.createElement('option');
            optEl.value = opt.val;
            optEl.textContent = opt.label;
            if (sel && sel.model === m.id && (sel.endpoint === m.url || !filtered.some(o => o.id === m.id && o !== m))) optEl.selected = true;
            else if (!sel && mi === Math.min(idx, filtered.length - 1)) optEl.selected = true;
            select.appendChild(optEl);
          });
          select.addEventListener('change', () => {
            try { selections[idx] = JSON.parse(select.value); } catch (e) { console.warn('Compare model select parse failed:', e); }
            _remindShuffle();
          });
          try { if (!selections[idx]) selections[idx] = JSON.parse(select.value); } catch (e) { console.warn('Compare model init parse failed:', e); }
          row.appendChild(select);
        }

        // Research 模式：模型旁边的搜索提供商选择器
        if (needsProviders && researchProviders.length > 0 && !_shuffled) {
          const provSelect = document.createElement('select');
          provSelect.className = 'cmp-form-control cmp-prov-select';
          provSelect.title = t('compare.search_provider');
          researchProviders.forEach((p, pi) => {
            const optEl = document.createElement('option');
            optEl.value = p.id;
            optEl.textContent = p.label;
            if (state._searchSynthModels[idx] && state._searchSynthModels[idx] === p.id) optEl.selected = true;
            else if (!state._searchSynthModels[idx] && pi === 0) optEl.selected = true;
            provSelect.appendChild(optEl);
          });
          provSelect.addEventListener('change', () => { state._searchSynthModels[idx] = provSelect.value; });
          if (!state._searchSynthModels[idx]) state._searchSynthModels[idx] = provSelect.value;
          row.appendChild(provSelect);
        }

        // X 移除按钮（当槽位 >2 时显示）
        if (selections.length > 2) {
          const rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.textContent = '\u00d7';
          rmBtn.className = 'cmp-rm-btn';
          rmBtn.addEventListener('mouseenter', () => { rmBtn.style.opacity = '1'; rmBtn.style.color = 'var(--color-error)'; });
          rmBtn.addEventListener('mouseleave', () => { rmBtn.style.opacity = '0.3'; rmBtn.style.color = 'var(--fg)'; });
          rmBtn.addEventListener('click', () => { selections.splice(idx, 1); if (state._searchSynthModels.length > idx) state._searchSynthModels.splice(idx, 1); renderModelRows(); });
          row.appendChild(rmBtn);
        }

        listContainer.appendChild(row);
      });
      if (addBtn) addBtn.style.display = (selections.length >= 8) ? 'none' : '';
    }

    // 如果没有已保存的选择，则默认使用 2 个空槽位
    if (!selections.length || !selections.some(s => s !== null)) selections = [null, null];

    addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.style.cssText = 'display:none;align-items:center;gap:6px;background:none;border:1px dashed var(--border);color:var(--fg);border-radius:6px;cursor:pointer;padding:6px 12px;font-size:0.82em;opacity:0.6;transition:all 0.15s;margin-bottom:16px;width:100%;justify-content:center;';
    addBtn.textContent = t('compare.add_model');
    addBtn.addEventListener('mouseenter', () => { addBtn.style.opacity = '1'; });
    addBtn.addEventListener('mouseleave', () => { addBtn.style.opacity = '0.6'; });
    addBtn.addEventListener('click', () => {
      if (selections.length >= 8) return;
      if (_shuffled) {
        // 在随机排列模式下，每个槽位都是一个隐藏的、随机选择的模型 — 因此
        // 新槽位也必须获得一个随机池中的模型，而非一个空选择器。
        const excluded = getExcludedModels();
        const used = new Set(selections.filter(Boolean).map(s => s.model + '|' + s.endpoint));
        const pool = filteredModels().filter(m => !excluded.includes(m.id));
        const fresh = pool.filter(m => !used.has(m.id + '|' + m.url));
        const src = fresh.length ? fresh : pool;
        const pick = src.length ? src[Math.floor(Math.random() * src.length)] : null;
        selections.push(pick ? { model: pick.id, endpoint: pick.url, endpointId: pick.endpointId, name: pick.name, endpointName: pick.endpointName || '' } : null);
      } else {
        selections.push(null);
      }
      renderModelRows();
      _remindShuffle();
    });
    body.appendChild(addBtn);

    // ── 超时输入 ──
    const timeoutRow = document.createElement('div');
    timeoutRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
    const timeoutLabel = document.createElement('span');
    timeoutLabel.style.cssText = 'color:color-mix(in srgb, var(--fg) 55%, transparent);font-size:0.82em;';
    timeoutLabel.textContent = t('compare.timeout');
    const timeoutInput = document.createElement('input');
    timeoutInput.type = 'number';
    timeoutInput.min = '5';
    timeoutInput.max = '300';
    timeoutInput.value = String(state._timeout);
    timeoutInput.style.cssText = 'width:60px;padding:4px 8px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;font-size:0.82em;text-align:center;-moz-appearance:textfield;';
    const timeoutSuffix = document.createElement('span');
    timeoutSuffix.style.cssText = 'color:color-mix(in srgb, var(--fg) 55%, transparent);font-size:0.82em;';
    timeoutSuffix.textContent = t('compare.seconds');
    timeoutRow.appendChild(timeoutLabel);
    timeoutRow.appendChild(timeoutInput);
    timeoutRow.appendChild(timeoutSuffix);

    // 计分板按钮
    const scoreBtn = document.createElement('button');
    scoreBtn.type = 'button';
    scoreBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>Scoreboard';
    scoreBtn.style.cssText = 'margin-left:auto;padding:4px 10px;background:transparent;color:var(--fg);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:0.82em;opacity:0.7;position:relative;top:-5px;';
    scoreBtn.addEventListener('mouseenter', () => { scoreBtn.style.opacity = '1'; });
    scoreBtn.addEventListener('mouseleave', () => { scoreBtn.style.opacity = '0.7'; });
    scoreBtn.addEventListener('click', () => showScoreboard());
    timeoutRow.appendChild(scoreBtn);

    body.appendChild(timeoutRow);

    content.appendChild(body);

    // ── 带操作按钮的页脚 ──
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding:14px 16px 10px;border-top:1px solid var(--border);';
    // Cancel 按钮已移除 — 覆盖层的 X / 外部点击 / Esc 都可以关闭弹窗，因此页脚的 Cancel 是多余的。
    const startBtn = document.createElement('button');
    startBtn.innerHTML = _CMP_START_LABEL;
    startBtn.className = 'research-start-btn';
    startBtn.disabled = true;
    // 固定在 30px 的框内，与 Cancel 相同，使两个按钮位于同一行。
    startBtn.style.cssText = 'opacity:0.4;height:30px;box-sizing:border-box;align-items:center;';
    footer.appendChild(startBtn);
    content.appendChild(footer);

    overlay.appendChild(content);
    document.body.appendChild(overlay);

    // 通过标题栏使弹窗可拖拽
    if (themeModule && themeModule.makeDraggable) {
      themeModule.makeDraggable(content, header);
    }

    function cleanup(result) {
      overlay.remove();
      // 移除任何追加到 body 的选择器下拉菜单，以免孤立。
      document.querySelectorAll('.cmp-picker-dropdown').forEach(d => d.remove());
      if (result) {
        state._selectedModels = selections.filter(Boolean);
        state._timeout = Math.max(5, parseInt(timeoutInput.value) || 30);
        // 持久化选择以供下次使用（保存筛选后的非空条目）
        _persistSelections();
      }
      resolve(result);
    }
    // （cancelBtn 已移除 — 覆盖层 X / 外部点击 / Esc 仍会调用 cleanup）
    startBtn.addEventListener('click', async () => {
      if (!_modelsLoaded) return;
      let selected = selections.filter(Boolean);
      // 自动从可用模型中填充任何空选择
      if (selected.length < selections.length) {
        const avail = state._compareMode === 'search' ? [] : filteredModels();
        selections.forEach((s, i) => {
          if (!s && avail.length > 0) {
            const fb = avail[Math.min(i, avail.length - 1)];
            selections[i] = { model: fb.id, endpoint: fb.url, endpointId: fb.endpointId, name: fb.name };
          }
        });
        selected = selections.filter(Boolean);
      }
      if (selected.length < 1) return;

      // 对于搜索模式，探测合成 LLM 模型而非提供商
      const modelsToProbe = (state._compareMode === 'search')
        ? (state._searchSynthModels || []).filter(Boolean)
        : selected;
      if (modelsToProbe.length < 1) { cleanup(true); return; }

      // ── 如果所有模型都已探测，跳过探测直接启动 ──
      const allAlreadyProbed = modelsToProbe.every(m => state._probed.has(m.model));
      if (allAlreadyProbed) { cleanup(true); return; }

      // ── 在启动前检查选中的模型 ──
      startBtn.disabled = true;
      startBtn.style.opacity = '0.6';

      const isBlind = state._blindMode || _shuffled;

      // 显示探测覆盖层为固定弹窗
      const probeOverlay = document.createElement('div');
      probeOverlay.className = 'compare-probe-overlay';
      const probeCard = document.createElement('div');
      probeCard.className = 'compare-probe-card';
      probeCard.innerHTML = '<div class="compare-probe-title">Checking models...</div>';
      let _probeSkipped = false;
      const probeList = document.createElement('div');
      probeList.className = 'compare-probe-list';
      modelsToProbe.forEach((m, i) => {
        const row = document.createElement('div');
        row.className = 'compare-probe-row';
        row.dataset.model = m.model;
        row.dataset.idx = i;
        // 盲评模式下隐藏名称直到失败 — 仅显示槽位字母
        const name = m.name || m.model.split('/').pop();
        const displayName = isBlind ? `Model ${_slotChar(i)}` : escapeHtml(name);
        row._realName = name;
        row.innerHTML = `<span class="compare-probe-spinner">▁▂▃</span><span class="compare-probe-name">${displayName}</span><span class="compare-probe-status"></span>`;
        const waveEl = row.querySelector('.compare-probe-spinner');
        const waveFrames = WAVE_FRAMES;
        let waveIdx = 0;
        row._waveInterval = setInterval(() => {
          waveIdx = (waveIdx + 1) % waveFrames.length;
          if (waveEl && !waveEl.classList.contains('ok') && !waveEl.classList.contains('fail')) {
            waveEl.textContent = waveFrames[waveIdx];
          }
        }, 100);
        probeList.appendChild(row);
      });
      probeCard.appendChild(probeList);
      const skipBtn = document.createElement('button');
      skipBtn.textContent = t('compare.skip');
      skipBtn.className = 'cmp-btn-secondary';
      skipBtn.style.cssText = 'padding:4px 14px;font-size:11px;opacity:0.5;transition:opacity 0.15s;margin-top:8px;';
      skipBtn.addEventListener('mouseenter', () => { skipBtn.style.opacity = '1'; });
      skipBtn.addEventListener('mouseleave', () => { skipBtn.style.opacity = '0.5'; });
      skipBtn.addEventListener('click', () => {
        _probeSkipped = true;
        _clearProbeWaves();
        probeOverlay.remove();
        cleanup(true);
      });
      probeCard.appendChild(skipBtn);
      probeOverlay.appendChild(probeCard);
      // .compare-probe-overlay 的 CSS z-index 为 300，但 modalManager
      // 在每次聚焦时会将每个打开的工具弹窗提升到该值之上（_modalTopZ
      // 从 300 开始递增）。因此 compare 弹窗通常会在探测覆盖层
      // 之上，将其遮挡。从 compare 弹窗的当前有效 z-index 重新计算，
      // 使探测始终位于其上方一层。
      const _cmpModal = document.getElementById('compare-model-overlay');
      if (_cmpModal) {
        const _cmpZ = parseInt(getComputedStyle(_cmpModal).zIndex, 10) || 0;
        probeOverlay.style.setProperty('z-index', String(_cmpZ + 1), 'important');
      }
      document.body.appendChild(probeOverlay);

      // ESC 关闭探测覆盖层（stopPropagation 防止同时关闭模型选择器）
      const _probeEsc = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          _probeSkipped = true;
          _clearProbeWaves();
          probeOverlay.remove();
          document.removeEventListener('keydown', _probeEsc, false);
          startBtn.disabled = false;
          startBtn.innerHTML = _CMP_START_LABEL;
          startBtn.style.opacity = '1';
        }
      };
      document.addEventListener('keydown', _probeEsc, false);

      // 辅助函数：探测单个模型（跳过图像模型 — 它们使用不同的 API）
      const _imageModelPrefixes = ['dall-e', 'gpt-image', 'chatgpt-image', 'stable-diffusion', 'sdxl', 'flux', 'midjourney'];
      function _isImageModel(modelId) {
        const lower = (modelId || '').toLowerCase();
        return _imageModelPrefixes.some(p => lower.includes(p));
      }
      async function _probeOne(m) {
        if (_isImageModel(m.model)) {
          return { status: 'ok', model: m.model, skipped: true, skipReason: 'Image' };
        }
        // Search 模式 — 正常探测 LLM 模型（不要跳过）
        if (state._compareMode === 'search' && !m.model) {
          return { status: 'ok', model: m.model, skipped: true, skipReason: 'No model' };
        }
        const res = await fetch(`${state.API_BASE}/api/probe-selected`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ models: [{ endpoint_id: m.endpointId || '', model: m.model, endpoint: m.endpoint || '', with_tools: state._compareMode === 'agent' }] }),
        });
        const data = await res.json();
        return (data.results || [])[0] || { status: 'fail', error: 'No response' };
      }

      // 辅助函数：更新探测行的视觉状态
      function _updateRow(idx, result) {
        const row = probeList.querySelector(`[data-idx="${idx}"]`);
        if (!row) return;
        // 停止波浪动画
        if (row._waveInterval) { clearInterval(row._waveInterval); row._waveInterval = null; }
        const spinner = row.querySelector('.compare-probe-spinner');
        const status = row.querySelector('.compare-probe-status');
        if (result.status === 'ok') {
          spinner.textContent = '\u2713';
          spinner.classList.remove('fail');
          spinner.classList.add('ok');
          status.textContent = result.skipped ? (result.skipReason || 'Skipped') : (result.latency_ms ? `${result.latency_ms}ms` : 'OK');
          status.classList.remove('fail');
          status.classList.add('ok');
          row.classList.remove('fail');
          // 标记为已探测
          if (result.model) state._probed.add(result.model);
        } else {
          spinner.textContent = '\u2717';
          spinner.classList.remove('ok');
          spinner.classList.add('fail');
          status.textContent = '';
          status.classList.remove('ok');
          row.classList.add('fail');
          // 失败时显示真实模型名称（即使在盲评模式下）
          if (isBlind && row._realName) {
            const nameEl = row.querySelector('.compare-probe-name');
            if (nameEl) nameEl.textContent = row._realName;
          }
          // 如果重试则移除旧的详情/操作
          const oldDetail = row.nextElementSibling;
          if (oldDetail && oldDetail.classList.contains('compare-probe-detail')) oldDetail.remove();
          // 错误 + 操作放置在行下方
          const detail = document.createElement('div');
          detail.className = 'compare-probe-detail';
          detail.style.cssText = 'grid-column:1/-1;display:flex;align-items:flex-start;gap:6px;padding:4px 10px 6px;font-size:10px;opacity:0.6;background:color-mix(in srgb, var(--color-error, #f44) 5%, transparent);border-radius:4px;margin-top:-2px;';
          const errSpan = document.createElement('span');
          // 截断过长的错误消息
          const errText = (result.error || 'Failed');
          errSpan.textContent = errText.length > 80 ? errText.slice(0, 80) + '...' : errText;
          errSpan.title = errText;
          errSpan.style.cssText = 'flex:1;line-height:1.4;';
          detail.appendChild(errSpan);
          // 跟踪重试超时以进行倍增
          if (!row._probeTimeout) row._probeTimeout = 15000;
          if (result.error === 'Timeout') row._probeTimeout = Math.min(row._probeTimeout * 2, 120000);
          const retryBtn = document.createElement('button');
          retryBtn.className = 'compare-probe-action-btn';
          const retryLabel = result.error === 'Timeout' ? `Retry ${Math.round(row._probeTimeout / 1000)}s` : 'Retry';
          retryBtn.textContent = retryLabel;
          retryBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            detail.remove();
            if (isBlind) {
              const nameEl = row.querySelector('.compare-probe-name');
              if (nameEl) nameEl.textContent = `Model ${_slotChar(idx)}`;
            }
            const waveFrames2 = WAVE_FRAMES;
            let w2 = 0;
            spinner.classList.remove('ok', 'fail');
            spinner.style.color = '';
            row._waveInterval = setInterval(() => { w2 = (w2 + 1) % waveFrames2.length; spinner.textContent = waveFrames2[w2]; }, 100);
            row.classList.remove('fail');
            const r2 = await Promise.race([_probeOne(modelsToProbe[idx]), new Promise(r => setTimeout(() => r({ status: 'fail', error: 'Timeout' }), row._probeTimeout))]);
            _updateRow(idx, r2);
          });
          const swapBtn = document.createElement('button');
          swapBtn.className = 'compare-probe-action-btn';
          swapBtn.textContent = t('compare.swap');
          swapBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _clearProbeWaves();
            probeOverlay.remove();
            _probeSkipped = true;
            startBtn.disabled = false;
            startBtn.innerHTML = _CMP_START_LABEL;
            startBtn.style.opacity = '1';
          });
          detail.appendChild(retryBtn);
          detail.appendChild(swapBtn);
          row.after(detail);
        }
      }

      try {
        // 并行探测所有模型（每个模型 15 秒超时）
        const results = await Promise.all(modelsToProbe.map(m =>
          Promise.race([
            _probeOne(m),
            new Promise(r => setTimeout(() => r({ status: 'fail', error: 'Timeout' }), 15000))
          ])
        ));
        if (_probeSkipped) return;
        let allOk = true;
        let failCount = 0;

        for (let i = 0; i < results.length; i++) {
          _updateRow(i, results[i]);
          if (results[i].status !== 'ok') {
            allOk = false;
            failCount++;
          }
        }

        // 在随机排列/盲评模式下：静默替换失败的模型（search/research 除外）
        if (!allOk && _shuffled && state._compareMode !== 'search' && state._compareMode !== 'research') {
          const excluded = getExcludedModels();
          const usedModels = new Set(selections.filter(Boolean).map(m => m.model));
          const pool = filteredModels().filter(m => !excluded.includes(m.id) && !usedModels.has(m.id));
          let poolIdx = 0;

          for (let i = 0; i < results.length; i++) {
            if (results[i].status !== 'ok') {
              const row = probeList.querySelector(`[data-idx="${i}"]`);
              // 重新启动红色波浪以显示正在替换
              if (row) {
                const spinner = row.querySelector('.compare-probe-spinner');
                const status = row.querySelector('.compare-probe-status');
                if (spinner) {
                  spinner.classList.remove('ok', 'fail');
                  spinner.style.color = 'var(--color-error, #f44)';
                  const waveFrames = WAVE_FRAMES;
                  let wIdx = 0;
                  row._waveInterval = setInterval(() => { wIdx = (wIdx + 1) % waveFrames.length; spinner.textContent = waveFrames[wIdx]; }, 100);
                }
                if (status) status.textContent = t('compare.swapping');
              }

              // 尝试最多 3 个替换，每个 10 秒超时
              let swapped = false;
              for (let attempt = 0; attempt < 3 && poolIdx < pool.length; attempt++) {
                const replacement = pool[poolIdx++];
                const probePromise = _probeOne({ model: replacement.id, endpoint: replacement.url, endpointId: replacement.endpointId });
                const timeoutPromise = new Promise(r => setTimeout(() => r({ status: 'timeout', error: 'Swap timed out' }), 10000));
                const probeResult = await Promise.race([probePromise, timeoutPromise]);
                if (probeResult.status === 'ok') {
                  selections[i] = { model: replacement.id, endpoint: replacement.url, endpointId: replacement.endpointId, name: replacement.name };
                  usedModels.add(replacement.id);
                  if (row && row._waveInterval) { clearInterval(row._waveInterval); row._waveInterval = null; }
                  _updateRow(i, probeResult);
                  swapped = true;
                  break;
                }
              }
              if (!swapped) {
                if (row && row._waveInterval) { clearInterval(row._waveInterval); row._waveInterval = null; }
                if (row) {
                  const spinner = row.querySelector('.compare-probe-spinner');
                  const status = row.querySelector('.compare-probe-status');
                  if (spinner) { spinner.textContent = '\u2717'; spinner.classList.add('fail'); spinner.style.color = ''; }
                  if (status) { status.textContent = t('compare.no_replacement'); }
                }
              }
            }
          }

          // 重新检查现在是否全部正常
          const finalToProbe = (state._compareMode === 'search') ? (state._searchSynthModels || []).filter(Boolean) : selections.filter(Boolean);
          const finalResults = await Promise.all(finalToProbe.map(m => _probeOne(m)));
          allOk = finalResults.every(r => r.status === 'ok');
          failCount = finalResults.filter(r => r.status !== 'ok').length;
        }

        // ── 第二阶段：对于 search/research，也检查搜索提供商 ──
        if (allOk && (state._compareMode === 'search' || state._compareMode === 'research')) {
          const providers = state._compareMode === 'search'
            ? selected.map(s => ({ id: s.model, label: s.name }))
            : (state._searchSynthModels || []).map(p => typeof p === 'string' ? { id: p, label: p } : null).filter(Boolean);

          if (providers.length > 0) {
            const titleEl = probeOverlay.querySelector('.compare-probe-title');
            titleEl.textContent = t('compare.checking_providers');

            // 添加提供商行
            const providerRows = [];
            providers.forEach((p, i) => {
              const row = document.createElement('div');
              row.className = 'compare-probe-row';
              row.dataset.idx = 'p' + i;
              row.innerHTML = `<span class="compare-probe-spinner">▁▂▃</span><span class="compare-probe-name">${escapeHtml(p.label || p.id)}</span><span class="compare-probe-status"></span>`;
              const waveEl = row.querySelector('.compare-probe-spinner');
              const waveFrames = WAVE_FRAMES;
              let wIdx = 0;
              row._waveInterval = setInterval(() => {
                wIdx = (wIdx + 1) % waveFrames.length;
                if (waveEl && !waveEl.classList.contains('ok') && !waveEl.classList.contains('fail')) waveEl.textContent = waveFrames[wIdx];
              }, 100);
              probeList.appendChild(row);
              providerRows.push(row);
            });

            // 用测试查询探测每个提供商
            const provResults = await Promise.all(providers.map(async (p) => {
              try {
                const fd = new FormData();
                fd.append('query', 'test');
                fd.append('provider', p.id);
                fd.append('count', '1');
                const r = await fetch(`${state.API_BASE}/api/search/query`, { method: 'POST', body: fd, credentials: 'same-origin' });
                const d = await r.json();
                return { status: d.error ? 'fail' : 'ok', error: d.error };
              } catch (e) {
                return { status: 'fail', error: e.message };
              }
            }));

            let searchAllOk = true;
            provResults.forEach((result, i) => {
              const row = providerRows[i];
              if (row._waveInterval) { clearInterval(row._waveInterval); row._waveInterval = null; }
              const spinner = row.querySelector('.compare-probe-spinner');
              const status = row.querySelector('.compare-probe-status');
              if (result.status === 'ok') {
                spinner.textContent = '\u2713'; spinner.classList.add('ok');
                status.textContent = t('compare.ok'); status.classList.add('ok');
              } else {
                spinner.textContent = '\u2717'; spinner.classList.add('fail');
                status.textContent = result.error || 'Failed'; status.classList.add('fail');
                row.classList.add('fail');
                searchAllOk = false;
              }
            });

            if (!searchAllOk) {
              allOk = false;
              failCount += provResults.filter(r => r.status !== 'ok').length;
            }
          }
        }

        if (allOk) {
          // 不要在这里隐藏 Skip 按钮 — 折叠其空间会使卡片缩小且
          // 标题 + 行跳动（"快速切换"）。成功后整个覆盖层稍后会淡出，
          // 所以只需保留它即可。
          probeOverlay.querySelector('.compare-probe-title').textContent = t('compare.all_ready');
          setTimeout(() => {
            probeOverlay.style.transition = 'opacity 0.3s ease';
            probeOverlay.style.opacity = '0';
            setTimeout(() => { _clearProbeWaves(); probeOverlay.remove(); cleanup(true); if (window._updateCheckBtnState) window._updateCheckBtnState(); }, 300);
          }, 400);
        } else {
          // 失败 — Skip 按钮被 Go Back / Start Anyway 行替换。
          skipBtn.style.display = 'none';
          // 部分失败 — 显示哪些失败了
          const failedNames = [];
          probeList.querySelectorAll('.compare-probe-row.fail').forEach(row => {
            failedNames.push(row.querySelector('.compare-probe-name').textContent);
          });
          const titleEl = probeOverlay.querySelector('.compare-probe-title');
          titleEl.textContent = failedNames.length <= 2
            ? failedNames.join(' & ') + ' failed'
            : `${failCount} models failed`;
          const btnRow = document.createElement('div');
          btnRow.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:12px;';
          const goBackBtn = document.createElement('button');
          goBackBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="15 18 9 12 15 6"/></svg>Go Back';
          goBackBtn.className = 'cmp-btn-secondary';
          goBackBtn.style.cssText = 'padding:5px 12px;font-size:12px;display:inline-flex;align-items:center;';
          goBackBtn.addEventListener('click', () => { _clearProbeWaves(); probeOverlay.remove(); startBtn.disabled = false; startBtn.innerHTML = _CMP_START_LABEL; startBtn.style.opacity = '1'; });
          const startAnywayBtn = document.createElement('button');
          startAnywayBtn.textContent = t('compare.start_anyway');
          startAnywayBtn.className = 'cmp-btn-primary';
          startAnywayBtn.style.cssText = 'padding:5px 12px;font-size:12px;';
          startAnywayBtn.addEventListener('click', () => { _clearProbeWaves(); probeOverlay.remove(); cleanup(true); });
          btnRow.appendChild(goBackBtn);
          btnRow.appendChild(startAnywayBtn);
          probeCard.appendChild(btnRow);
        }
      } catch (e) {
        // 探测完全失败 — 让用户无论如何启动
        console.error('Compare probe error:', e);
        _clearProbeWaves();
        probeOverlay.remove();
        startBtn.disabled = false;
        startBtn.innerHTML = _CMP_START_LABEL;
        startBtn.style.opacity = '1';
        cleanup(true);
      }
    });

    // ── 后台获取模型 ──
    fetchModels().then(fetched => {
      models = fetched;
      state._cachedModels = fetched;
      _modelsLoaded = true;
      if (models.length < 1) {
        listContainer.innerHTML = '<div style="color:var(--color-error);font-size:0.85em;padding:12px 0;text-align:center;">No models available</div>';
        return;
      }
      // 根据可用模型验证已保存的选择
      if (_needsValidation && selections.length > 0) {
        selections = selections.map(sel => {
          if (!sel) return null;
          // 优先精确匹配（模型 + 端点），回退到仅模型 ID
          const exact = models.find(m => m.id === sel.model && m.url === sel.endpoint);
          if (exact) return { ...sel, endpoint: exact.url, endpointId: exact.endpointId, endpointName: exact.endpointName || sel.endpointName || '' };
          const byId = models.find(m => m.id === sel.model);
          if (byId) return { model: byId.id, endpoint: byId.url, endpointId: byId.endpointId, name: byId.name, endpointName: byId.endpointName || '' };
          return null;
        });
        // 保留 null 以保持槽位位置不变
        if (!selections.some(s => s !== null)) selections = [null, null];
        _needsValidation = false;
      }
      if (!selections.length) selections = [null, null];
      startBtn.disabled = false;
      startBtn.style.opacity = '1';
      addBtn.style.display = 'flex';
      renderModelRows();
    }).catch(e => {
      console.error('Failed to fetch models for compare:', e);
      listContainer.innerHTML = '<div style="color:var(--color-error);font-size:0.85em;padding:12px 0;text-align:center;">Failed to load models</div>';
    });
  });
}

export { showModelSelector, disableToolToggles, restoreToolToggles, _syncToolbarIndicator };
