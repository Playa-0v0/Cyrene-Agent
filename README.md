<div align="center">

# Cyrene-Agent

[English](./README.en.md) | **中文**

> Live2D 桌面智能伴侣 (Electron + TS) — Cyrene from Honkai: Star Rail.

基于 Electron + TypeScript 开发的桌面端 Live2D 智能对话 Agent，
搭载《崩坏：星穹铁道》昔涟（Cyrene）人设，支持日常聊天、情感交互
与个性化记忆引擎。

---

</div>

<div align="center">

## ⚠️ 免责声明

</div>

本项目为**非官方粉丝同人作品**，与 HoYoverse / 米哈游**无任何关联、
背书或赞助关系**。

《崩坏：星穹铁道》、"昔涟"角色及其相关美术、世界观、商标等知识产权
归 **HoYoverse / 米哈游**所有。

本项目以 MIT 协议发布，**仅供个人非商用使用**。根据米哈游同人创作
规范，任何商业用途均**严格禁止**。

---

## ✨ 功能

### 🪟 桌面伴侣
- **Live2D 桌宠** — 基于 `pixi-live2d-display` + Cubism 引擎的置顶桌宠，
  支持表情切换、嘴型同步、点击交互与自然待机动画。
- **多窗口架构** — 7 个独立 BrowserWindow：主聊天、侧边栏、任务面板、
  设置、贴纸管理、语音通话、桌宠本体，各窗口互不干扰。
- **桌宠状态联动** — 桌宠显示「陪伴中/思考中/工作中/聆听中/提醒中」等
  状态与「平静/开心/温柔/激动/撒娇」等情绪，跟着对话实时变化。
- **窗口置顶 / 拖动 / 鼠标穿透** — 支持置顶 toggle、任意拖动、需要时
  鼠标穿透到下层窗口（不影响桌宠存在）。
- **托盘菜单** — 系统托盘右键快捷进入状态面板、设置、显示-隐藏桌宠、
  退出。
- **AG-UI 表情广播** — Agent 通过 `play_live2d_action` 工具把「表情 +
  动作 + 气泡」事件推到桌宠窗口，让桌宠随对话情绪同步表演。
- **一键缩放与可见性** — 设置面板可调桌宠大小、随时显示/隐藏，
  配合开机启动。

### 💬 对话
- **日常聊天** — 基于昔涟人设（system.md / identity.md / soul.md /
  canon_quotes.md）的自然对话 Agent，支持桌面/手机/通话三种人格风格切换。
- **AG-UI 事件流** — 标准化的 Agent 事件流（RUN_STARTED / TEXT_MESSAGE /
  TOOL_CALL / RUN_FINISHED），逐字 delta 流式渲染，体感接近实时回复。
- **多会话历史** — 每个会话独立 JSON 持久化（`<userData>/cyrene-chats/`），
  自动派生标题、按 `updatedAt` 排序、双击重命名，告别 localStorage 时代。
- **拖拽文件摄入** — 直接拖入 PDF/MD/TXT/DOCX/XLSX/PPTX/CSV/JSON 到聊天窗口，
  自动切块注入 RAG 知识库，文档可追溯。
- **TTS 朗读 + 一键复制** — 每条消息内嵌 SVG 图标，点击直接朗读或复制。
- **会话侧栏** — 右侧 rail 列出所有会话（新建/列表/空态），按时间倒序，
  30 s 轮询实时刷新。
- **用户选择卡片** — Agent 遇到歧义问题时弹出选择卡片（`ask_user_choice`），
  走 AGUI CUSTOM 事件，无需用户口述答案。
- **表情贴纸** — 内置贴纸选择器（small/standard/large 三档大小），
  AI 可自动按回复相似度匹配最合适的贴纸。
- **TTS 早播优化** — 流式输出期间提前合成首段音频播放，减少首字延迟。
- **语音通话** — 状态机 `IDLE → LISTENING → THINKING → SPEAKING → ENDED`，
  24 轮滑动窗口上下文，VAD 静默触发自动回复。
- **通话上下文持久** — 通话结束后 24 轮 × 2 条滑动窗口保留，下次重连可
  接续上下文。

### 🧠 记忆引擎
- **L0 核心画像** — 昵称、称呼、职业、长期兴趣、常用语言、备注；
  `isPinned` 字段锁定后 AI 不自动覆写。
- **L1 近期状态** — `recentGoals` / `recentPreferences` / `currentProject`
  短期画像，定期刷新。
- **L2 长期记忆** — `weight` (0-100)、`accessCount`、`status`
  (active/aging/archived/superseded/merged)、`conflictWith`、`evidenceIds`
  完整证据链，可单条删除/置顶/批量归档。
- **权重自动衰减** — 每轮 -1，平方加速 + `sqrt(intrinsicValue)` 阻力；
  weight 阈值 60/30/10 自动切换 active/aging/archived。
- **冲突检测与解决** — 本地词法候选 → RAG 召回 → 评分 → 队列 →
  resolver 解决；状态机 `candidate → pending → confirmed/dismissed/resolved`，
  解决类型覆盖「无关/语境差异/偏好演变/直接冲突/待确认」。
- **个性化召回** — `recall_history` 工具 + 每次 L2 召回自动
  `updateL2RecallStats(+1)`，`recent-injected-memory` 防重复注入。
- **DMAE Worldbook 引擎** — Markdown 词条格式（触发词/常驻/优先级/
  内在价值/连带触发词），`Ru = Bu × (1 + γ·ln(1+U_old))` 激活公式，
  Active/Dormant/Archived 三态状态机。
- **One-Shot 连带触发** — 1 层封顶 + userHit 拦截 + cascade 去重，
  让相关条目按因果链自动激活。
- **文档与知识导入 RAG** — 支持 txt/md/pdf/docx/xlsx/pptx/csv/json，
  导入后 `source: imported_doc` 可追溯，整片删除一键清理。
- **混合检索** — 向量 + BM25 + reranker 三档（light/standard/none），
  embedding 走本地 `@xenova/transformers` 或云端 OpenAI 兼容。
- **实体关系图谱** — jieba 词典注入防止「昔涟/小鹿」等被错误切分，
  注入 `【人物关系】` 段强化角色间关系记忆。
- **关系画像日志** — 每轮记录心情正则（疲惫/焦虑/低落/开心）+ `nextCareCue`
  下一次关怀钩子；日摘要压缩 + 90 天滚动窗口。

### 🛠 任务与工具
- **任务面板** — 今日日期 + 当前 token 用量 + 7 日 token 柱状图
  (Chart.js) + 今日定时任务列表，30 s 轮询 + scheduler 事件驱动刷新。
- **定时任务调度** — 单 timer 调度最近触发（`maxTimerDelay = 1h`），
  任务类型 `once` / `daily` / `weekly` / `interval`，错过重算
  `normalizeOverdueNextFireAt`，触发时给 agent 注入「我是定时任务」元数据。
- **文档生成工具** — `write_excel` (exceljs 多 sheet/公式/样式)、
  `write_word` (docx 段落/表格/标题/列表/页眉页脚/目录)、
  `write_pdf` (pdfkit 文本/表格/字体嵌入)、`write_markdown`。
- **文件 / Shell 工具** — `read_file` / `list_dir` / `write_file` /
  `read_image` (走 vision captioner 解析图片内容)。
- **联网 / 网页** — `fetch_url` (turndown HTML→Markdown)、
  `web_search` (搜索 + 抓取，playwright 兜底)。
- **生活小工具** — `record_expense` / `query_expense` 记账 + 汇总、
  `exchange_rate` 汇率、`translate` 翻译、`apply_patch` unified diff 应用、
  `plan_trip` 多日行程规划。
- **任务委派与询问** — `delegate_task` (sub-agent)、`todo_write`
  任务清单 + 状态栏、`ask_user_choice` 用户选择卡片。
- **Skill 系统** — 双源扫描（`prompts/skills/` 内置 + `<userData>/skills/`
  用户覆盖，目录级整体覆盖），Meta 工具 `invoke_skill` /
  `read_skill_reference`（含路径穿越防护 + 读重放拦截 + 大文本截断），
  支持 `/skill_id ...` slash 命令。
- **Game Bot 自动化** — `engine.ts` 步骤解释器支持 `launch / wait / key /
  click / vlm_click / vlm_select / vlm_check / branch` 等指令，配合
  GameRecipe 格式描述自动化流程，暴露为 `game_bot_start` 工具。
- **权限分级** — `ToolRiskLevel` (safe/caution/dangerous) 三档审批，
  危险操作弹窗确认。

### 🎨 主题与界面
- **多主题系统** — 珠光白、经典、季节限定多套主题，CSS variables 驱动，
  文本可读性达 WCAG-AA 标准。
- **侧边栏总览** — 📌 置顶 toggle、💬 打开聊天 / ⏰ 任务 / ⚙️ 设置 /
  🔑 切换模型 / 📞 通话一键直达，实时显示在线/离线 + 状态 emoji +
  情绪 emoji + 当前模型 displayName。
- **聊天窗** — 消息流、附件气泡、sticker 嵌入、todo 状态条、weather 气泡、
  ask_user_choice 卡片、AG-UI 流式 delta、复制/朗读 SVG、history rail、
  sticker picker、min/max/close 完整生命周期。
- **任务面板** — 含 Chart.js 7 日柱状图、日均/峰值、当前日期、当前 token。
- **设置面板** — 14 个标签页：🧠 记忆 / 💬 聊天 / 👤 用户信息 / ⏰ 定时
  任务 / 💼 职位 / ✨ 技能 / 🔌 插件 / 🌐 外部 MCP / ⚙️ 通用 / 🔑 API /
  🌸 昔涟设置 / 📱 连接手机 / 🎙️ TTS / 🎧 ASR / 📊 Token 用量 / 📜 免责声明。
- **贴纸管理** — 网格视图 + 启用开关 + 内置/自定义分类。
- **Modal 组件** — 自实现通用确认弹窗（inline modal 避免 Vite tree-shaking），
  自实现 input 弹窗（Electron 禁用 `window.prompt` 兜底）。
- **图标 SVG 内联** — 不依赖 emoji 字体，颜色随主题（currentColor）。

### 🔌 外部集成
- **飞书 Lark 长连接** — 官方 SDK + WebSocket 长连接（无需公网/域名/
  内网穿透），私聊 only，支持 text / image / audio / video / file / sticker
  多模态，资源自动下载到本地缓存。
- **微信 iLink Bot** — `@tencent-weixin/openclaw-weixin` + CLI，扫码登录 →
  long-poll 35s 拉取 `getUpdates` → 主回复链 `dispatchInbound → sendText`，
  `SessionExpiredError` 自动提示重新扫码。
- **MCP（Model Context Protocol）** — 支持 stdio / SSE / HTTP 三种 transport，
  内置 servers 自动同步，`install_mcp_server` 工具让 agent 自动安装新 server。
- **多 LLM 厂商** — OpenAI / Anthropic 兼容适配，厂商能力表 + transport
  启发式探测，per-provider 配置 + test connection。
- **多模态 vision** — 设置页 vision 子配置 (`baseUrl / apiKey / model`)，
  `SETTINGS_TEST_VISION` 一键测连通性。
- **二维码生成 / 解析** — `qrcode` 生成 dataURL，`qr-image` 解析图片内
  二维码，渠道配置扫码登录流程。

### 🔊 语音
- **多 TTS 引擎** — MiniMax / GPT-SoVITS / 自定义云端 / MiMo / off 五档
  可切换，支持流式合成 + 音频缓存。
- **多 ASR 引擎** — 阿里云实时语音识别，自动 token 获取 + JSON 协议 +
  纯 PCM 音频流处理。
- **VAD 静默检测** — 通话模式下检测用户停顿自动触发回复，无需手动按
  结束键。
- **语音通话音频链路** — 通话窗 `pcm-processor.js` 端处理音频流，
  通话时长 + 头像状态实时同步。

### 🧪 场景模拟与测试
- **DMAE 场景模拟** — `npm run sim:coffee` / `sim:mix` / `sim:rescue` /
  `sim:sweep --rewardGain=3,5,7,10` 跑 Worldbook 评分参数 sweep，
  产物输出到 `sim-result/`。
- **Vitest 单元测试** — `npm test` / `npm run test:watch`，覆盖 asr/tts/
  channels/chats/game-bot/memory/opener/orchestrator/rag/scheduler/skills
  等核心模块。
- **构建脚本** — `build:main` (tsc) / `build:preload` / `build:renderer`
  (vite) / `dev` (concurrently tsc + vite + electron with VITE_DEV=1)。
- **记忆追踪日志** — `memory-trace.ts` 记录所有 L0/L1/L2/RAG/conflict
  操作 (ok/error/skip)，方便调试与审计。

### ⚙️ 开发者体验
- **统一 IPC 总线** — `shared/ipc-channels.ts` 定义 90+ 通道常量，
  所有主进程 ↔ 渲染进程通信统一走它，避免硬编码字符串散落。
- **运行时状态 preview** — `SETTINGS_PREVIEW_RUNTIME_SYNC` (off/local/llm)
  实时预览情绪/状态文案，无需完整运行流程。
- **嵌入式模型热切换** — `EMBEDDING_SET_MODEL` IPC 触发后自动检测维度
  不匹配并清空旧库，无需手动迁移。
- **文件监视 / 重载** — 启动时遍历 `rag-data` / `memory.json` /
  `worldbook` / `skills` 目录；运行时 `watchWorldbookFile` 等热更新。

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
├── main/             # Electron 主进程
│   ├── asr/          # 语音识别（阿里云实时 ASR）
│   ├── call/         # 语音通话核心逻辑
│   ├── channels/     # 外部渠道适配层（飞书 / 微信 iLink / ...）
│   ├── chats/        # 多会话历史与持久化
│   ├── game-bot/     # 游戏自动化（game-recipes 驱动）
│   ├── memory/       # L0/L1/L2 记忆引擎 + RAG
│   ├── opener/       # 启动器 / 托盘 / 单实例
│   ├── orchestrator/ # Agent 主循环 + 工具调度
│   ├── rag/          # 检索增强生成 + worldbook 注入
│   ├── relationship/ # 用户关系画像
│   ├── scheduler/    # 定时任务（提醒 / 日程）
│   ├── sim/          # 场景模拟工具（场景驱动）
│   ├── skills/       # Agent skill 系统
│   └── tts/          # 语音合成（多引擎）
├── preload/          # Electron preload 桥接（IPC 暴露）
├── renderer/         # Vite 渲染层
│   ├── call/         # 语音通话窗口
│   ├── chat/         # 主聊天界面
│   ├── live2d/       # Live2D 模型渲染逻辑
│   ├── public/       # 静态资源（音频 / 头像 / 模型 / 贴纸）
│   ├── settings/     # 设置中心
│   ├── sidebar/      # 侧边栏
│   ├── sticker-manager/ # 贴纸管理
│   ├── tasks/        # 任务面板
│   ├── types/        # 共享类型定义
│   └── ui/           # 通用 UI 组件
└── shared/           # 主进程与渲染进程共享代码

dist/renderer/        # Vite 构建产物（不在 git 跟踪范围内）
├── assets/           # 打包后的 JS/CSS（hash 文件名）
├── audio/            # 音频资源（BGM、音效）
├── avatars/          # 头像图片
├── call/             # 通话窗口 HTML 入口
├── chat/             # 主聊天窗口 HTML 入口
├── models/           # Live2D 模型 — 见 MODEL_LICENSE.md
│   └── cyrene/       # 昔涟模型资源
├── settings/         # 设置窗口 HTML 入口
├── sidebar/          # 侧栏 HTML 入口
├── sticker-manager/  # 贴纸管理 HTML 入口
├── stickers/         # 贴纸图片资源
└── tasks/            # 任务面板 HTML 入口
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