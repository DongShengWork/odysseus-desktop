// static/js/emailLibrary/state.js
//
// 电子邮件库弹窗的共享可变状态。将这些状态放在单个导出对象上，
// 让兄弟模块（utils、signatureFold，以及未来的 render/menu/composer 拆分）
// 可以读写相同的值，而不需要每个模块各自导入 19 个 `let` 绑定——
// ES 模块本来也不允许从定义模块外部访问这些绑定。
//
// 写入操作在任何地方都像 `state._libOpen = true`；读取操作像
// `state._libOpen`。名称与原始变量匹配，因此这次重构纯粹是重命名，
// 不涉及语义变更。

export const state = {
  _libOpen: false,
  _libJustOpened: false,
  _libEmails: [],
  _libTotal: 0,
  _libOffset: 0,
  _libFolder: 'INBOX',
  _libFolders: [],
  _libAccountId: null,           // null = backend default account
  _libAccounts: [],              // list of accounts for the chip strip
  _libPendingExpandUid: null,
  _libSearch: '',
  _libFilter: 'all',             // all, unread, unanswered
  _libSort: 'recent',            // recent, unread, favorites
  _libHasAttachments: false,
  _libLoading: false,
  _docModule: null,
  _onEmailClick: null,
  _libEscHandler: null,
  _selectMode: false,
  _selectedUids: new Set(),
};
