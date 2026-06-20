# core/models.py
"""
纯数据模型 — 无数据库逻辑，无副作用。

这些是简单的数据容器。所有持久化由 SessionManager 处理。
"""

from dataclasses import dataclass
from typing import Dict, List, Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .session_manager import SessionManager

# Module-level session manager singleton (single source of truth)
_SESSION_MANAGER_INSTANCE: Optional["SessionManager"] = None


def set_session_manager_instance(manager: "SessionManager"):
    """Set the global SessionManager singleton."""
    global _SESSION_MANAGER_INSTANCE
    _SESSION_MANAGER_INSTANCE = manager


def get_session_manager_instance() -> Optional["SessionManager"]:
    """Get the global SessionManager singleton."""
    return _SESSION_MANAGER_INSTANCE


# Keep legacy name for backward compatibility
set_session_manager = set_session_manager_instance
get_session_manager = get_session_manager_instance


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
    """A chat session — pure data container.

    ``.history`` is the authoritative mutable message list. Callers may
    read, append, pop, or reassign it directly — these changes take
    effect immediately. ``_history`` remains a compatibility alias that
    always resolves to the authoritative ``history`` list.

    Each session gets its own unique history list at construction time
    (the dataclass default is never shared between instances).
    """

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
        if self.headers is None:
            self.headers = {}
        # Ensure each session gets its OWN list (not the shared dataclass default)
        if self.history is None:
            self.history = []

    @property
    def _history(self) -> List[ChatMessage]:
        """Compatibility alias for callers that still reference ``_history``."""
        return self.history

    @_history.setter
    def _history(self, messages: List[ChatMessage]):
        self.history = messages

    def add_message(self, message: ChatMessage):
        """
        向此会话中添加一条消息。

        Appends to the authoritative history list and increments
        message_count. Delegates to SessionManager for persistence
        if available.
        """
        self.history.append(message)
        self.message_count = len(self.history)

        # 委托给会话管理器进行持久化
        if _SESSION_MANAGER_INSTANCE:
            _SESSION_MANAGER_INSTANCE._persist_message(self.id, message)

    def get_context_messages(self) -> List[Dict[str, Any]]:
        """获取用于发送给 LLM API 的消息格式。

        Slash-command / setup replies are persisted to history so they render
        in the transcript, but they are UI chatter (e.g. ``/setup ...`` and its
        status lines) the user never meant as conversation. They carry
        ``metadata.source == "slash"`` 标记；在此排除它们，使其
        the model. Display/history-load paths use the raw ``history`` and are
        unaffected.
        """
        return [
            msg.to_dict()
            for msg in self.history
            if (msg.metadata or {}).get("source") != "slash"
        ]

    def get(self, key: str, default=None):
        """类字典访问以保持兼容性。"""
        return getattr(self, key, default)

    def __getitem__(self, key: str):
        """Allow session['field'] syntax."""
        return getattr(self, key)
