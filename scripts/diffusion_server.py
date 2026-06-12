#!/usr/bin/env python3
"""使用 diffusers 的最小 OpenAI 兼容图像生成 API 服务器。

提供 /v1/images/generations 和 /v1/models 端点，兼容
Odysseus 的图像生成工具。

用法：
    python3 scripts/diffusion_server.py --model /path/to/model --port 8100
"""
import os
import sys
import importlib
import importlib.machinery
# 阻止 xformers — 创建一个报告为未安装的假模块
_fake = type(sys)("xformers")
_fake.__version__ = "0.0.0"
_fake.__spec__ = importlib.machinery.ModuleSpec("xformers", None)
_fake.__path__ = []
sys.modules["xformers"] = _fake
sys.modules["xformers.ops"] = type(sys)("xformers.ops")
sys.modules["xformers.ops.fmha"] = type(sys)("xformers.ops.fmha")

import argparse
import base64
import io
import json
import logging
import time
from pathlib import Path

from contextlib import asynccontextmanager

import torch
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("diffusion_server")

_pipe = None
_model_id = ""
DTYPE_MAP = {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}
_args = None


@asynccontextmanager
async def lifespan(application):
    load_model()
    yield


app = FastAPI(title="Diffusion Server", lifespan=lifespan)

# 保守的默认值 — 服务器设计用于从 Odysseus 后端进行服务器到服务器的使用。
# 通配符 CORS + 127.0.0.1 默认绑定过去会让服务器在同主机上的任何浏览器标签页
# 通过 DNS 重新绑定可达。下面的 CLI 标志扩展了这些允许列表，供需要浏览器
# 访问的操作员使用；安全默认值处理常见情况。
_DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "::1"]
_DEFAULT_CORS_ORIGINS: list = []  # 默认拒绝


def _compute_allowed_hosts(bind_host: str, extras=None) -> list:
    """允许的 Host 头值：绑定地址 + 回环变体 +
    操作员提供的任何 --allowed-host 值。重复和空字符串
    被丢弃；顺序是稳定的，以便可预测的中间件设置。"""
    seen = []
    for h in (bind_host, *_DEFAULT_ALLOWED_HOSTS, *(extras or [])):
        h = (h or "").strip()
        if h and h not in seen:
            seen.append(h)
    return seen


def _compute_cors_origins(extras=None) -> list:
    """CORS 允许列表：默认拒绝（空），仅由显式的
    --allowed-origin 值扩展。服务器到服务器的调用者不设置 Origin
    头，所以不受影响；这仅限制浏览器访问。"""
    seen = []
    for o in (*_DEFAULT_CORS_ORIGINS, *(extras or [])):
        o = (o or "").strip()
        if o and o not in seen:
            seen.append(o)
    return seen


def _configure_security_middleware(application, allowed_hosts, allowed_origins):
    """用扩散服务器的安全中间件替换 `application` 的用户中间件栈：
    TrustedHost 允许列表，以及提供来源时的 CORS。在模块加载时
    和 __main__ CLI 路径在服务开始前使用。如果中间件栈已经构建，
    会在变更前抛出异常。顺序被保留：TrustedHost 优先，然后 CORS
    （最后添加 → 最外层）。"""
    if application.middleware_stack is not None:
        raise RuntimeError("security middleware must be configured before the app starts serving")
    application.user_middleware.clear()
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=list(allowed_hosts))
    if allowed_origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=list(allowed_origins),
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type"],
        )


# 在模块加载时安装默认值，以便导入应用进行测试/直接
# uvicorn 调用仍然受益于 Host 头允许列表。
_configure_security_middleware(app, _DEFAULT_ALLOWED_HOSTS, _DEFAULT_CORS_ORIGINS)


class ImageRequest(BaseModel):
    model: str = ""
    prompt: str
    n: int = 1
    size: str = "1024x1024"
    quality: str = "medium"
    response_format: str = "b64_json"


def _fix_meta_tensors(pipe, dtype):
    """将任何元张量替换为 CPU 上的真实零张量，以便 .to(cuda) 工作。"""
    for name, component in pipe.components.items():
        if not hasattr(component, 'parameters'):
            continue
        fixed = 0
        for pname, param in component.named_parameters():
            if param.device.type == 'meta':
                with torch.no_grad():
                    new_param = torch.zeros(param.shape, dtype=dtype, device='cpu')
                    # 遍历持有此参数的实际模块
                    parts = pname.split('.')
                    mod = component
                    for p in parts[:-1]:
                        mod = getattr(mod, p)
                    setattr(mod, parts[-1], torch.nn.Parameter(new_param, requires_grad=param.requires_grad))
                    fixed += 1
        if fixed:
            logger.info(f"  Fixed {fixed} meta tensors in {name}")


def load_model():
    global _pipe, _model_id
    import diffusers

    model_path = _args.model
    _model_id = Path(model_path).name
    dtype_map = {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}
    torch_dtype = dtype_map.get(_args.dtype, torch.bfloat16)
    use_offload = _args.cpu_offload

    logger.info(f"Loading model from {model_path} (dtype={_args.dtype}, offload={use_offload})...")

    # 确保 HF token 可用于需要授权的仓库
    _hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if _hf_token:
        logger.info("HF token found in environment")
        # 登录使所有 huggingface_hub 调用使用 token
        try:
            from huggingface_hub import login
            login(token=_hf_token, add_to_git_credential=False)
            logger.info("Logged in to HuggingFace Hub")
        except Exception as e:
            logger.warning(f"HF login failed: {e}")
    else:
        logger.warning("No HF_TOKEN set — gated models will fail")

    # 从 model_index.json 检测管道类
    model_index = Path(model_path) / "model_index.json"
    pipeline_cls = None
    cls_name_from_index = ""
    if model_index.exists():
        try:
            idx = json.loads(model_index.read_text(encoding="utf-8"))
            cls_name_from_index = idx.get("_class_name", "")
            if hasattr(diffusers, cls_name_from_index):
                pipeline_cls = getattr(diffusers, cls_name_from_index)
                logger.info(f"Detected pipeline class: {cls_name_from_index}")
            else:
                logger.warning(f"model_index.json says {cls_name_from_index} but not in diffusers")
        except Exception as e:
            logger.warning(f"Could not parse model_index.json: {e}")

    # 构建候选列表：检测到的类优先，然后是 DiffusionPipeline（从 model_index.json 自动检测）
    # 只有当模型名称暗示 Flux 时才尝试 Flux 特定的管道
    candidates = []
    if pipeline_cls:
        candidates.append((pipeline_cls, pipeline_cls.__name__))
    # DiffusionPipeline 读取 model_index.json 并自动选择正确的管道
    candidates.append((diffusers.DiffusionPipeline, "DiffusionPipeline"))
    # 仅当模型名称暗示 Flux 时，Flux 特定的回退方案
    _model_lower = Path(model_path).name.lower()
    if "flux" in _model_lower:
        for name in ("Flux2Pipeline", "FluxPipeline"):
            cls = getattr(diffusers, name, None)
            if cls and cls not in [c for c, _ in candidates]:
                candidates.append((cls, name))

    def _cleanup():
        import gc; gc.collect()
        try:
            torch.cuda.empty_cache()
            logger.debug("GPU cache cleared")
        except Exception as e:
            logger.debug(f"GPU cache clear failed: {e}")

    def _load_pipe(cls, name):
        """尝试加载管道，处理元张量问题。"""
        global _pipe

        # 首先尝试正常加载
        try:
            _pipe = cls.from_pretrained(model_path, torch_dtype=torch_dtype)
        except Exception as e:
            logger.warning(f"{name} from_pretrained failed: {e}")
            _pipe = None
            _cleanup()
            return False

        # 在移动到设备之前实现任何元张量
        _fix_meta_tensors(_pipe, torch_dtype)

        if use_offload:
            try:
                _pipe.enable_model_cpu_offload()
                logger.info(f"Loaded as {name} with CPU offload")
                return True
            except Exception as e:
                logger.warning(f"{name} + cpu_offload failed: {e}")
                _pipe = None
                _cleanup()
                return False

        # 尝试完整 CUDA
        try:
            _pipe = _pipe.to("cuda")
            logger.info(f"Loaded as {name} on CUDA")
            return True
        except Exception as e:
            logger.warning(f"{name} + .to(cuda) failed: {e}")
            _pipe = None
            _cleanup()

        if not use_offload:
            logger.error(f"{name} doesn't fit in VRAM. Use --cpu-offload to enable offloading.")
            return False

        # 显存不足 — 重新加载并尝试 CPU offload
        try:
            logger.info(f"Reloading {name} with CPU offload...")
            _pipe = cls.from_pretrained(model_path, torch_dtype=torch_dtype)
            _fix_meta_tensors(_pipe, torch_dtype)
            _pipe.enable_model_cpu_offload()
            logger.info(f"Loaded as {name} with CPU offload")
            return True
        except Exception as e:
            logger.warning(f"{name} + cpu_offload reload failed: {e}")
            _pipe = None
            _cleanup()

        # 最后手段 — 顺序 offload
        try:
            logger.info(f"Reloading {name} with sequential CPU offload...")
            _pipe = cls.from_pretrained(model_path, torch_dtype=torch_dtype)
            _fix_meta_tensors(_pipe, torch_dtype)
            _pipe.enable_sequential_cpu_offload()
            logger.info(f"Loaded as {name} with sequential CPU offload")
            return True
        except Exception as e:
            logger.warning(f"{name} + sequential offload failed: {e}")
            _pipe = None
            _cleanup()

        return False

    loaded = False
    for cls, name in candidates:
        if _load_pipe(cls, name):
            loaded = True
            break

    # 最后手段：覆盖未知的管道类
    if not loaded and cls_name_from_index and not hasattr(diffusers, cls_name_from_index):
        for fallback in ("Flux2Pipeline", "FluxPipeline", "StableDiffusionPipeline"):
            fb_cls = getattr(diffusers, fallback, None)
            if fb_cls and fb_cls not in [c for c, _ in candidates]:
                logger.info(f"Overriding {cls_name_from_index} -> {fallback}")
                if _load_pipe(fb_cls, fallback):
                    loaded = True
                    break

    # 最后手段：为原始 safetensors / ckpt 模型尝试 from_single_file
    if not loaded:
        # 查找单文件权重（优先 safetensors，然后是 ckpt/bin）
        single_file = None
        from huggingface_hub import hf_hub_download, list_repo_files
        # 检查是否是带单个 safetensors 文件的 HF repo
        try:
            files = list_repo_files(model_path)
            sf_files = [f for f in files if f.endswith('.safetensors') and '/' not in f]
            ckpt_files = [f for f in files if f.endswith(('.ckpt', '.bin')) and '/' not in f]
            target = sf_files[0] if sf_files else (ckpt_files[0] if ckpt_files else None)
            if target:
                logger.info(f"Downloading single file: {target}")
                single_file = hf_hub_download(model_path, target)
        except Exception as e:
            logger.warning(f"Could not list repo files for single-file fallback: {e}")
        # 也检查本地路径
        if not single_file:
            local_path = Path(model_path)
            if local_path.is_dir():
                for ext in ('.safetensors', '.ckpt', '.bin'):
                    matches = list(local_path.glob(f'*{ext}'))
                    if matches:
                        single_file = str(matches[0])
                        break
            elif local_path.is_file():
                single_file = str(local_path)

        if single_file:
            logger.info(f"Trying from_single_file with: {single_file}")
            # 从路径/文件名检测模型系列，优先选择正确的管道 + 配置
            _path_lower = (model_path + "/" + (single_file or "")).lower()
            _SD35_CONFIGS = ["stabilityai/stable-diffusion-3.5-large", "stabilityai/stable-diffusion-3.5-medium"]
            _SD3_CONFIGS = ["stabilityai/stable-diffusion-3-medium-diffusers"]
            _FLUX2_CONFIGS = ["black-forest-labs/FLUX.2-dev"]
            _FLUX_CONFIGS = ["black-forest-labs/FLUX.1-schnell", "black-forest-labs/FLUX.1-dev"]
            _SDXL_CONFIGS = ["stabilityai/stable-diffusion-xl-base-1.0"]

            # 基于模型名称提示构建有序的管道候选
            _pipeline_configs = []
            if "sd3.5" in _path_lower or "stable-diffusion-3.5" in _path_lower:
                _pipeline_configs.append(("StableDiffusion3Pipeline", _SD35_CONFIGS))
            elif "sd3" in _path_lower or "stable-diffusion-3" in _path_lower:
                _pipeline_configs.append(("StableDiffusion3Pipeline", _SD3_CONFIGS + _SD35_CONFIGS))
            elif "flux.2" in _path_lower or "flux2" in _path_lower:
                _pipeline_configs.append(("Flux2Pipeline", _FLUX2_CONFIGS))
                _pipeline_configs.append(("FluxPipeline", _FLUX_CONFIGS))
            elif "flux" in _path_lower:
                _pipeline_configs.append(("FluxPipeline", _FLUX_CONFIGS))
                _pipeline_configs.append(("Flux2Pipeline", _FLUX2_CONFIGS))
            elif "sdxl" in _path_lower or "xl" in _path_lower:
                _pipeline_configs.append(("StableDiffusionXLPipeline", _SDXL_CONFIGS))
            # 始终添加所有管道作为回退
            _pipeline_configs.extend([
                ("Flux2Pipeline", _FLUX2_CONFIGS),
                ("StableDiffusion3Pipeline", _SD35_CONFIGS + _SD3_CONFIGS),
                ("FluxPipeline", _FLUX_CONFIGS),
                ("StableDiffusionXLPipeline", _SDXL_CONFIGS + [None]),
                ("StableDiffusionPipeline", [None]),
            ])
            # 去重同时保持顺序
            _seen = set()
            _deduped = []
            for item in _pipeline_configs:
                if item[0] not in _seen:
                    _seen.add(item[0])
                    _deduped.append(item)
            _pipeline_configs = _deduped
            # 预下载配置文件（仅 json/txt），以便 from_single_file 不会出错
            def _ensure_config_local(repo_id):
                """仅从仓库下载配置文件，返回本地路径或 None。"""
                try:
                    from huggingface_hub import snapshot_download
                    local = snapshot_download(
                        repo_id,
                        allow_patterns=["*.json", "*.txt", "**/*.json", "**/*.txt"],
                        ignore_patterns=["*.safetensors", "*.bin", "*.ckpt", "*.pt", "*.msgpack", "*.h5", "*.onnx", "*.png", "*.jpg", "*.md"],
                        token=_hf_token,
                        local_files_only=False,
                    )
                    logger.info(f"Config files cached for {repo_id} at {local}")
                    return local
                except Exception as e1:
                    logger.warning(f"Could not download configs from {repo_id}: {e1}")
                    # 尝试不使用 allow_patterns（某些 hf_hub 版本在受限仓库上有过滤器 bug）
                    try:
                        from huggingface_hub import snapshot_download as _sd2
                        local = _sd2(
                            repo_id,
                            ignore_patterns=["*.safetensors", "*.bin", "*.ckpt", "*.pt", "*.msgpack", "*.h5", "*.onnx"],
                            token=_hf_token,
                            local_files_only=False,
                        )
                        logger.info(f"Config files cached (no filter) for {repo_id} at {local}")
                        return local
                    except Exception as e2:
                        logger.warning(f"Retry without allow_patterns also failed for {repo_id}: {e2}")
                        return None

            for cls_name, configs in _pipeline_configs:
                if loaded:
                    break
                cls = getattr(diffusers, cls_name, None)
                if not cls or not hasattr(cls, 'from_single_file'):
                    continue
                for config in configs:
                    try:
                        kwargs = {"torch_dtype": torch_dtype}
                        if config:
                            # 使用本地路径而不是 repo ID，这样 diffusers 不会重新下载
                            local_config = _ensure_config_local(config)
                            if not local_config:
                                continue
                            kwargs["config"] = local_config
                            logger.info(f"Trying {cls_name}.from_single_file with config={config}")
                        _pipe = cls.from_single_file(single_file, **kwargs)
                        _fix_meta_tensors(_pipe, torch_dtype)
                        if use_offload:
                            _pipe.enable_model_cpu_offload()
                            logger.info(f"Loaded as {cls_name} (single file, config={config}) with CPU offload")
                        else:
                            _pipe = _pipe.to("cuda")
                            logger.info(f"Loaded as {cls_name} (single file, config={config}) on CUDA")
                        loaded = True
                        break
                    except Exception as e:
                        logger.warning(f"{cls_name}.from_single_file (config={config}) failed: {e}")
                        _pipe = None
                        _cleanup()

    if not loaded:
        raise RuntimeError(f"Could not load model from {model_path}. Check diffusers version and model format.")

    # 内存优化
    if _args.attention_slicing:
        try:
            _pipe.enable_attention_slicing()
            logger.info("Attention slicing enabled")
        except Exception:
            pass
    if _args.vae_slicing:
        try:
            _pipe.enable_vae_slicing()
            logger.info("VAE slicing enabled")
        except Exception:
            pass

    logger.info(f"Model loaded: {_model_id}")

    # 如果指定了 LoRA 权重，加载它们
    if _args.lora:
        for lora_path in _args.lora.split(','):
            lora_path = lora_path.strip()
            if not lora_path:
                continue
            try:
                lora_name = Path(lora_path).stem
                _pipe.load_lora_weights(lora_path, adapter_name=lora_name)
                logger.info(f"Loaded LoRA: {lora_name} from {lora_path}")
            except Exception as e:
                logger.warning(f"Failed to load LoRA {lora_path}: {e}")
        # 设置 LoRA scale
        try:
            _pipe.set_adapters([Path(p.strip()).stem for p in _args.lora.split(',') if p.strip()],
                              adapter_weights=[_args.lora_scale] * len([p for p in _args.lora.split(',') if p.strip()]))
            logger.info(f"LoRA scale set to {_args.lora_scale}")
        except Exception as e:
            logger.debug(f"Could not set adapter weights: {e}")


@app.get("/v1/models")
def list_models():
    return {
        "data": [
            {
                "id": _model_id,
                "object": "model",
                "owned_by": "local",
            }
        ]
    }


@app.post("/v1/images/generations")
def generate_image(req: ImageRequest):
    if _pipe is None:
        return {"error": "Model not loaded"}

    # 解析尺寸
    try:
        w, h = req.size.split("x")
        width, height = int(w), int(h)
    except Exception:
        width, height = _args.width, _args.height

    # 将 quality 映射到 num_inference_steps
    default_steps = _args.steps or 8
    steps_map = {"low": 4, "medium": default_steps, "high": 20, "auto": 12}
    steps = steps_map.get(req.quality, default_steps)

    logger.info(f"Generating: {req.prompt[:80]}... ({width}x{height}, {steps} steps)")
    start = time.time()

    # 检测管道是否是仅 inpaint（需要 image + mask）
    _is_inpaint_pipe = 'inpaint' in type(_pipe).__name__.lower()

    images = []
    for _ in range(req.n):
        if _is_inpaint_pipe:
            # Inpaint 管道需要 image + mask — 为 txt2img 创建空白图像
            from PIL import Image as _PILGen
            _blank = _PILGen.new('RGB', (width, height), (128, 128, 128))
            _mask = _PILGen.new('L', (width, height), 255)  # 全部白色 = 重新生成所有内容
            result = _pipe(
                prompt=req.prompt,
                image=_blank,
                mask_image=_mask,
                width=width,
                height=height,
                num_inference_steps=steps,
                guidance_scale=3.5,
            )
        else:
            result = _pipe(
                prompt=req.prompt,
                width=width,
                height=height,
                num_inference_steps=steps,
                guidance_scale=3.5,
            )
        img = result.images[0]

        # 转换为 base64
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        images.append({"b64_json": b64})

    elapsed = time.time() - start
    logger.info(f"Generated {req.n} image(s) in {elapsed:.1f}s")

    return {
        "created": int(time.time()),
        "data": images,
    }


class InpaintRequest(BaseModel):
    image: str  # base64 PNG
    mask: str   # base64 PNG（白色 = 修复区域）
    prompt: str
    width: int = 0
    height: int = 0
    steps: int = 0
    strength: float = 0.75  # 改变的幅度（0=不变，1=完全重新生成）
    feather: int = 8  # 遮罩边缘羽化，以像素为单位


_inpaint_pipe = None
_img2img_pipe = None

def _get_inpaint_pipe():
    """从同一模型延迟加载 inpaint 或 img2img 管道。"""
    global _inpaint_pipe, _img2img_pipe
    if _inpaint_pipe:
        return _inpaint_pipe, 'inpaint'
    if _img2img_pipe:
        return _img2img_pipe, 'img2img'

    import diffusers
    model_path = _args.model
    torch_dtype = DTYPE_MAP.get(_args.dtype, torch.bfloat16)

    # 检查主管道是否已经是 inpaint 管道
    pipe_cls_name = type(_pipe).__name__
    if 'inpaint' in pipe_cls_name.lower():
        _inpaint_pipe = _pipe
        logger.info(f"Main pipeline is already inpaint: {pipe_cls_name}")
        # 也尝试从中获取 img2img
        try:
            img2img_cls_name = pipe_cls_name.replace('Inpaint', 'Img2Img')
            img2img_cls = getattr(diffusers, img2img_cls_name, None)
            if img2img_cls:
                _img2img_pipe = img2img_cls.from_pipe(_pipe)
                logger.info(f"Also loaded img2img from inpaint pipe: {img2img_cls_name}")
        except Exception as e:
            logger.debug(f"Could not create img2img from inpaint: {e}")
        return _inpaint_pipe, 'inpaint'

    # 尝试从相同组件加载专用的 inpaint 管道
    inpaint_names = [
        pipe_cls_name.replace('Pipeline', 'InpaintPipeline'),
        'StableDiffusion3InpaintPipeline',
        'StableDiffusionXLInpaintPipeline',
        'StableDiffusionInpaintPipeline',
    ]
    for name in inpaint_names:
        cls = getattr(diffusers, name, None)
        if cls:
            try:
                _inpaint_pipe = cls.from_pipe(_pipe)
                logger.info(f"Loaded inpaint pipeline: {name}")
                return _inpaint_pipe, 'inpaint'
            except Exception as e:
                logger.debug(f"{name} from_pipe failed: {e}")

    # 尝试 img2img 管道
    img2img_names = [
        pipe_cls_name.replace('Pipeline', 'Img2ImgPipeline'),
        'StableDiffusion3Img2ImgPipeline',
        'StableDiffusionXLImg2ImgPipeline',
        'StableDiffusionImg2ImgPipeline',
    ]
    torch_dtype = DTYPE_MAP.get(_args.dtype, torch.bfloat16)
    harmonize_gpu = _args.harmonize_gpu
    for name in img2img_names:
        cls = getattr(diffusers, name, None)
        if cls:
            try:
                if harmonize_gpu is not None:
                    # 在单独的 GPU 上重新加载
                    logger.info(f"Loading {name} on cuda:{harmonize_gpu}...")
                    _img2img_pipe = cls.from_pretrained(_args.model, torch_dtype=torch_dtype)
                    _img2img_pipe = _img2img_pipe.to(f"cuda:{harmonize_gpu}")
                else:
                    _img2img_pipe = cls.from_pipe(_pipe, torch_dtype=torch_dtype)
                logger.info(f"Loaded img2img pipeline: {name}" + (f" on cuda:{harmonize_gpu}" if harmonize_gpu is not None else ""))
                return _img2img_pipe, 'img2img'
            except Exception as e:
                logger.debug(f"{name} failed: {e}")
                try:
                    # 某些管道需要 from_pretrained 而不是 from_pipe
                    _img2img_pipe = cls.from_pretrained(_args.model, torch_dtype=torch_dtype)
                    if _args.cpu_offload:
                        _img2img_pipe.enable_model_cpu_offload()
                    else:
                        _img2img_pipe = _img2img_pipe.to("cuda")
                    logger.info(f"Loaded img2img pipeline (from_pretrained): {name}")
                    return _img2img_pipe, 'img2img'
                except Exception as e2:
                    logger.debug(f"{name} from_pretrained also failed: {e2}")

    logger.warning("No inpaint or img2img pipeline available — will use txt2img fallback")
    return None, None


@app.post("/v1/images/inpaint")
def inpaint_image(req: InpaintRequest):
    """对遮罩区域进行修复。尝试：原生 inpaint → img2img+合成 → txt2img+合成。"""
    if _pipe is None:
        return {"error": "Model not loaded"}

    from PIL import Image as PILImage

    # 解码输入图像和遮罩
    img_bytes = base64.b64decode(req.image)
    mask_bytes = base64.b64decode(req.mask)
    init_image = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
    mask_image = PILImage.open(io.BytesIO(mask_bytes)).convert("L")

    # 羽化值 — 在裁剪后应用以避免边缘裁剪
    feather = max(0, min(60, req.feather))

    width = req.width or init_image.width
    height = req.height or init_image.height

    default_steps = _args.steps or 12
    steps = req.steps or default_steps

    logger.info(f"Inpainting: {req.prompt[:80]}... ({width}x{height}, {steps} steps)")
    start = time.time()

    strength = max(0.1, min(1.0, req.strength))

    # 尝试获取专用的 inpaint 或 img2img 管道
    alt_pipe, alt_type = _get_inpaint_pipe()

    # SDXL inpaint 期望短边约 1024。在画布原生分辨率运行可能会
    # 产生灰色/暗淡的输出，当模型的潜在网格远大于训练时。
    # 限制在模型友好的尺寸（8 的倍数），在此修复，然后放大回去。
    max_side = 1024
    scale = min(max_side / max(width, height), 1.0)
    work_w = max(64, ((int(width  * scale) + 7) // 8) * 8)
    work_h = max(64, ((int(height * scale) + 7) // 8) * 8)
    work_init = init_image.resize((work_w, work_h), PILImage.LANCZOS)
    work_mask = mask_image.resize((work_w, work_h), PILImage.BILINEAR)
    logger.info(f"Inpaint working size: {work_w}x{work_h} (from {width}x{height})")

    # SDXL VAE 在 fp16/bfloat16 下通常会产生 NaN/溢出，
    # 解码为纯灰色输出。在调用前将 VAE 升格到 fp32；
    # 成本低廉（仅 VAE 解码运行在 fp32，重量级 UNet
    # 保持在请求的 dtype）。每个管道一次。
    if alt_pipe is not None and not getattr(alt_pipe, '_ge_vae_upcast', False):
        try:
            alt_pipe.upcast_vae()
            alt_pipe._ge_vae_upcast = True
            logger.info("Upcast VAE to fp32 to avoid grey-output bug")
        except Exception as e:
            logger.warning(f"Could not upcast VAE: {e}")

    try:
        if alt_type == 'inpaint' and alt_pipe:
            # 使用专用 inpaint 管道。guidance_scale 7.5 是
            # SDXL 默认值 — 之前的 3.5 产生了暗淡/灰色的
            # 结果，尤其是在有大型遮罩的风格迁移提示上。
            logger.info("Using dedicated inpaint pipeline")
            result = alt_pipe(
                prompt=req.prompt,
                image=work_init,
                mask_image=work_mask,
                width=work_w,
                height=work_h,
                num_inference_steps=steps,
                strength=strength,
                guidance_scale=7.5,
            )
        elif alt_type == 'img2img' and alt_pipe:
            raise TypeError("Skip to img2img fallback")
        else:
            # 尝试使用带 inpaint 参数的主管
            result = _pipe(
                prompt=req.prompt,
                image=work_init,
                mask_image=work_mask,
                width=work_w,
                height=work_h,
                num_inference_steps=steps,
                strength=strength,
                guidance_scale=7.5,
            )
    except TypeError:
        # 管道不支持原生修复 — 使用裁剪到遮罩 + img2img + 合成
        # 这通过仅重新生成带有周围填充的遮罩区域来保留上下文
        import numpy as np
        logger.info(f"Pipeline doesn't support inpainting — using crop+img2img (strength={strength}) + composite")

        mask_resized = mask_image.resize((width, height))
        init_resized = init_image.resize((width, height))
        mask_arr = np.array(mask_resized)

        # 查找遮罩的边界框
        ys, xs = np.where(mask_arr > 10)
        if len(xs) == 0 or len(ys) == 0:
            logger.warning("Empty mask — returning original image")
            buf = io.BytesIO()
            init_resized.save(buf, format="PNG")
            return {"image": base64.b64encode(buf.getvalue()).decode(), "elapsed": 0}

        x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())

        # 添加充足的填充（遮罩大小的 50%，最少 64px），以便模型看到周围的上下文
        pad_x = max(64, int((x2 - x1) * 0.5))
        pad_y = max(64, int((y2 - y1) * 0.5))
        cx1 = max(0, x1 - pad_x)
        cy1 = max(0, y1 - pad_y)
        cx2 = min(width, x2 + pad_x)
        cy2 = min(height, y2 + pad_y)

        # 使裁剪为方形并四舍五入到 64 的倍数（SD3 VAE 要求）
        crop_size = max(cx2 - cx1, cy2 - cy1)
        crop_size = max(256, ((crop_size + 63) // 64) * 64)  # min 256, 向上取整到 64
        # 将方形裁剪居中于遮罩中心
        cx_mid = (cx1 + cx2) // 2
        cy_mid = (cy1 + cy2) // 2
        cx1 = max(0, cx_mid - crop_size // 2)
        cy1 = max(0, cy_mid - crop_size // 2)
        cx2 = min(width, cx1 + crop_size)
        cy2 = min(height, cy1 + crop_size)
        # 如果碰到图像边缘则调整
        if cx2 - cx1 < crop_size:
            cx1 = max(0, cx2 - crop_size)
        if cy2 - cy1 < crop_size:
            cy1 = max(0, cy2 - crop_size)
        cw = cx2 - cx1
        ch = cy2 - cy1

        logger.info(f"Mask bbox: ({x1},{y1})-({x2},{y2}), crop region: ({cx1},{cy1})-({cx2},{cy2}) = {cw}x{ch}")

        # 将原始图像和遮罩裁剪到该区域
        crop_img = init_resized.crop((cx1, cy1, cx2, cy2))
        crop_mask = mask_resized.crop((cx1, cy1, cx2, cy2))

        # 如果有 img2img 管道则使用，否则回退
        _i2i_pipe = alt_pipe if alt_type == 'img2img' else None
        # 确保裁剪图像的尺寸正确（8 的倍数）
        crop_img = crop_img.resize((cw, ch))
        try:
            if _i2i_pipe:
                logger.info(f"Using img2img pipeline on crop ({cw}x{ch})")
                result = _i2i_pipe(
                    prompt=req.prompt,
                    image=crop_img,
                    num_inference_steps=steps,
                    strength=strength,
                    guidance_scale=7.0,
                )
            else:
                # 尝试使用带 image 参数的主管
                result = _pipe(
                    prompt=req.prompt,
                    image=crop_img,
                    num_inference_steps=steps,
                    strength=strength,
                    guidance_scale=3.5,
                )
            generated_crop = result.images[0].resize((cw, ch))
        except TypeError:
            # 完全没有 img2img 支持 — 在裁剪尺寸上使用 txt2img
            logger.info("No img2img support — txt2img on crop region")
            result = _pipe(
                prompt=req.prompt,
                width=cw,
                height=ch,
                num_inference_steps=steps,
                guidance_scale=3.5,
            )
            generated_crop = result.images[0].resize((cw, ch))

        # 对裁剪的遮罩应用羽化以实现软边缘混合
        if feather > 0:
            from PIL import ImageFilter
            # PIL GaussianBlur 半径约为 CSS 模糊像素的一半，所以乘以
            blur_radius = feather * 1.5
            crop_mask = crop_mask.filter(ImageFilter.GaussianBlur(radius=blur_radius))
            logger.info(f"Applied {feather}px feather (PIL radius={blur_radius:.0f}) to crop mask")

        # 合成：使用羽化遮罩将生成的裁剪混合到原始图像中
        orig_arr = np.array(init_resized).astype(float)
        gen_full = orig_arr.copy()
        crop_gen_arr = np.array(generated_crop).astype(float)
        crop_mask_arr = np.array(crop_mask) / 255.0

        # 仅在裁剪区域内混合
        region = gen_full[cy1:cy2, cx1:cx2]
        blended_region = region * (1 - crop_mask_arr[:, :, None]) + crop_gen_arr * crop_mask_arr[:, :, None]
        gen_full[cy1:cy2, cx1:cx2] = blended_region

        result_img = PILImage.fromarray(gen_full.astype(np.uint8))

        buf = io.BytesIO()
        result_img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        elapsed = time.time() - start
        logger.info(f"Inpaint (crop+composite) done in {elapsed:.1f}s")
        return {"image": b64, "elapsed": round(elapsed, 2)}

    img = result.images[0]
    # 如果我们在较小的分辨率下工作，则放大回画布大小。
    if (img.width, img.height) != (width, height):
        img = img.resize((width, height), PILImage.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    elapsed = time.time() - start
    logger.info(f"Inpaint done in {elapsed:.1f}s")
    return {"image": b64, "elapsed": round(elapsed, 2)}


class HarmonizeRequest(BaseModel):
    image: str  # base64 PNG
    prompt: str
    # 两阶段协调：
    #   1) 在 `body_mask` 内的 Reinhard 颜色迁移（将遮罩区域的 L*a*b* 均值/标准差
    #      匹配到未遮罩的周围环境）。像素级精确。
    #   2) 在 `seam_mask`（alpha 边缘带）上可选窄修复，以修复
    #      锯齿状的剪切和接缝。仅重新生成边缘带。
    color_match: float = 0.65  # 0..1 — 应用颜色偏移的比例
    seam_fix: float = 0.0      # 0..1 — 接缝修复通道的强度
    body_mask: str | None = None  # base64 PNG, 白色 = 图层体
    seam_mask: str | None = None  # base64 PNG, 白色 = 图层 alpha 边缘带
    steps: int = 0
    # Legacy fields (older clients): if `mask` is sent without body/seam,
    # we treat it as body_mask. `strength` maps to color_match.
    mask: str | None = None
    strength: float | None = None
    max_side: int = 1024


def _rgb_to_lalphabeta(rgb_f):
    """RGB → L*alpha*beta (Ruderman et al., Reinhard 原始论文使用的色彩空间)。
    纯 numpy — 无 cv2。输入/输出：形状为 (..., 3) 的 float32 数组；
    输入在 0..255 范围内，输出无界 log-RGB 风格。"""
    import numpy as np
    eps = 1.0
    # 线性化到 LMS 锥体空间
    M_rgb2lms = np.array([
        [0.3811, 0.5783, 0.0402],
        [0.1967, 0.7244, 0.0782],
        [0.0241, 0.1288, 0.8444],
    ], dtype=np.float32)
    lms = rgb_f @ M_rgb2lms.T
    lms = np.log(np.maximum(lms, eps))
    # LMS → L*alpha*beta
    M_lms2lab = np.array([
        [1.0/np.sqrt(3),  1.0/np.sqrt(3),  1.0/np.sqrt(3)],
        [1.0/np.sqrt(6),  1.0/np.sqrt(6), -2.0/np.sqrt(6)],
        [1.0/np.sqrt(2), -1.0/np.sqrt(2),  0.0          ],
    ], dtype=np.float32)
    return lms @ M_lms2lab.T


def _lalphabeta_to_rgb(lab):
    """_rgb_to_lalphabeta 的逆。返回 0..255（裁剪后）的 RGB float32。"""
    import numpy as np
    M_lab2lms = np.array([
        [np.sqrt(3)/3.0,  np.sqrt(6)/6.0,  np.sqrt(2)/2.0],
        [np.sqrt(3)/3.0,  np.sqrt(6)/6.0, -np.sqrt(2)/2.0],
        [np.sqrt(3)/3.0, -np.sqrt(6)/3.0,  0.0          ],
    ], dtype=np.float32)
    lms = lab @ M_lab2lms.T
    lms = np.exp(lms)
    M_lms2rgb = np.array([
        [ 4.4679, -3.5873,  0.1193],
        [-1.2186,  2.3809, -0.1624],
        [ 0.0497, -0.2439,  1.2045],
    ], dtype=np.float32)
    rgb = lms @ M_lms2rgb.T
    return np.clip(rgb, 0, 255)


def _reinhard_color_transfer(source_rgb, body_mask_l, blend: float = 1.0):
    """使用 Reinhard 的 L*alpha*beta 迁移将遮罩区域的颜色统计
    匹配到未遮罩的周围环境。纯 numpy。

    `blend`（0..1）控制应用偏移的比例。
    """
    import numpy as np
    from PIL import Image as _PILImg

    src_np = np.asarray(source_rgb).astype(np.float32)  # H,W,3 在 0..255 范围内
    h, w, _ = src_np.shape

    mask_np = np.asarray(body_mask_l).astype(np.float32) / 255.0
    if mask_np.shape != (h, w):
        return source_rgb

    interior = mask_np > 0.5
    exterior = mask_np < 0.05
    if interior.sum() < 100 or exterior.sum() < 100:
        return source_rgb

    lab = _rgb_to_lalphabeta(src_np)
    in_pix = lab[interior]
    out_pix = lab[exterior]

    in_mean, in_std = in_pix.mean(axis=0), in_pix.std(axis=0) + 1e-6
    out_mean, out_std = out_pix.mean(axis=0), out_pix.std(axis=0) + 1e-6

    shifted = lab.copy()
    shifted[interior] = (lab[interior] - in_mean) * (out_std / in_std) + out_mean
    rgb_shifted = _lalphabeta_to_rgb(shifted)

    # 通过遮罩 × blend 在源和偏移之间进行线性插值，使遮罩边缘
    # 平滑渐变回源。
    m3 = (mask_np * blend)[..., None]
    out = src_np * (1 - m3) + rgb_shifted * m3
    return _PILImg.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode='RGB')


def _decode_mask_b64(b64_str, target_size):
    """解码 base64 编码的灰度 PNG。返回目标尺寸的 PIL 'L' 图像，
    如果为空/无效则返回 None。"""
    if not b64_str:
        return None
    try:
        from PIL import Image as _PILImg
        m = _PILImg.open(io.BytesIO(base64.b64decode(b64_str))).convert("L")
        if m.size != target_size:
            m = m.resize(target_size, _PILImg.BILINEAR)
        if not m.getbbox():
            return None
        return m
    except Exception as e:
        logger.warning(f"Harmonize: bad mask: {e}")
        return None


@app.post("/v1/images/harmonize")
def harmonize_image(req: HarmonizeRequest):
    """两阶段图层协调。

    阶段 1 — 在 `body_mask` 内进行 Reinhard 颜色迁移：将遮罩区域的
    L*a*b* 均值/标准差匹配到未遮罩的周围环境。像素级精确，
    无模型重新生成。由 `color_match`（0..1）控制。

    阶段 2 — 在 `seam_mask`（alpha 边缘带）上可选窄修复：
    仅重新生成带；图层内部与颜色偏移结果保持完全一致。
    由 `seam_fix`（0..1）控制。如果 `seam_fix=0` 或无修复管道可用，则跳过。

    向后兼容：如果只提供了 `mask`（没有 body/seam），
    将其视为 body_mask。`strength`（旧字段）映射到 `color_match`。
    """
    if _pipe is None:
        return {"error": "Model not loaded"}

    from PIL import Image as PILImage

    img_bytes = base64.b64decode(req.image)
    source_full = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
    orig_w, orig_h = source_full.size

    # 解析新旧字段名。
    body_b64 = req.body_mask or req.mask
    seam_b64 = req.seam_mask
    color_match = req.color_match
    if req.strength is not None:
        color_match = req.strength
    color_match = max(0.0, min(1.0, color_match))
    seam_fix = max(0.0, min(1.0, req.seam_fix))

    body_mask_full = _decode_mask_b64(body_b64, (orig_w, orig_h))
    seam_mask_full = _decode_mask_b64(seam_b64, (orig_w, orig_h))

    # 如果两个遮罩都没有提供：旧版全图回退。用户没有告诉我们
    # 接缝在哪里，所以我们不能进行有针对性的混合。
    if body_mask_full is None and seam_mask_full is None:
        logger.info("Harmonize: no masks — falling back to legacy whole-image path")
        return _legacy_whole_image_harmonize(req, source_full)

    logger.info(
        f"Harmonize: color_match={color_match:.2f} seam_fix={seam_fix:.2f} "
        f"body_mask={'y' if body_mask_full else 'n'} seam_mask={'y' if seam_mask_full else 'n'}"
    )
    start = time.time()

    # ── 阶段 1: Reinhard 颜色迁移（像素级精确，无重新生成）──
    if body_mask_full is not None and color_match > 0.01:
        try:
            stage1 = _reinhard_color_transfer(source_full, body_mask_full, blend=color_match)
        except Exception as e:
            logger.warning(f"Harmonize stage 1 failed, skipping: {e}")
            stage1 = source_full
    else:
        stage1 = source_full

    # ── 阶段 2: 窄接缝修复（仅 alpha 边缘带）──
    final = stage1
    if seam_mask_full is not None and seam_fix > 0.01:
        alt_pipe, alt_type = _get_inpaint_pipe()
        is_inpaint_main = 'inpaint' in type(_pipe).__name__.lower()
        inpaint_pipe = alt_pipe if alt_type == 'inpaint' else (_pipe if is_inpaint_main else None)
        if inpaint_pipe is None:
            logger.info("Harmonize: seam_fix requested but no inpaint pipe — skipping stage 2")
        else:
            try:
                max_side = req.max_side or 1024
                scale = min(max_side / orig_w, max_side / orig_h, 1.0)
                w = ((int(orig_w * scale) + 63) // 64) * 64
                h = ((int(orig_h * scale) + 63) // 64) * 64
                init_small = stage1.resize((w, h), PILImage.LANCZOS)
                seam_small = seam_mask_full.resize((w, h), PILImage.BILINEAR)
                # 限制修复强度 — seam_fix=1.0 → strength=0.50,
                # 因此即使最大设置也不能完全重绘带。
                inpaint_strength = max(0.10, min(0.50, seam_fix * 0.50))
                steps = req.steps or (_args.steps or 12)
                logger.info(f"Harmonize stage 2: seam inpaint at {w}x{h}, strength={inpaint_strength:.2f}")
                result = inpaint_pipe(
                    prompt=req.prompt,
                    image=init_small,
                    mask_image=seam_small,
                    width=w,
                    height=h,
                    num_inference_steps=max(steps, 20),
                    strength=inpaint_strength,
                    guidance_scale=7.0,
                )
                ai_small = result.images[0]
                ai_full = ai_small.resize((orig_w, orig_h), PILImage.LANCZOS) if (w, h) != (orig_w, orig_h) else ai_small
                # 使用接缝遮罩作为 alpha 进行合成 — 接缝带之外
                # 的区域与阶段 1 保持像素级一致。
                final = PILImage.composite(ai_full, stage1, seam_mask_full)
            except Exception as e:
                logger.warning(f"Harmonize stage 2 failed, returning stage 1 only: {e}")
                final = stage1

    buf = io.BytesIO()
    final.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    elapsed = time.time() - start
    logger.info(f"Harmonize done in {elapsed:.1f}s")
    return {"image": b64, "elapsed": round(elapsed, 2)}


def _legacy_whole_image_harmonize(req, source_full):
    """旧行为：没有提供遮罩 → 在整个图像上运行 img2img。
    保留用于客户端想要全局重新渲染的情况。"""
    from PIL import Image as PILImage

    orig_w, orig_h = source_full.size
    max_side = req.max_side or 1024
    scale = min(max_side / orig_w, max_side / orig_h, 1.0)
    width = ((int(orig_w * scale) + 63) // 64) * 64
    height = ((int(orig_h * scale) + 63) // 64) * 64
    init_image = source_full.resize((width, height), PILImage.LANCZOS)
    steps = req.steps or (_args.steps or 12)
    strength = req.strength if req.strength is not None else 0.30
    strength = max(0.1, min(0.9, strength))

    alt_pipe, alt_type = _get_inpaint_pipe()
    i2i_pipe = _img2img_pipe if _img2img_pipe else (alt_pipe if alt_type == 'img2img' else None)

    start = time.time()
    try:
        if i2i_pipe:
            result = i2i_pipe(
                prompt=req.prompt, image=init_image,
                num_inference_steps=steps, strength=strength, guidance_scale=7.0,
            )
        else:
            result = _pipe(
                prompt=req.prompt, image=init_image,
                num_inference_steps=steps, strength=strength, guidance_scale=7.0,
            )
    except TypeError:
        result = _pipe(
            prompt=req.prompt, width=width, height=height,
            num_inference_steps=steps, guidance_scale=7.0,
        )

    img = result.images[0]
    if (orig_w, orig_h) != (width, height):
        img = img.resize((orig_w, orig_h), PILImage.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    elapsed = time.time() - start
    logger.info(f"Legacy harmonize done in {elapsed:.1f}s")
    return {"image": b64, "elapsed": round(elapsed, 2)}


@app.get("/health")
def health():
    return {"status": "ok", "model": _model_id}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Path to diffusers model")
    parser.add_argument("--lora", type=str, default=None, help="Path to LoRA weights (.safetensors). Can specify multiple comma-separated.")
    parser.add_argument("--lora-scale", type=float, default=1.0, help="LoRA weight scale (0.0-2.0)")
    parser.add_argument("--port", type=int, default=8100)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"])
    parser.add_argument("--device-map", default=None, help="Device map strategy (unused, kept for compat)")
    parser.add_argument("--steps", type=int, default=0, help="Default inference steps (0=auto)")
    parser.add_argument("--width", type=int, default=1024, help="Default output width")
    parser.add_argument("--height", type=int, default=1024, help="Default output height")
    parser.add_argument("--cpu-offload", action="store_true", help="Enable model CPU offload")
    parser.add_argument("--attention-slicing", action="store_true", help="Enable attention slicing")
    parser.add_argument("--vae-slicing", action="store_true", help="Enable VAE slicing")
    parser.add_argument("--harmonize-gpu", type=int, default=None, help="GPU index for harmonize/img2img (default: same as main)")
    parser.add_argument("--allowed-host", action="append", default=[],
        help="Additional Host header value to accept (DNS-rebinding allowlist). "
             "Can be repeated. Loopback values are always included.")
    parser.add_argument("--allowed-origin", action="append", default=[],
        help="Additional CORS origin to allow. Can be repeated. Defaults to "
             "no cross-origin access — only pass this if you need a browser "
             "on a specific origin to call the server.")
    _args = parser.parse_args()

    # 将模块加载时的中间件栈替换为 CLI 配置的栈，以便
    # 操作员提供的 --allowed-host / --allowed-origin 值在第一个请求
    # 被服务之前生效。user_middleware 在第一个请求构建中间件栈时
    # 被惰性查询，因此在这里修改它是安全的。
    final_hosts = _compute_allowed_hosts(_args.host, _args.allowed_host)
    final_origins = _compute_cors_origins(_args.allowed_origin)
    _configure_security_middleware(app, final_hosts, final_origins)
    logger.info("security middleware: allowed_hosts=%s allowed_origins=%s",
                final_hosts, final_origins or "(none — default-deny)")

    app.state.model_path = _args.model
    uvicorn.run(app, host=_args.host, port=_args.port)
