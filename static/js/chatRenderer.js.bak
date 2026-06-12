// static/js/chatRenderer.js
// 从 chat.js 提取 — 消息渲染、引用来源、图片、性能指标

import uiModule from './ui.js';
import markdownModule from './markdown.js';
import { addAITTSButton } from './tts-ai.js';
import { providerLogo, providerLabel } from './providers.js';
import settingsModule from './settings.js';
import spinnerModule from './spinner.js';
import { bindMenuDismiss } from './escMenuStack.js';
import { matchModelKey } from './model/matchKey.js';

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>';
const REPORT_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>';
const CHAT_ABOUT_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

/** 对用于 href 的 URL 进行安全过滤 — 仅允许 http(s) 和协议相对路径。 */
function _safeHref(url) {
  if (!url) return '#';
  try {
    var parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return uiModule.esc(url);
  } catch(e) { /* 无效的 URL */ }
  return '#';
}

export function safeToolScreenshotSrc(raw) {
  const src = String(raw || '').trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) {
    return src;
  }
  return '';
}

export function safeDisplayImageSrc(raw) {
  const src = String(raw || '').trim();
  if (!src) return '';
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) {
    return src;
  }
  try {
    const parsed = new URL(src, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (_) {}
  return '';
}

function _makeActionBtn(className, title, text, handler) {
  const btn = document.createElement('button');
  btn.className = className;
  btn.type = 'button';
  btn.title = title;
  btn.textContent = text;
  btn.addEventListener('click', handler);
  return btn;
}

// 附件卡片辅助函数
function _attachIcon(mimeOrName) {
  const s = (mimeOrName || '').toLowerCase();
  if (s.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(s))
    return '<svg class="attach-card-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
  if (s.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|webm)$/i.test(s))
    return '<svg class="attach-card-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  if (s === 'application/pdf' || /\.pdf$/i.test(s))
    return '<svg class="attach-card-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  // 默认：通用文档图标
  return '<svg class="attach-card-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}
function _formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// 构建消息附件列表的 `.attach-cards` 元素。由 addMessage 和
// updateMessageAttachments 共享，使实时（乐观）用户气泡在
// 上传完成后可以用真实上传 ID 重新渲染。
function buildAttachCards(attachments) {
  const attachWrap = document.createElement('div');
  attachWrap.className = 'attach-cards';
  for (const att of attachments) {
    const isImage = (att.mime || '').startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(att.name || '');
    if (isImage) {
      // 图片预览。对已上传（有 att.id）和仍在
      // 上传中的附件都显示。闪烁骨架 + 漩涡填充
      // 空间，直到上传解析完成（尚无 id）或缩略图
      // 图片加载完成，避免照片突然弹出。
      const imgWrap = document.createElement('div');
      imgWrap.className = 'attach-image-preview';
      imgWrap.style.cursor = att.id ? 'zoom-in' : 'default';
      if (att.id) imgWrap.dataset.fileId = att.id;
      if (att.id) {
        imgWrap.addEventListener('click', (e) => {
          // 点击角落 OCR 按钮不应同时打开灯箱。
          if (e.target.closest('.attach-ocr-btn')) return;
          _openImageLightbox(att);
        });
      }

      let skel = null;
      let sp = null;
      if (!att.previewUrl) {
        // 骨架占位符，带居中漩涡。被移除时自动停止。
        skel = document.createElement('div');
        skel.className = 'attach-image-skeleton';
        // 在上传时后端已知宽高比时，匹配照片的宽高比，
        // 避免骨架以 4:3 默认比例显示，然后在图片到达时
        // 突然变为竖版形状。
        if (att.width && att.height) {
          skel.style.aspectRatio = att.width + ' / ' + att.height;
          skel.style.width = 'auto';
          skel.style.height = 'auto';
          skel.style.maxWidth = '300px';
          skel.style.maxHeight = '200px';
          skel.style.minWidth = '80px';
        }
        sp = spinnerModule.createWhirlpool(20);
        skel.appendChild(sp.element);
        imgWrap.appendChild(skel);
      }

      if (att.id || att.previewUrl) {
        const img = document.createElement('img');
        // 小缩略图缓存 — 预览很小，无需拉取
        // 全分辨率照片。点击仍会打开完整图片。
        img.alt = att.name || 'Image';
        img.loading = 'lazy';
        img.style.cssText = 'max-width:300px;max-height:200px;border-radius:6px;display:' + (att.previewUrl ? 'block' : 'none') + ';';
        let _revealed = false;
        let _revealTimer = null;
        const _reveal = () => {
          if (_revealed) return;
          _revealed = true;
          if (_revealTimer) { clearTimeout(_revealTimer); _revealTimer = null; }
          img.style.display = 'block';
          try { sp && sp.stop(); } catch {}
          if (skel) skel.remove();
        };
        img.addEventListener('load', _reveal);
        img.addEventListener('error', _reveal);
        img.src = att.previewUrl || `/api/upload/${att.id}?thumb=1`;
        // 缓存的图片可能在 load 监听器附加之前就已加载完成。
        if (img.complete && img.naturalWidth) _reveal();
        // 保底：如果 8 秒内 load 和 error 都没触发，仍然显示。
        // 显示时清除计时器，updateMessageAttachments 替换卡片时
        // （会从 DOM 中移除 img / skel 元素）也清除，因此
        // 重复重新渲染不会累积孤立的计时器。
        if (!att.previewUrl) _revealTimer = setTimeout(_reveal, 8000);
        imgWrap.appendChild(img);

        if (att.id) {
          // 小角落按钮 → 打开视觉/OCR 编辑器，使用户可以
          // 更正视觉模型提取的内容。编辑缓存于
          // 服务器，以文件 ID 为键，因此此后引用同一
          // 图片的消息会获取更正后的文本，而无需重新运行模型。
          const ocrBtn = document.createElement('button');
          ocrBtn.type = 'button';
          ocrBtn.className = 'attach-ocr-btn';
          ocrBtn.title = 'View / edit OCR text';
          ocrBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg><span class="attach-ocr-label">Caption</span>';
          ocrBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _openVisionEditor(att, ocrBtn.closest('.msg'));
          });
          imgWrap.appendChild(ocrBtn);
        }
      }

      if (att.vision_model) {
        const visionLabel = document.createElement('div');
        visionLabel.className = 'attach-vision-model';
        visionLabel.textContent = 'Vision: ' + String(att.vision_model).split('/').pop();
        imgWrap.appendChild(visionLabel);
      }
      if (att.name) {
        const label = document.createElement('div');
        label.className = 'attach-image-name';
        label.textContent = att.name;
        imgWrap.appendChild(label);
      }
      attachWrap.appendChild(imgWrap);
    } else {
      // 非图片文件卡片
      const card = document.createElement('div');
      card.className = 'attach-card';
      card.dataset.name = att.name;
      if (att.id) {
        card.dataset.fileId = att.id;
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
          // PDF 和文本/代码/markdown → 在文档查看器中打开
          // （其他文件回退到原始文件）。
          if (window.chatModule?.openAttachment) window.chatModule.openAttachment(att, false);
          else window.open(`/api/upload/${att.id}`, '_blank');
        });
      }
      const icon = _attachIcon(att.mime || att.name);
      const nameSpan = document.createElement('span');
      nameSpan.className = 'attach-card-name';
      nameSpan.textContent = att.name;
      card.innerHTML = icon;
      card.appendChild(nameSpan);
      if (att.size) {
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'attach-card-size';
        sizeSpan.textContent = _formatSize(att.size);
        card.appendChild(sizeSpan);
      }
      attachWrap.appendChild(card);
    }
  }
  return attachWrap;
}

// 重新渲染已渲染消息的附件卡片。用于将
// 真实上传 ID（和图片缩略图）换入乐观用户气泡，
// 在 uploadPending() 解析后 — 否则图片预览仅在
// 刷新后出现，因为气泡在上传分配 ID 之前渲染。
export function updateMessageAttachments(msgWrap, attachments) {
  if (!msgWrap || !attachments?.length) return;
  const body = msgWrap.querySelector('.body') || msgWrap;
  const existing = body.querySelector('.attach-cards');
  const fresh = buildAttachCards(attachments);
  if (existing) existing.replaceWith(fresh);
  else body.appendChild(fresh);
}

// 用户点击聊天照片缩略图时的快速全尺寸预览。
// 居中显示原始图片的覆盖层 — 无 Gallery 面板，无编辑器。
function _openImageLightbox(att) {
  if (!att?.id) return;
  const overlay = document.createElement('div');
  overlay.className = 'attach-lightbox';
  // 立即显示缓存的缩略图，避免覆盖层在 25MB 原始图片
  // 流式加载时显示空白。完整图片加载后替换；
  // 如果完整加载失败（404 / 网络），保留缩略图 + 显示
  // 错误标签，而非永远显示空白覆盖层。
  const img = document.createElement('img');
  img.alt = att.name || '';
  img.src = `/api/upload/${att.id}?thumb=1`;
  overlay.appendChild(img);
  const full = new Image();
  full.addEventListener('load', () => { img.src = full.src; });
  full.addEventListener('error', () => {
    const err = document.createElement('div');
    err.className = 'attach-lightbox-err';
    err.textContent = 'Failed to load full-resolution image.';
    overlay.appendChild(err);
  });
  full.src = `/api/upload/${att.id}`;

  const _onKey = (e) => { if (e.key === 'Escape') _close(); };
  const _close = () => {
    document.removeEventListener('keydown', _onKey);
    if (_overlayObs) { try { _overlayObs.disconnect(); } catch {} }
    overlay.remove();
  };
  // 如果覆盖层通过非关闭处理程序的路径被移除
  // （会话切换、父元素重新渲染、外部清理），仍然移除
  // 文档级 keydown 监听器，防止泄漏。
  let _overlayObs = null;
  try {
    _overlayObs = new MutationObserver(() => {
      if (!document.body.contains(overlay)) {
        document.removeEventListener('keydown', _onKey);
        _overlayObs.disconnect();
      }
    });
    _overlayObs.observe(document.body, { childList: true, subtree: false });
  } catch {}
  overlay.addEventListener('click', _close);
  document.addEventListener('keydown', _onKey);
  document.body.appendChild(overlay);
}

// 视觉/OCR 编辑器模态框 — 从聊天照片缩略图的角落 "Aa" 按钮打开。
// 让用户查看和更正视觉模型提供给 LLM 的文本
// （例如 OCR 误读单词时）。持久化到服务器的视觉
// 缓存（PUT /api/upload/{id}/vision），因此任何后续
// 引用同一文件的消息都会获取更正后的文本。
let _visionEditorEl = null;
let _visionEditorEsc = null;
function _closeVisionEditor() {
  if (_visionEditorEsc) { document.removeEventListener('keydown', _visionEditorEsc); _visionEditorEsc = null; }
  if (_visionEditorEl) { _visionEditorEl.remove(); _visionEditorEl = null; }
}
function _openVisionEditor(att, userMsgEl) {
  if (!att?.id) return;
  _closeVisionEditor();
  const overlay = document.createElement('div');
  overlay.className = 'vision-editor-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeVisionEditor(); });
  const panel = document.createElement('div');
  panel.className = 'vision-editor-panel';
  const title = document.createElement('div');
  title.className = 'vision-editor-title';
  // 眼睛图标与设置 → 视觉中的图标匹配，让用户识别此文本来源。
  //
  title.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.7;flex-shrink:0"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>Vision text</span>';
  panel.appendChild(title);
  const desc = document.createElement('div');
  desc.className = 'vision-editor-desc';
  desc.textContent = 'Edit text and save, new chats will have the new context. Regenerate or continue from there.';
  panel.appendChild(desc);
  const ta = document.createElement('textarea');
  ta.className = 'vision-editor-text';
  ta.rows = 10;
  ta.placeholder = 'Loading…';
  ta.disabled = true;
  panel.appendChild(ta);
  const actions = document.createElement('div');
  actions.className = 'vision-editor-actions';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'vision-editor-btn';
  closeBtn.innerHTML = '<span class="vision-btn-label">Close</span>';
  closeBtn.addEventListener('click', _closeVisionEditor);
  const _saveVisionText = async () => {
    const res = await fetch(`/api/upload/${att.id}/vision`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ text: ta.value }),
    });
    if (!res.ok) throw new Error('save failed');
  };
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'vision-editor-btn vision-editor-btn-primary';
  saveBtn.innerHTML = '<span class="vision-btn-label">Save</span>';
  saveBtn.disabled = true;
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="vision-btn-label">Saving…</span>';
    try {
      await _saveVisionText();
      if (uiModule?.showToast) uiModule.showToast('Saved');
      _closeVisionEditor();
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<span class="vision-btn-label">Save</span>';
      if (uiModule?.showError) uiModule.showError('Failed to save OCR text');
    }
  });
  // 重新生成消息：保存编辑后的文本，关闭，然后触发重新发送
  // 用户消息，使新的 AI 回复立即使用编辑结果。
  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.className = 'vision-editor-btn vision-editor-btn-primary';
  regenBtn.title = 'Save and regenerate the message';
  regenBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span class="vision-btn-label">Regenerate message</span>';
  regenBtn.disabled = true;
  regenBtn.addEventListener('click', async () => {
    regenBtn.disabled = true;
    saveBtn.disabled = true;
    try {
      await _saveVisionText();
      _closeVisionEditor();
      if (userMsgEl && window.chatModule?.resendUserMessage) {
        window.chatModule.resendUserMessage(userMsgEl);
      } else if (uiModule?.showToast) {
        uiModule.showToast('Saved');
      }
    } catch (e) {
      regenBtn.disabled = false;
      saveBtn.disabled = false;
      if (uiModule?.showError) uiModule.showError('Failed to save OCR text');
    }
  });
  actions.appendChild(closeBtn);
  actions.appendChild(saveBtn);
  actions.appendChild(regenBtn);
  panel.appendChild(actions);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  _visionEditorEl = overlay;

  // ESC 关闭弹出窗口。注册在 document 上，使其无论焦点在哪里都能工作
  // （否则 textarea 会吞掉该事件）。
  _visionEditorEsc = (e) => { if (e.key === 'Escape') _closeVisionEditor(); };
  document.addEventListener('keydown', _visionEditorEsc);

  fetch(`/api/upload/${att.id}/vision`, { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : Promise.reject(r))
    .then(data => {
      ta.value = data.text || '';
      ta.placeholder = '';
      ta.disabled = false;
      saveBtn.disabled = false;
      regenBtn.disabled = !userMsgEl;
      ta.focus();
    })
    .catch(() => {
      ta.value = '';
      ta.placeholder = 'Could not load OCR text — type your correction and save.';
      ta.disabled = false;
      saveBtn.disabled = false;
      regenBtn.disabled = !userMsgEl;
    });
}

// 从显示文本中剥离的工具调用语法模式
const TOOL_CALL_RE = /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi;
// 仅剥离看起来像结构化调用的围栏工具调用块，而非普通代码示例
const EXEC_FENCE_RE = /```(?:web_search|read_file|write_file|create_document|edit_document|update_document)\s*\n[\s\S]*?```/gi;
// XML 风格的工具调用：<minimax:tool_call>、<tool_call>、<function_call>、裸 <invoke>
const XML_TOOL_CALL_RE = /<(?:[\w]+:)?(?:tool_call|function_call)>[\s\S]*?<\/(?:[\w]+:)?(?:tool_call|function_call)>/gi;
const XML_INVOKE_RE = /<invoke\s+name=['"][^'"]*['"]>[\s\S]*?<\/invoke>/gi;
// DeepSeek "DSML" 工具调用标记（全角竖线 ｜ 或 ascii | 分隔），
// 当模型发出文本工具调用而非原生调用时泄漏到内容中。
// 剥离整个块；第二个模式捕获杂散/部分标签
// （例如流传输中在闭合标签到达之前）。
const DSML_TOOL_RE = /<\s*[｜|]+\s*DSML\s*[｜|]+\s*tool_calls\s*>[\s\S]*?(?:<\s*\/\s*[｜|]+\s*DSML\s*[｜|]+\s*tool_calls\s*>|$)/gi;
const DSML_STRAY_RE = /<\s*\/?\s*[｜|]+\s*DSML\s*[｜|]+[^>]*>/gi;
// 关于工具结果的自述（模型回显 stdout/exit_code）
const TOOL_NARRATION_RE = /(?:The (?:result|output) shows?:?\s*)?-?\s*(?:stdout|stderr|exit_code):\s*.+/gi;


// 模型定价表 — 每百万 token
// 模型信息：定价（每 1M token）+ 上下文窗口长度
const MODEL_INFO = {
  // --- Anthropic ---
  'claude-sonnet-4-5':    { input: 3.00,  output: 15.00, ctx: 200000 },
  'claude-sonnet-4-6':    { input: 3.00,  output: 15.00, ctx: 200000 },
  'claude-sonnet-4':      { input: 3.00,  output: 15.00, ctx: 200000 },
  'claude-opus-4':        { input: 15.00, output: 75.00, ctx: 200000 },
  'claude-opus-4-6':      { input: 15.00, output: 75.00, ctx: 200000 },
  'claude-haiku-4':       { input: 0.80,  output: 4.00,  ctx: 200000 },
  'claude-haiku-3-5':     { input: 0.80,  output: 4.00,  ctx: 200000 },
  'claude-3-5-sonnet':    { input: 3.00,  output: 15.00, ctx: 200000 },
  'claude-3-5-haiku':     { input: 0.80,  output: 4.00,  ctx: 200000 },
  'claude-3-opus':        { input: 15.00, output: 75.00, ctx: 200000 },
  'claude-3-sonnet':      { input: 3.00,  output: 15.00, ctx: 200000 },
  'claude-3-haiku':       { input: 0.25,  output: 1.25,  ctx: 200000 },
  // --- OpenAI ---
  'gpt-5':                { input: 2.00,  output: 8.00,  ctx: 400000 },
  'gpt-4.1':              { input: 2.00,  output: 8.00,  ctx: 1047576 },
  'gpt-4.1-mini':         { input: 0.40,  output: 1.60,  ctx: 1047576 },
  'gpt-4.1-nano':         { input: 0.10,  output: 0.40,  ctx: 1047576 },
  'gpt-4o':               { input: 2.50,  output: 10.00, ctx: 128000 },
  'gpt-4o-mini':          { input: 0.15,  output: 0.60,  ctx: 128000 },
  'gpt-4-turbo':          { input: 10.00, output: 30.00, ctx: 128000 },
  'o1':                   { input: 15.00, output: 60.00, ctx: 200000 },
  'o1-mini':              { input: 3.00,  output: 12.00, ctx: 128000 },
  'o1-pro':               { input: 150.0, output: 600.0, ctx: 200000 },
  'o3':                   { input: 2.00,  output: 8.00,  ctx: 200000 },
  'o3-mini':              { input: 1.10,  output: 4.40,  ctx: 200000 },
  'o4-mini':              { input: 1.10,  output: 4.40,  ctx: 200000 },
  // --- DeepSeek ---
  'deepseek-chat':        { input: 0.27,  output: 1.10,  ctx: 64000 },
  'deepseek-coder':       { input: 0.27,  output: 1.10,  ctx: 64000 },
  'deepseek-reasoner':    { input: 0.55,  output: 2.19,  ctx: 64000 },
  'deepseek-r1':          { input: 0.55,  output: 2.19,  ctx: 64000 },
  'deepseek-v3':          { input: 0.27,  output: 1.10,  ctx: 64000 },
  'deepseek-v2':          { input: 0.14,  output: 0.28,  ctx: 64000 },
  // --- Google ---
  'gemini-2.5-pro':       { input: 1.25,  output: 10.00, ctx: 1048576 },
  'gemini-2.5-flash':     { input: 0.15,  output: 0.60,  ctx: 1048576 },
  'gemini-2.0-flash':     { input: 0.10,  output: 0.40,  ctx: 1048576 },
  'gemini-1.5-pro':       { input: 1.25,  output: 5.00,  ctx: 1048576 },
  'gemini-1.5-flash':     { input: 0.075, output: 0.30,  ctx: 1048576 },
  'gemma-3':              { input: 0.10,  output: 0.10,  ctx: 128000 },
  // --- Mistral ---
  'mistral-large':        { input: 2.00,  output: 6.00,  ctx: 128000 },
  'mistral-medium':       { input: 2.00,  output: 6.00,  ctx: 32000 },
  'mistral-small':        { input: 0.20,  output: 0.60,  ctx: 32000 },
  'mistral-nemo':         { input: 0.15,  output: 0.15,  ctx: 128000 },
  'mixtral':              { input: 0.24,  output: 0.24,  ctx: 32000 },
  'codestral':            { input: 0.30,  output: 0.90,  ctx: 32000 },
  'pixtral':              { input: 2.00,  output: 6.00,  ctx: 128000 },
  // --- xAI ---
  'grok-4':               { input: 3.00,  output: 15.00, ctx: 131072 },
  'grok-3':               { input: 3.00,  output: 15.00, ctx: 131072 },
  'grok-2':               { input: 2.00,  output: 10.00, ctx: 131072 },
  // --- Meta ---
  'llama-4':              { input: 0.20,  output: 0.20,  ctx: 1048576 },
  'llama-3.3':            { input: 0.20,  output: 0.20,  ctx: 131072 },
  'llama-3.2':            { input: 0.20,  output: 0.20,  ctx: 131072 },
  'llama-3.1':            { input: 0.20,  output: 0.20,  ctx: 131072 },
  'llama-3':              { input: 0.20,  output: 0.20,  ctx: 131072 },
  // --- Qwen ---
  'qwen3':                { input: 0.30,  output: 1.20,  ctx: 131072 },
  'qwen2.5':              { input: 0.30,  output: 1.20,  ctx: 131072 },
  'qwq':                  { input: 0.30,  output: 1.20,  ctx: 32768 },
  // --- Cohere ---
  'command-a':            { input: 2.50,  output: 10.00, ctx: 256000 },
  'command-r-plus':       { input: 2.50,  output: 10.00, ctx: 128000 },
  'command-r':            { input: 0.15,  output: 0.60,  ctx: 128000 },
  // --- Perplexity ---
  'sonar-pro':            { input: 3.00,  output: 15.00, ctx: 200000 },
  'sonar':                { input: 1.00,  output: 1.00,  ctx: 128000 },
  // --- MiniMax ---
  'minimax':              { input: 0.70,  output: 0.70,  ctx: 1000000 },
  // --- Kimi / Moonshot ---
  'moonshot':             { input: 1.00,  output: 1.00,  ctx: 128000 },
  'kimi':                 { input: 1.00,  output: 1.00,  ctx: 128000 },
  // --- Microsoft ---
  'phi-4':                { input: 0.07,  output: 0.14,  ctx: 16000 },
  'phi-3':                { input: 0.07,  output: 0.14,  ctx: 128000 },
  // --- Nvidia ---
  'nemotron':             { input: 0.30,  output: 1.20,  ctx: 131072 },
  // --- Nous ---
  'hermes':               { input: 0.20,  output: 0.20,  ctx: 131072 },
};

// 兼容别名
const MODEL_PRICING = MODEL_INFO;

// 图像生成成本查询（每张图片，按模型 × 质量 × 尺寸）
const IMAGE_PRICING = {
  'gpt-image-1.5': { 'low': { '1024x1024': 0.009, '1024x1536': 0.013, '1536x1024': 0.013 }, 'medium': { '1024x1024': 0.034, '1024x1536': 0.05, '1536x1024': 0.05 }, 'high': { '1024x1024': 0.133, '1024x1536': 0.2, '1536x1024': 0.2 } },
  'gpt-image-1':   { 'low': { '1024x1024': 0.011, '1024x1536': 0.016, '1536x1024': 0.016 }, 'medium': { '1024x1024': 0.042, '1024x1536': 0.063, '1536x1024': 0.063 }, 'high': { '1024x1024': 0.167, '1024x1536': 0.25, '1536x1024': 0.25 } },
  'gpt-image-1-mini': { 'low': { '1024x1024': 0.005, '1024x1536': 0.006, '1536x1024': 0.006 }, 'medium': { '1024x1024': 0.011, '1024x1536': 0.015, '1536x1024': 0.015 }, 'high': { '1024x1024': 0.036, '1024x1536': 0.052, '1536x1024': 0.052 } },
};

export function shortModel(name) {
  if (!name) return '...';
  if (typeof name !== 'string') name = String(name);
  let short = name.split('/').pop();
  // 剥离 .gguf 扩展名
  short = short.replace(/\.gguf$/i, '');
  // 剥离量化后缀（Q4_K_M、Q8_0 等）和分片编号
  short = short.replace(/-0000\d-of-\d+$/, '');
  short = short.replace(/[-_](Q\d[_A-Z\d]*|F16|F32|BF16|fp16|fp32)$/i, '');
  // 如果仍然太长则截断（保留第一个有意义的部分）
  if (short.length > 25) {
    // 尝试找到自然断点（模型大小后的破折号，如 -35B 或 -7B）
    const sizeMatch = short.match(/^(.+?-\d+[BbMm])/);
    if (sizeMatch) short = sizeMatch[1];
    else short = short.substring(0, 22) + '…';
  }
  return short;
}

function modelValue(name) {
  if (name == null) return '';
  return String(name).trim();
}

export function sameModelName(left, right) {
  const a = modelValue(left);
  const b = modelValue(right);
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase()
    || shortModel(a).toLowerCase() === shortModel(b).toLowerCase();
}

export function modelRouteLabel(requestedModel, actualModel) {
  const requested = modelValue(requestedModel);
  const actual = modelValue(actualModel) || requested;
  if (!requested || sameModelName(requested, actual)) return shortModel(actual || requested);
  return shortModel(requested) + ' -> ' + shortModel(actual);
}

export function replyModelPair(modelName, metadata) {
  const meta = metadata || {};
  const actualFromMeta = modelValue(meta.model || meta.actual_model);
  const requestedFromMeta = modelValue(meta.requested_model || meta.selected_model);
  if (actualFromMeta || requestedFromMeta) {
    const actual = actualFromMeta || requestedFromMeta || modelValue(modelName);
    const requested = requestedFromMeta || actual;
    return { requestedModel: requested, actualModel: actual };
  }
  const fallback = modelValue(modelName);
  return { requestedModel: fallback, actualModel: fallback };
}

