// static/js/documentLibrary.js — 文档库（文档/聊天/归档/调研）UI
/**
 * Document Library — modal with Chats / Documents / Research / Archive tabs.
 * Extracted from document.js to reduce file size.
 */

import uiModule from './ui.js';
import sessionModule from './sessions.js';
import spinnerModule from './spinner.js';
import markdownModule from './markdown.js';
import { makeWindowDraggable } from './windowDrag.js';
import { langIcon } from './langIcons.js';
import { registerMenuDismiss, dismissOrRemove } from './escMenuStack.js';

// ── 从 documentModule 注入的引用 ──
let API_BASE = '';
let _esc;          // HTML 转义函数
let _getDocs;      // () => Map of open docs
let _isOpenFn;     // () => boolean — is doc panel open
let _createDocument;
let _loadDocument;
let _switchToDoc;
let _openPanel;
let _addDocToTabs;
let _syncDocIndicator;

export function initLibrary(config) {
  API_BASE        = config.apiBase;
  _esc            = config.esc;
  _getDocs        = config.getDocs;
  _isOpenFn       = config.isOpen;
  _createDocument = config.createDocument;
  _loadDocument   = config.loadDocument;
  _switchToDoc    = config.switchToDoc;
  _openPanel      = config.openPanel;
  _addDocToTabs   = config.addDocToTabs;
  _syncDocIndicator = config.syncDocIndicator;
}

// ── 库状态 ──
let _libraryOpen = false;
// 追踪哪些标签页已经播放过多米诺入场动画，确保我们只
// 运行一次。每个标签页 DOM 至少会通过一次渲染；没有这个守卫的话
// 每次重新渲染都会重播动画，看起来会很闪烁。
const _libraryCascadedTabs = new Set();
function _maybeCascadeGrid(grid, tabKey) {
  if (!grid || !tabKey || _libraryCascadedTabs.has(tabKey)) return;
  _libraryCascadedTabs.add(tabKey);
  grid.classList.add('doclib-just-opened');
  setTimeout(() => grid.classList.remove('doclib-just-opened'), 900);
}
let _libraryDocs = [];
let _libraryTotal = 0;
let _libraryOffset = 0;
let _docsVisibleLimit = 20;  // chunked reveal (matches the Chats tab's 20)
let _libraryLanguages = {};
let _librarySessionCount = 0;
let _libraryActiveLanguage = null;
let _librarySort = 'recent';
let _librarySearch = '';
let _librarySearchDebounce = null;

// 在纯文本字符串中高亮显示活跃的搜索词。先转义，
// 然后将匹配项包裹在 <mark> 标签中。正则表达式的交替匹配模式
// 由经过净化的查询词元构建，因此结果始终可以安全地通过 innerHTML 渲染。
function _hlSearch(text) {
  const esc = _esc(text || '');
  const q = (_librarySearch || '').trim();
  if (!q) return esc;
  const toks = [...new Set(q.split(/\s+/).filter(Boolean))]
    .sort((a, b) => b.length - a.length)             // prefer longer matches
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!toks.length) return esc;
  try {
    return esc.replace(new RegExp(`(${toks.join('|')})`, 'gi'),
                       '<mark class="doclib-search-hl">$1</mark>');
  } catch { return esc; }
}

function _safeResearchHref(raw) {
  try {
    const parsed = new URL(String(raw || '').trim(), window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return _esc(parsed.href);
  } catch {}
  return '';
}

let _libraryEscHandler = null;
let _librarySelectMode = false;
let _librarySelectedIds = new Set();
let _libraryImportMode = false;
let _libScrollBound = false;   // infinite-scroll listener attached once
let _libraryArchivedView = false;   // 文档标签页是否显示已归档文档？

// ---- 库动画辅助函数 ----

  /** Collapse an expanded card */
  function _collapseExpandedCard(card) {
    const grid = card.closest('.doclib-grid');
    const instant = card?.dataset?.spaceToggle === '1';
    card.classList.remove('doclib-card-expanded');
    // 释放高度锁定以便网格恢复自然尺寸
    if (grid) {
      grid.style.minHeight = '';
      grid.style.maxHeight = '';
    }
    const reader = card.querySelector('.doclib-card-reader');
    if (reader) reader.remove();

    // 淡入还原兄弟节点
    if (grid && !instant) {
      const siblings = [...grid.querySelectorAll('.doclib-card')].filter(c => c !== card);
      siblings.forEach(s => { s.style.opacity = '0'; });
      requestAnimationFrame(() => {
        siblings.forEach(s => {
          s.style.transition = 'opacity 0.15s ease';
          s.style.opacity = '1';
        });
        setTimeout(() => { siblings.forEach(s => { s.style.transition = ''; s.style.opacity = ''; }); }, 200);
      });
    }
  }

  // 获取聊天的完整历史记录并序列化为纯文本转录，
  // 最小化 token 浪费（无时间戳、无角色标签、消息之间仅单换行）。
  // 最小化 token 浪费（无时间戳、无角色标签、消息之间仅单换行）。
  // 库不需要先在 UI 中加载聊天。
  async function _copyChatById(sessionId) {
    try {
      const res = await fetch(`${API_BASE}/api/history/${sessionId}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      const history = Array.isArray(data) ? data : (data.history || []);
      const lines = [];
      for (const m of history) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const label = m.role === 'user' ? 'User' : 'Assistant';
        const body = (m.content || '')
          .replace(/<think>[\s\S]*?<\/think>/g, '')
          .replace(/<think>[\s\S]*$/, '')
          .trim();
        if (body) lines.push(`${label}: ${body}`);
      }
      const text = lines.join('\n\n');
      if (uiModule && uiModule.copyToClipboard) {
        await uiModule.copyToClipboard(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch (err) {
      if (uiModule && uiModule.showError) uiModule.showError('Failed to copy chat');
    }
  }

  // 长按列表卡片以打开其操作菜单。`menuSelector` 解析为应出现的 DOM 元素。
  // 卡片上已有的 ••• 按钮；长按时我们触发其点击以便
  // 下拉菜单在通常位置打开。手指移动超过 10px 或在计时器触发前松开则取消。
  // 500ms cancels.
  function _attachLongPressMenu(card, menuSelector) {
    let hold = null;
    let start = null;
    const cancel = () => { if (hold) { clearTimeout(hold); hold = null; } start = null; };
    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest(menuSelector + ', .memory-select-cb, button')) return;
      start = { x: e.clientX, y: e.clientY };
      hold = setTimeout(() => {
        hold = null;
        card._suppressNextClick = true;
        setTimeout(() => { card._suppressNextClick = false; }, 400);
        if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
        const btn = card.querySelector(menuSelector);
        if (btn) btn.click();
      }, 500);
    });
    card.addEventListener('pointermove', (e) => {
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
    });
    card.addEventListener('pointerup', cancel);
    card.addEventListener('pointercancel', cancel);
  }

  // 聊天/归档/调研下拉行使用的内联图标。与各处使用的 24x24 viewBox 约定一致。
  // 与文档标签页卡片菜单使用相同的样式，以保持各标签页之间的视觉语言一致。
  // 各标签页之间保持一致。
  const _LIB_DD_ICONS = {
    open: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    archive: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
    restore: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><polyline points="3 4 3 9 8 9"/></svg>',
    delete: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
    clone: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  };

  function _showLibDropdown(anchor, items, opts) {
    opts = opts || {};
    document.querySelectorAll('._lib-dd').forEach(dismissOrRemove);
    const dd = document.createElement('div');
    dd.className = 'dropdown session-dropdown-menu _lib-dd';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'dropdown-item-compact' + (item.danger ? ' dropdown-item-danger' : '');
      const iconKey = item.icon || item.label.toLowerCase();
      const iconSvg = _LIB_DD_ICONS[iconKey] || '';
      row.innerHTML = (iconSvg ? '<span class="dropdown-icon">' + iconSvg + '</span>' : '') + '<span>' + item.label + '</span>';
      row.addEventListener('click', (e) => { e.stopPropagation(); teardown(); item.action(); });
      dd.appendChild(row);
    }
    if (typeof opts.onSelect === 'function') {
      const sel = document.createElement('div');
      sel.className = 'dropdown-item-compact';
      sel.innerHTML =
        '<span class="dropdown-icon"><span style="font-size:16px;line-height:1;position:relative;top:-2px;">●</span></span>'
        + '<span>Select</span>';
      sel.addEventListener('click', (e) => { e.stopPropagation(); teardown(); opts.onSelect(); });
      dd.appendChild(sel);
    }
    const cancel = document.createElement('div');
    cancel.className = 'dropdown-item-compact dropdown-cancel-mobile';
    cancel.innerHTML =
      '<span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>'
      + '<span>Cancel</span>';
    cancel.addEventListener('click', (e) => { e.stopPropagation(); teardown(); if (typeof opts.onCancel === 'function') opts.onCancel(); });
    dd.appendChild(cancel);
    document.body.appendChild(dd);
    const rect = anchor.getBoundingClientRect();
    dd.style.right = (window.innerWidth - rect.right) + 'px';
    dd.style.top = (rect.bottom + 2) + 'px';
    dd.style.display = 'block';
    dd.style.zIndex = '100000';
    requestAnimationFrame(() => {
      const mr = dd.getBoundingClientRect();
      if (mr.bottom > window.innerHeight - 8) {
        dd.style.top = (rect.top - mr.height - 2) + 'px';
      }
      if (mr.left < 8) { dd.style.left = '8px'; dd.style.right = 'auto'; }
    });
    // 每个关闭路径共享的单一幂等清理（点击选项、点击遮罩、滑动、Escape）。
    // 每个关闭路径共享的单一幂等清理（点击选项、点击遮罩、滑动、Escape）。
    let _unreg = () => {};
    const teardown = () => {
      _unreg(); _unreg = () => {};
      document.removeEventListener('click', close);
      dd.remove();
    };
    const close = (e) => { if (!dd.contains(e.target)) teardown(); };
    setTimeout(() => document.addEventListener('click', close), 0);
    _unreg = registerMenuDismiss(teardown);
    dd._dismiss = teardown;   // let bulk removers (reopen sweep) tear down cleanly

    // 向下滑动关闭（移动端）。模拟底部滑出面板的感觉 — 拖动
    // 菜单卡片本身，如果手指垂直移动足够远则关闭。
    // 弹回。仅垂直方向；水平滑动穿透到滚动。
    let _swipeStart = null;
    let _swipeDy = 0;
    dd.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      _swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      _swipeDy = 0;
      dd.style.transition = '';
    }, { passive: true });
    dd.addEventListener('touchmove', (e) => {
      if (!_swipeStart || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - _swipeStart.x;
      const dy = e.touches[0].clientY - _swipeStart.y;
      if (Math.abs(dy) < Math.abs(dx)) { _swipeStart = null; return; }
      if (dy > 0) {
        _swipeDy = dy;
        dd.style.transform = 'translateY(' + dy + 'px)';
        dd.style.opacity = String(Math.max(0.3, 1 - dy / 240));
      }
    }, { passive: true });
    dd.addEventListener('touchend', () => {
      if (!_swipeStart) return;
      _swipeStart = null;
      if (_swipeDy > 60) {
        dd.style.transition = 'transform 0.15s ease, opacity 0.15s ease';
        dd.style.transform = 'translateY(120px)';
        dd.style.opacity = '0';
        // 立即注销并移除外部点击监听器；将 DOM 删除推迟到
        // 下一个微任务，以便触发关闭的点击可以先冒泡。
        // 下一个微任务，以便触发关闭的点击可以先冒泡。
        document.removeEventListener('click', close);
        setTimeout(() => dd.remove(), 160);
      } else {
        dd.style.transition = 'transform 0.18s ease, opacity 0.18s ease';
        dd.style.transform = '';
        dd.style.opacity = '';
      }
    });
  }

  // ---- 文档库 ----

  function libraryRelativeTime(isoString) {
    if (!isoString) return '';
    const now = Date.now();
    const then = new Date(isoString).getTime();
    const diffS = Math.floor((now - then) / 1000);
    if (diffS < 60) return 'just now';
    const diffM = Math.floor(diffS / 60);
    if (diffM < 60) return diffM + 'm ago';
    const diffH = Math.floor(diffM / 60);
    if (diffH < 24) return diffH + 'h ago';
    const diffD = Math.floor(diffH / 24);
    if (diffD === 1) return 'yesterday';
    if (diffD < 14) return diffD + 'd ago';
    const diffW = Math.floor(diffD / 7);
    if (diffW < 8) return diffW + 'w ago';
    return new Date(isoString).toLocaleDateString();
  }

  async function libraryFetch(append) {
    if (!append) _libraryOffset = 0;
    // 将页面大小提升到后端最大值（50），这样全屏时在大显示器上不会留下半个视口空白。
    // 将页面大小提升到后端最大值（50），这样全屏时在大显示器上不会留下半个视口空白。
    // 虽然请求 limit=100，但 documents_library 验证限 `le=50`，所以我们
    // 必须限制在此值。下面的自动填充循环会补足剩余的缺口。
    const params = new URLSearchParams({
      sort: _librarySort,
      offset: String(_libraryOffset),
      limit: '50',
    });
    if (_librarySearch) params.set('search', _librarySearch);
    if (_libraryActiveLanguage) params.set('language', _libraryActiveLanguage);
    if (_libraryArchivedView) params.set('archived', 'true');

    try {
      const res = await fetch(`${API_BASE}/api/documents/library?${params}`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();

      if (append) {
        _libraryDocs = _libraryDocs.concat(data.documents);
      } else {
        _libraryDocs = data.documents;
        _docsVisibleLimit = 20;  // reset chunk on a fresh load / search / sort
      }
      _libraryTotal = data.total;
      _libraryLanguages = data.languages;
      _librarySessionCount = data.session_count;

      libraryRenderStats();
      libraryRenderLangChips();
      libraryRenderGrid();
      libraryRenderLoadMore();
    } catch (e) {
      console.error('Library fetch error:', e);
    }
  }

  function libraryRenderStats() {
    const el = document.getElementById('doclib-stats');
    if (!el) return;
    const totalAll = Object.values(_libraryLanguages).reduce((a, b) => a + b, 0);
    if (_librarySearch || _libraryActiveLanguage) {
      el.textContent = `${t('library.document_count_of_total', { n: _libraryTotal, total: totalAll })}`;
    } else {
      el.textContent = `${t('library.document_count_total', { total: totalAll })}`;
    }
  }

  function libraryRenderLangChips() {
    const wrap = document.getElementById('doclib-chips');
    if (!wrap) return;
    // 仅移除语言标签按钮，保留排序/选择元素
    wrap.querySelectorAll('.memory-cat-chip').forEach(c => c.remove());
    const totalAll = Object.values(_libraryLanguages).reduce((a, b) => a + b, 0);

    // 当没有文档时，完全隐藏 "all (0)" 标签和语言标签。
    if (totalAll === 0) return;

    const allChip = document.createElement('button');
    allChip.className = 'memory-cat-chip' + (!_libraryActiveLanguage ? ' active' : '');
    allChip.textContent = t('library.all_documents', { n: totalAll });
    allChip.addEventListener('click', () => {
      if (_librarySelectMode) {
        _libraryDocs.forEach(d => _librarySelectedIds.add(d.id));
        libraryUpdateBulkCount();
        const selectAllEl = document.getElementById('doclib-select-all');
        if (selectAllEl) selectAllEl.checked = true;
        libraryRenderGrid();
        return;
      }
      _libraryActiveLanguage = null;
      libraryFetch(false);
    });
    wrap.appendChild(allChip);

    const sorted = Object.entries(_libraryLanguages).sort((a, b) => b[1] - a[1]);
    for (const [lang, count] of sorted) {
      const chip = document.createElement('button');
      chip.className = 'memory-cat-chip' + (_libraryActiveLanguage === lang ? ' active' : '');
      chip.textContent = t('library.lang_filter', { lang: lang, n: count });
      chip.addEventListener('click', () => {
        _libraryActiveLanguage = lang;
        libraryFetch(false);
      });
      wrap.appendChild(chip);
    }
  }

  function libraryRemoveDocumentFromState(docId) {
    const removed = _libraryDocs.find(d => String(d.id) === String(docId));
    _libraryDocs = _libraryDocs.filter(d => String(d.id) !== String(docId));
    _librarySelectedIds.delete(docId);
    _libraryTotal = Math.max(0, _libraryTotal - 1);

    const lang = removed && (removed.language || 'text');
    if (lang && Object.prototype.hasOwnProperty.call(_libraryLanguages, lang)) {
      const next = Math.max(0, Number(_libraryLanguages[lang] || 0) - 1);
      if (next > 0) {
        _libraryLanguages[lang] = next;
      } else {
        delete _libraryLanguages[lang];
      }
    }

    libraryRenderStats();
    libraryRenderLangChips();
    libraryUpdateBulkCount();
  }

  function libraryRenderGrid() {
    const grid = document.getElementById('doclib-grid');
    if (!grid) return;
    // 打开的卡片菜单挂载在 <body> 上（为了逃避溢出裁剪），因此
    // 必须拆除它。同时移除为此菜单注册的任何 Escape 栈条目。
    // 必须拆除它。同时移除为此菜单注册的任何 Escape 栈条目。
    document.querySelectorAll('.doclib-card-dropdown').forEach(dismissOrRemove);
    grid.innerHTML = '';
    // 丢弃任何之前的行内"加载更多"按钮 — 下面随列表一起重新生成。
    if (grid.parentElement) grid.parentElement.querySelectorAll(':scope > .doclib-inline-load-more').forEach(b => b.remove());

    if (_libraryDocs.length === 0) {
      if (_librarySearch || _libraryActiveLanguage) {
        grid.innerHTML = '<div class="doclib-empty">' + t('library.no_documents_match') + '</div>';
      } else {
        const _impIco = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin:0 4px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
        grid.innerHTML =
          '<div class="doclib-empty" style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;">' +
            '<span>No documents yet</span>' +
            '<span style="opacity:0.7;font-size:11px;">' +
              '<a href="#" data-doclib-import style="color:var(--accent,var(--red));text-decoration:underline;">Import' + _impIco + '</a>' +
              ' &middot; or create one in a session' +
            '</span>' +
          '</div>';
        grid.querySelector('[data-doclib-import]')?.addEventListener('click', (e) => {
          e.preventDefault();
          document.getElementById('doclib-import-file-btn')?.click();
        });
      }
      return;
    }
    _maybeCascadeGrid(grid, 'documents');

    // 每次展示 20 条（与聊天标签页一致）。旧的文档标签页一次性
    // 显示所有内容，但数百个文档会导致明显的帧率下降。
    // 显示所有内容，但数百个文档会导致明显的帧率下降。
    const shown = _libraryDocs.slice(0, _docsVisibleLimit);
    for (const doc of shown) {
      grid.appendChild(libraryCreateCard(doc));
    }
    // 当还有更多已加载文档待展示，或服务器尚未返回总数时
    // （即我们甚至还没获取第一页），显示"加载更多"。
    // （即我们甚至还没获取第一页），显示"加载更多"。
    if (shownCount < _libraryTotal) {
      const btn = document.createElement('button');
      btn.className = 'doclib-load-more doclib-inline-load-more';
      btn.id = 'doclib-docs-load-more';
      btn.textContent = t('library.load_more', { shown: shownCount, total: _libraryTotal });
      btn.addEventListener('click', async () => {
        _docsVisibleLimit += 20;
        // 需要比已获取的更多？先拉取下一页服务器数据。
        if (_docsVisibleLimit > _libraryDocs.length && _libraryDocs.length < _libraryTotal) {
          _libraryOffset = _libraryDocs.length;
          await libraryFetch(true);  // appends + re-renders
        } else {
          libraryRenderGrid();
        }
      });
      grid.parentElement.appendChild(btn);
    }
  }

  // 库的无限滚动（移动端 + 桌面端），覆盖所有标签页 —
  // 文档、聊天、调研、归档都在其列表底部渲染一个 `.doclib-inline-load-more` 按钮。
  // 当用户滚动到足够近（200px）时，我们程序化地点击它。
  // 当用户滚动到足够近（200px）时，我们程序化地点击它。
  // 当滚动到接近视口底部时点击它 — 复用每个标签页各自的加载逻辑。
  // 按钮点击后标记，这样同一个实例不会重复触发（按钮在下次渲染时会被重新
  // 创建，所以这是双重保险）。
  // 展示标签页（聊天/调研）和异步获取标签页（文档/归档）。
  if (!_libScrollBound) {
    _libScrollBound = true;
    let _tick = false;
    const _maybeAutoLoad = () => {
      _tick = false;
      if (!_libraryOpen) return;
      for (const btn of document.querySelectorAll('.doclib-inline-load-more')) {
        if (btn.dataset.autoLoaded) continue;
        if (!btn.offsetParent) continue;   // inactive tab (hidden)
        if (btn.getBoundingClientRect().top > window.innerHeight + 600) continue;
        btn.dataset.autoLoaded = '1';
        btn.click();
        break;   // one load per scroll tick
      }
    };
    document.addEventListener('scroll', () => {
      if (_tick) return;
      _tick = true;
      requestAnimationFrame(_maybeAutoLoad);
    }, true);
  }

  function libraryCreateCard(doc) {
    const card = document.createElement('div');
    card.className = 'doclib-card memory-item';
    card.dataset.docId = doc.id;
    if (_librarySelectMode && _librarySelectedIds.has(doc.id)) {
      card.classList.add('selected');
    }

    // 选择模式下的复选框
    if (_librarySelectMode) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'memory-select-cb';
      cb.checked = _librarySelectedIds.has(doc.id);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        libraryToggleSelectItem(doc.id);
        card.classList.toggle('selected', _librarySelectedIds.has(doc.id));
        const selectAllEl = document.getElementById('doclib-select-all');
        if (selectAllEl) selectAllEl.checked = _libraryDocs.every(d => _librarySelectedIds.has(d.id));
      });
      card.appendChild(cb);
    }

    // 内容包装器
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;padding-top:4px;';

    // 标题行带版本标记
    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;';
    const titleEl = document.createElement('span');
    titleEl.className = 'memory-item-title';
    titleEl.style.cssText = 'flex:0 1 auto;min-width:0;';
    // 标题旁的语言特定图标（匹配文档类型：
    //  py → Python, md → Markdown, pdf → PDF, js → JavaScript 等）
    // 当语言没有专用字形时使用。
    const _GEN_DOC_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;opacity:0.4;flex-shrink:0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
    const _langSvg = doc.language && doc.language !== 'text'
      ? langIcon(doc.language, 12, { style: 'vertical-align:-2px;margin-right:4px;opacity:0.55;flex-shrink:0;color:currentColor;' })
      : '';
    titleEl.innerHTML = (_langSvg || _GEN_DOC_ICON) + _hlSearch(doc.title || t('library.untitled'));
    titleRow.appendChild(titleEl);
    const verBadge = document.createElement('span');
    verBadge.style.cssText = 'font-size:9px;padding:1px 6px;border-radius:8px;background:color-mix(in srgb, var(--red) 15%, transparent);border:1px solid color-mix(in srgb, var(--red) 40%, transparent);color:var(--red);flex-shrink:0;';
    verBadge.textContent = 'v' + (doc.version_count || 1);
    titleRow.appendChild(verBadge);
    // 箭头推到标题行最右端 — 折叠状态
    // 折叠时不显示内容，展开后显示向下箭头，以便用户
    // 看到卡片已打开并可以点击关闭它。
    const chevron = document.createElement('span');
    chevron.className = 'doclib-card-chevron';
    chevron.style.marginLeft = 'auto';
    chevron.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    titleRow.appendChild(chevron);
    content.appendChild(titleRow);

    // 元信息行：会话 → [语言图标 语言] → 时间
    const meta = document.createElement('div');
    meta.className = 'memory-item-meta';
    meta.style.cssText = 'font-size:10px;opacity:0.55;margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
    const _esc = (s) => uiModule.esc(String(s || ''));
    const pieces = [];
    if (doc.session_name) pieces.push(`<span>${_esc(doc.session_name)}</span>`);
    if (doc.language && doc.language !== 'text') {
      // 每种语言的图标在标题行上方显示；元信息行中仅显示语言名称，以保持行紧凑。
      // 每种语言的图标在标题行上方显示；元信息行中仅显示语言名称，以保持行紧凑。
      pieces.push(`<span>${_esc(doc.language)}</span>`);
    }
    pieces.push(`<span>${_esc(libraryRelativeTime(doc.updated_at))}</span>`);
    meta.innerHTML = pieces.join('<span style="opacity:0.5;">\u00b7</span>');
    content.appendChild(meta);
    card.appendChild(content);

    // 头部元素（保留以兼容展开/预览）
    const header = document.createElement('div');
    header.className = 'doclib-card-header';
    header.style.display = 'none';

    // 操作按钮 — "..." 菜单
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'memory-item-actions';
    const menuWrap = document.createElement('span');
    menuWrap.className = 'doclib-card-menu-wrap';
    menuWrap.style.position = 'relative';
    const menuBtn = document.createElement('button');
    menuBtn.className = 'memory-item-btn';
    menuBtn.title = 'Actions';
    menuBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 移动端：自定义 5 项下拉菜单太拥挤 — 改用原生上下文菜单
      // （iOS/Android 显示复制/选择/分享/取消）。
      // 重量级操作（归档、删除、导出）在批量模式下进行。
      if (window.innerWidth <= 768) {
        const items = [];
        if (doc.session_id) items.push({ label: t('common.open'), action: () => libraryOpenInSession(doc) });
        items.push({ label: t('library.clone'), action: () => libraryImportDocument(doc) });
        _showLibDropdown(menuBtn, items, { onSelect: () => {
          libraryEnterSelectMode();
          _librarySelectedIds.add(doc.id);
          libraryUpdateBulkCount();
          libraryRenderGrid();
        } });
        return;
      }
      const dropdown = menuWrap.querySelector('.doclib-card-dropdown') || document.body.querySelector('.doclib-card-dropdown[data-owner="' + CSS.escape(doc.id) + '"]');
      if (dropdown) {
        const isOpen = dropdown.style.display !== 'none' && dropdown.parentElement === document.body;
        if (isOpen) {
          hideCardDropdown();
        } else {
          // 固定定位在 body 上以逃避溢出裁剪
          const rect = menuBtn.getBoundingClientRect();
          document.body.appendChild(dropdown);
          dropdown.dataset.owner = doc.id;
          dropdown.style.cssText = 'position:fixed;z-index:10000;min-width:0;width:max-content;padding:4px;background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.3);backdrop-filter:blur(12px);font-size:12px;display:block;';
          dropdown.style.top = (rect.bottom + 4) + 'px';
          dropdown.style.left = 'auto';
          dropdown.style.right = (window.innerWidth - rect.right) + 'px';
          // 限制在视口内
          requestAnimationFrame(() => {
            const mr = dropdown.getBoundingClientRect();
            if (mr.bottom > window.innerHeight - 8) dropdown.style.top = (rect.top - mr.height - 4) + 'px';
            if (mr.left < 8) { dropdown.style.left = '8px'; dropdown.style.right = 'auto'; }
          });
          // 点击外部或按 Escape 关闭（后者通过注册表）。
          _cardDocClick = (ev) => {
            if (!dropdown.contains(ev.target) && !menuWrap.contains(ev.target)) hideCardDropdown();
          };
          setTimeout(() => document.addEventListener('click', _cardDocClick, true), 0);
          _cardUnreg = registerMenuDismiss(hideCardDropdown);
        }
      }
    });
    menuWrap.appendChild(menuBtn);

    // 下拉菜单
    const dropdown = document.createElement('div');
    dropdown.className = 'doclib-card-dropdown';
    dropdown.style.cssText = 'display:none;position:absolute;top:100%;right:0;z-index:1000;min-width:0;width:max-content;padding:4px;background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.3);backdrop-filter:blur(12px);font-size:12px;';

    // 卡片操作下拉菜单的单一关闭路径，由切换按钮
    // 和外部点击监听器共享。
    // 调解器（通过 registerMenuDismiss）。隐藏菜单、将其返回其
    // 包装器、移除外部点击监听器，并从
    // Escape 栈。幂等 — 无论哪个路径先触发都可以安全调用。
    let _cardUnreg = () => {};
    let _cardDocClick = null;
    function hideCardDropdown() {
      _cardUnreg(); _cardUnreg = () => {};
      if (_cardDocClick) { document.removeEventListener('click', _cardDocClick, true); _cardDocClick = null; }
      dropdown.style.display = 'none';
      if (dropdown.parentElement === document.body) menuWrap.appendChild(dropdown);
    }
    dropdown._dismiss = hideCardDropdown;   // bulk removers tear down through this

    const _di = (svg) => `<span class="dropdown-icon">${svg}</span>`;
    const _openIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

    // 打开
    const openItem = document.createElement('button');
    openItem.className = 'dropdown-item-compact';
    openItem.style.cssText = 'background:none;border:none;width:100%;';
    openItem.innerHTML = _di(_openIco) + '<span>Open</span>';
    if (doc.session_id) {
      openItem.addEventListener('click', (e) => { e.stopPropagation(); hideCardDropdown(); libraryOpenInSession(doc); });
    } else {
      // 已分离的文档（已关闭/会话已分离）仍然可以在编辑器中打开
      // 通过 id — libraryOpenDocument 处理无会话的情况 (#1602)。
      openItem.title = t('library.open_in_editor');
      openItem.addEventListener('click', (e) => { e.stopPropagation(); hideCardDropdown(); libraryOpenDocument(doc); });
    }
    dropdown.appendChild(openItem);

    // 克隆
    const _cloneIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const cloneItem = document.createElement('button');
    cloneItem.className = 'dropdown-item-compact';
    cloneItem.style.cssText = 'background:none;border:none;width:100%;';
    cloneItem.innerHTML = _di(_cloneIco) + '<span>Clone</span>';
    cloneItem.title = 'Clone to active session';
    cloneItem.addEventListener('click', (e) => { e.stopPropagation(); hideCardDropdown(); libraryImportDocument(doc); });
    dropdown.appendChild(cloneItem);

    // 导出
    const _exportIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    const exportItem = document.createElement('button');
    exportItem.className = 'dropdown-item-compact';
    exportItem.style.cssText = 'background:none;border:none;width:100%;';
    exportItem.innerHTML = _di(_exportIco) + '<span>Export</span>';
    exportItem.addEventListener('click', async (e) => {
      e.stopPropagation();
      hideCardDropdown();
      try {
        const res = await fetch(`${API_BASE}/api/document/${doc.id}`);
        if (!res.ok) throw new Error('Failed');
        const full = await res.json();
        const extMap = { javascript: '.js', python: '.py', html: '.html', css: '.css', markdown: '.md', json: '.json', yaml: '.yml', bash: '.sh', sql: '.sql', rust: '.rs', go: '.go', java: '.java', c: '.c', cpp: '.cpp', typescript: '.ts', ruby: '.rb', php: '.php', xml: '.xml', toml: '.toml', ini: '.ini' };
        const ext = extMap[full.language] || '.txt';
        const blob = new Blob([full.current_content || ''], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (full.title || 'document') + ext;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch { if (uiModule) uiModule.showError('Failed to export document'); }
    });
    dropdown.appendChild(exportItem);

    // 归档 / 恢复 — 将文档软归档移出主列表，或将其恢复回来。
    const _archiveIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
    const archiveItem = document.createElement('button');
    archiveItem.className = 'dropdown-item-compact';
    archiveItem.style.cssText = 'background:none;border:none;width:100%;';
    archiveItem.innerHTML = _di(_archiveIco) + `<span>${_libraryArchivedView ? 'Restore' : 'Archive'}</span>`;
    archiveItem.title = _libraryArchivedView ? 'Restore to active documents' : t('library.archive_hide');
    archiveItem.addEventListener('click', async (e) => {
      e.stopPropagation();
      hideCardDropdown();
      const toArchived = !_libraryArchivedView;
      try {
        const res = await fetch(`${API_BASE}/api/document/${doc.id}/archive?archived=${toArchived}`, { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) throw new Error('failed');
        // 从当前视图移除（它已不属于这里）并刷新。
        libraryRemoveDocumentFromState(doc.id);
        libraryRenderGrid();
        if (uiModule) uiModule.showToast(toArchived ? t('library.archived') : 'Restored');
      } catch { if (uiModule) uiModule.showError('Failed to ' + (toArchived ? 'archive' : 'restore')); }
    });
    dropdown.appendChild(archiveItem);

    // 删除
    const _deleteIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
    const deleteItem = document.createElement('button');
    deleteItem.className = 'dropdown-item-compact dropdown-item-danger';
    deleteItem.style.cssText = 'background:none;border:none;width:100%;';
    deleteItem.innerHTML = _di(_deleteIco) + '<span>Delete</span>';
    deleteItem.addEventListener('click', (e) => { e.stopPropagation(); hideCardDropdown(); libraryDeleteSingle(doc.id, card); });
    dropdown.appendChild(deleteItem);

    menuWrap.appendChild(dropdown);
    actionsWrap.appendChild(menuWrap);
    card.appendChild(actionsWrap);

    // 隐藏的头部，用于兼容展开/预览
    card.appendChild(header);

    // 注入库卡片悬停样式（仅一次）
    if (!document.getElementById('doclib-card-styles')) {
      const s = document.createElement('style');
      s.id = 'doclib-card-styles';
      s.textContent = `.doclib-card:hover .doclib-card-icon-btn{opacity:.4}.doclib-card-icon-btn:hover{opacity:1!important}.doclib-card-text-btn{background:none;border:1px solid var(--border);color:var(--fg-muted);font-size:10px;padding:3px 8px;border-radius:4px;cursor:pointer;transition:border-color .15s,color .15s}.doclib-card-text-btn:hover{border-color:var(--accent,var(--red));color:var(--accent,var(--red))}.doclib-card-text-btn-danger{border-color:var(--color-danger,#e06c75)!important;color:var(--color-danger,#e06c75)!important}.doclib-card-text-btn-danger:hover{border-color:#ff4d4d!important;color:#ff4d4d!important}.doclib-card-chevron{display:none;align-items:center;justify-content:center;align-self:center;opacity:0.6;transition:transform .15s ease;flex-shrink:0;height:14px;line-height:0}.doclib-card-expanded .doclib-card-chevron{display:inline-flex;transform:rotate(180deg)}.doclib-card-chevron svg{display:block}`;
      document.head.appendChild(s);
    }

    // 预览 — 默认隐藏，展开时显示
    const preview = document.createElement('div');
    preview.className = 'doclib-card-preview';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    try {
      if (doc.language && doc.language !== 'text' && window.hljs && !_librarySearch) {
        code.innerHTML = window.hljs.highlight(doc.preview || '', { language: doc.language }).value;
      } else if (_librarySearch) {
        // 搜索时，在预览中高亮匹配的词条（纯文本方式，不进行语法着色）。
        // 搜索时，在预览中高亮匹配的词条（纯文本方式，不进行语法着色）。
        code.innerHTML = _hlSearch(doc.preview || '');
      } else {
        code.textContent = doc.preview || '';
      }
    } catch {
      code.textContent = doc.preview || '';
    }
    pre.appendChild(code);
    preview.appendChild(pre);

    // 仅展开时显示的操作栏 — 在预览内
    const expandedActions = document.createElement('div');
    expandedActions.className = 'doclib-card-expanded-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'doclib-card-text-btn doclib-card-action-btn';
    openBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><path d="M5 12h14M13 5l7 7-7 7"/></svg>Open';
    if (doc.session_id) {
      openBtn.title = t('library.open_in_session');
      openBtn.addEventListener('click', (e) => { e.stopPropagation(); libraryOpenInSession(doc); });
    } else {
      // 已分离的文档（已关闭/会话已分离）仍然可以在编辑器中打开
      // 通过 id — libraryOpenDocument 处理无会话的情况 (#1602)。
      openBtn.title = t('library.open_in_editor');
      openBtn.addEventListener('click', (e) => { e.stopPropagation(); libraryOpenDocument(doc); });
    }

    const cloneBtn = document.createElement('button');
    cloneBtn.className = 'doclib-card-text-btn doclib-card-action-btn';
    cloneBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Clone';
    cloneBtn.title = 'Clone — copy to active session';
    cloneBtn.addEventListener('click', (e) => { e.stopPropagation(); libraryImportDocument(doc); });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'doclib-card-text-btn doclib-card-action-btn doclib-card-text-btn-danger';
    deleteBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>Delete';
    deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); libraryDeleteSingle(doc.id, card); });

    // 归档紧挨删除按钮放在左侧 — 与聊天预览底部栏相同的排列。
    // 归档紧挨删除按钮放在左侧 — 与聊天预览底部栏相同的排列。
    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'doclib-card-text-btn doclib-card-action-btn';
    archiveBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>' + (_libraryArchivedView ? 'Restore' : 'Archive');
    archiveBtn.title = _libraryArchivedView ? 'Restore to active documents' : t('library.archive_hide');
    archiveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const toArchived = !_libraryArchivedView;
      try {
        const res = await fetch(`${API_BASE}/api/document/${doc.id}/archive?archived=${toArchived}`, { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) throw new Error('failed');
        libraryRemoveDocumentFromState(doc.id);
        libraryRenderGrid();
        if (uiModule) uiModule.showToast(toArchived ? t('library.archived') : 'Restored');
      } catch { if (uiModule) uiModule.showError('Failed to ' + (toArchived ? 'archive' : 'restore')); }
    });

    const leftGroup = document.createElement('div');
    leftGroup.className = 'doclib-action-group';
    const btnRow = document.createElement('div');
    btnRow.className = 'doclib-action-btn-row';
    // 导出 lives in the ⋮ menu — keep the footer uncrowded with Clone + Open.
    btnRow.appendChild(cloneBtn);
    btnRow.appendChild(openBtn);
    leftGroup.appendChild(btnRow);
    // 删除 furthest LEFT, then Archive; Open/Clone group on the RIGHT.
    // 将删除/归档对向左微调 8px 以对齐。
    deleteBtn.style.cssText += ';position:relative;left:-8px;';
    archiveBtn.style.cssText += ';position:relative;left:-8px;';
    expandedActions.appendChild(deleteBtn);
    expandedActions.appendChild(archiveBtn);
    expandedActions.appendChild(leftGroup);

    preview.appendChild(expandedActions);
    card.appendChild(preview);

    card.addEventListener('click', () => {
      if (card._suppressNextClick) { card._suppressNextClick = false; return; }
      if (_librarySelectMode) {
        const cb = card.querySelector('.memory-select-cb');
        if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
      } else {
        libraryExpandCard(card, doc);
      }
    });
    _attachLongPressMenu(card, '.memory-item-btn');
    return card;
  }

  async function libraryExpandCard(card, doc) {
    const grid = card.closest('.doclib-grid');
    const instant = card?.dataset?.spaceToggle === '1';

    // 已展开 — 折叠
    if (card.classList.contains('doclib-card-expanded')) {
      _collapseExpandedCard(card);
      return;
    }

    // 折叠其他已展开的卡片
    if (grid) {
      grid.querySelectorAll('.doclib-card-expanded').forEach(c => _collapseExpandedCard(c));
    }

    // 在 CSS display:none 生效前淡出兄弟节点
    const siblings = grid ? [...grid.querySelectorAll('.doclib-card')].filter(c => c !== card) : [];
    // 强制设置明确的起始透明度，以便首次过渡生效
    siblings.forEach(s => { s.style.opacity = '1'; });
    // 强制回流以使浏览器记录起始值
    if (!instant) {
      if (siblings.length) siblings[0].offsetHeight;
      siblings.forEach(s => { s.style.transition = 'opacity 0.12s ease'; s.style.opacity = '0'; });
    }

    // 捕获完整的网格 + 工具栏高度，以便弹窗在整个过渡期间保持
    // 相同的可视高度。
    // 网格占据所有可用空间 — 在此跳过高度锁定。
    const isMobile = window.innerWidth <= 768;
    const toolbar = grid ? grid.closest('.admin-card')?.querySelector('.memory-toolbar') : null;
    const toolbarH = toolbar ? toolbar.offsetHeight : 0;
    if (grid && !isMobile) {
      grid.style.minHeight = (grid.offsetHeight + toolbarH) + 'px';
      grid.style.maxHeight = (grid.offsetHeight + toolbarH) + 'px';
    }

    // 等待淡出完成，然后展开
    if (!instant) await new Promise(r => setTimeout(r, 120));

    card.classList.add('doclib-card-expanded');
    if (grid) grid.scrollTop = 0;

    // 清理兄弟节点的内联样式（现在由 CSS display:none 接管）
    siblings.forEach(s => { s.style.transition = ''; s.style.opacity = ''; });

    // 将完整内容加载到预览区域
    const preview = card.querySelector('.doclib-card-preview');
    if (!preview) return;

    const actionsBar = preview.querySelector('.doclib-card-expanded-actions');
    const existingPre = preview.querySelector('pre');

    try {
      const res = await fetch(`${API_BASE}/api/document/${doc.id}`);
      if (!res.ok) throw new Error('Failed');
      const full = await res.json();
      const content = full.current_content || '';
      const lang = full.language || doc.language || 'text';

      // 基于 PDF 的文档在其 markdown 中有标记注释 — 显示
      // 文件名 + 帮助文本，而非原始二进制噪音。
      const isPdfDoc = /<!--\s*pdf_(?:form_)?source\s+upload_id="[^"]+"/.test(content);
      const existingFrame = preview.querySelector('.doclib-card-pdf-frame');

      if (isPdfDoc) {
        const frame = document.createElement('iframe');
        frame.className = 'doclib-card-pdf-frame';
        frame.src = `${API_BASE}/api/document/${doc.id}/render-pdf?t=${Date.now()}`;
        frame.style.cssText = 'width:100%;height:60vh;border:1px solid var(--border);border-radius:6px;background:var(--bg);opacity:0;transition:opacity 0.15s ease;';
        if (existingPre) existingPre.remove();
        if (existingFrame) existingFrame.remove();
        preview.insertBefore(frame, preview.firstChild);
        if (actionsBar && !preview.contains(actionsBar)) preview.appendChild(actionsBar);
        requestAnimationFrame(() => { frame.style.opacity = '1'; });
        return;
      }

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      // 语法高亮是同步的且复杂度为 O(n) — 对整个
      // 10 万+ 行文件运行会阻塞 UI。限制为前 15000 行和
      // 合理的字节上限。
      // 已显示）以便预览立即打开。Markdown 本来就没多少语法高亮可看，
      // 所以跳过它。
      const HL_CAP = 20000;
      try {
        if (lang && lang !== 'text' && lang !== 'markdown' && window.hljs && content.length <= HL_CAP) {
          code.innerHTML = window.hljs.highlight(content, { language: lang }).value;
        } else {
          code.textContent = content;
        }
      } catch {
        code.textContent = content;
      }
      pre.appendChild(code);

      // 切换内容 — 淡入完整版本
      if (existingPre) existingPre.remove();
      if (existingFrame) existingFrame.remove();
      pre.style.opacity = '0';
      preview.insertBefore(pre, preview.firstChild);
      if (actionsBar && !preview.contains(actionsBar)) preview.appendChild(actionsBar);
      requestAnimationFrame(() => {
        pre.style.transition = 'opacity 0.15s ease';
        pre.style.opacity = '1';
      });
    } catch (e) {
      // 出错时，如果可用则保留现有预览
      if (!existingPre) {
        preview.innerHTML = '<div style="padding:8px;color:var(--color-error);font-size:10px;">Failed to load</div>';
      }
      if (actionsBar && !preview.contains(actionsBar)) preview.appendChild(actionsBar);
    }
  }

  function libraryRenderLoadMore() {
    // 文档现在通过行内"加载更多"按钮每次展示 20 条；
    // 此处无需额外操作 — 上面的渲染步骤已经插入了按钮。
    // 此处无需额外操作 — 上面的渲染步骤已经插入了按钮。
    // 控制和意外的自动加载。
    const legacy = document.getElementById('doclib-load-more');
    if (legacy) legacy.style.display = 'none';
  }

  async function libraryOpenDocument(doc) {
    closeLibrary();
    // 已分离的文档（会话已删除）— 仅在编辑器中打开而不切换会话
    if (!doc.session_id) {
      _loadDocument(doc.id);
      return;
    }
    const currentSessionId = sessionModule && sessionModule.getCurrentSessionId();
    if (doc.session_id !== currentSessionId) {
      await sessionModule.selectSession(doc.session_id);
    }
    _loadDocument(doc.id);
  }

  /** Open a document in its linked session */
  async function libraryOpenInSession(doc) {
    if (!doc.session_id) return;
    closeLibrary();

    // 第 1 步：如有需要则切换会话并等待加载
    const currentSessionId = sessionModule && sessionModule.getCurrentSessionId();
    if (doc.session_id !== currentSessionId) {
      await sessionModule.selectSession(doc.session_id);
      // 给会话 UI 一点时间稳定下来
      await new Promise(r => setTimeout(r, 150));
    }

    // 第 2 步：确保文档在标签页中
    const docs = _getDocs();
    if (!docs.has(doc.id)) {
      const res = await fetch(`${API_BASE}/api/document/${doc.id}`);
      if (res.ok) {
        const full = await res.json();
        _addDocToTabs(full, doc.session_id);
      }
    }

    // 第 3 步：打开面板（滑入由 openPanel 处理）
    if (!_isOpenFn()) _openPanel();

    _switchToDoc(doc.id);
    _syncDocIndicator();
  }

  /** Copy a document from the library into the current session */
  async function libraryImportDocument(doc) {
    let sessionId = sessionModule && sessionModule.getCurrentSessionId();
    if (!sessionId) {
      // 如果不存在则创建新会话
      if (sessionModule && sessionModule.hasPendingChat && sessionModule.hasPendingChat()) {
        const ok = await sessionModule.materializePendingSession();
        if (ok) sessionId = sessionModule.getCurrentSessionId();
      }
      if (!sessionId) {
        // 也没有待处理的聊天 — 触发新会话，保留当前模型
        const curModel = sessionModule.getCurrentModel ? sessionModule.getCurrentModel() : null;
        const sessions = sessionModule ? sessionModule.getSessions() : [];
        // 优先选择匹配当前模型的会话，否则回退到第一个有模型的会话
        const withModel = sessions.filter(s => s.endpoint_url && s.model);
        const match = (curModel && withModel.find(s => s.model === curModel)) || withModel[0];
        if (match) {
          sessionModule.createDirectChat(match.endpoint_url, match.model, match.endpoint_id);
          const ok = await sessionModule.materializePendingSession();
          if (ok) sessionId = sessionModule.getCurrentSessionId();
        }
      }
      if (!sessionId) {
        if (uiModule) uiModule.showError('Could not create a session');
        return;
      }
    }
    try {
      // 获取源文档的完整内容
      const srcRes = await fetch(`${API_BASE}/api/document/${doc.id}`);
      if (!srcRes.ok) throw new Error('Failed to fetch document');
      const src = await srcRes.json();

      // 标题去重 — 如果名称已在会话中存在，则追加 (2)、(3) 等后缀
      let baseTitle = src.title || doc.title || t('library.untitled');
      const existingTitles = new Set();
      const docs = _getDocs();
      for (const [, d] of docs) {
        if (d.sessionId === sessionId && d.title) existingTitles.add(d.title);
      }
      if (existingTitles.has(baseTitle)) {
        // 剥离已有的 (N) 后缀以获取基础名称
        const root = baseTitle.replace(/\s*\(\d+\)$/, '');
        let n = 2;
        while (existingTitles.has(root + ' (' + n + ')')) n++;
        baseTitle = root + ' (' + n + ')';
      }

      // 在当前会话中创建新的文档副本
      const res = await fetch(`${API_BASE}/api/document`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          // 保留源文档的类型；未知时默认为 markdown
          // （后端也会嗅探，但这样可以保持标签页标签正确）。
          language: src.language || doc.language || 'markdown',
          content: src.current_content || '',
        }),
      });
      if (!res.ok) throw new Error('Failed to create document');
      const created = await res.json();
      closeLibrary();
      _addDocToTabs(created, sessionId);
      if (!_isOpenFn()) _openPanel();

      _switchToDoc(created.id);
      _syncDocIndicator();
      if (uiModule) uiModule.showToast('Document cloned to session');
    } catch (e) {
      console.error('Failed to import document:', e);
      if (uiModule) uiModule.showError('Failed to import document');
    }
  }

  // ---- 库批量操作 ----

  function libraryEnterSelectMode() {
    _librarySelectMode = true;
    _librarySelectedIds.clear();
    const bulkBar = document.getElementById('doclib-bulk-bar');
    const selectBtn = document.getElementById('doclib-select-btn');
    if (bulkBar) bulkBar.classList.remove('hidden');
    if (selectBtn) { selectBtn.classList.add('active'); selectBtn.textContent = t('common.cancel'); }
    libraryUpdateBulkCount();
    libraryRenderGrid();
  }

  function libraryExitSelectMode() {
    _librarySelectMode = false;
    _librarySelectedIds.clear();
    const bulkBar = document.getElementById('doclib-bulk-bar');
    const selectBtn = document.getElementById('doclib-select-btn');
    const selectAll = document.getElementById('doclib-select-all');
    if (bulkBar) bulkBar.classList.add('hidden');
    if (selectBtn) { selectBtn.classList.remove('active'); selectBtn.textContent = t('library.select'); }
    if (selectAll) selectAll.checked = false;
    libraryRenderGrid();
  }

  function libraryToggleSelectItem(id) {
    if (_librarySelectedIds.has(id)) {
      _librarySelectedIds.delete(id);
    } else {
      _librarySelectedIds.add(id);
    }
    libraryUpdateBulkCount();
  }

  function libraryToggleSelectAll() {
    const selectAllEl = document.getElementById('doclib-select-all');
    if (!selectAllEl) return;
    if (selectAllEl.checked) {
      _libraryDocs.forEach(d => _librarySelectedIds.add(d.id));
    } else {
      _librarySelectedIds.clear();
    }
    libraryUpdateBulkCount();
    libraryRenderGrid();
  }

  function libraryUpdateBulkCount() {
    const countEl = document.getElementById('doclib-selected-count');
    const actionsBtn = document.getElementById('doclib-bulk-actions');
    if (countEl) countEl.textContent = `${t('library.selected_n', { n: _librarySelectedIds.size })}`;
    if (actionsBtn) actionsBtn.style.color = _librarySelectedIds.size > 0 ? 'var(--fg)' : '';
    // 旧版每操作按钮不再渲染 — 守卫确保方法的其余部分仍能正常工作。
    // 旧版每操作按钮不再渲染 — 守卫确保方法的其余部分仍能正常工作。
    const deleteBtn = document.getElementById('doclib-bulk-delete');
    const exportBtn = document.getElementById('doclib-bulk-export');
    const archiveBtn = document.getElementById('doclib-bulk-archive');
    const cloneBtn = document.getElementById('doclib-bulk-clone');
    if (deleteBtn) deleteBtn.disabled = _librarySelectedIds.size === 0;
    if (exportBtn) exportBtn.disabled = _librarySelectedIds.size === 0;
    if (cloneBtn) cloneBtn.disabled = _librarySelectedIds.size === 0;
    if (archiveBtn) {
      archiveBtn.disabled = _librarySelectedIds.size === 0;
      archiveBtn.textContent = _libraryArchivedView ? 'Restore' : 'Archive';
    }
  }

  async function libraryDeleteSingle(docId, card) {
    if (uiModule && uiModule.styledConfirm) {
      const ok = await uiModule.styledConfirm(t('library.delete_document_confirm'), { confirmText: t('common.delete'), danger: true });
      if (!ok) return;
    } else if (!confirm('Delete this document?')) {
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/document/${docId}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.detail) detail = j.detail; } catch {}
        throw new Error(detail);
      }
      if (card) {
        card.classList.add('doclib-card-deleting');
        card.addEventListener('transitionend', () => card.remove(), { once: true });
        setTimeout(() => { if (card.parentElement) card.remove(); }, 400);
      }
      libraryRemoveDocumentFromState(docId);
      if (uiModule) uiModule.showToast('Document deleted');
    } catch (e) {
      if (uiModule) uiModule.showError(`Failed to delete document: ${e.message || e}`);
    }
  }

  async function libraryBulkDelete() {
    if (_librarySelectedIds.size === 0) return;
    const count = _librarySelectedIds.size;
    if (uiModule && uiModule.styledConfirm) {
      const ok = await uiModule.styledConfirm(
        t('library.delete_documents_confirm', { n: count }),
        { confirmText: t('common.delete'), danger: true }
      );
      if (!ok) return;
    } else if (!confirm(t('library.delete_documents_confirm', { n: count }))) {
      return;
    }

    let deleted = 0;
    let failed = 0;
    const deletedIds = [];
    for (const id of _librarySelectedIds) {
      try {
        const res = await fetch(`${API_BASE}/api/document/${id}`, { method: 'DELETE', credentials: 'same-origin' });
        if (res.ok) {
          deleted++;
          deletedIds.push(id);
        }
        else { failed++; console.warn('Delete failed for', id, 'status', res.status); }
      } catch (e) {
        failed++;
        console.error('Failed to delete document:', id, e);
      }
    }

    for (const id of deletedIds) {
      const card = document.querySelector(`.doclib-card[data-doc-id="${CSS.escape(String(id))}"]`);
      if (card) card.classList.add('doclib-card-deleting');
    }
    if (deletedIds.length) await new Promise(r => setTimeout(r, 320));
    libraryExitSelectMode();
    await libraryFetch(false);
    if (uiModule) {
      const msg = failed > 0
        ? `Deleted ${deleted} · ${failed} failed`
        : `Deleted ${deleted} document${deleted !== 1 ? 's' : ''}`;
      (failed > 0 ? uiModule.showError : uiModule.showToast)(msg);
    }
  }

  async function libraryBulkArchive() {
    if (_librarySelectedIds.size === 0) return;
    const toArchived = !_libraryArchivedView;
    const ids = [..._librarySelectedIds];
    let done = 0, failed = 0;
    for (const id of ids) {
      try {
        const res = await fetch(`${API_BASE}/api/document/${id}/archive?archived=${toArchived}`, { method: 'POST', credentials: 'same-origin' });
        if (res.ok) done++; else failed++;
      } catch { failed++; }
    }
    libraryExitSelectMode();
    await libraryFetch(false);
    if (uiModule) {
      const verb = toArchived ? t('library.archived') : 'Restored';
      const msg = failed > 0 ? `${verb} ${done} · ${failed} failed` : `${verb} ${done} document${done !== 1 ? 's' : ''}`;
      (failed > 0 ? uiModule.showError : uiModule.showToast)(msg);
    }
  }

  // 批量"克隆" — 为每个选中的文档复用 libraryImportDocument。
  // 它会处理会话解析 + 可能创建一次新会话
  // （后续克隆进入同一会话，与画廊行为一致）。
  async function libraryBulkClone() {
    if (_librarySelectedIds.size === 0) return;
    const ids = [..._librarySelectedIds];
    let done = 0, failed = 0;
    for (const id of ids) {
      const doc = _libraryDocs.find(d => d.id === id);
      if (!doc) { failed++; continue; }
      try {
        const ok = await libraryImportDocument(doc);
        if (ok === false) failed++; else done++;
      } catch { failed++; }
    }
    libraryExitSelectMode();
    if (uiModule) {
      const msg = failed > 0
        ? `Cloned ${done} · ${failed} failed`
        : `Cloned ${done} document${done !== 1 ? 's' : ''}`;
      (failed > 0 ? uiModule.showError : uiModule.showToast)(msg);
    }
  }

  async function libraryBulkExport() {
    if (_librarySelectedIds.size === 0) return;
    // 超过 5 个 → 一个服务器端构建的 .zip（镜像画廊的批量导出；
    // 避免浏览器在数十个并发 ZIP 构建时崩溃）。
    if (_librarySelectedIds.size > 5) {
      const ids = [..._librarySelectedIds];
      try {
        if (uiModule) uiModule.showToast(t('library.zipping', { n: ids.length }));
        const res = await fetch(`${API_BASE}/api/documents/export-zip`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (!res.ok) throw new Error('zip failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'documents.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        if (uiModule) uiModule.showToast(t('library.exported_zip', { n: ids.length }));
      } catch (e) {
        if (uiModule) uiModule.showError('Failed to create zip');
      }
      return;
    }
    const extMap = {
      javascript: '.js', python: '.py', html: '.html', css: '.css',
      markdown: '.md', json: '.json', yaml: '.yml', bash: '.sh',
      sql: '.sql', rust: '.rs', go: '.go', java: '.java', c: '.c', cpp: '.cpp',
      typescript: '.ts', ruby: '.rb', php: '.php', text: '.txt',
      xml: '.xml', toml: '.toml', ini: '.ini',
    };

    const docs = await Promise.all([..._librarySelectedIds].map(async id => {
      try {
        const res = await fetch(`${API_BASE}/api/document/${id}`);
        if (!res.ok) return null;
        return await res.json();
      } catch (e) {
        console.error('Failed to export document:', id, e);
        return null;
      }
    }));
    for (const doc of docs) {
      if (!doc) continue;
      const ext = extMap[doc.language] || '.txt';
      const filename = (doc.title || 'document') + (doc.title && doc.title.includes('.') ? '' : ext);
      const blob = new Blob([doc.current_content || ''], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }
    if (uiModule) uiModule.showToast(t('library.exported_n', { n: _librarySelectedIds.size }));
  }

  /** Lazy-load SheetJS for spreadsheet parsing */
  let _xlsxReady = null;
  function ensureXLSX() {
    if (_xlsxReady) return _xlsxReady;
    if (window.XLSX) return (_xlsxReady = Promise.resolve());
    _xlsxReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/static/lib/xlsx.full.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load XLSX library'));
      document.head.appendChild(s);
    });
    return _xlsxReady;
  }

  let _mammothReady = null;
  function ensureMammoth() {
    if (_mammothReady) return _mammothReady;
    if (window.mammoth) return (_mammothReady = Promise.resolve());
    _mammothReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/static/lib/mammoth.browser.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load DOCX library'));
      document.head.appendChild(s);
    });
    return _mammothReady;
  }

  /** Convert HTML from mammoth to clean markdown */
  function htmlToMarkdown(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let md = '';
    function walk(node) {
      if (node.nodeType === 3) { md += node.textContent; return; }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'h1') { md += '\n# '; walkChildren(node); md += '\n'; }
      else if (tag === 'h2') { md += '\n## '; walkChildren(node); md += '\n'; }
      else if (tag === 'h3') { md += '\n### '; walkChildren(node); md += '\n'; }
      else if (tag === 'h4') { md += '\n#### '; walkChildren(node); md += '\n'; }
      else if (tag === 'strong' || tag === 'b') { md += '**'; walkChildren(node); md += '**'; }
      else if (tag === 'em' || tag === 'i') { md += '*'; walkChildren(node); md += '*'; }
      else if (tag === 'a') { md += '['; walkChildren(node); md += `](${node.href || ''})`; }
      else if (tag === 'br') { md += '\n'; }
      else if (tag === 'p') { md += '\n'; walkChildren(node); md += '\n'; }
      else if (tag === 'ul' || tag === 'ol') { md += '\n'; walkChildren(node); }
      else if (tag === 'li') {
        const parent = node.parentElement?.tagName?.toLowerCase();
        if (parent === 'ol') {
          const idx = Array.from(node.parentElement.children).indexOf(node) + 1;
          md += `${idx}. `;
        } else { md += '- '; }
        walkChildren(node);
        md += '\n';
      }
      else if (tag === 'table') { md += '\n'; convertTable(node); md += '\n'; }
      else if (tag === 'img') {
        // 跳过嵌入的 base64 图片 — 它们会产生巨大且不可读的数据块
        const src = node.src || '';
        if (!src.startsWith('data:')) {
          md += `![${node.alt || ''}](${src})`;
        } else if (node.alt) {
          md += `*[image: ${node.alt}]*`;
        }
      }
      else { walkChildren(node); }
    }
    function walkChildren(node) { for (const child of node.childNodes) walk(child); }
    function convertTable(table) {
      const rows = table.querySelectorAll('tr');
      rows.forEach((tr, i) => {
        const cells = tr.querySelectorAll('th, td');
        md += '| ' + Array.from(cells).map(c => c.textContent.trim()).join(' | ') + ' |\n';
        if (i === 0) md += '| ' + Array.from(cells).map(() => '---').join(' | ') + ' |\n';
      });
    }
    walkChildren(doc.body);
    return md.replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Read file contents — handles text, spreadsheet, and DOCX formats */
  async function readFileContent(file) {
    const name = file.name.toLowerCase();
    const isSpreadsheet = name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.ods');
    const isDocx = name.endsWith('.docx');

    if (isSpreadsheet) {
      await ensureXLSX();
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      // 将每个工作表转换为 CSV，每个工作表用一个标题连接
      const parts = [];
      for (const sheetName of wb.SheetNames) {
        if (wb.SheetNames.length > 1) parts.push(`# Sheet: ${sheetName}`);
        parts.push(window.XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]));
      }
      return parts.join('\n\n');
    }

    if (isDocx) {
      await ensureMammoth();
      const buf = await file.arrayBuffer();
      const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
      return htmlToMarkdown(result.value);
    }

    // 纯文本
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  /** Import files from disk into the document library */
  async function libraryImportFiles(fileList) {
    const EXT_TO_LANG = {
      '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
      '.html': 'html', '.htm': 'html', '.css': 'css', '.md': 'markdown',
      '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.sh': 'bash',
      '.bash': 'bash', '.sql': 'sql', '.rs': 'rust', '.go': 'go',
      '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
      '.rb': 'ruby', '.php': 'php', '.xml': 'xml',
      '.toml': 'toml', '.ini': 'ini', '.txt': '', '.log': '',
      '.cfg': 'ini', '.conf': 'ini', '.env': '', '.jsx': 'javascript',
      '.tsx': 'typescript', '.vue': 'html', '.svelte': 'html',
      '.scss': 'css', '.sass': 'css', '.less': 'css',
      '.csv': 'csv', '.tsv': 'csv',
      '.xlsx': 'csv', '.xls': 'csv', '.ods': 'csv',
      '.docx': 'markdown', '.doc': 'markdown',
    };

    let imported = 0;
    let failed = 0;
    let _firstErr = '';

    // 库导入不绑定到某个聊天 — 后端现在接受一个
    // `session_id` 请求体参数，所以我们始终传递当前会话。
    for (const file of fileList) {
      try {
        const name = file.name;
        const dotIdx = name.lastIndexOf('.');
        const ext = dotIdx >= 0 ? name.slice(dotIdx).toLowerCase() : '';
        const baseTitle = dotIdx > 0 ? name.slice(0, dotIdx) : name;
        const language = EXT_TO_LANG[ext] !== undefined ? EXT_TO_LANG[ext] : null;

        const isSpreadsheet = ['.xlsx', '.xls', '.ods'].includes(ext);
        const isPdf = ext === '.pdf';

        if (isPdf) {
          // 后端一次性处理保存 + AcroForm 检测 — 为缩略图条选择
          // 最佳页数/显示方式。
          // 视图，普通 PDF 则获得静态页面图像查看器。
          const fd = new FormData();
          fd.append('file', file);
          const res = await fetch(`${API_BASE}/api/documents/import-pdf`, {
            method: 'POST',
            body: fd,
          });
          if (!res.ok) {
            let _e = `HTTP ${res.status}`;
            try { const _j = await res.json(); _e = _j.detail || _j.error || _e; } catch {}
            throw new Error('PDF import failed: ' + _e);
          }
          imported++;
          continue;
        }

        if (isSpreadsheet) {
          // 多工作表：为每个工作表创建一个文档
          await ensureXLSX();
          const buf = await file.arrayBuffer();
          const wb = window.XLSX.read(buf, { type: 'array' });
          for (const sheetName of wb.SheetNames) {
            const csv = window.XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
            if (!csv.trim()) continue;
            const sheetTitle = wb.SheetNames.length > 1
              ? `${baseTitle} - ${sheetName}` : baseTitle;
            const res = await fetch(`${API_BASE}/api/document`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: sheetTitle, language: 'csv', content: csv }),
            });
            if (!res.ok) throw new Error('Server error');
          }
          imported++;
        } else {
          const content = await readFileContent(file);
          const res = await fetch(`${API_BASE}/api/document`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: baseTitle, language, content }),
          });
          if (!res.ok) throw new Error('Server error');
          imported++;
        }
      } catch (e) {
        console.error('Failed to import file:', file.name, e);
        if (!_firstErr) _firstErr = (e && e.message) || String(e);
        failed++;
      }
    }

    const msg = `Imported ${imported} file${imported !== 1 ? 's' : ''}` +
      (failed ? `, ${failed} failed${_firstErr ? ' — ' + _firstErr : ''}` : '');
    if (failed && uiModule) uiModule.showError(msg);
    else if (uiModule) uiModule.showToast(msg);
    await libraryFetch(false);
  }

  export function openLibrary(opts) {
    if (_libraryOpen) {
      // 从卡住状态恢复：ui.js 中的滑动关闭会添加 .hidden 类到覆盖层，
      // 但如果还没等过渡完成就再次调用 open()，弹窗会保持不可见。
      // 即便弹窗已经消失或不可见，也仍然是 true。检测并重置。
      const existing = document.getElementById('doclib-modal');
      if (!existing || existing.classList.contains('hidden')) {
        if (existing) existing.remove();
        _libraryOpen = false;
      } else {
        return;
      }
    }
    _libraryOpen = true;
    _libraryImportMode = !!(opts && opts.import);
    _librarySelectMode = false;
    _librarySelectedIds.clear();
    _librarySearch = '';
    _libraryActiveLanguage = null;
    _librarySort = 'recent';
    _libraryOffset = 0;
    _libraryDocs = [];

    // 创建弹窗
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'doclib-modal';
    modal.innerHTML = `
      <div class="modal-content doclib-modal-content" style="width:min(640px, 92vw);max-height:85vh;background:var(--bg);">
        <div class="modal-header">
          <!-- Header title + icon mirror the currently-active sub-tab (Chats /
               Documents / Research / Archive) so the user sees ONE icon at
               the top representing the section they're in, with the tab
               strip below as sub-navigation. _switchLibTab() updates this. -->
          <h4 id="doclib-header-title"><span id="doclib-header-icon" style="vertical-align:-2px;margin-right:4px;display:inline-flex;"></span><span id="doclib-header-text">Library</span></h4>
          <button class="close-btn" id="doclib-close">\u2716</button>
        </div>
        <div class="lib-tabs" id="doclib-lib-tabs" style="padding:0 10px;">
          <button class="lib-tab" data-doclib-tab="chats"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Chats</button>
          <button class="lib-tab active" data-doclib-tab="documents"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>Documents</button>
          <button class="lib-tab" data-doclib-tab="research"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:3px;"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>Research</button>
          <button class="lib-tab" data-doclib-tab="archive"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>Archive</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:10px;overflow:hidden;">
          <div id="doclib-panel-chats" data-doclib-panel="chats" class="admin-card" style="display:none;flex:1;flex-direction:column;overflow:hidden;">
            <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">
              <h2 style="margin:0;padding:0;line-height:1;">Chats <span id="doclib-chats-stats" class="memory-count" style="font-size:0.6em;opacity:0.6;font-weight:normal"></span></h2>
            </div>
            <p class="memory-desc doclib-desc">All active chat sessions. Click to open.</p>
            <div class="memory-toolbar">
              <div class="memory-category-filters">
                <select class="memory-sort-select" id="doclib-chats-sort">
                  <option value="recent">Recent</option>
                  <option value="oldest">Oldest</option>
                  <option value="most-messages">Most messages</option>
                  <option value="alpha">A\u2013Z</option>
                </select>
                <button class="memory-toolbar-btn" id="doclib-chats-select-btn">Select</button>
                <button class="memory-toolbar-btn" id="doclib-chats-tidy-btn" title="AI tidy: delete junk sessions and organize into folders"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:2px;"><path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z"/></svg> Tidy</button>
              </div>
              <input type="text" id="doclib-chats-search" placeholder=t('library.search_chats') class="memory-search-input" />
              <div id="doclib-chats-chips" class="doclib-lang-chips"></div>
            </div>
            <div id="doclib-chats-bulk" class="memory-bulk-bar hidden" style="margin-bottom:5px;">
              <label class="memory-bulk-check-all" style="position:relative;top:0px;left:-1px;"><input type="checkbox" id="doclib-chats-select-all" style="position:relative;top:0px;"> All</label>
              <span id="doclib-chats-selected-count">0 Selected</span>
              <button class="memory-toolbar-btn" id="doclib-chats-bulk-archive" style="position:relative;top:-3px;left:2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>Archive</button>
              <button class="memory-toolbar-btn danger" id="doclib-chats-bulk-delete" style="position:relative;left:2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>Delete</button>
              <button class="memory-toolbar-btn" id="doclib-chats-bulk-cancel" title="Cancel (Esc)" style="margin-left:4px;padding:3px 6px;position:relative;left:2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div id="doclib-chats-grid" class="doclib-grid"></div>
          </div>
          <div id="doclib-panel-archive" data-doclib-panel="archive" class="admin-card" style="display:none;flex:1;flex-direction:column;overflow:hidden;">
            <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">
              <h2 style="margin:0;padding:0;line-height:1;position:relative;top:2px;">Archive <span id="doclib-arc-stats" class="memory-count" style="font-size:0.6em;opacity:0.6;font-weight:normal"></span></h2>
            </div>
            <p class="memory-desc doclib-desc" style="position:relative;top:0.5px;">Archived sessions. Restore to make active again.</p>
            <div class="memory-toolbar">
              <div class="memory-category-filters">
                <select class="memory-sort-select" id="doclib-arc-sort">
                  <option value="recent">Recent</option>
                  <option value="oldest">Oldest</option>
                  <option value="most-messages">Most messages</option>
                  <option value="alpha">A\u2013Z</option>
                </select>
                <button class="memory-toolbar-btn" id="doclib-arc-select-btn">Select</button>
              </div>
              <input type="text" id="doclib-arc-search" placeholder=t('library.search_archive') class="memory-search-input" />
              <div id="doclib-arc-chips" class="doclib-lang-chips"></div>
            </div>
            <div id="doclib-arc-bulk" class="memory-bulk-bar hidden" style="margin-bottom:5px;">
              <label class="memory-bulk-check-all" style="position:relative;top:0px;left:1px;"><input type="checkbox" id="doclib-arc-select-all"> All</label>
              <span id="doclib-arc-selected-count">0 Selected</span>
              <button class="memory-toolbar-btn" id="doclib-arc-bulk-restore" style="position:relative;top:-3px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>Restore</button>
              <button class="memory-toolbar-btn danger" id="doclib-arc-bulk-delete"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>Delete</button>
              <button class="memory-toolbar-btn" id="doclib-arc-bulk-cancel" title="Cancel (Esc)" style="margin-left:4px;padding:3px 6px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div id="doclib-arc-grid" class="doclib-grid"></div>
          </div>
          <div id="doclib-panel-research" data-doclib-panel="research" class="admin-card" style="display:none;flex:1;flex-direction:column;overflow:hidden;">
            <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;margin-top:10px;">
              <h2 style="margin:0;padding:0;line-height:1;">Research <span id="doclib-research-stats" class="memory-count" style="font-size:0.6em;opacity:0.6;font-weight:normal"></span></h2>
            </div>
            <p class="memory-desc doclib-desc" style="position:relative;top:-1px;">Completed deep research reports. Click to view.</p>
            <div class="memory-toolbar">
              <div class="memory-category-filters">
                <select class="memory-sort-select" id="doclib-research-sort">
                  <option value="recent">Recent</option>
                  <option value="oldest">Oldest</option>
                  <option value="most-sources">Most sources</option>
                  <option value="alpha">A\u2013Z</option>
                </select>
                <button class="memory-toolbar-btn" id="doclib-research-select-btn">Select</button>
                <button class="memory-toolbar-btn" id="doclib-research-tidy-btn" title="Tidy: delete research with no sources or empty reports">Tidy</button>
              </div>
              <input type="text" id="doclib-research-search" placeholder=t('library.search_research') class="memory-search-input" />
            </div>
            <div id="doclib-research-bulk" class="memory-bulk-bar hidden" style="margin-bottom:5px;">
              <label class="memory-bulk-check-all" style="position:relative;top:0px;left:1px;"><input type="checkbox" id="doclib-research-select-all"> All</label>
              <span id="doclib-research-selected-count">0 Selected</span>
              <button class="memory-toolbar-btn" id="doclib-research-bulk-archive" style="position:relative;top:-2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>Archive</button>
              <button class="memory-toolbar-btn danger" id="doclib-research-bulk-delete" style="position:relative;top:-2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>Delete</button>
              <button class="memory-toolbar-btn" id="doclib-research-bulk-cancel" title="Cancel (Esc)" style="margin-left:4px;padding:3px 6px;position:relative;top:-2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div id="doclib-research-grid" class="doclib-grid"></div>
          </div>
          <div data-doclib-panel="documents" class="admin-card" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
            <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">
              <h2 style="margin:0;padding:0;line-height:1;">Documents <span id="doclib-stats" class="memory-count" style="font-size:0.6em;opacity:0.6;font-weight:normal"></span></h2>
              <button class="memory-toolbar-btn" id="doclib-import-file-btn" title="Import files from disk" style="margin-left:auto;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px;"><polyline points="7 10 12 5 17 10"/><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="21" x2="19" y2="21"/></svg> Import</button>
              <button class="memory-toolbar-btn" id="doclib-create-btn" title="Create new blank document"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> Create</button>
            </div>
            <p class="memory-desc doclib-desc">Open documents in a session, clone to a new or import new files.</p>
            <div class="memory-toolbar">
              <div class="memory-category-filters">
                <select class="memory-sort-select" id="doclib-sort">
                  <option value="recent">Recent</option>
                  <option value="oldest">Oldest</option>
                  <option value="edits">Most edits</option>
                  <option value="alpha">A\u2013Z</option>
                </select>
                <button class="memory-toolbar-btn" id="doclib-select-btn" title="Select documents">Select</button>
                <button class="memory-toolbar-btn" id="doclib-tidy-btn" title="Tidy: remove empty / junk / duplicate documents">Tidy</button>
              </div>
              <input type="text" id="doclib-search" placeholder=t('library.search_content') class="memory-search-input" />
              <div id="doclib-chips" class="doclib-lang-chips"></div>
            </div>
            <input type="file" id="doclib-file-input" multiple style="display:none" />
            <div id="doclib-bulk-bar" class="memory-bulk-bar hidden" style="margin-bottom:5px;">
              <label class="memory-bulk-check-all" style="position:relative;top:0px;left:1px;"><input type="checkbox" id="doclib-select-all" /> All</label>
              <span id="doclib-selected-count">0 Selected</span>
              <button id="doclib-bulk-actions" class="memory-toolbar-btn" style="position:relative;top:-2px;margin-left:auto;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>Actions <span style="opacity:0.55;font-size:9px;">&#9660;</span></button>
              <button id="doclib-bulk-cancel" class="memory-toolbar-btn" title="Cancel (Esc)" style="margin-left:4px;margin-right:4px;padding:3px 6px;position:relative;top:-2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div class="doclib-grid" id="doclib-grid"></div>
            <button class="doclib-load-more" id="doclib-load-more" style="display:none">Load more</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // 使弹窗可拖动（与其他弹窗相同的逻辑）
    {
      const content = modal.querySelector('.modal-content');
      const header = modal.querySelector('.modal-header');
      if (content && header) {
        // 恢复保存的位置/全屏状态
        try {
          const saved = JSON.parse(localStorage.getItem('doclib-pos'));
          if (saved && saved.fullscreen) {
            localStorage.removeItem('doclib-pos');
          } else if (saved && saved.left && saved.top) {
            content.style.position = 'fixed';
            content.style.left = saved.left;
            content.style.top = saved.top;
            content.style.margin = '0';
            // 限制在视口内 in case window was resized
            requestAnimationFrame(() => {
              const r = content.getBoundingClientRect();
              if (r.right > window.innerWidth) content.style.left = Math.max(0, window.innerWidth - r.width - 8) + 'px';
              if (r.bottom > window.innerHeight) content.style.top = Math.max(0, window.innerHeight - r.height - 8) + 'px';
              if (r.left < 0) content.style.left = '8px';
              if (r.top < 0) content.style.top = '8px';
            });
          }
        } catch {}
        // 用一次辅助调用替换了约 150 行内联拖拽/吸附/停靠代码。
        // 库故意禁用了上边缘全屏吸附：那种布局
        // 会破坏密集的图标/工具行。侧边停靠仍然有效。
        const FS_CLASS = 'doclib-fullscreen';
        const enterFullscreen = () => {
          if (modal.classList.contains(FS_CLASS)) return;
          modal.classList.add(FS_CLASS);
          content.style.position = 'fixed';
          content.style.left = '0';
          content.style.top = '0';
          content.style.right = '0';
          content.style.bottom = '0';
          content.style.width = '100vw';
          content.style.maxWidth = '100vw';
          content.style.height = '100vh';
          content.style.maxHeight = '100vh';
          content.style.borderRadius = '0';
          content.style.margin = '0';
          content.style.transform = 'none';
          try { localStorage.setItem('doclib-pos', JSON.stringify({ fullscreen: true })); } catch {}
        };
        const exitFullscreen = (cx, cy) => {
          if (!modal.classList.contains(FS_CLASS)) return;
          modal.classList.remove(FS_CLASS);
          content.style.width = '';
          content.style.maxWidth = '';
          content.style.height = '';
          content.style.maxHeight = '';
          content.style.borderRadius = '';
          content.style.right = '';
          content.style.bottom = '';
          const r0 = content.getBoundingClientRect();
          const w = r0.width || Math.min(900, window.innerWidth * 0.92);
          content.style.left = Math.max(8, cx - w / 2) + 'px';
          content.style.top = Math.max(8, cy - 20) + 'px';
        };
        makeWindowDraggable(modal, {
          content,
          header,
          fsClass: FS_CLASS,
          skipSelector: '.modal-close',
          onEnterFullscreen: enterFullscreen,
          onExitFullscreen: exitFullscreen,
          enableFullscreen: false,
          onDragEnd: () => {
            try { localStorage.setItem('doclib-pos', JSON.stringify({ left: content.style.left, top: content.style.top })); } catch {}
          },
        });
      }
    }

    // 绑定事件
    document.getElementById('doclib-close').addEventListener('click', closeLibrary);

    // 标签页切换 — 聊天 / 文档 / 归档 / 调研
    let _activeLibTab = (opts && opts.tab) || 'documents';
    const _tabBtns = modal.querySelectorAll('[data-doclib-tab]');
    const _tabPanels = modal.querySelectorAll('[data-doclib-panel]');

    // 对一次性返回所有数据的标签页进行客户端分页
    // （聊天/归档/调研）。初始只渲染这么多行；
    // “加载更多”按钮每次分批展示更多。
    const _LIB_PAGE_SIZE = 20;
    let _chatsVisibleLimit = _LIB_PAGE_SIZE;
    let _arcVisibleLimit = _LIB_PAGE_SIZE;
    let _researchVisibleLimit = _LIB_PAGE_SIZE;

    function _appendInlineLoadMore(grid, totalCount, currentLimit, onClick) {
      if (!grid || !grid.parentElement) return;
      // 丢弃之前的实例（如果有）— 我们重新渲染列表
      // 从头渲染，所以按钮也随之重新生成。
      grid.parentElement.querySelectorAll(':scope > .doclib-inline-load-more').forEach(b => b.remove());
      if (totalCount <= currentLimit) return;
      const btn = document.createElement('button');
      btn.className = 'doclib-load-more doclib-inline-load-more';
      btn.textContent = t('library.load_more_short', { n: currentLimit, total: totalCount });
      btn.addEventListener('click', onClick);
      grid.parentElement.appendChild(btn);
    }

    // 每个标签页的 SVG 标记 + 标签 — 用于在切换时保持弹窗头部同步。
    // 每个标签页的 SVG 标记 + 标签 — 用于在切换时保持弹窗头部同步。
    const _TAB_HEADERS = {
      chats: {
        label: t('library.tab_chats'),
        svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
      },
      documents: {
        label: t('library.tab_documents'),
        svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
      },
      research: {
        label: t('library.tab_research'),
        svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
      },
      archive: {
        label: t('library.tab_archive'),
        svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
      },
    };

    function _switchLibTab(tab) {
      _activeLibTab = tab;
      _tabBtns.forEach(b => b.classList.toggle('active', b.dataset.doclibTab === tab));
      _tabPanels.forEach(p => {
        if (p.dataset.doclibPanel === tab) {
          p.style.display = 'flex';
        } else {
          p.style.display = 'none';
        }
      });
      // 同步弹窗头部图标 + 标签以匹配活跃的子标签页。
      const hdr = _TAB_HEADERS[tab];
      if (hdr) {
        const ico = document.getElementById('doclib-header-icon');
        const txt = document.getElementById('doclib-header-text');
        if (ico) ico.innerHTML = hdr.svg;
        if (txt) txt.textContent = hdr.label;
      }
      if (tab === 'chats') _renderLibChats();
      else if (tab === 'archive') _renderLibArchive();
      else if (tab === 'research') _renderLibResearch();
    }

    _tabBtns.forEach(btn => {
      btn.addEventListener('click', () => _switchLibTab(btn.dataset.doclibTab));
    });

    // ── 聊天标签页状态 ──
    let _chatsSessions = [];
    let _chatsSearch = '';
    let _chatsSort = 'recent';
    let _chatsSelectMode = false;
    const _chatsSelected = new Set();
    let _chatsModelFilter = '';

    function _renderLibChats() {
      const grid = document.getElementById('doclib-chats-grid');
      if (!grid) return;
      grid.innerHTML = '';
      grid.appendChild(spinnerModule.createLoadingRow('Loading…'));
      fetch(API_BASE + '/api/sessions', { credentials: 'same-origin' }).then(r => r.json()).then(data => {
        const raw = Array.isArray(data) ? data : (data.sessions || []);
        _chatsSessions = raw.filter(s => !s.archived);
        _renderChatsGrid();
        _renderChatsChips();
      }).catch(() => { grid.innerHTML = '<div class="doclib-empty">Failed to load</div>'; });
    }

    // 点击聊天行以内联方式展开：获取最近的消息并
    // 渲染带有对话控件（导航、归档、复制）的预览。
    // 渲染带有对话控件（导航、归档、复制）的预览。
    async function _toggleChatPreview(card, session) {
      const preview = card.querySelector('.doclib-chat-preview');
      if (!preview) return;
      const isOpen = card.classList.contains('doclib-card-expanded');
      // 先折叠此网格中其他已打开的预览
      const grid = card.closest('.doclib-grid');
      if (grid) {
        grid.querySelectorAll('.doclib-card-expanded').forEach(c => {
          if (c !== card) {
            c.classList.remove('doclib-card-expanded');
            const p = c.querySelector('.doclib-chat-preview');
            if (p) { p.style.display = 'none'; p.innerHTML = ''; }
          }
        });
      }
      if (isOpen) {
        card.classList.remove('doclib-card-expanded');
        preview.style.display = 'none';
        preview.innerHTML = '';
        return;
      }
      card.classList.add('doclib-card-expanded');
      preview.style.display = 'block';
      preview.innerHTML = '<div style="opacity:0.4;font-size:11px;padding:8px 4px;">Loading…</div>';
      try {
        const res = await fetch(`${API_BASE}/api/history/${session.id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        const history = Array.isArray(data) ? data : (data.history || []);
        const recent = history.filter(m => m.role === 'user' || m.role === 'assistant').slice(-5);
        const sessionModel = (session.model || '').split('/').pop();
        const msgsHtml = recent.length
          ? recent.map(m => {
              const isUser = m.role === 'user';
              const raw = m.content || '';
              const truncated = raw.length > 600 ? raw.slice(0, 600) + '…' : raw;
              // 剥离思考块（内部模型状态）并渲染
              // 聊天使用的同一 markdown 处理管道。
              const cleaned = truncated
                .replace(/<think>[\s\S]*?<\/think>/g, '')
                .replace(/<think>[\s\S]*$/, '')
                .trim();
              let body;
              try {
                body = markdownModule.mdToHtml(cleaned);
              } catch { body = _esc(cleaned); }
              // 每条消息的模型可以覆盖会话默认值（例如
              // 在同一聊天中比较模型时）。
              const msgModel = (m.metadata && (m.metadata.model || m.metadata.model_name)) || '';
              const modelTag = !isUser && (msgModel || sessionModel)
                ? `<span class="doclib-chat-msg-model">${_esc(msgModel || sessionModel)}</span>`
                : '';
              return `<div class="doclib-chat-bubble-row ${isUser ? 'user' : 'assistant'}">
                <div class="doclib-chat-bubble">
                  ${modelTag}
                  <div class="doclib-chat-bubble-body">${body}</div>
                </div>
              </div>`;
            }).join('')
          : '<div style="opacity:0.4;font-size:11px;padding:6px 4px;">No messages yet</div>';
        const isArchive = !!session.archived;
        // 已归档的聊天获得恢复按钮（取消归档）；活跃聊天获得归档按钮。
        // 与调研 + 文档归档预览一致。
        const archiveHtml = isArchive
          ? '<button class="doclib-chat-restore-btn">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9"/></svg>' +
              'Restore' +
            '</button>'
          : '<button class="doclib-chat-archive-btn">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>' +
              'Archive' +
            '</button>';
        // 复制按钮紧挨归档按钮放在操作行左侧。
        // 使用相同的边框仅有样式的次要操作样式 — 与填充式的
        // 主要按钮（导航、打开、恢复）区分开来。
        // 复制在归档视图中隐藏（底部栏只保留删除 + 恢复 + 打开）。
        // 在活跃聊天中仍然显示。
        const copyHtml = isArchive ? '' : '<button class="doclib-chat-copy-btn">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
              'Copy' +
            '</button>';
        const deleteHtml = '<button class="doclib-chat-delete-btn">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>' +
              'Delete' +
            '</button>';
        preview.innerHTML =
          '<div class="doclib-chat-preview-messages">' + msgsHtml + '</div>' +
          '<div class="doclib-chat-preview-actions">' +
            deleteHtml +
            archiveHtml +
            copyHtml +
            '<button class="doclib-chat-open-btn">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>' +
              'Open' +
            '</button>' +
          '</div>';
        const openBtn = preview.querySelector('.doclib-chat-open-btn');
        if (openBtn) openBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.sessionModule) window.sessionModule.selectSession(session.id);
          closeLibrary();
          // 同时折叠宽侧边栏，使所选聊天处于
          // 前中位置，而不是被库挤压到旁边。
          // 侧边栏本身。桌面端跳过，因为用户期望
          // 侧边栏停留在他们离开时的位置。
          if (window.innerWidth <= 768) {
            const sb = document.getElementById('sidebar');
            if (sb) {
              sb.classList.add('hidden');
              try { window.syncRailSide && window.syncRailSide(); } catch (_) {}
            }
          }
        });
        const archiveBtn = preview.querySelector('.doclib-chat-archive-btn');
        if (archiveBtn) archiveBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await fetch(API_BASE + '/api/session/' + session.id + '/archive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          _renderLibChats();
        });
        const restoreBtn = preview.querySelector('.doclib-chat-restore-btn');
        if (restoreBtn) restoreBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await fetch(API_BASE + '/api/session/' + session.id + '/unarchive', { method: 'POST' });
          _renderLibArchive();
        });
        const copyBtn = preview.querySelector('.doclib-chat-copy-btn');
        if (copyBtn) copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _copyChatById(session.id);
        });
        const deleteBtn = preview.querySelector('.doclib-chat-delete-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!await window.styledConfirm(t('library.delete_chat_confirm'), { confirmText: t('common.delete'), danger: true })) return;
          await fetch(API_BASE + '/api/session/' + session.id, { method: 'DELETE' });
          card.style.maxHeight = `${Math.max(card.getBoundingClientRect().height, card.scrollHeight)}px`;
          card.classList.add('memory-tidy-removing');
          await new Promise(r => setTimeout(r, 520));
          if (isArchive) _renderLibArchive(); else _renderLibChats();
        });
      } catch (e) {
        preview.innerHTML = '<div style="opacity:0.5;font-size:11px;padding:6px 4px;color:var(--color-error);">${t('library.failed_preview')}</div>';
      }
    }

    function _renderChatsGrid() {
      const grid = document.getElementById('doclib-chats-grid');
      if (!grid) return;
      const _csb = document.getElementById('doclib-chats-select-btn');
      if (_csb) { _csb.classList.toggle('active', _chatsSelectMode); _csb.textContent = _chatsSelectMode ? t('common.cancel') : t('library.select'); }
      let filtered = _chatsSessions.slice();
      if (_chatsSearch) {
        const q = _chatsSearch.toLowerCase();
        filtered = filtered.filter(s => (s.name || '').toLowerCase().includes(q) || (s.model || '').toLowerCase().includes(q));
      }
      if (_chatsModelFilter) filtered = filtered.filter(s => s.folder === _chatsModelFilter);
      if (_chatsSort === 'oldest') filtered.sort((a, b) => (a.updated_at || '') > (b.updated_at || '') ? 1 : -1);
      else if (_chatsSort === 'most-messages') filtered.sort((a, b) => (b.message_count || 0) - (a.message_count || 0));
      else if (_chatsSort === 'alpha') filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      else filtered.sort((a, b) => (b.updated_at || '') > (a.updated_at || '') ? 1 : -1);

      const stats = document.getElementById('doclib-chats-stats');
      if (stats) stats.textContent = t('library.chat_count', { n: filtered.length });

      if (!filtered.length) {
        // 撇嘴表情（向下曲线）表示"这里还没有内容"。
        const _sadIco = '<span style="vertical-align:-3px;margin-left:6px;">' + uiModule.emptyStateIcon('sad') + '</span>';
        grid.innerHTML = '<div class="doclib-empty">' + t('library.no_chats') + _sadIco + '</div>';
        _appendInlineLoadMore(grid, 0, _chatsVisibleLimit, () => {});
        return;
      }
      const total = filtered.length;
      const visible = filtered.slice(0, _chatsVisibleLimit);
      grid.innerHTML = '';
      _maybeCascadeGrid(grid, 'chats');
      for (const s of visible) {
        const card = document.createElement('div');
        card.className = 'memory-item doclib-chat-row';
        card.style.cursor = 'pointer';
        card.dataset.sid = s.id;
        const model = (s.model || '').split('/').pop();
        const cbHtml = _chatsSelectMode ? '<input type="checkbox" class="memory-select-cb"' + (_chatsSelected.has(s.id) ? ' checked' : '') + '>' : '';
        const chatIconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;opacity:0.4;flex-shrink:0;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
        const chevronSvg = '<span class="doclib-card-chevron"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>';
        // 消息计数徽章在标题内，比名称更暗，以免在视觉上争夺注意力。
        // 消息计数徽章在标题内，比名称更暗，以免在视觉上争夺注意力。
        // brand-new "New Chat" rows don't show "\u00b7 0 msgs".
        const _chatMsgs = s.message_count || 0;
        const msgCountHtml = _chatMsgs > 0
          ? '<span style="opacity:0.45;font-weight:normal;font-size:0.9em;margin-left:6px;">\u00b7 ' + _chatMsgs + ' msg' + (_chatMsgs === 1 ? '' : 's') + '</span>'
          : '';
        card.innerHTML =
          '<div class="doclib-chat-header" style="display:flex;align-items:center;width:100%;gap:6px;">' +
            cbHtml +
            '<div style="flex:1;min-width:0;">' +
              '<div class="memory-item-title">' + chatIconSvg + _esc(s.name || t('library.untitled')) + msgCountHtml + '</div>' +
              '<div class="memory-item-meta" style="font-size:10px;opacity:0.4;margin-top:2px;">' + [model, _relTime(s.updated_at)].filter(Boolean).join(' \u00b7 ') + '</div>' +
            '</div>' +
            chevronSvg +
            '<div class="memory-item-actions"><button class="memory-item-btn _chat-menu" title="${t('library.actions')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button></div>' +
          '</div>' +
          '<div class="doclib-chat-preview" style="display:none;"></div>';
        const cb = card.querySelector('.memory-select-cb');
        if (cb) { cb.addEventListener('click', e => e.stopPropagation()); cb.addEventListener('change', () => { if (cb.checked) _chatsSelected.add(s.id); else _chatsSelected.delete(s.id); _updateChatsCount(); }); }
        card.querySelector('._chat-menu').addEventListener('click', (e) => { e.stopPropagation(); _showLibDropdown(e.currentTarget, [
          { label: t('common.open'), action: () => { if (window.sessionModule) window.sessionModule.selectSession(s.id); } },
          { label: t('common.copy'), action: () => _copyChatById(s.id) },
          { label: t('library.archive_hide'), action: async () => { await fetch(API_BASE + '/api/session/' + s.id + '/archive', { method: 'POST', headers: {'Content-Type':'application/json'} }); _renderLibChats(); } },
          { label: t('common.delete'), action: async () => {
            if (!await window.styledConfirm(t('library.delete_chat_confirm'), { confirmText: t('common.delete'), danger: true })) return;
            await fetch(API_BASE + '/api/session/' + s.id, { method: 'DELETE' });
            card.style.maxHeight = `${Math.max(card.getBoundingClientRect().height, card.scrollHeight)}px`;
            card.classList.add('memory-tidy-removing');
            await new Promise(r => setTimeout(r, 520));
            _renderLibChats();
          }, danger: true },
        ], { onSelect: () => {
          _chatsSelectMode = true;
          _chatsSelected.add(s.id);
          document.getElementById('doclib-chats-bulk')?.classList.remove('hidden');
          _renderChatsGrid();
        } }); });
        card.addEventListener('click', (e) => {
          if (card._suppressNextClick) { card._suppressNextClick = false; return; }
          if (_chatsSelectMode) { const c = card.querySelector('.memory-select-cb'); if (c) { c.checked = !c.checked; if (c.checked) _chatsSelected.add(s.id); else _chatsSelected.delete(s.id); _updateChatsCount(); } return; }
          if (e.target.closest('._chat-menu') || e.target.closest('.memory-select-cb') || e.target.closest('.doclib-chat-open-btn')) return;
          _toggleChatPreview(card, s);
        });
        _attachLongPressMenu(card, '._chat-menu');
        grid.appendChild(card);
      }
      _appendInlineLoadMore(grid, total, _chatsVisibleLimit, () => {
        _chatsVisibleLimit += _LIB_PAGE_SIZE;
        _renderChatsGrid();
      });
    }

    function _renderChatsChips() {
      const el = document.getElementById('doclib-chats-chips');
      if (!el) return;
      const counts = {};
      _chatsSessions.forEach(s => { const f = s.folder; if (f) counts[f] = (counts[f] || 0) + 1; });
      const folders = Object.keys(counts).sort();
      if (folders.length < 1) { el.innerHTML = ''; return; }
      el.innerHTML = '';
      const mk = (label, val, count) => { const c = document.createElement('button'); c.className = 'memory-cat-chip' + (_chatsModelFilter === val ? ' active' : ''); c.textContent = label + ' (' + count + ')'; c.addEventListener('click', () => { _chatsModelFilter = _chatsModelFilter === val ? '' : val; _renderChatsGrid(); _renderChatsChips(); }); el.appendChild(c); };
      mk('all', '', _chatsSessions.length);
      folders.forEach(f => mk(f, f, counts[f]));
    }

    function _updateChatsCount() { const el = document.getElementById('doclib-chats-selected-count'); if (el) el.textContent = _chatsSelected.size + ' Selected'; }

    // 聊天事件监听器
    document.getElementById('doclib-chats-sort').addEventListener('change', (e) => { _chatsSort = e.target.value; _renderChatsGrid(); });
    document.getElementById('doclib-chats-search').addEventListener('input', (e) => { _chatsSearch = e.target.value.trim(); _renderChatsGrid(); });
    document.getElementById('doclib-chats-select-btn').addEventListener('click', () => { _chatsSelectMode = !_chatsSelectMode; _chatsSelected.clear(); document.getElementById('doclib-chats-bulk').classList.toggle('hidden', !_chatsSelectMode); _renderChatsGrid(); });
    document.getElementById('doclib-chats-bulk-cancel')?.addEventListener('click', () => {
      _chatsSelectMode = false; _chatsSelected.clear();
      document.getElementById('doclib-chats-bulk').classList.add('hidden');
      _renderChatsGrid();
    });
    function _chatsToggleAll() {
      const allCb = document.getElementById('doclib-chats-select-all');
      const newState = _chatsSelected.size < _chatsSessions.length;
      if (allCb) allCb.checked = newState;
      document.querySelectorAll('#doclib-chats-grid .memory-select-cb').forEach(cb => { cb.checked = newState; });
      _chatsSessions.forEach(s => { if (newState) _chatsSelected.add(s.id); else _chatsSelected.delete(s.id); });
      _updateChatsCount();
    }
    document.getElementById('doclib-chats-select-all').addEventListener('change', _chatsToggleAll);
    document.getElementById('doclib-chats-bulk').addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      _chatsToggleAll();
    });
    document.getElementById('doclib-chats-bulk-archive').addEventListener('click', async () => {
      const count = _chatsSelected.size;
      if (!count) return;
      const grid = document.getElementById('doclib-chats-grid');
      if (grid) {
        grid.querySelectorAll('.doclib-card').forEach(card => {
          const sid = card.dataset.sid || card.dataset.sessionId;
          if (sid && _chatsSelected.has(sid)) {
            card.style.transition = 'opacity 0.25s, transform 0.25s';
            card.style.opacity = '0';
            card.style.transform = 'scale(0.95)';
          }
        });
      }
      await new Promise(r => setTimeout(r, 250));
      const ids = [..._chatsSelected];
      const results = await Promise.all(
        ids.map(sid => fetch(API_BASE + '/api/session/' + sid + '/archive', { method: 'POST', headers: {'Content-Type':'application/json'} })
          .then(r => ({ sid, ok: r.ok }))
          .catch(() => ({ sid, ok: false }))
        )
      );
      const failed = results.filter(r => !r.ok).map(r => r.sid);
      if (failed.length && grid) {
        grid.querySelectorAll('.doclib-card').forEach(card => {
          const sid = card.dataset.sid || card.dataset.sessionId;
          if (sid && failed.includes(sid)) {
            card.style.opacity = '';
            card.style.transform = '';
          }
        });
        if (window.uiModule) window.uiModule.showError(`Failed to archive ${failed.length} of ${ids.length} chat${ids.length > 1 ? 's' : ''}`);
      }
      _chatsSelected.clear();
      _chatsSelectMode = false;
      document.getElementById('doclib-chats-bulk').classList.add('hidden');
      _renderLibChats();
    });
    document.getElementById('doclib-chats-bulk-delete').addEventListener('click', async () => {
      const count = _chatsSelected.size;
      if (!count) return;
      if (!await window.styledConfirm(t('library.delete_chats_confirm', { n: count }), { confirmText: t('common.delete'), danger: true })) return;
      // 淡出选中的卡片
      const grid = document.getElementById('doclib-chats-grid');
      if (grid) {
        grid.querySelectorAll('.doclib-card').forEach(card => {
          const sid = card.dataset.sid || card.dataset.sessionId;
          if (sid && _chatsSelected.has(sid)) {
            card.style.transition = 'opacity 0.25s, transform 0.25s';
            card.style.opacity = '0';
            card.style.transform = 'scale(0.95)';
          }
        });
      }
      // 删除 after animation. v2 review HIGH-8: inspect each response
      // 这样被服务器拒绝的卡片会被恢复（而不是
      // 永远保持淡出状态），并且用户会看到一个汇总的
      // 错误提示。
      await new Promise(r => setTimeout(r, 250));
      const ids = [..._chatsSelected];
      const results = await Promise.all(
        ids.map(sid => fetch(API_BASE + '/api/session/' + sid, { method: 'DELETE' })
          .then(r => ({ sid, ok: r.ok }))
          .catch(() => ({ sid, ok: false }))
        )
      );
      const failed = results.filter(r => !r.ok).map(r => r.sid);
      if (failed.length && grid) {
        // 恢复被服务器拒绝的行的淡出卡片。
        grid.querySelectorAll('.doclib-card').forEach(card => {
          const sid = card.dataset.sid || card.dataset.sessionId;
          if (sid && failed.includes(sid)) {
            card.style.opacity = '';
            card.style.transform = '';
          }
        });
        if (window.uiModule) window.uiModule.showError(`Failed to delete ${failed.length} of ${ids.length} chat${ids.length > 1 ? 's' : ''}`);
      }
      _chatsSelected.clear();
      _chatsSelectMode = false;
      document.getElementById('doclib-chats-bulk').classList.add('hidden');
      _renderLibChats();
    });

    // 整理按钮 — AI 清理 + 组织到文件夹中
    document.getElementById('doclib-chats-tidy-btn').addEventListener('click', async () => {
      const tidyBtn = document.getElementById('doclib-chats-tidy-btn');
      const origHTML = tidyBtn.innerHTML;
      tidyBtn.disabled = true;
      tidyBtn.classList.add('spinning');
      tidyBtn.textContent = '';
      // 静默漩涡图标，向上微调以与周围按钮对齐
      // 聊天头部中的文本。之前的版本检查
      // `window.spinnerModule`（从未绑定）并且总是回退到
      // 纯文本“整理中...”标签。
      const sp = spinnerModule.create('', 'clean', 'whirlpool');
      const el = sp.createElement();
      el.style.position = 'relative';
      el.style.top = '1px';
      tidyBtn.appendChild(el);
      sp.start();
      try {
        const res = await fetch(API_BASE + '/api/sessions/auto-sort', { method: 'POST', credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Tidy failed');
        if (data.status === 'ok') {
          if (window.uiModule) window.uiModule.showToast('Sorted ' + data.updated + ' sessions into ' + data.folders.length + ' folders');
          if (window.sessionModule) await window.sessionModule.loadSessions();
          _renderLibChats();
        } else {
          if (window.uiModule) window.uiModule.showToast(data.reason || 'Nothing to tidy');
        }
      } catch (e) {
        if (window.uiModule) window.uiModule.showError('Tidy: ' + e.message);
      } finally {
        tidyBtn.disabled = false;
        tidyBtn.classList.remove('spinning');
        tidyBtn.innerHTML = origHTML;
      }
    });

    // ── 归档标签页状态 ──
    let _arcSessions = [];
    let _arcDocs = [];        // archived documents
    let _arcResearch = [];    // archived research reports
    let _arcSearch = '';
    let _arcSort = 'recent';
    let _arcSelectMode = false;
    const _arcSelected = new Set();
    let _arcModelFilter = '';
    let _arcTypeFilter = '';   // '', 'chats', 'documents', 'research'

    function _renderLibArchive() {
      const grid = document.getElementById('doclib-arc-grid');
      if (!grid) return;
      grid.innerHTML = '';
      grid.appendChild(spinnerModule.createLoadingRow('Loading…'));
      // 归档标签页是所有已归档项目的家 — 聊天、文档和调研。
      // 获取所有三个集合并合并为一个统一视图。
      Promise.all([
        fetch(API_BASE + '/api/sessions/archived?limit=100&sort=recent', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
        fetch(API_BASE + '/api/documents/library?archived=true&limit=50', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
        fetch('/api/research/library?archived=true', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
      ]).then(([s, d, r]) => {
        // 这些按定义都是已归档的 — 标记它们以便展开的
        // 卡片在底部栏显示恢复而非归档。
        _arcSessions = (s.sessions || []).map(x => ({ ...x, archived: true }));
        _arcDocs = d.documents || [];
        _arcResearch = (r.research || []).map(x => ({ ...x, archived: true }));
        _renderArcGrid();
        _renderArcChips();
      }).catch(() => { grid.innerHTML = '<div class="doclib-empty">Failed to load</div>'; });
    }

    // 已归档文档卡片的内联展开/折叠（聊天风格）。从 API 加载纯文本预览。
    // 已归档文档卡片的内联展开/折叠（聊天风格）。从 API 加载纯文本预览。
    // 已显示的文本并跳过语法高亮（归档预览是只读快速查看）。
    async function _toggleArcDocPreview(card, d) {
      const preview = card.querySelector('.doclib-chat-preview');
      if (!preview) return;
      const grid = card.closest('.doclib-grid');
      if (grid) {
        grid.querySelectorAll('.doclib-card-expanded').forEach(c => {
          if (c !== card) {
            c.classList.remove('doclib-card-expanded');
            const p = c.querySelector('.doclib-chat-preview');
            if (p) { p.style.display = 'none'; p.innerHTML = ''; }
          }
        });
      }
      if (card.classList.contains('doclib-card-expanded')) {
        card.classList.remove('doclib-card-expanded');
        preview.style.display = 'none'; preview.innerHTML = '';
        return;
      }
      card.classList.add('doclib-card-expanded');
      preview.style.display = 'block';
      preview.innerHTML = '<div style="opacity:0.4;font-size:11px;padding:8px 4px;">Loading…</div>';
      try {
        const res = await fetch(`${API_BASE}/api/document/${d.id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('failed');
        const full = await res.json();
        const content = (full.current_content || '').slice(0, 20000);
        const pre = document.createElement('pre');
        pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:11px;margin:6px 4px;max-height:50vh;overflow:auto;';
        pre.textContent = content || '(empty document)';
        preview.innerHTML = '';
        preview.appendChild(pre);

        // 底部操作栏 — 使用相同的可见 .doclib-chat-preview-actions 样式
        // 聊天/调研预览（.doclib-card-expanded-actions 类是
        // display:none，除非在 .doclib-card 内，而这些归档行
        // 不在其中）。删除 + 恢复，与其他一致。
        const actions = document.createElement('div');
        actions.className = 'doclib-chat-preview-actions';
        actions.innerHTML =
          '<button class="doclib-chat-delete-btn"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>Delete</button>' +
          '<button class="doclib-chat-restore-btn"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9"/></svg>Restore</button>' +
          '<button class="doclib-chat-open-btn"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>Open</button>';
        actions.querySelector('.doclib-chat-delete-btn').addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!await window.styledConfirm(t('library.delete_document_confirm'), { confirmText: t('common.delete'), danger: true })) return;
          await fetch(`${API_BASE}/api/document/${d.id}`, { method: 'DELETE', credentials: 'same-origin' });
          _renderLibArchive();
        });
        actions.querySelector('.doclib-chat-restore-btn').addEventListener('click', async (ev) => {
          ev.stopPropagation();
          await fetch(`${API_BASE}/api/document/${d.id}/archive?archived=false`, { method: 'POST', credentials: 'same-origin' });
          _renderLibArchive();
        });
        // 打开 = clone the doc into the active session and surface it in the editor.
        actions.querySelector('.doclib-chat-open-btn').addEventListener('click', (ev) => {
          ev.stopPropagation();
          libraryImportDocument(d);
        });
        preview.appendChild(actions);
      } catch {
        preview.innerHTML = '<div style="opacity:0.4;font-size:11px;padding:8px 4px;">${t('library.failed_preview')}</div>';
      }
    }

    function _renderArcGrid() {
      const grid = document.getElementById('doclib-arc-grid');
      if (!grid) return;
      const _asb = document.getElementById('doclib-arc-select-btn');
      if (_asb) { _asb.classList.toggle('active', _arcSelectMode); _asb.textContent = _arcSelectMode ? t('common.cancel') : t('library.select'); }
      let filtered = _arcSessions.slice();
      if (_arcSearch) {
        const q = _arcSearch.toLowerCase();
        filtered = filtered.filter(s => (s.name || '').toLowerCase().includes(q) || (s.model || '').toLowerCase().includes(q));
      }
      if (_arcModelFilter) filtered = filtered.filter(s => (s.model || '').split('/').pop() === _arcModelFilter);
      if (_arcSort === 'oldest') filtered.sort((a, b) => (a.updated_at || '') > (b.updated_at || '') ? 1 : -1);
      else if (_arcSort === 'most-messages') filtered.sort((a, b) => (b.message_count || 0) - (a.message_count || 0));
      else if (_arcSort === 'alpha') filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      else filtered.sort((a, b) => (b.updated_at || '') > (a.updated_at || '') ? 1 : -1);

      // 已归档的文档 + 调研也在这里 — 通过相同的搜索过滤它们。
      const _aq = (_arcSearch || '').toLowerCase();
      let filtDocs = _aq ? _arcDocs.filter(d => (d.title || '').toLowerCase().includes(_aq)) : _arcDocs;
      let filtResearch = _aq ? _arcResearch.filter(r => (r.query || '').toLowerCase().includes(_aq)) : _arcResearch;

      // 类型过滤器标签（聊天/文档/调研）将其他类型归零。
      const _showChats = !_arcTypeFilter || _arcTypeFilter === 'chats';
      const _showDocs = !_arcTypeFilter || _arcTypeFilter === 'documents';
      const _showResearch = !_arcTypeFilter || _arcTypeFilter === 'research';
      if (!_showChats) filtered = [];
      if (!_showDocs) filtDocs = [];
      if (!_showResearch) filtResearch = [];

      const stats = document.getElementById('doclib-arc-stats');
      if (stats) stats.textContent = (filtered.length + filtDocs.length + filtResearch.length) + ' archived';

      if (!filtered.length && !filtDocs.length && !filtResearch.length) {
        // 中性/无表情面孔表示"这里没有归档内容"。
        const _neutralIco = '<span style="vertical-align:-3px;margin-left:6px;">' + uiModule.emptyStateIcon('neutral') + '</span>';
        grid.innerHTML = '<div class="doclib-empty">' + t('library.no_archived_items') + _neutralIco + '</div>';
        _appendInlineLoadMore(grid, 0, _arcVisibleLimit, () => {});
        return;
      }
      const total = filtered.length;
      const visible = filtered.slice(0, _arcVisibleLimit);
      grid.innerHTML = '';
      _maybeCascadeGrid(grid, 'archive');
      for (const s of visible) {
        const card = document.createElement('div');
        card.className = 'memory-item doclib-chat-row';
        card.style.cursor = 'pointer';
        card.dataset.sid = s.id;
        card.dataset.arckey = 'chats:' + s.id;
        const model = (s.model || '').split('/').pop();
        const cbHtml = _arcSelectMode ? '<input type="checkbox" class="memory-select-cb" data-arckey="chats:' + s.id + '"' + (_arcSelected.has('chats:' + s.id) ? ' checked' : '') + '>' : '';
        const arcIconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;opacity:0.5;flex-shrink:0;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
        card.innerHTML =
          '<div class="doclib-chat-header" style="display:flex;align-items:center;width:100%;gap:6px;">' +
            cbHtml +
            '<div style="flex:1;min-width:0;">' +
              '<div class="memory-item-title">' + arcIconSvg + _esc(s.name || t('library.untitled')) + '</div>' +
              '<div class="memory-item-meta" style="font-size:10px;opacity:0.4;margin-top:2px;">' + [model, _relTime(s.updated_at)].filter(Boolean).join(' \u00b7 ') + '</div>' +
            '</div>' +
            '<div class="memory-item-actions"><button class="memory-item-btn _arc-menu" title="${t('library.actions')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button></div>' +
          '</div>' +
          '<div class="doclib-chat-preview" style="display:none;"></div>';
        const cb = card.querySelector('.memory-select-cb');
        if (cb) { cb.addEventListener('click', e => e.stopPropagation()); cb.addEventListener('change', () => { if (cb.checked) _arcSelected.add('chats:' + s.id); else _arcSelected.delete('chats:' + s.id); _updateArcCount(); }); }
        card.querySelector('._arc-menu').addEventListener('click', (e) => { e.stopPropagation(); _showLibDropdown(e.currentTarget, [
          { label: t('common.open'), action: () => { if (window.sessionModule) window.sessionModule.selectSession(s.id); } },
          { label: t('common.copy'), action: () => _copyChatById(s.id) },
          { label: t('library.restore'), action: async () => { await fetch(API_BASE + '/api/session/' + s.id + '/unarchive', { method: 'POST' }); _renderLibArchive(); } },
          { label: t('common.delete'), action: async () => {
            if (!await window.styledConfirm(t('library.delete_chat_permanent'), { confirmText: t('common.delete'), danger: true })) return;
            await fetch(API_BASE + '/api/session/' + s.id, { method: 'DELETE' });
            _renderLibArchive();
          }, danger: true },
        ], { onSelect: () => {
          _arcSelectMode = true;
          _arcSelected.add('chats:' + s.id);
          document.getElementById('doclib-arc-bulk')?.classList.remove('hidden');
          _renderArcGrid();
        } }); });
        card.addEventListener('click', (e) => {
          if (card._suppressNextClick) { card._suppressNextClick = false; return; }
          if (_arcSelectMode) { const c = card.querySelector('.memory-select-cb'); if (c) { c.checked = !c.checked; if (c.checked) _arcSelected.add('chats:' + s.id); else _arcSelected.delete('chats:' + s.id); _updateArcCount(); } return; }
          if (e.target.closest('._arc-menu') || e.target.closest('.memory-select-cb') || e.target.closest('.doclib-chat-open-btn')) return;
          _toggleChatPreview(card, s);
        });
        _attachLongPressMenu(card, '._arc-menu');
        grid.appendChild(card);
      }
      // 已归档文档 — 文档图标，恢复 / 删除。
      const _arcDocIco = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;opacity:0.5;flex-shrink:0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
      for (const d of filtDocs) {
        const card = document.createElement('div');
        card.className = 'memory-item doclib-chat-row';
        card.style.cursor = 'pointer';
        card.dataset.arckey = 'documents:' + d.id;
        const _dcb = _arcSelectMode ? '<input type="checkbox" class="memory-select-cb" data-arckey="documents:' + d.id + '"' + (_arcSelected.has('documents:' + d.id) ? ' checked' : '') + '>' : '';
        card.innerHTML =
          '<div class="doclib-chat-header" style="display:flex;align-items:center;width:100%;gap:6px;">' +
            _dcb +
            '<div style="flex:1;min-width:0;">' +
              '<div class="memory-item-title">' + _arcDocIco + _esc(d.title || t('library.untitled')) + '</div>' +
              '<div class="memory-item-meta" style="font-size:10px;opacity:0.4;margin-top:2px;">' + ['Document', (d.language || 'text'), _relTime(d.updated_at)].filter(Boolean).join(' · ') + '</div>' +
            '</div>' +
            '<div class="memory-item-actions"><button class="memory-item-btn _arc-doc-menu" title="${t('library.actions')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button></div>' +
          '</div>' +
          '<div class="doclib-chat-preview" style="display:none;"></div>';
        const _dcbEl = card.querySelector('.memory-select-cb');
        if (_dcbEl) { _dcbEl.addEventListener('click', e => e.stopPropagation()); _dcbEl.addEventListener('change', () => { if (_dcbEl.checked) _arcSelected.add('documents:' + d.id); else _arcSelected.delete('documents:' + d.id); _updateArcCount(); }); }
        card.addEventListener('click', (e) => {
          if (e.target.closest('._arc-doc-menu') || e.target.closest('.memory-select-cb')) return;
          if (_arcSelectMode) { const c = card.querySelector('.memory-select-cb'); if (c) { c.checked = !c.checked; if (c.checked) _arcSelected.add('documents:' + d.id); else _arcSelected.delete('documents:' + d.id); _updateArcCount(); } return; }
          _toggleArcDocPreview(card, d);
        });
        card.querySelector('._arc-doc-menu').addEventListener('click', (e) => { e.stopPropagation(); _showLibDropdown(e.currentTarget, [
          { label: t('library.restore'), action: async () => { await fetch(API_BASE + '/api/document/' + d.id + '/archive?archived=false', { method: 'POST', credentials: 'same-origin' }); _renderLibArchive(); } },
          { label: t('common.delete'), danger: true, action: async () => { if (!await window.styledConfirm(t('library.delete_document_confirm'), { confirmText: t('common.delete'), danger: true })) return; await fetch(API_BASE + '/api/document/' + d.id, { method: 'DELETE', credentials: 'same-origin' }); _renderLibArchive(); } },
        ], { onSelect: () => {
          _arcSelectMode = true;
          _arcSelected.add('documents:' + d.id);
          document.getElementById('doclib-arc-bulk')?.classList.remove('hidden');
          _renderArcGrid();
        } }); });
        _attachLongPressMenu(card, '._arc-doc-menu');
        grid.appendChild(card);
      }
      // 已归档调研 — 放大镜图标，打开 / 恢复 / 删除。
      const _arcResIco = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;opacity:0.5;flex-shrink:0;"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
      for (const r of filtResearch) {
        const card = document.createElement('div');
        card.className = 'memory-item doclib-chat-row';
        card.style.cursor = 'pointer';
        card.dataset.arckey = 'research:' + r.id;
        const _rcb = _arcSelectMode ? '<input type="checkbox" class="memory-select-cb" data-arckey="research:' + r.id + '"' + (_arcSelected.has('research:' + r.id) ? ' checked' : '') + '>' : '';
        card.innerHTML =
          '<div class="doclib-chat-header" style="display:flex;align-items:center;width:100%;gap:6px;">' +
            _rcb +
            '<div style="flex:1;min-width:0;">' +
              '<div class="memory-item-title">' + _arcResIco + _esc(r.query || 'Research') + '</div>' +
              '<div class="memory-item-meta" style="font-size:10px;opacity:0.4;margin-top:2px;">' + ['Research', (r.source_count ? r.source_count + ' sources' : ''), _relTime(r.completed_at ? new Date(r.completed_at * 1000).toISOString() : '')].filter(Boolean).join(' · ') + '</div>' +
            '</div>' +
            '<div class="memory-item-actions"><button class="memory-item-btn _arc-res-menu" title="${t('library.actions')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button></div>' +
          '</div>' +
          '<div class="doclib-chat-preview" style="display:none;"></div>';
        const _rcbEl = card.querySelector('.memory-select-cb');
        if (_rcbEl) { _rcbEl.addEventListener('click', e => e.stopPropagation()); _rcbEl.addEventListener('change', () => { if (_rcbEl.checked) _arcSelected.add('research:' + r.id); else _arcSelected.delete('research:' + r.id); _updateArcCount(); }); }
        card.addEventListener('click', (e) => {
          if (e.target.closest('._arc-res-menu') || e.target.closest('.memory-select-cb')) return;
          if (_arcSelectMode) { const c = card.querySelector('.memory-select-cb'); if (c) { c.checked = !c.checked; if (c.checked) _arcSelected.add('research:' + r.id); else _arcSelected.delete('research:' + r.id); _updateArcCount(); } return; }
          _toggleResearchPreview(card, r);
        });
        card.querySelector('._arc-res-menu').addEventListener('click', (e) => { e.stopPropagation(); _showLibDropdown(e.currentTarget, [
          { label: t('common.open'), action: () => { const a = document.createElement('a'); a.href = '/api/research/report/' + r.id; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); } },
          { label: t('library.restore'), action: async () => { await fetch('/api/research/' + r.id + '/archive?archived=false', { method: 'POST', credentials: 'same-origin' }); _renderLibArchive(); } },
          { label: t('common.delete'), danger: true, action: async () => { if (!await window.styledConfirm(t('library.delete_research_confirm'), { confirmText: t('common.delete'), danger: true })) return; await fetch('/api/research/' + r.id, { method: 'DELETE', credentials: 'same-origin' }); _renderLibArchive(); } },
        ], { onSelect: () => {
          _arcSelectMode = true;
          _arcSelected.add('research:' + r.id);
          document.getElementById('doclib-arc-bulk')?.classList.remove('hidden');
          _renderArcGrid();
        } }); });
        _attachLongPressMenu(card, '._arc-res-menu');
        grid.appendChild(card);
      }
      _appendInlineLoadMore(grid, total, _arcVisibleLimit, () => {
        _arcVisibleLimit += _LIB_PAGE_SIZE;
        _renderArcGrid();
      });
    }

    function _renderArcChips() {
      const el = document.getElementById('doclib-arc-chips');
      if (!el) return;
      // 类型过滤器：全部/聊天/文档/调研（仅显示存在的类型）。
      el.innerHTML = '';
      const mk = (label, val, count) => {
        const c = document.createElement('button');
        c.className = 'memory-cat-chip' + (_arcTypeFilter === val ? ' active' : '');
        c.textContent = label + ' (' + count + ')';
        c.addEventListener('click', () => { _arcTypeFilter = _arcTypeFilter === val ? '' : val; _renderArcGrid(); _renderArcChips(); });
        el.appendChild(c);
      };
      const total = _arcSessions.length + _arcDocs.length + _arcResearch.length;
      if (!total) return;
      mk('All', '', total);
      if (_arcSessions.length) mk('Chats', 'chats', _arcSessions.length);
      if (_arcDocs.length) mk('Documents', 'documents', _arcDocs.length);
      if (_arcResearch.length) mk('Research', 'research', _arcResearch.length);
    }

    function _updateArcCount() { const el = document.getElementById('doclib-arc-selected-count'); if (el) el.textContent = _arcSelected.size + ' Selected'; }

    // 归档事件监听器
    document.getElementById('doclib-arc-sort').addEventListener('change', (e) => { _arcSort = e.target.value; _renderArcGrid(); });
    document.getElementById('doclib-arc-search').addEventListener('input', (e) => { _arcSearch = e.target.value.trim(); _renderArcGrid(); });
    document.getElementById('doclib-arc-select-btn').addEventListener('click', () => { _arcSelectMode = !_arcSelectMode; _arcSelected.clear(); document.getElementById('doclib-arc-bulk').classList.toggle('hidden', !_arcSelectMode); _renderArcGrid(); });
    document.getElementById('doclib-arc-bulk-cancel')?.addEventListener('click', () => {
      _arcSelectMode = false; _arcSelected.clear();
      document.getElementById('doclib-arc-bulk').classList.add('hidden');
      _renderArcGrid();
    });
    // 全选切换所有可见的已归档卡片（聊天 + 文档 + 调研），
    // 以卡片的复合"类型:id" data-arckey 为键。
    function _arcToggleAll() {
      const cbs = document.querySelectorAll('#doclib-arc-grid .memory-select-cb');
      const newState = _arcSelected.size < cbs.length;
      const allCb = document.getElementById('doclib-arc-select-all');
      if (allCb) allCb.checked = newState;
      cbs.forEach(cb => {
        cb.checked = newState;
        const k = cb.dataset.arckey;
        if (k) { if (newState) _arcSelected.add(k); else _arcSelected.delete(k); }
      });
      _updateArcCount();
    }
    document.getElementById('doclib-arc-select-all').addEventListener('change', _arcToggleAll);
    document.getElementById('doclib-arc-bulk').addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      _arcToggleAll();
    });
    // 将复合的"类型:id"键路由到正确的恢复/删除端点。
    function _arcRestoreOne(key) {
      const i = key.indexOf(':'), type = key.slice(0, i), id = key.slice(i + 1);
      if (type === 'documents') return fetch(API_BASE + '/api/document/' + id + '/archive?archived=false', { method: 'POST', credentials: 'same-origin' });
      if (type === 'research') return fetch('/api/research/' + id + '/archive?archived=false', { method: 'POST', credentials: 'same-origin' });
      return fetch(API_BASE + '/api/session/' + id + '/unarchive', { method: 'POST', credentials: 'same-origin' });
    }
    function _arcDeleteOne(key) {
      const i = key.indexOf(':'), type = key.slice(0, i), id = key.slice(i + 1);
      if (type === 'documents') return fetch(API_BASE + '/api/document/' + id, { method: 'DELETE', credentials: 'same-origin' });
      if (type === 'research') return fetch('/api/research/' + id, { method: 'DELETE', credentials: 'same-origin' });
      return fetch(API_BASE + '/api/session/' + id, { method: 'DELETE', credentials: 'same-origin' });
    }
    document.getElementById('doclib-arc-bulk-restore').addEventListener('click', async () => {
      if (!_arcSelected.size) return;
      await Promise.all([..._arcSelected].map(_arcRestoreOne));
      _arcSelected.clear(); _arcSelectMode = false;
      document.getElementById('doclib-arc-bulk').classList.add('hidden');
      _renderLibArchive();
    });
    document.getElementById('doclib-arc-bulk-delete').addEventListener('click', async () => {
      const count = _arcSelected.size;
      if (!count) return;
      if (!await window.styledConfirm(t('library.delete_archived_confirm', { n: count }), { confirmText: t('common.delete'), danger: true })) return;
      const grid = document.getElementById('doclib-arc-grid');
      if (grid) {
        grid.querySelectorAll('.memory-item[data-arckey]').forEach(card => {
          if (_arcSelected.has(card.dataset.arckey)) {
            card.style.transition = 'opacity 0.25s, transform 0.25s';
            card.style.opacity = '0';
            card.style.transform = 'scale(0.95)';
          }
        });
      }
      await new Promise(r => setTimeout(r, 250));
      await Promise.all([..._arcSelected].map(_arcDeleteOne));
      _arcSelected.clear();
      _arcSelectMode = false;
      document.getElementById('doclib-arc-bulk').classList.add('hidden');
      _renderLibArchive();
    });

    // ── 调研标签页 ──
    let _researchItems = [];
    let _researchSearch = '';
    let _researchSelectMode = false;
    let _researchArchivedView = false;
    const _researchSelected = new Set();

    async function _renderLibResearch() {
      const grid = document.getElementById('doclib-research-grid');
      const stats = document.getElementById('doclib-research-stats');
      if (!grid) return;
      // 显示我们的漩涡加载图标而非纯文本"加载中..."。
      grid.innerHTML = '';
      try {
        const _spm = (await import('./spinner.js')).default;
        const _sp = _spm.createWhirlpool(22);
        _sp.element.style.cssText = 'margin:18px auto;display:block;';
        grid.appendChild(_sp.element);
      } catch { grid.innerHTML = '<div class="hwfit-loading">Loading…</div>'; }
      try {
        const res = await fetch('/api/research/library' + (_researchArchivedView ? '?archived=true' : ''), { credentials: 'same-origin' });
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();
        _researchItems = data.research || data || [];
      } catch (e) {
        grid.innerHTML = `<div class="hwfit-loading">Failed to load: ${_esc(e.message)}</div>`;
        return;
      }
      _renderResearchGrid();
    }

    // 切换调研行的内联预览。镜像 _toggleChatPreview
     // 但拉取调研专用的元数据：查询、来源列表（截断），
     // 后跟打开完整报告的“打开”操作。
    async function _toggleResearchPreview(card, item) {
      const preview = card.querySelector('.doclib-chat-preview');
      if (!preview) return;
      const isOpen = card.classList.contains('doclib-card-expanded');
      const grid = card.closest('.doclib-grid');
      if (grid) {
        grid.querySelectorAll('.doclib-card-expanded').forEach(c => {
          if (c !== card) {
            c.classList.remove('doclib-card-expanded');
            const p = c.querySelector('.doclib-chat-preview');
            if (p) { p.style.display = 'none'; p.innerHTML = ''; }
          }
        });
      }
      if (isOpen) {
        card.classList.remove('doclib-card-expanded');
        preview.style.display = 'none';
        preview.innerHTML = '';
        return;
      }
      card.classList.add('doclib-card-expanded');
      preview.style.display = 'block';
      preview.innerHTML = '<div style="opacity:0.4;font-size:11px;padding:8px 4px;">Loading…</div>';
      let detail = item;
      try {
        // 请求每个调研的详情端点以获取来源 + 摘要。
        // 库列表端点仅返回轻量元数据。
        const res = await fetch(`${API_BASE}/api/research/detail/${item.id}`, { credentials: 'same-origin' });
        if (res.ok) detail = await res.json();
      } catch {}
      const sources = Array.isArray(detail.sources) ? detail.sources : [];
      const sourcesList = sources.slice(0, 12).map((src, i) => {
        const title = _esc(src.title || src.url || `Source ${i + 1}`);
        const url = _safeResearchHref(src.url);
        return url
          ? `<li><a href="${url}" target="_blank" rel="noopener">${title}</a></li>`
          : `<li>${title}</li>`;
      }).join('');
      const sourcesHtml = sources.length
        ? `<div class="doclib-research-sources"><div class="doclib-research-section-label">Sources (${sources.length})</div><ol>${sourcesList}${sources.length > 12 ? `<li style="opacity:0.5;">…and ${sources.length - 12} more</li>` : ''}</ol></div>`
        : '';
      // 存储的调研 JSON 将报告保存在 `result`（清理后）/
      // `raw_report`（原始 markdown）键下 — 两者都尝试。
      const summary = (detail.summary || detail.report_summary || detail.result || detail.raw_report || '').toString().trim();
      const summaryHtml = summary
        ? `<div class="doclib-research-summary"><div class="doclib-research-section-label">Report</div><div>${markdownModule.mdToHtml ? markdownModule.mdToHtml(summary) : _esc(summary)}</div></div>`
        : '';
      preview.innerHTML =
        '<div class="doclib-chat-preview-messages">' +
          (summaryHtml || sourcesHtml || '<div style="opacity:0.4;font-size:11px;padding:6px 4px;">${t('library.no_preview')}</div>') +
          (summaryHtml && sourcesHtml ? sourcesHtml : '') +
        '</div>' +
        '<div class="doclib-chat-preview-actions">' +
          '<button class="doclib-chat-delete-btn">' +
            '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>' +
            'Delete' +
          '</button>' +
          '<button class="doclib-chat-archive-btn">' +
            '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>' +
            ((_researchArchivedView || item.archived) ? 'Restore' : 'Archive') +
          '</button>' +
          // 在归档视图中隐藏讨论按钮，使底部栏与聊天一致
          // （删除 + 恢复 + 打开）。
          (item.archived ? '' :
          '<button class="doclib-chat-discuss-btn">' +
            '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
            'Discuss' +
          '</button>') +
          '<button class="doclib-chat-open-btn">' +
            '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>' +
            'Open' +
          '</button>' +
        '</div>';
      const discussBtn = preview.querySelector('.doclib-chat-discuss-btn');
      if (discussBtn) discussBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const _orig = discussBtn.innerHTML;
        discussBtn.disabled = true;
        discussBtn.textContent = t('library.creating');
        try {
          const _sid = detail.session_id || detail.id || item.id;
          const res = await fetch(`${API_BASE}/api/research/spinoff/${_sid}`, { method: 'POST', credentials: 'same-origin' });
          if (!res.ok) { let d = ''; try { d = (await res.json()).detail || ''; } catch {} throw new Error(d || ('HTTP ' + res.status)); }
          const payload = await res.json();
          if (window.sessionModule && payload.session_id) {
            await window.sessionModule.loadSessions().catch(() => {});
            await window.sessionModule.selectSession(payload.session_id);
          }
          closeLibrary();
        } catch (err) {
          discussBtn.disabled = false;
          discussBtn.innerHTML = _orig;
          if (uiModule) uiModule.showError('Could not start discussion: ' + (err.message || err));
        }
      });
      const openBtn = preview.querySelector('.doclib-chat-open-btn');
      if (openBtn) openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const a = document.createElement('a');
        a.href = '/api/research/report/' + item.id;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
      const delBtn = preview.querySelector('.doclib-chat-delete-btn');
      if (delBtn) delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = uiModule && uiModule.styledConfirm
          ? await uiModule.styledConfirm(t('library.delete_report_confirm'), { confirmText: t('common.delete'), danger: true })
          : window.confirm('Delete this research report?');
        if (!ok) return;
        try {
          const res = await fetch(`${API_BASE}/api/research/${item.id}`, { method: 'DELETE', credentials: 'same-origin' });
          if (!res.ok) throw new Error(await res.text());
          if (item.archived) {
            _renderLibArchive();
          } else {
            _researchItems = _researchItems.filter(r => r.id !== item.id);
            _renderResearchGrid();
          }
        } catch (err) {
          if (uiModule && uiModule.showError) uiModule.showError('Failed to delete: ' + err.message);
        }
      });
      const arcBtn = preview.querySelector('.doclib-chat-archive-btn');
      if (arcBtn) arcBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        // 从主归档标签页来看，项目已经归档了 → 恢复并
        // 刷新归档。从调研标签页，按之前的方式切换。
        const fromArchiveTab = !!item.archived;
        const toArchived = fromArchiveTab ? false : !_researchArchivedView;
        try {
          await fetch(`${API_BASE}/api/research/${item.id}/archive?archived=${toArchived}`, { method: 'POST', credentials: 'same-origin' });
          if (fromArchiveTab) {
            _renderLibArchive();
          } else {
            _researchItems = _researchItems.filter(r => r.id !== item.id);
            _renderResearchGrid();
          }
          if (uiModule) uiModule.showToast(toArchived ? t('library.archived') : 'Restored');
        } catch { if (uiModule) uiModule.showError('Failed to ' + (toArchived ? 'archive' : 'restore')); }
      });
    }

    function _renderResearchGrid() {
      const grid = document.getElementById('doclib-research-grid');
      const stats = document.getElementById('doclib-research-stats');
      if (!grid) return;
      const _rsb = document.getElementById('doclib-research-select-btn');
      if (_rsb) { _rsb.classList.toggle('active', _researchSelectMode); _rsb.textContent = _researchSelectMode ? t('common.cancel') : t('library.select'); }
      let items = _researchItems;
      if (_researchSearch) {
        const s = _researchSearch.toLowerCase();
        items = items.filter(r => (r.query || '').toLowerCase().includes(s));
      }
      // 排序
      const _rSort = document.getElementById('doclib-research-sort')?.value || 'recent';
      if (_rSort === 'recent') items.sort((a, b) => (b.completed_at || 0) - (a.completed_at || 0));
      else if (_rSort === 'oldest') items.sort((a, b) => (a.completed_at || 0) - (b.completed_at || 0));
      else if (_rSort === 'most-sources') items.sort((a, b) => (b.source_count || 0) - (a.source_count || 0));
      else if (_rSort === 'alpha') items.sort((a, b) => (a.query || '').localeCompare(b.query || ''));
      if (stats) stats.textContent = items.length + ' research' + (items.length !== 1 ? 'es' : '');
      if (!items.length) {
        grid.innerHTML =
          '<div class="hwfit-loading" style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;">' +
            '<span>' + t('library.no_research_yet') + '</span>' +
            '<span style="opacity:0.7;font-size:11px;">' +
              'create one in the <a href="#" data-doclib-open-research style="color:var(--accent,var(--red));text-decoration:underline;">Deep Research</a> tab' +
            '</span>' +
          '</div>';
        grid.querySelector('[data-doclib-open-research]')?.addEventListener('click', (e) => {
          e.preventDefault();
          document.getElementById('rail-research')?.click();
        });
        _appendInlineLoadMore(grid, 0, _researchVisibleLimit, () => {});
        return;
      }
      const total = items.length;
      items = items.slice(0, _researchVisibleLimit);
      let html = '';
      for (const r of items) {
        const date = r.completed_at ? new Date(r.completed_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        const time = r.completed_at ? new Date(r.completed_at * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
        const sources = r.source_count || 0;
        const duration = r.duration || '';
        const rounds = r.rounds || '';
        const selected = _researchSelected.has(r.id);
        const metaBits = [];
        if (date) metaBits.push(`${date} ${time}`);
        if (sources) metaBits.push(`${sources} sources`);
        if (rounds) metaBits.push(`${rounds} rounds`);
        if (duration) metaBits.push(`${duration}`);
        const metaText = metaBits.join(' \u00B7 ');
        html += `<div class="memory-item doclib-chat-row doclib-research-card" data-research-id="${r.id}" style="cursor:pointer;">`;
        html += `<div class="doclib-chat-header" style="display:flex;align-items:center;width:100%;gap:6px;">`;
        if (_researchSelectMode) html += `<input type="checkbox" class="memory-select-cb _res-cb" data-rid="${r.id}"${selected ? ' checked' : ''}>`;
        html += `<div style="flex:1;min-width:0;">`;
        html += `<div class="memory-item-title"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;opacity:0.4;flex-shrink:0;"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>${_esc(r.query || t('library.untitled_research'))}</div>`;
        html += `<div class="memory-item-meta" style="font-size:10px;opacity:0.4;margin-top:2px;">${metaText}</div>`;
        html += `</div>`;
        if (!_researchSelectMode) html += `<div class="memory-item-actions"><button class="memory-item-btn doclib-research-delete" data-rid="${r.id}" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button></div>`;
        html += `</div>`;
        html += `<div class="doclib-chat-preview" style="display:none;"></div>`;
        html += `</div>`;
      }
      grid.innerHTML = html;
      _maybeCascadeGrid(grid, 'research');

      // 绑定复选框
      grid.querySelectorAll('._res-cb').forEach(cb => {
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) _researchSelected.add(cb.dataset.rid); else _researchSelected.delete(cb.dataset.rid);
          _updateResearchCount();
        });
      });

      // 点击卡片 → 切换预览（聊天风格展开）。菜单按钮
      // 和预览内的打开报告按钮除外。
      grid.querySelectorAll('.doclib-research-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (card._suppressNextClick) { card._suppressNextClick = false; return; }
          if (e.target.closest('.doclib-research-delete') || e.target.closest('._res-cb') || e.target.closest('.doclib-chat-open-btn')) return;
          const rid = card.dataset.researchId;
          if (_researchSelectMode) {
            const cb = card.querySelector('._res-cb');
            if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
            return;
          }
          const item = _researchItems.find(r => r.id === rid);
          if (item) _toggleResearchPreview(card, item);
        });
        _attachLongPressMenu(card, '.doclib-research-delete');
      });

      // 每个调研行上的操作按钮打开操作菜单
      // （打开报告、删除）— 聊天风格的 ••• 菜单。
      grid.querySelectorAll('.doclib-research-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const rid = btn.dataset.rid;
          _showLibDropdown(btn, [
            { label: t('common.open'), action: () => {
                const a = document.createElement('a');
                a.href = '/api/research/report/' + rid;
                a.target = '_blank';
                a.rel = 'noopener';
                document.body.appendChild(a);
                a.click();
                a.remove();
              } },
            { label: _researchArchivedView ? 'Restore' : 'Archive', action: async () => {
                const toArchived = !_researchArchivedView;
                const card = btn.closest('.doclib-research-card');
                if (card) { card.style.transition = 'opacity 0.25s, transform 0.25s'; card.style.opacity = '0'; card.style.transform = 'scale(0.95)'; }
                try { await fetch('/api/research/' + rid + '/archive?archived=' + toArchived, { method: 'POST', credentials: 'same-origin' }); } catch {}
                await new Promise(r => setTimeout(r, 200));
                _researchItems = _researchItems.filter(r => r.id !== rid);
                _renderResearchGrid();
                if (uiModule) uiModule.showToast(toArchived ? t('library.archived') : 'Restored');
              } },
            { label: t('common.delete'), danger: true, action: async () => {
                if (!await window.styledConfirm(t('library.delete_research_confirm'), { confirmText: t('common.delete'), danger: true })) return;
                const card = btn.closest('.doclib-research-card');
                if (card) {
                  card.style.transition = 'opacity 0.25s, transform 0.25s';
                  card.style.opacity = '0';
                  card.style.transform = 'scale(0.95)';
                }
                await new Promise(r => setTimeout(r, 250));
                await fetch('/api/research/' + rid, { method: 'DELETE', credentials: 'same-origin' });
                _researchItems = _researchItems.filter(r => r.id !== rid);
                _renderResearchGrid();
              } },
          ], { onSelect: () => {
            _researchSelectMode = true;
            _researchSelected.add(rid);
            document.getElementById('doclib-research-bulk')?.classList.remove('hidden');
            _renderResearchGrid();
          } });
        });
      });
      _appendInlineLoadMore(grid, total, _researchVisibleLimit, () => {
        _researchVisibleLimit += _LIB_PAGE_SIZE;
        _renderResearchGrid();
      });
    }

    // 调研排序 + 搜索
    const researchSortEl = document.getElementById('doclib-research-sort');
    if (researchSortEl) researchSortEl.addEventListener('change', () => _renderResearchGrid());
    const researchSearchEl = document.getElementById('doclib-research-search');
    if (researchSearchEl) {
      researchSearchEl.addEventListener('input', () => {
        _researchSearch = researchSearchEl.value.trim();
        _renderResearchGrid();
      });
    }

    function _updateResearchCount() {
      const el = document.getElementById('doclib-research-selected-count');
      if (el) el.textContent = _researchSelected.size + ' Selected';
      const arc = document.getElementById('doclib-research-bulk-archive');
      if (arc) arc.textContent = _researchArchivedView ? 'Restore' : 'Archive';
    }

    // 调研选择模式
    document.getElementById('doclib-research-select-btn')?.addEventListener('click', () => {
      _researchSelectMode = !_researchSelectMode;
      _researchSelected.clear();
      document.getElementById('doclib-research-bulk').classList.toggle('hidden', !_researchSelectMode);
      _renderResearchGrid();
    });

    // 调研整理 — 删除空返回的报告（无来源，或 result + raw_report
    // 都是极小的占位文本）。
    // 并跳过确认对话框（按用户要求）。
    document.getElementById('doclib-research-tidy-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const origHTML = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('spinning');
      btn.textContent = '';
      const sp = spinnerModule.create('', 'clean', 'whirlpool');
      const el = sp.createElement();
      el.style.position = 'relative';
      el.style.top = '1px';
      btn.appendChild(el);
      sp.start();
      try {
        const candidates = [];
        const needFetch = [];
        for (const r of _researchItems) {
          if ((r.source_count || 0) === 0) candidates.push(r);
          else needFetch.push(r);
        }
        const results = await Promise.all(needFetch.map(async r => {
          try {
            const res = await fetch('/api/research/detail/' + r.id, { credentials: 'same-origin' });
            if (!res.ok) return null;
            const d = await res.json();
            // 后端 JSON 使用 `result`（渲染后）或 `raw_report`（原始 markdown）。
            // 如果两者都不存在或都很小，视为空。
            const body = (d.result || d.raw_report || '').trim();
            return body.length < 200 ? r : null;
          } catch { return null; }
        }));
        for (const r of results) if (r) candidates.push(r);
        if (candidates.length === 0) {
          if (uiModule) uiModule.showToast('Nothing to tidy');
          return;
        }
        await Promise.all(candidates.map(r => fetch('/api/research/' + r.id, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {})));
        const ids = new Set(candidates.map(r => r.id));
        _researchItems = _researchItems.filter(r => !ids.has(r.id));
        _renderResearchGrid();
        if (uiModule) uiModule.showToast('Deleted ' + candidates.length);
      } finally {
        sp.stop();
        btn.disabled = false;
        btn.classList.remove('spinning');
        btn.innerHTML = origHTML;
      }
    });
    document.getElementById('doclib-research-archived-btn')?.addEventListener('click', (e) => {
      _researchArchivedView = !_researchArchivedView;
      e.currentTarget.classList.toggle('active', _researchArchivedView);
      e.currentTarget.title = _researchArchivedView ? 'Show active research' : 'Show archived research';
      if (_researchSelectMode) { _researchSelectMode = false; _researchSelected.clear(); document.getElementById('doclib-research-bulk').classList.add('hidden'); }
      _renderLibResearch();
    });
    document.getElementById('doclib-research-bulk-cancel')?.addEventListener('click', () => {
      _researchSelectMode = false;
      _researchSelected.clear();
      document.getElementById('doclib-research-bulk').classList.add('hidden');
      _renderResearchGrid();
    });

    // 调研全选
    document.getElementById('doclib-research-select-all')?.addEventListener('change', () => {
      const allCb = document.getElementById('doclib-research-select-all');
      const newState = allCb?.checked;
      _researchItems.forEach(r => { if (newState) _researchSelected.add(r.id); else _researchSelected.delete(r.id); });
      _updateResearchCount();
      _renderResearchGrid();
    });

    // 调研批量删除
    document.getElementById('doclib-research-bulk-delete')?.addEventListener('click', async () => {
      const count = _researchSelected.size;
      if (!count) return;
      if (!await window.styledConfirm(t('library.delete_reports_confirm', { n: count }), { confirmText: t('common.delete'), danger: true })) return;
      const grid = document.getElementById('doclib-research-grid');
      if (grid) {
        grid.querySelectorAll('.doclib-research-card').forEach(card => {
          if (_researchSelected.has(card.dataset.researchId)) {
            card.style.transition = 'opacity 0.25s, transform 0.25s';
            card.style.opacity = '0';
            card.style.transform = 'scale(0.95)';
          }
        });
      }
      await new Promise(r => setTimeout(r, 250));
      await Promise.all([..._researchSelected].map(rid => fetch('/api/research/' + rid, { method: 'DELETE', credentials: 'same-origin' })));
      _researchItems = _researchItems.filter(r => !_researchSelected.has(r.id));
      _researchSelected.clear();
      _researchSelectMode = false;
      document.getElementById('doclib-research-bulk').classList.add('hidden');
      _renderResearchGrid();
    });

    // 调研批量归档 / 恢复
    document.getElementById('doclib-research-bulk-archive')?.addEventListener('click', async () => {
      const count = _researchSelected.size;
      if (!count) return;
      const toArchived = !_researchArchivedView;
      const grid = document.getElementById('doclib-research-grid');
      if (grid) {
        grid.querySelectorAll('.doclib-research-card').forEach(card => {
          if (_researchSelected.has(card.dataset.researchId)) {
            card.style.transition = 'opacity 0.25s, transform 0.25s';
            card.style.opacity = '0';
            card.style.transform = 'scale(0.95)';
          }
        });
      }
      await new Promise(r => setTimeout(r, 250));
      await Promise.all([..._researchSelected].map(rid => fetch('/api/research/' + rid + '/archive?archived=' + toArchived, { method: 'POST', credentials: 'same-origin' })));
      _researchItems = _researchItems.filter(r => !_researchSelected.has(r.id));
      _researchSelected.clear();
      _researchSelectMode = false;
      document.getElementById('doclib-research-bulk').classList.add('hidden');
      _renderResearchGrid();
      if (uiModule) uiModule.showToast(toArchived ? t('library.archived') : 'Restored');
    });

    // 聊天/归档菜单的共享下拉菜单 — 在下面的模块作用域中定义
    // （原本在此函数内；提升为模块作用域以便 libraryCreateCard 的移动端 kebab
    // 处理程序可以调用它，该处理程序位于 openLibrary 闭包之外）。

    function _relTime(iso) {
      if (!iso) return '';
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      if (days < 30) return days + 'd ago';
      return new Date(iso).toLocaleDateString();
    }

    // 切换到初始标签页。始终调用此方法 — 即使调用者已经设置了一个标签页，
    // 我们也需要知道*我们*打开了哪个标签页。
    // 首次打开时从"库"同步到活跃的子标签页。
    _switchLibTab(_activeLibTab);

    const searchInput = document.getElementById('doclib-search');
    searchInput.addEventListener('input', () => {
      clearTimeout(_librarySearchDebounce);
      _librarySearchDebounce = setTimeout(() => {
        _librarySearch = searchInput.value.trim();
        libraryFetch(false);
      }, 300);
    });

    document.getElementById('doclib-sort').addEventListener('change', (e) => {
      _librarySort = e.target.value;
      libraryFetch(false);
    });

    document.getElementById('doclib-load-more').addEventListener('click', () => {
      _libraryOffset = _libraryDocs.length;
      libraryFetch(true);
    });

    // 仅当滚动到接近底部时显示"加载更多"
    const grid = document.getElementById('doclib-grid');
    if (grid) {
      grid.addEventListener('scroll', () => libraryRenderLoadMore());
      // 调整大小时自动填充（全屏切换、窗口调整大小、侧边栏
      // 切换）：重新运行加载更多检查，以便新露出的
      // 最后一个卡片下方的空白空间自动拉取下一页。
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => libraryRenderLoadMore()).observe(grid);
      }
    }

    // 绑定文件导入按钮
    const importFileBtn = document.getElementById('doclib-import-file-btn');
    const fileInput = document.getElementById('doclib-file-input');
    if (importFileBtn && fileInput) {
      importFileBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        if (fileInput.files.length === 0) return;
        const files = Array.from(fileInput.files);
        fileInput.value = '';
        // 文件上传时将导入图标替换为漩涡加载图标。
        const _orig = importFileBtn.innerHTML;
        importFileBtn.disabled = true;
        let _sp = null;
        try {
          _sp = spinnerModule.createWhirlpool(12);
          _sp.element.style.cssText = 'width:12px;height:12px;margin:0 4px 0 0;display:inline-block;vertical-align:middle;position:relative;top:-2px;';
          importFileBtn.innerHTML = '';
          importFileBtn.appendChild(_sp.element);
          importFileBtn.appendChild(document.createTextNode('Import'));
        } catch {}
        try {
          await libraryImportFiles(files);
        } finally {
          try { _sp && _sp.stop(); } catch {}
          importFileBtn.innerHTML = _orig;
          importFileBtn.disabled = false;
        }
      });
    }

    // 新建按钮 — 新建空白文档
    const createBtn = document.getElementById('doclib-create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', async () => {
        // 创建新会话，然后在其中创建空白文档
        try {
          const sRes = await fetch('/api/session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t('library.untitled_document') }) });
          const sData = await sRes.json();
          const sessionId = sData.session_id;
          await _createDocument(sessionId);
          // 关闭库并打开新会话
          closeLibrary();
          if (window.sessionsModule) window.sessionsModule.loadSession(sessionId);
          setTimeout(() => _openPanel(), 300);
        } catch (e) {
          console.error('Failed to create document:', e);
          if (uiModule) uiModule.showError('Failed to create document');
        }
      });
    }

    // 归档切换 — 在活跃和已归档之间切换文档列表。
    const archivedBtn = document.getElementById('doclib-archived-btn');
    if (archivedBtn) archivedBtn.addEventListener('click', () => {
      _libraryArchivedView = !_libraryArchivedView;
      archivedBtn.classList.toggle('active', _libraryArchivedView);
      archivedBtn.title = _libraryArchivedView ? 'Show active documents' : 'Show archived documents';
      if (_librarySelectMode) libraryExitSelectMode();
      libraryFetch(false);
    });

    // 整理按钮 — 移除空/损坏的文档
    const tidyBtn = document.getElementById('doclib-tidy-btn');
    if (tidyBtn) tidyBtn.addEventListener('click', async () => {
      tidyBtn.disabled = true;
      tidyBtn.classList.add('spinning');
      const origHTML = tidyBtn.innerHTML;
      tidyBtn.textContent = '';
      const spinner = spinnerModule.create('', 'clean', 'whirlpool');
      const _spEl = spinner.createElement();
      // 视觉对齐：漩涡图标在按钮内看起来偏高了 1px。
      _spEl.style.position = 'relative';
      _spEl.style.top = '1px';
      tidyBtn.appendChild(_spEl);
      spinner.start();

      let totalDeleted = 0;
      let totalFixed = 0;
      let aiMessage = '';
      try {
        // 第一阶段：正则整理（空/损坏的文档）
        const [res1] = await Promise.all([
          fetch(`${API_BASE}/api/documents/tidy`, { method: 'POST' }),
          new Promise(r => setTimeout(r, 600)),
        ]);
        if (res1.ok) {
          const d1 = await res1.json();
          totalDeleted += d1.deleted || 0;
          totalFixed += d1.fixed_titles || 0;
        }

        // 第二阶段：AI 整理（垃圾/测试文档检测）
        try {
          const res2 = await fetch(`${API_BASE}/api/documents/ai-tidy`, { method: 'POST' });
          if (res2.ok) {
            const d2 = await res2.json();
            totalDeleted += d2.deleted || 0;
            if (d2.message) aiMessage = d2.message;
          }
        } catch (_) { /* AI tidy is optional */ }

        spinner.destroy();

        if (totalDeleted === 0 && totalFixed === 0) {
          tidyBtn.innerHTML = '<span style="opacity:0.7">Already tidy</span>';
        } else {
          const msg = aiMessage || `Removed ${totalDeleted} document${totalDeleted !== 1 ? 's' : ''}`;
          if (uiModule) uiModule.showToast(msg);
          libraryFetch(false);
        }
        setTimeout(() => { tidyBtn.innerHTML = origHTML; tidyBtn.disabled = false; tidyBtn.classList.remove('spinning'); }, 1500);
      } catch (e) {
        spinner.destroy();
        console.error('Document tidy failed:', e);
        if (uiModule) uiModule.showToast('Tidy failed');
        tidyBtn.disabled = false;
        tidyBtn.classList.remove('spinning');
        tidyBtn.innerHTML = origHTML;
      }
    });

    // 选择模式
    const selectBtn = document.getElementById('doclib-select-btn');
    if (selectBtn) selectBtn.addEventListener('click', () => {
      if (_librarySelectMode) libraryExitSelectMode();
      else libraryEnterSelectMode();
    });

    const selectAll = document.getElementById('doclib-select-all');
    if (selectAll) selectAll.addEventListener('change', libraryToggleSelectAll);

    // 点击批量操作栏"全部"标签或计数区域的任意位置以切换全选
    const bulkCheckLabel = modal.querySelector('.memory-bulk-check-all');
    if (bulkCheckLabel) {
      bulkCheckLabel.addEventListener('click', (e) => {
        if (e.target === selectAll) return; // let native checkbox handle it
        e.preventDefault();
        selectAll.checked = !selectAll.checked;
        libraryToggleSelectAll();
      });
    }
    const selectedCountEl = document.getElementById('doclib-selected-count');
    if (selectedCountEl) {
      selectedCountEl.style.cursor = 'pointer';
      selectedCountEl.addEventListener('click', () => {
        selectAll.checked = !selectAll.checked;
        libraryToggleSelectAll();
      });
    }

    const bulkActionsBtn = document.getElementById('doclib-bulk-actions');
    if (bulkActionsBtn) bulkActionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_librarySelectedIds.size === 0) {
        if (uiModule) uiModule.showToast('Select documents first');
        return;
      }
      _showLibDropdown(e.currentTarget, [
        { label: _libraryArchivedView ? 'Restore' : 'Archive', icon: _libraryArchivedView ? 'restore' : 'archive', action: libraryBulkArchive },
        { label: 'Clone', icon: 'clone', action: libraryBulkClone },
        { label: 'Export', icon: 'open', action: libraryBulkExport },
        { label: t('common.delete'), icon: 'delete', danger: true, action: libraryBulkDelete },
      ], { onCancel: libraryExitSelectMode });
    });

    const bulkCancelBtn = document.getElementById('doclib-bulk-cancel');
    if (bulkCancelBtn) bulkCancelBtn.addEventListener('click', libraryExitSelectMode);

    // 点击弹窗内容外部时关闭
    modal.addEventListener('click', (e) => {
      if (uiModule.isTouchInsideModal()) return;
      if (e.target === modal) closeLibrary();
    });

    // Escape 键
    _libraryEscHandler = (e) => {
      if (e.key === 'Escape') {
        // 先折叠已展开的卡片，第二次按 Escape 时关闭弹窗
        const expanded = document.querySelector('#doclib-grid .doclib-card-expanded');
        if (expanded) {
          _collapseExpandedCard(expanded);
        } else {
          closeLibrary();
        }
      }
    };
    document.addEventListener('keydown', _libraryEscHandler);

    // 切换工具按钮的活跃状态
    const btn = document.getElementById('tool-doclib-btn');
    if (btn) btn.classList.add('active');

    libraryFetch(false);
    if (window.innerWidth >= 768) searchInput.focus();
  }

  export function closeLibrary() {
    if (!_libraryOpen) return;
    _libraryOpen = false;
    _librarySelectMode = false;
    _librarySelectedIds.clear();
    _libraryImportMode = false;
    clearTimeout(_librarySearchDebounce);

    const modal = document.getElementById('doclib-modal');
    if (modal) {
      const content = modal.querySelector('.modal-content, .doclib-modal-content');
      if (content) {
        content.classList.add('modal-closing');
        content.addEventListener('animationend', () => modal.remove(), { once: true });
        setTimeout(() => { if (modal.parentElement) modal.remove(); }, 250);
      } else {
        modal.remove();
      }
    }

    if (_libraryEscHandler) {
      document.removeEventListener('keydown', _libraryEscHandler);
      _libraryEscHandler = null;
    }

    const btn = document.getElementById('tool-doclib-btn');
    if (btn) btn.classList.remove('active');
  }

  export function isLibraryOpen() {
    return _libraryOpen;
  }
