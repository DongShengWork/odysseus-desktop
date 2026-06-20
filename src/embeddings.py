"""
embeddings.py

RAG 和记忆向量搜索的嵌入客户端。

优先级顺序：
  1. HTTP API (Ollama / vLLM / llama.cpp) — 在 .env 中设置 EMBEDDING_URL
  2. 本地 fastembed (ONNX, ~50MB) — 零配置回退

在 .env 中设置 EMBEDDING_URL，例如：
  EMBEDDING_URL=http://localhost:11434/v1/embeddings   (ollama)
  EMBEDDING_URL=http://localhost:8000/v1/embeddings    (vllm / llama.cpp)
"""

import os

from src.constants import FASTEMBED_CACHE_DIR, EMBEDDING_ENDPOINT_FILE

# Windows: 强制 HuggingFace/fastembed 复制模型文件而非使用符号链接。
# 在网络共享/UNC 缓存目录下 Windows 无法跟随 HF 的符号链接
# ([WinError 1463] "symbolic link cannot be followed")，导致 ONNX 加载模型失败，
# 语义记忆功能失效。huggingface_hub 在导入时读取此标志，
# 因此必须在首次导入 huggingface_hub 之前设置 — 故放在模块顶层。
# (app.py 也为服务器入口设置了相同的保护。)
if os.name == "nt":
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import logging
import numpy as np
import httpx
from typing import List, Optional

logger = logging.getLogger(__name__)

_DEFAULT_MODEL = "all-minilm:l6-v2"
_DEFAULT_FASTEMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


class EmbeddingClient:
    """使用 HTTP API 替代 SentenceTransformer.encode() 的直接替换实现。"""

    def __init__(self, url: Optional[str] = None, model: Optional[str] = None, api_key: Optional[str] = None):
        self.url = url or os.getenv(
            "EMBEDDING_URL",
            f"http://{os.getenv('LLM_HOST', 'localhost')}:11434/v1/embeddings",
        )
        self.model = model or os.getenv("EMBEDDING_MODEL", _DEFAULT_MODEL)
        self.api_key = api_key or os.getenv("EMBEDDING_API_KEY")
        self._dim: Optional[int] = None
        # Short connect timeout so a DOWN embedding endpoint (e.g. Ollama not
        # running on :11434) fast-fails to the local FastEmbed fallback instead
        # of stalling startup ~30s per probe. Read stays generous for a real
        # endpoint (embedding a short string returns in well under a second).
        self._client = httpx.Client(timeout=httpx.Timeout(connect=3.0, read=10.0, write=5.0, pool=3.0))

    def get_sentence_embedding_dimension(self) -> int:
        """探测端点获取嵌入维度（如果尚未获取）。"""
        if self._dim is not None:
            return self._dim
        # 嵌入单个单词以发现维度
        vec = self.encode(["hello"])
        self._dim = vec.shape[1]
        logger.info(f"Embedding dimension: {self._dim} (model={self.model})")
        return self._dim

    def encode(
        self, texts: List[str], normalize_embeddings: bool = True
    ) -> np.ndarray:
        """通过 API 编码文本。返回 (N, dim) float32 数组。"""
        if not texts:
            return np.array([], dtype="float32")

        # 以 64 条为一批处理，避免请求过大
        all_vecs = []
        for i in range(0, len(texts), 64):
            batch = texts[i : i + 64]
            resp = self._client.post(
                self.url,
                headers={"Authorization": f"Bearer {self.api_key}"} if self.api_key else {},
                json={"input": batch, "model": self.model},
            )
            resp.raise_for_status()
            data = resp.json()

            # OpenAI 格式: {"data": [{"embedding": [...], "index": 0}, ...]}
            embeddings = data.get("data", [])
            embeddings.sort(key=lambda e: e.get("index", 0))
            for emb in embeddings:
                all_vecs.append(emb["embedding"])

        vecs = np.array(all_vecs, dtype="float32")

        if normalize_embeddings and vecs.size > 0:
            norms = np.linalg.norm(vecs, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1, norms)
            vecs = vecs / norms

        if self._dim is None and vecs.size > 0:
            self._dim = vecs.shape[1]

        return vecs


class FastEmbedClient:
    """本地嵌入客户端，使用 fastembed (ONNX)。无需外部服务。"""

    def __init__(self, model: Optional[str] = None):
        try:
            from fastembed import TextEmbedding
        except ImportError as e:
            raise RuntimeError(
                "Local fastembed is not installed. Either install it "
                "(pip install fastembed) or point the app at a remote "
                "embeddings server."
            ) from e

        self.model = model or os.getenv("FASTEMBED_MODEL", _DEFAULT_FASTEMBED_MODEL)
        # Persistent cache under data/ so the model survives reboots and so
        # the download lands exactly where the admin panel's _is_downloaded()
        # check looks (both default to this same path).
        cache_dir = FASTEMBED_CACHE_DIR
        os.makedirs(cache_dir, exist_ok=True)
        # Windows 自愈：HuggingFace-hub 缓存将模型文件存储为符号链接
        # (snapshots/<rev>/model.onnx -> ../../blobs/<hash>)。在网络共享/UNC 数据目录下
        # network-share / UNC data dir Windows refuses to follow them
        # Windows 无法跟随它们 ([WinError 1463] "symbolic link cannot be followed because its type is
        # disabled"), and a cache copied between machines can carry dead symlinks
        # too. Either way fastembed tries to load a broken symlink and fails
        # *without* re-downloading, leaving semantic memory degraded. Detect a
        # broken-symlink model in the cache and drop the contaminated hub dir so
        # fastembed re-fetches (it falls back to its CDN tarball of real files,
        # which load fine). Best-effort; only ever removes a verifiably dead link.
        if os.name == "nt":
            try:
                import glob, shutil
                for _onnx in glob.glob(os.path.join(cache_dir, "**", "*.onnx"), recursive=True):
                    if os.path.islink(_onnx) and not os.path.exists(_onnx):
                        _root = _onnx
                        while os.path.basename(_root) and not os.path.basename(_root).startswith("models--"):
                            _parent = os.path.dirname(_root)
                            if _parent == _root:
                                break
                            _root = _parent
                        if os.path.basename(_root).startswith("models--"):
                            logger.warning(
                                "Embedding cache has a broken symlink (%s); clearing %s "
                                "so fastembed re-downloads real files", _onnx, _root,
                            )
                            shutil.rmtree(_root, ignore_errors=True)
            except Exception as _e:
                logger.debug("embedding cache symlink-heal skipped: %s", _e)
        kwargs = {"model_name": self.model, "cache_dir": cache_dir}
        self._embedding = TextEmbedding(**kwargs)
        self._dim: Optional[int] = None
        self.url = "local://fastembed"
        logger.info(f"FastEmbed loaded model={self.model}")

    def get_sentence_embedding_dimension(self) -> int:
        if self._dim is not None:
            return self._dim
        vec = self.encode(["hello"])
        self._dim = vec.shape[1]
        logger.info(f"Embedding dimension: {self._dim} (model={self.model})")
        return self._dim

    def encode(
        self, texts: List[str], normalize_embeddings: bool = True
    ) -> np.ndarray:
        """本地编码文本。返回 (N, dim) float32 数组。"""
        if not texts:
            return np.array([], dtype="float32")

        vecs = np.array(list(self._embedding.embed(texts)), dtype="float32")

        if normalize_embeddings and vecs.size > 0:
            norms = np.linalg.norm(vecs, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1, norms)
            vecs = vecs / norms

        if self._dim is None and vecs.size > 0:
            self._dim = vecs.shape[1]

        return vecs


def _load_persisted_endpoint() -> dict:
    """加载通过管理面板保存的自定义嵌入端点。"""
    try:
        endpoint_file = EMBEDDING_ENDPOINT_FILE
        if os.path.exists(endpoint_file):
            import json
            data = json.loads(open(endpoint_file, encoding="utf-8").read())
            if data.get("url"):
                return data
    except Exception:
        pass
    return {}


_http_embed_down = False  # 进程级锁存：跳过对已失效端点的重复探测


def reset_http_embed_state():
    """Clear the 'HTTP embedding endpoint is down' latch so the next
    get_embedding_client() re-probes. Call this when the embedding endpoint
    setting changes (e.g. the user starts Ollama and saves the endpoint) —
    otherwise a latch tripped at startup would keep us on FastEmbed for the
    whole process even after the endpoint comes back."""
    global _http_embed_down
    _http_embed_down = False


def get_embedding_client():
    """工厂函数：先尝试 HTTP API，回退到本地 fastembed。"""
    global _http_embed_down

    # 检查持久化的自定义端点（从管理面板保存的）
    persisted = _load_persisted_endpoint()
    if persisted.get("url"):
        url = persisted["url"]
        model = persisted.get("model", "")
        api_key = persisted.get("api_key", "")
        # 同时设置环境变量以便其他代码可见
        os.environ["EMBEDDING_URL"] = url
        if model:
            os.environ["EMBEDDING_MODEL"] = model
        if api_key:
            from src.secret_storage import decrypt
            os.environ["EMBEDDING_API_KEY"] = decrypt(api_key)
    # 尝试 HTTP 嵌入 API — 除非本进程中已确定其不可用
    # （避免每次 RAG/记忆/工具探测都再次付出连接超时的代价）。
    if not _http_embed_down:
        try:
            client = EmbeddingClient()
            client.get_sentence_embedding_dimension()  # 健康检查
            logger.info(f"Using HTTP embedding API: {client.url} model={client.model}")
            return client
        except Exception as e:
            _http_embed_down = True
            logger.warning(f"HTTP embedding API unavailable ({e}); using local FastEmbed for the rest of this process")

    # 回退到本地 fastembed
    try:
        client = FastEmbedClient()
        client.get_sentence_embedding_dimension()
        logger.info(f"Using local FastEmbed: model={client.model}")
        return client
    except ImportError:
        logger.error("fastembed not installed — run: pip install fastembed")
    except Exception as e:
        logger.error(f"FastEmbed init failed: {e}")

    return None
