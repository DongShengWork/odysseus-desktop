/**
 * 编辑器实时预览弹窗共享的纯模糊渲染器。
 *
 * 每个导出匹配 `_applyLiveBlur` 在 galleryEditor.js 中期望的
 * `renderer(snap, params, dst)` 签名 — `snap` 是
 * 模糊前的快照画布，`params` 是滑块值对象，
 * `dst` 是绘制最终结果的 2D 上下文。无模块状态。
 */

/**
 * 使用边缘钳位采样的高斯模糊。
 *
 * Canvas 的 `filter: blur()` 会天真地与图像外部的
 * 透明像素混合，导致边框淡出。为了匹配 Photoshop 的
 * "边缘：钳位"高斯模糊，我们将源图像填充到更大的缓冲区上，
 * 边缘像素拉伸到边距中（4 条边带 + 4 个角），
 * 模糊填充后的缓冲区，然后仅将原始尺寸的中心区域复制回来。
 *
 * @param {HTMLCanvasElement} snap
 * @param {{ radius: number }} v
 * @param {CanvasRenderingContext2D} dst
 */
export function gaussianBlur(snap, v, dst) {
  if (!v.radius || v.radius <= 0) { dst.drawImage(snap, 0, 0); return; }
  const r = v.radius;
  const w = snap.width, h = snap.height;
  // 边距需要覆盖卷积核的有效范围 — 大多数
  // 引擎在约 2 倍半径内饱和。
  const m = Math.ceil(r * 2 + 4);
  const pad = document.createElement('canvas');
  pad.width = w + m * 2;
  pad.height = h + m * 2;
  const pctx = pad.getContext('2d');
  pctx.drawImage(snap, m, m);
  // 边缘条：使用源高度=1（或宽度=1）的 drawImage
  // 绘制到大小为 `m` 的目标区域，将边缘像素拉伸到
  // 边距中 — 效果等同于边缘钳位采样。
  pctx.drawImage(snap, 0, 0, w, 1, m, 0, w, m);
  pctx.drawImage(snap, 0, h - 1, w, 1, m, m + h, w, m);
  pctx.drawImage(snap, 0, 0, 1, h, 0, m, m, h);
  pctx.drawImage(snap, w - 1, 0, 1, h, m + w, m, m, h);
  // 角 — 将角像素拉伸为 m×m 块。
  pctx.drawImage(snap, 0, 0, 1, 1, 0, 0, m, m);
  pctx.drawImage(snap, w - 1, 0, 1, 1, m + w, 0, m, m);
  pctx.drawImage(snap, 0, h - 1, 1, 1, 0, m + h, m, m);
  pctx.drawImage(snap, w - 1, h - 1, 1, 1, m + w, m + h, m, m);
  // 模糊填充后的缓冲区并裁剪回原始尺寸的中心区域。
  const out = document.createElement('canvas');
  out.width = pad.width;
  out.height = pad.height;
  const octx = out.getContext('2d');
  octx.filter = `blur(${r}px)`;
  octx.drawImage(pad, 0, 0);
  octx.filter = 'none';
  dst.drawImage(out, m, m, w, h, 0, 0, w, h);
}


/**
 * 缩放模糊 — 从画布中心向外径向涂抹。16 份低透明度
 * 缩放副本近似于高斯缩放模糊。
 *
 * @param {HTMLCanvasElement} snap
 * @param {{ strength: number }} v
 * @param {CanvasRenderingContext2D} dst
 */
export function zoomBlur(snap, v, dst) {
  const w = snap.width, h = snap.height;
  const steps = 16;
  dst.drawImage(snap, 0, 0);
  dst.globalAlpha = 0.18;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const scale = 1 + (v.strength / 200) * t;
    const sw = w * scale, sh = h * scale;
    dst.drawImage(snap, (w - sw) / 2, (h - sh) / 2, sw, sh);
  }
  dst.globalAlpha = 1;
}


/**
 * 运动模糊 — 沿用户选择的角度方向涂抹。
 *
 * 每个偏移副本以 globalAlpha = 1/steps 渲染到离屏
 * 累加器上，使用 globalCompositeOperation = 'lighter'（相加），
 * 然后绘制到 `dst`。Lighter 将预乘的源像素加到目标上，
 * 因此 N 个各自贡献 snap.RGB/N 的副本求和得到 snap.RGB，
 * alpha 求和为 1。Source-over 混合会导致颜色洗褪，
 * 因为每个副本会混合到目标上而非累加到其中。
 * 使用累加器保持 `dst` 干净，即使在中途抛出异常也能保证。
 *
 * @param {HTMLCanvasElement} snap
 * @param {{ length: number, angle: number }} v
 * @param {CanvasRenderingContext2D} dst
 */
export function motionBlur(snap, v, dst) {
  const w = snap.width, h = snap.height;
  const rad = (v.angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // 步数 = 长度方向上每像素约一个样本，上限
  // 防止极长模糊导致性能下降。
  const steps = Math.max(4, Math.min(80, Math.round(v.length)));
  const acc = document.createElement('canvas');
  acc.width = w; acc.height = h;
  const actx = acc.getContext('2d');
  actx.globalCompositeOperation = 'lighter';
  actx.globalAlpha = 1 / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i / Math.max(1, steps - 1)) - 0.5;
    actx.drawImage(snap, dx * v.length * t, dy * v.length * t);
  }
  actx.globalCompositeOperation = 'source-over';
  actx.globalAlpha = 1;
  dst.drawImage(acc, 0, 0);
}
