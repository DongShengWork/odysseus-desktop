<p align="center">
  <img src="docs/odysseus-wordmark.png" alt="Odysseus" width="280">
</p>

<p align="center">
  自托管 AI 工作台：集聊天、智能体、深度研究、文档、邮件、笔记、日历和本地模型工作流于一体。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/setup.md">安装指南</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a> ·
  <a href="ROADMAP.md">路线图</a>
</p>

<p align="center">
  <a href="https://repology.org/project/odysseus-ai/versions"><img src="https://repology.org/badge/vertical-allrepos/odysseus-ai.svg" alt="Packaging status"></a>
</p>

<p align="center">
  <img src="docs/odysseus.jpg" alt="Odysseus interface">
</p>

---

## 快速开始

> `dev` 是默认分支，会最先获得最新更新。如需更稳定的版本，请使用 [`main`](https://github.com/pewdiepie-archdaemon/odysseus/tree/main) 分支。

```bash
git clone https://github.com/pewdiepie-archdaemon/odysseus.git
cd odysseus
cp .env.example .env
docker compose up -d --build
```

容器启动健康后，打开 `http://localhost:7000`。首次管理员密码在 `docker compose logs odysseus` 中输出。

原生安装、GPU 说明、Windows/macOS 指引、HTTPS 和配置详见[安装指南](docs/setup.md)。

## 功能特性

- **聊天 + 智能体** — 本地/API 模型、工具、MCP、文件、Shell、技能和记忆。
- **Cookbook** — 硬件感知的模型推荐、下载和服务。
- **深度研究** — 多步骤网页研究，来源阅读和报告生成。
- **对比** — 盲测并排模型对比和综合评估。
- **文档** — 写作优先的编辑器，支持 AI 编辑、建议、Markdown、HTML、CSV 和语法高亮。
- **邮件** — IMAP/SMTP 收件箱，支持分类、标签、摘要、提醒和回复草稿。
- **笔记、任务 + 日历** — 提醒、待办、定时智能体任务和 CalDAV 同步。
- **其他** — 图库/图片编辑器、主题、上传、网页搜索、预设、会话和双因素认证。

## 演示

落地页提供完整的悬停播放导览：[`docs/index.html`](docs/index.html)。

## 参与贡献

欢迎贡献！最佳切入点包括：全新安装测试、提供商配置 Bug、移动端/编辑器优化、文档以及小而聚焦的重构。详见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [ROADMAP.md](ROADMAP.md)。

## 安全

Odysseus 是一个自托管工作台，拥有强大的本地工具。请保持认证开启，将私有数据排除在 Git 之外，不要公开暴露原始模型/服务端口。部署详情见[安装指南](docs/setup.md#security-notes)。

## Star 历史

<a href="https://www.star-history.com/?repos=pewdiepie-archdaemon%2Fodysseus&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=pewdiepie-archdaemon/odysseus&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=pewdiepie-archdaemon/odysseus&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=pewdiepie-archdaemon/odysseus&type=date&legend=top-left" />
 </picture>
</a>

## 许可证

AGPL-3.0-or-later -- 详见 [LICENSE](LICENSE) 和 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)。
