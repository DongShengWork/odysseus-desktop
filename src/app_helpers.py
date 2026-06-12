# src/app_helpers.py
import os
import base64

def read_if_exists(path: str) -> str:
    """若文件存在则读取，否则返回空字符串。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""

def file_to_data_url(path: str, mime: str) -> str:
    """将文件转换为 data URL。"""
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"

def abs_join(base_dir: str, rel: str) -> str:
    """拼接路径并返回绝对路径。"""
    return os.path.abspath(os.path.join(base_dir, rel))

def inside_base_dir(base_dir: str, path: str) -> bool:
    """检查路径是否在基础目录内。"""
    if not isinstance(base_dir, str) or not isinstance(path, str):
        return False
    base = os.path.realpath(base_dir)
    p = os.path.realpath(path)
    try:
        return os.path.commonpath([base, p]) == base
    except Exception:
        return False
