// streamingRenderer.js
//
// 用于增量流式 markdown 渲染的 DOM 外壳。一个实例拥有一条流式助手消息
// 的 DOM，并且在流式传输期间是唯一写入该 DOM 的对象。
//
// 它将消息分为两个区域，通过一个不可见的注释标记分隔，这样渲染块就是
// 容器的直接子元素（没有包装元素干扰 CSS）：
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
  // 前提条件：调用者必须传入仅追加的文本 — 每次调用的 `fullText` 必须在前一次
  // 的基础上扩展，且已见过的前缀部分保持不变。已冻结的块被冻结且不再重新渲染，
  // 因此重写早期文本的输入会导致冻结块过时（仅在下次全量重新渲染时修复）。
  // chat.js 满足此条件：它的 stripToolBlocks 输出仅去除尚未最终化的尾部工具
  // 语法，而不会修改已冻结的文本。
  function update(fullText) {
    lastText = fullText;
    if (degraded) {
      fullRender(fullText);
      return;
    }
    try {
      // 自愈：如果我们的 DOM 被外部替换了 — chat.js 为思考指示器和工具块
      // 直接写入 contentEl.innerHTML，finalize() 移除标记 — 那么我们的 tail
      // marker 不再是容器的子元素。从头重建，确保不会追加到外部内容或操作
      // 已分离的标记。
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

  // 流结束：规范地冻结剩余内容，并移除标记使容器内容与单次全量渲染的输出
  // 完全一致。chat.js 当前出于自身原因从源文本重新渲染已完成的消息，因此
  // 不调用此函数，但它完善了渲染器的生命周期，并在测试中进行了验证。
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
