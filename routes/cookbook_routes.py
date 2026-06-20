"""Cookbook 路由 — 模型下载、服务、缓存扫描和 cookbook 状态同步。"""

import asyncio
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Depends

from src.auth_helpers import require_user
from src.constants import COOKBOOK_STATE_FILE
from pydantic import BaseModel

from core.middleware import require_admin
from routes._validators import validate_remote_host, validate_ssh_port
from core.platform_compat import (
    IS_WINDOWS,
    detached_popen_kwargs,
    find_bash,
    kill_process_tree,
    pid_alive,
    safe_chmod,
    which_tool,
)
from routes.shell_routes import TMUX_LOG_DIR
from routes.cookbook_output import (
    error_aware_output_tail, classify_dead_download,
    HF_CACHE_COMPLETE_PROBE, HF_CACHE_INCOMPLETE_PROBE,
)

logger = logging.getLogger(__name__)

from routes.cookbook_helpers import (
    _SESSION_ID_RE, _validate_repo_id, _validate_serve_model_id, _validate_include, _validate_token,
    _validate_local_dir, _validate_gpus, _shell_path,
    _ps_squote, _bash_squote, _validate_serve_cmd, _parse_serve_phase,
    _safe_env_prefix, _local_tooling_path_export, _append_serve_preflight_exit_lines,
    _append_serve_exit_code_lines, _append_llama_cpp_linux_accel_build_lines, _cached_model_scan_script,
    load_stored_hf_token,
    _append_vllm_linux_preflight_lines, _ollama_bind_from_cmd, _pip_install_fallback_chain,
    _pip_install_no_cache, _user_shell_path_bootstrap, _venv_safe_local_pip_install_cmd,
    _diagnose_serve_output, run_ssh_command_async,
    _ollama_bind_from_cmd, _pip_install_fallback_chain, _pip_install_no_cache,
    _user_shell_path_bootstrap, _venv_safe_local_pip_install_cmd,
    _normalize_llama_cpp_python_cache_types,
    ModelDownloadRequest, ServeRequest,
)

_HF_TOKEN_STATUS_SNIPPET = (
    'if [ -n "$HF_TOKEN" ]; then '
    'echo "[odysseus] HF token: applied"; '
    'else '
    'echo "[odysseus] HF token: NOT SET — gated/private models will be denied. '
    'Add one in Odysseus Cookbook -> Settings -> HuggingFace Token."; '
    'fi'
)

def setup_cookbook_routes() -> APIRouter:
    router = APIRouter(tags=["cookbook"])
    _cookbook_state_path = Path(COOKBOOK_STATE_FILE)

    def _mask_secret(value: str) -> str:
        if not value:
            return ""
        if len(value) <= 8:
            return "stored"
        return f"{value[:4]}...{value[-4:]}"

    def _decrypt_secret(value: str | None) -> str:
        if not value:
            return ""
        from src.secret_storage import decrypt
        return decrypt(value)

    def _encrypt_secret(value: str) -> str:
        from src.secret_storage import encrypt
        return encrypt(value)

    def _strip_task_secrets(state):
        tasks = state.get("tasks") if isinstance(state, dict) else None
        if isinstance(tasks, list):
            for task in tasks:
                if isinstance(task, dict) and isinstance(task.get("payload"), dict):
                    task["payload"].pop("hf_token", None)
        return state

    def _diagnose_serve_output(text: str) -> dict | None:
        """服务端镜像 Cookbook UI 的常见服务诊断信息。

        浏览器使用 cookbook-diagnosis.js 提供可点击的修复方案。这里给 agent/工具
        路径提供相同的结构化信号，使其可以用调整后的命令重试，而不必从原始 tmux
        输出中猜测。
        """
        if not text:
            return None
        tail = text[-6000:]
        patterns = [
            (
                r"No available memory for the cache blocks|Available KV cache memory:.*-",
                "No GPU memory left for KV cache after loading model.",
                [
                    {"label": "retry with GPU memory utilization 0.95", "op": "replace", "flag": "--gpu-memory-utilization", "value": "0.95"},
                    {"label": "retry with context 2048", "op": "replace", "flag": "--max-model-len", "value": "2048"},
                ],
            ),
            (
                r"CUDA out of memory|torch\.cuda\.OutOfMemoryError|CUDA error: out of memory|warming up sampler|max_num_seqs.*gpu_memory_utilization",
                "GPU ran out of memory during startup or warmup.",
                [
                    {"label": "retry with context 4096", "op": "replace", "flag": "--max-model-len", "value": "4096"},
                    {"label": "retry with GPU memory utilization 0.80", "op": "replace", "flag": "--gpu-memory-utilization", "value": "0.80"},
                    {"label": "retry with --enforce-eager", "op": "append", "arg": "--enforce-eager"},
                ],
            ),
            (
                r"not divisib|must be divisible|attention heads.*divisible",
                "Tensor parallel size is incompatible with the model.",
                [
                    {"label": "retry with tensor parallel size 1", "op": "replace", "flag": "--tensor-parallel-size", "value": "1"},
                    {"label": "retry with tensor parallel size 2", "op": "replace", "flag": "--tensor-parallel-size", "value": "2"},
                ],
            ),
            (
                r"KV cache.*too (small|large)|max_model_len.*exceeds|maximum.*context",
                "Context length is too large for available GPU memory.",
                [
                    {"label": "retry with context 8192", "op": "replace", "flag": "--max-model-len", "value": "8192"},
                    {"label": "retry with context 4096", "op": "replace", "flag": "--max-model-len", "value": "4096"},
                ],
            ),
            (
                r"enable-auto-tool-choice requires --tool-call-parser",
                "Auto tool choice requires an explicit tool call parser.",
                [{"label": "retry with Hermes tool parser", "op": "append", "arg": "--tool-call-parser hermes"}],
            ),
            (
                r"Please pass.*trust.remote.code=True|contains custom code which must be executed to correctly load|does not recognize this architecture|model type.*but Transformers does not",
                "Model requires custom code or newer model support.",
                [{"label": "retry with --trust-remote-code", "op": "append", "arg": "--trust-remote-code"}],
            ),
            (
                r"Either a revision or a version must be specified|transformers\.integrations\.hub_kernels|kernels/layer",
                "vLLM/Transformers kernel package mismatch.",
                [{"label": "update vLLM, Transformers, and kernels on this server", "op": "dependency", "package": "vllm transformers kernels"}],
            ),
            (
                r"Address already in use|bind.*address.*in use",
                "Port is already in use.",
                [{"label": "retry on port 8001", "op": "replace", "flag": "--port", "value": "8001"}],
            ),
            (
                r"No CUDA GPUs are available|no GPU.*found|CUDA_VISIBLE_DEVICES.*invalid",
                "No GPUs are visible to the serve process.",
                [{"label": "clear Cookbook GPU selection or choose available GPUs", "op": "settings", "field": "gpus", "value": ""}],
            ),
            (
                r"Failed to infer device type|NVML Shared Library Not Found|No module named 'amdsmi'|platform is not available",
                "vLLM could not find a supported GPU (CUDA or ROCm). "
                "This machine may have integrated or unsupported graphics only.",
                [
                    {"label": "switch to llama.cpp (CPU/Metal, works without a discrete GPU)", "op": "manual"},
                    {"label": "switch to Ollama (CPU/Metal, works without a discrete GPU)", "op": "manual"},
                ],
            ),
            (
                r"vllm.*command not found|No module named vllm|ERROR: vLLM is not installed",
                "vLLM is not installed or not in PATH on this server.",
                [{"label": "install vLLM in Cookbook Dependencies", "op": "dependency", "package": "vllm"}],
            ),
            (
                r"sgl_kernel[\s\S]*(Python\.h|libnuma\.so\.1|common_ops)|"
                r"(Python\.h|libnuma\.so\.1|common_ops)[\s\S]*sgl_kernel|"
                r"Please ensure sgl_kernel is properly installed",
                "SGLang native dependencies are missing on this server.",
                [
                    {"label": "install OS packages: libnuma-dev python3.12-dev build-essential", "op": "manual"},
                    {"label": "upgrade sglang-kernel after OS packages are installed", "op": "manual"},
                ],
            ),
            (
                r"sglang.*command not found|No module named sglang|SGLang is not installed",
                "SGLang is not installed or not in PATH on this server.",
                [{"label": "install SGLang in Cookbook Dependencies", "op": "dependency", "package": "sglang[all]"}],
            ),
            (
                r"llama-server.*command not found|llama\.cpp.*not found|No module named.*llama_cpp|No module named 'starlette_context'|git: command not found|cmake: command not found",
                "llama.cpp / llama-cpp-python dependencies are missing.",
                [{"label": "install llama.cpp dependencies or llama-cpp-python[server]", "op": "dependency", "package": "llama-cpp-python[server]"}],
            ),
            (
                r"No GGUF found on this host|no \.gguf file|No GGUF file found",
                "No GGUF file found for this model on this host. The llama.cpp backend needs a .gguf file.",
                [{"label": "download a GGUF build of this model (repo name usually ends in -GGUF, file like Q4_K_M.gguf)", "op": "manual"}],
            ),
            (
                r"No module named 'torch'|No module named torch|No module named 'diffusers'|No module named diffusers",
                "Diffusion serving requires PyTorch and diffusers.",
                [{"label": "install diffusers[torch] in Cookbook Dependencies", "op": "dependency", "package": "diffusers[torch]"}],
            ),
            (
                r"403 Forbidden|401 Unauthorized|Access to model.*is restricted|gated repo|not in the authorized list|awaiting a review",
                "Model access is gated or unauthorized.",
                [{"label": "set HF token and request model access on HuggingFace", "op": "manual"}],
            ),
        ]
        for pattern, message, suggestions in patterns:
            if re.search(pattern, tail, re.I):
                return {"message": message, "suggestions": suggestions}
        if re.search(r"Traceback \(most recent call last\)", tail, re.I) and not re.search(
            r"Application startup complete|GET /v1/|Uvicorn running on", tail, re.I
        ):
            return {
                "message": "Python traceback detected during serve startup.",
                "suggestions": [{"label": "inspect traceback and retry with adjusted backend/settings", "op": "manual"}],
            }
        return None

    def _state_for_client(state):
        """返回移除了原始密钥的 cookbook 状态，供浏览器客户端使用。"""
        _strip_task_secrets(state)
        env = state.get("env") if isinstance(state, dict) else None
        if isinstance(env, dict):
            token = _decrypt_secret(env.get("hfToken"))
            env.pop("hfToken", None)
            env["hfTokenConfigured"] = bool(token)
            env["hfTokenMasked"] = _mask_secret(token)
        return state

    def _state_for_storage(state, on_disk=None):
        """写入磁盘前加密 cookbook 密钥。"""
        _strip_task_secrets(state)
        env = state.get("env") if isinstance(state, dict) else None
        disk_env = on_disk.get("env") if isinstance(on_disk, dict) and isinstance(on_disk.get("env"), dict) else {}
        if isinstance(env, dict):
            incoming = env.get("hfToken")
            if incoming:
                _validate_token(incoming)
                env["hfToken"] = _encrypt_secret(incoming)
            elif disk_env.get("hfToken"):
                env["hfToken"] = disk_env["hfToken"]
            else:
                env.pop("hfToken", None)
            env.pop("hfTokenMasked", None)
            env.pop("hfTokenConfigured", None)
        return state

    def _load_stored_hf_token() -> str:
        return load_stored_hf_token(state_path=_cookbook_state_path)

    def _cookbook_ssh_dir() -> Path:
        # Docker 镜像将 cookbook 密钥保存在 /app/.ssh 下；该路径仅
        # 存在于容器内部。在 Windows（及任何非容器主机）上
        # 回退到用户配置文件的 ~/.ssh，这是 Win10+ 上 OpenSSH 使用的路径。
        if not IS_WINDOWS:
            app_ssh = Path("/app/.ssh")
            if Path("/app").exists():
                return app_ssh
        return Path.home() / ".ssh"

    def _cookbook_ssh_key_path() -> Path:
        return _cookbook_ssh_dir() / "id_ed25519"

    def _read_cookbook_public_key() -> str:
        pub = _cookbook_ssh_key_path().with_suffix(".pub")
        if not pub.exists():
            return ""
        return pub.read_text(encoding="utf-8", errors="replace").strip()

    @router.get("/api/cookbook/ssh-key")
    async def get_cookbook_ssh_key(request: Request):
        require_admin(request)
        public_key = _read_cookbook_public_key()
        return {
            "configured": bool(public_key),
            "public_key": public_key,
        }

    @router.post("/api/cookbook/ssh-key")
    async def generate_cookbook_ssh_key(request: Request):
        require_admin(request)
        ssh_dir = _cookbook_ssh_dir()
        key_path = _cookbook_ssh_key_path()
        ssh_dir.mkdir(parents=True, exist_ok=True)
        # safe_chmod no-ops on Windows (~/.ssh is already ACL-restricted to the
        # user profile); applies 0o700 on POSIX.
        safe_chmod(ssh_dir, 0o700)
        if not key_path.exists():
            # ssh-keygen ships with the OpenSSH client on Win10+; resolve it via
            # which_tool so the .exe is found even when PATHEXT is unusual.
            ssh_keygen = which_tool("ssh-keygen") or "ssh-keygen"
            proc = await asyncio.create_subprocess_exec(
                ssh_keygen, "-t", "ed25519", "-N", "", "-C", "odysseus-cookbook", "-f", str(key_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
            if proc.returncode != 0:
                detail = (stderr or stdout).decode("utf-8", errors="replace").strip()[-500:]
                return {"ok": False, "error": detail or "Failed to generate SSH key"}
        safe_chmod(key_path, 0o600)
        safe_chmod(key_path.with_suffix(".pub"), 0o644)
        return {"ok": True, "public_key": _read_cookbook_public_key()}

    def _needs_binary(cmd: str, binary: str) -> bool:
        return bool(re.search(rf"(^|[\s;&|()]){re.escape(binary)}($|[\s;&|()])", cmd or ""))

    def _missing_binary_message(binary: str, target: str) -> str:
        if binary == "tmux":
            return (
                f"tmux is required for Cookbook background downloads/serves on {target}. "
                "Install it with your OS package manager, or run Cookbook server setup for that server."
            )
        if binary == "docker":
            return (
                f"Docker is required by this Cookbook launch command on {target}, but the docker CLI was not found. "
                "Install Docker and make sure this user can run `docker`, then retry."
            )
        return f"{binary} is required on {target}, but it was not found."

    async def _remote_binary_available(remote: str, ssh_port: str | None, binary: str, *, windows: bool = False) -> bool:
        _port = ssh_port or ""
        _pf = ["-p", _port] if _port and _port != "22" else []
        if windows:
            check = f"powershell -NoProfile -Command \"if (Get-Command {binary} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 127 }}\""
        else:
            check = f"command -v {shlex.quote(binary)} >/dev/null 2>&1"
        try:
            proc = await asyncio.create_subprocess_exec(
                "ssh", "-o", "ConnectTimeout=6", "-o", "StrictHostKeyChecking=no",
                *_pf, remote, check,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=10)
            return proc.returncode == 0
        except Exception:
            return False

    async def _binary_available(binary: str, remote: str | None, ssh_port: str | None, *, windows: bool = False) -> bool:
        if remote:
            return await _remote_binary_available(remote, ssh_port, binary, windows=windows)
        return shutil.which(binary) is not None

    def _launch_local_detached(session_id: str, bash_lines: list[str]) -> dict:
        """Windows 原生替代方案，用于本地 tmux 会话（tmux 在 Windows 上不存在）。
        镜像 shell_routes._generate_win_detached / bg_jobs.launch：
        以分离模式运行包装脚本，使其在浏览器/SSE 断开连接后仍能存活
        （长下载/服务的 tmux 功能的全部意义），写入 <session>.log 供状态轮询器
        读取，并写入 <session>.pid 用于存活检测。

        `bash_lines` 是与 POSIX 上使用的相同的 bash 包装脚本。优先使用 Git Bash
        for full command-syntax parity; falls back to a cmd.exe wrapper that
        runs the script through whatever bash is reachable, else best-effort
        directly (simple commands only). Returns the launched job record."""
        log_path = TMUX_LOG_DIR / f"{session_id}.log"
        pid_path = TMUX_LOG_DIR / f"{session_id}.pid"
        bash = find_bash()
        if bash:
            # 通过 Git Bash 逐字运行已有的 bash 包装器，将所有输出
            # 重定向到轮询器读取的日志中。传递给 bash 的路径使用
            # POSIX 形式 + shell-quoting 以确保驱动器路径/空格正常。
            inner = TMUX_LOG_DIR / f"{session_id}_run.sh"
            pp = shlex.quote(pid_path.as_posix())
            inner.write_text(
                f"printf '%s\\n' \"$$\" > {pp}\n" + "\n".join(bash_lines) + "\n",
                encoding="utf-8",
            )
            lp = shlex.quote(log_path.as_posix())
            ip = shlex.quote(inner.as_posix())
            script_path = TMUX_LOG_DIR / f"{session_id}.sh"
            script_path.write_text(
                f"bash {ip} > {lp} 2>&1\n",
                encoding="utf-8",
            )
            argv = [bash, str(script_path)]
        else:
            # 此 Windows 主机上没有 bash：bash 包装器无法运行。回退到
            # cmd.exe 包装器，仅将清晰的错误记录到日志中，
            # 这样 UI 会显示 "install Git Bash" 而不会静默挂起。
            script_path = TMUX_LOG_DIR / f"{session_id}.cmd"
            script_path.write_text(
                "@echo off\r\n"
                f'echo Cookbook LOCAL execution on Windows needs Git Bash ^(bash.exe^) on PATH. > "{log_path}" 2>&1\r\n'
                f'echo Install Git for Windows, then retry. >> "{log_path}"\r\n',
                encoding="utf-8",
            )
            argv = [os.environ.get("ComSpec", "cmd.exe"), "/c", str(script_path)]
        env = os.environ.copy()
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            env=env,
            **detached_popen_kwargs(),
        )
        pid_path.write_text(str(proc.pid), encoding="utf-8")
        return {"pid": proc.pid, "log_path": str(log_path)}

    @router.post("/api/model/download")
    async def model_download(request: Request, req: ModelDownloadRequest):
        """在 tmux 会话中下载 HuggingFace 模型。
        直接使用 `hf download` CLI — 通过 `script -qc` 在 tmux 中运行以获取真实
        TTY 进度，通过日志文件流式传输 ANSI 过滤后的输出。"""
        require_admin(request)
        # 纵深防御：即使此端点受管理员限制，也拒绝包含 shell 元字符的值。
        # values that would land in shell contexts with metacharacters.
        backend = (req.backend or "").strip().lower()
        is_ollama_download = backend == "ollama" or ("/" not in req.repo_id and ":" in req.repo_id)
        if is_ollama_download:
            _validate_serve_model_id(req.repo_id)
            req.include = None
            req.local_dir = None
        else:
            _validate_repo_id(req.repo_id)
            _validate_include(req.include)
        validate_remote_host(req.remote_host)
        req.ssh_port = validate_ssh_port(req.ssh_port)
        req.local_dir = _validate_local_dir(req.local_dir)
        req.hf_token = "" if is_ollama_download else (req.hf_token or _load_stored_hf_token())
        _validate_token(req.hf_token)
        TMUX_LOG_DIR.mkdir(parents=True, exist_ok=True)
        session_id = f"cookbook-{uuid.uuid4().hex[:8]}"
        wrapper_script = TMUX_LOG_DIR / f"{session_id}.sh"

        # Custom download dir: point the HF cache at <dir>/hub via env vars
        # (HF_HOME + HUGGINGFACE_HUB_CACHE) 而非 --local-dir。local_dir
        # 产生扁平布局 (<dir>/<name>/<file>) 和 local-dir 簿记文件
        # (.cache/huggingface/.gitignore.lock)，而且在不稳定传输中无法稳健恢复 —
        # also breaks robust resume on flaky transfers — the blob-based hub
        # cache survives SSL ReadError mid-stream by reusing <sha>.incomplete,
        # 中流式中断后存活，local_dir 则不行。见 issue #2722。
        _dl_hf_home_shell = _shell_path(req.local_dir.rstrip("/")) if req.local_dir else None
        _dl_pyarg = ""  # snapshot_download honors the env vars too — no kwarg needed

        # 构建 hf download 命令。重定向用于抑制交互式
        # "update available? [Y/n]" 提示，在下面按平台分别添加
        # (< /dev/null on bash, $null | on PowerShell)。
        hf_cmd = f"hf download {req.repo_id}"
        if req.include:
            hf_cmd += f" --include '{req.include}'"
        ollama_cmd = f"ollama pull {shlex.quote(req.repo_id)}"

        # 构建 shell 包装器 — 直接在 tmux 中运行 hf download（tmux 是 TTY）
        # 无需 script/tee — 我们将使用 tmux capture-pane 读取输出
        lines = ["#!/bin/bash"]
        lines.extend(_user_shell_path_bootstrap())
        if req.hf_token:
            lines.append(f"export HF_TOKEN='{_bash_squote(req.hf_token)}'")
        if _dl_hf_home_shell and not is_ollama_download:
            # 通过标准 HF 缓存让 hf download / snapshot_download 使用所选目录
            # （提供 models--org--name/blobs/... 布局及可恢复的 .incomplete blobs）。
            # （提供 models--org--name/blobs/... 布局及可恢复的 .incomplete blobs）。
            lines.append(f"export HF_HOME={_dl_hf_home_shell}")
            lines.append(f"export HUGGINGFACE_HUB_CACHE={_dl_hf_home_shell}/hub")
            lines.append(f"export HF_HUB_CACHE={_dl_hf_home_shell}/hub")
        # 确保 pip --user 脚本（如 --user 安装的 hf CLI）在 PATH 上
        lines.append('export PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"')
        # Odysseus 从 venv 运行时（如原生 macOS 安装），将其 bin 目录加入
        # PATH 以便 tmux shell 无需激活 venv 就能找到绑定的 `hf`/`python3`。
        # 仅限本地 bash 运行 — 在 SSH 上无意义。
        if not req.remote_host:
            lines.append(_local_tooling_path_export(sys.executable))
        # 尽力安装 hf CLI（始终执行）。hf_transfer（Rust 并行下载器）
        # 速度快但大文件不稳定 — 在高吞吐量下容易在末尾崩溃。
        # 重试时设置 disable_hf_transfer 回退到普通但可靠的下载器
        # （从 .incomplete 文件干净地恢复）。使用 `python3 -m pip` 而非 `pip`
        # — macOS 没有独立的 `pip` 命令。
        if is_ollama_download:
            lines.append('if command -v ollama >/dev/null 2>&1; then')
            lines.append(f'  ODYSSEUS_OLLAMA_PULL_CMD={shlex.quote(ollama_cmd)}')
            lines.append('elif command -v docker >/dev/null 2>&1; then')
            lines.append('  ODYSSEUS_OLLAMA_CONTAINER="$(docker ps --format \'{{.Names}}\' 2>/dev/null | grep -E \'^(ollama-rocm|ollama-test)$\' | head -1)"')
            lines.append('  if [ -n "$ODYSSEUS_OLLAMA_CONTAINER" ]; then')
            lines.append(f'    ODYSSEUS_OLLAMA_PULL_CMD={shlex.quote("docker exec ${ODYSSEUS_OLLAMA_CONTAINER} " + ollama_cmd)}')
            lines.append('  fi')
            lines.append('fi')
            lines.append('if [ -z "$ODYSSEUS_OLLAMA_PULL_CMD" ]; then echo "ERROR: Ollama not found on this server. Install Ollama or start an ollama-rocm/ollama-test container."; exit 127; fi')
        else:
            lines.append(f"command -v hf >/dev/null 2>&1 || {_pip_install_fallback_chain('huggingface_hub', upgrade=True)}")
            if req.disable_hf_transfer:
                lines.append("export HF_HUB_ENABLE_HF_TRANSFER=0")
                lines.append("export HF_HUB_DOWNLOAD_MAX_WORKERS=4")
            else:
                lines.append(f"python3 -c 'import hf_transfer' 2>/dev/null || {_pip_install_fallback_chain('hf_transfer')}")
                lines.append("python3 -c 'import hf_transfer' 2>/dev/null && export HF_HUB_ENABLE_HF_TRANSFER=1")
                lines.append("export HF_HUB_DOWNLOAD_MAX_WORKERS=8")

        remote = req.remote_host  # None 表示本地
        is_windows = req.platform == "windows"
        # 原生 Windows 主机上的本地执行永不使用 tmux（它使用下面的
        # 分离进程路径），无论 UI 提供的平台参数如何。
        local_windows = IS_WINDOWS and not remote
        logger.info(f"Download request: repo={req.repo_id}, remote={remote}, ssh_port={req.ssh_port}, platform={req.platform}")

        if not is_windows and not local_windows and not await _binary_available("tmux", remote, req.ssh_port):
            return {
                "ok": False,
                "error": _missing_binary_message("tmux", remote or "local server"),
                "session_id": session_id,
            }

        if remote and is_windows:
            # ── Windows 远程：生成 .ps1 运行器，使用 Start-Process 后台运行 ──
            remote_runner = f".{session_id}_run.ps1"
            ps_lines = []
            ps_lines.append('$sessionDir = "$env:TEMP\\odysseus-sessions"')
            ps_lines.append('New-Item -ItemType Directory -Force -Path $sessionDir | Out-Null')
            if req.hf_token:
                ps_lines.append(f"$env:HF_TOKEN = '{_ps_squote(req.hf_token)}'")
            if req.local_dir and not is_ollama_download:
                # Mirror the bash branch — point the HF cache at the user's dir
                # 而非 --local-dir，以便在不稳定传输中恢复（issue #2722）。
                # 而非 --local-dir，以便在不稳定传输中恢复（issue #2722）。
                _dl_ps = _ps_squote(req.local_dir.rstrip("/"))
                ps_lines.append(f"$env:HF_HOME = '{_dl_ps}'")
                ps_lines.append(f"$env:HUGGINGFACE_HUB_CACHE = '{_dl_ps}/hub'")
                ps_lines.append(f"$env:HF_HUB_CACHE = '{_dl_ps}/hub'")
            if req.env_prefix:
                ps_lines.append(_safe_env_prefix(req.env_prefix))
            if is_ollama_download:
                ps_lines.append('if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Write-Host "ERROR: Ollama not found. Install from https://ollama.com/download/windows"; exit 127 }')
                ps_lines.append(f"$null | ollama pull '{_ps_squote(req.repo_id)}'")
                ps_lines.append('if ($LASTEXITCODE -eq 0) { Write-Host ""; Write-Host "DOWNLOAD_OK" } else { Write-Host ""; Write-Host "DOWNLOAD_FAILED (exit $LASTEXITCODE)" }')
            else:
                # 尝试 hf CLI，回退到 Python huggingface_hub，再自动安装
                ps_lines.append('try {{')
                ps_lines.append('  $hfPath = Get-Command hf -ErrorAction SilentlyContinue')
                ps_lines.append('  if ($hfPath) {{')
                # 将 $null 管道到 stdin 以抑制交互式 "update available? [Y/n]" 提示
                ps_lines.append(f'    $null | {hf_cmd}')
                ps_lines.append('  }} else {{')
                ps_lines.append('    python -c "import huggingface_hub" 2>$null')
                ps_lines.append('    if ($LASTEXITCODE -eq 0) {{')
                ps_lines.append('      Write-Host "hf CLI not found, using Python huggingface_hub..."')
                ps_lines.append('      python -m pip install -q hf_transfer 2>$null')
                ps_lines.append('      $env:HF_HUB_ENABLE_HF_TRANSFER = "1"')
                ps_lines.append(f"      python -c \"import os; from huggingface_hub import snapshot_download; snapshot_download('{req.repo_id}'{_dl_pyarg}, max_workers=8)\"")
                ps_lines.append('    }} else {{')
                ps_lines.append('      Write-Host "Installing huggingface-hub..."')
                ps_lines.append('      python -m pip install -q huggingface-hub hf_transfer')
                ps_lines.append('      $env:HF_HUB_ENABLE_HF_TRANSFER = "1"')
                ps_lines.append(f"      python -c \"import os; from huggingface_hub import snapshot_download; snapshot_download('{req.repo_id}'{_dl_pyarg}, max_workers=8)\"")
                ps_lines.append('    }}')
                ps_lines.append('  }}')
                ps_lines.append('  if ($LASTEXITCODE -eq 0) {{ Write-Host ""; Write-Host "DOWNLOAD_OK" }}')
                ps_lines.append('  else {{ Write-Host ""; Write-Host "DOWNLOAD_FAILED (exit $LASTEXITCODE)" }}')
                ps_lines.append('}} catch {{')
                ps_lines.append('  Write-Host ""; Write-Host "DOWNLOAD_FAILED ($_)"')
                ps_lines.append('}}')
            ps_lines.append(f'Remove-Item -Force "$HOME\\{remote_runner}" -ErrorAction SilentlyContinue')
            runner_path = TMUX_LOG_DIR / f"{session_id}_run.ps1"
            runner_path.write_text("\r\n".join(ps_lines) + "\r\n", encoding="utf-8")

            # scp 上传 .ps1 脚本，然后以分离进程启动，带日志和 pid 文件
            _port = req.ssh_port
            _Pf = f"-P {_port} " if _port and _port != "22" else ""
            _pf = f"-p {_port} " if _port and _port != "22" else ""
            # Start-Process 创建完全分离的进程，在 SSH 断开后仍然存活
            launch_ps = (
                "$sd = \\\"$env:TEMP\\odysseus-sessions\\\"; "
                f"Start-Process powershell -ArgumentList '-ExecutionPolicy','Bypass','-File','$HOME\\{remote_runner}' "
                f"-RedirectStandardOutput \\\"$sd\\{session_id}.log\\\" "
                f"-RedirectStandardError \\\"$sd\\{session_id}.err.log\\\" "
                f"-NoNewWindow -PassThru | ForEach-Object {{ $_.Id | Out-File \\\"$sd\\{session_id}.pid\\\" }}"
            )
            setup_cmd = (
                f"scp -O {_Pf}-q '{runner_path}' {remote}:{remote_runner} && "
                f'ssh {_pf}{remote} "powershell -Command \\"{launch_ps}\\""'
            )

        elif remote:
            # ── Linux/Termux 远程：在远程主机上创建 tmux 会话 ──
            remote_runner = f".{session_id}_run.sh"
            runner_lines = ["#!/bin/bash"]
            runner_lines.extend(_user_shell_path_bootstrap())
            runner_lines.append("# 自动检测环境")
            runner_lines.append("deactivate 2>/dev/null; hash -r")
            if req.hf_token:
                runner_lines.append(f"export HF_TOKEN='{_bash_squote(req.hf_token)}'")
            if _dl_hf_home_shell and not is_ollama_download:
                runner_lines.append(f"export HF_HOME={_dl_hf_home_shell}")
                runner_lines.append(f"export HUGGINGFACE_HUB_CACHE={_dl_hf_home_shell}/hub")
                runner_lines.append(f"export HF_HUB_CACHE={_dl_hf_home_shell}/hub")
            if req.env_prefix:
                runner_lines.append(_safe_env_prefix(req.env_prefix))
            else:
                # 回退：查找具有 hf CLI 的 venv，或安装 huggingface-hub
                runner_lines.append(
                    'for p in ~/vllm-env ~/venv ~/.venv; do '
                    'if [ -f "$p/bin/activate" ]; then source "$p/bin/activate"; break; fi; '
                    'done'
                )
        # 确保 pip --user 脚本（如 --user 安装的 hf CLI）在 PATH 上
            runner_lines.append('export PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"')
            # 安装 hf CLI + 可选的 hf_transfer（尽力而为）。重试时禁用 hf_transfer，
            # hf_transfer because the Rust parallel path is fast but has been
            # flaky near the end of very large multi-file downloads.
            # Use --break-system-packages on PEP-668 systems (Arch, newer Debian) so it doesn't bail.
            if is_ollama_download:
                runner_lines.append('if command -v ollama >/dev/null 2>&1; then')
                runner_lines.append(f'  ODYSSEUS_OLLAMA_PULL_CMD={shlex.quote(ollama_cmd)}')
                runner_lines.append('elif command -v docker >/dev/null 2>&1; then')
                runner_lines.append('  ODYSSEUS_OLLAMA_CONTAINER="$(docker ps --format \'{{.Names}}\' 2>/dev/null | grep -E \'^(ollama-rocm|ollama-test)$\' | head -1)"')
                runner_lines.append('  if [ -n "$ODYSSEUS_OLLAMA_CONTAINER" ]; then')
                runner_lines.append(f'    ODYSSEUS_OLLAMA_PULL_CMD={shlex.quote("docker exec ${ODYSSEUS_OLLAMA_CONTAINER} " + ollama_cmd)}')
                runner_lines.append('  fi')
                runner_lines.append('fi')
                runner_lines.append('if [ -z "$ODYSSEUS_OLLAMA_PULL_CMD" ]; then echo "ERROR: Ollama not found on this server. Install Ollama or start an ollama-rocm/ollama-test container."; exit 127; fi')
            else:
                runner_lines.append(f"command -v hf >/dev/null 2>&1 || {_pip_install_fallback_chain('huggingface_hub', python_cmd='pip', upgrade=True)}")
                if req.disable_hf_transfer:
                    runner_lines.append("export HF_HUB_ENABLE_HF_TRANSFER=0")
                    runner_lines.append("export HF_HUB_DOWNLOAD_MAX_WORKERS=4")
                else:
                    runner_lines.append(f"python3 -c 'import hf_transfer' 2>/dev/null || {_pip_install_fallback_chain('hf_transfer', python_cmd='pip')}")
                    runner_lines.append("python3 -c 'import hf_transfer' 2>/dev/null && export HF_HUB_ENABLE_HF_TRANSFER=1")
                    runner_lines.append("export HF_HUB_DOWNLOAD_MAX_WORKERS=8")
                # Surface whether the HF token actually reached THIS server, so a gated
                # "not authorized" 失败与 token 缺失（token 被掩码 — 只输出 applied / not-set）。
                # "not authorized" 失败与 token 缺失（token 被掩码 — 只输出 applied / not-set）。
                runner_lines.append(_HF_TOKEN_STATUS_SNIPPET)
            # 将下载包裹在重试循环中。大型 HF/Ollama 传输可能遇到
            # 瞬时网络故障；两种后端都从缓存的未完成部分恢复。
            mw = 4 if req.disable_hf_transfer else 8
            runner_lines.append('_max_retries=10; _attempt=0; _ec=0')
            runner_lines.append('while [ $_attempt -lt $_max_retries ]; do')
            runner_lines.append('  _attempt=$((_attempt+1))')
            if is_ollama_download:
                runner_lines.append('  eval "$ODYSSEUS_OLLAMA_PULL_CMD" < /dev/null')
            else:
                runner_lines.append('  if command -v hf &>/dev/null; then')
                runner_lines.append(f'    {hf_cmd} < /dev/null')
                runner_lines.append('  elif python3 -c "import huggingface_hub" 2>/dev/null; then')
                runner_lines.append('    [ $_attempt -eq 1 ] && echo "hf CLI not found, using Python huggingface_hub..."')
                runner_lines.append(f'    python3 -c "import os; from huggingface_hub import snapshot_download; snapshot_download(\'{req.repo_id}\'{_dl_pyarg}, max_workers={mw})"')
                runner_lines.append('  else')
                runner_lines.append('    echo "Installing huggingface-hub and dependencies..."')
                runner_lines.append('    pip install --no-deps -q huggingface-hub 2>/dev/null')
                if req.disable_hf_transfer:
                    runner_lines.append('    pip install -q filelock fsspec packaging pyyaml tqdm typer httpx requests 2>/dev/null')
                    runner_lines.append('    export HF_HUB_ENABLE_HF_TRANSFER=0')
                else:
                    runner_lines.append('    pip install -q filelock fsspec packaging pyyaml tqdm typer httpx requests hf_transfer 2>/dev/null')
                    runner_lines.append("    python3 -c 'import hf_transfer' 2>/dev/null && export HF_HUB_ENABLE_HF_TRANSFER=1")
                runner_lines.append(f'    python3 -c "import os; from huggingface_hub import snapshot_download; snapshot_download(\'{req.repo_id}\'{_dl_pyarg}, max_workers={mw})"')
                runner_lines.append('  fi')
            runner_lines.append('  _ec=$?')
            runner_lines.append('  if [ $_ec -eq 0 ]; then break; fi')
            runner_lines.append('  if [ $_attempt -lt $_max_retries ]; then')
            runner_lines.append('    echo ""; echo "Download attempt $_attempt failed (exit $_ec) — retrying in 30s..."')
            runner_lines.append('    sleep 30')
            runner_lines.append('  fi')
            runner_lines.append('done')
            runner_lines.append('if [ $_ec -eq 0 ]; then echo ""; echo "DOWNLOAD_OK"; else echo ""; echo "DOWNLOAD_FAILED (exit $_ec after $_attempt attempts)"; fi')
            runner_lines.append(f"rm -f {remote_runner}")
            runner_lines.append('exec "${SHELL:-/bin/bash}"')
            runner_path = TMUX_LOG_DIR / f"{session_id}_run.sh"
            runner_path.write_text("\n".join(runner_lines) + "\n", encoding="utf-8")
            # Local temp file is scp'd then chmod'd on the remote; the local bit
            # is irrelevant (no-op on Windows).
            safe_chmod(runner_path, 0o755)

            # scp 上传运行脚本，然后在远程上创建 tmux 会话
            _port = req.ssh_port
            _pf = f"-P {_port} " if _port and _port != "22" else ""
            _spf = f"-p {_port} " if _port and _port != "22" else ""
            setup_cmd = (
                f"scp -O {_pf}-q '{runner_path}' {remote}:{remote_runner} && "
                f"ssh {_spf}{remote} 'chmod +x {remote_runner} && tmux set-option -g history-limit 100000 2>/dev/null; tmux new-session -d -s {session_id} \"./{remote_runner}\"'"
            )
        else:
            # 本地：在后台运行 hf download（POSIX 上用 tmux，Windows 上用
            # 分离进程 + 日志文件替代 tmux）。
            if req.env_prefix:
                lines.append(_safe_env_prefix(req.env_prefix))
            else:
                lines.append("deactivate 2>/dev/null; hash -r")
            # 显示 HF token 是否到达了本次运行（已掩码）— 区分受控
            # "not authorized" 失败与 token 缺失。
            if not is_ollama_download:
                lines.append(_HF_TOKEN_STATUS_SNIPPET)
            # 重试循环 — 与远程 bash 路径同理。Issue #2722。
            _hf_invoke = 'eval "$ODYSSEUS_OLLAMA_PULL_CMD" < /dev/null' if is_ollama_download else (hf_cmd if IS_WINDOWS else f"{hf_cmd} < /dev/null")
            lines.append('_max_retries=10; _attempt=0; _ec=0')
            lines.append('while [ $_attempt -lt $_max_retries ]; do')
            lines.append('  _attempt=$((_attempt+1))')
            lines.append(f'  {_hf_invoke}')
            lines.append('  _ec=$?')
            lines.append('  if [ $_ec -eq 0 ]; then break; fi')
            lines.append('  if [ $_attempt -lt $_max_retries ]; then')
            lines.append('    echo ""; echo "Download attempt $_attempt failed (exit $_ec) — retrying in 30s..."')
            lines.append('    sleep 30')
            lines.append('  fi')
            lines.append('done')
            lines.append('if [ $_ec -eq 0 ]; then echo ""; echo "DOWNLOAD_OK"; else echo ""; echo "DOWNLOAD_FAILED (exit $_ec after $_attempt attempts)"; fi')
            if not IS_WINDOWS:
                lines.append(f"rm -f '{wrapper_script}'")
                lines.append('exec "${SHELL:-/bin/bash}"')
                wrapper_script.write_text("\n".join(lines) + "\n", encoding="utf-8")
                wrapper_script.chmod(0o755)
            setup_cmd = None if IS_WINDOWS else f"tmux set-option -g history-limit 100000 2>/dev/null; tmux new-session -d -s {session_id} {shlex.quote(str(wrapper_script))}"

        logger.info(f"Model download: {req.repo_id} (backend={'ollama' if is_ollama_download else 'hf'}, include={req.include}, session={session_id}, remote={remote})")
        logger.info(f"Download setup_cmd: {setup_cmd}")

        if setup_cmd is None:
            # 本地 Windows：分离模式启动 bash 包装器；无 tmux setup_cmd。
            try:
                _launch_local_detached(session_id, lines)
            except Exception as e:
                logger.error(f"Local detached download launch failed: {e}")
                return {"ok": False, "error": str(e), "session_id": session_id}
        else:
            proc = await asyncio.create_subprocess_shell(
                setup_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.wait()

            if proc.returncode != 0:
                stderr = (await proc.stderr.read()).decode(errors="replace")
                logger.error(f"Download failed (rc={proc.returncode}): {stderr}")
                return {"ok": False, "error": stderr, "session_id": session_id}

        # 记录到 assistant
        try:
            from src.assistant_log import log_to_assistant
            from src.auth_helpers import get_current_user
            owner = get_current_user(request)
            log_to_assistant(
                owner,
                f"Started downloading {req.repo_id} to {remote or 'local'}",
                category="Download",
            )
        except Exception:
            pass

        return {"ok": True, "session_id": session_id, "remote": remote or "local"}

    @router.get("/api/model/cached")
    async def model_cached(request: Request, host: str | None = None, model_dir: str | None = None, ssh_port: str | None = None, platform: str | None = None):
        """列出缓存模型。扫描 HF 缓存 + 可选模型目录。"""
        require_admin(request)
        # 验证 shell-bound 输入，匹配相邻的 list_gpus 端点 —
        # `host`/`ssh_port` 在下面的 ssh 命令中被插值，所以
        # 未经验证的值（如 "x'; rm -rf ~ #"）将是命令注入。
        host = validate_remote_host(host)
        ssh_port = validate_ssh_port(ssh_port)
        TMUX_LOG_DIR.mkdir(parents=True, exist_ok=True)

        model_dirs = []
        if model_dir:
            for d in model_dir.split(','):
                d = d.strip()
                if d:
                    model_dirs.append(d)
        paths_code = _cached_model_scan_script(model_dirs)

        scan_py = TMUX_LOG_DIR / "scan_cache.py"
        scan_py.write_text(paths_code, encoding="utf-8")

        if host:
            _pf = f"-p {ssh_port} " if ssh_port and ssh_port != "22" else ""
            if platform == "windows":
                # Windows：使用 'python' 并通过双引号包裹由 stdin 管道传入
                cmd = f'ssh {_pf}{host} "python -" < \'{scan_py}\''
            else:
                cmd = f"ssh {_pf}{host} 'python3 -' < '{scan_py}'"
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(Path.home()),
            )
        else:
            # 本地扫描：使用 sys.executable（Odysseus 正在运行的 venv Python）
            # running under) — it's guaranteed real Python on all platforms.
            # Falling back to which_tool on Windows risks hitting the Microsoft
            # 有风险会命中 Microsoft Store 存根别名 "python3"/"python"，
            # 它会输出 "Python was not found; run without arguments to
            # install from the Microsoft Store" 并退出 9009，导致空 stdout
            # 和 JSON 解析错误。sys.executable 完全绕过 PATH。
            local_py = sys.executable or (
                which_tool("python3") or which_tool("python")
                or which_tool("py") or "python"
            )
            proc = await asyncio.create_subprocess_exec(
                local_py, str(scan_py),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(Path.home()),
            )
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=60)

        models = []
        try:
            raw = json.loads(stdout_b.decode(errors="replace").strip())
            for m in raw:
                size_gb = m["size_bytes"] / (1024 ** 3)
                if size_gb >= 1:
                    size_str = f"{size_gb:.1f} GB"
                else:
                    size_str = f"{m['size_bytes'] / (1024**2):.0f} MB"
                entry = {
                    "repo_id": m["repo_id"],
                    "size": size_str,
                    "nb_files": m["nb_files"],
                    "has_incomplete": m["has_incomplete"],
                    "status": "downloading" if m["has_incomplete"] else "ready",
                    "path": m.get("path", ""),
                    "is_diffusion": m.get("is_diffusion", False),
                }
                if m.get("is_local_dir"):
                    entry["is_local_dir"] = True
                if m.get("is_gguf"):
                    entry["is_gguf"] = True
                if m.get("backend"):
                    entry["backend"] = m.get("backend")
                if m.get("is_ollama"):
                    entry["is_ollama"] = True
                if isinstance(m.get("gguf_files"), list):
                    entry["gguf_files"] = m["gguf_files"]
                models.append(entry)
        except Exception as e:
            logger.warning(f"Failed to parse cached models: {e}")
            logger.warning(f"stderr: {stderr_b.decode(errors='replace')[:500]}")

        return {"models": models, "host": host or "local"}

    def _auto_register_image_endpoint(req: ServeRequest, remote: str | None) -> str | None:
        """Register a diffusion model as an image endpoint so it appears in the model selector."""
        import re
        from core.database import SessionLocal, ModelEndpoint

        # 从命令中解析端口（--port NNNN），diffusion_server 默认 8100
        port_match = re.search(r'--port\s+(\d+)', req.cmd)
        port = int(port_match.group(1)) if port_match else 8100

        # 确定主机
        if remote:
            # SSH 别名 — 用作主机名（Tailscale 稍后解析）
            host = remote.split("@")[-1] if "@" in remote else remote
        else:
            host = "localhost"

        base_url = f"http://{host}:{port}/v1"

        # 从 repo_id 生成友好的显示名称
        short_name = req.repo_id.split("/")[-1] if "/" in req.repo_id else req.repo_id
        display_name = f"{short_name} (image)"

        db = SessionLocal()
        try:
            # 检查是否存在相同 base_url 的端点 — 更新它
            existing = db.query(ModelEndpoint).filter(ModelEndpoint.base_url == base_url).first()
            if existing:
                existing.is_enabled = True
                existing.model_type = "image"
                existing.name = display_name
                db.commit()
                logger.info(f"Updated existing image endpoint: {base_url}")
                return existing.id

            ep_id = f"img-{uuid.uuid4().hex[:8]}"
            ep = ModelEndpoint(
                id=ep_id,
                name=display_name,
                base_url=base_url,
                api_key=None,
                is_enabled=True,
                model_type="image",
            )
            db.add(ep)
            db.commit()
            logger.info(f"Auto-registered image endpoint: {display_name} @ {base_url}")
            return ep_id
        except Exception as e:
            logger.error(f"Failed to auto-register image endpoint: {e}")
            db.rollback()
            return None
        finally:
            db.close()

    def _pick_free_port_for_ollama(
        remote: str | None, ssh_port: str | None, start_port: int, max_offset: int
    ) -> int | None:
        """Return the first free port in [start_port, start_port+max_offset] on
        the target host. Used to pick a real bind for `ollama serve` so we
        don't reattach to an external systemd ollama (or other listener) the
        Cookbook Stop button can't kill."""
        import socket
        if remote:
            # 通过 SSH 探测。Bash 的 /dev/tcp 提供便携的 "是否有监听" 
            # 检查，无需 ss/netstat/nmap。
            ssh_base = ["ssh", "-o", "ConnectTimeout=4", "-o", "StrictHostKeyChecking=no"]
            if ssh_port and str(ssh_port) != "22":
                try:
                    ssh_port = validate_ssh_port(ssh_port)
                except HTTPException:
                    return None
                ssh_base.extend(["-p", str(ssh_port)])
            try:
                host_arg = validate_remote_host(remote)
            except HTTPException:
                return None
            if not host_arg:
                return None
            probe_ports = " ".join(str(start_port + i) for i in range(max_offset + 1))
            script = (
                f"for p in {probe_ports}; do "
                "if ! (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null; then "
                "echo $p; exit 0; fi; exec 3<&-; exec 3>&-; done; exit 1"
            )
            try:
                import subprocess
                r = subprocess.run(
                    ssh_base + [host_arg, script],
                    capture_output=True, text=True, timeout=8,
                )
                if r.returncode == 0:
                    out = (r.stdout or "").strip().splitlines()
                    if out and out[0].isdigit():
                        return int(out[0])
            except Exception:
                return None
            return None
        # 本地：直接尝试连接。
        for off in range(max_offset + 1):
            p = start_port + off
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.25)
                try:
                    s.connect(("127.0.0.1", p))
                except (ConnectionRefusedError, socket.timeout, OSError):
                    return p
        return None

    async def _serve_crash_watchdog(
        endpoint_id: str,
        session_id: str,
        remote: str | None,
        ssh_port: str | None,
        is_windows: bool,
    ) -> None:
        """Drop a freshly-registered endpoint when the cookbook serve dies early.

        The runner script always emits ``=== Process exited with code N ===``
        when the launched cmd terminates (success or failure). We poll the
        tmux pane periodically; on a non-zero exit detected within the watch
        window, the endpoint row is deleted so the picker doesn't keep a
        dead model around. A zero exit (rare for a long-running serve, but
        possible for fast-failing builds that the runner reports as code 0)
        and "missing exit marker" both leave the endpoint alone — that's
        the loading-but-not-yet-bound state, which the probe-marks-offline
        logic already handles.

        Times are picked to outlast realistic vLLM load times (Qwen3.5-122B
        takes ~3 min to load) without burning resources on a stuck-forever
        wait. After the last check, the watchdog gives up — the picker's
        per-endpoint probe takes over from there.
        """
        # 累计等待点：25 秒、60 秒、2 分钟、5 分钟。
        _waits = [25, 35, 60, 180]
        # 本文其他地方使用的轮询路径的 Tmux capture-pane 等价。
        # 构建一次，在每个 tick 重用。在原生 Windows 本地运行上
        # 完全跳过着门狗（无 tmux）。Windows 分离进程路径
        # 将其日志写入已知文件，有自己的生命周期跟踪；
        # 在此跳过保持代码简单。
        local_win = is_windows and not remote
        if local_win:
            return
        if remote:
            ssh_args = ["ssh"]
            if ssh_port and ssh_port != "22":
                ssh_args.extend(["-p", str(ssh_port)])
            capture_cmd = ssh_args + [remote, "tmux", "capture-pane", "-t", session_id, "-p", "-S", "-2000"]
        else:
            capture_cmd = ["tmux", "capture-pane", "-t", session_id, "-p", "-S", "-2000"]

        _exit_re = re.compile(r"=== Process exited with code (-?\d+) ===")
        for wait_s in _waits:
            await asyncio.sleep(wait_s)
            try:
                proc = await asyncio.create_subprocess_exec(
                    *capture_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=8)
                output = stdout.decode("utf-8", errors="replace")
            except Exception as e:
                logger.debug(f"crash-watchdog: capture-pane failed (will retry): {e!r}")
                continue
            # 最后一次出现为准 — 在运行器 "exec bash -i" 轨迹下
            # 退出/重启的服务会发出多个标记；
            # 最新的代码才是重要的。
            matches = list(_exit_re.finditer(output))
            if not matches:
                continue
            try:
                exit_code = int(matches[-1].group(1))
            except (ValueError, IndexError):
                continue
            if exit_code == 0:
                # 长时间运行的服务退出码 0 是不寻常的（正常的 "加载完成
                # 然后就绪" 路径保持进程活跃），但用户可能通过
                # 相同表单启动的 "ollama pull" 等命令会这样。
                # 不在干净退出时删除端点；
                # 如果没有人在监听，让 probe 层将其标记为离线。
                logger.info(f"crash-watchdog: serve {session_id} exited cleanly (0); leaving endpoint {endpoint_id}")
                return
            # 非零退出 — 删除端点。
            try:
                from core.database import SessionLocal as _SL, ModelEndpoint as _ME
                db = _SL()
                try:
                    ep = db.query(_ME).filter(_ME.id == endpoint_id).first()
                    if ep:
                        logger.info(
                            f"crash-watchdog: dropping endpoint {endpoint_id} "
                            f"({ep.name} @ {ep.base_url}) — serve exited {exit_code}"
                        )
                        db.delete(ep)
                        db.commit()
                finally:
                    db.close()
            except Exception as e:
                logger.warning(f"crash-watchdog: endpoint cleanup failed: {e!r}")
            return
        logger.debug(f"crash-watchdog: no exit marker for {session_id} within window; leaving endpoint {endpoint_id}")

    def _auto_register_llm_endpoint(req: ServeRequest, remote: str | None) -> str | None:
        """Register a freshly-served LLM as a model endpoint so it appears in the
        model picker without a manual /setup step — the text-model sibling of
        _auto_register_image_endpoint.

        Cookbook serve commands launch an OpenAI-compatible server (llama.cpp's
        llama-server, vLLM, SGLang, or Ollama) on a known port. We point an
        endpoint at that server's /v1; the picker auto-discovers the model id by
        probing /v1/models and dims the endpoint until the server is reachable,
        so registering immediately (before the server finishes loading) is safe.
        """
        logger.info(
            f"_auto_register_llm_endpoint: ENTRY repo_id={req.repo_id!r} "
            f"remote={remote!r} cmd_prefix={req.cmd[:80]!r}"
        )
        import re
        from core.database import SessionLocal, ModelEndpoint

        # Port: ordered fallbacks so we match whatever the user actually
        # asked for, not a hardcoded default:
        #   1. 显式 `--port N`（vllm / sglang / llama-server）
        #   2. `OLLAMA_HOST=host:port`（Ollama 指定其绑定的方式）
        #   3. 按后端回退（11434 ollama / 8080 llama.cpp）
        # Previously the OLLAMA_HOST form was silently ignored and we
        # registered every Ollama endpoint at 11434 — even if the user
        # 注册到 11434 — 即使用户设置 OLLAMA_HOST=0.0.0.0:11435
        # existing systemd Ollama, the registered endpoint pointed at
        # the OLD port and showed as offline.
        port_match = re.search(r'--port\s+(\d+)', req.cmd)
        ollama_host_match = re.search(r'OLLAMA_HOST=[^\s]*?:(\d+)', req.cmd)
        if port_match:
            port = int(port_match.group(1))
        elif ollama_host_match:
            port = int(ollama_host_match.group(1))
        elif "ollama" in req.cmd:
            port = 11434
        else:
            port = 8080  # llama.cpp's llama-server default — the Apple Silicon path

        # 确定主机。cookbook tmux 对于 `local=true` 的服务运行在
        # the odysseus container — so the right URL for the in-container
        # `localhost`，而非 `host.docker.internal`
        # (the latter points at the docker HOST, which doesn't have a server
        # 之前的 host.docker.internal 回退仅对 /setup 添加的外部服务
        # sense for /setup-added external services like systemd Ollama on the
        # host — and those go through manual setup, not this auto-register
        # code path. For remote serves we still use the SSH host alias.
        if remote:
            host = remote.split("@")[-1] if "@" in remote else remote
        elif re.search(r"\bdocker\s+exec\s+(?:ollama-rocm|ollama-test)\b", req.cmd or ""):
            host = "host.docker.internal"
        else:
            host = "localhost"

        base_url = f"http://{host}:{port}/v1"

        short_name = req.repo_id.split("/")[-1] if "/" in req.repo_id else req.repo_id
        display_name = short_name or "Local model"

        # 如果服务命令让模型使用 OpenAI tool-calling，记录下来，
        # 以便 agent_loop 信任发出的 tool_calls 而非名称启发式。
        is_ollama_endpoint = "ollama" in (req.cmd or "").lower()
        supports_tools = True if "--enable-auto-tool-choice" in req.cmd else None
        pinned_models = [req.repo_id] if is_ollama_endpoint and req.repo_id else []

        db = SessionLocal()
        try:
            # 重用已指向此 URL 的端点，而非重复创建。
            existing = db.query(ModelEndpoint).filter(ModelEndpoint.base_url == base_url).first()
            if existing:
                existing.is_enabled = True
                existing.model_type = "llm"
                existing.name = display_name
                if is_ollama_endpoint:
                    existing.endpoint_kind = "ollama"
                    if pinned_models:
                        existing.cached_models = json.dumps(pinned_models)
                        existing.pinned_models = json.dumps(pinned_models)
                if supports_tools is not None:
                    existing.supports_tools = supports_tools
                db.commit()
                logger.info(f"Updated existing local model endpoint: {base_url}")
                # 重新探测以便 cached_models 匹配服务器当前实际提供的内容
                # serves right now (the URL may have stayed the same but the
                # model behind it changed across launches).
                try:
                    from routes.model_routes import _probe_endpoint
                    import json as _json2
                    probed = _probe_endpoint(base_url, existing.api_key, timeout=5)
                    if probed:
                        existing.cached_models = _json2.dumps(probed)
                        db.commit()
                except Exception as _pe:
                    logger.warning(f"Re-probe failed for {base_url}: {_pe!r}")
                # Sweep stale dupes: other endpoints with the same display name
                # at DIFFERENT URLs (likely failed earlier-attempt ports) get
                # deleted so the picker doesn't show an offline ghost next to
                # the working one. Only sweeps endpoints whose id starts with
                # DeepSeek/OpenAI/等具有巧合匹配名称的条目。
                # etc. entry with a coincidentally matching name.
                stale = (db.query(ModelEndpoint)
                         .filter(ModelEndpoint.name == display_name)
                         .filter(ModelEndpoint.base_url != base_url)
                         .filter(ModelEndpoint.id.like("local-%"))
                         .all())
                for s in stale:
                    logger.info(f"Sweeping stale local endpoint {s.id} ({s.base_url})")
                    db.delete(s)
                if stale:
                    db.commit()
                return existing.id

            ep_id = f"local-{uuid.uuid4().hex[:8]}"
            ep = ModelEndpoint(
                id=ep_id,
                name=display_name,
                base_url=base_url,
                api_key=None,
                is_enabled=True,
                model_type="llm",
                endpoint_kind="ollama" if is_ollama_endpoint else "auto",
                cached_models=json.dumps(pinned_models) if pinned_models else None,
                pinned_models=json.dumps(pinned_models) if pinned_models else None,
                supports_tools=supports_tools,
            )
            db.add(ep)
            db.commit()
            logger.info(f"Auto-registered local model endpoint: {display_name} @ {base_url}")
            # 首次注册路径上的相同清理：删除任何具有此显示名称
            # 但指向其他地方且已存在的 local-* 端点。
            stale = (db.query(ModelEndpoint)
                     .filter(ModelEndpoint.name == display_name)
                     .filter(ModelEndpoint.id != ep_id)
                     .filter(ModelEndpoint.id.like("local-%"))
                     .all())
            for s in stale:
                logger.info(f"Sweeping stale local endpoint {s.id} ({s.base_url})")
                db.delete(s)
            if stale:
                db.commit()
            # 立即探测 /v1/models 并写入 cached_models，以便聊天选择器
            # picker actually shows the model on the next /api/models
            # call. Without this immediate probe, the endpoint has empty
            # cached_models until the next background refresh fires (up
            # to a minute later) and the picker shows nothing — even
            # though the endpoint is in the DB and the server is up.
            try:
                from routes.model_routes import _probe_endpoint
                import json as _json2
                probed = _probe_endpoint(base_url, None, timeout=5)
                if probed:
                    ep.cached_models = _json2.dumps(probed)
                    db.commit()
                    logger.info(f"Auto-register: probed {len(probed)} models @ {base_url}")
            except Exception as _pe:
                logger.warning(f"Auto-register: probe-after-create failed for {base_url}: {_pe!r}")
            return ep_id
        except Exception as e:
            logger.error(f"Failed to auto-register local model endpoint: {e}")
            db.rollback()
            return None
        finally:
            db.close()

    @router.post("/api/model/serve")
    async def model_serve(request: Request, req: ServeRequest):
        """在 tmux 会话（或 Windows 上的 PowerShell 后台进程）中启动模型服务器。

        `repo_id` 具有双重用途：HuggingFace 仓库（`<org>/<name>`）用于模型服务命令，
        model-serve commands, a cached local-model id (the folder name reported
        by `/api/model/cached`) for models scanned from a custom model dir, OR a
        （文件夹名称），或者在 cmd 是 `python -m pip install …` 时用作裸 pip 包名。
        keep strict validation, but serving local cached models must not require
        a fake org/name wrapper.
        """
        require_admin(request)
        # 纵深防御：拒绝可能逃逸 shell 上下文的值。
        validate_remote_host(req.remote_host)
        req.ssh_port = validate_ssh_port(req.ssh_port)
        req.gpus = _validate_gpus(req.gpus)
        req.hf_token = req.hf_token or _load_stored_hf_token()
        _validate_token(req.hf_token)
        # Normalize away backslash-newline continuations (multi-line pasted
        # serve commands) so the cleaned single-line command is what gets
        # written into the runner script and used for engine auto-detection.
        # `_validate_serve_cmd` 对空输入返回 None；强制转为 ""，
        # 使下游众多的 `"engine" in req.cmd` 成员检查不会触发
        # `TypeError: argument of type 'NoneType'`（不应是 500 而应是干净的 400）。
        req.cmd = _validate_serve_cmd(req.cmd) or ""
        req.cmd = _normalize_llama_cpp_python_cache_types(req.cmd) or ""
        req.cmd = _venv_safe_local_pip_install_cmd(
            req.cmd,
            local=not bool(req.remote_host),
            in_venv=sys.prefix != sys.base_prefix,
        )
        is_pip_install = bool(req.cmd and "pip install" in req.cmd)
        if is_pip_install:
            # 将大型依赖 wheel 构建（vLLM 等）移出 home 文件系统的
            # pip 缓存，以免构建中途因 "No space left" 失败 (#1219)
            # 并留下已安装但不可用的依赖 (#1459)。
            req.cmd = _pip_install_no_cache(req.cmd)
            # 接受常见别名并为 llama-cpp 强制 server extras，
            # 使 `python -m llama_cpp.server` 拥有所有运行时依赖。
            req.cmd = re.sub(r"(?<![A-Za-z0-9_.-])llama_cpp(?![A-Za-z0-9_.-])", "llama-cpp-python[server]", req.cmd)
            req.cmd = re.sub(r"(?<![A-Za-z0-9_.-])llama-cpp-python(?!\[)", "llama-cpp-python[server]", req.cmd)
            if "llama-cpp-python" in req.cmd and "--extra-index-url" not in req.cmd:
                req.cmd += " --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu"
            # PEP-508 风格包规范 — 字母、数字、`.-_` 用于名称；
            # `[` `]` 用于 extras；`<>=!~,` 用于版本说明符。
            # v2 review HIGH-14：从上个正则收紧，上个正则
            # 还允许空格和 `+`，两者都可能被滥用从而在插值到
            # 服务命令时引入额外的 shell 令牌。我们现在使用
            # `re.fullmatch` 并移除空格/`+`。
            if not req.repo_id or not re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9._\-\[\]<>=!,~]{0,200}", req.repo_id
            ):
                raise HTTPException(400, "Invalid pip package name")
        else:
            _validate_serve_model_id(req.repo_id)
        TMUX_LOG_DIR.mkdir(parents=True, exist_ok=True)
        session_id = f"serve-{uuid.uuid4().hex[:8]}"
        remote = req.remote_host
        is_windows = req.platform == "windows"

        # Ollama：如果用户没有固定端口，在此处（构建运行器之前）
        # 通过探测目标主机解析实际将绑定的端口。
        # 否则运行器脚本在运行时自行选择端口，而下面的 `_auto_register`
        # 仍注册过时的 11434 默认值 — 这在具有 systemd ollama 的
        # 主机上会落到错误的（不可从 docker 访问的）服务。
        # 将 "ollama serve" 作为短语匹配（后面可以有可选标志），
        # 而非任何包含 "ollama" 的子字符串 — 否则如
        # `docker exec ollama-test ollama-import …` 的命令会被当作
        # 原生 `ollama serve` 来包装，在前面加上 OLLAMA_HOST=… 然后
        # 运行 ollama-not-found preflight 并以 127 退出。
        if re.search(r"\bollama\s+serve\b", req.cmd) and "OLLAMA_HOST=" not in req.cmd:
            _ollama_bind_host = "0.0.0.0" if remote else "127.0.0.1"
            _ollama_chosen_port = _pick_free_port_for_ollama(
                remote, req.ssh_port, start_port=11434, max_offset=10,
            )
            if _ollama_chosen_port:
                req.cmd = f"OLLAMA_HOST={_ollama_bind_host}:{_ollama_chosen_port} {req.cmd}"
        # 原生 Windows 主机上的本地执行永不使用 tmux（下面的
        # 分离进程路径），无论 UI 提供的平台参数如何。
        local_windows = IS_WINDOWS and not remote

        if not is_windows and not local_windows and not await _binary_available("tmux", remote, req.ssh_port):
            return {
                "ok": False,
                "error": _missing_binary_message("tmux", remote or "local server"),
                "session_id": session_id,
            }
        if _needs_binary(req.cmd, "docker") and not await _binary_available("docker", remote, req.ssh_port, windows=is_windows):
            return {
                "ok": False,
                "error": _missing_binary_message("docker", remote or "local server"),
                "session_id": session_id,
            }

        if is_windows and remote:
            # ── Windows remote: generate .ps1 serve runner ──
            remote_runner = f".{session_id}_run.ps1"
            ps_lines = []
            ps_lines.append('$sessionDir = "$env:TEMP\\odysseus-sessions"')
            ps_lines.append('New-Item -ItemType Directory -Force -Path $sessionDir | Out-Null')
            if req.hf_token:
                ps_lines.append(f"$env:HF_TOKEN = '{_ps_squote(req.hf_token)}'")
            if req.gpus:
                ps_lines.append(f"$env:CUDA_VISIBLE_DEVICES = '{req.gpus}'")
            if req.env_prefix:
                ps_lines.append(_safe_env_prefix(req.env_prefix))
            # 如果命令使用 ollama，自动安装（已在上面翻译过，不变）
            if "ollama" in req.cmd:
                ps_lines.append('# 检查 ollama 是否可用')
                ps_lines.append('if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {')
                ps_lines.append('  Write-Host "Ollama not found. Please install from https://ollama.com/download/windows"')
                ps_lines.append('  exit 1')
                ps_lines.append('}')
            elif "llama_cpp" in req.cmd or "llama-server" in req.cmd:
                ps_lines.append('# 如果缺失，自动安装 llama-cpp-python')
                ps_lines.append('try { python -c "import llama_cpp" 2>$null } catch {}')
                ps_lines.append('if ($LASTEXITCODE -ne 0) {')
                ps_lines.append('  Write-Host "Installing llama-cpp-python..."')
                ps_lines.append('  python -m pip install llama-cpp-python[server]')
                ps_lines.append('}')
            elif "vllm" in req.cmd:
                ps_lines.append('Write-Host "ERROR: vLLM is not supported on Windows. Use Ollama or llama.cpp instead."')
                ps_lines.append('exit 1')
            ps_lines.append(req.cmd)
            if is_pip_install:
                ps_lines.append('if ($LASTEXITCODE -eq 0) { Write-Host ""; Write-Host "DOWNLOAD_OK" }')
            ps_lines.append('Write-Host ""')
            ps_lines.append('Write-Host "=== Process exited with code $LASTEXITCODE ==="')
            runner_path = TMUX_LOG_DIR / f"{session_id}_run.ps1"
            runner_path.write_text("\r\n".join(ps_lines) + "\r\n", encoding="utf-8")

            _port = req.ssh_port
            _Pf = f"-P {_port} " if _port and _port != "22" else ""
            _pf = f"-p {_port} " if _port and _port != "22" else ""
            launch_ps = (
                "$sd = \\\"$env:TEMP\\odysseus-sessions\\\"; "
                f"Start-Process powershell -ArgumentList '-ExecutionPolicy','Bypass','-File','$HOME\\{remote_runner}' "
                f"-RedirectStandardOutput \\\"$sd\\{session_id}.log\\\" "
                f"-RedirectStandardError \\\"$sd\\{session_id}.err.log\\\" "
                f"-NoNewWindow -PassThru | ForEach-Object {{ $_.Id | Out-File \\\"$sd\\{session_id}.pid\\\" }}"
            )
            setup_cmd = (
                f"scp -O {_Pf}-q '{runner_path}' {remote}:{remote_runner} && "
                f'ssh {_pf}{remote} "powershell -Command \\"{launch_ps}\\""'
            )
        else:
            # ── Linux/Termux: bash + tmux (existing flow) ──
            runner_lines = ["#!/bin/bash"]
            # Mirror every line of stdout+stderr into a persistent log file
            # on the host running the serve. This is the file tail_serve_output
            # reads when the tmux pane has been overwritten by the post-crash
            # bash prompt — without it, the agent's diagnostic tool sees the
            # neofetch 横幅而不是实际的 Python traceback。
            # We save the original fds to 3/4 so we can RESTORE them before
            # `exec ${SHELL}` at the end of the script. Without that restore,
            # the post-crash interactive shell's neofetch banner ALSO gets
            # teed into the log file and `tail -N` returns ONLY the banner —
            # `tail -N` 只返回横幅 — 实际的 traceback 在 tail 窗口之前。
            runner_lines.append("mkdir -p /tmp/odysseus-tmux 2>/dev/null || true")
            runner_lines.append("exec 3>&1 4>&2")
            runner_lines.append(
                f"exec > >(tee -a /tmp/odysseus-tmux/{session_id}.log) 2>&1"
            )
            runner_lines.extend(_user_shell_path_bootstrap())
            runner_lines.append('ODYSSEUS_PREFLIGHT_EXIT=""')
            # 将 Odysseus 自己的 venv bin 加入 PATH（仅限本地运行），
            # 以便 serve shell 解析绑定的 python3/hf，镜像下载流程。
            if not remote:
                runner_lines.append(_local_tooling_path_export(sys.executable))
            runner_lines.append("export FLASHINFER_DISABLE_VERSION_CHECK=1")
            if req.hf_token:
                runner_lines.append(f"export HF_TOKEN='{_bash_squote(req.hf_token)}'")
            if req.gpus:
                runner_lines.append(f"export CUDA_VISIBLE_DEVICES='{req.gpus}'")
            if req.env_prefix:
                runner_lines.append(_safe_env_prefix(req.env_prefix))
            else:
                runner_lines.append("deactivate 2>/dev/null; hash -r")
            # 显示 HF token 是否到达了此服务器（已掩码）— 受控的
            # vLLM 需要下载的模型，没有它会被拒绝。
            runner_lines.append(_HF_TOKEN_STATUS_SNIPPET)
            handled_ollama_serve = False
            # 如果推理引擎缺失，自动安装
            if "llama_cpp" in req.cmd or "llama-server" in req.cmd:
                # 优先使用 NATIVE llama-server 二进制文件 — 它的 minja 模板
                # 渲染现代 GGUF 聊天模板，Python 绑定的 Jinja2 无法处理
                #（do_tojson ensure_ascii）。如果缺失从源码构建一次；
                # llama-cpp-python 仅作为后备。
                runner_lines.append('# 确保 llama.cpp 服务器（优先原生 llama-server）')
                # 包含 Homebrew bin 目录，以便找到通过 brew 安装的 llama-server /
                # ollama（否则 macOS 回退到缓慢的源码构建）。
                # /opt/homebrew = Apple Silicon, /usr/local = Intel；在 Linux 上无害。
                runner_lines.append('export PATH="$HOME/.local/bin:$HOME/bin:$HOME/llama.cpp/build/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"')
                runner_lines.append('if [ -d /data/data/com.termux ]; then')
                runner_lines.append('  # Termux：无原生构建 — 使用 Python 绑定（CPU）。')
                runner_lines.append('  if ! python3 -c "import llama_cpp" 2>/dev/null; then')
                runner_lines.append('    pkg install -y cmake 2>/dev/null')
                runner_lines.append('    pip install numpy diskcache jinja2 2>/dev/null')
                runner_lines.append('    CMAKE_ARGS="-DGGML_BLAS=OFF -DGGML_LLAMAFILE=OFF" pip install \'llama-cpp-python[server]\' --no-build-isolation --no-cache-dir 2>&1 || true')
                runner_lines.append('  fi')
                runner_lines.append('elif ! command -v llama-server &>/dev/null; then')
                runner_lines.append('  echo "Native llama-server not found — building from source (one-time, may take a few minutes)..."')
                runner_lines.append('  mkdir -p ~/bin')
                runner_lines.append('  cd ~ && [ -d llama.cpp ] || git clone --depth 1 https://github.com/ggml-org/llama.cpp')
                # Build with the right accelerator: Metal on macOS (llama.cpp
                # enables it automatically, no flag), CUDA on Linux when present,
                # nproc 仅 Linux 可用 — 在 macOS 上回退到 `sysctl hw.ncpu`。
                #（提示：`brew install llama.cpp` 提供预构建的 llama-server 跳过整个源码构建。）
                # a prebuilt llama-server and skips this whole source build.)
                runner_lines.append('  NPROC="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"')
                runner_lines.append('  if [ "$(uname -s)" = "Darwin" ]; then')
                runner_lines.append('    command -v cmake >/dev/null 2>&1 || echo "WARNING: cmake not found — install it with: brew install cmake (or: brew install llama.cpp for a prebuilt llama-server)."')
                # 从干净的缓存开始：之前失败的配置（如 CUDA 尝试）
                # 会污染 build/CMakeCache.txt，所以普通的 `cmake -B build`
                # 会重用错误设置并再次失败。显式设置 CMAKE_BUILD_TYPE
                # 以确保二进制文件优化（macOS 上 Metal 自动启用）。
                runner_lines.append('    cd ~/llama.cpp && rm -rf build && cmake -B build -DCMAKE_BUILD_TYPE=Release \\')
                runner_lines.append('      && cmake --build build -j"$NPROC" --target llama-server \\')
                runner_lines.append('      && ln -sf ~/llama.cpp/build/bin/llama-server ~/bin/llama-server')
                runner_lines.append('  else')
                _append_llama_cpp_linux_accel_build_lines(runner_lines)
                runner_lines.append('  fi')
                runner_lines.append('  # 如果原生构建失败，回退到 Python 绑定。')
                runner_lines.append('  if ! command -v llama-server &>/dev/null && ! python3 -c "import llama_cpp" 2>/dev/null; then')
                runner_lines.append('    echo "llama-server build failed — installing Python bindings as fallback..."')
                runner_lines.append(f"    {_pip_install_fallback_chain('llama-cpp-python[server]', python_cmd='pip')} || true")
                runner_lines.append('  fi')
                runner_lines.append('  if ! command -v llama-server &>/dev/null && ! python3 -c "import llama_cpp" 2>/dev/null; then')
                runner_lines.append('    echo "ERROR: llama.cpp serving is not available after install/build attempts."')
                runner_lines.append('    ODYSSEUS_PREFLIGHT_EXIT=127')
                runner_lines.append('  fi')
                runner_lines.append('fi')
            elif re.search(r"\bollama\s+serve\b", req.cmd):
                handled_ollama_serve = True
                _ollama_default_host = "0.0.0.0" if remote else "127.0.0.1"
                _ollama_host, _ollama_port = _ollama_bind_from_cmd(
                    req.cmd,
                    default_host=_ollama_default_host,
                )
                # 始终在 tmux 下启动新的 ollama，以便 Stop 可靠地杀死它。
                # kills it. If the requested port is busy (e.g. a systemd
                # ollama on 11434), scan upward for a free one rather than
                # silently reattaching to an external service that Stop
                # 触及的外部服务。
                runner_lines.append(f'ODYSSEUS_OLLAMA_HOST={_bash_squote(_ollama_host)}')
                runner_lines.append(f'ODYSSEUS_OLLAMA_PORT="{_ollama_port}"')
                runner_lines.append('for _ody_off in 0 1 2 3 4 5 6 7 8 9; do')
                runner_lines.append('  _ody_try_port=$((ODYSSEUS_OLLAMA_PORT + _ody_off))')
                runner_lines.append('  if ! (exec 3<>/dev/tcp/127.0.0.1/$_ody_try_port) 2>/dev/null; then')
                runner_lines.append('    exec 3<&-; exec 3>&-')
                runner_lines.append('    ODYSSEUS_OLLAMA_PORT="$_ody_try_port"')
                runner_lines.append('    break')
                runner_lines.append('  fi')
                runner_lines.append('  exec 3<&-; exec 3>&-')
                runner_lines.append('done')
                runner_lines.append('if ! command -v ollama &>/dev/null; then')
                runner_lines.append('  echo "ERROR: Ollama not found on this server. Install it from https://ollama.com/download or `curl -fsSL https://ollama.com/install.sh | sh`."')
                runner_lines.append('  echo')
                runner_lines.append('  echo "=== Process exited with code 127 ==="')
                runner_lines.append('  exec bash -i')
                runner_lines.append('fi')
                runner_lines.append('ODYSSEUS_OLLAMA_URL="http://${ODYSSEUS_OLLAMA_HOST}:${ODYSSEUS_OLLAMA_PORT}"')
                if remote and _ollama_host in ("0.0.0.0", "::"):
                    runner_lines.append('echo "[odysseus] WARNING: remote Ollama will bind to ${ODYSSEUS_OLLAMA_HOST}:${ODYSSEUS_OLLAMA_PORT} so Odysseus can reach it from this host."')
                    runner_lines.append('echo "[odysseus] Ollama has no built-in authentication; expose this only on a trusted LAN/VPN or provide an explicit OLLAMA_HOST with your own access controls."')
                runner_lines.append('echo "Starting ollama server on ${ODYSSEUS_OLLAMA_HOST}:${ODYSSEUS_OLLAMA_PORT}..."')
                runner_lines.append('OLLAMA_HOST="${ODYSSEUS_OLLAMA_HOST}:${ODYSSEUS_OLLAMA_PORT}" ollama serve')
                runner_lines.append('_ody_exit=$?')
                runner_lines.append('echo')
                runner_lines.append('echo "=== Process exited with code ${_ody_exit} ==="')
                runner_lines.append('exec bash -i')
            elif "vllm serve" in req.cmd:
                # vLLM is CUDA/ROCm-only and does not run on macOS at all.
                runner_lines.append('if [ "$(uname -s)" = "Darwin" ]; then')
                runner_lines.append('  echo "ERROR: vLLM does not run on macOS. Use Ollama or llama.cpp (Metal) instead."')
                runner_lines.append('  ODYSSEUS_PREFLIGHT_EXIT=1')
                runner_lines.append('fi')
                # 首先将 ~/.local/bin 加入 PATH — 没有 venv 时，vllm 通过 --user
                # 安装到那里，非登录 serve shell 否则找不到 `vllm` CLI
                #（"command not found"）。镜像上面的 llama.cpp。
                runner_lines.append('export PATH="$HOME/.local/bin:$PATH"')
                runner_lines.append('if ! command -v vllm &>/dev/null; then')
                runner_lines.append('  echo "ERROR: vLLM is not installed."')
                runner_lines.append('  ODYSSEUS_PREFLIGHT_EXIT=127')
                runner_lines.append('fi')
            elif "sglang.launch_server" in req.cmd:
                runner_lines.append('export PATH="$HOME/.local/bin:$PATH"')
                runner_lines.append('if ! command -v sglang &>/dev/null; then')
                runner_lines.append('  echo "ERROR: SGLang is not installed."')
                runner_lines.append('  ODYSSEUS_PREFLIGHT_EXIT=127')
                runner_lines.append('elif ! ODYSSEUS_SGLANG_IMPORT_ERROR="$(python3 -c "import sglang" 2>&1)"; then')
                runner_lines.append('  echo "ERROR: SGLang is installed but failed to import."')
                runner_lines.append('  printf "%s\\n" "$ODYSSEUS_SGLANG_IMPORT_ERROR"')
                runner_lines.append('  ODYSSEUS_PREFLIGHT_EXIT=127')
                runner_lines.append('fi')
            elif "scripts/diffusion_server.py" in req.cmd or ".diffusion_server.py" in req.cmd:
                runner_lines.append('export PATH="$HOME/.local/bin:$PATH"')
                runner_lines.append('if ! ODYSSEUS_DIFFUSION_IMPORT_ERROR="$(python3 -c "import torch, diffusers" 2>&1)"; then')
                runner_lines.append('  echo "ERROR: Diffusion serving requires PyTorch + diffusers."')
                runner_lines.append('  printf "%s\\n" "$ODYSSEUS_DIFFUSION_IMPORT_ERROR"')
                runner_lines.append('  ODYSSEUS_PREFLIGHT_EXIT=127')
                runner_lines.append('fi')

            handled_ollama_sidecar_probe = False
            if (not handled_ollama_serve
                and re.search(r"\bdocker\s+exec\s+(?:ollama-rocm|ollama-test)\s+ollama\s+show\b", req.cmd or "")):
                handled_ollama_sidecar_probe = True
                _append_serve_preflight_exit_lines(
                    runner_lines,
                    keep_shell_open=not local_windows,
                )
                runner_lines.append(req.cmd)
                runner_lines.append('_ody_exit=$?')
                runner_lines.append('echo')
                runner_lines.append('echo "=== Process exited with code ${_ody_exit} ==="')
                runner_lines.append('if [ "$_ody_exit" -eq 0 ]; then')
                runner_lines.append('  echo "[odysseus] Ollama sidecar model is available; keeping Cookbook task attached to the persistent Ollama daemon."')
                runner_lines.append('  while true; do sleep 3600; done')
                runner_lines.append('fi')
                runner_lines.append('exec bash -i')

            if not handled_ollama_serve and not handled_ollama_sidecar_probe:
                _append_serve_preflight_exit_lines(
                    runner_lines,
                    keep_shell_open=not local_windows,
                )
                runner_lines.append(req.cmd)
                if local_windows:
                    # 分离后台进程 — 无需保持交互式 shell 打开。
                    # 打印状态轮询器查找的退出标记，然后停止。
                    _append_serve_exit_code_lines(
                        runner_lines,
                        keep_shell_open=False,
                        is_pip_install=is_pip_install,
                    )
                else:
                    # 退出后保持 shell 打开，以便用户可以看到错误
                    _append_serve_exit_code_lines(
                        runner_lines,
                        keep_shell_open=True,
                        is_pip_install=is_pip_install,
                    )

            runner_path = TMUX_LOG_DIR / f"{session_id}_run.sh"
            runner_path.write_text("\n".join(runner_lines) + "\n", encoding="utf-8")
            # chmod 在 Windows 上无操作；Windows 上的 bash 运行脚本
            # 不受可执行位影响。
            safe_chmod(runner_path, 0o755)

            if local_windows:
                # 本地 Windows：以分离模式启动 bash 运行器（tmux 替代方案）。
                setup_cmd = None
            elif remote:
                remote_runner = f".{session_id}_run.sh"
                # 如果命令引用了 scripts/，也 scp 它们
                scp_extras = ""
                _port = req.ssh_port
                _Pf = f"-P {_port} " if _port and _port != "22" else ""
                _pf = f"-p {_port} " if _port and _port != "22" else ""
                if "scripts/diffusion_server.py" in req.cmd:
                    from core.constants import BASE_DIR
                    diff_script = Path(BASE_DIR) / "scripts" / "diffusion_server.py"
                    if diff_script.exists():
                        scp_extras = f"scp -O {_Pf}-q '{diff_script}' {remote}:.diffusion_server.py && "
                        runner_path.write_text(
                            runner_path.read_text(encoding="utf-8").replace(
                                "scripts/diffusion_server.py", ".diffusion_server.py"
                            ),
                            encoding="utf-8",
                        )
                setup_cmd = (
                    f"{scp_extras}"
                    f"scp -O {_Pf}-q '{runner_path}' {remote}:{remote_runner} && "
                    f"ssh {_pf}{remote} 'chmod +x {remote_runner} && tmux set-option -g history-limit 100000 2>/dev/null; tmux new-session -d -s {session_id} \"./{remote_runner}\"'"
                )
            else:
                setup_cmd = f"tmux set-option -g history-limit 100000 2>/dev/null; tmux new-session -d -s {session_id} {shlex.quote(str(runner_path))}"

        if setup_cmd is None:
            # 本地 Windows：以分离模式启动 bash 运行器；无 tmux setup_cmd。
            try:
                _launch_local_detached(session_id, runner_lines)
            except Exception as e:
                logger.error(f"Local detached serve launch failed: {e}")
                return {"ok": False, "error": str(e), "session_id": session_id}
        else:
            proc = await asyncio.create_subprocess_shell(
                setup_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.wait()

            if proc.returncode != 0:
                stderr = (await proc.stderr.read()).decode(errors="replace")
                return {"ok": False, "error": stderr, "session_id": session_id}

        # 自动注册模型端点，以便服务的模型无需手动 /setup 步骤
        # 就能出现在模型选择器中。Diffusion 模型获得 image 端点；
        # 任何其他真正的模型服务（即非 pip-install 任务）获得
        # 指向其 /v1 的本地 LLM 端点。
        endpoint_id = None
        is_diffusion = "diffusion_server.py" in req.cmd
        if is_diffusion:
            endpoint_id = _auto_register_image_endpoint(req, remote)
        elif not is_pip_install:
            endpoint_id = _auto_register_llm_endpoint(req, remote)

        # Crash watchdog: the auto-register above writes the endpoint row
        # IMMEDIATELY (before the server has even bound its port) so the
        # picker shows the model as it warms up. When the serve process
        # crashes right at startup (missing module, bad cmd, port collision,
        # ModuleNotFoundError on llama_cpp 等），端点会被遗留为
        # dangling — every subsequent chat returns 503 or an empty response.
        # Schedule a background task to read the tmux output for the
        # "=== Process exited with code N ===" 标记的 tmux 输出；
        # if N != 0 within the watch window, delete the endpoint we just
        # 对 diffusion（不同的 image-endpoint 清理路径）和 pip-install
        # path) and pip-install tasks (no endpoint to drop).
        if endpoint_id and not is_diffusion and not is_pip_install:
            asyncio.create_task(_serve_crash_watchdog(
                endpoint_id=endpoint_id,
                session_id=session_id,
                remote=remote,
                ssh_port=req.ssh_port,
                is_windows=is_windows,
            ))

        # 记录到 assistant
        try:
            from src.assistant_log import log_to_assistant
            from src.auth_helpers import get_current_user
            owner = get_current_user(request)
            short = req.repo_id.split("/")[-1] if "/" in req.repo_id else req.repo_id
            log_to_assistant(
                owner,
                f"Started serving {short} on {remote or 'local'}",
                category="Serve",
            )
        except Exception:
            pass

        return {"ok": True, "session_id": session_id, "remote": remote or "local",
                "endpoint_id": endpoint_id}

    # ── Server setup (install deps on remote) ──

    class SetupRequest(BaseModel):
        host: str
        ssh_port: str | None = None

    @router.post("/api/cookbook/setup")
    async def server_setup(request: Request, req: SetupRequest):
        """通过 SSH 在远程服务器上安装所需依赖。"""
        require_admin(request)
        host = validate_remote_host(req.host)
        if not host:
            raise HTTPException(400, "host is required")
        port = req.ssh_port
        port = validate_ssh_port(port)
        pf = f"-p {port} " if port and port != "22" else ""

        # 检测平台：先 Windows（echo %OS% → Windows_NT），再 Termux，最后 Linux
        detect_cmd = f'ssh {pf}{host} "echo %OS%"'
        platform = "linux"
        try:
            proc = await asyncio.create_subprocess_shell(
                detect_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            out = stdout.decode().strip()
            if "Windows_NT" in out:
                platform = "windows"
            else:
                # 检查 Termux
                detect_cmd2 = f"ssh {pf}{host} 'test -d /data/data/com.termux && echo termux || echo linux'"
                proc2 = await asyncio.create_subprocess_shell(
                    detect_cmd2, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
                )
                stdout2, _ = await asyncio.wait_for(proc2.communicate(), timeout=10)
                platform = stdout2.decode().strip()
        except Exception:
            platform = "linux"

        if platform == "windows":
            # Windows 设置：通过 PowerShell 确保 Python + pip + huggingface-hub
            # 同时为后台任务创建会话目录
            setup_script = (
                'powershell -Command "'
                "New-Item -ItemType Directory -Force -Path $env:TEMP\\odysseus-sessions | Out-Null; "
                "try { python --version } catch { Write-Host 'ERROR: Python not found — install from python.org'; exit 1 }; "
                "python -m pip install -q huggingface-hub 2>$null; "
                "python -c \\\"from huggingface_hub import snapshot_download; print('OK')\\\""
                '"'
            )
            cmd = f'ssh {pf}{host} {setup_script}'
        elif platform == "termux":
            setup_script = (
                "pkg install -y python tmux 2>/dev/null; "
                "pip install --no-deps -q huggingface-hub 2>/dev/null; "
                "pip install -q filelock fsspec packaging pyyaml tqdm typer httpx requests 2>/dev/null; "
                "python3 -c 'from huggingface_hub import snapshot_download; print(\"OK\")'"
            )
            cmd = f"ssh {pf}{host} '{setup_script}'"
        else:
            # Linux：自动安装 tmux（通过可用的包管理器）
            # 和 huggingface_hub + hf_transfer（在 PEP-668 锁定的发行版
            # 如 Arch / 新版 Debian 上回退到 --user/--break-system-packages）。
            setup_script = (
                # 如果缺失安装 tmux — 尝试常见包管理器；无 sudo 则跳过
                "if ! command -v tmux >/dev/null 2>&1; then "
                "  if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y tmux 2>/dev/null; "
                "  elif command -v pacman >/dev/null 2>&1; then sudo -n pacman -S --noconfirm tmux 2>/dev/null; "
                "  elif command -v dnf >/dev/null 2>&1; then sudo -n dnf install -y tmux 2>/dev/null; "
                "  elif command -v apk >/dev/null 2>&1; then sudo -n apk add --no-interactive tmux 2>/dev/null; "
                "  elif command -v zypper >/dev/null 2>&1; then sudo -n zypper --non-interactive install tmux 2>/dev/null; "
                "  fi; "
                "fi; "
                "command -v tmux >/dev/null 2>&1 || echo 'WARNING: tmux missing and auto-install failed (need passwordless sudo). Install manually.'; "
                # 安装 Python 组件。先尝试系统安装；在 PEP 668 系统上回退到 --user --break-system-packages。
                "pip install -q huggingface_hub hf_transfer 2>/dev/null || "
                "pip install --user --break-system-packages -q huggingface_hub hf_transfer 2>/dev/null || "
                "pip3 install --user --break-system-packages -q huggingface_hub hf_transfer 2>/dev/null; "
                "python3 -c 'from huggingface_hub import snapshot_download; print(\"OK\")'"
            )
            cmd = f"ssh {pf}{host} '{setup_script}'"

        try:
            proc = await asyncio.create_subprocess_shell(
                cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
            output = stdout.decode() + stderr.decode()
            ok = "OK" in output
            return {"ok": ok, "output": output.strip(), "platform": platform}
        except asyncio.TimeoutError:
            return {"ok": False, "error": "Setup timed out (120s)", "platform": platform}
        except Exception as e:
            return {"ok": False, "error": str(e), "platform": platform}

    # ── GPU availability probe ──

    async def _run_nvidia_smi(query: str, host: str | None, ssh_port: str | None, timeout: int = 8):
        """在本地或通过 SSH 运行 nvidia-smi。返回 (stdout, error_or_None)。"""
        if host:
            pf = f"-p {ssh_port} " if ssh_port and ssh_port != "22" else ""
            cmd = f"ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no {pf}{host} '{query}'"
            proc = await asyncio.create_subprocess_shell(
                cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
        else:
            proc = await asyncio.create_subprocess_exec(
                *shlex.split(query),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return None, "nvidia-smi timed out"
        if proc.returncode != 0:
            err = (stderr.decode("utf-8", errors="replace") or "").strip()[:200]
            return None, err or "nvidia-smi failed"
        return stdout.decode("utf-8", errors="replace"), None

    async def _run_gpu_shell(cmd_text: str, host: str | None, ssh_port: str | None, timeout: int = 8):
        """在本地或通过 SSH 运行小型 GPU 探针 shell 命令。"""
        if host:
            pf = f"-p {ssh_port} " if ssh_port and ssh_port != "22" else ""
            quoted_cmd = shlex.quote(cmd_text)
            remote_cmd = (
                f"if command -v sh >/dev/null 2>&1; then sh -lc {quoted_cmd}; "
                f"elif command -v bash >/dev/null 2>&1; then bash -lc {quoted_cmd}; "
                f"elif command -v zsh >/dev/null 2>&1; then zsh -lc {quoted_cmd}; "
                "else echo 'No POSIX shell found for GPU probe' >&2; exit 127; fi"
            )
            cmd = f"ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no {pf}{host} {shlex.quote(remote_cmd)}"
            proc = await asyncio.create_subprocess_shell(
                cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
        else:
            proc = await asyncio.create_subprocess_shell(
                cmd_text, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return None, "GPU probe timed out"
        if proc.returncode != 0:
            err = (stderr.decode("utf-8", errors="replace") or "").strip()[:200]
            return None, err or f"GPU probe failed ({proc.returncode})"
        return stdout.decode("utf-8", errors="replace"), None

    async def _gpu_read_file(path: str, host: str | None, ssh_port: str | None) -> str | None:
        out, err = await _run_gpu_shell(f"cat {shlex.quote(path)} 2>/dev/null", host, ssh_port, timeout=4)
        if err is not None or out is None:
            return None
        return out.strip()

    async def _probe_gpu_device_processes(host: str | None, ssh_port: str | None) -> list[dict]:
        pid_cmd = (
            "{ command -v lsof >/dev/null 2>&1 && "
            "lsof -w -t /dev/kfd /dev/dri/renderD* 2>/dev/null || true; "
            "command -v fuser >/dev/null 2>&1 && "
            "fuser /dev/kfd /dev/dri/renderD* 2>/dev/null || true; } "
            "| tr ' ' '\\n' | sed '/^[0-9][0-9]*$/!d' | sort -n -u"
        )
        out, err = await _run_gpu_shell(pid_cmd, host, ssh_port, timeout=5)
        if err is not None or not out:
            return []
        processes = []
        seen = set()
        for raw in out.splitlines():
            try:
                pid = int(raw.strip())
            except ValueError:
                continue
            if pid in seen:
                continue
            seen.add(pid)
            name_out, _ = await _run_gpu_shell(f"ps -p {pid} -o comm= 2>/dev/null", host, ssh_port, timeout=3)
            name = (name_out or "").strip().splitlines()[0] if (name_out or "").strip() else "process"
            processes.append({"pid": pid, "name": name[:80], "used_mb": 0})
        return processes

    async def _probe_amd_sysfs(host: str | None, ssh_port: str | None) -> list[dict]:
        out, err = await _run_gpu_shell("ls -1 /sys/class/drm 2>/dev/null", host, ssh_port, timeout=4)
        if err is not None or not out:
            return []
        gpus = []
        for entry in out.split():
            if not entry.startswith("card") or "-" in entry:
                continue
            base = f"/sys/class/drm/{entry}/device"
            vendor = await _gpu_read_file(f"{base}/vendor", host, ssh_port)
            if vendor != "0x1002":
                continue
            vram_raw = await _gpu_read_file(f"{base}/mem_info_vram_total", host, ssh_port)
            vis_raw = await _gpu_read_file(f"{base}/mem_info_vis_vram_total", host, ssh_port)
            gtt_raw = await _gpu_read_file(f"{base}/mem_info_gtt_total", host, ssh_port)
            vram_bytes = int(vram_raw) if vram_raw and vram_raw.isdigit() else 0
            vis_bytes = int(vis_raw) if vis_raw and vis_raw.isdigit() else 0
            gtt_bytes = int(gtt_raw) if gtt_raw and gtt_raw.isdigit() else 0
            total_bytes = max(vram_bytes, vis_bytes)
            used_attr = "mem_info_vis_vram_used" if vis_bytes and vis_bytes >= vram_bytes else "mem_info_vram_used"
            unified = bool(vis_bytes and vis_bytes >= vram_bytes)
            if total_bytes <= 0:
                total_bytes = gtt_bytes
                used_attr = "mem_info_gtt_used"
                unified = True
            if total_bytes <= 0:
                continue
            used_raw = await _gpu_read_file(f"{base}/{used_attr}", host, ssh_port)
            used_bytes = int(used_raw) if used_raw and used_raw.isdigit() else 0
            name = await _gpu_read_file(f"{base}/product_name", host, ssh_port)
            if not name:
                device = await _gpu_read_file(f"{base}/device", host, ssh_port)
                name = f"AMD GPU {device or entry}"
            total_mb = max(0, int(total_bytes / (1024 * 1024)))
            used_mb = max(0, min(total_mb, int(used_bytes / (1024 * 1024))))
            free_mb = max(0, total_mb - used_mb)
            # GTT = GPU 在 VRAM 满时将页面换入的系统 RAM 池。
            # 在独立显卡上，大的 gtt_used 表示模型通过 PCIe
            # 溢出 VRAM 到了 RAM — 速度极慢。将其暴露出来以便 UI 可以
            # 警告"spilling to RAM"，而不是让用户疑惑为什么这么慢。
            gtt_used_raw = await _gpu_read_file(f"{base}/mem_info_gtt_used", host, ssh_port)
            gtt_used_mb = max(0, int(int(gtt_used_raw) / (1024 * 1024))) if (gtt_used_raw and gtt_used_raw.isdigit()) else 0
            gpus.append({
                "index": len(gpus), "name": name, "uuid": entry,
                "free_mb": free_mb, "total_mb": total_mb, "used_mb": used_mb,
                "gtt_used_mb": gtt_used_mb,
                "util_pct": 0, "busy": bool(total_mb and (free_mb / total_mb) < 0.85),
                "processes": [], "backend": "rocm", "source": "amd-sysfs",
                "unified_memory": unified,
            })
        if gpus:
            processes = await _probe_gpu_device_processes(host, ssh_port)
            if processes:
                gpus[0]["processes"] = processes
                gpus[0]["busy"] = True
        return gpus

    @router.get("/api/cookbook/gpus")
    async def list_gpus(request: Request, host: str | None = None, ssh_port: str | None = None):
        """Probe GPU memory/process state locally or via SSH.

        Probe order:
            1. NVIDIA via nvidia-smi
            2. AMD/ROCm and unified-memory APUs via /sys/class/drm
            3. Generic GPU device holders via /dev/kfd and /dev/dri/renderD*

        Returned shape:
            { "ok": True, "gpus": [
                {"index": 0, "name": "...", "free_mb": int, "total_mb": int,
                 "used_mb": int, "util_pct": int, "busy": bool,
                 "uuid": "GPU-...",
                 "processes": [{"pid": int, "name": str, "used_mb": int}, ...]
                }, ...
            ]}
        `busy` is True when free_mb/total_mb < 0.5.
        """
        require_admin(request)
        host = validate_remote_host(host)
        ssh_port = validate_ssh_port(ssh_port)
        gpu_query = "nvidia-smi --query-gpu=index,name,memory.free,memory.total,memory.used,utilization.gpu,uuid --format=csv,noheader,nounits"
        nvidia_error = None
        try:
            gpu_out, err = await _run_nvidia_smi(gpu_query, host, ssh_port)
            if err is not None:
                nvidia_error = err
                gpu_out = ""
        except FileNotFoundError:
            nvidia_error = "nvidia-smi not found"
            gpu_out = ""
        except Exception as e:
            nvidia_error = str(e)[:200]
            gpu_out = ""

        gpus = []
        uuid_to_idx: dict[str, int] = {}
        for line in (gpu_out or "").strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 7:
                continue
            try:
                idx = int(parts[0])
                name = parts[1]
                free_mb = int(float(parts[2]))
                total_mb = int(float(parts[3]))
                used_mb = int(float(parts[4]))
                util_pct = int(float(parts[5]))
                gpu_uuid = parts[6]
            except (ValueError, IndexError):
                continue
            busy = total_mb > 0 and (free_mb / total_mb) < 0.5
            uuid_to_idx[gpu_uuid] = idx
            gpus.append({
                "index": idx, "name": name, "uuid": gpu_uuid,
                "free_mb": free_mb, "total_mb": total_mb,
                "used_mb": used_mb, "util_pct": util_pct,
                "busy": busy, "processes": [],
            })

        # 尽力列进程 — 失败时静默跳过
        proc_query = "nvidia-smi --query-compute-apps=pid,gpu_uuid,process_name,used_memory --format=csv,noheader,nounits"
        try:
            proc_out, proc_err = await _run_nvidia_smi(proc_query, host, ssh_port, timeout=5)
            if proc_err is None and proc_out:
                gpus_by_idx = {g["index"]: g for g in gpus}
                for line in proc_out.strip().splitlines():
                    parts = [p.strip() for p in line.split(",")]
                    if len(parts) < 4:
                        continue
                    try:
                        pid = int(parts[0])
                        pname = parts[2]
                        pmem = int(float(parts[3]))
                    except (ValueError, IndexError):
                        continue
                    idx = uuid_to_idx.get(parts[1])
                    if idx is None or idx not in gpus_by_idx:
                        continue
                    gpus_by_idx[idx]["processes"].append({
                        "pid": pid, "name": pname, "used_mb": pmem,
                    })
        except Exception:
            pass

        if gpus:
            return {"ok": True, "gpus": gpus, "backend": "cuda", "source": "nvidia-smi"}

        # 本地 Apple Silicon / Metal 回退。macOS 没有 nvidia-smi 也没有
        # Linux /sys/class/drm 树，但 services.hwfit.hardware 已经知道
        # 如何计算共享统一内存 GPU 预算。保持此路由同步，
        # 以便 Cookbook 的 GPU 选择器在原生 Mac 启动时不显示
        # "nvidia-smi not found"。
        if not host and sys.platform == "darwin":
            try:
                from services.hwfit.hardware import detect_system
                info = detect_system(fresh=True)
                backend = str(info.get("backend") or "").lower()
                if backend in {"metal", "mps", "apple"} and info.get("gpu_count", 0) > 0:
                    total_mb = int(float(info.get("gpu_vram_gb") or info.get("total_ram_gb") or 0) * 1024)
                    free_mb = int(float(info.get("available_ram_gb") or 0) * 1024)
                    if total_mb and (free_mb <= 0 or free_mb > total_mb):
                        free_mb = total_mb
                    used_mb = max(0, total_mb - max(0, free_mb))
                    return {
                        "ok": True,
                        "gpus": [{
                            "index": 0,
                            "name": info.get("gpu_name") or info.get("cpu_name") or "Apple Silicon GPU",
                            "uuid": "apple-metal-0",
                            "free_mb": max(0, free_mb),
                            "total_mb": max(0, total_mb),
                            "used_mb": used_mb,
                            "util_pct": 0,
                            "busy": bool(total_mb and (free_mb / total_mb) < 0.5),
                            "processes": [],
                            "backend": "metal",
                            "source": "apple-metal",
                            "unified_memory": True,
                        }],
                        "backend": "metal",
                        "source": "apple-metal",
                        "fallback_from": "nvidia-smi",
                        "nvidia_error": nvidia_error,
                    }
            except Exception as e:
                logger.warning("Apple Metal GPU fallback failed: %s", e)

        amd_gpus = await _probe_amd_sysfs(host, ssh_port)
        if amd_gpus:
            return {
                "ok": True,
                "gpus": amd_gpus,
                "backend": "rocm",
                "source": "amd-sysfs",
                "fallback_from": "nvidia-smi",
                "nvidia_error": nvidia_error,
            }

        processes = await _probe_gpu_device_processes(host, ssh_port)
        if processes:
            return {
                "ok": True,
                "gpus": [{
                    "index": 0, "name": "GPU device holders", "uuid": "dev-dri",
                    "free_mb": 0, "total_mb": 0, "used_mb": 0, "util_pct": 0,
                    "busy": True, "processes": processes,
                    "backend": "generic", "source": "gpu-devices",
                }],
                "backend": "generic",
                "source": "gpu-devices",
                "fallback_from": "nvidia-smi",
                "nvidia_error": nvidia_error,
            }

        return {"ok": False, "error": nvidia_error or "No GPU memory probe available", "gpus": []}

    class KillPidRequest(BaseModel):
        pid: int
        host: str | None = None
        ssh_port: str | None = None
        signal: str = "TERM"  # TERM（优雅）或 KILL（强制）

    @router.post("/api/cookbook/kill-pid")
    async def kill_pid(request: Request, req: KillPidRequest):
        """杀死正在占用 GPU 内存的 PID。

        Admin-gated. Validates PID is positive int, signal is TERM/KILL, and
        forbids low PIDs (<100) to avoid accidentally signalling init/system
        以避免意外信号 init/系统守护进程。使用 `kill -<sig> <pid>` 在本地或通过 SSH 执行。
        """
        require_admin(request)
        if req.pid < 100:
            raise HTTPException(400, f"Refusing to signal PID {req.pid} (<100, likely system process)")
        sig = (req.signal or "TERM").upper()
        if sig not in ("TERM", "KILL", "INT"):
            raise HTTPException(400, "signal must be TERM, KILL, or INT")
        host = validate_remote_host(req.host)
        req.ssh_port = validate_ssh_port(req.ssh_port)
        kill_cmd = f"kill -{sig} {req.pid}"
        try:
            if host:
                pf = f"-p {req.ssh_port} " if req.ssh_port and req.ssh_port != "22" else ""
                cmd = f"ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no {pf}{host} '{kill_cmd}'"
                proc = await asyncio.create_subprocess_shell(
                    cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
                )
            elif IS_WINDOWS:
                # Windows 上没有 `kill` 二进制文件 / POSIX 信号。taskkill /F /T 会终止
                # PID 及其子进程。没有优雅-vs-强制的区分，
                # 所以 TERM/KILL/INT 都映射到相同的强制杀死。
                # 注意：永远不要在这里用 os.kill(pid, 0) 探针 — 在 Windows 上
                # 这会路由到 TerminateProcess 并杀死进程。
                if not pid_alive(req.pid):
                    return {"ok": False, "error": f"PID {req.pid} is not running"}
                await asyncio.to_thread(kill_process_tree, req.pid)
                return {"ok": True, "pid": req.pid, "signal": sig}
            else:
                proc = await asyncio.create_subprocess_exec(
                    "kill", f"-{sig}", str(req.pid),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5)
            if proc.returncode != 0:
                err = (stderr.decode("utf-8", errors="replace") or "").strip()[:200]
                return {"ok": False, "error": err or f"kill returned {proc.returncode}"}
            return {"ok": True, "pid": req.pid, "signal": sig}
        except asyncio.TimeoutError:
            return {"ok": False, "error": "kill command timed out"}
        except Exception as e:
            return {"ok": False, "error": str(e)[:200]}

    # ── Cookbook state persistence (cross-device sync) ──

    @router.get("/api/cookbook/state")
    async def get_cookbook_state(request: Request):
        """加载已保存的 cookbook 状态（任务、服务器、预设、设置）。"""
        require_admin(request)
        if _cookbook_state_path.exists():
            try:
                return _state_for_client(json.loads(_cookbook_state_path.read_text(encoding="utf-8")))
            except Exception:
                return {}
        return {}

    @router.post("/api/cookbook/state")
    async def save_cookbook_state(request: Request):
        """保存 cookbook 状态用于跨设备同步。

        需要管理员权限，因为 cookbook 状态在轮询 tmux 会话状态时会被读回
        shell-quoting 上下文中（见 status handler）。

        Merge guard: the UI debounces a `_syncToServer` POST every few
        seconds with whatever localStorage has. The agent's tool layer
        writes server-side tasks (e.g. `download_model` registering a
        task). Without a merge, every UI sync wipes the agent's recent
        additions. We preserve any on-disk task that the incoming body
        omits but was added in the last RACE_WINDOW seconds — that's a
        race, not an intentional delete.
        """
        require_admin(request)
        RACE_WINDOW_MS = 60_000
        try:
            from core.atomic_io import atomic_write_json
            data = await request.json()
            if not isinstance(data, dict):
                data = {}
            try:
                if _cookbook_state_path.exists():
                    on_disk = json.loads(_cookbook_state_path.read_text(encoding="utf-8"))
                else:
                    on_disk = {}
            except Exception:
                on_disk = {}
            # env servers 防擦除保护。UI 防抖同步内存中的任何内容；
            # sync of whatever is in memory; if it fires before the state has
            # hydrated from GET /state (a load-time race) or during a render
            # glitch, `env.servers` would be empty and silently overwrite the
            # saved servers on disk. Never let an empty/absent incoming
            # env.servers clobber a populated on-disk one — preserve the disk
            # values while still accepting the rest of the incoming env.
            disk_env = on_disk.get("env") if isinstance(on_disk, dict) and isinstance(on_disk.get("env"), dict) else None
            if disk_env:
                inc_env = data.get("env") if isinstance(data.get("env"), dict) else None
                if inc_env is None:
                    data["env"] = disk_env
                    logger.warning("cookbook state POST: incoming body had no env; preserved on-disk env (anti-wipe guard)")
                elif disk_env.get("servers") and not inc_env.get("servers"):
                    inc_env["servers"] = disk_env["servers"]
                    logger.warning("cookbook state POST: incoming env.servers empty; preserved on-disk servers (anti-wipe guard)")

            disk_tasks = on_disk.get("tasks") or [] if isinstance(on_disk, dict) else []
            incoming_tasks = data.get("tasks") if isinstance(data.get("tasks"), list) else []
            # Anti-poisoning guard: a stale browser tab can keep POSTing a
            # download task as status='done' from before the strict-finish
            # fix landed, undoing any server-side correction. For each
            # incoming "done" download, override to "running" if the last
            # DOWNLOAD_OK/DOWNLOAD_FAILED//snapshots/ 标记，则覆盖为 "running"。
            # /snapshots/ sentinel is in the output.
            import re as _re_dl
            for _it in incoming_tasks:
                if (not isinstance(_it, dict)) or _it.get("type") != "download" or _it.get("status") != "done":
                    continue
                _out = _it.get("output") or ""
                if ("DOWNLOAD_OK" in _out) or ("DOWNLOAD_FAILED" in _out) or ("/snapshots/" in _out):
                    continue
                _shards = _re_dl.findall(r"model-(\d+)-of-(\d+)\.safetensors", _out)
                if _shards:
                    _n, _tot = _shards[-1]
                    if int(_n) < int(_tot):
                        logger.info(f"cookbook state POST: rejecting stale done for {_it.get('sessionId')} "
                                    f"(last shard {_n}/{_tot}, no DOWNLOAD_OK)")
                        _it["status"] = "running"
                else:
                    _completed = _out.count("Download complete")
                    _starts = _out.count("Downloading '")
                    if _starts > _completed:
                        logger.info(f"cookbook state POST: rejecting stale done for {_it.get('sessionId')} "
                                    f"({_completed}/{_starts} files complete, no DOWNLOAD_OK)")
                        _it["status"] = "running"
            incoming_ids = {t.get("sessionId") for t in incoming_tasks if isinstance(t, dict) and t.get("sessionId")}
            import time as _t
            now_ms = int(_t.time() * 1000)
            preserved = []
            for t in disk_tasks:
                if not isinstance(t, dict):
                    continue
                sid = t.get("sessionId")
                if not sid or sid in incoming_ids:
                    continue  # client's version wins
                ts = t.get("ts") or 0
                if isinstance(ts, (int, float)) and (now_ms - ts) <= RACE_WINDOW_MS:
                    preserved.append(t)
            if preserved:
                logger.info(f"cookbook state POST: preserving {len(preserved)} recent task(s) "
                            f"not in incoming body (race guard): "
                            f"{[t.get('sessionId') for t in preserved]}")
                data["tasks"] = incoming_tasks + preserved
            atomic_write_json(str(_cookbook_state_path), _state_for_storage(data, on_disk), indent=2)
            return {"ok": True, "preserved": len(preserved)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    @router.get("/api/cookbook/hf-latest")
    async def hf_latest(vram_gb: float = 0, limit: int = 10, pipeline: str = "text-generation", owner: str = Depends(require_user)):
        """获取最新的 HuggingFace 模型，按能装入可用 VRAM 的条件过滤。

        vram_gb: 可用总 VRAM（GB）。0 = 不过滤（返回全部）。
        limit:   返回多少模型（默认 10）。
        pipeline: HF pipeline_tag 过滤器（text-generation, text-to-image 等）。
        """
        import re
        import httpx

        # 获取更大的池以便有足够内容过滤（我们会丢弃约 80%）
        pool_size = max(limit * 15, 100)
        url = (
            "https://huggingface.co/api/models"
            f"?sort=trendingScore&direction=-1&limit={pool_size}&filter={pipeline}"
        )
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(url)
                if resp.status_code != 200:
                    return {"models": [], "error": f"HF API HTTP {resp.status_code}"}
                raw = resp.json()
        except Exception as e:
            return {"models": [], "error": str(e)}

        # 从模型 id 估算 VRAM。查找类似 "7B"、"70B"、"1.5B" 等的模式。
        # 返回 fp16 下近似的 VRAM（GB）（参数数*2）。调用者根据量化调整。
        def _est_vram_fp16(repo_id: str) -> float | None:
            m = re.search(r'[-_/](\d+(?:\.\d+)?)\s*[Bb](?![a-zA-Z])', repo_id)
            if not m:
                return None
            params_b = float(m.group(1))
            return params_b * 2.0  # fp16 baseline

        # 从 repo_id / tags 检测量化。返回 fp16 大小的乘数。
        def _quant_factor(repo_id: str, tags: list) -> float:
            text = (repo_id + " " + " ".join(tags or [])).lower()
            if "fp4" in text or "nf4" in text or "int4" in text or "4bit" in text or "q4" in text or "awq" in text or "gptq" in text:
                return 0.25
            if "int8" in text or "8bit" in text or "q8" in text or "fp8" in text:
                return 0.5
            if "bf16" in text or "fp16" in text:
                return 1.0
            return 1.0  # default fp16

        # 排除适配器、LoRAs、数据集、仅 GGUF 仓库和其他不可运行的构件
        EXCLUDE_TAG_SUBSTRINGS = (
            "lora", "adapter", "peft", "qlora",
            "dataset", "embeddings",
            "merge", "control-lora",
            "diffusion-lora", "stable-diffusion-lora",
            "text-classification", "token-classification",
            "feature-extraction", "sentence-similarity",
        )
        EXCLUDE_NAME_SUBSTRINGS = (
            "lora", "adapter", "peft", "qlora",
            "embedding", "embed-",
            "dataset",
        )

        def _is_excluded(repo_id: str, tags: list) -> bool:
            text = repo_id.lower()
            for s in EXCLUDE_NAME_SUBSTRINGS:
                if s in text:
                    return True
            tag_text = " ".join(t.lower() for t in (tags or []))
            for s in EXCLUDE_TAG_SUBSTRINGS:
                if s in tag_text:
                    return True
            return False

        out = []
        for entry in raw:
            repo_id = entry.get("modelId") or entry.get("id") or ""
            if not repo_id:
                continue
            tags = entry.get("tags") or []
            pipeline_tag = entry.get("pipeline_tag") or ""

            # 硬过滤：仅请求的 pipeline（HF 的 filter 参数较宽松）
            if pipeline and pipeline_tag and pipeline_tag != pipeline:
                continue
            # 跳过适配器、LoRAs、数据集等。
            if _is_excluded(repo_id, tags):
                continue

            est_fp16 = _est_vram_fp16(repo_id)
            quant_mult = _quant_factor(repo_id, tags)
            est_vram = (est_fp16 * quant_mult) if est_fp16 else None
            # 为 KV 缓存、激活等增加 30% 余量。
            needed_vram = (est_vram * 1.3) if est_vram else None

            if vram_gb > 0 and needed_vram is not None and needed_vram > vram_gb:
                continue
            # 未知大小模型（如 MiniMax-M2.7, DeepSeek-V4-Flash）的仓库 id 中
            # "NB" in the repo id, so the regex above can't extract their
            # param count. Previously we dropped them entirely, which made
            # brand-new flagship releases silently vanish from this list even
            # on rigs with hundreds of GB of VRAM. Adapters/LoRAs are already
            # 适配器/LoRAs 已被 _is_excluded() 过滤，
            # overwhelmingly full models — keep them, just without a size
            # 只是不带大小标记（前端会优雅处理 needed_vram_gb=null）。

            out.append({
                "repo_id": repo_id,
                "downloads": entry.get("downloads", 0),
                "likes": entry.get("likes", 0),
                "createdAt": entry.get("createdAt", ""),
                "tags": tags[:5],  # trim
                "pipeline_tag": pipeline_tag,
                "est_vram_gb": round(est_vram, 1) if est_vram else None,
                "needed_vram_gb": round(needed_vram, 1) if needed_vram else None,
            })
            if len(out) >= limit:
                break

        return {"models": out}

    # 孤儿 tmux 采纳扫描的速率限制。60s 间隔使 SSH 工作
    # 即使在活跃轮询的 cookbook 页面上也真正稀疏。
    _last_orphan_sweep_ts = [0.0]
    _ORPHAN_SWEEP_MIN_INTERVAL_S = 60.0
    # 并发保护，防止两个竞态请求都触发扫描。
    _orphan_sweep_inflight = [False]

    def _maybe_sweep_orphans(tasks: list, state: dict) -> None:
        """扫描每个已配置的 cookbook 服务器上的 `serve-*` tmux 会话并
        the cookbook doesn't know about and adopt them into state.tasks.

        Heavy SSH work runs in a background thread via asyncio.to_thread so
        it never blocks the request that triggered it. Was previously
        disabled because the sync implementation pegged uvicorn CPU during
        active cookbook polling — re-enabled now with the work pushed off
        the event loop and a slower (60s) cadence.
        """
        import time as _time
        now = _time.monotonic()
        if _orphan_sweep_inflight[0]:
            return
        if now - _last_orphan_sweep_ts[0] < _ORPHAN_SWEEP_MIN_INTERVAL_S:
            return
        _last_orphan_sweep_ts[0] = now
        _orphan_sweep_inflight[0] = True
        # 快照输入，使工作线程不与状态变更竞态。
        try:
            tasks_snap = list(tasks or [])
        except Exception:
            tasks_snap = []
        state_snap = state if isinstance(state, dict) else {}

        # 调用者是 _cookbook_tasks_status_sync（同步上下文，无事件循环）。
        # 使用普通后台线程 — 不需要 asyncio。
        import threading
        def _run_sweep() -> None:
            try:
                _sync_sweep_orphans(tasks_snap, state_snap)
            except Exception as _e:
                logger.warning(f"orphan sweep thread failed: {_e!r}")
            finally:
                _orphan_sweep_inflight[0] = False
        try:
            threading.Thread(target=_run_sweep, daemon=True, name="orphan-sweep").start()
        except Exception as _e:
            logger.warning(f"orphan sweep thread spawn failed: {_e!r}")
            _orphan_sweep_inflight[0] = False
        return

    def _sync_sweep_orphans(tasks: list, state: dict) -> None:
        """实际的同步扫描 — 绝不在事件循环中调用。"""
        import subprocess
        env = state.get("env") if isinstance(state, dict) else {}
        servers = env.get("servers") if isinstance(env, dict) else []
        logger.info(f"orphan sweep starting: {len(servers) if isinstance(servers, list) else 0} server(s), known_sids={len([t for t in tasks if isinstance(t, dict) and t.get('sessionId')])}")
        if not isinstance(servers, list):
            return

        known_sids = {
            t.get("sessionId") for t in tasks
            if isinstance(t, dict) and t.get("sessionId")
        }

        adopted_any = False
        for srv in servers:
            if not isinstance(srv, dict):
                continue
            host = (srv.get("host") or "").strip()
            if not host:
                continue  # local-only entry; the /proc scan handles it
            try:
                host = validate_remote_host(host)
            except HTTPException:
                continue
            sport = str(srv.get("port") or "").strip()
            ssh_base = ["ssh", "-o", "ConnectTimeout=4", "-o", "StrictHostKeyChecking=no"]
            if sport and sport != "22":
                try:
                    sport = validate_ssh_port(sport)
                except HTTPException:
                    continue
                if sport != "22":
                    ssh_base.extend(["-p", sport])

            try:
                ls = subprocess.run(
                    ssh_base + [host, "tmux ls 2>/dev/null"],
                    timeout=6, capture_output=True, text=True,
                )
            except Exception:
                continue
            for line in (ls.stdout or "").splitlines():
                sid = line.split(":", 1)[0].strip()
                if not sid or not _SESSION_ID_RE.match(sid):
                    continue
                if sid in known_sids:
                    continue
                # 只显示 bash 提示符 — 采纳它会用 "running" 任务污染 UI，
                # known model-server process (checked below). The earlier
                #（下面检查）。之前的 prefix gate（serve-/cookbook-）
                # serves whenever tmux fell back to numeric IDs, leaving
                # 使其在 Cookbook UI 中不可见 — 所以用户
                # python/vllm/等进程。
                # 跳过僵尸/空闲 shell 会话。崩溃的 vllm 留下的 tmux 会话
                # over from a crashed vllm just shows a bash prompt —
                # 只显示 bash 提示符 — 采纳它会用 "running" 任务污染 UI，
                # 而这些任务实际上并未提供任何服务。pane_current_command
                # is the foreground process in the pane right now; only
                # python/vllm/等进程。
                try:
                    pc = subprocess.run(
                        ssh_base + [host, "tmux", "list-panes", "-t", sid,
                                    "-F", "#{pane_current_command}"],
                        timeout=4, capture_output=True, text=True,
                    )
                    cur = (pc.stdout or "").strip().splitlines()
                except Exception:
                    cur = []
                LIVE_PROCS = {"python", "python3", "vllm", "llama-server",
                              "llama_cpp_main", "sglang", "lmdeploy",
                              "ollama", "node", "uvicorn"}
                if not any(c in LIVE_PROCS for c in cur):
                    continue
                # 尝试从窗格缓冲区恢复合理的 repo_id + 端口。
                # 廉价启发式 — 如果做不到，用占位字段注册；
                # UI 仍会显示它。
                try:
                    cap = subprocess.run(
                        ssh_base + [host, "tmux", "capture-pane", "-t", sid, "-p", "-S", "-300"],
                        timeout=6, capture_output=True, text=True,
                    )
                    pane = cap.stdout or ""
                except Exception:
                    pane = ""
                import re as _re_orphan
                # vLLM 横幅："model   /path/..."。如果横幅已滚出
                # 则回退到原始 vllm-serve 命令。
                m_model = _re_orphan.search(r"model\s+(\S+)", pane)
                model = m_model.group(1) if m_model else ""
                if not model:
                    m_serve = _re_orphan.search(r"vllm\s+serve\s+(\S+)", pane)
                    model = m_serve.group(1) if m_serve else f"adopted:{sid}"
                m_port = _re_orphan.search(r"--port\s+(\d+)", pane)
                port = int(m_port.group(1)) if m_port else 0

                import time as _t2
                tasks.append({
                    "id": sid,
                    "sessionId": sid,
                    "name": model.split("/")[-1] if "/" in model else model,
                    "type": "serve",
                    "status": "running",
                    "output": f"Auto-adopted from orphan tmux session on {host}. "
                              "Open the task to see live output.",
                    "ts": int(_t2.time() * 1000),
                    "payload": {
                        "repo_id": model,
                        "remote_host": host,
                        "_cmd": "(orphan tmux session — original launch cmd unknown)",
                        "port": port,
                    },
                    "remoteHost": host,
                    "sshPort": sport,
                    "platform": "linux",
                    "_serveReady": False,
                    "_endpointAdded": False,
                    "_adoptedExternally": True,
                })
                known_sids.add(sid)
                adopted_any = True
                logger.info(f"auto-adopted orphan tmux session {sid!r} on {host}")

        if adopted_any:
            try:
                from core.atomic_io import atomic_write_json
                state["tasks"] = tasks
                atomic_write_json(_cookbook_state_path, state)
            except Exception as e:
                logger.warning(f"orphan sweep: state write failed: {e}")

    # Ollama 库抓取的内存缓存。ollama.com 是公开网站，
    # 但不提供稳定的 JSON 列表 — 我们抓取 HTML 搜索页面并
    # 用正则提取模型卡片。缓存 1 小时，使繁忙的 cookbook 视图
    # 不会在每次渲染时冲击网站。
    _ollama_library_cache: dict = {"models": [], "fetched_at": 0.0, "error": None}

    _OLLAMA_FALLBACK_LIBRARY = [
        {"name": "qwen2.5", "description": "Qwen2.5 series — strong general/coding model from Alibaba.", "sizes": ["0.5b", "1.5b", "3b", "7b", "14b", "32b", "72b"]},
        {"name": "qwen2.5-coder", "description": "Code-specialized Qwen2.5 family.", "sizes": ["0.5b", "1.5b", "3b", "7b", "14b", "32b"]},
        {"name": "qwen3", "description": "Qwen3 — newer Alibaba family with hybrid reasoning.", "sizes": ["0.6b", "1.7b", "4b", "8b", "14b", "32b"]},
        {"name": "llama3.2", "description": "Meta Llama 3.2 instruct (and tiny / vision variants).", "sizes": ["1b", "3b", "11b", "90b"]},
        {"name": "llama3.1", "description": "Meta Llama 3.1 instruct.", "sizes": ["8b", "70b", "405b"]},
        {"name": "llama3.3", "description": "Meta Llama 3.3 70B instruct.", "sizes": ["70b"]},
        {"name": "gemma3", "description": "Google Gemma 3 — multimodal capable open-weights.", "sizes": ["1b", "4b", "12b", "27b"]},
        {"name": "gemma2", "description": "Google Gemma 2 instruct.", "sizes": ["2b", "9b", "27b"]},
        {"name": "mistral", "description": "Mistral 7B instruct — small, fast generalist.", "sizes": ["7b"]},
        {"name": "mistral-nemo", "description": "Mistral NeMo 12B instruct.", "sizes": ["12b"]},
        {"name": "mistral-small", "description": "Mistral Small 22B / 24B instruct.", "sizes": ["22b", "24b"]},
        {"name": "mixtral", "description": "Mistral MoE 8x7B / 8x22B.", "sizes": ["8x7b", "8x22b"]},
        {"name": "phi3", "description": "Microsoft Phi-3 small / medium.", "sizes": ["mini", "medium"]},
        {"name": "phi4", "description": "Microsoft Phi-4 14B.", "sizes": ["14b"]},
        {"name": "deepseek-r1", "description": "DeepSeek R1 reasoning model (distilled variants).", "sizes": ["1.5b", "7b", "8b", "14b", "32b", "70b"]},
        {"name": "deepseek-v3", "description": "DeepSeek V3 MoE 671B (huge — needs serious VRAM).", "sizes": ["671b"]},
        {"name": "codellama", "description": "Meta Code Llama instruct family.", "sizes": ["7b", "13b", "34b", "70b"]},
        {"name": "starcoder2", "description": "BigCode StarCoder2 — code completion.", "sizes": ["3b", "7b", "15b"]},
        {"name": "deepseek-coder-v2", "description": "DeepSeek Coder V2 — code MoE.", "sizes": ["16b", "236b"]},
        {"name": "nomic-embed-text", "description": "Embedding model — text vector encoder.", "sizes": ["latest"]},
        {"name": "mxbai-embed-large", "description": "Embedding model — Mixedbread large.", "sizes": ["latest"]},
        {"name": "llava", "description": "LLaVA multimodal vision-language model.", "sizes": ["7b", "13b", "34b"]},
        {"name": "minicpm-v", "description": "MiniCPM-V multimodal.", "sizes": ["8b"]},
        {"name": "command-r", "description": "Cohere Command R — RAG-oriented.", "sizes": ["35b"]},
        {"name": "command-r-plus", "description": "Cohere Command R+ — larger RAG model.", "sizes": ["104b"]},
        {"name": "qwq", "description": "Qwen QwQ reasoning preview.", "sizes": ["32b"]},
        {"name": "smollm2", "description": "HuggingFaceTB SmolLM2 — tiny capable models.", "sizes": ["135m", "360m", "1.7b"]},
        {"name": "granite3.1-dense", "description": "IBM Granite 3.1 dense instruct.", "sizes": ["2b", "8b"]},
        {"name": "nemotron", "description": "NVIDIA Nemotron 70B.", "sizes": ["70b"]},
        {"name": "olmo2", "description": "AI2 OLMo 2 open-weights.", "sizes": ["7b", "13b"]},
    ]

    @router.get("/api/cookbook/ollama/library")
    async def ollama_library(refresh: int = 0, request: Request = None, owner: str = Depends(require_user)):
        """列出 Browse 选择器中流行的 Ollama 库模型。

        Tries a 1-hour-cached fetch of ollama.com/library, falls back to a
        curated hard-coded list so the picker always renders something."""
        import time as _time
        import httpx as _httpx
        TTL = 3600.0
        now = _time.time()
        if refresh or (now - _ollama_library_cache["fetched_at"]) > TTL or not _ollama_library_cache["models"]:
            models: list[dict] = []
            err = None
            try:
                async with _httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
                    resp = await client.get(
                        "https://ollama.com/search?sort=popular",
                        headers={"User-Agent": "odysseus-cookbook/1.0"},
                    )
                if resp.status_code == 200:
                    html = resp.text
                    # ollama.com 将每个模型卡片渲染为单个锚点：
                    #   <a href="/library/<name>" class="group w-full"> … </a>
                    # 描述和大小都在该锚点内。提取整个块
                    # 然后单独提取各部分。
                    block_re = re.compile(
                        r'<a[^>]*href="/library/([A-Za-z0-9._-]+)"[^>]*>(.*?)</a>',
                        re.DOTALL,
                    )
                    desc_re = re.compile(r'<p[^>]*>([^<]{4,400})</p>', re.DOTALL)
                    # ollama.com 卡片上的大小标签如 "0.5b"、"14b"、
                    # "8x7b"、"27b"。从短 <span> 包裹的芯片中提取。
                    size_re = re.compile(r'>\s*(\d+(?:\.\d+)?(?:x\d+)?[bBmM])\s*<')
                    seen: set[str] = set()
                    for bm in block_re.finditer(html):
                        name = bm.group(1).strip()
                        if name in seen:
                            continue
                        seen.add(name)
                        body = bm.group(2)
                        dm = desc_re.search(body)
                        desc = (dm.group(1).strip() if dm else "").replace("\n", " ")
                        sizes_raw = size_re.findall(body)
                        # 去重大小保持顺序
                        sizes: list[str] = []
                        for s in sizes_raw:
                            s_low = s.lower()
                            if s_low not in sizes:
                                sizes.append(s_low)
                        models.append({"name": name, "description": desc, "sizes": sizes})
                        if len(models) >= 80:
                            break
                else:
                    err = f"HTTP {resp.status_code}"
            except Exception as e:
                err = str(e)[:160]
            # 合并精选回退，使经典模型（qwen2.5, llama3, deepseek-r1,
            # …）即使在 ollama.com 首页被用户可能不想要的
            # 全新版本占据时仍可访问。
            live_names = {m["name"] for m in models}
            for fb in _OLLAMA_FALLBACK_LIBRARY:
                if fb["name"] not in live_names:
                    models.append(fb)
            if not models:
                models = list(_OLLAMA_FALLBACK_LIBRARY)
                if err is None:
                    err = "parsed 0 results — using fallback list"
            _ollama_library_cache["models"] = models
            _ollama_library_cache["fetched_at"] = now
            _ollama_library_cache["error"] = err
        return {
            "models": _ollama_library_cache["models"],
            "fetched_at": _ollama_library_cache["fetched_at"],
            "error": _ollama_library_cache["error"],
        }

    # ── vLLM recipe scraper ─────────────────────────────────────────────
    # Fetches the official YAML recipe for a model from vllm-project/recipes
    # and normalizes it into a small JSON the frontend can consume. Cached
    # per-repo so the GitHub raw endpoint isn't hammered.
    _vllm_recipe_cache: dict[str, tuple[float, dict | None]] = {}
    # Manifest of all <org>/<model> ids that have a recipe in the upstream
    # repo. Cheap to fetch (one Git Tree API call), so we cache the whole
    # set for ~12h. Per-row "does this model have a recipe?" lookups hit
    # this set instead of doing 912 individual recipe fetches.
    _vllm_recipe_manifest: dict = {"fetched_at": 0.0, "models": set(), "error": ""}

    @router.get("/api/cookbook/vllm-recipe-manifest")
    async def vllm_recipe_manifest(refresh: int = 0):
        """Return the set of <org>/<model> ids known to have a vLLM recipe.
        One GitHub Tree API call, 12h cache. The frontend uses this to badge
        rows in the model list before the user expands them."""
        import time as _time
        import httpx as _httpx
        TTL = 12 * 3600.0
        now = _time.time()
        if (
            refresh
            or (now - _vllm_recipe_manifest["fetched_at"]) > TTL
            or not _vllm_recipe_manifest["models"]
        ):
            url = (
                "https://api.github.com/repos/vllm-project/recipes/"
                "git/trees/main?recursive=1"
            )
            def _fetch_sync() -> tuple[int, dict | None, str]:
                try:
                    headers = {"Accept": "application/vnd.github+json"}
                    with _httpx.Client(timeout=10.0, follow_redirects=True) as client:
                        r = client.get(url, headers=headers)
                        if r.status_code != 200:
                            return r.status_code, None, r.text[:200]
                        return 200, r.json(), ""
                except Exception as e:
                    return 0, None, f"fetch error: {e}"
            status, data, err = await asyncio.to_thread(_fetch_sync)
            if status == 200 and isinstance(data, dict):
                models: set[str] = set()
                for entry in data.get("tree") or []:
                    path = (entry or {}).get("path") or ""
                    if not path.startswith("models/") or not path.endswith(".yaml"):
                        continue
                    # path = "models/<org>/<model>.yaml" → "<org>/<model>"
                    body = path[len("models/"):-len(".yaml")]
                    if "/" in body:
                        models.add(body)
                _vllm_recipe_manifest["models"] = models
                _vllm_recipe_manifest["fetched_at"] = now
                _vllm_recipe_manifest["error"] = ""
            else:
                _vllm_recipe_manifest["error"] = (
                    f"HTTP {status}: {err}" if status else err
                )
                # Don't clobber a stale-but-usable list on transient failures.
                if not _vllm_recipe_manifest["models"]:
                    return {
                        "models": [],
                        "count": 0,
                        "error": _vllm_recipe_manifest["error"],
                    }
        return {
            "models": sorted(_vllm_recipe_manifest["models"]),
            "count": len(_vllm_recipe_manifest["models"]),
            "fetched_at": _vllm_recipe_manifest["fetched_at"],
            "error": _vllm_recipe_manifest["error"],
        }

    @router.get("/api/cookbook/vllm-recipe")
    async def vllm_recipe(repo: str, refresh: int = 0):
        """Return the vLLM official recipe for a HuggingFace repo, if one
        exists at vllm-project/recipes. `repo` is the full HF id like
        'MiniMaxAI/MiniMax-M2'. Cached 6h."""
        import time as _time
        import httpx as _httpx
        import yaml as _yaml

        TTL = 6 * 3600.0
        now = _time.time()
        repo = (repo or "").strip().strip("/")
        if "/" not in repo:
            return {"exists": False, "error": "repo must be <org>/<model>"}

        cached = _vllm_recipe_cache.get(repo)
        if cached and not refresh and (now - cached[0]) < TTL:
            return cached[1] or {"exists": False, "cached": True}

        url = (
            f"https://raw.githubusercontent.com/vllm-project/recipes/"
            f"main/models/{repo}.yaml"
        )

        def _fetch_sync() -> tuple[int, str]:
            try:
                with _httpx.Client(timeout=8.0, follow_redirects=True) as client:
                    r = client.get(url)
                    return r.status_code, r.text
            except Exception as e:
                return 0, f"fetch error: {e}"

        status, text = await asyncio.to_thread(_fetch_sync)
        if status == 404:
            _vllm_recipe_cache[repo] = (now, {"exists": False})
            return {"exists": False}
        if status != 200:
            return {"exists": False, "error": f"HTTP {status}", "transient": True}

        try:
            doc = _yaml.safe_load(text) or {}
        except Exception as e:
            return {"exists": False, "error": f"yaml parse: {e}"}

        meta = doc.get("meta") or {}
        model = doc.get("model") or {}
        features = doc.get("features") or {}
        deps = doc.get("dependencies") or []
        variants = doc.get("variants") or {}
        hw_overrides = doc.get("hardware_overrides") or {}
        strat_overrides = doc.get("strategy_overrides") or {}

        # Tool-call + reasoning parsers, as flat arg arrays, so the frontend
        # can drop them straight into the launch command.
        tool_calling = features.get("tool_calling") or {}
        reasoning = features.get("reasoning") or {}

        normalized = {
            "exists": True,
            "source_url": url,
            "title": meta.get("title") or "",
            "provider": meta.get("provider") or "",
            "description": meta.get("description") or "",
            "date_updated": str(meta.get("date_updated") or ""),
            "hardware_support": meta.get("hardware") or {},
            "model_id": model.get("model_id") or repo,
            "min_vllm_version": model.get("min_vllm_version") or "",
            "architecture": model.get("architecture") or "",
            "parameter_count": model.get("parameter_count") or "",
            "active_parameters": model.get("active_parameters") or "",
            "context_length": model.get("context_length") or 0,
            "base_args": list(model.get("base_args") or []),
            "base_env": dict(model.get("base_env") or {}),
            "tool_calling": {
                "description": tool_calling.get("description") or "",
                "args": list(tool_calling.get("args") or []),
            } if tool_calling else None,
            "reasoning": {
                "description": reasoning.get("description") or "",
                "args": list(reasoning.get("args") or []),
            } if reasoning else None,
            "dependencies": [
                {
                    "note": (d.get("note") or "").strip(),
                    "command": (d.get("command") or "").strip(),
                    "optional": bool(d.get("optional", False)),
                }
                for d in deps if isinstance(d, dict)
            ],
            "variants": {
                k: {
                    "model_id": v.get("model_id") or model.get("model_id") or repo,
                    "precision": v.get("precision") or "",
                    "vram_minimum_gb": v.get("vram_minimum_gb") or 0,
                    "description": v.get("description") or "",
                    "extra_args": list(v.get("extra_args") or []),
                    "extra_env": dict(v.get("extra_env") or {}),
                }
                for k, v in variants.items() if isinstance(v, dict)
            },
            "hardware_overrides": {
                hw: {
                    "extra_args": list((ov or {}).get("extra_args") or []),
                    "extra_env": dict((ov or {}).get("extra_env") or {}),
                }
                for hw, ov in hw_overrides.items() if isinstance(ov, dict)
            },
            "strategy_overrides": {
                strat: dict(ov or {})
                for strat, ov in strat_overrides.items() if isinstance(ov, dict)
            },
            "compatible_strategies": list(doc.get("compatible_strategies") or []),
        }
        _vllm_recipe_cache[repo] = (now, normalized)
        return normalized

    @router.get("/api/cookbook/tasks/status")
    async def cookbook_tasks_status(request: Request):
        """检查所有活跃 cookbook tmux 会话的状态。

        Critical: every subprocess.run inside this handler is a sync blocking
        call that — when this was a plain async def — froze the entire server
        event loop. Now the whole body runs in a worker thread via
        asyncio.to_thread so other requests stay responsive."""
        require_admin(request)
        return await asyncio.to_thread(_cookbook_tasks_status_sync)

    def _cookbook_tasks_status_sync():
        import subprocess

        def _download_cache_complete(repo_id: str, remote_host: str = "", ssh_port: str = "", cache_root: str = "") -> bool:
            """尽力检查已完成的 HF 缓存条目。

            tmux output can stop at a stale progress line if the pane/session
            tmux 输出可能在 Cookbook 捕获到最终 DOWNLOAD_OK 标记之前，
            In that case, trust the cache shape: a snapshot directory with files
            blobs 表示 HuggingFace 已完成模型物化。
            model. cache_root is the task's custom download dir — the runner
            pointed HF_HOME there, so the cache lives under <cache_root>/hub,
            not wherever this probe's environment says.
            """
            if not repo_id or "/" not in repo_id:
                return False
            cmd = ["python3", "-c", HF_CACHE_COMPLETE_PROBE, repo_id, cache_root or ""]
            try:
                if remote_host:
                    ssh_base = ["ssh"]
                    if ssh_port and ssh_port != "22":
                        ssh_base.extend(["-p", str(ssh_port)])
                    shell_cmd = " ".join(shlex.quote(x) for x in cmd)
                    proc = subprocess.run(ssh_base + [remote_host, shell_cmd], timeout=12, capture_output=True)
                else:
                    proc = subprocess.run(cmd, timeout=12, capture_output=True)
                return proc.returncode == 0
            except Exception:
                return False

        def _download_cache_incomplete(repo_id: str, remote_host: str = "", ssh_port: str = "", cache_root: str = "") -> bool:
            """尽力检查可恢复的 HF 未完成 blob。

            丢失的 SSH/tmux 会话可能导致真实下载仍处于未完成状态。
            将任何 *.incomplete blob 视为比捕获的窗格输出中过时的
            "100%" 行更有力的证据。
            """
            if not repo_id or "/" not in repo_id:
                return False
            cmd = ["python3", "-c", HF_CACHE_INCOMPLETE_PROBE, repo_id, cache_root or ""]
            try:
                if remote_host:
                    ssh_base = ["ssh"]
                    if ssh_port and ssh_port != "22":
                        ssh_base.extend(["-p", str(ssh_port)])
                    shell_cmd = " ".join(shlex.quote(x) for x in cmd)
                    proc = subprocess.run(ssh_base + [remote_host, shell_cmd], timeout=12, capture_output=True)
                else:
                    proc = subprocess.run(cmd, timeout=12, capture_output=True)
                return proc.returncode == 0
            except Exception:
                return False

        # 从 cookbook 状态加载已保存的任务
        tasks = []
        state = {}
        if _cookbook_state_path.exists():
            try:
                state = json.loads(_cookbook_state_path.read_text(encoding="utf-8"))
                saved_tasks = state.get("tasks", [])
                if isinstance(saved_tasks, list):
                    tasks = saved_tasks
                elif isinstance(saved_tasks, dict):
                    tasks = list(saved_tasks.values())
            except Exception:
                pass

        # 孤儿 tmux 自动采纳扫描。当 agent（或任何人）通过 SSH
        # 启动 `serve-*` tmux 会话时 — 通常是因为 serve_model
        # 拒绝了 `source ... && vllm ...` 或因为通过 tmux send-keys
        # 手动重新启动 — 该会话在 cookbook UI 中不可见，
        # 即使它是正在运行的模型服务器。扫描在每个已配置的
        # 远程主机上找到这些孤儿，并以 _adoptedExternally=True
        # 写入 state.tasks，这样它们在下一次轮询时显示在 UI 中，
        # 无需任何人记住调用 adopt_served_model。
        # 通过模块级 _last_orphan_sweep 进行速率限制，
        # 防止每 3 秒 SSH 一次。
        try:
            _maybe_sweep_orphans(tasks, state)
        except Exception as _sweep_e:
            logger.warning(f"orphan sweep failed (non-fatal): {_sweep_e!r}")

        results = []
        for task in tasks:
            session_id = task.get("sessionId", "")
            if not session_id:
                continue
            remote = task.get("remoteHost", "")
            task_type = task.get("type", "download")  # "download" or "serve"
            # 字段名根据任务是通过下载流程（`repoId`）、
            # 服务流程（`modelId`）还是 UI 端服务预设
            # （使用 `name` + `payload.repo_id`）添加的而有所不同。
            _payload = task.get("payload") or {}
            model = (
                task.get("modelId")
                or task.get("repoId")
                or task.get("name")
                or _payload.get("repo_id")
                or _payload.get("modelId")
                or ""
            )
            task_platform = task.get("platform", "")

            # 检查会话是否存活 + 捕获输出
            _tport = task.get("sshPort", "")
            # 纵深防御：cookbook 状态是管理员可写的，但这些值会
            # 落入下面的 shell 插值命令中。拒绝任何非良性的
            # session-id / hostname / port 值。
            if not _SESSION_ID_RE.match(session_id):
                logger.warning(f"Skipping task with unsafe session_id: {session_id!r}")
                continue
            if remote:
                try:
                    remote = validate_remote_host(remote)
                except HTTPException:
                    logger.warning(f"Skipping task with unsafe remoteHost: {remote!r}")
                    continue
            if _tport:
                try:
                    _tport = validate_ssh_port(str(_tport))
                except HTTPException:
                    logger.warning(f"Skipping task with unsafe sshPort: {_tport!r}")
                    continue
            if task_platform == "windows" and remote:
                # Windows：检查 PID 文件 + Get-Process，读取日志尾部
                sd = "$env:TEMP\\odysseus-sessions"
                ssh_base = ["ssh"]
                if _tport and _tport != "22":
                    ssh_base.extend(["-p", str(_tport)])
                check_cmd = ssh_base + [
                    remote,
                    "powershell",
                    "-Command",
                    f"$pid = Get-Content \"{sd}\\{session_id}.pid\" -ErrorAction SilentlyContinue; "
                    "if ($pid) {{ Get-Process -Id $pid -ErrorAction SilentlyContinue | Out-Null; if ($?) {{ exit 0 }} else {{ exit 1 }} }} else {{ exit 1 }}"
                ]
                capture_cmd = ssh_base + [
                    remote,
                    "powershell",
                    "-Command",
                    f"Get-Content \"{sd}\\{session_id}.log\" -Tail 10 -ErrorAction SilentlyContinue",
                ]
            elif remote:
                ssh_base = ["ssh"]
                if _tport and _tport != "22":
                    ssh_base.extend(["-p", str(_tport)])
                check_cmd = ssh_base + [remote, "tmux", "has-session", "-t", session_id]
                # 捕获 500 行（原来是 50），以便 Python traceback 在崩溃后的
                # neofetch 横幅 + bash 提示符之前存活下来，否则这些会填满
                # 可见尾部。没有这个，output_tail 最终只是
                # "Locale: C / Ubuntu_Odysseus ❯"，agent 无法诊断实际错误。
                # can't diagnose the actual error.
                capture_cmd = ssh_base + [remote, "tmux", "capture-pane", "-t", session_id, "-p", "-S", "-500"]
            elif IS_WINDOWS:
                # 本地 Windows 任务：作为分离进程启动（无 tmux）。
                # 存活状态来自 <session>.pid 文件，输出来自包装器
                # 重定向到的 <session>.log 文件。无子进程。
                check_cmd = None
                capture_cmd = None
            else:
                check_cmd = ["tmux", "has-session", "-t", session_id]
                capture_cmd = ["tmux", "capture-pane", "-t", session_id, "-p", "-S", "-500"]

            local_win_task = (not remote) and IS_WINDOWS

            progress_text = ""
            full_snapshot = ""

            if local_win_task:
                # 分离进程模型的基于文件的存活状态 + 输出。
                pid_path = TMUX_LOG_DIR / f"{session_id}.pid"
                log_path = TMUX_LOG_DIR / f"{session_id}.log"
                task_pid = None
                try:
                    task_pid = int(pid_path.read_text(encoding="utf-8").strip())
                except Exception:
                    task_pid = None
                is_alive = pid_alive(task_pid)
                try:
                    if log_path.exists():
                        full_snapshot = log_path.read_text(
                            encoding="utf-8", errors="replace"
                        ).strip()[-12000:]
                        lines = [l.strip() for l in full_snapshot.split('\n') if l.strip()]
                        downloading_lines = [l for l in lines if l.startswith("Downloading")]
                        if downloading_lines:
                            progress_text = downloading_lines[-1]
                        elif lines:
                            progress_text = lines[-1]
                except Exception:
                    pass
            else:
                # Skip the live SSH check entirely for tasks already in a
                # terminal state — they won't change, and 10s timeouts
                # stacked per task were the dominant cost of this whole
                # status endpoint (3+ minute stalls with ~8 accumulated
                # 任务导致 3+ 分钟的停滞）。agent 的 `list_served_models`
                # was blocking the chat stream every time.
                _task_status = (task.get("status") or "").lower()
                if _task_status in {"stopped", "done", "completed",
                                    "crashed", "error", "failed",
                                    "ended", "killed"}:
                    is_alive = False
                    # 保留持久化的 output_tail 给 UI — 这是 agent
                    # 用来诊断过去失败的内容。
                    full_snapshot = (task.get("output") or "")[-12000:]
                else:
                    try:
                        alive = subprocess.run(check_cmd, timeout=4, capture_output=True)
                        is_alive = alive.returncode == 0
                    except Exception:
                        is_alive = False

                    # 捕获最后几行获取进度。优先 "Downloading" 行
                    # （真实聚合字节数）而非 "Fetching N files"（在 hf_transfer
                    # 下滞后的整文件计数）。否则回退到真正的最后一行。
                    if is_alive:
                        try:
                            cap = subprocess.run(capture_cmd, timeout=4, capture_output=True, text=True)
                            if cap.returncode == 0:
                                full_snapshot = cap.stdout.strip()
                                lines = [l.strip() for l in full_snapshot.split('\n') if l.strip()]
                                downloading_lines = [l for l in lines if l.startswith("Downloading")]
                                if downloading_lines:
                                    progress_text = downloading_lines[-1]
                                elif lines:
                                    progress_text = lines[-1]
                        except Exception:
                            pass

            # 确定状态。对于本地 Windows 分离模型，进程退出后日志文件
            # 仍然存在，所以已完成的下载仍有快照可供分类
            # （DOWNLOAD_OK / 退出标记）— 即使 PID 不存在也要评估，
            # 而不是盲目报告 "stopped"。
            download_zero_files = False
            exit_code = None
            status = "unknown"
            download_has_ok = task_type == "download" and "DOWNLOAD_OK" in full_snapshot
            download_has_failed = task_type == "download" and "DOWNLOAD_FAILED" in full_snapshot
            download_has_incomplete_evidence = (
                task_type == "download"
                and (
                    ".incomplete" in full_snapshot
                    or bool(re.search(r'model-\d+-of-\d+\.[A-Za-z0-9_.-]+:\s+(?:[0-9]|[1-8][0-9])%', full_snapshot))
                    or _download_cache_incomplete(_payload.get("repo_id") or model, remote, str(_tport or ""), _payload.get("local_dir") or "")
                )
            )
            if is_alive or (local_win_task and full_snapshot):
                lower = full_snapshot.lower()
                exit_match = re.search(r"=== process exited with code\s+(-?\d+)", full_snapshot, re.I)
                has_exit = exit_match is not None
                exit_code = int(exit_match.group(1)) if exit_match else None
                has_error = "error" in lower or "failed" in lower or "traceback" in lower
                if has_exit and task_type == "serve":
                    # 退出的服务任务始终是错误 — 它们应该无限期运行
                    status = "error"
                elif has_exit and task_type == "download":
                    # 依赖安装被跟踪为下载任务，但只发出
                    # 通用的运行器退出标记，不发出 HF 下载标记。
                    if download_has_incomplete_evidence and not download_has_ok:
                        status = "running" if is_alive else "stopped"
                    else:
                        status = "completed" if exit_code == 0 else "error"
                elif has_exit and "unrecognized arguments" in lower:
                    status = "error"
                elif has_error and not ("application startup complete" in lower):
                    status = "error"
                elif task_type == "download" and download_has_ok:
                    if re.search(r"Fetching\s+0\s+files", full_snapshot, re.IGNORECASE):
                        status = "error"
                        download_zero_files = True
                    else:
                        status = "completed"
                elif task_type == "download" and download_has_failed:
                    status = "error"
                elif task_type == "download" and download_has_incomplete_evidence:
                    status = "running" if is_alive else "stopped"
                elif "application startup complete" in lower:
                    status = "ready"
                elif not is_alive:
                    # local-Windows: process gone, log has no success/ready marker.
                    status = "stopped"
                else:
                    status = "running"
            else:
                # Session is dead — check if it completed or crashed. The
                # runner markers in the retained output are conclusive
                # (DOWNLOAD_OK only prints after exit 0), so check them before
                # the cache probe, which can't see ollama pulls at all.
                marker = classify_dead_download(full_snapshot) if task_type == "download" else None
                if marker is not None:
                    status, download_zero_files = marker
                    if status == "completed" and not progress_text:
                        progress_text = "Download complete"
                elif (
                    task_type == "download"
                    and not download_has_incomplete_evidence
                    and _download_cache_complete(_payload.get("repo_id") or model, remote, str(_tport or ""), _payload.get("local_dir") or "")
                ):
                    status = "completed"
                    if not progress_text:
                        progress_text = "Download complete"
                    if not full_snapshot:
                        full_snapshot = "DOWNLOAD_OK"
                else:
                    status = "stopped"

            # 解析结构化阶段信息 — UI 的单一事实来源
            phase_info = _parse_serve_phase(full_snapshot, task_type) if (task_type == "serve" and full_snapshot) else {}
            if phase_info.get("status") == "ready":
                status = "ready"
            serve_phase = phase_info.get("phase", "")
            diagnosis = _diagnose_serve_output(full_snapshot) if task_type == "serve" and full_snapshot else None
            if diagnosis and status in {"running", "unknown", "stopped"} and phase_info.get("status") != "ready":
                status = "error"
            if download_zero_files:
                diagnosis = {"message": "No matching files were downloaded. The model repo or filename/quant pattern may be wrong (for example a ':Q4_K_M' tag that does not exist in the repo). Check the repo and the include/quant pattern."}
            output_tail = error_aware_output_tail(full_snapshot, status)

            results.append({
                "session_id": session_id,
                "type": task_type,
                "model": model.split("/")[-1] if "/" in model else model,
                "status": status,
                "progress": serve_phase if task_type == "serve" else progress_text[:120],
                "phase": serve_phase,
                "diagnosis": diagnosis,
                "output_tail": output_tail,
                "exit_code": exit_code,
                "cmd": _payload.get("_cmd") or "",
                "tps": phase_info.get("tps"),
                "reqs": phase_info.get("reqs"),
                "pct": phase_info.get("pct"),
                "remote": remote or "local",
            })

        return {"tasks": results}

    return router
