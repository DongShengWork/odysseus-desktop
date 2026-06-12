// static/js/chat.js

/**
 * 主聊天功能 - 消息处理和流式传输
 */
// ES6 模块 — 已移除 IIFE

import Storage from './storage.js';
import uiModule from './ui.js';
import sessionModule from './sessions.js';
import chatRenderer from './chatRenderer.js';
import chatStream from './chatStream.js';
import { addAITTSButton } from './tts-ai.js';
import markdownModule from './markdown.js';
import { svgifyEmoji } from './markdown.js';
import spinnerModule from './spinner.js';
import presetsModule from './presets.js';
import fileHandlerModule from './fileHandler.js';
import searchModule from './search.js';
import documentModule from './document.js';
import * as emailInbox from './emailInbox.js';
import codeRunnerModule from './codeRunner.js';
import slashCommands, { initSlashCommands, isCommand, handleSlashCommand, handleSetupInput, handleSetupWizard, typewriterInto } from './slashCommands.js';
import createResearchSynapse from './researchSynapse.js';
import { createStreamRenderer } from './streamingRenderer.js';
import { wireArrowUpRecall, getLastUserMessageFromChatHistory } from './composerArrowUpRecall.js';
import { t } from './i18n.js';

  const RESEARCH_TIMEOUT_MS = 360000;
  const DEFAULT_TIMEOUT_MS = 120000;
  const RESEARCH_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>';

  let API_BASE = '';
  let currentAbort = null;
  let isStreaming = false;
  // 持续停滞看门狗：在流式传输期间，如果 SSE 流在 STALL_THRESHOLD_MS 内无任何输出
  // （无增量文本、无工具心跳——工具每2秒跳动一次，因此整整一分钟的静默意味着它确实卡住了
  // 或模型悄悄停止了），则显示一个非破坏性的"还在运行吗？"提示，
  // 而不是静默挂起。替代了之前仅依赖标签页重新获得焦点时的恢复机制
  // （该机制仅在 visibilitychange 事件触发时执行，并且会静默重新加载）。
  let _stallWatchdog = null;
  let _stallBannerShown = false;
  const STALL_THRESHOLD_MS = 60000;
  let _sendInFlight = false;   // 覆盖从点击到流式传输开始的窗口期
  let _displayOverride = null; // 覆盖可见的用户消息气泡文本（隐藏注入的提示）
  let _hideUserBubble = false; // 完全跳过用户气泡（例如：停止后继续）
  let _pendingContinue = null; // 存储已停止的 AI 元素，用于与新响应合并
  // ── 自动恢复：当某一轮对话的流式传输静默断开（连接丢失）或
  // 在连接保持的情况下无声时，通过完成握手重新连接模型
  // 而不是让它一直挂起。设有上限以防止循环。
  let _autoNudges = 0;             // 当前用户轮次触发的握手次数
  let _autoContinuePending = false; // 标记下一次提交为自动继续（不重置计数器）
  const _AUTO_NUDGE_CAP = 3;

  // shortModel 和 modelColor 现在在 chatRenderer.js 中
  var _shortModel = chatRenderer.shortModel;
  var _modelRouteLabel = chatRenderer.modelRouteLabel;
  var _sameModelName = chatRenderer.sameModelName;
  var _applyModelColor = chatRenderer.applyModelColor;
  function _setRoleModelLabel(roleEl, requestedModel, actualModel, opts) {
    if (!roleEl) return;
    opts = opts || {};
    const tsSpan = roleEl.querySelector('.role-timestamp');
    const req = requestedModel || actualModel || '';
    const actual = actualModel || requestedModel || '';
    let label = _modelRouteLabel(req, actual);
    if (opts.suffix) label += ' (' + opts.suffix + ')';
    if (opts.characterName) label = opts.characterName;
    roleEl.textContent = label + ' ';
    _applyModelColor(roleEl, actual || req);
    if (req && actual && !_sameModelName(req, actual)) {
      roleEl.title = req + ' -> ' + actual + (opts.reason ? ': ' + opts.reason : '');
    } else if (!opts.reason) {
      roleEl.removeAttribute('title');
    }
    if (tsSpan) roleEl.appendChild(tsSpan);
  }
  // 每个会话的研究跟踪（支持跨会话并发研究）
  const _researchingStreamIds = new Set();
  let _researchTimerEl = null, _researchTimerInterval = null;
  let _researchStartTime = 0, _researchAvgDuration = null;
  let _researchSynapse = null;
  function _clearResearchTimer() {
    if (_researchTimerInterval) { clearInterval(_researchTimerInterval); _researchTimerInterval = null; }
    if (_researchTimerEl) { _researchTimerEl.remove(); _researchTimerEl = null; }
    if (_researchSynapse) {
      // 先标记为完成，让用户短暂看到"已完成"状态，
      // 然后在下一个时钟周期销毁它。
      try { _researchSynapse.complete(); } catch {}
      const s = _researchSynapse;
      _researchSynapse = null;
      setTimeout(() => { try { s.destroy(); } catch {} }, 800);
    }
    _researchStartTime = 0;
    _researchAvgDuration = null;
  }

  /** 追加"生成可视化报告"按钮 — 委托给 chatRenderer。 */
  function _appendViewReportLink(msgEl, sessionId) {
    const body = msgEl.querySelector('.body');
    if (body) chatRenderer.appendReportButton(body, sessionId);
  }
  let currentAccumulated = ''; // 跨函数作用域跟踪累积的文本
  let currentHolder = null; // 跟踪当前消息容器
  let currentSpinner = null; // 跟踪当前旋转加载图标，用于停止时清理

  // 后台流式传输支持
  const _backgroundStreams = new Map(); // sessionId -> { status, accumulated, sourcesHtml, abortCtrl, query, metrics }
  const _resumingStreams = new Set();   // sessionId -> 一个 resumeStream() 读取器正在运行（重新附加锁）
  let _streamSessionId = null; // 当前活动读取循环的会话 ID
  let _lastReaderActivity = 0; // 上次 reader.read() 成功的时间戳 — 用于检测冻结的流
  let _webLockRelease = null;  // 释放流式传输期间持有的 Web Lock 的函数

  /** 检查某个会话的 SSE 读取器是否仍然处于活动连接状态。 */
  function hasActiveStream(sessionId) {
    return _streamSessionId === sessionId || _backgroundStreams.has(sessionId) ||
           _resumingStreams.has(sessionId);
  }

  // Sources box builder 和 toggleSources 现在在 chatRenderer.js 中
  var _buildSourcesBox = chatRenderer.buildSourcesBox;

  // 浏览器通知现在在 chatStream.js 中
  var _notifyResearchComplete = chatStream.notifyResearchComplete;

  // 模型/图片定价、_buildImageBubble 现在在 chatRenderer.js 中
  var _buildImageBubble = chatRenderer.buildImageBubble;
  var getModelCost = chatRenderer.getModelCost;
  var getImageCost = chatRenderer.getImageCost;

  // stripToolBlocks 和 roleTimestamp 现在在 chatRenderer.js 中
  var stripToolBlocks = chatRenderer.stripToolBlocks;

  function _normalizeEndpointForCompare(url) {
    if (!url) return '';
    try {
      const u = new URL(String(url), window.location.origin);
      let path = u.pathname.replace(/\/+$/, '');
      const suffixes = [
        '/v1/chat/completions', '/chat/completions',
        '/v1/completions', '/completions',
        '/v1/messages', '/messages',
        '/v1/models', '/models',
      ];
      for (const suffix of suffixes) {
        if (path.toLowerCase().endsWith(suffix)) {
          path = path.slice(0, -suffix.length).replace(/\/+$/, '');
          break;
        }
      }
      return (u.origin + path).toLowerCase();
    } catch (_) {
      return String(url).trim().replace(/\/+$/, '').toLowerCase();
    }
  }

  async function _probeCurrentEndpointStatus(endpointUrl, signal) {
    const target = _normalizeEndpointForCompare(endpointUrl);
    if (!target) return null;
    const modelsRes = await fetch(`${API_BASE}/api/models`, { credentials: 'same-origin', signal });
    if (!modelsRes.ok) return null;
    const modelsData = await modelsRes.json().catch(() => ({}));
    const item = (modelsData.items || []).find(ep =>
      _normalizeEndpointForCompare(ep.url || ep.endpoint_url || ep.base_url) === target
    );
    if (!item || !item.endpoint_id) return null;

    const probesRes = await fetch(`${API_BASE}/api/model-endpoints/probe-local`, {
      credentials: 'same-origin',
      signal,
    });
    if (!probesRes.ok) return null;
    const probes = await probesRes.json().catch(() => ({}));
    return probes[item.endpoint_id] || null;
  }

  /**
   * 使用依赖项初始化
   */
  export function init(apiBase) {
    API_BASE = apiBase;
    initSlashCommands({ apiBase, isStreaming: () => isStreaming });
    // 初始化邮件收件箱
    emailInbox.init(documentModule);
    // 在聊天输入框上挂载斜杠命令自动补全弹窗。
    // 调度器已经处理了已输入的命令 — 这里只是在用户以 / 开头输入消息时
    // 将命令注册表呈现为可发现的菜单。
    import('./slashAutocomplete.js').then(mod => {
      const ta = document.getElementById('message');
      if (ta && mod.initSlashAutocomplete) mod.initSlashAutocomplete(ta);
    }).catch(() => {});

    // 在空输入框中按上箭头可召回上一条用户消息（类似许多聊天应用）。
    const _wireArrowUpRecall = (composer) =>
      wireArrowUpRecall(composer, () => getLastUserMessageFromChatHistory(), {
        autoResize: uiModule?.autoResize,
      });

    const composer = document.getElementById('message');
    if (!_wireArrowUpRecall(composer)) {
      // init 可能在 #message 元素存在之前运行（模板化 UI）；仅进行简短重试。
      try { requestAnimationFrame(() => _wireArrowUpRecall(document.getElementById('message'))); } catch (_) {}
      setTimeout(() => _wireArrowUpRecall(document.getElementById('message')), 250);
    }
  }

  // addMessage、createMsgFooter、displayMetrics、hideWelcomeScreen、showWelcomeScreen
  // 现在在 chatRenderer.js 中 — 通过上述公共 API 委托引用。
  var addMessage = chatRenderer.addMessage;
  var createMsgFooter = chatRenderer.createMsgFooter;
  var displayMetrics = chatRenderer.displayMetrics;
  var hideWelcomeScreen = chatRenderer.hideWelcomeScreen;
  var showWelcomeScreen = chatRenderer.showWelcomeScreen;

  /**
   * 更新发送按钮状态
   */
  function updateSubmitButton(state, submitBtn) {
    if (!submitBtn) return;

    if (state === 'streaming') {
      // 清除所有待处理的 + → 箭头切换过渡动画
      submitBtn.classList.remove('anim-spin', 'anim-spin-swap', 'anim-land', 'mic-mode', 'newchat-mode', 'newchat-expanded', 'recording');
      // 确保在发射动画前箭头图标已显示
      var icons = window._odysseusBtnIcons;
      if (icons) submitBtn.innerHTML = icons.send;
      void submitBtn.offsetWidth;
      // 箭头向上飞出，然后停止图标降落入位
      submitBtn.classList.add('anim-launch');
      const _stopSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
      // 等待发射关键帧完成（0.3秒）后再将箭头
      // 换为停止图标 — 否则交换发生在飞行中途
      // 用户看不到任何飞出效果。
      setTimeout(() => {
        submitBtn.innerHTML = _stopSvg;
        submitBtn.classList.remove('anim-launch');
        void submitBtn.offsetWidth;
        submitBtn.classList.add('anim-land');
        submitBtn.addEventListener('animationend', () => submitBtn.classList.remove('anim-land'), { once: true });
      }, 300);
      submitBtn.title = t('chat.stop_generation');
      submitBtn.dataset.mode = 'streaming';
      submitBtn.dataset.phase = 'processing';
      isStreaming = true;
      _startStallWatchdog();
    } else if (state === 'idle') {
      submitBtn.dataset.mode = '';
      delete submitBtn.dataset.phase;
      submitBtn.classList.remove('recording');
      isStreaming = false;
      _stopStallWatchdog();
      // 延迟到全局更新器，由它处理麦克风/新对话/发送模式
      if (window._updateSendBtnIcon) {
        setTimeout(window._updateSendBtnIcon, 50);
      } else {
        var icons = window._odysseusBtnIcons;
        submitBtn.innerHTML = icons ? icons.send : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
        submitBtn.title = t('chat.send_button');
        submitBtn.classList.remove('mic-mode', 'newchat-mode');
      }
    }
  }

  // -----------------------------------------------------------------------
  // 斜杠命令 — 现在在 slashCommands.js 中
  // -----------------------------------------------------------------------

  // handleChatSubmit 守卫的 API 密钥匹配模式
  const API_KEY_RE = /^(sk-[a-zA-Z0-9_\-]{20,}|gsk_[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_\-]{30,}|xai-[a-zA-Z0-9]{20,})$/;


  /**
   * 处理聊天表单提交
   */
  export async function handleChatSubmit(e) {
    e.preventDefault();
    // 如果有激活的研究澄清超时计时器，则取消它
    if (window._researchTimeoutTimer) {
      clearTimeout(window._researchTimeoutTimer);
      window._researchTimeoutTimer = null;
    }
    // 获取当前会话
    const sessionId = sessionModule.getCurrentSessionId();
    const session = sessionModule.getSessions().find(s => s.id === sessionId);
    
    const submitBtn = document.querySelector('.send-btn');
    
    // 如果对比模式是激活的，停止所有对比流
    if (window.compareModule && window.compareModule.isActive()) {
      window.compareModule.handleCompareSubmit();
      return;
    }

    // 如果正在流式传输中，则停止
    if (isStreaming) {
      // 如果研究正在进行中，取消服务端研究
      const _cancelSid = sessionModule.getCurrentSessionId();
      if (_cancelSid && _researchingStreamIds.has(_cancelSid)) {
        fetch(`${API_BASE}/api/research/cancel/${_cancelSid}`, { method: 'POST' }).catch(e => console.warn('Research cancel failed:', e));
        _researchingStreamIds.delete(_cancelSid);
        _clearResearchTimer();
      }
      abortCurrentRequest(true);  // 用户显式点击停止 → 同时取消已分离的服务端运行

      // 清理所有正在运行的代理线程节点（停止波浪动画，移除"running"状态）
      document.querySelectorAll('.agent-thread-node.running').forEach(node => {
        if (node._waveInterval) { clearInterval(node._waveInterval); node._waveInterval = null; }
        if (node._elapsedTicker) { clearInterval(node._elapsedTicker); node._elapsedTicker = null; }
        node.classList.remove('running');
        const wave = node.querySelector('.agent-thread-wave');
        if (wave) wave.textContent = '';
        const icon = node.querySelector('.agent-thread-icon');
        if (icon) icon.textContent = '\u25A0'; // 停止方块图标
        const statusEl = node.querySelector('.agent-thread-status');
        if (!statusEl) {
          const header = node.querySelector('.agent-thread-header');
          if (header) {
            const s = document.createElement('span');
            s.className = 'agent-thread-status';
            s.textContent = 'stopped';
            header.appendChild(s);
          }
        }
      });
      document.querySelectorAll('.agent-thread.streaming').forEach(t => t.classList.remove('streaming'));

      // 清理所有思考加载动画
      document.querySelectorAll('.agent-thinking-dots').forEach(el => {
        if (el._spinner) el._spinner.destroy();
        el.remove();
      });
      // 没有累积文字 — 移除带加载动画的空容器
      if (currentHolder && !currentAccumulated) {
        if (currentSpinner) { currentSpinner.destroy(); currentSpinner = null; }
        // 空白取消 — 保留带有"用户已取消"
        // 指示器的助手气泡，并在服务端持久化一个占位记录，
        // 确保刷新后对话轮次不会无声消失。
        _renderCancelledBubble(currentHolder);
        currentHolder = null;
        updateSubmitButton('idle', submitBtn);
        const messageInput = uiModule.el('message');
        if (messageInput) messageInput.disabled = false;
        currentAccumulated = '';
        return;
      }
      // 渲染目前已累积的内容
      if (currentHolder && currentAccumulated) {
        // 在变量被清除前将累积内容存入闭包变量
        const stoppedContent = currentAccumulated;
        
        // 将原始内容存入 dataset 以与其他消息保持一致
        currentHolder.dataset.raw = stoppedContent;
        
        currentHolder.querySelector('.body').innerHTML = markdownModule.processWithThinking(
          markdownModule.squashOutsideCode(stoppedContent)
        );
        
        // 高亮代码块
        if (window.hljs) {
          currentHolder.querySelectorAll('pre code').forEach((block) => {
            window.hljs.highlightElement(block);
          });
        }
        
        // 添加带继续按钮的已停止指示器
        const stoppedIndicator = document.createElement('div');
        stoppedIndicator.className = 'stopped-indicator';
        const stoppedLabel = document.createElement('span');
        stoppedLabel.textContent = t('chat.message_interrupted');
        stoppedIndicator.appendChild(stoppedLabel);
        const continueBtn = document.createElement('button');
        continueBtn.className = 'continue-btn';
        continueBtn.title = t('chat.continue');
        continueBtn.textContent = '\u25B8';
        const _stoppedHolder = currentHolder; // 在变量被清除前捕获
        continueBtn.addEventListener('click', () => {
          stoppedIndicator.remove();
          _hideUserBubble = true;
          _pendingContinue = _stoppedHolder;
          const cutoff = stoppedContent;
          const msgInput = uiModule.el('message');
          if (msgInput) {
            msgInput.value = 'Your previous response was interrupted. It ended with:\n\n' + cutoff.slice(-500) + '\n\nDo NOT repeat what you already said. Continue exactly from where you were cut off.';
            const sb = document.querySelector('.send-btn');
            if (sb) sb.click();
          }
        });
        stoppedIndicator.appendChild(continueBtn);
        currentHolder.querySelector('.body').appendChild(stoppedIndicator);

        // 告知服务端将此消息标记为已停止
        const _sid = sessionModule.getCurrentSessionId();
        if (_sid) fetch(`${API_BASE}/api/session/${_sid}/mark-stopped`, { method: 'POST' }).catch(e => console.warn('mark-stopped failed:', e));

        // 如果页脚尚未存在，则添加带复制/重新生成按钮的页脚
        if (!currentHolder.querySelector('.msg-footer')) {
          currentHolder.dataset.raw = stoppedContent;
          currentHolder.appendChild(createMsgFooter(currentHolder));
        }

        uiModule.scrollHistory();
      }
      
      // 重置按钮状态
      updateSubmitButton('idle', submitBtn);
      
      // 重新启用消息输入框
      const messageInput = uiModule.el('message');
      if (messageInput) messageInput.disabled = false;
      
      // 清除跟踪变量
      currentAccumulated = '';
      currentHolder = null;

      return;
    }

    // --- 发送路径入口：阻止提交后到流开始前的重复点击 ---
    if (_sendInFlight) return;
    _sendInFlight = true;
    // 即时视觉反馈，让用户在下方流式按钮状态生效前
    // 就能看到点击已被接受。
    const _earlyMessageInput = uiModule.el('message');
    if (_earlyMessageInput) _earlyMessageInput.disabled = true;
    if (submitBtn) submitBtn.classList.add('send-pending');
    const _releaseSendFlag = () => {
      _sendInFlight = false;
      if (_earlyMessageInput) _earlyMessageInput.disabled = false;
      if (submitBtn) submitBtn.classList.remove('send-pending');
    };

    // --- 设置模式：拦截下一条消息（但放行斜杠命令） ---
    {
      const el = uiModule.el;
      const rawMsg = (el('message').value || '').trim();
      const currentSetupMode = slashCommands.getSetupMode();
      if (currentSetupMode && rawMsg && !isCommand(rawMsg)) {
        const mode = currentSetupMode;
        slashCommands.clearSetupMode(mode === 'endpoint-provider' || mode === 'endpoint-key-for-provider');
        el('message').value = '';
        if (window._syncModelPickerAutohide) window._syncModelPickerAutohide();
        if (uiModule.autoResize) uiModule.autoResize(el('message'));
        if (mode === true || mode === 'endpoint') {
          handleSetupInput(rawMsg);
        } else {
          handleSetupWizard(mode, rawMsg);
        }
        _releaseSendFlag();
        return;
      }
      if (currentSetupMode && rawMsg && isCommand(rawMsg)) {
        slashCommands.clearSetupMode();  // 清除设置模式，落入斜杠命令处理器
      }
    }

    const el = uiModule.el;
    const msg = el('message').value;
    // 允许空文本：当重新生成携带了原始消息的附件 ID 时
    // 纯图片消息仍有内容可发送。
    if (!msg.trim() && !fileHandlerModule.getPendingCount() && !(_pendingRegenAttachments && _pendingRegenAttachments.length)) { _releaseSendFlag(); return; }

    // --- 斜杠命令：直接执行，无需 AI（不需要会话） ---
    if (isCommand(msg.trim())) {
      const handled = await handleSlashCommand(msg.trim());
      if (handled) {
        el('message').value = '';
        if (window._syncModelPickerAutohide) window._syncModelPickerAutohide();
        if (uiModule.autoResize) uiModule.autoResize(el('message'));
        _releaseSendFlag();
        return;
      }
    }

    // 在首条消息时将待创建的会话实体化（从模型点击延迟的）
    if (sessionModule.hasPendingChat && sessionModule.hasPendingChat()) {
      const ok = await sessionModule.materializePendingSession();
      if (!ok || !sessionModule.getCurrentSessionId()) { _releaseSendFlag(); return; }
    }

    if (!sessionModule.getCurrentSessionId()) {
      // 使用默认聊天配置自动创建会话。始终获取最新配置，
      // 以便最近的设置更改无需刷新页面即可生效。
      try {
        let dc = null;
        try {
          const dcRes = await fetch('/api/default-chat');
          dc = await dcRes.json();
          if (dc && dc.endpoint_url && dc.model) {
            try { window.__odysseusDefaultChat = dc; } catch (_) {}
          }
        } catch (_) {
          dc = (typeof window !== 'undefined' && window.__odysseusDefaultChat) || null;
        }
        if (dc.endpoint_url && dc.model) {
          await sessionModule.createDirectChat(dc.endpoint_url, dc.model, dc.endpoint_id);
          const ok = await sessionModule.materializePendingSession();
          if (!ok || !sessionModule.getCurrentSessionId()) { _releaseSendFlag(); return; }
        } else {
          el('message').value = '';
          if (uiModule.autoResize) uiModule.autoResize(el('message'));
          addMessage('assistant',
            'No chat session active. You can:\n\n' +
            '- Open the model picker in the chat box and pick a model\n' +
            '- Use the `+` button in the model picker to add a model endpoint\n' +
            '- Use `/help` to see all available commands');
          _releaseSendFlag();
          return;
        }
      } catch (e) {
        el('message').value = '';
        if (uiModule.autoResize) uiModule.autoResize(el('message'));
        addMessage('assistant', t('chat.no_chat_session'));
        _releaseSendFlag();
        return;
      }
    }

    // --- API 密钥守卫：如果消息看起来像 API 密钥则发出警告 ---
    if (API_KEY_RE.test(msg.trim())) {
      if (!await window.styledConfirm(t('chat.api_key_warning'), { confirmText: t('chat.send_anyway'), danger: true })) {
        _releaseSendFlag();
        return;
      }
    }


    const messageInput = el('message');
    const originalBtnText = submitBtn ? submitBtn.innerHTML : '';

    // 将文本区重新启用，因为我们已经将工作交接给了流：
    // 用户想在 AI 还在说话时就编辑下一条消息。
    // `isStreaming` 标志是发送按钮的重复点击守卫。
    if (messageInput) messageInput.disabled = false;
    updateSubmitButton('streaming', submitBtn);
    if (submitBtn) submitBtn.classList.remove('send-pending');
    _sendInFlight = false;

    // 捕获会话 ID 用于后台流检测
    const streamSessionId = sessionModule.getCurrentSessionId();
    _streamSessionId = streamSessionId;
    const streamQuery = msg;
    _lastReaderActivity = Date.now();

    // 获取 Web Lock 以提示浏览器在流式传输期间不要丢弃此标签页
    if (navigator.locks) {
      navigator.locks.request('odysseus-stream-' + streamSessionId, { mode: 'exclusive', ifAvailable: true }, lock => {
        if (!lock) return; // 另一个流已持有锁 — 没问题
        return new Promise(resolve => { _webLockRelease = resolve; });
      }).catch(e => console.warn('web lock acquire failed:', e)); // 忽略锁错误 — 尽力而为
    }

    // 在 try 块外部声明累积变量，以便在 catch 中也能访问
    let accumulated = '';
    // 当前是否在未关闭的 <think> 块内？按思考/回答周期切换，
    // 使多轮代理响应（每轮一个推理阶段）将每轮的推理包裹在
    // 各自的 <think>…</think> 中，避免第 2+ 轮推理泄漏为纯文本。
    let _thinkOpen = false;
    let holder = null;
    let finalMeta = null;
    let spinner = null;
    let timedOut = false;
    let processingProbeTimer = null;
    let processingProbeAbort = null;
    let _renderStream = () => {};
    let _cancelThinkingTimer = () => {};
    let _removeThinkingSpinner = () => {};
    let timeoutId = null;
    let responseTimeoutCleared = false;
    let clearResponseTimeout = () => {};
    const clearProcessingProbe = () => {
      if (processingProbeTimer) {
        clearTimeout(processingProbeTimer);
        processingProbeTimer = null;
      }
      if (processingProbeAbort) {
        try { processingProbeAbort.abort(); } catch (_) {}
        processingProbeAbort = null;
      }
    };

    // 开始时重置跟踪变量
    currentAccumulated = '';
    currentHolder = null;
    
    try {
      // 用户发送消息时重新启用自动滚动
      uiModule.setAutoScroll(true);
      uiModule.scrollHistoryInstant();
      // 用户正在交互，清除已完成标记点
      if (sessionModule.clearStreamComplete) sessionModule.clearStreamComplete(sessionModule.getCurrentSessionId());

      // 在消费显示覆盖前检查文档选择上下文
      const docSel = documentModule && documentModule.getSelectionContext();
      if (docSel) {
        const sels = Array.isArray(docSel) ? docSel : [docSel];
        const lineRefs = sels.map(s =>
          s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}-${s.endLine}`
        );
        _displayOverride = `[Doc edit: ${lineRefs.join(', ')}] ${msg}`;
      }

      const userDisplay = _displayOverride || msg;
      _displayOverride = null;
      const skipBubble = _hideUserBubble;
      _hideUserBubble = false;
      // 自动恢复计数器：在同一轮对话的自动继续中保持，但
      // 当用户真正发送新消息时重置（以便每个任务获得新的配额）。
      // 真实的用户轮次（可见气泡）始终重置配额 — 即使之前
      // 自动继续的延迟点击从未清除待处理标志 — 这样
      // 卡住的标志不会悄无声息地消耗下一轮的恢复配额。
      if (!skipBubble) { _autoNudges = 0; _autoContinuePending = false; }
      else if (_autoContinuePending) { _autoContinuePending = false; }
      const _pendingAttachInfo = fileHandlerModule.getPendingCount() ? fileHandlerModule.getPendingInfo() : null;
      // 在上传清除待处理文件之前预读取可导入的文件内容
      const IMPORTABLE_EXT = /\.(txt|py|js|ts|html|htm|css|md|json|csv|yml|yaml|sh|sql|rs|go|java|c|cpp|h|rb|php|xml|jsx|tsx|log|toml|ini|conf|env|vue|svelte|scss|sass|less)$/i;
      const _importableFiles = [];
      if (_pendingAttachInfo && documentModule) {
        const rawFiles = fileHandlerModule.getPendingRaw ? fileHandlerModule.getPendingRaw() : [];
        for (let i = 0; i < _pendingAttachInfo.length; i++) {
          const att = _pendingAttachInfo[i];
          if (IMPORTABLE_EXT.test(att.name) && rawFiles[i]) {
            _importableFiles.push({ info: att, file: rawFiles[i] });
          }
        }
      }
      let _userMsgEl = null;
      if (!skipBubble) {
        _userMsgEl = addMessage('user', userDisplay, null, _pendingAttachInfo ? { attachments: _pendingAttachInfo } : null);
      }
      messageInput.value = '';
      messageInput.style.height = '';
      messageInput.dispatchEvent(new Event('input'));
      // 移动端：发送后关闭屏幕键盘。iOS 尤其会在某些情况下
      // 忽略单独的 blur()（或某些其他监听器紧接着重新聚焦），
      // 因此我们暂时将输入框标记为 readonly 来强制键盘收起，
      // 然后 blur，键盘消失后再移除 readonly 属性，
      // 以便下一条消息仍能正常输入。
      // 以便下一条消息仍能正常输入。
      if (window.innerWidth <= 768) {
        try {
          messageInput.setAttribute('readonly', 'readonly');
          messageInput.blur();
          const _dropReadonly = () => { try { messageInput.removeAttribute('readonly'); } catch {} };
          setTimeout(() => {
            // 如果 blur 生效了，输入框不再是有焦点的元素 —
            // 现在可以安全地移除 readonly，以便输入下一条消息。
            // 如果 blur 没有生效（某些移动浏览器在程序化 blur 后
            // 仍保持 textarea 聚焦），在这里移除 readonly 会在
            // 流式传输中重新唤出键盘 — 产生"弹起"效果，
            // 持续到流结束时 blur。这种情况下保持 readonly
            // （键盘保持隐藏），等用户点击输入时再移除，
            // 这样输入仍能正常工作但不会有弹起。
            if (document.activeElement === messageInput) {
              messageInput.addEventListener('pointerdown', _dropReadonly, { once: true });
              messageInput.addEventListener('focus', _dropReadonly, { once: true });
            } else {
              _dropReadonly();
            }
          }, 120);
        } catch {}
      }

      let ids = [];
      try {
        ids = await fileHandlerModule.uploadPending();
      } catch(e) {
        console.error('upload failed', e);
      }

      // 重新生成时携带原始消息的 file-ids，使新的发送仍
      // 引用相同的照片/文档（并通过服务端 .vision 缓存获取
      // 用户编辑的 OCR 文字）。始终消费该字段 —
      // 即使为空/出错 — 以防 regen ID 泄漏到
      // 无关的下一条消息（如果上面的 uploadPending() 抛出了异常）。
      if (_pendingRegenAttachments && _pendingRegenAttachments.length) {
        ids = ids.concat(_pendingRegenAttachments);
      }
      _pendingRegenAttachments = null;

      // 乐观的用户气泡在上传分配 ID 之前就已经渲染了，
      // 所以图片预览无法显示（渲染器需要 att.id）。现在
      // 上传完成后，打上 ID — 加上图片的宽度/高度，
      // 这样骨架屏能按照片宽高比调整尺寸 —
      // 重新渲染后缩略图实时出现，无需刷新。
      if (_userMsgEl && _pendingAttachInfo && ids.length) {
        const _meta = fileHandlerModule.getLastUploadedMeta?.() || [];
        for (let i = 0; i < _pendingAttachInfo.length && i < ids.length; i++) {
          _pendingAttachInfo[i].id = ids[i];
          const _m = _meta[i];
          if (_m) {
            if (_m.width)  _pendingAttachInfo[i].width  = _m.width;
            if (_m.height) _pendingAttachInfo[i].height = _m.height;
          }
        }
        chatRenderer.updateMessageAttachments(_userMsgEl, _pendingAttachInfo);
      }

      // 提供将文本文件导入文档库的选项
      if (_importableFiles.length > 0) {
        const existing = document.getElementById('import-prompt-banner');
        if (existing) existing.remove();
        const banner = document.createElement('div');
        banner.id = 'import-prompt-banner';
        banner.className = 'import-prompt-banner';
        const label = _importableFiles.length === 1
          ? `Import "${_importableFiles[0].info.name}" to document library?`
          : `Import ${_importableFiles.length} files to document library?`;
        const textEl = document.createElement('span');
        textEl.textContent = label;
        banner.appendChild(textEl);
        const importBtn = document.createElement('button');
        importBtn.textContent = t('common.import');
        importBtn.addEventListener('click', async () => {
          importBtn.disabled = true;
          importBtn.textContent = t('common.importing');
          const EXT_LANG = {'.py':'python','.js':'javascript','.ts':'typescript','.html':'html','.css':'css','.md':'markdown','.json':'json','.yml':'yaml','.yaml':'yaml','.sh':'bash','.sql':'sql','.rs':'rust','.go':'go','.java':'java','.c':'c','.cpp':'cpp','.rb':'ruby','.php':'php','.xml':'xml','.jsx':'javascript','.tsx':'typescript'};
          let imported = 0;
          for (const { info, file } of _importableFiles) {
            try {
              const content = await file.text();
              const dotIdx = info.name.lastIndexOf('.');
              const title = dotIdx > 0 ? info.name.slice(0, dotIdx) : info.name;
              const ext = dotIdx >= 0 ? info.name.slice(dotIdx).toLowerCase() : '';
              await fetch(`${API_BASE}/api/document`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, language: EXT_LANG[ext] || '', content }),
              });
              imported++;
            } catch (e) { console.error('Import failed:', info.name, e); }
          }
          banner.textContent = `Imported ${imported} file${imported !== 1 ? 's' : ''}`;
          setTimeout(() => banner.remove(), 2000);
        });
        banner.appendChild(importBtn);
        const dismissBtn = document.createElement('button');
        dismissBtn.textContent = '\u00d7';
        dismissBtn.className = 'import-prompt-dismiss';
        dismissBtn.addEventListener('click', () => banner.remove());
        banner.appendChild(dismissBtn);
        const chatBar = document.getElementById('chat-bar');
        if (chatBar) chatBar.parentNode.insertBefore(banner, chatBar);
        // 15 秒后自动关闭
        setTimeout(() => { if (banner.parentNode) banner.remove(); }, 15000);
      }

      // 发送前自动保存文档编辑器内容，确保 AI 看到最新文字
      if (documentModule && documentModule.isPanelOpen() && documentModule.getCurrentDocId()) {
        try { await documentModule.saveDocument(); } catch(e) { console.warn('doc auto-save failed', e); }
      }

      // 如果存在文档选择上下文，则注入它
      let finalMsg = msg;
      if (docSel) {
        const sels = Array.isArray(docSel) ? docSel : [docSel];
        if (sels.length === 1) {
          const s = sels[0];
          const lineRef = s.startLine === s.endLine ? `line ${s.startLine}` : `lines ${s.startLine}-${s.endLine}`;
          finalMsg = `In the document, edit this specific text (${lineRef}):\n\`\`\`\n${s.text}\n\`\`\`\n\nInstruction: ${msg}`;
        } else {
          const parts = sels.map((s, i) => {
            const lineRef = s.startLine === s.endLine ? `line ${s.startLine}` : `lines ${s.startLine}-${s.endLine}`;
            return `Selection ${i + 1} (${lineRef}):\n\`\`\`\n${s.text}\n\`\`\``;
          });
          finalMsg = `In the document, edit these specific sections:\n\n${parts.join('\n\n')}\n\nInstruction: ${msg}`;
        }
      }

      // 应用注入的前缀/后缀
      const _inject = presetsModule.getInject ? presetsModule.getInject() : { prefix: '', suffix: '' };
      let _finalMsgWithInject = finalMsg;
      if (_inject.prefix) _finalMsgWithInject = _inject.prefix + ' ' + _finalMsgWithInject;
      if (_inject.suffix) _finalMsgWithInject = _finalMsgWithInject + ' ' + _inject.suffix;

      const fd = new FormData();
      fd.append('message', _finalMsgWithInject);
      fd.append('session', streamSessionId);
      if (ids.length) fd.append('attachments', JSON.stringify(ids));
      // 自动保存并发送活动文档 ID，确保后端看到最新内容
      if (documentModule && documentModule.isPanelOpen() && documentModule.getCurrentDocId()) {
        try { await documentModule.saveDocument({ silent: true }); } catch (_e) { /* 尽力而为 */ }
        fd.append('active_doc_id', documentModule.getCurrentDocId());
      }
      // 网页开关：聊天模式下为预搜索，代理模式下为工具权限
      const toggleState = Storage.loadToggleState();
      let isAgentMode = (toggleState.mode || 'chat') === 'agent';
      // 打开文档时自动升级到代理模式 — 用户期望
      // AI 能看到文档并拥有编辑它的工具
      if (!isAgentMode && documentModule && documentModule.isPanelOpen() && documentModule.getCurrentDocId()) {
        isAgentMode = true;
      }
      fd.append('mode', isAgentMode ? 'agent' : 'chat');
      if (el('web-toggle').checked) {
        if (isAgentMode) {
          fd.append('allow_web_search', 'true');
        } else {
          fd.append('use_web', 'true');
        }
      }
      if (el('research-toggle').checked) {
        fd.append('use_research', 'true');
        // 研究始终在聊天模式下运行 — 如果设定了代理模式则覆盖
        fd.set('mode', 'chat');
      }
      if (el('bash-toggle').checked) {
        fd.append('allow_bash', 'true');
      }
      const ragChk = el('rag-toggle');
      if (ragChk && !ragChk.checked) {
        fd.append('use_rag', 'false');
      }
      const incognitoChk = el('incognito-toggle');
      if (incognitoChk && incognitoChk.checked) {
        fd.append('incognito', 'true');
      }
      if (presetsModule.getSelectedPreset()) {
        fd.append('preset_id', presetsModule.getSelectedPreset());
      }


      const abortCtrl = new AbortController();
      abortCtrl._reason = '';
      currentAbort = abortCtrl;

      const _tState = Storage.loadToggleState();
      const _isAgent = (_tState.mode || 'chat') === 'agent';

      // 超时时间：研究和代理模式为 6 分钟，其他为 3 分钟
      const timeoutMs = el('research-toggle').checked || _isAgent ? RESEARCH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
      timeoutId = setTimeout(() => {
        if (!abortCtrl.signal.aborted) {
          timedOut = true;
          abortCtrl._reason = 'timeout';
          try {
            if (streamSessionId) {
              fetch(`/api/chat/stop/${encodeURIComponent(streamSessionId)}`, {
                method: 'POST',
                credentials: 'same-origin',
              }).catch(() => {});
            }
          } catch (_) {}
          abortCtrl.abort();
        }
      }, timeoutMs);
      clearResponseTimeout = () => {
        if (responseTimeoutCleared) return;
        responseTimeoutCleared = true;
        clearTimeout(timeoutId);
      };
      
      const box = el('chat-history');
      holder = document.createElement('div');
      holder.className = 'msg msg-ai streaming';

      // 将容器全局跟踪，以便停止按钮可以访问它
      currentHolder = holder;
      holder._researchQuery = msg; // 存储查询文本用于通知
      
      const modelName = sessionModule.getCurrentModel() || null;

      let loadingText = 'Initializing...';

      if (el('web-toggle').checked && !_isAgent) {
        const _searchLabel = searchModule ? searchModule.getProviderLabel() : 'web';
        loadingText = `Searching via ${_searchLabel}...<br>
                       <span style="font-size: 0.9em; opacity: 0.8;">
                       Query: "${msg.substring(0, 50)}${msg.length > 50 ? '...' : ''}"<br>
                       Fetching top results...</span>`;
      } else if (el('research-toggle').checked) {
        loadingText = 'Deep research mode active...';
      } else {
        loadingText = 'Processing request...';
      }

      var roleLabel = _modelRouteLabel(modelName, modelName);
      var _charNameInit = presetsModule.getCharacterName ? presetsModule.getCharacterName() : '';
      if (_charNameInit) roleLabel = _charNameInit;
      const roleTs = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      holder.innerHTML = `<div class="role">${uiModule.esc(roleLabel)} <span class="role-timestamp">${roleTs}</span></div><div class="body"></div>`;
      holder._requestedModel = modelName;
      holder._actualModel = modelName;
      _applyModelColor(holder.querySelector('.role'), modelName);
      holder.style.position = 'relative';
      
      // 创建加载动画
      spinner = spinnerModule.create('Initializing', 'right', 'wave');
      currentSpinner = spinner;
      const bodyDiv = holder.querySelector('.body');
      bodyDiv.appendChild(spinner.createElement());
      spinner.start();
      
      // 根据模式更新加载动画的消息
      if (el('web-toggle').checked && !_isAgent) {
        spinner.updateMessage('Searching web with ' + (searchModule ? searchModule.getProviderLabel() : 'SearXNG'));
        setTimeout(() => spinner.updateMessage('Processing results'), 1500);
      } else if (el('research-toggle').checked) {
        spinner.updateMessage('Researching');
        setTimeout(() => spinner.updateMessage('Analyzing sources'), 1500);
      } else {
        spinner.updateMessage('Processing request');
        const endpointUrlForProbe = sessionModule.getCurrentEndpointUrl ? sessionModule.getCurrentEndpointUrl() : null;
        if (endpointUrlForProbe && modelName) {
          processingProbeTimer = setTimeout(async () => {
            processingProbeTimer = null;
            if (accumulated || !spinner || !spinner.element || (currentAbort && currentAbort.signal.aborted)) return;
            processingProbeAbort = new AbortController();
            try {
              spinner.updateMessage('Checking model endpoint');
              const status = await _probeCurrentEndpointStatus(endpointUrlForProbe, processingProbeAbort.signal);
              if (accumulated || !spinner || !spinner.element || (currentAbort && currentAbort.signal.aborted)) return;
              if (!status) {
                spinner.updateMessage('Still waiting for model');
              } else if (status.alive) {
                const latency = status.latency_ms ? ` (${status.latency_ms}ms)` : '';
                spinner.updateMessage(`Endpoint online${latency}; waiting for first token`);
              } else {
                // 探测确认端点无响应。不要
                // 在挂起的 fetch 上干等 — 给用户 5 秒阅读
                // 状态信息，然后以 reason='offline' 自动中止，
                // 这样 catch 处理器会显示清晰的"切换模型"消息，
                // 而不会让加载动画永远转下去。
                if (status.error) console.warn('Model endpoint probe failed:', status.error);
                let _countdown = 5;
                spinner.updateMessage(`Endpoint offline — cancelling in ${_countdown}s`);
                const _tick = setInterval(() => {
                  _countdown--;
                  if (!spinner || !spinner.element || (currentAbort && currentAbort.signal.aborted) || accumulated) {
                    clearInterval(_tick);
                    return;
                  }
                  if (_countdown > 0) {
                    spinner.updateMessage(`Endpoint offline — cancelling in ${_countdown}s`);
                  } else {
                    clearInterval(_tick);
                    if (currentAbort && !currentAbort.signal.aborted) {
                      currentAbort._reason = 'offline';
                      currentAbort.abort();
                    }
                  }
                }, 1000);
              }
            } catch (e) {
              if (e && e.name !== 'AbortError' && spinner && spinner.element && !accumulated) {
                spinner.updateMessage('Still waiting for model');
              }
            } finally {
              processingProbeAbort = null;
            }
          }, 10000);
        }
      }
      
      const researchBtn = el('research-toggle-btn');
      if (el('research-toggle').checked && researchBtn) {
        researchBtn.disabled = true;
        researchBtn.classList.remove('active');
      }
      box.appendChild(holder);
      uiModule.scrollHistory();

      const enableResearchBtn = () => {
        if (!researchBtn) return;
        researchBtn.disabled = false;
        researchBtn.classList.toggle('active', el('research-toggle').checked);
      };

      if (el('research-toggle').checked && researchBtn) {
        researchBtn.style.display = 'none';
        // 取消勾选研究开关，避免后续消息触发另一次研究
        el('research-toggle').checked = false;
      }

      // 用户当前 UTC 偏移量（分钟，东向为正）。传入
      // 代理中，使"今晚 9 点"这样的自然语言时间
      // 在你的时区中解释，而非服务器时区。
      const _tzOffsetMin = -new Date().getTimezoneOffset();
      const _tzName = (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
        catch { return ''; }
      })();
      const res = await fetch(`${API_BASE}/api/chat_stream`, {
        method: 'POST',
        body: fd,
        headers: { 'X-Tz-Offset': String(_tzOffsetMin), 'X-Tz-Name': _tzName },
        signal: abortCtrl.signal
      });
      
      if (!res.ok) {
        clearResponseTimeout();
        if (res.status === 404) {
          // 会话已被删除（例如被 AI 删除）— 重新加载并回到欢迎页
          holder.remove();
          if (sessionModule) await sessionModule.loadSessions();
          return;
        }
        let errText = `Error ${res.status}`;
        try {
          const errBody = await res.text();
          // 如果存在嵌套 JSON 错误则解析
          const m = errBody.match(/"message"\s*:\s*"([^"]+)"/);
          if (m) errText = m[1].replace(/\\"/g, '"');
          else if (errBody.length < 200) errText = errBody;
        } catch {}
        // 工具相关错误自动切换到聊天模式
        if (errText.includes('tool') || errText.includes('auto')) {
          errText = 'This model doesn\'t support agent tools — switched to Chat mode. Try again.';
          const _ab = document.getElementById('mode-agent-btn');
          const _cb = document.getElementById('mode-chat-btn');
          if (_ab && _cb) {
            _ab.classList.remove('active');
            _cb.classList.add('active');
            const _toggle = _ab.closest('.mode-toggle');
            if (_toggle) _toggle.classList.add('mode-chat');
          }
          if (typeof Storage !== 'undefined' && Storage.KEYS) {
            const _st = Storage.getJSON(Storage.KEYS.TOGGLES, {});
            _st.mode = 'chat';
            Storage.setJSON(Storage.KEYS.TOGGLES, _st);
          }
        }
        typewriterInto(holder.querySelector('.body'), errText);
        enableResearchBtn();
        return;
      }

      // 流式传输时将聊天记录标记为忙碌，使读屏软件等待
      // 稳定后的响应，而不是播报每一个 token。在 finally 中清除。
      const _chatLog = document.getElementById('chat-history');
      if (_chatLog) _chatLog.setAttribute('aria-busy', 'true');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let metrics = null;
      let isThinking = false;
      let thinkingStartTime = null;
      // 流式 TTS：在流式传输中逐句合成语音
      const streamingTTS = !!(window.aiTTSManager && window.aiTTSManager.autoPlay && window.aiTTSManager.available);
      if (streamingTTS) window.aiTTSManager.streamingStart();
      // 多气泡代理跟踪
      let roundHolder = holder;       // 当前 AI 文字气泡（每轮变化）
      let roundText = '';             // 当前轮次累积的文字
      let currentToolBubble = null;   // 当前工具执行气泡
      let roundFinalized = false;     // 当前轮次的文字是否已完成
      let _sourcesHtml = '';          // 信息源框 HTML，用于插入到内容体前面
      let _sourcesExpanded = false;   // 跟踪用户在流式传输中是否展开了信息源
      let _sourcesData = null;        // 原始信息源数据，用于重建
      let _sourcesType = '';          // 'web' 或 'research'
      let _findingsData = null;      // 原始发现数据，用于可折叠框
      // _keepResearchOn 已移除 — 澄清状态现在通过 DB 模式持久化在服务端
      // 将信息源框作为稳定 DOM 节点插入，在流式传输中不会被替换。
      // 返回用于 innerHTML 更新的内容容器。
      function _ensureStreamLayout(body) {
        if (!body) return body;
        // 信息源推迟到最终渲染 — 流式传输中不插入
        // 确保存在稳定的内容 div 用于文字内容
        var contentDiv = body.querySelector('.stream-content');
        if (!contentDiv) {
          contentDiv = document.createElement('div');
          contentDiv.className = 'stream-content';
          body.appendChild(contentDiv);
        }
        return contentDiv;
      }
      const esc = uiModule.esc;
      // 移除思考加载动画辅助函数
      _removeThinkingSpinner = () => {
        const el = document.querySelector('.agent-thinking-dots');
        if (el) {
          if (el._spinner) el._spinner.destroy();
          el.remove();
        }
      };

      // 工具感知型思考加载动画
      let _lastToolName = '';
      const _searchIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="vertical-align:-2px;margin-right:4px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
      const _toolLabels = {
        'web_search': _searchIcon + 'Searching',
        'bash': 'Running',
        'python': 'Running',
        'create_document': 'Writing',
        'update_document': 'Writing',
        'read_document': 'Reading',
        'edit_file': 'Editing',
        'read_file': 'Reading',
        'write_file': 'Writing',
        'list_files': 'Browsing',
        'image_gen': 'Generating',
        'generate_image': 'Generating',
        'manage_memory': 'Remembering',
        'save_memory': 'Remembering',
        'search_memory': 'Recalling',
        'manage_session': 'Organizing',
        'deep_research': 'Researching',
        'list_models': 'Browsing',
        'ui_control': 'Adjusting',
      };
      function _thinkingLabel() {
        if (!_lastToolName) {
          return 'Thinking';
        }
        // 先检查精确匹配，然后是前缀匹配
        const lower = _lastToolName.toLowerCase();
        if (_toolLabels[lower]) return _toolLabels[lower];
        for (const [key, label] of Object.entries(_toolLabels)) {
          if (lower.includes(key) || key.includes(lower)) return label;
        }
        return 'Thinking';
      }

      function _showThinkingSpinner(label) {
        if (document.querySelector('.agent-thinking-dots')) return;
        const _thinkMsg = document.createElement('div');
        _thinkMsg.className = 'msg msg-ai agent-thinking-dots';
        const _thinkBody = document.createElement('div');
        _thinkBody.className = 'body';
        const _ts = spinnerModule.create(label || 'Thinking', 'right', 'wave');
        _thinkBody.appendChild(_ts.createElement());
        _ts.start(120);
        _thinkMsg._spinner = _ts;
        _thinkMsg.appendChild(_thinkBody);
        document.getElementById('chat-history').appendChild(_thinkMsg);
        uiModule.scrollHistory();
      }

      // 文字停止流式传输后自动显示思考加载动画
      let _textPauseTimer = null;
      function _scheduleThinkingSpinner() {
        if (_textPauseTimer) clearTimeout(_textPauseTimer);
        _textPauseTimer = setTimeout(() => {
          if (!document.querySelector('.agent-thinking-dots') && isStreaming) {
            _showThinkingSpinner(_thinkingLabel());
          }
        }, 400);
      }
      _cancelThinkingTimer = () => {
        if (_textPauseTimer) { clearTimeout(_textPauseTimer); _textPauseTimer = null; }
      };

      // 文档流式传输状态（文字围栏检测）
      let _docFenceOpened = false;
      let _docFenceContentStart = -1;
      let _liveThinkSection = null;
      let _liveThinkContent = null;
      let _liveThinkInner = null;
      let _liveThinkHeader = null;
      let _liveThinkSpinnerSlot = null;
      let _liveThinkTimerEl = null;
      let _liveThinkToggle = null;
      let _liveThinkDomId = null;

      function _replyAfterClosedThinking(text) {
        const closeRe = /<\/(?:think(?:ing)?|thought)>|<channel\|>/gi;
        let match = null;
        let last = null;
        while ((match = closeRe.exec(text || '')) !== null) last = match;
        if (!last) return '';
        return (text || '').slice(last.index + last[0].length).trimStart();
      }

      // 流式文本的直接渲染辅助函数
      _renderStream = () => {
        let dt = stripToolBlocks(roundText);
        const bodyEl = roundHolder.querySelector('.body');
        const contentEl = _ensureStreamLayout(bodyEl);

        // 如果思考部分已在原位折叠，只渲染回复部分
        let liveReply = contentEl.querySelector('.live-reply-content');
        if (liveReply) {
          // 提取回复文本 — 处理原生 <think> 标签和非标签模式
          const closedThinkReply = _replyAfterClosedThinking(dt);
          const { thinkingBlocks, content: replyText } = closedThinkReply
            ? { thinkingBlocks: [''], content: closedThinkReply }
            : markdownModule.extractThinkingBlocks(dt);
          let replyTrimmed = '';
          if (thinkingBlocks.length) {
            replyTrimmed = (replyText || '').trim();
          } else {
            // 非标签：检查错乱的 <think>（reasoning\n<think>reply）
            const _gm = dt.match(/^[\s\S]+?<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>\s*([\s\S]*?)(?:<\/(?:think(?:ing)?|thought)>)?\s*$/i);
            if (_gm && _gm[1].trim()) {
              replyTrimmed = _gm[1].trim();
            } else {
              // 纯非标签：找到回复边界
              const _rPrefixes = markdownModule.startsWithReasoningPrefix;
              const _rpStarts = ['Hey', 'Hi ', 'Hi!', 'Hello', 'Sure', 'Yes', 'No ', 'No,', 'Yo', 'OK', 'Here', 'Absolutely', 'Of course', 'Great', 'Alright', 'Thanks', 'Welcome', 'Good ', "I'm happy", "I'd be"];
              const _rt = (replyText || '').trimStart();
              if (_rPrefixes(_rt)) {
                const _rLines = _rt.split('\n');
                for (let _ri = 1; _ri < _rLines.length; _ri++) {
                  const _rl = _rLines[_ri].trim();
                  if (!_rl) continue;
                  if (_rpStarts.some(rp => _rl.startsWith(rp))) { replyTrimmed = _rLines.slice(_ri).join('\n'); break; }
                }
                if (!replyTrimmed) {
                  for (const rp of _rpStarts) {
                    const rx = new RegExp('[.!?]\\s*(' + rp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')');
                    const m = rx.exec(_rt);
                    if (m && m.index > 20) { replyTrimmed = _rt.slice(m.index + 1).trim(); break; }
                  }
                }
              }
            }
          }
          if (replyTrimmed) {
            const r = liveReply._streamRenderer ||
              (liveReply._streamRenderer = createStreamRenderer(liveReply, {
                render: (t) => markdownModule.mdToHtml(markdownModule.squashOutsideCode(t)),
                hljs: window.hljs,
              }));
            r.update(replyTrimmed);
          }
          // 回复空或非空 — 保留思考栏，不落入完整重新渲染
          uiModule.scrollHistory();
          return;
        }

        // 如果思考仍在流式传输（未关闭的 <think>），显示指示器而非原始文本
        if (markdownModule.hasUnclosedThinkTag && markdownModule.hasUnclosedThinkTag(dt)) {
          const thinkStart = dt.search(/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>|<\|channel>thought/i);
          const thinkContent = dt.substring(Math.max(thinkStart, 0))
            .replace(/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>|<\|channel>thought\s*\n?/i, '')
            .replace(/<channel\|>/gi, '')
            .trim();
          const lines = thinkContent.split('\n').length;
          // 流式传输中不显示 beforeThink 文本 — 它会在最终渲染中出现
          // 这可以防止"分裂成两个"的重复问题
          contentEl.innerHTML =
            '<div class="thinking-section"><div class="thinking-header"><div class="thinking-header-left">Thinking' +
            (lines > 1 ? ` (${lines} lines)` : '') + '</div></div></div>';
          // 流式渲染器在下次看到此被覆盖的容器时会自行修复
          // （streamingRenderer.js），因此此处不需要显式重置。
          uiModule.scrollHistory();
          return;
        }

        // 增量流式渲染：冻结已完成的块，只重新渲染
        // 正在增长的部分，并在每个代码块完成后高亮一次。这
        // 就是让代码块悬停按钮不闪烁的原因，并且避免了
        // 每个 token 都重新解析/重新高亮整个消息的 O(N^2) 复杂度。
        // 参见 streamingRenderer.js / streamingSegmenter.js。
        const renderer = contentEl._streamRenderer ||
          (contentEl._streamRenderer = createStreamRenderer(contentEl, {
            render: (t) => markdownModule.processWithThinking(markdownModule.squashOutsideCode(t)),
            hljs: window.hljs,
          }));
        renderer.update(dt);
        uiModule.scrollHistory();
      };

      let _nextIsError = false;
      let _streamSawDone = false;

      while (true) {
        const { done, value } = await reader.read();
        _lastReaderActivity = Date.now();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          // 记录 SSE 事件类型（例如 "event: error"）用于调试
          if (line.startsWith('event: ')) {
            const evtType = line.slice(7).trim();
            if (evtType === 'error') _nextIsError = true;
            continue;
          }
          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            // （思考加载动画的移除以在 agent_step / tool_start / content 处理器中处理）

            // 后台检测：我们是否在不同的会话上？
            const _isBg = (sessionModule.getCurrentSessionId() !== streamSessionId);

            // 首次切换到后台时，将状态存入 map
            if (_isBg && !_backgroundStreams.has(streamSessionId)) {
              _backgroundStreams.set(streamSessionId, {
                status: 'running',
                accumulated: accumulated,
                sourcesHtml: _sourcesHtml,
                findingsData: null,
                abortCtrl: currentAbort,
                query: streamQuery,
                metrics: null,
              });
              if (sessionModule && sessionModule.markStreaming) {
                sessionModule.markStreaming(streamSessionId);
              }
            }

            if (data === '[DONE]') {
              _streamSawDone = true;
              // 如果条目存在则始终更新后台 map（即使用户已切换回来）
              var bgDone = _backgroundStreams.get(streamSessionId);
              if (bgDone) {
                bgDone.status = 'completed';
                bgDone.accumulated = accumulated;
                if (_isBg) {
                  try {
                    _notifyStreamComplete(streamSessionId, streamQuery);
                    _insertStreamDoneToast(streamSessionId, streamQuery);
                  } catch (toastErr) {
                    console.warn('[bg-stream] Toast/notification error:', toastErr);
                  }
                }
                // 关键：始终将流标记为完成，用于侧边栏标记点
                try {
                  if (sessionModule && sessionModule.markStreamComplete) {
                    sessionModule.markStreamComplete(streamSessionId);
                  }
                } catch (dotErr) {
                  console.warn('[bg-stream] markStreamComplete error:', dotErr);
                }
                // 不进行前台最终渲染 — checkBackgroundStream 轮询
                // 会检测到 'completed' 并干净地重新加载历史
                break;
              }
              // 如果思考仍打开则强制关闭（模型从未输出边界标记）
              if (isThinking) {
                isThinking = false;
                cancelAnimationFrame(_thinkTimerRAF);
                var _elapsedDone = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : null;
                if (_elapsedDone) {
                  accumulated = accumulated.replace(/<think>/i, '<think time="' + _elapsedDone + '">');
                  roundText = roundText.replace(/<think>/i, '<think time="' + _elapsedDone + '">');
                }
                if (_liveThinkHeader) _liveThinkHeader.textContent = t('chat.view_thinking');
                if (_liveThinkSpinnerSlot) _liveThinkSpinnerSlot.remove();
                if (_liveThinkTimerEl && _elapsedDone) {
                  _liveThinkTimerEl.textContent = _elapsedDone + 's';
                  _liveThinkTimerEl.style.marginLeft = 'auto';
                  _liveThinkTimerEl.style.marginRight = '5px';
                  var _hdrDone = _liveThinkTimerEl.closest('.thinking-header');
                  // 将折叠箭头放在最右边，计时器在其左侧
                  // （匹配实时 + 最终渲染的布局）— 插入到
                  // 切换开关前面，而不是追加（追加会放在它后面）。
                  if (_hdrDone) {
                    if (_liveThinkToggle && _liveThinkToggle.parentElement === _hdrDone)
                      _hdrDone.insertBefore(_liveThinkTimerEl, _liveThinkToggle);
                    else _hdrDone.appendChild(_liveThinkTimerEl);
                  }
                }
                // 分配稳定的 ID
                var _thinkIdDone = 'think-' + Date.now();
                var _liveHdrDone = _liveThinkSection && _liveThinkSection.querySelector('.thinking-header');
                if (_liveHdrDone) _liveHdrDone.dataset.thinkingId = _thinkIdDone;
                if (_liveThinkContent) _liveThinkContent.id = _thinkIdDone;
                if (_liveThinkToggle) _liveThinkToggle.id = _thinkIdDone + '-toggle';
                // 创建实时回复容器，使最终渲染保留思考栏
                var _streamElDone = _liveThinkSection ? _liveThinkSection.parentElement : roundHolder.querySelector('.stream-content');
                if (!_streamElDone) _streamElDone = roundHolder.querySelector('.body');
                if (_streamElDone && !_streamElDone.querySelector('.live-reply-content')) {
                  var _replyElDone = document.createElement('div');
                  _replyElDone.className = 'live-reply-content';
                  _streamElDone.appendChild(_replyElDone);
                }
              }
              // 正常前台完成 — 指标将显示在下方的最终渲染块中
              break;
            }
            try {
              const json = JSON.parse(data);
              // 处理 SSE 错误事件（例如来自供应商的 HTTP 404）
              if (_nextIsError || json.status >= 400) {
                _nextIsError = false;
                const errMsg = json.text || json.error?.message || `Error ${json.status || 'unknown'}`;
                console.error('Stream error:', errMsg);
                if (spinner && spinner.element) spinner.destroy();
                typewriterInto(roundHolder.querySelector('.body'), errMsg);
                break;
              }
              if (json.delta || json.type === 'tool_start' || json.type === 'tool_output' || json.type === 'tool_progress' || json.type === 'agent_step' || json.type === 'doc_stream_open' || json.type === 'doc_stream_delta' || json.type === 'research_progress') {
                clearResponseTimeout();
                clearProcessingProbe();
              }
              if (json.delta) {
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                // 工具之后有文字到达 — 将线程线连接到此气泡
                const _threadAbove = roundHolder?.previousElementSibling;
                if (_threadAbove && _threadAbove.classList.contains('agent-thread') && !_threadAbove.classList.contains('has-bottom')) {
                  _threadAbove.classList.add('has-bottom');
                }
                // VLLM 推理 token：用 <think> 标签包裹用于思考 UI。
                // 有状态的开关（不是全消息子字符串检查），使每轮
                // 多轮代理响应都有自己的 <think>…</think> — 否则
                // 只有第 1 轮被包裹，第 2+ 轮的推理会泄漏到答案中。
                let _delta = json.delta;
                if (json.thinking) {
                  if (!_thinkOpen) { _delta = '<think>' + _delta; _thinkOpen = true; }
                } else if (_thinkOpen) {
                  _delta = '</think>' + _delta; _thinkOpen = false;
                }
                const wasEmpty = !accumulated;
                accumulated += _delta;
                roundText += _delta;
                currentAccumulated = accumulated; // 更新全局跟踪器
                // 第一个 token 到达 — 将停止按钮从处理状态切换到流式状态
                if (wasEmpty && submitBtn && !_isBg) {
                  submitBtn.dataset.phase = 'receiving';
                }

                // 如果在后台运行则更新后台 map
                if (_isBg) {
                  var bgEntry = _backgroundStreams.get(streamSessionId);
                  if (bgEntry) bgEntry.accumulated = accumulated;
                  continue; // 跳过所有 DOM 写入
                }

                // --- 文字围栏文档流式传输（用于不使用原生工具调用的模型） ---
                if (!_docFenceOpened && documentModule && roundText.includes('```create_document\n')) {
                  const fenceIdx = roundText.indexOf('```create_document\n');
                  const afterFence = roundText.slice(fenceIdx + '```create_document\n'.length);
                  const fenceLines = afterFence.split('\n');
                  if (fenceLines.length >= 1 && fenceLines[0].trim()) {
                    _docFenceOpened = true;
                    const title = fenceLines[0].trim();
                    // 与后端 src/tool_implementations.py 中的 _KNOWN_LANGS 保持同步
                    const knownLangs = ['python','py','javascript','js','typescript','ts','html','css','json','yaml','bash','sql','rust','go','java','c','cpp','markdown','text','plain','ruby','swift','kotlin','php','email','csv','xml','toml','ini'];
                    const isLang = fenceLines.length >= 2 && knownLangs.includes(fenceLines[1].trim().toLowerCase());
                    const lang = isLang ? fenceLines[1].trim() : '';
                    _docFenceContentStart = fenceIdx + '```create_document\n'.length + title.length + 1 + (isLang ? fenceLines[1].length + 1 : 0);
                    documentModule.streamDocOpen(title, lang);
                  }
                }
                if (_docFenceOpened && _docFenceContentStart > 0 && documentModule) {
                  let raw = roundText.slice(_docFenceContentStart);
                  const closeIdx = raw.indexOf('\n```');
                  if (closeIdx >= 0) raw = raw.slice(0, closeIdx);
                  documentModule.streamDocDelta(raw);
                }

                // 检测进行中的思考：
                // 1. 正常：<think>... 尚未有闭合标签
                // 2. 格式错误：<think></think>\n... 有文本但还没有第二个 </think>
                // 3. Qwen3.5："Thinking Process:" 但没有 <think> 标签
                let hasUnclosedThink = markdownModule.hasUnclosedThinkTag(roundText);
                // 检测非标签思考模式："Thinking:"、"Thinking Process:"、Gemma 风格的推理
                // 这些模式不使用 <think> 标签，因此我们在流式传输中模拟未关闭的思考
                const _replyPrefixes = ['Hey', 'Hi ', 'Hi!', 'Hello', 'Sure', 'Yes', 'No ', 'No,', 'Yo', 'OK', 'Here', 'Absolutely', 'Of course', 'Great', 'Alright', 'Thanks', 'Welcome', 'Good ', "I'm happy", "I'd be"];
                if (!hasUnclosedThink && !/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>|<\|channel>thought/i.test(roundText)) {
                  const _trimmedRT = roundText.trimStart();
                  const _isReasoning = markdownModule.startsWithReasoningPrefix(_trimmedRT);
                  if (_isReasoning) {
                    // 检查是否已能看到回复边界（换行符 + 回复模式）
                    const _lines = _trimmedRT.split('\n');
                    let _replyFound = false;
                    for (let li = 1; li < _lines.length; li++) {
                      const _l = _lines[li].trim();
                      if (!_l) continue;
                      if (_replyPrefixes.some(rp => _l.startsWith(rp))) {
                        _replyFound = true;
                        break;
                      }
                    }
                    if (!_replyFound) {
                      // 也检查行内："推理文字.回复文字"
                      const _inlineReply = _replyPrefixes.some(rp => {
                        const rx = new RegExp('[.!?]\\s*' + rp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                        const m = rx.exec(_trimmedRT);
                        return m && m.index > 20;
                      });
                      if (!_inlineReply) hasUnclosedThink = true;
                    }
                  }
                }
                if (!hasUnclosedThink && /^<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>\s*<\/(?:think(?:ing)?|thought)>/i.test(roundText)) {
                  // 空的 <think></think> — 模型可能将推理放在了标签之外
                  const afterEmpty = roundText.replace(/^<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>\s*<\/(?:think(?:ing)?|thought)>/i, '').trim();
                  const closeTags = (afterEmpty.match(/<\/(?:think(?:ing)?|thought)>/gi) || []).length;
                  if (closeTags === 0 && afterEmpty.length > 0) {
                    hasUnclosedThink = true; // 仍在等待真正的闭合标签
                  }
                }
                // 检测虚假闭合：<think>短文本</think> 但后续有未标签的真实推理
                // 仅在稍后有第二个 </think> 时适用（模型将推理泄漏到了标签外）
                // 如果 </think> 之后的文本包含工具调用则不要触发（那是真实内容）
                if (!hasUnclosedThink && isThinking) {
                  const _thinkMatch = roundText.match(/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>([\s\S]*?)<\/(?:think(?:ing)?|thought)>/i);
                  const _thinkLen = _thinkMatch ? _thinkMatch[1].trim().length : 0;
                  if (_thinkLen < 20) {
                    const _afterClose = roundText.replace(/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>([\s\S]*?)<\/(?:think(?:ing)?|thought)>/i, '').trim();
                    // 只有当尾部文本看起来像推理（而非工具调用）时才继续等待
                    const _hasToolCall = /```(?:bash|python|web_search|read_file|write_file|create_document|edit_document|manage_|generate_image)/i.test(_afterClose);
                    const _hasOrphanClose = /<\/(?:think(?:ing)?|thought)>/i.test(_afterClose);
                    if (!_hasToolCall && (_hasOrphanClose || (Date.now() - thinkingStartTime) < 500)) {
                      hasUnclosedThink = true; // 继续等待真正的 </think>
                    }
                  }
                }

                if (hasUnclosedThink && !isThinking) {
                  isThinking = true;
                  thinkingStartTime = Date.now();
                  if (spinner && spinner.element) spinner.destroy();

                  // 创建实时思考框 — 初始展开，使内容流式可见
                  var thinkBody = roundHolder.querySelector('.body');
                  var thinkContent = _ensureStreamLayout(thinkBody);
                  thinkContent.style.minHeight = '';
                  _liveThinkDomId = 'live-think-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
                  thinkContent.innerHTML = `
                    <div class="thinking-section">
                      <div class="thinking-header" data-thinking-id="${_liveThinkDomId}">
                        <div class="thinking-header-left"><span class="live-think-header-text">Thinking\u2026</span></div>
                        <span class="live-think-spinner-slot" style="flex-shrink:0;margin-left:auto;"></span>
                        <span class="live-think-timer" style="font-size:11px;opacity:0.4;font-variant-numeric:tabular-nums;margin-left:6px;margin-right:5px;"></span>
                        <span class="thinking-toggle live-think-toggle" id="${_liveThinkDomId}-toggle"></span>
                      </div>
                      <div class="thinking-content" id="${_liveThinkDomId}">
                        <div class="thinking-content-inner live-think-inner"></div>
                      </div>
                    </div>`;
                  _liveThinkSection = thinkContent.querySelector('.thinking-section');
                  _liveThinkContent = thinkContent.querySelector('.thinking-content');
                  _liveThinkInner = thinkContent.querySelector('.live-think-inner');
                  _liveThinkHeader = thinkContent.querySelector('.live-think-header-text');
                  _liveThinkSpinnerSlot = thinkContent.querySelector('.live-think-spinner-slot');
                  _liveThinkTimerEl = thinkContent.querySelector('.live-think-timer');
                  _liveThinkToggle = thinkContent.querySelector('.live-think-toggle');
                  // 实时计时器
                  var _thinkTimerStart = Date.now();
                  var _thinkTimerRAF = 0;
                  function _tickThinkTimer() {
                    if (!_liveThinkTimerEl || !_liveThinkTimerEl.isConnected) return;
                    var s = ((Date.now() - _thinkTimerStart) / 1000).toFixed(1);
                    _liveThinkTimerEl.textContent = s + 's';
                    _thinkTimerRAF = requestAnimationFrame(_tickThinkTimer);
                  }
                  _thinkTimerRAF = requestAnimationFrame(_tickThinkTimer);
                  // 漩涡加载动画
                  if (_liveThinkSpinnerSlot) {
                    var _wp = spinnerModule.createWhirlpool(12);
                    _wp.element.style.margin = '0';
                    _wp.element.style.width = '12px';
                    _wp.element.style.height = '12px';
                    _wp.element.style.transform = 'translateY(-1px)'; // 使漩涡与标题文字对齐
                    _liveThinkSpinnerSlot.appendChild(_wp.element);
                  }
                } else if (hasUnclosedThink && isThinking) {
                  if (_liveThinkInner) {
                    // 提取原始思考文本（剥离已知的思考包装和前缀）
                    var thinkText = roundText
                      .replace(/<\/?(?:think(?:ing)?|thought)(?:\s+[^>]*)?>/gi, '')
                      .replace(/<\|channel>thought\s*\n?/gi, '')
                      .replace(/<\|channel>response\s*\n?/gi, '')
                      .replace(/<channel\|>/gi, '');
                    thinkText = thinkText.replace(/^\s*Thinking(?:\s+Process)?:\s*/i, '');
                    _liveThinkInner.innerHTML = markdownModule.mdToHtml(thinkText);
                    // 保持思考框滚动到底部
                    var thinkBox = _liveThinkInner.closest('.thinking-content');
                    if (thinkBox) thinkBox.scrollTop = thinkBox.scrollHeight;
                  }
                  uiModule.scrollHistory();
                  continue;
                } else if (!hasUnclosedThink && isThinking) {
                  isThinking = false;
                  var _thinkTextLen = _liveThinkInner ? _liveThinkInner.textContent.trim().length : 0;

                  // 如果思考内容非常短（< 20 字符），完全移除该区域
                  // 模型有时会输出 <think>The</think> 或类似的噪声
                  if (_thinkTextLen < 20 && _liveThinkSection) {
                    _liveThinkSection.remove();
                    _liveThinkSection = null;
                    _liveThinkContent = null;
                    _liveThinkInner = null;
                    _liveThinkHeader = null;
                    _liveThinkSpinnerSlot = null;
                    _liveThinkTimerEl = null;
                    _liveThinkToggle = null;
                    _liveThinkDomId = null;
                    // 落入正常流式传输
                    if (spinner && spinner.element) spinner.destroy();
                    _renderStream();
                    _scheduleThinkingSpinner();
                    continue;
                  }

                  // 思考结束 — 平滑过渡：更新标题，暂停，然后折叠
                  // 停止实时计时器和加载动画
                  cancelAnimationFrame(_thinkTimerRAF);
                  var elapsed = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : null;
                  // 将思考时间嵌入 <think> 标签，以便重新加载时保持
                  if (elapsed) {
                    accumulated = accumulated.replace(/<think>/i, '<think time="' + elapsed + '">');
                    roundText = roundText.replace(/<think>/i, '<think time="' + elapsed + '">');
                  }
                  if (_liveThinkHeader) _liveThinkHeader.textContent = t('chat.view_thinking');
                  if (_liveThinkSpinnerSlot) _liveThinkSpinnerSlot.remove();
                  // 将计时器移到标题右侧
                  if (_liveThinkTimerEl && elapsed) {
                    _liveThinkTimerEl.textContent = elapsed + 's';
                    _liveThinkTimerEl.style.marginLeft = 'auto';
                    _liveThinkTimerEl.style.marginRight = '5px';
                    var _hdrRow = _liveThinkTimerEl.closest('.thinking-header');
                    // 折叠箭头在最右边，计时器在其左侧 — 插入到
                    // 切换开关前面（追加会把计时器放在它后面）。
                    if (_hdrRow) {
                      if (_liveThinkToggle && _liveThinkToggle.parentElement === _hdrRow)
                        _hdrRow.insertBefore(_liveThinkTimerEl, _liveThinkToggle);
                      else _hdrRow.appendChild(_liveThinkTimerEl);
                    }
                  }

                  // 分配稳定的 ID（用于 markdown.js 中的点击折叠处理器）
                  var _thinkId = 'think-' + Date.now();
                  var _liveHdr = _liveThinkSection && _liveThinkSection.querySelector('.thinking-header');
                  if (_liveHdr) _liveHdr.dataset.thinkingId = _thinkId;
                  if (_liveThinkContent) _liveThinkContent.id = _thinkId;
                  if (_liveThinkToggle) _liveThinkToggle.id = _thinkId + '-toggle';

                  // 追加一个容器，用于思考之后的回复文字
                  var _streamEl = _liveThinkSection ? _liveThinkSection.parentElement : roundHolder.querySelector('.stream-content');
                  if (!_streamEl) _streamEl = roundHolder.querySelector('.body');
                  if (_streamEl) {
                    var _replyEl = document.createElement('div');
                    _replyEl.className = 'live-reply-content';
                    _streamEl.appendChild(_replyEl);
                  }

                  // 渲染随闭合 </think> token 一起到达的任何回复文字
                  _renderStream();
                } else {
                  // 正常流式传输
                  if (spinner && spinner.element) spinner.destroy();
                  _renderStream();
                  _scheduleThinkingSpinner();
                  // 用累积的文字喂入流式 TTS
                  if (streamingTTS) window.aiTTSManager.streamingUpdate(roundText);
                }
              } else if (json.type === 'research_progress') {
                if (_isBg) continue; // 后台跳过 DOM 更新
                _researchingStreamIds.add(streamSessionId);
                // 运行期间高亮研究按钮
                var _rToggle = document.getElementById('research-toggle-btn');
                if (_rToggle) _rToggle.classList.add('research-running');
                // 首次研究事件时请求通知权限
                if ('Notification' in window && Notification.permission === 'default') {
                  Notification.requestPermission();
                }
                // 在侧边栏将会话标记为研究进行中
                var _rSid = sessionModule && sessionModule.getCurrentSessionId();
                if (_rSid && sessionModule.markResearching) sessionModule.markResearching(_rSid);
                const rp = json.data;
                // 首次进度事件时启动研究计时器 +  synapse
                if (!_researchTimerEl && spinner && spinner.element) {
                  _researchStartTime = rp.started_at ? rp.started_at * 1000 : Date.now();
                  _researchAvgDuration = rp.avg_duration || null;
                  _researchTimerEl = document.createElement('div');
                  _researchTimerEl.className = 'research-timer';
                  // 样式在 .research-timer CSS 类中
                  spinner.element.parentNode.insertBefore(_researchTimerEl, spinner.element.nextSibling);
                  _researchTimerInterval = setInterval(() => {
                    if (!_researchTimerEl) return;
                    var elapsed = Math.floor((Date.now() - _researchStartTime) / 1000);
                    var mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
                    var ss = String(elapsed % 60).padStart(2, '0');
                    var txt = mm + ':' + ss;
                    if (_researchAvgDuration) {
                      var avgM = String(Math.floor(_researchAvgDuration / 60)).padStart(2, '0');
                      var avgS = String(Math.round(_researchAvgDuration % 60)).padStart(2, '0');
                      txt += ' / avg ' + avgM + ':' + avgS;
                    }
                    _researchTimerEl.textContent = txt;
                  }, 1000);
                  // Synapse 可视化 — 直接插入在计时器上方，
                  // 使其位于加载消息和计时器行之间。
                  try {
                    _researchSynapse = createResearchSynapse(spinner.element.parentNode, {
                      query: holder._researchQuery || rp.query || '',
                      startedAt: _researchStartTime,
                    });
                    // 将它移到加载动画和计时器之间
                    if (_researchSynapse.element && _researchTimerEl) {
                      spinner.element.parentNode.insertBefore(_researchSynapse.element, _researchTimerEl);
                    }
                  } catch (e) { console.warn('synapse init failed', e); }
                }
                if (_researchSynapse) {
                  _researchSynapse.setPhase(rp.phase, rp);
                  if (typeof rp.round === 'number') _researchSynapse.setRound(rp.round);
                  if (typeof rp.total_sources === 'number') _researchSynapse.setSourceCount(rp.total_sources);
                  if (rp.phase === 'error') _researchSynapse.complete();
                }
                if (spinner && spinner.element) {
                  if (rp.phase === 'probing') {
                    spinner.updateMessage(`Verifying model: ${rp.model || '?'}`);
                  } else if (rp.phase === 'planning') {
                    spinner.updateMessage('Analyzing question & planning research strategy');
                  } else if (rp.phase === 'searching') {
                    const q = rp.queries ? `${rp.queries} queries` : '';
                    const s = rp.total_sources ? ` · ${rp.total_sources} sources` : '';
                    spinner.updateMessage(`Round ${rp.round || '?'}: Searching${q ? ' (' + q + ')' : ''}${s}`);
                  } else if (rp.phase === 'reading') {
                    spinner.updateMessage(rp.title ? `Reading: ${rp.title}` : `Round ${rp.round || '?'}: Reading ${rp.new_sources || ''} pages · ${rp.total_sources || 0} sources total`);
                  } else if (rp.phase === 'analyzing') {
                    spinner.updateMessage(`Round ${rp.round || '?'}: Analyzing ${rp.total_findings || 0} findings`);
                  } else if (rp.phase === 'writing') {
                    spinner.updateMessage(`Writing report · ${rp.total_sources || 0} sources`);
                  } else if (rp.phase === 'error') {
                    spinner.updateMessage(rp.message || 'Search error');
                  }
                }
              } else if (json.type === 'research_sources') {
                if (_isBg) {
                  // 将信息源 HTML 存储到后台 map
                  if (json.data && json.data.length > 0) {
                    _sourcesHtml = _buildSourcesBox(json.data, 'research');
                    var bgE = _backgroundStreams.get(streamSessionId);
                    if (bgE) bgE.sourcesHtml = _sourcesHtml;
                  }
                  // 清除此后台会话的研究进行中指示器
                  if (sessionModule && sessionModule.clearResearching) sessionModule.clearResearching(streamSessionId);
                  continue;
                }
                // 研究完成 — 清理计时器，显示信息源框，然后显示 LLM 响应的加载动画
                _clearResearchTimer();
                holder._researchSources = json.data;
                var _rSid2 = sessionModule && sessionModule.getCurrentSessionId();
                if (_rSid2 && sessionModule.clearResearching) sessionModule.clearResearching(_rSid2);
                if (json.data && json.data.length > 0) {
                  _sourcesData = json.data; _sourcesType = 'research';
                  _sourcesHtml = _buildSourcesBox(json.data, 'research');
                }
                if (document.hidden) {
                  _notifyResearchComplete(_rSid2 || '', holder._researchQuery || '');
                }
              } else if (json.type === 'research_findings') {
                if (_isBg) {
                  var bgEf = _backgroundStreams.get(streamSessionId);
                  if (bgEf) bgEf.findingsData = json.data;
                  continue;
                }
                if (json.data && json.data.length > 0) {
                  _findingsData = json.data;
                }
              } else if (json.type === 'research_done') {
                // 研究完成 — 重新加载会话以显示持久化的报告
                _clearResearchTimer();
                if (sessionModule && sessionModule.clearResearching) {
                  sessionModule.clearResearching(streamSessionId);
                }
                _researchingStreamIds.delete(streamSessionId);
                // 短暂延迟后重新加载会话历史，其中包含完整报告
                setTimeout(async () => {
                  // 如果用户已导航到别处，不要将用户拉回此对话
                  // （例如已开始新对话）而研究已完成 —
                  // 只刷新侧边栏，这样当他们返回时报告就会显示。
                  if (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId() === streamSessionId) {
                    await sessionModule.selectSession(streamSessionId);
                  } else {
                    await sessionModule.loadSessions();
                  }
                }, 500);
                continue;
              } else if (json.type === 'web_sources') {
                if (_isBg) {
                  if (json.data && json.data.length > 0) {
                    _sourcesHtml = _buildSourcesBox(json.data, 'web');
                    var bgE2 = _backgroundStreams.get(streamSessionId);
                    if (bgE2) bgE2.sourcesHtml = _sourcesHtml;
                  }
                  continue;
                }
                // 网页搜索完成 — 存储信息源用于最终渲染（不中途渲染）
                holder._webSources = json.data;
                if (json.data && json.data.length > 0) {
                  _sourcesData = json.data; _sourcesType = 'web';
                  _sourcesHtml = _buildSourcesBox(json.data, 'web');
                }
              } else if (json.type === 'model_fallback') {
                // 模型离线 — 已切换到备用模型
                var _fbData = json.data || {};
                uiModule.showToast(
                  t('chat.model_offline', { old: _fbData.old_model || '?', new: _fbData.new_model || '?' }),
                  5000
                );
                // 更新模型选择器以反映新的模型
                if (sessionModule && sessionModule.updateModelPicker) {
                  sessionModule.updateModelPicker();
                }
                continue;
              } else if (json.type === 'model_info') {
                // 一旦知道模型名称就更新角色标签
                if (!_isBg && holder) {
                  const roleEl = holder.querySelector('.role');
                  if (roleEl) {
                    holder._requestedModel = json.requested_model || json.model || holder._requestedModel;
                    holder._actualModel = json.model || holder._actualModel || holder._requestedModel;
                    if (json.suffix) holder._roleSuffix = json.suffix;
                    // 如果由服务器发送或本地设置，则前置角色名称
                    var _charName = json.character_name || (presetsModule.getCharacterName ? presetsModule.getCharacterName() : '');
                    if (_charName) holder._characterName = _charName;
                    _setRoleModelLabel(roleEl, holder._requestedModel, holder._actualModel, {
                      suffix: holder._roleSuffix,
                      characterName: holder._characterName,
                    });
                  }
                }
              } else if (json.type === 'fallback') {
                // 所选模型失败，另一个供应商响应了。
                // 使其可见，这样配置错误的供应商永远不会被无声地
                // 伪装在所选模型的名称之下。
                if (!_isBg) {
                  var _selM = _shortModel(json.selected_model || '');
                  var _ansM = _shortModel(json.answered_by || '');
                  uiModule.showToast(t('chat.model_fallback', { old: _selM, new: _ansM }), 6000);
                  if (holder) {
                    var _rEl = holder.querySelector('.role');
                    if (_rEl) {
                      var _tsS = _rEl.querySelector('.role-timestamp');
                      _rEl.textContent = _ansM + ' (fallback) ';
                      _rEl.title = (json.selected_model || '') + ' failed' +
                        (json.reason ? ': ' + json.reason : '') + ' — answered by ' + (json.answered_by || '');
                      _applyModelColor(_rEl, json.answered_by);
                      if (_tsS) _rEl.appendChild(_tsS);
                      holder._requestedModel = json.selected_model || holder._requestedModel || modelName;
                      const _hasResolvedActual = holder._actualModel && !_sameModelName(holder._actualModel, holder._requestedModel);
                      holder._actualModel = _hasResolvedActual ? holder._actualModel : (json.answered_by || holder._actualModel || holder._requestedModel);
                      _setRoleModelLabel(_rEl, holder._requestedModel, holder._actualModel, {
                        suffix: holder._roleSuffix,
                        characterName: holder._characterName,
                        reason: json.reason,
                      });
                    }
                  }
                }
              } else if (json.type === 'rounds_exhausted') {
                // 代理在仍工作时达到了每轮步骤限制。
                // 提供继续按钮，而不是静默卡住。
                // 注意：追加到聊天历史容器（底部），而不是
                // 消息体 — 消息体的 innerHTML 在流
                // 结束时会被重新渲染，会清除放在其中的注释。
                const _chatBox = document.getElementById('chat-history');
                if (!_isBg && _chatBox) {
                  // 移除任何先前的框，使每次重复达到上限都获得新的
                  // 底部继续按钮（连续多次继续）。
                  const _old = _chatBox.querySelector('.rounds-exhausted');
                  if (_old) _old.remove();
                  const note = document.createElement('div');
                  note.className = 'stopped-indicator rounds-exhausted';
                  const label = document.createElement('span');
                  label.className = 'rounds-exhausted-label';
                  label.textContent = `Reached the ${json.rounds || ''}-step limit — not finished.`;
                  note.appendChild(label);
                  const contBtn = document.createElement('button');
                  contBtn.className = 'continue-btn';
                  contBtn.title = t('chat.continue_task');
                  contBtn.textContent = t('chat.continue') + ' ▸';
                  const _holder = currentHolder;
                  contBtn.addEventListener('click', () => {
                    note.remove();
                    _hideUserBubble = true;
                    _pendingContinue = _holder;
                    const msgInput = uiModule.el('message');
                    if (msgInput) {
                      msgInput.value = 'You hit the step limit before finishing — the task is not complete. Continue from exactly where you left off and keep going until it is done. Do NOT repeat work already done.';
                      const sb = document.querySelector('.send-btn');
                      if (sb) sb.click();
                    }
                  });
                  note.appendChild(contBtn);
                  _chatBox.appendChild(note);
                  try { note.scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch (_) { uiModule.scrollHistory && uiModule.scrollHistory(); }
                }
              } else if (json.type === 'model_actual') {
                if (!_isBg && holder) {
                  holder._requestedModel = json.requested_model || holder._requestedModel || modelName;
                  holder._actualModel = json.model || holder._actualModel || holder._requestedModel;
                  _setRoleModelLabel(holder.querySelector('.role'), holder._requestedModel, holder._actualModel, {
                    suffix: holder._roleSuffix,
                    characterName: holder._characterName,
                  });
                }
              } else if (json.type === 'attachments') {
                if (_isBg) continue;
                // 更新用户气泡 — 用图片预览替换文件标记
                const _ub = document.querySelector('#chat-history .msg-user:last-of-type');
                if (_ub) {
                  const _aw = _ub.querySelector('.attach-cards');
                  if (_aw) {
                    for (const _att of json.data) {
                      const _isImg = (_att.mime || '').startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(_att.name || '');
                      if (_isImg && _att.id) {
                        // 如果此文件 id 已有预览则跳过 —
                        // 重新生成时原始用户气泡保留其
                        // 照片，后端重新发送附件事件
                        // 用于相同的 id；没有这个守卫会追加一个
                        // 重复项（视觉上把真实照片挤掉）。
                        const _existingPreview = _aw.querySelector('[data-file-id="' + _att.id + '"]');
                        if (_existingPreview) {
                          if (_att.vision_model && !_existingPreview.querySelector('.attach-vision-model')) {
                            const _vl = document.createElement('div');
                            _vl.className = 'attach-vision-model';
                            _vl.textContent = 'Vision: ' + String(_att.vision_model).split('/').pop();
                            const _name = _existingPreview.querySelector('.attach-image-name');
                            if (_name) _existingPreview.insertBefore(_vl, _name);
                            else _existingPreview.appendChild(_vl);
                          }
                          continue;
                        }
                        const _card = _aw.querySelector('.attach-card[data-name="' + (_att.name || '').replace(/"/g, '\\"') + '"]');
                        const _iw = document.createElement('div');
                        _iw.className = 'attach-image-preview';
                        _iw.dataset.fileId = _att.id;
                        _iw.style.cursor = 'pointer';
                        _iw.onclick = () => window.open(API_BASE + '/api/upload/' + _att.id, '_blank');
                        const _im = document.createElement('img');
                        _im.src = API_BASE + '/api/upload/' + _att.id;
                        _im.alt = _att.name || 'Image';
                        _im.style.cssText = 'max-width:300px;max-height:200px;border-radius:6px;display:block;';
                        _iw.appendChild(_im);
                        if (_att.vision_model) {
                          const _vl = document.createElement('div');
                          _vl.className = 'attach-vision-model';
                          _vl.textContent = 'Vision: ' + String(_att.vision_model).split('/').pop();
                          _iw.appendChild(_vl);
                        }
                        if (_att.name) {
                          const _nm = document.createElement('div');
                          _nm.className = 'attach-image-name';
                          _nm.textContent = _att.name;
                          _iw.appendChild(_nm);
                        }
                        if (_card) _card.replaceWith(_iw); else _aw.appendChild(_iw);
                      } else {
                        const _card = _aw.querySelector('.attach-card[data-name="' + (_att.name || '').replace(/"/g, '\\"') + '"]');
                        if (_card && _att.id) {
                          _card.dataset.fileId = _att.id;
                          _card.style.cursor = 'pointer';
                          _card.onclick = () => window.open(API_BASE + '/api/upload/' + _att.id, '_blank');
                        }
                      }
                    }
                  }
                  // 标题 / OCR 文字不再作为内联
                  // 可折叠内容渲染在用户气泡上 — 用户可以通过
                  // 照片缩略图上的"标题"按钮查看/编辑它。
                }
              } else if (json.type === 'rag_sources') {
                if (_isBg) continue;
                holder._ragSources = json.data;
              } else if (json.type === 'memories_used') {
                if (_isBg) continue;
                holder._memoriesUsed = json.data;
              } else if (json.type === 'compacted') {
                if (!_isBg) {
                  uiModule.showToast(t('chat.context_compacted'));
                }
              } else if (json.type === 'metrics') {
                metrics = json.data;
                if (!_isBg && holder && metrics) {
                  holder._requestedModel = metrics.requested_model || holder._requestedModel || modelName;
                  holder._actualModel = metrics.model || holder._actualModel || holder._requestedModel;
                }
                if (_isBg) {
                  var bgM = _backgroundStreams.get(streamSessionId);
                  if (bgM) bgM.metrics = json.data;
                  continue;
                }

              } else if (json.type === 'message_saved') {
                // 将持久化的数据库 ID 挂接到刚刚流式传输的气泡上，
                // 使其可以立即编辑/删除，无需重新加载聊天。
                if (_isBg) continue;
                if (currentHolder && json.id) currentHolder.dataset.dbId = json.id;

              } else if (json.type === 'tool_start') {
                if (_isBg) continue;
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                // 如果思考仍打开则强制关闭 — 工具是真实内容，不是思考
                if (isThinking) {
                  isThinking = false;
                  cancelAnimationFrame(_thinkTimerRAF);
                  var _elapsed2 = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : null;
                  if (_liveThinkHeader) _liveThinkHeader.textContent = t('chat.view_thinking');
                  if (_liveThinkTimerEl) _liveThinkTimerEl.textContent = _elapsed2 ? _elapsed2 + 's' : '';
                  if (_liveThinkSpinnerSlot) _liveThinkSpinnerSlot.remove();
                  // 分配稳定的 ID
                  var _thinkId2 = 'think-' + Date.now();
                  var _liveHdr2 = _liveThinkSection && _liveThinkSection.querySelector('.thinking-header');
                  if (_liveHdr2) _liveHdr2.dataset.thinkingId = _thinkId2;
                  if (_liveThinkContent) _liveThinkContent.id = _thinkId2;
                  if (_liveThinkToggle) _liveThinkToggle.id = _thinkId2 + '-toggle';
                }
                _renderStream();
                // --- 完成当前文字气泡（每轮只执行一次） ---
                if (!roundFinalized) {
                  roundFinalized = true;
                  if (spinner && spinner.element) spinner.destroy();
                  const dt = stripToolBlocks(roundText);
                  if (dt.trim()) {
                    var _body3 = roundHolder.querySelector('.body');
                    var _contentEl3 = _ensureStreamLayout(_body3);
                    _contentEl3.style.minHeight = '';  // 清除流式传输的膨胀状态
                    _contentEl3.innerHTML = markdownModule.processWithThinking(markdownModule.squashOutsideCode(dt));
                    if (window.hljs) roundHolder.querySelectorAll('pre code').forEach((b) => window.hljs.highlightElement(b));
                  } else {
                    roundHolder.style.display = 'none';
                  }
                }

                // 跟踪工具名称用于上下文相关的加载动画标签
                _lastToolName = json.tool || '';

                // --- 线程时间线：将工具分组到线程容器中 ---
                const cmd = json.command || '';
                const chatBox = document.getElementById('chat-history');
                // 查找要追加到的现有线程 — 检查最后几个子元素
                // （agent_step 可能在工具轮次之间插入空的 msg-ai）
                let threadWrap = null;
                for (let ci = chatBox.children.length - 1; ci >= Math.max(0, chatBox.children.length - 5); ci--) {
                  const child = chatBox.children[ci];
                  if (child.classList.contains('agent-thread')) {
                    threadWrap = child;
                    break;
                  }
                  // 跳过隐藏的（空）气泡和思考加载动画
                  if (child.style.display === 'none' || child.classList.contains('agent-thinking-dots')) continue;
                  // 如果碰到可见消息气泡（工具之间有真实内容）则停止
                  if (child.classList.contains('msg')) break;
                }
                if (threadWrap) {
                  // 继续现有线程 — 移除 has-bottom（agent_step 可能已设置
                  // 期望文字，但我们得到的是更多工具）
                  threadWrap.classList.remove('has-bottom');
                } else {
                  threadWrap = document.createElement('div');
                  threadWrap.className = 'agent-thread';
                  // 向上延伸连接线到上方的聊天气泡（如果有的话）
                  const _prevSib = chatBox.lastElementChild;
                  const _hasBubbleAbove = _prevSib && (_prevSib.classList.contains('msg') && _prevSib.style.display !== 'none');
                  const _hasThreadAbove = _prevSib && _prevSib.classList.contains('agent-thread');
                  if (_hasBubbleAbove || _hasThreadAbove || (roundText.trim() && roundHolder && roundHolder.style.display !== 'none')) {
                    threadWrap.classList.add('has-top');
                  }
                  chatBox.appendChild(threadWrap);
                }
                threadWrap.classList.add('streaming');
                const toolLabel = _toolLabels[json.tool.toLowerCase()] || json.tool;
                const node = document.createElement('div')
                node.className = 'agent-thread-node running';
                const cmdHtml = cmd ? `<pre class="agent-thread-cmd">${esc(cmd)}</pre>` : '';
                node.innerHTML = `<div class="agent-thread-dot"></div><div class="agent-thread-header"><span class="agent-thread-icon">\u25B6</span><span class="agent-thread-tool">${esc(toolLabel)}</span><span class="agent-thread-wave">▁▂▃</span></div><div class="agent-thread-content">${cmdHtml}</div>`;
                // 通过代理的点击处理器展开/折叠（初始化在模块底部）。
                threadWrap.appendChild(node);
                currentToolBubble = node;
                // 波浪动画
                const waveEl = node.querySelector('.agent-thread-wave');
                if (waveEl) {
                  const waveFrames = ['▁▂▃', '▂▃▄', '▃▄▅', '▄▅▆', '▅▆▇', '▆▅▄', '▅▄▃', '▄▃▂'];
                  let waveIdx = 0;
                  node._waveInterval = setInterval(() => {
                    waveIdx = (waveIdx + 1) % waveFrames.length;
                    waveEl.textContent = waveFrames[waveIdx];
                  }, 100);
                }
                // 平滑的每秒"烹饪"计时器 — 每秒跳动（而不仅仅在
                // 2 秒的后端心跳上），这样长时间运行的工具
                // 始终显示可见的运动，绝不会表现为冻结状态。
                node._startTime = Date.now();
                node._elapsedTicker = setInterval(() => {
                  const hdr2 = node.querySelector('.agent-thread-header');
                  if (!hdr2) return;
                  let el2 = hdr2.querySelector('.agent-thread-elapsed');
                  if (!el2) {
                    el2 = document.createElement('span');
                    el2.className = 'agent-thread-elapsed';
                    // 位于图标之后的左侧。
                    const icon = hdr2.querySelector('.agent-thread-icon');
                    if (icon && icon.nextSibling) hdr2.insertBefore(el2, icon.nextSibling);
                    else hdr2.appendChild(el2);
                  }
                  const s = (Date.now() - node._startTime) / 1000;
                  // 精确到百分之一秒，使亚秒级可见计数（1.00, 1.05, …）。
                  el2.textContent = s < 60 ? `${s.toFixed(2)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(2).padStart(5, '0')}s`;
                }, 50);
                uiModule.scrollHistory();

              } else if (json.type === 'tool_progress') {
                // 长时间运行的子进程（bash、python）仍在
                // 运行中 — 用已运行时间和其 stdout/stderr 的
                // 末尾内容刷新运行中的工具卡片，这样
                // 用户不会盯着一个毫无信息的"运行中…"加载动画。
                if (_isBg) continue;
                if (!currentToolBubble) continue;
                // 每秒跳动计时器（在 tool_start 中启动）拥有
                // 耗时显示；此处我们只展示实时输出的末尾内容。
                const tailStr = (json.tail || '').trim();
                if (tailStr) {
                  let tailEl = currentToolBubble.querySelector('.agent-thread-tail');
                  if (!tailEl) {
                    tailEl = document.createElement('pre');
                    tailEl.className = 'agent-thread-tail';
                    tailEl.style.cssText = 'margin:4px 0 0;padding:6px 8px;font-size:11px;background:rgba(0,0,0,0.18);border-radius:4px;max-height:140px;overflow:auto;white-space:pre-wrap;opacity:0.85;';
                    const content = currentToolBubble.querySelector('.agent-thread-content');
                    if (content) content.appendChild(tailEl);
                  }
                  tailEl.textContent = tailStr;
                  tailEl.scrollTop = tailEl.scrollHeight;
                }
                uiModule.scrollHistory();

              } else if (json.type === 'tool_output') {
                if (_isBg) continue;
                // --- 更新当前线程节点 ---
                if (currentToolBubble) {
                  // 停止波浪动画 + 每秒烹饪跳动计时器
                  if (currentToolBubble._waveInterval) {
                    clearInterval(currentToolBubble._waveInterval);
                    currentToolBubble._waveInterval = null;
                  }
                  if (currentToolBubble._elapsedTicker) {
                    clearInterval(currentToolBubble._elapsedTicker);
                    currentToolBubble._elapsedTicker = null;
                  }
                  const ok = (json.exit_code === 0 || json.exit_code == null);
                  const cmd = json.command || '';
                  let outHtml = '';
                  if (json.output && json.output.trim()) {
                    outHtml = `<details class="agent-tool-output"><summary>Output</summary><pre>${esc(json.output)}</pre></details>`;
                  }
                  // 文件写入差异（write_file）：显示前后统一的差异。
                  let diffHtml = '';
                  if (json.diff && json.diff.text) {
                    const d = json.diff;
                    // 折叠摘要：文件名 + 新增（绿色）/ 删除（红色）。
                    const stat = [
                      d.new_file ? '<span class="diff-stat-new">new</span>' : '',
                      d.added ? `<span class="diff-stat-add">+${d.added}</span>` : '',
                      d.removed ? `<span class="diff-stat-del">−${d.removed}</span>` : '',
                    ].filter(Boolean).join(' ');
                    const rows = d.text.split('\n').map(line => {
                      let cls = 'diff-ctx', text = line;
                      if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-meta';
                      else if (line.startsWith('@@')) cls = 'diff-hunk';
                      // 去除前导的 diff 标记（+/-/空格）— 行颜色
                      // 已经编码了新增/删除，保留它会与
                      // markdown 的 "- " 项目符号重叠（读作 "+-"/"--"）。
                      else if (line.startsWith('+')) { cls = 'diff-add'; text = line.slice(1); }
                      else if (line.startsWith('-')) { cls = 'diff-del'; text = line.slice(1); }
                      else if (line.startsWith(' ')) { text = line.slice(1); }
                      return `<span class="${cls}">${esc(text) || '&nbsp;'}</span>`;
                    }).join('');  // span 是 display:block — 此处的字面 \n 会使 diff 显示为双倍行距
                    diffHtml = `<details class="agent-tool-output agent-tool-diff"><summary><span class="diff-file">${esc(d.file || 'diff')}</span> <span class="diff-summary-stats">${stat}</span></summary><pre class="diff-pre">${rows}</pre></details>`;
                  }
                  // 对于文件编辑，"command" 是原始 JSON 参数 —
                  // 在 diff 旁边是冗余的，所以有 diff 可显示时隐藏它。
                  const cmdHtml2 = (cmd && !(json.diff && json.diff.text)) ? `<pre class="agent-thread-cmd">${esc(cmd)}</pre>` : '';
                  // 在 innerHTML 重写中保留用户的 .open 选择
                  // — 否则展开正在运行的工具会在结果到达时
                  // 立即折叠，迫使用户需要再次
                  // 点击。点击处理以代理方式实现（参见模块
                  // 底部的 init），因此不需要每个节点的监听器。
                  const _wasOpen = currentToolBubble.classList.contains('open');
                  currentToolBubble.className = 'agent-thread-node' + (ok ? '' : ' error') + (_wasOpen ? ' open' : '');
                  currentToolBubble.innerHTML = `<div class="agent-thread-dot"></div><div class="agent-thread-header"><span class="agent-thread-icon">${ok ? '\u2713' : '\u2717'}</span><span class="agent-thread-tool">${esc(json.tool)}</span><span class="agent-thread-status">${ok ? 'done' : 'failed'}</span><span class="agent-thread-chevron">\u25B6</span></div><div class="agent-thread-content">${cmdHtml2}${outHtml}${diffHtml}</div>`;
                  // 重置，使工具间的思考加载动画显示"思考中"而非旧工具的标签
                  _lastToolName = '';
                  uiModule.scrollHistory();
                }
                // --- 内联渲染生成的图片 ---
                if (json.image_url) {
                  const chatBox = document.getElementById('chat-history');
                  chatBox.appendChild(_buildImageBubble(json.image_url, json.image_prompt, json.image_model, json.image_size, json.image_quality, json.image_id));
                  uiModule.scrollHistory();
                  // 通知图片库刷新（如果已打开）
                  window.dispatchEvent(new CustomEvent('gallery-refresh'));
                }
                // --- 在工具输出中渲染浏览器截图 ---
                if (json.screenshot && currentToolBubble) {
                  const contentEl = currentToolBubble.querySelector('.agent-thread-content');
                  if (contentEl) {
                    const screenshotSrc = chatRenderer.safeToolScreenshotSrc(json.screenshot);
                    if (screenshotSrc) {
                      const details = document.createElement('details');
                      details.className = 'agent-tool-output';
                      const summary = document.createElement('summary');
                      summary.textContent = t('chat.screenshot');
                      const img = document.createElement('img');
                      img.src = screenshotSrc;
                      img.style.cssText = 'max-width:100%;border-radius:6px;margin-top:6px;border:1px solid var(--border)';
                      details.appendChild(summary);
                      details.appendChild(img);
                      contentEl.appendChild(details);
                    }
                  }
                }
                // --- manage_session 工具操作后重新加载会话（删除、重命名等） ---
                // 防抖处理，使批量删除不会每次调用都触发 loadSessions
                if (json.tool === 'manage_session' && sessionModule) {
                  if (window._manageSessionTimer) clearTimeout(window._manageSessionTimer);
                  window._manageSessionTimer = setTimeout(() => sessionModule.loadSessions(), 1000);
                }
                // --- manage_calendar 操作后实时刷新日历（添加/编辑/删除） ---
                // 这样新事件无需用户手动刷新就能显示。已做防抖，
                // 使批量事件创建只触发一次重新获取。
                if (json.tool === 'manage_calendar') {
                  if (window._manageCalTimer) clearTimeout(window._manageCalTimer);
                  window._manageCalTimer = setTimeout(
                    () => window.dispatchEvent(new CustomEvent('calendar-refresh')), 600);
                }
                // --- manage_memory 更改后实时刷新记忆 ---
                if (json.tool === 'manage_memory') {
                  if (window._manageMemoryTimer) clearTimeout(window._manageMemoryTimer);
                  window._manageMemoryTimer = setTimeout(
                    () => window.dispatchEvent(new CustomEvent('memory-refresh')), 600);
                }
                // --- 应用工具输出中嵌入的 UI 控制操作 ---
                if (json.ui_event) {
                  chatStream.handleUIControl(json);
                }

                // 在工具轮次之间调度思考加载动画（短暂延迟，这样
                // 同一 SSE 块中的 agent_step 可以在它显示前取消）
                _scheduleThinkingSpinner();
                uiModule.scrollHistory();

              } else if (json.type === 'doc_stream_open') {
                if (_isBg) {
                  // 存储供用户返回此会话时回放
                  var bgDocOpen = _backgroundStreams.get(streamSessionId);
                  if (bgDocOpen) {
                    bgDocOpen._docTitle = json.title || '';
                    bgDocOpen._docLang = json.language || '';
                    bgDocOpen._docContent = '';
                  }
                  continue;
                }
                if (documentModule) {
                  documentModule.streamDocOpen(json.title || '', json.language || '');
                }

              } else if (json.type === 'doc_stream_delta') {
                if (_isBg) {
                  var bgDocDelta = _backgroundStreams.get(streamSessionId);
                  if (bgDocDelta) bgDocDelta._docContent = json.content || '';
                  continue;
                }
                if (documentModule) {
                  documentModule.streamDocDelta(json.content || '');
                }

              } else if (json.type === 'doc_update') {
                // doc_update 表示服务器已将文档保存到数据库。
                if (_isBg) continue;
                if (documentModule) {
                  documentModule.handleDocUpdate(json);
                }

              } else if (json.type === 'doc_suggestions') {
                if (_isBg) continue;
                if (documentModule && documentModule.handleDocSuggestions) {
                  documentModule.handleDocSuggestions(json);
                }

              } else if (json.type === 'ui_control') {
                if (_isBg) continue;
                chatStream.handleUIControl(json.data || {});

              } else if (json.type === 'ask_user') {
                if (_isBg) continue;
                // 代理提出了一个多选题；此轮对话已结束。
                // 在对话历史底部渲染可点击的选项。
                // 用户的选择作为下一条消息发送，代理继续运行。
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                const _aq = json.data || {};
                const _opts = Array.isArray(_aq.options) ? _aq.options : [];
                if (_aq.question && _opts.length) {
                  const chatBox = document.getElementById('chat-history');
                  // 移除任何先前的未回答卡片，只显示最新的。
                  chatBox.querySelectorAll('.ask-user-card').forEach(n => n.remove());
                  const card = document.createElement('div');
                  card.className = 'ask-user-card';
                  const multi = !!_aq.multi;
                  // 为辅助技术分组选项，并使用
                  // 问题标记该组（见下方设置）；使卡片可获得焦点，
                  // 以便在出现时可以导航到它。
                  card.setAttribute('role', 'group');
                  card.tabIndex = -1;
                  // 通过应用管道渲染代理提供文本中的任何 emoji：
                  // 转义，然后 svgify 为单色主题着色的
                  // 符号（项目规则：从不使用彩色 emoji；遵守
                  // "仅文本 Emoji"设置，与聊天的其余部分一致）。
                  const _emo = (s) => svgifyEmoji(uiModule.esc(String(s)));

                  // 标题行包含关闭按钮（×），用于关闭这些UI辅助，
                  // 直接输入回复。
                  const head = document.createElement('div');
                  head.className = 'ask-user-head';
                  const closeBtn = document.createElement('button');
                  closeBtn.type = 'button';
                  closeBtn.className = 'modal-close ask-user-close';
                  closeBtn.setAttribute('aria-label', 'Dismiss question');
                  closeBtn.textContent = '×';
                  closeBtn.addEventListener('click', () => {
                    card.remove();
                    const mi = uiModule.el('message');
                    if (mi) mi.focus();
                  });
                  head.appendChild(closeBtn);
                  card.appendChild(head);

                  // 在卡片内渲染问题，使其自包含：
                  // 一些模型调用 ask_user 时不会先叙述问题
                  // 作为助手文本，这种情况下卡片会显示
                  // 孤立的选项，没有提示。
                  if (_aq.question) {
                    const q = document.createElement('div');
                    q.className = 'ask-user-question';
                    q.id = `ask-user-q-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
                    q.innerHTML = _emo(_aq.question);
                    card.appendChild(q);
                    // 为读屏软件用问题标记选项组。
                    card.setAttribute('aria-labelledby', q.id);
                  } else {
                    card.setAttribute('aria-label', 'Question from the assistant');
                  }

                  const list = document.createElement('div');
                  list.className = 'ask-user-options';
                  card.appendChild(list);

                  const _send = (text) => {
                    if (!text) return;
                    // 回答后移除卡片 — 选择作为
                    // 普通用户消息发送（问题作为上面的
                    // 助手文本保留），因此辅助功能已消耗完成。
                    card.remove();
                    const mi = uiModule.el('message');
                    if (mi) mi.value = text;
                    const sb = document.querySelector('.send-btn');
                    if (sb) sb.click();
                  };

                  _opts.forEach((opt, i) => {
                    const label = (opt && opt.label) ? String(opt.label) : String(opt || '');
                    if (!label) return;
                    const descr = (opt && opt.description) ? String(opt.description) : '';
                    const row = document.createElement(multi ? 'label' : 'button');
                    row.className = 'ask-user-option';
                    if (multi) {
                      const cb = document.createElement('input');
                      cb.type = 'checkbox';
                      cb.value = label;
                      row.appendChild(cb);
                    }
                    const txt = document.createElement('span');
                    txt.className = 'ask-user-option-label';
                    txt.innerHTML = _emo(label);
                    row.appendChild(txt);
                    if (descr) {
                      const d = document.createElement('span');
                      d.className = 'ask-user-option-desc';
                      d.innerHTML = _emo(descr);
                      row.appendChild(d);
                    }
                    if (!multi) {
                      row.type = 'button';
                      row.addEventListener('click', () => _send(label));
                    }
                    list.appendChild(row);
                  });

                  // 自由文本"其他" — 输入自定义答案并发送（回车或→键）。
                  const other = document.createElement('div');
                  other.className = 'ask-user-other';
                  const otherInput = document.createElement('input');
                  otherInput.type = 'text';
                  otherInput.className = 'styled-prompt-input ask-user-other-input';
                  otherInput.placeholder = multi ? 'Other (added to selection)…' : 'Other… (type your own answer)';
                  otherInput.setAttribute('aria-label', multi ? 'Add a custom option' : 'Type a custom answer');
                  const otherSend = document.createElement('button');
                  otherSend.type = 'button';
                  otherSend.className = 'confirm-btn confirm-btn-primary ask-user-other-send';
                  otherSend.setAttribute('aria-label', 'Send answer');
                  otherSend.textContent = multi ? 'Send selection' : 'Send';
                  const _submit = () => {
                    const free = otherInput.value.trim();
                    if (multi) {
                      const picked = Array.from(card.querySelectorAll('.ask-user-option input:checked')).map(c => c.value);
                      if (free) picked.push(free);
                      if (picked.length) _send(picked.join(', '));
                    } else if (free) {
                      _send(free);
                    }
                  };
                  otherSend.addEventListener('click', _submit);
                  otherInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                      e.preventDefault();
                      _submit();
                    }
                  });
                  other.appendChild(otherInput);
                  other.appendChild(otherSend);
                  card.appendChild(other);

                  chatBox.appendChild(card);
                  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  // 将焦点移到卡片上，使键盘/读屏软件用户能在
                  // 问题和选项出现时直接落入其中。
                  try { card.focus(); } catch (_) {}
                }

              } else if (json.type === 'plan_update') {
                if (_isBg) continue;
                // 代理回写了计划（勾选了一步/修订）。更新
                // 存储的计划 + 实时刷新停靠的计划窗口。
                const _pu = (json.data && json.data.plan) ? json.data.plan : '';
                if (_pu) _setStoredPlan(_pu);

              } else if (json.type === 'agent_step') {
                if (_isBg) continue;
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                _renderStream();
                // 将线程标记为连接到下方的气泡
                const _activeThread = document.querySelector('.agent-thread.streaming');
                if (_activeThread) {
                  _activeThread.classList.add('has-bottom');
                }
                // --- 新一轮：创建带有加载动画的新 AI 气泡 ---
                currentToolBubble = null;
                roundFinalized = false;
                isThinking = false;
                _docFenceOpened = false;
                _docFenceContentStart = -1;
                const box = document.getElementById('chat-history');
                const newWrap = document.createElement('div');
                newWrap.className = 'msg msg-ai msg-continuation streaming';
                // 添加模型名称标签
                const newRole = document.createElement('div');
                newRole.className = 'role';
                const metaS = sessionModule.getSessions().find(s => s.id === streamSessionId);
                const _roundRequested = holder?._requestedModel || metaS?.model;
                const _roundActual = holder?._actualModel || _roundRequested;
                newRole.textContent = _modelRouteLabel(_roundRequested, _roundActual) || '';
                _applyModelColor(newRole, _roundActual);
                newWrap.appendChild(newRole);
                const newBody = document.createElement('div');
                newBody.className = 'body';
                newWrap.appendChild(newBody);
                box.appendChild(newWrap);
                roundHolder = newWrap;
                roundText = '';
                // 创建新的之前先销毁任何之前的加载动画
                if (spinner && spinner.element) spinner.destroy();
                // 等待文字时显示加载动画（研究跳过一次 — 有自己的进度）
                if (!_researchingStreamIds.has(streamSessionId)) {
                  spinner = spinnerModule.create('Generating response', 'right', 'wave');
                  newBody.appendChild(spinner.createElement());
                  spinner.start();
                }
                if (streamingTTS) window.aiTTSManager._streamSentencesSent = 0;
                uiModule.scrollHistory();
              } else if (json.type === 'budget_exceeded') {
                if (_isBg) continue;
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                const budgetDiv = document.createElement('div');
                budgetDiv.style.cssText = 'font-size:11px;opacity:0.6;font-style:italic;padding:4px 8px;margin:4px 0;';
                budgetDiv.textContent = `Tool budget reached (${json.used}/${json.limit} calls). Agent stopped.`;
                const chatBox = document.getElementById('chat-history');
                chatBox.appendChild(budgetDiv);

              } else if (json.type === 'teacher_takeover') {
                if (_isBg) continue;
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                // 完成任何正在传输中的气泡，使接管横幅
                // 区分学生尝试和教师尝试。
                if (spinner && spinner.element) { try { spinner.destroy(); } catch(_){} spinner = null; }
                const chatBox = document.getElementById('chat-history');
                const banner = document.createElement('div');
                banner.className = 'teacher-takeover-banner';
                banner.style.cssText = 'margin:10px 0;padding:8px 12px;border-left:3px solid #c08a3e;background:rgba(192,138,62,0.08);font-size:12px;color:var(--fg);border-radius:4px;';
                const teacherName = json.teacher_model || 'teacher';
                const why = json.student_failure ? ` &mdash; <span style="opacity:0.7">${esc(json.student_failure)}</span>` : '';
                banner.innerHTML = t('chat.teacher_takeover', { name: esc(teacherName), reason: why });
                chatBox.appendChild(banner);
                // 重置轮次气泡状态，使教师的第一条文字开始一个新气泡
                roundHolder = null;
                roundText = '';
                roundFinalized = false;
                currentToolBubble = null;
                uiModule.scrollHistory();

              } else if (json.type === 'skill_saved') {
                if (_isBg) continue;
                const chatBox = document.getElementById('chat-history');
                const note = document.createElement('div');
                note.className = 'skill-saved-note';
                note.style.cssText = 'margin:6px 0;padding:6px 10px;border-left:3px solid #4a8a4a;background:rgba(74,138,74,0.07);font-size:12px;color:var(--fg);border-radius:4px;';
                note.innerHTML = t('chat.skill_learned', { name: '<code>' + esc(json.name || '') + '</code>', category: json.category ? ' <span style="opacity:0.6">[' + esc(json.category) + ']</span>' : '' });
                chatBox.appendChild(note);
                uiModule.scrollHistory();

              } else if (json.type === 'escalation_failed' || json.type === 'skill_save_failed') {
                if (_isBg) continue;
                const chatBox = document.getElementById('chat-history');
                const note = document.createElement('div');
                note.className = 'escalation-failed-note';
                note.style.cssText = 'margin:6px 0;padding:6px 10px;border-left:3px solid #8a4a4a;background:rgba(138,74,74,0.07);font-size:12px;color:var(--fg);border-radius:4px;';
                const label = json.type === 'escalation_failed' ? 'Teacher could not solve it' : 'Skill not saved';
                note.innerHTML = `<strong>${label}:</strong> <span style="opacity:0.75">${esc(json.reason || '')}</span>`;
                chatBox.appendChild(note);
                uiModule.scrollHistory();

              } else if (json.error) {
                // --- 后端错误（超时、连接问题等） ---
                console.error('Stream error from backend:', json.error);
                if (_isBg) continue;
                if (spinner && spinner.element) spinner.destroy();
                const errDiv = document.createElement('div');
                errDiv.style.cssText = 'color: var(--color-error); font-style: italic; padding: 4px 0;';
                errDiv.textContent = `[Error: ${json.error}]`;
                roundHolder.querySelector('.body').appendChild(errDiv);
                uiModule.scrollHistory();
              }
            } catch (e) {
              console.error('Error parsing SSE data:', e);
            }
          }
        }
      }

      if (!_streamSawDone) {
        throw new Error('Stream closed before completion');
      }

      _renderStream();
      _cancelThinkingTimer();
      _removeThinkingSpinner();
      // 停止所有线程脉冲动画
      document.querySelectorAll('.agent-thread.streaming').forEach(t => t.classList.remove('streaming'));
      // --- 最终渲染（如果流曾经进入后台或当前在后台则跳过） ---
      // 从所有轮次气泡中移除流式传输类
      holder.classList.remove('streaming');
      if (roundHolder && roundHolder !== holder) roundHolder.classList.remove('streaming');

      const _isBgFinal = (sessionModule.getCurrentSessionId() !== streamSessionId) || _backgroundStreams.has(streamSessionId);
      if (!_isBgFinal) {
        finalMeta = sessionModule.getSessions().find(s => s.id === sessionModule.getCurrentSessionId());
        const _finalActualModel = metrics?.model || holder._actualModel || finalMeta?.model;
        const _finalRequestedModel = metrics?.requested_model || holder._requestedModel || finalMeta?.model || _finalActualModel;
        // 如果设置了角色名称则前置
        var _charNameFinal = presetsModule.getCharacterName ? presetsModule.getCharacterName() : '';
        const roleEl = holder.querySelector('.role');
        if (roleEl) {
          _setRoleModelLabel(roleEl, _finalRequestedModel, _finalActualModel, {
            suffix: holder._roleSuffix,
            characterName: _charNameFinal || holder._characterName,
          });
        }
        holder.dataset.raw = accumulated;

        // 防停滞：运行了工具但几乎没有输出
        // 最终文字的轮次通常意味着模型在半途中停止（那种
        // 需要输入"你完成了吗？"的情况）。提供一个一键
        // 继续按钮，从停止的地方精确恢复 — 复用与
        // 用户停止"[消息已中断]"按钮相同的恢复机制。
        try {
          const _usedTools = holder.querySelector('.agent-thread-node');
          const _proseLen = (accumulated || '').replace(/<[^>]*>/g, '').trim().length;
          if (_usedTools && _proseLen < 24 && !holder.querySelector('.agent-continue-btn')) {
            const _stall = document.createElement('div');
            _stall.className = 'stopped-indicator';
            const _lbl = document.createElement('span');
            _lbl.style.cssText = 'font-style:italic;opacity:0.7;';
            _lbl.textContent = t('chat.paused_mid_task');
            _stall.appendChild(_lbl);
            const _cont = document.createElement('button');
            _cont.className = 'continue-btn agent-continue-btn';
            _cont.title = t('chat.continue_pickup');
            _cont.textContent = '▸';
            _cont.addEventListener('click', () => {
              _stall.remove();
              const mi = uiModule.el('message');
              if (mi) {
                mi.value = 'Continue — you stopped before finishing. Pick up exactly where you left off and complete the task.';
                const sb = document.querySelector('.send-btn');
                if (sb) sb.click();
              }
            });
            _stall.appendChild(_cont);
            (holder.querySelector('.body') || holder).appendChild(_stall);
          }
        } catch (_) {}

        // 清除流式传输 minHeight 锁定
        const _streamContent = roundHolder.querySelector('.stream-content');
        if (_streamContent) _streamContent.style.minHeight = '';

        // 完成最后一轮的气泡 — 展平流内容包装器以获得干净的 DOM
        const finalDisplay = stripToolBlocks(roundText);
        if (finalDisplay.trim()) {
          var _body4 = roundHolder.querySelector('.body');
          // 在最终渲染前保留信息源展开状态
          var _wasExpanded = _sourcesExpanded || !!(_body4 && _body4.querySelector('.sources-content.expanded'));

          // 如果思考在流式传输中被就地折叠，保留它
          var _liveReplyEl = _body4 && _body4.querySelector('.live-reply-content');
          var _extracted = _liveReplyEl ? markdownModule.extractThinkingBlocks(finalDisplay) : null;
          var _finalReply = '';
          if (_liveReplyEl) {
            // 先尝试标准提取（用于原生 <think> 标签）
            if (_extracted?.thinkingBlocks?.length) {
              _finalReply = (_extracted.content || '').trim();
            } else {
              // 非标签思考：从原始文本中提取回复
              // 处理错乱的思考标签："Thinking: reasoning\n<think>reply"
              const _garbledMatch = finalDisplay.match(/^[\s\S]+?<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>\s*([\s\S]*?)(?:<\/(?:think(?:ing)?|thought)>)?\s*$/i);
              if (_garbledMatch && _garbledMatch[1].trim()) {
                _finalReply = _garbledMatch[1].trim();
              } else {
                // 纯非标签：通过前缀模式找到回复边界
                const _rs2 = ['Hey', 'Hi ', 'Hi!', 'Hello', 'Sure', 'Yes', 'No ', 'No,', 'Yo', 'OK', 'Here', 'Absolutely', 'Of course', 'Great', 'Alright', 'Thanks', 'Welcome', 'Good ', "I'm happy", "I'd be"];
                const _fr = (finalDisplay || '').trimStart();
                if (markdownModule.startsWithReasoningPrefix(_fr)) {
                  const _fLines = _fr.split('\n');
                  for (let _fi = 1; _fi < _fLines.length; _fi++) {
                    const _fl = _fLines[_fi].trim();
                    if (!_fl) continue;
                    if (_rs2.some(rp => _fl.startsWith(rp))) { _finalReply = _fLines.slice(_fi).join('\n'); break; }
                  }
                  // 行内检查
                  if (!_finalReply) {
                    for (const rp of _rs2) {
                      const rx = new RegExp('[.!?]\\s*(' + rp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')');
                      const m = rx.exec(_fr);
                      if (m && m.index > 20) { _finalReply = _fr.slice(m.index + 1).trim(); break; }
                    }
                  }
                }
              }
            }
          }
          if (_liveReplyEl && _finalReply) {
            // 将回复渲染到实时回复容器中（思考栏已在显示）
            var _replyHtml = markdownModule.mdToHtml(markdownModule.squashOutsideCode(_finalReply));
            _liveReplyEl.innerHTML = _replyHtml;
            _liveReplyEl.classList.remove('live-reply-content');
            if (_sourcesData) {
              var _srcEl = document.createElement('div');
              _srcEl.innerHTML = _buildSourcesBox(_sourcesData, _sourcesType, _wasExpanded);
              _body4.insertBefore(_srcEl.firstChild || _srcEl, _body4.firstChild);
            }
            if (_findingsData) _body4.insertAdjacentHTML('beforeend', chatRenderer.buildFindingsBox(_findingsData));
          } else {
            // 完全重新渲染（回复为空或无实时回复容器）
            _body4.innerHTML = (_sourcesData ? _buildSourcesBox(_sourcesData, _sourcesType, _wasExpanded) : '')
              + markdownModule.processWithThinking(markdownModule.squashOutsideCode(finalDisplay))
              + (_findingsData ? chatRenderer.buildFindingsBox(_findingsData) : '');
          }
        } else if (_sourcesHtml) {
          var _body4b = roundHolder.querySelector('.body');
          var _wasExpanded2 = _sourcesExpanded || !!(_body4b && _body4b.querySelector('.sources-content.expanded'));
          _body4b.innerHTML = _sourcesData ? _buildSourcesBox(_sourcesData, _sourcesType, _wasExpanded2) : _sourcesHtml;
        } else if (roundHolder !== holder) {
          // 检查是否有值得展示的思考内容
          const _thinkingOnly = markdownModule.extractThinkingBlocks(roundText);
          if (_thinkingOnly.thinkingBlocks?.length && !_thinkingOnly.content) {
            // 即使没有可见的回复文字，也在折叠区域中显示思考
            const _body4c = roundHolder.querySelector('.body');
            if (_body4c) _body4c.innerHTML = markdownModule.processWithThinking(roundText);
          } else {
            roundHolder.style.display = 'none';
            // 上面的线程期望下方有气泡 — 移除 has-bottom，因为气泡被隐藏了
            const _lastThread = roundHolder.previousElementSibling;
            if (_lastThread && _lastThread.classList.contains('agent-thread')) {
              _lastThread.classList.remove('has-bottom');
            }
          }
        }


        if (window.hljs) {
          roundHolder.querySelectorAll('pre code').forEach((block) => {
            window.hljs.highlightElement(block);
          });
        }
        if (markdownModule.renderMermaid) markdownModule.renderMermaid(roundHolder);

        uiModule.scrollHistory();
        // 如果存在 RAG 信息源则渲染
        if (holder._ragSources && holder._ragSources.length) {
          const details = document.createElement('details');
          details.className = 'rag-sources';
          const summary = document.createElement('summary');
          summary.textContent = `Sources (${holder._ragSources.length} documents)`;
          details.appendChild(summary);
          holder._ragSources.forEach(src => {
            const item = document.createElement('div');
            item.className = 'rag-source-item';
            const _esc = uiModule.esc;
            item.innerHTML = `<strong>${_esc(src.filename)}</strong> <span class="rag-similarity">${(src.similarity * 100).toFixed(1)}%</span><div class="rag-snippet">${_esc(src.snippet)}</div>`;
            details.appendChild(item);
          });
          holder.querySelector('.body').appendChild(details);
        }

        // 隐藏第一个气泡如果没有可见文字内容（例如代理直接使用工具）
        if (holder !== roundHolder && holder.style.display !== 'none') {
          const _hBody = holder.querySelector('.body');
          const _hText = _hBody ? _hBody.textContent.trim() : '';
          if (!_hText) holder.style.display = 'none';
        }

        // 将页脚附加到最后一个可见气泡（多轮代理用 roundHolder，单轮用 holder）
        const footerTarget = (roundHolder && roundHolder !== holder && roundHolder.style.display !== 'none') ? roundHolder : holder;
        footerTarget.appendChild(createMsgFooter(footerTarget));
        // 为已完成的研究添加"查看报告"链接
        if (_researchingStreamIds.has(streamSessionId)) {
          _appendViewReportLink(footerTarget, streamSessionId);
        }
        // 也将原始文本存储到页脚目标上，使复制/TTS 正常工作
        if (footerTarget !== holder) footerTarget.dataset.raw = accumulated;
        if (addAITTSButton && accumulated && window.aiTTSManager?._provider !== 'disabled' && window.aiTTSManager?.available) {
          addAITTSButton(footerTarget, accumulated);
        }
        // TTS 自动播放：流式模式刷新剩余文本，非流式模式将完整消息入队
        if (accumulated && window.aiTTSManager && window.aiTTSManager.autoPlay) {
          const ttsBtn = holder.querySelector('.ai-tts-button');
          if (ttsBtn) {
            var ICON_PLAY_TTS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
            var ICON_STOP_TTS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
            const resetFn = () => {
              ttsBtn.innerHTML = ICON_PLAY_TTS;
              ttsBtn.classList.remove('playing', 'loading');
              ttsBtn.style.color = '#6b7280';
              ttsBtn.title = t('chat.read_aloud');
            };
            if (streamingTTS) {
              // 刷新剩余的不完整句子并附加真实按钮
              window.aiTTSManager.streamingEnd(accumulated);
              window.aiTTSManager.streamingAttachButton(ttsBtn, resetFn);
              // 如果仍在播放流中的句子，显示停止图标
              if (window.aiTTSManager.isPlaying || window.aiTTSManager._processing) {
                ttsBtn.innerHTML = ICON_STOP_TTS;
                ttsBtn.classList.add('playing');
                ttsBtn.style.color = '#ccc';
                ttsBtn.title = t('chat.stop');
              }
            } else {
              // 非流式回退（例如中途切换了 autoPlay）
              window.aiTTSManager.enqueue(accumulated, ttsBtn, resetFn);
            }
          }
        }
        if (metrics) {
          displayMetrics(footerTarget, metrics);
        }
        // 如果这是重新生成，则附加变体导航
        _attachVariantNav(footerTarget);

        // 如果这是继续操作，则与之前的停止消息合并
        if (_pendingContinue) {
          const prevEl = _pendingContinue;
          _pendingContinue = null;
          const prevBody = prevEl.querySelector('.body');
          const newBody = footerTarget.querySelector('.body');
          if (prevBody && newBody && prevEl.parentNode) {
            // 合并：将原始文本与 *(已继续)* 标记组合
            const oldRaw = prevEl.dataset.raw || '';
            const newRaw = footerTarget.dataset.raw || '';
            const mergedRaw = oldRaw + '\n\n*(continued)*\n\n' + newRaw;
            prevEl.dataset.raw = mergedRaw;
            // 重新渲染合并的内容
            prevBody.innerHTML = markdownModule.processWithThinking(
              markdownModule.squashOutsideCode(mergedRaw)
            );
            // 移除新气泡并重新添加页脚到合并的气泡
            footerTarget.remove();
            const oldFooter = prevEl.querySelector('.msg-footer');
            if (oldFooter) oldFooter.remove();
            prevEl.appendChild(createMsgFooter(prevEl));
            if (window.hljs) {
              prevEl.querySelectorAll('pre code').forEach(block => window.hljs.highlightElement(block));
            }

            // 将合并持久化到服务器
            const sid = sessionModule.getCurrentSessionId();
            if (sid) {
              fetch(`${API_BASE}/api/session/${sid}/merge-last-assistant`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ separator: '\n\n*(continued)*\n\n' })
              }).catch(e => console.warn('merge-last-assistant failed:', e));
            }
          }
        }
      } // 结束 if (!_isBgFinal)

    } catch (err) {
      _renderStream();
      // 清理所有活动的加载动画（例如工具调用期间的"正在生成响应"）
      if (spinner && spinner.element) spinner.destroy();
      _cancelThinkingTimer();
      _removeThinkingSpinner();
      document.querySelectorAll('.agent-thread.streaming').forEach(t => t.classList.remove('streaming'));
      // 检查此流是否在后台运行
      const _isBgCatch = (sessionModule.getCurrentSessionId() !== streamSessionId) || _backgroundStreams.has(streamSessionId);

      if (_isBgCatch) {
        // 后台时发生错误 — 更新 map，不触碰 DOM
        console.error('Background stream error:', err);
        var bgErr = _backgroundStreams.get(streamSessionId);
        if (bgErr && bgErr.status === 'completed') {
          // [DONE] 已被处理 — 此错误无害（例如 close 之后的 reader.read()）
          // 不覆盖完成状态；只确保完成标记点保持不变
          if (sessionModule && sessionModule.clearStreaming) {
            sessionModule.clearStreaming(streamSessionId);
          }
        } else if (bgErr) {
          bgErr.status = 'error';
          if (sessionModule && sessionModule.clearStreaming) {
            sessionModule.clearStreaming(streamSessionId);
          }
        }
      } else {
        // 在任何错误/中断时停止流式 TTS
        if (streamingTTS && window.aiTTSManager) window.aiTTSManager.stop();

        if (currentAbort && currentAbort.signal.aborted) {
          const abortReason = currentAbort._reason || '';
          // 超时触发的中断应保持可见，而不是消失。
          if (timedOut || abortReason === 'timeout') {
            const timeoutMsg = _isAgent
              ? 'Agent response timed out. Try again, switch to a faster model, or reduce tool usage.'
              : 'Response timed out. Try again.';

            if (holder && !accumulated) {
              holder.querySelector('.body').innerHTML =
                `<div style="color: var(--color-error); font-style: italic; padding: 4px 0;">[${timeoutMsg}]</div>`;
            } else if (holder && accumulated) {
              const timeoutNote = document.createElement('div');
              timeoutNote.className = 'stopped-indicator';
              timeoutNote.innerHTML =
                `<span style="color: var(--color-error);">[${timeoutMsg}]</span>`;
              holder.querySelector('.body').appendChild(timeoutNote);
            }
            currentAbort = null;
            return;
          }

          if (abortReason === 'offline') {
            const offlineMsg = 'Endpoint offline — switch model or try again.';
            if (holder && !accumulated) {
              holder.querySelector('.body').innerHTML =
                `<div style="color: var(--color-error); font-style: italic; padding: 4px 0;">[${offlineMsg}]</div>`;
            } else if (holder && accumulated) {
              const offlineNote = document.createElement('div');
              offlineNote.className = 'stopped-indicator';
              offlineNote.innerHTML =
                `<span style="color: var(--color-error);">[${offlineMsg}]</span>`;
              holder.querySelector('.body').appendChild(offlineNote);
            }
            currentAbort = null;
            return;
          }

          if (abortReason === 'recovery') {
            const recoveryMsg = 'Streaming was interrupted after the tab went inactive. Partial output was preserved.';
            if (holder && !accumulated) {
              holder.querySelector('.body').innerHTML =
                `<div style="color: var(--color-error); font-style: italic; padding: 4px 0;">[${recoveryMsg}]</div>`;
            } else if (holder && accumulated) {
              const recoveryNote = document.createElement('div');
              recoveryNote.className = 'stopped-indicator';
              recoveryNote.innerHTML =
                `<span style="color: var(--color-error);">[${recoveryMsg}]</span>`;
              holder.querySelector('.body').appendChild(recoveryNote);
            }
            currentAbort = null;
            return;
          }

          // 用户发起的停止（或浏览器导航中断）。
          // 在任何文字到达前停止 — 将气泡保留为
          // "用户已取消"记录（以便刷新后仍然保留）。
          if (holder && !accumulated) {
            _renderCancelledBubble(holder);
          }

          // 但如果停止按钮没有渲染它，就在这里渲染
          if (holder && accumulated && !currentHolder) {
            holder.dataset.raw = accumulated;
            holder.querySelector('.body').innerHTML = markdownModule.processWithThinking(
              markdownModule.squashOutsideCode(accumulated)
            );

            if (window.hljs) {
              holder.querySelectorAll('pre code').forEach((block) => {
                window.hljs.highlightElement(block);
              });
            }

            const stoppedIndicator = document.createElement('div');
            stoppedIndicator.className = 'stopped-indicator';
            const stoppedLabel = document.createElement('span');
            stoppedLabel.textContent = t('chat.message_interrupted');
            stoppedIndicator.appendChild(stoppedLabel);
            const continueBtn = document.createElement('button');
            continueBtn.className = 'continue-btn';
            continueBtn.title = t('chat.continue');
            continueBtn.textContent = '\u25B8';
            continueBtn.addEventListener('click', () => {
              stoppedIndicator.remove();
              _hideUserBubble = true;
              _pendingContinue = holder;
              const cutoff = accumulated;
              const msgInput = uiModule.el('message');
              if (msgInput) {
                msgInput.value = 'Your previous response was interrupted. It ended with:\n\n' + cutoff.slice(-500) + '\n\nDo NOT repeat what you already said. Continue exactly from where you were cut off.';
                const sb = document.querySelector('.send-btn');
                if (sb) sb.click();
              }
            });
            stoppedIndicator.appendChild(continueBtn);
            holder.querySelector('.body').appendChild(stoppedIndicator);

            // 告知服务端将此消息标记为已停止
            const _sid2 = sessionModule.getCurrentSessionId();
            if (_sid2) fetch(`${API_BASE}/api/session/${_sid2}/mark-stopped`, { method: 'POST' }).catch(e => console.warn('mark-stopped failed:', e));

            if (!holder.querySelector('.msg-footer')) {
              holder.appendChild(createMsgFooter(holder));
            }

            uiModule.scrollHistory();
          }

          // 现在清除中断控制器
          currentAbort = null;
        } else {
          console.error(err);
          // 流中断但工具节点仍在旋转。其每个节点的跳动器
          // （_elapsedTicker 50ms / _waveInterval 100ms）通常在
          // `tool_output` 中清理，但现在永远等不到了 — 不清理的话
          // 它们会在孤立节点上永远触发（而自动恢复会每次
          // 推动加剧）。此处安全：自动恢复的新发送延迟 200ms，
          // 因此目前没有新运行节点存在。
          document.querySelectorAll('.agent-thread-node.running').forEach(node => {
            if (node._waveInterval) { clearInterval(node._waveInterval); node._waveInterval = null; }
            if (node._elapsedTicker) { clearInterval(node._elapsedTicker); node._elapsedTicker = null; }
            node.classList.remove('running');
          });
          // 流意外中断 — "静默死亡"情况。立即使用完成握手
          // 重新连接模型（无需等待），上限为
          // 上限值。仅对连接类故障自动恢复；确定性的
          // 错误（不支持的工具栏、4xx/5xx、解析失败）立即显示，
          // 而不是在注定失败的重试上消耗推动配额。
          if (!(_isRecoverableStreamErr(err) && _tryAutoRecover(holder, accumulated, streamSessionId))) {
            const errorHolder = document.querySelector('.msg-ai:last-of-type .body');
            if (errorHolder) {
              let errMsg = `Error: ${err.message}`;
              // 为工具调用错误添加提示
              if (err.message && (err.message.includes('tool') || err.message.includes('auto'))) {
                errMsg += '\n\nThis model may not support tools — try switching to Chat mode.';
              }
              typewriterInto(errorHolder, errMsg);
            }
          }
        }
      }
    } finally {
      clearResponseTimeout();
      clearProcessingProbe();
      // 流式传输完成 — 让读屏软件播报稳定后的响应。
      const _chatLogDone = document.getElementById('chat-history');
      if (_chatLogDone) _chatLogDone.setAttribute('aria-busy', 'false');
      // 无论后台状态如何，始终清理研究跟踪
      _researchingStreamIds.delete(streamSessionId);
      if (_researchingStreamIds.size === 0) {
        var _rToggleCleanup = document.getElementById('research-toggle-btn');
        if (_rToggleCleanup) _rToggleCleanup.classList.remove('research-running');
      }

      // 仅在仍在流的会话上且从未进入过后台时重置 UI 状态
      const _isBgFinally = (sessionModule.getCurrentSessionId() !== streamSessionId) || _backgroundStreams.has(streamSessionId);

      if (!_isBgFinally) {
        // 将按钮重置为空闲状态
        updateSubmitButton('idle', submitBtn);

        // 重新启用消息输入框；移动端上 blur 以关闭键盘
        if (messageInput) {
          messageInput.disabled = false;
          if (window.innerWidth <= 768) {
            messageInput.blur();
          } else {
            messageInput.focus();
          }
        }

        // 清除跟踪变量
        currentAccumulated = '';
        currentHolder = null;
        currentSpinner = null;
        _researchingStreamIds.delete(streamSessionId);
        // 如果没有更多活跃的研究则清除研究运行高亮
        if (_researchingStreamIds.size === 0) {
          var _rToggle2 = document.getElementById('research-toggle-btn');
          if (_rToggle2) _rToggle2.classList.remove('research-running');
        }
        _clearResearchTimer();

        // 重新启用研究按钮，使用后自动取消勾选
        // （如果是澄清轮次则跳过 — 保持开关开启以便跟进）
        const _el = uiModule.el;
        const _researchBtn = _el('research-toggle-btn');
        const _researchToggle = _el('research-toggle');
        if (_researchToggle && _researchToggle.checked) {
          _researchToggle.checked = false;
          Storage.setToggle('research', false);
        }
        if (_researchBtn) {
          _researchBtn.disabled = false;
          _researchBtn.classList.remove('active');
          _researchBtn.style.display = 'none';
        }
        // 也同步溢出按钮和工具侧边栏按钮
        const _overflowRes = _el('overflow-research-btn');
        if (_overflowRes) _overflowRes.classList.remove('active');
        const _toolRes = _el('tool-research-btn');
        if (_toolRes) _toolRes.classList.remove('active');

      }

      // 研究澄清超时 — 如果用户 5 分钟内未回复，显示超时
      if (holder && holder._roleSuffix === 'Research' && !_researchingStreamIds.has(streamSessionId)) {
        var _timeoutSessionId = streamSessionId;
        var _timeoutTimer = setTimeout(async function() {
          // 检查 research_pending 是否仍处于活动状态（用户尚未回复）
          try {
            var _box = document.getElementById('chat-history');
            if (_box && sessionModule.getCurrentSessionId() === _timeoutSessionId) {
              var _timeoutMsg = document.createElement('div');
              _timeoutMsg.className = 'msg msg-ai';
              _timeoutMsg.innerHTML = '<div class="role">Odysseus</div><div class="body" style="opacity:0.6;font-style:italic;">' + t('chat.research_timeout') + '</div>';
              _box.appendChild(_timeoutMsg);
              uiModule.scrollHistory();
            }
          } catch(_te) {}
        }, 5 * 60 * 1000);
        // 用户发送消息时取消超时
        var _origSubmit = window._researchTimeoutTimer;
        if (_origSubmit) clearTimeout(_origSubmit);
        window._researchTimeoutTimer = _timeoutTimer;
      }

      // 释放 Web Lock
      if (_webLockRelease) {
        _webLockRelease();
        _webLockRelease = null;
      }

      // 延迟后刷新会话列表（获取自动生成的名称）
      setTimeout(() => {
        if (sessionModule && sessionModule.loadSessions) {
          sessionModule.loadSessions();
        }
      }, 3000);
    }
  }

  /**
   * 中止当前聊天请求
   */
  // stopServer=true 仅用于显式用户停止。运行现在是分离的
  // （在标签页关闭/导航后仍然存在），因此清理路径
  // （会话切换、删除、标签页关闭时的读取器清理）使用的通用中断决不能
  // 停止服务端运行 — 否则关闭标签页会终止后台任务，
  // 完全破坏了设计目的。只有停止按钮取消服务端运行。
  export function abortCurrentRequest(stopServer = false) {
    if (currentAbort) {
      currentAbort.abort();
      // 此处不要设为 null - 让 catch 块处理
    }
    if (stopServer) {
      try {
        const _sid = _streamSessionId
          || (window.sessionModule && window.sessionModule.getCurrentSessionId && window.sessionModule.getCurrentSessionId());
        if (_sid) {
          fetch(`/api/chat/stop/${encodeURIComponent(_sid)}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
        }
      } catch (_) {}
    }
  }

  // ── 停滞看门狗 ──────────────────────────────────────────────
  // 自动恢复流中断（连接断开）或静默的对话轮次：
  // 保留部分内容，然后通过复用现有的继续/恢复路径
  // 重新提交完成握手。达到上限时返回 false，
  // 使调用方可以呈现失败，而不是无限推动。
  // 仅对连接类故障（真正的"静默
  // 死亡"情况）自动恢复。确定性错误 — 不支持的工具栏、HTTP 4xx/5xx、
  // JSON 解析失败 — 在重试时会同样失败，因此
  // 立即显示它们既更诚实，也避免浪费推动配额。
  function _isRecoverableStreamErr(err) {
    if (!err) return false;
    if (err.name === 'TypeError') return true;   // fetch/reader 网络故障
    const m = (err.message || '').toLowerCase();
    if (/\btool\b|unsupported|json|parse|\b4\d\d\b|\b5\d\d\b/.test(m)) return false;
    return /network|fetch|connection|reset|closed|aborted|stream|tim(?:e|ed)\s?out|econn|eof/.test(m);
  }

  function _tryAutoRecover(holder, accumulated, sessionId) {
    if (_autoNudges >= _AUTO_NUDGE_CAP) return false;
    _autoNudges++;
    if (holder && accumulated) {
      holder.dataset.raw = accumulated;
      try {
        holder.querySelector('.body').innerHTML =
          markdownModule.processWithThinking(markdownModule.squashOutsideCode(accumulated));
      } catch (_) {}
    }
    _pendingContinue = holder || null;   // 将继续操作合并到同一个气泡中
    _hideUserBubble = true;              // 握手不显示用户气泡
    _autoContinuePending = true;         // 此次提交时不重置计数器
    const _abandon = () => {             // 清除待处理标志，使它们不会
      _pendingContinue = null;           // 泄漏到当前打开的任何聊天中
      _hideUserBubble = false;
      _autoContinuePending = false;
    };
    // 延迟执行，使流的 finally 先重置状态 — 否则发送
    // 按钮仍在"停止"模式，点击它会切换，而非发送。
    setTimeout(() => {
      // 中断的流可能不是用户当前正在看的聊天 —
      // 绝不要将恢复握手注入到错误的对话中。
      if (sessionId && sessionModule.getCurrentSessionId() !== sessionId) { _abandon(); return; }
      const msgInput = uiModule.el('message');
      const sb = document.querySelector('.send-btn');
      if (!msgInput || !sb) { _abandon(); return; }
      const tail = (accumulated || '').slice(-400);
      msgInput.value = tail
        ? `The stream dropped before you finished. It ended with:\n\n${tail}\n\nIf the task is fully complete, reply with just: DONE. Otherwise continue exactly where you left off and finish it — do not repeat what you already wrote.`
        : `The stream dropped before you produced anything. If the task is already done, reply with just: DONE. Otherwise complete it now.`;
      sb.click();
    }, 200);
    return true;
  }

  function _removeStallBanner() {
    const b = document.getElementById('stall-banner');
    if (b) b.remove();
    _stallBannerShown = false;
  }
  function _showStallBanner(secs) {
    if (document.getElementById('stall-banner')) return;
    _stallBannerShown = true;
    const box = document.getElementById('chat-history');
    if (!box) return;
    const bar = document.createElement('div');
    bar.id = 'stall-banner';
    bar.className = 'stall-banner';
    const mins = Math.floor(secs / 60);
    const label = mins >= 1 ? `${mins}m` : `${secs}s`;
    bar.innerHTML = `<span class="stall-banner-txt">` + t('chat.stall_banner', { time: label }) + `</span>`;
    const cont = document.createElement('button');
    cont.className = 'stall-banner-btn';
    cont.textContent = t('chat.nudge');
    cont.title = t('chat.stop_stalled');
    cont.addEventListener('click', () => {
      _removeStallBanner();
      const mi = uiModule.el('message');
      if (mi) {
        mi.value = 'Are you still working? If you stopped, continue exactly where you left off and finish the task.';
        const sb = document.querySelector('.send-btn');
        if (sb) sb.click();
      }
    });
    const stop = document.createElement('button');
    stop.className = 'stall-banner-btn stall-banner-stop';
    stop.textContent = t('chat.stop');
    stop.addEventListener('click', () => { _removeStallBanner(); abortCurrentRequest(true); });
    bar.appendChild(cont);
    bar.appendChild(stop);
    box.appendChild(bar);
    if (uiModule.scrollHistory) uiModule.scrollHistory();
  }
  function _startStallWatchdog() {
    // 已禁用：服务端停滞检测器 / 自动继续（代理
    // 循环断路器）现在处理静默/停滞的流，因此手动
    // "已静默 N 分钟 — 还在运行吗？"横幅是多余的（且烦人）。
    if (_stallWatchdog) { clearInterval(_stallWatchdog); _stallWatchdog = null; }
    _removeStallBanner();
  }
  function _stopStallWatchdog() {
    if (_stallWatchdog) { clearInterval(_stallWatchdog); _stallWatchdog = null; }
    _removeStallBanner();
  }

  /** 在 `holder` 中显示"用户已取消"记录，并在服务端持久化一个空的
   *  助手占位符，使该轮对话在刷新后仍然保留。
   *  在两个中止路径中当尚未流式传输任何 token 时调用。 */
  function _renderCancelledBubble(holder) {
    if (!holder) return;
    holder.dataset.raw = '';
    const body = holder.querySelector('.body');
    if (body) {
      body.innerHTML = '';
      const indicator = document.createElement('div');
      indicator.className = 'stopped-indicator';
      const label = document.createElement('span');
      label.style.fontStyle = 'italic';
      label.style.opacity = '0.7';
      label.textContent = '[Cancelled by user]';
      indicator.appendChild(label);
      body.appendChild(indicator);
    }
    if (typeof createMsgFooter === 'function' && !holder.querySelector('.msg-footer')) {
      holder.appendChild(createMsgFooter(holder));
    }
    // 作为带有 stopped+cancelled 元数据的助手消息持久化，使
    // 聊天历史加载器在刷新后渲染相同的指示器。
    // 包含模型名称，使气泡标题仍能显示是哪个模型
    // 在用户点击停止时正在运行。
    const sid = sessionModule.getCurrentSessionId();
    if (sid) {
      let modelName = '';
      try { modelName = sessionModule.getCurrentModel?.() || ''; } catch {}
      // 回退：从容器的现有元数据中获取（流式传输
      // 占位符通常在标题中已设有模型）。
      if (!modelName) {
        modelName = holder.dataset.model
          || holder.querySelector('.msg-header .msg-model')?.textContent
          || '';
      }
      fetch(`${API_BASE}/api/session/${sid}/inject_messages`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            role: 'assistant',
            content: '',
            metadata: { stopped: true, cancelled: true, model: modelName },
          }],
        }),
      }).catch(() => {});
    }
  }

  /**
   * 将当前流分离到后台运行，而非中止。
   * 当用户在流传输中途切换会话时调用。
   */
  export function detachCurrentStream(sessionId) {
    if (!isStreaming || !currentAbort) {
      // 未在流式传输中 — 落入中断
      abortCurrentRequest();
      return;
    }
    // 存储后台流状态
    _backgroundStreams.set(sessionId, {
      status: 'running',
      accumulated: currentAccumulated,
      sourcesHtml: '',
      findingsData: null,
      abortCtrl: currentAbort,
      query: currentHolder ? (currentHolder._researchQuery || '') : '',
      metrics: null,
    });
    // 在侧边栏用跳动标记点标记会话
    if (sessionModule && sessionModule.markStreaming) {
      sessionModule.markStreaming(sessionId);
    }
    // 清除本地状态但不中断 fetch
    currentAbort = null;
    isStreaming = false;
    currentHolder = null;
    currentAccumulated = '';
    // 重置提交按钮，使新聊天可以发送
    const submitBtn = document.querySelector('.send-btn');
    if (submitBtn) updateSubmitButton('idle', submitBtn);
  }

  // _notifyStreamComplete 和 _insertStreamDoneToast 现在在 chatStream.js 中
  var _notifyStreamComplete = chatStream.notifyStreamComplete;
  var _insertStreamDoneToast = chatStream.insertStreamDoneToast;

  /**
   * 实时恢复仍在服务端分离运行的聊天流（#2539）。
   *
   * 在会话重新进入时，GET /api/chat/resume/{id} 先重放运行的缓冲区，
   * 然后进行实时流式传输；回复 token 在到达时即时渲染。完成后，纯文本
   * 回复就地完成（通过 chatRenderer.addMessage 的规范气泡，无需重新加载）；
   * "丰富"回复（工具调用、信息源、文档流式传输、多轮）则从数据库重新加载，
   * 以确保其完整渲染保持准确。返回 true 表示已附加，返回 false 让调用方回退到加载动画+轮询。
   */
  export async function resumeStream(sessionId) {
    if (!sessionId) return false;
    if (hasActiveStream(sessionId)) return false;

    let res;
    try {
      res = await fetch(`${API_BASE}/api/chat/resume/${sessionId}`);
    } catch (e) {
      return false;
    }
    if (!res.ok || !res.body) return false;

    const box = document.getElementById('chat-history');
    if (!box) return false;

    // 在此读取器活动时阻止重复的重新附加尝试。专用的
    // Set（不是 _backgroundStreams）使 checkBackgroundStream 不会将此
    // 误认为同标签页的 POST 流并在重新进入时生成自己的加载动画和轮询。
    _resumingStreams.add(sessionId);

    const holder = document.createElement('div');
    holder.className = 'msg msg-ai';
    const meta = sessionModule.getSessions().find(s => s.id === sessionId);
    const roleLabel = _shortModel(meta && meta.model);
    const roleTs = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    holder.innerHTML = '<div class="role">' + uiModule.esc(roleLabel) +
      ' <span class="role-timestamp">' + roleTs + '</span></div>' +
      '<div class="body"><div class="stream-content"></div></div>';
    _applyModelColor(holder.querySelector('.role'), meta && meta.model);
    const contentDiv = holder.querySelector('.stream-content');
    box.appendChild(holder);

    const spinner = spinnerModule.create('Generating response...', 'right');
    holder.querySelector('.body').appendChild(spinner.createElement());
    spinner.start();
    uiModule.scrollHistory();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let roundText = '';
    let gotDelta = false;
    let leftSession = false;
    let metricsData = null;
    // "丰富"响应（工具调用、信息源、文档流式传输、多轮）需要
    // 完整的规范渲染，在重新加载时从保存的数据库记录重建。
    // 纯文本回复可以就地完成，无需重新加载。
    let rich = false;

    const cleanup = () => {
      try { spinner.destroy(); } catch (_) {}
      _resumingStreams.delete(sessionId);
    };

    const renderDelta = () => {
      const dt = stripToolBlocks(roundText);
      contentDiv.innerHTML = markdownModule.mdToHtml(markdownModule.squashOutsideCode(dt));
      uiModule.scrollHistory();
    };

    try {
      readLoop:
      while (true) {
        // 用户离开了此会话：停止渲染，运行在服务端继续。
        if (sessionModule.getCurrentSessionId &&
            sessionModule.getCurrentSessionId() !== sessionId) {
          leftSession = true;
          try { await reader.cancel(); } catch (_) {}
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') {
            try { await reader.cancel(); } catch (_) {}
            break readLoop;
          }
          let json;
          try { json = JSON.parse(payload); } catch (_) { continue; }
          if (json.delta) {
            roundText += json.delta;
            if (!gotDelta) { gotDelta = true; try { spinner.destroy(); } catch (_) {} }
            renderDelta();
          } else if (json.type === 'doc_stream_open') {
            rich = true;
            if (documentModule) documentModule.streamDocOpen(json.title || '', json.lang || '');
          } else if (json.type === 'doc_stream_delta') {
            rich = true;
            if (documentModule && json.delta) documentModule.streamDocDelta(json.delta);
          } else if (json.type === 'metrics') {
            metricsData = json.data || metricsData;
          } else if (json.type === 'tool_start' || json.type === 'tool_output' ||
                     json.type === 'tool_progress' || json.type === 'agent_step' ||
                     json.type === 'web_sources' || json.type === 'rag_sources' ||
                     json.type === 'research_progress' || json.type === 'research_sources' ||
                     json.type === 'research_findings' || json.type === 'research_done') {
            rich = true;
          }
        }
      }
    } catch (e) {
      // 网络断开或解析失败：落入下方的重新加载。
    }

    cleanup();
    if (leftSession) { if (holder.parentNode) holder.remove(); return true; }

    const onThisSession = sessionModule.getCurrentSessionId &&
                          sessionModule.getCurrentSessionId() === sessionId;

    // 纯文本回复：就地完成。用规范的
    // 单条消息（markdown + 页脚操作 + 指标）替换实时气泡，
    // 使用与历史相同的渲染器。无需重新获取历史，无流结束闪烁。
    if (onThisSession && !rich && roundText.trim()) {
      if (holder.parentNode) holder.remove();
      const model = meta && meta.model;
      const meta_ = metricsData ? Object.assign({ model }, metricsData) : { model };
      chatRenderer.addMessage('assistant', roundText, model, meta_);
      uiModule.scrollHistory();
      return true;
    }

    // 丰富响应（工具、信息源、文档、多轮）或用户已离开：
    // 从数据库重新加载以获取完整规范渲染。
    if (holder.parentNode) holder.remove();
    if (onThisSession) sessionModule.selectSession(sessionId);
    else sessionModule.loadSessions();
    return true;
  }

  /**
   * 在切换到会话时检查后台流。
   * 在会话切换后加载历史记录时调用。
   */
  export function checkBackgroundStream(sessionId) {
    if (!sessionId || !_backgroundStreams.has(sessionId)) return;
    var entry = _backgroundStreams.get(sessionId);

    if (entry.status === 'completed') {
      // 响应已保存到数据库，将出现在历史中 — 仅清理
      _backgroundStreams.delete(sessionId);
      return;
    }

    if (entry.status === 'error') {
      _backgroundStreams.delete(sessionId);
      var box = document.getElementById('chat-history');
      if (box) {
        var errHolder = document.createElement('div');
        errHolder.className = 'msg msg-ai';
        errHolder.innerHTML = '<div class="body"><i style="color: var(--color-error);">[Background stream encountered an error]</i></div>';
        box.appendChild(errHolder);
      }
      return;
    }

    if (entry.status === 'running') {
      // 流仍处于活动状态 — 显示干净的加载动画，轮询直到完成，
      // 然后重新加载历史以显示最终保存的响应。
      var box = document.getElementById('chat-history');
      if (!box) return;

      // 回放任何在后台流式传输的文档内容
      if (entry._docTitle != null && documentModule) {
        documentModule.streamDocOpen(entry._docTitle, entry._docLang || '');
        if (entry._docContent) {
          documentModule.streamDocDelta(entry._docContent);
        }
      }

      var holder = document.createElement('div');
      holder.className = 'msg msg-ai';
      var meta = sessionModule.getSessions().find(function(s) { return s.id === sessionId; });
      var roleLabel = _shortModel(meta && meta.model);
      var roleTs = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      holder.innerHTML = '<div class="role">' + uiModule.esc(roleLabel) + ' <span class="role-timestamp">' + roleTs + '</span></div><div class="body"></div>';
      _applyModelColor(holder.querySelector('.role'), meta && meta.model);

      var bodyDiv = holder.querySelector('.body');
      var spinner = spinnerModule.create('Response streaming in background', 'right');
      bodyDiv.appendChild(spinner.createElement());
      spinner.start();

      box.appendChild(holder);
      uiModule.scrollHistory();

      // 轮询 map 直到流完成，然后重新加载历史
      var pollId = setInterval(function() {
        if (sessionModule.getCurrentSessionId() !== sessionId) {
          clearInterval(pollId);
          spinner.destroy();
          if (holder.parentNode) holder.remove();
          return;
        }
        // 轮询时更新文档内容
        var curPoll = _backgroundStreams.get(sessionId);
        if (curPoll && curPoll._docContent && documentModule) {
          documentModule.streamDocDelta(curPoll._docContent);
        }
        if (!curPoll || curPoll.status !== 'running') {
          clearInterval(pollId);
          spinner.destroy();
          if (holder.parentNode) holder.remove(); // 移除整个容器，而不只是加载动画
          _backgroundStreams.delete(sessionId);
          // 重新加载会话以显示已完成的响应 — 但仅在用户
          // 仍在该会话上时才执行；不要将他们从打开的新聊天中拉回来。
          if (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId() === sessionId) {
            sessionModule.selectSession(sessionId);
          } else {
            sessionModule.loadSessions();
          }
        }
      }, 500);
    }
  }

  // 用 .pre-compact 标记短的单行代码块，使 CSS 可以
  // 将运行/编辑/复制按钮渲染为紧凑行，不会让
  // 1 行 bash 代码块比其内容本身还高。
  function _markCompactPre(pre) {
    const code = pre.querySelector('code');
    if (!code) return;
    const txt = code.textContent || '';
    // 计数可见行 — 忽略尾部换行符（围栏代码块
    // 常见）并将任何空多余行视为不是真正的第二行。
    const lines = txt.replace(/\n+$/, '').split('\n');
    const compact = lines.length <= 1 && txt.length < 200;
    pre.classList.toggle('pre-compact', compact);
  }
  function _scanCompactPres(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('pre').forEach(_markCompactPre);
  }
  // 全局观察器，使得应用中任何地方添加的 <pre>（聊天流、
  // 聊天重新渲染、文档库聊天预览、斜杠命令、
  // 研究预览等）都被标记，而无需每个调用点
  // 记住。
  (function _initCompactPreObserver() {
    if (window._cmpPreObserverWired) return;
    window._cmpPreObserverWired = true;
    _scanCompactPres(document.body);
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'PRE') _markCompactPre(n);
          if (n.querySelectorAll) _scanCompactPres(n);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  })();

  /**
   * 初始化事件监听器
   */
  export function initListeners() {
    // 代码复制按钮的全局事件委托
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.copy-code');
      if (!btn) return;
      e.stopPropagation();
      const code = btn.getAttribute('data-code');
      if (code && uiModule) {
        uiModule.copyToClipboard(code);
        // 视觉反馈：将图标换为对勾（常规大小）
        // 并添加 .copied，CSS 使用它闪烁绿色 + 脉冲动画。
        // 对于紧凑型按钮，标签文字来自
        // CSS ::before — 通过 data-state 交换，以免破坏
        // 文字按钮布局。
        const origHTML = btn.innerHTML;
        const isCompact = !!btn.closest('pre.pre-compact');
        if (!isCompact) {
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        }
        btn.classList.add('copied');
        btn.dataset.state = 'copied';
        setTimeout(() => {
          if (!isCompact) btn.innerHTML = origHTML;
          btn.classList.remove('copied');
          delete btn.dataset.state;
        }, 1500);
      }
    });

    // 代码运行按钮的委托
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.run-code');
      if (!btn) return;
      e.stopPropagation();
      if (codeRunnerModule) codeRunnerModule.run(btn);
    });

    // 代码编辑按钮的委托 — 切换 code 元素的 contentEditable
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.edit-code');
      if (!btn) return;
      e.stopPropagation();
      const pre = btn.closest('pre');
      if (!pre) return;
      const codeEl = pre.querySelector('code');
      if (!codeEl) return;
      const isEditing = codeEl.contentEditable !== 'false' && codeEl.contentEditable !== 'inherit';
      if (isEditing) {
        // 保存：退出编辑模式，更新复制/运行按钮上的 data-code
        codeEl.contentEditable = 'false';
        codeEl.classList.remove('editing');
        pre.classList.remove('editing');
        const newCode = codeEl.textContent;
        const copyBtn = pre.querySelector('.copy-code');
        if (copyBtn) copyBtn.setAttribute('data-code', newCode);
        const runBtn = pre.querySelector('.run-code');
        if (runBtn) runBtn.setAttribute('data-code', newCode);
        // 将图标换回铅笔
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
        btn.title = t('common.edit');
        btn.classList.remove('active');
      } else {
        // 进入编辑模式。Firefox（尤其是移动端）历史上缺少
        // contentEditable="plaintext-only" — 在那里设置会使代码块
        // 不可编辑，导致点击"只得到对勾"而无法输入。
        // 当 plaintext-only 不生效时，回退到 "true"。
        try { codeEl.contentEditable = 'plaintext-only'; } catch (_) { /* 不支持的值 */ }
        if (codeEl.contentEditable !== 'plaintext-only') codeEl.contentEditable = 'true';
        codeEl.classList.add('editing');
        pre.classList.add('editing');
        // preventScroll 防止在移动端聚焦可编辑区域时
        // 页面跳转到代码块 — 否则浏览器会
        // 将代码块滚动到键盘上方，这看起来像是"点击编辑时触发了
        // 自动滚动"。
        try { codeEl.focus({ preventScroll: true }); } catch (_) { codeEl.focus(); }
        // 将图标换为对勾
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        btn.title = t('chat.done_editing');
        btn.classList.add('active');
      }
    });

    // 点击代码块主体（而非按钮）切换覆盖的
    // 复制/编辑/运行按钮，这些按钮在移动端会遮挡文字。
    document.addEventListener('click', (e) => {
      if (e.target.closest('.copy-code, .edit-code, .run-code')) return;
      const pre = e.target.closest('pre');
      if (!pre || !pre.querySelector('.copy-code')) return;
      // 编辑时不隐藏 — 按钮（包括完成对勾）很重要。
      if (pre.classList.contains('editing')) return;
      pre.classList.toggle('buttons-hidden');
    });

    // 根据视口位置将复制/运行按钮放在顶部或底部
    // — 仅桌面端。移动端上点击时会不断重新触发
    // （合成 mouseenter 事件），导致按钮跳动，用户的手指
    // 落在移动后的目标上。触摸设备上固定按钮在顶部 —
    // 不自动重新定位。
    document.addEventListener('mouseenter', (e) => {
      if (window.matchMedia('(max-width: 768px)').matches) return;
      const pre = e.target.closest ? e.target.closest('pre') : null;
      if (!pre || pre.dataset.btnPosComputed) return;
      const rect = pre.getBoundingClientRect();
      const threshold = window.innerHeight * 0.35;
      const isBottom = rect.top < threshold;
      const copyBtn = pre.querySelector('.copy-code');
      if (copyBtn) copyBtn.classList.toggle('bottom', isBottom);
      const editBtn = pre.querySelector('.edit-code');
      if (editBtn) editBtn.classList.toggle('bottom', isBottom);
      const runBtn = pre.querySelector('.run-code');
      if (runBtn) runBtn.classList.toggle('bottom', isBottom);
      pre.dataset.btnPosComputed = '1';
    }, true);

    // 标签页挂起恢复：用户切回标签页时，检查流是否冻结
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!isStreaming) return;

      // 流声称正在运行 — 检查读取器是否真的活动
      const staleSince = Date.now() - _lastReaderActivity;
      if (staleSince < 20000) return; // 最近活跃过，可能没问题

      // 标签页恢复后 5 秒以上读取器没有产生数据。
      // 给予短暂宽限期然后恢复。
      console.warn('[tab-recovery] Stream appears frozen (no activity for ' + Math.round(staleSince/1000) + 's). Recovering...');

      setTimeout(() => {
        // 重新检查 — 也许读取器在宽限期内唤醒了
        if (!isStreaming) return;
        const stillStale = Date.now() - _lastReaderActivity;
        if (stillStale < 5000) return; // 已恢复活动

        console.warn('[tab-recovery] Stream confirmed dead. Aborting and reloading session.');

        // 中止冻结的流，但保留可见气泡。
        if (currentAbort) {
          currentAbort._reason = 'recovery';
          currentAbort.abort();
        }
        isStreaming = false;

        // 释放 Web Lock
        if (_webLockRelease) {
          _webLockRelease();
          _webLockRelease = null;
        }

        // 重置 UI 状态
        var _submitBtn = document.getElementById('submit');
        updateSubmitButton('idle', _submitBtn);
        var _msgInput = document.getElementById('message');
        if (_msgInput) _msgInput.disabled = false;
      }, 2000); // 2 秒宽限期
    });

    // 移动端上，键盘打开时淡出欢迎文字以防止重叠
    if (window.innerWidth <= 768) {
      const msgInput = document.getElementById('message');
      if (msgInput) {
        msgInput.addEventListener('focus', () => {
          const ws = document.getElementById('welcome-screen');
          if (ws && !ws.classList.contains('hidden')) {
            ws.classList.add('kb-hidden');
          }
        });
        msgInput.addEventListener('blur', () => {
          const ws = document.getElementById('welcome-screen');
          if (ws && !ws.classList.contains('hidden')) {
            // 延迟重新显示，使在聊天框内点击不会闪烁
            setTimeout(() => {
              if (document.activeElement !== msgInput) {
                ws.classList.remove('kb-hidden');
              }
            }, 200);
          }
        });
      }
      // 键盘开合时平滑调整视口大小
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
          document.documentElement.style.setProperty('--vh', window.visualViewport.height + 'px');
        });
        document.documentElement.style.setProperty('--vh', window.visualViewport.height + 'px');
      }
    }

    // 如果浏览器丢弃并恢复了此标签页，重新加载当前会话
    // 使用户看到服务端保存的部分响应，而不是空白页面
    if (document.wasDiscarded) {
      console.warn('[tab-recovery] Tab was discarded by browser — reloading session');
      setTimeout(() => {
        var _sid = sessionModule && sessionModule.getCurrentSessionId();
        if (_sid) sessionModule.selectSession(_sid);
      }, 500);
    }
  }

  /**
   * 重新生成响应：将历史截断到此 AI 消息之前的用户消息，
   * 然后重新提交该用户消息。
   */
  /**
   * 编辑用户消息：显示输入框，截断到该消息之前，重新提交编辑后的文本。
   */
  export async function editUserMessage(userMsgElement) {
    const box = document.getElementById('chat-history');
    const allMsgs = Array.from(box.querySelectorAll('.msg'));
    const msgIndex = allMsgs.indexOf(userMsgElement);
    if (msgIndex < 0) return;

    const bodyEl = userMsgElement.querySelector('.body');
    const currentText = bodyEl ? bodyEl.textContent.trim().replace(/\s*\[\d+ attachment\(s\)\]$/, '') : '';

    // 用可编辑 textarea 替换内容体
    const editor = document.createElement('textarea');
    editor.className = 'edit-textarea';
    editor.value = currentText;
    editor.rows = Math.max(2, currentText.split('\n').length);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:6px; margin-top:4px;';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'edit-save-btn';
    saveBtn.textContent = t('chat.send');
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'edit-cancel-btn';
    cancelBtn.textContent = t('common.cancel');
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);

    const originalHTML = bodyEl.innerHTML;
    bodyEl.innerHTML = '';
    bodyEl.appendChild(editor);
    bodyEl.appendChild(btnRow);
    editor.focus();

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      bodyEl.innerHTML = originalHTML;
    });

    saveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newText = editor.value.trim();
      if (!newText) return;

      const sessionId = sessionModule.getCurrentSessionId();
      if (!sessionId) return;

      const keepCount = msgIndex;
      try {
        await fetch(`${API_BASE}/api/session/${sessionId}/truncate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keep_count: keepCount })
        });

        // 从 msgIndex 开始移除 DOM 元素
        for (let i = allMsgs.length - 1; i >= msgIndex; i--) {
          allMsgs[i].remove();
        }

        // 提交编辑后的文本
        const messageInput = uiModule.el('message');
        messageInput.value = newText;
        const submitBtn = document.querySelector('.send-btn');
        if (submitBtn) submitBtn.click();
      } catch (err) {
        console.error('Edit failed:', err);
        if (uiModule) uiModule.showError(t('chat.edit_failed', { error: err.message }));
        bodyEl.innerHTML = originalHTML;
      }
    });

    // 也通过回车键提交（不带 Shift）
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        saveBtn.click();
      }
    });
  }

  /**
   * 重新发送用户消息 — 将历史截断到该点并重新提交。
   */
  export async function resendUserMessage(userMsgElement) {
    const box = document.getElementById('chat-history');
    const allMsgs = Array.from(box.querySelectorAll('.msg'));
    const msgIndex = allMsgs.indexOf(userMsgElement);
    if (msgIndex < 0) return;

    // 优先使用 dataset.raw（剥离后的原始用户文本）而非 .body.textContent
    // — 后者会吞入渲染后的"查看图片描述"可折叠
    // 内容，这些内容随之会被作为用户的问题发送回去，
    // AI 会回复那段乱码而非实际提示。
    const bodyEl = userMsgElement.querySelector('.body');
    let text = (userMsgElement.dataset.raw || (bodyEl ? bodyEl.textContent : '') || '').trim();
    text = text.replace(/\s*\[\d+ attachment\(s\)\]$/, '');

    // 收集此用户消息附带的 file_ids，使重新发送时
    // 重新携带照片/文档（聊天处理器获取用户在服务端
    // 这些 file_id 下缓存的编辑过的 OCR 文字）。
    const _attachEls = userMsgElement.querySelectorAll('[data-file-id]');
    let _ids = Array.from(_attachEls).map(el => el.dataset.fileId).filter(Boolean);
    if (!_ids.length) {
      const _imgs = userMsgElement.querySelectorAll('.attach-image-preview img, .attach-card img');
      for (const _im of _imgs) {
        const _m = (_im.getAttribute('src') || '').match(/\/api\/upload\/([A-Za-z0-9_\-]+)/);
        if (_m && _m[1] && !_ids.includes(_m[1])) _ids.push(_m[1]);
      }
    }

    // 补救：旧版气泡可能将文件名存储为消息
    // 内容（较早破损重新发送的产物）。不要将其作为
    // 用户提示重新发送如果文件仍然存在。放宽正则
    // 以覆盖真实世界的相机/截图文件名（含空格、括号、
    // 多点）："Screen Shot 2026-05-28 at 4.05.32 PM.png"、"IMG (1).JPG"。
    if (text && _ids.length && /^[^\n\r]{1,200}\.(png|jpe?g|gif|webp|svg|bmp|heic|heif)$/i.test(text)) {
      text = '';
    }
    // 空文本 + 无附件 → 告知用户，而非静默退出。
    // 常见情况是上传前竞争中的重新生成，气泡
    // 从未有过可抓取的 `[data-file-id]`。
    if (!text && !_ids.length) {
      if (uiModule?.showError) uiModule.showError(t('chat.nothing_to_resend'));
      return;
    }

    const sessionId = sessionModule.getCurrentSessionId();
    if (!sessionId) return;

    // 截断后端以保留此用户消息之前的所有内容
    const keepCount = msgIndex;
    try {
      await fetch(`${API_BASE}/api/session/${sessionId}/truncate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep_count: keepCount })
      });

      // 删除用户消息之后的 AI 回复但保留用户气泡
      // 本身（使其照片保持可见）。然后抑制新的用户
      // 气泡（send 原本会添加的）— 与重新生成相同的模式。
      let sibling = userMsgElement.nextSibling;
      while (sibling) {
        const next = sibling.nextSibling;
        sibling.remove();
        sibling = next;
      }
      _hideUserBubble = true;
      _pendingRegenAttachments = _ids;

      // 重新提交
      const messageInput = uiModule.el('message');
      messageInput.value = text;
      const submitBtn = document.querySelector('.send-btn');
      if (submitBtn) submitBtn.click();
    } catch (err) {
      console.error('Resend failed:', err);
      if (uiModule) uiModule.showError(t('chat.resend_failed', { error: err.message }));
    }
  }

  export async function regenerateFrom(aiMsgElement) {
    const box = document.getElementById('chat-history');
    const allMsgs = Array.from(box.querySelectorAll('.msg'));
    const aiIndex = allMsgs.indexOf(aiMsgElement);
    if (aiIndex < 0) return;

    // 找到前一条用户消息
    let userIndex = -1;
    let userText = '';
    let userMsgEl = null;
    for (let i = aiIndex - 1; i >= 0; i--) {
      if (allMsgs[i].classList.contains('msg-user')) {
        userIndex = i;
        userMsgEl = allMsgs[i];
        // 优先使用 dataset.raw（由 addMessage 设置，包含剥离后的原始
        // 用户文本）而非渲染的内容体 textContent — 后者
        // 也会拉入"查看图片描述"可折叠内容，
        // 在重新生成时复制 OCR 文字。
        const bodyEl = userMsgEl.querySelector('.body');
        userText = (userMsgEl.dataset.raw || (bodyEl ? bodyEl.textContent : '') || '').trim();
        userText = userText.replace(/\s*\[\d+ attachment\(s\)\]$/, '');
        break;
      }
    }

    if (userIndex < 0) {
      if (uiModule) uiModule.showError(t('chat.no_user_message'));
      return;
    }

    // 收集原始用户消息附带的任何 file_ids，使
    // 重新生成的发送复用它们。没有这个，AI 仅基于
    // 文字重新生成 — 照片（以及用户在服务端
    // 该 file_id 下缓存的编辑过的 OCR 文字）将被静默丢弃。
    const _attachEls = userMsgEl ? userMsgEl.querySelectorAll('[data-file-id]') : [];
    let _regenIds = Array.from(_attachEls).map(el => el.dataset.fileId).filter(Boolean);
    // data-file-id 标记到达前渲染的气泡的回退方案：
    // 直接从任何 `.attach-image-preview img` 的
    // src URL 嗅探文件 id（匹配 /api/upload/<id>）。否则旧气泡会
    // 以零附件重新生成，照片将从结果中丢失，
    // 即使文件仍然存在于磁盘上。
    if (!_regenIds.length && userMsgEl) {
      const _imgs = userMsgEl.querySelectorAll('.attach-image-preview img, .attach-card img');
      for (const _im of _imgs) {
        const _m = (_im.getAttribute('src') || '').match(/\/api\/upload\/([A-Za-z0-9_\-]+)/);
        if (_m && _m[1] && !_regenIds.includes(_m[1])) _regenIds.push(_m[1]);
      }
    }
    _pendingRegenAttachments = _regenIds;

    // 补救：较早版本的重新生成（dataset.raw 修复之前）将
    // 照片的文件名存储为用户消息内容。在后续重新生成中，
    // 该文件名会作为字面用户提示发回，导致
    // AI 认为问题是"blue_night_preview.jpg"并回复"那是一张
    // 图片文件"。如果 userText 只是一个裸图片文件名且我们有
    // 附件，则丢弃它，使 OCR 文字（或视觉模型的图像字节）
    // 成为模型实际看到的内容。
    if (userText && _pendingRegenAttachments.length &&
        /^[^\n\r]{1,200}\.(png|jpe?g|gif|webp|svg|bmp|heic|heif)$/i.test(userText.trim())) {
      userText = '';
    }

    // 纯图片消息的用户文本为空 — 重新生成仍必须继续，
    // 因为附件本身就是消息。仅当没有文字且没有
    // 附件可发送时才退出。
    if (!userText && !_pendingRegenAttachments.length) {
      if (uiModule) uiModule.showError(t('chat.nothing_to_regenerate'));
      return;
    }

    const sessionId = sessionModule.getCurrentSessionId();
    if (!sessionId) return;

    // 将当前响应保存为变体
    const oldRaw = aiMsgElement.dataset.raw || aiMsgElement.querySelector('.body')?.textContent || '';
    const oldHtml = aiMsgElement.querySelector('.body')?.innerHTML || '';
    let variants = [];
    try { variants = JSON.parse(aiMsgElement.dataset.variants || '[]'); } catch(_) {}
    if (variants.length === 0) {
      // 首次重新生成 — 将原始响应保存为变体 0
      variants.push({ raw: oldRaw, html: oldHtml, label: 'original' });
    }

    const keepCount = userIndex;

    try {
      await fetch(`${API_BASE}/api/session/${sessionId}/truncate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep_count: keepCount })
      });

      for (let i = allMsgs.length - 1; i > aiIndex; i--) {
        allMsgs[i].remove();
      }

      // 从 DOM 中移除 AI 消息 — 它将被新的流式响应替换
      // 但首先，暂存变体数据，以便将其转移到新元素
      _pendingVariants = variants;
      _pendingVariantLabel = 'regen';
      aiMsgElement.remove();

      _hideUserBubble = true;
      const messageInput = uiModule.el('message');
      messageInput.value = userText;
      const submitBtn = document.querySelector('.send-btn');
      if (submitBtn) submitBtn.click();

    } catch (err) {
      console.error('Regenerate failed:', err);
      if (uiModule) uiModule.showError(t('chat.regenerate_failed', { error: err.message }));
    }
  }

  // 来自重新生成的待处理变体 — 转移到新的流式元素
  let _pendingVariants = null;
  let _pendingVariantLabel = null;
  // 重新生成时从原始用户消息携带的 file-ids，使
  // 照片/OCR 覆盖在新发送中存留。仅消费一次。
  let _pendingRegenAttachments = null;

  /**
   * 在流式传输完成后调用，用于附加变体导航（如果这是重新生成的话）。
   */
  function _attachVariantNav(msgElement) {
    if (!_pendingVariants) return;
    const variants = _pendingVariants;
    _pendingVariants = null;

    // 添加新响应作为最新变体
    const newRaw = msgElement.dataset.raw || msgElement.querySelector('.body')?.textContent || '';
    const newHtml = msgElement.querySelector('.body')?.innerHTML || '';
    const varLabel = _pendingVariantLabel || 'regen';
    _pendingVariantLabel = null;
    variants.push({ raw: newRaw, html: newHtml, label: varLabel });

    msgElement.dataset.variants = JSON.stringify(variants);
    msgElement.dataset.variantIndex = String(variants.length - 1);

    _renderVariantNav(msgElement, variants, variants.length - 1);

    // 将变体持久化到服务器
    const sid = sessionModule.getCurrentSessionId();
    if (sid) {
      fetch(`${API_BASE}/api/session/${sid}/update-last-meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { variants: variants, variantIndex: variants.length - 1 } })
      }).catch(e => console.warn('update-last-meta (variants) failed:', e));
    }
  }

  const _VARIANT_ICONS = { regen: '\u21BB', shorter: '\u2702', simpler: '?', original: '\u25CB' };
  function _variantTagText(label) {
    return _VARIANT_ICONS[label] || _VARIANT_ICONS['original'];
  }

  function _renderVariantNav(msgElement, variants, currentIdx) {
    // 如果存在现有导航则移除
    const old = msgElement.querySelector('.variant-nav');
    if (old) old.remove();

    if (variants.length < 2) return;

    const nav = document.createElement('span');
    nav.className = 'variant-nav';
    nav.addEventListener('click', (e) => e.stopPropagation());

    // 显示此变体是什么的标签
    // 分隔符
    const divider = document.createElement('span');
    divider.className = 'variant-divider';
    divider.textContent = '|';
    nav.appendChild(divider);

    // 标签
    const curVariant = variants[currentIdx];
    const tagLabel = document.createElement('span');
    tagLabel.className = 'variant-tag' + (curVariant?.label === 'shorter' ? ' variant-tag-scissors' : '');
    tagLabel.textContent = _variantTagText(curVariant?.label);
    nav.appendChild(tagLabel);

    // < 按钮
    const prevBtn = document.createElement('button');
    prevBtn.className = 'variant-btn';
    prevBtn.textContent = '<';
    prevBtn.disabled = currentIdx === 0;
    prevBtn.addEventListener('click', (e) => { e.stopPropagation(); _switchVariant(msgElement, variants, currentIdx - 1); });
    nav.appendChild(prevBtn);

    // 当前索引的可点击数字（点击左侧数字 = 左移，右侧 = 右移）
    const numLeft = document.createElement('button');
    numLeft.className = 'variant-num';
    numLeft.textContent = String(currentIdx + 1);
    numLeft.disabled = currentIdx === 0;
    numLeft.addEventListener('click', (e) => { e.stopPropagation(); _switchVariant(msgElement, variants, currentIdx - 1); });
    nav.appendChild(numLeft);

    const slash = document.createElement('span');
    slash.className = 'variant-slash';
    slash.textContent = '/';
    nav.appendChild(slash);

    const numRight = document.createElement('button');
    numRight.className = 'variant-num';
    numRight.textContent = String(variants.length);
    numRight.disabled = currentIdx === variants.length - 1;
    numRight.addEventListener('click', (e) => { e.stopPropagation(); _switchVariant(msgElement, variants, currentIdx + 1); });
    nav.appendChild(numRight);

    // > 按钮
    const nextBtn = document.createElement('button');
    nextBtn.className = 'variant-btn';
    nextBtn.textContent = '>';
    nextBtn.disabled = currentIdx === variants.length - 1;
    nextBtn.addEventListener('click', (e) => { e.stopPropagation(); _switchVariant(msgElement, variants, currentIdx + 1); });
    nav.appendChild(nextBtn);

    // 插入到 .role 标题中
    const roleEl = msgElement.querySelector('.role');
    if (roleEl) {
      roleEl.appendChild(nav);
    } else {
      msgElement.appendChild(nav);
    }
  }

  function _switchVariant(msgElement, variants, newIdx) {
    if (newIdx < 0 || newIdx >= variants.length) return;
    const v = variants[newIdx];
    const body = msgElement.querySelector('.body');
    if (body) body.innerHTML = v.html;
    msgElement.dataset.raw = v.raw;
    msgElement.dataset.variantIndex = String(newIdx);
    if (window.hljs) {
      msgElement.querySelectorAll('pre code').forEach(block => window.hljs.highlightElement(block));
    }
    _renderVariantNav(msgElement, variants, newIdx);

    // 将选定的变体持久化到服务器
    const sid = sessionModule.getCurrentSessionId();
    if (sid) {
      fetch(`${API_BASE}/api/session/${sid}/update-last-meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { variantIndex: newIdx } })
      }).catch(e => console.warn('update-last-meta (variantIndex) failed:', e));
    }
  }

  export async function forkFrom(aiMsgElement) {
    const box = document.getElementById('chat-history');
    const allMsgs = Array.from(box.querySelectorAll('.msg'));
    const aiIndex = allMsgs.indexOf(aiMsgElement);
    if (aiIndex < 0) return;

    const sessionId = sessionModule.getCurrentSessionId();
    if (!sessionId) return;

    const keepCount = aiIndex + 1;

    try {
      const res = await fetch(`${API_BASE}/api/session/${sessionId}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep_count: keepCount }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      await sessionModule.loadSessions();
      await sessionModule.selectSession(data.id);
      if (uiModule) uiModule.showToast(`Forked → ${data.name}`);
    } catch (err) {
      console.error('Fork failed:', err);
      if (uiModule) uiModule.showError(t('chat.fork_failed', { error: err.message }));
    }
  }

  /**
   * 在页面刷新或会话切换后检查待处理/已完成的研究。
   * 如果研究仍在运行，显示加载动画并轮询直到完成。
   * 如果研究已完成，获取结果并进行渲染。
   */
  export async function checkPendingResearch(sessionId) {
    if (!sessionId) return;
    try {
      const res = await fetch(`${API_BASE}/api/research/status/${sessionId}`);
      if (!res.ok) return; // 404 = 此会话无研究
      const data = await res.json();

      if (data.status === 'done') {
        // 获取并渲染已完成的结果
        _notifyResearchComplete(sessionId, data.query || '');
        if (sessionModule && sessionModule.clearResearching) sessionModule.clearResearching(sessionId);
        const resultRes = await fetch(`${API_BASE}/api/research/result/${sessionId}`, { method: 'POST' });
        if (resultRes.ok) {
          const resultData = await resultRes.json();
          if (resultData.result) {
            // 如果历史中已有此会话的研究消息则跳过
            if (document.querySelector(`#chat-history .msg-ai[data-research-session="${sessionId}"]`)) return;

            var srcBox = '';
            if (resultData.sources && resultData.sources.length > 0) {
              srcBox = _buildSourcesBox(resultData.sources, 'research');
            }
            var findingsBox = chatRenderer.buildFindingsBox(resultData.raw_findings);
            var cleanResult = resultData.result;
            // 直接构建 DOM 以避免通过 addMessage 双重处理
            chatRenderer.hideWelcomeScreen();
            var _box = document.getElementById('chat-history');
            if (_box) {
              var _wrap = document.createElement('div');
              _wrap.className = 'msg msg-ai';
              _wrap.dataset.researchSession = sessionId;
              var _role = document.createElement('div');
              _role.className = 'role';
              var _meta = sessionModule.getSessions().find(function(s) { return s.id === sessionId; });
              _role.textContent = _shortModel(_meta?.model);
              _applyModelColor(_role, _meta?.model);
              _role.appendChild(chatRenderer.roleTimestamp());
              var _body = document.createElement('div');
              _body.className = 'body';
              _body.innerHTML = srcBox + markdownModule.processWithThinking(
                markdownModule.squashOutsideCode(cleanResult)
              ) + findingsBox;
              _wrap.dataset.raw = cleanResult;
              _wrap.appendChild(_role);
              _wrap.appendChild(_body);
              _wrap.appendChild(chatRenderer.createMsgFooter(_wrap));
              _appendViewReportLink(_wrap, sessionId);
              _box.appendChild(_wrap);
              if (window.hljs) _wrap.querySelectorAll('pre code').forEach(function(b) { window.hljs.highlightElement(b); });
              uiModule.scrollHistory();
            }
          }
        }
        return;
      }

      if (data.status !== 'running') return;

      // 如果已切换到别处则不显示重连 UI
      if (sessionModule.getCurrentSessionId() !== sessionId) return;

      // 研究仍在运行 — 显示带加载动画的重连 UI
      const box = document.getElementById('chat-history');
      if (!box) return;

      const holder = document.createElement('div');
      holder.className = 'msg msg-ai research-reconnect';
      holder.dataset.researchSession = sessionId;
      const roleTs = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      const agentMeta = sessionModule.getSessions().find(s => s.id === sessionModule.getCurrentSessionId());
      const agentModelLabel = _shortModel(agentMeta?.model);
      holder.innerHTML = `<div class="role">${uiModule.esc(agentModelLabel)} <span class="role-timestamp">${roleTs}</span></div><div class="body"></div>`;
      _applyModelColor(holder.querySelector('.role'), agentMeta?.model);
      box.appendChild(holder);

      const bodyDiv = holder.querySelector('.body');
      const spinner = spinnerModule.create('Reconnecting to research...', 'right');
      bodyDiv.appendChild(spinner.createElement());
      spinner.start();

      // 如果有当前进度则更新加载动画
      function updateSpinnerFromProgress(progress) {
        if (!progress || !progress.phase) return;
        const rp = progress;
        if (rp.phase === 'probing') {
          spinner.updateMessage(`Verifying model: ${rp.model || '?'}`);
        } else if (rp.phase === 'planning') {
          spinner.updateMessage('Analyzing question & planning research strategy');
        } else if (rp.phase === 'searching') {
          const q = rp.queries ? `${rp.queries} queries` : '';
          const s = rp.total_sources ? ` · ${rp.total_sources} sources` : '';
          spinner.updateMessage(`Round ${rp.round || '?'}: Searching${q ? ' (' + q + ')' : ''}${s}`);
        } else if (rp.phase === 'reading') {
          spinner.updateMessage(rp.title ? `Reading: ${rp.title}` : `Round ${rp.round || '?'}: Reading ${rp.new_sources || ''} pages · ${rp.total_sources || 0} sources total`);
        } else if (rp.phase === 'analyzing') {
          spinner.updateMessage(`Round ${rp.round || '?'}: Analyzing ${rp.total_findings || 0} findings`);
        } else if (rp.phase === 'writing') {
          spinner.updateMessage(`Writing report · ${rp.total_sources || 0} sources`);
        }
      }

      updateSpinnerFromProgress(data.progress);
      _researchingStreamIds.add(sessionId);
      if (sessionModule && sessionModule.markResearching) sessionModule.markResearching(sessionId);

      // 从 started_at 恢复研究计时器
      if (data.started_at && spinner && spinner.element) {
        _researchStartTime = data.started_at * 1000;
        _researchAvgDuration = data.avg_duration || null;
        _researchTimerEl = document.createElement('div');
        _researchTimerEl.className = 'research-timer';
        _researchTimerEl.style.cssText = 'font-size:0.8em; opacity:0.6; margin-top:4px; font-family:monospace;';
        spinner.element.parentNode.insertBefore(_researchTimerEl, spinner.element.nextSibling);
        _researchTimerInterval = setInterval(() => {
          if (!_researchTimerEl) return;
          var elapsed = Math.floor((Date.now() - _researchStartTime) / 1000);
          var mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
          var ss = String(elapsed % 60).padStart(2, '0');
          var txt = mm + ':' + ss;
          if (_researchAvgDuration) {
            var avgM = String(Math.floor(_researchAvgDuration / 60)).padStart(2, '0');
            var avgS = String(Math.round(_researchAvgDuration % 60)).padStart(2, '0');
            txt += ' / avg ' + avgM + ':' + avgS;
          }
          _researchTimerEl.textContent = txt;
        }, 1000);
        // 重连 synapse — 用已知的任何进度初始化它
        try {
          _researchSynapse = createResearchSynapse(spinner.element.parentNode, {
            query: data.query || '',
            startedAt: _researchStartTime,
          });
          if (_researchSynapse.element && _researchTimerEl) {
            spinner.element.parentNode.insertBefore(_researchSynapse.element, _researchTimerEl);
          }
          if (data.progress) {
            _researchSynapse.setPhase(data.progress.phase, data.progress);
            if (typeof data.progress.round === 'number') _researchSynapse.setRound(data.progress.round);
            if (typeof data.progress.total_sources === 'number') _researchSynapse.setSourceCount(data.progress.total_sources);
          }
        } catch (e) { console.warn('synapse reconnect failed', e); }
      }

      // 轮询直到完成
      const pollInterval = setInterval(async () => {
        // 如果用户切换到不同会话则停止轮询
        if (sessionModule.getCurrentSessionId() !== sessionId) {
          clearInterval(pollInterval);
          spinner.destroy();
          _clearResearchTimer();
          if (holder.parentNode) holder.remove();
          _researchingStreamIds.delete(sessionId);
          if (_researchingStreamIds.size === 0) {
            var _rToggleP = document.getElementById('research-toggle-btn');
            if (_rToggleP) _rToggleP.classList.remove('research-running');
          }
          return;
        }
        try {
          const pollRes = await fetch(`${API_BASE}/api/research/status/${sessionId}`);
          if (!pollRes.ok) {
            clearInterval(pollInterval);
            spinner.destroy();
            _clearResearchTimer();
            _researchingStreamIds.delete(sessionId);
            if (sessionModule && sessionModule.clearResearching) sessionModule.clearResearching(sessionId);
            return;
          }
          const pollData = await pollRes.json();
          updateSpinnerFromProgress(pollData.progress);
          if (_researchSynapse && pollData.progress) {
            _researchSynapse.setPhase(pollData.progress.phase, pollData.progress);
            if (typeof pollData.progress.round === 'number') _researchSynapse.setRound(pollData.progress.round);
            if (typeof pollData.progress.total_sources === 'number') _researchSynapse.setSourceCount(pollData.progress.total_sources);
          }

          if (pollData.status !== 'running') {
            clearInterval(pollInterval);
            spinner.destroy();
            _clearResearchTimer();
            _researchingStreamIds.delete(sessionId);
            if (sessionModule && sessionModule.clearResearching) sessionModule.clearResearching(sessionId);

            if (pollData.status === 'done') {
              _notifyResearchComplete(sessionId, data.query || '');
              const rRes = await fetch(`${API_BASE}/api/research/result/${sessionId}`, { method: 'POST' });
              if (rRes.ok) {
                const rData = await rRes.json();
                if (rData.result) {
                  var srcHtml = '';
                  if (rData.sources && rData.sources.length > 0) {
                    srcHtml = _buildSourcesBox(rData.sources, 'research');
                  }
                  var findingsHtml = chatRenderer.buildFindingsBox(rData.raw_findings);
                  bodyDiv.innerHTML = srcHtml + markdownModule.processWithThinking(
                    markdownModule.squashOutsideCode(rData.result)
                  ) + findingsHtml;
                  holder.dataset.raw = rData.result;
                  _appendViewReportLink(holder, sessionId);
                  if (window.hljs) {
                    holder.querySelectorAll('pre code').forEach(b => window.hljs.highlightElement(b));
                  }
                }
              }
            } else {
              bodyDiv.innerHTML = '<i style="color: var(--color-error);">[Research ' + pollData.status + ']</i>';
            }
          }
        } catch (e) {
          console.error('Research poll error:', e);
        }
      }, 2000);
    } catch (e) {
      // 无待处理的研究，没问题
    }
  }

  /** 为下一条用户消息气泡设置显示覆盖 */
  export function setDisplayOverride(text) {
    _displayOverride = text;
  }

  /** 隐藏下一次提交的用户气泡（例如停止后继续） */
  export function setHideUserBubble() {
    _hideUserBubble = true;
  }

  /** 设置要与下一个流式响应合并的 AI 元素（停止后继续） */
  export function setPendingContinue(el) {
    _pendingContinue = el;
  }

  /**
   * 从对话中删除一条 AI 消息及其对应的用户消息。
   */
  export async function deleteMessage(msgElement) {
    const box = document.getElementById('chat-history');
    const allMsgs = Array.from(box.querySelectorAll('.msg'));
    const clickedIndex = allMsgs.indexOf(msgElement);
    if (clickedIndex < 0) return;

    // 没有会话不提前退出：在没有选择模型之前显示的
    // 输出（问题 #1428）没有会话/持久化行，但其 "x" 必须
    // 仍能删除它。我们只需要会话 id 用于服务端删除
    // 见下文；没有的话则回退到仅移除 DOM。
    const sessionId = sessionModule.getCurrentSessionId();

    const clickedIsUser = msgElement.classList.contains('msg-user');

    // 找到用户+AI 消息对
    let userIndex = -1;
    let aiIndex = -1;
    if (clickedIsUser) {
      userIndex = clickedIndex;
      // 找到下方的 AI 消息
      for (let i = clickedIndex + 1; i < allMsgs.length; i++) {
        if (allMsgs[i].classList.contains('msg-ai') && !allMsgs[i].classList.contains('msg-continuation')) {
          aiIndex = i;
          break;
        }
        if (allMsgs[i].classList.contains('msg-user')) break; // 下一条是用户消息，无 AI 响应
      }
    } else {
      // 如果点击的是继续消息，回溯到主 AI 消息
      let mainAiIndex = clickedIndex;
      if (allMsgs[mainAiIndex].classList.contains('msg-continuation')) {
        for (let i = mainAiIndex - 1; i >= 0; i--) {
          if (allMsgs[i].classList.contains('msg-ai') && !allMsgs[i].classList.contains('msg-continuation')) {
            mainAiIndex = i;
            break;
          }
        }
      }
      aiIndex = mainAiIndex;
      // 找到前一条用户消息
      for (let i = aiIndex - 1; i >= 0; i--) {
        if (allMsgs[i].classList.contains('msg-user')) {
          userIndex = i;
          break;
        }
      }
    }

    // 收集要移除的数据库消息 ID 和 DOM 元素
    const msgIds = [];
    const domToRemove = [];

    // 如果找到了用户消息则添加
    if (userIndex >= 0) {
      domToRemove.push(allMsgs[userIndex]);
      const uid = allMsgs[userIndex].dataset.dbId;
      if (uid) msgIds.push(uid);
    }

    // 如果找到了 AI 消息则添加
    if (aiIndex >= 0) {
      domToRemove.push(allMsgs[aiIndex]);
      const aid = allMsgs[aiIndex].dataset.dbId;
      if (aid) msgIds.push(aid);

      const aiEl = allMsgs[aiIndex];
      // 也移除用户和 AI 消息之间的代理线程元素
      if (userIndex >= 0) {
        let between = allMsgs[userIndex].nextElementSibling;
        while (between && between !== aiEl) {
          domToRemove.push(between);
          between = between.nextElementSibling;
        }
      }
      // 从 AI 元素向前遍历，移除继续消息和工具栏气泡
      let sibling = aiEl.nextElementSibling;
      while (sibling) {
        if (sibling.classList.contains('msg-user') ||
            (sibling.classList.contains('msg-ai') && !sibling.classList.contains('msg-continuation'))) {
          break;
        }
        domToRemove.push(sibling);
        sibling = sibling.nextElementSibling;
      }
    }

    if (!msgIds.length || !sessionId) {
      // 没有要删除的持久化行（无 DB ID，或根本没有会话 — 例如
      // 在模型被选之前显示的错误输出，#1428）。仅移除
      // DOM，使 "x" 无论如何都能工作。
      domToRemove.forEach(el => el.remove());
      if (uiModule) uiModule.showToast(t('chat.message_deleted'));
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/session/${sessionId}/delete-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_ids: msgIds })
      });
      if (!res.ok) throw new Error('Server error ' + res.status);
      domToRemove.forEach(el => el.remove());
      if (uiModule) uiModule.showToast(t('chat.message_deleted'));
    } catch (err) {
      console.error('Delete failed:', err);
      if (uiModule) uiModule.showError(t('chat.delete_failed', { error: err.message }));
    }
  }

  /**
   * 内联编辑 AI 消息。使正文变为 contentEditable，确认后保存到数据库。
   */
  export async function editAIMessage(msgElement) {
    const body = msgElement.querySelector('.body');
    if (!body) return;

    const isEditing = body.contentEditable === 'true' || body.contentEditable === 'plaintext-only';
    if (isEditing) return; // 已在编辑中

    const originalRaw = msgElement.dataset.raw || body.textContent || '';

    // 创建可编辑的 textarea 覆盖层
    const textarea = document.createElement('textarea');
    textarea.className = 'msg-edit-textarea';
    textarea.value = originalRaw;
    textarea.style.width = '100%';
    textarea.style.minHeight = Math.max(100, body.offsetHeight) + 'px';
    body.style.display = 'none';
    body.parentNode.insertBefore(textarea, body.nextSibling);
    textarea.focus();

    // 添加保存/取消栏
    const bar = document.createElement('div');
    bar.className = 'msg-edit-bar';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'msg-edit-save';
    saveBtn.textContent = t('common.save');
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'msg-edit-cancel';
    cancelBtn.textContent = t('common.cancel');
    bar.appendChild(saveBtn);
    bar.appendChild(cancelBtn);
    textarea.parentNode.insertBefore(bar, textarea.nextSibling);

    function cleanup() {
      textarea.remove();
      bar.remove();
      body.style.display = '';
    }

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
    });

    saveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newContent = textarea.value;
      if (newContent === originalRaw) { cleanup(); return; }

      const msgId = msgElement.dataset.dbId;
      if (!msgId) { if (uiModule) uiModule.showError(t('chat.cannot_edit_no_id')); cleanup(); return; }

      const sessionId = sessionModule.getCurrentSessionId();
      if (!sessionId) { cleanup(); return; }

      try {
        const res = await fetch(`${API_BASE}/api/session/${sessionId}/edit-message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msg_id: msgId, content: newContent }),
        });
        if (!res.ok) throw new Error('Server error ' + res.status);

        // 用 markdown 重新渲染内容体
        body.innerHTML = markdownModule.processWithThinking(markdownModule.squashOutsideCode(newContent));
        msgElement.dataset.raw = newContent;

        // 如果编辑指示器尚未存在则添加
        if (!msgElement.querySelector('.edited-indicator')) {
          const indicator = document.createElement('div');
          indicator.className = 'edited-indicator';
          indicator.textContent = '[Message edited]';
          body.parentNode.insertBefore(indicator, body.nextSibling);
        }

        cleanup();
        if (uiModule) uiModule.showToast(t('chat.message_edited'));
      } catch (err) {
        console.error('Edit failed:', err);
        if (uiModule) uiModule.showError(t('chat.edit_failed', { error: err.message }));
      }
    });
  }

  /**
   * 使用特定指令改写 AI 的最后一条响应。
   * 使用轻量级的 /api/rewrite 端点 — 无工具，无代理循环。
   * 仅改写最后一个 AI 气泡的文本。
   */
  export async function rewriteWith(aiMsgElement, instruction) {
    const sessionId = sessionModule.getCurrentSessionId();
    if (!sessionId) return;

    // 从 AI 气泡获取原始文本
    const oldRaw = aiMsgElement.dataset.raw || aiMsgElement.querySelector('.body')?.textContent || '';
    const oldHtml = aiMsgElement.querySelector('.body')?.innerHTML || '';

    if (!oldRaw.trim()) {
      if (uiModule) uiModule.showError(t('chat.no_text_to_rewrite'));
      return;
    }

    // 将当前响应保存为变体
    let variants = [];
    try { variants = JSON.parse(aiMsgElement.dataset.variants || '[]'); } catch(_) {}
    if (variants.length === 0) {
      variants.push({ raw: oldRaw, html: oldHtml, label: 'original' });
    }

    // 从指令确定标签
    let varLabel = 'rewrite';
    if (instruction.includes('shorter')) varLabel = 'shorter';
    else if (instruction.includes('simpler')) varLabel = 'simpler';

    // 清除气泡并显示漩涡加载动画，等待
    // 改写（替换旧的"正在改写..."文字）。
    const bodyEl = aiMsgElement.querySelector('.body');
    let _rwSpin = null;
    if (bodyEl) {
      bodyEl.innerHTML = '';
      _rwSpin = spinnerModule.createWhirlpool(18);
      _rwSpin.element.style.margin = '4px 0';
      bodyEl.appendChild(_rwSpin.element);
    }
    // 停止并分离加载动画（在真实内容开始渲染时调用，以及
    // 在失败路径上调用，使其永不永远旋转）。
    const _killRwSpin = () => { if (_rwSpin) { try { _rwSpin.destroy(); } catch (_) {} _rwSpin = null; } };

    try {
      const res = await fetch(`${API_BASE}/api/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          original_text: oldRaw,
          instruction: instruction,
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let newText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const data = JSON.parse(payload);
            // 端点流式传输 `event: error\ndata: {error,status}` 在
            // 失败时 — 显示错误而非静默停留在"正在改写…"。
            if (data.error) {
              throw new Error(data.error || ('HTTP ' + (data.status || 500)));
            }
            // 推理 token（vLLM --reasoning-parser: Qwen3 / DeepSeek-R1）
            // 以独立的 {delta, thinking:true} 块到达。它们不是
            // 改写的结果 — 折叠它们以免污染结果。
            if (data.thinking) continue;
            if (data.delta) {
              newText += data.delta;
              _killRwSpin();
              if (bodyEl) {
                bodyEl.innerHTML = markdownModule.processWithThinking(
                  markdownModule.squashOutsideCode(newText)
                );
              }
            }
          } catch (e) {
            if (e instanceof Error && e.message) throw e;  // 重新抛出真正的错误
            /* 忽略 JSON 解析噪声 */
          }
        }
      }

      // 从答案中剥离所有思考标记。推理模型可能会输出
      // 内联 <think>…</think> 块、裸的 </think>（无开头标签），或 — 当
      // 其推理通过 reasoning_content 来临时 — 一个孤立的开头 <think>，
      // 永远不闭合（否则会隐藏整个答案）。剥离所有
      // 这些标记，使剩下的只有改写后的文本。
      const _stripThink = (t) => {
        t = markdownModule.normalizeThinkingMarkup(t || '');
        t = t.replace(/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>[\s\S]*?<\/(?:think(?:ing)?|thought)>/gi, '');   // 完整的块
        if (/<\/(?:think(?:ing)?|thought)>/i.test(t)) t = t.replace(/^[\s\S]*?<\/(?:think(?:ing)?|thought)>/i, '');  // 推理但无开头标签
        return t.replace(/<\/?(?:think(?:ing)?|thought)(?:\s+[^>]*)?>/gi, '').trim();        // 任何孤立标签
      };
      newText = _stripThink(newText);

      // 剥离后无剩余（或空流）→ 真正的失败，不是
      // 空白气泡。
      if (!newText.trim()) {
        throw new Error('model returned no rewritten text');
      }

      // 更新元素的原始文本
      if (newText) {
        aiMsgElement.dataset.raw = newText;
        // 使用正确的 markdown 进行最终渲染
        if (bodyEl) {
          bodyEl.innerHTML = markdownModule.processWithThinking(
            markdownModule.squashOutsideCode(newText)
          );
        }

        // 将新响应保存为变体
        variants.push({ raw: newText, html: bodyEl ? bodyEl.innerHTML : '', label: varLabel });
        aiMsgElement.dataset.variants = JSON.stringify(variants);
        aiMsgElement.dataset.variantIndex = String(variants.length - 1);

        // 将变体元数据持久化到服务器
        try {
          await fetch(`${API_BASE}/api/session/${sessionId}/update-last-meta`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ metadata: { variants: variants, variantIndex: variants.length - 1 } }),
          });
        } catch (_) {}

        // 重新渲染变体导航
        _renderVariantNav(aiMsgElement, variants, variants.length - 1);
      }

      if (uiModule) uiModule.scrollHistory();

    } catch (err) {
      console.error('Rewrite failed:', err);
      _killRwSpin();
      // 失败时恢复原始内容
      if (bodyEl) bodyEl.innerHTML = oldHtml;
      if (uiModule) uiModule.showError(t('chat.rewrite_failed', { error: err.message }));
    }
  }

  /**
   * 从停止处继续 AI 的响应。
   */
  export async function continueFrom(aiMsgElement) {
    const sessionId = sessionModule.getCurrentSessionId();
    if (!sessionId) return;

    const messageInput = uiModule.el('message');
    if (messageInput) {
      messageInput.value = 'Continue from where you left off.';
      const submitBtn = document.querySelector('.send-btn');
      if (submitBtn) submitBtn.click();
    }
  }

  // 在正确位置打开聊天附件：图片 → 图片库编辑器；PDF 和
  // 文本/代码/markdown → 文档查看器；其他 → 原始文件。给定的
  // 上传导入的文档会被复用（按上传 ID 缓存），这样点击它
  // 会重新打开同一个文档，而不是创建重复。
  const _attachDocCache = new Map();  // 上传 ID → 文档 ID
  function _attachLang(name) {
    const m = (name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    const ext = m ? m[1] : '';
    const map = { md:'markdown', markdown:'markdown', js:'javascript', ts:'typescript',
      jsx:'javascript', tsx:'typescript', py:'python', rb:'ruby', go:'go', rs:'rust',
      java:'java', c:'c', cpp:'cpp', h:'c', hpp:'cpp', cs:'csharp', php:'php', html:'html',
      htm:'html', css:'css', scss:'scss', json:'json', yaml:'yaml', yml:'yaml', sh:'bash',
      bash:'bash', sql:'sql', csv:'csv', xml:'xml' };
    return map[ext] || '';
  }
  async function openAttachment(att, isImage) {
    if (!att || !att.id) return;
    const id = att.id, name = att.name || '', mime = att.mime || '';
    const url = `${API_BASE}/api/upload/${id}`;

    // 图片 → 图片库编辑器。
    if (isImage) {
      try {
        const gx = await import('./galleryEditor.js');
        if (gx.openEditor) { gx.openEditor(url, id, null, name); return; }
      } catch (e) { console.warn('gallery open failed', e); }
      window.open(url, '_blank');
      return;
    }

    const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(name);
    const TEXT_EXT = /\.(txt|md|markdown|js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|html?|css|scss|sass|less|json|ya?ml|toml|ini|conf|env|sh|bash|sql|csv|tsv|xml|log|vue|svelte)$/i;
    const isTextDoc = TEXT_EXT.test(name) || /^text\// .test(mime);
    if (!isPdf && !isTextDoc) { window.open(url, '_blank'); return; }  // 二进制/未知 → 原始

    // 复用它仍能加载的此上传已导入的文档。
    const cached = _attachDocCache.get(id);
    if (cached) {
      try {
        documentModule.openPanel && documentModule.openPanel();
        await documentModule.loadDocument(cached);
        return;
      } catch (_) { _attachDocCache.delete(id); }
    }

    // 需要会话以附加文档（裸会话回退方案，与编写相同）。
    let sid = '';
    try { sid = sessionModule.getCurrentSessionId() || ''; } catch (_) {}
    if (!sid) {
      try {
        const _fd = new FormData();
        _fd.append('name', name || 'Attachment');
        _fd.append('skip_validation', 'true');
        const r = await fetch(`${API_BASE}/api/session`, { method: 'POST', body: _fd, credentials: 'same-origin' });
        if (r.ok) { const d = await r.json(); if (d && d.id) { sid = d.id; if (sessionModule.loadSessions) await sessionModule.loadSessions(); } }
      } catch (_) {}
    }

    try {
      let doc;
      if (isPdf) {
        // import-pdf 需要新的文件上传 — 重新获取已存储的 blob 并发送。
        const blob = await (await fetch(url)).blob();
        const fd = new FormData();
        fd.append('file', blob, name || 'document.pdf');
        if (sid) fd.append('session_id', sid);
        const res = await fetch(`${API_BASE}/api/documents/import-pdf`, { method: 'POST', body: fd, credentials: 'same-origin' });
        if (!res.ok) throw new Error('import-pdf ' + res.status);
        doc = await res.json();
      } else {
        const text = await (await fetch(url)).text();
        const res = await fetch(`${API_BASE}/api/document`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sid || null, title: name.replace(/\.[^.]+$/, '') || 'Document', content: text, language: _attachLang(name) }),
        });
        if (!res.ok) throw new Error('document ' + res.status);
        doc = await res.json();
      }
      if (doc && doc.id) {
        _attachDocCache.set(id, doc.id);
        documentModule.openPanel && documentModule.openPanel();
        if (documentModule.injectFreshDoc) documentModule.injectFreshDoc(doc);
        else await documentModule.loadDocument(doc.id);
      }
    } catch (e) {
      console.error('open attachment as document failed', e);
      import('./ui.js').then(m => m.showError && m.showError(t('chat.could_not_open_attachment'))).catch(() => {});
      window.open(url, '_blank');  // 回退方案以确保文件仍然可访问
    }
  }

  // 公共 API
  const chatModule = {
    init,
    initListeners,
    openAttachment,
    addMessage: chatRenderer.addMessage,
    displayMetrics: chatRenderer.displayMetrics,
    handleChatSubmit,
    abortCurrentRequest,
    detachCurrentStream,
    checkBackgroundStream,
    resumeStream,
    hideWelcomeScreen: chatRenderer.hideWelcomeScreen,
    showWelcomeScreen: chatRenderer.showWelcomeScreen,
    checkPendingResearch,
    getImageCost: chatRenderer.getImageCost,
    setDisplayOverride,
    setHideUserBubble,
    setPendingContinue,
    regenerateFrom,
    forkFrom,
    editUserMessage,
    editAIMessage,
    resendUserMessage,
    deleteMessage,
    rewriteWith,
    continueFrom,
    _appendViewReportLink,
    hasActiveStream,
  };

  // 工具调用折叠/展开的单一委托处理器。在 document.body 上的
  // 一个监听器覆盖所有 .agent-thread-node — 运行中、已完成、
  // 流式传输中、历史渲染的、对比模式，全部覆盖。在每个
  // innerHTML 重写时重新附加每个节点监听器是
  // "需要多次点击" bug 的根源。
  if (!window.__odysseus_thread_click_bound) {
    document.body.addEventListener('click', (e) => {
      const header = e.target.closest('.agent-thread-header');
      if (!header) return;
      const node = header.closest('.agent-thread-node');
      if (!node) return;
      node.classList.toggle('open');
    });
    window.__odysseus_thread_click_bound = true;
  }

  export default chatModule;
  window.chatModule = chatModule;
