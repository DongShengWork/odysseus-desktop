"""标准 services.search.providers 模块的兼容性包装。

Historically Odysseus carried duplicate provider implementations under both
历史原因下，Odysseus 在 ``src.search`` 和 ``services.search`` 下各有一份重复的
make provider behavior come from one source of truth.
"""

import sys

from services.search import providers as _providers

sys.modules[__name__] = _providers
