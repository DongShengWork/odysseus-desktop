/**
 * 变换工具会话生命周期 + 浮动弹窗接线。
 *
 *   _startTransform        快照活动图层 + 打开弹窗
 *   _openTransformPopup    构建 W/H/旋转弹窗，连接输入
 *   _wireTransformDrag     标题栏拖拽，移动端 + 桌面端位置处理
 *   _reapplyTransform      从快照实时预览重新渲染
 *   _confirmTransform      提交 + 清除会话状态
 *   _cancelTransform       通过 undo() 恢复 + 清除会话状态
 *
 * 画布上的手柄拖拽交互（角点/旋转把手）位于
 * `editor/tools/transform-drag.js` — 那些交互会修改与弹窗输入
 * 相同的暂存 `state.transformPending*` 字段，
 * 因此两者通过 `_reapplyTransform()` 保持同步。
 *
 * @param {{
 *   activeLayer:           () => object | null,
 *   saveState:             (label?: string) => void,
 *   composite:             () => void,
 *   fitZoom:               () => void,
 *   drawTransformHandles:  () => void,
 *   showCanvasLoading:     (label: string) => void,
 *   hideCanvasLoading:     () => void,
 *   undo:                  () => void,
 *   uiModule:              object | null,
 * }} deps
 *
 * @returns {{
 *   startTransform, openTransformPopup, closeTransformPopup,
 *   reapplyTransform, confirmTransform, cancelTransform,
 * }}
 */
import { state } from '../state.js';
import {
  transformPopupHTML,
  attachSpinRepeat,
} from '../build/transform-popup.js';

export function createTransformSession({
  activeLayer, saveState, composite, fitZoom, drawTransformHandles,
  showCanvasLoading, hideCanvasLoading, undo, uiModule,
}) {
  function startTransform() {
    const layer = activeLayer();
    if (!layer || layer.locked) { uiModule.showToast('Select an unlocked layer'); return; }
    if (state.transformActive) { cancelTransform(); return; } // 切换关闭
    state.transformActive = true;
    state.transformLayer = layer;
    state.transformOrigW = layer.canvas.width;
    state.transformOrigH = layer.canvas.height;
    state.transformPendingW = state.transformOrigW;
    state.transformPendingH = state.transformOrigH;
    state.transformPendingRot = 0;
    state.transformPendingFlipH = false;
    state.transformPendingFlipV = false;
    // 对图层进行快照，这样每次按键时都可以从
    // 原始像素重新派生实时预览，而不是累积
    // 破坏性的编辑。
    state.transformOrigCanvas = document.createElement('canvas');
    state.transformOrigCanvas.width = state.transformOrigW;
    state.transformOrigCanvas.height = state.transformOrigH;
    state.transformOrigCanvas.getContext('2d').drawImage(layer.canvas, 0, 0);
    state.transformOrigOffset = { ...(state.layerOffsets.get(layer.id) || { x: 0, y: 0 }) };
    saveState();
    // 将画布适配到视口，使角点手柄可见 —
    // 否则，大于视口的图层会导致抓取
    // 标记在屏幕外。
    try { fitZoom(); } catch {}
    composite();
    drawTransformHandles();
    openTransformPopup();
  }

  function closeTransformPopup() {
    if (state.transformPopup) {
      try { state.transformPopup.remove(); } catch {}
      state.transformPopup = null;
    }
  }

  // 浮动变换弹窗 — 水平布局，可通过标题栏拖拽，
  // 默认锚定在右侧面板（图层面板区域）上方，
  // 这样就不会遮挡画布。让用户可以输入精确的 W/H/旋转值
  // 并通过负值翻转。
  function openTransformPopup() {
    closeTransformPopup();
    if (!state.container) return;
    const pop = document.createElement('div');
    pop.className = 'ge-transform-popup';
    pop.innerHTML = transformPopupHTML();
    state.container.appendChild(pop);
    state.transformPopup = pop;
    wireTransformDrag(pop);
    const wInput = pop.querySelector('#ge-transform-w');
    const hInput = pop.querySelector('#ge-transform-h');
    const rotInput = pop.querySelector('#ge-transform-rot');
    const aspectBtn = pop.querySelector('#ge-transform-aspect');
    wInput.value = String(state.transformOrigW);
    hInput.value = String(state.transformOrigH);
    rotInput.value = '0';
    aspectBtn.classList.toggle('active', state.transformAspectLock);
    aspectBtn.setAttribute('aria-pressed', state.transformAspectLock ? 'true' : 'false');

    // 宽高比锁定跟随模型：锁定启用时，一个字段
    // 是"主导"，另一个是只读 + 变暗。
    // 主导 = 最后用户输入的字段。切换
    // 锁定会释放跟随者。
    let driver = null;
    const applyAspectVisuals = () => {
      if (!state.transformAspectLock || !driver) {
        wInput.readOnly = false;
        hInput.readOnly = false;
        wInput.classList.remove('ge-transform-input-locked');
        hInput.classList.remove('ge-transform-input-locked');
        return;
      }
      const followerW = driver === 'h';
      const followerH = driver === 'w';
      wInput.readOnly = followerW;
      hInput.readOnly = followerH;
      wInput.classList.toggle('ge-transform-input-locked', followerW);
      hInput.classList.toggle('ge-transform-input-locked', followerH);
    };
    const refresh = () => {
      let w = parseInt(wInput.value, 10);
      let h = parseInt(hInput.value, 10);
      const rot = parseInt(rotInput.value, 10) || 0;
      state.transformPendingFlipH = w < 0;
      state.transformPendingFlipV = h < 0;
      w = Math.abs(w || state.transformOrigW);
      h = Math.abs(h || state.transformOrigH);
      state.transformPendingW = Math.max(1, w);
      state.transformPendingH = Math.max(1, h);
      state.transformPendingRot = rot;
      reapplyTransform();
    };
    wInput.addEventListener('input', () => {
      if (state.transformAspectLock) {
        driver = 'w';
        const w = parseInt(wInput.value, 10);
        if (!Number.isNaN(w) && state.transformOrigW > 0) {
          const sign = (parseInt(hInput.value, 10) || 1) < 0 ? -1 : 1;
          const newH = Math.round((Math.abs(w) / state.transformOrigW) * state.transformOrigH) * sign;
          hInput.value = String(newH);
        }
        applyAspectVisuals();
      }
      refresh();
    });
    hInput.addEventListener('input', () => {
      if (state.transformAspectLock) {
        driver = 'h';
        const h = parseInt(hInput.value, 10);
        if (!Number.isNaN(h) && state.transformOrigH > 0) {
          const sign = (parseInt(wInput.value, 10) || 1) < 0 ? -1 : 1;
          const newW = Math.round((Math.abs(h) / state.transformOrigH) * state.transformOrigW) * sign;
          wInput.value = String(newW);
        }
        applyAspectVisuals();
      }
      refresh();
    });
    rotInput.addEventListener('input', refresh);
    aspectBtn.addEventListener('click', () => {
      state.transformAspectLock = !state.transformAspectLock;
      aspectBtn.classList.toggle('active', state.transformAspectLock);
      aspectBtn.setAttribute('aria-pressed', state.transformAspectLock ? 'true' : 'false');
      // 在用户打破锁定的瞬间重置跟随者，
      // 使两个字段都可编辑；重新启用意味着"下次输入设置主导"。
      driver = null;
      applyAspectVisuals();
    });
    pop.querySelector('#ge-transform-apply').addEventListener('click', () => confirmTransform());
    pop.querySelector('#ge-transform-cancel').addEventListener('click', () => cancelTransform());
    pop.querySelector('#ge-transform-cancel-btn')?.addEventListener('click', () => cancelTransform());
    // 最小化 — 折叠主体，只显示标题栏。
    pop.querySelector('#ge-transform-min')?.addEventListener('click', (e) => {
      e.stopPropagation();
      pop.classList.toggle('ge-transform-popup-minimised');
    });
    // 快捷操作：通过正负号翻转 W/H，使重新应用管线
    // 获取新的方向。Rotate-90 将旋转值 ±90°。
    pop.querySelector('#ge-transform-flip-h')?.addEventListener('click', () => {
      const wIn = pop.querySelector('#ge-transform-w');
      const cur = parseInt(wIn.value, 10) || state.transformOrigW;
      wIn.value = String(-cur);
      wIn.dispatchEvent(new Event('input', { bubbles: true }));
    });
    pop.querySelector('#ge-transform-flip-v')?.addEventListener('click', () => {
      const hIn = pop.querySelector('#ge-transform-h');
      const cur = parseInt(hIn.value, 10) || state.transformOrigH;
      hIn.value = String(-cur);
      hIn.dispatchEvent(new Event('input', { bubbles: true }));
    });
    pop.querySelector('#ge-transform-rot-90')?.addEventListener('click', (e) => {
      const rIn = pop.querySelector('#ge-transform-rot');
      const cur = parseInt(rIn.value, 10) || 0;
      const delta = e.shiftKey ? -90 : 90;
      let next = cur + delta;
      while (next > 180) next -= 360;
      while (next <= -180) next += 360;
      rIn.value = String(next);
      // 大图片：旋转过程会阻塞 UI 约 0.5-2 秒。显示一个加载动画
      // 让用户看到有事情发生。rAF 将繁重的工作
      // 推迟到当前帧之后，使覆盖层先绘制。
      showCanvasLoading('Rotating…');
      requestAnimationFrame(() => {
        try { rIn.dispatchEvent(new Event('input', { bubbles: true })); }
        finally { hideCanvasLoading(); }
      });
    });
    attachSpinRepeat(pop);
  }

  // 变换弹窗的标题栏拖拽。默认位置：在
  // 右侧面板（图层面板区域）上方。移动端通过样式表固定，
  // 我们使用 setProperty 'important' 覆盖拖拽时的位置。
  function wireTransformDrag(pop) {
    const isMobile = window.matchMedia('(max-width: 820px)').matches;
    const defaultRight = 20;
    const defaultTop = 60;
    if (isMobile) {
      pop.style.setProperty('position', 'fixed', 'important');
    } else {
      pop.style.position = 'absolute';
      pop.style.right = defaultRight + 'px';
      pop.style.top = defaultTop + 'px';
      pop.style.left = 'auto';
    }
    const dragSource = pop.querySelector('[data-transform-drag]') || pop;
    let dragging = false;
    let startX = 0, startY = 0, originLeft = 0, originTop = 0;
    const NON_DRAG = 'input,button,select,textarea,a,[contenteditable]';

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
        pop.style.right = 'auto';
      }
    };

    const beginDrag = (clientX, clientY) => {
      dragging = true;
      const rect = pop.getBoundingClientRect();
      if (isMobile) {
        originLeft = rect.left;
        originTop = rect.top;
      } else {
        const parentRect = state.container.getBoundingClientRect();
        originLeft = rect.left - parentRect.left;
        originTop = rect.top - parentRect.top;
      }
      startX = clientX;
      startY = clientY;
      setPos(originLeft, originTop);
      pop.classList.add('ge-transform-popup-dragging');
      document.body.style.userSelect = 'none';
    };

    const moveDrag = (clientX, clientY) => {
      if (!dragging) return;
      const dx = clientX - startX;
      const dy = clientY - startY;
      let nx = originLeft + dx;
      let ny = originTop + dy;
      if (isMobile) {
        const rect = pop.getBoundingClientRect();
        nx = Math.max(0, Math.min(window.innerWidth - rect.width, nx));
        ny = Math.max(0, Math.min(window.innerHeight - rect.height, ny));
      }
      setPos(nx, ny);
    };

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      pop.classList.remove('ge-transform-popup-dragging');
    };

    dragSource.addEventListener('mousedown', (e) => {
      if (e.target.closest(NON_DRAG)) return;
      e.preventDefault();
      beginDrag(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
    document.addEventListener('mouseup', endDrag);

    dragSource.addEventListener('touchstart', (e) => {
      if (e.target.closest(NON_DRAG)) return;
      if (!e.touches || e.touches.length !== 1) return;
      e.preventDefault();
      beginDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    document.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      if (!e.touches || e.touches.length !== 1) return;
      e.preventDefault();
      moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    document.addEventListener('touchend', endDrag);
    document.addEventListener('touchcancel', endDrag);
  }

  // 从原始快照重新派生活动图层的像素，应用
  // 弹窗当前的 W/H/翻转/旋转值。成本低 —
  // 绘制到最终尺寸的离屏画布上。
  function reapplyTransform() {
    const layer = state.transformLayer;
    if (!layer || !state.transformOrigCanvas) return;
    const w = state.transformPendingW;
    const h = state.transformPendingH;
    const rotDeg = state.transformPendingRot;
    const rotRad = (rotDeg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rotRad));
    const sin = Math.abs(Math.sin(rotRad));
    // 旋转后 W×H 的边界框 — 画布扩大
    // 以防止角点被裁剪。
    const finalW = Math.max(1, Math.round(w * cos + h * sin));
    const finalH = Math.max(1, Math.round(w * sin + h * cos));
    const tmp = document.createElement('canvas');
    tmp.width = finalW; tmp.height = finalH;
    const tCtx = tmp.getContext('2d');
    tCtx.imageSmoothingEnabled = true;
    tCtx.imageSmoothingQuality = 'high';
    tCtx.save();
    tCtx.translate(finalW / 2, finalH / 2);
    if (rotDeg) tCtx.rotate(rotRad);
    tCtx.scale(state.transformPendingFlipH ? -1 : 1, state.transformPendingFlipV ? -1 : 1);
    tCtx.drawImage(state.transformOrigCanvas, -w / 2, -h / 2, w, h);
    tCtx.restore();
    layer.canvas.width = finalW;
    layer.canvas.height = finalH;
    layer.ctx.clearRect(0, 0, finalW, finalH);
    layer.ctx.drawImage(tmp, 0, 0);
    // 重新居中图层，使旋转轴在视觉上保持原位。
    const origCenterX = state.transformOrigOffset.x + state.transformOrigW / 2;
    const origCenterY = state.transformOrigOffset.y + state.transformOrigH / 2;
    state.layerOffsets.set(layer.id, {
      x: Math.round(origCenterX - finalW / 2),
      y: Math.round(origCenterY - finalH / 2),
    });
    composite();
    drawTransformHandles();
  }

  function confirmTransform() {
    closeTransformPopup();
    state.transformOrigCanvas = null;
    state.transformOrigOffset = null;
    state.transformActive = false;
    state.transformLayer = null;
    state.transformHandle = null;
    composite();
    uiModule.showToast('Transform applied');
  }

  function cancelTransform() {
    closeTransformPopup();
    state.transformOrigCanvas = null;
    state.transformOrigOffset = null;
    if (state.transformLayer) undo(); // 恢复保存的状态
    state.transformActive = false;
    state.transformLayer = null;
    state.transformHandle = null;
    composite();
  }

  return {
    startTransform, openTransformPopup, closeTransformPopup,
    reapplyTransform, confirmTransform, cancelTransform,
  };
}
