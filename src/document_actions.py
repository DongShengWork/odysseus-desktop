"""
document_actions.py

可复用的文档操作，既可从 REST 路由也可从任务调度器调用。
"""

import logging
import re
from datetime import datetime

logger = logging.getLogger(__name__)


_JUNK_TITLES = {
    "untitled", "untitled document", "new document", "document",
    "new email", "new mail", "new message", "reply", "fwd", "re:",
    "test", "testing", "asdf", "asd", "foo", "bar", "baz",
    "tmp", "temp", "scratch", "scratchpad", "draft", "delete",
    "remove", "junk", "trash", "xxx", "abc", "qwerty",
}


def _norm_title(t: str) -> str:
    """规范化标题用于分组：去除空白、压缩空白、转小写。"""
    t = t if isinstance(t, str) else ""
    return re.sub(r"\s+", " ", t.strip()).lower()


def _content_fingerprint(content: str) -> str:
    """用于重复检测的稳定文档内容指纹。

    去除在其他方面相同的副本之间不同的部分 — 主要是重新导入 PDF 的
    `upload_id` 和注释的随机 `id=` — 使同一文件的 N 次导入合并为一个
    指纹。空白被压缩，结果转小写。
    """
    c = content if isinstance(content, str) else ""
    c = re.sub(r'upload_id="[^"]*"', "upload_id", c)          # pdf_source 重新导入
    c = re.sub(r"\bid=ann-[A-Za-z0-9_-]+", "id=ann", c)        # 注释 ID
    c = re.sub(r"\s+", " ", c).strip().lower()
    return c


def _real_len(content: str) -> int:
    """去除 markdown 噪声后的内容长度 — '完整性'代理指标。"""
    content = content if isinstance(content, str) else ""
    stripped = re.sub(r"^#{1,6}\s+", "", content, flags=re.MULTILINE)
    stripped = re.sub(r"[*_`>\-=]+", "", stripped)
    stripped = re.sub(r"\s+", " ", stripped).strip()
    return len(stripped)


async def run_document_tidy(owner: str) -> str:
    """为所有者删除明显垃圾的文档和冗余重复项。

    保守规则（不基于长度的删除 — 短笔记是合法的）：
    - 空/纯空白/占位符（"# Untitled"）
    - 标题是随意起的名字（test、asdf 等）或内容本身是随意起的
    - 无原始内容的邮件回复链
    - 重复项：共享相同规范化标题和相同内容指纹的文档
      （忽略易变的 upload/annotation ID）。保留最完整的副本
      （最长真实内容，然后最最近的）；其余删除。
    """
    from core.database import SessionLocal, Document, Session as DbSession

    db = SessionLocal()
    try:
        if owner:
            # 文档现在带有自己的 owner 列（即使 session 被删除也可靠）。
            # 直接匹配它；孤立的旧数据行在启动时被归到管理员名下，
            # 因此它们也有归属。
            docs = db.query(Document).filter(Document.owner == owner).all()
        else:
            docs = db.query(Document).all()

        deleted_examples = []
        deleted = 0
        kept = 0
        survivors = []  # 通过垃圾规则的文档，考虑用于去重

        for doc in docs:
            content = (doc.current_content or "").strip()
            title = (doc.title or "").strip().lower()

            # 去除 markdown 噪声以获得"真实"字符数
            stripped = re.sub(r"^#{1,6}\s+", "", content, flags=re.MULTILINE)  # 标题
            stripped = re.sub(r"[*_`>\-=]+", "", stripped)  # markdown 字符
            stripped = re.sub(r"\s+", " ", stripped).strip()
            real_len = len(stripped)

            # 检测保存为文档的邮件（无原始内容的引用链）
            lines = [ln for ln in content.split("\n") if ln.strip()]
            quoted_lines = [ln for ln in lines if ln.lstrip().startswith(">")]
            header_lines = [ln for ln in lines if re.match(r"^On .+ wrote:?\s*$", ln.strip())]
            non_quote_content = "\n".join(
                ln for ln in lines
                if not ln.lstrip().startswith(">")
                and not re.match(r"^On .+ wrote:?\s*$", ln.strip())
            ).strip()
            quote_ratio = len(quoted_lines) / max(len(lines), 1)

            should_delete = False
            reason = ""

            if not content or content in ("", "# Untitled"):
                should_delete = True
                reason = "empty"
            elif title in _JUNK_TITLES:
                # 如果你把它命名为 "test" 或 "asdf" 等，你不关心它
                should_delete = True
                reason = f"junk title '{title}'"
            elif stripped.lower() in _JUNK_TITLES:
                should_delete = True
                reason = "throwaway content"
            # 不基于长度删除：短笔记是合法内容。
            elif (quoted_lines or header_lines) and len(non_quote_content) < 50 and quote_ratio > 0.4:
                # 无原始内容的邮件回复链
                should_delete = True
                reason = "email quote-chain only"

            if should_delete:
                if len(deleted_examples) < 5:
                    label = (doc.title or "(no title)")[:40]
                    deleted_examples.append(f"{label} ({reason})")
                db.delete(doc)
                deleted += 1
            else:
                survivors.append(doc)

        # --- 去重阶段：按 (规范化标题, 内容指纹) 分组幸存者，
        # 仅保留每个组中最完整的副本。 ---
        groups: dict = {}
        for doc in survivors:
            key = (_norm_title(doc.title), _content_fingerprint(doc.current_content))
            groups.setdefault(key, []).append(doc)

        for (title_key, _fp), members in groups.items():
            if len(members) < 2:
                kept += 1
                continue
            # 保留最完整的（最长真实内容），然后最近更新的。
            def _updated(d):
                return d.updated_at or d.created_at
            # 排序键必须是全序安全的：如果文档同时是 updated_at 和
            # created_at NULL，Python 会在真实长度平局时将 None 与
            # datetime 比较，引发 TypeError 并终止整个 tidy 运行。
            # 将 "有时间戳" 排在时间戳本身之前，这样 None 永远不需要
            # 与 datetime 比较。
            members.sort(
                key=lambda d: (
                    _real_len(d.current_content),
                    _updated(d) is not None,
                    _updated(d) or datetime.min,
                ),
                reverse=True,
            )
            keeper = members[0]
            kept += 1
            dupes = members[1:]
            if len(deleted_examples) < 5:
                label = (keeper.title or "(no title)")[:40]
                deleted_examples.append(f"{label} (+{len(dupes)} duplicate copies)")
            for d in dupes:
                db.delete(d)
                deleted += 1

        if deleted:
            db.commit()

        if deleted == 0:
            # 使用哨兵值，以便调度器可以完全删除运行行。
            from src.builtin_actions import TaskNoop
            raise TaskNoop(f"scanned {len(docs)} document(s), no junk")
        preview = "; ".join(deleted_examples)
        extra = f" (+{deleted - len(deleted_examples)} more)" if deleted > len(deleted_examples) else ""
        return f"Removed {deleted} of {len(docs)}: {preview}{extra} · {kept} kept"
    finally:
        db.close()
