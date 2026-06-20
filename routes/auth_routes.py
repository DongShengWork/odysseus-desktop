"""认证路由 — 登录、登出、注册、状态、用户管理。"""

from fastapi import APIRouter, Request, Response, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncio
import logging
import os

import json
import re
from pathlib import Path

from core.atomic_io import atomic_write_json, atomic_write_text
from core.auth import AuthManager, SetAdminResult
from src.constants import DEEP_RESEARCH_DIR, MEMORY_FILE, SKILLS_DIR
from src.rate_limiter import RateLimiter
from src.settings_scrub import scrub_settings
from src.settings import (
    load_settings as _load_settings,
    save_settings as _save_settings,
    load_features as _load_features,
    save_features as _save_features,
    DEFAULT_SETTINGS,
)
from src.integrations import (
    load_integrations,
    add_integration,
    update_integration,
    delete_integration,
    get_integration,
    mask_integration_secret,
    execute_api_call,
    INTEGRATION_PRESETS,
    migrate_from_settings,
)

logger = logging.getLogger(__name__)


class LoginRequest(BaseModel):
    username: str
    password: str
    remember: bool = True
    totp_code: Optional[str] = None


class SetupRequest(BaseModel):
    username: str
    password: str


class SignupRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    is_admin: bool = False


class DeleteUserRequest(BaseModel):
    username: str


class RenameUserRequest(BaseModel):
    username: str


class SetAdminRequest(BaseModel):
    is_admin: bool


class SetOpenRegistrationRequest(BaseModel):
    enabled: bool

SESSION_COOKIE = "odysseus_session"


def setup_auth_routes(auth_manager: AuthManager) -> APIRouter:
    router = APIRouter(prefix="/api/auth", tags=["auth"])

    _login_limiter = RateLimiter(max_requests=15, window_seconds=60)
    _signup_limiter = RateLimiter(max_requests=3, window_seconds=300)
    _setup_limiter = RateLimiter(max_requests=3, window_seconds=300)

    def _get_current_user(request: Request) -> Optional[str]:
        token = request.cookies.get(SESSION_COOKIE)
        return auth_manager.get_username_for_token(token)

    @router.post("/setup")
    async def first_run_setup(body: SetupRequest, request: Request):
        """创建初始管理员账户。仅在没有账户时有效。"""
        if not _setup_limiter.check(request.client.host):
            raise HTTPException(429, "Too many requests — try again later")
        if auth_manager.is_configured:
            raise HTTPException(400, "Already configured")
        if len(body.password) < 8:
            raise HTTPException(400, "Password must be at least 8 characters")
        ok = await asyncio.to_thread(auth_manager.setup, body.username, body.password)
        if not ok:
            raise HTTPException(500, "Setup failed")
        return {"ok": True, "message": "Admin account created"}

    @router.post("/signup")
    async def signup(body: SignupRequest, request: Request):
        """创建新用户账户。仅在管理员开启注册时有效。"""
        if not _signup_limiter.check(request.client.host):
            raise HTTPException(429, "Too many requests — try again later")
        if not auth_manager.is_configured:
            raise HTTPException(400, "Run setup first")
        if not auth_manager.signup_enabled:
            raise HTTPException(403, "Registration is disabled. Ask an admin for an account.")
        if len(body.password) < 8:
            raise HTTPException(400, "Password must be at least 8 characters")
        if len(body.username.strip()) < 1:
            raise HTTPException(400, "Username is required")
        ok = await asyncio.to_thread(auth_manager.create_user, body.username, body.password, is_admin=False)
        if not ok:
            raise HTTPException(409, "Username already taken")
        return {"ok": True, "message": "Account created"}

    @router.post("/login")
    async def login(body: LoginRequest, request: Request, response: Response):
        if not _login_limiter.check(request.client.host):
            raise HTTPException(429, "Too many requests — try again later")
        # 先验证密码
        username = body.username.strip().lower()
        if not await asyncio.to_thread(auth_manager.verify_password, username, body.password):
            raise HTTPException(401, "Invalid credentials")
        # 如果启用了 2FA，检查
        if auth_manager.totp_enabled(username):
            if not body.totp_code:
                # 密码正确但需要 TOTP — 告知客户端显示验证码输入
                return {"ok": False, "requires_totp": True, "username": username}
            if not auth_manager.totp_verify(username, body.totp_code):
                raise HTTPException(401, "Invalid 2FA code")
        # 所有检查通过 — 创建会话（密码已在上面验证）
        token = await asyncio.to_thread(auth_manager.create_session_trusted, username)
        cookie_kwargs = dict(
            key=SESSION_COOKIE,
            value=token,
            httponly=True,
            samesite="lax",
            secure=os.getenv("SECURE_COOKIES", "false").lower() == "true",
            path="/",
        )
        if body.remember:
            cookie_kwargs["max_age"] = 60 * 60 * 24 * 7  # 7 天
        response.set_cookie(**cookie_kwargs)
        return {"ok": True, "username": username}

    @router.post("/logout")
    async def logout(request: Request, response: Response):
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            auth_manager.revoke_token(token)
        response.delete_cookie(SESSION_COOKIE, path="/")
        return {"ok": True}

    @router.get("/status")
    async def auth_status(request: Request):
        token = request.cookies.get(SESSION_COOKIE)
        result = auth_manager.status(token)
        result["signup_enabled"] = auth_manager.signup_enabled
        # 包含调用者的有效权限，以便前端可以隐藏/灰显
        # 用户不允许使用的 UI 控件。管理员获得
        # ADMIN_PRIVILEGES（全部开启），普通用户获得其存储的
        # 权限集与 DEFAULT_PRIVILEGES 合并后的结果。
        try:
            u = result.get("username")
            if u:
                result["privileges"] = auth_manager.get_privileges(u)
        except Exception:
            pass
        return result

    @router.post("/change-password")
    async def change_password(body: ChangePasswordRequest, request: Request):
        user = _get_current_user(request)
        if not user:
            raise HTTPException(401, "Not authenticated")
        if len(body.new_password) < 8:
            raise HTTPException(400, "Password must be at least 8 characters")
        current_token = request.cookies.get(SESSION_COOKIE)
        ok = await asyncio.to_thread(auth_manager.change_password, user, body.current_password, body.new_password)
        if not ok:
            raise HTTPException(400, "Current password is incorrect")
        await asyncio.to_thread(auth_manager.revoke_user_sessions, user, current_token)
        return {"ok": True}

    # ------------------------------------------------------------------
    # 双因素认证
    # ------------------------------------------------------------------

    @router.post("/2fa/setup")
    async def totp_setup(request: Request):
        """生成 TOTP 密钥并返回二维码 URI。"""
        user = _get_current_user(request)
        if not user:
            raise HTTPException(401, "Not authenticated")
        if auth_manager.totp_enabled(user):
            raise HTTPException(400, "2FA is already enabled")
        secret = auth_manager.totp_generate_secret(user)
        if not secret:
            raise HTTPException(500, "Failed to generate secret")
        uri = auth_manager.totp_get_provisioning_uri(user, secret)
        # 生成二维码为 base64 PNG
        import qrcode, io, base64
        qr = qrcode.make(uri, box_size=6, border=2)
        buf = io.BytesIO()
        qr.save(buf, format="PNG")
        qr_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return {"secret": secret, "uri": uri, "qr_code": f"data:image/png;base64,{qr_b64}"}

    class TotpVerifyRequest(BaseModel):
        code: str

    @router.post("/2fa/confirm")
    async def totp_confirm(body: TotpVerifyRequest, request: Request):
        """验证 TOTP 验证码以确认 2FA 设置。返回备用码。"""
        user = _get_current_user(request)
        if not user:
            raise HTTPException(401, "Not authenticated")
        if not auth_manager.totp_confirm_enable(user, body.code):
            raise HTTPException(400, "Invalid code — try again")
        backup = auth_manager.users.get(user, {}).get("totp_backup_codes", [])
        return {"ok": True, "backup_codes": backup}

    class TotpDisableRequest(BaseModel):
        password: str

    @router.post("/2fa/disable")
    async def totp_disable(body: TotpDisableRequest, request: Request):
        """禁用 2FA。需要密码确认。"""
        user = _get_current_user(request)
        if not user:
            raise HTTPException(401, "Not authenticated")
        if not auth_manager.totp_disable(user, body.password):
            raise HTTPException(400, "Invalid password")
        return {"ok": True}

    @router.get("/2fa/status")
    async def totp_status(request: Request):
        """检查当前用户是否启用了 2FA。"""
        user = _get_current_user(request)
        if not user:
            raise HTTPException(401, "Not authenticated")
        return {"enabled": auth_manager.totp_enabled(user)}

    # 管理员专属路由
    @router.get("/users")
    async def list_users(request: Request):
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        return {"users": auth_manager.list_users()}

    @router.post("/users")
    async def admin_create_user(body: CreateUserRequest, request: Request):
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        if len(body.password) < 8:
            raise HTTPException(400, "Password must be at least 8 characters")
        ok = auth_manager.create_user(body.username, body.password, body.is_admin)
        if not ok:
            raise HTTPException(409, "Username already taken")
        return {"ok": True}

    @router.put("/users/{username}/privileges")
    async def update_user_privileges(username: str, request: Request):
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        body = await request.json()
        ok = auth_manager.set_privileges(username, body)
        if not ok:
            raise HTTPException(404, "User not found or is admin")
        return {"ok": True, "privileges": auth_manager.get_privileges(username)}

    @router.put("/users/{username}/rename")
    async def rename_user(username: str, body: RenameUserRequest, request: Request):
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        old_username = (username or "").strip().lower()
        new_username = (body.username or "").strip().lower()
        if not new_username:
            raise HTTPException(400, "Username required")
        if old_username == new_username:
            return {"ok": True, "username": new_username, "renamed_self": old_username == user}
        if old_username not in auth_manager.users:
            raise HTTPException(404, "User not found")
        if new_username in auth_manager.users:
            raise HTTPException(409, "Username already taken")

        # Gate on auth first. Every mutation below is contingent on this
        # succeeding — doing it last meant a rejected rename (e.g. reserved
        # username) left file-backed owner fields already rewritten with no
        # way to roll them back.
        ok = auth_manager.rename_user(old_username, new_username, user)
        if not ok:
            raise HTTPException(400, "Cannot rename user")

        def _rollback_auth_rename() -> bool:
            # On self-rename the admin session has already moved to the new
            # username, so the rollback must authenticate as the new user.
            rollback_user = new_username if user == old_username else user
            try:
                return bool(auth_manager.rename_user(new_username, old_username, rollback_user))
            except Exception as rollback_err:
                logger.error(
                    "Failed to roll back auth rename %s -> %s after owner migration failure: %s",
                    new_username, old_username, rollback_err,
                )
                return False

        # 用户名是用户数据的所有权键。在更改认证数据之前，
        # owner-scoped DB rows so the account keeps access to its sessions,
        # docs, email accounts, tasks, etc.
        try:
            from sqlalchemy import func
            from core.database import Base, SessionLocal
            db = SessionLocal()
            try:
                for mapper in Base.registry.mappers:
                    model = mapper.class_
                    if not hasattr(model, "owner"):
                        continue
                    (
                        db.query(model)
                        .filter(func.lower(model.owner) == old_username)
                        .update({"owner": new_username}, synchronize_session=False)
                    )
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()
        except Exception as e:
            logger.error("Failed to rename owner references %s -> %s: %s", old_username, new_username, e)
            if not _rollback_auth_rename():
                logger.error(
                    "Auth rename %s -> %s could not be rolled back after owner migration failure",
                    old_username, new_username,
                )
            raise HTTPException(500, "Failed to rename user data")

        # 每用户偏好设置使用 JSON 存储，而非 SQL。
        try:
            from routes.prefs_routes import _load as _load_prefs, _save as _save_prefs
            prefs = _load_prefs()
            users = prefs.get("_users") if isinstance(prefs, dict) else None
            if isinstance(users, dict):
                prefs_key = next(
                    (k for k in users if str(k).strip().lower() == old_username),
                    None,
                )
                new_taken = any(str(k).strip().lower() == new_username for k in users)
                if prefs_key is not None and not new_taken:
                    users[new_username] = users.pop(prefs_key)
                    _save_prefs(prefs)
        except Exception as e:
            logger.warning("Failed to rename user prefs %s -> %s: %s", old_username, new_username, e)

        # In-flight deep-research tasks live in the process-local
        # ResearchHandler registry. They are not covered by the persisted JSON
        # migration above, but the research routes filter and cancel by this
        # owner field while the job is running. Do this before sweeping
        # completed JSON files so a job that finishes during the rename saves
        # with the new owner or is caught by the disk sweep below.
        try:
            rh = getattr(request.app.state, "research_handler", None)
            rename_owner = getattr(rh, "rename_owner", None)
            if callable(rename_owner):
                rename_owner(old_username, new_username)
        except Exception as e:
            logger.warning("Failed to rename active research tasks %s -> %s: %s", old_username, new_username, e)

        # deep_research: each completed report is a standalone JSON file with
        # an `owner` field. research_routes filters by d.get("owner") == user,
        # so a stale owner makes every report invisible to the renamed user.
        try:
            dr_dir = Path(DEEP_RESEARCH_DIR)
            if dr_dir.is_dir():
                for p in dr_dir.glob("*.json"):
                    try:
                        d = json.loads(p.read_text(encoding="utf-8"))
                        if str(d.get("owner", "")).strip().lower() == old_username:
                            d["owner"] = new_username
                            atomic_write_json(str(p), d)
                    except Exception as err:
                        logger.warning("Failed to update research owner in %s: %s", p.name, err)
        except Exception as e:
            logger.warning("Failed to rename research owner references %s -> %s: %s", old_username, new_username, e)

        # memory.json: a flat JSON array where each entry carries an `owner`
        # field. memory_manager.load(owner=user) filters on it, so stale
        # entries disappear from the memory panel.
        try:
            if os.path.isfile(MEMORY_FILE):
                with open(MEMORY_FILE, encoding="utf-8") as fh:
                    entries = json.loads(fh.read())
                if isinstance(entries, list):
                    changed = False
                    for entry in entries:
                        if isinstance(entry, dict) and str(entry.get("owner", "")).strip().lower() == old_username:
                            entry["owner"] = new_username
                            changed = True
                    if changed:
                        atomic_write_json(MEMORY_FILE, entries)
        except Exception as e:
            logger.warning("Failed to rename memory.json owner references %s -> %s: %s", old_username, new_username, e)

        # uploads.json: upload rows use owner metadata for access checks and
        # owner-prefixed index keys for dedupe. Rename both so attachments keep
        # resolving after the account username changes.
        try:
            upload_handler = getattr(request.app.state, "upload_handler", None)
            rename_owner = getattr(upload_handler, "rename_owner", None)
            if callable(rename_owner):
                rename_owner(old_username, new_username)
        except Exception as e:
            logger.warning("Failed to rename upload owner references %s -> %s: %s", old_username, new_username, e)

        # skills: SKILL.md frontmatter carries owner: <username>; the usage
        # sidecar (_usage.json) keys entries as owner::skill-name. Both must
        # be updated or the renamed user's Skills panel goes empty.
        try:
            skills_root = Path(SKILLS_DIR)
            if skills_root.is_dir():
                _owner_re = re.compile(
                    r'(?m)^(owner:\s*)' + re.escape(old_username) + r'\s*$',
                    re.IGNORECASE,
                )
                for p in skills_root.rglob("SKILL.md"):
                    try:
                        text = p.read_text(encoding="utf-8")
                        new_text = _owner_re.sub(r'\g<1>' + new_username, text)
                        if new_text != text:
                            atomic_write_text(str(p), new_text)
                    except Exception as err:
                        logger.warning("Failed to update skill owner in %s: %s", p, err)
                usage_path = skills_root / "_usage.json"
                if usage_path.is_file():
                    try:
                        usage = json.loads(usage_path.read_text(encoding="utf-8"))
                        if isinstance(usage, dict):
                            new_usage = {}
                            changed = False
                            for k, v in usage.items():
                                owner_part, sep, skill_part = k.partition("::")
                                if sep and owner_part.lower() == old_username:
                                    new_usage[new_username + "::" + skill_part] = v
                                    changed = True
                                else:
                                    new_usage[k] = v
                            if changed:
                                atomic_write_json(str(usage_path), new_usage)
                    except Exception as err:
                        logger.warning("Failed to update skills usage keys %s -> %s: %s", old_username, new_username, err)
        except Exception as e:
            logger.warning("Failed to rename skills owner references %s -> %s: %s", old_username, new_username, e)

        # The in-memory session cache (session_manager.sessions) stores each
        # session's owner at load time. Without this patch the renamed user's
        # sessions are invisible on the next /api/sessions call because
        # get_sessions_for_user does an exact `s.owner == username` comparison
        # against stale in-memory values.
        sm = getattr(request.app.state, "session_manager", None)
        if sm is not None:
            for sess in list(getattr(sm, "sessions", {}).values()):
                if str(getattr(sess, "owner", None) or "").strip().lower() == old_username:
                    sess.owner = new_username

        # 上面的 owner 重命名循环已更新了数据库中的 ApiToken.owner，
        # 但 bearer-token 缓存仍然将每个令牌映射到旧的 owner。如果不
        # 刷新它，重命名用户的 API 令牌会解析到旧的（现已不存在的）
        # owner，并停止访问其数据，直到缓存下次标记为脏。现在就使其
        # 失效，与令牌 CRUD 路由的做法相同。
        invalidator = getattr(request.app.state, "invalidate_token_cache", None)
        if callable(invalidator):
            invalidator()
        return {"ok": True, "username": new_username, "renamed_self": old_username == user}

    @router.put("/users/{username}/admin")
    async def set_user_admin(username: str, body: SetAdminRequest, request: Request):
        """Promote/demote a user to/from admin. Admin only.

        The last remaining admin can't be demoted (no lockout). Self-demotion
        is allowed while another admin exists; the `self` flag tells the UI to
        reload the acting user into the normal-user view.
        """
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        result = auth_manager.set_admin(username, body.is_admin, user)
        if result is SetAdminResult.USER_NOT_FOUND:
            raise HTTPException(404, "User not found")
        if result is SetAdminResult.NOT_AUTHORIZED:
            raise HTTPException(403, "Admin only")
        if result is SetAdminResult.LAST_ADMIN:
            raise HTTPException(400, "Cannot demote the last admin")
        target = (username or "").strip().lower()
        return {
            "ok": True,
            "is_admin": body.is_admin,
            "self": target == (user or "").strip().lower(),
        }

    @router.post("/signup-toggle", deprecated=True)
    async def toggle_signup(request: Request):
        """
        切换开放注册开/关。仅限管理员。

        已弃用：此端点使用切换语义，可能导致不安全的
        状态变更。请改用 PUT /open-signup。

        保留此端点用于向后兼容，可能在未来版本中移除。
        """
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        auth_manager.signup_enabled = not auth_manager.signup_enabled
        return {"ok": True, "signup_enabled": auth_manager.signup_enabled}

    @router.put("/open-signup")
    async def set_signup_enabled(body: SetOpenRegistrationRequest, request: Request):
        """设置开放注册启用状态。仅限管理员。"""
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        auth_manager.signup_enabled = body.enabled
        return {"ok": True,"signup_enabled": auth_manager.signup_enabled}

    @router.delete("/users")
    async def admin_delete_user(body: DeleteUserRequest, request: Request):
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")

        def _invalidate_api_token_cache():
            try:
                invalidator = getattr(request.app.state, "invalidate_token_cache", None)
                if invalidator:
                    invalidator()
            except Exception:
                pass

        try:
            ok = auth_manager.delete_user(body.username, user)
        except Exception:
            # delete_user can touch ApiToken rows before a later auth-store write
            # fails. Dirty the bearer cache anyway so a partial token purge does
            # not leave already-cached tokens authenticating until restart.
            _invalidate_api_token_cache()
            raise
        if not ok:
            raise HTTPException(400, "Cannot delete user")
        # delete_user 会删除用户的 ApiToken 行，但 bearer-auth
        # 中间件从一个内存中的 prefix->token 缓存中提供服务，
        # 该缓存仅在标记为脏时才重建。没有这个，已删除用户的已缓存
        # 令牌会继续认证，直到其他令牌操作或重启清除缓存。
        # 与令牌路由的做法相同。
        _invalidate_api_token_cache()
        return {"ok": True}

    # ---- 功能可见性（管理员管理） ----

    @router.get("/features")
    async def get_features():
        """公开：返回启用了哪些 UI 功能。"""
        return _load_features()

    @router.post("/features")
    async def set_features(request: Request):
        """仅限管理员：更新功能开关。"""
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        body = await request.json()
        current = _load_features()
        for key in current:
            if key in body and isinstance(body[key], bool):
                current[key] = body[key]
        _save_features(current)
        return current

    # ---- 应用设置（管理员管理） ----

    @router.get("/settings")
    async def get_settings(request: Request):
        """返回应用设置。管理员获得完整集合；非管理员获得
        已屏蔽密钥的脱敏副本。前端将其用于键位绑定 +
        TTS 偏好设置，因此无需管理员即可调用。"""
        user = _get_current_user(request)
        settings = _load_settings()
        if user and auth_manager.is_admin(user):
            return settings
        return scrub_settings(settings)

    @router.post("/settings")
    async def set_settings(request: Request):
        """仅限管理员：更新应用设置。"""
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        body = await request.json()
        current = _load_settings()
        # 对数值设置逐键校验：将其强制转为整数并限制在合理范围内，
        # 以避免错误的值禁用 agent 或使其失控。
        _INT_RANGES = {
            "agent_max_rounds": (1, 200),
            "agent_max_tool_calls": (0, 1000),  # 0 = 无限制
        }
        for key in DEFAULT_SETTINGS:
            if key not in body:
                continue
            val = body[key]
            if key in _INT_RANGES:
                lo, hi = _INT_RANGES[key]
                try:
                    val = int(val)
                except (TypeError, ValueError):
                    raise HTTPException(400, f"{key} must be an integer")
                val = max(lo, min(val, hi))
            current[key] = val
        _save_settings(current)
        return current

    # ---- 集成 CRUD ----

    # 在启动时运行迁移
    migrate_from_settings()

    @router.get("/integrations")
    async def list_integrations_route(request: Request):
        """列出所有集成（仅限管理员，密钥已遮蔽）。"""
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        items = load_integrations()
        # 遮蔽 API 密钥以供前端显示
        safe = [mask_integration_secret(item) for item in items]
        return {"integrations": safe}

    @router.get("/integrations/presets")
    async def list_presets():
        """列出可用的集成预设。"""
        return {"presets": {k: {kk: vv for kk, vv in v.items() if kk != "api_key"} for k, v in INTEGRATION_PRESETS.items()}}

    @router.post("/integrations")
    async def create_integration(request: Request):
        """创建新的集成（仅限管理员）。"""
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        body = await request.json()
        item = add_integration(body)
        return {"ok": True, "integration": mask_integration_secret(item)}

    @router.put("/integrations/{integration_id}")
    async def update_integration_route(integration_id: str, request: Request):
        """更新现有集成（仅限管理员）。"""
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        body = await request.json()
        item = update_integration(integration_id, body)
        if not item:
            raise HTTPException(404, "Integration not found")
        return {"ok": True, "integration": mask_integration_secret(item)}

    @router.delete("/integrations/{integration_id}")
    async def delete_integration_route(integration_id: str, request: Request):
        """删除集成（仅限管理员）。"""
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        ok = delete_integration(integration_id)
        if not ok:
            raise HTTPException(404, "Integration not found")
        return {"ok": True}

    @router.post("/integrations/{integration_id}/test")
    async def test_integration_route(integration_id: str, request: Request):
        """测试与集成的连接（仅限管理员）。"""
        user = _get_current_user(request)
        if not user or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        integ = get_integration(integration_id)
        if not integ:
            raise HTTPException(404, "Integration not found")
        preset = (integ.get("preset") or integ.get("name", "")).lower()

        # ntfy is special: a GET / proves the server is reachable but
        # publishes nothing, so the user has no way to know whether
        # subscribers will actually receive notifications. Instead, do
        # the real thing — POST a one-line "connectivity test" message
        # to the topic the Reminders panel is configured to use. If the
        # subscriber app is wired up correctly, this is what the green
        # checkmark + a phone ping confirms together.
        if preset == "ntfy":
            import httpx
            from urllib.parse import urlparse
            # Strip any path/query the user accidentally pasted in the
            # （例如 `http://host:8091/odysseus`）— 否则主题会
            # the topic gets appended after the path and we publish to
            # 被附加在路径后面，我们会发布到 `/odysseus/odysseus`
            # only ever serves from the root.
            raw_base = (integ.get("base_url") or "").strip()
            parsed = urlparse(raw_base)
            base = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else raw_base.rstrip("/")
            settings = _load_settings()
            topic = (settings.get("reminder_ntfy_topic") or "reminders").strip() or "reminders"
            full_url = f"{base}/{topic}"
            api_key = integ.get("api_key", "")
            auth_type = (integ.get("auth_type") or "none").lower()
            headers = {
                "Title": "Odysseus connectivity test",
                "Tags": "white_check_mark",
                "Priority": "default",
            }
            if api_key:
                if auth_type == "bearer":
                    headers["Authorization"] = f"Bearer {api_key}"
                elif auth_type == "header":
                    headers[integ.get("auth_header") or "Authorization"] = api_key
            try:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    r = await client.post(
                        full_url,
                        content="Connectivity test from Odysseus. If you see this on your phone, ntfy is wired up correctly.",
                        headers=headers,
                    )
                if r.is_success:
                    # Tell the user EXACTLY where it went and what to
                    # subscribe to on their phone, so they can match
                    # without guesswork. The doubled-topic / wrong-host
                    # mistakes are easier to spot when the actual URL
                    # is right there in the success line.
                    return {
                        "ok": True,
                        "message": (
                            f"Sent to {full_url} — on your ntfy app, "
                            f"subscribe to topic \"{topic}\" with server "
                            f"\"{base}\" (or paste the full URL: {full_url})."
                        ),
                    }
                return {"ok": False, "message": f"ntfy returned HTTP {r.status_code} from {full_url}: {r.text[:200]}"}
            except Exception as e:
                hint = ""
                if parsed.hostname not in ("127.0.0.1", "localhost"):
                    hint = " 如果使用 Docker Compose ntfy，请在 .env 中将 NTFY_BIND 设置为该主机/Tailscale IP，NTFY_BASE_URL 设置为相同的服务器 URL，然后重建 ntfy。"
                return {"ok": False, "message": f"ntfy publish to {full_url} failed: {e}.{hint}"[:500]}

        if preset == "discord_webhook":
            import httpx
            webhook_url = (integ.get("base_url") or "").strip()
            if not webhook_url:
                return {"ok": False, "message": "No webhook URL set — paste the full Discord webhook URL into the Base URL field."}
            payload = {
                "embeds": [{
                    "title": "Odysseus connectivity test",
                    "description": "If you see this, your Discord Webhook integration is wired up correctly.",
                    "color": 5793266,
                }]
            }
            try:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    r = await client.post(webhook_url, json=payload)
                if r.is_success:
                    return {"ok": True, "message": "Test embed sent — check your Discord channel to confirm it arrived."}
                return {"ok": False, "message": f"Discord returned HTTP {r.status_code}: {r.text[:200]}"}
            except Exception as e:
                return {"ok": False, "message": f"Request failed: {e}"[:400]}

        # 所有其他预设：对已知的健康检查端点执行 GET。
        # 如果预设缺失，回退到从名称检测。
        health_paths = {
            "miniflux": "/v1/me",
            "gitea": "/api/v1/version",
            "linkding": "/api/tags/",
            "homeassistant": "/api/",
            "home assistant": "/api/",
        }
        path = health_paths.get(preset, "/")
        result = await execute_api_call(integration_id, "GET", path)
        if result.get("exit_code", 1) == 0:
            return {"ok": True, "message": "Connection successful"}
        return {"ok": False, "message": (result.get("error") or "Connection failed")[:300]}

    return router
