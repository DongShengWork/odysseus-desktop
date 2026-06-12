"""私有 CA 的 LLM 提供商的扩展 TLS 信任存储。

一些上游 LLM 提供商通过由私有根 CA 签名的 TLS 证书
提供其 API，该根 CA 不属于标准系统证书包：

  - GigaChat（Sber）使用俄罗斯可信根 CA，不包含在
    OpenSSL/certifi/大多数非俄罗斯安装的系统信任中。
    证书链对 Python 而言看起来是自签名的，端点被标记为离线，
    并显示 `CERTIFICATE_VERIFY_FAILED: self-signed certificate in
    certificate chain`（参见 issue #722）。
  - 本地企业 LLM 网关通常呈现未导入到运行时
    信任存储中的企业 CA。

运维人员将 `LLM_CA_BUNDLE` 指向包含额外 CA
证书的 PEM 文件。首先加载默认系统/certifi 信任存储，然后
在其之上叠加运维人员的 PEM，因此验证仍然发生——
只是信任集合变大了。我们有意不提供
"verify=off" 开关：全局（或按主机）禁用验证会
使这些端点面临中间人攻击，而运维人员提供的证书包是
合法的私有 CA 提供商的正确解决方案。

示例（GigaChat）：
    # Sber 在以下地址发布证书链
    # https://www.gosuslugi.ru/crt/rootca_ssl_rsa2022.cer
    # 转换为 PEM 并将环境变量指向它。
    LLM_CA_BUNDLE=/etc/odysseus/ca/russian-trusted-root.pem

范围：
    `llm_verify()` 有意只被两个调用点使用——`src/llm_core.py`
    中的共享异步客户端和 `routes/model_routes.py` 中的端点探测。
    两者都访问 LLM 提供商 URL。该覆盖
    不会传入 web_fetch、搜索提供商、图库下载、
    embedding、webhook 投递或任何访问任意 URL 的操作，
    也不影响应用自身的面向浏览器的 TLS。该
    边界由 `tests/test_tls_overrides_scope.py` 固定——扩展
    它需要在白名单中更新，并附上书面理由。
"""

import logging
import os
import ssl
from typing import Optional

logger = logging.getLogger(__name__)


_extra_bundle_path: Optional[str] = (os.environ.get("LLM_CA_BUNDLE") or "").strip() or None


def _build_ssl_context() -> Optional[ssl.SSLContext]:
    """构建使用默认信任存储并同时信任
    运维人员提供的 PEM 包的 SSLContext。未配置额外包时返回 None，
    此时调用者回退到 httpx 的默认 verify=True。"""
    if not _extra_bundle_path:
        return None
    if not os.path.isfile(_extra_bundle_path):
        logger.warning(
            "LLM_CA_BUNDLE points at %r but the file does not exist; "
            "falling back to the default trust store.",
            _extra_bundle_path,
        )
        return None
    ctx = ssl.create_default_context()
    try:
        ctx.load_verify_locations(cafile=_extra_bundle_path)
    except (ssl.SSLError, OSError) as e:
        logger.warning(
            "LLM_CA_BUNDLE=%r failed to load (%s); falling back to the "
            "default trust store.",
            _extra_bundle_path, e,
        )
        return None
    logger.info(
        "Loaded extra CA bundle %r on top of the default trust store.",
        _extra_bundle_path,
    )
    return ctx


# 在导入时解析一次。src/llm_core.py 中的 httpx 客户端是
# 长寿的（进程范围内），因此编辑 LLM_CA_BUNDLE 需要重启——
# 这与 LLM_HOST、SEARXNG_INSTANCE 等的现有语义一致。
_SHARED_SSL_CONTEXT: Optional[ssl.SSLContext] = _build_ssl_context()


def llm_verify():
    """返回传递给 httpx.get / httpx.Client /
    httpx.AsyncClient 的 `verify=` 参数值。当 LLM_CA_BUNDLE
    已设置并加载时，返回扩展信任的 SSLContext；
    否则返回 True（httpx 默认——系统
    / certifi 包，验证完全开启）。"""
    return _SHARED_SSL_CONTEXT if _SHARED_SSL_CONTEXT is not None else True
