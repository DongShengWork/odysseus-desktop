// 流式传输Renderer.js
//
// The DOM shell for incremental 流式传输 markdown rendering. One instance owns
// the DOM of one 流式传输 助手消息 and is the only thing that writes to
// it while it streams.
//
// It keeps the message as two regions, separated by an invisible comment marker so
// the rendered blocks are direct children of the 容器 (no wrapper elements to
// disturb CSS):
//
//     [ 已冻结块 ][ 已冻结块 ] <!--tail--> [ 实时尾部 ]
//
//   - 已冻结块仅渲染一次，之后不再修改 — 这样代码块的悬停按钮不会闪烁，
//     代码也只高亮一次。
//   - 实时尾部（仍在增长的尾部块）每个 token 重新渲染一次，除了未关闭的
//     代码围栏，它以追加模式流式传输（文本追加到稳定的 <pre> 中，围栏关闭
//     时高亮一次）。
//
// 所有"是否可以安全冻结？"的逻辑都放在纯函数的 segmenter 中；本文件刻意
// 保持机械化。如果任何操作抛出异常，将回退到全量重新渲染，确保 bug 不会
// 产生错误输出 — 只会产生当前行为。

import { splitFinalized, describeOpenFence } from './streamingSegmenter.js';

// 编译时逃生舱：设为 false 以强制使用普通的全量重新渲染路径。
// （下面的实例级 try/catch `degraded` 回退是运行时安全网。）
const ENABLED = true;

export function createStreamRenderer(contentEl, { render, hljs } = {}) {
  let started = false;
  let tailMarker = null; // 已冻结节点在其之前；实时尾部节点在其之后
  let committedLen = 0; // 已冻结的源字符数
  let lastText = ''; // 最近的完整文本（用于 finalize）
  let tailShownLen = 0; // 实时尾部已渲染的文本长度（驱动 token 淡入效果）
  let appendMode = null; // { codeText: Text, appendedLen }，当未关闭的围栏在流式传输时
  let degraded = !ENABLED; // 一旦回退到全量重新渲染后为 true

  function start() {
    contentEl.textContent = '';
    tailMarker = document.createComment('tail');
    contentEl.appendChild(tailMarker);
    started = true;
  }

  function highlight(root) {
    if (hljs) root.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
  }

  function clearTail() {
    while (tailMarker.nextSibling) tailMarker.nextSibling.remove();
  }

  // 渲染 `src` 并冻结 tail marker 之前的节点。高亮在这里执行，
  // 在分离的 fragment 上仅执行一次，在节点显示之前。
  function freeze(src) {
    const holder = document.createElement('div');
    holder.innerHTML = render(src);
    highlight(holder);
    while (holder.firstChild) contentEl.insertBefore(holder.firstChild, tailMarker);
  }

  // 重新渲染实时尾部。未关闭的尾部围栏以追加模式流式传输。
  function renderTail(tailText) {
    const fence = tailText ? describeOpenFence(tailText) : null;
    if (fence) {
      appendOpenFence(tailText, fence);
      return;
    }
    appendMode = null;
    clearTail();
    if (!tailText) {
      tailShownLen = 0;
      return;
    }
    const holder = document.createElement('div');
    holder.innerHTML = render(tailText);
    fadeNewText(holder, tailShownLen);
    tailShownLen = holder.textContent.length;
    while (holder.firstChild) contentEl.appendChild(holder.firstChild);
  }

  // 以追加模式流式传输未终止代码围栏的正文，仅将新字符追加到
  // 稳定的 <pre><code> 文本节点中 — 无需重新解析，无需重新高亮。
  function appendOpenFence(tailText, fence) {
    if (!appendMode) {
      clearTail();
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence.lang) code.className = `language-${fence.lang}`;
      const textNode = document.createTextNode('');
      code.appendChild(textNode);
      pre.appendChild(code);
      contentEl.appendChild(pre);
      appendMode = { codeText: textNode, appendedLen: 0 };
      tailShownLen = 0; // 代码从不淡入；围栏后的普通文本正常淡入
    }
    const code = tailText.slice(fence.contentStart);
    if (code.length > appendMode.appendedLen) {
      appendMode.codeText.appendData(code.slice(appendMode.appendedLen));
      appendMode.appendedLen = code.length;
    }
  }

  // 将超出 `prevLen` 字符的尾部文本用 <span class="token-new"> 包裹，
  // 实现流式淡入效果。跳过代码块（<pre>）和思考块（.thinking-content）。
  // 注意：原始 chat.js 辅助函数检查的是 `.think-content`，这是一个应用中
  // 不存在的类，因此思考文本曾会淡入；匹配实际的 `.thinking-content` 修正了
  // 这个问题。在插入前的分离 fragment 上操作。
  function fadeNewText(container, prevLen) {
    if (!prevLen) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let count = 0;
    const toWrap = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const len = node.textContent.length;
      if (count + len <= prevLen) {
        count += len;
        continue;
      }
      toWrap.push({ node, splitAt: count < prevLen ? prevLen - count : 0 });
      count += len;
    }
    for (const { node, splitAt } of toWrap) {
      const parent = node.parentNode;
      if (!parent || parent.closest('pre, .thinking-content')) continue;
      const target = splitAt > 0 ? node.splitText(splitAt) : node;
      const span = document.createElement('span');
      span.className = 'token-new';
      parent.replaceChild(span, target);
      span.appendChild(target);
    }
  }

  function fullRender(fullText) {
    contentEl.innerHTML = render(fullText);
    highlight(contentEl);
  }

  // 渲染最新的完整源文本。
  //
  // PRECONDITION: callers must pass append-only text — each call's `fullText` must
  // extend the previous one with the already-seen prefix UNCHANGED. Finalized
  // blocks are frozen and never re-rendered, so a feed that rewrites earlier text
  // would leave stale frozen blocks (corrected only by the next full re-render).
  // chat.js satisfies this: its stripToolBlocks output only strips not-yet-finalized
  // trailing tool syntax, never text that has already been frozen.
  function update(fullText) {
    lastText = fullText;
    if (degraded) {
      fullRender(fullText);
      return;
    }
    try {
      // Self-heal: if our DOM was replaced out from under us — chat.js writes
      // contentEl.innerHTML directly for thinking indicators and tool blocks, and
      // finalize() removes the marker — our tail marker is no longer a child of the
      // 容器. Rebuild from scratch so we never append onto foreign content or
      // touch a detached marker.
      if (started && (!tailMarker || tailMarker.parentNode !== contentEl)) {
        started = false;
        committedLen = 0;
        tailShownLen = 0;
        appendMode = null;
      }
      if (!started) start();
      const next = splitFinalized(fullText, render, committedLen);
      if (next > committedLen) {
        freeze(fullText.slice(committedLen, next));
        committedLen = next;
        appendMode = null; // 正在流式传输的内容现在已被冻结
        tailShownLen = 0;
      }
      renderTail(fullText.slice(committedLen));
    } catch (err) {
      degraded = true;
      console.error('streamingRenderer: falling back to full render', err);
      fullRender(fullText);
    }
  }

  // Stream finished: freeze whatever is left canonically and flatten away the
  // marker so the 容器 holds exactly what a single full render would produce.
  // chat.js currently re-renders the finished message from source for its own
  // reasons and so doesn't call this, but it completes the renderer's lifecycle and
  // is exercised by the tests.
  function finalize() {
    if (degraded) return;
    try {
      if (!started) start();
      clearTail();
      appendMode = null;
      const rest = lastText.slice(committedLen);
      if (rest.trim()) freeze(rest);
      tailMarker.remove();
      tailMarker = null;
      committedLen = lastText.length;
    } catch (err) {
      degraded = true;
      console.error('streamingRenderer: falling back to full render', err);
      fullRender(lastText);
    }
  }

  return { update, finalize };
}
