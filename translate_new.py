#!/usr/bin/env python3
"""
Translate English comments and docstrings in new Python files to Chinese.
Works by detecting comment/docstring lines and applying a comprehensive
translation dictionary.
"""
import re
import os
import sys

# Comprehensive comment translation dictionary
# Format: "english phrase" -> "chinese translation"
# Matches exact full-line comments (stripped) and applies translations
COMMENT_MAP = {
    # Common patterns
    "Core imports": "核心模块导入",
    "TODO": "待办",
    "FIXME": "修复",
    "NOTE": "注意",
    "HACK": "临时方案",
    "XXX": "待修复",
    # Auth / Security
    "Require admin": "需要管理员权限",
    "Validate ownership": "验证所有权",
    "Check authentication": "检查认证",
    "Bearer token": "Bearer 令牌",
    "API key": "API 密钥",
    "Session token": "会话令牌",
    "Unauthorized": "未授权",
    "Forbidden": "禁止访问",
    # Database
    "Database session": "数据库会话",
    "Commit transaction": "提交事务",
    "Rollback": "回滚",
    "Query": "查询",
    # File operations
    "Read file": "读取文件",
    "Write file": "写入文件",
    "Delete file": "删除文件",
    "Upload file": "上传文件",
    "File not found": "文件未找到",
    # Error handling
    "Error handling": "错误处理",
    "Exception": "异常",
    "Invalid request": "无效请求",
    "Bad request": "错误请求",
    "Internal server error": "内部服务器错误",
    # HTTP
    "Request body": "请求体",
    "Response": "响应",
    "Status code": "状态码",
    "Headers": "请求头",
    # Logging
    "Log error": "记录错误",
    "Log warning": "记录警告",
    "Log info": "记录信息",
}

# Docstring / comment phrase translations (substring matching)
PHRASE_MAP = {
    "Route handler for": "路由处理器",
    "Helper function": "辅助函数",
    "Helper functions": "辅助函数",
    "Utility function": "工具函数",
    "Utility functions": "工具函数",
    "Validate the": "验证",
    "Process the": "处理",
    "Handle the": "处理",
    "Create a new": "创建新的",
    "Delete the": "删除",
    "Update the": "更新",
    "Get the": "获取",
    "List all": "列出所有",
    "Return the": "返回",
    "Returns the": "返回",
    "Check if": "检查是否",
    "Ensure that": "确保",
    "Make sure": "确保",
    "Raise an error": "抛出错误",
    "Raise HTTPException": "抛出 HTTPException",
    "authentication": "认证",
    "authorization": "授权",
    "middleware": "中间件",
    "database": "数据库",
    "session": "会话",
    "request": "请求",
    "response": "响应",
    "endpoint": "端点",
    "parameter": "参数",
    "configuration": "配置",
    "environment": "环境",
    "dependency": "依赖",
    "validation": "验证",
    "serialization": "序列化",
    "deserialization": "反序列化",
    "pagination": "分页",
    "filtering": "过滤",
    "sorting": "排序",
    "caching": "缓存",
    "logging": "日志",
    "error handling": "错误处理",
    "file upload": "文件上传",
    "file download": "文件下载",
    "image processing": "图像处理",
    "email sending": "邮件发送",
    "background task": "后台任务",
    "scheduled task": "定时任务",
    "webhook": "Webhook",
    "API token": "API 令牌",
    "owner scope": "所有者作用域",
    "ownership": "所有权",
    "tenant": "租户",
    "workspace": "工作空间",
}

# Module-level docstring translations
MODULE_DOCSTRINGS = {
    "Upload routes": "上传路由",
    "Memory routes": "记忆路由",
    "Workspace routes": "工作空间路由",
    "Cookbook output": "Cookbook 输出",
    "Validators": "验证器",
    "Document tools": "文档工具",
    "Filesystem tools": "文件系统工具",
    "Subprocess tools": "子进程工具",
    "Web tools": "Web 工具",
    "Chat handler": "聊天处理器",
    "Chat helpers": "聊天辅助函数",
    "Chat processor": "聊天处理器",
    "Agent tools": "智能体工具",
    "Cleanup service": "清理服务",
    "Document processor": "文档处理器",
    "Email thread parser": "邮件线程解析器",
    "Generated images": "生成的图像",
    "Optional dependencies": "可选依赖",
    "Reminder personas": "提醒角色",
    "Request models": "请求模型",
    "Service health": "服务健康检查",
    "Search analytics": "搜索分析",
}


def translate_line_comment(line):
    """Translate a single-line # comment."""
    stripped = line.lstrip()
    if not stripped.startswith('#'):
        return line
    
    indent = line[:len(line) - len(stripped)]
    comment_text = stripped[1:].strip()
    
    # Check exact match first
    if comment_text in COMMENT_MAP:
        return f"{indent}# {COMMENT_MAP[comment_text]}\n"
    
    # Try phrase-by-phrase translation
    translated = comment_text
    for en, zh in sorted(PHRASE_MAP.items(), key=lambda x: -len(x[0])):
        translated = translated.replace(en, zh)
    
    if translated != comment_text:
        return f"{indent}# {translated}\n"
    
    return line


def translate_file(filepath):
    """Translate comments in a Python file."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except Exception as e:
        return 0, f"read error: {e}"
    
    result = []
    translated_count = 0
    
    for line in lines:
        stripped = line.strip()
        
        # Skip empty lines and non-comment lines
        if not stripped or (not stripped.startswith('#') and '#' not in stripped):
            result.append(line)
            continue
        
        # Handle full-line comments
        if stripped.startswith('#'):
            new_line = translate_line_comment(line)
            if new_line != line:
                translated_count += 1
            result.append(new_line)
            continue
        
        # Handle inline comments (code # comment)
        # Be careful with strings containing #
        code_part = line
        comment_start = -1
        in_string = None
        for i, ch in enumerate(line):
            if ch in ('"', "'") and (i == 0 or line[i-1] != '\\'):
                if in_string is None:
                    in_string = ch
                elif in_string == ch:
                    in_string = None
            elif ch == '#' and in_string is None:
                comment_start = i
                break
        
        if comment_start > 0:
            code_part = line[:comment_start]
            comment_part = line[comment_start:]
            new_comment = translate_line_comment("  " + comment_part)
            if new_comment.strip() != comment_part.strip():
                translated_count += 1
                result.append(code_part + new_comment.lstrip())
            else:
                result.append(line)
        else:
            result.append(line)
    
    if translated_count > 0:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.writelines(result)
    
    return translated_count, f"translated {translated_count} comments"


# Files to translate
NEW_FILES = [
    "routes/_validators.py",
    "routes/cookbook_output.py",
    "routes/memory_routes.py",
    "routes/upload_routes.py",
    "routes/workspace_routes.py",
    "src/agent_tools/__init__.py",
    "src/agent_tools/document_tools.py",
    "src/agent_tools/filesystem_tools.py",
    "src/agent_tools/subprocess_tools.py",
    "src/agent_tools/web_tools.py",
    "src/chat_handler.py",
    "src/chat_helpers.py",
    "src/chat_processor.py",
    "src/chatgpt_subscription.py",
    "src/cleanup_service.py",
    "src/document_processor.py",
    "src/email_thread_parser.py",
    "src/generated_images.py",
    "src/optional_deps.py",
    "src/reminder_personas.py",
    "src/request_models.py",
    "src/search/__init__.py",
    "src/search/analytics.py",
    "src/service_health.py",
    "services/hwfit/__init__.py",
    "services/stt/__init__.py",
    "services/tts/__init__.py",
    "services/youtube/__init__.py",
    "routes/__init__.py",
    "mcp_servers/__init__.py",
    "core/__init__.py",
    # New JS files
    "static/js/cookbook-deps-recipes.js",
    "static/js/workspace.js",
]


def main():
    total = 0
    for f in NEW_FILES:
        if not os.path.exists(f):
            print(f"  SKIP {f} (not found)")
            continue
        count, msg = translate_file(f)
        total += count
        if count > 0:
            print(f"  ✓ {f}: {msg}")
        else:
            print(f"  - {f}: {msg}")
    
    print(f"\nTotal: {total} comments translated in {len(NEW_FILES)} new files")


if __name__ == "__main__":
    main()
