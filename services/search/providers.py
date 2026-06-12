"""搜索提供商实现：SearXNG、Brave、DuckDuckGo、Google PSE、Tavily、Serper。"""

import json
import logging
import os
from typing import List, Optional
from urllib.parse import urljoin, urlparse, parse_qs

import httpx
from bs4 import BeautifulSoup

from src.constants import SEARXNG_INSTANCE
from .analytics import RateLimitError, error_logger
from .query import build_enhanced_query

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 20

# 提供商注册表 — 将设置值映射为 (标签, 需要密钥, 需要 URL)
PROVIDER_INFO = {
    "searxng":  ("SearXNG",           False, True),
    "brave":    ("Brave Search",      True,  False),
    "duckduckgo": ("DuckDuckGo",      False, False),
    "google_pse": ("Google PSE",      True,  False),
    "tavily":   ("Tavily",            True,  False),
    "serper":   ("Serper",            True,  False),
    "disabled": ("Disabled",          False, False),
}


# ── 设置辅助 ──

def _get_search_settings() -> dict:
    """从管理员配置返回搜索设置，回退到环境变量默认值。"""
    try:
        from src.settings import load_settings
        return load_settings()
    except Exception:
        return {}


def _get_search_instance() -> str:
    """从管理员设置返回活跃的搜索 API URL，回退到环境变量。"""
    settings = _get_search_settings()
    url = (settings.get("search_url") or "").strip()
    if url:
        return url.rstrip("/")
    return SEARXNG_INSTANCE


def _get_provider_key(provider: str) -> str:
    """返回特定提供商的 API 密钥，带旧版回退。"""
    settings = _get_search_settings()
    key_map = {
        "brave": "brave_api_key",
        "google_pse": "google_pse_key",
        "tavily": "tavily_api_key",
        "serper": "serper_api_key",
    }
    field = key_map.get(provider, "")
    if field:
        val = (settings.get(field) or "").strip()
        if val:
            return val
    # 旧版回退：旧的共享 search_api_key 字段
    legacy = (settings.get("search_api_key") or "").strip()
    if legacy:
        return legacy
    env_map = {
        "brave": "DATA_BRAVE_API_KEY",
        "google_pse": "GOOGLE_API_KEY",
        "tavily": "TAVILY_API_KEY",
        "serper": "SERPER_API_KEY",
    }
    env_name = env_map.get(provider, "")
    return (os.environ.get(env_name) or "").strip() if env_name else ""


def _get_result_count() -> int:
    """返回配置的结果数量，默认 5。"""
    settings = _get_search_settings()
    try:
        return int(settings.get("search_result_count", 5))
    except (ValueError, TypeError):
        return 5


# 标准安全搜索等级："strict"（默认）、"moderate"、"off"。
# 各提供商有自己的开关名称和值空间 — 参见 _safesearch_for(...)。
_SAFESEARCH_LEVELS = ("strict", "moderate", "off")


def _get_safesearch_level() -> str:
    """返回配置的安全搜索等级，标准化为标准值。"""
    settings = _get_search_settings()
    raw = (settings.get("search_safesearch") or "strict").strip().lower()
    if raw in _SAFESEARCH_LEVELS:
        return raw
    aliases = {
        "on": "strict", "high": "strict", "2": "strict",
        "medium": "moderate", "1": "moderate", "default": "moderate",
        "none": "off", "disabled": "off", "0": "off",
    }
    return aliases.get(raw, "strict")


def _safesearch_for(provider: str) -> Optional[str]:
    """将标准安全搜索等级转换为特定于提供商的值。"""
    level = _get_safesearch_level()
    if provider == "searxng":
        return {"strict": "2", "moderate": "1", "off": "0"}[level]
    if provider == "brave":
        return level
    if provider == "duckduckgo_lib":
        return {"strict": "on", "moderate": "moderate", "off": "off"}[level]
    if provider == "duckduckgo_html":
        return {"strict": "1", "moderate": "-1", "off": "-2"}[level]
    if provider == "google_pse":
        return None if level == "off" else "active"
    if provider == "serper":
        return None if level == "off" else "active"
    return None


# ── SearXNG ──

_NEWS_HINTS = ("news", "nyheter", "headlines", "breaking", "latest", "today", "idag")

# 默认通用引擎（google/duckduckgo/brave/startpage/wikipedia）在
# 此实例上经常被限速/CAPTCHA 阻止，不返回结果。
# 锁定实际响应的引擎，使非新闻查询无需任何
# 第三方 API 回退即可获取结果。可通过 SEARXNG_GENERAL_ENGINES 覆盖。
_GENERAL_ENGINES = os.environ.get("SEARXNG_GENERAL_ENGINES", "bing,mojeek,presearch")


def searxng_search_api(query: str, count: int = 10, categories: str = "general",
                       time_filter: Optional[str] = None) -> List[dict]:
    """使用 SearXNG JSON API 搜索。返回 {title, url, snippet} 列表。"""
    instance = _get_search_instance()
    api_key = ""
    headers = {"User-Agent": "Mozilla/5.0"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    # 新闻/新鲜查询在 'general' 类别中表现不佳 — 它偏好
    # 百科全书/旅游页面，忽略时效性，且（无语言固定时）
    # 混入外语结果。当 agent 层检测到
    # 新鲜度（time_filter）或查询读起来像新闻查询时，切换到
    # 'news' 类别，限制时效性，并固定语言为英语，使
    # "Canada latest news" 这样的搜索返回实际新闻而非维基百科。
    # 为所有搜索固定英语 — 否则 SearXNG 会地理定位/混合
    # 语言，品牌歧义词条会混入外语 SEO 页面（例如
    # "Odyssey" → Honda Japan，"Trojan" → Japanese malware blogs，"Polyphemus"
    # → Chinese math forums）。新闻路径已经这样做了；通用路径没有。
    params = {
        "q": query,
        "format": "json",
        "language": "en",
        "safesearch": _safesearch_for("searxng"),
    }
    q_lc = query.lower()
    is_news = time_filter is not None or any(h in q_lc for h in _NEWS_HINTS)
    if is_news and categories == "general":
        params["categories"] = "news"
        if time_filter in ("day", "week", "month", "year"):
            # 'day' 在大多数 SearXNG 新闻引擎上结果太稀疏 — 扩大到一周
            # 以确保有足够的量；新闻类别本来就偏向近期。
            params["time_range"] = "week" if time_filter in ("day", "week") else time_filter
    else:
        params["categories"] = categories
        # 将通用查询路由到未被阻止的引擎（默认通用
        # 引擎集在此实例上返回 0 — 参见 _GENERAL_ENGINES）。
        if categories == "general" and _GENERAL_ENGINES:
            params["engines"] = _GENERAL_ENGINES
    try:
        def _parse_results(results):
            return [
                {
                    "title": r.get("title", ""),
                    "url": r.get("url", ""),
                    "snippet": r.get("content", ""),
                }
                for r in results[:count]
                if r.get("url")
            ]

        def _run(search_params):
            response = httpx.get(
                f"{instance}/search",
                params=search_params,
                headers=headers or None,
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
            return _parse_results(data.get("results", [])), data

        active_params = params
        parsed, data = _run(active_params)
        if not parsed and is_news and categories == "general":
            # 某些自托管 SearXNG 配置没有可用的新闻引擎。
            # 在报告空搜索之前回退到已知好的通用引擎，
            # 否则像 "Canada news" 这样的常见查询会失败。
            fallback = {
                "q": query,
                "format": "json",
                "language": "en",
                "categories": "general",
                "safesearch": _safesearch_for("searxng"),
            }
            if _GENERAL_ENGINES:
                fallback["engines"] = _GENERAL_ENGINES
            logger.info(
                "SearXNG news search returned 0 results for %r; retrying general engines",
                query,
            )
            active_params = fallback
            parsed, data = _run(active_params)
        if not parsed and active_params.get("language"):
            fallback = dict(active_params)
            fallback.pop("language", None)
            logger.info(
                "SearXNG language-pinned search returned 0 results for %r; retrying without language",
                query,
            )
            active_params = fallback
            parsed, data = _run(active_params)
        if not parsed and active_params.get("engines"):
            fallback = dict(active_params)
            fallback.pop("engines", None)
            logger.info(
                "SearXNG pinned engines returned 0 results for %r; retrying default engines",
                query,
            )
            parsed, data = _run(fallback)
        logger.info(f"SearXNG JSON API returned {len(parsed)} results for: {query}")
        if not parsed:
            unresponsive = data.get("unresponsive_engines") if isinstance(data, dict) else None
            if unresponsive:
                logger.info(f"SearXNG unresponsive engines for {query!r}: {unresponsive}")
        return parsed
    except Exception as e:
        logger.warning(f"SearXNG JSON API search failed: {e}")
        html_results = searxng_search(query, max_results=count)
        if html_results:
            logger.info(f"SearXNG HTML fallback returned {len(html_results)} results for: {query}")
        return html_results


def searxng_search(query, max_results=10):
    """使用 SearXNG 实例搜索 — 解析 HTML。"""
    instance = _get_search_instance()
    api_key = ""
    req_headers = {"User-Agent": "Mozilla/5.0"}
    if api_key:
        req_headers["Authorization"] = f"Bearer {api_key}"
    try:
        response = httpx.get(
            f"{instance}/search",
            params={"q": query, "safesearch": _safesearch_for("searxng")},
            headers=req_headers,
            timeout=10,
        )
        if response.is_success:
            soup = BeautifulSoup(response.text, "html.parser")
            results = []
            for article in soup.select("article.result")[:max_results]:
                title_elem = article.select_one("h3 a")
                if not title_elem:
                    continue
                title = title_elem.get_text(strip=True)
                url = title_elem.get("href", "")
                snippet_elem = article.select_one("p.content")
                snippet = snippet_elem.get_text(strip=True) if snippet_elem else ""
                results.append({"title": title, "url": url, "snippet": snippet})
            logger.info(f"SearXNG search (HTML) returned {len(results)} results")
            return results
    except Exception as e:
        logger.error(f"SearXNG search failed: {e}")
    return []


# ── Brave ──

def brave_search(query: str, count: int = 10, time_filter: Optional[str] = None) -> List[dict]:
    """使用 Brave API 搜索，密钥从管理员设置或环境变量获取。"""
    api_key = _get_provider_key("brave") or os.environ.get("DATA_BRAVE_API_KEY") or ""
    return _brave_search_impl(query, count, time_filter, search_config={"brave_api_key": api_key})


def _brave_search_impl(query: str, count: int, time_filter: Optional[str] = None, search_config: dict = None) -> List[dict]:
    """Brave API 核心调用。返回结果字典列表，失败时返回空列表。"""
    enhanced_query = build_enhanced_query(query, time_filter)
    config = search_config or {}

    brave_api_key = config.get("brave_api_key")
    if not brave_api_key:
        brave_api_key = os.environ.get("DATA_BRAVE_API_KEY")

    if not brave_api_key:
        logger.warning("Brave API key not found, returning empty results for fallback")
        return []

    headers = {"X-Subscription-Token": brave_api_key, "Accept": "application/json"}
    params = {
        "q": enhanced_query,
        "count": count,
        "safesearch": _safesearch_for("brave"),
    }
    if time_filter:
        time_map = {"day": "day", "week": "week", "month": "month", "year": "year"}
        if time_filter in time_map:
            params["freshness"] = time_map[time_filter]

    logger.info(f"Executing Brave search with query: {enhanced_query}")
    try:
        response = httpx.get(
            "https://api.search.brave.com/res/v1/web/search",
            headers=headers,
            params=params,
            timeout=REQUEST_TIMEOUT,
        )
        if response.status_code == 429:
            raise RateLimitError("Brave rate limit hit")
        response.raise_for_status()
    except httpx.RequestError as e:
        error_logger.error(f"NetworkError during Brave search: {e}")
        return []
    except RateLimitError as e:
        error_logger.error(str(e))
        return []

    try:
        data = response.json()
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse Brave API response: {e}")
        return []

    results = []
    if "web" in data and "results" in data["web"]:
        for item in data["web"]["results"][:count]:
            url = item.get("url", "")
            if not url:
                continue
            results.append({
                "title": item.get("title", ""),
                "url": url,
                "snippet": item.get("description", "") or item.get("content", ""),
                "age": item.get("date", "") if item.get("date") else "",
            })

    logger.info(f"Brave search returned {len(results)} results")
    return results


# ── DuckDuckGo（免费，无需密钥）──

def _is_duckduckgo_host(host: str) -> bool:
    """仅对 duckduckgo.com 及其子域返回 True。"""
    host = (host or "").lower()
    return host == "duckduckgo.com" or host.endswith(".duckduckgo.com")


def _resolve_ddg_redirect(raw: str) -> str:
    """解析 DuckDuckGo /l/?uddg= 重定向 URL 到目标地址。"""
    if not raw:
        return raw
    resolved = raw
    if resolved.startswith("//"):
        resolved = "https:" + resolved
    elif resolved.startswith("/"):
        resolved = urljoin("https://html.duckduckgo.com", resolved)
    try:
        parsed = urlparse(resolved)
        if _is_duckduckgo_host(parsed.hostname) and parsed.path.rstrip("/") == "/l":
            qs = parse_qs(parsed.query)
            if "uddg" in qs:
                return qs["uddg"][0]
    except Exception:
        pass
    return resolved


def duckduckgo_search(query: str, count: int = 10, time_filter: Optional[str] = None) -> List[dict]:
    """使用 DuckDuckGo 通过 duckduckgo-search 库搜索。无需 API 密钥。"""

    def _html_fallback() -> List[dict]:
        try:
            response = httpx.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query, "kp": _safesearch_for("duckduckgo_html")},
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "html.parser")
            parsed = []
            for result in soup.select(".result")[:count]:
                link = result.select_one(".result__a")
                if not link:
                    continue
                url = _resolve_ddg_redirect(link.get("href", ""))
                if not url:
                    continue
                snippet_el = result.select_one(".result__snippet")
                parsed.append({
                    "title": link.get_text(" ", strip=True),
                    "url": url,
                    "snippet": snippet_el.get_text(" ", strip=True) if snippet_el else "",
                })
            logger.info(f"DuckDuckGo HTML search returned {len(parsed)} results")
            return parsed
        except Exception as e:
            logger.warning(f"DuckDuckGo HTML search failed: {e}")
            return []

    try:
        from duckduckgo_search import DDGS
    except ImportError:
        logger.warning("duckduckgo-search package not installed; using HTML fallback")
        return _html_fallback()

    timelimit = None
    if time_filter:
        time_map = {"day": "d", "week": "w", "month": "m", "year": "y"}
        timelimit = time_map.get(time_filter)

    try:
        ddgs = DDGS()
        raw = ddgs.text(
            query,
            max_results=count,
            timelimit=timelimit,
            safesearch=_safesearch_for("duckduckgo_lib"),
        )
        results = []
        for item in raw:
            url = item.get("href", "")
            if not url:
                continue
            results.append({
                "title": item.get("title", ""),
                "url": url,
                "snippet": item.get("body", ""),
            })
        logger.info(f"DuckDuckGo search returned {len(results)} results")
        return results or _html_fallback()
    except Exception as e:
        logger.warning(f"DuckDuckGo search failed: {e}")
        return _html_fallback()


# ── Google 可编程搜索引擎 ──

def google_pse_search(query: str, count: int = 10, time_filter: Optional[str] = None) -> List[dict]:
    """使用 Google PSE（自定义搜索 JSON API）搜索。

    需要在设置中配置两个密钥：
      - search_api_key：Google API 密钥
      - google_pse_cx：可编程搜索引擎 ID（cx）
    或环境变量 GOOGLE_API_KEY 和 GOOGLE_PSE_CX。
    """
    settings = _get_search_settings()
    api_key = _get_provider_key("google_pse") or os.environ.get("GOOGLE_API_KEY", "")
    cx = (settings.get("google_pse_cx") or "").strip() or os.environ.get("GOOGLE_PSE_CX", "")

    if not api_key or not cx:
        logger.warning("Google PSE: missing API key or CX ID")
        return []

    params = {
        "key": api_key,
        "cx": cx,
        "q": query,
        "num": min(count, 10),  # Google PSE 每次请求最多 10 条
    }
    safe = _safesearch_for("google_pse")
    if safe:
        params["safe"] = safe
    if time_filter:
        # dateRestrict：d[数字], w[数字], m[数字], y[数字]
        time_map = {"day": "d1", "week": "w1", "month": "m1", "year": "y1"}
        if time_filter in time_map:
            params["dateRestrict"] = time_map[time_filter]

    try:
        response = httpx.get(
            "https://www.googleapis.com/customsearch/v1",
            params=params,
            timeout=REQUEST_TIMEOUT,
        )
        if response.status_code == 429:
            raise RateLimitError("Google PSE rate limit hit")
        response.raise_for_status()
    except httpx.RequestError as e:
        error_logger.error(f"Google PSE search failed: {e}")
        return []
    except RateLimitError as e:
        error_logger.error(str(e))
        return []

    try:
        data = response.json()
    except json.JSONDecodeError as e:
        error_logger.error(f"Google PSE returned invalid JSON: {e}")
        return []

    results = []
    for item in data.get("items", [])[:count]:
        url = item.get("link", "")
        if not url:
            continue
        results.append({
            "title": item.get("title", ""),
            "url": url,
            "snippet": item.get("snippet", ""),
        })

    logger.info(f"Google PSE returned {len(results)} results")
    return results


# ── Tavily ──

def tavily_search(query: str, count: int = 10, time_filter: Optional[str] = None) -> List[dict]:
    """使用 Tavily API 搜索。需要 search_api_key 或 TAVILY_API_KEY 环境变量。"""
    api_key = _get_provider_key("tavily") or os.environ.get("TAVILY_API_KEY", "")
    if not api_key:
        logger.warning("Tavily: no API key configured")
        return []

    payload = {
        "query": query,
        "max_results": count,
        "include_answer": False,
    }
    if time_filter:
        time_map = {"day": "day", "week": "week", "month": "month", "year": "year"}
        if time_filter in time_map:
            payload["days"] = {"day": 1, "week": 7, "month": 30, "year": 365}[time_filter]

    try:
        response = httpx.post(
            "https://api.tavily.com/search",
            json=payload,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=REQUEST_TIMEOUT,
        )
        if response.status_code == 429:
            raise RateLimitError("Tavily rate limit hit")
        response.raise_for_status()
    except httpx.RequestError as e:
        error_logger.error(f"Tavily search failed: {e}")
        return []
    except RateLimitError as e:
        error_logger.error(str(e))
        return []

    try:
        data = response.json()
    except json.JSONDecodeError as e:
        error_logger.error(f"Tavily returned invalid JSON: {e}")
        return []

    results = []
    for item in data.get("results", [])[:count]:
        url = item.get("url", "")
        if not url:
            continue
        results.append({
            "title": item.get("title", ""),
            "url": url,
            "snippet": item.get("content", ""),
            "age": item.get("published_date", ""),
        })

    logger.info(f"Tavily returned {len(results)} results")
    return results


# ── Serper.dev ──

def serper_search(query: str, count: int = 10, time_filter: Optional[str] = None) -> List[dict]:
    """使用 Serper.dev API 搜索。需要 search_api_key 或 SERPER_API_KEY 环境变量。"""
    api_key = _get_provider_key("serper") or os.environ.get("SERPER_API_KEY", "")
    if not api_key:
        logger.warning("Serper: no API key configured")
        return []

    payload = {
        "q": query,
        "num": count,
    }
    safe = _safesearch_for("serper")
    if safe:
        payload["safe"] = safe
    if time_filter:
        time_map = {"day": "qdr:d", "week": "qdr:w", "month": "qdr:m", "year": "qdr:y"}
        if time_filter in time_map:
            payload["tbs"] = time_map[time_filter]

    try:
        response = httpx.post(
            "https://google.serper.dev/search",
            json=payload,
            headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
            timeout=REQUEST_TIMEOUT,
        )
        if response.status_code == 429:
            raise RateLimitError("Serper rate limit hit")
        response.raise_for_status()
    except httpx.RequestError as e:
        error_logger.error(f"Serper search failed: {e}")
        return []
    except RateLimitError as e:
        error_logger.error(str(e))
        return []

    try:
        data = response.json()
    except json.JSONDecodeError as e:
        error_logger.error(f"Serper returned invalid JSON: {e}")
        return []

    results = []
    for item in data.get("organic", [])[:count]:
        url = item.get("link", "")
        if not url:
            continue
        results.append({
            "title": item.get("title", ""),
            "url": url,
            "snippet": item.get("snippet", ""),
            "age": item.get("date", ""),
        })

    logger.info(f"Serper returned {len(results)} results")
    return results
