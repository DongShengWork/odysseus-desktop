/**
 * 图层面板渲染器 — 每次调用时从 `state.layers` 重建右侧的图层列表。
 * 每个图层的完整行树：
 *
 *   父行
 *     [拖拽手柄] [眼睛] [名称] [不透明度滑块] [FX] [复制] [遮罩] [向下合并] [×]
 *   调节子行（FX 条目）
 *     [眼睛] [名称+图标] [不透明度滑块] [合并] [×]
 *   遮罩子行
 *     [眼睛] [名称] [向上合并?] [×]
 *
 * 直接读写共享的 `state`（layers, activeLayerId, layerOffsets,
 * imgWidth, imgHeight, lassoPoints/lassoActive, wandMask,
 * maskCanvas/maskCtx, nextLayerId）。函数依赖是仍位于
 * galleryEditor.js 中的编排回调。
 *
 * 返回 `{ render }`，以便通过闭包递归自调用 `render`
 * 而非模块状态查找。
 *
 * @param {{
 *   composite:                       () => void,
 *   saveState:                       (label?: string) => void,
 *   showLayerThumb:                  (rowEl: HTMLElement, layer: object) => void,
 *   hideLayerThumb:                  () => void,
 *   loadLayerAlphaAsSelection:       (layer: object) => void,
 *   openFxPopup:                     (layer: object, anchor: HTMLElement) => void,
 *   editAdjLayer:                    (layer: object, adj: object, anchor: HTMLElement) => void,
 *   createLayer:                     (name: string, w: number, h: number) => object,
 *   lassoToMask:                     () => void,
 *   wandToMask:                      () => void,
 *   getActiveMaskLayer:              () => object | null,
 *   syncFxPanelToActiveLayerIfPresent: () => void,
 *   dragSortModule:                  object | null,
 *   uiModule:                        object | null,
 * }} deps
 */
import { state } from './state.js';
import {
  layerHasAdjustments,
  isLayerEmpty,
  isMaskCanvasEmpty,
  adjLayerLabel,
  ADJ_ICONS,
} from './layer-helpers.js';
import { applyAdjustment } from './fx/pixel-pass.js';
import { mergeLayerDownAtIndex } from './wire-merge-buttons.js';

import { t } from './i18n.js';

const EYE_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/></svg>';
const EYE_OPEN_SM = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SM  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/></svg>';

export function createLayerPanelRenderer(deps) {
  const {
    composite, saveState, showLayerThumb, hideLayerThumb,
    loadLayerAlphaAsSelection, openFxPopup, editAdjLayer,
    createLayer, lassoToMask, wandToMask, getActiveMaskLayer,
    syncFxPanelToActiveLayerIfPresent,
    dragSortModule, uiModule,
  } = deps;

  function shouldIgnoreLayerTap() {
    return Date.now() < (window.__geSuppressLayerTapUntil || 0);
  }

  function render() {
    // FX 面板镜像活动图层的调节 — 在每次图层事件（激活、添加、删除等）时重新同步。
    try { syncFxPanelToActiveLayerIfPresent(); } catch {}
    const list = document.getElementById('ge-layers-list');
    if (!list) return;
    // 移动端底部面板露出高度 — 标题 + N 行，上限避免 20 层文档的露出高度占用画布空间。
    const panel = document.querySelector('.ge-right-panel');
    if (panel) {
      requestAnimationFrame(() => {
        const header = panel.querySelector('.ge-layers-header');
        const firstRow = list.querySelector('.ge-layer-item');
        const headerH = header ? header.offsetHeight : 52;
        const rowH = firstRow ? firstRow.offsetHeight : 36;
        const allRows = list.querySelectorAll('.ge-layer-item').length;
        const MAX_ROWS = 2;
        const rows = Math.min(allRows, MAX_ROWS);
        panel.style.setProperty('--peek-height', `${headerH + rows * rowH + 6}px`);
      });
    }
    list.innerHTML = '';

    // 按逆向顺序渲染（顶层优先）。
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const layer = state.layers[i];
      const item = document.createElement('div');
      // 父行仅在实际是绘制目标时才高亮 — 已激活且当前没有遮罩子图层处于活动状态。
      const parentIsPaintTarget = layer.id === state.activeLayerId &&
        !(layer.masks && layer.activeMaskId && layer.masks.some(m => m.id === layer.activeMaskId));
      item.className = 'ge-layer-item' +
        (parentIsPaintTarget ? ' active' : '') +
        (layer.id === state.activeLayerId && !parentIsPaintTarget ? ' active-parent' : '');
      item.dataset.layerId = layer.id;
      // 悬停缩略图。
      item.addEventListener('mouseenter', () => showLayerThumb(item, layer));
      item.addEventListener('mouseleave', () => hideLayerThumb());
      item.addEventListener('click', (e) => {
        if (shouldIgnoreLayerTap()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // Shift+点击 → 将图层透明度加载为魔棒选区。
        if (e.shiftKey) {
          e.preventDefault();
          loadLayerAlphaAsSelection(layer);
          return;
        }
        if (state.activeLayerId === layer.id) return;
        state.activeLayerId = layer.id;
        // 内联切换 active 类（避免完全重新渲染，使名称元素上的双击监听器
        // 在点击之间保持有效 — 重新渲染会在第一次点击后销毁元素，
        // 第二次点击落在不同节点上）。
        document.querySelectorAll('.ge-layers-list .ge-layer-item').forEach(el => {
          el.classList.toggle('active', el.dataset.layerId === state.activeLayerId);
        });
      });

      // 拖拽手柄 — 抓取点；下面的 dragSortModule.enable() 将拖拽初始化
      // 限制在此手柄上，使行主体点击仍可激活。
      const handle = document.createElement('span');
      handle.className = 'ge-layer-drag';
      handle.title = 'Drag to reorder';
      handle.innerHTML = '<svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor"><circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/><circle cx="2" cy="7" r="1"/><circle cx="6" cy="7" r="1"/><circle cx="2" cy="12" r="1"/><circle cx="6" cy="12" r="1"/></svg>';
      item.appendChild(handle);

      const visBtn = document.createElement('button');
      visBtn.className = 'ge-layer-vis' + (layer.visible ? ' visible' : '');
      visBtn.innerHTML = layer.visible ? EYE_OPEN : EYE_OFF;
      visBtn.title = layer.visible ? 'Hide layer' : 'Show layer';
      visBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        composite();
        render();
      });

      const nameEl = document.createElement('span');
      nameEl.className = 'ge-layer-name';
      nameEl.textContent = layer.name + (isLayerEmpty(layer) ? ' (empty)' : '');
      nameEl.addEventListener('dblclick', () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = layer.name;
        input.className = 'ge-layer-name-input';
        nameEl.replaceWith(input);
        input.focus();
        const save = () => { layer.name = input.value || layer.name; render(); };
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
      });

      const opSlider = document.createElement('input');
      opSlider.type = 'range';
      opSlider.min = '0';
      opSlider.max = '100';
      opSlider.value = String(Math.round(layer.opacity * 100));
      opSlider.className = 'ge-layer-opacity';
      opSlider.title = 'Opacity';
      opSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        layer.opacity = parseInt(e.target.value) / 100;
        composite();
      });
      // 浏览器 :active 在鼠标离开滑块命中区域时立即丢失（某些浏览器）；
      // JS 管理的 `dragging` 类在 OS 指针捕获中持续存在，
      // 使滑块在整个拖拽过程中保持展开。
      opSlider.addEventListener('pointerdown', () => {
        opSlider.classList.add('dragging');
        const onUp = () => {
          opSlider.classList.remove('dragging');
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointerup', onUp);
      });

      const controls = document.createElement('div');
      controls.className = 'ge-layer-controls';

      // FX（调节）— 打开绑定到此图层的浮动弹出框。
      const fxBtn = document.createElement('button');
      fxBtn.className = 'ge-layer-btn ge-layer-fx-btn' + (layerHasAdjustments(layer) ? ' active' : '');
      fxBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor"/></svg>';
      fxBtn.title = 'Adjust layer (Brightness, Contrast, Saturation, Hue, Levels, Color Balance)';
      fxBtn.style.touchAction = 'manipulation';
      let lastFxPointerOpenAt = 0;
      let fxOpenTimer = null;
      const openLayerFx = (e, delay = 0) => {
        e.preventDefault?.();
        e.stopPropagation();
        window.__geSuppressLayerTapUntil = 0;
        if (fxOpenTimer) clearTimeout(fxOpenTimer);
        fxOpenTimer = setTimeout(() => {
          fxOpenTimer = null;
          openFxPopup(layer, fxBtn);
        }, delay);
      };
      fxBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
      });
      fxBtn.addEventListener('pointerup', (e) => {
        lastFxPointerOpenAt = Date.now();
        const delay = e.pointerType === 'touch' || e.pointerType === 'pen' ? 120 : 0;
        openLayerFx(e, delay);
      });
      fxBtn.addEventListener('click', (e) => {
        if (Date.now() - lastFxPointerOpenAt < 500) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        openLayerFx(e);
      });
      controls.appendChild(fxBtn);

      // 复制 — 克隆像素 + 偏移 + 不透明度 + 遮罩 + 调节图层 + 可见性；
      // 插入到原始图层上方；新副本成为活动图层。
      const dupBtn = document.createElement('button');
      dupBtn.className = 'ge-layer-btn';
      dupBtn.title = 'Duplicate layer';
      dupBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      dupBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        saveState(t('editor.duplicate_layer', { name: layer.name }));
        const copy = createLayer(layer.name + ' copy', layer.canvas.width, layer.canvas.height);
        copy.ctx.drawImage(layer.canvas, 0, 0);
        copy.opacity = layer.opacity;
        copy.visible = layer.visible;
        const srcOff = state.layerOffsets.get(layer.id) || { x: 0, y: 0 };
        state.layerOffsets.set(copy.id, { x: srcOff.x, y: srcOff.y });
        if (Array.isArray(layer.masks) && layer.masks.length) {
          copy.masks = layer.masks.map(m => {
            const c = document.createElement('canvas');
            c.width = m.canvas.width; c.height = m.canvas.height;
            c.getContext('2d').drawImage(m.canvas, 0, 0);
            return {
              id: 'mask-' + (state.nextLayerId++),
              name: m.name,
              canvas: c,
              ctx: c.getContext('2d'),
              visible: m.visible !== false,
            };
          });
        }
        if (Array.isArray(layer.adjLayers) && layer.adjLayers.length) {
          copy.adjLayers = layer.adjLayers.map(a => ({
            id: 'adj-' + Math.random().toString(36).slice(2, 9),
            type: a.type,
            name: a.name,
            visible: a.visible !== false,
            opacity: a.opacity != null ? a.opacity : 1,
            params: JSON.parse(JSON.stringify(a.params || {})),
          }));
        }
        const idx = state.layers.findIndex(l => l.id === layer.id);
        if (idx >= 0) state.layers.splice(idx + 1, 0, copy);
        else state.layers.push(copy);
        state.activeLayerId = copy.id;
        composite();
        render();
        if (uiModule) uiModule.showToast('Layer duplicated');
      });
      controls.appendChild(dupBtn);

      // 添加遮罩 — 如果有套索/魔棒选区，将其烘焙为此图层的遮罩子图层；
      // 否则创建空遮罩，供用户使用画笔工具绘制。
      const hasLassoSelInitial = state.lassoPoints.length >= 3 && !state.lassoActive;
      const hasWandSelInitial = !!state.wandMask;
      const maskBtn = document.createElement('button');
      maskBtn.className = 'ge-layer-btn ge-layer-mask-btn' +
        ((hasLassoSelInitial || hasWandSelInitial) ? ' from-selection' : '');
      maskBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12c4 0 4-4 8-4s4 4 8 4-4 4-8 4-4-4-8-4z" fill="currentColor"/></svg>';
      maskBtn.title = (hasLassoSelInitial || hasWandSelInitial)
        ? 'Make mask from current selection'
        : 'Add empty mask (paint with Brush)';
      maskBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 先激活此图层，使新遮罩附加到这里。
        state.activeLayerId = layer.id;
        // 在点击时重新检查选区状态 — 捕获的变量可能过期，
        // 如果选区在面板渲染后绘制。
        const hasLassoSel = state.lassoPoints.length >= 3 && !state.lassoActive;
        const hasWandSel = !!state.wandMask;
        if (hasLassoSel) {
          saveState(t('editor.mask_from_lasso', { name: layer.name }));
          // 为此转换强制创建新的遮罩子图层，使每个选区成为自己的遮罩，
          // 而非合并到先前的活动遮罩中。
          layer.activeMaskId = null;
          lassoToMask();
        } else if (hasWandSel) {
          saveState(t('editor.mask_from_wand', { name: layer.name }));
          layer.activeMaskId = null;
          wandToMask();
        } else {
          saveState(t('editor.add_mask', { name: layer.name }));
          const c = document.createElement('canvas');
          c.width = state.imgWidth;
          c.height = state.imgHeight;
          if (!layer.masks) layer.masks = [];
          const mask = {
            id: 'mask-' + (state.nextLayerId++),
            name: 'Mask ' + (layer.masks.length + 1),
            canvas: c,
            ctx: c.getContext('2d'),
            visible: true,
          };
          layer.masks.push(mask);
          layer.activeMaskId = mask.id;
          state.maskCanvas = mask.canvas;
          state.maskCtx = mask.ctx;
          composite();
          render();
        }
      });
      controls.appendChild(maskBtn);

      // 每行向下合并 — 将此图层烘焙到下方的图层中。
      // 在视觉堆栈的底层隐藏（idx 0 及之后）。
      if (i > 0) {
        const mergeDownBtn = document.createElement('button');
        mergeDownBtn.className = 'ge-layer-btn';
        mergeDownBtn.title = 'Merge down into layer below';
        mergeDownBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/></svg>';
        mergeDownBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          saveState(t('editor.merge_down', { name: layer.name }));
          mergeLayerDownAtIndex(i);
          composite();
          render();
          uiModule.showToast('Layer merged down');
        });
        controls.appendChild(mergeDownBtn);
      }

      // 删除 — 除最后一个图层外每个图层都显示。底图照片也可删除；
      // Ctrl+Z 可从历史记录恢复。底图层需要额外确认。
      if (state.layers.length > 1) {
        const delBtn = document.createElement('button');
        delBtn.className = 'ge-layer-btn danger';
        delBtn.textContent = '×';
        delBtn.title = layer.isBase ? 'Delete original layer (Ctrl+Z to undo)' : 'Delete layer';
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (layer.isBase && uiModule?.styledConfirm) {
            const ok = await uiModule.styledConfirm(
              'Delete the original photo layer? Ctrl+Z brings it back.',
              { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
            );
            if (!ok) return;
          }
          // 在删除之前拍摄快照，以便 Ctrl+Z 可恢复。
          saveState(t('editor.delete_layer', { name: layer.name }));
          state.layers.splice(i, 1);
          state.layerOffsets.delete(layer.id);
          if (state.activeLayerId === layer.id) {
            state.activeLayerId = state.layers[Math.min(i, state.layers.length - 1)].id;
          }
          composite();
          render();
        });
        controls.appendChild(delBtn);
      }

      item.appendChild(visBtn);
      item.appendChild(nameEl);
      item.appendChild(opSlider);
      item.appendChild(controls);

      item.addEventListener('click', () => {
        if (shouldIgnoreLayerTap()) return;
        state.activeLayerId = layer.id;
        // 点击父行使图层像素成为绘制目标（遮罩不再是目标）。
        // 遮罩子行保留在面板中；点击一个将其重新设为目标。
        layer.activeMaskId = null;
        state.maskCanvas = null;
        state.maskCtx = null;
        render();
        composite();
      });

      list.appendChild(item);

      // 调节子图层行，缩进在父行下方。
      if (layer.adjLayers && layer.adjLayers.length) {
        for (const adj of layer.adjLayers) {
          const sub = document.createElement('div');
          sub.className = 'ge-layer-item ge-adj-sub-item';
          sub.dataset.adjId = adj.id;
          const sVis = document.createElement('button');
          sVis.className = 'ge-layer-vis' + (adj.visible ? ' visible' : '');
          sVis.innerHTML = adj.visible ? EYE_OPEN_SM : EYE_OFF_SM;
          sVis.title = adj.visible ? 'Hide adjustment' : 'Show adjustment';
          sVis.addEventListener('click', (e) => {
            e.stopPropagation();
            adj.visible = !adj.visible;
            layer._adjFinalKey = null;
            composite();
            render();
          });
          const sName = document.createElement('span');
          sName.className = 'ge-layer-name ge-adj-sub-name';
          sName.innerHTML = `<span class="ge-adj-sub-icon">${ADJ_ICONS[adj.type] || ''}</span><span>${(adj.name || adjLayerLabel(adj.type)).replace(/[<>&]/g,'')}</span>`;
          const sOp = document.createElement('input');
          sOp.type = 'range';
          sOp.min = '0'; sOp.max = '100';
          sOp.value = Math.round(adj.opacity * 100);
          sOp.className = 'ge-layer-opacity';
          sOp.title = 'Adjustment opacity';
          sOp.addEventListener('input', () => {
            adj.opacity = parseInt(sOp.value, 10) / 100;
            layer._adjFinalKey = null;
            composite();
          });
          const sControls = document.createElement('div');
          sControls.className = 'ge-layer-controls';
          const mergeBtn = document.createElement('button');
          mergeBtn.className = 'ge-layer-btn';
          mergeBtn.title = 'Merge into layer (bake)';
          mergeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
          mergeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // 仅将此调节烘焙到 layer.canvas 中，然后移除它。
            saveState(t('editor.merge_adj', { type: adjLayerLabel(adj.type) }));
            const baked = applyAdjustment(layer.canvas, adj);
            layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
            layer.ctx.drawImage(baked, 0, 0);
            layer.adjLayers = layer.adjLayers.filter(x => x.id !== adj.id);
            layer._adjFinalKey = null;
            composite();
            render();
          });
          sControls.appendChild(mergeBtn);
          const delBtn = document.createElement('button');
          delBtn.className = 'ge-layer-btn danger';
          delBtn.textContent = '×';
          delBtn.title = 'Delete adjustment';
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            saveState(t('editor.delete_adj', { type: adjLayerLabel(adj.type) }));
            layer.adjLayers = layer.adjLayers.filter(x => x.id !== adj.id);
            layer._adjFinalKey = null;
            composite();
            render();
          });
          sControls.appendChild(delBtn);

          sub.appendChild(sVis);
          sub.appendChild(sName);
          sub.appendChild(sOp);
          sub.appendChild(sControls);
          // 单击子行（内联控件之外）重新打开调节弹出框，
          // 暂存此子图层的参数。
          sub.addEventListener('click', (e) => {
            if (shouldIgnoreLayerTap()) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (e.target.closest('.ge-layer-vis, .ge-layer-opacity, .ge-layer-btn')) return;
            if (!e.target.closest('.ge-adj-sub-name')) return;
            e.stopPropagation();
            editAdjLayer(layer, adj, sub);
          });
          list.appendChild(sub);
        }
      }

      // 遮罩子图层行。
      if (layer.masks && layer.masks.length) {
        for (let mi = 0; mi < layer.masks.length; mi++) {
          const mk = layer.masks[mi];
          const sub = document.createElement('div');
          sub.className = 'ge-layer-item ge-adj-sub-item ge-mask-sub-item' +
            (layer.activeMaskId === mk.id ? ' active' : '');
          sub.dataset.maskId = mk.id;
          const sVis = document.createElement('button');
          sVis.className = 'ge-layer-vis' + (mk.visible ? ' visible' : '');
          sVis.innerHTML = mk.visible ? EYE_OPEN_SM : EYE_OFF_SM;
          sVis.title = mk.visible ? 'Hide mask' : 'Show mask';
          sVis.addEventListener('click', (e) => {
            e.stopPropagation();
            mk.visible = !mk.visible;
            composite();
            render();
          });
          const sName = document.createElement('span');
          sName.className = 'ge-layer-name ge-adj-sub-name';
          const maskIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12c4 0 4-4 8-4s4 4 8 4-4 4-8 4-4-4-8-4z" fill="currentColor"/></svg>';
          const mkName = String(mk.name || 'Mask').replace(/[<>&]/g, '');
          const mkEmpty = isMaskCanvasEmpty(mk.canvas) ? ' <span style="opacity:0.55;">(empty)</span>' : '';
          sName.innerHTML = `<span class="ge-adj-sub-icon">${maskIcon}</span><span>${mkName}${mkEmpty}</span>`;
          const sControls = document.createElement('div');
          sControls.className = 'ge-layer-controls';
          // 向上合并 — 将此遮罩合并到上方的遮罩中（mi 较小的）。
          if (mi > 0) {
            const mergeBtn = document.createElement('button');
            mergeBtn.className = 'ge-layer-btn';
            mergeBtn.title = 'Merge into mask above';
            mergeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg>';
            mergeBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              const above = layer.masks[mi - 1];
              if (!above) return;
              saveState(t('editor.merge_mask', { mk: mk.name, above: above.name }));
              // Alpha 并集 — `source-over` 对完全不透明的白色遮罩已经实现了最大化；
              // 这也处理了部分 alpha。
              above.ctx.save();
              above.ctx.globalCompositeOperation = 'source-over';
              above.ctx.drawImage(mk.canvas, 0, 0);
              above.ctx.restore();
              layer.masks = layer.masks.filter(x => x.id !== mk.id);
              if (layer.activeMaskId === mk.id) layer.activeMaskId = above.id;
              const a = getActiveMaskLayer();
              if (a) { state.maskCanvas = a.canvas; state.maskCtx = a.ctx; }
              else   { state.maskCanvas = null;     state.maskCtx = null; }
              composite();
              render();
            });
            sControls.appendChild(mergeBtn);
          }
          const delBtn = document.createElement('button');
          delBtn.className = 'ge-layer-btn danger';
          delBtn.textContent = '×';
          delBtn.title = 'Delete mask';
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            saveState(t('editor.delete_mask', { name: mk.name }));
            layer.masks = layer.masks.filter(x => x.id !== mk.id);
            if (layer.activeMaskId === mk.id) {
              layer.activeMaskId = layer.masks[layer.masks.length - 1]?.id || null;
            }
            // 同步全局遮罩管道。
            const a = getActiveMaskLayer();
            if (a) { state.maskCanvas = a.canvas; state.maskCtx = a.ctx; }
            else   { state.maskCanvas = null;     state.maskCtx = null; }
            composite();
            render();
          });
          sControls.appendChild(delBtn);
          sub.appendChild(sVis);
          sub.appendChild(sName);
          sub.appendChild(sControls);
          sub.addEventListener('click', (e) => {
            if (e.target.closest('.ge-layer-vis, .ge-layer-btn')) return;
            e.stopPropagation();
            // 激活此遮罩：绘制/修复/生成目标。
            layer.activeMaskId = mk.id;
            state.activeLayerId = layer.id;
            state.maskCanvas = mk.canvas;
            state.maskCtx = mk.ctx;
            render();
            composite();
          });
          list.appendChild(sub);
        }
      }
    }

    // 连接共享的 dragSort 模块 — 将拖拽初始化限制在抓取手柄上，
    // 使行主体点击仍可激活。每次渲染都调用，因为 `enable()` 清理了
    // 以 instanceKey 为键的上一个实例。
    if (dragSortModule) {
      dragSortModule.enable('ge-layers-list', '.ge-layer-item', {
        instanceKey: 'ge-layers',
        handleSelector: '.ge-layer-drag',
        onReorder: (orderedItems) => {
          // DOM 从上到下 = 数组顺序的反向，因此新数组是 DOM 顺序的逆向。
          const byId = new Map(state.layers.map(l => [l.id, l]));
          const newLayers = orderedItems
            .map(el => byId.get(el.dataset.layerId))
            .filter(Boolean)
            .reverse();
          if (newLayers.length === state.layers.length) {
            state.layers = newLayers;
            saveState();
            composite();
          }
        },
      });
    }
  }

  return { render };
}
