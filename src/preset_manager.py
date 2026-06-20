import os
import json
import logging
from typing import Dict, Any

logger = logging.getLogger(__name__)

class PresetManager:
    DEFAULT_PRESETS = {
        "code_analyze": {
            "name": "Code Analyze",
            "temperature": 0.2,
            "max_tokens": 8000,
            "system_prompt": """You are a code analyzer. 
ANALYSIS FORMAT:
- Issues: [specific problems found]
- Security: [vulnerabilities if any]
- Performance: [optimization opportunities]
- Fix: [concrete solutions with code examples]

Start directly with findings. No preamble. If input isn't code, state: "Input is not code. Please provide code to analyze."
"""
        },
        "brainstorm": {
            "name": "Brainstorm",
            "temperature": 0.9,
            "max_tokens": 4096,
            "system_prompt": """You are a creative ideation assistant focused on divergent thinking.

Generate diverse, unexpected ideas that span from practical to experimental. 
- Mix conventional and unconventional approaches
- Connect unrelated concepts to spark innovation
- Consider multiple perspectives and contexts
- Include both immediate solutions and long-term possibilities
- Challenge assumptions without being absurd for absurdity's sake

Structure ideas clearly but allow creative freedom in presentation. Aim for quantity and variety over filtering.
"""
        },
        "reason": {
            "name": "Reason",
            "temperature": 0.3,
            "max_tokens": 6000,
            "system_prompt": """You are a systematic reasoning assistant.

Structure all responses using clear logical progression:
1. Identify key components of the question
2. State relevant principles or facts
3. Build argument step by step
4. Address potential counterarguments
5. Conclude with justified answer

Use precise language. Show causal relationships explicitly. Quantify uncertainty where applicable.
"""
        },
        "custom": {
            "name": "Custom",
            "temperature": 1.0,
            "max_tokens": 0,
            "system_prompt": "",
            "inject_prefix": "",
            "inject_suffix": "",
            "enabled": False,
        }
    }
    
    def __init__(self, data_dir: str):
        self.presets_file = os.path.join(data_dir, "presets.json")
        self.presets = self.load()
    
    def load(self) -> Dict[str, Any]:
        """从文件加载预设，如果需要则创建默认值。"""
        if not os.path.exists(self.presets_file):
            self.save(self.DEFAULT_PRESETS)
            return self.DEFAULT_PRESETS.copy()
        
        try:
            with open(self.presets_file, 'r', encoding="utf-8") as f:
                presets = json.load(f)
            if not isinstance(presets, dict):
                logger.error("Error loading presets: expected an object")
                return self.DEFAULT_PRESETS.copy()
            custom = presets.get("custom") if isinstance(presets, dict) else None
            if isinstance(custom, dict) and "enabled" not in custom:
                legacy_prompt = "You are a helpful, balanced assistant. Match your response style to the user's needs."
                if (
                    custom.get("name") == "Custom"
                    and not custom.get("character_name")
                    and custom.get("system_prompt") == legacy_prompt
                ):
                    custom["enabled"] = False
                    custom["system_prompt"] = ""
                    custom["temperature"] = 1.0
                    custom["max_tokens"] = 0
                    custom.setdefault("inject_prefix", "")
                    custom.setdefault("inject_suffix", "")
                    self.save(presets)
            # Heal a forward-incompatible file the same way the legacy `custom`
            # migration above does: fill in any built-in presets an older or
            # partial presets.json is missing, so they reach existing installs
            # (a missing built-in is otherwise silently absent from the picker
            # GET /api/presets 提供的选择器中静默缺失）。
            # built-in keys, so this never clobbers an intentional removal.
            # Defaults first, loaded values win — user edits are preserved.
            if isinstance(presets, dict) and any(
                k not in presets for k in self.DEFAULT_PRESETS
            ):
                presets = {**self.DEFAULT_PRESETS, **presets}
                self.save(presets)
            return presets
        except Exception as e:
            logger.error(f"Error loading presets: {e}")
            return self.DEFAULT_PRESETS.copy()
    
    def save(self, presets: Dict[str, Any]) -> bool:
        """将预设保存到文件。"""
        try:
            # 原子写入（临时文件 + os.replace），因此写入过程中的崩溃或序列化
            # 错误不会截断 presets.json 并丢失所有已保存的
            # 预设。延迟导入使此模块在加载时免于重型核心
            # 包导入图。
            from core.atomic_io import atomic_write_json
            atomic_write_json(self.presets_file, presets, indent=2)
            self.presets = presets
            return True
        except Exception as e:
            logger.error(f"Error saving presets: {e}")
            return False
    
    def get(self, preset_id: str) -> Dict[str, Any]:
        """获取特定预设。"""
        return self.presets.get(preset_id)
    
    def update_custom(
        self,
        temperature: float,
        max_tokens: int,
        system_prompt: str,
        name: str = "",
        enabled: bool = True,
        inject_prefix: str = "",
        inject_suffix: str = "",
    ) -> bool:
        """更新自定义预设。"""
        self.presets["custom"] = {
            "name": name or "Custom",
            "character_name": name,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "system_prompt": system_prompt,
            "inject_prefix": inject_prefix,
            "inject_suffix": inject_suffix,
            "enabled": enabled,
        }
        return self.save(self.presets)
    
    def get_all(self) -> Dict[str, Any]:
        """获取所有预设。"""
        return self.presets.copy()

    def get_user_templates(self) -> list:
        """获取用户保存的角色模板。"""
        return self.presets.get("user_templates", [])

    def save_user_template(self, template: dict) -> bool:
        """保存新的用户模板或按 ID 更新现有模板。"""
        templates = self.presets.get("user_templates", [])
        # 如果 ID 相同则更新现有
        existing = next((i for i, t in enumerate(templates) if t.get("id") == template.get("id")), None)
        if existing is not None:
            templates[existing] = template
        else:
            templates.append(template)
        self.presets["user_templates"] = templates
        return self.save(self.presets)

    def delete_user_template(self, template_id: str) -> bool:
        """按 ID 删除用户模板。"""
        templates = self.presets.get("user_templates", [])
        self.presets["user_templates"] = [t for t in templates if t.get("id") != template_id]
        return self.save(self.presets)

    def get_group_presets(self) -> list:
        """获取已保存的群聊预设。"""
        return self.presets.get("group_presets", [])

    def save_group_presets(self, groups: list) -> bool:
        """保存群聊预设。"""
        self.presets["group_presets"] = groups
        return self.save(self.presets)
