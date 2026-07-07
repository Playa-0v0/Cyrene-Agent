# Cyrene-Agent

English | [中文](./README.md)

> Live2D desktop companion (Electron + TS) — Cyrene from Honkai: Star Rail.

A desktop Live2D conversational agent built with Electron + TypeScript,
featuring the Cyrene character from *Honkai: Star Rail*. Supports daily
chat, emotional interaction, and a personalized memory engine.

---

## ⚠️ Disclaimer

This is an **unofficial fan-made project**. It is **NOT** affiliated with,
endorsed by, or sponsored by HoYoverse / miHoYo in any way.

"Honkai: Star Rail", "Cyrene" (昔涟), and all related character designs,
artwork, story content, and trademarks are the intellectual property of
**HoYoverse / miHoYo**.

This project is distributed under the MIT License for **personal and
non-commercial use only**. Any commercial use of this software or its
assets is **strictly prohibited** under miHoYo's fan-content policy.

---

## ✨ Features

### 🪟 Desktop Companion
- **Live2D presence**: Always-on-top desktop pet with the Cyrene model,
  expressive reactions, and natural idle animations.
- **Multi-window shells**: Chat, voice call, stickers, tasks, settings —
  each surfaces its own focused experience.

### 💬 Conversation
- **Daily chat**: Natural conversational agent with personality grounded
  in the Cyrene character.
- **Voice calls**: Real-time voice interaction with call duration and
  avatar visual state.
- **Stickers**: Built-in sticker panel with curated reactions.

### 🧠 Memory Engine
- **L0/L1 memory fields**: Editable user-level memory with snapshot
  and dirty-check semantics.
- **Personalized recall**: The agent remembers prior context, user
  preferences, and emotional threads across sessions.

### 🛠 Tasks & Tools
- **Task panel**: Lightweight task tracking in classic mode.
- **Documents & knowledge import**: Tools to feed the agent curated
  knowledge.

### 🎨 Themes
- Multiple visual themes including **pearl-white**, **classic**, and
  seasonal variants, with WCAG-AA readable text targets.

---

## 🧱 Tech Stack

| Layer | Tech |
|---|---|
| Shell | Electron 33 |
| Renderer | Vite 5 + TypeScript 5 + Pixi.js 7 |
| Live2D | `pixi-live2d-display` 0.5.0-beta + Cubism Core |
| AI / MCP | `@modelcontextprotocol/sdk`, `@ag-ui/core`, `@ag-ui/client` |
| Integrations | Lark OpenAPI, WeChat OpenClaw, Nodemailer, PDFKit, docx |
| Testing | Vitest 4 |

See [`package.json`](./package.json) for the full dependency list.

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm 9+

### Install & Build

```bash
npm install
npm run build
npm start
```

### Dev mode

```bash
npm run dev
```

This runs `tsc` for main/preload + `vite` + Electron concurrently.

### Run tests

```bash
npm test
```

---

## 📦 Project Structure

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

## 📄 Licensing

- **Source code**: [MIT](./LICENSE) — copyright held by the project authors.
- **Live2D model assets**: See [MODEL_LICENSE.md](./MODEL_LICENSE.md) —
  used with permission from the credited Bilibili creator. Character IP
  remains with HoYoverse / miHoYo.

For personal, non-commercial fan use only.

---

## 🙏 Credits

- **Cyrene character**: © HoYoverse / miHoYo
- **Live2D model**: Created by [@是依七哒](https://space.bilibili.com/457683484) —
  see [MODEL_LICENSE.md](./MODEL_LICENSE.md)
- **Live2D Cubism SDK**: © Live2D Cubism

Special thanks to the original model creator for generously granting
permission to use, modify, and redistribute their work in this project.

---

## 💌 Contact

Issues and PRs welcome via GitHub. Please keep all discussions respectful
and on-topic.