/**
 * Editor keyboard shortcuts — bound to `document` so shortcuts work
 * without first clicking into the canvas. Gated by `state.editorOpen`
 * so they don't leak into chat input when the editor is closed.
 *
 * 涵盖：
 *   ?              切换快捷键速查表
 *   Enter          确认进行中的变换
 *   Esc            取消变换 / 套索 / 裁剪（按优先级顺序）
 *   Ctrl+Z         撤销（Shift 加为重做）
 *   Ctrl+Shift+D   取消选择（清除魔棒 + 套索）
 *   Ctrl+S         保存（Shift = 另存为 / 导出到图片库）
 *   Ctrl+Shift+T   打开调整大小弹出窗口
 *   Ctrl+Alt+T     开始自由变换
 *   Ctrl+Alt+I     反转魔棒 / 套索选区
 *   Ctrl+Alt+J     新建空图层
 *   Ctrl+Alt+A     全选画布（套索多边形 = 完整边界）
 *   Ctrl+C/X       复制 / 剪切魔棒或套索选区（图像剪贴板
 *                  + 内部剪贴板）
 *   Ctrl+V         （由粘贴事件监听器处理）
 *   工具按键 (V, B, E, L, …) → 工具栏点击
 *   [ / ]          按比例缩小 / 放大画笔大小
 *   D, C, M（当套索有 3+ 个点时）→ 删除 / 复制 / 转换为蒙版
 *   Delete / Backspace（魔棒或套索）→ 删除像素
 *
 * @param {{
 *   toolbar:                HTMLDivElement,
 *   toolKeyMap:             Record<string, string>,
 *   composite:              () => void,
 *   saveState:              (label?: string) => void,
 *   undo:                   () => void,
 *   redo:                   () => void,
 *   toggleShortcuts:        (show?: boolean) => void,
 *   confirmTransform:       () => void,
 *   cancelTransform:        () => void,
 *   startTransform:         () => void,
 *   resizeCustomPrompt:     () => void,
 *   addEmptyLayer:          () => void,
 *   brushSizeSync:          (source: HTMLInputElement | null) => void,
 *   invertSelection:        () => boolean,
 *   wandDeleteSelection:    () => void,
 *   wandCopyToNewLayer:     () => void,
 *   lassoDeleteSelection:   () => void,
 *   lassoCopyToLayer:       () => void,
 *   lassoToMask:            () => void,
 *   buildLassoMask:         (w: number, h: number, offX: number, offY: number, feather: number, grow: number) => HTMLCanvasElement,
 *   drawLassoOverlay:       () => void,
 *   activeLayer:            () => object | null,
 *   uiModule:               object,
 * }} deps
 */
import { state } from './state.js';
import { isAltGrEvent } from '../platform.js';

export function wireKeyboardShortcuts(deps) {
  const {
    toolbar, toolKeyMap,
    composite, saveState, undo, redo,
    toggleShortcuts, confirmTransform, cancelTransform, startTransform,
    resizeCustomPrompt, addEmptyLayer, brushSizeSync,
    invertSelection,
    wandDeleteSelection, wandCopyToNewLayer,
    lassoDeleteSelection, lassoCopyToLayer, lassoToMask,
    buildLassoMask, drawLassoOverlay,
    activeLayer, uiModule,
  } = deps;

  document.addEventListener('keydown', (e) => {
    if (!state.editorOpen) return;
    // `?` 切换速查表。在文本输入框中输入时不要触发
    // — 用户可能在输入带有 `?` 的提示词。
    if (e.key === '?' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      toggleShortcuts();
      return;
    }
    if (e.key === 'Enter' && state.transformActive) {
      e.preventDefault();
      confirmTransform();
      return;
    }
    if (e.key === 'Escape') return;
    // 对 AltGr 按键跳过 Ctrl+Alt 编辑器组合键（参见 platform.js）；
    // 仅跳过组合键部分，因此下面的布局字符处理器
    // 仍然生效 — AltGr+5 / AltGr+8 在 AZERTY / QWERTZ 键盘上
    // 保持为 [ ] 画笔大小快捷键。
    if ((e.ctrlKey || e.metaKey) && !isAltGrEvent(e)) {
      if (e.key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      // Ctrl+Shift+D = 取消选择：清除魔棒选区（以及
      // 套索如果处于活动状态），不影响图层。
      if (e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        if (state.wandMask || state.lassoPoints.length) {
          e.preventDefault();
          if (state.wandMask) {
            saveState();
            state.wandMask = null;
            state.wandLayerId = null;
            state.wandLastSeed = null;
          }
          if (state.lassoPoints.length) {
            state.lassoPoints = [];
            state.lassoActive = false;
          }
          composite();
        }
      }
      // 保存快捷键 — 与保存下拉菜单中显示的提示匹配。
      if ((e.key === 's' || e.key === 'S') && !e.altKey) {
        e.preventDefault();
        document.getElementById(e.shiftKey ? 'ge-export-gallery' : 'ge-save')?.click();
      }
      if (e.shiftKey && e.key === 'T') { e.preventDefault(); resizeCustomPrompt(); }
      if (e.altKey && e.key === 't') { e.preventDefault(); startTransform(); }
      // Ctrl+Alt+I — 反转当前选区。使用 e.code 以便
      // Alt 修饰键产生的值（例如 Mac 上 Option+I 产生的 `ˆ`）
      // 不会破坏匹配。
      if (e.altKey && e.code === 'KeyI') {
        if (invertSelection()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
      // Ctrl+Alt+J — 新建空图层。
      if (e.altKey && e.code === 'KeyJ') {
        e.preventDefault();
        e.stopPropagation();
        addEmptyLayer();
      }
      // 魔棒选区：Delete = 擦除像素。Ctrl+X = 剪切到
      // 剪贴板 + 新建图层 + 擦除。Ctrl+C = 复制。
      // （旧代码中的 `&& !_wandActive` 子句引用了一个未声明的
      // 变量 — 已移除；魔棒仅用于选区，没有
      // "活动拖拽" 状态。）
      if (state.wandMask) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          wandDeleteSelection();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'c')) {
          e.preventDefault();
          const isCut = e.key === 'x';
          const src = state.layers.find(l => l.id === state.wandLayerId);
          if (!src) return;
          // 按魔棒蒙版裁剪源图层到临时画布。
          const w = src.canvas.width, h = src.canvas.height;
          const tmp = document.createElement('canvas');
          tmp.width = w; tmp.height = h;
          const tCtx = tmp.getContext('2d');
          tCtx.drawImage(src.canvas, 0, 0);
          tCtx.globalCompositeOperation = 'destination-in';
          tCtx.drawImage(state.wandMask, 0, 0);
          state.internalClipboard = tmp;
          tmp.toBlob(blob => {
            if (blob && navigator.clipboard?.write) {
              navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => {
                uiModule.showToast(isCut ? 'Cut to clipboard' : 'Copied to clipboard');
              }).catch(() => uiModule.showToast(isCut ? 'Cut (editor only)' : 'Copied (editor only)'));
            }
          }, 'image/png');
          if (isCut) {
            // 剪切同时将选区移动到新图层 + 擦除源内容。
            wandCopyToNewLayer();
            wandDeleteSelection();
          }
          return;
        }
      }
      if ((e.key === 'x' || e.key === 'c') && state.lassoPoints.length >= 3) {
        e.preventDefault();
        const layer = activeLayer();
        if (!layer) return;
        const off = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
        const feather = parseInt(document.getElementById('ge-lasso-feather')?.value || '0');
        const grow = parseInt(document.getElementById('ge-lasso-grow')?.value || '0');
        const w = layer.canvas.width, h = layer.canvas.height;
        const mask = buildLassoMask(w, h, off.x, off.y, feather, grow);
        const srcData = layer.ctx.getImageData(0, 0, w, h);
        const maskData = mask.getContext('2d').getImageData(0, 0, w, h);
        // 构建裁剪后的图像。
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tCtx = tmp.getContext('2d');
        const outData = tCtx.createImageData(w, h);
        for (let i = 0; i < w * h; i++) {
          const mv = maskData.data[i * 4] / 255;
          if (mv > 0) {
            outData.data[i*4] = srcData.data[i*4];
            outData.data[i*4+1] = srcData.data[i*4+1];
            outData.data[i*4+2] = srcData.data[i*4+2];
            outData.data[i*4+3] = Math.round(srcData.data[i*4+3] * mv);
          }
        }
        tCtx.putImageData(outData, 0, 0);
        state.internalClipboard = tmp;
        const isCut = e.key === 'x';
        tmp.toBlob(blob => {
          if (blob && navigator.clipboard?.write) {
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => {
              uiModule.showToast(isCut ? 'Cut to clipboard' : 'Copied to clipboard');
            }).catch(() => uiModule.showToast(isCut ? 'Cut (editor only)' : 'Copied (editor only)'));
          }
        }, 'image/png');
        if (e.key === 'x') {
          const savedPts = [...state.lassoPoints];
          state.lassoPoints = savedPts;
          lassoDeleteSelection();
        } else {
          state.lassoPoints = [];
          composite();
        }
      }
      // Ctrl+C 且没有活动选区 → 将整个活动图层
      // 作为 PNG 复制到系统剪贴板。提供一个"直接复制此图像"
      // 的快捷键，无需先套索全选。
      // 上面的选区感知 Ctrl+C 路径先运行（魔棒 + 套索），
      // 因此仅当两者都不活动时才会触发此路径。
      if (e.key === 'c' && !e.shiftKey && !state.wandMask && state.lassoPoints.length < 3) {
        const layer = activeLayer();
        if (layer && layer.canvas && layer.canvas.width > 0) {
          e.preventDefault();
          layer.canvas.toBlob(blob => {
            if (blob && navigator.clipboard?.write) {
              navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                .then(() => uiModule.showToast('Layer copied to clipboard'))
                .catch(() => uiModule.showToast('Copy failed (clipboard permission denied?)'));
            }
          }, 'image/png');
          return;
        }
      }
      // Ctrl+Alt+A = 全选画布。
      if (e.altKey && e.key === 'a' && state.imgWidth > 0 && state.imgHeight > 0) {
        e.preventDefault();
        state.lassoPoints = [
          { x: 0, y: 0 }, { x: state.imgWidth, y: 0 },
          { x: state.imgWidth, y: state.imgHeight }, { x: 0, y: state.imgHeight },
        ];
        state.lassoActive = false;
        composite();
        drawLassoOverlay();
        uiModule.showToast('All selected — Ctrl+C to copy, Del to delete');
      }
      // Ctrl+V 由粘贴事件监听器处理。
      if (e.key === 'v') { /* 此处不操作 */ }
      return;
    }
    // 工具快捷键（仅当不在输入框中输入时生效）。
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const toolId = toolKeyMap[e.key.toLowerCase()];
    if (toolId) {
      const toolBtn = toolbar.querySelector(`[data-tool="${toolId}"]`);
      if (toolBtn) toolBtn.click();
    }
    // Bracket keys for brush size — ±10% multiplier mirrors the
    // exponential slider curve so each press feels the same at any
    // size.
    if (e.key === '[' || e.key === ']') {
      const factor = e.key === '[' ? 0.9 : 1.1;
      state.brushSize = Math.max(1, Math.min(800, Math.round(state.brushSize * factor)));
      try { brushSizeSync(null); } catch {}
    }
    // 套索快捷键（当选区存在时）。
    if (state.lassoPoints.length >= 3) {
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); lassoDeleteSelection(); }
      if (e.key === 'd') { e.preventDefault(); lassoDeleteSelection(); }
      if (e.key === 'c') { e.preventDefault(); lassoCopyToLayer(); }
      if (e.key === 'm') { e.preventDefault(); lassoToMask(); }
    }
  });
}
