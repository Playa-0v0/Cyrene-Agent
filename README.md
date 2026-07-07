# Cyrene-Agent

[English](./README.en.md) | 中文

> Live2D 桌面智能伴侣 (Electron + TS) — Cyrene from Honkai: Star Rail.

基于 Electron + TypeScript 开发的桌面端 Live2D 智能对话 Agent，
搭载《崩坏：星穹铁道》昔涟（Cyrene）人设，支持日常聊天、情感交互
与个性化记忆引擎。

---

## ⚠️ 免责声明

本项目为**非官方粉丝同人作品**，与 HoYoverse / 米哈游**无任何关联、
背书或赞助关系**。

《崩坏：星穹铁道》、"昔涟"角色及其相关美术、世界观、商标等知识产权
归 **HoYoverse / 米哈游**所有。

本项目以 MIT 协议发布，**仅供个人非商用使用**。根据米哈游同人创作
规范，任何商业用途均**严格禁止**。

---

## ✨ 功能

### 🪟 桌面伴侣
- **Live2D 桌宠**：使用昔涟 Live2D 模型的置顶桌面宠物，支持表情反应
  与自然待机动画。
- **多窗口架构**：聊天、语音通话、贴纸、任务、设置各自独立窗口，
  聚焦不同体验。

### 💬 对话
- **日常聊天**：基于昔涟人设的自然对话 Agent。
- **语音通话**：实时语音交互，含通话时长与头像视觉状态。
- **表情贴纸**：内置贴纸面板，精选情绪反应。

### 🧠 记忆引擎
- **L0/L1 记忆字段**：可编辑的用户级记忆，支持快照与脏检查。
- **个性化召回**：跨会话记住上下文、用户偏好与情感线索。

### 🛠 任务与工具
- **任务面板**：经典模式下的轻量任务跟踪。
- **文档与知识导入**：向 Agent 投喂精选知识。

### 🎨 主题
- 多种视觉主题，包括**珠光白**、**经典**及季节限定变体，
  文本可读性达 WCAG-AA 标准。

---

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| Shell | Electron 33 |
| 渲染层 | Vite 5 + TypeScript 5 + Pixi.js 7 |
| Live2D | `pixi-live2d-display` 0.5.0-beta + Cubism Core |
| AI / MCP | `@modelcontextprotocol/sdk`, `@ag-ui/core`, `@ag-ui/client` |
| 集成 | 飞书 OpenAPI, 微信 iLink, Nodemailer, PDFKit, docx |
| 测试 | Vitest 4 |

完整依赖列表见 [`package.json`](./package.json)。

---

## 🚀 快速开始

### 前置条件
- Node.js 18+
- npm 9+

### 安装与构建

```bash
npm install
npm run build
npm start
```

### 开发模式

```bash
npm run dev
```

同时运行 `tsc`（主进程/preload）+ `vite` + Electron。

### 运行测试

```bash
npm test
```

---

## 📦 项目结构

```
src/
├── main/         # Electron 主进程
├── preload/      # Electron preload 桥接
├── renderer/     # Vite 渲染层（聊天 / 通话 / 设置 / 任务 / 贴纸）
└── sim/          # 场景模拟工具

dist/renderer/
├── audio/        # 音频资源（BGM、音效）
├── avatars/      # 头像图片
├── models/       # Live2D 模型 — 见 MODEL_LICENSE.md
│   └── cyrene/
└── stickers/     # 贴纸图片资源
```

> **注意**：`dist/renderer/assets/`、`dist/renderer/*/index.html`
> 等 Vite 构建产物不在 git 跟踪范围内（见 `.gitignore`）。
> 运行 `npm run build:renderer` 重新生成。

---

## 📄 许可证

- **源代码**：[MIT](./LICENSE) — 版权归项目作者所有。
- **Live2D 模型资源**：见 [MODEL_LICENSE.md](./MODEL_LICENSE.md) —
  经 B 站创作者授权使用。角色 IP 归 HoYoverse / 米哈游所有。

仅供个人非商用粉丝向使用。

---

## 🙏 致谢

- **昔涟角色**：© HoYoverse / 米哈游
- **Live2D 模型**：由 [@是依七哒](https://space.bilibili.com/457683484) 制作 —
  详见 [MODEL_LICENSE.md](./MODEL_LICENSE.md)
- **Live2D Cubism SDK**：© Live2D Cubism

特别感谢模型原作者慷慨授权本项目使用、修改并再分发其作品。

---

## 💌 联系

欢迎通过 GitHub Issues / PR 交流。请保持讨论的礼貌与主题相关性。