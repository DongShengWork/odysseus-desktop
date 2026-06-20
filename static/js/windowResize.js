// 共享窗口调整大小辅助函数。makeWindowDraggable 的配套工具：为每个
// 可拖动的工具窗口（资料库、笔记、任务、日历、画廊、邮件、
// 食谱、记忆、设置、主题、对比、研究、会话）提供边缘和
// 角落调整大小功能，就像原生桌面窗口调整大小一样 — 抓住
// 四条边或四个角中的任意一个并拖动。
//
// Why edge-proximity detection instead of injected handle elements:
//   The windows differ structurally. `.modal-content` scrolls its own body
//   (overflow:auto)，而 `.notes-pane` 保持 overflow:hidden 并滚动
//   inner element. Absolutely-positioned handle children would scroll away
//   with the content in the first case. Detecting pointer proximity to the
//   window's border works uniformly regardless of the overflow model and
//   matches the user's mental model ("drag the edges or corners").
//
// API：
//   makeWindowResizable(content, {
//     modal,        // 可选的包装 .modal（用于基于 id 的尺寸持久化）
//     mobileSkip,   // 在此视口宽度及以下禁用调整大小功能（sheet 模式）
//     isLocked,     // () => bool — 全屏/停靠时跳过
//     minWidth, minHeight,
//     storageKey,   // 持久化 {w,h} 的 localStorage 键；null 禁用
//     onResizeEnd,  // ({rect}) => void
//   })

const EDGE = 7;          // 触发调整大小抓取器的边框接近距离（像素）
const MIN_W = 320;       // 窗口可拖动到的最小宽度
const MIN_H = 200;
// 即使位于窗口边框 EDGE 像素内也必须保留其自身点击/拖动行为的控件
//（关闭按钮、滑块、输入框、链接）。
const INTERACTIVE = 'button, input, select, textarea, a, [contenteditable=""], [contenteditable="true"]';

export function makeWindowResizable(content, options = {}) {
  if (!content) return;
  const modal = options.modal || null;
  const mobileSkip = (typeof options.mobileSkip === 'number') ? options.mobileSkip : 768;
  const minW = options.minWidth || MIN_W;
  const minH = options.minHeight || MIN_H;
  const isLocked = options.isLocked || (() => false);
  const onResizeEnd = options.onResizeEnd || null;
  const storageKey = options.storageKey || null;

  const _skip = () => (mobileSkip > 0 && window.innerWidth <= mobileSkip) || isLocked();

  // (cx,cy) 在哪些边框的 EDGE 像素范围内？仅当指针
  // 在垂直轴上也在窗口范围内时才计入，使角落
  // 解析为真正的对角抓取器而不是整条边。
  function edgesAt(cx, cy) {
    const r = content.getBoundingClientRect();
    const within = (cy >= r.top - EDGE && cy <= r.bottom + EDGE && cx >= r.left - EDGE && cx <= r.right + EDGE);
    if (!within) return { l: false, r: false, t: false, b: false, rect: r };
    const onY = cy >= r.top - EDGE && cy <= r.bottom + EDGE;
    const onX = cx >= r.left - EDGE && cx <= r.right + EDGE;
    return {
      l: Math.abs(cx - r.left) <= EDGE && onY,
      r: Math.abs(cx - r.right) <= EDGE && onY,
      t: Math.abs(cy - r.top) <= EDGE && onX,
      b: Math.abs(cy - r.bottom) <= EDGE && onX,
      rect: r,
    };
  }

  function cursorFor(e) {
    if ((e.l && e.t) || (e.r && e.b)) return 'nwse-resize';
    if ((e.r && e.t) || (e.l && e.b)) return 'nesw-resize';
    if (e.l || e.r) return 'ew-resize';
    if (e.t || e.b) return 'ns-resize';
    return '';
  }

  let hoverCursor = false;
  function clearHoverCursor() {
    if (hoverCursor) { content.style.cursor = ''; hoverCursor = false; }
  }
  function onHover(ev) {
    if (resizing) return;
    if (_skip()) { clearHoverCursor(); return; }
    if (ev.target && ev.target.closest && ev.target.closest(INTERACTIVE)) { clearHoverCursor(); return; }
    const c = cursorFor(edgesAt(ev.clientX, ev.clientY));
    if (c) { content.style.cursor = c; hoverCursor = true; }
    else clearHoverCursor();
  }

  let resizing = false;
  let active = null;
  let startRect = null, startX = 0, startY = 0;

  function begin(cx, cy, edges) {
    resizing = true;
    active = edges;
    // Kill the modal/pane open-animation (a scale transform that runs for the
    // first ~200-250ms) BEFORE measuring. Done as a permanent inline style
    // rather than a toggled class on purpose: a class that flips animation
    // off→on would re-trigger the scale-in on mouseup, mis-measuring the final
    // size and visibly popping the window. The open animation is a one-shot,
    // so killing it for this instance is harmless (it replays on next open).
    content.style.animation = 'none';
    content.classList.add('window-resizing');
    const r = content.getBoundingClientRect();
    startRect = { left: r.left, top: r.top, width: r.width, height: r.height };
    startX = cx; startY = cy;
    // 固定为显式盒模型定位，与拖动辅助函数相同，
    // 使居中变换/边距停止与新尺寸争斗。移除
    // max-width/height 限制（如 85vh），使窗口可以实际增长。
    content.style.position = 'fixed';
    content.style.margin = '0';
    content.style.transform = 'none';
    content.style.left = r.left + 'px';
    content.style.top = r.top + 'px';
    content.style.width = r.width + 'px';
    content.style.height = r.height + 'px';
    content.style.maxWidth = 'none';
    content.style.maxHeight = 'none';
    document.body.classList.add('window-resizing-active');
    document.body.style.cursor = cursorFor(edges);
  }

  function move(cx, cy) {
    if (!resizing) return;
    const dx = cx - startX, dy = cy - startY;
    let { left, top, width, height } = startRect;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (active.r) width = startRect.width + dx;
    if (active.b) height = startRect.height + dy;
    if (active.l) { width = startRect.width - dx; left = startRect.left + dx; }
    if (active.t) { height = startRect.height - dy; top = startRect.top + dy; }
    // Min-size clamps — keep the opposite edge anchored when pulling from
    // the left/top so the window doesn't jump.
    if (width < minW) { if (active.l) left = startRect.left + (startRect.width - minW); width = minW; }
    if (height < minH) { if (active.t) top = startRect.top + (startRect.height - minH); height = minH; }
    // 保持窗口在屏幕内且不超过视口大小。
    if (active.l && left < 0) { width += left; left = 0; }
    if (active.t && top < 0) { height += top; top = 0; }
    if (left + width > vw) width = Math.max(minW, vw - left);
    if (top + height > vh) height = Math.max(minH, vh - top);
    content.style.left = left + 'px';
    content.style.top = top + 'px';
    content.style.width = width + 'px';
    content.style.height = height + 'px';
  }

  function end() {
    if (!resizing) return;
    resizing = false;
    content.classList.remove('window-resizing');
    document.body.classList.remove('window-resizing-active');
    document.body.style.cursor = '';
    clearHoverCursor();
    const r = content.getBoundingClientRect();
    if (storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) })); } catch (_) {}
    }
    if (onResizeEnd) { try { onResizeEnd({ rect: r }); } catch (_) {} }
  }

  function armFrom(target, cx, cy) {
    if (_skip()) return false;
    if (target && target.closest && target.closest(INTERACTIVE)) return false;
    const edges = edgesAt(cx, cy);
    if (!(edges.l || edges.r || edges.t || edges.b)) return false;
    begin(cx, cy, edges);
    return true;
  }

  // 捕获阶段：当抓取落在边框上时，抢占标题栏的拖动监听器
  //（位于后代元素上，在冒泡阶段触发）。
  content.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    if (!armFrom(ev.target, ev.clientX, ev.clientY)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const mu = () => {
      end();
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', mu);
    };
    // 自愈漏掉的 mouseup（在窗口外释放、事件丢失、
    // 窗口失焦）：无按键按下的移动意味着拖动结束 —
    // 完成而不是在每次后续 mousemove 上失控运行。
    const mm = (e) => {
      if (e.buttons === 0) { mu(); return; }
      move(e.clientX, e.clientY);
    };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  }, true);

  content.addEventListener('mousemove', onHover);
  content.addEventListener('mouseleave', clearHoverCursor);

  content.addEventListener('touchstart', (ev) => {
    const t = ev.touches[0];
    if (!t) return;
    if (!armFrom(ev.target, t.clientX, t.clientY)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const tm = (e) => { const tt = e.touches[0]; if (tt) move(tt.clientX, tt.clientY); };
    const te = () => {
      end();
      document.removeEventListener('touchmove', tm);
      document.removeEventListener('touchend', te);
      document.removeEventListener('touchcancel', te);
    };
    document.addEventListener('touchmove', tm, { passive: false });
    document.addEventListener('touchend', te);
    document.addEventListener('touchcancel', te);
  }, true);

  // 在（重新）打开时恢复之前选择的尺寸。在窗口仍由其覆盖层居中时
  // 应用內联 width/height 可保持新尺寸仍居中；
  // 一旦拖动/调整大小，则如常固定为 absolute。
  //
  // Deferred one frame on purpose: some windows (e.g. Notes) snap to an edge
  // dock or fullscreen synchronously right AFTER this helper is wired. Waiting a
  // frame lets that settle so we can re-check _skip() and NOT stretch a
  // docked/fullscreen window to a stale windowed size. The open animation masks
  // the one-frame delay, so there is no visible jump.
  if (storageKey) {
    requestAnimationFrame(() => {
      if (_skip() || !content.isConnected) return;
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (saved && saved.w && saved.h) {
          const w = Math.max(minW, Math.min(saved.w, window.innerWidth));
          const h = Math.max(minH, Math.min(saved.h, window.innerHeight));
          content.style.width = w + 'px';
          content.style.height = h + 'px';
          content.style.maxWidth = 'none';
          content.style.maxHeight = 'none';
        }
      } catch (_) {}
    });
  }
}
