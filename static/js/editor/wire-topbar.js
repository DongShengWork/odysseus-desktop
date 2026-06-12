/**
 * 顶栏接线 — 撤销/重做/历史记录、保存下拉菜单、缩放按钮、
 * 保存/导出/下载/项目、边缘弹出菜单，以及跨下拉菜单
 * 协调（关闭其他菜单 + 全局外部点击关闭）。
 *
 *   #ge-undo / #ge-redo / #ge-history-btn
 *   #ge-save-menu-btn + #ge-save-menu  (保存 / 另存为 / 下载 /
 *                                       保存项目 / 加载项目)
 *   #ge-zoom-out / #ge-zoom-in / #ge-zoom-fit / #ge-zoom-100
 *   #ge-export-gallery / #ge-download
 *   #ge-save-project / #ge-load-project
 *   #ge-edge-menu-btn + #ge-edge-menu (宽度输入 + 羽化 / 删除
 *                                      操作按钮)
 *
 * 下拉菜单协调：每个菜单在打开时会隐藏所有同级菜单
 * (closeOtherTopbarMenus)，并且全局外部点击处理器
 * 在用户点击菜单之外的任何位置时关闭所有打开的菜单。
 *
 * @param {{
 *   undo:                 () => void,
 *   redo:                 () => void,
 *   toggleHistoryPanel:   () => void,
 *   fitZoom:              () => void,
 *   applyZoom:            () => void,
 *   exportToGallery:      () => void,
 *   downloadPNG:          () => void,
 *   saveProject:          () => void,
 *   loadProjectPrompt:    () => void,
 *   activeLayer:          () => object | null,
 *   saveState:            (label?: string) => void,
 *   applyEdgeFeather:     (layer: object, width: number, hardDelete: boolean) => void,
 *   composite:            () => void,
 *   registerDocClickAway: (handler: (e: Event) => void) => void,
 *   uiModule:             object,
 * }} deps
 */
import { state } from './state.js';

import { t } from './i18n.js';

const TOPBAR_MENU_IDS = ['ge-image-menu', 'ge-filter-menu', 'ge-resize-menu', 'ge-save-menu'];
const TOPBAR_TRIGGER_IDS = ['ge-image-menu-btn', 'ge-filter-menu-btn', 'ge-resize-menu-btn', 'ge-save-menu-btn'];

/**
 * 关闭每个顶栏下拉菜单，但保留一个可选的"保持打开"项。
 * 导出此函数，以便其他地方接线的图像 / 滤镜 / 调整大小菜单
 * 可以从其自身的打开处理程序中调用它。
 */
export function closeOtherTopbarMenus(keepId) {
  for (const id of TOPBAR_MENU_IDS) {
    if (id === keepId) continue;
    const m = document.getElementById(id);
    if (m && !m.hidden) m.hidden = true;
  }
}

export function wireTopbar(deps) {
  const {
    undo, redo, toggleHistoryPanel,
    fitZoom, applyZoom,
    exportToGallery, downloadPNG, saveProject, loadProjectPrompt,
    activeLayer, saveState, applyEdgeFeather, composite,
    registerDocClickAway, uiModule,
  } = deps;

  // 撤销 / 重做 / 历史记录。
  document.getElementById('ge-undo')?.addEventListener('click', undo);
  document.getElementById('ge-redo')?.addEventListener('click', redo);
  document.getElementById('ge-history-btn')?.addEventListener('click', toggleHistoryPanel);

  // 保存下拉菜单 — "保存 ▾" 切换一个小菜单（保存 / 另存为 /
  // 下载 / 保存项目 / 加载项目）。内部项保持其
  // 原始 ID，因此下面的独立处理程序可以不变地接续到它们。
  {
    const saveBtn = document.getElementById('ge-save-menu-btn');
    const saveMenu = document.getElementById('ge-save-menu');
    if (saveBtn && saveMenu) {
      const saveTopbar = saveBtn.closest('.ge-topbar');
      // 将菜单重新父级化到 <body>。如果不这样做，菜单会继承
      // 画廊模态框的包含块（模态框应用了
      // `transform: scale(...)` 用于其入场动画 — 而祖先上的任何
      // 非 `none` 的 `transform` 都会使该祖先成为
      // `position: fixed` 后代的包含块，即使在
      // 动画落到 identity 之后）。下面的 JS 计算假设
      // 使用视口相对坐标，因此如果没有重新父级化，菜单
      // 在桌面上会"偏离"按钮很远。
      if (saveMenu.parentNode !== document.body) {
        document.body.appendChild(saveMenu);
      }
      const setSaveMenuOpen = (open) => {
        saveMenu.hidden = !open;
        saveTopbar?.classList.toggle('ge-topbar-menu-open', !!open);
      };
      const positionSaveMenu = () => {
        const r = saveBtn.getBoundingClientRect();
        saveMenu.style.top = `${r.bottom + 2}px`;
        saveMenu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
        saveMenu.style.left = 'auto';
      };
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = saveMenu.hidden;
        setSaveMenuOpen(willOpen);
        if (willOpen) positionSaveMenu();
      });
      saveMenu.addEventListener('click', () => { setSaveMenuOpen(false); });
      window.addEventListener('resize', () => { if (!saveMenu.hidden) positionSaveMenu(); });
      registerDocClickAway((e) => {
        if (!saveMenu.hidden && !saveMenu.contains(e.target) && e.target !== saveBtn) {
          setSaveMenuOpen(false);
        }
      });
    }
  }

  // 缩放按钮。
  document.getElementById('ge-zoom-fit')?.addEventListener('click', fitZoom);
  document.getElementById('ge-zoom-100')?.addEventListener('click', () => { state.zoom = 1; applyZoom(); });
  document.getElementById('ge-zoom-in')?.addEventListener('click', () => { state.zoom = Math.min(5, state.zoom * 1.25); applyZoom(); });
  document.getElementById('ge-zoom-out')?.addEventListener('click', () => { state.zoom = Math.max(0.1, state.zoom / 1.25); applyZoom(); });

  // 导出 / 下载 / 项目保存 / 项目加载。
  document.getElementById('ge-export-gallery')?.addEventListener('click', exportToGallery);
  document.getElementById('ge-download')?.addEventListener('click', downloadPNG);
  document.getElementById('ge-save-project')?.addEventListener('click', saveProject);
  document.getElementById('ge-load-project')?.addEventListener('click', loadProjectPrompt);

  // 全局外部点击 — 当用户点击任何不是菜单或触发按钮的
  // 位置时，关闭编辑器的每个下拉菜单。每个
  // 菜单也有自己的点击外部处理器；这是针对跨菜单点击 /
  // 移动触摸漏掉单独处理程序的多层防御网络。
  document.addEventListener('pointerdown', (e) => {
    for (const id of TOPBAR_MENU_IDS.concat(TOPBAR_TRIGGER_IDS)) {
      const el = document.getElementById(id);
      if (el && el.contains(e.target)) return;
    }
    for (const id of TOPBAR_MENU_IDS) {
      const m = document.getElementById(id);
      if (m && !m.hidden) m.hidden = true;
    }
  });

  // 边缘弹出菜单 — 宽度输入 + 羽化 / 删除操作按钮。
  function applyEdgeAction(hardDelete) {
    const layer = activeLayer();
    if (!layer || layer.locked) { uiModule.showToast('Select an unlocked layer'); return; }
    const widthInput = document.getElementById('ge-edge-width');
    const width = parseInt(widthInput?.value || '8');
    if (isNaN(width) || width < 1) { uiModule.showToast('Invalid width'); return; }
    saveState();
    applyEdgeFeather(layer, width, hardDelete);
    composite();
    uiModule.showToast(hardDelete ? `Edges deleted ${width}px` : t('editor.edges_feathered', { width: width }));
  }
  {
    const btn = document.getElementById('ge-edge-menu-btn');
    const menu = document.getElementById('ge-edge-menu');
    if (btn && menu) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menu.hidden;
        if (willOpen) closeOtherTopbarMenus('ge-edge-menu');
        menu.hidden = !menu.hidden;
        if (!menu.hidden) {
          // 自动聚焦宽度输入框，使用户可以立即输入。
          setTimeout(() => document.getElementById('ge-edge-width')?.select(), 0);
        }
      });
      document.getElementById('ge-edge-feather')?.addEventListener('click', () => {
        menu.hidden = true;
        applyEdgeAction(false);
      });
      document.getElementById('ge-edge-delete')?.addEventListener('click', () => {
        menu.hidden = true;
        applyEdgeAction(true);
      });
      document.getElementById('ge-edge-width')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          menu.hidden = true;
          applyEdgeAction(false);
        }
      });
      registerDocClickAway((e) => {
        if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true;
      });
    }
  }
}
