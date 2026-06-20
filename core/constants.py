# core/constants.py — 核心常量模块
"""向后兼容的适配层 — 单一事实来源是 src/constants.py。

Historically there were two copies of this module (this one lagged behind at
APP_VERSION 0.9.1 and was missing the consolidated tool-output constants). To
kill the drift, this now simply re-exports everything from src.constants so
there is exactly one place that defines paths and reads ODYSSEUS_DATA_DIR.
internal_api_base() 现在也位于 src.constants 中，并在此重新导出，
以便现有的 `from core.constants import internal_api_base` 调用者可以继续正常工作。
"""
from src.constants import *  # noqa: F401,F403
from src.constants import internal_api_base  # noqa: F401  （说明：某些 linter 的 * 导入不会覆盖函数）
