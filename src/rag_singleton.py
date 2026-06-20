"""
应用的 RAG 单例实例。
"""
import os
import logging
import time
from pathlib import Path

from src.constants import RAG_DIR

logger = logging.getLogger(__name__)

rag_instance = None
_last_attempt = 0.0
_RETRY_INTERVAL = 30  # 重新初始化尝试之间的秒数


def get_rag_manager():
    """懒加载的 ChromaDB 支持的 VectorRAG 初始化器。

    首次成功初始化时返回 VectorRAG 实例，如果 ChromaDB
    不可达/不可用则返回 None。失败的初始化尝试每
    _RETRY_INTERVAL 秒限制一次，因此缺失的 ChromaDB 不会
    在每个请求上忙重试 — 调用方（个人文档路由等）收到 None
    并改为向用户返回干净的 503。

    历史说明：这里曾经硬编码为 ``return None``，
    并附带 chromadb 1.4.1 / pydantic 2.12 互不兼容的注释。
    该兼容性问题已在当前固定版本中解决
    （chromadb 1.5.x + pydantic 2.13.x），因此真实的初始化器重新启用。
    """
    global rag_instance, _last_attempt

    if rag_instance is not None:
        return rag_instance

    now = time.monotonic()
    if now - _last_attempt < _RETRY_INTERVAL:
        return None  # 重试太早 — 上次尝试失败

    _last_attempt = now

    try:
        from src.rag_vector import VectorRAG

        persist_dir = RAG_DIR

        rag_instance = VectorRAG(persist_directory=persist_dir)
        if not rag_instance.healthy:
            logger.warning("VectorRAG created but not healthy, will retry later")
            rag_instance = None
        else:
            logger.info("Initialized VectorRAG with ChromaDB")

    except ImportError as e:
        logger.warning(f"VectorRAG not available: {e}")
        rag_instance = None
    except Exception as e:
        logger.error(f"Failed to initialize RAG: {e}")
        rag_instance = None

    return rag_instance
