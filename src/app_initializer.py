# src/app_initializer.py
"""初始化所有应用程序组件和依赖。"""
import os
import logging
from typing import Dict, Any

from src.constants import (
    DATA_DIR, PERSONAL_DIR, RUNBOOK_DIR, UPLOAD_DIR,
    SESSIONS_FILE, DEFAULT_HOST, OPENAI_API_KEY
)
from src.memory import MemoryManager
from src.memory_provider import MemoryProviderRegistry, NativeMemoryProvider
from services.memory.skills import SkillsManager
from core.session_manager import SessionManager
from core.models import set_session_manager
from src.personal_docs import PersonalDocsManager
from src.api_key_manager import APIKeyManager
from src.preset_manager import PresetManager
from src.chat_processor import ChatProcessor
from src.model_discovery import ModelDiscovery
from src.chat_handler import ChatHandler
from src.research_handler import ResearchHandler
from src.upload_handler import UploadHandler
from src.search import update_search_config

logger = logging.getLogger(__name__)

def create_directories():
    """创建必要的目录（如果不存在）。"""
    for directory in (DATA_DIR, PERSONAL_DIR, RUNBOOK_DIR, UPLOAD_DIR):
        os.makedirs(directory, exist_ok=True)
        
def initialize_managers(base_dir: str, rag_manager=None) -> Dict[str, Any]:
    """
    Initialize all manager and handler instances.

    Args:
        base_dir: 基础目录路径
        rag_manager: RAG 管理器实例（可选）
    Returns:
        包含所有已初始化组件的字典
    """
    # 首先创建目录
    create_directories()

    # 初始化核心管理器
    memory_manager = MemoryManager(DATA_DIR)
    skills_manager = SkillsManager(DATA_DIR)
    session_manager = SessionManager(SESSIONS_FILE)
    set_session_manager(session_manager)  # 启用 Session.add_message() 持久化
    upload_handler = UploadHandler(base_dir, UPLOAD_DIR)
    personal_docs_manager = PersonalDocsManager(PERSONAL_DIR, rag_manager)
    api_key_manager = APIKeyManager(DATA_DIR)
    preset_manager = PresetManager(DATA_DIR)

    # 初始化 Memory Vector Store（如果 RAG 可用则共享嵌入模型）
    memory_vector = None
    try:
        from src.memory_vector import MemoryVectorStore
        embedding_model = getattr(rag_manager, '_model', None) if rag_manager else None
        memory_vector = MemoryVectorStore(DATA_DIR, embedding_model=embedding_model)
        if memory_vector.healthy:
            # 如果为空，从现有 memories 重建索引
            if memory_vector.count() == 0:
                existing = memory_manager.load()
                if existing:
                    memory_vector.rebuild(existing)
                    logger.info(f"Rebuilt memory vector index from {len(existing)} existing entries")
            logger.info("MemoryVectorStore initialized")
        else:
            logger.warning("MemoryVectorStore DEGRADED: ChromaDB vector memory unavailable")
            memory_vector = None
    except Exception as e:
        logger.warning(f"MemoryVectorStore DEGRADED: {e}")
        memory_vector = None

    memory_provider_registry = MemoryProviderRegistry([
        NativeMemoryProvider(memory_manager, memory_vector),
    ])

    # 初始化处理器
    chat_processor = ChatProcessor(memory_manager, personal_docs_manager, memory_vector=memory_vector, skills_manager=skills_manager)
    research_handler = ResearchHandler()
    
    # 使用所有依赖初始化聊天处理器
    chat_handler = ChatHandler(
        session_manager=session_manager,
        memory_manager=memory_manager,
        chat_processor=chat_processor,
        research_handler=research_handler,
        preset_manager=preset_manager,
        upload_handler=upload_handler,
    )
    
    # 初始化模型发现
    model_discovery = ModelDiscovery(DEFAULT_HOST, OPENAI_API_KEY)
    
    # 加载并应用已保存的 API 密钥
    saved_keys = api_key_manager.load()
    if "brave" in saved_keys:
        update_search_config(api_key=saved_keys["brave"])
        logger.info("Loaded Brave API key from saved configuration")
    
    return {
        "memory_manager": memory_manager,
        "memory_vector": memory_vector,
        "memory_provider_registry": memory_provider_registry,
        "skills_manager": skills_manager,
        "session_manager": session_manager,
        "upload_handler": upload_handler,
        "personal_docs_manager": personal_docs_manager,
        "api_key_manager": api_key_manager,
        "preset_manager": preset_manager,
        "chat_processor": chat_processor,
        "research_handler": research_handler,
        "chat_handler": chat_handler,
        "model_discovery": model_discovery,
        "current_presets": preset_manager.presets,
        "PERSONAL_INDEX": personal_docs_manager.index
    }
