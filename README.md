<div align="center">

<img src="./preview.png" alt="Cyrene Agent" width="800">

# Cyrene-Agent

[English](./README.en.md) | **中文**

</div>

**Cyrene-Agent 是一个以《崩坏：星穹铁道》昔涟为核心角色的 Windows Live2D AI 桌面伴侣。**

> 基于 Electron + TypeScript 开发的桌面端 Live2D 智能对话 Agent。  
> 项目围绕昔涟（Cyrene）的角色设定，结合自研 DMAE 记忆引擎，  
> 将角色化聊天、个性化记忆、语音交互、工具调用与多平台接入整合在同一个桌面 Agent 中，  
> 同时支持日常聊天（Chat）与辅助工作（Work）两种模式。

---

## ✨ 速览

- 🌸 **趣味桌面陪伴** — Live2D 角色常驻桌面，支持表情、动作、状态、心情、气泡互动与智能表情包
- 💬 **日常聊天（Chat）** — 专注角色化交流，结合会话历史、用户风格与长期记忆自然回应
- 🛠️ **辅助工作（Work）** — 通过完整 Agent 工作流理解请求、调用工具，并根据真实执行结果回复
- 🧠 **个性化记忆** — L0 / L1 / L2 分层记忆，结合自研 DMAE Worldbook 沉淀长期互动
- 🔊 **语音交互** — 集成 TTS、ASR 与语音通话，让昔涟能够听见并回应用户
- 🧰 **丰富工具生态** — 覆盖联网搜索、文件处理、文档生成、生活服务、音乐与 MCP 扩展
- 🔌 **多模型厂商适配** — 针对不同厂商提供分级 Structured Output 与 Function Calling 兼容方案
- 🎨 **个性化外观** — 支持多套界面风格、主题外观与聊天字体选择
- 📱 **多平台接入** — 支持桌面端、飞书与微信 iLink，共享角色能力与对话体验
- 🌙 **主动聊天** — 根据时间、状态与用户偏好主动发起交流，并支持多渠道定向投递

---

## 🚀 快速开始

### 前置条件

- **Windows 10 / 11 64 位**
- **Node.js 24 LTS**
- **npm 10+**（推荐 npm 11）
- **[Rust stable](https://www.rust-lang.org/tools/install)**（源码构建截图功能必需）
- **[Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)**

安装 Visual Studio Build Tools 时，请勾选：

- **使用 C++ 的桌面开发**
- **MSVC v143**
- **Windows 10 / 11 SDK**

安装 Rust 后，建议确认使用 MSVC 工具链：

```powershell
rustup default stable-x86_64-pc-windows-msvc
```

> 飞书、微信 iLink、`nut-js` 键鼠自动化及原生截图功能依赖 Windows 环境。
>
> 如果直接安装 Releases 中的打包版本，无需另外安装 Rust 和 Visual Studio Build Tools。

### 1. 克隆项目

```bash
git clone https://github.com/Playa-0v0/Cyrene-Agent.git
cd Cyrene-Agent
```

### 2. 安装依赖

推荐使用锁定版本安装：

```bash
npm ci
```

也可以使用：

```bash
npm install
```

首次安装会下载 Electron、Pixi.js、Live2D 等相关依赖，具体耗时取决于网络环境。

### 3. 安装 BGE-M3（推荐）

Cyrene 无需本地大语言模型即可正常聊天，但建议安装 **BGE-M3 Embedding 模型**，以获得更完整的语义增强体验：

- 贴纸语义匹配
- 场景语气增强
- Worldbook 语义检索
- RAG检索

[前往 Releases 下载 BGE-M3](https://github.com/Playa-0v0/Cyrene-Agent/releases)

> [!IMPORTANT]
>
> 未安装 BGE-M3 不会影响基础聊天，依赖 Embedding 的增强功能会自动关闭或降级。

### 4. 音乐功能（可选）

音乐工具基于 [Code-MonkeyZhang/cloud-music-mcp](https://github.com/Code-MonkeyZhang/cloud-music-mcp) 集成。如需使用网易云音乐功能，需额外安装：

- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — Python 包管理器，首次运行音乐工具时会自动下载 Python 并安装依赖
- **[网易云音乐桌面客户端](https://music.163.com/)** — 用于播放歌曲，需注册 `orpheus://` 协议

> [!NOTE]
>
> 音乐功能为可选组件，不影响聊天及其他核心功能。未安装 `uv` 时，音乐工具会自动跳过并在界面中提示。

### 5. 构建并启动

首次从源码运行时，需要先构建 Rust 原生截图助手：

```bash
npm run build:screenshot-helper
npm run build
npm start
```

> [!IMPORTANT]
>
> 原生截图助手不会以 `.exe` 形式提交到 Git 仓库，因此首次克隆后必须执行一次 `npm run build:screenshot-helper`。

开发模式：

```bash
npm run build:screenshot-helper
npm run dev
```

修改 Rust 截图助手代码后，需要重新执行：

```bash
npm run build:screenshot-helper
```

构建 Windows 可分发版本：

```bash
npm run package:win:dir
```

打包命令会自动构建 Electron 应用和 Rust 截图助手。

---

## 🔑 配置 API Key

应用启动后，**点击系统托盘图标 → 打开设置**，完成以下基础配置：

1. **🔑 模型设置**：选择 LLM 厂商预设，填写 API Key、Base URL 与模型名称。  
   这是 Cyrene 正常聊天和运行 Agent 的必要配置。

2. **🎙️ TTS 设置**（可选）：选择 Mossland、MiniMax、MiMo、GPT-SoVITS 或自定义云端语音合成服务。

3. **🎧 ASR 设置**（可选）：如需使用语音通话，配置阿里云实时 ASR 的 AppKey 与 AccessKey。

4. **📱 外部渠道**（可选）：根据需要连接飞书或微信 iLink，在手机端与 Cyrene 对话。

相关配置会保存在应用的 `<userData>/` 目录中，修改后通常无需重启应用。

---

## 📊 当前状态

| 模块 | 状态 | 说明 |
| --- | :---: | --- |
| 🌸 Live2D 桌面陪伴 | ✅ 可用 | 支持桌宠置顶、多窗口、表情动作、心情状态、气泡互动与智能表情包 |
| 💬 日常聊天（Chat） | ✅ 可用 | 独立角色聊天流程，不暴露或执行工具，结合近期消息、社交上下文与用户风格生成回复 |
| 🛠️ 辅助工作（Work） | ✅ 可用 | 完整 Agent 工作流：CITA → Action Gate → Native FC → Execution Policy → Tool Runtime → Soul |
| 🧠 个性化记忆 | ✅ 可用 | L0 / L1 / L2 分层记忆、自研 DMAE Worldbook、关系画像与长期互动沉淀 |
| 🔊 语音交互 | ✅ 可用 | 支持多 TTS 引擎、实时 ASR、语音通话与 VAD 静默检测，部分功能需要额外配置 |
| 🧰 内置工具 | ✅ 可用 | 支持联网搜索、网页读取、文件操作、文档生成、生活服务、音乐等工具 |
| 🔌 多模型厂商适配 | ✅ 可用 | 根据厂商能力使用 A / B / M / D 分级 Structured Output 与 Function Calling Profile |
| ✨ Skill 系统 | ✅ 可用 | 支持内置 Skill、用户自定义 Skill、Slash 命令与参考资料读取 |
| 📚 RAG 文档知识库 | 🧪 实验性 | 支持多格式文档导入、向量与 BM25 混合检索、Reranker 和来源追溯 |
| 🔌 MCP 扩展生态 | 🧪 实验性 | 支持 stdio、SSE 与 HTTP Transport，实际兼容性取决于第三方 MCP Server |
| 📱 飞书 Lark | ✅ 可用 | 支持长连接消息接入与多种媒体类型 |
| 📱 微信 iLink | 🧪 实验性 | 支持长轮询消息收发、媒体处理与手机端对话 |
| 🌙 主动聊天 | 🧪 实验性 | 支持状态判断、不打扰策略与桌面、飞书、微信多渠道投递 |

> ✅ **可用**：核心流程已经实现，可用于日常体验。  
> 🧪 **实验性**：功能已经接入，但兼容性、边界情况或使用体验仍在持续完善。

---

## ❓ 常见问题

### 本地 AI 模型


### 是否支持本地大模型和其他第三方模型平台？

Cyrene 对本地模型、自定义端点及未列入兼容性名单的第三方模型平台，仅提供基础的通用兼容与容错处理。

由于这些端点尚未经过完整 Work 流程实测，因此：

- 不保证能够稳定运行
- 不保证 Structured Output 与 Function Calling 能力可用
- 不保证能够完成完整 Agent 工具链
- 暂不提供相关配置、兼容性问题与错误排查的技术解答

未知模型、本地模型与自定义端点会默认使用通用 **D 档**运行，实际兼容性需要用户自行测试。

> [!NOTE]
>
> Cyrene 目前由个人独立开发，时间、设备和 API 测试成本有限。现阶段仅对项目明确适配并完成验证的主要模型厂商提供兼容性维护与技术解答，未来会根据项目进度逐步扩展测试范围。

当前重点适配的模型厂商包括：

- 豆包 Seed
- Kimi
- DeepSeek
- Qwen
- GLM
- MiMo
- MiniMax
- OpenAI
- Anthropic

不同厂商和具体型号的验证状态并不相同，请以项目内的模型兼容性表及实测报告为准。

> BGE-M3、`ms-marco-MiniLM-L-6-v2` 与 `bge-reranker-base` 是项目使用的本地 Embedding / Reranker 增强模型，不属于用于聊天的本地大语言模型。

### API Key 安全吗？

> [!WARNING]
>
> 当前版本不建议在共享电脑或其他不可信环境中运行。

LLM、独立视觉模型、ASR、TTS 及其他第三方服务的凭据会保存在应用的 `<userData>/` 目录中：

- `<userData>/model-settings.json`：LLM 与视觉模型配置（明文）
- `<userData>/app-settings.json`：ASR、TTS、地图、搜索、邮件等配置（明文）
- `<userData>/weixin/credentials.json`：微信 iLink Bot 凭据（明文）
- `<userData>/mcp-servers.json`：MCP server 配置，含 `env` 环境变量（明文）
- `<userData>/channels-settings.json`：飞书 `appSecret` / `verificationToken` / `encryptKey`（safeStorage 加密）
- `<userData>/music/netease/account.enc`：网易云音乐登录 Cookie（safeStorage 加密）

目前大部分凭据仍以明文形式保存在本地文件中，主要依赖操作系统的用户目录权限进行保护。

飞书渠道凭据与网易云音乐登录 Cookie 使用 Electron `safeStorage` 加密：

- Windows：DPAPI
- macOS：Keychain
- Linux：libsecret
- 系统密钥环不可用时会回退至较弱的本地混淆方案

请勿分享或上传 `<userData>/`、设置文件及日志文件，也不要将其同步到公共云盘或提交到 Git 仓库。

如需清除凭据与应用配置，可以删除以下文件后重启：

```text
<userData>/model-settings.json
<userData>/app-settings.json
<userData>/weixin/credentials.json
<userData>/mcp-servers.json
<userData>/channels-settings.json
<userData>/music/netease/account.enc
```

### macOS / Linux 可以运行吗？

Cyrene 当前以 **Windows 10 / 11** 为主要开发和测试平台。

| 平台 | 状态 | 说明 |
|---|:---:|---|
| Windows 10 / 11 | ✅ 已实测 | 主要支持平台 |
| macOS | ⚠️ 未完整验证 | Electron 主体理论可运行，但透明窗口、鼠标穿透与窗口层级可能存在兼容问题 |
| Linux | ⚠️ 未完整验证 | 桌面环境与系统密钥环差异可能影响部分功能 |

`game-bot` 使用的 `nut.js` 包含原生依赖，目前仅在 Windows 上完成端到端验证。

如在 macOS 或 Linux 上遇到兼容问题，欢迎通过 GitHub Issue 提交运行环境、错误日志和复现步骤。

### 出现 OOM 或内存占用过高怎么办？

可以依次尝试：

1. **关闭 Reranker**  
   设置 -> 昔涟设置 -> RAG / 文档导入 -> 将 Reranker 模式设为 none

2. **关闭暂时不用的 MCP 服务**  
   Playwright 等浏览器自动化服务可能启动额外的 Chromium 进程。

3. **减少大型 RAG 文档**  
   删除暂时不需要的知识库文件，降低索引和检索负担。

4. **关闭不使用的窗口和后台任务**  
   长时间运行的工具任务、语音服务和多会话可能持续占用资源。

5. **重启应用**  
   可以释放模型、索引、浏览器子进程和长期运行任务占用的内存。

Embedding 索引已采用后台 Worker、批处理和缓存机制，以降低文档导入时的内存峰值。

如果仍然频繁出现 OOM，可以在开发模式下使用 Chrome DevTools Memory Profiler 获取 Heap Snapshot，并在提交 Issue 时附上复现步骤与相关日志。

---

## ✨ 功能

### 核心功能

#### 🌸 桌面陪伴

- **Live2D 桌面角色** — 基于 `pixi-live2d-display` 与 Cubism Core 渲染，支持桌面置顶、鼠标交互、自然待机与嘴型同步。
- **表情与动作联动** — 根据对话内容触发表情、动作、状态、心情与桌面气泡，让角色反馈不只停留在文字层面。
- **智能表情包** — 内置贴纸面板，并可通过语义匹配自动选择符合当前语境的表情包。
- **多窗口交互** — 桌宠、聊天、设置、任务、通话和贴纸管理等界面相互独立，又共享统一运行状态。
- **个性化外观** — 支持界面主题、聊天样式与字体选择。

#### 💬 日常聊天（Chat）

- **独立角色聊天流程** — Chat 模式专注于角色化交流，不暴露、不调用也不执行任何工具。
- **人格化回复** — 结合昔涟角色设定、近期会话、社交上下文、用户风格与个性化记忆生成回复。
- **多会话历史** — 不同会话独立保存，可自动生成标题、排序和重命名。
- **多端聊天风格** — 桌面聊天、手机渠道和语音通话可使用不同的表达风格。
- **回复分段** — 可选择「全部分段 / 仅 Chat 分段 / 关闭」，长回复能够按语义拆分为多个聊天气泡。

#### 🛠️ 辅助工作（Work）

- **完整 Agent 工作流** - 使用以下可信执行链路处理工具任务：

```text
用户请求
  ↓
CITA 上下文理解
  ↓
Action Gate 行动决策
  ↓
Native Function Calling 参数生成
  ↓
Execution Policy 权限与风险检查
  ↓
Tool Runtime 工具执行
  ↓
RouteAfterTool ──┬── 失败 / 需复规划 → 回到 Action Gate 重试
                  └── 成功 → 继续
  ↓
Soul 根据真实结果回复
```

- **本地可信校验** - 模型输出必须通过格式、Schema 与业务可信校验，模型本身不是最终信任边界。
- **失败安全降级** - Action Gate、Native FC 或执行策略任意阶段不可信时，均禁止执行工具，并由 Soul 根据本地失败事实诚实回复。
- **多模型厂商适配** - 根据厂商能力自动选择 A / B / M / D Structured Output Profile，并统一处理 reasoning、JSON 提取、Repair 与失败路由。
- **AG-UI 事件流** - 统一传递文本、工具调用、执行状态和最终结果，支持逐字流式输出与工具卡片展示。

#### 📝 富文本与代码渲染

- **Markdown 渲染** — 支持标题、列表、引用、表格、链接、代码块等常见 Markdown 内容。
- **代码高亮** — 支持多种常用编程语言的代码块语法高亮和代码复制。
- **数学公式** — 支持行内公式与块级公式渲染。
- **流式兼容** — 生成过程中保持稳定输出，消息完成后再渲染为完整富文本内容。

#### 🧠 个性化记忆

- **L0 / L1 / L2 分层记忆** — 分别管理核心用户画像、近期状态和长期经历。
- **记忆证据链** — 记忆内容保留来源与上下文，减少无依据的画像推断。
- **冲突检测与解决** — 对旧记忆与新信息进行召回、评分和语义判断，区分语境变化、偏好演变与直接冲突。
- **自研 DMAE Worldbook** — 通过触发词、优先级、内在价值、连带触发与 Active / Dormant / Archived 状态管理角色知识和长期互动内容。
- **关系与风格沉淀** — 根据长期交互逐步形成用户偏好、交流习惯与关系上下文。

#### 🔊 语音交互

- **多 TTS 引擎** — 支持 Mossland、MiniMax、MiMo、GPT-SoVITS 与自定义云端语音服务。
- **实时 ASR** — 支持阿里云实时语音识别，将麦克风音频转为对话输入。
- **完整语音通话** — 通过 `LISTENING → THINKING → SPEAKING` 状态流完成连续语音交流。
- **VAD 静默检测** — 自动判断用户是否结束说话并触发回复。

#### 🧰 工具生态

Cyrene 内置和扩展的工具较多，主要覆盖以下类别：

- **文档与办公** — 生成 Word、Excel、PDF 和 Markdown 文档。
- **联网能力** — 网页搜索、网页读取、内容提取和信息整理。
- **文件处理** — 读取、写入、浏览本地文件及识别图片内容。
- **生活服务** — 天气、地图、翻译、汇率、记账和行程规划等。
- **音乐能力** — 搜索歌曲、获取推荐并调用本地音乐客户端播放。
- **任务协作** — 任务清单、用户选择卡片、任务委派与子任务处理。
- **MCP 扩展** — 通过 Model Context Protocol 接入额外的外部工具与服务。

<details>
<summary><b>🧩 高级功能</b>（点击展开）</summary>

#### 📚 RAG 文档知识库

- 支持 `txt`、`md`、`pdf`、`docx`、`xlsx`、`pptx`、`csv`、`json` 等格式导入。
- 支持向量检索、BM25 与 Reranker 组成的混合检索流程。
- 支持本地 Embedding 与 OpenAI-compatible 云端 Embedding。
- 检索结果保留来源信息，方便追溯原始文档。
- 支持实体关系信息与自定义分词词典。

#### 🔌 MCP（Model Context Protocol）

- 支持 `stdio`、SSE 与 HTTP Transport。
- 支持在设置页面管理和启停 MCP Server。
- MCP 工具会统一接入 Cyrene 的工具注册、Action Gate 与 Execution Policy。
- 第三方 MCP Server 的实际稳定性取决于其自身实现。

#### 📱 外部渠道

- **飞书 Lark** — 通过官方 SDK 和 WebSocket 长连接接入，无需公网服务器或内网穿透。
- **微信 iLink** — 支持长轮询消息接收、文本发送和部分媒体处理。
- **多渠道统一人格** — 桌面端、飞书与微信共享角色设定、记忆和会话能力。
- **渠道独立风格** — 可针对手机聊天与桌面聊天使用不同表达方式。

#### ✨ Skill 系统

- 支持内置 Skill 与用户自定义 Skill。
- 用户目录中的同名 Skill 可以整体覆盖内置版本。
- 支持 `invoke_skill`、参考资料读取与 Slash Command。
- 包含路径防护、重复读取限制与大文本截断机制。

#### 🌙 主动聊天

- **状态感知** — 根据时间、用户活跃状态、会话状态和角色心情判断是否适合主动交流。
- **不打扰策略** — 深夜、用户正在聊天或连续未回应时降低或停止主动消息。
- **多渠道投递** — 可选择桌面、微信或飞书作为主动消息目标。
- **渠道失败保护** — 指定手机渠道不可用时取消发送，不会擅自改投桌面端。

</details>

---

<details>
<summary><b>🔧 开发功能</b>（点击展开）</summary>

#### 🧪 单元测试
- Vitest 4 覆盖 asr / tts / channels / chats / game-bot / memory /
  opener / orchestrator / rag / scheduler / skills 等核心模块。
- `npm test` 一次性 / `npm run test:watch` 监听模式。

#### 🎬 场景模拟
- `npm run sim` 默认场景 / `sim:coffee` / `sim:mix` / `sim:rescue` 单场景调试。
- `npm run sim:sweep --rewardGain=3,5,7,10` 跑 Worldbook 评分参数 sweep。
- 产物输出到 `sim-result/`。

#### 🔧 开发者体验
- 统一 IPC 总线：`shared/ipc-channels.ts` 定义 90+ 通道常量。
- 运行时状态 preview：设置面板实时预览情绪 / 状态文案。
- Embedding 模型热切换：自动检测维度不匹配并清空旧库。
- 文件监视 / 热更新：`watchWorldbookFile` 等运行时热加载。

</details>

---

## 🧱 技术栈

| 层级 | 技术 |
|---|---|
| 运行环境 | Node.js 24 LTS + Electron 43 |
| 开发语言 | TypeScript 5 |
| 构建工具 | Vite 5 |
| 界面渲染 | HTML / CSS + Pixi.js 7 + Chart.js |
| Live2D | `pixi-live2d-display` 0.5.0-beta + Cubism Core |
| Agent 工作流 | LangGraph + Structured Output + Native Function Calling |
| Agent 事件协议 | `@ag-ui/core`、`@ag-ui/client` |
| 工具扩展 | `@modelcontextprotocol/sdk` |
| 记忆与检索 | Embedding（`@xenova/transformers`）+ BM25 + 自研 Cross-Encoder Reranker + 自研索引管线 |
| 中文检索 | `@node-rs/jieba` |
| 浏览器与桌面自动化 | Playwright + `@nut-tree-fork/nut-js` |
| 语音与媒体 | TTS / ASR + `silk-wasm` |
| 原生截图助手 | Rust + DXGI Desktop Duplication / Direct2D / GDI + WIC PNG + NDJSON IPC |
| 自研核心 | CITA、Action Gate、DMAE Worldbook、统一 Structured Output Pipeline |
| 外部渠道 | 飞书 OpenAPI、微信 iLink |
| 文档与邮件 | ExcelJS、docx、PDFKit、Nodemailer |
| 测试 | Vitest 4 |

---

## 📦 项目结构

```
models/                # 本机 AI 模型（用户放置，见 MODEL_LICENSE.md）
├── Xenova/
│   └── bge-m3/       # Embedding 模型（贴纸语义 + 场景识别，~570MB）
│       ├── tokenizer.json
│       ├── config.json
│       └── onnx/model_quantized.onnx
├── bge-reranker-base/  # 标准排序模型（~279MB，可选）
└── ms-marco-MiniLM-L-6-v2/  # 轻量排序模型（~23MB，可选）

src/
├── main/             # Electron 主进程
│   ├── asr/          # 语音识别（阿里云实时 ASR）
│   ├── call/         # 语音通话核心逻辑（ASR -> agent -> TTS 轮次）
│   ├── channels/     # 外部渠道适配层（飞书 / 微信 iLink / ...）
│   ├── chat/         # 聊天附属（图片处理 / think 过滤 / 发送策略）
│   ├── chats/        # 多会话历史与持久化
│   ├── cita/         # CITA 上下文理解与建议引擎
│   ├── game-bot/     # 游戏自动化（game-recipes 驱动）
│   ├── memory/       # L0/L1/L2 记忆引擎 + 实体关系图
│   ├── music/        # 音乐陪伴（播放 / 推荐 / 会话）
│   ├── orchestrator/ # Agent 主循环 + 工具调度 + Action Gate
│   ├── proactive/    # 主动对话：模型 / 策略 / 路由 / 服务
│   ├── rag/          # 检索增强生成 + worldbook 注入
│   ├── relationship/ # 用户关系画像
│   ├── scheduler/    # 定时任务（提醒 / 日程）
│   ├── sim/          # 场景模拟工具
│   ├── skills/       # Agent skill 系统
│   ├── social-context/  # 社交上下文抽取与注入
│   ├── sticker-*.ts  # 贴纸语义匹配（协议 / 存储 / 描述 / embedder）
│   ├── sync-mcp-builtin.ts  # 内置 MCP 同步（Playwright / 飞书等）
│   └── tts/          # 语音合成（多引擎）
├── preload/          # Electron preload 桥接
├── renderer/         # Vite 渲染层
│   ├── call/         # 语音通话窗口
│   ├── chat/         # 主聊天界面
│   ├── live2d/       # Live2D 模型渲染逻辑
│   ├── public/       # 静态资源源文件（音频 / 头像 / Cubism Core / 贴纸，已跟踪）
│   ├── settings/     # 设置中心
│   ├── sidebar/      # 侧边栏
│   ├── sticker-manager/  # 贴纸管理
│   ├── tasks/        # 任务面板
│   ├── types/        # 共享类型定义
│   └── ui/           # 通用 UI 组件（modal / theme / chart 等）
└── shared/           # 主进程与渲染进程共享代码

dist/renderer/        # Vite 构建产物（构建产物 gitignore，产品资源已跟踪）
├── assets/           # 打包后的 JS/CSS（构建产物，gitignore）
├── audio/            # 音频资源（已跟踪）
├── avatars/          # 头像图片（已跟踪）
├── call/ chat/ settings/ sidebar/ sticker-manager/ tasks/   # HTML 入口（构建产物，gitignore）
├── icons/            # 图标（已跟踪）
├── models/cyrene/    # Live2D 模型 - 见 MODEL_LICENSE.md（已跟踪）
└── stickers/         # 贴纸图片资源（已跟踪）
```

> dist/renderer/assets/、dist/renderer/*/index.html、 dist/renderer/live2dcubismcore.min.js 为 Vite 构建产物
> 不在 git 跟踪范围内。 audio/、avatars/、icons/、models/、stickers/ 为产品资源，已纳入 git。
> 静态资源源文件见 src/renderer/public/。 运行 npm run build:renderer 重新生成构建产物。

---

## ⚠️ 免责声明

本项目为**非官方粉丝同人作品**，与 HoYoverse / 米哈游**无任何关联、
背书或赞助关系**。

《崩坏：星穹铁道》、"昔涟"角色及其相关美术，世界观、商标等知识产权
归 **HoYoverse / 米哈游**所有。

**关于授权范围的说明**：

- **源代码**采用 [MIT License](./LICENSE)，仅约束本仓库的源代码。
- **角色 IP、Live2D 模型、美术资产** 不属于 MIT 授权范围，分别遵循
  [MODEL_LICENSE.md](./MODEL_LICENSE.md) 与米哈游同人创作规范处理。
- 因底层角色 IP 涉及米哈游同人创作规范，**本项目内包含昔涟 IP、Live2D 模型和美术资产的衍生物禁止商业使用。**（售卖、付费社群、含广告变现、打包销售等）。

---

## 📄 许可证

本仓库的**源代码**遵循 [MIT License](./LICENSE)，Copyright (c) 2026 Playa。
MIT 仅约束本仓库的源代码，不适用于角色、Live2D 模型与美术资产。

角色 IP（《崩坏：星穹铁道》"昔涟" 等）、Live2D 模型（`models/cyrene/`）、
美术资产遵循各自对应的授权：

- **Live2D 模型** — 详见 [MODEL_LICENSE.md](./MODEL_LICENSE.md)，
  模型作者 [@是依七哒](https://space.bilibili.com/457683484) 授权使用、
  修改，再分发。
- **角色 IP / 美术** — 归 **HoYoverse / 米哈游**所有。

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

---

⭐ 如果你喜欢这个项目，欢迎点一个 Star。这会帮助更多喜欢昔涟的人发现它。
