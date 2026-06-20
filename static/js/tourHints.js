// tourHints.js —— /tour 的秘密延续。用户首次打开
// 工具模态框后（在欢迎体验之后），显示一个"专业提示"
// 提示，指出模态框可以通过拖动标题栏吸附到屏幕边缘或
// 全屏。全局仅显示一次 —— 一旦用户
// 将其关闭（或自动隐藏），它永远不会再出现。

const HINT_SEEN_KEY = 'odysseus-hint-drag-to-snap-seen';

// Allow-list of modals where the snap/fullscreen hint makes sense.
// These are the full-window "tool" modals where users commonly want to
// reposition or fullscreen the pane (email, calendar, cookbook, gallery,
// library, brain memories, tasks, theme, compare). Transient modals
// like settings, prompts, rename dialogs, custom-preset picker, etc.
// are excluded — opening those is task-focused and the snap tip would
// be noise.
const SHOW_MODALS = new Set([
  'email-lib-modal',
  'calendar-modal',
  'compare-modal',     // 当前不是真实 id，防御性的
  'cookbook-modal',
  'gallery-modal',
  'doclib-modal',
  'library-modal',     // 聊天历史库（sessions.js）
  'memory-modal',      // 大脑 / 记忆
  'tasks-modal',
  'theme-modal',
]);

// 某些模态框具有动态的每个实例 ID（例如每封打开的邮件一个窗口）。
// 按前缀匹配，使同一系列的任意窗口都符合条件。
const SHOW_MODAL_PREFIXES = ['email-window-'];

function _modalShouldShowHint(id) {
  if (!id) return false;
  if (SHOW_MODALS.has(id)) return true;
  return SHOW_MODAL_PREFIXES.some(p => id.startsWith(p));
}

let _shown = false;
let _initialized = false;

function _hasSeen() { return localStorage.getItem(HINT_SEEN_KEY) === '1'; }
function _markSeen() { try { localStorage.setItem(HINT_SEEN_KEY, '1'); } catch {} }

function _isVisible(el) {
  if (!el || el.classList.contains('hidden')) return false;
  // 某些模态框设置内联 display:none 而非 .hidden
  if (el.style.display === 'none') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function _onModalOpened(modal) {
  if (_shown || _hasSeen()) return;
  const id = modal.id;
  if (!_modalShouldShowHint(id)) return;
  // 不要打断欢迎/导览本身
  if (document.body.classList.contains('tour-active')) return;
  if (document.getElementById('tour-tooltip')) return;
  // 移动端：跳过 —— 吸附功能不适用于移动端
  if (window.innerWidth <= 768) return;

  _shown = true;
  // 给模态框一点时间稳定（有些打开时有自己的动画）。
  setTimeout(() => _show(modal), 380);
}

function _show(modal) {
  if (_hasSeen()) return;
  const content = modal.querySelector('.modal-content') || modal;
  const r = content.getBoundingClientRect();

  const pop = document.createElement('div');
  pop.className = 'tour-hint';
  pop.innerHTML = `
    <div class="tour-hint-visual" aria-hidden="true">
      <svg viewBox="0 0 100 60" width="160" height="96">
        <!-- 环境框架 -->
        <rect x="0.5" y="0.5" width="99" height="59" rx="3" fill="none" stroke="currentColor" stroke-opacity="0.18" />
        <!-- 吸附区域预览（右半部分） -->
        <rect class="th-zone" x="51" y="2" width="47" height="56" rx="2" fill="currentColor" opacity="0" />
        <!-- 被拖动的模态框 -->
        <g class="th-modal-group">
          <rect x="22" y="20" width="34" height="22" rx="2.5" fill="var(--bg)" stroke="currentColor" stroke-width="1.2" />
          <rect x="22" y="20" width="34" height="5"  rx="2.5" fill="currentColor" opacity="0.35" />
        </g>
        <!-- 光标 -->
        <path class="th-cursor" d="M0 0 L0 9 L2.5 7 L4.5 10 L6 9 L4 6 L7 6 Z" fill="currentColor" />
      </svg>
    </div>
    <div class="tour-hint-text"><b>专业提示：</b> 将任意窗口的标题栏拖到屏幕边缘即可吸附。拖到顶部即可全屏。</div>
    <button class="tour-hint-dismiss" type="button">Got it</button>
  `;
  document.body.appendChild(pop);

  // 优先放置在模态框右侧；回退到左侧，然后是下方。
  pop.style.opacity = '0';
  requestAnimationFrame(() => {
    const pw = pop.offsetWidth || 260;
    const ph = pop.offsetHeight || 200;
    let left = r.right + 14;
    let top  = r.top;
    if (left + pw > window.innerWidth - 8) {
      left = r.left - pw - 14;
      if (left < 8) {
        left = Math.max(8, r.left + (r.width - pw) / 2);
        top  = r.bottom + 14;
        if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 14);
      }
    }
    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
    pop.style.opacity = '';
    pop.classList.add('tour-hint-in');
  });

  const dismiss = () => {
    pop.classList.add('tour-hint-out');
    setTimeout(() => pop.remove(), 280);
    _markSeen();
  };
  pop.querySelector('.tour-hint-dismiss').addEventListener('click', dismiss);
  // 14 秒后自动关闭，不会永远停留。
  setTimeout(() => { if (pop.isConnected) dismiss(); }, 14000);
}

function _watchModals() {
  const observeModal = (modal) => {
    if (!modal || modal.dataset.tourHintObserved === '1') return;
    modal.dataset.tourHintObserved = '1';
    observer.observe(modal, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['class', 'style'],
    });
    if (_isVisible(modal)) _onModalOpened(modal);
  };
  const observer = new MutationObserver((muts) => {
    if (_hasSeen() || _shown) return;
    for (const m of muts) {
      if (m.attributeName !== 'class' && m.attributeName !== 'style') continue;
      const el = m.target;
      if (!(el instanceof HTMLElement)) continue;
      if (!el.classList.contains('modal')) continue;
      const wasHidden = !m.oldValue || /\bhidden\b/.test(m.oldValue) || /display:\s*none/.test(m.oldValue);
      if (wasHidden && _isVisible(el)) _onModalOpened(el);
    }
  });
  document.querySelectorAll('.modal').forEach(observeModal);
  const addObserver = new MutationObserver((muts) => {
    if (_hasSeen() || _shown) return;
    for (const m of muts) {
      m.addedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        if (node.classList.contains('modal')) observeModal(node);
        node.querySelectorAll?.('.modal').forEach(observeModal);
      });
    }
  });
  addObserver.observe(document.body, { childList: true, subtree: true });
}

export function init() {
  if (_initialized) return;
  _initialized = true;
  if (_hasSeen()) return; // 无需操作
  // 延迟一个周期，让应用的其他部分有机会挂载其模态框。
  setTimeout(_watchModals, 50);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

export default { init };
