// skills.js — 记忆弹窗中的“技能”标签页。
//
// 技能是 data/skills/ 目录下的 SKILL.md 文件（frontmatter + 正文）。
// 本 UI 支持：列表、搜索、查看（阅读 SKILL.md）、编辑（替换
// 内容）、发布/草稿切换、删除，以及通过 /<skill-name> 路径
// “作为斜指令运行”。

import uiModule from './ui.js';
import * as spinnerModule from './spinner.js';
import { t } from './i18n.js';

const API = window.location.origin;
let skills = [];
let builtinSkills = [];   // 只读的代理工具能力 (TOOL_SECTIONS)
let loaded = false;
let _loadPromise = null;

function esc(s) { return uiModule.esc(String(s ?? '')); }

let _pendingFocusSkill = null;
let _cascadeNext = false;   // 设为 true 以在下次渲染时播放多米诺入场动画

function _playSkillsCascade(container = document.getElementById('skills-list')) {
  if (!container || !container.querySelector('.skill-card')) return false;
  container.classList.remove('doclib-just-opened');
  void container.offsetWidth;
  container.classList.add('doclib-just-opened');
  setTimeout(() => container.classList.remove('doclib-just-opened'), 900);
  return true;
}

// 按技能名称缓存 SKILL.md 文本，使展开时立即显示（无异步
// 获取 + 内容跳动）。展开时懒加载，同时在渲染后
// 后台预加载所有可见卡片的内容。
const _mdCache = new Map();
async function _fetchSkillMarkdown(name) {
  if (_mdCache.has(name)) return _mdCache.get(name);
  const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}/markdown`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const md = data.markdown || '';
  _mdCache.set(name, md);
  return md;
}
// 后台预加载所有已渲染的技能卡片的 markdown 内容，使其
// 在用户展开之前就已就绪（在卡片的 <pre> + _mdLoaded 中）。
function _preloadVisibleMarkdown() {
  document.querySelectorAll('#skills-list .skill-card[data-skill-name]').forEach(card => {
    const name = card.dataset.skillName;
    if (!name || card._mdLoaded) return;
    const pre = card.querySelector('.skill-md-pre');
    const apply = (md) => { if (pre) pre.textContent = md || '(empty)'; card._mdLoaded = true; card._md = md || ''; };
    if (_mdCache.has(name)) { apply(_mdCache.get(name)); return; }
    _fetchSkillMarkdown(name).then(apply).catch(() => {});
  });
}

// 折叠的技能分区（“用户” / “内置”），持久化以便
// 选择在重新加载后保持。内置区默认折叠（它是
// 参考信息，不是用户自己的技能）。
const _collapsedSections = (() => {
  try {
    const raw = localStorage.getItem('skillsSectionsCollapsed');
    if (raw) return new Set(JSON.parse(raw));
  } catch (_) {}
  return new Set(['builtin']);
})();
function _saveCollapsedSections() {
  try { localStorage.setItem('skillsSectionsCollapsed', JSON.stringify([..._collapsedSections])); } catch (_) {}
}
function _applySectionCollapse(container) {
  if (!container) return;
  container.querySelectorAll('.skills-section-header').forEach(h => {
    h.classList.toggle('collapsed', _collapsedSections.has(h.dataset.section));
  });
  container.querySelectorAll('.doclib-card[data-skill-section]').forEach(c => {
    c.classList.toggle('skill-card-section-hidden', _collapsedSections.has(c.dataset.skillSection));
  });
}

export async function loadSkills(cascade = false) {
  // 在此次加载时播放多米诺入场动画（在标签页打开时设置，
  // 编辑/删除后的静默重新加载不会触发）。
  if (cascade) _cascadeNext = true;
  if (cascade && loaded && !_loadPromise && _playSkillsCascade()) {
    _cascadeNext = false;
    updateCount();
    return;
  }
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
  try {
    const res = await fetch(`${API}/api/skills`);
    const data = await res.json();
    skills = data.skills || [];
    _loadSkillApprovalThreshold();
    // 内置能力不再在技能菜单中显示。
    loaded = true;
    renderSkillsList();
    updateCount();
    if (_pendingFocusSkill) {
      _focusSkillRow(_pendingFocusSkill);
      _pendingFocusSkill = null;
    }
    // 如果后台审计正在运行，重新显示其进度面板。
    if (!_auditPoll) {
      _fetchAuditStatus().then(st => {
        if (st.status === 'running') _auditAllSkills();
      }).catch(() => {});
    }
  } catch (e) {
    console.error('Failed to load skills:', e);
  } finally {
    _loadPromise = null;
  }
  })();
  return _loadPromise;
}

function _focusSkillRow(name) {
  setTimeout(() => {
    const card = document.querySelector(`.skill-card[data-skill-name="${CSS.escape(name)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('skill-row-flash');
    setTimeout(() => card.classList.remove('skill-row-flash'), 2000);
    // 展开它以便链接的技能直接打开其 SKILL.md。
    _expandSkillCard(card, name);
  }, 200);
}

// 打开“记忆”弹窗 → “技能”标签页 → 聚焦特定技能行。
// 由聊天锚点链接委派（[name](#skill-<name>)）使用。
export function openSkill(name) {
  _pendingFocusSkill = name || null;
  // 如果“记忆”弹窗尚未打开，则打开它。
  const memBtn = document.getElementById('tool-memory-btn');
  if (memBtn) memBtn.click();
  // 切换到“技能”标签页（触发懒加载 loadSkills()）。
  setTimeout(() => {
    const tab = document.querySelector('.memory-tab[data-memory-tab="skills"]');
    if (tab) tab.click();
    else loadSkills();  // 如果标签页结构不同时的回退方案
  }, 120);
}

let _skillsSort = 'confidence';
let _showDraftsOnly = false;
let _showPublishedOnly = false;
let _confMax = null;   // 置信度上限过滤器（%，例如 90 = 显示≤90% 的）；null = 关闭
let _selectMode = false;
const _selectedNames = new Set();
let _skillApprovalThreshold = 0.85;

function updateCount() {
  const el = document.getElementById('skills-count');
  if (el) el.textContent = skills.length || '0';
  const elH = document.getElementById('skills-count-h2');
  if (elH) elH.textContent = skills.length + ' skill' + (skills.length === 1 ? '' : 's');
}

function _sortSkills(list) {
  const arr = list.slice();
  if (_skillsSort === 'confidence') {
    arr.sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || (a.name || '').localeCompare(b.name || ''));
  } else if (_skillsSort === 'uses') {
    arr.sort((a, b) => (b.uses || 0) - (a.uses || 0) || (a.name || '').localeCompare(b.name || ''));
  } else if (_skillsSort === 'recent') {
    arr.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
  } else {
    arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
  return arr;
}

function _matches(sk, query) {
  const q = query.toLowerCase();
  return (
    (sk.name || '').toLowerCase().includes(q) ||
    (sk.description || '').toLowerCase().includes(q) ||
    (sk.when_to_use || sk.problem || '').toLowerCase().includes(q) ||
    (sk.category || '').toLowerCase().includes(q) ||
    (sk.tags || []).some(t => (t || '').toLowerCase().includes(q))
  );
}

function _statusPill(sk) {
  const s = sk.status || (sk._legacy ? 'legacy' : 'draft');
  if (s === 'published') return '<span class="memory-cat-badge skill-status-pill" data-status="published" style="background:color-mix(in srgb, var(--accent, #4ade80) 30%, transparent)">published</span>';
  if (s === 'draft')     return '<span class="memory-cat-badge skill-status-pill" data-status="draft" style="background:color-mix(in srgb, var(--fg) 14%, transparent)">draft</span>';
  return `<span class="memory-cat-badge skill-status-pill" data-status="${esc(s)}" style="opacity:0.6">${esc(s)}</span>`;
}

// 为自动升级教师循环编写的技能显示“教师”徽章。让用户一眼就能区分
// 哪些流程是手动编写的、哪些是自动生成的，以便在信任之前
// 进行审计（并降级/
// 编辑/发布）。
function _sourcePill(sk) {
  if (sk.source !== 'teacher-escalation') return '';
  const teacher = sk.teacher_model || 'teacher';
  return `<span class="memory-cat-badge" title="Created by teacher escalation: ${esc(teacher)}" style="background:color-mix(in srgb, var(--color-warning, #f0ad4e) 22%, transparent);">teacher-created</span>`;
}

function _modelShortName(model) {
  return String(model || '').split('/').filter(Boolean).pop() || String(model || '');
}

function _skillTokens(sk) {
  return new Set(String([
    sk.name || '',
    sk.description || '',
    sk.when_to_use || '',
    ...(sk.tags || []),
  ].join(' ')).toLowerCase()
    .replace(/-\d+\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2 && !['the', 'and', 'with', 'for', 'from', 'using'].includes(t)));
}

function _skillSimilarity(a, b) {
  const A = _skillTokens(a), B = _skillTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function _baseSkillName(name) {
  return String(name || '').replace(/-\d+$/, '');
}

function _scoreDuplicateKeeper(sk) {
  return [
    (sk.status === 'published') ? 100000 : 0,
    (sk.uses || 0) * 100,
    Math.round((sk.confidence || 0) * 100),
    sk.audit_by_teacher ? -5 : 0,
    -String(sk.name || '').length / 1000,
  ].reduce((a, b) => a + b, 0);
}

function _duplicateMeta(list) {
  const parent = new Map();
  const names = list.map(s => s.name || s.id).filter(Boolean);
  names.forEach(n => parent.set(n, n));
  const find = (x) => {
    let p = parent.get(x) || x;
    while (p !== parent.get(p)) p = parent.get(p);
    return p;
  };
  const unite = (a, b) => {
    const pa = find(a), pb = find(b);
    if (pa !== pb) parent.set(pb, pa);
  };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const an = a.name || a.id, bn = b.name || b.id;
      if (!an || !bn) continue;
      if (_baseSkillName(an) === _baseSkillName(bn) || _skillSimilarity(a, b) >= 0.38) {
        unite(an, bn);
      }
    }
  }
  const groups = new Map();
  for (const sk of list) {
    const n = sk.name || sk.id;
    if (!n) continue;
    const root = find(n);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(sk);
  }
  const meta = new Map();
  let idx = 1;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((a, b) => _scoreDuplicateKeeper(b) - _scoreDuplicateKeeper(a));
    const keep = sorted[0].name || sorted[0].id;
    const groupNames = sorted.map(s => s.name || s.id).filter(Boolean);
    for (const sk of sorted) {
      const n = sk.name || sk.id;
      meta.set(n, { group: idx, keep: n === keep, keepName: keep, names: groupNames });
    }
    idx++;
  }
  return meta;
}

function _auditModelPills(sk) {
  const worker = sk.audit_worker_model || '';
  const teacher = sk.audit_teacher_model || '';
  let html = '';
  if (worker) {
    html += `<span class="memory-cat-badge skill-model-pill skill-model-student" title="Last audited by default audit model: ${esc(worker)}">audit</span>`;
  }
  if (sk.audit_by_teacher || teacher) {
    const title = teacher
      ? `Teacher rewrote this skill; audit model passed after the rewrite. Teacher: ${teacher}`
      : 'Teacher rewrote this skill; audit model passed after the rewrite.';
    html += `<span class="memory-cat-badge skill-model-pill skill-model-teacher" title="${esc(title)}">teacher-fixed</span>`;
  }
  return html;
}

function _necessityKind(sk) {
  const nec = sk && sk.necessity;
  if (sk && sk._duplicateGroup) return 'duplicate';
  if (!nec || nec.necessary !== false) return null;
  const reason = String(nec.reason || '').toLowerCase();
  const redundant = (nec.redundant_with || []).filter(Boolean);
  if (redundant.length || /duplicat|redundan|overlap|same skill|same procedure/.test(reason)) return 'duplicate';
  if (/trivial|generic|capable assistant|without a saved|not need|unnecessary/.test(reason)) return 'trivial';
  return 'irrelevant';
}

function _necessityPill(sk) {
  const kind = _necessityKind(sk);
  if (!kind) return '';
  const nec = sk.necessity || {};
  const dup = (nec.redundant_with || []).filter(Boolean);
  const label = kind === 'duplicate' ? (sk._duplicateGroup ? `duplicate #${sk._duplicateGroup}` : 'duplicate')
    : kind === 'trivial' ? 'generic'
    : 'possibly-irrelevant';
  const group = sk._duplicateNames || [];
  const why = sk._duplicateGroup
    ? `Duplicate group #${sk._duplicateGroup}. Recommended keep: ${sk._duplicateKeepName}. Group: ${group.join(', ')}`
    : (nec.reason || 'May not be worth keeping') + (dup.length ? ' | overlaps: ' + dup.join(', ') : '');
  return `<span class="memory-cat-badge skill-necessity-pill skill-necessity-${kind}" title="${esc(why)}">${label}</span>`;
}

function _duplicatePriorityPill(sk) {
  if (!sk._duplicateGroup) return '';
  if (sk._duplicateKeep) {
    return `<span class="memory-cat-badge skill-duplicate-keep" title="Best duplicate candidate by published status, uses, confidence, and specificity">recommended</span>`;
  }
  return `<span class="memory-cat-badge skill-duplicate-lower" title="Lower-priority duplicate. Suggested keeper: ${esc(sk._duplicateKeepName || '')}">lower-priority</span>`;
}

// 在置信度% 旁显示的“已通过测试验证”指示器。当测试/审计运行通过时显示勾号；
// 当教师模型需要重写技能以使其通过时显示学士帽图标。
// SVG 图标（非 Unicode 表情符号）。
function _auditMarks(sk) {
  let html = '';
  if (sk.audit_verdict === 'pass') {
    html += `<span class="skill-verified" title="Passed an automated test"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>`;
  }
  if (sk.audit_by_teacher) {
    const teacher = sk.audit_teacher_model ? `: ${sk.audit_teacher_model}` : '';
    html += `<span class="skill-teachermark" title="Teacher rewrote this skill; audit model passed after the rewrite${esc(teacher)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1 3 2 6 2s6-1 6-2v-5"/></svg></span>`;
  }
  return html;
}

// 审计结果圆点 — 应用户要求已移除。置信度% 旁边的 ✓ 勾号
// 仍然表示通过。占位函数返回空字符串，以便周围的
// 头部 HTML 组成时不会改变其他布局。
function _auditDot(sk) { return ''; }

function _isDraftsFilter() { return !!_showDraftsOnly; }

// 置信度 → 颜色。90%+ 为坚实的绿色，递减经过
// 黄色/橙色到 50% 及以下为红色（色相 120→0 在 90→50 范围内）。
function _confColor(conf) {
  const hue = Math.max(0, Math.min(120, ((conf - 50) / 40) * 120));
  return `hsl(${Math.round(hue)}, 70%, 42%)`;
}

// 共享操作图标（折叠的 kebab 菜单 + 展开的底部栏使用相同的图标）。
const _ICON = {
  del:   '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  edit:  '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  approve: '<polyline points="20 6 9 17 4 12"/>',
  unpublish: '<path d="M5 12l5 5L20 7"/>',
  test:  '<polygon points="5 3 19 12 5 21 5 3"/>',
};
function _svg(paths, { fill = 'none', size = 13 } = {}) {
  const stroke = fill === 'currentColor' ? '' : 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" ${stroke} style="vertical-align:-2px;flex-shrink:0;">${paths}</svg>`;
}

// 折叠技能卡片的 kebab 下拉菜单 — 与展开的底部栏相同的操作 + 图标
// （发布/取消发布 · 编辑 · 删除）。
function _openSkillMenu(btn, card, sk, name, isPublished) {
  document.querySelectorAll('.skill-kebab-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'skill-kebab-menu';
  const mk = (paths, label, opts, onClick) => {
    const item = document.createElement('button');
    item.className = 'skill-kebab-item' + (opts && opts.danger ? ' danger' : '');
    item.innerHTML = _svg(paths, opts) + `<span>${label}</span>`;
    item.addEventListener('click', (e) => { e.stopPropagation(); menu.remove(); onClick(); });
    menu.appendChild(item);
  };
  if (isPublished) mk(_ICON.unpublish, 'Unpublish', {}, () => _setSkillStatus(name, 'draft'));
  else mk(_ICON.approve, 'Publish', {}, () => _setSkillStatus(name, 'published'));
  mk(_ICON.edit, 'Edit', {}, async () => {
    if (!card.classList.contains('doclib-card-expanded')) await _expandSkillCard(card, name);
    _toggleSkillEdit(card, name);
  });
  mk(_ICON.test, 'Test', {}, () => _testSkill(card, name));
  // 审计触发批量审计-all 循环（测试 → 评分 → 修复 → 重试 → 降级）。
  // 从列表顶部开始并向下遍历。
  mk(_ICON.test, 'Audit', {}, () => _auditAllSkills());
  mk(_ICON.del, 'Delete', { danger: true }, () => _deleteSkill(name, card));

  // 选择 — 进入批量选择模式并预选此技能。与邮件/文档/大脑
  // 的“选择”项相同模式，使用邮件圆点图标。
  const selItem = document.createElement('button');
  selItem.className = 'skill-kebab-item';
  selItem.innerHTML = '<span style="display:inline-flex;width:14px;height:14px;align-items:center;justify-content:center;"><span style="font-size:16px;line-height:1;">●</span></span><span>Select</span>';
  selItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    if (!_selectMode) _enterSelectMode();
    _selectedNames.add(name);
    renderSkillsList();
  });
  menu.appendChild(selItem);

  // 仅移动端的“取消”按钮 — 镜像邮件/文档/大脑弹窗模式。
  // 在桌面端通过 CSS 隐藏 `.dropdown-cancel-mobile`，因为在桌面端
  // 点击外部就可以干净地关闭。
  const cancelItem = document.createElement('button');
  cancelItem.className = 'skill-kebab-item dropdown-cancel-mobile';
  cancelItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span>Cancel</span>';
  cancelItem.addEventListener('click', (e) => { e.stopPropagation(); menu.remove(); });
  menu.appendChild(cancelItem);

  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.right = Math.max(6, window.innerWidth - r.right) + 'px';
  // 保持在屏幕内（移动端）：如果会溢出底部则翻转到按钮上方，
  // 限制左边缘，并作为最后手段限制高度。
  const mr = menu.getBoundingClientRect();
  if (mr.bottom > window.innerHeight - 6) {
    menu.style.top = Math.max(6, r.top - mr.height - 4) + 'px';
  }
  if (mr.left < 6) {
    menu.style.right = Math.max(6, window.innerWidth - 6 - mr.width) + 'px';
  }
  const mr2 = menu.getBoundingClientRect();
  if (mr2.bottom > window.innerHeight - 6) {
    menu.style.maxHeight = Math.max(80, window.innerHeight - 12 - mr2.top) + 'px';
    menu.style.overflowY = 'auto';
  }
  const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close, true); } };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

// 代理的内置工具能力卡片（来自
// /api/skills/builtin → TOOL_SECTIONS）。可展开预览
// 指令块；可编辑，带警告 + 还原到默认值的按钮
// （覆盖存储在设置中，应用到提示词）。
function _buildBuiltinCards() {
  return builtinSkills.map(b => {
    const card = document.createElement('div');
    card.className = 'doclib-card skill-card skill-builtin-card';
    card.dataset.builtinName = b.name;

    const header = document.createElement('div');
    header.className = 'doclib-card-header skill-card-header';
    header.innerHTML = `
      <span class="skill-conf-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent, var(--red));flex-shrink:0;margin-right:6px;opacity:0.55;"></span>
      <div style="flex:1;min-width:0;overflow:hidden;">
        <div class="doclib-card-title" style="display:flex;align-items:center;gap:6px;min-width:0;">
          <code style="font-weight:600;font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:1;min-width:0;">${esc(b.name)}</code>
          <span class="memory-cat-badge" style="background:color-mix(in srgb, var(--fg) 14%, transparent)">built-in</span>
          ${b.is_overridden ? '<span class="memory-cat-badge" title="You have edited this built-in capability" style="background:color-mix(in srgb, var(--color-warning, #f0ad4e) 30%, transparent);">edited</span>' : ''}
        </div>
        ${b.description ? `<div class="doclib-card-session" title="${esc(b.description)}" style="font-size:10px;opacity:0.55;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(b.description)}</div>` : ''}
      </div>
      <span class="doclib-card-chevron"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>
    `;
    card.appendChild(header);

    const preview = document.createElement('div');
    preview.className = 'doclib-card-preview skill-card-preview';
    // 警告横幅 — 编辑内置能力会改变助手使用原生工具的方式。
    const warn = document.createElement('div');
    warn.className = 'skill-builtin-warn';
    warn.innerHTML = '⚠ This is a built-in capability. Editing changes how the assistant is instructed to use this native tool — it can break or alter core behaviour. Use Revert to restore the shipped default.';
    preview.appendChild(warn);
    const pre = document.createElement('pre');
    pre.className = 'skill-md-pre';
    pre.textContent = '';  // 展开时填充
    preview.appendChild(pre);

    // 底部栏：还原（左侧，仅在被覆盖时有意义）· 编辑/保存（右侧）。
    const actions = document.createElement('div');
    actions.className = 'doclib-card-expanded-actions';

    const revertBtn = document.createElement('button');
    revertBtn.className = 'doclib-card-text-btn doclib-card-action-btn doclib-card-text-btn-danger';
    revertBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>' + t('skills.revert');
    revertBtn.title = t('skills.restore_original');
    revertBtn.addEventListener('click', (e) => { e.stopPropagation(); _revertBuiltin(b.name); });

    const editBtn = document.createElement('button');
    editBtn.className = 'doclib-card-text-btn doclib-card-action-btn';
    editBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' + t('skills.edit');
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); _toggleBuiltinEdit(card, b.name); });

    const rightGroup = document.createElement('div');
    rightGroup.className = 'doclib-action-group';
    const btnRow = document.createElement('div');
    btnRow.className = 'doclib-action-btn-row';
    btnRow.appendChild(editBtn);
    rightGroup.appendChild(btnRow);

    actions.appendChild(revertBtn);
    actions.appendChild(rightGroup);
    preview.appendChild(actions);
    card.appendChild(preview);

    card.addEventListener('click', (e) => {
      if (e.target.closest('button, input, textarea')) return;
      _expandBuiltinCard(card, b.name);
    });
    return card;
  });
}

async function _expandBuiltinCard(card, name) {
  const grid = card.closest('.doclib-grid');
  if (card.classList.contains('doclib-card-expanded')) {
    card.classList.remove('doclib-card-expanded');
    return;
  }
  if (grid) grid.querySelectorAll('.doclib-card-expanded').forEach(c => c.classList.remove('doclib-card-expanded'));
  card.classList.add('doclib-card-expanded');
  if (grid) grid.scrollTop = 0;
  const pre = card.querySelector('.skill-md-pre');
  if (pre && !card._loaded) {
    pre.textContent = 'Loading…';
    try {
      const res = await fetch(`${API}/api/skills/builtin/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      pre.textContent = data.text || '(empty)';
      card._loaded = true;
      card._text = data.text || '';
      card._default = data.default || '';
    } catch (e) {
      pre.textContent = 'Failed to load.';
    }
  }
}

function _toggleBuiltinEdit(card, name) {
  const preview = card.querySelector('.skill-card-preview');
  if (!preview) return;
  if (preview.querySelector('.skill-md-editor')) { _saveBuiltinEdit(card, name); return; }
  const pre = preview.querySelector('.skill-md-pre');
  const ta = document.createElement('textarea');
  ta.className = 'skill-md-editor';
  ta.spellcheck = false;
  ta.value = (card._text != null ? card._text : (pre ? pre.textContent : '')) || '';
  ta.addEventListener('click', (e) => e.stopPropagation());
  if (pre) pre.style.display = 'none';
  preview.insertBefore(ta, preview.querySelector('.doclib-card-expanded-actions'));
  ta.focus();
  const editBtn = [...preview.querySelectorAll('.doclib-card-action-btn')].find(b => /Edit|Save/.test(b.textContent));
  if (editBtn) editBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Save';
}

async function _saveBuiltinEdit(card, name) {
  const ta = card.querySelector('.skill-md-editor');
  if (!ta) return;
  try {
    const res = await fetch(`${API}/api/skills/builtin/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ta.value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    uiModule.showToast('Built-in capability updated');
    builtinSkills = [];  // 强制重新加载内置列表（刷新“已编辑”徽章）
    await loadSkills();
  } catch (e) { uiModule.showError('Save failed: ' + e.message); }
}

async function _revertBuiltin(name) {
  if (!(await uiModule.styledConfirm(`Revert "${name}" to its original built-in instructions?`, { confirmText: 'Revert', danger: true }))) return;
  try {
    const res = await fetch(`${API}/api/skills/builtin/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    uiModule.showToast('Reverted to default');
    builtinSkills = [];
    await loadSkills();
  } catch (e) { uiModule.showError('Revert failed: ' + e.message); }
}

function _getFilteredSkills() {
  const query = (document.getElementById('skills-search')?.value || '').toLowerCase();
  let filtered = query ? skills.filter(sk => _matches(sk, query)) : skills;
  if (_showDraftsOnly) {
    filtered = filtered.filter(sk => (sk.status || 'draft') !== 'published');
  }
  if (_showPublishedOnly) {
    filtered = filtered.filter(sk => (sk.status || 'draft') === 'published');
  }
  if (_confMax != null) {
    // "≤ X%" — 显示可能需要审查的低置信度技能。
    filtered = filtered.filter(sk => Math.round((sk.confidence || 0) * 100) <= _confMax);
  }
  return _sortSkills(filtered);
}

function renderSkillsList() {
  const container = document.getElementById('skills-list');
  if (!container) return;
  // 重新渲染会重建卡片（无展开的卡片），所以清除展开标志
  // 否则会在没有扩展内容时保持工具栏隐藏。
  container.closest('.admin-card')?.classList.remove('skills-has-expanded');

  const sorted = _getFilteredSkills();
  // 内置能力作为其自己的只读分区显示（当用户过滤到草稿时跳过，
  // 因为内置能力不是草稿）。
  // 技能菜单仅显示用户自己的技能（内置能力
  // 故意不在此处显示）。
  const showBuiltin = false;

  if (!sorted.length && !showBuiltin) {
    const selectBtn = document.getElementById('skills-select-btn');
    if (selectBtn) selectBtn.disabled = true;
    if (_selectMode) _exitSelectMode();
    container.innerHTML = `<div style="text-align:center;opacity:0.4;padding:24px 0;font-size:11px;">${loaded ? 'No skills yet, use agent for it to auto extract them.' : 'Loading…'}</div>`;
    return;
  }

  const selectBtn = document.getElementById('skills-select-btn');
  if (selectBtn) selectBtn.disabled = false;

  // 库风格的卡片：紧凑的横条在原地展开以显示
  // SKILL.md，带有底部栏（删除在左；编辑/运行/批准在右）。
  // 复用已验证的 .doclib-card / .doclib-card-preview /
  // .doclib-card-expanded-actions 标记，使桌面端+移动端展开 +
  // 底部栏行为与文档/聊天库完全一致。
  //
  // #skills-list 本身变成 .doclib-grid（而非嵌套的网格），
  // 以便全局规则“当卡片展开时隐藏非网格子元素”
  // (.admin-card:has(.doclib-card-expanded) > *:not(.doclib-grid))
  // 不会将列表容器一起隐藏。
  container.classList.add('doclib-grid');
  const cards = [];
  const dupeMeta = _duplicateMeta(sorted);

  for (const sk of sorted) {
    const name = sk.name || sk.id;
    const dm = dupeMeta.get(name);
    if (dm) {
      sk._duplicateGroup = dm.group;
      sk._duplicateKeep = dm.keep;
      sk._duplicateKeepName = dm.keepName;
      sk._duplicateNames = dm.names;
    } else {
      delete sk._duplicateGroup;
      delete sk._duplicateKeep;
      delete sk._duplicateKeepName;
      delete sk._duplicateNames;
    }
    const conf = Math.round((sk.confidence || 0) * 100);
    const uses = sk.uses || 0;
    const isPublished = (sk.status === 'published');
    const confColor = _confColor(conf);

    const card = document.createElement('div');
    card.className = 'doclib-card skill-card';
    card.dataset.skillName = name;
    card.dataset.skillStatus = sk.status || 'draft';

    const checked = _selectedNames.has(name) ? 'checked' : '';
    const cbHtml = _selectMode
      ? `<input type="checkbox" class="memory-select-cb skill-select-cb" data-name="${esc(name)}" ${checked} style="margin-right:6px;flex-shrink:0;cursor:pointer;" />`
      : '';

    // 折叠的头部栏：圆点 · 名称（换行）· [徽章（右侧）· 统计 · 菜单]。
    const header = document.createElement('div');
    header.className = 'doclib-card-header skill-card-header';
    header.innerHTML = `
      ${cbHtml}
      ${_auditDot(sk)}
      <div class="skill-card-textcol">
        <code class="skill-card-name">${esc(name)}</code>
        ${sk.description ? `<div class="skill-card-desc">${esc(sk.description)}</div>` : ''}
      </div>
      <div class="skill-card-right">
        ${_statusPill(sk)}
        ${_sourcePill(sk)}
        ${_auditModelPills(sk)}
        ${_necessityPill(sk)}
        ${_duplicatePriorityPill(sk)}
        <span class="skill-stats">${_auditMarks(sk)}<span class="skill-conf" style="color:${confColor};">${conf}%</span> · ${uses}u</span>
        <span class="skill-chevron-up" title="Collapse"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></span>
        <button class="skill-kebab-btn" title="Actions" aria-label="Actions"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>
      </div>
    `;
    card.appendChild(header);

    // Kebab 下拉菜单（折叠栏快捷操作：与展开的底部栏
    // 相同的操作 + 图标）。点击 kebab 打开它；不会展开卡片。
    header.querySelector('.skill-kebab-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      _openSkillMenu(e.currentTarget, card, sk, name, isPublished);
    });

    // 预览（展开前隐藏）— SKILL.md 放在这里 + 底部栏。
    const preview = document.createElement('div');
    preview.className = 'doclib-card-preview skill-card-preview';
    const pre = document.createElement('pre');
    pre.className = 'skill-md-pre';
    pre.textContent = '';  // 展开时填充
    preview.appendChild(pre);

    // 底部栏：左侧为批准/取消发布，右侧为破坏性删除。
    const actions = document.createElement('div');
    actions.className = 'doclib-card-expanded-actions';

    const delBtn = document.createElement('button');
    delBtn.className = 'doclib-card-text-btn doclib-card-action-btn doclib-card-text-btn-danger';
    delBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>Delete';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); _deleteSkill(name, card); });

    const editBtn = document.createElement('button');
    editBtn.className = 'doclib-card-text-btn doclib-card-action-btn';
    editBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' + t('skills.edit');
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); _toggleSkillEdit(card, name); });

    const pubBtn = document.createElement('button');
    pubBtn.className = 'doclib-card-text-btn doclib-card-action-btn';
    if (isPublished) {
      pubBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12l5 5L20 7"/></svg>Unpublish';
      pubBtn.title = 'Move back to draft';
      pubBtn.addEventListener('click', (e) => { e.stopPropagation(); _setSkillStatus(name, 'draft'); });
    } else {
      pubBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>Publish';
      pubBtn.title = 'Publish — appears in the skills index';
      pubBtn.style.color = 'var(--color-success, #4caf50)';
      pubBtn.addEventListener('click', (e) => { e.stopPropagation(); _setSkillStatus(name, 'published'); });
    }

    // 测试/审计这一个技能 — 与 kebab 中相同的操作，放在
    // 底部栏中以免被埋在“⋯”菜单下。
    const testBtn = document.createElement('button');
    testBtn.className = 'doclib-card-text-btn doclib-card-action-btn';
    testBtn.innerHTML = _svg(_ICON.test, { size: 11 }) + 'Test';
    testBtn.title = 'Test this skill — run it + AI judge';
    testBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 即时视觉反馈：之前点击后看起来像没反应，因为
      // _testSkill 在等待状态获取才覆盖预览 —
      // 所以用户会再点一次。立即将按钮标记为
      // “等待中”以确保第一次点击被明确注册。
      if (testBtn.dataset.busy === '1') return;  // 同时防止双击
      testBtn.dataset.busy = '1';
      testBtn.disabled = true;
      const _origHTML = testBtn.innerHTML;
      testBtn.innerHTML = _svg(_ICON.test, { size: 11 }) + 'Starting…';
      Promise.resolve(_testSkill(card, name)).finally(() => {
        // 预览被 _testSkill 覆盖，它会移除 testBtn 从 DOM。
        // 下面的清理仅在按钮仍存在时有意义
        // （例如 _testSkill 提早退出时）。
        if (document.body.contains(testBtn)) {
          testBtn.disabled = false;
          testBtn.dataset.busy = '';
          testBtn.innerHTML = _origHTML;
        }
      });
    });

    const rightGroup = document.createElement('div');
    rightGroup.className = 'doclib-action-group';
    const btnRow = document.createElement('div');
    btnRow.className = 'doclib-action-btn-row';
    btnRow.appendChild(testBtn);
    btnRow.appendChild(editBtn);
    btnRow.appendChild(delBtn);
    rightGroup.appendChild(btnRow);

    actions.appendChild(pubBtn);
    actions.appendChild(rightGroup);
    preview.appendChild(actions);
    card.appendChild(preview);

    // 点击展开/折叠（除非在选择模式下 → 切换复选框）。
    card.addEventListener('click', (e) => {
      if (card._suppressNextClick) { card._suppressNextClick = false; return; }
      if (e.target.closest('button, input, textarea')) return;
      if (_selectMode) {
        const cb = card.querySelector('.skill-select-cb');
        if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
        return;
      }
      _expandSkillCard(card, name);
    });

    // 在卡片任意位置长按打开 kebab 下拉菜单 — 镜像
    // 文档库 + 大脑记忆模式。当触摸从按钮/输入框开始时跳过，
    // 以便各控件处理程序继续工作。
    {
      const kebab = header.querySelector('.skill-kebab-btn');
      let hold = null;
      let start = null;
      const _lpCancel = () => { if (hold) { clearTimeout(hold); hold = null; } start = null; };
      card.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.skill-kebab-btn, .skill-select-cb, button, input, textarea')) return;
        start = { x: e.clientX, y: e.clientY };
        hold = setTimeout(() => {
          hold = null;
          card._suppressNextClick = true;
          setTimeout(() => { card._suppressNextClick = false; }, 400);
          if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
          if (kebab) kebab.click();
        }, 500);
      });
      card.addEventListener('pointermove', (e) => {
        if (!start) return;
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) _lpCancel();
      });
      card.addEventListener('pointerup', _lpCancel);
      card.addEventListener('pointercancel', _lpCancel);
    }

    cards.push(card);
  }
  container.innerHTML = '';

  // 两个可折叠的分区 — “你的技能”和“内置能力”。标题和
  // 卡片都是网格的直接子元素（卡片带有 data-skill-section 标签），
  // 以便全局展开规则 — 通过直接子选择器隐藏兄弟元素 —
  // 继续正常工作。
  // 折叠只是切换带标签卡片的显示状态。
  const _mkSectionHeader = (sectionId, title, count) => {
    const collapsed = _collapsedSections.has(sectionId);
    const hdr = document.createElement('div');
    hdr.className = 'skills-section-label skills-section-header' + (collapsed ? ' collapsed' : '');
    hdr.dataset.section = sectionId;
    hdr.innerHTML =
      `<svg class="skills-section-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
      `<span>${esc(title)}</span>` +
      `<span class="skills-section-count">${count}</span>`;
    hdr.addEventListener('click', () => {
      if (_collapsedSections.has(sectionId)) _collapsedSections.delete(sectionId);
      else _collapsedSections.add(sectionId);
      _saveCollapsedSections();
      _applySectionCollapse(container);
    });
    return hdr;
  };

  // “你的技能”分区 — 仅在也有内置分区时显示标题，
  // 以便区分（否则只是一个列表）。
  if (cards.length) {
    if (showBuiltin) container.appendChild(_mkSectionHeader('user', 'Your skills', cards.length));
    cards.forEach(c => { c.dataset.skillSection = 'user'; container.appendChild(c); });
  }

  // 内置能力 — 只读卡片（代理的原生工具）。
  if (showBuiltin) {
    const builtinCards = _buildBuiltinCards();
    container.appendChild(_mkSectionHeader('builtin', 'Built-in capabilities', builtinCards.length));
    builtinCards.forEach(c => { c.dataset.skillSection = 'builtin'; container.appendChild(c); });
  }

  _applySectionCollapse(container);

  // 当技能标签页（重新）打开时的多米诺入场动画 — 与文档/聊天库
  // 使用的同样精致的错开入场动画（.doclib-just-opened
  // → 每个 .doclib-card 子元素上的 section-domino-in）。仅消耗在
  // 标签页打开时设置的标志，使搜索/排序/编辑重新渲染时保持即时。
  if (_cascadeNext && cards.length) {
    _cascadeNext = false;
    _playSkillsCascade(container);
  }

  // 选择模式复选框配线（card-body 点击在卡片
  // 自己的点击监听器中处理）。
  if (_selectMode) {
    container.querySelectorAll('.skill-select-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const name = cb.dataset.name;
        if (cb.checked) _selectedNames.add(name); else _selectedNames.delete(name);
        const all = document.getElementById('skills-select-all');
        if (all) {
          const visible = _getFilteredSkills().map(s => s.name || s.id);
          all.checked = visible.length > 0 && visible.every(n => _selectedNames.has(n));
        }
        _updateBulkBar();
      });
    });
  }

  // 不要急切加载所有可见的 SKILL.md。在大型技能库中，这会
  // 在应用启动时创建数十个同时的 /api/skills/<name>/markdown 请求，
  // 可能会压跨 uvicorn。Markdown 在卡片展开时懒加载。
  // 展开时懒加载。
}

// ---- 卡片展开 / 编辑 / 操作 ----

// 折叠已展开的技能卡片：移除类名并清除内联
// 高度（否则折叠的卡片会保持
// 完整的展开高度）并移除其 resize 监听器。
function _collapseSkillCardEl(c) {
  c.classList.remove('doclib-card-expanded', 'skill-expand-instant');
  c.style.removeProperty('height');
  const pv = c.querySelector('.doclib-card-preview');
  const pr = c.querySelector('.skill-md-pre') || c.querySelector('.skill-md-editor');
  if (pv) { pv.style.removeProperty('height'); pv.style.removeProperty('flex'); pv.style.removeProperty('max-height'); }
  if (pr) { pr.style.removeProperty('height'); pr.style.removeProperty('flex'); }
  if (c._fillH) window.removeEventListener('resize', c._fillH);
}

async function _expandSkillCard(card, name) {
  const grid = card.closest('.doclib-grid');
  const adminCard = card.closest('.admin-card');
  // 如果已打开则切换折叠。
  if (card.classList.contains('doclib-card-expanded')) {
    _collapseSkillCardEl(card);
    if (adminCard) adminCard.classList.remove('skills-has-expanded');
    return;
  }
  // 我们是否已经显示了另一张已展开的卡片？如果是，这是一个切换，
  // 而非新开启 — 跳过淡入动画。淡入会显示叠在
  // 新卡片后面折叠的旧卡片（半透明），看起来像跳跃。
  const switching = !!(grid && grid.querySelector('.doclib-card-expanded'));
  // 折叠任何其他已展开的兄弟元素（完整清理，不仅是类名）。
  if (grid) grid.querySelectorAll('.doclib-card-expanded').forEach(_collapseSkillCardEl);
  card.classList.add('doclib-card-expanded');
  if (switching) card.classList.add('skill-expand-instant');
  // 在 admin-card 上显式设置类名，使 CSS 不依赖 :has()
  // （Firefox 移动端版本没有 :has 支持，导致展开只有约 50%）。
  if (adminCard) adminCard.classList.add('skills-has-expanded');
  if (grid) grid.scrollTop = 0;

  // Firefox 不会将绝对定位卡片的拉伸高度（inset:0）
  // 或 height:100% 视为确定的，所以 grid/flex 子元素不会填充。
  // 钉住显式的 px 高度 = 卡片已渲染的高度。px 值
  // 是明确确定的，所以预览 + <pre> 最终能填充。
  card._fillH = () => {
    // 重置任何之前的内联高度，以便我们先测量自然盒子
    // （并且切换桌面端<→移动端时不会留下过时的 px 值）。
    card.style.removeProperty('height');
    const preview = card.querySelector('.doclib-card-preview');
    const header = card.querySelector('.skill-card-header');
    const pre = card.querySelector('.skill-md-pre') || card.querySelector('.skill-md-editor');
    if (preview) { preview.style.removeProperty('height'); preview.style.removeProperty('flex'); preview.style.removeProperty('max-height'); }
    if (pre) { pre.style.removeProperty('height'); pre.style.removeProperty('flex'); }

    // px 钉住仅适用于移动端布局（position:absolute fill，
    // Firefox 无法传播确定的高度）。在桌面端，卡片
    // 通过正常的 flex/flow 展开 — 在那里钉住测量的高度只会
    // 导致尺寸过小。所以在桌面端退出，让 CSS 处理。
    if (!window.matchMedia('(max-width: 768px)').matches) return;

    const cardH = card.getBoundingClientRect().height;
    if (cardH <= 0) return;
    card.style.setProperty('height', cardH + 'px', 'important');
    if (!preview) return;

    const px = (el, prop) => parseFloat(getComputedStyle(el)[prop]) || 0;
    const headerH = header ? header.getBoundingClientRect().height : 0;
    const cardPad = px(card, 'paddingTop') + px(card, 'paddingBottom');
    const previewH = Math.max(0, cardH - headerH - cardPad);
    // 强制预览使用显式高度（flex:none 以便没有东西与之冲突）。
    // 之前的 max-height（约 335px，由 % 规则解析）限制了它 — 清除它。
    preview.style.setProperty('flex', '0 0 auto', 'important');
    preview.style.setProperty('max-height', 'none', 'important');
    preview.style.setProperty('height', previewH + 'px', 'important');

    if (pre) {
      // Pre = 预览高度减去其非 pre 兄弟元素（底部栏、警告横幅）。
      const prevPad = px(preview, 'paddingTop') + px(preview, 'paddingBottom');
      let siblings = 0;
      for (const child of preview.children) {
        if (child !== pre) siblings += child.getBoundingClientRect().height;
      }
      const preH = Math.max(0, previewH - prevPad - siblings);
      pre.style.setProperty('height', preH + 'px', 'important');
      pre.style.setProperty('flex', '0 0 auto', 'important');
    }
  };
  // 同步尺寸调整（不是 rAF）以便钉住的高度在浏览器第一帧
  // 绘制展开卡片之前就就位。在一帧之后运行会
  // 让第一帧以内容高度绘制，然后突变 — 这就是
  // 第一次展开时出现的“爆炸”效果（当 SKILL.md 还在加载时）。
  card._fillH();
  window.addEventListener('resize', card._fillH);

  const pre = card.querySelector('.skill-md-pre');
  if (pre && !card._mdLoaded) {
    // 如果缓存可用则使用它（后台预加载通常已经有了），
    // 以便内容同步就位 — 无异步稳定/跳跃。
    if (_mdCache.has(name)) {
      const md = _mdCache.get(name);
      pre.textContent = md || '(empty)';
      card._mdLoaded = true;
      card._md = md || '';
    } else {
      pre.textContent = 'Loading…';
      try {
        const md = await _fetchSkillMarkdown(name);
        pre.textContent = md || '(empty)';
        card._mdLoaded = true;
        card._md = md;
      } catch (e) {
        pre.textContent = 'Failed to load SKILL.md';
      }
    }
  }
}

// 将只读的 <pre> 替换为可编辑的 <textarea>（以及反向操作）。
// “编辑”按钮切换；“保存”按钮通过 markdown 端点提交。
function _toggleSkillEdit(card, name) {
  const preview = card.querySelector('.skill-card-preview');
  if (!preview) return;
  const existing = preview.querySelector('.skill-md-editor');
  if (existing) {
    // 已在编辑中 — 将“编辑”视为“保存”。
    _saveSkillEdit(card, name);
    return;
  }
  const pre = preview.querySelector('.skill-md-pre');
  const ta = document.createElement('textarea');
  ta.className = 'skill-md-editor';
  ta.spellcheck = false;
  ta.value = (card._md != null ? card._md : (pre ? pre.textContent : '')) || '';
  ta.addEventListener('click', (e) => e.stopPropagation());
  if (pre) pre.style.display = 'none';
  preview.insertBefore(ta, preview.querySelector('.doclib-card-expanded-actions'));
  ta.focus();
  // 将“编辑”按钮标签改为“保存”。
  const editBtn = [...preview.querySelectorAll('.doclib-card-action-btn')].find(b => /Edit|Save/.test(b.textContent));
  if (editBtn) editBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Save';
}

async function _saveSkillEdit(card, name) {
  const preview = card.querySelector('.skill-card-preview');
  const ta = preview?.querySelector('.skill-md-editor');
  if (!ta) return;
  try {
    const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}/markdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: ta.value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 刷新缓存的 markdown 以便预加载/展开显示新文本。
    _mdCache.set(name, ta.value);
    uiModule.showToast('Saved');
    await loadSkills();  // 重新渲染（frontmatter 变化如名称/状态可能已经改变）
  } catch (e) {
    uiModule.showError('Save failed: ' + e.message);
  }
}

async function _deleteSkill(name, card = null) {
  if (!(await uiModule.styledConfirm(`Delete skill "${name}"? This removes the SKILL.md.`, { confirmText: 'Delete', danger: true }))) return;
  // 如果调用者没有传递卡片，则定位卡片，以便我们可以
  // 优雅地折叠它（与文档库相同的 fade+shrink 效果），
  // 而不是重新渲染整个列表。
  if (!card) {
    card = [...document.querySelectorAll('.skill-card')]
      .find(c => { const n = c.querySelector('.skill-card-name'); return n && n.textContent === name; }) || null;
  }
  try {
    await fetch(`${API}/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
    _mdCache.delete(name);
    if (card) {
      if (card._testPoll) { clearInterval(card._testPoll); card._testPoll = null; }
      _setCardRunning(card, false);
      card.classList.add('doclib-card-deleting');
      card.addEventListener('transitionend', () => card.remove(), { once: true });
      setTimeout(() => { if (card.parentElement) card.remove(); }, 400);
    }
    await loadSkills();
    uiModule.showToast('Skill deleted');
  } catch (e) { uiModule.showError('Delete failed: ' + e.message); }
}

async function _setSkillStatus(name, status) {
  try {
    await fetch(`${API}/api/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    await loadSkills();
    uiModule.showToast(status === 'published' ? 'Skill approved' : 'Skill moved to draft');
  } catch (e) { uiModule.showError('Update failed: ' + e.message); }
}

// ---- 测试技能（沙盒代理运行 + AI 评估） ----

async function _fetchTestStatus(name) {
  try {
    const r = await fetch(`${API}/api/skills/${encodeURIComponent(name)}/test-status`);
    return r.ok ? await r.json() : { status: 'none' };
  } catch { return { status: 'none' }; }
}

function _renderTestLog(logEl, verdictEl, job, card, name) {
  if (!logEl) return;
  logEl.innerHTML = '';
  const add = (txt, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = txt; logEl.appendChild(d); };
  for (const ev of (job.log || [])) {
    if (ev.type === 'skill_test_start') { add('Task: ' + ev.task, 'skill-test-task'); add('Model: ' + ev.model, 'skill-test-meta'); }
    else if (ev.type === 'agent_step') add('— round ' + ev.round + ' —', 'skill-test-round');
    else if (ev.type === 'tool_start') add('▸ ' + ev.tool + '  ' + String(ev.command || '').slice(0, 200), 'skill-test-tool');
    else if (ev.type === 'tool_output') add(String(ev.output || '').slice(0, 500), 'skill-test-out');
    else if (ev.type === 'say') add(ev.text || '', 'skill-test-say');
    else if (ev.type === 'evaluating') add('Evaluating run…', 'skill-test-meta');
    else if (ev.type === 'error') add('Error: ' + (ev.error || 'run failed'), 'skill-test-err');
  }
  if (job.status === 'running') add('…running (you can close this — it keeps going)', 'skill-test-meta');
  logEl.scrollTop = logEl.scrollHeight;
  if (job.status === 'done' && job.verdict) _renderTestVerdict(verdictEl, job.verdict, card, name);
  else if (verdictEl) verdictEl.innerHTML = '';
}

// `force` = 即使已有完成的结果也启动全新运行（重试）。
async function _testSkill(card, name, force = false) {
  if (!card.classList.contains('doclib-card-expanded')) await _expandSkillCard(card, name);
  const preview = card.querySelector('.skill-card-preview');
  if (!preview) return;
  preview.innerHTML =
    '<div class="skill-test"><div class="skill-test-log"></div>' +
    '<div class="skill-test-verdict"></div></div>';
  const logEl = preview.querySelector('.skill-test-log');
  const verdictEl = preview.querySelector('.skill-test-verdict');
  if (card._testPoll) { clearInterval(card._testPoll); card._testPoll = null; }

  // 附加到现有任务，除非强制重新运行。
  let job = force ? { status: 'none' } : await _fetchTestStatus(name);

  if (job.status === 'none') {
    logEl.innerHTML = '<div class="skill-test-meta">Starting test…</div>';
    let model = '', endpoint_url = '';
    try {
      const sm = window.sessionModule;
      model = (sm && sm.getCurrentModel && sm.getCurrentModel()) || '';
      endpoint_url = (sm && sm.getCurrentEndpointUrl && sm.getCurrentEndpointUrl()) || '';
    } catch (_) {}
    try {
      const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, endpoint_url }),
      });
      if (!res.ok) { logEl.innerHTML = '<div class="skill-test-err">Test failed: HTTP ' + res.status + '</div>'; return; }
    } catch (e) { logEl.innerHTML = '<div class="skill-test-err">Test failed: ' + (e.message || e) + '</div>'; return; }
    job = await _fetchTestStatus(name);
  }

  _renderTestLog(logEl, verdictEl, job, card, name);
  _setCardRunning(card, job.status === 'running');

  if (job.status === 'running') {
    card._testPoll = setInterval(async () => {
      // 即使卡片已折叠也继续轮询（测试在服务器端运行）；
      // 只有当卡片本身从 DOM 中消失时才停止。
      if (!document.body.contains(card)) { clearInterval(card._testPoll); card._testPoll = null; _setCardRunning(card, false); return; }
      const s = await _fetchTestStatus(name);
      // 仅在日志仍在屏幕上时更新展开的日志。
      if (document.body.contains(logEl)) _renderTestLog(logEl, verdictEl, s, card, name);
      if (s.status !== 'running') {
        clearInterval(card._testPoll); card._testPoll = null;
        _setCardRunning(card, false);
        // 如果日志不可见（卡片已折叠），仍然更新
        // 头部圆点/% 以便结果显示在折叠的卡片上。
        if (!document.body.contains(logEl) && s.verdict && s.verdict.verdict) {
          _applyVerdictToHeader(card, s.verdict.verdict);
        }
      }
    }, 1300);
  }
}

// 在测试进行时，在技能名称旁显示/隐藏应用级的漩涡加载图标。
// 在折叠的头部上也能工作，因为我们注入的是真实的 DOM
// 元素而非 CSS 伪类。
function _setCardRunning(card, on) {
  if (!card) return;
  card.classList.toggle('skill-test-running', !!on);
  if (on) {
    if (card._testSpinner) return;
    const nameEl = card.querySelector('.skill-card-name');
    if (!nameEl) return;
    const wp = spinnerModule.createWhirlpool(12);
    wp.element.style.cssText = 'display:inline-flex;width:12px;height:12px;margin:0 0 0 7px;vertical-align:middle;flex-shrink:0;';
    // 追加到 <code> 名称内部（inline-flow），而非其后面。textcol
    // 是 flex column，所以后面的兄弟元素会独占一行 —
    // 将 spinner 放在内联 code 内使其保持在标题行上。
    nameEl.appendChild(wp.element);
    card._testSpinner = wp;
  } else if (card._testSpinner) {
    try { card._testSpinner.destroy(); } catch (_) {}
    if (card._testSpinner.element && card._testSpinner.element.parentElement) {
      card._testSpinner.element.remove();
    }
    card._testSpinner = null;
  }
}

// 在（可能已折叠的）卡片头部上反映测试/审计结果，无需
// 完整重新加载：发光的审计圆点、置信度% 和通过勾号。
// 无论卡片是展开还是折叠都能工作，以便在你折叠后完成的测试
// 仍然能更新卡片。
function _applyVerdictToHeader(card, verdict) {
  if (!card || !verdict) return;
  const dotColor = {
    pass: 'var(--color-success, #4ade80)',
    needs_work: 'var(--color-warning, #f0ad4e)',
    inconclusive: 'var(--color-warning, #f0ad4e)',
    fail: 'var(--color-danger, #e06c75)',
  }[verdict];
  // 应用户要求已移除审计圆点 — 删除任何既存的，以便
  // 审计后的实时更新不会留下旧渲染的过时圆点。
  const header = card.querySelector('.skill-card-header');
  if (header) {
    header.querySelectorAll('.skill-audit-dot').forEach(n => n.remove());
  }
  const newConf = { pass: 95, needs_work: 60, fail: 40 }[verdict];
  const statsEl = card.querySelector('.skill-stats');
  if (statsEl && newConf != null) {
    const confEl = statsEl.querySelector('.skill-conf');
    if (confEl) { confEl.textContent = newConf + '%'; confEl.style.color = _confColor(newConf); }
  }
  // 将结果折叠到状态（草稿/已发布）徽章中 — 着色
  // 徽章本身并附加小型勾号/警告/叉号图标，以便审计结果
  // 位于标签旁边而非悬挂在统计行中。
  const pill = card.querySelector('.skill-status-pill');
  if (pill) {
    // 每个结果徽章的内联图标 — 显示在“已检查”
    // 标签旁边，使结果看起来像真实的徽章。
    const ICON = {
      pass: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="20 6 9 17 4 12"/></svg>',
      needs_work: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
      inconclusive: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
      fail: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    }[verdict];
    // 洗刧徽章背景 + 着色文本，使一眼就能从徽章看出
    // 通过/需修改/失败，无需展开卡片。
    const tint = {
      pass:       { bg: 'color-mix(in srgb, var(--color-success, #4ade80) 30%, transparent)', fg: 'var(--color-success, #4ade80)' },
      needs_work: { bg: 'color-mix(in srgb, var(--color-warning, #f0ad4e) 30%, transparent)', fg: 'var(--color-warning, #f0ad4e)' },
      inconclusive: { bg: 'color-mix(in srgb, var(--color-warning, #f0ad4e) 30%, transparent)', fg: 'var(--color-warning, #f0ad4e)' },
      fail:       { bg: 'color-mix(in srgb, var(--color-danger, #e06c75) 30%, transparent)',  fg: 'var(--color-danger, #e06c75)' },
    }[verdict];
    // 状态徽章（草稿/已发布）现在保持其自己的颜色 —
    // 结果位于插入在其旁边的单独“已检查”徽章中。
    // 移除任何之前的审计图标（之前是插入在徽章内部的；
    // 现在每次刷新都清除徽章内部和兄弟位置的图标）。
    pill.querySelectorAll('.skill-pill-verdict').forEach(n => n.remove());
    if (pill.parentElement) {
      pill.parentElement.querySelectorAll(':scope > .skill-pill-verdict').forEach(n => n.remove());
    }
    if (ICON) {
      // 完整的“已检查”徽章 — 位于草稿/已发布徽章左侧，
      // 样式与其他 memory-cat-badges 一致，看起来像真实的芯片。
      const span = document.createElement('span');
      span.className = 'memory-cat-badge skill-pill-verdict';
      span.title = 'Audited: ' + verdict.replace(/_/g, ' ');
      span.innerHTML = ICON + '<span>checked</span>';
      if (tint) {
        span.style.background = tint.bg;
        span.style.color = tint.fg;
      }
      if (pill.parentElement) {
        pill.parentElement.insertBefore(span, pill);
      } else {
        pill.insertAdjacentElement('beforebegin', span);
      }
    }
  }
  // 旧的浮动式 .skill-verified 勾号（在置信度% 旁边）不再
  // 添加 — 现在徽章承载了结果图标。删除旧版本
  // 渲染的过时徽章，以防卡片是由早期版本渲染的。
  card.querySelectorAll('.skill-verified').forEach(n => n.remove());
}

function _renderTestVerdict(el, v, card, name) {
  if (!el) return;
  const verdict = (v && v.verdict) || 'unknown';
  const cls = { pass: 'ok', needs_work: 'warn', fail: 'bad', inconclusive: 'unknown' }[verdict] || 'unknown';
  const label = { pass: 'PASS', needs_work: 'NEEDS WORK', fail: 'FAIL', inconclusive: 'INCONCLUSIVE', unknown: 'UNCLEAR' }[verdict] || 'UNCLEAR';
  const conf = v && typeof v.confidence === 'number' ? Math.round(v.confidence * 100) + '%' : '';
  const issues = Array.isArray(v && v.issues) ? v.issues : [];
  // 反映技能的当前状态：如果已经发布，按钮
  // 表示“已批准”（点击取消发布），而非提供批准选项。
  const isPub = card && card.dataset && card.dataset.skillStatus === 'published';
  const approveLabel = isPub ? 'Approved' : 'Approve';
  const approveCls = 'skill-eval-approve' + (isPub ? ' is-approved' : (verdict === 'pass' ? ' suggested' : ''));
  const approveTitle = isPub ? 'Already approved — click to unpublish' : 'Publish — appears in the skills index';
  el.innerHTML =
    '<div class="skill-eval-head"><span class="skill-eval-badge skill-eval-' + cls + '">' + label + (conf ? ' · ' + conf : '') + '</span>' +
    '<span class="skill-eval-summary">' + esc((v && v.summary) || '') + '</span></div>' +
    (issues.length ? '<ul class="skill-eval-issues">' + issues.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul>' : '') +
    '<div class="doclib-card-expanded-actions skill-eval-actions-wrap">' +
      '<button class="doclib-card-text-btn doclib-card-action-btn ' + approveCls + '" data-act="approve" title="' + approveTitle + '">' + approveLabel + '</button>' +
      '<div class="doclib-action-group"><div class="doclib-action-btn-row">' +
        '<button class="doclib-card-text-btn doclib-card-action-btn" data-act="retry" title="Run the test again">Retry</button>' +
        '<button class="doclib-card-text-btn doclib-card-action-btn" data-act="copy" title="Copy the run output + verdict">Copy</button>' +
        '<button class="doclib-card-text-btn doclib-card-action-btn" data-act="edit">Edit</button>' +
        '<button class="doclib-card-text-btn doclib-card-action-btn doclib-card-text-btn-danger" data-act="del"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>Delete</button>' +
      '</div></div>' +
    '</div>';
  _applyVerdictToHeader(card, verdict);
  el.querySelector('[data-act="approve"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const nowPub = card.dataset.skillStatus === 'published';
    await _setSkillStatus(name, nowPub ? 'draft' : 'published');
    // _setSkillStatus reloads the list, but if this card survives, relabel it.
    card.dataset.skillStatus = nowPub ? 'draft' : 'published';
    const btn = el.querySelector('[data-act="approve"]');
    if (btn) {
      const pub = card.dataset.skillStatus === 'published';
      btn.textContent = pub ? 'Approved' : 'Approve';
      btn.title = pub ? 'Already approved — click to unpublish' : 'Publish — appears in the skills index';
      btn.classList.toggle('is-approved', pub);
      btn.classList.toggle('suggested', !pub && verdict === 'pass');
    }
  });
  el.querySelector('[data-act="del"]')?.addEventListener('click', (e) => { e.stopPropagation(); _deleteSkill(name, card); });
  el.querySelector('[data-act="edit"]')?.addEventListener('click', (e) => { e.stopPropagation(); _toggleSkillEdit(card, name); });
  el.querySelector('[data-act="retry"]')?.addEventListener('click', (e) => { e.stopPropagation(); _testSkill(card, name, true); });
  el.querySelector('[data-act="copy"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const logEl = card.querySelector('.skill-test-log');
    const issuesTxt = issues.length ? '\nIssues:\n- ' + issues.join('\n- ') : '';
    const text = (logEl ? logEl.innerText.trim() + '\n\n' : '') +
      '=== Eval: ' + label + (conf ? ' (' + conf + ')' : '') + ' ===\n' + ((v && v.summary) || '') + issuesTxt;
    // 共享辅助函数在纯 HTTP 环境下回退到 execCommand（navigator.clipboard
    // 在非安全上下文中不可用，这就是原始调用失败的原因）。
    uiModule.copyToClipboard(text);
  });
}

// ---- 审计所有技能（自主：测试 → 修正 → 重试 → 教师 → 标记） ----

let _auditPoll = null;
let _auditSeenResults = 0;

function _confirmAuditSkills(label) {
  return new Promise(resolve => {
    let overlay = document.getElementById('skills-audit-confirm-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'skills-audit-confirm-overlay';
      overlay.className = 'modal';
      overlay.innerHTML =
        '<div class="modal-content styled-confirm-box">' +
          '<div class="modal-header"><h4>Audit Skills</h4></div>' +
          '<div class="modal-body">' +
            '<p id="skills-audit-confirm-msg"></p>' +
            '<label class="memory-bulk-check-all" style="margin-top:10px;display:inline-flex;align-items:center;gap:7px;">' +
              '<input type="checkbox" id="skills-audit-skip-audited" checked />' +
              '<span>Skip already audited</span>' +
            '</label>' +
          '</div>' +
          '<div class="modal-footer">' +
            '<button id="skills-audit-confirm-cancel" class="confirm-btn confirm-btn-secondary">Cancel</button>' +
            '<button id="skills-audit-confirm-ok" class="confirm-btn confirm-btn-primary">Audit</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
    }

    const msg = overlay.querySelector('#skills-audit-confirm-msg');
    const skip = overlay.querySelector('#skills-audit-skip-audited');
    const okBtn = overlay.querySelector('#skills-audit-confirm-ok');
    const cancelBtn = overlay.querySelector('#skills-audit-confirm-cancel');
    msg.textContent = `Audit ${label}? Each is tested from top to bottom, then published or moved to draft using your auto-approve confidence threshold.`;
    skip.checked = true;
    overlay.classList.remove('hidden');
    overlay.style.display = '';

    function cleanup(result) {
      overlay.classList.add('hidden');
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk() { cleanup({ ok: true, skipAudited: !!skip.checked }); }
    function onCancel() { cleanup({ ok: false, skipAudited: false }); }
    function onBackdrop(e) { if (e.target === overlay) onCancel(); }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanup({ ok: false, skipAudited: false });
      }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    okBtn.focus();
  });
}

async function _auditAllSkills(opts = {}) {
  const panel = document.getElementById('skills-audit-panel');
  if (!panel) return;
  // 如果已有运行在进行，只需（重新）附加到它。
  let st = await _fetchAuditStatus();
  if (st.status !== 'running') {
    const explicitNames = Array.isArray(opts.names) ? opts.names.filter(Boolean) : null;
    const visibleNames = _getFilteredSkills()
      .map(sk => sk.name || sk.id)
      .filter(Boolean);
    const names = explicitNames || visibleNames;
    const label = explicitNames
      ? `${names.length} selected ${names.length === 1 ? 'skill' : 'skills'}`
      : `${names.length} visible ${names.length === 1 ? 'skill' : 'skills'}`;
    if (!names.length) {
      uiModule.showToast(explicitNames ? 'No selected skills to audit' : 'No visible skills to audit');
      return;
    }
    const confirmed = await _confirmAuditSkills(label);
    if (!confirmed.ok) return;
    try {
      const r = await fetch(`${API}/api/skills/audit-all`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: explicitNames ? 'selected' : 'all', names, skip_audited: confirmed.skipAudited }),
      });
      if (!r.ok) { uiModule.showError('Audit failed to start (HTTP ' + r.status + ')'); return; }
      st = await _fetchAuditStatus();
    } catch (e) { uiModule.showError('Audit failed: ' + (e.message || e)); return; }
    _auditSeenResults = 0;
  }
  panel.classList.remove('hidden');
  _auditSeenResults = Math.min(_auditSeenResults, (st.results || []).length);
  _renderAuditPanel(panel, st);
  _applyAuditResults(st);
  _highlightAuditCard(st.status === 'running' ? st.current : null);
  if (_auditPoll) clearInterval(_auditPoll);
  if (st.status === 'running') {
    _auditPoll = setInterval(async () => {
      const s = await _fetchAuditStatus();
      _renderAuditPanel(panel, s);
      _applyAuditResults(s);
      _highlightAuditCard(s.status === 'running' ? s.current : null);
      if (s.status !== 'running') {
        clearInterval(_auditPoll); _auditPoll = null;
        _highlightAuditCard(null);
        loadSkills();  // refresh statuses (some may have been demoted/edited)
      }
    }, 1500);
  }
}

function _findSkillCard(name) {
  if (!name) return null;
  return [...document.querySelectorAll('.skill-card[data-skill-name]')]
    .find(c => c.dataset.skillName === name) || null;
}

function _mergeSkillState(state) {
  if (!state || !state.name) return;
  const idx = skills.findIndex(s => (s.name || s.id) === state.name);
  if (idx >= 0) skills[idx] = { ...skills[idx], ...state };
}

function _applySkillStateToHeader(card, state, fallbackVerdict) {
  if (!card) return;
  const verdict = state?.audit_verdict || fallbackVerdict;
  if (verdict) _applyVerdictToHeader(card, verdict);
  if (state && typeof state.confidence === 'number') {
    const conf = Math.round(state.confidence * 100);
    const confEl = card.querySelector('.skill-conf');
    if (confEl) { confEl.textContent = conf + '%'; confEl.style.color = _confColor(conf); }
  }
  if (state?.status) {
    card.dataset.skillStatus = state.status;
    const oldPill = card.querySelector('.skill-status-pill');
    if (oldPill) {
      const wrap = document.createElement('span');
      wrap.innerHTML = _statusPill(state);
      const next = wrap.firstElementChild;
      if (next) oldPill.replaceWith(next);
    }
  }
  const right = card.querySelector('.skill-card-right');
  if (right && state) {
    right.querySelectorAll('.skill-model-pill, .skill-necessity-pill').forEach(n => n.remove());
    const stats = right.querySelector('.skill-stats');
    const wrap = document.createElement('span');
    wrap.innerHTML = _auditModelPills(state) + _necessityPill(state);
    [...wrap.children].forEach(p => {
      if (stats) right.insertBefore(p, stats);
      else right.appendChild(p);
    });
  }
}

function _applyAuditResults(st) {
  const results = st && Array.isArray(st.results) ? st.results : [];
  if (!results.length) return;
  for (const r of results.slice(_auditSeenResults)) {
    const name = r && r.skill;
    if (!name) continue;
    const state = r.skill_state || null;
    _mergeSkillState(state);
    const verdict = state?.audit_verdict || r.verdict?.verdict || (r.result === 'flagged' ? 'fail' : null);
    _applySkillStateToHeader(_findSkillCard(name), state, verdict);
  }
  _auditSeenResults = results.length;
}

// 使当前正在审计的卡片发光，以便清楚地看到
// "立即审计"运行正在处理哪个。传入 null 清除所有高亮。
function _highlightAuditCard(name) {
  document.querySelectorAll('.skill-card.skill-audit-active')
    .forEach(c => { c.classList.remove('skill-audit-active'); _setCardRunning(c, false); });
  if (!name) return;
  const card = _findSkillCard(name);
  if (card) {
    card.classList.add('skill-audit-active');
    _setCardRunning(card, true);
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

async function _fetchAuditStatus() {
  try {
    const r = await fetch(`${API}/api/skills/audit-all/status`);
    return r.ok ? await r.json() : { status: 'none' };
  } catch { return { status: 'none' }; }
}

function _renderAuditPanel(panel, st) {
  if (st.status === 'none') { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  const done = st.done || 0, total = st.total || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const counts = {};
  for (const r of (st.results || [])) counts[r.result] = (counts[r.result] || 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => v + ' ' + k.replace(/_/g, ' ')).join(' · ');
  const running = st.status === 'running';
  const cancelled = st.status === 'cancelled';
  const head = running
    ? `Auditing ${done}/${total}${st.current ? ' — ' + esc(st.current) : ''}`
    : cancelled
      ? `Audit cancelled — ${done}/${total}`
    : `Audit complete — ${total} skill${total === 1 ? '' : 's'}`;
  panel.innerHTML =
    '<div class="skills-audit-head">' +
      '<span class="skills-audit-title-wrap" style="display:inline-flex;align-items:center;gap:8px;">' +
        '<span class="skills-audit-title">' + head + '</span>' +
      '</span>' +
      (running
        ? '<button class="memory-toolbar-btn" data-act="audit-cancel">Cancel</button>'
        : '<button class="memory-toolbar-btn" data-act="audit-close">Close</button>') +
    '</div>' +
    '<div class="skills-audit-bar"><div class="skills-audit-fill" style="width:' + pct + '%"></div></div>' +
    (summary ? '<div class="skills-audit-summary">' + esc(summary) + (st.teacher ? ' · teacher: ' + esc(st.teacher) : '') + '</div>' : '') +
    '<div class="skills-audit-log">' + (st.log || []).slice(-40).map(l => '<div>' + esc(l) + '</div>').join('') + '</div>';
  // 审计实际运行时，漩涡图标显示在标题旁边。
  if (running) {
    const titleWrap = panel.querySelector('.skills-audit-title-wrap');
    if (titleWrap) {
      const wp = spinnerModule.createWhirlpool(12);
      wp.element.style.cssText = 'display:inline-flex;width:12px;height:12px;margin:0;vertical-align:middle;flex-shrink:0;';
      titleWrap.appendChild(wp.element);
    }
  }
  const cancel = panel.querySelector('[data-act="audit-cancel"]');
  if (cancel) cancel.addEventListener('click', async (e) => {
    e.stopPropagation();
    cancel.disabled = true;
    cancel.textContent = 'Cancelling...';
    try {
      await fetch(`${API}/api/skills/audit-all/cancel`, { method: 'POST', credentials: 'same-origin' });
      const s = await _fetchAuditStatus();
      _renderAuditPanel(panel, { ...s, status: s.status === 'none' ? 'cancelled' : s.status });
      _highlightAuditCard(null);
    } catch {
      cancel.disabled = false;
      cancel.textContent = 'Cancel';
    }
  });
  const close = panel.querySelector('[data-act="audit-close"]');
  if (close) close.addEventListener('click', () => { panel.classList.add('hidden'); panel.innerHTML = ''; });
  const logEl = panel.querySelector('.skills-audit-log');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

// ---- 选择模式 / 批量操作 ----

function _enterSelectMode() {
  _selectMode = true;
  _selectedNames.clear();
  const bar = document.getElementById('skills-bulk-bar');
  const btn = document.getElementById('skills-select-btn');
  if (bar) bar.classList.remove('hidden');
  if (btn) { btn.classList.add('active'); btn.textContent = 'Cancel'; }
  _updateBulkBar();
  renderSkillsList();
}

function _exitSelectMode() {
  _selectMode = false;
  _selectedNames.clear();
  const bar = document.getElementById('skills-bulk-bar');
  const btn = document.getElementById('skills-select-btn');
  const all = document.getElementById('skills-select-all');
  if (bar) bar.classList.add('hidden');
  if (btn) { btn.classList.remove('active'); btn.textContent = 'Select'; }
  if (all) all.checked = false;
  renderSkillsList();
}

function _updateBulkBar() {
  const countEl = document.getElementById('skills-selected-count');
  const delBtn = document.getElementById('skills-bulk-delete');
  const delNonPassingBtn = document.getElementById('skills-bulk-delete-nonpassing');
  const pubBtn = document.getElementById('skills-bulk-publish');
  const auditBtn = document.getElementById('skills-bulk-audit');
  if (countEl) countEl.textContent = `${_selectedNames.size} Selected`;
  if (delBtn) delBtn.disabled = _selectedNames.size === 0;
  if (auditBtn) auditBtn.disabled = _selectedNames.size === 0;
  if (delNonPassingBtn) {
    const count = _selectedNonPassingSkills().length;
    delNonPassingBtn.disabled = count === 0;
    delNonPassingBtn.title = count
      ? `Delete ${count} selected non-passing ${count === 1 ? 'skill' : 'skills'}`
      : 'No selected non-passing skills';
  }
  // 仅当至少有一个选中的技能仍是草稿时，批准才有意义。
  const anyDraft = [..._selectedNames].some(n => {
    const sk = skills.find(s => (s.name || s.id) === n);
    return sk && (sk.status || 'draft') !== 'published';
  });
  if (pubBtn) pubBtn.disabled = !anyDraft;
}

function _toggleSelectAll() {
  const all = document.getElementById('skills-select-all');
  if (!all) return;
  const visible = _getFilteredSkills().map(s => s.name || s.id);
  if (all.checked) visible.forEach(n => _selectedNames.add(n));
  else visible.forEach(n => _selectedNames.delete(n));
  _updateBulkBar();
  renderSkillsList();
}

async function _bulkDelete() {
  if (!_selectedNames.size) return;
  const n = _selectedNames.size;
  const ok = await uiModule.styledConfirm(
    `Delete ${n} ${n === 1 ? 'skill' : 'skills'}? This removes their SKILL.md files.`,
    { confirmText: 'Delete', danger: true }
  );
  if (!ok) return;
  let deleted = 0;
  const deletedNames = [];
  for (const name of _selectedNames) {
    try {
      const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (res.ok) {
        deleted++;
        deletedNames.push(name);
      }
    } catch {}
  }
  for (const name of deletedNames) {
    const card = document.querySelector(`.skill-card[data-skill-name="${CSS.escape(name)}"]`);
    if (card) card.classList.add('doclib-card-deleting');
  }
  if (deletedNames.length) await new Promise(resolve => setTimeout(resolve, 320));
  _exitSelectMode();
  await loadSkills();
  uiModule.showToast(`Deleted ${deleted}`);
}

async function _loadSkillApprovalThreshold() {
  try {
    const res = await fetch(`${API}/api/prefs`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const prefs = await res.json();
    const raw = prefs.skill_min_confidence ?? prefs.skill_autosave_min_confidence;
    const val = Number(raw);
    if (Number.isFinite(val)) _skillApprovalThreshold = Math.max(0, Math.min(1, val));
  } catch {}
}

function _selectedNonPassingSkills() {
  const selected = new Set(_selectedNames);
  return skills.filter(sk => {
    const name = sk.name || sk.id;
    if (!selected.has(name)) return false;
    const conf = Number(sk.confidence || 0);
    const necessity = _necessityKind(sk);
    if (necessity === 'duplicate' || necessity === 'trivial' || necessity === 'irrelevant') return true;
    if ((sk.audit_verdict || '') !== 'pass') return true;
    return conf < _skillApprovalThreshold;
  });
}

async function _bulkDeleteNonPassing() {
  const targets = _selectedNonPassingSkills();
  if (!targets.length) {
    uiModule.showToast('No selected non-passing skills');
    return;
  }
  const thresholdPct = Math.round(_skillApprovalThreshold * 100);
  const names = targets.map(sk => sk.name || sk.id).filter(Boolean);
  const ok = await uiModule.styledConfirm(
    `Delete ${names.length} selected non-passing ${names.length === 1 ? 'skill' : 'skills'}? This removes duplicates, generic/irrelevant skills, failed audits, and anything below ${thresholdPct}%.`,
    { confirmText: 'Delete non passing', danger: true }
  );
  if (!ok) return;
  let deleted = 0;
  const deletedNames = [];
  for (const name of names) {
    try {
      const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (res.ok) {
        deleted++;
        deletedNames.push(name);
        _mdCache.delete(name);
      }
    } catch {}
  }
  for (const name of deletedNames) {
    const card = document.querySelector(`.skill-card[data-skill-name="${CSS.escape(name)}"]`);
    if (card) card.classList.add('doclib-card-deleting');
  }
  if (deletedNames.length) await new Promise(resolve => setTimeout(resolve, 320));
  _exitSelectMode();
  await loadSkills();
  uiModule.showToast(`Deleted ${deleted} non-passing`);
}

async function _bulkApprove() {
  if (!_selectedNames.size) return;
  let published = 0;
  for (const name of _selectedNames) {
    const sk = skills.find(s => (s.name || s.id) === name);
    if (sk && sk.status === 'published') continue;
    try {
      const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'published' }),
      });
      if (res.ok) published++;
    } catch {}
  }
  _exitSelectMode();
  await loadSkills();
  uiModule.showToast(`Published ${published}`);
}

async function _bulkAudit() {
  if (!_selectedNames.size) return;
  const selected = new Set(_selectedNames);
  const ordered = _getFilteredSkills()
    .map(sk => sk.name || sk.id)
    .filter(n => selected.has(n));
  _exitSelectMode();
  await _auditAllSkills({ names: ordered });
}

async function _showSkillSource(name) {
  let md = '';
  try {
    const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}/markdown`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    md = data.markdown || '';
  } catch (e) {
    uiModule.showError('Failed to load SKILL.md');
    return;
  }

  // 轻量级弹窗 — 复用应用其他部分使用的 .modal CSS。
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.style.display = 'block';
  wrap.innerHTML = `
    <div class="modal-content" style="max-width:760px;max-height:85vh;display:flex;flex-direction:column">
      <div class="modal-header">
        <h4>SKILL.md — <code>${esc(name)}</code></h4>
        <span style="flex:1"></span>
        <button class="memory-toolbar-btn" id="skill-save-btn">Save</button>
        <button class="close-btn" id="skill-md-close">✖</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:8px">
        <textarea id="skill-md-textarea" spellcheck="false" style="flex:1;min-height:50vh;width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);box-sizing:border-box"></textarea>
        <p class="memory-desc" style="margin:0">Edit the frontmatter and body directly. Save replaces the file via PUT /api/skills/{name}.</p>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  const ta = wrap.querySelector('#skill-md-textarea');
  ta.value = md;
  wrap.querySelector('#skill-md-close').addEventListener('click', () => wrap.remove());
  wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  wrap.querySelector('#skill-save-btn').addEventListener('click', async () => {
    try {
      // We use the manage_skills-style edit by going through PUT with a
      // single 'content' field. The route doesn't accept that yet — use the
      // tool call instead. We have a /api/skills/{name} PUT for fields, but
      // a full SKILL.md replace is simpler via the parsed-then-PUT approach
      // below: parse client-side by uploading via the tool route.
      const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}/markdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: ta.value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      uiModule.showToast('Saved');
      wrap.remove();
      await loadSkills();
    } catch (e) {
      uiModule.showError('Save failed: ' + e.message);
    }
  });
}

async function importSkillFromUrl() {
  const input = document.getElementById('skill-import-url');
  const url = (input?.value || '').trim();
  if (!url) {
    uiModule.showError('Paste a GitHub or skills.sh URL first');
    return;
  }
  const btn = document.getElementById('skill-import-url-btn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API}/api/skills/import-from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
    if (input) input.value = '';
    await loadSkills();
    const name = data.skill?.name || 'skill';
    uiModule.showToast(`Imported ${name} (${data.files || 1} file(s))`);
    if (name) openSkill(name);
  } catch (err) {
    uiModule.showError('Import failed: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function addSkill() {
  const name = document.getElementById('new-skill-name')?.value.trim()
    || document.getElementById('new-skill-title')?.value.trim();
  const description = document.getElementById('new-skill-description')?.value.trim()
    || document.getElementById('new-skill-title')?.value.trim();
  const whenToUse = document.getElementById('new-skill-when')?.value.trim()
    || document.getElementById('new-skill-problem')?.value.trim() || '';
  const procedureRaw = document.getElementById('new-skill-procedure')?.value.trim()
    || document.getElementById('new-skill-solution')?.value.trim() || '';
  const tagsRaw = document.getElementById('new-skill-tags')?.value.trim();
  const category = document.getElementById('new-skill-category')?.value.trim() || 'general';

  if (!description && !name) {
    uiModule.showError('Description (or name) is required');
    return;
  }
  const procedure = procedureRaw
    ? procedureRaw.split('\n').map(s => s.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).filter(Boolean)
    : [];
  const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

  try {
    const res = await fetch(`${API}/api/skills/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name || undefined,
        description,
        category,
        when_to_use: whenToUse,
        procedure,
        tags,
        status: 'draft',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ['new-skill-name', 'new-skill-title', 'new-skill-description', 'new-skill-when',
     'new-skill-problem', 'new-skill-procedure', 'new-skill-solution', 'new-skill-tags',
     'new-skill-category']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    await loadSkills();
    uiModule.showToast('Skill added (draft)');
  } catch (err) {
    uiModule.showError('Failed to add skill: ' + err.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('skill-import-url-btn')?.addEventListener('click', importSkillFromUrl);
  document.getElementById('skill-import-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') importSkillFromUrl();
  });
  document.getElementById('add-skill-btn')?.addEventListener('click', addSkill);
  document.getElementById('skills-search')?.addEventListener('input', renderSkillsList);
  document.getElementById('skills-sort')?.addEventListener('change', (e) => {
    // 下拉菜单包含两个选项组：排序（sort:<key>）和过滤（filter:<key>）。
    // 选择排序选项不会影响过滤设置，反之亦然。
    const v = e.target.value || '';
    if (v.startsWith('sort:')) {
      _skillsSort = v.slice(5);
    } else if (v.startsWith('filter:')) {
      const f = v.slice(7);
      if (f === 'all') { _showDraftsOnly = false; _showPublishedOnly = false; _confMax = null; }
      else if (f === 'drafts') { _showDraftsOnly = true; _showPublishedOnly = false; _confMax = null; }
      else if (f === 'published') { _showPublishedOnly = true; _showDraftsOnly = false; _confMax = null; }
      else if (f.startsWith('conf')) { _showDraftsOnly = false; _showPublishedOnly = false; _confMax = parseInt(f.slice(4), 10) || null; }
    }
    renderSkillsList();
  });
  document.getElementById('skills-select-btn')?.addEventListener('click', () => {
    if (_selectMode) _exitSelectMode(); else _enterSelectMode();
  });
  document.getElementById('skills-audit-btn')?.addEventListener('click', _auditAllSkills);
  document.getElementById('skills-select-all')?.addEventListener('change', _toggleSelectAll);
  document.getElementById('skills-bulk-cancel')?.addEventListener('click', _exitSelectMode);
  document.getElementById('skills-bulk-audit')?.addEventListener('click', _bulkAudit);
  document.getElementById('skills-bulk-delete')?.addEventListener('click', _bulkDelete);
  document.getElementById('skills-bulk-delete-nonpassing')?.addEventListener('click', _bulkDeleteNonPassing);
  document.getElementById('skills-bulk-publish')?.addEventListener('click', _bulkApprove);
  document.getElementById('new-skill-title')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSkill();
  });
  document.getElementById('new-skill-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSkill();
  });
});

export default { loadSkills, openSkill };

// 在首次加载时填充"技能"徽章，以便在用户点击标签页之前
// 计数已经正确。轻量获取 — 与懒加载路径相同。
document.addEventListener('DOMContentLoaded', () => { loadSkills(); });
