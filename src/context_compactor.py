"""
context_compactor.py

当接近上下文窗口限制时，自动压缩对话历史。
通过同一个 LLM 总结较早的消息，保留关键上下文。
"""

import json
import logging
from typing import Any, Dict, List, Optional

from src.model_context import get_context_length, estimate_tokens
from src.llm_core import llm_call_async
from src.endpoint_resolver import resolve_endpoint
from core.models import ChatMessage

logger = logging.getLogger(__name__)


def _content_as_text(content: Any) -> str:
    """将消息的 content 展平为纯文本。

    Handles the three shapes that flow through history: a plain string, a
    multimodal list of content blocks (vision/image attachments), and None
    (assistant turns that carried only native tool_calls persist content as
    None). Returns "" for anything without text so callers can safely slice
    the result.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("text")
        )
    return ""


COMPACT_THRESHOLD = 0.85  # 在 85% 上下文窗口使用时触发压缩
SUMMARY_MAX_TOKENS = 1024
SMALL_CONTEXT_LIMIT = 8192  # 上下文 <= 此值的模型会进行激进裁剪

# Cursor 风格的自摘要提示 — 生成结构化、密集的摘要
SELF_SUMMARY_SYSTEM_PROMPT = """You are summarizing a conversation to preserve context after compaction. Produce a structured summary that lets the conversation continue seamlessly.

Use this format:

## Conversation Summary
**Turns summarized:** {count}  |  **Compactions so far:** {n}

### User Goal
One sentence describing what the user is trying to accomplish.

### What Was Done
- Bullet points of completed actions, decisions made, and key outputs
- Include specific file paths, function names, variable names, URLs, and config values
- Note any errors encountered and how they were resolved

### Current State
What is the system/code/task state right now? What was the last thing discussed?

### Pending / Next Steps
- What remains to be done
- Any open questions or blockers

### Key Context
- Important constraints, preferences, or decisions that must not be forgotten
- Specific values: model names, ports, paths, credentials references, versions

Keep the summary under 1000 tokens. Be dense — every token should carry information. Do not include pleasantries or meta-commentary."""


def _sanitize_tool_messages(msgs: List[Dict]) -> List[Dict]:
    """删除孤立的 `tool` 消息和悬空的 assistant `tool_calls`。

    OpenAI API 要求每个 `role:"tool"` 消息必须紧跟在携带 `tool_calls` 的
      - 删除其 tool 响应全部被裁掉的 assistant `tool_calls` 消息
    tool message in the same batch). Front-trimming the history can cut
    可能会裁掉 assistant 的 `tool_calls` 父消息，但保留其 tool 响应，这会触发：
    "messages with role 'tool' must be a response to a preceding message with
    preceding message with 'tool_calls'". This pass repairs that:
      - drops `tool` messages with no valid preceding tool_calls
      - 删除其 tool 响应全部被裁掉的 assistant `tool_calls` 消息
        all trimmed away (some providers reject unanswered tool_calls)
    """
    # 第一遍：删除孤立的 tool 消息。
    cleaned: List[Dict] = []
    in_batch = False  # 是否紧跟在 assistant tool_calls 之后（或处于批次中）？
    for m in msgs:
        role = m.get("role")
        if role == "tool":
            if in_batch:
                cleaned.append(m)
            # 否则：孤立消息 — 丢弃
            continue
        if role == "assistant" and m.get("tool_calls"):
            in_batch = True
        else:
            in_batch = False
        cleaned.append(m)

    # 第二遍：删除后续没有 tool 响应的 assistant tool_calls 消息
    # （悬空）— 反向遍历，这样我们可以知道后面是什么。
    out: List[Dict] = []
    for i, m in enumerate(cleaned):
        if m.get("role") == "assistant" and m.get("tool_calls"):
            nxt = cleaned[i + 1] if i + 1 < len(cleaned) else None
            if not (nxt and nxt.get("role") == "tool"):
                # 悬空的 tool_calls — 保留消息但移除 tool_calls，
                # 悬空的 tool_calls — 保留消息但移除 tool_calls，
                # text content the model produced alongside the calls).
                m = {k: v for k, v in m.items() if k != "tool_calls"}
                if not (m.get("content") or "").strip():
                    continue  # 没有保留价值的内容
        out.append(m)
    return out


def _message_text_token_estimate(text: str) -> int:
    if not isinstance(text, str):
        return 4
    return int(len(text) * 0.3) + 4


def _truncate_text_to_token_budget(text: str, token_budget: int) -> str:
    """裁剪过大的当前用户消息，而不是完全丢弃它。"""
    if token_budget <= 32:
        return "[Current user message omitted: it exceeded the model context window.]"

    if not isinstance(text, str):
        # This helper is typed/used as text downstream, so return an empty
        # string rather than the raw non-string (which would move the crash
        # into the caller that concatenates/measures the result).
        return ""
    # 匹配 src.model_context.estimate_tokens 的粗略 chars * 0.3 估算。
    max_chars = max(200, int((token_budget - 16) / 0.3))
    if len(text) <= max_chars:
        return text

    notice = (
        "\n\n[Notice: the pasted message was too large for this model's context "
        "window, so Odysseus kept the beginning and end.]"
    )
    keep_chars = max(200, max_chars - len(notice))
    head_len = max(100, int(keep_chars * 0.7))
    tail_len = max(80, keep_chars - head_len)
    return text[:head_len].rstrip() + notice + "\n\n" + text[-tail_len:].lstrip()


def _truncate_tool_call_args(msg: Dict[str, Any], token_budget: int) -> Dict[str, Any]:
    """缩小过大的 assistant ``tool_calls`` 参数以适应 ``token_budget``。

    A tool-only turn persists ``content=None`` with its whole payload in
    ``tool_calls[].function.arguments``（例如一个大的 create_document 正文），
    the text-content truncation can't reach — so the message could stay over
    budget and the upstream call would 400. Replace each argument string that
    overflows its share of the budget with a small valid-JSON placeholder,
    保留 ``id``/``type``/``function.name``，以便工具/结果配对和
    provider validation are unaffected. Returns msg unchanged when there is
    nothing oversized.
    """
    tool_calls = msg.get("tool_calls")
    if not isinstance(tool_calls, list) or not tool_calls:
        return msg
    # 扣除已存在 content 后的剩余预算（estimate_tokens 也计数 tool
    # arguments，因此此处单独度量 content）。
    content_tokens = estimate_tokens([{"role": msg.get("role", "assistant"), "content": msg.get("content")}])
    per_call = max(16, (max(0, token_budget - content_tokens)) // len(tool_calls))
    new_calls = []
    changed = False
    for tc in tool_calls:
        fn = tc.get("function") if isinstance(tc, dict) else None
        args = fn.get("arguments") if isinstance(fn, dict) else None
        if isinstance(args, str) and int(len(args) * 0.3) > per_call:
            new_fn = dict(fn)
            new_fn["arguments"] = json.dumps({"_truncated_for_context": len(args)})
            new_tc = dict(tc)
            new_tc["function"] = new_fn
            new_calls.append(new_tc)
            changed = True
        else:
            new_calls.append(tc)
    if not changed:
        return msg
    out = dict(msg)
    out["tool_calls"] = new_calls
    return out


def _truncate_message_to_token_budget(msg: Dict[str, Any], token_budget: int) -> Dict[str, Any]:
    """返回 msg 的副本，确保其文本内容（和工具调用参数）不超过 token_budget。"""
    out = dict(msg)
    content = out.get("content", "")
    if isinstance(content, str):
        out["content"] = _truncate_text_to_token_budget(content, token_budget)
    elif isinstance(content, list):
        remaining = token_budget
        new_content = []
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "text":
                new_content.append(item)
                continue
            text = item.get("text", "")
            truncated = _truncate_text_to_token_budget(text, remaining)
            cloned = dict(item)
            cloned["text"] = truncated
            new_content.append(cloned)
            remaining -= _message_text_token_estimate(truncated)
        out["content"] = new_content
    # 纯工具轮次（content=None）将其负载携带在 tool_calls args 中，
    # 上述分支无法缩小它 — 处理它以使消息能够适应。
    return _truncate_tool_call_args(out, token_budget)


def trim_for_context(messages: List[Dict], context_length: int, reserve_tokens: int = 512) -> List[Dict]:
    """裁剪系统消息以适应 context_length。

    对于小上下文模型，逐步去除：
    1. RAG/内存系统消息（保留预设的系统提示）
    2. 较旧的对话轮次
    为响应保留空间。
    """
    budget = context_length - reserve_tokens
    used = estimate_tokens(messages)
    if used <= budget:
        return messages

    logger.info(f"Trimming messages: {used} tokens > {budget} budget (ctx={context_length})")

    # 将系统消息与对话分离。
    # 标记为 _protected 的消息（例如活动文档）永远不会被裁剪。
    system_msgs = []
    protected_msgs = []
    convo_msgs = []
    for msg in messages:
        if msg.get("_protected"):
            protected_msgs.append(msg)
        elif msg.get("role") == "system":
            system_msgs.append(msg)
        else:
            convo_msgs.append(msg)

    # 受保护的消息计入预算但永远不会被丢弃
    protected_tokens = estimate_tokens(protected_msgs)
    budget -= protected_tokens

    # Priority: keep first system msg (preset prompt), drop others (memory, RAG, memo).
    # Exception: a research-spinoff primer (the 随机种子ed report that grounds a
    # "Discuss" chat) must never be dropped — it is the conversation's whole
    # 知识库. Treat any system message carrying research_spinoff_from
    # metadata as essential alongside the leading 系统提示.
    def _is_research_primer(m):
        return bool((m.get("metadata") or {}).get("research_spinoff_from"))
    _primers = [m for m in system_msgs if _is_research_primer(m)]
    _non_primer = [m for m in system_msgs if not _is_research_primer(m)]
    essential_system = (_non_primer[:1] if _non_primer else []) + _primers
    extra_system = _non_primer[1:]

    # 尝试从末尾逐个丢弃额外的系统消息
    trimmed = essential_system + convo_msgs
    if estimate_tokens(trimmed) <= budget:
        # Dropping extras was enough — try adding back some
        result = list(essential_system)
        for msg in extra_system:
            candidate = result + [msg] + convo_msgs
            if estimate_tokens(candidate) <= budget:
                result.append(msg)
            else:
                break
        return _sanitize_tool_messages(result + protected_msgs + convo_msgs)

    # 仍然太大 — 截断第一条系统消息（但保留超过 500 个字符）
    if essential_system:
        sys_text = essential_system[0].get("content", "")
        if len(sys_text) > 2000:
            essential_system[0] = {"role": "system", "content": sys_text[:2000] + "\n[System prompt truncated for context limits]"}
            trimmed = essential_system + convo_msgs
            if estimate_tokens(trimmed) <= budget:
                return _sanitize_tool_messages(essential_system + protected_msgs + convo_msgs)

    # 仍然太大 — 丢弃较旧的对话轮次，但始终保留当前的
    # 用户轮次。如果仅粘贴的消息就超出模型上下文，则截断
    # 该消息并附上可见提示，而不是丢弃它；否则模型
    # 看起来像是"忽略"了大型粘贴内容，因为它从未收到它们。
    # Hermes 风格：近期上下文比旧上下文更重要。
    PROTECT_RECENT = 10
    current_msg = convo_msgs[-1:] if convo_msgs else []
    prior_convo = convo_msgs[:-1] if convo_msgs else []
    if len(prior_convo) >= PROTECT_RECENT:
        old_msgs = prior_convo[:-(PROTECT_RECENT - 1)]
        recent_msgs = prior_convo[-(PROTECT_RECENT - 1):] + current_msg
        while old_msgs and estimate_tokens(essential_system + old_msgs + recent_msgs) > budget:
            old_msgs.pop(0)
        convo_msgs = old_msgs + recent_msgs
    else:
        convo_msgs = prior_convo + current_msg
        while prior_convo and estimate_tokens(essential_system + prior_convo + current_msg) > budget:
            prior_convo.pop(0)
        convo_msgs = prior_convo + current_msg

    # 如果当前消息本身太大，只缩小该消息。
    if current_msg and estimate_tokens(essential_system + protected_msgs + convo_msgs) > budget:
        prefix = essential_system + protected_msgs + convo_msgs[:-1]
        available_for_current = max(64, budget - estimate_tokens(prefix))
        convo_msgs[-1] = _truncate_message_to_token_budget(convo_msgs[-1], available_for_current)

    result = _sanitize_tool_messages(essential_system + protected_msgs + convo_msgs)
    logger.info(f"Trimmed to {estimate_tokens(result)} tokens ({len(result)} messages)")
    return result


async def maybe_compact(
    session,
    endpoint_url: str,
    model: str,
    messages: List[Dict],
    headers: Optional[Dict] = None,
    owner: Optional[str] = None,
) -> tuple:
    """检查上下文使用情况并在超过阈值时进行压缩。

    返回 (messages, context_length, was_compacted)。
    """
    context_length = get_context_length(endpoint_url, model)
    used = estimate_tokens(messages)
    pct = (used / context_length) * 100 if context_length else 0

    if pct < COMPACT_THRESHOLD * 100:
        return messages, context_length, False

    logger.info(
        f"Context at {pct:.1f}% ({used}/{context_length} tokens) — compacting"
    )

    # 分为系统前言和对话部分
    system_msgs = []
    convo_msgs = []
    for msg in messages:
        if msg.get("role") == "system":
            system_msgs.append(msg)
        else:
            convo_msgs.append(msg)

    if len(convo_msgs) < 4:
        return messages, context_length, False

    # 将对话分成两半：总结较旧的一半，保留最近的一半
    split_point = len(convo_msgs) // 2
    older = convo_msgs[:split_point]
    recent = convo_msgs[split_point:]

    # 构建要摘要的文本
    convo_text = "\n".join(
        f"{msg.get('role', 'user').upper()}: {_content_as_text(msg.get('content'))[:2000]}"
        for msg in older
    )

    # 从已有的摘要消息中统计先前的压缩次数
    compaction_count = sum(
        1 for m in system_msgs
        if "[Conversation summary" in m.get("content", "")
    )

    # 如果配置了 utility 模型则使用，否则回退到 session 模型
    util_url, util_model, util_headers = resolve_endpoint("utility", owner=owner)
    compact_url = util_url or endpoint_url
    compact_model = util_model or model
    compact_headers = util_headers if util_url else headers

    prompt = SELF_SUMMARY_SYSTEM_PROMPT.replace(
        "{count}", str(len(older))
    ).replace(
        "{n}", str(compaction_count + 1)
    )
    summary_messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": convo_text},
    ]

    try:
        summary = await llm_call_async(
            compact_url,
            compact_model,
            summary_messages,
            temperature=0.2,
            max_tokens=SUMMARY_MAX_TOKENS,
            headers=compact_headers,
            timeout=30,
        )
    except Exception as e:
        logger.error(f"Compaction summary failed: {e}")
        # 优雅降级：保持对话完整，而不是静默丢弃较旧的
        # 一半内容。was_compacted=False 告知调用者未被摘要；
        # trim_for_context 处理长度问题。
        return messages, context_length, False

    summary_msg = {
        "role": "system",
        "content": f"[Conversation summary — earlier messages were compacted]\n{summary}",
    }

    compacted = system_msgs + [summary_msg] + recent

    # 更新 session 历史记录以匹配。传递 len(system_msgs)，以便
    # _update_session_history 中的 recent_history 切片使用正确的
    # 偏移量 — session.history 包含系统消息，但
    # split_point 是相对于 convo_msgs 索引的，而 convo_msgs 不包含系统消息。
    # 没有这一步，切片会丢弃开头的系统消息。
    _update_session_history(session, split_point, summary, system_msg_count=len(system_msgs))

    new_used = estimate_tokens(compacted)
    logger.info(
        f"Compacted: {used} -> {new_used} tokens "
        f"({len(older)} messages summarized, {len(recent)} kept)"
    )

    return compacted, context_length, True


def _update_session_history(session, split_point: int, summary: str,
                            system_msg_count: int = 0):
    """更新压缩后的内存中 session 历史记录。

    `split_point` 是 `convo_msgs`（去除系统消息后）中的索引。
    in-memory `session.history` includes leading system messages, so the
    实际的近期历史切片从 `system_msg_count + split_point` 开始。
    将 `session.history[:system_msg_count]` 添加到新历史记录前，
    preserves persona, preset, and RAG system messages that would
    otherwise be dropped.
    """
    if not session or not hasattr(session, "history"):
        return

    effective_split = system_msg_count + split_point
    if effective_split >= len(session.history):
        return

    # 保留最近的消息，在开头添加摘要和开头的系统
    # 消息，以便系统提示在压缩后仍能保留。
    system_prefix = list(session.history[:system_msg_count])
    recent_history = session.history[effective_split:]
    summary_msg = ChatMessage(
        role="system",
        content=f"[Conversation summary]\n{summary}",
        metadata={"compacted": True, "summarized_count": split_point},
    )
    new_history = system_prefix + [summary_msg] + recent_history
    try:
        from core.models import get_session_manager_instance
        manager = get_session_manager_instance()
    except Exception:
        manager = None
    if manager and getattr(session, "id", None):
        if manager.replace_messages(session.id, new_history):
            return
    session.history = new_history
