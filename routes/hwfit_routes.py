import re
from copy import deepcopy

from fastapi import APIRouter


# 手动硬件模拟器接受的后端。必须是
# services.hwfit.fit 能理解的子集，确保模拟与真实机器排名一致：
# "metal" 走 Apple Silicon 路径（仅 GGUF，llama.cpp/Ollama），
# CPU 后端走 RAM/offload 路径，cuda/rocm 走 vLLM。
_MANUAL_BACKENDS = {"cuda", "rocm", "metal", "cpu_x86", "cpu_arm"}


def _apply_manual_hardware(system, manual_mode="", manual_gpu_count="", manual_vram_gb="", manual_ram_gb="", manual_backend=""):
    """Manual hardware is a "what if I had this setup" simulator —
    REPLACES the detected hardware entirely instead of adding to it.

    The previous additive behavior averaged the manual VRAM across
    all GPUs (base + manual), which meant adding "1× 400 GB" on top
    of "2× 70 GB" only nudged the per-GPU cap from 70 to 180 GB
    (= 540 / 3), so GGUF models bigger than that still didn't surface
    — exactly the "cap stuck at detected level" bug the user hit.
    """
    manual_mode = (manual_mode or "").lower()
    if manual_mode not in {"gpu", "ram"}:
        return system

    try:
        override_ram_gb = float(manual_ram_gb) if manual_ram_gb else 0
    except ValueError:
        override_ram_gb = 0
    override_ram_gb = max(0.0, override_ram_gb)
    if override_ram_gb:
        # Replace RAM, don't add. The number in the field is the
        # 用户想要模拟的系统总内存。
        system["available_ram_gb"] = round(override_ram_gb, 1)
        system["total_ram_gb"] = round(override_ram_gb, 1)
    system["manual_hardware"] = True

    if manual_mode == "ram":
        # 纯 RAM 模拟 — 完全清除 GPU 数据，使排名器使用
        # CPU/RAM 路径。
        system["has_gpu"] = False
        system["gpu_name"] = None
        system["gpu_vram_gb"] = 0
        system["gpu_count"] = 0
        system["gpus"] = []
        system["gpu_groups"] = []
        system["backend"] = "cpu_x86"
        system.pop("unified_memory", None)
        return system

    try:
        count = int(manual_gpu_count) if manual_gpu_count else 1
    except ValueError:
        count = 1
    try:
        vram_each = float(manual_vram_gb) if manual_vram_gb else 8.0
    except ValueError:
        vram_each = 8.0
    count = max(1, min(count, 16))
    vram_each = max(1.0, vram_each)
    backend = (manual_backend or system.get("backend") or "cuda").lower()
    if backend not in _MANUAL_BACKENDS:
        backend = "cuda"
    total_vram = round(vram_each * count, 1)
    gpu_name = f"Simulated {backend.upper()} GPU" + (f" × {count}" if count > 1 else "")
    system["has_gpu"] = True
    system["gpu_name"] = gpu_name
    system["gpu_vram_gb"] = total_vram
    system["gpu_count"] = count
    system["gpus"] = [
        {"index": i, "name": gpu_name, "vram_gb": vram_each}
        for i in range(count)
    ]
    # 单个同构池 — vram_each 是用户输入的每 GPU 实际
    # VRAM the user entered, not an average. That's the whole point:
    # 提升 vram_each 会将每 GPU 上限（GGUF、张量并行）
    # 拉高到底，而非仅微调一小部分。
    system["gpu_groups"] = [{
        "name": gpu_name,
        "vram_each": vram_each,
        "count": count,
        "indices": list(range(count)),
        "vram_total": total_vram,
    }]
    system["homogeneous"] = True
    system["backend"] = backend
    # Apple Silicon 与 GPU 共享统一内存池；标记此以便
    # API/UI 按真实 Metal 检测方式报告。独立 GPU
    # （cuda/rocm）和 CPU 后端使用独立 VRAM，因此清除
    # 先前检测留下的过时标记。
    if backend == "metal":
        system["unified_memory"] = True
    else:
        system.pop("unified_memory", None)
    return system


def setup_hwfit_routes():
    router = APIRouter(prefix="/api/hwfit", tags=["hwfit"])

    @router.get("/system")
    def get_system(host: str = "", ssh_port: str = "", platform: str = "", fresh: bool = False):
        """检测并返回当前系统硬件信息。远程时传入 host=user@server。
        fresh=true 绕过每主机缓存（重新扫描按钮）。"""
        from services.hwfit.hardware import detect_system
        return detect_system(host=host, ssh_port=ssh_port, platform=platform, fresh=fresh)

    @router.get("/models")
    def get_models(use_case: str = "", sort: str = "score", limit: int = 50, search: str = "", host: str = "", quant: str = "", ctx: str = "", gpu_count: str = "", gpu_group: str = "", ssh_port: str = "", platform: str = "", fresh: bool = False, manual_mode: str = "", manual_gpu_count: str = "", manual_vram_gb: str = "", manual_ram_gb: str = "", manual_backend: str = "", ignore_detected_gpu: bool = False, ignore_detected_ram: bool = False, fit_only: bool = False):
        """根据检测到的硬件对 LLM 模型评分并返回结果。
        gpu_count: override GPU count (0 = CPU only, 1-N = simulate N GPUs of the
            的活跃组）。gpu_group: system.gpu_groups 中的索引（同构池），
            目标池 — 空/auto = 最大池。vLLM 只能
            在相同 GPU 上进行张量并行，因此从不混合池。
        fresh=true 绕过硬件检测缓存。"""
        from services.hwfit.hardware import detect_system
        from services.hwfit.fit import rank_models
        from services.hwfit.models import get_models, model_catalog_path
        system = deepcopy(detect_system(host=host, ssh_port=ssh_port, platform=platform, fresh=fresh))
        if system.get("error"):
            return {"system": system, "models": [], "error": system["error"]}
        if not get_models():
            return {
                "system": system,
                "models": [],
                "error": f"Model catalog missing or empty: {model_catalog_path()}",
            }

        if ignore_detected_gpu:
            system["has_gpu"] = False
            system["gpu_name"] = None
            system["gpu_vram_gb"] = 0
            system["gpu_count"] = 0
            system["gpus"] = []
            system["gpu_groups"] = []
        if ignore_detected_ram:
            system["available_ram_gb"] = 0
            system["total_ram_gb"] = 0

        system = _apply_manual_hardware(system, manual_mode, manual_gpu_count, manual_vram_gb, manual_ram_gb, manual_backend)

        # Keep the raw detection around so the UI can still show the box's full
        # GPU 配置，即使我们正针对单个同构池进行排名。
        system["detected_gpu_vram_gb"] = system.get("gpu_vram_gb")
        system["detected_gpu_count"] = system.get("gpu_count")

        groups = system.get("gpu_groups") or []
        # 解析目标同构池。默认（auto）= 最大池，
        # 对于均匀机器即「所有 GPU」— 行为不变。
        grp = None
        if groups:
            try:
                gidx = int(gpu_group) if gpu_group != "" else 0
            except ValueError:
                gidx = 0
            if 0 <= gidx < len(groups):
                grp = groups[gidx]

        def _apply_group(g, n):
            n = max(1, min(n, g["count"]))
            system["gpu_count"] = n
            system["gpu_vram_gb"] = round(g["vram_each"] * n, 1)
            system["gpu_name"] = g["name"]
            system["active_group"] = {**g, "use_count": n}

        if gpu_count != "":
            n = int(gpu_count)
            if n == 0:
                # RAM 模式：按系统内存排名，允许卸载。
                system["has_gpu"] = False
                system["gpu_vram_gb"] = 0
                system["gpu_count"] = 0
                system["gpu_only"] = False
                system.pop("active_group", None)
            elif grp:
                _apply_group(grp, n)
                system["gpu_only"] = True
            else:
                # 无每 GPU 详情（旧版检测）— 假设均匀分配。
                single_vram = (system.get("gpu_vram_gb") or 0) / (system.get("gpu_count") or 1)
                system["gpu_count"] = max(1, n)
                system["gpu_vram_gb"] = round(single_vram * max(1, n), 1)
                system["gpu_only"] = True
        elif grp:
            # 无显式计数，但仍固定到一个池，以便异构
            # 机器按真实可混合组排名，而非虚构的 VRAM 总和。
            # 此处 gpu_only 保持关闭，让默认视图仍显示卸载选项。
            _apply_group(grp, grp["count"])

        try:
            target_context = int(ctx) if ctx else None
        except ValueError:
            target_context = None
        if target_context is not None:
            target_context = max(1024, min(target_context, 1000000))

        rank_kwargs = {
            "use_case": use_case or None,
            "limit": limit,
            "search": search or None,
            "sort": sort,
            "quant": quant or None,
            "fit_only": fit_only,
        }
        if target_context is not None:
            rank_kwargs["target_context"] = target_context
        try:
            import inspect
            supported = set(inspect.signature(rank_models).parameters)
            rank_kwargs = {k: v for k, v in rank_kwargs.items() if k in supported}
        except Exception:
            rank_kwargs.pop("target_context", None)
            rank_kwargs.pop("fit_only", None)
        results = rank_models(system, **rank_kwargs)
        return {"system": system, "models": results}

    @router.get("/profiles")
    def get_serve_profiles(model: str = "", host: str = "", ssh_port: str = "", platform: str = "", fresh: bool = False, serve_weights_gb: float = 0.0, serve_quant: str = ""):
        """Compute llama.cpp serve profiles (Quality/Balanced/Speed) for `model`
        against the detected hardware on `host` (or local). Returns concrete
        标志（n_gpu_layers、n_cpu_moe、cache_type、ctx），服务 UI 可应用。

        `model` is matched against the catalog by name; if it's not in the
        目录中（例如临时 HF 仓库），通过最小合成条目传递足够提示
        在此不可行，因此返回 []，UI 保留手动标志。
        """
        from services.hwfit.hardware import detect_system
        from services.hwfit.models import get_models
        from services.hwfit.profiles import compute_serve_profiles
        system = detect_system(host=host, ssh_port=ssh_port, platform=platform, fresh=fresh)
        if system.get("error"):
            return {"system": system, "profiles": [], "error": system["error"]}
        catalog = {m.get("name"): m for m in (get_models() or [])}

        def _norm(s):
            # 标准化用于匹配：去除 org/ 前缀、末尾的 -GGUF/-gguf
            # 标记和任何量化标签，小写。因此 "DeepSeek-Coder-V2-Lite-
            # Instruct-GGUF"（本地文件夹名）匹配目录条目
            # "deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct"。
            s = (s or "").lower().strip()
            s = s.split("/")[-1]                     # 去除 org 前缀
            s = re.sub(r"[-_.]?gguf$", "", s)        # 去除末尾 gguf 标记
            s = re.sub(r"[-_.](q\d[^/]*|iq\d[^/]*|fp8|bf16|f16|awq[^/]*|gptq[^/]*)$", "", s)
            return s

        m = catalog.get(model)
        if m is None and model:
            want = _norm(model)
            for name, entry in catalog.items():
                nn = _norm(name)
                if nn and (nn == want or want.endswith(nn) or nn.endswith(want)):
                    m = entry
                    break
        if m is None:
            return {"system": system, "profiles": [], "error": "model not in catalog"}
        # Surface the model's trained context limit so the serve UI can clamp a
        # 用户输入的上下文限制在此之下（请求 ctx > n_ctx_train 会溢出，
        # 且配合量化 KV 缓存可能导致 GPU 崩溃）。
        model_ctx_max = 0
        for k in ("context_length", "max_position_embeddings", "n_ctx_train", "context"):
            v = m.get(k)
            if isinstance(v, (int, float)) and v > 0:
                model_ctx_max = int(v)
                break
        return {
            "system": system,
            "profiles": compute_serve_profiles(
                system, m,
                serve_weights_gb=(serve_weights_gb or None),
                serve_quant=(serve_quant or None),
            ),
            "model_ctx_max": model_ctx_max,
        }

    @router.get("/image-models")
    def get_image_models(sort: str = "fit", search: str = "", host: str = "", gpu_count: str = "", ssh_port: str = "", platform: str = "", fresh: bool = False, manual_mode: str = "", manual_gpu_count: str = "", manual_vram_gb: str = "", manual_ram_gb: str = "", manual_backend: str = "", ignore_detected_gpu: bool = False, ignore_detected_ram: bool = False):
        """根据检测到的硬件对图像生成模型评分。"""
        from services.hwfit.hardware import detect_system
        from services.hwfit.image_models import rank_image_models
        system = deepcopy(detect_system(host=host, ssh_port=ssh_port, platform=platform, fresh=fresh))
        if system.get("error"):
            return {"system": system, "models": [], "error": system["error"]}
        if ignore_detected_gpu:
            system["has_gpu"] = False
            system["gpu_name"] = None
            system["gpu_vram_gb"] = 0
            system["gpu_count"] = 0
            system["gpus"] = []
            system["gpu_groups"] = []
        if ignore_detected_ram:
            system["available_ram_gb"] = 0
            system["total_ram_gb"] = 0
        system = _apply_manual_hardware(system, manual_mode, manual_gpu_count, manual_vram_gb, manual_ram_gb, manual_backend)
        # 图像模型使用单个 GPU — 始终使用每 GPU VRAM
        gpu_vrams = [float(g.get("vram_gb") or 0) for g in (system.get("gpus") or []) if isinstance(g, dict)]
        single_vram = max(gpu_vrams) if gpu_vrams else ((system.get("gpu_vram_gb") or 0) / max(system.get("gpu_count") or 1, 1))
        system["gpu_vram_gb"] = single_vram
        system["gpu_count"] = 1 if single_vram > 0 else 0
        results = rank_image_models(system, search=search or None, sort=sort)
        return {"system": system, "models": results}

    return router
