// static/js/censor.js
/**
 * 敏感信息审查模块
 * 检测聊天回复中的邮箱、密码、API 密钥、令牌等敏感信息
 * 并将其模糊处理。点击可逐个显示。
 */

let _enabled = true;
let _observer = null;
const PREF_KEY = 'odysseus-sensitive-blur';
export const _prefEnabled = () => {
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch (_) {
    return false;
  }
};

// 可能表示敏感数据的正则模式
const PATTERNS = [
  // 邮箱地址
  { re: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g, label: 'email' },
  // API 密钥前缀（常见服务）
  { re: /\b(sk-[a-zA-Z0-9]{20,}|pk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|glpat-[a-zA-Z0-9\-_]{20,}|xox[bpras]-[a-zA-Z0-9\-]{10,}|npm_[a-zA-Z0-9]{36,}|AKIA[A-Z0-9]{12,})\b/g, label: 'api-key' },
  // Bearer 令牌
  { re: /Bearer\s+[A-Za-z0-9._\-]{20,}/g, label: 'token' },
  // 通用令牌/密钥，格式为 key=value 或 key: value
  // 带分隔符的凭据（key: value, key=value, key  value）
  { re: /(?:password|passwd|secret|api[_\-]?key|access[_\-]?token|auth[_\-]?token|private[_\-]?key|client[_\-]?secret)[\s]*[:=]\s*["']?[^\s"'<]{4,}["']?/gi, label: 'credential' },
  // 表格/标签-值格式中的凭据（Password    xyzABC123）
  { re: /(?:password|passwd|secret|api[_\-]?key|access[_\-]?token|auth[_\-]?token|private[_\-]?key|client[_\-]?secret)\s{2,}[^\s<]{4,}/gi, label: 'credential' },
  // 以类似密码的标签开头的那一行的值
  { re: /(?:^|\n)\s*(?:password|passwd|secret|api[_\-]?key|token|private[_\-]?key)[\t ]*\n\s*([^\s<]{4,})/gim, label: 'credential' },
  // SSH / PEM 私钥（内联格式）
  { re: /-----BEGIN\s[\w\s]*PRIVATE KEY-----[\s\S]*?-----END\s[\w\s]*PRIVATE KEY-----/g, label: 'private-key' },
  // 长十六进制字符串（32+ 字符），看起来像哈希/令牌
  { re: /\b[0-9a-f]{32,}\b/gi, label: 'hash' },
  // JWT 令牌（三段点号分隔的 base64 编码）
  { re: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, label: 'jwt' },
  // 带端口的 IP 地址（内网地址）
  { re: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g, label: 'internal-ip' },
];

export function init() {
  // 从功能标志加载启用状态
  _loadState();
  window.addEventListener('odysseus-sensitive-blur-change', (e) => {
    setEnabled(e.detail?.enabled !== false);
  });
  // 设置点击处理以显示内容（事件委托）
  document.addEventListener('click', (e) => {
    const el = e.target.closest('.censored-item');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.toggle('revealed');
  });
}

function _loadState() {
  // 检查管理员功能标志
  fetch('/api/auth/features', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(features => {
      _enabled = features.sensitive_filter !== false && _prefEnabled();
      // 加载状态后启动观察器
      _startObserver();
    })
    .catch(() => {
      // 默认：启用
      _enabled = _prefEnabled();
      _startObserver();
    });
}

function _startObserver() {
  if (_observer) return;
  // 观察 chat-history、compare panes 和 split panes 以获取新消息
  _observer = new MutationObserver((mutations) => {
    if (!_enabled) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        // 处理新添加节点中的 .body 元素
        if (node.classList && node.classList.contains('body')) {
          _scheduleProcess(node);
        } else if (node.querySelectorAll) {
          node.querySelectorAll('.msg .body, .msg-ai .body').forEach(b => _scheduleProcess(b));
        }
      }
    }
  });

  // 观察整个主区域以获取新消息
  const targets = [
    document.getElementById('chat-container'),
    document.getElementById('chat-history'),
  ].filter(Boolean);

  targets.forEach(t => {
    _observer.observe(t, { childList: true, subtree: true });
  });
}

// 防抖处理 — 内容可能仍在流式传输中
const _pending = new WeakSet();
function _scheduleProcess(el) {
  if (_pending.has(el)) return;
  _pending.add(el);
  // 等待流式传输稳定下来 — 短暂延迟后处理
  // 流式传输期间定期重新处理
  let attempts = 0;
  const maxAttempts = 30;
  const interval = setInterval(() => {
    _processElement(el);
    attempts++;
    if (attempts >= maxAttempts) clearInterval(interval);
  }, 2000);
  // 也立即处理一次（捕获非流式内容）
  setTimeout(() => _processElement(el), 100);
  // 流式传输可能结束后再做最后一轮处理
  setTimeout(() => {
    clearInterval(interval);
    _processElement(el);
    _pending.delete(el);
  }, 60000);
}

// 表示下一个值应该被审查的标签
const SENSITIVE_LABELS = /^(?:password|passwd|secret|api[_\-]?key|access[_\-]?token|auth[_\-]?token|private[_\-]?key|client[_\-]?secret|token|credentials?)$/i;

function _processElement(el) {
  if (!_enabled || !el) return;
  if (el.closest && el.closest('.setup-guide-no-censor')) return;

  // --- 第一轮：对文本节点进行基于模式的审查 ---
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement.closest('.setup-guide-no-censor')) continue;
    if (node.parentElement.closest('pre:not(.censored-item), .censored-item')) continue;
    textNodes.push(node);
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent;
    if (!text || text.trim().length < 4) continue;

    const matches = [];
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let m;
      while ((m = pattern.re.exec(text)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], label: pattern.label });
      }
    }
    if (matches.length === 0) continue;

    matches.sort((a, b) => a.start - b.start);
    const deduped = [matches[0]];
    for (let i = 1; i < matches.length; i++) {
      const prev = deduped[deduped.length - 1];
      if (matches[i].start < prev.end) {
        if (matches[i].end > prev.end) prev.end = matches[i].end;
      } else {
        deduped.push(matches[i]);
      }
    }

    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    for (const match of deduped) {
      if (match.start > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, match.start)));
      }
      const span = document.createElement('span');
      span.className = 'censored-item';
      span.dataset.type = match.label;
      span.title = '点击显示 ' + match.label;
      span.textContent = match.text;
      frag.appendChild(span);
      lastIdx = match.end;
    }
    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
    textNode.parentNode.replaceChild(frag, textNode);
  }

  // --- 第二轮：基于上下文的标签/值审查 ---
  // 查找文本匹配敏感标签的元素，然后审查
  // 相邻兄弟元素或下一个文本内容作为值。
  _contextCensor(el);
}

function _contextCensor(el) {
  // 策略 1：遍历所有元素查找敏感标签
  const allElements = el.querySelectorAll('td, th, dt, dd, span, strong, b, em, li, p, div');
  for (let i = 0; i < allElements.length; i++) {
    const elem = allElements[i];
    if (elem.closest('.setup-guide-no-censor')) continue;
    if (elem.closest('.censored-item, pre')) continue;
    const txt = (elem.textContent || '').trim();
    if (!SENSITIVE_LABELS.test(txt)) continue;

    // 找到了标签 — 通过多种策略审查值
    let censored = false;

    // A) 下一个文本兄弟节点（例如 <strong>Password</strong> value123）
    let sibling = elem.nextSibling;
    while (sibling && !censored) {
      if (sibling.nodeType === 3) { // 文本节点
        const val = sibling.textContent.trim();
        if (val.length >= 4 && !SENSITIVE_LABELS.test(val)) {
          const span = document.createElement('span');
          span.className = 'censored-item';
          span.dataset.type = 'credential';
          span.title = '点击显示凭据';
          span.textContent = sibling.textContent;
          sibling.parentNode.replaceChild(span, sibling);
          censored = true;
        }
      } else if (sibling.nodeType === 1 && !sibling.closest('.censored-item')) {
        // 元素兄弟节点 — 审查其文本
        const val = sibling.textContent.trim();
        if (val.length >= 4 && !SENSITIVE_LABELS.test(val)) {
          _censorAllText(sibling);
          censored = true;
        }
      }
      sibling = censored ? null : sibling.nextSibling;
    }

    // B) 父元素的下一个元素兄弟节点（用于 <td>/<dd> 对）
    if (!censored) {
      const parent = elem.parentElement;
      if (parent) {
        const nextEl = parent.nextElementSibling;
        if (nextEl && !nextEl.closest('.censored-item')) {
          const val = nextEl.textContent.trim();
          if (val.length >= 2 && !SENSITIVE_LABELS.test(val)) {
            _censorAllText(nextEl);
            censored = true;
          }
        }
      }
    }

    // C) 同一父元素下，此元素之后的文本节点
    if (!censored && elem.parentElement) {
      const parent = elem.parentElement;
      let found = false;
      for (let c = 0; c < parent.childNodes.length; c++) {
        const child = parent.childNodes[c];
        if (child === elem) { found = true; continue; }
        if (!found) continue;
        if (child.nodeType === 3 && child.textContent.trim().length >= 4) {
          const val = child.textContent.trim();
          if (!SENSITIVE_LABELS.test(val)) {
            const span = document.createElement('span');
            span.className = 'censored-item';
            span.dataset.type = 'credential';
            span.title = '点击显示凭据';
            span.textContent = child.textContent;
            child.parentNode.replaceChild(span, child);
            break;
          }
        }
      }
    }
  }

  // 策略 2：全文本扫描，查找跨行的标签-值模式
  // 获取完整文本，查找如 "Password\n  value" 或 "Password: value" 的模式
  const fullText = el.textContent || '';
  const labelValueRe = /(?:password|passwd|secret|api[_\-]?key|access[_\-]?token|private[_\-]?key|client[_\-]?secret|token|auth[_\-]?token)\s*[:\s]\s*(\S{4,})/gi;
  let m;
  while ((m = labelValueRe.exec(fullText)) !== null) {
    const value = m[1];
    // 在文本节点中查找并审查此值字符串
    _censorValueInElement(el, value);
  }
}

function _censorValueInElement(el, value) {
  if (!value || value.length < 4) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement.closest('.setup-guide-no-censor')) continue;
    if (node.parentElement.closest('pre:not(.censored-item), .censored-item')) continue;
    const idx = node.textContent.indexOf(value);
    if (idx < 0) continue;
    // 分割文本节点并将值包裹起来
    const before = node.textContent.slice(0, idx);
    const after = node.textContent.slice(idx + value.length);
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    const span = document.createElement('span');
    span.className = 'censored-item';
    span.dataset.type = 'credential';
    span.title = '点击显示凭据';
    span.textContent = value;
    frag.appendChild(span);
    if (after) frag.appendChild(document.createTextNode(after));
    node.parentNode.replaceChild(frag, node);
    return; // 每次调用只做一次替换以避免遍历器问题
  }
}

function _censorAllText(el) {
  // 将所有文本内容包裹在审查 span 中
  if (el.querySelector('.censored-item')) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.parentElement.closest('.setup-guide-no-censor')) continue;
    if (n.parentElement.closest('.censored-item, pre')) continue;
    if (n.textContent.trim().length >= 2) nodes.push(n);
  }
  for (const tn of nodes) {
    const span = document.createElement('span');
    span.className = 'censored-item';
    span.dataset.type = 'credential';
    span.title = '点击显示凭据';
    span.textContent = tn.textContent;
    tn.parentNode.replaceChild(span, tn);
  }
}

/** 手动审查特定元素（用于动态加载的内容） */
export function censorElement(el) {
  if (!_enabled) return;
  _processElement(el);
}

/** 切换审查开/关（客户端） */
export function setEnabled(enabled) {
  _enabled = enabled;
  if (!enabled) {
    // 显示所有当前被审查的项目
    document.querySelectorAll('.censored-item').forEach(el => el.classList.add('revealed'));
  } else {
    document.querySelectorAll('.censored-item').forEach(el => el.classList.remove('revealed'));
  }
}

export function isEnabled() {
  return _enabled;
}

const censorModule = { init, censorElement, setEnabled, isEnabled };

export default censorModule;
