// ============================================
// Odysseus UI — 主应用编排器
// ES6 模块 — 入口点，无导出（将所有模块连接在一起）
// ============================================
import Storage from './js/storage.js';
import uiModule from './js/ui.js';
import fileHandlerModule from './js/fileHandler.js';
import modelsModule from './js/models.js';
import ragModule from './js/rag.js';
import presetsModule from './js/presets.js';
import searchModule from './js/search.js';
import chatModule from './js/chat.js';
import compareModule from './js/compare/index.js';
import documentModule from './js/document.js';
import searchChatModule from './js/search-chat.js';
import { makeWindowDraggable } from './js/windowDrag.js';
import markdownModule from './js/markdown.js';
import chatRenderer from './js/chatRenderer.js';
import sessionModule from './js/sessions.js';
import memoryModule from './js/memory.js';
import voiceRecorderModule from './js/voiceRecorder.js';
import censorModule from './js/censor.js';
import galleryModule from './js/gallery.js';
import tasksModule from './js/tasks.js';
import calendarModule from './js/calendar.js';
import notesModule from './js/notes.js';
import adminModule from './js/admin.js';
import settingsModule from './js/settings.js';
// 预先绑定所有工具模态框的统一最小化/恢复行为。
import './js/modalManager.js';
// 桌面窗口贴靠 — 将模态框拖到边缘/角落即可吸附。
import './js/tileManager.js';
import themeModule from './js/theme.js';
// 重要提示：导入 cookbook.js 时不要使用 ?v= 查询参数 — 与其他导入者
// （cookbook-hwfit.js / cookbook-diagnosis.js）使用相同的纯说明符。查询参数
// 不匹配会导致浏览器将 cookbook.js 作为两个独立模块加载两次（产生两个
// _envState 对象），这会破坏服务器选择功能。所有 cookbook 导入保持无版本号，
// 以防此问题再次发生。
import cookbookModule from './js/cookbook.js';
import groupModule from './js/group.js';
import * as researchPanelModule from './js/research/panel.js';
import ttsModule from './js/tts-ai.js';
import spinnerModule from './js/spinner.js';
import { initKeyboardShortcuts } from './js/keyboard-shortcuts.js';
import { initSidebarLayout, syncRailSide } from './js/sidebar-layout.js';
import { initSectionCollapse, initSectionDrag } from './js/section-management.js';
import i18nModule from './js/i18n.js';

const API_BASE = window.location.origin;
window.themeModule = themeModule;
window.sessionModule = sessionModule;
window.uiModule = uiModule;
window.adminModule = adminModule;
window.cookbookModule = cookbookModule;
window.i18nModule = i18nModule;

// 任何 fetch 请求返回 401 时重定向到登录页
const _origFetch = window.fetch;
window.fetch = async function(...args) {
  const res = await _origFetch.apply(this, args);
  if (res.status === 401 && !String(args[0]).includes('/api/auth/')) {
    window.location.href = '/login';
  }
  return res;
};

// 搜索设置


const el = uiModule.el;

// 默认聊天配置 — 每次新建聊天操作时刷新，以便设置
// 变更立即生效（之前仅在页面加载时缓存一次，当用户
// 更改默认模型后会过时）。
let _defaultChat = null;
async function _refreshDefaultChat() {
  try {
    const d = await (await fetch('/api/default-chat')).json();
    if (d && d.endpoint_url && d.model) {
      _defaultChat = d;
      try { window.__odysseusDefaultChat = d; } catch (_) {}
      return d;
    }
  } catch (_) {}
  return null;
}
// 启动时预先填充缓存，供同步读取 _defaultChat 的初始渲染路径使用；
// 后续读取应先调用 _refreshDefaultChat()。
_refreshDefaultChat();

async function _createDirectChatFromPreferredModel() {
  if (!sessionModule) return false;

  const pending = sessionModule.getPendingChat && sessionModule.getPendingChat();
  if (pending && pending.url && pending.modelId) {
    sessionModule.createDirectChat(pending.url, pending.modelId, pending.endpointId);
    return true;
  }

  const sessions = sessionModule.getSessions();
  const currentId = sessionModule.getCurrentSessionId();
  const current = sessions.find(s => s.id === currentId);
  if (current && current.endpoint_url && current.model) {
    sessionModule.createDirectChat(current.endpoint_url, current.model, current.endpoint_id);
    return true;
  }

  const dc = await _refreshDefaultChat();
  if (dc) {
    sessionModule.createDirectChat(dc.endpoint_url, dc.model, dc.endpoint_id);
    return true;
  }

  const withModel = sessions.filter(s => s.endpoint_url && s.model);
  if (withModel.length > 0) {
    const last = withModel[0]; // 会话按最近使用排序
    sessionModule.createDirectChat(last.endpoint_url, last.model, last.endpoint_id);
    return true;
  }

  return false;
}

// ============================================
// 事件监听器初始化
// ============================================
function initializeEventListeners() {
  // 聊天表单提交
//  document.getElementById('chat-form').addEventListener('submit', chatModule.handleChatSubmit);

  // 文件附件（溢出菜单内）
  const _overflowAttach = el('overflow-attach-btn');
  if (_overflowAttach) _overflowAttach.addEventListener('click', fileHandlerModule.openPicker);
  el('file-input').addEventListener('change', (e)=>{
    for (const f of e.target.files) fileHandlerModule.addFiles([f]);
    fileHandlerModule.renderAttachStrip();
    // 文件选择器关闭后重新聚焦文本区域（移动端键盘）
    const ta = el('message');
    if (ta) setTimeout(() => ta.focus(), 100);
  });

  // 粘贴处理
  window.addEventListener('paste', async (e)=>{
    if (!e.clipboardData) return;
    let changed = false;
    for (const item of e.clipboardData.items){
      if (item.kind === 'file'){
        const f = item.getAsFile();
        if (f) {
          fileHandlerModule.addFiles([f]);
          changed = true;
        }
      }
    }
    if (changed) fileHandlerModule.renderAttachStrip();
  });

  // 标题栏消息计数 — 监听 #chat-history 中的任何 DOM 变化，
  // 并在标题旁显示"· N msgs"。统计顶层 .msg 元素
  // （每个用户/助手轮次一个）；不包括欢迎屏幕，
  // 因为它不在 chat-history 内。
  const _metaCountEl = el('current-meta-count');
  const _chatHistEl = el('chat-history');
  if (_metaCountEl && _chatHistEl) {
    let _countScheduled = false;
    const _updateMsgCount = () => {
      _countScheduled = false;
      const n = _chatHistEl.querySelectorAll(':scope > .msg').length;
      _metaCountEl.textContent = n ? i18nModule.t('notification.msg_count', { count: n }) : '';
    };
    const _scheduleCount = () => {
      if (_countScheduled) return;
      _countScheduled = true;
      requestAnimationFrame(_updateMsgCount);
    };
    new MutationObserver(_scheduleCount).observe(_chatHistEl, { childList: true });
    _updateMsgCount();
  }

  // 滚动
  el('chat-history').addEventListener('scroll', uiModule.debounce(() => {
    const box = el('chat-history');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    uiModule.setAutoScroll(atBottom);
  }, 100));
  // 任何滚动时立即关闭所有底部弹窗
  el('chat-history').addEventListener('scroll', () => {
    document.querySelectorAll('.ctx-popup, .memory-used-detail, .msg-overflow-menu').forEach(p => p.remove());
    document.querySelectorAll('.memory-used-pill').forEach(p => { p._openDetail = null; });
  }, { passive: true });

  el('chat-history').addEventListener('wheel', (e) => {
    // 仅在用户向上滚动时禁用自动滚动（deltaY < 0）
    if (e.deltaY < 0) uiModule.setAutoScroll(false);
  });
  let _touchThrottled = false;
  el('chat-history').addEventListener('touchmove', () => {
    if (_touchThrottled) return;
    _touchThrottled = true;
    uiModule.setAutoScroll(false);
    requestAnimationFrame(() => { _touchThrottled = false; });
  }, { passive: true });

  // AI 搜索结果中的内部 #session-id 链接
  el('chat-history').addEventListener('click', (e) => {
    const link = e.target.closest('a.chat-link');
    if (!link) return;
    const href = link.getAttribute('href');
    if (href && href.startsWith('#') && sessionModule) {
      e.preventDefault();
      sessionModule.selectSession(href.slice(1));
    }
  });

  // 导出下拉按钮
  const exportDlBtn = el('export-dl-btn');
  // ── 统一弹窗关闭 ──
  // 轻量弹窗（标题栏下拉菜单、烤肉串菜单、选择器）应在任何
  // "其他操作"时消失——打开侧边栏、打开工具窗口等。每个弹窗
  // 原本各自绑定外部点击/Escape 关闭，但遗漏了非点击操作。
  // closeAllPopups() 统一处理：切换菜单移除 `.open` 类；
  // 临时附加到 body 的菜单直接删除。完整的模态框/窗口
  // 故意不在此处处理——它们通过各自的控件关闭。
  window.closeAllPopups = function closeAllPopups(except) {
    document.querySelectorAll(
      '.export-dropdown-menu.open, .overflow-menu.open, .model-picker-menu.open, .doc-overflow-menu.open'
    ).forEach(m => { if (m !== except) m.classList.remove('open'); });
    document.querySelectorAll(
      '.skill-kebab-menu, .note-reminder-menu, .task-dropdown, .doclib-card-dropdown, .email-card-dropdown, .msg-overflow-menu'
    ).forEach(m => { if (m !== except) m.remove(); });
  };
  // 打开窗口/导航控件（导轨按钮、侧边栏工具行 + 会话行、
  // 分区标题）视为"其他操作"——点击时关闭弹窗。使用冒泡阶段，
  // 以便在控件自身的处理程序之后运行（窗口已经打开；我们只是
  // 清理多余弹窗）。弹窗触发器本身不在这些选择器范围内，
  // 所以切换操作不会被破坏。
  document.addEventListener('click', (e) => {
    if (e.target.closest('.icon-rail-btn, #sidebar .list-item, .section-header-flex')) {
      window.closeAllPopups();
    }
  });

  const exportMenu = el('export-dropdown-menu');
  if (exportDlBtn && exportMenu) {
    exportDlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (exportMenu.classList.contains('open')) {
        exportMenu.classList.remove('open');
      } else {
        // 将菜单移到 body，避免受祖先元素 transform 影响
        if (exportMenu.parentElement !== document.body) document.body.appendChild(exportMenu);
        const rect = exportDlBtn.getBoundingClientRect();
        exportMenu.style.top = (rect.bottom + 4) + 'px';
        exportMenu.style.left = 'auto';
        exportMenu.style.right = (window.innerWidth - rect.right) + 'px';
        exportMenu.classList.add('open');
      }
    });
    document.addEventListener('click', () => exportMenu.classList.remove('open'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && exportMenu.classList.contains('open')) {
        exportMenu.classList.remove('open');
      }
    });
    // 打开侧边栏应关闭任何已打开的弹窗。许多代码路径会打开
    // 侧边栏（切换按钮、滑动、键盘、导轨），因此监听其 class
    // 的 hidden→visible 过渡，而不是单独挂钩每个入口。
    const _sidebarEl = el('sidebar');
    if (_sidebarEl) {
      let _wasHidden = _sidebarEl.classList.contains('hidden');
      new MutationObserver(() => {
        const nowHidden = _sidebarEl.classList.contains('hidden');
        if (_wasHidden && !nowHidden) window.closeAllPopups();
        _wasHidden = nowHidden;
      }).observe(_sidebarEl, { attributes: true, attributeFilter: ['class'] });
    }
    // 点击会话名称也打开下拉菜单
    const currentMeta = el('current-meta');
    if (currentMeta) {
      currentMeta.style.cursor = 'pointer';
      currentMeta.addEventListener('click', (e) => {
        e.stopPropagation();
        exportDlBtn.click();
      });
    }
  }

  // 将当前聊天历史序列化为纯文本副本。
  // 按 DOM 顺序包含用户消息、助手回复和代理工具调用。
  function _serializeChatTranscript() {
    const box = document.getElementById('chat-history');
    if (!box) return '';
    const parts = [];
    for (const child of box.children) {
      if (child.classList?.contains('msg')) {
        const isUser = child.classList.contains('msg-user');
        let label;
        if (isUser) {
          label = i18nModule.t('export.user_label');
        } else {
          const roleEl = child.querySelector('.role');
          const ts = roleEl?.querySelector('.role-timestamp');
          let raw = roleEl ? roleEl.textContent : '';
          if (ts) raw = raw.replace(ts.textContent, '');
          label = (raw || '').trim() || i18nModule.t('export.assistant_label');
        }
        const body = child.querySelector('.body');
        // 优先使用 dataset.raw（原始 markdown）而非 innerText（渲染后的 HTML 文本）
        // 以避免多余换行和格式化产物。
        const text = body ? (body.dataset.raw || body.innerText || body.textContent || '').trim() : '';
        if (text) parts.push(`${label}: ${text}`);
      } else if (child.classList?.contains('agent-thread')) {
        const lines = [i18nModule.t('export.tool_calls_label')];
        for (const n of child.querySelectorAll('.agent-thread-node')) {
          const tool = n.querySelector('.agent-thread-tool')?.textContent?.trim() || 'tool';
          const cmd = n.querySelector('.agent-thread-cmd')?.textContent?.trim() || '';
          const output = n.querySelector('.agent-tool-output pre')?.textContent?.trim() || '';
          const status = n.classList.contains('error') ? i18nModule.t('export.tool_status_failed') : i18nModule.t('export.tool_status_done');
          let line = `- ${tool} [${status}]`;
          if (cmd) line += `\n  cmd: ${cmd}`;
          if (output) {
            const truncated = output.length > 2000 ? output.slice(0, 2000) + '…' : output;
            line += `\n  out: ${truncated}`;
          }
          lines.push(line);
        }
        parts.push(lines.join('\n'));
      }
    }
    return parts.join('\n\n');
  }

  // 导出：复制所有消息
  const exportCopyBtn = el('export-copy-btn');
  if (exportCopyBtn) {
    exportCopyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      exportMenu.classList.remove('open');
      const transcript = _serializeChatTranscript();
      // 新建/空的聊天没有可复制的内容 — 不写入空字符串并错误报告"已复制"。
      if (!transcript.trim()) { uiModule.showToast(i18nModule.t('notification.nothing_to_copy')); return; }
      await uiModule.copyToClipboard(transcript);
    });
  }

  // 导出：PDF
  const exportPdfBtn = el('export-pdf-btn');
  if (exportPdfBtn) {
    exportPdfBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.remove('open');
      const meta = sessionModule.getSessions().find(s => s.id === sessionModule.getCurrentSessionId());
      const sessionName = meta ? meta.name : i18nModule.t('export.default_pdf_title');
      const originalTitle = document.title;
      document.title = sessionName;
      const chatHistory = document.getElementById('chat-history');
      if (chatHistory) chatHistory.dataset.printTitle = sessionName;
      document.querySelectorAll('#chat-history details:not([open])').forEach(d => {
        d.setAttribute('open', '');
        d.dataset.printOpened = '1';
      });
      window.print();
      document.title = originalTitle;
      document.querySelectorAll('#chat-history details[data-print-opened]').forEach(d => {
        d.removeAttribute('open');
        d.removeAttribute('data-print-opened');
      });
    });
  }

  // 导出：保存到文档
  const exportDocBtn = el('export-doc-btn');
  if (exportDocBtn) {
    exportDocBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      exportMenu.classList.remove('open');
      try {
        const sessionId = sessionModule.getCurrentSessionId();
        const texts = _serializeChatTranscript();
        const meta = sessionModule.getSessions().find(s => s.id === sessionId);
        const title = meta?.name || i18nModule.t('notes.untitled');
        const res = await fetch(`${API_BASE}/api/document`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, title, content: texts }),
        });
        if (!res.ok) throw new Error('Failed');
        const doc = await res.json();
        if (documentModule) documentModule.loadDocument(doc.id);
        uiModule.showToast(i18nModule.t('notification.saved_to_documents'));
      } catch (err) {
        console.error('Save to docs failed:', err);
        uiModule.showError(i18nModule.t('notification.failed_save_to_documents'));
      }
    });
  }

  // 从顶部栏重命名会话
  const exportRenameBtn = el('export-rename-btn');
  if (exportRenameBtn) {
    exportRenameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.remove('open');
      let sid = sessionModule.getCurrentSessionId();
      // 全新聊天还没有会话 ID — 如果有待提交的聊天仍允许重命名
      // （我们在提交时实体化会话以保证名称保留）。
      const hasPending = sessionModule.hasPendingChat && sessionModule.hasPendingChat();
      if (!sid && !hasPending) return;
      const meta = sid ? sessionModule.getSessions().find(s => s.id === sid) : null;
      const currentName = meta?.name || '';
      const metaEl = el('current-meta');
      if (!metaEl) return;

      // 用输入框替换标题
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentName;
      input.className = 'session-rename-input';
      input.style.cssText = 'font-size:inherit;background:transparent;border:none;border-bottom:1px solid var(--accent, var(--red));color:var(--fg);outline:none;width:100%;padding:0;';
      const origText = metaEl.textContent;
      metaEl.textContent = '';
      metaEl.appendChild(input);
      input.focus();
      input.select();

      const commit = async () => {
        const newName = input.value.trim();
        if (newName && newName !== currentName) {
          // 先实体化待提交的（新建）聊天，使其拥有可用于重命名的 ID。
          if (!sid && sessionModule.materializePendingSession) {
            try { await sessionModule.materializePendingSession(); sid = sessionModule.getCurrentSessionId(); } catch (_) {}
          }
          if (!sid) { metaEl.textContent = newName; return; }
          const fd = new FormData();
          fd.append('name', newName);
          await fetch(`${API_BASE}/api/session/${sid}`, { method: 'PATCH', body: fd });
          const _m = sessionModule.getSessions().find(s => s.id === sid);
          if (_m) _m.name = newName;
          metaEl.textContent = newName;
          uiModule.showToast(i18nModule.t('notification.renamed'));
          sessionModule.loadSessions();
        } else {
          metaEl.textContent = origText;
        }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { input.removeEventListener('blur', commit); metaEl.textContent = origText; }
      });
    });
  }

  // 自定义预设模态框处理
  const closeCustomPreset = el('close-custom-preset');
  const cancelCustomPreset = el('cancel-custom-preset');
  const saveCustomPreset = el('save-custom-preset');

  if (closeCustomPreset) {
    closeCustomPreset.addEventListener('click', () => {
      el('custom-preset-modal').classList.add('hidden');
    });
  }

  if (cancelCustomPreset) {
    cancelCustomPreset.addEventListener('click', () => {
      el('custom-preset-modal').classList.add('hidden');
    });
  }

  if (saveCustomPreset) {
    saveCustomPreset.addEventListener('click', async () => {
      // 当分组标签页激活时跳过角色保存 — group.js 负责处理
      const activeTab = document.querySelector('.preset-tab.active');
      if (activeTab && activeTab.dataset.chartab === 'group') return;
      await presetsModule.saveCustomPreset(uiModule.showToast, uiModule.showError);
    });
  }

  // 设置下拉菜单已移除 — 项目现在内联在侧边栏分区中

  


  // 用 Escape 键逐一关闭弹窗（最顶层优先）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 如果确认对话框已打开，让它自行处理 Escape
      const confirmOverlay = document.getElementById('styled-confirm-overlay');
      if (confirmOverlay && !confirmOverlay.classList.contains('hidden')) return;

      // 如果正在内联编辑记忆，取消编辑而不是关闭模态框
      const editingMemory = document.querySelector('.memory-item-editing');
      if (editingMemory) {
        if (window.memoryModule) window.memoryModule.renderMemoryList();
        return;
      }

      // 优先级顺序：最顶层的覆盖层优先。每次按键只关闭一个，
      // 这样如果窗口堆叠在另一个窗口上（例如记分板叠在比较窗口上），
      // 只关闭最顶层的，而不是两个都关。

      // 记分板位于比较窗口之上 — 先关闭它。
      const scoreboardOverlay = document.getElementById('scoreboard-overlay');
      if (scoreboardOverlay) {
        scoreboardOverlay.remove();
        return;
      }

      if (searchChatModule && searchChatModule.isOpen()) {
        searchChatModule.closeSearch();
        return;
      }

      // 比较模型选择器
      const cmpOverlay = document.getElementById('compare-model-overlay');
      if (cmpOverlay) {
        cmpOverlay.remove();
        return;
      }

      // 主题弹窗
      const themeModal = document.getElementById('theme-modal');
      if (themeModal && !themeModal.classList.contains('hidden')) {
        themeModule.closePopup();
        return;
      }

      // 日历拥有几个内部 Escape 层级（设置面板、事件表单，
      // 然后是日历模态框本身）。让 calendar.js 处理这些，
      // 而不是回退到不相关的页面级后备方案（如文档面板最小化）。
      const calendarModal = document.getElementById('calendar-modal');
      if (calendarModal && !calendarModal.classList.contains('hidden') && getComputedStyle(calendarModal).display !== 'none') {
        return;
      }

      // 模型选择器弹窗 — 在打开任何模态框之前关闭
      const modelPickerMenu = document.getElementById('model-picker-menu');
      if (modelPickerMenu && modelPickerMenu.classList.contains('open')) {
        modelPickerMenu.classList.remove('open');
        return;
      }

      // 一次关闭一个模态框（DOM 中最后的 = 最顶层）
      // 映射 modal id → sidebar list-item id 以清除激活状态
      const modalItemMap = {
        'cookbook-modal': null,
        'rename-session-modal': null,
        'rename-ai-modal': null,
        'custom-preset-modal': null,
        'memory-modal': null,
      };

      // 动态模态框（关闭时从 DOM 移除）
      const dynamicModals = ['library-modal', 'archive-modal', 'doclib-modal', 'gallery-modal', 'tasks-modal', 'email-lib-modal'];
      for (const id of dynamicModals) {
        const m = document.getElementById(id);
        if (id === 'gallery-modal') {
          const editor = document.getElementById('gallery-editor-container');
          const editing = !!window.__galleryEditLive || !!(
            editor &&
            getComputedStyle(editor).display !== 'none' &&
            editor.querySelector('.gallery-editor')
          );
          if (editing) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
        }
        if (m) { dismissModal(m); return; }
      }

      for (const modalId of Object.keys(modalItemMap)) {
        const modal = el(modalId);
        if (modal && !modal.classList.contains('hidden')) {
          dismissModal(modal);
          return;
        }
      }

      // 没有模态框/弹窗打开 — 如果文档面板打开，则最小化它。
      // Esc 应将文档收起到停靠标签（与折叠箭头相同），
      // 而不是完全关闭 — closePanel('down') 注册标签 +
      // Modals.minimize 以保留文档并可恢复。
      if (documentModule && documentModule.isPanelOpen()) {
        // 如果文档编辑器中有文本选中，让 Escape 先清除选中
        const docTextarea = document.getElementById('doc-editor-textarea');
        if (docTextarea && docTextarea.selectionStart !== docTextarea.selectionEnd) {
          return;
        }
        documentModule.closePanel('down');
        return;
      }
    }
  });

  // ── 共享的模态框关闭辅助函数 ──
  const _modalSidebarMap = {
    'memory-modal': null,
    'theme-modal': null,
  };
  const _dynamicModalIds = ['library-modal', 'archive-modal', 'doclib-modal', 'gallery-modal', 'tasks-modal'];
  function dismissModal(modal) {
    if (!modal || modal.classList.contains('hidden')) return;
    if (modal.id === 'gallery-modal') {
      const editor = document.getElementById('gallery-editor-container');
      const editing = !!window.__galleryEditLive || !!(
        editor &&
        getComputedStyle(editor).display !== 'none' &&
        editor.querySelector('.gallery-editor')
      );
      if (editing) return;
    }
    const content = modal.querySelector('.modal-content') || modal.querySelector('#theme-popup');
    if (content && !content.classList.contains('modal-closing')) {
      content.classList.remove('sheet-ready');
      content.style.transform = '';
      content.style.transition = '';
      content.classList.add('modal-closing');
      content.addEventListener('animationend', () => {
        if (_dynamicModalIds.includes(modal.id)) {
          modal.remove();
        } else {
          modal.classList.add('hidden');
          content.classList.remove('modal-closing');
        }
      }, { once: true });
      // 后备方案，以防 animationend 不触发
      setTimeout(() => {
        if (modal.parentElement && !modal.classList.contains('hidden')) {
          if (_dynamicModalIds.includes(modal.id)) modal.remove();
          else { modal.classList.add('hidden'); content.classList.remove('modal-closing'); }
        }
      }, 250);
    } else {
      if (content) content.classList.remove('sheet-ready');
      if (_dynamicModalIds.includes(modal.id)) modal.remove();
      else modal.classList.add('hidden');
    }
  }

  // 点击模态框内容外部 → 关闭模态框
  document.addEventListener('click', (e) => {
    if (uiModule.isTouchInsideModal()) return; // 抑制触摸滚动产生的合成事件
    const modal = e.target.closest('.modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (e.target.closest('.modal-content')) return;
    dismissModal(modal);
  });

  // 移动端底部面板滑动关闭由 ui.js 处理（仅标题栏）

  // ── 辅助函数：开始全新聊天（取消选中当前，清除历史，显示欢迎页）──
  function _startFreshChat() {
    try {
      const prevId = sessionModule && sessionModule.getCurrentSessionId ? sessionModule.getCurrentSessionId() : null;
      if (chatModule && chatModule.detachCurrentStream) chatModule.detachCurrentStream(prevId);
      else if (chatModule && chatModule.abortCurrentRequest) chatModule.abortCurrentRequest();
    } catch (e) {
      console.warn('fresh chat stream detach failed:', e);
    }
    if (sessionModule) sessionModule.setCurrentSessionId(null);
    const box = el('chat-history');
    if (box) box.innerHTML = '';
    if (chatModule && chatModule.showWelcomeScreen) {
      chatModule.showWelcomeScreen();
    }
    // 关闭文档面板（如果已打开）
    if (documentModule && documentModule.closePanel) documentModule.closePanel();
    if (researchPanelModule && researchPanelModule.isOpen()) researchPanelModule.closePanel();
    // 重置研究溢出圆点（但不触碰研究状态 — 由调用者管理）
    const _overflowRes = el('overflow-research-btn');
    if (_overflowRes) _overflowRes.classList.remove('active');
    if (typeof updatePlusDot === 'function') updatePlusDot();
    // 重置代理模式为聊天
    const modeToggle = el('agent-mode-toggle');
    if (modeToggle && modeToggle.checked) { modeToggle.checked = false; modeToggle.dispatchEvent(new Event('change')); }
    // 清除角色/人设
    if (presetsModule && presetsModule.deactivateCharacter) presetsModule.deactivateCharacter();
  }

  /** 同步研究指示器按钮 + 溢出菜单 + 工具侧边栏激活状态。 */
  function _syncResearchIndicator(active) {
    const btn = el('research-toggle-btn');
    const overflow = el('overflow-research-btn');
    const toolBtn = el('tool-research-btn');
    const chk = el('research-toggle');
    if (btn) {
      btn.style.display = active ? '' : 'none';
      btn.classList.toggle('active', active);
    }
    // 显示在聊天框中时从溢出菜单隐藏（避免重复）
    if (overflow) {
      overflow.classList.toggle('active', active);
      overflow.style.display = active ? 'none' : '';
    }
    if (toolBtn) toolBtn.classList.toggle('active', active);
    if (chk) chk.checked = active;
    // 研究模式禁用 Shell 访问
    const bashChk = el('bash-toggle');
    const bashBtn = el('bash-toggle-btn');
    if (active) {
      if (bashChk && bashChk.checked) {
        bashChk.checked = false;
        if (bashBtn) bashBtn.classList.remove('active');
        saveToolPref('bash', (loadToggleState().mode || 'chat'), false);
      }
    }
    const s = loadToggleState(); s.research = active; saveToggleState(s);
    updatePlusDot();
    document.dispatchEvent(new CustomEvent('overflow-state-change'));
  }

  /** 同步群组聊天指示器按钮 + 溢出菜单。 */
  function _syncGroupIndicator(active) {
    const btn = el('group-toggle-btn');
    const overflow = el('overflow-group-btn');
    const chk = el('group-toggle');
    if (btn) {
      btn.style.display = active ? '' : 'none';
      btn.classList.toggle('active', active);
    }
    if (overflow) {
      overflow.classList.toggle('active', active);
      overflow.style.display = active ? 'none' : '';
    }
    if (chk) chk.checked = active;
    // 显示/隐藏模型选择器
    const _mpw = el('model-picker-wrap');
    if (_mpw) _mpw.style.display = active ? 'none' : '';
    // 互斥：群组禁用研究 + 网页搜索
    if (active) {
      _syncResearchIndicator(false);
      const _webChk = el('web-toggle');
      if (_webChk && _webChk.checked) {
        _webChk.checked = false;
        saveToolPref('web', (loadToggleState().mode || 'chat'), false);
      }
    }
    const s = loadToggleState(); s.group = active; saveToggleState(s);
    updatePlusDot();
    document.dispatchEvent(new CustomEvent('overflow-state-change'));

    // 更新研究模式的欢迎屏幕
    const ws = el('welcome-screen');
    const welcomeName = document.querySelector('.welcome-name');
    const welcomeSub = el('welcome-sub');
    const tipEl = el('welcome-tip');
    const _resIco = '<svg class="welcome-boat" style="position:relative;top:0.5px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
    if (active) {
      if (welcomeName) {
        if (!welcomeName.dataset.researchOrigHtml) welcomeName.dataset.researchOrigHtml = welcomeName.innerHTML;
        welcomeName.innerHTML = _resIco + i18nModule.t('research.title');
      }
      if (welcomeSub) {
        if (!welcomeSub.dataset.researchOrigText) welcomeSub.dataset.researchOrigText = welcomeSub.textContent;
        welcomeSub.textContent = i18nModule.t('research.description');
      }
      if (tipEl) {
        if (!tipEl.dataset.researchOrigTip) tipEl.dataset.researchOrigTip = tipEl.textContent;
        tipEl.textContent = '';
        tipEl.style.display = 'none';
      }
      // 研究模式期间隐藏 Nobody 切换
      const _incBtn = el('incognito-btn');
      if (_incBtn) { _incBtn.dataset.researchOrigDisplay = _incBtn.style.display; _incBtn.style.display = 'none'; }
      // 关闭文档面板（如果已打开）
      if (window.documentModule && window.documentModule.isPanelOpen()) {
        window.documentModule.closePanel();
      }
    } else {
      if (welcomeName && welcomeName.dataset.researchOrigHtml) {
        welcomeName.innerHTML = welcomeName.dataset.researchOrigHtml;
        delete welcomeName.dataset.researchOrigHtml;
      }
      if (welcomeSub && welcomeSub.dataset.researchOrigText) {
        welcomeSub.textContent = welcomeSub.dataset.researchOrigText;
        delete welcomeSub.dataset.researchOrigText;
      }
      if (tipEl && tipEl.dataset.researchOrigTip) {
        tipEl.textContent = tipEl.dataset.researchOrigTip;
        tipEl.style.opacity = '';
        tipEl.style.display = '';
        delete tipEl.dataset.researchOrigTip;
      }
      // 恢复 Nobody 切换
      const _incBtn2 = el('incognito-btn');
      if (_incBtn2 && _incBtn2.dataset.researchOrigDisplay !== undefined) {
        _incBtn2.style.display = _incBtn2.dataset.researchOrigDisplay;
        delete _incBtn2.dataset.researchOrigDisplay;
      }
    }
    if (ws) { ws.style.animation = 'none'; ws.offsetHeight; ws.style.animation = 'welcome-enter 0.3s ease-out both'; }
  }

  // ── 如果比较激活则关闭（所有工具/侧边栏激活时使用）──
  // 如果比较之前是激活的则返回 true（页面将重载），调用者应提前返回
  function _closeCompareIfActive() {
    if (compareModule && compareModule.isActive()) {
      compareModule.deactivate(true);
      return true;
    }
    return false;
  }

  // ── 工具分区点击处理 ──
  const toolCompareBtn = el('tool-compare-btn');
  if (toolCompareBtn) {
    toolCompareBtn.addEventListener('click', () => {
      if (compareModule) {
        if (compareModule.isActive()) {
          // 已激活 — 切换关闭
          compareModule.toggleMode();
          return;
        }
        // 打开比较前关闭其他独占工具
        const resChk = el('research-toggle');
        if (resChk && resChk.checked) {
          _syncResearchIndicator(false);
        }
        _startFreshChat();
        compareModule.toggleMode();
      }
    });
  }

  const toolResearchBtn = el('tool-research-btn');
  if (toolResearchBtn) {
    toolResearchBtn.addEventListener('click', () => {
      researchPanelModule.toggle();
    });
  }

  // ── Cookbook 模态框切换 ──
  const toolCookbookBtn = el('tool-cookbook-btn');
  if (toolCookbookBtn) {
    toolCookbookBtn.addEventListener('click', async () => {
      if (!cookbookModule) return;
      // 先尝试通过管理器进行最小化→恢复或打开→最小化
      const Modals = await import('./js/modalManager.js');
      if (!Modals.toggle('cookbook-modal')) {
        // 尚未注册 → 全新打开
        cookbookModule.open();
      }
    });
  }

  // 文档库工具按钮
  const toolDoclibBtn = el('tool-doclib-btn');
  if (toolDoclibBtn) {
    toolDoclibBtn.addEventListener('click', () => {
      if (_closeCompareIfActive()) return;
      if (documentModule) {
        if (documentModule.isLibraryOpen()) {
          documentModule.closeLibrary();
        } else {
          documentModule.openLibrary();
        }
      }
    });
  }

  // 图库工具按钮
  const toolGalleryBtn = el('tool-gallery-btn');
  if (toolGalleryBtn) {
    toolGalleryBtn.addEventListener('click', async () => {
      if (!galleryModule) return;
      const Modals = await import('./js/modalManager.js');
      if (!Modals.toggle('gallery-modal')) {
        if (galleryModule.isGalleryOpen()) galleryModule.closeGallery();
        else galleryModule.openGallery();
      }
    });
  }

  // 任务工具按钮
  const toolTasksBtn = el('tool-tasks-btn');
  if (toolTasksBtn) {
  // 代理按钮（侧边栏 + 导轨）
  const agentsBtns = [el("rail-agents"), el("tool-agents-btn")].filter(Boolean);
  agentsBtns.forEach(btn => {
    btn.addEventListener("click", () => {
    });
  });
    toolTasksBtn.addEventListener('click', () => {
      if (tasksModule) {
        tasksModule.isTasksOpen() ? tasksModule.closeTasks() : tasksModule.openTasks();
      }
    });
  }

  // 日历工具按钮
  const toolCalendarBtn = el('tool-calendar-btn');
  if (toolCalendarBtn) {
    toolCalendarBtn.addEventListener('click', async () => {
      if (!calendarModule) return;
      const Modals = await import('./js/modalManager.js');
      // toggle 在已注册的模态框被最小化/恢复时返回 true；
      // 没有注册任何内容时返回 false → 全新打开。
      if (!Modals.toggle('calendar-modal')) {
        if (calendarModule.isCalendarOpen()) calendarModule.closeCalendar();
        else calendarModule.openCalendar();
      }
    });
  }

  // 笔记工具按钮
  const toolNotesBtn = el('tool-notes-btn');
  if (toolNotesBtn) {
    toolNotesBtn.addEventListener('click', () => {
      if (notesModule) {
        notesModule.togglePanel();
      }
    });
  }
  // 页面加载时以及每5分钟刷新笔记到期提醒标记
  if (notesModule && notesModule.refreshDueBadge) {
    notesModule.refreshDueBadge();
    setInterval(() => notesModule.refreshDueBadge(), 5 * 60 * 1000);
  }

  // 基于 URL 的面板路由 — 收藏 /calendar、/notes、/cookbook 等路径，
  // 相应的工具会在页面加载时自动打开。
  const urlPath = window.location.pathname;
  // 始终可见的图标导轨的当前宽度。导轨可通过拖拽调整大小，
  // 并在窄视口上隐藏，所以每次调用时实时读取而不是硬编码 48px。
  // 当导轨未渲染时返回 0。
  const _iconRailWidth = () => {
    const r = document.getElementById('icon-rail');
    if (!r) return 0;
    const cs = window.getComputedStyle(r);
    if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
    return Math.round(r.getBoundingClientRect().width);
  };
  // 收起宽侧边栏，使图标导轨（48px 迷你侧边栏）显示在其位置。
  // 两者互斥 — sidebar-layout.js:57 仅在设置 `.sidebar.hidden` 时
  // 显示导轨。由 /email 和 /notes 路由打开器使用，使这些全屏视图
  // 保持导轨可见作为用户的导航条。将之前的状态记录在 body 上，
  // 以便配对的关闭处理程序可以恢复它，而不会覆盖用户在此期间
  // 手动切换的操作。
  const _collapseSidebarToRail = () => {
    const sb = document.getElementById('sidebar');
    const rail = document.getElementById('icon-rail');
    if (!sb || !rail) return;
    const wasVisible = !sb.classList.contains('hidden');
    if (wasVisible) {
      document.body.dataset.routeCollapsedSidebar = '1';
    }
    sb.classList.add('hidden');
    rail.classList.remove('rail-hidden');
    // syncRailSide() 根据我们刚设置的 class 来翻转 iconRail.style.display。
    // 由 sidebar-layout.js 暴露在 window 上。
    try { window.syncRailSide && window.syncRailSide(); } catch (_) {}
  };
  // 配对恢复：如果路由打开器收起了侧边栏，在全屏视图关闭时
  // 重新展开它。仅在用户在此期间未手动切换时恢复（我们通过
  // MutationObserver 在 `.sidebar.hidden` 上监听手动汉堡菜单点击
  // 来清除标记）。
  const _restoreSidebarIfRouteCollapsed = () => {
    if (document.body.dataset.routeCollapsedSidebar !== '1') return;
    delete document.body.dataset.routeCollapsedSidebar;
    const sb = document.getElementById('sidebar');
    if (!sb) return;
    sb.classList.remove('hidden');
    try { window.syncRailSide && window.syncRailSide(); } catch (_) {}
  };
  // 暴露出去，使 closeEmailLibrary / notes 关闭时可以调用此函数，
  // 而无需直接导入 app.js。
  window._restoreSidebarIfRouteCollapsed = _restoreSidebarIfRouteCollapsed;
  // 在侧边栏再次变为可见时立即清除标记（用户汉堡菜单点击，
  // 或我们自己的 _restoreSidebarIfRouteCollapsed 调用 —
  // 两个端点都是相同的可观察状态变化）。
  {
    const sb = document.getElementById('sidebar');
    if (sb && typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => {
        if (!sb.classList.contains('hidden')) {
          delete document.body.dataset.routeCollapsedSidebar;
        }
      }).observe(sb, { attributes: true, attributeFilter: ['class'] });
    }
  }
  const _routeOpen = {
    '/notes':    () => {
      if (!notesModule) return;
      _collapseSidebarToRail();
      notesModule.openPanel();
      // 提升到带导轨可见的全屏模式。面板本身连接了全屏切换
      // （#notes-fullscreen-toggle）；借助该路径使按钮图标翻转，
      // 并同时应用 overflow:hidden。使用 rAF 重试以防面板稍后挂载。
      const _go = () => {
        const btn = document.getElementById('notes-fullscreen-toggle');
        const pane = document.querySelector('.notes-pane');
        if (!pane) return false;
        if (!pane.classList.contains('notes-pane-fullscreen') && btn) btn.click();
        return true;
      };
      if (!_go()) {
        requestAnimationFrame(_go);
        setTimeout(_go, 50);
        setTimeout(_go, 200);
      }
    },
    '/calendar': () => calendarModule && calendarModule.openCalendar(),
    '/cookbook': () => document.getElementById('tool-cookbook-btn')?.click(),
    '/email':    () => {
      // 收起宽侧边栏 → 图标导轨（48px），以便用户在全屏邮件视图
      // 旁边保持导航可见。
      _collapseSidebarToRail();
      // 先创建一个新聊天，这样回复（或用户从邮件链出的任何 AI 工作）
      // 会存在于自己的会话中，而不是嫁接在上次打开的内容上。
      // 导轨按钮内置了完整的默认聊天/回退模型解析逻辑，直接委托给它。
      try { document.getElementById('rail-new-session')?.click(); } catch (_) {}
      // 邮件库通过点击邮件分区的 HEADER 行
      // （.section-header-flex）打开，而不是标题 span。触发那个，然后
      // 在下一帧将模态框贴靠到全屏。
      const hdr = document.querySelector('#email-section .section-header-flex');
      if (hdr) hdr.click();
      // 模态框在 openEmailLibrary 内同步构建，所以一帧后
      // 它已在 DOM 中并准备好被标记。全屏在左侧保留图标导轨可见，
      // 这样导航只需一次点击（参照 #93）。宽度 = 视口减去导轨。
      // 只需添加 class — .email-lib-fullscreen .modal-content 的 CSS 规则
      // 处理所有定位（使用 !important 覆盖 openEmailLibrary
      // 挂载后的居中 rAF），并从 --icon-rail-w 读取导轨宽度。
      const _goFullscreen = () => {
        const modal = document.getElementById('email-lib-modal');
        if (!modal) return false;
        modal.classList.add('email-lib-fullscreen');
        return true;
      };
      _goFullscreen();
      requestAnimationFrame(_goFullscreen);
      setTimeout(_goFullscreen, 50);
      setTimeout(_goFullscreen, 200);
    },
    '/memory':   () => document.getElementById('tool-memory-btn')?.click(),
    '/gallery':  () => document.getElementById('tool-gallery-btn')?.click(),
    '/tasks':    () => document.getElementById('tool-tasks-btn')?.click(),
    '/library':  () => sessionModule && sessionModule.openLibrary && sessionModule.openLibrary(),
  };
  const _opener = _routeOpen[urlPath];
  // 延迟执行 opener — 在初始化到这个点时，我们触发的模块处理程序
  // （#rail-new-session 点击处理、emailInbox 中的邮件分区标题
  // 点击处理、sessionModule 加载的会话列表）仍在同一函数的下方
  // 继续连接中。将 opener 暂存，使其在下方
  // sessionModule.loadSessions().finally() 中运行。
  if (_opener) window._odysseusRouteOpener = _opener;

  // 档案库浏览器工具按钮
  const toolLibraryBtn = el('tool-library-btn');
  if (toolLibraryBtn) {
    toolLibraryBtn.addEventListener('click', () => {
      if (sessionModule) sessionModule.openLibrary();
    });
  }

  // 文档库行上的"+"→ 创建新的空白文档并在编辑器中打开
  // （镜像邮件分区的撰写"+"按钮）。stopPropagation 以避免
  // 同时触发行的打开文档库点击。
  const libraryNewDocBtn = el('library-new-doc-btn');
  if (libraryNewDocBtn) {
    libraryNewDocBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        if (documentModule && documentModule.newDocument) await documentModule.newDocument();
      } catch (err) {
        console.error('New document from Library failed:', err);
        if (uiModule && uiModule.showError) uiModule.showError(i18nModule.t('notification.could_not_create_document'));
      }
    });
  }

  // 管理聊天 — 打开完整文档库模态框（与聊天折叠面板切换解耦）
  const chatsLibraryBtn = el('chats-library-btn');
  if (chatsLibraryBtn) {
    chatsLibraryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sessionModule) sessionModule.openLibrary('chats');
    });
  }

  const toolArchiveBtn = el('tool-archive-btn');
  if (toolArchiveBtn) {
    toolArchiveBtn.addEventListener('click', () => {
      if (sessionModule) sessionModule.openLibrary('archive');
    });
  }

  const toolThemeBtn = el('tool-theme-btn');
  if (toolThemeBtn) {
    toolThemeBtn.addEventListener('click', () => {
      const tm = document.getElementById('theme-modal');
      if (tm) tm.classList.remove('hidden');
    });
  }

  // 语言切换按钮
  const toolLangBtn = el('tool-language-btn');
  if (toolLangBtn) {
    toolLangBtn.addEventListener('click', () => {
      const lm = document.getElementById('language-modal');
      if (!lm) return;
      lm.classList.remove('hidden');
      // 高亮当前激活的语言区域
      const currentLocale = i18nModule.getCurrentLocale();
      lm.querySelectorAll('.language-option-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-locale') === currentLocale);
      });
    });
  }

  // 语言模态框关闭按钮
  const closeLangPopup = el('close-language-popup');
  if (closeLangPopup) {
    closeLangPopup.addEventListener('click', () => {
      const lm = document.getElementById('language-modal');
      if (lm) lm.classList.add('hidden');
    });
  }

  // 语言模态框背景点击关闭
  const langModal = document.getElementById('language-modal');
  if (langModal) {
    langModal.addEventListener('click', (e) => {
      if (e.target === langModal) {
        langModal.classList.add('hidden');
      }
    });
  }

  // 语言选项按钮
  document.querySelectorAll('.language-option-btn').forEach(btn => {
    btn.addEventListener('click', async function() {
      const locale = this.getAttribute('data-locale');
      if (!locale) return;
      const oldLocale = i18nModule.getCurrentLocale();
      if (locale === oldLocale) return;
      await i18nModule.setLocale(locale);
      // 更新激活状态
      this.parentElement.querySelectorAll('.language-option-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-locale') === locale);
      });
      // 显示提示通知
      if (uiModule && uiModule.showToast) {
        const displayName = i18nModule.getLocaleDisplayName(locale);
        uiModule.showToast(i18nModule.t('language.switch_success') + ' - ' + displayName);
      }
      // 短暂延迟后关闭模态框
      const lm = document.getElementById('language-modal');
      if (lm) {
        setTimeout(() => lm.classList.add('hidden'), 300);
      }
    });
  });

  // 侧边栏切换
  const toggleSidebarOption = el('toggle-sidebar-option');
  if (toggleSidebarOption) {
    toggleSidebarOption.addEventListener('click', () => {
      const sidebar = el('sidebar');
      sidebar.classList.toggle('hidden');
    });
  }

  // 侧边栏用户栏 — 设置、管理、个人资料
  const userBarSettings = el('user-bar-settings');
  const userBarProfile = el('user-bar-profile');
  const userBarAdmin = el('user-bar-admin');

  if (userBarSettings) {
    userBarSettings.addEventListener('click', () => settingsModule.open());
  }
  if (userBarProfile) {
    // 点击用户（头像 + 名称）直接跳转到账户标签页，
    // 而不是落在上次选择的标签上。
    userBarProfile.addEventListener('click', () => settingsModule.open('account'));
  }
  if (userBarAdmin) {
    userBarAdmin.addEventListener('click', () => adminModule.open());
  }

  // 获取认证状态 — 填充用户栏并在管理员时显示管理按钮
  fetch(`${API_BASE}/api/auth/status`, { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => {
      window._isAdmin = !!d.is_admin;
      if (d.is_admin && userBarAdmin) userBarAdmin.style.display = '';
      const userBarName = el('user-bar-name');
      const userBarAvatar = el('user-bar-avatar');
      if (userBarName && d.username) {
        let displayName = d.username;
        // 遮盖邮箱地址
        if (displayName.includes('@')) {
          const [local, domain] = displayName.split('@');
          const ext = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
          displayName = local.charAt(0) + '•••@••••' + ext;
        }
        userBarName.textContent = displayName;
        if (userBarAvatar) userBarAvatar.textContent = d.username.charAt(0).toUpperCase();
      }
      // 应用每个用户的权限限制
      if (d.privileges) {
        window._userPrivileges = d.privileges;
        const p = d.privileges;
        // 隐藏代理模式切换
        if (!p.can_use_agent) {
          const modeToggle = document.getElementById('mode-toggle');
          if (modeToggle) modeToggle.closest('.chat-input-toggle')?.style.setProperty('display', 'none');
        }
        // 隐藏 Bash 切换
        if (!p.can_use_bash) {
          const bashToggle = document.getElementById('bash-toggle');
          if (bashToggle) bashToggle.closest('.chat-input-toggle')?.style.setProperty('display', 'none');
          const bashBtn = document.getElementById('tool-bash-btn');
          if (bashBtn) bashBtn.style.display = 'none';
        }
        // 隐藏文档按钮
        if (!p.can_use_documents) {
          const docBtn = document.getElementById('overflow-doc-btn');
          if (docBtn) docBtn.style.display = 'none';
          const docInd = document.getElementById('doc-indicator-btn');
          if (docInd) docInd.style.display = 'none';
        }
        // 隐藏研究切换
        if (!p.can_use_research) {
          const resBtn = document.getElementById('research-toggle-btn');
          if (resBtn) resBtn.style.display = 'none';
          const resOverflow = document.getElementById('overflow-research-btn');
          if (resOverflow) resOverflow.style.display = 'none';
        }
        // 隐藏图片生成选项
        if (!p.can_generate_images) {
          const imgBtn = document.getElementById('tool-image-btn');
          if (imgBtn) imgBtn.style.display = 'none';
        }
      }
    })
    .catch(() => {});

  // 会话排序下拉菜单
  const sortBtn = el('session-sort-btn');
  const sortDropdown = el('session-sort-dropdown');
  if (sortBtn && sortDropdown) {
    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sortDropdown.style.display = sortDropdown.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', () => { sortDropdown.style.display = 'none'; });
    sortDropdown.addEventListener('click', (e) => e.stopPropagation());

    // 排序模式选项（最新、最旧、最近活跃）— 可切换
    sortDropdown.querySelectorAll('.sort-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const mode = opt.dataset.sort;
        const current = sessionModule.getSortMode();
        // 切换：点击当前排序恢复为手动排序
        if (current === mode) {
          sessionModule.setSortMode(null);
          sortDropdown.style.display = 'none';
          uiModule.showToast(i18nModule.t('notification.manual_order'));
        } else {
          sessionModule.setSortMode(mode);
          sortDropdown.style.display = 'none';
          uiModule.showToast(i18nModule.t('notification.sorted_mode', { mode: opt.textContent.trim().toLowerCase() }));
        }
        _syncSortChecks();
      });
    });

    // 同步排序选项上的对勾标记
    function _syncSortChecks() {
      const current = sessionModule.getSortMode();
      sortDropdown.querySelectorAll('.sort-option').forEach(o => {
        const check = o.querySelector('.sort-check') || document.createElement('span');
        check.className = 'sort-check';
        check.style.cssText = 'float:right;font-size:20px;line-height:1;position:relative;top:3px;color:var(--accent, var(--red));opacity:' + (o.dataset.sort === current ? '1' : '0');
        check.textContent = '\u2022';
        if (!o.querySelector('.sort-check')) o.appendChild(check);
      });
      // 当排序活动时高亮筛选图标
      if (sortBtn) sortBtn.classList.toggle('active', !!current);
    }
    // 下拉菜单打开时同步 + 初始加载
    sortBtn.addEventListener('click', _syncSortChecks);
    _syncSortChecks();

    // AI 自动排序 — 排序按钮自身的旋转器。通过 skipLlm 标志
    // 同时供主导航的"★ 整理"按钮（AI）和子行"整理"按钮
    // （无 AI，仅第一阶段清理）使用。
    async function _runTidy(skipLlm) {
      const btnIcon = sortBtn.querySelector('.sort-icon');
      if (btnIcon) btnIcon.style.display = 'none';
      const wp = spinnerModule.create('', 'clean', 'whirlpool');
      const wpEl = wp.createElement();
      wpEl.style.cssText = 'width:13px;height:13px;display:inline-block;vertical-align:middle;margin-top:-5px;';
      sortBtn.appendChild(wpEl);
      wp.start();
      sortDropdown.style.display = 'none';
      try {
        const url = `${API_BASE}/api/sessions/auto-sort${skipLlm ? '?skip_llm=true' : ''}`;
        const res = await fetch(url, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Auto-sort failed');
        if (data.status === 'ok') {
          sessionModule.setSortMode(null); // 清除排序 — tidy 创建手动文件夹排序
          _syncSortChecks();
          if (skipLlm) {
            // 无 AI 路径：仅报告清理了什么。不提示"未分类剩余"，
            // 因为我们根本没尝试归档任何内容。
            const cleaned = (data.deleted_empty || 0) + (data.deleted_throwaway || 0);
            uiModule.showToast(cleaned ? i18nModule.t(cleaned === 1 ? 'notification.cleaned_chat' : 'notification.cleaned_chats', { count: cleaned }) : i18nModule.t('notification.already_clean'));
          } else {
            // Tidy 现在批量工作（每次点击处理 15 个最近未归档的会话），
            // 这样用户能获得快速反馈和可管理的 LLM 调用量，
            // 即使有数百个聊天也是如此。告诉用户还剩多少。
            const remaining = data.unfiled_remaining || 0;
            let msg;
            if (data.updated > 0) {
              msg = i18nModule.t(data.folders.length === 1 ? 'notification.sorted_into_folder' : 'notification.sorted_into_folders', { updated: data.updated, folders: data.folders.length });
              if (remaining > 0) msg += ' ' + i18nModule.t('notification.unfiled_left_hit_tidy', { remaining });
            } else if (remaining > 0) {
              msg = i18nModule.t('notification.unfiled_chats_hit_tidy', { remaining });
            } else {
              msg = i18nModule.t('notification.all_sorted');
            }
            uiModule.showToast(msg);
          }
          if (sessionModule) await sessionModule.loadSessions();
        } else {
          uiModule.showToast(data.reason || i18nModule.t('notification.nothing_to_sort'));
        }
      } catch (e) {
        uiModule.showError(i18nModule.t('notification.auto_sort_failed', { error: e.message }));
      } finally {
        wp.destroy();
        if (wpEl.parentNode) wpEl.parentNode.removeChild(wpEl);
        if (btnIcon) btnIcon.style.display = '';
      }
    }

    const autoSortBtn = el('auto-sort-sessions-btn');
    if (autoSortBtn) autoSortBtn.addEventListener('click', () => _runTidy(false));

    // 整理行旁边的折叠箭头切换无 AI 子项。
    const autoSortMoreBtn = el('auto-sort-sessions-more');
    const autoSortNoaiBtn = el('auto-sort-sessions-noai-btn');
    if (autoSortMoreBtn && autoSortNoaiBtn) {
      autoSortMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        autoSortNoaiBtn.style.display = autoSortNoaiBtn.style.display === 'none' ? 'block' : 'none';
      });
      autoSortNoaiBtn.addEventListener('click', () => _runTidy(true));
    }
  }

  // 模型排序下拉菜单
  const modelSortBtn = el('model-sort-btn');
  const modelSortDropdown = el('model-sort-dropdown');
  if (modelSortBtn && modelSortDropdown) {
    modelSortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      modelSortDropdown.style.display = modelSortDropdown.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', () => { modelSortDropdown.style.display = 'none'; });
    modelSortDropdown.addEventListener('click', (e) => e.stopPropagation());
    modelSortDropdown.querySelectorAll('.sort-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const mode = opt.dataset.sort;
        Storage.set('odysseus-model-sort', mode);
        if (modelsModule) modelsModule.refreshModels();
        modelSortDropdown.style.display = 'none';
        uiModule.showToast(i18nModule.t('notification.models_sorted', { mode: opt.textContent.trim().toLowerCase() }));
      });
    });
  }



  // 功能可见性 — 隐藏管理员禁用的功能
  // 如果可用，使用登录页预取的数据
  const _prefetchedFeatures = sessionStorage.getItem('ody-prefetch-features');
  sessionStorage.removeItem('ody-prefetch-features');
  window._initFeaturesReady = (_prefetchedFeatures
    ? Promise.resolve(JSON.parse(_prefetchedFeatures))
    : fetch(`${API_BASE}/api/auth/features`, { credentials: 'same-origin' }).then(r => r.json())
  ).then(features => {
      const map = {
        web_search:      ['web-toggle-btn'],
        deep_research:   ['research-toggle-btn', 'tool-research-btn', 'overflow-research-btn', 'rail-research'],
        document_editor: ['overflow-doc-btn', 'rail-documents'],
        gallery:         ['tool-gallery-btn', 'rail-gallery'],
      };
      Object.entries(map).forEach(([key, ids]) => {
        if (features[key] === false) {
          ids.forEach(id => { const e = el(id); if (e) e.style.display = 'none'; });
        }
      });
      // 在功能获取完成后重新应用用户的外观 UI 可见性偏好 —
      // 否则管理员禁用的功能会使侧边栏条目保持隐藏，即使用户的
      // "在侧边栏中显示"开关已打开。用户必须切换关闭再开启
      // 才能触发第二次 applyUIVis，这是他们反馈的
      // "深度研究只有在我切换后才显示"的问题。
      try { if (window.applyUIVis && window.loadUIVis) window.applyUIVis(window.loadUIVis()); } catch (_) {}
    })
    .catch(() => {});

  // 当设置中图片生成被禁用时隐藏图库
  const _prefetchedSettings = sessionStorage.getItem('ody-prefetch-settings');
  sessionStorage.removeItem('ody-prefetch-settings');
  window._initSettingsReady = (_prefetchedSettings
    ? Promise.resolve(JSON.parse(_prefetchedSettings))
    : fetch(`${API_BASE}/api/auth/settings`, { credentials: 'same-origin' }).then(r => r.json())
  ).then(settings => {
      // 注意：image_gen_enabled 仅管理在聊天中*生成*图片 — 该
      // 工具被服务器端（chat_routes / agent_loop）阻止。图库
      // 也包含上传和过去的图片，因此无论如何保持可见；
      // 使用 `gallery` 功能标志来完全隐藏图库。
      // 当 TTS 被禁用或未配置提供者时隐藏 TTS 溢出按钮
      const ttsOff = settings.tts_enabled === false || !settings.tts_provider || settings.tts_provider === 'disabled';
      const overflowTts = el('overflow-tts-btn');
      if (overflowTts) {
        overflowTts.style.display = ttsOff ? 'none' : '';
      }
    })
    .catch(() => {});

  // （退出登录处理已移到上方侧边栏用户栏）

  // 重命名 AI 模态框
  const renameAiOption = el('rename-ai-option');
  const renameAiModal = el('rename-ai-modal');
  const closeRenameAi = el('close-rename-ai');
  const cancelRenameAi = el('cancel-rename-ai');
  const saveAiName = el('save-ai-name');
  const aiNameInput = el('ai-name-input');
  
  if (renameAiOption) {
    renameAiOption.addEventListener('click', () => {
      const currentName = aiNameInput.value;
      renameAiModal.classList.remove('hidden');
    });
  }
  
  if (closeRenameAi) {
    closeRenameAi.addEventListener('click', () => {
      renameAiModal.classList.add('hidden');
    });
  }
  
  if (cancelRenameAi) {
    cancelRenameAi.addEventListener('click', () => {
      renameAiModal.classList.add('hidden');
    });
  }
  
  if (saveAiName) {
    saveAiName.addEventListener('click', async () => {
      const newName = aiNameInput.value.trim();
      
      if (!newName) {
        uiModule.showError(i18nModule.t('notification.ai_rename_prompt'));
        return;
      }
      
      try {
        const response = await fetch(`${API_BASE}/api/ai/name`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ name: newName })
        });
        
        const result = await response.json();
        if (result.success) {
          uiModule.showToast(i18nModule.t('notification.ai_renamed_to', { name: newName }));
          renameAiModal.classList.add('hidden');
          aiNameInput.value = '';
        }
      } catch (e) {
        uiModule.showError(i18nModule.t('notification.failed_rename_ai', { error: e.message }));
      }
    });
  }

  // 记忆管理
  const memoryModal = el('memory-modal');
  const closeMemoryBtn = el('close-memory-modal');

  // 主题弹窗关闭按钮
  const closeThemeBtn = el('close-theme-popup');
  if (closeThemeBtn && themeModule) {
    closeThemeBtn.addEventListener('click', () => {
      themeModule.closePopup();
    });
  }

  // 重命名会话模态框
  const renameSessionModal = el('rename-session-modal');
  const closeRenameSession = el('close-rename-session');
  const cancelRenameSession = el('cancel-rename-session');
  const saveSessionName = el('save-session-name');
  const sessionNameInput = el('session-name-input');
  
  // 重命名会话模态框的关闭处理
  if (closeRenameSession) {
    closeRenameSession.addEventListener('click', () => {
      renameSessionModal.classList.add('hidden');
    });
  }
  
  if (cancelRenameSession) {
    cancelRenameSession.addEventListener('click', () => {
      renameSessionModal.classList.add('hidden');
    });
  }
  
  if (saveSessionName) {
    saveSessionName.addEventListener('click', async () => {
      const newName = sessionNameInput.value.trim();
      
      if (!newName) {
        uiModule.showError(i18nModule.t('notification.session_rename_prompt'));
        return;
      }
      
      try {
        const response = await fetch(`${API_BASE}/api/session/${sessionModule.getCurrentSessionId()}`, {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ name: newName })
        });
        
        const result = await response.json();
        if (response.ok) {
          uiModule.showToast(i18nModule.t('notification.session_renamed_to', { name: newName }));
          renameSessionModal.classList.add('hidden');
          sessionNameInput.value = '';
          // 更新界面中的当前会话名称
          const meta = sessionModule.getSessions().find(s => s.id === sessionModule.getCurrentSessionId());
          if (meta) {
            meta.name = newName;
            const ver = window._appVersion ? ` v${window._appVersion}` : '';
            el('current-meta').textContent = `Session: ${meta.name}${meta.model ? ' ' + meta.model.split('/').pop() : ''}${meta.rag ? ' [RAG]' : ''}${ver}`;
          }
            // 刷新会话列表
        await sessionModule.loadSessions();
        } else {
          throw new Error(result.detail || i18nModule.t('notification.failed_rename_session'));
        }
      } catch (e) {
        uiModule.showError(i18nModule.t('notification.failed_rename_session_error', { error: e.message }));
      }
    });
  }
  
  if (closeMemoryBtn) {
    closeMemoryBtn.addEventListener('click', () => {
      dismissModal(memoryModal);
    });
  }

  // 侧边栏记忆按钮
  const toolMemoryBtn = el('tool-memory-btn');
  if (toolMemoryBtn && memoryModal) {
    toolMemoryBtn.addEventListener('click', () => {
      memoryModal.classList.remove('hidden');
      if (memoryModule && memoryModule.renderMemoryList) memoryModule.renderMemoryList();
      if (memoryModule && memoryModule.updateMemoryCount) memoryModule.updateMemoryCount();
    });
  }

  const addMemBtn = el('add-memory-btn');
  if (addMemBtn) {
    addMemBtn.addEventListener('click', memoryModule.addNewMemory);
  }
  
  const memorySearchInput = el('memory-search');
  if (memorySearchInput) {
    memorySearchInput.addEventListener('input', () => {
      memoryModule.renderMemoryList();
      memoryModule.updateMemoryCount();
    });
  }
  
  const newMemoryInput = el('new-memory-input');
  if (newMemoryInput) {
    newMemoryInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        memoryModule.addNewMemory();
      }
    });
  }

// 语音录制由双重用途的发送/麦克风按钮处理（见下文）

  // ── 切换状态持久化 — 委托给 Storage 模块 ──
  function loadToggleState() {
    return Storage.loadToggleState();
  }
  function saveToggleState(state) {
    Storage.saveToggleState(state);
  }

  // 模式影响工具：Agent 模式默认开启，Chat 模式默认关闭，
  // 但用户显式的每模式覆盖会被持久化并遵守。
  const MODE_TOOLS = [
    { btnId: 'web-toggle-btn',  checkboxId: 'web-toggle',  stateKey: 'web' },
    { btnId: 'bash-toggle-btn', checkboxId: 'bash-toggle', stateKey: 'bash' },
  ];

  function _modeKey(stateKey, mode) { return `${stateKey}_${mode}`; }

  function loadToolPref(stateKey, mode) {
    const state = loadToggleState();
    const key = _modeKey(stateKey, mode);
    if (Object.prototype.hasOwnProperty.call(state, key)) return !!state[key];
    return mode === 'agent'; // 默认：Agent 模式开启，Chat 模式关闭
  }

  function saveToolPref(stateKey, mode, value) {
    const state = loadToggleState();
    state[_modeKey(stateKey, mode)] = value;
    saveToggleState(state);
  }

  const TOOL_TOGGLE_TOAST_LABELS = {
    web: 'tools.web_search_toggle',
    bash: 'tools.shell_toggle',
  };

  function showToolToggleToast(stateKey, active) {
    const labelKey = TOOL_TOGGLE_TOAST_LABELS[stateKey];
    if (!labelKey || !uiModule?.showToast) return;
    const label = i18nModule.t(labelKey);
    uiModule.showToast(i18nModule.t(active ? 'notification.tool_toggle_on' : 'notification.tool_toggle_off', { tool: label }), 1800);
  }

  function applyModeToToggles(mode) {
    MODE_TOOLS.forEach(({ btnId, checkboxId, stateKey }) => {
      const btn = el(btnId);
      if (!btn) return;
      // Chat 模式下隐藏 Bash 按钮
      if (mode === 'chat' && stateKey === 'bash') {
        btn.style.display = 'none';
        return;
      }
      // Agent 模式或任何模式下显示 Web 切换按钮
      btn.style.display = '';
      if (btn.style.display === 'none') return;
      const on = loadToolPref(stateKey, mode);
      btn.classList.toggle('active', on);
      if (checkboxId) { const chk = el(checkboxId); if (chk) chk.checked = on; }
    });
  }

  // ── Agent / Chat 模式切换 ──
  (function initModeToggle() {
    const agentBtn = el('mode-agent-btn');
    const chatBtn = el('mode-chat-btn');
    if (!agentBtn || !chatBtn) return;
    const state = loadToggleState();
    let currentMode = state.mode || 'chat';

    // 页面加载时 Chat 模式下立即隐藏 Bash 按钮
    if (currentMode === 'chat') {
      const bashBtn = el('bash-toggle-btn');
      if (bashBtn) bashBtn.style.display = 'none';
    }

    function setMode(mode) {
      currentMode = mode;
      const st = loadToggleState();
      st.mode = mode;
      saveToggleState(st);
      agentBtn.classList.toggle('active', mode === 'agent');
      chatBtn.classList.toggle('active', mode === 'chat');
      agentBtn.setAttribute('aria-pressed', String(mode === 'agent'));
      chatBtn.setAttribute('aria-pressed', String(mode === 'chat'));
      // 将滑块滑动到激活按钮
      const toggle = agentBtn.closest('.mode-toggle');
      if (toggle) toggle.classList.toggle('mode-chat', mode === 'chat');
      // 延迟工具发光效果以实现交错动画
      setTimeout(() => applyModeToToggles(mode), 500);
    }
    agentBtn.addEventListener('click', () => {
      // Agent 模式会关闭研究（如果激活）
      const resChk = el('research-toggle');
      if (resChk && resChk.checked) _syncResearchIndicator(false);
      setMode('agent');
    });
    chatBtn.addEventListener('click', () => setMode('chat'));
    setMode(currentMode);
  })();

  // ── 工具提示说明消息（每个工具首次使用的前2次显示）──
  const SPLASH_COUNT_KEY = 'odysseus-tool-splash-counts';
  const SPLASH_MAX = 2;
  const _toolSplashes = {
    web: { roleKey: 'tool_splashes.web.role', textKey: 'tool_splashes.web.desc' },
    bash: { roleKey: 'tool_splashes.bash.role', textKey: 'tool_splashes.bash.desc' },
    builder: { roleKey: 'tool_splashes.builder.role', textKey: 'tool_splashes.builder.desc' },
    research: { roleKey: 'tool_splashes.research.role', textKey: 'tool_splashes.research.desc' },
  };
  function _showToolSplash(key) {
    const splash = _toolSplashes[key];
    if (!splash) return;
    // 每个工具仅显示前 SPLASH_MAX 次
    const counts = Storage.getJSON(SPLASH_COUNT_KEY, {});
    const seen = counts[key] || 0;
    if (seen >= SPLASH_MAX) return;
    counts[key] = seen + 1;
    Storage.setJSON(SPLASH_COUNT_KEY, counts);
    // 隐藏欢迎屏幕使提示可见
    if (chatModule && chatModule.hideWelcomeScreen) {
      chatModule.hideWelcomeScreen();
    }
    const chatBox = document.getElementById('chat-history');
    if (!chatBox) return;
    const div = document.createElement('div');
    div.className = 'msg msg-ai tool-splash';
    div.innerHTML = '<div class="role">' + i18nModule.t(splash.roleKey) + '</div><div class="body" style="opacity:0.7;font-size:0.92em">' + i18nModule.t(splash.textKey) + '</div>';
    chatBox.appendChild(div);
    if (uiModule) uiModule.scrollHistory();
  }

  // ── 基于复选框的切换按钮（带按模式持久化）──
  function setupToggle(btnId, checkboxId, stateKey) {
    const btn = el(btnId);
    if (!btn) return;
    // 还原 Agent 和 Chat 模式的每模式保存状态。
    const mode = (loadToggleState().mode) || 'chat';
    const saved = loadToolPref(stateKey, mode);
    const chk = el(checkboxId);
    if (chk) chk.checked = saved;
    btn.classList.toggle('active', saved);
    btn.setAttribute('aria-pressed', String(saved));
    btn.addEventListener('click', () => {
      const curMode = (loadToggleState().mode) || 'chat';
      const chk = el(checkboxId);
      chk.checked = !chk.checked;
      btn.classList.toggle('active', chk.checked);
      btn.setAttribute('aria-pressed', String(chk.checked));
      saveToolPref(stateKey, curMode, chk.checked);
      showToolToggleToast(stateKey, chk.checked);
      if (chk.checked) _showToolSplash(stateKey);
      // Web 搜索和研究互斥 — 研究优先
      if (stateKey === 'web' && chk.checked) {
        const resChk = el('research-toggle');
        if (resChk && resChk.checked) {
          _syncResearchIndicator(false);
        }
      }
    });
  }
  setupToggle('web-toggle-btn', 'web-toggle', 'web');
  setupToggle('bash-toggle-btn', 'bash-toggle', 'bash');

  // 文档编辑器切换（特殊：使用模块面板，而不是复选框）
  const overflowDocBtn = el('overflow-doc-btn');
  if (overflowDocBtn) {
    overflowDocBtn.addEventListener('click', async () => {
      if (!documentModule) return;
      if (documentModule.isPanelOpen()) {
        documentModule.closePanel();
        overflowDocBtn.classList.remove('active');
        const st = loadToggleState(); st.doc = false; saveToggleState(st);
      } else {
        let sessionId = sessionModule.getCurrentSessionId();
        // 如果有待提交的"新建聊天"，先实体化它
        if (!sessionId && sessionModule.hasPendingChat && sessionModule.hasPendingChat()) {
          await sessionModule.materializePendingSession();
          sessionId = sessionModule.getCurrentSessionId();
        }
        if (sessionId) {
          documentModule.loadSessionDocs(sessionId, { forceOpen: true });
        } else {
          documentModule.ensureDocPanel();
        }
        overflowDocBtn.classList.add('active');
        const st = loadToggleState(); st.doc = true; saveToggleState(st);
      }
    });
  }

  // 文档指示器按钮（文档存在时显示在溢出菜单外）
  const docIndicatorBtn = el('doc-indicator-btn');
  if (docIndicatorBtn) {
    docIndicatorBtn.addEventListener('click', () => {
      const ob = el('overflow-doc-btn');
      if (ob) ob.click();
    });
  }

  // ── RAG 切换（溢出 + 指示器）──
  function _syncRagIndicator(active) {
    const indicator = el('rag-indicator-btn');
    const overflow = el('overflow-rag-btn');
    const chk = el('rag-toggle');
    if (chk) chk.checked = active;
    if (indicator) {
      indicator.style.display = active ? '' : 'none';
      indicator.classList.toggle('active', active);
    }
    if (overflow) overflow.classList.toggle('active', active);
    const s = loadToggleState(); s.rag = active; saveToggleState(s);
    updatePlusDot();
  }
  window._syncRagIndicator = _syncRagIndicator;
  window._syncResearchIndicator = _syncResearchIndicator;
  // 必须在模块级别赋值（而非函数体内部），这样第一个外部调用者 —
  // group.js / sessions.js 在本地运行之前触发它 — 能找到它，而不是
  // 静默地什么都不做（"群组指示器有时不出现"的 bug）。
  window._syncGroupIndicator = _syncGroupIndicator;
  // 初始化 RAG 状态
  {
    const st = loadToggleState();
    const ragState = st.rag || false;
    _syncRagIndicator(ragState);
  }

  // ── 溢出"..."菜单（研究）──
  function updatePlusDot() {
    const plusBtn = el('overflow-plus-btn');
    if (!plusBtn) return;
    const menu = el('overflow-menu');
    const anyActive = menu ? Array.from(menu.querySelectorAll('.overflow-menu-item.active')).some(item => item.style.display !== 'none') : false;
    plusBtn.classList.toggle('has-active', anyActive);
  }
  // 外部模块（compare）在其溢出状态变化时分发此事件
  document.addEventListener('overflow-state-change', () => updatePlusDot());

  // ── 防止工具栏按钮抢夺焦点（避免移动端键盘弹出）──
  const chatInputBar = document.querySelector('.chat-input-bar');
  // ── 与聊天栏控件交互时保持文本区域聚焦（移动端键盘修复）──
  const _msgTextarea = el('message');
  if (chatInputBar && _msgTextarea) {
    let _refocusOnBlur = false;
    function _flagRefocus(e) {
      if (e.target.closest('textarea, input')) return;
      // 不要为附件重新聚焦 — 文件选择器需要完整的焦点控制
      if (e.target.closest('#overflow-attach-btn')) return;
      // 不要为模型选择器按钮重新聚焦 — 焦点应转到选择器搜索输入
      if (e.target.closest('.model-picker-btn')) return;
      // 点击 +/折叠工具按钮时不重新聚焦 — 用户明确想要
      // 收起键盘并打开工具菜单。不加此判断，文本区域失焦
      // （键盘收起），然后此处理程序重新聚焦（键盘弹回）。
      if (e.target.closest('#overflow-plus-btn')) return;
      if (document.activeElement === _msgTextarea) _refocusOnBlur = true;
    }
    chatInputBar.addEventListener('touchstart', _flagRefocus, { passive: true });
    // 溢出菜单是 position:fixed — 在移动端可能不会通过 chatInputBar 冒泡
    const _overflowMenu = el('overflow-menu');
    if (_overflowMenu) _overflowMenu.addEventListener('touchstart', _flagRefocus, { passive: true });
    // 模型选择器菜单也是
    const _pickerMenu = document.getElementById('model-picker-menu');
    if (_pickerMenu) _pickerMenu.addEventListener('touchstart', _flagRefocus, { passive: true });
    // 附件条（在 chat-input-bar 外）
    const _attachStrip = el('attach-strip');
    if (_attachStrip) _attachStrip.addEventListener('touchstart', _flagRefocus, { passive: true });
    _msgTextarea.addEventListener('blur', () => {
      if (_refocusOnBlur) {
        _refocusOnBlur = false;
        setTimeout(() => _msgTextarea.focus(), 0);
      }
    });
    // 如果触摸结束但未导致失焦则清除标志
    document.addEventListener('touchend', () => { setTimeout(() => { _refocusOnBlur = false; }, 50); }, { passive: true });
  }

  (function initOverflowMenu() {
    const plusBtn = el('overflow-plus-btn');
    const menu = el('overflow-menu');
    if (!plusBtn || !menu) return;

    // `.chat-input-bar` 有 `container-type: inline-size`，这使它成为
    // `position: fixed` 后代元素的包含块 — 因此此菜单被困在编辑器的
    // 堆叠上下文中，渲染在附件的后面（文件越多越糟糕）。
    // 在打开时将它传送到 <body>，使其 fixed 位置 + z-index 相对于视口生效，
    // 然后在关闭时恢复回其包装元素中。
    const ownerWrap = menu.parentElement;
    const pickerWrap = el('model-picker-wrap');
    let _vvReposition = null;
    // 将菜单底部固定到折叠箭头以上 8px 处（视口相对，因为它已传送到 <body>）。
    // 仅当列表真实高度大于按钮上方的可用空间时才限制高度并显示滚动条。
    function positionMenu() {
      const r = plusBtn.getBoundingClientRect();
      menu.style.left = r.left + 'px';
      menu.style.right = 'auto';
      menu.style.bottom = 'auto';
      menu.style.maxHeight = '';      // 重置以便测量自然高度
      menu.style.overflowY = '';
      const avail = r.top - 16;        // 折叠箭头上方的空间
      const natural = menu.scrollHeight;
      const h = Math.min(natural, avail);
      if (natural > avail) {           // 仅在放不下时才限制高度并滚动
        menu.style.maxHeight = avail + 'px';
        menu.style.overflowY = 'auto';
      }
      menu.style.top = (r.top - 8 - h) + 'px';
    }
    // 点击折叠箭头绝对不能从消息框抢夺焦点，否则移动端键盘会收起。
    // pointerdown 上的 preventDefault 保持文本区域聚焦（键盘保持打开），
    // 同时 click 仍然可以打开菜单。
    plusBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); });
    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 关闭路径需要播放折叠动画，而不是简单地翻转 .hidden —
      // 通过 closeOverflowMenu 路由，使第二次点击关闭的效果与
      // 点击外部 / Escape / 选择项目一致。
      const isOpen = !menu.classList.contains('hidden') && !menu.classList.contains('closing');
      if (isOpen) {
        closeOverflowMenu();
        return;
      }
      // 在折叠动画进行中重新打开：干净地取消动画。
      menu.classList.remove('closing');
      menu.classList.remove('hidden');
      plusBtn.classList.add('expanded');
      document.body.appendChild(menu);  // 摆脱编辑器的 container-type 陷阱
      // 隐藏药丸栏标签，避免透过菜单显示
      if (pickerWrap) pickerWrap.style.visibility = 'hidden';
      // 保持文本区域聚焦，避免键盘收起（如果之前是打开的），
      // 上面的 pointerdown 处理程序阻止了焦点抢夺。同时监听
      // visualViewport，使菜单在视口移动时跟随折叠箭头。
      positionMenu();
      if (window.visualViewport && !_vvReposition) {
        _vvReposition = () => positionMenu();
        window.visualViewport.addEventListener('resize', _vvReposition);
        window.visualViewport.addEventListener('scroll', _vvReposition);
      }
    });
    function closeOverflowMenu() {
      if (menu.classList.contains('hidden')) return;
      if (menu.classList.contains('closing')) return;
      if (_vvReposition && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', _vvReposition);
        window.visualViewport.removeEventListener('scroll', _vvReposition);
        _vvReposition = null;
      }
      // 播放折叠动画（项目自上而下剥离，然后容器缩放回折叠箭头）
      // 然后再翻转为 display:none。
      menu.classList.add('closing');
      plusBtn.classList.remove('expanded');
      if (pickerWrap) pickerWrap.style.visibility = '';
      // 项目延迟最大 0.18s + 0.20s 动画 = 项目 0.38s，容器
      // 延迟 0.16s + 0.22s = 0.38s。400ms 覆盖两者并有余量。
      setTimeout(() => {
        menu.classList.add('hidden');
        menu.classList.remove('closing');
        if (ownerWrap) ownerWrap.appendChild(menu);  // 从 <body> 传送还原
      }, 400);
    }
    // 点击菜单内任意项目时关闭。pointerdown 上的 preventDefault
    // 使得点击项目（例如附件文件）不会从消息框抢夺焦点 —
    // 保持移动端键盘打开。
    menu.querySelectorAll('.overflow-menu-item').forEach(item => {
      item.addEventListener('pointerdown', (e) => { e.preventDefault(); });
      item.addEventListener('click', () => closeOverflowMenu());
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && e.target !== plusBtn) closeOverflowMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.classList.contains('hidden')) closeOverflowMenu();
    });

    // 研究切换
    const researchBtn = el('research-toggle-btn');
    if (researchBtn) {
      const st = loadToggleState();
      const resState = st.research || false;
      el('research-toggle').checked = resState;
      researchBtn.classList.toggle('active', resState);
      researchBtn.style.display = resState ? '' : 'none';
      // 页面加载时同步溢出 + 工具侧边栏
      const overflowRes = el('overflow-research-btn');
      if (overflowRes) overflowRes.classList.toggle('active', resState);
      const toolRes = el('tool-research-btn');
      if (toolRes) toolRes.classList.toggle('active', resState);
      // 页面加载时：如果研究和网页搜索都已开启，研究优先
      if (resState) {
        const webChk = el('web-toggle');
        const webBtn = el('web-toggle-btn');
        if (webChk && webChk.checked) {
          webChk.checked = false;
          if (webBtn) webBtn.classList.remove('active');
          saveToolPref('web', (st.mode || 'chat'), false);
        }
      }

      researchBtn.addEventListener('click', () => {
        const chk = el('research-toggle');
        const turningOn = chk ? !chk.checked : false;
        _syncResearchIndicator(turningOn);
        if (turningOn) {
          _showToolSplash('research');
          // 清除角色 — 与研究互斥
          if (presetsModule && presetsModule.deactivateCharacter) presetsModule.deactivateCharacter();
          // 研究和 Web 搜索是互斥的
          const webChk = el('web-toggle');
          const webBtn = el('web-toggle-btn');
          if (webChk && webChk.checked) {
            webChk.checked = false;
            if (webBtn) webBtn.classList.remove('active');
            saveToolPref('web', (loadToggleState().mode || 'chat'), false);
          }
          // 研究需要 Chat 模式 — 强制从 Agent 切换
          const rs = loadToggleState();
          if (rs.mode === 'agent') {
            rs.mode = 'chat';
            saveToggleState(rs);
            const ab = el('mode-agent-btn'), cb = el('mode-chat-btn');
            if (ab) ab.classList.remove('active');
            if (cb) cb.classList.add('active');
            applyModeToToggles('chat');
          }
        }
      });
    }

    updatePlusDot();
  })();

  // ── 空间紧张时自动将工具栏按钮折叠到溢出菜单中 ──
  (function initToolbarOverflow() {
    const inputLeft = document.querySelector('.chat-input-left');
    const overflowMenu = el('overflow-menu');
    const overflowWrapper = document.querySelector('.overflow-wrapper');
    if (!inputLeft || !overflowMenu || !overflowWrapper) return;

    // 可折叠的按钮（按反向优先级 — 最后折叠的最先被折叠）
    const collapsibleIds = ['bash-toggle-btn', 'web-toggle-btn'];
    const collapsibleBtns = collapsibleIds.map(id => el(id)).filter(Boolean);
    // 工具栏 btn id → 溢出镜像元素的映射（动态创建）
    const overflowMirrors = new Map();

    // 为每个可折叠按钮创建溢出镜像项
    collapsibleBtns.forEach(btn => {
      const mirror = document.createElement('button');
      mirror.type = 'button';
      mirror.className = 'overflow-menu-item toolbar-overflow-mirror';
      mirror.dataset.mirrorOf = btn.id;
      const title = btn.title || btn.id.replace(/-/g, ' ');
      mirror.innerHTML = btn.querySelector('svg').outerHTML + '<span>' + title + '</span>' +
        '<span class="overflow-active-dot"></span>';
      mirror.style.display = 'none';
      mirror.addEventListener('click', () => btn.click());
      // 插入到溢出菜单顶部（在现有项之前）
      overflowMenu.insertBefore(mirror, overflowMenu.firstChild);
      overflowMirrors.set(btn.id, mirror);
    });

    function syncMirrorStates() {
      overflowMirrors.forEach((mirror, btnId) => {
        const btn = el(btnId);
        if (btn) mirror.classList.toggle('active', btn.classList.contains('active'));
      });
      updatePlusDot();
    }

    function checkToolbarOverflow() {
      const inputBottom = inputLeft.parentElement;
      if (!inputBottom) return;
      const rightEl = document.querySelector('.chat-input-right');
      const available = inputBottom.clientWidth -
        (rightEl ? rightEl.offsetWidth : 0) - 16;

      // 取消所有折叠以测量自然宽度
      collapsibleBtns.forEach(btn => btn.classList.remove('toolbar-collapsed'));
      overflowMirrors.forEach(m => m.style.display = 'none');

      // 临时允许溢出以进行准确测量
      const prevOverflow = inputLeft.style.overflow;
      inputLeft.style.overflow = 'visible';
      inputLeft.style.flexWrap = 'nowrap';

      // 强制重排然后测量每个子元素
      void inputLeft.offsetWidth;

      // 测量溢出包装器（始终可见）
      const wrapperWidth = overflowWrapper.offsetWidth + 4;

      // 测量每个可折叠按钮的自然宽度
      const btnWidths = collapsibleBtns.map(btn => btn.offsetWidth + 4);

      // 测量不可折叠、非包装器的子元素（工具指示器等）
      let otherWidth = 0;
      Array.from(inputLeft.children).forEach(c => {
        if (c === overflowWrapper) return;
        if (collapsibleBtns.includes(c)) return;
        if (c.offsetWidth) otherWidth += c.offsetWidth + 4;
      });

      let totalWidth = wrapperWidth + otherWidth + btnWidths.reduce((a, b) => a + b, 0);

      // 研究模式 + 文档面板同时激活时强制折叠 Shell 和搜索
      const _resChk = el('research-toggle');
      const _researchOn = _resChk && _resChk.checked;
      const _docViewOn = document.body.classList.contains('doc-view');
      if (_researchOn && _docViewOn) {
        collapsibleBtns.forEach(btn => {
          btn.classList.add('toolbar-collapsed');
          const mirror = overflowMirrors.get(btn.id);
          if (mirror) mirror.style.display = '';
        });
        inputLeft.style.overflow = prevOverflow;
        inputLeft.style.flexWrap = '';
        syncMirrorStates();
        return;
      }

      // 从最低优先级开始折叠，直到放得下
      if (totalWidth > available) {
        for (let i = 0; i < collapsibleBtns.length; i++) {
          collapsibleBtns[i].classList.add('toolbar-collapsed');
          const mirror = overflowMirrors.get(collapsibleBtns[i].id);
          if (mirror) mirror.style.display = '';
          totalWidth -= btnWidths[i];
          if (totalWidth <= available) break;
        }
      }

      // 恢复
      inputLeft.style.overflow = prevOverflow;
      inputLeft.style.flexWrap = '';
      syncMirrorStates();
    }

    // 监听 active 类变化以同步镜像状态
    const observer = new MutationObserver(() => syncMirrorStates());
    collapsibleBtns.forEach(btn => {
      observer.observe(btn, { attributes: true, attributeFilter: ['class'] });
    });

    // 窗口大小调整时运行和加载时运行
    window.addEventListener('resize', () => requestAnimationFrame(checkToolbarOverflow));
    // 立即运行（此时状态已恢复）
    checkToolbarOverflow();
    // 侧边栏切换时重新检查（改变可用宽度）
    document.addEventListener('overflow-state-change', () =>
      requestAnimationFrame(checkToolbarOverflow));
    // 侧边栏可见性变化时也重新检查
    const sidebarEl = el('sidebar');
    if (sidebarEl) {
      new MutationObserver(() => requestAnimationFrame(checkToolbarOverflow))
        .observe(sidebarEl, { attributes: true, attributeFilter: ['class'] });
    }
    // 文档面板打开/关闭时重新检查（body.doc-view切换）
    new MutationObserver(() => requestAnimationFrame(checkToolbarOverflow))
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // 输入栏自身调整大小时重新检查（例如文档面板拖拽）
    const inputBottom = inputLeft.parentElement;
    if (inputBottom) {
      new ResizeObserver(() => requestAnimationFrame(checkToolbarOverflow)).observe(inputBottom);
    }
  })();

  // ── 文本区域过窄时自动隐藏模型选择器 ──
  (function initModelPickerResponsive() {
    const inputTop = document.querySelector('.chat-input-top');
    const pickerWrap = el('model-picker-wrap');
    if (!inputTop || !pickerWrap) return;

    const PLACEHOLDER_HIDE_WIDTH = 400;
    const PICKER_HIDE_WIDTH = 220;
    const TOOLBAR_HIDE_WIDTH = 160;
    const textarea = el('message');
    const inputBottom = document.querySelector('.chat-input-bottom');
    const _isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    function checkPickerOverflow() {
      // 移动端跳过响应式折叠 — 键盘开合会导致闪烁
      if (_isMobile) return;
      const w = inputTop.clientWidth;
      // 隐藏模型选择器
      pickerWrap.classList.toggle('picker-auto-hidden', w < PICKER_HIDE_WIDTH);
      // 隐藏占位文本
      if (textarea) {
        textarea.setAttribute('placeholder', w < PLACEHOLDER_HIDE_WIDTH ? '' : i18nModule.t('chat.placeholder'));
      }
      // 隐藏整个底部工具栏（工具、模式切换）— 仅保留发送按钮
      if (inputBottom) {
        inputBottom.classList.toggle('toolbar-auto-hidden', w < TOOLBAR_HIDE_WIDTH);
      }
    }

    const ro = new ResizeObserver(() => requestAnimationFrame(checkPickerOverflow));
    ro.observe(inputTop);
    checkPickerOverflow();
  })();

  // TTS模式切换（为安全起见独立于溢出菜单IIFE）
  (function initTTSToggle() {
    const ttsBtn = document.getElementById('overflow-tts-btn');
    if (!ttsBtn) return;
    try {
      const st = loadToggleState();
      if (st.ttsMode) {
        ttsBtn.classList.add('active');
        if (window.aiTTSManager) window.aiTTSManager.autoPlay = true;
      }
    } catch(e) {}

    ttsBtn.addEventListener('click', () => {
      const isActive = !ttsBtn.classList.contains('active');
      ttsBtn.classList.toggle('active', isActive);
      if (window.aiTTSManager) window.aiTTSManager.autoPlay = isActive;
      const s = loadToggleState(); s.ttsMode = isActive; saveToggleState(s);
      updatePlusDot();
    });
  })();


  // ── 模型对比指示器（仅侧边栏，无溢出菜单）──
  const compareIndicatorBtn = el('compare-indicator-btn');
  if (compareIndicatorBtn) {
    compareIndicatorBtn.addEventListener('click', () => {
      if (compareModule && compareModule.isActive()) {
        compareModule.closeCompare();
      }
    });
  }

  // ── 溢出菜单 RAG 切换 ──
  const overflowRagBtn = el('overflow-rag-btn');
  const ragIndicatorBtn = el('rag-indicator-btn');
  if (overflowRagBtn) {
    overflowRagBtn.addEventListener('click', () => {
      const chk = el('rag-toggle');
      const isActive = chk ? !chk.checked : true;
      _syncRagIndicator(isActive);
    });
  }
  if (ragIndicatorBtn) {
    ragIndicatorBtn.addEventListener('click', () => {
      _syncRagIndicator(false);
    });
  }

  // ── 溢出菜单研究切换 ──
  const overflowResearchBtn = el('overflow-research-btn');
  if (overflowResearchBtn) {
    overflowResearchBtn.addEventListener('click', () => {
      const chk = el('research-toggle');
      const turningOn = chk ? !chk.checked : false;
      _syncResearchIndicator(turningOn);
      if (turningOn) {
        _showToolSplash('research');
        // 清除角色 — 与研究互斥
        if (presetsModule && presetsModule.deactivateCharacter) presetsModule.deactivateCharacter();
        // 与网页搜索互斥
        const webChk = el('web-toggle');
        const webBtn = el('web-toggle-btn');
        if (webChk && webChk.checked) {
          webChk.checked = false;
          if (webBtn) webBtn.classList.remove('active');
          saveToolPref('web', (loadToggleState().mode || 'chat'), false);
        }
        // 研究需要聊天模式
        const rs2 = loadToggleState();
        if (rs2.mode === 'agent') {
          rs2.mode = 'chat';
          saveToggleState(rs2);
          const ab2 = el('mode-agent-btn'), cb2 = el('mode-chat-btn');
          if (ab2) ab2.classList.remove('active');
          if (cb2) cb2.classList.add('active');
          applyModeToToggles('chat');
        }
      }
    });
  }

  // ── 溢出菜单群聊切换 ──
  const overflowGroupBtn = el('overflow-group-btn');
  if (overflowGroupBtn) {
    overflowGroupBtn.addEventListener('click', async () => {
      const chk = el('group-toggle');
      const turningOn = chk ? !chk.checked : false;
      if (turningOn) {
        const picked = await groupModule.showModelPicker();
        if (!picked || picked.length < 2) return;
        groupModule.setActive(true);  // 提前设置以便 updateModelPicker 能看到
        _syncGroupIndicator(true);
        _startFreshChat();
        // 清除残留的启动画面
        const _chatBox = document.getElementById('chat-history');
        if (_chatBox) {
          _chatBox.querySelectorAll('.tool-splash').forEach(s => s.remove());
          // 同时隐藏欢迎屏幕
          if (chatModule && chatModule.hideWelcomeScreen) chatModule.hideWelcomeScreen();
        }
        // 启动群组 — 立即创建参与者会话
        const sid = sessionModule.getCurrentSessionId() || 'group-' + Date.now();
        await groupModule.startGroup(picked, sid);
        // 所有操作完成后重新隐藏选择器
        const _mpw = el('model-picker-wrap');
        if (_mpw) _mpw.style.display = 'none';
        uiModule.showToast(i18nModule.t('notification.group_chat_ready', { count: picked.length }));
      } else {
        _syncGroupIndicator(false);
        groupModule.stopGroup();
        // 恢复 model picker
        const _mpWrap2 = el('model-picker-wrap');
        if (_mpWrap2) _mpWrap2.style.display = '';
      }
    });
  }

  // ── 群聊切换按钮（聊天框指示器）— 点击停用 ──
  const groupToggleBtn = el('group-toggle-btn');
  if (groupToggleBtn) {
    groupToggleBtn.addEventListener('click', () => {
      _syncGroupIndicator(false);
      groupModule.stopGroup();
    });
  }

  // ── 无痕模式切换（在欢迎屏幕上）──
  const incognitoBtn = el('incognito-btn');
  const INCOGNITO_EYE_OPEN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const INCOGNITO_EYE_CLOSED = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/></svg>';
  const SESSION_ICON_CHAT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  const SESSION_ICON_INCOGNITO = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function _syncSessionIncognitoIcon(active) {
    const activeSession = document.querySelector('.list-item.active-session .session-icon');
    if (activeSession) {
      activeSession.innerHTML = active ? SESSION_ICON_INCOGNITO : SESSION_ICON_CHAT;
      activeSession.style.color = active ? 'var(--accent)' : '';
    }
  }

  if (incognitoBtn) {
    incognitoBtn.addEventListener('mousedown', (e) => e.preventDefault());
    incognitoBtn.addEventListener('click', () => {
      // 对话中途不允许切换 — 无痕模式只能从欢迎屏幕更改
      const ws = el('welcome-screen');
      if (ws && ws.classList.contains('hidden')) return;
      const chk = el('incognito-toggle');
      chk.checked = !chk.checked;
      incognitoBtn.classList.toggle('active', chk.checked);
      const tipEl = el('welcome-tip');
      incognitoBtn.title = chk.checked ? i18nModule.t('incognito.disable') : i18nModule.t('incognito.enable');
      const welcomeName = document.querySelector('.welcome-name');
      if (chk.checked) {
        incognitoBtn.innerHTML = INCOGNITO_EYE_CLOSED + '<span class="incognito-label">' + i18nModule.t('incognito.label') + '</span>';
        if (welcomeName) {
          welcomeName.dataset.originalHtml = welcomeName.innerHTML;
          welcomeName.innerHTML = '<svg class="welcome-boat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/></svg>' + i18nModule.t('incognito.label');
          // 在新标签上重新启动从左到右的裁剪擦除动画
          welcomeName.style.animation = 'none';
          welcomeName.offsetHeight;
          welcomeName.style.animation = '';
        }
        if (ws) { ws.style.animation = 'none'; ws.offsetHeight; ws.style.animation = 'welcome-enter 0.3s ease-out both'; }
        const welcomeSub = el('welcome-sub');
        if (welcomeSub) {
          if (!welcomeSub.dataset.originalText) welcomeSub.dataset.originalText = welcomeSub.textContent;
          welcomeSub.textContent = i18nModule.t('incognito.welcome_subtitle');
          welcomeSub.style.display = '';
        }
        if (tipEl) { tipEl.dataset.originalTip = tipEl.textContent; tipEl.textContent = i18nModule.t('incognito.welcome_tip'); tipEl.style.opacity = '0.5'; tipEl.style.marginTop = '8px'; }
        // 默认切换到纯聊天模式：视觉上禁用工具，切换到聊天模式。
        // 重要：不要覆盖用户持久化的各模式工具偏好
        // （`web_agent`、`bash_agent`、`web_chat`、`bash_chat`）。无痕模式是
        // 临时的 — 关闭后必须恢复用户的Agent模式默认值。
        const _offIds = ['web-toggle', 'bash-toggle', 'research-toggle'];
        _offIds.forEach(id => { const c = el(id); if (c) c.checked = false; });
        ['web-toggle-btn', 'bash-toggle-btn'].forEach(id => { const b = el(id); if (b) b.classList.remove('active'); });
        const _ab = el('mode-agent-btn'), _cb = el('mode-chat-btn');
        if (_ab) _ab.classList.remove('active');
        if (_cb) _cb.classList.add('active');
        const ts = Storage.getJSON(Storage.KEYS.TOGGLES, {});
        ts.research = false; ts.mode = 'chat';
        Storage.setJSON(Storage.KEYS.TOGGLES, ts);
      } else {
        incognitoBtn.innerHTML = INCOGNITO_EYE_OPEN + '<span class="incognito-label">' + i18nModule.t('incognito.label') + '</span>';
        if (welcomeName && welcomeName.dataset.originalHtml) {
          welcomeName.innerHTML = welcomeName.dataset.originalHtml;
          // 在恢复的标签上重新启动从左到右的裁剪擦除动画
          welcomeName.style.animation = 'none';
          welcomeName.offsetHeight;
          welcomeName.style.animation = '';
        }
        if (ws) { ws.style.animation = 'none'; ws.offsetHeight; ws.style.animation = 'welcome-enter 0.3s ease-out both'; }
        const welcomeSub2 = el('welcome-sub');
        if (welcomeSub2) {
          if (welcomeSub2.dataset.originalText) {
            welcomeSub2.textContent = welcomeSub2.dataset.originalText;
            delete welcomeSub2.dataset.originalText;
          }
          welcomeSub2.style.display = '';
        }
        if (tipEl && tipEl.dataset.originalTip) { tipEl.textContent = tipEl.dataset.originalTip; tipEl.style.opacity = ''; tipEl.style.marginTop = ''; }
        // 修复以前无痕模式bug导致持久化的 false 值
        // 使Agent模式默认值（web/bash开启）能恢复。
        const _ts = Storage.getJSON(Storage.KEYS.TOGGLES, {});
        let _dirty = false;
        ['web_agent', 'bash_agent', 'web_chat', 'bash_chat'].forEach(k => {
          if (_ts[k] === false) { delete _ts[k]; _dirty = true; }
        });
        if (_dirty) Storage.setJSON(Storage.KEYS.TOGGLES, _ts);
        // 将当前模式的真实默认值重新应用到可见开关
        const _curMode = (Storage.getJSON(Storage.KEYS.TOGGLES, {}) || {}).mode || 'chat';
        try { applyModeToToggles(_curMode); } catch (_) {}
      }
      // 如果在对话中关闭（欢迎屏幕隐藏），隐藏按钮
      if (!chk.checked && ws && ws.classList.contains('hidden')) {
        incognitoBtn.style.display = 'none';
      }
      // 显示/隐藏顶部栏的持久无痕指示器
      const _incInd = el('incognito-indicator');
      if (_incInd) _incInd.style.display = chk.checked ? '' : 'none';
      // 更新侧边栏中的活动会话图标
      _syncSessionIncognitoIcon(chk.checked);
    });
  }

  // 无痕指示器点击 — 停用无痕模式
  const incognitoIndicator = el('incognito-indicator');
  if (incognitoIndicator) {
    incognitoIndicator.addEventListener('click', () => {
      if (incognitoBtn) incognitoBtn.click();
      else {
        const chk = el('incognito-toggle');
        if (chk) { chk.checked = false; }
        incognitoIndicator.style.display = 'none';
      }
    });
  }

  // ── 停用无痕模式（新建会话时调用）──
  function _deactivateIncognito() {
    const chk = el('incognito-toggle');
    if (!chk || !chk.checked) return;
    if (incognitoBtn) incognitoBtn.click();
  }

  // ── UI 可见性（自定义UI模态框）──
  const UI_VIS_KEY = 'odysseus-ui-visibility';

  // 选择器映射：键 → 目标元素的 CSS 选择器
  const UI_VIS_MAP = {
    'sidebar-brand':       '.sidebar-brand-title',
    'sidebar-new-chat':    '#sidebar-new-chat-btn',
    'sidebar-search':      '#sidebar-search-btn',
    'sessions-section':    '#sessions-section',
    'email-section':       '#email-section',
    'models-section':      '#models-section',
    'tools-section':       '#tools-section',
    // 每个工具可见性 — 精细控制哪些条目显示
    // 在侧边栏工具区域中。
    'tool-calendar':       '#tool-calendar-btn',
    'tool-compare':        '#tool-compare-btn',
    'tool-cookbook':       '#tool-cookbook-btn',
    'tool-research':       '#tool-research-btn',
    'tool-gallery':        '#tool-gallery-btn',
    'tool-library':        '#tool-library-btn',
    'tool-memory':         '#tool-memory-btn',
    'tool-notes':          '#tool-notes-btn',
    'tool-tasks':          '#tool-tasks-btn',
    'tool-theme':          '#tool-theme-btn',
    'tool-language':       '#tool-language-btn',
    'user-bar':            '#user-bar-profile',
    'sidebar-settings-btn':'#user-bar-settings',
    'chat-meta':           '.chat-meta-overlay',
    'welcome-text':        '.welcome-name, .welcome-sub, #welcome-tip',
    'incognito-btn':       '.incognito-btn',
    'web-toggle-btn':      '#web-toggle-btn',
    'doc-toggle-btn':      '#overflow-doc-btn',
    'rag-toggle-btn':      '#overflow-rag-btn',
    'bash-toggle-btn':     '#bash-toggle-btn',
    'overflow-plus-btn':   '.overflow-wrapper',
    'mode-toggle':         '.mode-toggle',
    'preset-mini-btn':     '#overflow-preset-btn',
    'attach-btn':          '#overflow-attach-btn',
    'research-btn':        '#overflow-research-btn',
    'rail-new-chat':       '#rail-new-session',
  };

  // 首次运行时默认隐藏的键（尚无 localStorage）
  const UI_VIS_DEFAULT_OFF = new Set(['models-section', 'rag-toggle-btn', 'text-emojis']);

  // 需要管理员才能关闭的键（保留供将来使用）
  const UI_VIS_ADMIN_ONLY = new Set([]);

  function loadUIVis() {
    return Storage.getJSON(UI_VIS_KEY, {});
  }

  function saveUIVis(state) {
    Storage.setJSON(UI_VIS_KEY, state);
  }

  function applyUIVis(state) {
    Object.entries(UI_VIS_MAP).forEach(([key, selector]) => {
      // section-drag-reorder 使用body类而非内联样式
      if (key === 'section-drag-reorder') return;
      const visible = key in state ? state[key] !== false : !UI_VIS_DEFAULT_OFF.has(key);
      document.querySelectorAll(selector).forEach(el => {
        el.style.display = visible ? '' : 'none';
      });
    });
    // 拖拽排序：使用 body 类使动态创建的手柄也能被覆盖
    const dragEnabled = state['section-drag-reorder'] === true;
    document.body.classList.toggle('rearrange-mode', dragEnabled);
    document.querySelectorAll('.section[draggable]').forEach(el => {
      el.setAttribute('draggable', dragEnabled ? 'true' : 'false');
    });
    // 纯文本表情切换。默认关闭，避免模型输出的短代码
    // 如 `:blush:` 通过正常单色表情路径渲染。
    applyTextEmojis(state['text-emojis'] === true);
    // 隐藏思考区域切换（show-thinking: 选中=显示, 未选中=隐藏）
    document.body.classList.toggle('hide-thinking', state['show-thinking'] === false);
  }

  // 会话/模型排序下拉框中的重新排列开关
  function syncRearrangeChecks() {
    const on = loadUIVis()['section-drag-reorder'] === true;
    document.querySelectorAll('.rearrange-toggle .rearrange-check').forEach(ch => {
      ch.style.opacity = on ? '1' : '0';
    });
  }
  document.querySelectorAll('.rearrange-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const state = loadUIVis();
      const wasOn = state['section-drag-reorder'] === true;
      state['section-drag-reorder'] = !wasOn;
      saveUIVis(state);
      applyUIVis(state);
      syncRearrangeChecks();
      uiModule.showToast(!wasOn ? i18nModule.t('notification.rearrange_enabled') : i18nModule.t('notification.rearrange_disabled'));
      // 关闭切换开关所在的下拉菜单 — 排序下拉菜单自身的
      // click-stopPropagation 意味着它不会自动关闭。
      const dd = toggle.closest('[id$="-sort-dropdown"]');
      if (dd) dd.style.display = 'none';
    });
  });

  // Esc 退出重新排列模式（无论焦点/鼠标在哪里）— 与全局
  // Esc-取消-选择模式一致。使用捕获阶段，防止已打开的排序下拉菜单
  // 先吞掉该事件。
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.body.classList.contains('rearrange-mode')) return;
    e.preventDefault();
    e.stopPropagation();
    const state = loadUIVis();
    state['section-drag-reorder'] = false;
    saveUIVis(state);
    applyUIVis(state);
    syncRearrangeChecks();
    uiModule.showToast(i18nModule.t('notification.rearrange_disabled'));
  }, true);
  // 下拉菜单打开时同步勾选标记
  const _sessionSortBtn = el('session-sort-btn');
  const _modelSortBtn = el('model-sort-btn');
  if (_sessionSortBtn) _sessionSortBtn.addEventListener('click', syncRearrangeChecks);
  if (_modelSortBtn) _modelSortBtn.addEventListener('click', syncRearrangeChecks);
  syncRearrangeChecks();

  // ── 纯文本 emoji 转换 ──
  // 匹配大部分 emoji 码点的正则（Emoji_Presentation + 常见序列）
  const EMOJI_RE = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:\uFE0F|\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}))*/gu;

  // 常用表情 → 文字描述的映射表
  const EMOJI_MAP = {
    '😀':'grinning','😃':'smiley','😄':'smile','😁':'grin','😆':'laughing','😅':'sweat smile',
    '🤣':'rofl','😂':'joy','🙂':'slightly smiling','🙃':'upside down','😉':'wink',
    '😊':'blush','😇':'innocent','🥰':'smiling hearts','😍':'heart eyes','🤩':'star struck',
    '😘':'kissing heart','😗':'kissing','😚':'kissing closed eyes','😙':'kissing smiling eyes',
    '🥲':'smiling tear','😋':'yum','😛':'tongue','😜':'winking tongue','🤪':'zany',
    '😝':'squinting tongue','🤑':'money mouth','🤗':'hugging','🤭':'hand over mouth',
    '🤫':'shushing','🤔':'thinking','🫡':'saluting','🤐':'zipper mouth','🤨':'raised eyebrow',
    '😐':'neutral','😑':'expressionless','😶':'no mouth','🫥':'dotted line face',
    '😏':'smirk','😒':'unamused','🙄':'eye roll','😬':'grimacing','🤥':'lying',
    '😌':'relieved','😔':'pensive','😪':'sleepy','🤤':'drooling','😴':'sleeping',
    '😷':'mask','🤒':'thermometer','🤕':'head bandage','🤢':'nauseated','🤮':'vomiting',
    '🥵':'hot','🥶':'cold','🥴':'woozy','😵':'dizzy','🤯':'exploding head',
    '🤠':'cowboy','🥳':'party','🥸':'disguised','😎':'sunglasses','🤓':'nerd',
    '🧐':'monocle','😕':'confused','🫤':'diagonal mouth','😟':'worried','🙁':'slightly frowning',
    '😮':'open mouth','😯':'hushed','😲':'astonished','😳':'flushed','🥺':'pleading',
    '🥹':'holding back tears','😦':'frowning open mouth','😧':'anguished','😨':'fearful',
    '😰':'anxious sweat','😥':'sad relieved','😢':'crying','😭':'sobbing','😱':'screaming',
    '😖':'confounded','😣':'persevering','😞':'disappointed','😓':'downcast sweat',
    '😩':'weary','😫':'tired','🥱':'yawning','😤':'triumph','😡':'pouting',
    '😠':'angry','🤬':'swearing','😈':'smiling devil','👿':'angry devil',
    '💀':'skull','☠️':'skull crossbones','💩':'poop','🤡':'clown','👹':'ogre','👺':'goblin',
    '👻':'ghost','👽':'alien','👾':'space invader','🤖':'robot',
    '😺':'smiling cat','😸':'grinning cat','😹':'tears of joy cat','😻':'heart eyes cat',
    '😼':'wry cat','😽':'kissing cat','🙀':'weary cat','😿':'crying cat','😾':'pouting cat',
    '🙈':'see no evil','🙉':'hear no evil','🙊':'speak no evil',
    '👋':'wave','🤚':'raised back of hand','🖐️':'hand with fingers splayed','✋':'raised hand',
    '🖖':'vulcan salute','🫱':'rightward hand','🫲':'leftward hand',
    '👌':'ok hand','🤌':'pinched fingers','🤏':'pinching hand','✌️':'victory',
    '🤞':'crossed fingers','🫰':'hand with index finger and thumb crossed',
    '🤟':'love you','🤘':'rock on','🤙':'call me','👈':'point left','👉':'point right',
    '👆':'point up','🖕':'middle finger','👇':'point down','☝️':'index up',
    '🫵':'point at viewer','👍':'thumbs up','👎':'thumbs down','✊':'raised fist',
    '👊':'fist bump','🤛':'left fist','🤜':'right fist','👏':'clap','🙌':'raising hands',
    '🫶':'heart hands','👐':'open hands','🤲':'palms up','🤝':'handshake','🙏':'pray',
    '✍️':'writing','💅':'nail polish','🤳':'selfie','💪':'flexed biceps',
    '❤️':'red heart','🧡':'orange heart','💛':'yellow heart','💚':'green heart',
    '💙':'blue heart','💜':'purple heart','🖤':'black heart','🤍':'white heart',
    '🩷':'pink heart','🩵':'light blue heart','🩶':'grey heart','🤎':'brown heart',
    '💔':'broken heart','❤️‍🔥':'heart on fire','❤️‍🩹':'mending heart',
    '💕':'two hearts','💞':'revolving hearts','💓':'heartbeat','💗':'growing heart',
    '💖':'sparkling heart','💘':'heart with arrow','💝':'heart with ribbon',
    '💟':'heart decoration','🔥':'fire','💯':'100','✨':'sparkles','⭐':'star',
    '🌟':'glowing star','💫':'dizzy star','🎉':'party popper','🎊':'confetti ball',
    '🎈':'balloon','🎁':'gift','🏆':'trophy','🥇':'1st place','🥈':'2nd place','🥉':'3rd place',
    '⚡':'zap','💡':'light bulb','🔑':'key','🔒':'locked','🔓':'unlocked',
    '🔔':'bell','🔕':'bell off','📢':'loudspeaker','📣':'megaphone',
    '💬':'speech bubble','💭':'thought bubble','🗯️':'anger bubble',
    '✅':'check mark','❌':'cross mark','❓':'question','❗':'exclamation',
    '⚠️':'warning','🚫':'prohibited','⛔':'no entry','🔴':'red circle','🟢':'green circle',
    '🔵':'blue circle','🟡':'yellow circle','⚪':'white circle','⚫':'black circle',
    '🟠':'orange circle','🟣':'purple circle','🟤':'brown circle',
    '📁':'folder','📂':'open folder','📄':'document','📝':'memo','📎':'paperclip',
    '📌':'pin','📍':'round pin','🔗':'link','📊':'bar chart','📈':'chart up','📉':'chart down',
    '🔍':'magnifying glass left','🔎':'magnifying glass right',
    '🌐':'globe','🌍':'globe europe','🌎':'globe americas','🌏':'globe asia',
    '🕐':'clock 1','🕑':'clock 2','🕒':'clock 3','🕓':'clock 4',
    '⏰':'alarm clock','⏳':'hourglass flowing','⌛':'hourglass done',
    '🚀':'rocket','✈️':'airplane','🚗':'car','🚂':'train','🚢':'ship',
    '🏠':'house','🏢':'building','🏗️':'construction','🏭':'factory',
    '🎵':'musical note','🎶':'musical notes','🎤':'microphone','🎧':'headphones',
    '📷':'camera','📸':'camera flash','🎬':'clapperboard','📺':'television',
    '💻':'laptop','🖥️':'desktop','📱':'mobile phone','☎️':'telephone',
    '🔧':'wrench','🔨':'hammer','⚙️':'gear','🧲':'magnet','🧪':'test tube','🔬':'microscope',
    '📚':'books','📖':'open book','✏️':'pencil','🖊️':'pen','🖋️':'fountain pen',
    '🎯':'bullseye','♟️':'chess pawn','🎲':'game die','🧩':'puzzle piece',
    '🍕':'pizza','🍔':'burger','🍟':'fries','🌮':'taco','🍣':'sushi','🍩':'donut',
    '☕':'coffee','🍺':'beer','🍷':'wine','🥤':'cup with straw',
    '🐶':'dog','🐱':'cat','🐭':'mouse','🐹':'hamster','🐰':'rabbit','🦊':'fox',
    '🐻':'bear','🐼':'panda','🐨':'koala','🐯':'tiger','🦁':'lion','🐮':'cow',
    '🐷':'pig','🐸':'frog','🐵':'monkey','🐔':'chicken','🐧':'penguin','🐦':'bird',
    '🦅':'eagle','🦆':'duck','🦉':'owl','🐺':'wolf','🐗':'boar','🐴':'horse',
    '🦄':'unicorn','🐝':'bee','🐛':'bug','🦋':'butterfly','🐌':'snail','🐞':'ladybug',
    '🐍':'snake','🐢':'turtle','🐙':'octopus','🦀':'crab','🐠':'tropical fish',
    '🐳':'whale','🐋':'whale','🦈':'shark','🐊':'crocodile','🦕':'sauropod','🦖':'t-rex',
    '🌸':'cherry blossom','🌹':'rose','🌻':'sunflower','🌺':'hibiscus','🌷':'tulip',
    '🌱':'seedling','🌲':'evergreen tree','🌳':'deciduous tree','🍀':'four leaf clover',
    '🍎':'red apple','🍐':'pear','🍊':'tangerine','🍋':'lemon','🍌':'banana',
    '🍉':'watermelon','🍇':'grapes','🍓':'strawberry','🫐':'blueberries','🍑':'peach',
    '🌈':'rainbow','☀️':'sun','🌤️':'sun behind cloud','⛅':'sun behind cloud','☁️':'cloud',
    '🌧️':'rain','⛈️':'thunder','❄️':'snowflake','🌊':'wave',
    '👀':'eyes','👁️':'eye','👂':'ear','👃':'nose','👄':'mouth','👅':'tongue',
    '🧠':'brain','🦴':'bone','🦷':'tooth','👶':'baby','🧒':'child','👦':'boy','👧':'girl',
    '🧑':'person','👨':'man','👩':'woman','🧓':'older person',
    '👮':'police officer','🧑‍💻':'technologist','👨‍💻':'man technologist',
    '👩‍💻':'woman technologist',
    '🎓':'graduation cap','🧢':'billed cap','👑':'crown','💎':'gem','👓':'glasses','🕶️':'sunglasses',
    '🩸':'drop of blood','💊':'pill','🩹':'bandage','🧬':'dna','🦠':'microbe',
    '☢️':'radioactive','☣️':'biohazard','♻️':'recycling',
    '🏳️':'white flag','🏴':'black flag','🚩':'red flag','🏁':'checkered flag',
    '➡️':'right arrow','⬅️':'left arrow','⬆️':'up arrow','⬇️':'down arrow',
    '↗️':'upper right arrow','↘️':'lower right arrow','↙️':'lower left arrow','↖️':'upper left arrow',
    '↩️':'left curve','↪️':'right curve','🔄':'counterclockwise','🔃':'clockwise',
    '➕':'plus','➖':'minus','➗':'division','✖️':'multiply','♾️':'infinity',
    '‼️':'double exclamation','⁉️':'exclamation question',
    '©️':'copyright','®️':'registered','™️':'trademark',
  };

  function emojiToText(str) {
    return str.replace(EMOJI_RE, (match) => {
      const desc = EMOJI_MAP[match];
      if (desc) return ':' + desc + ':';
      // 降级方案：如果可用则使用表情的 Unicode 名称，否则跳过
      return ':emoji:';
    });
  }

  const _DEOJ_SKIP = '.sources-section, .thinking-toggle, .memory-used-pill';

  /** 遍历元素内的所有文本节点并将表情符号替换为文本描述 */
  function deEmojify(root) {
    if (!root || !root.querySelectorAll) return;
    // 来自 svgifyEmoji 的单色 SVG span — Unicode 仅存在于 aria-label 中
    root.querySelectorAll('.emoji[aria-label]').forEach((span) => {
      if (span.closest(_DEOJ_SKIP)) return;
      const label = span.getAttribute('aria-label') || '';
      span.replaceWith(document.createTextNode(emojiToText(label)));
    });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      // 跳过使用 Unicode 符号作为功能图标的 UI 元素
      if (node.parentElement && node.parentElement.closest(_DEOJ_SKIP)) continue;
      if (EMOJI_RE.test(node.textContent)) {
        EMOJI_RE.lastIndex = 0; // 重置正则状态
        node.textContent = emojiToText(node.textContent);
      }
    }
  }

  /** 在所有聊天消息上应用或移除文本表情模式 */
  function applyTextEmojis(enabled) {
    document.body.classList.toggle('text-emojis', enabled);
    if (enabled) {
      document.querySelectorAll('.msg .body').forEach(deEmojify);
    }
  }

  // 监听聊天记录的新增/变化消息 — 动态去除emoji
  let _deEmojifyTimer = null;
  const _chatObs = new MutationObserver(() => {
    if (!document.body.classList.contains('text-emojis')) return;
    clearTimeout(_deEmojifyTimer);
    _deEmojifyTimer = setTimeout(() => {
      document.querySelectorAll('.msg .body').forEach(deEmojify);
    }, 150);
  });
  const _chatBox = document.getElementById('chat-history');
  if (_chatBox) _chatObs.observe(_chatBox, { childList: true, subtree: true });

  // 如果存在旧的工具栏可见性键则迁移
  (function migrateOldToolbarVis() {
    const OLD_KEY = 'odysseus-toolbar-visibility';
    try {
      const old = Storage.getJSON(OLD_KEY, null);
      if (old && typeof old === 'object') {
        const current = loadUIVis();
        let migrated = false;
        Object.entries(old).forEach(([btnId, val]) => {
          if (current[btnId] === undefined) {
            current[btnId] = val;
            migrated = true;
          }
        });
        if (migrated) saveUIVis(current);
        Storage.remove(OLD_KEY);
      }
    } catch {}
  })();

  // 暴露 UI 可见性函数供 admin.js 使用
  window.loadUIVis = loadUIVis;
  window.saveUIVis = saveUIVis;
  window.applyUIVis = applyUIVis;
  window.UI_VIS_ADMIN_ONLY = UI_VIS_ADMIN_ONLY;
  window.UI_VIS_DEFAULT_OFF = UI_VIS_DEFAULT_OFF;

  (function initUIVisibility() {
    // 页面加载时应用保存的可见性设置
    applyUIVis(loadUIVis());

    // 仅有的两个没有各自 makeWindowDraggable 调用的模态框。把它们
    // 接入共享辅助函数，仅拖拽模式，以匹配原有行为。
    try {
      ['custom-preset-modal', 'rename-session-modal'].forEach((id) => {
        const m = document.getElementById(id);
        if (!m) return;
        const content = m.querySelector('.modal-content');
        const header = m.querySelector('.modal-header');
        if (!content || !header) return;
        makeWindowDraggable(m, {
          content, header,
          skipSelector: '.close-btn',
          enableDock: false,
          enableResize: false,
        });
        // 打开时重新居中（这些在 DOM 中持久存在）。守卫条件：
        // 仅在 hidden→visible 转换时触发，避免拖拽中误触发。
        let wasHidden = m.classList.contains('hidden');
        new MutationObserver(() => {
          const isHidden = m.classList.contains('hidden');
          if (wasHidden && !isHidden) {
            content.style.position = '';
            content.style.left = '';
            content.style.top = '';
            content.style.right = '';
            content.style.bottom = '';
            content.style.margin = '';
          }
          wasHidden = isHidden;
        }).observe(m, { attributes: true, attributeFilter: ['class'] });
      });
    } catch (e) { console.error('Dialog drag init error:', e); }
  })();

  // ── 模态框最小化 → 停靠栏 ──
  // 在每个模态框的关闭按钮旁边添加一个 "_" 按钮。点击后隐藏
  // 模态框并将条目添加到固定的底部停靠栏；点击停靠栏
  // 条目恢复模态框。通过 document.body 上的 MutationObserver
  // 对手动创建和动态创建的模态框均有效。
  (function initModalMinimize() {
    // custom-preset-modal（提示窗口）由新的 modalManager 停靠栏
    // 处理（在 _AUTO_WIRE 中注册），因此旧版停靠栏不能
    // 也为它注入 `_`/芯片。
    const SKIP_IDS = new Set(['styled-confirm-overlay', 'custom-preset-modal']);
    const dockEntries = new Map(); // 模态框元素 -> 停靠栏条目元素

    let dock = document.getElementById('modal-dock');
    if (!dock) {
      dock = document.createElement('div');
      dock.id = 'modal-dock';
      document.body.appendChild(dock);
    }

    // 保持停靠栏远离侧边栏（侧边栏可折叠、调整大小、
    // 隐藏或翻转到右侧）。
    function updateDockOffset() {
      const sidebar = document.getElementById('sidebar');
      const iconRail = document.getElementById('icon-rail');
      let leftPx = 0;
      let rightPx = 0;
      const sidebarRight = sidebar && sidebar.classList.contains('right-side');
      const sidebarVisible = sidebar &&
        !sidebar.classList.contains('hidden') &&
        sidebar.offsetWidth > 0;
      const railVisible = iconRail && iconRail.offsetWidth > 0;
      const sidebarW = sidebarVisible ? sidebar.offsetWidth : 0;
      const railW = railVisible ? iconRail.offsetWidth : 0;
      if (sidebarRight) {
        rightPx = sidebarW + railW;
      } else {
        leftPx = sidebarW + railW;
      }
      dock.style.left = leftPx + 'px';
      dock.style.right = rightPx + 'px';
    }
    updateDockOffset();
    // 侧边栏调整大小、折叠或换边时重新计算
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(updateDockOffset);
      const sb = document.getElementById('sidebar');
      const ir = document.getElementById('icon-rail');
      if (sb) ro.observe(sb);
      if (ir) ro.observe(ir);
    }
    window.addEventListener('resize', updateDockOffset);
    // 侧边翻转/折叠切换 body 或 sidebar 的类名
    new MutationObserver(updateDockOffset).observe(document.body, {
      attributes: true, attributeFilter: ['class'],
    });
    const sbEl = document.getElementById('sidebar');
    if (sbEl) {
      new MutationObserver(updateDockOffset).observe(sbEl, {
        attributes: true, attributeFilter: ['class', 'style'],
      });
    }

    function modalTitle(modal) {
      const h = modal.querySelector('.modal-header h4, .modal-header h3, .modal-header h2');
      if (h && h.textContent.trim()) return h.textContent.trim();
      if (modal.id) return modal.id.replace(/-modal$|-overlay$|-popup$/, '').replace(/-/g, ' ');
      return i18nModule.t('window.window');
    }

    function removeDockEntry(modal) {
      const entry = dockEntries.get(modal);
      if (entry) {
        entry.remove();
        dockEntries.delete(modal);
      }
    }

    function restoreModal(modal) {
      modal.classList.remove('minimized');
      modal.classList.remove('hidden');
      removeDockEntry(modal);
      // 置前（匹配现有的点击聚焦行为）
      modal.style.zIndex = '';
    }

    function minimizeModal(modal) {
      if (modal.classList.contains('hidden')) return;
      modal.classList.add('minimized');
      if (dockEntries.has(modal)) return;

      const entry = document.createElement('div');
      entry.className = 'modal-dock-item';
      entry.title = i18nModule.t('window.restore', { name: modalTitle(modal) });

      const label = document.createElement('span');
      label.className = 'modal-dock-label';
      label.textContent = modalTitle(modal);

      const closeX = document.createElement('button');
      closeX.className = 'modal-dock-close';
      closeX.textContent = '×';
      closeX.title = i18nModule.t('window.close');
      closeX.addEventListener('click', (e) => {
        e.stopPropagation();
        modal.classList.remove('minimized');
        modal.classList.add('hidden');
        modal.style.display = '';
        removeDockEntry(modal);
      });

      entry.appendChild(label);
      entry.appendChild(closeX);
      entry.addEventListener('click', () => restoreModal(modal));
      dock.appendChild(entry);
      dockEntries.set(modal, entry);
    }

    function injectMinimizeButton(modal) {
      if (!modal || !modal.classList || !modal.classList.contains('modal')) return;
      if (modal.id && SKIP_IDS.has(modal.id)) return;
      // 由新的modalManager（Modals.register）管理的模态框各自拥有
      // .modal-minimize-btn 和通过 .minimized-dock-chip 系统的条目标签。
      // 完全跳过它们，避免重复添加最小化按钮或chip。
      if (modal.id && /^email-reader-/.test(modal.id)) return;
      if (modal.id && window.Modals && window.Modals.isRegistered && window.Modals.isRegistered(modal.id)) return;
      const header = modal.querySelector('.modal-header');
      if (!header) return;
      if (header.querySelector('.minimize-btn, .modal-minimize-btn')) return;
      const closeBtn = header.querySelector('.close-btn, .modal-close');
      if (!closeBtn) return;

      const minBtn = document.createElement('button');
      minBtn.className = 'minimize-btn';
      minBtn.type = 'button';
      minBtn.title = i18nModule.t('window.minimize');
      minBtn.textContent = '_';
      minBtn.addEventListener('mousedown', (e) => e.stopPropagation()); // 不启动拖拽
      minBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        minimizeModal(modal);
      });
      closeBtn.parentElement.insertBefore(minBtn, closeBtn);

      // 监听此模态框的类变化，以便从其他地方关闭时清除dock入口
      new MutationObserver(() => {
        if (modal.classList.contains('hidden') && !modal.classList.contains('minimized')) {
          removeDockEntry(modal);
        }
      }).observe(modal, { attributes: true, attributeFilter: ['class'] });
    }

    // 首次遍历现有模态框
    document.querySelectorAll('.modal').forEach(injectMinimizeButton);

    // 监听动态创建的模态框
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.classList && n.classList.contains('modal')) {
            injectMinimizeButton(n);
          }
          if (n.querySelectorAll) {
            n.querySelectorAll('.modal').forEach(injectMinimizeButton);
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  })();

  // 预设按钮（在溢出菜单中）
  const overflowPresetBtn = el('overflow-preset-btn');
  if (overflowPresetBtn) {
    overflowPresetBtn.addEventListener('click', () => {
      if (presetsModule && presetsModule.openCustomPresetModal) {
        presetsModule.openCustomPresetModal();
      }
    });
  }

  // RAG 目录
  const addDirBtn = el('add-directory-btn');
  if (addDirBtn) {
    addDirBtn.addEventListener('click', () => {
      ragModule.addRagDirectory(uiModule.showToast, uiModule.showError);
    });
  }
  
  const directoryInput = el('rag-directory');
  if (directoryInput) {
    directoryInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        ragModule.addRagDirectory(uiModule.showToast, uiModule.showError);
      }
    });

  }

  // 侧边栏布局（已提取到 js/sidebar-layout.js）
  initSidebarLayout(Storage, {
    documentModule, _closeCompareIfActive, _deactivateIncognito,
    presetsModule, sessionModule, el, _defaultChat, _syncResearchIndicator
  });

  // 移动端：在选项卡窗口中横向滑动切换标签。适用于任何具有
  // 拥有同级按钮并在点击时切换的标签栏（提示词、文档库、
  // 记忆库、主题）— 只需点击上一个/下一个标签，让现有切换
  // 逻辑运行。从交互控件（滑块、输入框、
  // 条目标签停靠栏）开始的滑动将被忽略，避免与文本选择/拖拽冲突。
  (function initTabSwipe() {
    if (window.innerWidth > 768) return;
    // 每个选项卡窗口的[标签栏选择器, 标签按钮选择器]。
    const SYSTEMS = [
      ['.preset-tabs', '.preset-tab'],
      ['.lib-tabs', '.lib-tab'],
      ['.memory-tabs', '.memory-tab'],
      ['.admin-tabs', '.admin-tab'],
    ];
    const _IGNORE = 'input, textarea, select, [contenteditable="true"], .preset-range, ' +
      '.note-cl-row, .minimized-dock-chip, canvas, .email-card-reader';
    let sx = 0, sy = 0, tracking = false;

    document.addEventListener('touchstart', (e) => {
      if (window.innerWidth > 768 || e.touches.length !== 1) { tracking = false; return; }
      if (e.target.closest && e.target.closest(_IGNORE)) { tracking = false; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - sx, dy = t.clientY - sy;
      // 需要是明显的、基本水平的滑动
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      for (const [barSel, tabSel] of SYSTEMS) {
        const bar = document.querySelector(barSel);
        if (!bar || bar.offsetParent === null) continue;  // 不是可见窗口
        // 仅在滑动发生在当前窗口内时才切换（而不是其他屏幕元素上）
        const host = bar.closest('.modal, #notes-pane, .preset-modal-content, .admin-card') || bar.parentElement;
        const startEl = document.elementFromPoint(sx, sy);
        if (host && startEl && !host.contains(startEl)) continue;
        const tabs = [...bar.querySelectorAll(tabSel)];
        if (tabs.length < 2) continue;
        let idx = tabs.findIndex(tb => tb.classList.contains('active'));
        if (idx < 0) idx = 0;
        // 左滑 (dx<0) → 下一个标签页；右滑 (dx>0) → 上一个标签页
        const nextIdx = dx < 0 ? idx + 1 : idx - 1;
        if (nextIdx < 0 || nextIdx >= tabs.length) return;  // 已到边缘
        tabs[nextIdx].click();
        return;
      }
    }, { passive: true });
  })();

  // 弹性过度滚动（橡皮筋回弹）—— 仅桌面端滚轮，作用于 chat-history 而非 container
  (function initElasticScroll() {
    const hist = el('chat-history');
    if (!hist) return;
    const SNAP_BACK = 'transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94)';

    let wheelPull = 0;
    let wheelTimer = null;
    hist.addEventListener('wheel', (e) => {
      const atTop = hist.scrollTop <= 0 && e.deltaY < 0;
      const atBottom = hist.scrollTop + hist.clientHeight >= hist.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atBottom) { wheelPull = 0; return; }

      wheelPull += e.deltaY * -0.03;
      wheelPull = Math.max(-7, Math.min(7, wheelPull));
      hist.style.transition = 'none';
      hist.style.transform = `translateY(${wheelPull}px)`;

      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        wheelPull = 0;
        hist.style.transition = SNAP_BACK;
        hist.style.transform = '';
      }, 120);
    }, { passive: true });
  })();

  // 图标栏上的新建会话按钮
  const railNewSession = el('rail-new-session');
  if (railNewSession) {
    railNewSession.addEventListener('click', async () => {
      if (!sessionModule) return;
      if (_closeCompareIfActive()) return;
      _deactivateIncognito();
      // 新建聊天时清除角色
      if (presetsModule && presetsModule.deactivateCharacter) presetsModule.deactivateCharacter();
      // 清除研究模式（如已激活）
      const _resChk = el('research-toggle');
      if (_resChk && _resChk.checked) _syncResearchIndicator(false);
      if (await _createDirectChatFromPreferredModel()) return;
      // 完全没有模型 — 显示欢迎页面
      sessionModule.setCurrentSessionId(null);
      if (documentModule && documentModule.isPanelOpen && documentModule.isPanelOpen()) documentModule.closePanel();
      const docBtn3 = el('overflow-doc-btn');
      if (docBtn3) docBtn3.classList.remove('active', 'has-docs');
      const box = el('chat-history');
      if (box) box.innerHTML = '';
      if (chatModule && chatModule.showWelcomeScreen) {
        chatModule.showWelcomeScreen();
      }
      document.querySelectorAll('.session-item.active').forEach(s => s.classList.remove('active'));
    });
  }

  // 移动端新建聊天按钮 — 始终跳转到空白欢迎页面。
  // 聊天发送路径（chat.js:354）在第一次提交时会通过 /api/default-chat 自动创建会话，
  // 这样用户可以在模型加载完成前就开始输入，发送时默认模型会自动附加。
  const mobileNewChat = el('mobile-new-chat-btn');
  if (mobileNewChat) {
    mobileNewChat.addEventListener('click', () => {
      if (!sessionModule) return;
      if (_closeCompareIfActive()) return;
      _deactivateIncognito();
      _startFreshChat();
      document.querySelectorAll('.session-item.active').forEach(s => s.classList.remove('active'));
      // 同步聚焦输入框，让移动端键盘弹出。
      // iOS Safari 只在原始点击回调中响应程序化聚焦 —
      // setTimeout 会打断用户手势链。
      const _input = el('message-input');
      if (_input) { try { _input.focus(); } catch (_) {} }
    });
  }

  // Logo 点击 → 新建聊天（与图标栏新建会话按钮逻辑相同）
  const brandBtn = el('sidebar-brand-btn');
  if (brandBtn) {
    brandBtn.addEventListener('click', async () => {
      if (!sessionModule) return;
      if (_closeCompareIfActive()) return;
      _deactivateIncognito();
      if (presetsModule && presetsModule.deactivateCharacter) presetsModule.deactivateCharacter();
      // 开始新聊天时清除研究切换状态（非通过研究按钮触发）
      _syncResearchIndicator(false);
      if (await _createDirectChatFromPreferredModel()) return;
      // 完全没有模型 — 显示欢迎页面
      sessionModule.setCurrentSessionId(null);
      if (documentModule && documentModule.isPanelOpen && documentModule.isPanelOpen()) documentModule.closePanel();
      const docBtn2 = el('overflow-doc-btn');
      if (docBtn2) docBtn2.classList.remove('active', 'has-docs');
      const box = el('chat-history');
      if (box) box.innerHTML = '';
      if (chatModule && chatModule.showWelcomeScreen) chatModule.showWelcomeScreen();
      document.querySelectorAll('.session-item.active').forEach(s => s.classList.remove('active'));
    });
  }

  const sidebarNewChatBtn = el('sidebar-new-chat-btn');
  if (sidebarNewChatBtn) {
    sidebarNewChatBtn.addEventListener('click', () => {
      const brandBtn = el('sidebar-brand-btn');
      if (brandBtn) brandBtn.click();
    });
  }

  // 图标栏上的删除会话按钮
  const railDelete = el('rail-delete-session');
  if (railDelete) {
    railDelete.addEventListener('click', async () => {
      if (!sessionModule) return;
      const currentId = sessionModule.getCurrentSessionId();
      if (!currentId) return;
      const sessions = sessionModule.getSessions();
      const current = sessions.find(s => s.id === currentId);
      const name = current ? current.name : 'this session';
      if (!await uiModule.styledConfirm(`Delete "${name}"?`, { confirmText: i18nModule.t('common.delete'), danger: true })) return;
      try {
        // 删除前找到当前会话下方的下一个会话
        const idx = sessions.findIndex(s => s.id === currentId);
        const nextSession = sessions.filter(s => !s.archived && s.id !== currentId)[Math.max(0, idx)] ||
                            sessions.find(s => !s.archived && s.id !== currentId);
        const res = await fetch(`${API_BASE}/api/session/${currentId}`, { method: 'DELETE' });
        if (res.ok) {
          await sessionModule.loadSessions();
          if (nextSession) {
            await sessionModule.selectSession(nextSession.id);
          }
          uiModule.showToast(i18nModule.t('notification.session_deleted'));
        } else {
          uiModule.showError(i18nModule.t('notification.failed_delete_session'));
        }
      } catch (e) {
        uiModule.showError(i18nModule.t('notification.failed_delete_session_error', { error: String(e) }));
      }
    });
  }

  // 文本框自适应高度
  const textarea = el('message');
  if (textarea) {
    uiModule.autoResize(textarea);
    textarea.addEventListener('input', () => {
      uiModule.autoResize(textarea);
    });
    textarea.addEventListener('paste', () => {
      setTimeout(() => uiModule.autoResize(textarea), 1);
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        // 如果虚拟文本自动补全激活中，接受建议而不是提交
        if (window._ghostAutocomplete && window._ghostAutocomplete.isActive()) {
          e.preventDefault();
          e.stopPropagation();
          window._ghostAutocomplete.accept();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        // 触发表单提交前检查是否已在提交中
        const form = el('chat-form');
        if (form) {
         const submitBtn = form.querySelector('button[type="submit"]');
         if (submitBtn) submitBtn.click();
        }
      }
    });
  }

  // ── 虚拟文本自动补全：/new 和 /create 命令 ──
  (function initGhostAutocomplete() {
    const textarea = el('message');
    const ghost = document.getElementById('message-ghost');
    if (!textarea || !ghost) return;

    let modelCache = null;     // { models: [{ mid, url, endpointId, displayName }], ts }
    let filtered = [];         // 当前匹配的模型
    let cycleIdx = 0;          // filtered[] 的索引
    let active = false;        // 虚拟提示是否可见？
    const CACHE_TTL = 60000;   // 60秒后重新获取
    const CMD_RE = /^\/(new|create)\s/i;

    async function fetchModels() {
      if (modelCache && Date.now() - modelCache.ts < CACHE_TTL) return modelCache.models;
      try {
        const res = await fetch(`${API_BASE}/api/models`, { credentials: 'same-origin' });
        const data = await res.json();
        const models = [];
        (data.items || []).forEach(ep => {
          const displayNames = ep.models_display || ep.models || [];
          (ep.models || []).forEach((mid, i) => {
            models.push({
              mid,
              url: ep.url,
              endpointId: ep.endpoint_id || null,
              displayName: displayNames[i] || mid,
            });
          });
        });
        modelCache = { models, ts: Date.now() };
        return models;
      } catch (e) {
        console.warn('Ghost autocomplete: failed to fetch models', e);
        return modelCache ? modelCache.models : [];
      }
    }

    function hide() {
      active = false;
      filtered = [];
      cycleIdx = 0;
      ghost.textContent = '';
      ghost.style.display = 'none';
    }

    function show(typed, suggestion) {
      active = true;
      ghost.innerHTML = '';
      // 不可见部分匹配用户输入（保持对齐）
      const span1 = document.createElement('span');
      span1.style.visibility = 'hidden';
      span1.textContent = typed;
      // 可见的淡色建议部分
      const span2 = document.createElement('span');
      span2.className = 'ghost-suggestion';
      span2.textContent = suggestion;
      ghost.appendChild(span1);
      ghost.appendChild(span2);
      ghost.style.display = 'block';
    }

    function syncSize() {
      // 匹配虚拟覆盖层尺寸与文本框
      const cs = getComputedStyle(textarea);
      ghost.style.width = cs.width;
      ghost.style.height = cs.height;
    }

    async function update() {
      const val = textarea.value;
      const match = val.match(CMD_RE);
      if (!match) { hide(); return; }

      const prefix = val.slice(match[0].length); // "/new " 或 "/create " 之后的文本
      const models = await fetchModels();
      if (!models.length) { hide(); return; }

      // 过滤出 displayName 以输入前缀开头的模型（忽略大小写）
      const lp = prefix.toLowerCase();
      filtered = models.filter(m =>
        m.mid.toLowerCase().startsWith(lp) || m.displayName.toLowerCase().startsWith(lp)
      );

      if (!filtered.length) { hide(); return; }

      // 限制循环索引
      cycleIdx = cycleIdx % filtered.length;
      const chosen = filtered[cycleIdx];
      // 判断哪个名称匹配用于补全
      const name = chosen.mid.toLowerCase().startsWith(lp) ? chosen.mid : chosen.displayName;
      const remainder = name.slice(prefix.length);
      if (!remainder && filtered.length <= 1) { hide(); return; }

      syncSize();
      show(val, remainder);
    }

    // --- 事件监听器 ---

    textarea.addEventListener('input', () => {
      cycleIdx = 0;
      update();
    });

    textarea.addEventListener('keydown', (e) => {
      if (!active) return;

      if (e.key === 'Tab') {
        // Tab 键将当前建议填入文本框
        e.preventDefault();
        e.stopPropagation();
        const val = textarea.value;
        const match = val.match(CMD_RE);
        if (match && filtered.length) {
          const prefix = val.slice(match[0].length);
          const chosen = filtered[cycleIdx % filtered.length];
          const lp = prefix.toLowerCase();
          const name = chosen.mid.toLowerCase().startsWith(lp) ? chosen.mid : chosen.displayName;
          textarea.value = match[0] + name;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        cycleIdx = (cycleIdx + 1) % filtered.length;
        update();
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        cycleIdx = (cycleIdx - 1 + filtered.length) % filtered.length;
        update();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        hide();
        return;
      }
    });

    textarea.addEventListener('blur', hide);

    // 监听文本框尺寸变化（autoResize），使虚拟文本保持同步
    const ro = new ResizeObserver(() => { if (active) syncSize(); });
    ro.observe(textarea);

    // 给上层 Enter 处理器的公开 API
    window._ghostAutocomplete = {
      isActive() { return active && filtered.length > 0; },
      accept() {
        if (!active || !filtered.length) return;
        const val = textarea.value;
        const match = val.match(CMD_RE);
        if (!match) { hide(); return; }
        const prefix = val.slice(match[0].length);
        const chosen = filtered[cycleIdx % filtered.length];
        const lp = prefix.toLowerCase();
        const name = chosen.mid.toLowerCase().startsWith(lp) ? chosen.mid : chosen.displayName;
        textarea.value = match[0] + name;
        hide();
        // 触发 input 事件让 autoResize 生效
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        // 现在提交表单（/new 命令处理器会处理它）
        setTimeout(() => {
          const form = el('chat-form');
          if (form) form.querySelector('button[type="submit"]').click();
        }, 0);
      }
    };
  })();

  // 键盘快捷键（提取到 js/keyboard-shortcuts.js）
  initKeyboardShortcuts({
    el, Storage, sessionModule, uiModule, chatModule,
    adminModule, settingsModule, searchChatModule,
    _closeCompareIfActive, _deactivateIncognito, API_BASE
  });
  
}

// ============================================
// 页面加载初始化
// ============================================
function startOdysseusApp() {
  if (window.__odysseusAppStarted) return;
  window.__odysseusAppStarted = true;

  // 首先初始化 i18n，确保所有文本从一开始就被翻译
  i18nModule.initI18n().then(() => {
    i18nModule.translateDOM();
  });

  // 设置 CSS 变量
  document.documentElement.style.setProperty('--line-height', '20px');

  // 平滑处理移动端键盘打开/关闭 — 保持聊天到底部
  if (window.visualViewport && 'ontouchstart' in window) {
    let _prevVPH = visualViewport.height;
    visualViewport.addEventListener('resize', () => {
      const delta = visualViewport.height - _prevVPH;
      _prevVPH = visualViewport.height;
      // 键盘已打开（视口显著缩小）
      if (delta < -50) {
        const hist = document.getElementById('chat-history');
        if (hist) {
          hist.style.scrollBehavior = 'smooth';
          hist.scrollTop = hist.scrollHeight;
          // 动画后重置
          setTimeout(() => { hist.style.scrollBehavior = ''; }, 300);
        }
      }
    });
  }

  // 初始化所有事件监听器
  try { initializeEventListeners(); } catch(e) { console.error('Event init error:', e); }

  // 显示工具栏，此时所有开关/溢出状态已解析
  // （HTML 中通过内联 style="visibility:hidden" 隐藏以防止 FOUC）
  const _inputBottom = document.querySelector('.chat-input-bottom');
  if (_inputBottom) _inputBottom.style.visibility = '';

  fileHandlerModule.init(API_BASE);
  modelsModule.init(API_BASE);
  ragModule.init(API_BASE);
  presetsModule.init(API_BASE);
  searchModule.init(API_BASE);
  chatModule.init(API_BASE);
  chatModule.initListeners();
  groupModule.init(API_BASE);
  // 初始化 compare 模块
  if (compareModule) {
    compareModule.init(API_BASE);
  }
  researchPanelModule.init(API_BASE, markdownModule, sessionModule);
  // 初始化文档编辑器模块
  if (documentModule) {
    documentModule.init(API_BASE);
    // 如果刷新前文档面板已打开则恢复
    const _curSession = sessionModule && sessionModule.getCurrentSessionId();
    if (_curSession && localStorage.getItem('odysseus-doc-open-' + _curSession) === '1') {
      documentModule.loadSessionDocs(_curSession);
    }
  }  
  // 初始化搜索聊天模块
  if (searchChatModule) {
    searchChatModule.init(API_BASE);
  }

  // 搜索按钮 — 图标栏 + 侧边栏
  const railSearchBtn = el('rail-search-btn');
  if (railSearchBtn) {
    railSearchBtn.addEventListener('click', () => {
      if (searchChatModule) searchChatModule.openSearch();
    });
  }

  // 图标栏工具按钮 — 委托给侧边栏工具按钮
  const _railToolMap = {
    'rail-compare':   'tool-compare-btn',
    'rail-research':  'tool-research-btn',
    'rail-cookbook':   'tool-cookbook-btn',
    'rail-archive':   'tool-library-btn',
    'rail-gallery':   'tool-gallery-btn',
    'rail-tasks':     'tool-tasks-btn',
    'rail-calendar':  'tool-calendar-btn',
    'rail-notes':     'tool-notes-btn',
    'rail-memory':    'tool-memory-btn',
    'rail-theme':     'tool-theme-btn',
    'rail-language':  'tool-language-btn',
    'rail-email':     'email-section-title',
  };
  Object.entries(_railToolMap).forEach(([railId, toolId]) => {
    const railBtn = el(railId);
    if (railBtn) {
      railBtn.addEventListener('click', () => {
        const toolBtn = el(toolId);
        if (toolBtn) toolBtn.click();
      });
    }
  });

  // 图标栏聊天按钮 — 点击打开已完成的后台会话
  const _railChatsBtn = el('rail-chats');
  if (_railChatsBtn) {
    _railChatsBtn.addEventListener('click', () => {
      const targetSid = _railChatsBtn.dataset.targetSession;
      if (targetSid && window.sessionModule) {
        window.sessionModule.selectSession(targetSid);
      }
      // 清除通知 — 会话加载时会调用 clearStreamComplete
      _railChatsBtn.classList.remove('rail-notify', 'rail-notify-success');
      delete _railChatsBtn.dataset.targetSession;
      _syncRailDynamic();
    });
  }

  // 图标栏文档按钮 — 切换文档面板开关（非资料库）
  const _railDocsBtn = el('rail-documents');
  if (_railDocsBtn) {
    _railDocsBtn.addEventListener('click', () => {
      const ob = el('overflow-doc-btn');
      if (ob) ob.click();
    });
  }

  // 图标栏：设置按钮
  const _railSettings = el('rail-settings');
  if (_railSettings) {
    _railSettings.addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      if (sidebar) sidebar.classList.remove('hidden');
      syncRailSide();
      // 滚动到底部，设置项通常在那里
      const sidebarInner = document.querySelector('.sidebar-inner');
      if (sidebarInner) sidebarInner.scrollTo({ top: sidebarInner.scrollHeight, behavior: 'smooth' });
    });
  }

  // 图标栏：管理按钮
  const _railAdmin = el('rail-admin');
  if (_railAdmin) {
    _railAdmin.addEventListener('click', () => {
      // 尝试打开管理模态框
      const adminBtn = document.querySelector('[data-modal="admin-modal"]') || el('tool-admin-btn');
      if (adminBtn) adminBtn.click();
    });
  }

  // 同步上下文图标栏图标。工具启动器（日历/对比/技能手册/
  // 研究/图库/任务/归档/记忆/笔记/主题/邮件）现在是始终可见的启动器，
  // 因此只有文档和后台聊天指示器在此处动态显示/隐藏。
  function _syncRailDynamic() {
    // 如果面板已打开或会话有文档则显示文档图标
    const docPanelOpen = window.documentModule && window.documentModule.isPanelOpen();
    const docIndicator = el('doc-indicator-btn');
    const hasDocs = docIndicator && docIndicator.classList.contains('visible');
    const docOpen = docPanelOpen || hasDocs;
    const hasChatNotif = el('rail-chats')?.classList.contains('rail-notify');

    const _show = (id, visible) => { const b = el(id); if (b) b.style.display = visible ? '' : 'none'; };
    _show('rail-documents', docOpen);
    _show('rail-chats', !!hasChatNotif);
  }
  window._syncRailDynamic = _syncRailDynamic;
  // 定期同步并在关键事件时同步
  setInterval(_syncRailDynamic, 1000);
  document.addEventListener('overflow-state-change', _syncRailDynamic);

  const sidebarSearchBtn = el('sidebar-search-btn');
  if (sidebarSearchBtn) {
    sidebarSearchBtn.addEventListener('click', () => {
      if (searchChatModule) searchChatModule.openSearch();
    });
  }
  // 修改表单提交以处理特殊模式
  const chatForm = document.getElementById('chat-form');
  const originalSubmit = chatModule.handleChatSubmit;
  let _submitting = false;

  function handleSubmit(e) {
    if (e) e.preventDefault();
    // 防抖：防止在请求发起期间重复提交
    if (_submitting) return;
    _submitting = true;
    // 短暂延迟后释放（流启动时会设置自己的 isStreaming 守卫）
    setTimeout(() => { _submitting = false; }, 300);

    // 对比模式：路由提交到对比处理器（相同消息发送到所有窗格）
    if (compareModule && compareModule.isActive()) {
      return compareModule.handleCompareSubmit(e);
    }

    // 群聊：路由到群组模块
    if (groupModule && groupModule.isActive()) {
      console.log('[group] Submit intercepted');
      const msgInput = document.getElementById('message');
      const msg = msgInput ? msgInput.value.trim() : '';
      if (!msg) { console.log('[group] Empty message, skipping'); return; }
      console.log('[group] Sending:', msg);
      chatRenderer.hideWelcomeScreen();
      chatRenderer.addMessage('user', msg);
      msgInput.value = '';
      groupModule.sendMessage(msg);
      return;
    }

    return originalSubmit.call(chatModule, e);
  }

  chatForm.onsubmit = handleSubmit;

  // ── 双用途发送/麦克风按钮 ──
  const sendBtn = document.querySelector('.send-btn');
  const messageInput = el('message');
  const modelPickerWrap = document.getElementById('model-picker-wrap');

  const _sendIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const _micIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
  const _stopIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  const _newChatIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  // 全局暴露图标，使 chat.js 的 updateSubmitButton 可使用
  window._odysseusBtnIcons = { send: _sendIcon, mic: _micIcon, stop: _stopIcon, newChat: _newChatIcon };

  function _isSttEnabled() {
    return voiceRecorderModule._sttProvider && voiceRecorderModule._sttProvider !== 'disabled';
  }

  function _hasAttachments() {
    return fileHandlerModule.getPendingCount && fileHandlerModule.getPendingCount() > 0;
  }

  function _updateSendBtnIcon() {
    if (!sendBtn) return;
    // 流式传输中（停止按钮）或录音时不要覆盖
    if (sendBtn.dataset.mode === 'streaming' || sendBtn.dataset.mode === 'recording') return;
    const prevMode = sendBtn.dataset.mode || '';
    const hasText = messageInput && messageInput.value.trim().length > 0;
    const hasFiles = _hasAttachments();
    let newMode;
    if (!hasText && !hasFiles && _isSttEnabled()) {
      clearTimeout(sendBtn._collapseTimer);
      sendBtn.innerHTML = _micIcon;
      sendBtn.title = i18nModule.t('chat.record_voice');
      newMode = 'mic';
      sendBtn.classList.add('mic-mode');
      sendBtn.classList.remove('newchat-mode', 'newchat-expanded');
    } else if (!hasText && !hasFiles && !_isSttEnabled()) {
      clearTimeout(sendBtn._collapseTimer);
      // 群聊：始终显示发送按钮，不进入新聊天模式
      if (groupModule && groupModule.isActive()) {
        sendBtn.innerHTML = _sendIcon;
        sendBtn.title = i18nModule.t('chat.send_to_group');
        newMode = 'idle';
        sendBtn.classList.remove('mic-mode', 'newchat-mode', 'newchat-expanded');
      } else {
      // 检查是否已处于新的空白会话（欢迎屏幕可见）
      const isEmptySession = document.getElementById('chat-container')?.classList.contains('welcome-active');
      if (isEmptySession) {
        // 已是新聊天 — 以静音样式显示箭头（准备输入）
        sendBtn.innerHTML = _sendIcon;
        sendBtn.title = i18nModule.t('chat.send_button');
        newMode = 'idle';
        sendBtn.classList.add('newchat-mode'); // 静音灰色样式
        sendBtn.classList.remove('mic-mode', 'newchat-expanded');
        clearTimeout(sendBtn._expandTimer);
      } else {
        sendBtn.innerHTML = _newChatIcon + '<span class="send-btn-label">+ ' + i18nModule.t('chat.new_chat') + '</span>';
        sendBtn.title = i18nModule.t('chat.new_chat');
        newMode = 'newchat';
        sendBtn.classList.add('newchat-mode');
        sendBtn.classList.remove('mic-mode');
        // 按钮保持 32px 紧凑图标（不自动展开为标签 —
        // 内部的"新建"标签仅供屏幕阅读器使用；可视用户
        // 在悬停时看到旋转的 + 和标题提示）。
        clearTimeout(sendBtn._expandTimer);
        sendBtn.classList.remove('newchat-expanded');
      }
      } // 关闭 group-else 分支
    } else {
      newMode = 'send';
      clearTimeout(sendBtn._expandTimer);
      const wasExpanded = sendBtn.classList.contains('newchat-expanded');
      const wasNewchat = prevMode === 'newchat' || prevMode === 'mic';
      if (wasExpanded || wasNewchat) {
        // 如果已展开则收起胶囊按钮，然后旋入箭头（与 + 旋入相同）
        if (wasExpanded) sendBtn.classList.remove('newchat-expanded');
        const delay = wasExpanded ? 300 : 0;
        setTimeout(() => {
          if (sendBtn.dataset.mode !== 'send') return;
          sendBtn.innerHTML = _sendIcon;
          sendBtn.title = i18nModule.t('chat.send_button');
          sendBtn.classList.remove('mic-mode', 'newchat-mode', 'anim-spin-swap');
          sendBtn.classList.add('anim-spin');
          sendBtn.addEventListener('animationend', () => sendBtn.classList.remove('anim-spin'), { once: true });
        }, delay);
      } else {
        sendBtn.innerHTML = _sendIcon;
        sendBtn.title = i18nModule.t('chat.send_button');
        sendBtn.classList.remove('mic-mode', 'newchat-mode', 'newchat-expanded', 'anim-spin', 'anim-launch', 'anim-land');
      }
    }
    // 图标旋转动画 — 切换 TO 新聊天或麦克风时
    // 出现时）。之前的 `prevMode && ...` 守卫在流结束后
    // 跳过了此动画（dataset.mode 在那里被重置为 ''，空 falsy
    // 字符串），导致停止图标的残留 anim-land 类
    // 在 + 上重播，使 + 看起来从下方出现。
    // 不要对发送模式（箭头）使用动画 — 应直接显示。
    if (newMode !== prevMode && (newMode === 'newchat' || newMode === 'mic')) {
      if (!sendBtn.classList.contains('anim-spin')) {
        sendBtn.classList.remove('anim-launch', 'anim-land');
        sendBtn.classList.add('anim-spin');
        sendBtn.addEventListener('animationend', () => sendBtn.classList.remove('anim-spin'), { once: true });
      }
    }
    sendBtn.dataset.mode = newMode;
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();

      // 如果正在录音，停止录音
      if (sendBtn.dataset.mode === 'recording' || voiceRecorderModule.getIsRecording()) {
        voiceRecorderModule.stopRecording();
        return;
      }

      const hasText = messageInput && messageInput.value.trim().length > 0;
      const hasFiles = _hasAttachments();

      // 新聊天模式 — 空输入、无附件、无语音
      if (!hasText && !hasFiles && sendBtn.dataset.mode === 'newchat') {
        if (sessionModule) {
          const sessions = sessionModule.getSessions();
          const currentId = sessionModule.getCurrentSessionId();
          const current = sessions.find(s => s.id === currentId);
          if (current && current.endpoint_url && current.model) {
            sessionModule.createDirectChat(current.endpoint_url, current.model, current.endpoint_id);
          } else {
            // 回退到图标栏按钮
            const railNew = el('rail-new-session');
            if (railNew) railNew.click();
          }
        }
        return;
      }

      // 如果输入为空且语音转文本已启用，开始录音
      if (!hasText && !hasFiles && _isSttEnabled()) {
        sendBtn.innerHTML = _stopIcon;
        sendBtn.title = i18nModule.t('chat.stop_recording');
        sendBtn.dataset.mode = 'recording';
        sendBtn.classList.add('recording');
        voiceRecorderModule.startRecording(
          (audioFile) => fileHandlerModule.addFiles([audioFile]),
          uiModule.showToast,
          uiModule.showError
        );
        return;
      }

      // 否则，发送消息
      handleSubmit(e);
    });
  }

  // Enter 发送（Shift+Enter 换行），或空输入时新建聊天
  if (messageInput) {
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        // 刷新防抖图标更新，使 dataset.mode 反映当前
        // 文本状态。没有这个，快速输入并回车仍会看到
        // 过时的 'newchat' 模式并打开新聊天而非发送。
        try { _updateSendBtnIcon(); } catch {}
        if (sendBtn && sendBtn.dataset.mode === 'newchat') {
          const railNew = el('rail-new-session');
          if (railNew) railNew.click();
          return;
        }
        handleSubmit(e);
      }
    });
  }

  // 输入变化时切换麦克风/发送图标 + 文本足够后隐藏模型选择器
  if (messageInput) {
    const _debouncedUpdateIcon = uiModule.debounce(_updateSendBtnIcon, 50);
    const _MODEL_PICKER_HIDE_CHARS = 10;
    const _syncModelPickerAutohide = () => {
      const hidePicker = (messageInput.value || '').replace(/\s/g, '').length >= _MODEL_PICKER_HIDE_CHARS;
      if (modelPickerWrap) {
        modelPickerWrap.classList.toggle('model-picker-autohide', hidePicker);
      }
    };
    window._syncModelPickerAutohide = _syncModelPickerAutohide;
    _syncModelPickerAutohide();
    messageInput.addEventListener('input', () => {
      _syncModelPickerAutohide();
      _debouncedUpdateIcon();
    }, { passive: true });
  }

  // 滚动时折叠"新建会话"标签
  const _chatScroll = document.getElementById('chat-container');
  if (_chatScroll && sendBtn) {
    _chatScroll.addEventListener('scroll', () => {
      if (sendBtn.classList.contains('newchat-expanded')) {
        sendBtn.classList.remove('newchat-expanded');
      }
    }, { passive: true });
  }

  // 全局暴露，使 voiceRecorder 可在异步获取后触发更新
  window._updateSendBtnIcon = _updateSendBtnIcon;

  // 初始图标状态
  _updateSendBtnIcon();

  // 页面加载时自动聚焦输入框
  if (messageInput) {
    setTimeout(() => messageInput.focus(), 100);
  }

  // 为聊天容器添加拖放处理
  const chatContainer = el('chat-container');

  // 阻止默认行为以允许放置
  const chatInputBar = chatContainer.querySelector('.chat-input-bar');
  function _showDropHighlight() {
    chatContainer.style.backgroundColor = 'rgba(0, 170, 255, 0.1)';
    chatContainer.style.transition = 'background-color 0.2s ease';
    if (chatInputBar) {
      chatInputBar.style.outline = '2px dashed color-mix(in srgb, var(--accent, #0af) 50%, transparent)';
      chatInputBar.style.outlineOffset = '-2px';
      chatInputBar.style.background = 'color-mix(in srgb, var(--accent, #0af) 8%, var(--bg))';
      chatInputBar.style.transition = 'outline 0.2s ease, background 0.2s ease';
    }
  }
  function _hideDropHighlight() {
    chatContainer.style.backgroundColor = '';
    if (chatInputBar) {
      chatInputBar.style.outline = '';
      chatInputBar.style.outlineOffset = '';
      chatInputBar.style.background = '';
    }
  }

  chatContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    _showDropHighlight();
  });

  chatContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    _hideDropHighlight();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    fileHandlerModule.addFiles(files);
    fileHandlerModule.renderAttachStrip();
    uiModule.showToast(i18nModule.t(files.length === 1 ? 'notification.added_file_to_chat' : 'notification.added_files_to_chat', { count: files.length }));
  });

  chatContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    _hideDropHighlight();
  });
  
  // 使附件条也成为一个放置目标
  const attachStrip = el('attach-strip');
  attachStrip.addEventListener('dragover', (e) => {
    e.preventDefault();
    attachStrip.style.backgroundColor = 'rgba(0, 170, 255, 0.1)';
    attachStrip.style.borderRadius = '4px';
  });
  
  attachStrip.addEventListener('drop', (e) => {
    e.preventDefault();
    attachStrip.style.backgroundColor = '';
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    uiModule.showToast(i18nModule.t(files.length === 1 ? 'notification.added_file_to_chat' : 'notification.added_files_to_chat', { count: files.length }));

  });
  
  attachStrip.addEventListener('dragleave', (e) => {
    e.preventDefault();
    attachStrip.style.backgroundColor = '';
  });

  // ── 对比模式文件拖放防护层 ──────────────────────────────────────────
  // 对比模式复用 #chat-container，但每个窗格渲染到独立的
  // <iframe>。Iframe 会吞掉拖放事件：拖到面板上的文件会被
  // iframe 处理而非父页面，因此浏览器会在面板内部加载该文件
  // （在应用"背后"）而不是附加它。chatContainer 的拖放
  // 处理器看不到它，因为事件不会冒泡出框架。
  //
  // 修复：对比模式下拖拽文件时，升起一个全窗口遮罩层
  // 坐在每个面板/iframe 上方并成为拖放目标。拖放操作
  // 落在父文档上，我们将文件路由到共享的输入栏
  // （与文件选择器和粘贴相同的待处理文件管道）。通过
  // .compare-active 类限定范围，因此普通聊天和工具拖放区（画廊、
  // RAG、文档编辑器等）不受影响。
  let _cmpDropShield = null;
  const _isFileDrag = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
  };
  const _compareActive = () => {
    const c = el('chat-container');
    return !!c && c.classList.contains('compare-active');
  };
  const _showCmpShield = () => {
    if (!_cmpDropShield) {
      _cmpDropShield = document.createElement('div');
      _cmpDropShield.id = 'compare-drop-shield';
      _cmpDropShield.setAttribute('aria-hidden', 'true');
      _cmpDropShield.style.cssText = 'position:fixed;inset:0;z-index:2147483646;' +
        'display:none;align-items:center;justify-content:center;' +
        'background:color-mix(in srgb, var(--accent, #0af) 16%, rgba(0,0,0,0.5));' +
        'backdrop-filter:blur(2px);';
      const _box = document.createElement('div');
      _box.style.cssText = 'pointer-events:none;border:2px dashed rgba(255,255,255,0.9);' +
        'border-radius:14px;padding:20px 28px;background:rgba(0,0,0,0.4);' +
        'font:600 16px/1.4 system-ui,sans-serif;color:#fff;';
      _box.textContent = i18nModule.t('export.drop_files');
      _cmpDropShield.appendChild(_box);
      document.body.appendChild(_cmpDropShield);
    }
    _cmpDropShield.style.display = 'flex';
  };
  const _hideCmpShield = () => { if (_cmpDropShield) _cmpDropShield.style.display = 'none'; };
  // 使用捕获阶段，在指针到达 iframe 之前升起遮罩。
  window.addEventListener('dragenter', (e) => {
    if (_isFileDrag(e) && _compareActive()) _showCmpShield();
  }, true);
  window.addEventListener('dragover', (e) => {
    if (!_isFileDrag(e) || !_compareActive()) return;
    e.preventDefault();                       // 标记为有效的放置目标
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    _showCmpShield();
  }, true);
  window.addEventListener('dragleave', (e) => {
    // 仅当拖拽真正离开窗口时才隐藏（无 relatedTarget）。
    if (_compareActive() && !e.relatedTarget) _hideCmpShield();
  }, true);
  window.addEventListener('dragend', _hideCmpShield, true);
  window.addEventListener('drop', (e) => {
    if (!_isFileDrag(e) || !_compareActive()) return;
    e.preventDefault();
    _hideCmpShield();
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    fileHandlerModule.addFiles(files);
    fileHandlerModule.renderAttachStrip();
    uiModule.showToast(i18nModule.t(files.length === 1 ? 'notification.added_file_to_attach' : 'notification.added_files_to_attach', { count: files.length }));
  }, true);

  // 加载初始数据
  presetsModule.loadPresets(uiModule.showError);

  if (sessionModule) {
    sessionModule.initDependencies({
      API_BASE: API_BASE,
      el: el,
      showToast: uiModule.showToast,
      showError: uiModule.showError,
      addMessage: chatModule.addMessage,
      renderContent: markdownModule.renderContent,
      scrollHistory: uiModule.scrollHistoryInstant
    });

    // 首先加载会话（关键路径）— 完成后移除加载器
    sessionModule.loadSessions()
      .catch(e => console.warn('loadSessions error:', e))
      .finally(() => {
        const loader = document.getElementById('app-loader');
        if (loader) { loader.style.opacity = '0'; setTimeout(() => loader.remove(), 300); }
        // 现在会话和模块接线已就绪，触发 URL 路由开启
        // 就绪。正是因为这个原因从初始化顶部延迟。
        if (window._odysseusRouteOpener) {
          try { window._odysseusRouteOpener(); } catch (_) {}
          window._odysseusRouteOpener = null;
        }
      });
  } else {
    console.error('Session module not loaded!');
  }

  // 非关键：并行加载，静默解决
  modelsModule.refreshModels(true).then(() => {
    const modelsBox = document.getElementById('models');
    const hasModels = modelsBox && modelsBox.querySelector('.models-row');
    if (!hasModels) {
      const tip = document.getElementById('welcome-tip');
      if (tip) tip.textContent = i18nModule.t('chat.no_config_tip');
    }
  }).catch(() => {});
  modelsModule.refreshProviders();
  ragModule.loadPersonalDocs();
  memoryModule.loadMemories(); // 确保页面加载时加载记忆
  
  // 确保记忆列表在加载后渲染
  setTimeout(async () => {
    await memoryModule.loadMemories();
  }, 1000);
  
  // 确保正确的初始状态
  voiceRecorderModule.init();
  if (censorModule) censorModule.init();

  // 页面加载时自动聚焦消息输入框
  const msgEl = document.getElementById('message');
  if (msgEl) msgEl.focus();
  
  // 初始化侧边栏区域的鼠标拖拽
  const sidebar = document.getElementById('sidebar');
  const sidebarInner = sidebar ? sidebar.querySelector('.sidebar-inner') : sidebar;

  // ── 侧边栏的微妙弹性过度滚动 ──
  if (sidebarInner) {
    const MAX_PULL = 8;
    let _overscroll = 0;
    let _resetTimer = null;
    sidebarInner.addEventListener('wheel', (e) => {
      const el = sidebarInner;
      const atTop = el.scrollTop <= 0 && e.deltaY < 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atBottom) { _overscroll = 0; return; }
      // 累积过度滚动（递减效率）
      _overscroll += Math.abs(e.deltaY) * 0.15;
      const pull = Math.min(_overscroll, MAX_PULL);
      const dir = atTop ? 1 : -1;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dir * pull}px)`;
      // 滚动停止后重置
      clearTimeout(_resetTimer);
      _resetTimer = setTimeout(() => {
        el.style.transition = 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)';
        el.style.transform = '';
        _overscroll = 0;
      }, 120);
    }, { passive: true });
  }

  // ── 侧边栏的全局触摸滚动守卫 ──
  // 用户滚动时（手指移动）抑制点击事件。
  // 防止滑动时意外选择会话/模型/设置。
  if (sidebarInner && 'ontouchstart' in window) {
    let _sidebarTouchMoved = false;
    let _sidebarTouchStartY = 0;
    sidebarInner.addEventListener('touchstart', (e) => {
      _sidebarTouchMoved = false;
      _sidebarTouchStartY = e.touches[0].clientY;
    }, { passive: true });
    sidebarInner.addEventListener('touchmove', (e) => {
      // 仅当手指垂直移动超过 8px 时才标记为滚动
      if (Math.abs(e.touches[0].clientY - _sidebarTouchStartY) > 8) {
        _sidebarTouchMoved = true;
      }
    }, { passive: true });
    sidebarInner.addEventListener('click', (e) => {
      if (_sidebarTouchMoved) {
        e.stopPropagation();
        e.preventDefault();
        _sidebarTouchMoved = false;
      }
    }, true); // 捕获阶段 — 在任何子处理器之前拦截
  }

  // 区域折叠/展开 + 拖拽排序（提取到 js/section-management.js）
  initSectionCollapse(Storage);
  initSectionDrag(Storage, loadUIVis);
  
  // 处理单个区域的拖入和拖出
  const sections = document.querySelectorAll('.section[draggable="true"]');
  sections.forEach(section => {
    section.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      
      // 仅在未拖到活动元素上时显示视觉反馈
      const activeId = e.dataTransfer.getData('text/plain');
      if (activeId && activeId !== section.id) {
        section.setAttribute('dnd-over', 'true');
      }
    });
    
    section.addEventListener('dragleave', (e) => {
      // 检查是否真正离开该元素
      const rect = section.getBoundingClientRect();
      if (e.clientY < rect.top || e.clientY > rect.bottom || 
          e.clientX < rect.left || e.clientX > rect.right) {
        section.setAttribute('dnd-over', 'false');
      }
    });
  });
  
  // 页面加载时恢复保存的顺序
  const savedOrder = Storage.get(Storage.KEYS.SECTION_ORDER);
  if (savedOrder) {
    try {
      const order = JSON.parse(savedOrder);
      const innerContainer = sidebarInner || document.getElementById('sidebar');

      // 创建文档片段以最小化重排
      const fragment = document.createDocumentFragment();

      // 首先，按期望顺序收集所有区域
      for (const id of order) {
        const section = document.getElementById(id);
        if (section) {
          fragment.appendChild(section);
        }
      }

      // 追加任何剩余区域（以防新增）
      sections.forEach(section => {
        if (!order.includes(section.id)) {
          fragment.appendChild(section);
        }
      });

      // 最后，将所有区域添加回容器
      innerContainer.appendChild(fragment);
    } catch (e) {
      console.error('Failed to restore sidebar order:', e);
    }
  }
  


  if (window.hljs) {
    console.log('Highlighting all code blocks on page load');
    document.querySelectorAll('pre code:not(.hljs)').forEach(block => {
      window.hljs.highlightElement(block);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startOdysseusApp, { once: true });
} else {
  startOdysseusApp();
}
