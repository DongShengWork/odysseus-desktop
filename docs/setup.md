# Odysseus 安装指南

本页面将详细的安装、部署、故障排除和配置说明从首页 README 中分离出来。

## 快速开始

> **Branch note:** `dev` is the default branch and contains the latest development changes, but it may be unstable. For the more stable curated branch, use [`main`](https://github.com/pewdiepie-archdaemon/odysseus/tree/main).

默认配置开箱即用：克隆、运行，然后在**设置**中配置模型/搜索/邮件。仅需编辑 `.env` 文件来设置部署级覆盖项，如 `APP_BIND`、`APP_PORT`、`AUTH_ENABLED`、`DATABASE_URL` 或预置管理员密码。

首次安装时，Odysseus 创建管理员账户（默认为 `admin`，除非设置了 `ODYSSEUS_ADMIN_USER`），并在终端打印临时密码。使用 Docker 时，相同信息位于 `docker compose logs odysseus` 中。用该密码首次登录后，在**设置**中修改密码。

参与贡献？详见 [CONTRIBUTING.md](CONTRIBUTING.md) 获取开发环境、测试和 PR 指南。

### Docker（推荐）
```bash
git clone https://github.com/pewdiepie-archdaemon/odysseus.git
cd odysseus
cp .env.example .env       # optional, but recommended for explicit defaults
docker compose up -d --build
```
如需在镜像中包含可选功能（PDF 查看器、Office 文档提取，含 AGPL 协议的 PyMuPDF），在 `up` 之前构建时添加 `docker compose build --build-arg INSTALL_OPTIONAL=true`。

容器健康启动后，打开 `http://localhost:7000`。Docker Compose 默认将 Web 界面绑定到 `127.0.0.1`。如果端口被占用，在 `.env` 中设置 `APP_PORT=7001` 并重建容器。仅在确需 LAN/反向代理访问时才设置 `APP_BIND=0.0.0.0`。

> **Apple Silicon（M 系列）Mac 注意：** Docker 无法访问 Metal GPU，因此 Cookbook 仅在 CPU 上运行本地模型。要使用 GPU 加速，请原生运行 — 见下方 [Apple Silicon](#apple-silicon) 章节。

### 原生 Linux / macOS
```bash
git clone https://github.com/pewdiepie-archdaemon/odysseus.git
cd odysseus
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python setup.py
python -m uvicorn app:app --host 127.0.0.1 --port 7000
```
环境要求：Python 3.11+。Cookbook 还需要 `tmux` 用于后台模型下载和服务。应用本身很轻量；本地模型服务是重负载部分，取决于模型、运行时、GPU 和 VRAM，因此小型主机可改用 API 或远程模型服务器。仅在确需 LAN/反向代理访问时才使用 `--host 0.0.0.0`。

### Apple Silicon
macOS 上的 Docker 无法使用 Metal GPU。要在 M 系列 Mac 上运行 GPU 加速的 Cookbook，请原生运行 Odysseus：

```bash
git clone https://github.com/pewdiepie-archdaemon/odysseus.git
cd odysseus
./start-macos.sh
```

启动后访问 `http://127.0.0.1:7860`。如需通过受信任的 LAN/VPN（如 Tailscale）在手机上访问，绑定所有接口：

```bash
ODYSSEUS_HOST=0.0.0.0 ./start-macos.sh
# 然后打开 http://<tailscale-ip>:7860
```

脚本在启动时也会读取 `.env` 文件，因此其中设置的 `APP_BIND=0.0.0.0` 和 `APP_PORT` 会自动生效，无需每次运行时手动指定。

在绑定到回环以外接口之前，请保持 `AUTH_ENABLED=true`（默认值）。请勿将此端口直接暴露于公网。构建可点击的桌面应用包装器：

```bash
./build-macos-app.sh
```

<details>
<summary>Cookbook、GPU、Ollama 及故障排除说明</summary>

**Docker 捆绑服务。** Compose 启动 Odysseus、ChromaDB、SearXNG 和 ntfy。Odysseus 及捆绑服务端口默认绑定到 `127.0.0.1`，从主机可访问但不会暴露到 LAN/公网，除非您主动开启。

**Docker 中 Cookbook 的存储。** 下载文件位于 `./data/huggingface`（容器内为 `~/.cache/huggingface`）。Cookbook 安装的 Python CLI 和服务引擎位于 `./data/local`（容器内为 `~/.local`），因此容器重建后数据不会丢失。

**远程服务器。** 在 **Cookbook → 设置 → 服务器** 中生成 Odysseus SSH 密钥，将公钥添加到远程服务器的 `~/.ssh/authorized_keys`。也可以在主机上运行以下命令：

```bash
ssh-copy-id -i data/ssh/id_ed25519.pub user@server
```

**Docker GPU 叠加配置。** 仅 CPU 用户可跳过此节。Cookbook 只能检测 Docker 暴露给容器的 GPU——如果未配置主机运行时或设备直通，Cookbook 会错误地使用 iGPU、其他显卡或 CPU，而非您期望的 GPU。

NVIDIA 用户可运行 `scripts/check-docker-gpu.sh` 诊断 GPU 直通状态，并可选择安装主机运行时或更新 `.env`。

```bash
# 只读诊断（默认 — 不安装任何东西，不修改 .env）：
scripts/check-docker-gpu.sh

# 打印系统特定的安装命令（不实际执行）：
scripts/check-docker-gpu.sh --print-install-commands

# 在 Ubuntu/Debian 上安装 NVIDIA Container Toolkit（需 sudo）：
scripts/check-docker-gpu.sh --install-nvidia-toolkit

# 将 COMPOSE_FILE 写入 .env（仅在 GPU 直通确认可用时）：
scripts/check-docker-gpu.sh --enable-nvidia-overlay

# 完整辅助设置 — 安装toolkit，直通可用则启用叠加：
scripts/check-docker-gpu.sh --install-nvidia-toolkit --enable-nvidia-overlay
```

安全说明：
- 应用绝不会自动安装主机 GPU 运行时。
- 应用绝不会自动编辑 `.env`。
- 仅当显式传入 `--enable-nvidia-overlay` 且 GPU 直通成功时才修改 `.env`。`--yes` 跳过提示但不会绕过直通检查。
- `--enable-nvidia-overlay` 创建的 `.env.bak.*` 备份文件会被 Git 和 Docker 构建上下文忽略。

不使用脚本手动启用的方法，在 `.env` 中添加：

```bash
COMPOSE_FILE=docker-compose.yml:docker/gpu.nvidia.yml
```

**AMD / ROCm。** AMD 配置为只读诊断加手动编辑 `.env`。运行：

```bash
scripts/check-docker-amd-gpu.sh
```

然后将报告的值添加到 `.env`，将 `RENDER_GID` 替换为主机上的数字渲染组 ID：

```bash
COMPOSE_FILE=docker-compose.yml:docker/gpu.amd.yml
RENDER_GID=989
```

关于 NVIDIA/AMD GPU 支持，请同时阅读所选叠加文件中的注释：docker/gpu.nvidia.yml 或 docker/gpu.amd.yml。

**容器管理界面（Portainer、Coolify、Dockhand 等）。** 这些工具通常只接受单个 Compose 文件，且不可靠地遵守 `COMPOSE_FILE` 或多 `-f` 叠加。CLI 用户请继续使用上述 `COMPOSE_FILE` 叠加工作流。对于管理界面，改为指向以下独立文件，它们包含了基础堆栈和 GPU 设置：

- `docker-compose.gpu-nvidia.yml` — 仍需要主机安装 NVIDIA Container Toolkit。
- `docker-compose.gpu-amd.yml` — 仍需要主机 ROCm/kfd/DRI 配置、`video`/`render` 组成员资格及 `RENDER_GID`（按需）。

基础 `docker-compose.yml` 加 `docker/gpu.*.yml` 叠加文件仍是权威来源；独立文件为单文件部署提供镜像。

启用任一叠加后验证：

```bash
docker compose exec odysseus nvidia-smi -L   # NVIDIA
docker compose exec odysseus sh -lc 'test -e /dev/kfd && test -d /dev/dri && ls -l /dev/kfd /dev/dri/renderD*'  # AMD
```

> **GPU 直通 ≠ llama.cpp CUDA。** 容器内 `nvidia-smi` 正常仅确认了 Docker GPU 访问权，但 llama.cpp 运行时还需要 `cudart` 和 CUDA Toolkit。如果 Cookbook 日志显示 `Unable to find cudart library`、`Could NOT find CUDAToolkit`、`CUDA Toolkit not found` 或张量/层分配给了 CPU，这是 Cookbook/llama.cpp 构建问题——而非 Docker 直通失败。通过 **Cookbook → 依赖** 重新安装服务引擎获取 CUDA 构建版本。
>
> 同样适用于 AMD/ROCm：容器内可见 `/dev/kfd` 和 `/dev/dri` 只确认设备直通，不确认 ROCm 用户空间或 ROCm 编译的 vLLM/llama.cpp。精简的 Odysseus 镜像内不会包含 `rocm-smi` 和 `rocminfo`。

**Ollama 与 Docker 配合使用。** 如果 Ollama 在主机上运行，在设置中添加以下端点：

```text
http://host.docker.internal:11434/v1
```

Ollama 必须监听回环接口以外的地址：

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

This connects Odysseus in Docker to an Ollama server that is already running on
your host machine; it does not start Ollama inside the container.
`host.docker.internal` is Docker's hostname for the host machine from inside the
container. Cookbook **Serve** is a separate workflow for serving downloaded
models through Odysseus/llama.cpp, so Windows users with an existing Ollama
install usually only need to add the endpoint in Settings.

**Useful checks.**

```bash
docker compose ps
docker compose logs --tail=120 odysseus
docker compose logs odysseus | grep -E 'ChromaDB|MemoryVectorStore|DEGRADED'
```

**macOS details.** `start-macos.sh` installs Homebrew deps, creates the venv,
runs setup, and starts uvicorn on port `7860` because AirPlay often holds
`7000`. It uses llama.cpp/Ollama for Metal. vLLM/SGLang are CUDA/ROCm-only and
do not run on macOS. MLX-only models are not served by Odysseus.

</details>

### Native Windows

**One-command launcher** (creates the venv, installs deps, runs setup, starts the
server; safe to re-run):

```powershell
git clone https://github.com/pewdiepie-archdaemon/odysseus.git
cd odysseus
powershell -ExecutionPolicy Bypass -File .\launch-windows.ps1
```

Or do it by hand:

```powershell
git clone https://github.com/pewdiepie-archdaemon/odysseus.git
cd odysseus
py -3.11 -m venv venv
venv\Scripts\Activate.ps1
pip install -r requirements.txt
python setup.py
python -m uvicorn app:app --host 127.0.0.1 --port 7000
```

If `python` points at an older interpreter, use `py -3.12` (or another installed
3.11+ version) for the venv step.

**Requirements:** Python 3.11+. The core app (chat, agent, memory, documents,
email, calendar, deep research) runs fully native. For full **Cookbook** background
model downloads and the agent shell tool, also install
[Git for Windows](https://git-scm.com/download/win) (provides `bash.exe`).
Local GPU *serving* of vLLM/SGLang needs Linux/WSL2; for a local model on Windows,
[Ollama](https://ollama.com/download) is the easiest path — point Odysseus at
`http://localhost:11434/v1` in Settings.

Open `http://localhost:7000`, log in with the generated admin password,
and configure everything else inside **Settings**.

## Troubleshooting & Advanced Setup

### `chromadb-client` conflicts with embedded ChromaDB
If `chromadb-client` (the lightweight HTTP-only package) is installed alongside the full `chromadb` package, Odysseus starts but ChromaDB silently falls back to HTTP-only mode and fails.

**Fix:** uninstall `chromadb-client` and force-reinstall the full package:
```bash
./venv/bin/pip uninstall chromadb-client -y
./venv/bin/pip install --force-reinstall chromadb
```

### HTTPS + LAN/Tailscale exposure
To expose Odysseus on a local network or Tailscale with HTTPS:
1. Change the bind address to `0.0.0.0` in `.env` (`APP_BIND=0.0.0.0` or `ODYSSEUS_HOST=0.0.0.0`).
2. Generate a locally-trusted cert for your LAN/Tailscale IPs using [mkcert](https://github.com/FiloSottile/mkcert):
   ```bash
   mkcert -install
   mkcert -cert-file cert.pem -key-file key.pem 192.168.1.100 tailscale-ip
   ```
3. Run `uvicorn` with the generated certs:
   ```bash
   python -m uvicorn app:app --host 0.0.0.0 --port 7000 --ssl-certfile=cert.pem --ssl-keyfile=key.pem
   ```
4. Install the `mkcert` CA on any other device you want to access Odysseus from (e.g., for iOS, email the `rootCA.pem` to yourself, install the profile, and trust it in Certificate Trust Settings).

### Optional Dependencies
`requirements-optional.txt` contains packages that unlock extra features. It is not installed by default.

| Package | Feature unlocked |
|---------|-----------------|
| `faster-whisper` | Local speech-to-text (microphone -> text) via the "local" STT provider. |
| `ddgs` | DuckDuckGo as a search provider option. |
| `PyMuPDF` | PDF page rendering in the side viewer panel and form-filling. (Note: AGPL-3.0) |
| `markitdown` | Office/EPUB document text extraction (converts .docx/.xlsx/.pptx/.xls/.epub to Markdown). |

### Faster, reproducible installs with uv (optional)
[uv](https://docs.astral.sh/uv/) works as a drop-in replacement for the
venv + pip steps in the native install guides, no project changes are needed but this change results in faster installs along with a lockfile for reproducible environments. After [installing `uv`](https://docs.astral.sh/uv/getting-started/installation/), use:

```bash
uv venv venv --python 3.13
uv pip install -r requirements.txt
# then continue as usual: python setup.py, uvicorn, ...
```

`requirements.txt` is intentionally unpinned, so two installs at different times can produce different package versions. If you want a reproducible environment (e.g. across your own machines, or to roll back after a bad upgrade), snapshot and restore exact versions with:

```bash
uv pip compile requirements.txt -o requirements.lock   # snapshot current resolution
uv pip sync requirements.lock                          # reproduce it exactly later
```

`requirements.lock` is gitignored and platform-specific (compile it on the OS you deploy to). Regenerate it deliberately when you want to take upgrades. The plain `uv pip install -r requirements.txt` keeps following the unpinned requirements like pip does.

### Outlook / Office 365 email
Odysseus email accounts currently use IMAP/SMTP username-password auth. Outlook
and Microsoft 365 generally require OAuth instead, so normal Microsoft mailbox
passwords will fail. See [docs/email-outlook.md](docs/email-outlook.md) for the
current limitation and the planned integration direction.

## Security Notes
Odysseus is a self-hosted workspace with powerful local tools: shell access, file uploads, model downloads, web research, email/calendar integrations, and API tokens. Treat it like an admin console.

- Keep `AUTH_ENABLED=true` for any network-accessible deployment.
- Keep `LOCALHOST_BYPASS=false` outside local development.
- Use `SECURE_COOKIES=true` when Odysseus is served through HTTPS by a trusted reverse proxy or private access gateway.
- Do not expose it directly to the public internet without HTTPS and a trusted reverse proxy or private access layer.
- Keep `.env`, `data/`, `logs/`, databases, uploads, generated media, backups, auth/session files, API keys, and model/provider tokens out of Git and private shares. They are ignored by default.
- Review `data/auth.json` after first boot: disable open signup unless you intentionally want it, make only your own account admin, and keep demo/test accounts non-admin.
- Non-admin users do not get shell/Python/file read/write by default, and admin-only routes/tools such as MCP management, API tokens, webhooks, model/cookbook serving, backup/vault, and app settings are admin-gated. Other features are controlled by per-user privileges, so review each user's privileges before exposing a deployment.
- Rotate any API keys or tokens that were ever pasted into a shared chat, demo, screenshot, or log.
- If you enable API tokens or webhooks, create separate tokens per integration and delete unused ones.
- Prefer binding manual development runs to `127.0.0.1`; bind to `0.0.0.0` only when you intentionally want LAN/reverse-proxy access.
- Keep ChromaDB, SearXNG, ntfy, Ollama, vLLM, llama.cpp, databases, and raw model/provider APIs internal-only. Expose only the authenticated Odysseus web/API entrypoint through your trusted proxy or private access layer.
- Before publishing a fork, run `git status --short` and confirm no private files from `.env`, `data/`, `logs/`, uploads, backups, or local databases are staged.

### Private or proxied deployments
Odysseus serves plain HTTP on its app port. Docker Compose binds Odysseus and the bundled services to `127.0.0.1` by default, so a typical production/private setup is:

1. Keep Odysseus on localhost, for example `127.0.0.1:7000`.
2. Terminate HTTPS at a trusted reverse proxy or private access gateway.
3. Put the authenticated Odysseus web/API entrypoint behind that layer.
4. Keep raw service and model ports internal-only.

Cloudflare Access, Tailscale, Caddy, nginx, and Traefik can all fit this pattern; none are required by Odysseus. If your access layer reaches Odysseus on the same host, proxy to `http://127.0.0.1:7000` and keep `AUTH_ENABLED=true`, `LOCALHOST_BYPASS=false`, and `SECURE_COOKIES=true`.
`ALLOWED_ORIGINS` lists exact permitted origins for cross-origin browser/API clients; ordinary same-origin reverse-proxy access usually does not need a special CORS entry.

Common internal-only ports from the default docs/compose setup:

| Port | Service |
|---|---|
| `7000` | Odysseus raw app port |
| `8080` | SearXNG |
| `8091` | ntfy |
| `8100` | ChromaDB host port for manual/compose access |
| `11434` | Ollama |
| `8000-8020` | Common local model/provider APIs |

## Configuration
Most setup is done inside the app with `/setup` or **Settings**. Use `.env`
for deployment-level defaults and secrets you want present before first boot.
Key settings:

| Variable | Default | Description |
|---|---|---|
| `LLM_HOST` | `localhost` | Your LLM server (e.g. `llm-host.local:8000`) |
| `LLM_HOSTS` | -- | Comma-separated list for model discovery |
| `OPENAI_API_KEY` | -- | Optional OpenAI key. Prefer adding providers in the app unless pre-seeding. |
| `SEARXNG_INSTANCE` | `http://localhost:8080` | SearXNG URL. Docker overrides this to `http://searxng:8080`. |
| `SEARXNG_SECRET` | generated on first Docker boot | Optional SearXNG cookie/CSRF secret. Leave blank unless you need to pin it. |
| `APP_BIND` | `127.0.0.1` | Docker Compose host bind address for the web UI. Use `0.0.0.0` only for intentional LAN/reverse-proxy access. |
| `APP_PORT` | `7000` | Docker Compose host port for the web UI. |
| `APP_DATA_DIR` | `./data` | Docker Compose host directory for application data volumes. |
| `APP_LOGS_DIR` | `./logs` | Docker Compose host directory for application logs. |
| `AUTH_ENABLED` | `true` | Enable/disable login |
| `LOCALHOST_BYPASS` | `false` | Development-only auth bypass for loopback requests. Keep false for shared/network deployments. |
| `ALLOWED_ORIGINS` | `http://localhost,http://127.0.0.1` | Comma-separated exact permitted origins for cross-origin browser/API clients. |
| `SECURE_COOKIES` | `false` | Set true when serving Odysseus through HTTPS at a trusted proxy or private access gateway. |
| `DATABASE_URL` | `sqlite:///./data/app.db` | Database connection string |
| `CHROMADB_HOST` | `localhost` | ChromaDB host for vector memory. Docker overrides this to `chromadb`. |
| `CHROMADB_PORT` | `8100` | ChromaDB port for manual host runs. Docker overrides this to `8000`. |
| `EMBEDDING_URL` | -- | OpenAI-compatible embeddings endpoint |
| `ODYSSEUS_CHAT_UPLOAD_MAX_BYTES` | `10485760` | Chat/agent attachment cap in bytes. Raise for larger local PDFs or text documents. |
| `ODYSSEUS_GALLERY_UPLOAD_MAX_BYTES` | `104857600` | Gallery image upload cap in bytes (100 MB). |
| `ODYSSEUS_GALLERY_TRANSFORM_UPLOAD_MAX_BYTES` | `26214400` | Gallery transform input cap in bytes (25 MB). |
| `ODYSSEUS_MEMORY_IMPORT_MAX_BYTES` | `10485760` | Memory import file cap in bytes (10 MB). |
| `ODYSSEUS_PERSONAL_UPLOAD_MAX_BYTES` | `26214400` | Personal document upload cap in bytes (25 MB). |
| `ODYSSEUS_EMAIL_COMPOSE_UPLOAD_MAX_BYTES` | `26214400` | Email compose attachment cap in bytes (25 MB). |
| `ODYSSEUS_STT_MAX_AUDIO_BYTES` | `26214400` | Speech-to-text audio cap in bytes (25 MB). |
| `ODYSSEUS_ICS_MAX_BYTES` | `10485760` | Calendar `.ics` import cap in bytes (10 MB). |

All upload-limit vars are validated (must be a positive integer) and optional; an invalid value fails fast at startup.

### Built-in MCP servers (optional setup)

Odysseus auto-registers a few built-in MCP servers at startup. The npx-based ones (currently the browser server, `@playwright/mcp`) only start when their npm package is already in the local npx cache. If a package isn't cached, that server is skipped with a startup log message explaining what to do, so a fresh install does not block on a multi-minute npm download or hang if Playwright system deps are missing.

To enable the browser MCP (page navigation, screenshots, vision), run once:

```bash
npx -y @playwright/mcp@latest --version
```

That installs `@playwright/mcp` plus Playwright (~300MB total). Restart Odysseus and the server will register at startup.

## Architecture
```
app.py                   # FastAPI entry point
core/      auth, database, middleware, constants
src/       llm_core, agent_loop, agent_tools, chat_processor, search/
routes/    chat, session, document, memory, model … endpoints
services/  docs, memory, search, hwfit (Cookbook) …
static/    index.html + app.js + style.css + js/ (modular front-end)
docs/      landing page (index.html) + preview clips
```

## Data
All user data lives in `data/` (gitignored): `app.db` (sessions, messages, documents),
`memory.json`, `presets.json`, `uploads/`, `personal_docs/`, `chroma/`, `settings.json`.

To back up or restore everything in `data/`, see the
[Backup & Restore guide](docs/backup-restore.md).
