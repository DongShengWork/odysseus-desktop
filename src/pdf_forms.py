"""PDF AcroForm 字段检测和提取。

用于判断上传的 PDF 是否应按可填充表单处理
（路由到 pdf_form 文档类型）还是作为普通文本 PDF
（路由通过 document_processor._process_pdf）。
"""

import logging
import re
from typing import Any

# PyMuPDF 是一个可选依赖（AGPL-3.0），仅用于本模块实现的 PDF
# 表单填充功能。MIT 核心在没有它的情况下可以正常导入；
# 在没有 PyMuPDF 的情况下调用这些函数会引发明确的错误。
# 参见 requirements-optional.txt。
try:
    import fitz  # PyMuPDF — 可选，AGPL-3.0
except ImportError:  # pragma: no cover
    fitz = None

logger = logging.getLogger(__name__)

_PYMUPDF_MISSING = (
    "PDF form features require PyMuPDF, an optional dependency. Install it with "
    "`pip install -r requirements-optional.txt` (note: PyMuPDF is AGPL-3.0)."
)


def _require_fitz():
    """如果缺少可选的 PyMuPDF 依赖，引发明确的错误。"""
    if fitz is None:
        raise RuntimeError(_PYMUPDF_MISSING)
    return fitz


def _widget_type_names() -> dict:
    return {
        fitz.PDF_WIDGET_TYPE_UNKNOWN: "unknown",
        fitz.PDF_WIDGET_TYPE_BUTTON: "button",
        fitz.PDF_WIDGET_TYPE_CHECKBOX: "checkbox",
        fitz.PDF_WIDGET_TYPE_RADIOBUTTON: "radio",
        fitz.PDF_WIDGET_TYPE_TEXT: "text",
        fitz.PDF_WIDGET_TYPE_LISTBOX: "listbox",
        fitz.PDF_WIDGET_TYPE_COMBOBOX: "combobox",
        fitz.PDF_WIDGET_TYPE_SIGNATURE: "signature",
    }

# 实际是签名占位符的文本控件。涵盖 DocuSign 风格的
# "_es_:签名ature" 以及英国产权转让表格（TA6、TA10）中常见的
# 裸 "签名ed N" / "Signature" 模式。有意使用子串匹配 —
# 像 "as签名ed" 这样的误报在表单字段名称中很少见。
_SIGNATURE_NAME_RE = re.compile(r'sign(?:ed|ature)', re.IGNORECASE)


def has_form_fields(path: str) -> bool:
    """如果 PDF 看起来像一个*可填充表单* — 而不仅仅是恰好
    带有一两个孤立控件的纯内容 PDF，则返回 True。

    Excel 导出的 PDF（日本估价单、发票等）通常附带有
    一两个孤立的 AcroForm 控件（签名印章框、源模板留下的
    文本字段），即使它们实际上是纯内容文档。
    将它们视为表单会将它们路由到表单填充聊天提示，
    该提示询问用户要编辑哪个字段而不是讨论内容 —
    这正是我们要避免的问题。

    启发式规则：要求至少 3 个非签名控件。纯签名
    PDF（例如带有一个签名字段的合同）当作内容读取，
    而少量孤立控件不再劫持聊天。真正的英国产权转让
    表格（TA6、TA10）及类似文件包含数十个控件，
    仍能轻松触及此阈值。
    """
    _require_fitz()
    try:
        doc = fitz.open(path)
    except Exception as e:
        logger.warning(f"Could not open PDF {path} for form detection: {e}")
        return False
    try:
        non_signature_count = 0
        for page in doc:
            for w in page.widgets() or []:
                if w.field_type != fitz.PDF_WIDGET_TYPE_SIGNATURE:
                    non_signature_count += 1
                    if non_signature_count >= 3:
                        return True
        return False
    finally:
        doc.close()


def _infer_label(page: "fitz.Page", rect: "fitz.Rect", page_words: list) -> str:
    """从控件附近的文本进行尽力标签推断。

    策略：优先选择同一行上左侧紧邻的文本，
    然后选择紧靠上方的文本。返回最近的非空匹配
    或在没有有用内容时返回 ""。AcroForm field_label 在
    实际表单中很少被填充，因此此回退很重要。
    """
    candidates_left = []
    candidates_above = []
    line_tol = max(2.0, rect.height * 0.6)

    for w in page_words:
        wx0, wy0, wx1, wy1, text = w[0], w[1], w[2], w[3], w[4]
        if not text.strip():
            continue
        # 同一行，在左侧
        if abs((wy0 + wy1) / 2 - (rect.y0 + rect.y1) / 2) < line_tol and wx1 <= rect.x0 + 1:
            candidates_left.append((rect.x0 - wx1, wx0, text))
        # 在上方，水平重叠
        elif wy1 <= rect.y0 + 1 and not (wx1 < rect.x0 or wx0 > rect.x1):
            candidates_above.append((rect.y0 - wy1, wx0, text))

    def _join_nearest(cands, gap_limit):
        if not cands:
            return ""
        cands.sort(key=lambda c: (c[0], c[1]))
        nearest_dist = cands[0][0]
        if nearest_dist > gap_limit:
            return ""
        same = [c for c in cands if c[0] - nearest_dist < line_tol]
        same.sort(key=lambda c: c[1])
        return " ".join(c[2] for c in same).strip()

    label = _join_nearest(candidates_left, gap_limit=200.0)
    if label:
        return label
    return _join_nearest(candidates_above, gap_limit=40.0)


def _widget_on_state(w) -> str:
    try:
        return w.on_state() or ""
    except Exception:
        return ""


def extract_fields(path: str) -> list[dict[str, Any]]:
    """枚举表单字段，每个唯一字段名一个条目。

    共享字段名的多个复选框控件被视为单个
    "choice" 字段，其选项是每个控件的 on-state — 这是
    用于单选样式 "Included / Excluded / None" 行的 PDF 惯用做法。

    返回字典，包含：name, type, label, value, options, page (1-indexed),
    rect (x0,y0,x1,y1) 为组中第一个控件, required。
    """
    _require_fitz()
    names = _widget_type_names()
    grouped: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    try:
        doc = fitz.open(path)
    except Exception as e:
        logger.error(f"Could not open PDF {path} for field extraction: {e}")
        return []

    try:
        for page_index, page in enumerate(doc):
            widgets = page.widgets() or []
            if not widgets:
                continue
            words = page.get_text("words")
            for w in widgets:
                name = w.field_name or ""
                if not name:
                    continue
                wtype = names.get(w.field_type, "unknown")
                label = (getattr(w, "field_label", None) or "").strip()
                if not label:
                    label = _infer_label(page, w.rect, words)
                value = w.field_value if w.field_value is not None else ""
                on_state = _widget_on_state(w) if wtype == "checkbox" else ""

                if name not in grouped:
                    # AdobeSign 风格的签名占位符被存储为
                    # 纯文本控件，但命名为 `_es_:签名ature`。
                    if wtype == "text" and _SIGNATURE_NAME_RE.search(name):
                        wtype = "signature"
                    order.append(name)
                    grouped[name] = {
                        "name": name,
                        "type": wtype,
                        "label": label,
                        "value": value,
                        "options": list(w.choice_values) if w.choice_values else (
                            [on_state] if on_state else []
                        ),
                        "page": page_index + 1,
                        "rect": [w.rect.x0, w.rect.y0, w.rect.x1, w.rect.y1],
                        "required": bool((w.field_flags or 0) & 2),
                        "_on_states": [on_state] if on_state else [],
                    }
                else:
                    g = grouped[name]
                    if not g["label"] and label:
                        g["label"] = label
                    if value and not g["value"]:
                        g["value"] = value
                    if on_state and on_state not in g["_on_states"]:
                        g["_on_states"].append(on_state)
                        if on_state not in g["options"]:
                            g["options"].append(on_state)
                    # 如果复选框名称出现多次且有不同的 on-states，
                    # 将其提升为 choice 字段。
                    if wtype == "checkbox" and len(g["_on_states"]) > 1:
                        g["type"] = "choice"
    finally:
        doc.close()

    out = []
    for name in order:
        g = grouped[name]
        g.pop("_on_states", None)
        out.append(g)
    return out


def stamp_signatures(
    pdf_path: str,
    output_path: str,
    stamps: dict[str, bytes],
) -> int:
    """将 PNG 签名图像印章到每个命名字段 rect 处的 PDF 中。

    `stamps` 为 {field_name: png_bytes}。每个命名字段在
    AcroForm 中找到；图像绘制到字段的矩形中，保持宽高比。
    控件本身保持不变（仍为表单字段），以便以后需要时
    重新编辑；印章渲染在顶部。

    返回写入的印章数量。传入源 PDF（或
    fill_fields 的已填充输出）和新的 output_path。
    """
    if not stamps:
        return 0
    _require_fitz()
    doc = fitz.open(pdf_path)
    written = 0
    try:
        for page in doc:
            for w in page.widgets() or []:
                name = w.field_name
                if name not in stamps:
                    continue
                png = stamps[name]
                if not png:
                    continue
                try:
                    page.insert_image(w.rect, stream=png, keep_proportion=True, overlay=True)
                    written += 1
                except Exception as e:
                    logger.warning(f"Failed to stamp signature into {name}: {e}")
        doc.save(output_path, incremental=False, deflate=True)
    finally:
        doc.close()
    return written


def stamp_annotations(
    pdf_path: str,
    output_path: str,
    annotations: list[dict],
    signature_pngs: dict[str, bytes] | None = None,
) -> int:
    """将自由形式标注（文本、勾选、签名）烧录到 PDF 上。

    每个标注具有页面百分比坐标（x, y, w, h: 0–100），一个 `kind`
    属于 {text, check, signature}，一个字符串 value，以及文本的 line_height。
    返回印章的标注数量。
    """
    if not annotations:
        return 0
    _require_fitz()
    signature_pngs = signature_pngs or {}
    doc = fitz.open(pdf_path)
    written = 0
    try:
        for ann in annotations:
            try:
                page_no = int(ann.get("page") or 1)
                if page_no < 1 or page_no > doc.page_count:
                    continue
                page = doc[page_no - 1]
                pw, ph = page.rect.width, page.rect.height
                x = float(ann.get("x", 0)) / 100.0 * pw
                y = float(ann.get("y", 0)) / 100.0 * ph
                w = float(ann.get("w", 0)) / 100.0 * pw
                h = float(ann.get("h", 0)) / 100.0 * ph
                rect = fitz.Rect(x, y, x + w, y + h)
                kind = ann.get("kind", "text")
                value = ann.get("value", "")

                if kind == "text":
                    if not value:
                        continue
                    line_height = float(ann.get("line_height") or 1.3)
                    lines = value.split("\n")
                    # 根据 HTML 指标，行框的基线位于 fontsize × (lh + 0.6) / 2
                    # regardless of how each was resized. Per HTML 指标 the
                    # 根据 HTML 指标，行框的基线位于 fontsize × (lh + 0.6) / 2
                    # from the line-box top (half the leading above the glyph,
                    # 一半在下方，ascent ≈ 0.8 × fontsize）。
                    fontsize = 11.0
                    # Stride between lines is tuned to match what the editor
                    # shows: the editor's textarea renders text larger than
                    # 呈现的文本比 11pt 更大（基于 cqh ≈ 页面图像高度的 1.5%
                    # ≈ Letter 的 17pt），因此其行间距比页面上的 11 × lh 更宽。
                    # the page. Multiply the export stride to compensate.
                    line_box = fontsize * line_height * 1.2
                    # 首行基线位于框顶部下方一个 ascent 处 — 最接近
                    # 编辑器第一行文本出现的位置。
                    yy = y + fontsize * 0.85
                    # 匹配 textarea 的 4px 左边距（~3 PDF 点）。
                    xx = x + 3.0
                    for line in lines:
                        try:
                            page.insert_text(
                                (xx, yy),
                                line,
                                fontsize=fontsize,
                                color=(0, 0, 0),
                            )
                        except Exception as e:
                            logger.warning(f"insert_text failed for annotation: {e}")
                        yy += line_box
                    written += 1

                elif kind == "check":
                    # 绘制填充框的勾选标记笔画。
                    cx = x + w / 2.0
                    cy = y + h / 2.0
                    size = min(w, h) * 0.85
                    p1 = fitz.Point(cx - size * 0.40, cy + size * 0.05)
                    p2 = fitz.Point(cx - size * 0.10, cy + size * 0.30)
                    p3 = fitz.Point(cx + size * 0.45, cy - size * 0.30)
                    shape = page.new_shape()
                    shape.draw_polyline([p1, p2, p3])
                    shape.finish(
                        color=(0, 0, 0),
                        width=max(1.0, size * 0.13),
                        lineCap=1,
                        lineJoin=1,
                    )
                    shape.commit()
                    written += 1

                elif kind == "signature":
                    if not isinstance(value, str) or not value.startswith("signature:"):
                        continue
                    sid = value[len("signature:"):].strip()
                    png = signature_pngs.get(sid)
                    if not png:
                        continue
                    try:
                        page.insert_image(rect, stream=png, keep_proportion=True, overlay=True)
                        written += 1
                    except Exception as e:
                        logger.warning(f"signature stamp failed: {e}")
            except Exception as e:
                logger.warning(f"Failed to stamp annotation {ann.get('id')}: {e}")
                continue
        doc.save(output_path, incremental=False, deflate=True)
    finally:
        doc.close()
    return written


def fill_fields(source_path: str, output_path: str, values: dict[str, Any]) -> int:
    """将值写回 AcroForm 并保存新的 PDF。

    返回更新的字段数量。忽略未知的字段名称。
    保留源 PDF 的布局。
    """
    _require_fitz()
    doc = fitz.open(source_path)
    updated = 0
    try:
        for page in doc:
            for w in page.widgets() or []:
                name = w.field_name
                if name not in values:
                    continue
                new_value = values[name]
                if w.field_type == fitz.PDF_WIDGET_TYPE_CHECKBOX:
                    on_state = _widget_on_state(w)
                    if isinstance(new_value, bool):
                        # 单个复选框：bool 语义
                        w.field_value = (on_state or "Yes") if new_value else "Off"
                    else:
                        # Choice/radio 组：只有 on_state 匹配的控件
                        # 获得该 on_state；其余为 Off。
                        chosen = "" if new_value is None else str(new_value).strip()
                        w.field_value = on_state if on_state and on_state == chosen else "Off"
                else:
                    w.field_value = "" if new_value is None else str(new_value)
                w.update()
                updated += 1
        doc.save(output_path, incremental=False, deflate=True)
    finally:
        doc.close()
    return updated
