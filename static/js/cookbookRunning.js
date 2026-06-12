// ============================================

// COOKBOOK RUNNING 子模块

// 运行任务标签页：任务卡片、状态监控、

// 停止/重启、诊断、自动修复、后台监控

// ============================================



import uiModule from './ui.js';

import { _diagnose, _showDiagnosis, _clearDiagnosis } from './cookbook-diagnosis.js';

import { registerMenuDismiss } from './escMenuStack.js';

import { computeProgressSignal } from './cookbookProgressSignal.js';
import { t } from './i18n.js';



// 将任务内部状态映射为对用户友好的徽章标签。避免在侧边栏中显示

// "error" 字样——用户手动停止或正常退出的服务器应显示为 "stopped" 而非 "error"。

function _statusLabel(status, type) {

  if (status === 'running' && type === 'download') return 'downloading';

  if (status === 'done' && type === 'download') return 'finished';

  if (status === 'error') return 'stopped';

  return status || '';

}



// 任务状态徽章显示内容及样式类的唯一来源。

// 关键点：正在启动中的 serve 任务显示其实时阶段

// ("loading 45%", "warming up", …) 而非通用的 "running" —— 它们

// 是同一状态，因此徽章不应在每次重新渲染时在两个不同标签之间切换。

// 返回 { text, cls }，其中 cls 会追加在

// "cookbook-task-status" 之后（'' = 中性加载样式）。

function _taskBadge(task) {

  if (task._unreachable && task.status === 'running') return { text: 'unreachable', cls: 'cookbook-task-error' };

  if (task.type === 'serve' && task.status === 'running' && task.progress) {

    // 同样是绿色的 "running" 药丸——只是显示动态阶段文字，这样在服务器启动过程中

    // 不会显示为不同的状态。

    return { text: task.progress, cls: 'cookbook-task-running' };

  }

  return { text: _statusLabel(task.status, task.type), cls: 'cookbook-task-' + task.status };

}



// 如果下载任务的 tmux 输出仍然显示活跃的分片行

//（例如 "model-00012-of-00082.safetensors: 56%|"），则它实际上并未完成 ——

// cookbook 只是跟丢了。此时清除药丸变为 "reconnect" 操作入口

//（点击 → 恢复该行并重新连接轮询循环）。

function _downloadOutputLooksActive(task) {

  if (!task || task.type !== 'download') return false;

  const out = task.output || '';

  if (!out) return false;

  if (out.includes('DOWNLOAD_OK') || out.includes('DOWNLOAD_FAILED')) return false;

  // 活跃的分片行：文件名 + 冒号 + 非 100% 的百分比。

  // 捕获任何传输中的分片或 "Downloading 'X' to ..." 行（无 %）。

  return /model-\d+-of-\d+\.[a-z]+:\s+(?!100%)\d+%/i.test(out)

      || /Downloading\s+'[^']+'\s+to\s+'[^']*\.incomplete'/i.test(out);

}



function _canClearTask(task) {

  if (!task || task.status === 'running') return false;

  if (task.type === 'serve' && (task.status === 'ready' || task._serveReady)) return false;

  // 如果 tmux 输出仍然显示传输中的下载，则任务实际上并未

  // 完成——隐藏清除/勾选药丸以不在仍在执行的任务上

  // 显示。（下一次渲染会反映这一点，理想情况下自动修复会

  // 将状态切回 running。）

  if (_downloadOutputLooksActive(task)) return false;

  return ['done', 'stopped', 'error', 'crashed', 'failed'].includes(task.status);

}



function _clearPillLabel(task) {

  if (_downloadOutputLooksActive(task)) return 'reconnect';

  return 'clear';

}



// pip 依赖/驱动安装（payload._dep）的成功标记是 runner 的

// "=== Process exited with code 0 ===" 哨兵和 pip 的

// "Successfully installed" 行——而不是下载启发式算法寻找的

// HuggingFace 下载标记（DONE / 100% / /snapshots/ / DOWNLOAD_OK）。

// 如果没有这个检查，tmux 窗格已消失的干净安装会被

// 误读为 crashed/stopped，即使 pip 已退出并返回 0。优先使用权威的

// 退出码哨兵；当未捕获到哨兵时回退到 pip 的成功行

//（且同一输出中没有安装错误）。

function _depInstallSucceeded(output) {

  const text = String(output || '');

  if (!text) return false;

  const exitMatch = text.match(/=== Process exited with code (-?\d+) ===/);

  if (exitMatch) return Number(exitMatch[1]) === 0;

  return /\b(?:Successfully installed|Requirement already satisfied)\b/.test(text)

    && !/\bERROR\b|No matching distribution|Could not find a version|Traceback \(most recent call last\)/.test(text);

}



function _shouldOfferCrashReport(task) {

  if (!task) return false;

  if (task._unreachable && task.type === 'serve') return true;

  return ['error', 'crashed', 'failed'].includes(task.status);

}



function _serveTaskLooksAwqOnLocalBackend(task, outputText = '') {

  const repo = `${task?.payload?.repo_id || ''} ${task?.name || ''}`.toLowerCase();

  const cmd = `${task?.payload?._cmd || ''} ${outputText || ''}`.toLowerCase();

  return /\b(awq|gptq|fp8)\b/.test(repo) && /(llama-server|llama_cpp\.server|ollama|ggml_cuda_enable_unified_memory)/.test(cmd);

}



function _serveTaskLooksAwqWithoutUsableAccelerator(task, outputText = '') {

  const repo = `${task?.payload?.repo_id || ''} ${task?.name || ''}`.toLowerCase();

  const out = String(outputText || '').toLowerCase();

  return /\b(awq|gptq|fp8)\b/.test(repo)

    && /(no accelerator|no cuda runtime|failed to infer device type|triton is not supported|0 active driver)/i.test(out);

}



async function _openDownloadForGgufTask(task) {

  const raw = task?.payload?.repo_id || task?.name || '';

  const modelName = String(raw)

    .split('/').pop()

    .replace(/[-_](?:AWQ|GPTQ|FP8|4bit|8bit|Int4|Int8).*$/i, '')

    .replace(/[-_]+$/g, '')

    || String(raw).split('/').pop()

    || raw;

  const cookbook = window.cookbookModule;

  if (cookbook && typeof cookbook.open === 'function') {

    cookbook.open({ tab: 'Search' });

  } else {

    document.getElementById('tool-cookbook-btn')?.click();

  }

  setTimeout(async () => {

    const modal = document.getElementById('cookbook-modal');

    const tab = modal?.querySelector('.cookbook-tab[data-backend="Search"]');

    if (tab && !tab.classList.contains('active')) tab.click();

    const search = document.getElementById('hwfit-search');

    if (search) {

      search.value = modelName;

      search.dispatchEvent(new Event('input', { bubbles: true }));

      search.focus();

    }

    const quant = document.getElementById('hwfit-quant');

    if (quant) {

      quant.value = 'Q4_K_M';

      quant.dispatchEvent(new Event('change', { bubbles: true }));

    }

    try {

      const hwfit = await import('./cookbook-hwfit.js');

      if (typeof hwfit._hwfitFetch === 'function') hwfit._hwfitFetch(true);

    } catch {}

  }, 80);

}



function _terminalServeDiagnosis(task, outputText) {

  const out = String(outputText || task?.output || '');

  if (!task || task.type !== 'serve' || !['stopped', 'error', 'crashed', 'failed'].includes(task.status) || !out.trim()) return null;

  // Pip 任务（Reinstall vLLM、Upgrade torch 等）借用了 serve 任务类型

  // 以便获得 tmux 会话并显示在 Running 标签页中——但它们不是 serve 调用。

  // 它们的输出是 pip 自身的；通用的 "Serve stopped before the model became reachable"

  // 消息 + Edit-serve 修复没有意义。因此跳过，让面板只显示 pip 的输出。

  const _isPipTask = ((task.payload?.repo_id || '').startsWith('pip-'))

    || /python3? -m pip\b/.test(task.payload?._cmd || '');

  if (_isPipTask) return null;

  if (_serveTaskLooksAwqOnLocalBackend(task, out)) {

    return {

      message: 'AWQ/GPTQ/FP8 cannot be served through llama.cpp/Ollama unified-memory mode.',

      suggestion: 'Suggested action: use vLLM/SGLang on a compatible CUDA/ROCm GPU server, or download a GGUF version for llama.cpp/Ollama/unified-memory serving.',

      fixes: [

        { label: 'Find GGUF download', action: () => _openDownloadForGgufTask(task) },

        { label: 'Edit serve', action: (panel) => _openServeEditForTask(task) },

      ],

    };

  }

  if (_serveTaskLooksAwqWithoutUsableAccelerator(task, out)) {

    return {

      message: 'AWQ/GPTQ/FP8 needs a working vLLM/SGLang accelerator path; this server did not expose one.',

      suggestion: 'Suggested action: choose a CUDA/ROCm server where vLLM/SGLang can see the GPU, or download a GGUF version and serve it with llama.cpp/Ollama.',

      fixes: [

        { label: 'Find GGUF download', action: () => _openDownloadForGgufTask(task) },

        { label: 'Edit serve', action: (panel) => _openServeEditForTask(task) },

      ],

    };

  }

  return _diagnose(out) || {

    message: /Native llama-server not found|building llama-server|llama\.cpp/i.test(out)

      ? 'llama.cpp build stopped before the server became reachable.'

      : 'Serve stopped before the model became reachable.',

    suggestion: /Native llama-server not found|building llama-server|llama\.cpp/i.test(out)

      ? 'Suggested action: copy the troubleshooting bundle, then edit serve settings. For the quickest local/CPU path, use Ollama or a prebuilt llama-server; source builds can take several minutes and fail if build dependencies are incomplete.'

      : 'Suggested action: copy the troubleshooting bundle, then edit serve settings or relaunch with a CPU/backend fallback.',

    fixes: [{ label: 'Edit serve', action: (panel) => _openServeEditForTask(task) }],

  };

}



function _redactCrashReportText(text) {

  if (!text) return '';

  return String(text)

    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]')

    .replace(/\b(hf_[A-Za-z0-9]{16,})\b/g, '[redacted-hf-token]')

    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[redacted-api-key]')

    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{16,})\b/g, '[redacted-slack-token]')

    .replace(/\b(AIza[0-9A-Za-z_-]{20,})\b/g, '[redacted-google-key]')

    .replace(/\b((?:HF_TOKEN|HUGGING_FACE_HUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|BRAVE_API_KEY|TAVILY_API_KEY|SERPER_API_KEY|GOOGLE_API_KEY|API_KEY|TOKEN|PASSWORD)\s*=\s*)(['"]?)[^\s'"\\]+/gi, '$1$2[redacted]')

    .replace(/\b(--(?:api-key|token|hf-token|password)\s+)([^\s]+)/gi, '$1[redacted]');

}



function _lastLines(text, count = 160) {

  const clean = _redactCrashReportText(text || '').trimEnd();

  if (!clean) return '(no captured output)';

  return clean.split('\n').slice(-count).join('\n');

}



function _codeFence(text) {

  return String(text || '').replace(/```/g, '` ` `');

}



function _taskHostLabel(task) {

  if (!task?.remoteHost) return 'local';

  return task.remoteHost + (task.sshPort ? `:${task.sshPort}` : '');

}



function _taskPort(task) {

  const cmd = task?.payload?._cmd || '';

  const match = cmd.match(/--port\s+(\d+)/);

  return match ? match[1] : '';

}



function _buildCrashReport(task, outputText) {

  const capturedOutput = outputText || task?.output || '';

  const cmd = _redactCrashReportText(task?.payload?._cmd || '');

  const diag = _diagnose(capturedOutput);

  const started = task?.ts ? new Date(task.ts).toISOString() : '';

  const report = [

    '## Odysseus Cookbook crash report',

    '',

    'Please review this report for secrets before posting it publicly.',

    '',

    '### Task',

    `- ID: \`${task?.sessionId || task?.id || 'unknown'}\``,

    `- Type: \`${task?.type || 'unknown'}\``,

    `- Status: \`${task?._unreachable ? 'unreachable' : (task?.status || 'unknown')}\``,

    `- Model/repo: \`${task?.payload?.repo_id || task?.name || 'unknown'}\``,

    `- Host: \`${_taskHostLabel(task)}\``,

  ];

  if (task?.platform) report.push(`- Platform: \`${task.platform}\``);

  if (started) report.push(`- Started: \`${started}\``);

  const port = _taskPort(task);

  if (port) report.push(`- Port: \`${port}\``);

  if (diag?.message) report.push(`- Diagnosis: ${diag.message}`);

  if (cmd) {

    report.push('', '### Command', '```bash', _codeFence(cmd), '```');

  }

  report.push('', '### Last captured output', '```text', _codeFence(_lastLines(capturedOutput)), '```');

  return report.join('\n');

}



// 共享状态/函数，由 init() 注入

let _envState;

let _sshCmd;

let _getPort;

let _sshPrefix;

let _getPlatform;

let _isWindows;

let _buildEnvPrefix;

let _loadPresets;

let _savePresets;

let _copyText;

let _persistEnvState;

let _refreshDependencies;

let _serverByVal;

let _selectedServer;

let modelLogo;

let esc;

let _detectBackend;

let _detectToolParser;

let _detectModelOptimizations;

let _buildServeCmd;



// 当启动新操作（下载 / 依赖安装 / serve）时，此处保存新任务的 ID，

// 以便下一次渲染折叠所有其他卡片，只保留新卡片展开。

// 由 _renderRunningTab 消费（清除）。

let _soloExpandTaskId = null;



// 存储键名

const TASKS_KEY = 'cookbook-tasks';

const STORAGE_KEY = 'cookbook-presets';

const SERVE_STATE_KEY = 'cookbook-serve-state';



// 轮询 / 超时间隔

const TASK_POLL_INTERVAL_MS = 3000;       // 重连循环迭代之间的延迟

const BG_MONITOR_INTERVAL_MS = 5000;      // 后台任务状态轮询

const STALE_PROGRESS_MS = 5 * 60 * 1000;  // 在此时间内无进度更新的下载 = 停滞

const STARTUP_STALE_PROGRESS_MS = 45 * 1000; // 启动阶段长时间 0% 停滞：更快重试



// ── 阶段检测（对应 Python cookbook_routes.py 中的 _parse_serve_phase）──

// Serve 任务状态的唯一来源。请与 Python 版本保持一致。

export function _parseServePhase(snapshot) {

  if (!snapshot) return {};

  // 去除换行符，使 tmux 自动换行不会破坏正则匹配

  const flat = snapshot.replace(/\s+/g, ' ');

  const loadMatches = [...flat.matchAll(/Loading safetensors.*?(\d+)%/g)];

  // "Downloading (incomplete total...)" 跟踪真实的聚合字节数；优先于

  // "Fetching N files"，后者仅计算已完全关闭的文件数，且在

  // hf_transfer 的并行分片策略下严重滞后（通常在大部分时间都停在 0/N）。

  const downloadingMatches = [...flat.matchAll(/Downloading.*?(\d+)%/g)];

  const fetchingMatches = [...flat.matchAll(/Fetching.*?(\d+)%/g)];

  const dlMatches = downloadingMatches.length ? downloadingMatches : fetchingMatches;

  // "Avg generation throughput: X tokens/s, Running: N reqs"

  const tpsMatches = [...flat.matchAll(/(?:Avg )?generation throughput:\s*([\d.]+)\s*tokens\/s.*?Running:\s*(\d+)\s*reqs/g)];



  // 吞吐量优先——其日志行包含 "GPU KV cache usage"，否则会错误匹配预热检查

  if (tpsMatches.length) {

    const m = tpsMatches[tpsMatches.length - 1];

    const tps = parseFloat(m[1]);

    const reqs = parseInt(m[2]);

    return {

      phase: reqs > 0 ? `${m[1]} tok/s` : 'idle',

      status: 'ready',

      tps,

      reqs,

    };

  }

  if (flat.includes('Application startup complete')) {

    return { phase: 'ready', status: 'ready' };

  }

  if (/Ollama API ready on port\s+\d+/i.test(flat)) {

    return { phase: 'ready', status: 'ready' };

  }

  const llamaBuildMatches = [...flat.matchAll(/\[\s*(\d{1,3})%\]\s*(?:Building|Linking)/gi)];

  if (llamaBuildMatches.length) {

    const pct = Math.min(100, parseInt(llamaBuildMatches[llamaBuildMatches.length - 1][1], 10));

    return { phase: `building llama.cpp ${pct}%`, status: 'running', pct };

  }

  if (/Native llama-server not found|building from source/i.test(flat)) {

    if (/Cloning into ['"]?llama\.cpp/i.test(flat) && !/Receiving objects:\s*100%/i.test(flat)) {

      return { phase: 'cloning llama.cpp', status: 'running' };

    }

    if (/Configuring incomplete|CMake Error/i.test(flat)) {

      return {};

    }

    if (/CMAKE_BUILD_TYPE|Detecting CXX|Found Threads|Including CPU backend|CUDA nvcc found|building llama-server/i.test(flat)) {

      return { phase: 'configuring llama.cpp', status: 'running' };

    }

    return { phase: 'building llama.cpp', status: 'running' };

  }

  // HTTP 访问日志（如 GET /v1/models 200 OK）表示服务器已启动

  if (/(?:GET|POST)\s+\/[^\s]*\s+HTTP\/[\d.]+"\s*\d{3}/.test(flat)) {

    return { phase: 'idle', status: 'ready' };

  }

  if (flat.includes('Loading weights took')) {

    return { phase: 'initializing', status: 'running' };

  }

  // 单独的 "GPU KV cache"（分配阶段）—— 不是 "GPU KV cache usage"（运行时日志）

  if (flat.includes('GPU KV cache') && !flat.includes('GPU KV cache usage')) {

    return { phase: 'warming up', status: 'running' };

  }

  if (loadMatches.length) {

    const pct = parseInt(loadMatches[loadMatches.length - 1][1]);

    return { phase: `loading ${pct}%`, status: 'running', pct };

  }

  if (dlMatches.length) {

    const pct = parseInt(dlMatches[dlMatches.length - 1][1]);

    return { phase: `downloading ${pct}%`, status: 'running', pct };

  }

  return {};

}



// ── 端口自动递增 ──



function _nextAvailablePort() {

  const tasks = _loadTasks();

  const presets = _loadPresets();

  const usedPorts = new Set();

  tasks.forEach(t => {

    if (t.type === 'serve' && (t.status === 'running' || t.status === 'queued')) {

      const m = t.payload?._cmd?.match(/--port\s+(\d+)/);

      if (m) usedPorts.add(parseInt(m[1]));

    }

  });

  presets.forEach(p => {

    if (p.port) usedPorts.add(parseInt(p.port));

  });

  let port = 8000;

  while (usedPorts.has(port)) port++;

  return String(port);

}



// ── 端点清理 ──



async function _removeEndpointByUrl(baseUrl) {

  try {

    const res = await fetch('/api/model-endpoints', { credentials: 'same-origin' });

    if (!res.ok) return;

    const endpoints = await res.json();

    const hostPort = baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    const ep = endpoints.find(e => e.base_url === baseUrl)

            || endpoints.find(e => e.base_url.includes(hostPort));

    if (ep) {

      await fetch(`/api/model-endpoints/${ep.id}`, { method: 'DELETE', credentials: 'same-origin' });

      _refreshModelsAfterEndpointChange();

    }

  } catch {}

}



function _refreshModelsAfterEndpointChange() {

  const pickerLabel = document.getElementById('model-picker-label');

  if (pickerLabel) {

    pickerLabel.dataset.prevHtml = pickerLabel.innerHTML;

    pickerLabel.innerHTML = '<span style="opacity:0.4;">' + t('cookbook.refreshing') + '</span>';

  }

  if (window.modelsModule && window.modelsModule.refreshModels) {

    window.modelsModule.refreshModels(true);

  }

  setTimeout(() => {

    if (!window.sessionModule) return;

    const currentModel = window.sessionModule.getCurrentModel ? window.sessionModule.getCurrentModel() : null;

    if (currentModel) {

      const items = (window.modelsModule && window.modelsModule.getCachedItems) ? window.modelsModule.getCachedItems() : [];

      const allModels = [];

      items.forEach(item => {

        if (item.offline) return;

        (item.models || []).concat(item.models_extra || []).forEach(m => allModels.push({ mid: m, url: item.url, endpointId: item.endpoint_id }));

      });

      const stillExists = allModels.some(m => m.mid === currentModel);

      if (!stillExists && allModels.length > 0) {

        const fallback = allModels[0];

        if (window.sessionModule.createDirectChat) {

          window.sessionModule.createDirectChat(fallback.url, fallback.mid, fallback.endpointId);

        }

      }

    }

    if (window.sessionModule.updateModelPicker) {

      window.sessionModule.updateModelPicker();

    }

  }, 1500);

}



function _appendCookbookEndpointScope(fd, remoteHost) {

  const host = String(remoteHost || '').trim();

  if (!host || host === 'local' || host === 'localhost' || host === '127.0.0.1') {

    fd.append('container_local', 'true');

  }

}



function _connectHostFromRemote(remoteHost, fallback = 'localhost') {

  const host = String(remoteHost || '').trim();

  if (!host || host === 'local') return fallback;

  return host.includes('@') ? host.split('@').pop() : host;

}



function _isAnyBindHost(host) {

  const h = String(host || '').trim().toLowerCase();

  return h === '0.0.0.0' || h === '::' || h === '[::]';

}



function _endpointFromAdvertisedUrl(rawUrl, currentHost, fallbackPort = '11434') {

  try {

    const u = new URL(rawUrl);

    const host = _isAnyBindHost(u.hostname) ? currentHost : (u.hostname || currentHost);

    const port = u.port || fallbackPort;

    const bracketedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

    return { host, port, baseUrl: `${u.protocol}//${bracketedHost}${port ? `:${port}` : ''}/v1` };

  } catch {

    return null;

  }

}



// ── 下载队列——每台服务器一次只运行一个 ──



function _processQueue() {

  const tasks = _loadPrunedTasks();

  const running = tasks.filter(t => t.type === 'download' && t.status === 'running');

  const queued = tasks.filter(t => t.type === 'download' && t.status === 'queued');

  if (!queued.length) return;



  const busyHosts = new Set(running.map(t => t.remoteHost || 'local'));



  for (const task of queued) {

    const host = task.remoteHost || 'local';

    if (busyHosts.has(host)) continue;

    busyHosts.add(host);

    _startQueuedDownload(task);

  }

}



async function _startQueuedDownload(task) {

  if (!task.payload) {

    _updateTask(task.sessionId, { status: 'error', output: 'No payload' });

    _renderRunningTab();

    return;

  }

  // 同步切换为 'running'（在异步 POST 之前），以防止

  // 并发的 _processQueue 或第二个 "Start now"

  // 仍将其视为 'queued' 并再次启动同一个下载。没有这个步骤，

  // 在 POST 过程中完成另一个下载会重新将此任务重新排队为重复任务。

  {

    const _pre = _loadTasks();

    const _pt = _pre.find(t => t.sessionId === task.sessionId);

    if (_pt) {

      if (_pt.status === 'running' && _pt._startLaunched) return;  // 已在启动中

      _pt.status = 'running';

      _pt._startLaunched = true;

      _saveTasks(_pre);

    }

  }

  try {

    const res = await fetch('/api/model/download', {

      method: 'POST', credentials: 'same-origin',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify(task.payload),

    });

    if (!res.ok) {

      const errText = await res.text().catch(() => '');

      _updateTask(task.sessionId, { status: 'error', output: `HTTP ${res.status}: ${errText.slice(0, 200)}` });

      _renderRunningTab();

      return;

    }

    const data = await res.json();

    if (!data.ok) {

      _updateTask(task.sessionId, { status: 'error', output: data.error || 'Unknown error' });

      _renderRunningTab();

      return;

    }

    const oldId = task.sessionId;

    const launchedTask = { ...task, sessionId: data.session_id, id: data.session_id, status: 'running' };

    const key = _downloadDedupeKey(launchedTask);

    let found = false;

    const tasks = _loadTasks().filter(t => {

      if (t.sessionId === oldId) {

        found = true;

        t.sessionId = data.session_id;

        t.id = data.session_id;

        t.status = 'running';

        t._startLaunched = true;

        return true;

      }

      if (t.sessionId === data.session_id) return false;

      return !(key && t.type === 'download' && t.status === 'queued' && _downloadDedupeKey(t) === key);

    });

    if (!found) tasks.push(_stripTaskSecrets(launchedTask));

    _saveTasks(tasks);

    _renderRunningTab();

    _startBackgroundMonitor();

    await new Promise(r => setTimeout(r, 2000));

    _renderRunningTab();

  } catch (e) {

    _updateTask(task.sessionId, { status: 'error', output: e.message || 'Network error' });

    _renderRunningTab();

  }

}



// ── 任务 CRUD ──



function _serveOutputLooksReady(task) {

  const out = String(task?.output || '');

  return !!task?._serveReady

    || /Application startup complete/i.test(out)

    || /Ollama API ready on port\s+\d+/i.test(out)

    || /(?:GET|POST)\s+\/[^\s]*\s+HTTP\/[\d.]+"\s*2\d\d/i.test(out);

}



function _normalizeTaskForDisplay(task) {

  if (!task || typeof task !== 'object') return task;

  // Pip 任务（Reinstall vLLM / Upgrade torch / 等）借用了 serve 任务类型

  // 以便获得 tmux + Running 标签页。它们不是 serve —— 它们的

  // "ready" 标记是 pip 的 `Successfully installed` / `Requirement already

  // satisfied`，而不是 "Application startup complete"。

  const _isPipTask = ((task.payload?.repo_id || '').startsWith('pip-'))

    || /python3? -m pip\b/.test(task.payload?._cmd || '');

  if (_isPipTask) {

    // 覆盖过期状态：任何输出中包含 pip 自身成功标记的 pip 任务

    // 无论 localStorage 中存储了什么，都显示为 `done`。旧版的修复前运行

    // 会停留在 error/stopped 状态，即使我们之后已经教会了流程的其余部分

    // 关于 pip 任务的知识——这是一个通用的补丁，在渲染时将其翻转为 Finished。

    const out = String(task.output || '');

    const ranOk = /Successfully installed|Requirement already (?:satisfied|up-to-date)/i.test(out)

      && !/error:|ERROR:/.test(out.slice(-1024));

    if (ranOk && task.status !== 'done' && task.status !== 'running') {

      return { ...task, status: 'done' };

    }

    return task;

  }

  if (task.type === 'serve' && task.status === 'done' && !_serveOutputLooksReady(task)) {

    return { ...task, status: 'error' };

  }

  return task;

}



export function _loadTasks() {

  try { return (JSON.parse(localStorage.getItem(TASKS_KEY)) || []).map(_normalizeTaskForDisplay); }

  catch { return []; }

}



function _downloadRepoKey(task) {

  return String(task?.payload?.repo_id || task?.repo_id || task?.repo || task?.name || '').trim();

}



function _downloadHostKey(task) {

  return String(task?.remoteHost || task?.payload?.remote_host || 'local').trim() || 'local';

}



function _downloadDedupeKey(task) {

  if (!task || task.type !== 'download') return '';

  const repo = _downloadRepoKey(task);

  if (!repo) return '';

  return `${_downloadHostKey(task)}\n${repo}`;

}



function _pruneQueuedDownloadDuplicates(tasks) {

  if (!Array.isArray(tasks) || !tasks.length) return tasks || [];

  const launched = new Set();

  for (const task of tasks) {

    if (task?.type !== 'download' || task.status === 'queued') continue;

    const key = _downloadDedupeKey(task);

    if (key) launched.add(key);

  }



  let changed = false;

  const seenQueued = new Set();

  const next = tasks.filter(task => {

    if (task?.type !== 'download' || task.status !== 'queued') return true;

    const key = _downloadDedupeKey(task);

    if (!key) return true;

    if (launched.has(key) || seenQueued.has(key)) {

      changed = true;

      return false;

    }

    seenQueued.add(key);

    return true;

  });

  return changed ? next : tasks;

}



function _loadPrunedTasks() {

  const tasks = _loadTasks();

  const pruned = _pruneQueuedDownloadDuplicates(tasks);

  if (pruned !== tasks) _saveTasks(pruned);

  return pruned;

}



// 已删除任务的墓碑记录。否则，删除任务仅会本地删除——

// 但服务器仍然持有该任务（其自身的 POST 防护甚至会重新保留

// 最近添加的任务），所以下一次同步/轮询会将其合并回来（"我删除了但

// 它又回来了"）。墓碑确保删除持久化：合并时跳过用户

// 删除的任何 ID，直到该条目过期。

const _REMOVED_KEY = 'cookbook-removed-tasks';

const _TOMBSTONE_TTL_MS = 24 * 3600 * 1000;

function _loadTombstones() {

  try { return JSON.parse(localStorage.getItem(_REMOVED_KEY)) || {}; }

  catch { return {}; }

}

function _tombstoneTask(id) {

  if (!id) return;

  const tomb = _loadTombstones();

  const now = Date.now();

  tomb[id] = now;

  for (const k in tomb) { if (now - tomb[k] > _TOMBSTONE_TTL_MS) delete tomb[k]; }

  localStorage.setItem(_REMOVED_KEY, JSON.stringify(tomb));

}

function _isTombstoned(id) {

  const ts = _loadTombstones()[id];

  return ts != null && (Date.now() - ts) <= _TOMBSTONE_TTL_MS;

}



function _stripTaskSecrets(task) {

  if (!task || typeof task !== 'object') return task;

  const safe = { ...task };

  if (safe.payload && typeof safe.payload === 'object') {

    safe.payload = { ...safe.payload };

    delete safe.payload.hf_token;

  }

  return safe;

}



function _stripStateSecrets(state) {

  const safe = { ...state };

  if (safe.env && typeof safe.env === 'object') {

    const { hfToken, ...env } = safe.env;

    if (hfToken) env.hfToken = hfToken;

    safe.env = env;

  }

  if (Array.isArray(safe.tasks)) safe.tasks = safe.tasks.map(_stripTaskSecrets);

  return safe;

}



export function _saveTasks(tasks) {

  localStorage.setItem(TASKS_KEY, JSON.stringify((tasks || []).map(_stripTaskSecrets)));

  _syncToServer();

}



export function _addTask(sessionId, name, type, payload) {

  let tasks = _loadTasks();

  const remoteHost = (payload && payload.remote_host) || _envState.remoteHost || '';

  const sshPort = (payload && payload.ssh_port) || _getPort(remoteHost) || '';

  const platform = (payload && payload.platform) || _getPlatform(remoteHost) || '';

  // 启动模型服务会取代该模型的已完成下载——清除匹配的

  // 已完成下载卡片（覆盖直接从 Serve 标签页启动的情况，而不仅仅

  // 是通过下载卡片的 "Serve →" 按钮启动）。

  if (type === 'serve' && payload && payload.repo_id) {

    const _repoId = payload.repo_id;

    tasks = tasks.filter(t => !(t.type === 'download' && t.status === 'done' && t.payload && t.payload.repo_id === _repoId));

  }

  if (type === 'download' && payload && payload.repo_id) {

    const key = _downloadDedupeKey({ type: 'download', payload, remoteHost });

    tasks = tasks.filter(t => {

      if (t.sessionId === sessionId) return false;

      return !(key && t.type === 'download' && t.status === 'queued' && _downloadDedupeKey(t) === key);

    });

  }

  const task = _stripTaskSecrets({ id: sessionId, sessionId, name, type, status: 'running', output: '', ts: Date.now(), payload: payload || null, remoteHost, sshPort, platform });

  tasks.push(task);

  _saveTasks(tasks);

  // 新操作 → 折叠所有其他卡片，仅保留当前卡片展开。

  _soloExpandTaskId = sessionId;

  _renderRunningTab();

  // 添加任务时始终启动后台监控——即使模态框关闭

  // 也能工作，确保侧边栏立即显示实时状态

  _startBackgroundMonitor();

  // 切换到 Running 标签页

  const body = document.querySelector('#cookbook-modal .cookbook-body');

  if (body) {

    const tab = body.querySelector('.cookbook-tab[data-backend="Running"]');

    if (tab) tab.click();

  }

  return task;

}



function _updateTask(sessionId, updates) {

  const tasks = _loadTasks();

  const task = tasks.find(t => t.sessionId === sessionId);

  if (task) {

    Object.assign(task, updates);

    _saveTasks(tasks);

  }

  if ('status' in updates || '_unreachable' in updates) {

    _refreshServerDots();

  }

  if (updates.status && updates.status !== 'running') {

    const el = document.querySelector(`.cookbook-task[data-task-id="${sessionId}"]`);

    if (el) {

      if (el._uptimeInterval) { clearInterval(el._uptimeInterval); el._uptimeInterval = null; }

      const wave = el.querySelector('.cookbook-task-wave');

      if (wave) wave.style.display = 'none';

      const uptime = el.querySelector('.cookbook-task-uptime');

      if (uptime) uptime.style.display = 'none';

    }

  }

}



function _refreshDepsAfterInstall(task) {

  if (!task || task.type !== 'download' || !task.payload?._dep) return;

  try {

    _refreshDependencies?.({ host: task.remoteHost || '', port: task.sshPort || '', venv: task.payload?.env_path || '' });

  } catch {}

}



export function _removeTask(sessionId) {

  _tombstoneTask(sessionId);  // so sync/poll can't resurrect it

  const tasks = _loadTasks().filter(t => t.sessionId !== sessionId);

  _saveTasks(tasks);

  _renderRunningTab();

}



// 让任务卡片淡出/滑出，然后移除——这样无论是任务自动停止还是

// 用户手动移除/终止，平滑的退出动画都保持一致。

function _animateOutThenRemove(el, sessionId) {

  if (!el || !el.style) { _removeTask(sessionId); return; }

  if (el._abort) el._abort.abort();

  el.style.transition = 'opacity 0.35s ease, transform 0.35s ease';

  el.style.opacity = '0';

  el.style.transform = 'translateX(-10px)';

  setTimeout(() => _removeTask(sessionId), 360);

}



// ── tmux / Windows 会话命令 ──



export function _tmuxCmd(task, tmuxArgs) {

  if (_isWindows(task)) {

    return _winSessionCmd(task, tmuxArgs);

  }

  if (task.remoteHost) {

    return `ssh ${_sshPrefix(_getPort(task))}${task.remoteHost} 'tmux ${tmuxArgs}' 2>/dev/null`;

  }

  return `tmux ${tmuxArgs} 2>/dev/null`;

}



function _winSessionCmd(task, tmuxArgs) {

  const host = task.remoteHost;

  const sd = host ? '$env:TEMP\\odysseus-sessions' : '$env:TEMP\\odysseus-tmux';

  const sid = task.sessionId;

  const pf = _sshPrefix(_getPort(task));

  if (tmuxArgs.includes('capture-pane')) {

    const lines = tmuxArgs.match(/-S\s*-?(\d+)/)?.[1] || '200';

    const ps = host

      ? `Get-Content '${sd}\\${sid}.log' -Tail ${lines} -ErrorAction SilentlyContinue`

      : `Get-Content (Join-Path $env:TEMP 'odysseus-tmux\\${sid}.log') -Tail ${lines} -ErrorAction SilentlyContinue`;

    return host ? `ssh ${pf}${host} "powershell -Command \\"${ps}\\""` : `powershell -Command "${ps}"`;

  }

  if (tmuxArgs.includes('has-session')) {

    const ps = host

      ? `$p = Get-Content '${sd}\\${sid}.pid' -ErrorAction SilentlyContinue; if ($p) { Get-Process -Id $p -ErrorAction SilentlyContinue | Out-Null; if ($?) { exit 0 } else { exit 1 } } else { exit 1 }`

      : `$p = Get-Content (Join-Path $env:TEMP 'odysseus-tmux\\${sid}.pid') -ErrorAction SilentlyContinue; if ($p) { Get-Process -Id $p -ErrorAction SilentlyContinue | Out-Null; if ($?) { exit 0 } else { exit 1 } } else { exit 1 }`;

    return host ? `ssh ${pf}${host} "powershell -Command \\"${ps}\\""` : `powershell -Command "${ps}"`;

  }

  if (tmuxArgs.includes('kill-session')) {

    const ps = host

      ? `$p = Get-Content '${sd}\\${sid}.pid' -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; Remove-Item '${sd}\\${sid}.*' -Force -ErrorAction SilentlyContinue`

      : `$p = Get-Content (Join-Path $env:TEMP 'odysseus-tmux\\${sid}.pid') -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; Remove-Item (Join-Path $env:TEMP 'odysseus-tmux\\${sid}.*') -Force -ErrorAction SilentlyContinue`;

    return host ? `ssh ${pf}${host} "powershell -Command \\"${ps}\\""` : `powershell -Command "${ps}"`;

  }

  if (tmuxArgs.includes('send-keys') && tmuxArgs.includes('C-c')) {

    const ps = host

      ? `$p = Get-Content '${sd}\\${sid}.pid' -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p -ErrorAction SilentlyContinue }`

      : `$p = Get-Content (Join-Path $env:TEMP 'odysseus-tmux\\${sid}.pid') -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p -ErrorAction SilentlyContinue }`;

    return host ? `ssh ${pf}${host} "powershell -Command \\"${ps}\\""` : `powershell -Command "${ps}"`;

  }

  return host ? `ssh ${pf}${host} 'tmux ${tmuxArgs}' 2>/dev/null` : `tmux ${tmuxArgs} 2>/dev/null`;

}



function _tmuxGracefulKill(task) {

  if (_isWindows(task)) {

    const host = task.remoteHost;

    const sd = host ? '$env:TEMP\\odysseus-sessions' : '$env:TEMP\\odysseus-tmux';

    const sid = task.sessionId;

    const pf = _sshPrefix(_getPort(task));

    const ps = host

      ? `$p = Get-Content '${sd}\\${sid}.pid' -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; Remove-Item '${sd}\\${sid}.*' -Force -ErrorAction SilentlyContinue`

      : `$p = Get-Content (Join-Path $env:TEMP 'odysseus-tmux\\${sid}.pid') -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; Remove-Item (Join-Path $env:TEMP 'odysseus-tmux\\${sid}.*') -Force -ErrorAction SilentlyContinue`;

    return host ? `ssh ${pf}${host} "powershell -Command \\"${ps}\\""` : `powershell -Command "${ps}"`;

  }

  if (task.remoteHost) {

    return `ssh ${_sshPrefix(_getPort(task))}${task.remoteHost} 'tmux send-keys -t ${task.sessionId} C-c 2>/dev/null; sleep 2; tmux kill-session -t ${task.sessionId} 2>/dev/null'`;

  }

  return `tmux send-keys -t ${task.sessionId} C-c 2>/dev/null; sleep 2; tmux kill-session -t ${task.sessionId} 2>/dev/null`;

}



function _shQuote(value) {

  return "'" + String(value ?? '').replace(/'/g, "'\\''") + "'";

}



function _taskLooksOllama(task, outputText = '') {

  const haystack = `${task?.payload?.backend || ''} ${task?.payload?._cmd || ''} ${task?.payload?._fields?.backend || ''} ${outputText || ''}`;

  return /\bollama\b/i.test(haystack) || /Ollama API ready on port\s+\d+/i.test(haystack);

}



function _ollamaBaseUrlForTask(task, outputText = '') {

  const out = String(outputText || '');

  const ready = out.match(/Ollama API ready on port\s+\d+:\s*(http:\/\/[^\s]+)/i);

  if (ready) return ready[1].replace(/\/+$/, '');

  const cmd = String(task?.payload?._cmd || '');

  const host = cmd.match(/OLLAMA_HOST=([^\s]+)/)?.[1] || '';

  const port = host.match(/:(\d+)$/)?.[1] || '11434';

  return `http://127.0.0.1:${port}`;

}



function _ollamaModelForTask(task) {

  return String(task?.payload?.model || task?.payload?.repo_id || task?.name || '').trim();

}



function _ollamaUnloadCommand(task, outputText = '') {

  if (!_taskLooksOllama(task, outputText)) return '';

  const model = _ollamaModelForTask(task);

  if (!model) return '';

  const base = _ollamaBaseUrlForTask(task, outputText);

  const body = JSON.stringify({ model, prompt: '', keep_alive: 0, stream: false });

  const inner = `curl -sf -X POST ${_shQuote(base + '/api/generate')} -H 'Content-Type: application/json' -d ${_shQuote(body)} >/dev/null 2>&1 || true`;

  if (task.remoteHost) {

    return `ssh ${_sshPrefix(_getPort(task))}${task.remoteHost} ${_shQuote(inner)}`;

  }

  return inner;

}



function _endpointUrlForTask(task, outputText = '') {

  if (_taskLooksOllama(task, outputText)) {

    return _ollamaBaseUrlForTask(task, outputText) + '/v1';

  }

  const host = _connectHostFromRemote(task.remoteHost);

  const portMatch = task.payload?._cmd?.match(/--port\s+(\d+)/);

  const port = portMatch ? portMatch[1] : '8000';

  return `http://${host}:${port}/v1`;

}



// ── 波浪动画 ──



const _waveFrames = ['▁▂▃', '▂▃▄', '▃▄▅', '▄▅▆', '▅▆▅', '▆▅▄', '▅▄▃', '▄▃▂', '▃▂▁'];

let _waveIdx = 0;

let _waveTimer = null;

const _waveEls = new Set();



function _startWaveSync() {

  if (_waveTimer) return;

  _waveTimer = setInterval(() => {

    _waveIdx = (_waveIdx + 1) % _waveFrames.length;

    for (const el of _waveEls) {

      if (!el.isConnected) { _waveEls.delete(el); continue; }

      if (el.style.display !== 'none') el.textContent = _waveFrames[_waveIdx];

    }

    if (!_waveEls.size) { clearInterval(_waveTimer); _waveTimer = null; }

  }, 200);

}



function _registerWaveEl(el) { _waveEls.add(el); _startWaveSync(); }



// ── 通知 ──



function _showCookbookNotif(isError = false) {

  const dot = document.getElementById('cookbook-notif-dot');

  if (dot) {

    dot.style.display = '';

    dot.classList.toggle('cookbook-notif-error', isError);

  }

  const btn = document.getElementById('tool-cookbook-btn');

  if (btn) { btn.style.opacity = '1'; btn.classList.add('cookbook-notif-active'); }

  const railBtn = document.getElementById('rail-cookbook');

  if (railBtn) {

    railBtn.classList.remove('rail-notify-success', 'rail-notify-error');

    railBtn.classList.add('rail-notify', isError ? 'rail-notify-error' : 'rail-notify-success', 'cookbook-notif-active');

  }

  if (window._syncRailDynamic) window._syncRailDynamic();

}



export function _clearCookbookNotif() {

  const dot = document.getElementById('cookbook-notif-dot');

  if (dot) dot.style.display = 'none';

  const btn = document.getElementById('tool-cookbook-btn');

  if (btn) { btn.style.opacity = ''; btn.classList.remove('cookbook-notif-active'); }

  const railBtn = document.getElementById('rail-cookbook');

  if (railBtn) {

    railBtn.classList.remove('rail-notify', 'rail-notify-success', 'cookbook-notif-active');

  }

  if (window._syncRailDynamic) window._syncRailDynamic();

}



// ── 预设帮助函数（用于从任务保存预设）──



// 预设必须携带 venv + 激活的 GPU，而不仅仅是命令——没有这些信息

// 重新启动时就没有激活环境和 GPU 绑定，导致保存时正常工作的配置

// 重新加载时失败。从启动负载（_env/_envPath/_gpus，由

// _launchServeTask 捕获）中提取这些信息并合并到 Serve 面板

// 恢复时的 serve-form `fields` 中。

function _presetEnvFields(task) {

  const p = task.payload || {};

  const fields = { ...(p._fields || {}) };

  // 服务面板的 venv 字段是路径；conda/venv 均从此激活。

  if (p._envPath && (p._env === 'venv' || p._env === 'conda')) fields.venv = fields.venv || p._envPath;

  if (p._gpus) fields.gpus = p._gpus;

  return {

    fields: Object.keys(fields).length ? fields : undefined,

    env: p._env || '',

    envPath: p._envPath || '',

    gpus: p._gpus || '',

  };

}



function _saveTaskAsPreset(task, label) {

  const host = task.remoteHost || 'localhost';

  const portMatch = task.payload?._cmd?.match(/--port\s+(\d+)/);

  const port = portMatch ? portMatch[1] : '8000';

  const presets = _loadPresets();

  if (presets.some(p => p.cmd === task.payload._cmd)) return false;

  presets.push({ name: task.name, model: task.payload.repo_id, backend: 'vllm', host, port, cmd: task.payload._cmd, remoteHost: task.remoteHost || '', label: label || task.name, ..._presetEnvFields(task) });

  _savePresets(presets);

  return true;

}



// 与 cookbookServe 的 _presetsForModel 使用相同的模型匹配逻辑，

// 因此自动保存的计数与 Serve 标签页为该模型显示的预设槽位数完全一致。

function _presetsForModelLocal(presets, repo) {

  const short = (repo || '').split('/').pop();

  return presets.filter(p => {

    const pm = p.model || '', pn = p.name || '';

    return pm === repo || pn === repo || pm.split('/').pop() === short || pn === short;

  });

}



// 根据启动命令构建简短的自动标签，以便自动保存的配置

// 在 Saved 下拉列表中可识别（例如 "TP2 · 16k ctx · AWQ"）。

function _autoConfigLabel(task) {

  const cmd = task.payload?._cmd || '';

  const bits = [];

  const tp = cmd.match(/--tensor-parallel-size[=\s]+(\d+)/);

  if (tp && tp[1] !== '1') bits.push('TP' + tp[1]);

  const ml = cmd.match(/--max-model-len[=\s]+(\d+)/);

  if (ml) { const n = parseInt(ml[1]); bits.push((n >= 1024 ? Math.round(n / 1024) + 'k' : n) + ' ctx'); }

  const q = (task.name || '').match(/AWQ|GPTQ|FP8|Q4|Q5|Q6|Q8|INT8|INT4/i);

  if (q) bits.push(q[0].toUpperCase());

  return bits.length ? bits.join(' · ') : 'working';

}



// 自动保存 serve 配置——当其端点成功注册时立即保存，并标记为

// 已确认可用。按精确命令去重：如果相同的设置已经保存，

// 我们只升级该槽位的徽章，而不是创建重复项。

// 每任务最多运行一次。

function _autoSaveWorkingConfig(task) {

  if (!task || task.type !== 'serve' || !task.payload?._cmd) return;

  if (task._autoSaved) return;

  const cmd = task.payload._cmd;

  // Diffusion/image 服务器非 vLLM 预设——跳过。

  if (cmd.includes('diffusion_server')) { task._autoSaved = true; return; }

  const model = task.payload.repo_id || task.name;

  const presets = _loadPresets();

  const existing = presets.find(p => p.cmd === cmd);

  if (existing) {

    task._autoSaved = true;

    if (!existing.confirmedWorking) { existing.confirmedWorking = true; _savePresets(presets); }

    return;   // 已保存 → 仅确认可用，不创建重复项，不显示提示

  }

  // 遵守手动保存流程的每模型上限（最多 5 个）。

  if (_presetsForModelLocal(presets, model).length >= 5) { task._autoSaved = true; return; }

  const host = task.remoteHost || 'localhost';

  const portMatch = cmd.match(/--port[=\s]+(\d+)/);

  const port = portMatch ? portMatch[1] : '8000';

  presets.push({

    name: task.name, model, backend: 'vllm', host, port,

    cmd, remoteHost: task.remoteHost || '',

    label: _autoConfigLabel(task), confirmedWorking: true, autoSaved: true,

    ..._presetEnvFields(task),

  });

  _savePresets(presets);

  task._autoSaved = true;

  uiModule.showToast('Saved working config');

}



// ── 跨设备同步 ──



let _syncTimer = null;

function _syncToServer() {

  // 防抖以合并批量写入，同时保持低延迟，使服务器在不同设备间

  // 有效地保持权威

  clearTimeout(_syncTimer);

  _syncTimer = setTimeout(async () => {

    try {

      // 不要推送尚未初始化的状态。合法的状态始终至少有

      // "Local" 服务器，因此空的 servers 列表意味着我们在

      // GET /state 填充 _envState 之前就加载了——此时同步会清除

      // 已保存的服务器配置。（服务器端也有防护；这里只是避免

      // 不必要的往返。）

      if (!_envState || !Array.isArray(_envState.servers) || _envState.servers.length === 0) return;

      const state = {

        tasks: _loadTasks(),

        presets: _loadPresets(),

        env: _envState,

        serveState: null,

      };

      try { state.serveState = JSON.parse(localStorage.getItem(SERVE_STATE_KEY)); } catch {}

      await fetch('/api/cookbook/state', {

        method: 'POST', credentials: 'same-origin',

        headers: { 'Content-Type': 'application/json' },

        body: JSON.stringify(_stripStateSecrets(state)),

      });

    } catch {}

  }, 400);

}



// 规范化来自服务器的状态：将旧版重复键合并到规范形式。

// - server.modelDir（单数）→ server.modelDirs[0]（规范形式）

// - 清除 modelDirs 中的 ✕/✖ 污染

// - 去重 modelDirs

function _normalizeState(state) {

  if (!state || typeof state !== 'object') return state;

  if (state.env && Array.isArray(state.env.servers)) {

    for (const s of state.env.servers) {

      // 将旧版 modelDir 合并到 modelDirs

      let dirs = Array.isArray(s.modelDirs) ? s.modelDirs : [];

      if (s.modelDir && !dirs.includes(s.modelDir)) dirs.push(s.modelDir);

      dirs = dirs

        .map(d => (d || '').replaceAll('\u2715', '').replaceAll('\u2716', '').trim())

        .filter(Boolean);

      if (!dirs.includes('~/.cache/huggingface/hub')) dirs.unshift('~/.cache/huggingface/hub');

      s.modelDirs = [...new Set(dirs)];

      delete s.modelDir; // 删除旧版的单数形式

      // 下载目标不再在目录列表中的，回退到默认 HF 缓存（空），

      // 这样永远不会下载到未扫描的目录中。

      if (s.downloadDir && !s.modelDirs.includes(s.downloadDir)) s.downloadDir = '';

    }

  }

  return state;

}



export async function _syncFromServer() {

  try {

    const res = await fetch('/api/cookbook/state', { credentials: 'same-origin' });

    if (!res.ok) return false;

    const state = _normalizeState(await res.json());

    if (!state || !state.env) return false;



    const localTasks = _loadTasks();

    const serverTasks = state.tasks || [];



    const localIds = new Set(localTasks.map(t => t.sessionId));

    const merged = [...localTasks];

    for (const t of serverTasks) {

      if (!localIds.has(t.sessionId) && !_isTombstoned(t.sessionId)) {

        merged.push(t);

      }

    }

    localStorage.setItem(TASKS_KEY, JSON.stringify(merged.map(_stripTaskSecrets)));



    if (state.env) {

      // 活跃的服务器选择（remoteHost 及其 env/path/platform）是

      // 每设备、实时选择。决不能允许服务器存储的副本在此处覆盖

      //——否则会悄悄将活跃的主机切回服务器端保存的值，

      // 导致下载/扫描忽略用户刚刚选择的目标。

      // 仅同步共享的非机密设置（服务器列表、GPU、路径）。

      const { remoteHost: _rh, env: _e, envPath: _ep, platform: _pf, ...settings } = state.env;

      delete settings.hfToken;

      Object.assign(_envState, settings);

      const { hfToken, ...safeState } = _envState;

      localStorage.setItem('cookbook-last-state', JSON.stringify(safeState));

    }

    if (state.presets) {

      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.presets));

    }

    if (state.serveState) {

      localStorage.setItem(SERVE_STATE_KEY, JSON.stringify(state.serveState));

    }

    return true;

  } catch { return false; }

}



// ── 重试下载 ──



// 下载的有界自动重试计数器，按模型索引——大型多文件下载的网络波动

// 很常见，HF 可以从 .incomplete 的缓存部分继续下载。

const _dlRetryCount = new Map();

const _DL_MAX_AUTO_RETRY = 2;



// 终止并重新启动任务（下载或 serve）。供 ⋮ → Restart 操作

// 和停滞下载徽章的点击重试共用。

async function _retryTask(el, task) {

  if (el && el._abort) el._abort.abort();

  const badge = el?.querySelector('.cookbook-task-status');

  if (badge) { badge.textContent = t('cookbook.restarting'); badge.className = 'cookbook-task-status'; }

  try {

    await fetch('/api/shell/exec', {

      method: 'POST', credentials: 'same-origin',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ command: _tmuxGracefulKill(task) }),

    });

  } catch {}

  if (task.payload) {

    if (task.type === 'serve' && task.payload._cmd) {

      _removeTask(task.sessionId);

      _launchServeTask(task.name, task.payload.repo_id, task.payload._cmd, task.payload._fields, task.remoteHost || '');

    } else {

      uiModule.showToast('Retrying download — progress may look reset while HuggingFace checks cached files, then it should resume.', 7000);

      _updateTask(task.sessionId, {

        status: 'running',

        output: `${task.output || ''}\n\n[odysseus] Retrying download. Progress may briefly look like a fresh download while HuggingFace checks cached/incomplete files; cached partial files will be reused when available.`.trim(),

        _retrying: true,

      });

      _retryDownload(task.name, task.payload, task.sessionId);

    }

  }

}



async function _retryDownload(name, payload, replaceSessionId = '') {

  try {

    // 重试意味着快速 hf_transfer 路径已经失败过一次——回退到

    // 普通的可靠下载器来完成本次及后续尝试（它会从缓存

    // 的 .incomplete 文件继续下载，因此不会丢失进度）。

    const _payload = { ...(payload || {}), disable_hf_transfer: true };

    const res = await fetch('/api/model/download', {

      method: 'POST', credentials: 'same-origin',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify(_payload),

    });

    if (!res.ok) {

      uiModule.showToast('Download failed: HTTP ' + res.status);

      if (replaceSessionId) _updateTask(replaceSessionId, { status: 'crashed', _retrying: false });

      return;

    }

    const data = await res.json();

    if (!data.ok) {

      uiModule.showToast('Download failed: ' + (data.error || ''));

      if (replaceSessionId) _updateTask(replaceSessionId, { status: 'crashed', _retrying: false });

      return;

    }

    if (replaceSessionId) {

      const tasks = _loadTasks();

      const task = tasks.find(t => t.sessionId === replaceSessionId);

      if (task) {

        task.id = data.session_id;

        task.sessionId = data.session_id;

        task.status = 'running';

        task.output = '';

        task.ts = Date.now();

        task.payload = _payload;

        task._retrying = false;

        _saveTasks(tasks);

        _soloExpandTaskId = data.session_id;

        _renderRunningTab();

        _startBackgroundMonitor();

      } else {

        _addTask(data.session_id, name, 'download', _payload);

      }

    } else {

      _addTask(data.session_id, name, 'download', _payload);

    }

    uiModule.showToast(`Downloading ${name}...`);

  } catch (e) {

    uiModule.showToast('Download failed: ' + e.message);

    if (replaceSessionId) _updateTask(replaceSessionId, { status: 'crashed', _retrying: false });

  }

}



// ── Serve 自动修复（终止 + 使用环境变量重新启动）──



// 阻止堆叠重试：一旦某个任务点击了任何 "Retry with X"，

// 就忽略该任务后续的所有重试点击。每次重试都会触发自己的

// _launchServeTask，因此点击多个选项——或在淡出/加载期间重复点击

//——过去会堆叠启动多个服务器（例如 6 个实例）。

// 该标记位于卡片元素上（之后立即移除），因此无法重新激活。

function _guardServeRetry(panel, taskEl) {

  if (!taskEl || taskEl.dataset.retrying) return false;

  taskEl.dataset.retrying = '1';

  panel.querySelectorAll('button').forEach(b => {

    b.disabled = true;

    b.style.opacity = '0.5';

    b.style.pointerEvents = 'none';

  });

  return true;

}



export async function _serveAutoFix(panel, envVar) {

  const taskEl = panel.closest('.cookbook-task');

  if (!taskEl) return;

  const taskId = taskEl.dataset.taskId;

  const tasks = _loadTasks();

  const task = tasks.find(t => t.sessionId === taskId);

  if (!task || !task.payload) return;

  if (!_guardServeRetry(panel, taskEl)) return;



  const killCmd = _tmuxCmd(task, `kill-session -t ${taskId}`);

  try {

    await fetch('/api/shell/exec', {

      method: 'POST', credentials: 'same-origin',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ command: killCmd }),

    });

  } catch {}



  _animateOutThenRemove(taskEl, taskId);



  const origCmd = task.payload._cmd || '';

  const newCmd = `export ${envVar} && ${origCmd}`;



  const origHost = _envState.remoteHost;

  if (task.remoteHost) _envState.remoteHost = task.remoteHost;

  try {

    uiModule.showToast(`Retrying with ${envVar}...`);

    await _launchServeTask(task.name, task.payload.repo_id, newCmd);

  } finally {

    // 始终恢复——否则抛出的启动异常会导致全局 host 卡在

    // 该 serve 任务上，后续下载/扫描会受到影响。

    _envState.remoteHost = origHost;

  }

}



// 打开预填写任务信息的 Serve 面板——与任务的 Edit

// 按钮流程相同，但可选择带有修改后的命令（供诊断中的

// "Retry with X" 按钮使用，使重试以调整后的设置进入可编辑的

// Serve 面板，而不是盲目重新启动）。

async function _openServeEditForTask(task, cmdOverride, fieldOverrides = null) {

  const repo = task.payload?.repo_id;

  if (!repo) { uiModule.showToast('No model info on this task'); return; }

  const cmd = cmdOverride || task.payload?._cmd;

  // 修改过的命令必须重新解析；否则优先使用精确的启动字段。

  let fields = cmdOverride

    ? _parseServeCmdToFields(cmd)

    : (task.payload?._fields || (cmd ? _parseServeCmdToFields(cmd) : null));

  if (fieldOverrides && typeof fieldOverrides === 'object') {

    fields = { ...(fields || {}), ...fieldOverrides };

  }

  // 将活跃服务器切换为此 serve 实际运行的服务器（镜像 _openEdit）。

  const _tHost = task.remoteHost || '';

  _envState.remoteHost = _tHost;

  const _tSrv = _serverByVal(_envState.remoteServerKey || _tHost)

    || _envState.servers.find(s => s.host === _tHost);

  if (_tSrv) { _envState.env = _tSrv.env || 'none'; _envState.envPath = _tSrv.envPath || ''; _envState.platform = _tSrv.platform || ''; }

  else if (!_tHost) { _envState.env = 'none'; _envState.envPath = ''; _envState.platform = ''; }

  document.querySelectorAll('#hwfit-server-select, #hwfit-dl-server, #hwfit-cache-server, #hwfit-deps-server').forEach(sel => {

    if (!sel || sel.tagName !== 'SELECT') return;

    sel.value = _tHost || 'local';

  });

  try {

    const { openServePanelForRepo } = await import('./cookbookServe.js');

    await openServePanelForRepo(repo, fields);

  } catch (err) {

    console.error('[cookbook] open serve panel failed', err);

    uiModule.showToast('Could not open serve panel');

  }

}



export async function _serveAutoRetryReplace(panel, flag, value) {

  const taskEl = panel.closest('.cookbook-task');

  if (!taskEl) return;

  const taskId = taskEl.dataset.taskId;

  const tasks = _loadTasks();

  const task = tasks.find(t => t.sessionId === taskId);

  if (!task || !task.payload || !task.payload._cmd) return;

  if (!_guardServeRetry(panel, taskEl)) return;



  try {

    await fetch('/api/shell/exec', {

      method: 'POST', credentials: 'same-origin',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ command: _tmuxCmd(task, `kill-session -t ${taskId}`) }),

    });

  } catch {}



  _animateOutThenRemove(taskEl, taskId);



  let newCmd = task.payload._cmd;

  const re = new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\S+');

  if (re.test(newCmd)) {

    newCmd = newCmd.replace(re, `${flag} ${value}`);

  } else {

    newCmd += ` ${flag} ${value}`;

  }



  const origHost = _envState.remoteHost;

  if (task.remoteHost) _envState.remoteHost = task.remoteHost;

  try {

    uiModule.showToast(`Retrying with ${flag} ${value}...`);

    await _launchServeTask(task.name, task.payload.repo_id, newCmd);

  } finally {

    _envState.remoteHost = origHost;

  }

}



export async function _serveAutoRetryRemove(panel, flag) {

  const taskEl = panel.closest('.cookbook-task');

  if (!taskEl) return;

  const taskId = taskEl.dataset.taskId;

  const tasks = _loadTasks();

  const task = tasks.find(t => t.sessionId === taskId);

  if (!task || !task.payload || !task.payload._cmd) return;

  if (!_guardServeRetry(panel, taskEl)) return;



  try {

    await fetch('/api/shell/exec', {

      method: 'POST', credentials: 'same-origin',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ command: _tmuxCmd(task, `kill-session -t ${taskId}`) }),

    });

  } catch {}



  _animateOutThenRemove(taskEl, taskId);



  let newCmd = task.payload._cmd;

  const re = new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\S+');

  newCmd = newCmd.replace(re, '').replace(/\s{2,}/g, ' ').trim();



  const origHost = _envState.remoteHost;

  if (task.remoteHost) _envState.remoteHost = task.remoteHost;

  try {

    uiModule.showToast(`Retrying without ${flag}...`);

    await _launchServeTask(task.name, task.payload.repo_id, newCmd);

  } finally {

    _envState.remoteHost = origHost;

  }

}



export async function _serveAutoRetry(panel, flag) {

  const taskEl = panel.closest('.cookbook-task');

  if (!taskEl) return;

  const taskId = taskEl.dataset.taskId;

  const tasks = _loadTasks();

  const task = tasks.find(t => t.sessionId === taskId);

  if (!task || !task.payload || !task.payload._cmd) return;

  if (!_guardServeRetry(panel, taskEl)) return;



  try {

    await fetch('/api/shell/exec', {

      method: 'POST', credentials: 'same-origin',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ command: _tmuxCmd(task, `kill-session -t ${taskId}`) }),

    });

  } catch {}



  _animateOutThenRemove(taskEl, taskId);



  let newCmd = task.payload._cmd;

  if (!newCmd.includes(flag)) {

    newCmd += ' ' + flag;

  }



  const origHost = _envState.remoteHost;

  if (task.remoteHost) _envState.remoteHost = task.remoteHost;

  try {

    uiModule.showToast(`Retrying with ${flag}...`);

    await _launchServeTask(task.name, task.payload.repo_id, newCmd);

  } finally {

    _envState.remoteHost = origHost;

  }

}



// ── 编辑命令提示框 ──

// 显示一个预填当前 serve 命令的小模态框。

// 点击 Save 时解析为编辑后的字符串，点击 Cancel 时返回 null。

function _promptEditServeCmd(currentCmd) {

  return new Promise((resolve) => {

    const overlay = document.createElement('div');

    overlay.className = 'cookbook-edit-overlay';

    overlay.innerHTML = `

      <div class="cookbook-edit-modal">

        <div class="cookbook-edit-title">Edit serve command</div>

        <textarea class="cookbook-edit-textarea" spellcheck="false"></textarea>

        <div class="cookbook-edit-actions">

          <button class="cookbook-edit-cancel memory-toolbar-btn">Cancel</button>

          <button class="cookbook-edit-save memory-toolbar-btn">Save &amp; relaunch</button>

        </div>

      </div>`;

    const ta = overlay.querySelector('.cookbook-edit-textarea');

    ta.value = currentCmd || '';

    document.body.appendChild(overlay);

    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);



    const close = (result) => {

      overlay.remove();

      document.removeEventListener('keydown', onKey);

      resolve(result);

    };

    const onKey = (e) => {

      if (e.key === 'Escape') close(null);

      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) close(ta.value.trim() || null);

    };

    overlay.querySelector('.cookbook-edit-cancel').addEventListener('click', () => close(null));

    overlay.querySelector('.cookbook-edit-save').addEventListener('click', () => close(ta.value.trim() || null));

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

    document.addEventListener('keydown', onKey);

  });

}



// ── 启动 serve 任务 ──



// 从原始启动命令尽力重建 serve 表单字段值。用于在 _fields

// 捕获存在之前创建的任务。镜像了 cookbookServe.js 中 _loadSlotIntoPanel 的正则解析器。

function _parseServeCmdToFields(cmd) {

  if (!cmd) return null;

  const ex = (re) => { const m = cmd.match(re); return m ? m[1] : ''; };

  const fields = {

    backend: cmd.includes('llama_cpp') || cmd.includes('llama-server') ? 'llamacpp'

      : cmd.includes('diffusion_server') ? 'diffusers'

      : cmd.includes('sglang') ? 'sglang'

      : cmd.includes('ollama') ? 'ollama' : 'vllm',

    port: ex(/--port\s+(\d+)/) || '8000',

    tp: ex(/--tensor-parallel-size\s+(\d+)/) || '1',

    ctx: ex(/--max-model-len\s+(\d+)/) || ex(/--n_ctx\s+(\d+)/) || ex(/-c\s+(\d+)/) || '8192',

    gpu_mem: ex(/--gpu-memory-utilization\s+([\d.]+)/) || '0.90',

    swap: ex(/--swap-space\s+(\d+)/) || '',

    dtype: ex(/--dtype\s+(\w+)/) || 'auto',

    vllm_kv_cache_dtype: ex(/--kv-cache-dtype\s+([\w.-]+)/) || 'auto',

    max_seqs: ex(/--max-num-seqs\s+(\d+)/) || '',

    gpus: ex(/CUDA_VISIBLE_DEVICES=(\S+)/) || '',

    cache_type: ex(/(?:--cache-type-k|-ctk)\s+(\S+)/) || '',

    llama_fit: ex(/(?:--fit|-fit)\s+(on|off)/) || '',

    llama_split_mode: ex(/(?:--split-mode|-sm)\s+(none|layer|row|tensor)/) || '',

    llama_tensor_split: ex(/(?:--tensor-split|-ts)\s+([0-9.,]+)/) || '',

    llama_main_gpu: ex(/(?:--main-gpu|-mg)\s+(\d+)/) || '',

    llama_parallel: ex(/(?:--parallel|-np)\s+(\d+)/) || '',

    llama_batch_size: ex(/(?:--batch-size|-b)\s+(\d+)/) || '',

    llama_ubatch_size: ex(/(?:--ubatch-size|-ub)\s+(\d+)/) || '',

    llama_spec_tokens: ex(/--spec-draft-n-max\s+(\d+)/) || '3',

    enforce_eager: cmd.includes('--enforce-eager'),

    trust_remote: cmd.includes('--trust-remote-code'),

    prefix_cache: cmd.includes('--enable-prefix-caching'),

    auto_tool: cmd.includes('--enable-auto-tool-choice'),

    flash_attn: /--flash-attn\s+on\b/.test(cmd),

    unified_mem: /GGML_CUDA_ENABLE_UNIFIED_MEMORY=1/.test(cmd),

    llama_no_mmap: /--no-mmap\b/.test(cmd),

    llama_no_warmup: /--no-warmup\b/.test(cmd),

    llama_speculative_mtp: /--spec-type\s+\S*draft-mtp/.test(cmd),

    speculative: cmd.includes('--speculative-config'),

  };

  const spec = cmd.match(/--speculative-config\s+'?\{[^}]*"method"\s*:\s*"([^"]+)"[^}]*"num_speculative_tokens"\s*:\s*(\d+)/);

  if (spec) { fields.spec_method = spec[1]; fields.spec_tokens = spec[2]; }

  return fields;

}



export async function _launchServeTask(shortName, repo, cmd, fields, hostOverride) {

  // 主机解析镜像下载路径：当调用者传递显式主机（从用户实际选择的下拉菜单解析）

  // 时，使用该主机并从共享服务器列表中查找该服务器的端口/平台。仅对

  // 旧版调用者（诊断/pip-更新）回退到 _envState.remoteHost。

  const _host = (hostOverride !== undefined) ? (hostOverride || '') : (_envState.remoteHost || '');

  const _hsrv = _serverByVal(_envState.remoteServerKey || _host)

    || _envState.servers.find(s => s.host === _host) || {};

  const _hplatform = _host ? (_hsrv.platform || '') : (_envState.platform || '');



  // 替换已存在于此 host:port 上的任何 serve——不能在同一个端口上运行两个

  // 服务器，所以重新启动（或重试）时应停止并移除旧的，而不是留下一个

  // 僵尸副本。（重试按钮已经移除了它们自己的任务，因此此处是空操作。）

  try {

    const _pm = cmd.match(/--port[=\s]+(\d+)/) || cmd.match(/(?:^|\s)-p[=\s]+(\d+)/);

    const _newPort = _pm ? _pm[1] : '';

    if (_newPort) {

      for (const _t of _loadTasks()) {

        if (_t.type !== 'serve' || !_t.payload || !_t.payload._cmd) continue;

        const _tm = _t.payload._cmd.match(/--port[=\s]+(\d+)/) || _t.payload._cmd.match(/(?:^|\s)-p[=\s]+(\d+)/);

        if ((_tm ? _tm[1] : '') === _newPort && (_t.remoteHost || '') === _host) {

          try {

            await fetch('/api/shell/exec', {

              method: 'POST', credentials: 'same-origin',

              headers: { 'Content-Type': 'application/json' },

              body: JSON.stringify({ command: _tmuxGracefulKill(_t) }),

            });

          } catch {}

          _removeTask(_t.sessionId);

        }

      }

    }

  } catch {}

  // 在构建请求之前捕获本次启动使用的环境 + GPU 绑定。

  // Serve 面板设置 _envState.env/envPath/gpus，调用我们，然后同步

  // 恢复它们——而我们的负载在 `await` 之后构建，所以此时读取

  // _envState 会看到恢复后的（错误的）值。持久化这些值使得

  // 保存的预设可以使用相同的 venv + GPU 重新启动（否则已确认

  // 可用的配置会失败：无法激活 venv，没有 GPU 绑定）。

  const _usedEnv = _envState.env;

  const _usedEnvPath = _envState.envPath;

  const _usedGpus = _envState.gpus || '';

  let envPrefix = '';

  if (_isWindows()) {

    if (_envState.env === 'venv' && _envState.envPath) {

      envPrefix = '& ' + (_envState.envPath.endsWith('\\Scripts\\Activate.ps1') ? _envState.envPath : _envState.envPath + '\\Scripts\\Activate.ps1');

    } else if (_envState.env === 'conda' && _envState.envPath) {

      envPrefix = 'conda activate ' + _envState.envPath;

    }

  } else {

    if (_envState.env === 'venv' && _envState.envPath) {

      const p = _envState.envPath;

      envPrefix = 'source ' + (p.endsWith('/bin/activate') ? p : p + '/bin/activate');

    } else if (_envState.env === 'conda' && _envState.envPath) {

      envPrefix = 'eval "$(conda shell.bash hook)" && conda activate ' + _envState.envPath;

    }

  }



  const reqBody = {

    repo_id: repo,

    cmd: cmd,

    remote_host: _host || undefined,

    ssh_port: _getPort(_host) || undefined,

    env_prefix: envPrefix || undefined,

    hf_token: _envState.hfToken || undefined,

    gpus: _envState.gpus || undefined,

    platform: _hplatform || undefined,

  };



  try {

    const res = await fetch('/api/model/serve', {

      method: 'POST', credentials: 'same-origin',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify(reqBody),

    });

    const data = await res.json();

    if (!data.ok) {

      // 两种错误格式：`{ok:false, error}`（tmux 启动失败）或

      // `{detail}`（FastAPI HTTPException）。显示存在的那个

      // + 记录完整负载以便用户复制错误信息。

      const err = data.error || data.detail || res.statusText || 'unknown';

      console.error('[cookbook] /api/model/serve failed', { status: res.status, body: data });

      uiModule.showToast('Failed to start: ' + String(err).slice(0, 200), 9000);

      return;

    }



    const _sp = _getPort(_host);

    // _fields = 本次启动使用的精确结构化 serve 表单值，

    // 以便 "Edit / relaunch" 按钮可以重新打开 Serve 面板并预填

    // 这些精确设置（而不仅仅是该 repo 的最后使用状态）。

    const payload = { repo_id: repo, remote_host: _host || undefined, ssh_port: _sp || undefined, _cmd: cmd, _fields: fields || undefined, _env: _usedEnv, _envPath: _usedEnvPath, _gpus: _usedGpus };

    _addTask(data.session_id, shortName, 'serve', payload);

    uiModule.showToast(`Serving ${shortName}...`);

    // 自动注册可能已为此 host:port 启用了现有（离线）端点。

    // 刷新选择器使该行不再变暗，用户也不会在看到他们刚启动的 serve 时

    // 显示 "offline"。

    try { _refreshModelsAfterEndpointChange(); } catch (_) {}

  } catch (e) {

    uiModule.showToast('Failed: ' + e.message);

  }

}



// ── 渲染 Running 标签页 ──



export function _renderRunningTab() {

  // 当没有任务活跃运行或出错时，自动清除侧边栏通知（高亮图标）。

  // 每次任务事件触发 _showCookbookNotif，但匹配的清除只在模态框打开时运行，

  // 所以后台任务完成后高亮会一直保持。这里修复此问题。

  try {

    const _activeTasks = _loadPrunedTasks().filter(t => t.status === 'running' || t.status === 'queued' || t.status === 'error');

    if (!_activeTasks.length) _clearCookbookNotif();

  } catch {}



  const body = document.querySelector('#cookbook-modal .cookbook-body');

  if (!body) return;



  // 捕获展开状态，使重新渲染不会折叠用户已打开的内容。

  // 任务输出：存在 .cookbook-task-collapsed 表示已折叠。

  // 区域主体：内联 display:none 表示已折叠。

  const _collapsedTaskIds = new Set();

  const _expandedTaskIds = new Set();  // 移动端：用户明确展开的任务

  body.querySelectorAll('.cookbook-task').forEach(tEl => {

    const id = tEl.dataset.taskId;

    if (!id) return;

    const wrap = tEl.querySelector('.cookbook-output-wrap');

    if (!wrap) return;

    if (wrap.classList.contains('cookbook-task-collapsed')) _collapsedTaskIds.add(id);

    else _expandedTaskIds.add(id);

  });

  // 刚刚启动了新操作——折叠所有现有卡片，只打开新卡片

  //（同时适用于桌面端和移动端的默认折叠路径）。

  if (_soloExpandTaskId) {

    const _allIds = new Set([..._collapsedTaskIds, ..._expandedTaskIds]);

    _collapsedTaskIds.clear();

    _expandedTaskIds.clear();

    _allIds.forEach(id => { if (id !== _soloExpandTaskId) _collapsedTaskIds.add(id); });

    _expandedTaskIds.add(_soloExpandTaskId);

    _soloExpandTaskId = null;

  }

  // 在移动端，任务输出默认折叠——如果进入时所有运行窗口都展开，

  // 用户需要大量点击来折叠它们。用户手动展开的内容会在下面的

  // _expandedTaskIds 中重新打开。

  const _mobileCollapseDefault = window.innerWidth <= 768;

  const _collapsedSectionIds = new Set();

  body.querySelectorAll('.cookbook-section-body').forEach(sb => {

    if (sb.style.display === 'none' && sb.id) _collapsedSectionIds.add(sb.id);

  });



  const tasks = _loadTasks();

  const hasContent = tasks.length > 0;

  // 统计所有真正活跃的任务：显式的 'running'/'queued' 状态，

  // 或者 tmux 输出中仍显示实时分片进度的下载任务。

  // 没有输出检查的话，一个状态卡在 'done'/'crashed' 的任务

  //（在自动重连捕获之前）即使模型正在主机上活跃下载，

  // 也会显示为 "Running 0"。

  const activeCount = tasks.filter(t =>

    t.status === 'running'

    || t.status === 'queued'

    || _downloadOutputLooksActive(t)

  ).length;

  const activeCountHtml = activeCount ? ` <span class="cookbook-tab-count">${activeCount}</span>` : '';



  let tabBar = body.querySelector('.cookbook-tabs');

  if (!tabBar) return;

  let runTab = tabBar.querySelector('.cookbook-tab[data-backend="Running"]');

  if (hasContent && !runTab) {

    runTab = document.createElement('button');

    runTab.className = 'cookbook-tab';

    runTab.dataset.backend = 'Running';

    const _errCount = tasks.filter(t => t.status === 'error' || t.status === 'crashed').length;

    runTab.innerHTML = t('cookbook.running_tab') + activeCountHtml + (_errCount ? `<span class="cookbook-tab-error-dot"></span>` : '');

    tabBar.insertBefore(runTab, tabBar.firstChild);

    runTab.addEventListener('click', () => {

      tabBar.querySelectorAll('.cookbook-tab').forEach(t => t.classList.remove('active'));

      runTab.classList.add('active');

      body.querySelectorAll('.cookbook-group').forEach(g => {

        g.classList.toggle('hidden', g.dataset.backendGroup !== 'Running');

      });

    });

  } else if (runTab) {

    const _errCount2 = tasks.filter(t => t.status === 'error' || t.status === 'crashed').length;

    runTab.innerHTML = tasks.length ? t('cookbook.running_tab') + activeCountHtml + (_errCount2 ? '<span class="cookbook-tab-error-dot"></span>' : '') : t('cookbook.running_tab');

    if (!hasContent) {

      if (runTab.classList.contains('active')) {

        const wfTab = tabBar.querySelector('.cookbook-tab[data-backend="Search"]');

        if (wfTab) wfTab.click();

      }

      runTab.remove();

    }

  }



  let group = body.querySelector('.cookbook-group[data-backend-group="Running"]');

  if (hasContent && !group) {

    group = document.createElement('div');

    group.className = 'cookbook-group hidden';

    group.dataset.backendGroup = 'Running';

    group.innerHTML = '<div class="admin-card" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">' +

      '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">' +

      '<h2 style="margin:0;padding:0;line-height:1;">Running <span id="running-count" class="memory-count" style="font-size:0.6em;opacity:0.6;font-weight:normal">' + activeCount + '</span></h2>' +

      '</div>' +

      '<p class="memory-desc doclib-desc" style="margin-top:6px;">Active downloads and serving processes.</p>' +

      '</div>';

    const firstGroup = body.querySelector('.cookbook-group');

    if (firstGroup) body.insertBefore(group, firstGroup);

    else body.appendChild(group);

  }



  if (!group) return;



  const countEl = group.querySelector('#running-count');

  if (countEl) countEl.textContent = activeCount;



  if (!hasContent) {

    group.remove();

    return;

  }



  const _adminCard = group.querySelector('.admin-card');

  function _ensureSection(cls, label, items) {

    let sec = group.querySelector('.' + cls);

    if (!sec) {

      sec = document.createElement('div');

      sec.className = cls;

      (_adminCard || group).appendChild(sec);

    }

    if (!items || !items.length) {

      sec.style.display = 'none';

      return sec;

    }

    sec.style.display = '';

    return sec;

  }



  // 按服务器分组任务

  const _serverName = (host) => {

    if (!host) return 'Local';

    const srv = _serverByVal(_envState.remoteServerKey || host)

      || _envState.servers.find(s => s.host === host);

    return srv?.name || host;

  };

  const serverGroups = {};

  for (const t of tasks) {

    const key = t.remoteHost || '';

    if (!serverGroups[key]) serverGroups[key] = { name: _serverName(key), serve: [], download: [] };

    serverGroups[key][t.type === 'serve' ? 'serve' : 'download'].push(t);

  }





  // ── 按服务器分组的区域 ──

  group.querySelectorAll('.cookbook-serve-section, .cookbook-dl-section').forEach(el => el.remove());



  const serverKeys = Object.keys(serverGroups).sort((a, b) => {

    if (!a) return -1; if (!b) return 1;

    return serverGroups[a].name.localeCompare(serverGroups[b].name);

  });



  // 清理过期的服务器区域：不再有任何任务的服务器不在 serverKeys 中，

  // 否则其区域标题/下拉菜单会在用户手动清除前一直残留。

  // 在每次渲染时自动删除它们。

  const _liveSafeKeys = new Set(serverKeys.map(k => (k || 'local').replace(/[^a-zA-Z0-9-]/g, '_')));

  (_adminCard || group).querySelectorAll('[class*="cookbook-server-section-"]').forEach(el => {

    const cls = [...el.classList].find(c => c.startsWith('cookbook-server-section-'));

    if (cls && !_liveSafeKeys.has(cls.replace('cookbook-server-section-', ''))) el.remove();

  });



  for (const key of serverKeys) {

    const sg = serverGroups[key];

    const allTasks = [...sg.serve, ...sg.download];

    const safeKey = (key || 'local').replace(/[^a-zA-Z0-9-]/g, '_');

    const sectionCls = `cookbook-server-section-${safeKey}`;

    const bodyId = `server-body-${safeKey}`;

    let sec = _ensureSection(sectionCls, sg.name, allTasks);

    if (allTasks.length && !sec.querySelector('.cookbook-section-header')) {

      const clearId = `clear-server-${key || 'local'}`;

      // 服务器名称旁边的发光状态点（类似 Settings 服务器卡片）：

      // 可达时绿色，该服务器上有任何 serve 任务崩溃/不可达时红色。

      const _secDot = (key && allTasks.some(_serveTaskFailed)) ? 'fail' : 'ok';

      const _dotTitle = key ? (_secDot === 'fail' ? 'Server not responding' : 'Reachable') : 'Local (this machine)';

      sec.insertAdjacentHTML('afterbegin', `<div class="cookbook-section-header" data-collapse="${bodyId}"><svg class="cookbook-section-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg><span class="cookbook-srv-status ${_secDot}" title="${_dotTitle}" style="flex-shrink:0;position:relative;top:0px;"></span><span class="cookbook-section-title" style="margin:0;">${esc(sg.name)}</span><button class="cookbook-btn cookbook-stop-all-btn" data-stop-server="${esc(key)}">Stop all</button><button class="cookbook-btn cookbook-clear-btn" data-clear-server="${esc(key)}">Clear finished</button></div><div id="${bodyId}" class="cookbook-section-body"></div>`);

    }

  }



  // 连接清除全部按钮

  group.querySelectorAll('[data-clear-server]').forEach(btn => {

    if (btn._bound) return;

    btn._bound = true;

    btn.addEventListener('click', async (e) => {

      e.stopPropagation();  // 不要触发区域折叠（原来是在线 onclick，被 CSP 阻止）

      const host = btn.dataset.clearServer;

      if (!await window.styledConfirm(`Clear finished tasks on ${_serverName(host)}?`, { confirmText: 'Clear' })) return;

      const allTasks = _loadTasks();

      const toRemove = allTasks.filter(t => (t.remoteHost || '') === host && _canClearTask(t));

      const remaining = allTasks.filter(t => (t.remoteHost || '') !== host || !_canClearTask(t));

      _saveTasks(remaining);

      // 让每张已完成的卡片淡出/滑出（与单张卡片的清除相同），

      // 而不是瞬间移除。

      toRemove.forEach(t => {

        const el = document.querySelector(`.cookbook-task[data-task-id="${t.sessionId}"]`);

        if (el) {

          if (el._abort) el._abort.abort();

          if (el._uptimeInterval) clearInterval(el._uptimeInterval);

          el.style.transition = 'opacity 0.35s ease, transform 0.35s ease';

          el.style.opacity = '0';

          el.style.transform = 'translateX(-10px)';

        }

      });

      // 动画完成后，移除卡片并整理现在的空区域。

      setTimeout(() => {

        toRemove.forEach(t => document.querySelector(`.cookbook-task[data-task-id="${t.sessionId}"]`)?.remove());

        // 如果此服务器的区域现在为空（只有已完成的任务在此区域），

        // 移除整个区域以免标题残留。

        const _sk = (host || 'local').replace(/[^a-zA-Z0-9-]/g, '_');

        const _sec = group.querySelector(`.cookbook-server-section-${_sk}`);

        if (_sec && !_sec.querySelector('.cookbook-task')) _sec.remove();

        if (!remaining.length) _renderRunningTab();

      }, 360);

    });

  });



  // 连接 "Stop all" 按钮——停止该服务器上所有运行中的任务。

  group.querySelectorAll('[data-stop-server]').forEach(btn => {

    if (btn._bound) return;

    btn._bound = true;

    btn.addEventListener('click', async (e) => {

      e.stopPropagation();  // 不要触发区域折叠

      const host = btn.dataset.stopServer;

      const running = _loadTasks().filter(t => (t.remoteHost || '') === host && t.status === 'running');

      if (!running.length) { uiModule.showToast(`Nothing running on ${_serverName(host)}`); return; }

      if (!await window.styledConfirm(`Stop ${running.length} running task${running.length > 1 ? 's' : ''} on ${_serverName(host)}?`, { confirmText: 'Stop all' })) return;

      // 在发送终止命令前将每个任务标记为用户停止，这样

      // 下载自动重试逻辑永远不会重新启动用户刚停止的任务。

      running.forEach(t => _updateTask(t.sessionId, { _userStopped: true }));

      // 重用每个任务自身的 Stop 操作，使其执行完整的拆卸流程

      //（发送 C-c、移除端点、标记为已停止），保持一致性。

      running.forEach(t => {

        const el = document.querySelector(`.cookbook-task[data-task-id="${t.sessionId}"]`);

        el?.querySelector('.cookbook-task-action-stop')?.click();

      });

      uiModule.showToast(`Stopped ${running.length} task${running.length > 1 ? 's' : ''} on ${_serverName(host)}`);

    });

  });



  // 段落折叠/展开

  group.querySelectorAll('.cookbook-section-header[data-collapse]').forEach(hdr => {

    if (hdr._bound) return;

    hdr._bound = true;

    hdr.addEventListener('click', () => {

      const bodyId = hdr.dataset.collapse;

      const body = document.getElementById(bodyId);

      if (!body) return;

      const isHidden = body.style.display === 'none';

      body.style.display = isHidden ? '' : 'none';

      const chevron = hdr.querySelector('.cookbook-section-chevron');

      if (chevron) {

        // 折叠 → 指向右侧（▶，点击展开）；展开 → 向下（▼）。

        chevron.style.transform = isHidden ? '' : 'rotate(-90deg)';

        chevron.style.opacity = '';

      }

    });

  });



  // 仅添加新任务或更新现有任务

  const existingIds = new Set();

  group.querySelectorAll('.cookbook-task').forEach(el => {

    const id = el.dataset.taskId;

    existingIds.add(id);

    const task = tasks.find(t => t.sessionId === id);

    if (task) {

      el.dataset.status = task.status;

      const isDone = task.status === 'done';

      // 类型芯片在任务完成时兼作"finished"徽章——

      // download 和 serve 均显示相同绿色 FINISHED 芯片。

      const typeChip = el.querySelector('.cookbook-task-type');

      if (typeChip) {

        // 仅 DOWNLOAD 任务完成时翻转为"finished"——serve 任务

        // 继续显示"serve"，因为模型仍在该端口运行。

        const isDoneDl = isDone && task.type === 'download';

        typeChip.textContent = isDoneDl ? t('cookbook.finished') : task.type;

        typeChip.classList.toggle('cookbook-task-type-done', isDoneDl);

      }

      const badge = el.querySelector('.cookbook-task-status');

      if (badge) {

        const _bdg = _taskBadge(task);

        badge.textContent = _bdg.text;

        badge.className = 'cookbook-task-status' + (_bdg.cls ? ' ' + _bdg.cls : '');

        badge.style.display = '';

      }

      // 指示器：运行时旋转波浪，完成时绿色对号。

      const wave = el.querySelector('.cookbook-task-wave');

      if (wave) wave.style.display = task.status === 'running' ? '' : 'none';

      const check = el.querySelector('.cookbook-task-check');

      if (check) {

        check.style.display = _canClearTask(task) ? '' : 'none';

        const label = check.querySelector('.cookbook-task-done-label');

        if (label) label.textContent = _clearPillLabel(task);

      }

      const startNow = el.querySelector('.cookbook-task-start-now');

      if (startNow) startNow.style.display = (task.type === 'download' && task.status === 'queued') ? '' : 'none';

      const terminalDiag = _terminalServeDiagnosis(task, el.querySelector('.cookbook-output-pre')?.textContent || task.output || '');

      if (terminalDiag) {

        _showDiagnosis(el, terminalDiag, el.querySelector('.cookbook-output-pre')?.textContent || task.output || '');

      } else {

        const existingDiag = el.querySelector('.cookbook-diagnosis');

        // 即使输出已清除，仍保留失败任务的诊断——

        // 移除会向用户隐藏崩溃原因。

        

        if (existingDiag && !['stopped', 'error', 'crashed', 'failed'].includes(task.status)) {

          existingDiag.remove();

        }

      }

    }

    if (!task) {

      if (el._uptimeInterval) { clearInterval(el._uptimeInterval); el._uptimeInterval = null; }

      el.remove();

    }

  });



  // 添加新任务条目

  for (const task of tasks) {

    if (existingIds.has(task.sessionId)) continue;



    const el = document.createElement('div');

    el.className = 'cookbook-task' + (task._unreachable && task.status === 'running' ? ' cookbook-task-unreachable' : '');

    el.dataset.taskId = task.sessionId;

    el.dataset.status = task.status;

    el.dataset.type = task.type || '';



    const _bdg = _taskBadge(task);

    const _bdgTitle = (task._unreachable && task.status === 'running') ? ' title="Server not responding — it may have crashed"' : '';

    el.innerHTML = `

      <div class="cookbook-task-header">

        <span class="cookbook-task-type${(task.status === 'done' && task.type === 'download') ? ' cookbook-task-type-done' : ''}" data-type="${esc(task.type)}">${esc((task.status === 'done' && task.type === 'download') ? 'finished' : task.type)}</span>

        <span class="cookbook-task-name">${modelLogo(task.name)}${esc(task.name)}</span>

        <span class="cookbook-task-indicator"><span class="cookbook-task-wave" style="display:${task.status === 'running' ? '' : 'none'}"></span><span class="cookbook-task-check" title="Clear" style="display:${_canClearTask(task) ? '' : 'none'}"><svg class="cookbook-task-check-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#50fa7b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><svg class="cookbook-task-clear-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span class="cookbook-task-done-label">${esc(_clearPillLabel(task))}</span><span class="cookbook-task-clear-label">clear</span></span></span>

        <button type="button" class="cookbook-task-start-now" title="Start this queued download now" style="display:${(task.type === 'download' && task.status === 'queued') ? '' : 'none'}"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="8 5 19 12 8 19 8 5"/></svg><span>start now</span></button>

        <span class="cookbook-task-status ${_bdg.cls}"${_bdgTitle}>${esc(_bdg.text)}</span>

        <button class="cookbook-task-menu-btn" title="Actions">&#8942;</button>

      </div>

      <div class="cookbook-task-sub"><span class="cookbook-task-session">${esc(task.sessionId)}</span><span class="cookbook-task-uptime" style="display:${((task.type === 'serve' || task.type === 'download') && task.status === 'running') ? '' : 'none'}"></span>${(task.type === 'download') ? `<span class="cookbook-task-dldir" title="Download destination" style="font-size:9px;color:var(--fg-muted);font-family:'Fira Code',monospace;opacity:0.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40ch;">Dir: ${esc(task.payload?.local_dir || '~/.cache/huggingface/hub')}</span>` : ''}</div>

      <div class="cookbook-output-wrap cookbook-task-collapsible${_mobileCollapseDefault ? ' cookbook-task-collapsed' : ''}"><pre class="cookbook-output-pre">${esc(task.output || '')}</pre><button type="button" class="copy-code cookbook-output-copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>

    `;



    const _waveEl = el.querySelector('.cookbook-task-wave');

    if (_waveEl && task.status === 'running') _registerWaveEl(_waveEl);



    const terminalDiag = _terminalServeDiagnosis(task, task.output || '');

    if (terminalDiag) _showDiagnosis(el, terminalDiag, task.output || '');

    if (!terminalDiag && (task.status === 'error' || task.status === 'crashed') && task._backendDiagnosis) {

      _showDiagnosis(el, task._backendDiagnosis, task.output || '');

    }



    const _uptimeEl = el.querySelector('.cookbook-task-uptime');

    if (_uptimeEl && (task.type === 'serve' || task.type === 'download') && task.status === 'running') {

      const _startedAt = task.ts || Date.now();

      const _prefix = task.type === 'download' ? 'downloading' : 'uptime';

      el._uptimeInterval = setInterval(() => {

        const secs = Math.floor((Date.now() - _startedAt) / 1000);

        const h = Math.floor(secs / 3600);

        const m = Math.floor((secs % 3600) / 60);

        const s = secs % 60;

        const _timer = h > 0

          ? `${_prefix}: ${h}h ${String(m).padStart(2,'0')}m`

          : `${_prefix}: ${m}m ${String(s).padStart(2,'0')}s`;

        // ETA——仅限下载，仅当有意义的整体百分比时。

        // 读取徽章文本（已在实时轮询中计算的

        // 真实整体百分比）并反推剩余时间估计。

        // 在 pct >= 3% 前隐藏，避免早期疯狂估计。

        

        let _eta = '';

        if (task.type === 'download') {

          const _badge = el.querySelector('.cookbook-task-status');

          const _m = _badge && /^(\d+)%/.exec(_badge.textContent || '');

          const _pct = _m ? parseInt(_m[1], 10) : 0;

          if (_pct >= 3 && _pct < 100 && secs > 5) {

            const _totalSec = Math.round(secs * (100 / _pct));

            const _remain = Math.max(0, _totalSec - secs);

            const _eh = Math.floor(_remain / 3600);

            const _em = Math.floor((_remain % 3600) / 60);

            const _es = _remain % 60;

            _eta = _eh > 0

              ? ` · ETA ${_eh}h ${String(_em).padStart(2,'0')}m`

              : (_em > 0 ? ` · ETA ${_em}m ${String(_es).padStart(2,'0')}s` : ` · ETA ${_es}s`);

          }

        }

        _uptimeEl.textContent = _timer + _eta;

      }, 1000);

    }



    // 为此模型重新打开 Serve 面板，预填此实例启动时使用的精确设置，并指向它所在的服务器。

    const _openEdit = () => _openServeEditForTask(task);

    el.addEventListener('cookbook:edit-serve', (e) => {

      e.stopPropagation();

      _openServeEditForTask(task, null, e.detail?.fields || null);

    });



    // 已完成的下载 → 显式的 "Serve →" 按钮直接跳转到

    // 预选了此模型的 Serve 标签页（在它下载到的服务器上）。

    if (task.type === 'download') {

      const _serveBtn = el.querySelector('.cookbook-task-serve-btn');

      if (_serveBtn) {

        _serveBtn.addEventListener('click', async (e) => {

          e.stopPropagation();

          const repo = task.payload?.repo_id || task.name;

          if (!repo) { uiModule.showToast('No model info on this task'); return; }

          // 将活跃服务器指向下载任务所在的服务器。

          const _tHost = task.remoteHost || '';

          _envState.remoteHost = _tHost;

          const _tSrv = _serverByVal(_envState.remoteServerKey || _tHost)

            || _envState.servers.find(s => s.host === _tHost);

          if (_tSrv) { _envState.env = _tSrv.env || 'none'; _envState.envPath = _tSrv.envPath || ''; _envState.platform = _tSrv.platform || ''; }

          else if (!_tHost) { _envState.env = 'none'; _envState.envPath = ''; _envState.platform = ''; }

          document.querySelectorAll('#hwfit-server-select, #hwfit-dl-server, #hwfit-cache-server, #hwfit-deps-server').forEach(sel => {

            if (sel && sel.tagName === 'SELECT') sel.value = _tHost || 'local';

          });

          try {

            const { openServePanelForRepo } = await import('./cookbookServe.js');

            await openServePanelForRepo(repo);

            // 启动服务会取代已完成的下载——跳转到 Serve 面板后，从

            // Running 标签页清除该卡片（平滑退出）。

            _animateOutThenRemove(el, task.sessionId);

          } catch (err) { uiModule.showToast('Could not open Serve: ' + err.message); }

        });

      }

    }



    // 已完成的任务显示绿色对号——使其可点击清除，用户可以直接

    // 关闭已完成的下载/更新（不再自动移除）。悬停时变为红色 ✕（见 CSS）。

    const _clearChk = el.querySelector('.cookbook-task-check');

    if (_clearChk) {

      _clearChk.addEventListener('click', (e) => {

        e.stopPropagation();

        // 如果输出仍然显示活跃的分片行，则任务实际上并未

        // 完成——点击是 "reconnect"（切回 running + 让 _reconnectTask

        // 重新连接活跃的 tmux 会话），而不是 "clear"。

        // 药丸标签已通过 _clearPillLabel 反映此情况。

        if (_downloadOutputLooksActive(task)) {

          const _fresh = _loadTasks();

          const _ft = _fresh.find(t => t.sessionId === task.sessionId);

          if (_ft) {

            _ft.status = 'running';

            _ft._selfHealed = true;

            _saveTasks(_fresh);

          }

          // 在等待完整重新渲染前先做视觉切换——与打开 cookbook 时自动修复

          // 使用的路径相同。

          const _chk = el.querySelector('.cookbook-task-check');

          if (_chk) _chk.style.display = 'none';

          const _wave = el.querySelector('.cookbook-task-wave');

          if (_wave) _wave.style.display = '';

          const _up = el.querySelector('.cookbook-task-uptime');

          if (_up) _up.style.display = '';

          el.dataset.status = 'running';

          _renderRunningTab();

          return;

        }

        // 否则：实际的清除。作为双重保险先终止 tmux 会话，

        // 然后动画淡出并移除该行。

        try {

          fetch('/api/shell/exec', {

            method: 'POST', credentials: 'same-origin',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ command: _tmuxCmd(task, `kill-session -t ${task.sessionId}`) }),

          }).catch(() => {});

        } catch {}

        _animateOutThenRemove(el, task.sessionId);

      });

    }



    const _startNowBtn = el.querySelector('.cookbook-task-start-now');

    if (_startNowBtn) {

      _startNowBtn.addEventListener('click', (e) => {

        e.stopPropagation();

        _startQueuedDownload(task);

      });

    }



    // 连接标题点击以折叠/展开输出

    el.querySelector('.cookbook-task-header').addEventListener('click', (e) => {

      if (e.target.closest('button')) return;

      const wrap = el.querySelector('.cookbook-output-wrap');

      if (wrap) wrap.classList.toggle('cookbook-task-collapsed');

    });



    // 连接菜单按钮（同时在卡片的任意位置长按也能触发，让移动端用户

    // 不必精确点击小的 ⋮ 目标）。

    const menuBtn = el.querySelector('.cookbook-task-menu-btn');

    if (menuBtn) {

      // 卡片上的长按检测：约 500ms 保持不放且无滚动移动，

      // 复用菜单按钮的点击路径（避免重复逻辑）。

      let _lpTimer = null;

      let _lpStartY = 0;

      let _lpCanceled = false;

      const _lpStart = (e) => {

        _lpCanceled = false;

        _lpStartY = (e.touches?.[0]?.clientY) ?? 0;

        _lpTimer = setTimeout(() => {

          if (_lpCanceled) return;

          _lpCanceled = true;  // 抑制后续的点击穿透

          try { menuBtn.click(); } catch {}

        }, 500);

      };

      const _lpCancel = () => {

        if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }

      };

      const _lpMove = (e) => {

        const y = (e.touches?.[0]?.clientY) ?? 0;

        if (Math.abs(y - _lpStartY) > 8) _lpCancel();

      };

      el.addEventListener('touchstart', (e) => {

        // 如果用户从卡片内的按钮/链接开始触摸，则跳过——

        // 那些已有自己的点击处理程序。

        if (e.target.closest('button, a, input, textarea, .cookbook-task-dropdown')) return;

        _lpStart(e);

      }, { passive: true });

      el.addEventListener('touchmove', _lpMove, { passive: true });

      el.addEventListener('touchend', _lpCancel, { passive: true });

      el.addEventListener('touchcancel', _lpCancel, { passive: true });

      menuBtn.addEventListener('click', (e) => {

        e.stopPropagation();

        document.querySelectorAll('.cookbook-task-dropdown').forEach(d => { if (typeof d._dismiss === 'function') d._dismiss(); else d.remove(); });



        const dropdown = document.createElement('div');

        dropdown.className = 'cookbook-task-dropdown';



        const items = [];

        // 排队的下载：让用户跳过队列立即启动

        //（下载否则按每服务器一次一个的方式运行）。

        if (task.type === 'download' && task.status === 'queued') {

          items.push({ label: 'Start now', action: 'start-now', custom: () => {

            _startQueuedDownload(task);

            _renderRunningTab();

          }});

        }

        if (task.status !== 'running' && task.status !== 'queued') {

          items.push({ label: 'Reconnect', action: 'reconnect' });

        }

        if (task.status === 'running') {

          items.push({ label: 'Stop', action: 'stop', danger: true });

        }

        items.push({ label: 'Restart', action: 'retry' });

        // 编辑 serve —— 打开完整的 serve 面板（与编辑图标相同），

        // 先切换到此任务的服务器以便找到模型。

        if (task.type === 'serve' && task.payload?.repo_id) {

          items.push({ label: 'Edit in serve panel', action: 'edit-panel', tooltip: 'Open the full Serve config panel pre-filled with this task — pick a different backend, change GPUs, edit env vars, then Launch from there', custom: () => _openEdit() });

        }

        // 保存 serve —— 将当前启动配置保存为预设。

        if (task.type === 'serve' && task.payload?._cmd) {

          items.push({ label: 'Save serve', action: 'save', custom: () => {

            if (!_saveTaskAsPreset(task)) { uiModule.showToast('Already saved'); return; }

            uiModule.showToast('Saved to presets');

            _renderRunningTab();

          }});

        }

        // 编辑命令——仅对非运行中的 serve 任务有效。

        // 让用户在崩溃/错误后调整参数并重新启动。

        if (task.type === 'serve' && task.status !== 'running' && task.payload?._cmd) {

          items.push({ label: 'Edit cmd & relaunch', action: 'edit', tooltip: 'Edit the raw vllm/llama-server cmd string in a dialog and relaunch immediately on the same host', custom: async () => {

            const newCmd = await _promptEditServeCmd(task.payload._cmd);

            if (newCmd == null) return; // cancelled

            try {

              await fetch('/api/shell/exec', {

                method: 'POST', credentials: 'same-origin',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({ command: _tmuxGracefulKill(task) }),

              });

            } catch {}

            _removeTask(task.sessionId);

            // 在任务自身的主机上重新启动，而非当前全局选择的主机。

            _launchServeTask(task.name, task.payload.repo_id, newCmd, task.payload._fields, task.remoteHost || '');

          }});

        }

        // 手动注册端点——自动添加失败时的回退方案

        //（例如远程服务器上探测超时）。强制将此 serve 添加到

        // 模型端点列表，无论先前的标志状态如何。

        if (task.type === 'serve' && task.payload?._cmd) {

          items.push({ label: 'Register endpoint', action: 'register-endpoint', custom: async () => {

            const host = _connectHostFromRemote(task.remoteHost);

            const portMatch = task.payload?._cmd?.match(/--port\s+(\d+)/);

            const port = portMatch ? portMatch[1] : '8000';

            const baseUrl = `http://${host}:${port}/v1`;

            try {

              // 先检查是否已存在——如存在则询问是否覆盖

              const eps = await (await fetch('/api/model-endpoints', { credentials: 'same-origin' })).json();

              const existing = eps.find(e => e.base_url === baseUrl);

              if (existing) {

                uiModule.showToast(`Already registered as "${existing.name}"`);

                task._endpointAdded = true;

                _updateTask(task.sessionId, { _endpointAdded: true });

                _refreshModelsAfterEndpointChange();

                // 如果仍处于离线状态（在服务器完成加载之前已注册），

                // 持续探测直到收到响应，而不是让它一直卡在离线状态

                // 直到手动删除/重新添加。

                if (existing.id && !(existing.models || []).length) _probeEndpointUntilOnline(existing.id, host, port);

                return;

              }

              const fd = new FormData();

              fd.append('base_url', baseUrl);

              fd.append('name', task.name);

              fd.append('skip_probe', 'true');

              _appendCookbookEndpointScope(fd, task.remoteHost || '');

              if (task.payload?._cmd?.includes('diffusion_server')) fd.append('model_type', 'image');

              const res = await fetch('/api/model-endpoints', { method: 'POST', credentials: 'same-origin', body: fd });

              if (res.ok) {

                task._endpointAdded = true;

                _updateTask(task.sessionId, { _endpointAdded: true });

                uiModule.showToast(`Endpoint registered: ${host}:${port}`);

                _refreshModelsAfterEndpointChange();

                // 使用 skip_probe 添加 → 持续探测直到（可能仍在预热中的）

                // 服务器响应，使其自动变为在线状态。

                const _ep = await res.json().catch(() => ({}));

                if (_ep && _ep.id) _probeEndpointUntilOnline(_ep.id, host, port);

              } else {

                const body = await res.text().catch(() => '');

                uiModule.showError(`Register failed: ${res.status} ${body.slice(0, 140)}`);

              }

            } catch (e) {

              uiModule.showError(`Register failed: ${e.message || e}`);

            }

          }});

        }

        if (_isWindows(task)) {

          const host = task.remoteHost;

          const sd = host ? '$env:TEMP\\odysseus-sessions' : '$env:TEMP\\odysseus-tmux';

          const logCmd = host

            ? `ssh ${_sshPrefix(_getPort(task))}${host} "powershell -Command \\"Get-Content '${sd}\\${task.sessionId}.log' -Wait\\""`

            : `powershell -Command "Get-Content (Join-Path $env:TEMP 'odysseus-tmux\\${task.sessionId}.log') -Wait"`;

          items.push({ label: 'Copy log cmd', action: 'copy-tmux', custom: () => {

            _copyText(logCmd);

          }});

        } else {

          // 仅 tmux 命令本身——没有 SSH 包装。

          const tmuxAttach = `tmux attach -t ${task.sessionId}`;

          items.push({ label: 'Copy tmux', action: 'copy-tmux', custom: () => {

            _copyText(tmuxAttach);

          }});

        }

        if (_shouldOfferCrashReport(task)) {

          items.push({ label: 'Copy crash report', action: 'copy-crash-report', custom: () => {

            const out = (el.querySelector('.cookbook-output-pre')?.textContent || task.output || '');

            _copyText(_buildCrashReport(task, out));

            uiModule.showToast('Copied crash report');

          }});

        }

        // 复制任务输出/日志的最后 50 行。

        items.push({ label: 'Copy last 50 lines', action: 'copy-log', custom: () => {

          const out = (el.querySelector('.cookbook-output-pre')?.textContent || task.output || '');

          const last = out.split('\n').slice(-50).join('\n');

          if (!last.trim()) {

            uiModule.showToast('No log content available yet');

            return;

          }

          _copyText(last);

          uiModule.showToast('Copied last 50 lines');

        }});

        // 标签与行为匹配——kill 处理器始终先 kill
        // 活动 tmux 会话并删除匹配的模型端点，
        // 然后动画移出任务卡片。
        // 仅"Remove"隐藏了也停止活动服务。
        const _isLive = task.type === 'serve' && ['running', 'ready', 'loading', 'warming', 'starting'].includes(task.status || '');

        items.push({

          label: _isLive ? 'Stop and remove' : 'Remove',

          action: 'kill',

          tooltip: _isLive

            ? 'Kill the live tmux session, deregister the chat endpoint, and remove this row'

            : 'Remove this row',

          danger: true,

        });

        // Cancel = 仅移动端关闭项。与邮件 kebab 同模式：
        // 桌面端隐藏，移动端样式为分隔底行
        //（border-top + 额外内边距）。
        items.push({ label: 'Cancel', action: 'cancel', mobileOnly: true, custom: () => {} });



        const _MENU_ICONS = {

          'start-now': '<polygon points="6 4 20 12 6 20 6 4"/>',

          reconnect: '<path d="M1 4v6h6"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/>',

          retry: '<path d="M1 4v6h6"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/>',

          stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',

          edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',

          'edit-panel': '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',

          'register-endpoint': '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',

          save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',

          'copy-tmux': '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',

          'copy-crash-report': '<path d="M10.3 2.3 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.3a2 2 0 0 0-3.4 0z"/><path d="M12 8v5M12 17h.01"/>',

          'copy-log': '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',

          kill: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',

          cancel: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',

        };

        for (const item of items) {

          const div = document.createElement('div');

          div.className = 'dropdown-item-compact'

            + (item.danger ? ' cookbook-dropdown-danger' : '')

            + (item.mobileOnly ? ' dropdown-cancel-mobile' : '');

          div.style.cssText = 'display:flex;align-items:center;gap:8px;';

          if (item.tooltip) div.title = item.tooltip;

          const ic = _MENU_ICONS[item.action] || '';

          div.innerHTML = `<span style="display:inline-flex;flex-shrink:0;opacity:0.7;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ic}</svg></span><span>${item.label}</span>`;

          div.addEventListener('click', () => {

            _cleanup();

            if (item.custom) { item.custom(); return; }

            el.querySelector('.cookbook-task-action-' + item.action)?.click();

          });

          dropdown.appendChild(div);

        }



        const rect = menuBtn.getBoundingClientRect();

        dropdown.style.position = 'fixed';

        dropdown.style.top = rect.bottom + 2 + 'px';

        dropdown.style.right = (window.innerWidth - rect.right) + 'px';

        document.body.appendChild(dropdown);

        // 限制到*可见*区域。移动端（尤其 Firefox）
        // window.innerHeight 含动态工具栏下隐藏区域，
        // 按它"适配"的菜单仍触底超出屏幕。
        // visualViewport 提供真实可见区域。空间不足则翻转到上方，
        // 否则限制到底部边缘。
        {

          const vv = window.visualViewport;

          const viewTop = vv ? vv.offsetTop : 0;

          const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;

          const dh = dropdown.offsetHeight;

          const m = 8;

          let top = rect.bottom + 2;

          if (top + dh > viewBottom - m) {

            const above = rect.top - 2 - dh;

            top = above >= viewTop + m ? above : Math.max(viewTop + m, viewBottom - dh - m);

          }

          dropdown.style.top = top + 'px';

        }



        const closeHandler = (ev) => {

          if (!dropdown.contains(ev.target) && ev.target !== menuBtn) {

            _cleanup();

          }

        };

        // 滚动也关闭——页面滚动后下拉菜单
        // 固定位置不再匹配原始 ⋮ 按钮，
        // 视觉漂移。与邮件 kebab 行为一致。
        const scrollClose = () => _cleanup();

        let _unreg = () => {};

        const _cleanup = () => {

          _unreg(); _unreg = () => {};

          dropdown.remove();

          document.removeEventListener('click', closeHandler);

          window.removeEventListener('scroll', scrollClose, true);

          window.visualViewport?.removeEventListener('scroll', scrollClose);

        };

        dropdown._dismiss = _cleanup;

        setTimeout(() => {

          document.addEventListener('click', closeHandler);

          window.addEventListener('scroll', scrollClose, true);

          window.visualViewport?.addEventListener('scroll', scrollClose);

        }, 0);

        _unreg = registerMenuDismiss(_cleanup);

      });

    }



    // 隐藏操作按钮用于菜单分发
    const _actionBtns = document.createElement('div');

    _actionBtns.style.display = 'none';

    _actionBtns.innerHTML = `

      <button class="cookbook-task-action-reconnect"></button>

      <button class="cookbook-task-action-retry"></button>

      <button class="cookbook-task-action-stop"></button>

      <button class="cookbook-task-action-kill"></button>

    `;

    el.appendChild(_actionBtns);



    // 绑定重连
    el.querySelector('.cookbook-task-action-reconnect').addEventListener('click', () => {

      _updateTask(task.sessionId, { status: 'running' });

      el.dataset.status = 'running';

      const badge = el.querySelector('.cookbook-task-status');

      if (badge) { badge.textContent = _statusLabel('running', task.type); badge.className = 'cookbook-task-status cookbook-task-running'; }

      _reconnectTask(el, task);

    });



    // 绑定停止
    el.querySelector('.cookbook-task-action-stop').addEventListener('click', async () => {

      // 发送 kill 前中止重连循环，使 shell 包装器
      // 写入的 DOWNLOAD_FAILED 标记不会
      // 在手动停止后触发自动重试。
      if (el._abort) el._abort.abort();

      const badge = el.querySelector('.cookbook-task-status');

      if (badge) { badge.textContent = t('cookbook.stopping'); badge.className = 'cookbook-task-status cookbook-task-stopping'; }

      el.dataset.status = 'stopped';

      _updateTask(task.sessionId, { _userStopped: true });

      const outputText = el.querySelector('.cookbook-output-pre')?.textContent || task.output || '';

      // 删除模型端点使选择器停止列出。
      if (task.type === 'serve' && task.payload) {

        _removeEndpointByUrl(_endpointUrlForTask(task, outputText));

      }

      const ollamaUnload = _ollamaUnloadCommand(task, outputText);

      if (ollamaUnload) {

        try {

          await fetch('/api/shell/exec', {

            method: 'POST', credentials: 'same-origin',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ command: ollamaUnload }),

          });

        } catch {}

      }

      // 优雅停止（C-c 后 kill 会话）确保完全关闭
      try {

        await fetch('/api/shell/exec', {

          method: 'POST', credentials: 'same-origin',

          headers: { 'Content-Type': 'application/json' },

          body: JSON.stringify({ command: _tmuxGracefulKill(task) }),

        });

      } catch {}

      // 然后平滑淡出/滑出并自动移除——无需手动 ⋮ → Remove。
      
      _animateOutThenRemove(el, task.sessionId);

    });



    // 绑定 kill——等待 SSH/tmux kill 并验证会话
    // 确实消失后才移除行。之前 fire-and-forget，
    // 意味着失败 kill（错误 remoteHost、SSH 错误、tmux 已退出）
    // 会静默让活动服务继续运行而 UI 行已消失。
    
    el.querySelector('.cookbook-task-action-kill').addEventListener('click', async () => {

      const outputText = el.querySelector('.cookbook-output-pre')?.textContent || task.output || '';

      const isLive = task.type === 'serve' && ['running', 'ready', 'loading', 'warming', 'starting'].includes(task.status || '');

      const ollamaUnload = _ollamaUnloadCommand(task, outputText);

      if (ollamaUnload) {

        try {

          await fetch('/api/shell/exec', {

            method: 'POST', credentials: 'same-origin',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ command: ollamaUnload }),

          });

        } catch (_) { /* unload best-effort */ }

      }

      let killOk = true;

      try {

        const r = await fetch('/api/shell/exec', {

          method: 'POST', credentials: 'same-origin',

          headers: { 'Content-Type': 'application/json' },

          body: JSON.stringify({ command: _tmuxGracefulKill(task) }),

        });

        if (r.ok) {

          const out = await r.json();

          // 不单独信任 exit_code——tmux kill 即使
          // 无事可 kill 也返回 0。验证会话确实消失。
          if (task.sessionId && isLive) {

            try {

              const probe = await fetch('/api/shell/exec', {

                method: 'POST', credentials: 'same-origin',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({ command: _tmuxCmd(task, `has-session -t ${task.sessionId}`) }),

              });

              if (probe.ok) {

                const pj = await probe.json();

                // has-session 会话仍存在则退出 0；非零 = 已消失。
                if ((pj.exit_code || 0) === 0) killOk = false;

              }

            } catch (_) { /* probe best-effort; trust kill */ }

          }

        } else {

          killOk = false;

        }

      } catch (_) { killOk = false; }

      if (!killOk) {

        try { uiModule.showToast('Kill failed — session may still be running. Check `tmux ls` on the server.', 'error'); } catch (_) {}

        return;  // 保留该行以便用户可以重试

      }

      if (task.type === 'serve' && task.payload) {

        const endpointUrl = _endpointUrlForTask(task, outputText);

        _removeEndpointByUrl(endpointUrl);

        const modelName = task.payload.model || task.name || '';

        if (modelName) {

          fetch('/api/model-endpoints', { credentials: 'same-origin' })

            .then(r => r.json())

            .then(eps => {

              const ep = eps.find(e => e.name === modelName || e.base_url === endpointUrl);

              if (ep) fetch(`/api/model-endpoints/${ep.id}`, { method: 'DELETE', credentials: 'same-origin' }).then(() => _refreshModelsAfterEndpointChange());

            }).catch(() => {});

        }

      }

      _animateOutThenRemove(el, task.sessionId);

    });



    // 绑定重试
    el.querySelector('.cookbook-task-action-retry').addEventListener('click', () => _retryTask(el, task));



    // 绑定复制按钮
    el.querySelector('.cookbook-output-copy').addEventListener('click', (e) => {

      e.stopPropagation();

      const text = el.querySelector('.cookbook-output-pre')?.textContent || '';

      if (!text.trim()) {

        uiModule.showToast('No log content available yet');

        return;

      }

      _copyText(text).then(() => {

        const btn = el.querySelector('.cookbook-output-copy');

        const origHTML = btn.innerHTML;

        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

        btn.classList.add('copied');

        setTimeout(() => { btn.innerHTML = origHTML; btn.classList.remove('copied'); }, 1500);

      });

    });



    // 路由到正确的服务器段落主体
    const serverBodyId = `server-body-${(task.remoteHost || 'local').replace(/[^a-zA-Z0-9-]/g, '_')}`;

    const targetBody = document.getElementById(serverBodyId);

    if (targetBody) targetBody.appendChild(el);

    else group.appendChild(el);



    // 自动附加任何底层会话可能仍存活的
    // 任务的 tmux 输出流——不仅是 'running'。
    // 调度器启动的服务在 /v1/models 响应时转为 'ready'；
    // 无此则用户打开 Running 标签页只看到
    // 占位文本，因为 _reconnectTask 对
    // 'ready'/'loading'/'warming' 状态不触发。
    if (['running', 'ready', 'loading', 'warming', 'starting'].includes(task.status)) {

      _reconnectTask(el, task);

    }

  }



  if (tasks.some(t => t.status === 'running')) _startWaveSync();



  // 重新应用捕获的展开状态使重新渲染不折叠任务/段落。
  _collapsedTaskIds.forEach((id) => {

    const wrap = body.querySelector(`.cookbook-task[data-task-id="${id}"] .cookbook-output-wrap`);

    if (wrap) wrap.classList.add('cookbook-task-collapsed');

  });

  // 移动端默认折叠（上述），所以重新打开用户
  // 在此次重新渲染前明确展开的内容。
  if (_mobileCollapseDefault) {

    _expandedTaskIds.forEach((id) => {

      const wrap = body.querySelector(`.cookbook-task[data-task-id="${id}"] .cookbook-output-wrap`);

      if (wrap) wrap.classList.remove('cookbook-task-collapsed');

    });

  }

  _collapsedSectionIds.forEach((sid) => {

    const sb = document.getElementById(sid);

    if (sb) sb.style.display = 'none';

    const hdr = body.querySelector(`.cookbook-section-header[data-collapse="${sid}"]`);

    const chevron = hdr?.querySelector('.cookbook-section-chevron');

    if (chevron) { chevron.style.transform = 'rotate(-90deg)'; chevron.style.opacity = ''; }

  });

}



// ── 重连任务（轮询循环）──


async function _reconnectTask(el, task) {

  const output = el.querySelector('.cookbook-output-pre');

  const controller = new AbortController();

  el._abort = controller;

  let failCount = 0;



  while (!controller.signal.aborted) {

    if (!el.isConnected) {

      controller.abort();

      break;

    }

    try {

      const res = await fetch('/api/shell/exec', {

        method: 'POST', credentials: 'same-origin',

        headers: { 'Content-Type': 'application/json' },

        body: JSON.stringify({ command: _tmuxCmd(task, `capture-pane -t ${task.sessionId} -p -S -200`), timeout: 15 }),

      });

      const data = await res.json();



      if (data.exit_code !== 0) {

        failCount++;

        if (failCount < 5) {

          await new Promise(r => setTimeout(r, 3000));

          continue;

        }

        try {

          const verify = await fetch('/api/shell/exec', {

            method: 'POST', credentials: 'same-origin',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ command: _tmuxCmd(task, `has-session -t ${task.sessionId}`) }),

          });

          const vData = await verify.json();

          if (vData.exit_code === 0) {

            failCount = 0;

            await new Promise(r => setTimeout(r, 5000));

            continue;

          }

        } catch {

          await new Promise(r => setTimeout(r, 10000));

          continue;

        }



        const lastOutput = output.textContent || '';

        // Pip 任务（Reinstall vLLM 等）必须跳过
        // 通用 serve `_diagnose` 步骤。其输出是 pip 的，
        // 错误模式（torch ABI 回溯、"No module named torch"）
        // 常与之前 tmux 回滚匹配，
        // 将干净的 pip 成功标记为崩溃服务。
        // 检测与下方 looksSuccessful 分支同形。
        const _isPipTaskDiag = ((task.payload?.repo_id || '').startsWith('pip-'))

          || /python3? -m pip\b/.test(task.payload?._cmd || '');

        const diag = _isPipTaskDiag ? null : _diagnose(lastOutput);

        if (diag) {

          let diagEl = el.querySelector('.cookbook-diagnosis');

          if (!diagEl) {

            diagEl = document.createElement('div');

            diagEl.className = 'cookbook-diagnosis';

            el.appendChild(diagEl);

          }

          _showDiagnosis(el, diag, lastOutput);

          _updateTask(task.sessionId, { status: 'error' });

          el.dataset.status = 'error';

          const badge = el.querySelector('.cookbook-task-status');

          if (badge) { badge.textContent = _statusLabel('error', task.type); badge.className = 'cookbook-task-status cookbook-task-error'; }

          _showCookbookNotif(true);

        } else {

          const downloadLooksSuccessful = !lastOutput.includes('DOWNLOAD_FAILED')

            && (lastOutput.includes('DONE') || lastOutput.includes('100%') || lastOutput.includes('/snapshots/') || lastOutput.includes('Download complete') || lastOutput.includes('DOWNLOAD_OK'));

          // Pip 安装/重装任务通过 _launchServeTask 启动
          //（显示在 Running 标签页 + 使用 tmux）但非真实服务——
          // 命令是 `python3 -m pip ...`，成功标记
          // 是 pip 自己的。无此分支则成功重装无
          // "Uvicorn running on"行，被误标记为崩溃服务。
          
          const _isPipTask = ((task.payload?.repo_id || '').startsWith('pip-'))

            || /python3? -m pip\b/.test(task.payload?._cmd || '');

          const pipLooksSuccessful = _isPipTask

            && /Successfully installed|Requirement already (?:satisfied|up-to-date)/i.test(lastOutput)

            && !/error:|ERROR:/.test(lastOutput.slice(-1024));

          const serveLooksReady = task.type === 'serve' && _serveOutputLooksReady({ ...task, output: lastOutput });

          // 依赖安装作为下载任务跟踪，以 pip exit-0 哨兵
          // 而非 HF 下载标记完成——也需检查。
          // 独立 pip-* 服务以 pip 自身成功行完成，
          // 非 HF 或"Uvicorn running on"。
          const depInstallSucceeded = !!task.payload?._dep && _depInstallSucceeded(lastOutput);

          const looksSuccessful = depInstallSucceeded

            || (task.type === 'download'

              ? downloadLooksSuccessful

              : (_isPipTask ? pipLooksSuccessful : serveLooksReady));

          if (!lastOutput.trim() || !looksSuccessful) {

            _updateTask(task.sessionId, { status: 'crashed' });

            el.dataset.status = 'crashed';

            const badge = el.querySelector('.cookbook-task-status');

            if (badge) { badge.textContent = _statusLabel('crashed', task.type); badge.className = 'cookbook-task-status cookbook-task-crashed'; }

            if (_isPipTask) {

              // Pip 任务：不运行服务诊断（会报
              // "Serve stopped before the model became reachable"）。
              // 显示 pip 定制消息；用户可阅读上方 pip 自身错误输出。
              
              const _ranOk = /Successfully installed|Requirement already (?:satisfied|up-to-date)/i.test(lastOutput);

              if (!_ranOk) {

                _showDiagnosis(el, {

                  message: 'Pip install did not finish with a success marker. Check the output for the underlying error.',

                  suggestion: 'Suggested action: copy the troubleshooting bundle. Common causes: missing build deps, network blip, mismatched torch ABI.',

                  fixes: [],

                }, lastOutput);

              }

            } else if (task.type === 'serve') {

              const diag = _diagnose(lastOutput) || {

                message: _serveTaskLooksAwqOnLocalBackend(task, lastOutput)

                  ? 'AWQ/GPTQ/FP8 cannot be served through llama.cpp/Ollama unified-memory mode.'

                  : /Native llama-server not found|building llama-server|llama\.cpp/i.test(lastOutput)

                  ? 'llama.cpp build stopped before the server became reachable.'

                  : 'Serve stopped before the model became reachable.',

                suggestion: _serveTaskLooksAwqOnLocalBackend(task, lastOutput)

                  ? 'Suggested action: use vLLM/SGLang on a compatible CUDA/ROCm GPU server, or download a GGUF version for llama.cpp/Ollama/unified-memory serving.'

                  : /Native llama-server not found|building llama-server|llama\.cpp/i.test(lastOutput)

                  ? 'Suggested action: copy the troubleshooting bundle, then edit serve settings. For the quickest local/CPU path, use Ollama or a prebuilt llama-server; source builds can take several minutes and fail if build dependencies are incomplete.'

                  : 'Suggested action: copy the troubleshooting bundle, then edit serve settings or relaunch with a CPU/backend fallback.',

                fixes: [{ label: 'Edit serve', action: (panel) => _openServeEditForTask(task) }],

              };

              _showDiagnosis(el, diag, lastOutput);

            } else if (task.type === 'download') {

              const isDisk = /no space left|disk quota|enospc/i.test(lastOutput);

              const isNetwork = /connection|timeout|timed out|incompleteread|chunkedencoding|reset by peer|protocolerror|all connection attempts failed/i.test(lastOutput);

              const progressMatch = String(lastOutput || '').match(/(\d+)%\|/);

              const nearDone = progressMatch && Number(progressMatch[1]) >= 80;

              // 重连：大多数接近结束的"crashed"下载实际已完成——
              // 我们只是错过了 DOWNLOAD_OK//snapshots/ 标记，
              // 因为输出滚动或 tmux 会话提前结束。
              // 探测 has-session 并重新附加 capture-pane
              // 让现有 _reconnectTask 流程获取真实状态。
              
              const _reconnectFix = {

                label: 'Reconnect',

                action: () => {

                  _updateTask(task.sessionId, { status: 'running' });

                  el.dataset.status = 'running';

                  const badge2 = el.querySelector('.cookbook-task-status');

                  if (badge2) { badge2.textContent = _statusLabel('running', task.type); badge2.className = 'cookbook-task-status'; }

                  const _diagEl = el.querySelector('.cookbook-diagnosis');

                  if (_diagEl) _diagEl.remove();

                  const _wave = el.querySelector('.cookbook-task-wave'); if (_wave) _wave.style.display = '';

                  const _up = el.querySelector('.cookbook-task-uptime'); if (_up) _up.style.display = '';

                  _reconnectTask(el, task);

                },

              };

              const diag = {

                message: isDisk

                  ? 'Download stopped because this server ran out of disk space.'

                  : isNetwork

                  ? 'Download stopped after the HuggingFace connection was interrupted.'

                  : nearDone

                  ? 'Download stopped near the end before the final completion marker was captured.'

                  : 'Download stopped before HuggingFace reported completion.',

                suggestion: isDisk

                  ? 'Suggested action: free disk space, then retry the download. HuggingFace resumes incomplete files when possible.'

                  : nearDone

                  ? 'Suggested action: hit Reconnect first — the download may have finished after the output buffer rolled over. Retry only if reconnect cannot recover.'

                  : 'Suggested action: hit Reconnect to re-attach to the tmux session. If that fails, retry — HuggingFace resumes incomplete files when possible.',

                fixes: isDisk

                  ? [

                      { label: 'Retry download', action: () => _retryTask(el, task) },

                      { label: 'Copy last 50 lines', action: () => {

                        const last = String(lastOutput || '').split('\n').slice(-50).join('\n');

                        _copyText(last || 'No download log available.');

                      } },

                    ]

                  : [

                      _reconnectFix,

                      { label: 'Retry download', action: () => _retryTask(el, task) },

                      { label: 'Copy last 50 lines', action: () => {

                        const last = String(lastOutput || '').split('\n').slice(-50).join('\n');

                        _copyText(last || 'No download log available.');

                      } },

                    ],

              };

              _showDiagnosis(el, diag, lastOutput);

              // 自动探测：若 tmux 会话仍存活（下载
              // 确实仍在进行中），_selfHealStaleTasks 将
              // 任务翻回 running，诊断消失无需用户点击 Reconnect。
              
              if (nearDone) setTimeout(() => { _selfHealStaleTasks().catch(() => {}); }, 1200);

            }

            _showCookbookNotif(true);

          } else {

            // 强完成标记——`DOWNLOAD_OK` 由下载器包装器
            // 在模型快照写入磁盘后发出，`/snapshots/`
            // 仅 HF 解析缓存树后出现。二者均结论性。
            // 立即以 done 结案，跳过 30 秒防抖——
            // 防抖仅用于防范歧义标记
            //（裸"100%"/"Download complete"）
            // 在多文件下载中可能中途出现。
            const _strongDone = task.type === 'download'

              && (lastOutput.includes('DOWNLOAD_OK') || lastOutput.includes('/snapshots/'));

            if (_strongDone) {

              _updateTask(task.sessionId, { status: 'done', _doneConfirmAt: null, _lastStatusFlipAt: Date.now() });

              el.dataset.status = 'done';

              const badge = el.querySelector('.cookbook-task-status');

              if (badge) { badge.textContent = _statusLabel('done', task.type); badge.className = 'cookbook-task-status cookbook-task-done'; }

              const _chk = el.querySelector('.cookbook-task-check'); if (_chk) _chk.style.display = '';

              const _sb = el.querySelector('.cookbook-task-serve-btn'); if (_sb) _sb.style.display = '';

              _showCookbookNotif();

              _refreshDepsAfterInstall(task);

              _renderRunningTab();

              _processQueue();

              break;

            }

            // 防抖 done 翻转。tmux capture-pane 可能短暂失败
            //（网络波动、ssh 重连），上方 verify has-session
            // 可能短暂报告死亡即使会话在结束中。
            // 立即标记 done + 定期 _selfHealStaleTasks
            // 再翻回 running 导致状态徽章振荡。
            // 等待 30 秒重新探测：仅 tmux 仍消失才
            // 以 done 结案。若会话重新出现，重启
            // _reconnectTask 使实时捕获恢复。
            
            if (!task._doneConfirmAt) {

              _updateTask(task.sessionId, { _doneConfirmAt: Date.now() + 30000 });

              setTimeout(async () => {

                try {

                  const fresh = _loadTasks().find(t => t.sessionId === task.sessionId);

                  if (!fresh) return;

                  let stillAlive = false;

                  try {

                    const probe = await fetch('/api/shell/exec', {

                      method: 'POST', credentials: 'same-origin',

                      headers: { 'Content-Type': 'application/json' },

                      body: JSON.stringify({ command: _tmuxCmd(task, `has-session -t ${task.sessionId}`), timeout: 5 }),

                    });

                    const pData = await probe.json();

                    stillAlive = pData.exit_code === 0;

                  } catch { /* network blip — treat as inconclusive, prefer running */ stillAlive = true; }

                  if (stillAlive) {

                    _updateTask(task.sessionId, { status: 'running', _doneConfirmAt: null, _lastStatusFlipAt: Date.now() });

                    const _el = document.querySelector(`.cookbook-task[data-task-id="${task.sessionId}"]`);

                    if (_el) {

                      _el.dataset.status = 'running';

                      const _badge = _el.querySelector('.cookbook-task-status');

                      if (_badge) { _badge.textContent = _statusLabel('running', task.type); _badge.className = 'cookbook-task-status'; }

                      const _wave = _el.querySelector('.cookbook-task-wave'); if (_wave) _wave.style.display = '';

                      const _up = _el.querySelector('.cookbook-task-uptime'); if (_up) _up.style.display = '';

                      _reconnectTask(_el, _loadTasks().find(t => t.sessionId === task.sessionId));

                    }

                    return;

                  }

                  _updateTask(task.sessionId, { status: 'done', _doneConfirmAt: null, _lastStatusFlipAt: Date.now() });

                  const _el = document.querySelector(`.cookbook-task[data-task-id="${task.sessionId}"]`);

                  if (_el) {

                    _clearDiagnosis(_el);

                    _el.dataset.status = 'done';

                    const _badge = _el.querySelector('.cookbook-task-status');

                    if (_badge) { _badge.textContent = _statusLabel('done', task.type); _badge.className = 'cookbook-task-status cookbook-task-done'; }

                    const _chk = _el.querySelector('.cookbook-task-check'); if (_chk) _chk.style.display = '';

                    const _sb = _el.querySelector('.cookbook-task-serve-btn'); if (_sb) _sb.style.display = '';

                  }

                  _showCookbookNotif();

                  _refreshDepsAfterInstall(task);

                  _renderRunningTab();

                  _processQueue();

                } catch { /* swallow — next polling cycle will retry */ }

              }, 30000);

            }

          }

        }

        _renderRunningTab();

        _processQueue();

        break;

      }



      const snapshot = (data.stdout || '').trim();

      if (snapshot) {

        // 仅用户已在底部时才自动滚动到底部。
        // 用户向上滚动阅读之前输出时不改变位置。
        // 40px 容差覆盖子像素舍入。
        
        
        const _atBottom = (output.scrollHeight - output.scrollTop - output.clientHeight) < 40;

        output.textContent = snapshot;

        if (_atBottom) output.scrollTop = output.scrollHeight;



        // 下载任务实时状态解析
        if (task.type === 'download') {

          const badge = el.querySelector('.cookbook-task-status');

          if (badge) {

            const completed = (snapshot.match(/Download complete/g) || []).length;

            const downloading = snapshot.match(/Downloading '([^']+)'/g) || [];

            const totalFiles = downloading.length;

            const pctMatches = [...snapshot.matchAll(/(\d+)%\|/g)];

            const lastPct = pctMatches.length ? pctMatches[pctMatches.length - 1][1] : null;

            const speedMatch = [...snapshot.matchAll(/([\d.]+)(?:MB|GB)\/s/g)];

            const lastSpeed = speedMatch.length ? speedMatch[speedMatch.length - 1][0] : null;

            // hf_transfer 输出"Downloading (incomplete total...): 73% | 1.81G/2.49G"
            // 真实聚合字节进度。优先使用此聚合数据。
            
            
            const _dlAggMatches = [...snapshot.matchAll(/Downloading\s*\(incomplete[^)]*\):\s*(\d+)%/g)];

            const _dlAgg = _dlAggMatches.length ? parseInt(_dlAggMatches[_dlAggMatches.length - 1][1]) : null;



            // 停滞下载检测。
            // 使用已下载字节计数作为进度信号：
            // 传输时持续增长（即使百分点在
            // 大 hf_transfer 块期间停滞）且卡住时冻结。
            // 仅百分点会停滞（假卡住），冻结帧仍显示
            // 过时速度/ETA。字节数是诚实信号。
            
            
            const _byteMatches = [...snapshot.matchAll(/([\d.]+\s?[KMGT])B?\s*\/\s*[\d.]+\s?[KMGT]B?/gi)];

            const _bytes = _byteMatches.length ? _byteMatches[_byteMatches.length - 1][1].replace(/\s/g, '') : null;

            // 无字节计数器时（pip resolve/原生构建阶段），
            // 基于输出尾部使新构建行计为进度——否则
            // 长时静默构建被误判停滞并重启动，无限循环。
            
            const curProgress = computeProgressSignal(_bytes, _dlAgg, lastPct, snapshot);

            const _fetchPctMatches = [...snapshot.matchAll(/Fetching\s+\d+\s+files:\s*(\d+)%/g)];

            const _fetchPct = _fetchPctMatches.length ? parseInt(_fetchPctMatches[_fetchPctMatches.length - 1][1]) : null;

            const isPipDep = !!(task.payload && task.payload._dep);

            const _startupStalled = !_bytes && ((_dlAgg === 0) || (_fetchPct === 0)) && curProgress === '0';

            const _STALE_TIMEOUT = _startupStalled ? STARTUP_STALE_PROGRESS_MS : STALE_PROGRESS_MS;

            if (!el._lastProgress) { el._lastProgress = curProgress; el._lastProgressTime = Date.now(); }

            if (curProgress !== el._lastProgress) {

              el._lastProgress = curProgress;

              el._lastProgressTime = Date.now();

            } else if (!isPipDep && Date.now() - (el._lastProgressTime || 0) > _STALE_TIMEOUT && task._autoRestarted) {

              const mins = Math.floor((Date.now() - (el._lastProgressTime || 0)) / 60000);

              // 已自动重启一次且再次停滞——使徽章成为
              // 一键重试（从缓存部分文件恢复），
              // 用户无需深入 ⋮ 菜单。
              badge.textContent = t('cookbook.stalled_hint', { mins: mins });

              badge.className = 'cookbook-task-status cookbook-task-error';

              badge.title = t('cookbook.stalled_click_retry');

              badge.style.cursor = 'pointer';

              if (!badge._retryBound) {

                badge._retryBound = true;

                badge.addEventListener('click', (e) => { e.stopPropagation(); _retryTask(el, task); });

              }

            } else if (!isPipDep && Date.now() - (el._lastProgressTime || 0) > _STALE_TIMEOUT && !task._autoRestarted) {

              task._autoRestarted = true;

              _updateTask(task.sessionId, { _autoRestarted: true });

              badge.textContent = _startupStalled ? t('cookbook.stall_retrying') : t('cookbook.stale_restarting');

              badge.className = 'cookbook-task-status cookbook-task-error';

              _showCookbookNotif(true);

              try {

                await fetch('/api/shell/exec', {

                  method: 'POST', credentials: 'same-origin',

                  headers: { 'Content-Type': 'application/json' },

                  body: JSON.stringify({ command: _tmuxCmd(task, `kill-session -t ${task.sessionId}`) }),

                });

              } catch {}

              try {

                // 重用原始 payload 保留完整 repo_id
                //（如"Qwen/Qwen3.5-..."）——task.repo/name 会丢失组织前缀。
                const dlPayload = task.payload

                  ? { ...task.payload }

                  : { repo_id: task.repo || task.name, remote_host: task.remoteHost || '' };

                if (_envState.hfToken) dlPayload.hf_token = _envState.hfToken;

                // hf_transfer 停滞——在可靠下载器上重启。
                dlPayload.disable_hf_transfer = true;

                // 不覆盖 env_prefix——task.payload 已有正确的
                // "source <path>"形式。纯 envPath 会缺少 `source`
                // 导致 venv 不激活（hf CLI 脱离 PATH）。
                const res = await fetch('/api/model/download', {

                  method: 'POST', credentials: 'same-origin',

                  headers: { 'Content-Type': 'application/json' },

                  body: JSON.stringify(dlPayload),

                });

                const data = await res.json();

                if (data.ok && data.session_id) {

                  _updateTask(task.sessionId, { sessionId: data.session_id, status: 'running', output: '' });

                  task.sessionId = data.session_id;

                  el._lastProgress = null;

                  el._lastProgressTime = Date.now();

                  badge.textContent = t('cookbook.restarted');

                  badge.className = 'cookbook-task-status cookbook-task-running';

                  continue;

                }

              } catch {}

              badge.textContent = t('cookbook.stale_restart_failed');

              badge.className = 'cookbook-task-status cookbook-task-error';

              _showCookbookNotif(true);

              break;

            }



            // 若快照含分片标记如
            // "model-00006-of-00082.safetensors"，
            // 真实整体进度 = ((分片-1)+当前分片比例)/总分片。
            // 此前 _dlAgg 被当作整体，实际仅当前分片进度。
            
            
            const _shardPat = [...snapshot.matchAll(/model-(\d+)-of-(\d+)\.(?:safetensors|bin)/g)];

            const _lastShard = _shardPat.length ? _shardPat[_shardPat.length - 1] : null;

            const _curShardNum = _lastShard ? parseInt(_lastShard[1], 10) : null;

            const _totalShards = _lastShard ? parseInt(_lastShard[2], 10) : null;

            const _useShardAgg = _curShardNum && _totalShards && _totalShards > 1;



            // HF 自身"Fetching N files: X%"聚合统计所有文件含之前会话已完成的。
            // 因此恢复下载时反映真实整体进度。
            // 取二者较高值避免恢复下载读为 0%。
            
            
            if (_useShardAgg) {

              // 多分片下载：计算真实整体为已完成分片
              // + 当前分片比例。_dlAgg/lastPct 仅代表
              // *此分片*进度，非整体下载。
              const curShardFrac = (_dlAgg != null)

                ? _dlAgg / 100

                : (lastPct ? parseInt(lastPct, 10) / 100 : 0);

              let overallPct = Math.round((((_curShardNum - 1) + curShardFrac) / _totalShards) * 100);

              if (_fetchPct != null) overallPct = Math.max(overallPct, _fetchPct);

              let text = `${overallPct}%`;

              if (lastSpeed) text += ` · ${lastSpeed}`;

              badge.textContent = text;

              badge.className = 'cookbook-task-status cookbook-task-running';

            } else if (_dlAgg != null) {

              // 真实聚合字节进度——最准确；取所有信号最大值。
              let pct = _dlAgg;

              if (_fetchPct != null) pct = Math.max(pct, _fetchPct);

              let text = `${pct}%`;

              if (lastSpeed) text += ` · ${lastSpeed}`;

              badge.textContent = text;

              badge.className = 'cookbook-task-status cookbook-task-running';

            } else if (totalFiles > 0 && completed < totalFiles) {

              const curFilePct = lastPct ? parseInt(lastPct) / 100 : 0;

              let overallPct = Math.round(((completed + curFilePct) / totalFiles) * 100);

              if (_fetchPct != null) overallPct = Math.max(overallPct, _fetchPct);

              let text = `${overallPct}%`;

              if (lastSpeed) text += ` · ${lastSpeed}`;

              badge.textContent = text;

              badge.className = 'cookbook-task-status cookbook-task-running';

            } else if (_fetchPct != null && _fetchPct < 100) {

              // 恢复开始时仅聚合有意义。
              let text = `${_fetchPct}%`;

              if (lastSpeed) text += ` · ${lastSpeed}`;

              badge.textContent = text;

              badge.className = 'cookbook-task-status cookbook-task-running';

            } else if (completed > 0 && completed >= totalFiles) {

              badge.textContent = t('cookbook.finishing');

              badge.className = 'cookbook-task-status cookbook-task-running';

            }

            if (snapshot.includes('DOWNLOAD_FAILED')) {

              // 包装器输出 DOWNLOAD_FAILED 但退出 0，逐文件
              // "Download complete"/"100%"行使它看似成功——
              // 捕获显式失败标记并处理。
              // 门控/认证失败绝无法通过重试修复（HF token
              // 已发送但账户未获批准）——跳过自动重试
              // 并直接显示门控诊断。
              const _accessDenied = /Access to model.*is restricted|gated repo|GatedRepoError|401 Unauthorized|403 Forbidden|not in the authorized list|awaiting a review|must (?:be authenticated|have access)/i.test(snapshot);

              const _dlKey = task.payload?.repo_id || task.name;

              const _dlN = _dlRetryCount.get(_dlKey) || 0;

              if (!controller.signal.aborted && !_accessDenied && task.type === 'download' && task.payload && _dlN < _DL_MAX_AUTO_RETRY) {

                // 自动重试：kill 死会话并重新启动
                //（从缓存 .incomplete 文件恢复），延迟后执行。
                _dlRetryCount.set(_dlKey, _dlN + 1);

                badge.textContent = t('cookbook.retrying_progress', { n: _dlN + 1, m: _DL_MAX_AUTO_RETRY });

                badge.className = 'cookbook-task-status cookbook-task-running';

                uiModule.showToast(t('cookbook.retrying_toast', { n: _dlN + 1, m: _DL_MAX_AUTO_RETRY }), 6000);

                const _p = task.payload, _nm = task.name;

                try {

                  await fetch('/api/shell/exec', {

                    method: 'POST', credentials: 'same-origin',

                    headers: { 'Content-Type': 'application/json' },

                    body: JSON.stringify({ command: _tmuxCmd(task, `kill-session -t ${task.sessionId}`) }),

                  });

                } catch {}

                _removeTask(task.sessionId);

                setTimeout(() => { _retryDownload(_nm, _p); }, 8000);

                break;

              }

              // 超过自动重试次数（或非下载）——显示错误；
              // 卡片 Retry 按钮仍可手动恢复。
              badge.textContent = _statusLabel('error', task.type);

              badge.className = 'cookbook-task-status cookbook-task-error';

              _updateTask(task.sessionId, { status: 'error' });

              el.dataset.status = 'error';

              // 用可操作按钮解释门控/访问失败（在 HF 上请求
              // 访问、检查 token）——否则只是原始红色文本。
              if (_accessDenied) {

                const _diag = _diagnose(snapshot);

                if (_diag) {

                  let diagEl = el.querySelector('.cookbook-diagnosis');

                  if (!diagEl) { diagEl = document.createElement('div'); diagEl.className = 'cookbook-diagnosis'; el.appendChild(diagEl); }

                  _showDiagnosis(el, _diag, snapshot);

                }

              }

              _showCookbookNotif(true);

              break;

            }

            if (snapshot.includes('DOWNLOAD_OK') || (snapshot.includes('/snapshots/') && completed >= totalFiles && totalFiles > 0)) {

              _clearDiagnosis(el);

              _dlRetryCount.delete(task.payload?.repo_id || task.name);

              badge.textContent = _statusLabel('done', task.type);

              badge.className = 'cookbook-task-status cookbook-task-done';

              // 将类型芯片从"download"翻为绿色"finished"徽章，
              // 使标题显示完成无过时标签。
              const _typeChip = el.querySelector('.cookbook-task-type');

              if (_typeChip) { _typeChip.textContent = t('cookbook.finished'); _typeChip.classList.add('cookbook-task-type-done'); }

              _updateTask(task.sessionId, { status: 'done' });

              const _sb2 = el.querySelector('.cookbook-task-serve-btn'); if (_sb2) _sb2.style.display = '';

              _showCookbookNotif();

              _refreshDepsAfterInstall(task);

              fetch('/api/shell/exec', {

                method: 'POST', credentials: 'same-origin',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({ command: _tmuxCmd(task, `kill-session -t ${task.sessionId}`) }),

              }).catch(() => {});

              _processQueue();

              break;

            }

          }

        }



        // 服务任务实时状态解析——使用共享 _parseServePhase
        if (task.type === 'serve') {

          const badge = el.querySelector('.cookbook-task-status');

          if (badge) {

            const info = _parseServePhase(snapshot);

            if (info.status === 'ready' && !task._serveReady) {

              task._serveReady = true;

              _updateTask(task.sessionId, { _serveReady: true });

              // 自动注册端点被标记离线时服务器还在启动中。
              // 现在可到达了，推动选择器重新探测使
              // 离线标记清除，用户无需重开 Settings 或刷新页面。
              
              try { _refreshModelsAfterEndpointChange(); } catch (_) {}

            }

            if (info.phase) {

              badge.textContent = info.phase;

              // 始终绿色"running"样式——loading/warming 是同状态，
              // 仅文本动态变化（不切换到中性样式）。
              badge.className = 'cookbook-task-status cookbook-task-running';

              // 实时输出报告 'ready' 是服务器已启动的直接证据——
              // 也清除过时"unreachable"标志。HTTP 探测可能滞后、
              // 错过远程端点或缓存 down 结果，使卡片卡在红色。
              
              if (info.status === 'ready' && task._unreachable) {

                task._unreachable = false;

                _updateTask(task.sessionId, { _unreachable: false });

                el.classList.remove('cookbook-task-unreachable');

                _refreshServerDots();

              }

              // 持久化加载阶段使重新渲染保持显示"loading 45%"
              // 而非重置为通用"running"。ready 后清除。
              
              if (info.status !== 'ready') {

                if (task.progress !== info.phase) _updateTask(task.sessionId, { progress: info.phase });

              } else if (task.progress) {

                _updateTask(task.sessionId, { progress: '' });

              }

            }

          }

        }



        // 在服务任务上运行错误诊断
        const diag = _diagnose(snapshot);

        if (diag) {

          let diagEl = el.querySelector('.cookbook-diagnosis');

          if (!diagEl) {

            diagEl = document.createElement('div');

            diagEl.className = 'cookbook-diagnosis';

            el.appendChild(diagEl);

          }

          _showDiagnosis(el, diag, snapshot);

        }

        // 检测服务就绪——自动添加到模型端点。POST 成功
        // 后才翻转 `_endpointAdded`；否则瞬时错误
        // 会静默阻止所有未来重试。飞行守卫
        // 防止第二次轮询在第一次去重检查能观察到
        // 新添加行前发起重复 POST。
        if (task.type === 'serve' && !task._endpointAdded && !task._endpointAddInFlight && task._serveReady) {

          task._endpointAddInFlight = true;

          let host = _connectHostFromRemote(task.remoteHost);

          const portMatch = task.payload?._cmd?.match(/--port[=\s]+(\d+)/)

            || task.payload?._cmd?.match(/(?:^|\s)-p[=\s]+(\d+)/)

            || snapshot.match(/Uvicorn running on\D*?:(\d+)/i)

            || snapshot.match(/running on\D*?:(\d+)/i)

            || snapshot.match(/listening on\D*?:(\d+)/i)

            || snapshot.match(/port[:=\s]+(\d+)/i);

          let port = portMatch ? portMatch[1] : '8000';

          let baseUrl = `http://${host}:${port}/v1`;

          const ollamaUrlMatch = snapshot.match(/Ollama API ready on port\s+\d+:\s*(http:\/\/[^\s]+)/i);

          if (ollamaUrlMatch) {

            const endpoint = _endpointFromAdvertisedUrl(ollamaUrlMatch[1], host, '11434');

            if (endpoint) ({ host, port, baseUrl } = endpoint);

          }

          fetch('/api/model-endpoints', { credentials: 'same-origin' })

            .then(r => r.json())

            .then(async (eps) => {

              // 仅匹配精确 base_url——不按友好名称去重，
              // 因其他端点可能碰巧共享模型名称。
              const exists = eps.some(e => e.base_url === baseUrl);

              if (exists) {

                // 已注册——例如后端预先注册了 diffusion 端点。
                // 标记为不重试，但仍刷新选择器
                //（并探测直到在线）使新模型无需手动刷新即可显示。
                
                task._endpointAdded = true;

                _updateTask(task.sessionId, { _endpointAdded: true });

                _autoSaveWorkingConfig(task);   // endpoint live → remember these settings

                if (window.modelsModule?.refreshModels) await window.modelsModule.refreshModels(true);

                if (window.sessionModule?.updateModelPicker) window.sessionModule.updateModelPicker();

                window.dispatchEvent(new CustomEvent('ge:model-endpoints-updated', { detail: { baseUrl, host, port, model: task.name } }));

                const _ex = eps.find(e => e.base_url === baseUrl);

                if (_ex && _ex.id && !(_ex.models || []).length) _probeEndpointUntilOnline(_ex.id, host, port);

                return null;

              }

              const _isDiffusion = task.payload?._cmd?.includes('diffusion_server');

              const fd = new FormData();

              fd.append('base_url', baseUrl);

              fd.append('name', task.name);

              fd.append('skip_probe', 'true');

              _appendCookbookEndpointScope(fd, task.remoteHost || '');

              if (_isDiffusion) fd.append('model_type', 'image');

              return fetch('/api/model-endpoints', { method: 'POST', credentials: 'same-origin', body: fd });

            })

            .then(async (res) => {

              if (res && res.ok) {

                // 仅在确认成功时翻转标志
                task._endpointAdded = true;

                _updateTask(task.sessionId, { _endpointAdded: true });

                _autoSaveWorkingConfig(task);   // endpoint live → remember these settings

                uiModule.showToast(`Model endpoint added: ${host}:${port}`);

                // 重试探测直到预热服务器响应，
                // 无需手动启用/禁用切换即可在线。
                const _epData = await res.json().catch(() => ({}));

                if (_epData && _epData.id && !(_epData.models || []).length) {

                  _probeEndpointUntilOnline(_epData.id, host, port);

                }

                window.dispatchEvent(new CustomEvent('ge:model-endpoints-updated', { detail: { baseUrl, host, port, model: task.name } }));

                const _trySelectModel = async (attempt) => {

                  if (window.modelsModule?.refreshModels) await window.modelsModule.refreshModels(true);

                  const items = window.modelsModule?.getCachedItems?.() || [];

                  for (const item of items) {

                    if (item.offline) continue;

                    const url = item.url || '';

                    if (url.includes(host) || url.includes(port)) {

                      const mid = (item.models || [])[0];

                      if (mid && window.sessionModule?.createDirectChat) {

                        window.sessionModule.createDirectChat(url, mid, item.endpoint_id);

                        if (window.sessionModule?.updateModelPicker) window.sessionModule.updateModelPicker();

                        uiModule.showToast(`Switched to ${mid.split('/').pop()}`);

                        return;

                      }

                    }

                  }

                  if (attempt < 3) setTimeout(() => _trySelectModel(attempt + 1), 2000);

                  else if (window.sessionModule?.updateModelPicker) window.sessionModule.updateModelPicker();

                };

                setTimeout(() => _trySelectModel(0), 1000);

              } else if (res && !res.ok) {

                const body = await res.text().catch(() => '');

                console.warn('Endpoint auto-add failed', res.status, body);

                uiModule.showError(`Auto-register endpoint failed (${res.status}). Use ⋮ → Register endpoint to retry.`);

              }

            })

            .catch((e) => {

              console.warn('Endpoint auto-add error', e);

              uiModule.showError(`Auto-register endpoint error: ${e.message || e}. Use ⋮ → Register endpoint to retry.`);

            })

            .finally(() => { task._endpointAddInFlight = false; });

          _updateTask(task.sessionId, { status: 'running' });

          const badge = el.querySelector('.cookbook-task-status');

          if (badge) { badge.textContent = 'running'; badge.className = 'cookbook-task-status cookbook-task-running'; }

          _showCookbookNotif();

        }

        // 检测进程退出
        if (snapshot.includes('=== Process exited with code')) {

          const codeMatch = snapshot.match(/=== Process exited with code (\d+)/);

          const code = codeMatch ? parseInt(codeMatch[1]) : -1;

          // 未到达 ready 状态即退出的服务任务始终是错误——
          // 服务进程应无限运行
          const status = (task.type === 'serve' && !task._serveReady) ? 'error'

            : (code === 0 ? 'done' : 'error');

          _updateTask(task.sessionId, { status });

          const badge = el.querySelector('.cookbook-task-status');

          if (badge) { badge.textContent = status; badge.className = `cookbook-task-status cookbook-task-${status}`; }

          _renderRunningTab();

        }

        _updateTask(task.sessionId, { output: snapshot.slice(-5000) });

      }

    } catch {

      failCount++;

      if (failCount > 10) break;

      await new Promise(r => setTimeout(r, 10000));

      continue;

    }



    failCount = 0;

    await new Promise(r => setTimeout(r, TASK_POLL_INTERVAL_MS));

  }

}



// ── 后台监控 ──


let _bgMonitorInterval = null;



// 运行中服务任务可达性检查。tmux 窗格可能保持存活
// 而内部模型服务器已崩溃（因此永无"Process exited"行）——
// 导致卡片永远显示"running"。因此主动探测注册端点
// 并在服务器停止响应时标记"unreachable"（红色）。

async function _checkServeReachability() {

  let serveTasks;

  try {

    serveTasks = _loadTasks().filter(t => t.type === 'serve' && t.status === 'running');

  } catch { return; }

  if (!serveTasks.length) return;

  let eps = [], probe = {};

  try {

    [eps, probe] = await Promise.all([

      fetch('/api/model-endpoints', { credentials: 'same-origin' }).then(r => r.json()).catch(() => []),

      fetch('/api/model-endpoints/probe-local', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),

    ]);

  } catch { return; }

  for (const task of serveTasks) {

    const host = _connectHostFromRemote(task.remoteHost);

    const portMatch = task.payload?._cmd?.match(/--port\s+(\d+)/);

    const port = portMatch ? portMatch[1] : '8000';

    const baseUrl = `http://${host}:${port}/v1`;

    const ep = (eps || []).find(e => e.base_url === baseUrl);

    if (!ep) continue;                       // not registered yet — can't judge

    const pr = probe[ep.id];

    if (!pr || pr.alive === undefined) continue;  // not probed (non-local) — skip

    // 记录首次实际响应时间。在那之前服务器仍在
    // LOADING/预热（端点可能在 300 秒超时上注册，
    // 大模型尚未完成加载），尚未响应的服务器
    // 不是"unreachable"——启动中这样标记是假警报。
    // 仅在至少曾可达一次后才视为不可达。
    if (pr.alive === true && !task._everReachable) {

      task._everReachable = true;

      _updateTask(task.sessionId, { _everReachable: true });

    }

    const unreachable = pr.alive === false;

    if (unreachable && !task._everReachable) continue;  // still coming up, not crashed

    if (!!task._unreachable !== unreachable) {

      _updateTask(task.sessionId, { _unreachable: unreachable });

    }

    const el = document.querySelector(`.cookbook-task[data-task-id="${task.sessionId}"]`);

    if (el) {

      el.classList.toggle('cookbook-task-unreachable', unreachable);

      const badge = el.querySelector('.cookbook-task-status');

      if (badge) {

        if (unreachable) {

          badge.textContent = 'unreachable';

          badge.className = 'cookbook-task-status cookbook-task-error';

          badge.title = pr.error || 'Server not responding — it may have crashed';

        } else if (badge.textContent === 'unreachable') {

          // 已恢复——恢复正常 running 标签。
          badge.textContent = _statusLabel('running', task.type);

          badge.className = 'cookbook-task-status cookbook-task-running';

          badge.title = '';

        }

      }

    }

    if (unreachable) _showCookbookNotif(true);

  }

  _refreshServerDots();

}



function _serveTaskFailed(task) {

  if (!task || task.type !== 'serve') return false;

  return !!task._unreachable || ['error', 'crashed', 'failed'].includes(task.status);

}



function _setServerDot(dot, failed, title) {

  if (!dot) return;

  dot.classList.toggle('fail', !!failed);

  dot.classList.toggle('ok', !failed);

  dot.title = title;

}



function _syncSettingsServerDots(byKey) {

  document.querySelectorAll('.cookbook-server-entry').forEach(entry => {

    const hostEl = entry.querySelector('.cookbook-srv-host');

    const dot = entry.querySelector('.cookbook-srv-status');

    const msg = entry.querySelector('.cookbook-srv-test-msg');

    if (!hostEl || !dot) return;



    const host = hostEl.value?.trim() || '';

    if (!host || hostEl.readOnly || hostEl.disabled) {

      _setServerDot(dot, false, 'Local (this machine)');

      return;

    }



    const list = byKey[host] || [];

    if (!list.length) return;



    const failed = list.some(_serveTaskFailed);

    _setServerDot(dot, failed, failed ? 'Server not responding - running serve may have crashed' : 'Reachable');

    if (!msg) return;



    if (failed) {

      msg.textContent = 'Server not responding';

      msg.title = 'Server not responding - running serve may have crashed';

      msg.style.color = 'var(--red,#e06c75)';

      msg.style.opacity = '0.75';

    } else if (/failed|crashed|not responding|unreachable/i.test(msg.textContent || '')) {

      msg.textContent = 'Reachable';

      msg.title = 'Reachable';

      msg.style.color = 'var(--green,#50fa7b)';

      msg.style.opacity = '0.75';

    }

  });

}



// 保持每服务器段落状态点（绿↔红）与活动
// 服务任务运行状况同步。标题点仅构建一次，无此则卡在首个值。
// 下载不计因无端点可"unreachable"。

function _refreshServerDots() {

  let tasks;

  try { tasks = _loadTasks(); } catch { return; }

  const byKey = {};

  for (const t of tasks) { (byKey[t.remoteHost || ''] = byKey[t.remoteHost || ''] || []).push(t); }

  document.querySelectorAll('.cookbook-section-header').forEach(header => {

    const dot = header.querySelector('.cookbook-srv-status');

    if (!dot) return;

    const key = header.querySelector('[data-stop-server]')?.dataset.stopServer || '';

    const list = byKey[key] || [];

    const fail = !!key && list.some(_serveTaskFailed);

    _setServerDot(dot, fail, key ? (fail ? 'Server not responding' : 'Reachable') : 'Local (this machine)');

  });

  _syncSettingsServerDots(byKey);

}



// 自愈：扫描标记为 done/error/crashed 的持久化下载任务
// 检查其 tmux 会话在主机上是否仍存活。若是——
// 任务实际未完成，cookbook 仅在重启中丢失了进行中状态——
// 将状态翻回 'running' 使 _reconnectTask 接管。
// 调用者（打开路径）或内部时间节流强制执行一次性守卫。

let _selfHealRan = false;

let _selfHealLastTs = 0;

export async function _selfHealStaleTasks(opts = {}) {

  // 打开路径调用：每页面加载一次性。
  if (opts.oneShot) {

    if (_selfHealRan) return;

    _selfHealRan = true;

  } else {

    // 后台监控调用：节流为每 8 秒一次（bg 监控
    // 本身每 10 秒触发，所以这几乎总是触发，
    // 但守卫防止快速手动调用重复触发）。
    const now = Date.now();

    if (now - _selfHealLastTs < 4000) return;

    _selfHealLastTs = now;

  }

  const tasks = _loadTasks();

  const candidates = tasks.filter(t => {

    if (t.type !== 'download') return false;

    if (!['done', 'error', 'crashed', 'stopped'].includes(t.status)) return false;

    if (!t.sessionId || String(t.sessionId).startsWith('queue-')) return false;

    // 有强完成标记（DOWNLOAD_OK 或 HF
    // /snapshots/ 解析）的已完成下载已确认完成——
    // 不因 tmux 会话仍存活就翻回 running
    //（例如长期运行 shell 或波动 SSH）。
    // 这是不稳定连接上完成↔下载振荡的主因。
    
    if (t.status === 'done' && /DOWNLOAD_OK|\/snapshots\//.test(t.output || '')) return false;

    // 冷却：永不在 45 秒内多次翻转同一任务。
    // 波动 SSH 连接曾让徽章每次探测来回切换；
    // 这强制执行波动间的稳定视图。
    if (t._lastStatusFlipAt && (Date.now() - t._lastStatusFlipAt < 45000)) return false;

    return true;

  });

  if (!candidates.length) return;

  let flipped = 0;

  for (const t of candidates) {

    try {

      const res = await fetch('/api/shell/exec', {

        method: 'POST', credentials: 'same-origin',

        headers: { 'Content-Type': 'application/json' },

        body: JSON.stringify({ command: _tmuxCmd(t, `has-session -t ${t.sessionId}`), timeout: 5 }),

      });

      const data = await res.json();

      if (data.exit_code === 0) {

        // 会话仍存活 → 任务实际仍在运行。
        const fresh = _loadTasks();

        const ft = fresh.find(x => x.sessionId === t.sessionId);

        if (ft && ft.status !== 'running') {

          ft.status = 'running';

          ft._selfHealed = true;

          ft._lastStatusFlipAt = Date.now();

          _saveTasks(fresh);

          flipped++;

          const _el = document.querySelector(`.cookbook-task[data-task-id="${t.sessionId}"]`);

          if (_el) {

            const _chk = _el.querySelector('.cookbook-task-check');

            if (_chk) _chk.style.display = 'none';

            const _wave = _el.querySelector('.cookbook-task-wave');

            if (_wave) _wave.style.display = '';

            const _up = _el.querySelector('.cookbook-task-uptime');

            if (_up) _up.style.display = '';

            _el.dataset.status = 'running';

          }

        }

      }

    } catch { /* network blip — skip this one */ }

  }

  if (flipped) {

    console.log(`[cookbook] auto-reconnect: revived ${flipped} task(s) whose tmux session was still alive`);

    _renderRunningTab();

  }

}



export function _startBackgroundMonitor() {

  if (_bgMonitorInterval) return;

  _bgMonitorInterval = setInterval(() => {

    _pollBackgroundStatus();

    _checkServeReachability();

    // 自动重连：每周期查找标记为 finished/
    // crashed 等但 tmux 会话实际仍在运行的下载任务
    // 并翻回 running。内部节流 8 秒防重复。
    
    _selfHealStaleTasks().catch(() => {});

  }, BG_MONITOR_INTERVAL_MS);

  _pollBackgroundStatus();

  _checkServeReachability();

}



function _stopBackgroundMonitor() {

  if (_bgMonitorInterval) {

    clearInterval(_bgMonitorInterval);

    _bgMonitorInterval = null;

  }

  const statusEl = document.getElementById('cookbook-bg-status');

  if (statusEl) statusEl.style.display = 'none';

}



// 对新添加端点重试探测直到其模型服务器响应。
// 刚在 cookbook 中达到"ready"的模型常无法满足
// 1 秒添加时探测（远程、权重仍在 mmap）故被添加为离线。
// 此轮询每端点 /probe，每几秒一次直到
// 端点报告模型，然后刷新选择器。有界防止
// 确实死机的服务器无限轮询。

async function _probeEndpointUntilOnline(epId, host, port) {

  if (!epId) return;

  // 大模型（如 70B+）在服务器响应 /v1/models 前可能需要
  // 几分钟加载权重。探测最多约 5 分钟，
  // 逐步延长间隔避免长时间预热中过度请求。
  const MAX_TRIES = 40;

  for (let i = 0; i < MAX_TRIES; i++) {

    const interval = i < 12 ? 5000 : 10000;   // 前一分钟每 5 秒，之后每 10 秒

    await new Promise(r => setTimeout(r, interval));

    try {

      // 命中探测端点——在服务器端重新探测并更新
      // cached_models。我们消费（并丢弃）SSE 流。
      await fetch(`/api/model-endpoints/${epId}/probe`, { credentials: 'same-origin' }).then(r => r.text()).catch(() => {});

      const eps = await fetch('/api/model-endpoints', { credentials: 'same-origin' }).then(r => r.json()).catch(() => []);

      const ep = (eps || []).find(e => e.id === epId);

      if (ep && (ep.models || []).length) {

        if (window.modelsModule?.refreshModels) await window.modelsModule.refreshModels(true);

        if (window.sessionModule?.updateModelPicker) window.sessionModule.updateModelPicker();

        window.dispatchEvent(new CustomEvent('ge:model-endpoints-updated', {

          detail: { baseUrl: ep.base_url || `http://${host}:${port}/v1`, host, port, model: (ep.models || [])[0] || '' },

        }));

        uiModule.showToast(`${host}:${port} is online`);

        return;

      }

    } catch (_) { /* keep retrying */ }

  }

}



async function _pollBackgroundStatus() {

  try {

    // 拉取服务器知晓但 localStorage 中不存在的任务
    //（如 agent 生成的下载/服务）。无此合并则
    // _syncToServer 每次轮询持续覆盖服务器添加的任务。
    try {

      const stateRes = await fetch('/api/cookbook/state', { credentials: 'same-origin' });

      if (stateRes.ok) {

        const serverState = await stateRes.json();

        const serverTasks = (serverState && Array.isArray(serverState.tasks)) ? serverState.tasks : [];

        if (serverTasks.length) {

          const localTasks = _loadTasks();

          const localIds = new Set(localTasks.map(t => t.sessionId));

          const merged = [...localTasks];

          let added = 0;

          for (const t of serverTasks) {

            if (t && t.sessionId && !localIds.has(t.sessionId) && !_isTombstoned(t.sessionId)) {

              merged.push(t);

              added++;

            }

          }

          if (added > 0) {

            localStorage.setItem(TASKS_KEY, JSON.stringify(merged.map(_stripTaskSecrets)));

            _renderRunningTab();

          }

        }

      }

    } catch (_) { /* non-fatal */ }



    const res = await fetch('/api/cookbook/tasks/status', { credentials: 'same-origin' });

    if (!res.ok) return;

    const data = await res.json();

    const tasks = data.tasks || [];



    // 将权威 tmux/进程状态调和回持久化客户端任务列表。
    // Running 标签页重连循环也做此操作，但仅在
    // 卡片渲染时存在；页面刷新或模态框关闭后
    // 依赖安装可能在服务器端完成而 localStorage 仍卡在"running"。
    
    try {

      const statusById = new Map(tasks.map(t => [t.session_id, t]));

      const localTasks = _loadTasks();

      let changed = false;

      const completedDeps = [];

      for (const task of localTasks) {

        const live = statusById.get(task.sessionId);

        if (!live) continue;

        const updates = {};

        // tmux 窗格消失的已完成依赖安装被后端报告为
        // "stopped"。从保留输出的 exit-0 哨兵恢复"done"，
        // 使干净安装不被降级为 crashed。
        
        const depDone = !!task.payload?._dep && _depInstallSucceeded(task.output);

        const nextStatus = live.status === 'completed'

          ? 'done'

          : (live.status === 'error'

            ? 'error'

            : (live.status === 'stopped'

                ? (depDone ? 'done' : (task.type === 'download' ? 'crashed' : 'stopped'))

                : null));

        if (nextStatus && task.status !== nextStatus) {

          updates.status = nextStatus;

          if (nextStatus === 'done' && task.payload?._dep) completedDeps.push(task);

        }

        if ((live.status === 'running' || live.status === 'ready') && task.status !== live.status) {

          updates.status = live.status === 'ready' ? 'ready' : 'running';

        }

        if (live.progress && live.progress !== task.progress) updates.progress = live.progress;

        if (live.output_tail) {

          const previous = String(task.output || '');

          const tail = String(live.output_tail || '');

          if (tail && !previous.endsWith(tail)) {

            updates.output = `${previous ? `${previous}\n` : ''}${tail}`.slice(-5000);

          }

        }

        if (live.diagnosis && !task._diagnosisDismissed) {

          updates._backendDiagnosis = live.diagnosis;

        }

        if (live.cmd && !task.payload?._cmd) {

          updates.payload = { ...(task.payload || {}), _cmd: live.cmd };

        }

        if (Object.keys(updates).length) {

          Object.assign(task, updates);

          changed = true;

        }

      }

      if (changed) {

        _saveTasks(localTasks);

        _renderRunningTab();

        for (const task of localTasks) {

          if (!task._backendDiagnosis) continue;

          const el = document.querySelector(`[data-session-id="${CSS.escape(task.sessionId)}"]`);

          if (!el || el.querySelector('.cookbook-diagnosis')) continue;

          _showDiagnosis(el, task._backendDiagnosis, task.output || '');

        }

        completedDeps.forEach(t => _refreshDepsAfterInstall(t));

      }

    } catch (_) { /* non-fatal: background status should never break polling */ }



    const statusEl = document.getElementById('cookbook-bg-status');

    const activeTasks = tasks.filter(t => t.status === 'running' || t.status === 'ready');

    const errorTasks = tasks.filter(t => t.status === 'error');

    const completedTasks = tasks.filter(t => t.status === 'completed');



    // 自动添加就绪的服务端点（模态框关闭时也工作）
    const readyServes = tasks.filter(t => t.type === 'serve' && t.status === 'ready');

    for (const t of readyServes) {

      const localTasks = _loadTasks();

      const localTask = localTasks.find(lt => lt.sessionId === t.session_id);

      if (localTask && localTask._endpointAdded) continue;



      let host = _connectHostFromRemote(localTask?.remoteHost || t.remote);

      const portMatch = localTask?.payload?._cmd?.match(/--port\s+(\d+)/)

        || localTask?.payload?._cmd?.match(/OLLAMA_HOST=[^\s:]+:(\d+)/);

      let port = portMatch ? portMatch[1] : '8000';

      let baseUrl = `http://${host}:${port}/v1`;

      const snapshot = t.output || localTask?.output || '';

      const ollamaUrlMatch = snapshot.match(/Ollama API ready on port\s+\d+:\s*(http:\/\/[^\s]+)/i);

      if (ollamaUrlMatch) {

        const endpoint = _endpointFromAdvertisedUrl(ollamaUrlMatch[1], host, '11434');

        if (endpoint) ({ host, port, baseUrl } = endpoint);

      }

      const _isDiffusion = localTask?.payload?._cmd?.includes('diffusion_server');



      _updateTask(t.session_id, { _serveReady: true, _endpointAdded: true });

      if (localTask) _autoSaveWorkingConfig(localTask);   // remember working settings (modal may be closed)



      // 从服务命令自动检测函数调用支持。
      // vLLM 仅使用 `--enable-auto-tool-choice` 启动时
      // 才发出 OpenAI 风格 tool_calls；否则本地模型
      // 会幻觉出后端无法解析的伪文本格式。
      
      const _cmd = localTask?.payload?._cmd || '';

      const _supportsTools = _cmd.includes('--enable-auto-tool-choice') || _isDiffusion === false && /(?:^|\s)(?:deepseek|gpt-[45o]|claude|gemini|qwen3|qwen2\.5|mixtral|llama-[34]|minimax|kimi|hermes|glm-4)/i.test(t.model);



      fetch('/api/model-endpoints', { credentials: 'same-origin' })

        .then(r => r.json())

        .then(eps => {

          const hostPort = `${host}:${port}`;

          const existing = eps.find(e => e.base_url === baseUrl || e.base_url.includes(hostPort) || e.name === t.model);

          if (existing) {

            // 已注册——但可能显示离线因
            // 在服务器仍在预热时添加。触发重新探测
            // 使其无需手动切换即可在线。
            if (!(existing.models || []).length) _probeEndpointUntilOnline(existing.id, host, port);

            return null;

          }

          const fd = new FormData();

          fd.append('base_url', baseUrl);

          fd.append('name', t.model);

          fd.append('skip_probe', 'true');

          _appendCookbookEndpointScope(fd, localTask?.remoteHost || t.remote || '');

          if (_isDiffusion) fd.append('model_type', 'image');

          if (_supportsTools) fd.append('supports_tools', 'true');

          return fetch('/api/model-endpoints', { method: 'POST', credentials: 'same-origin', body: fd });

        })

        .then(async (res) => {

          if (res && res.ok) {

            uiModule.showToast(`Model endpoint added: ${host}:${port}`);

            const data = await res.json().catch(() => ({}));

            // 刚启动的服务器常无法在 1 秒添加时探测中
            // 响应，因此落入"offline"。后台重试探测
            // 直到 /v1/models 响应——无需手动启用/禁用。
            if (data && data.id) _probeEndpointUntilOnline(data.id, host, port);

            if (window.modelsModule?.refreshModels) await window.modelsModule.refreshModels(true);

            if (window.sessionModule?.updateModelPicker) window.sessionModule.updateModelPicker();

          }

        })

        .catch(() => {});

    }



    if (errorTasks.length > 0) {

      _showCookbookNotif(true);

    } else if (completedTasks.length > 0) {

      _showCookbookNotif(false);

    } else if (activeTasks.length > 0) {

      _showCookbookNotif(false);

    } else {

      _clearCookbookNotif();

      _stopBackgroundMonitor();

    }



    if (statusEl) {

      if (activeTasks.length > 0) {

        const t = activeTasks[0];

        if (t.type === 'serve') {

          if (t.progress) {

            // 从后端显示服务阶段（如"loading 45%"、"warming up"、"idle"、"12.5 tok/s"）
            statusEl.textContent = t.progress;

          } else if (t.status === 'ready') {

            statusEl.textContent = 'ready';

          } else {

            statusEl.textContent = 'cooking';

          }

        } else {

          var _dlProgress = '';

          if (t.progress) {

            var _pctMatch = t.progress.match(/(\d+)%/);

            _dlProgress = _pctMatch ? ` ${_pctMatch[0]}` : '';

          }

          statusEl.textContent = `downloading${_dlProgress}`;

        }

        statusEl.style.display = '';

      } else if (errorTasks.length > 0) {

        statusEl.textContent = 'error';

        statusEl.style.display = '';

        statusEl.style.color = 'var(--color-error, #f44)';

      } else if (completedTasks.length > 0) {

        statusEl.textContent = 'done';

        statusEl.style.display = '';

        statusEl.style.color = 'var(--color-success, #4caf50)';

      } else {

        statusEl.style.display = 'none';

        statusEl.style.color = '';

      }

    }

    // 无活动任务时也清除侧边栏/轨道图标高亮。
    // 无此则 cookbook 图标保持全不透明度（"高亮"）
    // 无限期，因模态框打开清除仅在用户实际重开 Cookbook 时运行。
    
    if (!activeTasks.length && !errorTasks.length) {

      _clearCookbookNotif();

    }

  } catch (e) {

    // 静默失败
  }

}



// ── 初始化：接收共享状态/函数 ──


export function initRunning(shared) {

  _envState = shared._envState;

  _sshCmd = shared._sshCmd;

  _getPort = shared._getPort;

  _sshPrefix = shared._sshPrefix;

  _getPlatform = shared._getPlatform;

  _isWindows = shared._isWindows;

  _buildEnvPrefix = shared._buildEnvPrefix;

  _loadPresets = shared._loadPresets;

  _savePresets = shared._savePresets;

  _copyText = shared._copyText;

  _persistEnvState = shared._persistEnvState;

  _refreshDependencies = shared._refreshDependencies;

  _serverByVal = shared._serverByVal;

  _selectedServer = shared._selectedServer;

  modelLogo = shared.modelLogo;

  esc = shared.esc;

  _detectBackend = shared._detectBackend;

  _detectToolParser = shared._detectToolParser;

  _detectModelOptimizations = shared._detectModelOptimizations;

  _buildServeCmd = shared._buildServeCmd;



  // 应用启动：从服务器拉取权威状态，然后无条件
  // 自动启动后台监控。之前以"已有运行任务"
  // 为门控条件，但意味着 agent 在启动后添加任务时
  // UI 从未察觉。每 10 秒轮询一个小状态端点很廉价
  // 且给 agent + UI 一个共享的实时图景。
  
  (async () => {

    try {

      await _syncFromServer();

    } catch {}

    _startBackgroundMonitor();

  })();

}



// 也导出 _retryDownload 和 _nextAvailablePort 供其他模块使用
export { _retryDownload, _nextAvailablePort, _processQueue };
