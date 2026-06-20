"""跨 LLM 输出路径共享的文本清理助手。

`<think>` 标签剥离、Qwen 风格"Thinking Process"
块以及捕获无标记推理的模型的链式思考泄露的
软"推理散文"启发式规则的唯一真实来源。

在此模块之前，六个不同的文件（`email_routes.py`、
`chat_helpers.py`、`note_routes.py`、`builtin_actions.py`、`research_utils.py`、
`agent_loop.py`）各有一套相同正则的变体。在边缘情况下
（未闭合的 `<think>`、嵌套标签、模型发出 `<thinking>` 而不是 `<think>`）
它们都以略微不同的方式出错了。
"""

from __future__ import annotations

import re

_THINK_TAG_NAME = r"(?:think(?:ing)?|thought)"

# 封闭的推理块。`strip_think` 中的多遍循环处理一些模型发出的
# 嵌套 `<think><think>...</think></think>` 模式。
_THINK_CLOSED_RE = re.compile(rf"<{_THINK_TAG_NAME}(?:\s+[^>]*)?>[\s\S]*?</{_THINK_TAG_NAME}>\s*", re.IGNORECASE)
# 封闭遍之后残留的孤立打开或关闭标签。
_THINK_TAG_RE = re.compile(rf"</?{_THINK_TAG_NAME}[^>]*>\s*", re.IGNORECASE)
# 响应中任何位置的未闭合开头——从头到尾剥离
# 从 `<think>` 到字符串末尾的所有内容。
_THINK_OPEN_RE = re.compile(rf"<{_THINK_TAG_NAME}(?:\s+[^>]*)?>[\s\S]*$", re.IGNORECASE)
# 流式模型偶尔发出 `<thinking time="0.42">` 风格的属性。
# 标准化为纯 `<think>`，以便上面的正则能捕获。
_THINK_ATTR_RE = re.compile(rf"<{_THINK_TAG_NAME}\s+[^>]*>", re.IGNORECASE)
_THINK_ATTR_CLOSE_RE = re.compile(rf"</{_THINK_TAG_NAME}\s+[^>]*>", re.IGNORECASE)
_GEMMA_THOUGHT_OPEN_RE = re.compile(r"<\|channel>thought\s*\n?[\s\S]*$", re.IGNORECASE)
_GEMMA_RESPONSE_CHANNEL_RE = re.compile(
    r"<\|channel>response\s*\n?([\s\S]*?)<channel\|>",
    re.IGNORECASE,
)
_GEMMA_RESPONSE_OPEN_RE = re.compile(r"<\|channel>response\s*\n?", re.IGNORECASE)
_GEMMA_CHANNEL_CLOSE_RE = re.compile(r"<channel\|>", re.IGNORECASE)
_THOUGHT_TAG_OPEN_RE = re.compile(r"<thought(\s+[^>]*)?>", re.IGNORECASE)
_THOUGHT_TAG_CLOSE_RE = re.compile(r"</thought>", re.IGNORECASE)
_GEMMA_THOUGHT_CHANNEL_CAPTURE_RE = re.compile(
    r"<\|channel>thought\s*\n?([\s\S]*?)<channel\|>\s*",
    re.IGNORECASE,
)
# Qwen 和其他一些模型在真实回答之前
# 加上 "Thinking Process:" 块。
_QWEN_THINKING_RE = re.compile(
    r"^Thinking Process:.*?(?=\n\n#|\n\n\*\*|\Z)",
    re.IGNORECASE | re.DOTALL,
)
# 泄露的提示重复头部（一些模型在回答之前重复请求）。
_PROMPT_ECHO_RES = (
    re.compile(r"^The user asks:.*?(?=\n\n#|\n\n\*\*[A-Z]|\Z)", re.DOTALL),
    re.compile(r"^We need to.*?(?=\n\n#|\n\n\*\*[A-Z]|\Z)", re.DOTALL),
)

# 对未标记推理散文的激进启发式规则（不将链式思考
# 包裹在 `<think>` 标签中的模型）。仅作为可选项应用（`prose=True`），因为
# 对合法用户内容存在误报，如 "Looking at the attached file…"。
_REASONING_PREFIX_RE = re.compile(
    r"^\s*(?:"
    r"the user (?:wants|is|asks|needs|wrote|said|told|messaged|requested)|"
    r"i (?:need|should|have|'ll|will|am going)(?: to)? (?:write|draft|reply|respond|read|check|look|review|consider|think|provide|generate|produce|craft|compose|acknowledge|summarize|answer|give|keep|aim|make|address|focus|use|just|simply|analyze|format|create|build|note|decide)|"
    r"let me (?:think|look|see|check|read|review|consider|draft|write|analyze|format|summarize|create|produce|craft|note|extract|identify|figure)|"
    r"looking at (?:the|this|that)|"
    r"(?:okay|alright|hmm|right|so|well|first|next|now)[,.]?\s+(?:the|i|let|so|now|this|here)|"
    r"based on (?:the|this|what|context)|"
    r"to (?:draft|write|reply|respond|summarize|answer)"
    r")\b",
    re.IGNORECASE,
)


def _strip_reasoning_prose(text: str) -> str:
    if not text or not text.strip():
        return text
    paragraphs = re.split(r"\n\s*\n", text.strip())
    if len(paragraphs) <= 1:
        return text
    # 仅剥离*前导的*连续的推理段落运行。保留
    # *最后一个*推理段落后的文本会在真实回答后有推理风格句子尾随时
    # 毁掉真实回答：keep 变为空，函数
    # 返回尾随句子而不是上面的回答。
    first_keep = 0
    for i, p in enumerate(paragraphs):
        if _REASONING_PREFIX_RE.match(p):
            first_keep = i + 1
        else:
            break
    if first_keep == 0:
        return text
    keep = paragraphs[first_keep:]
    return "\n\n".join(keep).strip() if keep else text


def normalize_thinking_markup(text: str) -> str:
    """将支持的思考包装标准化为 `<think>` 标记。

    聊天 UI 和持久化层已经理解 `<think>...</think>`。
    Gemma 4 可能改为发出 `<|channel>thought\n...<channel|>`，而一些
    网关/模型发出 `<thought>...</thought>`。将这些形状标准化为
    现有的表示，并剥离空的思考通道。
    """
    if not text:
        return text
    out = _THOUGHT_TAG_OPEN_RE.sub(lambda m: "<think" + (m.group(1) or "") + ">", text)
    out = _THOUGHT_TAG_CLOSE_RE.sub("</think>", out)

    def _replace_gemma_thought(match: re.Match) -> str:
        thought = match.group(1).strip()
        return f"<think>{thought}</think>\n" if thought else ""

    out = _GEMMA_THOUGHT_CHANNEL_CAPTURE_RE.sub(_replace_gemma_thought, out)
    out = _GEMMA_RESPONSE_CHANNEL_RE.sub(lambda m: m.group(1), out)
    out = _GEMMA_RESPONSE_OPEN_RE.sub("", out)
    out = _GEMMA_CHANNEL_CLOSE_RE.sub("", out)
    return out


def strip_think(text: str, *, prose: bool = False, prompt_echo: bool = True) -> str:
    """从模型输出中剥离 `<think>` 块。

    Args:
      prose: 同时剥离未标记的"推理散文"段落。对用户
        内容有风险（对 "Looking at the attached file…" 等短语
        产生误报）；仅为短 LLM 纯输出启用，且仅在输入中
        实际存在 `<think>` 标签时才启用——调用者可以通过
        在确定输入是 LLM 纯输出时才传递 `prose=True` 来使用
        `had_think` 语义。
      prompt_echo: 同时剥离 Qwen "Thinking Process:" 块和
        "The user asks:" / "We need to" 泄露的提示重复。

    能处理以下情况：
      * 闭合的 `<think>...</think>`（任意深度，加上 `<thinking>`/`<thought>`）
      * 未闭合的 `<think>...` / `<thought>...`
      * 游离的打开/关闭标签
      * `<think time="0.42">` 风格的属性
      * Gemma 4 `<|channel>thought...<channel|>` 包装
    """
    if not text:
        return ""
    # Gemma 4 有思考能力的模型在运行时不会将推理拆分为
    # 单独字段时，使用通道控制令牌而不是 XML 标签。
    # 在非思考模式下思考通道可能为空；无论如何它都不是
    # 面向用户的内容。响应通道（如果存在）只是
    # 最终回答的包装。
    text = normalize_thinking_markup(text)
    text = _GEMMA_THOUGHT_OPEN_RE.sub("", text)
    # 标准化属性，以便闭合/打开的正则能捕获。
    text = _THINK_ATTR_RE.sub("<think>", text)
    text = _THINK_ATTR_CLOSE_RE.sub("</think>", text)
    # 处理嵌套块的多遍循环。
    prev = None
    out = text
    while prev != out:
        prev = out
        out = _THINK_CLOSED_RE.sub("", out)
    out = _THINK_OPEN_RE.sub("", out)
    out = _THINK_TAG_RE.sub("", out)
    if prompt_echo:
        out = _QWEN_THINKING_RE.sub("", out)
        for _re in _PROMPT_ECHO_RES:
            out = _re.sub("", out)
    if prose:
        out = _strip_reasoning_prose(out)
    return out.strip()


# 深度研究代码路径的向后兼容别名。保持从
# `src.research_utils` 的现有导入正常工作，同时委托给中心实现。
def strip_thinking(text: str) -> str:
    return strip_think(text or "", prose=False, prompt_echo=True)
