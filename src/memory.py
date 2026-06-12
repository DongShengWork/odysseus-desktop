
import json
import logging
import os
import time
import uuid
import re
from typing import List, Dict, Tuple
from datetime import datetime

logger = logging.getLogger(__name__)

def tokenize(text: str) -> List[str]:
    """简单分词器，按空格分割并移除标点符号。"""
    return [word.strip('.,!?";') for word in text.split()]

def get_text_similarity(text1: str, text2: str) -> float:
    """计算两个文本之间的 Jaccard 相似度。"""
    if not text1 or not text2:
        return 0.0
    
    tokens1 = set(tokenize(text1.lower()))
    tokens2 = set(tokenize(text2.lower()))
    
    if not tokens1 and not tokens2:
        return 1.0
    if not tokens1 or not tokens2:
        return 0.0
        
    intersection = tokens1.intersection(tokens2)
    union = tokens1.union(tokens2)
    
    return len(intersection) / len(union)

class MemoryManager:
    def __init__(self, data_dir: str):
        self.memory_file = os.path.join(data_dir, "memory.json")
        self.ensure_file_exists()
        
    def extract_memory_from_chat(self, chat_history: List[Dict], session_id: str = None) -> List[Dict]:
        """
        从聊天历史中提取记忆条目，作为 LLM 失败时的回退方案。
        
        Args:
            chat_history: 包含 'role' 和 'content' 键的聊天消息列表
            session_id: 可选的会话 ID，与提取的记忆关联
            
        Returns:
            包含 text、timestamp 和可选 session_id 的记忆条目列表
        """
        memories = []
        
        for msg in chat_history:
            if not isinstance(msg, dict):
                continue
            if msg.get("role") == "assistant":
                content = str(msg.get("content", ""))
                lines = content.split('\n')
                
                for line in lines:
                    line = line.strip()
                    # 查找可能包含记忆的列表项或编号列表
                    if re.match(r'^[-*•]|\d+\.', line):
                        # 提取标记/编号后面的文本。将两种标记组合在一起
                        # 使捕获适用于任一情况 — 之前的 `^[-*•]|\d+\.\s*(.*)`
                        # 仅在编号分支放置捕获组，导致标记行匹配后
                        # group(1)=None 并在 .strip() 时崩溃。
                        text_match = re.match(r'^(?:[-*•]|\d+\.)\s*(.*)', line)
                        if text_match:
                            text = text_match.group(1).strip()
                            if text:
                                memories.append({
                                    "text": text,
                                    "timestamp": int(datetime.now().timestamp()),
                                    "session_id": session_id
                                })
                    # 如果看到暗示记忆的标题
                    elif re.search(r'memory|fact|note|remember', line, re.I):
                        pass
                    # 如果看到明确的分隔符或结束标记
                    elif re.match(r'^={3,}|-{3,}|_{3,}', line):
                        pass
                        
        return memories
        
    def process_inline_memory_command(self, message: str) -> Tuple[bool, str]:
        """
        检查消息是否为行内记忆命令（例如 "remember: X"）。
        
        Args:
            message: 要检查的用户消息
            
        Returns:
            (is_command, extracted_text) 元组，其中 is_command 为 True 表示
            消息匹配记忆命令模式
        """
        # 记忆命令模式: "remember: X", "memorize: X", "save: X" 等。
        pattern = r'^(?:remember|memorize|save|note|store)[:\-]?\s+(.+)$'
        match = re.match(pattern, message.strip(), re.IGNORECASE)
        
        if match:
            return True, match.group(1).strip()
        else:
            return False, ""
    
    def ensure_file_exists(self):
        """如果记忆文件不存在则创建。"""
        if not os.path.exists(self.memory_file):
            with open(self.memory_file, 'w', encoding='utf-8') as f:
                json.dump([], f, ensure_ascii=False, indent=2)
    
    def load_all(self) -> List[Dict]:
        """从 JSON 文件加载所有记忆条目（未过滤）。"""
        if not os.path.exists(self.memory_file):
            return []

        try:
            with open(self.memory_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return self._validate_entries(data)
        except (json.JSONDecodeError, PermissionError) as e:
            logger.error("Error loading memory.json: %s", e)
            return self._migrate_from_legacy()

        return []

    def load(self, owner: str = None) -> List[Dict]:
        """加载记忆条目，可选按所有者过滤。"""
        entries = self.load_all()
        if owner is None:
            return entries
        return [e for e in entries if e.get("owner") == owner]

    def claim_ownerless(self, owner: str):
        """将所有无所有者的记忆条目分配给给定的所有者。"""
        entries = self.load_all()
        changed = False
        claimed = 0
        for entry in entries:
            if not entry.get("owner"):
                entry["owner"] = owner
                changed = True
                claimed += 1
        if changed:
            self.save(entries)
            logger.info("Claimed %d ownerless memories for %s", claimed, owner)
    
    def _validate_entries(self, entries: List[Dict]) -> List[Dict]:
        """确保所有条目包含必需字段。"""
        validated = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if "id" not in entry:
                entry["id"] = str(uuid.uuid4())
            if "timestamp" not in entry:
                entry["timestamp"] = int(time.time())
            if "source" not in entry:
                entry["source"] = "unknown"
            if "category" not in entry:
                entry["category"] = "fact"
            if "uses" not in entry:
                entry["uses"] = 0
            validated.append(entry)
        return validated
    
    def _migrate_from_legacy(self) -> List[Dict]:
        """从旧文本格式迁移到 JSON 格式（如果需要）。"""
        legacy_path = os.path.join(os.path.dirname(self.memory_file), "memory.txt")
        if not os.path.exists(legacy_path):
            return []
            
        logger.info("Converting legacy memory.txt to new JSON format")
        try:
            with open(legacy_path, "r", encoding="utf-8") as f:
                lines = [ln.strip() for ln in f.readlines() if ln.strip()]
            
            entries = []
            for line in lines:
                entries.append({
                    "id": str(uuid.uuid4()),
                    "text": line,
                    "timestamp": int(time.time()),
                    "source": "user",
                    "category": "fact"
                })
            
            self.save(entries)
            return entries
        except Exception as e:
            logger.error("Failed to convert legacy memory: %s", e)
            return []
    
    def save(self, entries: List[Dict]):
        """将记忆条目保存到 JSON 文件。"""
        # 保存前验证条目
        for entry in entries:
            if "id" not in entry:
                entry["id"] = str(uuid.uuid4())
            if "timestamp" not in entry:
                entry["timestamp"] = int(time.time())
            if "source" not in entry:
                entry["source"] = "user"
            if "category" not in entry:
                entry["category"] = "fact"
        
        # 使用原子写入
        tmp_file = self.memory_file + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False, indent=2)
        os.replace(tmp_file, self.memory_file)
    
    def add_entry(self, text: str, source: str = "user", category: str = "fact", owner: str = None) -> Dict:
        """添加新的记忆条目。"""
        if not text.strip():
            raise ValueError("Memory text cannot be empty")

        entry = {
            "id": str(uuid.uuid4()),
            "text": text.strip(),
            "timestamp": int(time.time()),
            "source": source,
            "category": category,
            "uses": 0,
        }
        if owner:
            entry["owner"] = owner
        return entry

    def increment_uses(self, ids: List[str]) -> None:
        """递增每个记忆 ID 的使用计数。在记忆实际被注入到
        聊天上下文（而非仅检索）后调用。"""
        if not ids:
            return
        id_set = set(ids)
        entries = self.load_all()
        changed = False
        for e in entries:
            if e.get("id") in id_set:
                e["uses"] = int(e.get("uses", 0) or 0) + 1
                changed = True
        if changed:
            self.save(entries)
    
    def find_duplicates(self, text: str, entries: List[Dict] = None) -> List[Dict]:
        """基于文本内容查找重复的记忆条目。"""
        if entries is None:
            entries = self.load()
            
        text_lower = text.strip().lower()
        return [entry for entry in entries if entry["text"].lower() == text_lower]
            
    def categorize_memory_by_relevance(self, message: str, memories: list):
        """按类型和相关性对记忆进行分类"""
        categories = {
            "contacts": [],
            "preferences": [],
            "facts": [],
            "tasks": []
        }
        
        msg_lower = message.lower()
        
        for mem in memories:
            text_lower = mem["text"].lower()
            
            # 联系人信息
            if any(word in text_lower for word in ["phone", "email", "address", "lives", "works"]):
                if any(word in msg_lower for word in ["contact", "phone", "address", "email"]):
                    categories["contacts"].append(mem)
            
            # 个人偏好
            elif any(word in text_lower for word in ["likes", "dislikes", "prefers", "favorite"]):
                if any(word in msg_lower for word in ["like", "prefer", "favorite", "want"]):
                    categories["preferences"].append(mem)
            
            # 任务和待办事项
            elif any(word in text_lower for word in ["todo", "task", "remind", "meeting"]):
                if any(word in msg_lower for word in ["todo", "task", "schedule", "remind"]):
                    categories["tasks"].append(mem)
            
            # 一般事实 — 仅在高度相关时
            else:
                if get_text_similarity(message, mem["text"]) > 0.4:
                    categories["facts"].append(mem)
        
        return categories

    def get_relevant_memories(self, query: str, memories: list, threshold: float = 0.05, max_items: int = 8):
        """基于文本相似度和语义关键词匹配获取与查询相关的记忆。"""
        if not memories or not query.strip():
            return []
            
        # 定义语义匹配的关键词类别
        identity_words = ["name", "who", "i", "am", "called", "identity", "myself", "me", "my"]
        contact_words = ["phone", "email", "address", "contact", "number", "where", "located", "reach"]
        preference_words = ["like", "prefer", "favorite", "want", "love", "hate", "dislike", "enjoy", "interested"]
        task_words = ["todo", "task", "remind", "meeting", "appointment", "schedule", "deadline"]
        fact_words = ["what", "when", "where", "how", "why", "explain", "describe", "information", "know"]
        
        query_lower = query.lower()
        
        # 基于关键词确定查询类型
        query_type = None
        if any(word in query_lower for word in identity_words):
            query_type = "identity"
        elif any(word in query_lower for word in contact_words):
            query_type = "contact"
        elif any(word in query_lower for word in preference_words):
            query_type = "preference"
        elif any(word in query_lower for word in task_words):
            query_type = "task"
        elif any(word in query_lower for word in fact_words):
            query_type = "fact"
        
        relevant = []
        identity_memories = []
        other_memories = []
        
        # 将身份记忆与其他记忆分离
        for memory in memories:
            memory_text = memory["text"].lower()
            # 检查是否为身份记忆（包含姓名模式或身份标识符）
            is_identity = any([
                re.search(r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', memory["text"]),
                any(word in memory_text for word in ["name is", "i'm", "i am", "called", "my name", "named", "call me"])
            ])
            if is_identity:
                identity_memories.append(memory)
            else:
                other_memories.append(memory)
        
        # 对于身份查询，包含所有身份记忆，无论相似度如何
        if query_type == "identity" and identity_memories:
            # 赋予高分以确保它们排在前面
            for memory in identity_memories:
                relevant.append((0.9, memory))  # 身份查询中身份记忆的高分
        
        # 用相似度打分处理其他记忆
        for memory in other_memories:
            memory_text = memory["text"].lower()
            memory_tokens = set(tokenize(memory_text))
            query_tokens = set(tokenize(query_lower))
            
            # 计算基础 Jaccard 相似度
            if not query_tokens or not memory_tokens:
                continue
                
            base_similarity = len(query_tokens & memory_tokens) / len(query_tokens | memory_tokens)
            final_score = base_similarity
            
            # 基于语义匹配应用加分
            if query_type == "contact":
                # 对包含联系人信息的记忆加分
                has_contact_info = any(word in memory_text for word in ["@gmail.com", "@", ".com", 
                                                                     "phone", "number", "address", 
                                                                     "http", "www", "tel:"])
                if has_contact_info:
                    final_score *= 1.4  # 联系人相关记忆加 40%
            
            elif query_type == "preference":
                # 对包含偏好标识的记忆加分
                has_preference = any(word in memory_text for word in ["like", "love", "hate", "dislike", 
                                                                   "prefer", "favorite", "enjoy", "interested"])
                if has_preference:
                    final_score *= 1.3  # 偏好相关记忆加 30%
            
            elif query_type == "task":
                # 对包含任务标识的记忆加分
                has_task = any(word in memory_text for word in ["todo", "task", "remind", "meeting", 
                                                              "appointment", "schedule", "deadline", "need to"])
                if has_task:
                    final_score *= 1.3  # 任务相关记忆加 30%
            
            # 始终将精确短语匹配视为高度相关
            if query.lower() in memory["text"].lower():
                final_score = max(final_score, 0.8)  # 确保精确匹配的高相关性
            
            # 如果记忆在加分后达到阈值则包含
            if final_score >= threshold:
                relevant.append((final_score, memory))
        
        # 按最终得分降序排序，返回前若干个匹配
        relevant.sort(key=lambda x: x[0], reverse=True)
        return [mem for _, mem in relevant[:max_items]]
