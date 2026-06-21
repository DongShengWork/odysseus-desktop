// ============================================
// i18n — 多语言国际化模块
// ============================================

const I18N_KEY = 'odysseus-locale';
const SUPPORTED_LOCALES = ['zh-CN', 'en-US'];
const DEFAULT_LOCALE = 'zh-CN';

let _currentLocale = DEFAULT_LOCALE;
let _translations = {};  // { locale: { key: value, ... } }
let _loadedLocales = new Set();
let _listeners = [];     // 语言切换回调

/**
 * 获取当前语言
 */
export function getCurrentLocale() {
  return _currentLocale;
}

/**
 * 获取所有支持的语言列表
 */
export function getSupportedLocales() {
  return [...SUPPORTED_LOCALES];
}

/**
 * 语言显示名称
 */
export function getLocaleDisplayName(locale) {
  const names = {
    'zh-CN': '中文',
    'en-US': 'English'
  };
  return names[locale] || locale;
}

/**
 * 加载指定语言的翻译文件
 */
async function loadLocale(locale) {
  if (_loadedLocales.has(locale)) return;
  try {
    const resp = await fetch(`/static/js/locales/${locale}.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    _translations[locale] = await resp.json();
    _loadedLocales.add(locale);
  } catch (e) {
    console.warn(`[i18n] Failed to load locale "${locale}":`, e.message);
    // 如果加载失败且不是默认语言，使用默认语言兜底
    if (locale !== DEFAULT_LOCALE) {
      if (!_loadedLocales.has(DEFAULT_LOCALE)) {
        await loadLocale(DEFAULT_LOCALE);
      }
    }
  }
}

/**
 * 翻译函数：获取 key 对应的翻译文本
 * 支持简单的参数替换，如 t('hello', { name: 'World' })
 */
export function t(key, params = {}) {
  let text = _get(key, _currentLocale);
  if (text === undefined && _currentLocale !== DEFAULT_LOCALE) {
    text = _get(key, DEFAULT_LOCALE);
  }
  if (text === undefined) return key; // 找不到翻译则返回 key 本身

  // 参数替换 {key}
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}

function _get(key, locale) {
  const dict = _translations[locale];
  if (!dict) return undefined;
  const parts = key.split('.');
  let val = dict;
  for (const p of parts) {
    if (val == null || typeof val !== 'object') return undefined;
    val = val[p];
  }
  return val;
}

/**
 * 切换到指定语言
 */
export async function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) {
    console.warn(`[i18n] Unsupported locale: "${locale}"`);
    return;
  }
  if (locale === _currentLocale) return;

  // 确保翻译已加载
  if (!_loadedLocales.has(locale)) {
    await loadLocale(locale);
  }

  _currentLocale = locale;
  try {
    localStorage.setItem(I18N_KEY, locale);
  } catch (e) { /* 忽略 */ }

  // 通知所有监听器
  for (const fn of _listeners) {
    try { fn(locale); } catch (e) { console.warn('[i18n] Listener error:', e); }
  }

  // 更新 html lang 属性
  document.documentElement.lang = locale;
}

/**
 * 注册语言切换监听器，返回取消注册函数
 */
export function onLocaleChange(fn) {
  _listeners.push(fn);
  return () => {
    _listeners = _listeners.filter(f => f !== fn);
  };
}

/**
 * 初始化 i18n 模块
 */
export async function initI18n() {
  // 从 localStorage 读取上次选择的语言
  let saved = null;
  try {
    saved = localStorage.getItem(I18N_KEY);
  } catch (e) { /* 忽略 */ }

  const initialLocale = saved && SUPPORTED_LOCALES.includes(saved) ? saved : DEFAULT_LOCALE;

  // 预加载所有支持的语言
  await Promise.all(SUPPORTED_LOCALES.map(l => loadLocale(l).catch(() => {})));

  _currentLocale = initialLocale;
  document.documentElement.lang = initialLocale;

  console.log(`[i18n] Initialized with locale: "${initialLocale}"`);
  return initialLocale;
}

/**
 * 翻译 DOM 中所有带 data-i18n 属性的元素
 */
export function translateDOM(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    if (el.tagName === 'OPTGROUP') {
      el.label = t(key);
    } else {
      el.textContent = t(key);
    }
  });
  // data-i18n-placeholder
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.placeholder = t(key);
  });
  // data-i18n-title
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.title = t(key);
  });
  // data-i18n-aria
  root.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const key = el.getAttribute('data-i18n-aria');
    if (key) el.setAttribute('aria-label', t(key));
  });
}

// 自动监听语言变更并重新翻译 DOM
onLocaleChange(() => translateDOM());

// 将 t() 暴露为全局函数，供其他模块直接使用
window.t = t;
window.setLocale = setLocale;
window.getCurrentLocale = getCurrentLocale;
window.initI18n = initI18n;
window.translateDOM = translateDOM;

export default { initI18n, t, setLocale, getCurrentLocale, getSupportedLocales, getLocaleDisplayName, onLocaleChange, translateDOM };
