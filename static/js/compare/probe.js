// compare/probe.js — 模型探测/检查系统
import state from './state.js';
import { WAVE_FRAMES } from './icons.js';
import uiModule from '../ui.js';
import spinnerModule from '../spinner.js';

function _clearProbeWaves() {
  const rows = document.querySelectorAll('.compare-probe-row');
  rows.forEach(r => { if (r._waveInterval) { clearInterval(r._waveInterval); r._waveInterval = null; } });
}

async function _checkUnprobed() {
  const unprobed = state._selectedModels.filter(m => !state._probed.has(m.model));
  if (unprobed.length === 0) {
    if (uiModule) uiModule.showToast(t('compare.all_verified'));
    return;
  }

  // 在检查运行期间，探测按钮上显示旋转加载动画。
  const _btn = document.getElementById('compare-check-btn');
  let _btnHTML = null, _wp = null;
  if (_btn) {
    _btnHTML = _btn.innerHTML;
    _btn.disabled = true;
    _btn.style.opacity = '0.7';
    try {
      _wp = spinnerModule.createWhirlpool(14);
      _btn.innerHTML = '';
      _btn.appendChild(_wp.element);
    } catch (_) { /* spinner 尽力而为 */ }
  }

  // 快速内联探测 — 用 toast 显示结果
  const isBlind = state._blindMode;
  let ok = 0, fail = 0;
  try {
  for (const m of unprobed) {
    try {
      const _imageModelPrefixes = ['dall-e', 'gpt-image', 'chatgpt-image', 'stable-diffusion', 'sdxl', 'flux', 'midjourney'];
      if (_imageModelPrefixes.some(p => m.model.toLowerCase().includes(p))) {
        state._probed.add(m.model);
        ok++;
        continue;
      }
      const res = await fetch(`${state.API_BASE}/api/probe-selected`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: [{ endpoint_id: m.endpointId || '', model: m.model, endpoint: m.endpoint || '' }] }),
      });
      const data = await res.json();
      const result = (data.results || [])[0];
      if (result && result.status === 'ok') {
        state._probed.add(m.model);
        ok++;
      } else {
        fail++;
        const name = isBlind ? 'a model' : (m.name || m.model.split('/').pop());
        if (uiModule) uiModule.showToast(t('compare.verify_failed', { name, error: result?.error || t('compare.unknown_error') }), 5000);
      }
    } catch (e) {
      fail++;
    }
  }
  if (fail === 0) {
    if (uiModule) uiModule.showToast(t('compare.models_verified', { count: ok }));
  }
  } finally {
    // 恢复探测按钮（其标签/可见性将在下方刷新）。
    if (_btn) {
      _btn.disabled = false;
      _btn.style.opacity = '';
      if (_btnHTML !== null) _btn.innerHTML = _btnHTML;
    }
    if (window._updateCheckBtnState) window._updateCheckBtnState();
  }
}

export { _clearProbeWaves, _checkUnprobed };
