/**
 * Build the editor's right-panel controls innerHTML.
 *
 * Returns the string — caller creates the wrapper element, attaches its
 * own touch / swipe-to-dismiss listeners, then sets innerHTML. Per-tool
 * sections are all toggled `display:none` here; the tool-switch handler
 * in galleryEditor.js shows the section matching the active tool.
 *
 * @param {{ color: string, brushSize: number, wandTolerance: number }} ctx
 * @returns {string}
 */
export function controlsHTML({ color, brushSize, wandTolerance }) {
  const brushSliderValue = Math.round(Math.log(Math.max(1, brushSize)) / Math.log(800) * 1000);
  return `
    <div id="ge-brush-controls">
      <div class="ge-control-row" id="ge-color-row">
        <label>颜色</label>
        <input type="color" class="ge-color-picker" value="${color}" />
      </div>
      <div class="ge-control-row">
        <label>大小 <span class="ge-size-label">${brushSize}px</span></label>
      <input type="range" class="ge-size-slider" min="0" max="1000" value="${brushSliderValue}" />
    </div>
    </div>
    <div class="ge-lasso-section" id="ge-lasso-section" style="display:none;">
      <div class="ge-control-row ge-eraser-row ge-sel-refine" id="ge-lasso-refine-feather" style="display:none;">
        <span class="ge-eraser-preview" id="ge-lasso-feather-preview" aria-hidden="true"></span>
        <label>羽化 <span id="ge-lasso-feather-label">0px</span></label>
        <input type="range" id="ge-lasso-feather" min="0" max="200" value="0" title="柔化选区边缘 — 羽化蒙版透明度。" />
      </div>
      <div class="ge-control-row ge-eraser-row ge-sel-refine" id="ge-lasso-refine-grow" style="display:none;">
        <span class="ge-eraser-preview" id="ge-lasso-grow-preview" aria-hidden="true"></span>
        <label>边缘描边 <span id="ge-lasso-grow-label">0px</span></label>
        <input type="range" id="ge-lasso-grow" min="-40" max="40" value="0" title="展开 (+) 或收缩 (−) 选区后再应用。" />
      </div>
      <div class="ge-control-row ge-actions" style="margin-top:4px;flex-wrap:wrap;">
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel" id="ge-lasso-invert" title="反转选区 (Ctrl+Alt+I)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          反选
        </button>
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel" id="ge-lasso-delete" title="从图层中删除选中的像素">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
          删除
        </button>
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel" id="ge-lasso-copy" title="复制选区到新图层">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          复制图层
        </button>
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel" id="ge-lasso-mask" title="转换选区为修复蒙版">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></svg>
          转蒙版
        </button>
      </div>
      <p style="font-size:9px;opacity:0.4;margin:4px 0 0;">绘制自由选区。按 Esc 取消。</p>
    </div>
    <div class="ge-wand-section" id="ge-wand-section" style="display:none;">
      <div class="ge-control-row" style="display:flex;gap:4px;margin-bottom:4px;" title="下一次点击与当前选区的合并方式。按住 Shift / Alt 点击可临时覆盖此设置。">
        <button type="button" class="ge-btn ge-btn-sm ge-wand-mode-btn active" data-wand-mode="replace" title="每次点击替换选区">新选</button>
        <button type="button" class="ge-btn ge-btn-sm ge-wand-mode-btn" data-wand-mode="add" title="添加到选区 (Shift)">+ 加选</button>
        <button type="button" class="ge-btn ge-btn-sm ge-wand-mode-btn" data-wand-mode="subtract" title="从选区中减去 (Alt)">− 减选</button>
      </div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-wand-tol-preview" aria-hidden="true"></span>
        <label>容差 <span id="ge-wand-tol-label">${wandTolerance}</span></label>
        <button type="button" class="ge-btn ge-btn-sm ge-wand-live-btn" id="ge-wand-live" title="拖动容差时实时调整选区" aria-pressed="false">实时</button>
        <input type="range" id="ge-wand-tolerance" min="0" max="100" value="${wandTolerance}" />
      </div>
      <div class="ge-control-row ge-eraser-row ge-sel-refine" id="ge-wand-refine-feather" style="display:none;">
        <span class="ge-eraser-preview" id="ge-wand-feather-preview" aria-hidden="true"></span>
        <label>羽化 <span id="ge-wand-feather-label">0px</span></label>
        <input type="range" id="ge-wand-feather" min="0" max="200" value="0" title="柔化选区边缘 — 羽化蒙版透明度。" />
      </div>
      <div class="ge-control-row ge-eraser-row ge-sel-refine" id="ge-wand-refine-grow" style="display:none;">
        <span class="ge-eraser-preview" id="ge-wand-grow-preview" aria-hidden="true"></span>
        <label>边缘描边 <span id="ge-wand-grow-label">0px</span></label>
        <input type="range" id="ge-wand-grow" min="-40" max="40" value="0" title="展开 (+) 或收缩 (−) 选区后再应用。" />
      </div>
      <div class="ge-control-row ge-actions" style="margin-top:4px;flex-wrap:wrap;">
        <button class="ge-btn ge-btn-sm ge-mask-vis-btn visible" id="ge-wand-vis" title="隐藏选区叠加层" aria-label="切换选区叠加层">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel" id="ge-wand-clear" title="清除选区">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
          清除
        </button>
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel" id="ge-wand-invert" title="反转选区 (Ctrl+Alt+I)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          反选
        </button>
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel" id="ge-wand-delete" title="从图层中删除选中的像素">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
          擦除
        </button>
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel" id="ge-wand-copy" title="复制选区到新图层">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          复制图层
        </button>
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel" id="ge-wand-mask" title="添加选区到修复蒙版">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></svg>
          转蒙版
        </button>
      </div>
      <p style="font-size:9px;opacity:0.4;margin:4px 0 0;">点击区域选择相似像素。Shift+点击增加，Alt+点击减少。Esc 清除选区。</p>
    </div>
    <div class="ge-inpaint-section" id="ge-inpaint-section" style="display:none;">
      <div class="ge-inpaint-popover-head" data-inpaint-drag>
        <div class="ge-section-title ge-section-title-with-help ge-inpaint-popover-title"><span>修复</span><span class="ge-section-help" tabindex="0" role="img" aria-label="修复功能说明" title="用画笔涂抹需要AI重新绘制的区域 — 红色预览表示蒙版区域。使用 Paint 添加，Erase 减去（或按住 Ctrl+Alt 临时切换）。Generate 按提示词填充；Remove 用周围背景填充。">?</span></div>
        <button class="ge-inpaint-popover-close" id="ge-inpaint-popover-close" type="button" title="关闭修复面板" aria-label="关闭修复面板">&times;</button>
      </div>
      <div class="ge-section-title ge-section-title-with-help"><span>修复</span><span class="ge-section-help" tabindex="0" role="img" aria-label="修复功能说明" title="用画笔涂抹需要AI重新绘制的区域 — 红色预览表示蒙版区域。使用 Paint 添加，Erase 减去（或按住 Ctrl+Alt 临时切换）。Generate 按提示词填充；Remove 用周围背景填充。">?</span></div>
      <p class="ge-section-hint" style="margin-top:0;">
        在选中的蒙版上生成或移除内容。先生成前设置 <strong>强度</strong>，生成后调整 <strong>边缘羽化 / 描边</strong>。
      </p>
      <div class="ge-section-title" style="margin-top:8px;display:flex;align-items:center;gap:6px;">
        <span>蒙版画笔</span>
        <input type="color" class="ge-color-picker ge-inpaint-mask-color" value="#ff6e6e" title="蒙版叠加颜色 — 仅用于视觉显示，模型实际使用硬蒙版。" />
      </div>
      <div class="ge-control-row" style="display:flex;gap:4px;margin-bottom:4px;" title="按住 Ctrl+Alt 可临时切换绘制/擦除模式。">
        <button type="button" class="ge-btn ge-btn-sm ge-inpaint-mode-btn active" id="ge-inpaint-mode-paint" style="flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></svg>
          绘制
        </button>
        <button type="button" class="ge-btn ge-btn-sm ge-inpaint-mode-btn" id="ge-inpaint-mode-erase" style="flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.4 14.6 14.6 19.4a2 2 0 0 1-2.83 0L4.6 12.23a2 2 0 0 1 0-2.83l7.17-7.17a2 2 0 0 1 2.83 0l4.8 4.8a2 2 0 0 1 0 2.83Z"/><line x1="22" y1="21" x2="7" y2="21"/><line x1="14" y1="3" x2="9" y2="8"/></svg>
          擦除
        </button>
      </div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-inpaint-brush-preview" aria-hidden="true"></span>
        <label>蒙版画笔大小 <span id="ge-inpaint-brush-label">${brushSize}px</span></label>
        <input type="range" id="ge-inpaint-brush-slider" min="0" max="1000" value="${brushSliderValue}" title="画笔直径（对数刻度 1→800px）。使用 [ 和 ] 增减10%。" />
      </div>
      <div class="ge-control-row ge-actions ge-inpaint-mask-row" style="margin-top:4px;">
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel ge-mask-vis-btn visible" id="ge-mask-vis" title="隐藏蒙版">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          <span id="ge-mask-vis-label">隐藏</span>
        </button>
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel" id="ge-inpaint-invert" title="反转蒙版">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          反选
        </button>
        <button class="ge-btn ge-btn-sm ge-btn-iconlabel" id="ge-inpaint-clear" title="清除蒙版">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
          清除
        </button>
      </div>
      <hr class="ge-section-divider" />
      <div class="ge-section-title" style="margin-top:8px;"><span>提示词</span></div>
      <input type="text" class="ge-inpaint-prompt" id="ge-inpaint-prompt" placeholder="描述蒙版区域要填充的内容..." />
      <div class="ge-control-row ge-inpaint-model-row" style="margin-top:6px;">
        <label for="ge-ai-inpaint">模型</label>
        <select id="ge-ai-inpaint" class="ge-ai-model" title="修复模型">
          <option value="">自动</option>
          <option value="" disabled>──────────</option>
          <option value="__serve_cookbook__">+ 在 Cookbook 中运行模型…</option>
        </select>
      </div>
      <div class="ge-control-row ge-eraser-row" style="margin-top:6px;">
        <span class="ge-eraser-preview" id="ge-strength-preview" aria-hidden="true"></span>
        <label>强度 <span id="ge-strength-label">0.75</span><span class="ge-section-help" tabindex="0" role="img" aria-label="强度说明" title="AI 在蒙版内重新绘制的程度。0 = 不变 · 1 = 完全按提示词重新生成。建议：0.9–1.0 用于添加/替换物体，0.6–0.8 用于改变材质或颜色，0.3–0.5 用于细微修饰。默认 0.75 适用于大多数编辑。">?</span></label>
        <input type="range" id="ge-strength-slider" min="10" max="100" value="75" title="AI 在蒙版内重新绘制的程度（0 = 不变，1 = 完全扩散生成）。" />
      </div>
      <div class="ge-control-row ge-actions" style="margin-top:6px;display:flex;gap:6px;align-items:center;min-width:0;">
        <button class="ge-btn ge-btn-primary ge-btn-ai" id="ge-inpaint-run" style="flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:6px;" title="按提示词填充蒙版区域。">
          <span class="ge-btn-ai-mark" aria-hidden="true">✦</span>
          <span id="ge-inpaint-run-label">生成</span>
        </button>
        <button class="ge-btn ge-btn-ai" id="ge-inpaint-remove" style="flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:6px;" title="擦除蒙版内容并用周围背景填充。忽略提示词。">
          <span class="ge-btn-ai-mark" aria-hidden="true">✦</span>
          <span id="ge-inpaint-remove-label">移除</span>
        </button>
        <button class="ge-btn ge-btn-ai" id="ge-inpaint-outpaint" style="flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:6px;" title="填充画布的空白（透明）区域，生成与现有图像融合的 AI 内容。忽略画笔蒙版。">
          <span class="ge-btn-ai-mark" aria-hidden="true">✦</span>
          <span id="ge-inpaint-outpaint-label">扩展</span>
        </button>
      </div>
      <hr class="ge-section-divider" id="ge-inpaint-postedge-divider" style="margin-top:14px;" />
      <div class="ge-section-title ge-section-title-with-help" id="ge-inpaint-postedge-title"><span>后期处理</span><span class="ge-section-help" tabindex="0" role="img" aria-label="功能说明" title="对上一个修复结果图层进行实时边缘修剪。边缘羽化柔化透明度边界；边缘描边展开(+)或收缩(−)可见边缘到 AI 生成的缓冲区。">?</span></div>
      <p class="ge-section-hint" id="ge-inpaint-postedge-hint" style="margin-top:0;opacity:0.45;">
        生成后可用。
      </p>
      <div class="ge-control-row ge-eraser-row" id="ge-inpaint-postfeather-row" style="display:none;">
        <span class="ge-eraser-preview" id="ge-feather-preview" aria-hidden="true"></span>
        <label>边缘羽化 <span id="ge-feather-label">0px</span></label>
        <input type="range" id="ge-feather-slider" min="0" max="200" value="0" title="模糊修复结果的透明度边缘 — 拖动以使 AI 填充与周围图像融合。实时更新。" />
      </div>
      <div class="ge-control-row ge-eraser-row" id="ge-inpaint-edgestroke-row" style="display:none;">
        <span class="ge-eraser-preview" id="ge-edgestroke-preview" aria-hidden="true"></span>
        <label>边缘描边 <span id="ge-edgestroke-label">0px</span></label>
        <input type="range" id="ge-edgestroke-slider" min="-80" max="80" value="0" title="在羽化前展开 (+) 或收缩 (−) 修复图层的边缘。使用 AI 在画笔周围生成的缓冲区。" />
      </div>
    </div>
    <div class="ge-eraser-section" id="ge-clone-section" style="display:none;">
      <div class="ge-section-title ge-section-title-with-help"><span>克隆</span><span class="ge-section-help" tabindex="0" role="img" aria-label="克隆工具说明" title="Alt+点击（桌面端）或双击（移动端）画布某处设置采样源。然后在其他位置拖动将像素克隆到当前图层。采样点随画笔移动，偏移量保持不变。大小/不透明度/流量/软度来自画笔面板。">?</span></div>
      <p class="ge-section-hint" style="margin-top:0;">
        <strong class="ge-clone-hint-desktop">Alt+点击</strong><strong class="ge-clone-hint-mobile">双击</strong> 设置采样源 · 拖动绘制
      </p>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-clone-preview-opacity" aria-hidden="true"></span>
        <label>不透明度 <span id="ge-clone-opacity-label">100%</span></label>
        <input type="range" id="ge-clone-opacity" min="10" max="100" value="100" />
      </div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-clone-preview-flow" aria-hidden="true"></span>
        <label>流量 <span id="ge-clone-flow-label">100%</span></label>
        <input type="range" id="ge-clone-flow" min="5" max="100" value="100" />
      </div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-clone-preview-softness" aria-hidden="true"></span>
        <label>软度 <span id="ge-clone-softness-label">100%</span></label>
        <input type="range" id="ge-clone-softness" min="0" max="300" value="100" title="软画笔边缘 — 模糊每次采样以实现羽化淡出效果。" />
      </div>
    </div>
    <div class="ge-eraser-section" id="ge-brush-section" style="display:none;">
      <div class="ge-section-title">画笔</div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-brush-preview-opacity" aria-hidden="true"></span>
        <label>不透明度 <span id="ge-brush-opacity-label">100%</span></label>
        <input type="range" id="ge-brush-opacity" min="10" max="100" value="100" />
      </div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-brush-preview-flow" aria-hidden="true"></span>
        <label>流量 <span id="ge-brush-flow-label">100%</span></label>
        <input type="range" id="ge-brush-flow" min="5" max="100" value="100" />
      </div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-brush-preview-softness" aria-hidden="true"></span>
        <label>软度 <span id="ge-brush-softness-label">100%</span></label>
        <input type="range" id="ge-brush-softness" min="0" max="300" value="100" title="软画笔边缘 — 模糊笔触透明度以实现边缘羽化淡出效果。" />
      </div>
    </div>
    <div class="ge-eraser-section" id="ge-eraser-section" style="display:none;">
      <div class="ge-section-title">橡皮擦</div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-eraser-preview-opacity" aria-hidden="true"></span>
        <label>不透明度 <span id="ge-eraser-opacity-label">100%</span></label>
        <input type="range" id="ge-eraser-opacity" min="10" max="100" value="100" />
      </div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-eraser-preview-flow" aria-hidden="true"></span>
        <label>流量 <span id="ge-eraser-flow-label">100%</span></label>
        <input type="range" id="ge-eraser-flow" min="5" max="100" value="100" />
      </div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-eraser-preview-softness" aria-hidden="true"></span>
        <label>软度 <span id="ge-eraser-softness-label">100%</span></label>
        <input type="range" id="ge-eraser-softness" min="0" max="300" value="100" title="软橡皮擦边缘 — 模糊笔触透明度以实现边缘淡出效果。" />
      </div>
    </div>
    <div class="ge-sharpen-section" id="ge-sharpen-section" style="display:none;">
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-sharpen-preview" aria-hidden="true"></span>
        <label>强度 <span id="ge-sharpen-label">50%</span></label>
        <input type="range" id="ge-sharpen-amount" min="10" max="100" value="50" />
      </div>
      <div class="ge-control-row ge-actions" style="margin-top:4px;">
        <button class="ge-btn ge-btn-primary" id="ge-sharpen-run">锐化</button>
      </div>
    </div>
    <div class="ge-rembg-section" id="ge-rembg-section" style="display:none;">
      <div class="ge-section-title ge-section-title-with-help"><span>背景移除</span><span class="ge-section-help" tabindex="0" role="img" aria-label="功能说明" title="运行 ML 模型，保留它学习到的前景（通常是人、产品或动物）。如果有套索或魔棒选区，它将作为提示 — 模型仅在选区内查找，选区外的内容强制透明。">?</span></div>
      <div class="ge-dep-notice" id="ge-rembg-dep-missing" style="display:none;">
        <div class="ge-dep-notice-text">
          <strong>rembg 未安装。</strong>
          背景移除需要服务器上的 <code>rembg</code> 包。
          点击通过 Cookbook → 依赖项进行安装。
        </div>
        <button type="button" class="ge-btn ge-btn-sm" id="ge-rembg-install-link">安装 rembg</button>
      </div>
      <div class="ge-control-row ge-actions" id="ge-rembg-run-row">
        <button class="ge-btn ge-btn-primary ge-btn-ai" id="ge-rembg-run">
          <span class="ge-btn-ai-mark" aria-hidden="true">✦</span>
          去背景
        </button>
      </div>
      <hr class="ge-section-divider" />
      <div class="ge-section-title ge-section-title-with-help"><span>边缘清理</span><span class="ge-section-help" tabindex="0" role="img" aria-label="功能说明" title="实时应用于最近一个去背景图层。羽化柔化边缘；边缘向内(−)或向外(+)微调。">?</span></div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-rembg-feather-preview" aria-hidden="true"></span>
        <label>羽化 <span id="ge-rembg-feather-label">0px</span></label>
        <input type="range" id="ge-rembg-feather" min="0" max="20" value="0" />
      </div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-rembg-grow-preview" aria-hidden="true"></span>
        <label>边缘 <span id="ge-rembg-grow-label">0px</span></label>
        <input type="range" id="ge-rembg-grow" min="-10" max="10" value="0" />
      </div>
    </div>
    <div class="ge-import-section" id="ge-import-section" style="display:none;">
      <p style="font-size:10px;opacity:0.5;margin:0 0 6px;">导入图片作为新图层。拖动以定位。</p>
      <div class="ge-control-row ge-actions">
        <button class="ge-btn" id="ge-import-file">文件</button>
        <button class="ge-btn" id="ge-import-paste">剪贴板</button>
        <button class="ge-btn" id="ge-import-gallery">画廊</button>
      </div>
    </div>
    <div class="ge-harmonize-section" id="ge-harmonize-section" style="display:none;">
      <div class="ge-section-title">协调 <span class="ge-section-help" tabindex="0" role="img" title="将粘贴的图层融合到底层照片中。颜色匹配调整图层的亮度/色调以匹配周围环境（不重新绘制像素）。接缝修复使用 inpaint 清理锯齿状的裁剪边缘（需要自托管的 img2img/inpaint 模型）。">?</span></div>
      <div class="ge-control-row ge-tool-model-row">
        <label>模型</label>
        <select class="ge-tool-model" data-ge-tool-model="harmonize" title="协调模型">
          <option value="">自动</option>
        </select>
      </div>
      <div class="ge-control-row">
        <label style="font-size:11px;opacity:0.6;">提示词（仅在接缝修复 > 0 时使用）</label>
      </div>
      <input type="text" class="ge-inpaint-prompt" id="ge-harmonize-prompt" placeholder="照片真实感，自然光照，无缝融合..." />
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-harmonize-color-preview" aria-hidden="true"></span>
        <label>颜色匹配 <span id="ge-harmonize-color-label">0.65</span></label>
        <input type="range" id="ge-harmonize-color" min="0" max="100" value="65" title="Reinhard 颜色/亮度偏移的应用程度。0 = 不变，1 = 完全匹配周围环境。" />
      </div>
      <div class="ge-control-row ge-eraser-row">
        <span class="ge-eraser-preview" id="ge-harmonize-seam-preview" aria-hidden="true"></span>
        <label>接缝修复 <span id="ge-harmonize-seam-label">0.00</span></label>
        <input type="range" id="ge-harmonize-seam" min="0" max="100" value="0" title="透明度边缘区域窄带 inpaint 的强度。0 = 关闭，1 = 边界最大融合。" />
      </div>
      <div class="ge-control-row ge-actions" style="margin-top:4px;">
        <button class="ge-btn ge-btn-primary" id="ge-harmonize-run">协调</button>
      </div>
    </div>
    <div class="ge-style-section" id="ge-style-section" style="display:none;">
      <p style="font-size:10px;opacity:0.5;margin:0 0 6px;">使用 img2img 将艺术风格应用于图像。需要运行中的扩散模型。</p>
      <div class="ge-control-row ge-tool-model-row">
        <label>模型</label>
        <select class="ge-tool-model" data-ge-tool-model="style" title="风格迁移模型">
          <option value="">自动</option>
        </select>
      </div>
      <div class="ge-control-row">
        <label style="font-size:11px;opacity:0.6;">风格提示词</label>
      </div>
      <input type="text" class="ge-inpaint-prompt" id="ge-style-prompt" placeholder="油画，印象派，梵高风格..." />
      <div class="ge-control-row">
        <label style="font-size:11px;opacity:0.6;">强度 <span id="ge-style-strength-label">0.55</span></label>
        <input type="range" id="ge-style-strength" min="10" max="90" value="55" style="flex:1;" />
      </div>
      <div class="ge-control-row ge-actions" style="margin-top:4px;">
        <button class="ge-btn ge-btn-primary" id="ge-style-run">应用风格</button>
      </div>
    </div>
  `;
}


/**
 * Layer-panel header markup. Static; static IDs are wired by the caller.
 * @returns {string}
 */
export function layerPanelHTML() {
  return `<div class="ge-layers-header">
      <span class="ge-layers-grab"></span>
      <span class="ge-layers-title">图层</span>
      <button class="ge-btn ge-btn-sm ge-icon-btn" id="ge-merge-down" title="向下合并" aria-label="向下合并">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/></svg>
      </button>
      <button class="ge-btn ge-btn-sm ge-icon-btn" id="ge-merge-all" title="合并全部" aria-label="合并全部">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v6M9 6l3-3 3 3M3 14h18M12 14v7M9 18l3 3 3-3"/></svg>
      </button>
      <button class="ge-btn ge-btn-sm ge-icon-btn" id="ge-flatten" title="平面化副本（保留原始图层）" aria-label="平面化副本">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 L4 6 L4 18 L12 22 L20 18 L20 6 Z"/><path d="M12 2 L12 22"/><path d="M4 6 L20 6"/><path d="M4 18 L20 18"/></svg>
      </button>
      <button class="ge-btn ge-btn-sm" id="ge-add-layer" title="添加空白图层">+ 添加</button>
    </div><div class="ge-layers-list" id="ge-layers-list"></div>`;
}
