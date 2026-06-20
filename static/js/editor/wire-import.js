/**
 * Image-import wiring — covers all four entry points that drop an
 * image as a new layer:
 *
 *   #ge-import-topbar    顶部栏 "+ Import" 按钮
 *   #ge-import-file      导入区域的 File 按钮
 *   #ge-import-paste     剪贴板按钮（使用异步剪贴板 API）
 *   #ge-import-gallery   图库选择器 — 获取 /api/gallery/library
 *                        并显示缩略图网格覆盖层
 *
 * 以及共享的 `handleImportedImage(img)` 汇聚函数 — 缩放至画布、
 * centres, creates a new layer, switches to Move tool, hides the
 * import section, refreshes the panel. Returned so the drag-and-drop
 * 返回该函数，以便拖放 + 粘贴路径（在 editor/clipboard-and-drop.js
 * same sink.
 *
 * @param {{
 *   container:        HTMLElement,
 *   saveState:        (label?: string) => void,
 *   createLayer:      (name, w, h) => object,
 *   composite:        () => void,
 *   renderLayerPanel: () => void,
 *   uiModule:         object,
 * }} deps
 *
 * @returns {{ handleImportedImage: (img: HTMLImageElement) => void }}
 */
import { state } from './state.js';

export function wireImport({ container, saveState, createLayer, composite, renderLayerPanel, uiModule }) {
  // 隐藏的 <input type="file">，顶部栏和文件按钮都通过它触发文件选择。
  const importFileInput = document.createElement('input');
  importFileInput.type = 'file';
  importFileInput.accept = 'image/*';
  importFileInput.style.display = 'none';
  container.appendChild(importFileInput);

  function handleImportedImage(img) {
    if (!state.editorOpen) return;
    saveState('Import image');
    // 如果图片比画布大，则等比缩小。
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (w > state.imgWidth || h > state.imgHeight) {
      const scale = Math.min(state.imgWidth / w, state.imgHeight / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const layer = createLayer('Imported', state.imgWidth, state.imgHeight);
    // 在画布上居中。
    const ox = Math.round((state.imgWidth - w) / 2);
    const oy = Math.round((state.imgHeight - h) / 2);
    layer.ctx.drawImage(img, ox, oy, w, h);
    state.layers.push(layer);
    state.activeLayerId = layer.id;
    // Switch to move tool so the imported layer is immediately
    // repositionable.
    state.tool = 'move';
    const tb = container.querySelector('.ge-toolbar');
    if (tb) tb.querySelectorAll('.ge-tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === 'move'));
    // 导入完成后隐藏导入区域。
    const importSec = document.getElementById('ge-import-section');
    if (importSec) importSec.style.display = 'none';
    composite();
    renderLayerPanel();
    if (uiModule) uiModule.showToast('Image imported — drag to position');
  }

  importFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => handleImportedImage(img);
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    importFileInput.value = '';
  });

  document.getElementById('ge-import-topbar')?.addEventListener('click', () => importFileInput.click());
  document.getElementById('ge-import-file')?.addEventListener('click', () => importFileInput.click());

  document.getElementById('ge-import-paste')?.addEventListener('click', async () => {
    try {
      const clipItems = await navigator.clipboard.read();
      let blob = null;
      for (const item of clipItems) {
        const imgType = item.types.find(t => t.startsWith('image/'));
        if (imgType) { blob = await item.getType(imgType); break; }
      }
      if (!blob) { if (uiModule) uiModule.showToast('No image found in clipboard'); return; }
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { handleImportedImage(img); URL.revokeObjectURL(url); };
      img.onerror = () => { URL.revokeObjectURL(url); if (uiModule) uiModule.showToast('Failed to load clipboard image'); };
      img.src = url;
    } catch (e) {
      if (uiModule) uiModule.showToast('Clipboard access denied or no image available');
    }
  });

  // 从图库导入 — 获取 /api/gallery/library 并显示缩略图网格选择器覆盖层。
  // thumbnail-grid picker overlay.
  document.getElementById('ge-import-gallery')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/gallery/library?limit=50', { credentials: 'same-origin' });
      const data = await res.json();
      const items = data.items || [];
      if (!items.length) { if (uiModule) uiModule.showToast('No images in gallery'); return; }

      // 选择器覆盖层。
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
      const panel = document.createElement('div');
      panel.style.cssText = 'background:var(--panel,#1e1e1e);border-radius:12px;padding:16px;max-width:500px;max-height:70vh;overflow-y:auto;width:90%;';
      panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><span style="font-size:13px;font-weight:600;">Pick from Gallery</span><button id="ge-gallery-close" style="background:none;border:none;color:var(--fg);cursor:pointer;font-size:18px;">✕</button></div>';
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:6px;';
      for (const item of items) {
        const thumb = document.createElement('img');
        thumb.src = item.url;
        thumb.style.cssText = 'width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid transparent;transition:border-color 0.15s;';
        thumb.addEventListener('mouseenter', () => { thumb.style.borderColor = 'var(--accent,#61afef)'; });
        thumb.addEventListener('mouseleave', () => { thumb.style.borderColor = 'transparent'; });
        thumb.addEventListener('click', () => {
          overlay.remove();
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => handleImportedImage(img);
          img.onerror = () => { if (uiModule) uiModule.showToast('Failed to load gallery image'); };
          img.src = item.url;
        });
        grid.appendChild(thumb);
      }
      panel.appendChild(grid);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      panel.querySelector('#ge-gallery-close').addEventListener('click', () => overlay.remove());
    } catch (e) {
      if (uiModule) uiModule.showToast('Failed to load gallery: ' + e.message);
    }
  });

  return { handleImportedImage };
}
