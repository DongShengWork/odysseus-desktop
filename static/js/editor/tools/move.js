/**
 * 移动工具 — 在画布上拖拽图层，可选按住 Ctrl
 * 吸附到其他图层的边缘/中心以及画布边缘/中心。
 *
 * 拥有自己的输入处理器（begin/drag/end），直接读写
 * 共享的 `state` 存储。工厂函数接受一个小的依赖包，
 * 用于仍在 galleryEditor.js 中的功能 —
 * `activeLayer`、`saveState`、`composite` —
 * 因此本模块无需了解协调器。
 *
 * @param {{
 *   activeLayer: () => {id: string, canvas: HTMLCanvasElement, locked?: boolean} | null,
 *   saveState:   (label?: string) => void,
 *   composite:   () => void,
 * }} deps
 * @returns {{ begin: (e: Event) => void, drag: (e: Event) => void, end: () => void }}
 */
import { state } from '../state.js';
import { canvasCoords } from '../canvas-coords.js';
import { computeSnap as computeSnapImpl } from '../snap.js';

export function createMoveTool({ activeLayer, saveState, composite }) {
  function computeSnap(layer, nx, ny) {
    return computeSnapImpl(layer, nx, ny, {
      zoom: state.zoom,
      canvasW: state.imgWidth,
      canvasH: state.imgHeight,
      otherLayers: state.layers.map(l => ({
        visible: l.visible,
        id: l.id,
        canvas: l.canvas,
        offset: state.layerOffsets.get(l.id) || { x: 0, y: 0 },
      })),
    });
  }

  return {
    begin(e) {
      const layer = activeLayer();
      if (!layer || layer.locked) return;
      saveState();
      state.moving = true;
      const coords = canvasCoords(e, state.mainCanvas);
      const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
      state.moveStartX = coords.x;
      state.moveStartY = coords.y;
      state.moveLayerOffsetX = off.x;
      state.moveLayerOffsetY = off.y;
    },
    drag(e) {
      if (!state.moving) return;
      e.preventDefault();
      const layer = activeLayer();
      if (!layer) return;
      const coords = canvasCoords(e, state.mainCanvas);
      const dx = coords.x - state.moveStartX;
      const dy = coords.y - state.moveStartY;
      let nx = state.moveLayerOffsetX + dx;
      let ny = state.moveLayerOffsetY + dy;
      // Ctrl 按住 = 吸附到画布边缘/中心以及每个
      // 可见图层的边缘/中心。选择加入以避免正常拖拽
      // 时产生"粘滞"感。
      if (e.ctrlKey || e.metaKey) {
        const snapped = computeSnap(layer, nx, ny);
        nx = snapped.x;
        ny = snapped.y;
        state.activeSnapGuides = snapped.guides;
      } else {
        state.activeSnapGuides = null;
      }
      state.layerOffsets.set(layer.id, { x: nx, y: ny });
      composite();
    },
    end() {
      state.moving = false;
      state.activeSnapGuides = null;
    },
  };
}
