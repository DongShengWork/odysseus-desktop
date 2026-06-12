# core/models.py
"""
纯数据模型 — 无数据库逻辑，无副作用。

这些是简单的数据容器。所有持久化由 SessionManager 处理。
"""

from dataclasses import dataclass
from typing import Dict, List, Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .session_manager import SessionManager

# 模块级别的会话管理器引用（在应用启动时设置）
_session_manager: Optional["SessionManager"] = None


def set_session_manager(manager: "SessionManager"):
    """设置全局会话管理器引用。"""
    global _session_manager
    _session_manager = manager


@dataclass
class ChatMessage:
    """单条聊天消息。"""
    role: str
    content: str
    metadata: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典以用于 API 响应。"""
        result = {"role": self.role, "content": self.content}
        if self.metadata:
            result["metadata"] = self.metadata
        return result

    def get(self, key: str, default=None):
        """类字典访问以保持兼容性。"""
        return getattr(self, key, default)


@dataclass
class Session:
    """聊天会话 — 纯数据容器。"""
    id: str
    name: str
    endpoint_url: str
    model: str
    rag: bool = False
    archived: bool = False
    headers: Optional[Dict[str, str]] = None
    history: List[ChatMessage] = None
    owner: Optional[str] = None
    is_important: bool = False
    message_count: int = 0

    def __post_init__(self):
        if self.history is None:
            self.history = []
        if self.headers is None:
            self.headers = {}

    def add_message(self, message: ChatMessage):
        """
        向此会话中添加一条消息。

        如果可用，委托给 SessionManager 进行持久化，
        否则仅追加到历史记录中。
        """
        self.history.append(message)
        self.message_count = len(self.history)

        # 委托给会话管理器进行持久化
        if _session_manager:
            _session_manager._persist_message(self.id, message)

    def get_context_messages(self) -> List[Dict[str, Any]]:
        """获取用于发送给 LLM API 的消息格式。

        斜杠命令 / setup 回复会被持久化到历史记录中以便在
        对话记录中展示，但它们属于 UI 对话内容（例如 ``/setup ...``
        及其状态行），用户从未将其视为对话的一部分。这些消息带有
        ``metadata.source == "slash"`` 标记；在此排除它们，使其
        永远不会送达模型。显示/历史加载路径使用原始的 ``history``，不受影响。
        """
        return [
            msg.to_dict()
            for msg in self.history
            if (msg.metadata or {}).get("source") != "slash"
        ]

    def get(self, key: str, default=None):
        """类字典访问以保持兼容性。"""
        return getattr(self, key, default)
