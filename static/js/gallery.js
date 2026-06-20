/**
 * 画廊模块 — 照片备份 + AI 生成图片库。
 */

import uiModule from './ui.js';
import { openEditor, closeEditor, isEditorOpen } from './galleryEditor.js';
import spinnerModule from './spinner.js';
import { makeWindowDraggable } from './windowDrag.js';

const API_BASE = window.location.origin;
let _open = false;
let _galleryResizeHandler = null;

// 新图片生成时自动刷新画廊
window.addEventListener('gallery-refresh', () => {
  if (_open) _fetchLibrary(false);
});
let _items = [];
let _total = 0;
let _totalTagged = 0;

// 更新 AI 打标设置头部中的 "X/Y 已打标" 徽章。
function _updateTagCount() {
  const el = document.getElementById('gallery-tag-count');
  if (el) el.textContent = _total ? `${t('gallery.tagged_count', { tagged: _totalTagged, total: _total })}` : '';
}
let _search = '';
// 活动标签过滤器栈。多个标签 AND 组合 — 用户通过
// 点击标签芯片或在搜索框中按 Enter 来构建，
// 通过每个标签上的 × 来拆除。
let _activeTags = [];
let _activeModel = null;
let _activeAlbum = null;
let _galleryCascaded = false;   // 每次打开时播放一次多米诺级联动画
let _favoritesOnly = false;
let _sort = 'shuffle';
let _shuffleSeed = Math.floor(Math.random() * 2 ** 31);
let _offset = 0;
// 页大小 — 根据网格可见区域计算，使更高/更宽的
// 窗口（全屏）能获取足够多的照片填满屏幕，
// 而不是在固定的 24 张照片页面下方留白。上限为
// 后端的最大值 (100)。
let _limit = 24;
function _computeFetchLimit() {
  const grid = document.getElementById('gallery-grid');
  const COL_W = 168; // 160px 最小列宽 + 8px 间距
  const ROW_H = 200; // ~160px 图片 + 标题 + 间距
  const gridW = (grid && grid.clientWidth) || Math.min(window.innerWidth * 0.9, 1100);
  const cols = Math.max(2, Math.floor(gridW / COL_W));
  // 网格滚动视口最大高度为 60vh。
  const gridH = window.innerHeight * 0.6;
  const rows = Math.ceil(gridH / ROW_H) + 2; // +2 行缓冲区用于滚动
  return Math.min(100, Math.max(24, cols * rows));
}
let _searchDebounce = null;
let _escHandler = null;
let _albums = [];
// Albums 标签页 — 搜索过滤器 + 多选状态。与 Photos 标签页
// (_search, _selectMode) 保持一致，但作用域限定在相册网格。
let _albumSearch = '';
let _albumSelectMode = false;
const _albumSelected = new Set();

// ---- API 辅助函数 ----

async function _fetchLibrary(append) {
  // 每次拉取时重新计算页大小，以便在加载之间调整窗口大小/全屏
  // 时能拉取正确数量的照片。
  _limit = _computeFetchLimit();
  // First load with nothing on screen → show skeleton tiles instead of a blank
  // grid that then snaps to full. BUT: if the last successful load returned
  // zero items, skip the skeleton entirely — otherwise empty accounts flash
  // 8-20 placeholder tiles for ~200ms before snapping to the "No photos yet"
  // message, which read as glitchy.
  if (!append && _items.length === 0) {
    let _knownEmpty = false;
    try { _knownEmpty = localStorage.getItem('gallery-known-empty') === '1'; } catch (_) {}
    if (!_knownEmpty) _renderSkeletons(_limit);
  }
  if (!append) {
    _offset = 0;
    // Leave _items untouched until the response arrives — that's the
    // stale-while-revalidate trick that lets the gallery feel instant on
    // re-open. The new list replaces _items on success below; if the fetch
    // fails, the previous photos stay visible.
  }
  const params = new URLSearchParams({ sort: _sort, offset: _offset, limit: _limit });
  if (_sort === 'shuffle') params.set('seed', String(_shuffleSeed));
  if (_search) params.set('search', _search);
  if (_activeTags.length) params.set('tag', _activeTags.join(','));
  if (_activeModel) params.set('model', _activeModel);
  if (_activeAlbum) params.set('album', _activeAlbum);
  if (_favoritesOnly) params.set('favorites', 'true');
  try {
    const res = await fetch(`${API_BASE}/api/gallery/library?${params}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (append) {
      _items = _items.concat(data.items || []);
    } else {
      _items = data.items || [];
    }
    // 缓存"空"判断，这样下次打开空画廊时不会
    // 在真正的"暂无照片"消息之前闪烁骨架块。
    try {
      const _noFilters = !_search && !_activeTags.length && !_activeModel && !_activeAlbum && !_favoritesOnly;
      if (_noFilters) {
        if (_items.length === 0) localStorage.setItem('gallery-known-empty', '1');
        else localStorage.removeItem('gallery-known-empty');
      }
    } catch (_) {}
    _total = data.total || 0;
    if (typeof data.total_tagged === 'number') _totalTagged = data.total_tagged;
    _updateTagCount();
    _renderGrid();
    _renderTags(data.tags || []);
    _renderModels(data.models || []);
    _renderStats();
  } catch (e) {
    console.error('Gallery fetch error:', e);
  }
}

async function _fetchAlbums() {
  try {
    const res = await fetch(`${API_BASE}/api/gallery/albums`, { credentials: 'same-origin' });
    const data = await res.json();
    _albums = data.albums || [];
    _renderAlbums();
  } catch (e) { console.error('Albums fetch error:', e); }
}


// v2 review HIGH-7: return a boolean so callers can stop showing
// "Tags saved" / "Photo deleted" toasts when the server actually
// returned 4xx/5xx. The previous swallow-and-return-undefined caused
// silent UI lies on permission failures.
async function _patchImage(id, patch) {
  try {
    const r = await fetch(`${API_BASE}/api/gallery/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      console.warn('Gallery patch returned', r.status);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Gallery patch error:', e);
    return false;
  }
}

async function _deleteImage(id) {
  try {
    const r = await fetch(`${API_BASE}/api/gallery/${id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!r.ok) {
      console.warn('Gallery delete returned', r.status);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Gallery delete error:', e);
    return false;
  }
}

// ---- 批量上传带进度 ----

// 接受 File[]（全部上传到 fallbackAlbumId）或
// {file, albumId}[]（按文件指定相册 — 用于文件夹拖放）。
async function _bulkUpload(filesOrItems, fallbackAlbumId) {
  const bar = document.getElementById('gallery-upload-bar');
  const progress = document.getElementById('gallery-upload-progress');
  const status = document.getElementById('gallery-upload-status');
  if (!bar) return;

  const items = filesOrItems.map(it =>
    it instanceof File ? { file: it, albumId: fallbackAlbumId } : it
  );

  bar.style.display = '';
  let done = 0, dupes = 0, errors = 0;
  const total = items.length;

  // 并发池 — N 个工作线程从队列中拉取。4 是对本地服务器合理的
  // 默认值：足以重叠网络 + EXIF + 磁盘操作
  // 而不会淹没 SQLite（它本身就是串行写入的）。视频
  // 尤其受益，因为它们足够大，是 I/O 密集型。
  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const it = items[idx];
      const fd = new FormData();
      fd.append('file', it.file);
      if (it.albumId) fd.append('album_id', it.albumId);
      try {
        const res = await fetch(`${API_BASE}/api/gallery/upload`, {
          method: 'POST', body: fd, credentials: 'same-origin',
        });
        const data = await res.json();
        if (data.duplicate) dupes++;
        else if (!data.ok) errors++;
      } catch (e) { errors++; }
      done++;
      if (progress) progress.style.width = `${(done / total) * 100}%`;
      if (status) status.textContent = `${done}/${total}${dupes ? ` (${dupes} duplicates)` : ''}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  const msg = `${done - dupes - errors} imported` +
    (dupes ? `, ${dupes} duplicates skipped` : '') +
    (errors ? `, ${errors} errors` : '');
  if (status) status.textContent = msg;
  uiModule.showToast(msg);
  setTimeout(() => { bar.style.display = 'none'; }, 3000);
  // 自动切换到"最近"排序，使刚上传的照片立即
  // 在顶部可见（否则"随机"排序会打散它们）。
  if (done - dupes - errors > 0 && _sort !== 'recent') {
    _sort = 'recent';
    const sortSel = document.getElementById('gallery-sort');
    if (sortSel) sortSel.value = 'recent';
  }
  _fetchLibrary(false);
  _fetchAlbums();
}

// 判断此 File / 文件名是否应上传 — 图片和常见视频。
function _isMediaFile(f) {
  const t = (f?.type || '').toLowerCase();
  if (t.startsWith('image/') || t.startsWith('video/')) return true;
  // Some Linux file managers and older browsers leave .type blank; fall
  // back to the extension.
  const ext = (f?.name || '').toLowerCase().split('.').pop() || '';
  return ['png','jpg','jpeg','webp','gif','mp4','mov','webm','mkv','m4v'].includes(ext);
}

// 判断 URL/文件名是否指向视频 — 用于选择 <video> 还是 <img>。
function _isVideoUrl(url) {
  const ext = (url || '').toLowerCase().split('?')[0].split('.').pop();
  return ['mp4','mov','webm','mkv','m4v'].includes(ext);
}

// 递归遍历 webkit FileSystemEntry，返回其下所有媒体文件。
async function _walkEntryForImages(entry) {
  if (entry.isFile) {
    return new Promise(res => {
      entry.file(
        f => res(_isMediaFile(f) ? [f] : []),
        () => res([])
      );
    });
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const out = [];
  while (true) {
    const batch = await new Promise(res => reader.readEntries(res, () => res([])));
    if (!batch.length) break;
    const subs = await Promise.all(batch.map(_walkEntryForImages));
    subs.forEach(s => out.push(...s));
  }
  return out;
}

// 处理原生拖放：将文件夹（→ 新建/已有相册）和零散文件
// （→ 当前相册）分开处理。整个上传完成后返回。
async function _handleGalleryDrop(e) {
  const dtItems = [...(e.dataTransfer?.items || [])];
  const entries = dtItems
    .map(it => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
    .filter(Boolean);

  const uploadItems = [];
  let sawFolderEntry = false;

  for (const entry of entries) {
    if (entry.isDirectory) {
      sawFolderEntry = true;
      let album = _albums.find(a => a.name === entry.name);
      if (!album) {
        try {
          const res = await fetch(`${API_BASE}/api/gallery/albums`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ name: entry.name }),
          });
          const data = await res.json();
          if (data && data.id) album = { id: data.id, name: data.name || entry.name };
        } catch (err) { console.error('Failed to create album for', entry.name, err); }
      }
      if (!album) continue;
      const files = await _walkEntryForImages(entry);
      files.forEach(f => uploadItems.push({ file: f, albumId: album.id }));
    } else if (entry.isFile) {
      const f = await new Promise(res => entry.file(res, () => res(null)));
      if (f && _isMediaFile(f)) {
        uploadItems.push({ file: f, albumId: _activeAlbum });
      }
    }
  }

  // 回退处理：某些拖放源（Linux 文件管理器如 Thunar/Nautilus，
  // 或旧浏览器）不填充 FileSystemEntry 但会填充
  // dataTransfer.files 中的零散文件。同样拾取这些。
  if (!uploadItems.length) {
    const files = [...(e.dataTransfer?.files || [])].filter(_isMediaFile);
    files.forEach(f => uploadItems.push({ file: f, albumId: _activeAlbum }));
  }

  if (uploadItems.length) {
    await _bulkUpload(uploadItems);
    return;
  }

  // 没有可用内容 — 空文件夹、不可读的文件夹 URI 或非图片拖放。
  // 如果 dataTransfer 类型暗示是文件夹/URI 拖放，
  // 解释限制并指向"上传相册"按钮。
  const types = [...(e.dataTransfer?.types || [])];
  const looksLikeFolderUri = !sawFolderEntry && (
    types.includes('text/uri-list') ||
    types.includes('text/x-moz-url') ||
    dtItems.some(it => it.kind === 'string')
  );
  if (looksLikeFolderUri) {
    uiModule.showError('Browsers can’t read folders dropped from native file managers (Thunar/Nautilus). Use the "Upload album" tile in the Albums tab instead.');
  } else if (entries.length || dtItems.length) {
    uiModule.showToast('No images found in that drop');
  }
}

// ---- 渲染辅助函数 ----

function _renderStats() {
  const el = document.getElementById('gallery-stats');
  if (el) el.textContent = `${t('gallery.photo_count', { n: _total })}`;
}

function _renderTags(tags) {
  // 搜索栏下方的全局"画廊中所有标签"芯片行已移除 —
  // 它只是堆积了每个用户添加的标签，无法移除。现在通过
  // 点击照片上的标签（→ 头部出现可移除的标签）或通过搜索来过滤。
  const container = document.getElementById('gallery-tag-chips');
  if (!container) return;
  container.innerHTML = '';
  container.style.display = 'none';
}

function _renderModels(models) {
  const sel = document.getElementById('gallery-model-filter');
  if (!sel) return;
  let html = '<option value="">All sources</option>';
  models.forEach(m => {
    const selected = _activeModel === m ? ' selected' : '';
    html += `<option value="${_esc(m)}"${selected}>${_esc(m)}</option>`;
  });
  sel.innerHTML = html;
}

function _renderAlbums() {
  const container = document.getElementById('gallery-album-chips');   // 搜索栏上方：活动过滤器指示器
  const filterC = document.getElementById('gallery-filter-chips');    // 搜索栏下方：全部/收藏
  if (!container && !filterC) return;
  // 搜索栏下方："全部"/"收藏"过滤器 + 活动标签芯片
  // （这样你搜索/点击的标签就在"全部"和爱心旁边显示）。
  if (filterC) {
    // 顺序：全部，然后是爱心，然后是活动标签芯片（在两者
    // 的右侧），然后是活动相册芯片。相册内没有收藏视图，所以
    // 当相册活动时隐藏爱心。
    let fhtml = `<button class="gallery-chip${!_activeAlbum && !_favoritesOnly ? ' active' : ''}" data-album="">All</button>`;
    if (!_activeAlbum) {
      fhtml += `<button class="gallery-chip gallery-chip-fav${_favoritesOnly ? ' active' : ''}" data-fav="true" title="Favorites">&#9829;</button>`;
    }
    _activeTags.forEach(t => {
      fhtml += `<span class="gallery-chip gallery-chip-active-album" title="Filtered to tag — click × to remove"><span>#${_esc(t)}</span><button class="gallery-chip-clear" data-clear-tag="${_esc(t)}" aria-label="Remove tag filter">&times;</button></span>`;
    });
    if (_activeAlbum) {
      const a = _albums.find(x => x.id === _activeAlbum);
      if (a) {
        fhtml += `<span class="gallery-chip gallery-chip-active-album" title="Currently showing this album — click X to clear"><span>${_esc(a.name)}</span><button class="gallery-chip-clear" data-clear="album" aria-label="Clear album filter">&times;</button></span>`;
      }
    }
    filterC.innerHTML = fhtml;
    filterC.querySelector('.gallery-chip[data-album=""]')?.addEventListener('click', () => {
      _favoritesOnly = false;
      _activeAlbum = null;
      _activeTags = [];
      _fetchLibrary(false);
      _renderAlbums();
    });
    filterC.querySelector('.gallery-chip-fav')?.addEventListener('click', () => {
      _favoritesOnly = !_favoritesOnly;
      _activeAlbum = null;
      _fetchLibrary(false);
      _renderAlbums();
    });
    filterC.querySelector('.gallery-chip-clear[data-clear="album"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _activeAlbum = null;
      _fetchLibrary(false);
      _renderAlbums();
    });
    filterC.querySelectorAll('.gallery-chip-clear[data-clear-tag]').forEach(x => {
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        const tag = x.dataset.clearTag;
        _activeTags = _activeTags.filter(t => t !== tag);
        _fetchLibrary(false);
        _renderAlbums();
      });
    });
  }
  // 搜索栏上方的行不再使用 — 所有过滤器芯片现在都在下方。
  if (container) container.innerHTML = '';
}

// Albums 标签页 — 将相册列表渲染为由封面缩略图组成的卡片网格。
// 点击相册会切换到按该相册过滤的 Photos 标签页。
//
// 结构与 Photos 标签页一致：持久工具栏（搜索 + 选择）
// 和批量操作栏一次性构建，只有内部的 #gallery-albums-grid-wrap
// 重新渲染，这样搜索输入框在输入时保持焦点。
function _renderAlbumsTab() {
  const container = document.getElementById('gallery-albums-container');
  if (!container) return;
  _ensureAlbumsToolbar(container);
  _renderAlbumsGrid();
}

function _filteredAlbums() {
  const q = _albumSearch.trim().toLowerCase();
  if (!q) return _albums;
  return _albums.filter(a => (a.name || '').toLowerCase().includes(q));
}

function _ensureAlbumsToolbar(container) {
  if (container.querySelector('#gallery-albums-toolbar')) return;
  container.innerHTML = `
    <div class="gallery-toolbar" id="gallery-albums-toolbar">
      <div class="gallery-search-wrap">
        <input type="text" class="gallery-search" id="gallery-albums-search" placeholder="Search albums..." />
      </div>
      <button class="gallery-select-btn gallery-toolbar-action" id="gallery-albums-select-btn" title="Select for bulk actions" style="position:relative;top:2px;"><span style="position:relative;top:1px;">Select</span></button>
    </div>
    <div class="memory-bulk-bar hidden" id="gallery-albums-bulk-bar">
      <label class="memory-bulk-check-all" style="position:relative;top:-1px;"><input type="checkbox" id="gallery-albums-bulk-all"> All</label>
      <span id="gallery-albums-bulk-count" style="position:relative;top:-1px;">0 selected</span>
      <button class="memory-toolbar-btn" id="gallery-albums-bulk-delete" title="Delete selected" style="margin-left:auto;color:var(--color-error, #f44);position:relative;top:-3px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>Delete</button>
      <button class="memory-toolbar-btn" id="gallery-albums-bulk-cancel" title="Cancel (Esc)" style="margin-left:4px;padding:3px 6px;position:relative;top:-3px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div id="gallery-albums-grid-wrap"></div>
  `;

  // 绑定搜索 — 防抖重新渲染，与 Photos 相同的模式。
  const searchInput = container.querySelector('#gallery-albums-search');
  let _albumSearchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(_albumSearchDebounce);
    _albumSearchDebounce = setTimeout(() => {
      _albumSearch = searchInput.value;
      _renderAlbumsGrid();
    }, 150);
  });

  // 绑定选择 + 批量操作栏 — 取消恢复正常的点击打开行为；
  // 操作打开一个锚定在按钮上的下拉菜单。
  container.querySelector('#gallery-albums-select-btn').addEventListener('click', () => {
    _setAlbumSelectMode(!_albumSelectMode);
  });
  container.querySelector('#gallery-albums-bulk-cancel').addEventListener('click', () => {
    _setAlbumSelectMode(false);
  });
  container.querySelector('#gallery-albums-bulk-all').addEventListener('change', (e) => {
    const on = e.target.checked;
    const list = _filteredAlbums();
    if (on) list.forEach(a => _albumSelected.add(a.id));
    else _albumSelected.clear();
    _renderAlbumsGrid();
  });
  container.querySelector('#gallery-albums-bulk-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!_albumSelected.size) { uiModule.showToast('Select albums first'); return; }
    _bulkDeleteAlbums([..._albumSelected]);
  });
}

function _setAlbumSelectMode(on) {
  _albumSelectMode = on;
  if (!on) _albumSelected.clear();
  const container = document.getElementById('gallery-albums-container');
  container.querySelector('#gallery-albums-select-btn span').textContent = on ? t('common.cancel') : 'Select';
  container.querySelector('#gallery-albums-select-btn').classList.toggle('active', on);
  container.querySelector('#gallery-albums-bulk-bar').classList.toggle('hidden', !on);
  _renderAlbumsGrid();
}

function _updateAlbumBulkCount() {
  const container = document.getElementById('gallery-albums-container');
  if (!container) return;
  const sel = _albumSelected.size;
  const cnt = container.querySelector('#gallery-albums-bulk-count');
  if (cnt) cnt.textContent = sel + ' selected';
  const all = container.querySelector('#gallery-albums-bulk-all');
  const total = _filteredAlbums().length;
  if (all) { all.checked = total > 0 && sel === total; all.indeterminate = sel > 0 && sel < total; }
  const del = container.querySelector('#gallery-albums-bulk-delete');
  if (del) del.style.opacity = sel > 0 ? '1' : '0.5';
}

function _renderAlbumsGrid() {
  const container = document.getElementById('gallery-albums-container');
  if (!container) return;
  const wrap = container.querySelector('#gallery-albums-grid-wrap');
  if (!wrap) return;

  const albums = _filteredAlbums();
  if (!_albums.length) {
    wrap.innerHTML = `
      <div class="gallery-albums-empty">
        <p>No albums yet.</p>
        <button class="gallery-select-btn" id="gallery-albums-new">+ New album</button>
      </div>`;
    _wireAlbumsEvents(wrap);
    return;
  }
  if (!albums.length) {
    wrap.innerHTML = `<div class="gallery-albums-empty"><p>No albums match "${_esc(_albumSearch)}".</p></div>`;
    return;
  }

  let html = '<div class="gallery-albums-grid">';
  // 操作卡片（新建/上传）— 在选择模式下隐藏，以免
  // 与选择圆点视觉冲突，也不会被误当作
  // 真实相册来切换选中。
  if (!_albumSelectMode) {
    html += `
      <div class="gallery-album-card gallery-album-card-add" id="gallery-albums-new">
        <div class="gallery-album-cover">
          <div class="gallery-album-placeholder">+</div>
        </div>
        <div class="gallery-album-info">
          <div class="gallery-album-name">New album</div>
        </div>
      </div>
      <div class="gallery-album-card gallery-album-card-add" id="gallery-albums-upload">
        <div class="gallery-album-cover">
          <div class="gallery-album-placeholder">
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </div>
        </div>
        <div class="gallery-album-info">
          <div class="gallery-album-name">Upload album</div>
          <div class="gallery-album-count">Pick a folder</div>
        </div>
      </div>`;
  }
  albums.forEach(a => {
    // 空相册即使 cover_url 有值也使用占位图标 —
    // 相册在被清空前留下的旧封面看起来像是
    // 相册中还有照片。
    const cover = (a.cover_url && a.count > 0)
      ? `<img src="${_esc(a.cover_url)}" alt="" loading="lazy" />`
      : `<div class="gallery-album-placeholder">
           <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
         </div>`;
    const isSel = _albumSelected.has(a.id);
    const dot = _albumSelectMode
      ? `<span class="gallery-select-dot${isSel ? ' selected' : ''}" style="display:flex;"></span>`
      : '';
    const cls = 'gallery-album-card' + (_albumSelectMode ? ' gallery-card-selectable' : '') + (isSel ? ' selected' : '');
    html += `
      <div class="${cls}" data-album="${_esc(a.id)}">
        ${dot}
        <button class="gallery-album-menu-btn" data-album="${_esc(a.id)}" title="Options" aria-label="Album options"${_albumSelectMode ? ' style="display:none"' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="position:relative;top:2px;"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
        <div class="gallery-album-menu-pop dropdown" data-album="${_esc(a.id)}" hidden>
          <div class="dropdown-item-compact" data-action="upload">
            <span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></span>
            <span>Upload here</span>
          </div>
          <div class="dropdown-item-compact" data-action="rename">
            <span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></span>
            <span>Rename</span>
          </div>
          <div class="dropdown-item-compact dropdown-item-danger" data-action="delete">
            <span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></span>
            <span>Delete</span>
          </div>
        </div>
        <div class="gallery-album-cover">${cover}</div>
        <div class="gallery-album-info">
          <div class="gallery-album-name">${_esc(a.name)}</div>
          <div class="gallery-album-count">${a.count} photo${a.count === 1 ? '' : 's'}</div>
        </div>
      </div>`;
  });
  html += '</div>';
  wrap.innerHTML = html;
  _updateAlbumBulkCount();
  _wireAlbumsEvents(wrap);
}

// 每卡片 / 每弹窗菜单的事件绑定 — 提取出来以便空状态
// 和真实网格都能复用。
function _wireAlbumsEvents(scope) {
  const container = document.getElementById('gallery-albums-container');
  if (!container) return;

  container.querySelectorAll('.gallery-album-card[data-album]').forEach(card => {
    card.addEventListener('click', (e) => {
      // 点击菜单按钮或任何弹窗菜单项由下面的处理逻辑处理；
      // 此情况下不导航进入相册。
      if (e.target.closest('.gallery-album-menu-btn')) return;
      if (e.target.closest('.gallery-album-menu-pop')) return;
      // 选择模式下，点击卡片切换其选中状态而不是
      // 打开。与 Photos 标签页的行为一致。
      if (_albumSelectMode) {
        const id = card.dataset.album;
        if (_albumSelected.has(id)) _albumSelected.delete(id);
        else _albumSelected.add(id);
        const dot = card.querySelector('.gallery-select-dot');
        if (dot) dot.classList.toggle('selected', _albumSelected.has(id));
        card.classList.toggle('selected', _albumSelected.has(id));
        _updateAlbumBulkCount();
        return;
      }
      _activeAlbum = card.dataset.album || null;
      _favoritesOnly = false;
      // 切换上下文前隐藏任何已打开的照片详情 — 否则
      // 之前查看的照片会在用户返回 Photos 标签页时
      // 悬浮在顶层。
      const _detail = document.getElementById('gallery-detail');
      if (_detail) _detail.style.display = 'none';
      _renderAlbums();
      _fetchLibrary(false);
      // 切回 Photos 标签页，让他们立即看到内容。
      const modal = document.getElementById('gallery-modal');
      const photosTab = modal?.querySelector('.gallery-tab[data-tab="images"]');
      photosTab?.click();
    });
  });

  // 悬停菜单：点击 ⋯ 切换每卡片弹窗，关闭其他弹窗。
  container.querySelectorAll('.gallery-album-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.album;
      const pop = container.querySelector(`.gallery-album-menu-pop[data-album="${CSS.escape(id)}"]`);
      const wasOpen = pop && !pop.hidden;
      container.querySelectorAll('.gallery-album-menu-pop').forEach(p => { p.hidden = true; });
      if (pop && !wasOpen) pop.hidden = false;
    });
  });
  // 点击其他任何地方关闭已打开的弹窗。
  if (!container._popDismissWired) {
    document.addEventListener('click', (e) => {
      if (e.target.closest('.gallery-album-menu-btn')) return;
      if (e.target.closest('.gallery-album-menu-pop')) return;
      container.querySelectorAll('.gallery-album-menu-pop').forEach(p => { p.hidden = true; });
    });
    container._popDismissWired = true;
  }

  container.querySelectorAll('.gallery-album-menu-pop').forEach(pop => {
    const id = pop.dataset.album;
    pop.querySelector('[data-action="upload"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      pop.hidden = true;
      // 生成一个限定到此相册的临时文件选择器。
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/*,video/*';
      picker.multiple = true;
      picker.style.display = 'none';
      picker.addEventListener('change', async () => {
        const files = [...(picker.files || [])];
        if (files.length) await _bulkUpload(files, id);
        picker.remove();
      });
      document.body.appendChild(picker);
      picker.click();
    });
    pop.querySelector('[data-action="rename"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      pop.hidden = true;
      const album = _albums.find(a => a.id === id);
      const newName = prompt('Rename album:', album?.name || '');
      if (!newName || !newName.trim() || newName.trim() === album?.name) return;
      const r = await fetch(`${API_BASE}/api/gallery/albums/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ name: newName.trim() }),
      });
      if (r.ok) {
        await _fetchAlbums();
        _renderAlbumsTab();
        if (uiModule) uiModule.showToast('Album renamed');
      } else if (uiModule) {
        uiModule.showError('Rename failed');
      }
    });
    pop.querySelector('[data-action="delete"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      pop.hidden = true;
      const album = _albums.find(a => a.id === id);
      const ok = await uiModule.styledConfirm(
        `Delete album "${album?.name || ''}"? Photos inside will stay in your library.`,
        { confirmText: t('common.delete'), danger: true },
      );
      if (!ok) return;
      const r = await fetch(`${API_BASE}/api/gallery/albums/${id}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      if (r.ok) {
        if (_activeAlbum === id) _activeAlbum = null;
        await _fetchAlbums();
        _renderAlbumsTab();
        _renderAlbums();
        if (uiModule) uiModule.showToast('Album deleted');
      } else if (uiModule) {
        uiModule.showError('Delete failed');
      }
    });
  });

  document.getElementById('gallery-albums-new')?.addEventListener('click', async () => {
    const name = (uiModule.styledPrompt
      ? await uiModule.styledPrompt('Name your new album.', { title: 'New album', placeholder: 'e.g. Vacation 2026', confirmText: t('common.create') })
      : prompt('Album name:'));
    if (!name?.trim()) return;
    await fetch(`${API_BASE}/api/gallery/albums`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ name: name.trim() }),
    });
    await _fetchAlbums();
    _renderAlbumsTab();
  });

  document.getElementById('gallery-albums-upload')?.addEventListener('click', () => {
    // <input webkitdirectory> 选择一个文件夹；我们以文件夹名创建一个相册
    // 并上传其中的每张图片。
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.webkitdirectory = true;
    picker.style.display = 'none';
    picker.addEventListener('change', async () => {
      const all = [...(picker.files || [])];
      const images = all.filter(_isMediaFile);
      picker.remove();
      if (!images.length) {
        if (uiModule) uiModule.showToast('No images or videos in that folder');
        return;
      }
      // 从第一个文件的相对路径推导文件夹名称（例如
      // "MyTrip/photo.jpg" → "MyTrip"）。失败时回退到提示框。
      const rel = images[0].webkitRelativePath || '';
      let folderName = rel.split('/')[0] || '';
      if (!folderName) {
        folderName = prompt('Album name for these photos:') || '';
        if (!folderName.trim()) return;
      }
      // 复用同名的已有相册；否则创建新的。
      let album = _albums.find(a => a.name === folderName);
      if (!album) {
        const r = await fetch(`${API_BASE}/api/gallery/albums`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin', body: JSON.stringify({ name: folderName }),
        });
        const data = await r.json().catch(() => ({}));
        if (data?.id) {
          album = { id: data.id, name: folderName, count: 0 };
          _albums.push(album);
        }
      }
      if (!album) {
        if (uiModule) uiModule.showError('Could not create album');
        return;
      }
      await _bulkUpload(images, album.id);
      await _fetchAlbums();
      _renderAlbumsTab();
    });
    document.body.appendChild(picker);
    picker.click();
  });
}

async function _bulkDeleteAlbums(ids) {
  if (!ids.length) return;
  const ok = await uiModule.styledConfirm(
    t('gallery.delete_albums_confirm', { n: ids.length }),
    { confirmText: t('common.delete'), danger: true },
  );
  if (!ok) return;
  let failed = 0;
  for (const id of ids) {
    const r = await fetch(`${API_BASE}/api/gallery/albums/${id}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
    if (!r.ok) failed++;
    else if (_activeAlbum === id) _activeAlbum = null;
  }
  if (failed) uiModule.showError(t('gallery.failed_delete_albums', { failed: failed, total: ids.length }));
  else if (uiModule) uiModule.showToast(t('gallery.deleted_albums', { n: ids.length }));
  _setAlbumSelectMode(false);
  await _fetchAlbums();
  _renderAlbumsTab();
  _renderAlbums();
}

// 获取用户已持久化的编辑器草稿，并将它们渲染为缩略图网格，
// 放在新画布/浏览按钮下方。每个卡片点击后在编辑器中恢复该草稿；
// × 在服务端删除它。
// 获取草稿列表时在草稿区域上方显示磨砂旋涡覆盖层。
// 位于草稿区域内部，使其位于网格上方。
let _draftsSpinner = null;
function _draftsShowLoading(section) {
  if (!section) return;
  let ov = section.querySelector('.gallery-editor-drafts-loading');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'gallery-editor-drafts-loading';
    try {
      _draftsSpinner = spinnerModule.createWhirlpool(28);
      _draftsSpinner.element.style.cssText = 'width:28px;height:28px;margin:0;';
      ov.appendChild(_draftsSpinner.element);
    } catch (_) {
      ov.textContent = t('gallery.loading');
    }
    section.appendChild(ov);
  }
  // 从网格顶部精确地开始覆盖层，使其只覆盖项目
  // 列表 — 不覆盖上方头部的搜索/选择（旧的固定 30px 偏移
  // 假设头部很短，结果覆盖了搜索/选择的一半）。
  const _grid = section.querySelector('.gallery-editor-drafts-grid');
  const _hdr = section.querySelector('.gallery-editor-drafts-header');
  const _top = _grid ? _grid.offsetTop : (_hdr ? _hdr.offsetHeight : 30);
  ov.style.top = _top + 'px';
  ov.style.display = '';
}
function _draftsHideLoading(section) {
  if (!section) return;
  const ov = section.querySelector('.gallery-editor-drafts-loading');
  if (ov) ov.style.display = 'none';
}

// 在渲染之间保持，使搜索和选择状态在重新渲染后仍然存在。
let _draftsCache = [];
let _draftsSearch = '';
let _draftsSelectMode = false;
let _draftsSelected = new Set();

async function _renderEditorDrafts() {
  const section = document.getElementById('gallery-editor-drafts');
  const grid = document.getElementById('gallery-editor-drafts-grid');
  if (!section || !grid) return;
  // 列表正在获取时，在草稿区域显示磨砂旋涡覆盖层。
  // 区域在获取之前就变为可见，
  // 这样用户看到的是加载指示器而不是空白。
  section.hidden = false;
  _draftsShowLoading(section);
  try {
    const res = await fetch(`${API_BASE}/api/editor-drafts`, { credentials: 'same-origin' });
    if (res.ok) {
      const out = await res.json();
      _draftsCache = Array.isArray(out.drafts) ? out.drafts : [];
    }
  } catch (_) {
    _draftsCache = [];
  }
  _draftsHideLoading(section);
  if (!_draftsCache.length) {
    section.hidden = true;
    grid.innerHTML = '';
    _draftsSelected.clear();
    _draftsSelectMode = false;
    _draftsSyncBulkBar();
    return;
  }
  section.hidden = false;
  // 移除以不存在的草稿的选中状态。
  const present = new Set(_draftsCache.map(d => d.id));
  for (const id of [..._draftsSelected]) if (!present.has(id)) _draftsSelected.delete(id);
  _draftsPaint();
  _draftsWireOnce();
}

// 仅重新渲染网格（和批量操作栏），使用缓存的草稿 + 搜索 +
// 选择状态。用于搜索/选择模式/复选框更新。
function _draftsPaint() {
  const grid = document.getElementById('gallery-editor-drafts-grid');
  if (!grid) return;
  const q = _draftsSearch.trim().toLowerCase();
  const filtered = _draftsCache.filter(d => {
    if (!q) return true;
    const name = String(d.name || '').toLowerCase();
    return name.includes(q);
  });
  grid.innerHTML = filtered.map(d => {
    const updated = d.updated_at ? _humanRelativeDate(new Date(d.updated_at)) : '';
    const dims = (d.width && d.height) ? `${d.width}×${d.height}` : '';
    const thumb = d.thumbnail
      ? `<img class="gallery-editor-draft-thumb" src="${_esc(d.thumbnail)}" alt="" />`
      : '<div class="gallery-editor-draft-thumb gallery-editor-draft-thumb-empty"></div>';
    const checked = _draftsSelected.has(d.id);
    const checkbox = _draftsSelectMode
      ? `<span class="gallery-select-dot${checked ? ' selected' : ''}" data-draft-id="${_esc(d.id)}"></span>`
      : '';
    return `
      <div class="gallery-editor-draft-card${checked ? ' selected' : ''}${_draftsSelectMode ? ' select-mode' : ''}" data-draft-id="${_esc(d.id)}" tabindex="0" title="Resume ${_esc(d.name || 'project')}">
        ${checkbox}
        ${thumb}
        <div class="gallery-editor-draft-info">
          <div class="gallery-editor-draft-name">${_esc(d.name || 'Untitled')}</div>
          <div class="gallery-editor-draft-meta">${_esc([dims, updated].filter(Boolean).join(' · '))}</div>
        </div>
        <button class="gallery-editor-draft-delete" data-draft-id="${_esc(d.id)}" title="Delete project" aria-label="Delete project">×</button>
      </div>`;
  }).join('');
  grid.querySelectorAll('.gallery-editor-draft-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.gallery-editor-draft-delete')) return;
      const id = card.dataset.draftId;
      if (!id) return;
      if (_draftsSelectMode) {
        if (_draftsSelected.has(id)) _draftsSelected.delete(id);
        else _draftsSelected.add(id);
        _draftsPaint();
        _draftsSyncBulkBar();
        return;
      }
      // 传递缓存的尺寸作为预设大小，这样编辑器在草稿加载时
      // 可以显示一个比例正确的占位符。
      const draft = _draftsCache.find(d => d.id === id);
      const presetSize = (draft && draft.width && draft.height)
        ? { w: draft.width, h: draft.height }
        : null;
      openEditor(null, null, presetSize, draft?.name || null, id);
    });
  });
  grid.querySelectorAll('.gallery-editor-draft-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.draftId;
      if (!id) return;
      const ok = await uiModule.styledConfirm('Delete this project?', {
        confirmText: t('common.delete'), cancelText: t('common.cancel'), danger: true,
      });
      if (!ok) return;
      // 优雅退出：在网格重新渲染前淡出 + 缩小卡片。
      const card = btn.closest('.gallery-editor-draft-card');
      if (card) card.classList.add('gallery-draft-removing');
      try {
        await fetch(`${API_BASE}/api/editor-drafts/${encodeURIComponent(id)}`, {
          method: 'DELETE', credentials: 'same-origin',
        });
      } catch (_) { /* 吞掉错误 — 下面会刷新 */ }
      await new Promise(r => setTimeout(r, 240));   // 让动画完成
      _draftsSelected.delete(id);
      _renderEditorDrafts();
    });
  });
  _draftsSyncBulkBar();
}

function _draftsSyncBulkBar() {
  const bar = document.getElementById('gallery-editor-drafts-bulk');
  const countEl = document.getElementById('gallery-editor-drafts-bulk-count');
  const selectBtn = document.getElementById('gallery-editor-drafts-select');
  if (bar) bar.classList.toggle('hidden', !_draftsSelectMode);
  if (countEl) countEl.textContent = `${t('gallery.selected_n', { n: _draftsSelected.size })}`;
  if (selectBtn) {
    selectBtn.textContent = _draftsSelectMode ? t('common.cancel') : 'Select';
    selectBtn.classList.toggle('active', _draftsSelectMode);
  }
  // "全选"复选框状态 — 所有可见草稿都选中时勾选，
  // 部分选中时为不确定状态（与 Photos 标签页一致）。
  const all = document.getElementById('gallery-editor-drafts-select-all');
  if (all) {
    const q = _draftsSearch.trim().toLowerCase();
    const visible = _draftsCache.filter(d => !q || String(d.name || '').toLowerCase().includes(q));
    const selVis = visible.filter(d => _draftsSelected.has(d.id)).length;
    all.checked = visible.length > 0 && selVis === visible.length;
    all.indeterminate = selVis > 0 && selVis < visible.length;
  }
}

let _draftsWired = false;
function _draftsWireOnce() {
  if (_draftsWired) return;
  _draftsWired = true;
  document.getElementById('gallery-editor-drafts-search')?.addEventListener('input', (e) => {
    _draftsSearch = e.target.value || '';
    _draftsPaint();
  });
  document.getElementById('gallery-editor-drafts-select')?.addEventListener('click', () => {
    _draftsSelectMode = !_draftsSelectMode;
    if (!_draftsSelectMode) _draftsSelected.clear();
    _draftsPaint();
  });
  document.getElementById('gallery-editor-drafts-select-all')?.addEventListener('change', (e) => {
    // 与 Photos 相同的"全选"复选框行为：勾选选中每个可见
    // 草稿，取消勾选则清除（遵守搜索过滤）。
    const q = _draftsSearch.trim().toLowerCase();
    const visible = _draftsCache.filter(d => !q || String(d.name || '').toLowerCase().includes(q));
    if (e.target.checked) for (const d of visible) _draftsSelected.add(d.id);
    else for (const d of visible) _draftsSelected.delete(d.id);
    _draftsPaint();
  });
  document.getElementById('gallery-editor-drafts-bulk-cancel')?.addEventListener('click', () => {
    _draftsSelectMode = false;
    _draftsSelected.clear();
    _draftsPaint();
  });
  document.getElementById('gallery-editor-drafts-bulk-delete')?.addEventListener('click', async () => {
    if (!_draftsSelected.size) return;
    const n = _draftsSelected.size;
    const ok = await uiModule.styledConfirm(t('gallery.delete_projects_confirm', { n: n }), {
      confirmText: t('common.delete'), cancelText: t('common.cancel'), danger: true,
    });
    if (!ok) return;
    const ids = [..._draftsSelected];
    // 选中卡片在被移除前优雅退出。
    const grid = document.getElementById('gallery-editor-drafts-grid');
    if (grid) ids.forEach(id => grid.querySelector(`.gallery-editor-draft-card[data-draft-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`)?.classList.add('gallery-draft-removing'));
    await new Promise(r => setTimeout(r, 240));
    await Promise.allSettled(ids.map(id =>
      fetch(`${API_BASE}/api/editor-drafts/${encodeURIComponent(id)}`, {
        method: 'DELETE', credentials: 'same-origin',
      })
    ));
    _draftsSelected.clear();
    _draftsSelectMode = false;
    _renderEditorDrafts();
  });
}

// 人类可读的 "x 分钟前" / "y 天前" 用于草稿列表。
function _humanRelativeDate(when) {
  const diff = (Date.now() - when.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + 'd ago';
  return when.toLocaleDateString();
}

// Edit 标签页空状态 — 当用户点击该标签页但没有照片
// 加载时显示。让他们可以开始空白画布或跳回选择照片。
function _renderEditorLanding() {
  const container = document.getElementById('gallery-editor-container');
  if (!container) return;
  // openEditor()/closeEditor() 可能已将容器隐藏；Edit
  // 标签页仍处于活动状态，确保入口页实际可见。
  container.style.display = 'flex';
  // 模板以原生 <select> 渲染。浏览器原生处理所有布局
  // 和样式 — 不需要自定义 flex 网格，不会裁剪，没有空盒子。
  // 选择选项触发 `change` 事件并直接进入编辑器。
  const presets = [
    { w: 1024, h: 1024, label: 'Square HD — 1024 × 1024' },
    { w: 1920, h: 1080, label: 'Widescreen — 1920 × 1080' },
    { w: 1080, h: 1920, label: 'Portrait — 1080 × 1920' },
    { w: 1080, h: 1080, label: 'Instagram — 1080 × 1080' },
    { w: 1500, h: 1050, label: 'Postcard — 1500 × 1050' },
    { w: 2480, h: 3508, label: 'A4 (300dpi) — 2480 × 3508' },
    { w: 2550, h: 3300, label: 'Letter (300dpi) — 2550 × 3300' },
    { w: 3840, h: 2160, label: '4K — 3840 × 2160' },
  ];
  const optionsHtml = presets
    .map((p, i) => `<option value="${i}">${p.label}</option>`)
    .join('');
  container.innerHTML = `
    <div class="gallery-editor-landing">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
      <h3>Image Editor <span class="ge-alpha-tag">Alpha</span></h3>
      <p>Start a blank canvas, or open a photo from your gallery to edit it.</p>
      <div class="gallery-editor-landing-actions">
        <button class="gallery-select-btn" id="gallery-editor-new">New canvas...</button>
        <button class="gallery-select-btn" id="gallery-editor-pick">Browse photos</button>
      </div>
      <label class="gallery-editor-template-label">
        Or pick a template
        <select class="gallery-editor-template-select" id="gallery-editor-template">
          <option value="">Select a size…</option>
          ${optionsHtml}
        </select>
      </label>
      <div class="gallery-editor-drafts" id="gallery-editor-drafts" hidden>
        <div class="gallery-editor-drafts-header">
          <h4 class="gallery-editor-drafts-title">Saved projects</h4>
          <input type="search" class="gallery-editor-drafts-search" id="gallery-editor-drafts-search" placeholder=t('gallery.search_projects') autocomplete="off" />
          <button class="gallery-select-btn" id="gallery-editor-drafts-select" title="Toggle multi-select">Select</button>
        </div>
        <div class="gallery-bulk-bar hidden" id="gallery-editor-drafts-bulk">
          <label class="memory-bulk-check-all"><input type="checkbox" id="gallery-editor-drafts-select-all"> All</label>
          <span class="gallery-bulk-count" id="gallery-editor-drafts-bulk-count">0 selected</span>
          <button class="gallery-bulk-delete" id="gallery-editor-drafts-bulk-delete"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>Delete selected</button>
          <button class="memory-toolbar-btn" id="gallery-editor-drafts-bulk-cancel" title="Cancel (Esc)" style="margin-left:4px;padding:3px 6px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="gallery-editor-drafts-grid" id="gallery-editor-drafts-grid"></div>
      </div>
    </div>`;
  // 编辑器入口页的每次重新挂载都会重建草稿头部
  // 标记，因此缓存的事件监听器引用已过期。重置。
  _draftsWired = false;
  _renderEditorDrafts();
  document.getElementById('gallery-editor-template')?.addEventListener('change', (e) => {
    const idx = parseInt(e.target.value, 10);
    if (Number.isNaN(idx)) return;
    const p = presets[idx];
    if (p) openEditor(null, null, { w: p.w, h: p.h }, `${p.w}×${p.h}`);
  });
  document.getElementById('gallery-editor-new')?.addEventListener('click', async () => {
    // openEditor() 现在返回 Promise — 它是异步的，因为尺寸
    // 提示是一个样式化的模态框。在检查编辑器是否实际打开
    // 之前 await 它（用户可能已取消）。
    await openEditor(null, null, null, 'New canvas');
    if (!isEditorOpen()) _renderEditorLanding();
  });
  document.getElementById('gallery-editor-pick')?.addEventListener('click', () => {
    document.querySelector('#gallery-modal .gallery-tab[data-tab="images"]')?.click();
  });
}

// 绑定 Photos 网格中的首卡片上传入口。打开与旧 Import 按钮
// 相同的多文件选择器。
function _wireUploadTile() {
  const tile = document.getElementById('gallery-upload-tile');
  if (!tile) return;
  tile.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.multiple = true;
    input.addEventListener('change', () => {
      if (input.files.length) _bulkUpload([...input.files], _activeAlbum);
    });
    input.click();
  });
}

// 首次页面加载时显示的闪烁占位块，使网格
// 不会从空突然跳到满（重新打开时通过 stale-while-revalidate
// 保留旧照片，所以骨架只在没有任何内容时才显示）。
function _renderSkeletons(n) {
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;
  const count = Math.max(8, Math.min(n || 12, 20));
  let html = '';
  for (let i = 0; i < count; i++) html += '<div class="gallery-card gallery-card-skeleton" aria-hidden="true"></div>';
  grid.innerHTML = html;
  const lm = document.getElementById('gallery-load-more');
  if (lm) lm.style.display = 'none';
}

function _renderGrid() {
  const grid = document.getElementById('gallery-grid');
  const loadMore = document.getElementById('gallery-load-more');
  if (!grid) return;

  // 首卡片：始终可见的"上传"入口。与 Albums 标签页中的上传相册
  // 卡片保持一致，使上传入口在两个
  // 网格中统一。
  const uploadTile = `
    <div class="gallery-card gallery-card-upload" id="gallery-upload-tile" title="Upload photos or videos">
      <div class="gallery-card-upload-inner">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <div class="gallery-card-upload-label">Upload</div>
      </div>
    </div>`;

  if (_items.length === 0) {
    grid.innerHTML = uploadTile + '<div class="gallery-empty">No photos yet. Click Upload or drag-and-drop to get started!</div>';
    _wireUploadTile();
    if (loadMore) loadMore.style.display = 'none';
    return;
  }

  let html = uploadTile;
  _items.forEach(img => {
    const date = img.taken_at
      ? new Date(img.taken_at).toLocaleDateString()
      : (img.created_at ? new Date(img.created_at).toLocaleDateString() : '');
    // 卡片标签：优先使用 prompt（上传照片时可作为用户可编辑的
    // 名称）。回退到清理过的文件名，这样
    // 空 prompt 的导入照片仍然显示有用信息
    // 而不是空行。
    const fallbackName = (img.filename || '')
      .replace(/^\d{4,}[_-]/, '')   // 删除上传文件的日期前缀
      .replace(/\.[^.]+$/, '')       // 删除扩展名
      .replace(/[_-]+/g, ' ')
      .trim();
    const labelText = (img.prompt || '').trim() || fallbackName || 'Photo';
    const promptPreview = labelText.length > 60 ? labelText.substring(0, 58) + '...' : labelText;
    const favCls = img.favorite ? ' gallery-fav-active' : '';
    html += `
      <div class="gallery-card" data-id="${_esc(img.id)}">
        <span class="gallery-select-dot" style="display:none;"></span>
        <button class="gallery-fav-btn${favCls}" data-id="${_esc(img.id)}" title="Favorite">&#9829;</button>
        <button class="gallery-dl-btn" data-id="${_esc(img.id)}" data-url="${_esc(img.url)}" data-filename="${_esc(img.filename || '')}" title="Download">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        ${_isVideoUrl(img.url)
          ? `<video src="${_esc(img.url)}" preload="metadata" muted playsinline></video>
             <span class="gallery-card-play" aria-hidden="true">
               <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
             </span>`
          : `<img src="${_esc(img.url)}" alt="${_esc(img.prompt)}" loading="lazy" />`}
        <div class="gallery-card-info">
          <div class="gallery-card-prompt">${_esc(promptPreview)}</div>
          <div class="gallery-card-meta">
            ${img.model ? `<span class="gallery-card-model">${_esc(img.model)}</span>` : ''}
            <span class="gallery-card-date">${date}</span>
          </div>
        </div>
      </div>`;
  });
  grid.innerHTML = html;
  _wireUploadTile();

  // 打开后的首次渲染播放多米诺级联动画（不在过滤/排序/
  // 加载更多重新渲染时） — 与文档库一致。
  if (!_galleryCascaded) {
    _galleryCascaded = true;
    grid.classList.add('gallery-just-opened');
    setTimeout(() => grid.classList.remove('gallery-just-opened'), 900);
  }

  if (loadMore) {
    loadMore.style.display = _items.length < _total ? 'block' : 'none';
  }

  // 卡片点击 → 详情（跳过上传卡片，它有独立的处理逻辑）
  grid.querySelectorAll('.gallery-card[data-id]').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.gallery-fav-btn')) return;
      if (e.target.closest('.gallery-dl-btn')) return;
      const selectBtn = document.getElementById('gallery-select-btn');
      if (selectBtn && selectBtn.classList.contains('active')) return;
      const img = _items.find(i => i.id === card.dataset.id);
      if (img) _openDetail(img);
    });
  });

  // 下载按钮
  grid.querySelectorAll('.gallery-dl-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = btn.dataset.url;
      const filename = btn.dataset.filename || `image-${btn.dataset.id}.png`;
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
      } catch (_) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    });
  });

  // 收藏按钮
  grid.querySelectorAll('.gallery-fav-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const res = await fetch(`${API_BASE}/api/gallery/${id}/favorite`, {
        method: 'POST', credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.ok) {
        btn.classList.toggle('gallery-fav-active', data.favorite);
        const item = _items.find(i => i.id === id);
        if (item) item.favorite = data.favorite;
      }
    });
  });
}

// ---- 详情覆盖层 ----

function _openDetail(img) {
  const detail = document.getElementById('gallery-detail');
  if (!detail) return;
  // 在新的渲染附加其监听器之前，
  // 移除之前照片的人脸覆盖层 resize 监听器。

  const _dateSrc = img.taken_at || img.created_at || null;
  const _dateObj = _dateSrc ? new Date(_dateSrc) : null;
  const _relAgo = (d) => {
    if (!d || isNaN(d.getTime())) return '';
    const secs = (Date.now() - d.getTime()) / 1000;
    if (secs < 0) return '';
    if (secs < 60) return 'just now';
    if (secs < 3600) { const m = Math.floor(secs / 60); return `${m} minute${m !== 1 ? 's' : ''} ago`; }
    if (secs < 86400) { const h = Math.floor(secs / 3600); return `${h} hour${h !== 1 ? 's' : ''} ago`; }
    if (secs < 86400 * 7) { const d2 = Math.floor(secs / 86400); return `${d2} day${d2 !== 1 ? 's' : ''} ago`; }
    if (secs < 86400 * 30) { const w = Math.floor(secs / (86400 * 7)); return `${w} week${w !== 1 ? 's' : ''} ago`; }
    if (secs < 86400 * 365) { const mo = Math.floor(secs / (86400 * 30)); return `${mo} month${mo !== 1 ? 's' : ''} ago`; }
    const y = Math.floor(secs / (86400 * 365));
    return `${y} year${y !== 1 ? 's' : ''} ago`;
  };
  const date = _dateObj
    ? `${_dateObj.toLocaleString()}<span class="gallery-date-rel"> (${_relAgo(_dateObj)})</span>`
    : 'Unknown';
  const userTags = img.user_tags || img.tags || '';
  const aiTags = img.ai_tags || '';
  const dims = img.width && img.height ? `${img.width} x ${img.height}` : (img.size || 'Unknown');
  const fileSize = img.file_size ? _humanSize(img.file_size) : '';
  // "已编辑"行：仅当 updated_at 明显晚于 created_at
  // (>10s) 时显示。每张照片在插入时通过 ORM 时间戳 mixin
  // 都会更新 updated_at，所以这个间隔过滤掉平凡的情况。
  let editedHtml = '';
  if (img.updated_at && img.created_at) {
    const u = new Date(img.updated_at);
    const c = new Date(img.created_at);
    if (!isNaN(u) && !isNaN(c) && (u.getTime() - c.getTime() > 10000)) {
      editedHtml = `<div class="gallery-detail-section"><label>Edited</label><div>${u.toLocaleString()}<span class="gallery-date-rel"> (${_relAgo(u)})</span></div></div>`;
    }
  }

  detail.innerHTML = `
    <div class="gallery-detail-header">
      <button class="gallery-detail-back" id="gallery-detail-back">&larr; Back</button>
      <div style="flex:1"></div>
      <button class="gallery-detail-back" id="gallery-edit-direct-btn" title="Edit (E)" aria-label="Edit photo" style="display:inline-flex;align-items:center;gap:4px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        Edit
      </button>
      <button class="gallery-detail-back gallery-detail-fav-header${img.favorite ? ' active' : ''}" id="gallery-detail-fav-header" title="${img.favorite ? 'Unfavorite' : 'Favorite'}" aria-label="Favorite" aria-pressed="${img.favorite ? 'true' : 'false'}" style="display:inline-flex;align-items:center;justify-content:center;padding:4px 8px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="${img.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      </button>
      <div class="gallery-detail-menu-wrap">
        <button class="gallery-detail-action gallery-detail-menu-btn" id="gallery-detail-menu-btn" title="Actions" aria-label="Photo actions">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
        <div class="gallery-detail-menu dropdown" id="gallery-detail-menu" hidden>
          <button class="dropdown-item-compact" id="gallery-fav-detail">
            <span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="${img.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></span>
            ${img.favorite ? 'Favorited' : 'Favorite'}
          </button>
          <button class="dropdown-item-compact" id="gallery-ai-tag-btn" data-mode="${aiTags ? 'clear' : 'tag'}">
            <span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg></span>
            ${aiTags ? 'Clear AI tags' : 'AI Tag'}
          </button>
          <button class="dropdown-item-compact" id="gallery-download-btn">
            <span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span>
            Download
          </button>
          ${img.album_id ? `<button class="dropdown-item-compact" id="gallery-set-cover-btn">
            <span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></span>
            Set as album cover
          </button>` : ''}
          <button class="dropdown-item-compact dropdown-item-danger" id="gallery-delete-btn">
            <span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></span>
            Delete
          </button>
        </div>
      </div>
    </div>
    <div class="gallery-detail-body">
      <div class="gallery-detail-image" id="gallery-detail-image-wrap" style="position:relative">
        <button class="gallery-detail-rotate gallery-detail-rotate-ccw" id="gallery-rotate-ccw-btn" title="Rotate 90° counter-clockwise" aria-label="Rotate left">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        </button>
        <button class="gallery-detail-rotate gallery-detail-rotate-cw" id="gallery-rotate-btn" title="Rotate 90° clockwise" aria-label="Rotate right">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <button class="gallery-detail-nav gallery-detail-nav-prev" id="gallery-detail-prev" title="Previous (←)" aria-label="Previous">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="gallery-detail-img-frame">
          ${_isVideoUrl(img.url)
            ? `<video id="gallery-detail-img" src="${_esc(img.url)}" controls preload="metadata" playsinline></video>`
            : `<img id="gallery-detail-img" src="${_esc(img.url)}" alt="${_esc(img.prompt)}" />`}
          <div id="gallery-detail-face-overlay" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></div>
        </div>
        <button class="gallery-detail-nav gallery-detail-nav-next" id="gallery-detail-next" title="Next (→)" aria-label="Next">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
      <div class="gallery-detail-sidebar">
        <div class="gallery-detail-section">
          <label>Name</label>
          <div class="gallery-name-wrap">
            <input type="text" class="gallery-detail-name-input" id="gallery-detail-name-input"
              value="${_esc(img.prompt || '')}" placeholder=t('gallery.untitled_photo') />
            <svg class="gallery-name-enter" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>
          </div>
        </div>
        ${img.prompt && img.model !== 'imported' ? `<div class="gallery-detail-section"><label>Prompt</label><div class="gallery-detail-prompt">${_esc(img.prompt)}</div></div>` : ''}
        <div class="gallery-detail-section gallery-detail-section-date">
          <label>Date</label>
          <div>${date}</div>
        </div>
        ${editedHtml}
        <div class="gallery-detail-section">
          <label>Dimensions</label>
          <div>${dims}${fileSize ? ` (${fileSize})` : ''}</div>
        </div>
        ${img.camera ? `<div class="gallery-detail-section"><label>Camera</label><div>${_esc(img.camera)}</div></div>` : ''}
        ${img.gps ? `<div class="gallery-detail-section"><label>Location</label><div>${img.gps.lat}, ${img.gps.lng}</div></div>` : ''}
        ${img.model ? `<div class="gallery-detail-section"><label>Source</label><div>${_esc(img.model)}</div></div>` : ''}
        ${img.session_name ? `<div class="gallery-detail-section"><label>Session</label><div>${_esc(img.session_name)}</div></div>` : ''}
        ${aiTags ? `<div class="gallery-detail-section"><label>AI Tags</label><div class="gallery-ai-tags">${aiTags.split(',').map(t => t.trim()).filter(Boolean).map(t => `<button class="gallery-ai-chip gallery-aitag-chip" data-tag-filter="${_esc(t)}" title="AI-generated tag — click to filter to photos tagged “${_esc(t)}”"><span class="gallery-aitag-mark" aria-hidden="true">✦</span>${_esc(t)}</button>`).join('')}</div></div>` : ''}
        <div class="gallery-detail-section">
          <label>Tags</label>
          <div class="gallery-ai-tags" id="gallery-user-tag-chips">${userTags.split(',').map(t => t.trim()).filter(Boolean).map(t => `<button class="gallery-ai-chip gallery-user-chip" data-tag-filter="${_esc(t)}" title="Filter to photos tagged “${_esc(t)}”">${_esc(t)}<span class="gallery-tag-x" title="Remove tag" aria-label="Remove tag">×</span></button>`).join('')}</div>
          <div class="gallery-tag-input-wrap">
            <input type="text" class="gallery-tag-input" id="gallery-tag-input"
              value="" placeholder="Add a tag" title="Type a tag and press Enter to add it" />
            <span class="gallery-tag-enter-hint" aria-hidden="true">↵</span>
          </div>
        </div>
        <div class="gallery-detail-section">
          <label>Album</label>
          <select id="gallery-detail-album" class="gallery-tag-input" style="padding:4px 6px;">
            <option value="">None</option>
            ${_albums.map(a => `<option value="${a.id}" ${img.album_id === a.id ? 'selected' : ''}>${_esc(a.name)}</option>`).join('')}
          </select>
        </div>
        <div class="gallery-detail-section" id="gallery-detail-people-section" style="display:none">
          <label>${t('gallery.people_in_photo')}</label>
          <div id="gallery-detail-people-list" class="gallery-detail-people"></div>
        </div>
      </div>
    </div>
  `;
  detail.style.display = 'flex';

  document.getElementById('gallery-detail-back').addEventListener('click', () => {
    detail.style.display = 'none';
  });

  // 可点击的标签芯片 — AI 标签和用户标签。点击芯片
  // 关闭详情，在主网格上设置标签过滤器，并
  // 重新获取，让用户看到带该标签的其他照片。
  // 从此照片中移除用户标签（标签芯片上的 ×）。
  const _removeUserTag = async (tag, chip) => {
    const existing = (img.user_tags || img.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const remaining = existing.filter(e => e.toLowerCase() !== String(tag).toLowerCase());
    const cleaned = remaining.join(', ');
    const ok = await _patchImage(img.id, { tags: cleaned });
    if (!ok) { if (uiModule) uiModule.showError('Failed to remove tag'); return; }
    img.tags = cleaned;
    img.user_tags = cleaned;
    chip.remove();
  };
  detail.querySelectorAll('[data-tag-filter]').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      // × 移除标签（仅限用户芯片）而不是过滤。
      if (e.target.closest('.gallery-tag-x')) { _removeUserTag(chip.dataset.tagFilter, chip); return; }
      const tag = chip.dataset.tagFilter;
      if (!tag) return;
      if (!_activeTags.includes(tag)) _activeTags.push(tag);
      _activeAlbum = null;
      _favoritesOnly = false;
      detail.style.display = 'none';
      // 确保我们查看的是 Photos 标签页。
      const photosTab = document.querySelector('#gallery-modal .gallery-tab[data-tab="images"]');
      photosTab?.click();
      _fetchLibrary(false);
      _renderAlbums();
    });
  });

  // 溢出菜单 — 右侧单个 ⋮ 按钮，承载所有操作
  // 项目。点击任何项目都会关闭菜单（每个项目的处理逻辑也会触发）。
  const menuBtn = document.getElementById('gallery-detail-menu-btn');
  const menu = document.getElementById('gallery-detail-menu');
  if (menuBtn && menu) {
    // `.dropdown { display:none }` 不与 [hidden] 关联 — 设置内联 display。
    const _setMenu = (show) => { menu.hidden = !show; menu.style.display = show ? 'block' : 'none'; };
    _setMenu(false);
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _setMenu(menu.hidden);
    });
    menu.addEventListener('click', () => { _setMenu(false); });
    // 点击外部关闭菜单。
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== menuBtn) _setMenu(false);
    });
  }

  const _toggleDetailFavorite = async () => {
    const res = await fetch(`${API_BASE}/api/gallery/${img.id}/favorite`, {
      method: 'POST', credentials: 'same-origin',
    });
    const data = await res.json();
    if (!data.ok) return;
    img.favorite = data.favorite;
    const menuItem = document.getElementById('gallery-fav-detail');
    if (menuItem) menuItem.innerHTML = data.favorite ? '&#9829; Favorited' : '&#9825; Favorite';
    const headerBtn = document.getElementById('gallery-detail-fav-header');
    if (headerBtn) {
      headerBtn.setAttribute('aria-pressed', data.favorite ? 'true' : 'false');
      headerBtn.setAttribute('title', data.favorite ? 'Unfavorite' : 'Favorite');
      const svg = headerBtn.querySelector('svg');
      if (svg) svg.setAttribute('fill', data.favorite ? 'currentColor' : 'none');
    }
  };
  document.getElementById('gallery-fav-detail').addEventListener('click', _toggleDetailFavorite);
  document.getElementById('gallery-detail-fav-header')?.addEventListener('click', _toggleDetailFavorite);

  document.getElementById('gallery-ai-tag-btn').addEventListener('click', async (e) => {
    // 当照片已有 AI 标签时，此按钮显示为"清除 AI 标签"。
    const clearMode = e.currentTarget.dataset.mode === 'clear';
    // 按钮位于 ⋮ 菜单中，点击后菜单关闭，因此其文本从不
    // 显示 — 改为在图片上显示旋涡覆盖层。
    const stage = document.getElementById('gallery-detail-image-wrap') || document.getElementById('gallery-detail-img')?.parentElement;
    let overlay = null, spinner = null;
    if (stage) {
      overlay = document.createElement('div');
      overlay.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;background:color-mix(in srgb, var(--bg) 55%, transparent);z-index:5;';
      try {
        spinner = spinnerModule.createWhirlpool(36);
        spinner.element.style.cssText = 'width:36px;height:36px;margin:0;';
        overlay.appendChild(spinner.element);
        const label = document.createElement('div');
        label.textContent = clearMode ? 'Clearing…' : 'AI tagging…';
        label.style.cssText = 'font-size:11px;opacity:0.7;';
        overlay.appendChild(label);
      } catch (_) { overlay.textContent = clearMode ? 'Clearing…' : 'AI tagging…'; }
      if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
      stage.appendChild(overlay);
    }
    const cleanup = () => { try { spinner?.destroy?.(); } catch {} overlay?.remove(); };
    try {
      const url = clearMode
        ? `${API_BASE}/api/gallery/clear-ai-tags?image_id=${encodeURIComponent(img.id)}`
        : `${API_BASE}/api/gallery/${img.id}/ai-tag`;
      const res = await fetch(url, { method: 'POST', credentials: 'same-origin' });
      const data = await res.json();
      cleanup();
      if (data.ok) {
        img.ai_tags = clearMode ? '' : data.ai_tags;
        uiModule.showToast(clearMode ? 'AI tags cleared' : 'AI tags added');
        _openDetail(img); // 重新渲染详情
      } else {
        uiModule.showError(data.error || (clearMode ? 'Clear failed' : 'AI tagging failed'));
      }
    } catch (e2) {
      cleanup();
      uiModule.showError(clearMode ? 'Clear failed' : 'AI tagging failed');
    }
  });

  document.getElementById('gallery-download-btn').addEventListener('click', async () => {
    try {
      const res = await fetch(img.url, { credentials: 'same-origin' });
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = img.filename || `image-${img.id}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    } catch (e) {
      // 降级方案：直接链接
      const a = document.createElement('a');
      a.href = img.url;
      a.download = img.filename || `image-${img.id}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  });

  // 当（新打开/导航的）图片加载时显示旋涡 — 缓存的图片
  // 立即报告 `complete`，因此不会闪烁旋转图标。
  const _imgEl = document.getElementById('gallery-detail-img');
  const _frame = detail.querySelector('.gallery-detail-img-frame');
  if (_imgEl && _frame && _imgEl.tagName === 'IMG' && !_imgEl.complete) {
    const ld = document.createElement('div');
    ld.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, var(--bg) 40%, transparent);z-index:4;pointer-events:none;border-radius:6px;';
    let _sp = null;
    try { _sp = spinnerModule.createWhirlpool(34); _sp.element.style.cssText = 'width:34px;height:34px;margin:0;'; ld.appendChild(_sp.element); } catch (_) {}
    _frame.appendChild(ld);
    const _done = () => { try { _sp?.destroy?.(); } catch {} ld.remove(); };
    _imgEl.addEventListener('load', _done, { once: true });
    _imgEl.addEventListener('error', _done, { once: true });
  }

  // 上一条/下一条导航
  const curIdx = _items.findIndex(i => i.id === img.id);
  const prevBtn = document.getElementById('gallery-detail-prev');
  const nextBtn = document.getElementById('gallery-detail-next');
  if (curIdx <= 0) prevBtn.classList.add('gallery-detail-nav-disabled');
  if (curIdx < 0 || curIdx >= _items.length - 1) nextBtn.classList.add('gallery-detail-nav-disabled');

  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (curIdx > 0) _openDetail(_items[curIdx - 1]);
  });
  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (curIdx >= 0 && curIdx < _items.length - 1) _openDetail(_items[curIdx + 1]);
  });

  // 移动端滑动 — 在图片区域上水平单指滑动切换
  // 照片。跳过多点触控（双指缩放）并让视频
  // 控件处理自己的触摸。
  const wrap = document.getElementById('gallery-detail-image-wrap');
  if (wrap) {
    let sx = 0, sy = 0, st = 0, tracking = false;
    wrap.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { tracking = false; return; }
      if (e.target.closest('video, button')) { tracking = false; return; }
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now();
      tracking = true;
    }, { passive: true });
    wrap.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      const dt = Date.now() - st;
      // 水平轻扫：> 40px，主要为水平方向，800ms 以内。
      if (dt > 800) return;
      if (Math.abs(dx) < 40) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.2) return;
      if (dx < 0 && curIdx < _items.length - 1) _openDetail(_items[curIdx + 1]);
      else if (dx > 0 && curIdx > 0) _openDetail(_items[curIdx - 1]);
    }, { passive: true });
  }

  const _openInEditor = () => {
    try {
      detail.style.display = 'none';
      const modal = document.getElementById('gallery-modal');
      if (modal) {
        modal.querySelectorAll('.gallery-tab').forEach(t => t.classList.remove('active'));
        modal.querySelector('.gallery-tab[data-tab="editor"]')?.classList.add('active');
      }
      const imagesContainer = document.getElementById('gallery-images-container');
      const albumsContainer = document.getElementById('gallery-albums-container');
      if (imagesContainer) imagesContainer.style.display = 'none';
      if (albumsContainer) albumsContainer.style.display = 'none';
      const editorContainer = document.getElementById('gallery-editor-container');
      if (editorContainer) editorContainer.style.display = 'flex';
      const baseFilename = (img.filename || '').replace(/\.[^.]+$/, '');
      const label = img.prompt?.trim() || baseFilename || 'Photo';
      openEditor(img.url, img.id, null, label);
    } catch (e) {
      console.error('[edit] failed:', e);
      if (uiModule) uiModule.showError('Failed to open editor: ' + (e?.message || 'unknown'));
    }
  };
  document.getElementById('gallery-edit-btn')?.addEventListener('click', _openInEditor);
  document.getElementById('gallery-edit-direct-btn')?.addEventListener('click', _openInEditor);

  // Rotate — server-side image rotation. Forces a fresh URL afterwards
  // so the browser doesn't show the old cached version. Shows a
  // whirlpool over the detail image while the request + reload are in
  // flight so the user sees the action is processing.
  const _rotate = async (angle) => {
    const stage = document.querySelector('.gallery-detail-img-stage') || document.getElementById('gallery-detail-img')?.parentElement;
    let overlay = null;
    let spinner = null;
    if (stage) {
      overlay = document.createElement('div');
      overlay.className = 'gallery-detail-rotate-loading';
      overlay.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, var(--bg) 55%, transparent);z-index:5;pointer-events:none;';
      try {
        spinner = spinnerModule.createWhirlpool(36);
        spinner.element.style.cssText = 'width:36px;height:36px;margin:0;';
        overlay.appendChild(spinner.element);
      } catch (_) { overlay.textContent = t('gallery.rotating'); }
      if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
      stage.appendChild(overlay);
    }
    const cleanup = () => {
      try { spinner?.destroy?.(); } catch {}
      overlay?.remove();
    };
    try {
      const r = await fetch(`${API_BASE}/api/gallery/${img.id}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ angle }),
      });
      if (!r.ok) { cleanup(); uiModule.showError('Rotate failed'); return; }
      // 缓存破坏详情视图中的图片 URL，然后等待新图片
      // 实际加载完成再清除旋转图标，这样用户
      // 不会看到旧图片/空白图片的闪烁。
      const imgEl = document.getElementById('gallery-detail-img');
      if (imgEl) {
        const newSrc = img.url + (img.url.includes('?') ? '&' : '?') + 't=' + Date.now();
        await new Promise((resolve) => {
          imgEl.onload = imgEl.onerror = () => { imgEl.onload = null; imgEl.onerror = null; resolve(); };
          imgEl.src = newSrc;
        });
      }
      cleanup();
      uiModule.showToast('Rotated');
      _fetchLibrary(false);
    } catch (e) {
      cleanup();
      uiModule.showError('Rotate failed');
    }
  };
  document.getElementById('gallery-rotate-btn')?.addEventListener('click', () => _rotate(90));
  document.getElementById('gallery-rotate-ccw-btn')?.addEventListener('click', () => _rotate(-90));

  // 设为相册封面 — 仅当照片当前在相册中存在时显示。
  document.getElementById('gallery-set-cover-btn')?.addEventListener('click', async () => {
    if (!img.album_id) return;
    try {
      const r = await fetch(`${API_BASE}/api/gallery/albums/${img.album_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ cover_id: img.id }),
      });
      if (r.ok) {
        uiModule.showToast('Album cover updated');
        await _fetchAlbums();
      } else {
        uiModule.showError('Failed to set cover');
      }
    } catch (e) {
      uiModule.showError('Failed to set cover');
    }
  });

  document.getElementById('gallery-delete-btn').addEventListener('click', async () => {
    if (!await uiModule.styledConfirm('Delete this photo? This cannot be undone.', { confirmText: t('common.delete'), danger: true })) return;
    const ok = await _deleteImage(img.id);
    if (!ok) {
      uiModule.showError('Failed to delete photo');
      return;
    }
    detail.style.display = 'none';
    _items = _items.filter(i => i.id !== img.id);
    _total = Math.max(0, _total - 1);
    _renderGrid();
    _renderStats();
    if (uiModule) uiModule.showToast('Photo deleted');
  });

  // 标签输入 — Enter 保存；同时从每个标签中去除前导 '#'
  // 使输入 "#person, #beach" 存储为 "person, beach"。
  // 重命名输入 — 通过专用重命名端点，
  // 在 Enter/blur 时保存到 prompt 列。
  const _nameInput = document.getElementById('gallery-detail-name-input');
  if (_nameInput) {
    const _saveName = async () => {
      const newName = _nameInput.value.trim();
      if (newName === (img.prompt || '')) return;
      try {
        const r = await fetch(`${API_BASE}/api/gallery/${img.id}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name: newName }),
        });
        if (!r.ok) throw new Error('Failed');
        img.prompt = newName;
        if (uiModule) uiModule.showToast('Renamed');
        window.dispatchEvent(new CustomEvent('gallery-refresh'));
      } catch {
        if (uiModule) uiModule.showError('Failed to rename');
      }
    };
    _nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _saveName(); _nameInput.blur(); }
    });
    _nameInput.addEventListener('blur', _saveName);
  }
  const _tagInput = document.getElementById('gallery-tag-input');
  if (_tagInput) {
    // 绑定标签芯片的点击过滤功能（与打开时渲染的芯片行为相同）
    // 使我们实时添加的芯片也能工作。
    const _wireTagChip = (chip) => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target.closest('.gallery-tag-x')) { _removeUserTag(chip.dataset.tagFilter, chip); return; }
        const tag = chip.dataset.tagFilter;
        if (!tag) return;
        if (!_activeTags.includes(tag)) _activeTags.push(tag);
        _activeAlbum = null;
        _favoritesOnly = false;
        detail.style.display = 'none';
        document.querySelector('#gallery-modal .gallery-tab[data-tab="images"]')?.click();
        _fetchLibrary(false);
        _renderAlbums();
      });
    };
    // 输入框是添加字段：输入标签，按 Enter → 追加到照片的标签中，
    // 字段清空，芯片立即出现。无需重新渲染。
    const _addTags = async () => {
      const newTags = _tagInput.value.split(',').map(t => t.trim().replace(/^#+/, '').trim()).filter(Boolean);
      _tagInput.value = '';
      if (!newTags.length) return;
      const existing = (img.user_tags || img.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      const merged = existing.slice();
      const added = [];
      for (const t of newTags) {
        if (!merged.some(e => e.toLowerCase() === t.toLowerCase())) { merged.push(t); added.push(t); }
      }
      if (!added.length) return;
      const cleaned = merged.join(', ');
      const ok = await _patchImage(img.id, { tags: cleaned });
      if (!ok) { if (uiModule) uiModule.showError('Failed to save tags'); return; }
      img.tags = cleaned;
      img.user_tags = cleaned;
      const chips = document.getElementById('gallery-user-tag-chips');
      if (chips) {
        added.forEach(t => {
          const b = document.createElement('button');
          b.className = 'gallery-ai-chip gallery-user-chip';
          b.dataset.tagFilter = t;
          b.title = t('gallery.filter_tagged', { t: t });
          b.textContent = t;
          const x = document.createElement('span');
          x.className = 'gallery-tag-x';
          x.title = 'Remove tag';
          x.setAttribute('aria-label', 'Remove tag');
          x.textContent = '×';
          b.appendChild(x);
          chips.appendChild(b);
          _wireTagChip(b);
        });
      }
    };
    _tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _addTags(); }
    });
    // 移动端失焦时仍会添加已输入的内容。
    _tagInput.addEventListener('blur', () => { if (_tagInput.value.trim()) _addTags(); });
  }

  document.getElementById('gallery-detail-album').addEventListener('change', async (e) => {
    const albumId = e.target.value;
    const ok = await _patchImage(img.id, { album_id: albumId || '' });
    if (!ok) { uiModule.showError('Failed to update album'); return; }
    img.album_id = albumId || null;
    uiModule.showToast(albumId ? 'Added to album' : 'Removed from album');
  });
}


function _makeGalleryDraggable(content) {
  if (!content) return;
  const header = content.querySelector('.modal-header');
  if (!header) return;
  const modal = content.closest('.modal') || content;
  makeWindowDraggable(modal, { content, header });
}

// ---- 打开 / 关闭 ----

// 重新导出管理器供侧边栏点击处理器使用
import * as Modals from './modalManager.js';

export function openGallery() {
  // 如果已最小化 — 在当前位置恢复，保留所有状态
  if (Modals.isRegistered('gallery-modal') && Modals.isMinimized('gallery-modal')) {
    Modals.restore('gallery-modal');
    return;
  }
  if (_open) return;
  _open = true;
  _galleryCascaded = false;   // 每次打开时重放多米诺级联动画
  // 状态在关闭/重新打开后保留 — 过滤器、相册、排序、项目、
  // 相册列表、人物 — 因此重新打开画廊感觉即时。使用搜索
  // 输入框或"全部"芯片来清除活动过滤器。
  // 例外：当排序为随机时，每次打开重新生成种子，让
  // 用户每次访问获得不同的顺序（这正是随机的意义）。同时
  // 清除缓存的项目，这样用户不会看到旧的随机顺序
  // 闪烁一下再在获取解析后换成新顺序 —
  // 短暂重新拉取期间显示的骨架是故意的，但新旧顺序的交换不是。
  if (_sort === 'shuffle') {
    _shuffleSeed = Math.floor(Math.random() * 2 ** 31);
    _items = [];
  }

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'gallery-modal';
  modal.innerHTML = `
    <div class="modal-content gallery-modal-content">
      <div class="modal-header">
        <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>Gallery <span id="gallery-stats" class="memory-count" style="font-size:0.6em;opacity:0.6;font-weight:normal;margin-left:8px"></span></h4>
        <button class="modal-close" id="gallery-close">&times;</button>
      </div>
      <div class="gallery-tabs">
        <button class="gallery-tab active" data-tab="images">
          <span class="gallery-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></span>
          <span class="gallery-tab-label">Photos</span>
        </button>
        <button class="gallery-tab" data-tab="albums">
          <span class="gallery-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></span>
          <span class="gallery-tab-label">Albums</span>
        </button>
        <button class="gallery-tab" data-tab="editor" id="gallery-editor-tab">
          <span class="gallery-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></span>
          <span class="gallery-tab-label">Edit</span>
          <span class="gallery-tab-close" id="gallery-editor-tab-close" title="Close edit" aria-label="Close edit">×</span>
        </button>
        <button class="gallery-tab" data-tab="settings">
          <span class="gallery-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
          <span class="gallery-tab-label">Settings</span>
        </button>
      </div>
      <div class="modal-body">
        <div id="gallery-upload-bar" style="display:none;padding:4px 8px 0;">
          <div style="background:var(--border);border-radius:4px;overflow:hidden;height:6px;">
            <div id="gallery-upload-progress" style="height:100%;background:var(--accent, var(--red));width:0%;transition:width 0.2s;"></div>
          </div>
          <div id="gallery-upload-status" style="font-size:10px;opacity:0.5;margin-top:2px;"></div>
        </div>
        <div class="gallery-images-container" id="gallery-images-container" style="margin-top:2px">
        <div class="gallery-album-chips" id="gallery-album-chips"></div>
        <div class="gallery-album-chips gallery-people-chips" id="gallery-people-chips" style="display:none"></div>
        <div class="gallery-toolbar">
          <div class="gallery-search-wrap">
            <input type="text" class="gallery-search" id="gallery-search" placeholder=t('gallery.search_photos') />
            <span class="gallery-search-enter-hint" aria-hidden="true"><svg class="gallery-enter-key" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>to tag</span>
          </div>
          <span class="gallery-toolbar-break" aria-hidden="true"></span>
          <select class="gallery-model-filter" id="gallery-model-filter">
            <option value="">All sources</option>
          </select>
          <select class="gallery-sort" id="gallery-sort">
            <option value="shuffle">Random</option>
            <option value="recent">Recent</option>
            <option value="oldest">Oldest</option>
          </select>
          <button class="gallery-select-btn gallery-toolbar-action" id="gallery-select-btn" title="Select for bulk actions"><span style="position:relative;top:1px;">Select</span></button>
        </div>
        <div class="gallery-album-chips" id="gallery-filter-chips" style="margin-top:0;"></div>
        <div class="memory-bulk-bar hidden" id="gallery-bulk-bar" style="margin-bottom:4px;">
          <label class="memory-bulk-check-all" style="position:relative;top:-1px;"><input type="checkbox" id="gallery-bulk-select-all"> All</label>
          <span id="gallery-bulk-count" style="position:relative;top:-1px;">0 selected</span>
          <button class="memory-toolbar-btn" id="gallery-bulk-actions" style="position:relative;top:-3px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>Actions <span style="opacity:0.55;font-size:9px;">▼</span></button>
          <button class="memory-toolbar-btn" id="gallery-bulk-cancel" title="Cancel (Esc)" style="margin-left:4px;padding:3px 6px;position:relative;top:-3px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="gallery-tag-chips" id="gallery-tag-chips"></div>
        <div class="gallery-grid" id="gallery-grid"></div>
        <button class="gallery-load-more" id="gallery-load-more" style="display:none">Load more</button>
        <div class="gallery-detail" id="gallery-detail" style="display:none"></div>
        </div>
        <div class="gallery-albums-container" id="gallery-albums-container" style="display:none;"></div>
        <div class="gallery-editor-container" id="gallery-editor-container" style="display:none;"></div>
        <div class="gallery-settings-container" id="gallery-settings-container" style="display:none;">
          <div class="admin-card">
            <h2>AI Tagging <span id="gallery-tag-count" class="memory-count" style="font-size:0.6em;opacity:0.6;font-weight:normal;"></span></h2>
            <p class="memory-desc doclib-desc">Auto-tag photos by content with your <a href="#" id="gallery-vision-link" class="ge-vision-link">vision model</a>. Your own tags are kept.</p>
            <div id="gallery-tag-bar" style="display:none;padding:8px 0 0;">
              <div style="background:var(--border);border-radius:4px;overflow:hidden;height:6px;">
                <div id="gallery-tag-progress" style="height:100%;background:var(--accent, var(--red));width:0%;transition:width 0.2s;"></div>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
                <div id="gallery-tag-status" style="font-size:10px;opacity:0.5;"></div>
                <button id="gallery-tag-cancel" class="gallery-select-btn" style="font-size:10px;padding:1px 6px;">Cancel</button>
              </div>
            </div>
            <div class="memory-toolbar" style="display:flex;flex-direction:row;gap:6px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:32px;">
              <button class="memory-toolbar-btn" id="gallery-clear-ai-tags-btn" title="Remove all AI-generated tags from every photo">Clear AI tags</button>
              <button class="memory-toolbar-btn" id="gallery-tag-all-btn" title="AI-tag all untagged photos (in the current album, if any)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:5px;"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                Start AI tag
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  Modals.register('gallery-modal', {
    railBtnId: 'rail-gallery',
    sidebarBtnId: 'tool-gallery-btn',
    closeFn: () => _doCloseGallery(),
    restoreFn: () => {},
  });

  // 允许通过标题栏拖动模态框 — 与邮件库、会话等相同模式。
  // tileManager（边角吸附平铺）也监听
  // 指针事件；它只在移动时显示幽灵框，在放下时吸附，
  // 所以两者共存。
  _makeGalleryDraggable(modal.querySelector('.modal-content'));

  document.getElementById('gallery-close').addEventListener('click', async () => {
    if (isEditorOpen()) {
      const ok = await uiModule.styledConfirm(
        'Close Gallery and the active edit?',
        { confirmText: t('common.close'), danger: true },
      );
      if (!ok) return;
      window.__galleryAllowCloseEditor = true;
    }
    closeGallery();
  });

  // 双击 Edit 标签页可重命名正在编辑的内容。标签通过 id
  // (#gallery-editor-tab) 在所有引用位置显示，因此
  // 简单的内联 contenteditable 就足够了。
  const editorTab = modal.querySelector('.gallery-tab[data-tab="editor"]');
  // Edit 标签页上的关闭 × — 悬停时出现。如果编辑器
  // 有打开的会话（任何进行中的编辑），则确认；否则直接关闭。
  const editorTabClose = modal.querySelector('#gallery-editor-tab-close');
  if (editorTabClose) {
    editorTabClose.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isEditorOpen()) {
        const ok = await uiModule.styledConfirm(
          'Close the edit? Any unsaved changes will be lost.',
          { confirmText: t('common.close'), danger: true },
        );
        if (!ok) return;
      }
      window.__galleryAllowCloseEditor = true;
      closeEditor();
      window.__galleryAllowCloseEditor = false;
      // 如果用户当前在 Edit 标签页上，切回 Photos。
      const activeTab = modal.querySelector('.gallery-tab.active');
      if (activeTab?.dataset.tab === 'editor') {
        modal.querySelector('.gallery-tab[data-tab="images"]')?.click();
      }
    });
  }
  if (editorTab) {
    editorTab.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const labelEl = editorTab.querySelector('.gallery-tab-label') || editorTab;
      const current = labelEl.textContent.replace(/^Edit:\s*/, '');
      const oldText = labelEl.textContent;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = current === 'Edit' ? '' : current;
      input.placeholder = 'Edit name';
      input.className = 'gallery-tab-rename-input';
      // 仅替换标签 span 的内容，使旁边的图标 SVG
      // 在重命名期间保持可见。
      labelEl.textContent = '';
      labelEl.appendChild(input);
      input.focus();
      input.select();
      const finish = (commit) => {
        if (commit && input.value.trim()) {
          labelEl.textContent = t('gallery.edit_title', { title: input.value.trim().slice(0, 24) });
        } else {
          labelEl.textContent = oldText;
        }
      };
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      });
    });
  }

  // ── 标签页切换 ──
  modal.querySelectorAll('.gallery-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      modal.querySelectorAll('.gallery-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      // 切换标签页时始终关闭照片详情 — 让它保持打开意味着
      // 下次用户返回 Photos 时它又会弹出来。
      const _detail = document.getElementById('gallery-detail');
      if (_detail) _detail.style.display = 'none';
      const imagesContainer = document.getElementById('gallery-images-container');
      const albumsContainer = document.getElementById('gallery-albums-container');
      const editorContainer = document.getElementById('gallery-editor-container');
      const settingsContainer = document.getElementById('gallery-settings-container');
      if (imagesContainer) imagesContainer.style.display = target === 'images' ? '' : 'none';
      if (albumsContainer) albumsContainer.style.display = target === 'albums' ? '' : 'none';
      if (editorContainer) editorContainer.style.display = target === 'editor' ? 'flex' : 'none';
      if (settingsContainer) settingsContainer.style.display = target === 'settings' ? '' : 'none';
      if (target === 'images') {
        // 离开 Edit 标签页时保持活动编辑。编辑
        // 会话仅由显式的 Edit 标签页关闭操作拆除。
      } else if (target === 'albums') {
        _renderAlbumsTab();
      } else if (target === 'editor') {
        // 如果编辑器尚未持有图片，则渲染选择器，
        // 让标签页做有用的事情而不是打开空的灰色面板。
        if (!isEditorOpen()) _renderEditorLanding();
      }
    });
  });

  const searchInput = document.getElementById('gallery-search');
  searchInput.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      _search = searchInput.value.trim();
      _fetchLibrary(false);
    }, 300);
  });
  // 在搜索框中按 Enter 将当前查询转换为
  // 堆叠的标签过滤芯片（去除前导 "#"），清空输入框，并
  // 重新获取。让用户无需点击芯片就能
  // 继续按标签缩小范围。
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const raw = searchInput.value.trim().replace(/^#/, '');
    if (!raw) return;
    if (!_activeTags.includes(raw)) _activeTags.push(raw);
    // 搜索标签时将活动过滤器切换到"全部"（清除收藏/相册），
    // 使爱心停用，"全部"高亮。
    _favoritesOnly = false;
    _activeAlbum = null;
    // 按标签过滤时最好按最新优先 — 将排序切换到"最近"。
    if (_sort !== 'recent') {
      _sort = 'recent';
      const sortSel = document.getElementById('gallery-sort');
      if (sortSel) sortSel.value = 'recent';
    }
    searchInput.value = '';
    _search = '';
    clearTimeout(_searchDebounce);
    _fetchLibrary(false);
    _renderAlbums();
  });

  document.getElementById('gallery-sort').addEventListener('change', (e) => {
    _sort = e.target.value;
    // 每次用户选择随机排序时生成新的随机会话，
    // 使其真正重新随机排列，而不是重新渲染相同的种子顺序。
    if (_sort === 'shuffle') _shuffleSeed = Math.floor(Math.random() * 2 ** 31);
    _fetchLibrary(false);
  });

  document.getElementById('gallery-model-filter').addEventListener('change', (e) => {
    _activeModel = e.target.value || null;
    _fetchLibrary(false);
  });

  document.getElementById('gallery-load-more').addEventListener('click', () => {
    _offset = _items.length;
    _fetchLibrary(true);
  });

  // 无限滚动：当加载更多按钮接近画廊滚动区域底部时自动加载下一页。
  // 按钮作为手动回退保留。
  // 在 document 上的捕获阶段滚动监听器捕获来自
  // 实际滚动的任意元素的滚动（桌面端 modal-body 或移动端的
  // 滚动包装器 — IntersectionObserver 的 root 在两者之间不可靠）。
  // 我们只需检测加载更多按钮相对于视口底部的位置。
  let _loadingMore = false;
  let _scrollTick = false;
  const _maybeAutoLoad = () => {
    _scrollTick = false;
    if (!_open || _loadingMore || _items.length >= _total) return;
    const btn = document.getElementById('gallery-load-more');
    if (!btn || btn.style.display === 'none' || !btn.offsetParent) return;  // 隐藏 / 没有更多
    const r = btn.getBoundingClientRect();
    if (r.top <= window.innerHeight + 600) {   // 距离视口底部 600px 内
      _loadingMore = true;
      _offset = _items.length;
      Promise.resolve(_fetchLibrary(true)).finally(() => { _loadingMore = false; });
    }
  };
  document.addEventListener('scroll', () => {
    if (_scrollTick) return;
    _scrollTick = true;
    requestAnimationFrame(_maybeAutoLoad);
  }, true);

  // 当窗口变宽时（例如进入全屏），可见网格
  // 可以容纳比上次获取更多的照片 — 补充加载以避免
  // 空白。防抖；仅当重新计算的
  // 页大小超过已加载的量且服务器还有更多可提供时触发。
  let _resizeTopUpTimer = null;
  const _onGalleryResize = () => {
    clearTimeout(_resizeTopUpTimer);
    _resizeTopUpTimer = setTimeout(() => {
      if (!_open) return;
      if (_items.length >= _total) return;        // 已有全部内容
      if (_computeFetchLimit() <= _items.length) return; // 视口没有变大
      _offset = _items.length;
      _fetchLibrary(true);
    }, 300);
  };
  window.addEventListener('resize', _onGalleryResize);
  // 记住处理器，以便 closeGallery 可以移除它。
  _galleryResizeHandler = _onGalleryResize;

  // ── 导入图片 ──

  // "视觉模型"链接 → 打开 AI 标签页上的设置（视觉模型
  // 在此配置）。
  const visionLink = document.getElementById('gallery-vision-link');
  if (visionLink) {
    visionLink.addEventListener('click', (e) => {
      e.preventDefault();
      import('./settings.js').then(m => {
        m.open('ai');
        // 画廊模态框从 modalManager 获得提升的 z-index；设置
        // 以其较低的静态 z-index 打开并落到了画廊后面。将其提升到上面。
        const sm = document.getElementById('settings-modal');
        const gm = document.getElementById('gallery-modal');
        if (sm) {
          const gz = gm ? (parseInt(getComputedStyle(gm).zIndex) || 0) : 0;
          sm.style.setProperty('z-index', String(Math.max(gz + 1, 10050)), 'important');
        }
      }).catch(() => {});
    });
  }

  // ── 全部未打标图片打标 ──
  let _tagCancelRequested = false;
  let _tagging = false;
  const tagAllBtn = document.getElementById('gallery-tag-all-btn');
  const _tagAllOrigHTML = tagAllBtn ? tagAllBtn.innerHTML : '';
  if (tagAllBtn) {
    tagAllBtn.addEventListener('click', async () => {
      // 运行期间此按钮充当取消按钮。
      if (_tagging) {
        _tagCancelRequested = true;
        const _se = document.getElementById('gallery-tag-status');
        if (_se) _se.textContent = t('gallery.cancelling');
        tagAllBtn.textContent = t('gallery.cancelling');
        tagAllBtn.disabled = true;
        return;
      }
      if (tagAllBtn.disabled) return;
      const scope = _activeAlbum
        ? (_albums.find(a => a.id === _activeAlbum)?.name || 'this album')
        : 'entire gallery';
      const params = new URLSearchParams();
      if (_activeAlbum) params.set('album_id', _activeAlbum);
      let listRes;
      try {
        const r = await fetch(`${API_BASE}/api/gallery/ai-tag-batch?${params.toString()}`, {
          method: 'POST', credentials: 'same-origin',
        });
        listRes = await r.json();
      } catch (e) { uiModule.showError('Failed to fetch tag queue'); return; }
      if (!listRes.ok || !Array.isArray(listRes.image_ids) || listRes.image_ids.length === 0) {
        uiModule.showToast(t('gallery.no_untagged_photos', { scope: scope }));
        return;
      }
      const total = listRes.image_ids.length;
      const untagged = listRes.total_untagged || total;
      if (!await uiModule.styledConfirm(
        t('gallery.tag_all_confirm', { count: total, total: untagged, scope: scope }),
        { confirmText: t('gallery.tag_all') }
      )) return;

      const bar = document.getElementById('gallery-tag-bar');
      const progEl = document.getElementById('gallery-tag-progress');
      const statusEl = document.getElementById('gallery-tag-status');
      const cancelBtn = document.getElementById('gallery-tag-cancel');
      bar.style.display = '';
      progEl.style.width = '0%';
      // 开始按钮变为运行的取消控件（保持启用以便
      // 可点击；上面的点击处理器通过 _tagging 路由到取消）。
      _tagging = true;
      _tagCancelRequested = false;
      tagAllBtn.classList.add('active', 'gallery-tag-cancelling');
      tagAllBtn.textContent = t('common.cancel');
      if (cancelBtn) cancelBtn.style.display = 'none';   // 开始按钮现在覆盖它
      cancelBtn.onclick = () => { _tagCancelRequested = true; statusEl.textContent = t('gallery.cancelling'); };

      let done = 0, failed = 0;
      for (const id of listRes.image_ids) {
        if (_tagCancelRequested) break;
        try {
          const r = await fetch(`${API_BASE}/api/gallery/${id}/ai-tag`, {
            method: 'POST', credentials: 'same-origin',
          });
          const d = await r.json();
          if (!d.ok) failed++;
        } catch (_) { failed++; }
        done++;
        progEl.style.width = `${Math.round((done / total) * 100)}%`;
        statusEl.textContent = `Tagging ${done}/${total}${failed ? ` — ${failed} failed` : ''}`;
      }

      statusEl.textContent = _tagCancelRequested
        ? `Cancelled after ${done}/${total}${failed ? ` (${failed} failed)` : ''}`
        : t('gallery.tagged_done', { done: done - failed, total: total }) + (failed ? t('gallery.failed_tagging', { failed: failed }) : '');
      // 恢复开始按钮。
      _tagging = false;
      tagAllBtn.disabled = false;
      tagAllBtn.classList.remove('active', 'gallery-tag-cancelling');
      tagAllBtn.innerHTML = _tagAllOrigHTML;
      if (cancelBtn) cancelBtn.style.display = '';
      setTimeout(() => { bar.style.display = 'none'; }, 3000);
      await _fetchLibrary(false);
      if (uiModule) uiModule.showToast(t('gallery.tagged_n', { n: done - failed }));
    });
  }

  // ── 工具栏溢出 (⋮) ──
  const moreBtn = document.getElementById('gallery-toolbar-more-btn');
  const moreMenu = document.getElementById('gallery-toolbar-more-menu');
  if (moreBtn && moreMenu) {
    // `.dropdown { display:none }` 不与 [hidden] 关联，因此仅切换
    // 属性不会显示它 — 同时设置内联 display（内联优先）。
    const _setMore = (show) => { moreMenu.hidden = !show; moreMenu.style.display = show ? 'block' : 'none'; };
    _setMore(false);
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _setMore(moreMenu.hidden);
    });
    document.addEventListener('click', (e) => {
      if (!moreMenu.hidden && !moreMenu.contains(e.target) && e.target !== moreBtn) _setMore(false);
    });
  }

  // ── 清除 AI 标签 ──
  const clearAiTagsBtn = document.getElementById('gallery-clear-ai-tags-btn');
  if (clearAiTagsBtn) {
    clearAiTagsBtn.addEventListener('click', async () => {
      if (clearAiTagsBtn.disabled) return;
      if (moreMenu) { moreMenu.hidden = true; moreMenu.style.display = 'none'; }
      if (!await uiModule.styledConfirm(
        'Remove all AI-generated tags from every photo? Your own tags are kept.',
        { confirmText: t('gallery.clear_ai_tags'), danger: true }
      )) return;
      clearAiTagsBtn.disabled = true;
      try {
        const r = await fetch(`${API_BASE}/api/gallery/clear-ai-tags`, {
          method: 'POST', credentials: 'same-origin',
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'Clear failed');
        uiModule.showToast(t('gallery.cleared_ai_tags', { n: d.cleared }));
        await _fetchLibrary(false);
      } catch (e) {
        uiModule.showError(`Failed to clear AI tags: ${e.message || e}`);
      } finally {
        clearAiTagsBtn.disabled = false;
      }
    });
  }


  // ── 选择模式 + 批量删除 ──
  let _selectMode = false;
  const selectBtn = document.getElementById('gallery-select-btn');
  const bulkBar = document.getElementById('gallery-bulk-bar');

  const _selectedDots = () => [...document.querySelectorAll('.gallery-select-dot.selected')];
  const _selectedIds = () => _selectedDots().map(d => d.closest('.gallery-card')?.dataset.id).filter(Boolean);

  function _updateBulkCount() {
    const sel = document.querySelectorAll('.gallery-select-dot.selected').length;
    const total = document.querySelectorAll('.gallery-select-dot').length;
    const el = document.getElementById('gallery-bulk-count');
    if (el) el.textContent = sel + ' selected';
    const all = document.getElementById('gallery-bulk-select-all');
    if (all) { all.checked = total > 0 && sel === total; all.indeterminate = sel > 0 && sel < total; }
    // 有内容选中时，将"操作"按钮变亮到与 "N selected" 计数相同的完整 --fg 颜色
    // （按钮默认使用较暗的 60%--fg）。
    const actions = document.getElementById('gallery-bulk-actions');
    if (actions) actions.style.color = sel > 0 ? 'var(--fg)' : '';
  }

  function _setSelectMode(on) {
    _selectMode = on;
    selectBtn.classList.toggle('active', on);
    // 选择按钮在激活时兼作取消按钮（与文档库一致）。
    selectBtn.textContent = on ? t('common.cancel') : 'Select';
    bulkBar.classList.toggle('hidden', !on);
    // Body 级别信号，使隐藏每缩略图叠加按钮
    // (favorite/download) 的 CSS 规则应用到每张卡片 — 包括
    // 选择模式开启后渲染的卡片（加载更多等）。
    document.body.classList.toggle('gallery-selecting', on);
    document.querySelectorAll('.gallery-select-dot').forEach(d => {
      d.style.display = on ? '' : 'none';
      if (!on) d.classList.remove('selected');
      d.closest('.gallery-card')?.classList.toggle('gallery-card-selectable', on);
    });
    if (!on) document.querySelectorAll('.gallery-bulk-menu').forEach(m => m.remove());
    _updateBulkCount();
  }

  function _exitSelectMode() { _setSelectMode(false); }

  selectBtn.addEventListener('click', () => _setSelectMode(!_selectMode));
  document.getElementById('gallery-bulk-cancel')?.addEventListener('click', () => _exitSelectMode());

  // 全选 / 全部取消。
  document.getElementById('gallery-bulk-select-all')?.addEventListener('change', (e) => {
    const on = e.target.checked;
    document.querySelectorAll('.gallery-select-dot').forEach(d => d.classList.toggle('selected', on));
    _updateBulkCount();
  });

  document.getElementById('gallery-grid').addEventListener('click', (e) => {
    if (!_selectMode) return;
    const card = e.target.closest('.gallery-card');
    if (!card) return;
    e.stopPropagation();
    const dot = card.querySelector('.gallery-select-dot');
    if (dot) { dot.classList.toggle('selected'); _updateBulkCount(); }
  });

  // 移动端：长按缩略图进入选择模式并将该
  // 缩略图标记为首个选中项。通过移动（使垂直
  // 滚动仍然有效）或在计时器触发前抬起手指来取消。
  if ('ontouchstart' in window) {
    const gridEl = document.getElementById('gallery-grid');
    let lpTimer = null;
    let lpCard = null;
    let lpStartX = 0, lpStartY = 0;
    let lpFired = false;
    const LONG_PRESS_MS = 380;
    const MOVE_CANCEL_PX = 10;
    const cancel = () => { clearTimeout(lpTimer); lpTimer = null; lpCard = null; };
    gridEl.addEventListener('touchstart', (e) => {
      const card = e.target.closest('.gallery-card');
      if (!card) return;
      const t = e.touches[0];
      lpCard = card;
      lpStartX = t.clientX; lpStartY = t.clientY;
      lpFired = false;
      lpTimer = setTimeout(() => {
        if (!lpCard) return;
        lpFired = true;
        try { if (navigator.vibrate) navigator.vibrate(15); } catch {}
        if (!_selectMode) _setSelectMode(true);
        const dot = lpCard.querySelector('.gallery-select-dot');
        if (dot && !dot.classList.contains('selected')) {
          dot.classList.add('selected');
          _updateBulkCount();
        }
      }, LONG_PRESS_MS);
    }, { passive: true });
    gridEl.addEventListener('touchmove', (e) => {
      if (!lpCard) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - lpStartX) > MOVE_CANCEL_PX
        || Math.abs(t.clientY - lpStartY) > MOVE_CANCEL_PX) cancel();
    }, { passive: true });
    gridEl.addEventListener('touchend', (e) => {
      if (lpFired) {
        // 吞掉长按后跟随的合成 click 事件，使
        // 轻点不会立即将同一个圆点切换回关闭状态。
        e.preventDefault();
      }
      cancel();
    });
    gridEl.addEventListener('touchcancel', cancel);
  }

  // 拖放导入
  const grid = document.getElementById('gallery-grid');
  const imagesContainer = document.getElementById('gallery-images-container');
  ['dragenter', 'dragover'].forEach(ev => {
    imagesContainer.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); grid.classList.add('gallery-dragover'); });
  });
  ['dragleave', 'drop'].forEach(ev => {
    imagesContainer.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); grid.classList.remove('gallery-dragover'); });
  });
  imagesContainer.addEventListener('drop', (e) => {
    _handleGalleryDrop(e).catch(err => console.error('Gallery drop error:', err));
  });

  // Albums 标签页上的相同拖放处理：拖放的文件夹成为新相册，
  // 零散文件放入当前活动的相册（或保持松散）。
  const albumsContainer = document.getElementById('gallery-albums-container');
  if (albumsContainer) {
    ['dragenter', 'dragover'].forEach(ev => {
      albumsContainer.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        albumsContainer.classList.add('gallery-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      albumsContainer.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        albumsContainer.classList.remove('gallery-dragover');
      });
    });
    albumsContainer.addEventListener('drop', (e) => {
      _handleGalleryDrop(e)
        .then(() => _renderAlbumsTab())
        .catch(err => console.error('Gallery drop error:', err));
    });
  }


  // ── 批量操作菜单（收藏/添加标签/删除选中项）──
  // 动态构建，类似邮件库的 _showBulkActionsMenu，
  // 共享完全相同的下拉菜单样式/行为。
  const _bulkActionsBtn = document.getElementById('gallery-bulk-actions');
  function _showGalleryBulkMenu(anchor) {
    document.querySelectorAll('.gallery-bulk-menu').forEach(d => d.remove());
    // 标准 Odysseus 下拉菜单 (.dropdown + dropdown-item-compact)，
    // 与应用中其他所有菜单保持一致。在按钮位置 fixed 定位。
    const dropdown = document.createElement('div');
    dropdown.className = 'dropdown gallery-bulk-menu';
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - 200);
    // 内联标准下拉菜单外观，使其在 `.dropdown` 规则
    // 被作用域排除的地方也能正确渲染（例如移动端仅悬停媒体查询）。
    dropdown.style.cssText = `position:fixed;display:block;z-index:10001;top:${rect.bottom + 6}px;left:${Math.max(8, left)}px;right:auto;min-width:180px;background:var(--panel,var(--bg));border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.3);padding:6px;font-size:11px;`;
    const _favIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-6.7-4.35-9.33-8.04C.9 10.3 1.4 6.9 4.1 5.6c1.9-.9 4 .03 5 1.7 1-1.67 3.1-2.6 5-1.7 2.7 1.3 3.2 4.7 1.43 7.36C18.7 16.65 12 21 12 21z"/></svg>';
    const _tagIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
    const _dlIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    const _delIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    const _cancelIco = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const items = [
      { label: 'Favorite', icon: _favIco, action: () => _bulkFavorite(_selectedIds()) },
      { label: 'Add tag…', icon: _tagIco, action: () => _bulkTag(_selectedIds()) },
      { label: 'Download', icon: _dlIco, action: () => _bulkDownload(_selectedIds()) },
      { label: 'Delete', icon: _delIco, danger: true, action: () => _bulkDelete(_selectedIds()) },
      { separator: true },
      { label: t('common.cancel'), icon: _cancelIco, action: () => _exitSelectMode() },
    ];
    for (const a of items) {
      if (a.separator) {
        const sep = document.createElement('div');
        sep.className = 'dropdown-divider';
        sep.style.cssText = 'height:1px;background:var(--border);margin:4px 4px;';
        dropdown.appendChild(sep);
        continue;
      }
      const it = document.createElement('div');
      it.className = 'dropdown-item-compact' + (a.danger ? ' dropdown-item-danger' : '');
      it.innerHTML = `<span class="dropdown-icon">${a.icon}</span><span>${a.label}</span>`;
      it.addEventListener('click', (e) => { e.stopPropagation(); dropdown.remove(); a.action(); });
      dropdown.appendChild(it);
    }
    document.body.appendChild(dropdown);
    const close = (ev) => {
      if (!dropdown.contains(ev.target) && ev.target !== anchor) {
        dropdown.remove();
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 10);
  }

  _bulkActionsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    // 切换：当下拉菜单已打开时再次点击操作按钮
    // 应关闭它。外部点击处理器会显式跳过对
    // 锚点的点击，因此按钮本身需要自行关闭。
    const existing = document.querySelector('.gallery-bulk-menu');
    if (existing) { existing.remove(); return; }
    if (!_selectedIds().length) { uiModule.showToast('Select photos first'); return; }
    _showGalleryBulkMenu(e.currentTarget);
  });

  async function _bulkDelete(ids) {
    if (!ids.length) return;
    if (!await uiModule.styledConfirm(`Delete ${ids.length} photo${ids.length > 1 ? 's' : ''}? This cannot be undone.`, { confirmText: t('common.delete'), danger: true })) return;
    const deleted = [], failed = [];
    for (const id of ids) { const ok = await _deleteImage(id); (ok ? deleted : failed).push(id); }
    if (failed.length) uiModule.showError(`Failed to delete ${failed.length} of ${ids.length} photos`);
    _items = _items.filter(i => !deleted.includes(i.id));
    _total = Math.max(0, _total - deleted.length);
    _exitSelectMode();
    if (uiModule) uiModule.showToast(t('gallery.photos_deleted', { n: deleted.length }));
    // 如果我们刚清空了一个过滤视图（例如删除了标签下的所有照片），
    // 移除过滤器并重新加载完整库，以免用户被困在
    // 空白屏幕上，而现已为空的标签/相册/收藏过滤器仍处于活动状态。
    if (_items.length === 0 && (_activeTags.length || _activeAlbum || _favoritesOnly)) {
      _activeTags = [];
      _activeAlbum = null;
      _favoritesOnly = false;
      _fetchLibrary(false);
      _renderAlbums();
      return;
    }
    _renderGrid(); _renderStats();
  }

  async function _bulkDownload(ids) {
    if (!ids.length) return;
    // 超过 5 张 → 在服务端打包成单个 .zip，而不是
    // 发起大量单独的下载。
    if (ids.length > 5) {
      try {
        if (uiModule) uiModule.showToast(t('gallery.zipping_photos', { n: ids.length }));
        const res = await fetch(`${API_BASE}/api/gallery/download-zip`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (!res.ok) throw new Error('zip failed');
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = 'gallery-photos.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
        _exitSelectMode();
        if (uiModule) uiModule.showToast(t('gallery.downloaded_photos', { n: ids.length }));
      } catch (e) {
        if (uiModule) uiModule.showError('Failed to create zip');
      }
      return;
    }
    // 5 张或更少 → 单独下载。
    let n = 0;
    for (const id of ids) {
      const it = _items.find(i => i.id === id);
      if (!it) continue;
      try {
        const res = await fetch(it.url, { credentials: 'same-origin' });
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = it.filename || `image-${it.id}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
        n++;
        // 错开下载，防止浏览器丢弃同时发起的下载。
        await new Promise(r => setTimeout(r, 250));
      } catch (_) { /* 跳过失败 */ }
    }
    _exitSelectMode();
    if (uiModule) uiModule.showToast(t('gallery.downloading_photos', { n: n }));
  }

  async function _bulkFavorite(ids) {
    let n = 0;
    for (const id of ids) {
      if (await _patchImage(id, { favorite: true })) {
        n++;
        const it = _items.find(i => i.id === id); if (it) it.favorite = true;
      }
    }
    _renderGrid(); _exitSelectMode();
    if (uiModule) uiModule.showToast(t('gallery.favorited_n', { n: n }));
  }

  async function _bulkTag(ids) {
    const tag = (await uiModule.styledPrompt('', { title: 'Add tag to selected', placeholder: 'tag', confirmText: t('common.add'), maxLength: 60 }) || '').trim().replace(/^#+/, '').trim();
    if (!tag) return;
    let n = 0;
    for (const id of ids) {
      const it = _items.find(i => i.id === id);
      const existing = (it?.user_tags || it?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      if (existing.includes(tag)) { continue; }
      const merged = [...existing, tag].join(', ');
      if (await _patchImage(id, { tags: merged })) {
        n++;
        if (it) { it.tags = merged; it.user_tags = merged; }
      }
    }
    _exitSelectMode();
    if (uiModule) uiModule.showToast(t('gallery.tagged_n_with_tag', { n: n, tag: tag }));
  }

  modal.addEventListener('click', (e) => {
    if (uiModule.isTouchInsideModal()) return;
    if (e.target === modal) closeGallery();
  });

  _escHandler = (e) => {
    if (e.key === 'Escape') {
      // 当图片编辑器可见时，Escape 保留给
      // 编辑器（取消变换/套索/裁剪，关闭尺寸提示等）。
      // 不要关闭画廊 — 用户会丢失进行中的编辑。
      // 我们检查编辑器容器的可见性和 isEditorOpen()
      // 标志，使裁剪弹窗、变换手柄等都保留 Esc。
      const editorContainer = document.getElementById('gallery-editor-container');
      const editorVisible = !!(
        editorContainer &&
        getComputedStyle(editorContainer).display !== 'none' &&
        editorContainer.querySelector('.gallery-editor')
      );
      if (editorVisible || isEditorOpen()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const detail = document.getElementById('gallery-detail');
      if (detail && detail.style.display !== 'none') {
        // 点击"返回"，使 Esc 和可见按钮始终执行相同操作 —
        // 后续对"返回"拆卸的调整也会自动应用到 Esc。
        // stopImmediatePropagation 阻止 app.js 的通用动态模态框 Esc
        // 处理器，否则它会在我们下面关闭整个画廊。
        e.preventDefault();
        e.stopImmediatePropagation();
        const back = document.getElementById('gallery-detail-back');
        if (back) back.click(); else detail.style.display = 'none';
      } else {
        closeGallery();
      }
      return;
    }
    // 详情视图内的方向键导航（当在输入框中输入时忽略）
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const detail = document.getElementById('gallery-detail');
    if (!detail || detail.style.display === 'none') return;
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
    const btn = document.getElementById(e.key === 'ArrowLeft' ? 'gallery-detail-prev' : 'gallery-detail-next');
    if (btn && !btn.classList.contains('gallery-detail-nav-disabled')) {
      e.preventDefault();
      btn.click();
    }
  };
  // 捕获阶段 + stopImmediatePropagation（参见 _escHandler），使 app.js 的
  // 通用动态模态框 Esc 关闭不会在我们获得机会
  // 只关闭照片详情之前关闭整个画廊。
  document.addEventListener('keydown', _escHandler, true);

  const btn = document.getElementById('tool-gallery-btn');
  if (btn) btn.classList.add('active');

  // 1) 立即绘制缓存状态，让用户即时看到照片。
  //    过滤器、排序、搜索框、相册芯片和网格都来自
  //    模块级状态，我们不再在打开时重置。
  if (_items.length || _albums.length) {
    if (_search) searchInput.value = _search;
    const sortSel = document.getElementById('gallery-sort');
    if (sortSel) sortSel.value = _sort;
    _renderAlbums();
    _renderGrid();
    _renderStats();
  }
  // 2) 在后台刷新，使缓存保持接近最新。如果
  //    获取失败或需要一些时间，缓存的视图保持不变。
  _fetchAlbums();
  _fetchLibrary(false);
  searchInput.focus();
}

function _doCloseGallery() {
  const editorMounted = !!document.querySelector('#gallery-editor-container .gallery-editor');
  if ((window.__galleryEditLive || isEditorOpen() || editorMounted) && !window.__galleryAllowCloseEditor) {
    if (uiModule) uiModule.showToast('Close the edit tab first');
    return;
  }
  _open = false;
  clearTimeout(_searchDebounce);
  if (_galleryResizeHandler) {
    window.removeEventListener('resize', _galleryResizeHandler);
    _galleryResizeHandler = null;
  }
  // 移除人脸覆盖层 resize 监听器，避免在关闭后
  // 泄漏处理器 (v2 review HIGH-9)。
  closeEditor();
  window.__galleryAllowCloseEditor = false;

  const modal = document.getElementById('gallery-modal');
  if (modal) {
    const content = modal.querySelector('.modal-content, .gallery-modal-content');
    if (content) {
      content.classList.add('modal-closing');
      content.addEventListener('animationend', () => modal.remove(), { once: true });
      setTimeout(() => { if (modal.parentElement) modal.remove(); }, 250);
    } else {
      modal.remove();
    }
  }

  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler, true);
    _escHandler = null;
  }

  const btn = document.getElementById('tool-gallery-btn');
  if (btn) btn.classList.remove('active');
}

export function closeGallery() {
  if (!_open && !Modals.isMinimized('gallery-modal')) return;
  if (Modals.isRegistered('gallery-modal')) {
    Modals.close('gallery-modal');
  } else {
    _doCloseGallery();
  }
}

export function isGalleryOpen() {
  if (Modals.isMinimized('gallery-modal')) return false;
  return _open;
}

// ---- 工具函数 ----

function _esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function _humanSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

const galleryModule = {
  openGallery,
  closeGallery,
  isGalleryOpen,
};

export default galleryModule;
