"""核心搜索编排器：searxng_search_results、comprehensive_web_search、配置、缓存失效。"""

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, List, Set
from urllib.parse import urlparse

from .analytics import (
    NetworkError,
    ParseError,
    RateLimitError,
    error_logger,
    _record_query,
)
from .cache import (
    SEARCH_CACHE_DIR,
    search_cache_index,
    generate_cache_key,
    cleanup_cache,
)
from .query import _cache_duration_for_query
from .ranking import rank_search_results
from .providers import (
    searxng_search_api,
    brave_search,
    duckduckgo_search,
    google_pse_search,
    tavily_search,
    serper_search,
    _get_search_settings,
    _get_provider_key,
    _get_result_count,
)
from .content import (
    fetch_webpage_content,
    extract_key_points,
    get_tldr,
    extract_quotes,
    extract_statistics,
)

logger = logging.getLogger(__name__)

# ========= 配置 =========
SEARCH_CONFIG: Dict[str, Any] = {
    "primary_provider": "searxng",
}


def _is_secret_key(name: str) -> bool:
    """对于保存凭据的配置键返回 True（例如 ``brave_api_key``）。"""
    return name.endswith(("_api_key", "_key", "_token", "_secret"))


def get_search_config() -> Dict[str, Any]:
    """获取当前搜索配置，包括活跃服务商信息。

    永远不返回存储的 API 密钥：调用者——包括未认证的
    ``GET /api/search/config`` 路由——只需要通过
    ``has_api_key`` 知道密钥的 *存在*，而非秘密本身（#1661）。
    """
    config = SEARCH_CONFIG.copy()
    settings = _get_search_settings()
    provider = settings.get("search_provider", "searxng")
    config["active_provider"] = provider
    config["has_api_key"] = bool(_get_provider_key(provider))
    config["result_count"] = _get_result_count()
    if provider == "searxng":
        from .providers import _get_search_instance
        config["search_url"] = _get_search_instance()
    # 剥离所有字符串类型凭据，确保秘密不泄露到响应中；
    # 布尔 has_api_key 标记（仅存在性）被保留。
    return {
        k: v for k, v in config.items()
        if not (isinstance(v, str) and _is_secret_key(k))
    }


def update_search_config(api_key: str = None, **kwargs):
    """将非密钥搜索配置合并到 SEARCH_CONFIG 中。

    服务商 API 密钥有意 *不* 在此处缓存。它们按需从
    settings/env 通过 ``_get_provider_key``（例如 ``brave_search``）读取，
    因此之前的 ``SEARCH_CONFIG["brave_api_key"] = api_key`` 缓存从未
    被用于搜索，只通过 ``get_search_config`` /
    ``GET /api/search/config`` 泄露了解密后的密钥（#1661）。
    ``api_key`` 参数为向后兼容而接受，但不再存储。
    """
    for k, v in kwargs.items():
        if not _is_secret_key(k):
            SEARCH_CONFIG[k] = v


def _call_provider(provider_name: str, query: str, count: int, time_filter: str = None) -> List[dict]:
    """按名称调用搜索服务商。返回结果列表或空列表。"""
    if provider_name == "searxng":
        return searxng_search_api(query, count, time_filter=time_filter)
    elif provider_name == "brave":
        return brave_search(query, count, time_filter)
    elif provider_name == "duckduckgo":
        return duckduckgo_search(query, count, time_filter)
    elif provider_name == "google_pse":
        return google_pse_search(query, count, time_filter)
    elif provider_name == "tavily":
        return tavily_search(query, count, time_filter)
    elif provider_name == "serper":
        return serper_search(query, count, time_filter)
    return []


# 如果自托管 SearXNG 实例已启动但所有启用的引擎返回空结果，
# 回退到免密钥服务商，确保初次安装时 "search X" 仍然可用。
# 用户可通过 `search_回退_chain` 覆盖/禁用。
_FALLBACK_ORDER = ["duckduckgo"]


def _build_provider_chain(primary: str) -> List[str]:
    """构建有序列表：主服务商优先，然后是可配置/默认的回退服务商。"""
    chain = [primary]
    settings = _get_search_settings()
    user_chain = settings.get("search_fallback_chain") or []
    if isinstance(user_chain, str):
        user_chain = [s.strip() for s in user_chain.split(",") if s.strip()]
    fallbacks = user_chain if user_chain else _FALLBACK_ORDER
    for fb in fallbacks:
        if fb and fb != primary and fb not in chain and fb != "disabled":
            chain.append(fb)
    return chain


# ----------------------------------------------------------------------
# 带缓存和重试的统一搜索
# ----------------------------------------------------------------------
def searxng_search_results(query: str, count: int = 10, time_filter: str = None) -> list[dict]:
    """使用配置的服务商执行网页搜索，支持缓存和重试。"""
    settings = _get_search_settings()
    search_provider = settings.get("search_provider", "searxng")
    result_count = _get_result_count()
    # 如果调用者使用默认值，则使用配置的结果数量
    if count == 10:
        count = result_count

    cache_key = generate_cache_key(f"{query}|{count}|{time_filter}")
    cache_file = SEARCH_CACHE_DIR / f"{cache_key}.cache"

    # 检查缓存
    if cache_file.exists():
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                cached_data = json.load(f)
            expiry_raw = cached_data.get("expiry")
            expiry = datetime.fromisoformat(expiry_raw) if expiry_raw else None
            if expiry and datetime.now() < expiry:
                logger.debug(f"Search cache hit for query: {query}")
                results = cached_data["data"]
                _record_query(query, bool(results), cache_hit=True)
                return results
            else:
                cache_file.unlink(missing_ok=True)
                search_cache_index.pop(cache_key, None)
        except Exception as e:
            logger.warning(f"Failed to read search cache for {query}: {e}")
            cache_file.unlink(missing_ok=True)
            search_cache_index.pop(cache_key, None)

    logger.debug(f"Search cache miss for query: {query}")

    if search_provider == "disabled":
        logger.info("Search is disabled via admin settings")
        return []

    provider_chain = _build_provider_chain(search_provider)

    results: List[dict] = []
    for provider_name in provider_chain:
        for attempt in range(2):
            try:
                logger.info(f"Attempting {provider_name} search (attempt {attempt + 1})")
                results = _call_provider(provider_name, query, count, time_filter)
                if results:
                    logger.info(f"{provider_name} search succeeded with {len(results)} results")
                    break
            except (NetworkError, ParseError, RateLimitError) as e:
                error_logger.error(f"{provider_name} search error (attempt {attempt + 1}): {e}")
            except Exception as e:
                error_logger.error(f"Unexpected error during {provider_name} search (attempt {attempt + 1}): {e}")
        if results:
            break

    success = bool(results)
    _record_query(query, success, cache_hit=False)

    if success:
        results = rank_search_results(query, results)
        try:
            expiry = datetime.now() + _cache_duration_for_query(query)
            cache_data = {
                "timestamp": datetime.now().isoformat(),
                "expiry": expiry.isoformat(),
                "data": results,
            }
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(cache_data, f)
            search_cache_index[cache_key] = datetime.now()
            cleanup_cache(SEARCH_CACHE_DIR, search_cache_index, timedelta(hours=1))
        except Exception as e:
            logger.warning(f"Failed to write search cache for {query}: {e}")

    if not success:
        logger.error(f"All search providers failed for query: {query}")

    return results


# ----------------------------------------------------------------------
# 缓存失效
# ----------------------------------------------------------------------
def invalidate_search_cache(query: Optional[str] = None) -> None:
    """使缓存的搜索结果失效。None 清除全部，否则只清除指定查询。"""
    if query is None:
        for file in SEARCH_CACHE_DIR.glob("*.cache"):
            try:
                file.unlink(missing_ok=True)
            except Exception as e:
                error_logger.warning(f"Failed to delete cache file {file}: {e}")
        search_cache_index.clear()
        logger.info("All search cache entries have been cleared.")
    else:
        # 匹配写入路径存储的键：searxng_search_results 会将
        # 调用者的默认 count 替换为配置的 _get_result_count()
        # （默认 5），因此硬编码的 "|10|None" 从未匹配过真实条目。
        cache_key = generate_cache_key(f"{query}|{_get_result_count()}|None")
        cache_file = SEARCH_CACHE_DIR / f"{cache_key}.cache"
        if cache_file.exists():
            try:
                cache_file.unlink(missing_ok=True)
                search_cache_index.pop(cache_key, None)
                logger.info(f"Cache entry for query '{query}' has been invalidated.")
            except Exception as e:
                error_logger.warning(f"Failed to delete cache file for query '{query}': {e}")
        else:
            logger.info(f"No cache entry found for query '{query}'.")


# ----------------------------------------------------------------------
# 全面网页搜索（含高级过滤）
# ----------------------------------------------------------------------
def comprehensive_web_search(
    query: str,
    max_pages: int = 3,
    max_workers: int = 4,
    time_filter: str = None,
    domain_whitelist: Optional[Set[str]] = None,
    domain_blacklist: Optional[Set[str]] = None,
    content_type: Optional[str] = None,
    language: Optional[str] = None,
    min_content_length: int = 0,
    return_sources: bool = False,
):
    """执行全面网页搜索，包含内容抓取和高级过滤。"""
    logger.info(f"Starting comprehensive search for: {query}")
    if time_filter:
        logger.info(f"Applying time filter: {time_filter}")

    settings = _get_search_settings()
    search_provider = settings.get("search_provider", "searxng")
    result_count = _get_result_count()

    if search_provider == "disabled":
        logger.info("Search is disabled via admin settings")
        msg = "Web search is disabled by the administrator."
        return (msg, []) if return_sources else msg

    # 使用配置的结果数量（至少 max_pages 用于内容抓取）
    fetch_count = max(result_count, max_pages)

    provider_chain = _build_provider_chain(search_provider)

    search_results = []
    provider_attempts = {}
    for provider_name in provider_chain:
        last_err = None
        empty = False
        for attempt in range(2):
            try:
                search_results = _call_provider(provider_name, query, fetch_count, time_filter)
                if search_results:
                    provider_attempts[provider_name] = f"ok ({len(search_results)})"
                    logger.info(f"Comprehensive search: {provider_name} returned {len(search_results)} results")
                    break
                empty = True
            except Exception as e:
                last_err = e
                logger.warning(f"Comprehensive search: {provider_name} attempt {attempt + 1} failed: {e}")
        if search_results:
            break
        if last_err is not None:
            provider_attempts[provider_name] = f"error: {last_err}"
        elif empty:
            provider_attempts[provider_name] = "empty"

    if not search_results:
        tally = ", ".join(f"{p}:{r}" for p, r in provider_attempts.items()) or "no providers configured"
        any_errors = any(r.startswith("error") for r in provider_attempts.values())
        if any_errors:
            msg = f"Web search failed — all providers errored or returned empty. Tried: {tally}"
        else:
            msg = (
                f"No search results found. Tried: {tally}. "
                "All providers returned empty — possibly a niche query or upstream rate-limiting; "
                "rephrasing or using the browser tool for a specific URL may help."
            )
        logger.warning(msg)
        return (msg, []) if return_sources else msg

    search_results = rank_search_results(query, search_results)

    # URL 过滤辅助函数
    def url_passes_filters(url: str) -> bool:
        try:
            netloc = urlparse(url).netloc.lower()
        except Exception:
            return False
        if domain_whitelist is not None and netloc not in domain_whitelist:
            return False
        if domain_blacklist is not None and netloc in domain_blacklist:
            return False
        if content_type:
            ct = content_type.lower()
            if ct == "article":
                if not any(k in url.lower() for k in ("article", "blog", "news", "post")):
                    return False
            elif ct == "forum":
                if not any(k in url.lower() for k in ("forum", "discussion", "thread", "topic")):
                    return False
            elif ct == "academic":
                if not any(k in url.lower() for k in ("pdf", "doi", "scholar", "arxiv", "journal", "research")):
                    return False
        if language:
            lang_pat = language.lower()
            if not (f"/{lang_pat}/" in url.lower() or f"?lang={lang_pat}" in url.lower() or f"&lang={lang_pat}" in url.lower()):
                return False
        return True

    filtered_urls = [r["url"] for r in search_results[:max_pages] if url_passes_filters(r["url"])]
    if not filtered_urls:
        logger.warning("All URLs filtered out by advanced criteria")
        msg = "No suitable results after applying filters."
        return (msg, []) if return_sources else msg

    # 在抓取内容前构建前端来源列表
    _source_list = [
        {"url": r.get("url", ""), "title": r.get("title", "")}
        for r in search_results if r.get("url")
    ]

    # 将每个 URL 映射到来源列表中的索引号，以便抓取后的内容
    # 块可以用与模型引用的相同索引进行标注。
    _url_index = {
        r["url"]: i for i, r in enumerate(search_results, 1) if r.get("url")
    }

    # 并行抓取内容
    fetched_content = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_url = {
            executor.submit(fetch_webpage_content, url, 8, retry_attempt=0): url
            for url in filtered_urls
        }
        for future in as_completed(future_to_url):
            url = future_to_url[future]
            try:
                result = future.result()
                if result["success"] and result["content"] and len(result["content"]) >= min_content_length:
                    # 记住此抓取对应哪个来源：重定向
                    # 可能改变 result["url"]，且完成顺序是
                    # 任意的，因此后续无法重新计算块标签。
                    result["source_index"] = _url_index.get(url)
                    fetched_content.append(result)
            except Exception as e:
                logger.error(f"Exception while fetching {url}: {str(e)}")

    logger.info(f"Successfully fetched content from {len(fetched_content)} pages")

    # 格式化结果
    output_parts = []

    if search_results:
        output_parts.append("```sources")
        for i, result in enumerate(search_results, 1):
            output_parts.append(f"[{i}] {result['title']}")
            output_parts.append(f"    {result['url']}")
            if result.get("age"):
                output_parts.append(f"    {result['age']}")
        output_parts.append("```")
        output_parts.append("")

    output_parts.append("=" * 70)
    output_parts.append("WEB SEARCH RESULTS AND FETCHED CONTENT")
    output_parts.append(f"Query: {query}")
    output_parts.append(f"Searched {len(search_results)} results, fetched {len(fetched_content)} pages")
    output_parts.append("=" * 70)
    output_parts.append("")

    output_parts.append("SEARCH RESULTS SUMMARY:")
    output_parts.append("-" * 50)
    for i, result in enumerate(search_results, 1):
        output_parts.append(f"\n[{i}] {result['title']}")
        output_parts.append(f"    URL: {result['url']}")
        output_parts.append(f"    Snippet: {result['snippet'][:200]}...")
        if result.get("age"):
            output_parts.append(f"    Age: {result['age']}")

    if fetched_content:
        output_parts.append("\n" + "=" * 70)
        output_parts.append("FETCHED PAGE CONTENT:")
        output_parts.append("-" * 50)

        # 按来源顺序输出块，使用与来源列表相同的索引编号，
        # 因此 [CONTENT 2] 确实来自来源 [2] 的内容。
        # 在此之前，块按抓取完成顺序编号为 1..N，
        # 既与来源列表不匹配，不同运行顺序也不一致。
        fetched_content.sort(key=lambda c: c.get("source_index") or len(search_results) + 1)
        for content in fetched_content:
            _idx = content.get("source_index")
            _label = f"[CONTENT {_idx}]" if _idx else "[CONTENT]"
            output_parts.append(f"\n{_label} From: {content['url']}")
            output_parts.append(f"Title: {content['title']}")
            output_parts.append("-" * 30)

            text = content["content"][:3000]
            if len(content["content"]) > 3000:
                text += "... [truncated]"
            output_parts.append(text)

            key_points = extract_key_points(content["content"])
            if key_points:
                output_parts.append("\nKey Points:")
                for pt in key_points[:5]:
                    output_parts.append(f"- {pt}")

            tldr = get_tldr(content["content"])
            if tldr:
                output_parts.append("\nTL;DR:")
                output_parts.append(tldr)

            quotes = extract_quotes(content["content"])
            if quotes:
                output_parts.append("\nImportant Quotes:")
                for q in quotes[:3]:
                    output_parts.append(f"\u201c{q}\u201d")

            stats = extract_statistics(content["content"])
            if stats:
                output_parts.append("\nData / Statistics:")
                for s in stats[:5]:
                    output_parts.append(f"- {s}")

            output_parts.append("")

    output_parts.append("=" * 70)
    output_parts.append("END OF WEB SEARCH RESULTS")
    output_parts.append("=" * 70)

    instructions = (
        "\n\nIMPORTANT INSTRUCTIONS:\n"
        "1. Use the above web search results and fetched content to answer the user's question\n"
        "2. Prioritize information from the FETCHED PAGE CONTENT section as it contains actual page data\n"
        "3. Cross-reference multiple sources when possible\n"
        "4. If the information is time-sensitive, pay attention to the age of the results\n"
        "5. Be explicit if the search results don't contain sufficient information to fully answer the question"
    )
    output_parts.append(instructions)

    result = "\n".join(output_parts)
    return (result, _source_list) if return_sources else result
