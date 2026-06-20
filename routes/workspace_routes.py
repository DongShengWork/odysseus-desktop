"""工作空间 API - 浏览服务器目录以选择工具工作空间文件夹。"""
import os
from fastapi import APIRouter, Request, HTTPException, Query

from src.auth_helpers import get_current_user
from src.tool_security import owner_is_admin_or_single_user

# 每个目录返回的条目上限（与 filesystem_tools._CODENAV_MAX_HITS 一致）。
# 大目录不应将数千行倒入选择器；用户可以
# 输入/粘贴路径直接跳转。
_MAX_BROWSE_DIRS = 500


def setup_workspace_routes():
    router = APIRouter(prefix="/api/workspace", tags=["workspace"])

    @router.get("/browse")
    def browse(request: Request, path: str = Query(default="")):
        """列出 `path`（默认：home）的子目录，以便 UI 导航
        服务器文件系统并选择工作空间文件夹。仅目录。

        仅管理员：此功能枚举服务器文件系统，因此与
        文件/shell 工具的限制相同（read_file/write_file/bash 在
        NON_ADMIN_BLOCKED_TOOLS 中）。不能使用这些工具的非管理员也
        不应能够映射主机的目录树。
        """
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            raise HTTPException(status_code=403, detail="Workspace browsing is admin-only")

        # 解析符号链接，使报告的路径是规范路径，UI 导航真实
        # 目录（防止显示路径中的符号链接欺骗）。
        target = os.path.realpath(os.path.expanduser(path.strip() or "~"))
        if not os.path.isdir(target):
            target = os.path.realpath(os.path.expanduser("~"))

        dirs = []
        try:
            with os.scandir(target) as it:
                for entry in it:
                    try:
                        # 分类时不跟随符号链接 - 符号链接的
                        # 目录会被跳过，而不是让浏览器通过链接
                        # 跳转到其他位置。隐藏条目会被省略。
                        if entry.is_dir(follow_symlinks=False) and not entry.name.startswith("."):
                            # 在服务端使用 os.path.join 构建子路径
                            # 以确保在 Windows（反斜杠）和 Linux 上都正确。
                            dirs.append({"name": entry.name, "path": os.path.join(target, entry.name)})
                    except OSError:
                        continue
        except (PermissionError, OSError):
            dirs = []

        dirs_sorted = sorted(dirs, key=lambda d: d["name"].lower())
        truncated = len(dirs_sorted) > _MAX_BROWSE_DIRS
        parent = os.path.dirname(target)
        from src.tool_execution import vet_workspace
        return {
            "path": target,
            "parent": parent if parent and parent != target else None,
            "dirs": dirs_sorted[:_MAX_BROWSE_DIRS],
            "truncated": truncated,
            # 此目录是否可绑定为工作空间（文件系统
            # 根目录和敏感目录可浏览但不能选择）。
            "selectable": vet_workspace(target) is not None,
        }

    @router.get("/vet")
    def vet(request: Request, path: str = Query(default="")):
        """验证工作空间路径而不绑定它。

        UI 在持久化手动输入的路径之前调用此接口（/workspace
        set），这样拼写错误、文件路径、已删除的文件夹、敏感目录或文件系统
        根目录会被提前拒绝，成功时返回规范路径，
        而不是在客户端存储并在聊天时静默丢弃。
        与 /browse 一样仅限管理员：它确认主机上的路径存在。
        """
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            raise HTTPException(status_code=403, detail="Workspace selection is admin-only")
        from src.tool_execution import vet_workspace
        resolved = vet_workspace(path)
        return {"ok": resolved is not None, "path": resolved}

    return router
