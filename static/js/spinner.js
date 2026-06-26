// static/js/加载指示器.js

/**
 * ASCII 加载动画模块，用于 AI 思考/处理状态
 */

class Spinner {
  constructor(message = "AI 正在处理", style = "right", animation = "spinner") {
    // 不同的动画帧
    this.animations = {
      spinner: ['|', '/', '-', '\\'],
      wave: ['▁▂▃', '▂▃▄', '▃▄▅', '▄▅▆', '▅▆▅', '▆▅▄', '▅▄▃', '▄▃▂', '▃▂▁']
    };

    this.animation = animation;
    this.frames = this.animations[animation] || this.animations.spinner;
    this.message = message;
    this.style = style; // "left"、"right" 或 "clean"
    this.isRunning = false;
    this.currentFrame = 0;
    this.intervalId = null;
    this.rafId = null;
    this.element = null;
  }

  /**
   * 创建并返回加载动画 HTML 元素
   */
  createElement() {
    if (this.animation === 'sinewave') {
      return this._createSineWaveElement();
    }
    if (this.animation === 'whirlpool') {
      return this._createWhirlpoolElement();
    }
    const span = document.createElement('span');
    span.className = 'ai-spinner';
    span.style.cssText = 'font-family: monospace; white-space: pre;';
    this.element = span;
    this.updateDisplay();
    return span;
  }

  _createSineWaveElement() {
    const wrapper = document.createElement('span');
    wrapper.className = 'ai-spinner ai-spinner-sinewave';
    wrapper.style.cssText = 'font-family: monospace; white-space: pre; display: inline-flex; align-items: center; gap: 6px;';

    const canvas = document.createElement('canvas');
    canvas.width = 50;
    canvas.height = 18;
    canvas.style.cssText = 'display: inline-block; vertical-align: middle;';

    const msgSpan = document.createElement('span');
    msgSpan.textContent = this.message;
    this._msgSpan = msgSpan;

    if (this.style === 'left') {
      wrapper.appendChild(canvas);
      wrapper.appendChild(msgSpan);
    } else if (this.style === 'right') {
      wrapper.appendChild(msgSpan);
      wrapper.appendChild(canvas);
    } else {
      wrapper.appendChild(msgSpan);
    }

    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._waveT = 0;
    this._wavePrev = performance.now();
    this.element = wrapper;
    return wrapper;
  }

  _drawSineWave() {
    const ctx = this._ctx;
    const W = this._canvas.width;
    const H = this._canvas.height;
    const midY = H / 2;
    const AMP = 7;
    const CYCLES = 2.5;
    const PAD = 3;
    const trackW = W - 2 * PAD;
    const BASE_SPEED = 0.44;
    const MIN_SPEED = 0.4;
    const MAX_SPEED = 2.5;

    const now = performance.now();
    const dt = (now - this._wavePrev) / 1000;
    this._wavePrev = now;

    const dotPhase = 0.5 * CYCLES * 2 * Math.PI + this._waveT;
    const norm = (1 + Math.sin(dotPhase)) / 2;
    const speedMul = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * Math.pow(norm, 1.3);
    this._waveT += dt * BASE_SPEED * speedMul * CYCLES * 2 * Math.PI;

    ctx.clearRect(0, 0, W, H);

    // 波形线
    ctx.beginPath();
    for (let i = 0; i <= 80; i++) {
      const frac = i / 80;
      const x = PAD + frac * trackW;
      const phase = frac * CYCLES * 2 * Math.PI + this._waveT;
      const y = midY + Math.sin(phase) * AMP;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(156, 222, 242, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 圆点
    const cx = W / 2;
    const cPhase = 0.5 * CYCLES * 2 * Math.PI + this._waveT;
    const cy = midY + Math.sin(cPhase) * AMP;
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(156, 222, 242, 0.9)';
    ctx.fill();

    if (this.isRunning) {
      this.rafId = requestAnimationFrame(() => this._drawSineWave());
    }
  }

  _createWhirlpoolElement() {
    const wrapper = document.createElement('span');
    wrapper.className = 'ai-spinner ai-spinner-whirlpool';
    wrapper.style.cssText = 'font-family: monospace; white-space: pre; display: inline-flex; align-items: center; gap: 6px;';

    const size = this._wpSize || 18;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.cssText = 'display: inline-block; vertical-align: middle;';

    const msgSpan = document.createElement('span');
    msgSpan.textContent = this.message;
    this._msgSpan = msgSpan;

    if (this.style === 'left') {
      wrapper.appendChild(canvas);
      wrapper.appendChild(msgSpan);
    } else if (this.style === 'right') {
      wrapper.appendChild(msgSpan);
      wrapper.appendChild(canvas);
    } else {
      wrapper.appendChild(canvas);
    }

    this._wpCanvas = canvas;
    this._wpCtx = canvas.getContext('2d');
    this._wpFrame = 60;
    this.element = wrapper;
    return wrapper;
  }

  _drawWhirlpool() {
    const ctx = this._wpCtx;
    const W = this._wpCanvas.width;
    const H = this._wpCanvas.height;
    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) / 2 - 1;
    const lw = W > 30 ? 3 : W > 20 ? 2 : 1.5;
    const TOTAL_TURNS = 4;
    const TAIL_LEN = 0.45;
    const SPIN_SPEED = 0.08;
    const LAYERS = 12;
    const STEPS = 50;
    const t = this._wpFrame;

    // 从 CSS 变量读取颜色 — 只读一次并缓存。每帧调用 getComputedStyle
    // 会强制每帧重新计算样式，在绘制大量图片时会导致
    // canvas 动画严重卡顿/冻结。（主题变更很少发生；
    // 加载指示器生命周期很短，所以缓存过时也没关系。）
    if (!this._wpColors) {
      const s = getComputedStyle(document.documentElement);
      this._wpColors = {
        fg: s.getPropertyValue('--red').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2',
        track: s.getPropertyValue('--border').trim() || '#355a66',
      };
    }
    const fg = this._wpColors.fg;
    const track = this._wpColors.track;

    function spiralPoint(frac, rot) {
      const r = maxR * (1 - frac);
      const angle = frac * TOTAL_TURNS * Math.PI * 2 + rot;
      return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
    }

    ctx.clearRect(0, 0, W, H);

    // 轨道环
    ctx.beginPath();
    ctx.arc(cx, cy, maxR - lw / 2, 0, Math.PI * 2);
    ctx.strokeStyle = track;
    ctx.lineWidth = lw;
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;

    const headPos = (t * 0.008) % 1;

    // 重叠子路径实现平滑渐隐
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let layer = LAYERS - 1; layer >= 0; layer--) {
      const endFrac = (layer + 1) / LAYERS;
      const stepsForLayer = Math.ceil(STEPS * endFrac);
      const alpha = Math.pow(1 - endFrac, 2) * 0.7;

      ctx.beginPath();
      let started = false;
      let prevPos = -1;
      for (let i = 0; i <= stepsForLayer; i++) {
        const frac = i / STEPS;
        let pos = headPos - frac * TAIL_LEN;
        if (pos < 0) pos += 1;
        if (started && prevPos < 0.3 && pos > 0.7) {
          ctx.stroke();
          ctx.beginPath();
          started = false;
        }
        const pt = spiralPoint(pos, t * SPIN_SPEED);
        if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
        else ctx.lineTo(pt.x, pt.y);
        prevPos = pos;
      }
      ctx.strokeStyle = fg;
      ctx.lineWidth = lw * 0.8;
      ctx.globalAlpha = alpha;
      ctx.stroke();
    }

    // 头部的亮点
    const head = spiralPoint(headPos, t * SPIN_SPEED);
    ctx.beginPath();
    ctx.arc(head.x, head.y, Math.max(1, lw * 0.45), 0, Math.PI * 2);
    ctx.fillStyle = fg;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;

    this._wpFrame++;
    if (!this.isRunning) return;
    // 防泄漏的自我终止：当我们的元素曾经在 DOM 中且后来
    // 被移除时停止（例如加载行被结果替换）。但在第一次追加之前
    // 继续保持旋转 — start() 是同步运行的，在调用者插入元素之前，
    // 所以第 1 帧时它还没有连接到 DOM。
    const connected = !!(this.element && this.element.isConnected);
    if (connected) this._wpWasConnected = true;
    if (connected || !this._wpWasConnected) {
      this.rafId = requestAnimationFrame(() => this._drawWhirlpool());
    } else {
      this.isRunning = false;
    }
  }

  /**
   * 更新加载动画显示
   */
  updateDisplay() {
    if (!this.element) return;

    const frame = this.frames[this.currentFrame % this.frames.length];

    let display = '';
    if (this.style === "left") {
      display = `${frame} ${this.message}`;
    } else if (this.style === "right") {
      display = `${this.message} ${frame}`;
    } else { // clean
      display = this.message;
    }

    this.element.innerHTML = display;
  }

  /**
   * 启动加载动画
   */
  start(speed = 150) {
    if (this.isRunning) return;
    this.isRunning = true;

    if (this.animation === 'sinewave') {
      this._wavePrev = performance.now();
      this._drawSineWave();
      return;
    }

    if (this.animation === 'whirlpool') {
      this._wpFrame = 60;
      this._drawWhirlpool();
      return;
    }

    this.currentFrame = 0;
    this.intervalId = setInterval(() => {
      this.currentFrame++;
      this.updateDisplay();
    }, speed);
  }

  /**
   * 停止加载动画
   */
  stop() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * 在加载动画运行期间更新消息文本
   */
  updateMessage(newMessage) {
    this.message = newMessage;
    if ((this.animation === 'sinewave' || this.animation === 'whirlpool') && this._msgSpan) {
      this._msgSpan.textContent = newMessage;
    } else {
      this.updateDisplay();
    }
  }

  /**
   * 更新加载动画标签文本
   */
  updateLabel(newMessage) {
    this.message = newMessage;
    if (this._msgSpan) {
      this._msgSpan.textContent = newMessage;
    } else {
      this.updateDisplay();
    }
  }

  /**
   * 销毁加载动画并清理
   */
  destroy() {
    this.stop();
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    this.element = null;
  }
}

/**
 * 创建新的加载动画实例
 */
export function create(message, style = "right", animation = "wave") {
  return new Spinner(message, style, animation);
}

/**
 * 创建独立的漩涡圆形加载动画（替换 CSS .spinner）
 * 返回 { element, start(), stop(), destroy() }
 */
export function createWhirlpool(size = 24) {
  const sp = new Spinner('', 'clean', 'whirlpool');
  sp._wpSize = size;
  const el = sp.createElement();
  // 包裹在匹配 .加载指示器 布局的 div 中
  const wrap = document.createElement('div');
  wrap.className = 'spinner-whirlpool';
  wrap.style.cssText = `width:${size}px;height:${size}px;margin:8px auto;`;
  wrap.appendChild(el);
  sp.start();
  return { element: wrap, stop: () => sp.stop(), destroy: () => sp.destroy() };
}

/**
 * 列表/库空状态的一致内联加载行：标签加
 * 漩涡加载动画。返回一个分离的元素；加载动画在元素离开 DOM 后
 * 自动停止（参见 _drawWhirlpool），所以调用者可以直接
 * 用结果替换它 — 无需手动清理。
 */
export function createLoadingRow(text = '加载中…', size = 16) {
  const sp = new Spinner('', 'clean', 'whirlpool');
  sp._wpSize = size;
  const canvas = sp.createElement();
  const row = document.createElement('div');
  row.className = 'lib-loading-row';
  const label = document.createElement('span');
  label.textContent = text;
  row.appendChild(label);
  row.appendChild(canvas);
  sp.start();
  return row;
}

export { Spinner };

const spinnerModule = { create, createWhirlpool, createLoadingRow, Spinner };
export default spinnerModule;
