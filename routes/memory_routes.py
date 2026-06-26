# routes/memory_routes.py — 记忆路由
from fastapi import APIRouter, Form, HTTPException, Request, UploadFile, File
from typing import Dict, Any, Optional, List
import json
import os
import re
import tempfile
import time
from datetime import datetime
import logging

# 列表前缀正则，如 "1."、"12)" 或 "3:"，加上周围的空白。
# 每次调用只剥离一个前缀，这样从 LLM 输出导入时不会留下
# 编号在保存的记忆文本中。项目符号（-、*、•）也在此剥离。
_LIST_PREFIX_RE = re.compile(r"^\s*(?:\d{1,3}[.):]\s+|[-*•]\s+)")


def _strip_list_prefix(text: str) -> str:
    if not text:
        return text
    return _LIST_PREFIX_RE.sub("", text, count=1).strip()

from services.memory import MemoryManager
from core.session_manager import SessionManager
from src.request_models import MemoryAddRequest
from core.database import SessionLocal
from src.llm_core import llm_call_async
from services.memory.memory_extractor import audit_memories
from src.auth_helpers import get_current_user, require_user
from src.endpoint_resolver import resolve_endpoint
from src.task_endpoint import resolve_task_endpoint
from src.upload_limits import read_upload_limited, MEMORY_IMPORT_MAX_BYTES

logger = logging.getLogger(__name__)


def setup_memory_routes(memory_manager: MemoryManager, session_manager: SessionManager, memory_vector=None):
    """设置记忆相关的路由。"""
    router = APIRouter(prefix="/api/memory", tags=["memory"])

    def _owner(request: Request) -> Optional[str]:
        return get_current_user(request)

    def _assert_session_owner(session_obj, user):
        """安全：如果调用者不拥有此会话，返回 404。

        SessionManager.get_session 不是按所有者作用域的 — 它按 ID 返回任何
        会话。这些路由接受调用者提供的会话 ID，因此如果没有此门控，
        用户可能针对其他租户的会话，泄漏其聊天历史、会话作用域的 LLM
        凭据或会话标题。与 session_routes / webhook_routes 的所有权检查一致。
        """
        if user is not None and getattr(session_obj, "owner", None) != user:
            raise HTTPException(404, "Session not found")

    def _verify_memory_owner(memory: dict, user: Optional[str]):
        """如果用户不拥有此记忆，抛出 404。

        安全：严格所有权 — 之前 `mem_owner and mem_owner != user`
        允许任何用户读取/编辑/删除所有者字段为空/null 的记忆，
        这在多用户部署中泄漏了旧数据。
        """
        if user is None:
            return  # Auth disabled
        if memory.get("owner") != user:
            raise HTTPException(404, "Memory not found")

    @router.post("/debug")
    def debug_memory_relevance(request: Request, query: str = Form(...)):
        """调试哪些记忆会被查询触发"""
        user = _owner(request)
        memories = memory_manager.load(owner=user)
        relevant = memory_manager.get_relevant_memories(query, memories, threshold=0.05)

        return {
            "query": query,
            "total_memories": len(memories),
            "relevant_count": len(relevant),
            "relevant_memories": [{"text": m["text"], "category": m.get("category", "unknown")}
                                 for m in relevant]
        }

    @router.post("/add", response_model=Dict[str, Any])
    async def api_add_memory(
        request: Request,
        memory_data: Optional[MemoryAddRequest] = None
    ):
        """添加新的记忆条目，可选类别、来源和会话引用。"""
        from src.auth_helpers import require_privilege
        require_privilege(request, "can_manage_memory")
        if memory_data is None:
            form = await request.form()
            memory_data = MemoryAddRequest(
                text=form.get("text"),
                category=form.get("category", "fact"),
                source=form.get("source", "user"),
                session_id=form.get("session_id")
            )

        user = _owner(request)
        text = (memory_data.text or "").strip()
        if not text:
            raise HTTPException(400, "empty memory")
        user_mem = memory_manager.load(owner=user)
        if memory_manager.find_duplicates(text, user_mem):
            return {"ok": True, "count": len(user_mem), "message": "Memory already exists"}

        if memory_data.session_id:
            try:
                session_obj = session_manager.get_session(memory_data.session_id)
            except KeyError:
                raise HTTPException(404, "Session not found")
            _assert_session_owner(session_obj, user)

        new_entry = memory_manager.add_entry(text, memory_data.source, memory_data.category, owner=user)
        if memory_data.session_id:
            new_entry["session_id"] = memory_data.session_id
        all_mem = memory_manager.load_all()
        all_mem.append(new_entry)
        memory_manager.save(all_mem)
        # Sync vector 索引
        if memory_vector and memory_vector.healthy:
            memory_vector.add(new_entry["id"], text)
        try:
            from src.event_bus import fire_event
            fire_event("memory_added", user)
        except Exception:
            logger.debug("memory_added event dispatch failed", exc_info=True)
        return {"ok": True, "count": len([m for m in all_mem if m.get("owner") == user])}

    @router.get("")
    def api_get_memory(request: Request):
        """返回所有记忆条目及其元数据。"""
        user = _owner(request)
        return {"memory": memory_manager.load(owner=user)}

    @router.post("/search")
    def search_memories(request: Request, query: str = Form(...), session_id: str = Form(None), category: str = Form(None)):
        """搜索所有记忆，可选过滤器。"""
        user = _owner(request)
        memories = memory_manager.load(owner=user)

        if session_id:
            memories = [m for m in memories if m.get("session_id") == session_id]

        if category:
            memories = [m for m in memories if category in m.get("categories", [m.get("category", "")])]

        relevant = memory_manager.get_relevant_memories(query, memories, threshold=0.05, max_items=20)

        return {"memories": relevant, "total": len(relevant), "query": query}

    @router.get("/timeline")
    def memory_timeline(request: Request):
        """按时间顺序获取记忆，包含源会话信息。"""
        user = _owner(request)
        memories = memory_manager.load(owner=user)
        sorted_memories = sorted(memories, key=lambda x: x.get("timestamp", 0), reverse=True)

        results = []
        for memory in sorted_memories:
            if "timestamp" in memory:
                try:
                    dt = datetime.fromtimestamp(memory["timestamp"])
                    memory["timestamp_str"] = dt.strftime("%Y-%m-%d %H:%M:%S")
                except (ValueError, OSError, OverflowError):
                    memory["timestamp_str"] = "Unknown"
            else:
                memory["timestamp_str"] = "Unknown"

            session_id = memory.get("session_id")
            if session_id and session_id in session_manager.sessions:
                try:
                    session = session_manager.get_session(session_id)
                    if session:
                        _assert_session_owner(session, user)
                    memory["session_name"] = session.name if session else f"Session {session_id[:6]}"
                except KeyError:
                    memory["session_name"] = "Unknown"
                except HTTPException as exc:
                    if exc.status_code != 404:
                        raise
                    memory["session_name"] = "Unknown"
            else:
                memory["session_name"] = "Unknown"

            results.append(memory)

        return {"timeline": results, "total": len(results)}

    @router.get("/by-session/{session_id}")
    def get_memory_by_session(request: Request, session_id: str):
        """获取与特定会话关联的所有记忆。"""
        user = _owner(request)
        try:
            _session_obj = session_manager.get_session(session_id)
        except KeyError:
            raise HTTPException(404, f"Session {session_id} not found")
        _assert_session_owner(_session_obj, user)
        memories = memory_manager.load(owner=user)
        session_memories = [m for m in memories if m.get("session_id") == session_id]

        session_memories.sort(key=lambda x: x.get("timestamp", 0), reverse=True)

        try:
            session = session_manager.get_session(session_id)
            session_name = session.name if session else f"Session {session_id[:6]}"
        except KeyError:
            session_name = f"Session {session_id[:6]}"

        for memory in session_memories:
            memory["session_name"] = session_name

        return {
            "session_id": session_id,
            "session_name": session_name,
            "memory_count": len(session_memories),
            "memories": session_memories
        }

    @router.post("/extract")
    async def extract_memory(request: Request, session: str = Form(...)) -> Dict[str, List[str]]:
        """分析会话的聊天历史并返回记忆建议。"""
        require_user(request)
        try:
            sess = session_manager.get_session(session)
        except KeyError:
            raise HTTPException(404, "Session not found")
        _assert_session_owner(sess, _owner(request))

        system_msg = {
            "role": "system",
            "content": (
                "You are a helpful assistant. Analyze the entire conversation history provided and extract any "
                "useful factual statements, contacts, addresses, phone numbers, or other information that the user "
                "might want to remember for future interactions. Return each piece of information as a JSON object "
                "with a 'text' field. For example: [{'text': 'Alice lives at 123 Main St'}, {'text': 'Bob works at Acme Corp'}]. "
                "Only include information that is specific and likely to be useful later."
            ),
        }
        messages = [system_msg] + sess.get_context_messages()

        t_url, t_model, t_headers = resolve_task_endpoint(
            sess.endpoint_url, sess.model, sess.headers, owner=_owner(request)
        )

        try:
            suggestion_text = await llm_call_async(
                t_url,
                t_model,
                messages,
                temperature=0.2,
                max_tokens=500,
                headers=t_headers,
            )
            try:
                suggestions = json.loads(suggestion_text)
                if isinstance(suggestions, list):
                    suggestions = [s if isinstance(s, str) else s.get("text", "") for s in suggestions]
                else:
                    suggestions = []
            except json.JSONDecodeError:
                suggestions = [line.strip() for line in suggestion_text.splitlines() if line.strip()]

            return {"suggestions": [s for s in suggestions if s]}
        except Exception as e:
            logger.error(f"LLM memory extraction failed (session {session}): {e}")
            fallback = memory_manager.extract_memory_from_chat(sess.history, session)
            return {"suggestions": [item["text"] for item in fallback]}

    @router.post("/audit")
    async def api_audit_memories(request: Request, session: str = Form(None)):
        """通过 LLM 去重和合并记忆。

        Uses task/utility/default settings through the shared resolver, with
        the active session as fallback when no task or utility model is set.
        Returns before and after memory counts.
        """
        user = _owner(request)
        fallback_url = fallback_model = None
        fallback_headers = None
        if session:
            try:
                sess = session_manager.get_session(session)
                _assert_session_owner(sess, user)
                fallback_url = sess.endpoint_url
                fallback_model = sess.model
                fallback_headers = sess.headers
            except KeyError:
                pass

        endpoint_url, model, headers = resolve_task_endpoint(
            fallback_url, fallback_model, fallback_headers, owner=user
        )

        if not endpoint_url or not model:
            raise HTTPException(400, "No default model configured — set one in Settings")

        result = await audit_memories(
            memory_manager,
            memory_vector,
            endpoint_url,
            model,
            headers,
            owner=user,
        )

        if "error" in result and "before" not in result:
            raise HTTPException(502, f"Audit failed: {result['error']}")

        return {
            "ok": "error" not in result,
            "before": result.get("before", 0),
            "after": result.get("after", 0),
            "removed": result.get("before", 0) - result.get("after", 0),
            # True when the audit skipped the LLM because nothing changed
            # since the last tidy. Frontend already says "Already clean"
            # for removed==0, so this is here for future use / debugging.
            "already_tidy": bool(result.get("already_tidy")),
        }

    @router.post("/import")
    async def import_memories_from_file(
        request: Request,
        session: str | None = Form(None),
        file: UploadFile = File(...)
    ):
        """从上传的文件中提取记忆建议（PDF、TXT、MD 等）。"""
        from src.auth_helpers import require_privilege
        require_privilege(request, "can_manage_memory")

        endpoint_url = None
        model = None
        headers = {}

        user = _owner(request)

        if session:
            try:
                sess = session_manager.get_session(session)
                _assert_session_owner(sess, user)
            except KeyError:
                sess = None
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                sess = None

            if sess is None:
                logger.warning("Session %s not found or inaccessible, falling back to utility endpoint", session)
                endpoint_url, model, headers = resolve_endpoint("utility", owner=user)
            else:
                endpoint_url, model, headers = resolve_task_endpoint(
                    sess.endpoint_url, sess.model, sess.headers, owner=user
                )
        else:
            endpoint_url, model, headers = resolve_task_endpoint(owner=user)
    
        if not endpoint_url or not model:
            raise HTTPException(400, "No LLM model configured. Set a default model in Settings.")

        content = await read_upload_limited(file, MEMORY_IMPORT_MAX_BYTES, "Memory import")
        filename = file.filename or "upload"
        _, ext = os.path.splitext(filename.lower())

        allowed = {".txt", ".md", ".pdf", ".csv", ".log", ".json", ".py", ".js", ".html"}
        if ext not in allowed:
            raise HTTPException(400, f"Unsupported file type: {ext}")

        # 提取 text based on 文件类型
        if ext == ".pdf":
            from src.document_processor import _process_pdf
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                tmp.write(content)
                tmp_path = tmp.name
            try:
                text = _process_pdf(tmp_path, owner=_owner(request))
            finally:
                os.unlink(tmp_path)
        else:
            try:
                text = content.decode("utf-8")
            except UnicodeDecodeError:
                from charset_normalizer import detect
                encoding = (detect(content) or {}).get("encoding") or "utf-8"
                text = content.decode(encoding, errors="replace")

        if not text.strip():
            return {"suggestions": [], "message": "No readable content found"}

        # Fast path: a .json upload that already looks like a memories export
        # (list of {text, category, ...} dicts, or list of strings) round-trips
        # directly without spending an LLM call to re-extract its own output.
        # Without this, re-importing a memories.json from another account
        # ran the file through the extractor, which often re-emitted the
        # entries as a numbered list (and the numbering leaked into the
        # `text` field).
        if ext == ".json":
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, list) and parsed:
                direct = []
                for item in parsed:
                    if isinstance(item, dict) and item.get("text"):
                        direct.append({
                            "text": _strip_list_prefix(str(item["text"])),
                            "category": item.get("category") or "fact",
                        })
                    elif isinstance(item, str) and item.strip():
                        direct.append({
                            "text": _strip_list_prefix(item.strip()),
                            "category": "fact",
                        })
                if direct:
                    return {"suggestions": direct, "filename": filename}

        # Truncate very long documents
        if len(text) > 15000:
            text = text[:15000] + "\n[Truncated]"

        # 发送 to LLM for 记忆提取
        import_prompt = (
            "You are a memory extraction assistant. The user uploaded a document. "
            "Analyze the text below and extract specific, useful facts — things like "
            "names, preferences, jobs, locations, relationships, opinions, projects, "
            "goals, contacts, or any other personal details worth remembering.\n\n"
            "Rules:\n"
            "- Each fact should be a short, self-contained statement\n"
            "- Do NOT extract generic knowledge\n"
            "- Focus on personal, memorable information\n"
            "- If there are no useful facts, return an empty array\n\n"
            "Return a JSON array of objects with 'text' and 'category' fields.\n"
            "Categories: 'identity', 'preference', 'fact', 'contact', 'project', 'goal'\n\n"
            "Return ONLY valid JSON, no markdown fences."
        )

        try:
            raw = await llm_call_async(
                endpoint_url,
                model,
                [
                    {"role": "system", "content": import_prompt},
                    {"role": "user", "content": f"Document: {filename}\n\n{text}"},
                ],
                temperature=0.2,
                max_tokens=2000,
                headers=headers,
            )

            # 解析 JSON
            raw = raw.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

            suggestions = json.loads(raw)
            if isinstance(suggestions, list):
                normalized = []
                for s in suggestions:
                    if not s:
                        continue
                    if isinstance(s, dict):
                        s = dict(s)
                        if s.get("text"):
                            s["text"] = _strip_list_prefix(str(s["text"]))
                        normalized.append(s)
                    else:
                        normalized.append({"text": _strip_list_prefix(str(s)), "category": "fact"})
                suggestions = normalized
            else:
                suggestions = []

            return {"suggestions": suggestions, "filename": filename}

        except json.JSONDecodeError:
            # Fallback: split by lines, stripping any "1.", "2)" markdown-list
            # numbering the model added so saved memories don't keep the prefix.
            lines = [_strip_list_prefix(l.strip()) for l in raw.splitlines() if l.strip() and len(l.strip()) > 5]
            return {"suggestions": [{"text": l, "category": "fact"} for l in lines[:20]], "filename": filename}
        except Exception as e:
            logger.error(f"Memory import extraction failed: {e}")
            raise HTTPException(502, f"LLM extraction failed: {str(e)}")

    @router.post("/{memory_id}/pin")
    def pin_memory(request: Request, memory_id: str, pinned: bool = Form(True)):
        """固定或取消固定记忆。固定的记忆始终包含在上下文中。"""
        user = _owner(request)
        all_mem = memory_manager.load_all()
        for i, memory in enumerate(all_mem):
            if memory["id"] == memory_id:
                _verify_memory_owner(memory, user)
                all_mem[i]["pinned"] = pinned
                memory_manager.save(all_mem)
                return {"ok": True, "pinned": pinned}
        raise HTTPException(404, f"Memory item {memory_id} not found")

    # Wildcard routes MUST come last — otherwise they swallow /import, /search, etc.
    @router.get("/{memory_id}")
    def get_memory_item(request: Request, memory_id: str):
        """通过 ID 获取特定记忆项。"""
        user = _owner(request)
        memories = memory_manager.load(owner=user)
        for memory in memories:
            if memory["id"] == memory_id:
                return {"memory": memory}

        raise HTTPException(404, "Memory not found")

    @router.put("/{memory_id}")
    def update_memory(request: Request, memory_id: str, text: str = Form(...), category: str = Form(None)):
        """用新文本和可选类别更新现有记忆项。"""
        user = _owner(request)
        all_mem = memory_manager.load_all()
        for i, memory in enumerate(all_mem):
            if memory["id"] == memory_id:
                _verify_memory_owner(memory, user)
                all_mem[i]["text"] = text.strip()
                if category:
                    all_mem[i]["category"] = category
                all_mem[i]["timestamp"] = int(time.time())

                memory_manager.save(all_mem)
                # Sync vector 索引 (remove old, add updated)
                if memory_vector and memory_vector.healthy:
                    memory_vector.remove(memory_id)
                    memory_vector.add(memory_id, text.strip())
                return {"ok": True, "message": "Memory updated successfully"}

        raise HTTPException(404, f"Memory item {memory_id} not found")

    @router.delete("/{memory_id}")
    def delete_memory(request: Request, memory_id: str):
        """通过 ID 删除记忆项。"""
        user = _owner(request)
        all_mem = memory_manager.load_all()

        # Find and 验证 ownership before deleting
        target = next((m for m in all_mem if m["id"] == memory_id), None)
        if not target:
            raise HTTPException(404, f"Memory item {memory_id} not found")
        _verify_memory_owner(target, user)

        all_mem = [m for m in all_mem if m["id"] != memory_id]
        memory_manager.save(all_mem)
        # Sync vector 索引
        if memory_vector and memory_vector.healthy:
            memory_vector.remove(memory_id)
        return {"ok": True, "message": "Memory deleted successfully"}

    return router
