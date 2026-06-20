"""标准 services.search.query 模块的兼容性包装。

``src.search.query`` 保持可导入以兼容旧版 agent/deep-research 代码，但
实现已移至 ``services.search.query``，以避免两份实现出现差异。
"""

import sys

from services.search import query as _query

sys.modules[__name__] = _query
