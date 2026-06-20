// static/js/markdown/tableRow.js
//
// 纯工具函数，用于将 Markdown 表格行拆分为单元格。不涉及 DOM —
// 可在任何地方安全导入，也可在 Node 下进行单元测试。

// 将 "| a | b | c |" 行拆分为去除首尾空格的单元格字符串。
//
// Strip only the optional leading/trailing pipe, then split — filtering out
// every empty cell (the old behaviour) dropped intentionally-empty interior
// cells too, so "| a |  | c |" collapsed to 2 columns and misaligned with the
// header.
export function splitTableRow(row) {
  const text = typeof row === 'string' ? row : '';
  return text
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}
