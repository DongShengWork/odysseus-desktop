"""搜索分析、指标追踪和异常层次结构。"""

import json
import logging
from collections import Counter
from pathlib import Path
from typing import Dict, Any

from core.constants import DATA_DIR

from .cache import cache_metrics

logger = logging.getLogger(__name__)

# 专用错误日志器 — 写入 data logs 目录（原生运行和 Docker 均可写，
# Docker 中 DATA_DIR 解析为绑定的挂载卷）。
_log_dir = Path(DATA_DIR) / "logs"
_error_log_path = _log_dir / "search_engine_error.log"
error_logger = logging.getLogger("search_engine_error")
error_logger.propagate = False
try:
    _log_dir.mkdir(parents=True, exist_ok=True)
    _error_handler = logging.FileHandler(_error_log_path, encoding="utf-8")
    _error_handler.setLevel(logging.WARNING)
    _error_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    error_logger.addHandler(_error_handler)
except Exception as _e:
    logging.getLogger(__name__).warning("search_engine_error log handler unavailable: %s", _e)

# 分析日志文件 — 同样位于可写入的日志卷中。
ANALYTICS_FILE = _log_dir / "search_analytics.json"


# ----------------------------------------------------------------------
# 自定义异常层次结构
# ----------------------------------------------------------------------
class SearchEngineError(Exception):
    """所有搜索引擎相关错误的基类。"""


class NetworkError(SearchEngineError):
    """当网络请求失败时抛出（例如超时、DNS 错误）。"""


class ParseError(SearchEngineError):
    """当 HTML 或其他内容无法解析时抛出。"""


class RateLimitError(SearchEngineError):
    """当远程服务返回速率限制（HTTP 429）时抛出。"""


# ----------------------------------------------------------------------
# 分析辅助函数
# ----------------------------------------------------------------------
def _default_analytics() -> Dict[str, Any]:
    return {
        "total_queries": 0,
        "successful_queries": 0,
        "failed_queries": 0,
        "cache_hits": 0,
        "cache_misses": 0,
        "query_patterns": {},
    }


def _load_analytics() -> Dict[str, Any]:
    """从 JSON 文件加载分析数据，如果缺失则创建默认值。"""
    if not ANALYTICS_FILE.exists():
        default = _default_analytics()
        _save_analytics(default)
        return default
    try:
        with open(ANALYTICS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        # 与默认值合并，确保旧架构或部分写入的文件仍然包含每个计数器 —
        # _record_query 直接索引这些键，缺少会导致 KeyError。
        merged = _default_analytics()
        if isinstance(data, dict):
            merged.update(data)
        return merged
    except Exception as e:
        logger.warning(f"Failed to load analytics file: {e}")
        return _default_analytics()


def _save_analytics(data: Dict[str, Any]) -> None:
    """将分析数据持久化到 JSON 文件。"""
    try:
        with open(ANALYTICS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        logger.warning(f"Failed to write analytics file: {e}")


def _record_query(query: str, success: bool, cache_hit: bool) -> None:
    """更新单次查询执行的分析数据。"""
    analytics = _load_analytics()
    analytics["total_queries"] += 1
    if success:
        analytics["successful_queries"] += 1
    else:
        analytics["failed_queries"] += 1

    if cache_hit:
        analytics["cache_hits"] += 1
        cache_metrics["hits"] += 1
    else:
        analytics["cache_misses"] += 1
        cache_metrics["misses"] += 1

    patterns = analytics["query_patterns"]
    entry = patterns.get(query, {"count": 0, "successes": 0})
    entry["count"] += 1
    if success:
        entry["successes"] += 1
    patterns[query] = entry

    _save_analytics(analytics)


def get_search_stats() -> Dict[str, Any]:
    """返回汇总的搜索分析数据。"""
    analytics = _load_analytics()
    total = analytics.get("total_queries", 0) or 1
    success_rate = analytics.get("successful_queries", 0) / total
    cache_total = analytics.get("cache_hits", 0) + analytics.get("cache_misses", 0) or 1
    cache_hit_rate = analytics.get("cache_hits", 0) / cache_total

    pattern_counter = Counter({
        q: data["count"] for q, data in analytics.get("query_patterns", {}).items()
    })
    most_common = [q for q, _ in pattern_counter.most_common(5)]

    return {
        "most_common_queries": most_common,
        "success_rate": success_rate,
        "cache_hit_rate": cache_hit_rate,
        "total_queries": analytics.get("total_queries", 0),
        "successful_queries": analytics.get("successful_queries", 0),
        "failed_queries": analytics.get("failed_queries", 0),
        "cache_hits": analytics.get("cache_hits", 0),
        "cache_misses": analytics.get("cache_misses", 0),
        "cache_evictions": cache_metrics["evictions"],
        "runtime_cache_hits": cache_metrics["hits"],
        "runtime_cache_misses": cache_metrics["misses"],
    }
