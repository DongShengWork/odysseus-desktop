# src/research_handler.py
"""研究服务集成处理器，支持可展开的 UI。

使用 IterResearch 风格的 DeepResearcher（LLM-in-the-loop）作为主要
engine, falling back to the legacy ResearchOrchestrator or basic web search
if needed.

包含任务注册表，使得研究在页面刷新后仍然存活，并且可以被取消。
"""
import asyncio
import json
import logging
import re
import time
from pathlib import Path
from typing import Optional, Dict

from src.research_utils import strip_thinking, is_low_quality
from src.constants import DEEP_RESEARCH_DIR

logger = logging.getLogger(__name__)

RESEARCH_DATA_DIR = Path(DEEP_RESEARCH_DIR)
_RESEARCH_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,128}$")


def _bounded_int(value, *, default: int, minimum: int, maximum: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, n))


def _format_probe_failure(model: str, exc: Exception) -> str:
    """将失败的研究模型探测转换为面向用户的消息。"""
    detail = getattr(exc, "detail", None)
    status = getattr(exc, "status_code", None)
    err = str(detail if detail is not None else exc).strip()

    if status in {401, 403} or "401" in err or "API key" in err or "Unauthorized" in err:
        return f"Model '{model}' requires an API key. Check your endpoint configuration."

    if status and err:
        return f"Model '{model}' probe failed: {err}"

    if err:
        return f"Cannot reach model '{model}' — {err}"

    return f"Cannot reach model '{model}' — check that the endpoint is running and accessible."


def _research_json_path(session_id: str) -> Optional[Path]:
    if not isinstance(session_id, str) or not _RESEARCH_SESSION_ID_RE.fullmatch(session_id):
        return None
    root = RESEARCH_DATA_DIR.resolve()
    path = (RESEARCH_DATA_DIR / f"{session_id}.json").resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path


class ResearchHandler:
    """处理研究服务操作，支持迭代深度研究。"""

    def __init__(self):
        self._legacy_engine = None
        self._active_tasks: Dict[str, dict] = {}
        self._initialize_legacy_engine()
        RESEARCH_DATA_DIR.mkdir(parents=True, exist_ok=True)

    def _initialize_legacy_engine(self):
        """初始化旧版研究引擎作为回退。"""
        try:
            from research_engine import ResearchOrchestrator, Config
            config = Config(max_searches=12, max_content_per_page=15000)
            self._legacy_engine = ResearchOrchestrator(config)
            logger.info("Legacy ResearchOrchestrator initialized (fallback)")
        except ImportError:
            logger.info("Legacy research_engine.py not found — DeepResearcher only")
            self._legacy_engine = None
        except Exception as e:
            logger.warning(f"Legacy research engine init failed: {e}")
            self._legacy_engine = None

    # ------------------------------------------------------------------
    # 查询综合与规划
    # ------------------------------------------------------------------

    async def synthesize_query(
        self, sess, latest_message: str,
        llm_endpoint: str, llm_model: str, llm_headers: dict = None,
    ) -> str:
        """将对话综合为单个集中的研究查询。

        读取会话历史和最新消息，生成一个清晰、
        具体的能捕捉用户完整意图的研究问题。
        如果综合失败，回退到最新消息。
        """
        # 从历史中构建对话上下文
        history = getattr(sess, 'history', [])

        # 裸确认（"yes", "ok", "go ahead"）是用户接受
        # 澄清问题轮次的回应，而非研究主题 — 研究 "yes" 这个单词
        # 是这里典型的失败情况。当综合无法运行或失败时，
        # 回退到最早的用户实质性消息（原始提问）
        # 而非字面跟进消息。
        #
        # Match on an explicit affirmation/continuation phrase only (plus the
        # empty/punctuation-only case). We deliberately do NOT use a length
        # heuristic: a short answer like "UK", "C++", or "Rust" is a real topic
        # in a clarification flow and must be left untouched.
        _AFFIRMATIONS = {
            "yes", "y", "yeah", "yep", "yup", "sure", "sure thing", "ok", "okay",
            "k", "kk", "go", "go ahead", "go for it", "do it", "please",
            "yes please", "sounds good", "continue", "proceed", "lets go",
            "let's go", "yes go ahead",
        }

        def _normalize(text: str) -> str:
            return (text or "").strip().lower().strip("!.? ")

        def _fallback() -> str:
            normalized = _normalize(latest_message)
            if normalized and normalized not in _AFFIRMATIONS:
                return latest_message  # 短或长，它是真正的主题
            # 确认，或空/仅标点：使用原始提问。
            for m in history:
                c = (m.content or "").strip()
                if m.role == "user" and c and _normalize(c) not in _AFFIRMATIONS:
                    return c
            return latest_message

        if len(history) <= 1:
            return _fallback()  # 没有对话可综合

        # 最多取最近 6 条消息用作上下文
        recent = history[-6:]
        convo = "\n".join(
            f"{'User' if m.role == 'user' else 'Assistant'}: {m.content[:500]}"
            for m in recent if m.content
        )
        convo += f"\nUser: {latest_message}"

        try:
            from src.llm_core import llm_call_async

            response = await llm_call_async(
                url=llm_endpoint,
                model=llm_model,
                messages=[{"role": "user", "content":
                    "Read this conversation and write a single, specific research query that captures "
                    "what the user wants to know. Include all relevant context, constraints, and preferences "
                    "they mentioned. Output ONLY the research query — nothing else.\n\n"
                    f"Conversation:\n{convo}"
                }],
                temperature=0.1,
                max_tokens=200,
                headers=llm_headers,
                timeout=15,
                max_retries=1,
            )
            query = strip_thinking(response).strip().strip('"\'')
            if query and len(query) > 5:
                return query
        except Exception as e:
            logger.warning(f"Query synthesis failed: {e}")

        return _fallback()

    async def generate_plan(
        self, query: str, llm_endpoint: str, llm_model: str, llm_headers: dict = None,
    ) -> Optional[dict]:
        """生成研究计划供用户在开始研究前审查。"""
        try:
            from src.deep_research import RESEARCH_PLAN_PROMPT, current_date_context
            from src.llm_core import llm_call_async

            prompt = current_date_context() + RESEARCH_PLAN_PROMPT.format(question=query)
            response = await llm_call_async(
                url=llm_endpoint,
                model=llm_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=1024,
                headers=llm_headers,
                timeout=30,
                max_retries=1,
            )
            response = strip_thinking(response)

            # 尝试解析结构化计划
            import json as _json
            parsed = None
            try:
                # 尝试从响应中提取 JSON
                _clean = response.strip()
                if _clean.startswith("```"):
                    _clean = re.sub(r'^```(?:json)?\s*', '', _clean)
                    _clean = re.sub(r'\s*```$', '', _clean)
                import re as _re
                _match = _re.search(r'\{[\s\S]*\}', _clean)
                if _match:
                    parsed = _json.loads(_match.group())
            except Exception:
                pass

            return {
                "sub_questions": parsed.get("sub_questions", []) if parsed else [],
                "key_topics": parsed.get("key_topics", []) if parsed else [],
                "success_criteria": parsed.get("success_criteria", "") if parsed else "",
                "raw": response,
            }
        except Exception as e:
            logger.warning(f"Research plan generation failed: {e}")
            return None

    # ------------------------------------------------------------------
    # 任务注册表 — 带持久化的后台研究
    # ------------------------------------------------------------------

    def rename_owner(self, old_owner: str, new_owner: str) -> int:
        """Move in-flight research tasks from one owner key to another."""
        old_key = str(old_owner or "").strip().lower()
        new_key = str(new_owner or "").strip().lower()
        if not old_key or not new_key:
            return 0

        changed = 0
        for entry in list(self._active_tasks.values()):
            if not isinstance(entry, dict):
                continue
            if str(entry.get("owner", "")).strip().lower() == old_key:
                entry["owner"] = new_key
                changed += 1
        return changed

    def start_research(
        self,
        session_id: str,
        query: str,
        llm_endpoint: str,
        llm_model: str,
        max_time: int = 300,
        hard_timeout: int = None,
        llm_headers: dict = None,
        on_complete: callable = None,
        prior_report: str = "",
        prior_findings: list = None,
        prior_urls: set = None,
        max_rounds: int = 20,
        search_provider: str = None,
        category: str = None,
        extraction_timeout: int = None,
        extraction_concurrency: int = None,
        owner: str = "",
    ) -> dict:
        """将研究作为后台任务启动。返回任务信息字典。

        max_rounds 是安全上限；AI 的 _should_stop 决策（在
        min_rounds 之后）在正常操作中会提前终止循环。
        """
        if _research_json_path(session_id) is None:
            raise ValueError("Invalid research session_id")

        # 解析 the hard wall-clock 超时 from settings when the caller
        # didn't pin one. Local / edge models routinely need more than the
        # old 600s default to finish a deep-research synthesis. A setting of
        # 0 disables the cap entirely (unlimited run); any other value is
        # 被限制在 [60, 86400] 范围内，因此错误配置的 settings.json 不会
        # explode into a multi-day hang.
        if hard_timeout is None:
            from src.settings import get_setting
            try:
                raw_timeout = int(get_setting("research_run_timeout_seconds", 1800))
            except (TypeError, ValueError):
                raw_timeout = 1800
            if raw_timeout <= 0:
                hard_timeout = None  # 0 = 无挂钟时间上限（asyncio.wait_for timeout=None）
            else:
                hard_timeout = _bounded_int(
                    raw_timeout,
                    default=1800,
                    minimum=60,
                    maximum=86400,
                )

        # 取消此会话的任何现有研究
        if session_id in self._active_tasks:
            existing = self._active_tasks[session_id]
            if existing.get("status") == "running":
                self.cancel_research(session_id)

        entry = {
            "task": None,
            "researcher": None,
            "query": query,
            "status": "running",
            "progress": {},
            "result": None,
            "started_at": time.time(),
            "category": category,
            # SECURITY: 跟踪所有权以便所有读取/保存可以按用户过滤。
            "owner": owner or "",
        }
        self._active_tasks[session_id] = entry

        def on_progress(event):
            entry["progress"] = event

        _completed = False

        def _guarded_complete(*args, **kwargs):
            nonlocal _completed
            if _completed:
                return
            _completed = True
            if on_complete:
                on_complete(*args, **kwargs)

        async def _run():
            # 硬挂钟超时 — 如果 LLM 调用挂起则保存部分结果
            # hard_超时 从 start_research() 传入
            try:
                result = await asyncio.wait_for(
                    self.call_research_service(
                        query, llm_endpoint, llm_model,
                        max_time=max_time,
                        progress_callback=on_progress,
                        _task_entry=entry,
                        llm_headers=llm_headers,
                        prior_report=prior_report,
                        prior_findings=prior_findings,
                        prior_urls=prior_urls,
                        max_rounds=max_rounds,
                        search_provider=search_provider,
                        category=category,
                        extraction_timeout=extraction_timeout,
                        extraction_concurrency=extraction_concurrency,
                    ),
                    timeout=hard_timeout,
                )
                entry["result"] = result
                entry["status"] = "done"
                self._save_result(session_id, entry)
                # 通过回调持久化到数据库（确保即使 SSE 断开结果也能保留）
                try:
                    sources = entry.get("sources", [])
                    researcher = entry.get("researcher")
                    findings = self._extract_raw_findings(researcher.findings) if researcher and researcher.findings else []
                    _guarded_complete(session_id, result, sources, findings)
                except Exception as cb_err:
                    logger.error(f"on_complete callback failed: {cb_err}")
            except asyncio.TimeoutError:
                logger.error(f"Research hard timeout ({hard_timeout}s) for session {session_id}")
                entry["status"] = "error"
                # 如果有部分结果，保存已有的
                researcher = entry.get("researcher")
                if researcher and researcher.evolving_report:
                    entry["result"] = self._format_research_report(
                        query, researcher.evolving_report,
                        researcher.get_stats(), hard_timeout,
                    )
                    entry["status"] = "done"
                    self._save_result(session_id, entry)
                    try:
                        sources = self._extract_sources(researcher.findings) if researcher.findings else []
                        findings = self._extract_raw_findings(researcher.findings) if researcher.findings else []
                        _guarded_complete(session_id, entry["result"], sources, findings)
                    except Exception as e:
                        logger.warning(f"on_complete callback failed in timeout branch: {e}")
                else:
                    entry["result"] = f"Research timed out after {hard_timeout}s. The model may be too slow for deep research."
                on_progress({"phase": "error", "message": f"Research timed out after {hard_timeout}s"})
            except asyncio.CancelledError:
                entry["status"] = "cancelled"
                raise
            except Exception as e:
                logger.error(f"Background research failed: {e}", exc_info=True)
                # 保留部分发现如果可用（镜像超时分支）
                researcher = entry.get("researcher")
                if researcher and researcher.evolving_report:
                    _elapsed = time.time() - entry["started_at"]
                    entry["result"] = self._format_research_report(
                        query, researcher.evolving_report,
                        researcher.get_stats(), _elapsed,
                    )
                    entry["status"] = "done"
                    self._save_result(session_id, entry)
                    try:
                        sources = self._extract_sources(researcher.findings) if researcher.findings else []
                        findings = self._extract_raw_findings(researcher.findings) if researcher.findings else []
                        _guarded_complete(session_id, entry["result"], sources, findings)
                    except Exception as cb_err:
                        logger.warning(f"on_complete callback failed in error branch: {cb_err}")
                    on_progress({"phase": "warning", "message": f"Research finished with errors — partial results saved ({_elapsed:.0f}s elapsed)"})
                else:
                    entry["result"] = str(e)
                    entry["status"] = "error"

        task = asyncio.create_task(_run())
        entry["task"] = task
        return {"session_id": session_id, "status": "running", "query": query}

    def get_status(self, session_id: str) -> Optional[dict]:
        """获取会话的当前研究状态。"""
        if session_id in self._active_tasks:
            entry = self._active_tasks[session_id]
            result = {
                "status": entry["status"],
                "progress": entry["progress"],
                "query": entry["query"],
                "started_at": entry["started_at"],
            }
            # avg_duration is a historical figure over completed reports on
            # disk; get_avg_duration() globs and JSON-parses the whole research
            # dir, so compute it at most once per active stream (memoized on the
            # entry) instead of on every ~1s SSE poll. The disk branch below
            # never used it, so it no longer pays that cost at all.
            if "_avg_duration" not in entry:
                entry["_avg_duration"] = self.get_avg_duration()
            avg = entry["_avg_duration"]
            if avg is not None:
                result["avg_duration"] = round(avg, 1)
            return result
        # 检查磁盘上的已完成研究（跳过已消费的结果）
        path = _research_json_path(session_id)
        if path is None:
            return None
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if data.get("consumed"):
                    return None
                return {
                    "status": data.get("status", "done"),
                    "progress": {},
                    "query": data.get("query", ""),
                    "started_at": data.get("started_at", 0),
                }
            except Exception:
                pass
        return None

    def cancel_research(self, session_id: str) -> bool:
        """取消会话中正在运行的研究。"""
        if session_id not in self._active_tasks:
            return False
        entry = self._active_tasks[session_id]
        if entry["status"] != "running":
            return False
        researcher = entry.get("researcher")
        if researcher:
            researcher.cancel()
        task = entry.get("task")
        if task and not task.done():
            task.cancel()
        entry["status"] = "cancelled"
        return True

    def get_result(self, session_id: str) -> Optional[str]:
        """获取已完成的研究结果。"""
        if session_id in self._active_tasks:
            entry = self._active_tasks[session_id]
            if entry["status"] in ("done", "error", "cancelled"):
                return entry.get("result")
        # 检查磁盘（跳过已消费的结果）
        path = _research_json_path(session_id)
        if path is None:
            return None
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if data.get("consumed"):
                    return None
                return data.get("result")
            except Exception:
                pass
        return None

    def get_sources(self, session_id: str) -> Optional[list]:
        """从研究发现中获取去重后的源列表。"""
        # 首先检查内存
        if session_id in self._active_tasks:
            entry = self._active_tasks[session_id]
            if entry.get("sources"):
                return entry["sources"]
            researcher = entry.get("researcher")
            if researcher and researcher.findings:
                return self._extract_sources(researcher.findings)
        # 检查磁盘
        path = _research_json_path(session_id)
        if path is None:
            return None
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                return data.get("sources")
            except Exception:
                pass
        return None

    def get_raw_findings(self, session_id: str) -> Optional[list]:
        """获取用于展示的每个原始来源发现。"""
        if session_id in self._active_tasks:
            entry = self._active_tasks[session_id]
            researcher = entry.get("researcher")
            if researcher and researcher.findings:
                return self._extract_raw_findings(researcher.findings)
        # 检查磁盘
        path = _research_json_path(session_id)
        if path is None:
            return None
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                return data.get("raw_findings")
            except Exception as e:
                logger.warning(f"Failed to read raw findings for {session_id}: {e}")
        return None

    @staticmethod
    def _extract_sources(findings: list) -> list:
        """从发现中提取去重的 [{url, title}]，过滤低质量的。"""
        seen = set()
        sources = []
        for f in findings:
            if not isinstance(f, dict):
                continue
            url = f.get("url", "")
            title = f.get("title", "") or url
            summary = f.get("summary", "") or f.get("evidence", "")
            if url and url not in seen and not is_low_quality(summary):
                seen.add(url)
                entry = {"url": url, "title": title}
                og_img = f.get("og_image", "")
                if og_img:
                    entry["image"] = og_img
                sources.append(entry)
        return sources

    @staticmethod
    def _extract_raw_findings(findings: list) -> list:
        """提取 [{url, title, summary}] 用于每个来源的发现展示，过滤垃圾。"""
        try:
            items = []
            for f in findings:
                if not isinstance(f, dict):
                    continue
                url = f.get("url", "")
                title = f.get("title", "") or "Untitled"
                summary = f.get("summary", "")
                evidence = f.get("evidence", "")
                content = summary if summary else (evidence[:2000] if evidence else "")
                if url and content and not is_low_quality(content):
                    items.append({"url": url, "title": title, "summary": content})
            return items
        except Exception as e:
            logger.warning(f"Failed to extract raw findings: {e}")
            return []

    def get_avg_duration(self) -> Optional[float]:
        """从磁盘上已完成的结果计算平均研究时长。"""
        durations = []
        try:
            for p in RESEARCH_DATA_DIR.glob("*.json"):
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                    if data.get("status") == "done":
                        started = data.get("started_at", 0)
                        completed = data.get("completed_at", 0)
                        if started and completed and completed > started:
                            durations.append(completed - started)
                except Exception:
                    continue
        except Exception:
            pass
        if durations:
            return sum(durations) / len(durations)
        return None

    def clear_result(self, session_id: str):
        """将结果标记为已消费，使其不会在刷新时重新渲染。

        保留磁盘上的 JSON 以便以后可以生成可视化报告。
        """
        self._active_tasks.pop(session_id, None)
        path = _research_json_path(session_id)
        if path is None:
            return
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                data["consumed"] = True
                path.write_text(json.dumps(data), encoding="utf-8")
            except Exception:
                pass

    def _save_result(self, session_id: str, entry: dict):
        """将已完成的研究结果持久化到磁盘。"""
        try:
            path = _research_json_path(session_id)
            if path is None:
                logger.error("Refusing to save research result for invalid session_id: %r", session_id)
                return
            # 提取并缓存源和原始发现
            sources = []
            raw_findings = []
            researcher = entry.get("researcher")
            if researcher and researcher.findings:
                sources = self._extract_sources(researcher.findings)
                raw_findings = self._extract_raw_findings(researcher.findings)
            entry["sources"] = sources

            data = {
                "query": entry["query"],
                "status": entry["status"],
                "result": entry["result"],
                "raw_report": entry.get("raw_report", ""),
                "sources": sources,
                "raw_findings": raw_findings,
                "stats": entry.get("stats"),
                "category": entry.get("category"),
                "started_at": entry["started_at"],
                "completed_at": time.time(),
                # SECURITY: 标记所有者以便路由处理器可以按用户过滤。
                "owner": entry.get("owner", ""),
            }
            path.write_text(json.dumps(data), encoding="utf-8")
            logger.info(f"Research result saved to {path}")
            try:
                from src.event_bus import fire_event
                fire_event("research_completed", entry.get("owner") or None)
            except Exception:
                logger.debug("research_completed event dispatch failed", exc_info=True)
        except Exception as e:
            logger.error(f"Failed to save research result: {e}")

    def _get_session_json(self, session_id: str) -> Optional[dict]:
        """加载会话保存的研究 JSON（如果存在）。"""
        path = _research_json_path(session_id)
        if path is None:
            return None
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                pass
        return None

    def get_report_html(self, session_id: str) -> Optional[str]:
        """为会话生成可视化 HTML 报告（始终从 JSON 重新生成最新版）。"""
        json_path = _research_json_path(session_id)
        if json_path is None:
            return None
        if not json_path.exists():
            logger.warning(f"No JSON found for visual report: {json_path}")
            return None

        try:
            from src.visual_report import generate_visual_report

            data = json.loads(json_path.read_text(encoding="utf-8"))
            report_md = data.get("raw_report") or data.get("result", "")
            html_content = generate_visual_report(
                question=data.get("query", ""),
                report_markdown=report_md,
                sources=data.get("sources"),
                stats=data.get("stats"),
                category=data.get("category"),
                session_id=session_id,
                hidden_images=data.get("hidden_images") or [],
            )
            logger.info(f"Visual report generated for {session_id}")
            return html_content
        except Exception as e:
            logger.error(f"Failed to generate visual report: {e}")
            return None

    def hide_image(self, session_id: str, image_url: str) -> bool:
        """将 image_url 添加到研究的持久化 hidden_images 列表中。"""
        path = _research_json_path(session_id)
        if path is None:
            return False
        if not path.exists():
            return False
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            hidden = data.get("hidden_images") or []
            if image_url not in hidden:
                hidden.append(image_url)
                data["hidden_images"] = hidden
                path.write_text(json.dumps(data), encoding="utf-8")
                logger.info(f"Hid image {image_url[:80]} for research {session_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to hide image: {e}")
            return False

    def unhide_all_images(self, session_id: str) -> bool:
        """清除研究的 hidden_images 列表。"""
        path = _research_json_path(session_id)
        if path is None:
            return False
        if not path.exists():
            return False
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data["hidden_images"] = []
            path.write_text(json.dumps(data), encoding="utf-8")
            logger.info(f"Cleared hidden_images for research {session_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to unhide images: {e}")
            return False

    @staticmethod
    async def _probe_endpoint(endpoint: str, model: str, headers: dict = None):
        """在研究开始之前快速探测 LLM 端点/模型是否响应。"""
        from src.llm_core import llm_call_async
        try:
            logger.info(f"Probing {model} at {endpoint} (has_auth={bool(headers and 'Authorization' in (headers or {}))})")
            await llm_call_async(
                url=endpoint,
                model=model,
                messages=[{"role": "user", "content": "hi"}],
                temperature=0,
                max_tokens=5,
                headers=headers,
                timeout=15,
                max_retries=1,
            )
            logger.info(f"Endpoint probe OK: {model}")
        except Exception as e:
            logger.error(f"Probe failed for {model}: {e}")
            raise RuntimeError(_format_probe_failure(model, e)) from e

    async def call_research_service(
        self,
        query: str,
        llm_endpoint: str,
        llm_model: str,
        max_time: int = 300,
        progress_callback=None,
        _task_entry: dict = None,
        llm_headers: dict = None,
        prior_report: str = "",
        prior_findings: list = None,
        prior_urls: set = None,
        max_rounds: int = 20,
        search_provider: str = None,
        category: str = None,
        extraction_timeout: int = None,
        extraction_concurrency: int = None,
    ) -> str:
        """
        使用 LLM-in-the-loop DeepResearcher 运行迭代深度研究。

        Args:
            query: 研究问题
            llm_endpoint: LLM 端点 URL，用于对话补全
            llm_model: 模型名称/ID
            max_time: 最大研究时间（秒，默认 5 分钟）
            _task_entry: 内部 - 用于存储 researcher 引用的注册表条目
            prior_report: 要继续的前一份报告。
            prior_findings: 要基于的先前发现。
            prior_urls: 已经访问过的 URL（不会重新获取）。

        Returns:
            格式化的研究报告，带可展开部分和摘要
        """
        is_continuation = bool(prior_report)
        logger.info(f"{'Continuing' if is_continuation else 'Starting'} IterResearch Deep Research")
        logger.info(f"Query: {query}")
        logger.info(f"LLM: {llm_endpoint} / {llm_model}")
        logger.info(f"Max time: {max_time}s")
        if is_continuation:
            logger.info(f"Prior: {len(prior_findings or [])} findings, {len(prior_urls or set())} URLs")

        # 在投入长时间的研究运行之前探测端点
        if progress_callback:
            progress_callback({"phase": "probing", "model": llm_model})
        await self._probe_endpoint(llm_endpoint, llm_model, llm_headers)

        try:
            from src.deep_research import DeepResearcher

            from src.settings import get_setting
            _max_report_tokens = int(get_setting("research_max_tokens", 16384))
            _extraction_timeout = _bounded_int(
                extraction_timeout if extraction_timeout is not None else get_setting("research_extraction_timeout_seconds", 90),
                default=90,
                minimum=15,
                maximum=3600,
            )
            _extraction_concurrency = _bounded_int(
                extraction_concurrency if extraction_concurrency is not None else get_setting("research_extraction_concurrency", 3),
                default=3,
                minimum=1,
                maximum=12,
            )
            _planning_timeout = _bounded_int(
                get_setting("research_planning_timeout_seconds", _extraction_timeout),
                default=_extraction_timeout,
                minimum=15,
                maximum=3600,
            )
            _query_timeout = _bounded_int(
                get_setting("research_query_timeout_seconds", _extraction_timeout),
                default=_extraction_timeout,
                minimum=15,
                maximum=3600,
            )

            researcher = DeepResearcher(
                llm_endpoint=llm_endpoint,
                llm_model=llm_model,
                llm_headers=llm_headers,
                max_rounds=max_rounds,
                min_rounds=max(2, max_rounds - 2),
                max_time=max_time,
                max_report_tokens=_max_report_tokens,
                extraction_timeout=_extraction_timeout,
                planning_timeout=_planning_timeout,
                query_timeout=_query_timeout,
                extraction_concurrency=_extraction_concurrency,
                progress_callback=progress_callback,
                search_provider=search_provider,
                category=category,
            )
            if _task_entry is not None:
                _task_entry["researcher"] = researcher

            start_time = time.time()
            report = await researcher.research(
                query,
                prior_report=prior_report,
                prior_findings=prior_findings,
                prior_urls=prior_urls,
            )
            elapsed = time.time() - start_time

            stats = researcher.get_stats()
            logger.info("IterResearch completed successfully")
            for key, value in stats.items():
                logger.info(f"  {key}: {value}")

            # 存储原始报告和统计信息用于视觉报告生成
            if _task_entry is not None:
                _task_entry["raw_report"] = strip_thinking(report)
                _task_entry["stats"] = stats

            return self._format_research_report(query, report, stats, elapsed)

        except Exception as e:
            logger.error(f"DeepResearcher failed: {e}", exc_info=True)
            return await self._fallback_research(query, llm_endpoint, llm_model, max_time, str(e))

    async def _fallback_research(
        self, query: str, llm_endpoint: str, llm_model: str,
        max_time: int, primary_error: str,
    ) -> str:
        """回退到旧版引擎，然后到基本网页搜索。"""
        # 尝试旧版编排器
        if self._legacy_engine:
            try:
                import asyncio
                logger.info("Falling back to legacy ResearchOrchestrator...")
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(
                    None, self._legacy_engine.start_research, query, max_time
                )
                stats = self._get_legacy_stats()
                elapsed = float(stats.get("Duration", "0").rstrip("s") or 0)
                return self._format_research_report(query, result, stats, elapsed)
            except Exception as e:
                logger.error(f"Legacy engine also failed: {e}")

        # 回退到基本网页搜索
        return self._handle_research_failure(query, primary_error)

    def _get_legacy_stats(self) -> dict:
        """从旧版研究引擎获取统计信息。"""
        if not self._legacy_engine:
            return {}
        try:
            tracker = self._legacy_engine.progress_tracker
            return {
                "Findings": len(self._legacy_engine.findings),
                "Sources": len(self._legacy_engine.source_reports),
                "Searches": tracker.counters['searches_executed'],
                "URLs": tracker.counters['urls_processed'],
            }
        except Exception:
            return {}

    def _format_research_report(
        self, query: str, full_report: str, stats: dict, elapsed: float,
    ) -> str:
        """格式化研究报告（仅 markdown — 源/发现由前端处理）。"""
        full_report = strip_thinking(full_report)
        summary_lines = [
            f"**Duration:** {elapsed:.1f}s",
            f"**Rounds:** {stats.get('Rounds', stats.get('Findings', '?'))}",
            f"**Queries:** {stats.get('Queries', stats.get('Searches', '?'))}",
            f"**URLs Analyzed:** {stats.get('URLs', '?')}",
        ]
        summary_text = " | ".join(summary_lines)

        formatted = f"""---

## Research Summary

{summary_text}

---

{full_report}
"""
        return formatted

    def _format_error_response(self, error_msg: str, query: str) -> str:
        """以用户友好的方式格式化错误响应。"""
        return f"""## Research Engine Unavailable

**Query:** {query}

**Error:** {error_msg}

**Please check:**
1. LLM endpoint is reachable
2. SearXNG is running at the configured instance
3. Application logs for detailed error information

**Troubleshooting:**
- Test basic search: Try the web search toggle first
- Check search config: `/api/search/config`
- Review logs for initialization errors
"""

    def _handle_research_failure(self, query: str, error: str) -> str:
        """处理研究失败，回退到基本搜索。"""
        try:
            logger.info("Attempting fallback to basic web search...")
            from src.search import comprehensive_web_search

            search_result = comprehensive_web_search(query)

            return f"""## Research Failed - Basic Search Fallback

**Query:** {query}

**Error:** {error}

**Note:** The deep research engine encountered an error. Here are basic search results instead:

---

### Basic Web Search Results

{search_result}

---

**To fix deep research:**
1. Check that your LLM endpoint and search provider are properly configured
2. Verify network connectivity
3. Review application logs for detailed error information

Try the web search toggle for simpler queries, or fix the research engine for comprehensive analysis.
"""

        except Exception as e2:
            logger.error(f"Fallback search also failed: {e2}", exc_info=True)
            return f"""## Complete Research Failure

**Primary Error:** {error}
**Fallback Error:** {str(e2)}

**Please check:**
1. Search provider configuration in Settings -> Search Settings
2. Network connectivity to search APIs
3. Application logs for detailed error information
4. That SearXNG is running (if using SearXNG)

**Debug Info:**
- Search config endpoint: `/api/search/config`
- Test basic search toggle with a simple query first
"""
