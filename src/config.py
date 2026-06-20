import os
from pathlib import Path
from typing import List, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, field_validator

from src.constants import DATA_DIR as _DATA_DIR_CONST

# Cross-platform OS flag, exposed here so callers can `from src.config import
# IS_WINDOWS`. Defined locally (a trivial `os.name == "nt"`) rather than imported
# from core.platform_compat, to keep this dependency-light config module from
# dragging in the whole core/__init__ + llm_core import chain. The platform
# 平台*辅助函数*（safe_chmod、pid_alive、find_bash 等）仅存在于
# core.platform_compat — that remains their single source of truth. Keep platform
# 内联 `if IS_WINDOWS:` 差异（绝不要平行的 *_windows.py 文件），
# files) so they stay easy to integrate with upstream changes.
IS_WINDOWS = os.name == "nt"

class DataConfig(BaseSettings):
    """数据存储和文件处理的配置。"""
    # Base directory
    base_dir: Path = Field(default=Path(__file__).parent.parent, description="应用程序基础目录")
    
    # Data paths
    data_dir: Path = Field(default=Path(_DATA_DIR_CONST), description="主数据目录")
    uploads_dir: Path = Field(default=Path(_DATA_DIR_CONST) / "uploads", description="上传文件目录")
    sessions_file: Path = Field(default=Path(_DATA_DIR_CONST) / "sessions.json", description="Sessions 存储文件")
    memory_file: Path = Field(default=Path(_DATA_DIR_CONST) / "memory.json", description="Memory 存储文件")
    memory_doc: Path = Field(default=Path(_DATA_DIR_CONST) / "memory_doc.md", description="Memory 文档文件")
    personal_dir: Path = Field(default=Path(_DATA_DIR_CONST) / "personal_docs", description="个人文档目录")
    runbook_dir: Path = Field(default=Path(_DATA_DIR_CONST) / "personal_docs" / "runbook", description="Runbook 目录")
    
    # Upload settings
    max_upload_size: int = Field(default=10 * 1024 * 1024, description="最大上传大小（字节，10MB）")
    allowed_extensions: List[str] = Field(
        default=[
            '.txt', '.py', '.html', '.md', '.json', '.csv',
            '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.pdf'
        ],
        description="允许上传的文件扩展名"
    )
    chunk_size: int = Field(default=1000, description="文档处理的块大小")
    chunk_overlap: int = Field(default=200, description="文档处理的块重叠")
    cleanup_days: int = Field(default=30, description="清理旧上传的天数")
    
    model_config = SettingsConfigDict(env_prefix="DATA_")

class LLMConfig(BaseSettings):
    """LLM 集成的配置。"""
    
    # LLM endpoints
    default_host: str = Field(default="localhost", description="LLM 服务的默认主机")
    openai_api_key: Optional[str] = Field(default=None, description="OpenAI API 密钥（如使用 OpenAI）")
    openai_compat_path: str = Field(default="/v1/chat/completions", description="OpenAI 兼容 API 路径")
    
    # LLM behavior
    max_context_messages: int = Field(default=90, description="保留的最大上下文消息数")
    request_timeout: int = Field(default=20, description="请求超时秒数")
    llm_stream_timeout: int = Field(default=30, description="LLM 流式传输超时秒数")
    llm_max_tokens: int = Field(default=4096, description="LLM 响应的最大 token 数")
    llm_temperature: float = Field(default=0.3, description="LLM 响应的温度参数")
    
    model_config = SettingsConfigDict(env_prefix="LLM_")

class SearchConfig(BaseSettings):
    """搜索功能的配置。"""
    
    # Web search
    searxng_instance: str = Field(
        default="http://localhost:8080",
        description="SearXNG 实例 URL（自托管）"
    )
    web_search_count: int = Field(default=10, description="检索的搜索结果数量")
    web_search_max_pages: int = Field(default=6, description="搜索的最大页面数")
    web_search_max_workers: int = Field(default=4, description="Web 搜索的最大工作线程数")
    
    # Research service
    research_service_url: str = Field(
        default="http://localhost:8003/research", 
        description="Research 服务 URL"
    )
    research_timeout: int = Field(default=300, description="Research 服务超时秒数")
    
    # API keys (optional)
    serpapi_key: Optional[str] = Field(default=None, description="SerpAPI 密钥（如使用）")
    google_api_key: Optional[str] = Field(default=None, description="Google API 密钥（如使用）")
    google_cx: Optional[str] = Field(default=None, description="Google 自定义搜索引擎 ID（如使用）")
    
    model_config = SettingsConfigDict(env_prefix="SEARCH_")

class SecurityConfig(BaseSettings):
    """安全和速率限制的配置。"""
    
    # Rate limiting
    max_concurrent_uploads: int = Field(default=3, description="每个 IP 的最大并发上传数")
    upload_rate_limit: int = Field(default=5, description="每个 IP 每分钟的最大上传数")
    upload_rate_window: int = Field(default=60, description="速率限制窗口秒数")
    upload_rate_max_entries: int = Field(default=1000, description="保留的最大速率限制条目数")
    
    # Security settings
    allowed_origins: List[str] = Field(default=["*"], description="CORS 允许的来源")
    max_file_size: int = Field(default=10 * 1024 * 1024, description="最大文件大小（字节）")
    dangerous_file_types: List[str] = Field(
        default=[
            'application/x-executable', 'application/x-sharedlib',
            'application/x-dll', 'application/x-msdownload',
            'application/x-sh', 'application/x-bat', 'application/x-vbs',
            'application/javascript', 'application/x-javascript'
        ],
        description="需要阻止的潜在危险 MIME 类型"
    )
    dangerous_extensions: List[str] = Field(
        default=[
            '.exe', '.dll', '.bat', '.cmd', '.sh', '.bash', 
            '.js', '.vbs', '.ps1', '.py', '.php', '.jsp', '.asp', '.aspx'
        ],
        description="需要阻止的潜在危险文件扩展名"
    )
    
    model_config = SettingsConfigDict(env_prefix="SECURITY_")

class AppConfig(BaseSettings):
    """组合所有组件的主应用程序配置。"""
    
    data: DataConfig = DataConfig()
    llm: LLMConfig = LLMConfig()
    search: SearchConfig = SearchConfig()
    security: SecurityConfig = SecurityConfig()
    
    # Application settings
    debug: bool = Field(default=False, description="启用调试模式")
    log_level: str = Field(default="INFO", description="日志级别")
    
    @field_validator("data", mode="before")
    def set_data_paths(cls, v, info):
        """根据 base_dir 设置数据路径。"""
        # 从字段值获取 base_dir 或使用默认值
        if isinstance(v, dict) and "base_dir" in v:
            base_dir = v["base_dir"]
        else:
            base_dir = Path(__file__).parent.parent
        
        # 将字符串路径转换为相对于 base_dir 的 Path 对象
        data_dir = Path(_DATA_DIR_CONST)
        
        # 从输入字典获取值或使用默认值
        max_upload_size = v.get("max_upload_size", 10 * 1024 * 1024) if isinstance(v, dict) else 10 * 1024 * 1024
        allowed_extensions = v.get("allowed_extensions", [
            '.txt', '.py', '.html', '.md', '.json', '.csv',
            '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.pdf'
        ]) if isinstance(v, dict) else [
            '.txt', '.py', '.html', '.md', '.json', '.csv',
            '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.pdf'
        ]
        chunk_size = v.get("chunk_size", 1000) if isinstance(v, dict) else 1000
        chunk_overlap = v.get("chunk_overlap", 200) if isinstance(v, dict) else 200
        cleanup_days = v.get("cleanup_days", 30) if isinstance(v, dict) else 30
        return {
            "base_dir": base_dir,
            "data_dir": data_dir,
            "uploads_dir": data_dir / "uploads",
            "sessions_file": data_dir / "sessions.json",
            "memory_file": data_dir / "memory.json",
            "memory_doc": data_dir / "memory_doc.md",
            "personal_dir": data_dir / "personal_docs",
            "runbook_dir": data_dir / "personal_docs" / "runbook",
            "max_upload_size": max_upload_size,
            "allowed_extensions": allowed_extensions,
            "chunk_size": chunk_size,
            "chunk_overlap": chunk_overlap,
            "cleanup_days": cleanup_days
        }
    
    model_config = SettingsConfigDict()

# 创建全局配置实例
config = AppConfig()

# 如果目录不存在则创建它们
def create_directories():
    """创建所需的目录（如果不存在）。"""
    directories = [
        config.data.data_dir,
        config.data.uploads_dir,
        config.data.personal_dir,
        config.data.runbook_dir
    ]
    
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)

# 启动时验证配置
def validate_config():
    """验证应用程序配置。"""
    # 检查 LLM 主机是否可达（如果指定了）
    if config.llm.default_host and config.llm.default_host.startswith("192.168."):
        # 这是本地 IP，假设它有效
        pass
    
    # 检查需要时 API 密钥是否已设置
    if not config.llm.openai_api_key:
        # OpenAI API 密钥未设置，如果不使用 OpenAI 则没问题
        pass
    
    # 创建目录
    create_directories()

# 初始化配置
validate_config()
