// static/js/markdown/tableRow.js
//
// 纯工具函数，用于将 Markdown 表格行拆分为单元格。不涉及 DOM —
// 可在任何地方安全导入，也可在 Node 下进行单元测试。

// 将 "| a | b | c |" 行拆分为去除首尾空格的单元格字符串。
//
// 仅去除可选的首尾管道符，然后按 | 分割 — 过去过滤掉所有空单元格（旧行为）会导致有意保留的内部空
// 单元格也被丢弃，例如 "| a |  | c |" 会被压缩为 2 列，与表头不对齐。
export function splitTableRow(row) {
  const text = typeof row === 'string' ? row : '';
  return text
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}
