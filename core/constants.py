# core/constants.py — 核心常量模块
"""向后兼容的适配层 — 单一事实来源是 src/constants.py。

历史上存在两份此模块的副本（这份滞留在 APP_VERSION 0.9.1，并且缺少
统一后的工具输出常量）。为了消除版本漂移，现在直接从 src.constants
重新导出所有内容，确保路径和 ODYSSEUS_DATA_DIR 读取只有一个定义位置。
internal_api_base() 现在也位于 src.constants 中，并在此重新导出，
以便现有的 `from core.constants import internal_api_base` 调用者可以继续正常工作。
"""
from src.constants import *  # noqa: F401,F403
from src.constants import internal_api_base  # noqa: F401  （说明：某些 linter 的 * 导入不会覆盖函数）
