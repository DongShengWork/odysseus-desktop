// streamingSegmenter.js
//
// 纯逻辑模块，用于增量（"逐块"）流式 markdown 渲染。
//
// 当助手消息流式传入时，每个 token 都重新渲染整个累积的 markdown 既浪费
// （O(N^2)）又会重建 DOM 节点，导致代码块悬停按钮闪烁。解决方案是冻结
// 消息中不会再改变的前导部分，仅重新渲染增长的尾部。
//
// 本模块回答使冻结安全的一个核心问题：
//
//     给定目前收到的完整 markdown，有多少个前导字符可以被最终化，
//     而不会改变渲染输出？
//
// 调用者依赖的契约（`render` 是规范的 markdown 渲染器）：
//
//     const n = splitFinalized(text, render);
//     render(text.slice(0, n)) + render(text.slice(n))  ===  render(text)
//
// 本模块刻意不含 DOM 操作且与渲染器无关，因此可以隔离进行单元测试，
// 并复用于任何没有跨块长距离依赖（无引用式链接/脚注）的 markdown 渲染器。
//
// 已知限制（两者均有相同的缓解措施）：
//   - cutIsRenderSafe 仅证明当前时态的等价性。如果渲染器将内联分隔符跨空行配对
//     （例如 markdown.js 会将 `*a\n\nb*` 转换为跨两个段落的强调），那么在对
//     关闭分隔符到达之前冻结的块可能与最终的全量渲染不一致。
//   - afterClosedFence 边界不经等价性检查就直接信任，因此真实渲染器以不同方式
//     解析的围栏（例如奇怪的 4 反引号行）可能被错误检测为关闭。
//   这两种情况仅在渲染器本身处理奇怪的输入时发生，且都是暂时的：
//   chat.js 从源文本重新渲染已完成的消息，因此最终的稳定输出始终是规范的。

// 围栏代码分隔行：最多 3 个前导空格，然后是 >=3 个反引号或波浪号，
// 后面可选跟信息字符串。
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * 从 `fromOffset`（必须在顶层 — 调用者只会前进到已冻结的边界，绝不会进入围栏）
 * 扫描 `text`，收集候选切分点。
 *
 * @returns {{ boundaries: Array<{offset:number, afterClosedFence:boolean}>, inFence:boolean }}
 *   - 顶层的空行序列在下一个非空行的起始位置产生边界 (`afterClosedFence: false`)。
 *   - 围栏关闭在关闭围栏行之后产生边界 (`afterClosedFence: true`) —
 *     这样的切分无条件安全，因为没有任何内容可以合并到已完成的代码块中。
 */
function findBoundaries(text, fromOffset) {
  const boundaries = [];
  const n = text.length;
  let inFence = false;
  let fenceMarker = '';
  let i = fromOffset;

  while (i < n) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? n : nl;
    const afterNl = nl === -1 ? n : nl + 1;
    const line = text.slice(i, lineEnd);
    const fence = line.match(FENCE_RE);

    if (fence) {
      const marker = fence[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (
        marker[0] === fenceMarker[0] &&
        marker.length >= fenceMarker.length &&
        fence[2].trim() === '' // 关闭围栏不能携带信息字符串
      ) {
        inFence = false;
        fenceMarker = '';
        boundaries.push({ offset: afterNl, afterClosedFence: true });
      }
      i = afterNl;
    } else if (!inFence && line.trim() === '') {
      // 消费整个空行序列；边界在下一个非空行的起始位置，
      // 这样冻结侧拥有分隔符，尾部从干净的行开始。
      let j = afterNl;
      while (j < n) {
        const nl2 = text.indexOf('\n', j);
        const lineEnd2 = nl2 === -1 ? n : nl2;
        if (text.slice(j, lineEnd2).trim() !== '') break;
        if (nl2 === -1) {
          j = n;
          break;
        }
        j = nl2 + 1;
      }
      boundaries.push({ offset: j, afterClosedFence: false });
      i = j;
    } else {
      i = afterNl;
    }
  }

  return { boundaries, inFence };
}

/**
 * 在 `before` 和 `after` 之间切分是否保持渲染输出不变？
 * 这是自验证安全检查：直接比较分别渲染两侧与合并渲染的结果，因此跨越切分点的
 * 结构（松散列表、setext 标题、懒惰块引用延续、表格）都会被捕获，无需手写的
 * 语法规则。
 *
 * 渲染器的不确定性（例如 mermaid id 使用 Date.now() 作为种子）只会导致返回
 * 假阳性，绝不会出现假阴性 — 因此偏向于欠冻结，这是安全的方向。
 */
function cutIsRenderSafe(before, after, render) {
  return render(before) + render(after) === render(before + after);
}

/**
 * 返回 `text` 中可安全冻结的前导字符数，从 `committedLen`（已被冻结的数量）
 * 开始向前扫描。
 *
 * 保证 `render(text.slice(0, n)) + render(text.slice(n)) === render(text)`，
 * 且 `committedLen <= n <= text.length`。
 *
 * @param {string} text       目前为止累积的完整 markdown。
 * @param {(src:string)=>string} render  规范的 markdown 渲染器。
 * @param {number} [committedLen=0]  已冻结的字符数（始终是之前的边界值）。
 * @returns {number}
 */
export function splitFinalized(text, render, committedLen = 0) {
  const { boundaries } = findBoundaries(text, committedLen);

  let best = committedLen;
  let segStart = committedLen;

  for (let k = 0; k < boundaries.length; k++) {
    const { offset, afterClosedFence } = boundaries[k];

    if (afterClosedFence) {
      // 已完成的代码块 — 始终可以安全冻结到此位置。
      best = offset;
    } else {
      // 普通文本/列表/表格边界。我们需要一个后续块来对比
      // （最后一个块必须保持活动状态，因为它可能还会增长），并且切分必须局部渲染等价。
      const nextOffset = k + 1 < boundaries.length ? boundaries[k + 1].offset : text.length;
      const before = text.slice(segStart, offset);
      const after = text.slice(offset, nextOffset);
      if (after.trim() !== '' && cutIsRenderSafe(before, after, render)) {
        best = offset;
      }
    }
    segStart = offset;
  }

  return best;
}

/**
 * 如果 `text` 以一个从未关闭的围栏代码开启符开头，描述该围栏以便渲染器以追加模式
 * 流式传输代码，而不是重新渲染。返回 `{ lang, contentStart }`（contentStart =
 * 第一个代码字符的偏移），如果 `text` 不以仍未关闭的围栏开头则返回 null。
 *
 * 开启符行必须是完整的（以换行符结束），以便在追加模式开始前知道信息字符串/语言。
 */
export function describeOpenFence(text) {
  const open = text.match(/^( {0,3})(`{3,}|~{3,})([^\n]*)\n/);
  if (!open) return null;
  const marker = open[2];
  const contentStart = open[0].length;

  for (let i = contentStart; i < text.length; ) {
    const nl = text.indexOf('\n', i);
    const line = text.slice(i, nl === -1 ? text.length : nl);
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
      return null; // 围栏关闭 — 让正常的冻结路径处理
    }
    if (nl === -1) break;
    i = nl + 1;
  }

  const lang = (open[3] || '').trim().split(/\s+/)[0] || '';
  return { lang, contentStart };
}
