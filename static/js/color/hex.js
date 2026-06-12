// static/js/color/hex.js
//
// 将 CSS 十六进制颜色解析为 {r, g, b}。纯函数 — 无 DOM — 可跨模块复用，
// 也可在 Node 环境下进行单元测试。

// 接受 "#rgb"、"#rrggbb"（可带或不带前置 '#'）。对于非法的
// 3 位或 6 位十六进制颜色，返回 null。
export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
