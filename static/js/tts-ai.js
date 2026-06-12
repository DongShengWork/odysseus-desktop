// static/js/tts-ai.js
// AI 文字转语音模块 — 支持服务器 TTS 和浏览器 Web Speech API

class AITTSManager {
    constructor() {
        this.currentAudio = null;
        this.isPlaying = false;
        this.available = false;
        this.useBrowserTTS = false;
        this.browserVoice = '';
        this.playbackSpeed = 1;
        this._provider = 'disabled';
        this.autoPlay = false;
        this.cache = new Map(); // 客户端音频缓存

        // 顺序自动播放队列
        this._queue = [];       // { text, button, resetFn } 数组
        this._processing = false;

        // 逐句流式 TTS 状态
        this._streamSentencesSent = 0;  // 已排队的纯文本字符数
        this._streamActive = false;
        this._streamButton = null;
        this._streamResetFn = null;
        this._streamDebounceTimer = null;

        // 检查 TTS 服务是否可用
        this.checkAvailability();
    }

    async checkAvailability() {
        try {
            // 先检查用户设置 — 如果设置中禁用了 TTS，不显示按钮
            try {
                const settingsRes = await fetch('/api/auth/settings', { credentials: 'same-origin' });
                const settings = await settingsRes.json();
                if (settings.tts_enabled === false) {
                    this.available = false;
                    this._provider = 'disabled';
                    return;
                }
            } catch {}

            const response = await fetch('/api/tts/stats');
            const stats = await response.json();
            this.available = stats.available && stats.ready;
            this.playbackSpeed = stats.speed || 1;
            this._provider = stats.provider || 'disabled';

            if (stats.provider === 'browser') {
                this.useBrowserTTS = true;
                this.browserVoice = stats.voice || '';
                this.available = 'speechSynthesis' in window;
                if (!this.available) {
                    console.warn('TTS：已选择浏览器模式，但 speechSynthesis 不受支持');
                }
            } else if (this.available) {
                this.useBrowserTTS = false;
            } else {
                console.warn('TTS：不可用');
            }
        } catch (error) {
            console.error('检查 TTS 可用性失败：', error);
            this.available = false;
        }
    }

    extractPlainText(content) {
        // 去除 <think>/<thinking> 块（模型推理过程）
        let cleaned = content.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');

        // 创建一个临时 div 来解析 HTML/markdown
        const temp = document.createElement('div');
        temp.innerHTML = cleaned;

        // 移除代码块
        temp.querySelectorAll('pre, code').forEach(el => el.remove());

        // 获取文本内容
        let text = temp.textContent || temp.innerText || '';

        // 清理 markdown 语法
        text = text
            .replace(/#{1,6}\s/g, '') // 移除标题
            .replace(/\*\*(.+?)\*\*/g, '$1') // 移除粗体
            .replace(/\*(.+?)\*/g, '$1') // 移除斜体
            .replace(/\[(.+?)\]\(.+?\)/g, '$1') // 移除链接
            .replace(/`(.+?)`/g, '$1') // 移除内联代码
            .replace(/\n{3,}/g, '\n\n') // 规范化换行
            .trim();

        return text;
    }

    getCacheKey(text) {
        // 简单的哈希函数用于缓存键
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            const char = text.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    async synthesize(text, onProgress = null) {
        if (!this.available) {
            throw new Error('AI TTS 服务不可用');
        }

        const plainText = this.extractPlainText(text);

        if (!plainText) {
            throw new Error('没有可合成的文本');
        }

        // 浏览器 TTS 不使用 synthesize — 直接在 play() 中处理
        if (this.useBrowserTTS) {
            return '__browser_tts__';
        }

        const cacheKey = this.getCacheKey(plainText);

        // 先检查缓存
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        try {
            if (onProgress) onProgress('synthesizing');

            const response = await fetch('/api/tts/synthesize', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: plainText,
                    format: 'audio'
                })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail?.message || '合成失败');
            }

            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);

            // 缓存结果
            this.cache.set(cacheKey, audioUrl);

            if (onProgress) onProgress('complete');

            return audioUrl;

        } catch (error) {
            if (onProgress) onProgress('error');
            throw error;
        }
    }

    _findBrowserVoice() {
        if (!this.browserVoice) return null;
        const voices = window.speechSynthesis.getVoices();
        const target = this.browserVoice.toLowerCase();
        // 先精确匹配，再部分匹配
        return voices.find(v => v.name.toLowerCase() === target) ||
               voices.find(v => v.name.toLowerCase().includes(target)) ||
               null;
    }

    async play(text) {
        // 如果正在播放则停止当前音频
        this.stop();

        const plainText = this.extractPlainText(text);
        if (!plainText) return;

        if (this.useBrowserTTS) {
            return this._playBrowser(plainText);
        }

        try {
            const audioUrl = await this.synthesize(text);

            this.currentAudio = new Audio(audioUrl);
            await this.currentAudio.play();
            this.isPlaying = true;
            // 注意：onended 应由调用者（addAITTSButton）设置，在音频播放
            // 完成时重置按钮状态

        } catch (error) {
            console.error('播放音频失败：', error);
            throw error;
        }
    }

    _playBrowser(plainText) {
        return new Promise((resolve, reject) => {
            const utterance = new SpeechSynthesisUtterance(plainText);
            const voice = this._findBrowserVoice();
            if (voice) utterance.voice = voice;
            utterance.rate = this.playbackSpeed;

            utterance.onend = () => {
                this.isPlaying = false;
                resolve();
            };
            utterance.onerror = (e) => {
                this.isPlaying = false;
                reject(new Error('浏览器 TTS 错误：' + e.error));
            };

            window.speechSynthesis.speak(utterance);
            this.isPlaying = true;
        });
    }

    stop() {
        // 取消流式 TTS
        this._streamActive = false;
        if (this._streamDebounceTimer) {
            clearTimeout(this._streamDebounceTimer);
            this._streamDebounceTimer = null;
        }
        this._streamSentencesSent = 0;

        // 清空整个队列并重置所有排队按钮
        for (const item of this._queue) {
            if (item.resetFn) item.resetFn();
        }
        this._queue = [];
        this._processing = false;

        if (this.useBrowserTTS) {
            window.speechSynthesis.cancel();
            this.isPlaying = false;
        }
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.currentTime = 0;
            this.currentAudio = null;
            this.isPlaying = false;
        }
    }

    /**
     * 将消息加入自动播放队列。按顺序播放 — 每条消息
     * 播放完毕后再开始下一条。停止任何消息会清空队列。
     */
    enqueue(text, button, resetFn) {
        this._queue.push({ text, button, resetFn });
        if (!this._processing) {
            this._processQueue();
        }
    }

    async _processQueue() {
        if (this._processing) return;
        this._processing = true;

        while (this._queue.length > 0) {
            const item = this._queue[0];
            try {
                await this._playQueueItem(item);
            } catch (err) {
                console.error('TTS 队列项错误：', err);
            }
            if (this._queue.length > 0 && this._queue[0] === item) {
                this._queue.shift();
            }
            if (!this._processing) return;
        }

        this._processing = false;
    }

    async _playQueueItem(item) {
        const { text, button, resetFn } = item;
        const ICON_LOADING = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9" stroke-dasharray="42" stroke-dashoffset="12" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></circle></svg>';
        var ICON_STOP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';

        button.innerHTML = ICON_LOADING;
        button.classList.add('loading');
        button.style.color = '#ccc';
        button.title = '加载中…';

        try {
            if (!this._processing) return;

            const audioUrl = await this.synthesize(text);

            if (!this._processing) return;

            button.innerHTML = ICON_STOP;
            button.classList.remove('loading');
            button.classList.add('playing');
            button.title = '停止';

            if (this.useBrowserTTS) {
                const plainText = this.extractPlainText(text);
                await this._playBrowser(plainText);
            } else {
                if (this.currentAudio) {
                    this.currentAudio.pause();
                    this.currentAudio = null;
                }

                await new Promise((resolve, reject) => {
                    const audio = new Audio(audioUrl);
                    if (this._provider === 'local' && this.playbackSpeed !== 1) {
                        audio.playbackRate = this.playbackSpeed;
                    }
                    this.currentAudio = audio;
                    audio.onended = () => {
                        this.isPlaying = false;
                        if (this.currentAudio === audio) this.currentAudio = null;
                        resolve();
                    };
                    audio.onerror = (e) => {
                        this.isPlaying = false;
                        if (this.currentAudio === audio) this.currentAudio = null;
                        reject(new Error('音频播放错误'));
                    };
                    audio.onpause = () => {
                        if (this.currentAudio !== audio) {
                            resolve();
                        }
                    };
                    audio.play().then(() => {
                        this.isPlaying = true;
                    }).catch(reject);
                });
            }
        } finally {
            if (resetFn) resetFn();
        }
    }

    // ── 流式 TTS（逐句播放） ──

    streamingStart() {
        this._streamSentencesSent = 0;
        this._streamActive = true;
        this._streamButton = null;
        this._streamResetFn = null;
    }

    streamingUpdate(accumulatedText) {
        if (!this._streamActive || !this.available || !this.autoPlay) return;
        if (this._streamDebounceTimer) return;
        this._streamDebounceTimer = setTimeout(() => {
            this._streamDebounceTimer = null;
            this._processStreamingSentences(accumulatedText);
        }, 150);
    }

    _processStreamingSentences(accumulatedText) {
        if (!this._streamActive) return;

        var text = accumulatedText
            .replace(/```[\s\S]*?```/g, '')
            .replace(/```[\s\S]*$/g, '');

        var plainText = this.extractPlainText(text);
        if (!plainText || plainText.length <= this._streamSentencesSent) return;

        var newRegion = plainText.substring(this._streamSentencesSent);

        var sentences = [];
        var current = '';
        for (var i = 0; i < newRegion.length; i++) {
            current += newRegion[i];
            var ch = newRegion[i];
            var next = newRegion[i + 1];
            if ((ch === '.' || ch === '!' || ch === '?') && next && /\s/.test(next)) {
                var lastWord = current.trim().split(/\s/).pop() || '';
                if (/^\d+\.$/.test(lastWord)) continue;
                if (/^[A-Z][a-z]?\.$/.test(lastWord)) continue;
                sentences.push(current.trim());
                current = '';
            }
        }

        if (sentences.length === 0) return;

        var advancedChars = 0;
        for (var j = 0; j < sentences.length; j++) {
            var sentence = sentences[j];
            if (sentence.length < 15) {
                advancedChars += sentence.length + 1;
                continue;
            }
            var btn = this._streamButton || this._createPlaceholderButton();
            var resetFn = this._streamResetFn || function() {};
            this.enqueue(sentence, btn, resetFn);
            advancedChars += sentence.length + 1;
        }

        this._streamSentencesSent += advancedChars;
    }

    _createPlaceholderButton() {
        var btn = document.createElement('button');
        btn.style.display = 'none';
        btn.className = 'ai-tts-button streaming-placeholder';
        return btn;
    }

    streamingAttachButton(button, resetFn) {
        this._streamButton = button;
        this._streamResetFn = resetFn;
        for (var i = 0; i < this._queue.length; i++) {
            if (this._queue[i].button && this._queue[i].button.classList.contains('streaming-placeholder')) {
                this._queue[i].button = button;
                this._queue[i].resetFn = resetFn;
            }
        }
    }

    streamingEnd(finalText) {
        if (!this._streamActive) return;
        this._streamActive = false;
        if (this._streamDebounceTimer) {
            clearTimeout(this._streamDebounceTimer);
            this._streamDebounceTimer = null;
        }

        var text = finalText
            .replace(/```[\s\S]*?```/g, '')
            .replace(/```[\s\S]*$/g, '');

        var plainText = this.extractPlainText(text);
        if (!plainText) return;

        var remaining = plainText.substring(this._streamSentencesSent).trim();
        if (remaining.length >= 15) {
            var btn = this._streamButton || this._createPlaceholderButton();
            var resetFn = this._streamResetFn || function() {};
            this.enqueue(remaining, btn, resetFn);
        }
        this._streamSentencesSent = 0;
    }

    clearCache() {
        for (const url of this.cache.values()) {
            URL.revokeObjectURL(url);
        }
        this.cache.clear();
    }
}

// 创建全局 AI TTS 管理器实例
window.aiTTSManager = new AITTSManager();

// 向消息元素的操作栏添加 AI TTS 按钮的函数
export function addAITTSButton(messageElement, text) {
    if (!window.aiTTSManager.available || window.aiTTSManager._provider === 'disabled') {
        return;
    }

    if (messageElement.querySelector('.ai-tts-button')) {
        return;
    }

    // 在页脚中查找 msg-actions 容器
    const actions = messageElement.querySelector('.msg-actions');
    if (!actions) return;

    var ICON_PLAY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
    var ICON_STOP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
    var ICON_LOADING = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9" stroke-dasharray="42" stroke-dashoffset="12" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></circle></svg>';

    const playButton = document.createElement('button');
    playButton.className = 'ai-tts-button';
    playButton.type = 'button';
    playButton.title = '朗读';
    playButton.innerHTML = ICON_PLAY;
    playButton.style.cssText = 'background:none;border:none;color:#6b7280;cursor:pointer;padding:2px 6px;border-radius:4px;transition:color .15s;line-height:1;display:inline-flex;align-items:center;';

    playButton.addEventListener('mouseenter', () => { playButton.style.color = '#ccc'; });
    playButton.addEventListener('mouseleave', () => {
        if (!playButton.classList.contains('playing') && !playButton.classList.contains('loading')) playButton.style.color = '#6b7280';
    });

    function resetButton() {
        playButton.innerHTML = ICON_PLAY;
        playButton.classList.remove('playing', 'loading');
        playButton.style.color = '#6b7280';
        playButton.title = '朗读';
    }

    playButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        const mgr = window.aiTTSManager;

        if (mgr.isPlaying || mgr._processing) {
            mgr.stop();
            resetButton();
            return;
        }

        mgr.enqueue(text, playButton, resetButton);
    });

    actions.appendChild(playButton);
}

// 导航离开时停止音频
window.addEventListener('beforeunload', () => {
    if (window.aiTTSManager) {
        window.aiTTSManager.stop();
    }
});

export { AITTSManager };

const ttsModule = { AITTSManager, addAITTSButton };
export default ttsModule;
