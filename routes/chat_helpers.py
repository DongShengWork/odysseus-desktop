"""聊天路由的共享辅助函数 — 上下文构建、响应后任务、认证解析。"""

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from core.models import ChatMessage
from core.database import SessionLocal
from core.database import Session as DBSession, ModelEndpoint
from src.llm_core import normalize_model_id
from src.endpoint_resolver import normalize_base
from src.context_compactor import maybe_compact, trim_for_context
from src.auth_helpers import get_current_user
from src.prompt_security import untrusted_context_message
from routes.prefs_routes import _load_for_user as load_prefs_for_user

from fastapi import HTTPException

logger = logging.getLogger(__name__)


# ── Data containers ────────────────────────────────────────────────────── #

@dataclass
class PresetInfo:
    """提取的预设参数。"""
    temperature: Optional[float]
    max_tokens: Optional[int]
    system_prompt: Optional[str]
    character_name: Optional[str]


@dataclass
class PreprocessedMessage:
    """chat_handler.preprocess_message 的结果。"""
    enhanced_message: str
    user_content: Any  # str or list (multimodal)
    text_for_context: str
    youtube_transcripts: list
    attachment_meta: list


@dataclass
class ChatContext:
    """上下文构建完成后调用 LLM 所需的所有信息。"""
    preface: list
    rag_sources: list
    web_sources: list
    used_memories: list
    messages: list
    context_length: int
    was_compacted: bool
    user: Optional[str]
    uprefs: dict
    preset: PresetInfo
    preprocessed: PreprocessedMessage
    # 在预处理过程中服务端自动创建的文档（例如
    # 将附件的可填写 PDF 渲染为 Markdown 编辑器文档）。
    # 聊天路由在开始流式传输前为每个文档发出 doc_update SSE 事件，
    # 以便编辑器面板立即切换到新文档。
    auto_opened_docs: list = field(default_factory=list)


# ── Helpers ────────────────────────────────────────────────────────────── #

def _enforce_chat_privileges(request, sess) -> None:
    """应用每个用户的权限门控——/api/chat 和 /api/chat_stream 在
    任何 LLM 工作之前必须强制执行 allowed_models 和 max_messages_per_day。

    如果会话的模型不在用户的允许列表中，抛出 HTTPException(403)；
    如果用户达到每日消息上限，抛出 HTTPException(429)。
    对于未认证的调用者或 auth_manager 不存在时（单用户模式），
    不做任何操作。管理员从 get_privileges 获得 ADMIN_PRIVILEGES，
    即无限制的 allowed_models / 零上限 → 对他们无操作。
    """
    try:
        user = get_current_user(request)
    except Exception:
        user = None
    if not user:
        return
    auth_manager = getattr(getattr(request.app, "state", None), "auth_manager", None)
    if not auth_manager:
        return

    privs = auth_manager.get_privileges(user) or {}

    # 显式的"阻止一切"哨兵优先于白名单 —
    # 这是区分用户点击"无"（阻止全部）和用户点击"全部"（无限制）
    # 的唯一方式，否则两者都会产生空的 allowed_models 列表。
    if privs.get("block_all_models"):
        raise HTTPException(403, f"Your account is not allowed to use model '{sess.model}'.")

    allowed_raw = privs.get("allowed_models")
    allowed = allowed_raw if isinstance(allowed_raw, list) else []
    restricted = bool(privs.get("allowed_models_restricted")) or bool(allowed)
    if restricted and sess.model and sess.model not in allowed:
        raise HTTPException(403, f"Your account is not allowed to use model '{sess.model}'.")

    cap = int(privs.get("max_messages_per_day") or 0)
    if cap <= 0:
        return

    from datetime import datetime as _dt, timedelta as _td
    from core.database import Session as _DbSess, ChatMessage as _Cm
    db = SessionLocal()
    try:
        count = (
            db.query(_Cm)
            .join(_DbSess, _Cm.session_id == _DbSess.id)
            .filter(_DbSess.owner == user,
                    _Cm.role == "user",
                    _Cm.timestamp >= _dt.utcnow() - _td(days=1))
            .count()
        )
    finally:
        db.close()
    if count >= cap:
        raise HTTPException(429, f"Daily message limit reached ({cap}). Try again in 24 hours.")


def needs_auto_name(name: str) -> bool:
    """检查会话是否仍使用默认/占位名称。"""
    if not name:
        return True
    if name.startswith("Chat:") or name == "Chat":
        return True
    # 默认前端名称："modelname HH:MM:SS AM/PM"
    if re.match(r"^.+ \d{1,2}:\d{2}:\d{2}(\s*(AM|PM))?$", name, re.IGNORECASE):
        return True
    return False


async def auto_name_session(session_manager, sess):
    """从会话的第一条用户消息生成简短标题。"""
    try:
        from src.llm_core import llm_call_async
        from src.task_endpoint import resolve_task_endpoint

        # 查找第一条用户消息
        first_msg = ""
        for msg in sess.history:
            if msg.role == "user":
                content = msg.content
                if isinstance(content, list):
                    content = next(
                        (i.get("text", "") for i in content if isinstance(i, dict) and i.get("type") == "text"),
                        "",
                    )
                first_msg = str(content)[:500]
                break

        if not first_msg:
            return

        owner = getattr(sess, "owner", None)
        t_url, t_model, t_headers = resolve_task_endpoint(
            sess.endpoint_url, sess.model, sess.headers, owner=owner,
        )
        if not t_model:
            logger.debug("[auto-name] No model provided, skipping")
            return

        # max_tokens 足够大，让推理模型（Minimax M2、
        # DeepSeek R1、QwQ 等）有空间完成 <think>…</think>
        # 再加上实际的标题 — 200 会导致它们在中途被截断，
        # strip_think 留下空字符串而没有发生重命名。
        # 超时匹配：60 秒给慢速本地推理模型留出完成空间。
        title = await llm_call_async(
            t_url,
            t_model,
            [
                {"role": "system", "content": "Generate a short title (3-6 words, no quotes) for a conversation that starts with this message. Reply with ONLY the title, nothing else. Do NOT include any thinking, reasoning, or explanation — just the title."},
                {"role": "user", "content": first_msg},
            ],
            temperature=0.3,
            max_tokens=4096,
            headers=t_headers,
            timeout=60,
        )

        title = title.strip().strip('"\'').strip()
        # 通过中心辅助函数去除 <think>/<thinking> 块（已闭合、悬空或孤立的标签）。
        from src.text_helpers import strip_think
        title = strip_think(title, prose=False, prompt_echo=False)
        if title and len(title) < 80:
            session_manager.update_session_name(sess.id, title)
            logger.info(f"Auto-named session {sess.id}: {title}")

    except Exception as e:
        import traceback
        logger.error(f"Auto-name failed for {sess.id}: {e}\n{traceback.format_exc()}")


def try_fallback_endpoint(sess, session_id: str) -> dict | None:
    """当前端点失败时查找替代的工作端点。

    返回 {"model": ..., "endpoint_url": ..., "endpoint_name": ...} 或 None。
    """
    import requests as _req
    from src.endpoint_resolver import (
        build_chat_url,
        build_headers,
        build_models_url,
        normalize_base,
        resolve_endpoint_runtime,
    )
    from src.chatgpt_subscription import is_chatgpt_subscription_base

    current_url = sess.endpoint_url or ""
    owner = getattr(sess, "owner", None)
    db = SessionLocal()
    try:
        q = db.query(ModelEndpoint).filter(
            ModelEndpoint.is_enabled == True
        )
        if owner:
            from src.auth_helpers import owner_filter
            q = owner_filter(q, ModelEndpoint, owner)
        endpoints = q.all()
    finally:
        db.close()

    for ep in endpoints:
        base = normalize_base(ep.base_url)
        # 跳过当前端点
        if current_url and base in current_url:
            continue
        try:
            base, api_key = resolve_endpoint_runtime(ep, owner=owner)
        except Exception:
            continue
        ping_url = build_models_url(base)
        headers = build_headers(api_key, base)
        try:
            if ping_url:
                r = _req.get(ping_url, headers=headers, timeout=5)
                r.raise_for_status()
                data = r.json()
                models = [m.get("id") for m in (data.get("data") or []) if m.get("id")]
                if not models:
                    models = [
                        m.get("name") or m.get("model")
                        for m in (data.get("models") or [])
                        if m.get("name") or m.get("model")
                    ]
            else:
                models = json.loads(ep.cached_models or "[]")
            if not models:
                continue
            # 找到一个可用的端点 — 更新会话
            new_model = models[0]
            chat_url = build_chat_url(base)
            new_headers = build_headers(api_key, base)
            persisted_headers = {} if is_chatgpt_subscription_base(base) else new_headers

            sess.model = new_model
            sess.endpoint_url = chat_url
            sess.headers = new_headers

            # 持久化
            _db = SessionLocal()
            try:
                _db.query(DBSession).filter(DBSession.id == session_id).update({
                    "model": new_model,
                    "endpoint_url": chat_url,
                    "headers": persisted_headers,
                })
                _db.commit()
            finally:
                _db.close()

            logger.info(f"Fallback: switched session {session_id} from {current_url} to {ep.name} ({new_model})")
            return {
                "model": new_model,
                "endpoint_url": chat_url,
                "endpoint_name": ep.name,
            }
        except Exception:
            continue

    return None


def extract_preset(chat_handler, preset_id) -> PresetInfo:
    """通过 chat_handler 提取预设参数。"""
    temperature, max_tokens, system_prompt, char_name = (
        chat_handler.validate_and_extract_preset(preset_id)
    )
    return PresetInfo(
        temperature=temperature,
        max_tokens=max_tokens,
        system_prompt=system_prompt,
        character_name=char_name,
    )


async def preprocess(
    chat_handler, message, att_ids, sess,
    auto_opened_docs: Optional[list] = None,
    allow_tool_preprocessing: bool = True,
) -> PreprocessedMessage:
    """运行 chat_handler.preprocess_message 并封装结果。"""
    enhanced, user_content, text_ctx, yt_transcripts, att_meta = (
        await chat_handler.preprocess_message(
            message,
            att_ids,
            sess,
            auto_opened_docs=auto_opened_docs,
            allow_tool_preprocessing=allow_tool_preprocessing,
        )
    )
    return PreprocessedMessage(
        enhanced_message=enhanced,
        user_content=user_content,
        text_for_context=text_ctx,
        youtube_transcripts=yt_transcripts,
        attachment_meta=att_meta,
    )


def add_user_message(sess, chat_handler, preprocessed: PreprocessedMessage, incognito: bool = False):
    """将用户消息添加到会话历史并更新会话名称。
    在隐身模式下，仍然添加到内存历史（用于对话上下文）
    但跳过会话名称更新（该操作会持久化）。"""
    user_meta = {"attachments": preprocessed.attachment_meta} if preprocessed.attachment_meta else None
    sess.add_message(ChatMessage("user", preprocessed.user_content, metadata=user_meta))
    if not incognito:
        chat_handler.update_session_name_if_needed(sess, preprocessed.text_for_context)


def fire_message_event(request, webhook_manager, session_id: str, sess, message: str, compare_mode: bool = False):
    """针对新用户消息触发 webhook 和 event_bus 事件。"""
    if webhook_manager and not compare_mode:
        asyncio.create_task(webhook_manager.fire("chat.message", {
            "session_id": session_id, "model": sess.model, "message": message[:2000],
        }))
    from src.event_bus import fire_event
    user = get_current_user(request)
    fire_event("message_sent", user)


def _session_url_matches_endpoint(session_url: str, endpoint_base: str) -> bool:
    if not session_url or not endpoint_base:
        return False
    try:
        from src.endpoint_resolver import build_chat_url, normalize_base

        sess_url = session_url.rstrip("/")
        base = normalize_base(endpoint_base).rstrip("/")
        return sess_url in {
            base,
            base + "/chat/completions",
            build_chat_url(base).rstrip("/"),
        }
    except Exception:
        return False


def _has_auth_keys(headers) -> bool:
    """如果 headers 字典包含 Authorization/x-api-key 条目则返回 True。"""
    return isinstance(headers, dict) and any(
        k.lower() in ('authorization', 'x-api-key') for k in headers
    )


def resolve_session_auth(sess, session_id: str, owner: Optional[str] = None):
    """确保会话有认证头 — 如果缺失则从端点数据库解析。"""
    try:
        from src.chatgpt_subscription import is_chatgpt_subscription_base
        is_chatgpt_subscription = is_chatgpt_subscription_base(getattr(sess, "endpoint_url", "") or "")
    except Exception:
        is_chatgpt_subscription = False
    has_auth = _has_auth_keys(sess.headers)
    if has_auth and not is_chatgpt_subscription:
        return

    try:
        from src.endpoint_resolver import build_headers, resolve_endpoint_runtime
        db = SessionLocal()
        try:
            target_url = getattr(sess, "endpoint_url", "") or ""
            if not target_url:
                return
            q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)
            if owner:
                # 缺失的 headers 通常意味着"从已保存的端点恢复"。
                # 将该查询范围限定到会话所有者，否则两个
                # 拥有相似端点 URL 的用户可能相互借用对方的 API key。
                from src.auth_helpers import owner_filter
                q = owner_filter(q, ModelEndpoint, owner)
            for ep in q.all():
                if not _session_url_matches_endpoint(target_url, ep.base_url or ""):
                    continue
                try:
                    base, api_key = resolve_endpoint_runtime(ep, owner=owner)
                except Exception as e:
                    logger.warning("Failed to resolve provider auth for session %s: %s", session_id, e)
                    return
                if not api_key:
                    # 没有可用的 key（例如 ChatGPT Subscription 需要重新授权）。
                    return
                sess.headers = build_headers(api_key, base)
                if is_chatgpt_subscription:
                    # bearer 是短期的，每个请求重新解析，因此
                    # 它保持在请求本地，永远不会写入明文
                    # sessions.headers 列。主动清除旧代码路径
                    # 可能已持久化的任何 bearer 以免残留。
                    stale_q = db.query(DBSession).filter(DBSession.id == session_id)
                    if owner:
                        stale_q = stale_q.filter(DBSession.owner == owner)
                    stored = stale_q.first()
                    if stored is not None and _has_auth_keys(stored.headers):
                        stale_q.update({"headers": {}})
                        db.commit()
                        logger.info(f"Cleared persisted ChatGPT Subscription bearer from session {session_id}")
                    logger.debug(f"Resolved request-local ChatGPT Subscription auth for session {session_id}")
                    return
                update_q = db.query(DBSession).filter(DBSession.id == session_id)
                if owner:
                    update_q = update_q.filter(DBSession.owner == owner)
                update_q.update({"headers": sess.headers})
                db.commit()
                logger.info(f"Resolved and persisted auth headers for session {session_id} from endpoint {ep.name}")
                return
        finally:
            db.close()
    except Exception as e:
        logger.warning(f"Failed to resolve session headers: {e}")


def _match_cached_model_id(requested: str, models) -> Optional[str]:
    if not requested or not models:
        return None
    model_ids = [str(m) for m in models if m]
    if requested in model_ids:
        return requested

    req_base = os.path.basename(requested.rstrip("/"))
    for model_id in model_ids:
        if os.path.basename(model_id.rstrip("/")) == req_base:
            return model_id
    return None


def _normalize_model_id_from_cache(sess) -> Optional[str]:
    """优先使用存储的端点模型 ID，然后回退到实时的 /models 探测。"""
    endpoint_url = getattr(sess, "endpoint_url", "") or ""
    requested = getattr(sess, "model", "") or ""
    if not endpoint_url or not requested:
        return None

    try:
        session_base = normalize_base(endpoint_url)
    except Exception:
        session_base = endpoint_url.rstrip("/")
    if not session_base:
        return None

    db = SessionLocal()
    try:
        q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)
        owner = getattr(sess, "owner", None)
        if owner:
            from src.auth_helpers import owner_filter
            q = owner_filter(q, ModelEndpoint, owner)
        endpoints = q.all()
        for ep in endpoints:
            try:
                if normalize_base(getattr(ep, "base_url", "") or "") != session_base:
                    continue
            except Exception:
                continue

            raw_models = getattr(ep, "cached_models", None)
            if not raw_models:
                continue
            try:
                models = json.loads(raw_models) if isinstance(raw_models, str) else raw_models
            except Exception:
                continue

            matched = _match_cached_model_id(requested, models)
            if matched:
                return matched
    except Exception as e:
        logger.debug("Cached model normalization skipped: %s", e)
    finally:
        db.close()

    return None


async def build_chat_context(
    sess,
    request,
    chat_handler,
    chat_processor,
    message: str,
    session_id: str,
    preset_id=None,
    att_ids: list = None,
    use_web=None,
    use_rag=None,
    use_research=None,
    time_filter=None,
    incognito: bool = False,
    no_memory: bool = False,
    search_context: str = None,
    compare_mode: bool = False,
    webhook_manager=None,
    use_enhanced_message: bool = False,
    agent_mode: bool = False,
    allow_tool_preprocessing: bool = True,
) -> ChatContext:
    """构建 LLM 调用的完整上下文（前言 + 消息）。

    这是 /chat 和 /chat_stream 的共享逻辑 — 预设提取、
    消息预处理、记忆/RAG/网络注入、压缩、归一化。
    """
    # 预设
    preset = extract_preset(chat_handler, preset_id)

    # 预处理消息（CoT、YouTube、VL 图片、构建内容）。
    # auto_opened_docs 收集器捕获服务端创建的任何文档
    #（例如可填写 PDF → Markdown 编辑器文档），以便聊天路由
    # 在流式传输前向前端通知它们。
    auto_opened_docs: list = []
    preprocessed = await preprocess(
        chat_handler, message, att_ids or [], sess,
        auto_opened_docs=auto_opened_docs,
        allow_tool_preprocessing=allow_tool_preprocessing,
    )

    # 将用户消息添加到历史记录
    add_user_message(sess, chat_handler, preprocessed, incognito=incognito)

    # 触发事件
    if not incognito:
        fire_message_event(request, webhook_manager, session_id, sess, message, compare_mode)

    # 解析用户偏好
    user = get_current_user(request)
    uprefs = load_prefs_for_user(user)

    # 记忆已启用？
    mem_enabled = not incognito and not no_memory and uprefs.get("memory_enabled", True)
    # 技能注入遵循自己的启用开关（镜像 memory_enabled）。
    # 关闭时，"可用技能"索引不添加到提示中。
    skills_enabled = not incognito and uprefs.get("skills_enabled", True)
    if not allow_tool_preprocessing:
        mem_enabled = False
        skills_enabled = False
    logger.debug(
        "Memory enabled=%s for user=%s (incognito=%s, no_memory=%s, pref=%s)",
        mem_enabled, user, incognito, no_memory, uprefs.get("memory_enabled", "NOT_SET"),
    )

    # 使用 RAG？
    use_rag_val = (str(use_rag).lower() != "false") if use_rag is not None else True
    if incognito or not allow_tool_preprocessing:
        use_rag_val = False

    # 如果提供了预获取的搜索上下文（比较模式），跳过实时网络搜索
    skip_web = bool(search_context) or not allow_tool_preprocessing

    # 构建上下文前言
    # 流式路径使用 enhanced_message（已应用 CoT/预处理），
    # 同步路径使用 text_for_context。
    _ctx_msg = preprocessed.enhanced_message if use_enhanced_message else preprocessed.text_for_context
    _preface_kwargs = dict(
        message=_ctx_msg,
        session=sess,
        use_web=use_web and not skip_web,
        use_memory=mem_enabled,
        time_filter=time_filter,
        preset_system_prompt=preset.system_prompt,
        owner=user,
        character_name=preset.character_name,
        agent_mode=agent_mode,
        incognito=incognito,
        use_skills=skills_enabled,
    )
    if use_rag is not None:
        _preface_kwargs["use_rag"] = use_rag_val
    preface, rag_sources, web_sources = chat_processor.build_context_preface(**_preface_kwargs)

    # 立即捕获已使用的记忆
    used_memories = getattr(chat_processor, '_last_used_memories', [])

    # 注入预获取的搜索上下文（比较模式）
    if search_context and allow_tool_preprocessing:
        preface.append(untrusted_context_message("prefetched search context", search_context))

    # YouTube 转录
    for transcript in preprocessed.youtube_transcripts:
        preface.append(untrusted_context_message("youtube transcript", transcript))

    # 规范化模型 ID。优先使用缓存的端点模型，以便群聊不会
    # 在每次参与者轮次时重新访问缓慢的本地 /models 端点。
    norm = _normalize_model_id_from_cache(sess) or normalize_model_id(
        sess.endpoint_url,
        sess.model,
        owner=getattr(sess, "owner", None),
    )
    if norm:
        sess.model = norm

    # 构建消息
    messages = preface + sess.get_context_messages()

    # 自动压缩
    messages, context_length, was_compacted = await maybe_compact(
        sess, sess.endpoint_url, sess.model, messages, sess.headers, owner=user,
    )
    messages = trim_for_context(messages, context_length)

    return ChatContext(
        preface=preface,
        rag_sources=rag_sources,
        web_sources=web_sources,
        used_memories=used_memories,
        messages=messages,
        context_length=context_length,
        was_compacted=was_compacted,
        user=user,
        uprefs=uprefs,
        preset=preset,
        preprocessed=preprocessed,
        auto_opened_docs=auto_opened_docs,
    )


def accumulate_token_usage(session_id: str, metrics: dict):
    """将输入/输出 token 计数累加到会话的运行总计中。"""
    in_t = metrics.get("input_tokens", 0)
    out_t = metrics.get("output_tokens", 0)
    if not (in_t or out_t):
        return
    db = SessionLocal()
    try:
        db_s = db.query(DBSession).filter(DBSession.id == session_id).first()
        if db_s:
            db_s.total_input_tokens = (db_s.total_input_tokens or 0) + in_t
            db_s.total_output_tokens = (db_s.total_output_tokens or 0) + out_t
            db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


def _normalize_thinking(text: str) -> str:
    """将内联思考模式包裹在 <think> 标签中，使其在重新加载时持久化。

    处理：
    - "Thinking Process:"（Qwen3.5）
    - Gemma 风格的内联推理（"The user said/asked..."、"I should/need to..."）
    - 损坏的 <think> 标签（标签前的推理、未闭合的标签）
    """
    import re
    if not text:
        return text
    from src.text_helpers import normalize_thinking_markup
    text = normalize_thinking_markup(text)
    reasoning_prefix_re = re.compile(
        r'^\s*(?:thinking(?:\s+process)?\s*:|the user |i need |i should |i will |they are |the question |i can )',
        re.IGNORECASE,
    )
    thinking_prefix_re = re.compile(r'^thinking(?:\s+process)?\s*:\s*', re.IGNORECASE)

    # 处理乱码的 <think> 标签：推理文本后跟 <think> 作为分隔符
    # e.g. "The user said...I should respond.\n<think>Hey! What's up?"
    garbled = re.match(
        r'^([\s\S]+?)\n*<think(?:ing)?>\s*([\s\S]*?)(?:</think(?:ing)?>)?\s*$',
        text, re.IGNORECASE
    )
    if garbled:
        before = garbled.group(1).strip()
        after = garbled.group(2).strip()
        # 仅当 <think> 之前的部分看起来像推理时才视为乱码
        reasoning_starts = (
            'The user ', 'I need ', 'I should ', 'I will ',
            'They are ', 'The question ', 'I can ',
            'Thinking Process', 'Thinking:',
        )
        stripped_before = before.lstrip()
        if any(stripped_before.startswith(p) for p in reasoning_starts) or reasoning_prefix_re.match(stripped_before):
            # 从 thinking 内容中移除 "Thinking:" 前缀
            stripped_before = thinking_prefix_re.sub('', stripped_before)
            return '<think>' + stripped_before + '</think>\n' + after

    if '<think' in text.lower():
        return text  # already has proper think tags

    # Qwen3.5："Thinking Process:" 或 "Thinking:" 前缀
    if thinking_prefix_re.match(text.lstrip()):
        # 首先尝试干净的边界
        m = re.match(
            r'^(Thinking(?:\s+Process)?:[\s\S]*?)(\n\n(?=[A-Z]|Hey|Yo|Hi|Sure|I |What|Here|Let|The |This |OK|Ok|Yes|No |So |Well |Thank|Alright|Of course|Absolutely|Great|Hello|As ))',
            text, re.IGNORECASE | re.MULTILINE
        )
        if m:
            think = thinking_prefix_re.sub('', m.group(1)).strip()
            return '<think>' + think + '</think>' + text[m.end()-2:]
        # 回退：查找最后一段非缩进段落作为回复
        parts = text.split('\n\n')
        for i in range(len(parts) - 1, 0, -1):
            line = parts[i].strip()
            if line and not re.match(r'^[\d*\-\s(]', line) and len(line) > 5:
                think = thinking_prefix_re.sub('', '\n\n'.join(parts[:i])).strip()
                reply = '\n\n'.join(parts[i:])
                return '<think>' + think + '</think>\n\n' + reply
        # 最后手段：在 thinking 中查找引用的最终响应
        # Qwen 通常将回复起草为 "Option: ..." 或 * "回复文本"
        last_quote = re.findall(r'["\u201c]([^"\u201d]{10,})["\u201d]', text)
        if last_quote:
            reply = last_quote[-1].strip()
            think = thinking_prefix_re.sub('', text).strip()
            return '<think>' + think + '</think>\n\n' + reply
        # 确实没有找到回复
        think = thinking_prefix_re.sub('', text).strip()
        return '<think>' + think + '</think>'

    # Gemma 风格：以推理开头（"The user"、"I need"、"I should" 等）
    stripped_text = text.lstrip()
    first_line = stripped_text.split('\n')[0].strip()
    reasoning_starts = (
        'The user ', 'I need ', 'I should ', 'I will ',
        'They are ', 'The question ', 'I can ',
    )
    reply_starts = (
        'Hey', 'Hi ', 'Hi!', 'Hello', 'Sure', 'Yes', 'No ', 'No,', 'Yo', 'OK',
        'Here', 'Absolutely', 'Of course', 'Great', 'Alright',
        'Thanks', 'Welcome', 'Good ', "I'm happy", "I'd be",
    )
    if any(first_line.startswith(p) for p in reasoning_starts):
        # 先尝试逐行分割
        lines = stripped_text.split('\n')
        for i, line in enumerate(lines):
            stripped = line.strip()
            if not stripped:
                continue
            if i > 0 and any(stripped.startswith(p) for p in reply_starts):
                think = '\n'.join(lines[:i])
                reply = '\n'.join(lines[i:])
                return '<think>' + think + '</think>\n' + reply

        # 尝试行内分割 — 模型将 thinking + reply 混合在一行中
        # 在句号或句子结尾后查找回复模式
        for p in reply_starts:
            # 匹配："...推理文本。回复文本" 或 "...推理文本。回复文本"
            pattern = r'([.!?])\s*(' + re.escape(p) + r')'
            m = re.search(pattern, stripped_text)
            if m and m.start() > 20:  # at least 20 chars of reasoning before
                think = stripped_text[:m.start() + 1]  # include the period
                reply = stripped_text[m.start() + 1:].lstrip()
                return '<think>' + think + '</think>\n' + reply

        # 最后手段：查找最后一行非推理行
        for i in range(len(lines) - 1, 0, -1):
            stripped = lines[i].strip()
            if stripped and not any(stripped.startswith(p) for p in reasoning_starts) and not stripped.startswith('*') and len(stripped) > 3:
                think = '\n'.join(lines[:i])
                reply = '\n'.join(lines[i:])
                return '<think>' + think + '</think>\n' + reply

    return text


def _extract_thinking_meta(text: str) -> dict | None:
    """将思考内容提取到元数据中，返回 {thinking, reply, time} 或 None。"""
    import re
    if not text:
        return None
    from src.text_helpers import normalize_thinking_markup
    original_text = text
    text = normalize_thinking_markup(text)
    normalized_changed = text != original_text

    # 检查 <think> 标签（原生或注入的）
    time_match = re.search(r'<think(?:ing)?\s+time="([\d.]+)"', text)
    think_time = time_match.group(1) if time_match else None
    # 移除 time 属性以进行解析
    clean = re.sub(r'<think(?:ing)?\s+time="[\d.]+"', '<think', text)

    think_match = re.match(r'^[\s]*<think(?:ing)?>([\s\S]*?)</think(?:ing)?>\s*([\s\S]*)', clean, re.IGNORECASE)
    if think_match:
        thinking = think_match.group(1).strip()
        reply = think_match.group(2).strip()
        # 只有当还有实际回复剩下来时才将思考内容提取到元数据中。
        # 如果回复为空（模型在 <think> 内部达到 max_tokens，或者
        # 该轮次仅是推理），将原始文本作为内容保留 — 否则
        # 保存的消息内容为空，气泡在重新加载时看起来是空白的。
        # 渲染器的 processWithThinking 仍会在显示时提取
        # <think> 块，所以正常情况没有变化。
        if thinking and reply:
            return {"thinking": thinking, "reply": reply, "time": think_time}

    # 检测 Thinking Process：或 Gemma 风格推理
    normalized = _normalize_thinking(text)
    if '<think>' in normalized:
        think_match2 = re.match(r'^[\s]*<think(?:ing)?>([\s\S]*?)</think(?:ing)?>\s*([\s\S]*)', normalized, re.IGNORECASE)
        if think_match2:
            thinking = think_match2.group(1).strip()
            reply = think_match2.group(2).strip()
            if thinking and reply:
                return {"thinking": thinking, "reply": reply, "time": think_time}

    if normalized_changed and text.strip() and text.strip() != original_text.strip():
        return {"thinking": "", "reply": text.strip(), "time": think_time}

    return None


def clean_thinking_for_save(content: str, metadata: dict | None = None) -> tuple[str, dict]:
    """从内容中提取思考到元数据。用于绕过 save_assistant_response 的保存路径。"""
    md = dict(metadata) if metadata else {}
    info = _extract_thinking_meta(content)
    if info:
        if info.get("thinking"):
            md["thinking"] = info["thinking"]
        if info.get("time"):
            md["thinking_time"] = info["time"]
        return info["reply"], md
    return content, md


def save_assistant_response(
    sess,
    session_manager,
    session_id: str,
    full_response: str,
    last_metrics: dict | None,
    *,
    character_name: str = None,
    web_sources: list = None,
    rag_sources: list = None,
    research_sources: list = None,
    used_memories: list = None,
    do_research: bool = False,
    tool_events: list = None,
    incognito: bool = False,
):
    """添加助手回复到会话历史。在隐身模式下，保留内存上下文但跳过数据库持久化。"""
    md = dict(last_metrics) if last_metrics else {}
    def _model_value(value) -> str:
        if value is None:
            return ""
        if not isinstance(value, str):
            value = str(value)
        return value.strip()

    requested_model = _model_value(md.get("requested_model") or md.get("selected_model") or getattr(sess, "model", ""))
    actual_model = _model_value(md.get("model") or md.get("actual_model") or requested_model)
    if requested_model:
        md["requested_model"] = requested_model
    if actual_model:
        md["model"] = actual_model
    if character_name:
        md["character_name"] = character_name
    if web_sources:
        md["web_sources"] = web_sources
    if rag_sources:
        md["rag_sources"] = rag_sources
    if research_sources:
        md["research_sources"] = research_sources
    if used_memories:
        md["memories_used"] = used_memories
    if do_research and not research_sources:
        md["research_clarification"] = True
    if tool_events:
        md["tool_events"] = tool_events

    # 将思考内容提取到元数据中（不要用 <think> 标签污染消息内容）
    _think_info = _extract_thinking_meta(full_response)
    if _think_info:
        if _think_info.get("thinking"):
            md["thinking"] = _think_info["thinking"]
        if _think_info.get("time"):
            md["thinking_time"] = _think_info.get("time")
        _content = _think_info["reply"]
    else:
        _content = full_response
    sess.add_message(ChatMessage("assistant", _content, metadata=md))

    if not incognito:
        from core.database import update_session_last_accessed
        update_session_last_accessed(session_id)
        session_manager.save_sessions()

    # 返回已持久化消息的数据库 id，以便流式传输可以将其连接到
    # 刚渲染的气泡 — 让用户无需重新加载即可编辑/删除刚流式传输的回复。
    # 隐身模式返回 None：这些消息是临时的，
    # 所以不为它们提供编辑/删除的句柄。
    if incognito:
        return None
    try:
        _last = sess.history[-1]
        _meta = getattr(_last, "metadata", None)
        if isinstance(_meta, dict):
            return _meta.get("_db_id")
    except (IndexError, AttributeError):
        pass
    return None


def run_post_response_tasks(
    sess,
    session_manager,
    session_id: str,
    message: str,
    full_response: str,
    last_metrics: dict | None,
    uprefs: dict,
    memory_manager,
    memory_vector,
    webhook_manager,
    *,
    incognito: bool = False,
    compare_mode: bool = False,
    character_name: str = None,
    agent_rounds: int = 0,
    agent_tool_calls: int = 0,
    skills_manager=None,
    owner: str = None,
    extract_skills: bool = True,
    allow_background_extraction: bool = True,
):
    """在响应完成后触发后台任务：记忆提取、webhook、自动命名、技能提取。"""
    # 记忆提取 — 仅每第 4 对消息执行以避免过多 LLM 调用
    _msg_count = len(sess.history) if hasattr(sess, 'history') else 0
    _should_extract = (_msg_count >= 4) and (_msg_count % 4 == 0)
    if allow_background_extraction and not incognito and not compare_mode and _should_extract and uprefs.get("auto_memory", True):
        from services.memory.memory_extractor import extract_and_store
        from src.task_endpoint import resolve_task_endpoint
        t_url, t_model, t_headers = resolve_task_endpoint(
            sess.endpoint_url, sess.model, sess.headers, owner=owner,
        )
        asyncio.create_task(extract_and_store(
            sess, memory_manager, memory_vector,
            t_url, t_model, t_headers,
        ))

    # 从复杂 agent 运行中提取技能。仅在用户实际使用了 agent 工具时。
    # chose agent mode — not a chat we auto-escalated for a notes/calendar
    # intent, and never in incognito/compare.
    auto_skills_enabled = bool(uprefs.get("auto_skills", True))
    # 默认保持安静 — 完整的 gate/dispatch/start 跟踪在 DEBUG 级别运行，
    # users can re-enable diagnostics with LOG_LEVEL=DEBUG when something
    # silently breaks. INFO-level only shows the outcome inside
    # maybe_extract_skill (Auto-extracted / dropped / failed).
    logger.debug(
        "[skill-extract] gate: extract_skills=%s auto_skills=%s incognito=%s "
        "compare=%s rounds=%d tools=%d skills_manager=%s",
        extract_skills, auto_skills_enabled, incognito, compare_mode,
        agent_rounds, agent_tool_calls, "set" if skills_manager else "MISSING",
    )
    if (
        extract_skills
        and allow_background_extraction
        and auto_skills_enabled
        and not incognito
        and not compare_mode
        and (agent_rounds >= 2 or agent_tool_calls >= 2)
    ):
        if skills_manager is None:
            logger.warning(
                "[skill-extract] gate PASSED but skills_manager is None — "
                "extraction skipped. (Bug: caller didn't pass skills_manager.)"
            )
        else:
            from services.memory.skill_extractor import maybe_extract_skill
            from src.task_endpoint import resolve_task_endpoint
            s_url, s_model, s_headers = resolve_task_endpoint(
                sess.endpoint_url, sess.model, sess.headers, owner=owner,
            )
            logger.debug("[skill-extract] dispatching extractor (model=%s)", s_model)
            asyncio.create_task(maybe_extract_skill(
                sess, skills_manager,
                s_url, s_model, s_headers,
                agent_rounds, agent_tool_calls,
                owner=owner,
            ))

    # Token 累积
    if last_metrics:
        accumulate_token_usage(session_id, last_metrics)

    # Webhook
    if webhook_manager and not compare_mode:
        asyncio.create_task(webhook_manager.fire("chat.completed", {
            "session_id": session_id, "model": sess.model,
            "user_message": message, "response": full_response[:2000],
        }))

    # 自动命名
    if needs_auto_name(sess.name):
        asyncio.create_task(auto_name_session(session_manager, sess))
