/**
 * 编辑器状态存储 — 一个单一的可变对象，图片编辑器及其工具模块直接读写。
 *
 * 迁移说明：galleryEditor.js 曾拥有约 110 个模块作用域的 `let`
 * 声明并通过闭包捕获它们。工具模块无法跨模块边界导入
 * `let` 绑定的变更，因此我们将状态移入一个单一导出的 OBJECT，
 * 持有其引用的任何人都可以自由修改其属性。读写 `state.transformW`
 * 的方式与旧代码写入 `_transformW` 的方式完全相同。
 *
 * 状态片段一次迁移一个工具；随着更多状态从 galleryEditor.js
 * 迁移出来，此文件会增长。默认值与旧模块作用域初始化器完全一致
 * — galleryEditor.js 中每个 `state.foo = …` 重置点仍然可以不变地工作。
 */
export const state = {
  // ── 变换工具 ──
  // 拖拽调整大小/旋转的会话状态。当 `transformActive` 为
  // false 时，以下所有字段应视为过期数据。
  transformActive: false,
  transformLayer: null,
  transformOrigW: 0,
  transformOrigH: 0,
  // 用户当前拖拽的角/边控制手柄。取值为
  // 'tl' | 'tr' | 'bl' | 'br' | 'rot' | null 其中之一。
  transformHandle: null,
  // 当前光标悬停在哪个手柄上（未拖拽）。驱动悬停光标查找；
  // 与 `transformHandle` 放在一起是因为两者都来自 `_getTransformHandle`。
  hoveredHandle: null,
  // 变换开始时图层画布+偏移的快照，以便取消时可以精确恢复而无需重新从图层获取。
  transformOrigCanvas: null,
  transformOrigOffset: null,
  // 进行中的尺寸/旋转/翻转，在应用时提交。
  transformPendingW: 0,
  transformPendingH: 0,
  transformPendingRot: 0,
  transformPendingFlipH: false,
  transformPendingFlipV: false,
  transformAspectLock: true,
  // 浮动变换弹出窗口元素 + 拖拽起始偏移。
  transformPopup: null,
  transformStartX: 0,
  transformStartY: 0,
  transformStartOffX: 0,
  transformStartOffY: 0,
  // 变换叠加画布 — 位于主画布上方的独立画布，为手柄渲染留出了额外空间。
  // 由 _buildEditor 创建；移动/变换工具在其 2D 上下文中绘制手柄图层。
  transformOverlay: null,
  transformOverlayCtx: null,

  // ── 魔棒工具 ──
  // 二值选区蒙版 + 采样来源的图层。`wandMask`
  // 是一个与 `wandLayer` 像素尺寸相同的画布，选中区域为白色，
  // 其他区域为透明。`wandLastSeed` 记住上次点击位置，以便
  // 调整容差时可以重新运行泛洪填充而无需重新点击。
  wandMask: null,
  wandLayerId: null,
  wandTolerance: 24,
  wandMaskVisible: true,
  wandMode: 'replace',
  wandLiveRetune: false,
  wandLastSeed: null,
  // 缓存的图层像素数据（getImageData 是 O(像素数) — 对于 4K 图层开销很大；
  // 在活动图层变化时失效）。
  wandSrcCache: null,

  // ── 画笔 / 橡皮擦 / 克隆工具 ──
  // 共享的绘制颜色（画笔拾取色板；橡皮擦和克隆
  // 忽略颜色但复用相同的颜色选择器控件）。
  color: '#e06c75',
  // 画笔直径，单位为画布像素。在工具切换时保持；首次进入修补模式时
  // 会调整为适合蒙版的默认值。
  brushSize: 8,
  // 每种工具的笔触修饰符 — 不透明度 + 流量 + 柔和度。每种工具
  // 拥有各自的行，以便用户可以独立调整它们。
  brushOpacity: 100,
  brushFlow: 100,
  brushSoftness: 100,
  eraserOpacity: 100,
  eraserFlow: 100,
  eraserSoftness: 100,
  cloneOpacity: 100,
  cloneFlow: 100,
  cloneSoftness: 100,
  // 克隆印章的源点（通过 Alt+点击或双击设置）。null
  // 表示尚未选取源点 — 在设置源点之前，使用克隆工具点击不会产生任何效果。
  cloneSourceX: null,
  cloneSourceY: null,
  // 笔触起始偏移，使得源点随画笔移动，在整个笔触过程中
  // 保持源→目标的偏移量不变。
  cloneStrokeStartX: null,
  cloneStrokeStartY: null,
  // 笔触开始时源图层像素的冻结快照，使得
  // 在已绘制像素上移动源点时采样的是原始图像，
  // 而非进行中的印章环。
  cloneSourceSnapshot: null,
  cloneSourceLayerId: null,
  // 移动端：用于"设置源点"的双击检测，因为没有键盘时 Alt+点击不可用。
  cloneLastTapTime: 0,
  cloneLastTapX: 0,
  cloneLastTapY: 0,

  // ── 修补 + 蒙版 ──
  // 活动蒙版画布 + 其 2D 上下文。当用户在图层面板中选择不同的蒙版时，
  // 重新指向活动的蒙版子图层。
  maskCanvas: null,
  maskCtx: null,
  maskVisible: true,
  // 复用的画布，用于蒙版合并的着色通道（避免每次合成时重复分配）。
  compositeMaskUnion: null,
  // 合成中应用于蒙版像素的视觉着色 — 纯粹是装饰性的；
  // AI 模型仍然看到硬二值蒙版。
  maskTintColor: 'rgba(255, 110, 110, 1)',
  maskTintOpacity: 0.28,
  // 修补工具的绘制与擦除模式（Ctrl+Alt 可临时切换单次笔触；
  // UI 按钮切换持久设置）。
  inpaintEraseMode: false,
  inpaintEraseStroke: false,
  // 首次进入保护：用户每次会话首次打开修补工具时，
  // 将画笔大小调整为适合蒙版的默认值。
  inpaintBrushInitialised: false,
  // 上次成功修补结果的图层 — 驱动实时边缘
  // 羽化/笔触滑块（这些只应用于最近的结果）。
  lastInpaintLayerId: null,
  // 捕获的处理函数，以便关闭时可以移除它们而不泄漏。
  inpaintDismissHandlers: null,
  // 背景移除工具状态 — 原始快照，使得边缘
  // 清理滑块可以实时重建 alpha 而无需重新运行 rembg。
  rembgLiveLayer: null,
  rembgLiveSnap: null,
  // 缓存的"rembg 是否安装在服务器上？"探测结果。
  rembgInstalledCache: null,

  // ── 笔触拖拽状态 ──
  // 画笔/橡皮擦/克隆/修补共享的通用进行中笔触标志。
  // `lastX/Y` 是上一个鼠标位置，用于在快速移动的光标样本之间
  // 插值出连续的线条。
  drawing: false,
  lastX: 0,
  lastY: 0,

  // ── 移动工具 ──
  moving: false,
  moveStartX: 0,
  moveStartY: 0,
  // 拖拽开始时的图层偏移，以便我们可以通过
  // (鼠标 - 起始鼠标) + 起始偏移 来计算新偏移，而不是累积增量。
  moveLayerOffsetX: 0,
  moveLayerOffsetY: 0,
  // 移动工具拖拽时绘制的吸附辅助线（按住 Ctrl 时）。每一项
  // 是画布空间中的垂直线或水平线。
  activeSnapGuides: null,

  // ── 裁剪工具 ──
  cropping: false,
  cropStart: null,
  cropEnd: null,
  cropRect: null,
  cropAspectLock: null,
  // 当用户拖拽已完成裁剪矩形的内部来重新定位时，此值为 true。
  cropMoving: false,
  cropMoveStart: null,

  // ── 套索工具 ──
  // 自由选择多边形，单位为画布像素。当没有套索
  // 在进行或暂存时为空。
  lassoPoints: [],
  lassoActive: false,

  // 编辑器内复制/粘贴 — 与系统剪贴板分离，以便我们可以
  // 无损地传递图层 alpha 和元数据。
  internalClipboard: null,

  // ── 编辑器 DOM 引用 ──
  // openEditor 挂载到的根容器。
  container: null,
  // 主图像画布 + 其 2D 上下文。每次 openEditor 时重新创建，
  // 以便编辑器可以用新的尺寸重新打开。
  mainCanvas: null,
  mainCtx: null,

  // ── 文档 + 图层 ──
  layers: [],
  activeLayerId: null,
  // 活动工具 ID — move/crop/transform/brush/eraser/clone/
  // lasso/wand/inpaint/rembg/harmonize/sharpen/upscale/style 其中之一。
  tool: 'move',
  // 显示缩放比例（1 = 100%）。pan{X,Y} 在视口中平移画布。
  zoom: 1,
  panX: 0,
  panY: 0,
  // 文档尺寸，单位为画布像素。
  imgWidth: 0,
  imgHeight: 0,
  // 此编辑器会话正在编辑的图片库图像 ID，对于空白画布草稿则为 null。
  imageId: null,
  // 原始文件扩展名，以便覆盖保存原件时用相同的格式重新编码
  // （JPEG 与 PNG 的区别很重要：对于相机照片，通过远程隧道
  // JPEG 可将上传大小减少 5-10 倍）。
  originalExt: 'png',
  // 在 openEditor / closeEditor 之间为 true — 防止在用户关闭编辑器后
  // 触发的异步回调（不要绘制到已销毁的画布，不要重新挂载加载旋转器）。
  editorOpen: false,
  // 为当前会话注册的文档级点击外部处理函数。
  // 被追踪以便 closeEditor 可以干净地全部移除。
  // 原地修改（push / length = 0）；引用永不改变。
  editorDocClickHandlers: [],

  // ── 撤销 / 重做 ──
  undoStack: [],
  redoStack: [],

  // ── 图层偏移 + ID 分配 ──
  // Map<layerId, {x, y}> — 使用 Map 以便我们可以将其与图层自身的画布分开序列化。
  // 原地修改。
  layerOffsets: new Map(),
  nextLayerId: 1,

  // ── 弹出窗口 / 面板引用 ──
  fxPopupEl: null,
  fxPopupLayerId: null,
  fxMenuEl: null,
  adjPopupEl: null,
  // 在调整弹出窗口中拖动滑块时，通过 rAF 节流的实时预览。
  adjRafPending: false,
  historyPanelEl: null,
  // 自定义画笔光标叠加元素（跟随鼠标的圆形）。
  cursorEl: null,
  // 悬停预览缩略图浮动元素（单例，重新定位）。
  layerThumbEl: null,
  // 加载叠加元素（漩涡动画 + 标签）。
  editorLoadingEl: null,

  // ── 草稿持久化 ──
  draftId: null,
  draftName: '',
  persistTimer: null,
  // 当前 PUT/POST promise，以便并发保存可以链接。
  persistInFlight: null,
  // 当在进行中的保存期间发生编辑时为 true — 触发
  // 当前保存完成后进行后续持久化。
  persistDirty: false,
};
