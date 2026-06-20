"""
rag_manager.py

一个围绕 VectorRAG 的薄包装器，用于向后兼容和附加功能。
"""

import logging
from typing import List, Dict, Any, Optional

from src.constants import CHROMA_DIR

# 尝试从不同的可能位置导入
try:
    from rag_vector import VectorRAG
except ImportError:
    try:
        from .rag_vector import VectorRAG
    except ImportError:
        from src.rag_vector import VectorRAG

logger = logging.getLogger(__name__)

class RAGManager:
    """
    包装 VectorRAG 以提供向后兼容的管理器类。
    大多数方法直接委托给 VectorRAG。
    """
    
    def __init__(self, persist_directory: str = CHROMA_DIR):
        """使用 VectorRAG 初始化 RAGManager。"""
        self.vector_rag = VectorRAG(persist_directory=persist_directory)
        logger.info("RAGManager initialized as wrapper for VectorRAG")
    
    # 将所有方法委托给 VectorRAG
    def search(self, query: str, k: int = 5) -> List[Dict[str, Any]]:
        """搜索文档 — 委托给 VectorRAG。"""
        return self.vector_rag.search(query, k)
    
    def index_personal_documents(
        self,
        directory: str,
        file_extensions: Optional[set] = None,
        owner: Optional[str] = None,
    ) -> Dict[str, Any]:
        """索引文档 — 委托给 VectorRAG。"""
        return self.vector_rag.index_personal_documents(
            directory,
            file_extensions=file_extensions,
            owner=owner,
        )
    
    def retrieve(self, query: str, k: int = 5) -> List[str]:
        """检索相关块 — 委托给 VectorRAG。"""
        return self.vector_rag.retrieve(query, k)
    
    def rebuild_index(self) -> bool:
        """重建索引 — 委托给 VectorRAG。"""
        return self.vector_rag.rebuild_index()
    
    def get_stats(self) -> Dict[str, Any]:
        """获取统计信息 — 委托给 VectorRAG。"""
        return self.vector_rag.get_stats()
    
    def add_document(self, text: str, metadata: Dict[str, Any]) -> bool:
        """添加单个文档 — 委托给 VectorRAG。"""
        return self.vector_rag.add_document(text, metadata)
    
    def add_documents_batch(self, docs: List[tuple]) -> Dict[str, Any]:
        """批量添加文档 — 委托给 VectorRAG。"""
        return self.vector_rag.add_documents_batch(docs)
