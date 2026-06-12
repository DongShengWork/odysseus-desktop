// compare/index.js — 编排模块（公共 API）
/**
 * 模型 A/B 对比模块。
 * 构建自己的多窗格网格布局（最多 8 个模型）。
 * 将相同的提示同时发送给所有模型，让用户投票。
 *
 * 使用对原始容器子元素的 show/hide 而非 innerHTML 替换，
 * 以便保留输入栏、对比按钮、模式切换等组件上的事件监听器。
 */

// ── 子模块导入 ──
import state from './state.js';
import { EVAL_PROMPTS, WAVE_FRAMES,
  ICON_DICE, ICON_EXPAND, ICON_COLLAPSE, ICON_CLOSE,
  ICON_REROLL, ICON_COPY, ICON_PLAY, ICON_CODE,
  ICON_PARALLEL, ICON_SEQUENTIAL,
  EYE_OPEN, EYE_CLOSED, SAVE_ICON, CHAT_ICON,
  SEND_SVG, VOTES_STORAGE_KEY,
} from './icons.js';
import { fetchModels, _persistSelections, _modelDisplayNames, getExcludedModels, setExcludedModels } from './models.js';
import { showModelSelector, disableToolToggles, restoreToolToggles, _syncToolbarIndicator } from './selector.js';
import { _checkUnprobed, _clearProbeWaves } from './probe.js';
import { streamToPane, _renderSearchResults, _runSynthForPane, _formatMs, registerStreamActions } from './stream.js';
import {
  stopAll, stopPane, rerollPane, shufflePanePositions, resetCompare,
  _addPane, _removePane, toggleExpandPane, togglePanePreview, copyPaneResponse,
  _showModelSwapDropdown, _createAndAppendPane, _autoPreviewHtml,
  registerPaneActions,
} from './panes.js';
import { handleVote, buildVoteBar, addFinishBadge, spawnConfetti, _saveVote, registerCompareActions } from './vote.js';
import { showScoreboard } from './scoreboard.js';

// ── 外部依赖导入 ──
import Storage from '../storage.js';
import uiModule from '../ui.js';
import sessionModule from '../sessions.js';
import spinnerModule from '../spinner.js';
import themeModule from '../theme.js';
import presetsModule from '../presets.js';
import markdownModule from '../markdown.js';
import { t } from '../i18n.js';

var escapeHtml = uiModule.esc;

/** 槽位标签：并行用字母（A、B），顺序用数字（1、2） */
function _slotChar(i) { return state._parallel ? String.fromCharCode(65 + i) : String(i + 1); }

// ────────────────────────────────────────────────────────────────────────────
// ── 工具栏指示器同步 ──
// ────────────────────────────────────────────────────────────────────────────
// ── 初始化 ──
// ────────────────────────────────────────────────────────────────────────────

function init(apiBase) {
  state.API_BASE = apiBase;
  // 在页面关闭/刷新时清理未保存的对比会话
  window.addEventListener('beforeunload', () => {
    if (!state._saveOnClose && state._paneSessionIds.length > 0) {
      // sendBeacon 使用 POST — 使用批量删除端点
      navigator.sendBeacon(
        `${state.API_BASE}/api/sessions/bulk-delete`,
        new Blob([JSON.stringify({ ids: state._paneSessionIds })], { type: 'application/json' })
      );
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// ── isCompareActive ──
// ────────────────────────────────────────────────────────────────────────────

function isCompareActive() {
  return state.isActive;
}

// ────────────────────────────────────────────────────────────────────────────
// ── closeCompare ──
// ────────────────────────────────────────────────────────────────────────────

/** 关闭对比模式（工具栏指示器的公共 API）。 */
function closeCompare() {
  if (state.isActive) deactivate(true);
}

// ────────────────────────────────────────────────────────────────────────────
// ── toggleMode ──
// ────────────────────────────────────────────────────────────────────────────

/** 切换对比模式 — 显示模型选择器，然后构建 UI。 */
async function toggleMode() {
  if (state.isActive) {
    deactivate(true);
    return false;
  }
  if (state._openingSelector) return false;

  state._openingSelector = true;
  try {
    const confirmed = await showModelSelector();
    if (!confirmed) return false;

    state.isActive = true;
    _syncToolbarIndicator(true);
    await _buildCompareUI();
    return true;
  } catch (err) {
    console.error('Compare toggleMode error:', err);
    return false;
  } finally {
    state._openingSelector = false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ── 停用 ──
// ────────────────────────────────────────────────────────────────────────────

async function deactivate(teardown) {
  // 中止所有正在进行的流
  state._abortControllers.forEach(ac => { if (ac) ac.abort(); });
  state._abortControllers = [];

  // 如果保存则将会话移动到对比文件夹
  if (state._saveOnClose && state._paneSessionIds.length > 0) {
    const modelShorts = _modelDisplayNames(state._selectedModels);
    const folderName = 'Compare: ' + modelShorts.join(' vs ');
    await Promise.all(state._paneSessionIds.map(sid =>
      fetch(`${state.API_BASE}/api/session/${sid}`, {
        method: 'PATCH', body: new URLSearchParams({ folder: folderName })
      }).catch(() => {})
    ));
  }

  // 在重置状态之前捕获要删除的会话 ID
  const sessionIdsToDelete = (!state._saveOnClose && teardown && state._paneSessionIds.length > 0)
    ? [...state._paneSessionIds] : [];

  removeOverlays();
  state.isActive = false;
  state._streaming = false;
  state._paneSessionIds = [];
  state._paneMetrics = [];
  state._finishOrder = 0;
  state._paneElapsed = [];
  state._saveOnClose = false;
  state._continueChat = false;
  state._probed.clear();
  state._expectedAnswer = '';
  _syncToolbarIndicator(false);

  // 恢复主文本区域的 placeholder
  const msgTA = document.getElementById('message');
  if (msgTA) msgTA.placeholder = '';

  // 恢复工具栏指示器的显示状态和指针事件
  Object.entries(state._savedIndicatorDisplay).forEach(([id, display]) => {
    const el = document.getElementById(id);
    if (el) { el.style.display = display; el.style.pointerEvents = ''; }
  });
  state._savedIndicatorDisplay = {};

  // 解锁模式切换
  const _modeToggleR = document.querySelector('.mode-toggle');
  if (_modeToggleR) { _modeToggleR.style.pointerEvents = ''; _modeToggleR.style.opacity = ''; }

  // 恢复工具开关的指针事件
  ['overflow-plus-btn', 'web-toggle-btn', 'bash-toggle-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.pointerEvents = '';
  });

  // 将 agent/chat 模式恢复到对比之前的状态
  const _ts = Storage.loadToggleState();
  _ts.mode = state._savedMode;
  Storage.saveToggleState(_ts);
  const _ab2 = document.getElementById('mode-agent-btn'), _cb2 = document.getElementById('mode-chat-btn');
  if (_ab2 && _cb2) { _ab2.classList.toggle('active', state._savedMode === 'agent'); _cb2.classList.toggle('active', state._savedMode === 'chat'); }
  document.querySelectorAll('[data-mode-tool]').forEach(b => { b.style.display = state._savedMode === 'agent' ? '' : 'none'; });

  // 删除未保存的会话，然后重新加载
  if (teardown) {
    if (sessionIdsToDelete.length > 0) {
      // keepalive 确保即使在页面导航期间也能完成请求
      await Promise.all(sessionIdsToDelete.map(sid =>
        fetch(`${state.API_BASE}/api/session/${sid}`, { method: 'DELETE', keepalive: true }).catch(() => {})
      ));
    }
    location.href = location.pathname;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ── _buildCompareUI ──
// ────────────────────────────────────────────────────────────────────────────

/** 构建对比 UI：会话、标题栏、窗格网格、投票栏、评测下拉菜单。 */
async function _buildCompareUI() {
  if (state._selectedModels.length < 1) {
    if (uiModule) uiModule.showError(t('compare.select_at_least_one'));
    return;
  }

  const n = state._selectedModels.length;
  const modelShorts = _modelDisplayNames(state._selectedModels);
  _persistSelections();

  // 1. 创建会话（搜索模式跳过 — 不需要 LLM 会话）
  if (state._compareMode !== 'search') {
    const sessionIds = [];
    for (let i = 0; i < n; i++) {
      const m = state._selectedModels[i];
      const fd = new FormData();
      // 盲评模式：以中立槽位命名会话，使侧边栏 /
      // GET /api/sessions 无法去匿名化对比（问题 #1285）。
      fd.append('name', '[CMP] ' + (state._blindMode ? 'Model ' + _slotChar(i) : modelShorts[i]));
      fd.append('endpoint_url', m.endpoint || '');
      fd.append('model', m.model || '');
      if (m.endpointId) {
        fd.append('endpoint_id', m.endpointId);
        fd.append('skip_validation', 'true');
      }
      const res = await fetch(`${state.API_BASE}/api/session`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error('Failed to create session for ' + modelShorts[i]);
      const data = await res.json();
      sessionIds.push(data.id);
    }
    state._paneSessionIds = sessionIds;
  } else {
    state._paneSessionIds = [];
  }
  state._paneMetrics = state._selectedModels.map(() => null);
  state._abortControllers = state._selectedModels.map(() => null);

  // 2. 如果有很多窗格则自动折叠侧边栏
  if (n > 3) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('hidden')) {
      sidebar.classList.add('hidden');
      state._sidebarWasHidden = true;
      const iconRail = document.getElementById('icon-rail');
      if (iconRail) iconRail.classList.remove('rail-hidden');
      if (typeof window.syncRailSide === 'function') window.syncRailSide();
    }
  }

  // 3. 对比期间隐藏移动端的新聊天按钮
  const _mobileNewBtn = document.getElementById('mobile-new-chat-btn');
  if (_mobileNewBtn) {
    _mobileNewBtn.dataset.cmpWasDisplay = _mobileNewBtn.style.display;
    _mobileNewBtn.style.display = 'none';
  }

  // 4. 在隐藏之前保存工具栏指示器的显示状态
  const indicatorIds = ['overflow-tts-btn', 'overflow-attach-btn', 'overflow-rag-btn', 'overflow-research-btn', 'overflow-doc-btn', 'rag-indicator-btn', 'research-toggle-btn'];
  state._savedIndicatorDisplay = {};
  indicatorIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) state._savedIndicatorDisplay[id] = el.style.display;
  });

  // 5. 保存当前模式并锁定到正确的对比类型模式
  const _toggleState = Storage.loadToggleState();
  state._savedMode = _toggleState.mode || 'chat';
  const _targetMode = (state._compareMode === 'agent') ? 'agent' : 'chat';
  _toggleState.mode = _targetMode;
  Storage.saveToggleState(_toggleState);
  const _ab = document.getElementById('mode-agent-btn'), _cb = document.getElementById('mode-chat-btn');
  if (_ab && _cb) {
    _ab.classList.toggle('active', _targetMode === 'agent');
    _cb.classList.toggle('active', _targetMode === 'chat');
  }
  const _modeToggle = document.querySelector('.mode-toggle');
  if (_modeToggle) { _modeToggle.style.pointerEvents = 'none'; _modeToggle.style.opacity = '0.4'; }

  // 6. 根据对比模式强制设置工具开关
  disableToolToggles();
  if (state._compareMode === 'search') {
    const webChk = document.getElementById('web-toggle');
    if (webChk && !webChk.checked) { webChk.checked = true; webChk.dispatchEvent(new Event('change')); }
    const webBtn = document.getElementById('web-toggle-btn');
    if (webBtn) webBtn.classList.add('active');
  } else if (state._compareMode === 'research') {
    const resChk = document.getElementById('research-toggle');
    if (resChk && !resChk.checked) { resChk.checked = true; resChk.dispatchEvent(new Event('change')); }
    const resBtn = document.getElementById('research-toggle-btn');
    if (resBtn) { resBtn.style.display = ''; resBtn.classList.add('active'); }
  }

  // 7. 隐藏现有的聊天容器子元素（保留事件监听器）
  const container = document.getElementById('chat-container');
  state._compareElements = [];
  Array.from(container.children).forEach(child => {
    if (child.style.display === 'none') return;
    child.dataset.cmpHidden = '1';
    child.style.display = 'none';
  });
  container.classList.add('compare-active');

  // 8. 标题栏
  const cols = Math.min(n, 4);
  const headerBar = document.createElement('div');
  headerBar.className = 'compare-header-bar';
  headerBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 10px;flex-shrink:0;';
  const headerLabel = document.createElement('span');
  headerLabel.style.cssText = 'font-size:10px;font-weight:400;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;';
  const _modeLabel = ({ search: ' search providers', agent: ' agents', research: ' research models' }[state._compareMode] || ' models');
  headerLabel.textContent = t('compare.comparing') + _modeLabel + (state._blindMode ? ' (blind)' : '') + ' · ' + state._timeout + 's timeout';
  // 左侧：Compare 工具图标（两个并排窗格，匹配导轨/侧边栏图标）+ 标签。
  // 其他工具标题带有其图标；这个之前缺少图标。
  const headerLeft = document.createElement('div');
  headerLeft.style.cssText = 'display:flex;align-items:center;min-width:0;';
  const headerIcon = document.createElement('span');
  headerIcon.style.cssText = 'display:inline-flex;flex-shrink:0;margin-right:6px;opacity:0.85;';
  headerIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="8" height="18" rx="1"/><rect x="14" y="3" width="8" height="18" rx="1"/></svg>';
  headerLeft.appendChild(headerIcon);
  headerLeft.appendChild(headerLabel);
  headerBar.appendChild(headerLeft);

  const headerActions = document.createElement('div');
  headerActions.style.cssText = 'display:flex;align-items:center;gap:2px;';

  const _btnCSS = 'background:none;border:1px solid var(--border);color:var(--fg);cursor:pointer;padding:3px 10px;font-size:11px;font-weight:600;opacity:0.7;transition:all 0.15s;line-height:1;border-radius:4px;display:inline-flex;align-items:center;font-family:inherit;';

  const checkBtn = document.createElement('button');
  checkBtn.id = 'compare-check-btn';
  checkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg><span style="font-size:11px;margin-left:3px;">' + t('compare.probe') + '</span>';
  checkBtn.title = t('compare.probe_title');
  checkBtn.style.cssText = _btnCSS;
  checkBtn.addEventListener('click', () => _checkUnprobed());
  headerActions.appendChild(checkBtn);

  // Check 按钮是动态的：仅当至少有一个选中的模型尚未探测时才可见。
  // 在添加/更改后显示，成功后隐藏。
  window._updateCheckBtnState = function() {
    const btn = document.getElementById('compare-check-btn');
    if (!btn) return;
    const hasUnprobed = state._selectedModels.some(m => !state._probed.has(m.model));
    btn.style.display = hasUnprobed ? '' : 'none';
  };

  // （Scoreboard 按钮移到了投票栏中，紧挨 Tie — 见 vote.js。）

  const exportWrap = document.createElement('div');
  exportWrap.style.cssText = 'position:relative;display:inline-flex;';
  const exportBtn = document.createElement('button');
  exportBtn.id = 'compare-export-btn';
  exportBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span style="font-size:11px;margin-left:3px;">' + t('compare.export') + '</span>';
  exportBtn.title = t('compare.export_title');
  exportBtn.style.cssText = _btnCSS;
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleExportMenu(exportBtn);
  });
  exportWrap.appendChild(exportBtn);
  headerActions.appendChild(exportWrap);

  const shuffleBtn = document.createElement('button');
  shuffleBtn.id = 'compare-shuffle-btn';
  shuffleBtn.innerHTML = ICON_DICE + '<span style="font-size:11px;margin-left:3px;">Shuffle</span>';
  shuffleBtn.title = t('compare.shuffle_panes');
  shuffleBtn.style.cssText = _btnCSS;
  shuffleBtn.addEventListener('click', () => shufflePanePositions());
  headerActions.appendChild(shuffleBtn);

  const addBtn = document.createElement('button');
  addBtn.id = 'compare-add-btn';
  addBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span style="font-size:11px;margin-left:3px;">Add</span>';
  addBtn.title = t('compare.add_model_pane');
  addBtn.style.cssText = _btnCSS;
  addBtn.addEventListener('click', () => _addPane(addBtn));
  headerActions.appendChild(addBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'compare-close-btn';
  closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  closeBtn.title = t('compare.close_compare');
  // 匹配 Export/Score/Shuffle/Model 样式，使 X 与工具栏其余部分齐平，
  // 而不是一个 24×24 带边框的方块。
  closeBtn.style.cssText = _btnCSS;
  closeBtn.addEventListener('click', () => deactivate(true));
  headerActions.appendChild(closeBtn);

  // 将 Export 移到操作集群的最左边（按用户偏好）。
  headerActions.insertBefore(exportWrap, headerActions.firstChild);

  headerBar.appendChild(headerActions);
  container.appendChild(headerBar);
  state._compareElements.push(headerBar);

  // 初始可见性 — 如果当前所有模型都已探测则隐藏
  window._updateCheckBtnState();

  // 9. 窗格网格
  const grid = document.createElement('div');
  grid.className = 'compare-grid';
  grid.dataset.cols = String(cols);
  for (let i = 0; i < n; i++) {
    const label = state._blindMode ? 'Model ' + _slotChar(i) : modelShorts[i];
    const pane = document.createElement('div');
    pane.className = 'compare-pane';
    pane.dataset.pane = String(i);
    pane.innerHTML =
      '<div class="pane-header">' +
        '<button class="pane-title pane-title-btn" id="cmp-title-' + i + '" data-pane="' + i + '" type="button">' + escapeHtml(label) + ' <span class="pane-title-caret">&#x25BE;</span></button>' +
        '<span class="pane-timer" id="cmp-timer-' + i + '"></span>' +
        '<span class="pane-finish-badge" id="cmp-badge-' + i + '"></span>' +
        '<div class="pane-actions">' +
          '<button class="pane-action-btn pane-stop-btn" data-action="stop" data-pane="' + i + '" title="Stop" style="display:none;"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>' +
          '<button class="pane-action-btn pane-preview-btn" data-action="preview" data-pane="' + i + '" id="cmp-preview-' + i + '" title="Run preview" style="display:none;">' + ICON_PLAY + '</button>' +
          '<button class="pane-action-btn" data-action="reroll" data-pane="' + i + '" title="Re-roll">' + ICON_REROLL + '</button>' +
          '<button class="pane-action-btn" data-action="copy" data-pane="' + i + '" title="Copy">' + ICON_COPY + '</button>' +
          '<button class="pane-action-btn" data-action="expand" data-pane="' + i + '" title="Expand">' + ICON_EXPAND + '</button>' +
          '<button class="pane-action-btn pane-close-btn" data-action="close" data-pane="' + i + '" title="Remove pane">' + ICON_CLOSE + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="chat-history" id="cmp-history-' + i + '"></div>' +
      '<iframe class="compare-pane-iframe" id="cmp-iframe-' + i + '" sandbox="allow-scripts" style="display:none;"></iframe>' +
      '<div class="pane-vote-footer">' +
        '<button class="pane-vote-btn" data-pane="' + i + '" type="button" disabled style="opacity:0.4;">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;vertical-align:-2px;"><polyline points="20 6 9 17 4 12"/></svg>' +
          '<span class="pane-vote-label">Vote ' + escapeHtml(label) + '</span>' +
        '</button>' +
      '</div>';
    grid.appendChild(pane);
  }
  grid.addEventListener('click', (e) => {
    const voteBtn = e.target.closest('.pane-vote-btn');
    if (voteBtn) {
      e.stopPropagation();
      if (voteBtn.disabled) return;
      const idx = parseInt(voteBtn.dataset.pane);
      handleVote(idx);
      return;
    }
    const actionBtn = e.target.closest('.pane-action-btn');
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      const idx = parseInt(actionBtn.dataset.pane);
      if (action === 'stop') stopPane(idx);
      else if (action === 'copy') copyPaneResponse(idx);
      else if (action === 'reroll') rerollPane(idx);
      else if (action === 'expand') toggleExpandPane(idx, actionBtn);
      else if (action === 'preview') togglePanePreview(idx);
      else if (action === 'close') _removePane(idx);
      return;
    }
    const titleBtn = e.target.closest('.pane-title-btn');
    if (titleBtn) {
      e.stopPropagation();
      const idx = parseInt(titleBtn.dataset.pane);
      _showModelSwapDropdown(idx, titleBtn);
    }
  });
  container.appendChild(grid);
  state._compareElements.push(grid);

  // 10. 投票栏占位符
  const voteBar = document.createElement('div');
  voteBar.id = 'compare-vote-bar';
  voteBar.className = 'compare-vote-bar';
  container.appendChild(voteBar);
  state._compareElements.push(voteBar);
  buildVoteBar(n);

  if (state._blindMode && n > 1) shufflePanePositions();

  // 11. 将聊天输入栏移到容器底部
  const inputBar = document.querySelector('.chat-input-bar');
  if (inputBar) {
    inputBar.style.display = '';
    if (inputBar.dataset.cmpHidden) delete inputBar.dataset.cmpHidden;
    container.appendChild(inputBar);
  }
  const msgTA = document.getElementById('message');
  if (msgTA) {
    msgTA.placeholder = t('compare.prompt_placeholder');
    requestAnimationFrame(() => msgTA.focus());
  }

  // 评测提示选择器 — 位于消息框右上角（模型选择器通常所在的位置）。
  // 模型选择器在对比期间不相关，因此隐藏它并在停用时通过 wrap 的
  // _cleanup 恢复显示。
  _setupEvalPicker();

  // 12. 隐藏对比期间不适用的工具按钮
  ['overflow-tts-btn', 'overflow-attach-btn', 'overflow-rag-btn', 'overflow-research-btn', 'overflow-doc-btn', 'rag-indicator-btn', 'web-toggle-btn', 'bash-toggle-btn', 'overflow-plus-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.display = 'none'; el.style.pointerEvents = 'none'; }
  });
  if (state._compareMode !== 'research') {
    const resBtn = document.getElementById('research-toggle-btn');
    if (resBtn) { resBtn.style.display = 'none'; resBtn.style.pointerEvents = 'none'; }
  }
  document.querySelectorAll('[data-mode-tool]').forEach(b => { b.style.display = 'none'; });

  _setSendBtn('send');
}

// ────────────────────────────────────────────────────────────────────────────
// ── _setSendBtn ──
// ────────────────────────────────────────────────────────────────────────────

function _setSendBtn(mode) {
  const btn = document.querySelector('.send-btn');
  if (!btn) return;
  if (mode === 'stop') {
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    btn.title = t('compare.stop_all');
    btn.dataset.mode = 'streaming';
    btn.classList.remove('mic-mode', 'newchat-mode');
  } else {
    btn.dataset.mode = '';
    btn.innerHTML = SEND_SVG;
    btn.style.color = '';
    btn.title = t('compare.send_all');
    btn.classList.remove('mic-mode', 'newchat-mode', 'newchat-expanded');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ── handleCompareSubmit ──
// ────────────────────────────────────────────────────────────────────────────

/**
 * 在对比激活时处理来自主聊天输入的提交。
 * 由 app.js 提交守卫调用。
 */
function handleCompareSubmit(e) {
  // 如果正在流式传输，则作为停止按钮
  if (state._streaming) {
    stopAll();
    return;
  }
  const input = document.getElementById('message');
  const message = input ? input.value.trim() : '';
  if (!message) return;
  input.value = '';
  // 重置文本区域高度
  input.style.height = '';
  // 通知输入监听器（评测选择器可见性、自动调整大小等）文本区域
  // 已重新为空 — 程序化清除不会原生触发 `input`。
  input.dispatchEvent(new Event('input', { bubbles: true }));
  // 移动端：发送提示后关闭屏幕键盘，以便用户看到流式输出
  // 而不是输入区域。简单的 blur() 在 Firefox 移动端上经常被忽略，
  // 因此在 blur 前后切换 readonly（同时 blur 活动元素）来可靠地
  // 收起键盘。
  // 移动端键盘关闭 — 使用与主聊天发送（chat.js handleChatSubmit）
  // 相同的已验证逻辑。Compare 在该流程中提前返回，因此从未执行过
  // 此代码；在这里复制相同的逻辑才能真正在 Firefox 移动端上工作
  // （readonly + blur，然后仅在 blur 确认后或用户再次点击输入时才
  // 取消 readonly — 避免键盘弹回来）。
  if (window.innerWidth <= 768) {
    try {
      input.setAttribute('readonly', 'readonly');
      input.blur();
      // 对已经聚焦的 textarea 设置 readonly 不会在 Firefox 上关闭
      // 键盘，blur() 也经常被忽略 — 所以仅 readonly 的方法只在输入
      // 恰好在发送时未聚焦时有效（在第一次/第二次提示之间不一致）。
      // 通过聚焦一个丢弃的 readonly 输入来可靠地将焦点从 textarea
      // 上移开，然后丢弃它。
      const tmp = document.createElement('input');
      tmp.setAttribute('readonly', 'readonly');
      tmp.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;';
      document.body.appendChild(tmp);
      tmp.focus();
      setTimeout(() => { try { tmp.blur(); tmp.remove(); } catch {} }, 50);
      const _dropReadonly = () => { try { input.removeAttribute('readonly'); } catch {} };
      setTimeout(() => {
        if (document.activeElement === input) {
          input.addEventListener('pointerdown', _dropReadonly, { once: true });
          input.addEventListener('focus', _dropReadonly, { once: true });
        } else {
          _dropReadonly();
        }
      }, 120);
    } catch {}
  }
  _executeCompare(message);
}

// ────────────────────────────────────────────────────────────────────────────
// ── _executeCompare ──
// ────────────────────────────────────────────────────────────────────────────

/**
 * 向所有窗格发送提示，流式传输响应。
 * 适用于第一条和后续消息。
 */
async function _executeCompare(message) {
  if (state._streaming) return;
  if (state._selectedModels.length < 1) return;

  // 新一轮 — 允许再次投票并清除上一轮的胜负/平局样式
  // （窗格高亮 + Winner!/= 标题装饰），否则旧结果会
  // 在下一次提示时一直显示在窗格上。
  state._voted = false;
  for (let i = 0; i < state._selectedModels.length; i++) {
    const pane = document.querySelector('.compare-pane[data-pane="' + i + '"]');
    if (pane) {
      pane.classList.remove('winner', 'loser');
      // 清除上一轮的 Failed/Timeout 徽章和评测 ✓/✗ 评分。
      pane.querySelector('.pane-grade-badge')?.remove();
    }
    const fb = document.getElementById('cmp-badge-' + i);
    if (fb) { fb.textContent = ''; fb.style.color = ''; }
    const titleEl = document.getElementById('cmp-title-' + i);
    if (titleEl) {
      const label = state._blindMode
        ? 'Model ' + _slotChar(i)
        : ((state._selectedModels[i] && state._selectedModels[i].name) || 'Model ' + _slotChar(i));
      titleEl.innerHTML = escapeHtml(label) + ' <span class="pane-title-caret">&#x25BE;</span>';
    }
  }

  state._streaming = true;
  state._lastPrompt = message;
  _setSendBtn('stop');
  // 流式传输期间禁用标题栏按钮
  document.querySelectorAll('#compare-shuffle-btn, #compare-check-btn, #compare-add-btn').forEach(b => {
    b.disabled = true; b.style.opacity = '0.25'; b.style.pointerEvents = 'none';
  });

  // ── 搜索模式：直接 API 调用，无 SSE 流式传输 ──
  if (state._compareMode === 'search') {
    try {
      const n = state._selectedModels.length;

      // 在后续提问时清除之前的投票按钮
      const voteBar = document.getElementById('compare-vote-bar');
      if (voteBar) voteBar.innerHTML = '';

      // 为每个窗格添加用户查询 + Spinner
      for (let i = 0; i < n; i++) {
        const hist = document.getElementById('cmp-history-' + i);
        if (!hist) continue;
        const userMsg = document.createElement('div');
        userMsg.className = 'msg msg-user';
        userMsg.innerHTML = '<div class="role">You</div><div class="body"></div>';
        userMsg.querySelector('.body').textContent = message;
        hist.appendChild(userMsg);

        const aiMsg = document.createElement('div');
        aiMsg.className = 'msg msg-ai';
        aiMsg.innerHTML = '<div class="role">Search</div><div class="body"></div>';
        const aiBody = aiMsg.querySelector('.body');
        if (spinnerModule) {
          const spinner = spinnerModule.create('Searching...', 'right');
          aiBody.appendChild(spinner.createElement());
          spinner.start();
        }
        hist.appendChild(aiMsg);
        hist.scrollTop = hist.scrollHeight;
      }

      // 发起搜索 — 根据 _parallel 设置决定并行还是顺序执行
      const t0 = performance.now();
      state._abortControllers = state._selectedModels.map(() => new AbortController());

      async function _searchOne(m, i) {
        const fd = new FormData();
        fd.append('query', message);
        fd.append('provider', m.model);
        fd.append('count', '10');
        try {
          const res = await fetch(`${state.API_BASE}/api/search/query`, { method: 'POST', body: fd, signal: state._abortControllers[i].signal });
          const data = await res.json();
          return { idx: i, data };
        } catch (err) {
          return { idx: i, data: { results: [], error: err.name === 'AbortError' ? 'Stopped' : err.message } };
        }
      }

      let results;
      const _seqSynthDone = new Set();
      if (state._parallel) {
        results = await Promise.all(state._selectedModels.map((m, i) => _searchOne(m, i)));
      } else {
        // 顺序 — 逐个运行，等待中的窗格变暗
        results = [];
        const panes = document.querySelectorAll('.compare-pane');
        panes.forEach((p, i) => { if (i > 0) p.style.opacity = '0.4'; });
        for (let i = 0; i < state._selectedModels.length; i++) {
          const pane = panes[i];
          if (pane) pane.style.opacity = '1';
          results.push(await _searchOne(state._selectedModels[i], i));
          // 立即渲染此结果
          const { idx, data } = results[results.length - 1];
          const hist = document.getElementById('cmp-history-' + idx);
          if (hist) {
            const aiMsg = hist.querySelector('.msg-ai:last-child');
            if (aiMsg) {
              const aiBody = aiMsg.querySelector('.body');
              aiBody.innerHTML = '';
              if (data.error) {
                aiBody.innerHTML = '<div style="color:var(--color-error);font-size:0.85em;">Error: ' + escapeHtml(data.error) + '</div>';
              } else if (!data.results || data.results.length === 0) {
                aiBody.innerHTML = '<div style="color:color-mix(in srgb, var(--fg) 50%, transparent);font-size:0.85em;font-style:italic;">No results found</div>';
              } else {
                aiBody.appendChild(_renderSearchResults(data));
              }
              const footer = document.createElement('div'); footer.className = 'msg-footer';
              const span = document.createElement('span'); span.className = 'response-metrics';
              const parts = [];
              if (data.results) parts.push(data.results.length + ' results');
              if (data.time) parts.push(data.time + 's');
              span.textContent = parts.join(' | '); footer.appendChild(span); aiMsg.appendChild(footer);
              hist.scrollTop = hist.scrollHeight;
              const _pe = document.querySelector(`.compare-pane[data-pane="${idx}"]`);
              if (_pe) _pe.querySelectorAll('.pane-needs-response').forEach(b => b.style.display = '');
            }
          }
          // 顺序模式：立即为此窗格运行合成，然后再移到下一个
          _seqSynthDone.add(idx);
          if (!data.error && data.results && data.results.length > 0) {
            const modelToUse = state._searchSynthModels?.[idx] || null;
            if (modelToUse) {
              const seqHist = document.getElementById('cmp-history-' + idx);
              if (seqHist) {
                const synthMsg = document.createElement('div');
                synthMsg.className = 'msg msg-ai';
                synthMsg.innerHTML = '<div class="role">Analysis</div><div class="body"></div>';
                const synthBody = synthMsg.querySelector('.body');
                let spinner = null;
                if (spinnerModule) { spinner = spinnerModule.create('Analyzing...', 'right'); synthBody.appendChild(spinner.createElement()); spinner.start(); }
                seqHist.appendChild(synthMsg);
                seqHist.scrollTop = seqHist.scrollHeight;
                const resultsText = data.results.map((r, ri) => `[${ri + 1}] ${r.title}\n${r.snippet || ''}\nURL: ${r.url}`).join('\n\n');
                const synthPrompt = `Analyze these search results for the query "${message}". Summarize the key findings, note any consensus or conflicting information, and provide a brief synthesis.\n\nSearch Results:\n${resultsText}`;
                await _runSynthForPane(modelToUse, synthPrompt, synthBody, spinner, seqHist);
              }
            }
          }
        }
        // 重置不透明度
        panes.forEach(p => { p.style.opacity = ''; });
      }
      // 将结果渲染到每个窗格中
      for (const { idx, data } of results) {
        const hist = document.getElementById('cmp-history-' + idx);
        if (!hist) continue;
        const aiMsg = hist.querySelector('.msg-ai:last-child');
        if (!aiMsg) continue;
        const aiBody = aiMsg.querySelector('.body');
        aiBody.innerHTML = '';

        if (data.error) {
          aiBody.innerHTML = '<div style="color:var(--color-error);font-size:0.85em;">Error: ' + escapeHtml(data.error) + '</div>';
        } else if (!data.results || data.results.length === 0) {
          aiBody.innerHTML = '<div style="color:color-mix(in srgb, var(--fg) 50%, transparent);font-size:0.85em;font-style:italic;">No results found</div>';
        } else {
          aiBody.appendChild(_renderSearchResults(data));
        }

        // 页脚指标
        const footer = document.createElement('div');
        footer.className = 'msg-footer';
        const span = document.createElement('span');
        span.className = 'response-metrics';
        const parts = [];
        if (data.results) parts.push(data.results.length + ' results');
        if (data.time) parts.push(data.time + 's');
        span.textContent = parts.join(' | ');
        footer.appendChild(span);
        aiMsg.appendChild(footer);

        hist.scrollTop = hist.scrollHeight;
        // 为搜索结果显示重新运行/复制按钮
        const _paneEl = document.querySelector(`.compare-pane[data-pane="${idx}"]`);
        if (_paneEl) _paneEl.querySelectorAll('.pane-needs-response').forEach(b => b.style.display = '');
      }

      // ── 合成：将搜索结果发送给 LLM 进行分析（遵循 _parallel 设置） ──
      if (state._searchSynthModels) {
        // 构建合成任务列表
        const synthTasks = [];
        for (let i = 0; i < results.length; i++) {
          const { idx, data } = results[i];
          // 跳过已在顺序模式中合成的窗格
          if (_seqSynthDone.has(idx)) continue;
          if (data.error || !data.results || data.results.length === 0) continue;

          const modelToUse = state._searchSynthModels?.[idx] || null;
          if (!modelToUse) continue;

          const hist = document.getElementById('cmp-history-' + idx);
          if (!hist) continue;

          // 添加带 Spinner 的合成消息
          const synthMsg = document.createElement('div');
          synthMsg.className = 'msg msg-ai';
          synthMsg.innerHTML = '<div class="role">Analysis</div><div class="body"></div>';
          const synthBody = synthMsg.querySelector('.body');
          let spinner = null;
          if (spinnerModule) {
            spinner = spinnerModule.create('Analyzing...', 'right');
            synthBody.appendChild(spinner.createElement());
            spinner.start();
          }
          hist.appendChild(synthMsg);
          // 自动滚动以显示 Analysis 消息
          hist.scrollTop = hist.scrollHeight;

          // 构建合成提示
          const resultsText = data.results.map((r, ri) =>
            `[${ri + 1}] ${r.title}\n${r.snippet || ''}\nURL: ${r.url}`
          ).join('\n\n');

          const synthPrompt = `Analyze these search results for the query "${message}". Summarize the key findings, note any consensus or conflicting information, and provide a brief synthesis.\n\nSearch Results:\n${resultsText}`;

          synthTasks.push({ idx, modelToUse, synthBody, synthMsg, spinner, hist, synthPrompt });
        }

        // 运行合成流（根据 _parallel 标志决定并行还是顺序执行）
        const runSynthesis = async (task) => _runSynthForPane(task.modelToUse, task.synthPrompt, task.synthBody, task.spinner, task.hist);

        if (state._parallel) {
          await Promise.all(synthTasks.map(runSynthesis));
        } else {
          for (const task of synthTasks) {
            await runSynthesis(task);
          }
        }
      }

      buildVoteBar(n);
    } catch (err) {
      console.error('Search compare error:', err);
      if (uiModule) uiModule.showError(t('compare.search_failed', { error: err.message }));
    } finally {
      state._streaming = false;
      _setSendBtn('send');
    }
    return;
  }

  // ── Chat / Image 模式 ──
  const isFollowUp = document.getElementById('cmp-history-0')?.querySelector('.msg-ai');

  try {
    const n = state._selectedModels.length;

    if (isFollowUp) {
      const voteBar = document.getElementById('compare-vote-bar');
      if (voteBar) {
        voteBar.innerHTML = '';
        voteBar.classList.add('hidden');
      }
    }

    // ── 为每个窗格添加用户 + AI 气泡 ──
    const aiElements = [];
    for (let i = 0; i < n; i++) {
      const hist = document.getElementById('cmp-history-' + i);
      if (!hist) { aiElements.push(null); continue; }

      const userMsg = document.createElement('div');
      userMsg.className = 'msg msg-user';
      userMsg.innerHTML = '<div class="role">You</div><div class="body"></div>';
      userMsg.querySelector('.body').textContent = message;
      hist.appendChild(userMsg);

      const aiMsg = document.createElement('div');
      aiMsg.className = 'msg msg-ai';
      aiMsg.innerHTML = '<div class="role">AI</div><div class="body"></div>';
      const aiBody = aiMsg.querySelector('.body');
      if (spinnerModule) {
        // 在顺序模式中，只有第一个窗格显示"Processing"，其余显示"Waiting"
        const label = (!state._parallel && i > 0)
          ? 'Waiting for Model ' + _slotChar(i - 1) + '...'
          : 'Processing...';
        const spinner = spinnerModule.create(label, 'right');
        aiBody.appendChild(spinner.createElement());
        spinner.start();
        aiMsg._spinner = spinner;
      }
      hist.appendChild(aiMsg);
      hist.scrollTop = hist.scrollHeight;
      aiElements.push(aiMsg);
    }

    // ── 自动延长超时 ──
    const researchChk = document.getElementById('research-toggle');
    const webChkT = document.getElementById('web-toggle');
    const noTimeLimit = state._compareMode === 'research' || (researchChk && researchChk.checked);
    const needsLongTimeout = state._compareMode === 'agent' || (webChkT && webChkT.checked);
    const runTimeout = noTimeLimit ? 999999 : needsLongTimeout ? Math.max(state._timeout, 300) : state._timeout;

    // ── 如果 web 开关打开则预搜索（所有窗格共享相同结果） ──
    let sharedSearchContext = null;
    let sharedSearchSources = null;
    const webChk = document.getElementById('web-toggle');
    const toggleState = Storage.loadToggleState();
    const isAgentMode = (toggleState.mode || 'chat') === 'agent';
    const webOn = webChk && webChk.checked;
    // 在 agent 模式中，web_search 是一个工具（每个窗格单独处理）；在 chat 模式中，预搜索并共享
    if (webOn && !isAgentMode) {
      try {
        const fd = new FormData();
        fd.append('query', message);
        const searchRes = await fetch(`${state.API_BASE}/api/search`, { method: 'POST', body: fd });
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          if (searchData.context) sharedSearchContext = searchData.context;
          if (searchData.sources) sharedSearchSources = searchData.sources;
        }
      } catch (err) {
        console.warn('Compare pre-search failed, panes will search individually:', err);
      }
    }

    // ── 立即显示投票栏，以便用户随时投票 ──
    buildVoteBar(n);

    // ── 流式传输所有窗格（根据 _parallel 标志决定并行还是顺序） ──
    state._finishOrder = 0;
    state._paneElapsed = new Array(n).fill(null);
    state._paneMetrics = new Array(n).fill(null);
    state._abortControllers = new Array(n).fill(null);

    if (state._parallel) {
      // 同时运行所有窗格
      await Promise.all(state._paneSessionIds.map((sid, i) =>
        streamToPane(i, sid, message, aiElements[i], { searchContext: sharedSearchContext, timeout: runTimeout })
      ));
    } else {
      // 逐个运行窗格（顺序） — 活跃窗格全不透明度，其他变暗
      const allPanes = document.querySelectorAll('.compare-pane');
      allPanes.forEach(p => { p.style.transition = 'opacity 0.4s ease'; });
      // 变暗除第一个外的所有窗格
      allPanes.forEach((p, idx) => { p.style.opacity = idx === 0 ? '1' : '0.35'; });

      for (let i = 0; i < state._paneSessionIds.length; i++) {
        // 更新 Spinner
        if (aiElements[i] && aiElements[i]._spinner) {
          aiElements[i]._spinner.updateLabel('Processing...');
        }

        await streamToPane(i, state._paneSessionIds[i], message, aiElements[i], { searchContext: sharedSearchContext, timeout: runTimeout });

        // 切换不透明度：变暗当前，变亮下一个
        if (allPanes[i]) allPanes[i].style.opacity = '0.35';
        if (i + 1 < allPanes.length && allPanes[i + 1]) {
          allPanes[i + 1].style.opacity = '1';
        }
      }

      // 完成后恢复所有窗格的不透明度
      allPanes.forEach(p => { p.style.opacity = ''; p.style.transition = ''; });
    }

    // 重新聚焦主输入框以进行后续提问
    if (state._continueChat) {
      const ta = document.getElementById('message');
      if (ta) ta.focus();
    }

  } catch (err) {
    console.error('Compare error:', err);
    if (uiModule) uiModule.showError(t('compare.compare_failed', { error: err.message }));
  } finally {
    state._streaming = false;
    _setSendBtn('send');
    // 重新启用标题栏按钮
    document.querySelectorAll('#compare-shuffle-btn, #compare-check-btn, #compare-add-btn').forEach(b => {
      b.disabled = false; b.style.opacity = '0.7'; b.style.pointerEvents = '';
    });
  }
}

// showModelSelector 从 ./selector.js 导入

// ────────────────────────────────────────────────────────────────────────────
// ── cleanupResults / removeOverlays ──
// ────────────────────────────────────────────────────────────────────────────

/**
 * 构建当前窗格的 Markdown 对比（提示 + 每个模型的响应 + 指标 + 评分）
 * 并复制到剪贴板。让用户可以一键保存或分享并排对比。
 */
// 构建对比 Markdown 字符串。由所有导出路径共享。
function _buildComparisonMarkdown() {
  const grid = document.querySelector('.compare-grid');
  if (!grid) return null;
  const panes = grid.querySelectorAll('.compare-pane');
  if (!panes.length) return null;
  const prompt = state._lastPrompt || '(no prompt yet — run a comparison first)';
  const expected = state._expectedAnswer || '';
  const date = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let md = '# Compare\n\n';
  md += '**When:** ' + date + '\n';
  md += '**Type:** ' + (state._compareMode || 'chat') + (state._blindMode ? ' (blind)' : '') + '\n';
  md += '**Prompt:**\n\n```\n' + prompt + '\n```\n\n';
  if (expected) md += '**Expected answer:** `' + expected + '`\n\n';
  panes.forEach((pane, i) => {
    const m = state._selectedModels[i];
    const name = m ? (m.name || m.model) + (m.endpointName ? ' (' + m.endpointName + ')' : '') : 'Model ' + (i + 1);
    const body = pane.querySelector('.compare-text-content, .msg-body, .body');
    const text = body ? (body.innerText || body.textContent || '').trim() : '';
    const metrics = state._paneMetrics[i];
    const grade = pane.querySelector('.pane-grade-badge');
    const gradeMark = grade ? (grade.classList.contains('pass') ? ' ✓' : ' ✗') : '';
    md += '## ' + name + gradeMark + '\n\n';
    if (metrics) {
      const bits = [];
      if (metrics.output_tokens != null) bits.push(metrics.output_tokens + ' tokens');
      if (metrics.tokens_per_second != null) bits.push(metrics.tokens_per_second + ' tok/s');
      if (metrics.response_time != null) bits.push(metrics.response_time + 's');
      if (bits.length) md += '_' + bits.join(' · ') + '_\n\n';
    }
    md += text ? text + '\n\n' : '_(no response)_\n\n';
    md += '---\n\n';
  });
  return md;
}

let _exportMenuEl = null;
function _toggleExportMenu(btn) {
  if (_exportMenuEl) { _closeExportMenu(); return; }
  const r = btn.getBoundingClientRect();
  const m = document.createElement('div');
  m.className = 'compare-export-menu';
  m.style.cssText = 'position:fixed;z-index:10001;top:' + (r.bottom + 4) + 'px;left:' + r.left + 'px;background:var(--panel,var(--bg));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.3);padding:4px;font-size:12px;display:flex;flex-direction:column;min-width:170px;';
  const opts = [
    { label: 'Copy as Markdown', fn: () => _exportCopyMarkdown(btn) },
    { label: 'Download .md',     fn: () => _exportDownloadMarkdown() },
    { label: 'Print / Save PDF', fn: () => _exportPrint() },
  ];
  for (const o of opts) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = o.label;
    item.style.cssText = 'background:none;border:none;color:var(--fg);text-align:left;padding:8px 12px;border-radius:6px;cursor:pointer;font:inherit;font-size:12px;';
    item.addEventListener('mouseenter', () => { item.style.background = 'color-mix(in srgb, var(--fg) 8%, transparent)'; });
    item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
    item.addEventListener('click', () => { _closeExportMenu(); o.fn(); });
    m.appendChild(item);
  }
  document.body.appendChild(m);
  _exportMenuEl = m;
  setTimeout(() => document.addEventListener('click', _closeExportMenu, { once: true }), 0);
}
function _closeExportMenu() {
  if (_exportMenuEl) { _exportMenuEl.remove(); _exportMenuEl = null; }
}

async function _exportCopyMarkdown(_btn) {
  const md = _buildComparisonMarkdown();
  if (!md) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(md);
    } else {
      // 现代 API 可用时避免使用会抢占焦点的 textarea 回退方案 —
      // 该方案在添加/聚焦/移除 textarea 时会短暂闪烁页面。
      const ta = document.createElement('textarea');
      ta.value = md;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
    }
    try { window.uiModule?.showToast?.('Copied comparison to clipboard'); } catch {}
  } catch (e) {
    try { window.uiModule?.showToast?.('Copy failed'); } catch {}
  }
}

function _exportDownloadMarkdown() {
  const md = _buildComparisonMarkdown();
  if (!md) return;
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'compare-' + ts + '.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _exportPrint() {
  const md = _buildComparisonMarkdown();
  if (!md) return;
  // 将 Markdown 渲染为新窗口中的快速 HTML 视图并触发系统打印对话框 —
  // 用户可以从那里选择"另存为 PDF"。
  const w = window.open('', '_blank');
  if (!w) return;
  try { w.opener = null; } catch (_) {}
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = '<!doctype html><meta charset="utf-8"><title>Compare export</title>' +
    '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:780px;margin:32px auto;padding:0 24px;line-height:1.55;color:#222}' +
    'pre{background:#f5f5f5;border-radius:6px;padding:10px;white-space:pre-wrap}' +
    'h1{margin-top:0}h2{border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:32px}' +
    'hr{border:none;border-top:1px solid #ccc;margin:24px 0}' +
    '</style><body><pre style="background:none;padding:0">' + escape(md) + '</pre>' +
    '<script>window.onload=()=>setTimeout(()=>window.print(),100)<\/script>';
  w.document.write(html);
  w.document.close();
}

async function _exportComparison(btn) {
  const grid = document.querySelector('.compare-grid');
  if (!grid) return;
  const panes = grid.querySelectorAll('.compare-pane');
  if (!panes.length) return;

  const prompt = state._lastPrompt || '(no prompt yet — run a comparison first)';
  const expected = state._expectedAnswer || '';
  const date = new Date().toISOString().slice(0, 19).replace('T', ' ');

  let md = '# Compare\n\n';
  md += '**When:** ' + date + '\n';
  md += '**Type:** ' + (state._compareMode || 'chat') + (state._blindMode ? ' (blind)' : '') + '\n';
  md += '**Prompt:**\n\n```\n' + prompt + '\n```\n\n';
  if (expected) md += '**Expected answer:** `' + expected + '`\n\n';

  panes.forEach((pane, i) => {
    const m = state._selectedModels[i];
    const name = m ? (m.name || m.model) + (m.endpointName ? ' (' + m.endpointName + ')' : '') : 'Model ' + (i + 1);
    const body = pane.querySelector('.compare-text-content, .msg-body, .body');
    const text = body ? (body.innerText || body.textContent || '').trim() : '';
    const metrics = state._paneMetrics[i];
    const grade = pane.querySelector('.pane-grade-badge');
    const gradeMark = grade ? (grade.classList.contains('pass') ? ' ✓' : ' ✗') : '';

    md += '## ' + name + gradeMark + '\n\n';
    if (metrics) {
      const bits = [];
      if (metrics.output_tokens != null) bits.push(metrics.output_tokens + ' tokens');
      if (metrics.tokens_per_second != null) bits.push(metrics.tokens_per_second + ' tok/s');
      if (metrics.response_time != null) bits.push(metrics.response_time + 's');
      if (bits.length) md += '_' + bits.join(' · ') + '_\n\n';
    }
    md += text ? text + '\n\n' : '_(no response)_\n\n';
    md += '---\n\n';
  });

  // 复制到剪贴板
  const origLabel = btn ? btn.innerHTML : '';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(md);
    } else {
      const ta = document.createElement('textarea');
      ta.value = md; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
    }
    if (btn) {
      btn.innerHTML = '<span style="font-size:11px;">Copied!</span>';
      setTimeout(() => { btn.innerHTML = origLabel; }, 1500);
    }
  } catch (e) {
    if (btn) {
      btn.innerHTML = '<span style="font-size:11px;color:var(--color-error);">Failed</span>';
      setTimeout(() => { btn.innerHTML = origLabel; }, 2000);
    }
  }
}

/**
 * 构建评测提示选择器 — 仅在对比期间显示。镜像模型选择器
 * 的绝对定位位置（.chat-input-top 的右上角），并在标准
 * _compareElements 拆卸流程中自动清理。
 */
function _setupEvalPicker() {
  const inputTop = document.querySelector('.chat-input-top');
  if (!inputTop) return;

  const escapeHtml = uiModule.esc;

  // 隐藏模型选择器，使评测提示占据相同的位置
  const modelWrap = document.getElementById('model-picker-wrap');
  const prevModelDisplay = modelWrap ? modelWrap.style.display : '';
  if (modelWrap) modelWrap.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'cmp-eval-wrap';
  wrap.id = 'cmp-eval-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'cmp-eval-btn';
  btn.className = 'cmp-eval-btn';
  btn.title = t('compare.insert_eval_prompt');
  btn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
    + '<span class="cmp-eval-label">Eval prompts</span>'
    + '<svg class="cmp-eval-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  const menu = document.createElement('div');
  menu.className = 'cmp-eval-menu hidden';
  menu.id = 'cmp-eval-menu';

  function _renderItems() {
    const mode = state._compareMode || 'chat';
    // research/html 不是一级对比类型 — 优雅回退
    const key = EVAL_PROMPTS[mode] ? mode
      : (mode === 'research' ? 'search' : 'chat');
    const list = EVAL_PROMPTS[key] || [];

    if (!list.length) {
      menu.innerHTML = '<div class="cmp-eval-empty">No prompts for this type</div>';
      return;
    }
    // 按原始顺序按子类别分组
    const order = [];
    const groups = {};
    for (const p of list) {
      const sub = p.sub || 'Other';
      if (!groups[sub]) { groups[sub] = []; order.push(sub); }
      groups[sub].push(p);
    }
    let html = '';
    for (const sub of order) {
      html += '<div class="cmp-eval-group-label">' + escapeHtml(sub) + '</div>';
      for (const p of groups[sub]) {
        const data = encodeURIComponent(p.prompt);
        const ans = p.answer ? ' data-answer="' + encodeURIComponent(p.answer) + '"' : '';
        const checkMark = p.answer ? '<span class="cmp-eval-item-tick" title="Has expected answer">✓</span>' : '';
        html += '<button type="button" class="cmp-eval-item" data-prompt="' + data + '"' + ans + '>'
          + escapeHtml(p.label) + checkMark + '</button>';
      }
    }
    menu.innerHTML = html;
    menu.querySelectorAll('.cmp-eval-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const ta = document.getElementById('message');
        if (ta) {
          ta.value = decodeURIComponent(item.dataset.prompt);
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.focus();
        }
        const ans = item.dataset.answer ? decodeURIComponent(item.dataset.answer) : '';
        _showExpectedAnswer(ans);
        menu.classList.add('hidden');
      });
    });
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) {
      _renderItems();
      menu.classList.remove('hidden');
    } else {
      menu.classList.add('hidden');
    }
  });

  const _onDocClick = (e) => {
    if (!wrap.contains(e.target)) menu.classList.add('hidden');
  };
  document.addEventListener('click', _onDocClick);

  wrap.appendChild(btn);
  wrap.appendChild(menu);
  inputTop.appendChild(wrap);

  // 期望答案芯片 — 放在 chat-input-bar 的上方（外部），使其悬浮在对比网格之上，紧挨消息框。
  // 当选择带评分的提示时显示，以便评测运行器可以验证模型输出。
  const hintChip = document.createElement('div');
  hintChip.className = 'cmp-eval-expected hidden';
  hintChip.id = 'cmp-eval-expected';
  hintChip.innerHTML =
    '<span class="cmp-eval-expected-label">Expected:</span>'
    + ' <strong class="cmp-eval-expected-value"></strong>'
    + ' <button type="button" class="cmp-eval-expected-close" title="Dismiss">×</button>';
  // 将浮动面板锚定在输入栏上（需要 position:relative —
  // 通过下方 .chat-input-bar:has(.cmp-eval-expected) 上的 CSS 规则添加）。
  const inputBar = document.querySelector('.chat-input-bar');
  if (inputBar) {
    inputBar.appendChild(hintChip);
  } else {
    inputTop.appendChild(hintChip);
  }
  hintChip.querySelector('.cmp-eval-expected-close').addEventListener('click', (e) => {
    e.stopPropagation();
    hintChip.classList.add('hidden');
    state._expectedAnswer = '';
  });

  function _showExpectedAnswer(answer) {
    state._expectedAnswer = answer || '';
    if (!answer) {
      hintChip.classList.add('hidden');
      return;
    }
    hintChip.querySelector('.cmp-eval-expected-value').textContent = answer;
    hintChip.classList.remove('hidden');
  }

  // 当文本区域有任何用户文本时隐藏选择器（仅在重新开始时有用）。
  // 清除后重新显示。期望答案芯片在发送过程中保持不变 — 在每个空文本区域
  // tick 时清除它会清除 state._expectedAnswer，导致评分无法读取它，
  // 因此窗格 ✓/✗ 徽章永远不会出现。芯片只能通过其自己的关闭按钮清除
  // （或当用户选择新的评测时）。
  const ta = document.getElementById('message');
  const _syncEvalVisibility = () => {
    const hasText = ta && ta.value.trim().length > 0;
    wrap.style.display = hasText ? 'none' : '';
    if (hasText) menu.classList.add('hidden');
  };
  if (ta) ta.addEventListener('input', _syncEvalVisibility);
  _syncEvalVisibility();

  // 存储清理函数，使 cleanupResults() 能够在对比停用时分离文档监听器
  // 并恢复模型选择器。
  wrap._cleanup = () => {
    document.removeEventListener('click', _onDocClick);
    if (ta) ta.removeEventListener('input', _syncEvalVisibility);
    if (modelWrap) modelWrap.style.display = prevModelDisplay || '';
    if (hintChip.parentNode) hintChip.remove();
  };
  state._compareElements.push(wrap);
}

/** 移除对比 UI 元素并恢复原始视图。 */
function cleanupResults() {
  // 移除所有对比元素
  state._compareElements.forEach(el => {
    if (el._cleanup) el._cleanup();
    if (el._cleanupInput) el._cleanupInput();
    if (el.parentNode) el.remove();
  });
  state._compareElements = [];

  // 移除任何残留的对比/探测覆盖层
  document.querySelectorAll('.compare-probe-overlay').forEach(el => el.remove());

  // 恢复侧边栏
  if (state._sidebarWasHidden) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('hidden');
    state._sidebarWasHidden = false;
  }
  const _mobileNewRestore = document.getElementById('mobile-new-chat-btn');
  if (_mobileNewRestore && _mobileNewRestore.dataset.cmpWasDisplay !== undefined) {
    _mobileNewRestore.style.display = _mobileNewRestore.dataset.cmpWasDisplay;
    delete _mobileNewRestore.dataset.cmpWasDisplay;
  }
  state._hasVisibleResults = false;

  // 硬重新加载页面以干净地恢复所有 UI 状态
  window.location.reload();
}

function removeOverlays() {
  const bar = document.getElementById('compare-vote-bar');
  if (bar) bar.remove();
  const modal = document.getElementById('compare-model-overlay');
  if (modal) modal.remove();
  const probe = document.querySelector('.compare-probe-overlay');
  if (probe) probe.remove();
}

// ────────────────────────────────────────────────────────────────────────────
// ── showShufflePoolEditor ──
// ────────────────────────────────────────────────────────────────────────────

/** 随机池编辑器 — 让用户从骰子池中排除有问题的模型。 */
async function showShufflePoolEditor() {
  let models;
  try { models = await fetchModels(); } catch (e) {
    if (uiModule) uiModule.showError(t('compare.failed_load_models'));
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'shuffle-pool-overlay';

  const content = document.createElement('div');
  content.className = 'modal-content';
  content.style.width = '420px';

  const header = document.createElement('div');
  header.className = 'modal-header';
  header.innerHTML = '<h4>Shuffle Pool</h4>';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.innerHTML = '&#x2716;';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);
  content.appendChild(header);

  const body = document.createElement('div');
  body.className = 'modal-body';
  body.style.padding = '12px 16px';

  const desc = document.createElement('p');
  desc.style.cssText = 'color:color-mix(in srgb, var(--fg) 55%, transparent);font-size:0.85em;margin:0 0 12px;';
  desc.textContent = t('compare.uncheck_hint');
  body.appendChild(desc);

  const list = document.createElement('div');
  list.style.cssText = 'max-height:400px;overflow-y:auto;';

  const excluded = getExcludedModels();

  // 按类型分组
  const groups = { chat: [], image: [] };
  models.forEach(m => { if (groups[m.type]) groups[m.type].push(m); });

  Object.entries(groups).forEach(([type, items]) => {
    if (items.length === 0) return;
    const heading = document.createElement('div');
    heading.style.cssText = 'font-size:0.78em;font-weight:600;color:color-mix(in srgb, var(--fg) 50%, transparent);text-transform:uppercase;letter-spacing:0.5px;padding:8px 4px 4px;';
    heading.textContent = type === 'chat' ? 'Chat Models' : 'Image Models';
    list.appendChild(heading);

    items.forEach(m => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;font-size:0.85em;color:var(--fg);border-radius:4px;';
      row.addEventListener('mouseenter', () => { row.style.background = 'color-mix(in srgb, var(--fg) 4%, transparent)'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !excluded.includes(m.id);
      chk.addEventListener('change', () => {
        const exc = getExcludedModels();
        if (chk.checked) {
          const idx = exc.indexOf(m.id);
          if (idx >= 0) exc.splice(idx, 1);
        } else {
          if (!exc.includes(m.id)) exc.push(m.id);
        }
        setExcludedModels(exc);
      });
      const label = document.createElement('span');
      label.textContent = m.endpointName ? m.name + ' (' + m.endpointName + ')' : m.name;
      row.appendChild(chk);
      row.appendChild(label);
      list.appendChild(row);
    });
  });

  body.appendChild(list);
  content.appendChild(body);
  overlay.appendChild(content);
  document.body.appendChild(overlay);

  if (themeModule && themeModule.makeDraggable) {
    themeModule.makeDraggable(content, header);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ── 注册跨模块回调 ──
// ────────────────────────────────────────────────────────────────────────────

registerCompareActions({ stopAll, resetCompare });
registerStreamActions({ rerollPane, autoPreviewHtml: _autoPreviewHtml });
registerPaneActions({ setSendBtn: _setSendBtn, deactivate, streamToPane, renderSearchResults: _renderSearchResults, fetchModels });

// ────────────────────────────────────────────────────────────────────────────
// ── 公共 API ──
// ────────────────────────────────────────────────────────────────────────────

export { EVAL_PROMPTS, showScoreboard, handleCompareSubmit };

const compareModule = {
  init,
  toggleMode,
  handleCompareSubmit,
  isActive: isCompareActive,
  hasVisibleResults: () => state._hasVisibleResults,
  deactivate,
  closeCompare,
  cleanupResults,
  showShufflePoolEditor,
  showScoreboard,
};

export default compareModule;
window.compareModule = compareModule;
