/**
 * 变换弹窗的静态标记，当用户激活调整大小/变换工具时，
 * 浮于画布之上。
 *
 * 纯 DOM——无模块状态，无事件监听器。调用方通过
 * document.getElementById / pop.querySelector 绑定所有 ID。
 *
 * @returns {string}
 */
export function transformPopupHTML() {
  return `
    <div class="ge-adj-head ge-transform-popup-head" data-transform-drag>
      <span class="ge-adj-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 7 7 3 11 7"/><line x1="7" y1="3" x2="7" y2="21"/><polyline points="21 17 17 21 13 17"/><line x1="17" y1="21" x2="17" y2="3"/></svg>
      </span>
      <span class="ge-adj-title">Transform</span>
      <button type="button" id="ge-transform-aspect" class="ge-transform-aspect-btn" title="Lock aspect ratio" aria-pressed="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      </button>
      <span class="ge-head-btns">
        <button class="ge-adj-min" type="button" title="Minimise" id="ge-transform-min">&minus;</button>
        <button class="ge-adj-close" type="button" title="Cancel" id="ge-transform-cancel">&times;</button>
      </span>
    </div>
    <div class="ge-transform-popup-body">
      <div class="ge-transform-field">
        <label>W</label>
        <input type="number" class="ge-transform-popup-input" id="ge-transform-w" step="1" />
        <span class="ge-transform-spin" data-spin-for="ge-transform-w">
          <button type="button" data-spin="down" tabindex="-1" aria-label="Decrease width">−</button>
          <button type="button" data-spin="up" tabindex="-1" aria-label="Increase width">+</button>
        </span>
      </div>
      <div class="ge-transform-field">
        <label>H</label>
        <input type="number" class="ge-transform-popup-input" id="ge-transform-h" step="1" />
        <span class="ge-transform-spin" data-spin-for="ge-transform-h">
          <button type="button" data-spin="down" tabindex="-1" aria-label="Decrease height">−</button>
          <button type="button" data-spin="up" tabindex="-1" aria-label="Increase height">+</button>
        </span>
      </div>
      <div class="ge-row-break"></div>
      <div class="ge-transform-field">
        <label>↻</label>
        <input type="number" class="ge-transform-popup-input ge-transform-popup-input-rot" id="ge-transform-rot" step="1" value="0" />
        <span class="ge-transform-spin" data-spin-for="ge-transform-rot">
          <button type="button" data-spin="down" tabindex="-1" aria-label="Rotate -1°">−</button>
          <button type="button" data-spin="up" tabindex="-1" aria-label="Rotate +1°">+</button>
        </span>
      </div>
      <button type="button" class="ge-btn ge-btn-sm" id="ge-transform-cancel-btn">Cancel</button>
      <button type="button" class="ge-btn ge-btn-sm ge-btn-primary" id="ge-transform-apply">Apply</button>
    </div>
    <p class="ge-transform-popup-hint">Type <strong>-</strong> before W / H to flip.</p>
  `;
}


/**
 * 将一个 `<span class="ge-transform-spin">…<button data-spin="up|down"/>…</span>`
 * 组合绑定点击递增 + 长按连续递增。1.5 秒后连续递增
 * 间隔从 70ms 加速到 30ms，使用户可以快速滚动
 * 数字字段而无需狂按按钮。
 *
 * 每次递增时，辅助函数根据 spin-group 的 `data-spin-for` 属性
 * 查找目标 `<input>` 并派发 `input` 事件，
 * 以便弹窗的其余绑定能拾取到变化。
 *
 * @param {HTMLElement} root   拥有一个或多个 spin group 的元素
 *                             （如变换弹窗）。
 */
export function attachSpinRepeat(root) {
  root.querySelectorAll('.ge-transform-spin button').forEach(btn => {
    const tick = (shift) => {
      const targetId = btn.parentElement?.dataset?.spinFor;
      if (!targetId) return;
      const input = root.querySelector('#' + CSS.escape(targetId));
      if (!input || input.readOnly) return;
      const step = shift ? 10 : 1;
      const cur = parseInt(input.value, 10) || 0;
      const next = btn.dataset.spin === 'up' ? cur + step : cur - step;
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    let holdTimeout = null, repeatInterval = null, started = 0;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      tick(e.shiftKey);
      started = Date.now();
      holdTimeout = setTimeout(() => {
        repeatInterval = setInterval(() => {
          tick(false);
          if (Date.now() - started > 1500 && repeatInterval) {
            clearInterval(repeatInterval);
            repeatInterval = setInterval(() => tick(false), 30);
          }
        }, 70);
      }, 350);
    });
    const endHold = () => {
      if (holdTimeout) clearTimeout(holdTimeout);
      if (repeatInterval) clearInterval(repeatInterval);
      holdTimeout = null; repeatInterval = null;
    };
    btn.addEventListener('pointerup', endHold);
    btn.addEventListener('pointerleave', endHold);
    btn.addEventListener('pointercancel', endHold);
  });
}
