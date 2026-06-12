/**
 * 各工具的笔画调节滑块（不透明度 / 流量 / 柔和度），
 * 适用于橡皮擦、画笔和克隆。三个部分共享相同的 UX：
 *
 *   - 不透明度滑块：写入 state，更新标签，淡入淡出预览色板的不透明度。
 *   - 流量滑块：写入 state，更新标签，淡入淡出色板的不透明度，
 *     并切换其边框样式（低流量 → 虚线，高流量 → 点线），用户可看到"密度"变化。
 *   - 柔和度滑块：写入 state，更新标签，调整色板上径向渐变内停止点，
 *     使其视觉效果从硬圆盘过渡到柔和衰减。
 *
 * 整个模块之前是三个几乎相同的 30 行代码副本；现在是一个
 * 接收工具前缀 + state 字段包的辅助函数。
 *
 * 用法：只需调用 wireStrokeToolSliders() — DOM ID 从
 * #ge-{eraser,brush,clone}-{opacity,flow,softness} 及其标签和预览色板静态连接。
 */
import { state } from './state.js';

/** 为一个笔画工具连接三个滑块。 */
function wireToolSliders(prefix, fields) {
  const opPrev   = document.getElementById(`ge-${prefix}-preview-opacity`);
  const flPrev   = document.getElementById(`ge-${prefix}-preview-flow`);
  const softPrev = document.getElementById(`ge-${prefix}-preview-softness`);

  document.getElementById(`ge-${prefix}-opacity`)?.addEventListener('input', (e) => {
    state[fields.opacity] = parseInt(e.target.value);
    document.getElementById(`ge-${prefix}-opacity-label`).textContent = state[fields.opacity] + '%';
    if (opPrev) opPrev.style.opacity = (state[fields.opacity] / 100).toFixed(2);
  });

  document.getElementById(`ge-${prefix}-flow`)?.addEventListener('input', (e) => {
    state[fields.flow] = parseInt(e.target.value);
    document.getElementById(`ge-${prefix}-flow-label`).textContent = state[fields.flow] + '%';
    // 低流量 → 点更少/更稀疏。通过切换虚线/点线边框样式和
    // 淡入淡出不透明度来循环点密度。
    if (flPrev) {
      const denseness = Math.max(1, Math.round(state[fields.flow] / 20));
      flPrev.style.borderStyle = denseness <= 2 ? 'dashed' : 'dotted';
      flPrev.style.opacity = (0.3 + (state[fields.flow] / 100) * 0.6).toFixed(2);
    }
  });

  document.getElementById(`ge-${prefix}-softness`)?.addEventListener('input', (e) => {
    state[fields.softness] = parseInt(e.target.value);
    document.getElementById(`ge-${prefix}-softness-label`).textContent = state[fields.softness] + '%';
    // 预览随柔和度增加从硬圆盘过渡到柔和径向渐变（CSS 已设置径向渐变 —
    // 只需调整内部实心半径来传达衰减效果）。
    if (softPrev) {
      const innerStop = Math.max(0, 60 - state[fields.softness] * 0.55);
      softPrev.style.background = `radial-gradient(circle, var(--fg) 0%, var(--fg) ${innerStop}%, transparent 90%)`;
    }
  });
}

export function wireStrokeToolSliders() {
  wireToolSliders('eraser', { opacity: 'eraserOpacity', flow: 'eraserFlow', softness: 'eraserSoftness' });
  wireToolSliders('brush',  { opacity: 'brushOpacity',  flow: 'brushFlow',  softness: 'brushSoftness'  });
  wireToolSliders('clone',  { opacity: 'cloneOpacity',  flow: 'cloneFlow',  softness: 'cloneSoftness'  });
}
