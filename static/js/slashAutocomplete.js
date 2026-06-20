// static/js/slashAutocomplete.js
// 轻量级弹出窗口，在用户输入时展示现有的 /command 注册表。
// 从 slashCommands.js 读取 COMMANDS —— 此处不包含命令逻辑。

import { COMMANDS, LEGACY_ALIASES } from './slashCommands.js';

const POPUP_ID = 'slash-autocomplete';
const MAX_VISIBLE = 14;

// 将注册表扁平化为可搜索的叶子条目列表。每个条目
// 要么是顶级命令，要么是 "cmd sub" 对（使子命令在相关时获得
// 各自的行 —— /toggle web、/chats new 等）。
// 有意从自动完成弹出窗口中排除的命令（纯彩蛋，
// 无生产力价值，或内部机制）。
const EXCLUDED = new Set(['flip','roll','8ball','fortune','odyssey','ascii']);

// 要在弹出窗口中提升为独立行的重要历史别名。这些
// 是人们实际会输入的短格式（/new、/clear、/web 等），
// 而不是完整的 /chats new、/toggle web 等效项。
const PROMOTED_ALIASES = new Set([
  'new','clear','rename','fork','export','archive','favorite','unfavorite',
  'web','bash','research','doc',
  'memories','forget',
]);

function _flatten() {
  const out = [];
  const seen = new Set();

  // 1. COMMANDS 中的顶级命令及其子命令
  for (const [name, def] of Object.entries(COMMANDS)) {
    if (EXCLUDED.has(name)) continue;
    if (def.hidden) continue;
    if (def.handler) {
      seen.add(`/${name}`);
      out.push({
        token: `/${name}`,
        aliases: (def.alias || []).map(a => `/${a}`),
        category: def.category || '',
        help: def.help || '',
        usage: def.usage || '',
      });
    }
    if (def.subs) {
      for (const [sub, sdef] of Object.entries(def.subs)) {
        if (sub.startsWith('_')) continue;
        if (sdef.hidden) continue;
        const tok = `/${name} ${sub}`;
        seen.add(tok);
        out.push({
          token: tok,
          aliases: (sdef.alias || []).map(a => `/${name} ${a}`),
          category: def.category || '',
          help: sdef.help || '',
          usage: sdef.usage || '',
        });
      }
    }
  }

  // 2. 提升的历史别名（/new、/clear、/web 等）作为便捷短行
  if (LEGACY_ALIASES) {
    for (const [alias, { parent, sub }] of Object.entries(LEGACY_ALIASES)) {
      if (!PROMOTED_ALIASES.has(alias)) continue;
      const tok = `/${alias}`;
      if (seen.has(tok)) continue;
      const parentDef = COMMANDS[parent];
      const subDef = parentDef?.subs?.[sub];
      if (!subDef) continue;
      seen.add(tok);
      out.push({
        token: tok,
        aliases: [],
        category: parentDef.category || '',
        help: subDef.help || '',
        usage: tok,
      });
    }
  }

  return out;
}

async function _loadSkillEntries() {
  try {
    const res = await fetch('/api/skills/slash-catalog', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data.skills) ? data.skills : []).map(s => ({
      token: s.token || `/${s.name}`,
      aliases: [],
      category: s.category || t('slash.skills_category'),
      help: s.help || t('slash.run_skill'),
      usage: s.usage || `${s.token || `/${s.name}`} <request>`,
    })).filter(e => e.token && e.token.startsWith('/'));
  } catch {
    return [];
  }
}

function _scoreMatch(entry, query) {
  // query 已经以 "/" 开头。匹配 token + 别名。前缀匹配优先于
  // 子串匹配；别名匹配得分略低于 token 匹配。
  const q = query.toLowerCase();
  const t = entry.token.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500 + (50 - Math.min(50, t.length - q.length));
  for (const a of entry.aliases) {
    const al = a.toLowerCase();
    if (al === q) return 900;
    if (al.startsWith(q)) return 400;
  }
  if (t.includes(q)) return 100;
  if (entry.help.toLowerCase().includes(q.slice(1))) return 25;  // 帮助文本
  return 0;
}

function _exactCommandGroupItems(all, query) {
  const q = query.toLowerCase();
  if (!/^\/[a-z0-9_-]+$/i.test(q)) return [];
  const parent = all.find(entry => entry.token.toLowerCase() === q);
  if (!parent) return [];
  const prefix = q + ' ';
  const children = all.filter(entry => entry.token.toLowerCase().startsWith(prefix));
  if (!children.length) return [];
  return children.concat(parent);
}

function _ensurePopup(textarea) {
  let el = document.getElementById(POPUP_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = POPUP_ID;
  el.className = 'slash-autocomplete-popup';
  el.setAttribute('role', 'listbox');
  el.setAttribute('aria-label', 'Slash commands');
  document.body.appendChild(el);
  return el;
}

function _position(popup, textarea) {
  const r = textarea.getBoundingClientRect();
  const maxH = Math.min(window.innerHeight * 0.5, 360);
  popup.style.maxHeight = maxH + 'px';
  // 将弹出窗口锚定在 textarea 上方，左对齐
  popup.style.left = Math.round(r.left) + 'px';
  popup.style.width = Math.max(280, Math.round(Math.min(r.width, 520))) + 'px';
  // 上方空间足够时放在上面，否则放在下面。
  const aboveSpace = r.top;
  if (aboveSpace > maxH + 20) {
    popup.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    popup.style.top = '';
  } else {
    popup.style.top = (r.bottom + 6) + 'px';
    popup.style.bottom = '';
  }
}

function _render(popup, items, selectedIdx, query) {
  if (!items.length) {
    popup.innerHTML = `<div class="slash-ac-empty">No commands match <code>${_esc(query)}</code></div>`;
    return;
  }
  // 按类别分组显示标题
  let html = '';
  let lastCat = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.category !== lastCat) {
      html += `<div class="slash-ac-cat">${_esc(it.category || t('slash.other_category'))}</div>`;
      lastCat = it.category;
    }
    const sel = i === selectedIdx ? ' slash-ac-row-sel' : '';
    const usage = it.usage && it.usage !== it.token ? ` <span class="slash-ac-usage">${_esc(it.usage)}</span>` : '';
    html += `<div class="slash-ac-row${sel}" role="option" data-idx="${i}" data-token="${_esc(it.token)}">`
         +    `<span class="slash-ac-token">${_esc(it.token)}</span>`
         +    `<span class="slash-ac-help">${_esc(it.help)}</span>`
         +    usage
         + `</div>`;
  }
  popup.innerHTML = html;
  // 将选中项滚动到可视区域
  const selEl = popup.querySelector('.slash-ac-row-sel');
  if (selEl) selEl.scrollIntoView({ block: 'nearest' });
}

function _esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c]));
}

export function initSlashAutocomplete(textarea) {
  if (!textarea || textarea._slashAcWired) return;
  textarea._slashAcWired = true;

  let all = _flatten();
  let popup = null;
  let visible = false;
  let items = [];
  let selectedIdx = 0;

  const hide = () => {
    if (!visible) return;
    visible = false;
    if (popup) popup.style.display = 'none';
  };

  const show = () => {
    if (!popup) popup = _ensurePopup(textarea);
    visible = true;
    popup.style.display = 'block';
    _position(popup, textarea);
  };

  const refresh = () => {
    const v = textarea.value;
    // 仅在消息以 "/" 开头（无前导空格）且
    // 命令后最多包含一个空格时才触发（以支持子命令）。
    // 如果用户已越过斜杠命令（换行、较长的正文），
    // 菜单隐藏 —— 我们不在句子中间自动完成。
    if (!v.startsWith('/') || v.includes('\n')) { hide(); return; }
    const query = v.trim();
    const groupItems = _exactCommandGroupItems(all, query);
    if (groupItems.length) {
      items = groupItems.slice(0, MAX_VISIBLE);
    } else {
      items = all
      .map(e => ({ e, s: _scoreMatch(e, query) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_VISIBLE)
      .map(x => x.e);
    }
    if (!items.length && query.length > 1) { hide(); return; }
    if (!items.length) {
      // 只有 "/" 且无匹配项 —— 回退到显示最多 MAX_VISIBLE 个全部条目
      items = all.slice(0, MAX_VISIBLE);
    }
    selectedIdx = 0;
    show();
    _render(popup, items, selectedIdx, query);
  };

  _loadSkillEntries().then(skillEntries => {
    if (!skillEntries.length) return;
    const seen = new Set(all.map(e => e.token));
    const merged = all.slice();
    for (const entry of skillEntries) {
      if (seen.has(entry.token)) continue;
      seen.add(entry.token);
      merged.push(entry);
    }
    all = merged;
    if (visible) refresh();
  });

  const insert = (token) => {
    textarea.value = token + ' ';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    const len = textarea.value.length;
    textarea.setSelectionRange(len, len);
    hide();
  };

  textarea.addEventListener('input', refresh);
  textarea.addEventListener('focus', () => { if (textarea.value.startsWith('/')) refresh(); });
  textarea.addEventListener('blur', () => { setTimeout(hide, 120); });  // 延迟以允许点击生效

  textarea.addEventListener('keydown', (e) => {
    if (!visible || !items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = (selectedIdx + 1) % items.length;
      _render(popup, items, selectedIdx, textarea.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = (selectedIdx - 1 + items.length) % items.length;
      _render(popup, items, selectedIdx, textarea.value);
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      // Tab 始终插入。Enter 仅在用户尚未
      // 输入完整命令 + 参数时才插入 —— 即弹出窗口仍处于自动完成
      // 模式，而非"准备提交已输入的命令"模式。
      const v = textarea.value.trim();
      const exactHit = items.find(it => it.token === v || it.aliases.includes(v));
      if (e.key === 'Enter' && exactHit) {
        // 用户输入了完整命令 —— 让正常的提交路径处理
        hide();
        return;
      }
      e.preventDefault();
      insert(items[selectedIdx].token);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  });

  // 窗口大小改变/滚动时重新定位
  window.addEventListener('resize', () => { if (visible) _position(popup, textarea); });

  // 弹出窗口上的点击处理（委托）
  document.addEventListener('mousedown', (e) => {
    if (!visible || !popup) return;
    const row = e.target.closest?.('.slash-ac-row');
    if (row && popup.contains(row)) {
      e.preventDefault();
      const tok = row.dataset.token;
      if (tok) insert(tok);
    }
  });
}

export default { initSlashAutocomplete };
