/**
 * 魔棒工具 — 在活动图层上单击即可进行泛洪填充选区。
 * Shift/Alt 修饰键会在本次点击期间覆盖持久化的模式
 * 开关（添加 / 减去）。
 *
 * 在已有选区内无修饰键点击则不选中。
 *
 * 魔棒仅做选区 — 直到用户从面板调用操作（擦除 / 复制等）
 * 才会改变图层。这就是为什么它只有 `click` 处理器
 * 而没有 begin/drag/end。
 *
 * @param {{
 *   activeLayer: () => object | null,
 *   saveState:   () => void,
 *   composite:   () => void,
 *   wandHits:    (cx: number, cy: number) => boolean,
 *   runMagicWand: (cx: number, cy: number, mode: 'replace'|'add'|'subtract') => void,
 * }} deps
 */
import { state } from '../state.js';
import { canvasCoords } from '../canvas-coords.js';

export function createWandTool({ activeLayer, saveState, composite, wandHits, runMagicWand }) {
  return {
    click(e) {
      const layer = activeLayer();
      if (!layer) return;
      const coords = canvasCoords(e, state.mainCanvas);
      // 持久化开关设置默认模式；Shift 强制添加，Alt
      // 强制减去，无论开关状态如何（修饰键始终优先）。
      let mode = state.wandMode || 'replace';
      if (e.shiftKey) mode = 'add';
      else if (e.altKey) mode = 'subtract';
      // 在已有选区内点击且无修饰键 → 取消选中。
      if (mode === 'replace' && wandHits(coords.x, coords.y)) {
        saveState();
        state.wandMask = null;
        state.wandLayerId = null;
        state.wandLastSeed = null;
        composite();
        return;
      }
      runMagicWand(coords.x, coords.y, mode);
    },
  };
}
