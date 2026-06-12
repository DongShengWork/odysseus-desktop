// compare/state.js — compare 模块的共享可变状态
const state = {
  API_BASE: '',
  isActive: false,
  _openingSelector: false,        // 防止快速重复点击导致重复对比弹窗
  _streaming: false,
  _blindMode: true,
  _saveOnClose: false,
  _continueChat: false,
  _timeout: 300,                   // 秒
  _finishOrder: 0,
  _paneElapsed: [],                // 每个窗格的总毫秒数；完成时填充，
                                   // 以便按实际时间授予 Fastest 徽章
                                   // （顺序模式否则总是选窗格 1）
  _selectedModels: [],             // [{model, endpoint, endpointId, name}, ...]
  _paneSessionIds: [],             // 每个窗格的会话 ID
  _paneMetrics: [],                // 上一轮每个窗格的指标
  _abortControllers: [],           // 每个窗格的中止控制器
  _sidebarWasHidden: false,
  _compareElements: [],            // 添加到容器中的元素（用于清理）
  _savedToggles: null,             // 对比前保存的工具开关状态
  _savedIndicatorDisplay: {},      // 对比前工具栏指示器的显示状态
  _savedMode: 'chat',              // 对比前保存的 agent/chat 模式
  _hasVisibleResults: false,       // 关闭后对比结果是否仍在屏幕上
  _compareMode: 'chat',            // 'chat'、'agent'、'search' 或 'research'
  _lastPrompt: '',                 // 最后发送的提示（用于重新匹配）
  _cachedModels: [],               // 缓存的模型列表，用于窗格下拉菜单
  _probed: new Set(),              // 已成功探测的模型 ID
  _cachedProviders: null,          // 缓存的搜索提供商，用于搜索模式
  _searchSynthModels: null,        // 搜索模式中每个窗格的合成模型
  _parallel: true,                 // true = 一次运行所有窗格，false = 一次一个
  _fetchModelsCache: null,
  _fetchModelsCacheTime: 0,
  _expectedAnswer: '',             // 当选择带有 `answer` 的评测提示时，
                                   // stream.js 读取此项并为每个窗格标记 ✓/✗
};

/** 将临时状态重置为默认值 — 适用于干净的重新启动。 */
export function reset() {
  state._openingSelector = false;
  state._streaming = false;
  state._finishOrder = 0;
  state._paneElapsed = [];
  state._abortControllers.forEach(c => { if (c) c.abort(); });
  state._abortControllers = [];
  state._paneSessionIds = [];
  state._paneMetrics = [];
  state._compareElements = [];
  state._hasVisibleResults = false;
  state._lastPrompt = '';
  state._cachedModels = [];
  state._probed = new Set();
  state._cachedProviders = null;
  state._fetchModelsCache = null;
  state._fetchModelsCacheTime = 0;
}

export default state;
