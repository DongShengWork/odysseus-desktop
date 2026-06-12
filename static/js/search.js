// static/js/search.js — 搜索设置管理

/**
 * 搜索设置管理 — 从管理员设置中读取当前搜索提供商。
 */

let API_BASE = '';
let _provider = 'searxng';
let _loaded = false;

export function init(apiBase) {
  API_BASE = apiBase;
  // 初始化时获取提供商，确保聊天需要时已准备就绪
  _fetchProvider();
}

async function _fetchProvider() {
  try {
    const res = await fetch((API_BASE || '') + '/api/auth/settings', { credentials: 'same-origin' });
    const s = await res.json();
    _provider = s.search_provider || 'searxng';
    _loaded = true;
  } catch (e) { /* 保持默认值 */ }
}

export function getCurrentProvider() {
  return _provider;
}

const _labels = {
  searxng: 'SearXNG', brave: 'Brave', duckduckgo: 'DuckDuckGo',
  google_pse: 'Google', tavily: 'Tavily', serper: 'Serper',
  disabled: 'search (disabled)',
};

export function getProviderLabel() {
  return _labels[_provider] || _provider;
}

/** 管理员保存新设置后重新获取 */
export function refresh() {
  _fetchProvider();
}

const searchModule = {
  init,
  getCurrentProvider,
  getProviderLabel,
  refresh
};

export default searchModule;
