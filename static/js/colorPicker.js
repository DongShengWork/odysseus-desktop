// 自建颜色选择器，带实时反馈 HSV 方框、色相条、
// 取色器、最近使用颜色与协调色建议。
// 非侵入式：包装现有 <input type="color"> 元素 —
// 它们的 .value 保持为真实数据源，我们派发 'input'
// 事件使现有监听器继续工作。

const LS_RECENT = 'odysseus-recent-colors';
const MAX_RECENT = 12;

let _popover = null;
let _input = null;
let _h = 0, _s = 100, _v = 100;   // HSV
let _drag = null;                  // 'sl' | 'hue' | null
let _onOutside = null;

// ── 颜色数学 ──────────────────────────────────────────────────────────
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function hexToRgb(hex) {
  hex = String(hex || '').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return { r: 0, g: 0, b: 0 };
  const n = parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v =>
    Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')
  ).join('');
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d === 0) h = 0;
  else if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s: s * 100, v: v * 100 };
}

function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  h /= 60; s /= 100; v /= 100;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function hsvToHex(h, s, v) { const { r, g, b } = hsvToRgb(h, s, v); return rgbToHex(r, g, b); }

function hexToHsv(hex) { const { r, g, b } = hexToRgb(hex); return rgbToHsv(r, g, b); }

// ── 存储 ──────────────────────────────────────────────────────────────
function getRecents() {
  try { return JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); }
  catch { return []; }
}

function addRecent(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
  let recents = getRecents().filter(c => c.toLowerCase() !== hex.toLowerCase());
  recents.unshift(hex.toLowerCase());
  recents = recents.slice(0, MAX_RECENT);
  try { localStorage.setItem(LS_RECENT, JSON.stringify(recents)); } catch {}
}

// ── 基于当前颜色的建议（5 个协调色色块）──────────────────────────────
function computeSuggestions() {
  // 互补色、类似色 ±30°、分裂互补色 (+150)、色调偏移
  return [
    { hex: hsvToHex(_h + 180, _s, _v),                                   label: 'Complement' },
    { hex: hsvToHex(_h + 30, _s, _v),                                    label: 'Analogous +30°' },
    { hex: hsvToHex(_h - 30, _s, _v),                                    label: 'Analogous -30°' },
    { hex: hsvToHex(_h + 150, _s, _v),                                   label: 'Split-complement' },
    { hex: hsvToHex(_h, _s, clamp(_v > 50 ? _v - 30 : _v + 30, 10, 95)), label: 'Tone shift' },
  ];
}

// ── 弹出框构建 ─────────────────────────────────────────────────────────
function buildPopover() {
  const p = document.createElement('div');
  p.className = 'cp-popover';
  p.innerHTML = `
    <div class="cp-sl" data-drag="sl">
      <div class="cp-sl-white"></div>
      <div class="cp-sl-black"></div>
      <div class="cp-sl-handle"></div>
    </div>
    <div class="cp-hue" data-drag="hue">
      <div class="cp-hue-handle"></div>
    </div>
    <div class="cp-row">
      <div class="cp-preview"></div>
      <input type="text" class="cp-hex" maxlength="7" spellcheck="false" autocomplete="off">
      <button class="cp-eyedropper" title="取色器" type="button">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 22l4-4m0 0l3-3 5 5-3 3a2 2 0 01-2.8 0l-2.2-2.2a2 2 0 010-2.8z"/>
          <path d="M14 8l3-3a3 3 0 014.2 4.2l-3 3-4.2-4.2z"/>
        </svg>
      </button>
    </div>
    <div class="cp-section-label">建议</div>
    <div class="cp-swatches cp-suggestions"></div>
    <div class="cp-section-label">最近</div>
    <div class="cp-swatches cp-recent"></div>
  `;
  document.body.appendChild(p);
  wireHandlers(p);
  return p;
}

// ── UI 同步 ────────────────────────────────────────────────────────────
function syncUI() {
  if (!_popover) return;
  const sl = _popover.querySelector('.cp-sl');
  const slH = _popover.querySelector('.cp-sl-handle');
  const hue = _popover.querySelector('.cp-hue');
  const hueH = _popover.querySelector('.cp-hue-handle');
  const hex = _popover.querySelector('.cp-hex');
  const preview = _popover.querySelector('.cp-preview');

  const pureHue = hsvToHex(_h, 100, 100);
  sl.style.background = pureHue;   // 基础色相 — 白色/黑色层通过 CSS 堆叠在上方

  slH.style.left = (_s) + '%';
  slH.style.top = (100 - _v) + '%';

  hueH.style.left = (_h / 360 * 100) + '%';

  const current = hsvToHex(_h, _s, _v);
  preview.style.background = current;
  if (document.activeElement !== hex) hex.value = current;

  // 建议
  const sContainer = _popover.querySelector('.cp-suggestions');
  const sugs = computeSuggestions();
  sContainer.innerHTML = sugs.map(s =>
    `<button class="cp-swatch" title="${s.label}: ${s.hex}" data-hex="${s.hex}" style="background:${s.hex}"></button>`
  ).join('');

  // 最近
  const rContainer = _popover.querySelector('.cp-recent');
  const recs = getRecents();
  rContainer.innerHTML = recs.length
    ? recs.map(h => `<button class="cp-swatch" title="${h}" data-hex="${h}" style="background:${h}"></button>`).join('')
    : '<div class="cp-recent-empty">(暂无)</div>';
}

function applyToInput(pushChange) {
  if (!_input) return;
  const hex = hsvToHex(_h, _s, _v);
  _input.value = hex;  // setter 也会更新 style.background
  if (pushChange) _input.dispatchEvent(new Event('input', { bubbles: true }));
  syncUI();
}

function setFromHex(hex) {
  const v = hexToHsv(hex);
  _h = v.h; _s = v.s; _v = v.v;
}

// ── 处理程序 ─────────────────────────────────────────────────────────
// 窗口级指针监听器 — 安装一次，不每次弹出框重建时安装，防止
// 每次打开弹出框重建时泄漏。
let _windowPointerInstalled = false;
function _installWindowPointer() {
  if (_windowPointerInstalled) return;
  _windowPointerInstalled = true;
  window.addEventListener('pointermove', (e) => { if (_drag) handleDrag(e); });
  window.addEventListener('pointerup', () => {
    if (_drag) {
      _drag = null;
      commitCurrent();
    }
  });
}

function wireHandlers(p) {
  const sl = p.querySelector('.cp-sl');
  const hue = p.querySelector('.cp-hue');
  const hex = p.querySelector('.cp-hex');
  const eye = p.querySelector('.cp-eyedropper');

  const onDown = (type) => (e) => {
    _drag = type;
    handleDrag(e);
    e.preventDefault();
  };
  sl.addEventListener('pointerdown', onDown('sl'));
  hue.addEventListener('pointerdown', onDown('hue'));
  _installWindowPointer();

  hex.addEventListener('input', () => {
    let v = hex.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-f]{6}$/i.test(v)) {
      setFromHex(v);
      applyToInput(true);
    }
  });
  hex.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commitCurrent(); close(); }
    if (e.key === 'Escape') { close(); }
  });

  p.addEventListener('click', (e) => {
    const sw = e.target.closest('.cp-swatch');
    if (sw && sw.dataset.hex) {
      setFromHex(sw.dataset.hex);
      applyToInput(true);
      commitCurrent();
    }
  });

  if (window.EyeDropper) {
    eye.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      // 在系统取色器打开期间抑制外部点击关闭。
      // 没有这个，用户的像素拾取会触发窗口点击，
      // 击中我们的文档捕获监听器并关闭弹出框。
      const wasOnOutside = _onOutside;
      _detachOutsideHandlers();
      try {
        const r = await new window.EyeDropper().open();
        if (r && r.sRGBHex) {
          setFromHex(r.sRGBHex);
          applyToInput(true);
          commitCurrent();
        }
      } catch (_) { /* 用户取消 */ }
      // 延迟一帧重新安装外部点击处理程序，使取色器
      // 自身的拾取点击不会立即重新关闭我们。
      if (wasOnOutside && _popover) {
        requestAnimationFrame(() => {
          if (!_popover) return;
          _onOutside = wasOnOutside;
          _onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
          document.addEventListener('click', _onOutside, true);
          document.addEventListener('keydown', _onEsc, true);
        });
      }
    });
  } else {
    eye.disabled = true;
    eye.style.opacity = '0.3';
    eye.title = '此浏览器不支持取色器';
  }
}

function handleDrag(e) {
  if (_drag === 'sl') {
    const sl = _popover.querySelector('.cp-sl');
    const r = sl.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width, 0, 1);
    const y = clamp((e.clientY - r.top) / r.height, 0, 1);
    _s = x * 100;
    _v = (1 - y) * 100;
    applyToInput(true);
  } else if (_drag === 'hue') {
    const hue = _popover.querySelector('.cp-hue');
    const r = hue.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width, 0, 1);
    _h = x * 360;
    applyToInput(true);
  }
}

function commitCurrent() {
  if (!_input) return;
  addRecent(_input.value);
  syncUI();
}

// ── 打开 / 关闭 ──────────────────────────────────────────────────────
function position(p, anchor) {
  const rect = anchor.getBoundingClientRect();
  const pRect = p.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + pRect.width > window.innerWidth - 8) left = window.innerWidth - pRect.width - 8;
  if (top + pRect.height > window.innerHeight - 8) top = rect.top - pRect.height - 6;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  p.style.left = left + 'px';
  p.style.top = top + 'px';
}

let _onEsc = null;

function _detachOutsideHandlers() {
  if (_onOutside) {
    document.removeEventListener('click', _onOutside, true);
    document.removeEventListener('mousedown', _onOutside, true);
    document.removeEventListener('pointerdown', _onOutside, true);
    _onOutside = null;
  }
  if (_onEsc) {
    document.removeEventListener('keydown', _onEsc, true);
    _onEsc = null;
  }
}

function _destroyPopover() {
  _detachOutsideHandlers();
  if (_popover && _popover.parentNode) {
    _popover.parentNode.removeChild(_popover);
  }
  _popover = null;
  _input = null;
  _drag = null;
}

function open(inputEl) {
  // 始终拆除任何先前的弹出框，永不继承过时状态
  //（孤立监听器、隐藏但位置错乱的 div 等）。
  _destroyPopover();
  _popover = buildPopover();
  _input = inputEl;
  setFromHex(inputEl.value || '#000000');
  _popover.style.display = 'block';
  _popover.style.visibility = 'visible';
  _popover.style.opacity = '1';
  _popover.style.pointerEvents = 'auto';
  // 让弹出框以其自然尺寸渲染，然后定位
  requestAnimationFrame(() => {
    if (_popover && _input) position(_popover, _input);
  });
  syncUI();

  _onOutside = (e) => {
    if (_drag) return;                        // 拖动期间忽略
    if (!_popover) return;
    if (_popover.contains(e.target)) return;
    if (e.target === _input) return;
    // 如果点击落在模态框关闭按钮（X）上，吞掉它，使
    // 弹出框关闭不会同时关闭外层模态框。用户希望
    // 第一次点击仅关闭颜色选择器。
    const closeBtn = e.target.closest && e.target.closest('.close-btn, [aria-label*="lose" i]');
    if (closeBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    }
    close();
  };
  _onEsc = (e) => {
    if (e.key === 'Escape') {
      // 键盘同理：Escape 首先关闭选择器；
      // 模态框自身的 Esc 处理程序仅在下次按键时触发。
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      close();
    }
  };
  // 延迟安装使打开我们的点击不会立即关闭我们。
  // 使用 requestAnimationFrame 而非 setTimeout(0) 确保当前
  // 点击事件在注册监听器之前已完全冒泡。
  requestAnimationFrame(() => {
    document.addEventListener('click', _onOutside, true);
    // pointerdown 在触摸设备上先于 click 触发，即使
    // 触摸目标吞掉了 click 也能可靠触发。
    // 捕获它确保外部触摸在移动端关闭选择器。
    document.addEventListener('pointerdown', _onOutside, true);
    document.addEventListener('keydown', _onEsc, true);
  });
}

function close() {
  _destroyPopover();
}

// ── 附加到输入元素 ───────────────────────────────────────────────────
// 在用自定义 setter 包装 .value 后需要调用的标准 setter。
const _NATIVE_VALUE_DESC = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

function _syncSwatch(el) {
  const v = _NATIVE_VALUE_DESC.get.call(el);
  if (/^#[0-9a-f]{6}$/i.test(v || '')) el.style.background = v;
}

export function attachColorPicker(inputEl) {
  if (!inputEl || inputEl.dataset.cpAttached === '1') return;
  inputEl.dataset.cpAttached = '1';

  // 通过更改元素类型来中和原生颜色对话框。
  // 现有 `.value` 读取 + `input` 事件监听器继续工作。
  const initialAttr = inputEl.getAttribute('value');
  const initial = inputEl.value || initialAttr || '#000000';
  inputEl.setAttribute('data-cp-original-type', inputEl.type || 'color');
  inputEl.type = 'text';
  inputEl.readOnly = true;
  inputEl.classList.add('cp-swatch-input');

  // 包装 .value 使任何赋值（来自 theme.js applyColors 等）自动更新色块背景。
  Object.defineProperty(inputEl, 'value', {
    configurable: true,
    get() { return _NATIVE_VALUE_DESC.get.call(this); },
    set(v) {
      _NATIVE_VALUE_DESC.set.call(this, v);
      _syncSwatch(this);
    },
  });

  // 应用初始值，使色块在任何编程式设置之前显示颜色。
  inputEl.value = initial;

  // 使用 mousedown 使其在任何文档级点击处理程序
  //（例如我们自己的 _onOutside 监听器）决定关闭之前触发。
  inputEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 如果同一输入元素已经打开了选择器，则关闭（切换）。
    // 否则始终（重新）打开 — 永不陷入“无法重新打开”的状态。
    if (_input === inputEl && _popover) {
      close();
    } else {
      open(inputEl);
    }
  });
  // 抑制后续 click 使其不能冒泡到覆盖层/监听器。
  inputEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

export function initColorPickers(root = document) {
  root.querySelectorAll('input[type="color"]').forEach(attachColorPicker);
}

// 对可能在初始化之后挂载的新输入元素重新运行
export function refreshColorPickers(root = document) {
  initColorPickers(root);
}
