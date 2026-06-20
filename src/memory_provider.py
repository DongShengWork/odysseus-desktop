"""原生和外部记忆系统的记忆提供者接口。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional


@dataclass
class MemoryRecord:
    """与提供者无关的记忆条目。"""

    id: str
    text: str
    timestamp: int = 0
    category: str = "fact"
    source: str = "unknown"
    owner: Optional[str] = None
    session_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class MemorySearchHit:
    """提供者召回返回的记忆结果。"""

    memory: MemoryRecord
    provider_id: str
    score: Optional[float] = None


class MemoryProvider(ABC):
    """Odysseus 记忆提供者的基础契约。

    原生记忆提供者应始终可用。外部提供者可以添加
    召回/写入行为和自己的工具，而无需替换
    内置的本地记忆基线。
    """

    provider_id = "unknown"
    display_name = "Unknown"
    enabled = True

    async def initialize(self) -> None:
        """使用前准备提供者资源。"""

    async def shutdown(self) -> None:
        """释放提供者资源。"""

    @abstractmethod
    async def remember(
        self,
        text: str,
        *,
        owner: Optional[str] = None,
        session_id: Optional[str] = None,
        category: str = "fact",
        source: str = "user",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> MemoryRecord:
        """存储一条记忆并返回存储的记录。"""

    @abstractmethod
    async def recall(
        self,
        query: str,
        *,
        owner: Optional[str] = None,
        top_k: int = 5,
    ) -> List[MemorySearchHit]:
        """返回与查询相关的提供者记忆。"""

    @abstractmethod
    async def list_memories(
        self,
        *,
        owner: Optional[str] = None,
        limit: int = 100,
    ) -> List[MemoryRecord]:
        """列出所有者可见的记忆。"""

    @abstractmethod
    async def delete(self, memory_id: str, *, owner: Optional[str] = None) -> bool:
        """在提供者允许的情况下按 ID 删除记忆。"""

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """当此提供者启用时，返回提供者定义的工具 schema。"""
        return []

    async def handle_tool_call(self, name: str, arguments: Dict[str, Any]) -> Any:
        """处理提供者定义的工具调用。"""
        raise KeyError(f"Provider {self.provider_id} does not expose tool {name}")


class NativeMemoryProvider(MemoryProvider):
    """Odysseus 内置记忆管理器和向量存储的提供者适配器。"""

    provider_id = "native"
    display_name = "Odysseus native memory"

    _CORE_FIELDS = {
        "id",
        "text",
        "timestamp",
        "source",
        "category",
        "uses",
        "owner",
        "session_id",
        "metadata",
    }

    def __init__(self, memory_manager, memory_vector=None):
        self.memory_manager = memory_manager
        self.memory_vector = memory_vector

    def _to_record(self, entry: Dict[str, Any]) -> MemoryRecord:
        metadata = {
            key: value
            for key, value in entry.items()
            if key not in self._CORE_FIELDS
        }
        stored_metadata = entry.get("metadata")
        if isinstance(stored_metadata, dict):
            metadata.update(stored_metadata)

        return MemoryRecord(
            id=entry.get("id", ""),
            text=entry.get("text", ""),
            timestamp=entry.get("timestamp", 0),
            category=entry.get("category", "fact"),
            source=entry.get("source", "unknown"),
            owner=entry.get("owner"),
            session_id=entry.get("session_id"),
            metadata=metadata,
        )

    async def remember(
        self,
        text: str,
        *,
        owner: Optional[str] = None,
        session_id: Optional[str] = None,
        category: str = "fact",
        source: str = "user",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> MemoryRecord:
        entry = self.memory_manager.add_entry(
            text,
            source=source,
            category=category,
            owner=owner,
        )
        if session_id:
            entry["session_id"] = session_id
        if metadata:
            entry["metadata"] = dict(metadata)

        memories = self.memory_manager.load_all()
        memories.append(entry)
        self.memory_manager.save(memories)

        if self._vector_available():
            self.memory_vector.add(entry["id"], entry["text"])

        return self._to_record(entry)

    async def recall(
        self,
        query: str,
        *,
        owner: Optional[str] = None,
        top_k: int = 5,
    ) -> List[MemorySearchHit]:
        memories = self.memory_manager.load(owner=owner)
        by_id = {m.get("id"): m for m in memories}

        if self._vector_available():
            hits: List[MemorySearchHit] = []
            for result in self.memory_vector.search(query, k=top_k):
                if not isinstance(result, dict):
                    continue
                memory_id = result.get("memory_id")
                entry = by_id.get(memory_id) if memory_id else result
                if not entry:
                    continue
                if owner is not None and entry.get("owner") != owner:
                    continue
                hits.append(
                    MemorySearchHit(
                        memory=self._to_record(entry),
                        provider_id=self.provider_id,
                        score=result.get("score"),
                    )
                )
            if hits:
                return hits

        fallback = self.memory_manager.get_relevant_memories(
            query,
            memories,
            max_items=top_k,
        )
        return [
            MemorySearchHit(
                memory=self._to_record(entry),
                provider_id=self.provider_id,
                score=None,
            )
            for entry in fallback
        ]

    async def list_memories(
        self,
        *,
        owner: Optional[str] = None,
        limit: int = 100,
    ) -> List[MemoryRecord]:
        return [
            self._to_record(entry)
            for entry in self.memory_manager.load(owner=owner)[:limit]
        ]

    async def delete(self, memory_id: str, *, owner: Optional[str] = None) -> bool:
        memories = self.memory_manager.load_all()
        remaining = []
        deleted_id = None

        for entry in memories:
            if entry.get("id") != memory_id:
                remaining.append(entry)
                continue
            if owner is not None and entry.get("owner") != owner:
                remaining.append(entry)
                continue
            deleted_id = entry.get("id")

        if deleted_id is None:
            return False

        self.memory_manager.save(remaining)
        if self._vector_available():
            self.memory_vector.remove(deleted_id)
        return True

    def _vector_available(self) -> bool:
        return bool(self.memory_vector and getattr(self.memory_vector, "healthy", True))


class MemoryProviderRegistry:
    """原生和可选外部记忆提供者的容器。"""

    def __init__(self, providers: Optional[Iterable[MemoryProvider]] = None):
        self._providers: Dict[str, MemoryProvider] = {}
        for provider in providers or []:
            self.register(provider)

    def register(self, provider: MemoryProvider) -> None:
        if provider.provider_id in self._providers:
            raise ValueError(f"Memory provider already registered: {provider.provider_id}")
        self._providers[provider.provider_id] = provider

    def get(self, provider_id: str) -> MemoryProvider:
        return self._providers[provider_id]

    def all(self) -> List[MemoryProvider]:
        return list(self._providers.values())

    def active(self) -> List[MemoryProvider]:
        return [provider for provider in self._providers.values() if provider.enabled]

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        schemas: List[Dict[str, Any]] = []
        seen: Dict[str, str] = {}

        for provider in self.active():
            for schema in provider.get_tool_schemas():
                name = self._tool_name(schema)
                if name in seen:
                    raise ValueError(
                        f"Memory tool name conflict: {name} from "
                        f"{provider.provider_id} already exposed by {seen[name]}"
                    )
                seen[name] = provider.provider_id
                schemas.append(schema)

        return schemas

    async def handle_tool_call(self, name: str, arguments: Dict[str, Any]) -> Any:
        provider_by_tool: Dict[str, MemoryProvider] = {}
        for provider in self.active():
            for schema in provider.get_tool_schemas():
                tool_name = self._tool_name(schema)
                if tool_name in provider_by_tool:
                    raise ValueError(
                        f"Memory tool name conflict: {tool_name} from "
                        f"{provider.provider_id} already exposed by "
                        f"{provider_by_tool[tool_name].provider_id}"
                    )
                provider_by_tool[tool_name] = provider

        provider = provider_by_tool.get(name)
        if provider:
            return await provider.handle_tool_call(name, arguments)
        raise KeyError(f"No active memory provider exposes tool {name}")

    @staticmethod
    def _tool_name(schema: Dict[str, Any]) -> str:
        if not isinstance(schema, dict):
            raise ValueError("Memory provider tool schema must be a dict")
        name = schema.get("name")
        if isinstance(name, str) and name:
            return name
        function = schema.get("function")
        if isinstance(function, dict):
            function_name = function.get("name")
            if isinstance(function_name, str) and function_name:
                return function_name
        raise ValueError("Memory provider tool schema is missing a tool name")
