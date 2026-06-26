"""
rag_vector.py

使用 ChromaDB 存储和基于 API 的嵌入的向量 RAG 系统。
特性：持久化存储、混合搜索（向量 + 关键词）、句子感知分块、
可通过 EMBEDDING_URL 环境变量配置的嵌入端点。
"""

import os
import hashlib
import re
import logging
import numpy as np
from typing import List, Dict, Any, Optional, Set

from src.constants import CHROMA_DIR
from pathlib import Path

from src.embedding_lanes import (
    LANE_CUSTOM,
    LANE_FASTEMBED,
    build_embedding_lanes,
    collection_name,
    dedupe_results,
    lane_count,
    migrate_legacy_collection,
    query_lanes,
)

logger = logging.getLogger(__name__)

DEFAULT_FILE_EXTENSIONS: Set[str] = {
    '.txt', '.md', '.py', '.json', '.yaml', '.yml',
    '.csv', '.html', '.css', '.js', '.pdf'
}

VECTOR_WEIGHT = 0.7
KEYWORD_WEIGHT = 0.3

COLLECTION_NAME = "odysseus_rag"


def _generate_doc_id(text: str, owner: str = "") -> str:
    # 以 owner 为作用域的 ID，这样两个所有者可以索引完全相同的块，
    # 而第二个的添加不会因为第一个的 ID 已存在而提前返回，
    # 在其 owner 过滤的搜索结果中被静默丢弃。
    # 空的 owner 还原到旧版仅文本 ID，因此无所有者/基础索引保持其现有 ID，
    # 而不会被重新搅动。
    key = f"{owner}\x00{text}" if owner else text
    return f"doc_{hashlib.sha256(key.encode('utf-8')).hexdigest()[:16]}"


def _rewrite_owner_path(value: str, path_map: Dict[str, str], path_prefixes: List[tuple]) -> str:
    if not isinstance(value, str) or not value:
        return value
    abs_value = os.path.abspath(value)
    mapped = path_map.get(abs_value)
    if mapped:
        return mapped
    for old_prefix, new_prefix in path_prefixes:
        old_abs = os.path.abspath(old_prefix)
        new_abs = os.path.abspath(new_prefix)
        if abs_value == old_abs:
            return new_abs
        if abs_value.startswith(old_abs + os.sep):
            return new_abs + abs_value[len(old_abs):]
    return value


class VectorRAG:
    """使用 ChromaDB 向量存储的 RAG 系统，支持混合搜索。"""

    def __init__(self, persist_directory: str = CHROMA_DIR):
        self.persist_directory = persist_directory
        self._collection = None
        self._model = None
        self._lanes = []
        self._healthy = False

        Path(self.persist_directory).mkdir(parents=True, exist_ok=True)
        self._initialize_system()

    # ------------------------------------------------------------------
    # 初始化
    # ------------------------------------------------------------------

    def _initialize_system(self) -> bool:
        try:
            self._lanes = build_embedding_lanes(COLLECTION_NAME)
            if not self._lanes:
                raise RuntimeError("No embedding lanes available")
            self._collection = next(
                (lane.collection for lane in self._lanes if lane.name == LANE_FASTEMBED),
                self._lanes[0].collection,
            )
            self._model = self._lanes[0].client
            migrate_legacy_collection(COLLECTION_NAME, self._lanes)
            logger.info(
                "VectorRAG ready (lanes=%s docs=%s)",
                [lane.name for lane in self._lanes],
                lane_count(self._lanes),
            )
            self._healthy = True
            return True

        except Exception as e:
            logger.error(f"VectorRAG init failed: {e}")
            self._healthy = False
            return False

    def _embed(self, texts: List[str]) -> List[List[float]]:
        if not self._lanes:
            return []
        return np.array(self._lanes[0].encode(texts), dtype=np.float32).tolist()

    # ------------------------------------------------------------------
    # 属性
    # ------------------------------------------------------------------

    @property
    def healthy(self) -> bool:
        if getattr(self, "_lanes", None):
            return self._healthy and bool(self._lanes)
        return self._healthy and getattr(self, "_collection", None) is not None

    @property
    def collection(self):
        """暴露 ChromaDB 集合供 personal_routes 等直接访问。"""
        return self._collection

    def _active_collections(self):
        lanes = getattr(self, "_lanes", None)
        if lanes:
            return [(lane.name, lane.collection) for lane in lanes]
        collection = getattr(self, "_collection", None)
        return [("legacy", collection)] if collection is not None else []

    def _collections_for_delete(self):
        collections = []
        seen = set()

        def add(lane_name: str, collection) -> None:
            if collection is None:
                return
            key = getattr(collection, "name", None) or id(collection)
            if key in seen:
                return
            seen.add(key)
            collections.append((lane_name, collection))

        for lane_name, collection in self._active_collections():
            add(lane_name, collection)

        if getattr(self, "_lanes", None):
            try:
                from src.chroma_client import get_chroma_client

                client = get_chroma_client()
                try:
                    add("legacy", client.get_collection(COLLECTION_NAME))
                except Exception:
                    pass
                for lane_name in (LANE_CUSTOM, LANE_FASTEMBED):
                    try:
                        add(lane_name, client.get_collection(collection_name(COLLECTION_NAME, lane_name)))
                    except Exception:
                        pass
            except Exception:
                pass

        return collections

    # ------------------------------------------------------------------
    # 文档操作
    # ------------------------------------------------------------------

    def add_document(self, text: str, metadata: Dict[str, Any]) -> bool:
        if not self.healthy:
            logger.error("Collection not initialized")
            return False
        if not text or not isinstance(text, str):
            return False
        if not metadata or not isinstance(metadata, dict):
            return False

        doc_id = _generate_doc_id(text, metadata.get("owner") or "")
        wrote = False
        for lane in self._lanes:
            try:
                existing = lane.collection.get(ids=[doc_id])
                if existing["ids"]:
                    wrote = True
                    continue
                lane.collection.add(
                    ids=[doc_id],
                    embeddings=lane.encode([text]),
                    documents=[text],
                    metadatas=[metadata],
                )
                wrote = True
            except Exception as e:
                logger.warning("add_document failed in %s lane: %s", lane.name, e)
        return wrote

    def add_documents_batch(self, docs: List[tuple]) -> Dict[str, Any]:
        if not self.healthy:
            return {"success": False, "message": "Collection not initialized"}
        if not docs:
            return {"success": False, "message": "Empty document list"}

        valid = [
            (t, m) for t, m in docs
            if t and isinstance(t, str) and m and isinstance(m, dict)
        ]
        if not valid:
            return {"success": False, "message": "No valid documents"}

        added_ids = set()
        attempted_new = False
        write_failed = False
        for lane in self._lanes:
            all_ids = [_generate_doc_id(t, m.get("owner") or "") for t, m in valid]
            try:
                existing = lane.collection.get(ids=all_ids)
                existing_ids = set(existing.get("ids") or [])
            except Exception:
                existing_ids = set()

            new_texts = []
            new_metas = []
            new_ids = []
            for (text, meta), doc_id in zip(valid, all_ids):
                if doc_id not in existing_ids:
                    new_texts.append(text)
                    new_metas.append(meta)
                    new_ids.append(doc_id)

            if new_texts:
                attempted_new = True
                lane_failed = False
                for i in range(0, len(new_texts), 100):
                    batch_texts = new_texts[i:i + 100]
                    batch_ids = new_ids[i:i + 100]
                    batch_metas = new_metas[i:i + 100]
                    try:
                        lane.collection.add(
                            ids=batch_ids,
                            embeddings=lane.encode(batch_texts),
                            documents=batch_texts,
                            metadatas=batch_metas,
                        )
                    except Exception as e:
                        lane_failed = True
                        write_failed = True
                        logger.warning("add_documents_batch failed in %s lane: %s", lane.name, e)
                        break
                if not lane_failed:
                    added_ids.update(new_ids)

        if attempted_new and write_failed and not added_ids:
            return {"success": False, "message": "No embedding lane accepted the batch"}

        return {
            "success": True,
            "added_count": len(added_ids),
            "total_count": len(docs),
            "failed_count": len(docs) - len(valid),
        }

    def rename_owner(
        self,
        old_owner: str,
        new_owner: str,
        *,
        path_map: Optional[Dict[str, str]] = None,
        path_prefixes: Optional[List[tuple]] = None,
    ) -> Dict[str, Any]:
        """Rewrite existing RAG metadata after an auth username rename."""
        if not self.healthy:
            return {"success": False, "updated_count": 0, "message": "Collection not initialized"}

        old_owner = (old_owner or "").strip().lower()
        new_owner = (new_owner or "").strip().lower()
        if not old_owner or not new_owner or old_owner == new_owner:
            return {"success": True, "updated_count": 0, "message": "No owner rename needed"}

        path_map = {os.path.abspath(k): os.path.abspath(v) for k, v in (path_map or {}).items()}
        path_prefixes = path_prefixes or []
        updated_ids = set()
        failed_count = 0

        for lane_name, collection in self._collections_for_delete():
            try:
                results = collection.get(
                    where={"owner": old_owner},
                    include=["metadatas"],
                )
            except Exception as e:
                logger.warning("rename_owner metadata scan failed in %s lane: %s", lane_name, e)
                failed_count += 1
                continue

            ids = results.get("ids") or []
            metadatas = results.get("metadatas") or []
            if not ids:
                continue

            new_metas = []
            selected_ids = []
            for doc_id, meta in zip(ids, metadatas):
                if not isinstance(meta, dict):
                    continue
                next_meta = dict(meta)
                if str(next_meta.get("owner", "")).strip().lower() == old_owner:
                    next_meta["owner"] = new_owner
                for key in ("source", "directory"):
                    next_meta[key] = _rewrite_owner_path(next_meta.get(key), path_map, path_prefixes)
                selected_ids.append(doc_id)
                new_metas.append(next_meta)

            if not selected_ids:
                continue

            try:
                collection.update(ids=selected_ids, metadatas=new_metas)
                updated_ids.update(selected_ids)
            except Exception as e:
                logger.warning("rename_owner metadata update failed in %s lane: %s", lane_name, e)
                failed_count += len(selected_ids)

        success = failed_count == 0
        return {
            "success": success,
            "updated_count": len(updated_ids),
            "failed_count": failed_count,
            "message": f"Updated {len(updated_ids)} RAG chunk(s)",
        }

    # ------------------------------------------------------------------
    # 搜索 — 混合：向量相似度 + 关键词重叠
    # ------------------------------------------------------------------

    def search(self, query: str, k: int = 5, owner: Optional[str] = None) -> List[Dict[str, Any]]:
        if not self.healthy:
            return []
        if not query or not isinstance(query, str):
            return []
        if lane_count(self._lanes) == 0:
            return []

        try:
            where_filter = {"owner": owner} if owner else None
            query_words = set(query.lower().split())
            candidates = []

            for lane, results in query_lanes(
                self._lanes,
                query,
                n_results=lambda lane: min(
                    (k * 6 if owner else k * 3),
                    max(k, 20),
                    lane.count(),
                ),
                where=where_filter,
                include=["documents", "metadatas", "distances"],
                raise_if_all_failed=True,
            ):
                for idx in range(len(results["ids"][0])):
                    doc_id = results["ids"][0][idx]
                    distance = results["distances"][0][idx]
                    doc_text = results["documents"][0][idx]
                    meta = results["metadatas"][0][idx]

                    vector_sim = 1.0 - distance
                    doc_words = set(doc_text.lower().split())
                    overlap = len(query_words & doc_words)
                    keyword_score = overlap / len(query_words) if query_words else 0.0
                    hybrid_score = (VECTOR_WEIGHT * vector_sim) + (KEYWORD_WEIGHT * keyword_score)

                    candidates.append({
                        "id": doc_id,
                        "document": doc_text,
                        "metadata": meta,
                        "distance": round(distance, 4),
                        "similarity": round(hybrid_score, 4),
                        "vector_similarity": round(vector_sim, 4),
                        "keyword_score": round(keyword_score, 4),
                        "embedding_lane": lane.name,
                    })

            candidates.sort(key=lambda c: c["similarity"], reverse=True)
            top = dedupe_results(candidates, limit=k)
            logger.info(f"Hybrid search for '{query[:60]}': {len(top)} results")
            return top

        except Exception as e:
            logger.error(f"search failed: {e}")
            return self._keyword_search_fallback(query, k, owner=owner)

    def _keyword_search_fallback(self, query: str, k: int = 5, owner: Optional[str] = None) -> List[Dict[str, Any]]:
        try:
            if not self._active_collections():
                return []

            query_words = query.lower().split()
            scored = []
            for lane_name, collection in self._active_collections():
                if collection.count() == 0:
                    continue
                all_docs = collection.get(include=["documents", "metadatas"])
                if not all_docs["ids"]:
                    continue
                for i, doc in enumerate(all_docs["documents"]):
                    meta = all_docs["metadatas"][i]
                    if owner and meta.get("owner") != owner:
                        continue
                    doc_lower = doc.lower()
                    score = sum(1 for w in query_words if w in doc_lower)
                    if score > 0:
                        scored.append({
                            "id": all_docs["ids"][i],
                            "document": doc,
                            "metadata": meta,
                            "distance": 0,
                            "similarity": score,
                            "search_type": "keyword_fallback",
                            "embedding_lane": lane_name,
                        })

            scored.sort(key=lambda x: x["similarity"], reverse=True)
            return dedupe_results(scored, limit=k)
        except Exception as e:
            logger.error(f"keyword fallback failed: {e}")
            return []

    # ------------------------------------------------------------------
    # 索引管理
    # ------------------------------------------------------------------

    def rebuild_index(self) -> bool:
        try:
            from src.chroma_client import get_chroma_client
            client = get_chroma_client()
            try:
                client.delete_collection(COLLECTION_NAME)
            except Exception:
                pass
            for name in (
                collection_name(COLLECTION_NAME, LANE_CUSTOM),
                collection_name(COLLECTION_NAME, LANE_FASTEMBED),
            ):
                try:
                    client.delete_collection(name)
                except Exception:
                    pass
            # 重建意味着清空当前通道。同时也清除旧版未加后缀的
            # 集合，使得启动迁移无法复活过时的文档。
            self._lanes = build_embedding_lanes(COLLECTION_NAME)
            self._collection = next(
                (lane.collection for lane in self._lanes if lane.name == LANE_FASTEMBED),
                self._lanes[0].collection if self._lanes else None,
            )
            self._healthy = True
            return True
        except Exception as e:
            logger.error(f"rebuild_index failed: {e}")
            self._healthy = False
            return False

    def get_stats(self) -> Dict[str, Any]:
        if not self.healthy:
            return {"error": "Collection not initialized"}
        try:
            return {
                "document_count": lane_count(self._lanes),
                "embedding_model": f"{self._lanes[0].model} @ {self._lanes[0].url}" if self._lanes else "N/A",
                "persist_directory": self.persist_directory,
                "collection_name": COLLECTION_NAME,
                "embedding_lanes": [lane.stats() for lane in self._lanes],
                "healthy": True,
            }
        except Exception as e:
            logger.error(f"get_stats failed: {e}")
            return {"error": str(e), "healthy": False}

    # ------------------------------------------------------------------
    # 目录索引
    # ------------------------------------------------------------------

    def index_personal_documents(
        self, directory: str, file_extensions: Optional[set] = None, owner: Optional[str] = None
    ) -> Dict[str, Any]:
        if file_extensions is None:
            file_extensions = DEFAULT_FILE_EXTENSIONS

        indexed = 0
        failed = 0

        try:
            for root, _, files in os.walk(directory):
                for fname in files:
                    fpath = os.path.join(root, fname)
                    ext = Path(fname).suffix.lower()
                    if ext not in file_extensions:
                        continue

                    try:
                        if ext == '.pdf':
                            from src.personal_docs import extract_pdf_text
                            content = extract_pdf_text(fpath)
                        else:
                            with open(fpath, 'r', encoding='utf-8') as f:
                                content = f.read()

                        if not content or not content.strip():
                            continue

                        meta = {
                            'source': fpath,
                            'filename': fname,
                            'directory': root,
                            'type': ext,
                        }
                        if owner:
                            meta['owner'] = owner

                        for i, chunk in enumerate(self._split_into_chunks(content)):
                            if self.add_document(chunk, {**meta, 'chunk_id': i}):
                                indexed += 1
                            else:
                                failed += 1
                    except Exception as e:
                        logger.error(f"index {fpath}: {e}")
                        failed += 1

            return {
                'success': True,
                'indexed_count': indexed,
                'failed_count': failed,
                'message': f'Indexed {indexed} chunks from {directory}',
            }
        except Exception as e:
            logger.error(f"index_personal_documents {directory}: {e}")
            return {'success': False, 'indexed_count': indexed, 'failed_count': failed, 'message': str(e)}

    def remove_directory(self, directory: str) -> Dict[str, Any]:
        """移除 ``directory`` 下（递归）的所有块，除此之外不删除任何内容。

        选择基于每个块存储的 ``source`` 完整路径的 Python 端路径边界匹配，
        而非 Chroma 元数据 ``where`` 过滤器。没有 Chroma
        元数据操作符可以按路径前缀选择标量字符串（``$contains``
        针对文档内容/列表成员，而非 ``source`` 子串），
        而纯子串匹配会过度删除 — 移除 ``/docs``
        不能触碰 ``/docs2`` 或 ``/docs_personal``。因此我们匹配
        ``source == directory`` 或 ``source`` 以 ``directory + os.sep`` 开头，
        与 add_directory 用于排除的边界规则相同。``directory``
        经过 abspath 规范化，因此与索引用绝对路径存储的 ``source`` 匹配，
        无论调用方如何传入。
        """
        if not self.healthy:
            return {"success": False, "message": "Collection not initialized"}
        directory = os.path.abspath(directory)
        try:
            removed_ids = set()
            for _lane_name, collection in self._collections_for_delete():
                results = collection.get(include=["metadatas"])
                ids = [
                    results["ids"][i]
                    for i, m in enumerate(results["metadatas"])
                    if isinstance(m, dict)
                    and isinstance(m.get("source"), str)
                    and (m["source"] == directory or m["source"].startswith(directory + os.sep))
                ]
                if ids:
                    collection.delete(ids=ids)
                    removed_ids.update(ids)
            if not removed_ids:
                return {"success": True, "removed_count": 0, "message": "No docs found"}

            n = len(removed_ids)
            logger.info(f"Removed {n} chunks from {directory}")
            return {"success": True, "removed_count": n, "message": f"Removed {n} chunks"}
        except Exception as e:
            logger.error(f"remove_directory {directory}: {e}")
            return {"success": False, "message": str(e)}

    def reindex_directory(
        self, directory: str, file_extensions: Optional[set] = None
    ) -> Dict[str, Any]:
        remove_result = self.remove_directory(directory)
        if not remove_result.get("success"):
            return remove_result
        index_result = self.index_personal_documents(directory, file_extensions)
        return {
            "success": index_result.get("success", False),
            "message": (
                f"Re-index for {directory}: removed {remove_result.get('removed_count', 0)}, "
                f"{index_result.get('message', '')}"
            ),
            "removed_count": remove_result.get("removed_count", 0),
            "indexed_count": index_result.get("indexed_count", 0),
            "failed_count": index_result.get("failed_count", 0),
        }

    # ------------------------------------------------------------------
    # 句子边界感知分块
    # ------------------------------------------------------------------

    def _split_into_chunks(
        self, text: str, chunk_size: int = 1000, overlap: int = 200
    ) -> List[str]:
        if not text:
            return []
        if len(text) <= chunk_size:
            return [text]

        # 先按句子分割
        sentences = re.split(r'(?<=[.!?])\s+|\n{2,}', text)
        sentences = [s.strip() for s in sentences if s.strip()]

        chunks: List[str] = []
        current_chunk: List[str] = []
        current_len = 0

        for sentence in sentences:
            sent_len = len(sentence)

            # 如果单个句子超过 chunk_size，按字符分割
            if sent_len > chunk_size:
                # 先清空当前块
                if current_chunk:
                    chunks.append(' '.join(current_chunk))
                    current_chunk = []
                    current_len = 0

                # 硬分割长句子
                for start in range(0, sent_len, chunk_size - overlap):
                    chunks.append(sentence[start:start + chunk_size])
                continue

            if current_len + sent_len + 1 > chunk_size and current_chunk:
                chunks.append(' '.join(current_chunk))
                # 保留最后几句用作重叠
                overlap_sentences: List[str] = []
                overlap_len = 0
                for s in reversed(current_chunk):
                    if overlap_len + len(s) > overlap:
                        break
                    overlap_sentences.insert(0, s)
                    overlap_len += len(s) + 1
                current_chunk = overlap_sentences
                current_len = sum(len(s) for s in current_chunk) + max(0, len(current_chunk) - 1)

            current_chunk.append(sentence)
            current_len += sent_len + (1 if current_len > 0 else 0)

        if current_chunk:
            chunks.append(' '.join(current_chunk))

        return chunks if chunks else [text]

    # ------------------------------------------------------------------
    # 按元数据删除
    # ------------------------------------------------------------------

    def delete_by_source(self, source: str) -> int:
        """移除所有 metadata['source'] 匹配 *source* 的块。
        返回删除的块数量。"""
        if not self.healthy:
            return 0
        try:
            removed_ids = set()
            for _lane_name, collection in self._collections_for_delete():
                results = collection.get(
                    where={"source": source},
                    include=[],
                )
                ids = results.get("ids", [])
                if ids:
                    collection.delete(ids=ids)
                    removed_ids.update(ids)
            logger.info(f"Deleted {len(removed_ids)} chunks for source={source}")
            return len(removed_ids)
        except Exception as e:
            logger.error(f"delete_by_source failed: {e}")
            return 0

    # ------------------------------------------------------------------
    # 便捷方法
    # ------------------------------------------------------------------

    def retrieve(self, query: str, k: int = 5) -> List[str]:
        return [r['document'] for r in self.search(query, k)]
