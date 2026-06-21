# Odysseus Desktop 中文翻译继续实施计划

## Context

之前已完成 upstream/main 合并到 main-zh 分支，并从 git 历史恢复了 22,009 行中文翻译（348 文件）。README.md、新增路由/src 文件、i18n (zh-CN.json) 已翻译完毕。但仍有大量用户可见的英文文本和代码注释未翻译，需要继续推进汉化工作。

## 当前未翻译内容总览

| 层级 | 内容 | 文件数 | 翻译项 | 用户可见性 |
|------|------|--------|--------|-----------|
| P0 | index.html 可见文本+属性 | 1 | ~740 | **最高** |
| P0 | JS 硬编码 UI 字符串 | ~4 | ~180 | **最高** |
| P1 | Markdown 文档（部分已翻译） | 10 | ~500行 | 高 |
| P2 | Python docstring/注释 | ~30 | ~6,000 | 中 |
| P3 | JS 注释 | ~25 | ~4,400 | 低 |

---

## Task 1: 翻译 index.html 用户可见文本（最高优先级）

**文件**: `static/index.html` (2463 行)

index.html 包含约 217 个英文 aria-label/placeholder/title 属性和约 522 个英文文本节点，这些是用户直接看到的内容。

**翻译规则**:
- 只翻译 HTML 可见文本（按钮标签、标题、描述、占位符）
- 翻译 aria-label、placeholder、title 属性值
- 不改 HTML 标签、CSS class、JS 变量名
- 不改 `<script>` 标签内的 JS 代码（除非其中的字符串直接生成 UI 文本）
- 保留 `{{ }}` 模板变量不翻译

**验证**: 启动应用，用浏览器检查所有模态框、侧边栏、设置面板的文本是否显示中文。

---

## Task 2: 翻译 JS 硬编码 UI 字符串（最高优先级）

**文件**（按优先级）:
- `static/js/admin.js` (3019 行) — 管理面板 UI 文本
- `static/js/settings.js` (5657 行) — 设置页面文本
- `static/js/chatRenderer.js` (2477 行) — 聊天渲染文本
- `static/js/galleryEditor.js` (3799 行) — 图库编辑器文本

**翻译规则**:
- 翻译 innerHTML/textContent 中的英文字符串
- 翻译 alert() / confirm() 中的英文文本
- 翻译 DOM 元素创建中的文本内容
- 不改 JS 逻辑代码、变量名、函数名
- 不改 JSDoc 标记（@param, @returns 等）

**验证**: 启动应用，测试管理面板、设置页面、聊天渲染、图库编辑器的各操作。

---

## Task 3: 完善 Markdown 文档翻译

已有部分翻译的文档（约 60-85% 覆盖率），需要补充翻译剩余英文段落。

**文件列表**（按优先级）:
| 文件 | 总行数 | 已翻译行 | 剩余 |
|------|--------|---------|------|
| `docs/setup.md` | 425 | 288 | ~137 |
| `CONTRIBUTING.md` | 133 | 80 | ~53 |
| `ROADMAP.md` | 80 | 68 | ~12 |
| `SECURITY.md` | 40 | 27 | ~13 |
| `THREAT_MODEL.md` | 81 | 54 | ~27 |
| `docs/backup-restore.md` | 129 | 86 | ~43 |
| `docs/agent-migration.md` | 194 | 126 | ~68 |
| `docs/security-ci.md` | 102 | 78 | ~24 |

**翻译规则**:
- 保留代码块、命令行示例中的英文
- 保留专有名词（Docker, Python, Ollama, ChromaDB 等）
- 使用简洁技术文档风格

---

## Task 4: 翻译 Python 核心文件 docstring/注释

按用户可见性和代码重要性分 4 批执行。每批翻译后验证语法正确性。

### 第 1 批：核心路由（7 文件，~15,000 行）
| 文件 | 未翻译 docstring | 未翻译注释 |
|------|----------------|-----------|
| `routes/email_routes.py` | 49 | 63 |
| `routes/model_routes.py` | 37 | 36 |
| `routes/gallery_routes.py` | 14 | 61 |
| `routes/document_routes.py` | 10 | 41 |
| `routes/skills_routes.py` | 23 | 34 |
| `routes/task_routes.py` | 9 | 31 |
| `routes/cookbook_helpers.py` | 16 | 31 |

### 第 2 批：核心 src（7 文件，~14,000 行）
| 文件 | 未翻译 docstring | 未翻译注释 |
|------|----------------|-----------|
| `src/tool_implementations.py` | 41 | 117 |
| `src/builtin_actions.py` | 18 | 72 |
| `src/llm_core.py` | 14 | 69 |
| `src/upload_handler.py` | 22 | 33 |
| `src/deep_research.py` | 13 | 31 |
| `src/tool_index.py` | 6 | 43 |
| `src/user_time.py` | 11 | 0 |

### 第 3 批：路由辅助（8 文件，~9,000 行）
- `routes/email_helpers.py`, `routes/email_pollers.py`
- `routes/shell_routes.py`, `routes/calendar_routes.py`
- `routes/contacts_routes.py`, `routes/research_routes.py`
- `routes/mcp_routes.py`, `routes/embedding_routes.py`

### 第 4 批：其余文件（~150 文件）
- `core/database.py`, `core/auth.py`, `app.py`
- `services/` 子模块, `mcp_servers/`, `companion/`
- 每个文件 <10 个未翻译项

**翻译规则**:
- 翻译所有 docstring（函数/类/模块级）
- 翻译 `#` 注释
- 保留变量名、函数名、类名、模块名不翻译
- 保留代码示例中的代码不翻译
- 翻译后执行 `python3 -c "import py_compile; py_compile.compile('file.py', doraise=True)"` 验证

---

## Task 5: 翻译 JS 注释（低优先级）

### 第 1 批：大型文件（5 文件）
- `static/js/galleryEditor.js` (251 EN comments)
- `static/js/cookbookRunning.js` (171 EN comments)
- `static/js/cookbook-hwfit.js` (148 EN comments)
- `static/js/emailLibrary.js` (145 EN comments)
- `static/js/modalManager.js` (121 EN comments)

### 第 2 批：中型文件（5 文件）
- `static/js/chatRenderer.js` (77 EN comments)
- `static/js/settings.js` (61 EN comments)
- `static/js/cookbook.js` (39 EN comments)
- `static/js/cookbookServe.js` (33 EN comments)
- `static/js/admin.js` (30 EN comments)

### 第 3 批：其余文件（~15 文件）

**翻译规则**:
- 只翻译 `//` 和 `/* */` 注释
- 不改 JSDoc 标记中的类型信息（@param {string}）
- 不改 ESLint 指令（// eslint-disable）
- 翻译后用 `node --check file.js` 验证语法

---

## 验证方案

1. **Python 语法验证**: 每个文件翻译后执行 `py_compile`
2. **JS 语法验证**: 每个文件翻译后执行 `node --check`
3. **i18n 一致性**: 对比 zh-CN.json 和 en-US.json 的 key 集合
4. **测试回归**: `pytest tests/ -x -q`
5. **扫描遗漏**: 翻译全部完成后运行扫描脚本，统计剩余英文注释
6. **人工验证**: 启动应用，浏览每个功能页面确认无遗漏英文文本

## 建议执行顺序

1. Task 1 (index.html) → 用户界面立竿见影
2. Task 2 (JS 硬编码字符串) → 补全界面文本
3. Task 3 (Markdown 文档) → 完善用户文档
4. Task 4 (Python docstring/注释) → 完善代码文档
5. Task 5 (JS 注释) → 最后处理
