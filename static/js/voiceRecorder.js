// static/js/voiceRecorder.js

/**
 * 语音录制，支持可选的语音转文字（Speech-to-Text）转录。
 *
 * 语音转文字提供商：
 *   "disabled"       — 将音频录制为文件附件（原始行为）
 *   "browser"        — 使用 Web Speech API 进行实时转录
 *   "local"          — 将录音发送到服务器 /api/stt/transcribe（Whisper）
 *   "endpoint:<id>"  — 将录音发送到服务器 /api/stt/transcribe（API）
 */

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingInterval = null;

// 浏览器语音识别状态
let _recognition = null;
let _browserTranscript = '';

// 缓存的语音识别提供商 — 设置变更时刷新
let _sttProvider = 'disabled';

/**
 * 从服务器设置中获取当前的语音识别提供商
 */
async function refreshSttProvider() {
  try {
    const res = await fetch('/api/stt/stats', { credentials: 'same-origin' });
    if (res.ok) {
      const stats = await res.json();
      _sttProvider = stats.provider || 'disabled';
      // 通知发送按钮更新图标
      if (window._updateSendBtnIcon) window._updateSendBtnIcon();
    }
  } catch (e) {
    console.warn('Failed to fetch STT stats:', e);
  }
}

/**
 * 将秒数格式化为 MM:SS 格式
 */
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

/**
 * 录音结束后重置 UI 状态
 */
function _resetRecordingUI() {
  isRecording = false;
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  // 通过全局回调重置发送按钮
  const sendBtn = document.querySelector('.send-btn');
  if (sendBtn) {
    sendBtn.classList.remove('recording');
    sendBtn.dataset.mode = '';
  }
  if (window._updateSendBtnIcon) {
    setTimeout(window._updateSendBtnIcon, 50);
  }
}

/**
 * 在录制的同时启动浏览器语音识别
 */
function startBrowserSTT() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  _browserTranscript = '';
  _recognition = new SpeechRecognition();
  _recognition.continuous = true;
  _recognition.interimResults = false;
  _recognition.lang = '';

  _recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        _browserTranscript += event.results[i][0].transcript + ' ';
      }
    }
  };

  _recognition.onerror = (e) => {
    console.warn('Browser STT error:', e.error);
  };

  _recognition.start();
}

function stopBrowserSTT() {
  if (_recognition) {
    try { _recognition.stop(); } catch (e) { /* 忽略 */ }
    _recognition = null;
  }
  return _browserTranscript.trim();
}

/**
 * 将音频发送到服务器进行转录
 */
async function transcribeOnServer(audioBlob) {
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.webm');

  const res = await fetch('/api/stt/transcribe', {
    method: 'POST',
    credentials: 'same-origin',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || 'Transcription failed');
  }

  const data = await res.json();
  return data.text || '';
}

/**
 * 将转录后的文本插入到聊天输入框中
 */
function insertTranscription(text, showToast) {
  if (!text) return;
  const input = document.getElementById('message');
  if (!input) return;

  const existing = input.value.trim();
  input.value = existing ? existing + ' ' + text : text;

  // 触发自动调整大小和图标更新
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();

  if (showToast) showToast('Transcribed');
}

/**
 * 开始语音录制
 */
export function startRecording(onFileCreated, showToast, showError) {
  // 检查安全上下文（getUserMedia 需要 HTTPS 或 localhost）
  if (!window.isSecureContext) {
    if (showError) showError('Microphone requires HTTPS. Use a reverse proxy with SSL or access via localhost.');
    _resetRecordingUI();
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (showError) showError('Microphone not supported in this browser.');
    _resetRecordingUI();
    return;
  }

  audioChunks = [];

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());

        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const provider = _sttProvider;

        if (provider === 'browser') {
          const transcript = stopBrowserSTT();
          if (transcript) {
            insertTranscription(transcript, showToast);
          } else {
            if (showToast) showToast('No speech detected');
            const audioFile = new File([audioBlob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
            if (onFileCreated) onFileCreated(audioFile);
          }
        } else if (provider === 'local' || provider.startsWith('endpoint:')) {
          // 显示"正在转录..."反馈
          if (showToast) showToast('Transcribing...', 5000);
          try {
            const transcript = await transcribeOnServer(audioBlob);
            if (transcript) {
              insertTranscription(transcript, showToast);
            } else {
              if (showToast) showToast('No speech detected');
            }
          } catch (e) {
            console.error('STT transcription error:', e);
            if (showError) showError('Transcription failed: ' + e.message);
            // 降级方案：作为文件附件
            const audioFile = new File([audioBlob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
            if (onFileCreated) onFileCreated(audioFile);
          }
        } else {
          // 语音识别已禁用 — 附加音频文件
          const audioFile = new File([audioBlob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
          if (onFileCreated) onFileCreated(audioFile);
        }

        _resetRecordingUI();
      };

      mediaRecorder.start();
      isRecording = true;
      recordingStartTime = new Date();

      // 如果提供商是浏览器，则启动浏览器语音识别
      if (_sttProvider === 'browser') {
        startBrowserSTT();
      }

      if (showToast) {
        showToast('Recording...');
      }
    })
    .catch(error => {
      console.error('Microphone access error:', error);
      if (showError) {
        if (error.name === 'NotAllowedError') {
          showError('Microphone access denied. Check browser permissions.');
        } else if (error.name === 'NotFoundError') {
          showError('No microphone found.');
        } else {
          showError('Microphone error: ' + error.message);
        }
      }
      _resetRecordingUI();
    });
}

/**
 * 停止语音录制
 */
export function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    // isRecording 将在 _resetRecordingUI 中设置为 false（由 onstop 调用）
  } else {
    _resetRecordingUI();
  }
}

/**
 * 检查当前是否正在录制
 */
export function getIsRecording() {
  return isRecording;
}

/**
 * 初始化录音状态
 */
export function init() {
  isRecording = false;
  refreshSttProvider();
}

const voiceRecorderModule = {
  startRecording,
  stopRecording,
  getIsRecording,
  init,
  refreshSttProvider,
  get _sttProvider() { return _sttProvider; },
  set _sttProvider(v) { _sttProvider = v; },
};

export default voiceRecorderModule;
