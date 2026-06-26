# 服务s/search/服务.py
"""Search service — clean interface for web search."""

from dataclasses import dataclass
from typing import List, Optional, Dict, Any

from . import (
    comprehensive_web_search,
    fetch_webpage_content,
    get_search_config,
)


@dataclass
class SearchResult:
    """单条搜索结果。"""
    url: str
    title: str
    snippet: str
    content: Optional[str] = None


@dataclass
class SearchResponse:
    """搜索查询的响应。"""
    query: str
    results: List[SearchResult]
    total: int
    cached: bool = False


class SearchService:
    """
    网页搜索服务。

    用法：
        service = SearchService()
        result = await service.search("python async patterns")
        for r in result.results:
            print(f"{r.title}: {r.url}")
    """

    def __init__(self, default_depth: int = 1, fetch_content: bool = True):
        self.default_depth = default_depth
        self.fetch_content = fetch_content

    async def search(
        self,
        query: str,
        depth: Optional[int] = None,
        fetch_content: Optional[bool] = None,
    ) -> SearchResponse:
        """
        搜索网页。

        Args:
            query: 搜索查询
            depth: 搜索深度（1=快速, 2=深入, 3=全面）
            fetch_content: 是否获取全页内容

        Returns:
            包含搜索结果的 SearchResponse
        """
        depth = depth or self.default_depth

        # comprehensive_web_search 是同步的，配合 return_sources=True
        # 返回 (context_str, [{"url", "title"}, ...])。在事件循环外运行它
        # 以免阻塞，并使用源列表作为结果行。
        # `fetch_content` 参数被接受以保持 API 兼容性；全面搜索
        # 总是抓取页面内容。
        import asyncio
        _context, raw_results = await asyncio.to_thread(
            comprehensive_web_search,
            query,
            max_pages=10 * depth,
            return_sources=True,
        )

        results = []
        for r in raw_results:
            if not isinstance(r, dict):
                continue
            results.append(SearchResult(
                url=r.get("url", ""),
                title=r.get("title", ""),
                snippet=r.get("snippet", ""),
                content=r.get("content"),
            ))

        return SearchResponse(
            query=query,
            results=results,
            total=len(results),
        )

    async def fetch_content(self, url: str) -> Optional[str]:
        """从 URL 获取内容。"""
        return await fetch_webpage_content(url)

    def get_config(self) -> Dict[str, Any]:
        """获取当前搜索配置。"""
        return get_search_config()
