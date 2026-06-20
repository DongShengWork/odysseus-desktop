/**
 * 画笔 / 橡皮擦 / 修复画笔的共享笔触管线。
 *
 * 逐次采样绘制在 `_strokeTo` 中进行（仍在 galleryEditor.js 中，
 * 因为它涉及大量像素传递的内部逻辑）。本模块负责围绕它的
 * begin / continue / end 编排：
 *
 *  - begin: capture the inpaint-erase flag for the stroke, ensure a
 *           mask sub-layer exists when inpaint runs against an empty
 *           layer, push an undo entry with a tool-specific label, then
 *           kick off the first stamp.
 *  - continue: 将新的光标位置转发给 `_strokeTo`。
 *  - end: clear the drawing flag, composite, sync any tool indicators
 *         that reflect mask state.
 *
 * 克隆工具有自己的 begin（参见 tools/clone.js），但复用了
 * `continue` 和 `end`，因为一旦克隆笔触开始，管线
 * 完全相同。
 *
 * @param {{
 *   saveState:               (label: string) => void,
 *   strokeTo:                (x: number, y: number) => void,
 *   composite:               () => void,
 *   getActiveMaskLayer:      () => object | null,
 *   activeParentLayer:       () => object | null,
 *   ensureActiveMaskLayer:   () => object | null,
 *   createLayer:             (name: string, w: number, h: number) => object,
 *   renderLayerPanel:        () => void,
 *   syncToolClearIndicators: () => void,
 * }} deps
 */
import { state } from '../state.js';
import { canvasCoords } from '../canvas-coords.js';

const STROKE_TOOLS = new Set(['brush', 'eraser', 'inpaint']);

function strokeLabel(tool) {
  if (tool === 'brush') return 'Brush stroke';
  if (tool === 'eraser') return 'Eraser stroke';
  if (tool === 'inpaint') return state.inpaintEraseStroke ? 'Erase mask' : 'Paint mask';
  return 'Stroke';
}

export function createStrokeTool({
  saveState, strokeTo, composite,
  getActiveMaskLayer, activeParentLayer, ensureActiveMaskLayer, createLayer,
  renderLayerPanel, syncToolClearIndicators,
}) {
  return {
    /**
     * 开始一个笔触。如果分发器应该认为事件已被处理
     * （即工具是 brush/eraser/inpaint 之一），则返回 true。
     */
    tryBegin(e) {
      if (!STROKE_TOOLS.has(state.tool)) return false;
      // Capture the inpaint-erase flag for this stroke. Ctrl+Alt
      // pressed at pointerdown flips the persistent toggle for one
      // stroke only.
      if (state.tool === 'inpaint') {
        const flip = e && e.ctrlKey && e.altKey;
        state.inpaintEraseStroke = flip ? !state.inpaintEraseMode : state.inpaintEraseMode;
        // 确保正在绘制到已有的遮罩子图层上。如果
        // 根本没有父图层，先创建一个，这样完全
        // 空白的画布也能接受修复笔触。
        if (!getActiveMaskLayer()) {
          let parent = activeParentLayer();
          if (!parent) {
            parent = createLayer('Layer 1', state.imgWidth, state.imgHeight);
            state.layers.push(parent);
            state.activeLayerId = parent.id;
          }
          if (parent.masks && parent.masks.length) {
            parent.activeMaskId = parent.masks[parent.masks.length - 1].id;
            const m = getActiveMaskLayer();
            if (m) {
              state.maskCanvas = m.canvas;
              state.maskCtx = m.ctx;
              renderLayerPanel();
            }
          } else {
            const mk = ensureActiveMaskLayer();
            if (mk) {
              state.maskCanvas = mk.canvas;
              state.maskCtx = mk.ctx;
              renderLayerPanel();
            }
          }
        }
      }
      saveState(strokeLabel(state.tool));
      state.drawing = true;
      const coords = canvasCoords(e, state.mainCanvas);
      state.lastX = coords.x;
      state.lastY = coords.y;
      strokeTo(coords.x, coords.y);
      return true;
    },

    /**
     * 转发正在进行的笔触。如果笔触确实正在进行中
     * （分发器应该短路），则返回 true。
     */
    tryContinue(e) {
      if (!state.drawing) return false;
      e.preventDefault();
      const coords = canvasCoords(e, state.mainCanvas);
      strokeTo(coords.x, coords.y);
      return true;
    },

    /**
     * 结束正在进行的笔触。如果有笔触在进行中则返回 true。
     */
    tryEnd() {
      if (!state.drawing) return false;
      const wasDrawingInpaint = state.tool === 'inpaint';
      state.drawing = false;
      composite();
      if (wasDrawingInpaint) syncToolClearIndicators();
      return true;
    },
  };
}
