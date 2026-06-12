// static/js/researchSynapse.js
//
// 深度研究运行的实时 SVG 可视化：中心查询节点，带有
// 子问题分支和随着轮次进展弹出的来源叶子节点。
// 由 chat.js 在 SSE research_progress 事件到达时命令式驱动。

const SVG_NS = 'http://www.w3.org/2000/svg';

const PHASE_LABEL = {
  probing:   'verifying model',
  planning:  'planning strategy',
  searching: 'searching',
  reading:   'reading sources',
  analyzing: 'analyzing findings',
  writing:   'writing report',
  error:     'error',
  done:      'complete',
};

function rand(a, b) { return Math.random() * (b - a) + a; }
function pick(arr)  { return arr[Math.floor(Math.random() * arr.length)]; }

export default function createResearchSynapse(container, opts = {}) {
  const W = 520, H = 220;
  const cx = W / 2, cy = H / 2;

  const wrap = document.createElement('div');
  wrap.className = 'research-synapse' + (opts.compact ? ' research-synapse-compact' : '');
  wrap.innerHTML = `
    <div class="rs-stage">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        <g class="rs-edges"></g>
        <g class="rs-nodes"></g>
        <circle class="rs-pulse" cx="${cx}" cy="${cy}" r="6"></circle>
      </svg>
    </div>
    <div class="rs-meta">
      <span class="rs-status">starting…</span>
      <span class="rs-sep">·</span>
      <span class="rs-round">round <b>0</b></span>
      <span class="rs-sep">·</span>
      <span class="rs-sources"><b>0</b> sources</span>
      <span class="rs-sep">·</span>
      <span class="rs-timer">00:00</span>
    </div>
  `;
  container.appendChild(wrap);

  const svg     = wrap.querySelector('svg');
  const edgesG  = wrap.querySelector('.rs-edges');
  const nodesG  = wrap.querySelector('.rs-nodes');
  const statusE = wrap.querySelector('.rs-status');
  const roundE  = wrap.querySelector('.rs-round b');
  const srcE    = wrap.querySelector('.rs-sources b');
  const timerE  = wrap.querySelector('.rs-timer');

  // ── 根节点（查询主题）──────────────────────────────────────────────────
  const root = document.createElementNS(SVG_NS, 'circle');
  root.setAttribute('cx', cx); root.setAttribute('cy', cy);
  root.setAttribute('r', 11);
  root.setAttribute('class', 'rs-node rs-node-root');
  nodesG.appendChild(root);
  const rootLabel = document.createElementNS(SVG_NS, 'text');
  rootLabel.setAttribute('x', cx);
  rootLabel.setAttribute('y', cy + 28);
  rootLabel.setAttribute('text-anchor', 'middle');
  rootLabel.setAttribute('class', 'rs-label');
  rootLabel.textContent = _trunc(opts.query || 'query', 28);
  nodesG.appendChild(rootLabel);

  const subs = []; // { x, y, count }
  let sourceCount = 0;
  let lastRound = 0;
  let completed = false;

  // ── 计时器 ───────────────────────────────────────────────────────────
  const startedAt = opts.startedAt || Date.now();
  let timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    timerE.textContent =
      String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' +
      String(elapsed % 60).padStart(2, '0');
  }, 1000);

  // ── 辅助函数 ─────────────────────────────────────────────────────────
  function _trunc(s, n) {
    if (!s) return '';
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function _addSub(label) {
    if (subs.length >= 10) return; // 限制视觉混乱
    // 将子节点散布在圆形上；保留轻微偏移使第一个子节点不会
    // 直接位于根标签上方。
    const slot = subs.length;
    const totalSlots = Math.max(6, subs.length + 1);
    const angle = (slot / totalSlots) * Math.PI * 2 - Math.PI / 2;
    const r = 78;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;

    const edge = document.createElementNS(SVG_NS, 'line');
    edge.setAttribute('x1', cx); edge.setAttribute('y1', cy);
    edge.setAttribute('x2', x);  edge.setAttribute('y2', y);
    edge.setAttribute('class', 'rs-edge rs-edge-firing');
    edgesG.appendChild(edge);
    setTimeout(() => edge.classList.remove('rs-edge-firing'), 1100);

    const n = document.createElementNS(SVG_NS, 'circle');
    n.setAttribute('cx', x); n.setAttribute('cy', y); n.setAttribute('r', 7);
    n.setAttribute('class', 'rs-node rs-node-sub rs-node-new');
    nodesG.appendChild(n);

    if (label) {
      const t = document.createElementNS(SVG_NS, 'text');
      // 将标签放在圆形外侧相同角度上
      const lx = cx + Math.cos(angle) * (r + 14);
      const ly = cy + Math.sin(angle) * (r + 14);
      t.setAttribute('x', lx); t.setAttribute('y', ly + 3);
      t.setAttribute('text-anchor', Math.cos(angle) > 0.15 ? 'start' :
                                    Math.cos(angle) < -0.15 ? 'end' : 'middle');
      t.setAttribute('class', 'rs-label rs-label-sub');
      t.textContent = _trunc(label, 14);
      nodesG.appendChild(t);
    }

    subs.push({ x, y, count: 0 });
  }

  function _addLeaf() {
    if (!subs.length) _addSub('');
    // 始终将新来源附加到当前轮次的子节点（即最近添加的那个）。
    // 这提供了清晰的每轮归因 — 3 轮 10 个来源显示为三个子节点各 10/10/10，
    // 而不是随机散布。
    const sub = subs[subs.length - 1];
    sub.count++;
    // 将叶子节点以同心弧排列在子节点周围：每环 6 个扇形分布在 ~140° 范围内，
    // 然后下一环进一步向外用于下 6 个，以此类推。
    // 保证每个子节点 10+ 叶子节点时仍然可读。
    const baseAngle = Math.atan2(sub.y - cy, sub.x - cx);
    const idx = sub.count - 1;
    const perRing = 6;
    const ring = Math.floor(idx / perRing);
    const slot = idx % perRing;
    const arcSpan = 2.4;
    const angle = baseAngle + (slot - (perRing - 1) / 2) * (arcSpan / perRing) + rand(-0.05, 0.05);
    const r = 26 + ring * 14 + rand(-1.5, 1.5);
    const lx = sub.x + Math.cos(angle) * r;
    const ly = sub.y + Math.sin(angle) * r;

    const edge = document.createElementNS(SVG_NS, 'line');
    edge.setAttribute('x1', sub.x); edge.setAttribute('y1', sub.y);
    edge.setAttribute('x2', lx);    edge.setAttribute('y2', ly);
    edge.setAttribute('class', 'rs-edge rs-edge-firing');
    edgesG.appendChild(edge);
    setTimeout(() => edge.classList.remove('rs-edge-firing'), 1100);

    const leaf = document.createElementNS(SVG_NS, 'circle');
    leaf.setAttribute('cx', lx); leaf.setAttribute('cy', ly);
    leaf.setAttribute('r', 4);
    leaf.setAttribute('class', 'rs-node rs-node-leaf rs-node-new');
    nodesG.appendChild(leaf);
  }

  // ── 公开 API ──────────────────────────────────────────────────────────
  return {
    element: wrap,

    /** 反映阶段变化到状态文本中及其附带效果。 */
    setPhase(phase, extra = {}) {
      if (completed) return;
      const label = PHASE_LABEL[phase] || phase || '';
      let txt = label;
      if (phase === 'searching' && extra.queries) txt += ` · ${extra.queries} queries`;
      else if (phase === 'reading' && extra.title) txt = `reading: ${_trunc(extra.title, 32)}`;
      else if (phase === 'analyzing' && extra.total_findings) txt += ` · ${extra.total_findings} findings`;
      statusE.textContent = txt;
      // 各阶段的视觉提示
      if (phase === 'error') wrap.classList.add('rs-error');
    },

    /** 增加轮次计数 — 当轮次增长时添加子问题节点。 */
    setRound(round, opts = {}) {
      if (completed) return;
      if (typeof round !== 'number' || round < 1) return;
      if (round > lastRound) {
        // 每发现一个新轮次添加一个子问题节点
        for (let i = lastRound; i < round && subs.length < 10; i++) {
          _addSub(opts.label || `R${i + 1}`);
        }
        lastRound = round;
        roundE.textContent = round;
      }
    },

    /** 更新总来源数 — 为任何新增来源添加叶子节点。 */
    setSourceCount(total) {
      if (completed) return;
      if (typeof total !== 'number' || total <= sourceCount) return;
      const delta = Math.min(total - sourceCount, 6); // 一次最多动画 6 个
      for (let i = 0; i < delta; i++) {
        // 错开叶子节点，使它们不会在同一帧弹出
        setTimeout(_addLeaf, i * 110);
      }
      sourceCount = total;
      srcE.textContent = total;
    },

    /** 标记运行完成 — 冻结脉冲并将图表变为绿色。 */
    complete() {
      if (completed) return;
      completed = true;
      wrap.classList.add('rs-complete');
      statusE.textContent = 'complete';
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    },

    destroy() {
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    },
  };
}
