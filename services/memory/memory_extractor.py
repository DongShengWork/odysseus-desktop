"""
memory_extractor.py

从聊天对话中自动提取事实的后台任务。
每次 LLM 回复后，本模块将最近的几条消息发送给 LLM，
要求其提取值得记忆的事实，然后同时存储到 memory.json
和 FAISS 向量索引中。

定期通过 LLM 审核所有记忆以合并重复项、
改写模糊条目并删除无用信息。
"""

import hashlib
import json
import logging
import os
import re
from typing import Optional

logger = logging.getLogger(__name__)


def _tidy_state_path(memory_manager) -> str:
    """Sidecar JSON next to memory.json that remembers the fingerprint of
    the last successfully-audited state per owner. Lets the audit short-
    circuit when nothing has changed since the previous tidy — running
    the LLM again on an already-clean list was wasting 30-120s per call
    and occasionally timing out on the second pass."""
    return os.path.join(os.path.dirname(memory_manager.memory_file), "memory_tidy_state.json")


def _fingerprint_entries(entries) -> str:
    """某 owner 记忆的稳定哈希 — 与顺序无关，仅取决于
    id+text+category。任何添加/编辑/删除都会导致失效。"""
    items = sorted(
        (str(e.get("id", "")), e.get("text", ""), e.get("category", ""))
        for e in _memory_dicts(entries)
    )
    h = hashlib.sha256()
    for triple in items:
        h.update(("\x1f".join(triple) + "\x1e").encode("utf-8"))
    return h.hexdigest()


def _memory_dicts(entries):
    for entry in entries or []:
        if isinstance(entry, dict):
            yield entry


def _load_tidy_state(memory_manager) -> dict:
    path = _tidy_state_path(memory_manager)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_tidy_state(memory_manager, owner: Optional[str], fingerprint: str) -> None:
    path = _tidy_state_path(memory_manager)
    state = _load_tidy_state(memory_manager)
    state[owner or ""] = {"fingerprint": fingerprint}
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except OSError as e:
        logger.warning(f"Could not persist tidy fingerprint: {e}")

EXTRACT_SYSTEM_PROMPT = (
    "You are a memory extraction assistant. Analyze the conversation and extract ONLY "
    "durable personal facts about the user that would be useful across many future conversations.\n\n"
    "Good examples: name, job title, city, family members, long-term projects, strong preferences.\n"
    "Bad examples: what they asked about today, temporary moods, generic statements, "
    "things the assistant said, one-off tasks, opinions on the current topic.\n\n"
    "Rules:\n"
    "- MAX 2 facts per conversation — only the most important\n"
    "- Only extract facts the USER stated or clearly implied\n"
    "- Each fact must be a single short sentence (under 15 words)\n"
    "- If a fact is similar to something likely already known, skip it\n"
    "- If nothing durable was revealed, return []\n\n"
    "Return a JSON array of objects with 'text' and 'category' fields.\n"
    "Categories: 'identity', 'preference', 'fact', 'contact', 'project', 'goal'\n\n"
    "Return ONLY valid JSON, no markdown fences."
)

# 每次提取包含多少条最近消息
CONTEXT_WINDOW = 6

AUDIT_SYSTEM_PROMPT = (
    "You are a memory database curator. Be CONSERVATIVE: remove only TRUE "
    "duplicates and clearly useless entries. Every distinct fact must survive. "
    "When in doubt, KEEP the entry. Return the cleaned list.\n\n"
    "Rules:\n"
    "1. MERGE only entries that state the SAME fact in different words. If you "
    "are not sure two entries are the same fact, KEEP BOTH.\n"
    "   Merge: 'User's name is Sam' + 'The user is called Sam' -> one.\n"
    "   Do NOT merge related-but-distinct facts: 'Likes Python' and 'Uses "
    "Python at work' are DIFFERENT — keep both.\n"
    "2. REMOVE only entries that are genuinely worthless: about what the AI did "
    "(not the user), empty, or meaningless. Do NOT drop a real fact just "
    "because it seems minor or niche.\n"
    "3. Keep the original wording. Only lightly trim obvious redundancy — do "
    "NOT aggressively rewrite or shorten.\n"
    "4. Preserve the 'id' of the entry you keep when merging.\n"
    "5. Never invent facts. When unsure, KEEP.\n\n"
    "Return a JSON array of objects with fields: id, text, category.\n"
    "Return ONLY valid JSON, no markdown fences."
)

AUDIT_INTERVAL = 5  # 每新增 N 条记忆后触发审核
_extractions_since_audit = 0


def _message_text(message) -> str:
    content = getattr(message, "content", None)
    if content is None and isinstance(message, dict):
        content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(item))
        return " ".join(p for p in parts if p).strip()
    return ""


def _message_role(message) -> str:
    role = getattr(message, "role", None)
    if role is None and isinstance(message, dict):
        role = message.get("role")
    return str(role or "").lower()


def _clean_memory_value(value: str, max_len: int = 80) -> str:
    value = re.sub(r"\s+", " ", value or "").strip(" .,!?:;\"'`“”‘’")
    value = re.sub(r"^(?:the|a|an)\s+", "", value, flags=re.I)
    if not value or len(value) > max_len:
        return ""
    if re.search(r"https?://|@|[{}<>]", value):
        return ""
    return value


def _fallback_memory_candidates(messages) -> list[dict]:
    """不依赖 LLM 提取明显的持久化事实。

    此方法范围刻意缩小。LLM 仍是主要提取器，但
    简单的身份/偏好/目标陈述不应因为后台模型
    认为它们过于对话化而无声地消失。
    """
    candidates = []
    seen = set()

    def add(text: str, category: str):
        text = _clean_memory_value(text, 120)
        if not text:
            return
        key = text.lower()
        if key in seen:
            return
        seen.add(key)
        candidates.append({"text": text, "category": category})

    for msg in messages:
        if _message_role(msg) != "user":
            continue
        text = _message_text(msg)
        if not text:
            continue

        m = re.search(r"\bmy name is\s+([A-Za-z][A-Za-z0-9 .'\-]{1,50})\b", text, re.I)
        if m:
            name = _clean_memory_value(m.group(1), 50)
            if name:
                add(f"User's name is {name}.", "identity")

        m = re.search(r"\bcall me\s+([A-Za-z][A-Za-z0-9 .'\-]{1,50})\b", text, re.I)
        if m:
            name = _clean_memory_value(m.group(1), 50)
            if name:
                add(f"User wants to be called {name}.", "identity")

        m = re.search(r"\bi (?:live in|am from|'m from)\s+([^.!?\n]{2,80})", text, re.I)
        if m:
            place = _clean_memory_value(m.group(1), 80)
            if place:
                add(f"User lives in {place}.", "identity")

        m = re.search(r"\bi (prefer|like|love|hate|do not like|don't like)\s+([^.!?\n]{4,100})", text, re.I)
        if m:
            preference = _clean_memory_value(m.group(2), 100)
            if preference:
                # 同样的模式会匹配喜欢和讨厌；保持存储的
                # 情感原文而不是将每个匹配都记录为
                # 偏好（"I hate cilantro" 不能变成 "User prefers
                # cilantro"）。
                verb = m.group(1).lower()
                if verb in ("hate", "do not like", "don't like"):
                    add(f"User dislikes {preference}.", "preference")
                else:
                    add(f"User prefers {preference}.", "preference")

        m = re.search(
            r"\bi (?:(?:want|would like|plan|hope) to|wanna) "
            r"(?:go|travel|move|visit) to\s+([^.!?\n]{2,80})",
            text,
            re.I,
        )
        if m:
            destination = _clean_memory_value(m.group(1), 80)
            if destination:
                add(f"User wants to visit {destination}.", "goal")

    return candidates[:2]


def _is_text_duplicate(new_text: str, existing: list, threshold: float = 0.6) -> bool:
    """检查 new_text 是否与任何现有记忆过于相似（Jaccard 相似度）。"""
    new_tokens = set(new_text.lower().split())
    if not new_tokens:
        return False
    for entry in _memory_dicts(existing):
        old_tokens = set(entry.get("text", "").lower().split())
        if not old_tokens:
            continue
        intersection = new_tokens & old_tokens
        union = new_tokens | old_tokens
        if len(intersection) / len(union) >= threshold:
            return True
    return False


def _parse_extraction_json(raw: str) -> list:
    """Parse the extraction LLM's reply into a list of facts, tolerating
    reasoning-model noise.

    模型会在 JSON 数组周围输出 <think>…</think>（有时还有散文序言或
    ```json 代码块）；不剥离这些，json.loads
    会失败且运行静默地 yield "0 candidates"。纯字符串 -> 列表（无
    LLM/网络）；解析失败返回 [] 而不是抛出异常。
    """
    text = (raw or "").strip()
    try:
        from src.text_helpers import strip_think as _strip_think
        text = _strip_think(text, prose=True, prompt_echo=True).strip()
    except Exception:
        pass
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    # JSON 仍可能嵌入在周围的评论文本中（前导散文或
    # 尾随的备注如 "[...] Done!"）— 当两者都存在时，从第一个 '[' 截取到最后一个
    # ']'。无条件截取：以 '[' 开头的回复仍可能带有尾随评注，
    # 会破坏 json.loads。
    _start = text.find("[")
    _end = text.rfind("]")
    if 0 <= _start < _end:
        text = text[_start : _end + 1]

    try:
        facts = json.loads(text)
    except json.JSONDecodeError:
        logger.debug("Memory extraction returned non-JSON: %r", (raw or "")[:120])
        return []
    except Exception:
        logger.debug("Memory extraction returned non-JSON: %r", (raw or "")[:120])
        return []
    return facts if isinstance(facts, list) else []


async def extract_and_store(
    session,
    memory_manager,
    memory_vector,
    endpoint_url: str,
    model: str,
    headers: Optional[dict] = None,
):
    """从最近对话中提取事实并存储。

    设计为后台任务运行（asyncio.create_task）。
    错误被记录，永不抛出。
    """
    if not endpoint_url or not model:
        logger.debug("[memory-extract] No model or URL provided, skipping")
        return

    try:
        from src.llm_core import llm_call_async

        # 从 session 获取最近 N 条消息
        messages = session.get_context_messages()
        recent = messages[-CONTEXT_WINDOW:] if len(messages) > CONTEXT_WINDOW else messages

        if len(recent) < 2:
            return  # 至少需要一条用户消息和一条助手回复

        # 从消息中移除媒体内容（图片/音频）— 后台记忆提取
        # 只需要文本。VL 生成的描述已在消息的文本内容中。
        # 这避免了向非视觉模型发送图片 token，并防止意外触发
        # "视觉接地"。
        stripped_recent = []
        for msg in recent:
            role = msg.get("role")
            content = msg.get("content", "")
            if isinstance(content, list):
                # 过滤掉非文本内容块
                text_only = [b for b in content if isinstance(b, dict) and b.get("type") == "text"]
                if not text_only and content:
                    continue
                content = text_only
            stripped_recent.append({"role": role, "content": content})

        if not stripped_recent:
            return

        fallback_facts = _fallback_memory_candidates(stripped_recent)

        # Flatten the window into a SINGLE user message instead of appending the
        # raw alternating role messages. Passed as raw chat messages, the model
        # treats the window as a conversation to CONTINUE rather than a transcript
        # to ANALYZE, so it reliably extracts nothing — typically returning `[]`
        # (and, depending on the input, sometimes an empty or <think>-only
        # completion when the window ends on an assistant turn). This was the real
        # 补全）。这就是 auto-memory 每次运行都记录 "0 candidates" 的真实
        # one "analyze this transcript, return the JSON array" user message makes
        # the model actually extract. Controlled repro on this model: 0/6 trials
        # with the old structure vs 6/6 with this one. The skill extractor flattens
        # for the same reason.
        def _flatten_msg(m):
            c = m.get("content", "")
            if isinstance(c, list):
                c = " ".join(
                    b.get("text", "") for b in c
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            return f"{m.get('role', '?')}: {c}"

        transcript = "\n\n".join(_flatten_msg(m) for m in stripped_recent)
        extraction_messages = [
            {"role": "system", "content": EXTRACT_SYSTEM_PROMPT},
            {"role": "user", "content": (
                "Conversation to analyze:\n\n" + transcript
                + "\n\nReturn the JSON array of durable facts now (or [] if none)."
            )},
        ]

        facts = []
        try:
            raw = await llm_call_async(
                endpoint_url,
                model,
                extraction_messages,
                temperature=0.1,
                # 推理模型在输出 JSON 之前将大部分预算
                # 花在 <think> 令牌上，因此旧的 500 上限会在
                # 任何 JSON 出现之前截断响应 → 每次运行都记录 "0 candidates"。审计
                # 路径遇到了同样的障碍并提升到 16384；提取的
                # 输出（一个简短的事实列表）体积很小，所以给定思考空间后
                # 慷慨的上限就够了。
                max_tokens=4096,
                headers=headers,
            )

            # 解析 JSON，容忍推理模型的噪声（<think> 块、
            # ```json 围栏、以及前后评论文本）。参见
            # _parse_extraction_json — 返回 [] 而不是抛出异常。
            facts = _parse_extraction_json(raw)
        except Exception as e:
            logger.warning(f"LLM memory extraction failed; using fallback candidates if available: {e}")

        if not isinstance(facts, list):
            facts = []

        if fallback_facts:
            facts = list(facts) + fallback_facts

        if not facts:
            logger.info("Auto memory extraction ran: 0 candidates")
            return

        # 从 session 获取 owner
        _owner = getattr(session, 'owner', None)

        existing = memory_manager.load_all()
        added = 0

        for fact in facts:
            if isinstance(fact, str):
                fact_text = fact
                category = "fact"
            elif isinstance(fact, dict):
                fact_text = fact.get("text", "").strip()
                category = fact.get("category", "fact")
            else:
                continue

            if not fact_text or len(fact_text) < 5:
                continue

            # 去重：先检查向量相似度（快速），然后精确文本匹配。
            # 运行时的 嵌入/ChromaDB 失败（后端 OOM、模型被驱逐、
            # 远程端点宕机）不应中止整批处理 — 回退到
            # 下面的文本/模糊去重，而不是丢失此会话中提取的每条
            # 已验证事实。（`.healthy` 仅在初始化时设置，因此
            # 不会捕获后续发展的失败。）
            if memory_vector and memory_vector.healthy:
                try:
                    existing_id = memory_vector.find_similar(fact_text, threshold=0.72)
                except Exception as e:
                    logger.warning(f"Memory dedup (vector) unavailable, using text fallback: {e}")
                    existing_id = None
                if existing_id:
                    # owner 元数据，因此 find_similar 会返回另一个
                    # owner 元数据，因此 find_similar 会返回另一个
                    # tenant's memory. Only treat it as a duplicate when the
                    # match is this user's own (or a legacy unowned) memory —
                    # otherwise the user's freshly-extracted fact would be
                    # silently dropped. Mirror the owner predicate used by the
                    # text dedup below; cross-tenant/stale matches fall through.
                    _match = next((e for e in existing if e.get("id") == existing_id), None)
                    if _match is not None and (_match.get("owner") == _owner or _match.get("owner") is None):
                        logger.debug(f"Memory dedup (vector): '{fact_text[:50]}' matches {existing_id}")
                        continue

            # 文本去重兜底：精确匹配 + 模糊相似度
            user_existing = [e for e in existing if e.get("owner") == _owner or e.get("owner") is None] if _owner else existing
            if memory_manager.find_duplicates(fact_text, user_existing):
                continue
            # 模糊文本相似度检查（当向量索引不可用时捕获改写后的重复项）
            if _is_text_duplicate(fact_text, user_existing):
                logger.debug(f"Memory dedup (fuzzy): '{fact_text[:50]}' too similar to existing")
                continue

            entry = memory_manager.add_entry(fact_text, source="auto", category=category, owner=_owner)
            # 自动置顶身份事实（姓名、职位、位置）— 核心上下文
            if category == "identity":
                entry["pinned"] = True
            if hasattr(session, "session_id"):
                entry["session_id"] = session.session_id
            elif hasattr(session, "name"):
                entry["session_id"] = session.name

            existing.append(entry)

            # 添加到向量索引。JSON 存储（保存在下面）是可靠来源，
            # 且关键字路径仍然可以检索此条目，因此向量
            # 写入失败不得丢弃事实或中止剩余批次。
            if memory_vector and memory_vector.healthy:
                try:
                    memory_vector.add(entry["id"], fact_text)
                except Exception as e:
                    logger.warning(f"Memory vector add failed for {entry['id']}: {e}")

            added += 1

        if added > 0:
            memory_manager.save(existing)
            try:
                from src.event_bus import fire_event
                for _ in range(added):
                    fire_event("memory_added", _owner)
            except Exception:
                logger.debug("memory_added event dispatch failed", exc_info=True)
            logger.info(f"Auto-extracted {added} memories from session")

            global _extractions_since_audit
            _extractions_since_audit += added
            if _extractions_since_audit >= AUDIT_INTERVAL:
                _extractions_since_audit = 0
                logger.info("Audit threshold reached, running memory audit")
                await audit_memories(
                    memory_manager, memory_vector, endpoint_url, model, headers, owner=_owner
                )
        else:
            logger.info("Auto memory extraction ran: 0 added")

    except Exception as e:
        logger.error(f"Memory extraction failed: {e}")


async def audit_memories(
    memory_manager,
    memory_vector,
    endpoint_url: str,
    model: str,
    headers: Optional[dict] = None,
    owner: Optional[str] = None,
):
    """将所有记忆发送给 LLM 进行去重和合并。

    - 合并近似重复的条目
    - 将模糊条目改写为简洁
    - 删除垃圾/非个人条目
    - 之后重建向量索引

    可以手动调用，也可以由 extract_and_store 中的自动触发器调用。
    错误被记录，永不抛出。
    """
    try:
        from src.llm_core import llm_call_async

        existing = memory_manager.load(owner=owner)
        if not existing:
            logger.info("Memory audit: nothing to audit")
            return {"before": 0, "after": 0}

        before_count = len(existing)

        # 当这组记忆上次已被审核过且未发生变化时，
        # 完全跳过 LLM 调用 — 上一次整理已将它们置于干净状态。
        # 自那时起无任何变化。立即返回，让 UI 显示
        # "已经是干净的"，避免浪费 30-120 秒的 LLM 轮次。
        # 指纹包含 id+text+category；任何添加/编辑/删除
        # 会使指纹失效，审核会正常运行。
        current_fp = _fingerprint_entries(existing)
        last_state = _load_tidy_state(memory_manager).get(owner or "") or {}
        if last_state.get("fingerprint") == current_fp:
            logger.info("Memory audit: state unchanged since last tidy — skipping LLM")
            return {
                "before": before_count,
                "after": before_count,
                "already_tidy": True,
            }

        # 为 LLM 构建载荷：{id, text, category} 列表
        memory_payload = [
            {"id": m["id"], "text": m["text"], "category": m.get("category", "fact")}
            for m in existing
        ]

        audit_messages = [
            {"role": "system", "content": AUDIT_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(memory_payload, ensure_ascii=False)},
        ]

        raw = await llm_call_async(
            endpoint_url,
            model,
            audit_messages,
            temperature=0.1,
            # 16384（之前是 2000）：去重后的所有记忆列表可能很大，
            # 且推理模型会先花 token 思考 — 2000 会截断
            # JSON 导致永不变析（"bad_json"）。
            max_tokens=16384,
            headers=headers,
            # Bound the call so the Tidy whirlpool can't spin indefinitely on a
            # slow/large generation.
            timeout=120,
        )

        # 解析 JSON 列表，容忍推理模型噪声：<think> 块、
        # markdown 围栏、前导散文和尾随逗号。
        import re as _re
        text = (raw or "").strip()
        text = _re.sub(r'<think(?:ing)?>[\s\S]*?</think(?:ing)?>', '', text, flags=_re.I).strip()

        def _loads_list(s):
            if not s:
                return None
            for cand in (s, _re.sub(r',(\s*[}\]])', r'\1', s)):
                try:
                    v = json.loads(cand)
                    if isinstance(v, list):
                        return v
                except Exception:
                    continue
            return None

        cleaned = _loads_list(text)
        if cleaned is None:
            _m = _re.search(r'```(?:json)?\s*\n?([\s\S]*?)```', text)
            if _m:
                cleaned = _loads_list(_m.group(1).strip())
        if cleaned is None:
            _a, _b = text.find('['), text.rfind(']')
            if _a >= 0 and _b > _a:
                cleaned = _loads_list(text[_a:_b + 1])
        if cleaned is None:
            logger.error(f"Memory audit returned non-JSON: {text[:300]}")
            return {"before": before_count, "after": before_count, "error": "bad_json"}

        # 按 ID 构建原始条目查找表，以便保留元数据
        originals = {m["id"]: m for m in existing}

        final_entries = []
        for item in cleaned:
            if not isinstance(item, dict):
                continue
            mid = item.get("id", "")
            new_text = item.get("text", "").strip()
            if not new_text:
                continue

            if mid in originals:
                # 保留原始元数据，更新 text + category
                entry = originals[mid].copy()
                entry["text"] = new_text
                if item.get("category"):
                    entry["category"] = item["category"]
            else:
                # 未找到 ID — 跳过，避免虚构条目
                logger.debug(f"Audit returned unknown id {mid}, skipping")
                continue

            final_entries.append(entry)

        after_count = len(final_entries)

        # 灾难性过度删除的安全网。保守的整理
        # 不应在一次通过中清除一半以上的存储 — 如果模型
        # 返回的条目远少于传入的（过度合并、列表
        # 丢失/截断、或忽略了 id），将其视为误触发并
        # 不保存。宁可无操作，也比静默丢失记忆好。
        if before_count >= 8 and after_count < before_count * 0.5:
            logger.warning(
                f"Memory audit would cut {before_count} -> {after_count} "
                f"(>50% removed) — refusing as unsafe, keeping originals"
            )
            return {"before": before_count, "after": before_count, "error": "unsafe_removal"}

        # 将审核后的条目与其他用户的条目合并
        if owner:
            all_entries = memory_manager.load_all()
            audited_ids = {e["id"] for e in final_entries}
            other_entries = [e for e in all_entries if e.get("owner") != owner and (e.get("owner") is not None)]
            # 也保留不属于本次审核的旧条目
            for e in all_entries:
                if e.get("owner") is None and e["id"] not in audited_ids and e["id"] not in {o["id"] for o in other_entries}:
                    other_entries.append(e)
            saved_entries = final_entries + other_entries
        else:
            saved_entries = final_entries
        memory_manager.save(saved_entries)
        logger.info(
            f"Memory audit complete: {before_count} -> {after_count} entries "
            f"({before_count - after_count} removed/merged)"
        )

        # 从完整保存集重建向量索引，而非仅从此 owner 的
        # 分片 — 否则共享集合会丢失其他所有
        # owner 的条目，直到他们恰好运行自己的审计。
        if memory_vector and memory_vector.healthy:
            memory_vector.rebuild(saved_entries)

        # 持久化整理后的指纹，以便下一次调用在日志未被修改
        # 时短路返回。
        _save_tidy_state(memory_manager, owner, _fingerprint_entries(final_entries))

        return {"before": before_count, "after": after_count}

    except Exception as e:
        logger.error(f"Memory audit failed: {e}")
        return {"error": str(e)}
