// static/js/emailLibrary/state.js
//
// Shared mutable state for the email-library popup. Keeping these on a
// single exported object lets sibling modules (utils, signatureFold,
// future render/menu/composer splits) read and write the same values
// without each one importing 19 `let` bindings — which ES modules
// don't allow from outside the defining module anyway.
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
