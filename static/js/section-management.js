// ============================================
// 区块管理 — 折叠/展开 + 拖拽排序
// ============================================

/**
 * 初始化使用箭头按钮的区块折叠/展开。
 * @param {Object} Storage - 存储模块
 */
export function initSectionCollapse(Storage) {
  const _chevronHtml = '<button type="button" class="section-collapse-btn" title="折叠区块"><svg class="section-collapse-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>';
  const savedState = Storage.getJSON('section-collapsed') || {};

  document.querySelectorAll('.section .section-header-flex').forEach(header => {
    const section = header.closest('.section');
    if (!section || !section.id) return;

    // 跳过邮件区块 — 它不折叠（标题改为打开弹窗）
    if (section.id === 'email-section') return;

    // 添加箭头（始终可见 — 折叠时旋转）
    header.insertAdjacentHTML('beforeend', _chevronHtml);

    // 恢复已保存的状态
    if (savedState[section.id]) {
      section.classList.add('collapsed');
    }

    function toggleCollapse() {
      const wasCollapsed = section.classList.contains('collapsed');
      const willCollapse = !wasCollapsed;
      const state = Storage.getJSON('section-collapsed') || {};
      state[section.id] = willCollapse;
      Storage.setJSON('section-collapsed', state);

      // 始终清除上一次切换可能还在进行的动画 class，
      // 让连续点击能干净地重新开始。递增代次标记，
      // 让还未完成的上次切换的回调变成空操作。
      section.classList.remove('section-just-expanded', 'section-just-collapsing');
      const gen = (section._collapseGen = (section._collapseGen || 0) + 1);

      if (willCollapse) {
        // 多米诺关闭：在实际添加 .collapsed 之前先播放
        // 子行上的淡出/下滑动画（.collapsed 会通过 display:none 隐藏它们），
        // 然后在瀑布动画完成后锁定折叠。
        //
        // We wait on the REAL animations (getAnimations) rather than a fixed
        // timeout. Different sections animate different rows — .list-item in
        // .models-row 在 #models-section 中 — 所以任何硬编码的时长
        // either stalls with a dead pause (when the selector matches nothing,
        // as it did for #models-section) or guesses the wrong length. Force a
        // reflow first so the keyframes restart from the top.
        // eslint-disable-next-line no-unused-expressions
        section.offsetHeight;
        section.classList.add('section-just-collapsing');

        const lockCollapsed = () => {
          if (section._collapseGen !== gen) return; // 被新的切换取代
          section.classList.remove('section-just-collapsing');
          section.classList.add('collapsed');
        };
        // 只有多米诺关闭关键帧控制折叠 — 忽略子树中无关的
        //（且可能是无限的，例如加载动画）动画。
        const dominoOut = section.getAnimations({ subtree: true })
          .filter(a => a.animationName === 'section-domino-out');
        if (dominoOut.length === 0) {
          lockCollapsed(); // 没有可动画的元素 — 立即折叠，无死等
        } else {
          Promise.allSettled(dominoOut.map(a => a.finished)).then(lockCollapsed);
          // 安全网：如果动画永远不完成（例如元素被移除），
          // 仍然锁定折叠，防止区块卡在打开状态。
          setTimeout(lockCollapsed, 600);
        }
      } else {
        // 展开路径 — 移除 .collapsed 并重播进入多米诺动画。
        section.classList.remove('collapsed');
        // eslint-disable-next-line no-unused-expressions
        section.offsetHeight;
        section.classList.add('section-just-expanded');
        setTimeout(() => {
          if (section._collapseGen !== gen) return; // 被新的切换取代
          section.classList.remove('section-just-expanded');
        }, 700);
      }
    }

    // 点击标题折叠/展开
    const title = header.querySelector('h4') || header.querySelector('.section-title');
    if (title) {
      title.style.cursor = 'pointer';
      title.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCollapse();
      });
    }

    // 点击箭头按钮
    const chevronBtn = header.querySelector('.section-collapse-btn');
    if (chevronBtn) {
      chevronBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCollapse();
      });
    }

    // 点击折叠区块的任意位置展开
    section.addEventListener('click', (e) => {
      if (!section.classList.contains('collapsed')) return;
      if (e.target.closest('button, select, .dropdown')) return;
      e.stopPropagation();
      toggleCollapse();
    });
  });
}

/**
 * 初始化区块拖拽排序（基于鼠标，仅桌面端）。
 * @param {Object} Storage - 存储模块
 * @param {Function} loadUIVis - 返回 UI 可见性状态的函数
 */
export function initSectionDrag(Storage, loadUIVis) {
  const sidebar = document.getElementById('sidebar');
  const sidebarInner = sidebar ? sidebar.querySelector('.sidebar-inner') : null;
  if (!sidebarInner) return;

  // 在移动端禁用拖拽以防止滚动干扰
  if ('ontouchstart' in window) {
    document.querySelectorAll('.section[draggable]').forEach(s => {
      s.setAttribute('draggable', 'false');
    });
  }

  let draggedSection = null;
  let placeholder = null;
  let offsetY = 0;

  function getSections() {
    return Array.from(sidebar.querySelectorAll('.section[draggable="true"]'));
  }

  function onMouseDown(e) {
    if (!e.target.classList.contains('drag-handle')) return;

    // 检查拖拽排序是否启用
    const uiState = loadUIVis();
    if (uiState['section-drag-reorder'] === false) return;

    const section = e.target.closest('.section[draggable="true"]');
    if (!section) return;

    e.preventDefault();

    const rect = section.getBoundingClientRect();
    offsetY = e.clientY - rect.top;
    draggedSection = section;

    // 创建占位元素
    placeholder = document.createElement('div');
    placeholder.className = 'section-placeholder';
    placeholder.style.cssText = `
      height: ${rect.height}px;
      margin: 4px 0;
      border: 2px dashed rgba(0, 170, 255, 0.5);
      border-radius: 8px;
      background: rgba(0, 170, 255, 0.1);
    `;
    section.parentNode.insertBefore(placeholder, section);

    // 使区块浮动
    Object.assign(section.style, {
      position: 'fixed',
      width: rect.width + 'px',
      left: rect.left + 'px',
      top: rect.top + 'px',
      zIndex: '9999',
      opacity: '0.95',
      boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      pointerEvents: 'none',
      transition: 'none'
    });

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    if (!draggedSection) return;

    // 只垂直移动 — 水平方向锁定
    draggedSection.style.top = (e.clientY - offsetY) + 'px';

    const sections = getSections().filter(s => s !== draggedSection);
    const dragRect = draggedSection.getBoundingClientRect();
    const dragTop = dragRect.top;

    let insertBefore = null;

    // 查找应该在哪个区块之前插入
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const rect = section.getBoundingClientRect();

      // 如果我们的顶部边缘在此区块底部上方，就插在它前面
      if (dragTop < rect.bottom - 10) {
        insertBefore = section;
        break;
      }
    }

    // 移动占位元素
    if (insertBefore) {
      if (placeholder.nextElementSibling !== insertBefore) {
        sidebarInner.insertBefore(placeholder, insertBefore);
      }
    } else if (sections.length > 0) {
      const lastSection = sections[sections.length - 1];
      if (placeholder !== lastSection.nextElementSibling) {
        sidebarInner.insertBefore(placeholder, lastSection.nextElementSibling);
      }
    }
  }

  function onMouseUp() {
    if (!draggedSection) return;

    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    // 吸附到占位元素 — 快速！
    const phRect = placeholder.getBoundingClientRect();
    draggedSection.style.transition = 'top 0.08s ease-out';
    draggedSection.style.top = phRect.top + 'px';

    setTimeout(() => {
      placeholder.parentNode.insertBefore(draggedSection, placeholder);
      placeholder.remove();
      draggedSection.style.cssText = '';

      // 保存排序
      const ids = getSections().map(s => s.id).filter(Boolean);
      Storage.setJSON(Storage.KEYS.SECTION_ORDER, ids);

      draggedSection = null;
      placeholder = null;
    }, 80);
  }

  sidebar.addEventListener('mousedown', onMouseDown);

  // 加载时恢复已保存的排序
  try {
    const saved = Storage.get(Storage.KEYS.SECTION_ORDER);
    if (saved) {
      const order = JSON.parse(saved);
      order.forEach(id => {
        const section = document.getElementById(id);
        if (section) sidebarInner.appendChild(section);
      });
    }
  } catch (e) {}
}
