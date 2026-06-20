/**
 * 顶栏下拉菜单 — 图像、滤镜和调整大小。
 *
 *   图像菜单 (#ge-image-menu-btn → #ge-image-menu):
 *     调整大小、选区（边缘羽化/删除）、填充、旋转 90/180、
 *     水平/垂直翻转。
 *
 *   滤镜菜单 (#ge-filter-menu-btn → #ge-filter-menu):
 *     模糊子菜单 — 高斯模糊、缩放模糊。
 *
 *   调整大小菜单 (#ge-resize-menu-btn → #ge-resize-menu):
 *     预设宽×高项 (data-resize-w/-h) 立即应用；
 *     [data-resize-custom] 打开一个主题化的提示框用于输入自定义尺寸。
 *
 * 返回调整大小辅助函数，以便键盘快捷键模块也可以
 * 调用它们（Ctrl+Shift+T 打开自定义提示框）。
 *
 * @param {{
 *   closeOtherTopbarMenus: (keepId: string) => void,
 *   registerDocClickAway:  (handler: (e: Event) => void) => void,
 *   saveState:             (label?: string) => void,
 *   composite:             () => void,
 *   fitZoom:               () => void,
 *   promptCanvasSize:      (opts: object) => Promise<{w, h} | null>,
 *   doFillSelection:       () => void,
 *   rotateAllLayers:       (deg: number) => void,
 *   flipAllLayers:         (axis: 'h' | 'v') => void,
 *   applyGaussianBlur:     () => void,
 *   applyZoomBlur:         () => void,
 *   uiModule:              object,
 * }} deps
 *
 * @returns {{
 *   applyResize:         (newW: number, newH: number) => void,
 *   resizeCustomPrompt:  () => Promise<void>,
 * }}
 */
import { state } from './state.js';

export function wireTopbarMenus({
  closeOtherTopbarMenus, registerDocClickAway,
  saveState, composite, fitZoom,
  promptCanvasSize, doFillSelection,
  rotateAllLayers, flipAllLayers,
  applyGaussianBlur, applyZoomBlur,
  uiModule,
}) {
  // ── 调整画布大小 ──
  // 提取为独立函数，使弹出预设和 Ctrl+Shift+T 快捷键
  // 都可以调用它。
  function applyResize(newW, newH) {
    if (!newW || !newH || newW < 1 || newH < 1) {
      uiModule.showToast('Invalid size');
      return;
    }
    saveState('Resize canvas');
    // Only resize the main canvas — layers keep their original size.
    // Content outside the new bounds is clipped during composite, not
    // destroyed.
    if (state.maskCanvas) {
      const tmpMask = document.createElement('canvas');
      tmpMask.width = state.maskCanvas.width;
      tmpMask.height = state.maskCanvas.height;
      tmpMask.getContext('2d').drawImage(state.maskCanvas, 0, 0);
      state.maskCanvas.width = newW;
      state.maskCanvas.height = newH;
      state.maskCtx.drawImage(tmpMask, 0, 0);
    }
    state.imgWidth = newW;
    state.imgHeight = newH;
    state.mainCanvas.width = newW;
    state.mainCanvas.height = newH;
    const sizeLabel = document.getElementById('ge-canvas-size');
    if (sizeLabel) sizeLabel.textContent = `${newW}×${newH}`;
    fitZoom();
    composite();
    uiModule.showToast(t('editor.canvas_resized', { w: newW, h: newH }));
  }

  async function resizeCustomPrompt() {
    const result = await promptCanvasSize({
      title: 'Canvas size',
      okLabel: 'Apply',
      initialW: state.imgWidth,
      initialH: state.imgHeight,
    });
    if (!result) return;
    applyResize(result.w, result.h);
  }

  // ── 图像菜单 ──
  {
    const btn = document.getElementById('ge-image-menu-btn');
    const menu = document.getElementById('ge-image-menu');
    if (btn && menu) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menu.hidden;
        if (willOpen) closeOtherTopbarMenus('ge-image-menu');
        menu.hidden = !menu.hidden;
      });
      menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-image-action]');
        if (!item || item.disabled) return;
        menu.hidden = true;
        const action = item.dataset.imageAction;
        if (action === 'resize') resizeCustomPrompt();
        else if (action === 'selection') document.getElementById('ge-edge-menu-btn')?.click();
        else if (action === 'fill') doFillSelection();
        else if (action === 'rotate-90') rotateAllLayers(90);
        else if (action === 'rotate-180') rotateAllLayers(180);
        else if (action === 'flip-h') flipAllLayers('h');
        else if (action === 'flip-v') flipAllLayers('v');
      });
      registerDocClickAway((e) => {
        if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true;
      });
    }
  }

  // ── 滤镜菜单（模糊子菜单 — 高斯模糊 / 缩放模糊）──
  {
    const btn = document.getElementById('ge-filter-menu-btn');
    const menu = document.getElementById('ge-filter-menu');
    if (btn && menu) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menu.hidden;
        if (willOpen) closeOtherTopbarMenus('ge-filter-menu');
        menu.hidden = !menu.hidden;
      });
      menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-filter-action]');
        if (!item) return;
        menu.hidden = true;
        const action = item.dataset.filterAction;
        if (action === 'blur-gaussian') applyGaussianBlur();
        else if (action === 'blur-zoom') applyZoomBlur();
      });
      registerDocClickAway((e) => {
        if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true;
      });
    }
  }

  // ── 调整大小弹出菜单（预设项 + 自定义… → resizeCustomPrompt）──
  {
    const btn = document.getElementById('ge-resize-menu-btn');
    const menu = document.getElementById('ge-resize-menu');
    if (btn && menu) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menu.hidden;
        if (willOpen) closeOtherTopbarMenus('ge-resize-menu');
        menu.hidden = !menu.hidden;
      });
      menu.querySelectorAll('[data-resize-w]').forEach(item => {
        item.addEventListener('click', () => {
          menu.hidden = true;
          applyResize(parseInt(item.dataset.resizeW, 10), parseInt(item.dataset.resizeH, 10));
        });
      });
      menu.querySelector('[data-resize-custom]')?.addEventListener('click', () => {
        menu.hidden = true;
        resizeCustomPrompt();
      });
      registerDocClickAway((e) => {
        if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true;
      });
    }
  }

  return { applyResize, resizeCustomPrompt };
}
