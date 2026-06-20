// static/js/escMenuStack.js
//
// 临时即席覆盖层的关闭注册表 —— 下拉菜单和
// 即时构建并附加到 <body> 的上下文弹出窗口，位于
// .modal 系统之外。ui.js 中的全局 Escape 仲裁器可以找到
// 模态框，但找不到这些，因此每个菜单在打开时在此注册关闭回调，
// 关闭时注销。
//
// 堆栈是 LIFO：dismissTopMenu() 首先关闭最近打开的菜单，
// 这样在模态框上打开的下拉菜单会在模态框之前关闭。
// 刻意不依赖 DOM，以便在普通 node 下进行单元测试（参见
// tests/test_esc_menu_stack_js.py）。

const _stack = [];

/**
 * 注册菜单的关闭回调。返回一个注销函数，菜单
 * 必须从其自身的清理逻辑中调用（外部点击关闭、项目点击等），
 * 以确保堆栈永远不会包含过期条目。多次调用返回的函数，
 * 或在菜单已通过 Escape 关闭后调用，都是安全的。
 */
export function registerMenuDismiss(dismissFn) {
  if (typeof dismissFn !== 'function') return () => {};
  const entry = { dismissFn };
  _stack.push(entry);
  return () => {
    const i = _stack.indexOf(entry);
    if (i !== -1) _stack.splice(i, 1);
  };
}

/**
 * 关闭最近注册的菜单（如果有）。当菜单被关闭时返回 true
 * （以便调用方可以吞下 Escape 键），当没有菜单打开时返回 false。
 * 条目在其回调运行之前弹出，因此即使
 * dismissFn 忘记注销或抛出异常，单次 Escape 恰好关闭
 * 一个菜单，堆栈永远不会卡住。
 */
export function dismissTopMenu() {
  const entry = _stack.pop();
  if (!entry) return false;
  try { entry.dismissFn(); } catch {}
  return true;
}

/** 测试/调试辅助：当前已注册菜单的数量。 */
export function _openMenuCount() {
  return _stack.length;
}

/**
 * 通过其注册的关闭回调拆除临时菜单（如果有的
 * 话），释放其 Escape 堆栈条目和任何监听器，否则回退到
 * 普通节点删除。在任何批量清除菜单的地方使用 —— 滚动 /
 * 滑动 / 模态框关闭清理，或"关闭前一个"重新打开扫描 ——
 * 而不是使用原始的 `el.remove()`，后者会导致堆栈条目孤立。
 */
export function dismissOrRemove(el) {
  if (!el) return;
  if (typeof el._dismiss === 'function') el._dismiss();
  else el.remove();
}

// ── DOM 便捷包装 ──────────────────────────────────────────────
// 上述注册表刻意不依赖 DOM（并以此方式进行单元测试）。
// bindMenuDismiss 是大多数调用方实际需要的一层薄 DOM 层：它将
// 无处不在的"覆盖层附加到 <body>，外部点击关闭"
// 惯用法同时连接到外部点击监听器和 Escape 堆栈，一次调用完成，
// 这样菜单只需要描述一次如何拆除自身。
//
//   const close = bindMenuDismiss(popup, () => popup.remove());
//   // 外部点击和 Escape 现在都调用 close()；你也可以在
//   // 项目处理器中手动调用。
//
// `onClose` 恰好运行一次（幂等），并拥有实际的拆除工作
// （移除/隐藏节点，清除锚点状态等）。`isOutside(ev)`
// 默认为"点击落在 `el` 之外的区域"；当额外的锚点
// 应被视为菜单内部时，可以覆盖它。返回的幂等 close() 也
// 存储在 `el._dismiss` 上，因此批量移除器（参见 dismissOrRemove）可以通过
// 其真实的拆除逻辑关闭菜单，而不是孤立其堆栈条目。
export function bindMenuDismiss(el, onClose, isOutside) {
  let done = false;
  let unreg = () => {};
  const onDocClick = (ev) => {
    const outside = typeof isOutside === 'function' ? isOutside(ev) : !el.contains(ev.target);
    if (outside) close();
  };
  function close() {
    if (done) return;
    done = true;
    unreg(); unreg = () => {};
    document.removeEventListener('click', onDocClick, true);
    try { if (typeof onClose === 'function') onClose(); } catch {}
  }
  // 延迟附加外部点击监听器，使打开菜单的点击不会
  // 立即关闭菜单。如果 close() 已在同一事件循环中运行
  // （例如即时的 Escape），则跳过附加，避免留下悬空的监听器。
  setTimeout(() => { if (!done) document.addEventListener('click', onDocClick, true); }, 0);
  unreg = registerMenuDismiss(close);
  el._dismiss = close;
  return close;
}
