// static/js/document.js — 文档编辑器模块
/**
 * 文档编辑器模块 — 聊天旁边的多文档标签面板。
 * 支持多个打开文档的标签切换、每个文档独立状态，
 * 以及主题感知样式。
 */


import uiModule from './ui.js';
import sessionModule from './sessions.js';
import emojiPicker from './emojiPicker.js';
import markdownModule from './markdown.js';
import codeRunnerModule from './codeRunner.js';
import { langIcon } from './langIcons.js';
import spinnerModule from './spinner.js';
import { openLibrary, closeLibrary, isLibraryOpen, initLibrary } from './documentLibrary.js';
import signatureModule from './signature.js';
import * as Modals from './modalManager.js';
import { t } from './i18n.js';

  let API_BASE = '';
  let isOpen = false;
  let _hlDebounce = null;
  let _isEditingTabTitle = false;
  let _autoDetectDebounce = null;
  let _autoTitleDebounce = null;
  let _autoSaveDebounce = null;
  let _animationInProgress = false;
  let _animationCancel = null;      // 取消当前动画的函数
  let _htmlPreviewActive = false;   // 内联 HTML 预览 iframe 显示时为 true
  let _emailAccountsCache = null;
  let _emailAccountsCacheAt = 0;
  let _emailHeaderManualExpandUntil = 0;

  // 差异模式状态
  let _diffModeActive = false;
  let _diffOldContent = null;
  let _diffNewContent = null;
  let _diffChunks = [];          // [{id, oldLines, newLines, startLine, resolved, accepted}]
  let _diffUnresolvedCount = 0;

  // 语言自动检测配置
  const AUTO_DETECT_DELAY = 500;
  const AUTO_DETECT_MIN_CHARS = 30;
  const AUTO_DETECT_MIN_RELEVANCE = 8;
  const AUTO_DETECT_SAMPLE_SIZE = 2000;
  const HLJS_TO_DROPDOWN = {
    python: 'python', javascript: 'javascript', typescript: 'typescript',
    xml: 'html', html: 'html', css: 'css', markdown: 'markdown',
    json: 'json', yaml: 'yaml', bash: 'bash', shell: 'bash',
    sql: 'sql', rust: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
    csv: 'csv',
  };

  // 在沙盒预览 iframe 中渲染的语言。SVG和XML标记
  // 作为 HTML 文档中的内联内容渲染，因此它们共享 HTML
  // "Run / Preview" 路径。（hljs 已将检测到的 `xml` 映射为 `html`；这也
  // 覆盖了文档被显式指定为 svg/xml 的情况。）
  const _isRenderLang = (l) => ['html', 'svg', 'xml'].includes((l || '').toLowerCase());
  // 在工具栏中获得分段 Code / Run-or-View 切换的语言
  // （与 markdown 的 Edit / Preview 切换相同的用户体验）。CSV 的"run"视图是
  // 表格；Python/JS 等是代码运行输出；HTML/SVG/XML 通过
  // iframe 预览渲染。
  const _hasViewToggle = (l) => {
    const lang = (l || '').toLowerCase();
    return [
      'csv', 'python', 'javascript', 'typescript', 'bash', 'sh', 'shell',
      'php', 'ruby', 'sql', 'java', 'go', 'rust',
      'c', 'cpp', 'c++', 'csharp', 'c#',
      'yaml', 'json', 'css',
      'ini', 'toml',
    ].includes(lang) || _isRenderLang(lang);
  };

  async function _getEmailAccountsCached() {
    const now = Date.now();
    if (_emailAccountsCache && (now - _emailAccountsCacheAt) < 30000) return _emailAccountsCache;
    try {
      const res = await fetch(`${API_BASE}/api/email/accounts`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('accounts failed');
      const data = await res.json();
      _emailAccountsCache = Array.isArray(data.accounts) ? data.accounts : [];
    } catch (_) {
      _emailAccountsCache = [];
    }
    _emailAccountsCacheAt = now;
    return _emailAccountsCache;
  }

  function _accountCanSend(account) {
    return !!(account && account.smtp_host && account.smtp_user && account.has_smtp_password);
  }

  async function _resolveComposeSendAccountId() {
    const activeAccountId = window.__odysseusActiveEmailAccount || null;
    if (!activeAccountId) return null;
    const accounts = await _getEmailAccountsCached();
    const activeAccount = accounts.find(a => String(a.id) === String(activeAccountId));
    if (!activeAccount || _accountCanSend(activeAccount)) return activeAccountId;
    if (uiModule) uiModule.showToast(t('document.email_receive_only_warning'));
    return null;
  }

  // 立即注入标签菜单样式（必须在任何悬停之前存在）
  {
    const s = document.createElement('style');
    s.id = 'doc-tab-menu-styles';
    s.textContent = `.doc-tab-menu-btn{background:none!important;border:none!important;outline:none!important;box-shadow:none!important;color:var(--fg);opacity:0.25;cursor:pointer;padding:2px 4px!important;height:auto!important;line-height:1;transition:opacity .15s;flex-shrink:0;-webkit-appearance:none;appearance:none}.doc-tab-menu-btn:focus,.doc-tab-menu-btn:active{outline:none!important;box-shadow:none!important;background:none!important}.doc-tab:hover .doc-tab-menu-btn{opacity:.5}.doc-tab-menu-btn:hover{opacity:1!important}.doc-tab-dropdown .dropdown-item-compact{padding:6px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;border-bottom:none;display:flex;align-items:center;gap:10px;font-size:11px}.doc-tab-dropdown .dropdown-item-compact:hover{background:color-mix(in srgb,var(--fg) 8%,transparent)}.doc-tab-dropdown .dropdown-item-compact .dropdown-icon{width:14px;height:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;opacity:0.5}.doc-tab-dropdown .dropdown-divider{height:1px;margin:3px 0;background:color-mix(in srgb,var(--border) 40%,transparent)}.doc-tab-action-delete{color:var(--red,#e06c75)!important}.doc-tab-action-delete .dropdown-icon{opacity:0.7!important}`;
    document.head.appendChild(s);
  }

  // 多文档状态
  let activeDocId = null;           // 当前可见的文档
  let _lastSessionId = '';          // "+" 按钮的会话上下文
  const docs = new Map();           // docId -> { id, title, language, content, version, sessionId }

  const _docOpenKey = (sessionId) => 'odysseus-doc-open-' + sessionId;
  const _docMinimizedKey = (sessionId) => 'odysseus-doc-minimized-' + sessionId;

  function _markDocVisibleState(sessionId, state) {
    if (!sessionId) return;
    if (state === 'open') {
      localStorage.setItem(_docOpenKey(sessionId), '1');
      localStorage.removeItem(_docMinimizedKey(sessionId));
    } else if (state === 'minimized') {
      localStorage.removeItem(_docOpenKey(sessionId));
      localStorage.setItem(_docMinimizedKey(sessionId), '1');
    } else {
      localStorage.removeItem(_docOpenKey(sessionId));
      localStorage.removeItem(_docMinimizedKey(sessionId));
    }
  }

  /** 如果尚未切换，将聊天切换到 agent 模式 */
  function _ensureAgentMode() {
    const ab = document.getElementById('mode-agent-btn');
    const cb = document.getElementById('mode-chat-btn');
    if (ab && !ab.classList.contains('active')) {
      ab.click();
    }
  }

  export function init(apiBase) {
    API_BASE = apiBase;
    initLibrary({
      apiBase,
      esc: _esc,
      getDocs: () => docs,
      isOpen: () => isOpen,
      createDocument,
      loadDocument,
      switchToDoc,
      openPanel,
      addDocToTabs,
      syncDocIndicator: _syncDocIndicator,
    });
    _maybeOpenDocFromHash();
    window.addEventListener('hashchange', _maybeOpenDocFromHash);
  }

  /** 更新 overflow-doc-btn 强调指示器、工具栏指示器和会话列表图标 */
  function _syncDocIndicator() {
    const btn = document.getElementById('overflow-doc-btn');
    // 有文档 = 映射中至少有一个非空文档
    const hasDocs = docs.size > 0;
    if (btn) btn.classList.toggle('has-docs', hasDocs);
    // 当文档存在时显示/隐藏工具栏文档指示器
    const indicator = document.getElementById('doc-indicator-btn');
    if (indicator) indicator.classList.toggle('visible', hasDocs);
    // 当指示器在外面显示时隐藏溢出菜单项
    if (btn) btn.style.display = hasDocs ? 'none' : '';
    // 更新会话列表图标
    const sid = sessionModule?.getCurrentSessionId();
    if (sid && sessionModule.setSessionHasDocs) {
      sessionModule.setSessionHasDocs(sid, hasDocs);
    }
  }

  // ---- 标签栏渲染 ----

  function updateArrowVisibility(scrollArea, leftBtn, rightBtn) {
    const atLeft = scrollArea.scrollLeft <= 0;
    const atRight = scrollArea.scrollLeft + scrollArea.clientWidth >= scrollArea.scrollWidth - 1;
    leftBtn.style.display = atLeft ? 'none' : '';
    rightBtn.style.display = atRight ? 'none' : '';
// 切换边缘遮罩类，使渐变在对端无可滚动内容时变为平面——
// 否则即使没有箭头显示，左右渐变也会呈现为永久阴影。
//
    scrollArea.classList.toggle('is-at-left', atLeft);
    scrollArea.classList.toggle('is-at-right', atRight);
  }

  // 移动端下滑关闭文档面板。镜像了 ui.js 中的共享底栏手势
  // （手指跟随拖动、速度感知关闭、向上拖动弹性效果
  // 弹簧回弹）使其与其他窗口感觉一致 —
  // 但通过文档面板自己的 closePanel() 生命周期来关闭。
  function _wireSwipeDismiss(el) {
    if (!el) return;
    const DISMISS_THRESHOLD = 50;    // 像素
    const VELOCITY_THRESHOLD = 0.3;  // 像素/毫秒 — 快速滑动可在低于阈值时关闭
    const RUBBER_RESISTANCE = 0.35;  // 向上拖动超过原点时的阻力
    let startY = 0, startX = 0, lastY = 0, lastT = 0, velocity = 0;
    let dragging = false, cancelled = false;
    const getPane = () => document.getElementById('doc-editor-pane');
    let pane = null;

    el.addEventListener('touchstart', (e) => {
      if (window.innerWidth > 768 || e.touches.length !== 1) return;
      pane = getPane();
      if (!pane) return;
      const t = e.touches[0];
      startY = t.clientY; startX = t.clientX; lastY = startY; lastT = e.timeStamp;
      velocity = 0; dragging = false; cancelled = false;
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (cancelled || !pane || window.innerWidth > 768) return;
      const t = e.touches[0];
      const dx = Math.abs(t.clientX - startX);
      const dy = t.clientY - startY;
      if (!dragging) {
        if (dx > 40 && dx > Math.abs(dy) * 2) { cancelled = true; return; } // horizontal → tab scroll
        if (Math.abs(dy) > 8) {
          dragging = true;
// 清除打开动画——否则其 `both` fill-mode 会锁定
// transform 并覆盖我们的行内手指跟随 transform。
          pane.style.animation = 'none';
          pane.style.transition = 'none';
          pane.style.willChange = 'transform';
        } else return;
      }
      const dt = e.timeStamp - lastT;
      if (dt > 0) velocity = velocity * 0.6 + ((t.clientY - lastY) / dt) * 0.4;
      lastY = t.clientY; lastT = e.timeStamp;
      e.preventDefault();
      pane.style.transform = dy > 0 ? `translateY(${dy}px)` : `translateY(${dy * RUBBER_RESISTANCE}px)`;
    }, { passive: false });

    const endSwipe = () => {
      if (!dragging || !pane) { pane = null; return; }
      const p = pane; pane = null; dragging = false;
      p.style.willChange = '';
      const dy = lastY - startY;
      const shouldDismiss = dy > DISMISS_THRESHOLD || (dy > 20 && velocity > VELOCITY_THRESHOLD);
      if (shouldDismiss) {
        closePanel('down');
      } else {
        p.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.9, 0.3, 1.05)';
        p.style.transform = '';
        setTimeout(() => { p.style.transition = ''; }, 260);
      }
    };
    el.addEventListener('touchend', endSwipe, { passive: true });
    el.addEventListener('touchcancel', endSwipe, { passive: true });
  }

  function renderTabs() {
    if (_isEditingTabTitle) return;  // Don't rebuild while editing a title
    const tabBar = document.getElementById('doc-tab-bar');
    if (!tabBar) return;

    // 使用滚动箭头构建标签 HTML
    // 当文档面板在右侧（默认）时，+ 在最左侧；在左侧时，+ 在滚动区域内
    const paneEl = document.querySelector('.doc-editor-pane');
    const isDocLeft = paneEl && paneEl.classList.contains('doc-left');
    let html = '';
    html += `<button class="doc-tab-arrow doc-tab-arrow-left" id="doc-tab-left" title="${t('document.scroll_left')}">&#x2039;</button>`;
    html += '<div class="doc-tab-scroll" id="doc-tab-scroll">';
    const curSession = sessionModule?.getCurrentSessionId() || '';
    let _anyTab = false;
    for (const [id, doc] of docs) {
// 仅显示当前会话的标签页
      if (doc.sessionId && curSession && doc.sessionId !== curSession) continue;
      _anyTab = true;
      const isActive = id === activeDocId;
      const title = doc.title || t('document.untitled');
      const shortTitle = title.length > 24 ? title.slice(0, 22) + '...' : title;
      const menuBtn = `<button class="doc-tab-menu-btn" data-doc-id="${id}" title="${t('document.tab_actions')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="19" r="2.5"/></svg></button>`;
      const ver = doc.version || doc.version_count || 1;
      const verChip = `<span class="doc-tab-version" data-doc-id="${id}" title="${t('document.tab_version_history')}">v${ver}</span>`;
      // 标题前的语言图标 — 与元行/选择器同族
      // 图标。当文档没有有用语言时通过 :empty CSS 隐藏。
      const lic = (doc.language && doc.language !== 'text')
        ? langIcon(doc.language, 12, { style: 'opacity:0.65;flex-shrink:0;color:currentColor;margin-right:4px;' })
        : '';
      const langChip = `<span class="doc-tab-lang">${lic}</span>`;
      html += `<div class="doc-tab${isActive ? ' active' : ''}" draggable="true" data-doc-id="${id}" title="${title}">
        ${verChip}${langChip}<span class="doc-tab-title">${shortTitle}</span>
        <button class="doc-tab-close" data-doc-id="${id}" title="${t('document.tab_unlink')}">&times;</button>
      </div>`;
    }
// 空状态（面板已打开，尚无文档）：显示一个幽灵"未命名"标签页，
// 使用户清楚处于新文档状态而非面对空白面板。
    if (!_anyTab && isOpen && !activeDocId) {
      html += `<div class="doc-tab active doc-tab-ghost" title="${t('document.tab_new_hint')}"><span class="doc-tab-title">${t('document.untitled')}</span></div>`;
    }
    html += `<button class="doc-tab-new" id="doc-tab-new-btn" title="${t('document.tab_new')}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>`;
    html += '</div>';
    html += `<button class="doc-tab-arrow doc-tab-arrow-right" id="doc-tab-right" title="${t('document.scroll_right')}">&#x203A;</button>`;
    tabBar.innerHTML = html;

// 绑定滚动箭头
    const scrollArea = document.getElementById('doc-tab-scroll');
    const leftBtn = document.getElementById('doc-tab-left');
    const rightBtn = document.getElementById('doc-tab-right');
    if (scrollArea && leftBtn && rightBtn) {
      leftBtn.addEventListener('click', () => scrollArea.scrollBy({ left: -120, behavior: 'smooth' }));
      rightBtn.addEventListener('click', () => scrollArea.scrollBy({ left: 120, behavior: 'smooth' }));
      updateArrowVisibility(scrollArea, leftBtn, rightBtn);
      scrollArea.addEventListener('scroll', () => updateArrowVisibility(scrollArea, leftBtn, rightBtn));
    }

    // 移动端：标签栏兼作拖拽区域 — 下滑关闭。
    if (!tabBar._swipeWired) { tabBar._swipeWired = true; _wireSwipeDismiss(tabBar); }

    // 将被点击的标签完全带入视图 — 滚动区域每边有 18px
    // 的渐变遮罩加上 < / > 箭头按钮；没有这个，
    // 最右侧的标签会部分留在渐变下，用户看不到它的
    // 关闭按钮或版本标记。
    const _scrollTabIntoView = (tab, behavior = 'smooth') => {
      const sa = document.getElementById('doc-tab-scroll');
      if (!sa || !tab) return;
      const EDGE_PAD = 30;
      const tabLeft = tab.offsetLeft;
      const tabRight = tabLeft + tab.offsetWidth;
      const visLeft = sa.scrollLeft + EDGE_PAD;
      const visRight = sa.scrollLeft + sa.clientWidth - EDGE_PAD;
      if (tabRight > visRight) {
        sa.scrollTo({ left: sa.scrollLeft + tabRight - visRight, behavior });
      } else if (tabLeft < visLeft) {
        sa.scrollTo({ left: Math.max(0, sa.scrollLeft + tabLeft - visLeft), behavior });
      }
    };
// 绑定标签页点击（延迟以允许双击标题）
    let _tabClickTimer = null;
    tabBar.querySelectorAll('.doc-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
// 检查点击是否在或接近关闭/播放按钮
        if (e.target.closest('.doc-tab-close') || e.target.closest('.doc-tab-play') || e.target.closest('.doc-tab-menu-btn') || e.target.closest('.doc-tab-version')) return;
        if (_isEditingTabTitle) return;
// 如果点击标题 span，延迟以允许双击
        if (e.target.classList.contains('doc-tab-title')) {
          clearTimeout(_tabClickTimer);
          _tabClickTimer = setTimeout(() => { switchToDoc(tab.dataset.docId); _scrollTabIntoView(tab); }, 250);
        } else {
          switchToDoc(tab.dataset.docId);
          _scrollTabIntoView(tab);
        }
      });
      tab.addEventListener('dblclick', (e) => {
        clearTimeout(_tabClickTimer);
        const titleSpan = tab.querySelector('.doc-tab-title');
        if (!titleSpan) return;
        e.stopPropagation();
        const docId = tab.dataset.docId;
        const doc = docs.get(docId);
        if (!doc) return;
        startTitleEdit(titleSpan, docId, doc);
      });
    });

// 绑定关闭按钮——使用标签栏事件委托以确保可靠性
// 移除先前的处理器以防止跨 renderTabs 调用累积
    if (tabBar._closeHandler) tabBar.removeEventListener('click', tabBar._closeHandler);
    tabBar._closeHandler = (e) => {
      const verBtn = e.target.closest('.doc-tab-version');
      if (verBtn) {
        e.stopPropagation();
        const docId = verBtn.dataset.docId;
        if (docId) { if (docId !== activeDocId) switchToDoc(docId); toggleVersionHistory(); }
        return;
      }
      const playBtn = e.target.closest('.doc-tab-play');
      if (playBtn) {
        e.stopPropagation();
        const docId = playBtn.dataset.docId;
        if (docId) {
          if (docId !== activeDocId) switchToDoc(docId);
          toggleHtmlPreview();
        }
        return;
      }
      const menuBtnEl = e.target.closest('.doc-tab-menu-btn');
      if (menuBtnEl) {
        e.stopPropagation();
        const docId = menuBtnEl.dataset.docId;
        if (docId) showDocTabMenu(menuBtnEl, docId);
        return;
      }
      const closeBtn = e.target.closest('.doc-tab-close');
      if (!closeBtn) return;
      e.stopPropagation();
      const docId = closeBtn.dataset.docId;
      if (docId) closeTab(docId);
    };
    tabBar.addEventListener('click', tabBar._closeHandler);

// 绑定拖拽重排序
    initTabDragReorder(tabBar);

// 绑定新建文档按钮
    const newBtn = document.getElementById('doc-tab-new-btn');
    if (newBtn) {
      newBtn.addEventListener('click', async () => {
        let sessionId = docs.get(activeDocId)?.sessionId
          || _lastSessionId
          || (sessionModule && sessionModule.getCurrentSessionId());
        if (!sessionId) {
          try {
            sessionId = await _autoCreateSession();
          } catch (e) {
            console.error('Failed to auto-create session for document:', e);
            return;
          }
        }
        createDocument(sessionId);
      });
    }

// DOM 布局完成后将活动标签页滚动到可见区域
    requestAnimationFrame(() => {
      const at = document.getElementById('doc-tab-scroll')?.querySelector('.doc-tab.active');
      _scrollTabIntoView(at, 'auto');
    });
  }

  /** 开始内联编辑标签标题 */
  function startTitleEdit(titleSpan, docId, doc) {
    if (_isEditingTabTitle) return;
    _isEditingTabTitle = true;

    const fullTitle = doc.title || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'doc-tab-title-input';
    input.value = fullTitle;

    titleSpan.replaceWith(input);
    input.focus();
    input.select();

    function commitEdit() {
      if (!_isEditingTabTitle) return;
      const newTitle = input.value.trim();
      _isEditingTabTitle = false;
      doc.title = newTitle;
      if (docId === activeDocId) {
        const titleInput = document.getElementById('doc-title-input');
        if (titleInput) titleInput.value = newTitle;
      }
      updateTitle(docId, newTitle);
      renderTabs();
    }

    function cancelEdit() {
      _isEditingTabTitle = false;
      renderTabs();
    }

    input.addEventListener('blur', commitEdit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.removeEventListener('blur', commitEdit);
        commitEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.removeEventListener('blur', commitEdit);
        cancelEdit();
      }
    });
  }

  /** 拖拽重排标签 */
  function initTabDragReorder(tabBar) {
    let dragId = null;

    tabBar.querySelectorAll('.doc-tab').forEach(tab => {
      tab.addEventListener('dragstart', (e) => {
        dragId = tab.dataset.docId;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        dragId = null;
        tabBar.querySelectorAll('.doc-tab').forEach(t => t.classList.remove('drag-over'));
      });

      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (tab.dataset.docId !== dragId) {
          tab.classList.add('drag-over');
        }
      });

      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drag-over');
      });

      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over');
        const targetId = tab.dataset.docId;
        if (!dragId || dragId === targetId) return;

        // 重新排序文档 Map：将 dragId 移到 targetId 之前
        const entries = [...docs.entries()];
        const fromIdx = entries.findIndex(([k]) => k === dragId);
        const toIdx = entries.findIndex(([k]) => k === targetId);
        if (fromIdx === -1 || toIdx === -1) return;

        const [moved] = entries.splice(fromIdx, 1);
        entries.splice(toIdx, 0, moved);

        docs.clear();
        for (const [k, v] of entries) docs.set(k, v);

        renderTabs();
      });
    });
  }

  /** 当没有文档存在时显示空状态 */
  function showEmptyState() {
    activeDocId = null;
    const textarea = document.getElementById('doc-editor-textarea');
    const langSelect = document.getElementById('doc-language-select');
    const badge = document.getElementById('doc-version-badge');

    if (textarea) textarea.value = '';
    if (textarea) textarea.placeholder = t('document.editor_placeholder');
    if (textarea) textarea.disabled = false;
    if (langSelect) langSelect.value = '';
    if (badge) badge.textContent = '';
    _hideLoadingOverlay();
    syncHighlighting();
    renderTabs();
  }

  let _loadingSpinner = null;
  function _showLoadingOverlay() {
    const wrap = document.getElementById('doc-editor-wrap');
    if (!wrap) return;
    let overlay = wrap.querySelector('.doc-loading-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'doc-loading-overlay';
      wrap.appendChild(overlay);
    }
    overlay.innerHTML = '';
    overlay.style.display = '';
    _loadingSpinner = spinnerModule.create('', 'clean', 'whirlpool');
    const el = _loadingSpinner.createElement();
    overlay.appendChild(el);
    _loadingSpinner.start();
  }

  function _hideLoadingOverlay() {
    if (_loadingSpinner) { _loadingSpinner.destroy(); _loadingSpinner = null; }
    const overlay = document.querySelector('.doc-loading-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  /** 根据当前语言显示/隐藏标题中的统一操作按钮 */
  function _isFormBackedDoc(content) {
    const c = content || '';
    return /<!--\s*pdf_form_source\s+upload_id="[^"]+"/.test(c)
        || /<!--\s*pdf_source\s+upload_id="[^"]+"/.test(c);
  }

  // 在触摸设备上强制关闭屏幕键盘。Firefox 移动版会忽略普通的
  // blur，因此使用 readonly 技巧（readonly 字段不显示键盘），然后
  // 移除 readonly 以便用户可以再次输入。
  function _dismissDocKb() {
    if (!(('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0)) return;
    const ta = document.getElementById('doc-editor-textarea');
    const ae = document.activeElement;
    const el = (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ? ae : ta;
    if (!el) return;
    try {
      el.setAttribute('readonly', 'readonly');
      el.blur();
      setTimeout(() => { try { el.removeAttribute('readonly'); } catch (_) {} }, 120);
    } catch (_) { try { el.blur(); } catch (_) {} }
  }

  async function _downloadFilledPdf() {
    if (!activeDocId) return;
    _dismissDocKb();   // export shouldn't leave the keyboard up
    await _saveActiveDocBeforeExport();
    try {
      const r = await fetch(`${API_BASE}/api/document/${activeDocId}/export-pdf`);
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || r.statusText);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const cd = r.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^"';]+)/i);
      const _slug = (s) => (s || 'form').replace(/\.pdf$/i, '').replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'form';
      a.download = (m && decodeURIComponent(m[1])) || (_slug(docs.get(activeDocId)?.title) + '_annotated.pdf');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (uiModule) uiModule.showError(t('document.export_failed') + e.message);
      else alert(t('document.export_failed') + e.message);
    }
  }

  async function _saveActiveDocBeforeExport() {
    // 从两个编辑界面刷新进行中的编辑，以便服务端
    // 导出读取用户实际看到的值：
    //  - Markdown 视图：如果用户输入但现有的 2s 自动保存
    //    尚未触发，textarea.value 可能与 doc.content 不同。
    //  - PDF 视图：可能有待处理的防抖 _pdfPaneSaveTimer
    //    尚未刷新用户的输入更改。
    if (_pdfPaneSaveTimer) {
      clearTimeout(_pdfPaneSaveTimer);
      await _savePdfPaneToMarkdown();
    }
    const ta = document.getElementById('doc-editor-textarea');
    const doc = docs.get(activeDocId);
    if (!ta || !doc || !activeDocId) return;
    const live = ta.value;
    if (live === doc.content) return;
    try {
      await fetch(`${API_BASE}/api/document/${activeDocId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: live }),
      });
      doc.content = live;
    } catch (e) {
      console.warn('Pre-export save failed:', e);
    }
  }

  async function _openExportPdfModal() {
    if (!activeDocId) return;
    await _saveActiveDocBeforeExport();

    const overlay = document.createElement('div');
    overlay.className = 'modal pdf-export-overlay';
    overlay.style.cssText = 'pointer-events:auto;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);';
    overlay.innerHTML = `
      <div class="modal-content" style="width:min(780px,94vw);max-height:86vh;">
        <div class="modal-header">
          <h4>${t('document.pdf_export_title')}</h4>
          <button id="pdf-export-close" class="modal-close" title="${t('common.close')}">×</button>
        </div>
        <div id="pdf-export-summary" style="font-size:0.78rem;opacity:0.7;margin:0 0 6px;">${t('document.pdf_export_loading')}</div>
        <div id="pdf-export-body" class="modal-body" style="font-size:0.85rem;">
          <div style="opacity:0.6;">${t('document.pdf_export_fetching')}</div>
        </div>
        <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding-top:8px;border-top:1px solid var(--border);margin-top:6px;align-items:center;">
          <span id="pdf-export-status" style="font-size:0.75rem;opacity:0.7;margin-right:auto;"></span>
          <button id="pdf-export-cancel" class="confirm-btn confirm-btn-secondary">${t('common.cancel')}</button>
          <button id="pdf-export-download" class="confirm-btn confirm-btn-primary" disabled>${t('document.pdf_export_download')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#pdf-export-close').addEventListener('click', close);
    overlay.querySelector('#pdf-export-cancel').addEventListener('click', close);

    let fields = [];
    try {
      const res = await fetch(`${API_BASE}/api/document/${activeDocId}/export-pdf/preview`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || res.statusText);
      }
      const data = await res.json();
      fields = data.fields || [];

      const filledNow = data.filled || 0;
      const total = data.total || fields.length;
      overlay.querySelector('#pdf-export-summary').textContent =
        t('document.pdf_export_summary', { filled: filledNow, total: total });

      const body = overlay.querySelector('#pdf-export-body');
      body.innerHTML = '';

      // 按页分组
      const byPage = new Map();
      for (const f of fields) {
        const p = f.page || 1;
        if (!byPage.has(p)) byPage.set(p, []);
        byPage.get(p).push(f);
      }
      const pages = Array.from(byPage.keys()).sort((a, b) => a - b);

      // 跳转栏：页面链接 + 滚动到顶部/底部快捷方式
      const jumpBar = document.createElement('div');
      jumpBar.style.cssText = 'position:sticky;top:0;background:var(--panel);padding:6px 0;margin-bottom:8px;border-bottom:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:0.72rem;z-index:1;';
      jumpBar.innerHTML = `<span style="opacity:0.6;margin-right:4px;">${t('document.pdf_export_jump_to')}</span>`;
      const pageAnchors = {};
      const _smallBtnClass = 'confirm-btn confirm-btn-secondary';
      const _smallBtnStyle = 'padding:2px 8px;font-size:0.72rem;';
      for (const p of pages) {
        const a = document.createElement('button');
        a.textContent = String(p);
        a.title = t('document.pdf_export_page', { p: p });
        a.className = _smallBtnClass;
        a.style.cssText = _smallBtnStyle;
        a.addEventListener('click', () => pageAnchors[p]?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        jumpBar.appendChild(a);
      }
      const sep = document.createElement('span');
      sep.style.cssText = 'opacity:0.4;margin:0 4px;';
      sep.textContent = '|';
      jumpBar.appendChild(sep);
      const topBtn = document.createElement('button');
      topBtn.textContent = t('document.pdf_export_top');
      topBtn.className = _smallBtnClass;
      topBtn.style.cssText = _smallBtnStyle;
      topBtn.addEventListener('click', () => body.scrollTo({ top: 0, behavior: 'smooth' }));
      jumpBar.appendChild(topBtn);
      const botBtn = document.createElement('button');
      botBtn.textContent = t('document.pdf_export_bottom');
      botBtn.title = t('document.pdf_export_bottom_hint');
      botBtn.className = _smallBtnClass;
      botBtn.style.cssText = _smallBtnStyle;
      botBtn.addEventListener('click', () => body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' }));
      jumpBar.appendChild(botBtn);
      body.appendChild(jumpBar);

      for (const p of pages) {
        const sec = document.createElement('div');
        sec.className = 'pdf-export-section';
        sec.id = `pdf-export-page-${p}`;
        pageAnchors[p] = sec;
        sec.innerHTML = `<div class="pdf-export-section-title">${t('document.pdf_export_page', { p: p })}</div>`;
        for (const f of byPage.get(p)) {
          const row = document.createElement('div');
          row.className = 'pdf-export-row';
          const label = document.createElement('label');
          label.textContent = f.label || f.name;
          label.title = `${f.name} (${f.type})`;
          row.appendChild(label);

          const isSignature = f.type === 'signature' || /sign(?:ed|ature)/i.test((f.name || '') + ' ' + (f.label || ''));
          const isDate = f.type === 'text' && /\b(date|dated)\b/i.test(`${f.name || ''} ${f.label || ''}`);
          let input;
          if (isSignature) {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
            const btn = document.createElement('button');
            btn.className = 'confirm-btn confirm-btn-secondary';
            btn.style.cssText = 'padding:3px 10px;font-size:0.78rem;';
            const thumb = document.createElement('img');
            thumb.style.cssText = 'max-height:32px;max-width:140px;object-fit:contain;border:1px solid var(--border);border-radius:3px;background:#fff;display:none;';
            const clearBtn = document.createElement('button');
            clearBtn.textContent = '×';
            clearBtn.title = t('document.pdf_export_remove_sign');
            clearBtn.className = 'confirm-btn confirm-btn-secondary';
            clearBtn.style.cssText = 'padding:0 8px;font-size:0.85rem;line-height:1;display:none;';
            const apply = (sig) => {
              wrap.dataset.signatureId = sig.id;
              thumb.src = sig.dataUrl;
              thumb.style.display = '';
              clearBtn.style.display = '';
              btn.textContent = t('document.pdf_export_change');
            };
            const clear = () => {
              delete wrap.dataset.signatureId;
              thumb.removeAttribute('src');
              thumb.style.display = 'none';
              clearBtn.style.display = 'none';
              btn.textContent = t('document.pdf_export_sign_here');
            };
            btn.textContent = t('document.pdf_export_sign_here');
            btn.addEventListener('click', async () => {
              const sig = await signatureModule.pick();
              if (sig) apply(sig);
            });
            clearBtn.addEventListener('click', clear);
            wrap.appendChild(btn);
            wrap.appendChild(thumb);
            wrap.appendChild(clearBtn);
            wrap.dataset.fieldName = f.name;
            wrap.dataset.fieldType = 'signature';
            const last = signatureModule.getLastUsed && signatureModule.getLastUsed();
            if (last) apply(last);
            input = wrap;
          } else if (isDate) {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;gap:6px;align-items:center;';
            const ti = document.createElement('input');
            ti.type = 'text';
            ti.value = f.value == null ? '' : String(f.value);
            ti.className = 'pdf-export-input';
            ti.style.cssText = 'flex:1;';
            ti.dataset.fieldName = f.name;
            ti.dataset.fieldType = f.type;
            const today = document.createElement('button');
            today.textContent = t('document.pdf_export_today');
            today.title = t('document.pdf_export_today_date');
            today.className = 'confirm-btn confirm-btn-secondary';
            today.style.cssText = 'padding:3px 8px;font-size:0.72rem;';
            today.addEventListener('click', () => {
              const d = new Date();
              const dd = String(d.getDate()).padStart(2, '0');
              const mm = String(d.getMonth() + 1).padStart(2, '0');
              const yyyy = d.getFullYear();
              ti.value = `${dd}/${mm}/${yyyy}`;
            });
            wrap.appendChild(ti);
            wrap.appendChild(today);
            input = wrap;
          } else if (f.type === 'checkbox') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!f.value;
          } else if (f.type === 'choice' && (f.options || []).length) {
            input = document.createElement('select');
            input.className = 'pdf-export-input';
            const blank = document.createElement('option');
            blank.value = '';
            blank.textContent = t('document.pdf_export_none_option');
            input.appendChild(blank);
            for (const o of f.options) {
              const opt = document.createElement('option');
              opt.value = o; opt.textContent = o;
              if (o === f.value) opt.selected = true;
              input.appendChild(opt);
            }
          } else {
            input = document.createElement('input');
            input.type = 'text';
            input.value = f.value == null ? '' : String(f.value);
            input.className = 'pdf-export-input';
            input.style.cssText = 'width:100%;';
          }
          if (!isSignature && !isDate) {
            input.dataset.fieldName = f.name;
            input.dataset.fieldType = f.type;
          }
          row.appendChild(input);
          sec.appendChild(row);
        }
        body.appendChild(sec);
      }

      const downloadBtn = overlay.querySelector('#pdf-export-download');
      downloadBtn.disabled = false;
      downloadBtn.addEventListener('click', async () => {
        const values = {};
        const signatures = {};
        for (const el of overlay.querySelectorAll('[data-field-name]')) {
          const name = el.dataset.fieldName;
          const ftype = el.dataset.fieldType;
          if (ftype === 'signature') {
            if (el.dataset.signatureId) signatures[name] = el.dataset.signatureId;
          } else if (ftype === 'checkbox') {
            values[name] = el.checked;
          } else {
            values[name] = el.value;
          }
        }
        downloadBtn.disabled = true;
        overlay.querySelector('#pdf-export-status').textContent = t('document.pdf_export_building');
        try {
          const r = await fetch(`${API_BASE}/api/document/${activeDocId}/export-pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values, signatures }),
          });
          if (!r.ok) {
            const t = await r.text();
            throw new Error(t || r.statusText);
          }
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          const cd = r.headers.get('Content-Disposition') || '';
          const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^"';]+)/i);
          const _slug = (s) => (s || 'form').replace(/\.pdf$/i, '').replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'form';
          a.download = (m && decodeURIComponent(m[1])) || (_slug(docs.get(activeDocId)?.title) + '_annotated.pdf');
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          close();
        } catch (e) {
          overlay.querySelector('#pdf-export-status').textContent = t('document.pdf_export_error') + e.message;
          downloadBtn.disabled = false;
        }
      });
    } catch (e) {
      overlay.querySelector('#pdf-export-body').innerHTML =
        `<div style="color:#c00;">${t('document.pdf_export_load_failed')}${(e && e.message) || e}</div>`;
    }
  }

  // 跟踪用户已将哪些表单支持的文档切换到 PDF 视图
  // （每个文档，内存中）。在同会话中切换文档时保持。
  const _pdfViewState = new Map();
  const _pdfPaneFieldsByDoc = new Map(); // docId -> [{name, type, inputEl, ...}]
  const _pdfPaneAnnotationsByDoc = new Map(); // docId -> [{id, page, x, y, w, h, el, wrap}]
  const _pdfUndoStackByDoc = new Map(); // docId -> markdown 快照
  let _pdfPaneSaveTimer = null;

  // 匹配 markdown 源代码中的自由格式注释项目符号行。
  // 坐标是页面宽/高的百分比（0-100），因此它们随着
  // PDF 面板渲染的宽度而变化。`kind` 和 `lh`（行高）
  // 是可选参数，用于向后兼容早期的注释格式。
  function _annotationRegexGlobal() {
    return /^[ \t]*-\s+(.*?)\s*<!--\s*annotation\s+id=([\w-]+)\s+page=(\d+)\s+x=([\d.]+)\s+y=([\d.]+)\s+w=([\d.]+)\s+h=([\d.]+)(?:\s+kind=(\w+))?(?:\s+lh=([\d.]+))?\s*-->[ \t]*$/gm;
  }

  // 项目符号行是单行的，因此值中的换行符被转义为
  // \n（反斜杠-n）进行存储，解析时反转义。反斜杠
  // 先被转义，使得反向映射是无歧义的。
  function _escapeAnnotationValue(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  }
  function _unescapeAnnotationValue(s) {
    return String(s || '').replace(/\\(.)/g, (m, c) => c === 'n' ? '\n' : c === '\\' ? '\\' : m);
  }

  function _parseAnnotations(md) {
    const out = [];
    const re = _annotationRegexGlobal();
    let m;
    while ((m = re.exec(md || '')) !== null) {
      const rawVal = m[1] === '_(empty)_' ? '' : _unescapeAnnotationValue(m[1]);
      out.push({
        value: rawVal,
        id: m[2],
        page: parseInt(m[3], 10),
        x: parseFloat(m[4]),
        y: parseFloat(m[5]),
        w: parseFloat(m[6]),
        h: parseFloat(m[7]),
        kind: m[8] || 'text',
        lineHeight: m[9] ? parseFloat(m[9]) : 1.3,
      });
    }
    return out;
  }

  function _annotationLine(a) {
    const kind = a.kind || 'text';
    const lh = (a.lineHeight && Number.isFinite(a.lineHeight)) ? a.lineHeight : 1.3;
    const escaped = a.value === '' || a.value == null ? '_(empty)_' : _escapeAnnotationValue(a.value);
    return `- ${escaped} <!-- annotation id=${a.id} page=${a.page} x=${a.x.toFixed(2)} y=${a.y.toFixed(2)} w=${a.w.toFixed(2)} h=${a.h.toFixed(2)} kind=${kind} lh=${lh.toFixed(2)} -->`;
  }

  // 移除每个注释项目符号 + "## Annotations" 部分，然后
  // 在末尾重新输出。保持该部分与实时引用集同步
  // 的最干净方式，无需逐行比较。
  function _writeAnnotations(md, annotations) {
    let out = (md || '').replace(_annotationRegexGlobal(), '');
    out = out.replace(/\n##\s+Annotations\s*\r?\n+/g, '\n');
    out = out.replace(/\n{3,}/g, '\n\n');
    if (!annotations.length) return out;
    if (!out.endsWith('\n')) out += '\n';
    out += '\n## Annotations\n\n';
    for (const a of annotations) out += _annotationLine(a) + '\n';
    return out;
  }

  function _newAnnotationId() {
    return 'ann-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function _pdfMarkdownFromLive(docId = activeDocId) {
    const doc = docs.get(docId);
    if (!doc) return null;
    const annotations = _pdfPaneAnnotationsByDoc.get(docId) || [];
    return _writeAnnotations(doc.content || '', annotations.map(a => {
      let value = '';
      if (a.kind === 'check') {
        value = '✓';
      } else if (a.kind === 'signature') {
        const sid = a.el && a.el.dataset && a.el.dataset.signatureId;
        value = sid ? `signature:${sid}` : '';
      } else {
        value = (a.el && typeof a.el.value === 'string') ? a.el.value : '';
      }
      return {
        id: a.id, page: a.page, x: a.x, y: a.y, w: a.w, h: a.h,
        kind: a.kind || 'text',
        lineHeight: a.lineHeight || 1.3,
        value,
      };
    }));
  }

  function _pushPdfUndoSnapshot(docId = activeDocId) {
    const md = _pdfMarkdownFromLive(docId);
    if (md == null) return;
    const stack = _pdfUndoStackByDoc.get(docId) || [];
    if (stack[stack.length - 1] === md) return;
    stack.push(md);
    if (stack.length > 50) stack.shift();
    _pdfUndoStackByDoc.set(docId, stack);
  }

  async function _undoPdfPaneAction() {
    const docId = activeDocId;
    const stack = _pdfUndoStackByDoc.get(docId) || [];
    const prev = stack.pop();
    if (!prev) return false;
    _pdfUndoStackByDoc.set(docId, stack);
    if (_pdfPaneSaveTimer) {
      clearTimeout(_pdfPaneSaveTimer);
      _pdfPaneSaveTimer = null;
    }
    const doc = docs.get(docId);
    if (!doc) return false;
    doc.content = prev;
    const ta = document.getElementById('doc-editor-textarea');
    if (ta) ta.value = prev;
    _setPdfSaveStatus('saving');
    try {
      const res = await fetch(`${API_BASE}/api/document/${docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: prev }),
      });
      if (!res.ok) throw new Error(res.statusText || String(res.status));
      _setPdfSaveStatus('saved');
      _renderPdfPane();
      return true;
    } catch (e) {
      _setPdfSaveStatus('error', e.message || t('document.status_undo_failed'));
      return true;
    }
  }

  // PDF 工具栏的活动放置模式 — 工具栏按钮设置此模式；
  // 页面上的下一次点击使用它。null 表示点击无操作。
  let _pdfDropMode = null;
  // 每个文档的文本注释上次使用的行距。一旦用户选择了
  // 1.6，之后放置的每个文本框都默认使用 1.6。
  const _pdfLastLineHeight = new Map(); // docId -> 数字
  function _setPdfDropMode(mode) {
    _pdfDropMode = mode;
    const pane = document.getElementById('doc-pdf-view');
    if (pane) pane.style.cursor = mode ? 'crosshair' : '';
// 高亮活动工具栏按钮，让用户看到当前激活的模式。
    for (const id of ['doc-pdf-add-text-btn', 'doc-pdf-add-check-btn', 'doc-pdf-add-sign-btn']) {
      const b = document.getElementById(id);
      if (!b) continue;
      const want = (mode === 'text' && id === 'doc-pdf-add-text-btn')
        || (mode === 'check' && id === 'doc-pdf-add-check-btn')
        || (mode === 'signature' && id === 'doc-pdf-add-sign-btn');
      b.style.outline = want ? '2px solid var(--accent-primary, var(--red))' : '';
    }
  }
  // 按 ID 缓存的签名数据 URL，在 PDF 视图
  // 渲染行内签名和用户选择新签名时延迟填充。
  const _sigCache = new Map();

  // src/pdf_form_doc.py 中 Python _encode_name 的镜像 — 保持同步。
  // 对非 A-Za-z0-9 _ . - 的所有内容进行百分号编码
  function _encodeFieldName(name) {
    let out = '';
    for (const ch of name || '') {
      if (/[A-Za-z0-9_.\-]/.test(ch)) {
        out += ch;
      } else {
        const enc = new TextEncoder().encode(ch);
        for (const b of enc) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
    return out;
  }

  // 基于接近度的句柄可见性 — 当光标距注释约 30px 时
  // 显示 ×/拖拽/调整大小句柄，而不仅仅在内部时。
  // 仅附加到面板一次；在触发时读取当前文档的引用。
  let _pdfPaneProximityWired = false;
  function _wirePdfPaneProximity(pane) {
    if (_pdfPaneProximityWired || !pane) return;
    _pdfPaneProximityWired = true;
    let raf = 0;
    const buffer = 30;
    pane.addEventListener('mousemove', (ev) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const refs = _pdfPaneAnnotationsByDoc.get(activeDocId) || [];
        for (const ref of refs) {
          if (!ref || !ref.wrap || !ref._setHandlesVisible) continue;
          const r = ref.wrap.getBoundingClientRect();
          const dx = Math.max(r.left - ev.clientX, 0, ev.clientX - r.right);
          const dy = Math.max(r.top - ev.clientY, 0, ev.clientY - r.bottom);
          ref._setHandlesVisible(Math.hypot(dx, dy) <= buffer);
        }
      });
    });
    pane.addEventListener('mouseleave', () => {
      const refs = _pdfPaneAnnotationsByDoc.get(activeDocId) || [];
      for (const ref of refs) ref._setHandlesVisible && ref._setHandlesVisible(false);
    });
  }

  async function _pdfResponseErrorMessage(res) {
    const text = await res.text().catch(() => '');
    try {
      const data = JSON.parse(text);
      if (typeof data?.detail === 'string') return data.detail;
      if (data?.detail) return JSON.stringify(data.detail);
    } catch (_) {}
    return text || res.statusText || `HTTP ${res.status}`;
  }

  async function _renderPdfPane() {
    const pane = document.getElementById('doc-pdf-view');
    if (!pane || !activeDocId) return;
    _wirePdfPaneProximity(pane);
    const docId = activeDocId;
    // 通过分离/重新附加来在重新渲染间保留保存标记
    const savedPill = document.getElementById('doc-pdf-save-pill');
    pane.innerHTML = `<div style="color:#bbb;font-size:13px;text-align:center;padding:40px;">${t('document.pdf_view_loading')}</div>`;
    if (savedPill) pane.appendChild(savedPill);
    let data;
    try {
      const res = await fetch(`${API_BASE}/api/document/${docId}/render-pages`);
      if (!res.ok) throw new Error(await _pdfResponseErrorMessage(res));
      data = await res.json();
    } catch (e) {
      pane.innerHTML = `<div style="color:#fbb;padding:40px;text-align:center;">${t('document.pdf_view_load_failed')}${_escHtml(e.message || String(e))}</div>`;
      if (savedPill) pane.appendChild(savedPill);
      return;
    }
    if (docId !== activeDocId) return;

    pane.innerHTML = '';
    if (savedPill) pane.appendChild(savedPill);
    const fieldRefs = [];
    // 在页面循环之前重置此文档的注释引用 — 我们重建它们
    // 从实时 markdown 逐页重建。
    const annotationRefs = [];
    _pdfPaneAnnotationsByDoc.set(docId, annotationRefs);
    const liveMd = (docs.get(docId) && docs.get(docId).content) || '';
    const allAnnotations = _parseAnnotations(liveMd);
    // 从现有文本注释中恢复上次使用的行距，以便
    // 首选项在页面重载后保留，而不仅仅是此会话的内存生命周期。
    if (!_pdfLastLineHeight.has(docId)) {
      for (let i = allAnnotations.length - 1; i >= 0; i--) {
        const a = allAnnotations[i];
        if (a.kind === 'text' && a.lineHeight) {
          _pdfLastLineHeight.set(docId, a.lineHeight);
          break;
        }
      }
    }
    for (const page of data.pages) {
      // 将包装锁定到页面的精确宽高比，以便百分比定位的
      // 输入保持对齐，无论面板渲染多宽。
      const pageWrap = document.createElement('div');
      pageWrap.style.cssText = `position:relative;margin:0 auto 16px auto;width:${page.width}px;max-width:calc(100% - 24px);aspect-ratio:${page.width} / ${page.height};background:#fff;box-shadow:0 4px 16px rgba(0,0,0,0.4);container-type:size;`;
      const img = document.createElement('img');
      img.src = `${API_BASE}/api/document/${docId}/page/${page.page}.png`;
      img.style.cssText = 'display:block;width:100%;height:100%;user-select:none;-webkit-user-drag:none;pointer-events:none;';
      img.draggable = false;
      pageWrap.appendChild(img);

      // 缩放感知叠加层，使输入在页面包装缩小到
      // 其自然宽度以下时保持跟踪（设置 width:page.width 但 max-width:100% 限制）。
      // 每个字段通过页面矩形的百分比定位。
      for (const f of page.fields) {
        const [x0, y0, x1, y1] = f.rect_px;
        const wPct = ((x1 - x0) / page.width) * 100;
        const hPct = ((y1 - y0) / page.height) * 100;
        const lPct = (x0 / page.width) * 100;
        const tPct = (y0 / page.height) * 100;
        const isSig = f.type === 'signature' || /sign(?:ed|ature)/i.test((f.name || '') + ' ' + (f.label || ''));
        let el;
        const baseStyle = `position:absolute;left:${lPct}%;top:${tPct}%;width:${wPct}%;height:${hPct}%;box-sizing:border-box;font-family:inherit;`;
        if (isSig) {
          // 行内签名：点击选择/更改。所选签名
          // ID 通过现有的防抖保存流程镜像到 markdown 项目符号中
          // 作为 `signature:<id>`，导出路由会读取它。
          el = document.createElement('div');
          el.style.cssText = baseStyle + 'cursor:pointer;display:flex;align-items:center;justify-content:center;overflow:hidden;';
          el.dataset.fieldName = f.name;
          el.dataset.fieldType = 'signature';

          // 从值解析预选：`signature:<id>` 格式
          const initialSigId = (typeof f.value === 'string' && f.value.startsWith('signature:'))
            ? f.value.slice('signature:'.length).trim() : '';
          const renderSigUI = async (sigId) => {
            el.innerHTML = '';
            if (sigId) {
              el.dataset.signatureId = sigId;
              const img = document.createElement('img');
              img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;pointer-events:none;';
              // 通过保存列表缓存或获取来查找签名数据 URL
              try {
                if (!_sigCache.has(sigId)) {
                  const r = await fetch(`${API_BASE}/api/signatures`);
                  const data = await r.json();
                  for (const s of data.signatures || []) _sigCache.set(s.id, s.data_url);
                }
                const dataUrl = _sigCache.get(sigId);
                if (dataUrl) img.src = dataUrl;
                else throw new Error('not found');
                el.appendChild(img);
                el.style.border = '1px solid color-mix(in srgb, var(--accent, var(--red)) 45%, transparent)';
                el.style.background = 'transparent';
              } catch {
                el.removeAttribute('data-signature-id');
                renderSigUI('');
              }
            } else {
              delete el.dataset.signatureId;
              el.style.border = '1px dashed color-mix(in srgb, var(--accent, var(--red)) 65%, transparent)';
              el.style.background = 'color-mix(in srgb, var(--accent, var(--red)) 10%, transparent)';
              const span = document.createElement('span');
              span.style.cssText = 'color:var(--accent, var(--red));font-size:11px;';
              span.textContent = t('document.pdf_export_sign_here');
              el.appendChild(span);
            }
          };
          el.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const sig = await signatureModule.pick();
            if (sig) {
              _sigCache.set(sig.id, sig.dataUrl);
              await renderSigUI(sig.id);
              _schedulePdfPaneSave();
            }
          });
          renderSigUI(initialSigId);
        } else if (f.type === 'checkbox') {
          el = document.createElement('input');
          el.type = 'checkbox';
          el.checked = !!f.value;
          el.style.cssText = baseStyle + 'cursor:pointer;';
        } else if (f.type === 'choice' && (f.options || []).length) {
          el = document.createElement('select');
          const blank = document.createElement('option');
          blank.value = ''; blank.textContent = '—';
          el.appendChild(blank);
          for (const opt of f.options) {
            const o = document.createElement('option');
            o.value = opt; o.textContent = opt;
            if (opt === f.value) o.selected = true;
            el.appendChild(o);
          }
          el.style.cssText = baseStyle + 'border:1px solid color-mix(in srgb, var(--accent, var(--red)) 45%, transparent);background:rgba(255,255,255,0.85);font-size:11px;padding:0 2px;';
        } else {
          el = document.createElement('input');
          el.type = 'text';
          el.value = f.value == null ? '' : String(f.value);
          // 选择大致适合字段高度的字体大小。较小的
          // 乘数（比行高小）以留出呼吸空间并匹配
// AcroForm 渲染器通常使用的格式。
          const fontPx = Math.max(8, Math.min(14, Math.round((y1 - y0) * 0.4)));
          el.style.cssText = baseStyle + `border:1px solid color-mix(in srgb, var(--accent, var(--red)) 45%, transparent);background:rgba(255,255,255,0.85);font-size:${fontPx}px;padding:0 2px;`;
        }
        if (!isSig) {
          el.dataset.fieldName = f.name;
          el.dataset.fieldType = f.type;
          el.addEventListener('input', _schedulePdfPaneSave);
          el.addEventListener('change', _schedulePdfPaneSave);
        }
        pageWrap.appendChild(el);
        // 签名字段也通过 markdown 项目符号持久化 —
        // 点击处理程序在选择后直接调用 _schedulePdfPaneSave。
        fieldRefs.push({ name: f.name, type: isSig ? 'signature' : f.type, el });

        // 日期字段快捷方式：任何名称或标签暗示
        // 日期的文本字段会得到一个固定在其右边缘的小 "Today" 按钮。
        const isDate = f.type === 'text' && /\b(date|dated)\b/i.test(`${f.name} ${f.label}`);
        if (isDate) {
          const today = document.createElement('button');
          today.type = 'button';
          today.textContent = t('document.pdf_export_today');
          today.title = t('document.pdf_export_today_date');
          today.style.cssText = `position:absolute;left:calc(${lPct}% + ${wPct}%);top:${tPct}%;height:${hPct}%;margin-left:4px;padding:0 6px;border:1px solid color-mix(in srgb, var(--accent, var(--red)) 55%, transparent);background:rgba(255,255,255,0.95);color:var(--accent, var(--red));border-radius:3px;cursor:pointer;font-size:10px;line-height:1;white-space:nowrap;`;
          today.addEventListener('click', () => {
            const d = new Date();
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const yyyy = d.getFullYear();
            el.value = `${dd}/${mm}/${yyyy}`;
            _schedulePdfPaneSave();
          });
          pageWrap.appendChild(today);
        }
      }
      // 此页面的自由格式注释
      for (const ann of allAnnotations) {
        if (ann.page !== page.page) continue;
        const built = _buildAnnotation(pageWrap, ann);
        annotationRefs.push(built.ref);
      }
      // 当放置模式处于活动状态时（工具栏按钮设置模式），
      // 点击空白页面区域放置新注释。没有模式时，点击
      // 无操作 — 保持页面交互可预测，用户不会
      // 因误点击而产生意外框。
      pageWrap.addEventListener('click', (ev) => {
        if (ev.target !== pageWrap && ev.target.tagName !== 'IMG') return;
        if (!_pdfDropMode) return;
        const rect = pageWrap.getBoundingClientRect();
        const xPct = ((ev.clientX - rect.left) / rect.width) * 100;
        const yPct = ((ev.clientY - rect.top) / rect.height) * 100;
        // 每种类型的默认大小。将框居中于点击位置，以便值
        // 显示在用户指向的位置（文本输入宽度大于高度，
        // 因此垂直居中才是关键）。
        const sizes = {
          text: { w: 8, h: 2.5 },
          check: { w: 2.5, h: 2.5 },
          signature: { w: 22, h: 6 },
        };
        const size = sizes[_pdfDropMode] || sizes.text;
        // 复选标记在点击位置居中放置（你指向要
        // 标记的框）。文本+签名在点击位置左上角锚定，
        // 因此第一个字符正好落在光标所在位置。
        const centered = _pdfDropMode === 'check';
        const x = Math.max(0, Math.min(100 - size.w, centered ? xPct - size.w / 2 : xPct));
        const y = Math.max(0, Math.min(100 - size.h, centered ? yPct - size.h / 2 : yPct));
        const ann = {
          id: _newAnnotationId(),
          page: page.page,
          x, y, w: size.w, h: size.h,
          value: _pdfDropMode === 'check' ? '[ ]' : '',
          kind: _pdfDropMode,
          // 对于文本放置，继承文档上次使用的行距，以便
          // 用户的 "1.6" 选择在他们放置的每个新框中保持一致。
          lineHeight: _pdfDropMode === 'text' ? (_pdfLastLineHeight.get(docId) || 1.3) : undefined,
        };
        _pushPdfUndoSnapshot(docId);
        const built = _buildAnnotation(pageWrap, ann);
        annotationRefs.push(built.ref);
        if (_pdfDropMode === 'text') {
          built.ref.el.focus();
        } else if (_pdfDropMode === 'signature') {
          // 立即触发签名选择器 — 用户在放置框时
          // 总是想选择签名。
          built.ref.el.click();
        }
        _schedulePdfPaneSave();
        // 模式保持武装 — 继续放置更多，直到用户再次点击
        // 工具栏按钮将其关闭。
      });

      pane.appendChild(pageWrap);
    }
    _pdfPaneFieldsByDoc.set(docId, fieldRefs);
  }

  // 将注释渲染为带有适当类型内容的定位包装器
  // （文本输入/复选框/签名选择器）以及删除和拖拽
  // 手柄。返回 { ref }，调用者可以跟踪它进行保存。
  function _buildAnnotation(pageWrap, ann) {
    const kind = ann.kind || 'text';
    const wrap = document.createElement('div');
    wrap.className = 'pdf-annotation-wrap';
    wrap.style.cssText = `position:absolute;left:${ann.x}%;top:${ann.y}%;width:${ann.w}%;height:${ann.h}%;box-sizing:border-box;z-index:2;`;
    wrap.dataset.annId = ann.id;
    wrap.dataset.annKind = kind;

    let input;
    if (kind === 'check') {
      // 印章式复选标记绘制为 SVG，以便随框缩放 —
      // 固定字体大小的字形总是过度或不足填充。
      input = document.createElement('div');
      input.style.cssText = `width:100%;height:100%;display:flex;align-items:center;justify-content:center;user-select:none;pointer-events:none;`;
      input.innerHTML = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block;"><path d="M4 12 L10 18 L20 6" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    } else if (kind === 'signature') {
      input = document.createElement('div');
      input.style.cssText = `width:100%;height:100%;box-sizing:border-box;border:1px dashed color-mix(in srgb, var(--accent, var(--red)) 65%, transparent);background:color-mix(in srgb, var(--accent, var(--red)) 10%, transparent);display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;font-size:10px;color:var(--accent, var(--red));`;
      input.textContent = (ann.value && ann.value.startsWith('signature:')) ? '' : t('document.pdf_export_sign_here');
      input.dataset.signatureId = (ann.value && ann.value.startsWith('signature:')) ? ann.value.slice(10) : '';
    } else {
      // 多行文本输入。浏览器调整大小已禁用 — 我们使用自定义
      // 右下角手柄进行大小调整，以便位置元数据保持同步。
      // 字体大小使用 cqh（容器查询高度），因此文本随
      // 文档面板调整大小时渲染页面缩放 — 保持注释
      // 在视觉上锚定到 PDF，而不是在
      // 全屏切换后看起来过大/过小。
      input = document.createElement('textarea');
      input.value = ann.value || '';
      input.placeholder = t('document.pdf_annotation_type');
      input.rows = 1;
      input.spellcheck = false;
      const lh = ann.lineHeight || 1.3;
      input.style.cssText = `width:100%;height:100%;box-sizing:border-box;border:1px dashed color-mix(in srgb, var(--accent, var(--red)) 65%, transparent);background:color-mix(in srgb, var(--accent, var(--red)) 10%, transparent);font-family:inherit;font-size:1.5cqh;line-height:${lh};padding:1px 4px;color:#111;resize:none;overflow:auto;white-space:pre-wrap;`;
    }

    // 触摸设备没有光标，因此悬停/接近显示永远不会触发 —
    // 在那里，永久显示手柄并使其适合手指大小，以便
    // 框边缘实际上可以抓取。
    const _isTouch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
    const HS = _isTouch ? 28 : 20;       // 手柄大小（像素）
    // 将手柄放在框外 — 内边缘与角相接（无间隙、
    // 无重叠），这样它们不会覆盖你正在输入的文本但保持接近。
    const OFF = -HS;
    const HIDE = _isTouch ? '' : 'none'; // 初始显示（'' = 触摸时显示）

    // × 删除按钮
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✖';
    del.title = t('document.pdf_annotation_delete');
    del.style.cssText = `position:absolute;top:${OFF}px;right:${OFF}px;width:${HS}px;height:${HS}px;padding:0 0 0 1px;border:1px solid var(--accent, var(--red));background:#fff;color:var(--accent, var(--red));border-radius:50%;cursor:pointer;font-size:11px;line-height:1;display:${HIDE};font-weight:bold;touch-action:none;`;

    // ☰ 拖拽手柄 — 与 × 按钮相同大小。
    const grip = document.createElement('div');
    grip.title = t('document.pdf_annotation_drag');
    grip.textContent = '☰';
    grip.style.cssText = `position:absolute;top:${OFF}px;left:${OFF}px;width:${HS}px;height:${HS}px;border:1px solid color-mix(in srgb, var(--accent, var(--red)) 65%, transparent);background:#fff;color:var(--accent, var(--red));border-radius:3px;cursor:move;font-size:11px;line-height:${HS - 2}px;text-align:center;display:${HIDE};touch-action:none;`;

    // ↘ 调整大小手柄 — 与 × 按钮相同大小。
    const resize = document.createElement('div');
    resize.title = t('document.pdf_annotation_resize');
    resize.style.cssText = `position:absolute;bottom:${OFF}px;right:${OFF}px;width:${HS}px;height:${HS}px;border:1px solid color-mix(in srgb, var(--accent, var(--red)) 65%, transparent);background:#fff;color:var(--accent, var(--red));border-radius:3px;cursor:nwse-resize;display:${HIDE};touch-action:none;`;
    resize.innerHTML = '<svg width="14" height="14" viewBox="0 0 10 10" style="display:block;margin:auto;height:100%;"><path d="M2 8 L8 2 M5 8 L8 5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>';

    let menuBtn = null;
    if (kind === 'text') {
      menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.textContent = '…';
      menuBtn.title = t('document.pdf_annotation_options');
      menuBtn.style.cssText = `position:absolute;bottom:${OFF}px;left:${OFF}px;width:${HS}px;height:${HS}px;padding:0;border:1px solid color-mix(in srgb, var(--accent, var(--red)) 65%, transparent);background:#fff;color:var(--accent, var(--red));border-radius:50%;cursor:pointer;font-size:15px;line-height:0.8;display:${HIDE};font-weight:bold;touch-action:none;`;
    }

    // 一起设置手柄可见性；点击/轻触注释本身
    // 将隐藏的控件恢复。
    const _setHandlesVisible = (show) => {
      const dismissed = wrap.dataset.controlsDismissed === '1';
      const v = (show && !dismissed) ? '' : 'none';
      del.style.display = v;
      grip.style.display = v;
      resize.style.display = v;
      if (menuBtn) menuBtn.style.display = v;
    };
    if (!_isTouch) {
      wrap.addEventListener('mouseenter', () => _setHandlesVisible(true));
      wrap.addEventListener('mouseleave', () => _setHandlesVisible(false));
    }
    wrap.addEventListener('pointerdown', (ev) => {
      if (ev.target === del || ev.target === grip || ev.target === resize || ev.target === menuBtn) return;
      wrap.dataset.controlsDismissed = '0';
      _setHandlesVisible(true);
    });

    const ref = { id: ann.id, page: ann.page, x: ann.x, y: ann.y, w: ann.w, h: ann.h, el: input, wrap, kind, _setHandlesVisible };

    if (kind === 'check') {
      // 印章复选标记 — 值是固定的，无需监听。
      ref.value = '✓';
    } else if (kind === 'signature') {
      const _renderSig = async (sigId) => {
        input.innerHTML = '';
        if (!sigId) {
          input.dataset.signatureId = '';
          input.style.background = 'color-mix(in srgb, var(--accent, var(--red)) 10%, transparent)';
          input.style.border = '1px dashed color-mix(in srgb, var(--accent, var(--red)) 65%, transparent)';
          const span = document.createElement('span');
          span.textContent = t('document.pdf_export_sign_here');
          input.appendChild(span);
          return;
        }
        input.dataset.signatureId = sigId;
        try {
          if (!_sigCache.has(sigId)) {
            const r = await fetch(`${API_BASE}/api/signatures`);
            const data = await r.json();
            for (const s of data.signatures || []) _sigCache.set(s.id, s.data_url);
          }
          const dataUrl = _sigCache.get(sigId);
          if (!dataUrl) throw new Error('not found');
          const img = document.createElement('img');
          img.src = dataUrl;
          img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;pointer-events:none;';
          input.appendChild(img);
          input.style.background = 'transparent';
          input.style.border = '1px solid color-mix(in srgb, var(--accent, var(--red)) 45%, transparent)';
        } catch {
          _renderSig('');
        }
      };
      input.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const sig = await signatureModule.pick();
        if (sig) {
          _pushPdfUndoSnapshot();
          _sigCache.set(sig.id, sig.dataUrl);
          await _renderSig(sig.id);
          ref.value = `signature:${sig.id}`;
          _schedulePdfPaneSave();
        }
      });
      // 渲染任何预先存在的签名值
      _renderSig(input.dataset.signatureId);
    } else {
      // 扩展包装以适应输入内容。宽度随最长行增长，
      // 高度随总内容高度增长。永不会缩小 — 用户驱动的
      // 调整大小（角落手柄）被保留。
      let _mirror = null;
      const _autoGrow = () => {
        const pageRect = pageWrap.getBoundingClientRect();
        if (!pageRect.height || !pageRect.width) return;

        // --- 宽度：通过具有相同排版的隐藏镜像 div
        // 测量最长行 ---
        if (!_mirror) {
          _mirror = document.createElement('div');
          _mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:inherit;padding:1px 4px;left:-9999px;top:-9999px;';
          document.body.appendChild(_mirror);
        }
        const cs = window.getComputedStyle(input);
        _mirror.style.fontSize = cs.fontSize;
        _mirror.style.fontWeight = cs.fontWeight;
        _mirror.style.fontFamily = cs.fontFamily;
        _mirror.style.letterSpacing = cs.letterSpacing;
        let widestPx = 0;
        const lines = (input.value || input.placeholder || '').split('\n');
        for (const line of lines) {
          _mirror.textContent = line || ' ';
          if (_mirror.offsetWidth > widestPx) widestPx = _mirror.offsetWidth;
        }
        const neededWPct = ((widestPx + 12) / pageRect.width) * 100;
        if (neededWPct > ref.w) {
          ref.w = Math.min(100 - ref.x, neededWPct);
          wrap.style.width = ref.w + '%';
        }

        // --- 高度：与之前相同的技巧，短暂地让 textarea 适应内容 ---
        const prev = input.style.height;
        input.style.height = 'auto';
        const neededHpx = input.scrollHeight + 4;
        input.style.height = prev || '100%';
        const neededHpct = (neededHpx / pageRect.height) * 100;
        if (neededHpct > ref.h) {
          ref.h = Math.min(100 - ref.y, neededHpct);
          wrap.style.height = ref.h + '%';
        }
      };
      input.addEventListener('input', () => {
        if (wrap.dataset.textUndoCaptured !== '1') {
          _pushPdfUndoSnapshot();
          wrap.dataset.textUndoCaptured = '1';
        }
        ref.value = input.value;
        _autoGrow();
        _schedulePdfPaneSave();
      });
      input.addEventListener('change', () => {
        ref.value = input.value;
        _autoGrow();
        _schedulePdfPaneSave();
      });
      input.addEventListener('focus', () => {
        _pushPdfUndoSnapshot();
        wrap.dataset.textUndoCaptured = '1';
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') input.blur();
      });
      // 初始适应，以防保存的值比保存的高度高
      // （例如，放置框后行高被调大了）。
      requestAnimationFrame(_autoGrow);
      // 暴露出来，以便行距滑块在文档全局间距
      // 更改时可以重新适应每个注释。
      ref._autoGrow = _autoGrow;
    }

    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _pushPdfUndoSnapshot();
      _removeAnnotation(ref);
    });
    // 拖拽重新定位。坐标存储为页面包装的百分比
    // 以便在调整大小时保持。
    grip.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      _pushPdfUndoSnapshot();
      try { grip.setPointerCapture(ev.pointerId); } catch (_) {}
      // 移动时隐藏 × 和调整大小手柄，以免遮挡
      // 框 — 更容易看到它确切落在哪里。释放时恢复。
      del.style.display = 'none';
      resize.style.display = 'none';
      if (menuBtn) menuBtn.style.display = 'none';
      const start = { mx: ev.clientX, my: ev.clientY, x: ref.x, y: ref.y };
      const rect = pageWrap.getBoundingClientRect();
      const onMove = (e) => {
        const dxPct = ((e.clientX - start.mx) / rect.width) * 100;
        const dyPct = ((e.clientY - start.my) / rect.height) * 100;
        ref.x = Math.max(0, Math.min(100 - ref.w, start.x + dxPct));
        ref.y = Math.max(0, Math.min(100 - ref.h, start.y + dyPct));
        wrap.style.left = ref.x + '%';
        wrap.style.top = ref.y + '%';
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        _setHandlesVisible(true);
        _schedulePdfPaneSave();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });

    // 拖拽右下角调整大小。宽/高存储为百分比。
    resize.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      _pushPdfUndoSnapshot();
      try { resize.setPointerCapture(ev.pointerId); } catch (_) {}
      // 调整大小时隐藏 × 和移动手柄 — 框边缘的清晰视图。
      del.style.display = 'none';
      grip.style.display = 'none';
      if (menuBtn) menuBtn.style.display = 'none';
      const start = { mx: ev.clientX, my: ev.clientY, w: ref.w, h: ref.h };
      const rect = pageWrap.getBoundingClientRect();
      const onMove = (e) => {
        const dwPct = ((e.clientX - start.mx) / rect.width) * 100;
        const dhPct = ((e.clientY - start.my) / rect.height) * 100;
        ref.w = Math.max(1, Math.min(100 - ref.x, start.w + dwPct));
        ref.h = Math.max(0.8, Math.min(100 - ref.y, start.h + dhPct));
        wrap.style.width = ref.w + '%';
        wrap.style.height = ref.h + '%';
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        _setHandlesVisible(true);
        _schedulePdfPaneSave();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });

    // 文本选项菜单 — 从浮动的 … 按钮打开，因此
    // 空格控件在输入时不会总是可见。
    if (kind === 'text') {
      const popover = document.createElement('div');
      popover.className = 'pdf-annotation-text-menu';
      popover.style.cssText = `position:absolute;bottom:${OFF + HS + 4}px;left:${OFF}px;display:none;background:#fff;border:1px solid var(--accent, var(--red));border-radius:4px;padding:6px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.2);z-index:10;flex-direction:column;align-items:stretch;gap:6px;font-size:10px;color:#222;white-space:nowrap;`;
      popover.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;">
          <span>${t('document.pdf_annotation_line_spacing')}</span>
          <input type="range" min="1" max="3" step="0.05" value="${ann.lineHeight || 1.3}" style="width:90px;accent-color:var(--accent, var(--red));" />
          <input type="number" class="lh-val" min="0.5" max="5" step="0.01" value="${(ann.lineHeight || 1.3).toFixed(2)}" style="width:54px;font-size:10px;padding:1px 7px 1px 3px;border:1px solid var(--accent, var(--red));border-radius:3px;text-align:right;accent-color:var(--accent, var(--red));" />
        </div>
        <button type="button" class="pdf-ann-today" style="height:22px;padding:0 7px;border:1px solid color-mix(in srgb, var(--accent, var(--red)) 55%, transparent);background:color-mix(in srgb, var(--accent, var(--red)) 10%, transparent);color:var(--accent, var(--red));border-radius:4px;cursor:pointer;font-size:10px;font-family:inherit;text-align:left;">${t('document.pdf_export_today')}</button>
      `;
      const slider = popover.querySelector('input[type="range"]');
      const valInput = popover.querySelector('.lh-val');
      const todayBtn = popover.querySelector('.pdf-ann-today');
      const _applyLh = (v, fromSlider) => {
        if (!Number.isFinite(v)) return;
        if (popover.dataset.lhUndoCaptured !== '1') {
          _pushPdfUndoSnapshot();
          popover.dataset.lhUndoCaptured = '1';
        }
        v = Math.max(0.5, Math.min(5, v));
        // 应用于文档中的每个文本注释，以便间距保持
        // 一致 — 导出曾经"到处都是"，因为每个框
        // 可以有自己的行高；将其视为文档级设置。
        const allRefs = _pdfPaneAnnotationsByDoc.get(activeDocId) || [];
        for (const r of allRefs) {
          if (r.kind !== 'text') continue;
          r.lineHeight = v;
          if (r.el && r.el.style) r.el.style.lineHeight = String(v);
          // 间距变化可能将内容推出框高度 — 触发每个
          // 引用的自动扩展，以便包装扩展以适应新的行高。
          if (typeof r._autoGrow === 'function') r._autoGrow();
        }
        ref.lineHeight = v;
        input.style.lineHeight = String(v);
        if (fromSlider) valInput.value = v.toFixed(2);
        else slider.value = String(Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), v)));
        _pdfLastLineHeight.set(activeDocId, v);
        _schedulePdfPaneSave();
      };
      slider.addEventListener('input', () => _applyLh(parseFloat(slider.value), true));
      valInput.addEventListener('input', () => _applyLh(parseFloat(valInput.value), false));
      // 在失去焦点时拒绝无效输入值 — 弹回实时引用值。
      valInput.addEventListener('blur', () => {
        const v = parseFloat(valInput.value);
        if (!Number.isFinite(v)) valInput.value = (ref.lineHeight || 1.3).toFixed(2);
        popover.dataset.lhUndoCaptured = '0';
      });
      todayBtn.addEventListener('click', () => {
        _pushPdfUndoSnapshot();
        const d = new Date();
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        const text = `${dd}/${mm}/${yyyy}`;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.value = input.value.slice(0, start) + text + input.value.slice(end);
        const next = start + text.length;
        try { input.setSelectionRange(next, next); } catch (_) {}
        ref.value = input.value;
        if (typeof ref._autoGrow === 'function') ref._autoGrow();
        _schedulePdfPaneSave();
        input.focus({ preventScroll: true });
      });
      // 阻止弹出框点击冒泡到 pageWrap（会创建新注释）
      popover.addEventListener('mousedown', (e) => e.stopPropagation());
      popover.addEventListener('click', (e) => e.stopPropagation());
      menuBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        popover.style.display = popover.style.display === 'flex' ? 'none' : 'flex';
      });
      wrap.appendChild(popover);
      ref.lineHeight = ann.lineHeight || 1.3;
    }

    wrap.appendChild(input);
    wrap.appendChild(del);
    wrap.appendChild(grip);
    wrap.appendChild(resize);
    if (menuBtn) wrap.appendChild(menuBtn);
    pageWrap.appendChild(wrap);
    return { wrap, ref };
  }

  function _removeAnnotation(ref) {
    if (!ref || !ref.wrap) return;
    const docId = activeDocId;
    const refs = _pdfPaneAnnotationsByDoc.get(docId) || [];
    const idx = refs.indexOf(ref);
    if (idx >= 0) refs.splice(idx, 1);
    ref.wrap.remove();
    _schedulePdfPaneSave();
  }

  // 提示用户输入指令，并要求后端的 VL 流水线
  // 为 PDF 上的每个空白/标签位置提出注释建议。生成的
  // 注释添加到文档的 markdown 中，PDF 面板
  // 重新渲染，以便用户可以查看/编辑/拖拽/删除每个注释。
  async function _aiFillAnnotations() {
    const docId = activeDocId;
    if (!docId) return;
    const doc = docs.get(docId);
    if (!doc) return;

    const instruction = window.prompt(
      t('document.pdf_ai_fill_prompt')
    );
    if (!instruction || !instruction.trim()) return;

    _setPdfSaveStatus('saving');
    const btn = document.getElementById('doc-pdf-ai-fill-btn');
    if (btn) { btn.disabled = true; btn.textContent = t('document.pdf_ai_fill_thinking'); }
    try {
      const res = await fetch(`${API_BASE}/api/document/${docId}/ai-fill-annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: instruction.trim() }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => res.statusText);
        throw new Error(t || res.statusText);
      }
      const data = await res.json();
      const proposed = (data && data.annotations) || [];
      if (!proposed.length) {
        _setPdfSaveStatus('idle');
        if (uiModule && uiModule.showToast) uiModule.showToast(t('document.pdf_ai_fill_nothing'));
        return;
      }
      // 通过相同的 _writeAnnotations 路径合并到 markdown：解析当前，
      // 追加提议（每个获得新 ID），持久化，然后重新渲染。
      const existing = _parseAnnotations(doc.content || '');
      const combined = existing.slice();
      for (const a of proposed) {
        combined.push({
          id: _newAnnotationId(),
          page: parseInt(a.page, 10) || 1,
          x: Math.max(0, Math.min(100, parseFloat(a.x) || 0)),
          y: Math.max(0, Math.min(100, parseFloat(a.y) || 0)),
          w: Math.max(0.5, Math.min(100, parseFloat(a.w) || 22)),
          h: Math.max(0.3, Math.min(100, parseFloat(a.h) || 3.5)),
          value: String(a.value || ''),
        });
      }
      const newMd = _writeAnnotations(doc.content || '', combined);
      doc.content = newMd;
      const ta = document.getElementById('doc-editor-textarea');
      if (ta) ta.value = newMd;
      const r2 = await fetch(`${API_BASE}/api/document/${docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newMd }),
      });
      if (!r2.ok) {
        const t = await r2.text().catch(() => r2.statusText);
        throw new Error(t || r2.statusText);
      }
      _setPdfSaveStatus('saved');
      if (uiModule && uiModule.showToast) uiModule.showToast(t('document.pdf_ai_fill_added', { n: proposed.length }));
      _renderPdfPane();
    } catch (e) {
      console.error('AI fill failed:', e);
      _setPdfSaveStatus('error', `AI fill failed: ${e.message || e}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = t('document.pdf_ai_fill_button'); }
    }
  }

  function _schedulePdfPaneSave() {
    _setPdfSaveStatus('dirty');
    if (_pdfPaneSaveTimer) clearTimeout(_pdfPaneSaveTimer);
    _pdfPaneSaveTimer = setTimeout(() => _savePdfPaneToMarkdown(), 600);
  }

  function _setPdfSaveStatus(status, msg) {
    const pill = document.getElementById('doc-pdf-save-pill');
    if (!pill) return;
    const palette = {
      idle:   { txt: '',           bg: 'transparent',           fg: 'transparent' },
      dirty:  { txt: t('document.status_editing'),   bg: 'var(--panel)',          fg: 'var(--fg)' },
      saving: { txt: t('document.status_saving'),    bg: 'var(--panel)',          fg: 'var(--fg)' },
      saved:  { txt: t('document.status_saved'),      bg: 'rgba(34,197,94,0.85)',  fg: '#fff' },
      error:  { txt: msg || t('document.status_save_failed'), bg: 'var(--red)',    fg: 'var(--bg)' },
    };
    const p = palette[status] || palette.idle;
    pill.textContent = p.txt;
    pill.style.background = p.bg;
    pill.style.color = p.fg;
    pill.style.display = p.txt ? '' : 'none';
    if (status === 'saved') {
      setTimeout(() => {
        if (pill.textContent === t('document.status_saved')) _setPdfSaveStatus('idle');
      }, 1200);
    }
  }

  async function _savePdfPaneToMarkdown(opts = {}) {
    _pdfPaneSaveTimer = null;
    const docId = activeDocId;
    const fields = _pdfPaneFieldsByDoc.get(docId) || [];
    const annotations = _pdfPaneAnnotationsByDoc.get(docId) || [];
    if (!docId || (!fields.length && !annotations.length)) return false;
    const doc = docs.get(docId);
    if (!doc) return false;

    let md = doc.content || '';
    let changed = 0;
    for (const ref of fields) {
      // 服务端渲染对 [A-Za-z0-9_.-] 之外的所有内容进行百分号编码。
      // 精确匹配，以便原始 AcroForm 名称中的
      // 空格/换行/括号/逗号/`?` 不会破坏正则表达式。
      const encName = _encodeFieldName(ref.name);
      const re = new RegExp(
        `^(\\s*-\\s+)(.*?)(\\s*<!--\\s*field=${encName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s+type=\\w+\\s*-->\\s*)$`,
        'm'
      );
      const m = md.match(re);
      if (!m) continue;
      const body = m[2];
      let newBody = body;
      if (ref.type === 'checkbox') {
        const mark = ref.el.checked ? '[x]' : '[ ]';
        newBody = body.replace(/^\s*\[[ xX]\]/, mark);
      } else if (ref.type === 'choice') {
        const v = ref.el.value || '_(not selected)_';
        newBody = body.replace(/(\][\s]*:[ ]*).*$/, `$1${v}`);
      } else if (ref.type === 'signature') {
        const sid = ref.el.dataset.signatureId || '';
        const v = sid ? `signature:${sid}` : '_(unsigned)_';
        newBody = body.replace(/(:\*\*[ ]*).*$/, `$1${v}`);
      } else {
        const v = ref.el.value === '' ? '_(empty)_' : ref.el.value;
        newBody = body.replace(/(:\*\*[ ]*).*$/, `$1${v}`);
      }
      if (newBody !== body) {
        md = md.replace(re, `${m[1]}${newBody}${m[3]}`);
        changed++;
      }
    }
    // 从实时引用集重写自由格式注释部分，以便
    // 创建/编辑/移动/删除全部一次性持久化。
    md = _writeAnnotations(md, annotations.map(a => {
      let value = '';
      if (a.kind === 'check') {
        value = '✓';
      } else if (a.kind === 'signature') {
        const sid = a.el && a.el.dataset && a.el.dataset.signatureId;
        value = sid ? `signature:${sid}` : '';
      } else {
        value = (a.el && typeof a.el.value === 'string') ? a.el.value : '';
      }
      return {
        id: a.id, page: a.page, x: a.x, y: a.y, w: a.w, h: a.h,
        kind: a.kind || 'text',
        lineHeight: a.lineHeight || 1.3,
        value,
      };
    }));
    if (md === doc.content) {
      _setPdfSaveStatus('idle');
      return true;
    }
    doc.content = md;
    const ta = document.getElementById('doc-editor-textarea');
    if (ta) ta.value = md;
    _setPdfSaveStatus('saving');
    try {
      const res = await fetch(`${API_BASE}/api/document/${docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: md }),
        keepalive: !!opts.keepalive,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => res.statusText);
        _setPdfSaveStatus('error', `Save failed: ${res.status}`);
        console.warn('PDF-pane save HTTP error:', res.status, t);
        return false;
      }
      _setPdfSaveStatus('saved');
      return true;
    } catch (e) {
      _setPdfSaveStatus('error', e.message || t('document.status_save_failed'));
      console.warn('PDF-pane save failed:', e);
      return false;
    }
  }

  // 在导航离开之前刷新所有待处理的防抖保存
  window.addEventListener('beforeunload', () => {
    if (_pdfPaneSaveTimer) {
      clearTimeout(_pdfPaneSaveTimer);
      _savePdfPaneToMarkdown({ keepalive: true });
    }
  });

  async function _refreshPdfPreviewIframe() {
    // 从后端当前的解析值重新渲染面板。
    // 首先刷新任何防抖的用户编辑，以免覆盖它。
    const pane = document.getElementById('doc-pdf-view');
    if (!pane || !activeDocId) return;
    if (pane.style.display === 'none') return;
    if (_pdfPaneSaveTimer) {
      clearTimeout(_pdfPaneSaveTimer);
      await _savePdfPaneToMarkdown();
    }
    _renderPdfPane();
  }

  async function _setPdfViewActive(active) {
    const pane = document.getElementById('doc-pdf-view');
    const wrap = document.getElementById('doc-editor-wrap');
    const btn = document.getElementById('doc-pdf-view-btn');
    if (!pane || !wrap) return;
    if (active) {
      _pdfViewState.set(activeDocId, true);
      wrap.style.display = 'none';
      pane.style.display = '';
      _renderPdfPane();
      btn?.classList.add('active');
    } else {
      // 在拆除字段引用之前刷新任何待处理的防抖编辑。
      if (_pdfPaneSaveTimer) {
        clearTimeout(_pdfPaneSaveTimer);
        await _savePdfPaneToMarkdown();
      }
      _pdfViewState.set(activeDocId, false);
      pane.style.display = 'none';
      // 在渲染间保留保存标记
      const savedPill = document.getElementById('doc-pdf-save-pill');
      pane.innerHTML = '';
      if (savedPill) pane.appendChild(savedPill);
      _pdfPaneFieldsByDoc.delete(activeDocId);
      _pdfPaneAnnotationsByDoc.delete(activeDocId);
      wrap.style.display = '';
      btn?.classList.remove('active');
    }
  }

  // 当顶部标题栏中没有任何可见内容时隐藏它。Undo 和类型选择器
  // 移到页脚后，移动端的纯文档会显示一个
  // 空栏（"第二页脚"）。无重排（仅读取内联显示）因此
  // 可以在每个 stream 补丁上从 _syncHeaderActions 安全调用。桌面端
  // 该栏始终显示（它仍承载 Fullscreen + 版本标记）；
  // 移动端仅在上下文控件活动时显示。
  function _syncHeaderBarVisibility() {
    const hdr = document.getElementById('doc-editor-actions');
    if (!hdr) return;
    // 邮件文档隐藏整个标题（它们使用自己的发送页脚）— 永远不要
    // 在这里恢复它。
    if (docs.get(activeDocId)?.language === 'email') { hdr.style.display = 'none'; return; }
    const vis = (id) => {
      const e = document.getElementById(id);
      if (!e || !e.parentElement) return false;
      // 只计算仍然存在于标题本身的项目 — 运行时
      // 重排（~3217 行）将几个按钮移入页脚，并且
      // 我们不希望停放在其他位置的按钮使这一顶行保持活跃。
      if (!hdr.contains(e)) return false;
      return e.style.display !== 'none';
    };
    // 当这里不再有可见内容时隐藏整个标题。没有这个
    // 每个桌面视图都会在真正的操作页脚上方渲染一个空的
    // doc-editor-header — 一个重复的行。
    const visible = vis('doc-stream-indicator')
      || vis('doc-version-badge')
      || vis('doc-export-pdf-btn')
      || vis('doc-pdf-view-btn');
    hdr.style.display = visible ? '' : 'none';
  }

  function _syncHeaderActions() {
    const actionBtn = document.getElementById('doc-header-preview-btn');
    const exportBtn = document.getElementById('doc-export-pdf-btn');
    const pdfViewBtn = document.getElementById('doc-pdf-view-btn');
    const pdfPane = document.getElementById('doc-pdf-view');
    const langSelect = document.getElementById('doc-language-select');
    const live = document.getElementById('doc-editor-textarea')?.value
      || docs.get(activeDocId)?.content
      || '';
    const isForm = _isFormBackedDoc(live);
    // 页脚主按钮：对于从邮件附件打开的文档，将
    // Copy 按钮变形为 "Reply"（通过签名回复流程将
    // 填充的文件发回给发件人）。否则是普通的 Copy 操作。点击
    // 处理程序根据 data-mode 分支。
    const _copyBtn = document.getElementById('doc-footer-copy-btn');
    if (_copyBtn) {
      const _ad = docs.get(activeDocId);
      const _replyable = !!(_ad && _ad.sourceEmailUid && _ad.sourceEmailFolder);
      if (_replyable && _copyBtn.dataset.mode !== 'reply') {
        _copyBtn.dataset.mode = 'reply';
        _copyBtn.title = t('document.email_reply_title');
        _copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' + t('document.email_attach_text');
      } else if (!_replyable && _copyBtn.dataset.mode !== 'copy') {
        _copyBtn.dataset.mode = 'copy';
        _copyBtn.title = t('document.email_copy_title');
        _copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' + t('common.copy');
      }
    }
    // 独立的 Export PDF / PDF-toggle 图标按钮已废弃 — 对于
    // 表单支持的文档，语言选择器本身在
    // "pdf"（渲染视图）和 "markdown"（源视图）之间切换。
    if (exportBtn) exportBtn.style.display = 'none';
    if (pdfViewBtn) pdfViewBtn.style.display = 'none';
    if (true) {
      const explicit = _pdfViewState.get(activeDocId);
      const active = isForm && explicit !== false;
      // 将语言选择器的显示值与当前视图同步。
      if (isForm && langSelect) {
        const want = active ? 'pdf' : 'markdown';
        if (langSelect.value !== want) langSelect.value = want;
      }
      if (pdfPane) {
        if (active) {
          if (pdfPane.style.display === 'none') {
            const wrap = document.getElementById('doc-editor-wrap');
            if (wrap) wrap.style.display = 'none';
            pdfPane.style.display = '';
            _renderPdfPane();
          }
        } else if (pdfPane.style.display !== 'none') {
          pdfPane.style.display = 'none';
          pdfPane.innerHTML = '';
          const wrap = document.getElementById('doc-editor-wrap');
          if (wrap) wrap.style.display = '';
        }
      }
    }
    if (!actionBtn) return;

    const lang = (document.getElementById('doc-language-select')?.value || '').toLowerCase();
    const canPreview = ['markdown', 'csv'].includes(lang) || _isRenderLang(lang);
    const canRun = ['javascript', 'js', 'python', 'py', 'bash', 'sh', 'shell', 'zsh'].includes(lang);

    const _eyeIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    const _penIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
    const _playIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    const _codeIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';

    // 检查活动状态
    const _mdPreview = document.getElementById('doc-md-preview');
    const _csvPreview = document.getElementById('doc-csv-preview');
    const _htmlPreview = document.getElementById('doc-html-preview');
    const _outputPanel = document.getElementById('doc-run-output');
    const _mdActive = _mdPreview && _mdPreview.style.display !== 'none';
    const _csvActive = _csvPreview && _csvPreview.style.display !== 'none';
    const _htmlActive = _htmlPreview && _htmlPreview.style.display !== 'none';
    const _outputActive = _outputPanel && _outputPanel.style.display !== 'none';

    let show = false;
    actionBtn.classList.remove('active');

    // markdown Edit/Preview 切换是双图标开关；其他模式使用
    // 单个动态预览按钮。
    const mdToggle = document.getElementById('doc-md-view-toggle');
    if (mdToggle) mdToggle.style.display = (lang === 'markdown') ? 'inline-flex' : 'none';
    const renderToggle = document.getElementById('doc-render-view-toggle');
    if (renderToggle) {
      renderToggle.style.display = _hasViewToggle(lang) ? 'inline-flex' : 'none';
      // 交换 "run" 侧的图标以匹配语言实际功能：
      //   CSV → 四象限网格（表格视图）
      //   HTML / SVG / XML → 眼睛（渲染预览）
      //   Python / JS / TS / bash → 播放三角形（运行代码）
      const runBtn = renderToggle.querySelector('[data-renderview="run"]');
      if (runBtn) {
        let icon, title;
        if (lang === 'csv') {
          icon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>';
          title = t('document.code_table_view');
        } else if (_isRenderLang(lang)) {
          icon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
          title = t('document.code_preview');
        } else {
          icon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
          title = t('document.code_run');
        }
        if (runBtn.dataset.lastIcon !== lang) {
          runBtn.innerHTML = icon;
          runBtn.title = title;
          runBtn.dataset.lastIcon = lang;
        }
      }
      // 也交换 "code" 侧的图标 — CSV 的 "code" 实际上意味着
      // "编辑底层电子表格文本"，因此铅笔比
      // 实际代码使用的 </> 括号更易读。
      const codeBtn = renderToggle.querySelector('[data-renderview="code"]');
      if (codeBtn) {
        const codeIco = (lang === 'csv')
          ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>'
          : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
        const codeTitle = (lang === 'csv') ? t('document.code_edit') : t('document.code_edit_code');
        if (codeBtn.dataset.lastIcon !== lang) {
          codeBtn.innerHTML = codeIco;
          codeBtn.title = codeTitle;
          codeBtn.dataset.lastIcon = lang;
        }
      }
      // 反映当前活动的一侧，以便切换显示与
      // markdown 的 Edit/Preview 开关相同的视觉反馈（背景色调
      // + .md-view-toggle .md-view-opt.active 的"punch"弹出动画）。
      // 对于 CSV，run 端 = 表格视图；HTML/SVG/XML = iframe 预览；
      // 对于可运行语言 = 输出面板打开。
      let _viewActive = false;
      if (lang === 'csv') _viewActive = _csvActive;
      else if (_isRenderLang(lang)) _viewActive = _htmlActive;
      else _viewActive = _outputActive;
      const _codeBtn2 = renderToggle.querySelector('[data-renderview="code"]');
      const _runBtn2 = renderToggle.querySelector('[data-renderview="run"]');
      _codeBtn2?.classList.toggle('active', !_viewActive);
      _runBtn2?.classList.toggle('active', _viewActive);
    }

    if (lang === 'markdown') {
      show = false;
      if (mdToggle) {
        mdToggle.querySelector('[data-mdview="edit"]')?.classList.toggle('active', !_mdActive);
        mdToggle.querySelector('[data-mdview="preview"]')?.classList.toggle('active', _mdActive);
      }
    } else if (lang === 'csv') {
      show = true;
      actionBtn.innerHTML = _csvActive ? _penIco : '<span style="font-size:12px;font-weight:600;">⊞</span>';
      actionBtn.title = _csvActive ? t('document.code_edit') : t('document.code_table_view');
      if (_csvActive) actionBtn.classList.add('active');
    } else if (_isRenderLang(lang)) {
      // SVG/HTML/XML 使用分段 Code </> | Run ▶ 开关切换
      // （像 markdown 的 edit/preview 开关）而不是单个按钮。
      show = false;
      if (renderToggle) {
        renderToggle.querySelector('[data-renderview="code"]')?.classList.toggle('active', !_htmlActive);
        renderToggle.querySelector('[data-renderview="run"]')?.classList.toggle('active', _htmlActive);
      }
    } else if (canRun) {
      show = true;
      actionBtn.innerHTML = _outputActive ? _codeIco : _playIco;
      actionBtn.title = _outputActive ? t('document.code_hide_output') : t('document.code_run');
      if (_outputActive) actionBtn.classList.add('active');
    }

    // 统一分段 Code/Run-or-View 切换 (`#doc-render-view-toggle`)
    // 覆盖 CSV / Python / JS / bash / HTML / SVG / XML。显示时，
    // 抑制单个变形按钮以避免两个冗余控件。
    if (_hasViewToggle(lang)) show = false;
    actionBtn.style.display = show ? '' : 'none';

    // 上下文按钮的可见性已确定后，如果栏最终为空则折叠它
    // （常见的移动端纯文档情况）。
    _syncHeaderBarVisibility();
  }

  // ── 邮件文档类型辅助函数 ──

  function _parseEmailHeader(content) {
    const empty = { to: '', cc: '', bcc: '', subject: '', inReplyTo: '', references: '', sourceUid: '', sourceFolder: '', attachments: [], body: content || '' };
    if (!content) return empty;
    const parts = content.split(/\n---\n/);
    if (parts.length < 2) return empty;
    const header = parts[0];
    const body = parts.slice(1).join('\n---\n');
    const fields = { to: '', cc: '', bcc: '', subject: '', inReplyTo: '', references: '', sourceUid: '', sourceFolder: '', attachments: [], body: body };
    for (const line of header.split('\n')) {
      const m = line.match(/^(To|Cc|Bcc|Subject|In-Reply-To|References|X-Source-UID|X-Source-Folder|X-Attachments):\s*(.*)$/i);
      if (m) {
        let key = m[1].toLowerCase();
        if (key === 'in-reply-to') key = 'inReplyTo';
        else if (key === 'x-source-uid') key = 'sourceUid';
        else if (key === 'x-source-folder') key = 'sourceFolder';
        else if (key === 'x-attachments') {
          fields.attachments = m[2].trim().split('|').map(a => {
            const [index, filename, size] = a.split(':');
            return { index: parseInt(index), filename, size: parseInt(size) };
          });
          continue;
        }
        fields[key] = m[2].trim();
      }
    }
    return fields;
  }

  function _buildEmailContent(to, subject, inReplyTo, references, body, sourceUid, sourceFolder, cc, bcc) {
    let header = `To: ${to}`;
    if (cc) header += `\nCc: ${cc}`;
    if (bcc) header += `\nBcc: ${bcc}`;
    header += `\nSubject: ${subject}`;
    if (inReplyTo) header += `\nIn-Reply-To: ${inReplyTo}`;
    if (references) header += `\nReferences: ${references}`;
    if (sourceUid) header += `\nX-Source-UID: ${sourceUid}`;
    if (sourceFolder) header += `\nX-Source-Folder: ${sourceFolder}`;
    return header + '\n---\n' + body;
  }

  // ── WYSIWYG 邮件正文辅助函数 ──
  function _emailBodyToHtml(text) {
    const t = (text || '').trim();
    if (!t) return '';
    // 如果已包含格式化/结构化 HTML 标签，则是已保存的
    // WYSIWYG 正文 — 直接使用。（检查前导 '<' 不够：
    // 富文本正文通常以纯文本开头，例如 "Hi <b>there</b>"。）
    if (/<\/?(b|i|u|s|strong|em|del|strike|a|p|div|br|ul|ol|li|h[1-3]|blockquote|span|code|pre)\b[^>]*>/i.test(t)) return t;
    // 邮件正文：保持作者输入的 `:shortcode:` 文本字面量。Issue #345
    // （shortcode → emoji）仅限于聊天；不要在邮件中重写冒号。
    try { return markdownModule.mdToHtml(text, { shortcodes: false }); }
    catch (_) {
      const d = document.createElement('div'); d.textContent = text;
      return d.innerHTML.replace(/\n/g, '<br>');
    }
  }
  // 将富文本正文的纯文本镜像到隐藏的 textarea 中，以便现有的
  // send / draft / change-detection 管道（读取 textarea）保持
  // 有效。富文本正文的 HTML 在发送时单独读取（body_html）。
  function _syncEmailRichbody(rich) {
    const ta = document.getElementById('doc-editor-textarea');
    if (!ta) return;
    ta.value = rich.innerText;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function _wireEmailRichbody(rich) {
    if (rich._wired) { _syncEmailRichbody(rich); return; }
    rich._wired = true;
    rich.addEventListener('input', () => _syncEmailRichbody(rich));
    // 当光标位于格式化文本中时高亮工具栏按钮（B / I / S、标题、列表）。
    // queryCommandState 反映实时选择 —
    // 我们只需将其转换为 CSS 已经理解的 .is-active 类。
    // 
    const syncActive = () => {
      if (!rich.isConnected || rich.style.display === 'none') return;
      // 仅当焦点在富文本正文内时同步 — 否则外部的选择
      // （例如点击工具栏本身）会给出误导性状态。
      if (!rich.contains(document.activeElement) && document.activeElement !== rich) return;
      const tb = document.getElementById('doc-md-toolbar');
      if (!tb) return;
      const set = (sel, on) => { const b = tb.querySelector(sel); if (b) b.classList.toggle('is-active', !!on); };
      try {
        set('[data-md="bold"]',   document.queryCommandState('bold'));
        set('[data-md="italic"]', document.queryCommandState('italic'));
        set('[data-md="strike"]', document.queryCommandState('strikeThrough'));
      } catch (_) {}
      // 块级：标题/列表下拉切换从当前块标签
      // 读取其活动状态。
      const cur = _currentBlockTag(rich);
      const hBtn = tb.querySelector('[data-dd="heading"]');
      if (hBtn) hBtn.classList.toggle('is-active', cur === 'h1' || cur === 'h2' || cur === 'h3');
      try {
        const inList = document.queryCommandState('insertOrderedList') || document.queryCommandState('insertUnorderedList');
        const lBtn = tb.querySelector('[data-dd="list"]');
        if (lBtn) lBtn.classList.toggle('is-active', !!inList);
      } catch (_) {}
    };
    rich.addEventListener('keyup',    syncActive);
    rich.addEventListener('mouseup',  syncActive);
    rich.addEventListener('focus',    syncActive);
    rich.addEventListener('input',    syncActive);
    // selectionchange 在文档上触发；过滤到富文本内的选择。
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && rich.contains(sel.anchorNode)) syncActive();
    });
    rich._syncActive = syncActive;
  }
  function _emailRichbodyActive() {
    const r = document.getElementById('doc-email-richbody');
    return r && r.style.display !== 'none' ? r : null;
  }

  function _captureEmailBodyFocusState() {
    const rich = _emailRichbodyActive();
    const ta = document.getElementById('doc-editor-textarea');
    const active = document.activeElement;
    if (rich && (active === rich || rich.contains(active))) {
      const sel = window.getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      return {
        type: 'rich',
        range: range && rich.contains(range.commonAncestorContainer) ? range.cloneRange() : null,
      };
    }
    if (ta && active === ta) {
      return {
        type: 'textarea',
        start: ta.selectionStart,
        end: ta.selectionEnd,
      };
    }
    return null;
  }

  function _restoreEmailBodyFocusState(state) {
    if (!state) return;
    requestAnimationFrame(() => {
      if (state.type === 'rich') {
        const rich = _emailRichbodyActive();
        if (!rich) return;
        rich.focus({ preventScroll: true });
        if (state.range) {
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(state.range);
          }
        }
      } else if (state.type === 'textarea') {
        const ta = document.getElementById('doc-editor-textarea');
        if (!ta) return;
        ta.focus({ preventScroll: true });
        if (Number.isFinite(state.start) && Number.isFinite(state.end)) {
          try { ta.setSelectionRange(state.start, state.end); } catch (_) {}
        }
      }
    });
  }

  function _stripEmailReplyQuoteText(text) {
    const original = String(text || '');
    if (!original) return { body: '', stripped: false };
    const lines = original.split('\n');
    const quoteIdx = lines.findIndex(line =>
      /^-{5,}\s*Previous message\s*-{5,}$/i.test(line.trim())
      || /^On .+ wrote:\s*$/i.test(line.trim())
    );
    if (quoteIdx <= 0) return { body: original.trim(), stripped: false };
    const body = lines.slice(0, quoteIdx).join('\n').trim();
    return { body, stripped: !!body };
  }

  function _emailReplyOwnText(text) {
    return _stripEmailReplyQuoteText(text).body;
  }

  function _setEmailBodyText(textarea, value) {
    if (!textarea) return;
    textarea.value = value || '';
    syncHighlighting();
    const rich = _emailRichbodyActive();
    if (rich) rich.innerHTML = _emailBodyToHtml(textarea.value);
  }

  async function _streamEmailBodyText(textarea, value) {
    if (!textarea) return;
    const finalText = String(value || '');
    const maxFrames = 90;
    const chunk = Math.max(8, Math.ceil(finalText.length / maxFrames));
    textarea.value = '';
    const rich = _emailRichbodyActive();
    if (rich) rich.innerHTML = '';
    for (let i = 0; i < finalText.length; i += chunk) {
      const next = finalText.slice(0, i + chunk);
      textarea.value = next;
      if (rich) rich.innerHTML = _emailBodyToHtml(next);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    _setEmailBodyText(textarea, finalText);
  }

  function _focusEmailBodyEnd() {
    const target = _emailRichbodyActive() || document.getElementById('doc-editor-textarea');
    if (!target) return;
    target.focus();
    if (target.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else if (typeof target.setSelectionRange === 'function') {
      const len = target.value.length;
      target.setSelectionRange(len, len);
    }
  }

  function _syncEmailHeaderSummary() {
    const to = document.getElementById('doc-email-to')?.value?.trim() || t('document.email_no_recipient');
    const subject = document.getElementById('doc-email-subject')?.value?.trim() || t('document.email_no_subject');
    const cc = document.getElementById('doc-email-cc')?.value?.trim() || '';
    const bcc = document.getElementById('doc-email-bcc')?.value?.trim() || '';
    const summary = document.getElementById('doc-email-collapse-summary');
    if (!summary) return;
    const extras = [];
    if (cc) extras.push(t('document.email_cc_label'));
    if (bcc) extras.push(t('document.email_bcc_label'));
    summary.textContent = `${to} · ${subject}${extras.length ? ` · ${extras.join('/')}` : ''}`;
    summary.title = summary.textContent;
  }

  function _setEmailHeaderCollapsed(collapsed, { manual = true } = {}) {
    const header = document.getElementById('doc-email-header');
    const btn = document.getElementById('doc-email-collapse-btn');
    if (!header) return;
    if (window.innerWidth > 768) collapsed = false;
    header.classList.toggle('doc-email-header-collapsed', !!collapsed);
    if (btn) {
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.title = collapsed ? t('document.email_show_fields') : t('document.email_hide_fields');
    }
    const doc = activeDocId && docs.get(activeDocId);
    if (doc && manual) doc._emailHeaderCollapsed = !!collapsed;
    if (manual && !collapsed) _emailHeaderManualExpandUntil = Date.now() + 1400;
    _syncEmailHeaderSummary();
  }

  function _shouldAutoCollapseEmailHeader() {
    return window.innerWidth <= 768;
  }

  function _maybeAutoCollapseEmailHeader() {
    const doc = activeDocId && docs.get(activeDocId);
    if (!doc || doc.language !== 'email') return;
    if (Date.now() < _emailHeaderManualExpandUntil) return;
    if (document.activeElement?.closest?.('#doc-email-fields')) return;
    if (_shouldAutoCollapseEmailHeader()) _setEmailHeaderCollapsed(true, { manual: false });
  }

  function _showEmailFields(doc) {
    const emailHeader = document.getElementById('doc-email-header');
    const emailActions = document.getElementById('doc-email-actions');
    // 邮件也显示 MD 工具栏（B、I 等）
    const mdToolbar = document.getElementById('doc-md-toolbar');
    if (mdToolbar) {
      mdToolbar.style.display = '';
      if (mdToolbar._syncOverflow) requestAnimationFrame(mdToolbar._syncOverflow);
    }
    // 隐藏邮件中没有干净 WYSIWYG 等价物的工具栏项目（Code）。
    document.querySelectorAll('.md-toolbar-email-hide').forEach(el => { el.style.display = 'none'; });
    if (emailHeader) emailHeader.style.display = '';
    if (emailActions) emailActions.style.display = '';
    // 邮件有自己的完整页脚（Close / More / Send），因此隐藏
    // 通用文档操作栏和通用底部页脚。TYPE
    // 选择器是例外 — 将其重新定位到邮件页脚中，以便
    // 类型切换功能在所有文档的相同页脚位置。
    const docActions = document.getElementById('doc-editor-actions');
    if (docActions) docActions.style.display = 'none';
    const docFooter = document.getElementById('doc-actions-footer');
    if (docFooter) docFooter.style.display = 'none';
    if (emailActions) {
      const _lang = document.getElementById('doc-language-select');
      const _sendSplit = emailActions.querySelector('.email-send-split');
      if (_lang && _sendSplit) emailActions.insertBefore(_lang, _sendSplit);
    }
    // 邮件撰写使用彩色系统表情符号字体
    document.getElementById('doc-editor-textarea')?.classList.add('email-mode');
    document.getElementById('doc-editor-code')?.classList.add('email-mode');
    document.getElementById('doc-editor-highlight')?.classList.add('email-mode');
    const fields = _parseEmailHeader(doc.content || '');
    const toInput = document.getElementById('doc-email-to');
    const subjectInput = document.getElementById('doc-email-subject');
    const inReplyTo = document.getElementById('doc-email-in-reply-to');
    const refs = document.getElementById('doc-email-references');
    const textarea = document.getElementById('doc-editor-textarea');
    if (toInput) toInput.value = fields.to;
    if (subjectInput) subjectInput.value = fields.subject;
    _setEmailHeaderCollapsed(!!(doc && doc._emailHeaderCollapsed), { manual: false });
    if (subjectInput && !subjectInput._emailTabBodyBound) {
      subjectInput._emailTabBodyBound = true;
      subjectInput.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          _focusEmailBodyEnd();
        }
      });
    }
    if (inReplyTo) inReplyTo.value = fields.inReplyTo;
    if (refs) refs.value = fields.references;
    const sourceUid = document.getElementById('doc-email-source-uid');
    const sourceFolder = document.getElementById('doc-email-source-folder');
    if (sourceUid) sourceUid.value = fields.sourceUid || '';
    if (sourceFolder) sourceFolder.value = fields.sourceFolder || '';
    // 仅当我们有源 UID 时（来自收件箱）显示/隐藏未读按钮
    const unreadBtn = document.getElementById('doc-email-unread-btn');
    if (unreadBtn) unreadBtn.style.display = fields.sourceUid ? '' : 'none';
    // 渲染附件标签
    const attDiv = document.getElementById('doc-email-attachments');
    if (attDiv) {
      attDiv.innerHTML = '';
      if (fields.attachments && fields.attachments.length > 0 && fields.sourceUid) {
        attDiv.style.display = '';
        for (const att of fields.attachments) {
          const isPdf = (att.filename || '').toLowerCase().endsWith('.pdf');
          const sizeKb = att.size > 0 ? `${Math.round(att.size / 1024)} KB` : '';
          const chipHtml = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg><span>${_escHtml(att.filename)}</span><span class="att-size">${sizeKb}</span>`;
          // 辅助函数：忙碌时将标签内容替换为旋转加载器。
          const _withSpinner = async (chip, fn) => {
            if (chip.dataset.loading === '1') return;
            chip.dataset.loading = '1';
            const orig = chip.innerHTML;
            chip.innerHTML = '';
            const sp = spinnerModule.createWhirlpool(14);
            sp.style.marginRight = '6px';
            chip.appendChild(sp);
            const lbl = document.createElement('span');
            lbl.textContent = att.filename;
            chip.appendChild(lbl);
            try { await fn(); }
            finally { chip.dataset.loading = ''; chip.innerHTML = orig; }
          };
          if (isPdf) {
            // PDF：在应用内 PDF 查看器中作为新文档标签打开
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'email-attachment-chip email-attachment-chip-pdf';
            // 悬停时显示完整文件名 — 标签省略号截断长名称。
            chip.title = att.filename;
            chip.innerHTML = chipHtml;
            chip.addEventListener('click', () => _withSpinner(chip, async () => {
              try {
                const folderQs = encodeURIComponent(fields.sourceFolder || 'INBOX');
                const res = await fetch(`${API_BASE}/api/email/attachment-as-doc/${encodeURIComponent(fields.sourceUid)}/${att.index}?folder=${folderQs}`, { method: 'POST' });
                const data = await res.json();
                if (data.doc_id) {
                  await loadDocument(data.doc_id);
                } else if (uiModule) {
                  uiModule.showError(data.error || t('document.pdf_view_load_failed') + 'PDF');
                  window.open(`${API_BASE}/api/email/attachment/${encodeURIComponent(fields.sourceUid)}/${att.index}?folder=${folderQs}`, '_blank');
                }
              } catch (e) {
                console.error('Open PDF attachment failed:', e);
                if (uiModule) uiModule.showError(t('document.pdf_view_load_failed') + 'PDF');
              }
            }));
            attDiv.appendChild(chip);
          } else {
            // 非 PDF：通过 fetch+blob+anchor 下载 — 浏览器原生下载
            // 使用 target=_blank 在某些浏览器中不可靠（点击
            // 无效果）。blob 路径每次都强制打开真正的保存对话框。
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'email-attachment-chip';
            // 悬停时显示完整文件名，用于标签省略号截断的标签。
            chip.title = `Download ${att.filename}`;
            chip.innerHTML = chipHtml;
            chip.addEventListener('click', () => _withSpinner(chip, async () => {
              try {
                const folderQs = encodeURIComponent(fields.sourceFolder || 'INBOX');
                const res = await fetch(`${API_BASE}/api/email/attachment/${encodeURIComponent(fields.sourceUid)}/${att.index}?folder=${folderQs}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = att.filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                console.error('Download attachment failed:', e);
                if (uiModule) uiModule.showError(t('document.pdf_view_load_failed') + 'PDF: ' + e.message);
              }
            }));
            attDiv.appendChild(chip);
          }
        }
      } else {
        attDiv.style.display = 'none';
      }
    }
    if (textarea) {
      textarea.value = fields.body;
      // 存储原始正文以用于关闭时的更改检测
      if (doc) doc._originalBody = fields.body;
      syncHighlighting();
    }
    // WYSIWYG：将源编辑器替换为富文本正文并渲染 markdown。
    // 上面的 textarea 保持为纯文本镜像（下面保持同步），因此
    // send / draft / change-detection 仍然读取它。
    const _rich = document.getElementById('doc-email-richbody');
    const _srcWrap = document.getElementById('doc-editor-wrap');
    if (_rich && _srcWrap) {
      _srcWrap.style.display = 'none';
      _rich.style.display = '';
      _rich.innerHTML = _emailBodyToHtml(fields.body);
      _wireEmailRichbody(_rich);
      setTimeout(() => {
        try {
          const _isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
          if (!_isTouch) _rich.focus();
          _rich.scrollTop = 0;
        } catch (_) {}
      }, 50);
    }
    // 渲染撰写附件（如果为此文档上传了任何附件）
    _renderComposeAttachments();
    // 从解析的标题填充 CC/BCC，如果已填充则显示行
    const ccRow = document.getElementById('doc-email-cc-row');
    const bccRow = document.getElementById('doc-email-bcc-row');
    const ccToggle = document.getElementById('doc-email-show-cc');
    const ccInput = document.getElementById('doc-email-cc');
    const bccInput = document.getElementById('doc-email-bcc');
    if (ccInput) ccInput.value = fields.cc || '';
    if (bccInput) bccInput.value = fields.bcc || '';
    const hasCcBcc = !!(fields.cc || fields.bcc);
    if (ccRow) ccRow.style.display = hasCcBcc ? '' : 'none';
    if (bccRow) bccRow.style.display = hasCcBcc ? '' : 'none';
    if (ccToggle) ccToggle.style.display = hasCcBcc ? 'none' : '';
    _syncEmailHeaderSummary();
  }

  async function _uploadComposeFiles(files) {
    const list = Array.from(files || []);
    if (list.length === 0) return;
    const doc = docs.get(activeDocId);
    if (!doc) return;
    if (doc.language !== 'email') return;
    if (!doc._composeAtts) doc._composeAtts = [];

    for (const file of list) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(`${API_BASE}/api/email/compose-upload`, {
          method: 'POST',
          body: fd,
        });
        const data = await res.json();
        if (data.success) {
          doc._composeAtts.push({
            token: data.token,
            filename: data.filename,
            size: data.size,
          });
        } else {
          if (uiModule) uiModule.showError(t('document.pdf_view_load_failed') + `${file.name}: ${data.error || ''}`);
        }
      } catch (err) {
        if (uiModule) uiModule.showError(t('document.pdf_view_load_failed') + 'upload ' + file.name);
      }
    }
    _renderComposeAttachments();
  }

  async function _handleAttachUpload(e) {
    const files = e.target.files;
    e.target.value = ''; // reset for next upload
    await _uploadComposeFiles(files);
  }

  function _renderComposeAttachments() {
    const container = document.getElementById('doc-email-compose-atts');
    if (!container) return;
    const doc = docs.get(activeDocId);
    const atts = doc?._composeAtts || [];
    if (atts.length === 0) {
      container.style.display = 'none';
      container.innerHTML = '';
      return;
    }
    container.style.display = '';
    container.innerHTML = '';
    for (const att of atts) {
      const chip = document.createElement('span');
      chip.className = 'email-compose-chip';
      const sizeKb = att.size > 0 ? `${Math.round(att.size / 1024)} KB` : '';
      chip.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        <span class="compose-chip-name">${_escHtml(att.filename)}</span>
        <span class="att-size">${sizeKb}</span>
        <button class="compose-chip-remove" title="Remove">×</button>
      `;
      chip.querySelector('.compose-chip-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await fetch(`${API_BASE}/api/email/compose-upload/${encodeURIComponent(att.token)}`, { method: 'DELETE' });
        } catch (_) {}
        const d = docs.get(activeDocId);
        if (d) d._composeAtts = d._composeAtts.filter(a => a.token !== att.token);
        _renderComposeAttachments();
      });
      container.appendChild(chip);
    }
  }

  // 将 To/Cc/Bcc 文本字段分割为收件人 + 用户正在输入的
  // 进行中片段（最后一个逗号之后）。返回元组以便
  // 我们可以仅为片段显示建议而不干扰
  // 已确认的收件人。
  function _splitRecipientsAndFragment(rawValue) {
    const cut = (rawValue || '').lastIndexOf(',');
    if (cut < 0) return { confirmed: '', fragment: (rawValue || '').trimStart() };
    return {
      confirmed: rawValue.slice(0, cut + 1).trimStart(),
      fragment: rawValue.slice(cut + 1).trimStart(),
    };
  }

  // 将 `input` 中的进行中片段替换为所选电子邮件，
  // 追加 ", " 以便用户可以立即输入下一个收件人，然后
  // 隐藏建议下拉列表。
  function _commitRecipient(input, sugg, email) {
    if (!input) return;
    const { confirmed } = _splitRecipientsAndFragment(input.value);
    // 在逗号之间保留一个尾随空格以提高可读性。
    const head = confirmed ? confirmed.replace(/\s+$/, '') + ' ' : '';
    input.value = head + email + ', ';
    if (sugg) sugg.style.display = 'none';
    input.focus();
    // 光标移到末尾，以便下一个按键落在正确位置。
    const end = input.value.length;
    try { input.setSelectionRange(end, end); } catch (_) {}
  }

  // 搜索联系人以获取自动完成下拉列表。`input` 是 To/Cc/Bcc
  // 文本字段，`sugg` 是其兄弟 .email-autocomplete div。建议
  // 范围限定于最后逗号分隔的片段，因此已输入的
  // 收件人不会被干扰。
  async function _searchContacts(input, sugg) {
    if (!input || !sugg) return;
    const { fragment } = _splitRecipientsAndFragment(input.value);
    if (!fragment || fragment.length < 1) { sugg.style.display = 'none'; return; }
    try {
      const res = await fetch(`${API_BASE}/api/contacts/search?q=${encodeURIComponent(fragment)}`);
      const data = await res.json();
      if (!data.results || data.results.length === 0) {
        sugg.style.display = 'none';
        return;
      }
      // 此字段中已输入的电子邮件 — 在下拉列表中跳过，以防
      // 用户意外添加同一个人两次。
      const already = new Set(
        (input.value || '').split(',').map(s => {
          const m = s.match(/<([^>]+)>/);
          return (m ? m[1] : s).trim().toLowerCase();
        }).filter(Boolean)
      );
      sugg.innerHTML = '';
      let count = 0;
      for (const c of data.results) {
        for (const em of (c.emails || [])) {
          if (already.has(em.toLowerCase())) continue;
          const item = document.createElement('div');
          item.className = 'contact-suggestion';
          item.innerHTML = `<span class="contact-name">${_escHtml(c.name)}</span><span class="contact-email">${_escHtml(em)}</span>`;
          // mousedown 在 blur 之前触发，因此点击不会丢失
          item.addEventListener('mousedown', (e) => { e.preventDefault(); _commitRecipient(input, sugg, em); });
          item.addEventListener('click', (e) => { e.preventDefault(); _commitRecipient(input, sugg, em); });
          sugg.appendChild(item);
          count += 1;
        }
      }
      if (count === 0) { sugg.style.display = 'none'; return; }
      // 自动高亮第一个建议，以便 Enter 接受它。
      const first = sugg.querySelector('.contact-suggestion');
      if (first) first.classList.add('active');
      sugg.style.display = '';
    } catch (e) {
      sugg.style.display = 'none';
    }
  }

  // 绑定收件人字段的 input/keydown/blur，使其获得相同的
  // 自动完成和提交行为。由 To/Cc/Bcc 使用。
  function _wireRecipientAutocomplete(inputId, suggId) {
    const input = document.getElementById(inputId);
    const sugg = document.getElementById(suggId);
    if (!input || !sugg) return;
    let timer = null;
    input.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => _searchContacts(input, sugg), 150);
    });
    input.addEventListener('blur', () => {
      setTimeout(() => { sugg.style.display = 'none'; }, 200);
    });
    input.addEventListener('keydown', (e) => {
      const open = sugg.style.display !== 'none';
      const items = open ? sugg.querySelectorAll('.contact-suggestion') : [];
      const active = open ? sugg.querySelector('.contact-suggestion.active') : null;
      let idx = active ? Array.from(items).indexOf(active) : -1;
      if (open && e.key === 'ArrowDown') {
        e.preventDefault();
        idx = Math.min(items.length - 1, idx + 1);
        items.forEach(it => it.classList.remove('active'));
        if (items[idx]) items[idx].classList.add('active');
      } else if (open && e.key === 'ArrowUp') {
        e.preventDefault();
        idx = Math.max(0, idx - 1);
        items.forEach(it => it.classList.remove('active'));
        if (items[idx]) items[idx].classList.add('active');
      } else if (e.key === 'Enter') {
        // 如果高亮了建议，提交它。否则 — 如果当前片段
        // 已经看起来像完整的电子邮件 — 提交原始文本，
        // 以便输入全新地址的用户不必
        // 自己添加逗号。
        if (active) {
          e.preventDefault();
          const em = active.querySelector('.contact-email')?.textContent?.trim();
          if (em) _commitRecipient(input, sugg, em);
        } else {
          const { fragment } = _splitRecipientsAndFragment(input.value);
          if (/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(fragment.trim())) {
            e.preventDefault();
            _commitRecipient(input, sugg, fragment.trim());
          }
        }
      } else if (e.key === 'Tab' && active) {
        e.preventDefault();
        const em = active.querySelector('.contact-email')?.textContent?.trim();
        if (em) _commitRecipient(input, sugg, em);
      } else if (e.key === 'Escape') {
        sugg.style.display = 'none';
      } else if (e.key === ',' || (e.key === ' ' && input.value.trim().endsWith(','))) {
        // 直接输入逗号也接受高亮的建议。
        if (active) {
          e.preventDefault();
          const em = active.querySelector('.contact-email')?.textContent?.trim();
          if (em) _commitRecipient(input, sugg, em);
        }
      }
    });
  }

  function _hideEmailFields() {
    const emailHeader = document.getElementById('doc-email-header');
    const emailActions = document.getElementById('doc-email-actions');
    if (emailHeader) emailHeader.style.display = 'none';
    if (emailActions) emailActions.style.display = 'none';
    // 恢复为邮件隐藏的工具栏项目（Code 下拉）。
    document.querySelectorAll('.md-toolbar-email-hide').forEach(el => { el.style.display = ''; });
    // 恢复通用文档操作栏 + 其底部页脚（Close /
    // Copy / Export）用于非邮件文档。
    const docActions = document.getElementById('doc-editor-actions');
    if (docActions) docActions.style.display = '';
    const docFooter = document.getElementById('doc-actions-footer');
    if (docFooter) docFooter.style.display = '';
    // 将类型选择器返回到其非邮件位置（Copy/Export 分割之前）
    // — _showEmailFields 将其移入了邮件页脚。
    if (docFooter) {
      const _lang = document.getElementById('doc-language-select');
      const _split = docFooter.querySelector('#doc-copy-export-split');
      if (_lang && _split) docFooter.insertBefore(_lang, _split);
    }
    // 恢复源编辑器并隐藏 WYSIWYG 邮件正文。
    const _rich = document.getElementById('doc-email-richbody');
    if (_rich) _rich.style.display = 'none';
    const _srcWrap = document.getElementById('doc-editor-wrap');
    if (_srcWrap) _srcWrap.style.display = '';
    // 移除 email-mode 类，使编辑器恢复到等宽单色
    document.getElementById('doc-editor-textarea')?.classList.remove('email-mode');
    document.getElementById('doc-editor-code')?.classList.remove('email-mode');
    document.getElementById('doc-editor-highlight')?.classList.remove('email-mode');
  }

  const _ATTACH_RE = /\b(attach(ed|ment|ments|ing)?|enclosed|enclosing|PFA|find attached|see attached|ci-joint|en pi[eè]ce jointe|ajout[eé]|joint|jointe|anbei|im Anhang|beigef[uü]gt|添付|fichier joint)\b/i;

  function _bodyMentionsAttachment(text) {
    if (!text) return false;
    // 仅检查用户自己的文本，不检查引用的回复
    const parts = text.split(/^>|^On .* wrote:/m);
    const own = parts[0] || '';
    return _ATTACH_RE.test(own);
  }

  function _confirmMissingAttachment() {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal';
      overlay.style.display = 'flex';
      overlay.innerHTML = `
        <div class="modal-content" style="width:360px;max-width:90vw;">
          <div class="modal-header"><h4>No attachments found</h4></div>
          <div class="modal-body" style="padding:16px;font-size:13px;opacity:0.8;">
            Your message mentions an attachment, but nothing is attached. Send anyway?
          </div>
          <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="memory-toolbar-btn" id="att-warn-cancel">Go back</button>
            <button class="memory-toolbar-btn" id="att-warn-send" style="background:var(--accent-primary,var(--red));color:#fff;border-color:var(--accent-primary,var(--red));">Send anyway</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const cleanup = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector('#att-warn-cancel').addEventListener('click', () => cleanup(false));
      overlay.querySelector('#att-warn-send').addEventListener('click', () => cleanup(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    });
  }

  async function _sendEmail() {
    const sendDocId = activeDocId;
    const to = document.getElementById('doc-email-to')?.value?.trim();
    const cc = document.getElementById('doc-email-cc')?.value?.trim() || '';
    const bcc = document.getElementById('doc-email-bcc')?.value?.trim() || '';
    const subject = document.getElementById('doc-email-subject')?.value?.trim();
    const inReplyTo = document.getElementById('doc-email-in-reply-to')?.value?.trim();
    const references = document.getElementById('doc-email-references')?.value?.trim();
    const sourceUid = document.getElementById('doc-email-source-uid')?.value?.trim();
    const sourceFolder = document.getElementById('doc-email-source-folder')?.value?.trim() || 'INBOX';
    // WYSIWYG：富文本正文的 HTML 成为邮件的 HTML 部分（服务器
    // 进行清理）。`body`（纯文本镜像）保持为 text/plain 后备。
    const _rich = _emailRichbodyActive();
    if (_rich) _syncEmailRichbody(_rich);
    const textarea = document.getElementById('doc-editor-textarea');
    const body = (_rich ? (_rich.innerText || _rich.textContent || '') : (textarea?.value || '')).trim();
    const bodyHtml = _rich ? _rich.innerHTML : null;
    const doc = docs.get(activeDocId);
    const attachments = (doc?._composeAtts || []).map(a => a.token);
    if (!to || !body) {
      if (uiModule) uiModule.showError(t('document.email_to_body_required'));
      return;
    }
    if (inReplyTo && !_emailReplyOwnText(body)) {
      if (uiModule) uiModule.showError(t('document.email_reply_empty'));
      return;
    }
    // 如果正文提及附件但实际上没有附件时发出警告
    if (attachments.length === 0 && _bodyMentionsAttachment(body)) {
      const proceed = await _confirmMissingAttachment();
      if (!proceed) return;
    }
    const btn = document.getElementById('doc-email-send-btn');
    const _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let sendSpinner = null;
    let origBtnHtml = '';
    let detachedEmailDoc = null;
    if (btn) {
      btn.disabled = true;
      origBtnHtml = btn.innerHTML;
      sendSpinner = spinnerModule.createWhirlpool(14);
      sendSpinner.element.style.cssText = 'display:inline-block;vertical-align:-2px;margin-right:6px;width:14px;height:14px;';
      btn.innerHTML = '';
      btn.appendChild(sendSpinner.element);
      btn.appendChild(document.createTextNode(t('document.email_sending')));
    }
    try {
      let canceled = false;
      if (uiModule) {
        uiModule.showToast(t('document.email_sending'), {
          duration: 3200,
          leadingIcon: 'spinner',
          action: t('common.cancel'),
          onAction: () => { canceled = true; },
        });
      }
      await _sleep(3000);
      if (!canceled) detachedEmailDoc = _detachActiveEmailForBackground(sendDocId);
      await _sleep(200);
      if (canceled) {
        _restoreDetachedEmailDoc(detachedEmailDoc);
        detachedEmailDoc = null;
        if (uiModule) uiModule.showToast(t('document.email_send_canceled'));
        return;
      }

      const activeAccountId = await _resolveComposeSendAccountId();
      const res = await fetch(`${API_BASE}/api/email/send`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to, cc: cc || null, bcc: bcc || null, subject, body, body_html: bodyHtml,
          in_reply_to: inReplyTo || null, references: references || null,
          attachments: attachments.length > 0 ? attachments : null,
          account_id: activeAccountId,
          wait_for_delivery: true,
        }),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (_) {
        data = { success: false, error: `Send failed (${res.status})` };
      }
      if (!res.ok && data && !data.error) data.error = `Send failed (${res.status})`;
      if (data.success) {
        if (uiModule) {
          uiModule.showToast(t('document.email_sent'), {
            duration: 7000,
            leadingIcon: 'check',
            action: t('document.email_view_message'),
            onAction: () => {
              import('./emailLibrary.js').then(mod => {
                const open = mod.openEmailLibrary || (mod.default && mod.default.openEmailLibrary);
                if (open) open({
                  account_id: data.account_id || activeAccountId || null,
                  folder: data.sent_folder || 'Sent',
                  uid: data.sent_uid || null,
                });
              }).catch(() => {});
            },
          });
        }
        // 自动将收件人保存到配置的联系人后端（CardDAV）。
        // 撰写字段接受普通电子邮件和 "Name <email>" 标签。
        const _contactPieces = [to, cc, bcc].join(',').split(/[,;]/).map(s => s.trim()).filter(Boolean);
        const _seenContacts = new Set();
        for (const piece of _contactPieces) {
          const match = piece.match(/^(.*?)<([^>]+)>$/);
          const email = (match ? match[2] : piece).trim();
          const name = (match ? match[1] : '').replace(/^["']|["']$/g, '').trim();
          if (!email || !/@/.test(email)) continue;
          const key = email.toLowerCase();
          if (_seenContacts.has(key)) continue;
          _seenContacts.add(key);
          fetch(`${API_BASE}/api/contacts/add`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email }),
          }).catch(() => {});
        }
        // 如果这是回复，将源邮件标记为已回复
        if (sourceUid) {
          fetch(`${API_BASE}/api/email/mark-answered/${sourceUid}?folder=${encodeURIComponent(sourceFolder)}`, { method: 'POST' }).catch(() => {});
          // 通知收件箱刷新以显示已回复状态
          window.dispatchEvent(new CustomEvent('email-answered', { detail: { uid: sourceUid } }));
        }
        // 成功发送后删除撰写文档。它通常
        // 已从可见标签分离，因此发送可以在后台完成
        // 而用户继续在下一个标签中操作。
        if (sendDocId) {
          fetch(`${API_BASE}/api/document/${sendDocId}`, { method: 'DELETE' }).catch(() => {});
          const wasActiveSentDoc = activeDocId === sendDocId;
          docs.delete(sendDocId);
          if (wasActiveSentDoc) {
            activeDocId = null;
            const nextId = _visibleDocIdsForCurrentSession().find(id => docs.has(id));
            if (nextId) switchToDoc(nextId);
            else closePanel();
          } else {
            renderTabs();
          }
          _syncDocIndicator();
        }
      } else {
        _restoreDetachedEmailDoc(detachedEmailDoc);
        detachedEmailDoc = null;
        if (uiModule) uiModule.showError(data.error || t('document.email_send_failed'));
      }
    } catch (e) {
      _restoreDetachedEmailDoc(detachedEmailDoc);
      detachedEmailDoc = null;
      if (uiModule) uiModule.showError(e?.message ? t('document.email_send_failed_generic') + `: ${e.message}` : t('document.email_send_failed_generic'));
    } finally {
      if (sendSpinner) sendSpinner.destroy();
      if (btn) {
        btn.disabled = false;
        if (origBtnHtml) btn.innerHTML = origBtnHtml;
      }
    }
  }

  async function _saveDraft() {
    const to = document.getElementById('doc-email-to')?.value?.trim();
    const cc = document.getElementById('doc-email-cc')?.value?.trim() || '';
    const bcc = document.getElementById('doc-email-bcc')?.value?.trim() || '';
    const subject = document.getElementById('doc-email-subject')?.value?.trim();
    const inReplyTo = document.getElementById('doc-email-in-reply-to')?.value?.trim();
    const references = document.getElementById('doc-email-references')?.value?.trim();
    const _rich = _emailRichbodyActive();
    if (_rich) _syncEmailRichbody(_rich);
    const textarea = document.getElementById('doc-editor-textarea');
    const body = (_rich ? (_rich.innerText || _rich.textContent || '') : (textarea?.value || '')).trim();
    const bodyHtml = _rich ? _rich.innerHTML : null;
    const btn = document.getElementById('doc-email-draft-btn');
    if (btn) { btn.disabled = true; btn.textContent = t('common.saving'); }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);
    try {
      const res = await fetch(`${API_BASE}/api/email/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          to: to || '',
          cc: cc || null,
          bcc: bcc || null,
          subject: subject || '',
          body: body || '',
          body_html: bodyHtml,
          in_reply_to: inReplyTo || null,
          references: references || null,
          account_id: window.__odysseusActiveEmailAccount || null,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (uiModule) uiModule.showToast(t('document.email_draft_saved'));
      } else {
        if (uiModule) uiModule.showError(data.error || t('document.email_draft_save_failed'));
      }
    } catch (e) {
      const timedOut = e && e.name === 'AbortError';
      if (uiModule) uiModule.showError(timedOut ? t('document.email_draft_save_timeout') : t('document.email_draft_save_failed'));
    } finally {
      clearTimeout(timeout);
      if (btn) { btn.disabled = false; btn.textContent = t('document.email_draft_button'); }
    }
  }

  function _discardEmail() {
    if (!activeDocId) return;
// 仅关闭——"草稿"按钮负责显式保存
    _closeWithoutDeleting(true);
  }

  function _visibleDocIdsForCurrentSession() {
    const curSession = sessionModule?.getCurrentSessionId() || '';
    const ids = [];
    for (const [id, doc] of docs) {
      if (doc.sessionId && curSession && doc.sessionId !== curSession) continue;
      ids.push(id);
    }
    return ids;
  }

  function _detachActiveEmailForBackground(docId) {
    if (!docId || !docs.has(docId)) return null;
    saveCurrentToMap();
    const doc = docs.get(docId);
    const snapshot = { id: docId, doc: { ...doc } };
    const wasActive = activeDocId === docId;
    if (wasActive) saveDocument({ silent: true }).catch(() => {});

    const visibleBefore = _visibleDocIdsForCurrentSession();
    const idx = visibleBefore.indexOf(docId);
    docs.delete(docId);
    if (wasActive) activeDocId = null;

    if (wasActive) {
      const remaining = visibleBefore.filter(id => id !== docId && docs.has(id));
      const nextId = remaining[idx] || remaining[idx - 1] || remaining[0] || null;
      if (nextId) {
        switchToDoc(nextId);
      } else {
        closePanel();
      }
    }
    renderTabs();
    _syncDocIndicator();
    return snapshot;
  }

  function _restoreDetachedEmailDoc(snapshot) {
    if (!snapshot || !snapshot.id || !snapshot.doc) return;
    if (!docs.has(snapshot.id)) docs.set(snapshot.id, snapshot.doc);
    _ensureDocPaneMounted();
    switchToDoc(snapshot.id);
    _syncDocIndicator();
  }

  function _closeWithoutDeleting(deleteDoc = false) {
    if (!activeDocId) return;
    if (deleteDoc) {
      fetch(`${API_BASE}/api/document/${activeDocId}`, { method: 'DELETE' }).catch(() => {});
    }
// 先将当前状态保存到文档，以便在资源库中持久化
    saveCurrentToMap();
    if (!deleteDoc) {
      saveDocument({ silent: true }).catch(() => {});
    }
    docs.delete(activeDocId);
    const remaining = Array.from(docs.keys());
    if (remaining.length > 0) {
      switchToDoc(remaining[0]);
    } else {
      closePanel();
    }
    renderTabs();
  }

  async function _aiReply() {
    const to = document.getElementById('doc-email-to')?.value?.trim() || '';
    const subject = document.getElementById('doc-email-subject')?.value?.trim() || '';
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea) return;
    const currentBody = textarea.value || '';
    const inReplyTo = document.getElementById('doc-email-in-reply-to')?.value?.trim() || '';
    const sourceUid = document.getElementById('doc-email-source-uid')?.value?.trim() || '';
    const sourceFolder = document.getElementById('doc-email-source-folder')?.value?.trim() || 'INBOX';
    const cleanAiReplyText = (text) => {
      if (!text) return '';
      let t = String(text);
      const open = /<<<\s*(?:REPLY|SUMMARY|OUTPUT)\s*>>+/i;
      const close = /<<<\s*END\s*>>+/i;
      const m = open.exec(t);
      if (m) {
        const rest = t.slice(m.index + m[0].length);
        const c = close.exec(rest);
        t = c ? rest.slice(0, c.index) : rest;
      }
      return t
        .replace(/<<<\s*(?:REPLY|SUMMARY|OUTPUT)\s*>>+/gi, '')
        .replace(/<<<\s*END\s*>>+/gi, '')
        .trim();
    };
    const shouldUseFastAiReply = () => {
      const text = `${subject}\n${currentBody}`.toLowerCase();
      if (/\b(attach(?:ed|ment)?|pdf|document|contract|invoice|receipt|quote|estimate|proposal|question|questions|details|schedule|booking|reservation|meeting|calendar|availability|confirm|confirmation|review|sign|signature)\b/.test(text)) {
        return false;
      }
      return currentBody.length < 2500;
    };

// 使用当前聊天模型
    let currentModel = '';
    let currentSessionId = '';
    try {
      currentModel = sessionModule?.getCurrentModel() || '';
      currentSessionId = sessionModule?.getCurrentSessionId() || '';
    } catch (_) {}

    const btn = document.getElementById('doc-email-ai-reply-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:3px"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg>' + t('document.email_ai_reply_drafting'); }

    try {
      const res = await fetch(`${API_BASE}/api/email/ai-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: to,
          subject: subject,
          original_body: currentBody,
          model: currentModel,
          session_id: currentSessionId,
          message_id: inReplyTo,
          uid: sourceUid,
          folder: sourceFolder,
          fast: shouldUseFastAiReply(),
        }),
      });
      const data = await res.json();
      if (data.success && data.reply) {
        const cleanReply = cleanAiReplyText(data.reply);
        const lines = currentBody.split('\n');
        const quoteIdx = lines.findIndex(l => l.startsWith('On ') && l.includes(' wrote:'));
        let newBody = '';
        if (quoteIdx > 0) {
          newBody = cleanReply + '\n\n' + lines.slice(quoteIdx).join('\n');
        } else {
          newBody = cleanReply + (currentBody ? '\n\n' + currentBody : '');
        }
        await _streamEmailBodyText(textarea, newBody);
        if (uiModule) uiModule.showToast(t('document.email_ai_reply_inserted', { model: data.model_used || 'AI' }));
      } else {
        if (uiModule) uiModule.showError(data.error || t('document.email_ai_reply_failed'));
      }
    } catch (e) {
      if (uiModule) uiModule.showError(t('document.email_ai_reply_failed'));
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:3px"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg>' + t('document.email_ai_reply_button'); }
    }
  }

  async function _scheduleSend(anchorEl = null) {
    const to = document.getElementById('doc-email-to')?.value?.trim();
    const cc = document.getElementById('doc-email-cc')?.value?.trim() || '';
    const bcc = document.getElementById('doc-email-bcc')?.value?.trim() || '';
    const subject = document.getElementById('doc-email-subject')?.value?.trim();
    const inReplyTo = document.getElementById('doc-email-in-reply-to')?.value?.trim();
    const references = document.getElementById('doc-email-references')?.value?.trim();
    const _rich = _emailRichbodyActive();
    if (_rich) _syncEmailRichbody(_rich);
    const body = (_rich
      ? (_rich.innerText || _rich.textContent || '')
      : (document.getElementById('doc-editor-textarea')?.value || '')
    ).trim();
    const doc = docs.get(activeDocId);
    const attachments = (doc?._composeAtts || []).map(a => a.token);

    if (!to || !body) {
      if (uiModule) uiModule.showError(t('document.email_to_body_required'));
      return;
    }
    if (inReplyTo && !_emailReplyOwnText(body)) {
      if (uiModule) uiModule.showError(t('document.email_reply_empty'));
      return;
    }
    if (attachments.length === 0 && _bodyMentionsAttachment(body)) {
      const proceed = await _confirmMissingAttachment();
      if (!proceed) return;
    }

// 创建带有日期时间选择和快捷预设的小型模态框
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal-content schedule-send-modal" style="width:400px;max-width:92vw;">
        <div class="modal-header">
          <h4>Schedule Send</h4>
          <button class="close-btn" id="sched-close" title="Close"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="modal-body schedule-send-body">
          <label class="schedule-send-label">Quick presets</label>
          <div class="schedule-send-presets">
            <button class="memory-toolbar-btn" data-preset="1h">In 1 hour</button>
            <button class="memory-toolbar-btn" data-preset="3h">In 3 hours</button>
            <button class="memory-toolbar-btn" data-preset="tomorrow">Tomorrow 9am</button>
            <button class="memory-toolbar-btn" data-preset="monday">Monday 9am</button>
          </div>
          <label class="schedule-send-label" for="sched-datetime">Or pick a specific time</label>
          <input type="datetime-local" id="sched-datetime" class="schedule-send-datetime" />
        </div>
        <div class="modal-footer schedule-send-footer">
          <button class="memory-toolbar-btn" id="sched-cancel">Cancel</button>
          <button class="memory-toolbar-btn schedule-send-confirm" id="sched-confirm"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Schedule</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const modalContent = overlay.querySelector('.schedule-send-modal');
    const anchor = anchorEl || document.getElementById('doc-email-send-caret') || document.getElementById('doc-email-send-btn');
    if (modalContent && anchor) {
      const rect = anchor.getBoundingClientRect();
      const gap = 8;
      const width = Math.min(400, Math.max(280, window.innerWidth - 16));
      modalContent.style.width = `${width}px`;
      modalContent.style.position = 'fixed';
      modalContent.style.margin = '0';
      modalContent.style.transform = 'none';
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
      const belowTop = rect.bottom + gap;
      const estimatedHeight = Math.min(320, window.innerHeight - 16);
      const top = belowTop + estimatedHeight <= window.innerHeight - 8
        ? belowTop
        : Math.max(8, rect.top - estimatedHeight - gap);
      modalContent.style.left = `${left}px`;
      modalContent.style.top = `${top}px`;
    }

    const dtInput = overlay.querySelector('#sched-datetime');
// 默认从现在起 1 小时后
    const now = new Date(Date.now() + 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    dtInput.value = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const escHandler = (e) => { if (e.key === 'Escape') cleanup(); };
    const cleanup = () => {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    };
    overlay.querySelector('#sched-close').addEventListener('click', cleanup);
    overlay.querySelector('#sched-cancel').addEventListener('click', cleanup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
    document.addEventListener('keydown', escHandler);

    overlay.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.getAttribute('data-preset');
        const d = new Date();
        if (preset === '1h') d.setHours(d.getHours() + 1);
        else if (preset === '3h') d.setHours(d.getHours() + 3);
        else if (preset === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
        else if (preset === 'monday') {
          const daysUntilMon = (8 - d.getDay()) % 7 || 7;
          d.setDate(d.getDate() + daysUntilMon);
          d.setHours(9, 0, 0, 0);
        }
        dtInput.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      });
    });

    overlay.querySelector('#sched-confirm').addEventListener('click', async () => {
      const localDt = dtInput.value;
      if (!localDt) { if (uiModule) uiModule.showError(t('document.scheduler_pick_time')); return; }
// 将本地日期时间转换为 UTC ISO
      const utcIso = new Date(localDt).toISOString();
      try {
        const activeAccountId = await _resolveComposeSendAccountId();
        const res = await fetch(`${API_BASE}/api/email/schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to, cc: cc || null, bcc: bcc || null, subject, body,
            in_reply_to: inReplyTo || null,
            references: references || null,
            attachments: attachments.length > 0 ? attachments : null,
            send_at: utcIso,
            account_id: activeAccountId,
          }),
        });
        const data = await res.json();
        if (data.success) {
          if (uiModule) uiModule.showToast(t('document.scheduler_scheduled', { time: new Date(localDt).toLocaleString() }));
          cleanup();
// 关闭文档
          _closeWithoutDeleting(true);
        } else {
          if (uiModule) uiModule.showError(data.error || t('document.scheduler_failed'));
        }
      } catch (e) {
        if (uiModule) uiModule.showError(t('document.scheduler_failed'));
      }
    });
  }

  async function _markUnreadAndClose() {
    const sourceUid = document.getElementById('doc-email-source-uid')?.value || '';
    const sourceFolder = document.getElementById('doc-email-source-folder')?.value || 'INBOX';
    if (sourceUid) {
      try {
        await fetch(`${API_BASE}/api/email/mark-unread/${sourceUid}?folder=${encodeURIComponent(sourceFolder)}`, { method: 'POST' });
      } catch (e) { console.error('Failed to mark unread:', e); }
    }
    _discardEmail();
  }

  function switchToDoc(docId) {
    if (!docs.has(docId)) return;
    _hideLoadingOverlay();
    if (_diffModeActive) exitDiffMode(true);

// 切换前保存当前文档状态
    saveCurrentToMap();

// 如果要离开的文档完全为空，则自动删除
    const prevId = activeDocId;
    if (prevId && prevId !== docId && docs.has(prevId)) {
      const prev = docs.get(prevId);
      if (!(prev.content || '').trim() && !(prev.title || '').trim()) {
        fetch(`${API_BASE}/api/document/${prevId}`, { method: 'DELETE' }).catch(() => {});
        docs.delete(prevId);
        _syncDocIndicator();
      }
    }

    activeDocId = docId;
    clearSelection();
    const doc = docs.get(docId);

// 填充编辑器
    const titleInput = document.getElementById('doc-title-input');
    const textarea = document.getElementById('doc-editor-textarea');
    const langSelect = document.getElementById('doc-language-select');
    const badge = document.getElementById('doc-version-badge');

    if (titleInput) titleInput.value = doc.title || '';
// 对于 email 文档，_showEmailFields 将设置 textarea 为仅正文（不含原始头信息）
    if (textarea && doc.language !== 'email') textarea.value = doc.content || '';
    if (langSelect) langSelect.value = doc.language || 'markdown';
    if (badge) { const _v = doc.version || 1; badge.textContent = `v${_v}`; badge.style.display = _v > 1 ? '' : 'none'; }
    { const _v = doc.version || 1; const _dbtn = document.getElementById('doc-diff-toggle-btn'); if (_dbtn) _dbtn.style.display = _v > 1 ? '' : 'none'; }
    syncHighlighting();
// 延迟重新同步：确保浏览器布局后 minHeight 正确
    requestAnimationFrame(() => {
      const ta2 = document.getElementById('doc-editor-textarea');
      const code2 = document.getElementById('doc-editor-code');
      const pre2 = document.getElementById('doc-editor-highlight');
      if (ta2 && code2 && pre2) {
        code2.style.minHeight = ta2.scrollHeight + 'px';
        pre2.scrollTop = ta2.scrollTop;
      }
    });

// 为未设置语言的文档自动检测语言
    if (!doc.userSetLanguage && !doc.language) {
      setTimeout(attemptAutoDetect, 100);
    }

// 根据语言显示/隐藏 markdown 工具栏。PDF 支持的文档底层
// 是 markdown，因此工具栏也会显示——并在下方显示
// PDF 特定按钮（文本/勾选/签名/AI）。
    const isMd = (doc.language || 'markdown') === 'markdown';
    const isPdf = _isFormBackedDoc(doc.content || '');

// 对于 PDF 支持的文档，在后端重新运行文本提取，使 AI
// 能在下一条消息中看到内容。对每个会话每个文档仅执行一次
// 以避免重复调用视觉模型——通过文档对象上的标记来跟踪。
//
    if (isPdf && !doc._ocrTriggered) {
      doc._ocrTriggered = true;
      (async () => {
        try {
          const r = await fetch(`${API_BASE}/api/document/${docId}/extract-pdf-text`, { method: 'POST', credentials: 'same-origin' });
          if (!r.ok) return;
          const j = await r.json().catch(() => ({}));
          if (j && j.extracted) {
// 将最新内容拉入本地缓存，使后续 AI
// 轮次和源视图都能反映提取结果。
            const dr = await fetch(`${API_BASE}/api/document/${docId}`, { credentials: 'same-origin' });
            if (dr.ok) {
              const full = await dr.json();
              const cached = docs.get(docId);
              if (cached && full && full.current_content) {
                cached.content = full.current_content;
              }
            }
          }
        } catch (_) {}
      })();
    }
    const mdToolbar = document.getElementById('doc-md-toolbar');
    if (mdToolbar) {
// 为所有文档类型显示，使用户始终可以访问字号/
// 差异切换/语言特定控件。工具栏内的项目
// 根据语言控制自身可见性（markdown 编辑/预览切换等）。
      mdToolbar.style.display = '';
      if (mdToolbar._syncOverflow) requestAnimationFrame(mdToolbar._syncOverflow);
    }
// 切换仅 PDF 工具栏组
    document.querySelectorAll('.md-toolbar-pdf-only').forEach(el => {
      el.style.display = isPdf ? '' : 'none';
    });
// 字号对 PDF 无效（注释是放置的，不是样式化的）——
// 在 PDF 上隐藏，使工具栏只显示实际可用的功能。
    const _fsBtn = document.getElementById('doc-fontsize-btn');
    if (_fsBtn) _fsBtn.style.display = isPdf ? 'none' : '';
// 切换文档时退出 CSV 预览，或自动为 CSV 显示
    const isCsv = doc.language === 'csv';
    const csvPreview = document.getElementById('doc-csv-preview');
    if (!isCsv) {
      if (csvPreview) csvPreview.style.display = 'none';
    } else {
// 自动为 CSV 文档显示表格视图
      requestAnimationFrame(() => toggleCsvPreview());
    }

// 切换时退出 HTML 预览
    exitHtmlPreview();

// 显示/隐藏 email 字段。Markdown 预览使用与 email 源模式
// 相同的编辑器包装，因此在显示富文本 email 正文之前清除它；
// 否则源包装可能覆盖编写器重新出现。
    const isEmail = doc.language === 'email';
    if (isEmail) {
      _setMarkdownPreviewActive(false, { remember: false });
      _showEmailFields(doc);
    } else {
      _hideEmailFields();
      const wantsMarkdownPreview = (doc.language || 'markdown') === 'markdown' && doc._markdownPreviewActive === true;
      _setMarkdownPreviewActive(wantsMarkdownPreview, { remember: false });
    }

// 切换时隐藏版本面板
    const vp = document.getElementById('doc-version-panel');
    if (vp) vp.classList.add('hidden');

    renderTabs();
    _syncHeaderActions();

// 恢复此文档的任何持久化建议
    if (_activeSuggestions.length === 0) {
      _restoreSuggestionsFromStorage(docId);
    }

  }

// 将文档从聊天会话中解绑，使其不再在该聊天中重新出现：
// 有内容的文档解除链接（保留在资源库中），空文档
// 删除。由标签 × 和移动端芯片拖入垃圾桶的关闭使用。
  function _detachDocFromSession(docId, { toast = false } = {}) {
    const doc = docs.get(docId);
    const hasContent = doc && doc.content && doc.content.trim().length > 0;
    if (hasContent) {
      fetch(`${API_BASE}/api/document/${docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: '' }),
      }).then(() => {
        if (toast && uiModule) uiModule.showToast(t('document.doc_unlinked'));
      }).catch(() => {});
    } else {
      fetch(`${API_BASE}/api/document/${docId}`, { method: 'DELETE' }).catch(() => {});
    }
    docs.delete(docId);
    _syncDocIndicator();
  }

  async function closeTab(docId) {
// 将当前编辑器内容保存到 map，使下面的检查使用最新数据
    saveCurrentToMap();
    _detachDocFromSession(docId, { toast: true });
// 在当前会话中查找下一个标签页
    const curSession = sessionModule?.getCurrentSessionId() || '';
    let nextId = null;
    for (const [id, d] of docs) {
      if (!d.sessionId || !curSession || d.sessionId === curSession) {
        nextId = id;
        break;
      }
    }
    if (!nextId) {
      activeDocId = null;
      closePanel();
      return;
    }
    if (activeDocId === docId) {
      switchToDoc(nextId);
    } else {
      renderTabs();
    }
  }

  /** 用户输入/粘贴到空编辑器时自动创建文档 */
  let _autoCreating = false;
// createDocument 的 POST 请求进行中时为 true——抑制输入自动创建路径
// 防止点击"新建文档"后立即输入生成第二个未命名文档
//（创建往返未设置 activeDocId 时，输入处理器认为编辑器为空）。
//（创建往返未设置 activeDocId，因此输入处理器认为编辑器为空）。
  let _creatingDoc = false;
  async function _autoCreateFromInput(content) {
    if (_autoCreating) return;
    _autoCreating = true;
    try {
      let sessionId = _lastSessionId
        || (sessionModule && sessionModule.getCurrentSessionId());
      if (!sessionId) {
        sessionId = await _autoCreateSession();
      }
      const res = await fetch(`${API_BASE}/api/document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, title: '', content }),
      });
      const doc = await res.json();
      addDocToTabs(doc, sessionId);
// 将内容设置到 map 中，使 switchToDoc 保留它
      const d = docs.get(doc.id);
      if (d) d.content = content;
      activeDocId = doc.id;
// 更新 textarea（保留用户输入的内容）
      const textarea = document.getElementById('doc-editor-textarea');
      if (textarea) {
        textarea.placeholder = t('document.editor_placeholder_content');
      }
      syncHighlighting();
      renderTabs();
// 触发自动检测和自动标题
      setTimeout(attemptAutoDetect, 100);
      setTimeout(() => autoTitleFromContent(content), 300);
// 自动保存
      clearTimeout(_autoSaveDebounce);
      _autoSaveDebounce = setTimeout(() => { saveDocument({ silent: true }); }, 2000);
    } catch (e) {
      console.error('Failed to auto-create document from input:', e);
    } finally {
      _autoCreating = false;
    }
  }

  /** 将当前编辑器状态保存回文档映射 */
  function saveCurrentToMap() {
    if (!activeDocId || !docs.has(activeDocId)) return;
    const doc = docs.get(activeDocId);
    const textarea = document.getElementById('doc-editor-textarea');
    const titleInput = document.getElementById('doc-title-input');
    const langSelect = document.getElementById('doc-language-select');
    if (titleInput) doc.title = titleInput.value;
    if (langSelect) doc.language = langSelect.value;
// 对于 email 文档，用头信息重建完整内容
    if (doc.language === 'email' && textarea) {
      const to = document.getElementById('doc-email-to')?.value || '';
      const cc = document.getElementById('doc-email-cc')?.value || '';
      const bcc = document.getElementById('doc-email-bcc')?.value || '';
      const subject = document.getElementById('doc-email-subject')?.value || '';
      const inReplyTo = document.getElementById('doc-email-in-reply-to')?.value || '';
      const references = document.getElementById('doc-email-references')?.value || '';
      const sourceUid = document.getElementById('doc-email-source-uid')?.value || '';
      const sourceFolder = document.getElementById('doc-email-source-folder')?.value || '';
// 将 WYSIWYG 正文持久化为 HTML，使重新打开草稿时保留
// 其格式（textarea 镜像为纯文本）。_emailBodyToHtml 在重新加载时
// 检测到前导 '<' 并按原样恢复。
      const _rich = document.getElementById('doc-email-richbody');
      const _emailBody = (_rich && _rich.style.display !== 'none') ? _rich.innerHTML : textarea.value;
      doc.content = _buildEmailContent(to, subject, inReplyTo, references, _emailBody, sourceUid, sourceFolder, cc, bcc);
    } else if (textarea) {
// 当 textarea 为空时不覆盖 PDF/表单支持的文档源
//（它隐藏在渲染的 PDF 视图后面，因此其值不是真实来源）。
// 在此处覆盖会丢弃 pdf_form_source 标记，因此在
// 最小化→恢复后文档恢复为空白。
      if (!(textarea.value === '' && _isFormBackedDoc(doc.content))) {
        doc.content = textarea.value;
      }
    }
  }

  // ---- 面板打开/关闭 ----

  export function openPanel() {
    if (isOpen) return;
// 清除任何仍在从刚触发的关闭中滑出的面板/分隔条，避免
// 出现两个 #doc-editor-pane 节点（以及过时的关闭操作剥离 doc-view）。
// 与上方 _finishClose 中的 isOpen 守卫配对。
    document.getElementById('doc-editor-pane')?.remove();
    document.getElementById('doc-divider')?.remove();
// 如果文档已最小化为芯片，但用户通过其他路径（工具栏按钮、指示器）打开面板，
// 则清除该芯片——文档正在重新变为可见。
// 文档正在重新变为可见。
    if (Modals.isRegistered('doc-panel') && Modals.isMinimized('doc-panel')) {
      _minimizedDocId = null;
      Modals.unregister('doc-panel');
    }
    const container = document.getElementById('chat-container');
    if (!container) return;

    isOpen = true;
// 文档最后打开 → 它位于 email 窗口前面（清除 email-front 标记；
// 文档/email 的 z-index 交替在 CSS 中）。
    document.body.classList.remove('email-front');
    _ensureAgentMode();
    _markDocVisibleState(_lastSessionId, 'open');

    document.body.classList.add('doc-view');

// 同步切换按钮状态
    const toggleBtn = document.getElementById('overflow-doc-btn');
    if (toggleBtn) toggleBtn.classList.add('active');
    const docInd = document.getElementById('doc-indicator-btn');
    if (docInd) docInd.classList.add('active');

// 创建分隔条——中间手柄（可拖拽调整大小），悬停时切换为
// 可点击的折叠箭头。
    const divider = document.createElement('div');
    divider.className = 'doc-divider';
    divider.id = 'doc-divider';
// 单个箭头，根据光标位置切换方向：
//   - 光标在文档面板内   →  ›（折叠/关闭面板）
//   - 光标在文档面板外   →  ‹（全屏——向左扩展）
// 箭头通过 CSS 旋转，使切换感觉流畅。操作跟随
// 字形，因此点击始终执行箭头承诺的功能。
// 下方的辅助 X 按钮仅在全屏模式下显示，
// 直接隐藏面板（使全屏有一个退出全屏以外的逃逸方式）。
// "退出全屏"）。
    divider.innerHTML = `<button type="button" class="doc-divider-collapse" title="${t('document.collapse_panel')}" data-mode="collapse"><span>›</span></button>` +
      `<button type="button" class="doc-divider-hide" title="${t('document.hide_panel')}" aria-label="${t('document.hide_panel')}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
    const _divHide = divider.querySelector('.doc-divider-hide');
    if (_divHide) {
      _divHide.addEventListener('mousedown', (e) => e.stopPropagation());
      _divHide.addEventListener('click', (e) => { e.stopPropagation(); closePanel('down'); });
    }

// 创建编辑器面板
    const pane = document.createElement('div');
    pane.id = 'doc-editor-pane';
    pane.className = 'doc-editor-pane';
// ── 移动端：使工具栏/页脚按钮在键盘打开时首次点击即生效 ──
// 键盘打开时 ──
// 键盘打开时的点击通常被系统键盘关闭事件吞没，
// 按钮的 click 永远不会触发（"什么都没有触发"）。通过按下时聚焦
// 该字段使点击不被消耗，然后在释放时
// 重新分发 click，使操作在首次点击时触发。
// 操作处理器自身决定是否随后收起键盘
//（撤销/导出/关闭执行；格式/复制保留）。仅触摸——桌面不受影响。
// 不受影响。
    {
      let _kbBtn = null;
      pane.addEventListener('pointerdown', (e) => {
        _kbBtn = null;
        if (e.pointerType !== 'touch') return;
        const btn = e.target.closest && e.target.closest('button');
        if (!btn) return;
        const ae = document.activeElement;
        if (!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA'))) return;
        e.preventDefault();   // keep focus; this cancels the native touch click
        _kbBtn = btn;
      }, true);
      pane.addEventListener('pointerup', (e) => {
        const btn = _kbBtn; _kbBtn = null;
        if (!btn) return;
        if (e.target.closest && e.target.closest('button') === btn) {
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      }, true);
      pane.addEventListener('pointercancel', () => { _kbBtn = null; }, true);
    }
    pane.innerHTML = `
      <input type="hidden" id="doc-title-input" value="" />
      <div class="doc-mobile-grabber" id="doc-mobile-grabber" aria-hidden="true"></div>
      <div class="doc-editor-header" id="doc-editor-actions">
        <button id="doc-undo-btn" class="doc-action-icon-btn" title="${t('document.toolbar_undo')}" style="gap:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg><span style="font-size:11px;">${t('document.toolbar_undo')}</span></button>
        <button id="doc-header-preview-btn" class="doc-action-icon-btn" title="${t('document.toolbar_run_preview')}" style="display:none;opacity:0.85;gap:4px;"></button>
        <span id="doc-stream-indicator" class="doc-stream-indicator" style="display:none"><span class="doc-stream-dot"></span> editing</span>
        <span id="doc-version-badge" class="doc-version-badge" title="${t('document.tab_version_history')}" style="display:none">v1</span>
        <span style="flex:1"></span>
        <button id="doc-export-pdf-btn" class="doc-action-icon-btn" title="Export PDF" style="display:none;opacity:0.7;gap:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg> <span style="font-size:11px;">Export PDF</span></button>
        <button id="doc-pdf-view-btn" class="doc-action-icon-btn" title="${t('document.toolbar_toggle_pdf')}" style="display:none;opacity:0.7;gap:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> <span style="font-size:11px;">${t('document.toolbar_pdf')}</span></button>
        <select id="doc-language-select" class="doc-language-select">
          <option value="">${t('document.lang_picker_type')}</option>
          <option value="python">python</option>
          <option value="javascript">javascript</option>
          <option value="typescript">typescript</option>
          <option value="html">html</option>
          <option value="css">css</option>
          <option value="markdown">markdown</option>
          <option value="json">json</option>
          <option value="yaml">yaml</option>
          <option value="bash">bash</option>
          <option value="sql">sql</option>
          <option value="rust">rust</option>
          <option value="go">go</option>
          <option value="java">java</option>
          <option value="c">c</option>
          <option value="cpp">c++</option>
          <option value="csharp">c#</option>
          <option value="xml">xml</option>
          <option value="svg">svg</option>
          <option value="toml">toml</option>
          <option value="ini">ini</option>
          <option value="ruby">ruby</option>
          <option value="php">php</option>
          <option value="csv">csv</option>
          <option value="email">email</option>
          <option value="pdf">pdf</option>
        </select>
        <!-- Close + Copy/Export moved to the bottom action footer (#doc-actions-footer)
             so regular docs match the email footer layout. -->
      </div>
      <div class="doc-tab-bar" id="doc-tab-bar"></div>
      <div id="doc-email-header" class="doc-email-header" style="display:none">
        <button type="button" id="doc-email-collapse-btn" class="doc-email-collapse-btn" title="${t('document.email_hide_fields')}" aria-expanded="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>
          <span id="doc-email-collapse-summary" class="doc-email-collapse-summary">No recipient · No subject</span>
        </button>
        <div id="doc-email-fields" class="doc-email-fields">
          <div class="email-field" style="position:relative">
            <label>To</label>
            <input type="text" id="doc-email-to" placeholder="${t('document.email_placeholder_to')}" autocomplete="off" />
            <div id="doc-email-to-suggestions" class="email-autocomplete" style="display:none"></div>
            <button type="button" id="doc-email-show-cc" class="email-cc-toggle" title="${t('document.email_show_cc')}">${t('document.email_cc_label')}</button>
          </div>
          <div class="email-field" id="doc-email-cc-row" style="display:none;position:relative">
            <label>${t('document.email_cc_label')}</label>
            <input type="text" id="doc-email-cc" placeholder="${t('document.email_placeholder_cc')}" autocomplete="off" />
            <div id="doc-email-cc-suggestions" class="email-autocomplete" style="display:none"></div>
          </div>
          <div class="email-field" id="doc-email-bcc-row" style="display:none;position:relative">
            <label>${t('document.email_bcc_label')}</label>
            <input type="text" id="doc-email-bcc" placeholder="${t('document.email_placeholder_bcc')}" autocomplete="off" />
            <div id="doc-email-bcc-suggestions" class="email-autocomplete" style="display:none"></div>
          </div>
          <div class="email-field"><label>${t('document.email_subject')}</label><input type="text" id="doc-email-subject" placeholder="${t('document.email_placeholder_subject')}" /></div>
          <div id="doc-email-attachments" class="email-attachments" style="display:none"></div>
          <div id="doc-email-compose-atts" class="email-compose-atts" style="display:none"></div>
        </div>
        <input type="hidden" id="doc-email-in-reply-to" />
        <input type="hidden" id="doc-email-references" />
        <input type="hidden" id="doc-email-source-uid" />
        <input type="hidden" id="doc-email-source-folder" />
        <input type="file" id="doc-email-file-input" multiple style="display:none" />
      </div>
      <div class="doc-md-toolbar" id="doc-md-toolbar" style="display:none">
        <div class="md-toolbar-items" id="md-toolbar-items">
          <span class="md-view-toggle" id="doc-md-view-toggle" style="display:none" role="group" aria-label="${t('document.code_edit') + ' ' + t('document.code_preview').toLowerCase()}">
            <button type="button" class="md-view-opt" data-mdview="edit" title="${t('document.toolbar_edit_source')}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button type="button" class="md-view-opt" data-mdview="preview" title="${t('document.code_preview')}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
          </span>
          <span class="md-view-toggle" id="doc-render-view-toggle" style="display:none" role="group" aria-label="${t('document.toolbar_code_or_run')}">
            <button type="button" class="md-view-opt" data-renderview="code" title="${t('document.code_edit_code')}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></button>
            <button type="button" class="md-view-opt" data-renderview="run" title="${t('document.toolbar_run_preview')}"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
          </span>
          <button id="doc-fontsize-btn" class="doc-action-icon-btn" title="${t('document.toolbar_font_size')}" style="position:relative;width:28px;height:26px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.7;"><path d="M4 7V4h16v3"/><path d="M12 4v16"/><path d="M8 20h8"/></svg><span class="doc-fontsize-levels"><i data-sz="s">S</i><i data-sz="m">M</i><i data-sz="l">L</i></span></button>
          <button id="doc-diff-toggle-btn" class="doc-action-icon-btn" title="${t('document.toolbar_compare_changes')}" style="opacity:0.7;display:none;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M5 12H2l5-5 5 5H9"/><path d="M19 12h3l-5 5-5-5h3"/></svg></button>
          <span class="md-toolbar-sep"></span>
          <button type="button" data-md="bold" title="${t('document.toolbar_bold')}"><b>B</b></button>
          <button type="button" data-md="italic" title="${t('document.toolbar_italic')}"><i>I</i></button>
          <button type="button" data-md="strike" title="${t('document.toolbar_strikethrough')}"><s>S</s></button>
          <span class="md-toolbar-sep"></span>
          <button type="button" class="md-dd-toggle" data-dd="heading" title="${t('document.toolbar_heading')}"><b>H</b><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          <button type="button" class="md-dd-toggle" data-dd="list" title="${t('document.toolbar_list')}"><span style="font-variant-numeric:tabular-nums;">1.</span><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          <span class="md-toolbar-sep"></span>
          <button type="button" data-md="link" title="${t('document.toolbar_link')}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
          <button type="button" id="md-toolbar-attach-btn" class="md-toolbar-attach-btn" title="${t('document.toolbar_attach_files')}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
          <button type="button" class="md-dd-toggle md-toolbar-email-hide" data-dd="code" title="${t('document.toolbar_code')}">\`<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          <button type="button" data-md="hr" title="${t('document.toolbar_horizontal_rule')}">—</button>
          <span class="md-toolbar-sep"></span>
          <span id="md-toolbar-emoji-slot"></span>
          <span class="md-toolbar-sep md-toolbar-pdf-only" style="display:none"></span>
          <button type="button" id="doc-pdf-add-text-btn" class="md-toolbar-pdf-only" title="${t('document.toolbar_add_text_box')}" style="display:none"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg></button>
          <button type="button" id="doc-pdf-add-check-btn" class="md-toolbar-pdf-only" title="${t('document.toolbar_add_checkmark')}" style="display:none"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
          <button type="button" id="doc-pdf-add-sign-btn" class="md-toolbar-pdf-only" title="${t('document.toolbar_add_signature')}" style="display:none"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3l6 6-9 9-3-3z"/><path d="M9 15l-3 1 1-3"/><path d="M4 18l3-3"/><path d="M3 20l3-3"/><path d="M5 22l3-3"/></svg><span class="doc-pdf-sign-label">${t('document.toolbar_sign_label')}</span></button>
          <button type="button" id="doc-pdf-refresh-btn" class="md-toolbar-pdf-only" title="${t('document.toolbar_reload_pdf')}" style="display:none"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
        </div>
        <div class="md-toolbar-overflow-wrapper" id="md-toolbar-overflow-wrapper" style="display:none">
          <button class="md-toolbar-overflow-toggle" id="md-toolbar-overflow-toggle" title="${t('document.toolbar_more_formatting')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
          <div class="md-toolbar-overflow-menu" id="md-toolbar-overflow-menu"></div>
        </div>
        <button type="button" class="md-scroll-arrow md-scroll-left" id="md-scroll-left" title="${t('document.scroll_left')}" style="display:none"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
        <button type="button" class="md-scroll-arrow md-scroll-right" id="md-scroll-right" title="${t('document.scroll_right')}" style="display:none"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
      </div>
      <div id="doc-find-bar" class="doc-find-bar" style="display:none">
        <input id="doc-find-input" class="doc-find-input" type="text" placeholder="${t('document.find_placeholder')}" />
        <span id="doc-find-count" class="doc-find-count"></span>
        <button id="doc-find-prev" class="doc-find-nav" title="${t('document.find_previous')}">&uarr;</button>
        <button id="doc-find-next" class="doc-find-nav" title="${t('document.find_next')}">&darr;</button>
        <button id="doc-find-close" class="doc-find-close" title="${t('document.find_close')}">&times;</button>
      </div>
      <div id="doc-editor-wrap" class="doc-editor-wrap">
        <div id="doc-line-numbers" class="doc-line-numbers">1</div>
        <pre id="doc-editor-highlight" class="doc-editor-highlight"><code id="doc-editor-code"></code></pre>
        <textarea id="doc-editor-textarea" class="doc-editor-textarea" placeholder="Document content..." spellcheck="false"></textarea>
      </div>
      <!-- WYSIWYG email body. In email mode this replaces the source editor:
           B/I/S act on the live text (execCommand), and on send its HTML becomes
           the email's HTML part. Its plain text is mirrored into the textarea so
           the existing send/draft/change-detection paths keep working. -->
      <div id="doc-email-richbody" class="doc-email-richbody" contenteditable="true" spellcheck="true" style="display:none" data-no-swipe-dismiss></div>
      <div id="doc-email-actions" class="doc-email-actions" style="display:none">
        <button id="doc-email-discard-btn" class="email-discard-btn" title="${t('document.email_close')}" style="display:inline-flex;align-items:center;gap:5px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span>${t('common.close')}</span></button>
        <span style="flex:1"></span>
        <div class="email-send-split">
          <button id="doc-email-send-btn" class="email-send-btn email-send-main" title="${t('document.email_send_title')}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>${t('chat.send')}</button>
          <button id="doc-email-send-caret" class="email-send-btn email-send-caret" title="${t('document.email_more_options')}" aria-haspopup="true" aria-expanded="false"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
          <div id="doc-email-more-menu" class="email-more-menu" style="display:none">
            <div class="dropdown-item-compact" id="doc-email-draft-btn"><span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></span>${t('document.email_draft_button')}</div>
            <div class="dropdown-item-compact" id="doc-email-schedule-btn"><span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>${t('common.schedule') || 'Schedule Send...'}</div>
            <div class="dropdown-item-compact" id="doc-email-unread-btn"><span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg></span>${t('common.mark_unread') || 'Mark Unread'}</div>
          </div>
        </div>
      </div>
      <div id="doc-md-preview" class="doc-md-preview" style="display:none"></div>
      <div id="doc-csv-preview" class="doc-csv-preview" style="display:none"></div>
      <iframe id="doc-html-preview" class="doc-html-preview" sandbox="allow-scripts allow-modals" style="display:none"></iframe>
      <div id="doc-pdf-view" style="display:none;width:100%;flex:1;min-height:0;overflow:auto;background:#525659;padding:20px 0;position:relative;">
        <div id="doc-pdf-save-pill" style="display:none;position:absolute;top:8px;right:14px;padding:4px 10px;border-radius:12px;font-size:11px;z-index:5;pointer-events:none;background:transparent;color:transparent;"></div>
      </div>
      <!-- Action footer sits AFTER all the content/preview panes so it stays
           pinned to the bottom no matter which pane (editor / md-preview /
           csv / html / pdf) is the one growing to fill. -->
      <div id="doc-actions-footer" class="doc-email-actions">
        <span class="email-send-split" id="doc-copy-export-split">
          <button type="button" id="doc-footer-copy-btn" class="email-send-btn email-send-main" title="${t('document.email_copy_title')}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>${t('common.copy')}</button>
          <button type="button" id="doc-footer-export-btn" class="email-send-btn email-send-caret" title="${t('document.email_export_as')}" aria-label="${t('common.export')}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"/></svg></button>
        </span>
      </div>
      <div id="doc-version-panel" class="doc-version-panel hidden">
        <div class="doc-version-header">
          <span>${t('document.tab_version_history')}</span>
          <button id="doc-version-close" class="doc-action-icon-btn" title="${t('common.close')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div id="doc-version-list" class="doc-version-list"></div>
      </div>
      <div id="doc-mobile-footer" class="doc-mobile-footer">
        <button id="doc-mobile-close" class="doc-mobile-footer-btn" type="button">Unlink</button>
        <span style="flex:1"></span>
        <button id="doc-mobile-copy" class="doc-mobile-footer-btn" type="button">Copy</button>
      </div>
    `;

// 整合为单一操作栏：将撤销和类型选择器从头部的顶部
// 移到底部页脚（左侧，关闭旁边），使常规文档
// 显示一个栏而不是两个。头部的其余部分（运行/预览、
// 全屏、版本、PDF）保持不变；头部在没有可见内容时
// 隐藏自身——参见 _syncHeaderBarVisibility()。
// 注意：`#doc-render-view-toggle`（SVG/HTML 的代码↔运行）有意
// 留在顶部头部，使其与 `#doc-md-view-toggle`（markdown
// 编辑↔预览）对齐——两个视图切换位于同一位置。
    {
      const _footer = pane.querySelector('#doc-actions-footer');
      const _split = _footer && _footer.querySelector('#doc-copy-export-split');
      const _undo = pane.querySelector('#doc-undo-btn');
      const _lang = pane.querySelector('#doc-language-select');
      const _preview = pane.querySelector('#doc-header-preview-btn');  // single Run ▶ for python/bash/js/csv
      const _exportPdf = pane.querySelector('#doc-export-pdf-btn');
      const _pdfView = pane.querySelector('#doc-pdf-view-btn');
      if (_footer && _split) {
// 页脚顺序（左→右）：撤销、运行/预览、语言、…、复制/导出。
// X 关闭曾在此处，但现在与标题条中的每标签关闭按钮
// 冗余——已移除。
        if (_undo) _footer.insertBefore(_undo, _footer.firstChild);
        const _anchor = _undo;
        if (_preview && _anchor) _anchor.after(_preview);
        if (_lang) _split.before(_lang);
// 将所有仅头部的控件拉入页脚，使我们
// 始终只渲染一个底部操作行。独立的顶部头部
// 留下了一个重复行（带有全屏 + 版本徽章
// + 流指示器）。每个项目保持其自身的 display: toggling。
        const _streamInd = pane.querySelector('#doc-stream-indicator');
        const _versionBadge = pane.querySelector('#doc-version-badge');
        if (_split) {
          if (_pdfView)      _split.before(_pdfView);
          if (_exportPdf)    _split.before(_exportPdf);
          if (_versionBadge) _split.before(_versionBadge);
          if (_streamInd)    _split.before(_streamInd);
        }
      }
// iOS 在点击 <button> 时保持软键盘打开（它不会使
// 聚焦的 textarea 失焦），因此在你输入后它仍然存在。在任何
// 页脚控件点击时收起它。
      if (_footer) _footer.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('button, select')) return;
        const _ta = document.getElementById('doc-editor-textarea');
        if (_ta && document.activeElement === _ta) _ta.blur();
      });
    }

// 插入到 chat-container 之后（默认显示在右侧）
// 如果侧边栏在右侧，则插入到 chat-container 之前
    const sidebar = document.getElementById('sidebar');
    const isRight = sidebar && sidebar.classList.contains('right-side');
    if (isRight) {
      pane.classList.add('doc-left');
      container.parentNode.insertBefore(pane, container);
      container.parentNode.insertBefore(divider, container);
    } else {
      pane.classList.remove('doc-left');
      container.after(divider);
      divider.after(pane);
    }

// 从正确方向滑入动画
    const fromLeft = pane.classList.contains('doc-left');
    pane.style.transform = fromLeft ? 'translateX(-40px)' : 'translateX(40px)';
    pane.style.opacity = '0';
    requestAnimationFrame(() => {
      pane.style.transition = 'transform 0.15s cubic-bezier(0.22,1,0.36,1), opacity 0.12s ease-out';
      pane.style.transform = 'translateX(0)';
      pane.style.opacity = '1';
      pane.addEventListener('transitionend', () => {
        pane.style.transition = '';
        pane.style.transform = '';
        pane.style.opacity = '';
      }, { once: true });
    });

// 绑定分隔条拖拽调整大小
    initDividerDrag(divider, pane, isRight);
// 分隔条箭头——单按钮三种模式（字形在标记中相同
// 为 `›`；CSS 旋转 180° 得到向左指变体）。
//   • 光标在文档面板内  →  折叠（›，向后滑动，关闭面板）
//   • 光标在文档面板外  →  全屏（‹，向外滑动，扩展）
//   • 已全屏             →  退出全屏（›，指回内部）
// 用户也可以沿分隔条拖动箭头来重新定位。
// 重新定位它。
    const _divCollapse = divider.querySelector('.doc-divider-collapse');
    if (_divCollapse) {
      _divCollapse.addEventListener('mousedown', (e) => e.stopPropagation());
      let _dragging = false;
      _divCollapse.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_dragging) { _dragging = false; return; }  // suppress click after drag
        const mode = _divCollapse.dataset.mode;
        if (mode === 'fullscreen' || mode === 'unfullscreen') toggleFullscreen();
        else closePanel('down');
      });
      const HYSTERESIS = 24;
      const _applyMode = (ev) => {
// 全屏状态优先——一旦面板全屏，箭头始终提供
// "退出全屏"功能，无论光标位置。
// 无论光标位置如何。
        const isFull = pane.classList.contains('doc-fullscreen');
        if (isFull) {
          if (_divCollapse.dataset.mode !== 'unfullscreen') {
            _divCollapse.dataset.mode = 'unfullscreen';
            _divCollapse.title = t('document.fullscreen_exit');
          }
          return;
        }
        if (!ev) return;
        const rect = divider.getBoundingClientRect();
        const midX = (rect.left + rect.right) / 2;
        const cur = _divCollapse.dataset.mode;
        if (ev.clientX > midX + HYSTERESIS && cur !== 'collapse') {
          _divCollapse.dataset.mode = 'collapse';
          _divCollapse.title = t('document.collapse_panel');
        } else if (ev.clientX < midX - HYSTERESIS && cur !== 'fullscreen') {
          _divCollapse.dataset.mode = 'fullscreen';
          _divCollapse.title = t('document.fullscreen_enter');
        }
      };
      const _onMove = (ev) => _applyMode(ev);
      document.addEventListener('pointermove', _onMove, { passive: true });
// 切换时立即反映全屏状态（无需光标移动）。
      const _classObs = new MutationObserver(() => _applyMode());
      _classObs.observe(pane, { attributes: true, attributeFilter: ['class'] });

// 拖拽重新定位：按住并垂直拖动沿分隔条移动箭头。
// 存储为百分比，使调整面板大小时保持比例。
// 仅在轻微移动后激活，使正常点击仍能
// 注册为点击。
      const DRAG_THRESHOLD = 4;
      let _startY = 0, _moved = false, _pid = null;
      _divCollapse.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 && ev.pointerType === 'mouse') return;
        _startY = ev.clientY;
        _moved = false;
        _pid = ev.pointerId;
        _divCollapse.setPointerCapture?.(_pid);
        ev.preventDefault();
      });
      _divCollapse.addEventListener('pointermove', (ev) => {
        if (_pid === null) return;
        const dy = ev.clientY - _startY;
        if (!_moved && Math.abs(dy) < DRAG_THRESHOLD) return;
        _moved = true;
        _dragging = true;
        const rect = divider.getBoundingClientRect();
        if (!rect.height) return;
        const pct = Math.max(6, Math.min(94, ((ev.clientY - rect.top) / rect.height) * 100));
        _divCollapse.style.top = pct + '%';
      });
      const _endDrag = () => {
        if (_pid !== null) {
          try { _divCollapse.releasePointerCapture?.(_pid); } catch {}
          _pid = null;
        }
      };
      _divCollapse.addEventListener('pointerup', _endDrag);
      _divCollapse.addEventListener('pointercancel', _endDrag);

      const _obs = new MutationObserver(() => {
        if (!document.body.contains(divider)) {
          document.removeEventListener('pointermove', _onMove);
          _classObs.disconnect();
          _obs.disconnect();
        }
      });
      _obs.observe(document.body, { childList: true, subtree: true });
    }

// 移动端抓取柄——向下滑动关闭（类似其他工作表窗口）。
    _wireSwipeDismiss(document.getElementById('doc-mobile-grabber'));
    document.getElementById('doc-mobile-grabber')?.addEventListener('click', () => closePanel('down'));

// 绑定事件
    document.getElementById('doc-close-btn')?.addEventListener('click', () => closePanel('down'));
    document.getElementById('doc-footer-close-btn')?.addEventListener('click', () => { if (activeDocId) closeTab(activeDocId); });
    document.getElementById('doc-import-btn')?.addEventListener('click', () => openLibrary());
    document.getElementById('doc-footer-copy-btn')?.addEventListener('click', (e) => {
      if (e.currentTarget.dataset.mode === 'reply') { if (activeDocId) _sendSignedReply(activeDocId); }
      else copyDocument();
    });
    document.getElementById('doc-footer-export-btn')?.addEventListener('click', (e) => showExportMenu(null, e.currentTarget.getBoundingClientRect()));
// 移动端页脚：关闭当前文档 + 复制其内容（在小屏幕上
// 替代每标签 ×，镜像 email 阅读器的关闭页脚）。
    document.getElementById('doc-mobile-close')?.addEventListener('click', () => { if (activeDocId) closeTab(activeDocId); });
    document.getElementById('doc-mobile-copy')?.addEventListener('click', () => copyDocument());
// 保存、复制、运行、导出、删除、预览切换现在在每标签右键菜单中
    document.getElementById('doc-version-badge').addEventListener('click', toggleVersionHistory);
    document.getElementById('doc-version-close').addEventListener('click', _closeVersionPanel);
// 在类型选择旁边显示当前语言的小图标。
    const _syncLangIcon = () => {
      const iconEl = document.getElementById('doc-language-icon');
      const v = document.getElementById('doc-language-select')?.value || '';
      if (iconEl) iconEl.innerHTML = v ? langIcon(v, 14, { style: 'opacity:0.75;' }) : '';
    };
// 拦截编程式的 `langSelect.value = …`，使图标无需
// 在此文件中修改每个设置点即可更新。
    (function _interceptLangSelectValue() {
      const ls = document.getElementById('doc-language-select');
      if (!ls) return;
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      if (!desc || !desc.set) return;
      Object.defineProperty(ls, 'value', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) { desc.set.call(this, v); _syncLangIcon(); _syncLangPicker(); },
      });
      _syncLangIcon();  // initial paint
    })();

// ── 自定义语言选择器 ────────────────────────────────────
// 原生 <option> 无法渲染 SVG。因此我们构建一个自定义下拉菜单，
// 显示每种语言的图标 + 标签，同时保留底层
// <select> 作为真实来源（所有读写 langSelect.value 的现有代码
// 继续有效）。原生 select 在视觉上隐藏，但仍然可聚焦以支持无障碍/键盘。
// 视觉上隐藏但仍可聚焦以支持无障碍/键盘。
    let _syncLangPicker = () => {};
    (function _initLangPicker() {
      const ls = document.getElementById('doc-language-select');
      if (!ls || ls.dataset.pickerWired === '1') return;
      ls.dataset.pickerWired = '1';

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.id = 'doc-langpicker-trigger';
      trigger.className = 'doc-langpicker-trigger';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');

      const menu = document.createElement('div');
      menu.id = 'doc-langpicker-menu';
      menu.className = 'doc-langpicker-menu';
      menu.setAttribute('role', 'listbox');
      menu.style.display = 'none';

// 从 <select> 的真实 <option> 构建菜单行——单一
// 真实来源，未来对 select 的添加会自动传播。
      const _buildMenu = () => {
        menu.innerHTML = '';
        for (const opt of ls.options) {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'doc-langpicker-item';
          row.dataset.value = opt.value;
          row.setAttribute('role', 'option');
          const ic = opt.value
            ? langIcon(opt.value, 14, { style: 'opacity:0.85;' })
// 空值 = "类型"占位符选项——小圆点使
// 行仍与其他行对齐（且选择器在未设置类型时显示
// 某个标记）。
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.5;"><circle cx="12" cy="12" r="3"/></svg>';
          row.innerHTML = ic +
                          `<span class="doc-langpicker-label">${uiModule.esc(opt.textContent || opt.value)}</span>`;
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            if (ls.value !== opt.value) {
              ls.value = opt.value;
              ls.dispatchEvent(new Event('change', { bubbles: true }));
            }
            _close();
          });
          menu.appendChild(row);
        }
      };
      _buildMenu();

      _syncLangPicker = () => {
        const v = ls.value || '';
        const sel = Array.from(ls.options).find(o => o.value === v) || ls.options[0];
        const ic = v
          ? langIcon(v, 14, { style: 'opacity:0.85;flex-shrink:0;' })
// 尚未选择语言 → 小圆点标记，使触发器不显得空荡。
          : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.5;flex-shrink:0;"><circle cx="12" cy="12" r="3"/></svg>';
        trigger.innerHTML = ic +
          `<span class="doc-langpicker-label">${uiModule.esc(sel?.textContent || t('document.lang_picker_type'))}</span>` +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:4px;opacity:0.6;"><polyline points="6 9 12 15 18 9"/></svg>';
// 在打开菜单中高亮当前行。
        menu.querySelectorAll('.doc-langpicker-item').forEach(r => {
          r.classList.toggle('is-selected', r.dataset.value === v);
        });
      };

      const _close = () => {
        menu.style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', _outsideClick, true);
        document.removeEventListener('keydown', _escKey, true);
      };
      const _outsideClick = (e) => {
        if (!menu.contains(e.target) && e.target !== trigger) _close();
      };
      const _escKey = (e) => {
        if (e.key !== 'Escape' || menu.style.display === 'none') return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        _close();
      };

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = menu.style.display !== 'none';
        if (open) { _close(); return; }
// 将菜单定位在触发器下方（固定定位，使其脱离
// 任何溢出裁剪的祖先容器，如页脚）。
        const r = trigger.getBoundingClientRect();
        menu.style.display = 'block';
        menu.style.position = 'fixed';
        menu.style.left = r.left + 'px';
        menu.style.top = (r.bottom + 4) + 'px';
        menu.style.minWidth = r.width + 'px';
// 如果超出视口底部，翻转到上方。
        requestAnimationFrame(() => {
          const mr = menu.getBoundingClientRect();
          if (mr.bottom > window.innerHeight - 8) {
            menu.style.top = Math.max(8, r.top - mr.height - 4) + 'px';
          }
        });
        trigger.setAttribute('aria-expanded', 'true');
        document.addEventListener('click', _outsideClick, true);
        document.addEventListener('keydown', _escKey, true);
      });

// 隐藏原生 select 但保留在布局中以供屏幕阅读器
// /编程式值设置/焦点管理。旁边的图标 span
// 被移除，因为触发器现在承载当前图标。
      ls.classList.add('doc-langpicker-native-hidden');
      const iconSpan = document.getElementById('doc-language-icon');
      if (iconSpan) iconSpan.remove();
      ls.parentNode.insertBefore(trigger, ls);
// 菜单挂载在 body 上，使 position:fixed 坐标干净地工作。
      document.body.appendChild(menu);

      _syncLangPicker();
    })();
    document.getElementById('doc-language-select').addEventListener('change', () => {
      _syncLangIcon();
      _syncLangPicker();
      const val = document.getElementById('doc-language-select').value;
// 对于表单支持的文档，select 在 PDF 视图和
// markdown 源代码之间切换，而不是更改底层语言。
      const live = document.getElementById('doc-editor-textarea')?.value
        || docs.get(activeDocId)?.content || '';
      if (_isFormBackedDoc(live) && (val === 'pdf' || val === 'markdown')) {
        _setPdfViewActive(val === 'pdf');
        return;
      }
// 标记用户明确选择了语言——停止自动检测
      if (activeDocId && docs.has(activeDocId)) {
        docs.get(activeDocId).userSetLanguage = (val !== '');
      }
      updateLanguage();
      syncHighlighting();
// 显示/隐藏 markdown 工具栏
      const lang = document.getElementById('doc-language-select').value;
      const mdToolbar = document.getElementById('doc-md-toolbar');
      if (mdToolbar) {
// 工具栏现在对所有类型保持可见；只有内部项目
// 根据语言控制自身。
        mdToolbar.style.display = '';
        if (mdToolbar._syncOverflow) requestAnimationFrame(mdToolbar._syncOverflow);
      }
// 如果从 markdown 切换走，退出预览
      if (lang !== 'markdown') {
        _setMarkdownPreviewActive(false);
      }
// 如果从 CSV 切换走，退出表格预览
      if (lang !== 'csv') {
        const csvPreview = document.getElementById('doc-csv-preview');
        const wrap2 = document.getElementById('doc-editor-wrap');
        if (csvPreview) csvPreview.style.display = 'none';
        if (wrap2) wrap2.style.display = '';
      }
// 如果从 html 切换走，退出 HTML 预览
      if (!_isRenderLang(lang)) exitHtmlPreview();
// 显示/隐藏 email 字段
      if (lang === 'email') {
        const doc = activeDocId && docs.get(activeDocId);
        if (doc) _showEmailFields(doc);
      } else {
        _hideEmailFields();
      }
// 为新语言同步头部操作按钮
      _syncHeaderActions();
    });

// Email 发送/草稿按钮
// 将 emoji 选择器按钮注入 markdown 工具栏
    const emojiSlot = document.getElementById('md-toolbar-emoji-slot');
    if (emojiSlot && !emojiSlot.querySelector('.emoji-picker-btn')) {
// 在点击时解析实时目标：WYSIWYG email contenteditable
// 激活时，否则为纯文本 markdown textarea。
      emojiSlot.appendChild(emojiPicker.createEmojiButton(
        () => _emailRichbodyActive() || document.getElementById('doc-editor-textarea')
      ));
    }

    document.getElementById('doc-email-send-btn')?.addEventListener('click', () => {
// 按发送键时"更多选项"菜单绝对不能保持显示。
      const _m = document.getElementById('doc-email-more-menu');
      if (_m) _m.style.display = 'none';
      document.getElementById('doc-email-send-caret')?.setAttribute('aria-expanded', 'false');
      _sendEmail();
    });

// Ctrl+Enter / Cmd+Enter 在活动 email 文档时发送邮件
// 在模块级别通过守卫绑定一次，避免重新打开时重复监听
    if (!window._emailCtrlEnterBound) {
      window._emailCtrlEnterBound = true;
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          const doc = activeDocId && docs.get(activeDocId);
          if (doc && doc.language === 'email' && isOpen) {
            e.preventDefault();
            _sendEmail();
          }
        }
      });
    }
    document.getElementById('doc-email-draft-btn')?.addEventListener('click', () => {
      document.getElementById('doc-email-more-menu').style.display = 'none';
      _saveDraft();
    });
    document.getElementById('doc-email-discard-btn')?.addEventListener('click', _discardEmail);
    document.getElementById('doc-email-unread-btn')?.addEventListener('click', () => {
      document.getElementById('doc-email-more-menu').style.display = 'none';
      _markUnreadAndClose();
    });
    document.getElementById('doc-email-schedule-btn')?.addEventListener('click', (e) => {
      const anchor = document.getElementById('doc-email-send-caret') || e.currentTarget;
      document.getElementById('doc-email-more-menu').style.display = 'none';
      _scheduleSend(anchor);
    });
    document.getElementById('doc-email-ai-reply-btn')?.addEventListener('click', _aiReply);

    const collapseBtn = document.getElementById('doc-email-collapse-btn');
    if (collapseBtn && !collapseBtn._emailCollapseWired) {
      collapseBtn._emailCollapseWired = true;
      collapseBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const focusState = _captureEmailBodyFocusState();
        const header = document.getElementById('doc-email-header');
        const nextCollapsed = !header?.classList.contains('doc-email-header-collapsed');
        _setEmailHeaderCollapsed(nextCollapsed);
        if (!nextCollapsed) _restoreEmailBodyFocusState(focusState);
      });
      collapseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
    ['doc-email-to', 'doc-email-cc', 'doc-email-bcc', 'doc-email-subject'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', _syncEmailHeaderSummary);
      document.getElementById(id)?.addEventListener('focus', () => _setEmailHeaderCollapsed(false, { manual: false }));
    });
    document.getElementById('doc-email-richbody')?.addEventListener('focus', _maybeAutoCollapseEmailHeader);
    if (window.visualViewport && !window._docEmailViewportCollapseBound) {
      window._docEmailViewportCollapseBound = true;
      window.visualViewport.addEventListener('resize', _maybeAutoCollapseEmailHeader);
    }

// 分割按钮箭头切换发送选项菜单（向上弹出）。
    document.getElementById('doc-email-send-caret')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = document.getElementById('doc-email-more-menu');
      const caret = document.getElementById('doc-email-send-caret');
      if (!menu) return;
      const opening = menu.style.display === 'none';
      menu.style.display = opening ? '' : 'none';
      if (caret) caret.setAttribute('aria-expanded', String(opening));
    });
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('doc-email-more-menu');
// 仅在交互箭头自身或菜单时保持菜单打开。
// 任何其他点击——包括发送按钮（位于相同
// .email-send-split 中）——关闭它，使弹出框与箭头绑定。
      if (menu && !e.target.closest('#doc-email-send-caret, #doc-email-more-menu')) {
        menu.style.display = 'none';
        document.getElementById('doc-email-send-caret')?.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const menu = document.getElementById('doc-email-more-menu');
      if (!menu || menu.style.display === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      menu.style.display = 'none';
      document.getElementById('doc-email-send-caret')?.setAttribute('aria-expanded', 'false');
    }, true);

// 附件
    document.getElementById('doc-email-attach-btn')?.addEventListener('click', () => {
      document.getElementById('doc-email-file-input')?.click();
    });
    document.getElementById('md-toolbar-attach-btn')?.addEventListener('click', () => {
      document.getElementById('doc-email-file-input')?.click();
    });
    document.getElementById('doc-email-file-input')?.addEventListener('change', _handleAttachUpload);

// 抄送/密送切换
    document.getElementById('doc-email-show-cc')?.addEventListener('click', () => {
      _setEmailHeaderCollapsed(false, { manual: false });
      const ccRow = document.getElementById('doc-email-cc-row');
      const bccRow = document.getElementById('doc-email-bcc-row');
      if (ccRow) ccRow.style.display = '';
      if (bccRow) bccRow.style.display = '';
      document.getElementById('doc-email-show-cc').style.display = 'none';
      _syncEmailHeaderSummary();
    });

// 收件人/抄送/密送的自动完成——最后一个逗号之后的
// 输入片段触发联系人搜索；Enter/Tab/点击建议
// 追加 "<email>, "，以便用户可以继续输入更多收件人。
    _wireRecipientAutocomplete('doc-email-to',  'doc-email-to-suggestions');
    _wireRecipientAutocomplete('doc-email-cc',  'doc-email-cc-suggestions');
    _wireRecipientAutocomplete('doc-email-bcc', 'doc-email-bcc-suggestions');

// 头部统一操作按钮（根据语言显示预览或运行）
    document.getElementById('doc-header-preview-btn').addEventListener('click', () => {
      const lang = (document.getElementById('doc-language-select')?.value || '').toLowerCase();
      if (lang === 'markdown') toggleMarkdownPreview();
      else if (lang === 'csv') toggleCsvPreview();
      else if (_isRenderLang(lang)) toggleHtmlPreview();
      else {
// 可运行语言——切换输出
        const outputPanel = document.getElementById('doc-run-output');
        if (outputPanel && outputPanel.style.display !== 'none') {
          outputPanel.style.display = 'none';
        } else {
          runDocument();
        }
      }
      _syncHeaderActions();
    });

// Markdown 编辑/预览双图标切换——点击一侧切换到该视图。
    document.getElementById('doc-md-view-toggle')?.addEventListener('click', (e) => {
      const opt = e.target.closest('.md-view-opt');
      if (!opt) return;
      const wantPreview = opt.dataset.mdview === 'preview';
      const mdPrev = document.getElementById('doc-md-preview');
      const isPreview = mdPrev && mdPrev.style.display !== 'none';
      if (wantPreview !== isPreview) toggleMarkdownPreview();
      _syncHeaderActions();
    });

// 统一代码/运行或查看双图标切换——语言感知：CSV 在代码和表格视图之间切换，
// Python/JS/等在代码和运行输出之间，HTML/SVG/XML 在代码和 iframe 预览之间。
// 输出，HTML/SVG/XML 在代码和 iframe 预览之间。
    document.getElementById('doc-render-view-toggle')?.addEventListener('click', (e) => {
      const opt = e.target.closest('.md-view-opt');
      if (!opt) return;
      const wantRun = opt.dataset.renderview === 'run';
      const lang = (document.getElementById('doc-language-select')?.value || '').toLowerCase();
      if (lang === 'csv') {
        const csv = document.getElementById('doc-csv-preview');
        const isOn = csv && csv.style.display !== 'none';
        if (wantRun !== isOn) toggleCsvPreview();
      } else if (_isRenderLang(lang)) {
        const htmlPrev = document.getElementById('doc-html-preview');
        const isOn = htmlPrev && htmlPrev.style.display !== 'none';
        if (wantRun !== isOn) toggleHtmlPreview();
      } else {
// 可运行语言（python / js / ts / bash …）——点击运行是
// 一次性执行；点击代码关闭输出面板。
        if (wantRun) {
          document.getElementById('doc-header-preview-btn')?.click();
        } else {
          const out = document.getElementById('doc-run-output');
          if (out) out.style.display = 'none';
        }
      }
      _syncHeaderActions();
    });

// 字号切换（S → M → L）
    const fontBtn = document.getElementById('doc-fontsize-btn');
    const editorWrap = document.getElementById('doc-editor-wrap');
    const _fontSizes = ['s', 'm', 'l'];
    const _iconSizes = [12, 14, 16];
    let _fontIdx = parseInt(localStorage.getItem('odysseus-doc-fontsize') || '0', 10);
    if (!(_fontIdx >= 0 && _fontIdx < 3)) _fontIdx = 0;
    function _applyDocFont() {
      const richEmailBody = document.getElementById('doc-email-richbody');
      [editorWrap, richEmailBody].filter(Boolean).forEach(el => {
        el.classList.remove('doc-font-s', 'doc-font-m', 'doc-font-l');
        if (_fontSizes[_fontIdx] !== 's') el.classList.add('doc-font-' + _fontSizes[_fontIdx]);
      });
      if (fontBtn) {
        fontBtn.dataset.size = _fontSizes[_fontIdx];
// 保持原始行为：图标本身随字号变大。
        const svg = fontBtn.querySelector('svg');
        if (svg) { const sz = _iconSizes[_fontIdx]; svg.setAttribute('width', sz); svg.setAttribute('height', sz); }
// 仅显示活动尺寸字母（仅 S、或仅 M、或仅 L）。
        fontBtn.querySelectorAll('.doc-fontsize-levels [data-sz]').forEach(el => {
          const active = el.dataset.sz === _fontSizes[_fontIdx];
          el.classList.toggle('active', active);
          el.style.display = active ? '' : 'none';
        });
      }
      localStorage.setItem('odysseus-doc-fontsize', _fontIdx);
    }
    _applyDocFont();
// 点击循环切换尺寸（S → M → L → S）。
    if (fontBtn) fontBtn.addEventListener('click', () => {
      _fontIdx = (_fontIdx + 1) % 3;
      _applyDocFont();
      syncHighlighting();
    });

// 头部撤销按钮
    const docUndoBtn = document.getElementById('doc-undo-btn');
    if (docUndoBtn) docUndoBtn.addEventListener('click', async () => {
      const pdfPane = document.getElementById('doc-pdf-view');
      const pdfVisible = pdfPane && pdfPane.style.display !== 'none';
      if (pdfVisible && await _undoPdfPaneAction()) return;
      const ta = document.getElementById('doc-editor-textarea');
      if (ta) {
        ta.focus();   // execCommand('undo') needs the textarea focused
        document.execCommand('undo');
        _dismissDocKb();   // then force the keyboard back down on touch
      }
    });

// 差异切换按钮——将当前内容与上一版本比较
    const diffToggleBtn = document.getElementById('doc-diff-toggle-btn');
    if (diffToggleBtn) diffToggleBtn.addEventListener('click', async () => {
      if (_diffModeActive) {
        exitDiffMode(true);
        return;
      }
      if (!activeDocId) return;
      const ta = document.getElementById('doc-editor-textarea');
      if (!ta) return;
      const current = ta.value;

// 获取版本历史并与上一版本比较
      try {
        const res = await fetch(`${API_BASE}/api/document/${activeDocId}/versions`);
        if (!res.ok) throw new Error('Failed');
        const versions = await res.json();
        if (versions.length < 2) {
          if (uiModule) uiModule.showToast(t('document.version_no_previous'));
          return;
        }
// 版本按降序排列——[0] 是最新，[1] 是上一版本
        const prevContent = versions[1].content || '';
        if (prevContent === current) {
          if (uiModule) uiModule.showToast(t('document.version_no_changes'));
          return;
        }
        enterDiffMode(prevContent, current);
      } catch {
        if (uiModule) uiModule.showError(t('document.version_load_failed'));
      }
    });

// 导出 PDF（表单支持的 markdown 文档）
    document.getElementById('doc-export-pdf-btn')?.addEventListener('click', _downloadFilledPdf);

// 切换内联 PDF 视图（表单支持的 markdown 文档）。
// 表单支持文档的默认值是"活动"——切换读取可见状态。
    document.getElementById('doc-pdf-view-btn')?.addEventListener('click', () => {
      const pane = document.getElementById('doc-pdf-view');
      const visible = pane && pane.style.display !== 'none';
      _setPdfViewActive(!visible);
    });

// 工具栏按钮切换：点击活动模式清除它。否则
// 模式在多个位置之间保持激活，直到用户显式
// 关闭它。
    document.getElementById('doc-pdf-add-text-btn')?.addEventListener('click', () => _setPdfDropMode(_pdfDropMode === 'text' ? null : 'text'));
    document.getElementById('doc-pdf-add-check-btn')?.addEventListener('click', () => _setPdfDropMode(_pdfDropMode === 'check' ? null : 'check'));
    document.getElementById('doc-pdf-add-sign-btn')?.addEventListener('click', () => _setPdfDropMode(_pdfDropMode === 'signature' ? null : 'signature'));
    document.getElementById('doc-pdf-refresh-btn')?.addEventListener('click', () => _renderPdfPane());

// Markdown 格式工具栏
    initMdToolbar();

// 绑定高亮同步
    const ta = document.getElementById('doc-editor-textarea');
    const pre = document.getElementById('doc-editor-highlight');
    if (ta && pre) {
      ta.addEventListener('input', () => {
// 输入会使任何固定的选择高亮失效
        if (_selections.length) clearSelection();
// 如果用户在没有活动文档时输入/粘贴，自动创建文档。
// 当 createDocument POST 进行中时跳过——否则
// 往返期间的输入会产生重复的未命名文档。
        if (!activeDocId && !_creatingDoc && ta.value.trim()) {
          _autoCreateFromInput(ta.value);
          return;
        }
// 立即同步文本内容（防止滚动不同步导致视觉重复）
        const codeEl = document.getElementById('doc-editor-code');
        if (codeEl && !codeEl.dataset.hasDiff) {
          codeEl.textContent = ta.value + '\n';
          codeEl.style.minHeight = ta.scrollHeight + 'px';
        }
        if (pre) {
          pre.scrollTop = ta.scrollTop;
          pre.scrollLeft = ta.scrollLeft;
        }
        updateLineNumbers(ta.value);
// 对昂贵操作（语法高亮、自动检测、自动保存）进行防抖
        clearTimeout(_hlDebounce);
        _hlDebounce = setTimeout(syncHighlighting, 80);
        clearTimeout(_autoDetectDebounce);
        _autoDetectDebounce = setTimeout(attemptAutoDetect, AUTO_DETECT_DELAY);
        clearTimeout(_autoTitleDebounce);
        _autoTitleDebounce = setTimeout(() => autoTitleFromContent(ta.value), 600);
        clearTimeout(_autoSaveDebounce);
        _autoSaveDebounce = setTimeout(() => { saveDocument({ silent: true }); }, 2000);
      });
      ta.addEventListener('scroll', () => {
        const code = document.getElementById('doc-editor-code');
        if (code) code.style.minHeight = ta.scrollHeight + 'px';
        pre.scrollTop = ta.scrollTop;
        pre.scrollLeft = ta.scrollLeft;
        syncGutterScroll();
        syncSelectionOverlay();
// 重新定位查找矩形，使其在滚动时跟随 textarea。
        if (_findMatches && _findMatches.length) {
          const _q = document.getElementById('doc-find-input')?.value || '';
          if (_q) renderFindRects(_findMatches.map(s => [s, s + _q.length]), _findIdx);
        }
      });
// Tab 键插入真实制表符；Escape 清除选择
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (_diffModeActive) { exitDiffMode(true); return; }
// 首次 Esc 清除任何固定选择而不关闭
// 面板。第二次 Esc（无选择剩余）将面板最小化
// 为停靠芯片。之前的一键路径使一次 Esc
// 同时清除和关闭，这很烦人，因为用户通过按 Esc
// 消除错误的高亮而丢失了正在工作的文档。
// 错误的高亮。
          if (_selections.length > 0) {
            clearSelection();
            e.preventDefault();
            e.stopPropagation();
            return;
          }
// 无固定选择——Esc 将面板最小化（折叠
// 为停靠芯片）——与箭头按钮相同。
          e.preventDefault();
          e.stopPropagation();
          closePanel('down');
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          document.execCommand('insertText', false, '\t');
        }
// Markdown 快捷键（仅在语言为 markdown 时）
        const lang = document.getElementById('doc-language-select')?.value;
        if (lang === 'markdown' && (e.ctrlKey || e.metaKey)) {
          if (e.key === 'b') { e.preventDefault(); applyMdFormat('bold'); }
          else if (e.key === 'i') { e.preventDefault(); applyMdFormat('italic'); }
          else if (e.key === 'k') { e.preventDefault(); applyMdFormat('link'); }
        }
      });

// ── 文档内查找（Ctrl+F）──
      let _findMatches = [];
      let _findIdx = -1;

      function _openFindBar() {
        const bar = document.getElementById('doc-find-bar');
        if (!bar) return;
        bar.style.display = 'flex';
// 高亮覆盖层通常 display:none（单层渲染——
// textarea 拥有可见文本）。查找标记位于
// 该覆盖层内，因此在查找激活时我们必须重新显示它。
// body 类让 CSS 规则显示它，无需
// 触碰每个语言样式表路径。
        document.body.classList.add('doc-find-active');
        const inp = document.getElementById('doc-find-input');
        if (inp) { inp.focus(); inp.select(); }
      }
      function _closeFindBar() {
        const bar = document.getElementById('doc-find-bar');
        if (bar) bar.style.display = 'none';
        document.body.classList.remove('doc-find-active');
        _findMatches = [];
        _findIdx = -1;
        const cnt = document.getElementById('doc-find-count');
        if (cnt) cnt.textContent = '';
        const codeEl = document.getElementById('doc-editor-code');
        if (codeEl) {
          delete codeEl.dataset.findQuery;
          delete codeEl.dataset.findCurrent;
          applyFindMarks(codeEl);
        }
        renderFindRects([], -1);
        ta.focus();
      }
      function _doFind(dir, focusTextarea) {
        const inp = document.getElementById('doc-find-input');
        const cnt = document.getElementById('doc-find-count');
        if (!inp) return;
        const q = inp.value;
        const codeEl = document.getElementById('doc-editor-code');
        if (!q) {
          _findMatches = []; _findIdx = -1;
          if (cnt) cnt.textContent = '';
          if (codeEl) { delete codeEl.dataset.findQuery; delete codeEl.dataset.findCurrent; applyFindMarks(codeEl); }
          return;
        }
        const text = ta.value;
        const lq = q.toLowerCase();
        const lt = text.toLowerCase();
        _findMatches = [];
        let pos = 0;
        while (true) {
          const i = lt.indexOf(lq, pos);
          if (i < 0) break;
          _findMatches.push(i);
          pos = i + 1;
        }
        if (_findMatches.length === 0) {
          _findIdx = -1;
          if (cnt) cnt.textContent = '0 results';
          if (codeEl) { codeEl.dataset.findQuery = q; delete codeEl.dataset.findCurrent; applyFindMarks(codeEl); }
          renderFindRects([], -1);
          return;
        }
        if (dir === 'next') {
          _findIdx = _findIdx < _findMatches.length - 1 ? _findIdx + 1 : 0;
        } else if (dir === 'prev') {
          _findIdx = _findIdx > 0 ? _findIdx - 1 : _findMatches.length - 1;
        } else {
          _findIdx = 0;
        }
        if (cnt) cnt.textContent = `${_findIdx + 1} / ${_findMatches.length}`;
        const matchPos = _findMatches[_findIdx];
// 在 textarea 中高亮匹配项，不抢占输入焦点
        ta.setSelectionRange(matchPos, matchPos + q.length);
        const linesBefore = text.slice(0, matchPos).split('\n').length;
        const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 18;
        ta.scrollTop = Math.max(0, (linesBefore - 3) * lineH);
        if (codeEl) {
          codeEl.dataset.findQuery = q;
          codeEl.dataset.findCurrent = String(_findIdx);
          applyFindMarks(codeEl);
        }
// 在 textarea 上方使用专用覆盖矩形——
// 在 markdown/email/代码模式之间具有可靠的可见性。
        renderFindRects(_findMatches.map(s => [s, s + q.length]), _findIdx);
        if (focusTextarea) ta.focus();
      }

      document.getElementById('doc-find-close')?.addEventListener('click', _closeFindBar);
      document.getElementById('doc-find-next')?.addEventListener('click', () => _doFind('next', true));
      document.getElementById('doc-find-prev')?.addEventListener('click', () => _doFind('prev', true));
      document.getElementById('doc-find-input')?.addEventListener('input', () => _doFind('first', false));
      document.getElementById('doc-find-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); _closeFindBar(); }
        else if (e.key === 'Enter') { e.preventDefault(); _doFind(e.shiftKey ? 'prev' : 'next', false); }
      });

// 在编辑器面板拦截 Ctrl+F
      pane.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
          e.preventDefault();
          e.stopPropagation();
          _openFindBar();
        }
      });

// 在文档面板本身上按 Delete（或 Backspace）
//（不是在字段中输入时）删除活动文档。匹配 email 阅读器
// 的 Delete 行为，使键盘快捷键在各界面保持一致。
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        if (!isPanelOpen()) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        e.preventDefault();
        deleteActiveDocument();
      });

// 拖放文件附件用于 email 编写文档。整个面板
// 是放置目标；拖拽悬停时显示视觉高亮。放入的
// 文件通过相同的编写上传端点上传
// 如文件选择器一样。
      let _dragDepth = 0;
      const _isEmailDrag = (e) => {
        const doc = docs.get(activeDocId);
        if (!doc || doc.language !== 'email') return false;
        const dt = e.dataTransfer;
        if (!dt) return false;
// 仅文件——不在文本拖拽等情况下触发。
        return dt.types && Array.from(dt.types).includes('Files');
      };
      pane.addEventListener('dragenter', (e) => {
        if (!_isEmailDrag(e)) return;
        e.preventDefault();
        _dragDepth++;
        pane.classList.add('email-dragover');
      });
      pane.addEventListener('dragover', (e) => {
        if (!_isEmailDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      pane.addEventListener('dragleave', (e) => {
        if (!_isEmailDrag(e)) return;
        _dragDepth = Math.max(0, _dragDepth - 1);
        if (_dragDepth === 0) pane.classList.remove('email-dragover');
      });
      pane.addEventListener('drop', async (e) => {
        if (!_isEmailDrag(e)) return;
        e.preventDefault();
        _dragDepth = 0;
        pane.classList.remove('email-dragover');
        const files = e.dataTransfer.files;
        if (files && files.length) await _uploadComposeFiles(files);
      });

// 跟踪选择用于 AI 辅助编辑
      ta.addEventListener('mouseup', () => {
        setTimeout(updateSelectionState, 50);
      });
      ta.addEventListener('keyup', (e) => {
        if (e.shiftKey) updateSelectionState();
      });
// ESC 清除任何固定选择——匹配徽章的清除
// 按钮，使用户有相同操作的键盘快捷键。
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _selections.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          clearSelection();
        }
      });
    }

    renderTabs();

// 如果没有加载文档，显示带有有用占位符的空状态
    if (docs.size === 0 || !activeDocId) {
      showEmptyState();
    }
  }

  /** 将 markdown 格式应用于文本区选择 */
  let _lastMdFormat = { action: null, t: 0 };
// 样式的双字段链接对话框（显示文本 + URL）。解析为 {url, text}
// 或取消时返回 null。复用 styled-prompt CSS。文本可选——留空
// 时回退到选中的文本，再回退到 URL 本身。
  function _promptLink(defaultText = '') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.id = 'doc-link-prompt-overlay';
      overlay.className = 'modal';
      overlay.innerHTML =
        '<div class="modal-content styled-confirm-box styled-prompt-box">' +
          '<div class="modal-header"><h4>Insert link</h4></div>' +
          '<div class="modal-body">' +
            '<input type="text" id="doc-link-text" class="styled-prompt-input" placeholder="Link text (optional)" maxlength="500" />' +
            '<input type="url" id="doc-link-url" class="styled-prompt-input" placeholder="https://example.com" maxlength="2048" style="margin-top:8px;" />' +
          '</div>' +
          '<div class="modal-footer">' +
            '<button id="doc-link-cancel" class="confirm-btn confirm-btn-secondary">Cancel</button>' +
            '<button id="doc-link-ok" class="confirm-btn confirm-btn-primary">Insert</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      const textEl = overlay.querySelector('#doc-link-text');
      const urlEl = overlay.querySelector('#doc-link-url');
      textEl.value = defaultText || '';
      function done(result) {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(result);
      }
      function submit() {
        const url = (urlEl.value || '').trim();
        if (!url) { urlEl.focus(); return; }
        done({ url, text: (textEl.value || '').trim() });
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      }
      overlay.querySelector('#doc-link-ok').addEventListener('click', submit);
      overlay.querySelector('#doc-link-cancel').addEventListener('click', () => done(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
      urlEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); urlEl.focus(); } });
      document.addEventListener('keydown', onKey, true);
// 当文本已预填充时聚焦 URL 字段；否则从文本开始。
      requestAnimationFrame(() => { (defaultText ? urlEl : textEl).focus(); });
    });
  }

// Email WYSIWYG 链接插入。我们先快照 Range（对话框会窃取
// 焦点，否则会使其折叠），通过直接 DOM 操作插入，因为
// execCommand 在焦点移到模态框后不可靠。
  async function _wysiwygInsertLink(rich) {
    const selObj = window.getSelection();
    let savedRange = null;
    if (selObj && selObj.rangeCount) {
      const r = selObj.getRangeAt(0);
      if (rich.contains(r.commonAncestorContainer)) savedRange = r.cloneRange();
    }
    const selText = savedRange ? savedRange.toString() : '';
    let res;
    try { res = await _promptLink(selText); } catch (_) { res = null; }
    if (!res) { rich.focus(); return; }
    let url = (res.url || '').trim();
    if (!url) { rich.focus(); return; }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')) url = 'https://' + url;
    const linkText = (res.text || '').trim() || selText || url;

    if (!savedRange) {
      savedRange = document.createRange();
      savedRange.selectNodeContents(rich);
      savedRange.collapse(false);
    }
    const a = document.createElement('a');
    a.href = url;
    if (selText && linkText === selText) {
// 未更改的选择——包裹它以保留任何内联格式。
      a.appendChild(savedRange.extractContents());
    } else {
      savedRange.deleteContents();
      a.textContent = linkText;
    }
    savedRange.insertNode(a);
// 将插入符放在插入链接之后。
    const after = document.createRange();
    after.setStartAfter(a);
    after.collapse(true);
    rich.focus();
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(after);
    _syncEmailRichbody(rich);
  }

  function applyMdFormat(action) {
// 防止重复/"幽灵"点击快速连续触发同一切换两次——
// 那会导致先包裹然后立即取消包裹，使标记闪现
// 片刻后消失。
    const _now = Date.now();
    if (_lastMdFormat.action === action && _now - _lastMdFormat.t < 350) return;
    _lastMdFormat = { action, t: _now };
// Email WYSIWYG：通过 execCommand 格式化实时富文本，而不是
// 在（隐藏的）源 textarea 中插入 markdown 标记。
    const _rich = _emailRichbodyActive();
    if (_rich) {
      _rich.focus();
// 链接需要异步样式 URL 提示——单独处理以便我们
// 可以保存/恢复选择（否则打开模态框会使其折叠）。
      if (action === 'link') { _wysiwygInsertLink(_rich); return; }
      const _cmd = { bold: 'bold', italic: 'italic', strike: 'strikeThrough',
                     ul: 'insertUnorderedList', ol: 'insertOrderedList', hr: 'insertHorizontalRule' };
      try {
        if (_cmd[action]) document.execCommand(_cmd[action]);
        else if (action === 'h1' || action === 'h2' || action === 'h3') {
// 切换：如果块已经是此标题，恢复为普通段落；
// 否则应用（或切换为）该标题。
          const cur = _currentBlockTag(_rich);
          document.execCommand('formatBlock', false, (cur === action) ? 'div' : action);
        } else if (action === 'code') {
          const cur = _currentBlockTag(_rich);
          document.execCommand('formatBlock', false, (cur === 'pre') ? 'div' : 'pre');
        }
// 引用/复选框/代码块没有干净的 execCommand——WYSIWYG v1 中跳过。
      } catch (_) {}
      _syncEmailRichbody(_rich);
      if (_rich._syncActive) _rich._syncActive();
      return;
    }
    const ta = document.getElementById('doc-editor-textarea');
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;
    const sel = val.substring(start, end);
    const before = val.substring(0, start);
    const after = val.substring(end);

// 内联包裹切换：粗体、斜体、删除线、代码
    const wrapMarks = { bold: '**', italic: '*', strike: '~~', code: '`' };
    if (wrapMarks[action]) {
      const m = wrapMarks[action];
      _applyWrapToggle(ta, before, sel, after, start, end, m, action);
      return;
    }

// 编号列表——处理递增数字的特殊逻辑
    if (action === 'ol') {
      _applyOrderedList(ta, start, end);
      return;
    }

// 标题有自己的切换逻辑，应用相同级别则移除，
// 不同级别则干净切换（而不是堆叠 # 标记）。
    if (action === 'h1' || action === 'h2' || action === 'h3') {
      _applyHeadingToggle(ta, start, { h1: '# ', h2: '## ', h3: '### ' }[action]);
      return;
    }

// 行前缀切换：引用、列表、复选框
    const prefixMap = { quote: '> ', ul: '- ', check: '- [ ] ' };
    if (prefixMap[action]) {
      _applyLinePrefixToggle(ta, start, end, prefixMap[action]);
      return;
    }

// 非切换操作
    let insert = '';
    let sS = start, sE = start;
    switch (action) {
      case 'link':
        if (sel) {
          insert = `[${sel}](url)`;
          sS = start + 1; sE = start + 1 + sel.length;
        } else {
          insert = '[text](url)';
          sS = start + 1; sE = start + 5;
        }
        break;
      case 'codeblock': {
// 切换：查找当前行/选择是否在 ``` 块内
        const linesBefore = val.substring(0, start).split('\n');
        const linesAfter = val.substring(end).split('\n');
// 向后查找开头的 ```
        let openIdx = -1;
        for (let i = linesBefore.length - 1; i >= 0; i--) {
          if (/^```/.test(linesBefore[i].trimEnd())) { openIdx = i; break; }
        }
// 向前查找结尾的 ```
        let closeIdx = -1;
        for (let i = 0; i < linesAfter.length; i++) {
          if (/^```\s*$/.test(linesAfter[i].trimEnd())) { closeIdx = i; break; }
        }
        if (openIdx >= 0 && closeIdx >= 0) {
// 取消包裹：移除开头和结尾的围栏行
          const openLineStart = linesBefore.slice(0, openIdx).join('\n').length + (openIdx > 0 ? 1 : 0);
          const openLineEnd = openLineStart + linesBefore[openIdx].length + 1; // +1 for \n
          const closeLineStart = end + linesAfter.slice(0, closeIdx).join('\n').length + (closeIdx > 0 ? 1 : 0);
          const closeLineEnd = closeLineStart + linesAfter[closeIdx].length + (closeIdx < linesAfter.length - 1 ? 1 : 0);
// 先移除结尾（使索引保持有效），然后移除开头
          _replaceRange(ta, closeLineStart, closeLineEnd, '');
          _replaceRange(ta, openLineStart, openLineEnd, '');
          const inner = val.substring(openLineEnd, closeLineStart);
          ta.selectionStart = openLineStart;
          ta.selectionEnd = openLineStart + inner.length;
          return;
        }
// 包裹在代码块中
        const nl = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
        insert = nl + '```\n' + (sel || '') + '\n```\n';
        sS = start + nl.length + 4;
        sE = sS + (sel ? sel.length : 0);
        break;
      }
      case 'hr': {
        const nl = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
        insert = `${nl}---\n`;
        sE = sS = start + insert.length;
        break;
      }
      default: return;
    }
    _replaceRange(ta, start, end, insert);
    ta.selectionStart = sS;
    ta.selectionEnd = sE;
  }

  /** 使用 execCommand 替换文本区中的范围以保留撤销栈 */
  function _replaceRange(ta, from, to, text) {
    ta.focus();
    ta.selectionStart = from;
    ta.selectionEnd = to;
    const before = ta.value;
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (_) { ok = false; }
// execCommand('insertText') 保持原生撤销功能。但在某些移动浏览器上
// 静默无操作——因此仅当它没有更改任何内容时
// 我们直接拼接值（使用编辑前的值 + 原始范围，因此不会
// 双重插入）。execCommand 触发其自身的 input 事件；拼接路径
// 手动分发一个。
    if (!ok && ta.value === before) {
      ta.value = before.slice(0, from) + text + before.slice(to);
      ta.selectionStart = ta.selectionEnd = from + text.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  /** 切换内联包裹标记 (**, *, ~~, `) */
  function _applyWrapToggle(ta, before, sel, after, start, end, mark, action) {
    const mLen = mark.length;

// 情况 1：选择内容被包裹在里面——例如选中 "**bold**" → 取消包裹为 "bold"
    if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length > mLen * 2) {
      const inner = sel.slice(mLen, -mLen);
      _replaceRange(ta, start, end, inner);
      ta.selectionStart = start;
      ta.selectionEnd = start + inner.length;
      return;
    }

// 情况 2：标记在选择外部——例如 **|bold|** → 取消包裹
    if (before.endsWith(mark) && after.startsWith(mark)) {
      _replaceRange(ta, start - mLen, end + mLen, sel);
      ta.selectionStart = start - mLen;
      ta.selectionEnd = end - mLen;
      return;
    }

// 情况 3：包裹——添加标记。无选择时插入空标记和
// 将光标放在它们之间（不注入操作名称作为文本）。
    const inner = sel;
    const wrapped = mark + inner + mark;
    _replaceRange(ta, start, end, wrapped);
    ta.selectionStart = start + mLen;
    ta.selectionEnd = start + mLen + inner.length;
  }

  /** 切换行前缀（标题、引用、列表） */
// 包含当前选择的块级标签（h1/h2/h3/pre/p/…），位于
// contenteditable 根中——用于决定标题切换是
// 应用还是恢复。
  function _currentBlockTag(root) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return '';
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    while (node && node !== root) {
      const tag = node.tagName && node.tagName.toLowerCase();
      if (tag && /^(h1|h2|h3|h4|h5|h6|p|div|pre|blockquote|li)$/.test(tag)) return tag;
      node = node.parentNode;
    }
    return '';
  }

// Markdown textarea 的标题切换：先去除任何现有的
// 前导 `#{1,6} `，然后如果是相同级别则移除（切换关闭），
// 否则应用新级别。
  function _applyHeadingToggle(ta, caret, prefix) {
    const val = ta.value;
    const lineStart = val.lastIndexOf('\n', caret - 1) + 1;
    const nlIdx = val.indexOf('\n', caret);
    const lineEnd = nlIdx === -1 ? val.length : nlIdx;
    const line = val.substring(lineStart, lineEnd);
    const m = line.match(/^(#{1,6}) /);
    let newLine;
    if (m && m[1].length === prefix.trim().length) {
      newLine = line.slice(m[0].length);            // same level → toggle off
    } else if (m) {
      newLine = prefix + line.slice(m[0].length);   // different level → switch
    } else {
      newLine = prefix + line;                       // none → add
    }
    _replaceRange(ta, lineStart, lineEnd, newLine);
    const delta = newLine.length - line.length;
    const pos = Math.max(lineStart, caret + delta);
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
  }

  function _applyLinePrefixToggle(ta, start, end, prefix) {
    const val = ta.value;
    const sel = val.substring(start, end);
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;

    if (sel) {
// 多行：切换每行的前缀
      const lines = sel.split('\n');
      const nonEmpty = lines.filter(l => l.trim());
      const allPrefixed = nonEmpty.length > 0 && nonEmpty.every(l => l.startsWith(prefix));
      const result = allPrefixed
        ? lines.map(l => l.startsWith(prefix) ? l.slice(prefix.length) : l).join('\n')
        : lines.map(l => l.trim() ? prefix + l : l).join('\n');
      _replaceRange(ta, start, end, result);
      ta.selectionStart = start;
      ta.selectionEnd = start + result.length;
    } else {
// 无选择：切换当前行的前缀
      const lineBefore = val.substring(lineStart, start);

      if (lineBefore.startsWith(prefix)) {
// 移除前缀
        _replaceRange(ta, lineStart, lineStart + prefix.length, '');
      } else {
// 在行首添加前缀
        _replaceRange(ta, lineStart, lineStart, prefix);
      }
    }
  }

  /** 切换带递增数字的有序列表 */
  function _applyOrderedList(ta, start, end) {
    const val = ta.value;
    const sel = val.substring(start, end);
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;

    if (sel) {
      const lines = sel.split('\n');
      const nonEmpty = lines.filter(l => l.trim());
      const allNumbered = nonEmpty.length > 0 && nonEmpty.every(l => /^\d+\.\s/.test(l));
      const result = allNumbered
        ? lines.map(l => l.replace(/^\d+\.\s/, '')).join('\n')
        : (() => { let n = 0; return lines.map(l => l.trim() ? `${++n}. ${l}` : l).join('\n'); })();
      _replaceRange(ta, start, end, result);
      ta.selectionStart = start;
      ta.selectionEnd = start + result.length;
    } else {
      const lineBefore = val.substring(lineStart, start);
      if (/^\d+\.\s/.test(lineBefore)) {
        const prefixLen = lineBefore.match(/^\d+\.\s/)[0].length;
        _replaceRange(ta, lineStart, lineStart + prefixLen, '');
      } else {
// 查找上一个编号行以继续序列
        const prevText = val.substring(0, lineStart);
        const prevMatch = prevText.match(/(\d+)\.\s[^\n]*\n$/);
        const num = prevMatch ? parseInt(prevMatch[1]) + 1 : 1;
        _replaceRange(ta, lineStart, lineStart, `${num}. `);
      }
    }
  }

  /** 绑定 markdown 格式工具栏 */
// 分组格式下拉菜单（标题/代码/列表）。菜单追加到
// <body>，使可拖拽面板的 transform 不会裁剪其固定位置。
  let _mdDdOpenedAt = 0;
  function _showMdDropdown(toggleBtn) {
    const kind = toggleBtn.dataset.dd;
    const now = Date.now();
    const existing = document.getElementById('doc-md-dd-menu');
// 移动端在真实点击后立即触发重复/"幽灵"点击。如果它落在
// 同一切换上，会在菜单打开瞬间重新切换关闭。
// 在 400ms 内忽略同类型的重复调用，使菜单保持打开。
    if (existing && existing.dataset.dd === kind && (now - _mdDdOpenedAt) < 400) return;
    const prevKind = existing && existing.dataset.dd;
    if (existing) existing.remove();
    if (existing && prevKind === kind) return; // 同一开关再次点击 → 直接关闭
    _mdDdOpenedAt = now;

    const groups = {
      heading: [['h1', 'Heading 1', 'H1'], ['h2', 'Heading 2', 'H2'], ['h3', 'Heading 3', 'H3']],
      code: [['code', 'Inline code', '`'], ['codeblock', 'Code block', '```']],
      list: [['ul', 'Bullet list', '•'], ['ol', 'Numbered list', '1.']],
    };
    const items = groups[kind];
    if (!items) return;

    const rect = toggleBtn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'doc-md-dd-menu';
    menu.dataset.dd = kind;
    menu.className = 'doc-overflow-menu open';
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = rect.left + 'px';
    menu.style.zIndex = '9999';
    items.forEach(([md, label, ico]) => {
      const it = document.createElement('button');
      it.className = 'doc-overflow-item';
      const icoSpan = document.createElement('span');
      icoSpan.className = 'md-dd-ico';
      icoSpan.textContent = ico;
      const lbl = document.createElement('span');
      lbl.textContent = label;
      it.append(icoSpan, lbl);
// 不让菜单项从编辑器窃取焦点（保留选择）。
      it.addEventListener('mousedown', (ev) => ev.preventDefault());
      it.addEventListener('click', (ev) => { ev.stopPropagation(); menu.remove(); applyMdFormat(md); });
      menu.appendChild(it);
    });
    document.body.appendChild(menu);

    const close = (ev) => {
      if (ev && ev.type === 'keydown') {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation?.();
      }
      if (ev && ev.type === 'click') {
// 忽略移动端在打开后立即触发的幽灵/重复点击。
        if (Date.now() - _mdDdOpenedAt < 400) return;
        if (menu.contains(ev.target) || toggleBtn.contains(ev.target)) return;
      }
      menu.remove();
      document.removeEventListener('click', close, true);
      document.removeEventListener('keydown', close, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close, true);
    };
    setTimeout(() => {
      document.addEventListener('click', close, true);
      document.addEventListener('keydown', close, true);
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close, true);
    }, 0);
  }

  function initMdToolbar() {
    const toolbar = document.getElementById('doc-md-toolbar');
    if (!toolbar) return;

    const itemsWrap = document.getElementById('md-toolbar-items');
    const overflowWrapper = document.getElementById('md-toolbar-overflow-wrapper');
    const overflowToggle = document.getElementById('md-toolbar-overflow-toggle');
    const overflowMenu = document.getElementById('md-toolbar-overflow-menu');
    const undoBtn = document.getElementById('md-toolbar-undo');

// 格式按钮 + 分组下拉切换的点击处理器。菜单
// 追加到 <body>（不嵌套在工具栏内），使可拖拽面板的
// CSS transform 不会重新定位其固定位置或裁剪它。
// 当格式按钮/下拉切换被按下时保留编辑器焦点+选择。
// 否则按钮在按下时窃取焦点，折叠 textarea 选择
//（使 B/I/S 应用为空），在移动端还会收起键盘——
// 其视口调整随后立即关闭刚打开的任何下拉菜单。
// 阻止默认 mousedown 保持 textarea 聚焦，
// 使格式化命中实时选择，菜单保持打开。
    toolbar.addEventListener('mousedown', (e) => {
      if (e.target.closest('[data-md], .md-dd-toggle, .emoji-picker-btn')) e.preventDefault();
    });

    toolbar.addEventListener('click', (e) => {
      const dd = e.target.closest('.md-dd-toggle');
      if (dd) { e.preventDefault(); _showMdDropdown(dd); return; }
      const btn = e.target.closest('[data-md]');
      if (!btn) return;
      e.preventDefault();
      applyMdFormat(btn.dataset.md);
    });

// 撤销按钮
    if (undoBtn) {
      undoBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const ta = document.getElementById('doc-editor-textarea');
        if (ta) { ta.focus(); document.execCommand('undo'); }
      });
    }

// 溢出折叠逻辑
    let _mdMenuOpen = false;
// 水平滚动提示：工具栏滚动其图标；边缘箭头
// 在任一侧有更多内容时出现，并平滑滚动到该边缘。
    const scrollLeftBtn = document.getElementById('md-scroll-left');
    const scrollRightBtn = document.getElementById('md-scroll-right');
    function updateScrollArrows() {
      if (!itemsWrap || !scrollLeftBtn || !scrollRightBtn) return;
      const maxScroll = itemsWrap.scrollWidth - itemsWrap.clientWidth;
      const overflowing = maxScroll > 2;
      scrollLeftBtn.style.display = (overflowing && itemsWrap.scrollLeft > 1) ? 'flex' : 'none';
      scrollRightBtn.style.display = (overflowing && itemsWrap.scrollLeft < maxScroll - 1) ? 'flex' : 'none';
    }
    scrollLeftBtn?.addEventListener('click', () => itemsWrap.scrollTo({ left: 0, behavior: 'smooth' }));
    scrollRightBtn?.addEventListener('click', () => itemsWrap.scrollTo({ left: itemsWrap.scrollWidth, behavior: 'smooth' }));
    itemsWrap?.addEventListener('scroll', updateScrollArrows, { passive: true });
    if (window.ResizeObserver && itemsWrap) {
      new ResizeObserver(updateScrollArrows).observe(itemsWrap);
    }

    function syncMdOverflow() {
      if (overflowWrapper) overflowWrapper.style.display = 'none';
      updateScrollArrows();
    }

    function closeMdMenu() {
      _mdMenuOpen = false;
      if (overflowMenu) overflowMenu.classList.remove('open');
    }

    if (overflowToggle) {
      overflowToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        _mdMenuOpen = !_mdMenuOpen;
        if (_mdMenuOpen) {
          document.body.appendChild(overflowMenu);
          const rect = overflowToggle.getBoundingClientRect();
          overflowMenu.style.position = 'fixed';
          overflowMenu.style.top = (rect.bottom + 2) + 'px';
          overflowMenu.style.right = (window.innerWidth - rect.right) + 'px';
          overflowMenu.style.left = 'auto';
        } else {
          overflowWrapper.appendChild(overflowMenu);
        }
        overflowMenu.classList.toggle('open', _mdMenuOpen);
      });
    }
    document.addEventListener('click', () => {
      if (_mdMenuOpen) { closeMdMenu(); overflowWrapper.appendChild(overflowMenu); }
    });

// 在调整大小时重新检查溢出
    let _mdResizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(_mdResizeTimer);
      _mdResizeTimer = setTimeout(syncMdOverflow, 100);
    });

// 如果语言已是 markdown，显示工具栏
    const lang = document.getElementById('doc-language-select')?.value;
    if (lang === 'markdown') toolbar.style.display = '';

// 布局后初始同步
    requestAnimationFrame(syncMdOverflow);
// 暴露供外部调用（例如全屏切换后）
    toolbar._syncOverflow = syncMdOverflow;
  }

/** 将操作按钮折叠到溢出 "..." 菜单中（3 个最常用的可见） */
  const _DOC_RECENTS_KEY = 'odysseus-doc-actions-recent';
  const _DOC_MAX_VISIBLE = 2;

  function _getDocRecent() {
    try { return JSON.parse(localStorage.getItem(_DOC_RECENTS_KEY) || '[]'); } catch { return []; }
  }
  function _trackDocAction(id) {
    let recent = _getDocRecent().filter(x => x !== id);
    recent.unshift(id);
    if (recent.length > 10) recent.length = 10;
    localStorage.setItem(_DOC_RECENTS_KEY, JSON.stringify(recent));
  }

  function initActionOverflow() {
    const actionsEl = document.getElementById('doc-editor-actions');
    const wrapper = document.getElementById('doc-overflow-wrapper');
    const toggle = document.getElementById('doc-overflow-toggle');
    const menu = document.getElementById('doc-overflow-menu');
    if (!actionsEl || !wrapper || !toggle || !menu) return;

    const allBtns = Array.from(actionsEl.querySelectorAll('.doc-collapsible-btn'));
    let _menuOpen = false;

    function syncOverflow() {
      allBtns.forEach(b => { b.classList.remove('doc-collapsed'); });
      menu.innerHTML = '';

// 过滤到当前可见的按钮
      const available = allBtns.filter(b => b.style.display !== 'none');

// 按最近使用排序，默认：复制、导出、保存
      const recent = _getDocRecent();
      const defaults = ['doc-copy-btn', 'doc-export-btn', 'doc-save-btn'];
      const order = recent.length > 0 ? recent : defaults;

// 自动固定：当语言为 markdown 时，md 预览
      const lang = document.getElementById('doc-language-select')?.value;
      const pinned = [];
      if (lang === 'markdown') {
        const mdBtn = available.find(b => b.id === 'doc-md-btn');
        if (mdBtn) pinned.push(mdBtn);
      }

      const sorted = [...available].sort((a, b) => {
        const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1;
        if (bi >= 0) return 1;
        return 0;
      });

// 固定 + 前 N（去重）——固定计入最大数量
      const visible = [...pinned];
      for (const btn of sorted) {
        if (visible.length >= _DOC_MAX_VISIBLE) break;
        if (!visible.includes(btn)) visible.push(btn);
      }
// 确保不超过 MAX_VISIBLE
      while (visible.length > _DOC_MAX_VISIBLE) visible.pop();
      const overflow = sorted.filter(b => !visible.includes(b));

// 显示可见，隐藏溢出
      overflow.forEach(b => b.classList.add('doc-collapsed'));

// 重新排序 DOM：可见按钮在包装之前
      for (const btn of visible) {
        actionsEl.insertBefore(btn, wrapper);
      }

      if (overflow.length > 0) {
        wrapper.style.display = '';
        overflow.forEach(btn => {
          const item = document.createElement('button');
          item.className = 'doc-overflow-item';
          item.innerHTML = btn.innerHTML + '<span>' + (btn.title || '') + '</span>';
          item.addEventListener('click', (e) => {
            _trackDocAction(btn.id);
// 导出按钮有自己的子菜单
            if (btn.id === 'doc-export-btn') {
              e.stopPropagation();
              const savedRect = item.getBoundingClientRect();
              closeMenu();
              setTimeout(() => showExportMenu(null, savedRect), 50);
              return;
            }
            closeMenu();
            btn.click();
            syncOverflow(); // re-sort with new recency
          });
          menu.appendChild(item);
        });
      } else {
        wrapper.style.display = 'none';
      }
    }

    function closeMenu() {
      _menuOpen = false;
      menu.classList.remove('open');
    }

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      _menuOpen = !_menuOpen;
      if (_menuOpen) {
// 移动到 body 以脱离 doc-editor-pane 的 overflow:hidden
        document.body.appendChild(menu);
        const rect = toggle.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = (rect.bottom + 2) + 'px';
        menu.style.right = (window.innerWidth - rect.right) + 'px';
        menu.style.left = 'auto';
      } else {
        wrapper.appendChild(menu);
      }
      menu.classList.toggle('open', _menuOpen);
    });
    document.addEventListener('click', () => {
      if (_menuOpen) { closeMenu(); wrapper.appendChild(menu); }
    });

// 同时跟踪直接点击可见按钮时
    allBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        _trackDocAction(btn.id);
// 延迟重新排序，使点击处理器先触发
        setTimeout(syncOverflow, 100);
      });
    });

    requestAnimationFrame(syncOverflow);
    _syncOverflow = syncOverflow;
  }

  /** 分隔条拖拽调整编辑器面板大小 */
  function initDividerDrag(divider, pane, isRight) {
    let dragging = false;
    divider.addEventListener('mousedown', (e) => {
      dragging = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const width = isRight
        ? e.clientX
        : window.innerWidth - e.clientX;
      pane.style.width = Math.max(250, Math.min(width, window.innerWidth * 0.7)) + 'px';
      pane.style.flex = 'none';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
// 调整大小后重新同步语法高亮和行号
        syncHighlighting();
        const ta = document.getElementById('doc-editor-textarea');
        if (ta) updateLineNumbers(ta.value);
      }
    });
  }

  /** 关闭编辑器面板 */
// 当文档面板以"标签/箭头向下"方式最小化时，它作为芯片
// 存在于底部停靠栏中，而不是红色工具栏指示器。我们记住哪个
// 文档是活动的，以便芯片可以恢复它。
  let _minimizedDocId = null;

  function _ensureDocChipRegistered() {
    if (Modals.isRegistered('doc-panel')) return;
    Modals.register('doc-panel', {
// 最小化芯片上的 ✕ / 拖入垃圾桶是真正的关闭——将文档
// 从聊天会话中解绑，使其不在该聊天中重新出现。
      closeFn: () => {
// 面板最小化时内容已保存到 map，
// 因此只需解绑（不要重新读取现已移除的编辑器）。
        const id = _minimizedDocId;
        _minimizedDocId = null;
        if (id) _detachDocFromSession(id);
      },
      restoreFn: () => {
        const id = _minimizedDocId;
        _minimizedDocId = null;
// openPanel 构建面板外壳；switchToDoc 将保存的
// 文档内容重新渲染到其中（包括 PDF 渲染页面、语法
// 高亮等）。没有 switchToDoc，面板是空的。
        openPanel();
        if (id && docs.has(id)) {
          try { switchToDoc(id); } catch (e) { console.error('Restore doc failed:', e); }
        }
      },
    });
  }

  export function closePanel(direction) {
    if (!isOpen) {
      if (direction !== 'down' && Modals.isRegistered('doc-panel')) {
        _minimizedDocId = null;
        _markDocVisibleState(_lastSessionId, 'closed');
        Modals.unregister('doc-panel');
      }
      return;
    }
    isOpen = false;
// 在触摸时，关闭文档应保持键盘关闭。点击使
// textarea 失焦（键盘开始关闭），但拆卸过程中的意外重新聚焦
//（后面视图重新获得焦点等）会使其弹回。现在模糊任何
// 已聚焦的字段，并在关闭完成后再次模糊以保持键盘关闭。
    if (direction !== 'down' && (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0)) {
      const _dropKb = () => {
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) { try { ae.blur(); } catch (_) {} }
      };
      _dropKb();
      requestAnimationFrame(_dropKb);
      setTimeout(_dropKb, 80);
    }
// 保存当前状态
    saveCurrentToMap();

// "向下"关闭意味着最小化，而非关闭。注册芯片并翻转
// 停靠状态为最小化，使芯片出现在底部。任何
// 其他方向是真正的关闭——确保同时清除任何之前
// 最小化循环留下的芯片。
    if (direction === 'down') {
      _minimizedDocId = activeDocId;
      _markDocVisibleState(_lastSessionId, 'minimized');
      _ensureDocChipRegistered();
      Modals.minimize('doc-panel');
    } else if (Modals.isRegistered('doc-panel')) {
      _minimizedDocId = null;
      _markDocVisibleState(_lastSessionId, 'closed');
      Modals.unregister('doc-panel');
    } else {
      _markDocVisibleState(_lastSessionId, 'closed');
    }

    const pane = document.getElementById('doc-editor-pane');
    const divider = document.getElementById('doc-divider');

    const _finishClose = () => {
// 如果面板在滑出动画期间重新打开（关闭 →
// 快速重新打开，例如关闭草稿然后立即编写新的），
// 退出——否则这个过时的关闭在新打开重新添加
// doc-view 后会剥离它，新面板会降级到桌面分屏布局
//（在移动端呈现为窄"侧边栏"）。
      if (isOpen) { if (pane) pane.remove(); if (divider) divider.remove(); return; }
      document.body.classList.remove('doc-view');
      const container = document.getElementById('chat-container');
      if (container) container.style.display = '';
      if (pane) pane.remove();
      if (divider) divider.remove();
      activeDocId = null;
      const btn = document.getElementById('overflow-doc-btn');
      if (btn) btn.classList.remove('active');
      const docInd = document.getElementById('doc-indicator-btn');
      if (docInd) docInd.classList.remove('active');
    };

    if (pane) {
// 确定滑动方向
      let transform;
      if (direction === 'down') {
// 在移动端完全滑出屏幕（工作表关闭）；在桌面端小幅轻推。
        transform = window.innerWidth <= 768 ? 'translateY(100%)' : 'translateY(30px)';
      } else {
        const fromLeft = pane.classList.contains('doc-left');
        transform = fromLeft ? 'translateX(-40px)' : 'translateX(40px)';
      }
      pane.style.transition = 'transform 0.15s ease-in, opacity 0.1s ease-in';
      pane.style.transform = transform;
      pane.style.opacity = '0';
      if (divider) { divider.style.transition = 'opacity 0.1s ease-in'; divider.style.opacity = '0'; }
      pane.addEventListener('transitionend', _finishClose, { once: true });
// 安全回退
      setTimeout(_finishClose, 200);
    } else {
      _finishClose();
    }
  }

/** 切换文档面板侧（当侧边栏侧变化时调用） */
  export function swapSide() {
    if (!isOpen) return;
    const pane = document.getElementById('doc-editor-pane');
    const divider = document.getElementById('doc-divider');
    const container = document.getElementById('chat-container');
    if (!pane || !divider || !container) return;

    const sidebar = document.getElementById('sidebar');
    const isRight = sidebar && sidebar.classList.contains('right-side');

    if (isRight) {
// 侧边栏移到右侧 → 文档到左侧（chat 之前）
      pane.classList.add('doc-left');
      container.parentNode.insertBefore(pane, container);
      container.parentNode.insertBefore(divider, container);
    } else {
// 侧边栏移到左侧 → 文档到右侧（chat 之后）
      pane.classList.remove('doc-left');
      container.after(divider);
      divider.after(pane);
    }

// 为新侧重新初始化分隔条拖拽
    initDividerDrag(divider, pane, isRight);
  }

  // ---- 文档增删改查 ----

  /** 为当前会话创建新文档 */
// 创建新的空白文档，复用当前/上一个会话或
// 自动创建一个。与标签栏 "+" 相同的流程——侧边栏
// 资源库 "+" 也应使用的单一入口点。
  export async function newDocument() {
    let sessionId = docs.get(activeDocId)?.sessionId
      || _lastSessionId
      || (sessionModule && sessionModule.getCurrentSessionId());
    if (!sessionId) {
      try { sessionId = await _autoCreateSession(); }
      catch (e) { console.error('Failed to auto-create session for document:', e); return; }
    }
    await createDocument(sessionId);
  }

  export async function createDocument(sessionId) {
    if (_creatingDoc) return;
    _creatingDoc = true;
// 如果面板处于空状态，用户可能在创建往返期间
// 输入到编辑器中——将该文本保留到新文档中，
// 而不是让 switchToDoc 清空它。
    const wasEmpty = !activeDocId;
    try {
      const res = await fetch(`${API_BASE}/api/document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          title: '',
          content: '',
          language: 'markdown',
        }),
      });
      const doc = await res.json();
      addDocToTabs(doc, sessionId);
      if (!isOpen) openPanel();
// 如果处于空状态，重新启用编辑器
      let textarea = document.getElementById('doc-editor-textarea');
      if (textarea) {
        textarea.disabled = false;
        textarea.placeholder = t('document.editor_placeholder_content');
      }
// 捕获往返期间输入的文本（仅当从空编辑器开始时——
// 不要窃取其他文档的内容）。
      const typed = (wasEmpty && textarea && textarea.value.trim()) ? textarea.value : '';
      switchToDoc(doc.id);
      if (typed) {
        textarea = document.getElementById('doc-editor-textarea');
        if (textarea) textarea.value = typed;
        const d = docs.get(doc.id);
        if (d) d.content = typed;
        syncHighlighting();
        clearTimeout(_autoSaveDebounce);
        _autoSaveDebounce = setTimeout(() => { saveDocument({ silent: true }); }, 800);
      }
      textarea = document.getElementById('doc-editor-textarea');
      if (textarea) textarea.focus();
    } catch (e) {
      console.error('Failed to create document:', e);
      if (uiModule) uiModule.showError('Failed to create document');
    } finally {
      _creatingDoc = false;
    }
  }

  /** 将现有文档加载到标签中 */
  /** 将新创建的文档字典（来自POST响应）直接注入到
   * 标签中，无需通过GET重新获取。修复了GET
   * /api/document/{id} 在成功POST后可能出现404的竞态条件 — 我们已经
   * 从创建响应中获得了完整文档负载，无需往返请求。
   */
  export function injectFreshDoc(doc) {
    if (!doc || !doc.id) return;
    const sessionId = doc.session_id || _lastSessionId || null;
    addDocToTabs(doc, sessionId);
// 使用 _ensureDocPaneMounted（而非 `if (!isOpen) openPanel()`）：当从
// email 模态框编写草稿时，`isOpen` 可能是陈旧的 true，而
// 实际面板已被拆除——简单的 openPanel() 会提前返回，
// 文档挂载到错误/半建的面板中（在移动端呈现为窄侧边栏
// 而不是自己的全屏窗口）。这会干净地重新挂载。
    _ensureDocPaneMounted();
// 延迟到下一帧，使面板 DOM 在 switchToDoc 填充前存在
    requestAnimationFrame(() => requestAnimationFrame(() => {
      switchToDoc(doc.id);
    }));
  }

  export async function replaceEmailReplyBody(docId, replyText) {
    const doc = docs.get(docId);
    if (!doc) return;
    const fields = _parseEmailHeader(doc.content || '');
    const lines = String(fields.body || '').split('\n');
    const quoteIdx = lines.findIndex(line =>
      /^-{5,}\s*Previous message\s*-{5,}$/i.test(line.trim())
      || /^On .+ wrote:\s*$/i.test(line.trim())
    );
    const quote = quoteIdx >= 0 ? lines.slice(quoteIdx).join('\n') : '';
    const ownText = _emailReplyOwnText(fields.body || '');
    if (ownText && !/^(\[AI reply draft will appear here\]|Drafting AI reply)/i.test(ownText)) {
      if (uiModule) uiModule.showToast('AI reply ready, but draft was edited');
      return;
    }
    const body = String(replyText || '').trim() + (quote ? `\n\n${quote}` : '');
    doc.content = _buildEmailContent(
      fields.to,
      fields.subject,
      fields.inReplyTo,
      fields.references,
      body,
      fields.sourceUid,
      fields.sourceFolder,
      fields.cc,
      fields.bcc,
    );
    if (activeDocId === docId) {
      const textarea = document.getElementById('doc-editor-textarea');
      if (textarea) await _streamEmailBodyText(textarea, body);
    }
    clearTimeout(_autoSaveDebounce);
    _autoSaveDebounce = setTimeout(() => { saveDocument({ silent: true }); }, 800);
  }

// 强制面板进入真正打开状态。`isOpen` 可以是 true，但面板
// 已被另一个全屏视图拆除（例如从 email 模态框打开文档）：
// 此时 openPanel() 提前返回，什么都不挂载，因此
// 文档静默地从不出现。重置陈旧标志并真正重新打开。
  function _ensureDocPaneMounted() {
    if (!isOpen || !document.getElementById('doc-editor-pane')) {
      isOpen = false;
      openPanel();
    }
  }

  export async function loadDocument(docId) {
// 如果已在标签中，直接切换
    if (docs.has(docId)) {
      _ensureDocPaneMounted();
      switchToDoc(docId);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/document/${docId}`);
      if (!res.ok) throw new Error(res.status === 404 ? 'Not found' : `HTTP ${res.status}`);
      const doc = await res.json();
      addDocToTabs(doc, doc.session_id);
      _ensureDocPaneMounted();
      switchToDoc(doc.id);
    } catch (e) {
      console.error('Failed to load document:', e);
      if (uiModule) {
        const msg = e.message === 'Not found'
          ? 'Document not found — try opening it from the Library.'
          : 'Could not open document.';
        uiModule.showError(msg);
      }
    }
  }

// 深度链接：#document-<id> 在加载/URL 栏导航时打开该文档。
// 聊天中文档锚点的点击单独处理（它们调用
// preventDefault，因此不改变哈希）；这覆盖刷新
// 和粘贴/输入的文档 URL，此前它们无效。
  function _maybeOpenDocFromHash() {
    const m = (window.location.hash || '').match(/^#document-(.+)$/);
    if (m) loadDocument(m[1]);
  }

  /** 打开面板并确保文档存在，必要时创建会话 */
  export async function ensureDocPanel() {
    let sessionId = _lastSessionId
      || (sessionModule && sessionModule.getCurrentSessionId());
    if (!sessionId) {
      try {
        sessionId = await _autoCreateSession();
      } catch (e) {
        console.error('Failed to auto-create session for document:', e);
        openPanel();
        return;
      }
    }
    await loadSessionDocs(sessionId);
  }

  /** 创建会话并与sessions模块同步 */
  async function _autoCreateSession() {
// 如果有待处理的聊天，先将其具体化
    if (sessionModule && sessionModule.hasPendingChat && sessionModule.hasPendingChat()) {
      await sessionModule.materializePendingSession();
      const id = sessionModule.getCurrentSessionId();
      if (id) { _lastSessionId = id; return id; }
    }
// 创建文档会话时保留当前模型
    const curModel = sessionModule?.getCurrentModel ? sessionModule.getCurrentModel() : null;
    const sessions = sessionModule ? sessionModule.getSessions() : [];
    const match = curModel && sessions.find(s => s.model === curModel && s.endpoint_url);
    const fd = new FormData();
    fd.append('name', `Notes ${new Date().toLocaleTimeString()}`);
    fd.append('skip_validation', 'true');
    if (match) {
      fd.append('endpoint_url', match.endpoint_url);
      fd.append('model', match.model);
      if (match.endpoint_id) fd.append('endpoint_id', match.endpoint_id);
    }
    const res = await fetch(`${API_BASE}/api/session`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error('Session create failed');
    const payload = await res.json();
    const sessionId = payload.id;
    _lastSessionId = sessionId;
// 告诉会话模块，使聊天使用相同的会话
    if (sessionModule && sessionModule.setCurrentSessionId) {
      sessionModule.setCurrentSessionId(sessionId);
    }
    if (sessionModule && sessionModule.loadSessions) sessionModule.loadSessions();
    return sessionId;
  }

  /** 将会话的所有文档加载到标签中 */
  export async function loadSessionDocs(sessionId, opts = {}) {
    _lastSessionId = sessionId;
    const restoreMode = !!opts.restoreMode;
    const shouldRestoreOpen = localStorage.getItem(_docOpenKey(sessionId)) === '1';
    const shouldRestoreMinimized = localStorage.getItem(_docMinimizedKey(sessionId)) === '1';
// 清除其他会话的文档，使标签按会话组织，
// 但保留无会话文档（例如 email 编写）——它们是独立的
    for (const [id, doc] of [...docs]) {
      if (doc.sessionId && doc.sessionId !== sessionId) docs.delete(id);
    }
    activeDocId = null;

// 获取时显示加载状态
    if (isOpen) _showLoadingOverlay();

    try {
      const res = await fetch(`${API_BASE}/api/documents/${sessionId}`);
      const allDocs = await res.json();
      _hideLoadingOverlay();
// 仅加载活动文档
      const activeDocs = allDocs.filter(d => d.is_active);
      if (activeDocs.length === 0) {
// 尚无文档——显示空编辑器，用户输入时将创建文档
        if (!restoreMode || shouldRestoreOpen) {
          if (!isOpen) openPanel();
          showEmptyState();
          renderTabs();
        }
        return;
      }
      for (const doc of activeDocs) {
        if (!docs.has(doc.id)) {
          addDocToTabs(doc, sessionId);
        }
      }
      _syncDocIndicator();
// 切换到最近活动的（或第一个）
      const target = activeDocs[0];
      if (restoreMode && shouldRestoreMinimized && !shouldRestoreOpen) {
        activeDocId = null;
        _minimizedDocId = target.id;
        _markDocVisibleState(sessionId, 'minimized');
        _ensureDocChipRegistered();
        Modals.minimize('doc-panel');
        return;
      }
// 已移除：旧的 "if restoreMode && !shouldRestoreOpen → 保持
// 关闭"分支。用户期望进入带
// 附加文档的聊天时自动打开面板，而不是仅显示
// 一个指示器。上面的最小化分支仍然尊重
// 用户显式停靠面板的选择；其他所有情况
// 都落入下面的"打开面板"路径。
      if (false) {
        activeDocId = null;
        _minimizedDocId = null;
        if (Modals.isRegistered('doc-panel')) Modals.unregister('doc-panel');
        return;
      }
// 有文档时始终打开——上面的最小化分支
// 已为显式停靠面板的用户返回。
// 之前的 `if (!restoreMode || shouldRestoreOpen)` 门
// 在首次进入带文档的聊天时保持面板关闭，
// 隐藏文档除非用户手动打开面板。
      _markDocVisibleState(sessionId, 'open');
      if (!isOpen) openPanel();
      switchToDoc(target.id);
    } catch (e) {
      _hideLoadingOverlay();
      console.error('Failed to load session documents:', e);
// 出错时也打开空面板
      if (!isOpen) openPanel();
      showEmptyState();
    }
  }

  /** 将文档添加到标签映射 */
  function addDocToTabs(doc, sessionId) {
    const existing = docs.get(doc.id);
    docs.set(doc.id, {
      id: doc.id,
      title: doc.title || '',
      language: doc.language || '',
      content: doc.current_content || '',
      version: doc.version_count || 1,
      sessionId: sessionId || doc.session_id,
      userSetLanguage: !!doc.language,
      _composeAtts: existing?._composeAtts,
// "发送签名回复"流的溯源
      sourceEmailUid:       doc.source_email_uid || null,
      sourceEmailFolder:    doc.source_email_folder || null,
      sourceEmailAccountId: doc.source_email_account_id || null,
      sourceEmailMessageId: doc.source_email_message_id || null,
    });
  }

  /** 用文档数据填充编辑器（内部使用） */
  function populateEditor(doc) {
    const titleInput = document.getElementById('doc-title-input');
    const textarea = document.getElementById('doc-editor-textarea');
    const langSelect = document.getElementById('doc-language-select');
    const badge = document.getElementById('doc-version-badge');

    if (titleInput) titleInput.value = doc.title || '';
    if (textarea) textarea.value = doc.current_content || doc.content || '';
    if (langSelect) langSelect.value = doc.language || 'markdown';
    if (badge) { const _v = doc.version_count || doc.version || 1; badge.textContent = `v${_v}`; badge.style.display = _v > 1 ? '' : 'none'; }
    { const _v = doc.version_count || doc.version || 1; const _dbtn = document.getElementById('doc-diff-toggle-btn'); if (_dbtn) _dbtn.style.display = _v > 1 ? '' : 'none'; }
    syncHighlighting();
  }

  /** 后处理hljs markdown输出：着色[方括号]和标题#标记 */
  function _postProcessMarkdown(codeEl) {
    const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const text = node.textContent;
// 跳过已在 hljs span 内的节点（如 [link text] 是 .hljs-string）
      if (node.parentElement !== codeEl && node.parentElement.className &&
          /hljs-(string|link|code|section)/.test(node.parentElement.className)) continue;
// 匹配独立的 [方括号文本] 后不跟 (url)
      if (/\[[^\]]+\](?!\()/.test(text)) {
        const frag = document.createDocumentFragment();
        let last = 0;
        const re = /\[([^\]]+)\](?!\()/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          const span = document.createElement('span');
          span.className = 'md-bracket';
          span.textContent = m[0];
          frag.appendChild(span);
          last = re.lastIndex;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        if (last > 0) node.parentNode.replaceChild(frag, node);
      }
    }
// 在 .hljs-section span 中着色标题 # 标记
    codeEl.querySelectorAll('.hljs-section').forEach(span => {
      const text = span.textContent;
      const hashMatch = text.match(/^(#{1,6})\s/);
      if (hashMatch) {
        const marker = document.createElement('span');
        marker.className = 'md-heading-marker';
        marker.textContent = hashMatch[1] + ' ';
        span.textContent = text.slice(hashMatch[0].length);
        span.prepend(marker);
      }
    });
  }

// 查找结果矩形绘制在 textarea 上方——完全绕过
// 语法高亮覆盖层，使可见性在
// markdown、email 和任何其他模式中都有效，不受单层渲染
// 怪异行为的影响。与固定选择相同的镜像测量方法，
// 使换行与 textarea 精确匹配。
  //
// `matches` 是 [start, end] 偏移量数组；`currentIdx` 是
// 聚焦的匹配项（获得更亮的强调色）。传入空 matches 清除
// 所有矩形。
  function renderFindRects(matches, currentIdx) {
    const wrap = document.getElementById('doc-editor-wrap');
    if (!wrap) return;
    wrap.querySelectorAll('.doc-find-rect').forEach(el => el.remove());
    if (!matches || matches.length === 0) return;
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea) return;
    const text = textarea.value;
    const style = getComputedStyle(textarea);
    const paddingTop = parseFloat(style.paddingTop) || 10;
    const paddingLeft = parseFloat(style.paddingLeft) || 48;
    const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.45);

    let mirror = document.getElementById('doc-find-rect-mirror');
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.id = 'doc-find-rect-mirror';
      mirror.style.cssText = 'position:absolute;top:0;left:0;right:0;visibility:hidden;pointer-events:none;' +
        'white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;overflow:hidden;box-sizing:border-box;';
      wrap.appendChild(mirror);
    }
    mirror.style.font = style.font;
    mirror.style.padding = style.padding;
    mirror.style.borderWidth = style.borderWidth;
    mirror.style.borderStyle = 'solid';
    mirror.style.borderColor = 'transparent';
    mirror.style.width = textarea.clientWidth + 'px';
    mirror.style.tabSize = style.tabSize;
    mirror.style.letterSpacing = style.letterSpacing;
    mirror.style.wordSpacing = style.wordSpacing;
    mirror.style.textIndent = style.textIndent;

    const scrollTop = textarea.scrollTop;
    for (let i = 0; i < matches.length; i++) {
      const [s, e] = matches[i];
// 行带样式：高亮包含匹配的整行。
// 廉价、始终可见，不需要逐字符精确的
// 镜像测量（在 email/markdown/代码模式中可能不同）。
      mirror.textContent = text.substring(0, s);
      const startTop = mirror.scrollHeight - paddingTop;
// 通过在匹配结束位置之后多测量一个字符并回退到
// 最后一个空白边界来找到换行行尾。
      mirror.textContent = text.substring(0, e);
      const endHeight = mirror.scrollHeight - paddingTop;
      mirror.textContent = '';

      const top = paddingTop + startTop - scrollTop;
      const height = Math.max(endHeight - startTop, lineHeight);
      const rect = document.createElement('div');
      rect.className = 'doc-find-rect' + (i === currentIdx ? ' current' : '');
      rect.style.cssText =
        `position:absolute;left:${paddingLeft}px;right:8px;` +
        `top:${top}px;height:${height}px;` +
        `pointer-events:none;z-index:6;border-radius:2px;`;
      wrap.appendChild(rect);
    }
  }

  /** 在语法高亮叠加层中用<mark>标签包裹查找匹配项。
   * 遍历文本节点以保留现有hljs标签。跨语法标记的匹配项
   * 将被跳过（用户搜索中很少见）。 */
  function applyFindMarks(codeEl) {
    if (!codeEl) return;
// 移除先前的查找标记（取消包裹）
    codeEl.querySelectorAll('mark.doc-find-mark').forEach(m => {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
    const q = codeEl.dataset.findQuery || '';
    if (!q) return;
    const currentIdx = parseInt(codeEl.dataset.findCurrent || '-1', 10);
    const lq = q.toLowerCase();
    let occurrence = 0;
    const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
      const val = node.nodeValue || '';
      const lv = val.toLowerCase();
      if (!lv.includes(lq)) continue;
      const frag = document.createDocumentFragment();
      let i = 0;
      while (i < val.length) {
        const hit = lv.indexOf(lq, i);
        if (hit < 0) { frag.appendChild(document.createTextNode(val.slice(i))); break; }
        if (hit > i) frag.appendChild(document.createTextNode(val.slice(i, hit)));
        const mark = document.createElement('mark');
        mark.className = 'doc-find-mark' + (occurrence === currentIdx ? ' current' : '');
        mark.textContent = val.slice(hit, hit + q.length);
        frag.appendChild(mark);
        occurrence++;
        i = hit + q.length;
      }
      node.parentNode.replaceChild(frag, node);
    }
  }

  /** 将高亮叠加层与文本区内容同步 */
  function syncHighlighting() {
    const textarea = document.getElementById('doc-editor-textarea');
    const codeEl = document.getElementById('doc-editor-code');
    const pre = document.getElementById('doc-editor-highlight');
    if (!textarea || !codeEl) return;

// 不覆盖内联差异标记
    if (codeEl.dataset.hasDiff) return;

    const text = textarea.value;
// 尾随换行防止最后一行滚动不匹配
    codeEl.textContent = text + '\n';

    const lang = document.getElementById('doc-language-select')?.value;
// hljs 没有 'svg' 语法——将其作为 xml 高亮（下拉值保持
// 'svg'，使预览/运行路由仍然将其视为可渲染标记）。
    const _hlLang = lang === 'svg' ? 'xml' : lang;
    codeEl.className = _hlLang ? `language-${_hlLang}` : '';
    if (window.hljs && _hlLang) {
      codeEl.removeAttribute('data-highlighted');
      window.hljs.highlightElement(codeEl);
    }
// Markdown 后处理：着色独立 [方括号] 和标题标记
    if (lang === 'markdown') {
      _postProcessMarkdown(codeEl);
    }

// hljs 重写 DOM 后重新应用查找高亮
    if (codeEl.dataset.findQuery) applyFindMarks(codeEl);

// 保持滚动同步
    if (pre) {
      codeEl.style.minHeight = textarea.scrollHeight + 'px';
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
    }

// 更新行号
    updateLineNumbers(text);
  }

  /** 更新行号 gutter */
  let _lineNumberResizeObserver = null;
  let _lineNumberObservedTextarea = null;
  let _lineNumberResizeRaf = null;

  function _lineNumberContentEl(gutter) {
    let inner = gutter.querySelector('.doc-line-number-content');
    if (!inner) {
      inner = document.createElement('div');
      inner.className = 'doc-line-number-content';
      gutter.textContent = '';
      gutter.appendChild(inner);
    }
    return inner;
  }

  function _lineNumberStyleSignature(style) {
    return [
      style.fontFamily,
      style.fontSize,
      style.fontWeight,
      style.fontStyle,
      style.lineHeight,
      style.letterSpacing,
      style.tabSize,
      style.fontFeatureSettings,
      style.fontVariantLigatures,
      style.fontKerning,
    ].join('|');
  }

  function _textareaTextWidth(textarea, style) {
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    return Math.max(0, textarea.clientWidth - paddingLeft - paddingRight);
  }

  function _lineHeightPx(style) {
    const parsed = parseFloat(style.lineHeight);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    const fontSize = parseFloat(style.fontSize) || 11;
    return fontSize * 1.45;
  }

  function _lineNumberMeasureEl(textarea) {
    const wrap = document.getElementById('doc-editor-wrap') || textarea.parentElement || document.body;
    let probe = wrap.querySelector('.doc-line-number-measure');
    if (!probe) {
      probe = document.createElement('textarea');
      probe.className = 'doc-line-number-measure';
      probe.setAttribute('aria-hidden', 'true');
      probe.tabIndex = -1;
      probe.readOnly = true;
      probe.wrap = 'soft';
      wrap.appendChild(probe);
    }
    return probe;
  }

  function _syncLineNumberMeasureStyle(probe, style, textWidth) {
    probe.style.width = textWidth + 'px';
    probe.style.fontFamily = style.fontFamily;
    probe.style.fontSize = style.fontSize;
    probe.style.fontWeight = style.fontWeight;
    probe.style.fontStyle = style.fontStyle;
    probe.style.lineHeight = style.lineHeight;
    probe.style.letterSpacing = style.letterSpacing;
    probe.style.tabSize = style.tabSize;
    probe.style.fontFeatureSettings = style.fontFeatureSettings;
    probe.style.fontVariantLigatures = style.fontVariantLigatures;
    probe.style.fontKerning = style.fontKerning;
    probe.style.textRendering = style.textRendering;
    probe.style.whiteSpace = style.whiteSpace;
    probe.style.wordWrap = style.wordWrap;
    probe.style.overflowWrap = style.overflowWrap;
  }

  function _measureLineNumberHeights(textarea, lines, textWidth, style) {
    const probe = _lineNumberMeasureEl(textarea);
    _syncLineNumberMeasureStyle(probe, style, textWidth);
    const lineHeight = _lineHeightPx(style);
    return lines.map(line => {
      probe.value = line || ' ';
      const visualRows = Math.max(1, Math.round(probe.scrollHeight / lineHeight));
      return visualRows * lineHeight;
    });
  }

  function _renderLineNumberRows(inner, heights) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < heights.length; i++) {
      const row = document.createElement('div');
      row.className = 'doc-line-number-row';
      row.style.height = `${heights[i]}px`;

      const label = document.createElement('span');
      label.className = 'doc-line-number-label';
      label.textContent = String(i + 1);
      row.appendChild(label);
      frag.appendChild(row);
    }
    inner.textContent = '';
    inner.appendChild(frag);
  }

  function _scheduleLineNumberRerender() {
    if (_lineNumberResizeRaf) return;
    const run = () => {
      _lineNumberResizeRaf = null;
      const textarea = document.getElementById('doc-editor-textarea');
      if (textarea) updateLineNumbers(textarea.value, true);
    };
    if (typeof requestAnimationFrame === 'function') {
      _lineNumberResizeRaf = requestAnimationFrame(run);
    } else {
      run();
    }
  }

  function _ensureLineNumberResizeObserver(textarea) {
    if (typeof ResizeObserver === 'undefined') return;
    if (!_lineNumberResizeObserver) {
      _lineNumberResizeObserver = new ResizeObserver(_scheduleLineNumberRerender);
    }
    if (_lineNumberObservedTextarea === textarea) return;
    if (_lineNumberObservedTextarea) {
      _lineNumberResizeObserver.unobserve(_lineNumberObservedTextarea);
    }
    _lineNumberObservedTextarea = textarea;
    _lineNumberResizeObserver.observe(textarea);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', _scheduleLineNumberRerender);
  }

  function updateLineNumbers(text, force = false) {
    const textarea = document.getElementById('doc-editor-textarea');
    const gutter = document.getElementById('doc-line-numbers');
    if (!textarea || !gutter) return;

    const value = text || '';
    const lines = value.split('\n');
    const inner = _lineNumberContentEl(gutter);
    const style = getComputedStyle(textarea);
    const textWidth = _textareaTextWidth(textarea, style);
    const styleSig = _lineNumberStyleSignature(style);

    _ensureLineNumberResizeObserver(textarea);
    if (
      !force &&
      inner._lineNumberText === value &&
      inner._lineNumberWidth === textWidth &&
      inner._lineNumberStyleSig === styleSig
    ) {
      syncGutterScroll();
      return;
    }

    const heights = _measureLineNumberHeights(textarea, lines, textWidth, style);
    _renderLineNumberRows(inner, heights);
    inner._lineNumberText = value;
    inner._lineNumberWidth = textWidth;
    inner._lineNumberStyleSig = styleSig;
    syncGutterScroll();
  }

  /** 将行号 gutter 滚动与文本区同步 */
  function syncGutterScroll() {
    const textarea = document.getElementById('doc-editor-textarea');
    const gutter = document.getElementById('doc-line-numbers');
    if (textarea && gutter) {
      _lineNumberContentEl(gutter).style.transform = `translateY(${-textarea.scrollTop}px)`;
    }
  }

  /** 使用 hljs.highlightAuto() 尝试自动检测语言 */
  /** 在回退到hljs之前进行快速启发式markdown检测 */
  function _looksLikeMarkdown(text) {
    const lines = text.slice(0, 2000).split('\n');
    let score = 0;
    for (const line of lines) {
      if (/^#{1,6}\s/.test(line)) score += 3;         // headings
      else if (/^\s*[-*+]\s/.test(line)) score += 1;  // 列表项
      else if (/^\s*\d+\.\s/.test(line)) score += 1;  // 有序列表
      else if (/^\s*>/.test(line)) score += 1;         // 引用块
      else if (/\[.+\]\(.+\)/.test(line)) score += 2; // 链接
      else if (/^```/.test(line)) score += 2;          // 围栏代码
      else if (/\*\*.+\*\*/.test(line)) score += 1;   // 粗体
      else if (/^---\s*$/.test(line)) score += 1;      // 分割线
    }
    return score >= 3;
  }

  function attemptAutoDetect() {
    if (!window.hljs || !activeDocId) return;
    const doc = docs.get(activeDocId);
    if (!doc || doc.userSetLanguage) return;

    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea) return;

    const text = textarea.value;
    if (text.length < AUTO_DETECT_MIN_CHARS) return;

// SVG 启发式——独立的 <svg> 根（可选地跟在 XML 声明/
// doctype 之后）。hljs 会将其标记为通用 "xml"；我们希望标记为 svg，
// 使其以正确类型路由到预览 iframe。
    if (/^\s*(<\?xml[^>]*>\s*)?(<!doctype[^>]*>\s*)?<svg[\s>]/i.test(text)) {
      const langSelect = document.getElementById('doc-language-select');
      if (langSelect && langSelect.value !== 'svg') {
        langSelect.value = 'svg';
        doc.language = 'svg';
        updateLanguage();
        syncHighlighting();
        _syncHeaderActions();
      }
      return;
    }

// Markdown 启发式优先——hljs 经常无法检测到它
    if (_looksLikeMarkdown(text)) {
      const langSelect = document.getElementById('doc-language-select');
      if (langSelect && langSelect.value !== 'markdown') {
        langSelect.value = 'markdown';
        doc.language = 'markdown';
        updateLanguage();
        syncHighlighting();
        _syncHeaderActions();
        const mdToolbar = document.getElementById('doc-md-toolbar');
        if (mdToolbar) { mdToolbar.style.display = ''; if (mdToolbar._syncOverflow) requestAnimationFrame(mdToolbar._syncOverflow); }
      }
      return;
    }

    const sample = text.slice(0, AUTO_DETECT_SAMPLE_SIZE);
    const result = window.hljs.highlightAuto(sample);

    if (!result.language || result.relevance < AUTO_DETECT_MIN_RELEVANCE) return;

    const mapped = HLJS_TO_DROPDOWN[result.language];
    if (!mapped) return;

    const langSelect = document.getElementById('doc-language-select');
    if (!langSelect || langSelect.value === mapped) return;

    langSelect.value = mapped;
    doc.language = mapped;
    updateLanguage();
    syncHighlighting();
    _syncHeaderActions();

    const mdToolbar2 = document.getElementById('doc-md-toolbar');
    if (mdToolbar2) mdToolbar2.style.display = (mapped === 'markdown') ? '' : 'none';
  }

  // ---- 基于选择的 AI 编辑 ----

// 跟踪选择状态——当设置时，下一条聊天消息自动包含此上下文
  let _selections = [];  // [{ text, startLine, endLine, start, end }, ...]

// 固定选择覆盖层以像素坐标定位，测量基于
// textarea 的当前大小。当窗口缩小（或
// 侧边栏折叠，或面板调整大小）时，文本换行到更多行，
// 但覆盖矩形停留在原处——
// 视觉上偏离真正的高亮文本。在任何
// 大小更改时重新渲染，使覆盖层跟随新换行。通过
// rAF 防抖，以合并拖拽调整大小期间快速触发的
// ResizeObserver 脉冲。
  let _selResizeScheduled = false;
  function _scheduleSelRerender() {
    if (_selResizeScheduled || _selections.length === 0) return;
    _selResizeScheduled = true;
    requestAnimationFrame(() => {
      _selResizeScheduled = false;
      try { renderAllSelectionHighlights(); } catch (_) {}
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', _scheduleSelRerender);
  }
// 观察 textarea 自身，使内部布局变化（侧边栏折叠、
// 面板捕捉、移动端键盘显示/隐藏）也触发
// 重新渲染。观察器在首次选择时延迟附加，
// 避免在编辑器挂载之前产生开销。
  let _selResizeObserver = null;
  function _ensureSelResizeObserver() {
    if (_selResizeObserver || typeof ResizeObserver === 'undefined') return;
    const ta = document.getElementById('doc-editor-textarea');
    if (!ta) return;
    _selResizeObserver = new ResizeObserver(_scheduleSelRerender);
    _selResizeObserver.observe(ta);
  }

// 检测 textarea 当前是否有任何行换行。如果
// 每个逻辑行都适合一个视觉行，覆盖层位置
// 是精确的，固定选择无论全屏
// 状态如何都是安全的。我们从 scrollHeight/line-height 计算
// 渲染行数，并与 \n 分隔的行数比较。
  function _textareaWraps(ta) {
    if (!ta) return false;
    const style = getComputedStyle(ta);
    const lh = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.45);
    if (!lh) return false;
    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    const renderedRows = Math.round((ta.scrollHeight - padTop - padBottom) / lh);
    const logicalLines = (ta.value || '').split('\n').length;
    return renderedRows > logicalLines;
  }

  /** 更新选择跟踪，显示标记 + 持久高亮。
   *  每个新选择都被添加（固定）。无选择点击以清除全部。 */
  function updateSelectionState() {
// 当覆盖层测量可以精确时，固定选择是安全的。
// 这在两种情况下成立：(1) 全屏——宽度
// 稳定，或 (2) 无行换行——每个逻辑 \n 行适合一个
// 视觉行，因此逐字符精确的镜像测量不是
// 必需的。在两种情况之外，面板调整大小/换行偏移使
// 覆盖层漂移，因此我们无操作。
    const _pane = document.querySelector('.doc-editor-pane');
    const _isFs = !!(_pane && _pane.classList.contains('doc-fullscreen'));
    const _ta0 = document.getElementById('doc-editor-textarea');
    if (!_isFs && _textareaWraps(_ta0)) {
      if (_selections.length) clearSelection();
      return;
    }
    _ensureSelResizeObserver();
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    if (start === end) {
// 简单点击——不清除，用户可能点击到聊天中
      return;
    }

    const text = textarea.value;
    const selectedText = text.substring(start, end);
    const startLine = text.substring(0, start).split('\n').length;
    const endLine = text.substring(0, end).split('\n').length;

// 检查与现有选择的重叠——如果重叠则替换
    const overlapIdx = _selections.findIndex(s =>
      (start >= s.start && start <= s.end) || (end >= s.start && end <= s.end) ||
      (start <= s.start && end >= s.end)
    );
    const entry = { text: selectedText, startLine, endLine, start, end };
    if (overlapIdx >= 0) {
      _selections[overlapIdx] = entry;
    } else {
      _selections.push(entry);
    }

    showSelectionBadge();
    renderAllSelectionHighlights();
  }

  /** 显示带计数+清除按钮的选择指示器标记 */
  function showSelectionBadge() {
    let badge = document.getElementById('doc-selection-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'doc-selection-badge';
      badge.className = 'doc-selection-badge';
      badge.title = 'Selected regions — type in chat to edit';
// 直接位于格式工具栏下方，使其读取为工具栏行的一部分
// 而非埋在页面标题中。如果工具栏不在屏幕上，则回退到
// 编辑器标题。
      const toolbar = document.getElementById('doc-md-toolbar');
      if (toolbar && toolbar.parentNode) {
        toolbar.insertAdjacentElement('afterend', badge);
      } else {
        const header = document.querySelector('.doc-editor-header');
        if (header) header.insertBefore(badge, header.firstChild);
      }
    }
    if (_selections.length === 0) {
      badge.style.display = 'none';
      return;
    }
    const labels = _selections.map(s =>
      s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}-${s.endLine}`
    );
    const label = _selections.length === 1
      ? `${labels[0]} selected`
      : `${_selections.length} selections (${labels.join(', ')})`;
    badge.innerHTML = `${label}<button class="doc-selection-clear" title="Clear all selections">&times;</button>`;
    badge.style.display = '';
    badge.querySelector('.doc-selection-clear').addEventListener('click', (e) => {
      e.stopPropagation();
      clearSelection();
    });
  }

  /** Markdown/文本文档获得字符精确高亮（像
   *  普通浏览器选择但是持久化的）。代码文档获得基于行的
   *  高亮 — 在代码中工作时通常操作整行，
   *  字符基础的版本在等宽对齐下看起来抖动。 */
  function _isCodeDoc() {
    const lang = (document.getElementById('doc-language-select')?.value || '').toLowerCase();
    if (!lang) return false;
// 应获得逐字符精确高亮的散文/预览类型。
    const prose = new Set(['markdown', 'md', 'text', 'txt', 'email', 'html', 'csv']);
    return !prose.has(lang);
  }

  /** 测量字符索引在镜像元素中的视觉x,y位置
   *  通过在其中插入零宽标记span并
   *  读取其边界矩形。返回相对于镜像内容框原点的{x, y}。 */
*  content-box 原点。 */
  function _measurePos(mirror, text, pos) {
    mirror.innerHTML = '';
    if (pos > 0) mirror.appendChild(document.createTextNode(text.substring(0, pos)));
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.appendChild(marker);
    const r = marker.getBoundingClientRect();
    const m = mirror.getBoundingClientRect();
    return { x: r.left - m.left, y: r.top - m.top };
  }

  /** 为所有选择渲染持久高亮叠加层 */
// 根据实时 textarea 内容重新锚定固定选择。在
// 撤销或任何其他缩小/移动文本的路径之后，捕获的
// {start, end} 位置可能指向不相关的内容（或超出
// 缓冲区末尾）。我们：
//   1. 验证捕获的文本仍在 [start, end] 处。
//   2. 如果不在，在文档中其他位置查找捕获的文本并
//      重新锚定。优先选择最靠近旧位置的匹配。
//   3. 如果捕获的文本完全消失，则丢弃选择。
//   4. 重新锚定时刷新派生字段（startLine/endLine）。
// 每个选择 O(N) 成本；仅在 _selections 非空时运行。
  function _validateSelections(text) {
    if (_selections.length === 0) return;
    const survivors = [];
    for (const s of _selections) {
      const captured = s.text || '';
      if (!captured) continue;
// 快速路径：仍在相同的偏移量处。
      if (text.substring(s.start, s.end) === captured) {
        survivors.push(s);
        continue;
      }
// 重新锚定：查找捕获的文本并选择最靠近
// 旧开始的匹配，使多匹配文档不会跳到
// 错误的位置。indexOf 扫描对于典型文档大小是廉价的。
      let best = -1, bestDist = Infinity;
      let from = 0;
      while (true) {
        const idx = text.indexOf(captured, from);
        if (idx === -1) break;
        const dist = Math.abs(idx - s.start);
        if (dist < bestDist) { best = idx; bestDist = dist; }
        from = idx + 1;
      }
      if (best === -1) continue;  // text gone entirely → drop
      const newStart = best;
      const newEnd = best + captured.length;
      survivors.push({
        ...s,
        start: newStart,
        end: newEnd,
        startLine: text.substring(0, newStart).split('\n').length,
        endLine: text.substring(0, newEnd).split('\n').length,
      });
    }
    _selections = survivors;
  }

  function renderAllSelectionHighlights() {
    const wrap = document.getElementById('doc-editor-wrap');
    if (!wrap) return;
// 移除旧覆盖层
    wrap.querySelectorAll('.doc-selection-overlay').forEach(el => el.remove());

    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea || _selections.length === 0) return;

    const text = textarea.value;
// 预渲染守卫：重新锚定或丢弃文本已偏移的选择
//（撤销、编程编辑等），使覆盖层永远不会
// 绘制在错误区域上。
    _validateSelections(text);
    if (_selections.length === 0) return;
    const style = getComputedStyle(textarea);
    const paddingTop = parseFloat(style.paddingTop) || 10;
    const paddingLeft = parseFloat(style.paddingLeft) || 48;
    const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.45);

// 用于测量的共享镜像——与 textarea 相同的盒模型，
// 因此我们进行的任何测量与渲染文本 1:1 对齐。
    let mirror = document.getElementById('doc-selection-mirror');
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.id = 'doc-selection-mirror';
// box-sizing:border-box 是关键——没有它，镜像的
// 实际盒子宽度 = (width prop) + 水平内边距，这比
// textarea 的文本渲染区域宽。文本在镜像内
// 以不同的列换行，因此每个测量的 y 偏移
// 从真实文本所在位置漂移。border-box 使
// mirror.box = textarea.clientWidth 精确相等。
      mirror.style.cssText = 'position:absolute;top:0;left:0;right:0;visibility:hidden;pointer-events:none;' +
        'white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;overflow:hidden;box-sizing:border-box;';
      wrap.appendChild(mirror);
    }
    mirror.style.font = style.font;
    mirror.style.padding = style.padding;
    mirror.style.borderWidth = style.borderWidth;
    mirror.style.borderStyle = 'solid';
    mirror.style.borderColor = 'transparent';
    mirror.style.width = textarea.clientWidth + 'px';
    mirror.style.tabSize = style.tabSize;
    mirror.style.letterSpacing = style.letterSpacing;
    mirror.style.wordSpacing = style.wordSpacing;
    mirror.style.textIndent = style.textIndent;

    const codeDoc = _isCodeDoc();
    const scrollTop = textarea.scrollTop;

    for (const sel of _selections) {
      if (codeDoc) {
// 基于行：覆盖每个包含任何选中字符的行。
        const beforeStart = text.substring(0, sel.start);
        const lastNewline = beforeStart.lastIndexOf('\n');
        const startLineBegin = lastNewline + 1;
        mirror.textContent = text.substring(0, startLineBegin);
        const startTop = mirror.scrollHeight - paddingTop;

        const afterEnd = text.indexOf('\n', sel.end);
        const endLineEnd = afterEnd === -1 ? text.length : afterEnd;
        mirror.textContent = text.substring(0, endLineEnd);
        const endBottom = mirror.scrollHeight - paddingTop;

        mirror.textContent = '';

        const top = paddingTop + startTop - scrollTop;
        const height = endBottom - startTop || lineHeight;
        const overlay = document.createElement('div');
        overlay.className = 'doc-selection-overlay';
        overlay.style.top = top + 'px';
        overlay.style.left = paddingLeft + 'px';
        overlay.style.right = '0';
        overlay.style.height = height + 'px';
        wrap.appendChild(overlay);
      } else {
// 逐字符精确：通过标记 span 测量实际选择的开始/结束。
// 为单行选择渲染一个矩形，或
// 为多行选择渲染三个矩形（第一部分、中间整行、最后部分）。
// 多行选择。
        const startPos = _measurePos(mirror, text, sel.start);
        const endPos = _measurePos(mirror, text, sel.end);
        mirror.innerHTML = '';

        const addRect = (top, left, width, height) => {
          const overlay = document.createElement('div');
          overlay.className = 'doc-selection-overlay';
          overlay.style.top = (paddingTop + top - scrollTop) + 'px';
          overlay.style.left = (paddingLeft + left) + 'px';
          if (width != null) overlay.style.width = width + 'px';
          else overlay.style.right = '0';
          overlay.style.height = height + 'px';
          wrap.appendChild(overlay);
        };

        if (Math.abs(endPos.y - startPos.y) < 1) {
// 单视觉行。
          addRect(startPos.y, startPos.x, endPos.x - startPos.x, lineHeight);
        } else {
// 第一行：从选择开始到右边缘。
          addRect(startPos.y, startPos.x, null, lineHeight);
// 中间行（如果有）：两者之间的整行宽度条带。
          const middleTop = startPos.y + lineHeight;
          const middleHeight = endPos.y - middleTop;
          if (middleHeight > 0) addRect(middleTop, 0, null, middleHeight);
// 最后一行：从左边缘到选择结束。
          addRect(endPos.y, 0, endPos.x, lineHeight);
        }
      }
    }
  }

  /** 滚动时同步所有选择高亮位置 */
  function syncSelectionOverlay() {
    if (_selections.length === 0) return;
    renderAllSelectionHighlights();
  }

  /** 清除所有选择、标记和高亮 */
  function clearSelection() {
    _selections = [];
    const badge = document.getElementById('doc-selection-badge');
    if (badge) badge.style.display = 'none';
    const wrap = document.getElementById('doc-editor-wrap');
    if (wrap) wrap.querySelectorAll('.doc-selection-overlay').forEach(el => el.remove());
  }

  /**
   * 获取聊天注入的所有选择上下文。
   * 由聊天模块在发送消息前调用。
   * 如果没有选择则返回 null，或返回 { text, startLine, endLine } 数组。
   */
  export function getSelectionContext() {
    if (_selections.length === 0) return null;
// 在传递给聊天之前重新锚定/丢弃过时选择——
// 从过时偏移量发送文本意味着 AI 看到的内容
// 来自与用户认为已高亮的内容不同的区域。
    const _ta = document.getElementById('doc-editor-textarea');
    if (_ta) _validateSelections(_ta.value);
    if (_selections.length === 0) return null;
    if (_selections.length === 1) {
      const ctx = _selections[0];
      clearSelection();
      return ctx;
    }
// 多个选择——返回数组
    const ctx = [..._selections];
    clearSelection();
    return ctx;
  }

  // ── 内联建议注释（Google Docs 风格） ──

  let _activeSuggestions = []; // [{ id, find, replace, reason, highlightEl, bubbleEl }]

  /** 将建议持久化到活动文档的 localStorage */
  function _saveSuggestionsToStorage() {
    if (!activeDocId) return;
    const data = _activeSuggestions.map(s => ({ id: s.id, find: s.find, replace: s.replace, reason: s.reason }));
    if (data.length) {
      localStorage.setItem('odysseus-suggestions-' + activeDocId, JSON.stringify(data));
    } else {
      localStorage.removeItem('odysseus-suggestions-' + activeDocId);
    }
  }

  /** 从 localStorage 恢复文档的建议 */
  function _restoreSuggestionsFromStorage(docId) {
    try {
      const raw = localStorage.getItem('odysseus-suggestions-' + docId);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data) || !data.length) return;
      _activeSuggestions = data.map(s => ({ id: s.id, find: s.find, replace: s.replace, reason: s.reason, cardEl: null }));
      _suggestionTotal = _activeSuggestions.length;
      _suggestionIndex = 0;
      _showCurrentSuggestion();
    } catch {}
  }

  /** 处理 doc_suggestions SSE 事件 — 一次显示一个建议。
   *
   *  如果之前的批次已等待批准，新的建议
   *  会追加到实时队列中而不是替换它。Agent（或
   *  后续批次）可以在用户审查时继续添加编辑；计数
   *  和"n of m"标题会实时更新。 */
  export function handleDocSuggestions(data) {
    if (_diffModeActive) exitDiffMode(true);
    if (!data.suggestions || !data.suggestions.length) return;

    if (!isOpen) openPanel();
    if (data.doc_id && data.doc_id !== activeDocId) switchToDoc(data.doc_id);

    const hadPending = _activeSuggestions.length > 0;
    const existingIds = new Set(_activeSuggestions.map(s => s.id));

// 追加新建议，跳过队列中已有的任何 ID，
// 使重新发送的批次不重复。
    let added = 0;
    for (const sugg of data.suggestions) {
      if (existingIds.has(sugg.id)) continue;
      _activeSuggestions.push({
        id: sugg.id,
        find: sugg.find,
        replace: sugg.replace,
        reason: sugg.reason,
        cardEl: null,
      });
      added++;
    }
    _suggestionTotal = (_suggestionTotal || 0) + added;

    _saveSuggestionsToStorage();

// 如果之前没有待处理的建议，启动视觉流程。否则
// 当前显示的建议保留在屏幕上，队列大小更新
// 反映在下一张卡片标题中。
    if (!hadPending) {
      _suggestionIndex = 0;
      _showCurrentSuggestion();
    } else {
// 仅刷新活动卡片中的计数器，使用户看到
// 在他们思考期间队列已增长。
      const active = document.getElementById('doc-suggestion-active');
      if (active) {
        const counter = active.querySelector('.doc-suggestion-counter');
        if (counter) {
          const num = _suggestionTotal - _activeSuggestions.length + 1;
          counter.textContent = `${num} / ${_suggestionTotal}`;
        }
      }
    }
  }

/** 渲染当前建议卡片（一次一个）+ 文档中的内联差异 */
  function _showCurrentSuggestion() {
    const wrap = document.getElementById('doc-editor-wrap');
    const pane = document.querySelector('.doc-editor-pane');
    if (!wrap || !pane) return;

// 移除之前的卡片和内联差异
    const old = document.getElementById('doc-suggestion-active');
    if (old) { if (old._cleanup) old._cleanup(); old.remove(); }
    _clearSuggestionHighlight();
    _clearInlineDiff();

    if (_activeSuggestions.length === 0) {
      return;
    }

    const sugg = _activeSuggestions[0];
    const remaining = _activeSuggestions.length;
    const num = _suggestionTotal - remaining + 1;

// 在文档中显示内联差异
    _showInlineDiff(sugg.find, sugg.replace);

    const textarea = document.getElementById('doc-editor-textarea');

// 滚动到更改文本
    if (textarea) {
      const text = textarea.value;
      const idx = text.indexOf(sugg.find);
      if (idx >= 0) {
        const lineNum = text.substring(0, idx).split('\n').length - 1;
        const lineH = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
        const target = Math.max(0, lineNum * lineH - (textarea.clientHeight / 3));
        textarea.scrollTop = target;
      }
    }

// 将卡片放在高亮文本旁边
    function _positionCard(card) {
      if (!textarea) return;
      const text = textarea.value;
      const idx = text.indexOf(sugg.find);
      if (idx < 0) return;

      const linesBefore = text.substring(0, idx).split('\n').length - 1;
      const lineH = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
      const textareaRect = textarea.getBoundingClientRect();
      const paddingTop = parseFloat(getComputedStyle(textarea).paddingTop) || 10;
      const rawTop = textareaRect.top + paddingTop + (linesBefore * lineH) - textarea.scrollTop;
      const clampedTop = Math.max(60, Math.min(rawTop, window.innerHeight - 220));
      card.style.position = 'fixed';
      card.style.top = clampedTop + 'px';

      const paneRect = pane.getBoundingClientRect();
      const isMobile = window.innerWidth <= 768;
      if (!isMobile) {
        if (paneRect.right + 270 < window.innerWidth) {
          card.style.left = (paneRect.right + 16) + 'px';
          card.style.right = '';
        } else {
          card.style.left = '';
          card.style.right = (window.innerWidth - paneRect.left + 16) + 'px';
        }
      }

// 同时定位高亮覆盖层
      _clearSuggestionHighlight();
      _highlightSuggestionText(sugg.find);
    }

// 构建卡片
    const card = document.createElement('div');
    card.id = 'doc-suggestion-active';
    card.className = 'doc-suggestion-card';

    card.innerHTML = `
      <div class="doc-suggestion-header">
        <div class="doc-suggestion-nav">
          <button class="doc-suggestion-nav-btn doc-suggestion-prev" title="Previous">&lsaquo;</button>
          <span class="doc-suggestion-counter">${num} / ${_suggestionTotal}</span>
          <button class="doc-suggestion-nav-btn doc-suggestion-next" title="Next">&rsaquo;</button>
        </div>
        <button class="doc-suggestion-close" title="Close all suggestions">&times;</button>
      </div>
      <div class="doc-suggestion-reason">${_esc(sugg.reason)}</div>
      <div class="doc-suggestion-actions">
        <button class="doc-suggestion-accept">Accept</button>
        <button class="doc-suggestion-dismiss">Skip</button>
        ${remaining > 1 ? '<button class="doc-suggestion-accept-all">Accept All</button>' : ''}
      </div>
    `;

// 绑定按钮
    card.querySelector('.doc-suggestion-close').addEventListener('click', clearAllSuggestions);
    card.querySelector('.doc-suggestion-prev').addEventListener('click', () => {
      const current = _activeSuggestions.shift();
      _activeSuggestions.push(current);
      const prev = _activeSuggestions.pop();
      _activeSuggestions.unshift(prev);
      _suggestionIndex = (_suggestionIndex - 1 + _suggestionTotal) % _suggestionTotal;
      _showCurrentSuggestion();
    });
    card.querySelector('.doc-suggestion-next').addEventListener('click', () => {
      const current = _activeSuggestions.shift();
      _activeSuggestions.push(current);
      _suggestionIndex = (_suggestionIndex + 1) % _suggestionTotal;
      _showCurrentSuggestion();
    });
    card.querySelector('.doc-suggestion-accept').addEventListener('click', () => {
      _applySuggestion(sugg);
      _activeSuggestions.shift();
      _animateNext();
    });
    card.querySelector('.doc-suggestion-dismiss').addEventListener('click', () => {
      _activeSuggestions.shift();
      _animateNext();
    });
    const acceptAllBtn = card.querySelector('.doc-suggestion-accept-all');
    if (acceptAllBtn) {
      acceptAllBtn.addEventListener('click', () => {
        for (const s of _activeSuggestions) _applySuggestion(s);
        _activeSuggestions = [];
        _animateNext();
      });
    }

    sugg.cardEl = card;
    document.body.appendChild(card);

// 在一个 tick 后定位，使滚动生效
    requestAnimationFrame(() => _positionCard(card));

// 滚动/调整大小时重新定位，使卡片保持锚定
    const _reposition = () => { if (card.isConnected) _positionCard(card); };
    if (textarea) textarea.addEventListener('scroll', _reposition);
    window.addEventListener('resize', _reposition);
// 存储清理引用到卡片上
    card._cleanup = () => {
      if (textarea) textarea.removeEventListener('scroll', _reposition);
      window.removeEventListener('resize', _reposition);
    };
  }

/** 通过直接修改代码高亮元素显示内联差异 */
  function _showInlineDiff(findText, replaceText) {
    const codeEl = document.getElementById('doc-editor-code');
    const textarea = document.getElementById('doc-editor-textarea');
    if (!codeEl || !textarea) return;

    const text = textarea.value;
    const idx = text.indexOf(findText);
    if (idx === -1) return;

    const before = text.substring(0, idx);
    const after = text.substring(idx + findText.length);

// 逐字符差异
    let cPre = 0;
    while (cPre < findText.length && cPre < replaceText.length && findText[cPre] === replaceText[cPre]) cPre++;
    let cSuf = 0;
    while (cSuf < (findText.length - cPre) && cSuf < (replaceText.length - cPre) &&
           findText[findText.length - 1 - cSuf] === replaceText[replaceText.length - 1 - cSuf]) cSuf++;

    const commonBefore = findText.substring(0, cPre);
    const commonAfter = findText.substring(findText.length - cSuf);
    const delPart = findText.substring(cPre, findText.length - cSuf);
    const addPart = replaceText.substring(cPre, replaceText.length - cSuf);

// 用差异标记版本替换 codeEl 内容
    codeEl.innerHTML = '';
    codeEl.appendChild(document.createTextNode(before));
    if (commonBefore) codeEl.appendChild(document.createTextNode(commonBefore));

    if (delPart) {
      const del = document.createElement('span');
      del.className = 'sugg-inline-del';
      del.textContent = delPart;
      codeEl.appendChild(del);
    }
    if (addPart) {
      const add = document.createElement('span');
      add.className = 'sugg-inline-add';
      add.textContent = addPart;
      codeEl.appendChild(add);
    }

    if (commonAfter) codeEl.appendChild(document.createTextNode(commonAfter));
    codeEl.appendChild(document.createTextNode(after + '\n'));

// 标记我们有活动差异，使 syncHighlighting 不覆盖它
    codeEl.dataset.hasDiff = '1';
  }

/** 清除内联差异——恢复正常高亮 */
  function _clearInlineDiff() {
    const codeEl = document.getElementById('doc-editor-code');
    if (codeEl && codeEl.dataset.hasDiff) {
      delete codeEl.dataset.hasDiff;
      syncHighlighting();
    }
  }

// ---- 差异模式（行级审查）----

  const DIFF_MODE_THRESHOLD = 3; // 触发差异模式的最小更改行数

/** 行级 LCS 差异算法 */
  function _computeLineDiff(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const m = oldLines.length, n = newLines.length;

// 构建 LCS 表
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }

// 回溯以生成差异条目
    const entries = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        entries.push({ type: 'equal', line: oldLines[i - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        entries.push({ type: 'insert', line: newLines[j - 1] });
        j--;
      } else {
        entries.push({ type: 'delete', line: oldLines[i - 1] });
        i--;
      }
    }
    entries.reverse();
    return entries;
  }

/** 将差异条目分组为 chunks（连续更改块） */
  function _buildDiffChunks(entries) {
    const chunks = [];
    let chunkId = 0;
    let lineIdx = 0;
    let i = 0;
    while (i < entries.length) {
      const e = entries[i];
      if (e.type === 'equal') {
        lineIdx++;
        i++;
      } else {
// 收集连续的不等条目到一个 chunk 中
        const startLine = lineIdx;
        const oldLines = [], newLines = [];
        while (i < entries.length && entries[i].type !== 'equal') {
          if (entries[i].type === 'delete') oldLines.push(entries[i].line);
          else newLines.push(entries[i].line);
          i++;
        }
        chunks.push({
          id: chunkId++,
          oldLines,
          newLines,
          startLine,
          resolved: false,
          accepted: false,
        });
        lineIdx += oldLines.length + newLines.length;
      }
    }
    return chunks;
  }

/** 进入差异模式——显示行级差异以供审查 */
  function enterDiffMode(oldContent, newContent) {
    if (_diffModeActive) exitDiffMode(true);

    _diffModeActive = true;
    _diffOldContent = oldContent;
    _diffNewContent = newContent;

    const entries = _computeLineDiff(oldContent, newContent);
    _diffChunks = _buildDiffChunks(entries);
    _diffUnresolvedCount = _diffChunks.length;

    if (_diffChunks.length === 0) {
      _diffModeActive = false;
      if (uiModule) uiModule.showToast('No changes');
      return;
    }

    const textarea = document.getElementById('doc-editor-textarea');
    if (textarea) textarea.readOnly = true;
    const wrap = document.getElementById('doc-editor-wrap');
    if (wrap) wrap.classList.add('diff-mode');

    _renderDiffOverlay(entries);
    _renderDiffToolbar();
    _renderDiffGutter();

// 更新头部按钮
    const diffBtn = document.getElementById('doc-diff-toggle-btn');
    if (diffBtn) diffBtn.classList.add('active');
  }

/** 将行级差异渲染到代码高亮元素中 */
  function _renderDiffOverlay(entries) {
    const codeEl = document.getElementById('doc-editor-code');
    const gutter = document.getElementById('doc-line-numbers');
    if (!codeEl) return;

    codeEl.innerHTML = '';
    let gutterHtml = '';
    let oldNum = 0, newNum = 0;

// 通过同时遍历 chunks 和 entries 为条目预分配 chunk ID
    let chunkIdx = 0;
    let entryIdx = 0;
    const entryChunkMap = new Array(entries.length).fill(-1);
    while (entryIdx < entries.length) {
      if (entries[entryIdx].type === 'equal') {
        entryIdx++;
      } else {
// 这是更改块的开始——将所有连续的不等条目分配到当前 chunk
        const cid = chunkIdx < _diffChunks.length ? _diffChunks[chunkIdx].id : -1;
        while (entryIdx < entries.length && entries[entryIdx].type !== 'equal') {
          entryChunkMap[entryIdx] = cid;
          entryIdx++;
        }
        chunkIdx++;
      }
    }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === 'equal') {
        oldNum++; newNum++;
        const el = document.createElement('span');
        el.className = 'diff-line-equal';
        el.textContent = e.line + '\n';
        codeEl.appendChild(el);
        gutterHtml += newNum + '\n';
      } else if (e.type === 'delete') {
        oldNum++;
        const el = document.createElement('span');
        el.className = 'diff-line-del';
        if (entryChunkMap[i] >= 0) el.dataset.chunkId = entryChunkMap[i];
        el.textContent = e.line + '\n';
        codeEl.appendChild(el);
        gutterHtml += '−\n';
      } else {
        newNum++;
        const el = document.createElement('span');
        el.className = 'diff-line-add';
        if (entryChunkMap[i] >= 0) el.dataset.chunkId = entryChunkMap[i];
        el.textContent = e.line + '\n';
        codeEl.appendChild(el);
        gutterHtml += '+\n';
      }
    }

    if (gutter) gutter.textContent = gutterHtml;
    codeEl.dataset.hasDiff = '1';

// 同步 textarea 以显示组合视图（旧 + 新交错）用于滚动大小
    const textarea = document.getElementById('doc-editor-textarea');
    if (textarea) {
      const allLines = entries.map(e => e.line);
      textarea.value = allLines.join('\n') + '\n';
    }
  }

/** 在编辑器上方渲染差异工具栏 */
  function _renderDiffToolbar() {
    let toolbar = document.getElementById('doc-diff-toolbar');
    if (toolbar) toolbar.remove();

    toolbar = document.createElement('div');
    toolbar.id = 'doc-diff-toolbar';
    toolbar.className = 'diff-toolbar';

    const status = document.createElement('span');
    status.className = 'diff-toolbar-status';
    status.id = 'diff-toolbar-status';
    _updateDiffStatus(status);

    const acceptAll = document.createElement('button');
    acceptAll.className = 'diff-toolbar-btn diff-toolbar-btn-accept';
    acceptAll.textContent = 'Accept All';
    acceptAll.addEventListener('click', () => _resolveAllChunks(true));

    const rejectAll = document.createElement('button');
    rejectAll.className = 'diff-toolbar-btn diff-toolbar-btn-reject';
    rejectAll.textContent = 'Reject All';
    rejectAll.addEventListener('click', () => _resolveAllChunks(false));

    toolbar.appendChild(status);
    toolbar.appendChild(acceptAll);
    toolbar.appendChild(rejectAll);

    const wrap = document.getElementById('doc-editor-wrap');
    if (wrap) wrap.parentNode.insertBefore(toolbar, wrap);
  }

/** 在边栏覆盖层中渲染每个 chunk 的接受/拒绝按钮 */
  function _renderDiffGutter() {
    let gutterEl = document.getElementById('doc-diff-gutter');
    if (gutterEl) gutterEl.remove();

    gutterEl = document.createElement('div');
    gutterEl.id = 'doc-diff-gutter';
    gutterEl.className = 'diff-gutter';

    const codeEl = document.getElementById('doc-editor-code');
    if (!codeEl) return;

// 在每个 chunk 的第一个更改行旁边直接插入 chunk 操作按钮
// 这样它们自然随内容滚动
    requestAnimationFrame(() => {
      for (const chunk of _diffChunks) {
        if (chunk.resolved) continue;
        const firstEl = codeEl.querySelector(`[data-chunk-id="${chunk.id}"]`);
        if (!firstEl) continue;

        const actions = document.createElement('span');
        actions.className = 'diff-chunk-actions';
        actions.dataset.chunkId = chunk.id;

        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'diff-chunk-btn diff-chunk-btn-accept';
        acceptBtn.title = 'Accept change';
        acceptBtn.innerHTML = '✓';
        acceptBtn.addEventListener('click', (e) => { e.stopPropagation(); _resolveChunk(chunk.id, true); });

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'diff-chunk-btn diff-chunk-btn-reject';
        rejectBtn.title = 'Reject change';
        rejectBtn.innerHTML = '✗';
        rejectBtn.addEventListener('click', (e) => { e.stopPropagation(); _resolveChunk(chunk.id, false); });

        actions.appendChild(acceptBtn);
        actions.appendChild(rejectBtn);

// 插入到第一行 span 的开头
        firstEl.style.position = 'relative';
        firstEl.appendChild(actions);
      }
    });
  }

/** 更新工具栏状态文本 */
  function _updateDiffStatus(statusEl) {
    const el = statusEl || document.getElementById('diff-toolbar-status');
    if (!el) return;
    const resolved = _diffChunks.length - _diffUnresolvedCount;
    el.textContent = `${resolved} / ${_diffChunks.length} changes resolved`;
  }

/** 解析单个 chunk */
  function _resolveChunk(chunkId, accept) {
    const chunk = _diffChunks.find(c => c.id === chunkId);
    if (!chunk || chunk.resolved) return;

    chunk.resolved = true;
    chunk.accepted = accept;
    _diffUnresolvedCount--;

// 在覆盖层中淡化已解析的行
    const codeEl = document.getElementById('doc-editor-code');
    if (codeEl) {
      codeEl.querySelectorAll(`[data-chunk-id="${chunkId}"]`).forEach(el => {
        el.classList.add('diff-chunk-resolved');
      });
    }

// 移除此 chunk 的边栏按钮
    const gutterActions = document.querySelector(`.diff-chunk-actions[data-chunk-id="${chunkId}"]`);
    if (gutterActions) gutterActions.remove();

    _updateDiffStatus();

// 持久化部分进度，使刷新不丢失单独解析的 chunk
    _applyResolvedChunksToTextarea();
    saveDocument({ silent: true });

    if (_diffUnresolvedCount === 0) {
      setTimeout(() => exitDiffMode(false), 300);
    }
  }

/** 从旧内容 + 已解析的 chunk 决策计算当前内容；未解析的 chunk
*  默认为原始内容（拒绝）直到用户决定。更新 textarea。 */
  function _applyResolvedChunksToTextarea() {
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea) return;
    const entries = _computeLineDiff(_diffOldContent || '', _diffNewContent || '');
    const result = [];
    let chunkIdx = 0;
    let i = 0;
    while (i < entries.length) {
      if (entries[i].type === 'equal') {
        result.push(entries[i].line);
        i++;
      } else {
        const chunk = _diffChunks[chunkIdx++];
        const chunkOld = [], chunkNew = [];
        while (i < entries.length && entries[i].type !== 'equal') {
          if (entries[i].type === 'delete') chunkOld.push(entries[i].line);
          else chunkNew.push(entries[i].line);
          i++;
        }
// 已解析+接受 → 使用新内容；已解析+拒绝 或 未解析 → 保留旧内容
        if (chunk && chunk.resolved && chunk.accepted) {
          result.push(...chunkNew);
        } else {
          result.push(...chunkOld);
        }
      }
    }
    textarea.value = result.join('\n');
  }

/** 一次性解析所有 chunk */
  function _resolveAllChunks(accept) {
    for (const chunk of _diffChunks) {
      if (!chunk.resolved) {
        chunk.resolved = true;
        chunk.accepted = accept;
      }
    }
    _diffUnresolvedCount = 0;
    exitDiffMode(false);
  }

/** 退出差异模式并应用已解析的更改 */
  function exitDiffMode(discard) {
    if (!_diffModeActive) return;
    _diffModeActive = false;

    const textarea = document.getElementById('doc-editor-textarea');
    const codeEl = document.getElementById('doc-editor-code');
    const wrap = document.getElementById('doc-editor-wrap');
    if (wrap) wrap.classList.remove('diff-mode');

    if (discard) {
// 全部拒绝——恢复原始内容
      if (textarea) textarea.value = _diffOldContent || '';
    } else {
// 从已解析的 chunk 构建最终内容
      const oldLines = (_diffOldContent || '').split('\n');
      const newLines = (_diffNewContent || '').split('\n');
      const entries = _computeLineDiff(_diffOldContent || '', _diffNewContent || '');

      const result = [];
      let chunkIdx = 0;
      let i = 0;
      while (i < entries.length) {
        if (entries[i].type === 'equal') {
          result.push(entries[i].line);
          i++;
        } else {
// 找到匹配的 chunk
          const chunk = _diffChunks[chunkIdx++];
// 跳过属于此 chunk 的所有条目
          const chunkOld = [], chunkNew = [];
          while (i < entries.length && entries[i].type !== 'equal') {
            if (entries[i].type === 'delete') chunkOld.push(entries[i].line);
            else chunkNew.push(entries[i].line);
            i++;
          }
          if (chunk && chunk.accepted) {
            result.push(...chunkNew);
          } else {
            result.push(...chunkOld);
          }
        }
      }
      if (textarea) textarea.value = result.join('\n');
    }

// 恢复编辑器状态
    if (textarea) textarea.readOnly = false;
    if (codeEl) delete codeEl.dataset.hasDiff;

// 清理工具栏和任何剩余的 chunk 操作按钮
    const toolbar = document.getElementById('doc-diff-toolbar');
    if (toolbar) toolbar.remove();
    document.querySelectorAll('.diff-chunk-actions').forEach(el => el.remove());

// 重置状态
    _diffOldContent = null;
    _diffNewContent = null;
    _diffChunks = [];
    _diffUnresolvedCount = 0;

    const diffBtn = document.getElementById('doc-diff-toggle-btn');
    if (diffBtn) diffBtn.classList.remove('active');

    syncHighlighting();
    updateLineNumbers(textarea ? textarea.value : '');
    saveDocument({ silent: true });
  }

/** 检查差异模式是否活动 */
  function isDiffModeActive() { return _diffModeActive; }

  let _suggestionTotal = 0;
  let _suggestionIndex = 0;

// 覆盖 handleDocSuggestions 以跟踪总数
  const _origHandleDocSuggestions = handleDocSuggestions;
//（total 在 handleDocSuggestions 内设置后由 _showCurrentSuggestion 读取）

/** 应用单个建议编辑而不从队列中移除 */
  function _applySuggestion(sugg) {
    const textarea = document.getElementById('doc-editor-textarea');
    if (textarea && sugg.find && textarea.value.includes(sugg.find)) {
      textarea.value = textarea.value.replace(sugg.find, sugg.replace);
      syncHighlighting();
      saveDocument({ silent: true });
    }
  }

/** 动画过渡到下一个建议 */
  function _animateNext() {
    _saveSuggestionsToStorage();
    const old = document.getElementById('doc-suggestion-active');
    if (old) {
      if (old._cleanup) old._cleanup();
      old.style.transition = 'opacity 0.15s, transform 0.15s';
      old.style.opacity = '0';
      old.style.transform = 'translateY(-10px)';
      setTimeout(() => {
        old.remove();
        _showCurrentSuggestion();
      }, 150);
    } else {
      _showCurrentSuggestion();
    }
  }

  function _esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

/** 接受建议——应用编辑 */
  function acceptSuggestion(id) {
    const sugg = _activeSuggestions.find(s => s.id === id);
    if (!sugg) return;

    const textarea = document.getElementById('doc-editor-textarea');
    if (textarea && sugg.find && textarea.value.includes(sugg.find)) {
      textarea.value = textarea.value.replace(sugg.find, sugg.replace);
      syncHighlighting();
      saveDocument({ silent: true });
    }

// 动画卡片移出
    sugg.cardEl.style.transition = 'opacity 0.2s, transform 0.2s';
    sugg.cardEl.style.opacity = '0';
    sugg.cardEl.style.transform = 'translateX(10px)';
    setTimeout(() => sugg.cardEl.remove(), 200);

    _activeSuggestions = _activeSuggestions.filter(s => s.id !== id);
    _clearSuggestionHighlight();

// 如果为空则移除容器
    if (_activeSuggestions.length === 0) {
      const container = document.getElementById('doc-suggestions-container');
      if (container) container.style.display = 'none';
    }
  }

/** 忽略建议——仅移除卡片 */
  function dismissSuggestion(id) {
    const sugg = _activeSuggestions.find(s => s.id === id);
    if (!sugg) return;

    sugg.cardEl.style.transition = 'opacity 0.15s';
    sugg.cardEl.style.opacity = '0';
    setTimeout(() => sugg.cardEl.remove(), 150);

    _activeSuggestions = _activeSuggestions.filter(s => s.id !== id);
    _clearSuggestionHighlight();

    if (_activeSuggestions.length === 0) {
      const container = document.getElementById('doc-suggestions-container');
      if (container) container.style.display = 'none';
    }
  }

/** 清除所有建议卡片 */
  function clearAllSuggestions() {
    _activeSuggestions = [];
    _suggestionTotal = 0;
    _saveSuggestionsToStorage();
    _clearSuggestionHighlight();
    _clearInlineDiff();
    const old = document.getElementById('doc-suggestion-active');
    if (old) { if (old._cleanup) old._cleanup(); old.remove(); }
    const container = document.getElementById('doc-suggestions-container');
    if (container) { container.innerHTML = ''; container.style.display = 'none'; }
// 恢复行号
    const ta = document.getElementById('doc-editor-textarea');
    if (ta) updateLineNumbers(ta.value);
  }

/** 悬停建议时在编辑器中高亮引用的文本 */
  function _highlightSuggestionText(findText) {
    _clearSuggestionHighlight();
    const textarea = document.getElementById('doc-editor-textarea');
    const wrap = document.getElementById('doc-editor-wrap');
    if (!textarea || !wrap) return;

    const text = textarea.value;
    const idx = text.indexOf(findText);
    if (idx === -1) return;

    const style = getComputedStyle(textarea);
    const paddingTop = parseFloat(style.paddingTop) || 10;
    const paddingLeft = parseFloat(style.paddingLeft) || 48;
    const lineHeight = parseFloat(style.lineHeight) || 20;

    let mirror = document.getElementById('doc-selection-mirror');
    if (!mirror) return;

    const beforeStart = text.substring(0, idx);
    const lastNewline = beforeStart.lastIndexOf('\n');
    const startLineBegin = lastNewline + 1;
    mirror.textContent = text.substring(0, startLineBegin);
    const startTop = mirror.scrollHeight - paddingTop;

    const endIdx = idx + findText.length;
    const afterEnd = text.indexOf('\n', endIdx);
    const endLineEnd = afterEnd === -1 ? text.length : afterEnd;
    mirror.textContent = text.substring(0, endLineEnd);
    const endBottom = mirror.scrollHeight - paddingTop;
    mirror.textContent = '';

    const top = paddingTop + startTop - textarea.scrollTop;
    const height = Math.max(endBottom - startTop, lineHeight);

    const highlight = document.createElement('div');
    highlight.className = 'doc-suggestion-highlight';
    highlight.id = 'doc-suggestion-hover-hl';
    highlight.style.top = top + 'px';
    highlight.style.left = paddingLeft + 'px';
    highlight.style.right = '0';
    highlight.style.height = height + 'px';
    wrap.appendChild(highlight);

// 此处不自动滚动——调用者处理滚动
  }

/** 移除悬停高亮 */
  function _clearSuggestionHighlight() {
    const hl = document.getElementById('doc-suggestion-hover-hl');
    if (hl) hl.remove();
  }

/** 使用浏览器内代码运行器运行文档代码 */
  function runDocument() {
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea || !textarea.value.trim()) return;

    const code = textarea.value;
    const langSelect = document.getElementById('doc-language-select');
    const lang = (langSelect ? langSelect.value : '').toLowerCase();

// 获取或创建编辑器下方的输出面板
    let outputPanel = document.getElementById('doc-run-output');
    if (!outputPanel) {
      outputPanel = document.createElement('div');
      outputPanel.id = 'doc-run-output';
      outputPanel.className = 'doc-run-output';
      const editorWrap = document.getElementById('doc-editor-wrap');
      if (editorWrap) editorWrap.after(outputPanel);
    }
    outputPanel.style.display = 'block';
    outputPanel.innerHTML = '';

    if (_isRenderLang(lang)) {
// HTML / SVG / XML — 在沙箱预览 iframe 中内联渲染。
      outputPanel.style.display = 'none';
      toggleHtmlPreview();
      return;
    }

    if (!codeRunnerModule) {
      outputPanel.innerHTML = '<pre class="doc-run-error">Code runner not loaded</pre>';
      setTimeout(() => { if (outputPanel) outputPanel.style.display = 'none'; }, 5000);
      return;
    }

    if (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh') {
      codeRunnerModule.runServer(code, outputPanel, 'bash');
      return;
    }

    if (lang === 'python' || lang === 'py') {
      codeRunnerModule.runServer(code, outputPanel, 'python');
      return;
    }

    if (lang === 'javascript' || lang === 'js') {
      codeRunnerModule.runJavaScript(code, outputPanel);
      return;
    }

    outputPanel.innerHTML = '<pre class="doc-run-error">Unsupported language. Supported: bash, python, javascript, html</pre>';
    setTimeout(() => { if (outputPanel) outputPanel.style.display = 'none'; }, 5000);
  }

/** 复制文档内容到剪贴板 */
  async function copyDocument() {
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea || !textarea.value) return;
    if (uiModule && uiModule.copyToClipboard) {
      await uiModule.copyToClipboard(textarea.value);
    } else {
      try {
        await navigator.clipboard.writeText(textarea.value);
      } catch (e) { /* ignore */ }
    }
    if (uiModule) uiModule.showToast('Copied to clipboard');
  }

  /* ---- 每个标签上下文菜单 ---- */

  let _docTabMenu = null; // 单例下拉元素

  function _closeDocTabMenu() {
    if (_docTabMenu) { _docTabMenu.style.display = 'none'; }
  }

  function showDocTabMenu(btnEl, docId) {
// 如果已为此文档打开则切换关闭
    if (_docTabMenu && _docTabMenu.style.display === 'block' && _docTabMenu._docId === docId) {
      _closeDocTabMenu();
      return;
    }

// 在任何 DOM 更改之前捕获按钮位置
    const _menuAnchorRect = btnEl.getBoundingClientRect();

// 如果尚未激活则切换到此文档
    if (docId !== activeDocId) switchToDoc(docId);

    const doc = docs.get(docId);
    if (!doc) return;

// 创建一次性单例菜单容器
    if (!_docTabMenu) {
      _docTabMenu = document.createElement('div');
      _docTabMenu.className = 'doc-tab-dropdown';
      _docTabMenu.style.cssText = 'position:fixed;z-index:1000;min-width:0;width:max-content;padding:4px;background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.3);backdrop-filter:blur(12px);font-size:12px;display:none;';
      document.body.appendChild(_docTabMenu);
// 在外部点击时关闭
      document.addEventListener('click', (e) => {
        if (_docTabMenu && !_docTabMenu.contains(e.target) && !e.target.closest('.doc-tab-menu-btn')) {
          _closeDocTabMenu();
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !_docTabMenu || _docTabMenu.style.display !== 'block') return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        _closeDocTabMenu();
      }, true);
    }

    const lang = (doc.language || '').toLowerCase();
    const canRun = _isRenderLang(lang) || ['javascript', 'js', 'python', 'py', 'bash', 'sh', 'shell', 'zsh'].includes(lang);

    let previewIcon = '', previewLabel = '';
    const _mdPreview = document.getElementById('doc-md-preview');
    const _csvPreview = document.getElementById('doc-csv-preview');
    const _htmlPreview = document.getElementById('doc-html-preview');
    const _mdActive = _mdPreview && _mdPreview.style.display !== 'none';
    const _csvActive = _csvPreview && _csvPreview.style.display !== 'none';
    const _htmlActive = _htmlPreview && _htmlPreview.style.display !== 'none';
    if (lang === 'markdown') { previewIcon = 'MD'; previewLabel = _mdActive ? 'Edit' : 'Preview'; }
    else if (lang === 'csv') { previewIcon = '⊞'; previewLabel = _csvActive ? 'Edit' : 'Table View'; }
    else if (_isRenderLang(lang)) { previewIcon = '▶'; previewLabel = _htmlActive ? 'Edit' : 'Run / Preview'; }

    const _di = (svg) => `<span class="dropdown-icon">${svg}</span>`;
    const _saveIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
    const _copyIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const _runIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    const _previewIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    const _deleteIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

    let items = '';
    items += `<div class="dropdown-item-compact doc-tab-action" data-action="save">${_di(_saveIco)}<span>Save</span></div>`;
    items += `<div class="dropdown-item-compact doc-tab-action" data-action="copy">${_di(_copyIco)}<span>Copy</span></div>`;
    if (canRun) {
      items += `<div class="dropdown-item-compact doc-tab-action" data-action="run">${_di(_runIco)}<span>Run</span></div>`;
    }
    if (previewLabel) {
      items += `<div class="dropdown-item-compact doc-tab-action" data-action="preview"><span class="dropdown-icon">${previewIcon}</span><span>${previewLabel}</span></div>`;
    }
    const _downloadIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    items += `<div class="dropdown-item-compact doc-tab-action" data-action="download">${_di(_downloadIco)}<span>Download</span></div>`;
// "发送签名回复"——仅当此文档从 email 附件打开时
    if (doc.sourceEmailUid && doc.sourceEmailFolder) {
      const _sendBackIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
      items += `<div class="dropdown-item-compact doc-tab-action" data-action="signed-reply">${_di(_sendBackIco)}<span>Send signed reply</span></div>`;
    }
    const _closeIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    items += `<div class="dropdown-item-compact doc-tab-action" data-action="close">${_di(_closeIco)}<span>Close</span></div>`;
    items += `<div class="dropdown-divider"></div>`;
    items += `<div class="dropdown-item-compact doc-tab-action doc-tab-action-delete" data-action="delete">${_di(_deleteIco)}<span>Delete</span></div>`;

    _docTabMenu.innerHTML = items;
    _docTabMenu.style.display = 'block';
    _docTabMenu._docId = docId;

// 定位：锚定到标签栏底部，水平对齐到按钮
    const rect = _menuAnchorRect;
    const tabBar = document.getElementById('doc-tab-bar');
    const barBottom = tabBar ? tabBar.getBoundingClientRect().bottom : rect.bottom;
    _docTabMenu.style.position = 'fixed';
    _docTabMenu.style.zIndex = '1000';
    _docTabMenu.style.left = rect.left + 'px';
    _docTabMenu.style.top = (barBottom + 2) + 'px';

// 限制到视口边缘
    requestAnimationFrame(() => {
      const menuRect = _docTabMenu.getBoundingClientRect();
      if (menuRect.right > window.innerWidth - 8) {
        _docTabMenu.style.left = (window.innerWidth - menuRect.width - 8) + 'px';
      }
      if (menuRect.left < 8) {
        _docTabMenu.style.left = '8px';
      }
      if (menuRect.bottom > window.innerHeight - 8) {
        _docTabMenu.style.top = (barBottom - menuRect.height - 4) + 'px';
      }
    });

// 绑定操作点击
    _docTabMenu.querySelectorAll('.doc-tab-action').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.dataset.action;
        _closeDocTabMenu();
        switch (action) {
          case 'save': saveDocument(); break;
          case 'copy': copyDocument(); break;
          case 'run': runDocument(); break;
          case 'preview':
            if (lang === 'markdown') toggleMarkdownPreview();
            else if (lang === 'csv') toggleCsvPreview();
            else if (_isRenderLang(lang)) toggleHtmlPreview();
            break;
          case 'download': {
            const btn = document.getElementById('doc-fontsize-btn') || document.getElementById('doc-language-select');
            showExportMenu(null, btn?.getBoundingClientRect());
            break;
          }
          case 'signed-reply': _sendSignedReply(docId); break;
          case 'close': closeTab(docId); break;
          case 'delete': deleteActiveDocument(); break;
        }
      });
    });
  }

  /**
* "发送签名回复"——展平当前 PDF（表单字段 + 签名
* 印章 + 自由注释），放入编写上传目录，
* 然后：
*   1. 将附件添加到同一源线程的现有打开 email 草稿
*      （使多个签名文档累积到一个回复中），或
*   2. 创建新的 email 语言草稿文档，预填充收件人/
*      主题/In-Reply-To/References 和第一个附件。
* 将文档面板切换到该草稿，以便用户审核 + 发送。
   */
  async function _sendSignedReply(docId) {
    const doc = docs.get(docId);
    if (!doc || !doc.sourceEmailUid) return;
    if (uiModule) uiModule.showToast('Preparing signed reply…');
    let result;
    try {
      const res = await fetch(`${API_BASE}/api/document/${encodeURIComponent(docId)}/prepare-signed-reply`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      result = await res.json().catch(() => ({}));
      if (!res.ok || !result.ok) {
        const msg = (result && result.error) || `HTTP ${res.status}`;
        if (uiModule) uiModule.showError(`Couldn't prepare signed reply: ${msg}`);
        return;
      }
    } catch (e) {
      console.error('prepare-signed-reply failed:', e);
      if (uiModule) uiModule.showError("Couldn't prepare signed reply");
      return;
    }

    const att = result.attachment;
    const reply = result.reply || {};
    const mid = reply.source_message_id || doc.sourceEmailMessageId || '';

// 1) 已有为此源线程打开的草稿标签页？追加。
    for (const [, d] of docs) {
      if (d.language === 'email' && d._draftForMessageId === mid && mid) {
        d._composeAtts = (d._composeAtts || []).concat([att]);
        await loadDocument(d.id);
        _renderComposeAttachments();
        if (uiModule) uiModule.showToast(`Added "${att.filename}" to the reply draft`);
        return;
      }
    }

// 2) 否则创建新的 email 草稿。
    const headerLines = [
      `To: ${reply.to || ''}`,
      `Subject: ${reply.subject || ''}`,
      reply.in_reply_to ? `In-Reply-To: ${reply.in_reply_to}` : null,
      reply.references ? `References: ${reply.references}` : null,
      reply.source_uid ? `X-Source-UID: ${reply.source_uid}` : null,
      reply.source_folder ? `X-Source-Folder: ${reply.source_folder}` : null,
    ].filter(Boolean);
    const content = headerLines.join('\n') + '\n---\n\nHi' + (reply.to_name ? ' ' + reply.to_name.split(/\s+/)[0] : '') + ',\n\nPlease find the signed copy attached.\n\nBest,\n';

    let draftId = null;
    try {
// 如果可用则使用源 PDF 的会话；否则回退到当前。
      let sessionId = doc.sessionId
        || _lastSessionId
        || (sessionModule && sessionModule.getCurrentSessionId());
      if (!sessionId) {
        try { sessionId = await _autoCreateSession(); } catch (_) {}
      }
      const cRes = await fetch(`${API_BASE}/api/document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          session_id: sessionId,
          title: reply.subject || 'Signed reply',
          language: 'email',
          content,
        }),
      });
      const created = await cRes.json();
      draftId = created && (created.id || created.doc_id);
      if (!draftId) throw new Error('No draft id returned');
    } catch (e) {
      console.error('Failed to create draft doc:', e);
      if (uiModule) uiModule.showError("Couldn't create reply draft");
      return;
    }

// 用线程消息 ID 标记草稿（仅内存），使来自同一 email 的
// 未来签名 PDF 被追加到此相同草稿。
    addDocToTabs({
      id: draftId,
      title: reply.subject || 'Signed reply',
      language: 'email',
      current_content: content,
      version_count: 1,
    }, doc.sessionId);
    const draft = docs.get(draftId);
    if (draft) {
      draft._composeAtts = [att];
      draft._draftForMessageId = mid;
      if (reply.account_id) draft._draftAccountId = reply.account_id;
    }

    await loadDocument(draftId);
    _renderComposeAttachments();
    if (uiModule) uiModule.showToast(`Reply draft ready — "${att.filename}" attached`);
  }

/** 保存手动编辑 */
  export async function saveDocument({ silent = false } = {}) {
    if (!activeDocId) return;
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea) return;

    try {
      const res = await fetch(`${API_BASE}/api/document/${activeDocId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: textarea.value }),
      });
      const doc = await res.json();
      const badge = document.getElementById('doc-version-badge');
      if (badge) { const _v = doc.version_count || 1; badge.textContent = `v${_v}`; badge.style.display = _v > 1 ? '' : 'none'; }
// 更新 map
      if (docs.has(activeDocId)) {
        docs.get(activeDocId).version = doc.version_count || 1;
        docs.get(activeDocId).content = textarea.value;
      }
      _syncDocIndicator();
      if (!silent && uiModule) uiModule.showToast('Document saved');
    } catch (e) {
      console.error('Failed to save document:', e);
      if (!silent && uiModule) uiModule.showError('Failed to save document');
    }
  }

/** 导出/下载活动文档 */
  let _docxReady = null;
  function ensureDocx() {
    if (_docxReady) return _docxReady;
    if (window.docx) return (_docxReady = Promise.resolve());
    _docxReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/static/lib/docx.umd.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load DOCX library'));
      document.head.appendChild(s);
    });
    return _docxReady;
  }

  let _html2pdfReady = null;
  function ensureHtml2Pdf() {
    if (_html2pdfReady) return _html2pdfReady;
    if (window.html2pdf) return (_html2pdfReady = Promise.resolve());
    _html2pdfReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/static/lib/html2pdf.bundle.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load PDF library'));
      document.head.appendChild(s);
    });
    return _html2pdfReady;
  }

  function _getExportBaseName() {
    const doc = docs.get(activeDocId);
    const title = (doc && doc.title) || 'document';
    const safeName = title.replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || 'document';
    const ver = doc && doc.version ? `_v${doc.version}` : '';
    return safeName + ver;
  }

  function exportDocument() {
    if (!activeDocId) return;
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea) return;
    const doc = docs.get(activeDocId);
    const title = (doc && doc.title) || 'document';
    const lang = document.getElementById('doc-language-select')?.value || '';
    const extMap = {
      javascript: '.js', python: '.py', html: '.html', css: '.css',
      markdown: '.md', json: '.json', yaml: '.yml', bash: '.sh',
      sql: '.sql', rust: '.rs', go: '.go', java: '.java', c: '.c', cpp: '.cpp', csharp: '.cs',
      typescript: '.ts', ruby: '.rb', php: '.php', text: '.txt',
      xml: '.xml', toml: '.toml', ini: '.ini', csv: '.csv',
    };
    const ext = extMap[lang] || '.txt';
    const safeName = title.replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || 'document';
    const ver = doc && doc.version ? `_v${doc.version}` : '';
    const mime = lang === 'csv' ? 'text/csv' : lang === 'json' ? 'application/json' : 'text/plain';
    const blob = new Blob([textarea.value], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safeName + ver + ext;
    a.click();
    URL.revokeObjectURL(a.href);
  }

// "从设备导入"——打开文件选择器，上传，立即在此面板中打开
// 结果文档（而不是倒入资源库让用户再点击）。
// 对文本/代码镜像资源库扩展逻辑；
// 通过处理 AcroForm 字段的专用 import-pdf 端点路由 PDF。
// 电子表格回退到已知如何分割工作表的资源库流程。
// 流程，它已经知道如何分割工作表。
  function _importFromDevice() {
    const EXT_TO_LANG = {
      '.py':'python','.js':'javascript','.ts':'typescript','.html':'html','.htm':'html',
      '.css':'css','.md':'markdown','.json':'json','.yml':'yaml','.yaml':'yaml',
      '.sh':'bash','.bash':'bash','.sql':'sql','.rs':'rust','.go':'go',
      '.java':'java','.c':'c','.cpp':'cpp','.h':'c','.hpp':'cpp',
      '.rb':'ruby','.php':'php','.xml':'xml','.toml':'toml','.ini':'ini',
      '.txt':'','.log':'','.csv':'csv','.tsv':'csv','.jsx':'javascript','.tsx':'typescript',
    };
    const fi = document.createElement('input');
    fi.type = 'file';
    fi.style.display = 'none';
    fi.addEventListener('change', async () => {
      const file = fi.files?.[0];
      if (!file) return;
      const name = file.name;
      const dotIdx = name.lastIndexOf('.');
      const ext = dotIdx >= 0 ? name.slice(dotIdx).toLowerCase() : '';
      const baseTitle = dotIdx > 0 ? name.slice(0, dotIdx) : name;
      const isSpreadsheet = ['.xlsx','.xls','.ods'].includes(ext);
      const isPdf = ext === '.pdf';
// 电子表格需要资源库的每表分割——委托给它。
      if (isSpreadsheet) {
        openLibrary();
        requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('doclib-import-file-btn')?.click()));
        return;
      }
      try {
        let docId = null;
        if (isPdf) {
          const fd = new FormData();
          fd.append('file', file);
          const sid = (sessionModule && sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId()) || _lastSessionId || '';
          if (sid) fd.append('session_id', sid);
          const r = await fetch(`${API_BASE}/api/documents/import-pdf`, { method: 'POST', body: fd, credentials: 'same-origin' });
          if (!r.ok) throw new Error('PDF import failed');
          const j = await r.json();
          docId = j.doc_id || j.id;
        } else {
          const content = await new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onload = () => res(reader.result || '');
            reader.onerror = () => rej(reader.error);
            reader.readAsText(file);
          });
          const lang = EXT_TO_LANG[ext] !== undefined ? EXT_TO_LANG[ext] : null;
          const sid = (sessionModule && sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId()) || _lastSessionId || '';
          const body = { title: baseTitle, language: lang, content };
          if (sid) body.session_id = sid;
          const r = await fetch(`${API_BASE}/api/document`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
          });
          if (!r.ok) throw new Error('Import failed');
          const j = await r.json();
          docId = j.id || j.doc_id;
        }
        if (docId) {
// 获取完整文档，使 addDocToTabs 具有正确的内容 +
// 语言字段（下游 switchToDoc 使用）。
          try {
            const dr = await fetch(`${API_BASE}/api/document/${docId}`, { credentials: 'same-origin' });
            const full = dr.ok ? await dr.json() : { id: docId, title: baseTitle };
            const sid = (sessionModule && sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId()) || _lastSessionId || '';
            addDocToTabs(full, full.session_id || sid);
            switchToDoc(full.id || docId);
          } catch (_) {
// 回退——至少尝试切换（可能静默失败如果未加载）。
            addDocToTabs({ id: docId, title: baseTitle }, _lastSessionId || '');
            switchToDoc(docId);
          }
        }
      } catch (err) {
        if (uiModule && uiModule.showError) uiModule.showError('Import failed: ' + (err.message || err));
      } finally {
        fi.value = '';
        fi.remove();
      }
    });
    document.body.appendChild(fi);
    fi.click();
  }

  function showExportMenu(e, anchorRect) {
    if (e) e.stopPropagation();
// 如果存在则移除已有菜单
    const existing = document.getElementById('doc-export-menu');
    if (existing) { existing.remove(); return; }

// 从提供的 rect、点击的元素或回退到语言选择定位
    const rect = anchorRect
      || (e && e.target && e.target.closest('button')?.getBoundingClientRect())
      || document.getElementById('doc-language-select')?.getBoundingClientRect();
    if (!rect) return;

    const lang = document.getElementById('doc-language-select')?.value || '';
    const extMap = {
      javascript: '.js', python: '.py', html: '.html', css: '.css',
      markdown: '.md', json: '.json', yaml: '.yml', bash: '.sh',
      sql: '.sql', rust: '.rs', go: '.go', java: '.java', c: '.c', cpp: '.cpp', csharp: '.cs',
      typescript: '.ts', ruby: '.rb', php: '.php', text: '.txt',
      xml: '.xml', toml: '.toml', ini: '.ini', csv: '.csv',
    };
    const ext = extMap[lang] || '.txt';

    const menu = document.createElement('div');
    menu.id = 'doc-export-menu';
    menu.className = 'doc-overflow-menu open';
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 2) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    menu.style.left = 'auto';
    menu.style.zIndex = '9999';

    const langLabel = lang ? lang.toUpperCase() : 'TXT';
// 表单支持的 markdown 文档 → 主导出是填充的 PDF，不是
// markdown 源代码。将其提升到菜单顶部。
    const liveContent = document.getElementById('doc-editor-textarea')?.value
      || docs.get(activeDocId)?.content || '';
    const isForm = _isFormBackedDoc(liveContent);
    const options = [];
// 导入位于同一下拉菜单顶部——它是兄弟操作
//（"引入" vs "输出"），页脚
// 已经太拥挤无法容纳专用图标。
    options.push({ label: 'Import from library', fn: () => openLibrary() });
    options.push({ label: 'Import from device', fn: () => _importFromDevice(), _divider: true });
    if (isForm) options.push({ label: 'Filled PDF (.pdf)', fn: _downloadFilledPdf });
    options.push(
      { label: 'Export Markdown', fn: exportDocument },
      { label: 'Print as PDF', fn: exportAsPdf },
      { label: 'Export as Word', fn: exportAsDocx },
    );

    options.forEach(opt => {
      const item = document.createElement('button');
      item.className = 'doc-overflow-item';
      item.textContent = opt.label;
      item.addEventListener('click', (ev) => { ev.stopPropagation(); menu.remove(); opt.fn(); });
      menu.appendChild(item);
      if (opt._divider) {
        const sep = document.createElement('div');
        sep.className = 'doc-overflow-divider';
        sep.style.cssText = 'height:1px;margin:3px 6px;background:color-mix(in srgb,var(--border) 60%,transparent);';
        menu.appendChild(sep);
      }
    });

    document.body.appendChild(menu);
// 当下方没有空间时翻转到锚点上方——导出按钮现在
// 位于底部页脚，因此菜单否则会掉到屏幕下方。
    const mh = menu.offsetHeight;
    if (rect.bottom + mh > window.innerHeight - 8) {
      menu.style.top = 'auto';
      menu.style.bottom = (window.innerHeight - rect.top + 2) + 'px';
    }
    const close = (ev) => {
      if (ev && ev.type === 'keydown') {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation?.();
      } else if (ev && menu.contains(ev.target)) {
        return;
      }
      menu.remove();
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close, true);
    };
    setTimeout(() => document.addEventListener('click', close), 100);
    document.addEventListener('keydown', close, true);
  }

  function exportAsHtml() {
    if (!activeDocId) return;
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea) return;
    const lang = document.getElementById('doc-language-select')?.value || '';
    const text = textarea.value || '';
    let body;
    if (lang === 'markdown' && markdownModule?.mdToHtml) {
      body = markdownModule.mdToHtml(text, { shortcodes: false }); // export: keep :shortcodes: literal
    } else {
      body = '<pre style="white-space:pre-wrap;font-size:12px;font-family:monospace;">' +
        text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
    }
    const title = docs.get(activeDocId)?.title || 'document';
    const html = `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${title.replace(/</g,'&lt;')}</title></head><body style="max-width:800px;margin:40px auto;font-family:sans-serif;line-height:1.6;padding:0 20px;">\n${body}\n</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = _getExportBaseName() + '.html';
    a.click();
    URL.revokeObjectURL(a.href);
    if (uiModule) uiModule.showToast('Exported as HTML');
  }

  async function exportAsPdf() {
    if (!activeDocId) return;
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea) return;
    try {
      await ensureHtml2Pdf();
    } catch (e) {
      if (uiModule) uiModule.showError('Failed to load PDF library');
      return;
    }
    const lang = document.getElementById('doc-language-select')?.value || '';
    const text = textarea.value || '';
// 将内容渲染为 HTML 用于 PDF
    let html;
    if (lang === 'markdown' && markdownModule?.mdToHtml) {
      html = markdownModule.mdToHtml(text, { shortcodes: false }); // export: keep :shortcodes: literal
    } else {
      html = '<pre style="white-space:pre-wrap;font-size:11px;font-family:monospace;color:#000;background:#fff;">' +
        text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
    }
    const container = document.createElement('div');
    container.style.cssText = 'padding:20px;font-family:sans-serif;font-size:12px;color:#000;background:#fff;line-height:1.6;';
    container.innerHTML = html;
    const baseName = _getExportBaseName();
    window.html2pdf().set({
      margin: 10,
      filename: baseName + '.pdf',
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    }).from(container).save();
    if (uiModule) uiModule.showToast('Exporting PDF...');
  }

  async function exportAsDocx() {
    if (!activeDocId) return;
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea) return;
    try {
      await ensureDocx();
    } catch (e) {
      if (uiModule) uiModule.showError('Failed to load DOCX library');
      return;
    }
    const text = textarea.value || '';
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = window.docx;
// 将文本解析为段落，处理 markdown 标题
    const paragraphs = text.split('\n').map(line => {
      const h1 = line.match(/^# (.+)/);
      const h2 = line.match(/^## (.+)/);
      const h3 = line.match(/^### (.+)/);
      if (h1) return new Paragraph({ text: h1[1], heading: HeadingLevel.HEADING_1 });
      if (h2) return new Paragraph({ text: h2[1], heading: HeadingLevel.HEADING_2 });
      if (h3) return new Paragraph({ text: h3[1], heading: HeadingLevel.HEADING_3 });
// 处理粗体/斜体
      const runs = [];
      const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/);
      for (const part of parts) {
        if (part.startsWith('**') && part.endsWith('**')) {
          runs.push(new TextRun({ text: part.slice(2, -2), bold: true }));
        } else if (part.startsWith('*') && part.endsWith('*')) {
          runs.push(new TextRun({ text: part.slice(1, -1), italics: true }));
        } else {
          runs.push(new TextRun(part));
        }
      }
      return new Paragraph({ children: runs });
    });

    const doc = new Document({
      sections: [{ children: paragraphs }],
    });
    const blob = await Packer.toBlob(doc);
    const baseName = _getExportBaseName();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = baseName + '.docx';
    a.click();
    URL.revokeObjectURL(a.href);
    if (uiModule) uiModule.showToast('Exported as DOCX');
  }

/** 删除活动文档 */
  async function deleteActiveDocument() {
    if (!activeDocId) return;
    const doc = docs.get(activeDocId);
    const name = doc ? doc.title : 'this document';
    const ok = uiModule && uiModule.styledConfirm
      ? await uiModule.styledConfirm(`Delete "${name}"?`, { confirmText: 'Delete', danger: true })
      : confirm(`Delete "${name}"?`);
    if (!ok) return;
    try {
      const res = await fetch(`${API_BASE}/api/document/${activeDocId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
// 移除标签页
      const tab = document.querySelector(`.doc-tab[data-doc-id="${activeDocId}"]`);
      if (tab) tab.remove();
      docs.delete(activeDocId);
// 切换到另一个文档或关闭面板
      const remaining = Array.from(docs.keys());
      if (remaining.length > 0) {
        switchToDoc(remaining[0]);
      } else {
        activeDocId = null;
        closePanel();
      }
      if (uiModule) uiModule.showToast('Document deleted');
    } catch (e) {
      console.error('Failed to delete document:', e);
      if (uiModule) uiModule.showError('Failed to delete document');
    }
  }

/** 在文档编辑器面板上切换全屏 */
  function toggleFullscreen() {
    const pane = document.getElementById('doc-editor-pane');
    const container = document.getElementById('chat-container');
    if (!pane) return;
// 注意：分隔条在全屏期间保留在 DOM 中，使其箭头可以
// 作为退出全屏的功能（CSS 规则
// `body:has(.doc-editor-pane.doc-fullscreen) .doc-divider-collapse` 将其
// 滑动到强制内部位置）。此处隐藏分隔条会同时隐藏
// 其箭头。
    if (pane.classList.contains('doc-fullscreen')) {
      pane.classList.remove('doc-fullscreen');
      if (container) container.style.display = '';
    } else {
      pane.classList.add('doc-fullscreen');
      if (container) container.style.display = 'none';
    }
// 布局更改后重新检查 markdown 工具栏溢出
    const mdToolbar = document.getElementById('doc-md-toolbar');
    if (mdToolbar?._syncOverflow) requestAnimationFrame(mdToolbar._syncOverflow);
  }

/** 切换 markdown 预览 */
  function _setMarkdownPreviewActive(active, { remember = true } = {}) {
    const preview = document.getElementById('doc-md-preview');
    const wrap = document.getElementById('doc-editor-wrap');
    const textarea = document.getElementById('doc-editor-textarea');
    if (!preview || !wrap || !textarea) return;

    if (active) {
      const md = textarea.value || '';
      if (markdownModule && markdownModule.mdToHtml) {
        preview.innerHTML = markdownModule.mdToHtml(md, { shortcodes: false }); // doc preview: keep :shortcodes: literal
      } else {
        preview.innerHTML = md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g, '<br>');
      }
      if (window.hljs) {
        preview.querySelectorAll('pre code').forEach(b => window.hljs.highlightElement(b));
      }
      if (markdownModule && markdownModule.renderMermaid) {
        markdownModule.renderMermaid(preview);
      }
      preview.style.display = '';
      wrap.style.display = 'none';
    } else {
      preview.style.display = 'none';
      preview.innerHTML = '';
      const isEmailDoc = docs.get(activeDocId)?.language === 'email';
      const richEmailBody = document.getElementById('doc-email-richbody');
      if (!(isEmailDoc && richEmailBody && richEmailBody.style.display !== 'none')) {
        wrap.style.display = '';
      }
    }
    if (remember && activeDocId && docs.has(activeDocId)) {
      docs.get(activeDocId)._markdownPreviewActive = !!active;
    }
    _syncHeaderActions();
  }

  function toggleMarkdownPreview() {
    const preview = document.getElementById('doc-md-preview');
    _setMarkdownPreviewActive(!(preview && preview.style.display !== 'none'));
  }

/** 将 CSV 文本解析为二维数组（处理带引号字段） */
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { field += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
          if (ch === '\r') i++;
          row.push(field); field = '';
          if (row.some(c => c.trim())) rows.push(row);
          row = [];
        } else { field += ch; }
      }
    }
    row.push(field);
    if (row.some(c => c.trim())) rows.push(row);
    return rows;
  }

/** 转义 CSV 字段（如果包含逗号、引号或换行则加引号） */
  function csvEscapeField(val) {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  }

/** 从实时表格 DOM 重建 CSV 文本 */
  function syncTableToTextarea(preview, textarea) {
    const table = preview.querySelector('.csv-table');
    if (!table) return;
    const lines = [];
// 表头
    const ths = table.querySelectorAll('thead th');
    if (ths.length) lines.push([...ths].map(th => csvEscapeField(th.textContent)).join(','));
// 正文
    table.querySelectorAll('tbody tr').forEach(tr => {
      const cells = [...tr.querySelectorAll('td')].map(td => csvEscapeField(td.textContent));
      lines.push(cells.join(','));
    });
    textarea.value = lines.join('\n') + '\n';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

/** 切换 CSV 表格预览 */
  function toggleCsvPreview() {
    const preview = document.getElementById('doc-csv-preview');
    const wrap = document.getElementById('doc-editor-wrap');
    const textarea = document.getElementById('doc-editor-textarea');
    if (!preview || !wrap || !textarea) return;

    if (preview.style.display === 'none') {
      const rows = parseCSV(textarea.value || '');
      if (rows.length === 0) {
// 将"无数据"消息重路由到共享的 run-output 块，使
// 每个文档类型在同一位置显示错误/空状态
//（而不是在表格视图内印章）。
        let outputPanel = document.getElementById('doc-run-output');
        if (!outputPanel) {
          outputPanel = document.createElement('div');
          outputPanel.id = 'doc-run-output';
          outputPanel.className = 'doc-run-output';
          const editorWrap = document.getElementById('doc-editor-wrap');
          if (editorWrap) editorWrap.after(outputPanel);
        }
        outputPanel.style.display = 'block';
        outputPanel.innerHTML = '<pre class="doc-run-error">No data — CSV is empty or unparseable.</pre>';
        return;
      } else {
        const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const colCount = Math.max(...rows.map(r => r.length));
        let html = '<div class="csv-table-wrap"><table class="csv-table"><thead><tr>';
        for (let j = 0; j < colCount; j++) {
          html += `<th contenteditable="true">${esc(rows[0][j] || '')}</th>`;
        }
        html += '</tr></thead><tbody>';
        for (let i = 1; i < rows.length; i++) {
          html += '<tr>';
          for (let j = 0; j < colCount; j++) {
            html += `<td contenteditable="true">${esc(rows[i][j] || '')}</td>`;
          }
          html += '</tr>';
        }
        html += '</tbody></table>';
        html += '</div>';
        preview.innerHTML = html;

// 将编辑同步回 textarea
        const table = preview.querySelector('.csv-table');
        if (table) {
          table.addEventListener('input', () => syncTableToTextarea(preview, textarea));
// 防止 Enter 在单元格内创建 <br>
          table.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
// 移动到下一行，相同列
              const cell = e.target.closest('td,th');
              if (!cell) return;
              const colIdx = [...cell.parentElement.children].indexOf(cell);
              const nextRow = cell.parentElement.nextElementSibling;
              if (nextRow && nextRow.children[colIdx]) {
                nextRow.children[colIdx].focus();
              }
            } else if (e.key === 'Tab') {
              e.preventDefault();
              const cell = e.target.closest('td,th');
              if (!cell) return;
              const next = e.shiftKey ? cell.previousElementSibling : cell.nextElementSibling;
              if (next) next.focus();
            }
          });
        }

// 添加行按钮
        const addBtn = preview.querySelector('.csv-add-row-btn');
        if (addBtn && table) {
          addBtn.addEventListener('click', () => {
            const tbody = table.querySelector('tbody');
            const tr = document.createElement('tr');
            for (let j = 0; j < colCount; j++) {
              const td = document.createElement('td');
              td.contentEditable = 'true';
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
            tr.children[0].focus();
            syncTableToTextarea(preview, textarea);
          });
        }
      }
      preview.style.display = '';
      wrap.style.display = 'none';
    } else {
      preview.style.display = 'none';
      wrap.style.display = '';
    }
// 更新分段代码/运行切换的活动类，使图标
// 高亮匹配新状态——否则打开自动显示表格视图的 CSV
// 会将编辑（代码）侧错误地标记为活动，
// 用户必须翻转切换才能重新同步。
    _syncHeaderActions();
  }

/** 切换内联 HTML 预览（iframe） */
  function toggleHtmlPreview() {
    const iframe = document.getElementById('doc-html-preview');
    const wrap = document.getElementById('doc-editor-wrap');
    const textarea = document.getElementById('doc-editor-textarea');
    if (!iframe || !wrap || !textarea) return;

    if (!_htmlPreviewActive) {
// 显示预览——如果活动则隐藏 markdown 预览
      const mdPreview = document.getElementById('doc-md-preview');
      if (mdPreview) mdPreview.style.display = 'none';
      const code = textarea.value || '';
      iframe.srcdoc = code;
      iframe.style.display = '';
      wrap.style.display = 'none';
      _htmlPreviewActive = true;
      renderTabs();
    } else {
      exitHtmlPreview();
    }
  }

/** 退出 HTML 预览回到代码视图 */
  function exitHtmlPreview() {
    const iframe = document.getElementById('doc-html-preview');
    const wrap = document.getElementById('doc-editor-wrap');
    if (!_htmlPreviewActive) return;
    _htmlPreviewActive = false;
    if (iframe) { iframe.style.display = 'none'; iframe.srcdoc = ''; }
    if (wrap) wrap.style.display = '';
    renderTabs();
  }

// ---- 流式动画引擎 ----

  /**
* 简单差异：查找两个字符串之间的第一个和最后一个不同位置。
* 返回 { prefixLen, oldMid, newMid }，其中：
*   oldText = prefix + oldMid + suffix
*   newText = prefix + newMid + suffix
   */
  function simpleDiff(oldText, newText) {
    let i = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (i < minLen && oldText[i] === newText[i]) i++;
    const prefixLen = i;

    let oj = oldText.length;
    let nj = newText.length;
    while (oj > prefixLen && nj > prefixLen && oldText[oj - 1] === newText[nj - 1]) {
      oj--; nj--;
    }

    return {
      prefixLen,
      oldMid: oldText.slice(prefixLen, oj),
      newMid: newText.slice(prefixLen, nj),
    };
  }

  /**
* 在编辑器 textarea 中动画从 oldText 过渡到 newText。
* 首先逐字符删除旧的不同部分，然后输入新部分。
   */
  /**
* 计算两个文本之间的行级差异。
* 返回数组 { type: 'same'|'del'|'add', text: string }
   */
  function lineDiff(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

// 简单基于 LCS 的差异（Myers 风格，但 O(n*m) 为清晰起见）
    const m = oldLines.length, n = newLines.length;
// 对于非常大的差异，跳过详细差异
    if (m * n > 500000) return null;

    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (oldLines[i] === newLines[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    const result = [];
    let i = 0, j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && oldLines[i] === newLines[j]) {
        result.push({ type: 'same', text: oldLines[i] });
        i++; j++;
      } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
        result.push({ type: 'add', text: newLines[j] });
        j++;
      } else {
        result.push({ type: 'del', text: oldLines[i] });
        i++;
      }
    }
    return result;
  }

  async function animateDocChange(oldText, newText) {
    if (_animationCancel) _animationCancel();

    const textarea = document.getElementById('doc-editor-textarea');
    const wrap = document.getElementById('doc-editor-wrap');
    if (!textarea) return false;
    if (oldText === newText) return true;

    const diff = lineDiff(oldText, newText);
    if (!diff) return false; // too large for diff

// 统计更改
    const delCount = diff.filter(d => d.type === 'del').length;
    const addCount = diff.filter(d => d.type === 'add').length;
    if (delCount + addCount === 0) return true;

    _animationInProgress = true;
    let cancelled = false;
    _animationCancel = () => { cancelled = true; };

    textarea.readOnly = true;
    if (wrap) wrap.classList.add('animating');

    try {
// 构建差异覆盖层 HTML
      const overlay = document.createElement('div');
      overlay.className = 'doc-diff-overlay';

// 统计栏
      const stats = document.createElement('div');
      stats.className = 'doc-diff-stats';
      stats.innerHTML = `<span class="diff-stat-del">\u2212${delCount}</span> <span class="diff-stat-add">+${addCount}</span>`;
      overlay.appendChild(stats);

      const content = document.createElement('div');
      content.className = 'doc-diff-content';

// 渲染差异行——显示更改周围的上下文
      let inContext = false;
      let skipped = 0;
      diff.forEach((line, idx) => {
        if (line.type === 'same') {
// 显示更改周围 2 行上下文
          const nearChange = diff.slice(Math.max(0, idx - 2), idx + 3).some(d => d.type !== 'same');
          if (nearChange) {
            if (skipped > 0) {
              const sep = document.createElement('div');
              sep.className = 'doc-diff-sep';
              sep.textContent = `\u22EF ${skipped} unchanged`;
              content.appendChild(sep);
              skipped = 0;
            }
            const row = document.createElement('div');
            row.className = 'doc-diff-line same';
            row.textContent = line.text || '\u00A0';
            content.appendChild(row);
          } else {
            skipped++;
          }
        } else {
          if (skipped > 0) {
            const sep = document.createElement('div');
            sep.className = 'doc-diff-sep';
            sep.textContent = `\u22EF ${skipped} unchanged`;
            content.appendChild(sep);
            skipped = 0;
          }
          const row = document.createElement('div');
          row.className = 'doc-diff-line ' + line.type;
          row.textContent = (line.type === 'del' ? '\u2212 ' : '+ ') + (line.text || '\u00A0');
          content.appendChild(row);
        }
      });

      overlay.appendChild(content);

// 在 textarea 上方插入覆盖层
      const editorArea = textarea.parentElement;
      if (editorArea) editorArea.appendChild(overlay);

// 显示差异片刻，然后淡入最终内容
      overlay.offsetHeight; // force reflow
      overlay.classList.add('visible');

      const DIFF_DISPLAY_MS = 2500;
      await new Promise(r => setTimeout(r, cancelled ? 0 : DIFF_DISPLAY_MS));

      if (!cancelled) {
        overlay.classList.remove('visible');
        overlay.classList.add('fading');
        textarea.value = newText;
        syncHighlighting();
        await new Promise(r => setTimeout(r, 400));
      }

      overlay.remove();

      if (!cancelled) {
        textarea.value = newText;
        syncHighlighting();
      }

      return !cancelled;
    } finally {
      textarea.readOnly = false;
      _animationInProgress = false;
      _animationCancel = null;
      if (wrap) wrap.classList.remove('animating');
    }
  }

// --- 流式助手：打开面板并在 AI 生成时提供内容 ---
  let _streamDocId = null;

/** 为流式文档同步 markdown 工具栏 + 头部操作，使
*  编辑/预览切换和格式工具出现而无需手动刷新。 */
  function _syncStreamDocChrome(doc) {
    if (!doc) return;
    const lang = (doc.language || 'markdown').toLowerCase();
    const isMd = lang === 'markdown';
    const isPdf = _isFormBackedDoc(doc.content || '');
// 为有任何自己视图切换的文档类型显示工具栏
//（markdown 编辑↔预览，或代码↔运行用于可渲染代码类型）。
// `data-mode` 属性允许 CSS 在代码模式文档中隐藏 markdown 专用按钮
//（粗体、斜体、标题等）。
    const renderable = ['svg', 'html', 'css', 'csv', 'python', 'javascript', 'typescript',
                        'json', 'xml', 'bash', 'sh', 'yaml', 'toml', 'sql'];
    const isCodeRenderable = renderable.includes(lang);
    const mt = document.getElementById('doc-md-toolbar');
    if (mt) {
      const showToolbar = isMd || isPdf || isCodeRenderable;
      mt.style.display = showToolbar ? '' : 'none';
      mt.dataset.mode = isMd ? 'md' : (isPdf ? 'pdf' : (isCodeRenderable ? 'code' : ''));
      if (showToolbar && mt._syncOverflow) requestAnimationFrame(mt._syncOverflow);
    }
    _syncHeaderActions();
  }

/** 立即为正在流式传入的文档打开文档面板 */
  export function streamDocOpen(title, language) {
// 在此流更改活动文档之前丢弃任何待处理的 AI 编辑差异。
// 当 AI 在当前文档有未批准差异时流式传入新文档，
// streamDocOpen 在下文中重新分配 activeDocId；如果不先清除
// 过时差异，稍后的 exitDiffMode 会将旧文档的内容
// 应用到新文档上并覆盖它（issue #2467）。
// activeDocId 此时仍指向之前活动的文档，因此 exitDiffMode(true) 恢复
// 并保存该文档——与 handleDocUpdate/switchToDoc 使用的相同守卫。
    if (_diffModeActive) exitDiffMode(true);
// 如果已经在流式传输文档，复用（不创建第二个临时文档）
    if (_streamDocId && docs.has(_streamDocId)) {
      const existing = docs.get(_streamDocId);
      if (title) existing.title = title;
      if (language) existing.language = language;
// 更新 UI 字段
      const titleInput = document.getElementById('doc-title-input');
      const langSelect = document.getElementById('doc-language-select');
      if (title && titleInput) titleInput.value = title;
      if (langSelect) langSelect.value = existing.language || 'markdown';
      if (language === 'email') {
        _showEmailFields(existing);
      }
      _syncStreamDocChrome(existing);
      renderTabs();
      return;
    }

    const sessionId = sessionModule?.getCurrentSessionId() || '';
// 复用此会话中相同标题的现有文档，或创建一个临时文档
    let docId = null;
    if (title) {
      for (const [existingId, existingDoc] of docs) {
        if (existingDoc.title === title && existingDoc.sessionId === sessionId) {
          docId = existingId;
          break;
        }
      }
    }
    if (!docId) {
      docId = '_streaming_' + Date.now();
      docs.set(docId, {
        id: docId,
        title: title || '',
        language: language || '',
        content: '',
        version: 1,
        sessionId,
      });
    }
    _streamDocId = docId;
    activeDocId = docId;
    _syncDocIndicator();

    if (!isOpen) openPanel();

// 强制文档按钮可见
    const toggleBtn = document.getElementById('overflow-doc-btn');
    if (toggleBtn) {
      toggleBtn.style.display = '';
      toggleBtn.classList.remove('toolbar-collapsed');
      toggleBtn.classList.add('has-docs');
    }
    const docInd2 = document.getElementById('doc-indicator-btn');
    if (docInd2) docInd2.classList.add('visible');

    const titleInput = document.getElementById('doc-title-input');
    const langSelect = document.getElementById('doc-language-select');
    const badge = document.getElementById('doc-version-badge');
    if (titleInput) titleInput.value = title || '';
    if (langSelect) langSelect.value = language || 'markdown';
    if (badge) badge.textContent = 'v1';

    const textarea = document.getElementById('doc-editor-textarea');
    if (textarea) {
      textarea.disabled = false;
      textarea.placeholder = t('document.editor_placeholder_content');
      textarea.value = '';
    }
// 显示流式指示器
    const indicator = document.getElementById('doc-stream-indicator');
    if (indicator) indicator.style.display = '';

// 流式传输 email 文档时立即显示 email 字段，使用户
// 无需刷新编辑器即可进入 email 模式。
    if (language === 'email') {
      const streamDoc = docs.get(_streamDocId);
      if (streamDoc) _showEmailFields(streamDoc);
    } else {
      _hideEmailFields();
    }

    syncHighlighting();
    _syncStreamDocChrome(docs.get(_streamDocId));
    renderTabs();
  }

/** 模拟流式效果的文档编辑 */
  let _editAnimFrame = null;
  function _animateDocEdit(textarea, newContent) {
    if (_editAnimFrame) cancelAnimationFrame(_editAnimFrame);
    const indicator = document.getElementById('doc-stream-indicator');
    if (indicator) indicator.style.display = '';
    const codeEl = document.getElementById('doc-editor-code');
    let cursor = document.getElementById('doc-stream-cursor');
    if (!cursor) {
      cursor = document.createElement('span');
      cursor.id = 'doc-stream-cursor';
      cursor.className = 'doc-stream-cursor';
      cursor.textContent = '\u258F';
    }

    const oldContent = textarea.value;

// 查找共同前缀和后缀以隔离更改区域
    let prefixLen = 0;
    while (prefixLen < oldContent.length && prefixLen < newContent.length &&
           oldContent[prefixLen] === newContent[prefixLen]) prefixLen++;
    let suffixLen = 0;
    while (suffixLen < (oldContent.length - prefixLen) &&
           suffixLen < (newContent.length - prefixLen) &&
           oldContent[oldContent.length - 1 - suffixLen] === newContent[newContent.length - 1 - suffixLen]) suffixLen++;

    const deletedText = oldContent.slice(prefixLen, oldContent.length - suffixLen);
    const insertedText = newContent.slice(prefixLen, newContent.length - suffixLen);
    const suffix = oldContent.slice(oldContent.length - suffixLen);

// 阶段 1：逐字符删除，然后阶段 2：插入
    const deleteChunk = Math.max(2, Math.ceil(deletedText.length / 30));
    const insertChunk = Math.max(2, Math.ceil(insertedText.length / 30));
    let deletePos = deletedText.length;
    let insertPos = 0;
    let phase = deletedText.length > 0 ? 'delete' : 'insert';

// 滚动到编辑区域
    const linesBefore = oldContent.slice(0, prefixLen).split('\n').length;
    const lineH = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    textarea.scrollTop = Math.max(0, (linesBefore - 3) * lineH);

    function tick() {
      if (phase === 'delete') {
        deletePos = Math.max(0, deletePos - deleteChunk);
        const current = oldContent.slice(0, prefixLen) + deletedText.slice(0, deletePos) + suffix;
        textarea.value = current;
        if (codeEl) codeEl.textContent = current + '\n';
        if (codeEl && codeEl.parentElement) codeEl.parentElement.appendChild(cursor);
        updateLineNumbers(current);
        if (deletePos > 0) {
          _editAnimFrame = requestAnimationFrame(tick);
        } else {
          phase = 'insert';
          _editAnimFrame = requestAnimationFrame(tick);
        }
      } else {
        insertPos = Math.min(insertPos + insertChunk, insertedText.length);
        const current = newContent.slice(0, prefixLen + insertPos) + suffix;
        textarea.value = current;
        if (codeEl) codeEl.textContent = current + '\n';
        if (codeEl && codeEl.parentElement) codeEl.parentElement.appendChild(cursor);
        updateLineNumbers(current);
        if (insertPos < insertedText.length) {
          _editAnimFrame = requestAnimationFrame(tick);
        } else {
// 完成——设置最终内容
          textarea.value = newContent;
          _editAnimFrame = null;
          if (indicator) indicator.style.display = 'none';
          if (cursor) cursor.remove();
          syncHighlighting();
        }
      }
    }
    _editAnimFrame = requestAnimationFrame(tick);
  }

/** 追加流式内容到当前流式文档 */
  let _streamHlDebounce = null;
  export function streamDocDelta(content) {
    if (!_streamDocId) return;
    const doc = docs.get(_streamDocId);
    if (doc) doc.content = content;

    if (_streamDocId === activeDocId) {
      if ((doc?.language || '').toLowerCase() === 'email') {
        _showEmailFields(doc);
        return;
      }
      const textarea = document.getElementById('doc-editor-textarea');
      if (textarea) {
        textarea.value = content;
// 内容流入时自动滚动到底部
        textarea.scrollTop = textarea.scrollHeight;
      }
// 立即更新文本和行号，防抖昂贵的高亮操作
      const codeEl = document.getElementById('doc-editor-code');
      if (codeEl) codeEl.textContent = content + '\n';
      updateLineNumbers(content);
// 在内容末尾显示闪烁光标
      let cursor = document.getElementById('doc-stream-cursor');
      if (!cursor) {
        cursor = document.createElement('span');
        cursor.id = 'doc-stream-cursor';
        cursor.className = 'doc-stream-cursor';
        cursor.textContent = '\u258F';
      }
      if (codeEl && codeEl.parentElement) codeEl.parentElement.appendChild(cursor);
      clearTimeout(_streamHlDebounce);
      _streamHlDebounce = setTimeout(syncHighlighting, 150);
    }
  }

/** 完成流式传输——当 doc_update 带着真实 ID 到达时调用。
*  返回旧的 _streamDocId，使 handleDocUpdate 可以迁移临时→真实。 */
  export function streamDocFinalize() {
    const oldId = _streamDocId;
    _streamDocId = null;
// 隐藏流式指示器 + 光标
    const indicator = document.getElementById('doc-stream-indicator');
    if (indicator) indicator.style.display = 'none';
    const cursor = document.getElementById('doc-stream-cursor');
    if (cursor) cursor.remove();
// 最终高亮处理 + 自动检测语言
    clearTimeout(_streamHlDebounce);
    syncHighlighting();
    attemptAutoDetect();
    return oldId;
  }

  function _isMarkdownPreviewVisible() {
    const preview = document.getElementById('doc-md-preview');
    return !!(preview && preview.style.display !== 'none');
  }

  function _refreshMarkdownPreviewIfVisible(docId, content) {
    if (!_isMarkdownPreviewVisible()) return false;
    const doc = docs.get(docId);
    const lang = ((doc && doc.language) || document.getElementById('doc-language-select')?.value || '').toLowerCase();
    if (lang !== 'markdown') return false;
    const textarea = document.getElementById('doc-editor-textarea');
    if (textarea) textarea.value = content;
    syncHighlighting();
    _setMarkdownPreviewActive(true, { remember: false });
    return true;
  }

/** 处理来自 AI 的 SSE doc_update 事件 */
  export function handleDocUpdate(data) {
    const streamingId = streamDocFinalize();
// 在此更新更改活动文档之前丢弃任何待处理的 AI 编辑差异。
// 差异状态（_diffModeActive/_diffOldContent/...）是模块级单例，
// 绑定到打开差异时活动的任何文档；如果在不清理的情况下切换文档，
// 稍后的标签切换或接受/拒绝全部会将过时差异的内容刷新到现在
// 活动的文档中并静默覆盖它（issue #2467）。
// activeDocId 此时仍指向之前活动的文档，因此 exitDiffMode(true) 恢复并
// 保存该文档——在我们下方重新分配 activeDocId 之前——镜像 switchToDoc()
// 和 enterDiffMode()。
// 和 enterDiffMode()。
    if (_diffModeActive) exitDiffMode(true);
    let docId = data.doc_id;
    const newContent = data.content || '';

// 将流式临时文档迁移到真实 ID
    if (streamingId && streamingId.startsWith('_streaming_') && docs.has(streamingId)) {
      const tempDoc = docs.get(streamingId);
      docs.delete(streamingId);
      tempDoc.id = docId;
      tempDoc.version = data.version || 1;
      if (data.title) tempDoc.title = data.title;
      if (data.language) tempDoc.language = data.language;
      tempDoc.content = newContent;
      docs.set(docId, tempDoc);
// 修正 activeDocId 引用
      if (activeDocId === streamingId) activeDocId = docId;
    }

// 去重：如果新文档与此会话中的现有文档标题相同，则更新它
    if (!docs.has(docId)) {
      const curSession = sessionModule?.getCurrentSessionId() || '';
      let reuseId = null;

// 第一：按标题匹配
      if (data.title) {
        for (const [existingId, existingDoc] of docs) {
          if (existingDoc.title === data.title && existingDoc.sessionId === curSession) {
            reuseId = existingId;
            break;
          }
        }
      }

// 第二：如果没有标题匹配，复用此会话中的空未命名文档
      if (!reuseId) {
        for (const [existingId, existingDoc] of docs) {
          if (existingDoc.sessionId === curSession &&
              (!existingDoc.title || existingDoc.title === 'Untitled') &&
              (!existingDoc.content || existingDoc.content.trim() === '')) {
            reuseId = existingId;
            break;
          }
        }
      }

      if (reuseId) docId = reuseId;
    }

// 在更新 map 之前捕获旧内容
    const textarea = document.getElementById('doc-editor-textarea');
    const oldContent = (docId === activeDocId && textarea) ? textarea.value : '';
    const isExistingDoc = docs.has(docId);

// 在 docs map 中添加或更新
    if (isExistingDoc) {
      const doc = docs.get(docId);
      doc.content = newContent;
      doc.version = data.version || doc.version;
      if (data.title) doc.title = data.title;
      if (data.language) doc.language = data.language;
    } else {
      docs.set(docId, {
        id: docId,
        title: data.title || '',
        language: data.language || '',
        content: newContent,
        version: data.version || 1,
        sessionId: sessionModule?.getCurrentSessionId() || '',
      });
    }

    _syncDocIndicator();

// 如果仍是"Untitled"且 AI 未提供标题，从内容自动生成标题
    if (!data.title) autoTitleFromContent(newContent, docId);

    if (!isOpen) openPanel();

// 强制文档按钮可见（覆盖外观设置和工具栏折叠）
    const toggleBtn = document.getElementById('overflow-doc-btn');
    if (toggleBtn) {
      toggleBtn.style.display = '';
      toggleBtn.classList.remove('toolbar-collapsed');
      toggleBtn.classList.add('has-docs');
    }
    const docInd = document.getElementById('doc-indicator-btn');
    if (docInd) docInd.classList.add('visible');

// 切换到此文档的标签页
    activeDocId = docId;

    const badge = document.getElementById('doc-version-badge');
    const titleInput = document.getElementById('doc-title-input');
    const langSelect = document.getElementById('doc-language-select');

// 如果处于空状态，重新启用编辑器
    if (textarea) {
      textarea.disabled = false;
      textarea.placeholder = t('document.editor_placeholder_content');
    }
    if (badge) badge.textContent = `v${data.version || 1}`;
    if (data.title && titleInput) titleInput.value = data.title;
// 从数据设置语言，或回退到文档已有的（例如流式传输的）
    const docLang = data.language || (docs.has(docId) && docs.get(docId).language) || '';
    if (docLang && langSelect) langSelect.value = docLang;
    if (!docLang) attemptAutoDetect();
    const isEmailUpdate = (docLang || '').toLowerCase() === 'email';
    const markdownPreviewWasVisible = _isMarkdownPreviewVisible();

// 为编辑动画更新内容；为创建/流式直接应用
    const isEdit = !isEmailUpdate && isExistingDoc && oldContent && oldContent !== newContent && !streamingId;
    if (isEdit && textarea) {
// 计算更改行数以决定动画和差异模式
      const oldLines = oldContent.split('\n');
      const newLines = newContent.split('\n');
      let changedLines = 0;
      const maxLen = Math.max(oldLines.length, newLines.length);
      for (let li = 0; li < maxLen; li++) {
        if (oldLines[li] !== newLines[li]) changedLines++;
      }
      if (changedLines >= DIFF_MODE_THRESHOLD) {
        if (markdownPreviewWasVisible) _setMarkdownPreviewActive(false, { remember: false });
        enterDiffMode(oldContent, newContent);
      } else if (markdownPreviewWasVisible && _refreshMarkdownPreviewIfVisible(docId, newContent)) {
// 预览是可见表面，因此刷新它而不是动画隐藏的编辑器。
      } else {
        _animateDocEdit(textarea, newContent);
      }
    } else {
      if (isEmailUpdate) {
        const updatedDocForEmail = docs.get(docId);
        if (updatedDocForEmail) {
          _setMarkdownPreviewActive(false, { remember: false });
          _showEmailFields(updatedDocForEmail);
        }
      } else {
        if (textarea) textarea.value = newContent;
        syncHighlighting();
        _refreshMarkdownPreviewIfVisible(docId, newContent);
      }
    }

// 闪烁编辑器包装以指示内容已更新
    const wrap = document.getElementById('doc-editor-wrap');
    if (wrap && !isEdit) {
      wrap.classList.remove('doc-updated-flash');
      void wrap.offsetWidth; // force reflow
      wrap.classList.add('doc-updated-flash');
      wrap.addEventListener('animationend', () => wrap.classList.remove('doc-updated-flash'), { once: true });
    }

// 为未设置语言的文档自动检测语言
    const updatedDoc = docs.get(docId);
    if (isEmailUpdate && updatedDoc) {
      updatedDoc.language = 'email';
      if (langSelect) langSelect.value = 'email';
      _showEmailFields(updatedDoc);
    }
    if (updatedDoc && !updatedDoc.userSetLanguage && !updatedDoc.language) {
      setTimeout(attemptAutoDetect, 100);
    }

// 显示/隐藏格式特定的按钮并自动切换预览
    const finalLang = docLang || (updatedDoc && updatedDoc.language) || '';
    const mdToolbar = document.getElementById('doc-md-toolbar');
// 工具栏对所有文档类型显示——内部项目根据语言自我控制。
    if (mdToolbar) mdToolbar.style.display = '';
// 流式传输后自动为 CSV 显示表格视图
    if (finalLang === 'csv') {
      requestAnimationFrame(() => {
        const csvPreview = document.getElementById('doc-csv-preview');
        if (csvPreview && csvPreview.style.display === 'none') toggleCsvPreview();
      });
    }

    renderTabs();

// 在任何更新后刷新活动文档的头部按钮（运行/预览 ▶、编辑切换）——
// 否则 AI 创建的 html/svg/代码文档不会显示其 ▶ 运行按钮
// 直到页面刷新。
    if (docId === activeDocId) {
      _syncHeaderActions();
// 表单支持（PDF）文档：如果正在显示，重新获取渲染预览。
      if (_isFormBackedDoc(newContent)) {
        const explicit = _pdfViewState.get(docId);
        if (explicit !== false) _refreshPdfPreviewIframe();
      }
    }
  }

/** 切换版本历史面板 */
  let _versionClickOutside = null;
  let _versionSavedContent = null;  // 暂存当前内容用于预览/还原
  async function toggleVersionHistory() {
    const panel = document.getElementById('doc-version-panel');
    if (!panel || !activeDocId) return;

    if (panel.classList.contains('hidden')) {
// 暂存当前内容以便在关闭时恢复
      const ta = document.getElementById('doc-editor-textarea');
      _versionSavedContent = ta ? ta.value : null;

// 在桌面端定位到侧边栏旁边
      const sidebar = document.getElementById('sidebar');
      const isMobile = window.innerWidth <= 768;
      if (!isMobile && sidebar) {
        const sidebarRight = sidebar.classList.contains('right-side');
        const collapsed = document.body.classList.contains('sidebar-collapsed');
        if (sidebarRight || collapsed) {
          panel.style.left = '0';
          panel.style.right = 'auto';
        } else {
          panel.style.left = sidebar.offsetWidth + 'px';
          panel.style.right = 'auto';
        }
      } else if (isMobile) {
// 清除任何来自先前桌面打开的陈旧内联定位，
// 使移动端底部工作表（CSS）不被推到屏幕外。
        panel.style.left = '';
        panel.style.right = '';
        panel.style.top = '';
      }

// 将面板移动到 body，使其不被文档面板溢出裁剪
      if (panel.parentElement !== document.body) {
        document.body.appendChild(panel);
      }

      panel.classList.remove('hidden');
      await loadVersionHistory();
// 在外部点击时关闭
      setTimeout(() => {
        _versionClickOutside = (e) => {
          if (!panel.contains(e.target) && e.target.id !== 'doc-version-badge') {
            _closeVersionPanel();
          }
        };
        document.addEventListener('click', _versionClickOutside, true);
      }, 0);
    } else {
      _closeVersionPanel();
    }
  }

  function _closeVersionPanel() {
    const panel = document.getElementById('doc-version-panel');
    if (panel) panel.classList.add('hidden');
// 恢复到最新（暂存的）内容
    if (_versionSavedContent !== null) {
      const ta = document.getElementById('doc-editor-textarea');
      if (ta) ta.value = _versionSavedContent;
      syncHighlighting();
      _versionSavedContent = null;
    }
    if (_versionClickOutside) {
      document.removeEventListener('click', _versionClickOutside, true);
      _versionClickOutside = null;
    }
  }

/** 在两个字符串之间构建简短差异摘要 */
  function _buildDiffSummary(oldText, newText) {
    if (!oldText && !newText) return '';
    const oldLines = (oldText || '').split('\n');
    const newLines = (newText || '').split('\n');
    const added = [], removed = [];
// 简单行差异——收集更改的行
    const maxCheck = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxCheck; i++) {
      const ol = oldLines[i], nl = newLines[i];
      if (ol === nl) continue;
      if (ol !== undefined && (nl === undefined || ol !== nl)) removed.push(ol.trim());
      if (nl !== undefined && (ol === undefined || ol !== nl)) added.push(nl.trim());
    }
// 最多显示 3 个更改
    const parts = [];
    for (const line of removed.slice(0, 2)) {
      if (line) parts.push(`<span class="diff-del">${_escHtml(line.slice(0, 60))}</span>`);
    }
    for (const line of added.slice(0, 2)) {
      if (line) parts.push(`<span class="diff-add">${_escHtml(line.slice(0, 60))}</span>`);
    }
    const extra = (added.length + removed.length) - 4;
    if (extra > 0) parts.push(`<span>+${extra} more changes</span>`);
    return parts.join('<br>');
  }
  function _escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

/** 加载版本历史列表 */
  async function loadVersionHistory() {
    if (!activeDocId) return;
    const list = document.getElementById('doc-version-list');
    if (!list) return;

    try {
      const res = await fetch(`${API_BASE}/api/document/${activeDocId}/versions`);
      const versions = await res.json();

// 在连续版本之间构建差异摘要
      const diffs = [];
      for (let i = 0; i < versions.length; i++) {
        if (i < versions.length - 1) {
          diffs.push(_buildDiffSummary(versions[i + 1].content, versions[i].content));
        } else {
          diffs.push('');
        }
      }

      list.innerHTML = versions.map((v, i) => `
        <div class="doc-version-item" data-version="${v.version_number}">
          <div class="doc-version-info">
            <span class="doc-version-num">v${v.version_number}</span>
            ${i === 0 ? '<span class="doc-version-latest">latest</span>' : `<span class="doc-version-source">${v.source}</span><span class="doc-version-time">${v.created_at ? new Date(v.created_at).toLocaleString() : ''}</span>`}
          </div>
          ${v.summary ? `<div class="doc-version-summary">${v.summary}</div>` : ''}
          ${diffs[i] ? `<div class="doc-version-diff">${diffs[i]}</div>` : ''}
          ${i > 0 ? `<button class="doc-version-restore" data-version="${v.version_number}">Restore</button>` : ''}
        </div>
      `).join('');

// 绑定恢复按钮
      list.querySelectorAll('.doc-version-restore').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          restoreVersion(parseInt(btn.dataset.version));
        });
      });

// 绑定点击以预览版本 + 活动状态
      list.querySelectorAll('.doc-version-item').forEach(item => {
        item.addEventListener('click', (e) => {
          if (e.target.classList.contains('doc-version-restore')) return;
// 切换活动状态
          list.querySelectorAll('.doc-version-item.active').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
          previewVersion(parseInt(item.dataset.version));
        });
      });
    } catch (e) {
      list.innerHTML = '<div style="padding:8px;opacity:0.5;">Failed to load versions</div>';
    }
  }

/** 在编辑器中预览特定版本（不保存） */
  async function previewVersion(num) {
    if (!activeDocId) return;
    try {
      const res = await fetch(`${API_BASE}/api/document/${activeDocId}/version/${num}`);
      const ver = await res.json();
      const textarea = document.getElementById('doc-editor-textarea');
      if (textarea) textarea.value = ver.content || '';
      syncHighlighting();
    } catch (e) {
      console.error('Failed to preview version:', e);
    }
  }

/** 恢复旧版本（创建新版本） */
  async function restoreVersion(num) {
    if (!activeDocId) return;
    try {
      const res = await fetch(`${API_BASE}/api/document/${activeDocId}/restore/${num}`, {
        method: 'POST',
      });
      const doc = await res.json();
      populateEditor(doc);
// 清除暂存——恢复的内容即是新最新版本
      _versionSavedContent = null;
// 更新 map
      if (docs.has(activeDocId)) {
        const d = docs.get(activeDocId);
        d.content = doc.current_content || '';
        d.version = doc.version_count || 1;
      }
      await loadVersionHistory();
      if (uiModule) uiModule.showToast(`Restored to v${num}`);
    } catch (e) {
      console.error('Failed to restore version:', e);
      if (uiModule) uiModule.showError('Failed to restore version');
    }
  }

/** 通过 PATCH 更新文档标题 */
  async function updateTitle(overrideDocId, overrideTitle) {
    const docId = overrideDocId || activeDocId;
    if (!docId) return;
    const title = overrideTitle || document.getElementById('doc-title-input')?.value;
    if (!title) return;
    try {
      await fetch(`${API_BASE}/api/document/${docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (docs.has(docId)) {
        docs.get(docId).title = title;
        renderTabs();
      }
    } catch (e) {
      console.error('Failed to update title:', e);
    }
  }

/** 如果仍是"Untitled"，从内容自动检测标题 */
  function autoTitleFromContent(content, docId) {
    const id = docId || activeDocId;
    if (!id) return;
    const doc = docs.get(id);
    if (!doc || (doc.title && doc.title !== '' && doc.title !== 'Untitled')) return;

    const text = (content || '').trimStart();
    if (!text) return;

    let title = null;

// Markdown 标题：# 标题
    const mdMatch = text.match(/^#{1,3}\s+(.+)/m);
    if (mdMatch) {
      title = mdMatch[1].trim();
    }

// HTML 标题：<h1>标题</h1>
    if (!title) {
      const htmlMatch = text.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i);
      if (htmlMatch) title = htmlMatch[1].trim();
    }

// 第一行非空内容作为回退（仅当足够短以成为标题时）
    if (!title) {
      const firstLine = text.split('\n').find(l => l.trim().length > 0);
      if (firstLine) {
        const cleaned = firstLine.trim();
        if (cleaned.length <= 60 && cleaned.length >= 2) {
          title = cleaned;
        }
      }
    }

    if (!title) return;

// 清理：去除尾随标点如 : 或 ...
    title = title.replace(/[:#*`]+$/g, '').trim();
    if (title.length > 50) title = title.slice(0, 48) + '...';
    if (!title) return;

    updateTitle(id, title);
    const titleInput = document.getElementById('doc-title-input');
    if (titleInput && id === activeDocId) titleInput.value = title;
  }

/** 通过 PATCH 更新文档语言 */
  async function updateLanguage() {
    if (!activeDocId) return;
    const select = document.getElementById('doc-language-select');
    if (!select) return;
    try {
      await fetch(`${API_BASE}/api/document/${activeDocId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: select.value }),
      });
      if (docs.has(activeDocId)) {
        docs.get(activeDocId).language = select.value;
        renderTabs();
      }
    } catch (e) {
      console.error('Failed to update language:', e);
    }
  }

/** 清除所有标签状态（例如会话切换时） */
  export function clearAll() {
    docs.clear();
    activeDocId = null;
    _lastSessionId = '';
    if (isOpen) closePanel();
    _syncDocIndicator();
  }

  export function isPanelOpen() {
    return isOpen;
  }

  export function getCurrentDocId() {
    return activeDocId;
  }

/** 通过源 UID + 文件夹查找打开的 email 标签页。返回 docId 或 null。 */
  export function findEmailDocId(uid, folder) {
    if (uid == null) return null;
    const wantUid = String(uid);
    const wantFolder = (folder || '').trim();
    for (const [id, d] of docs) {
      if (d.language !== 'email') continue;
      const fields = _parseEmailHeader(d.content || '');
      if (fields.sourceUid && String(fields.sourceUid) === wantUid &&
          (!wantFolder || (fields.sourceFolder || '').trim() === wantFolder)) {
        return id;
      }
    }
    return null;
  }



const documentModule = {
  init,
  openPanel,
  closePanel,
  swapSide,
  createDocument,
  newDocument,
  loadDocument,
  injectFreshDoc,
  ensurePaneMounted: _ensureDocPaneMounted,
  loadSessionDocs,
  ensureDocPanel,
  saveDocument,
  handleDocUpdate,
  handleDocSuggestions,
  streamDocOpen,
  streamDocDelta,
  streamDocFinalize,
  isPanelOpen,
  enterDiffMode,
  exitDiffMode,
  isDiffModeActive,
  getCurrentDocId,
  findEmailDocId,
  getSelectionContext,
  clearSelection,
  clearAll,
  openLibrary,
  closeLibrary,
  isLibraryOpen,
};

export default documentModule;
window.documentModule = documentModule;
