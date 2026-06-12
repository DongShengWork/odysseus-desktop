"""标准 services.search.core 模块的兼容性包装。

``src.search.core`` 保持可导入以兼容旧版 agent/deep-research 代码，但
实现已移至 ``services.search.core``，以避免两份拷贝之间的服务商排序、
缓存失效和搜索路由行为出现差异。
"""

import sys

from services.search import core as _core

sys.modules[__name__] = _core
