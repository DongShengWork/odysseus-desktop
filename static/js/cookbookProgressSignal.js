// cookbookProgressSignal.js — 下载/安装进度活性信号
/**
 * 运行中 cookbook 下载/安装的活跃信号。看门狗在此信号长时间不变时将任务标记为停滞，
 * 因此信号必须在任务真正进行时发生变化。
 *
 * 在模型下载过程中，真实的信号是已下载字节计数器（从 "1.81G/2.49G" 中提取
 * "1.81G"）：它在传输时递增，在卡住时冻结——与进度条百分比或速度/ETA 不同，
 * 它不会在冻结的画面中继续动画。该路径保持原样不变。
 *
 * 但是依赖安装（例如 vllm）会有很长的阶段没有任何字节计数器——pip 依赖解析和
 * 原生 CUDA 构建/编译。纯字节信号在此处冻结，导致看门狗错误地判断安装已停滞
 * 并在构建中途重启它，陷入无限循环（#1568）。当没有字节计数器时，回退到输出
 * 尾部的指纹：解析器/编译行在进程存活期间不断变化，只有真正挂起的进程才会让
 * 尾部停留不变。
 *
 * 纯函数（字符串输入，字符串输出），因此可以进行单元测试；cookbookRunning.js
 * 引用了仅限于浏览器环境使用的模块，无法在 node 下加载。
 */
export function computeProgressSignal(bytes, dlAgg, lastPct, snapshot) {
  if (bytes) return bytes;
  const base = dlAgg != null ? String(dlAgg) : (lastPct || '0');
  // 无字节计数器 → 使用输出尾部，使构建/解析阶段发出的新行计入进度，而非误判停滞（#1568）。
  return base + '|' + String(snapshot || '').slice(-300);
}
