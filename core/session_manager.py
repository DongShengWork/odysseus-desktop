# core/session_manager.py
"""
会话管理 — 所有会话业务逻辑和数据库操作。

这是处理以下事项的唯一位置：
- 加载/保存会话到数据库
- 向会话添加消息
- 会话生命周期（创建、归档、删除）
"""

import json
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import Dict, Optional

from .database import Session as DbSession, ChatMessage as DbChatMessage, Document as DbDocument, SessionLocal, utcnow_naive
from .models import Session, ChatMessage

# Re-export singleton accessors from models for convenience
from .models import set_session_manager_instance, get_session_manager_instance

logger = logging.getLogger(__name__)


def _message_timestamp_iso(value: Optional[datetime]) -> Optional[str]:
    """返回用于聊天消息元数据的稳定 ISO 时间戳。"""
    if not value:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def _parse_msg_content(raw):
    """从数据库解析消息内容 — 将 JSON 数组反序列化为列表
    （包含图片/音频附件的多模态内容）。"""
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str) and raw.startswith('[{') and '"type"' in raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list) and all(isinstance(p, dict) for p in parsed):
                return parsed
        except (json.JSONDecodeError, ValueError):
            pass
    return raw


class SessionManager:
    """
    管理带有数据库持久化的聊天会话。

    用法：
        manager = SessionManager()
        session = manager.create_session(id, name, url, model)
        manager.add_message(session.id, ChatMessage("user", "hello"))
        session = manager.get_session(session_id)
    """

    def __init__(self, sessions_file: str = None):
        # sessions_file 保留用于向后兼容，未使用
        self.sessions: Dict[str, Session] = {}
        self.load_sessions()

    # ------------------------------------------------------------------
    # 加载
    # ------------------------------------------------------------------

    def load_sessions(self):
        """Load recent session METADATA from the database — messages are
        hydrated on demand by `get_session`. Previously this walked every
        message of every session into RAM at boot, which on a long-running
        personal-server box could be tens of thousands of rows held forever
        在长期运行的个人服务器上，可能意味着数万行数据永远保留在 `self.sessions` 中。
        """
        db = SessionLocal()
        try:
            db_sessions = db.query(DbSession).filter(
                DbSession.archived == False,
                DbSession.message_count > 0,
            ).order_by(DbSession.last_accessed.desc()).limit(100).all()

            loaded_count = 0
            for db_session in db_sessions:
                try:
                    session = self._db_to_session_meta(db_session)
                    if session is not None:
                        self.sessions[db_session.id] = session
                        loaded_count += 1
                except Exception as e:
                    logger.error(f"Error loading session {db_session.id}: {e}")
                    continue

            logger.info(f"Loaded {loaded_count} session(s) (metadata only)")

        except Exception as e:
            logger.error(f"Error loading sessions: {e}")
            self.sessions = {}
        finally:
            db.close()

    def _db_to_session_meta(self, db_session: DbSession) -> Optional[Session]:
        """构建一个带有空历史记录的 Session。`get_session` 将在首次读取时
        从数据库填充消息。"""
        headers = db_session.headers
        if isinstance(headers, str):
            try:
                headers = json.loads(headers)
            except json.JSONDecodeError:
                headers = {}
        session = Session(
            id=db_session.id,
            name=db_session.name,
            endpoint_url=db_session.endpoint_url,
            model=db_session.model,
            rag=db_session.rag,
            archived=db_session.archived,
            headers=headers,
            history=[],
            owner=getattr(db_session, "owner", None),
            is_important=getattr(db_session, "is_important", False) or False,
        )
        session.message_count = getattr(db_session, "message_count", 0) or 0
        return session

    def _db_to_session(self, db_session: DbSession, db) -> Optional[Session]:
        """将数据库会话转换为 Session 对象。"""
        history = []

        # 先尝试关系查询，再尝试直接查询
        if db_session.messages:
            for db_msg in db_session.messages:
                meta = json.loads(db_msg.meta_data) if db_msg.meta_data else {}
                if meta is None: meta = {}
                meta['_db_id'] = db_msg.id
                meta.setdefault('timestamp', _message_timestamp_iso(db_msg.timestamp))
                history.append(ChatMessage(
                    role=db_msg.role,
                    content=_parse_msg_content(db_msg.content),
                    metadata=meta,
                ))
        else:
            db_messages = db.query(DbChatMessage).filter(
                DbChatMessage.session_id == db_session.id
            ).order_by(DbChatMessage.timestamp).all()

            for db_msg in db_messages:
                meta = json.loads(db_msg.meta_data) if db_msg.meta_data else {}
                if meta is None: meta = {}
                meta['_db_id'] = db_msg.id
                meta.setdefault('timestamp', _message_timestamp_iso(db_msg.timestamp))
                history.append(ChatMessage(
                    role=db_msg.role,
                    content=_parse_msg_content(db_msg.content),
                    metadata=meta,
                ))

        if not history:
            return None

        # 解析请求头
        headers = db_session.headers
        if isinstance(headers, str):
            try:
                headers = json.loads(headers)
            except json.JSONDecodeError:
                headers = {}

        session = Session(
            id=db_session.id,
            name=db_session.name,
            endpoint_url=db_session.endpoint_url,
            model=db_session.model,
            rag=db_session.rag,
            archived=db_session.archived,
            headers=headers,
            history=history,
            owner=getattr(db_session, 'owner', None),
            is_important=getattr(db_session, 'is_important', False) or False,
        )

        session.message_count = getattr(db_session, 'message_count', len(history))
        return session

    # ------------------------------------------------------------------
    # 消息操作
    # ------------------------------------------------------------------

    def add_message(self, session_id: str, message: ChatMessage):
        """
        向会话添加一条消息并将其持久化到数据库。

        Updates the authoritative history list and persists through this
        manager directly so tests and temporary managers do not depend on the
        process-wide session-manager singleton.

        Args:
            session_id: 会话 ID
            message: 要添加的 ChatMessage
        """
        session = self.get_session(session_id)
        session.history.append(message)
        session._history = session.history
        session.message_count = len(session.history)

        self._persist_message(session_id, message)

    def _persist_message(self, session_id: str, message: ChatMessage):
        """将单条消息持久化到数据库。"""
        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session is None:
                # 流/工具回调可能在会话删除之后仍然存在。不要创建
                # 没有父会话的 chat_messages 行；同时删除任何过期的
                # 缓存会话，以便后续写入也能安全关闭。
                self.sessions.pop(session_id, None)
                logger.warning("Dropping message for deleted session %s", session_id)
                return

            msg_id = str(uuid.uuid4())
            msg_time = datetime.utcnow()
            if message.metadata is None:
                message.metadata = {}
            message.metadata.setdefault('timestamp', _message_timestamp_iso(msg_time))
            # 多模态内容（图片/音频附件）是一个列表——序列化为 JSON
            # 以便 Text 列可以存储它。重新加载时，_db_to_session
            # 检测到 JSON 数组前缀并解析回来。
            _content = message.content
            if isinstance(_content, list):
                _content = json.dumps(_content)
            db_message = DbChatMessage(
                id=msg_id,
                session_id=session_id,
                role=message.role,
                content=_content,
                meta_data=json.dumps(message.metadata) if message.metadata else None,
                timestamp=msg_time,
            )
            db.add(db_message)

            if session_id in self.sessions:
                db_session.message_count = len(self.sessions[session_id].history)
            else:
                db_session.message_count = 0
            _now = datetime.now(timezone.utc)
            db_session.last_accessed = _now
            # 清理"最后一次对话"时间戳——仅在实际消息持久化时更新，
            # 以便为准确的"最后活跃"排序提供依据，
            # 该排序忽略重命名/模型切换/仅打开操作。
            db_session.last_message_at = _now

            db.commit()

            # 将数据库 ID 存储在内存消息中，以便按 ID 编辑/删除
            message.metadata['_db_id'] = msg_id

            logger.debug(f"Persisted message to session {session_id}")

        except Exception as e:
            logger.error(f"Error persisting message: {e}")
            db.rollback()
        finally:
            db.close()

    def truncate_messages(self, session_id: str, keep_count: int) -> bool:
        """截断会话历史记录，仅保留前 `keep_count` 条消息。"""
        session = self.get_session(session_id)

        if keep_count < 0:
            return False

        db = SessionLocal()
        try:
            db_messages = db.query(DbChatMessage).filter(
                DbChatMessage.session_id == session_id
            ).order_by(DbChatMessage.timestamp).all()

            deleted = 0
            for msg in db_messages[keep_count:]:
                db.delete(msg)
                deleted += 1

            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                # keep_count 可能超过实际消息总数（例如 AI 工具在短会话上
                # 默认 keep_count=10）；message_count 必须跟踪实际保留的行数，
                # 而不是请求的上限。
                db_session.message_count = min(keep_count, len(db_messages))
                db_session.updated_at = datetime.now(timezone.utc)

            db.commit()

            # 更新内存中的数据
            session.history = session.history[:keep_count]
            session._history = session.history

            logger.info(f"Truncated session {session_id} to {keep_count} messages")
            return True

        except Exception as e:
            logger.error(f"Error truncating session: {e}")
            db.rollback()
            return False
        finally:
            db.close()

    def replace_messages(self, session_id: str, messages: list) -> bool:
        """原子地替换会话在数据库和内存中的历史记录。"""
        session = self.get_session(session_id)
        db = SessionLocal()
        try:
            db.query(DbChatMessage).filter(DbChatMessage.session_id == session_id).delete()
            now = datetime.now(timezone.utc)
            for i, message in enumerate(messages):
                msg_id = str(uuid.uuid4())
                db_message = DbChatMessage(
                    id=msg_id,
                    session_id=session_id,
                    role=message.role,
                    # Multimodal content (image/audio attachments) is a list;
                    # 序列化为 JSON 以便 Text 列通过 _parse_msg_content 往返。
                    # 而 _parse_msg_content 无法解析（它查找双引号的 "type"），
                    # 序列化为 JSON 以便 Text 列通过 _parse_msg_content 往返。
                    # 而 _parse_msg_content 无法解析（它查找双引号的 "type"），
                    # 因此附件在重新加载时被销毁。与 _persist_message 保持一致。
                    content=(json.dumps(message.content)
                             if isinstance(message.content, list)
                             else message.content),
                    meta_data=json.dumps(message.metadata) if message.metadata else None,
                    timestamp=now + timedelta(microseconds=i),
                )
                db.add(db_message)
                if message.metadata is None:
                    message.metadata = {}
                message.metadata["_db_id"] = msg_id

            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db_session.message_count = len(messages)
                db_session.updated_at = now
                db_session.last_accessed = now
                db_session.last_message_at = now

            db.commit()
            session.history = list(messages)
            session._history = session.history
            session.message_count = len(messages)
            logger.info("Replaced session %s history with %d messages", session_id, len(messages))
            return True
        except Exception as e:
            logger.error("Error replacing session history: %s", e)
            db.rollback()
            return False
        finally:
            db.close()

    # ------------------------------------------------------------------
    # 会话增删改查
    # ------------------------------------------------------------------

    def get_session(self, session_id: str) -> Session:
        """通过 ID 获取会话，按需从数据库加载。

        由 `load_sessions` 初始加载的会话以空历史记录开始。
        首次在此读取时，从消息行填充它们。
        """
        if session_id not in self.sessions:
            self._load_session_from_db(session_id)
        else:
            cached = self.sessions[session_id]
            # 懒加载填充：仅有元数据的条目在首次读取时获取完整消息。
            if not cached.history and getattr(cached, "message_count", 0) > 0:
                self._load_session_from_db(session_id)

        # 保持模型/端点元数据是最新的。端点删除可能清除数据库行，
        # 而会话对象仍缓存在 RAM 中。
        self.sync_session_metadata(session_id)

        # 更新最后访问时间
        self._touch_session(session_id)

        return self.sessions[session_id]

    def sync_session_metadata(self, session_id: str) -> bool:
        """从数据库刷新缓存的会话对象中非消息类的字段。"""
        session = self.sessions.get(session_id)
        if session is None:
            return False
        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session is None:
                return False
            headers = db_session.headers
            if isinstance(headers, str):
                try:
                    headers = json.loads(headers)
                except json.JSONDecodeError:
                    headers = {}
            session.name = db_session.name
            session.endpoint_url = db_session.endpoint_url or ""
            session.model = db_session.model or ""
            session.headers = headers or {}
            session.rag = db_session.rag
            session.archived = db_session.archived
            session.owner = getattr(db_session, "owner", None)
            session.is_important = getattr(db_session, "is_important", False) or False
            session.message_count = getattr(db_session, "message_count", session.message_count) or 0
            return True
        except Exception as e:
            logger.error(f"Error syncing session metadata {session_id}: {e}")
            return False
        finally:
            db.close()

    def _load_session_from_db(self, session_id: str):
        """从数据库加载单个会话（包含消息）到内存中。"""
        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session is None:
                raise KeyError(f"Session {session_id} not found")

            session = self._db_to_session(db_session, db)
            if session:
                self.sessions[session_id] = session
            else:
                # 没有消息——回退到仅有元数据的条目，以便调用者
                # 在空会话上不会因 KeyError 崩溃。
                meta = self._db_to_session_meta(db_session)
                if meta is None:
                    raise KeyError(f"Session {session_id} could not be loaded")
                self.sessions[session_id] = meta

        except KeyError:
            raise
        except Exception as e:
            logger.error(f"Error loading session {session_id}: {e}")
            raise
        finally:
            db.close()

    def _touch_session(self, session_id: str):
        """更新 last_accessed 时间戳。"""
        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db_session.last_accessed = datetime.now(timezone.utc)
                db.commit()
        except Exception as e:
            logger.error(f"Error updating last_accessed: {e}")
            db.rollback()
        finally:
            db.close()

    def create_session(
        self,
        session_id: str,
        name: str,
        endpoint_url: str,
        model: str,
        rag: bool = False,
        owner: str = None
    ) -> Session:
        """创建新会话并保存到数据库。"""
        db = SessionLocal()
        try:
            db_session = DbSession(
                id=session_id,
                name=name,
                endpoint_url=endpoint_url,
                model=model,
                rag=rag,
                headers={},
                owner=owner,
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc)
            )
            db.add(db_session)
            db.commit()

            session = Session(
                id=session_id,
                name=name,
                endpoint_url=endpoint_url,
                model=model,
                rag=rag,
                headers={},
                owner=owner,
            )

            self.sessions[session_id] = session
            return session

        except Exception as e:
            db.rollback()
            logger.error(f"Error creating session: {e}")
            raise
        finally:
            db.close()

    def delete_session(self, session_id: str) -> bool:
        """永久删除会话及其所有消息。"""
        db = SessionLocal()
        try:
            # 分离文档，使其作为孤立项保留在文档库中
            db.query(DbDocument).filter(DbDocument.session_id == session_id).update(
                {DbDocument.session_id: None}, synchronize_session=False
            )

            # 删除消息
            db.query(DbChatMessage).filter(DbChatMessage.session_id == session_id).delete()

            # 删除会话
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db.delete(db_session)

            # 即使没有数据库行，也删除内存中的副本。"幽灵"会话
            # 只存在于这里（从未持久化，或其行被外部移除）；
            # 如果不这样做，它永远无法被清除，并在每次操作时
            # 持续返回 404（issue #1044）。
            removed_in_memory = self.sessions.pop(session_id, None) is not None

            if db_session or removed_in_memory:
                # 将上面的文档分离/消息删除操作与会话删除一起提交
                # （当幽灵会话没有行时，此操作为空操作）。
                db.commit()
                logger.info(f"Deleted session {session_id}")
                return True
            return False

        except Exception as e:
            logger.error(f"Error deleting session: {e}")
            db.rollback()
            return False
        finally:
            db.close()

    # ------------------------------------------------------------------
    # 会话更新
    # ------------------------------------------------------------------

    def update_session_name(self, session_id: str, name: str):
        """更新会话名称。"""
        if session_id not in self.sessions:
            return

        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db_session.name = name
                db_session.updated_at = datetime.now(timezone.utc)
                db.commit()
                self.sessions[session_id].name = name
        except Exception as e:
            db.rollback()
            logger.error(f"Error updating session name: {e}")
            raise
        finally:
            db.close()

    def archive_session(self, session_id: str):
        """归档一个会话。"""
        if session_id not in self.sessions:
            return

        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db_session.archived = True
                db_session.updated_at = datetime.now(timezone.utc)
                db.commit()
                self.sessions[session_id].archived = True
        except Exception as e:
            db.rollback()
            logger.error(f"Error archiving session: {e}")
            raise
        finally:
            db.close()

    def mark_important(self, session_id: str, important: bool = True):
        """将会话标记为重要。"""
        db = SessionLocal()
        try:
            db_session = db.query(DbSession).filter(DbSession.id == session_id).first()
            if db_session:
                db_session.is_important = important
                db_session.updated_at = datetime.now(timezone.utc)
                db.commit()

                if session_id in self.sessions:
                    self.sessions[session_id].is_important = important
            else:
                raise KeyError(f"Session {session_id} not found")
        except Exception as e:
            db.rollback()
            logger.error(f"Error marking session important: {e}")
            raise
        finally:
            db.close()

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    def get_sessions_for_user(self, username: Optional[str] = None) -> Dict[str, Session]:
        """返回特定用户的会话（如果 username 为 None，则返回所有）。"""
        if username is None:
            return self.sessions
        return {
            sid: s for sid, s in self.sessions.items()
            if s.owner == username
        }

    def save_sessions(self):
        """数据库兼容性的空操作。"""

    def ensure_task_session(self, session_id: str, name: str, endpoint_url: str, model: str, owner: str = None, task: object = None) -> Session:
        """Create a task session if it doesn't exist, or return the existing one.

        Unlike create_session, this checks the cache first and does NOT
        overwrite an existing in-memory session. The task scheduler must
        use this instead of direct dict assignment.
        """
        if session_id in self.sessions:
            return self.sessions[session_id]

        session = self.create_session(session_id, name, endpoint_url, model, owner=owner)
        if task is not None:
            task.session_id = session_id
        return session

    # ------------------------------------------------------------------
    # 清理
    # ------------------------------------------------------------------

    def cleanup_empty_sessions(self, auto_archive_days: int = 30, min_age_hours: int = 1) -> dict:
        """Clean up empty and old sessions.

        Args:
            auto_archive_days: Age in days before non-important sessions are archived.
            min_age_hours: Minimum age in hours before an empty session can be deleted.
                          Prevents deleting sessions that were just created.
        """
        db = SessionLocal()
        stats = {'deleted_empty': 0, 'archived_old': 0, 'total_checked': 0}

        try:
            all_sessions = db.query(DbSession).all()
            cutoff_date = utcnow_naive() - timedelta(days=auto_archive_days)
            min_age = utcnow_naive() - timedelta(hours=min_age_hours)

            for db_session in all_sessions:
                stats['total_checked'] += 1

                # Delete empty sessions only if older than min_age_hours
                if db_session.message_count == 0:
                    if db_session.created_at is not None:
                        created = db_session.created_at
                        if created.tzinfo is None:
                            created = created.replace(tzinfo=timezone.utc)
                        if created > min_age:
                            continue  # Too young to delete
                    if db_session.id in self.sessions:
                        del self.sessions[db_session.id]
                    db.delete(db_session)
                    stats['deleted_empty'] += 1

                # 归档旧会话
                elif (not db_session.archived and
                      db_session.last_accessed and
                      db_session.last_accessed < cutoff_date and
                      db_session.message_count > 0 and
                      not getattr(db_session, 'is_important', False)):
                    db_session.archived = True
                    stats['archived_old'] += 1

            db.commit()
            logger.info(f"Cleanup: {stats['deleted_empty']} deleted, {stats['archived_old']} archived")

        except Exception as e:
            logger.error(f"Cleanup error: {e}")
            db.rollback()
            raise
        finally:
            db.close()

        return stats
