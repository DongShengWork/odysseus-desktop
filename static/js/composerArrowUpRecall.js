/**
 * 在空输入框中按上箭头键回显上一条用户消息（聊天应用惯例）。
 */

/**
 * 获取活跃聊天界面（#chat-history）中的最后一条用户消息，
 * 使用 dataset.raw（与 chat.js 中的重新发送/重新生成使用相同的源）。
 *
 * @param {Document | Element} [root=document]
 * @returns {string}
 */
export function getLastUserMessageFromChatHistory(root = document) {
  const chatBox =
    root && root.id === 'chat-history' && typeof root.querySelectorAll === 'function'
      ? root
      : (root.getElementById ? root.getElementById('chat-history') : null);
  if (!chatBox) return '';

  const users = chatBox.querySelectorAll('.msg-user');
  const last = users[users.length - 1];
  if (!last) return '';

  const bodyEl = last.querySelector('.body');
  return last.dataset?.raw || (bodyEl ? bodyEl.textContent : '') || '';
}

/**
 * @param {HTMLTextAreaElement} composer
 * @param {() => string} getLastUserMessage
 * @param {{ autoResize?: (el: HTMLTextAreaElement) => void }} [options]
 * @returns {boolean} true when wired (or already wired)
 */
export function wireArrowUpRecall(composer, getLastUserMessage, options = {}) {
  if (!composer) return false;
  if (composer._arrowUpRecallWired) return true;
  composer._arrowUpRecallWired = true;

  const { autoResize } = options;

  composer.addEventListener('keydown', (e) => {
    // 仅 ArrowUp，无修饰键，无 IME 输入法组合输入
    if (e.key !== 'ArrowUp') return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.isComposing) return;

    // 字面上的空内容 — 有意的空白字符不算空
    if (composer.value !== '') return;

    const recalled = getLastUserMessage();
    if (!recalled) return;

    e.preventDefault();
    composer.value = recalled;
    try {
      composer.selectionStart = composer.selectionEnd = recalled.length;
    } catch (_) {}
    if (autoResize) autoResize(composer);
  });

  return true;
}
