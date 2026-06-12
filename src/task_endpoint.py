"""后台任务 AI 端点的共享解析器（自动命名、记忆、分类）。"""

from src.endpoint_resolver import resolve_endpoint


def resolve_task_endpoint(fallback_url=None, fallback_model=None, fallback_headers=None, owner=None):
    """返回后台任务的 (endpoint_url, model, headers)。

    从管理员设置中读取 task_endpoint_id / task_model。
    当设置为空或端点无法解析时，回退到提供的值。
    """
    return resolve_endpoint("task", fallback_url, fallback_model, fallback_headers, owner=owner)
