// static/js/model/matchKey.js
//
// 纯辅助函数，用于将模型名称与一组已知键进行匹配。无 DOM —
// 可在任意处安全导入，也可在 Node 环境下进行单元测试。

// 返回 `name` 中最具体（最长）的子串键，若无匹配则返回 null。
// 如果返回第一个匹配项，会使 "gpt-4o-mini" 匹配到较短的
// "gpt-4o" 键 — 导致按 gpt-4o 费率计费（约 16 倍）且显示错误的
// 上下文窗口。
export function matchModelKey(name, keys) {
  const n = (name || '').toLowerCase();
  let best = null;
  for (const key of keys) {
    if (n.includes(key) && (best === null || key.length > best.length)) {
      best = key;
    }
  }
  return best;
}
