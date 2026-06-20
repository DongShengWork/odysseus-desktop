# src/constants.py
"""应用程序范围的常量和配置值。"""
import os

APP_VERSION = "1.0.0"

# 基础路径
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/"
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.getenv("ODYSSEUS_DATA_DIR", os.path.join(BASE_DIR, "data"))

# 数据文件路径
# 单一数据来源：每个持久化的文件/目录都位于 DATA_DIR 下，
# 这是唯一读取 ODYSSEUS_DATA_DIR 的地方。导入这些常量，
# 而不是从 __file__ 或相对 "data" 字面量重新推导路径。
SESSIONS_FILE = os.path.join(DATA_DIR, "sessions.json")
MEMORY_FILE = os.path.join(DATA_DIR, "memory.json")
MEMORY_DOC = os.path.join(DATA_DIR, "memory_doc.md")
PERSONAL_DIR = os.path.join(DATA_DIR, "personal_docs")
RUNBOOK_DIR = os.path.join(PERSONAL_DIR, "runbook")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
FEATURES_FILE = os.path.join(DATA_DIR, "features.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
AUTH_FILE = os.path.join(DATA_DIR, "auth.json")
USER_PREFS_FILE = os.path.join(DATA_DIR, "user_prefs.json")
PRESETS_FILE = os.path.join(DATA_DIR, "presets.json")
INTEGRATIONS_FILE = os.path.join(DATA_DIR, "integrations.json")
CONTACTS_FILE = os.path.join(DATA_DIR, "contacts.json")
APP_KEY_FILE = os.path.join(DATA_DIR, ".app_key")
EMBEDDING_ENDPOINT_FILE = os.path.join(DATA_DIR, "embedding_endpoint.json")
COOKBOOK_STATE_FILE = os.path.join(DATA_DIR, "cookbook_state.json")
BG_JOBS_FILE = os.path.join(DATA_DIR, "bg_jobs.json")
VAULT_FILE = os.path.join(DATA_DIR, "vault.json")
TIDY_CALENDAR_STATE_FILE = os.path.join(DATA_DIR, "tidy_calendar_state.json")
SKILLS_FILE = os.path.join(DATA_DIR, "skills.json")
APP_DB = os.path.join(DATA_DIR, "app.db")
SCHEDULED_EMAILS_DB = os.path.join(DATA_DIR, "scheduled_emails.db")
EMAIL_CACHE_DB = os.path.join(DATA_DIR, "email_cache.db")

# 数据子目录
PERSONAL_UPLOADS_DIR = os.path.join(DATA_DIR, "personal_uploads")
EMOJI_CACHE_DIR = os.path.join(DATA_DIR, "emoji_cache")
RAG_DIR = os.path.join(DATA_DIR, "rag")
CHROMA_DIR = os.path.join(DATA_DIR, "chroma")
BG_JOBS_DIR = os.path.join(DATA_DIR, "bg_jobs")
DEEP_RESEARCH_DIR = os.path.join(DATA_DIR, "deep_research")
MCP_OAUTH_DIR = os.path.join(DATA_DIR, "mcp_oauth")
GENERATED_IMAGES_DIR = os.path.join(DATA_DIR, "generated_images")
TTS_CACHE_DIR = os.path.join(DATA_DIR, "tts_cache")
EMAIL_URGENCY_CACHE_DIR = os.path.join(DATA_DIR, "email_urgency_cache")
SKILLS_DIR = os.path.join(DATA_DIR, "skills")
GALLERY_DIR = os.path.join(DATA_DIR, "gallery")
GALLERY_UPLOADS_DIR = os.path.join(DATA_DIR, "gallery_uploads")
MEMORY_VECTORS_DIR = os.path.join(DATA_DIR, "memory_vectors")

# 具有专用环境变量覆盖的路径，默认位于 DATA_DIR 下。
MAIL_ATTACHMENTS_DIR = os.getenv("ODYSSEUS_MAIL_ATTACHMENTS_DIR", os.path.join(DATA_DIR, "mail-attachments"))
FASTEMBED_CACHE_DIR = os.getenv("FASTEMBED_CACHE_PATH", os.path.join(DATA_DIR, "fastembed_cache"))

# Agent 工具输出限制（单一数据来源——由 tool_execution.py、
# tool_implementations.py、agent_tools.py 以及任何需要它们的模块导入）
MAX_OUTPUT_CHARS = 10_000       # bash/python/web_search/web_fetch 输出上限
MAX_READ_CHARS = 20_000         # read_file / 文档预览 上限
MAX_DIFF_LINES = 400            # edit_file 统一 diff 显示上限

# API 配置
MAX_CONTEXT_MESSAGES = 90
REQUEST_TIMEOUT = 20
OPENAI_COMPAT_PATH = "/v1/chat/completions"

# 环境变量（带默认值）
DEFAULT_HOST = os.getenv("LLM_HOST", "localhost")
LLM_HOSTS = [h.strip() for h in os.getenv("LLM_HOSTS", "").split(",") if h.strip()]
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
SEARXNG_INSTANCE = os.getenv("SEARXNG_INSTANCE", "http://localhost:8080")


# 清理配置
CLEANUP_ENABLED = os.getenv("CLEANUP_ENABLED", "True").lower() == "true"
CLEANUP_INTERVAL_HOURS = int(os.getenv("CLEANUP_INTERVAL_HOURS", "24"))

# 默认参数
DEFAULT_TEMPERATURE = 1.0
DEFAULT_MAX_TOKENS = 0


def internal_api_base() -> str:
    """进程内回环调用 Odysseus 自身 API 的基础 URL。

    Agent 工具和后台任务通过 HTTP 调用运行中的服务器来访问管理门
    控路由。解析顺序：
      1. ODYSSEUS_INTERNAL_BASE  - 显式覆盖（例如在 TLS 代理后面）。
      2. APP_PORT                - http://127.0.0.1:$APP_PORT（docker-compose）。
      3. 回退 http://127.0.0.1:7000 - 旧版默认值。

    使用 127.0.0.1（而非 "localhost"）可以避免严格本地调用的 IPv6/DNS
    歧义。没有这个，当服务器不在端口 7000 上时，回环工具会因
    "All connection attempts failed" 而失败。
    """
    override = os.environ.get("ODYSSEUS_INTERNAL_BASE")
    if override:
        return override.rstrip("/")
    return f"http://127.0.0.1:{os.environ.get('APP_PORT', '7000')}"
