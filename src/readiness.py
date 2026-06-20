"""Ithaca 锚点 — 本地实例就绪/完整性自检。

超越 ``/api/health`` 的存活 ping，此检查确认自托管实例是
完整且就位的：数据库可达，数据目录存在且
可写，存储为本地优先。由 ``GET /api/ready`` 提供服务，适合
编排器就绪探针（仅在所有关键检查通过时返回 200）。
"""

import os
import uuid
from datetime import datetime
from typing import Dict


def check_readiness() -> Dict[str, object]:
    """运行就绪检查并返回可 JSON 序列化的报告。

    ``ready`` 仅在所有关键检查（database, data_dir）通过时为 True。
    ``local_first`` 为参考信息 — 远程数据库是有效的部署方式，因此
    它永远不会导致就绪失败，只报告存储是否保留在本主机上。
    """
    from core.constants import APP_VERSION, DATA_DIR
    from core.database import DATABASE_URL, engine
    from sqlalchemy import text as sql_text

    checks: Dict[str, Dict[str, object]] = {}

    # 数据库可达 — 最简单的诚实探针，确认引擎在线。
    try:
        with engine.connect() as conn:
            conn.execute(sql_text("SELECT 1"))
        checks["database"] = {"ok": True}
    except Exception as e:
        checks["database"] = {"ok": False, "error": str(e)}

    # 数据目录存在且可写 — 家目录必须能持有自己的数据。
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        probe = os.path.join(DATA_DIR, f".ready_probe_{uuid.uuid4().hex}")
        with open(probe, "w", encoding="utf-8") as fh:
            fh.write("ok")
        os.remove(probe)
        checks["data_dir"] = {"ok": True, "path": DATA_DIR}
    except Exception as e:
        checks["data_dir"] = {"ok": False, "error": str(e)}

    # 本地优先：存储保留在宿主机上（参考信息，永远不会致命）。
    local_first = (
        DATABASE_URL.startswith("sqlite")
        or "localhost" in DATABASE_URL
        or "127.0.0.1" in DATABASE_URL
    )
    checks["local_first"] = {"ok": True, "local": local_first}

    ready = all(bool(c.get("ok")) for c in checks.values())
    return {
        "ready": ready,
        "version": APP_VERSION,
        "checks": checks,
        "timestamp": datetime.utcnow().isoformat(),
    }
