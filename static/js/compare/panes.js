// compare/panes.js — 窗格生命周期、操作、布局
import state from './state.js';
import { _persistSelections } from './models.js';
import { buildVoteBar } from './vote.js';
import {
  ICON_REROLL, ICON_COPY, ICON_EXPAND, ICON_COLLAPSE, ICON_CLOSE,
  ICON_PLAY, ICON_CODE, SEND_SVG,
} from './icons.js';
import { _clearProbeWaves } from './probe.js';
import Storage from '../storage.js';
import uiModule from '../ui.js';
import spinnerModule from '../spinner.js';
import { bindMenuDismiss } from '../escMenuStack.js';

var escapeHtml = uiModule.esc;

// ── 从 compare.js 懒加载注册的函数（避免循环导入） ──
let _setSendBtn = null;
let _deactivate = null;
let _streamToPane = null;
let _renderSearchResults = null;
let _fetchModels = null;

/** 注册在 compare.js 或兄弟模块中定义的外部函数。 */
function registerPaneActions({ setSendBtn, deactivate, streamToPane, renderSearchResults, fetchModels }) {
  if (setSendBtn) _setSendBtn = setSendBtn;
  if (deactivate) _deactivate = deactivate;
  if (streamToPane) _streamToPane = streamToPane;
  if (renderSearchResults) _renderSearchResults = renderSearchResults;
  if (fetchModels) _fetchModels = fetchModels;
}

/** 槽位标签：并行模式用 A/B/C，顺序模式用 1/2/3。 */
function _slotChar(i) { return state._parallel ? String.fromCharCode(65 + i) : String(i + 1); }

// ── 停止 / 重新运行 ──

function stopAll() {
  state._abortControllers.forEach(ac => { if (ac) ac.abort(); });
  state._abortControllers = [];
  state._streaming = false;
  if (_setSendBtn) _setSendBtn('send');
  // 重新启用标题栏按钮
  document.querySelectorAll('#compare-shuffle-btn, #compare-check-btn, #compare-add-btn').forEach(b => {
    b.disabled = false; b.style.opacity = '0.7'; b.style.pointerEvents = '';
  });
}

function stopPane(paneIdx) {
  const ac = state._abortControllers[paneIdx];
  if (ac) {
    ac.abort();
    state._abortControllers[paneIdx] = null;
  }
  // 隐藏停止按钮，显示重新运行按钮
  const pane = document.querySelector(`.compare-pane[data-pane="${paneIdx}"]`);
  if (pane) {
    const stopBtn = pane.querySelector('.pane-stop-btn');
    if (stopBtn) stopBtn.style.display = 'none';
    pane.querySelectorAll('.pane-needs-response').forEach(b => b.style.display = '');
  }
  // 移除 Spinner（如果存在）
  const hist = document.getElementById('cmp-history-' + paneIdx);
  if (hist) {
    const lastAi = hist.querySelector('.msg-ai:last-child');
    if (lastAi && lastAi._spinner) { lastAi._spinner.destroy(); lastAi._spinner = null; }
    const body = lastAi && lastAi.querySelector('.body');
    if (body && !body.textContent.trim()) {
      body.innerHTML = '<span style="opacity:0.4;font-style:italic;">Stopped</span>';
    }
  }
}

async function rerollPane(paneIdx, overrideTimeout) {
  // 即使其他窗格正在流式传输也允许重新运行 — 只需先停止此窗格
  if (state._abortControllers[paneIdx]) stopPane(paneIdx);
  const hist = document.getElementById('cmp-history-' + paneIdx);
  // 重置预览状态
  const _ri = document.getElementById('cmp-iframe-' + paneIdx);
  if (_ri) { _ri.srcdoc = ''; _ri.style.display = 'none'; _ri._htmlCode = null; }
  const _rp = document.getElementById('cmp-preview-' + paneIdx);
  if (_rp) { _rp.style.display = 'none'; _rp.classList.remove('active'); }
  if (hist) hist.style.display = '';
  if (!hist) return;
  const userBodies = hist.querySelectorAll('.msg-user .body');
  const firstUserText = userBodies.length > 0 ? userBodies[0].textContent : '';
  if (!firstUserText) return;

  // 清除所有消息并重新开始
  hist.innerHTML = '';
  const userMsg = document.createElement('div');
  userMsg.className = 'msg msg-user';
  userMsg.innerHTML = '<div class="role">You</div><div class="body">' + escapeHtml(firstUserText) + '</div>';
  hist.appendChild(userMsg);

  // 重置徽章和计时器
  const badge = document.getElementById('cmp-badge-' + paneIdx);
  if (badge) { badge.textContent = ''; badge.style.color = ''; }
  const timer = document.getElementById('cmp-timer-' + paneIdx);
  if (timer) timer.textContent = '';

  // 搜索模式：重新查询搜索提供商
  if (state._compareMode === 'search') {
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

    const m = state._selectedModels[paneIdx];
    const fd = new FormData();
    fd.append('query', firstUserText);
    fd.append('provider', m.model);
    fd.append('count', '10');
    try {
      const ac = new AbortController();
      state._abortControllers[paneIdx] = ac;
      const t0 = performance.now();
      const res = await fetch(`${state.API_BASE}/api/search/query`, { method: 'POST', body: fd, signal: ac.signal });
      const data = await res.json();
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      aiBody.innerHTML = '';
      if (data.error) {
        aiBody.innerHTML = '<div style="color:var(--color-error);font-size:0.85em;">Error: ' + escapeHtml(data.error) + '</div>';
      } else if (!data.results || data.results.length === 0) {
        aiBody.innerHTML = '<div style="color:color-mix(in srgb, var(--fg) 50%, transparent);font-size:0.85em;font-style:italic;">No results found</div>';
      } else {
        aiBody.appendChild(_renderSearchResults(data));
      }
      const footer = document.createElement('div');
      footer.className = 'msg-footer';
      const span = document.createElement('span');
      span.className = 'response-metrics';
      const parts = [];
      if (data.results) parts.push(data.results.length + ' results');
      parts.push(elapsed + 's');
      span.textContent = parts.join(' | ');
      footer.appendChild(span);
      aiMsg.appendChild(footer);
    } catch (err) {
      aiBody.innerHTML = '<div style="color:var(--color-error);font-size:0.85em;">Error: ' + escapeHtml(err.message) + '</div>';
    }
    state._abortControllers[paneIdx] = null;
    hist.scrollTop = hist.scrollHeight;
    return;
  }

  // 聊天/Agent 模式：通过 session 流式传输
  const aiMsg = document.createElement('div');
  aiMsg.className = 'msg msg-ai';
  aiMsg.innerHTML = '<div class="role">AI</div><div class="body"></div>';
  const aiBody = aiMsg.querySelector('.body');
  if (spinnerModule) {
    const label = overrideTimeout ? 'Retrying (' + overrideTimeout + 's)...' : 'Re-rolling...';
    const spinner = spinnerModule.create(label, 'right');
    aiBody.appendChild(spinner.createElement());
    spinner.start();
    aiMsg._spinner = spinner;
  }
  hist.appendChild(aiMsg);
  hist.scrollTop = hist.scrollHeight;

  const opts = { skipBadge: true };
  if (overrideTimeout) opts.timeout = overrideTimeout;
  await _streamToPane(paneIdx, state._paneSessionIds[paneIdx], firstUserText, aiMsg, opts);
}

// ── 展开 / 预览 / 复制 ──

function toggleExpandPane(paneIdx, btn) {
  const grid = document.querySelector('.compare-grid');
  if (!grid) return;
  const panes = grid.querySelectorAll('.compare-pane');
  const target = panes[paneIdx];
  if (!target) return;

  if (target.classList.contains('expanded')) {
    target.classList.remove('expanded');
    panes.forEach(p => { p.style.display = ''; });
    if (btn) btn.innerHTML = ICON_EXPAND;
  } else {
    target.classList.add('expanded');
    panes.forEach((p, i) => { if (i !== paneIdx) p.style.display = 'none'; });
    if (btn) btn.innerHTML = ICON_COLLAPSE;
  }
}

/**
 * 流式传输完成后，检查响应中是否包含 HTML 代码。
 * 如果找到，在标题栏中显示播放按钮。用户点击即可运行。
 */
function _autoPreviewHtml(paneIdx, accumulated) {
  if (!accumulated) return;
  const htmlCode = _extractHtmlFromText(accumulated);
  if (!htmlCode) return;

  const iframe = document.getElementById('cmp-iframe-' + paneIdx);
  const previewBtn = document.getElementById('cmp-preview-' + paneIdx);
  if (!iframe || !previewBtn) return;

  // 将 HTML 存储在 iframe 上，等待用户点击播放
  iframe._htmlCode = htmlCode;

  // 显示播放按钮
  previewBtn.style.display = '';
  previewBtn.innerHTML = ICON_PLAY;
  previewBtn.title = t('compare.run_preview');
}

/** 切换窗格的 iframe 预览和代码视图。 */
function togglePanePreview(paneIdx) {
  const iframe = document.getElementById('cmp-iframe-' + paneIdx);
  const hist = document.getElementById('cmp-history-' + paneIdx);
  const btn = document.getElementById('cmp-preview-' + paneIdx);
  if (!iframe || !hist || !btn) return;

  const showingPreview = iframe.style.display !== 'none';
  if (showingPreview) {
    // 切换到代码视图
    iframe.style.display = 'none';
    hist.style.display = '';
    btn.innerHTML = ICON_PLAY;
    btn.title = 'Run preview';
    btn.classList.remove('active');
  } else {
    // 切换到预览 — 首次点击时加载
    if (iframe._htmlCode) iframe.srcdoc = iframe._htmlCode;
    iframe.style.display = '';
    hist.style.display = 'none';
    btn.innerHTML = ICON_CODE;
    btn.title = t('compare.show_code');
    btn.classList.add('active');
  }
}

/** 从原始累积文本中提取完整的 HTML 文档。 */
function _extractHtmlFromText(text) {
  // 1. 尝试 Markdown 代码围栏
  const fenceRe = /`{3,}(?:html)?\s*\r?\n([\s\S]*?)`{3,}/gi;
  let match;
  while ((match = fenceRe.exec(text)) !== null) {
    const code = match[1].trim();
    if (/<!doctype\s+html|<html[\s>]/i.test(code)) return code;
  }
  // 2. 裸 HTML
  const bare = text.match(/(<!doctype\s+html[\s\S]*<\/html>)/i)
    || text.match(/(<html[\s>][\s\S]*<\/html>)/i);
  if (bare) return bare[1].trim();
  return null;
}

async function copyPaneResponse(paneIdx) {
  const hist = document.getElementById('cmp-history-' + paneIdx);
  if (!hist) return;
  const aiMsgs = hist.querySelectorAll('.msg-ai');
  if (aiMsgs.length === 0) return;
  const lastAi = aiMsgs[aiMsgs.length - 1];
  // 对于图像窗格，复制提示文本
  const text = lastAi._imageData ? (lastAi._imageData.prompt || '') : (lastAi.querySelector('.body')?.textContent || '');
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  if (uiModule) uiModule.showToast(lastAi._imageData ? 'Prompt copied!' : 'Copied!');
}

// ── 添加 / 创建 / 移除窗格 ──

/** 显示锚定到窗格标题栏中 "+" 按钮的模型选择器下拉菜单。 */
async function _addPane(anchorBtn) {
  if (state._streaming) return;
  const _effectiveType = (state._compareMode === 'agent' || state._compareMode === 'research') ? 'chat' : state._compareMode;
  const filtered = state._cachedModels.filter(m => m.type === _effectiveType);
  if (!filtered.length) return;

  // 切换现有下拉菜单
  const existing = document.querySelector('.add-pane-dropdown');
  if (existing) { if (typeof existing._dismiss === 'function') existing._dismiss(); else existing.remove(); return; }

  const dropdown = document.createElement('div');
  dropdown.className = 'add-pane-dropdown';
  let closeMenu = () => dropdown.remove();

  // 大型模型列表的搜索输入框
  if (filtered.length >= 5) {
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search models\u2026';
    searchInput.className = 'add-pane-search';
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      dropdown.querySelectorAll('.pane-model-item').forEach(item => {
        item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
    searchInput.addEventListener('click', (e) => e.stopPropagation());
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = dropdown.querySelector('.pane-model-item:not([style*="display: none"])');
        if (first) first.click();
      }
    });
    dropdown.appendChild(searchInput);
    // Desktop: auto-focus the search box so the user can start typing.
    // Mobile: skip — auto-focus pops the on-screen keyboard and covers
    // the model list. The user can tap the search box if they want to
    // filter, otherwise they just tap a model directly.
    if (window.innerWidth > 768) setTimeout(() => searchInput.focus(), 0);
  }

  filtered.forEach(m => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pane-model-item';
    const label = m.endpointName ? m.name + ' (' + m.endpointName + ')' : m.name;
    item.textContent = label;
    const alreadyUsed = state._selectedModels.some(s => s.model === m.id && s.endpointId === m.endpointId);
    if (alreadyUsed) item.classList.add('current');

    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeMenu();
      await _createAndAppendPane(m);
    });
    dropdown.appendChild(item);
  });

  // Position dropdown relative to the viewport (position: fixed) so it
  // can't end up off-screen even when the toolbar has scrolled or the
  // chat-container is wider than the viewport.
  const btnRect = anchorBtn.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;
  // 先渲染到屏幕外来测量下拉菜单的实际大小。
  // 提前将宽度限制在视口范围内，避免长模型名将下拉菜单推到屏幕边缘之外，
  // 并将 z-index 提升到窗格之上。
  dropdown.style.left = '-9999px';
  dropdown.style.top = '0';
  dropdown.style.maxWidth = (vw - margin * 2) + 'px';
  dropdown.style.zIndex = '100000';
  document.body.appendChild(dropdown);
  const ddRect = dropdown.getBoundingClientRect();
  const ddW = ddRect.width;
  const ddH = ddRect.height;
  // 水平：将下拉菜单的右边缘与按钮对齐，
  // 然后约束使其保持在 [margin, vw - margin] 范围内。
  let left = btnRect.right - ddW;
  if (left + ddW > vw - margin) left = vw - margin - ddW;
  if (left < margin) left = margin;
  // 垂直：如果有空间则放在按钮下方，否则放在上方。
  const spaceBelow = vh - btnRect.bottom;
  const spaceAbove = btnRect.top;
  let top;
  if (spaceBelow >= ddH + margin || spaceBelow >= spaceAbove) {
    top = Math.min(btnRect.bottom + 4, vh - margin - Math.min(ddH, vh - margin * 2));
  } else {
    top = Math.max(margin, btnRect.top - 4 - ddH);
  }
  dropdown.style.left = left + 'px';
  dropdown.style.top = top + 'px';
  dropdown.style.right = 'auto';
  dropdown.style.bottom = 'auto';
  dropdown.style.maxHeight = Math.min(ddH, vh - margin * 2) + 'px';

  // 通过外部点击或 Escape（后者通过注册表）关闭。
  closeMenu = bindMenuDismiss(dropdown, () => dropdown.remove(), (e) => !dropdown.contains(e.target) && e.target !== anchorBtn);}

/** 为给定模型创建新窗格并追加到对比网格中。 */
async function _createAndAppendPane(m) {
  const i = state._selectedModels.length;  // 新索引

  // 创建会话
  const fd = new FormData();
  // 盲评模式：仅使用中立槽位名称 — 绝不泄露模型（问题 #1285）。
  fd.append('name', '[CMP] ' + (state._blindMode ? 'Model ' + _slotChar(i) : m.name));
  fd.append('endpoint_url', m.url || '');
  fd.append('model', m.id || '');
  if (m.endpointId) {
    fd.append('endpoint_id', m.endpointId);
    fd.append('skip_validation', 'true');
  }
  const res = await fetch(`${state.API_BASE}/api/session`, { method: 'POST', body: fd });
  if (!res.ok) return;
  const data = await res.json();

  // 更新数组
  state._selectedModels.push({ model: m.id, endpoint: m.url, endpointId: m.endpointId, name: m.name, endpointName: m.endpointName || '' });
  state._paneSessionIds.push(data.id);
  state._paneMetrics.push(null);
  state._abortControllers.push(null);
  _persistSelections();
  if (window._updateCheckBtnState) window._updateCheckBtnState();

  // 构建窗格 DOM
  const label = state._blindMode ? 'Model ' + _slotChar(i) : m.name;
  const pane = document.createElement('div');
  pane.className = 'compare-pane';
  pane.dataset.pane = String(i);
  pane.innerHTML =
    '<div class="pane-header">' +
      '<button class="pane-title pane-title-btn" id="cmp-title-' + i + '" data-pane="' + i + '" type="button">' + escapeHtml(label) + ' <span class="pane-title-caret">&#x25BE;</span></button>' +
      '<span class="pane-timer" id="cmp-timer-' + i + '"></span>' +
        '<span class="pane-finish-badge" id="cmp-badge-' + i + '"></span>' +
      '<div class="pane-actions">' +
        '<button class="pane-action-btn pane-preview-btn" data-action="preview" data-pane="' + i + '" id="cmp-preview-' + i + '" title="' + t('compare.run_preview') + '" style="display:none;">' + ICON_PLAY + '</button>' +
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

  // 追加到网格
  const grid = document.querySelector('.compare-grid');
  grid.appendChild(pane);

  // 更新网格列数
  const n = state._selectedModels.length;
  grid.dataset.cols = String(Math.min(n, 4));

  // 更新标题栏标签
  const headerSpan = document.querySelector('.compare-active > div:first-child span');
  if (headerSpan) {
    const modeLabel = ({ search: ' search providers', agent: ' agents', research: ' research models' }[state._compareMode] || ' models');
    headerSpan.textContent = t('compare.comparing') + modeLabel +
      (state._blindMode ? ' (blind)' : '') + ' \u00b7 ' + state._timeout + 's timeout';
  }

  // 重建投票栏
  buildVoteBar(n);

  // 盲评模式下提示随机排列 — 在 Shuffle 按钮旁边显示工具提示气泡
  if (state._blindMode && n > 2) {
    const shuffleBtn = document.getElementById('compare-shuffle-btn');
    if (shuffleBtn) {
      const bubble = document.createElement('div');
      bubble.style.cssText = 'position:absolute;top:100%;right:0;margin-top:6px;background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:11px;white-space:nowrap;z-index:10000;box-shadow:0 4px 12px rgba(0,0,0,0.25);pointer-events:none;opacity:0;transition:opacity 0.2s;';
      bubble.textContent = t('compare.shuffle_models_question');
      shuffleBtn.style.position = 'relative';
      shuffleBtn.appendChild(bubble);
      requestAnimationFrame(() => { bubble.style.opacity = '1'; });
      setTimeout(() => { bubble.style.opacity = '0'; setTimeout(() => bubble.remove(), 200); }, 4000);
    }
  }
}

/** 从对比网格中移除窗格。如果只剩 1 个，则退出对比模式。 */
function _removePane(paneIdx) {
  if (state._streaming) return;

  // 如果正在流式传输则中止
  if (state._abortControllers[paneIdx]) state._abortControllers[paneIdx].abort();

  // 删除会话
  const sid = state._paneSessionIds[paneIdx];
  if (sid) {
    fetch(`${state.API_BASE}/api/session/${sid}`, { method: 'DELETE' }).catch(() => {});
  }

  // 从数组中移除
  state._selectedModels.splice(paneIdx, 1);
  state._paneSessionIds.splice(paneIdx, 1);
  state._paneMetrics.splice(paneIdx, 1);
  state._abortControllers.splice(paneIdx, 1);
  _persistSelections();
  if (window._updateCheckBtnState) window._updateCheckBtnState();

  // 如果没有窗格剩余，退出对比模式
  if (state._selectedModels.length === 0) {
    if (_deactivate) _deactivate(true);
    return;
  }

  // 重建窗格 DOM — 重新索引所有窗格，使 ID 保持一致
  const grid = document.querySelector('.compare-grid');
  grid.querySelectorAll('.compare-pane').forEach(p => p.remove());

  const n = state._selectedModels.length;
  for (let i = 0; i < n; i++) {
    const label = state._blindMode ? 'Model ' + _slotChar(i) : state._selectedModels[i].name;
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
          '<button class="pane-action-btn pane-preview-btn" data-action="preview" data-pane="' + i + '" id="cmp-preview-' + i + '" title="' + t('compare.run_preview') + '" style="display:none;">' + ICON_PLAY + '</button>' +
          '<button class="pane-action-btn pane-needs-response" data-action="reroll" data-pane="' + i + '" title="Re-roll" style="display:none;">' + ICON_REROLL + '</button>' +
          '<button class="pane-action-btn pane-needs-response" data-action="copy" data-pane="' + i + '" title="Copy" style="display:none;">' + ICON_COPY + '</button>' +
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

  // 更新网格列数
  grid.dataset.cols = String(Math.min(n, 4));

  // 更新标题栏标签
  const headerSpan = document.querySelector('.compare-active > div:first-child span');
  if (headerSpan) {
    const modeLabel = ({ search: ' search providers', agent: ' agents', research: ' research models' }[state._compareMode] || ' models');
    headerSpan.textContent = t('compare.comparing') + modeLabel +
      (state._blindMode ? ' (blind)' : '') + ' \u00b7 ' + state._timeout + 's timeout';
  }

  // 重建投票栏
  buildVoteBar(n);
}

/** 在窗格标题下方显示下拉菜单以替换该窗格的模型。 */
function _showModelSwapDropdown(paneIdx, titleBtn) {
  // 流式传输期间不允许替换
  if (state._streaming) return;

  // 移除任何现有下拉菜单
  const existing = document.querySelector('.pane-model-dropdown');
  if (existing) { if (typeof existing._dismiss === 'function') existing._dismiss(); else existing.remove(); return; }

  const _effectiveType = (state._compareMode === 'agent' || state._compareMode === 'research') ? 'chat' : state._compareMode;
  const filtered = state._cachedModels.filter(m => m.type === _effectiveType);
  if (filtered.length === 0) return;

  const dropdown = document.createElement('div');
  dropdown.className = 'pane-model-dropdown';
  let closeMenu = () => dropdown.remove();

  filtered.forEach(m => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pane-model-item';
    const label = m.endpointName ? m.name + ' (' + m.endpointName + ')' : m.name;
    item.textContent = label;
    // 高亮当前模型
    if (state._selectedModels[paneIdx] && state._selectedModels[paneIdx].model === m.id
        && state._selectedModels[paneIdx].endpointId === m.endpointId) {
      item.classList.add('current');
    }
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeMenu();

      // 更新此窗格的模型并持久化
      state._selectedModels[paneIdx] = {
        model: m.id, endpoint: m.url, endpointId: m.endpointId, name: m.name,
      };
      _persistSelections();
      if (window._updateCheckBtnState) window._updateCheckBtnState();

      // 删除旧会话，创建新会话
      const oldSid = state._paneSessionIds[paneIdx];
      if (oldSid) {
        fetch(`${state.API_BASE}/api/session/${oldSid}`, { method: 'DELETE' }).catch(() => {});
      }
      const fd = new FormData();
      // 盲评模式：仅使用中立槽位名称 — 绝不泄露模型（问题 #1285）。
      fd.append('name', '[CMP] ' + (state._blindMode ? 'Model ' + _slotChar(paneIdx) : m.name));
      fd.append('endpoint_url', m.url || '');
      fd.append('model', m.id || '');
      if (m.endpointId) {
        fd.append('endpoint_id', m.endpointId);
        fd.append('skip_validation', 'true');
      }
      try {
        const res = await fetch(`${state.API_BASE}/api/session`, { method: 'POST', body: fd });
        const data = await res.json();
        state._paneSessionIds[paneIdx] = data.id;
      } catch (err) {
        console.error('Failed to create session for swapped model:', err);
      }

      // 更新标题显示
      const titleEl = document.getElementById('cmp-title-' + paneIdx);
      if (titleEl) {
        const displayName = state._blindMode
          ? 'Model ' + _slotChar(paneIdx)
          : m.name;
        titleEl.innerHTML = escapeHtml(displayName) + ' <span class="pane-title-caret">&#x25BE;</span>';
      }

      // 清空窗格历史记录以重新开始
      const hist = document.getElementById('cmp-history-' + paneIdx);
      if (hist) { hist.innerHTML = ''; hist.style.display = ''; }
      const iframe = document.getElementById('cmp-iframe-' + paneIdx);
      if (iframe) { iframe.srcdoc = ''; iframe.style.display = 'none'; iframe._htmlCode = null; }
      const previewBtn = document.getElementById('cmp-preview-' + paneIdx);
      if (previewBtn) { previewBtn.style.display = 'none'; previewBtn.classList.remove('active'); }
      const badge = document.getElementById('cmp-badge-' + paneIdx);
      if (badge) { badge.textContent = ''; badge.style.color = ''; }
    });
    dropdown.appendChild(item);
  });

  // 相对于视口定位（fixed）并追加到 document.body，这样下拉菜单
  // 不会被窄窗格的 overflow 裁剪，也不会在移动端超出屏幕边缘
  // （与 "+" 添加窗格选择器的行为一致）。
  const rect = titleBtn.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight, margin = 8;
  dropdown.style.position = 'fixed';
  dropdown.style.zIndex = '100000';
  dropdown.style.maxWidth = (vw - margin * 2) + 'px';
  dropdown.style.overflowY = 'auto';
  dropdown.style.left = '-9999px';
  dropdown.style.top = '0';
  document.body.appendChild(dropdown);
  const ddRect = dropdown.getBoundingClientRect();
  const ddW = ddRect.width, ddH = ddRect.height;
  let left = rect.left;
  if (left + ddW > vw - margin) left = vw - margin - ddW;
  if (left < margin) left = margin;
  const spaceBelow = vh - rect.bottom, spaceAbove = rect.top;
  let top;
  if (spaceBelow >= ddH + margin || spaceBelow >= spaceAbove) {
    top = Math.min(rect.bottom + 4, vh - margin - Math.min(ddH, vh - margin * 2));
  } else {
    top = Math.max(margin, rect.top - 4 - ddH);
  }
  dropdown.style.left = left + 'px';
  dropdown.style.top = top + 'px';
  dropdown.style.maxHeight = Math.min(ddH, vh - margin * 2) + 'px';

  // 通过外部点击或 Escape（后者通过注册表）关闭。
  closeMenu = bindMenuDismiss(dropdown, () => dropdown.remove(), (e) => !dropdown.contains(e.target) && e.target !== titleBtn);}

// ── 随机排列 / 重置 ──

function shufflePanePositions() {
  if (state._streaming) return;
  // 移除随机排列提示气泡（如果存在）
  const shuffleBtn = document.getElementById('compare-shuffle-btn');
  if (shuffleBtn) { const b = shuffleBtn.querySelector('div'); if (b) b.remove(); }
  const n = state._selectedModels.length;
  if (n < 2) return;

  // Fisher-Yates 洗牌获取新顺序
  const indices = Array.from({ length: n }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  // 重新排序内部状态
  const newModels = indices.map(i => state._selectedModels[i]);
  const newSessionIds = indices.map(i => state._paneSessionIds[i]);
  const newMetrics = indices.map(i => state._paneMetrics[i]);

  // 在交换前收集窗格内容（HTML）
  const paneContents = [];
  const paneClasses = [];
  for (let i = 0; i < n; i++) {
    const hist = document.getElementById('cmp-history-' + i);
    paneContents.push(hist ? hist.innerHTML : '');
    const pane = document.querySelector(`.compare-pane[data-pane="${i}"]`);
    paneClasses.push(pane ? { winner: pane.classList.contains('winner'), loser: pane.classList.contains('loser') } : {});
  }

  // 应用随机排列后的状态
  state._selectedModels = newModels;
  state._paneSessionIds = newSessionIds;
  state._paneMetrics = newMetrics;

  // 旋转 Shuffle 按钮的骰子图标
  const shuffleBtn2 = document.getElementById('compare-shuffle-btn');
  if (shuffleBtn2) {
    const diceSvg = shuffleBtn2.querySelector('svg');
    if (diceSvg) {
      diceSvg.style.transition = 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
      diceSvg.style.transform = 'rotate(360deg)';
      setTimeout(() => { diceSvg.style.transition = ''; diceSvg.style.transform = ''; }, 400);
    }
  }

  // 抖动窗格并闪烁标题
  for (let i = 0; i < n; i++) {
    const pane = document.querySelector(`.compare-pane[data-pane="${i}"]`);
    if (pane) {
      pane.style.animation = 'pane-shake 0.3s ease';
      pane.addEventListener('animationend', () => { pane.style.animation = ''; }, { once: true });
    }
    const titleEl = document.getElementById('cmp-title-' + i);
    if (titleEl) {
      titleEl.style.transition = 'opacity 0.12s ease, transform 0.12s ease';
      titleEl.style.opacity = '0.3';
      titleEl.style.transform = 'scale(0.9)';
      titleEl.innerHTML = '?';
    }
    const hist = document.getElementById('cmp-history-' + i);
    if (hist) {
      hist.style.transition = 'opacity 0.15s ease';
      hist.style.opacity = '0';
    }
  }

  setTimeout(() => {
    for (let i = 0; i < n; i++) {
      const hist = document.getElementById('cmp-history-' + i);
      const pane = document.querySelector(`.compare-pane[data-pane="${i}"]`);
      const titleEl = document.getElementById('cmp-title-' + i);
      const badge = document.getElementById('cmp-badge-' + i);
      const src = indices[i];

      if (hist) hist.innerHTML = paneContents[src];
      if (titleEl) {
        const lbl = state._blindMode ? 'Model ' + _slotChar(i) : state._selectedModels[i].name;
        titleEl.innerHTML = escapeHtml(lbl) + ' <span class="pane-title-caret">&#x25BE;</span>';
        titleEl.style.transition = 'opacity 0.25s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)';
        titleEl.style.opacity = '1';
        titleEl.style.transform = 'scale(1)';
      }
      if (badge) { badge.textContent = ''; badge.style.color = ''; }
      if (pane) {
        pane.classList.toggle('winner', !!paneClasses[src].winner);
        pane.classList.toggle('loser', !!paneClasses[src].loser);
      }
      if (hist) {
        hist.style.transition = 'opacity 0.25s ease';
        hist.style.opacity = '1';
      }
    }
  }, 200);

  // 随机排列后重新启用盲评模式
  state._blindMode = true;

  // 用新标签重建投票栏
  setTimeout(() => buildVoteBar(n), 250);
}

function resetCompare() {
  if (state._streaming) stopAll();
  const n = state._selectedModels.length;

  // 清除上次提示，使投票按钮在下次提示前禁用
  state._lastPrompt = '';

  // 重置完成徽章、标题、胜者/失败者状态
  state._finishOrder = 0;
  state._paneMetrics = new Array(n).fill(null);
  const panes = document.querySelectorAll('.compare-pane');
  for (let i = 0; i < n; i++) {
    const badge = document.getElementById('cmp-badge-' + i);
    if (badge) { badge.textContent = ''; badge.style.color = ''; }
    const titleEl = document.getElementById('cmp-title-' + i);
    if (titleEl) {
      const lbl = state._blindMode ? 'Model ' + _slotChar(i) : state._selectedModels[i].name;
      titleEl.innerHTML = escapeHtml(lbl) + ' <span class="pane-title-caret">&#x25BE;</span>';
    }
    if (panes[i]) { panes[i].classList.remove('winner', 'loser'); }

    // 清除窗格历史中的所有消息
    const hist = document.getElementById('cmp-history-' + i);
    if (hist) { hist.innerHTML = ''; hist.style.display = ''; }

    // 重置 iframe 预览
    const iframe = document.getElementById('cmp-iframe-' + i);
    if (iframe) { iframe.srcdoc = ''; iframe.style.display = 'none'; iframe._htmlCode = null; }
    const previewBtn = document.getElementById('cmp-preview-' + i);
    if (previewBtn) { previewBtn.style.display = 'none'; previewBtn.classList.remove('active'); }
  }

  // 重新启用投票栏
  buildVoteBar(n);

  // 聚焦输入框准备下一轮提示
  const ta = document.getElementById('message');
  if (ta) ta.focus();
}

export {
  registerPaneActions,
  stopAll,
  stopPane,
  rerollPane,
  toggleExpandPane,
  togglePanePreview,
  _autoPreviewHtml,
  _extractHtmlFromText,
  copyPaneResponse,
  _addPane,
  _createAndAppendPane,
  _removePane,
  _showModelSwapDropdown,
  shufflePanePositions,
  resetCompare,
};
