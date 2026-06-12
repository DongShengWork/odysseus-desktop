"""
skill_extractor.py

从复杂 agent 运行中后台自动提取技能。
当 agent 需要 >= 2 轮或 >= 2 次工具调用来完成任务时，
我们要求 LLM 将方法提炼为可复用的技能。
"""

import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)

SKILL_EXTRACT_PROMPT = (
    "You are analyzing an AI agent's work session. The agent took {rounds} rounds "
    "and {tool_count} tool calls to complete the task.\n\n"
    "Extract a reusable 'skill' ONLY IF the session contains a concrete, "
    "repeatable procedure the agent could follow to solve a similar problem "
    "ON THE COMPUTER next time (e.g. a sequence of shell commands, code, file "
    "edits, API calls, or tool usage).\n\n"
    "Return null (the bare word, no JSON) when the session is NOT a reusable "
    "computer procedure, including:\n"
    "- The real work happened OUTSIDE the computer (the user did something "
    "physically, in person, on another device, or by hand) and the agent only "
    "discussed or advised it.\n"
    "- A one-off, personal, or context-specific task that won't recur "
    "(personal errands, a specific person/place/date, casual conversation).\n"
    "- A pure question/answer or explanation with no transferable method.\n"
    "- The agent failed, gave up, or the approach is not worth repeating.\n\n"
    "When (and only when) a genuine reusable procedure exists, return a JSON "
    "object with:\n"
    '- "title": short name (under 10 words)\n'
    '- "problem": what was the challenge (1-2 sentences)\n'
    '- "solution": what worked (1-2 sentences)\n'
    '- "steps": array of step-by-step instructions (3-7 short steps)\n'
    '- "tags": array of relevant keywords (3-5 tags)\n'
    '- "confidence": 0.0-1.0 how reliable AND reusable this procedure is\n\n'
    "Be conservative: if in doubt, return null.\n"
    "Return ONLY valid JSON (or the bare word null), no markdown fences."
)

# 模型不确定的技能（或看起来是一次性的）会增加杂乱 —
# 丢弃低于此置信度的任何内容。
MIN_CONFIDENCE = 0.6

# 包含多少条最近消息
CONTEXT_WINDOW = 12


def _skill_dicts(skills):
    for skill in skills or []:
        if isinstance(skill, dict):
            yield skill


def _has_duplicate_title(skills, title: str) -> bool:
    wanted = title.lower()
    for skill in _skill_dicts(skills):
        existing = skill.get("title", "")
        if isinstance(existing, str) and existing.lower() == wanted:
            return True
    return False


def _extract_json_object(text: str) -> Optional[dict]:
    """尽力从 LLM 响应中提取 JSON 对象。

    响应可能被代码围栏包裹或被散文包围，且某些
    模型在真实对象之前发出一段多余的括号
    （例如 "uses {placeholder} then {...}"）。截取第一个 '{' 到最后 '}'
    会得到一段无法解析的跨度，技能静默丢失。先尝试
    整个字符串，然后依次尝试每个 '{' 起始位置，返回第一个
    解析为 JSON 对象（dict）的候选。如果都没有则返回 None。
    """
    if not text:
        return None
    s = text.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    end = s.rfind("}")
    if end == -1:
        return None

    def _as_dict(candidate):
        try:
            obj = json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            return None
        return obj if isinstance(obj, dict) else None

    # 干净、常见的情况：整个（去除围栏后的）字符串就是对象。
    obj = _as_dict(s)
    if obj is not None:
        return obj
    # 否则从每个 '{' 位置向前扫描到最后一个 '}'。
    start = s.find("{")
    while 0 <= start < end:
        obj = _as_dict(s[start : end + 1])
        if obj is not None:
            return obj
        start = s.find("{", start + 1)
    return None


async def maybe_extract_skill(
    session,
    skills_manager,
    endpoint_url: str,
    model: str,
    headers: dict,
    round_count: int,
    tool_count: int,
    owner: Optional[str] = None,
):
    """如果 agent 运行复杂到值得提取，则提取技能。"""
    if not model:
        logger.debug("[skill-extract] No model provided, skipping")
        return None

    # 默认静默；追踪提取器问题时翻到 DEBUG。
    logger.debug(
        "[skill-extract] start: rounds=%d tools=%d model=%s owner=%s",
        round_count, tool_count, model, owner,
    )
    if round_count < 2 and tool_count < 2:
        logger.debug("[skill-extract] BELOW threshold (need rounds>=2 or tools>=2)")
        return None

    try:
        from src.llm_core import llm_call_async

        # 获取最近消息
        history = session.get_context_messages()
        recent = history[-CONTEXT_WINDOW:] if len(history) > CONTEXT_WINDOW else history
        if not recent:
            logger.debug("[skill-extract] no recent messages, skipping")
            return None

        # 从消息中移除媒体内容（图片/音频）
        stripped_recent = []
        for msg in recent:
            content = msg.get("content", "")
            if isinstance(content, list):
                text_only = [b for b in content if isinstance(b, dict) and b.get("type") == "text"]
                if not text_only and content:
                    continue
                content = text_only
            stripped_recent.append({"role": msg.get("role"), "content": content})

        if not stripped_recent:
            return None

        # 构建提取用的对话摘要
        conv_lines = []
        for msg in stripped_recent:
            role = msg.get("role", "?")
            content = msg.get("content", "")
            if isinstance(content, list):
                content = " ".join(
                    b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
                )
            # 截断过长的消息
            if len(content) > 500:
                content = content[:500] + "..."
            conv_lines.append(f"[{role}] {content}")

        conversation = "\n".join(conv_lines)

        prompt = SKILL_EXTRACT_PROMPT.format(rounds=round_count, tool_count=tool_count)

        import time as _time
        _t0 = _time.monotonic()
        logger.debug(
            "[skill-extract] calling LLM (endpoint=%s, ctx=%d msgs, timeout=30s)",
            endpoint_url, len(recent),
        )
        response = await llm_call_async(
            endpoint_url,
            model,
            [
                {"role": "system", "content": prompt},
                {"role": "user", "content": f"Conversation:\n{conversation}"},
            ],
            headers=headers,
            timeout=30,
        )
        logger.debug(
            "[skill-extract] LLM returned in %.1fs (len=%d, head=%r)",
            _time.monotonic() - _t0, len(response or ""), (response or "")[:80],
        )

        if not response or response.strip().lower() == "null":
            logger.debug(
                "[skill-extract] LLM declined (returned null/empty) — "
                "session deemed not a reusable procedure"
            )
            return None

        # 部分模型（MiniMax, Qwen-Thinker, DeepSeek-R1）即使在要求
        # 纯 JSON 时也会在 JSON 输出之前发出
        # 思维链。`strip_think(prose=True, prompt_echo=True)` 移除
        # <think>…</think> 标签和散文风格的 "Let me analyze this…"
        # 前言。没有它，json.loads 每次都在字符 0 崩溃，
        # 静默退出看起来像 "提取器不工作"。
        try:
            from src.text_helpers import strip_think as _strip_think
            response = _strip_think(response, prose=True, prompt_echo=True)
        except Exception:
            pass

        # 解析 JSON。对象可能被代码围栏包裹或被
        # 评论包围（且可能包含一个游离/无效的括号片段，
        # 在真实对象之前 — 包括让响应本身看起来
        # 像以 '{' 开头的），因此使用一个宽容的提取器，先尝试
        # 整个字符串，然后从左到右依次尝试每个 '{' 候选。
        data = _extract_json_object(response)
        if not data:
            logger.debug("[skill-extract] no JSON object found in response, dropping")
            return None

        title = data.get("title", "").strip()
        if not title:
            logger.debug("[skill-extract] LLM returned object with no title, dropping")
            return None

        # 遵守模型自身的可靠性/可复用性评估 — 低
        # 置信度的提取结果通常是一次性或不可靠的程序。
        try:
            _conf = float(data.get("confidence", 0.7))
        except (TypeError, ValueError):
            _conf = 0.7
        if _conf < MIN_CONFIDENCE:
            logger.debug(
                "[skill-extract] '%s' below confidence floor (%.2f < %.2f) — dropped",
                title, _conf, MIN_CONFIDENCE,
            )
            return None

        # 检查重复技能
        existing = skills_manager.load(owner=owner)
        if _has_duplicate_title(existing, title):
            logger.debug("[skill-extract] '%s' already exists — dropped as duplicate", title)
            return None

        # 自动发布闸门：如果用户开启了 `auto_approve_skills`，
        # 新提取的技能会立即创建为 `published`，而非
        # 等待下一次审计批次。审计会在稍后运行
        # 并可在失败时将技能降级回 `draft`（或删除）。默认
        # ON 匹配 UI 标签 "自动批准技能"。
        _initial_status = "draft"
        try:
            from routes.prefs_routes import _load_for_user as _load_prefs
            _prefs = _load_prefs(owner) or {}
            if _prefs.get("auto_approve_skills", True):
                _initial_status = "published"
        except Exception:
            pass

        entry = skills_manager.add_skill(
            title=title,
            problem=data.get("problem", ""),
            solution=data.get("solution", ""),
            steps=data.get("steps", []),
            tags=data.get("tags", []),
            source="learned",
            confidence=data.get("confidence", 0.7),
            session_id=getattr(session, "session_id", None),
            owner=owner,
            status=_initial_status,
        )
        try:
            from src.event_bus import fire_event
            fire_event("skill_added", owner)
        except Exception:
            logger.debug("skill_added event dispatch failed", exc_info=True)
        logger.info("Auto-extracted skill: %s (id=%s)", title, entry["id"])
        return entry

    except json.JSONDecodeError as e:
        logger.debug("[skill-extract] non-JSON LLM response, dropping: %s", e)
        return None
    except Exception as e:
        # 真实的异常保持 INFO+warning 级别，这样即使
        # 用户仅使用默认日志级别也不会丢失。`exc_info=True` 发送
        # 完整回溯，以便超时 vs 认证 vs 导入错误可以
        # 从外部区分。
        logger.warning("[skill-extract] FAILED: %s", e, exc_info=True)
        return None
