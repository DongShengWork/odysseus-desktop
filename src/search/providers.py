"""标准 services.search.providers 模块的兼容性包装。

历史原因下，Odysseus 在 ``src.search`` 和 ``services.search`` 下各有一份重复的
服务商实现。保留旧的导入路径可用，但服务商行为统一来源于同一个真实来源。
"""

import sys

from services.search import providers as _providers

sys.modules[__name__] = _providers
