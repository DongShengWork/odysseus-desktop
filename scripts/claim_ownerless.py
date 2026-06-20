#!/usr/bin/env python3
"""将所有者为空的数据全部认领到指定用户。

在启用多用户认证后运行一次，将现有数据分配给管理员。

Usage:
    python scripts/claim_ownerless.py admin@example.com
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.constants import MEMORY_FILE, SKILLS_FILE


def claim_json_entries(entries, owner):
    count = 0
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if not entry.get("owner"):
            entry["owner"] = owner
            count += 1
    return count


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/claim_ownerless.py <username>")
        sys.exit(1)

    owner = sys.argv[1]
    print(f"Claiming all ownerless data for: {owner}\n")

    # 1. 记忆（JSON 文件）
    for label, path in [
        ("memory.json", MEMORY_FILE),
        ("skills.json", SKILLS_FILE),
    ]:
        if not os.path.exists(path):
            print(f"  {label}: not found, skipping")
            continue
        with open(path, "r", encoding="utf-8") as f:
            entries = json.load(f)
        count = claim_json_entries(entries, owner)
        if count:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(entries, f, ensure_ascii=False, indent=2)
        print(f"  {label}: claimed {count} entries")

    # 2. 数据库表（sessions, gallery, comparisons, documents）
    from core.database import SessionLocal, Session, Document
    try:
        from core.database import GalleryImage
    except ImportError:
        GalleryImage = None
    try:
        from core.database import Comparison
    except ImportError:
        Comparison = None

    db = SessionLocal()
    try:
        # Sessions
        count = db.query(Session).filter(Session.owner == None).update({"owner": owner})
        print(f"  sessions: claimed {count}")

        # Documents（有自己的 owner 列；认领所有者为空的行，
        # 与 sessions/gallery/comparisons 块保持一致）。旧查询将
        # session_id 设为自身 — 一个无操作 — 且从未设置 owner，因此
        # 所有者为空文档始终保持为空且在用户的资料库中不可见。
        count = db.query(Document).filter(Document.owner == None).update({"owner": owner})
        print(f"  documents: claimed {count}")

        # Gallery
        if GalleryImage:
            count = db.query(GalleryImage).filter(GalleryImage.owner == None).update({"owner": owner})
            print(f"  gallery: claimed {count}")

        # Comparisons
        if Comparison:
            count = db.query(Comparison).filter(Comparison.owner == None).update({"owner": owner})
            print(f"  comparisons: claimed {count}")

        db.commit()
    except Exception as e:
        db.rollback()
        print(f"  ERROR: {e}")
    finally:
        db.close()

    print(f"\nDone! All ownerless data now belongs to {owner}")
    print("Restart the server: sudo systemctl restart odysseus-ui")


if __name__ == "__main__":
    main()
