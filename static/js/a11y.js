// 为键盘和屏幕阅读器用户提供无障碍增强。
//
// Odysseus 中的几个主要控件被编写为仅点击的 <div>
// （最显著的是整个侧边栏导航：New Chat、Search、Brain、
// Calendar、Compare、Cookbook、Deep Research、Gallery、Library、Notes、
// Tasks、Theme，以及账户行）。<div> 不在 Tab 键顺序中且
// 不被宣布为按钮，因此键盘和屏幕阅读器用户无法
// 到达或操作它们。
//
// 本模块就地增强这些行 —— 使其可聚焦
// （tabindex=0），在安全时将其宣布为按钮，并
// 通过 Enter / Space 激活它们 —— 而不改变它们的外观或
// 鼠标用户的行为方式。可见的焦点环已存在于
// style.css 中（`.list-item:focus-visible`）；它只是从未触发，因为
// 这些行从未可聚焦。

(function () {
  'use strict';

  // 我们希望通过键盘可达的作为按钮点击的行。
  var ROW_SELECTOR = ['#sidebar .list-item', '#user-bar-profile'].join(',');

  // 原生交互后代元素。如果行中包含其中之一，我们
  // 绝不能给该行 role="button" —— 按钮内嵌套按钮是无效的
  // （axe "nested-interactive"）并会混淆屏幕阅读器。此类行仍然
  // 变得可聚焦 + 可 Enter/Space 激活，只是没有该角色。
  var NESTED_INTERACTIVE =
    'a[href],button,input,select,textarea,[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

  function enhanceRow(el) {
    if (!el || el.nodeType !== 1 || el.dataset.a11yEnhanced === '1') return;
    var tag = el.tagName;
    // 保持真正的原生控件不变。
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' ||
        tag === 'SELECT' || tag === 'TEXTAREA') return;

    el.dataset.a11yEnhanced = '1';
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    el.setAttribute('data-a11y-activatable', '1');

    if (!el.querySelector(NESTED_INTERACTIVE) && !el.hasAttribute('role')) {
      el.setAttribute('role', 'button');
    }

    // 保证accessible name。可见文本通常提供它；对于纯图标行
    // 回退到 title 属性。
    if (!el.getAttribute('aria-label') &&
        !(el.textContent || '').trim() &&
        el.getAttribute('title')) {
      el.setAttribute('aria-label', el.getAttribute('title'));
    }
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll(ROW_SELECTOR).forEach(enhanceRow);
  }

  // ---- 模态对话框 -----------------------------------------------------
  // Odysseus 模态框是普通的 <div class="modal-content"> 框。将它们
  // 标记为 ARIA dialogs 使屏幕阅读器将其宣布为对话框，并
  // 豁免其内容免受"所有内容均在地标内"规则。我们还将
  // 模态框标题规范化为标题级别 2（低于页面 <h1> 一级），
  // 这样无论标记使用什么标签，标题顺序都保持有效。
  var titleSeq = 0;
  // 每个模态框"种类"是一个容器选择器加上在哪里找到其标题
  // 标题。标准模态框使用 .modal-content/.modal-header；停靠的
  // Notes 面板使用其自己的标记。
  var MODAL_KINDS = [
    {
      sel: '.modal-content',
      heading: '.modal-header h1, .modal-header h2, .modal-header h3, ' +
               '.modal-header h4, .modal-header h5, .modal-header h6'
    },
    { sel: '.notes-pane', heading: '.notes-pane-title' }
  ];
  var MODAL_SEL = MODAL_KINDS.map(function (k) { return k.sel; }).join(',');

  function enhanceModal(mc, headingSel) {
    if (!mc || mc.nodeType !== 1 || mc.dataset.a11yDialog === '1') return;
    mc.dataset.a11yDialog = '1';
    if (!mc.hasAttribute('role')) mc.setAttribute('role', 'dialog');
    if (!mc.hasAttribute('aria-modal')) mc.setAttribute('aria-modal', 'true');

    var heading = headingSel && mc.querySelector(headingSel);
    if (heading) {
      if (!heading.id) heading.id = 'a11y-modal-title-' + (++titleSeq);
      if (!mc.hasAttribute('aria-labelledby')) {
        mc.setAttribute('aria-labelledby', heading.id);
      }
      // 模态框标题位于页面 <h1> 下一级；规范化使标题
      // 顺序保持有效，无论标记恰好使用什么标签。
      if (!heading.hasAttribute('aria-level')) heading.setAttribute('aria-level', '2');
    }
  }

  function enhanceModals(root) {
    var scope = root || document;
    MODAL_KINDS.forEach(function (k) {
      scope.querySelectorAll(k.sel).forEach(function (mc) { enhanceModal(mc, k.heading); });
    });
  }

  function headingSelFor(el) {
    for (var i = 0; i < MODAL_KINDS.length; i++) {
      if (el.matches(MODAL_KINDS[i].sel)) return MODAL_KINDS[i].heading;
    }
    return null;
  }

  // 委托键盘激活。我们仅在聚焦的元素本身
  // 是增强行时才行动（keydown 以聚焦的元素为目标），因此对
  // 嵌套原生按钮的按键留给浏览器自己的处理。
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var el = e.target;
    if (!el || !el.matches || !el.matches('[data-a11y-activatable]')) return;
    e.preventDefault(); // Space 否则会滚动页面
    el.click();
  });

  function init() {
    enhanceAll(document);
    enhanceModals(document);

    // 侧边栏内容在用户导航时重新渲染（会话列表、
    // 工具子行等）。观察新行并同样增强它们。
    var sidebar = document.getElementById('sidebar');
    if (sidebar && 'MutationObserver' in window) {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.matches && n.matches(ROW_SELECTOR)) enhanceRow(n);
            if (n.querySelectorAll) enhanceAll(n);
          }
        }
      }).observe(sidebar, { childList: true, subtree: true });
    }

    // 某些模态框（Notes、Tasks 等）在运行时注入，通常作为
    // <body> 的直接子元素。捕获这些而不必对整个文档
    // 进行深度的子树观察。
    if ('MutationObserver' in window) {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.matches && n.matches(MODAL_SEL)) enhanceModal(n, headingSelFor(n));
            if (n.querySelector && n.querySelector(MODAL_SEL)) enhanceModals(n);
          }
        }
      }).observe(document.body, { childList: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
