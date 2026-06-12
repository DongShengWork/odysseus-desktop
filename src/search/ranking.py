"""活动排名模块的兼容性重导出垫片。

真实实现位于 :mod:`services.search.ranking`，搜索运行时（services/search/core.py）直接导入该模块。
此模块曾包含一份并行拷贝；现在已改为重导出，以防止两份实现再次出现不同步。
"""

from services.search.ranking import (  # noqa: F401
    _AGE_FORMATS,
    _SPORTS_HINT_RE,
    _utcnow_naive,
    rank_search_results,
    recency_score,
)
