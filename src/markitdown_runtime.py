"""可选的 markitdown 文档提取依赖的辅助函数。

markitdown (MIT, Microsoft) 可将 Office/EPUB 文档转换为 Markdown，比原始文本
转储更节省 token 且更易被模型理解。它是**可选的**：
通过 `pip install -r requirements-optional.txt` 安装。当依赖缺失时，调用方
优雅降级（聊天显示提示；RAG 索引器跳过该文件）— MIT 核心从不硬依赖它。
镜像了 `src/pdf_runtime.py` 中的可选依赖模式。
"""

import logging
import os

logger = logging.getLogger(__name__)

MARKITDOWN_MISSING = (
    "Office/EPUB document extraction requires markitdown. Install optional "
    "dependencies with `pip install -r requirements-optional.txt`."
)

# 通过 markitdown 处理的格式。PDF 仍走 pypdf（src/document_processor
# 和 src/personal_docs）；纯文本/code/csv/json/markdown/html 走更经济的
# 内置文本路径。以下是当前完全丢弃的格式。
MARKITDOWN_EXTS = frozenset({".docx", ".pptx", ".xlsx", ".xls", ".epub"})


def is_markitdown_format(path: str) -> bool:
    """如果文件扩展名属于通过 markitdown 处理的格式则返回 True。"""
    if not isinstance(path, str):
        return False
    return os.path.splitext(path)[1].lower() in MARKITDOWN_EXTS


def load_markitdown():
    """返回 MarkItDown 类，或抛出面向用户的安装提示。"""
    try:
        from markitdown import MarkItDown  # 可选依赖
    except ImportError as exc:
        raise RuntimeError(MARKITDOWN_MISSING) from exc
    return MarkItDown


def convert_to_markdown(path: str) -> str | None:
    """通过 markitdown 将文档转换为 Markdown 文本。

    返回提取的 Markdown，如果 markitdown 不可用或转换失败则返回 ``None`` —
    调用方优雅降级而不是报错。
    """
    try:
        markitdown_cls = load_markitdown()
    except RuntimeError:
        logger.warning("markitdown not installed; cannot extract %s", path)
        return None
    try:
        result = markitdown_cls().convert(path)
        text = getattr(result, "text_content", None)
        if text is None:
            text = getattr(result, "markdown", None)
        return text
    except Exception as e:
        logger.warning("markitdown failed to convert %s: %s", path, e)
        return None
