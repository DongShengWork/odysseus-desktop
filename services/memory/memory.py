"""规范 MemoryManager 的兼容性导入。

此包历史上包含一个重复的 ``MemoryManager`` 实现。
应用运行时实例化 ``src.memory.MemoryManager``，因此在此
维护一个并行实现存在不同导入路径间静默漂移的风险。
"""

from src.memory import MemoryManager, get_text_similarity, tokenize

__all__ = ["MemoryManager", "get_text_similarity", "tokenize"]
