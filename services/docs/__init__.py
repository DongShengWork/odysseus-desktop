# services/docs/__init__.py
"""文档服务 — 基于 ChromaDB 的个人文档 RAG。

精简外观层：DocsService 在此定义，RAGManager/VectorRAG 从 src/ 中的规范实现重新导出。
"""

from .service import DocsService, DocChunk, IndexResult
from src.rag_manager import RAGManager
from src.rag_vector import VectorRAG

__all__ = [
    "DocsService",
    "DocChunk",
    "IndexResult",
    "RAGManager",
    "VectorRAG",
]
