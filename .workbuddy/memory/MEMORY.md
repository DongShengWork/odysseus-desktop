# odysseus-desktop 项目记忆

## 项目本质
- 基于 [odysseus](https://github.com/pewdiepie-archdaemon/odysseus) 的中文多语言版本
- 本地源项目路径: `/Users/ding/Documents/github/odysseus`
- 当前路径: `/Users/ding/Documents/github/odysseus-desktop`
- 远端: `origin` → `DongShengWork/odysseus-desktop`, `upstream` → 本地 odysseus
- 分支: `main-zh`（中文翻译分支）

## 合并/翻译工作流
- 从 upstream 合并: `git fetch upstream && git merge upstream/main`
- 冲突策略: 代码冲突采用 upstream 版本，翻译重做
- 翻译优先级: P0(HTML/JS UI) > P1(Markdown) > P2(Python注释) > P3(JS注释)
- 翻译工具: Python 脚本 + 正则替换，优先最长匹配避免部分替换
- HTML 翻译验证: 检查结构完整性、CSP_NONCE、模板变量
- JS 翻译验证: `node --check` 语法检查

## 关键文件
- `static/index.html`: 主界面 (2467行)
- `static/js/locales/zh-CN.json`: i18n 翻译表 (1980行)
- `.qoder/translation-plan.md`: 翻译计划
- `static/js/i18n.js`: 国际化框架

## 注意事项
- 不要修改 `.workbuddy/` 目录（项目数据）
- 翻译时保留 HTML 标签、CSS class、JS 变量名
- 保留模板变量 `{{ }}`、`{{CSP_NONCE}}`
- 技术术语、品牌名（Ollama, Docker, API 等）不翻译
