"""
rag_server.py

MCP 服务器，暴露 RAG 文档管理功能（列表、添加目录、移除目录）。
"""

import asyncio
import os
import sys
from pathlib import Path

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

server = Server("rag")

_rag_manager = None
_personal_docs_manager = None
_initialized = False


def _ensure_init():
    """首次使用时延迟初始化 RAG 管理器。"""
    global _rag_manager, _personal_docs_manager, _initialized
    if _initialized:
        return
    _initialized = True

    try:
        from src.rag_singleton import get_rag_manager
        _rag_manager = get_rag_manager()
    except Exception:
        pass

    try:
        from src.constants import PERSONAL_DIR
        from src.personal_docs import PersonalDocsManager
        _personal_docs_manager = PersonalDocsManager(PERSONAL_DIR, _rag_manager)
    except Exception:
        pass


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="manage_rag",
            description="Manage RAG indexed documents. List indexed files, add directories, or remove directories.",
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "add_directory", "remove_directory"],
                        "description": "The action to perform",
                    },
                    "directory": {"type": "string", "description": "Directory path (for add/remove)"},
                },
                "required": ["action"],
            },
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name != "manage_rag":
        return [TextContent(type="text", text=f"Unknown tool: {name}")]

    _ensure_init()
    action = arguments.get("action", "")

    if action == "list":
        if not _personal_docs_manager:
            return [TextContent(type="text", text="Personal docs manager not available. RAG may not be configured.")]
        try:
            files = getattr(_personal_docs_manager, 'index', None) or []
            dirs = []
            if hasattr(_personal_docs_manager, 'get_indexed_directories'):
                dirs = _personal_docs_manager.get_indexed_directories()

            lines = []
            if dirs:
                lines.append(f"**Indexed directories ({len(dirs)}):**")
                for d in dirs:
                    lines.append(f"  - `{d}`")
            if files:
                lines.append(f"\n**Indexed files ({len(files)}):**")
                for f in files[:50]:
                    fname = f.get("name", str(f)) if isinstance(f, dict) else str(f)
                    lines.append(f"  - {fname}")
                if len(files) > 50:
                    lines.append(f"  ... and {len(files) - 50} more")
            if not lines:
                return [TextContent(type="text", text="No files or directories indexed in RAG.")]
            return [TextContent(type="text", text="\n".join(lines))]
        except Exception as e:
            return [TextContent(type="text", text=f"Error: {e}")]

    elif action == "add_directory":
        _dir = arguments.get("directory")
        directory = _dir.strip() if isinstance(_dir, str) else ""
        if not directory:
            return [TextContent(type="text", text="Error: add_directory needs a directory path")]
        # 存储绝对路径，以便索引的 `source` 元数据为绝对路径，
        # 并且 remove_directory（使用 abspath 规范化）后续可以匹配它 (#1660)。
        directory = os.path.abspath(os.path.expanduser(directory))
        if not os.path.isdir(directory):
            return [TextContent(type="text", text=f"Error: Directory not found: {directory}")]
        if not _rag_manager:
            return [TextContent(type="text", text="Error: RAG manager not available")]
        try:
            result = _rag_manager.index_personal_documents(directory)
            indexed = result.get("indexed_count", 0) if isinstance(result, dict) else 0
            # 记录目录以便 `list` 和 `remove_directory` 可以看到它。
            # 索引刚刚在上面完成，因此传入 索引=False 以避免第二次
            # （无所有者）扫描。否则目录已被索引但从未在 索引ed_directories
            # 中被跟踪，导致其不可见/不可移除。
            if _personal_docs_manager and hasattr(_personal_docs_manager, "add_directory"):
                try:
                    _personal_docs_manager.add_directory(directory, index=False)
                except Exception:
                    pass
            return [TextContent(type="text", text=f"Directory '{directory}' added to RAG index ({indexed} chunks indexed)")]
        except Exception as e:
            return [TextContent(type="text", text=f"Error: Failed to index directory: {e}")]

    elif action == "remove_directory":
        _dir = arguments.get("directory")
        directory = _dir.strip() if isinstance(_dir, str) else ""
        if not directory:
            return [TextContent(type="text", text="Error: remove_directory needs a directory path")]
        # 展开 ~ 以匹配 add_directory（add_directory 索引的是展开后的路径）。
        # 否则移除 "~/docs" 永远无法匹配存储的绝对路径。
        directory = os.path.expanduser(directory)
        if not _personal_docs_manager:
            return [TextContent(type="text", text="Error: Personal docs manager not available")]
        try:
            if hasattr(_personal_docs_manager, 'remove_directory'):
                _personal_docs_manager.remove_directory(directory)
            if _rag_manager and hasattr(_rag_manager, 'remove_directory'):
                _rag_manager.remove_directory(directory)
            return [TextContent(type="text", text=f"Directory '{directory}' removed from RAG index")]
        except Exception as e:
            return [TextContent(type="text", text=f"Error: Failed to remove directory: {e}")]

    else:
        return [TextContent(type="text", text=f"Error: Unknown action '{action}'. Use: list, add_directory, remove_directory")]


async def run():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(run())
