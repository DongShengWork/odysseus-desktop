// tourAutoplay.js —— 在用户首次打开工具模态框时自动触发匹配的
// `/tour-<x>` 斜杠命令。每个模态框仅触发一次：无论是否关闭，
// 标记已设置，重新打开时不再自动触发。
//
// 与现有的 tourHints.js 配对（后者显示一个全局的"拖动标题栏
// 以吸附"提示）。导览是更丰富的逐功能引导。
//
// 移动端被排除 —— 导览通过矩形数学定位光晕，不适合
// 底部面板布局。

import { handleSlashCommand } from './slashCommands.js';

// 模态框 id → 要触发的斜杠命令（不含前导 "/"）。当新功能
// 添加 `tour-*` 命令时，向此映射追加。
const TOUR_FOR_MODAL = {
  'doclib-modal':           'tour-library',
  'cookbook-modal':         'tour-cookbook',
  'research-overlay':       'tour-research',
  'compare-model-overlay':  'tour-compare',
  'theme-modal':            'tour-theme',
  'settings-modal':         'tour-settings',
  'gallery-modal':          'tour-gallery',
};

const SEEN_KEY = (tour) => `odysseus-tour-autoplay-seen-${tour}`;

let _initialized = false;
// 如果导览已激活或另一个模态框在导览中打开，则禁止重新触发。
// 斜杠命令本身在其光晕持续期间添加 `body.tour-active`。
function _tourActive() {
  return document.body.classList.contains('tour-active');
}

function _isVisible(el) {
  if (!el || el.classList.contains('hidden')) return false;
  if (el.style.display === 'none') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

async function _maybeFire(modal) {
  const id = modal.id;
  const tour = TOUR_FOR_MODAL[id];
  if (!tour) return;
  if (_tourActive()) {
    try { window.cancelActiveTour?.('modal-opened'); } catch (_) {}
    return;
  }
  let seen = false;
  try { seen = localStorage.getItem(SEEN_KEY(tour)) === '1'; } catch (_) {}
  if (seen) return;
  // 立即标记，防止快速双重触发（例如模态框类观察器
  // 在动画期间触发两次）排队两个导览。
  try { localStorage.setItem(SEEN_KEY(tour), '1'); } catch (_) {}
  // 让模态框自身的入场动画稳定后再让光晕尝试定位
  // 标题栏/第一张卡片/等。约 400ms 匹配 tourHints。
  setTimeout(() => {
    if (_tourActive()) return;
    try {
      handleSlashCommand('/' + tour);
    } catch (e) {
      // 如果触发失败，我们不取消标记 —— 每次模态框打开都重试
      // 比错过一次导览更烦人。用户可以手动从聊天输入框运行 `/tour-x`。
      // eslint-disable-next-line no-console
      console.warn(`Tour autoplay failed for ${id}:`, e);
    }
  }, 400);
}

function _watchModals() {
  if (typeof MutationObserver === 'undefined') return;
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.attributeName !== 'class' && m.attributeName !== 'style') continue;
      const el = m.target;
      if (!(el instanceof HTMLElement)) continue;
      if (!(el.id in TOUR_FOR_MODAL)) continue;
      const wasHidden = !m.oldValue
        || /\bhidden\b/.test(m.oldValue)
        || /display:\s*none/.test(m.oldValue);
      if (wasHidden && _isVisible(el)) _maybeFire(el);
    }
  });
  // 如果在启动时存在，观察每个已知目标…
  Object.keys(TOUR_FOR_MODAL).forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      observer.observe(el, {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['class', 'style'],
      });
    }
  });
  // …也观察之后添加的任何匹配模态框（例如 research overlay 是
  // 按需附加的）。
  const docObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        if (node.id in TOUR_FOR_MODAL) {
          observer.observe(node, {
            attributes: true,
            attributeOldValue: true,
            attributeFilter: ['class', 'style'],
          });
          if (_isVisible(node)) _maybeFire(node);
        }
      });
    }
  });
  docObserver.observe(document.body, { childList: true, subtree: false });
}

export function init() {
  if (_initialized) return;
  _initialized = true;
  // 为 v1 稳定性禁用：打开普通应用窗口绝不能
  // 自动生成导览覆盖层或干扰关闭/背景行为。
  // 手动斜杠导览仍通过 slashCommands.js 工作。
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

export default { init };
