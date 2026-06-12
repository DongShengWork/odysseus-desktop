"""
此模块有意不从项目中导入任何内容（除了
src.constants，它不从 src 导入任何内容）。在此处添加项目导入将
重新引入此模块旨在打破的循环依赖。
"""

from src.constants import MAX_OUTPUT_CHARS

_mcp_manager = None

# ---------------------------------------------------------------------------
# MCP 管理器单例
# ---------------------------------------------------------------------------

def set_mcp_manager(manager):
    """设置全局 MCP 管理器实例。"""
    global _mcp_manager
    _mcp_manager = manager

def get_mcp_manager():
    """获取全局 MCP 管理器实例。"""
    return _mcp_manager

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    """
    将文本截断到 *limit* 字符并附加后缀注释。

    调用者将结果作为文本处理，因此始终返回字符串：将
    非字符串（None → ""，否则 str(...)）转换，而不是返回原始值，
    后者只会将崩溃转移到下游。
    """
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    if len(text) > limit:
        return text[:limit] + f"\n... (truncated, {len(text)} chars total)"
    return text
