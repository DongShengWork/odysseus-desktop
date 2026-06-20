# src/chat_processor.py — 聊天处理器
import logging
import math
import re
import time
from collections import Counter
from typing import List, Dict, Any, Optional, Tuple
from src.chat_helpers import extract_urls
from src.youtube_handler import is_youtube_url
from src.search import comprehensive_web_search, fetch_webpage_content
from src.prompt_security import UNTRUSTED_CONTEXT_POLICY, untrusted_context_message

logger = logging.getLogger(__name__)

# ── 停用词 & 分词器 ──

_STOPWORDS = frozenset(
    "a an the is am are was were be been being have has had do does did "
    "will would shall should can could may might must need ought dare "
    "i me my mine we us our ours you your yours he him his she her hers "
    "it its they them their theirs this that these those "
    "and but or nor not no so if then else than too also very "
    "in on at to for of by with from up out about into over after "
    "what when where which who whom how why all each every some any "
    "just very really actually like well also still already even "
    "oh ok okay yes yeah hey hi hello thanks thank please sorry "
    "much more most own other another such only same here there "
    "because while during before until since through between both "
    "few many several some none nothing something anything everything "
    "get got make made go going went been come came take took "
    "know think want let say tell give see look find way thing "
    "don doesn didn won wouldn couldn shouldn wasn weren isn aren haven hasn "
    "don't doesn't didn't won't wouldn't couldn't shouldn't "
    "it's i'm i've i'll i'd you're you've you'll he's she's we're we've they're they've "
    "that's there's here's what's who's how's let's can't".split()
)

def _content_tokens(text: str) -> list:
    """提取有意义的内容词：无停用词，最少 3 个字符，小写。"""
    words = re.findall(r'[a-z0-9]+(?:[-_][a-z0-9]+)*', text.lower())
    return [w for w in words if len(w) >= 3 and w not in _STOPWORDS]


class ChatProcessor:
    def __init__(self, memory_manager, personal_docs_manager, memory_vector=None, skills_manager=None):
        self.memory_manager = memory_manager
        self.personal_docs_manager = personal_docs_manager
        self.memory_vector = memory_vector
        self.skills_manager = skills_manager

    # RAG 结果注入的最低相似度分数
    RAG_SIMILARITY_THRESHOLD = 0.35

    def _hybrid_retrieve(self, message: str, mem_entries: list, k: int = 5) -> list:
        """检索与消息相关的记忆。

        使用 BM25 风格的关键词评分 + 可选向量相似度。
        时效性仅作为打破平局的依据，绝不是主要信号。
        """
        if not mem_entries or not message.strip():
            return []

        now = time.time()
        query_tokens = _content_tokens(message)

        # 如果查询没有有意义的词元，完全跳过关键词检索
        if not query_tokens:
            # 回退到仅向量检索（如果可用）
            if not (self.memory_vector and self.memory_vector.healthy):
                return []

        # ── 从记忆语料库构建 IDF ──
        N = len(mem_entries)
        doc_freq = Counter()  # token -> how many memories contain it
        mem_token_cache = {}  # mem_id -> set of content tokens
        for mem in mem_entries:
            toks = set(_content_tokens(mem["text"]))
            mem_token_cache[mem["id"]] = toks
            for t in toks:
                doc_freq[t] += 1

        def _bm25_score(query_toks, mem_id):
            """查询与记忆之间的 BM25 风格评分。"""
            mem_toks = mem_token_cache.get(mem_id, set())
            if not mem_toks or not query_toks:
                return 0.0
            score = 0.0
            mem_len = len(mem_toks)
            avg_len = max(sum(len(v) for v in mem_token_cache.values()) / N, 1)
            k1, b = 1.5, 0.75
            for qt in query_toks:
                if qt not in mem_toks:
                    continue
                df = doc_freq.get(qt, 0)
                idf = math.log((N - df + 0.5) / (df + 0.5) + 1)
                tf = 1  # binary presence (memory entries are short)
                tf_norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * mem_len / avg_len))
                score += idf * tf_norm
            return score

        # ── Score all candidates ──
        has_vector = self.memory_vector and self.memory_vector.healthy
        vector_scores = {}

        if has_vector:
            results = self.memory_vector.search(message, k=min(k * 3, 20))
            mem_by_id = {m["id"]: m for m in mem_entries}
            for r in results:
                if r["memory_id"] in mem_by_id:
                    vector_scores[r["memory_id"]] = max(r["score"], 0.0)

        scored = []
        for mem in mem_entries:
            mid = mem["id"]
            vs = vector_scores.get(mid, 0.0)
            kw = _bm25_score(query_tokens, mid)

            # Normalize BM25 to roughly 0-1 range (cap at a reasonable max)
            kw_norm = min(kw / 6.0, 1.0) if kw > 0 else 0.0

            # Category-aware boost for identity/contact queries
            category = mem.get("category", "fact")
            msg_lower = message.lower()
            mem_lower = mem["text"].lower()
            cat_boost = 1.0
            if any(w in msg_lower for w in ["name", "who am i", "my name"]):
                if category == "identity" or any(w in mem_lower for w in ["name is", "i am", "called"]):
                    cat_boost = 1.4
            elif any(w in msg_lower for w in ["phone", "email", "address", "contact"]):
                if category == "contact" or "@" in mem_lower:
                    cat_boost = 1.3
            elif any(w in msg_lower for w in ["like", "prefer", "favorite"]):
                if category == "preference":
                    cat_boost = 1.2

            kw_norm = min(kw_norm * cat_boost, 1.0)

            # Recency — tiebreaker only (max 5% contribution)
            ts = mem.get("timestamp", 0)
            days_old = max((now - ts) / 86400, 0)
            recency = 1.0 / (1.0 + days_old * 0.05)

            # Gate: need real relevance, not just recency
            if has_vector:
                if vs < 0.20 and kw_norm < 0.08:
                    continue
                final = (0.55 * vs) + (0.40 * kw_norm) + (0.05 * recency)
            else:
                if kw_norm < 0.08:
                    continue
                final = (0.95 * kw_norm) + (0.05 * recency)

            if final > 0.12:
                scored.append((final, mem))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [mem for _, mem in scored[:k]]

    def build_context_preface(
        self,
        message: str,
        session: Any,
        use_web: bool = False,
        use_rag: bool = True,
        use_memory: bool = True,
        time_filter: Optional[str] = None,
        preset_system_prompt: Optional[str] = None,
        owner: Optional[str] = None,
        character_name: Optional[str] = None,
        agent_mode: bool = False,
        incognito: bool = False,
        use_skills: bool = True,
    ) -> Tuple[List[Dict[str, str]], List[Dict[str, Any]], List[Dict[str, str]]]:
        """构建 LLM 调用的上下文前导。

        返回：
            (前导消息, rag_sources 列表) 的元组

        关于 KV 缓存友好性的说明：此处组装的 ``system`` 角色消息稍后
        会被连接成单个系统消息，并作为负载的最前面发送
        （参见 ``llm_core`` 的“合并系统消息”步骤）。本地 OpenAI 兼容
        后端（llama.cpp / LM Studio）基于字节相同的词元前缀来键控
        KV 缓存，因此任何在轮次之间变化的内容——时间戳、检索片段、
        每轮计数——都不能在此处折叠到系统消息中。这些内容应放在
        单独的 ``user``/上下文消息中，追加到数组末尾（参见
        ``build_chat_context`` 中的 ``current_datetime_context_message``
        和 ``untrusted_context_message`` 调用方），这样可保持静态系统
        前缀在同一会话的不同轮次之间字节相同，让后端复用其缓存前缀。
        """
        preface = []
        rag_sources = []

        # Add preset system prompt if specified
        if preset_system_prompt:
            preface.append({
                "role": "system",
                "content": preset_system_prompt
            })
        preface.append({
            "role": "system",
            "content": UNTRUSTED_CONTEXT_POLICY,
        })

        # Memory: pinned (always included) + extended (RAG-retrieved when relevant)
        self._last_used_memories = []  # track what was injected
        if use_memory:
            mem_entries = self.memory_manager.load(owner=owner)

            pinned = [m for m in mem_entries if m.get("pinned")]
            extended = [m for m in mem_entries if not m.get("pinned")]

            _used_ids: list = []
            if pinned:
                pinned_text = "\n- ".join([m["text"] for m in pinned])
                preface.append(untrusted_context_message(
                    "saved memory: pinned user facts",
                    f"Core facts about the user:\n- {pinned_text}",
                ))
                for m in pinned:
                    self._last_used_memories.append({"text": m["text"], "category": m.get("category", "fact"), "type": "pinned"})
                    if m.get("id"):
                        _used_ids.append(m["id"])

            if extended:
                relevant = self._hybrid_retrieve(message, extended, k=3)
                if relevant:
                    ext_text = "\n".join([f"- {m['text']}" for m in relevant])
                    preface.append(untrusted_context_message(
                        "saved memory: retrieved context",
                        (
                            "Memory context. Do not reference unless the user asks "
                            f"about these topics.\n{ext_text}"
                        ),
                    ))
                    for m in relevant:
                        self._last_used_memories.append({"text": m["text"], "category": m.get("category", "fact"), "type": "recalled"})
                        if m.get("id"):
                            _used_ids.append(m["id"])

            # Bump usage counters for the memories that were actually injected.
            if _used_ids and hasattr(self.memory_manager, "increment_uses"):
                try:
                    self.memory_manager.increment_uses(_used_ids)
                except Exception as _e:
                    logger.warning("Failed to increment memory uses: %s", _e)

            # (skills index injection moved out — see below; only fires in
            # agent mode so chat mode and incognito stay clean.)

        # RAG: search if enabled and rag_manager available, inject only above threshold
        if use_rag:
            try:
                rag_manager = getattr(self.personal_docs_manager, 'rag_manager', None)
                if rag_manager:
                    results = rag_manager.search(message, k=5, owner=owner)
                    # Filter by similarity threshold
                    relevant = [r for r in results if r.get("similarity", 0) >= self.RAG_SIMILARITY_THRESHOLD]
                    if relevant:
                        logger.info(f"RAG: {len(relevant)}/{len(results)} results above threshold {self.RAG_SIMILARITY_THRESHOLD}")
                        rag_sources = [
                            {
                                "filename": r["metadata"].get("filename", r["metadata"].get("source", "unknown")),
                                "snippet": r["document"][:200],
                                "similarity": round(r.get("similarity", 0), 3)
                            }
                            for r in relevant
                        ]
                        rag_content = "Relevant documents:\n\n" + "\n\n---\n\n".join(
                            f"[{s['filename']}]\n{r['document']}" for s, r in zip(rag_sources, relevant)
                        )
                        if len(rag_content) > 10000:
                            rag_content = rag_content[:10000] + "\n[Truncated]"
                        preface.append(untrusted_context_message("retrieved documents", rag_content))
            except Exception as e:
                logger.warning(f"RAG retrieval failed: {e}")

        # Add web search if enabled
        web_sources = []
        if use_web:
            try:
                web_context, web_sources = comprehensive_web_search(
                    message, time_filter=time_filter, return_sources=True
                )
                preface.append(untrusted_context_message("web search results", web_context))
            except Exception as e:
                logger.error(f"Web search failed: {e}")
                preface.append({"role": "system", "content": "Web search encountered an error and could not retrieve results."})

        # Process non-YouTube URLs in message (YouTube handled by preprocess_message)
        # Skip auto-fetch for long pastes (the user already pasted the content —
        # fetching every embedded link buries the actual question under
        # hundreds of KB of duplicate page HTML and confuses the model) or for
        # link-heavy pastes (>3 URLs typically means it's a boilerplate-laden
        # blog post, not a "summarize this URL" request).
        urls = extract_urls(message)
        non_yt_urls = [u for u in urls if not is_youtube_url(u)]
        skip_url_fetch = len(message) > 2000 or len(non_yt_urls) > 3
        if not skip_url_fetch:
            for url in non_yt_urls:
                result = fetch_webpage_content(url)
                if result.get('success'):
                    content = result.get('content', '')[:10000]
                    preface.append(untrusted_context_message(
                        f"web page: {url}",
                        f"Content from {url}:\n\n{content}",
                    ))

        # Skills index — progressive disclosure. Only injected when the
        # model has the `manage_skills` tool available (agent_mode), and
        # never in incognito mode (the user has explicitly opted out of
        # context retention this turn). In plain chat mode the model can't
        # call the tool anyway, so the index would be noise.
        if agent_mode and not incognito and use_skills and self.skills_manager:
            try:
                idx = self.skills_manager.index_for(owner=owner)
            except Exception as e:
                logger.debug(f"Skills index unavailable: {e}")
                idx = []
            if idx:
                by_cat: Dict[str, list] = {}
                for s in idx:
                    by_cat.setdefault(s.get("category") or "general", []).append(s)
                lines = ["[Available skills — call manage_skills(action='view', name='...') to load one when relevant]"]
                for cat in sorted(by_cat):
                    lines.append(f"  {cat}:")
                    for s in sorted(by_cat[cat], key=lambda x: x["name"]):
                        desc = s.get("description") or ""
                        lines.append(f"    - {s['name']}: {desc}" if desc else f"    - {s['name']}")
                preface.append(untrusted_context_message("available skills index", "\n".join(lines)))

        return preface, rag_sources, web_sources
