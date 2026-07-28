<div align="center">

<img src="./preview.png" alt="Cyrene Agent" width="800">

# Cyrene-Agent

**English** | [中文](./README.md)

</div>

**Cyrene-Agent is a Windows Live2D AI desktop companion centered around Cyrene from _Honkai: Star Rail_.**

> A desktop Live2D conversational Agent built with Electron and TypeScript.  
> Centered around Cyrene's character design and powered by the self-developed DMAE memory engine,  
> it brings character-driven conversation, personalized memory, voice interaction, tool use, and multi-platform access into a single desktop Agent,  
> while supporting both casual conversation (Chat) and assisted work (Work).

---

## ✨ At a Glance

- 🌸 **Playful Desktop Companion** — A persistent Live2D character with expressions, actions, status, mood, speech bubbles, and intelligent stickers
- 💬 **Casual Conversation (Chat)** — Focused on character-driven interaction, with responses shaped by conversation history, user style, and long-term memory
- 🛠️ **Assisted Work (Work)** — Understands requests, invokes tools through a complete Agent workflow, and replies from verified execution results
- 🧠 **Personalized Memory** — L0 / L1 / L2 layered memory combined with the self-developed DMAE Worldbook for long-term interaction continuity
- 🔊 **Voice Interaction** — Integrated TTS, ASR, and voice calls so Cyrene can listen and respond
- 🧰 **Rich Tool Ecosystem** — Web search, file processing, document generation, everyday services, music, and MCP extensions
- 🔌 **Multi-Provider Model Support** — Tiered Structured Output and Function Calling compatibility profiles for different model providers
- 🎨 **Customizable Appearance** — Multiple interface styles, themes, and chat font options
- 📱 **Multi-Platform Access** — Desktop, Feishu/Lark, and WeChat iLink with shared character capabilities and conversation experience
- 🌙 **Proactive Chat** — Starts conversations according to time, status, and user preferences, with targeted multi-channel delivery

---

## 🚀 Quick Start

### Prerequisites

- **Windows 10 / 11 64-bit**
- **Node.js 24 LTS**
- **npm 10+** (npm 11 recommended)
- **[Rust stable](https://www.rust-lang.org/tools/install)** (required for building the screenshot helper from source)
- **[Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)**

When installing Visual Studio Build Tools, select:

- **Desktop development with C++**
- **MSVC v143**
- **Windows 10 / 11 SDK**

After installing Rust, it is recommended to confirm the MSVC toolchain:

```powershell
rustup default stable-x86_64-pc-windows-msvc
```

> Feishu, WeChat iLink, `nut-js` keyboard/mouse automation, and the native screenshot feature depend on the Windows environment.
>
> If you install a packaged release directly, you do not need to install Rust or Visual Studio Build Tools.

### 1. Clone the Project

```bash
git clone https://github.com/Playa-0v0/Cyrene-Agent.git
cd Cyrene-Agent
```

### 2. Install Dependencies

```bash
npm install
```

The first installation downloads Electron, Pixi.js, Live2D, and related dependencies. The time required depends on your network connection.

### 3. Install BGE-M3 (Recommended)

Cyrene can chat normally without running a local large language model. However, installing the **BGE-M3 Embedding model** is recommended for the complete semantic-enhancement experience:

- Semantic sticker matching
- Scene tone enhancement
- Worldbook semantic retrieval
- RAG retrieval

[Download BGE-M3 from Releases](https://github.com/Playa-0v0/Cyrene-Agent/releases)

> [!IMPORTANT]
>
> Not installing BGE-M3 does not affect basic chat. Features that depend on Embedding will be disabled or degraded automatically.

### 4. Music Feature (Optional)

The music tool is integrated via [Code-MonkeyZhang/cloud-music-mcp](https://github.com/Code-MonkeyZhang/cloud-music-mcp). To use the NetEase Cloud Music feature, install the following additional dependencies:

- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — A Python package manager that will automatically download Python and install all dependencies when the music tool is first used
- **[NetEase Cloud Music Desktop Client](https://music.163.com/)** — Required for music playback; the `orpheus://` protocol must be registered

> [!NOTE]
>
> The music feature is optional and does not affect chat or other core features. If `uv` is not installed, the music tool will be skipped automatically with a UI prompt.

### 5. Build and Start

When running from source for the first time, you need to build the Rust native screenshot helper:

```bash
npm run build:screenshot-helper
npm run build
npm start
```

> [!IMPORTANT]
>
> The native screenshot helper is not committed to the Git repository as an `.exe` file. You must run `npm run build:screenshot-helper` once after cloning.

Development mode:

```bash
npm run build:screenshot-helper
npm run dev
```

After modifying the Rust screenshot helper code, re-run:

```bash
npm run build:screenshot-helper
```

Development mode starts the Electron main process, Preload compilation, the Vite renderer, and the Electron application together.

Changes to the main process automatically restart Electron, while renderer changes are applied through Vite HMR.

Building a distributable Windows version:

```bash
npm run package:win:dir
```

The packaging command automatically builds both the Electron application and the Rust screenshot helper.

---

## 🔑 Configure API Keys

After starting the application, **click the system tray icon → Open Settings**, then complete the basic configuration:

1. **🔑 Model Settings**: Select an LLM provider preset and enter the API Key, Base URL, and model name.  
   This configuration is required for Cyrene to chat and run the Agent.

2. **🎙️ TTS Settings** (optional): Select Mossland, MiniMax, MiMo, GPT-SoVITS, or a custom cloud-based speech synthesis service.

3. **🎧 ASR Settings** (optional): To use voice calls, configure the AppKey and AccessKey for Alibaba Cloud real-time ASR.

4. **📱 External Channels** (optional): Connect Feishu or WeChat iLink to chat with Cyrene from a mobile device.

Configuration is stored in the application's `<userData>/` directory. Most changes do not require a restart.

---

## 📊 Current Status

| Module | Status | Description |
| --- | :---: | --- |
| 🌸 Live2D Desktop Companion | ✅ Available | Always-on-top companion, multiple windows, expressions, actions, mood and status, speech bubbles, and intelligent stickers |
| 💬 Casual Conversation (Chat) | ✅ Available | Independent character-chat flow that neither exposes nor executes tools, using recent messages, social context, and user style |
| 🛠️ Assisted Work (Work) | ✅ Available | Complete Agent workflow: CITA → Action Gate → Native FC → Execution Policy → Tool Runtime → Soul |
| 🧠 Personalized Memory | ✅ Available | L0 / L1 / L2 layered memory, self-developed DMAE Worldbook, relationship profile, and long-term interaction continuity |
| 🔊 Voice Interaction | ✅ Available | Multiple TTS engines, real-time ASR, voice calls, and VAD silence detection; some features require additional configuration |
| 🧰 Built-in Tools | ✅ Available | Web search, webpage reading, file operations, document generation, everyday services, music, and more |
| 🔌 Multi-Provider Model Support | ✅ Available | A / B / M / D tiered Structured Output and Function Calling profiles based on provider capabilities |
| ✨ Skill System | ✅ Available | Built-in Skills, user-defined Skills, slash commands, and reference reading |
| 📚 RAG Document Knowledge Base | 🧪 Experimental | Multi-format document import, vector + BM25 hybrid retrieval, Reranker, and source traceability |
| 🔌 MCP Extension Ecosystem | 🧪 Experimental | Supports stdio, SSE, and HTTP transports; actual compatibility depends on the third-party MCP Server |
| 📱 Feishu / Lark | ✅ Available | Long-connection message access and multiple media types |
| 📱 WeChat iLink | 🧪 Experimental | Long-poll message exchange, media handling, and mobile chat |
| 🌙 Proactive Chat | 🧪 Experimental | Status evaluation, do-not-disturb policies, and delivery through desktop, Feishu, and WeChat |

> ✅ **Available**: The core workflow is implemented and suitable for everyday use.  
> 🧪 **Experimental**: The feature is integrated, but compatibility, edge cases, or user experience are still being refined.

---

## ❓ FAQ

### Local AI Models

### Does Cyrene Support Local LLMs and Other Third-Party Model Platforms?

Cyrene only provides basic generic compatibility and fault-tolerance handling for local models, custom endpoints, and third-party model platforms that are not listed in the compatibility matrix.

Because these endpoints have not been tested through the complete Work workflow:

- Stable operation is not guaranteed
- Structured Output and Function Calling support is not guaranteed
- Completion of the full Agent toolchain is not guaranteed
- Configuration guidance, compatibility troubleshooting, and error diagnosis are currently not provided

Unknown models, local models, and custom endpoints use the generic **Tier D** profile by default. Users must verify actual compatibility themselves.

> [!NOTE]
>
> Cyrene is currently developed independently by a single developer. Time, hardware, and API testing budgets are limited. At this stage, compatibility maintenance and technical support are only provided for the major model providers that have been explicitly adapted and verified. The testing scope may expand as the project develops.

The primary model providers currently covered include:

- Doubao Seed
- Kimi
- DeepSeek
- Qwen
- GLM
- MiMo
- MiniMax
- OpenAI
- Anthropic Claude

Verification status varies by provider and model. Refer to the project's compatibility matrix and benchmark report for authoritative details.

> BGE-M3, `ms-marco-MiniLM-L-6-v2`, and `bge-reranker-base` are local Embedding / Reranker enhancement models used by the project. They are not local large language models for chat.

### Are API Keys Secure?

> [!WARNING]
>
> The current version is not recommended for use on shared computers or in other untrusted environments.

Credentials for the LLM, separate vision model, ASR, TTS, and other third-party services are stored in the application's `<userData>/` directory:

- `<userData>/model-settings.json`: LLM and vision model configuration (plaintext)
- `<userData>/app-settings.json`: ASR, TTS, maps, search, email, and other configuration (plaintext)
- `<userData>/weixin/credentials.json`: WeChat iLink Bot credentials (plaintext)
- `<userData>/mcp-servers.json`: MCP Server configuration, including `env` environment variables (plaintext)
- `<userData>/channels-settings.json`: Feishu `appSecret` / `verificationToken` / `encryptKey` (`safeStorage` encrypted)
- `<userData>/music/netease/account.enc`: NetEase Cloud Music login cookie (`safeStorage` encrypted)

Most credentials are currently stored as plaintext local files and are primarily protected by operating-system permissions on the user data directory.

Feishu channel credentials and the NetEase Cloud Music login cookie are encrypted with Electron `safeStorage`:

- Windows: DPAPI
- macOS: Keychain
- Linux: libsecret
- If the system keyring is unavailable, the application falls back to a weaker local obfuscation method

Do not share or upload `<userData>/`, settings files, or log files. Do not synchronize them to a public cloud drive or commit them to a Git repository.

To clear credentials and application configuration, delete the following files and restart the application:

```text
<userData>/model-settings.json
<userData>/app-settings.json
<userData>/weixin/credentials.json
<userData>/mcp-servers.json
<userData>/channels-settings.json
<userData>/music/netease/account.enc
```

### Can It Run on macOS or Linux?

Cyrene currently targets and is primarily tested on **Windows 10 / 11**.

| Platform | Status | Description |
|---|:---:|---|
| Windows 10 / 11 | ✅ Tested | Primary supported platform |
| macOS | ⚠️ Not fully verified | The Electron application may run, but transparent windows, mouse passthrough, and window layering may have compatibility issues |
| Linux | ⚠️ Not fully verified | Differences in desktop environments and system keyrings may affect some features |

The `game-bot` module uses the native `nut.js` dependency and has only been tested end to end on Windows.

When reporting a macOS or Linux compatibility problem, include the runtime environment, error logs, and reproduction steps in the GitHub Issue.

### What Should I Do About OOM or Excessive Memory Usage?

Try the following steps in order:

1. **Disable the Reranker**  
   Settings → Cyrene Settings → RAG / Document Import → set Reranker mode to `none`.

2. **Disable MCP Services You Are Not Using**  
   Browser automation services such as Playwright may start additional Chromium processes.

3. **Reduce Large RAG Documents**  
   Remove knowledge-base files that are not currently needed to reduce indexing and retrieval overhead.

4. **Close Unused Windows and Background Tasks**  
   Long-running tool tasks, voice services, and multiple conversations may continue consuming resources.

5. **Restart the Application**  
   This releases memory occupied by models, indexes, browser subprocesses, and long-running tasks.

The Embedding index uses a background Worker, batching, and caching to reduce peak memory usage during document import.

If OOM errors continue, use the Chrome DevTools Memory Profiler in development mode to capture a Heap Snapshot, then include the reproduction steps and relevant logs in the Issue.

---

## ✨ Features

### Core Features

#### 🌸 Desktop Companion

- **Live2D Desktop Character** — Rendered with `pixi-live2d-display` and Cubism Core, with always-on-top display, mouse interaction, natural idle animations, and lip sync.
- **Expression and Action Linking** — Conversation content can trigger expressions, actions, status, mood, and desktop speech bubbles, extending feedback beyond text.
- **Intelligent Stickers** — Includes a built-in sticker panel and semantic matching that can automatically select stickers appropriate to the current context.
- **Multi-Window Interaction** — The companion, chat, settings, tasks, call, and sticker-management windows are independent while sharing unified runtime state.
- **Customizable Appearance** — Supports interface themes, chat styles, and font selection.

#### 💬 Casual Conversation (Chat)

- **Independent Character-Chat Flow** — Chat mode focuses on character-driven interaction and does not expose, invoke, or execute tools.
- **Character-Aware Responses** — Combines Cyrene's character design, recent conversation, social context, user style, and personalized memory.
- **Multiple Conversation Histories** — Conversations are stored independently and support automatic titles, sorting, and renaming.
- **Channel-Specific Chat Style** — Desktop chat, mobile channels, and voice calls can use different expression styles.
- **Segmented Replies** — Choose between “segment all / segment Chat only / disabled,” allowing long replies to be split into semantic chat bubbles.

#### 🛠️ Assisted Work (Work)

- **Complete Agent Workflow** — Tool tasks are processed through the following trusted execution chain:

```text
User Request
  ↓
CITA Context Understanding
  ↓
Action Gate Decision
  ↓
Native Function Calling Argument Generation
  ↓
Execution Policy Permission and Risk Checks
  ↓
Tool Runtime Execution
  ↓
RouteAfterTool ──┬── Failure / Replanning Required → Return to Action Gate
                  └── Success → Continue
  ↓
Soul Responds from Verified Results
```

- **Local Trust Validation** — Model output must pass format, Schema, and business-level trust validation. The model itself is not the final trust boundary.
- **Fail-Safe Degradation** — If Action Gate, Native FC, or the execution policy becomes untrusted at any stage, tool execution is prohibited and Soul responds honestly from locally generated failure facts.
- **Multi-Provider Model Profiles** — Automatically selects an A / B / M / D Structured Output Profile based on provider capabilities and applies unified reasoning separation, JSON extraction, Repair, and failure routing.
- **AG-UI Event Stream** — Delivers text, tool calls, execution state, and final results through a unified event stream with token-by-token rendering and tool cards.

#### 📝 Rich Text and Code Rendering

- **Markdown Rendering** — Supports headings, lists, blockquotes, tables, links, code blocks, and other common Markdown elements.
- **Syntax Highlighting** — Supports syntax highlighting and copy actions for multiple common programming languages.
- **Mathematical Formulas** — Supports inline and block-level formula rendering.
- **Streaming Compatibility** — Keeps output stable during generation and renders complete rich text after a message finishes.

#### 🧠 Personalized Memory

- **L0 / L1 / L2 Layered Memory** — Separately manages core user profiles, recent state, and long-term experiences.
- **Memory Evidence Chain** — Memory entries retain their source and context to reduce unsupported profile inference.
- **Conflict Detection and Resolution** — Retrieves, scores, and semantically evaluates old and new memories to distinguish contextual differences, preference evolution, and direct conflict.
- **Self-Developed DMAE Worldbook** — Manages character knowledge and long-term interaction content through triggers, priority, intrinsic value, linked activation, and Active / Dormant / Archived states.
- **Relationship and Style Continuity** — Gradually develops user preferences, communication habits, and relationship context through long-term interaction.

#### 🔊 Voice Interaction

- **Multiple TTS Engines** — Supports Mossland, MiniMax, MiMo, GPT-SoVITS, and custom cloud-based speech services.
- **Real-Time ASR** — Uses Alibaba Cloud real-time speech recognition to convert microphone audio into conversation input.
- **Complete Voice Calls** — Continuous voice interaction through the `LISTENING → THINKING → SPEAKING` state flow.
- **VAD Silence Detection** — Automatically detects when the user has stopped speaking and triggers a response.

#### 🧰 Tool Ecosystem

Cyrene includes many built-in and extensible tools, primarily covering the following categories:

- **Documents and Office Work** — Generate Word, Excel, PDF, and Markdown documents.
- **Web Capabilities** — Web search, webpage reading, content extraction, and information organization.
- **File Processing** — Read, write, and browse local files, as well as interpret images.
- **Everyday Services** — Weather, maps, translation, currency conversion, bookkeeping, trip planning, and more.
- **Music** — Search for songs, retrieve recommendations, and invoke a local music client for playback.
- **Task Collaboration** — Task lists, user-choice cards, task delegation, and subtask handling.
- **MCP Extensions** — Connect additional external tools and services through the Model Context Protocol.

<details>
<summary><b>🧩 Advanced Features</b> (click to expand)</summary>

#### 📚 RAG Document Knowledge Base

- Supports importing `txt`, `md`, `pdf`, `docx`, `xlsx`, `pptx`, `csv`, and `json`.
- Supports hybrid retrieval with vector search, BM25, and a Reranker.
- Supports both local Embedding and OpenAI-compatible cloud Embedding.
- Retrieval results retain source information for traceability.
- Supports entity relationship information and custom tokenization dictionaries.

#### 🔌 MCP (Model Context Protocol)

- Supports `stdio`, SSE, and HTTP transports.
- Supports managing and enabling/disabling MCP Servers from Settings.
- MCP tools are integrated into Cyrene's tool registry, Action Gate, and Execution Policy.
- Actual stability of third-party MCP Servers depends on their own implementations.

#### 📱 External Channels

- **Feishu / Lark** — Connects through the official SDK and WebSocket long connection without requiring a public server or tunneling.
- **WeChat iLink** — Supports long-poll message receiving, text sending, and partial media processing.
- **Unified Character Across Channels** — Desktop, Feishu, and WeChat share the same character design, memory, and conversation capabilities.
- **Channel-Specific Style** — Mobile and desktop chat can use different expression styles.

#### ✨ Skill System

- Supports built-in Skills and user-defined Skills.
- A user Skill with the same name can fully override the built-in version.
- Supports `invoke_skill`, reference reading, and Slash Commands.
- Includes path protection, repeated-read restrictions, and large-text truncation.

#### 🌙 Proactive Chat

- **Status Awareness** — Evaluates time, user activity, conversation state, and character mood before initiating a conversation.
- **Do-Not-Disturb Policy** — Reduces or stops proactive messages late at night, while the user is already chatting, or after repeated unanswered messages.
- **Multi-Channel Delivery** — Desktop, WeChat, or Feishu can be selected as the destination.
- **Channel Failure Protection** — If the selected mobile channel is unavailable, delivery is canceled rather than silently redirected to desktop.

</details>

---

<details>
<summary><b>🔧 Development Features</b> (click to expand)</summary>

#### 🧪 Unit Tests

- Vitest 4 covers core modules including ASR, TTS, channels, chats, game-bot, memory, opener, orchestrator, RAG, scheduler, and Skills.
- Use `npm test` for a one-time run or `npm run test:watch` for watch mode.

#### 🎬 Scenario Simulation

- Use `npm run sim` for the default scenario, or `sim:coffee`, `sim:mix`, and `sim:rescue` for individual scenario debugging.
- Run `npm run sim:sweep --rewardGain=3,5,7,10` to sweep Worldbook scoring parameters.
- Output is written to `sim-result/`.

#### 🔧 Developer Experience

- Unified IPC bus: `shared/ipc-channels.ts` defines more than 90 channel constants.
- Runtime-state preview: Settings displays live previews of mood, status, and related text.
- Embedding hot switching: Automatically detects incompatible dimensions and clears outdated indexes.
- File watching and hot reload: Runtime reloading for Worldbook and other watched files through mechanisms such as `watchWorldbookFile`.

</details>

---

## 🧱 Technology Stack

| Layer | Technologies |
|---|---|
| Runtime | Node.js 24 LTS + Electron 43 |
| Language | TypeScript 5 |
| Build Tool | Vite 5 |
| UI Rendering | HTML / CSS + Pixi.js 7 + Chart.js |
| Live2D | `pixi-live2d-display` 0.5.0-beta + Cubism Core |
| Agent Workflow | LangGraph + Structured Output + Native Function Calling |
| Agent Event Protocol | `@ag-ui/core`, `@ag-ui/client` |
| Tool Extensions | `@modelcontextprotocol/sdk` |
| Memory and Retrieval | Embedding (`@xenova/transformers`) + BM25 + self-developed Cross-Encoder Reranker + self-developed indexing pipeline |
| Chinese Retrieval | `@node-rs/jieba` |
| Browser and Desktop Automation | Playwright + `@nut-tree-fork/nut-js` |
| Voice and Media | TTS / ASR + `silk-wasm` |
| Native Screenshot Helper | Rust + DXGI Desktop Duplication / Direct2D / GDI + WIC PNG + NDJSON IPC |
| Self-Developed Core | CITA, Action Gate, DMAE Worldbook, unified Structured Output Pipeline |
| External Channels | Feishu OpenAPI, WeChat iLink |
| Documents and Email | ExcelJS, docx, PDFKit, Nodemailer |
| Testing | Vitest 4 |

---

## 📦 Project Structure

```text
models/                # Local AI models placed by the user; see MODEL_LICENSE.md
├── Xenova/
│   └── bge-m3/       # Embedding model for sticker semantics and scene detection (~570 MB)
│       ├── tokenizer.json
│       ├── config.json
│       └── onnx/model_quantized.onnx
├── bge-reranker-base/       # Standard reranking model (~279 MB, optional)
└── ms-marco-MiniLM-L-6-v2/  # Lightweight reranking model (~23 MB, optional)

src/
├── main/             # Electron main process
│   ├── asr/          # Speech recognition (Alibaba Cloud real-time ASR)
│   ├── call/         # Voice-call core (ASR -> Agent -> TTS turns)
│   ├── channels/     # External channel adapters (Feishu / WeChat iLink / ...)
│   ├── chat/         # Chat support (image handling / think filtering / sending policy)
│   ├── chats/        # Multi-conversation history and persistence
│   ├── cita/         # CITA context-understanding and recommendation engine
│   ├── game-bot/     # Game automation driven by game recipes
│   ├── memory/       # L0/L1/L2 memory engine and entity relationship graph
│   ├── music/        # Music companion features (playback / recommendations / sessions)
│   ├── orchestrator/ # Agent loop, tool scheduling, and Action Gate
│   ├── proactive/    # Proactive chat: model / policy / routing / service
│   ├── rag/          # Retrieval-augmented generation and Worldbook injection
│   ├── relationship/ # User relationship profile
│   ├── scheduler/    # Scheduled tasks (reminders / calendar)
│   ├── sim/          # Scenario simulation tools
│   ├── skills/       # Agent Skill system
│   ├── social-context/  # Social-context extraction and injection
│   ├── sticker-*.ts  # Semantic sticker matching (protocol / storage / description / embedder)
│   ├── sync-mcp-builtin.ts  # Built-in MCP synchronization (Playwright / Feishu, etc.)
│   └── tts/          # Speech synthesis (multiple engines)
├── preload/          # Electron Preload bridge
├── renderer/         # Vite renderer
│   ├── call/         # Voice-call window
│   ├── chat/         # Main chat interface
│   ├── live2d/       # Live2D model rendering
│   ├── public/       # Tracked static source assets (audio / avatars / Cubism Core / stickers)
│   ├── settings/     # Settings center
│   ├── sidebar/      # Sidebar
│   ├── sticker-manager/  # Sticker management
│   ├── tasks/        # Task panel
│   ├── types/        # Shared type definitions
│   └── ui/           # Shared UI components (modal / theme / chart, etc.)
└── shared/           # Code shared between the main and renderer processes

dist/renderer/        # Vite output (generated files ignored; product assets tracked)
├── assets/           # Bundled JS/CSS (generated, ignored)
├── audio/            # Audio assets (tracked)
├── avatars/          # Avatar images (tracked)
├── call/ chat/ settings/ sidebar/ sticker-manager/ tasks/  # HTML entry points (generated, ignored)
├── icons/            # Icons (tracked)
├── models/cyrene/    # Live2D model; see MODEL_LICENSE.md (tracked)
└── stickers/         # Sticker images (tracked)
```

> `dist/renderer/assets/`, `dist/renderer/*/index.html`, and `dist/renderer/live2dcubismcore.min.js` are generated Vite build outputs and are not tracked by Git.  
> `audio/`, `avatars/`, `icons/`, `models/`, and `stickers/` are product assets and are tracked.  
> Static source assets are located in `src/renderer/public/`. Run `npm run build:renderer` to regenerate the build output.

---

## ⚠️ Disclaimer

This project is an **unofficial fan-made work** and has **no affiliation with, endorsement by, or sponsorship from HoYoverse / miHoYo**.

_Honkai: Star Rail_, Cyrene, and all related artwork, lore, trademarks, and intellectual property belong to **HoYoverse / miHoYo**.

**License scope:**

- The **source code** is licensed under the [MIT License](./LICENSE), which applies only to the source code in this repository.
- **Character IP, the Live2D model, and artwork assets** are not covered by the MIT License. They are governed separately by [MODEL_LICENSE.md](./MODEL_LICENSE.md) and HoYoverse's fan-creation guidelines.
- Derivative works that include Cyrene IP, the Live2D model, or related artwork from this project **must not be used commercially**, including sale, paid communities, advertising monetization, or bundled resale.

---

## 📄 License

The **source code** in this repository is licensed under the [MIT License](./LICENSE), Copyright (c) 2026 Playa.

The MIT License applies only to the source code in this repository. It does not apply to the character, Live2D model, or artwork assets.

Character IP, the Cyrene Live2D model (`models/cyrene/`), and artwork assets are governed by their respective permissions:

- **Live2D Model** — See [MODEL_LICENSE.md](./MODEL_LICENSE.md). The model creator, [@是依七哒](https://space.bilibili.com/457683484), has authorized its use, modification, and redistribution.
- **Character IP / Artwork** — Belongs to **HoYoverse / miHoYo**.

---

## 🙏 Acknowledgements

- **Cyrene Character**: © HoYoverse / miHoYo
- **Live2D Model**: Created by [@是依七哒](https://space.bilibili.com/457683484) — see [MODEL_LICENSE.md](./MODEL_LICENSE.md)
- **Live2D Cubism SDK**: © Live2D Cubism

Special thanks to the original model creator for generously authorizing this project to use, modify, and redistribute the work.

---

## 💌 Contact

GitHub Issues and pull requests are welcome. Please keep discussions respectful and relevant to the project.

---

⭐ If you like this project, consider giving it a Star. It helps more Cyrene fans discover it.
