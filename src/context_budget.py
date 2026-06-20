"""agent 循环的自适应输入 token 预算（#1170）。

agent 会将其输入上下文软裁剪到 ``agent_input_token_budget``（默认
6000）。旧的计算是 ``min(context_length or budget, budget)``，这
使得 6000 的默认值成为*每个*模型的硬上限 — 因此一个 128K 或 1M 上下文的
模型即使能容纳更多内容，也会被静默限制在 6000 个输入 token。

当用户未设置显式预算时，此函数从模型发现到的上下文窗口中推导有效预
算，同时仍然精确地遵守显式设置（受窗口限制）。纯函数且无副作用，可进
行单元测试。
"""

# 宽容的上限，使长上下文模型不被阻塞，同时不会在每个 agent 轮次中发送
# 异常庞大的提示。可调整；选定为完全覆盖 128K 模型，并给 1M 模型更大的
# 但有界限的预算。
DEFAULT_HARD_MAX = 200_000
DEFAULT_BUDGET = 6000
DEFAULT_HEADROOM = 0.85


def compute_input_token_budget(
    configured: int,
    context_length: int,
    explicit: bool,
    *,
    default: int = DEFAULT_BUDGET,
    headroom: float = DEFAULT_HEADROOM,
    hard_max: int = DEFAULT_HARD_MAX,
) -> int:
    """返回有效的软输入 token 预算。

    Args:
        configured: 从设置中读取的值（可能是默认值）。
        context_length: the model's discovered context window. Pass 0 when the
            window is unknown / only a bare fallback — auto-scaling then stays
            conservative instead of trusting an unproven window (review on #4122).
        explicit: True if the user set a NON-default budget. The default value is
            the "auto" sentinel (scale to the window); any other value is an
            explicit cap. (A deliberately-chosen default can't be distinguished
            from a materialized default by value, so the default reads as auto.)

    Rules:
        - 显式用户预算被精确遵守，仅当窗口已知时受模型窗口限制
          window when that window is known (the user's deliberate choice wins;
          ``hard_max`` is an auto-budget ceiling only — see #1230).
        - Otherwise (auto), scale to ``headroom`` of the context window, capped at
          ``hard_max`` — so long-context models use their capacity.
        - When the window is unknown (context_length <= 0), use the conservative
          ``default`` budget and do NOT scale off the fallback.
    """
    configured = int(configured or 0)
    context_length = int(context_length or 0)

    if explicit and configured > 0:
        return min(configured, context_length) if context_length > 0 else configured

    if context_length > 0:
        scaled = int(context_length * headroom)
        return max(1, min(scaled, hard_max))

    return configured if configured > 0 else default


def budget_is_explicit(configured: int, *, default: int = DEFAULT_BUDGET) -> bool:
    """Whether a configured agent_input_token_budget is a deliberate explicit cap.

    The default value is the "auto" sentinel (scale to the model's window), so only
    a NON-default positive value counts as explicit. This keys off the VALUE, not
    settings *presence* — the settings-save path materializes every default into
    settings.json, so a persisted default must still read as auto (the regression
    #4121 / #1230 are about). Centralised here so the materialized-default contract
    is unit-testable and can't silently regress to a presence check.
    """
    configured = int(configured or 0)
    return configured > 0 and configured != default
