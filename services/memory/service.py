# 服务s/memory/服务.py
"""记忆服务 — 持久化记忆存储与检索。"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
import os

from .memory import MemoryManager
from .memory_vector import MemoryVectorStore
from src.memory_provider import MemoryRecord, NativeMemoryProvider
from src.constants import DATA_DIR


@dataclass
class Memory:
    """一条已存储的记忆。"""
    id: str
    text: str
    timestamp: int
    session_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class MemorySearchResult:
    """记忆搜索结果。"""
    memories: List[Memory]
    query: str
    total: int


class MemoryService:
    """
    记忆存储与检索服务。

    用法：
        service = MemoryService()
        await service.remember("用户偏好深色模式")
        results = await service.recall("偏好设置")
    """

    def __init__(self, data_dir: str = DATA_DIR):
        self.manager = MemoryManager(data_dir)
        self.vector_store = MemoryVectorStore(data_dir) if os.path.exists(
            os.path.join(data_dir, "memory_vectors")
        ) else None
        self.provider = NativeMemoryProvider(self.manager, self.vector_store)

    def _sync_provider(self) -> None:
        self.provider.memory_vector = self.vector_store

    @staticmethod
    def _to_memory(entry: Dict[str, Any], metadata: Optional[Dict[str, Any]] = None) -> Memory:
        return Memory(
            id=entry.get("id", ""),
            text=entry.get("text", ""),
            timestamp=entry.get("timestamp", 0),
            session_id=entry.get("session_id"),
            metadata=metadata or {},
        )

    @staticmethod
    def _record_to_memory(record: MemoryRecord, metadata: Optional[Dict[str, Any]] = None) -> Memory:
        merged_metadata = dict(record.metadata)
        if metadata:
            merged_metadata.update(metadata)
        return Memory(
            id=record.id,
            text=record.text,
            timestamp=record.timestamp,
            session_id=record.session_id,
            metadata=merged_metadata,
        )

    async def remember(self, text: str, session_id: Optional[str] = None) -> Memory:
        """
        存储一条新的记忆。

        Args:
            text: 记忆内容
            session_id: 可选的会话关联

        Returns:
            已创建的 Memory 对象
        """
        self._sync_provider()
        record = await self.provider.remember(text, session_id=session_id)
        return self._record_to_memory(record)

    async def recall(self, query: str, top_k: int = 5) -> MemorySearchResult:
        """
        搜索记忆。

        Args:
            query: 搜索查询
            top_k: 最大结果数

        Returns:
            包含匹配记忆的 MemorySearchResult
        """
        self._sync_provider()
        results = await self.provider.recall(query, top_k=top_k)
        memories = [
            self._record_to_memory(hit.memory, metadata={"score": hit.score})
            if hit.score is not None
            else self._record_to_memory(hit.memory)
            for hit in results
        ]
        return MemorySearchResult(memories=memories, query=query, total=len(memories))

    def get_all(self, limit: int = 100) -> List[Memory]:
        """获取所有记忆。"""
        records = self.manager.load_all()[:limit]
        return [self._to_memory(m) for m in records]

    def delete(self, memory_id: str) -> bool:
        """按 ID 删除一条记忆。"""
        memories = self.manager.load_all()
        remaining = [m for m in memories if m.get("id") != memory_id]
        if len(remaining) == len(memories):
            return False

        self.manager.save(remaining)
        if self.vector_store and self.vector_store.healthy:
            self.vector_store.remove(memory_id)
        return True
