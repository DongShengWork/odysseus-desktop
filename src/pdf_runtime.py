"""可选 PDF 运行时依赖的小型辅助函数。"""

PDF_VIEWER_PYMUPDF_MISSING = (
    "PDF viewer requires PyMuPDF. Install optional PDF dependencies with "
    "`pip install -r requirements-optional.txt` (PyMuPDF is AGPL-3.0)."
)


def load_pymupdf_for_pdf_viewer():
    """返回 PyMuPDF 模块，或抛出面向用户的安装提示。"""
    try:
        import fitz  # PyMuPDF, 可选
    except ImportError as exc:
        raise RuntimeError(PDF_VIEWER_PYMUPDF_MISSING) from exc
    return fitz
