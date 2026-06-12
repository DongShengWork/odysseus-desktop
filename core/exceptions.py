# src/exceptions.py — 自定义异常模块
"""应用的自定义异常。"""

class SessionNotFoundError(Exception):
    """当请求的会话未找到时抛出。"""
    def __init__(self, session_id: str):
        self.session_id = session_id
        super().__init__(f"Session '{session_id}' not found")

class InvalidFileUploadError(Exception):
    """当文件上传未通过验证时抛出。"""
    def __init__(self, message: str, filename: str = None):
        self.filename = filename
        self.message = message
        super().__init__(message)

class LLMServiceError(Exception):
    """当与 LLM 服务通信发生错误时抛出。"""
    def __init__(self, message: str, endpoint: str = None):
        self.endpoint = endpoint
        self.message = message
        super().__init__(message)

class WebSearchError(Exception):
    """当网页搜索功能发生错误时抛出。"""
    def __init__(self, message: str, query: str = None):
        self.query = query
        self.message = message
        super().__init__(message)
