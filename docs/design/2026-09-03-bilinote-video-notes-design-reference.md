# BiliNote 设计解析——视频笔记生成的核心思路（供 Cyrene 借鉴）

> 对象仓库：https://github.com/JefferyHcool/BiliNote （MIT 协议，FastAPI + React）
> 分析目的：理解"让 AI 理解视频"的工程化方案，从中提取可用于 Cyrene 的设计模式。

---

## 一、它解决什么问题

用户丢一个 B 站 / YouTube / 抖音视频链接，系统产出一份结构化 Markdown 笔记：带章节、可跳转原片时间点、可插图，还能基于笔记内容做 AI 问答。

本质不是"AI 看视频"，而是**把视频翻译成大模型能消化的两种原料（文字 + 图片），加工完再把结果钉回视频时间轴**。

---

## 二、总体架构

```
前端 (React/Vite) ──HTTP──> 后端 (FastAPI)
                              │
                    任务队列（串行执行器）
                              │
        ┌──────────┬──────────┼──────────┬──────────┐
        下载器层     转写器层     GPT 层      工具层      存储层
     (按平台适配)  (工厂模式)   (工厂模式)  (FFmpeg等) (SQLite)
```

分层的关键点：**每一层都是"可替换的实现 + 统一接口"**。

- 下载器：`Downloader` 基类，bilibili / youtube / douyin / kuaishou / local 各一个子类
- 转写器：`Transcriber` 基类，fast-whisper / mlx-whisper / groq / bcut（必剪）/ kuaishou 各一个实现，`get_transcriber()` 工厂按配置实例化
- GPT：`GPT` 基类 + `GPTFactory`，任意 OpenAI 兼容供应商（DeepSeek、Qwen 等）即插即用

Cyrene 对照：这与我们 agent 的 tool / provider 抽象思路一致，但它把"媒体处理"也做成了同构的可插拔层，值得参考。

---

## 三、核心流水线（NoteGenerator.generate）

```
链接 → 拿文字（三层兜底）→ 拿画面（可选）→ LLM 生成草稿 → 后处理替换标记 → 落库返回
```

### 3.1 文字轨：三层兜底策略（成本从低到高）

| 优先级 | 来源 | 成本 |
|---|---|---|
| 1 | 本地缓存（`{task_id}_transcript.json`） | 零 |
| 2 | 平台字幕（B站 player API 直拉，人工字幕 > AI 字幕） | 一次 HTTP |
| 3 | 下载音频 + Whisper 转写 | 最高 |

设计要点：

- **拿到字幕就跳过音视频下载**，除非用户要截图或多模态理解（此时才需要视频文件）
- B站字幕走官方 `/x/player/wbi/v2` 接口，需要注入用户 Cookie（SESSDATA）才能拿到 AI 字幕
- 选字幕的优先级：人工中文 > AI 中文 > 任意中文 > 任意非空
- 每一步产物都有缓存文件，失败重试不从头开始

Cyrene 对照：这种"缓存 → 白嫖现成接口 → 自己算"的降级链，适用于任何昂贵的处理步骤（转写、嵌入、总结）。

### 3.2 画面轨：网格拼图方案

多模态理解的实现非常朴素：

1. FFmpeg 每隔 N 秒抽一帧
2. 拼成一张网格图（如 3×3），**每格左上角印时间戳 mm:ss**
3. 整张图 + 转写文本一起发给多模态模型

好处：一次请求覆盖全片画面，时间戳让模型能把"第几格画面"和"转写文本第几段"对上。

### 3.3 LLM 加工：提示词模板 + 占位标记（最值得学的部分）

提示词 = 基础模板（标题 + 带时间戳转写 + 标签）+ 格式选项（目录/跳转/截图/总结）+ 风格选项（精简/学术/小红书等 9 种）+ 用户附加要求。

**占位标记机制是灵魂**：

- 让 LLM 在章节标题后输出 `*Content-[01:23]`
- 让 LLM 在适合配图处输出 `*Screenshot-[02:45]`
- 后处理代码把这些标记替换成真正的跳转链接和截图文件

这实现了**"AI 决策 + 代码执行"的分离**：模型负责判断"哪里值得跳转、哪里值得配图"（它擅长的语义判断），代码负责实际截取图片、拼 URL（模型做不到的事）。且模型不需要输出任何真实文件路径，杜绝幻觉路径问题。

Cyrene 对照：Cyrene 的 agent 如果要产出"带富媒体引用"的内容（截图、文件、链接），完全可以用同样的标记协议——让模型输出 `[cyrene:screenshot: mm:ss]` 这类占位符，由宿主渲染层替换。

### 3.4 长内容：分块 + 断点续传

`request_chunker` 把长转写切成小块分次送 LLM，逐段总结后合并；已成功的段落有缓存，重试时从失败处继续，不重头开始。

### 3.5 事后问答：RAG + Function Calling

笔记生成不是终点：转写文本 + 视频元信息（标题/作者/标签）建向量索引，AI 问答时通过 Function Calling 主动检索原文，保证回答锚定在视频内容上。

---

## 四、工程细节亮点

### 4.1 反爬对抗都收在下载器内部

- B站风控要求 `dm_img` 参数，否则 player API 返回 412 —— 项目用 monkey patch 给 yt-dlp 打补丁，调用方无感知
- Cookie 统一由 `CookieConfigManager` 管理，写入 Netscape 格式临时文件注入 yt-dlp
- 浏览器插件场景下直接用用户浏览器里的登录态抓字幕，比后端更稳

### 4.2 任务状态用文件而非只靠数据库

每个任务一个 `{task_id}.status.json`，写入时先写临时文件再原子 rename。前端轮询这个状态。好处：状态文件天然是调试日志，且与数据库事务解耦。

### 4.3 转写器配置运行时可切换

`TranscriberConfigManager` 把转写引擎选择（本地 whisper 的模型大小 / 云端 groq / 必剪）做成运行时配置存 SQLite，前端设置页直接切换，不用改环境变量重启。模型没下载好时**前置拦截**任务并引导用户，而不是静默卡死。

### 4.4 多模态兼容性处理

`UniversalGPT` 的消息构造器按"是否带图"动态切换 string / 多模态数组两种形态——纯文本模型（如 DeepSeek）不会被图片请求打挂（这是他们踩过的坑，issue #282）。

Cyrene 对照：我们对接多家供应商时同样需要"能力探测 + 请求形态自适应"，不能假设所有模型都支持同一套消息结构。

---

## 五、可以搬到 Cyrene 的设计清单

按实用程度排序：

1. **占位标记协议**：模型输出语义标记（时间戳、引用、截图点），宿主代码负责物化。适合 Cyrene 的笔记/总结类技能，也适合任何"模型决策 + 宿主执行"的场景。
2. **三层降级链**：缓存 → 现成接口 → 本地计算。Cyrene 处理昂贵操作（转写、嵌入、网页抓取）时的通用模式。
3. **网格拼图 + 时间戳**：低成本视频理解方案。若 Cyrene 未来接视频输入，这是最省 token 的路子。
4. **可插拔的媒体处理层**：Downloader / Transcriber / GPT 三层同构抽象，与 Cyrene 现有 provider 抽象风格一致，扩展新媒体平台时只需加一个子类。
5. **段落级断点缓存**：长任务分块处理时，每块成功即落盘，重试不重跑。Cyrene 的调度任务跑长流程时可借鉴。
6. **状态文件 + 原子写**：任务状态与数据库解耦，天然留痕。Cyrene 已有类似的 status 机制，可对照看是否缺原子写保护。
7. **能力探测的消息自适应**：多供应商 LLM 接入时按模型能力切换请求形态，避免 400。

---

## 六、不建议照搬的部分

- **Python 技术栈**：Cyrene 是 TypeScript/Electron，参考设计而非实现
- **串行任务队列**：BiliNote 是单用户单任务串行；Cyrene 的插件调度已有更完整的并发模型
- **状态文件轮询**：前端 3 秒轮询是它的简化取舍，Cyrene 桌面端用 IPC 推送更合适

---

## 附：关键源码索引

| 模块 | 路径 | 作用 |
|---|---|---|
| 主流水线 | `backend/app/services/note.py` | NoteGenerator：下载→转写→总结→后处理 |
| B站字幕直拉 | `backend/app/downloaders/bilibili_subtitle.py` | player API 拿字幕，绕过 yt-dlp |
| B站下载器 | `backend/app/downloaders/bilibili_downloader.py` | Cookie 注入 + dm_img 风控补丁 |
| 提示词构建 | `backend/app/gpt/prompt_builder.py` | 格式/风格模板 + 占位标记指令 |
| 长文分块 | `backend/app/gpt/request_chunker.py` | 转写切块分次送 LLM |
| RAG 问答 | `backend/app/services/chat_service.py` | 向量检索 + Function Calling |
| 截图工具 | `backend/app/utils/video_helper.py` | FFmpeg 按时间点抽帧 |
