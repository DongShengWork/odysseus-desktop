// 会话管理函数
// 本模块处理所有与会话相关的操作

import Storage from './storage.js';
import uiModule, { styledPrompt } from './ui.js';
import markdownModule from './markdown.js';
import chatRenderer from './chatRenderer.js';
import { providerLogo } from './providers.js';
import { initModelPicker, updateModelPicker } from './modelPicker.js';
import themeModule from './theme.js';
import spinnerModule from './spinner.js';
import { t } from './i18n.js';

const API_BASE = window.location.origin;

let sessions = [];
let currentSessionId = null;
let _sessionNavToken = 0;
let _skipAutoSelect = false;

const SIDEBAR_MAX_VISIBLE = 10;
const FOLDER_MAX_VISIBLE = 5;
let _showAllSessions = false;
let _expandedFolders = {};  // folderName -> true 表示已点击"显示更多"
let _sortMode = Storage.get('odysseus-session-sort') || 'active'; // 默认按最近活跃排序
let _autoCreateInProgress = false; // 防止递归自动创建
const _INCOGNITO_SESSIONS_KEY = 'ody-incognito-sessions'; // 隐身会话 ID 的 sessionStorage 键
const _isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const _mod = _isMac ? '⌘' : 'Ctrl';

function _getIncognitoIds() {
  try { return JSON.parse(sessionStorage.getItem(_INCOGNITO_SESSIONS_KEY) || '[]'); } catch { return []; }
}
function _markIncognito(sid) {
  const ids = _getIncognitoIds();
  if (!ids.includes(sid)) { ids.push(sid); sessionStorage.setItem(_INCOGNITO_SESSIONS_KEY, JSON.stringify(ids)); }
}
function _isIncognitoSession(sid) { return _getIncognitoIds().includes(sid); }
async function _cleanupIncognitoSessions() {
  const ids = _getIncognitoIds();
  if (ids.length === 0) return;
  // 保留当前活跃的隐身会话，删除其余
  const toDelete = ids.filter(sid => sid !== currentSessionId);
  if (toDelete.length === 0) return;
  const keep = ids.filter(sid => sid === currentSessionId);
  sessionStorage.setItem(_INCOGNITO_SESSIONS_KEY, JSON.stringify(keep));
  await Promise.all(toDelete.map(sid =>
    fetch(`${API_BASE}/api/session/${sid}`, { method: 'DELETE' }).catch(() => {})
  ));
}

// Research 状态指示器跟踪
const _researchingSessions = new Set();
const _streamingSessions = new Set();   // 后台聊天流（不通过 Research API 轮询）
const _completedSessions = new Set();   // 已完成后台流的会话
let _researchPollTimer = null;

// 会话列表键盘导航状态
let _sessionListFocused = false;

/** 从 UI 中清除当前会话（删除/归档后调用）。 */
function _deselectCurrentSession(sid) {
  if (currentSessionId !== sid) return;
  currentSessionId = null;
  uiModule.el('chat-history').innerHTML = '';
  uiModule.el('current-meta').textContent = t('sessions.odysseus_chat');
  Storage.remove('lastSessionId');
  history.replaceState(null, '', window.location.pathname);
  if (window.chatModule && window.chatModule.showWelcomeScreen) {
    window.chatModule.showWelcomeScreen();
  }
  // 将发送按钮重置为空闲状态
  const submitBtn = document.querySelector('.send-btn');
  if (submitBtn) {
    submitBtn.dataset.mode = '';
    delete submitBtn.dataset.phase;
    submitBtn.classList.remove('recording');
  }
  if (window._updateSendBtnIcon) window._updateSendBtnIcon();
}

function _removeSessionFromLocalState(sid) {
  if (!sid) return;
  const id = String(sid);
  sessions = sessions.filter(s => String(s.id) !== id);
  _selectedIds.delete(id);
  try {
    const savedOrder = Storage.get('session-order');
    if (savedOrder) {
      const orderIds = JSON.parse(savedOrder);
      if (Array.isArray(orderIds) && orderIds.some(x => String(x) === id)) {
        Storage.set('session-order', JSON.stringify(orderIds.filter(x => String(x) !== id)));
      }
    }
  } catch (e) {
    console.warn('Failed to prune deleted session order:', e);
  }
  document.querySelectorAll('.list-item[data-session-id]').forEach(el => {
    if (String(el.dataset.sessionId) === id) el.remove();
  });
  _deselectCurrentSession(id);
}

function _normalizeSessionsList(fetched) {
  if (!Array.isArray(fetched)) return [];
  const seen = new Set();
  const unique = [];
  for (const session of fetched) {
    if (!session || session.id == null) continue;
    const id = String(session.id);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(session);
  }
  return unique;
}

// 从 app.js 初始化依赖（空操作：依赖现在直接导入）
export function initDependencies() {}

// ── 文件夹状态持久化 ──
const FOLDER_STATE_KEY = 'odysseus-folder-state';
const FOLDER_ORDER_KEY = 'odysseus-folder-order';

function loadFolderState() {
  return Storage.getJSON(FOLDER_STATE_KEY, {});
}
function saveFolderState(state) {
  Storage.setJSON(FOLDER_STATE_KEY, state);
}
function loadFolderOrder() {
  return Storage.getJSON(FOLDER_ORDER_KEY, []);
}
function saveFolderOrder(order) {
  Storage.setJSON(FOLDER_ORDER_KEY, order);
}

/** 获取当前会话中所有唯一的文件夹名称。 */
function getFolderNames() {
  const names = new Set();
  sessions.forEach(s => { if (s.folder) names.add(s.folder); });
  return Array.from(names).sort();
}

/** 通过 API 将会话移动到某个文件夹。 */
async function moveToFolder(sessionId, folderName) {
  const fd = new FormData();
  fd.append('folder', folderName || '');
  await fetch(`${API_BASE}/api/session/${sessionId}`, { method: 'PATCH', body: fd });
  // 更新本地数据
  const s = sessions.find(x => x.id === sessionId);
  if (s) s.folder = folderName || null;
  renderSessionList();
}

/** 构建会话下拉菜单中的"移动到文件夹"子菜单。 */
function buildFolderSubmenu(sessionId, currentFolder, dropdown) {
  const folders = getFolderNames();

  const moveItem = document.createElement('div');
  moveItem.className = 'dropdown-item-compact';
  moveItem.style.position = 'relative';
  const _folderIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  moveItem.innerHTML = '<span class="dropdown-icon">' + _folderIcon + '</span><span>' + t('sessions.move_to_folder') + '</span>';

  const sub = document.createElement('div');
  sub.className = 'dropdown session-folder-submenu';

  // "无文件夹"选项
  const noneOpt = document.createElement('div');
  noneOpt.className = 'dropdown-item-compact';
  if (!currentFolder) noneOpt.style.opacity = '0.5';
  noneOpt.textContent = t('sessions.no_folder');
  noneOpt.addEventListener('click', async (e) => {
    e.stopPropagation();
    await moveToFolder(sessionId, '');
    dropdown.style.display = 'none';
    sub.style.display = 'none';
  });
  sub.appendChild(noneOpt);

  // 已有文件夹
  folders.forEach(f => {
    const opt = document.createElement('div');
    opt.className = 'dropdown-item-compact';
    if (f === currentFolder) opt.style.opacity = '0.5';
    opt.textContent = f;
    opt.addEventListener('click', async (e) => {
      e.stopPropagation();
      await moveToFolder(sessionId, f);
      // 自动切换到"按文件夹"视图让用户看到聊天
      // 去了哪里，与创建新文件夹时行为一致。
      setSortMode('group');
      dropdown.style.display = 'none';
      sub.style.display = 'none';
    });
    sub.appendChild(opt);
  });

  // "新建文件夹"选项
  const newOpt = document.createElement('div');
  newOpt.className = 'dropdown-item-compact';
  newOpt.style.color = 'var(--accent-primary)';
  newOpt.textContent = t('sessions.new_folder');
  newOpt.addEventListener('click', async (e) => {
    e.stopPropagation();
    const name = await styledPrompt(t('sessions.name_folder_prompt'), {
      title: t('sessions.rename_folder_title'),
      placeholder: 'e.g. Work, Research, Drafts',
      confirmText: t('common.create'),
    });
    if (!name || !name.trim()) return;
    await moveToFolder(sessionId, name.trim());
    // 自动切换到"按文件夹"视图让用户立即看到
    // 刚创建的文件夹 — 否则新文件夹消失在
    // 平铺列表中，看起来像什么都没发生。
    setSortMode('group');
    dropdown.style.display = 'none';
    sub.style.display = 'none';
  });
  sub.appendChild(newOpt);

  moveItem.addEventListener('click', (e) => {
    e.stopPropagation();
    if (sub.style.display === 'block') {
      sub.style.display = 'none';
    } else {
      const rect = moveItem.getBoundingClientRect();
      const isMobile = window.innerWidth <= 768;
      sub.style.top = '-9999px';
      sub.style.display = 'block';
      const subRect = sub.getBoundingClientRect();

      if (isMobile) {
        // 移动端：定位在下拉菜单下方，居中
        const ddRect = dropdown.getBoundingClientRect();
        sub.style.left = Math.max(8, ddRect.left) + 'px';
        sub.style.width = Math.min(ddRect.width, window.innerWidth - 16) + 'px';
        const topBelow = ddRect.bottom + 4;
        if (topBelow + subRect.height > window.innerHeight) {
          sub.style.top = Math.max(8, ddRect.top - subRect.height - 4) + 'px';
        } else {
          sub.style.top = topBelow + 'px';
        }
      } else {
        // 桌面端：定位在右侧
        sub.style.left = rect.right + 2 + 'px';
        sub.style.width = '';
        if (rect.top + subRect.height > window.innerHeight) {
          sub.style.top = Math.max(2, window.innerHeight - subRect.height - 4) + 'px';
        } else {
          sub.style.top = rect.top + 'px';
        }
        // 限制右边界
        if (rect.right + 2 + subRect.width > window.innerWidth - 8) {
          sub.style.left = Math.max(8, rect.left - subRect.width - 2) + 'px';
        }
      }
    }
  });

  sub.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { sub.style.display = 'none'; });
  document.body.appendChild(sub);

  return moveItem;
}

/** 创建单个会话列表项元素。 */
function createSessionItem(s) {
  const div = document.createElement('div');
  div.className = 'list-item session-item';
  div.setAttribute('role', 'option');
  div.setAttribute('tabindex', '-1');
  div.setAttribute('data-session-id', s.id);
  // 特殊会话标记 — 旧版 OpenClaw 行跳过常规的提供商
  // 圆点/名称/操作装饰。之前在此处检测但声明被移除
  // 引用还在，导致每次会话列表重渲染时抛出
  // ReferenceError。
  const isOpenClaw = s.is_openclaw || s.id === 'openclaw';

  // 拖拽手柄
  const handle = document.createElement('span');
  handle.className = 'item-drag-handle';
  handle.textContent = '\u22EE\u22EE';
  handle.title = t('sessions.drag_to_reorder');
  div.appendChild(handle);

  // 提供商圆点指示器
  if (!isOpenClaw) {
    const star = document.createElement('span');
    const _logo = providerLogo(s.model);
    if (_logo) {
      star.className = 'session-star provider-logo';
      star.innerHTML = _logo;
      star.style.opacity = '0.4';
    } else {
      star.className = 'session-star';
    }
    div.appendChild(star);
  }

  // 会话类型图标
  const icon = document.createElement('span');
  const _isFork = s.name && (s.name.startsWith('Fork:') || s.name.startsWith('\u2ADD'));
  const _isGroup = s.name && s.name.startsWith('[GRP]');
  icon.className = 'session-icon' + (s.has_documents ? ' has-docs' : '');
  if (_isGroup) {
    icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  } else if (_isFork) {
    icon.textContent = '\u2ADD';
    icon.style.fontSize = '14px';
  } else if (s.has_documents) {
    icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  } else if (s.has_images) {
    icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
  } else if (s.mode === 'agent') {
    icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
  } else if (s.mode === 'research') {
    icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
  } else {
    icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  }
  // 标记为重要时，收藏书签替换会话图标
  if (s.is_important && !isOpenClaw) {
    icon.className = 'session-icon session-fav';
    icon.title = t('sessions.unfavorite');
    icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
    icon.addEventListener('click', async (e) => {
      e.stopPropagation();
      const fd = new FormData();
      fd.append('important', false);
      await fetch(`${API_BASE}/api/session/${s.id}/important`, { method: 'POST', body: fd });
      s.is_important = false;
      uiModule.showToast(t('sessions.unfavorited'));
      renderSessionList();
    });
  }
  div.appendChild(icon);

  const span = document.createElement('span');
  span.className = 'grow';
  let chatTitle = s.name || '';
  if (_isFork) chatTitle = chatTitle.replace(/^Fork:\s*/, '').replace(/^\u2ADD\s*/, '');
  if (_isGroup) chatTitle = chatTitle.replace(/^\[GRP\]\s*/, '');
  let label = chatTitle;
  if (s.model) label += ' · ' + s.model.split('/').pop();
  if (s.archived) label += ' ' + t('sessions.archived_label');
  span.textContent = label;
  span.title = (s.model ? s.model.split('/').pop() + ' · ' : '') + chatTitle;
  span.classList.add('text-ellipsis');

  // 双击重命名（仅当会话已被选中时）
  if (!isOpenClaw) {
    span.addEventListener('dblclick', (e) => {
      if (currentSessionId !== s.id) return; // 必须先选中该会话
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.value = s.name || '';
      input.className = 'session-rename-input';
      span.replaceWith(input);
      input.focus();
      input.select();
      const _stopGuard = _guardSidebarDuringRename();
      const commit = async () => {
        const newName = input.value.trim();
        if (newName && newName !== s.name) {
          const fd = new FormData();
          fd.append('name', newName);
          await fetch(`${API_BASE}/api/session/${s.id}`, { method: 'PATCH', body: fd });
          s.name = newName;
          uiModule.showToast(t('notification.renamed'));
        }
        _forceSidebarOpen();
        renderSessionList();
        _stopGuard();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { input.removeEventListener('blur', commit); _forceSidebarOpen(); renderSessionList(); _stopGuard(); }
      });
    });
  }

  // 点击行上任意位置选中会话（拖拽手柄和菜单除外）
  // 移动端：如果用户在滚动则抑制点击（检测到 touchmove）
  // 移动端长按显示上下文菜单
  let _touchMoved = false;
  let _longPressTimer = null;
  let _longPressed = false;
  div.addEventListener('touchstart', (e) => {
    _touchMoved = false;
    _longPressed = false;
    if (window.innerWidth > 768) return;
    _longPressTimer = setTimeout(() => {
      _longPressed = true;
      // 触觉反馈（如果可用）
      if (navigator.vibrate) navigator.vibrate(30);
      // 直接显示会话下拉菜单（移动端菜单按钮已隐藏）
      const dd = div._sessionDropdown;
      if (dd) {
        // 关闭其他已打开的下拉菜单
        document.querySelectorAll('.dropdown').forEach(d => { if (d !== dd) d.style.display = 'none'; });
        const rect = div.getBoundingClientRect();
        dd.style.position = 'fixed';
        dd.style.left = rect.left + 'px';
        dd.style.top = (rect.bottom + 4) + 'px';
        dd.style.right = 'auto';
        dd.style.display = 'block';
        dd.style.zIndex = '1000';
        // 限制在视口内
        requestAnimationFrame(() => {
          const mr = dd.getBoundingClientRect();
          if (mr.bottom > window.innerHeight - 8) dd.style.top = (rect.top - mr.height - 4) + 'px';
          if (mr.right > window.innerWidth - 8) { dd.style.left = 'auto'; dd.style.right = '8px'; }
        });
        // 点击外部关闭
        const close = (ev) => { if (!dd.contains(ev.target)) { dd.style.display = 'none'; document.removeEventListener('click', close, true); } };
        setTimeout(() => document.addEventListener('click', close, true), 100);
      }
    }, 500);
  }, { passive: true });
  div.addEventListener('touchmove', () => {
    _touchMoved = true;
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
  }, { passive: true });
  div.addEventListener('touchend', () => {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
  }, { passive: true });
  div.addEventListener('click', (e) => {
    if (e.target.closest('.item-drag-handle') || e.target.closest('.session-fav') || e.target.closest('.hamburger') || e.target.closest('.session-dropdown') || e.target.closest('.session-rename-input') || e.target.closest('.session-select-cb')) return;
    if (_touchMoved || _longPressed) { _touchMoved = false; _longPressed = false; return; }
    // 选择模式下，切换圆点状态而非导航
    if (_selectMode) {
      const dot = div.querySelector('.session-select-cb');
      if (dot) dot.click();
      return;
    }
    selectSession(s.id);
  });

  // 创建下拉菜单按钮
  const menuBtn = document.createElement('button');
  menuBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  menuBtn.title = t('sessions.session_actions');
  menuBtn.className = 'hamburger session-menu-btn';

  // 创建下拉菜单
  const dropdown = document.createElement('div');
  dropdown.className = 'dropdown session-dropdown session-dropdown-menu';

  // 创建菜单项
  const _icon = (svg) => `<span class="dropdown-icon">${svg}</span>`;
  const _renameIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
  const _archiveIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
  const _deleteIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
  const _copyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  const renameItem = document.createElement('div');
  renameItem.className = 'dropdown-item-compact';
  renameItem.innerHTML = _icon(_renameIcon) + '<span>' + t('common.rename') + '</span>';

  const archiveItem = document.createElement('div');
  archiveItem.className = 'dropdown-item-compact';
  archiveItem.innerHTML = _icon(_archiveIcon) + '<span>' + t('common.archive') + '</span>';

  const deleteItem = document.createElement('div');
  deleteItem.className = 'dropdown-item-compact dropdown-item-danger';
  deleteItem.innerHTML = _icon(_deleteIcon) + '<span>' + t('common.delete') + '</span><span class="dropdown-shortcut">' + _mod + '+Alt+D</span>';



  dropdown.appendChild(renameItem);

  // 收藏/取消收藏项
  if (!isOpenClaw) {
    const _favIcon = s.is_important
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
    const starItem = document.createElement('div');
    starItem.className = 'dropdown-item-compact';
    starItem.innerHTML = _icon(_favIcon) + '<span>' + (s.is_important ? t('sessions.unfavorite') : t('sessions.favorite')) + '</span><span class="dropdown-shortcut">' + _mod + '+Alt+F</span>';
    starItem.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newVal = !s.is_important;
      const fd = new FormData();
      fd.append('important', newVal);
      await fetch(`${API_BASE}/api/session/${s.id}/important`, { method: 'POST', body: fd });
      s.is_important = newVal;
      dropdown.style.display = 'none';
      renderSessionList();
    });
    dropdown.appendChild(starItem);
  }

  const copyItem = document.createElement('div');
  copyItem.className = 'dropdown-item-compact';
  copyItem.innerHTML = _icon(_copyIcon) + '<span>' + t('sessions.copy_chat') + '</span>';
  copyItem.addEventListener('click', async (e) => {
    e.stopPropagation();
    dropdown.style.display = 'none';
    try {
      const res = await fetch(`${API_BASE}/api/history/${s.id}`);
      const data = await res.json();
      const msgs = data.history || [];
      if (!msgs.length) { uiModule.showToast(t('sessions.no_messages_to_copy')); return; }
      const lines = msgs
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => {
          const label = m.role === 'user' ? t('sessions.you') : t('sessions.ai');
          const text = typeof m.content === 'string' ? m.content.trim() : JSON.stringify(m.content);
          return `${label}: ${text}`;
        });
      const text = lines.join('\n\n');
      try {
        await navigator.clipboard.writeText(text);
      } catch (_clipErr) {
        // 非安全上下文的回退方案
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      uiModule.showToast(t('sessions.chat_copied'));
    } catch (e) {
      console.error('Copy chat failed:', e);
      uiModule.showError(t('sessions.failed_copy_chat'));
    }
  });

  // 重命名项已在上方添加（第 393 行附近）

  // "选择" — 进入批量选择模式并预选此会话
  if (!isOpenClaw) {
    const selectMoreItem = document.createElement('div');
    selectMoreItem.className = 'dropdown-item-compact';
    selectMoreItem.innerHTML = _icon('<span style="font-size:16px;line-height:1;">●</span>') + '<span>' + t('sessions.select') + '</span>';
    selectMoreItem.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.style.display = 'none';
      _enterSelectMode();
      const dot = div.querySelector('.session-select-cb');
      if (dot) { dot._checked = true; dot.innerHTML = '●'; dot.style.opacity = '1'; dot.style.color = 'var(--accent, var(--red))'; _selectedIds.add(s.id); _updateBulkCount(); }
    });
    // 移动端"选择"是主要的多选操作 — 放在菜单顶部。
    // 桌面端保持原位置。
    if (window.innerWidth <= 768) {
      dropdown.insertBefore(selectMoreItem, dropdown.firstChild);
    } else {
      dropdown.appendChild(selectMoreItem);
    }
  }

  // 复制和移动到文件夹
  const folderItem = buildFolderSubmenu(s.id, s.folder, dropdown);
  dropdown.appendChild(copyItem);
  dropdown.appendChild(folderItem);

  // 危险操作前的分隔线
  const _sep = document.createElement('div');
  _sep.style.cssText = 'height:1px;margin:3px 0;background:color-mix(in srgb,var(--border) 40%,transparent)';
  dropdown.appendChild(_sep);

  dropdown.appendChild(archiveItem);
  dropdown.appendChild(deleteItem);

  // 仅移动端取消按钮 — 为触摸用户提供显式关闭。CSS 在
  // 桌面端隐藏它（点击外部即可关闭）。
  const _cancelIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const cancelItem = document.createElement('div');
  cancelItem.className = 'dropdown-item-compact dropdown-cancel-mobile';
  cancelItem.innerHTML = _icon(_cancelIcon) + '<span>' + t('common.cancel') + '</span>';
  cancelItem.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.style.display = 'none';
  });
  dropdown.appendChild(cancelItem);

  // 添加事件监听器
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // 关闭其他已打开的下拉菜单
    document.querySelectorAll('.dropdown').forEach(d => {
      if (d !== dropdown) d.style.display = 'none';
    });
    // 切换此下拉菜单
    if (dropdown.style.display === 'block') {
      dropdown.style.display = 'none';
    } else {
      // 使用视口坐标定位下拉菜单
      const rect = menuBtn.getBoundingClientRect();
      dropdown.style.left = '';
      dropdown.style.right = (window.innerWidth - rect.right) + 'px';
      // 先放在屏幕外以测量高度
      dropdown.style.top = '-9999px';
      dropdown.style.display = 'block';
      const ddRect = dropdown.getBoundingClientRect();
      // 如果下方空间不足则翻转到上方
      if (rect.bottom + 2 + ddRect.height > window.innerHeight) {
        dropdown.style.top = Math.max(2, rect.top - ddRect.height - 2) + 'px';
      } else {
        dropdown.style.top = rect.bottom + 2 + 'px';
      }
    }
  });

  renameItem.addEventListener('click', () => {
    dropdown.style.display = 'none';
    _forceSidebarOpen();
    // 找到会话行的名称 span 并开始内联编辑
    const sessionEl = document.querySelector(`.list-item[data-session-id="${s.id}"]`);
    if (!sessionEl) return;
    const span = sessionEl.querySelector('.grow');
    if (!span || sessionEl.querySelector('.session-rename-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = s.name || '';
    input.className = 'session-rename-input';
    span.replaceWith(input);
    input.focus();
    input.select();
    const _stopGuard = _guardSidebarDuringRename();
    const commit = async () => {
      const newName = input.value.trim();
      if (newName && newName !== s.name) {
        const fd = new FormData();
        fd.append('name', newName);
        await fetch(`${API_BASE}/api/session/${s.id}`, { method: 'PATCH', body: fd });
        s.name = newName;
        uiModule.showToast(t('notification.renamed'));
      }
      _forceSidebarOpen();
      renderSessionList();
      _stopGuard();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') { input.removeEventListener('blur', commit); _forceSidebarOpen(); renderSessionList(); _stopGuard(); }
    });
  });

  deleteItem.addEventListener('click', async () => {
    if (s.is_important) {
      uiModule.showToast(t('sessions.unfavorite_before_delete'));
      dropdown.style.display = 'none';
      return;
    }
    dropdown.style.display = 'none';
    if (!await uiModule.styledConfirm(t('sessions.delete_session_confirm'), { confirmText: t('common.delete'), danger: true })) {
      _forceSidebarOpen();
      return;
    }
    const wasCurrentSession = currentSessionId === s.id;
    // 如果正在流式传输，删除前先中止
    if (wasCurrentSession && window.chatModule && window.chatModule.abortCurrentRequest) {
      window.chatModule.abortCurrentRequest();
    }
    _deselectCurrentSession(s.id);
    _removeSessionFromLocalState(s.id);
    _skipAutoSelect = true;
    // 清理持久化聊天映射
    try {
      const pm = await import('./presets.js');
      if (pm.removePersistentChat) pm.removePersistentChat(s.id);
    } catch (e) {}
    // 移动端如果删除当前活跃会话则关闭侧边栏，让用户看到欢迎页
    if (wasCurrentSession && window.innerWidth <= 768) {
      const sidebar = document.getElementById('sidebar');
      if (sidebar) sidebar.classList.add('hidden');
      const backdrop = document.getElementById('sidebar-backdrop');
      if (backdrop) backdrop.classList.remove('visible');
    } else {
      _forceSidebarOpen();
    }
    // 等待 API 删除完成，然后从服务器重新加载权威列表
    try {
      await fetch(`${API_BASE}/api/session/${s.id}`, { method: 'DELETE' });
    } catch (e) { /* 网络错误 — 会话可能仍在服务器端存在 */ }
    await loadSessions();
  });

  archiveItem.addEventListener('click', async () => {
    dropdown.style.display = 'none';
    _forceSidebarOpen();
    try {
      const response = await fetch(`${API_BASE}/api/session/${s.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        _forceSidebarOpen();
        await loadSessions();
        dropdown.style.display = 'none';
        uiModule.showToast(t('sessions.session_archived'));
      } else {
        throw new Error(t('sessions.failed_archive_session'));
      }
    } catch (error) {
      console.error('Error archiving session:', error);
      uiModule.showError(t('sessions.failed_archive_session'));
    }
  });

  // 下拉菜单由共享的全局监听器 (_initDropdownDismiss) 关闭

  // 防止在下拉菜单内部点击时关闭
  dropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  div.appendChild(span);

  // 将处理中/已完成状态应用到星号圆点
  var _isProcessing = _researchingSessions.has(s.id) || _streamingSessions.has(s.id);
  var _isDone = _completedSessions.has(s.id) && !_isProcessing;
  if (!isOpenClaw) {
    var _starEl = div.querySelector('.session-star');
    if (_starEl) {
      _starEl.dataset.sessionId = s.id;
      if (_isProcessing) {
        _starEl.classList.add('processing');
        _starEl.style.opacity = '1';
      } else if (_isDone) {
        _starEl.classList.add('notify');
        _starEl.style.opacity = '1';
        div.classList.add('stream-complete');
      }
    }
  }

  div.appendChild(menuBtn);
  dropdown.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(dropdown);
  div._sessionDropdown = dropdown;

  return div;
}

let _renderRAF = null;
export function renderSessionList() {
  // 在同一帧内防抖快速重渲染
  if (_renderRAF) cancelAnimationFrame(_renderRAF);
  _renderRAF = requestAnimationFrame(_renderSessionListImpl);
}

function _renderSessionListImpl() {
  _renderRAF = null;
  const list = uiModule.el('session-list');
  if (!list) return;

  // 从 localStorage 获取保存的排序
  const savedOrder = Storage.get('session-order');
  let orderedSessions = sessions.filter(s => !s.archived && s.folder !== 'Assistant' && !_isIncognitoSession(s.id) && (s.name || '').trim() !== t('sessions.nobody_session_name') && (s.name || '').trim() !== 'Incognito');

  if (savedOrder) {
    try {
      const orderIds = JSON.parse(savedOrder);
      const sessionMap = new Map(orderedSessions.map(s => [s.id, s]));
      const ordered = [];
      orderIds.forEach(id => {
        if (sessionMap.has(id)) {
          ordered.push(sessionMap.get(id));
          sessionMap.delete(id);
        }
      });
      // 追加不在已保存顺序中的新会话
      sessionMap.forEach(s => ordered.push(s));
      orderedSessions = ordered;
    } catch (e) {
      console.warn('Failed to restore session order:', e);
    }
  }

  // 清理 body 中之前遗留的会话下拉菜单和文件夹子菜单
  document.querySelectorAll('.session-dropdown, .folder-submenu').forEach(d => d.remove());

  const _frag = document.createDocumentFragment();

  // ── 平铺排序模式：忽略文件夹，显示统一排序列表。——
  // 文件夹仅在 _sortMode === 'group'（或 null/空表示
  // 手动模式）时显示。这样保持选择器简洁：按文件夹分组
  // 视图是排序选项之一，与"最近活跃"/"最新"并列。
  if (_sortMode && _sortMode !== 'group') {
    orderedSessions.sort((a, b) => {
      if (_sortMode === 'newest') return (b.created_at || '').localeCompare(a.created_at || '');
      // "最近活跃"按最后实际消息排序，而非 updated_at —
      // updated_at 会因重命名/切换模型/移动文件夹而更新，
      // 使排序变得随机。对于 last_message_at 填充前的
      // 旧行，回退到 updated_at/created_at。
      if (_sortMode === 'active') {
        const av = a.last_message_at || a.updated_at || a.created_at || '';
        const bv = b.last_message_at || b.updated_at || b.created_at || '';
        return bv.localeCompare(av);
      }
      return 0;
    });
    // 收藏项仍然置顶
    const starred = orderedSessions.filter(s => s.is_important);
    const rest = orderedSessions.filter(s => !s.is_important);
    const allFlat = [...starred, ...rest];

    const limit = _showAllSessions ? allFlat.length : SIDEBAR_MAX_VISIBLE;
    const visible = allFlat.slice(0, limit);
    const activeIdx = allFlat.findIndex(s => s.id === currentSessionId);
    if (!_showAllSessions && activeIdx >= limit) visible.push(allFlat[activeIdx]);

    visible.forEach(s => _frag.appendChild(createSessionItem(s)));

    if (allFlat.length > SIDEBAR_MAX_VISIBLE) {
      const remaining = allFlat.length - SIDEBAR_MAX_VISIBLE;
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'session-show-more-btn';
      toggleBtn.textContent = _showAllSessions ? t('common.show_less') : t('common.show_more', { n: remaining });
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _showAllSessions = !_showAllSessions;
        renderSessionList();
      });
      _frag.appendChild(toggleBtn);
    }

    list.innerHTML = '';
    list.appendChild(_frag);
    _postRenderSessionList(list);
    return;
  }

  // ── 分组/手动模式：先渲染文件夹，再渲染未分类会话。——
  const folderState = loadFolderState();
  const folders = {}; // folderName -> [会话列表]
  const unfiled = [];

  orderedSessions.forEach(s => {
    if (s.folder) {
      if (!folders[s.folder]) folders[s.folder] = [];
      folders[s.folder].push(s);
    } else {
      unfiled.push(s);
    }
  });

  // 将收藏会话移到每组顶部，保持相对顺序
  const starPartition = (arr) => {
    const starred = arr.filter(s => s.is_important);
    const rest = arr.filter(s => !s.is_important);
    arr.length = 0;
    arr.push(...starred, ...rest);
  };
  starPartition(unfiled);
  Object.values(folders).forEach(arr => starPartition(arr));

  // 先渲染文件夹（在未分类会话之上）
  const savedFolderOrder = loadFolderOrder();
  const allFolderNames = Object.keys(folders);
  const orderedFolderNames = [];
  savedFolderOrder.forEach(name => {
    if (allFolderNames.includes(name)) orderedFolderNames.push(name);
  });
  allFolderNames.forEach(name => {
    if (!orderedFolderNames.includes(name)) orderedFolderNames.push(name);
  });

  orderedFolderNames.forEach(folderName => {
    const folderDiv = document.createElement('div');
    folderDiv.className = 'session-folder';
    folderDiv.dataset.folderName = folderName;

    const header = document.createElement('div');
    header.className = 'session-folder-header';
    header.dataset.folderName = folderName;
    const collapsed = folderState[folderName] === false;

    // 文件夹重排序的拖拽手柄
    const dragHandle = document.createElement('span');
    dragHandle.className = 'folder-drag-handle';
    dragHandle.textContent = '\u2630';
    dragHandle.title = t('sessions.drag_reorder_folder');
    header.appendChild(dragHandle);

    const toggle = document.createElement('span');
    toggle.className = 'folder-toggle';
    toggle.textContent = collapsed ? '\u25B6' : '\u25BC';
    header.appendChild(toggle);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'folder-name';
    nameSpan.textContent = folderName;
    header.appendChild(nameSpan);

    const countSpan = document.createElement('span');
    countSpan.className = 'folder-count';
    countSpan.textContent = `(${folders[folderName].length})`;
    header.appendChild(countSpan);

    // 删除文件夹按钮
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'folder-delete-btn';
    deleteBtn.textContent = '\u00d7';
    deleteBtn.title = t('sessions.delete_folder_all');
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const count = folders[folderName].length;
      if (!await uiModule.styledConfirm(t('sessions.delete_folder_confirm', { name: folderName, n: count }), { confirmText: t('common.delete'), danger: true })) return;
      for (const s of folders[folderName]) {
        try {
          await fetch(`${API_BASE}/api/session/${s.id}`, { method: 'DELETE' });
          _deselectCurrentSession(s.id);
        } catch (err) {
          console.error('Failed to delete session:', s.id, err);
        }
      }
      await loadSessions();
    });
    header.appendChild(deleteBtn);

    let _folderTouchMoved = false;
    header.addEventListener('touchstart', () => { _folderTouchMoved = false; }, { passive: true });
    header.addEventListener('touchmove', () => { _folderTouchMoved = true; }, { passive: true });
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('.folder-drag-handle') || e.target.closest('.folder-delete-btn')) return;
      if (_folderTouchMoved) { _folderTouchMoved = false; return; }
      const state = loadFolderState();
      const isCollapsed = state[folderName] === false;
      state[folderName] = isCollapsed ? true : false;
      saveFolderState(state);
      renderSessionList();
    });

    // 允许双击重命名文件夹
    header.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      if (e.target.closest('.folder-delete-btn')) return;
      const newName = await styledPrompt(t('sessions.rename_folder_prompt'), {
        title: t('sessions.rename_folder_title'),
        defaultValue: folderName,
        confirmText: t('common.rename'),
      });
      if (!newName || !newName.trim() || newName.trim() === folderName) return;
      const promises = folders[folderName].map(s => moveToFolder(s.id, newName.trim()));
      Promise.all(promises).then(() => loadSessions());
    });

    folderDiv.appendChild(header);

    if (!collapsed) {
      const content = document.createElement('div');
      content.className = 'session-folder-content';
      const folderSessions = folders[folderName];
      const folderExpanded = _expandedFolders[folderName];
      const folderLimit = folderExpanded ? folderSessions.length : FOLDER_MAX_VISIBLE;
      const visibleFolder = folderSessions.slice(0, folderLimit);

      // 始终包含活跃会话，即使超出限制
      const activeInFolder = folderSessions.findIndex(s => s.id === currentSessionId);
      if (!folderExpanded && activeInFolder >= folderLimit) {
        visibleFolder.push(folderSessions[activeInFolder]);
      }

      visibleFolder.forEach(s => {
        content.appendChild(createSessionItem(s));
      });

      if (folderSessions.length > FOLDER_MAX_VISIBLE) {
        const rem = folderSessions.length - FOLDER_MAX_VISIBLE;
        const moreBtn = document.createElement('button');
        moreBtn.className = 'session-show-more-btn';
        moreBtn.textContent = folderExpanded ? t('common.show_less') : t('common.show_more', { n: rem });
        moreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _expandedFolders[folderName] = !folderExpanded;
          renderSessionList();
        });
        content.appendChild(moreBtn);
      }

      folderDiv.appendChild(content);
    }

    _frag.appendChild(folderDiv);
  });

  // 在文件夹下方渲染未分类会话（限制数量，除非展开）
  const hasFolders = orderedFolderNames.length > 0;
  const activeInUnfiled = unfiled.findIndex(s => s.id === currentSessionId);
  const limit = _showAllSessions ? unfiled.length : SIDEBAR_MAX_VISIBLE;
  const visibleUnfiled = unfiled.slice(0, limit);

  // 如果活跃会话超出限制，仍包含它
  if (!_showAllSessions && activeInUnfiled >= limit) {
    visibleUnfiled.push(unfiled[activeInUnfiled]);
  }

  // 如果存在真实文件夹，用"未分类"文件夹包装
  let unfiledTarget = _frag;
  if (hasFolders && unfiled.length > 0) {
    const unsortedDiv = document.createElement('div');
    unsortedDiv.className = 'session-folder unsorted-folder';
    const unsortedHeader = document.createElement('div');
    unsortedHeader.className = 'session-folder-header';
    const unsortedCollapsed = loadFolderState()['__unsorted__'] === false;

    const dragHandle = document.createElement('span');
    dragHandle.className = 'folder-drag-handle';
    dragHandle.textContent = '\u2630';
    dragHandle.title = t('sessions.drag_reorder_folder');
    unsortedHeader.appendChild(dragHandle);

    const toggle = document.createElement('span');
    toggle.className = 'folder-toggle';
    toggle.textContent = unsortedCollapsed ? '\u25B6' : '\u25BC';
    unsortedHeader.appendChild(toggle);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'folder-name';
    nameSpan.textContent = t('sessions.unsorted');
    unsortedHeader.appendChild(nameSpan);
    const countSpan = document.createElement('span');
    countSpan.className = 'folder-count';
    countSpan.textContent = `(${unfiled.length})`;
    unsortedHeader.appendChild(countSpan);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'folder-delete-btn';
    deleteBtn.textContent = '\u00d7';
    deleteBtn.title = t('sessions.delete_all_unsorted');
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await uiModule.styledConfirm(t('sessions.delete_unsorted_confirm', { n: unfiled.length }), { confirmText: t('common.delete'), danger: true })) return;
      for (const s of unfiled) {
        try {
          await fetch(`${API_BASE}/api/session/${s.id}`, { method: 'DELETE' });
          _deselectCurrentSession(s.id);
        } catch (err) {
          console.error('Failed to delete session:', s.id, err);
        }
      }
      await loadSessions();
    });
    unsortedHeader.appendChild(deleteBtn);

    unsortedHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      const state = loadFolderState();
      state['__unsorted__'] = state['__unsorted__'] === false ? true : false;
      saveFolderState(state);
      renderSessionList();
    });
    unsortedDiv.appendChild(unsortedHeader);
    if (!unsortedCollapsed) {
      const content = document.createElement('div');
      content.className = 'session-folder-content';
      unfiledTarget = content;
      unsortedDiv.appendChild(content);
    }
    _frag.appendChild(unsortedDiv);
    if (unsortedCollapsed) {
      unfiledTarget = null;
    }
  }

  if (unfiledTarget) {
    visibleUnfiled.forEach(s => {
      unfiledTarget.appendChild(createSessionItem(s));
    });
  }

  // "显示更多"/"收起"切换按钮
  if (unfiledTarget && unfiled.length > SIDEBAR_MAX_VISIBLE) {
    const remaining = unfiled.length - SIDEBAR_MAX_VISIBLE;
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'session-show-more-btn';
    toggleBtn.textContent = _showAllSessions ? t('common.show_less') : t('common.show_more', { n: remaining });
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _showAllSessions = !_showAllSessions;
      renderSessionList();
    });
    unfiledTarget.appendChild(toggleBtn);
  }

  // 一次性将所有构建的元素写入列表
  list.innerHTML = '';
  list.appendChild(_frag);

  _postRenderSessionList(list);
}

/** 渲染后共享逻辑：高亮、键盘导航、滑动提示、拖拽排序 */
function _postRenderSessionList(list) {
  if (currentSessionId) {
    const activeEl = document.querySelector(`.list-item[data-session-id="${currentSessionId}"]`);
    if (activeEl) {
      activeEl.classList.add('active-session');
      if (_sessionListFocused) activeEl.focus();
    }
  }

  _initKeyboardNav(list);
  _initSwipeToDelete(list);
  initDragSort();
  _showSwipeHint(list);
}

function _initKeyboardNav(list) {
  if (!list._kbInit) {
    list._kbInit = true;
    list.addEventListener('keydown', _onSessionListKeydown);
    list.addEventListener('focusin', () => { _sessionListFocused = true; });
    list.addEventListener('focusout', (e) => {
      if (!list.contains(e.relatedTarget)) _sessionListFocused = false;
    });
  }
}

function _initSwipeToDelete(list) {
  // 由现有滑动代码处理 — 占位符保持一致性
}

function _showSwipeHint(list) {
  if ('ontouchstart' in window && !localStorage.getItem('ody-swipe-hint-shown')) {
    const firstItem = list.querySelector('.session-item');
    if (firstItem) {
      localStorage.setItem('ody-swipe-hint-shown', '1');
      const hint = document.createElement('div');
      hint.className = 'swipe-hint';
      hint.innerHTML = '<span class="swipe-hint-arrow">\u2190</span> ' + t('sessions.swipe_to_delete');
      firstItem.style.position = 'relative';
      firstItem.appendChild(hint);
      setTimeout(() => { hint.style.opacity = '0'; }, 3000);
      setTimeout(() => { hint.remove(); }, 3500);
    }
  }
}

// ── 移动端强制保持侧边栏打开（下拉菜单操作后）——
function _forceSidebarOpen() {
  if (window.innerWidth > 768) return;
  // 抑制背景遮罩关闭
  if (window._suppressSidebarClose !== undefined) {
    window._suppressSidebarClose = true;
    setTimeout(() => { window._suppressSidebarClose = false; }, 2000);
  }
  // 强制侧边栏可见
  requestAnimationFrame(() => {
    const sb = document.getElementById('sidebar');
    if (sb && sb.classList.contains('hidden')) {
      sb.classList.remove('hidden');
      if (window.syncRailSide) window.syncRailSide();
    }
  });
}

// 移动端行内重命名进行中时，多条路径可能隐藏侧边栏
// （背景遮罩点击、软键盘视口调整、下拉菜单关闭）。直接
// 监视侧边栏，一旦被隐藏就重新打开 — 无论哪条路径触发都能防御。
// 返回一个停止函数，重命名提交后调用。
function _guardSidebarDuringRename() {
  if (window.innerWidth > 768 || !window.MutationObserver) return () => {};
  const sb = document.getElementById('sidebar');
  if (!sb) return () => {};
  const obs = new MutationObserver(() => {
    if (sb.classList.contains('hidden')) {
      sb.classList.remove('hidden');
      const bd = document.getElementById('sidebar-backdrop');
      if (bd) bd.classList.add('visible');
    }
  });
  obs.observe(sb, { attributes: true, attributeFilter: ['class'] });
  // 调用方停止后短暂保持守卫，捕获 blur/提交后触发的
  // 键盘收起的 resize 事件。
  return () => setTimeout(() => obs.disconnect(), 400);
}

// ── 批量选择模式 ──
let _selectMode = false;
let _selectedIds = new Set();

function _enterSelectMode() {
  _selectMode = true;
  _selectedIds.clear();
  const bulkBar = document.getElementById('session-bulk-bar');
  if (bulkBar) bulkBar.classList.remove('hidden');
  const selectBtn = document.getElementById('session-select-btn');
  if (selectBtn) selectBtn.style.opacity = '1';
  // 为所有会话项添加选择圆点
  document.querySelectorAll('.list-item[data-session-id]').forEach(item => {
    if (item.querySelector('.session-select-cb')) return;
    const dot = document.createElement('span');
    dot.className = 'session-select-cb';
    dot.innerHTML = '○';
    dot.style.cssText = 'cursor:pointer;font-size:16px;flex-shrink:0;opacity:0.4;transition:opacity 0.1s;user-select:none;';
    dot._checked = false;
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      dot._checked = !dot._checked;
      dot.innerHTML = dot._checked ? '●' : '○';
      dot.style.opacity = dot._checked ? '1' : '0.4';
      dot.style.color = dot._checked ? 'var(--accent, var(--red))' : '';
      const sid = item.dataset.sessionId;
      if (dot._checked) _selectedIds.add(sid);
      else _selectedIds.delete(sid);
      _updateBulkCount();
    });
    item.insertBefore(dot, item.firstChild);
  });
  _updateBulkCount();
}

function _exitSelectMode() {
  _selectMode = false;
  _selectedIds.clear();
  const bulkBar = document.getElementById('session-bulk-bar');
  if (bulkBar) bulkBar.classList.add('hidden');
  const selectBtn = document.getElementById('session-select-btn');
  if (selectBtn) selectBtn.style.opacity = '0.5';
  const selectAll = document.getElementById('session-select-all');
  if (selectAll) selectAll.checked = false;
  // 移除选择框
  document.querySelectorAll('.session-select-cb').forEach(cb => cb.remove());
}

function _updateBulkCount() {
  const count = _selectedIds.size;
  const archiveBtn = document.getElementById('session-bulk-archive');
  const deleteBtn = document.getElementById('session-bulk-delete');
  if (archiveBtn) { archiveBtn.disabled = count === 0; archiveBtn.style.opacity = count === 0 ? '0.2' : ''; }
  if (deleteBtn) { deleteBtn.disabled = count === 0; deleteBtn.style.opacity = count === 0 ? '0.2' : ''; }
}

function _initBulkSelect() {
  const selectBtn = document.getElementById('session-select-btn');
  if (selectBtn) {
    selectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_selectMode) _exitSelectMode();
      else _enterSelectMode();
    });
  }
  const cancelBtn = document.getElementById('session-bulk-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => _exitSelectMode());

  // 从漏斗下拉菜单中选择
  const selectFromDropdown = document.getElementById('session-select-from-dropdown');
  if (selectFromDropdown) {
    selectFromDropdown.addEventListener('click', () => {
      const dd = document.getElementById('session-sort-dropdown');
      if (dd) dd.style.display = 'none';
      _enterSelectMode();
    });
  }

  // Escape 键退出选择模式
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _selectMode) {
      _exitSelectMode();
    }
  });

  const selectAll = document.getElementById('session-select-all');
  const selectAllDot = document.getElementById('session-select-all-dot');
  const selectAllLabel = document.getElementById('session-select-all-label');
  if (selectAll && selectAllDot) {
    const _toggleAll = () => {
      selectAll.checked = !selectAll.checked;
      selectAllDot.innerHTML = selectAll.checked ? '●' : '○';
      selectAllDot.style.opacity = selectAll.checked ? '1' : '0.4';
      selectAllDot.style.color = selectAll.checked ? 'var(--accent, var(--red))' : '';
      document.querySelectorAll('.session-select-cb').forEach(dot => {
        dot._checked = selectAll.checked;
        dot.innerHTML = selectAll.checked ? '●' : '○';
        dot.style.opacity = selectAll.checked ? '1' : '0.4';
        dot.style.color = selectAll.checked ? 'var(--accent, var(--red))' : '';
        const sid = dot.closest('[data-session-id]')?.dataset.sessionId;
        if (sid) {
          if (selectAll.checked) _selectedIds.add(sid);
          else _selectedIds.delete(sid);
        }
      });
      _updateBulkCount();
    };
    selectAllDot.addEventListener('click', _toggleAll);
    if (selectAllLabel) selectAllLabel.addEventListener('click', _toggleAll);
  }

  const archiveBtn = document.getElementById('session-bulk-archive');
  if (archiveBtn) {
    archiveBtn.addEventListener('click', async () => {
      if (_selectedIds.size === 0) return;
      const count = _selectedIds.size;
      if (!await uiModule.styledConfirm(t('sessions.archive_session_confirm', { n: count }), { confirmText: t('common.archive') })) return;
      for (const sid of _selectedIds) {
        try {
          await fetch(`${API_BASE}/api/session/${sid}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        } catch (_) {}
      }
      _exitSelectMode();
      if (window._suppressSidebarClose !== undefined) { window._suppressSidebarClose = true; setTimeout(() => { window._suppressSidebarClose = false; }, 1500); }
      await loadSessions();
      uiModule.showToast(t('sessions.session_archived_n', { n: count }));
    });
  }

  const deleteBtn = document.getElementById('session-bulk-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (_selectedIds.size === 0) return;
      const count = _selectedIds.size;
      if (!await uiModule.styledConfirm(t('sessions.delete_session_confirm_n', { n: count }), { confirmText: t('common.delete'), danger: true })) return;
      const deletedIds = [];
      for (const sid of _selectedIds) {
        try {
          const res = await fetch(`${API_BASE}/api/session/${sid}`, { method: 'DELETE' });
          if (res.ok) deletedIds.push(sid);
        } catch (_) {}
      }
      await _animateSessionRowsRemoving(deletedIds, '#session-list .list-item[data-session-id]');
      _exitSelectMode();
      if (window._suppressSidebarClose !== undefined) { window._suppressSidebarClose = true; setTimeout(() => { window._suppressSidebarClose = false; }, 1500); }
      await loadSessions();
      uiModule.showToast(t('notification.session_deleted'));
    });
  }
}

function _animateSessionRowsRemoving(ids, selector) {
  const idSet = new Set((ids || []).map(id => String(id)));
  if (!idSet.size) return Promise.resolve();
  const rows = Array.from(document.querySelectorAll(selector || '.list-item[data-session-id]'))
    .filter(row => idSet.has(String(row.dataset.sessionId || row.dataset.sid)));
  if (!rows.length) return Promise.resolve();
  for (const row of rows) {
    row.style.maxHeight = `${Math.max(row.getBoundingClientRect().height, row.scrollHeight)}px`;
    row.classList.add('memory-tidy-removing');
  }
  return new Promise(resolve => setTimeout(resolve, 520));
}

export async function loadSessions() {
  try {
    // 删除上次页面加载遗留的隐身会话
    await _cleanupIncognitoSessions();

    // 使用登录页预取的数据（仅首次加载）
    const prefetched = sessionStorage.getItem('ody-prefetch-sessions');
    let fetched;
    if (prefetched) {
      sessionStorage.removeItem('ody-prefetch-sessions');
      fetched = JSON.parse(prefetched);
    } else {
      const res = await fetch(`${API_BASE}/api/sessions`);
      fetched = await res.json();
    }
    sessions = _normalizeSessionsList(fetched);
    renderSessionList();

    const sessionsSection = uiModule.el('sessions-section');
    if (sessions.length === 0) {
      sessionsSection.classList.add('hidden');
    } else {
      sessionsSection.classList.remove('hidden');
    }

    const activeSessions = sessions.filter(s => !s.archived);
    // "临时"会话 = 单例 Assistant 聊天 + 任意任务输出会话。
    // 将其视为不可恢复的，以便返回应用时回到用户
    // 最后一次实际对话，而非最近追加消息的
    // 某个签到任务。
    const _isTransient = (s) => !!s && (s.folder === 'Assistant' || s.folder === 'Tasks');
    const _realSessions = activeSessions.filter(s => !_isTransient(s));
    const hashId = window.location.hash.replace('#', '');
    let savedId = Storage.get('lastSessionId');
    // 如果持久化的 lastSessionId 指向临时会话（持久化守卫
    // 添加前的旧状态），丢弃它。
    if (savedId) {
      const _saved = activeSessions.find(s => s.id === savedId);
      if (_saved && _isTransient(_saved)) {
        Storage.remove('lastSessionId');
        savedId = null;
      }
    }
    const hasPendingChat = !!_pendingChat;
    let targetId = null;
    if (hasPendingChat) {
      // 已选择模型且 UI 显示新的聊天，但会话直到发送
      // 第一条消息时才创建。后台流完成后会调用 loadSessions()；
      // 没有此守卫的话，重载时发现没有当前会话会自动选择
      // 上一个聊天。
      targetId = null;
    } else if (hashId && activeSessions.some(s => s.id === hashId)) {
      targetId = hashId;
    } else if (currentSessionId && activeSessions.some(s => s.id === currentSessionId)) {
      targetId = currentSessionId;
    } else if (currentSessionId) {
      // 会话刚创建但可能尚未出现在列表中 — 保留它
      targetId = currentSessionId;
    } else if (savedId && activeSessions.some(s => s.id === savedId)) {
      targetId = savedId;
    } else if (!_skipAutoSelect && _realSessions.length > 0) {
      // 最近的非临时会话 — 跳过 Assistant/Tasks 以免自动触发的
      // assistant 成为默认聊天。
      targetId = _realSessions[0].id;
    } else if (!_skipAutoSelect && activeSessions.length > 0) {
      // 仅存在临时会话（全新账户）— 回退到
      // 原始行为，确保用户不会面对空白。
      targetId = activeSessions[0].id;
    }
    _skipAutoSelect = false;

    // 新登录：优先使用默认模型会话，让新用户进入即可聊天。
    // 关键：仅在没有会话可返回时（无 hash/lastSessionId/已有聊天
    // 解析出 targetId）才这样做。否则新页面加载 — 服务器重启
    // 会触发 — 将创建新的空默认模型聊天，覆盖用户
    // 上次对话，让人以为聊天"丢失了上下文"（选择器
    // 仍会显示缓存状态中的旧模型名称）。参见上方 targetId
    // 解析顺序（hash → currentSession → lastSessionId → 最近一条）。
    const _isFirstLoad = !sessionStorage.getItem('ody-session-active');
    if (_isFirstLoad) {
      sessionStorage.setItem('ody-session-active', '1');
      if (!targetId) {
        try {
          const dcRes = await fetch(`${API_BASE}/api/default-chat`);
          const dc = await dcRes.json();
          if (dc.endpoint_url && dc.model) {
            // 检查是否已有使用此模型的空会话可以复用
            const emptyDefault = activeSessions.find(s =>
              s.model === dc.model && s.message_count === 0
            );
            if (emptyDefault) {
              targetId = emptyDefault.id;
            } else {
              await createDirectChat(dc.endpoint_url, dc.model, dc.endpoint_id);
              // 移动端隐藏侧边栏，让用户直接进入聊天
              if (window.innerWidth < 768) {
                const sb = document.getElementById('sidebar');
                if (sb) sb.classList.add('hidden');
              }
              return; // createDirectChat 内部处理 selectSession
            }
          }
        } catch (_) { /* 未配置默认模型 */ }
      }
    }

    if (targetId && targetId !== currentSessionId) {
      await selectSession(targetId, { keepSidebar: true });
    } else if (targetId && targetId === currentSessionId) {
      // 同一会话 — 仅刷新标题栏名称（以防自动生成的）
      const s = sessions.find(x => x.id === targetId);
      const metaEl = document.getElementById('current-meta');
      if (metaEl && s) metaEl.textContent = s.name;
    }

    // 无会话选中 — 仍启用输入框使斜杠命令（如 /setup）可用
    if (!targetId && !hasPendingChat) {
      const msgInput = document.getElementById('message');
      if (msgInput) {
        msgInput.disabled = false;
        if (window.innerWidth > 768) msgInput.focus();
      }
      if (window.chatModule && window.chatModule.showWelcomeScreen) {
        window.chatModule.showWelcomeScreen();
      }
      updateModelPicker();
      // 仅在确实没有会话时才自动创建（而非仅未选中）
      if (activeSessions.length === 0 && !_autoCreateInProgress) {
        _autoCreateInProgress = true;
        try {
          const dcRes = await fetch(`${API_BASE}/api/default-chat`);
          const dc = await dcRes.json();
          if (dc.endpoint_url && dc.model) {
            await createDirectChat(dc.endpoint_url, dc.model, dc.endpoint_id);
          }
        } catch (_) { /* 无默认模型 — 没关系，用户可用 /setup */ }
        _autoCreateInProgress = false;
      }
    }
  } catch (error) {
    console.error('Error in loadSessions:', error);
    uiModule.showError(t('sessions.failed_load_sessions', { error: error.message }));
  }
}

export async function selectSession(id, { keepSidebar = false } = {}) {
  // 如果对比模式活跃则干净地退出
  if (window.compareModule && window.compareModule.isActive()) {
    window.compareModule.deactivate(true);
    return; // deactivate 会触发页面重载
  }
  try {
    const navToken = ++_sessionNavToken;
    const prevSessionId = currentSessionId;
    // 导航离开时重新归档已预览的会话
    _checkPeekCleanup(id);
    // 清除残留的文档文本选择，避免渗入新聊天
    if (prevSessionId !== id && window.documentModule?.clearSelection) {
      try { window.documentModule.clearSelection(); } catch {}
    }
    currentSessionId = id;
    // 识别 Assistant/任务输出会话以免用户返回时"受困"于此。
    // 同时跳过 `lastSessionId` 持久化和 URL hash —
    // 用户反馈返回应用时总停留在自动触发的任务日志
    // 聊天而非上次实际对话。
    const _meta = sessions.find(s => s.id === id);
    const _isTransientChat = !!_meta && (_meta.folder === 'Assistant' || _meta.folder === 'Tasks');
    if (!_isTransientChat) {
      Storage.set('lastSessionId', id);
      // 更新 URL hash 但不触发 hashchange 处理器
      if (window.location.hash !== '#' + id) {
        history.replaceState(null, '', '#' + id);
      }
    }
    // 恢复持久化聊天的角色预设
    try {
      const presetsModule = window.presetsModule || (await import('./presets.js')).default;
      if (presetsModule && presetsModule.onSessionSwitch) presetsModule.onSessionSwitch(id);
    } catch (e) {}
    const meta = sessions.find(s => s.id === id);

    // 将正在进行的流移到后台而非中止
    try {
      if (window.chatModule) {
        if (window.chatModule.detachCurrentStream) {
          window.chatModule.detachCurrentStream(prevSessionId);
        } else if (window.chatModule.abortCurrentRequest) {
          window.chatModule.abortCurrentRequest();
        }
      }
    } catch (e) {
      console.warn('detachCurrentStream error:', e);
      if (window.chatModule && window.chatModule.abortCurrentRequest) {
        window.chatModule.abortCurrentRequest();
      }
    }
    // 将发送按钮重置为空闲状态
    if (window._updateSendBtnIcon) window._updateSendBtnIcon();
    const sendBtn = document.querySelector('.send-btn');
    if (sendBtn && sendBtn.dataset.mode === 'streaming') {
      sendBtn.dataset.mode = '';
      sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
      sendBtn.title = t('chat.send_button');
    }
    // 切换会话时停用对比模式
    if (window.compareModule) {
      if (window.compareModule.isActive()) window.compareModule.deactivate(true);
      else if (window.compareModule.hasVisibleResults()) window.compareModule.cleanupResults();
    }
    const msgInput = document.getElementById('message');
    if (msgInput) {
      msgInput.disabled = false;
      msgInput.value = '';
    }
    const sendBtn2 = document.querySelector('.send-btn');
    if (sendBtn2) {
      sendBtn2.style.color = '';
      if (window._updateSendBtnIcon) window._updateSendBtnIcon();
    }

    // 移动端保持侧边栏打开 — 用户通过点击聊天区域或滑动关闭

    // 在侧边栏中高亮当前活跃会话
    document.querySelectorAll('.list-item.active-session').forEach(el => el.classList.remove('active-session'));
    const activeEl = document.querySelector(`.list-item[data-session-id="${id}"]`);
    if (activeEl) activeEl.classList.add('active-session');

    const currentMetaEl = uiModule.el('current-meta');
    if (currentMetaEl) {
      currentMetaEl.textContent = meta ? meta.name : t('sessions.odysseus_chat');
    }
    // 更新模型选择器可见性
    updateModelPicker();

    // 刷新新选中会话的费用徽章
    if (chatRenderer.updateSessionCostUI) chatRenderer.updateSessionCostUI();

    const chatHistory = uiModule.el('chat-history');
    // 预取历史以便无缝切换。`isOC`
    // 是 OpenClaw 特殊会话标记 — 用于下方的 wouldWipe
    // 守卫和更下方的欢迎屏分支。（其
    // 声明已被移除但引用仍在，
    // 每次 selectSession 都会产生 ReferenceError。）
    const isOC = meta && (meta.is_openclaw || id === 'openclaw');
    let msgHistory = [], modelName = null;
    if (!isOC) {
      const res = await fetch(`${API_BASE}/api/history/${id}`);
      const data = await res.json();
      if (navToken !== _sessionNavToken || currentSessionId !== id) return;
      msgHistory = data.history || [];
      modelName = data.model || null;
      // /api/history 返回的模型是后端会用于此会话的权威值。
      // 将其写回缓存的会话元数据并刷新选择器，以便显示的模型
      // 永远不会与实际发送的不一致（"选择器说是 Minimax
      // 但实际使用了默认值"的 bug，重启/陈旧缓存后发生）。
      if (modelName) {
        const sMeta = sessions.find(s => s.id === id);
        if (sMeta && sMeta.model !== modelName) {
          sMeta.model = modelName;
          updateModelPicker();
        }
      }
    }

    // 守卫：如果获取的历史为空但 DOM 中已有同一会话的消息
    // 气泡（隐身会话不持久化，所以 /api/history
    // 返回 []），保留 DOM 而不清除它。这修复了
    // 隐身聊天中流式传输完成后调用 selectSession
    // 时“回复闪烁 0.1秒然后空白”的 bug。
    const isSameSession = (prevSessionId === id);
    const hasExistingBubbles = chatHistory && chatHistory.querySelectorAll('.msg').length > 0;
    const wouldWipe = !isOC && !msgHistory.length && isSameSession && hasExistingBubbles;
    if (wouldWipe) {
      // 跳过淡入淡出/重载；已经在显示正确的内容。
      if (chatHistory) chatHistory.classList.remove('no-animate');
      return;
    }

    // 淡出旧内容，切换，淡入新内容
    if (chatHistory) {
      chatHistory.style.transition = 'opacity 0.12s ease-out';
      chatHistory.style.opacity = '0';
      await new Promise(r => setTimeout(r, 120));
      if (navToken !== _sessionNavToken || currentSessionId !== id) return;
      chatHistory.innerHTML = '';
    }

    // 批量历史渲染时抑制每条消息的入场动画
    if (chatHistory) chatHistory.classList.add('no-animate');

    // 在不可见时填充新内容
    if (isOC) {
      if (window.chatModule && window.chatModule.showWelcomeScreen) window.chatModule.showWelcomeScreen();
      window.chatModule.addMessage('assistant',
        `<p>\uD83E\uDD9E <strong>OpenClaw Agent Connected</strong></p>
         <p>Messages will be routed through your OpenClaw agent. The agent has access to tools, memory, and skills configured in your OpenClaw workspace.</p>`,
        'OpenClaw');
    } else if (msgHistory.length) {
      for (const msg of msgHistory) {
        const meta = msg.metadata ? { ...msg.metadata, _fromHistory: true } : null;
        let displayContent;
        if (typeof msg.content === 'string') {
          displayContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          // 多模态（图片/音频附件）：提取文本部分，跳过二进制数据
          displayContent = msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
        } else {
          displayContent = '';
        }
        // 清理文档选择上下文以便显示
        if (msg.role === 'user') {
          // 隐藏"从上次地方继续"气泡
          if (displayContent.trim() === 'Continue where you left off' || displayContent.trim().startsWith('Your message was cut off.') || displayContent.trim().startsWith('Your previous response was interrupted.') || displayContent.includes('[Instruction: Rewrite') || displayContent.includes('[Instruction: Explain')) continue;
          const docEditMatch = displayContent.match(/^In the document, edit this specific text \((lines? [\d-]+)\):\n```\n([\s\S]*?)\n```\n\nInstruction: ([\s\S]*)$/);
          if (docEditMatch) {
            displayContent = `[Doc edit: ${docEditMatch[1]}] ${docEditMatch[3]}`;
          }
        }
        window.chatModule.addMessage(msg.role, markdownModule.renderContent(displayContent), modelName, meta);
      }
    } else {
      if (window.chatModule && window.chatModule.showWelcomeScreen) window.chatModule.showWelcomeScreen();
      // 不高亮空会话 — 感觉像没有任何会话被选中
      document.querySelectorAll('.list-item.active-session').forEach(el => el.classList.remove('active-session'));
    }
    uiModule.scrollHistoryInstant();

    // 淡入并重新启用消息动画
    if (chatHistory) {
      chatHistory.style.transition = 'opacity 0.15s ease-in';
      chatHistory.style.opacity = '1';
      chatHistory.classList.remove('no-animate');
    }
    if (window.hljs) {
      document.querySelectorAll('pre code:not(.hljs)').forEach(block => {
        window.hljs.highlightElement(block);
      });
    }
    // 切换会话时隐藏 Research 按钮 — 它仅属于发起它的会话
    var _rBtn = document.getElementById('research-toggle-btn');
    var _rChk = document.getElementById('research-toggle');
    if (_rBtn) _rBtn.style.display = 'none';
    if (_rChk) _rChk.checked = false;

    // 检查页面刷新后幸存的 Research 待处理/已完成状态
    if (window.chatModule && window.chatModule.checkPendingResearch) {
      window.chatModule.checkPendingResearch(id);
    }
    // 如果是群组会话则恢复群组聊天状态
    if (window.groupModule && window.groupModule.restoreState && window.groupModule.restoreState(id)) {
      if (window._syncGroupIndicator) window._syncGroupIndicator(true);
      // 群组会话时隐藏模型选择器
      const _mpw = document.getElementById('model-picker-wrap');
      if (_mpw) _mpw.style.display = 'none';
    } else if (window.groupModule && window.groupModule.isActive()) {
      // 切换离开群组会话 — 停用
      window.groupModule.stopGroup();
      if (window._syncGroupIndicator) window._syncGroupIndicator(false);
    }

    // 停止跳动通知 — 用户正在查看此会话
    clearStreamComplete(id);

    // 重新附加任何后台流
    try {
      if (window.chatModule && window.chatModule.checkBackgroundStream) {
        window.chatModule.checkBackgroundStream(id);
      }
    } catch (e) {
      console.warn('checkBackgroundStream error:', e);
    }
    // 检查服务器是否有活跃流（页面刷新后幸存）
    _checkServerStream(id);
    // 文档面板：如果下一个会话也需要则保持打开，否则关闭
    if (window.documentModule) {
      const docBtn = document.getElementById('overflow-doc-btn');
      const meta = sessions.find(s => s.id === id);
      const shouldOpen = localStorage.getItem('odysseus-doc-open-' + id) === '1';
      const hasDocs = !!(meta && meta.has_documents);
      if (docBtn) {
        docBtn.classList.remove('active');
        docBtn.classList.toggle('has-docs', hasDocs);
      }
      const docInd = document.getElementById('doc-indicator-btn');
      if (docInd) docInd.classList.toggle('visible', hasDocs);
      if (hasDocs) {
        // 等待会话 UI 稳定后滑入文档
        setTimeout(() => window.documentModule.loadSessionDocs(id, { restoreMode: true }), 300);
      } else if (!shouldOpen) {
        window.documentModule.closePanel();
      }
    }

  } catch (error) {
    console.error('Error in selectSession:', error);
    uiModule.showError(t('sessions.failed_load_session', { error: error.message }));
  } finally {
    // 确保会话选择后加载记忆
    if (window.memoryModule && window.memoryModule.loadMemories) {
      await window.memoryModule.loadMemories();
    }
    // 自动聚焦消息输入框（除非会话列表有键盘聚焦）。
    // 移动端跳过 — 聚焦文本框会弹出屏幕键盘，
    // 当用户只是在聊天间导航时（如从 Library
    // 选择聊天）会很打扰。用户可以点击输入框
    // 来弹出键盘。
    if (!_sessionListFocused && window.innerWidth > 768) {
      const msgInput = document.getElementById('message');
      if (msgInput) msgInput.focus();
    }
  }
}

// 待定会话 — 本地存储直到发送第一条消息
let _pendingChat = null; // { url, modelId, endpointId }

export function createDirectChat(url, modelId, endpointId) {
  _sessionNavToken++;
  // 移除活跃流以免干扰新聊天
  if (window.chatModule && window.chatModule.detachCurrentStream) {
    window.chatModule.detachCurrentStream(currentSessionId);
  }
  // 同时停止活跃的群组聊天 — 否则其进行中的并行/轮询流
  // 会持续渲染到全新聊天中（中止群组的 fetch）。
  if (window.groupModule && window.groupModule.isActive && window.groupModule.isActive()) {
    try { window.groupModule.stopGroup(); } catch {}
    if (window._syncGroupIndicator) window._syncGroupIndicator(false);
  }

  // 不调用 API — 仅存储模型信息并准备 UI
  _pendingChat = { url, modelId, endpointId };
  _skipAutoSelect = true;
  currentSessionId = null;
  Storage.remove('lastSessionId');
  history.replaceState(null, '', window.location.pathname);
  document.querySelectorAll('.list-item.active-session, .session-item.active').forEach(el => {
    el.classList.remove('active-session', 'active');
  });

  // 关闭文档面板 — 新聊天没有文档
  if (window.documentModule && window.documentModule.isPanelOpen()) {
    window.documentModule.closePanel();
  }
  const docBtn = document.getElementById('overflow-doc-btn');
  if (docBtn) {
    docBtn.classList.remove('active', 'has-docs');
    docBtn.style.display = ''; // 重新显示在溢出菜单中
  }
  const docInd = document.getElementById('doc-indicator-btn');
  if (docInd) docInd.classList.remove('visible', 'active');

  // 清空聊天区域并显示欢迎页
  const box = document.getElementById('chat-history');
  if (box) box.innerHTML = '';
  if (window.chatModule && window.chatModule.showWelcomeScreen) {
    window.chatModule.showWelcomeScreen();
  }

  // 更新模型选择器以显示待定模型
  updateModelPicker();

  // 更新当前元数据栏头
  const metaEl = document.getElementById('current-meta');
  if (metaEl) {
    metaEl.textContent = t('sessions.new_chat');
  }

  // 启用输入
  const msgInput = document.getElementById('message');
  if (msgInput) { msgInput.disabled = false; msgInput.value = ''; msgInput.focus(); }
}

/** 实际在数据库中创建会话。在发送第一条消息时调用。 */
export async function materializePendingSession() {
  const pending = _pendingChat;
  if (!pending) return false;
  _pendingChat = null;

  const incognitoChk = document.getElementById('incognito-toggle');
  const isIncognito = incognitoChk && incognitoChk.checked;
  const base = (pending.modelId || 'model').split('/').pop();
  const name = isIncognito ? t('sessions.nobody_session_name') : `${base} ${new Date().toLocaleTimeString()}`;

  const fd = new FormData();
  fd.append('name', name);
  fd.append('endpoint_url', pending.url || '');
  fd.append('model', pending.modelId || '');
  if (pending.url && pending.modelId) {
    fd.append('skip_validation', 'true');
  }
  if (pending.endpointId) {
    fd.append('endpoint_id', pending.endpointId);
  }

  let res;
  try {
    res = await fetch(`${API_BASE}/api/session`, { method: 'POST', body: fd });
  } catch (e) {
    uiModule.showError(t('sessions.failed_reach_backend', { error: e }));
    return false;
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = { detail: await res.text() };
  }

  if (!res.ok) {
    uiModule.showError(t('sessions.session_create_failed', { status: res.status, detail: payload.detail || JSON.stringify(payload) }));
    return false;
  }

  if (isIncognito && payload.id) {
    _markIncognito(payload.id);
  }

  // 清除上一个会话的残留文档文本选择
  if (window.documentModule?.clearSelection) {
    try { window.documentModule.clearSelection(); } catch {}
  }
  currentSessionId = payload.id;
  Storage.set('lastSessionId', payload.id);
  history.replaceState(null, '', '#' + payload.id);

  // 重新加载侧边栏以显示新会话 — 等待它以便会话
  // 在调用方继续之前完全注册（防止竞态条件）
  await loadSessions().catch(() => {});
  return true;
}

export function hasPendingChat() { return !!_pendingChat; }
export function getPendingChat() { return _pendingChat; }
// 外部访问的 getter
export function getCurrentSessionId() {
  return currentSessionId;
}

export function getSessions() {
  return sessions;
}

export function getCurrentModel() {
  const sess = sessions.find(x => x.id === currentSessionId);
  if (sess && sess.model) return sess.model;
  // 待定会话尚未实体化 — 从模型选择器标签读取
  const label = document.getElementById('model-picker-label');
  return label ? label.textContent.trim() : null;
}

/** 为当前（或待定）会话模型提供服务的 Endpoint URL。用于
 *  判断模型是本地（免费）还是付费云服务商。 */
export function getCurrentEndpointUrl() {
  const sess = sessions.find(x => x.id === currentSessionId);
  if (sess && sess.endpoint_url) return sess.endpoint_url;
  if (_pendingChat && _pendingChat.url) return _pendingChat.url;
  return null;
}

export function setCurrentSessionId(id) {
  _sessionNavToken++;
  currentSessionId = id;
  if (!id) {
    Storage.remove('lastSessionId');
    history.replaceState(null, '', window.location.pathname);
    document.querySelectorAll('.list-item.active-session, .session-item.active').forEach(el => {
      el.classList.remove('active-session', 'active');
    });
  }
}

// 会话列表键盘导航：方向键移动，Delete 删除
async function _onSessionListKeydown(e) {
  const item = e.target.closest('.list-item[data-session-id]');
  if (!item) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    // 获取所有容器中可见的会话项
    const allItems = Array.from(document.querySelectorAll('#session-list .list-item[data-session-id]'));
    const idx = allItems.indexOf(item);
    if (idx < 0) return;
    const next = e.key === 'ArrowDown' ? allItems[idx + 1] : allItems[idx - 1];
    if (next) {
      next.focus();
      const sid = next.dataset.sessionId;
      if (sid) selectSession(sid);
    }
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    const sid = item.dataset.sessionId;
    const s = sessions.find(x => x.id === sid);
    if (!s) return;
    if (s.is_important) {
      uiModule.showToast(t('sessions.unfavorite_before_delete'));
      return;
    }
    const ok = await uiModule.styledConfirm(t('sessions.delete_session_confirm'), { confirmText: t('common.delete'), danger: true });
    if (!ok) return;
    _sessionListFocused = true;
    (async () => {
      await fetch(`${API_BASE}/api/session/${s.id}`, { method: 'DELETE' });
      _deselectCurrentSession(s.id);
      await loadSessions();
    })();
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    const sid = item.dataset.sessionId;
    if (sid) selectSession(sid);
    return;
  }
}

// 初始化会话拖拽排序 — 使用与模型相同的 dragSortModule
export function initDragSort() {
  if (!window.dragSortModule) return;
  const list = uiModule.el('session-list');
  if (!list) return;

  // 未分类会话（排除文件夹内嵌的项）
  window.dragSortModule.enable('session-list', '.list-item', {
    instanceKey: 'session-items',
    handleSelector: '.item-drag-handle',
    excludeSelector: '.session-folder-content .list-item',
    storageKey: 'session-order',
  });

  // 文件夹重排序
  window.dragSortModule.enable('session-list', '.session-folder', {
    instanceKey: 'session-folders',
    handleSelector: '.folder-drag-handle',
    onReorder: (items) => {
      const order = items.map(f => f.dataset.folderName).filter(Boolean);
      saveFolderOrder(order);
    },
  });

  // 每个文件夹内的会话
  list.querySelectorAll('.session-folder-content').forEach((content, i) => {
    const id = 'session-folder-content-' + i;
    content.id = id;
    window.dragSortModule.enable(id, '.list-item', {
      handleSelector: '.item-drag-handle',
    });
  });
}

// 基于 Hash 的路由：使用浏览器前进/后退在会话间导航。
// 跳过实体前缀的 hash（document-、note- 等）— 这些由
// chatRenderer.js 中自己的点击处理器处理，不能触发
// 会话导航（否则会重置当前活跃聊天）。
window.addEventListener('hashchange', () => {
  const hashId = window.location.hash.replace('#', '');
  if (/^(document|note|image|email|event|task|skill|research)-/.test(hashId)) return;
  if (hashId && hashId !== currentSessionId) {
    const target = sessions.find(s => s.id === hashId && !s.archived);
    if (target) selectSession(hashId);
  }
});

// ── Research 指示器管理 ──
function _updateResearchDots() {
  document.querySelectorAll('.session-star[data-session-id]').forEach(function(star) {
    var sid = star.dataset.sessionId;
    var isRunning = _researchingSessions.has(sid) || _streamingSessions.has(sid);
    var isCompleted = _completedSessions.has(sid) && !isRunning;
    var listItem = star.closest('.list-item');
    star.classList.toggle('processing', isRunning);
    star.classList.toggle('notify', isCompleted);
    if (listItem) listItem.classList.toggle('stream-complete', isCompleted);

    if (isRunning || isCompleted) {
      star.style.opacity = '1';
    } else {
      star.style.opacity = '';
    }
  });
}

function _startResearchPolling() {
  if (_researchPollTimer) return;
  _researchPollTimer = setInterval(async function() {
    if (_researchingSessions.size === 0) {
      clearInterval(_researchPollTimer);
      _researchPollTimer = null;
      return;
    }
    for (var sid of _researchingSessions) {
      try {
        var res = await fetch(`${API_BASE}/api/research/status/${sid}`);
        if (!res.ok) { _researchingSessions.delete(sid); continue; }
        var data = await res.json();
        if (data.status !== 'running') {
          _researchingSessions.delete(sid);
        }
      } catch (e) {
        _researchingSessions.delete(sid);
      }
    }
    _updateResearchDots();
    if (_researchingSessions.size === 0 && _researchPollTimer) {
      clearInterval(_researchPollTimer);
      _researchPollTimer = null;
    }
  }, 5000);
}

export function markResearching(sessionId) {
  _researchingSessions.add(sessionId);
  _updateResearchDots();
  _updateRailNotifs();
  _startResearchPolling();
}

export function clearResearching(sessionId) {
  _researchingSessions.delete(sessionId);
  _updateResearchDots();
  _updateRailNotifs();
}

export function markStreaming(sessionId) {
  _streamingSessions.add(sessionId);
  _updateResearchDots();
  _updateRailNotifs();
}

export function clearStreaming(sessionId) {
  _streamingSessions.delete(sessionId);
  _updateResearchDots();
  _updateRailNotifs();
}

export function markStreamComplete(sessionId) {
  _researchingSessions.delete(sessionId);
  _streamingSessions.delete(sessionId);
  // 如果用户已在查看此会话则不跳动 — 他们可以看到响应
  if (currentSessionId === sessionId) {
    _updateResearchDots();
    _updateRailNotifs();
    return;
  }
  _completedSessions.add(sessionId);
  _updateResearchDots();
  _updateRailNotifs();
  // 如果 Chats 分区已折叠则显示通知圆点
  const sessSection = document.getElementById('sessions-section');
  if (sessSection && sessSection.classList.contains('collapsed')) {
    const dot = document.getElementById('chats-notif-dot');
    if (dot) dot.style.display = 'inline-block';
  }
  // 安全网：一个 tick 后重新应用，以防并发的 renderSessionList 覆盖 DOM
  setTimeout(function() {
    if (_completedSessions.has(sessionId)) {
      _updateResearchDots();
    }
  }, 300);
}

// ── 导航栏通知圆点 ──
// 当后台工作进行中/完成时保持导航栏按钮亮起
function _updateRailNotifs() {
  // Research 导航栏 — 有任何会话在进行 Research 时跳动
  const railResearch = document.getElementById('rail-research');
  if (railResearch) {
    // OR 混合 Deep Research 面板的任务状态（由 panel.js 设置）
    // 以便内联 Research 和面板 Research 都能保持导航栏亮起。
    const researching = _researchingSessions.size > 0 || !!window._researchJobsActive;
    railResearch.classList.toggle('rail-notify', researching);
  }
  // Chats 导航栏 — 后台流完成时显示
  const railChats = document.getElementById('rail-chats');
  if (railChats) {
    const sidebar = document.getElementById('sidebar');
    const sidebarHidden = sidebar && sidebar.classList.contains('hidden');
    const hasCompleted = _completedSessions.size > 0;
    railChats.classList.toggle('rail-notify', hasCompleted && sidebarHidden);
    railChats.classList.toggle('rail-notify-success', hasCompleted && sidebarHidden);
    // 存储第一个已完成会话以便点击打开
    if (hasCompleted) {
      railChats.dataset.targetSession = [..._completedSessions][0];
    } else {
      delete railChats.dataset.targetSession;
    }
  }
  // 触发导航栏同步以便按钮可见
  if (window._syncRailDynamic) window._syncRailDynamic();
}

/**
 * 检查服务器是否有活跃流（页面刷新后幸存）。
 * 如果服务器仍在为此会话进行流式传输，显示 spinner
 * 并轮询直到完成，然后重新加载会话。
 */
async function _checkServerStream(sessionId) {
  try {
    // 如果 Research 正在运行则跳过 — 它有自己的进度 UI
    if (_researchingSessions.has(sessionId)) return;

    // 如果 SSE 读取器仍在活跃连接则跳过 — 它处理渲染
    if (window.chatModule && window.chatModule.hasActiveStream && window.chatModule.hasActiveStream(sessionId)) return;

    const res = await fetch(`${API_BASE}/api/chat/stream_status/${sessionId}`);
    if (!res.ok) return; // 404 = 没有活跃流
    const info = await res.json();
    if (info.status !== 'streaming') return;

    // 如果是 Research 流则跳过 — Research 有自己的进度 UI
    if (info.mode === 'research' || info.is_research) return;

    // 实时恢复被移除的运行：重播其缓冲区然后流式传输实时 token
    // (#2539)。如果不可用则回退到下方的 spinner+轮询路径。
    if (window.chatModule && window.chatModule.resumeStream) {
      const attached = await window.chatModule.resumeStream(sessionId);
      if (attached) return;
    }

    // 回退方案：服务器仍在流式传输，显示 spinner 并轮询。
    const box = document.getElementById('chat-history');
    if (!box) return;

    const holder = document.createElement('div');
    holder.className = 'msg msg-ai';
    holder.innerHTML = '<div class="body"></div>';
    const bodyDiv = holder.querySelector('.body');

    const spinnerMod = await import('./spinner.js');
    const spinner = spinnerMod.default.create('Generating response...', 'right');
    bodyDiv.appendChild(spinner.createElement());
    spinner.start();
    box.appendChild(holder);
    uiModule.scrollHistory();

    // sessions.js 在模块顺序中先于 chat.js 执行，所以
    // _checkServerStream 首次运行时 window.chatModule 可能还未设置。
    // 在其可用时的第一个轮询周期中重试 resumeStream。
    let _resumeRetried = false;
    const pollId = setInterval(async () => {
      if (getCurrentSessionId() !== sessionId) {
        clearInterval(pollId);
        spinner.destroy();
        if (holder.parentNode) holder.remove();
        return;
      }
      if (!_resumeRetried && window.chatModule && window.chatModule.resumeStream) {
        _resumeRetried = true;
        const attached = await window.chatModule.resumeStream(sessionId);
        if (attached) {
          clearInterval(pollId);
          spinner.destroy();
          if (holder.parentNode) holder.remove();
          return;
        }
      }
      try {
        const r = await fetch(`${API_BASE}/api/chat/stream_status/${sessionId}`);
        if (!r.ok || (await r.json()).status !== 'streaming') {
          clearInterval(pollId);
          spinner.destroy();
          if (holder.parentNode) holder.remove();
          // 重新加载会话以显示完成的响应 + 文档
          selectSession(sessionId);
        }
      } catch (_) {
        clearInterval(pollId);
        spinner.destroy();
        if (holder.parentNode) holder.remove();
        selectSession(sessionId);
      }
    }, 1500);
  } catch (_) {
    // 没有活跃流 — 无需操作
  }
}

export function clearStreamComplete(sessionId) {
  _completedSessions.delete(sessionId);
  // 直接 DOM 清理，以防 _updateResearchDots 错过
  var item = document.querySelector(`.list-item[data-session-id="${sessionId}"]`);
  if (item) item.classList.remove('stream-complete');
  var star = document.querySelector(`.session-star[data-session-id="${sessionId}"]`);
  if (star) { star.classList.remove('notify', 'processing'); star.style.opacity = ''; }
  _updateResearchDots();
  _updateRailNotifs();
}

// DOM 准备好后初始化下拉菜单
function _initAllDropdowns() {
  initModelPicker({
    getCurrentSessionId: () => currentSessionId,
    getSessions: () => sessions,
    getPendingChat: () => _pendingChat,
    setPendingChat: (v) => { _pendingChat = v; },
    createDirectChat,
  });
  _initDropdownDismiss();
  _initBulkSelect();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initAllDropdowns);
} else {
  _initAllDropdowns();
}

// 共享全局监听器，点击外部或 Escape 时关闭所有会话下拉菜单
function _initDropdownDismiss() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('.session-dropdown-menu')) return;
    document.querySelectorAll('.session-dropdown-menu').forEach(d => d.style.display = 'none');
  });
  // 监视侧边栏 — 当它被隐藏时（任何路径：汉堡菜单、滑动、
  // 移动端折叠），关闭任何打开的会话下拉菜单，以免它们漂浮在
  // 页面上。
  const _sb = document.getElementById('sidebar');
  if (_sb) {
    new MutationObserver(() => {
      if (_sb.classList.contains('hidden')) {
        document.querySelectorAll('.session-dropdown-menu, .folder-submenu').forEach(d => d.style.display = 'none');
      }
    }).observe(_sb, { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.session-dropdown-menu').forEach(d => d.style.display = 'none');
    }
  });
}

// ──────────────────────────────────────────────
// 共享：定位下拉菜单
// ──────────────────────────────────────────────

/**
 * 显示一个锚定到按钮的下拉菜单，使用现有的
 * .dropdown / .dropdown-item-compact / .session-dropdown-menu CSS。
 * 项目：[{ label, action, danger? }]
 * 返回一个 close() 函数。
 */
function _showDropdown(anchorEl, items) {
  // 关闭任何已打开的归档下拉菜单
  document.querySelectorAll('.session-dropdown-menu.archive-dd').forEach(d => d.remove());

  const dd = document.createElement('div');
  dd.className = 'dropdown session-dropdown-menu archive-dd';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'dropdown-item-compact' + (item.danger ? ' dropdown-item-danger' : '');
    row.innerHTML = '<span>' + item.label + '</span>';
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      item.action();
    });
    dd.appendChild(row);
  }
  document.body.appendChild(dd);

  // 使用视口坐标定位（与会话菜单相同的模式）
  const rect = anchorEl.getBoundingClientRect();
  dd.style.right = (window.innerWidth - rect.right) + 'px';
  dd.style.top = '-9999px';
  dd.style.display = 'block';
  const ddRect = dd.getBoundingClientRect();
  if (rect.bottom + 2 + ddRect.height > window.innerHeight) {
    dd.style.top = Math.max(2, rect.top - ddRect.height - 2) + 'px';
  } else {
    dd.style.top = (rect.bottom + 2) + 'px';
  }

  function close() { dd.remove(); }
  // 现有的 _initDropdownDismiss 处理 .session-dropdown-menu 的点击外部和 Escape
  return close;
}


// ──────────────────────────────────────────────
// 归档浏览器
// ──────────────────────────────────────────────

// 所有可变的归档状态存储在此处；每次 openArchive() 时重置。
const _arc = { data: [], total: 0, search: '', offset: 0, sort: 'recent', model: '', debounce: null, selectMode: false, selected: new Set(), allModelCounts: null };

function _arcRelativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ── 操作（纯副作用，不创建 DOM）──

// 预览归档会话 — 不取消归档直接加载其历史
let _peekingSessionId = null;

async function _arcPeekOpen(sid) {
  try {
    _peekingSessionId = sid;
    closeArchive();
    // 不取消归档直接加载历史
    const res = await fetch(`${API_BASE}/api/history/${sid}`);
    const data = await res.json();
    const history = data.history || [];

    // 设为当前会话以便聊天渲染
    currentSessionId = sid;

    // 查找归档会话的元数据
    const meta = _arc.data.find(s => s.id === sid);
    const metaEl = document.getElementById('current-meta');
    if (metaEl) metaEl.textContent = (meta?.name || 'Archived') + ' (archived)';

    // 渲染聊天历史
    const chatBox = document.getElementById('chat-history');
    if (chatBox) chatBox.innerHTML = '';
    if (window.chatModule && window.chatModule.hideWelcomeScreen) window.chatModule.hideWelcomeScreen();

    const addMsg = window.chatModule && window.chatModule.addMessage;
    if (addMsg) {
      for (const msg of history) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          const model = String((msg.metadata && msg.metadata.model) || '');
          const content = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content : String(msg.content || ''));
          try { addMsg(msg.role, content, model, msg.metadata || null); } catch (e) { console.warn('Failed to render message:', e); }
        }
      }
    }
    if (window.uiModule) window.uiModule.scrollHistory();
  } catch (e) {
    console.error('Peek open failed:', e);
    uiModule.showError(t('sessions.failed_open_archived'));
  }
}

// 导航离开已预览会话时，仅清除状态
function _checkPeekCleanup(newSessionId) {
  if (_peekingSessionId && _peekingSessionId !== newSessionId) {
    _peekingSessionId = null;
  }
}

async function _arcRestore(sid) {
  try {
    const res = await fetch(`${API_BASE}/api/session/${sid}/unarchive`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed');
    _arcRemove(sid);
    _arcRefreshUI();
    uiModule.showToast(t('sessions.session_restored'));
    loadSessions();
  } catch { uiModule.showError(t('sessions.failed_restore_session')); }
}

async function _arcDelete(sid) {
  if (!await window.styledConfirm(t('sessions.delete_permanently_confirm'), { confirmText: 'Delete', danger: true })) return;
  try {
    const res = await fetch(`${API_BASE}/api/session/${sid}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed');
    await _animateSessionRowsRemoving([sid], '#archive-grid .archive-row[data-session-id]');
    _arcRemove(sid);
    _arcRefreshUI();
    uiModule.showToast(t('sessions.session_deleted'));
  } catch { uiModule.showError(t('sessions.failed_delete_session')); }
}

function _arcRemove(sid) {
  _arc.data = _arc.data.filter(x => x.id !== sid);
  _arc.total--;
  _arc.selected.delete(sid);
}

async function _arcBulkRestore() {
  const ids = [..._arc.selected];
  if (!ids.length) return;
  for (const sid of ids) {
    try {
      await fetch(`${API_BASE}/api/session/${sid}/unarchive`, { method: 'POST' });
      _arcRemove(sid);
    } catch {}
  }
  _arc.selected.clear();
  _arcRefreshUI();
  uiModule.showToast(`${ids.length} session${ids.length > 1 ? 's' : ''} restored`);
  loadSessions();
}

async function _arcBulkDelete() {
  const ids = [..._arc.selected];
  if (!ids.length) return;
  const ok = await uiModule.styledConfirm(`Delete ${ids.length} session${ids.length > 1 ? 's' : ''} permanently?`, { confirmText: 'Delete', danger: true });
  if (!ok) return;
  const deletedIds = [];
  for (const sid of ids) {
    try {
      const res = await fetch(`${API_BASE}/api/session/${sid}`, { method: 'DELETE' });
      if (res.ok) {
        deletedIds.push(sid);
        _arcRemove(sid);
      }
    } catch {}
  }
  await _animateSessionRowsRemoving(deletedIds, '#archive-grid .archive-row[data-session-id]');
  _arc.selected.clear();
  _arcRefreshUI();
  uiModule.showToast(`${deletedIds.length} session${deletedIds.length > 1 ? 's' : ''} deleted`);
}

function _arcToggleSelectMode() {
  _arc.selectMode = !_arc.selectMode;
  _arc.selected.clear();
  _arcRefreshUI();
}

function _arcUpdateBulkBar() {
  const bar = document.getElementById('archive-bulk-bar');
  const count = document.getElementById('archive-selected-count');
  const selectBtn = document.getElementById('archive-select-btn');
  if (bar) bar.classList.toggle('hidden', !_arc.selectMode);
  if (count) count.textContent = `${_arc.selected.size} selected`;
  if (selectBtn) {
    selectBtn.textContent = _arc.selectMode ? 'Cancel' : 'Select';
    selectBtn.classList.toggle('active', _arc.selectMode);
  }
}

// ── 数据获取 ──

async function _arcFetch(append) {
  if (!append) _arc.offset = 0;
  const params = new URLSearchParams({ offset: String(_arc.offset), limit: '20', sort: _arc.sort });
  if (_arc.search) params.set('search', _arc.search);
  if (_arc.model) params.set('model', _arc.model);
  try {
    const res = await fetch(`${API_BASE}/api/sessions/archived?${params}`);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    _arc.data = append ? _arc.data.concat(data.sessions) : data.sessions;
    _arc.total = data.total;
    // 缓存未过滤的首次获取中的模型统计数据
    if (!_arc.allModelCounts && !_arc.model && !_arc.search) {
      const counts = {};
      _arc.data.forEach(s => {
        const m = (s.model || '').split('/').pop();
        if (m) counts[m] = (counts[m] || 0) + 1;
      });
      _arc.allModelCounts = { counts, total: _arc.total };
    }
    _arcRefreshUI();
  } catch (e) {
    console.error('Archive fetch failed:', e);
  }
}

// ── 渲染（纯状态 — 读取 _arc，写入 DOM）──

function _arcRefreshUI() {
  _arcRenderStats();
  _arcRenderChips();
  _arcRenderGrid();
  _arcRenderLoadMore();
  _arcUpdateBulkBar();
}

function _arcRenderStats() {
  const el = document.getElementById('archive-stats');
  if (el) el.textContent = _arc.total ? `${_arc.total}` : '';
}

function _arcRenderChips() {
  const el = document.getElementById('archive-chips');
  if (!el) return;
  // 使用缓存统计数据，以免过滤时 chip 消失
  const cached = _arc.allModelCounts;
  if (!cached) return;
  const modelCounts = cached.counts;
  const models = Object.keys(modelCounts).sort();
  if (models.length < 2) { el.innerHTML = ''; return; }
  el.innerHTML = '';
  const mkChip = (label, value, count) => {
    const chip = document.createElement('button');
    chip.className = 'doclib-chip' + (_arc.model === value ? ' active' : '');
    chip.textContent = `${label} (${count})`;
    chip.addEventListener('click', () => { _arc.model = (_arc.model === value ? '' : value); _arcFetch(false); });
    el.appendChild(chip);
  };
  mkChip('All', '', cached.total);
  models.forEach(m => mkChip(m, m, modelCounts[m]));
}

function _arcRenderCard(s) {
  const card = document.createElement('div');
  card.className = 'memory-item archive-row' + (_arc.selected.has(s.id) ? ' selected' : '');
  card.dataset.sessionId = s.id;
  const modelShort = uiModule.esc((s.model || '').split('/').pop());
  const msgCount = s.message_count || 0;
  const checkboxHtml = _arc.selectMode
    ? `<input type="checkbox" class="memory-select-cb archive-checkbox" data-sid="${s.id}" ${_arc.selected.has(s.id) ? 'checked' : ''}>`
    : '';

  card.innerHTML = `
    ${checkboxHtml}
    <div style="flex:1;min-width:0;">
      <div class="memory-item-title">${uiModule.esc(s.name || t('common.unnamed'))}</div>
      <div class="memory-item-meta" style="font-size:10px;opacity:0.4;margin-top:2px;">
        <span>${modelShort || 'no model'}</span>
        <span>\u00b7</span>
        <span>${msgCount} msg${msgCount !== 1 ? 's' : ''}</span>
        <span>\u00b7</span>
        <span>${_arcRelativeTime(s.updated_at)}</span>
      </div>
    </div>
    <div class="memory-item-actions">
      <button class="memory-item-btn archive-menu-btn" title="Actions"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
    </div>
  `;

  const checkbox = card.querySelector('.archive-checkbox');
  if (checkbox) {
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      if (e.target.checked) _arc.selected.add(s.id);
      else _arc.selected.delete(s.id);
      card.classList.toggle('selected', e.target.checked);
      _arcUpdateBulkBar();
    });
  }
  card.querySelector('.archive-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    _showDropdown(e.currentTarget, [
      { label: t('sessions.open'), action: () => _arcPeekOpen(s.id) },
      { label: t('sessions.restore'), action: () => _arcRestore(s.id) },
      { label: 'Delete', action: () => _arcDelete(s.id), danger: true },
    ]);
  });
  card.addEventListener('click', () => {
    if (_arc.selectMode) {
      if (_arc.selected.has(s.id)) _arc.selected.delete(s.id);
      else _arc.selected.add(s.id);
      const cb = card.querySelector('.archive-checkbox');
      if (cb) cb.checked = _arc.selected.has(s.id);
      card.classList.toggle('selected', _arc.selected.has(s.id));
      _arcUpdateBulkBar();
    } else {
      _arcPeekOpen(s.id);
    }
  });
  return card;
}

function _arcRenderGrid() {
  const grid = document.getElementById('archive-grid');
  if (!grid) return;
  if (_arc.data.length === 0) {
    grid.innerHTML = '<div class="doclib-empty">No archived sessions</div>';
    return;
  }
  grid.innerHTML = '';
  for (const s of _arc.data) grid.appendChild(_arcRenderCard(s));
}

function _arcRenderLoadMore() {
  const btn = document.getElementById('archive-load-more');
  if (!btn) return;
  btn.style.display = _arc.data.length < _arc.total ? '' : 'none';
}


// ── 统一图书馆模态窗（聊天/文档/归档）──

const _lib = { tab: 'chats', search: '', sort: 'recent', debounce: null, selectMode: false, selected: new Set() };

export function openLibrary(defaultTab) {
  // 将所有功能委托给文档模块的图书馆（有聊天/文档/归档标签页）
  if (window.documentModule && window.documentModule.openLibrary) {
    window.documentModule.openLibrary({ tab: defaultTab || 'documents' });
    return;
  }
  if (document.getElementById('library-modal')) return;
  Object.assign(_lib, { tab: defaultTab || 'chats', search: '', sort: 'recent', debounce: null, selectMode: false, selected: new Set() });

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'library-modal';
  modal.innerHTML = `
    <div class="modal-content doclib-modal-content">
      <div class="modal-header">
        <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>Library <span id="lib-stats" style="font-size:0.8em;opacity:0.5;font-weight:normal;margin-left:4px"></span></h4>
        <button class="close-btn" id="lib-close">✖</button>
      </div>
      <div class="modal-body">
        <div class="lib-tabs" id="lib-tabs">
          <button class="lib-tab${_lib.tab === 'chats' ? ' active' : ''}" data-lib-tab="chats">Chats</button>
          <button class="lib-tab${_lib.tab === 'documents' ? ' active' : ''}" data-lib-tab="documents">Documents</button>
          <button class="lib-tab${_lib.tab === 'archive' ? ' active' : ''}" data-lib-tab="archive">Archive</button>
          <button class="lib-tab${_lib.tab === 'research' ? ' active' : ''}" data-lib-tab="research">Research</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <select class="memory-sort-select" id="lib-sort">
            <option value="recent">Recent</option>
            <option value="oldest">Oldest</option>
            <option value="most-messages">Most messages</option>
            <option value="alpha">A\u2013Z</option>
          </select>
          <input type="text" class="memory-search-input" id="lib-search" placeholder="Filter\u2026" style="flex:1;" />
          <button class="memory-toolbar-btn" id="lib-select-btn" title="Select">Select</button>
        </div>
        <div class="memory-bulk-bar hidden" id="lib-bulk-bar">
          <label class="memory-bulk-check-all"><input type="checkbox" id="lib-select-all"> All</label>
          <span id="lib-selected-count" style="color:color-mix(in srgb, var(--fg) 50%, transparent);font-size:10px;flex:1;">0 selected</span>
          <button class="memory-toolbar-btn" id="lib-bulk-action1"></button>
          <button class="memory-toolbar-btn danger" id="lib-bulk-delete">Delete</button>
        </div>
        <div class="doclib-grid archive-list" id="lib-grid"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // 可拖动
  const _clContent = modal.querySelector('.modal-content');
  const _clHeader = modal.querySelector('.modal-header');
  if (themeModule && themeModule.makeDraggable && _clContent && _clHeader) {
    themeModule.makeDraggable(_clContent, _clHeader);
  }

  document.getElementById('lib-close').addEventListener('click', closeLibrary);

  // 标签页切换
  modal.querySelectorAll('.lib-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      // 文档标签页 — 打开文档模块的图书馆（有展开/预览）
      if (tab.dataset.libTab === 'documents' && window.documentModule && window.documentModule.openLibrary) {
        closeLibrary();
        window.documentModule.openLibrary();
        return;
      }
      _lib.tab = tab.dataset.libTab;
      _lib.search = '';
      _lib.selectMode = false;
      _lib.selected.clear();
      modal.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('lib-search').value = '';
      document.getElementById('lib-bulk-bar').classList.add('hidden');
      // 根据标签页更新批量操作按钮标签
      const action1 = document.getElementById('lib-bulk-action1');
      if (_lib.tab === 'archive') { action1.textContent = t('sessions.restore'); }
      else if (_lib.tab === 'chats') { action1.textContent = 'Archive'; }
      else if (_lib.tab === 'research') { action1.textContent = 'Open Report'; }
      else { action1.textContent = 'Export'; }
      _renderLibGrid();
    });
  });

  // 设置初始批量操作按钮标签
  const _initAction = document.getElementById('lib-bulk-action1');
  if (_initAction) _initAction.textContent = _lib.tab === 'archive' ? t('sessions.restore') : _lib.tab === 'documents' ? 'Export' : 'Archive';

  document.getElementById('lib-sort').addEventListener('change', () => { _lib.sort = document.getElementById('lib-sort').value; _renderLibGrid(); });
  document.getElementById('lib-search').addEventListener('input', (e) => {
    clearTimeout(_lib.debounce);
    _lib.debounce = setTimeout(() => { _lib.search = e.target.value.trim().toLowerCase(); _renderLibGrid(); }, 200);
  });

  // 选择模式
  document.getElementById('lib-select-btn').addEventListener('click', () => {
    _lib.selectMode = !_lib.selectMode;
    _lib.selected.clear();
    document.getElementById('lib-bulk-bar').classList.toggle('hidden', !_lib.selectMode);
    _renderLibGrid();
  });
  document.getElementById('lib-select-all').addEventListener('change', (e) => {
    const checked = e.target.checked;
    document.querySelectorAll('#lib-grid .memory-select-cb').forEach(cb => { cb.checked = checked; });
    document.querySelectorAll('#lib-grid .doclib-card').forEach(card => {
      const id = card.dataset.sessionId || card.dataset.docId;
      if (id) { if (checked) _lib.selected.add(id); else _lib.selected.delete(id); }
    });
    _updateLibCount();
  });

  // 批量操作 1（归档/恢复/导出）
  document.getElementById('lib-bulk-action1').addEventListener('click', async () => {
    if (_lib.tab === 'chats') {
      for (const sid of _lib.selected) await fetch(`${API_BASE}/api/session/${sid}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      uiModule.showToast(`Archived ${_lib.selected.size} sessions`);
    } else if (_lib.tab === 'archive') {
      for (const sid of _lib.selected) await fetch(`${API_BASE}/api/session/${sid}/restore`, { method: 'POST' });
      uiModule.showToast(`Restored ${_lib.selected.size} sessions`);
    }
    _lib.selected.clear();
    _lib.selectMode = false;
    document.getElementById('lib-bulk-bar').classList.add('hidden');
    await loadSessions();
    _renderLibGrid();
  });

  // 批量删除
  document.getElementById('lib-bulk-delete').addEventListener('click', async () => {
    if (!await uiModule.styledConfirm(`Delete ${_lib.selected.size} items?`, { confirmText: 'Delete', danger: true })) return;
    if (_lib.tab === 'chats' || _lib.tab === 'archive') {
      for (const sid of _lib.selected) await fetch(`${API_BASE}/api/session/${sid}`, { method: 'DELETE' });
    } else if (_lib.tab === 'documents') {
      for (const did of _lib.selected) await fetch(`${API_BASE}/api/document/${did}`, { method: 'DELETE' });
    } else if (_lib.tab === 'research') {
      for (const rid of _lib.selected) await fetch(`${API_BASE}/api/research/${rid}`, { method: 'DELETE' });
    }
    _lib.selected.clear();
    _lib.selectMode = false;
    document.getElementById('lib-bulk-bar').classList.add('hidden');
    await loadSessions();
    _renderLibGrid();
  });

  _renderLibGrid();
}

function _updateLibCount() {
  const el = document.getElementById('lib-selected-count');
  if (el) el.textContent = `${_lib.selected.size} selected`;
}

function _renderLibGrid() {
  const grid = document.getElementById('lib-grid');
  if (!grid) return;

  if (_lib.tab === 'chats') _renderLibChats(grid);
  else if (_lib.tab === 'archive') _renderLibArchive(grid);
  else if (_lib.tab === 'documents') _renderLibDocuments(grid);
  else if (_lib.tab === 'research') _renderLibResearch(grid);
}

function _renderLibChats(grid) {
  if (!sessions || !sessions.length) {
    grid.innerHTML = '<div class="doclib-empty">No sessions loaded</div>';
    return;
  }
  let filtered = sessions.filter(s => !s.archived);
  if (_lib.search) {
    const q = _lib.search;
    filtered = filtered.filter(s => (s.name || '').toLowerCase().includes(q) || (s.model || '').toLowerCase().includes(q));
  }
  if (_lib.sort === 'oldest') filtered.sort((a, b) => (a.created_at || '') > (b.created_at || '') ? 1 : -1);
  else if (_lib.sort === 'most-messages') filtered.sort((a, b) => (b.message_count || 0) - (a.message_count || 0));
  else if (_lib.sort === 'alpha') filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  else filtered.sort((a, b) => (b.updated_at || '') > (a.updated_at || '') ? 1 : -1);

  const stats = document.getElementById('lib-stats');
  if (stats) stats.textContent = `(${filtered.length})`;

  if (!filtered.length) { grid.innerHTML = '<div class="doclib-empty">No chats found</div>'; return; }
  grid.innerHTML = '';
  for (const s of filtered) {
    const card = _buildLibCard(s.id, s.name || t('common.unnamed'), s.message_count || 0, (s.model || '').split('/').pop(), s.updated_at, s.id === currentSessionId);
    card.addEventListener('click', (e) => {
      if (e.target.closest('.archive-menu-btn,.memory-select-cb')) return;
      if (_lib.selectMode) { _toggleLibSelect(card, s.id); return; }
      closeLibrary(); selectSession(s.id);
    });
    card.querySelector('.archive-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      _showDropdown(e.currentTarget, [
        { label: t('sessions.open'), action: () => { closeLibrary(); selectSession(s.id); } },
        { label: 'Archive', action: async () => { await fetch(`${API_BASE}/api/session/${s.id}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }); await loadSessions(); _renderLibGrid(); } },
        { label: 'Delete', action: async () => { if (!await uiModule.styledConfirm('Delete?', { confirmText: 'Delete', danger: true })) return; await fetch(`${API_BASE}/api/session/${s.id}`, { method: 'DELETE' }); await loadSessions(); _renderLibGrid(); }, danger: true },
      ]);
    });
    grid.appendChild(card);
  }
}

async function _renderLibArchive(grid) {
  grid.innerHTML = '';
  grid.appendChild(spinnerModule.createLoadingRow('Loading…'));
  try {
    const params = new URLSearchParams({ limit: '50', sort: _lib.sort === 'most-messages' ? 'messages' : _lib.sort });
    if (_lib.search) params.set('search', _lib.search);
    const res = await fetch(`${API_BASE}/api/sessions/archived?${params}`);
    const data = await res.json();
    const items = data.sessions || [];
    const stats = document.getElementById('lib-stats');
    if (stats) stats.textContent = `(${data.total || items.length})`;
    if (!items.length) { grid.innerHTML = '<div class="doclib-empty">No archived sessions</div>'; return; }
    grid.innerHTML = '';
    for (const s of items) {
      const card = _buildLibCard(s.id, s.name || t('common.unnamed'), s.message_count || 0, (s.model || '').split('/').pop(), s.updated_at);
      card.addEventListener('click', (e) => {
        if (e.target.closest('.archive-menu-btn,.memory-select-cb')) return;
        if (_lib.selectMode) { _toggleLibSelect(card, s.id); return; }
      });
      card.querySelector('.archive-menu-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        _showDropdown(e.currentTarget, [
          { label: t('sessions.restore'), action: async () => { await fetch(`${API_BASE}/api/session/${s.id}/restore`, { method: 'POST' }); await loadSessions(); _renderLibGrid(); } },
          { label: 'Delete', action: async () => { if (!await uiModule.styledConfirm('Delete?', { confirmText: 'Delete', danger: true })) return; await fetch(`${API_BASE}/api/session/${s.id}`, { method: 'DELETE' }); _renderLibGrid(); }, danger: true },
        ]);
      });
      grid.appendChild(card);
    }
  } catch (e) { console.error('Library archive error:', e); grid.innerHTML = '<div class="doclib-empty">Failed to load archive</div>'; }
}

async function _renderLibDocuments(grid) {
  grid.innerHTML = '';
  grid.appendChild(spinnerModule.createLoadingRow('Loading…'));
  try {
    const params = new URLSearchParams({ limit: '50', sort: _lib.sort });
    if (_lib.search) params.set('search', _lib.search);
    const res = await fetch(`${API_BASE}/api/documents/library?${params}`);
    const data = await res.json();
    const docs = data.documents || [];
    const stats = document.getElementById('lib-stats');
    if (stats) stats.textContent = `(${data.total || docs.length})`;
    if (!docs.length) { grid.innerHTML = '<div class="doclib-empty">No documents found</div>'; return; }
    grid.innerHTML = '';
    for (const d of docs) {
      const card = _buildLibCard(d.id, d.title || t('common.unnamed'), d.version_count || 1, d.language || 'text', d.updated_at, false, true);
      card.dataset.docId = d.id;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.archive-menu-btn,.memory-select-cb')) return;
        if (_lib.selectMode) { _toggleLibSelect(card, d.id); return; }
        // 在其会话中打开文档
        if (d.session_id && window.documentModule) {
          closeLibrary();
          selectSession(d.session_id);
          setTimeout(() => { if (window.documentModule.loadSessionDocs) window.documentModule.loadSessionDocs(d.session_id); }, 300);
        }
      });
      card.querySelector('.archive-menu-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        _showDropdown(e.currentTarget, [
          { label: t('sessions.open'), action: () => { if (d.session_id) { closeLibrary(); selectSession(d.session_id); } } },
          { label: 'Delete', action: async () => { if (!await uiModule.styledConfirm('Delete?', { confirmText: 'Delete', danger: true })) return; await fetch(`${API_BASE}/api/document/${d.id}`, { method: 'DELETE' }); _renderLibGrid(); }, danger: true },
        ]);
      });
      grid.appendChild(card);
    }
  } catch (e) { console.error('Library documents error:', e); grid.innerHTML = '<div class="doclib-empty">Failed to load documents</div>'; }
}

async function _renderLibResearch(grid) {
  grid.innerHTML = '';
  grid.appendChild(spinnerModule.createLoadingRow('Loading research…'));
  try {
    const params = new URLSearchParams({ limit: '50', sort: _lib.sort });
    if (_lib.search) params.set('search', _lib.search);
    const res = await fetch(`${API_BASE}/api/research/library?${params}`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const items = data.research || [];
    const statsEl = document.getElementById('lib-stats');
    if (statsEl) statsEl.textContent = `${data.total || 0} research`;
    grid.innerHTML = '';
    if (!items.length) {
      grid.innerHTML = '<div class="doclib-empty">No research found</div>';
      return;
    }
    for (const item of items) {
      const meta = [
        item.duration || '',
        item.rounds ? item.rounds + ' rounds' : '',
      ].filter(Boolean).join(' \u00b7 ');
      const card = _buildLibCard(
        item.id, item.query || '(untitled)', item.source_count || 0,
        meta, item.completed_at ? new Date(item.completed_at * 1000).toISOString() : '',
        false, false,
      );
      const metaEl = card.querySelector('.memory-item-meta');
      if (metaEl) metaEl.textContent = metaEl.textContent.replace(/\d+ msgs?/, (item.source_count || 0) + ' sources');
      card.addEventListener('click', (e) => {
        if (e.target.closest('.archive-menu-btn') || e.target.closest('.memory-select-cb')) return;
        window.open(`${API_BASE}/api/research/report/${item.id}`, '_blank');
      });
      const menuBtn = card.querySelector('.archive-menu-btn');
      if (menuBtn) {
        menuBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _showDropdown(e.currentTarget, [
            { label: 'Open Report', action: () => window.open(`${API_BASE}/api/research/report/${item.id}`, '_blank') },
            { label: 'Re-run', action: () => {
              const modal = document.getElementById('library-modal');
              if (modal) modal.style.display = 'none';
              const msgInput = document.getElementById('message');
              if (msgInput) { msgInput.value = item.query; msgInput.focus(); }
              uiModule.showToast('Toggle Research and send to re-run');
            }},
            { label: 'Delete', danger: true, action: async () => {
              if (!await window.styledConfirm('Delete this research?', { confirmText: 'Delete', danger: true })) return;
              await fetch(`${API_BASE}/api/research/${item.id}`, { method: 'DELETE' });
              _renderLibGrid();
            }},
          ]);
        });
      }
      grid.appendChild(card);
    }
  } catch (e) { console.error('Library research error:', e); grid.innerHTML = '<div class="doclib-empty">Failed to load research</div>'; }
}

function _buildLibCard(id, title, count, meta, time, isActive, isDoc) {
  const card = document.createElement('div');
  card.className = 'memory-item';
  card.dataset.sessionId = id;
  if (isDoc) card.dataset.docId = id;
  const cbHtml = _lib.selectMode ? `<input type="checkbox" class="memory-select-cb"${_lib.selected.has(id) ? ' checked' : ''}>` : '';
  const metaParts = [];
  if (meta) metaParts.push(uiModule.esc(meta));
  metaParts.push(isDoc ? 'v' + count : count + ' msg' + (count !== 1 ? 's' : ''));
  if (time) metaParts.push(_arcRelativeTime(time));
  card.innerHTML = `
    ${cbHtml}
    <div style="flex:1;min-width:0;">
      <div class="memory-item-title"${isActive ? ' style="color:var(--accent);"' : ''}>${uiModule.esc(title)}</div>
      <div class="memory-item-meta" style="font-size:10px;opacity:0.4;margin-top:2px;">${metaParts.join(' \u00b7 ')}</div>
    </div>
    <div class="memory-item-actions">
      <button class="memory-item-btn archive-menu-btn" title="Actions"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
    </div>
  `;
  const cb = card.querySelector('.memory-select-cb');
  if (cb) {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => { if (cb.checked) _lib.selected.add(id); else _lib.selected.delete(id); _updateLibCount(); });
  }
  return card;
}

function _toggleLibSelect(card, id) {
  const cb = card.querySelector('.memory-select-cb');
  if (cb) { cb.checked = !cb.checked; if (cb.checked) _lib.selected.add(id); else _lib.selected.delete(id); _updateLibCount(); }
}

export function closeLibrary() {
  const modal = document.getElementById('library-modal');
  if (modal) {
    const content = modal.querySelector('.modal-content');
    if (content) {
      content.classList.add('modal-closing');
      content.addEventListener('animationend', () => modal.remove(), { once: true });
      setTimeout(() => { if (modal.parentElement) modal.remove(); }, 250);
    } else {
      modal.remove();
    }
  }
}

export function openArchive() {
  if (document.getElementById('archive-modal')) return;
  Object.assign(_arc, { data: [], total: 0, search: '', offset: 0, sort: 'recent', model: '', debounce: null, selectMode: false, selected: new Set(), allModelCounts: null });

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'archive-modal';
  modal.innerHTML = `
    <div class="modal-content doclib-modal-content">
      <div class="modal-header">
        <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>Archive <span id="archive-stats" style="font-size:0.8em;opacity:0.5;font-weight:normal;margin-left:4px"></span></h4>
        <button class="close-btn" id="archive-close">✖</button>
      </div>
      <div class="modal-body">
        <div class="doclib-chips" id="archive-chips"></div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <select class="memory-sort-select" id="archive-sort">
            <option value="recent">Recent</option>
            <option value="oldest">Oldest</option>
            <option value="most-messages">Most messages</option>
            <option value="alpha">A\u2013Z</option>
          </select>
          <input type="text" class="memory-search-input" id="archive-search" placeholder="Filter\u2026" style="flex:1;" />
          <button class="memory-toolbar-btn" id="archive-select-btn" title="Select sessions">Select</button>
        </div>
        <div class="memory-bulk-bar hidden" id="archive-bulk-bar">
          <label class="memory-bulk-check-all"><input type="checkbox" id="archive-select-all"> All</label>
          <span id="archive-selected-count" style="color:color-mix(in srgb, var(--fg) 50%, transparent);font-size:10px;flex:1;">0 selected</span>
          <button class="memory-toolbar-btn" id="archive-bulk-restore">Restore</button>
          <button class="memory-toolbar-btn danger" id="archive-bulk-delete">Delete</button>
        </div>
        <div class="doclib-grid archive-list" id="archive-grid"></div>
        <button class="doclib-load-more" id="archive-load-more" style="display:none">Load more</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // 通过标头栏设置可拖动
  const _arcContent = modal.querySelector('.modal-content');
  const _arcHeader = modal.querySelector('.modal-header');
  if (themeModule && themeModule.makeDraggable && _arcContent && _arcHeader) {
    themeModule.makeDraggable(_arcContent, _arcHeader);
  }

  document.getElementById('archive-close').addEventListener('click', closeArchive);
  document.getElementById('archive-sort').addEventListener('change', (e) => { _arc.sort = e.target.value; _arcFetch(false); });
  document.getElementById('archive-search').addEventListener('input', (e) => {
    clearTimeout(_arc.debounce);
    _arc.debounce = setTimeout(() => { _arc.search = e.target.value.trim(); _arcFetch(false); }, 300);
  });
  document.getElementById('archive-load-more').addEventListener('click', () => { _arc.offset = _arc.data.length; _arcFetch(true); });
  document.getElementById('archive-select-btn').addEventListener('click', _arcToggleSelectMode);
  document.getElementById('archive-bulk-restore').addEventListener('click', _arcBulkRestore);
  document.getElementById('archive-bulk-delete').addEventListener('click', _arcBulkDelete);
  document.getElementById('archive-select-all').addEventListener('change', (e) => {
    if (e.target.checked) _arc.data.forEach(s => _arc.selected.add(s.id));
    else _arc.selected.clear();
    _arcRefreshUI();
  });
  modal.addEventListener('click', (e) => { if (uiModule.isTouchInsideModal()) return; if (e.target === modal) closeArchive(); });

  _arcFetch(false);
}

export function closeArchive() {
  const modal = document.getElementById('archive-modal');
  if (modal) {
    const content = modal.querySelector('.modal-content');
    if (content) {
      content.classList.add('modal-closing');
      content.addEventListener('animationend', () => modal.remove(), { once: true });
      setTimeout(() => { if (modal.parentElement) modal.remove(); }, 250);
    } else {
      modal.remove();
    }
  }
}

/** 更新会话的 has_documents 标志并重新渲染侧边栏图标 */
export function getSortMode() { return _sortMode; }
export function setSortMode(mode) {
  _sortMode = mode || null;
  if (mode) Storage.set('odysseus-session-sort', mode);
  else Storage.remove('odysseus-session-sort');
  renderSessionList();
}

export function setSessionHasDocs(sessionId, hasDocs) {
  const s = sessions.find(s => s.id === sessionId);
  if (s && s.has_documents !== hasDocs) {
    s.has_documents = hasDocs;
    renderSessionList();
  }
}

// 将所有函数导出到 window 以供主应用使用
const sessionModule = {
  initDependencies,
  renderSessionList,
  loadSessions,
  selectSession,
  createDirectChat,
  materializePendingSession,
  hasPendingChat,
  getPendingChat,
  getCurrentSessionId,
  getSessions,
  getCurrentModel,
  getCurrentEndpointUrl,
  setCurrentSessionId,
  initDragSort,
  updateModelPicker,
  markResearching,
  clearResearching,
  markStreaming,
  clearStreaming,
  markStreamComplete,
  clearStreamComplete,
  openLibrary,
  closeLibrary,
  openArchive,
  closeArchive,
  setSessionHasDocs,
  getSortMode,
  setSortMode
};

export { updateModelPicker };

export default sessionModule;
