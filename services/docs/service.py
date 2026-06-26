# 服务s/docs/服务.py
"""文档服务 — 个人文档 RAG。"""

from dataclasses import dataclass
from typing import List, Dict, Any

from src.rag_manager import RAGManager
from src.constants import CHROMA_DIR


@dataclass
class DocChunk:
    """检索到的文档片段。"""
    text: str
    source: str
    score: float
    metadata: Dict[str, Any] = None


@dataclass
class IndexResult:
    """文档索引结果。"""
    indexed: int
    failed: int
    errors: List[str]


class DocsService:
    """
    文档 RAG 服务。

    用法：
        service = DocsService()
        await service.index("/path/to/docs")
        results = await service.query("what is async await?")
    """

    def __init__(self, persist_dir: str = CHROMA_DIR):
        self.rag = RAGManager(persist_directory=persist_dir)

    async def query(self, query: str, top_k: int = 5) -> List[DocChunk]:
        """
        查询文档索引。

        Args:
            query: 搜索查询
            top_k: 返回结果数量

        Returns:
            DocChunk 对象列表
        """
        results = self.rag.search(query, k=top_k)
        return [
            DocChunk(
                text=r.get("text", r.get("content", "")),
                source=r.get("source", r.get("metadata", {}).get("source", "unknown")),
                score=r.get("score", 0.0),
                metadata=r.get("metadata"),
            )
            for r in results
            if isinstance(r, dict)
        ]

    async def index(self, directory: str) -> IndexResult:
        """
        从目录索引文档。

        Args:
            directory: 文档路径

        Returns:
            包含统计信息的 IndexResult
        """
        result = self.rag.index_personal_documents(directory)
        return IndexResult(
            indexed=result.get("indexed", 0),
            failed=result.get("failed", 0),
            errors=result.get("errors", []),
        )

    async def add_document(self, text: str, metadata: Dict[str, Any]) -> bool:
        """向索引添加单个文档。"""
        return self.rag.add_document(text, metadata)

    def get_stats(self) -> Dict[str, Any]:
        """获取索引统计信息。"""
        return self.rag.get_stats()

    def rebuild_index(self) -> bool:
        """重建整个索引。"""
        return self.rag.rebuild_index()
