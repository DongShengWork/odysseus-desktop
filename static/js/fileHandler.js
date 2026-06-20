// static/js/fileHandler.js

/**
 * 文件附件和上传处理
 */

import uiModule from './ui.js';
import spinnerModule from './spinner.js';

let pendingFiles = [];
let uploaded = [];
// 保存最近一次 uploadPending() 返回的完整元数据（id/name/mime/size/width/height/…），
// 这样调用方可以将 width/height 附加到他们的 attachment 对象上，
// 而不需要修改 uploadPending() 的返回签名。
let _lastUploadedMeta = [];
let API_BASE = '';
let _uploadSpinners = [];
const _previewUrls = new WeakMap();

const MAX_FILES = 10;
const MAX_VISIBLE = 3;
let _expanded = false;

function _getPreviewUrl(f) {
  if (!f) return '';
  let url = _previewUrls.get(f);
  if (!url) {
    url = URL.createObjectURL(f);
    _previewUrls.set(f, url);
  }
  return url;
}

function _revokePreviewUrl(f) {
  const url = _previewUrls.get(f);
  if (url) {
    try { URL.revokeObjectURL(url); } catch (_) {}
    _previewUrls.delete(f);
  }
}

/**
 * 初始化依赖
 */
export function init(apiBase) {
  API_BASE = apiBase;
}

/**
 * 打开文件选择对话框
 */
export function openPicker() {
  document.getElementById('file-input').click();
}

/**
 * 渲染附件条，显示待处理文件。
 * 1-3 个文件：显示独立标签。
 * 4 个及以上：折叠为单个"N files"徽章（点击展开）。
 */
export function renderAttachStrip() {
  const strip = document.getElementById('attach-strip');

  while (strip.firstChild) strip.removeChild(strip.firstChild);
  if (pendingFiles.length === 0) {
    _expanded = false;
    if (window._updateSendBtnIcon) window._updateSendBtnIcon();
    return;
  }

  const total = pendingFiles.length;
  const collapsed = total > MAX_VISIBLE && !_expanded;

  if (collapsed) {
    // 单个紧凑徽章："5 files ×"
    const badge = document.createElement('div');
    badge.className = 'thumb thumb-collapsed';
    const label = document.createElement('span');
    label.textContent = t('file.files_label', { n: total });
    label.className = 'thumb-collapsed-label';
    badge.appendChild(label);
    badge.title = pendingFiles.map(f => f.name || t('file.pasted_image')).join('\n');
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', (e) => {
      if (e.target.closest('.thumb-collapsed-x')) return;
      _expanded = true;
      renderAttachStrip();
    });
    const x = document.createElement('button');
    x.className = 'thumb-collapsed-x';
    x.textContent = '\u00d7';
    x.title = t('file.remove_all');
    x.addEventListener('click', (e) => { e.stopPropagation(); clearPending(); });
    badge.appendChild(x);
    strip.appendChild(badge);
  } else {
    // 显示独立标签
    for (let idx = 0; idx < total; idx++) {
      strip.appendChild(_createChip(pendingFiles[idx], idx));
    }
  }
  if (window._updateSendBtnIcon) window._updateSendBtnIcon();
}

function _createChip(f, idx) {
  const chip = document.createElement('div');
  chip.className = 'thumb';
  const isImage = f.type?.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(f.name || '');
  if (isImage) {
    chip.classList.add('thumb-image');  // 让 CSS 在移动端将删除按钮覆盖到角落
    const img = document.createElement('img');
    img.className = 'thumb-img';
    img.src = _getPreviewUrl(f);
    img.alt = f.name || t('file.image_alt');
    chip.appendChild(img);
  } else {
    const span = document.createElement('span');
    span.textContent = f.name || t('file.pasted_image');
    chip.appendChild(span);
  }
  const x = document.createElement('button');
  x.textContent = '\u00d7';
  x.setAttribute('aria-label', t('file.remove_attachment'));
  x.addEventListener('click', (e) => { e.stopPropagation(); removePending(idx); });
  chip.appendChild(x);
  return chip;
}

/**
 * 按索引移除待处理文件
 */
export function removePending(idx) {
  _revokePreviewUrl(pendingFiles[idx]);
  pendingFiles.splice(idx, 1);
  renderAttachStrip();
}

/**
 * 上传所有待处理文件到服务器
 */
export async function uploadPending() {
  if (pendingFiles.length === 0) return [];

  // 消息气泡会立刻显示，但上传可能需要一点时间 —
  // 将标签变暗并覆盖一个 whirlpool 旋转动画，让用户知道文件还在发送中
  // （而不是看起来卡住了）。在下面的 finally 中清除。
  const strip = document.getElementById('attach-strip');
  if (strip) {
    strip.classList.add('attach-uploading');
    // 在每个附件标签（图片/文档）上放置一个 whirlpool 旋转动画，
    // 让旋转动画直接显示在正在上传的文件上，而不是悬浮在整个条带上方。
    strip.querySelectorAll('.thumb').forEach(chip => {
      try {
        const sp = spinnerModule.create('', 'clean', 'whirlpool');
        const ov = document.createElement('span');
        ov.className = 'thumb-upload-spinner';
        ov.appendChild(sp.createElement());
        chip.appendChild(ov);
        sp.start();
        _uploadSpinners.push(sp);
      } catch (_) { /* spinner 仅尽力而为 */ }
    });
  }

  const fd = new FormData();
  pendingFiles.forEach(f => fd.append('files', f, f.name || 'paste.png'));

  try {
    const res = await fetch(`${API_BASE}/api/upload`, {
      method: 'POST',
      body: fd
    });
    if (!res.ok) {
      // Surface the failure instead of swallowing it. Previously a non-OK
      // response (e.g. 429 rate limit, 413 too large) was ignored: the files
      // silently vanished and the chat sent with no attachments, so the model
      // "didn't even see them" (issue #1346). Show the server's reason and keep
      // pendingFiles so the strip re-renders for a retry (see finally below).
      let detail = '';
      try { const e = await res.json(); detail = e.detail || e.error || ''; } catch (_) {}
      _showToast(t('file.upload_failed') + (detail ? ': ' + detail : ` (HTTP ${res.status})`));
      return [];
    }
    const data = await res.json();
    uploaded = (data.files || []);
    pendingFiles = [];          // 仅在成功时清空
    // 将完整元数据（包括图片的 width/height）存储在模块上，
    // 让需要的调用方可以通过 getLastUploadedMeta() 获取。
    // 返回值保持 `ids` 格式以兼容现有的调用点。
    _lastUploadedMeta = uploaded;
    return uploaded.map(x => x.id);
  } finally {
    _uploadSpinners.forEach(sp => { try { sp.stop && sp.stop(); } catch (_) {} });
    _uploadSpinners = [];
    if (strip) strip.classList.remove('attach-uploading');
    // 重新渲染：成功时清空（标签消失），或失败时恢复以便用户重试
    // — 两种情况下旋转动画都会被移除。
    renderAttachStrip();
  }
}

/**
 * 添加文件到待处理列表（最多 MAX_FILES 个）
 */
export function addFiles(files) {
  for (const f of files) {
    if (pendingFiles.length >= MAX_FILES) {
      _showToast(t('file.max_files', { n: MAX_FILES }));
      break;
    }
    pendingFiles.push(f);
  }
  renderAttachStrip();
}

function _showToast(msg) {
  if (window.showToast) { window.showToast(msg); return; }
  // 回退内联提示
  let t = document.getElementById('_attach-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '_attach-toast';
    t.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--red);color:var(--red);padding:6px 14px;border-radius:6px;font-size:13px;z-index:9999;opacity:0;transition:opacity .3s';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

/**
 * 获取待处理文件数量
 */
export function getPendingCount() {
  return pendingFiles.length;
}

/**
 * 获取原始待处理 File 对象（在上传清空之前读取内容）
 */
export function getPendingRaw() {
  return [...pendingFiles];
}

/**
 * 获取待处理文件元数据（名称、大小、类型）用于显示
 */
export function getPendingInfo() {
  return pendingFiles.map(f => {
    const isImage = f.type?.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(f.name || '');
    return {
      name: f.name || t('file.pasted_image'),
      size: f.size || 0,
      mime: f.type || '',
      previewUrl: isImage ? _getPreviewUrl(f) : '',
    };
  });
}

/**
 * 清除所有待处理文件
 */
export function clearPending() {
  pendingFiles.forEach(_revokePreviewUrl);
  pendingFiles = [];
  renderAttachStrip();
}

/** 最近一次 uploadPending() 返回的完整元数据（包括图片的 width/height）。 */
export function getLastUploadedMeta() {
  return _lastUploadedMeta;
}

var escapeHtml = uiModule.esc;

const fileHandlerModule = {
  init,
  openPicker,
  renderAttachStrip,
  removePending,
  uploadPending,
  addFiles,
  getPendingCount,
  getPendingInfo,
  getPendingRaw,
  clearPending,
  getLastUploadedMeta,
};

export default fileHandlerModule;
