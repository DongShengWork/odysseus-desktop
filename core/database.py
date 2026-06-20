import os
import logging
import sqlite3
from datetime import datetime, timezone
from sqlalchemy import event, create_engine, Column, String, Text, Boolean, DateTime, Integer, ForeignKey, JSON, Index, func, text
from sqlalchemy.engine import Engine
from sqlalchemy.types import TypeDecorator
from sqlalchemy.ext.declarative import declarative_base, declared_attr
from sqlalchemy.orm import relationship, sessionmaker, backref

logger = logging.getLogger(__name__)

# 创建声明式模型的基类
Base = declarative_base()


def utcnow_naive() -> datetime:
    """返回不带时区信息的 UTC 时间，用于现有 DateTime 列。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class TimestampMixin:
    """为模型添加时间戳字段的混入类"""
    @declared_attr
    def created_at(cls):
        return Column(DateTime, default=utcnow_naive, nullable=False)
    
    @declared_attr
    def updated_at(cls):
        return Column(DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False)

# 从环境变量获取数据库 URL，默认使用 DATA_DIR 中的 SQLite
from src.constants import DATA_DIR, AUTH_FILE, MEMORY_FILE, USER_PREFS_FILE, SETTINGS_FILE
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DATA_DIR}/app.db")

# 创建引擎
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {}
)

# 创建会话工厂
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# 监听 Engine 类确保此监听器对进程内创建的所有 Engine
# 实例都生效，而不仅仅是主应用引擎。
# isinstance(sqlite3.Connection) 检查确保在使用非 SQLite 数据库后端时，
# 此 PRAGMA foreign_keys=ON 配置保持为无操作。
@event.listens_for(Engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    if isinstance(dbapi_connection, sqlite3.Connection):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


class EncryptedText(TypeDecorator):
    """文本列透明加密（静态存储），通过 src.secret_storage 实现。

    Writes are Fernet-encrypted (`enc:` prefix); reads decrypt back to
    plaintext, so all consumers use the column normally. Legacy plaintext
    rows pass through unchanged until their next write (a startup migration
    encrypts them). Protects the SQLite file at rest (stolen backup / leaked
    image), not a live process that can read the key.
    """
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        from src.secret_storage import encrypt
        return encrypt(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        from src.secret_storage import decrypt
        return decrypt(value)


class Session(TimestampMixin, Base):
    """
    会话表的 SQLAlchemy 模型。
    表示一个包含配置和元数据的聊天会话。
    """
    __tablename__ = "sessions"
    
    # 主键
    id = Column(String, primary_key=True, index=True)
    
    # 会话元数据
    name = Column(String, nullable=False)
    endpoint_url = Column(String, nullable=False)
    model = Column(String, nullable=False)
    owner = Column(String, nullable=True, index=True)  # 用户名；null = 传统/共享
    
    # 配置标志
    rag = Column(Boolean, default=False)
    archived = Column(Boolean, default=False)

    # 组织
    folder = Column(String, nullable=True, default=None)
    
    # 以 JSON 格式存储的请求头
    headers = Column(JSON, default=dict)
    
    # 时间戳由 TimestampMixin 提供
    last_accessed = Column(DateTime, default=func.now(), onupdate=func.now())
    # 此会话中最后一次实际消息的时间戳。仅在消息
    # 持久化时显式设置（不使用 onupdate）— 因此它是一个干净的
    # "最后一次对话"信号，不受重命名/模型切换/仅打开聊天
    # （这些都会更新 updated_at 和 last_accessed）的影响。
    # "最近活跃"排序使用此字段。
    last_message_at = Column(DateTime, nullable=True, default=None)
    
    
    # 索引 - 优化的复合索引
    __table_args__ = (
        Index('ix_sessions_active', 'archived', 'last_accessed'),
        Index('ix_sessions_search', 'name', 'archived'),
    )
    
    # 属性
    is_important = Column(Boolean, default=False)
    message_count = Column(Integer, default=0)
    total_input_tokens = Column(Integer, default=0)
    total_output_tokens = Column(Integer, default=0)
    mode = Column(String, nullable=True)  # 'agent'、'chat' 或 'research'
    crew_member_id = Column(String, nullable=True)  # 链接到 crew_members.id

    # 与聊天消息的关联关系
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan")
    
    @property
    def is_active(self):
        """检查会话是否活跃（未归档）"""
        return not self.archived
    
    def to_dict(self):
        """将会话转换为字典，用于 JSON 序列化"""
        return {
            'id': self.id,
            'name': self.name,
            'model': self.model,
            'endpoint_url': self.endpoint_url,
            'rag': self.rag,
            'archived': self.archived,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            'last_accessed': self.last_accessed.isoformat() if self.last_accessed else None,
            'last_message_at': self.last_message_at.isoformat() if self.last_message_at else None,
            'message_count': self.message_count,
            'is_important': self.is_important,
            'folder': self.folder,
            'total_input_tokens': self.total_input_tokens or 0,
            'total_output_tokens': self.total_output_tokens or 0,
            'crew_member_id': self.crew_member_id,
        }

class ChatMessage(Base):
    """
    聊天消息表的 SQLAlchemy 模型。
    表示会话中的单条聊天消息。
    """
    __tablename__ = "chat_messages"
    
    # 主键 - 使用 String 以支持 UUID
    id = Column(String, primary_key=True, index=True)
    
    # 外键关联到 Session
    session_id = Column(String, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # 消息内容
    role = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    meta_data = Column("metadata", Text, nullable=True)  # JSON 字符串，用于指标等

    # 时间戳
    timestamp = Column(DateTime, default=utcnow_naive)
    
    # 与 Session 的关联关系
    session = relationship("Session", back_populates="messages")
    
    # 索引 - 优化的复合索引
    __table_args__ = (
        Index('ix_messages_session_time', 'session_id', 'timestamp'),  # 复合索引，用于高效的消息检索
    )

class Document(TimestampMixin, Base):
    """AI 可原地创建和编辑的动态文档。"""
    __tablename__ = "documents"

    id              = Column(String, primary_key=True, index=True)
    session_id      = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True, index=True)
    title           = Column(String, nullable=False, default="Untitled")
    language        = Column(String, nullable=True)          # "python"、"markdown"、"text" 等
    current_content = Column(Text, nullable=False, default="")
    version_count   = Column(Integer, default=1)
    is_active       = Column(Boolean, default=True)
    # 软归档：在恢复之前从文档库的文档列表/搜索/整理中隐藏。
    # 与 is_active（跟踪"在会话中打开"）不同。
    archived        = Column(Boolean, default=False)
    # 此文档的所有者。文档过去通过关联的聊天会话
    # 派生所有权，但会话可能被删除（session_id → NULL 通过
    # SET NULL），导致文档孤立并使其从所有者的文档库
    # + 搜索中消失。直接拥有该行可以应对这种情况。
    owner           = Column(String, nullable=True, index=True)
    tidy_verdict    = Column(String, nullable=True)        # "keep"、"junk" 或 None（尚未审核）
    # 来源：如果此文档是通过打开电子邮件附件创建的，
    # 这些字段指向源电子邮件，以便"签名并回复"流程
    # 可以在原始对话中串联回复。
    source_email_uid         = Column(String, nullable=True)
    source_email_folder      = Column(String, nullable=True)
    source_email_account_id  = Column(String, nullable=True)
    source_email_message_id  = Column(String, nullable=True, index=True)

    session  = relationship("Session", backref=backref("documents", cascade="save-update, merge"))
    versions = relationship("DocumentVersion", back_populates="document",
                           cascade="all, delete-orphan", order_by="DocumentVersion.version_number")


class DocumentVersion(Base):
    """文档在某个时间点的不可变快照。"""
    __tablename__ = "document_versions"

    id             = Column(String, primary_key=True, index=True)
    document_id    = Column(String, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True)
    version_number = Column(Integer, nullable=False)
    content        = Column(Text, nullable=False)
    summary        = Column(String, nullable=True)     # 编辑描述
    source         = Column(String, default="ai")      # "ai" 或 "user"
    created_at     = Column(DateTime, default=utcnow_naive)

    document = relationship("Document", back_populates="versions")


class GalleryAlbum(TimestampMixin, Base):
    """一个相册/文件夹。"""
    __tablename__ = "gallery_albums"

    id          = Column(String, primary_key=True, index=True)
    name        = Column(String, nullable=False)
    description = Column(Text, default="")
    cover_id    = Column(String, nullable=True)  # 封面照片的 GalleryImage.id
    owner       = Column(String, nullable=True, index=True)

    images = relationship("GalleryImage", back_populates="album")


class GalleryImage(TimestampMixin, Base):
    """存储照片和 AI 生成图片的元数据。"""
    __tablename__ = "gallery_images"

    id         = Column(String, primary_key=True, index=True)
    filename   = Column(String, nullable=False, unique=True)
    prompt     = Column(Text, nullable=False, default="")
    model      = Column(String, nullable=True)
    size       = Column(String, nullable=True)
    quality    = Column(String, nullable=True)
    tags       = Column(String, nullable=True, default="")
    ai_tags    = Column(Text, nullable=True, default="")       # AI 生成的标签（逗号分隔）
    session_id = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True, index=True)
    album_id   = Column(String, ForeignKey("gallery_albums.id", ondelete="SET NULL"), nullable=True, index=True)
    owner      = Column(String, nullable=True, index=True)
    is_active  = Column(Boolean, default=True)
    favorite   = Column(Boolean, default=False)

    # 文件完整性
    file_hash  = Column(String(64), nullable=True, index=True)  # SHA-256

    # EXIF / 照片元数据
    taken_at       = Column(DateTime, nullable=True, index=True)  # EXIF DateTimeOriginal
    camera_make    = Column(String, nullable=True)
    camera_model   = Column(String, nullable=True)
    gps_lat        = Column(String, nullable=True)  # 存储为字符串以保持精度
    gps_lng        = Column(String, nullable=True)
    width          = Column(Integer, nullable=True)
    height         = Column(Integer, nullable=True)
    file_size      = Column(Integer, nullable=True)  # 字节

    session = relationship("Session", backref=backref("gallery_images"))
    album   = relationship("GalleryAlbum", back_populates="images")

    __table_args__ = (
        Index('ix_gallery_images_tags', 'tags'),
        Index('ix_gallery_images_model', 'model'),
        Index('ix_gallery_images_active', 'is_active', 'created_at'),
    )


class EmailAccount(TimestampMixin, Base):
    """已配置的 IMAP/SMTP 账户。每个用户支持多个账户 —
    每个所有者恰好有一个行的 is_default=True。

    安全说明：imap_password / smtp_password 通过
    src/secret_storage.py 使用 Fernet 加密存储。密钥位于
    data/.app_key（权限 0o600，已 gitignore）。任何能读取
    该文件的人都能解密每一行，因此威胁模型是"被盗的 SQLite 备份"
    而非"进程被攻破"。首次启动时，所有旧版明文行会
    自动迁移（参见 _migrate_encrypt_email_passwords）。
    """
    __tablename__ = "email_accounts"

    id             = Column(String, primary_key=True, index=True)
    owner          = Column(String, nullable=True, index=True)
    name           = Column(String, nullable=False)  # 显示名称："Work"、"Personal" 等
    is_default     = Column(Boolean, default=False, nullable=False)
    enabled        = Column(Boolean, default=True, nullable=False)

    # IMAP（接收）
    imap_host      = Column(String, default="")
    imap_port      = Column(Integer, default=993)
    imap_user      = Column(String, default="")
    imap_password  = Column(String, default="")
    imap_starttls  = Column(Boolean, default=True)

    # SMTP（发送）
    smtp_host      = Column(String, default="")
    smtp_port      = Column(Integer, default=465)
    smtp_security  = Column(String, default="ssl")  # ssl | starttls | none
    smtp_user      = Column(String, default="")
    smtp_password  = Column(String, default="")

    from_address   = Column(String, default="")

    __table_args__ = (
        Index('ix_email_accounts_owner_default', 'owner', 'is_default'),
    )


class ModelEndpoint(TimestampMixin, Base):
    """管理员配置的模型端点。模型通过 /v1/models 自动发现。"""
    __tablename__ = "model_endpoints"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)          # 显示标签，例如 "Local vLLM"、"OpenRouter"
    base_url = Column(String, nullable=False)      # Base URL，例如 "http://localhost:8002/v1"
    api_key = Column(EncryptedText, nullable=True)  # 可选的提供商 API 密钥，加密存储
    is_enabled = Column(Boolean, default=True)
    hidden_models = Column(Text, nullable=True)    # 探测失败的模型 ID 的 JSON 列表
    cached_models = Column(Text, nullable=True)    # 最后已知模型 ID 的 JSON 列表（避免在列表时进行探测）
    pinned_models = Column(Text, nullable=True)    # 管理员固定的模型 ID 的 JSON 列表（手动指定，可能不在 /v1/models 中）
    model_type = Column(String, nullable=True, default="llm")  # "llm" 或 "image"
    # auto = 按 URL 分类；local = 自托管服务器；api/proxy = 外部
    # OpenAI 兼容 API，即使通过私有/tailnet IP 也可达。
    endpoint_kind = Column(String, nullable=True, default="auto")
    # auto = 带 TTL/退避的后台刷新；manual/disabled = 仅缓存优先，
    # 除非显式请求端点探测。
    model_refresh_mode = Column(String, nullable=True, default="auto")
    model_refresh_interval = Column(Integer, nullable=True, default=None)
    model_refresh_timeout = Column(Integer, nullable=True, default=None)
    # 此端点上的模型是否接受 OpenAI 风格的函数
    # schema + 发出 `tool_calls`。在 Cookbook 自动注册时
    # 从 serve 命令中的 `--enable-auto-tool-choice` 自动检测；
    # 可以在 UI 中按端点切换。NULL = 未知，回退到
    # agent_loop.py 中的模型名称关键词启发式方法。
    supports_tools = Column(Boolean, nullable=True, default=None)
    # 按用户的所有权。NULL = 传统/共享（对所有用户可见）— 这是
    # 历史默认值。当非 null 时，模型选择器仅向该用户
    # 显示此端点（管理员始终可见全部）。
    owner = Column(String, nullable=True, index=True)
    # 可选的 OAuth/会话支持的凭证行。用于需要刷新令牌
    # 而不是静态 API 密钥的订阅支持提供商。
    provider_auth_id = Column(String, nullable=True, index=True)


class ProviderAuthSession(TimestampMixin, Base):
    """支持刷新令牌的模型提供商的加密 OAuth/会话凭据。"""
    __tablename__ = "provider_auth_sessions"

    id = Column(String, primary_key=True, index=True)
    provider = Column(String, nullable=False, index=True)
    owner = Column(String, nullable=True, index=True)
    label = Column(String, nullable=True)
    base_url = Column(String, nullable=False)
    access_token = Column(EncryptedText, nullable=True)
    refresh_token = Column(EncryptedText, nullable=True)
    last_refresh = Column(DateTime, nullable=True)
    auth_mode = Column(String, nullable=True)

class McpServer(TimestampMixin, Base):
    """管理员配置的 MCP（模型上下文协议）工具服务器。"""
    __tablename__ = "mcp_servers"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    transport = Column(String, nullable=False, default="stdio")  # "stdio" or "sse"
    command = Column(String, nullable=True)      # stdio 模式：可执行文件路径
    args = Column(Text, nullable=True)           # JSON 数组，命令参数
    env = Column(Text, nullable=True)            # JSON 对象，环境变量
    url = Column(String, nullable=True)          # SSE 模式：服务器 URL
    is_enabled = Column(Boolean, default=True)
    oauth_config = Column(Text, nullable=True)   # JSON: provider, keys_file, token_file, scopes
    disabled_tools = Column(Text, nullable=True)  # JSON array of tool names to hide from LLM
    oauth_tokens = Column(EncryptedText, nullable=True)  # JSON {tokens, client_info} for generic MCP OAuth, encrypted at rest


class Comparison(TimestampMixin, Base):
    """存储 A/B 模型对比结果。"""
    __tablename__ = "comparisons"

    id = Column(String, primary_key=True, index=True)
    session_id = Column(String, nullable=True)     # 父会话上下文（可选）
    owner = Column(String, nullable=True, index=True)  # username
    prompt = Column(Text, nullable=False)
    model_a = Column(String, nullable=False)
    model_b = Column(String, nullable=False)
    endpoint_a = Column(String, nullable=False)
    endpoint_b = Column(String, nullable=False)
    response_a = Column(Text, nullable=True)
    response_b = Column(Text, nullable=True)
    metrics_a = Column(Text, nullable=True)         # JSON string
    metrics_b = Column(Text, nullable=True)         # JSON string
    winner = Column(String, nullable=True)           # "a", "b", "tie", or null
    is_blind = Column(Boolean, default=True)
    blind_mapping = Column(Text, nullable=True)      # JSON: {"left": "a"/"b", "right": "a"/"b"}
    voted_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index('ix_comparisons_voted_at', 'voted_at'),
    )


class Signature(TimestampMixin, Base):
    """用户保存的可视化签名（图片印章）。

    可在 PDF 表单填写、电子邮件撰写和文档编辑中复用。
    `data_png` 是 base64 编码的 PNG（无 `data:` 前缀）。SVG 矢量
    列保留用于未来的平滑矢量存储。两者均在静态存储时使用
    Fernet 加密（参见 EncryptedText / src.secret_storage）；手写
    签名是敏感信息，因此绝不能以明文形式存在于数据库文件中。
    现有行在启动时自动迁移。
    """
    __tablename__ = "signatures"

    id = Column(String, primary_key=True, index=True)
    owner = Column(String, nullable=True, index=True)
    name = Column(String, nullable=False, default="Signature")
    data_png = Column(EncryptedText, nullable=False)   # base64 PNG, encrypted at rest
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    svg = Column(EncryptedText, nullable=True)         # vector signature, encrypted at rest


class ApiToken(TimestampMixin, Base):
    """用于外部集成的 API 令牌（n8n、Make 等）。"""
    __tablename__ = "api_tokens"

    id = Column(String, primary_key=True, index=True)
    owner = Column(String, nullable=True, index=True)
    name = Column(String, nullable=False)
    token_hash = Column(String, nullable=False)
    token_prefix = Column(String, nullable=False)  # first 8 chars for display
    scopes = Column(String, nullable=False, default="chat")
    is_active = Column(Boolean, default=True)
    last_used_at = Column(DateTime, nullable=True)


class Webhook(TimestampMixin, Base):
    """事件触发的外发 Webhook。"""
    __tablename__ = "webhooks"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    url = Column(String, nullable=False)
    secret = Column(String, nullable=True)  # HMAC-SHA256 signing secret
    events = Column(String, nullable=False)  # comma-separated event types
    is_active = Column(Boolean, default=True)
    last_triggered_at = Column(DateTime, nullable=True)
    last_status_code = Column(Integer, nullable=True)
    last_error = Column(String, nullable=True)


class UserTool(TimestampMixin, Base):
    """用户创建的沙盒化迷你应用/工具。"""
    __tablename__ = "user_tools"

    id            = Column(String, primary_key=True, index=True)
    name          = Column(String, nullable=False)
    description   = Column(Text, nullable=True)
    icon          = Column(String, nullable=True, default="")
    html_content  = Column(Text, nullable=False)
    scope         = Column(String, nullable=False, default="global")  # "global" or session_id
    session_id    = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True)
    owner         = Column(String, nullable=True, index=True)      # username
    is_pinned     = Column(Boolean, default=False)
    is_active     = Column(Boolean, default=True)
    version       = Column(Integer, default=1)
    author        = Column(String, nullable=True, default="ai")

    session = relationship("Session", backref=backref("user_tools", cascade="all, delete-orphan"))

    __table_args__ = (
        Index('ix_user_tools_scope', 'scope'),
        Index('ix_user_tools_active', 'is_active'),
    )


class UserToolData(Base):
    """用户工具持久化数据的键值存储。"""
    __tablename__ = "user_tool_data"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    tool_id    = Column(String, ForeignKey("user_tools.id", ondelete="CASCADE"), nullable=False)
    key        = Column(String, nullable=False)
    value      = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utcnow_naive)
    updated_at = Column(DateTime, default=utcnow_naive, onupdate=utcnow_naive)

    tool = relationship("UserTool", backref=backref("data_entries", cascade="all, delete-orphan"))

    __table_args__ = (
        Index('ix_user_tool_data_tool_key', 'tool_id', 'key', unique=True),
    )


class CrewMember(TimestampMixin, Base):
    """自定义 AI 角色（'团队成员'），拥有自己的个性、模型、工具和记忆范围。"""
    __tablename__ = "crew_members"

    id            = Column(String, primary_key=True, index=True)
    owner         = Column(String, nullable=True, index=True)
    name          = Column(String, nullable=False)
    avatar        = Column(String, nullable=True)
    user_name     = Column(String, nullable=True)          # what they call the user
    personality   = Column(Text, nullable=True)             # system prompt
    model         = Column(String, nullable=True)
    endpoint_url  = Column(String, nullable=True)
    greeting      = Column(Text, nullable=True)
    enabled_tools = Column(Text, nullable=True)             # JSON array or "all"
    session_id    = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True)
    is_active     = Column(Boolean, default=True)
    sort_order    = Column(Integer, default=0)
    is_default_assistant = Column(Boolean, default=False)   # singleton per-owner "personal assistant"
    timezone      = Column(String, nullable=True)           # IANA tz name (e.g. "America/New_York") for scheduled check-ins

    session = relationship("Session", foreign_keys=[session_id],
                           backref=backref("crew_member", uselist=False))


class ScheduledTask(TimestampMixin, Base):
    """周期性或一次性任务 — LLM 驱动或直接操作，时间或事件触发。"""
    __tablename__ = "scheduled_tasks"

    id             = Column(String, primary_key=True, index=True)
    owner          = Column(String, nullable=True, index=True)
    name           = Column(String, nullable=False, default="Untitled Task")
    prompt         = Column(Text, nullable=True)              # LLM prompt (for task_type="llm")
    task_type      = Column(String, default="llm")            # "llm" | "action"
    action         = Column(String, nullable=True)            # builtin action name (for task_type="action")
    schedule       = Column(String, nullable=True)            # "once", "daily", "weekly", "monthly"
    scheduled_time = Column(String, nullable=True)            # "HH:MM" (24h, stored UTC)
    scheduled_day  = Column(Integer, nullable=True)           # day-of-week 0=Mon for weekly, day-of-month for monthly
    scheduled_date = Column(DateTime, nullable=True)          # exact datetime for "once"
    trigger_type   = Column(String, default="schedule")       # "schedule" | "event"
    trigger_event  = Column(String, nullable=True)            # e.g. "session_created", "message_sent"
    trigger_count  = Column(Integer, nullable=True)           # fire every N events
    trigger_counter = Column(Integer, default=0)              # current count toward trigger_count
    next_run       = Column(DateTime, nullable=True, index=True)
    last_run       = Column(DateTime, nullable=True)
    status         = Column(String, default="active")         # "active", "paused", "completed"
    output_target  = Column(String, default="session")        # "session" (extensible later)
    session_id     = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True)
    model          = Column(String, nullable=True)
    endpoint_url   = Column(String, nullable=True)
    run_count      = Column(Integer, default=0)

    cron_expression = Column(String, nullable=True)           # cron string e.g. "*/5 * * * *"
    then_task_id   = Column(String, ForeignKey("scheduled_tasks.id", ondelete="SET NULL"), nullable=True)
    webhook_token  = Column(String, nullable=True, unique=True)
    crew_member_id = Column(String, nullable=True)     # optional link to crew_members.id
    # character_id 历史上引用了从未实际创建的 agent_characters 表。
    # 保留此列以保持架构兼容性，但删除 ForeignKey
    # 以便 SQLAlchemy 表排序在刷新时不会失败。
    character_id   = Column(String, nullable=True)
    max_steps      = Column(Integer, nullable=True)       # 最大 agent 循环迭代次数（null=无限制）
    email_results  = Column(Boolean, default=True)        # 将结果通过电子邮件发送到 character.email_to
    notifications_enabled = Column(Boolean, default=True) # 每个任务的完成通知开关

    session = relationship("Session", backref=backref("scheduled_tasks", cascade="save-update, merge"))
    then_task = relationship("ScheduledTask", remote_side=[id], foreign_keys=[then_task_id])

    __table_args__ = (
        Index('ix_scheduled_tasks_due', 'status', 'next_run'),
        Index('ix_scheduled_tasks_event', 'trigger_type', 'trigger_event', 'status'),
    )


class EditorDraft(TimestampMixin, Base):
    """持久化的进行中图库编辑器会话 — 分层项目状态，
    用户可以关闭并在以后重新打开。将完整的图层有效负载
    存储为 JSON（每层包含 base64 编码的 PNG dataURL），
    并附带一个小缩略图用于首页列表。
    """
    __tablename__ = "editor_drafts"

    id              = Column(String, primary_key=True, index=True)
    owner           = Column(String, nullable=True, index=True)
    name            = Column(String, nullable=False, default="Untitled")
    # 如果草稿是从图库照片打开的，回指它，以便我们
    # 可以显示"恢复编辑 <photo>"，重新打开该照片时
    # 会恢复相同的草稿，而不是从头开始。
    source_image_id = Column(String, nullable=True, index=True)
    width           = Column(Integer, nullable=True)
    height          = Column(Integer, nullable=True)
    # Full draft body — layer pixels (base64 PNG dataURLs), offsets,
    # opacities, visibility, active id, next id, etc. Kept as TEXT/JSON so
    # we don't have to re-shape the model every time the editor adds a
    # new piece of state.
    payload         = Column(Text, nullable=False, default="")
    # 用于列表页面的小预览（data URL，约 128px 宽）。内联存储，
    # 以便列表端点可以一次性返回所有内容。
    thumbnail       = Column(Text, nullable=True)
    is_active       = Column(Boolean, default=True)

    __table_args__ = (
        Index('ix_editor_drafts_owner_updated', 'owner', 'is_active', 'updated_at'),
    )


class TaskRun(Base):
    """ScheduledTask 的单次执行记录。"""
    __tablename__ = "task_runs"

    id          = Column(String, primary_key=True, index=True)
    task_id     = Column(String, ForeignKey("scheduled_tasks.id", ondelete="CASCADE"), nullable=False)
    started_at  = Column(DateTime, nullable=False, default=utcnow_naive)
    finished_at = Column(DateTime, nullable=True)
    status      = Column(String, default="running")  # "running", "success", "error"
    result      = Column(Text, nullable=True)
    error       = Column(Text, nullable=True)
    tokens_used = Column(Integer, nullable=True)
    steps       = Column(Text, nullable=True)             # JSON log of agent tool calls
    model       = Column(String, nullable=True)           # model that actually ran (resolved at execution)

    task = relationship("ScheduledTask", backref=backref("runs", cascade="all, delete-orphan",
                        order_by="TaskRun.started_at.desc()"))

    __table_args__ = (
        Index('ix_task_runs_task', 'task_id', 'started_at'),
    )


class Memory(Base):
    """
    记忆表的 SQLAlchemy 模型。
    表示带有元数据的持久化记忆条目。
    """
    __tablename__ = "memories"
    
    # 主键
    id = Column(String, primary_key=True, index=True)
    
    # 记忆内容
    text = Column(Text, nullable=False)
    
    # 分类
    category = Column(String, default='fact')
    source = Column(String, default='user')

    # 所有者（用户名）
    owner = Column(String, nullable=True, index=True)

    # 关联到会话（可为空）
    session_id = Column(String, ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True, index=True)

    # 时间戳，Unix 时间戳格式
    timestamp = Column(Integer, default=lambda: int(utcnow_naive().timestamp()))

    # 与 Session 的关联关系
    session = relationship("Session", backref="memories")

    # 索引 - 优化的复合索引
    __table_args__ = (
        Index('ix_memories_lookup', 'category', 'timestamp'),  # 用于基于分类的查询
        Index('ix_memories_session', 'session_id', 'timestamp'),  # 用于基于会话的查询
    )

def _migrate_add_last_message_at_column():
    """Add last_message_at to sessions + backfill from the latest message
    最新消息时间戳回填（无消息时回退到 last_accessed / created_at）。
    session has no messages). Idempotent: column-add is guarded, and the
    backfill only touches rows where last_message_at is still NULL so it
    won't clobber live values on later restarts."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(sessions)")
        columns = [row[1] for row in cursor.fetchall()]
        if "last_message_at" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN last_message_at DATETIME")
        # 回填所有 NULL 行：最新消息时间戳，否则 last_accessed，
        # 否则 created_at。仅填充 NULL，因此在每次启动时都是安全的。
        conn.execute(
            """
            UPDATE sessions
               SET last_message_at = COALESCE(
                   (SELECT MAX(timestamp) FROM chat_messages
                     WHERE chat_messages.session_id = sessions.id),
                   last_accessed,
                   created_at
               )
             WHERE last_message_at IS NULL
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS ix_sessions_last_message_at "
            "ON sessions(archived, last_message_at)"
        )
        conn.commit()
        logging.getLogger(__name__).info("Migrated: added + backfilled 'last_message_at' on sessions")
    except Exception as e:
        logging.getLogger(__name__).warning(f"last_message_at migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_document_archived_column():
    """为 documents 表添加 `archived` 列（软归档标志）。有防护检查，幂等。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(documents)")
        columns = [row[1] for row in cursor.fetchall()]
        if "archived" not in columns:
            conn.execute("ALTER TABLE documents ADD COLUMN archived BOOLEAN DEFAULT 0")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'archived' to documents")
    except Exception as e:
        logging.getLogger(__name__).warning(f"documents.archived migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _migrate_add_owner_column():
    """将 owner 列添加到 sessions 表（如果不存在）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(sessions)")
        columns = [row[1] for row in cursor.fetchall()]
        if "owner" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN owner TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_sessions_owner ON sessions(owner)")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'owner' column to sessions")
    except Exception as e:
        logging.getLogger(__name__).warning(f"Migration check failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_model_endpoints():
    """重建 model_endpoints 表（如果架构变更，url→base_url 迁移）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "base_url" not in columns:
            conn.execute("DROP TABLE IF EXISTS model_endpoints")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: dropped old model_endpoints table (schema change)")
    except Exception as e:
        logging.getLogger(__name__).warning(f"model_endpoints migration check failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_hidden_models_column():
    """将 hidden_models 列添加到 model_endpoints（如果不存在）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "hidden_models" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN hidden_models TEXT")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'hidden_models' column to model_endpoints")
    except Exception as e:
        logging.getLogger(__name__).warning(f"hidden_models migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_model_endpoint_owner_column():
    """将 owner 列添加到 model_endpoints（如果不存在）。

    如果没有此列，按用户模型选择器查询
    `(owner == user) | (owner IS NULL)` 会因 `OperationalError:
    no such column: model_endpoints.owner` 而失败，导致非管理员用户
    即使 `allowed_models` 不受限制，选择器也为空。
    为现有行回填 NULL（被过滤器视为共享）。
    """
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "owner" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN owner VARCHAR")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_model_endpoints_owner ON model_endpoints(owner)")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'owner' column + index to model_endpoints")
    except Exception as e:
        logging.getLogger(__name__).warning(f"model_endpoints.owner migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _migrate_add_provider_auth_id_column():
    """将 provider_auth_id 列添加到 model_endpoints（如果不存在）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "provider_auth_id" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN provider_auth_id VARCHAR")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_model_endpoints_provider_auth_id ON model_endpoints(provider_auth_id)")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'provider_auth_id' column + index to model_endpoints")
    except Exception as e:
        logging.getLogger(__name__).warning(f"model_endpoints.provider_auth_id migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _migrate_add_model_type_column():
    """将 model_type 列添加到 model_endpoints（如果不存在）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "model_type" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN model_type TEXT DEFAULT 'llm'")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'model_type' column to model_endpoints")
    except Exception as e:
        logging.getLogger(__name__).warning(f"model_type migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_model_endpoint_refresh_columns():
    """添加端点分类/刷新策略列（如果缺失）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "endpoint_kind" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN endpoint_kind TEXT DEFAULT 'auto'")
        if columns and "model_refresh_mode" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN model_refresh_mode TEXT DEFAULT 'auto'")
        if columns and "model_refresh_interval" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN model_refresh_interval INTEGER")
        if columns and "model_refresh_timeout" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN model_refresh_timeout INTEGER")
        conn.commit()
    except Exception as e:
        logging.getLogger(__name__).warning(f"model_endpoints refresh-policy migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_task_run_model_column():
    """将 model 列添加到 task_runs（如果不存在），记录实际运行的模型。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(task_runs)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "model" not in columns:
            conn.execute("ALTER TABLE task_runs ADD COLUMN model TEXT")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'model' column to task_runs")
    except Exception as e:
        logging.getLogger(__name__).warning(f"task_runs model migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_supports_tools_column():
    """将 supports_tools 列添加到 model_endpoints（如果不存在）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "supports_tools" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN supports_tools BOOLEAN")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'supports_tools' column to model_endpoints")
    except Exception as e:
        logging.getLogger(__name__).warning(f"supports_tools migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _migrate_add_cached_models_column():
    """将 cached_models 列添加到 model_endpoints（如果不存在）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "cached_models" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN cached_models TEXT")
            conn.commit()
    except Exception as e:
        logging.getLogger(__name__).warning(f"cached_models migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_pinned_models_column():
    """将 pinned_models 列添加到 model_endpoints（如果不存在）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(model_endpoints)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "pinned_models" not in columns:
            conn.execute("ALTER TABLE model_endpoints ADD COLUMN pinned_models TEXT")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'pinned_models' column to model_endpoints")
    except Exception as e:
        logging.getLogger(__name__).warning(f"pinned_models migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_notes_sort_order():
    """将 sort_order、image_url、repeat 列添加到 notes（如果不存在）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(notes)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "sort_order" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN sort_order INTEGER DEFAULT 0")
        if columns and "image_url" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN image_url TEXT")
        if columns and "repeat" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN repeat TEXT DEFAULT 'none'")
        if columns and "ai_classification" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN ai_classification TEXT")
        if columns and "ai_content_hash" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN ai_content_hash TEXT")
        if columns and "agent_session_id" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN agent_session_id TEXT")
        conn.commit()
    except Exception as e:
        logging.getLogger(__name__).warning(f"notes migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_mode_column():
    """将 mode 列添加到 sessions 表（如果不存在）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(sessions)")
        columns = [row[1] for row in cursor.fetchall()]
        if "mode" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN mode TEXT")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'mode' column to sessions")
    except Exception as e:
        logging.getLogger(__name__).warning(f"Migration check for mode failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_folder_column():
    """将 folder 列添加到 sessions 表（如果不存在）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(sessions)")
        columns = [row[1] for row in cursor.fetchall()]
        if "folder" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN folder TEXT")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'folder' column to sessions")
    except Exception as e:
        logging.getLogger(__name__).warning(f"Migration check for folder failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_token_columns():
    """将累计 token 跟踪列添加到 sessions 表。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(sessions)")
        columns = [row[1] for row in cursor.fetchall()]
        if "total_input_tokens" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN total_input_tokens INTEGER DEFAULT 0")
            conn.execute("ALTER TABLE sessions ADD COLUMN total_output_tokens INTEGER DEFAULT 0")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added token tracking columns to sessions")
    except Exception as e:
        logging.getLogger(__name__).warning(f"Migration check for token columns failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_owner_to_table(table_name: str, index_name: str):
    """通用辅助函数：将 owner TEXT 列 + 索引添加到表（如果缺失）。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute(f"PRAGMA table_info({table_name})")
        columns = [row[1] for row in cursor.fetchall()]
        if "owner" not in columns:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN owner TEXT")
            conn.execute(f"CREATE INDEX IF NOT EXISTS {index_name} ON {table_name}(owner)")
            conn.commit()
            logging.getLogger(__name__).info(f"Migrated: added 'owner' column to {table_name}")
    except Exception as e:
        logging.getLogger(__name__).warning(f"Migration owner column for {table_name} failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_add_multiuser_owner_columns():
    """将 owner 列添加到 memories、gallery_images、user_tools、comparisons。"""
    _migrate_add_owner_to_table("memories", "ix_memories_owner")
    _migrate_add_owner_to_table("gallery_images", "ix_gallery_images_owner")
    _migrate_add_owner_to_table("user_tools", "ix_user_tools_owner")
    _migrate_add_owner_to_table("comparisons", "ix_comparisons_owner")
    _migrate_add_owner_to_table("api_tokens", "ix_api_tokens_owner")
    # 在此列存在之前，documents 通过其会话关联派生所有权；
    # 传统所有者扫描（见下文）在下次启动时回填。
    _migrate_add_owner_to_table("documents", "ix_documents_owner")


def _migrate_add_api_token_scopes_column():
    """为现有安装添加 API 令牌作用域。

    Existing tokens get the current only-supported scope (`chat`) so they keep
    working after the schema migration, but route checks no longer treat tokens
    as an unscoped bearer credential.
    """
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        columns = [row[1] for row in conn.execute("PRAGMA table_info(api_tokens)").fetchall()]
        if columns and "scopes" not in columns:
            conn.execute("ALTER TABLE api_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT 'chat'")
            conn.execute("UPDATE api_tokens SET scopes = 'chat' WHERE scopes IS NULL OR scopes = ''")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added scopes column to api_tokens")
    except Exception as e:
        logging.getLogger(__name__).warning(f"api_tokens.scopes migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def _migrate_assign_legacy_owner():
    """将所有空 owner 的数据分配给第一个（管理员）用户。

    在启动时和定期（sweep_null_owners）运行，以确保在认证禁用 /
    通过 localhost 绕过中间件时创建的数据不会以全局可访问的方式
    存在于数据库中。以前只扫描 5 张表；实际拥有 owner 列的表
    集合要大得多。
    """
    import sqlite3
    import json as _json

    # 从 auth.json 查找管理员用户。认证架构使用 `is_admin: True`，
    # 而不是 `role: "admin"` — 旧代码查找了错误的字段，
    # 每次都静默地回退到"第一个用户"。
    auth_path = os.path.join(os.path.dirname(DATABASE_URL.replace("sqlite:///", "")), "auth.json")
    if not os.path.isabs(auth_path):
        auth_path = AUTH_FILE
    admin_user = None
    try:
        with open(auth_path, "r", encoding="utf-8") as f:
            auth_data = _json.load(f)
        users = auth_data.get("users", {})
        if users:
            for uname, udata in users.items():
                if udata.get("is_admin") is True:
                    admin_user = uname
                    break
            if not admin_user:
                admin_user = next(iter(users))
    except Exception:
        pass

    if not admin_user:
        return

    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return

    logger = logging.getLogger(__name__)
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        # 每个有 `owner` 列的表。后续新增的表将自动
        # 被识别，因为我们只在列存在时才 UPDATE；
        # 显式列表用于记录意图。
        tables = [
            "sessions", "memories", "gallery_images", "user_tools",
            "comparisons", "documents", "signatures", "notes",
            "calendars", "calendar_events", "integrations",
            "scheduled_tasks", "task_runs", "crew_members",
            "gallery_albums", "gallery_people", "user_tool_data",
            "api_tokens", "webhooks",
        ]
        for table in tables:
            try:
                cursor = conn.execute(f"PRAGMA table_info({table})")
                columns = [row[1] for row in cursor.fetchall()]
                if "owner" in columns:
                    res = conn.execute(f"UPDATE {table} SET owner = ? WHERE owner IS NULL", (admin_user,))
                    if res.rowcount > 0:
                        logger.info(f"Assigned {res.rowcount} legacy rows in {table} to '{admin_user}'")
            except Exception as e:
                logger.warning(f"Legacy owner assignment for {table} failed: {e}")
        conn.commit()
    except Exception as e:
        logger.warning(f"Legacy owner migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

    # 同时迁移 memory.json
    mem_path = MEMORY_FILE
    try:
        if os.path.exists(mem_path):
            with open(mem_path, "r", encoding="utf-8") as f:
                memories = _json.load(f)
            changed = False
            for m in memories:
                if not m.get("owner"):
                    m["owner"] = admin_user
                    changed = True
            if changed:
                with open(mem_path, "w", encoding="utf-8") as f:
                    _json.dump(memories, f, ensure_ascii=False, indent=2)
                logger.info(f"Assigned {sum(1 for _ in memories)} legacy memories in memory.json to '{admin_user}'")
    except Exception as e:
        logger.warning(f"memory.json legacy migration failed: {e}")

    # 同时迁移 user_prefs.json 到按用户格式
    prefs_path = USER_PREFS_FILE
    try:
        if os.path.exists(prefs_path):
            with open(prefs_path, "r", encoding="utf-8") as f:
                prefs = _json.load(f)
            if "_users" not in prefs and prefs:
                # 扁平格式 → 嵌套在管理员用户下
                new_prefs = {"_users": {admin_user: prefs}}
                with open(prefs_path, "w", encoding="utf-8") as f:
                    _json.dump(new_prefs, f, indent=2)
                logger.info(f"Migrated user_prefs.json to per-user format under '{admin_user}'")
    except Exception as e:
        logger.warning(f"user_prefs.json migration failed: {e}")


def _migrate_backfill_document_owner_from_session():
    """从关联的聊天会话回填 documents.owner。

    必须在添加 owner 列之后、批量旧版 owner 清扫之前运行，
    以便与会话关联的文档获得其*真实*所有者，而只有真正的
    孤立文档（无会话）才会落到管理员分配中。幂等 — 仅处理
    NULL-owner 的行。"""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(documents)"))]
            if "owner" not in cols:
                return
            res = conn.execute(text(
                "UPDATE documents SET owner = ("
                "  SELECT s.owner FROM sessions s WHERE s.id = documents.session_id"
                ") WHERE owner IS NULL AND session_id IS NOT NULL "
                "AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = documents.session_id "
                "            AND s.owner IS NOT NULL)"
            ))
            conn.commit()
            if res.rowcount:
                logging.getLogger(__name__).info(
                    f"Backfilled owner on {res.rowcount} session-linked documents")
    except Exception as e:
        logging.getLogger(__name__).warning(f"document owner backfill: {e}")


def _migrate_add_tidy_verdict():
    """将 tidy_verdict 列添加到 documents 表（如果缺失）。"""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(documents)"))]
            if "tidy_verdict" not in cols:
                conn.execute(text("ALTER TABLE documents ADD COLUMN tidy_verdict VARCHAR"))
                conn.commit()
                logging.getLogger(__name__).info("Added tidy_verdict column to documents")
    except Exception as e:
        logging.getLogger(__name__).warning(f"tidy_verdict migration: {e}")


def _migrate_add_doc_source_email_cols():
    """为 documents 表添加源邮件溯源列（用于签名并回复流程）。"""
    cols_to_add = {
        "source_email_uid":        "VARCHAR",
        "source_email_folder":     "VARCHAR",
        "source_email_account_id": "VARCHAR",
        "source_email_message_id": "VARCHAR",
    }
    try:
        with engine.connect() as conn:
            existing = {r[1] for r in conn.execute(text("PRAGMA table_info(documents)"))}
            for col, spec in cols_to_add.items():
                if col not in existing:
                    conn.execute(text(f"ALTER TABLE documents ADD COLUMN {col} {spec}"))
                    logging.getLogger(__name__).info(f"Added {col} column to documents")
            # 用于按消息 ID 查找的索引（"查找现有草稿"路径）
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_documents_source_email_message_id "
                "ON documents (source_email_message_id)"
            ))
            conn.commit()
    except Exception as e:
        logging.getLogger(__name__).warning(f"doc source-email migration: {e}")

def _migrate_add_task_automation_columns():
    """将自动化列添加到 scheduled_tasks 表（如果缺失）。"""
    new_cols = {
        "task_type": "VARCHAR DEFAULT 'llm'",
        "action": "VARCHAR",
        "trigger_type": "VARCHAR DEFAULT 'schedule'",
        "trigger_event": "VARCHAR",
        "trigger_count": "INTEGER",
        "trigger_counter": "INTEGER DEFAULT 0",
    }
    try:
        with engine.connect() as conn:
            cols_info = list(conn.execute(text("PRAGMA table_info(scheduled_tasks)")))
            col_names = [r[1] for r in cols_info]
            for col_name, col_def in new_cols.items():
                if col_name not in col_names:
                    conn.execute(text(f"ALTER TABLE scheduled_tasks ADD COLUMN {col_name} {col_def}"))

            # 检查 prompt/schedule/scheduled_time 是否仍为 NOT NULL — 需要重建表
            notnull_map = {r[1]: r[3] for r in cols_info}
            needs_rebuild = (
                notnull_map.get("prompt", 0) == 1 or
                notnull_map.get("schedule", 0) == 1 or
                notnull_map.get("scheduled_time", 0) == 1
            )
            if needs_rebuild:
                logging.getLogger(__name__).info("Rebuilding scheduled_tasks to make prompt/schedule/scheduled_time nullable")
                conn.execute(text("ALTER TABLE scheduled_tasks RENAME TO _old_scheduled_tasks"))
                conn.execute(text("""
                    CREATE TABLE scheduled_tasks (
                        id VARCHAR PRIMARY KEY,
                        owner VARCHAR,
                        name VARCHAR NOT NULL,
                        prompt TEXT,
                        schedule VARCHAR,
                        scheduled_time VARCHAR,
                        scheduled_day INTEGER,
                        scheduled_date DATETIME,
                        next_run DATETIME,
                        last_run DATETIME,
                        status VARCHAR,
                        output_target VARCHAR,
                        session_id VARCHAR,
                        model VARCHAR,
                        endpoint_url VARCHAR,
                        run_count INTEGER,
                        created_at DATETIME NOT NULL,
                        updated_at DATETIME NOT NULL,
                        task_type VARCHAR DEFAULT 'llm',
                        action VARCHAR,
                        trigger_type VARCHAR DEFAULT 'schedule',
                        trigger_event VARCHAR,
                        trigger_count INTEGER,
                        trigger_counter INTEGER DEFAULT 0
                    )
                """))
                conn.execute(text("""
                    INSERT INTO scheduled_tasks
                    SELECT id, owner, name, prompt, schedule, scheduled_time,
                           scheduled_day, scheduled_date, next_run, last_run,
                           status, output_target, session_id, model, endpoint_url,
                           run_count, created_at, updated_at,
                           task_type, action, trigger_type, trigger_event,
                           trigger_count, trigger_counter
                    FROM _old_scheduled_tasks
                """))
                conn.execute(text("DROP TABLE _old_scheduled_tasks"))

            conn.commit()
            logging.getLogger(__name__).info("Task automation columns migration complete")
    except Exception as e:
        logging.getLogger(__name__).warning(f"task automation migration: {e}")

def _migrate_add_oauth_config():
    """将 oauth_config 列添加到 mcp_servers 表（如果缺失）。"""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(mcp_servers)"))]
            if "oauth_config" not in cols:
                conn.execute(text("ALTER TABLE mcp_servers ADD COLUMN oauth_config TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added oauth_config column to mcp_servers")
    except Exception as e:
        logging.getLogger(__name__).warning(f"oauth_config migration: {e}")

def _migrate_add_disabled_tools():
    """将 disabled_tools 列添加到 mcp_servers 表（如果缺失）。"""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(mcp_servers)"))]
            if "disabled_tools" not in cols:
                conn.execute(text("ALTER TABLE mcp_servers ADD COLUMN disabled_tools TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added disabled_tools column to mcp_servers")
    except Exception as e:
        logging.getLogger(__name__).warning(f"disabled_tools migration: {e}")

def _migrate_add_mcp_oauth_tokens_column():
    """将 oauth_tokens 列添加到 mcp_servers 表（如果缺失）。

    模型将此列声明为 EncryptedText，但 SQL 类型有意使用纯 TEXT：
    EncryptedText 是一个 SQLAlchemy TypeDecorator，在 Python 层加密
    并将密文存储为 TEXT，因此数据库列类型是 TEXT。这与现有的
    加密列一致（参见 _migrate_encrypt_*）。"""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(mcp_servers)"))]
            if "oauth_tokens" not in cols:
                conn.execute(text("ALTER TABLE mcp_servers ADD COLUMN oauth_tokens TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added oauth_tokens column to mcp_servers")
    except Exception as e:
        logging.getLogger(__name__).warning(f"oauth_tokens migration: {e}")

def _migrate_add_task_v2_columns():
    """将 cron_expression、then_task_id、webhook_token 添加到 scheduled_tasks。"""
    new_cols = {
        "cron_expression": "VARCHAR",
        "then_task_id": "VARCHAR",
        "webhook_token": "VARCHAR",
    }
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(scheduled_tasks)"))]
            for col_name, col_def in new_cols.items():
                if col_name not in cols:
                    conn.execute(text(f"ALTER TABLE scheduled_tasks ADD COLUMN {col_name} {col_def}"))
            if "webhook_token" not in cols:
                conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_scheduled_tasks_webhook ON scheduled_tasks(webhook_token)"))
            conn.commit()
            logging.getLogger(__name__).info("Task v2 columns migration complete")
    except Exception as e:
        logging.getLogger(__name__).warning(f"task v2 migration: {e}")

def _migrate_drop_ping_notes_tasks():
    """一次性清理：ping_notes 和 ping_events 曾经被作为面向用户的
    任务播种。现在它们是调度器内部的纯后台扫描器
    （不使用 LLM，不属于 Tasks UI）。删除两者的现有行及其运行记录。
    （tidy_sessions/documents/research 仍然保留为任务。）"""
    targets = ("ping_notes", "ping_events")
    try:
        with engine.connect() as conn:
            for action in targets:
                conn.execute(text(
                    "DELETE FROM task_runs WHERE task_id IN "
                    "(SELECT id FROM scheduled_tasks WHERE action=:a)"
                ), {"a": action})
                r = conn.execute(text("DELETE FROM scheduled_tasks WHERE action=:a"), {"a": action})
                if r.rowcount:
                    logging.getLogger(__name__).info(f"Dropped {r.rowcount} {action} task row(s)")
            conn.commit()
    except Exception as e:
        logging.getLogger(__name__).debug(f"drop_ping_notes_tasks: {e}")


def _migrate_add_notifications_enabled():
    """每个任务的通知开关（默认开启）。"""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(scheduled_tasks)"))]
            if "notifications_enabled" not in cols:
                conn.execute(text("ALTER TABLE scheduled_tasks ADD COLUMN notifications_enabled BOOLEAN DEFAULT 1"))
                conn.commit()
                logging.getLogger(__name__).info("Added notifications_enabled column to scheduled_tasks")
    except Exception as e:
        logging.getLogger(__name__).warning(f"notifications_enabled migration: {e}")


def _migrate_add_crew_member_id():
    """将 crew_member_id 列添加到 sessions 和 scheduled_tasks 表（如果缺失）。"""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(sessions)"))]
            if "crew_member_id" not in cols:
                conn.execute(text("ALTER TABLE sessions ADD COLUMN crew_member_id TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added crew_member_id column to sessions")
            cols2 = [r[1] for r in conn.execute(text("PRAGMA table_info(scheduled_tasks)"))]
            if "crew_member_id" not in cols2:
                conn.execute(text("ALTER TABLE scheduled_tasks ADD COLUMN crew_member_id TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added crew_member_id column to scheduled_tasks")
    except Exception as e:
        logging.getLogger(__name__).warning(f"crew_member_id migration: {e}")

def _migrate_add_assistant_columns():
    """为 personal-assistant 功能将 is_default_assistant + timezone 列添加到 crew_members。"""
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(crew_members)"))]
            if "is_default_assistant" not in cols:
                conn.execute(text("ALTER TABLE crew_members ADD COLUMN is_default_assistant BOOLEAN DEFAULT 0"))
                conn.commit()
                logging.getLogger(__name__).info("Added is_default_assistant column to crew_members")
            if "timezone" not in cols:
                conn.execute(text("ALTER TABLE crew_members ADD COLUMN timezone TEXT"))
                conn.commit()
                logging.getLogger(__name__).info("Added timezone column to crew_members")
    except Exception as e:
        logging.getLogger(__name__).warning(f"assistant columns migration: {e}")





class Note(TimestampMixin, Base):
    """Google Keep 风格的便签或清单。"""
    __tablename__ = "notes"

    id         = Column(String, primary_key=True, index=True)
    owner      = Column(String, nullable=True, index=True)
    title      = Column(String, default="")
    content    = Column(Text, nullable=True)
    items      = Column(Text, nullable=True)       # JSON string of [{text, done}]
    note_type  = Column(String, default="note")     # "note" or "checklist"
    color      = Column(String, nullable=True)
    label      = Column(String, nullable=True)
    pinned     = Column(Boolean, default=False)
    archived   = Column(Boolean, default=False)
    due_date   = Column(String, nullable=True)
    source     = Column(String, default="user")     # "user" 或 "agent"
    session_id = Column(String, nullable=True)
    sort_order = Column(Integer, default=0)
    image_url  = Column(String, nullable=True)      # 上传的图片 URL（相对路径）
    repeat     = Column(String, default="none")     # none、daily、weekly、monthly、yearly
    # Auto-AI 字段 — 由 /api/notes/{id}/classify 填充。分类
    # JSON 形状为 { kind, solvable, confidence, task_prompt, tools, items?: [...] }。
    # 内容哈希作为重新分类的门控（避免每次保存都消耗 LLM 费用）。
    ai_classification = Column(Text, nullable=True)
    ai_content_hash   = Column(String, nullable=True)
    # 由便签的"Agent"按钮生成的任务会话（solve-this-todo）。
    # 便签显示一个可点击的标签，用于打开此会话进行审阅。
    agent_session_id  = Column(String, nullable=True)


class CalendarCal(TimestampMixin, Base):
    """一个日历（例如 'Personal'、'TimeTree'）。"""
    __tablename__ = "calendars"

    id    = Column(String, primary_key=True, index=True)
    owner = Column(String, nullable=True, index=True)
    name  = Column(String, nullable=False)
    color = Column(String, default="#5b8abf")
    source = Column(String, default="local")  # "local" 或 "caldav"
    # 用户偏好设置中拥有此日历的 CalDAV 账户的 UUID。
    # 对于本地日历和在多账户支持添加之前创建的 CalDAV 日历
    # 为 NULL（视为"使用任何已配置的账户"）。
    account_id = Column(String, nullable=True, index=True)
    caldav_base_url = Column(String, nullable=True)

    events = relationship("CalendarEvent", back_populates="calendar", cascade="all, delete-orphan")


class CalendarEvent(TimestampMixin, Base):
    """一个日历事件。"""
    __tablename__ = "calendar_events"

    uid         = Column(String, primary_key=True, index=True)
    calendar_id = Column(String, ForeignKey("calendars.id"), nullable=False, index=True)
    summary     = Column(String, nullable=False, default="")
    description = Column(Text, default="")
    location    = Column(String, default="")
    dtstart     = Column(DateTime, nullable=False, index=True)
    dtend       = Column(DateTime, nullable=False)
    all_day     = Column(Boolean, default=False)
    # 当 dtstart/dtend 存储为 UTC 时刻时为 True（在保留源 TZID 的
    # 导入路径上设置）。False = 传统本地时间。驱动序列化时的
    # `Z` 后缀，以便前端正确解释。
    is_utc      = Column(Boolean, default=False, nullable=False)
    rrule       = Column(String, default="")
    color       = Column(String, nullable=True)  # 每个事件的颜色覆盖
    status      = Column(String, default="confirmed")  # confirmed、cancelled
    importance  = Column(String, default="normal")    # low | normal | high | critical
    event_type  = Column(String, nullable=True)        # work | personal | health | travel | meal | social | admin | other
    last_pinged = Column(DateTime, nullable=True)      # 助手上次提醒此事件的时间
    # "caldav" = 从 CalDAV 服务器拉取（因此同步可能在其在
    # 上游消失时清除它）。NULL/local = 本地创建（agent、邮件分类或
    # 写入失败的 UI 事件），绝不能被同步清除。
    origin      = Column(String, nullable=True, index=True)
    remote_href = Column(String, nullable=True)        # CalDAV object URL for updates/deletes
    remote_etag = Column(String, nullable=True)        # Last seen CalDAV ETag, when available
    caldav_sync_pending = Column(String, nullable=True) # create | update | delete retry marker

    calendar = relationship("CalendarCal", back_populates="events")


class CalendarDeletedEvent(TimestampMixin, Base):
    """Hidden CalDAV delete tombstone retained until remote delete succeeds."""
    __tablename__ = "caldav_deleted_events"

    uid = Column(String, primary_key=True, index=True)
    owner = Column(String, nullable=True, index=True)
    calendar_id = Column(String, nullable=True, index=True)
    remote_href = Column(String, nullable=True)
    remote_etag = Column(String, nullable=True)
    caldav_base_url = Column(String, nullable=True)
    summary = Column(String, nullable=True)
    last_error = Column(Text, nullable=True)


class Integration(TimestampMixin, Base):
    """一个外部服务连接（电子邮件、RSS、Webhook 等）。"""
    __tablename__ = "integrations"

    id     = Column(String, primary_key=True, index=True)
    owner  = Column(String, nullable=True, index=True)
    name   = Column(String, nullable=False)
    type   = Column(String, nullable=False)  # "email", "rss", "webhook"
    config = Column(JSON, nullable=True)     # type-specific config
    enabled = Column(Boolean, default=True)





def _migrate_seed_email_account():
    """如果 email_accounts 为空且 settings.json 中有旧版平铺的
    imap_host/smtp_host 键，则从中创建一个默认账户，确保升级用户
    不受影响。可安全重复运行 — 一旦存在任何行就短路返回。"""
    try:
        with engine.connect() as conn:
            tables = [r[0] for r in conn.execute(text(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='email_accounts'"
            ))]
            if "email_accounts" not in tables:
                return
            existing = conn.execute(text("SELECT COUNT(*) FROM email_accounts")).scalar() or 0
            if existing > 0:
                return

        import json as _json
        import uuid as _uuid
        from pathlib import Path
        settings_file = Path(SETTINGS_FILE)
        if not settings_file.exists():
            return
        try:
            s = _json.loads(settings_file.read_text(encoding="utf-8"))
        except Exception:
            return

        imap_host = (s.get("imap_host") or "").strip()
        smtp_host = (s.get("smtp_host") or "").strip()
        if not imap_host and not smtp_host:
            return  # nothing to migrate

        now = utcnow_naive()
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO email_accounts
                  (id, owner, name, is_default, enabled,
                   imap_host, imap_port, imap_user, imap_password, imap_starttls,
                   smtp_host, smtp_port, smtp_user, smtp_password,
                   from_address, created_at, updated_at)
                VALUES
                  (:id, :owner, :name, :is_default, :enabled,
                   :imap_host, :imap_port, :imap_user, :imap_password, :imap_starttls,
                   :smtp_host, :smtp_port, :smtp_user, :smtp_password,
                   :from_address, :created_at, :updated_at)
            """), {
                "id": _uuid.uuid4().hex,
                "owner": None,
                "name": "Default",
                "is_default": True,
                "enabled": True,
                "imap_host": imap_host,
                "imap_port": int(s.get("imap_port") or 993),
                "imap_user": s.get("imap_user") or "",
                "imap_password": s.get("imap_password") or "",
                "imap_starttls": bool(s.get("imap_starttls", True)),
                "smtp_host": smtp_host,
                "smtp_port": int(s.get("smtp_port") or 465),
                "smtp_user": s.get("smtp_user") or "",
                "smtp_password": s.get("smtp_password") or "",
                "from_address": s.get("email_from") or "",
                "created_at": now,
                "updated_at": now,
            })
            logging.getLogger(__name__).info("Seeded email_accounts 'Default' from settings.json")
    except Exception as e:
        logging.getLogger(__name__).warning(f"seed email account migration: {e}")


# 警告：外键强制已为所有 SQLite 连接全局启用。
# 任何将来临时违反外键约束的迁移或架构变更
# 都会失败。要执行此类操作，必须在迁移工作流
# 期间临时禁用 foreign_keys。
def init_db():
    """
    通过创建所有表来初始化数据库。
    应在启动应用时调用。
    """
    _migrate_model_endpoints()
    Base.metadata.create_all(bind=engine)
    _migrate_add_hidden_models_column()
    _migrate_add_cached_models_column()
    _migrate_add_pinned_models_column()
    _migrate_add_notes_sort_order()
    _migrate_add_model_type_column()
    _migrate_add_model_endpoint_refresh_columns()
    _migrate_add_model_endpoint_owner_column()
    _migrate_add_provider_auth_id_column()
    _migrate_add_supports_tools_column()
    _migrate_add_task_run_model_column()
    _migrate_add_owner_column()
    _migrate_add_document_archived_column()
    _migrate_add_last_message_at_column()
    _migrate_add_folder_column()
    _migrate_add_token_columns()
    _migrate_add_mode_column()
    _migrate_add_multiuser_owner_columns()
    _migrate_add_api_token_scopes_column()
    _migrate_backfill_document_owner_from_session()
    _migrate_assign_legacy_owner()
    _migrate_add_tidy_verdict()
    _migrate_add_doc_source_email_cols()
    _migrate_add_oauth_config()
    _migrate_add_task_automation_columns()
    _migrate_add_disabled_tools()
    _migrate_add_mcp_oauth_tokens_column()
    _migrate_add_task_v2_columns()
    _migrate_add_notifications_enabled()
    _migrate_drop_ping_notes_tasks()
    _migrate_add_crew_member_id()
    _migrate_add_assistant_columns()
    _migrate_add_email_smtp_security()
    _migrate_seed_email_account()
    _migrate_add_calendar_metadata()
    _migrate_add_calendar_is_utc()
    _migrate_add_calendar_origin()
    _migrate_add_calendar_account_id()
    _migrate_add_caldav_sync_columns()
    _migrate_chat_messages_fts()
    _migrate_encrypt_email_passwords()
    _migrate_encrypt_signatures()
    _migrate_encrypt_endpoint_keys()
    _migrate_backfill_task_folders()


def _migrate_backfill_task_folders():
    """为预先存在的任务/研究会话回填 folder='Tasks'。

    任务调度器创建的会话（LLM 任务、操作任务、研究运行）
    现在在创建时将 folder='Tasks'。此迁移标记所有
    早于此分配旧会话。幂等 — 仅处理
    folder 为 NULL 或空且标题匹配已知前缀的行。
    """
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info(sessions)"))]
            if "folder" not in cols:
                return
            res = conn.execute(text(
                "UPDATE sessions SET folder = 'Tasks' "
                "WHERE (folder IS NULL OR folder = '') "
                "AND (name LIKE '[Task] %' OR name LIKE '[Research] %')"
            ))
            conn.commit()
            if res.rowcount:
                logging.getLogger(__name__).info(
                    f"Backfilled folder='Tasks' on {res.rowcount} task/research sessions")
    except Exception as e:
        logging.getLogger(__name__).warning(f"task folder backfill: {e}")


def _migrate_chat_messages_fts():
    """创建并回填 SQLite 的会话记录全文搜索索引。"""
    if not DATABASE_URL.startswith("sqlite"):
        return

    db_path = DATABASE_URL.replace("sqlite:///", "")
    if db_path == ":memory:":
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        try:
            conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS temp._odysseus_fts5_probe USING fts5(content)")
            conn.execute("DROP TABLE IF EXISTS temp._odysseus_fts5_probe")
        except Exception as e:
            logging.getLogger(__name__).warning(f"chat_messages FTS migration skipped; FTS5 unavailable: {e}")
            return

        conn.executescript(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
                content,
                message_id UNINDEXED,
                session_id UNINDEXED,
                role UNINDEXED
            );

            CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai
            AFTER INSERT ON chat_messages BEGIN
                INSERT INTO chat_messages_fts(content, message_id, session_id, role)
                VALUES (COALESCE(new.content, ''), new.id, new.session_id, new.role);
            END;

            CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ad
            AFTER DELETE ON chat_messages BEGIN
                DELETE FROM chat_messages_fts WHERE message_id = old.id;
            END;

            CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au
            AFTER UPDATE ON chat_messages BEGIN
                DELETE FROM chat_messages_fts WHERE message_id = old.id;
                INSERT INTO chat_messages_fts(content, message_id, session_id, role)
                VALUES (COALESCE(new.content, ''), new.id, new.session_id, new.role);
            END;
            """
        )
        conn.execute(
            """
            INSERT INTO chat_messages_fts(content, message_id, session_id, role)
            SELECT COALESCE(cm.content, ''), cm.id, cm.session_id, cm.role
            FROM chat_messages cm
            WHERE NOT EXISTS (
                SELECT 1 FROM chat_messages_fts fts
                WHERE fts.message_id = cm.id
            )
            """
        )
        conn.commit()
    except Exception as e:
        logging.getLogger(__name__).warning(f"chat_messages FTS migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _migrate_add_email_smtp_security():
    """为 Proton Bridge/自定义本地 SMTP 添加显式 SMTP 安全模式。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(email_accounts)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "smtp_security" not in columns:
            conn.execute("ALTER TABLE email_accounts ADD COLUMN smtp_security TEXT DEFAULT 'ssl'")
            conn.execute(
                "UPDATE email_accounts SET smtp_security = CASE "
                "WHEN COALESCE(smtp_port, 465) = 587 THEN 'starttls' "
                "WHEN COALESCE(smtp_port, 465) = 465 THEN 'ssl' "
                "ELSE 'ssl' END "
                "WHERE smtp_security IS NULL OR smtp_security = ''"
            )
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added smtp_security column to email_accounts")
    except Exception as e:
        logging.getLogger(__name__).warning(f"smtp_security migration skipped: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _migrate_encrypt_endpoint_keys():
    """加密 model_endpoints 中任何明文存储的提供商 API 密钥。幂等；
    使用原始 SQL 以避免 EncryptedText 装饰器被重复应用。"""
    try:
        from src.secret_storage import encrypt, is_encrypted
    except Exception as e:
        logger.warning(f"secret_storage import failed; skipping endpoint-key migration: {e}")
        return
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("SELECT id, api_key FROM model_endpoints")).fetchall()
            migrated = 0
            for rid, key in rows:
                if key and not is_encrypted(key):
                    conn.execute(text("UPDATE model_endpoints SET api_key = :k WHERE id = :id"),
                                 {"k": encrypt(key), "id": rid})
                    migrated += 1
            if migrated:
                conn.commit()
                logger.info(f"Encrypted plaintext API key on {migrated} endpoint row(s)")
    except Exception as e:
        logger.warning(f"Endpoint-key encryption migration skipped: {e}")


def _migrate_encrypt_signatures():
    """加密 signatures 表中仍存在的任何明文签名图片。
    幂等 — 已带有 `enc:` 前缀的行被跳过。使用原始 SQL
    以避免 EncryptedText 类型装饰器被重复应用。"""
    try:
        from src.secret_storage import encrypt, is_encrypted
    except Exception as e:
        logger.warning(f"secret_storage import failed; skipping signature migration: {e}")
        return
    try:
        with engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT id, data_png, svg FROM signatures"
            )).fetchall()
            migrated = 0
            for rid, data_png, svg in rows:
                updates = {}
                if data_png and not is_encrypted(data_png):
                    updates["data_png"] = encrypt(data_png)
                if svg and not is_encrypted(svg):
                    updates["svg"] = encrypt(svg)
                if updates:
                    sets = ", ".join(f"{k} = :{k}" for k in updates)
                    conn.execute(text(f"UPDATE signatures SET {sets} WHERE id = :id"), {**updates, "id": rid})
                    migrated += 1
            if migrated:
                conn.commit()
                logger.info(f"Encrypted plaintext signature(s) on {migrated} row(s)")
    except Exception as e:
        logger.warning(f"Signature encryption migration skipped: {e}")


def _migrate_encrypt_email_passwords():
    """加密 email_accounts 表中仍存在的任何明文 IMAP/SMTP 密码。
    幂等 — 已带有 `enc:` 前缀的行被跳过。
    可在每次启动时安全运行。"""
    try:
        from src.secret_storage import encrypt, is_encrypted
    except Exception as e:
        logger.warning(f"secret_storage import failed; skipping password migration: {e}")
        return
    try:
        with engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT id, imap_password, smtp_password FROM email_accounts"
            )).fetchall()
            migrated = 0
            for row in rows:
                rid, imap_pw, smtp_pw = row
                updates = {}
                if imap_pw and not is_encrypted(imap_pw):
                    updates["imap_password"] = encrypt(imap_pw)
                if smtp_pw and not is_encrypted(smtp_pw):
                    updates["smtp_password"] = encrypt(smtp_pw)
                if updates:
                    sets = ", ".join(f"{k} = :{k}" for k in updates)
                    params = {**updates, "id": rid}
                    conn.execute(text(f"UPDATE email_accounts SET {sets} WHERE id = :id"), params)
                    migrated += 1
            if migrated:
                conn.commit()
                logger.info(f"Encrypted plaintext passwords on {migrated} email account row(s)")
    except Exception as e:
        logger.warning(f"Password migration failed (will retry next start): {e}")


def _migrate_add_calendar_is_utc():
    """将 is_utc 列添加到 calendar_events，使导入的事件可以保留
    其原始 UTC 时间戳（传输中的 Z 后缀），而不会影响
    旧版不带时区的本地行。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(calendar_events)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "is_utc" not in columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN is_utc BOOLEAN DEFAULT 0 NOT NULL")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'is_utc' column to calendar_events")
    except Exception as e:
        logging.getLogger(__name__).warning(f"is_utc migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _migrate_add_calendar_origin():
    """将 `origin` 添加到 calendar_events，使 CalDAV 同步能够区分离
    服务器拉取的行（在上游消失时可清除）和本地创建的行（agent /
    邮件分类 / 回写失败），后者绝不能清除。幂等。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(calendar_events)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "origin" not in columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN origin TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_calendar_events_origin ON calendar_events(origin)")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'origin' column to calendar_events")
    except Exception as e:
        logging.getLogger(__name__).warning(f"calendar_events.origin migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _migrate_add_calendar_account_id():
    """将 `account_id` 添加到 calendars，使每个 CalDAV 日历知道
    哪个凭据集（来自用户偏好中的 caldav_accounts）拥有它。幂等。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(calendars)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "account_id" not in columns:
            conn.execute("ALTER TABLE calendars ADD COLUMN account_id TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_calendars_account_id ON calendars(account_id)")
            conn.commit()
            logging.getLogger(__name__).info("Migrated: added 'account_id' column to calendars")
    except Exception as e:
        logging.getLogger(__name__).warning(f"calendars.account_id migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _migrate_add_caldav_sync_columns():
    """Add remote CalDAV metadata used for bidirectional sync."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        ev_columns = [row[1] for row in conn.execute("PRAGMA table_info(calendar_events)").fetchall()]
        if ev_columns and "remote_href" not in ev_columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN remote_href TEXT")
        if ev_columns and "remote_etag" not in ev_columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN remote_etag TEXT")
        if ev_columns and "caldav_sync_pending" not in ev_columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN caldav_sync_pending TEXT")

        cal_columns = [row[1] for row in conn.execute("PRAGMA table_info(calendars)").fetchall()]
        if cal_columns and "caldav_base_url" not in cal_columns:
            conn.execute("ALTER TABLE calendars ADD COLUMN caldav_base_url TEXT")
        conn.commit()
        conn.close()
    except Exception as e:
        logging.getLogger(__name__).warning(f"CalDAV sync metadata migration failed: {e}")


def _migrate_add_calendar_metadata():
    """将 importance/event_type/last_pinged 列添加到 calendar_events 表。"""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(calendar_events)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "importance" not in columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN importance TEXT DEFAULT 'normal'")
        if columns and "event_type" not in columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN event_type TEXT")
        if columns and "last_pinged" not in columns:
            conn.execute("ALTER TABLE calendar_events ADD COLUMN last_pinged DATETIME")
        conn.commit()
    except Exception as e:
        logging.getLogger(__name__).warning(f"calendar_events migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

def get_db():
    """
    获取数据库会话的依赖项。
    用于 FastAPI 路由中注入数据库会话。
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

from contextlib import contextmanager
from typing import Generator

@contextmanager
def get_db_session() -> Generator:
    """数据库会话的上下文管理器"""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

def bulk_insert_messages(session_id: str, messages: list):
    """高效地批量插入多条消息"""
    with get_db_session() as db:
        db.bulk_insert_mappings(
            ChatMessage,
            [
                {
                    'session_id': session_id,
                    'role': msg['role'],
                    'content': msg['content'],
                    'timestamp': utcnow_naive()
                }
                for msg in messages
            ]
        )

def cleanup_old_sessions(days: int = 30):
    """删除超过指定天数的会话"""
    from datetime import timedelta
    
    with get_db_session() as db:
        cutoff_date = utcnow_naive() - timedelta(days=days)
        
        deleted_count = db.query(Session).filter(
            Session.archived == True,
            Session.last_accessed < cutoff_date,
            Session.is_important == False
        ).delete()
        
        return deleted_count

def get_session_stats():
    """获取数据库统计信息"""
    with get_db_session() as db:
        stats = {
            'total_sessions': db.query(Session).count(),
            'active_sessions': db.query(Session).filter(Session.archived == False).count(),
            'archived_sessions': db.query(Session).filter(Session.archived == True).count(),
            'total_messages': db.query(ChatMessage).count(),
            'total_memories': db.query(Memory).count()
        }
        return stats

def get_detailed_stats():
    """获取包含文件大小的综合数据库统计信息"""
    stats = get_session_stats()  # 复用已有函数
    
    # 添加数据库文件大小
    db_size_mb = 0.0
    if "sqlite" in DATABASE_URL:
        db_path = DATABASE_URL.replace("sqlite:///", "")
        if not os.path.isabs(db_path):
            db_path = os.path.abspath(db_path)
        
        if os.path.exists(db_path):
            db_size = os.path.getsize(db_path)
            db_size_mb = round(db_size / (1024 * 1024), 2)
    
    stats['database_size_mb'] = db_size_mb
    return stats

def update_session_last_accessed(session_id: str):
    """更新会话的 last_accessed 时间戳"""
    with get_db_session() as db:
        db_session = db.query(Session).filter(Session.id == session_id).first()
        if db_session:
            db_session.last_accessed = utcnow_naive()
            db.commit()
            return True
    return False

def get_session_mode(session_id: str):
    """返回会话持久化的 `mode`，如果未设置/未知则返回 None。

    尽力而为：从不抛出异常（任何数据库错误返回 None），因此
    热请求路径上的调用方无需防护。通过 get_db_session() 路由，
    确保连接始终归还到连接池。"""
    try:
        with get_db_session() as db:
            return db.query(Session.mode).filter(Session.id == session_id).scalar()
    except Exception:
        logger.warning("Failed to read mode for session %s", session_id)
        return None

def set_session_mode(session_id: str, mode: str) -> bool:
    """持久化会话的 `mode`。尽力而为：从不抛出异常，返回成功标志。

    通过 get_db_session() 路由，因此写入中途失败（例如并发流
    下的 SQLite 'database is locked'）仍会将连接归还到连接池
    而非泄漏 — 重复泄漏会耗尽连接池。"""
    try:
        with get_db_session() as db:
            db.query(Session).filter(Session.id == session_id).update({"mode": mode})
        return True
    except Exception:
        logger.warning("Failed to persist mode %r for session %s", mode, session_id)
        return False

def get_session_by_id(session_id: str):
    """通过 ID 获取会话"""
    with get_db_session() as db:
        return db.query(Session).filter(Session.id == session_id).first()

def get_upcoming_events(owner, horizon_days: int = 60, limit: int = 40):
    """即将到来的、未取消的事件，以 {uid, title, start} 字典形式返回，按时间升序排列。

    owner=None 表示不限定所有者（单用户/旧版）。多用户调用者
    必须传入所有者的用户名 — 否则会读取所有租户的事件。
    自动化的邮件到日历流程依赖于此，以避免泄露（并操作）
    其他用户的日历。"""
    from datetime import timedelta
    now = utcnow_naive()
    with get_db_session() as db:
        q = db.query(CalendarEvent).join(CalendarCal).filter(
            CalendarEvent.dtstart >= now,
            CalendarEvent.dtstart <= now + timedelta(days=horizon_days),
            CalendarEvent.status != "cancelled",
        )
        if owner is not None:
            q = q.filter(CalendarCal.owner == owner)
        return [
            {
                "uid": e.uid,
                "title": e.summary or "",
                "start": e.dtstart.isoformat() if e.dtstart else "",
            }
            for e in q.order_by(CalendarEvent.dtstart).limit(limit).all()
        ]

def archive_session(session_id: str):
    """归档一个会话"""
    with get_db_session() as db:
        session = db.query(Session).filter(Session.id == session_id).first()
        if session:
            session.archived = True
            db.commit()
            return True
    return False

# 初始化数据库并创建所有表


init_db()
