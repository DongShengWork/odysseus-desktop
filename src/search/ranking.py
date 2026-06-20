"""活动排名模块的兼容性重导出垫片。

The real implementation lives in :mod:`services.search.ranking`, which is what
the search runtime (services/search/core.py) imports. This module used to hold a
parallel copy; it now re-exports so the two cannot drift out of sync again.
"""

from services.search.ranking import (  # noqa: F401
    _AGE_FORMATS,
    _SPORTS_HINT_RE,
    _utcnow_naive,
    rank_search_results,
    recency_score,
)
