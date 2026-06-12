/**
 * 整个文档的变换：旋转 90/180/270° 或水平/垂直翻转。
 * 这些操作会修改每个图层的画布 + 偏移映射 +
 * 文档的整体宽度/高度，使得结果看起来像是整个图像作为一个整体被旋转。
 *
 * 近似纯函数 — 直接读/写共享状态；工厂函数接受
 * 一小部分依赖用于编排管道（撤销快照、画布
 * 加载叠加层、适配缩放至视口、合成重绘）。
 *
 * @param {{
 *   saveState:           (label?: string) => void,
 *   composite:           () => void,
 *   fitZoom:             () => void,
 *   showCanvasLoading:   (label: string) => void,
 *   hideCanvasLoading:   () => void,
 * }} deps
 */
import { state } from './state.js';

import { t } from './i18n.js';

export function createCanvasTransforms({ saveState, composite, fitZoom, showCanvasLoading, hideCanvasLoading }) {
  return {
    /**
     * 将整个文档旋转 `deg` 度（90 / 180 / 270）。90 和 270
     * 会交换画布尺寸。每个图层围绕自己的中心旋转，
     * 然后其中心围绕旧图像中心旋转
     * 并平移到新图像的框架中。
     *
     * 包裹在 requestAnimationFrame 中，因为旋转操作对于大图像
     * 可能阻塞 UI 0.5-2 秒 — 加载旋转器叠加层在我们阻塞之前绘制。
     */
    rotateAll(deg) {
      if (!state.layers.length) return;
      saveState(t('editor.rotate_n', { deg: deg }));
      showCanvasLoading('Rotating…');
      const oldW = state.imgWidth, oldH = state.imgHeight;
      const swap = (deg === 90 || deg === 270);
      const newW = swap ? oldH : oldW;
      const newH = swap ? oldW : oldH;
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      requestAnimationFrame(() => {
        try {
          for (const layer of state.layers) {
            const lw = layer.canvas.width, lh = layer.canvas.height;
            const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
            // 旧图像坐标中的图层中心。
            const cx = off.x + lw / 2;
            const cy = off.y + lh / 2;
            // 围绕旧图像中心旋转中心，并平移使得
            // 新图像中心落在 (newW/2, newH/2)。
            const dx = cx - oldW / 2;
            const dy = cy - oldH / 2;
            const nx = dx * cos - dy * sin + newW / 2;
            const ny = dx * sin + dy * cos + newH / 2;
            // 95度/270度时交换每个图层的尺寸。
            const newLw = swap ? lh : lw;
            const newLh = swap ? lw : lh;
            const tmp = document.createElement('canvas');
            tmp.width = newLw; tmp.height = newLh;
            const tctx = tmp.getContext('2d');
            tctx.translate(newLw / 2, newLh / 2);
            tctx.rotate(rad);
            tctx.drawImage(layer.canvas, -lw / 2, -lh / 2);
            layer.canvas.width = newLw;
            layer.canvas.height = newLh;
            layer.ctx.drawImage(tmp, 0, 0);
            // 调整渲染缓存的键仅由调整特征的签名决定，
            // 而旋转不会改变签名 — 因此合成可能会绘制
            // 过期的旋转前缓存（即"需要点两次"的 Bug）。丢弃它们
            // 以便下次合成时从旋转后的画布重新渲染。
            layer._adjCacheKey = null;
            layer._adjFinalKey = null;
            state.layerOffsets.set(layer.id, {
              x: Math.round(nx - newLw / 2),
              y: Math.round(ny - newLh / 2),
            });
          }
          state.imgWidth = newW;
          state.imgHeight = newH;
          state.mainCanvas.width = newW;
          state.mainCanvas.height = newH;
          if (state.maskCanvas) {
            state.maskCanvas.width = newW;
            state.maskCanvas.height = newH;
          }
          const sizeLabel = document.getElementById('ge-canvas-size');
          if (sizeLabel) sizeLabel.textContent = `${newW}×${newH}`;
          fitZoom();
          composite();
        } finally {
          hideCanvasLoading();
        }
      });
    },

    /**
     * 水平 ('h') 或垂直 ('v') 镜像每个图层。
     * 画布尺寸不变。每个图层偏移围绕图像中心反射。
     */
    flipAll(axis) {
      if (!state.layers.length) return;
      saveState(axis === 'h' ? 'Flip horizontal' : 'Flip vertical');
      for (const layer of state.layers) {
        const lw = layer.canvas.width, lh = layer.canvas.height;
        const tmp = document.createElement('canvas');
        tmp.width = lw; tmp.height = lh;
        const tctx = tmp.getContext('2d');
        tctx.save();
        if (axis === 'h') { tctx.translate(lw, 0); tctx.scale(-1, 1); }
        else              { tctx.translate(0, lh); tctx.scale(1, -1); }
        tctx.drawImage(layer.canvas, 0, 0);
        tctx.restore();
        layer.ctx.clearRect(0, 0, lw, lh);
        layer.ctx.drawImage(tmp, 0, 0);
        // 使调整渲染缓存失效（键仅由调整特征签名决定）
        // 以便合成时从翻转后的画布重绘，而非使用过期缓存。
        layer._adjCacheKey = null;
        layer._adjFinalKey = null;
        const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
        if (axis === 'h') {
          state.layerOffsets.set(layer.id, { x: state.imgWidth - off.x - lw, y: off.y });
        } else {
          state.layerOffsets.set(layer.id, { x: off.x, y: state.imgHeight - off.y - lh });
        }
      }
      composite();
    },
  };
}
