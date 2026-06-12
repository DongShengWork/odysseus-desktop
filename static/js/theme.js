// 主题系统 — 预设主题 + 自定义颜色编辑，存储在 localStorage 中
// ES6 模块

import Storage from './storage.js';
import uiModule from './ui.js';
import { initColorPickers, attachColorPicker } from './colorPicker.js';
import { hexToRgb } from './color/hex.js';
import { makeWindowDraggable } from './windowDrag.js';
import { snapModalToZone } from './tileManager.js';
import { t } from './i18n.js';

export const THEMES = {
  dark:       { bg:'#282c34', fg:'#9cdef2', panel:'#111111', border:'#355a66', red:'#e06c75' },
  light:      { bg:'#f0ebe3', fg:'#5a5248', panel:'#faf6f0', border:'#d4cdc2', red:'#c47d5a' },
  midnight:   { bg:'#0d1117', fg:'#c9d1d9', panel:'#161b22', border:'#30363d', red:'#f85149' },
  paper:      { bg:'#faf8f5', fg:'#3b3836', panel:'#ffffff', border:'#d5d0c8', red:'#c5ac4a' },
  // 趣味/花式主题
  cyberpunk:  { bg:'#0a0a0f', fg:'#0ff0fc', panel:'#12101a', border:'#9b30ff', red:'#e040fb' },
  retrowave:  { bg:'#1a1a2e', fg:'#e94560', panel:'#16213e', border:'#533483', red:'#e94560' },
  forest:     { bg:'#1b2a1b', fg:'#a8d5a2', panel:'#142414', border:'#3d6b3d', red:'#7cb871' },
  ocean:      { bg:'#0b1a2c', fg:'#64d2ff', panel:'#091422', border:'#1e5074', red:'#4facfe' },
  ume:        { bg:'#2b1b2e', fg:'#f5c2e7', panel:'#1e1420', border:'#6c4675', red:'#f5a0c0' },
  copper:     { bg:'#1c1410', fg:'#e8c39e', panel:'#140f0a', border:'#7a5533', red:'#d4764e' },
  terminal:   { bg:'#000000', fg:'#00ff41', panel:'#0a0a0a', border:'#003b00', red:'#00ff41' },
  organs:     { bg:'#0a0406', fg:'#efe1c8', panel:'#15080a', border:'#3a1519', red:'#c83240' },
  lavender:   { bg:'#f3eef8', fg:'#3d3551', panel:'#faf7ff', border:'#cec3de', red:'#9b6dcc' },
  gpt:        { bg:'#212121', fg:'#ececec', panel:'#171717', border:'#424242', red:'#949494',
                advanced: { sendBtnBg: '#949494', sendBtnHover: '#7f7f7f',
                            userBubbleBg: '#2f2f2f', aiBubbleBg: '#171717',
                            inputBg: '#2f2f2f' } },
  claude:     { bg:'#262624', fg:'#f5f4f0', panel:'#30302e', border:'#4a4a47', red:'#c6613f' },
  cute:       { bg:'#fff0f5', fg:'#d4608a', panel:'#fff8fa', border:'#f0c0d0', red:'#ff6b9d' },
};

const DEFAULT_THEME = 'dark';
const LS_KEY = 'odysseus-theme';
const CUSTOM_THEMES_KEY = 'odysseus-custom-themes';

const FONT_MAP = {
  mono: "'Fira Code', monospace",
  sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
};
const DEFAULT_FONT = 'mono';
const DEFAULT_DENSITY = 'comfortable';
const MAX_CUSTOM_THEMES = 8;

// 内置主题的默认背景图案
const THEME_DEFAULT_PATTERN = {
  dark:       'none',
  light:      'dots',
  midnight:   'rain',
  paper:      'dots',
  cyberpunk:  'synapse',
  retrowave:  'embers',
  forest:     'petals',
  ocean:      'constellations',
  terminal:   'perlin-flow',
  organs:     'rain',
  ume:        'petals',
  cute:       'sparkles',
};

// 特定主题的默认效果颜色（覆盖 --fg）
const THEME_DEFAULT_EFFECT_COLOR = {
  midnight:   '#ffffff',
  organs:     '#451616',
  cute:       '#ff8cb8',
  ume:        '#f5a0c0',
};

// 每个主题的默认效果强度（0..1）。未列出的主题默认为 1。
const THEME_DEFAULT_INTENSITY = {
  midnight:   0.5,
  terminal:   0.8,
  organs:     0.65,
};

// 每个主题的默认磨砂玻璃状态。未列出的主题默认为 false。
const THEME_DEFAULT_FROSTED = {
  lavender:   true,
};

// ── 自定义主题持久化 ──
function _loadCustomThemes() {
  return Storage.getJSON(CUSTOM_THEMES_KEY, {});
}
function _saveCustomThemes(obj) {
  Storage.setJSON(CUSTOM_THEMES_KEY, obj);
}
export function saveCustomTheme(name, colors, opts) {
  const ct = _loadCustomThemes();
  // 强制限制 — 允许覆盖已有主题，禁止超过上限的新主题
  if (!ct[name] && Object.keys(ct).length >= MAX_CUSTOM_THEMES) {
    return 'limit';
  }
  const entry = { ...colors };
  if (opts) {
    if (opts.font) entry.font = opts.font;
    if (opts.density) entry.density = opts.density;
    if (opts.bgPattern) entry.bgPattern = opts.bgPattern;
    if (opts.bgEffectColor) entry.bgEffectColor = opts.bgEffectColor;
    if (opts.bgEffectIntensity !== undefined) entry.bgEffectIntensity = opts.bgEffectIntensity;
    if (opts.bgEffectSize !== undefined) entry.bgEffectSize = opts.bgEffectSize;
    if (opts.frosted !== undefined) entry.frosted = !!opts.frosted;
  }
  ct[name] = entry;
  _saveCustomThemes(ct);
  _syncCustomThemesToServer(ct);
  initThemeUI();
  return 'ok';
}
export function deleteCustomTheme(name) {
  const ct = _loadCustomThemes();
  delete ct[name];
  _saveCustomThemes(ct);
  _syncCustomThemesToServer(ct);
  initThemeUI();
}
function _syncCustomThemesToServer(ct) {
  try {
    fetch('/api/prefs/custom-themes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ value: ct }),
    }).catch(e => console.warn('Theme sync (custom) failed:', e));
  } catch (e) { console.warn('Theme sync (custom) error:', e); }
}

// --- 从主题基础颜色推导语法高亮颜色 ---
function hexToHSL(hex) {
  const rgb = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const toHex = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}

function deriveSyntaxColors(colors) {
  const [fgH, fgS, fgL] = hexToHSL(colors.fg);
  const [bgH, bgS, bgL] = hexToHSL(colors.bg);
  const [redH, redS, redL] = hexToHSL(colors.red || '#e06c75');
  const isDark = bgL < 50;
  const codeBgL = isDark ? Math.max(bgL - 4, 0) : Math.min(bgL + 4, 100);
  return {
    bg: hslToHex(bgH, bgS, codeBgL),
    fg: colors.fg,
    keyword: hslToHex((redH + 280) % 360, Math.min(redS + 10, 80), isDark ? 70 : 45),
    string: hslToHex(40, Math.min(fgS + 20, 70), isDark ? 72 : 42),
    comment: hslToHex(fgH, Math.max(fgS - 20, 5), isDark ? (fgL * 0.5 + bgL * 0.5) : (fgL * 0.5 + bgL * 0.5)),
    function: hslToHex(210, Math.min(fgS + 20, 75), isDark ? 70 : 45),
    // 额外的 token 颜色，用于更丰富的高亮
    number: hslToHex(20, Math.min(fgS + 15, 65), isDark ? 68 : 48),
    builtin: hslToHex(180, Math.min(fgS + 15, 60), isDark ? 65 : 40),
    variable: hslToHex((fgH + 30) % 360, Math.min(fgS + 5, 60), isDark ? fgL : fgL),
    params: hslToHex(fgH, Math.max(fgS - 5, 10), isDark ? Math.min(fgL + 8, 85) : Math.max(fgL - 8, 25)),
  };
}

// 高级选择器 key → CSS 变量映射
const ADV_KEYS = [
  { key: 'userBubbleBg',       css: '--user-bubble-bg',    label: 'User Chat Bubble', group: 'Chat Bubbles' },
  { key: 'aiBubbleBg',         css: '--ai-bubble-bg',      label: 'AI Chat Bubble',   group: 'Chat Bubbles' },
  { key: 'bubbleBorder',       css: '--bubble-border',     label: 'Border Chat Bubble', group: 'Chat Bubbles' },
  { key: 'sidebarBg',          css: '--sidebar-bg',        label: 'Sidebar Bg',       group: 'Sidebar' },
  { key: 'brandColor',         css: '--brand-color',       label: 'Odysseus Logo',    group: 'Sidebar' },
  { key: 'hamburgerColor',     css: '--hamburger-color',   label: 'Hamburger Menu',   group: 'Sidebar' },
  { key: 'inputBg',            css: '--input-bg',          label: 'Input Bg',         group: 'Chat Input / Prompt Area' },
  { key: 'inputBorder',        css: '--input-border',      label: 'Input Border',     group: 'Chat Input / Prompt Area' },
  { key: 'sendBtnBg',          css: '--send-btn-bg',       label: 'Send Btn',         group: 'Chat Input / Prompt Area' },
  { key: 'sendBtnHover',       css: '--send-btn-hover',    label: 'Send Hover',       group: 'Chat Input / Prompt Area' },
  { key: 'codeBg',             css: '--code-bg',           label: 'Code Bg',          group: 'Code Blocks' },
  { key: 'codeFg',             css: '--code-fg',           label: 'Code Text',        group: 'Code Blocks' },
  { key: 'toggleActive',       css: '--toggle-active',     label: 'Toggle On',        group: 'Controls' },
];

function computeAdvancedDefaults(colors) {
  const syn = deriveSyntaxColors(colors);
  const red = colors.red || '#e06c75';
  return {
    userBubbleBg: colors.bg,
    aiBubbleBg: colors.panel,
    bubbleBorder: colors.border,
    sidebarBg: colors.panel,
    brandColor: red,
    hamburgerColor: colors.fg,
    inputBg: colors.panel,
    inputBorder: colors.border,
    sendBtnBg: red,
    sendBtnHover: red,
    codeBg: syn.bg,
    codeFg: syn.fg,
    toggleActive: red,
  };
}

function generateHarmonyColors(accentHex, harmonyType, mode) {
  const [h, s] = hexToHSL(accentHex);
  const isDark = mode === 'dark';

  let bgH, bgS, bgL, fgS, fgL, panelL, borderH, borderS, borderL;

  if (harmonyType === 'complementary') {
    bgH = h; bgS = Math.max(s * 0.15, 3);
    bgL = isDark ? 13 : 95; fgL = isDark ? 85 : 15; fgS = Math.max(s * 0.2, 5);
    panelL = isDark ? 8 : 98;
    borderH = h; borderS = Math.max(s * 0.25, 8); borderL = isDark ? 28 : 75;
  } else if (harmonyType === 'analogous') {
    bgH = (h - 30 + 360) % 360; bgS = Math.max(s * 0.12, 3);
    bgL = isDark ? 14 : 95; fgL = isDark ? 84 : 18; fgS = Math.max(s * 0.15, 5);
    panelL = isDark ? 9 : 97;
    borderH = (h + 30) % 360; borderS = Math.max(s * 0.3, 10); borderL = isDark ? 30 : 72;
  } else if (harmonyType === 'triadic') {
    bgH = (h + 240) % 360; bgS = Math.max(s * 0.1, 2);
    bgL = isDark ? 13 : 96; fgL = isDark ? 86 : 14; fgS = Math.max(s * 0.18, 5);
    panelL = isDark ? 8 : 99;
    borderH = (h + 120) % 360; borderS = Math.max(s * 0.2, 8); borderL = isDark ? 28 : 74;
  } else { // 单色
    bgH = h; bgS = Math.max(s * 0.08, 2);
    bgL = isDark ? 12 : 96; fgL = isDark ? 87 : 13; fgS = Math.max(s * 0.15, 5);
    panelL = isDark ? 7 : 99;
    borderH = h; borderS = Math.max(s * 0.2, 6); borderL = isDark ? 26 : 76;
  }

  return {
    bg: hslToHex(bgH, bgS, bgL),
    fg: hslToHex(h, fgS, fgL),
    panel: hslToHex(bgH, bgS * 0.6, panelL),
    border: hslToHex(borderH, borderS, borderL),
    red: accentHex,
  };
}

export function applyColors(colors) {
  const s = document.documentElement.style;
  s.setProperty('--bg', colors.bg);
  s.setProperty('--fg', colors.fg);
  s.setProperty('--panel', colors.panel);
  s.setProperty('--border', colors.border);
  if (colors.red) s.setProperty('--red', colors.red);

  // 保持移动浏览器工具栏/状态栏与主题背景匹配
  // （与首次绘制时 head 中的脚本相同）。
  const _mtc = document.querySelector('meta[name="theme-color"]');
  if (_mtc && colors.bg) _mtc.setAttribute('content', colors.bg);

  // 推导并应用语法高亮颜色
  const syn = deriveSyntaxColors(colors);
  s.setProperty('--hl-bg', syn.bg);
  s.setProperty('--hl-fg', syn.fg);
  s.setProperty('--hl-keyword', syn.keyword);
  s.setProperty('--hl-string', syn.string);
  s.setProperty('--hl-comment', syn.comment);
  s.setProperty('--hl-function', syn.function);
  s.setProperty('--hl-number', syn.number);
  s.setProperty('--hl-builtin', syn.builtin);
  s.setProperty('--hl-variable', syn.variable);
  s.setProperty('--hl-params', syn.params);

  // 应用高级覆盖（或默认值）
  const adv = colors.advanced || {};
  const defaults = computeAdvancedDefaults(colors);
  for (const { key, css } of ADV_KEYS) {
    s.setProperty(css, adv[key] || defaults[key]);
  }

  // 更新 favicon 以匹配主题强调色
  _updateFavicon(colors.red || '#e06c75');
}

// 各路由的 SVG 形状注册表 — 与 index.html 中的内联 favicon 脚本保持同步，
// 确保主题切换时保留路由图标而非默认小船。
// 返回以 `fg` 着色的内部 SVG 标记。
const _ROUTE_FAVICON_SHAPES = {
  '/calendar':
    "<rect x='4' y='6' width='24' height='22' rx='2' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<line x1='4' y1='12' x2='28' y2='12' stroke='__C__' stroke-width='2.5'/>" +
    "<line x1='10' y1='3' x2='10' y2='9' stroke='__C__' stroke-width='2.5' stroke-linecap='round'/>" +
    "<line x1='22' y1='3' x2='22' y2='9' stroke='__C__' stroke-width='2.5' stroke-linecap='round'/>",
  '/notes':
    "<rect x='6' y='4' width='20' height='24' rx='2' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<line x1='10' y1='10' x2='22' y2='10' stroke='__C__' stroke-width='2'/>" +
    "<line x1='10' y1='15' x2='22' y2='15' stroke='__C__' stroke-width='2'/>" +
    "<line x1='10' y1='20' x2='18' y2='20' stroke='__C__' stroke-width='2'/>",
  '/cookbook':
    "<path d='M5 8 L5 26 A2 2 0 0 0 7 28 L25 28 A2 2 0 0 0 27 26 L27 8' fill='none' stroke='__C__' stroke-width='2.5' stroke-linejoin='round'/>" +
    "<path d='M9 4 L23 4 L23 8 L9 8 Z' fill='none' stroke='__C__' stroke-width='2.5' stroke-linejoin='round'/>" +
    "<line x1='11' y1='14' x2='21' y2='14' stroke='__C__' stroke-width='2'/>" +
    "<line x1='11' y1='19' x2='17' y2='19' stroke='__C__' stroke-width='2'/>",
  '/email':
    "<rect x='4' y='7' width='24' height='18' rx='2' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<path d='M5 9 L16 17 L27 9' fill='none' stroke='__C__' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/>",
  '/memory':
    "<path d='M16 5 C10 5 6 9 6 14 C6 19 10 21 11 22 L11 26 L21 26 L21 22 C22 21 26 19 26 14 C26 9 22 5 16 5 Z' fill='none' stroke='__C__' stroke-width='2.5' stroke-linejoin='round'/>" +
    "<line x1='12' y1='28' x2='20' y2='28' stroke='__C__' stroke-width='2'/>",
  '/gallery':
    "<rect x='4' y='4' width='24' height='24' rx='2' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<circle cx='12' cy='12' r='2.5' fill='__C__'/>" +
    "<path d='M4 22 L11 16 L18 21 L23 17 L28 22' fill='none' stroke='__C__' stroke-width='2.5' stroke-linejoin='round'/>",
  '/tasks':
    "<rect x='4' y='4' width='24' height='24' rx='3' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<path d='M9 16 L14 21 L23 11' fill='none' stroke='__C__' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/>",
  '/library':
    "<rect x='5' y='5' width='5' height='22' rx='1' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<rect x='13' y='5' width='5' height='22' rx='1' fill='none' stroke='__C__' stroke-width='2.5'/>" +
    "<rect x='21' y='8' width='6' height='19' rx='1' fill='none' stroke='__C__' stroke-width='2.5' transform='rotate(8 24 17)'/>",
};

function _updateFavicon(fg) {
  const path = (window.location.pathname || '').toLowerCase();
  const routeShape = _ROUTE_FAVICON_SHAPES[path];
  let svg;
  if (routeShape) {
    svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>${routeShape.split('__C__').join(fg)}</svg>`;
  } else {
    svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M16 4L16 22L6 22Z' fill='${fg}'/><path d='M16 8L16 22L24 22Z' fill='${fg}' opacity='0.6'/><path d='M4 24Q10 20 16 24Q22 28 28 24' stroke='${fg}' stroke-width='2.5' fill='none' stroke-linecap='round'/></svg>`;
  }
  const href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  let link = document.querySelector("link[rel='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    document.head.appendChild(link);
  }
  link.href = href;
  let apple = document.querySelector("link[rel='apple-touch-icon']");
  if (!apple) {
    apple = document.createElement('link');
    apple.rel = 'apple-touch-icon';
    document.head.appendChild(apple);
  }
  apple.href = href;
}

// 已发现的自定义字体缓存：{ "字体族名称": [ {file, url, format} ] }
let _customFonts = {};
// 跟踪哪些自定义字体族已注入 @font-face
const _injectedFonts = new Set();

function _injectFontFace(familyName, variants) {
  if (_injectedFonts.has(familyName)) return;
  const style = document.createElement('style');
  style.dataset.customFont = familyName;
  const fmtMap = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };
  for (const v of variants) {
    style.textContent += `@font-face { font-family: '${familyName}'; src: url('${v.url}') format('${fmtMap[v.format] || v.format}'); font-display: swap; }\n`;
  }
  document.head.appendChild(style);
  _injectedFonts.add(familyName);
}

export function applyFontDensity(font, density) {
  const f = font || DEFAULT_FONT;
  const d = density || DEFAULT_DENSITY;
  let family = FONT_MAP[f];
  if (!family && _customFonts[f]) {
    // 这是来自本地文件夹的自定义字体
    _injectFontFace(f, _customFonts[f]);
    family = "'" + f + "', sans-serif";
  }
  if (!family) family = FONT_MAP[DEFAULT_FONT];
  document.documentElement.style.setProperty('--font-family', family);
  document.documentElement.classList.remove('density-compact', 'density-spacious');
  if (d !== 'comfortable') document.documentElement.classList.add('density-' + d);
}

const _BG_CLASSES = ['bg-pattern-dots',
  'bg-pattern-synapse', 'bg-pattern-rain', 'bg-pattern-constellations',
  'bg-pattern-perlin-flow',
  'bg-pattern-petals', 'bg-pattern-sparkles', 'bg-pattern-embers'];
const _CANVAS_PATTERNS = { synapse: _initSynapse, rain: _initRain, constellations: _initConstellations,
  'perlin-flow': _initPerlinFlow,
  petals: _initPetals, sparkles: _initSparkles, embers: _initEmbers };

export function applyBgEffectColor(color) {
  document.documentElement.style.setProperty('--bg-effect-color', color || '');
}

export function applyBgEffectIntensity(v) {
  // v 的范围是 0..1。缺失时默认为 1（全强度）。
  const n = (v === undefined || v === null || isNaN(v)) ? 1 : Math.max(0, Math.min(1, Number(v)));
  document.documentElement.style.setProperty('--bg-effect-intensity', String(n));
}

export function applyBgEffectSize(v) {
  // v 是乘数 0.2..3.0。缺失时默认为 1。
  const n = (v === undefined || v === null || isNaN(v)) ? 1 : Math.max(0.2, Math.min(3, Number(v)));
  document.documentElement.style.setProperty('--bg-effect-size', String(n));
}

/** 切换全局"磨砂玻璃"效果 — 通过对 `body.theme-frosted` 的 CSS 规则
 *  为每个面板、侧边栏、模态框、下拉菜单和弹出框应用半透明 + 模糊
 *  处理。 */
export function applyFrostedGlass(on) {
  document.body.classList.toggle('theme-frosted', !!on);
}

// 读取当前 JS 效果（基于 canvas）的大小乘数。
function _getEffectSize() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bg-effect-size'));
  return isNaN(v) ? 1 : v;
}

// 强度/大小滑块对这些图案没有可见效果的图案集合。
const _STATIC_PATTERNS = new Set(['none', 'dots']);

export function applyBgPattern(pattern) {
  const p = pattern || 'none';
  document.body.classList.remove(..._BG_CLASSES);
  // 清理任何 canvas 背景
  document.querySelectorAll('#synapse-canvas, #rain-canvas, #constellations-canvas, #perlin-flow-canvas, #petals-canvas, #sparkles-canvas, #embers-canvas').forEach(c => c.remove());
  if (p !== 'none') document.body.classList.add('bg-pattern-' + p);
  if (_CANVAS_PATTERNS[p]) _CANVAS_PATTERNS[p]();
  // 隐藏对静态图案无效果的滑块。
  const hide = _STATIC_PATTERNS.has(p);
  const ig = document.getElementById('theme-bg-intensity-group');
  const sg = document.getElementById('theme-bg-size-group');
  if (ig) ig.style.display = hide ? 'none' : '';
  if (sg) sg.style.display = hide ? 'none' : '';
}

export function getSaved() {
  const obj = Storage.getJSON(LS_KEY, null);
  // 迁移：'chatgpt' 预设已重命名为 'gpt'
  if (obj && obj.name === 'chatgpt') obj.name = 'gpt';
  // 迁移：'sakura' 预设已重命名为 'ume'
  if (obj && obj.name === 'sakura') obj.name = 'ume';
  return obj;
}

export function save(name, colors, opts) {
  const obj = { name, colors };
  if (opts) {
    if (opts.font && opts.font !== DEFAULT_FONT) obj.font = opts.font;
    if (opts.density && opts.density !== DEFAULT_DENSITY) obj.density = opts.density;
    if (opts.bgPattern && opts.bgPattern !== 'none') obj.bgPattern = opts.bgPattern;
    if (opts.bgEffectColor) obj.bgEffectColor = opts.bgEffectColor;
    if (opts.bgEffectIntensity !== undefined && opts.bgEffectIntensity !== 1) obj.bgEffectIntensity = opts.bgEffectIntensity;
    if (opts.bgEffectSize !== undefined && opts.bgEffectSize !== 1) obj.bgEffectSize = opts.bgEffectSize;
    if (opts.frosted) obj.frosted = true;
  }
  Storage.setJSON(LS_KEY, obj);
  _syncToServer(obj);
}

function _syncToServer(obj) {
  try {
    fetch('/api/prefs/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ value: obj }),
    }).catch(e => console.warn('Theme sync failed:', e));
  } catch (e) { console.warn('Theme sync error:', e); }
}

async function _loadFromServer() {
  try {
    const res = await fetch('/api/prefs/theme', { credentials: 'same-origin' });
    const data = await res.json();
    return data.value || null;
  } catch { return null; }
}


function syncPickers(colors) {
  document.getElementById('clr-bg').value = colors.bg;
  document.getElementById('clr-fg').value = colors.fg;
  document.getElementById('clr-panel').value = colors.panel;
  document.getElementById('clr-border').value = colors.border;
  document.getElementById('clr-red').value = colors.red;
  syncAdvancedPickers(colors);
}


function syncAdvancedPickers(colors) {
  const adv = colors.advanced || {};
  const defaults = computeAdvancedDefaults(colors);
  for (const { key } of ADV_KEYS) {
    const el = document.getElementById('adv-' + key);
    if (el) el.value = adv[key] || defaults[key];
  }
}

export function initThemeUI() {
  const themePopup = document.getElementById('theme-popup');
  const themeHeader = document.getElementById('theme-popup-header');
  if (themePopup && themeHeader && !themePopup.dataset.dragWired) {
    themePopup.dataset.dragWired = '1';
    makeDraggable(themePopup, themeHeader);
  }

  // 将内置颜色选择器附加到主题面板中的每个颜色输入。
  // 可安全重复调用 — 选择器会标记已包装的输入。
  try { initColorPickers(document); } catch (e) { console.warn('Color picker init failed', e); }

  // 立即用计算出的默认值填充高级颜色输入。
  // BUG 修复：没有这一步，未触碰的输入会停留在浏览器默认值 '#000000'，
  // 直到用户点击色板；此时任何高级输入的第一个编辑操作都会触发
  // readAdvanced() 将其他每个 '#000000' 作为覆盖值存储 —
  // 例如编辑聊天气泡边框会把侧边栏背景变成纯黑色。
  try {
    const saved = getSaved();
    if (saved && saved.colors) {
      syncAdvancedPickers(saved.colors);
    }
  } catch (e) { console.warn('syncAdvancedPickers on init failed', e); }
  // 关联主题标签页（主题 / 自定义）
  const themeTabs = document.getElementById('theme-tabs');
  if (themeTabs) {
    themeTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.admin-tab');
      if (!tab) return;
      const targetId = tab.dataset.tab;
      themeTabs.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.theme-tab-panel').forEach(p => p.style.display = 'none');
      const panel = document.getElementById(targetId);
      if (panel) panel.style.display = '';
      // 仅在自定义标签页中显示透明度滑块。
      const opWrap = document.getElementById('theme-opacity-wrap');
      if (opWrap) opWrap.classList.toggle('hidden', targetId !== 'theme-tab-customize');
      // 恢复完整透明度/模糊。滑块效果本来就只在自定义标签页中有效 —
      // 在调整颜色时窥视页面 — 所以切换回主题（或计划任务）标签页时应该
      // 看起来和应用的其他模态框完全一样。
      const popup = document.getElementById('theme-popup');
      if (popup) {
        if (targetId === 'theme-tab-customize') {
          // 重新应用透视切换的当前状态。
          if (opWrap && opWrap._apply) opWrap._apply();
        } else {
          popup.style.removeProperty('opacity');
          popup.style.removeProperty('background');
          popup.style.removeProperty('backdrop-filter');
          popup.style.removeProperty('-webkit-backdrop-filter');
          popup.querySelectorAll('.admin-card').forEach(c => {
            c.style.removeProperty('background');
            c.style.removeProperty('backdrop-filter');
            c.style.removeProperty('-webkit-backdrop-filter');
          });
        }
      }
    });
  }


  // 关联"透视"透明度开关 — 淡化主题模态框，让用户在
  // 自定义标签页中调整颜色时可以看见后面的页面。
  // 仅开/关（无滑块）；初始关闭，位于标题栏中，
  // 用户切换到主题/计划任务标签页时清除。
  (function _wireOpacityToggle() {
    const toggle = document.getElementById('theme-opacity-wrap');
    const popup = document.getElementById('theme-popup');
    if (!toggle || !popup || toggle.dataset.bound === '1') return;
    toggle.dataset.bound = '1';
    const PEEK = 55; // 透视时的透明度百分比
    const apply = (on) => {
      const cards = popup.querySelectorAll('.admin-card');
      if (on) {
        // 通过 color-mix 淡化模态框 + 每个内部卡片 — 永远不用元素透明度，
        // 这样文本、控件和色板保持清晰。
        const bgMix    = `color-mix(in srgb, var(--bg)    ${PEEK}%, transparent)`;
        const panelMix = `color-mix(in srgb, var(--panel) ${PEEK}%, transparent)`;
        popup.style.setProperty('background', bgMix, 'important');
        popup.style.setProperty('backdrop-filter', 'none', 'important');
        popup.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        popup.style.removeProperty('opacity');
        cards.forEach(c => {
          c.style.setProperty('background', panelMix, 'important');
          c.style.setProperty('backdrop-filter', 'none', 'important');
          c.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        });
      } else {
        popup.style.removeProperty('opacity');
        popup.style.removeProperty('background');
        popup.style.removeProperty('backdrop-filter');
        popup.style.removeProperty('-webkit-backdrop-filter');
        cards.forEach(c => {
          c.style.removeProperty('background');
          c.style.removeProperty('backdrop-filter');
          c.style.removeProperty('-webkit-backdrop-filter');
        });
      }
    };
    // 暴露此方法以便切换标签页时回到自定义标签可以重新应用。
    toggle._apply = () => apply(toggle.classList.contains('active'));
    toggle.addEventListener('click', () => {
      const on = !toggle.classList.contains('active');
      toggle.classList.toggle('active', on);
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      apply(on);
    });
  })();

  const grid = document.getElementById('themeGrid');
  if (!grid) return;

  const saved = getSaved();
  const activeName = saved ? saved.name : DEFAULT_THEME;
  const customThemes = _loadCustomThemes();

  // 渲染预设色板
  grid.innerHTML = Object.entries(THEMES).map(([name, c]) => `
    <div class="theme-swatch${name === activeName ? ' active' : ''}" data-theme="${name}">
      <div class="theme-swatch-colors">
        <span style="background:${c.bg}"></span>
        <span style="background:${c.panel}"></span>
        <span style="background:${c.fg}"></span>
        <span style="background:${c.red}"></span>
      </div>
      ${name === 'dark' ? 'original' : (name === 'gpt' ? 'GPT' : name)}
    </div>
  `).join('');

  // 在单独的卡片中渲染自定义主题色板
  const userGrid = document.getElementById('themeUserGrid');
  const userCard = document.getElementById('themeUserCard');
  const customEntries = Object.entries(customThemes);
  if (customEntries.length > 0 && userGrid && userCard) {
    userCard.style.display = '';
    userGrid.innerHTML = customEntries.map(([name, c]) => `
      <div class="theme-swatch${name === activeName ? ' active' : ''}" data-theme="${name}" data-custom="1">
        <div class="theme-swatch-colors">
          <span style="background:${c.bg}"></span>
          <span style="background:${c.panel}"></span>
          <span style="background:${c.fg}"></span>
          <span style="background:${c.red}"></span>
        </div>
        <span class="theme-swatch-name">${name}</span>
        <button type="button" class="theme-delete-btn" data-delete="${name}" title="${t('theme.delete_theme')}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    `).join('');
  } else if (userCard) {
    userCard.style.display = 'none';
  }

  // 辅助函数：使用 UI 下拉选择中当前的字体/密度/背景图案进行保存
  function _getOpts() {
    const opts = {};
    const fs = document.getElementById('theme-font-select');
    const ds = document.getElementById('theme-density-select');
    const ps = document.getElementById('theme-bg-pattern-select');
    const ec = document.getElementById('theme-bg-effect-color');
    const es = document.getElementById('theme-bg-intensity');
    const sz = document.getElementById('theme-bg-size');
    if (fs) opts.font = fs.value;
    if (ds) opts.density = ds.value;
    if (ps) opts.bgPattern = ps.value;
    if (ec) opts.bgEffectColor = ec.value;
    if (es) opts.bgEffectIntensity = parseFloat(es.value) / 100;
    if (sz) opts.bgEffectSize = parseFloat(sz.value) / 100;
    const fr = document.getElementById('theme-frosted-toggle');
    if (fr) opts.frosted = !!fr.checked;
    return opts;
  }
  function _saveFull(name, colors) { save(name, colors, _getOpts()); }

  // 两个网格中所有色板（预设 + 自定义）的点击处理器
  const allGrids = [grid, userGrid].filter(Boolean);
  function clearAllActive() { allGrids.forEach(g => g.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'))); }
  allGrids.forEach(g => {
    g.querySelectorAll('.theme-swatch').forEach(sw => {
      sw.addEventListener('click', (e) => {
        if (e.target.closest('.theme-delete-btn')) return;
        const name = sw.dataset.theme;
        const colors = sw.dataset.custom ? customThemes[name] : THEMES[name];
        if (!colors) return;
        applyColors(colors);
        clearAllActive();
        sw.classList.add('active');
        syncPickers(colors);
        const ct = sw.dataset.custom ? customThemes[name] : null;
        const f = ct && ct.font ? ct.font : DEFAULT_FONT;
        const d = ct && ct.density ? ct.density : DEFAULT_DENSITY;
        const p = ct && ct.bgPattern ? ct.bgPattern : (THEME_DEFAULT_PATTERN[name] || 'none');
        const ec = ct && ct.bgEffectColor ? ct.bgEffectColor : (THEME_DEFAULT_EFFECT_COLOR[name] || '');
        const ei = (ct && ct.bgEffectIntensity !== undefined) ? ct.bgEffectIntensity : (THEME_DEFAULT_INTENSITY[name] !== undefined ? THEME_DEFAULT_INTENSITY[name] : 1);
        const sz = (ct && ct.bgEffectSize !== undefined) ? ct.bgEffectSize : 1;
        const fr = (ct && ct.frosted !== undefined)
          ? !!ct.frosted
          : (THEME_DEFAULT_FROSTED[name] === true);
        applyFontDensity(f, d);
        applyBgEffectColor(ec);
        applyBgEffectIntensity(ei);
        applyBgEffectSize(sz);
        applyFrostedGlass(fr);
        applyBgPattern(p);
        const fs = document.getElementById('theme-font-select');
        const ds = document.getElementById('theme-density-select');
        const ps = document.getElementById('theme-bg-pattern-select');
        const ecs = document.getElementById('theme-bg-effect-color');
        const eis = document.getElementById('theme-bg-intensity');
        const szs = document.getElementById('theme-bg-size');
        const frs = document.getElementById('theme-frosted-toggle');
        if (fs) fs.value = f;
        if (ds) ds.value = d;
        if (ps) ps.value = p;
        if (ecs) ecs.value = ec || colors.fg || '#9cdef2';
        if (eis) eis.value = String(Math.round(ei * 100));
        if (szs) szs.value = String(Math.round(sz * 100));
        if (frs) frs.checked = fr;
        save(name, colors, { font: f, density: d, bgPattern: p, bgEffectColor: ec, bgEffectIntensity: ei, bgEffectSize: sz, frosted: fr });
      });
    });
    g.querySelectorAll('.theme-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = btn.dataset.delete;
        if (uiModule && uiModule.styledConfirm) {
          if (!await uiModule.styledConfirm(`Delete theme "${name}"?`, { confirmText: 'Delete', danger: true })) return;
        }
        deleteCustomTheme(name);
      });
    });
  });

  // 从当前主题初始化颜色选择器并应用语法颜色
  const currentColors = saved ? saved.colors : THEMES[DEFAULT_THEME];
  applyColors(currentColors);
  syncPickers(currentColors);

  // 各选择器重置的参考颜色（你开始的基准主题）
  const refName = saved ? saved.name : DEFAULT_THEME;
  const refColors = THEMES[refName] || customThemes[refName] || currentColors;
  const refDefaults = computeAdvancedDefaults(refColors);

  // 根据颜色是否与参考值不同来同步重置按钮的可见性
  function syncResetButtons() {
    document.querySelectorAll('.color-reset-btn[data-reset]').forEach(btn => {
      const key = btn.dataset.reset;
      const picker = document.getElementById(pickerIds[key]);
      if (picker && refColors[key]) {
        btn.classList.toggle('changed', picker.value.toLowerCase() !== refColors[key].toLowerCase());
      }
    });
    document.querySelectorAll('.color-reset-btn[data-reset-adv]').forEach(btn => {
      const key = btn.dataset.resetAdv;
      const picker = document.getElementById('adv-' + key);
      const ref = refDefaults[key] || '';
      if (picker && ref) {
        btn.classList.toggle('changed', picker.value.toLowerCase() !== ref.toLowerCase());
      }
    });
  }

  // 颜色选择器实时更新。
  // 注意：不要克隆 input。attachColorPicker 已在这个确切的元素上安装了
  // value-getter 覆盖 + mousedown 处理器；克隆会导致两者都失效。
  // 改为使用一次性绑定标记。
  const pickerIds = { bg: 'clr-bg', fg: 'clr-fg', panel: 'clr-panel', border: 'clr-border', red: 'clr-red' };
  Object.entries(pickerIds).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.themeBound === '1') return;
    el.dataset.themeBound = '1';
    el.addEventListener('input', () => {
      // 在读取新选择器值之前捕获旧的调色板。
      // 下面用于判断哪些高级选择器有真实的用户自定义覆盖值
      // （值与旧计算默认不同）与哪些是过时的默认值
      // 应自动刷新。
      const _oldColors = {};
      Object.entries(pickerIds).forEach(([k, pid]) => {
        // 对用户触碰的那个选择器来说，值已经改变了（input 已触发）。
        // 对该选择器，读取当前值就是新的颜色，这没问题
        // — _oldDefaults 使用其余值。我们
        // 用 computeAdvancedDefaults({...new}) 计算新的默认值
        // 用 CSS 变量获取旧默认值。
      });
      const _rs = getComputedStyle(document.documentElement);
      _oldColors.bg     = (_rs.getPropertyValue('--bg')    || '').trim();
      _oldColors.fg     = (_rs.getPropertyValue('--fg')    || '').trim();
      _oldColors.panel  = (_rs.getPropertyValue('--panel') || '').trim();
      _oldColors.border = (_rs.getPropertyValue('--border')|| '').trim();
      _oldColors.red    = (_rs.getPropertyValue('--red')   || '').trim();
      const _oldDefaults = computeAdvancedDefaults(_oldColors);

      const colors = {};
      Object.entries(pickerIds).forEach(([k, pid]) => {
        colors[k] = document.getElementById(pid).value;
      });

      // 构建高级覆盖映射：只有值与旧默认值不同的选择器
      // 才计为用户自定义。未触碰的选择器（仍匹配旧默认值）
      // 会自动更新为新默认值，使其继续跟踪基础调色板
      // （例如发送按钮跟随强调色）。
      const _newDefaults = computeAdvancedDefaults(colors);
      const _adv = {};
      let _hasAdv = false;
      // 将颜色字符串规范化为小写 6 位十六进制值，使 getComputedStyle
      // 的值（保持设置时的值 — 可能是 #abc、#ABCDEF 或 rgb()）
      // 能正确与颜色输入选择器（始终为小写 #rrggbb）比较。
      // 没有这个规范化步骤，每个高级选择器都会被计为
      // "用户自定义"，我们会回到 v161 的 bug。
      const _norm = (raw) => {
        let h = String(raw || '').trim().toLowerCase();
        if (!h) return '';
        // rgb(r,g,b) 或 rgba(r,g,b,a)
        const rgb = h.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (rgb) {
          const hx = n => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
          return '#' + hx(rgb[1]) + hx(rgb[2]) + hx(rgb[3]);
        }
        if (h[0] !== '#') h = '#' + h;
        // 展开 #rgb → #rrggbb
        if (/^#[0-9a-f]{3}$/.test(h)) {
          return '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
        }
        return h;
      };
      for (const { key } of ADV_KEYS) {
        const pEl = document.getElementById('adv-' + key);
        if (!pEl) continue;
        if (_norm(pEl.value) !== _norm(_oldDefaults[key])) {
          _adv[key] = pEl.value;
          _hasAdv = true;
        } else {
          // 未触碰——滑动到新默认值以跟随新调色板
          pEl.value = _newDefaults[key];
        }
      }
      if (_hasAdv) colors.advanced = _adv;
      applyColors(colors);
      // 自动保存：如果活动主题是用户的自定义主题之一
      // 则将更改写回该主题，这样重命名/重新加载能保留编辑内容。
      // 否则回退到临时的'custom'槽（现有行为）
      const _activeSaved = getSaved();
      const _activeName = _activeSaved && _activeSaved.name;
      const _customMap = _loadCustomThemes();
      if (_activeName && _customMap && _customMap[_activeName]) {
        // 保留不属于基础颜色的 advanced/opts 键
        saveCustomTheme(_activeName, colors, {
          font: _activeSaved.font, density: _activeSaved.density,
          bgPattern: _activeSaved.bgPattern, bgEffectColor: _activeSaved.bgEffectColor,
          bgEffectIntensity: _activeSaved.bgEffectIntensity,
          bgEffectSize: _activeSaved.bgEffectSize,
        });
        _saveFull(_activeName, colors);
      } else {
        _saveFull('custom', colors);
      }
      _flashAutosaved();
      grid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      syncResetButtons();
    });
  });

  // 保存自定义主题——内联输入
  const saveNameInputOld = document.getElementById('theme-save-name');
  const saveGoBtnOld = document.getElementById('theme-save-go');
  const saveError = document.getElementById('theme-save-error');
  if (saveGoBtnOld && saveNameInputOld) {
    const newGoBtn = saveGoBtnOld.cloneNode(true);
    saveGoBtnOld.parentNode.replaceChild(newGoBtn, saveGoBtnOld);
    const newNameInput = saveNameInputOld.cloneNode(true);
    saveNameInputOld.parentNode.replaceChild(newNameInput, saveNameInputOld);
    const doSave = () => {
      saveError.style.display = 'none';
      const name = newNameInput.value.trim();
      if (!name) { saveError.textContent = t('theme.enter_name'); saveError.style.display = 'block'; return; }
      const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!slug) { saveError.textContent = t('theme.invalid_name'); saveError.style.display = 'block'; return; }
      if (THEMES[slug]) { saveError.textContent = t('theme.cannot_overwrite_builtin'); saveError.style.display = 'block'; return; }
      const colors = {};
      const pickerIds2 = { bg: 'clr-bg', fg: 'clr-fg', panel: 'clr-panel', border: 'clr-border', red: 'clr-red' };
      Object.entries(pickerIds2).forEach(([k, pid]) => { colors[k] = document.getElementById(pid).value; });
      const adv = {};
      const defaults = computeAdvancedDefaults(colors);
      let hasAdv = false;
      for (const { key } of ADV_KEYS) {
        const el = document.getElementById('adv-' + key);
        if (el && el.value !== defaults[key]) { adv[key] = el.value; hasAdv = true; }
      }
      if (hasAdv) colors.advanced = adv;
      const opts = _getOpts();
      const result = saveCustomTheme(slug, colors, opts);
      if (result === 'limit') { saveError.textContent = t('theme.max_themes', { max: MAX_CUSTOM_THEMES }); saveError.style.display = 'block'; return; }
      save(slug, colors, opts);
      newNameInput.value = '';
      _flashAutosaved(t('theme.theme_saved'));
      uiModule.showToast?.(t('theme.theme_saved'));
      const prevHtml = newGoBtn.innerHTML;
      newGoBtn.disabled = true;
      newGoBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>' + t('settings.saved') + '</span>';
      setTimeout(() => {
        newGoBtn.disabled = false;
        newGoBtn.innerHTML = prevHtml;
      }, 1200);
    };
    newGoBtn.addEventListener('click', doSave);
    newNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
  }

  // 重置按钮
  const resetBtn = document.getElementById('theme-reset-btn');
  if (resetBtn) {
    const newReset = resetBtn.cloneNode(true);
    resetBtn.parentNode.replaceChild(newReset, resetBtn);
    newReset.addEventListener('click', () => {
      Storage.remove(LS_KEY);
      const colors = THEMES[DEFAULT_THEME];
      applyColors(colors);
      syncPickers(colors);
      applyFontDensity(DEFAULT_FONT, DEFAULT_DENSITY);
      applyBgPattern('none');
      const fs = document.getElementById('theme-font-select');
      const ds = document.getElementById('theme-density-select');
      const ps = document.getElementById('theme-bg-pattern-select');
      if (fs) fs.value = DEFAULT_FONT;
      if (ds) ds.value = DEFAULT_DENSITY;
      if (ps) ps.value = 'none';
      grid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      const darkSwatch = grid.querySelector('[data-theme="dark"]');
      if (darkSwatch) darkSwatch.classList.add('active');
    });
  }

  // 高级部分切换
  const advToggle = document.getElementById('theme-adv-toggle');
  const advSection = document.getElementById('themeAdvanced');
  if (advToggle && advSection) {
    const newToggle = advToggle.cloneNode(true);
    advToggle.parentNode.replaceChild(newToggle, advToggle);
    newToggle.addEventListener('click', () => {
      advSection.classList.toggle('hidden');
      newToggle.classList.toggle('open');
      // 重新扫描行，使高级颜色输入也能获得悬停高亮
      const root = document.getElementById('theme-tab-customize');
      if (root) root.dataset.zoneBound = '';
      initThemeZoneHighlight();
    });
  }
  // 绑定颜色行的悬停高亮，让用户看到每个输入编辑的 UI 区域
  // 编辑。
  initThemeZoneHighlight();

  // 高级颜色选择器实时更新
  function readCurrentColors() {
    const pickerIds2 = { bg: 'clr-bg', fg: 'clr-fg', panel: 'clr-panel', border: 'clr-border', red: 'clr-red' };
    const c = {};
    Object.entries(pickerIds2).forEach(([k, pid]) => { c[k] = document.getElementById(pid).value; });
    return c;
  }

  function readAdvanced() {
    const adv = {};
    const base = readCurrentColors();
    const defaults = computeAdvancedDefaults(base);
    let hasOverrides = false;
    for (const { key } of ADV_KEYS) {
      const el = document.getElementById('adv-' + key);
      if (!el) continue;
      const v = (el.value || '').toLowerCase();
      // 跳过空的或从未填充的输入，避免意外存储
      // （然后写入 '#000000' 到 CSS 变量）。
      if (!v || !/^#[0-9a-f]{6}$/.test(v)) continue;
      if (v !== (defaults[key] || '').toLowerCase()) {
        adv[key] = el.value;
        hasOverrides = true;
      }
    }
    return hasOverrides ? adv : undefined;
  }

  for (const { key } of ADV_KEYS) {
    const el = document.getElementById('adv-' + key);
    if (!el || el.dataset.themeBound === '1') continue;
    el.dataset.themeBound = '1';
    el.addEventListener('input', () => {
      const base = readCurrentColors();
      base.advanced = readAdvanced();
      applyColors(base);
      // 与上方基础颜色输入相同的自动保存路由——写入
      // 自定义主题则写入该主题，否则回退到
      // 临时的 'custom' 槽位。
      const _activeSaved = getSaved();
      const _activeName = _activeSaved && _activeSaved.name;
      const _customMap = _loadCustomThemes();
      if (_activeName && _customMap && _customMap[_activeName]) {
        saveCustomTheme(_activeName, base, {
          font: _activeSaved.font, density: _activeSaved.density,
          bgPattern: _activeSaved.bgPattern, bgEffectColor: _activeSaved.bgEffectColor,
          bgEffectIntensity: _activeSaved.bgEffectIntensity,
          bgEffectSize: _activeSaved.bgEffectSize,
        });
        _saveFull(_activeName, base);
      } else {
        _saveFull('custom', base);
      }
      _flashAutosaved();
      grid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      syncResetButtons();
    });
  }

  // 清除高级覆盖按钮
  const advClearBtn = document.getElementById('theme-adv-clear');
  if (advClearBtn) {
    const newClear = advClearBtn.cloneNode(true);
    advClearBtn.parentNode.replaceChild(newClear, advClearBtn);
    newClear.addEventListener('click', () => {
      const base = readCurrentColors();
      delete base.advanced;
      applyColors(base);
      _saveFull('custom', base);
      syncAdvancedPickers(base);
      syncResetButtons();
    });
  }

  // 各选择器的重置按钮（基础颜色）
  document.querySelectorAll('.color-reset-btn[data-reset]').forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      const key = newBtn.dataset.reset;
      const picker = document.getElementById(pickerIds[key]);
      if (picker && refColors[key]) {
        picker.value = refColors[key];
        picker.dispatchEvent(new Event('input'));
      }
    });
  });

  // 效果颜色重置按钮
  document.querySelectorAll('.color-reset-btn[data-reset-effect]').forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      const ec = document.getElementById('theme-bg-effect-color');
      if (ec) {
        const fg = currentColors.fg || '#9cdef2';
        ec.value = fg;
        applyBgEffectColor('');
        const s = getSaved(); if (s) _saveFull(s.name, s.colors);
      }
    });
  });

  // 各选择器的重置按钮（高级颜色）
  document.querySelectorAll('.color-reset-btn[data-reset-adv]').forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      const key = newBtn.dataset.resetAdv;
      const picker = document.getElementById('adv-' + key);
      if (picker) {
        picker.value = refDefaults[key] || computeAdvancedDefaults(refColors)[key];
        picker.dispatchEvent(new Event('input'));
      }
    });
  });

  // 重置按钮可见性的初始同步
  syncResetButtons();

  // 字体、密度、背景图案控件
  const _initFont = (saved && saved.font) || DEFAULT_FONT;
  const _initDensity = (saved && saved.density) || DEFAULT_DENSITY;
  const _initPattern = (saved && saved.bgPattern) || (saved && THEME_DEFAULT_PATTERN[saved.name]) || 'none';
  const _initEffectColor = (saved && saved.bgEffectColor) || (saved && THEME_DEFAULT_EFFECT_COLOR[saved.name]) || '';
  const _initEffectIntensity = (saved && saved.bgEffectIntensity !== undefined)
    ? saved.bgEffectIntensity
    : (saved && THEME_DEFAULT_INTENSITY[saved.name] !== undefined ? THEME_DEFAULT_INTENSITY[saved.name] : 1);
  const _initEffectSize = (saved && saved.bgEffectSize !== undefined) ? saved.bgEffectSize : 1;
  const _initFrosted = (saved && saved.frosted !== undefined)
    ? !!saved.frosted
    : (saved && THEME_DEFAULT_FROSTED[saved.name] === true);
  applyFontDensity(_initFont, _initDensity);
  applyBgEffectColor(_initEffectColor);
  applyBgEffectIntensity(_initEffectIntensity);
  applyBgEffectSize(_initEffectSize);
  applyFrostedGlass(_initFrosted);
  applyBgPattern(_initPattern);

  const fontSelect = document.getElementById('theme-font-select');
  const densitySelect = document.getElementById('theme-density-select');
  const patternSelect = document.getElementById('theme-bg-pattern-select');

  if (fontSelect) {
    const nf = fontSelect.cloneNode(true); fontSelect.parentNode.replaceChild(nf, fontSelect);
    nf.value = _initFont;
    nf.addEventListener('change', () => {
      applyFontDensity(nf.value, document.getElementById('theme-density-select').value);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
    // 从本地文件夹获取自定义字体并填充下拉菜单
    fetch('/api/fonts/custom', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(data => {
        _customFonts = data.fonts || {};
        const families = Object.keys(_customFonts);
        nf.querySelectorAll('option[data-custom-font]').forEach(o => o.remove());
        for (const fam of families) {
          const opt = document.createElement('option');
          opt.value = fam;
          opt.textContent = fam;
          opt.dataset.customFont = '1';
          nf.appendChild(opt);
        }
        // 选项填充后恢复已保存的值
        nf.value = _initFont;
      })
      .catch(e => console.warn('Custom fonts fetch failed:', e));
  }
  if (densitySelect) {
    const nd = densitySelect.cloneNode(true); densitySelect.parentNode.replaceChild(nd, densitySelect);
    nd.value = _initDensity;
    nd.addEventListener('change', () => {
      applyFontDensity(document.getElementById('theme-font-select').value, nd.value);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }
  if (patternSelect) {
    const np = patternSelect.cloneNode(true); patternSelect.parentNode.replaceChild(np, patternSelect);
    np.value = _initPattern;
    np.addEventListener('change', () => {
      applyBgPattern(np.value);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }

  const effectColorPicker = document.getElementById('theme-bg-effect-color');
  if (effectColorPicker) {
    effectColorPicker.value = _initEffectColor || currentColors.fg || '#9cdef2';
    effectColorPicker.addEventListener('input', () => {
      applyBgEffectColor(effectColorPicker.value);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }

  const intensitySlider = document.getElementById('theme-bg-intensity');
  if (intensitySlider) {
    intensitySlider.value = String(Math.round(_initEffectIntensity * 100));
    intensitySlider.addEventListener('input', () => {
      applyBgEffectIntensity(parseFloat(intensitySlider.value) / 100);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }

  const sizeSlider = document.getElementById('theme-bg-size');
  if (sizeSlider) {
    sizeSlider.value = String(Math.round(_initEffectSize * 100));
    sizeSlider.addEventListener('input', () => {
      applyBgEffectSize(parseFloat(sizeSlider.value) / 100);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }

  const frostedToggle = document.getElementById('theme-frosted-toggle');
  if (frostedToggle) {
    frostedToggle.checked = _initFrosted;
    frostedToggle.addEventListener('change', () => {
      applyFrostedGlass(frostedToggle.checked);
      const s = getSaved(); if (s) _saveFull(s.name, s.colors);
    });
  }

  // --- 颜色和谐生成器（在高级部分内） ---
  const harmonyGenBtnEl = document.getElementById('harmony-generate-btn');
  const harmonyAccentEl = document.getElementById('harmony-accent');
  // 确保内部颜色选择器确实已附加到此元素。
  // 全局 initColorPickers() 调用应该已经捕获了它，但在旧会话/部分加载中
  // 有时没有被包装 —
  // 幂等地调用 attachColorPicker，使弹出框、建议、最近使用
  // 和十六进制同步全部匹配其他每个颜色行。
  if (harmonyAccentEl) {
    try { attachColorPicker(harmonyAccentEl); } catch (_) {}
  }
  // 保持十六进制显示芯片与选择器报告的值同步
  const _harmonyHex = document.getElementById('harmony-accent-hex');
  if (harmonyAccentEl && _harmonyHex) {
    _harmonyHex.textContent = harmonyAccentEl.value || '#e06c75';
    harmonyAccentEl.addEventListener('input', () => {
      _harmonyHex.textContent = harmonyAccentEl.value;
    });
  }
  if (harmonyGenBtnEl) {
    const newGen = harmonyGenBtnEl.cloneNode(true);
    harmonyGenBtnEl.parentNode.replaceChild(newGen, harmonyGenBtnEl);
    newGen.addEventListener('click', () => {
      const accent = document.getElementById('harmony-accent').value;
      const type = document.getElementById('harmony-type').value;
      const mode = document.getElementById('harmony-mode').value;
      const colors = generateHarmonyColors(accent, type, mode);
      applyColors(colors);
      syncPickers(colors);
      _saveFull('custom', colors);
      grid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      const prev = document.getElementById('harmony-preview');
      if (prev) prev.innerHTML = [colors.bg, colors.panel, colors.fg, colors.border, colors.red].map(c => `<span style="background:${c}"></span>`).join('');
    });
  }
  if (harmonyAccentEl) {
    const newAcc = harmonyAccentEl.cloneNode(true);
    harmonyAccentEl.parentNode.replaceChild(newAcc, harmonyAccentEl);
    // 将内部颜色选择器重新附加到新的克隆。cloneNode
    // 复制了 data-cp-attached="1" 标志但不会复制监听器，因此我们必须
    // 先清除标志，否则 attachColorPicker 会作为空操作退出。
    delete newAcc.dataset.cpAttached;
    newAcc.type = 'color'; // 克隆元素可能是之前附加时的 type=text
    try { attachColorPicker(newAcc); } catch (_) {}
    newAcc.addEventListener('input', () => {
      const type = document.getElementById('harmony-type').value;
      const mode = document.getElementById('harmony-mode').value;
      const colors = generateHarmonyColors(newAcc.value, type, mode);
      const prev = document.getElementById('harmony-preview');
      if (prev) prev.innerHTML = [colors.bg, colors.panel, colors.fg, colors.border, colors.red].map(c => `<span style="background:${c}"></span>`).join('');
      // 同步选择器旁的十六进制芯片
      const hex = document.getElementById('harmony-accent-hex');
      if (hex) hex.textContent = newAcc.value;
    });
  }

  // --- 导入 / 导出 ---
  const exportBtnEl = document.getElementById('theme-export-btn');
  const importBtnEl = document.getElementById('theme-import-btn');
  const importAreaEl = document.getElementById('theme-import-area');
  const importActionsEl = document.getElementById('theme-import-actions');
  const importGoEl = document.getElementById('theme-import-go');
  const importCancelEl = document.getElementById('theme-import-cancel');

  if (exportBtnEl) {
    const newExp = exportBtnEl.cloneNode(true);
    exportBtnEl.parentNode.replaceChild(newExp, exportBtnEl);
    newExp.addEventListener('click', () => {
      const colors = readCurrentColors();
      const adv = readAdvanced();
      if (adv) colors.advanced = adv;
      const cur = getSaved();
      const obj = { name: cur ? cur.name : 'custom', colors };
      if (cur && cur.font) obj.font = cur.font;
      if (cur && cur.density) obj.density = cur.density;
      if (cur && cur.bgPattern) obj.bgPattern = cur.bgPattern;
      if (cur && cur.bgEffectColor) obj.bgEffectColor = cur.bgEffectColor;
      const json = JSON.stringify(obj, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'odysseus_' + (obj.name || 'theme') + '.json';
      a.click();
      URL.revokeObjectURL(url);
      newExp.innerHTML = '&#x2713; Downloaded!';
      setTimeout(() => { newExp.innerHTML = '&#x2913; Export'; }, 1500);
    });
  }

  if (importBtnEl && importAreaEl && importActionsEl) {
    const newImp = importBtnEl.cloneNode(true);
    importBtnEl.parentNode.replaceChild(newImp, importBtnEl);
    newImp.addEventListener('click', () => {
      importAreaEl.classList.toggle('hidden');
      importActionsEl.classList.toggle('hidden');
      importAreaEl.value = '';
      saveError.style.display = 'none';
    });
  }

  if (importGoEl && importAreaEl) {
    const newGo = importGoEl.cloneNode(true);
    importGoEl.parentNode.replaceChild(newGo, importGoEl);
    newGo.addEventListener('click', () => {
      saveError.style.display = 'none';
      let parsed;
      try { parsed = JSON.parse(importAreaEl.value.trim()); }
      catch { saveError.textContent = t('theme.invalid_json'); saveError.style.display = 'block'; return; }
      let colors = parsed.colors || parsed;
      const name = parsed.name || 'imported';
      const required = ['bg', 'fg', 'panel', 'border', 'red'];
      const missing = required.filter(k => !colors[k]);
      if (missing.length) { saveError.textContent = t('theme.missing_colors') + missing.join(', '); saveError.style.display = 'block'; return; }
      const hexRe = /^#[0-9a-fA-F]{6}$/;
      for (const k of required) {
        if (!hexRe.test(colors[k])) { saveError.textContent = t('theme.bad_hex') + k; saveError.style.display = 'block'; return; }
      }
      const colorData = { bg: colors.bg, fg: colors.fg, panel: colors.panel, border: colors.border, red: colors.red };
      if (colors.advanced && typeof colors.advanced === 'object') colorData.advanced = colors.advanced;
      const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'imported';
      const opts = {};
      if (parsed.font) opts.font = parsed.font;
      if (parsed.density) opts.density = parsed.density;
      if (parsed.bgPattern) opts.bgPattern = parsed.bgPattern;
      if (parsed.bgEffectColor) opts.bgEffectColor = parsed.bgEffectColor;
      const result = saveCustomTheme(slug, colorData, opts);
      if (result === 'limit') { saveError.textContent = t('theme.max_themes', { max: MAX_CUSTOM_THEMES }); saveError.style.display = 'block'; return; }
      save(slug, colorData, opts);
      applyColors(colorData);
      applyFontDensity(opts.font || DEFAULT_FONT, opts.density || DEFAULT_DENSITY);
      applyBgEffectColor(opts.bgEffectColor || '');
      applyBgPattern(opts.bgPattern || 'none');
      importAreaEl.classList.add('hidden');
      importActionsEl.classList.add('hidden');
    });
  }

  if (importCancelEl && importAreaEl && importActionsEl) {
    const newCancel = importCancelEl.cloneNode(true);
    importCancelEl.parentNode.replaceChild(newCancel, importCancelEl);
    newCancel.addEventListener('click', () => {
      importAreaEl.classList.add('hidden');
      importActionsEl.classList.add('hidden');
      importAreaEl.value = '';
      saveError.style.display = 'none';
    });
  }

  // 主题弹出框现在使用标准模态框框架（不可拖动）
}

// ── 区域高亮器 ───────────────────────────────────────────────────
// 将每个颜色输入 ID 映射到其影响的 UI 部分的选择器
// 当用户悬停在颜色行上时，在匹配元素上叠加半透明框
// 让用户清楚知道正在编辑什么。
const _THEME_ZONE_MAP = {
  'clr-bg':            'body',
  'clr-fg':            '.msg .body, .chat-input-bar',
  'clr-panel':         '.sidebar',
  'clr-border':        '.chat-input-bar, .sidebar, .msg .body',
  'clr-red':           '.send-btn, .icon-rail-btn.active',
  'theme-bg-effect-color': 'body',
  'adv-userBubbleBg':  '.msg.msg-user .body',
  'adv-aiBubbleBg':    '.msg.msg-ai .body',
  'adv-bubbleBorder':  '.msg .body',
  'adv-sidebarBg':     '.sidebar',
  'adv-sectionAccent': '.sidebar h4',
  'adv-brandColor':    '#sidebar-brand-btn',
  'adv-inputBg':       '#message',
  'adv-inputBorder':   '.chat-input-bar',
  'adv-sendBtnBg':     '.send-btn',
  'adv-sendBtnHover':  '.send-btn',
  'adv-codeBg':        'pre, code',
  'adv-codeFg':        'pre code, p code',
  'adv-toggleBg':      '.mode-toggle, .admin-switch',
  'adv-toggleActive':  '.mode-toggle-btn.active, .admin-switch input:checked + .admin-slider',
  'adv-accentPrimary': '.send-btn, .icon-rail-btn.active',
  'adv-accentError':   '.toast.error',
};

function _showThemeZoneHighlight(selector) {
  _clearThemeZoneHighlight();
  if (!selector) return;
  let els;
  try { els = document.querySelectorAll(selector); }
  catch { return; }
  els.forEach(el => {
    // 跳过主题模态框内的元素——高亮自身是干扰
    if (el.closest && el.closest('#theme-modal')) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const overlay = document.createElement('div');
    overlay.className = 'theme-zone-highlight';
    overlay.style.top    = (r.top - 2) + 'px';
    overlay.style.left   = (r.left - 2) + 'px';
    overlay.style.width  = (r.width + 4) + 'px';
    overlay.style.height = (r.height + 4) + 'px';
    document.body.appendChild(overlay);
  });
}

function _clearThemeZoneHighlight() {
  document.querySelectorAll('.theme-zone-highlight').forEach(el => el.remove());
}

let _flashTimer = null;
function _flashAutosaved(label = 'Auto-saved') {
  let pill = document.getElementById('theme-autosaved-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'theme-autosaved-pill';
    pill.className = 'theme-autosaved-pill';
    pill.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span></span>';
    // 锚定在自定义标签页内，使其随表单浮动
    const customizeTab = document.getElementById('theme-tab-customize');
    (customizeTab || document.body).appendChild(pill);
  }
  const labelEl = pill.querySelector('span');
  if (labelEl) labelEl.textContent = label;
  pill.classList.add('visible');
  clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => pill.classList.remove('visible'), 1100);
}

// 为主题模态框内每个颜色行绑定悬停高亮。调用
// 进入 DOM 后调用一次。幂等操作。
export function initThemeZoneHighlight() {
  const root = document.getElementById('theme-tab-customize');
  if (!root || root.dataset.zoneBound === '1') return;
  root.dataset.zoneBound = '1';
  root.querySelectorAll('.color-row').forEach(row => {
    const input = row.querySelector('input[type="color"]');
    if (!input) return;
    const sel = _THEME_ZONE_MAP[input.id];
    if (!sel) return;
    row.addEventListener('mouseenter', () => _showThemeZoneHighlight(sel));
    row.addEventListener('mouseleave', _clearThemeZoneHighlight);
    // 当选择器实际打开时也触发（输入框获焦）
    input.addEventListener('focus', () => _showThemeZoneHighlight(sel));
    input.addEventListener('blur', _clearThemeZoneHighlight);
  });
  // 模态框关闭时清除高亮
  const modal = document.getElementById('theme-modal');
  if (modal) {
    new MutationObserver(() => {
      if (modal.classList.contains('hidden')) _clearThemeZoneHighlight();
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
}

// 固定定位元素的通用拖拽辅助函数
// 对共享 makeWindowDraggable 辅助函数的薄包装。现有
// (el, handle)——el 是需要移动的元素，handle 是拖拽手柄。
// 不支持全屏（这些消费者都不需要）。
export function makeDraggable(el, handle) {
  if (!el || !handle) return;
  const dockTarget = (el.closest && el.closest('.modal')) || el;
  const dragOptions = {
    content: el,
    header: handle,
    // 当用户抓取交互控件时不启动窗口拖拽
    // 例如主题透明度滑块现在位于标题旁边，
    // 拖拽其滑块应该移动滑块而非窗口。
    skipSelector: 'button, input, select, .theme-opacity-wrap',
  };
  if (dockTarget && dockTarget.id === 'theme-modal') {
    dragOptions.onEnterFullscreen = () => {
      snapModalToZone(dockTarget, {
        name: 'fullscreen',
        rect: {
          left: 0,
          top: 0,
          width: window.innerWidth || document.documentElement.clientWidth || 0,
          height: window.innerHeight || document.documentElement.clientHeight || 0,
        },
      });
    };
  }
  makeWindowDraggable(dockTarget, dragOptions);
}

// 切换弹出框
export function togglePopup() {
  const modal = document.getElementById('theme-modal');
  if (!modal) return;
  const visible = !modal.classList.contains('hidden');
  if (visible) {
    modal.classList.add('hidden');
  } else {
    modal.classList.remove('hidden');
  }
}

export function closePopup() {
  const modal = document.getElementById('theme-modal');
  if (!modal) return;
  const content = modal.querySelector('.modal-content');
  if (content && !content.classList.contains('modal-closing')) {
    content.classList.add('modal-closing');
    content.addEventListener('animationend', () => {
      modal.classList.add('hidden');
      content.classList.remove('modal-closing');
    }, { once: true });
    setTimeout(() => { if (!modal.classList.contains('hidden')) { modal.classList.add('hidden'); content.classList.remove('modal-closing'); } }, 250);
  } else {
    modal.classList.add('hidden');
  }
}

// 暴露给 app.js 接线 + AI ui_control
export function getCustomThemes() { return _loadCustomThemes(); }

// ── Synapse 背景效果 ──
// 以 CSS 网格图案为基础，在网格线上叠加快速移动的小光脉冲
function _initSynapse() {
  if (document.getElementById('synapse-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'synapse-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // 装饰性背景效果 — 对辅助技术隐藏，这样屏幕阅读器
  // 不会播报空白 canvas，axe 的 "region" 规则也不会标记它。
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const GRID = 24; // 与 CSS 网格大小匹配
  const MAX_PULSES = 20;
  const SPEED_MIN = 2;
  const SPEED_MAX = 22;
  const TRAIL_LEN = 12; // 拖尾光晕的像素长度

  let W, H, cols, rows, pulses = [];

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(W / GRID); rows = Math.ceil(H / GRID);
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);

  function getColor() {
    const s = getComputedStyle(document.documentElement);
    return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2';
  }

  function spawnPulse() {
    const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
    if (Math.random() > 0.5) {
      // 水平——选择一个网格行
      const row = Math.floor(Math.random() * (rows + 1));
      pulses.push({ x: -TRAIL_LEN, y: row * GRID, dx: speed, dy: 0 });
    } else {
      // 垂直——选择一个网格列
      const col = Math.floor(Math.random() * (cols + 1));
      pulses.push({ x: col * GRID, y: -TRAIL_LEN, dx: 0, dy: speed });
    }
  }

  function draw() {
    if (!document.body.classList.contains('bg-pattern-synapse')) {
      window.removeEventListener('resize', _onResize);
      canvas.remove();
      return;
    }
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, W, H);
    const c = getColor();

    // 生成
    if (pulses.length < MAX_PULSES && Math.random() < 0.12) spawnPulse();

    // 将脉冲绘制为带有短拖尾的小亮点
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.x += p.dx; p.y += p.dy;

      // 离屏——移除
      if (p.x > W + TRAIL_LEN || p.y > H + TRAIL_LEN) { pulses.splice(i, 1); continue; }

      // 拖尾（在点后渐隐的线条渐变）
      const tx = p.x - (p.dx > 0 ? TRAIL_LEN : 0);
      const ty = p.y - (p.dy > 0 ? TRAIL_LEN : 0);
      const grad = ctx.createLinearGradient(tx, ty, p.x, p.y);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(1, c);
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();

      // 头部亮点
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }
  draw();
}

// ── 雨 — 下落细竖线 ──
function _initRain() {
  if (document.getElementById('rain-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'rain-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // 装饰性背景效果 — 对辅助技术隐藏，这样屏幕阅读器
  // 不会播报空白 canvas，axe 的 "region" 规则也不会标记它。
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H;
  const drops = [];
  const MAX_DROPS = 130;

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);

  function getColor() {
    const s = getComputedStyle(document.documentElement);
    return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2';
  }

  function spawn() {
    const len = 20 + Math.random() * 40;
    const speed = 4 + Math.random() * 8;
    drops.push({ x: Math.random() * W, y: -len, len, speed, alpha: 0.32 + Math.random() * 0.28 });
  }

  function draw() {
    if (!document.body.classList.contains('bg-pattern-rain')) {
      window.removeEventListener('resize', _onResize);
      canvas.remove();
      return;
    }
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, W, H);
    const c = getColor();
    // 强度同时控制雨的速度 + 生成率（昏暗时感觉更慢/更轻）
    const intenCss = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bg-effect-intensity'));
    const inten = isNaN(intenCss) ? 1 : intenCss;
    const speedMult = 0.35 + inten * 0.65;
    const sizeMult = _getEffectSize();

    if (drops.length < MAX_DROPS * inten && Math.random() < 0.6 * inten) spawn();

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.y += d.speed * speedMult;
      if (d.y > H + d.len * sizeMult) { drops.splice(i, 1); continue; }

      const effLen = d.len * sizeMult;
      const grad = ctx.createLinearGradient(d.x, d.y - effLen, d.x, d.y);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(1, c);
      ctx.strokeStyle = grad;
      ctx.globalAlpha = d.alpha;
      ctx.lineWidth = 1.3 * Math.min(2, Math.max(0.6, sizeMult));
      ctx.beginPath();
      ctx.moveTo(d.x, d.y - effLen);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  draw();
}

// ── 星座 — 缓慢形成/消散连接线的静态点 ──
function _initConstellations() {
  if (document.getElementById('constellations-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'constellations-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // 装饰性背景效果 — 对辅助技术隐藏，这样屏幕阅读器
  // 不会播报空白 canvas，axe 的 "region" 规则也不会标记它。
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H;
  const STAR_COUNT = 50;
  const CONNECT_DIST = 120;
  let stars = [];

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (stars.length === 0) initStars();
  }

  function initStars() {
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.15,
        vy: (Math.random() - 0.5) * 0.15,
        r: 0.8 + Math.random() * 0.8,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  resize();
  const _onResize = () => { resize(); initStars(); };
  window.addEventListener('resize', _onResize);

  function getColor() {
    const s = getComputedStyle(document.documentElement);
    return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2';
  }

  let t = 0;
  function draw() {
    if (!document.body.classList.contains('bg-pattern-constellations')) {
      window.removeEventListener('resize', _onResize);
      canvas.remove();
      return;
    }
    requestAnimationFrame(draw);
    t += 0.01;
    ctx.clearRect(0, 0, W, H);
    const c = getColor();

    // 轻柔地移动星星
    for (const s of stars) {
      s.x += s.vx; s.y += s.vy;
      if (s.x < 0) s.x = W; if (s.x > W) s.x = 0;
      if (s.y < 0) s.y = H; if (s.y > H) s.y = 0;
    }

    // 绘制连接线
    ctx.strokeStyle = c;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].x - stars[j].x;
        const dy = stars[i].y - stars[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CONNECT_DIST) {
          ctx.globalAlpha = (1 - dist / CONNECT_DIST) * 0.15;
          ctx.beginPath();
          ctx.moveTo(stars[i].x, stars[i].y);
          ctx.lineTo(stars[j].x, stars[j].y);
          ctx.stroke();
        }
      }
    }

    // 用微妙的闪烁绘制星星
    ctx.fillStyle = c;
    for (const s of stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(t * 2 + s.phase);
      ctx.globalAlpha = 0.15 + twinkle * 0.25;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  draw();
}

// ── Perlin 效果噪声辅助函数 ──
function _bgNoise2d(x, y) { const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return n - Math.floor(n); }
function _bgSmoothNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const a = _bgNoise2d(ix, iy), b = _bgNoise2d(ix + 1, iy), cc = _bgNoise2d(ix, iy + 1), d = _bgNoise2d(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * ux + (cc - a) * uy + (a - b - cc + d) * ux * uy;
}

// ── Perlin 流 — 彩色粒子流 ──
function _initPerlinFlow() {
  if (document.getElementById('perlin-flow-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'perlin-flow-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // 装饰性背景效果 — 对辅助技术隐藏，这样屏幕阅读器
  // 不会播报空白 canvas，axe 的 "region" 规则也不会标记它。
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H, t = 0;
  const particles = [];
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (particles.length === 0) for (let i = 0; i < 200; i++) particles.push({ x: Math.random() * W, y: Math.random() * H, life: Math.random() });
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);
  function getColor() { const s = getComputedStyle(document.documentElement); return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2'; }
  function getBg() { return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#282c34'; }
  let _cachedBg = '', _fadeStyle = '';
  function getFade() {
    const bg = getBg();
    if (bg !== _cachedBg) {
      _cachedBg = bg;
      // 解析十六进制为 RGB 以进行 RGBA 渐变
      const { r, g, b } = hexToRgb(bg) || { r: 0, g: 0, b: 0 };
      _fadeStyle = `rgba(${r},${g},${b},0.02)`;
    }
    return _fadeStyle;
  }
  function draw() {
    if (!document.body.classList.contains('bg-pattern-perlin-flow')) { window.removeEventListener('resize', _onResize); canvas.remove(); return; }
    requestAnimationFrame(draw);
    ctx.fillStyle = getFade();
    ctx.fillRect(0, 0, W, H);
    const c = getColor();
    particles.forEach(p => {
      const n = _bgSmoothNoise(p.x * 0.004 + t * 0.0008, p.y * 0.004 + 100);
      const angle = n * Math.PI * 6;
      const speed = 1 + _bgSmoothNoise(p.x * 0.003, p.y * 0.003 + 50) * 1.5;
      p.x += Math.cos(angle) * speed; p.y += Math.sin(angle) * speed; p.life -= 0.001;
      if (p.life <= 0 || p.x < 0 || p.x > W || p.y < 0 || p.y > H) { p.x = Math.random() * W; p.y = Math.random() * H; p.life = 1; }
      ctx.beginPath(); ctx.arc(p.x, p.y, 1, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.globalAlpha = p.life * 0.15; ctx.fill();
    });
    ctx.globalAlpha = 1;
    t++;
  }
  draw();
}

// ── 花瓣 — 轻柔飘落的花瓣 ──
function _initPetals() {
  if (document.getElementById('petals-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'petals-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // 装饰性背景效果 — 对辅助技术隐藏，这样屏幕阅读器
  // 不会播报空白 canvas，axe 的 "region" 规则也不会标记它。
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H;
  const petals = [];
  function makePetal() {
    return {
      x: Math.random() * W, y: -10 - Math.random() * 40,
      size: 3 + Math.random() * 5, rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.03, vy: 0.3 + Math.random() * 0.6,
      drift: Math.random() * Math.PI * 2, driftSpeed: 0.008 + Math.random() * 0.012,
      wobble: 0.3 + Math.random() * 0.8
    };
  }
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (petals.length === 0) for (let i = 0; i < 30; i++) { const p = makePetal(); p.y = Math.random() * H; petals.push(p); }
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);
  function getColor() { const s = getComputedStyle(document.documentElement); return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2'; }
  function draw() {
    if (!document.body.classList.contains('bg-pattern-petals')) { window.removeEventListener('resize', _onResize); canvas.remove(); return; }
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, W, H);
    const c = getColor();
    const sz = _getEffectSize();
    petals.forEach(p => {
      p.y += p.vy; p.rot += p.vr; p.drift += p.driftSpeed;
      p.x += Math.sin(p.drift) * p.wobble;
      if (p.y > H + 15) Object.assign(p, makePetal());
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = 0.2;
      // 花瓣形状 — 两个重叠的椭圆
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.ellipse(-p.size * 0.2 * sz, 0, p.size * 0.6 * sz, p.size * 0.3 * sz, 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.15;
      ctx.beginPath(); ctx.ellipse(p.size * 0.2 * sz, 0, p.size * 0.6 * sz, p.size * 0.3 * sz, -0.3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
    ctx.globalAlpha = 1;
  }
  draw();
}

// ── 星光 — 闪烁的星形闪光 ──
function _initSparkles() {
  if (document.getElementById('sparkles-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'sparkles-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // 装饰性背景效果 — 对辅助技术隐藏，这样屏幕阅读器
  // 不会播报空白 canvas，axe 的 "region" 规则也不会标记它。
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H;
  const sparkles = [];
  function makeSpark() {
    return { x: Math.random() * W, y: Math.random() * H, size: 2 + Math.random() * 5, phase: Math.random() * Math.PI * 2, speed: 0.015 + Math.random() * 0.03, life: 0.5 + Math.random() * 0.5 };
  }
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sparkles.length === 0) for (let i = 0; i < 35; i++) sparkles.push(makeSpark());
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);
  function getColor() { const s = getComputedStyle(document.documentElement); return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2'; }
  function drawStar(x, y, r, c, alpha) {
    ctx.save(); ctx.translate(x, y); ctx.fillStyle = c; ctx.globalAlpha = alpha;
    // 四角星
    ctx.beginPath();
    ctx.moveTo(0, -r); ctx.quadraticCurveTo(r * 0.15, -r * 0.15, r, 0);
    ctx.quadraticCurveTo(r * 0.15, r * 0.15, 0, r);
    ctx.quadraticCurveTo(-r * 0.15, r * 0.15, -r, 0);
    ctx.quadraticCurveTo(-r * 0.15, -r * 0.15, 0, -r);
    ctx.fill();
    ctx.restore();
  }
  function draw() {
    if (!document.body.classList.contains('bg-pattern-sparkles')) { window.removeEventListener('resize', _onResize); canvas.remove(); return; }
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, W, H);
    const c = getColor();
    const sizeMult = _getEffectSize();
    sparkles.forEach(s => {
      s.phase += s.speed;
      const twinkle = Math.sin(s.phase);
      const alpha = Math.max(0, twinkle) * 0.25 * s.life;
      const scale = 0.5 + Math.max(0, twinkle) * 0.5;
      if (alpha > 0.01) drawStar(s.x, s.y, s.size * scale * sizeMult, c, alpha);
      // 当周期完成时重新生成
      if (s.phase > Math.PI * 6) Object.assign(s, makeSpark());
    });
    ctx.globalAlpha = 1;
  }
  draw();
}

// ── 余烬 — 温暖的粒子带着光晕上升，偶尔爆发火花 ──
function _initEmbers() {
  if (document.getElementById('embers-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'embers-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // 装饰性背景效果 — 对辅助技术隐藏，这样屏幕阅读器
  // 不会播报空白 canvas，axe 的 "region" 规则也不会标记它。
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H;
  const embers = [];
  function makeEmber() {
    return {
      x: Math.random() * W,
      y: H + Math.random() * 40,
      vx: (Math.random() - 0.5) * 0.3,
      vy: -0.3 - Math.random() * 0.8,
      r: 0.3 + Math.random() * 0.6,
      life: 0,
      maxLife: 220 + Math.random() * 220,
      wobble: Math.random() * Math.PI * 2,
      spark: false,
    };
  }
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (embers.length === 0) {
      for (let i = 0; i < 60; i++) { const e = makeEmber(); e.y = Math.random() * H; e.life = Math.random() * e.maxLife; embers.push(e); }
    }
  }
  resize();
  const _onResize = () => resize();
  window.addEventListener('resize', _onResize);
  function getColor() {
    const s = getComputedStyle(document.documentElement);
    return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#c9a95a';
  }
  function rgba(hex, a) {
    const { r, g, b } = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
    return `rgba(${r},${g},${b},${a})`;
  }
  function draw() {
    if (!document.body.classList.contains('bg-pattern-embers')) {
      window.removeEventListener('resize', _onResize);
      canvas.remove();
      return;
    }
    requestAnimationFrame(draw);
    // 淡出上一帧（destination-out 保持无火星处的画布透明）
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    const color = getColor();
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      e.wobble += 0.03;
      e.x += e.vx + Math.sin(e.wobble) * 0.5;
      e.y += e.vy;
      e.life++;
      if (e.life > e.maxLife || e.y < -20) {
        embers.splice(i, 1);
        if (embers.length < 70) embers.push(makeEmber());
        continue;
      }
      if (!e.spark && Math.random() < 0.003) e.spark = true;
      const lifeRatio = e.life / e.maxLife;
      const fade = Math.min(1, Math.min(lifeRatio * 4, (1 - lifeRatio) * 3));
      const sz = _getEffectSize();
      const r = e.r * (e.spark ? 2.4 : 1) * sz;
      const a = (e.spark ? 0.9 : 0.55) * fade;
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r * 4);
      g.addColorStop(0, rgba(color, a));
      g.addColorStop(0.4, rgba(color, a * 0.3));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(e.x - r * 4, e.y - r * 4, r * 8, r * 8);
      ctx.fillStyle = rgba('#ffffff', a * 0.6);
      ctx.beginPath();
      ctx.arc(e.x, e.y, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
      e.spark = false;
    }
    if (Math.random() < 0.015) {
      const bx = Math.random() * W;
      for (let i = 0; i < 5; i++) {
        const e = makeEmber();
        e.x = bx + (Math.random() - 0.5) * 40;
        e.y = H - 10;
        e.vy *= 1.5;
        embers.push(e);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  draw();
}

const themeModule = { initThemeUI, togglePopup, closePopup, makeDraggable,
                       THEMES, applyColors, applyFontDensity, applyBgPattern,
                       applyBgEffectColor, applyBgEffectIntensity, applyBgEffectSize,
                       applyFrostedGlass,
                       save, getSaved, saveCustomTheme, deleteCustomTheme,
                       getCustomThemes };

export default themeModule;

// DOM 就绪时初始化，具备服务器端同步回退
async function _initWithSync() {
  // 如果本地无主题，尝试从服务器加载（跨设备同步）
  if (!getSaved()) {
    const serverTheme = await _loadFromServer();
    if (serverTheme && serverTheme.colors) {
      if (serverTheme.name === 'sakura') serverTheme.name = 'ume';
      Storage.setJSON(LS_KEY, serverTheme);
      applyColors(serverTheme.colors);
    }
  }
  // 同时从服务器同步自定义主题
  try {
    const res = await fetch('/api/prefs/custom-themes', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.value && typeof data.value === 'object') {
      const local = _loadCustomThemes();
      // 合并：服务器主题填补缺失的本地主题
      let changed = false;
      for (const [name, colors] of Object.entries(data.value)) {
        if (!local[name]) { local[name] = colors; changed = true; }
      }
      if (changed) _saveCustomThemes(local);
    }
  } catch (e) { console.warn('Custom theme server sync failed:', e); }
  initThemeUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => _initWithSync());
} else {
  _initWithSync();
}
