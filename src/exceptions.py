# src/exceptions.py
"""应用程序自定义异常。"""

class SessionNotFoundError(Exception):
    """请求的会话未找到时抛出。"""
    def __init__(self, session_id: str):
        self.session_id = session_id
        super().__init__(f"Session '{session_id}' not found")

class InvalidFileUploadError(Exception):
    """文件上传验证失败时抛出。"""
    def __init__(self, message: str, filename: str = None):
        self.filename = filename
        self.message = message
        super().__init__(message)

class LLMServiceError(Exception):
    """与 LLM 服务通信出错时抛出。"""
    def __init__(self, message: str, endpoint: str = None):
        self.endpoint = endpoint
        self.message = message
        super().__init__(message)

class WebSearchError(Exception):
    """网页搜索功能出错时抛出。"""
    def __init__(self, message: str, query: str = None):
        self.query = query
        self.message = message
        super().__init__(message)
