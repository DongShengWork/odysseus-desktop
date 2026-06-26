/**
 * 特效 / 调整弹窗机制 — 每个图层的亮度/对比度、
 * 色相/饱和度、色阶和色彩平衡编辑器。
 *
 * 自包含子系统，有三个外部接口：
 *
 *  - `composite()`         每次暂存更改后重绘画布
 *  - `saveState(label)`    应用时推送一个撤消条目
 *  - `renderLayerPanel()`  添加/编辑后刷新图层面板
 *
 * 生命周期：
 *
 *   图层行上的特效按钮 → openFxPopup(layer, anchor)
 *     → 小型选择器菜单（亮度/对比度、色相/饱和度、色阶、色彩平衡）
 *     → openAdjPopup(layer, type, anchor[, existingAdj])
 *       → buildAdjBody 渲染类型特定的滑块 + 直方图
 *       → 滑块 / 直方图手柄改变 `layer._stagedAdj.params`
 *       → composite() 通过 adjLayers 堆栈实时预览
 *       → 应用提交到 layer.adjLayers + saveState() + renderLayerPanel()
 *       → 取消 / Esc 丢弃暂存状态
 *
 * 弹窗可以最小化 → modalManager 停靠图标 → 点击图标
 * 恢复。重新打开已提交的子图层（从图层面板的
 * adj-row 点击）调用 `editAdjLayer`，重新打开 openAdjPopup
 * 并将现有子图层的参数暂存以供编辑。
 *
 * @param {{
 *   composite:        () => void,
 *   saveState:        (label?: string) => void,
 *   renderLayerPanel: () => void,
 * }} deps
 *
 * @returns {{
 *   openFxPopup, openAdjPopup, editAdjLayer,
 *   closeFxPopup, closeFxMenu, closeAdjPopup,
 *   ensureFxDock, ensureAdjustments,
 *   syncFxPanelToActiveLayerIfPresent,
 *   minimiseAdjPopup,
 * }}
 */
import { state } from '../state.js';
import modalManager from '../../modalManager.js';
import {
  ADJ_ICONS,
  adjLayerLabel,
  defaultAdjParams,
} from '../layer-helpers.js';
import { drawHistogram } from './histogram.js';

export function createAdjPopupSystem({ composite, saveState, renderLayerPanel }) {
  function suppressLayerGhostTap() {
    window.__geSuppressLayerTapUntil = Date.now() + 650;
  }

  function closeFxPopup() {
    if (state.fxPopupEl) {
      state.fxPopupEl.remove();
      state.fxPopupEl = null;
      state.fxPopupLayerId = null;
    }
  }

  function ensureAdjustments(layer) {
    // 旧版图层（从已保存的项目加载）可能缺少
    // 调整结构。用标识值填充。
    if (!layer.adjustments) layer.adjustments = {};
    const a = layer.adjustments;
    if (a.brightness === undefined) a.brightness = 1;
    if (a.contrast === undefined) a.contrast = 1;
    if (a.saturation === undefined) a.saturation = 1;
    if (a.hue === undefined) a.hue = 0;
    if (!a.levels) a.levels = { inBlack: 0, inWhite: 255, gamma: 1.0, outBlack: 0, outWhite: 255 };
    if (!a.colorBalance) a.colorBalance = {
      shadows: { r: 0, g: 0, b: 0 },
      midtones: { r: 0, g: 0, b: 0 },
      highlights: { r: 0, g: 0, b: 0 },
    };
    return a;
  }

  // 最小化特效弹窗的浮动停靠栏 — 位于右下角。
  function ensureFxDock() {
    let dock = document.getElementById('ge-fx-dock');
    if (!dock) {
      dock = document.createElement('div');
      dock.id = 'ge-fx-dock';
      document.body.appendChild(dock);
    }
    return dock;
  }

  function closeFxMenu() {
    if (state.fxMenuEl) {
      if (state.fxMenuEl._escHandler) {
        document.removeEventListener('keydown', state.fxMenuEl._escHandler, true);
      }
      if (state.fxMenuEl._awayHandler) {
        document.removeEventListener('pointerdown', state.fxMenuEl._awayHandler, true);
      }
      state.fxMenuEl.remove();
      state.fxMenuEl = null;
    }
    document.getElementById('ge-fx-menu-backdrop')?.remove();
  }

  function openFxPopup(layer, anchorEl) {
    // 仅当该图层的菜单确实在屏幕上时才切换关闭。
    // `state` 是一个共享单例，在编辑器关闭/重新打开后继续存在，
    // 因此之前会话中过期的 `fxMenuEl`（其分离的
    // 元素仍携带现已回收的 `_layerId`）曾导致
    // 此守卫触发并静默吞掉第一次点击。在视为"打开"之前
    // 验证元素仍在文档中。
    if (state.fxMenuEl && document.body.contains(state.fxMenuEl) &&
        state.fxMenuEl._layerId === layer.id) { closeFxMenu(); return; }
    closeFxMenu();
    if (!layer.adjLayers) layer.adjLayers = [];
    const backdrop = document.createElement('div');
    backdrop.id = 'ge-fx-menu-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:10001;background:transparent;pointer-events:auto;touch-action:none;';
    document.body.appendChild(backdrop);
    backdrop.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeFxMenu();
    }, true);
    backdrop.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    }, true);
    const menu = document.createElement('div');
    menu.className = 'ge-fx-menu ge-frosted';
    menu._layerId = layer.id;
    menu._ignoreActivationUntil = Date.now() + 350;
    menu.style.zIndex = '10002';
    menu.style.pointerEvents = 'auto';
    const items = [
      { type: 'brightness-contrast', label: 'Brightness / Contrast' },
      { type: 'hue-saturation',      label: 'Hue / Saturation' },
      { type: 'levels',              label: 'Levels' },
      { type: 'color-balance',       label: 'Color Balance' },
    ];
    menu.innerHTML = items.map(i =>
      `<button class="ge-fx-menu-item" data-fx-type="${i.type}"><span class="ge-fx-menu-icon">${ADJ_ICONS[i.type] || ''}</span><span>${i.label}</span></button>`
    ).join('');
    document.body.appendChild(menu);
    state.fxMenuEl = menu;
    const activateMenuItem = (btn, ev) => {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
      if (Date.now() < (menu._ignoreActivationUntil || 0)) return;
      if (!btn || btn.dataset.opening === '1') return;
      btn.dataset.opening = '1';
      const type = btn.dataset.fxType;
      closeFxMenu();
      openAdjPopup(layer, type, anchorEl);
    };
    menu.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
    }, true);
    menu.addEventListener('pointerup', (ev) => {
      const btn = ev.target.closest('.ge-fx-menu-item');
      if (btn) activateMenuItem(btn, ev);
      else ev.stopPropagation();
    }, true);
    menu.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.ge-fx-menu-item');
      if (btn) activateMenuItem(btn, ev);
      else ev.stopPropagation();
    }, true);

    const isMobile = window.matchMedia('(max-width: 820px)').matches;
    const r = isMobile ? null : anchorEl?.getBoundingClientRect?.();
    if (isMobile) {
      menu.style.left = '';
      menu.style.top = '';
      menu.style.right = '';
      menu.style.bottom = '';
    } else if (r) {
      const menuW = 220;
      const menuH = menu.offsetHeight || 200;
      const rightX = r.right + 4;
      const leftX  = r.left - menuW - 4;
      const fitsRight = rightX + menuW <= window.innerWidth - 8;
      let left = fitsRight ? rightX : Math.max(8, leftX);
      left = Math.min(window.innerWidth - menuW - 8, Math.max(8, left));
      menu.style.left = left + 'px';
      let top = r.top;
      if (top + menuH > window.innerHeight - 8) top = r.bottom - menuH;
      top = Math.min(window.innerHeight - menuH - 8, Math.max(8, top));
      menu.style.top = top + 'px';
    }
    menu.querySelectorAll('.ge-fx-menu-item').forEach(btn => {
      const activate = (ev) => {
        activateMenuItem(btn, ev);
      };
      btn.addEventListener('pointerup', activate);
      btn.addEventListener('click', activate);
    });
    // Esc 关闭菜单，捕获阶段 + stopPropagation 使
    // 图库模态框自己的 Esc 处理程序不会也触发。
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeFxMenu();
        document.removeEventListener('keydown', onKey, true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    menu._escHandler = onKey;
  }

  // 隐藏调整弹窗并在特效停靠栏中放置一个图标。点击图标
  // 将弹窗恢复到之前的位置，暂存状态
  // 保持不变（最小化时不清除暂存）。
  function minimiseAdjPopup(pop) {
    if (!pop) return;
    const type = pop._type;
    const r = pop.getBoundingClientRect();
    pop._stashLeft = r.left;
    pop._stashTop  = r.top;
    pop.style.display = 'none';
    if (state.adjPopupEl === pop) state.adjPopupEl = null;
    const popupId = pop._modalId || `ge-fx-popup-${Math.random().toString(36).slice(2, 8)}`;
    pop._modalId = popupId;
    modalManager.register(popupId, {
      label: adjLayerLabel(type),
      icon: ADJ_ICONS[type] || '',
      restoreFn: () => {
        pop.style.left = pop._stashLeft + 'px';
        pop.style.top  = pop._stashTop  + 'px';
        pop.style.display = '';
        if (state.adjPopupEl && state.adjPopupEl !== pop) {
          const other = state.adjPopupEl;
          state.adjPopupEl = other;
          closeAdjPopup();
        }
        state.adjPopupEl = pop;
      },
      closeFn: () => {
        state.adjPopupEl = pop;
        closeAdjPopup();
        modalManager.unregister(popupId);
      },
    });
    modalManager.minimize(popupId);
  }

  // 重新打开现有已提交的调整子图层进行编辑。
  // 预加载其参数作为暂存状态；应用时原地更新。
  function editAdjLayer(layer, adj, anchorEl) {
    openAdjPopup(layer, adj.type, anchorEl, adj);
  }

  function closeAdjPopup() {
    if (state.adjPopupEl) {
      suppressLayerGhostTap();
      const layer = state.adjPopupEl._layer;
      if (layer) {
        if (layer._stagedAdj) layer._stagedAdj = null;
        if (layer._editingAdjId) layer._editingAdjId = null;
        layer._adjFinalKey = null;
        composite();
      }
      if (state.adjPopupEl._escHandler) {
        document.removeEventListener('keydown', state.adjPopupEl._escHandler, true);
      }
      if (state.adjPopupEl._modalId) {
        try { modalManager.unregister(state.adjPopupEl._modalId); } catch {}
      }
      state.adjPopupEl.remove();
      state.adjPopupEl = null;
    }
  }

  function openAdjPopup(layer, type, anchorEl, existingAdj) {
    closeAdjPopup();
    // 编辑现有子图层？将其参数预加载为暂存
    // 预览，并标记弹窗使应用时更新而非追加。
    const editing = !!existingAdj;
    const startParams = editing
      ? JSON.parse(JSON.stringify(existingAdj.params))
      : defaultAdjParams(type);
    layer._stagedAdj = { type, params: startParams };
    if (editing) {
      // 将现有子图层从渲染堆栈中隐藏，使
      // 暂存预览正确显示而不加倍效果。
      layer._editingAdjId = existingAdj.id;
      layer._adjFinalKey = null;
    }
    const pop = document.createElement('div');
    pop.className = 'ge-adj-popup ge-frosted';
    pop.style.zIndex = '10003';
    pop._layer = layer;
    pop._type = type;
    pop._anchorEl = anchorEl;
    pop._existingAdj = existingAdj || null;
    pop.innerHTML = `
    <div class="ge-adj-head" data-adj-drag>
      <span class="ge-adj-icon">${ADJ_ICONS[type] || ''}</span>
      <span class="ge-adj-title">${adjLayerLabel(type)}</span>
      <span class="ge-head-btns">
        <button class="ge-adj-min" type="button" title="Minimise">&minus;</button>
      </span>
    </div>
    <div class="ge-adj-body" data-adj-body></div>
    <div class="ge-adj-foot">
      <button class="ge-btn ge-btn-sm ge-adj-cancel-btn" data-adj-action="cancel">Cancel</button>
      <button class="ge-btn ge-btn-sm ge-btn-primary ge-adj-apply-btn" data-adj-action="ok">Apply</button>
    </div>
    `;
    document.body.appendChild(pop);
    state.adjPopupEl = pop;

    const r = anchorEl?.getBoundingClientRect?.();
    const pw = type === 'color-balance' ? 340 : 320;
    // 优先放在锚点右侧；空间不足时回退到左侧。
    let left;
    if (r) {
      const rightX = r.right + 8;
      const leftX  = r.left - pw - 8;
      const fitsRight = rightX + pw <= window.innerWidth - 8;
      left = fitsRight ? rightX : Math.max(8, leftX);
    } else {
      left = (window.innerWidth - pw) / 2;
    }
    const top = r ? Math.max(8, r.top - 20) : 60;
    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';

    const body = pop.querySelector('[data-adj-body]');
    buildAdjBody(layer, type, body, pop);

    pop.querySelector('.ge-adj-close')?.addEventListener('click', closeAdjPopup);
    pop.querySelector('.ge-adj-min')?.addEventListener('click', () => minimiseAdjPopup(pop));
    // 通过标题栏拖动 — 除了按钮之外的任何地方。移动端通过 !important
    // 规则固定；在拖动期间使用 setProperty 和 'important' 让内联样式胜出。
    const head = pop.querySelector('[data-adj-drag]');
    if (head) {
      const isMobile = window.matchMedia('(max-width: 820px)').matches;
      const setPos = (x, y) => {
        if (isMobile) {
          pop.style.setProperty('left', x + 'px', 'important');
          pop.style.setProperty('top', y + 'px', 'important');
          pop.style.setProperty('right', 'auto', 'important');
          pop.style.setProperty('bottom', 'auto', 'important');
          pop.style.setProperty('width', 'auto', 'important');
          pop.style.setProperty('max-width', 'calc(100vw - 16px)', 'important');
        } else {
          pop.style.left = x + 'px';
          pop.style.top = y + 'px';
        }
      };
      head.style.touchAction = 'none';
      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        const r0 = pop.getBoundingClientRect();
        head.setPointerCapture(e.pointerId);
        head.style.cursor = 'grabbing';
        const onMove = (ev) => {
          const nx = Math.max(0, Math.min(window.innerWidth - 60, r0.left + (ev.clientX - startX)));
          const ny = Math.max(0, Math.min(window.innerHeight - 30, r0.top  + (ev.clientY - startY)));
          setPos(nx, ny);
        };
        const onUp = () => {
          head.releasePointerCapture(e.pointerId);
          head.style.cursor = '';
          head.removeEventListener('pointermove', onMove);
          head.removeEventListener('pointerup', onUp);
        };
        head.addEventListener('pointermove', onMove);
        head.addEventListener('pointerup', onUp);
      });
    }
    // Esc 关闭；捕获阶段 + stopPropagation 使图库模态框的
    // 自己的 Esc 处理程序不会也触发。
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeAdjPopup();
        document.removeEventListener('keydown', onKey, true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    pop._escHandler = onKey;
    pop.querySelector('[data-adj-action="cancel"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAdjPopup();
    });
    pop.querySelector('[data-adj-action="ok"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      suppressLayerGhostTap();
      saveState(editing ? `编辑 ${adjLayerLabel(type)}` : `添加 ${adjLayerLabel(type)}`);
      const params = layer._stagedAdj.params;
      layer._stagedAdj = null;
      if (editing) {
        const existing = (layer.adjLayers || []).find(a => a.id === existingAdj.id);
        if (existing) existing.params = params;
        layer._editingAdjId = null;
      } else {
        if (!layer.adjLayers) layer.adjLayers = [];
        layer.adjLayers.push({
          id: 'adj-' + Math.random().toString(36).slice(2, 9),
          type,
          name: adjLayerLabel(type),
          visible: true,
          opacity: 1,
          params,
        });
      }
      layer._adjFinalKey = null;
      composite();
      renderLayerPanel();
      closeAdjPopup();
    });
  }

  // 拖动滑块时进行 rAF 节流的实时预览。
  function scheduleAdjRefresh(layer) {
    if (state.adjRafPending) return;
    state.adjRafPending = true;
    requestAnimationFrame(() => {
      state.adjRafPending = false;
      layer._adjFinalKey = null;
      composite();
    });
  }

  function buildAdjBody(layer, type, body, popEl) {
    const p = layer._stagedAdj.params;
    const revertIcon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
    const sliderRow = (key, label, min, max, value, suffix) => `
      <div class="ge-adj-row" data-adj-key="${key}">
        <label>${label}</label>
        <input type="range" min="${min}" max="${max}" value="${value}" data-key="${key}" />
        <span class="ge-adj-value">${value}${suffix || ''}</span>
        <button class="ge-adj-revert" type="button" title="重置此滑块" data-revert-key="${key}">${revertIcon}</button>
      </div>
    `;
    if (type === 'brightness-contrast') {
      const bSlider = Math.round((p.brightness - 1) * 100);
      const cSlider = Math.round((p.contrast - 1) * 100);
      body.innerHTML = `
      ${sliderRow('brightness', t('editor.brightness'), -100, 100, bSlider, '')}
      ${sliderRow('contrast',   t('editor.contrast'),   -100, 100, cSlider, '')}
    `;
    } else if (type === 'hue-saturation') {
      const hSlider = Math.round(p.hue);
      const sSlider = Math.round((p.saturation - 1) * 100);
      body.innerHTML = `
      ${sliderRow('hue',        t('editor.hue'),        -180, 180, hSlider, ' °')}
      ${sliderRow('saturation', t('editor.saturation'), -100, 100, sSlider, '')}
    `;
    } else if (type === 'levels') {
      // 直方图画布 + 滑块。直方图是从
      // 图层的像素数据（在所有底层 adjLayers 之后）计算的，这样
      // 用户是根据实际看到的内容来匹配色阶。
      // <details> 包装器在移动端默认折叠以节约
      // 垂直空间；在桌面端默认展开。
      const isMobile = window.matchMedia('(max-width: 820px)').matches;
      body.innerHTML = `
      <details class="ge-adj-hist-details"${isMobile ? '' : ' open'}>
        <summary>直方图</summary>
        <div class="ge-adj-hist-wrap">
          <canvas class="ge-adj-histogram" width="280" height="80"></canvas>
          <div class="ge-adj-hist-handles">
            <div class="ge-adj-hist-handle hist-h-black"  data-handle="inBlack"  title="输入黑点 — 拖动"></div>
            <div class="ge-adj-hist-handle hist-h-gamma"  data-handle="gamma"    title="伽马 — 拖动"></div>
            <div class="ge-adj-hist-handle hist-h-white"  data-handle="inWhite"  title="输入白点 — 拖动"></div>
          </div>
        </div>
      </details>
      ${sliderRow('inBlack',  '输入黑点',  0, 254, p.inBlack, '')}
      ${sliderRow('inWhite',  '输入白点',  1, 255, p.inWhite, '')}
      ${sliderRow('gamma',    '伽马',        10, 990, Math.round((p.gamma || 1) * 100), 'γ')}
      ${sliderRow('outBlack', '输出黑点', 0, 255, p.outBlack, '')}
      ${sliderRow('outWhite', '输出白点', 0, 255, p.outWhite, '')}
    `;
      const hist = body.querySelector('.ge-adj-histogram');
      drawHistogram(hist, layer);
      wireHistogramHandles(body, layer, type);
      // 当用户打开折叠面板时重绘直方图（画布
      // 尺寸依赖布局）。
      body.querySelector('.ge-adj-hist-details')?.addEventListener('toggle', (e) => {
        if (e.target.open) drawHistogram(hist, layer);
      });
    } else if (type === 'color-balance') {
      // 带颜色的滑块端点，使用户看到每个方向的效果。
      const cbRow = (key, leftCol, rightCol, label, value) => `
      <div class="ge-adj-row ge-adj-cb-row" data-adj-key="${key}">
        <span class="ge-adj-cb-dot" style="background:${leftCol}"></span>
        <input type="range" min="-100" max="100" value="${value}" data-key="${key}" />
        <span class="ge-adj-cb-dot" style="background:${rightCol}"></span>
        <span class="ge-adj-value">${value}</span>
        <button class="ge-adj-revert" type="button" title="重置此滑块" data-revert-key="${key}">${revertIcon}</button>
      </div>
    `;
      // 色调选择器：一次显示一个色调组。记住
      // 弹窗上最后选择的色调，使重新渲染（恢复按钮
      // 等）保持选中状态。
      const tone = popEl._cbTone || 'shadows';
      popEl._cbTone = tone;
      const toneSliders = (t) => `
      ${cbRow(`${t}-r`, '#00d2d2', '#ff5555', '青 ↔ 红',      p[t].r)}
      ${cbRow(`${t}-g`, '#d855d8', '#55d855', '品红 ↔ 绿', p[t].g)}
      ${cbRow(`${t}-b`, '#e6e64a', '#4a78ff', '黄 ↔ 蓝',   p[t].b)}
    `;
      body.innerHTML = `
      <div class="ge-adj-cb-tone-picker">
        <select class="ge-adj-cb-tone-select">
          <option value="shadows"${tone === 'shadows' ? ' selected' : ''}>阴影</option>
          <option value="midtones"${tone === 'midtones' ? ' selected' : ''}>中间调</option>
          <option value="highlights"${tone === 'highlights' ? ' selected' : ''}>高光</option>
        </select>
      </div>
      <div class="ge-adj-cb-sliders" data-cb-tone="${tone}">
        ${toneSliders(tone)}
      </div>
    `;
      body.querySelector('.ge-adj-cb-tone-select')?.addEventListener('change', (e) => {
        popEl._cbTone = e.target.value;
        body.innerHTML = '';
        buildAdjBody(layer, type, body, popEl);
      });
    }
    // 绑定所有滑块。
    body.querySelectorAll('input[type="range"]').forEach(sl => {
      sl.addEventListener('input', () => onAdjSliderInput(layer, type, sl));
    });
    // 每个滑块的恢复按钮。
    body.querySelectorAll('.ge-adj-revert').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.revertKey;
        revertAdjKey(layer, type, key);
        // 重建主体使值和直方图刷新。
        body.innerHTML = '';
        buildAdjBody(layer, type, body, popEl);
      });
    });
  }

  // 将单个滑块键重置回标识值。更新暂存参数
  // 并触发合成刷新。
  function revertAdjKey(layer, type, key) {
    const defaults = defaultAdjParams(type);
    const p = layer._stagedAdj.params;
    if (type === 'brightness-contrast' || type === 'hue-saturation') {
      p[key] = defaults[key];
    } else if (type === 'levels') {
      p[key] = defaults[key];
    } else if (type === 'color-balance') {
      const [tone, ch] = key.split('-');
      p[tone][ch] = defaults[tone][ch];
    }
    layer._adjFinalKey = null;
    composite();
  }

  function onAdjSliderInput(layer, type, sl) {
    const key = sl.dataset.key;
    const raw = parseInt(sl.value, 10);
    const valEl = sl.parentElement.querySelector('.ge-adj-value');
    const p = layer._stagedAdj.params;
    let display = String(raw);
    if (type === 'brightness-contrast' || type === 'hue-saturation') {
      if (key === 'brightness' || key === 'contrast' || key === 'saturation') {
        p[key] = 1 + raw / 100;
      } else if (key === 'hue') {
        p.hue = raw; display = raw + ' °';
      }
    } else if (type === 'levels') {
      if (key === 'gamma') {
        p.gamma = raw / 100; display = (raw / 100).toFixed(2) + 'γ';
      } else {
        p[key] = raw;
      }
    } else if (type === 'color-balance') {
      const [tone, ch] = key.split('-');
      p[tone][ch] = raw;
    }
    if (valEl) valEl.textContent = display;
    scheduleAdjRefresh(layer);
  }

  // 根据当前暂存值定位三个直方图三角形手柄
  // + 绑定指针拖动。
  function wireHistogramHandles(bodyEl, layer, type) {
    const wrap = bodyEl.querySelector('.ge-adj-hist-wrap');
    const canvas = bodyEl.querySelector('.ge-adj-histogram');
    if (!wrap || !canvas) return;
    const handles = bodyEl.querySelectorAll('.ge-adj-hist-handle');
    const placeHandles = () => {
      const w = canvas.getBoundingClientRect().width;
      const p = layer._stagedAdj.params;
      const xB = (p.inBlack  / 255) * w;
      const xW = (p.inWhite  / 255) * w;
      // 伽马手柄位于 (xB..xW) 范围内，通过伽马的
      // 对数刻度映射（1 = 中点，0.1 = 最右，10 = 最左）。
      const gammaT = 1 - (Math.log(p.gamma || 1) / Math.log(10) * 0.5 + 0.5);
      const xG = xB + (xW - xB) * gammaT;
      const set = (sel, x) => {
        const el = bodyEl.querySelector(sel);
        if (el) el.style.left = (x - 6) + 'px';
      };
      set('.hist-h-black', xB);
      set('.hist-h-gamma', xG);
      set('.hist-h-white', xW);
    };
    placeHandles();
    handles.forEach(h => {
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        h.setPointerCapture(e.pointerId);
        const which = h.dataset.handle;
        const rect = canvas.getBoundingClientRect();
        const onMove = (ev) => {
          const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
          const v = Math.round((x / rect.width) * 255);
          const p = layer._stagedAdj.params;
          if (which === 'inBlack') {
            p.inBlack = Math.min(p.inWhite - 1, v);
          } else if (which === 'inWhite') {
            p.inWhite = Math.max(p.inBlack + 1, v);
          } else if (which === 'gamma') {
            const xB = (p.inBlack / 255) * rect.width;
            const xW = (p.inWhite / 255) * rect.width;
            const span = Math.max(1, xW - xB);
            let t = (x - xB) / span;
            t = Math.max(0.01, Math.min(0.99, t));
            // 反转 place处理 映射：t = 1 - (log10(g)*0.5+0.5)。
            const log10g = -((t - 0.5) * 2);
            p.gamma = Math.pow(10, log10g);
          }
          placeHandles();
          // 更新可见的滑块行 + 值标签。
          const updateRow = (key, displayVal) => {
            const sl = bodyEl.querySelector(`input[type="range"][data-key="${key}"]`);
            if (sl) sl.value = String(key === 'gamma' ? Math.round(layer._stagedAdj.params.gamma * 100) : layer._stagedAdj.params[key]);
            const val = sl?.parentElement.querySelector('.ge-adj-value');
            if (val) val.textContent = displayVal;
          };
          if (which === 'inBlack') updateRow('inBlack', String(layer._stagedAdj.params.inBlack));
          if (which === 'inWhite') updateRow('inWhite', String(layer._stagedAdj.params.inWhite));
          if (which === 'gamma')   updateRow('gamma',   layer._stagedAdj.params.gamma.toFixed(2) + 'γ');
          drawHistogram(canvas, layer);
          scheduleAdjRefresh(layer);
        };
        const onUp = () => {
          h.releasePointerCapture(e.pointerId);
          h.removeEventListener('pointermove', onMove);
          h.removeEventListener('pointerup', onUp);
        };
        h.addEventListener('pointermove', onMove);
        h.addEventListener('pointerup', onUp);
      });
    });
  }

  // 旧版侧边栏特效面板同步 — 特效现在位于每层的弹窗中；
  // 存根化使任何过时的调用方不会出错。
  function syncFxPanelToActiveLayerIfPresent() { /* 空操作 */ }

  return {
    openFxPopup, openAdjPopup, editAdjLayer,
    closeFxPopup, closeFxMenu, closeAdjPopup,
    ensureFxDock, ensureAdjustments,
    syncFxPanelToActiveLayerIfPresent,
    minimiseAdjPopup,
  };
}
