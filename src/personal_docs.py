# src/personal_docs.py
import os
import re
import json
import logging
from typing import List, Dict, Set, Any, Tuple
from dataclasses import dataclass

from src.markitdown_runtime import MARKITDOWN_EXTS

logger = logging.getLogger(__name__)


def extract_pdf_text(file_path: str) -> str:
    """使用 pypdf（宽松许可，BSD）从 PDF 文件中提取文本。"""
    try:
        from pypdf import PdfReader
        reader = PdfReader(file_path)
        text = "".join((page.extract_text() or "") for page in reader.pages)
        return text
    except ImportError:
        logger.warning("pypdf not installed, cannot extract PDF text")
        return ""
    except Exception as e:
        logger.error(f"Failed to extract PDF text from {file_path}: {e}")
        return ""


def extract_office_text(file_path: str) -> str:
    """通过可选的 markitdown 依赖从 Office/EPUB 文档中提取文本。

    当 markitdown 缺失或提取失败时返回 ""，镜像
    extract_pdf_text — 索引器随后简单地跳过该文件的内容。
    """
    from src.markitdown_runtime import convert_to_markdown
    return convert_to_markdown(file_path) or ""


@dataclass
class PersonalDocsConfig:
    """个人文档管理的配置。"""
    CHUNK_SIZE: int = 1000
    CHUNK_OVERLAP: int = 200
    DEFAULT_EXTENSIONS: Tuple[str, ...] = (
        ".txt", ".md", ".json", ".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".epub",
    )
    DEFAULT_K: int = 5
    STOP_WORDS: Set[str] = None
    
    def __post_init__(self):
        if self.STOP_WORDS is None:
            self.STOP_WORDS = set("""
            the a an is are was were be been being to of in for on at by with from 
            and or if then else when while as it this that those these i you he she 
            we they my your our their me him her us them
            """.split())

# 初始化配置
config = PersonalDocsConfig()

def read_text_file(path: str) -> str:
    """带错误处理地读取文本文件。"""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception:
        return ""

def split_chunks(text: str, size: int = config.CHUNK_SIZE, overlap: int = config.CHUNK_OVERLAP) -> List[str]:
    """将文本分割为重叠的块。"""
    text = text.strip()
    if not text:
        return []
    chunks = []
    i = 0
    n = len(text)
    while i < n:
        j = min(i + size, n)
        chunks.append(text[i:j])
        if j >= n:
            # 已到达末尾。如果不这样，下一次起始位置（j - overlap）仍然
            # 大于 i，导致循环追加一个重复的块，该块重复
            # 文本的最后 `overlap` 个字符。
            break
        i = j - overlap if j - overlap > i else j
    return chunks

def tokenize(s: str) -> Set[str]:
    """将字符串分词为单词，不包括停用词。"""
    tokens = re.findall(r"[A-Za-z0-9_\-]+", (s or "").lower())
    return set(t for t in tokens if t not in config.STOP_WORDS and len(t) > 1)

def load_personal_index(
    personal_dir: str, 
    extensions: Tuple[str, ...] = config.DEFAULT_EXTENSIONS
) -> List[Dict[str, Any]]:
    """加载和索引个人文档。"""
    files = []
    for root, _, names in os.walk(personal_dir):
        for name in sorted(names):
            p = os.path.join(root, name)
            if not os.path.isfile(p):
                continue
            if not any(name.lower().endswith(ext) for ext in extensions):
                continue
            size = os.path.getsize(p)
            ext = os.path.splitext(name)[1].lower()
            if ext == ".pdf":
                text = extract_pdf_text(p)
            elif ext in MARKITDOWN_EXTS:
                text = extract_office_text(p)
            else:
                text = read_text_file(p)
            chunks = split_chunks(text)
            display = os.path.relpath(p, personal_dir)
            files.append({"name": display, "path": p, "size": size, "chunks": chunks})
    return files

def retrieve_personal_keyword(personal_index: List[Dict], query: str, k: int = 5) -> List[str]:
    """
    使用关键词搜索检索相关文档。

    Args:
        personal_index: 已加载的文档索引
        query: 搜索查询
        k: 要返回的结果数

    Returns:
        格式化的搜索结果列表
    """
    q = tokenize(query)
    if not q:
        return []

    scored = []
    for f in personal_index:
        if not isinstance(f, dict):
            continue
        for idx, ch in enumerate(f.get("chunks") or []):
            score = len(q & tokenize(ch))
            if score > 0:
                scored.append((score, f.get("name", ""), idx, ch))
    scored.sort(key=lambda x: x[0], reverse=True)

    out = []
    for s, fname, idx, ch in scored[:k]:
        out.append(f"[{fname} :: chunk {idx+1}]\n{ch}")
    return out

def retrieve_personal(personal_index: List[Dict], query: str, k: int = 5,
                     rag_manager=None) -> List[str]:
    """
    首先使用向量搜索检索相关个人文档，回退到关键词搜索。

    Args:
        personal_index: 已加载的文档索引
        query: 搜索查询
        k: 要返回的结果数
        rag_manager: 可选的 RAGManager 实例，用于向量搜索

    Returns:
        格式化的搜索结果列表
    """
    if not query:
        return []

    # 如果 RAGManager 可用，先尝试向量搜索
    if rag_manager:
        try:
            vector_results = rag_manager.search(query, k)
            if vector_results:
                # 格式化向量搜索结果
                out = []
                for result in vector_results:
                    # 从路径中提取文件名
                    source = result["metadata"].get("source", "")
                    filename = os.path.basename(source)

                    # 格式化结果
                    formatted = f"[{filename} :: vector search]\n{result['document']}"
                    out.append(formatted)
                return out
        except Exception as e:
            logger.warning(f"Vector search failed, falling back to keyword search: {e}")

    # 回退到关键词搜索
    return retrieve_personal_keyword(personal_index, query, k)


def _string_list(values) -> list[str]:
    return [value for value in values or [] if isinstance(value, str)]


class PersonalDocsManager:
    """个人文档索引和检索的管理器类。"""

    def __init__(self, personal_dir: str, rag_manager=None):
        self.personal_dir = personal_dir
        self.rag_manager = rag_manager
        self.index = []
        self.indexed_directories = []  # 跟踪附加目录
        self.excluded_files: Set[str] = set()  # 从 RAG 列表中移除的文件
        self.directories_file = os.path.join(personal_dir, "indexed_directories.json")
        self._excluded_file = os.path.join(personal_dir, "excluded_files.json")
        self.load_directories()
        self._load_excluded()
        self.refresh_index()

    def load_directories(self):
        """从持久化存储中加载已索引目录列表。"""
        try:
            if os.path.exists(self.directories_file):
                with open(self.directories_file, 'r', encoding="utf-8") as f:
                    directories = json.load(f)
                if not isinstance(directories, list):
                    raise ValueError("indexed directories must be a list")
                self.indexed_directories = _string_list(directories)
                logger.info(f"Loaded {len(self.indexed_directories)} indexed directories")
            else:
                self.indexed_directories = []
        except Exception as e:
            logger.error(f"Error loading directories: {e}")
            self.indexed_directories = []

    def save_directories(self):
        """将已索引目录列表保存到持久化存储。"""
        try:
            with open(self.directories_file, 'w', encoding="utf-8") as f:
                json.dump(_string_list(self.indexed_directories), f, indent=2)
            logger.info(f"Saved {len(self.indexed_directories)} indexed directories")
        except Exception as e:
            logger.error(f"Error saving directories: {e}")

    def _load_excluded(self):
        """从持久化存储中加载已排除文件路径集合。"""
        try:
            if os.path.exists(self._excluded_file):
                with open(self._excluded_file, 'r', encoding="utf-8") as f:
                    excluded = json.load(f)
                if not isinstance(excluded, list):
                    raise ValueError("excluded files must be a list")
                self.excluded_files = set(_string_list(excluded))
            else:
                self.excluded_files = set()
        except Exception as e:
            logger.error(f"Error loading excluded files: {e}")
            self.excluded_files = set()

    def _save_excluded(self):
        try:
            with open(self._excluded_file, 'w', encoding="utf-8") as f:
                json.dump(_string_list(self.excluded_files), f)
        except Exception as e:
            logger.error(f"Error saving excluded files: {e}")

    def exclude_file(self, filepath: str):
        """从列表中排除文件。重启后持久化保留。"""
        self.excluded_files.add(os.path.abspath(filepath))
        self._save_excluded()
        self.index = [f for f in self.index if os.path.abspath(f.get("path", "")) != os.path.abspath(filepath)]

    def add_directory(self, directory: str, *, index: bool = True, owner: str = None):
        """将目录添加到跟踪列表并可选择索引它。"""
        # 规范化路径
        directory = os.path.abspath(directory)

        # 清除此目录中文件的任何排除项。在路径边界匹配
        # （目录本身或其下的路径）而非原始字符串前缀：
        # 裸的 ``startswith(directory)`` 也会匹配仅仅是共享
        # 名称前缀的同级目录（例如添加 ``/docs`` 会错误地
        # 取消排除 ``/docs2`` 下的文件）。
        self.excluded_files = {
            p for p in self.excluded_files
            if not (p == directory or p.startswith(directory + os.sep))
        }
        self._save_excluded()

        if directory not in self.indexed_directories:
            self.indexed_directories.append(directory)
            self.save_directories()
            logger.info(f"Added directory to tracking: {directory}")
            
            # 如果 RAG 管理器可用，立即索引该目录。
            # 已在 owner 元数据下索引的调用方可传递
            # index=False，这样不会创建第二个无所有者的副本。
            if index and self.rag_manager:
                try:
                    result = self.rag_manager.index_personal_documents(directory, owner=owner)
                    logger.info(f"Indexed {result.get('indexed_count', 0)} chunks from {directory}")
                except Exception as e:
                    logger.error(f"Failed to index directory {directory}: {e}")
            
            # 刷新本地索引以包含新目录
            self.refresh_index()
        else:
            logger.info(f"Directory already indexed: {directory}")

    def remove_directory(self, directory: str):
        """从跟踪列表中移除目录。"""
        # 规范化路径
        directory = os.path.abspath(directory)
        
        if directory in self.indexed_directories:
            self.indexed_directories.remove(directory)
            self.save_directories()
            logger.info(f"Removed directory from tracking: {directory}")
            
            # 刷新索引以排除已移除的目录
            self.refresh_index()
            
            # 仅删除此目录的块的针对性删除。之前的实现
            # 调用 rag_manager.rebuild_index()，会删除+重新创建
            # 整个共享集合（每个所有者 + 基础索引），然后
            # 仅重新索引剩余的跟踪目录 — 无所有者也从不包括
            # personal_dir — 造成灾难性的擦除（#1660）。remove_directory 现在
            # 只删除该目录的块，其余保持不变。
            if self.rag_manager:
                try:
                    self.rag_manager.remove_directory(directory)
                except Exception as e:
                    logger.error(f"Failed to remove directory from RAG index: {e}")
        else:
            logger.info(f"Directory not in index: {directory}")

    def rename_directory(self, old_directory: str, new_directory: str, *, path_map: Dict[str, str] = None):
        """Rewrite tracked directory and excluded-file paths after an owner rename."""
        old_directory = os.path.abspath(old_directory)
        new_directory = os.path.abspath(new_directory)
        path_map = {os.path.abspath(k): os.path.abspath(v) for k, v in (path_map or {}).items()}

        def rewrite(path: str) -> str:
            abs_path = os.path.abspath(path)
            mapped = path_map.get(abs_path)
            if mapped:
                return mapped
            if abs_path == old_directory:
                return new_directory
            if abs_path.startswith(old_directory + os.sep):
                return new_directory + abs_path[len(old_directory):]
            return abs_path

        changed_dirs = False
        rewritten_dirs = []
        for directory in self.indexed_directories:
            rewritten = rewrite(directory)
            changed_dirs = changed_dirs or rewritten != os.path.abspath(directory)
            if rewritten not in rewritten_dirs:
                rewritten_dirs.append(rewritten)
        if changed_dirs:
            self.indexed_directories = rewritten_dirs
            self.save_directories()

        changed_excluded = False
        rewritten_excluded = set()
        for path in self.excluded_files:
            rewritten = rewrite(path)
            changed_excluded = changed_excluded or rewritten != os.path.abspath(path)
            rewritten_excluded.add(rewritten)
        if changed_excluded:
            self.excluded_files = rewritten_excluded
            self._save_excluded()

        if changed_dirs or changed_excluded:
            self.refresh_index()

    def get_indexed_directories(self):
        """获取所有已索引目录的列表。"""
        return self.indexed_directories.copy()

    def refresh_index(self):
        """刷新文档索引，包括所有跟踪的目录。"""
        self.index = []

        # 索引基础个人目录
        base_files = load_personal_index(self.personal_dir)
        for f in base_files:
            if os.path.abspath(f.get("path", "")) in self.excluded_files:
                continue
            f['source_dir'] = self.personal_dir
            self.index.append(f)

        # 索引附加目录
        for directory in self.indexed_directories:
            if not os.path.exists(directory):
                logger.warning(f"Directory no longer exists: {directory}")
                continue

            if not os.path.isdir(directory):
                logger.warning(f"Path is not a directory: {directory}")
                continue

            # 从此目录加载文件
            dir_files = load_personal_index(directory)
            for f in dir_files:
                if os.path.abspath(f.get("path", "")) in self.excluded_files:
                    continue
                # 更新名称以包含目录信息，更清晰
                f['source_dir'] = directory
                f['name'] = f"{os.path.basename(directory)}/{f['name']}"
                self.index.append(f)

        logger.info(f"Refreshed index: {len(self.index)} documents from {len(self.indexed_directories) + 1} directories")

    def retrieve(self, query: str, k: int = 5) -> List[str]:
        """检索与查询相关的文档。"""
        return retrieve_personal(self.index, query, k, self.rag_manager)

    def get_file_list(self) -> List[Dict[str, Any]]:
        """获取带元数据的已索引文件列表。"""
        return [{"name": f["name"], "size": f["size"]} for f in self.index]

    def get_stats(self) -> Dict[str, Any]:
        """获取已索引文档的统计信息。"""
        total_docs = len(self.index)
        total_chunks = sum(len(doc.get('chunks', [])) for doc in self.index)
        total_size = sum(doc.get('size', 0) for doc in self.index)
        
        extensions = {}
        for doc in self.index:
            ext = os.path.splitext(doc['path'])[1]
            extensions[ext] = extensions.get(ext, 0) + 1
        
        return {
            'total_documents': total_docs,
            'total_chunks': total_chunks,
            'total_size_bytes': total_size,
            'total_size_mb': round(total_size / (1024 * 1024), 2),
            'file_types': extensions,
            'directories_count': len(self.indexed_directories) + 1,
            'base_directory': self.personal_dir,
            'additional_directories': self.indexed_directories
        }
        
    def index_all_directories(self):
        """在 RAG 系统中重新索引所有跟踪的目录。"""
        if not self.rag_manager:
            logger.warning("No RAG manager available for indexing")
            return
        
        success_count = 0
        failure_count = 0
        
        # 索引基础个人目录
        try:
            result = self.rag_manager.index_personal_documents(self.personal_dir)
            if result.get('success'):
                success_count += 1
                logger.info(f"Indexed base directory: {self.personal_dir}")
        except Exception as e:
            failure_count += 1
            logger.error(f"Failed to index base directory {self.personal_dir}: {e}")
        
        # 索引附加目录
        for directory in self.indexed_directories:
            if not os.path.exists(directory):
                logger.warning(f"Skipping non-existent directory: {directory}")
                failure_count += 1
                continue
            
            try:
                result = self.rag_manager.index_personal_documents(directory)
                if result.get('success'):
                    success_count += 1
                    logger.info(f"Indexed directory: {directory}")
                else:
                    failure_count += 1
                    logger.error(f"Failed to index directory {directory}: {result.get('message')}")
            except Exception as e:
                failure_count += 1
                logger.error(f"Failed to index directory {directory}: {e}")
        
        logger.info(f"Indexing complete: {success_count} succeeded, {failure_count} failed")
        return {"success": success_count, "failed": failure_count}
