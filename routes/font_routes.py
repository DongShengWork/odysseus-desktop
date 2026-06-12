"""自定义字体发现 — 列出用户在 static/fonts/custom/ 中提供的字体文件。"""
import os
import re
from fastapi import APIRouter

CUSTOM_FONTS_DIR = os.path.join("static", "fonts", "custom")
FONT_EXTENSIONS = {".ttf", ".otf", ".woff", ".woff2"}
FAMILY_SUFFIX_WORDS = ("Display", "Rounded", "Serif", "Sans", "Mono", "Code", "Text")


def _split_family_token(token):
    """拆分常见的紧凑字体系列后缀，而不破坏品牌名称。"""
    for suffix in FAMILY_SUFFIX_WORDS:
        if token.endswith(suffix) and len(token) > len(suffix):
            return f"{token[:-len(suffix)]} {suffix}"
    return re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', token)


def _derive_family(filename):
    """从文件名（如 'JetBrainsMono-Regular.woff2' → 'JetBrains Mono'）派生出字体系列名称。"""
    name = os.path.splitext(filename)[0]
    # 去除常见的粗细/样式后缀
    name = re.sub(
        r'[-_ ]?(Thin|ExtraLight|UltraLight|Light|Regular|Medium|SemiBold|DemiBold|Bold|ExtraBold|UltraBold|Black|Heavy|Italic|Oblique|Variable|VF)$',
        '', name, flags=re.IGNORECASE
    )
    # 将连字符/下划线替换为空格
    name = re.sub(r'[-_]+', ' ', name).strip()
    name = " ".join(_split_family_token(part) for part in name.split())
    return name or filename


def setup_font_routes():
    router = APIRouter(prefix="/api/fonts", tags=["fonts"])

    @router.get("/custom")
    async def list_custom_fonts():
        """返回按派生的字体系列名称分组的可用自定义字体。"""
        os.makedirs(CUSTOM_FONTS_DIR, exist_ok=True)
        families = {}
        for f in sorted(os.listdir(CUSTOM_FONTS_DIR)):
            ext = os.path.splitext(f)[1].lower()
            if ext not in FONT_EXTENSIONS:
                continue
            family = _derive_family(f)
            if family not in families:
                families[family] = []
            families[family].append({
                "file": f,
                "url": f"/static/fonts/custom/{f}",
                "format": ext.lstrip('.'),
            })
        return {"fonts": families}

    return router
