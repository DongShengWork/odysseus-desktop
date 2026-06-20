# services/research/__init__.py
"""研究服务 — LLM 参与环路的深度研究。"""

from .service import ResearchService, ResearchResult, ResearchSource
from .research_handler import ResearchHandler

__all__ = [
    "ResearchService",
    "ResearchResult",
    "ResearchSource",
    "ResearchHandler",
]
