# src/research_utils.py
"""深度研究系统的共享工具。

集中管理文本清理、质量过滤和其他逻辑，
在 deep_research.py、research_handler.py 和 visual_report.py 中共同使用。
"""

# ---------------------------------------------------------------------------
# 思考/推理块剥离
# ---------------------------------------------------------------------------

def strip_thinking(text):
    """从 LLM 输出中剥离思考/推理模式。

    委托给 `src.text_helpers.strip_think`（唯一真相来源）。
    在此保留为别名，以便现有的 `from src.research_utils import strip_thinking`
    调用方不会中断。保留 None 透传 — 许多调用方传递
    `Optional[str]` LLM 结果，并期望调用失败时返回 None。
    """
    if text is None:
        return None
    from src.text_helpers import strip_think
    return strip_think(text, prose=False, prompt_echo=True)


# ---------------------------------------------------------------------------
# 源质量过滤
# ---------------------------------------------------------------------------

# 表示提取内容为模板文本、错误文本或空文本的标记。
# 如果找到任何标记（不区分大小写），内容将被过滤掉。
LOW_QUALITY_MARKERS = [
    "insufficient to",
    "content is insufficient",
    "no substantive data",
    "does not contain",
    "not relevant to",
    "no relevant information",
    "unable to extract",
    "completely unrelated",
    "boilerplate",
    "footer text",
    # 短语（而非裸的 "cookie"/"copyright"），以便我们仍能捕获
    # 如同意横幅和页脚等模板文本，而不会丢弃仅是
    # 讨论 cookie 或版权作为主题的合法发现。
    "cookie consent",
    "cookie banner",
    "cookie notice",
    "copyright notice",
    "copyright footer",
    "all rights reserved",
]


def is_low_quality(summary: str) -> bool:
    """检查发现摘要是否表示无用的或不相关的内容。"""
    try:
        if not isinstance(summary, str) or not summary:
            return True
        low = summary.lower()
        return any(marker in low for marker in LOW_QUALITY_MARKERS)
    except Exception:
        return False  # 开放失败
