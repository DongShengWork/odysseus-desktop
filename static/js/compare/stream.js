// compare/stream.js — SSE 流式传输到窗格
import state from './state.js';
import { addFinishBadge } from './vote.js';
import { getModelCost, safeDisplayImageSrc } from '../chatRenderer.js';
import markdownModule from '../markdown.js';
import spinnerModule from '../spinner.js';
import uiModule from '../ui.js';
import presetsModule from '../presets.js';

var escapeHtml = uiModule.esc;

const WAVE_FRAMES = ['▁▂▃', '▂▃▄', '▃▄▅', '▄▅▆', '▅▆▇', '▆▅▄', '▅▄▃', '▄▃▂'];

function _safeHttpHref(raw) {
  try {
    const parsed = new URL(String(raw || '').trim(), window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (_) {}
  return '';
}

// ── 从 compare.js 懒加载注册的函数（避免循环依赖） ──
let _rerollPane = null;
let _autoPreviewHtml = null;

/** 注册位于 compare.js 中的外部函数。 */
function registerStreamActions({ rerollPane, autoPreviewHtml }) {
  _rerollPane = rerollPane;
  _autoPreviewHtml = autoPreviewHtml;
}

/** 将毫秒格式化为人类可读的持续时间（例如 "120ms"、"1.23s"、"4.5s"）。 */
function _formatMs(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 10000) return (ms / 1000).toFixed(2) + 's';
  return (ms / 1000).toFixed(1) + 's';
}

/** 从搜索响应构建搜索结果卡片的 DOM 容器。返回 HTMLElement。 */
function _renderSearchResults(data) {
  const container = document.createElement('div');
  container.className = 'compare-search-results';
  (data.results || []).forEach(r => {
    const card = document.createElement('div');
    card.className = 'compare-search-result';
    const titleLink = document.createElement('a');
    const safeUrl = _safeHttpHref(r.url);
    if (safeUrl) {
      titleLink.href = safeUrl;
      titleLink.target = '_blank';
      titleLink.rel = 'noopener noreferrer';
    }
    titleLink.className = 'search-result-title';
    titleLink.textContent = r.title || 'Untitled';
    card.appendChild(titleLink);
    if (r.snippet) {
      const s = document.createElement('div');
      s.className = 'search-result-snippet';
      s.textContent = r.snippet;
      card.appendChild(s);
    }
    if (r.url) {
      const u = document.createElement('div');
      u.className = 'search-result-url';
      u.textContent = r.url;
      card.appendChild(u);
    }
    container.appendChild(card);
  });
  return container;
}

/** 为搜索窗格运行合成 — 将搜索结果发送给 LLM 进行分析。 */
async function _runSynthForPane(modelToUse, synthPrompt, synthBody, spinner, hist) {
  // 为合成创建临时会话
  const fd = new FormData();
  fd.append('name', 'Synthesis');
  fd.append('endpoint_url', modelToUse.endpoint || '');
  fd.append('model', modelToUse.model || '');
  if (modelToUse.endpointId) {
    fd.append('endpoint_id', modelToUse.endpointId);
    fd.append('skip_validation', 'true');
  }

  try {
    const createRes = await fetch(`${state.API_BASE}/api/session`, { method: 'POST', body: fd });
    if (!createRes.ok) {
      const errData = await createRes.json().catch(() => ({}));
      throw new Error(errData.detail || 'Failed to create session');
    }
    const createData = await createRes.json();

    const synthAc = new AbortController();
    state._abortControllers.push(synthAc);
    const streamRes = await fetch(`${state.API_BASE}/api/chat_stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: createData.id, message: synthPrompt }),
      signal: synthAc.signal,
    });

    if (spinner) spinner.stop();
    synthBody.innerHTML = '';
    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let synthText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const d = JSON.parse(line.slice(6));
            if (d.delta) {
              synthText += d.delta;
              if (markdownModule && synthText.trim()) {
                synthBody.innerHTML = markdownModule.processWithThinking(
                  markdownModule.squashOutsideCode(synthText)
                );
              } else {
                synthBody.textContent = synthText;
              }
              hist.scrollTop = hist.scrollHeight;
            }
          } catch (e) {}
        }
      }
    }

    // 最终高亮
    if (window.hljs) synthBody.querySelectorAll('pre code:not(.hljs)').forEach(b => window.hljs.highlightElement(b));

    // 清理临时会话
    fetch(`${state.API_BASE}/api/session/${createData.id}`, { method: 'DELETE' }).catch(() => {});
  } catch (e) {
    if (spinner) spinner.stop();
    synthBody.innerHTML = '<div style="color:var(--color-error);font-size:0.85em;">Synthesis failed: ' + escapeHtml(e.message) + '</div>';
  }
}

/** 将 SSE 响应流式传输到对比窗格中。处理文本、工具块、图像和指标。 */
async function streamToPane(paneIdx, sessionId, message, aiMsgEl, opts) {
  opts = opts || {};
  const aiBody = aiMsgEl ? aiMsgEl.querySelector('.body') : null;
  const hist = aiMsgEl ? aiMsgEl.parentElement : null;
  if (!aiBody) return;

  const ac = new AbortController();
  state._abortControllers[paneIdx] = ac;

  // 显示此窗格的停止按钮
  const _paneEl = document.querySelector(`.compare-pane[data-pane="${paneIdx}"]`);
  if (_paneEl) {
    const _stopBtn = _paneEl.querySelector('.pane-stop-btn');
    if (_stopBtn) _stopBtn.style.display = '';
  }

  let accumulated = '';
  let metrics = null;
  let timedOut = false;
  let streamOk = false;
  let currentToolBlock = null;  // 跟踪活跃的 agent 工具块
  // 空闲超时 — 仅当在这么多秒内没有收到任何数据时才中止。
  // 长生成（SVG、大量代码）只要流保持活跃就没问题。
  // opts.timeout 可能仍会在某些路径中进一步收紧此值。
  const effectiveTimeout = opts.timeout || state._timeout;
  let timeoutId = setTimeout(() => { timedOut = true; ac.abort(); }, effectiveTimeout * 1000);
  const _resetIdleTimeout = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => { timedOut = true; ac.abort(); }, effectiveTimeout * 1000);
  };

  // 实时计时器
  const _timerStart = performance.now();
  let _ttft = 0; // 首个 token 时间
  let _timerDone = false;
  const _timerEl = document.getElementById('cmp-timer-' + paneIdx);
  let _rafId = 0;
  function _tickTimer() {
    if (_timerDone) return;
    const elapsed = performance.now() - _timerStart;
    if (_timerEl) _timerEl.textContent = _formatMs(elapsed);
    _rafId = requestAnimationFrame(_tickTimer);
  }
  _rafId = requestAnimationFrame(_tickTimer);

  // 节流 Markdown 渲染 — 在每个 token 到达时重新渲染整个增长中的缓冲区
  // 会导致总工作量为 O(n²)。合并更新，使最多每 ~80ms 绘制一次。
  // 最终渲染仍会在流结束时运行以保证质量。
  let _renderPending = false;
  let _renderLastAt = 0;
  const _RENDER_THROTTLE_MS = 80;
  function _scheduleLiveRender(target) {
    if (_renderPending) return;
    const now = performance.now();
    const elapsed = now - _renderLastAt;
    const delay = elapsed >= _RENDER_THROTTLE_MS ? 0 : _RENDER_THROTTLE_MS - elapsed;
    _renderPending = true;
    setTimeout(() => {
      _renderPending = false;
      _renderLastAt = performance.now();
      if (markdownModule && accumulated.trim()) {
        target.innerHTML = markdownModule.processWithThinking(
          markdownModule.squashOutsideCode(accumulated)
        );
      } else {
        target.textContent = accumulated;
      }
      if (hist) hist.scrollTop = hist.scrollHeight;
    }, delay);
  }

  try {
    const fd = new FormData();
    fd.append('message', message);
    fd.append('session', sessionId);

    // 对比模式决定启用哪些工具/功能
    const isAgent = state._compareMode === 'agent';
    const isResearch = state._compareMode === 'research';

    // Agent 模式：启用所有工具（web、bash 等）
    if (isAgent) {
      fd.append('mode', 'agent');
      fd.append('allow_web_search', 'true');
      fd.append('allow_bash', 'true');
    } else if (isResearch) {
      fd.append('use_research', 'true');
    } else {
      // Chat/Image：仅纯聊天 — 无工具、无搜索、无 bash、无 RAG。
      // 显式发送 mode='chat' 使后端的 compare_mode 剥离
      // （chat_routes.py 第 385 行）实际触发 — 否则表单
      // 字段缺失且 chat_mode 默认为 ""，意味着
      // bash/python/web_search 从未被添加到 disabled_tools 中，
      // 模型仍会尝试运行 Python。
      fd.append('mode', 'chat');
      fd.append('use_rag', 'false');
    }
    const incognitoChk = document.getElementById('incognito-toggle');
    if (incognitoChk && incognitoChk.checked) {
      fd.append('incognito', 'true');
    }
    // 在对比模式中禁用文档工具和内存注入
    fd.append('no_documents', 'true');
    fd.append('no_memory', 'true');
    // 告知后端这是对比模式 — 移除所有非开关工具
    fd.append('compare_mode', 'true');
    // 如果选择了预设则转发
    if (presetsModule && presetsModule.getSelectedPreset()) {
      fd.append('preset_id', presetsModule.getSelectedPreset());
    }

    const response = await fetch(`${state.API_BASE}/api/chat_stream`, {
      method: 'POST', body: fd, signal: ac.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      _resetIdleTimeout();  // 任何数据块 = 流仍在活跃

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') break;
        try {
          const json = JSON.parse(data);
          if (json.type === 'metrics') {
            metrics = json.data;

          // ── 研究进度（Spinner 更新） ──
          } else if (json.type === 'research_progress') {
            const rp = json.data;
            const spinner = aiMsgEl._spinner;
            if (spinner) {
              if (rp.phase === 'searching') {
                const q = rp.queries ? `${rp.queries} queries` : '';
                const s = rp.total_sources ? ` · ${rp.total_sources} sources` : '';
                spinner.updateMessage(`R${rp.round || '?'}: Searching${q ? ' (' + q + ')' : ''}${s}`);
              } else if (rp.phase === 'reading') {
                spinner.updateMessage(`R${rp.round || '?'}: Reading ${rp.new_sources || ''} pages`);
              } else if (rp.phase === 'analyzing') {
                spinner.updateMessage(`R${rp.round || '?'}: Analyzing ${rp.total_findings || 0} findings`);
              } else if (rp.phase === 'writing') {
                spinner.updateMessage(`Writing report · ${rp.total_sources || 0} sources`);
              } else if (rp.phase === 'error') {
                spinner.updateMessage(rp.message || 'Research error');
              }
            }

          // ── 研究源 / 网络源（紧凑源框） ──
          } else if (json.type === 'research_sources' || json.type === 'web_sources') {
            const sources = json.data || [];
            if (sources.length > 0) {
              const label = json.type === 'research_sources' ? 'Research' : 'Web';
              const box = document.createElement('div');
              box.className = 'compare-sources-box';
              box.innerHTML = '<span class="sources-label">' + sources.length + ' ' + label + ' sources</span>';
              box.title = sources.map(s => s.title || s.url).join('\n');
              // 用源 + 新 Spinner 替换原 Spinner
              aiBody.innerHTML = '';
              aiBody.appendChild(box);
              if (spinnerModule) {
                const newSpinner = spinnerModule.create('Generating response...', 'right');
                aiBody.appendChild(newSpinner.createElement());
                newSpinner.start();
                aiMsgEl._spinner = newSpinner;
              }
            }

          // ── 工具开始（bash、web 搜索 agent 工具） ──
          } else if (json.type === 'tool_start') {
            // 在工具块之前完成任何累积的文本
            if (accumulated.trim() && aiMsgEl._textEl) {
              if (markdownModule) {
                aiMsgEl._textEl.innerHTML = markdownModule.processWithThinking(
                  markdownModule.squashOutsideCode(accumulated));
                if (window.hljs) aiMsgEl._textEl.querySelectorAll('pre code:not(.hljs)').forEach(b => window.hljs.highlightElement(b));
              }
            }
            // 销毁 Spinner（如果仍然存在）
            if (aiMsgEl._spinner && aiMsgEl._spinner.element) {
              aiMsgEl._spinner.destroy();
              aiMsgEl._spinner = null;
              // 清理 Spinner 元素但保留源框和文本
              const spinnerEl = aiBody.querySelector('.spinner-wrapper, .mini-spinner');
              if (spinnerEl) spinnerEl.remove();
            }
            const toolName = json.tool || 'tool';
            const cmd = json.command || '';
            // 图像生成：显示 ASCII Spinner 而非紧凑工具块
            if (toolName === 'generate_image' && spinnerModule) {
              aiBody.innerHTML = '';
              const imgSpinner = spinnerModule.create('Generating image...', 'right');
              aiBody.appendChild(imgSpinner.createElement());
              imgSpinner.start();
              aiMsgEl._imgSpinner = imgSpinner;
              currentToolBlock = null;
            } else {
              // Agent 线程节点 — 匹配主聊天样式
              const _toolLabels = { bash: 'Terminal', python: 'Python', web_search: 'Web Search', read_file: 'Read File', write_file: 'Write File' };
              const toolLabel = _toolLabels[toolName.toLowerCase()] || toolName;
              const cmdHtml = cmd ? `<pre class="agent-thread-cmd">${escapeHtml(cmd)}</pre>` : '';
              const node = document.createElement('div');
              node.className = 'agent-thread-node running';
              node.innerHTML = `<div class="agent-thread-dot"></div><div class="agent-thread-header"><span class="agent-thread-icon">\u25B6</span><span class="agent-thread-tool">${escapeHtml(toolLabel)}</span><span class="agent-thread-wave">▁▂▃</span></div><div class="agent-thread-content">${cmdHtml}</div>`;
              node.querySelector('.agent-thread-header').addEventListener('click', () => node.classList.toggle('open'));
              // 波浪动画
              const waveEl = node.querySelector('.agent-thread-wave');
              if (waveEl) {
                const waveFrames = WAVE_FRAMES;
                let waveIdx = 0;
                node._waveInterval = setInterval(() => { waveIdx = (waveIdx + 1) % waveFrames.length; waveEl.textContent = waveFrames[waveIdx]; }, 100);
              }
              aiBody.appendChild(node);
              currentToolBlock = node;
            }
            if (hist) hist.scrollTop = hist.scrollHeight;

          // ── 工具输出（图像或非图像） ──
          } else if (json.type === 'tool_output') {
            if (json.image_url) {
              // 停止图像 Spinner 并在窗格中渲染生成的图像
              if (aiMsgEl._imgSpinner) { aiMsgEl._imgSpinner.destroy(); aiMsgEl._imgSpinner = null; }
              const safeImageUrl = safeDisplayImageSrc(json.image_url);
              aiBody.innerHTML = '';
              if (!safeImageUrl) {
                aiBody.textContent = t('compare.image_unavailable');
              } else {
                const img = document.createElement('img');
                img.className = 'compare-gen-image';
                img.src = safeImageUrl;
                img.alt = json.image_prompt || '';
                img.title = json.image_prompt || '';
                img.addEventListener('click', () => window.open(safeImageUrl, '_blank', 'noopener,noreferrer'));
                aiBody.appendChild(img);
                if (json.image_prompt) {
                  const caption = document.createElement('div');
                  caption.style.cssText = 'font-size:0.82em;color:color-mix(in srgb, var(--fg) 55%, transparent);margin-top:6px;line-height:1.4;';
                  caption.textContent = json.image_prompt;
                  aiBody.appendChild(caption);
                }
                // 在图像下方显示模型名称（盲评模式下隐藏直到投票）
                if (json.image_model && !state._blindMode) {
                  const modelLabel = document.createElement('div');
                  modelLabel.style.cssText = 'font-size:0.75em;color:color-mix(in srgb, var(--fg) 40%, transparent);margin-top:4px;';
                  modelLabel.textContent = json.image_model;
                  aiBody.appendChild(modelLabel);
                }
                aiMsgEl._imageData = { url: safeImageUrl, prompt: json.image_prompt, model: json.image_model, size: json.image_size, quality: json.image_quality };
              }
            } else if (currentToolBlock) {
              // 停止波浪动画
              if (currentToolBlock._waveInterval) { clearInterval(currentToolBlock._waveInterval); currentToolBlock._waveInterval = null; }
              const ok = (json.exit_code === 0 || json.exit_code == null);
              const cmd = json.command || '';
              const _toolLabels2 = { bash: 'Terminal', python: 'Python', web_search: 'Web Search', read_file: 'Read File', write_file: 'Write File' };
              const tLabel = _toolLabels2[(json.tool || '').toLowerCase()] || json.tool || '';
              let outHtml = '';
              if (json.output && json.output.trim()) {
                outHtml = `<details class="agent-tool-output"><summary>Output</summary><pre>${escapeHtml(json.output)}</pre></details>`;
              }
              const cmdHtml = cmd ? `<pre class="agent-thread-cmd">${escapeHtml(cmd)}</pre>` : '';
              currentToolBlock.className = 'agent-thread-node' + (ok ? '' : ' error');
              currentToolBlock.innerHTML = `<div class="agent-thread-dot"></div><div class="agent-thread-header"><span class="agent-thread-icon">${ok ? '\u2713' : '\u2717'}</span><span class="agent-thread-tool">${escapeHtml(tLabel)}</span><span class="agent-thread-status">${ok ? 'done' : 'failed'}</span><span class="agent-thread-chevron">\u25B6</span></div><div class="agent-thread-content">${cmdHtml}${outHtml}</div>`;
              currentToolBlock.querySelector('.agent-thread-header').addEventListener('click', () => currentToolBlock.classList.toggle('open'));
              currentToolBlock = null;
              // 重置文本元素，使后续的增量创建新的容器
              aiMsgEl._textEl = null;
              accumulated = '';
            }
            if (hist) hist.scrollTop = hist.scrollHeight;
          } else if (json.delta) {
            // 如果已经渲染了图像，跳过文本增量
            if (aiMsgEl._imageData) continue;
            // 在第一个文本增量时捕获 TTFT
            if (!accumulated && !_ttft) _ttft = performance.now() - _timerStart;
            // 在第一个增量时，销毁 Spinner 并准备文本区域
            if (!accumulated && aiMsgEl._spinner) {
              if (aiMsgEl._spinner.element) aiMsgEl._spinner.destroy();
              aiMsgEl._spinner = null;
              // 保留源框，清除其他所有内容
              const srcBox = aiBody.querySelector('.compare-sources-box');
              aiBody.innerHTML = '';
              if (srcBox) aiBody.appendChild(srcBox);
              // 添加文本容器
              const textEl = document.createElement('div');
              textEl.className = 'compare-text-content';
              aiBody.appendChild(textEl);
              aiMsgEl._textEl = textEl;
            }
            // 工具块之后，为继续的文本创建新的文本容器
            if (!accumulated && !aiMsgEl._textEl) {
              const textEl = document.createElement('div');
              textEl.className = 'compare-text-content';
              aiBody.appendChild(textEl);
              aiMsgEl._textEl = textEl;
            }
            accumulated += json.delta;
            const target = aiMsgEl._textEl || aiBody;
            _scheduleLiveRender(target);
          }
        } catch (e) { console.warn('Compare stream render error:', e); }
      }
    }

    streamOk = true;
    // 销毁任何剩余的 Spinner
    if (aiMsgEl._spinner && aiMsgEl._spinner.element) aiMsgEl._spinner.destroy();
    aiMsgEl._spinner = null;
    // 最终渲染
    const finalTarget = aiMsgEl._textEl || aiBody;
    if (markdownModule && accumulated.trim()) {
      finalTarget.innerHTML = markdownModule.processWithThinking(
        markdownModule.squashOutsideCode(accumulated)
      );
    }
    if (window.hljs) {
      finalTarget.querySelectorAll('pre code:not(.hljs)').forEach(b => window.hljs.highlightElement(b));
    }

    // ── 如果响应包含 HTML 则显示播放按钮 ──
    if (_autoPreviewHtml) _autoPreviewHtml(paneIdx, accumulated);

    // 指标页脚
    if (aiMsgEl && aiMsgEl._imageData) {
      // 图像特定的页脚，包含操作和指标
      const imgD = aiMsgEl._imageData;
      const footer = document.createElement('div');
      footer.className = 'msg-footer';

      // 操作按钮（复制提示 + 下载）
      const actions = document.createElement('span');
      actions.className = 'msg-actions';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'footer-copy-btn';
      copyBtn.type = 'button';
      copyBtn.title = t('compare.copy_prompt');
      copyBtn.textContent = '\u2398';
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const txt = imgD.prompt || '';
        if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
        else { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
        copyBtn.textContent = '\u2713';
        setTimeout(() => { copyBtn.textContent = '\u2398'; }, 1500);
        if (uiModule) uiModule.showToast(t('compare.prompt_copied'));
      });
      actions.appendChild(copyBtn);

      const dlBtn = document.createElement('button');
      dlBtn.className = 'footer-copy-btn';
      dlBtn.type = 'button';
      dlBtn.title = t('compare.download_image');
      dlBtn.textContent = '\u2913';
      dlBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const resp = await fetch(imgD.url);
          const blob = await resp.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = (imgD.prompt || 'image').slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, '') + '.png';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(a.href);
          dlBtn.textContent = '\u2713';
          setTimeout(() => { dlBtn.textContent = '\u2913'; }, 1500);
        } catch { dlBtn.textContent = '\u2717'; setTimeout(() => { dlBtn.textContent = '\u2913'; }, 1500); }
      });
      actions.appendChild(dlBtn);

      footer.appendChild(actions);

      // 指标 — 在盲评模式下隐藏以避免泄露模型身份
      if (!state._blindMode) {
        const span = document.createElement('span');
        span.className = 'response-metrics';
        const parts = [];
        if (imgD.model) parts.push(imgD.model.split('/').pop());
        if (imgD.size) parts.push(imgD.size);
        if (imgD.quality) parts.push(imgD.quality);
        if (metrics && metrics.response_time) parts.push(metrics.response_time + 's');
        const costFn = window.chatModule && window.chatModule.getImageCost;
        if (costFn) {
          const cost = costFn(imgD.model, imgD.quality, imgD.size);
          if (cost !== null) parts.push('$' + (cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)));
        }
        span.textContent = parts.join(' \u00b7 ');
        footer.appendChild(span);
      }
      aiMsgEl.appendChild(footer);
    } else if (metrics && aiMsgEl) {
      const footer = document.createElement('div');
      footer.className = 'msg-footer';
      const span = document.createElement('span');
      span.className = 'response-metrics';
      let text = metrics.output_tokens + ' tokens | ' + metrics.tokens_per_second + ' tok/s';
      // 添加每次请求的成本和每千次成本
      const _model = metrics.model || (state._selectedModels[paneIdx] && state._selectedModels[paneIdx].model) || '';
      const _cost = getModelCost(_model, metrics.input_tokens || 0, metrics.output_tokens || 0);
      // 构建带有可选成本和上下文的指标 span
      span.textContent = text;
      if (_cost !== null) {
        const _cost1k = _cost * 1000;
        const costSpan = document.createElement('span');
        costSpan.style.color = 'var(--color-success, #4caf50)';
        costSpan.title = t('compare.cost_estimate_title');
        costSpan.textContent = ' | $' + (_cost1k < 1 ? _cost1k.toFixed(2) : _cost1k.toFixed(0)) + '/1k';
        span.appendChild(costSpan);
      }
      if (metrics.context_percent > 0) {
        const ctx = document.createElement('span');
        ctx.textContent = ' | ' + metrics.context_percent + '% ctx';
        if (metrics.context_percent >= 85) ctx.style.color = 'var(--color-error)';
        else if (metrics.context_percent >= 70) ctx.style.color = '#ff9900';
        span.appendChild(ctx);
      }
      footer.appendChild(span);
      aiMsgEl.appendChild(footer);
    }
    if (hist) hist.scrollTop = hist.scrollHeight;

  } catch (error) {
    if (error.name === 'AbortError') {
      if (timedOut) {
        if (accumulated.trim()) {
          if (markdownModule) {
            aiBody.innerHTML = markdownModule.processWithThinking(
              markdownModule.squashOutsideCode(accumulated));
          }
        }
        const notice = document.createElement('div');
        notice.style.cssText = 'color:#ff9800;font-size:0.8em;margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        const text = document.createElement('span');
        text.style.fontStyle = 'italic';
        text.textContent = 'Timed out after ' + effectiveTimeout + 's' + (accumulated.trim() ? ' \u2014 response may be incomplete' : '');
        notice.appendChild(text);
        const retryBtn = document.createElement('button');
        retryBtn.textContent = t('compare.retry', { seconds: effectiveTimeout });
        retryBtn.style.cssText = 'background:rgba(255,152,0,0.15);border:1px solid #ff9800;color:#ff9800;border-radius:4px;cursor:pointer;padding:2px 8px;font-size:0.9em;white-space:nowrap;transition:all 0.15s;';
        retryBtn.addEventListener('mouseenter', () => { retryBtn.style.background = 'rgba(255,152,0,0.3)'; });
        retryBtn.addEventListener('mouseleave', () => { retryBtn.style.background = 'rgba(255,152,0,0.15)'; });
        retryBtn.addEventListener('click', () => { if (_rerollPane) _rerollPane(paneIdx, effectiveTimeout * 2); });
        notice.appendChild(retryBtn);
        aiBody.appendChild(notice);
      } else {
        if (!accumulated.trim()) aiBody.innerHTML = '<div style="color:#f0ad4e;font-size:0.9em;">Cancelled.</div>';
      }
    } else {
      console.error('Compare stream error:', error);
      aiBody.innerHTML = '<span style="color:var(--color-error);">Error: ' + escapeHtml(error.message) + '</span>';
    }
  } finally {
    clearTimeout(timeoutId);
    _timerDone = true;
    cancelAnimationFrame(_rafId);
    // 显示最终时间和 TTFT
    const _totalMs = performance.now() - _timerStart;
    if (_timerEl) {
      // 按用户要求从标题栏中移除 TTFT — 只显示总时间。
      _timerEl.textContent = _formatMs(_totalMs);
    }
    state._abortControllers[paneIdx] = null;
    // 隐藏停止按钮，显示响应操作按钮
    const _paneElFinal = document.querySelector(`.compare-pane[data-pane="${paneIdx}"]`);
    if (_paneElFinal) {
      const _stopBtnFinal = _paneElFinal.querySelector('.pane-stop-btn');
      if (_stopBtnFinal) _stopBtnFinal.style.display = 'none';
      if (accumulated.trim()) {
        _paneElFinal.querySelectorAll('.pane-needs-response').forEach(b => b.style.display = '');
      }
    }
    state._paneMetrics[paneIdx] = metrics;
    state._paneElapsed[paneIdx] = _totalMs;
    if (!opts.skipBadge) {
      if (streamOk) {
        state._finishOrder++;
        if (state._parallel) {
          // Parallel: all panes started at the same instant, so first
          // to finish is genuinely the fastest.
          if (state._finishOrder === 1) addFinishBadge(paneIdx);
        } else {
          // Sequential: panes run one after another, so "first to
          // finish" is meaningless (it's just whoever ran first).
          // Wait until all panes are done, then badge whichever had
          // the lowest measured per-pane elapsed time.
          const total = state._selectedModels.length;
          const finished = state._paneElapsed.filter(v => typeof v === 'number').length;
          if (finished >= total) {
            let winnerIdx = -1, winnerMs = Infinity;
            for (let i = 0; i < total; i++) {
              const v = state._paneElapsed[i];
              if (typeof v === 'number' && v < winnerMs) { winnerMs = v; winnerIdx = i; }
            }
            if (winnerIdx >= 0) addFinishBadge(winnerIdx);
          }
        }
      } else {
        // 超时或出错 — 显示失败徽章
        const badge = document.getElementById('cmp-badge-' + paneIdx);
        if (badge) { badge.textContent = timedOut ? 'Timeout' : 'Failed'; badge.style.color = 'var(--color-error)'; }
      }
    }
    // 根据期望答案自动评分 — 在窗格标题上标记 ✓ 或 ✗。
    if (streamOk && state._expectedAnswer) {
      _stampGradeBadge(paneIdx, accumulated, state._expectedAnswer);
    }
    // 现在显示复制/重新运行按钮（因为响应已存在）
    const paneEl = document.querySelector('.compare-pane:nth-child(' + (paneIdx + 1) + ')');
    if (paneEl) paneEl.querySelectorAll('.pane-needs-response').forEach(b => b.style.display = '');
  }
}

/**
 * 根据评测提示的期望答案自动评分窗格响应。
 * 启发式方法：小写子串匹配，加上数字提取回退，
 * 使得"答案是 882"可以匹配期望的"882"。
 * 跳过元答案，如"请自行统计单词数……"。
 */
function _stampGradeBadge(paneIdx, response, expected) {
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const r = norm(response);
  const e = norm(expected);
  if (!r || !e) return;
  // 跳过不可检查的指示
  if (e.includes('yourself') || e.includes('verify') || e.length > 120) return;

  let pass = r.includes(e);
  if (!pass) {
    // 数字回退 — 在期望值中找到第一个数字，在响应中独立查找
    const m = expected.match(/-?\d[\d,]*(?:\.\d+)?/);
    if (m) {
      const n = m[0].replace(/,/g, '');
      const re = new RegExp('(?<![\\d.])' + n.replace('.', '\\.') + '(?![\\d.])');
      pass = re.test(response);
    }
  }

  const paneEl = document.querySelector(`.compare-pane[data-pane="${paneIdx}"]`);
  if (!paneEl) return;
  const header = paneEl.querySelector('.pane-header');
  if (!header) return;
  // 移除任何先前的评分徽章（重新运行的情况）
  const prev = header.querySelector('.pane-grade-badge');
  if (prev) prev.remove();
  const badge = document.createElement('span');
  badge.className = 'pane-grade-badge ' + (pass ? 'pass' : 'fail');
  badge.title = pass ? 'Response contains the expected answer' : 'Expected answer not found in response';
  badge.textContent = pass ? '✓' : '✗';
  // 插入到完成徽章之前（如果存在），否则在标题之后
  const finBadge = header.querySelector('.pane-finish-badge');
  if (finBadge) header.insertBefore(badge, finBadge);
  else header.appendChild(badge);
}

export { streamToPane, _renderSearchResults, _runSynthForPane, _formatMs, registerStreamActions };
