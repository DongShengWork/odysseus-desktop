"""根据检测到的硬件计算智能的 llama.cpp 推理配置。

给定一个系统（VRAM/RAM/架构）和一个模型，生成 1-4 个可直接启动的
配置 — 质量 / 平衡 / 速度 — 包含具体的 llama.cpp 参数
（n_gpu_layers, n_cpu_moe, cache-type, context）。这将手动调优
（多少 MoE 层适合放在 GPU 上、何时用 VRAM 换取 q8 KV 缓存 vs 更多
上下文、为视觉编码器预留多少余量）转化为公式。

纯确定性的 — 无基准测试、无 I/O。重用与 fit.py/models.py 相同的 VRAM 数学，
使得 "Cookbook 推荐" 与 "实际推理" 保持一致。

注意：token/s 数据不在此处计算 — 部分卸载 MoE 的实际速度
由 CPU 决定，无法通过规格可靠预测。UI 通过权衡标签
（质量/平衡/速度）标识配置，而 VRAM 适配（决定是否
能加载的部分）基于真实数字计算。
"""

from services.hwfit.models import (
    QUANT_BPP,
    params_b,
    _active_params_b,
    is_prequantized,
)

# GGUF KV-cache 每 token 开销，以每活跃十亿参数的字节数为单位，按缓存类型划分。
# q4_0 ≈ q8_0 的一半 ≈ f16 的一半。estimate_memory_gb 中的 8e-6 基础值
# 是近似 q8_0 的数值；其他地方据此缩放。
_KV_FACTOR = {"q4_0": 0.5, "q8_0": 1.0, "f16": 2.0}

# 量化阶梯，从最高质量/体积向下排列。需要"最适合全量放入 GPU 的量化"
# 的配置会遍历此列表直到找到合适的。
_QUANT_LADDER = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M", "Q2_K"]


def _weights_gb(model, quant, fixed_gb=None):
    """完整权重的 VRAM 占用。当给出 fixed_gb（磁盘上已有特定的 GGUF
    文件），使用其真实大小 — 量化级别由文件决定，
    我们无法另行选择。"""
    if fixed_gb and fixed_gb > 0:
        return float(fixed_gb)
    return params_b(model) * QUANT_BPP.get(quant, 0.58)


def _kv_gb(model, ctx, kv_type):
    """指定上下文长度和缓存类型下的 KV-cache VRAM 占用。"""
    kv_params = _active_params_b(model)
    return 0.000008 * kv_params * ctx * _KV_FACTOR.get(kv_type, 1.0)


def _n_layers(model):
    """尽力获取 transformer 块总数（用于 n-cpu-moe 计算）。"""
    for k in ("num_hidden_layers", "n_layers", "num_layers", "block_count"):
        v = model.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return int(v)
    # 按规模回退 — 大多数 MoE/dense LLM 在 28-64 层之间。
    pb = params_b(model)
    if pb >= 60:
        return 64
    if pb >= 25:
        return 48
    if pb >= 12:
        return 40
    return 32


def _cpu_moe_for_budget(model, quant, kv_gb, vram_budget_gb, fixed_gb=None):
    """需要将多少 MoE 层移至 CPU 才能使 weights+KV 适配 vram_budget_gb。

    返回 (n_cpu_moe, fits_fully)。当模型已适配时，n_cpu_moe=0。
    每卸载一层大约释放 weights/n_layers 的 VRAM。我们仅对 MoE
    建模此行为（--n-cpu-moe 适用）；Dense 模型仅报告在
    n_gpu_layers=999 时是否适配。
    """
    weights = _weights_gb(model, quant, fixed_gb)
    needed = weights + kv_gb + 0.6  # +0.6 GB 运行时/计算缓冲
    if needed <= vram_budget_gb:
        return 0, True
    if not model.get("is_moe"):
        # Dense：没有 per-expert 卸载开关；要么适配要么通过 -ngl 溢出到内存。
        return 0, False
    layers = _n_layers(model)
    per_layer = weights / max(layers, 1)
    overflow = needed - vram_budget_gb
    import math
    n = math.ceil(overflow / max(per_layer, 1e-6))
    n = max(0, min(n, layers))   # 裁剪到合法范围
    return n, False


def compute_serve_profiles(system, model, serve_weights_gb=None, serve_quant=None):
    """返回在 `system` 上用 llama.cpp 推理 `model` 的配置字典列表。

    每个配置: {key, label, quant, n_gpu_layers, n_cpu_moe, cache_type, ctx,
               est_vram_gb, fits, note}。如果没有合理的 GGUF 路径，
    返回空列表（调用方应回退到手动参数）。

    下载模式（默认）：量化级别尚未选定，因此配置会变化
    （质量=Q6, 平衡=Q4, 速度=Q2...）以展示下载选项。

    推理模式（设置了 serve_weights_gb）：磁盘上已有特定 GGUF 文件 —
    其量化级别是固定的。配置保持该量化/大小，仅变化
    实际的推理参数（n_cpu_moe、KV-cache 类型、上下文）。serve_quant
    是文件的量化标签（例如 "Q4_K_M"），仅用于显示。
    """
    vram = float(system.get("gpu_vram_gb") or 0)
    if vram <= 0:
        return []

    serve_mode = bool(serve_weights_gb and serve_weights_gb > 0)

    # 永远不要提议超过模型训练上下文上限的上下文 — 要求 llama.cpp
    # 设置 ctx > n_ctx_train 会触发 "training context overflow"，并且对于
    # 量化 KV 缓存，会产生过大的分配，可能导致 GPU 崩溃
    # （radv/amdgpu ErrorDeviceLost）。将每个配置的上限限制在模型的实际上限。
    model_ctx_max = 0
    for k in ("context_length", "max_position_embeddings", "n_ctx_train", "context"):
        v = model.get(k)
        if isinstance(v, (int, float)) and v > 0:
            model_ctx_max = int(v)
            break
    if model_ctx_max <= 0:
        model_ctx_max = 131072  # 当目录中缺少该字段时的保守默认值

    # 视觉模型需要为图像编码器预留额外空间（约 1 GB，在权重之外）。
    is_vision = bool(
        model.get("is_multimodal") or model.get("vision") or model.get("mmproj")
        or "vl" in str(model.get("name", "")).lower()
    )
    headroom = 1.1 if is_vision else 0.4
    budget = max(vram - headroom, 1.0)

    # 预量化模型（AWQ/GPTQ/FP8）通过 GGUF 降级推理时使用固定 ~Q4 量化；
    # GGUF 模型可以选择它们的量化。为每个配置选择合理的量化。
    fixed_quant = model.get("quantization") if is_prequantized(model) else None

    is_moe = bool(model.get("is_moe"))

    def _pick_quant(prefer, require_full_fit):
        """为配置选择量化级别。

        - fixed_quant（通过 GGUF 推理的 AWQ/GPTQ/FP8）：始终使用该值。
        - require_full_fit=True（速度模式）：从 `prefer` 向下寻找权重能
          完全放入 GPU（无卸载）的最高量化 — 最快。
        - require_full_fit=False（MoE 上的质量模式）：保留 `prefer` 即使
          需要将专家卸载到 CPU 也是如此；这对于显存不足以容纳权重的显卡
          正是 n-cpu-moe 的意义所在。对于 Dense 模型我们无法按专家
          卸载，因此回退到能完全放入的最大量化。
        """
        if fixed_quant:
            return fixed_quant
        start = _QUANT_LADDER.index(prefer) if prefer in _QUANT_LADDER else 3
        if require_full_fit or not is_moe:
            for q in _QUANT_LADDER[start:]:
                if _weights_gb(model, q) + 0.6 <= budget:
                    return q
            return _QUANT_LADDER[-1]
        # MoE 质量：保留首选（大）量化；卸载处理溢出。
        return prefer

    if serve_mode:
        # 磁盘上的固定文件 — 量化不可更改。仅变化推理参数。
        fq = serve_quant or model.get("quantization") or "GGUF"
        specs = [
            # key, label, prefer_quant, full_fit, kv_type, ctx, note
            ("quality", "Quality", fq, False, "q8_0", 131072,
             "Sharp q8 KV cache + full context. Best long-context accuracy; offloads MoE layers to CPU if needed."),
            ("balanced", "Balanced", fq, False, "q4_0", 131072,
             "Compact q4 KV at full context — good speed/quality mix."),
            ("speed", "Speed", fq, False, "q4_0", 32768,
             "Trimmed context + light KV for the fastest tokens/s."),
        ]
    else:
        specs = [
            # key, label, prefer_quant, full_fit, kv_type, ctx, note
            ("quality", "Quality", "Q6_K", False, "q8_0", 131072,
             "Biggest quant + sharp q8 KV cache. Best answers; offloads MoE layers to CPU if needed."),
            ("balanced", "Balanced", "Q4_K_M", False, "q4_0", 131072,
             "Q4 weights + compact q4 KV. Good speed/quality mix at full context."),
            ("speed", "Speed", "Q4_K_M", True, "q4_0", 32768,
             "Smallest offload + trimmed context for the fastest tokens/s."),
        ]

    profiles = []
    for key, label, prefer_q, full_fit, kv_type, ctx, note in specs:
        # 推理模式下量化是固定的（文件决定的）；下载模式下我们选择。
        quant = prefer_q if serve_mode else _pick_quant(prefer_q, full_fit)
        # 缩小上下文，如果即便选定的 KV 也无法与权重一起放入 GPU。
        # 从配置目标和模型限制中较小的一个开始。
        cur_ctx = min(ctx, model_ctx_max)
        while cur_ctx >= 8192:
            kv = _kv_gb(model, cur_ctx, kv_type)
            n_cpu_moe, fits = _cpu_moe_for_budget(model, quant, kv, budget, fixed_gb=serve_weights_gb)
            est = _weights_gb(model, quant, serve_weights_gb) + kv + 0.6
            # 如果非 MoE 模型即使完全卸载也无法适配，尝试更少的上下文长度。
            if model.get("is_moe") or fits or cur_ctx <= 8192:
                profiles.append({
                    "key": key,
                    "label": label,
                    "quant": quant,
                    "n_gpu_layers": 999,
                    "n_cpu_moe": n_cpu_moe,
                    "cache_type": kv_type,
                    "ctx": cur_ctx,
                    # 当专家被卸载时，GPU 常驻 VRAM 上限是预算
                    # （超出部分存储在系统 RAM 中），因此将
                    # 估算值限制在 `budget` 而非整张卡 — 这同时让
                    # 视觉编码器的余量在数字上可见。
                    "est_vram_gb": round(min(est, budget), 1),
                    # 对于 MoE，我们将其视为通过卸载适配；报告
                    # 它是否在未卸载时适配作为 "干净" 标志。
                    "fits": fits or bool(model.get("is_moe")),
                    "offloads": n_cpu_moe > 0,
                    "note": note,
                })
                break
            cur_ctx //= 2

    # 去除重复的相同配置（例如小型模型三条配置都坍缩为
    # 相同的全 GPU 配置）— 保留第一条/最高质量标签。
    seen = set()
    deduped = []
    for p in profiles:
        sig = (p["quant"], p["n_cpu_moe"], p["cache_type"], p["ctx"])
        if sig in seen:
            continue
        seen.add(sig)
        deduped.append(p)
    return deduped
