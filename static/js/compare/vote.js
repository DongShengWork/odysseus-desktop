// compare/vote.js — 投票、揭示、五彩纸屑
import Storage from '../storage.js';
import state from './state.js';
import { _modelDisplayNames } from './models.js';
import { getModelCost } from '../chatRenderer.js';
import uiModule from '../ui.js';
import { VOTES_STORAGE_KEY, VOTES_MAX } from './icons.js';
import { showScoreboard } from './scoreboard.js';

var escapeHtml = uiModule.esc;

// ── 懒加载助手函数以避免循环依赖 ──
// stopAll 和 resetCompare 位于 compare.js 中；调用者必须注册它们。
let _stopAll = null;
let _resetCompare = null;

/** 注册位于 compare.js 中的外部函数（避免循环导入）。 */
function registerCompareActions({ stopAll, resetCompare }) {
  _stopAll = stopAll;
  _resetCompare = resetCompare;
}

function _slotChar(i) { return state._parallel ? String.fromCharCode(65 + i) : String(i + 1); }

function addFinishBadge(paneIdx) {
  const hist = document.getElementById('cmp-history-' + paneIdx);
  if (!hist) return;
  // 找到最后一条 AI 消息的页脚
  const lastAi = hist.querySelector('.msg-ai:last-of-type');
  const footer = lastAi && lastAi.querySelector('.msg-footer');
  if (footer) {
    const badge = document.createElement('span');
    badge.className = 'pane-finish-badge';
    badge.textContent = ' · ' + t('compare.fastest');
    footer.querySelector('.response-metrics')?.appendChild(badge);
  }
}

/** 构建投票/操作栏。每个模型的"为此投票"按钮现在位于
 *  每个窗格的页脚中 — 此栏仅包含共享操作
 *  （Tie、Reveal、Reset）。 */
function buildVoteBar(n) {
  const bar = document.getElementById('compare-vote-bar');
  if (!bar) return;
  bar.classList.remove('hidden');

  bar.innerHTML = '';
  // 在发送提示之前投票按钮保持禁用。
  const noPrompt = !state._lastPrompt;

  // 同步每个窗格的投票按钮状态以匹配提示已发送/盲评模式
  // 状态 — 这些元素是在构建窗格时创建的，但它们的启用/标记
  // 状态需要在每次（重新）构建此栏时刷新
  // （例如在发送第一条提示或揭示模型后）。
  for (let i = 0; i < n; i++) {
    const paneBtn = document.querySelector('.compare-pane[data-pane="' + i + '"] .pane-vote-btn');
    if (!paneBtn) continue;
    paneBtn.disabled = noPrompt;
    paneBtn.style.opacity = noPrompt ? '0.4' : '';
    const label = state._blindMode
      ? t('compare.vote_for') + ' ' + _slotChar(i)
      : t('compare.vote_for') + ' ' + state._selectedModels[i].name;
    paneBtn.querySelector('.pane-vote-label').textContent = label;
  }

  const tieBtn = document.createElement('button');
  tieBtn.className = 'compare-vote-btn compare-vote-tie';
  tieBtn.textContent = t('compare.tie');
  if (noPrompt) { tieBtn.disabled = true; tieBtn.style.opacity = '0.25'; }
  tieBtn.addEventListener('click', () => handleVote(-1));
  bar.appendChild(tieBtn);

  // 记分板按钮 — 紧挨 Tie 按钮。即使在投票后（以及提示前）也保持启用，
  // 因为查看记分板始终是允许的。
  const scoreBtn = document.createElement('button');
  scoreBtn.className = 'compare-vote-btn compare-score-btn';
  scoreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px;"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>' + t('compare.scoreboard');
  scoreBtn.title = t('compare.scoreboard');
  scoreBtn.addEventListener('click', () => showScoreboard());
  bar.insertBefore(scoreBtn, tieBtn); // 最左边，Tie 按钮之前

  if (state._blindMode) {
    const revealBtn = document.createElement('button');
    revealBtn.className = 'compare-vote-btn';
    revealBtn.style.opacity = noPrompt ? '0.25' : '0.5';
    revealBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' + t('compare.reveal');
    if (noPrompt) revealBtn.disabled = true;
    revealBtn.addEventListener('click', () => handleVote(-2));
    bar.appendChild(revealBtn);
  }

  // Add Model 按钮

  // Reset 按钮（始终显示）
  const resetBtn = document.createElement('button');
  resetBtn.className = 'compare-vote-btn compare-rematch-btn';
  resetBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px;"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' + t('compare.reset');
  resetBtn.addEventListener('click', () => { if (_resetCompare) _resetCompare(); });
  bar.appendChild(resetBtn);
}

/** 将投票记录持久化到 localStorage 并异步发送到后端。 */
function _saveVote(winnerIdx) {
  const modelNames = _modelDisplayNames(state._selectedModels);
  const winner = winnerIdx === -1 ? 'tie' : modelNames[winnerIdx];
  // 计算每个模型的成本
  const costs = state._selectedModels.map((m, i) => {
    const pm = state._paneMetrics[i];
    if (!pm) return null;
    return getModelCost(pm.model || m.model, pm.input_tokens || 0, pm.output_tokens || 0);
  });
  const record = {
    models: modelNames,
    winner: winner,
    prompt: state._lastPrompt,
    blind: state._blindMode,
    mode: state._compareMode || 'chat',
    timestamp: Date.now(),
    costs: costs,
  };

  // localStorage 持久化
  const votes = Storage.getJSON(VOTES_STORAGE_KEY, []);
  votes.push(record);
  if (votes.length > VOTES_MAX) votes.splice(0, votes.length - VOTES_MAX);
  Storage.setJSON(VOTES_STORAGE_KEY, votes);

  // 异步 POST 到后端
  try {
    fetch(`${state.API_BASE}/api/compare/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: state._lastPrompt,
        models: modelNames,
        winner: winner,
        is_blind: state._blindMode,
      }),
    }).catch(() => {});   // 静默忽略错误
  } catch (_) {}
}

/** 在窗格标题中显示模型名称。如果选择了获胜者则高亮显示。 */
function handleVote(winnerIdx) {
  const displayNames = _modelDisplayNames(state._selectedModels);

  // 仅揭示 — 只显示名称，保持投票按钮活跃
  if (winnerIdx === -2) {
    for (let i = 0; i < state._selectedModels.length; i++) {
      const el = document.getElementById('cmp-title-' + i);
      if (el) el.innerHTML = '<strong>' + escapeHtml(displayNames[i]) + '</strong> <span class="pane-title-caret">&#x25BE;</span>';
      const hist = document.getElementById('cmp-history-' + i);
      if (hist) hist.querySelectorAll('.msg-ai .role').forEach(roleEl => {
        if (roleEl.textContent.trim() === 'AI') roleEl.textContent = displayNames[i];
      });
    }
    return;
  }

  // 防止重复投票 — 每个窗格的投票按钮 (.pane-vote-btn) 不在
  // 下方 .compare-vote-btn 禁用范围内，因此没有此防护，用户可以
  // 连续点击窗格投票按钮并在每次点击时记录分数。
  if (state._voted) return;
  state._voted = true;

  // 持久化投票
  _saveVote(winnerIdx);

  // 停止任何仍在流式传输的窗格（用户提前投票）
  if (state._streaming && _stopAll) _stopAll();

  const panes = document.querySelectorAll('.compare-pane');

  for (let i = 0; i < state._selectedModels.length; i++) {
    const el = document.getElementById('cmp-title-' + i);
    const pane = panes[i];
    if (!el) continue;
    const name = displayNames[i];
    const isWinner = winnerIdx === i;
    const isTie = winnerIdx === -1;

    let html = '';
    const caret = ' <span class="pane-title-caret">&#x25BE;</span>';
    if (isWinner) html = '<span style="color:var(--red);margin-right:4px;">&#x2605;</span><strong>' + escapeHtml(name) + '</strong> <span style="color:var(--red);font-size:0.82em;font-weight:800;text-transform:uppercase;letter-spacing:1px;position:relative;top:-2px;">' + t('compare.winner') + '!</span>' + caret;
    else if (isTie) html = '<span style="opacity:0.5;margin-right:4px;">=</span><strong>' + escapeHtml(name) + '</strong>' + caret;
    else html = '<strong>' + escapeHtml(name) + '</strong>' + caret;
    el.innerHTML = html;

    if (pane) {
      if (isWinner) { pane.classList.add('winner'); }
      else if (winnerIdx >= 0) pane.classList.add('loser'); }
  }

  // 将每个窗格消息中的 "AI" 角色标签替换为真实模型名称
  for (let i = 0; i < state._selectedModels.length; i++) {
    const hist = document.getElementById('cmp-history-' + i);
    if (!hist) continue;
    hist.querySelectorAll('.msg-ai .role').forEach(roleEl => {
      if (roleEl.textContent.trim() === 'AI') {
        roleEl.textContent = displayNames[i];
      }
    });
  }

  // 禁用投票按钮但保持重置按钮活跃 — 包括每个窗格的投票按钮
  // (.pane-vote-btn)，使其在投票后不能被连续点击。
  document.querySelectorAll('.compare-vote-btn:not(.compare-rematch-btn):not(.compare-score-btn), .pane-vote-btn').forEach(b => {
    b.disabled = true; b.style.opacity = '0.4';
  });

  // 在获胜者窗格标题处绽放五彩纸屑
  if (winnerIdx >= 0) {
    const titleEl = document.getElementById('cmp-title-' + winnerIdx);
    if (titleEl) {
      const rect = titleEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      spawnConfetti(cx, cy, 50);
      setTimeout(() => spawnConfetti(cx - 30, cy, 25), 150);
      setTimeout(() => spawnConfetti(cx + 30, cy, 25), 300);
    }
  }
}

/** 从某个点生成五彩纸屑粒子。 */
function spawnConfetti(cx, cy, count) {
  const colors = ['#ffd700', '#ff6b6b', '#5b8def', '#51cf66', '#ff922b', '#cc5de8', '#22b8cf', '#fff'];
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    const color = colors[Math.floor(Math.random() * colors.length)];
    const size = 5 + Math.random() * 8;
    const isCircle = Math.random() > 0.5;
    el.style.width = size + 'px';
    el.style.height = (isCircle ? size : size * 0.6) + 'px';
    el.style.background = color;
    el.style.borderRadius = isCircle ? '50%' : '2px';
    el.style.left = cx + 'px';
    el.style.top = cy + 'px';
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 160;
    const dx = Math.cos(angle) * speed;
    const dy = Math.sin(angle) * speed - 100;
    const duration = 1.0 + Math.random() * 1.0;
    el.animate([
      { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy + 200}px) rotate(${400 + Math.random() * 400}deg) scale(0)`, opacity: 0 }
    ], { duration: duration * 1000, easing: 'cubic-bezier(0.15, 0.6, 0.35, 1)', fill: 'forwards' });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), duration * 1000 + 50);
  }
}

export { _saveVote, handleVote, buildVoteBar, addFinishBadge, spawnConfetti, registerCompareActions };
