"""搜索和内容缓存，使用 LRU 淘汰策略。"""

import hashlib
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict

from core.constants import DATA_DIR

logger = logging.getLogger(__name__)

# 缓存目录
CACHE_DIR = Path(DATA_DIR) / "cache"
SEARCH_CACHE_DIR = CACHE_DIR / "search"
CONTENT_CACHE_DIR = CACHE_DIR / "content"
CACHE_MAX_ENTRIES = 1000

# 创建缓存目录。警惕不可写路径（例如只读挂载），
# 降级为无磁盘缓存而不是在模块导入时崩溃。
try:
    SEARCH_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    CONTENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
except OSError as _e:
    logger.warning("Search cache directory unavailable (%s); disk cache disabled", _e)

# 追踪缓存大小用于 LRU 淘汰
search_cache_index: Dict[str, datetime] = {}
content_cache_index: Dict[str, datetime] = {}

    # 全局缓存指标
cache_metrics = {"hits": 0, "misses": 0, "evictions": 0}


def generate_cache_key(data: str) -> str:
    """使用 SHA-256 哈希生成唯一的缓存键。"""
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def cleanup_cache(cache_dir: Path, cache_index: Dict[str, datetime], max_age: timedelta):
    """移除过期的缓存条目并强制执行 LRU 策略。"""
    current_time = datetime.now()
    files_in_dir = {f.name.split(".")[0]: f for f in cache_dir.glob("*.cache")}

    to_remove = []
    for key, timestamp in list(cache_index.items()):
        if current_time - timestamp > max_age or key not in files_in_dir:
            to_remove.append(key)
            if key in files_in_dir:
                files_in_dir[key].unlink(missing_ok=True)

    for key in to_remove:
        cache_index.pop(key, None)
        cache_metrics["evictions"] += 1

    if len(cache_index) > CACHE_MAX_ENTRIES:
        sorted_items = sorted(cache_index.items(), key=lambda x: x[1])
        excess_count = len(cache_index) - CACHE_MAX_ENTRIES
        for key, _ in sorted_items[:excess_count]:
            cache_index.pop(key, None)
            cache_file = cache_dir / f"{key}.cache"
            cache_file.unlink(missing_ok=True)
            cache_metrics["evictions"] += 1
