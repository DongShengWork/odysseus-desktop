"""JSON 文件原子写入。

用于所有需要持久化 JSON 配置文件的地方。普通的 `open("w") + json.dump`
在第一次写入时截断文件，之后才填充新内容 — 在此期间的 kill -9 / 断电 / OOM
会导致文件被截断或为空。对于密码数据库（`auth.json`）和实时状态文件
（`sessions.json`、`settings.json`、`integrations.json`、`cookbook_state.json`），
这属于数据丢失事件。

`atomic_write_json` 写入一个同级的临时文件，执行 fsync，然后 `os.replace`
到位。在 POSIX 上，`os.replace` 在同一文件系统内是原子操作。
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional


def atomic_write_json(path: str, data: Any, *, indent: Optional[int] = None) -> None:
    """原子地将 `data` 以 JSON 格式持久化到 `path`。

    临时文件使用当前 PID 作为后缀，以防止两个进程同时保存同一个文件
    （例如单元测试）时在重命名目标上发生冲突。
    """
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=indent)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def atomic_write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
