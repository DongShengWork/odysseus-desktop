// static/js/emailLibrary/replyRecipients.js
//
// 构建回复所有收件人列表的纯函数辅助工具。无 DOM、无 fetch、
// 无共享状态 — 可以安全地导入任何地方，也可在 node 下进行单元测试。

// 从 "Name <email@x>" 或纯文本 "email@x" 中提取纯邮件地址。
export function extractEmail(addr) {
  const m = (addr || '').match(/<([^>]+)>/);
  return (m ? m[1] : (addr || '')).trim().toLowerCase();
}

// 回复全部 CC = 原始 To + Cc 中的所有人，排除自己，
// 保留原始 "Name <email>" 格式。
//
// `mine` 是单个地址或用户自己的地址列表（多账户用户有多个地址）。
// 空/未知 ⇒ 不排除任何人。
// 通过精确提取的邮件地址进行比对（而非子串 `includes`），这修复了
// issue #360：空的自身地址导致 `"...".includes("")` 对所有收件人都为真，
// 导致回复全部时丢掉了整个 Cc 列表。
export function buildReplyAllCc(data, mine) {
  const list = Array.isArray(mine) ? mine : [mine];
  const me = new Set(list.map((a) => (a || '').toLowerCase()).filter(Boolean));
  const split = (s) => (typeof s === 'string' ? s : '').split(',').map((x) => x.trim()).filter(Boolean);
  return [...split(data && data.to), ...split(data && data.cc)]
    .filter((addr) => !me.has(extractEmail(addr)))
    .join(', ');
}
