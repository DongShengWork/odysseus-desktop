# services/__init__.py
"""
服务层 — 为聊天核心提供可插拔的能力模块。

每个服务：
- 专注做好一件事
- 暴露清晰的异步接口
- 可以作为进程内模块运行，也可以作为独立的 HTTP 服务运行
"""

from .search import SearchService, SearchResult, SearchResponse
from .docs import DocsService, DocChunk, IndexResult
from .research import ResearchService, ResearchResult, ResearchSource
from .memory import MemoryService, Memory, MemorySearchResult
from .shell import ShellService, ShellResult

__all__ = [
    # Search
    "SearchService",
    "SearchResult",
    "SearchResponse",
    # Docs
    "DocsService",
    "DocChunk",
    "IndexResult",
    # Research
    "ResearchService",
    "ResearchResult",
    "ResearchSource",
    # Memory
    "MemoryService",
    "Memory",
    "MemorySearchResult",
    # Shell
    "ShellService",
    "ShellResult",
]
