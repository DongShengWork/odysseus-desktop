/**
 * 背景移除（rembg）+ 锐化连接 + 在最近一次 rembg 抠图上
 * 运行的实时边缘清理调节器。
 *
 *   rembg-run 按钮: 展平 + POST 到 /api/image/remove-bg，
 *     optional hint_mask if the user has a wand/lasso selection
 *     active. After the new layer lands, hides every previously-
 *     visible layer so the cutout reads cleanly, and binds the
 *     live-tuner to the new layer.
 *
 *   Live edge-cleanup tuner: snapshots the pristine cutout the
 *     moment it lands; subsequent feather/grow slider tweaks
 *     rebuild the layer's alpha from that snapshot WITHOUT
 *     re-running the model.
 *      - 膨胀 > 0 → 模糊快照 alpha，低阈值 (32) → 扩展。
 *      - 膨胀 < 0 → 模糊快照 alpha，高阈值 (200) → 收缩。
 *      - 羽化 > 0 → 模糊整个图层（alpha + RGB），
 *        edge softens AND the residual color fringe from the
 *        original background gets blurred away.
 *
 *   锐化: 小型滑块 + 按钮；仅通过 /api/image/sharpen
 *     调用 _applyImageTool。
 *
 *   buildSelectionHintMask: 纯工具函数 — 返回激活的魔棒
 *     或套索选区的 base64 PNG（无 data: 前缀），或 null。
 *     返回以便其他魔棒-rembg 调用点可以使用。
 *
 * @param {{
 *   applyImageTool:             (endpoint, payload, layerName, btn, opts?) => Promise<void>,
 *   openCookbookForDependency:  (pkg: string) => void,
 *   composite:                  () => void,
 *   renderLayerPanel:           () => void,
 *   uiModule:                   object,
 * }} deps
 *
 * @returns {{ buildSelectionHintMask: () => string | null }}
 */
import { state } from './state.js';

export function wireRembgAndSharpen({
  applyImageTool, openCookbookForDependency,
  composite, renderLayerPanel, uiModule,
}) {
  // ── 锐化 ──
  const sharpenPrev = document.getElementById('ge-sharpen-preview');
  if (sharpenPrev) sharpenPrev.style.opacity = '0.5';
  document.getElementById('ge-sharpen-amount')?.addEventListener('input', (e) => {
    document.getElementById('ge-sharpen-label').textContent = e.target.value + '%';
    if (sharpenPrev) sharpenPrev.style.opacity = (parseInt(e.target.value, 10) / 100).toFixed(2);
  });
  document.getElementById('ge-sharpen-run')?.addEventListener('click', () => {
    const amount = parseInt(document.getElementById('ge-sharpen-amount')?.value || '50');
    applyImageTool('/api/image/sharpen', { amount }, '已锐化', document.getElementById('ge-sharpen-run'));
  });

  // ── 背景移除 ──
  document.getElementById('ge-rembg-install-link')?.addEventListener('click', () => {
    openCookbookForDependency('rembg');
  });
  document.getElementById('ge-rembg-run')?.addEventListener('click', async () => {
    const payload = {};
    const hint = buildSelectionHintMask();
    if (hint) payload.hint_mask = hint;
    // 注意: edge_feather / edge_grow 在客户端应用，
    // 这样滑块可以重新调节抠图而无需重新运行模型。
    const btn = document.getElementById('ge-rembg-run');
    const before = state.layers.length;
    // 快照运行前哪些图层是可见的，以便知道
    // 成功抠图后需要隐藏哪些。
    const prevVisible = state.layers.filter(l => l.visible).map(l => l.id);
    await applyImageTool('/api/image/remove-bg', payload, '已移除背景', btn);
    // applyImageTool 在 fetch 后完成，但新图层在
    // img.onload 内添加（延迟一个 tick）。轮询最多 60 帧
    // (~1s) 等待新图层出现，然后再自动隐藏。
    let frames = 0;
    while (state.layers.length <= before && frames < 60) {
      await new Promise(r => requestAnimationFrame(r));
      frames++;
    }
    if (state.layers.length > before) {
      const newLayer = state.layers[state.layers.length - 1];
      bindRembgLiveTuner(newLayer);
      // 自动隐藏底层图层，让用户只看到抠图 —
      // 如果用户手动重新开启，眼睛图标会重新亮起。
      for (const layer of state.layers) {
        if (prevVisible.includes(layer.id) && layer.id !== newLayer.id) {
          layer.visible = false;
        }
      }
      composite();
      renderLayerPanel();
    }
    // 重置滑块，让新抠图从干净状态开始。
    const f = document.getElementById('ge-rembg-feather');
    const g = document.getElementById('ge-rembg-grow');
    if (f) { f.value = 0; document.getElementById('ge-rembg-feather-label').textContent = '0px'; syncRembgFeather(0); }
    if (g) { g.value = 0; document.getElementById('ge-rembg-grow-label').textContent = '0px'; syncRembgGrow(0); }
  });

  // ── Live edge-cleanup tuner ──
  // Snapshots the pristine cutout the moment it lands; slider tweaks
  // rebuild alpha from that snapshot.
  function bindRembgLiveTuner(layer) {
    if (!layer) return;
    const w = layer.canvas.width, h = layer.canvas.height;
    const snap = document.createElement('canvas');
    snap.width = w; snap.height = h;
    snap.getContext('2d').drawImage(layer.canvas, 0, 0);
    state.rembgLiveLayer = layer;
    state.rembgLiveSnap = snap;
    rembgApplyEdgeNow();  // 初始通过（0/0 时无操作）
  }
  let rembgRaf = null;
  function scheduleRembgApply() {
    if (rembgRaf) return;
    rembgRaf = requestAnimationFrame(() => { rembgRaf = null; rembgApplyEdgeNow(); });
  }
  function rembgApplyEdgeNow() {
    if (!state.rembgLiveLayer || !state.rembgLiveSnap) return;
    const feather = parseInt(document.getElementById('ge-rembg-feather')?.value || '0', 10);
    const grow = parseInt(document.getElementById('ge-rembg-grow')?.value || '0', 10);
    const layer = state.rembgLiveLayer;
    const snap = state.rembgLiveSnap;
    const w = snap.width, h = snap.height;
    const lctx = layer.ctx;

    // 1) 从原始抠图快照重新开始。
    lctx.clearRect(0, 0, w, h);
    lctx.drawImage(snap, 0, 0);

    // 2) 边缘 ±N — 通过模糊+阈值扩展/侵蚀 alpha:
    //      膨胀 > 0 → 低阈值 (32) → 光晕计为不透明 → 扩展。
    //      膨胀 < 0 → 高阈值 (200) → 仅实心内部 → 收缩。
    //    RGB 保留；仅替换 alpha。
    if (grow !== 0) {
      const blurC = document.createElement('canvas');
      blurC.width = w; blurC.height = h;
      const bctx = blurC.getContext('2d');
      bctx.filter = `blur(${Math.abs(grow)}px)`;
      bctx.drawImage(snap, 0, 0);
      bctx.filter = 'none';
      const blurred = bctx.getImageData(0, 0, w, h).data;
      const layerData = lctx.getImageData(0, 0, w, h);
      const out = layerData.data;
      const thr = grow > 0 ? 32 : 200;
      for (let i = 0; i < out.length; i += 4) {
        out[i + 3] = blurred[i + 3] >= thr ? 255 : 0;
      }
      lctx.putImageData(layerData, 0, 0);
    }

    // 3) 羽化柔化我们当前的任何边缘。模糊整个图层
    //    （alpha + RGB）— alpha 获得平滑衰减，RGB 在边缘
    //    获得轻微模糊，这实际上有助于隐藏原始背景
    //    残留的颜色晕。
    if (feather > 0) {
      const fC = document.createElement('canvas');
      fC.width = w; fC.height = h;
      const fctx = fC.getContext('2d');
      fctx.filter = `blur(${feather}px)`;
      fctx.drawImage(layer.canvas, 0, 0);
      fctx.filter = 'none';
      lctx.clearRect(0, 0, w, h);
      lctx.drawImage(fC, 0, 0);
    }
    composite();
  }

  // ── 滑块预览样本 + 连接 ──
  const rembgFeatherPrev = document.getElementById('ge-rembg-feather-preview');
  const rembgGrowPrev = document.getElementById('ge-rembg-grow-preview');
  function syncRembgFeather(v) {
    if (!rembgFeatherPrev) return;
    const inner = Math.max(0, 50 - v * 2.5);
    rembgFeatherPrev.style.background = `radial-gradient(circle, var(--fg) 0%, var(--fg) ${inner}%, transparent 75%)`;
  }
  function syncRembgGrow(v) {
    if (!rembgGrowPrev) return;
    // -10..+10 → 缩放 0.6..1.4，让样本可见地扩大/缩小。
    const s = 1 + v * 0.04;
    rembgGrowPrev.style.transform = `scale(${s})`;
    rembgGrowPrev.style.background = v < 0 ? 'color-mix(in srgb, var(--fg) 40%, transparent)' : 'var(--fg)';
  }
  syncRembgFeather(2);
  syncRembgGrow(0);
  document.getElementById('ge-rembg-feather')?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    document.getElementById('ge-rembg-feather-label').textContent = v + 'px';
    syncRembgFeather(v);
    scheduleRembgApply();
  });
  document.getElementById('ge-rembg-grow')?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    document.getElementById('ge-rembg-grow-label').textContent = (v >= 0 ? '+' : '') + v + 'px';
    syncRembgGrow(v);
    scheduleRembgApply();
  });

  // ── 选区提示蒙版构建器（此处 + wand-rembg 使用）──
  // 全图白色透明蒙版 PNG（base64，无 `data:` 前缀）
  // 对应当前激活的选区 — 优先魔棒，其次套索。
  // 如果两者都没有选区则返回 null。
  function buildSelectionHintMask() {
    const w = state.imgWidth, h = state.imgHeight;
    if (state.wandMask && state.wandLayerId) {
      const off = state.layerOffsets.get(state.wandLayerId) || { x: 0, y: 0 };
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(state.wandMask, off.x, off.y);
      return c.toDataURL('image/png').split(',')[1];
    }
    if (state.lassoPoints.length >= 3 && !state.lassoActive) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(state.lassoPoints[0].x, state.lassoPoints[0].y);
      for (let i = 1; i < state.lassoPoints.length; i++) {
        ctx.lineTo(state.lassoPoints[i].x, state.lassoPoints[i].y);
      }
      ctx.closePath();
      ctx.fill();
      return c.toDataURL('image/png').split(',')[1];
    }
    return null;
  }

  return { buildSelectionHintMask };
}
