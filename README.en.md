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
- **Live2D pet** — Always-on-top desktop pet powered by `pixi-live2d-display`
  + Cubism, with expression switching, mouth sync, click interaction, and
  natural idle animations.
- **Multi-window architecture** — 7 independent BrowserWindows: main chat,
  sidebar, tasks, settings, sticker manager, voice call, and the pet itself —
  each focused on its own experience.
- **Pet state sync** — Pet displays live status (accompanying / thinking /
  working / listening / reminding) and emotion (calm / happy / gentle /
  excited / clingy) that update with the conversation in real time.
- **Always-on-top / drag / click-through** — Toggle always-on-top, drag
  anywhere, and click-through to underlying windows without breaking the
  pet's presence.
- **Tray menu** — Right-click tray icon for quick access: status panel,
  settings, show/hide pet, quit.
- **AG-UI expression broadcast** — Agent uses the `play_live2d_action` tool
  to push (expression + motion + bubble) events to the pet window, so the
  pet performs along with the conversation mood.
- **One-click zoom & visibility** — Adjust pet size and toggle visibility
  from settings, optionally launch at boot.

### 💬 Conversation
- **Daily chat** — Natural conversational agent grounded in the Cyrene
  persona (system.md / identity.md / soul.md / canon_quotes.md), with three
  switchable personality styles: desktop / phone / call.
- **AG-UI event stream** — Standardized agent events (RUN_STARTED /
  TEXT_MESSAGE / TOOL_CALL / RUN_FINISHED) with per-token delta rendering,
  perceived latency close to real-time replies.
- **Multi-chat history** — Each chat persisted as its own JSON
  (`<userData>/cyrene-chats/`), with auto-derived titles, `updatedAt`
  sorting, double-click rename — leaving the localStorage era behind.
- **Drag-and-drop file ingestion** — Drop PDF/MD/TXT/DOCX/XLSX/PPTX/CSV/JSON
  into the chat window; chunks are auto-extracted and injected into the RAG
  knowledge base with traceability.
- **TTS read-aloud + one-click copy** — Each message has inline SVG icons
  for read-aloud and copy.
- **Chat rail** — Right-side rail lists all chats (new / list / empty
  states), sorted by time desc, polling refresh every 30 s.
- **User choice cards** — When the agent encounters ambiguous questions,
  it pops choice cards via `ask_user_choice`, using AGUI CUSTOM events —
  no need for users to dictate answers.
- **Stickers** — Built-in sticker picker with three sizes (small / standard /
  large); AI can auto-match the best sticker by reply similarity.
- **TTS early-play optimization** — Pre-synthesize the first audio segment
  during streaming output, cutting first-word latency.
- **Voice calls** — State machine `IDLE → LISTENING → THINKING → SPEAKING
  → ENDED`, 24-turn sliding window context, VAD silence auto-triggers reply.
- **Call context persistence** — The 24-turn × 2-message sliding window
  survives call end, so reconnecting resumes context.

### 🧠 Memory Engine
- **L0 core profile** — Nickname, address, occupation, long-term interests,
  preferred language, notes; `isPinned` locks fields against AI overwrite.
- **L1 recent state** — `recentGoals` / `recentPreferences` / `currentProject`
  short-term profile with periodic refresh.
- **L2 long-term memory** — Full evidence chain: `weight` (0-100),
  `accessCount`, `status` (active/aging/archived/superseded/merged),
  `conflictWith`, `evidenceIds`; per-entry delete / pin / batch archive.
- **Automatic weight decay** — -1 per turn with quadratic acceleration and
  `sqrt(intrinsicValue)` resistance; thresholds 60/30/10 auto-flip
  active/aging/archived.
- **Conflict detection & resolution** — Local lexical candidates → RAG
  recall → scoring → queue → resolver; state machine `candidate → pending
  → confirmed/dismissed/resolved`; resolution types cover unrelated /
  context_difference / preference_evolution / direct_conflict / uncertain.
- **Personalized recall** — `recall_history` tool + auto `updateL2RecallStats
  (+1)` per recall; `recent-injected-memory` prevents repeated injection.
- **DMAE Worldbook engine** — Markdown entry format (trigger words / pinned /
  priority / intrinsic value / linked triggers), activation formula
  `Ru = Bu × (1 + γ·ln(1+U_old))`, Active/Dormant/Archived state machine.
- **One-shot cascade trigger** — 1-level cap + userHit guard + cascade dedup,
  so related entries auto-activate via causal chains.
- **Document & knowledge RAG import** — Supports txt/md/pdf/docx/xlsx/pptx/
  csv/json; imported docs tagged `source: imported_doc`, bulk-deletable in
  one click.
- **Hybrid retrieval** — Vector + BM25 + reranker (three modes: light /
  standard / none); embedding via local `@xenova/transformers` or
  cloud OpenAI-compatible.
- **Entity relationship graph** — jieba dictionary injection prevents
  "Cyrene / 小鹿" from being split wrong; injects `【人物关系】` section
  to reinforce character relationships.
- **Relationship log** — Per-turn mood regex capture (tired/anxious/low/
  happy) + `nextCareCue` next-care hook; daily summary compression + 90-day
  rolling window.

### 🛠 Tasks & Tools
- **Task panel** — Today's date + current token usage + 7-day token
  histogram (Chart.js) + today's scheduled tasks; 30 s polling + scheduler
  event-driven refresh.
- **Scheduled task engine** — Single timer scheduling the next trigger
  (`maxTimerDelay = 1h`), task types `once` / `daily` / `weekly` /
  `interval`; missed triggers recomputed via
  `normalizeOverdueNextFireAt`; triggers inject "I'm a scheduled task"
  metadata into the agent.
- **Document generation tools** — `write_excel` (exceljs multi-sheet/
  formulas/styles), `write_word` (docx paragraphs/tables/headings/lists/
  headers/footers/TOC), `write_pdf` (pdfkit text/tables/font embedding),
  `write_markdown`.
- **File / Shell tools** — `read_file` / `list_dir` / `write_file` /
  `read_image` (vision captioner to parse image content).
- **Web fetch / search** — `fetch_url` (turndown HTML→Markdown),
  `web_search` (search + scrape, playwright fallback).
- **Life utilities** — `record_expense` / `query_expense` ledger + summary,
  `exchange_rate`, `translate`, `apply_patch` (unified diff), `plan_trip`
  multi-day itinerary.
- **Task delegation & query** — `delegate_task` (sub-agent), `todo_write`
  checklist + status bar, `ask_user_choice` user choice cards.
- **Skill system** — Dual-source scan (`prompts/skills/` builtin +
  `<userData>/skills/` user override, directory-level override); meta tools
  `invoke_skill` / `read_skill_reference` (with path traversal guard +
  read replay interceptor + large-text truncation); supports
  `/skill_id ...` slash commands.
- **Game Bot automation** — `engine.ts` step interpreter supports
  `launch / wait / key / click / vlm_click / vlm_select / vlm_check /
  branch` instructions; GameRecipe format describes automation flows;
  exposed as the `game_bot_start` tool.
- **Permission tiers** — `ToolRiskLevel` (safe/caution/dangerous) three-tier
  approval; dangerous operations trigger a confirmation dialog.

### 🎨 Themes & UI
- **Multi-theme system** — Pearl-white, classic, seasonal variants driven
  by CSS variables; text readability hits WCAG-AA.
- **Sidebar overview** — 📌 always-on-top toggle, 💬 chat / ⏰ tasks /
  ⚙️ settings / 🔑 switch model / 📞 call one-click shortcuts; live
  online/offline + status emoji + emotion emoji + current model
  displayName.
- **Chat window** — Message stream, attachment bubbles, sticker embed,
  todo status bar, weather bubble, ask_user_choice cards, AG-UI streaming
  delta, copy/read-aloud SVGs, history rail, sticker picker, full
  min/max/close lifecycle.
- **Task panel** — Chart.js 7-day histogram with daily average / peak,
  current date, current token count.
- **Settings panel** — 14 tabs: 🧠 Memory / 💬 Chat / 👤 User / ⏰ Tasks /
  💼 Role / ✨ Skills / 🔌 Plugins / 🌐 External MCP / ⚙️ General /
  🔑 API / 🌸 Cyrene / 📱 Phone / 🎙️ TTS / 🎧 ASR / 📊 Tokens / 📜
  Disclaimer.
- **Sticker manager** — Grid view + enable toggle + builtin/custom
  categorization.
- **Modal components** — Self-implemented universal confirm dialog
  (inline modal to avoid Vite tree-shaking), self-implemented input
  dialog (Electron disables `window.prompt` fallback).
- **Inline SVG icons** — No emoji font dependency; color follows theme
  (currentColor).

### 🔌 Integrations
- **Feishu / Lark long-connection** — Official SDK + WebSocket long-connection
  (no public domain / no intranet penetration needed); p2p chat only,
  multi-modal text / image / audio / video / file / sticker; resources
  auto-downloaded to local cache.
- **WeChat iLink Bot** — `@tencent-weixin/openclaw-weixin` + CLI; QR-code
  login → long-poll 35 s `getUpdates` → main reply chain `dispatchInbound
  → sendText`; `SessionExpiredError` auto-prompts re-scan.
- **MCP (Model Context Protocol)** — stdio / SSE / HTTP transports;
  builtin servers auto-synced; `install_mcp_server` tool lets the agent
  auto-install new servers.
- **Multi-LLM vendor support** — OpenAI / Anthropic compatible adapters,
  vendor capability table + transport heuristic detection; per-provider
  config + test connection.
- **Multimodal vision** — Settings vision sub-config (`baseUrl / apiKey /
  model`); `SETTINGS_TEST_VISION` one-click connectivity test.
- **QR code generate / parse** — `qrcode` generates dataURL, `qr-image`
  parses QR codes from images, used in channel config QR login flow.

### 🔊 Voice
- **Multi TTS engines** — MiniMax / GPT-SoVITS / Custom Cloud / MiMo / off
  five-way switchable; supports streaming synthesis + audio cache.
- **Multi ASR engines** — Aliyun realtime ASR, auto token acquisition +
  JSON protocol + raw PCM audio stream handling.
- **VAD silence detection** — Detects user pause during voice calls and
  auto-triggers reply, no manual end-turn needed.
- **Voice call audio pipeline** — Call window `pcm-processor.js` handles
  audio stream; call duration + avatar state sync in real time.

### 🧪 Simulation & Testing
- **DMAE scenario simulation** — `npm run sim:coffee` / `sim:mix` /
  `sim:rescue` / `sim:sweep --rewardGain=3,5,7,10` for Worldbook scoring
  parameter sweep; output to `sim-result/`.
- **Vitest unit tests** — `npm test` / `npm run test:watch`, covering
  asr / tts / channels / chats / game-bot / memory / opener /
  orchestrator / rag / scheduler / skills core modules.
- **Build scripts** — `build:main` (tsc) / `build:preload` / `build:renderer`
  (vite) / `dev` (concurrently tsc + vite + electron with VITE_DEV=1).
- **Memory trace log** — `memory-trace.ts` records all L0/L1/L2/RAG/
  conflict operations (ok/error/skip), for debug & audit.

### ⚙️ Developer Experience
- **Unified IPC bus** — `shared/ipc-channels.ts` defines 90+ channel
  constants; all main ↔ renderer communication goes through it, no
  hardcoded strings scattered around.
- **Runtime state preview** — `SETTINGS_PREVIEW_RUNTIME_SYNC`
  (off / local / llm) previews emotion / status copy in real time without
  running the full flow.
- **Embedding model hot-swap** — `EMBEDDING_SET_MODEL` IPC triggers
  dimension-mismatch auto-detection and old-store cleanup, no manual
  migration.
- **File watching / reload** — Boot-time scan of `rag-data` /
  `memory.json` / `worldbook` / `skills` directories; runtime
  `watchWorldbookFile` etc. hot-reloads.

---

## 🧱 Tech Stack

| Layer | Tech |
|---|---|
| Shell | Electron 33 |
| Renderer | Vite 5 + TypeScript 5 + Pixi.js 7 |
| Live2D | `pixi-live2d-display` 0.5.0-beta + Cubism Core |
| AI / MCP | `@modelcontextprotocol/sdk`, `@ag-ui/core`, `@ag-ui/client` |
| Integrations | Lark OpenAPI, WeChat iLink, Nodemailer, PDFKit, docx |
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
├── main/             # Electron main process
│   ├── asr/          # Automatic speech recognition (Aliyun realtime ASR)
│   ├── call/         # Voice call core logic
│   ├── channels/     # External channel adapters (Lark / WeChat iLink / ...)
│   ├── chats/        # Multi-chat history and persistence
│   ├── game-bot/     # Game automation (driven by game-recipes)
│   ├── memory/       # L0/L1/L2 memory engine + RAG
│   ├── opener/       # Launcher / tray / single-instance
│   ├── orchestrator/ # Agent main loop + tool dispatch
│   ├── rag/          # Retrieval-augmented generation + worldbook injection
│   ├── relationship/ # User relationship profile
│   ├── scheduler/    # Scheduled tasks (reminders / agenda)
│   ├── sim/          # Scenario simulation harness
│   ├── skills/       # Agent skill system
│   └── tts/          # Text-to-speech (multi-engine)
├── preload/          # Electron preload bridges (IPC exposure)
├── renderer/         # Vite renderer
│   ├── call/         # Voice call window
│   ├── chat/         # Main chat UI
│   ├── live2d/       # Live2D model rendering logic
│   ├── public/       # Static assets (audio / avatars / models / stickers)
│   ├── settings/     # Settings center
│   ├── sidebar/      # Sidebar
│   ├── sticker-manager/ # Sticker manager
│   ├── tasks/        # Task panel
│   ├── types/        # Shared type definitions
│   └── ui/           # Common UI components
└── shared/           # Code shared between main and renderer

dist/renderer/        # Vite build outputs (not tracked in git)
├── assets/           # Bundled JS/CSS (hashed filenames)
├── audio/            # Sound assets (BGM, SFX)
├── avatars/          # Avatar images
├── call/             # Call window HTML entry
├── chat/             # Main chat HTML entry
├── models/           # Live2D models — see MODEL_LICENSE.md
│   └── cyrene/       # Cyrene model assets
├── settings/         # Settings HTML entry
├── sidebar/          # Sidebar HTML entry
├── sticker-manager/  # Sticker manager HTML entry
├── stickers/         # Sticker image assets
└── tasks/            # Task panel HTML entry
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