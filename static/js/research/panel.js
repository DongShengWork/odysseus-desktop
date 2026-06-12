/**
 * 深度研究侧边面板 — 打开/关闭、表单、任务渲染、资料库。
 */
import * as jobs from './jobs.js';
import themeModule from '../theme.js';
import createResearchSynapse from '../researchSynapse.js';
import spinnerModule from '../spinner.js';
import { sortModelIds } from '../modelSort.js';
import { t } from '../i18n.js';

// jobId -> { synapse, status } — 在 _renderJobs() 重建之间保持活跃，
// 使 SVG 在进度事件之间保留其累积的节点/边。
const _jobSynapses = new Map();
// 用户已折叠的可折叠任务分组（'active' / 'past'）— 在重新渲染之间保持，
// 使面板不会在每次任务状态变化时重新展开。
const _collapsedSections = new Set();

// 最小化（隐藏）每个任务的 synapse "树"可视化的持久化偏好。
// 全局存储，以在频繁的 _renderJobs() 卡片重建中保持，并应用于每个运行中的任务。
const _SYNAPSE_MIN_KEY = 'research.synapseMinimized';
let _synapseMinimized = (() => { try { return localStorage.getItem(_SYNAPSE_MIN_KEY) === '1'; } catch { return false; } })();
const _vizCollapseIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
const _vizExpandIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
function _toggleSynapseMinimized() {
  _synapseMinimized = !_synapseMinimized;
  try { localStorage.setItem(_SYNAPSE_MIN_KEY, _synapseMinimized ? '1' : '0'); } catch {}
  // 实时应用到所有已渲染的卡片，无需强制完整重建。
  document.querySelectorAll('.research-job-synapse-host')
    .forEach(h => h.classList.toggle('synapse-collapsed', _synapseMinimized));
  document.querySelectorAll('.research-synapse-toggle').forEach(b => {
    b.classList.toggle('active', _synapseMinimized);
    b.title = _synapseMinimized ? 'Show visualization' : 'Minimize visualization';
    b.innerHTML = _synapseMinimized ? _vizExpandIcon : _vizCollapseIcon;
  });
}

let _open = false;
let _onDocKeydown = null;
let _apiBase = '';
let _endpoints = [];
let _expandedJobId = null;
let _markdownModule = null;
let _sessionModule = null;
let _settingsCollapsed = false;
const _SETTINGS_KEY = 'odysseus-research-settings';
const _COLLAPSE_KEY = 'odysseus-research-settings-collapsed';

try { _settingsCollapsed = localStorage.getItem(_COLLAPSE_KEY) === '1'; } catch {}

function _saveSettingsToStorage() {
  try {
    const activeCat = document.querySelector('.research-cat.active');
    localStorage.setItem(_SETTINGS_KEY, JSON.stringify({
      max_rounds: document.getElementById('research-rounds')?.value || '0',
      search_provider: document.getElementById('research-search-provider')?.value || '',
      endpoint_id: document.getElementById('research-endpoint')?.value || '',
      model: document.getElementById('research-model')?.value || '',
      category: activeCat?.dataset.cat || '',
    }));
  } catch {}
}

function _loadSettingsFromStorage() {
  try {
    const raw = localStorage.getItem(_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function _showBadge() {
  const btn = document.getElementById('tool-research-btn');
  if (!btn || btn.querySelector('.research-badge')) return;
  const dot = document.createElement('span');
  dot.className = 'research-badge';
  btn.appendChild(dot);
}

function _clearBadge() {
  const dot = document.querySelector('#tool-research-btn .research-badge');
  if (dot) dot.remove();
}

// 实时侧边栏/导轨反馈 — 镜像 cookbook 模式。当研究任务正在运行时，
// 导轨按钮脉冲闪烁；错误则标记为红色；没有任务运行时则清除。
// 面板独立，因此即使弹窗关闭也能工作。由 _renderJobs 在每次任务状态变化时调用。
function _syncResearchRail() {
  let running = 0, errored = 0, runningJob = null;
  try {
    for (const j of jobs.getJobs()) {
      if (j.status === 'running' || j.status === 'queued') {
        running++;
        if (j.status === 'running' && !runningJob) runningJob = j;
      } else if (j.status === 'error') errored++;
    }
  } catch { return; }
  const railBtn = document.getElementById('rail-research');
  const toolBtn = document.getElementById('tool-research-btn');
  const active = running > 0 || errored > 0;
  // 共享标志，使 sessions.js:_updateRailNotifs（它也为内联研究模式点亮相同的
  // 导轨按钮）与我们的进行或运算，而非覆盖 — 否则会话重新渲染会清除我们的点。
  window._researchJobsActive = active;
  if (railBtn) {
    railBtn.classList.remove('rail-notify', 'rail-notify-success', 'rail-notify-error', 'research-notif-active');
    if (active) {
      railBtn.classList.add('rail-notify', errored ? 'rail-notify-error' : 'rail-notify-success', 'research-notif-active');
    }
  }
  if (toolBtn) {
    toolBtn.classList.toggle('research-notif-active', active);
    toolBtn.style.opacity = active ? '1' : '';
    // 运行时的侧边栏反馈 — 一个小脉冲点 + 轮次文本，与 Cookbook 的运行指示器样式相同（无发光）。
    let wrap = toolBtn.querySelector('.research-sb-running');
    if (running > 0) {
      if (!wrap) {
        wrap = document.createElement('span');
        wrap.className = 'research-sb-running';
        wrap.innerHTML = '<span class="research-sb-status"></span><span class="research-sb-dot"></span>';
        toolBtn.appendChild(wrap);
      }
      const round = runningJob && runningJob.progress && runningJob.progress.round;
      // 仅显示轮次为"R1"、"R2"……（在第一个轮次落地前为空）。
      // 仅在有实际轮次时更新 — 不要在缺少轮次的进度 ticks 上清空它，
      // 否则它会在轮次之间闪灭。
      if (round) wrap.querySelector('.research-sb-status').textContent = `R${round}`;
    } else if (wrap) {
      wrap.remove();
    }
  }
  // 轨道边缘动画：任务运行时更快，空闲时更慢（环绕动画）。
  // _ensureOrbit 中的 rAF 循环驱动 --research-orbit-angle 作用于
  // 面板元素上 — 某些浏览器中仅 CSS 的 @property 动画静默失效，
  // 因此 JS 驱动以实现通用兼容性。
  _orbitSpeedDegPerSec = running > 0 ? 60 : 22;  // 6 秒/转 vs ~16 秒/转
  _ensureOrbit();
  if (window._syncRailDynamic) window._syncRailDynamic();
}

// ── 轨道角度 rAF 驱动器 ─────────────────────────────────────
// CSS @property 角度动画的通用替代方案。
// 当面板打开时每一帧驱动 #research-pane 元素上的 --research-orbit-angle。
// 当面板消失时自动停止。
let _orbitRAF = null;
let _orbitAngle = 0;
let _orbitLastTs = 0;
let _orbitSpeedDegPerSec = 22;  // 空闲环境默认值
function _ensureOrbit() {
  if (_orbitRAF) return;
  _orbitLastTs = 0;
  const tick = (ts) => {
    const pane = document.getElementById('research-pane');
    if (!pane) { _orbitRAF = null; return; }  // 面板已关闭 → 停止循环
    if (_orbitLastTs) {
      const dt = (ts - _orbitLastTs) / 1000;
      _orbitAngle = (_orbitAngle + _orbitSpeedDegPerSec * dt) % 360;
      pane.style.setProperty('--research-orbit-angle', _orbitAngle.toFixed(2) + 'deg');
    }
    _orbitLastTs = ts;
    _orbitRAF = requestAnimationFrame(tick);
  };
  _orbitRAF = requestAnimationFrame(tick);
}

/** 获取已保存的研究数量并填充标题栏芯片。 */
async function _updateResearchCount() {
  const el = document.getElementById('research-stats');
  if (!el) return;
  try {
    const res = await fetch('/api/research/library?limit=1', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    const n = data.total || 0;
    el.textContent = n + (n === 1 ? ' research' : ' research');
  } catch {}
}

const _searchIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
const _closeIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
const _playIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
const _cancelIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const _trashIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
const _externalIcon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
const _copyIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
const _retryIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>';
const _chevronIcon = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
const _editIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const _chatIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

export function init(apiBase, markdownMod, sessionMod) {
  _apiBase = apiBase;
  _markdownModule = markdownMod;
  _sessionModule = sessionMod;
  jobs.init(apiBase);
  jobs.setRenderCallback(_renderJobs);
  jobs.onComplete(() => { if (!_open) _showBadge(); });
}

export function isOpen() { return _open; }
export function toggle() {
  if (_open) {
    // 如果已最小化，则恢复而非关闭
    const overlay = document.getElementById('research-overlay');
    if (overlay && overlay.style.display === 'none') {
      overlay.style.display = '';
      const btn = document.getElementById('tool-research-btn');
      if (btn) btn.classList.remove('minimized');
      return;
    }
    closePanel();
  } else {
    openPanel();
  }
}

export function openPanel(focusJobId) {
  if (_open) {
    const overlay = document.getElementById('research-overlay');
    if (overlay && overlay.style.display === 'none') {
      overlay.style.display = '';
      const btn = document.getElementById('tool-research-btn');
      if (btn) btn.classList.remove('minimized');
    }
    document.body.classList.add('research-panel-view');
    if (focusJobId) _focusJob(focusJobId);
    return;
  }
  _open = true;

  const container = document.getElementById('chat-container');
  if (!container) return;

  document.body.classList.add('research-panel-view');
  const btn = document.getElementById('tool-research-btn');
  if (btn) btn.classList.add('active');

  const overlay = document.createElement('div');
  overlay.id = 'research-overlay';
  overlay.className = 'modal research-overlay';

  // 精确匹配 doclib/gallery/calendar 的弹窗尺寸，使研究面板看起来与
  // 弹窗家族中的其他成员一致（居中，~640px，85vh）。
  const pane = document.createElement('div');
  pane.id = 'research-pane';
  pane.className = 'modal-content doclib-modal-content research-pane';
  // 移动端：全屏，使内容有空间且任务列表可以在内部滚动。
  // 桌面端：居中 ~640px / 85vh 弹窗，与其他弹窗一致。
  pane.style.cssText = (window.innerWidth <= 768)
    ? 'width:100vw;max-width:100vw;height:90dvh;max-height:90dvh;border-radius:14px 14px 0 0;background:var(--bg);'
    : 'width:min(640px, 92vw);max-height:85vh;background:var(--bg);';
  pane.innerHTML = _buildPanelHTML();

  overlay.appendChild(pane);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePanel();
  });

  // 文档级 ESC 处理器 — 仅覆盖层的监听器永远不会触发，因为覆盖层未聚焦。
  // 在模块作用域中跟踪，使 closePanel 可以分离。
  _onDocKeydown = (e) => {
    if (e.key === 'Escape' && _open) {
      e.preventDefault();
      closePanel();
    }
  };
  document.addEventListener('keydown', _onDocKeydown);

  // 使面板可通过其标题栏拖拽 — 与 Library/Calendar 相同的模式。
  const paneHeader = pane.querySelector('.research-pane-header');
  if (themeModule && themeModule.makeDraggable && paneHeader) {
    themeModule.makeDraggable(pane, paneHeader);
  }

  _wireEvents(pane);
  _loadEndpoints().then(_restoreSavedSettings);
  _clearBadge();
  _updateResearchCount();

  if ('Notification' in window && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch {}
  }

  if (focusJobId) _focusJob(focusJobId);
}

// 滚动到并高亮显示指定会话 ID 的研究任务卡片。由聊天锚链接委托
// （[Topic](#research-<session_id>)）使用。
function _focusJob(jobId) {
  if (!jobId) return;
  // 任务可能仍在从 /api/research/active 加载 — 重试几次。
  let tries = 0;
  const tryFocus = () => {
    const card = document.querySelector(`[data-job-id="${jobId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('research-card-flash');
      setTimeout(() => card.classList.remove('research-card-flash'), 2000);
      return;
    }
    if (tries++ < 8) setTimeout(tryFocus, 400);
  };
  setTimeout(tryFocus, 200);
}

export function closePanel() {
  if (!_open) return;
  _open = false;

  if (_onDocKeydown) {
    document.removeEventListener('keydown', _onDocKeydown);
    _onDocKeydown = null;
  }

  document.body.classList.remove('research-panel-view');
  const btn = document.getElementById('tool-research-btn');
  if (btn) btn.classList.remove('active');

  const overlay = document.getElementById('research-overlay');
  if (overlay) overlay.remove();
}

function _buildPanelHTML() {
  const searchProviders = ['', 'searxng', 'duckduckgo', 'tavily', 'brave', 'google', 'serper'];
  const providerOpts = searchProviders.map(p =>
    `<option value="${p}">${p || 'Default'}</option>`
  ).join('');

  let roundOpts = '<option value="0" selected>Auto</option>';
  for (let i = 1; i <= 20; i++) {
    roundOpts += `<option value="${i}">${i}</option>`;
  }

  const settingsHidden = _settingsCollapsed ? ' style="display:none"' : '';
  const chevronCls = _settingsCollapsed ? ' collapsed' : '';

  return `
    <div class="modal-header research-pane-header">
      <h4><span style="position:relative;top:-1px;left:6px;display:inline-flex;vertical-align:middle;">${_searchIcon}</span><span style="margin-left:6px;">Deep Research</span></h4>
      <div class="research-pane-header-actions">
        <button id="research-panel-minimize" class="modal-minimize-btn" type="button" title="Minimize"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="18" x2="19" y2="18"/></svg></button>
        <button id="research-panel-close" class="close-btn" title="Close">&#x2716;</button>
      </div>
    </div>
    <div class="modal-body research-pane-body" data-no-swipe-dismiss>
      <div class="research-new-job">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">
          <h2 style="margin:0;padding:0;line-height:1;">Research <span id="research-stats" class="memory-count" style="font-size:0.6em;opacity:0.6;font-weight:normal"></span></h2>
        </div>
        <p class="memory-desc doclib-desc" style="margin-top:6px;display:flex;align-items:center;gap:6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.8;"><path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1-2-2V6h4v4a2 2 0 0 1-2 2Z"/><path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"/></svg>
          <span>Multi-step web research with an LLM-in-the-loop agent</span>
        </p>
        <div id="research-no-past-hint" class="memory-desc doclib-desc" style="display:none;margin-top:-2px;font-size:11px;opacity:0.7;">${t('research.past_research_hint')}</div>
        <textarea id="research-query" class="research-query" placeholder="e.g. Trace Odysseus's ten-year journey home from Troy — every island, monster, and detour, and why each one cost him" rows="4"></textarea>
        <div class="research-category-row" id="research-category-row">
          <button class="research-cat active" data-cat="" title="LLM auto-detects the best format">Auto</button>
          <button class="research-cat" data-cat="product">Product</button>
          <button class="research-cat" data-cat="comparison">Compare</button>
          <button class="research-cat" data-cat="howto">How-to</button>
          <button class="research-cat" data-cat="factcheck">Fact-check</button>
        </div>
        <button id="research-settings-toggle" class="research-settings-toggle${chevronCls}">
          Settings<span class="research-settings-chevron">${_chevronIcon}</span>
        </button>
        <div id="research-settings-body" class="research-settings-row"${settingsHidden}>
          <label class="research-setting">
            <span class="research-setting-label">Rounds</span>
            <select id="research-rounds">${roundOpts}</select>
          </label>
          <label class="research-setting">
            <span class="research-setting-label">Search engine</span>
            <select id="research-search-provider">${providerOpts}</select>
          </label>
          <label class="research-setting">
            <span class="research-setting-label">Endpoint</span>
            <select id="research-endpoint"><option value="">Default</option></select>
          </label>
          <label class="research-setting">
            <span class="research-setting-label">Model</span>
            <select id="research-model"><option value="">Default</option></select>
          </label>
        </div>
        <div class="research-controls-row">
          <button id="research-add-btn" class="research-add-btn"><span class="research-add-plus">+</span> Queue</button>
          <button id="research-start-btn" class="research-start-btn">${_playIcon} Start</button>
        </div>
      </div>
      <div id="research-jobs-list" class="research-jobs-list" data-no-swipe-dismiss></div>
    </div>
  `;
}

/** 淡入/滑出卡片，然后执行移除操作 — 匹配 cookbook 的平滑退出效果。 */
function _animateOutThenRemove(el, removeFn) {
  if (!el || !el.style) { removeFn(); return; }
  el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
  el.style.opacity = '0';
  el.style.transform = 'translateX(-10px)';
  setTimeout(removeFn, 320);
}

/** 通过将焦点转移到丢弃的 readonly 输入来关闭移动端键盘
 *  （仅 blur() 在 Firefox 移动端上经常被忽略）。 */
function _dismissKeyboard(input) {
  try {
    if (input) input.blur();
    const tmp = document.createElement('input');
    tmp.setAttribute('readonly', 'readonly');
    tmp.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;';
    document.body.appendChild(tmp);
    tmp.focus();
    setTimeout(() => { try { tmp.blur(); tmp.remove(); } catch {} }, 60);
  } catch {}
}

/** 每次启动后将类别选择器重置为"Auto"（自动）。 */
function _resetCategoryToAuto() {
  document.querySelectorAll('.research-cat').forEach(b =>
    b.classList.toggle('active', (b.dataset.cat || '') === ''));
}

function _wireEvents(pane) {
  pane.querySelector('#research-panel-close').addEventListener('click', closePanel);
  pane.querySelector('#research-panel-minimize')?.addEventListener('click', () => {
    const overlay = document.getElementById('research-overlay');
    if (overlay) overlay.style.display = 'none';
    const btn = document.getElementById('tool-research-btn');
    if (btn) btn.classList.add('minimized');
  });
  pane.querySelector('#research-start-btn').addEventListener('click', _handleStart);
  pane.querySelector('#research-add-btn').addEventListener('click', _handleAdd);

  pane.querySelectorAll('.research-cat').forEach(btn => {
    btn.addEventListener('click', () => {
      pane.querySelectorAll('.research-cat').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  pane.querySelector('#research-settings-toggle').addEventListener('click', () => {
    const body = document.getElementById('research-settings-body');
    const btn = document.getElementById('research-settings-toggle');
    if (!body || !btn) return;
    _settingsCollapsed = !_settingsCollapsed;
    body.style.display = _settingsCollapsed ? 'none' : '';
    btn.classList.toggle('collapsed', _settingsCollapsed);
    try { localStorage.setItem('odysseus-research-settings-collapsed', _settingsCollapsed ? '1' : '0'); } catch {}
  });

  const queryInput = pane.querySelector('#research-query');
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      _handleStart();
    }
  });

  const endpointSelect = pane.querySelector('#research-endpoint');
  endpointSelect.addEventListener('change', () => _populateModels(endpointSelect.value));

  _renderJobs();
}

function _readSettings() {
  const activeCat = document.querySelector('.research-cat.active');
  const category = activeCat?.dataset.cat || undefined;
  const settings = {
    max_rounds: parseInt(document.getElementById('research-rounds')?.value || '0', 10),
    search_provider: document.getElementById('research-search-provider')?.value || undefined,
    endpoint_id: document.getElementById('research-endpoint')?.value || undefined,
    model: document.getElementById('research-model')?.value || undefined,
    category: category || undefined,
  };
  const epSel = document.getElementById('research-endpoint');
  if (epSel && epSel.value) {
    const opt = epSel.options[epSel.selectedIndex];
    settings._endpointName = opt?.textContent || '';
  }
  const modelSel = document.getElementById('research-model');
  if (modelSel && modelSel.value) settings._modelName = modelSel.value;
  Object.keys(settings).forEach(k => { if (!settings[k]) delete settings[k]; });
  return settings;
}

function _handleAdd() {
  const queryEl = document.getElementById('research-query');
  const query = (queryEl?.value || '').trim();
  if (!query) { queryEl?.focus(); return; }
  _saveSettingsToStorage();
  jobs.addToQueue(query, _readSettings());
  queryEl.value = '';
  queryEl.focus();
}

// 将任务数据移回编辑表单，以便用户可以编辑并重新排队
function _editJob(job) {
  const queryEl = document.getElementById('research-query');
  if (queryEl) {
    queryEl.value = job.query || '';
    queryEl.focus();
    queryEl.setSelectionRange(queryEl.value.length, queryEl.value.length);
  }
  // 恢复类别
  const cat = job.category || '';
  document.querySelectorAll('.research-cat').forEach(b => {
    b.classList.toggle('active', b.dataset.cat === cat);
  });
  // 恢复设置
  const s = job.settings || {};
  const roundsEl = document.getElementById('research-rounds');
  if (roundsEl && s.max_rounds) roundsEl.value = s.max_rounds;
  const spEl = document.getElementById('research-search-provider');
  if (spEl && s.search_provider) spEl.value = s.search_provider;
  const epEl = document.getElementById('research-endpoint');
  if (epEl && s.endpoint_id) epEl.value = s.endpoint_id;
  const mEl = document.getElementById('research-model');
  if (mEl && s.model) mEl.value = s.model;
  // 移除旧任务以便点击 Start/Queue 创建新任务
  jobs.removeJob(job.id);
  // 将表单滚动到视野中
  queryEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function _handleStart() {
  const queryEl = document.getElementById('research-query');
  const startBtn = document.getElementById('research-start-btn');
  const query = (queryEl?.value || '').trim();

  // "Start All" 模式：多个任务排队 → 在启动前让用户选择并行还是顺序。
  // 首先将任何新输入的问题加入队列，使其加入批次，然后打开锚定在此按钮上的选择器。
  const queuedCount = jobs.getJobs().filter(j => j.status === 'queued').length;
  if (queuedCount > 1) {
    if (query) { _saveSettingsToStorage(); jobs.addToQueue(query, _readSettings()); queryEl.value = ''; }
    _resetCategoryToAuto();
    if (window.innerWidth <= 768) _dismissKeyboard(queryEl);
    const total = jobs.getJobs().filter(j => j.status === 'queued').length;
    _promptParallelOrSequential(total, startBtn);
    return;
  }

  // 启动请求飞行中时的视觉反馈 + Spinner
  const _setBusy = (busy) => {
    if (!startBtn) return;
    if (busy) {
      startBtn.disabled = true;
      startBtn.dataset._origHTML = startBtn.dataset._origHTML || startBtn.innerHTML;
      startBtn.innerHTML = '';
      try {
        const _wp = spinnerModule.createWhirlpool(14);
        _wp.element.style.cssText += ';vertical-align:middle;margin-right:5px;position:relative;top:-1px;';
        startBtn.appendChild(_wp.element);
      } catch {}
      startBtn.appendChild(document.createTextNode('Starting'));
      startBtn.classList.add('research-start-busy');
    } else {
      startBtn.disabled = false;
      startBtn.classList.remove('research-start-busy');
      if (startBtn.dataset._origHTML) {
        startBtn.innerHTML = startBtn.dataset._origHTML;
      }
    }
  };

  // 短暂显示忙碌状态作为点击反馈。不要等待整个启动过程 —
  // 每个任务的卡片会立即显示"Starting..."进度，而后端 POST 可能需要一段时间。
  _setBusy(true);
  setTimeout(() => _setBusy(false), 1500);

  const _mobile = window.innerWidth <= 768;
  if (!query) {
    jobs.startAllQueued();
    _resetCategoryToAuto();
    if (_mobile) _dismissKeyboard(queryEl);
    return;
  }
  _saveSettingsToStorage();
  const settings = _readSettings();
  queryEl.value = '';
  // 移动端：发送后关闭键盘；桌面端：保持焦点以便快速跟进。
  if (_mobile) _dismissKeyboard(queryEl); else queryEl.focus();
  _resetCategoryToAuto();
  jobs.startJob(query, settings).catch((e) => {
    if (typeof uiModule !== 'undefined' && uiModule?.showError) uiModule.showError('Failed to start research');
    queryEl.value = query; // 恢复以使用户可以重试
  });
}

function _restoreSavedSettings() {
  const saved = _loadSettingsFromStorage();
  if (!saved) return;
  if (saved.category !== undefined) {
    document.querySelectorAll('.research-cat').forEach(b => {
      b.classList.toggle('active', b.dataset.cat === saved.category);
    });
  }
  // 每次打开时轮次有意默认为"Auto" — 不恢复。
  // 用户可以在每次需要时选择特定的上限。
  const search = document.getElementById('research-search-provider');
  if (search && saved.search_provider !== undefined) search.value = saved.search_provider;
  const ep = document.getElementById('research-endpoint');
  if (ep && saved.endpoint_id) {
    ep.value = saved.endpoint_id;
    _populateModels(saved.endpoint_id);
    if (saved.model) {
      setTimeout(() => {
        const model = document.getElementById('research-model');
        if (model) model.value = saved.model;
      }, 50);
    }
  }
}

async function _loadEndpoints() {
  try {
    const res = await fetch(`${_apiBase}/api/model-endpoints`, { credentials: 'same-origin' });
    if (!res.ok) return;
    _endpoints = await res.json();
    const sel = document.getElementById('research-endpoint');
    if (!sel) return;
    _endpoints.filter(e => e.is_enabled && e.model_type === 'llm').forEach(ep => {
      const opt = document.createElement('option');
      opt.value = ep.id;
      opt.textContent = ep.name || ep.base_url;
      sel.appendChild(opt);
    });
  } catch {}
}

function _populateModels(endpointId) {
  const sel = document.getElementById('research-model');
  if (!sel) return;
  sel.innerHTML = '<option value="">Default</option>';
  if (!endpointId) return;
  const ep = _endpoints.find(e => e.id === endpointId);
  if (!ep || !ep.models) return;
  sortModelIds(ep.models).forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });
}

// ── 任务渲染 ──

function _renderJobs() {
  // 在每次任务状态变化时保持导轨/侧边栏指示器同步，
  // 即使面板已关闭（无容器）时也工作。
  _syncResearchRail();
  const container = document.getElementById('research-jobs-list');
  if (!container) return;

  const allJobs = jobs.getJobs();
  if (!allJobs.length) {
    // 正文中无空状态文本 — 上方的查询框就是行动号召。
    // 但仍在主标题下显示"所有过去的研究可在 Library, Research 中找到"的提示，
    // 因为 Past 区域不会渲染来承载它（这正是动态提示所针对的场景）。
    container.innerHTML = '';
    const noPastHint = document.getElementById('research-no-past-hint');
    if (noPastHint) {
      noPastHint.style.display = '';
      if (!noPastHint.dataset._wired) {
        noPastHint.dataset._wired = '1';
        noPastHint.querySelector('.research-library-link')?.addEventListener('click', (e) => {
          e.stopPropagation();
          closePanel();
          if (window.documentModule && window.documentModule.openLibrary) {
            window.documentModule.openLibrary({ tab: 'research' });
          }
        });
      }
    }
    return;
  }

  container.innerHTML = '';

  const active = allJobs.filter(j => j.status === 'queued' || j.status === 'running' || j.status === 'error' || j.status === 'cancelled');
  const past = allJobs.filter(j => j.status === 'done' && j._fromLibrary);
  const recentDone = allJobs.filter(j => j.status === 'done' && !j._fromLibrary).reverse();

  // 保持标题栏"(N research)"芯片与 Past 区域的数量同步。
  // _updateResearchCount 仅获取资料库总数，当有已会话完成但尚未
  // 持久化到资料库的任务时会少计。
  const statsEl = document.getElementById('research-stats');
  if (statsEl) {
    const n = recentDone.length + past.length;
    statsEl.textContent = n + ' research';
  }

  // 主 Start 按钮在多个任务排队时兼作"Start All (N)" — 点击它会打开
  // 并行/顺序选择器。无单独的队列栏按钮（就是那个冗余的第二个按钮）。
  const queued = active.filter(j => j.status === 'queued');
  const startBtn = document.getElementById('research-start-btn');
  if (startBtn && !startBtn.classList.contains('research-start-busy')) {
    startBtn.innerHTML = queued.length > 1
      ? `${_playIcon} Start All (${queued.length})`
      : `${_playIcon} Start`;
    startBtn.dataset._origHTML = startBtn.innerHTML;
  }

  // 动态 Past 提示：当 Past 区域不渲染（无过去任务）时，将"All past research found in
  // Library, Research"行显示在主 Research 标题下方，使链接始终可被发现。
  const noPastHint = document.getElementById('research-no-past-hint');
  if (noPastHint) {
    const hasPast = past.length + recentDone.length > 0;
    noPastHint.style.display = hasPast ? 'none' : '';
    if (!hasPast && !noPastHint.dataset._wired) {
      noPastHint.dataset._wired = '1';
      noPastHint.querySelector('.research-library-link')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closePanel();
        if (window.documentModule && window.documentModule.openLibrary) {
          window.documentModule.openLibrary({ tab: 'research' });
        }
      });
    }
  }

  // 清理已完成或已消失的任务的 synapses。complete() 在 destroy 移除前
  // 将 SVG 标记为绿色约 800ms。
  const liveIds = new Set(allJobs.filter(j => j.status === 'running').map(j => j.id));
  for (const [jobId, entry] of _jobSynapses) {
    if (liveIds.has(jobId)) continue;
    try { entry.synapse.complete(); } catch {}
    setTimeout(() => { try { entry.synapse.destroy(); } catch {} }, 800);
    _jobSynapses.delete(jobId);
  }

  // 分组到可折叠区域："Active"（进行中）和"Past research"
  // （所有已完成的任务 — 本次会话 + 资料库）。每个区域都有一个可点击的标题
  // 用于折叠正文。折叠状态通过模块级 _collapsedSections 集合在重新渲染之间保持。
  const _addSection = (key, title, arr) => {
    if (!arr.length) return;
    const collapsed = _collapsedSections.has(key);
    const sec = document.createElement('div');
    sec.className = 'research-section' + (collapsed ? ' collapsed' : '');
    const header = document.createElement('div');
    header.className = 'research-section-header';
    // 右侧的状态点（即使在折叠时也可见）：
    //  • Active = 脉冲强调色发光（工作进行中）
    //  • Active 中的任何失败/已取消任务 = 实心红色
    //  • Past（已完成）= 实心绿色（成功）
    let dotColor, dotPulse = false;
    if (key === 'active') {
      const failed = arr.some(j => j.status === 'error' || j.status === 'cancelled');
      if (failed) { dotColor = '#f44336'; }
      else { dotColor = 'var(--accent, var(--red))'; dotPulse = true; }
    } else {
      dotColor = 'var(--color-success)';
    }
    // 两个区域都在标题栏中带有"Clear all"按钮（cookbook-running 区域样式）；
    // 它清除所有研究且不得切换折叠。
    const clearAllHtml = '<button class="research-section-clear" title="Clear all research">' + _cancelIcon + ' Clear all</button>';
    header.innerHTML =
      '<span class="research-section-title">' + title + '</span>'
      + '<span class="research-section-count memory-count">' + arr.length + ' research</span>'
      + '<span class="research-section-right">'
      +   clearAllHtml
      +   '<span class="research-section-dot' + (dotPulse ? ' pulsing' : '') + '" style="background:' + dotColor + ';"></span>'
      +   '<svg class="research-section-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>'
      + '</span>';
    header.addEventListener('click', () => {
      const nowCollapsed = sec.classList.toggle('collapsed');
      if (nowCollapsed) _collapsedSections.add(key); else _collapsedSections.delete(key);
    });
    header.querySelector('.research-section-clear')?.addEventListener('click', (e) => {
      e.stopPropagation();
      // 优雅地淡出 + 折叠整个区域块，然后清除。
      container.querySelectorAll('.research-section').forEach(s => {
        s.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        s.style.opacity = '0';
        s.style.transform = 'translateX(-10px)';
      });
      setTimeout(() => jobs.clearAll(), 320);
    });
    const body = document.createElement('div');
    body.className = 'research-section-body';
    // "Past research"标题中的提示（第二行，样式类似于主 Research 描述）—
    // 过去的研究保存在资料库的 Research 标签页中。
    if (key === 'past') {
      const hint = document.createElement('div');
      hint.className = 'memory-desc doclib-desc research-library-hint';
      hint.innerHTML = t('research.past_research_hint');
      hint.querySelector('.research-library-link').addEventListener('click', (e) => {
        e.stopPropagation();
        // 先关闭研究面板，使 Library 在移动端打开时位于其上（否则它会堆叠在全屏面板下方）。
        closePanel();
        if (window.documentModule && window.documentModule.openLibrary) {
          window.documentModule.openLibrary({ tab: 'research' });
        }
      });
      header.appendChild(hint);
    }
    arr.forEach(j => body.appendChild(_buildJobCard(j)));
    sec.appendChild(header);
    sec.appendChild(body);
    container.appendChild(sec);
  };

  // （"Clear all" 位于 Past research 区域标题栏中 — 见 _addSection。）

  _addSection('active', 'Active', active);
  _addSection('past', 'Past research', recentDone.concat(past));
}

/** 作为锚定到 Start-All 按钮的小弹窗选择并行还是顺序。
 *  默认向下弹出；如果按钮下方空间不足则切换为向上弹出。
 *  外部点击 / Esc 关闭。 */
function _promptParallelOrSequential(count, anchorBtn) {
  // 移除任何先前的实例，使第二次点击干净地关闭后再重新打开。
  const existing = document.getElementById('research-run-mode-popover');
  if (existing) { existing.remove(); return; }
  if (!anchorBtn) return;

  const rect = anchorBtn.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.id = 'research-run-mode-popover';
  pop.className = 'research-run-mode-popover';
  // 模型对比选择器使用的相同并行/顺序字形。
  const ICON_PARALLEL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>';
  const ICON_SEQUENTIAL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/></svg>';
  pop.innerHTML =
    '<button class="research-run-mode-row" data-mode="parallel">' + ICON_PARALLEL + '<span class="rrm-title">Parallel</span></button>'
    + '<button class="research-run-mode-row" data-mode="sequential">' + ICON_SEQUENTIAL + '<span class="rrm-title">Sequential</span></button>';
  document.body.appendChild(pop);

  // 定位：默认从按钮的右下角向下弹出。
  // 如果视口下方空间不足，则翻转为向上弹出。
  const popHeight = pop.offsetHeight;
  const margin = 6;
  const spaceBelow = window.innerHeight - rect.bottom;
  const goUp = spaceBelow < popHeight + margin && rect.top > popHeight + margin;
  const top = goUp ? (rect.top - popHeight - margin) : (rect.bottom + margin);
  // 右对齐按钮，使菜单不会在右侧超出屏幕
  const right = Math.max(8, window.innerWidth - rect.right);
  pop.style.top = `${Math.round(top)}px`;
  pop.style.right = `${Math.round(right)}px`;
  pop.classList.add(goUp ? 'rrm-up' : 'rrm-down');

  const close = () => {
    pop.remove();
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDocClick = (e) => {
    if (pop.contains(e.target) || e.target === anchorBtn) return;
    close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  setTimeout(() => {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  pop.querySelectorAll('.research-run-mode-row').forEach(b => {
    b.addEventListener('click', () => {
      const mode = b.dataset.mode;
      close();
      if (mode === 'parallel') jobs.startAllQueued();
      else jobs.startAllQueuedSequential();
    });
  });
}

function _buildJobCard(job) {
  const card = document.createElement('div');
  card.className = `research-job-card ${job.status}${job._fromLibrary ? ' from-library' : ''}`;
  card.dataset.jobId = job.id;
  if (job.category) card.dataset.category = job.category;

  const elapsed = jobs.formatElapsed(job.elapsed || 0);
  const isExpanded = _expandedJobId === job.id;
  const modelTag = (job.modelName || job.settings?._modelName)
    ? `<span class="research-job-model">${_esc(job.modelName || job.settings._modelName)}</span>` : '';

  if (job.status === 'queued') {
    const rounds = job.settings?.max_rounds;
    const roundsLabel = !rounds ? 'Auto rounds' : `${rounds} rounds`;
    const epName = job.settings?._endpointName || '';
    const mName = job.settings?._modelName || '';
    const meta = [mName, epName, roundsLabel].filter(Boolean).join(' -- ');
    card.innerHTML = `
      <div class="research-job-header">
        <span class="research-job-query">${_esc(job.query)}</span>${job.category ? `<span class="research-cat-badge">${_esc(job.category)}</span>` : ""}
      </div>
      <div class="research-job-queued-meta">${_esc(meta)}</div>
      <div class="research-job-actions">
        <button class="research-job-action" data-action="start" title="Start">${_playIcon} Start</button>
        <button class="research-job-action" data-action="edit" title="Edit query">${_editIcon} Edit</button>
        <button class="research-job-action research-job-action-dim" data-action="remove" title="Remove">${_cancelIcon}</button>
      </div>
    `;
    card.querySelector('[data-action="start"]').addEventListener('click', (e) => {
      e.stopPropagation(); jobs.startQueued(job.id);
    });
    card.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
      e.stopPropagation(); _editJob(job);
    });
    card.querySelector('[data-action="remove"]').addEventListener('click', (e) => {
      e.stopPropagation(); jobs.removeJob(job.id);
    });

  } else if (job.status === 'running') {
    // 自动模式（max_rounds=0/undefined）— 显示轮次编号不含总数，
    // 并以 8 轮为启发式上限来计算进度条。
    const userMaxR = job.settings?.max_rounds || 0;
    const phaseMaxR = userMaxR || 0;  // 0 = formatPhase 显示"Round X"不含总数
    const phase = jobs.formatPhase(job.progress, phaseMaxR);
    const round = job.progress?.round || 0;
    const barCap = userMaxR || 8;
    const pct = Math.min(100, Math.round((round / barCap) * 100));
    card.innerHTML = `
      <div class="research-job-header">
        <span class="research-job-query">${_esc(job.query)}</span>${job.category ? `<span class="research-cat-badge">${_esc(job.category)}</span>` : ""}
        ${modelTag}
        <span class="research-job-time">${elapsed}</span>
        <button class="research-synapse-toggle${_synapseMinimized ? ' active' : ''}" title="${_synapseMinimized ? 'Show visualization' : 'Minimize visualization'}">${_synapseMinimized ? _vizExpandIcon : _vizCollapseIcon}</button>
        <button class="research-job-cancel" title="Cancel research">${_cancelIcon}</button>
      </div>
      <div class="research-job-phase">${phase}</div>
      <div class="research-job-synapse-host${_synapseMinimized ? ' synapse-collapsed' : ''}" data-synapse-host="${job.id}"></div>
      <div class="research-progress-bar"><div class="research-progress-fill" style="width:${pct}%"></div></div>
    `;
    card.querySelector('.research-job-cancel').addEventListener('click', (e) => {
      e.stopPropagation(); jobs.cancelJob(job.id);
    });
    card.querySelector('.research-synapse-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation(); _toggleSynapseMinimized();
    });
    // 点击标题栏任意位置（标题/模型/时间）也可切换可视化 —
    // cancel/synapse 按钮使用 stopPropagation 以保留自己的行为。
    const _runHdr = card.querySelector('.research-job-header');
    if (_runHdr) {
      _runHdr.style.cursor = 'pointer';
      _runHdr.addEventListener('click', () => _toggleSynapseMinimized());
    }
    // 附加（或重新附加）实时 synapse 可视化。每个任务创建一次，
    // 使动画/状态在每次进度事件触发的 _renderJobs() 重建中保持。
    const host = card.querySelector('.research-job-synapse-host');
    let entry = _jobSynapses.get(job.id);
    if (!entry) {
      const synapse = createResearchSynapse(host, {
        query: job.query || '',
        startedAt: job.startedAt || (Date.now() - (job.elapsed || 0) * 1000),
        compact: true,
      });
      entry = { synapse, status: 'running' };
      _jobSynapses.set(job.id, entry);
    } else {
      // 将现有元素移动到新渲染的容器中
      host.appendChild(entry.synapse.element);
    }
    // 推送当前进度状态
    if (job.progress) {
      entry.synapse.setPhase(job.progress.phase, job.progress);
      if (typeof job.progress.round === 'number') entry.synapse.setRound(job.progress.round);
      if (typeof job.progress.total_sources === 'number') entry.synapse.setSourceCount(job.progress.total_sources);
    }

  } else if (job.status === 'done') {
    // 从资料库加载的任务 sources=null 但预先设置了 sourceCount；新任务直接填充 sources。
    // 优先使用预先设置的数量。
    const srcCount = job.sources?.length ?? job.sourceCount ?? 0;
    // 0 个源 = 研究无法收集/提取任何内容 — 标记它。
    const failed = srcCount === 0;
    if (failed) card.classList.add('research-job-failed');
    const doneBadge = failed
      ? `<span class="research-cat-badge research-cat-failed">${_cancelIcon} no results</span>`
      : (job.category ? `<span class="research-cat-badge">${_esc(job.category)}</span>` : `<span class="research-cat-badge research-cat-standard">standard</span>`);
    const failNote = failed
      ? `<div class="research-job-failnote">Couldn't extract anything — try rephrasing the question, or switch the search engine in Settings.</div>`
      : '';
    card.innerHTML = `
      <div class="research-job-header">
        <span class="research-job-query">${_esc(job.query)}</span>${doneBadge}
        ${modelTag}
        <span class="research-job-meta">${elapsed} -- ${srcCount} sources</span>
      </div>
      ${failNote}
      <div class="research-job-actions">
        <button class="research-job-action" data-action="copy" title="Copy report to clipboard">${_copyIcon}</button>
        <button class="research-job-action" data-action="chat" title="Open follow-up chat with this research as context">${_chatIcon} Discuss</button>
        <button class="research-job-action research-job-action-report" data-action="report" title="Visual report">${_externalIcon} Visual Report</button>
        <button class="research-job-action research-job-action-dim" data-action="dismiss" title="Clear from list">${_cancelIcon}</button>
        <button class="research-job-action research-job-action-dim" data-action="delete" title="Delete from disk">${_trashIcon} Delete</button>
      </div>
      ${isExpanded ? `<div class="research-job-result">${_renderResult(job)}</div>` : ''}
    `;
    // 点击卡片上的任何位置（除了通过 stopPropagation 阻止的操作按钮）
    // 打开可视化报告 — 与 Visual Report 按钮相同。
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      window.open(`${_apiBase}/api/research/report/${job.id}`, '_blank');
    });
    card.querySelector('[data-action="copy"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget; // 在 await 之前捕获 — currentTarget 之后会变为 null
      if (!job.result) await _ensureResult(job);
      _copyResult(job, btn);
    });
    card.querySelector('[data-action="report"]').addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(`${_apiBase}/api/research/report/${job.id}`, '_blank');
    });
    card.querySelector('[data-action="chat"]').addEventListener('click', (e) => {
      e.stopPropagation();
      _chatAboutResearch(job.id, e.currentTarget);
    });
    card.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (window.styledConfirm) {
        const ok = await window.styledConfirm('Delete this research? This permanently removes it from disk.', { confirmText: 'Delete', danger: true });
        if (!ok) return;
      }
      try { await fetch(`${_apiBase}/api/research/${job.id}`, { method: 'DELETE', credentials: 'same-origin' }); } catch {}
      _animateOutThenRemove(card, () => jobs.removeJob(job.id));
    });
    card.querySelector('[data-action="dismiss"]').addEventListener('click', (e) => {
      e.stopPropagation();
      _animateOutThenRemove(card, () => jobs.removeJob(job.id));
    });

  } else {
    const errMsg = job.errorMsg ? `<div class="research-job-error">${_esc(job.errorMsg)}</div>` : '';
    card.innerHTML = `
      <div class="research-job-header">
        <span class="research-job-query">${_esc(job.query)}</span>${job.category ? `<span class="research-cat-badge">${_esc(job.category)}</span>` : ""}
        <span class="research-job-status">${job.status}</span>
      </div>
      ${errMsg}
      <div class="research-job-actions">
        <button class="research-job-action" data-action="retry" title="Retry">${_retryIcon} Retry</button>
        <button class="research-job-action" data-action="edit" title="Edit and retry">${_editIcon} Edit</button>
        <button class="research-job-action research-job-action-dim" data-action="dismiss" title="Dismiss">${_cancelIcon}</button>
      </div>
    `;
    card.querySelector('[data-action="retry"]').addEventListener('click', (e) => {
      e.stopPropagation(); jobs.retryJob(job.id);
    });
    card.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
      e.stopPropagation(); _editJob(job);
    });
    card.querySelector('[data-action="dismiss"]').addEventListener('click', (e) => {
      e.stopPropagation(); jobs.removeJob(job.id);
    });
  }

  return card;
}

const _CAT_ICONS = {
  product:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M7 8V5a5 5 0 0 1 10 0v3"/></svg>',
  comparison: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v18"/><path d="M16 3v18"/><path d="M3 8h5"/><path d="M16 16h5"/></svg>',
  howto:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  landscape:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  factcheck:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
};

const _CAT_LABELS = {
  product: 'Product',
  comparison: 'Comparison',
  howto: 'How-to Guide',
  landscape: 'Landscape',
  factcheck: 'Fact-check',
};

function _renderResult(job) {
  if (!job.result) return '<div class="research-job-loading">Loading result...</div>';
  const cat = job.category || '';
  const catIcon = _CAT_ICONS[cat] || '';
  const catLabel = _CAT_LABELS[cat] || '';

  let html = '';

  // 类别英雄横幅 — 仅用于已完成、已知类别的结果
  if (cat && catIcon) {
    html += `
      <div class="research-hero research-hero-${cat}">
        <span class="research-hero-icon">${catIcon}</span>
        <div class="research-hero-text">
          <div class="research-hero-label">${catLabel}</div>
          <div class="research-hero-query">${_esc(job.query)}</div>
        </div>
      </div>
    `;
  }

  if (job.sources?.length) {
    html += '<div class="research-job-sources">';
    for (const s of job.sources.slice(0, 10)) {
      const title = _esc(s.title || s.url || '');
      const url = _safeSourceHref(s.url);
      html += url
        ? `<a href="${url}" target="_blank" rel="noopener" class="research-source-link">${title}</a>`
        : `<span class="research-source-link">${title}</span>`;
    }
    if (job.sources.length > 10) html += `<span class="research-source-more">+${job.sources.length - 10} more</span>`;
    html += '</div>';
  }

  const bodyCls = `research-job-report-body${cat ? ' research-body-' + cat : ''}`;
  if (_markdownModule) {
    html += `<div class="${bodyCls}">${_markdownModule.renderContent(job.result)}</div>`;
  } else {
    html += `<div class="${bodyCls}"><pre>${_esc(job.result)}</pre></div>`;
  }
  return html;
}

async function _ensureResult(job) {
  if (job.result) return;
  try {
    const res = await fetch(`${_apiBase}/api/research/result-peek/${job.id}`, {
      method: 'POST', credentials: 'same-origin',
    });
    if (!res.ok) return;
    const d = await res.json();
    job.result = d.result;
    job.sources = d.sources;
    job.findings = d.raw_findings;
  } catch {}
}

async function _copyResult(job, btn) {
  if (!job.result) return;
  let text = `# ${job.query}\n\n${job.result}`;
  if (job.findings?.length) {
    text += '\n\n---\n## Raw Findings\n';
    for (const f of job.findings) {
      text += `\n### ${f.title || 'Untitled'}\nSource: ${f.url || ''}\n${f.summary || ''}\n`;
    }
  }
  if (job.sources?.length) {
    const srcList = job.sources.map(s => `- [${s.title || s.url}](${s.url})`).join('\n');
    text += `\n\n---\n## Sources\n${srcList}`;
  }
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {}
  if (!ok) {
    // 非安全上下文（HTTP 自托管）的回退方案，其中 navigator.clipboard 不可用。
    // textarea 必须在 Firefox Android / iOS Safari 中位于视口内且可聚焦，
    // 才能允许 execCommand('copy')。
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.readOnly = false;
    ta.contentEditable = 'true';
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { ta.setSelectionRange(0, text.length); } catch {}
    try {
      const sel = window.getSelection();
      if (sel && (!sel.rangeCount || sel.isCollapsed)) {
        const range = document.createRange();
        range.selectNodeContents(ta);
        sel.removeAllRanges();
        sel.addRange(range);
        ta.setSelectionRange(0, text.length);
      }
    } catch {}
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
  }
  if (btn) {
    const orig = btn.innerHTML;
    if (ok) {
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      btn.classList.add('research-job-action-copied');
      setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('research-job-action-copied'); }, 2000);
    } else {
      btn.innerHTML = `${_cancelIcon} Failed`;
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    }
  }
}

// ── 讨论此研究内容（服务器端衍生） ──

async function _chatAboutResearch(researchId, btn) {
  if (!researchId) return;
  const origLabel = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = `${_chatIcon} Creating…`; }
  try {
    const res = await fetch(`${_apiBase}/api/research/spinoff/${researchId}`, {
      method: 'POST', credentials: 'same-origin',
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).detail || ''; } catch {}
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const payload = await res.json();
    if (_sessionModule && _sessionModule.selectSession && payload.session_id) {
      if (_sessionModule.loadSessions) await _sessionModule.loadSessions().catch(() => {});
      await _sessionModule.selectSession(payload.session_id);
      closePanel();
    } else if (payload.session_id) {
      window.location.hash = '#' + payload.session_id;
      window.location.reload();
    } else {
      // 200 OK 但没有 session_id — 服务器约定违反。不要让按钮
      // 卡在"Creating…"状态；显示失败状态。
      throw new Error('Server returned no session id');
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
    alert('Could not start follow-up chat: ' + e.message);
  }
}

function _esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function _safeSourceHref(raw) {
  try {
    const parsed = new URL(String(raw || '').trim(), window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return _esc(parsed.href);
  } catch {}
  return '';
}
