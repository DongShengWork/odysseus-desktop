/**
 * Static markup for misc floating popups that live above the canvas.
 *
 * All pure DOM. Caller wires every ID via document.getElementById /
 * el.querySelector after appending.
 */

/** Keyboard-shortcuts popover. */
export function shortcutsPopupHTML() {
  return `
      <div id="ge-shortcuts-handle" style="display:flex;align-items:center;gap:6px;margin:-4px -6px 4px;padding:4px 6px;cursor:grab;user-select:none;touch-action:none;">
        <span style="display:inline-flex;flex-direction:column;gap:2px;margin-right:2px;opacity:0.35;">
          <span style="display:block;width:18px;height:2px;border-radius:1px;background:currentColor;"></span>
          <span style="display:block;width:18px;height:2px;border-radius:1px;background:currentColor;"></span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.8"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>
        <strong style="font-size:12px;letter-spacing:0.3px;">编辑器快捷键</strong>
        <span style="flex:1"></span>
        <button id="ge-shortcuts-close" class="ge-btn ge-btn-sm" style="padding:0 6px;height:20px;line-height:1;background:none;border:none;opacity:0.55;cursor:pointer;color:var(--fg);">✖</button>
      </div>
      <div class="ge-shortcuts-grid">
        <div class="ge-shortcuts-col">
          <h5>工具</h5>
          <div><kbd>V</kbd> 移动</div>
          <div><kbd>T</kbd> 变换</div>
          <div><kbd>B</kbd> 画笔</div>
          <div><kbd>E</kbd> 橡皮擦</div>
          <div><kbd>K</kbd> 克隆印章 <span style="opacity:0.5">(Alt+点击 = 设置采样源)</span></div>
          <div><kbd>L</kbd> 套索</div>
          <div><kbd>W</kbd> 魔棒</div>
          <div><kbd>M</kbd> 修复</div>
          <div><kbd>E</kbd> 橡皮擦</div>
          <div><kbd>C</kbd> 裁剪</div>
          <div><kbd>S</kbd> 锐化</div>
        </div>
        <div class="ge-shortcuts-col">
          <h5>编辑</h5>
          <div><kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销</div>
          <div><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 重做</div>
          <div><kbd>Ctrl</kbd>+<kbd>S</kbd> 保存</div>
          <div><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> 保存到画廊</div>
          <div><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> 新建图层</div>
          <div><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd> 自由变换</div>
          <div><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> 画布大小…</div>
        </div>
        <div class="ge-shortcuts-col">
          <h5>选区</h5>
          <div><kbd>Ctrl</kbd>+<kbd>A</kbd> 全选</div>
          <div><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> 取消选择</div>
          <div><kbd>Ctrl</kbd>+<kbd>C</kbd> 复制到图层</div>
          <div><kbd>Ctrl</kbd>+<kbd>X</kbd> 剪切套索</div>
          <div><kbd>Ctrl</kbd>+<kbd>D</kbd> 删除像素</div>
          <div><kbd>Esc</kbd> 取消选区 / 裁剪</div>
        </div>
        <div class="ge-shortcuts-col">
          <h5>画笔 / 蒙版</h5>
          <div><kbd>[</kbd> 画笔大小 −</div>
          <div><kbd>]</kbd> 画笔大小 +</div>
          <div>拖动容差滑块 → 魔棒实时重调</div>
        </div>
      </div>
      <div style="margin-top:8px;font-size:10px;opacity:0.5;text-align:center;">按 <kbd>?</kbd> 或点击键盘图标切换显示。</div>
    `;
}


/**
 * History panel — sidebar listing all undo entries.
 * @param {string} historyIcon  Inline SVG markup for the title icon.
 */
export function historyPanelHTML(historyIcon) {
  return `
    <div class="ge-history-head" data-history-drag>
      <span class="ge-adj-icon">${historyIcon}</span>
      <span class="ge-history-title">历史记录</span>
      <span class="ge-head-btns">
        <button class="ge-adj-min" type="button" title="最小化">&minus;</button>
      </span>
    </div>
    <div class="ge-history-list" id="ge-history-list"></div>
  `;
}


/**
 * Empty-canvas size-prompt modal — body markup (caller controls show /
 * hide and wires the Cancel / Create buttons).
 */
export function canvasSizePromptHTML() {
  return `
        <div class="modal-content ge-canvas-prompt">
          <div class="modal-header"><h4 id="ge-canvas-prompt-title">新建画布</h4></div>
          <div class="modal-body">
            <div class="ge-canvas-prompt-row">
              <label class="ge-canvas-prompt-field">
                <span>宽度</span>
                <input type="text" id="ge-canvas-prompt-w" inputmode="numeric" value="1024">
              </label>
              <span class="ge-canvas-prompt-x">×</span>
              <label class="ge-canvas-prompt-field">
                <span>高度</span>
                <input type="text" id="ge-canvas-prompt-h" inputmode="numeric" value="1024">
              </label>
            </div>
            <p class="ge-canvas-prompt-hint">像素，或在任一字段中输入比例如 3x5 / 16:9。</p>
          </div>
          <div class="modal-footer">
            <button class="confirm-btn confirm-btn-secondary" id="ge-canvas-prompt-cancel">取消</button>
            <button class="confirm-btn confirm-btn-primary" id="ge-canvas-prompt-ok">创建</button>
          </div>
        </div>`;
}
