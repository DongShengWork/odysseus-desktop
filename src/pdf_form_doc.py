"""提取的 PDF 表单字段与文档编辑器之间的桥梁。

设计理念：用户以可读的 markdown 编辑表单 — 标签为列表项，
值为纯文本 — 与编辑器中的其他文档完全一样。

在 markdown 顶部的隐藏 HTML 注释前置标记将文档
链接回源 PDF 和字段 schema sidecar：

    <!-- pdf_form_source upload_id="abc.pdf" fields="441" -->

导出路由读取该标记以找到源 PDF + sidecar JSON，
然后请求 LLM 将 markdown 值映射回 AcroForm 字段名称。
"""

import json
import logging
import os
import re
import uuid
from typing import Any, Optional

logger = logging.getLogger(__name__)


_FRONT_MATTER_RE = re.compile(
    r'<!--\s*pdf_form_source\s+upload_id="(?P<upload_id>[^"]+)"(?:\s+fields="(?P<fields>\d+)")?\s*-->'
)

# 自由形式标注的列表项 — 镜像 static/js/document.js 中的 JS 正则。
# 坐标为页面百分比（0–100）；kind/lh 为向后兼容而可选。
_ANNOTATION_RE = re.compile(
    r'^[ \t]*-\s+(?P<value>.*?)\s*<!--\s*annotation\s+id=(?P<id>[\w-]+)\s+page=(?P<page>\d+)\s+x=(?P<x>[\d.]+)\s+y=(?P<y>[\d.]+)\s+w=(?P<w>[\d.]+)\s+h=(?P<h>[\d.]+)(?:\s+kind=(?P<kind>\w+))?(?:\s+lh=(?P<lh>[\d.]+))?\s*-->[ \t]*$',
    re.MULTILINE,
)


def _unescape_annotation_value(s: str) -> str:
    """JS _escapeAnnotationValue 的逆操作：\\\\n → 换行，\\\\\\\\ → \\\\。"""
    out: list[str] = []
    i = 0
    n = len(s or "")
    while i < n:
        ch = s[i]
        if ch == "\\" and i + 1 < n:
            nxt = s[i + 1]
            if nxt == "n":
                out.append("\n")
            elif nxt == "\\":
                out.append("\\")
            else:
                out.append(nxt)
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def parse_markdown_annotations(content: str) -> list[dict]:
    """返回嵌入在文档 markdown 中的自由形式标注字典列表。

    每个条目：{id, page, x, y, w, h, kind, line_height, value}。
    Coordinates are page percentages (0–100) — caller scales them to PDF user
    units when stamping.
    """
    out: list[dict] = []
    for m in _ANNOTATION_RE.finditer(content or ""):
        # 一个格式错误的列表项（例如用户手动编辑 markdown 留下
        # `x=12.3.4`）绝不能导致文档中所有其他标注丢失。
        # 跳过该行，继续处理。
        try:
            raw = m.group("value")
            value = "" if raw == "_(empty)_" else _unescape_annotation_value(raw)
            out.append({
                "id": m.group("id"),
                "page": int(m.group("page")),
                "x": float(m.group("x")),
                "y": float(m.group("y")),
                "w": float(m.group("w")),
                "h": float(m.group("h")),
                "kind": m.group("kind") or "text",
                "line_height": float(m.group("lh")) if m.group("lh") else 1.3,
                "value": value,
            })
        except (ValueError, TypeError) as e:
            logger.warning(f"Skipping malformed annotation bullet near offset {m.start()}: {e}")
            continue
    return out

# 纯 PDF 标记：形状与表单源标记相同，但为任何导入的 PDF（无 AcroForm 字段）
# 发出。允许现有的 render-pages / render-pdf / page-png 端点也为
# 非表单 PDF 提供查看功能。
_PLAIN_FRONT_MATTER_RE = re.compile(
    r'<!--\s*pdf_source\s+upload_id="(?P<upload_id>[^"]+)"\s*-->'
)

# Bullet line emitted by render_form_as_markdown. The trailing comment is the
# anchor we rely on to recover the field name even after the user/model edits
# the value. The field name is percent-encoded so spaces, newlines, parens
# and other special chars in raw AcroForm names don't break parsing.
#   - **label:** value <!-- field=NAME-ENC type=text -->
#   - **label** [opts]: value <!-- field=NAME-ENC type=choice -->
#   - [x] **label** <!-- field=NAME-ENC type=checkbox -->
_FIELD_BULLET_RE = re.compile(
    r'^\s*-\s+(?P<body>.*?)\s*<!--\s*field=(?P<name>[A-Za-z0-9_.%-]+)\s+type=(?P<type>\w+)\s*-->\s*$'
)


def _encode_name(name: str) -> str:
    """对任何非正则/HTML 注释安全 token 的字符进行 URL 编码。

    保留 A-Z a-z 0-9 _ . - 。其他所有字符（空格、换行、括号、
    逗号、引号等）变为 %XX。JS 端必须使用相同的方案。
    """
    out = []
    for ch in name or "":
        if ch.isalnum() or ch in ("_", ".", "-"):
            out.append(ch)
        else:
            for b in ch.encode("utf-8"):
                out.append(f"%{b:02X}")
    return "".join(out)


def _decode_name(enc: str) -> str:
    """_encode_name 的逆操作。"""
    import urllib.parse
    return urllib.parse.unquote(enc or "")
# 标签段为非贪婪 (.+?)，使得包含 '*' 的标签 — 几乎通用的必填字段
# 标记，例如 "Email *" — 可以容忍，同时仍然在第一个 ':**' / '**[' 处分割，
# 因此本身包含 ':**' 的值会被保留。
# （旧的 [^*]+ 拒绝匹配任何包含星号的标签，并静默地
# 在导出时丢弃该字段的值。）
_TEXT_VALUE_RE = re.compile(r'\*\*.+?:\*\*\s*(?P<value>.*)$')
_CHOICE_VALUE_RE = re.compile(r'\*\*.+?\*\*\s*\[[^\]]*\]\s*:\s*(?P<value>.*)$')
_CHECKBOX_VALUE_RE = re.compile(r'^\s*\[(?P<state>[xX ])\]')

_PLACEHOLDERS = {"_(empty)_", "_(not selected)_", "_(empty)_.", "_(unsigned)_"}


def sidecar_path(pdf_path: str) -> str:
    """存储在 PDF 上传旁边的字段 schema JSON 的路径。"""
    return pdf_path + ".fields.json"


def save_field_sidecar(pdf_path: str, fields: list[dict[str, Any]]) -> str:
    """将字段 schema 持久化到其源 PDF 旁边。返回 sidecar 路径。"""
    path = sidecar_path(pdf_path)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(fields, f, indent=2)
    except Exception as e:
        logger.warning(f"Failed to write field sidecar {path}: {e}")
    return path


def load_field_sidecar(pdf_path: str) -> Optional[list[dict[str, Any]]]:
    """返回 PDF 的字段 schema，如果不存在 sidecar 则返回 None。"""
    path = sidecar_path(pdf_path)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Failed to read field sidecar {path}: {e}")
        return None


def find_source_upload_id(content: str) -> Optional[str]:
    """从文档的前置标记中返回 upload_id，如果没有则返回 None。

    匹配用于可填充 PDF 的表单源标记（`pdf_form_source`）
    和用于任何导入 PDF 的纯标记（`pdf_source`）。
    在任何查找之前拒绝格式错误的 ID（路径遍历、错误的形状）。
    """
    from src.upload_handler import is_valid_upload_id

    m = _FRONT_MATTER_RE.search(content or "") or _PLAIN_FRONT_MATTER_RE.search(content or "")
    if not m:
        return None
    upload_id = m.group("upload_id")
    if not is_valid_upload_id(upload_id):
        logger.warning("Ignoring invalid pdf_source upload_id in document content: %r", upload_id)
        return None
    return upload_id


def render_plain_pdf_markdown(upload_id: str, title: str, body_text: Optional[str] = None) -> str:
    """为导入到编辑器的非表单 PDF 构建 markdown 包装。

    隐藏的前置标记将文档链接到源 PDF，以便查看端点
    （render-pages / page-png）可以提供渲染的页面。
    在标题下方包含任何提取的文本，以便 markdown 源视图
    仍然有用（搜索、复制/粘贴、AI 工具）。
    """
    lines: list[str] = [
        f'<!-- pdf_source upload_id="{upload_id}" -->',
        "",
        f"# {title}",
        "",
    ]
    if body_text and body_text.strip():
        lines.append(body_text.strip())
        lines.append("")
    return "\n".join(lines) + "\n"


def create_plain_pdf_document(
    session_id: str,
    upload_id: str,
    title: str,
    body_text: Optional[str] = None,
) -> Optional[str]:
    """为非表单 PDF 创建 markdown Document 并将其设为活动。

    返回新的 doc_id，失败则返回 None。与 `find_source_upload_id` 配对，
    以便现有的 /render-pages 和 /page/{n}.png 端点可以在没有
    表单字段覆盖的情况下提供页面。
    """
    from src.database import SessionLocal, Document, DocumentVersion, Session as DbSession
    from src.agent_tools.document_tools import set_active_document

    content = render_plain_pdf_markdown(upload_id, title, body_text)
    db = SessionLocal()
    try:
        doc_id = str(uuid.uuid4())
        ver_id = str(uuid.uuid4())
        _sess = db.query(DbSession).filter(DbSession.id == session_id).first()
        doc = Document(
            id=doc_id,
            session_id=session_id,
            title=title,
            language="markdown",
            current_content=content,
            version_count=1,
            is_active=True,
            owner=_sess.owner if _sess else None,
        )
        ver = DocumentVersion(
            id=ver_id,
            document_id=doc_id,
            version_number=1,
            content=content,
            summary="Imported from PDF",
            source="upload",
        )
        db.add(doc)
        db.add(ver)
        db.commit()
        set_active_document(doc_id)
        return doc_id
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to create plain PDF document: {e}")
        return None
    finally:
        db.close()


def parse_markdown_to_values(content: str) -> dict[str, Any]:
    """从渲染的 markdown 中恢复 {field_name: value}。

    Deterministic — relies on the hidden HTML-comment field markers in each
    bullet. Lines whose markers are intact survive arbitrary edits to label
    and value text. Lines whose markers were stripped are silently skipped;
    those fields just won't be filled in the output PDF.

    空占位符（"_(empty)_", "_(not selected)_"）映射为 ""。
    复选框状态来自行首的 `[ ]` / `[x]` 标记。
    """
    values: dict[str, Any] = {}
    for line in (content or "").splitlines():
        m = _FIELD_BULLET_RE.match(line)
        if not m:
            continue
        name = _decode_name(m.group("name"))
        ftype = m.group("type")
        body = m.group("body")

        if ftype == "checkbox":
            cb = _CHECKBOX_VALUE_RE.match(body)
            values[name] = bool(cb and cb.group("state").lower() == "x")
            continue

        raw = ""
        if ftype == "choice":
            cm = _CHOICE_VALUE_RE.search(body)
            if cm:
                raw = cm.group("value").strip()
        else:
            tm = _TEXT_VALUE_RE.search(body)
            if tm:
                raw = tm.group("value").strip()

        if raw in _PLACEHOLDERS:
            raw = ""
        values[name] = raw
    return values


def _checkbox_marker(value: Any) -> str:
    return "[x]" if value else "[ ]"


def _flatten(value: Any) -> str:
    """将 PDF 换行符序列（\\r, \\n）折叠，使值适合单行列表项。"""
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def _format_field_bullet(f: dict[str, Any]) -> str:
    """将一个表单字段渲染为 markdown 列表项行。

    Hidden HTML comment carries the percent-encoded field name so the
    export/save logic has a robust anchor regardless of what whitespace,
    parens, or special chars appear in the raw AcroForm field name. The
    visible label is the human-readable bit.

    签名字段将选定的签名 ID 编码为 `signature:<id>`，
    以便选择器的选中状态保留在文档中，导出路由可以在无需
    额外状态的情况下印章保存的 PNG。
    """
    label = _flatten(f.get("label")) or f["name"]
    name = _encode_name(f["name"])
    ftype = f["type"]
    value = _flatten(f.get("value"))

    if ftype == "checkbox":
        body = f'{_checkbox_marker(value)} **{label}**'
    elif ftype == "choice":
        opts = f.get("options") or []
        opts_str = " / ".join(opts) if opts else ""
        shown = value if value else "_(not selected)_"
        body = f'**{label}** [{opts_str}]: {shown}'
    elif ftype == "signature":
        shown = value if (value and value.startswith("signature:")) else "_(unsigned)_"
        body = f'**{label}:** {shown}'
    else:
        shown = value if value else "_(empty)_"
        body = f'**{label}:** {shown}'

    return f'- {body} <!-- field={name} type={ftype} -->'


def render_form_as_markdown(
    fields: list[dict[str, Any]],
    upload_id: str,
    title: str,
    intro_text: Optional[str] = None,
) -> str:
    """构建用户在编辑器中编辑的 markdown 文档。

    布局：
      前置标记（在编辑器渲染中隐藏但在源中存在）
      标题
      一段引言 + 如何导出
      每页一节，带列表字段
    """
    lines: list[str] = [
        f'<!-- pdf_form_source upload_id="{upload_id}" fields="{len(fields)}" -->',
        "",
        f"# {title}",
        "",
        "Edit values in place — change the text after each label, tick/untick "
        "checkboxes, and pick one of the listed options for choice fields. "
        "When done, click **Export PDF** to download the filled form.",
        "",
    ]
    last_page: Optional[int] = None
    for f in fields:
        if f["page"] != last_page:
            lines.append("")
            lines.append(f"## Page {f['page']}")
            lines.append("")
            last_page = f["page"]
        lines.append(_format_field_bullet(f))

    if intro_text:
        lines.append("")
        lines.append("---")
        lines.append("")
        lines.append("## Original form text")
        lines.append("")
        lines.append(intro_text.strip())

    return "\n".join(lines) + "\n"


def create_form_markdown_document(
    session_id: str,
    fields: list[dict[str, Any]],
    upload_id: str,
    title: str,
    intro_text: Optional[str] = None,
) -> Optional[str]:
    """为可编辑表单创建 markdown Document 并将其设为活动。

    返回新的 doc_id，失败则返回 None。Document 的语言为
    "markdown" — 表单性质仅由内容内部的前置标记表示，
    导出路由会查找该标记。
    """
    from src.database import SessionLocal, Document, DocumentVersion, Session as DbSession
    from src.agent_tools.document_tools import set_active_document

    content = render_form_as_markdown(fields, upload_id, title, intro_text=intro_text)
    db = SessionLocal()
    try:
        doc_id = str(uuid.uuid4())
        ver_id = str(uuid.uuid4())
        _sess = db.query(DbSession).filter(DbSession.id == session_id).first()
        doc = Document(
            id=doc_id,
            session_id=session_id,
            title=title,
            language="markdown",
            current_content=content,
            version_count=1,
            is_active=True,
            owner=_sess.owner if _sess else None,
        )
        ver = DocumentVersion(
            id=ver_id,
            document_id=doc_id,
            version_number=1,
            content=content,
            summary="Imported from PDF form",
            source="upload",
        )
        db.add(doc)
        db.add(ver)
        db.commit()
        set_active_document(doc_id)
        return doc_id
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to create form markdown document: {e}")
        return None
    finally:
        db.close()
