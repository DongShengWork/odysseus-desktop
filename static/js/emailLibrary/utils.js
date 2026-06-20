// static/js/emailLibrary/utils.js
//
// 从 emailLibrary.js 中提取的纯函数辅助工具。无 DOM 状态、无 fetch、
// 无共享可变引用 — 可安全导入任何地方。

// ── 受 Talon 启发的多语言引用检测正则表达式 ───────────
// （大致）借鉴自 Mailgun 的 `talon` 库。这些是部分正则源码字符串 —
// 调用方将它们与周围的模式组合使用。
// 刻意支持多语言：输入的 "wrote:" 行具有区域限定性，而且人们经常
// 跨语言设置转发/回复邮件。

export const _TALON_WROTE = '(?:wrote|écrit|escribió|scrisse|schrieb|skrev|schreef|napisał|написал|napsal|написа|έγραψε|katselivat|napisao|написав|napisała|napisali|hat geschrieben|kirjoitti|написала|escreveu|napisao|написа|написала)';

export const _TALON_FROM = '(?:From|Från|Von|De|Da|От|Od|Van|差出人|发件人|寄件人|Ut|Frá|Lähettäjä|Avsender|Pošiljatelj|Од|Від|Posiljatelj|Frå)';
export const _TALON_SENT = '(?:Sent|Skickat|Gesendet|Envoy[ée]|Inviato|Enviado|Verzonden|Отправлено|Wysłane|Date|送信日時|发送时间|寄件日期|Sendt|Lähetetty|Tarih|Datum|Data|Datum)';
export const _TALON_SUBJ = '(?:Subject|Ämne|Betreff|Objet|Oggetto|Asunto|Onderwerp|Тема|Temat|件名|主题|主旨|Emne|Aihe|Onderwerp|Konu)';
export const _TALON_TO   = '(?:To|Till|An|À|A|Voor|Para|Naar|Кому|Do|宛先|收件人|Emri|Komu)';
export const _TALON_ORIG_RE = /(?:^|\n)[\s>]*[-_=]{3,}\s*(?:Original\s+Message|Forwarded\s+message|Ursprüngliche\s+Nachricht|Mensaje\s+original|Messaggio\s+originale|Message\s+d['’]origine|Oorspronkelijk\s+bericht|Original\s+meddelande|Vor[ ]asal[a]\s+meddelande|原文|原始邮件|転送)\s*[-_=]{3,}/i;

// 最小纯文本长度，达到此长度的"签名"才会被折叠。
// 简短的落款（"Cheers, John"）保持内联 — 折叠只会为
// 短短几个字增加一个点击操作。
export const _SIG_BLOAT_MIN_CHARS = 200;

// 通过 detached div 来回传值来 HTML 转义字符串。
// 简单且正确（处理 innerHTML 所需的所有实体）。
export function _esc(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function _attrEsc(text) {
  return String(text ?? '')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;');
}

function _compactUrlSchemeValue(value) {
  return String(value || '').replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').toLowerCase();
}

function _isDangerousUrl(value) {
  const compact = _compactUrlSchemeValue(value);
  return compact.startsWith('javascript:') || compact.startsWith('vbscript:') || compact.startsWith('data:');
}

function _isDangerousSrcset(value) {
  return String(value || '').split(',').some(candidate => _isDangerousUrl(candidate));
}

// 转义并链接化 URL 和电子邮件地址。返回 innerHTML 安全的标记。
export function _escLinkify(text) {
  const escaped = _esc(text);
  // URL: http(s)://... 或 www....
  const urlRe = /\b((?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;
  const mailRe = /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
  return escaped
    .replace(urlRe, (m) => {
      const href = m.startsWith('www.') ? `https://${m}` : m;
      return `<a href="${_attrEsc(href)}" target="_blank" rel="noopener noreferrer">${m}</a>`;
    })
    .replace(mailRe, (m) => `<a href="${_attrEsc(`mailto:${m}`)}">${m}</a>`);
}

// 从 "Name <email@x>" 中提取显示名称；回退到邮件的本地部分；
// 最终回退到输入字符串。
export function _extractName(addr) {
  const m = addr.match(/^"?([^"<]+?)"?\s*<([^>]+)>\s*$/);
  if (m) return m[1].trim();
  const localPart = addr.split('@')[0];
  return localPart || addr;
}

// Parse the "Author <email> · Date" metadata string emitted by the
// server-side thread parser.
export function _parseTurnMeta(meta) {
  if (!meta) return { author: '', email: '', date: '' };
  const m = String(meta);
  const eMatch = m.match(/<([^<>\s]+@[^<>\s]+)>/) ||
                 m.match(/\b([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})\b/);
  const email = eMatch ? eMatch[1].toLowerCase().trim() : '';
  const parts = m.split(/\s+[·•]\s+/);
  let author = '', date = '';
  if (parts.length >= 2) {
    author = parts[0].replace(/<[^>]+>/g, '').trim();
    date = parts.slice(1).join(' · ').trim();
  } else {
    author = m.replace(/<[^>]+>/g, '').trim();
  }
  return { author, email, date };
}

// 聊天气泡时间戳的简短、区域感知显示字符串。
// 对无效/空输入返回 ''。
export function _formatBubbleDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!d || isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return ''; }
}

// 将原始 "to" 地址字符串（"Foo <foo@x.com>, bar@y.com"）格式化为
// 简短、可读的列表 — 有显示名称时使用显示名称，否则只显示邮箱的本地部分，
// 超过 2 个收件人时显示 ", +N"。
export function _formatRecipients(raw) {
  if (!raw) return '';
  const addrs = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  if (!addrs.length) return '';
  const friendly = addrs.map(a => {
    const m = a.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
    if (m && m[1].trim()) return m[1].trim();
    const em = a.replace(/[<>]/g, '').trim();
    return em.split('@')[0] || em;
  });
  if (friendly.length === 1) return friendly[0];
  if (friendly.length === 2) return friendly.join(', ');
  return friendly.slice(0, 2).join(', ') + ' +' + (friendly.length - 2);
}

// Deterministic per-sender colour. Same hashing as
// emailInbox.js#_senderColor so a sender's avatar / name colour matches
// across the list view and the bubble reader.
export function _senderColor(name) {
  if (!name) return 'hsl(220, 55%, 65%)';
  const key = String(name).toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 65%)`;
}

// 头像气泡的 1-2 个字母缩写，支持 Unicode。
export function _initials(s) {
  if (!s) return '?';
  const clean = String(s).replace(/<[^>]+>/g, '').replace(/[^\p{L}\s]/gu, ' ').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// 用于渲染远程邮件正文的 HTML 消毒器。剥离 script/iframe/
// form/style/ 等标签，清除 `on*` 处理器，阻止所有已知 URL 属性上的
// `javascript:`/`vbscript:`/`data:` URL，清除内联颜色/字体/
// 位置样式以便主题可以接管显示，并将带有高亮背景的内联标签
// 包裹在 <mark> 中，使其在不同主题下清晰可见。
function _sanitizeHtmlOnce(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(
    'script, iframe, object, embed, form, style, link, ' +
    'svg, math, base, meta, noscript, frame, frameset, applet, portal'
  ).forEach(el => el.remove());

  const URL_ATTRS = ['href', 'src', 'xlink:href', 'srcset', 'action', 'formaction', 'background', 'poster', 'data'];

  const STRIP_CSS_PROPS = ['color', 'background', 'background-color',
                           'font-family', 'font', '-webkit-text-fill-color',
                           'position', 'z-index'];
  const HIGHLIGHT_INLINE_TAGS = new Set(['SPAN', 'FONT', 'EM', 'B', 'I',
                                         'STRONG', 'SMALL', 'U']);
  const HAS_BG_COLOR = /background(?:-color)?\s*:\s*(?!\s*(?:transparent|none|inherit|initial)\b)[^;]+/i;
  const _markedForHighlight = [];

  doc.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
      if (name === 'srcdoc') { el.removeAttribute(attr.name); continue; }
      if (URL_ATTRS.includes(name) && (name === 'srcset' ? _isDangerousSrcset(attr.value) : _isDangerousUrl(attr.value))) {
        el.removeAttribute(attr.name);
        continue;
      }
    }
    el.removeAttribute('color');
    const bgcolor = el.getAttribute('bgcolor');
    el.removeAttribute('bgcolor');
    el.removeAttribute('face');
    const style = el.getAttribute('style');
    const hadHighlight =
      HIGHLIGHT_INLINE_TAGS.has(el.tagName) &&
      ((style && HAS_BG_COLOR.test(style)) || (bgcolor && bgcolor !== 'transparent'));
    if (hadHighlight) _markedForHighlight.push(el);
    if (style) {
      const kept = style.split(';').map(s => s.trim()).filter(decl => {
        if (!decl) return false;
        const lower = _compactUrlSchemeValue(decl);
        if (lower.includes('javascript:') || lower.includes('vbscript:') || lower.includes('data:') || lower.includes('expression(')) return false;
        const prop = decl.split(':', 1)[0].trim().toLowerCase();
        return !STRIP_CSS_PROPS.includes(prop);
      });
      if (kept.length) el.setAttribute('style', kept.join('; '));
      else el.removeAttribute('style');
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });

  _markedForHighlight.forEach(el => {
    if (el.tagName === 'MARK' || !el.firstChild) return;
    const mark = doc.createElement('mark');
    while (el.firstChild) mark.appendChild(el.firstChild);
    el.appendChild(mark);
  });

  return doc.body.innerHTML;
}

export function _sanitizeHtml(html) {
  let out = String(html ?? '');
  for (let i = 0; i < 4; i++) {
    const next = _sanitizeHtmlOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}
