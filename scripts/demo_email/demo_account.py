#!/usr/bin/env python3
"""创建/移除 Odysseus 中可切换的非默认 'Demo' EmailAccount。

镜像现有的本地 Dovecot 账户（localhost:31143, STARTTLS），但指向
一次性 demo@odysseus.local 邮箱。密码通过应用的 secret_storage 进行
Fernet 加密存储，与真实账户完全一致。

    python demo_account.py setup     # 添加（或更新）'Demo' 账户
    python demo_account.py teardown  # 移除它

从仓库根目录运行，以便应用的模块能正常导入。
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

# 无论当前工作目录如何，使仓库根目录可导入。
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from core.database import SessionLocal, EmailAccount, Base, engine  # noqa: E402
from src.secret_storage import encrypt  # noqa: E402

NAME = "Demo"
IMAP_USER = "demo@odysseus.local"
IMAP_PASSWORD = "demodemo"
# Owner 空字符串 => 与真实 Default 账户相同的列表（可在账户下拉框中切换）。
OWNER = ""


def setup() -> int:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        acct = db.query(EmailAccount).filter(
            EmailAccount.name == NAME, EmailAccount.imap_user == IMAP_USER
        ).first()
        if acct is None:
            acct = EmailAccount(id=uuid.uuid4().hex, name=NAME)
            db.add(acct)
        acct.owner = OWNER
        acct.is_default = False          # 永远不作为默认 — 用户切换到它
        acct.enabled = True
        acct.imap_host = "localhost"
        acct.imap_port = 31143
        acct.imap_user = IMAP_USER
        acct.imap_password = encrypt(IMAP_PASSWORD)
        acct.imap_starttls = True
        # 仅本地：没有真实的 SMTP。指向一个死的本地端口，使演示期间的
        # 意外 "Send" 只在本地失败而不是发送给任何人。
        acct.smtp_host = "localhost"
        acct.smtp_port = 2525
        acct.smtp_user = IMAP_USER
        acct.smtp_password = encrypt(IMAP_PASSWORD)
        acct.from_address = IMAP_USER
        db.commit()
        print(f"'{NAME}' account ready (id={acct.id}, non-default, switchable).")
        return 0
    finally:
        db.close()


def teardown() -> int:
    db = SessionLocal()
    try:
        rows = db.query(EmailAccount).filter(
            EmailAccount.name == NAME, EmailAccount.imap_user == IMAP_USER
        ).all()
        for r in rows:
            db.delete(r)
        db.commit()
        print(f"removed {len(rows)} '{NAME}' account row(s).")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "setup":
        raise SystemExit(setup())
    if cmd == "teardown":
        raise SystemExit(teardown())
    print(__doc__)
    raise SystemExit(2)
