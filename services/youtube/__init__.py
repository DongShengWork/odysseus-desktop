"""YouTube 服务 — 字幕提取。"""

from .youtube_handler import (
    init_youtube,
    is_youtube_url,
    extract_youtube_id,
    extract_transcript_async,
    format_transcript_for_context,
    fetch_youtube_comments,
    format_comments_for_context,
)

__all__ = [
    "init_youtube",
    "is_youtube_url",
    "extract_youtube_id",
    "extract_transcript_async",
    "format_transcript_for_context",
    "fetch_youtube_comments",
    "format_comments_for_context",
]
