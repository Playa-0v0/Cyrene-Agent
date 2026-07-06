# Cyrene-Agent

> Live2D 桌面智能伴侣 (Electron + TS) — Cyrene from Honkai: Star Rail.
> Chat, emotional interaction, personalized memory.

基于 Electron + TypeScript 开发的桌面端 Live2D 智能对话 Agent，
搭载《崩坏：星穹铁道》昔涟（Cyrene）人设，支持日常聊天、情感交互
与个性化记忆引擎。

---

## ⚠️ Disclaimer / 免责声明

This is an **unofficial fan-made project**. It is **NOT** affiliated with,
endorsed by, or sponsored by HoYoverse / miHoYo in any way.

"Honkai: Star Rail", "Cyrene" (昔涟), and all related character designs,
artwork, story content, and trademarks are the intellectual property of
**HoYoverse / miHoYo**.

This project is distributed under the MIT License for **personal and
non-commercial use only**. Any commercial use of this software or its
assets is **strictly prohibited** under miHoYo's fan-content policy.

本项目为**非官方粉丝同人作品**，与 HoYoverse / 米哈游**无任何关联、
背书或赞助关系**。

《崩坏：星穹铁道》、"昔涟"角色及其相关美术、世界观、商标等知识产权
归 **HoYoverse / 米哈游**所有。

本项目以 MIT 协议发布，**仅供个人非商用使用**。根据米哈游同人创作
规范，任何商业用途均**严格禁止**。

---

## ✨ Features / 功能

### 🪟 Desktop Companion / 桌面伴侣
- **Live2D presence**: Always-on-top desktop pet with the Cyrene model,
  expressive reactions, and natural idle animations.
- **Multi-window shells**: Chat, voice call, stickers, tasks, settings —
  each surfaces its own focused experience.

### 💬 Conversation / 对话
- **Daily chat**: Natural conversational agent with personality grounded
  in the Cyrene character.
- **Voice calls**: Real-time voice interaction with call duration and
  avatar visual state.
- **Stickers**: Built-in sticker panel with curated reactions.

### 🧠 Memory Engine / 记忆引擎
- **L0/L1 memory fields**: Editable user-level memory with snapshot
  and dirty-check semantics.
- **Personalized recall**: The agent remembers prior context, user
  preferences, and emotional threads across sessions.

### 🛠 Tasks & Tools / 任务与工具
- **Task panel**: Lightweight task tracking in classic mode.
- **Documents & knowledge import**: Tools to feed the agent curated
  knowledge.

### 🎨 Themes / 主题
- Multiple visual themes including **pearl-white**, **classic**, and
  seasonal variants, with WCAG-AA readable text targets.

---

## 🧱 Tech Stack / 技术栈

| Layer / 层 | Tech / 技术 |
|---|---|
| Shell | Electron 33 |
| Renderer | Vite 5 + TypeScript 5 + Pixi.js 7 |
| Live2D | `pixi-live2d-display` 0.5.0-beta + Cubism Core |
| AI / MCP | `@modelcontextprotocol/sdk`, `@ag-ui/core`, `@ag-ui/client` |
| Integrations | 飞书 OpenAPI, 微信 OpenClaw, Nodemailer, PDFKit, docx |
| Testing | Vitest 4 |

See [`package.json`](./package.json) for the full dependency list.

---

## 🚀 Quick Start / 快速开始

### Prerequisites / 前置条件
- Node.js 18+
- npm 9+

### Install & Build / 安装与构建

```bash
npm install
npm run build
npm start
```

### Dev mode / 开发模式

```bash
npm run dev
```

This runs `tsc` for main/preload + `vite` + Electron concurrently.

### Run tests / 运行测试

```bash
npm test
```

---

## 📦 Project Structure / 项目结构

```
src/
├── main/         # Electron main process
├── preload/      # Electron preload bridges
├── renderer/     # Vite renderer (chat / call / settings / tasks / stickers)
└── sim/          # Scenario simulation harness

dist/renderer/
├── audio/        # Sound assets (BGM, SFX)
├── avatars/      # Avatar images
├── models/       # Live2D models — see MODEL_LICENSE.md
│   └── cyrene/
└── stickers/     # Sticker image assets
```

> **Note**: `dist/renderer/assets/`, `dist/renderer/*/index.html`,
> and other Vite build outputs are **not** tracked in git (see
> `.gitignore`). Run `npm run build:renderer` to regenerate them.

---

## 📄 Licensing / 许可证

- **Source code**: [MIT](./LICENSE) — copyright held by the project authors.
- **Live2D model assets**: See [MODEL_LICENSE.md](./MODEL_LICENSE.md) —
  used with permission from the credited B 站 creator. Character IP
  remains with HoYoverse / miHoYo.

For personal, non-commercial fan use only.

---

## 🙏 Credits / 致谢

- **Cyrene / 昔涟 character**: © HoYoverse / miHoYo
- **Live2D model**: Created by `[UP 主 B 站 ID]` — see
  [MODEL_LICENSE.md](./MODEL_LICENSE.md)
- **Live2D Cubism SDK**: © Live2D Cubism

Special thanks to the original model creator for generously granting
permission to use, modify, and redistribute their work in this project.

特别感谢模型原作者慷慨授权本项目使用、修改并再分发其作品。

---

## 💌 Contact / 联系

Issues and PRs welcome via GitHub. Please keep all discussions respectful
and on-topic.

欢迎通过 GitHub Issues / PR 交流。请保持讨论的礼貌与主题相关性。