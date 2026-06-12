/**
 * 粘贴 + 拖放导入处理器。两者都将图像作为新图层添加到编辑器中：
 *
 *   - 粘贴 (Ctrl+V)：首先检查 `state.internalClipboard`（由
 *     套索复制/剪切设置），然后回退到系统剪贴板的
 *     `image/*` 项。图层命名为 "Pasted Selection" 或 "Pasted"
 *     并成为活动图层；工具切换到移动工具以便用户可以立即
 *     重新定位它。
 *   - 拖放：从操作系统/其他标签页拖入的任何 `image/*` 文件。
 *     在拖放过程中显示 "Drop image to add as new layer" 叠加层。每个
 *     拖入的图像通过 `handleImportedImage` 路由处理，因此画布
 *     大小调整提示 + 撤销历史与工具栏的导入按钮行为一致。
 *
 * 两者都由 `state.editorOpen` 控制，确保编辑器关闭时
 * 它们在页面上是惰性的（页面上的其他监听器优先处理）。
 *
 * @param {{
 *   container:            HTMLElement,
 *   saveState:            (label?: string) => void,
 *   createLayer:          (name: string, w: number, h: number) => object,
 *   renderLayerPanel:     () => void,
 *   composite:            () => void,
 *   handleImportedImage:  (img: HTMLImageElement) => void,
 *   uiModule:             object,
 * }} deps
 */
import { state } from './state.js';

export function wireClipboardAndDrop({
  container, saveState, createLayer, renderLayerPanel, composite,
  handleImportedImage, uiModule,
}) {
  // ── 粘贴 ──
  window.addEventListener('paste', (e) => {
    if (!state.editorOpen) return;

    function pasteAsLayer(imgSource, label) {
      if (!state.editorOpen) return; // 用户在粘贴过程中关闭了编辑器
      saveState();
      const layer = createLayer(label || 'Pasted', imgSource.width, imgSource.height);
      layer.ctx.drawImage(imgSource, 0, 0);
      state.layers.push(layer);
      state.activeLayerId = layer.id;
      state.tool = 'move';
      const tb = state.container?.querySelector('.ge-toolbar');
      if (tb) tb.querySelectorAll('.ge-tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === 'move'));
      renderLayerPanel();
      composite();
      uiModule.showToast('Pasted as new layer');
    }

    // 首先检查内部剪贴板（来自 Ctrl+C 套索/魔棒）。
    if (state.internalClipboard) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pasteAsLayer(state.internalClipboard, 'Pasted Selection');
      return;
    }

    // 回退到系统剪贴板。
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      e.stopImmediatePropagation();
      const blob = item.getAsFile();
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { pasteAsLayer(img, 'Pasted'); URL.revokeObjectURL(url); };
      img.src = url;
      break;
    }
  }, true);  // 捕获阶段以便优先于聊天输入处理

  // ── 拖放 ──
  // 可视化的拖放区域叠加层在拖拽过程中出现；通过
  // handleImportedImage 路由处理，因此导入会遵循画布大小调整规则
  // + 保存历史记录（与工具栏导入按钮路径相同）。
  const dropZone = container;
  if (!dropZone) return;
  let dragDepth = 0;
  const hasFileType = (dt) => dt && Array.from(dt.types || []).some(t => t === 'Files');
  const showOverlay = () => {
    if (!state.editorOpen) return;
    let ov = dropZone.querySelector('.ge-drop-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'ge-drop-overlay';
      ov.innerHTML = '<div class="ge-drop-overlay-msg">Drop image to add as new layer</div>';
      dropZone.appendChild(ov);
    }
    ov.style.display = '';
  };
  const hideOverlay = () => {
    const ov = dropZone.querySelector('.ge-drop-overlay');
    if (ov) ov.style.display = 'none';
  };
  dropZone.addEventListener('dragenter', (e) => {
    if (!state.editorOpen || !hasFileType(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth++;
    showOverlay();
  });
  dropZone.addEventListener('dragover', (e) => {
    if (!state.editorOpen || !hasFileType(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  dropZone.addEventListener('dragleave', () => {
    if (!state.editorOpen) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  });
  dropZone.addEventListener('drop', (e) => {
    if (!state.editorOpen) return;
    dragDepth = 0;
    hideOverlay();
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => { handleImportedImage(img); URL.revokeObjectURL(url); };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    }
  });
}
