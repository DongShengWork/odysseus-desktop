/**
 * Shortcuts-cheatsheet popover — floating frosted-glass list of every
 * editor keyboard shortcut, anchored above the topbar keyboard icon
 * (drops below if there's no room above). Drag the header to move;
 * Esc or click outside dismisses; position is persisted in
 * localStorage so re-opening restores where the user left it.
 *
 * 公共 API：`toggleShortcuts(show?)` — true/false 强制状态，
 * undefined 切换。
 *
 * @returns {{ toggleShortcuts: (show?: boolean) => void }}
 */
import { shortcutsPopupHTML } from './build/popups.js';

export function createShortcutsPopover() {
  let pop = null;
  let outside = null;

  function ensurePopover() {
    if (pop) return pop;
    const el = document.createElement('div');
    el.id = 'ge-shortcuts-popover';
    el.style.cssText = [
      'position:fixed', 'z-index:10000', 'display:none',
      // Frosted-glass background: semi-transparent + heavy blur of
      // what's behind. Layered with an inner translucent veil so
      // light themes also read clearly without losing the see-through
      // feel.
      'background:color-mix(in srgb, var(--panel, #1a1a1a) 55%, transparent)',
      'backdrop-filter:blur(18px) saturate(150%)',
      '-webkit-backdrop-filter:blur(18px) saturate(150%)',
      'color:var(--fg,#eee)',
      'border:1px solid color-mix(in srgb, var(--fg, #eee) 18%, transparent)',
      'border-radius:12px',
      'box-shadow:0 14px 36px rgba(0,0,0,0.5), inset 0 1px 0 color-mix(in srgb, var(--fg, #fff) 8%, transparent)',
      'padding:12px 14px', 'min-width:540px', 'max-width:min(720px,92vw)',
      'font-size:12px', 'line-height:1.5',
    ].join(';');
    el.innerHTML = shortcutsPopupHTML();
    document.body.appendChild(el);
    el.querySelector('#ge-shortcuts-close').addEventListener('click', () => toggleShortcuts(false));

    // Drag by the header handle. Position survives across opens
    // 通过标题手柄拖拽。位置在多次打开之间保持（localStorage）。
    const handle = el.querySelector('#ge-shortcuts-handle');
    if (handle) {
      let drag = null;
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('#ge-shortcuts-close')) return;
        const r = el.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
        handle.setPointerCapture(e.pointerId);
        handle.style.cursor = 'grabbing';
        // 标记为用户定位，后续切换不会重新锚定。
        el.dataset.userPositioned = '1';
        e.preventDefault();
      });
      handle.addEventListener('pointermove', (e) => {
        if (!drag) return;
        let left = e.clientX - drag.dx;
        let top  = e.clientY - drag.dy;
        const m = 4;
        left = Math.max(m, Math.min(left, window.innerWidth  - drag.w - m));
        top  = Math.max(m, Math.min(top,  window.innerHeight - drag.h - m));
        el.style.left = left + 'px';
        el.style.top  = top + 'px';
      });
      const endDrag = () => {
        if (!drag) return;
        drag = null;
        handle.style.cursor = 'grab';
        try {
          localStorage.setItem('ge-shortcuts-pos', JSON.stringify({
            left: el.style.left, top: el.style.top,
          }));
        } catch {}
      };
      handle.addEventListener('pointerup', endDrag);
      handle.addEventListener('pointercancel', endDrag);
    }
    pop = el;
    return pop;
  }

  function positionPopover(el, anchor) {
    // 放置在锚点上方，水平居中但限制在视口内。
    // 上方空间不足时回退到下方。
    el.style.display = 'block';   // 需要布局计算以获取准确尺寸
    const ar = anchor.getBoundingClientRect();
    const pr = el.getBoundingClientRect();
    const margin = 8;
    let left = ar.left + (ar.width / 2) - (pr.width / 2);
    let top = ar.top - pr.height - margin;
    if (top < margin) top = ar.bottom + margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - pr.width - margin));
    top  = Math.max(margin, Math.min(top, window.innerHeight - pr.height - margin));
    el.style.left = left + 'px';
    el.style.top  = top + 'px';
  }

  function toggleShortcuts(show) {
    const el = ensurePopover();
    const open = show === undefined ? el.style.display === 'none' : show;
    if (open) {
      // Restore the user's last-dragged position if any; otherwise
      // anchor above the button.
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('ge-shortcuts-pos') || 'null'); } catch {}
      if (saved && saved.left && saved.top) {
        el.style.display = 'block';
        el.style.left = saved.left;
        el.style.top  = saved.top;
        // 重新限制位置，以防自用户拖拽后视口发生变化。
        requestAnimationFrame(() => {
          const r = el.getBoundingClientRect();
          const m = 4;
          if (r.right > window.innerWidth)  el.style.left = (window.innerWidth - r.width - m) + 'px';
          if (r.bottom > window.innerHeight) el.style.top = (window.innerHeight - r.height - m) + 'px';
          if (r.left < 0) el.style.left = m + 'px';
          if (r.top  < 0) el.style.top  = m + 'px';
        });
      } else {
        const anchor = document.getElementById('ge-shortcuts-btn');
        if (anchor) positionPopover(el, anchor);
        else el.style.display = 'block';
      }
      // 延迟外部点击，使打开我们的点击不会关闭我们。
      outside = (e) => {
        if (el.contains(e.target)) return;
        if (e.target.closest('#ge-shortcuts-btn')) return;
        toggleShortcuts(false);
      };
      setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    } else {
      el.style.display = 'none';
      if (outside) {
        document.removeEventListener('mousedown', outside, true);
        outside = null;
      }
    }
  }

  /** 当弹出框当前可见时返回 true。 */
  function isOpen() {
    return !!(pop && pop.style.display && pop.style.display !== 'none');
  }

  return { toggleShortcuts, isOpen };
}
