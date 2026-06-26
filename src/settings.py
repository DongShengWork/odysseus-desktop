# src/settings.py
"""集中式设置和功能管理。

读写 data/settings.json 和 data/features.json 的唯一真实来源。
所有模块都应从这里导入，而不是直接访问文件。
"""

import json
import time
import logging
from typing import Any

from src.constants import SETTINGS_FILE, FEATURES_FILE

logger = logging.getLogger(__name__)

# 设置/功能的小型 TTL 缓存。get_setting() 在热路径上被调用
#（每次聊天、每次预处理）；没有缓存时每次调用都会重新解析 JSON。
# 在 _CACHE_TTL 秒内会拾取到编辑，对于人工编辑的配置来说这是可以接受的。
_CACHE_TTL = 2.0
_settings_cache: tuple[float, dict] | None = None
_features_cache: tuple[float, dict] | None = None

def _invalidate_caches():
    global _settings_cache, _features_cache
    _settings_cache = None
    _features_cache = None

# ── Default values ──

DEFAULT_SETTINGS = {
    # Agent email safety: when True, the MCP send_email / reply_to_email
    # tools don't SMTP directly. They stage the composed message into the
    # scheduled_emails table with status='agent_draft' and return a
    # pending_id + the rendered email so the user can review and approve
    # (or cancel) before it actually goes out. Default ON because models
    # have been observed inventing 签名atures and sending to real
    # recipients without confirmation.
    "agent_email_confirm": True,
    "image_gen_enabled": False,
    "image_model": "",
    "image_quality": "medium",
    "vision_model": "",
    "vision_enabled": True,
    # Vision 模型的有序回退链（图像分析、OCR、标签）。
    "vision_model_fallbacks": [],
    # 用于构建外发告警（如紧急告警邮件）中可点击深度链接的公开基础 URL。
    # 示例："https://chat.example.com"
    "app_public_url": "",
    "tts_enabled": True,
    "tts_provider": "disabled",
    "tts_model": "tts-1",
    "tts_voice": "alloy",
    "tts_speed": "1",
    "stt_enabled": False,
    "stt_provider": "disabled",
    "stt_model": "base",
    "stt_language": "",
    "search_provider": "searxng",
    # 默认回退链——当主服务商失败或被限速时，
    # 接下来尝试 DuckDuckGo。免费，无需 API key，因此
    # 可以安全地对每个用户默认开启。
    "search_fallback_chain": ["duckduckgo"],
    "search_url": "",
    "search_result_count": 5,
    # 应用于每个支持该设置的服务商的 SafeSearch 级别。
    # "strict"   — 屏蔽成人/露骨内容（默认；符合用户对研究工具的
    #              期望，且避免无关的 NSFW URL 通过服务商
    #              "相关"/垃圾推荐混入）
    # "moderate" — 服务商默认行为（过滤露骨但允许
    #              暗示性内容）
    # "off"      — 完全禁用过滤（仅限高级用户）
    #
    # 遵循此设置的服务商（在 src/search/providers.py:_safesearch_for 中
    # 转换为各服务商的原生参数）：
    #     SearXNG       safesearch=0/1/2（JSON API、HTML 抓取、新闻回退）
    #     Brave Search  safesearch=off/moderate/strict
    #     DuckDuckGo    safesearch=off/moderate/on（库 + HTML kp 参数）
    #     Google PSE    safe=active（"off" 时省略；PSE 没有中间级别）
    #     Serper.dev    safe=active（"off" 时省略；代理 Google 的 `safe`）
    # 不受影响的服务商：Tavily（没有 SafeSearch 开关；在索引时过滤）
    # 以及通过 search_url 访问的任何自定义后端——它们保持后端自身
    # 决定的设置，因此运维人员保持对自托管/
    # 小众搜索实例的控制。
    "search_safesearch": "strict",
    "brave_api_key": "",
    "google_pse_key": "",
    "google_pse_cx": "",
    "tavily_api_key": "",
    "serper_api_key": "",
    "research_endpoint_id": "",
    "research_model": "",
    "research_search_provider": "",
    "research_max_tokens": 16384,
    "research_extraction_timeout_seconds": 90,
    # 轻量级的规划/查询 LLM 调用在任何搜索开始之前发生。
    # 保持它们可独立调节，以免慢速本地后端受到
    # 旧的 30s/60s 每次调用默认值的限制。
    "research_planning_timeout_seconds": 90,
    "research_query_timeout_seconds": 90,
    "research_extraction_concurrency": 3,
    # 单次深度研究运行的硬性墙钟时间上限。之前的 600s
    #（10 分钟）默认值会在合成中途截断慢速本地/边缘 LLM；1800s
    #（30 分钟）对大多数本地设置足够舒适，同时仍然限制
    # 失控的作业。设置为 0 完全禁用上限（无限）——仅用于
    # 非常长的深度研究运行，因为停滞的作业会无限期地
    # 产生模型/API 费用。其他值被限制在 [60, 86400] 范围内。
    # 通过设置或编辑 data/settings.json 进行调整。
    "research_run_timeout_seconds": 1800,
    "agent_max_tool_calls": 0,
    "agent_max_rounds": 20,  # 每条消息的 agent 步数上限（限制在 1..200）
    # Soft input-token budget for the 智能体循环. The DEFAULT value (6000) is the
    # "auto" sentinel: it means "scale the budget to the model's 上下文窗口"
    # (#1230) — so long-context models aren't capped at 6000. 设置 ANY OTHER value
    # to enforce an explicit cap (clamped to the window only — hard_max does not
    # apply to explicit budgets, #1230); set 0 to disable soft-trimming. The
    # default is treated as auto because the settings-save path materializes
    # defaults, so a persisted 6000 can't be told apart from a deliberate 6000 —
    # to pin a budget near the default, use a nearby value (e.g. 5999).
    "agent_input_token_budget": 6000,
    # Ceiling on the *auto-derived* input budget; a configurable setting since #1273
    # (the merged #1230 left it a module constant). No effect on an explicit budget
    # — a deliberate value is honoured (#1230). Default matches
    # `src.context_budget.DEFAULT_HARD_MAX`; lower this for
    # cost-paranoid setups, raise it on premium APIs with very large windows you
    #（例如 900_000 以填充 1M 上下文的模型）提高该值。参见
    # `compute_input_token_budget`.
    "agent_input_token_hard_max": 200_000,
    "agent_stream_timeout_seconds": 300,
    # read_file / write_file 可以访问的额外目录根，在
    # 内置的 data/ 和系统临时目录之外。每个
    # 条目是绝对路径。敏感子路径（.ssh、.gnupg、shell
    # rc 文件、SSH key 文件）无论根目录如何，始终被阻止。
    "tool_path_extra_roots": [],
    "task_endpoint_id": "",
    "task_model": "",
    "default_endpoint_id": "",
    "default_model": "",
    # 默认聊天模型的有序回退链。每个条目是
    # {"endpoint_id": "...", "model": "..."}。如果主模型在
    # 产生输出之前失败（端点离线/出错），聊天
    # 调度会按顺序重试下一个条目。
    "default_model_fallbacks": [],
    "utility_endpoint_id": "",
    "utility_model": "",
    # 实用模型的有序回退链（摘要、命名、
    # 整理操作等）。
    "utility_model_fallbacks": [],
    "teacher_model": "",
    "teacher_enabled": False,
    # 技能：自动编写（LLM 创作）的草稿技能能被注入到 agent 提示中的
    # 最低自报置信度。已发布的技能始终
    # 合格。保持低置信度的自动技能在审核/发布前不进入上下文。
    # 0 禁用此门控。
    "skill_autosave_min_confidence": 0.85,
    # 单次请求中被注入到提示中的最大相关技能数。技能
    # 库可以超过此数量；清理/废弃是显式的审核流程。
    "skill_max_injected": 3,
    # Reminders
    "reminder_channel": "browser",   # "browser" | "email" | "ntfy" | "webhook"
    "reminder_llm_synthesis": False,
    "reminder_llm_persona": "",
    "reminder_ntfy_topic": "Reminders",
    "reminder_email_to": "",
    # 通用外发 Webhook 渠道：选择任何已保存的集成作为
    # 目标，并提供 JSON 负载模板。使用 {{title}} 和 {{message}}
    # 作为占位符——它们在替换前进行 JSON 转义，因此
    # 渲染后的字符串始终是有效的 JSON。适用于 Discord、Slack、Teams、
    # ntfy（JSON 模式）或任何接受 JSON 请求体的 POST 服务。
    "reminder_webhook_integration_id": "",
    "reminder_webhook_payload_template": "",
    # 邮件分类扫描规则。运行/暂停状态和计划在
    # 任务中，通过内置的 `check_email_urgency` 任务管理。
    "urgent_email_prompt": (
        "Flag as urgent: explicit deadlines, time-sensitive requests, "
        "work-blocking issues, messages from people I report to, or anything "
        "where a delayed reply costs money/trust. Someone waiting outside, "
        "at the door, locked out, or unable to get in is urgent now. "
        "Newsletters, marketing, automated digests, and FYI-only updates are "
        "NOT urgent."
    ),
    # 键盘快捷键（操作：按键组合）
    "keybinds": {
        "search": "ctrl+k",
        "toggle_sidebar": "ctrl+b",
        "new_session": "ctrl+alt+n",
        "star_session": "ctrl+alt+s",
        "delete_session": "ctrl+alt+d",
        "admin_panel": "ctrl+shift+u",
        "cancel": "escape",
    },
}

DEFAULT_FEATURES = {
    "web_search": True,
    "web_fetch": True,
    "deep_research": False,
    "memory": True,
    "document_editor": True,
    "rag": True,
    "sensitive_filter": True,
    "gallery": True,
}


# ── Settings (data/settings.json) ──

def load_settings() -> dict:
    """加载与默认值合并后的设置。始终返回完整的字典。"""
    global _settings_cache
    now = time.monotonic()
    if _settings_cache and (now - _settings_cache[0]) < _CACHE_TTL:
        return _settings_cache[1]
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            saved = json.load(f)
        if not isinstance(saved, dict):
            raise ValueError("settings must be an object")
        merged = {**DEFAULT_SETTINGS, **saved}
    except (FileNotFoundError, PermissionError, json.JSONDecodeError, ValueError):
        merged = dict(DEFAULT_SETTINGS)
    _settings_cache = (now, merged)
    return merged


def save_settings(settings: dict):
    """将设置持久化到磁盘（原子操作；参见 core.atomic_io）。"""
    from core.atomic_io import atomic_write_json
    atomic_write_json(SETTINGS_FILE, settings, indent=2)
    _invalidate_caches()


def get_setting(key: str, default: Any = None) -> Any:
    """读取单个设置值。"""
    return load_settings().get(key, default)


def is_setting_overridden(key: str) -> bool:
    """如果 ``key`` 在已保存的设置文件中显式存在，返回 True。

    ``load_settings`` 将 DEFAULT_SETTINGS 与已保存文件合并，因此等于
    默认值的值无法通过 get_setting 与"从未设置"区分。
    Callers that must distinguish an explicit user choice from a default read
    the raw saved file via this. (Note: a materialized default is also "present",
    so value-sensitive callers should compare against the default — see
    ``context_budget.budget_is_explicit``.)
    """
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            saved = json.load(f)
        return isinstance(saved, dict) and key in saved
    except (FileNotFoundError, json.JSONDecodeError):
        return False


# 每用户设置（用户偏好会覆盖全局管理员默认值）。用于
# 允许用户单独选择的键——目前是 vision
# 模型 + 图像生成模型。owner 参数是 FastAPI 依赖项解析的已认证用户名；
# 空/None owner 回退到全局设置。
_PER_USER_KEYS = {
    "vision_model", "vision_enabled", "vision_model_fallbacks",
    "image_model", "image_gen_enabled", "image_quality",
    # 默认聊天端点/模型——没有每用户解析时，每个新
    # 账号都继承最近管理员选择的配置，这会
    # 在首次打开时注入到聊天编辑器中。
    "default_endpoint_id", "default_model", "default_model_fallbacks",
    "utility_endpoint_id", "utility_model", "utility_model_fallbacks",
    "research_endpoint_id", "research_model",
}


def get_user_setting(key: str, owner: str = "", default: Any = None) -> Any:
    """从调用者的每用户偏好中先解析 `key`，然后回退到
    全局设置。只有在 `_PER_USER_KEYS` 中的小白名单内
    才适用——对于其他任何键，此函数等同于 `get_setting(key)`。

    如果偏好模块无法导入（循环/早期启动），则优雅回退——
    管理员全局设置保持正常运作。
    """
    if owner and key in _PER_USER_KEYS:
        try:
            from routes.prefs_routes import _load_for_user
            prefs = _load_for_user(owner) or {}
            if key in prefs and prefs[key] not in (None, ""):
                return prefs[key]
        except Exception:
            pass
    return get_setting(key, default)


# ── Features (data/features.json) ──

def load_features() -> dict:
    """加载与默认值合并后的功能开关。"""
    global _features_cache
    now = time.monotonic()
    if _features_cache and (now - _features_cache[0]) < _CACHE_TTL:
        return _features_cache[1]
    try:
        with open(FEATURES_FILE, "r", encoding="utf-8") as f:
            saved = json.load(f)
        if not isinstance(saved, dict):
            raise ValueError("features must be an object")
        merged = {**DEFAULT_FEATURES, **saved}
    except (FileNotFoundError, PermissionError, json.JSONDecodeError, ValueError):
        merged = dict(DEFAULT_FEATURES)
    _features_cache = (now, merged)
    return merged


def save_features(features: dict):
    """将功能开关持久化到磁盘（原子操作）。"""
    from core.atomic_io import atomic_write_json
    atomic_write_json(FEATURES_FILE, features, indent=2)
    _invalidate_caches()
