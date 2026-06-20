"""Always-on monitor that auto-continues the agent when a background job
(see src/bg_jobs.py) finishes.

可靠性是关键：完成 → agent 重新调用绝不能静默失败。监控器每个周期
从 `bg_jobs.pending_followups()` 排空数据，并且仅在 agent run 成功
之后才调用 `mark_followed_up()` — 这样临时故障会在下一个周期自动重试。
超时/失败的任务仍然会产生后续操作（"任务失败/超时"），因此用户总能
收到反馈。
"""

from __future__ import annotations

import asyncio
import json
import logging

from src import bg_jobs

logger = logging.getLogger(__name__)

_monitor_task = None
POLL_INTERVAL_S = 5
# 后续 agent run 被允许几轮来实际继续任务
# （例如在 `pip install` 完成后运行转录）。
_FOLLOWUP_MAX_ROUNDS = 12


async def _drain_agent(sess, messages):
    """针对 session 在无界面模式下运行 agent 循环。返回
    (final_prose, tool_events) — tool_events 与实时聊天保存的
    格式相同，前端以标准 agent 线程工具卡片的形式重建它们。"""
    from src.agent_loop import stream_agent_loop
    full = ""
    tool_events = []
    round_num = 1
    async for chunk in stream_agent_loop(
        sess.endpoint_url, sess.model, messages,
        headers=getattr(sess, "headers", None),
        context_length=getattr(sess, "context_length", 0) or 0,
        session_id=sess.id,
        max_rounds=_FOLLOWUP_MAX_ROUNDS,
        owner=getattr(sess, "owner", None),
    ):
        if not chunk.startswith("data: "):
            continue
        body = chunk[6:].strip()
        if not body or body == "[DONE]":
            continue
        try:
            d = json.loads(body)
        except (ValueError, TypeError):
            continue
        if not isinstance(d, dict):
            continue
        if "delta" in d:
            delta = d.get("delta")
            if isinstance(delta, str):
                if d.get("thinking"):
                    continue
                full += delta
        elif d.get("type") == "agent_step":
            round_num = d.get("round", round_num)
        elif d.get("type") == "tool_output":
            # 镜像实时聊天的 tool_event 格式（chat_routes / chatRenderer）。
            tool_events.append({
                "round": round_num,
                "tool": d.get("tool"),
                "command": d.get("command"),
                "output": d.get("output"),
                "exit_code": d.get("exit_code"),
            })
    return full, tool_events


async def _run_followup(rec: dict) -> bool:
    """在任务的 session 中使用结果重新调用 agent。如果后续操作完成
    （或无事可做）则返回 True — 即可以安全地标记 followed_up。
    返回 False 则在下一个周期重试。"""
    from src.ai_interaction import get_session_manager
    from core.models import ChatMessage

    sm = get_session_manager()
    if not sm:
        return False  # 尚未就绪 — 重试
    sess = sm.get_session(rec["session_id"])
    if not sess:
        # Session 已删除 — 无后续操作。将其视为已处理，
        # 避免无限重试。
        logger.info("bg-followup: session %s gone for job %s — skipping", rec.get("session_id"), rec.get("id"))
        return True

    # 不要写入正在进行流式传输的 session。后续操作追加到
    # 历史记录 + save_sessions()；并发的实时轮次也做同样的事，
    # 没有每个 session 的锁时两者会交错（消息重排/覆盖）。
    # 推迟 — 返回 False 以便在下一个周期重试。
    try:
        from src import agent_runs
        if agent_runs.is_active(sess.id):
            logger.info("bg-followup: session %s busy (live turn) — deferring job %s", sess.id, rec.get("id"))
            return False
    except Exception:
        pass

    inject = (
        f"[Background job {rec['id']} finished]\n\n"
        f"{bg_jobs.result_text(rec)}\n\n"
        "Continue the task using this output. Don't repeat work that's already done. "
        "If the task is now complete, give the user the final result."
    )
    context = sess.get_context_messages()
    context.append({"role": "user", "content": inject})

    full, tool_events = await _drain_agent(sess, context)

    # 仅持久化助手后续内容，使其渲染为正常的 agent 轮次 —
    # 标准聊天气泡加上前端重建为常规 agent 线程工具卡片的
    # `tool_events`（chatRenderer:1494）。触发器不作为自己的消息
    # 保存（那会是个位置不对的气泡）；原始任务输出存储在元数据中
    # 以供追溯。
    sm.add_message(sess.id, ChatMessage(
        "assistant", full,
        metadata={
            "tool_events": tool_events,
            "model": sess.model,
            "bg_job_id": rec["id"],
            "bg_result": bg_jobs.result_text(rec)[:4000],
        },
    ))
    sm.save_sessions()
    logger.info("bg-followup: auto-continued session %s for job %s (%d chars, %d tools)",
                sess.id, rec["id"], len(full), len(tool_events))
    return True


async def _loop():
    while True:
        try:
            for rec in bg_jobs.pending_followups():
                try:
                    if await _run_followup(rec):
                        bg_jobs.mark_followed_up(rec["id"])
                except Exception as e:
                    # 幂等：保持 followed_up=False，下一个周期重试。
                    logger.warning("bg-followup failed for %s (will retry): %s", rec.get("id"), e)
        except Exception as e:
            logger.warning("bg-monitor tick error: %s", e)
        await asyncio.sleep(POLL_INTERVAL_S)


def start_bg_monitor():
    """幂等 — 启动常驻后台任务监控器。"""
    global _monitor_task
    if _monitor_task and not _monitor_task.done():
        return _monitor_task
    _monitor_task = asyncio.create_task(_loop())
    logger.info("Background-job monitor started (poll %ds)", POLL_INTERVAL_S)
    return _monitor_task
