"""基于相关性、来源质量和时效性对搜索结果进行排序。"""

import re
import logging
from datetime import datetime, timezone
from typing import List, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_AGE_FORMATS = ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S")


def _utcnow_naive() -> datetime:
    """返回本地 UTC 时间。与下面解析的本地 UTC 风格发布日期匹配，
    且在 Python 3.14 中安全（``datetime.utcnow()`` 已被移除，见 #1116）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def recency_score(age_str: Optional[str], now: Optional[datetime] = None) -> float:
    """评分结果的时效性：<=7 天为 1.0，>=30 天为 0.0。

    年龄以 UTC 为基准，而非本地时间。旧代码使用
    ``datetime.now()``（本地时间）对比 UTC 风格的发布日期，因此年龄
    受主机 UTC 偏移量的影响；当相邻代码迁移到带时区的 datetime 时
    也会产生潜在崩溃（#1116）。``now`` 可注入用于测试。
    """
    if not age_str:
        return 0.0
    dt = None
    for fmt in _AGE_FORMATS:
        try:
            dt = datetime.strptime(age_str, fmt)
            break
        except Exception:
            dt = None
    if not dt:
        return 0.0
    now = now or _utcnow_naive()
    days_old = (now - dt).days
    if days_old <= 7:
        return 1.0
    if days_old >= 30:
        return 0.0
    return (30 - days_old) / 23


_NEWS_HINTS = {"news", "nyheter", "headlines", "breaking", "latest", "today", "idag"}
_SPORTS_HINTS = {
    "sport", "sports", "soccer", "football", "hockey", "nba", "nfl", "mlb",
    "fifa", "world cup", "championship", "quarterfinal", "eliminates",
}
# 词边界匹配，确保 "sport" 不会在 "transport"/"passport" 内部触发，
# 且 "transport.gov" 这样的域名不会被误判为体育网站。
_SPORTS_HINT_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(h) for h in _SPORTS_HINTS) + r")\b"
)
_LOW_VALUE_NEWS_DOMAINS = {
    "facebook.com", "www.facebook.com", "sports.yahoo.com", "yahoo.com",
    "www.yahoo.com", "msn.com", "www.msn.com",
}
_TRUSTED_NEWS_DOMAINS = {
    "apnews.com", "www.apnews.com", "reuters.com", "www.reuters.com",
    "bbc.com", "www.bbc.com", "cbc.ca", "www.cbc.ca",
    "ctvnews.ca", "www.ctvnews.ca", "globalnews.ca", "www.globalnews.ca",
    "theguardian.com",
    "www.theguardian.com", "euronews.com", "www.euronews.com",
    "dw.com", "www.dw.com", "government.se", "www.government.se",
}


def _domain(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""


def _has_word(text: str, term: str) -> bool:
    """如果 ``term`` 在 ``text`` 中作为完整词出现则返回 True。

    查询词在词边界上匹配，因此短词不会匹配到
    不相关词内部："us" 不能匹配 "business"/"music"，"port"
    不能匹配 "transport"/"support"。这与构建
    ``query_terms``（``\\b\\w+\\b``）的分词方式保持一致。#1473 将标题和体育
    检查改为词边界匹配；下面的摘要和主题词检查使用
    相同的辅助函数，保证整个文件一致。
    """
    return re.search(rf"\b{re.escape(term)}\b", text) is not None


def rank_search_results(query: str, results: List[dict]) -> List[dict]:
    """按标题相关性、摘要质量、域名权威性和时效性对搜索结果进行排序。"""
    query_terms = [t.lower() for t in re.findall(r"\b\w+\b", query)]
    query_lc = query.lower()
    is_news_query = any(term in _NEWS_HINTS for term in query_terms)
    is_sports_query = bool(_SPORTS_HINT_RE.search(query_lc))

    def title_score(title: str) -> float:
        if not title:
            return 0.0
        title_lc = title.lower()
        matches = sum(1 for term in query_terms if _has_word(title_lc, term))
        return matches / len(query_terms) if query_terms else 0.0

    def snippet_score(snippet: str) -> float:
        if not snippet:
            return 0.0
        length_factor = min(len(snippet), 200) / 200
        term_hits = sum(1 for term in query_terms if _has_word(snippet.lower(), term))
        term_factor = term_hits / len(query_terms) if query_terms else 0.0
        return (length_factor + term_factor) / 2

    def domain_score(url: str) -> float:
        netloc = _domain(url)
        if not netloc:
            return 0.0
        if netloc in _TRUSTED_NEWS_DOMAINS:
            return 1.0
        if netloc.endswith(".edu") or netloc.endswith(".gov"):
            return 1.0
        if netloc.endswith(".org"):
            return 0.7
        return 0.4

    def news_quality_adjustment(title: str, snippet: str, url: str) -> float:
        if not is_news_query:
            return 0.0
        text = f"{title} {snippet}".lower()
        netloc = _domain(url)
        adjustment = 0.0
        if netloc in _TRUSTED_NEWS_DOMAINS:
            adjustment += 1.2
        if any(term in text for term in ("latest news", "breaking news", "daily coverage", "news from")):
            adjustment += 0.4
        if netloc in _LOW_VALUE_NEWS_DOMAINS:
            adjustment -= 0.8
        if not is_sports_query and (_SPORTS_HINT_RE.search(text) or _SPORTS_HINT_RE.search(netloc)):
            adjustment -= 1.5
        # 国家/新闻查询不应将标题/摘要中仅勉强提到该国
        # 的页面排在真正关于该国的新闻页面之前。
        subject_terms = [t for t in query_terms if t not in _NEWS_HINTS]
        if subject_terms and not any(_has_word(text, t) or _has_word(netloc, t) for t in subject_terms):
            adjustment -= 1.0
        return adjustment

    ranked = []
    for result in results:
        title = result.get("title", "")
        snippet = result.get("snippet", "")
        url = result.get("url", "")
        age = result.get("age", None)

        score = (
            2.0 * title_score(title)
            + 1.0 * snippet_score(snippet)
            + 1.5 * domain_score(url)
            + 1.0 * recency_score(age)
            + news_quality_adjustment(title, snippet, url)
        )
        ranked.append((score, result))

    ranked.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in ranked]
