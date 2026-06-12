// ============================================
// 平台检测 + AltGr 按键辅助
// ============================================
// 由按键绑定代码共享：根 keyboard-shortcuts.js、编辑器的
// keyboard-shortcuts.js 和 settings.js。单一数据源，使三处
// 防护逻辑不会偏移。

// AltGr（AZERTY/QWERTZ 和大多数非美式布局上的右 Alt，用于输入
// @ # { } [ ] | \ 和 €）被浏览器报告为 Ctrl+Alt。macOS 是
// 例外：在那里 Option 键 —— Mac 快捷键的正常组成部分 —— 也设置了
// AltGraph 修饰键状态，因此绝不能将其视为 AltGr。
//
// IS_MAC 涵盖所有 Apple 平台，包括 iPad/iPhone：妙控键盘的
// Option 键与 Mac 一样设置 AltGraph，因此它们需要相同的特殊处理
// —— 仅限 macOS 会重新破坏它们。命名和
// /Mac|iPhone|iPad/ 测试有意镜像 calendar.js 和 sessions.js
// 中现有的 isMac 检查；这是它们共享的单一数据源。
export const IS_MAC =
  /Mac|iPhone|iPad/.test((typeof navigator !== 'undefined' && navigator.platform) || '') ||
  /Mac/.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');

// 当 `e` 是 AltGr 按键时返回 true，对于 Ctrl+Alt 快捷键
// 目的应忽略此事件。getModifierState('AltGraph') 对 AltGr 返回 true，
// 但对真正的左 Ctrl+Alt 返回 false，因此真正的快捷键仍然有效。
// 在 macOS 上始终返回 false，因为 Option 键合法地设置 AltGraph。
//
// 我们还要求 ctrlKey+altKey：我们要防御的冲突恰好是
// "AltGr 被报告为 Ctrl+Alt"，因此一个断言了 AltGraph 但
// 没有表现为 Ctrl+Alt 的事件（Linux ISO_Level3_Shift 布局、异常的修饰键
// 状态）将被保留而不是被吞掉。
//
// 权衡：在 Windows 上 AltGr 就是 Ctrl+右 Alt，因此通过 AltGr 输入的
// 刻意 Ctrl+Alt+<char> 快捷键也无法到达 —— 接受；使用
// 左 Ctrl+Alt。
//
// 注意：AltGr → AltGraph 的映射取自 UI Events 规范 / MDN，
// 未经我们的测试证明。旧版 Firefox 和一些 Linux 设置历来
// 不报告 AltGraph；当浏览器设置 ctrlKey+altKey 但没有 AltGraph 时，
// 此防护仅仅是无操作（修复前的行为），而不是回归。
export function isAltGrEvent(e, isMac = IS_MAC) {
  return (
    !isMac &&
    !!e.ctrlKey &&
    !!e.altKey &&
    !!(e.getModifierState && e.getModifierState('AltGraph'))
  );
}
