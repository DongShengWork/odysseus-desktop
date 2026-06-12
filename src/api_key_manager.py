import os
import json
import logging
from typing import Dict
from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

class APIKeyManager:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.api_keys_file = os.path.join(data_dir, "api_keys.json")
        self.key_file = os.path.join(data_dir, ".key")
        
    def get_or_create_key(self) -> bytes:
        """获取或创建 API 密钥的加密密钥"""
        if os.path.exists(self.key_file):
            with open(self.key_file, 'rb') as f:
                return f.read()
        else:
            key = Fernet.generate_key()
            with open(self.key_file, 'wb') as f:
                f.write(key)
            return key
    
    def encrypt_api_key(self, api_key: str) -> str:
        """加密 API 密钥"""
        if not api_key:
            return ""
        f = Fernet(self.get_or_create_key())
        return f.encrypt(api_key.encode()).decode()
    
    def decrypt_api_key(self, encrypted_key: str) -> str:
        """解密 API 密钥"""
        if not encrypted_key:
            return ""
        f = Fernet(self.get_or_create_key())
        return f.decrypt(encrypted_key.encode()).decode()
    
    def _load_raw(self) -> Dict[str, str]:
        """从磁盘加载原始的、仍加密的密钥字典。

        容忍缺失/损坏/格式错误的文件，返回 {} —
        这与 load() 在启动时依赖的健壮性相同。
        """
        if not os.path.exists(self.api_keys_file):
            return {}
        try:
            with open(self.api_keys_file, 'r', encoding="utf-8") as f:
                encrypted_keys = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            # 损坏/截断的 api_keys.json 不能导致 load() 崩溃（由
            # app_initializer 在启动时调用）— 将其视为没有存储的密钥。
            logger.warning("Failed to read API keys file: %s", e)
            return {}
        if not isinstance(encrypted_keys, dict):
            # 旧版/错误格式（例如列表）— .items() 会抛出异常。忽略它。
            logger.warning("API keys file has unexpected shape (%s); ignoring", type(encrypted_keys).__name__)
            return {}
        return encrypted_keys

    def save(self, provider: str, api_key: str):
        """将加密后的 API 密钥保存到文件。

        操作的是磁盘上原始的（仍加密的）字典，这样其他提供商的
        密钥保持加密状态。先通过 load() 加载会解密它们并
        将其以明文写回，下次 load() 时会解密失败并静默丢弃这些提供商。
        """
        keys = self._load_raw()
        keys[provider] = self.encrypt_api_key(api_key)
        with open(self.api_keys_file, 'w', encoding="utf-8") as f:
            json.dump(keys, f)

    def load(self) -> Dict[str, str]:
        """加载并解密 API 密钥"""
        encrypted_keys = self._load_raw()
        decrypted = {}
        for provider, key in encrypted_keys.items():
            try:
                decrypted[provider] = self.decrypt_api_key(key)
            except (InvalidToken, ValueError) as e:
                logger.warning("Failed to decrypt API key for %s: %s", provider, e)
        return decrypted

