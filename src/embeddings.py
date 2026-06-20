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
        # 短连接超时，使得不可用的嵌入端点（例如未在 :11434 运行的 Ollama）
        # 快速失败回退到本地 FastEmbed，而不是启动时每次探测等待约 30 秒。
        # 读取超时保持宽松，真正的端点（嵌入短字符串在 1 秒内完成）不会有影响。
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
        # 持久化缓存到 data/ 下，使模型在重启后保留，且下载位置
        # 与管理面板的 _is_downloaded() 检查保持一致（两者默认使用相同路径）。
        cache_dir = FASTEMBED_CACHE_DIR
        os.makedirs(cache_dir, exist_ok=True)
        # Windows 自愈：HuggingFace-hub 缓存将模型文件存储为符号链接
        # (snapshots/<rev>/model.onnx -> ../../blobs/<hash>)。在网络共享/UNC 数据目录下
        # Windows 无法跟随它们 ([WinError 1463] "symbolic link cannot be followed because its type is
        # disabled")，且在不同机器间复制的缓存也可能携带失效的符号链接。
        # 无论哪种情况，fastembed 尝试加载失效的符号链接并失败，*且不会重新下载*，
        # 导致语义记忆功能降级。检测缓存中失效的符号链接模型，删除受污染的 hub 目录
        # 以便 fastembed 重新获取（fastembed 会回退到其 CDN tarball，其中包含真实文件，
        # 可以正常加载）。尽力而为；仅删除经确认确实失效的链接。
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
        try:
            self._embedding = TextEmbedding(**kwargs)
        except Exception as _init_err:
            _msg = str(_init_err)
            # SSL 验证失败（企业代理/中间人证书）：如果模型已缓存到本地，
            # 回退到离线模式加载 —— huggingface_hub 即使在缓存命中时也会
            # 发起版本检查请求，在企业网络中会被自签名证书拦截。
            if "SSL" in _msg or "CERTIFICATE" in _msg or "ssl" in _msg.lower():
                logger.warning(
                    "FastEmbed SSL error (%s); retrying with HF_HUB_OFFLINE=1 "
                    "(model must be pre-cached)", _msg,
                )
                _prev = os.environ.get("HF_HUB_OFFLINE")
                os.environ["HF_HUB_OFFLINE"] = "1"
                try:
                    self._embedding = TextEmbedding(**kwargs)
                finally:
                    if _prev is None:
                        os.environ.pop("HF_HUB_OFFLINE", None)
                    else:
                        os.environ["HF_HUB_OFFLINE"] = _prev
            else:
                raise
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
    """清除"HTTP 嵌入端点已失效"锁存，使下次 get_embedding_client()
    调用重新探测。当嵌入端点设置变更时（例如用户启动 Ollama 并保存端点）
    调用此函数 — 否则启动时触发的锁存会导致即使端点恢复后，
    整个进程仍继续使用 FastEmbed。"""
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
