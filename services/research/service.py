# services/research/service.py
"""研究服务 — LLM 参与环路的深度研究。"""

import re
from dataclasses import dataclass, field
from typing import List, Optional, Callable

from .research_handler import ResearchHandler

# ResearchHandler._format_research_report 发出的 Markdown 来源链接，
# 例如 "- [Some Title](https://example.com/page)"。
_SOURCE_LINK_RE = re.compile(r"^\s*-\s*\[(?P<title>[^\]]*)\]\((?P<url>[^)]+)\)\s*$")


@dataclass
class ResearchSource:
    """研究中找到的一个来源。"""
    url: str
    title: str
    snippet: str
    relevance: float = 0.0


@dataclass
class ResearchResult:
    """深度研究查询的结果。"""
    query: str
    summary: str
    sources: List[ResearchSource] = field(default_factory=list)
    sections: List[str] = field(default_factory=list)
    tokens_used: int = 0
    duration_seconds: float = 0.0


class ResearchService:
    """
    深度研究服务。

    用法：
        service = ResearchService()
        result = await service.research("2024 量子计算进展")
        print(result.summary)
    """

    def __init__(self):
        self.handler = ResearchHandler()
        self._active: dict = {}

    async def research(
        self,
        topic: str,
        llm_endpoint: str,
        llm_model: str,
        max_time: int = 300,
        on_progress: Optional[Callable[[dict], None]] = None,
    ) -> ResearchResult:
        """
        对某个主题执行深度研究。

        Args:
            topic: 研究主题/问题
            llm_endpoint: LLM API 端点
            llm_model: 要使用的模型
            max_time: 最长耗时（秒）
            on_progress: 可选进度回调

        Returns:
            包含研究结果的 ResearchResult
        """
        import time
        start = time.time()

        result = await self.handler.call_research_service(
            topic,
            llm_endpoint,
            llm_model,
            max_time=max_time,
            progress_callback=on_progress,
        )

        duration = time.time() - start

        # call_research_service returns a formatted markdown report string
        # (see ResearchHandler.call_research_service -> _format_research_report),
        # not a dict. Treat it as such; tolerate an unexpected dict/None defensively.
        if isinstance(result, dict):
            sources = [
                ResearchSource(
                    url=s.get("url", ""),
                    title=s.get("title", ""),
                    snippet=s.get("snippet", ""),
                    relevance=s.get("relevance", 0.0),
                )
                for s in result.get("sources", [])
                if isinstance(s, dict)
            ]
            return ResearchResult(
                query=topic,
                summary=result.get("summary", result.get("answer", "")),
                sources=sources,
                sections=result.get("sections", []),
                tokens_used=result.get("tokens_used", 0),
                duration_seconds=duration,
            )

        report = result if isinstance(result, str) else ""
        return ResearchResult(
            query=topic,
            summary=report,
            sources=self._parse_sources(report),
            duration_seconds=duration,
        )

    @staticmethod
    def _parse_sources(report: str) -> List[ResearchSource]:
        """从报告的 Markdown ### Sources 部分提取来源。

        ResearchHandler 为每个去重后的发现发出一个 ``- [title](url)`` 链接，
        位于 ``### Sources`` 标题下。仅解析该部分，避免将正文
        其他地方的内联链接误识别为来源。
        """
        if not report:
            return []
        sources: List[ResearchSource] = []
        seen = set()
        in_sources = False
        for line in report.splitlines():
            stripped = line.strip()
            if stripped.startswith("###") or stripped.startswith("##"):
                in_sources = stripped.lower().lstrip("#").strip() == "sources"
                continue
            if not in_sources:
                continue
            match = _SOURCE_LINK_RE.match(line)
            if not match:
                continue
            url = match.group("url").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            sources.append(
                # snippet is required on ResearchSource; markdown source links
                # carry no snippet, so default to empty (matches the dict path).
                ResearchSource(url=url, title=match.group("title").strip(), snippet="")
            )
        return sources

    def start_background(
        self,
        session_id: str,
        topic: str,
        llm_endpoint: str,
        llm_model: str,
        max_time: int = 300,
    ) -> dict:
        """在后台启动研究。返回任务信息。"""
        return self.handler.start_research(
            session_id, topic, llm_endpoint, llm_model, max_time
        )

    def get_status(self, session_id: str) -> Optional[dict]:
        """获取后台研究的状态。"""
        return self.handler.get_status(session_id)

    def cancel(self, session_id: str) -> bool:
        """取消后台研究。"""
        return self.handler.cancel_research(session_id)
