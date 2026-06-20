import re

from services.hwfit.models import (
    params_b, estimate_memory_gb, infer_use_case,
    get_models, is_prequantized, _active_params_b, QUANT_BYTES_PER_PARAM,
    QUANT_SPEED_MULT, QUANT_QUALITY_PENALTY,
)

GPU_BANDWIDTH = {
    "5090": 1792, "5080": 960, "5070 ti": 896, "5070": 672, "5060 ti": 448, "5060": 256,
    "4090": 1008, "4080 super": 736, "4080": 717, "4070 ti super": 672, "4070 ti": 504, "4070 super": 504, "4070": 504, "4060 ti": 288, "4060": 272,
    "3090 ti": 1008, "3090": 936, "3080 ti": 912, "3080": 760, "3070 ti": 608, "3070": 448, "3060 ti": 448, "3060": 360,
    "2080 ti": 616, "2080 super": 496, "2080": 448, "2070 super": 448, "2070": 448, "2060 super": 448, "2060": 336,
    "1660 ti": 288, "1660 super": 336, "1660": 192, "1650 super": 192, "1650": 128,
    "h100 sxm": 3350, "h100": 2039, "h200": 4800, "a100 sxm": 2039, "a100": 1555,
    "l40s": 864, "l40": 864, "l4": 300, "a10g": 600, "a10": 600, "t4": 320,
    "v100 sxm": 900, "v100": 897, "a6000": 768, "a5000": 768, "a4000": 448,
    "7900 xtx": 960, "7900 xt": 800, "7900 gre": 576, "7800 xt": 624, "7700 xt": 432, "7600": 288,
    "6950 xt": 576, "6900 xt": 512, "6800 xt": 512, "6800": 512, "6700 xt": 384, "6600 xt": 256, "6600": 224,
    "mi300x": 5300, "mi300": 5300, "mi250x": 3277, "mi250": 3277, "mi210": 1638, "mi100": 1229,
    "9070 xt": 624, "9070": 488, "9060 xt": 322, "9060": 322,
}

# 按长度降序预排序键，确保正确的子串匹配
_BW_KEYS_SORTED = sorted(GPU_BANDWIDTH.keys(), key=len, reverse=True)

# Apple Silicon unified-memory bandwidth (GB/s). For chip families with both
# binned and full variants under the same "Apple Mx Max" brand string, prefer
# GPU core count when hardware detection provides it; otherwise fall back to the
# conservative tier so speed estimates do not over-promise.
APPLE_BANDWIDTH_FIXED = {
    "m1 ultra": 800, "m1 max": 400, "m1 pro": 200, "m1": 68,
    "m2 ultra": 800, "m2 max": 400, "m2 pro": 200, "m2": 100,
    "m3 ultra": 800, "m3 pro": 150, "m3": 100,
    "m4 pro": 273, "m4": 120,
    "m5 pro": 307, "m5": 153,
}
APPLE_BANDWIDTH_BY_CORES = {
    "m3 max": {30: 300, 40: 400},
    "m4 max": {32: 410, 40: 546},
    "m5 max": {32: 460, 40: 614},
}
_APPLE_FIXED_KEYS_SORTED = sorted(APPLE_BANDWIDTH_FIXED.keys(), key=len, reverse=True)
_APPLE_VARIANT_KEYS_SORTED = sorted(APPLE_BANDWIDTH_BY_CORES.keys(), key=len, reverse=True)

# metal: backstop for Apple Silicon chips not in the explicit tables above
# (e.g. a future M6) — use a conservative generic estimate when unknown.
FALLBACK_K = {"cuda": 220, "rocm": 180, "metal": 150, "cpu_x86": 70, "cpu_arm": 90}

USE_CASE_WEIGHTS = {
    "general":    (0.45, 0.30, 0.15, 0.10),
    "coding":     (0.50, 0.20, 0.15, 0.15),
    "reasoning":  (0.55, 0.15, 0.15, 0.15),
    "chat":       (0.40, 0.35, 0.15, 0.10),
    "multimodal": (0.50, 0.20, 0.15, 0.15),
    "embedding":  (0.30, 0.40, 0.20, 0.10),
    "tts":        (0.40, 0.35, 0.15, 0.10),
    "stt":        (0.40, 0.35, 0.15, 0.10),
}

SPEED_TARGET = {
    "general": 40, "coding": 40, "multimodal": 40, "chat": 40,
    "reasoning": 25, "embedding": 200, "tts": 40, "stt": 40,
}

CONTEXT_TARGET = {
    "general": 4096, "chat": 4096, "coding": 8192,
    "reasoning": 8192, "multimodal": 4096, "embedding": 512,
    "tts": 2048, "stt": 2048,
}


def _lookup_apple_bandwidth(system):
    gpu_name = system.get("gpu_name")
    if not isinstance(gpu_name, str) or not gpu_name:
        return None
    gn = gpu_name.lower()

    # Guard against false matches on non-Apple GPUs whose names contain
    # "m3"/"m4"/"m5" (e.g. NVIDIA Quadro M4 000).
    if "apple" not in gn:
        return None

    raw_cores = system.get("gpu_cores")
    try:
        gpu_cores = int(raw_cores) if raw_cores is not None else None
    except (TypeError, ValueError):
        gpu_cores = None

    for key in _APPLE_VARIANT_KEYS_SORTED:
        if key not in gn:
            continue
        if gpu_cores in APPLE_BANDWIDTH_BY_CORES[key]:
            return APPLE_BANDWIDTH_BY_CORES[key][gpu_cores]
        return min(APPLE_BANDWIDTH_BY_CORES[key].values())

    for key in _APPLE_FIXED_KEYS_SORTED:
        if key in gn:
            return APPLE_BANDWIDTH_FIXED[key]
    return None


def _lookup_bandwidth(system):
    if isinstance(system, dict):
        gpu_name = system.get("gpu_name")
    else:
        gpu_name = system

    if not isinstance(gpu_name, str) or not gpu_name:
        return None

    # Apple tiers live only in the Apple-specific table now (#2564), so route
    # BOTH dict and bare-string callers through it. A bare string carries no
    # gpu_cores, so the helper falls back to the conservative (lowest) tier for
    # that model -- before #2564 the generic table answered string lookups, and
    # dropping that made _lookup_bandwidth("Apple M3 Max") return None.
    apple_input = system if isinstance(system, dict) else {"gpu_name": gpu_name}
    bw = _lookup_apple_bandwidth(apple_input)
    if bw is not None:
        return bw

    gn = gpu_name.lower()
    for key in _BW_KEYS_SORTED:
        if key in gn:
            return GPU_BANDWIDTH[key]
    return None


def _estimate_speed(model, quant, run_mode, system, offload_frac=0.0):
    """估算 tok/s。使用 MoE 的活跃参数量（每 token 仅活跃专家参与计算）。

    offload_frac (0..1): fraction of the model's weights that spill to system RAM
    (CPU) because they don't fit VRAM. Generation reads every active weight per
    token, so when part lives in CPU RAM the per-token time is dominated by the
    slow path. We model effective bandwidth as a blend of GPU VRAM bandwidth and
    system-RAM bandwidth weighted by what's where — far more accurate than a flat
    "halve it" for partial offload, which under/over-shoots depending on amount.
    已对实测 RX 9060 XT 校准：DeepSeek-Coder-V2-Lite Q4_K_M 轻度卸载时，
    估算 ~59 t/s vs 实测 59.8。
    """
    pb = _active_params_b(model)
    is_moe = model.get("is_moe", False)
    bw = _lookup_bandwidth(system)
    backend = system.get("backend", "cpu_x86")

    if bw and run_mode in ("gpu", "cpu_offload"):
        bpp = QUANT_BYTES_PER_PARAM.get(quant, 0.5)
        model_gb = pb * bpp
        if model_gb <= 0:
            return 0.0
        efficiency = 0.55
        if run_mode == "cpu_offload":
            # 双通道 DDR4-3200 ≈ 50 GB/s；DDR5 系统更高，但需要保守
            # 估计，因为卸载的 MoE 在 CPU 端同样受计算能力限制。
            cpu_bw = 55.0
            frac = min(max(offload_frac, 0.0), 1.0)
            # 如果不知道卸载比例（旧调用方在 cpu_offload 模式传入 0），
            # 假设有意义的溢出量，避免高估性能。
            if frac <= 0.0:
                frac = 0.5
            # 调和式混合：time = frac/cpu_bw + (1-frac)/gpu_bw，
            # 因此当更多专家卸载时，CPU 慢速部分会逐渐主导
            # （与实际中卸载比例增加时性能陡降的现象一致）。
            eff_bw = 1.0 / (frac / cpu_bw + (1.0 - frac) / bw)
            raw_tps = (eff_bw / model_gb) * efficiency
            return raw_tps * (0.8 if is_moe else 1.0)
        # 完全在 GPU 上运行。
        raw_tps = (bw / model_gb) * efficiency
        return raw_tps * (0.8 if is_moe else 1.0)

    k = FALLBACK_K.get(backend, 70)
    if pb <= 0:
        return 0.0
    sm = QUANT_SPEED_MULT.get(quant, 1.0)
    return k / pb * sm


def _architecture_bonus(model):
    name = (model.get("name") or "").lower()
    arch = (model.get("architecture") or "").lower()
    text = f"{name} {arch}"

    # Keep this intentionally small: hardware fit and speed still matter, but
    # current model families should not be scored the same as older Qwen2/LLama
    # era entries just because the parameter count is similar.
    if "qwen3.6" in text or "qwen3_6" in text:
        return 9
    if "qwen3.5" in text or "qwen3_5" in text:
        return 8
    if "qwen3-next" in text or "qwen3_next" in text:
        return 6
    if "qwen3" in text or arch.startswith("qwen3"):
        return 4
    if "qwen2.5" in text or "qwen2_5" in text:
        return 2
    return 0


def _quality_score(model, quant, use_case):
    pb = params_b(model)
    if pb < 1:
        base = 30
    elif pb < 3:
        base = 45
    elif pb < 7:
        base = 60
    elif pb < 10:
        base = 75
    elif pb < 20:
        base = 82
    elif pb < 40:
        base = 89
    else:
        base = 95

    name_lower = model.get("name", "").lower()
    if "qwen" in name_lower:
        base += 2
    if "deepseek" in name_lower:
        base += 3
    if "llama" in name_lower:
        base += 2
    if "mistral" in name_lower or "mixtral" in name_lower:
        base += 1
    if "gemma" in name_lower:
        base += 1

    base += _architecture_bonus(model)
    base += QUANT_QUALITY_PENALTY.get(quant, 0)

    model_uc = infer_use_case(model)
    if model_uc == "coding" and use_case == "coding":
        base += 6
    elif model_uc == "coding" and use_case in ("general", "chat"):
        # 代码专用模型在通用场景下仍有价值，但不应
        # 占据默认扫描的主导位置。用户需要代码时会通过
        # Coding 筛选器获得上述加分。
        base -= 10
    if model_uc == "reasoning" and use_case == "reasoning" and pb >= 13:
        base += 5
    elif model_uc == "reasoning" and use_case == "chat":
        base -= 4
    if model_uc == "multimodal" and use_case == "multimodal":
        base += 6

    return max(0, min(100, base))


def _speed_score(tps, use_case):
    target = SPEED_TARGET.get(use_case, 40)
    return max(0, min(100, (tps / target) * 100))


def _fit_score(required, available):
    if required > available:
        return 0
    if available <= 0:
        return 0
    ratio = required / available
    if ratio <= 0.5:
        return 60 + (ratio / 0.5) * 40
    if ratio <= 0.8:
        return 100
    if ratio <= 0.9:
        return 70
    return 50


def _context_score(ctx, use_case):
    target = CONTEXT_TARGET.get(use_case, 4096)
    if ctx >= target:
        return 100
    if ctx >= target / 2:
        return 70
    return 30


def _try_quant_at(model, quant, ctx, gpu_vram, available_ram):
    """在给定上下文下尝试特定量化。返回 (run_mode, quant, ctx, mem) 或 None。"""
    mem = estimate_memory_gb(model, quant, ctx)
    if gpu_vram > 0 and mem <= gpu_vram:
        return "gpu", quant, ctx, mem
    if gpu_vram > 0 and mem <= available_ram:
        return "cpu_offload", quant, ctx, mem
    if gpu_vram <= 0 and mem <= available_ram:
        return "cpu_only", quant, ctx, mem
    # 尝试将上下文长度减半
    cur_ctx = ctx // 2
    while cur_ctx >= 1024:
        mem = estimate_memory_gb(model, quant, cur_ctx)
        if gpu_vram > 0 and mem <= gpu_vram:
            return "gpu", quant, cur_ctx, mem
        if mem <= available_ram:
            return ("cpu_offload" if gpu_vram > 0 else "cpu_only"), quant, cur_ctx, mem
        cur_ctx //= 2
    return None


def _quant_bits(q):
    """近似量化标签的位宽，使 GGUF 量化等级（Q4/Q8/…）能与
    预量化格式（AWQ 4、AWQ-8bit、FP8、GPTQ-4bit…）匹配。
    未知时返回 0（调用方视作"不过滤"）。"""
    qu = (q or "").upper().replace("-", "").replace("_", "").replace(" ", "")
    # GGUF k-quant 系列 + 浮点格式
    if qu.startswith("Q8") or "FP8" in qu or "INT8" in qu or qu.startswith("W8"):
        return 8
    if qu.startswith("Q4") or qu.startswith("IQ4") or "FP4" in qu or "NF4" in qu or "INT4" in qu or qu.startswith("W4"):
        return 4
    if qu.startswith("Q2") or qu.startswith("IQ2"):
        return 2
    if qu.startswith("Q3") or qu.startswith("IQ3"):
        return 3
    if qu.startswith("Q5"):
        return 5
    if qu.startswith("Q6"):
        return 6
    if qu.startswith("F16") or qu.startswith("BF16") or qu.startswith("F32"):
        return 16
    # 预量化格式：提取位宽数字（AWQ4 / AWQ4BIT / GPTQ8 / 4BIT / INT8 ...）
    m = re.search(r"(?:AWQ|GPTQ|MLX|EXL2|BNB|INT|W)(\d{1,2})", qu) or re.search(r"(\d{1,2})BIT", qu)
    if m:
        b = int(m.group(1))
        if 2 <= b <= 16:
            return b
    return 0


def _native_quant(model):
    native_quant = model.get("quantization", "Q4_K_M")
    name = (model.get("name") or "").lower()
    fmt = (model.get("format") or "").lower()
    text = f"{name} {fmt}"
    if "nvfp4" in text:
        return "NVFP4"
    if re.search(r"(^|[-_/])fp8($|[-_/\s])", text):
        return "FP8"
    if "gptq" in text:
        m = re.search(r"(?:gptq|int|w)(?:[-_]?)(\d{1,2})(?:bit)?", text)
        # 规范的目录标签为 "GPTQ-Int4"/"GPTQ-Int8"（参见 models.py
        # QUANT_BPP / QUANT_QUALITY_PENALTY 的键）；"GPTQ-4bit" 两个映射
        # 都会错过，因此 BPP 和质量罚分静默回退到默认值。
        return f"GPTQ-Int{m.group(1)}" if m else "GPTQ-Int4"
    if "awq" in text:
        m = re.search(r"(?:awq|int|w)(?:[-_]?)(\d{1,2})(?:bit)?", text)
        # 目录中的键为 "AWQ-4bit"/"AWQ-8bit"；裸 "AWQ" 无法匹配。
        return f"AWQ-{m.group(1)}bit" if m else "AWQ-4bit"
    if "mlx" in text:
        m = re.search(r"mlx[-_]?(\d{1,2})bit", text)
        return f"mlx-{m.group(1)}bit" if m else native_quant
    if not (model.get("is_gguf") or model.get("gguf_sources")) and re.search(r"(^|[-_/])(?:int)?8bit($|[-_/\s])", text):
        return "INT8"
    return native_quant


def analyze_model(model, system, target_quant=None, scoring_use_case=None, target_context=None):
    pb = params_b(model)
    if pb <= 0:
        return None

    model_use_case = infer_use_case(model)
    score_use_case = scoring_use_case or "general"
    has_gpu = system.get("has_gpu", False)
    gpu_vram = (system.get("gpu_vram_gb") or 0) if has_gpu else 0
    gpu_count = system.get("gpu_count", 1) or 1
    single_gpu_vram = gpu_vram / gpu_count if gpu_count > 1 else gpu_vram
    available_ram = system.get("available_ram_gb", 0)
    # 当用户明确选择了 GPU 配置（非 RAM 模式），他们想看的是真正在
    # GPU 上运行的结果 — 而不是通过将大部分层溢出到系统 RAM 才
    # "装得下"的大模型。将卸载预算清零会让 _try_quant_at 只走 GPU
    # 分支（装在显存里，必要时缩减上下文），否则返回 None。
    # 这修复了 "96 GB GPU 仍显示 175 GB 模型" 的问题。
    gpu_only = bool(system.get("gpu_only")) and has_gpu and gpu_vram > 0
    eff_ram = 0 if gpu_only else available_ram
    is_moe = model.get("is_moe", False)
    model_ctx = model.get("context_length", 4096) or 4096
    try:
        target_context = int(target_context or 0)
    except (TypeError, ValueError):
        target_context = 0
    ctx = min(model_ctx, target_context) if target_context > 0 else model_ctx

    native_quant = _native_quant(model)
    preq = is_prequantized(model)

    # GGUF 模型不能跨 GPU 分片 — 使用单 GPU 显存
    is_gguf = bool(model.get("gguf_sources"))
    quant_upper = (native_quant or "").upper()
    is_gguf_quant = any(quant_upper.startswith(p) for p in ("Q2", "Q3", "Q4", "Q5", "Q6", "Q8", "IQ", "F16", "F32"))
    # Single-GPU VRAM only applies to GGUF/dense builds (llama.cpp can't shard
    # across GPUs). Prequantized formats (AWQ/GPTQ/FP8) are served sharded by
    # vLLM across all GPUs, so they get the FULL multi-GPU VRAM — even when the
    # model also lists a GGUF alternate download (gguf_sources).
    if (is_gguf or is_gguf_quant) and not preq:
        effective_vram = single_gpu_vram
    else:
        effective_vram = gpu_vram

    native_gpu_only = preq and not native_quant.startswith("mlx-")

    # 确定要评估的量化级别
    native_quant_prefixes = (
        "AWQ-", "GPTQ-", "FP8", "FP4", "NVFP4", "MXFP4", "NF4",
        "INT4", "INT8", "W4A16", "W8A8", "W8A16",
    )

    if preq:
        # 原生 HF/vLLM 量化仓库使用固定格式。如果用户选择了
        # GGUF 量化等级（Q4/Q8/等），不要将同一位宽的
        # AWQ/GPTQ/FP8/FP4 构建视为等价；这些格式是独立的
        # 服务路径，仅在明确选择或未过滤时出现。
        if target_quant:
            if not any(target_quant.startswith(p) for p in native_quant_prefixes):
                return None
            _tb, _nb = _quant_bits(target_quant), _quant_bits(native_quant)
            if _tb and _nb and _tb != _nb:
                return None
        quant_to_try = native_quant
    elif target_quant:
        # 用户选择了特定的量化级别
        quant_to_try = target_quant
    elif gpu_count >= 2:
        # 多 GPU 机器：vLLM/SGLang 无法服务 GGUF Q* 量化（那些是
        # llama.cpp 专用）。将非预量化模型默认为 BF16，使行
        # 在多 GPU 环境中有意义。如果 BF16 装不下，模型会显示为
        # too_tight — 比显示一个用户在 >1 GPU 上
        # 实际上无法用 vLLM 服务的 Q4 行更好。
        quant_to_try = "BF16"
    else:
        # 默认：Q4_K_M（用户的设定偏好）— 保留给单 GPU
        # 和 RAM 模式，这些场景下 llama.cpp 服务是自然路径。
        quant_to_try = "Q4_K_M"

    # 多 GPU 筛选：如果解析出的量化是 GGUF 等级（Q*/IQ- 前缀），
    # 跳过该行 — vLLM/SGLang 无法服务这些，因此在 2+ GPU 配置中
    # 显示它们只会让列表充斥不可服务的候选项。
    if gpu_count >= 2 and quant_to_try and not target_quant and quant_to_try.upper().startswith(("Q2", "Q3", "Q4", "Q5", "Q6", "Q8", "IQ")):
        return None

    result = _try_quant_at(model, quant_to_try, ctx, effective_vram, 0 if native_gpu_only else eff_ram)

    if result is None:
        # 模型在当前硬件上装不下。仍然展示它，但标记
        # "too_tight"，而不是静默地将其丢弃 — 否则，
        # 编辑硬件配置尝试更大容量时，用户永远看不到
        # 更大的模型，因为它们在用户看到能装下什么之前就
        # 被过滤掉了。客户端已经知道如何渲染 too_tight
        # （红色行）。
        oversized_required = estimate_memory_gb(model, quant_to_try, ctx)
        return {
            "name": model.get("name"),
            "provider": model.get("provider"),
            "parameter_count": model.get("parameter_count"),
            "params_b": round(pb, 1),
            "is_moe": is_moe,
            "use_case": model_use_case,
            "fit_level": "too_tight",
            "run_mode": "no_fit",
            "quant": quant_to_try,
            "context": ctx,
            "required_gb": round(oversized_required, 1),
            "speed_tps": 0,
            "score": 0,
            "scores": {"quality": 0, "speed": 0, "fit": 0, "context": 0},
            "gguf_sources": model.get("gguf_sources", []),
            "context_length": model_ctx,
            "target_context": target_context or None,
        }

    run_mode, quant, fit_ctx, required_gb = result

    # 确定适配级别
    budget = effective_vram if run_mode == "gpu" else available_ram
    if required_gb > budget:
        return None
    if run_mode == "gpu":
        rec = model.get("recommended_ram_gb") or required_gb
        if rec <= gpu_vram:
            fit_level = "perfect"
        elif gpu_vram >= required_gb * 1.2:
            fit_level = "good"
        else:
            fit_level = "marginal"
    elif run_mode == "cpu_offload":
        fit_level = "good" if available_ram >= required_gb * 1.2 else "marginal"
    else:
        fit_level = "marginal"

    # 溢出到 CPU RAM 的模型权重比例（驱动卸载速度
    # 模型）。卸载时，超出 GPU 显存的部分位于系统 RAM 中。
    offload_frac = 0.0
    if run_mode == "cpu_offload" and required_gb > 0 and effective_vram > 0:
        offload_frac = max(0.0, (required_gb - effective_vram) / required_gb)
    tps = _estimate_speed(model, quant, run_mode, system, offload_frac=offload_frac)

    q_score = _quality_score(model, quant, score_use_case)
    s_score = _speed_score(tps, score_use_case)
    f_score = _fit_score(required_gb, budget)
    c_score = _context_score(fit_ctx, score_use_case)

    wq, ws, wf, wc = USE_CASE_WEIGHTS.get(score_use_case, (0.45, 0.30, 0.15, 0.10))
    composite = q_score * wq + s_score * ws + f_score * wf + c_score * wc

    return {
        "name": model.get("name"),
        "provider": model.get("provider"),
        "parameter_count": model.get("parameter_count"),
        "params_b": round(pb, 1),
        "is_moe": is_moe,
        "use_case": model_use_case,
        "fit_level": fit_level,
        "run_mode": run_mode,
        "quant": quant,
        "context": fit_ctx,
        "required_gb": round(required_gb, 1),
        "speed_tps": round(tps, 1),
        "score": round(composite, 1),
        "scores": {
            "quality": round(q_score, 1),
            "speed": round(s_score, 1),
            "fit": round(f_score, 1),
            "context": round(c_score, 1),
        },
        "gguf_sources": model.get("gguf_sources", []),
        "context_length": model_ctx,
        "release_date": model.get("release_date", ""),
        "target_context": target_context or None,
    }


def _version_key(name):
    """从模型的展示名称中解析版本号，使同龄分
    的行可以按较新版本打破平局（例如 M2.7 > M2.5）。
    返回 float；无法识别版本号的名称返回 0.0。正则表达式
    抓取连字符/下划线后的第一个"包含数字的单词"，
    因此例如 'MiniMax-M2.7' -> 2.7, 'Qwen3.6-35B' -> 3.6, 'M2' -> 2.0。"""
    import re as _re
    if not name:
        return 0.0
    # 匹配版本标记词：一个字母后跟数字，可带小数，
    # 例如 M2.7, V4, Pro3。取第一个命中；忽略
    # 带 "B" 后缀的参数量（Qwen3-235B 应产出 3，不应产出 235）。
    for m in _re.finditer(r"[A-Za-z](\d+(?:\.\d+)?)(?![A-Za-z])", name):
        val = m.group(1)
        # 跳过参数量标记（例如 "235B" 给出 "235"，但下一个
        # 字符是 "B" — 已被否定前瞻排除）。
        try:
            f = float(val)
        except ValueError:
            continue
        # 启发式规则：裸整数 >= 100 几乎肯定是参数量
        # （1B/3B/8B/70B/235B…）而非版本号。跳过它们。
        if "." not in val and f >= 100:
            continue
        return f
    return 0.0


SORT_KEYS = {
    # Score sort with version-aware tiebreaker — when two rows tie on
    # composite score (a common case for the SAME base model in different
    # 例如 MiniMax-M2.5 vs M2.7 在相同 FP8 预算下同分），
    # prefer the newer version. Without this, ties resolved to whatever
    # order they came out of the registry, which let older releases land
    # above newer ones in user-facing lists.
    "score": lambda r: (r["score"], _version_key(r.get("name") or "")),
    "speed": lambda r: r["speed_tps"],
    "vram": lambda r: r["required_gb"],
    "params": lambda r: r["params_b"],
    "context": lambda r: r["context"],
    # 最新优先。release_date 是类 ISO 字符串（"2026-05-30"）；
    # string sort is chronological. Missing dates sort last (empty < any date,
    # and we sort reverse=True for newest, so "" lands at the bottom).
    "newest": lambda r: r.get("release_date") or "",
}


def rank_models(system, use_case=None, limit=50, search=None, sort="score", quant=None, target_context=None, fit_only=False):
    """按检测到的硬件对所有模型评分排序。返回排序后的适配结果列表。

    fit_only：为 True 时，丢弃 fit_level 为 "too_tight" 的行（模型无法
    放入所选预算）。为 False（默认）时，显示所有模型 —
    按参数排序意味着永久显示最高参数量，即使无法运行，
    这样用户能看到真实情况。
    """
    models = get_models()
    results = []

    # 仅在明确按 image_gen 筛选时包含图像生成模型
    if use_case == "image_gen":
        try:
            from services.hwfit.image_models import rank_image_models
        except ImportError:
            rank_image_models = None
        if rank_image_models:
            img_results = rank_image_models(system, search=search)
        else:
            img_results = []
        for im in img_results:
            fit_map = {"perfect": "perfect", "good": "good", "tight": "marginal", "no_fit": "too_tight", "no_gpu": "too_tight"}
            results.append({
                "name": im["id"],
                "provider": im["provider"],
                "parameter_count": f"{im['params_b']}B",
                "params_b": im["params_b"],
                "is_moe": False,
                "use_case": "image_gen",
                "fit_level": fit_map.get(im["fit"], "too_tight"),
                "run_mode": "gpu" if im["fits"] else "no_fit",
                "quant": im.get("quant", "BF16"),
                "context": 0,
                "context_length": 0,
                "required_gb": round(im.get("vram_needed") or 0, 1),
                "speed_tps": 0,
                "score": float(im["score"]),
                "scores": {"quality": float(im["quality"]), "speed": float(im["speed"]), "fit": 0, "context": 0},
                "gguf_sources": [],
                "is_image_gen": True,
                "capabilities": im.get("capabilities", []),
                "description": im.get("description", ""),
            })
        if use_case == "image_gen":
            sort_fn = SORT_KEYS.get(sort, SORT_KEYS["score"])
            results.sort(key=sort_fn, reverse=True)  # 参见下方主路径
            return results[:limit]

    # 如果用户选择了原生预量化格式，仅筛选这些模型。
    filter_native = quant and any(quant.startswith(p) for p in (
        "AWQ-", "GPTQ-", "FP8", "FP4", "NVFP4", "MXFP4", "NF4",
        "INT4", "INT8", "W4A16", "W8A8", "W8A16",
    ))

    system_backend = (system.get("backend") or "").lower()
    apple_silicon = system_backend in ("mps", "metal", "apple")
    rocm = system_backend == "rocm"
    is_windows = system.get("platform") == "windows"

    # 消费级 AMD Radeon（RDNA, gfx10/11/12）：实际的本地服务路径
    # 是 GGUF via llama.cpp。ROCm 上的 vLLM/SGLang 已针对数据中心
    # Instinct（CDNA, gfx9xx）验证，但在消费级 RDNA 上不可靠 —
    # AWQ kernel 大多不支持，FP8 需要额外补丁。因此将
    # 消费级 RDNA 当作 Apple Silicon 对待（仅 GGUF），保持 CDNA 不变。
    # 未知系列（无 rocminfo）保持不变，避免在误检测时
    # 隐藏本可能运行在 Instinct 上的模型。
    gpu_family = (system.get("gpu_family") or "").lower()
    consumer_amd = system_backend == "rocm" and gpu_family == "rdna"

    for m in models:
        native_q = _native_quant(m)

        # MLX 需要 mlx_lm 运行时，Odysseus 不为其生成 serve
        # 命令。在所有后端（包括 Metal）上隐藏它。
        if native_q.startswith("mlx-") or "mlx" in (m.get("name") or "").lower():
            continue

        # ROCm 对 vLLM/SGLang 量化 safetensors 的支持过于脆弱，
        # 不能在默认扫描中盲目推荐。仅当用户从量化筛选器
        # 明确选择该格式时，AWQ/GPTQ/FP8 才可见；否则优先 GGUF/Q*
        # 条目，Odysseus 可通过 llama.cpp/Ollama 路由，而不会
        # 假装"显存放得下"就意味"可以服务"。
        if rocm and is_prequantized(m) and not filter_native:
            continue

        # 在 Apple Silicon 上唯一的服务引擎是 llama.cpp 和 Ollama，
        # 两者都仅支持 GGUF（vLLM/SGLang 是 CUDA/ROCm 的，不在 macOS
        # 上运行）。因此模型仅在提供真实 GGUF 时才是 Metal 可服务的。
        # 丢弃其他所有 — 裸 safetensors 仓库（目录仍标有默认 GGUF
        # 量化）和 vLLM 专用的 AWQ/GPTQ/FP8 构建。否则 Cookbook
        # 会推荐 Mac 无法运行的模型；在 CUDA 上这些保持可见，
        # 因为 vLLM 直接服务 safetensors。
        #
        # 消费级 AMD（RDNA）同理：GGUF via llama.cpp 是
        # 可服务路径，因此模型需要真实 GGUF 才能被推荐。
        # 否则 Cookbook 会在实际上无法服务的 Radeon 上
        # 将 vLLM 专用的 AWQ/GPTQ 评为 "GOOD"。
        #
        # Windows 同理：Odysseus 在 Windows 上仅支持 llama.cpp，
        # 这需要 GGUF。vLLM/SGLang 被显式阻止，因此没有 GGUF
        # 源的 AWQ/GPTQ 模型在那里不可服务。
        if (apple_silicon or consumer_amd or is_windows) and not (m.get("is_gguf") or m.get("gguf_sources")):
            continue

        # 格式过滤器：AWQ 标签 -> 仅 AWQ 模型，FP4 标签 -> FP4 系列模型等。
        if filter_native:
            if quant == "FP8" and native_q != "FP8":
                continue
            if quant == "FP4" and native_q not in ("FP4", "NVFP4", "MXFP4", "NF4"):
                continue
            if quant.startswith("AWQ") and not native_q.startswith("AWQ"):
                continue
            if quant.startswith("GPTQ") and not native_q.startswith("GPTQ"):
                continue
            if quant.startswith("NVFP4") and not native_q.startswith("NVFP4"):
                continue
            if quant in ("INT4", "INT8", "W4A16", "W8A8", "W8A16") and native_q != quant:
                continue

        if search:
            name = m.get("name", "").lower()
            provider = m.get("provider", "").lower()
            if search.lower() not in name and search.lower() not in provider:
                continue

        result = analyze_model(m, system, target_quant=quant, scoring_use_case=(use_case or "general"), target_context=target_context)
        if result is None:
            continue

        if use_case:
            model_uc = infer_use_case(m)
            if use_case != model_uc and use_case != "general":
                continue

        results.append(result)

    # Pick the visible SET by the REQUESTED column. Per-user feedback: sorting
    # by Param should show the highest-param models PERIOD, not just those that
    # already fit. Same for every other column. Models that don't fit are still
    # in the list with their fit_level marking the constraint, so the user can
    # see the truth instead of a quietly-truncated view. Score sort is unchanged
    # (it's the default ranking and naturally pushes non-fits to the bottom).
    if fit_only:
        # 隐藏确实装不下的行（"too_tight" 标记）— 用户
        # 明确要求仅显示适配的视图。
        results = [r for r in results if r.get("fit_level") != "too_tight"]
    sort_fn = SORT_KEYS.get(sort, SORT_KEYS["score"])
    # Always sort descending then truncate top-N so each column shows the
    # global highest by that metric. Before, vram was special-cased
    # ascending → truncate kept the 50 SMALLEST models and "highest VRAM"
    # could never appear, breaking the column-click toggle.
    results.sort(key=sort_fn, reverse=True)
    results = results[:limit]
    return results
