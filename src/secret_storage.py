"""
secret_storage.py

基于 Fernet 的对称加密，用于保护存储在 SQLite DB 中的密钥
（目前为 IMAP/SMTP 密码；可安全扩展）。密钥存放在
`data/.app_key`，权限模式 0o600，首次调用时自动生成。`data/`
已在 gitignore 中，因此密钥永远不会随仓库一起发布。

威胁模型：防止 SQLite 文件泄露（被盗的备份、
泄露的容器层、同租户读取）。**不**
防止进程被攻破——任何能够读取本
模块内存或密钥文件的人都可以获取明文。

加密值带有 `enc:` 前缀，因此迁移是
幂等的：将已加密的值传递给 `encrypt()` 为
空操作；将明文值传递给 `decrypt()` 返回时
保持原样。这使得旧行和新行可以共存，直到
一次统一的迁移遍将它们重写。
"""

import os
import logging
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from core.platform_compat import safe_chmod
from src.constants import APP_KEY_FILE

logger = logging.getLogger(__name__)

_KEY_PATH = Path(APP_KEY_FILE)
_PREFIX = "enc:"
_fernet: Fernet | None = None


def _load_or_create_key() -> bytes:
    if _KEY_PATH.exists():
        return _KEY_PATH.read_bytes()
    _KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    _KEY_PATH.write_bytes(key)
    # POSIX: 锁定密钥文件权限为 0o600。Windows: 空操作（用户配置文件数据目录
    # 已受 ACL 限制）；safe_chmod 兼容处理两种情况。
    safe_chmod(_KEY_PATH, 0o600)
    logger.info(f"Generated new app key at {_KEY_PATH}")
    return key


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_or_create_key())
    return _fernet


def encrypt(plaintext: str) -> str:
    """加密字符串。空输入直接通过。已加密的
    值保持原样返回，因此重复加密为空操作。"""
    if not plaintext:
        return plaintext or ""
    if plaintext.startswith(_PREFIX):
        return plaintext
    token = _get_fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")
    return _PREFIX + token


def decrypt(value: str) -> str:
    """解密 `enc:`-前缀的值。明文（旧版）保持
    原样返回。解密失败时返回 ""，使得损坏
    或密钥轮换的行退化为"未配置"状态，而不是 500 错误。"""
    if not value:
        return value or ""
    if not value.startswith(_PREFIX):
        return value
    try:
        return _get_fernet().decrypt(value[len(_PREFIX):].encode("ascii")).decode("utf-8")
    except InvalidToken:
        logger.error("Failed to decrypt stored secret — wrong key or corrupt token")
        return ""
    except Exception as e:
        logger.error(f"Decrypt failure: {e}")
        return ""


def is_encrypted(value: str) -> bool:
    return bool(value) and value.startswith(_PREFIX)
