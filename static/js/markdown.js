// static/js/markdown.js

/**
 * Markdown 渲染和内容处理工具
 */

import uiModule from './ui.js';
import { splitTableRow } from './markdown/tableRow.js';
import { replaceEmojiShortcodes, hasEmojiShortcode } from './emojiShortcodes.js';

var escapeHtml = uiModule.esc;

function safeLinkUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (url.startsWith('#')) {
    return /^#[A-Za-z0-9_-]*$/.test(url) ? url : '';
  }
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (_) {
    return '';
  }
  return '';
}

function linkHtml(text, url) {
  const safeUrl = safeLinkUrl(url);
  const safeText = escapeHtml(text);
  if (!safeUrl) return safeText;
  if (safeUrl.startsWith('#')) {
    return `<a href="${safeUrl}" class="chat-link">${safeText}</a>`;
  }
  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${safeText}</a>`;
}

function _isModelEndpointUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''), window.location.origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const path = parsed.pathname.replace(/\/+$/, '');
    return path === '/v1';
  } catch (_) {
    return false;
  }
}

/**
 * Sanitize the raw-HTML fragments that mdToHtml deliberately preserves from
 * the source text — <details> blocks (collapsible agent output) and <a> tags
 * (emitted by the markdown link pass). Those fragments are later restored
 * verbatim into innerHTML, so without scrubbing them a model — or any content
 * routed through here — could smuggle in an `<img onerror=...>`, an
 * `<a href="javascript:...">`、`onmouseover=` 处理器等，
 * script in the authenticated page (DOM XSS).
 *
 * 解析到 <template> 中是惰性的：赋值给 template.innerHTML 既不会
 * 获取资源也不会运行脚本，因此我们可以遍历生成的 DOM 树，
 * 删除可执行脚本的元素，并在返回（现已安全）的片段之前
 * 剥离事件处理器属性和危险 URL 协议。
 */
const _ALLOWED_HTML_BAD_TAGS = new Set([
  'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',
  'STYLE', 'BASE', 'FORM', 'NOSCRIPT', 'TEMPLATE',
  // Foreign-content roots. SVG/MathML have their own parser rules and are a
  // classic mutation-XSS vehicle — e.g. an SVG-namespaced <script>, whose
  // `tagName` is the lower-case 'script' and would slip a name check that
  // assumed HTML's upper-casing. They aren't needed in the <details>/<a>
  // fragments we preserve, so drop the whole subtree.
  'SVG', 'MATH',
]);
const _ALLOWED_HTML_URL_ATTRS = new Set([
  'href', 'src', 'srcset', 'xlink:href', 'action', 'formaction', 'background', 'poster',
]);

function _compactUrlSchemeValue(value) {
  return String(value || '').replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').toLowerCase();
}

function _isDangerousUrl(value) {
  return /^(javascript|vbscript|data):/.test(_compactUrlSchemeValue(value));
}

function _isDangerousSrcset(value) {
  return String(value || '').split(',').some(candidate => _isDangerousUrl(candidate));
}

function _cleanAllowedHtmlOnce(htmlString) {
  const tpl = document.createElement('template');
  tpl.innerHTML = htmlString;
  for (const el of Array.from(tpl.content.querySelectorAll('*'))) {
    // 将标签转为大写进行比较：HTML tagName 是大写的
    // SVG/MathML 元素保留其原始（小写/驼峰）大小写，因此
    // 直接 `Set.has(el.tagName)` 会漏掉例如命名空间的 <script>。
    if (_ALLOWED_HTML_BAD_TAGS.has(el.tagName.toUpperCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      // 删除所有内联事件处理器（onerror、onclick、onmouseover 等）
      // 以及 srcdoc（无框架的脚本向量）。
      if (name.startsWith('on') || name === 'srcdoc') {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style') {
        const value = _compactUrlSchemeValue(attr.value);
        if (/javascript:|vbscript:|data:|expression\(/.test(value)) {
          el.removeAttribute(attr.name);
        }
        continue;
      }
      // 中和 URL 属性中的 javascript:/vbscript:/data: 协议。
      // 首先去除控制/空白字符，避免例如 `java\tscript:` 绕过去。
      if (_ALLOWED_HTML_URL_ATTRS.has(name)) {
        if (name === 'srcset' ? _isDangerousSrcset(attr.value) : _isDangerousUrl(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }
  return tpl.innerHTML;
}

function sanitizeAllowedHtml(html) {
  const raw = String(html == null ? '' : html);
  // 非浏览器上下文（例如未来的 SSR/Node 导入）：通过转义
  // 而非信任标记来安全关闭。
  if (typeof document === 'undefined') return escapeHtml(raw);

  // 清理到不动点。重新解析序列化输出可能会改变 DOM 树
  //（变异型 XSS 的基础），因此反复清理直到不再变化。
  let out = raw;
  for (let i = 0; i < 4; i++) {
    const next = _cleanAllowedHtmlOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * 检查文本是否有未关闭的 think 标签
 */
export function hasUnclosedThinkTag(text) {
  text = text || '';
  const openCount =
    (text.match(/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>/gi) || []).length
    + (text.match(/<\|channel>thought/gi) || []).length;
  const closeCount =
    (text.match(/<\/(?:think(?:ing)?|thought)>/gi) || []).length
    + (text.match(/<channel\|>/gi) || []).length;
  return openCount > closeCount;
}

export function startsWithReasoningPrefix(text) {
  return /^\s*(?:thinking(?:\s+process)?\s*:|the user |i need |i should |i will |they are |the question |i can )/i.test(text || '');
}

export function normalizeThinkingMarkup(text) {
  if (!text) return text;
  let normalized = text;
  normalized = normalized.replace(/<thought(\s+[^>]*)?>/gi, (_m, attrs = '') => `<think${attrs || ''}>`);
  normalized = normalized.replace(/<\/thought>/gi, '</think>');
  normalized = normalized.replace(/<\|channel>thought\s*\n?([\s\S]*?)<channel\|>\s*/gi, (_m, content = '') => {
    const thought = String(content || '').trim();
    return thought ? `<think>${thought}</think>\n` : '';
  });
  normalized = normalized.replace(/<\|channel>response\s*\n?([\s\S]*?)<channel\|>/gi, (_m, content = '') => content || '');
  normalized = normalized.replace(/<\|channel>response\s*\n?/gi, '');
  normalized = normalized.replace(/<channel\|>/gi, '');
  return normalized;
}

function normalizePlainThinking(text) {
  if (!text) return text;
  text = normalizeThinkingMarkup(text);
  if (/<think/i.test(text)) return text;

  const trimmed = text.trimStart();
  if (!startsWithReasoningPrefix(trimmed)) return text;

  const replyStarts = [
    'Hey', 'Hi ', 'Hi!', 'Hello', 'Sure', 'Yes', 'No ', 'No,', 'Yo', 'OK',
    'Here', 'Absolutely', 'Of course', 'Great', 'Alright', 'Thanks', 'Welcome',
    'Good ', "I'm happy", "I'd be"
  ];
  const prefixRegex = /^(thinking(?:\s+process)?\s*:)\s*/i;
  const escapedReplyStarts = replyStarts.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const boundaryRegex = new RegExp(
    `^([\\s\\S]*?)(\\n\\n(?=${escapedReplyStarts.join('|')}|I |What|Let|This |As ))[\\s\\S]*$`,
    'i'
  );
  const boundaryMatch = boundaryRegex.exec(trimmed);

  if (boundaryMatch) {
    const thinkBlock = boundaryMatch[1].replace(prefixRegex, '').trim();
    const reply = trimmed.slice(boundaryMatch[1].length).trimStart();
    if (thinkBlock && reply) return `<think>${thinkBlock}</think>\n\n${reply}`;
  }

  const lines = trimmed.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (replyStarts.some((prefix) => line.startsWith(prefix))) {
      const thinkBlock = lines.slice(0, index).join('\n').replace(prefixRegex, '').trim();
      const reply = lines.slice(index).join('\n').trim();
      if (thinkBlock && reply) return `<think>${thinkBlock}</think>\n${reply}`;
    }
  }

  const withoutPrefix = trimmed.replace(prefixRegex, '');
  for (const prefix of replyStarts) {
    const rx = new RegExp(`[.!?]\\s*(${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
    const match = rx.exec(withoutPrefix);
    if (match && match.index > 20) {
      const thinkBlock = withoutPrefix.slice(0, match.index + 1).trim();
      const reply = withoutPrefix.slice(match.index + 1).trim();
      if (thinkBlock && reply) return `<think>${thinkBlock}</think>\n${reply}`;
    }
  }

  return text;
}

/**
 * 提取所有完整的 thinking 块和剩余内容
 */
export function extractThinkingBlocks(text) {
  // 处理异常模式：<think></think>\n...实际思考内容...\n</think>
  // 某些模型会先输出一个空的 <think></think>，然后将思考内容放在外部，
  // 最后用第二个孤立的 </think> 关闭。
  let normalized = normalizePlainThinking(text);
  // 将 <think>short</think>...实际思考内容...</think> 合并为一个块
  // 模型有时会先输出一个简单块，然后继续在标签外思考
  normalized = normalized.replace(/<think(?:ing)?(?:\s+[^>]*)?>.{0,30}<\/think(?:ing)?>\s*([\s\S]*?)<\/think(?:ing)?>/gi, (m, content) => {
    return '<think>' + content.trim() + '</think>';
  });

  // 合并连续的 <think> 块（某些模型将思考内容分散到多个标签中）
  normalized = normalized.replace(/<\/think(?:ing)?>\s*<think(?:ing)?(?:\s+[^>]*)?>/gi, '\n\n');

  // 如果存在，提取 thinking 时间属性
  const timeMatch = normalized.match(/<think(?:ing)?\s+time="([\d.]+)"/i);
  const thinkingTime = timeMatch ? timeMatch[1] : null;
  // 为内容提取去除时间属性
  normalized = normalized.replace(/<think(?:ing)?\s+time="[\d.]+"/gi, '<think');

  const thinkRegex = /<think(?:ing)?(?:\s+[^>]*)?>([\s\S]*?)<\/think(?:ing)?>/gi;
  const thinkingBlocks = [];
  let match;

  // 提取所有完整的 thinking 块
  while ((match = thinkRegex.exec(normalized)) !== null) {
    const content = match[1].trim();
    if (content) thinkingBlocks.push(content);
  }

  // 移除所有完整的 <think>/<thinking> 块
  let cleanContent = normalized.replace(thinkRegex, '');

  // If there's an unclosed tag, decide between two cases:
  // (a) Stray opener at the very start with no real reply before it — typical
  //     of quantized models (MiniMax-AWQ) that emit a literal `<think>` token
  //     at the start of every reply without ever closing it. Strip just the
  //     opener and keep the body as the reply, otherwise the bubble looks
  //     blank on reload (the body was being treated as collapsed thinking).
  // (b) Cut-off mid-generation — there's already real reply text before the
  //     opener. Drop from the tag onward as before (it's truncated thinking).
  if (hasUnclosedThinkTag(normalized)) {
    const gemmaThoughtStart = cleanContent.search(/<\|channel>thought/i);
    if (gemmaThoughtStart >= 0) {
      const leakedThought = cleanContent
        .slice(gemmaThoughtStart)
        .replace(/^<\|channel>thought\s*\n?/i, '')
        .trim();
      if (gemmaThoughtStart === 0 && leakedThought) thinkingBlocks.push(leakedThought);
      cleanContent = cleanContent.slice(0, gemmaThoughtStart);
    } else {
      const strayOpener = cleanContent.match(/^\s*<think(?:ing)?(?:\s+[^>]*)?>([\s\S]*)$/i);
      if (strayOpener) {
        cleanContent = strayOpener[1];
      } else {
        cleanContent = cleanContent.replace(/<think(?:ing)?(?:\s+[^>]*)?>[\s\S]*$/gi, '');
      }
    }
  }

  // 处理孤儿 </think>（没有开始标签）——标签之前的文本是泄露的思考内容
  const orphanMatch = cleanContent.match(/^([\s\S]+?)<\/think(?:ing)?>/i);
  if (orphanMatch && orphanMatch[1].trim()) {
    thinkingBlocks.push(orphanMatch[1].trim());
    cleanContent = cleanContent.slice(orphanMatch[0].length);
  }

  // 去除剩余的所有孤儿关闭标签
  cleanContent = cleanContent.replace(/<\/think(?:ing)?>/gi, '');

  // 将所有 thinking 块合并为一个——没有必要显示多个下拉
  const mergedBlocks = thinkingBlocks.length > 1
    ? [thinkingBlocks.join('\n\n')]
    : thinkingBlocks;

  return {
    thinkingBlocks: mergedBlocks,
    content: cleanContent.trim(),
    thinkingTime,
  };
}

/**
 * 创建可折叠的 thinking 区域
 */
function createThinkingSection(thinkingContent, index = 0, thinkingTime = null) {
  const id = `thinking-${Date.now()}-${index}`;
  const timeHtml = thinkingTime ? `<span style="font-size:11px;opacity:0.4;font-variant-numeric:tabular-nums;">${thinkingTime}s</span>` : '';
  return `
    <div class="thinking-section">
      <div class="thinking-header" data-thinking-id="${id}">
        <div class="thinking-header-left">
          <span>View thinking process</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          ${timeHtml}
          <span class="thinking-toggle" id="${id}-toggle"></span>
        </div>
      </div>
      <div class="thinking-content" id="${id}">
        <div class="thinking-content-inner">
          ${mdToHtml(thinkingContent)}
        </div>
      </div>
    </div>
  `;
}

function createTaskCompletedMarker() {
  return `
    <div class="task-completed-marker" role="status" aria-label="Task completed">
      <span class="task-completed-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </span>
      <span>Task completed</span>
    </div>
  `;
}

/**
 * 处理文本并渲染带有 thinking 区域的内容
 */
// ── Emoji → 单色 SVG（OpenMoji-black，通过同源 /api/emoji 代理） ──
// 将彩色系统/Twemoji emoji 替换为与周围文字颜色一致的
// 单色线条图标（项目规则：永远不使用彩色 emoji）。操作在
// 已渲染的 HTML 上：仅处理标签外部的文本，跳过 <code>/<pre>。
const _EMOJI_RE = /\p{Extended_Pictographic}/u;
const _emojiSeg = (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function _emojiCodepoints(emoji) {
  // Twemoji 文件名规则：除非序列中有 ZWJ (U+200D)，否则去除 U+FE0F。
  const s = emoji.indexOf('‍') >= 0 ? emoji : emoji.replace(/️/g, '');
  const cps = [];
  for (const ch of s) { const c = ch.codePointAt(0); if (c) cps.push(c.toString(16)); }
  return cps.join('-');
}
function _emojiImg(emoji) {
  const code = _emojiCodepoints(emoji);
  if (!code) return emoji;
  // 单色线条图标：使用 OpenMoji 黑色 SVG 作为 CSS mask，
  // 填充色为周围文字颜色（currentColor），
  // 使 emoji 渲染为与主题一致的单一色调线条字形。
  // 如果代理无法提供字形，则返回透明 SVG，因此 mask 不显示任何内容。
  return `<span class="emoji" role="img" aria-label="${emoji}" style="--em:url('/api/emoji/${code}.svg')"></span>`;
}
function _svgifyText(text) {
  if (!_emojiSeg) return text;
  let out = '';
  for (const { segment } of _emojiSeg.segment(text)) {
    out += _EMOJI_RE.test(segment) ? _emojiImg(segment) : segment;
  }
  return out;
}
/** 当"仅文本 Emoji"开启时，保留 HTML 中的 Unicode 以便 deEmojify() 移除它们。 */
function _useSvgEmoji() {
  return typeof document === 'undefined' || !document.body?.classList.contains('text-emojis');
}

// `opts.shortcodes`（默认 true）控制 issue-#345 的 `:name:` → emoji 展开。
// 聊天中传入 true；文档/邮件正文渲染器中传入 false，
// 使作者输入的 `:shortcode:` 文本保持原样（参见 mdToHtml 调用处）。
// 无论是否启用 shortcodes，Unicode emoji → 单色 SVG 的转换始终执行，
// 因此文档中的真实 😀 仍然会渲染为像之前一样的主题线条图标。
export function svgifyEmoji(html, opts) {
  if (!_useSvgEmoji() || !html) return html;
  const allowShortcodes = !opts || opts.shortcodes !== false;
  // 遍历 HTML 有两个原因：将真实的 Unicode emoji 转为 SVG 图标，
  // 或者处理模型输出的 `:shortcode:` 短代码文本（issue #345）。
  const hasUnicode = _EMOJI_RE.test(html);
  const hasShortcode = allowShortcodes && hasEmojiShortcode(html);
  if (!hasUnicode && !hasShortcode) return html;
  const parts = html.split(/(<[^>]*>)/);   // 奇数索引 = 标签
  let codeDepth = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const t = parts[i].toLowerCase();
      if (/^<(pre|code)[\s>]/.test(t)) codeDepth++;
      else if (/^<\/(pre|code)\s*>/.test(t)) codeDepth = Math.max(0, codeDepth - 1);
      continue;
    }
    if (codeDepth !== 0) continue;
    let seg = parts[i];
    // 先将短代码展开为 Unicode，然后它们和已存在的 Unicode emoji
    // 一起被渲染为相同的单色线条图标。
    if (hasShortcode) seg = replaceEmojiShortcodes(seg);
    if (_EMOJI_RE.test(seg)) seg = _svgifyText(seg);
    parts[i] = seg;
  }
  return parts.join('');
}
/**
 * 通用可折叠区域，复用 thinking 下拉框的样式和
 * 委托切换（任何 `.thinking-header[data-thinking-id]`）。
 * 标签通过 data-label 属性驱动 "查看 <label>" / "隐藏 <label>" 文本。
 * 例如用于用户照片消息上的视觉模型图像描述。
 */
export function createCollapsible(contentMarkdown, label = 'details') {
  const id = `collapse-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const safeLabel = escapeHtml(label);
  return `
    <div class="thinking-section">
      <div class="thinking-header" data-thinking-id="${id}">
        <div class="thinking-header-left"><span data-label="${safeLabel}">View ${safeLabel}</span></div>
        <div style="display:flex;align-items:center;gap:6px;"><span class="thinking-toggle" id="${id}-toggle"></span></div>
      </div>
      <div class="thinking-content" id="${id}"><div class="thinking-content-inner">${mdToHtml(contentMarkdown)}</div></div>
    </div>`;
}

export function processWithThinking(text) {
  const { thinkingBlocks, content, thinkingTime } = extractThinkingBlocks(text);

  let html = '';
  let visibleContent = content || '';
  const doneOnly = /^\s*\[DONE\]\s*$/i.test(visibleContent);
  const hadTrailingDone = !doneOnly && /(?:^|\n)\s*\[DONE\]\s*$/i.test(visibleContent);

  // 添加 thinking 区域（默认折叠）
  thinkingBlocks.forEach((block, index) => {
    html += createThinkingSection(block, index, thinkingTime);
  });

  // 添加实际内容
  if (doneOnly) {
    html += createTaskCompletedMarker();
  } else {
    if (hadTrailingDone) visibleContent = visibleContent.replace(/\n?\s*\[DONE\]\s*$/i, '').trimEnd();
    if (visibleContent) html += mdToHtml(visibleContent);
    if (hadTrailingDone) html += createTaskCompletedMarker();
  }

  return _useSvgEmoji() ? svgifyEmoji(html) : html;
}

/**
 * 将 Markdown 转换为 HTML
 */
export function mdToHtml(src, opts) {
  const allowedHtmlBlocks = [];
  const codeBlocks = [];
  const mermaidBlocks = [];
  let s = (src ?? '');

  // Extract fenced code blocks before any markdown/HTML preservation passes.
  // Otherwise placeholders from the allowed-HTML sanitizer (e.g.
  // ___ALLOWED_HTML_0___）可能泄漏到引用的 HTML/JS 示例中，
  // placeholder gets captured as literal code content and never restored inside
  // the final <pre><code> block.
  s = s.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const cleaned = code
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/^\s*\n+/, '')
      .replace(/\n+\s*$/g, '');

    // Mermaid 图表：渲染为图表而非代码块
    if (lang && lang.toLowerCase() === 'mermaid') {
      const mermaidId = 'mermaid-' + Date.now() + '-' + mermaidBlocks.length;
      const raw = cleaned.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const placeholder = `___MERMAID_BLOCK_${mermaidBlocks.length}___`;
      mermaidBlocks.push(`<div class="mermaid-container"><pre class="mermaid" id="${mermaidId}">${escapeHtml(raw)}</pre></div>`);
      return placeholder;
    }

    const escaped = cleaned.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const placeholder = `___CODE_BLOCK_${codeBlocks.length}___`;

    const langClass = lang ? ` class="language-${lang}"` : '';
    const runnableLangs = ['python','py','javascript','js','html','bash','sh','shell','zsh'];
    const runBtn = (lang && runnableLangs.includes(lang.toLowerCase()))
      ? `<button type="button" class="run-code" data-code="${escapeHtml(escaped)}" data-lang="${lang}" title="Run code"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>`
      : '';
    const editBtn = `<button type="button" class="edit-code" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`;
    codeBlocks.push(`<pre><code${langClass} data-lang="${lang || ''}">${escapeHtml(escaped)}</code>${runBtn}${editBtn}<button type="button" class="copy-code" data-code="${escapeHtml(escaped)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></pre>`);

    return placeholder;
  });

  // Repair common ways the agent mangles the entity-anchor convention
  // (`[Name](#kind-<id>)`). Models reliably get the single-link case
  // right but slip into other formats when listing many in a table.
  // These regexes upgrade the broken forms to proper markdown links so
  // the standard `[text](url)` handler below picks them up.
  const ANCHOR_KIND = '(?:session|document|note|image|email|event|task|skill|research)';
  // 情况 A：`[Name] [#kind-id]` — agent 将 URL 放在方括号中，通常
  // 在标签旁边的表格单元格中。将它们配对。
  s = s.replace(
    new RegExp(`\\[([^\\]\\n]+?)\\]\\s*\\[#(${ANCHOR_KIND}-[A-Za-z0-9_-]+)\\]`, 'g'),
    '[$1](#$2)',
  );
  // 情况 B：单独的 `[#kind-id]` 没有前面的标签——给它一个
  // 通用的"→ 打开"链接文本以便仍然渲染为按钮。
  s = s.replace(
    new RegExp(`\\[#(${ANCHOR_KIND}-[A-Za-z0-9_-]+)\\]`, 'g'),
    '[→ open](#$1)',
  );
  // 情况 C：纯文本中的 `#kind-id`——仅在以单词边界分隔
  // 且未处于 markdown 链接或锚点语法中时生效。
  // 使用后顾断言 `](` 或 `[` 跳过这些情况。
  s = s.replace(
    new RegExp(`(^|[^\\[(])#(${ANCHOR_KIND}-[A-Za-z0-9_-]+)\\b`, 'g'),
    '$1[#$2](#$2)',
  );

  // 将 markdown 链接 [text](url) 转换为可点击链接
  // 内部 #hash 链接在页面内导航；外部链接在新标签页中打开
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    return linkHtml(text, url);
  });

  // 自动链接裸 URL（http/https）。跳过已在 <a> 标签内的 URL
  //（由上方 markdown 链接替换生成）以及反引号中的 URL。
  s = s.replace(
    /(^|[\s(<])(https?:\/\/[^\s<>"'`\]]+[^\s<>"'`\].,;:!?])/g,
    (match, prefix, url) => `${prefix}${linkHtml(url, url)}`
  );

  // 自动链接模型经常以纯文本输出的无协议域名
  //（例如 "techcrunch.com/ai"、"perplexity.ai"、"www.wired.com"）。TLD 白名单
  // 防止匹配文件名/版本号（"package.json"、"node.js"、"v1.2.3"）；
  // 要求的开头 /[\s(<] 前缀意味着已在 http 链接中（前面有 "//"）
  // 或电子邮件中（前面有 "@"）的域名会被跳过。
  // 要求 TLD 以真实的域名边界结束，这样点分隔的代码标识符如
  // `sklearn.metrics` 不会链接到 `sklearn.me` 并在剩余文本中留下
  // 占位符片段。
  s = s.replace(
    /(^|[\s(<])((?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|co|dev|app|gov|edu|news|info|tech|xyz|me)(?=$|[\/\s<>"'`\]).,;:!?])(?:\/[^\s<>"'`\])]*)?)/gi,
    (match, prefix, domain) => {
      const trail = (domain.match(/[.,;:!?)]+$/) || [''])[0];
      const core = trail ? domain.slice(0, -trail.length) : domain;
      return `${prefix}${linkHtml(core, 'https://' + core)}${trail}`;
    }
  );

  // 提取 <details>...</details> 块并替换为占位符
  // 默认展开以便 agent 输出可见
  s = s.replace(/<details>([\s\S]*?)<\/details>/gi, (match) => {
    const placeholder = `___ALLOWED_HTML_${allowedHtmlBlocks.length}___`;
    allowedHtmlBlocks.push(sanitizeAllowedHtml(match.replace(/<details>/i, '<details open>')));
    return placeholder;
  });

  // 同样保留 <a> 标签（它们现在已经由 markdown 转换存在于 HTML 中）
  s = s.replace(/<a\s+[^>]*>.*?<\/a>/gi, (match) => {
    const placeholder = `___ALLOWED_HTML_${allowedHtmlBlocks.length}___`;
    allowedHtmlBlocks.push(sanitizeAllowedHtml(match));
    return placeholder;
  });

  // 现在转义其他所有内容
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  s = s.replace(/\n{3,}/g, '\n\n');

  // KaTeX 数学公式渲染（在代码块提取之后进行，确保代码中的数学公式安全）
  const mathBlocks = [];
  if (window.katex) {
    // 显示数学：\[ ... \] — GPT 风格分隔符（gpt-5.x、Claude 等）。
    // 在 $$ / $ 之前处理，使所有常用分隔符都能渲染。
    s = s.replace(/\\\[([\s\S]*?)\\\]/g, (match, math) => {
      try {
        const raw = math.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const placeholder = `___MATH_BLOCK_${mathBlocks.length}___`;
        mathBlocks.push(katex.renderToString(raw.trim(), { displayMode: true, throwOnError: false }));
        return placeholder;
      } catch (e) { return match; }
    });
    // 行内数学：\( ... \) — GPT 风格行内分隔符。仅限单行
    //（[^\n]），避免行文中孤立的转义括号跨行吞噬内容。
    s = s.replace(/\\\(([^\n]*?)\\\)/g, (match, math) => {
      try {
        const raw = math.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const placeholder = `___MATH_BLOCK_${mathBlocks.length}___`;
        mathBlocks.push(katex.renderToString(raw.trim(), { displayMode: false, throwOnError: false }));
        return placeholder;
      } catch (e) { return match; }
    });
    // 显示数学：$$...$$
    s = s.replace(/\$\$([\s\S]*?)\$\$/g, (match, math) => {
      try {
        const raw = math.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const placeholder = `___MATH_BLOCK_${mathBlocks.length}___`;
        mathBlocks.push(katex.renderToString(raw.trim(), { displayMode: true, throwOnError: false }));
        return placeholder;
      } catch (e) { return match; }
    });
    // 行内数学：$...$（前后不是 $ 或数字，不跨多行）
    s = s.replace(/(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g, (match, math) => {
      try {
        const raw = math.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const placeholder = `___MATH_BLOCK_${mathBlocks.length}___`;
        mathBlocks.push(katex.renderToString(raw.trim(), { displayMode: false, throwOnError: false }));
        return placeholder;
      } catch (e) { return match; }
    });
  }

  // 处理管道表格
  s = s.replace(/(?:^|\n)([^\n]*\|[^\n]*\|[^\n]*)(?:\n([^\n]*\|[^\n]*\|[^\n]*))*/g, (table) => {
    if (table.includes('___CODE_BLOCK_') || table.includes('___ALLOWED_HTML_')) return table;

    const rows = table.trim().split('\n');
    if (rows.length < 2) return table;

    let html = '<table style="border-collapse: collapse; width: 100%; margin: 10px 0;">';

    rows.forEach((row, idx) => {
      if (idx === 1 && /^[\s|:\-]+$/.test(row)) {
        html += '<tbody>';
        return;
      }
      const cells = splitTableRow(row);
      if (cells.length === 0) return;

      html += '<tr>';

      cells.forEach(cell => {
        const tag = idx === 0 ? 'th' : 'td';
        html += `<${tag} style="padding: 8px; text-align: left; border-bottom: 1px solid var(--border);">${cell.trim()}</${tag}>`;
      });

      html += '</tr>';
    });

    html += '</tbody></table>';
    return html;
  });

  // 行内代码（但不包括占位符）
  s = s.replace(/`([^`]+?)`/g, (match, code) => {
    if (code.startsWith('___CODE_BLOCK_') || code.startsWith('___ALLOWED_HTML_')) return match;
    return `<code>${code}</code>`;
  });

  // 水平线（必须在粗体/斜体之前，避免 * 冲突）
  s = s.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr>');

  // 粗体、斜体、删除线
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 标题
  s = s.replace(/^###### (.*)$/gm, '<h6>$1</h6>')
       .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
       .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
       .replace(/^### (.*)$/gm, '<h3>$1</h3>')
       .replace(/^## (.*)$/gm, '<h2>$1</h2>')
       .replace(/^# (.*)$/gm, '<h1>$1</h1>');

  // 有序列表（1. 2. 3. 等）
  s = s.replace(/^(\d+)\. (.*)$/gm, '<oli>$2</oli>');
  s = s.replace(/(?:^|\n)(<oli>[\s\S]*?)(?=\n(?!<oli>)|$)/g, m => `<ol>${m.trim().replace(/<\/?oli>/g, (t) => t === '<oli>' ? '<li>' : '</li>')}</ol>`);

  // GitHub 风格任务列表（- [ ] / - [x]）→ 复选框项。必须在通用
  // 无序列表规则之前运行，以免 "- " 前缀被先消费。
  // 输出 <uli>（带 class），使下面的无序列表包装器将其视为
  // 列表项。由计划模式使用：计划 + 进度渲染为清单。
  s = s.replace(/^(?:- |\* )\[([ xX])\] (.*)$/gm, (_m, mark, text) => {
    const done = mark.toLowerCase() === 'x';
    return `<uli class="task-item${done ? ' task-done' : ''}"><span class="task-check" aria-hidden="true"></span><span class="task-text">${text}</span></uli>`;
  });

  // 无序列表。<uli> 可以携带属性（task-item class），因此
  // 包装器在转换 <uli ...> → <li ...> 时会保留它们。
  s = s.replace(/^(?:- |\* )(.*)$/gm, '<uli>$1</uli>');
  s = s.replace(/(^|\n)((?:<uli\b[^>]*>[^\n]*<\/uli>(?:\n|$))+)/g, (_, prefix, block) =>
    `${prefix}<ul>${block.trim().replace(/<uli\b([^>]*)>/g, '<li$1>').replace(/<\/uli>/g, '</li>')}</ul>`);

  // 引用块
  s = s.replace(/^&gt; (.*)$/gm, '<bq>$1</bq>');
  s = s.replace(/(?:^|\n)(<bq>[\s\S]*?)(?=\n(?!<bq>)|$)/g, m =>
    `<blockquote>${m.trim().replace(/<\/?bq>/g, (t) => t === '<bq>' ? '<p>' : '</p>')}</blockquote>`);

  // 段落——但不包括代码块占位符或允许的 HTML
  s = s.replace(/^(?!<h\d|<ul>|<ol>|<li|<oli>|<\/li>|<pre>|<blockquote>|<bq>|<hr>|___CODE_BLOCK_|___ALLOWED_HTML_|___MATH_BLOCK_|___MERMAID_BLOCK_)([^\n]+)$/gm, '<p>$1</p>');

  // 段落内的换行
  s = s.replace(/<p>([\s\S]*?)<\/p>/g, (match, content) => {
    if (content.includes('___CODE_BLOCK_') || content.includes('___ALLOWED_HTML_') || content.includes('___MATH_BLOCK_') || content.includes('___MERMAID_BLOCK_')) return match;
    const withLineBreaks = content.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
    return `<p>${withLineBreaks}</p>`;
  });

  // 移除空段落
  s = s.replace(/<p><\/p>/g, '');

  // 关键：首先恢复允许的 HTML 块
  allowedHtmlBlocks.forEach((block, index) => {
    s = s.replace(`___ALLOWED_HTML_${index}___`, block);
  });

  // 恢复数学块
  mathBlocks.forEach((block, index) => {
    s = s.replace(`___MATH_BLOCK_${index}___`, block);
  });

  // 恢复 mermaid 图表块
  mermaidBlocks.forEach((block, index) => {
    s = s.replace(`___MERMAID_BLOCK_${index}___`, block);
  });

  // 关键：最后恢复代码块
  codeBlocks.forEach((block, index) => {
    s = s.replace(`___CODE_BLOCK_${index}___`, block);
  });

  return _useSvgEmoji() ? svgifyEmoji(s, opts) : s;
}

/**
 * 减少代码块外部的多余空白
 */
export function squashOutsideCode(s) {
  if (!s) return "";
  const parts = String(s).split(/```/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }
  return parts.join('```');
}

/**
 * 渲染可能是文本或内容块数组的内容
 */
export function renderContent(content) {
  if (Array.isArray(content)) {
    const texts = [];
    for (const blk of content) {
      if (blk.type === 'text') texts.push(blk.text);
      else if (blk.type === 'image_url') texts.push('[image]');
    }
    return texts.join('\n');
  }
  return content;
}

/**
 * 初始化容器（或整个文档）中未处理的 Mermaid 图表
 */
export function renderMermaid(container) {
  if (!window.mermaid) return;
  initMermaid();
  const target = container || document;
  const pending = target.querySelectorAll('pre.mermaid:not([data-processed])');
  if (pending.length === 0) return;
  try {
    window.mermaid.run({ nodes: pending });
  } catch (e) {
    console.warn('Mermaid render error:', e);
  }
}

const markdownModule = {
  escapeHtml,
  mdToHtml,
  squashOutsideCode,
  renderContent,
  processWithThinking,
  createCollapsible,
  hasUnclosedThinkTag,
  extractThinkingBlocks,
  normalizeThinkingMarkup,
  startsWithReasoningPrefix,
  renderMermaid
};

export default markdownModule;

// Mermaid 是异步加载的，因此不会延迟应用框架渲染。
function initMermaid() {
  if (!window.mermaid || window.__odysseusMermaidReady) return;
  window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
  window.__odysseusMermaidReady = true;
}
window.odysseusInitMermaid = initMermaid;
initMermaid();

// 跨页面刷新持久化哪些 thinking 区域已被展开。
// ID 是渲染时生成的（基于 Date.now），因此我们使用内部文本内容的
// 稳定哈希作为键——相同的内容在重新加载时会得到相同的哈希。
// localStorage 保存展开哈希的 Set；我们监听聊天历史的变化，
// 在插入匹配的区域时重新展开它们。
const THINK_EXPANDED_KEY = 'odysseus-thinking-expanded';
function _loadExpandedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(THINK_EXPANDED_KEY) || '[]')); }
  catch { return new Set(); }
}
function _saveExpandedSet(set) {
  try {
    const arr = [...set];
    // 限制存储增长——保留最近的 200 条记录。
    if (arr.length > 200) arr.splice(0, arr.length - 200);
    localStorage.setItem(THINK_EXPANDED_KEY, JSON.stringify(arr));
  } catch {}
}
function _hashThinkingContent(el) {
  if (!el) return '';
  const text = (el.textContent || '').trim();
  if (!text) return '';
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return String(h);
}
function _setThinkingExpanded(content, toggle, header, expanded) {
  if (!content || !toggle) return;
  content.classList.toggle('expanded', expanded);
  toggle.classList.toggle('expanded', expanded);
  const label_el = header?.querySelector('.thinking-header-left span');
  if (label_el) {
    const label = label_el.dataset.label || 'thinking process';
    label_el.textContent = expanded ? `Hide ${label}` : t('markdown.view_label', { label: label });
  }
}

// 委托的 thinking 切换点击处理器（CSP 安全，无内联 onclick）
document.addEventListener('click', function(e) {
  const header = e.target.closest('.thinking-header[data-thinking-id]');
  if (!header) return;
  const id = header.dataset.thinkingId;
  const content = document.getElementById(id);
  const toggle = document.getElementById(id + '-toggle');
  if (!content || !toggle) return;

  const willExpand = !content.classList.contains('expanded');
  _setThinkingExpanded(content, toggle, header, willExpand);

  // 通过内容哈希持久化，使选择在刷新后仍然有效。
  const hash = _hashThinkingContent(content);
  if (!hash) return;
  const set = _loadExpandedSet();
  if (willExpand) set.add(hash);
  else set.delete(hash);
  _saveExpandedSet(set);
});

// 观察聊天历史；当 thinking 区域出现时，如果其哈希与用户之前
// 展开的哈希匹配，则将其展开。
(function _watchThinking() {
  if (window._thinkingWatcherWired) return;
  window._thinkingWatcherWired = true;
  const _apply = (root) => {
    if (!root || !root.querySelectorAll) return;
    const sections = root.matches?.('.thinking-section')
      ? [root]
      : [...root.querySelectorAll('.thinking-section')];
    if (!sections.length) return;
    const set = _loadExpandedSet();
    if (!set.size) return;
    for (const sec of sections) {
      const content = sec.querySelector('.thinking-content');
      if (!content) continue;
      if (content.classList.contains('expanded')) continue;
      const hash = _hashThinkingContent(content);
      if (!hash || !set.has(hash)) continue;
      const header = sec.querySelector('.thinking-header[data-thinking-id]');
      const id = header?.dataset.thinkingId;
      const toggle = id ? document.getElementById(id + '-toggle') : null;
      _setThinkingExpanded(content, toggle, header, true);
    }
  };
  const start = () => {
    const root = document.body;
    if (!root) return;
    _apply(root);
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) _apply(node);
        }
      }
    }).observe(root, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

function _endpointNameFromUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.host || parsed.hostname || 'Model endpoint';
  } catch (_) {
    return 'Model endpoint';
  }
}

function _appendEndpointAddButtons(root) {
  if (!root || !root.querySelectorAll) return;
  const anchors = root.matches?.('a[href]')
    ? [root]
    : [...root.querySelectorAll('a[href]')];
  for (const anchor of anchors) {
    if (anchor.dataset.endpointAddChecked === '1') continue;
    anchor.dataset.endpointAddChecked = '1';
    const href = anchor.getAttribute('href') || '';
    if (!_isModelEndpointUrl(href)) continue;
    if (anchor.nextElementSibling?.classList?.contains('model-endpoint-add-btn')) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-endpoint-add-btn';
    btn.dataset.endpointUrl = new URL(href, window.location.origin).href.replace(/\/+$/, '');
    btn.title = 'Add this OpenAI-compatible endpoint to the model picker';
    btn.innerHTML = '<span aria-hidden="true">+</span><span>Add to model picker</span>';
    anchor.insertAdjacentElement('afterend', btn);
  }
}

async function _registerEndpointFromButton(btn) {
  const baseUrl = String(btn?.dataset?.endpointUrl || '').trim();
  if (!baseUrl || !_isModelEndpointUrl(baseUrl)) return;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span aria-hidden="true">...</span><span>Adding</span>';
  try {
    const existingRes = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
    if (existingRes.ok) {
      const endpoints = await existingRes.json();
      const existing = Array.isArray(endpoints)
        ? endpoints.find((ep) => String(ep.base_url || '').replace(/\/+$/, '') === baseUrl)
        : null;
      if (existing) {
        btn.classList.add('added');
        btn.innerHTML = '<span aria-hidden="true">✓</span><span>Already added</span>';
        window.dispatchEvent(new CustomEvent('ge:model-endpoints-updated', { detail: { baseUrl } }));
        if (window.modelsModule?.refreshModels) window.modelsModule.refreshModels(true);
        if (window.sessionModule?.updateModelPicker) window.sessionModule.updateModelPicker();
        uiModule.showToast?.(t('markdown.already_in_picker', { name: existing.name || _endpointNameFromUrl(baseUrl) }));
        return;
      }
    }

    const parsed = new URL(baseUrl, window.location.origin);
    const fd = new FormData();
    fd.append('base_url', baseUrl);
    fd.append('name', _endpointNameFromUrl(baseUrl));
    fd.append('model_type', 'llm');
    fd.append('endpoint_kind', 'auto');
    fd.append('skip_probe', 'true');
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(parsed.hostname)) {
      fd.append('container_local', 'true');
    }
    const res = await fetch('/api/model-endpoints', {
      method: 'POST',
      credentials: 'same-origin',
      body: fd,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(t('markdown.http_error', { status: res.status }) + (body ? ': ' + body.slice(0, 160) : ''));
    }
    btn.classList.add('added');
    btn.innerHTML = '<span aria-hidden="true">✓</span><span>Added</span>';
    window.dispatchEvent(new CustomEvent('ge:model-endpoints-updated', { detail: { baseUrl } }));
    if (window.modelsModule?.refreshModels) await window.modelsModule.refreshModels(true);
    if (window.sessionModule?.updateModelPicker) window.sessionModule.updateModelPicker();
    uiModule.showToast?.(t('markdown.endpoint_added', { name: _endpointNameFromUrl(baseUrl) }));
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = original;
    uiModule.showError?.(t('markdown.add_endpoint_failed', { msg: err.message || err }));
  }
}

(function _watchModelEndpointLinks() {
  if (window._modelEndpointLinkWatcherWired) return;
  window._modelEndpointLinkWatcherWired = true;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.model-endpoint-add-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    _registerEndpointFromButton(btn);
  });

  const start = () => {
    const root = document.body;
    if (!root) return;
    _appendEndpointAddButtons(root);
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) _appendEndpointAddButtons(node);
        }
      }
    }).observe(root, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
