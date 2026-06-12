"""备份路由 — 导出/导入用户数据（记忆、预设、设置、技能、偏好）。"""

import json
import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Response
from core.middleware import require_admin
from src.auth_helpers import get_current_user
from src.settings import load_settings, save_settings, load_features, save_features

logger = logging.getLogger(__name__)


def setup_backup_routes(memory_manager, preset_manager, skills_manager) -> APIRouter:
    router = APIRouter(tags=["backup"])

    @router.get("/api/export")
    async def export_data(request: Request):
        """将所有用户数据导出为可下载的 JSON 文件。"""
        require_admin(request)
        user = get_current_user(request)

        # 记忆（启用认证时按 owner 过滤）
        memories = memory_manager.load(owner=user)

        # 预设（跨用户共享 — 导出全部）
        presets = preset_manager.get_all()

        # 技能（启用认证时按 owner 过滤）
        skills = skills_manager.load(owner=user)

        # 设置
        settings = load_settings()

        # 功能标志
        features = load_features()

        # 用户偏好设置
        from routes.prefs_routes import _load_for_user
        preferences = _load_for_user(user)

        export_data = {
            "version": 1,
            "exported_at": datetime.now().isoformat(),
            "exported_by": user,
            "memories": memories,
            "presets": presets,
            "skills": skills,
            "settings": settings,
            "features": features,
            "preferences": preferences,
        }

        filename = f"odysseus_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        return Response(
            content=json.dumps(export_data, indent=2, ensure_ascii=False),
            media_type="application/json",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    @router.post("/api/import")
    async def import_data(request: Request):
        """从先前导出的 JSON 文件导入用户数据。与已有数据合并。"""
        require_admin(request)
        user = get_current_user(request)
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(400, "Invalid JSON")

        if not isinstance(body, dict):
            raise HTTPException(400, "Expected a JSON object")

        imported = []

        # ── Memories ──
        if "memories" in body and isinstance(body["memories"], list):
            existing = memory_manager.load_all()
            # 仅对该用户自己的记忆去重。使用所有租户的行
            # 意味着一个记忆的文本如果匹配了其他用户的记忆就会被静默跳过，
            # 导致导入用户丢失自己的数据。完整存储仍然在下面保存。
            existing_texts = {e.get("text", "").strip().lower()
                              for e in existing if e.get("owner") == user}
            added = 0
            for mem in body["memories"]:
                if not isinstance(mem, dict) or not mem.get("text"):
                    continue
                if mem["text"].strip().lower() in existing_texts:
                    continue  # 跳过重复项
                # 启用认证时分配 owner
                if user and not mem.get("owner"):
                    mem["owner"] = user
                existing.append(mem)
                existing_texts.add(mem["text"].strip().lower())
                added += 1
            memory_manager.save(existing)
            imported.append(f"{added} memories")

        # ── Skills ──
        if "skills" in body and isinstance(body["skills"], list):
            existing = skills_manager.load_all()
            existing_names = {s.get("name") for s in existing if s.get("name")}
            existing_ids = {s.get("id") for s in existing if s.get("id")}
            existing_titles = {
                (s.get("title") or s.get("description") or "").strip().lower()
                for s in existing
            }
            added = 0
            for skill in body["skills"]:
                if not isinstance(skill, dict):
                    continue
                title = (
                    skill.get("title") or skill.get("description")
                    or skill.get("name") or ""
                ).strip()
                if not title:
                    continue
                sid = skill.get("id") or skill.get("name")
                if sid and sid in existing_ids:
                    continue
                nm = skill.get("name")
                if nm and nm in existing_names:
                    continue
                if title.lower() in existing_titles:
                    continue
                owner = skill.get("owner")
                if user and not owner:
                    owner = user
                # 技能以 SKILL.md 文件形式存储在磁盘上；旧的 JSON 时代的
                # skills_manager.save() 已不存在。通过 add_skill 写入每个新技能
                # （source="user" 跳过自动去重 — 这是显式的备份恢复）。
                result = skills_manager.add_skill(
                    title=title,
                    name=skill.get("name"),
                    description=skill.get("description"),
                    problem=skill.get("problem", ""),
                    solution=skill.get("solution", ""),
                    steps=skill.get("steps"),
                    tags=skill.get("tags"),
                    source="user",
                    teacher_model=skill.get("teacher_model"),
                    confidence=skill.get("confidence", 0.8),
                    owner=owner,
                    category=skill.get("category", "general"),
                    when_to_use=skill.get("when_to_use"),
                    procedure=skill.get("procedure"),
                    pitfalls=skill.get("pitfalls"),
                    verification=skill.get("verification"),
                    platforms=skill.get("platforms"),
                    requires_toolsets=skill.get("requires_toolsets"),
                    fallback_for_toolsets=skill.get("fallback_for_toolsets"),
                    status=skill.get("status", "draft"),
                    version=skill.get("version", "1.0.0"),
                )
                if result.get("_deduped"):
                    continue
                if result.get("name"):
                    existing_names.add(result["name"])
                if result.get("id"):
                    existing_ids.add(result["id"])
                existing_titles.add(title.lower())
                added += 1
            imported.append(f"{added} skills")

        # ── Presets ──
        if "presets" in body and isinstance(body["presets"], dict):
            current = preset_manager.get_all()
            for key, value in body["presets"].items():
                if isinstance(value, dict):
                    current[key] = value
                elif isinstance(value, list):
                    current[key] = value
            preset_manager.save(current)
            imported.append("presets")

        # ── Settings ──
        if "settings" in body and isinstance(body["settings"], dict):
            current = load_settings()
            current.update(body["settings"])
            save_settings(current)
            imported.append("settings")

        # ── Features ──
        if "features" in body and isinstance(body["features"], dict):
            current = load_features()
            current.update(body["features"])
            save_features(current)
            imported.append("features")

        # ── Preferences ──
        if "preferences" in body and isinstance(body["preferences"], dict):
            from routes.prefs_routes import _load_for_user, _save_for_user
            current = _load_for_user(user)
            current.update(body["preferences"])
            _save_for_user(user, current)
            imported.append("preferences")

        if not imported:
            return {"ok": False, "message": "No recognized data found in the file"}

        return {"ok": True, "imported": imported, "message": f"Imported: {', '.join(imported)}"}

    return router
