"""查询增强、实体提取和缓存时长辅助函数。"""

import re
import logging
from datetime import timedelta
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# 查询处理辅助函数
# ----------------------------------------------------------------------
def _detect_question_type(query: str) -> Optional[str]:
    """如果存在引导疑问词则返回（who、what、when、where、why、how）。"""
    if not isinstance(query, str):
        return None
    q = query.strip().lower()
    for word in ("who", "what", "when", "where", "why", "how"):
        # 需要完整词匹配：裸前缀会错误标记普通查询，
        # 如 "whatsapp pricing"（→ what）或 "however ..."（→ how），
        # 这些会在 enhance_query 中被 OR 追加虚假的提升词。
        if q == word or q.startswith(word + " "):
            return word
    return None


def _extract_entities(query: str) -> Dict[str, List[str]]:
    """轻量级实体提取：首字母大写的词和日期模式。"""
    if not isinstance(query, str):
        return {"names": [], "dates": []}
    entities: Dict[str, List[str]] = {"names": [], "dates": []}
    qtype = _detect_question_type(query)
    cleaned = query
    if qtype:
        cleaned = re.sub(rf"^{qtype}\b", "", cleaned, flags=re.I).strip()
    for token in re.findall(r"\b[A-Z][a-zA-Z]+\b", cleaned):
        entities["names"].append(token)
    for year in re.findall(r"\b(?:19|20)\d{2}\b", cleaned):
        entities["dates"].append(year)
    month_day_year = re.findall(
        r"\b(?:Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\s+\d{1,2},?\s*\d{4}\b",
        cleaned,
        flags=re.I,
    )
    entities["dates"].extend(month_day_year)
    return entities


def _split_multi_part(query: str) -> List[str]:
    """在常见连词处将查询拆分为子查询。"""
    if not isinstance(query, str):
        return []
    parts = re.split(r"\s+and\s+|\s+or\s+|;", query, flags=re.I)
    return [p.strip() for p in parts if p.strip()]


def _extract_site_filter(query: str) -> Tuple[str, Optional[str]]:
    """检测 'site:example.com' 标记。返回 (不带标记的查询, site 或 None)。"""
    if not isinstance(query, str):
        return "", None
    match = re.search(r"\bsite:([^\s]+)", query, flags=re.I)
    if match:
        site = match.group(1)
        new_query = re.sub(r"\bsite:[^\s]+", "", query, flags=re.I).strip()
        return new_query, site
    return query, None


def _boost_entities_in_query(base_query: str, entities: Dict[str, List[str]]) -> str:
    """将提取的实体使用 OR 追加到查询中以提高相关性。"""
    parts = [base_query]
    if entities.get("names"):
        parts.append(" OR ".join(f'"{n}"' for n in entities["names"]))
    if entities.get("dates"):
        parts.append(" OR ".join(f'"{d}"' for d in entities["dates"]))
    return " ".join(parts)


def enhance_query(original_query: str) -> Tuple[str, Optional[str]]:
    """处理原始查询：站点过滤、问题类型提升、实体提取。"""
    if not isinstance(original_query, str):
        original_query = ""
    query_without_site, site = _extract_site_filter(original_query)
    sub_queries = _split_multi_part(query_without_site)

    enhanced_subs: List[str] = []
    for sub in sub_queries:
        qtype = _detect_question_type(sub)
        boost_keywords = []
        if qtype == "who":
            boost_keywords.append("person")
        elif qtype == "when":
            boost_keywords.append("date")
        elif qtype == "where":
            boost_keywords.append("location")
        elif qtype == "why":
            boost_keywords.append("reason")
        elif qtype == "how":
            boost_keywords.append("method")
        entities = _extract_entities(sub)
        boosted = _boost_entities_in_query(sub, entities)
        if boost_keywords:
            boosted = f'({boosted}) OR ({" OR ".join(boost_keywords)})'
        enhanced_subs.append(boosted)

    final_query = " AND ".join(f"({s})" for s in enhanced_subs)
    if site:
        final_query = f"{final_query} site:{site}"
    return final_query, site


def build_enhanced_query(query: str, time_filter: str = None) -> str:
    """构建增强搜索查询，支持可选的时间过滤。"""
    enhanced_query, _ = enhance_query(query)

    if time_filter:
        time_map = {"day": "d", "week": "w", "month": "m", "year": "y"}
        if time_filter in time_map:
            enhanced_query = f"{enhanced_query} after:{time_map[time_filter]}"
            logger.info(f"Added time filter '{time_filter}' to query")

    logger.info(f"Enhanced query: '{query}' -> '{enhanced_query}'")
    return enhanced_query


# ----------------------------------------------------------------------
# 缓存时长辅助函数
# ----------------------------------------------------------------------
def _is_news_query(query: str) -> bool:
    """轻量级启发式判断查询是否面向新闻。"""
    news_terms = {"news", "latest", "breaking", "today", "today's", "current", "updates", "happening"}
    if not isinstance(query, str):
        return False
    tokens = set(re.findall(r"\b\w+\b", query.lower()))
    return bool(tokens & news_terms)


def _cache_duration_for_query(query: str) -> timedelta:
    """新闻查询 → 30 分钟，参考查询 → 24 小时。"""
    if _is_news_query(query):
        return timedelta(minutes=30)
    return timedelta(hours=24)
