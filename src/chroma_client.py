"""
chroma_client.py

单例 ChromaDB HTTP 客户端。
连接到作为独立服务运行的 ChromaDB 实例。
"""

import os
import socket
import logging

logger = logging.getLogger(__name__)

_client = None

# 短连接探针，使无法访问的 ChromaDB 快速失败，而不是
# 阻塞在操作系统连接超时上（~30-60s，Windows 上为 WinError 10060），
# 否则会延迟应用启动。可通过 CHROMADB_CONNECT_TIMEOUT 配置。
_CONNECT_TIMEOUT = float(os.getenv("CHROMADB_CONNECT_TIMEOUT", "2.0"))


def _port_open(host: str, port: int, timeout: float = None) -> bool:
    """如果在超时内成功建立到 host:port 的 TCP 连接，则返回 True。"""
    try:
        with socket.create_connection((host, port), timeout=timeout or _CONNECT_TIMEOUT):
            return True
    except OSError:
        return False


def get_chroma_client():
    """获取或创建单例 ChromaDB HTTP 客户端。

    如果 `chromadb` 包未安装则抛出 RuntimeError 并附带清晰的安装提示 —
    它是可选依赖（RAG + memory vectors）。
    """
    global _client
    if _client is not None:
        return _client

    try:
        import chromadb
    except ImportError as e:
        raise RuntimeError(
            "ChromaDB integration is not installed. Install the optional "
            "dependency with: pip install chromadb-client"
        ) from e

    host = os.getenv("CHROMADB_HOST", "localhost")
    port = int(os.getenv("CHROMADB_PORT", "8100"))

    if not _port_open(host, port):
        raise RuntimeError(
            f"ChromaDB is not reachable at {host}:{port}. Start the ChromaDB "
            f"service (e.g. `docker compose up chromadb`) or set CHROMADB_HOST / "
            f"CHROMADB_PORT to point at a running instance."
        )

    client = chromadb.HttpClient(host=host, port=port)

    # 缓存前先做健康检查 — 如果端口开放但服务尚未就绪
    # （例如仍在启动中），不要用无效的客户端污染单例；
    # 保持 _client 未设置，让下次调用重试。
    client.heartbeat()
    _client = client
    logger.info(f"ChromaDB connected: {host}:{port}")
    return _client


def reset_client():
    """重置单例（例如配置更改后）。"""
    global _client
    _client = None
