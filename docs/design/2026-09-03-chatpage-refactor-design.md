# Chat 前端架构重构设计文档（ChatPage.tsx）

- 日期：2026-09-03（已吸收一轮人工 review 意见修订）
- 范围：`src/renderer/react/features/chat/`（重点是 `pages/ChatPage.tsx`）
- 性质：设计文档。关键方案抉择已定稿（结论见文末"决策记录"）；Run 派生状态（todo / contextUsage / takeover / 压缩提示 / interruptedRun）先由 Run 域临时托管、Controller 稳定后再按生命周期复核，不在本文档宣布永久归属。
- 配套文件：回归 checklist 独立维护于 [2026-09-03-chatpage-refactor-regression-checklist.md](./2026-09-03-chatpage-refactor-regression-checklist.md)（每个重构步骤完成后执行）。
- 约束：保持现有功能与行为不变，以架构整理为主；不追求"一个文件一个职责"；避免把 God Component 变成 God Hook。

---

## 1. 现状概述

### 1.1 代码体量

| 项 | 数据 |
| --- | --- |
| ChatPage.tsx | 2213 行 / 约 97KB |
| `useState` 数量 | 30 个 |
| `useRef` 数量 | 15 个 |
| `useEffect` 数量 | 12 个 |
| 最大单函数 `runModel` | 约 656 行（L665–L1320），其中事件状态机 `handleEvent` 约 265 行（L867–L1132） |
| 直接依赖的同目录模块 | 8 个（bridge、normalizers、openSessionByDeps、run-event-gate、message-reveal、session-runtime-state、attachment-utils、conversation-run-policy） |
| 直接渲染的组件 | 11 个（Navigation、PanelHost、TodoPanel、CodeGitPanel、RunRecoveryNotices、ChatMessageList、ContextCompressionNotice、ComposerSlot+ChatComposer、ChatPageInspector 等） |

### 1.2 挂载方式与真实角色

`main.tsx → AppProviders → App → AppRouter → ChatPage`。**ChatPage 是整个 React 窗口唯一的路由页面**，它不是传统意义上的"页面组件"，而是这个窗口的 **App Shell + Composition Root**：几乎所有 window 桥（chatStore/agui/choice/settings/modelConfig/window.chat）的第一个消费点都在这里。

这个定位对重构目标有直接影响：目标**不是**把 ChatPage 缩成纯展示组件，而是让它回归"壳 + 组装"的角色，把业务过程逻辑移到可独立测试的模块中。

### 1.3 现状数据流（简化）

```
主进程 (IPC / preload)
  │  window.chatStore / window.agui / window.choice / window.settings / window.chat
  ▼
chat-page-bridge.ts ──(纯取值)──► ChatPage.tsx
                                     │
   ┌─────────────────────────────────┼──────────────────────────────────┐
   │ 会话域                          │ Run 域                          │ 交互域
   │ sessionsByMode / activeSessionIds│ runModel() 闭包状态机            │ interactionsBySession
   │ activeSession / workspaceNames  │  ├─ RunEventGate (事件闸)         │ planReviewBySession
   │ ensureSession / selectSession   │  ├─ checkpointChain (350ms 落盘) │ permission/choice 监听
   │ refreshSessions / IPC 切换链     │  ├─ revealChain (渐显)           │
   │                                 │  ├─ EarlyTtsPlaybackQueue        │
   │ 消息域                          │  └─ 终态/错误/takeover 处理       │
   │ messagesBySession + updateMessage                                  │
   │                                 │ Composer 域                     │
   │ 附件域                          │ drafts / attachmentsByScope      │
   │ chooseFiles / paste / caption   │ pendingQueueBySession            │
```

关键点：

- **Run 的实时状态不在 React state 里**，而在 `runModel` 的闭包变量中（`streamContent`、`reasoningBlocks`、`toolExecutions`、`agentRounds`…），每次事件先改闭包变量，再通过 `updateMessage` 把快照 patch 进 React state。React state 里的 messages 是"渲染快照"，闭包才是"真相源"。
- **大量 ref + state 双记账**（`activeSessionIds`+`activeSessionIdsRef`、`pendingQueueBySession`+`pendingQueueBySessionRef`、`modelBusyByMode`+`modelBusyByModeRef`）。原因是 IPC 回调和 runModel 闭包需要"最新值"，不能吃 React 渲染周期的过期闭包。这是当前架构最大的结构性信号：**这些状态的生命周期本来就长于组件渲染周期，放在组件里才需要用 ref 打补丁**。
- 三个 effect 里有 `eslint-disable react-hooks/exhaustive-deps`，都是有意为之（依赖 bridge 的一次性订阅 + ref 读最新值），重构时必须保留语义。

---

## 2. ChatPage.tsx 职责清单（问题 1）

按代码位置逐项列出。✅ = 适合继续留在页面组件；❌ = 应该移出；⚠️ = 有争议，见后文。

| # | 职责 | 主要位置 | 评估 |
| --- | --- | --- | --- |
| 1 | 布局壳层：三栏布局、面板开合、mode 切换入口 | L2064–L2290 | ✅ 壳层本来就是 Page 的活 |
| 2 | Agent Run 编排：事件状态机、checkpoint 落盘、渐显、TTS 接线、终态/takeover | `runModel` L665–L1320 | ❌ 最应移出 |
| 3 | 消息状态：`messagesBySession`、`updateMessage`、hydrate | L121、L498–L506、L594 | ❌ 移出（与 #2 强耦合） |
| 4 | 会话生命周期：bootstrap、IPC 切换链、selectSession、refreshSessions、ensureSession、createNewTask、rename/delete/pin | L557–L660、L1416–L1574、L317–L364 | ❌ 移出（机械但量大） |
| 5 | 消息发送链：sendMessage / dispatchUserMessage / submitTextToSession / 队列 | L1767–L1999 | ⚠️ 拆开后自然分散到 Run/Composer/Session 三处，见 §5 |
| 6 | 附件：拖拽、粘贴、截图、caption 策略、objectURL 生命周期 | L1576–L1765、L283–L297 | ❌ 移出（边界清晰） |
| 7 | 交互卡：审批请求/结算监听、choice resolve、busy 状态 | L175–L210、L2227–L2267 | ❌ 移出（边界清晰） |
| 8 | 计划模式：cyrene.plan.* 监听、阶段流转、批准后自动发消息 | L419–L484 | ❌ 移出（边界清晰） |
| 9 | TTS：early queue 生命周期、ttsCacheKey 落盘 | L508–L555 | ❌ 移出（TTS 子系统已框架无关，只差接线层） |
| 10 | 消息队列（pendingQueue）的入队/消费/移除 | L2023–L2052、L1300–L1318 | ⚠️ 跟随 #2/#4 拆，见 §5.3 |
| 11 | 会话级杂项状态：todoState、contextUsage、interruptedRun、stickerSize、isCompressingContext | 各处 | ⚠️ 分别归属各域 |
| 12 | 工作区：chooseWorkspace、initVaultStructure、pendingWorkspace | L1447–L1498 | ⚠️ 可跟随 #4 |
| 13 | UI 局部状态：collapsed、activePanel、inspectorTab、planDrawerOpen、scrollToBottom、isDraggingFiles | 各处 | ✅ 留下（纯视图状态） |
| 14 | URL 同步（openSessionById 里 replaceState）、localStorage mode 记忆 | L266–L272、L624–L637 | ✅ 留下或跟随 #4，不值得单独抽象 |

**结论：ChatPage 当前承担了约 10 个可识别的职责，其中 #2（Run 编排）是唯一"不可能在 Page 层长期合理存在"的——它是完整的业务过程，有自己的生命周期、持久化策略和错误恢复路径，跟 React 渲染毫无关系。其余多为"状态放错了地方"，属于机械迁移。**

---

## 3. 现状中合理的部分——不要为了重构而重构（问题 9）

这次重构的原则之一是识别"已经做对的事"。以下设计**明确保留，不动**：

### 3.1 纯函数模块抽取（已存在，质量好）

`pages/` 下已经有一批带测试的纯函数模块，边界划分是对的：

- `components/run-presentation.ts` —— 事件/交互卡的归一化与终态判定，全部纯函数
- `pages/session-runtime-state.ts` —— 会话级状态（interaction/todo/hydrate）的纯变换
- `pages/chat-page-normalizers.ts` —— 入口归一化（mode、权限卡、toUiMessages）
- `pages/openSessionByDeps.ts` —— bootstrap 决策逻辑，依赖注入风格
- `pages/run-event-gate.ts` —— runId 绑定前的事件缓冲闸
- `pages/message-reveal.ts` —— 渐显分帧
- `components/agent-rounds.ts`、`components/task-delegations.ts`

**重构应继续复用这批模块作为新 Hook/Controller 的底层，不重写。**（详见 §8）

### 3.2 window 桥模式

`pages/chat-page-bridge.ts` 用 `chatStore()/aguiApi()` 等函数包住 window 全局并导出类型，让测试可以 mock 桥而不是 mock window。**保留**。新模块同样通过 bridge 访问 IPC，不直接摸 `window`。

### 3.3 数据形态：按 sessionId 键控的 Record

`messagesBySession`、`interactionsBySession`、`todoStateBySession`、`pendingQueueBySession` 都是 `Record<sessionId, …>`。这支持了"语音提交到非当前会话 + 多会话并发 run"（`submitTextToSession` 的 `waitForRun: false` 路径），是真实业务需求。**数据形态不改**，问题只在于持有位置。

### 3.4 核心算法

以下算法本身是对的，只是被困在闭包里，搬迁时**逐行保留**：

- **checkpoint 落盘策略**：`checkpointChain` 串行链 + 350ms debounce 合并（`checkpointRun` L758–L794）。它保证了"running 快照可以合并，terminal 快照必须立即且有序落盘"。
- **渐显链**：`revealChain` 串行 promise + `revealCancelled`（L810–L822、L1012–L1016），保证 TEXT_MESSAGE_END 之后 final patch 一定排在所有渐显帧之后。
- **终态提交规则**：`isFormalAnswerCommitted`（success + 完整 TEXT_MESSAGE_END + 非空正文才提交正式回答，L1187–L1191）。
- **cancel-before-ack 窗口**：`cancelRequestedSessionsRef`（L2012–L2019、L1179–L1181），处理 runId 尚未返回时的取消。
- **RUN_STARTED.runId 与 ack.runId 一致性校验**（L885–L899）——只 warn 不重写，ack 为权威。

### 3.5 组件层边界

ChatComposer / ChatMessageList / TodoPanel / ChatPageNavigation 等组件基本都是"props 进、回调出"的受控组件（ChatComposer 内部只有贴纸开关一类局部状态）。**组件层不需要动。** 唯一例外见 §6 风险 R9（ChatMessageItem 类型定义在组件文件里）。

### 3.6 TTS 子系统

`components/tts-playback.ts`（模块级单例）和 `tts/early-tts-queue.ts`（类，串行 drain）已经是框架无关的，有自己的测试。**不需要重构，只需要把 ChatPage 里 ~90 行的接线代码（createEarlyTtsQueue/finishEarlyTtsQueue/handleTtsCacheKey + activeEarlyTtsRef 生命周期）收拢到一个归属点。**

### 3.7 一些"看起来能拆但不值得拆"的代码

按用户原则明确列出**不拆**清单：

- **拖拽四件套**（handleDragEnter/Over/Leave/Drop + dragDepthRef + isDraggingFiles）：20 行局部视图逻辑，跟随附件 hook 顺带走，不单独成模块。
- **stickerSize 同步 effect**（L212–L228）：独立小状态，留在壳层或塞进任意相邻 hook 均可，单独抽象没有价值。
- **interruptedRun 拉取 effect**（L405–L417）：跟随 Run 域，不单独抽象。
- **scroll-to-bottom 按钮 + ref**（L172–L173、L2159–L2181）：纯视图交互，留下。
- **initVaultStructure / chooseWorkspace 里的 window.confirm/alert**：现在直接调 `window.confirm`，风格上不优雅，但**这次不换**（换成 UI 组件是行为变更，违反"行为不变"约束）。只把它们随工作区逻辑一起搬走。
- **L98–L108 的 re-export 块**：为测试文件避免触发整模块副作用而存在，动机合理，保留。

---

## 4. 最优先拆什么，为什么（问题 2）

### 4.1 第一优先级：`runModel`（连同它的消息 patch 通道）

理由按重要性排序：

1. **它是风险与复杂度的绝对大头**。约 656 行（占文件 30%），一个函数内混合了六层关注点：AG-UI 事件解释、React state patch、checkpoint 持久化策略、渐显节奏、TTS 接线、错误/终态/takeover 恢复。历史上最容易出 bug 的领域（僵尸审批卡、cancel 竞态、终态落盘）全部集中在这里。
2. **它不可测试**。状态全在闭包里，唯一入口是真实 IPC。对比之下 `session-runtime-state`、`run-presentation` 都有完整测试——说明团队已经在往"抽纯函数"方向走，`runModel` 是这条路线上最大也最后的一块。
3. **它是真正的业务边界**："一次 Agent Run 的生命周期"（从 api.run 发出到 terminal checkpoint 落盘 + reportRunPersisted）是一个自洽的领域概念，天然不依赖 React。边界清晰的东西拆出来收益最大、回归风险反而可控（可以用注入的假桥做全流程测试）。
4. **它是 ref 双记账的根源**。`activeRunsBySession`、`runCheckpointBySessionRef`、`cancelRequestedSessionsRef`、`modelBusyByModeRef` 都是为了让闭包读到最新值而存在的。Run 状态搬出 React 后，这部分补丁自然消失一半。

### 4.2 第二优先级：消息状态（`messagesBySession` + `updateMessage`）

它和 `runModel` 是同一个问题的两面：runModel 是写方，React state 是存储。拆 controller 必须先定义 patch 通道，所以实际上 1、2 是**一件事的两步**。

`updateMessage` 还有一个现存坏味道：mode 参数时会**扫描所有会话找消息 id**（L498–L506 的 `Object.entries(current).find(...)`），O(会话数×消息数) 且语义含糊（cancel 路径在用它）。拆的时候顺手把调用点全部改成显式 sessionId 是低风险的（见 §6 R5），但要作为显式决策记录。

### 4.3 第三优先级之后（机械迁移，价值递减）

3. 会话管理（bootstrap/IPC 链/CRUD）——量大但逻辑直白。
4. Composer 域（drafts/attachments/queue）——边界清晰。
5. 交互卡 + 计划模式——各自独立，半天量级。
6. 壳层收尾。

**明确不作为目标**：ChatPage 行数本身。拆完前五项后它自然会落到合理区间（预估 500–700 行），但那是结果不是目标。

---

## 5. 目标架构：职责边界与状态归属（问题 3、4）

### 5.1 总体形态

```
ChatPage.tsx（壳 + Composition Root：组装各域 + 跨域协调 + 少量纯视图状态）
  │
  ├─ useChatSessions()      会话域：列表/选中/bootstrap/IPC 切换链/ensureSession/CRUD/工作区
  ├─ useSessionMessages()   消息域：messagesBySession 存储 + patch 通道 + hydrate
  ├─ useAgentRuns()         Run 域：run 注册表 + 忙闲判定 + cancel + dispatch 入口
  │     └─ AgentRunController（React-independent 类，每 run 一个实例）
  │           ├─ 事件状态机（复用 run-presentation / agent-rounds / task-delegations）
  │           ├─ checkpoint 链（策略逐行搬自 runModel）
  │           ├─ 渐显链 + Early TTS 接线（TTS 实例由上层注入）
  │           └─ 终态/takeover
  ├─ useComposerScope()     Composer 域：drafts + 附件 + 发送队列
  ├─ useInteractionCards()  交互域：审批+ask 卡生命周期
  └─ usePlanReview()        计划模式域

跨域协调（只发生在组合根，域之间互不调用）：
  run 结束   ← onRunFinished ── ChatPage ── sessions.refresh() + composer.consumePending()
  发送       → composer.sendMessage ── ChatPage ── ensureSession → runs.dispatch()
  语音提交   ← IPC 监听（薄胶水）── ChatPage ── runs.submitTextToSession()
```

**依赖方向规则（本架构的第一不变量）**：域 hook 之间**不互相 import、不互相调用**。所有跨域数据流（`isSessionBusy` 的查询、run 结束后的 refresh、队列消费）都经由 ChatPage 组装层以参数注入或回调上报的方式连接。依赖方向单向汇聚到组合根，不允许出现 Sessions ↔ Runs 式的生命周期循环。组合根的跨域协调代码（十几行量级）**留在 ChatPage 完全合理**——"A 模块结束后通知 B 模块做事"本来就是 Composition Root 的工作，不要为了"ChatPage 必须干净"把跨域协调硬塞进某一个 hook。

**反 God Hook 约束**：任何一个新 hook/模块的公共 API 超过 ~15 个导出成员、或同时持有两列以上领域的状态时，视为越界信号，必须停下来重新切。`useAgentRuns` 只做"注册表 + dispatch 入口 + 生命周期接线"，**不持有** messages/interactions 状态；controller 通过注入的 host 接口反向通知，不直接 setState。

**"由 Run 产生"≠"由 Run Manager 拥有"**：todoState、contextUsage、sessionTakeover、isCompressingContext 等 Run 派生状态（见 §5.2 表），Phase 1 先由 `useAgentRuns` **临时托管**（保证纯迁移可行），待 Controller 稳定后再根据各状态的真实生命周期决定是否下沉为独立投影模块（如 Run Projection）。本文档不宣布这些状态的永久归属。

### 5.2 状态归属总表（问题 4 的直接回答）

| 状态/ref | 现状 | 目标归属 | 说明 |
| --- | --- | --- | --- |
| `mode` | state | **ChatPage** | 纯视图选择，壳层状态 |
| `collapsed/activePanel/inspectorTab/planDrawerOpen/reviewInspector` | state | **ChatPage** | 纯视图 |
| `scrollToBottomVisible/scrollToBottomRef/isDraggingFiles/dragDepthRef` | state/ref | **ChatPage** | 纯视图 |
| `sessionsByMode` | state | **useChatSessions** | |
| `activeSessionIds`(+ref) | 双记账 | **useChatSessions**（ref 语义内化为 hook 返回稳定引用） | 双记账处理方式见抉择 B（内聚，不消灭） |
| `activeSession`（完整 ChatSession） | state | **useChatSessions** | |
| `workspaceNames/pendingWorkspaceByMode` | state | **useChatSessions** | 工作区绑定是会话属性 |
| `messagesBySession` | state | **useSessionMessages** | 存储 + patch 通道统一 |
| `drafts/attachmentsByScope` | state | **useComposerScope** | scopeKey 概念保留 |
| `pendingQueueBySession`(+ref) | 双记账 | **useComposerScope**（存储+入队；消费由组合根经 onRunFinished 协调触发） | 消费时机在 run finally，见 §6 R4 |
| `attachments ingestion`（chooseFiles/paste/screenshot/caption） | 函数 | **useComposerScope**（按抉择 C） | |
| `localPreviewUrlsRef`（objectURL 生命周期） | ref | 同上 | 卸载时 revoke 的语义保留 |
| `activeRunsBySession/runCheckpointBySessionRef/cancelRequestedSessionsRef` | ref | **useAgentRuns**（run 注册表本体，归属确定） | 唯一真源，不再需要 state 镜像 |
| `modelBusyByMode`(+ref) | 双记账 | **useAgentRuns**（归属确定） | |
| `isCompressingContext` | state | **useAgentRuns 临时托管**（Phase 1；后续按生命周期复核，见 §5.1 原则） | Host API 带 sessionId（见 §5.4），UI 映射保持现状全局单值行为 |
| `interruptedRun` | state | **useAgentRuns 临时托管**（后续复核） | |
| `sessionTakeover` | state | **useAgentRuns 临时托管**（含 retry 闭包，后续复核） | retry 闭包语义见 §6 R6 |
| `interactionsBySession` | state | **useInteractionCards** | 审批监听 + choice resolve 一起搬 |
| `todoStateBySession` | state | **useAgentRuns 临时托管**（本质是 Run 投影，后续复核是否独立） | mergeHarnessTodosForSession 复用 |
| `sessionContextUsageBySession` | state | **useAgentRuns 临时托管**（后续复核；有 selectSession hydrate 第二写点） | 暴露 hydrate 入口给组合根在选会话时调用 |
| `planReviewBySession` | state | **usePlanReview** | |
| `stickerSize` | state | **ChatPage**（保留现状） | 不值得挪 |
| `lastTurnRevisionStarting`(+ref) | 双记账 | **useAgentRuns**（重生成/编辑属于 Run 域入口） | |
| `activeEarlyTtsRef` | ref | **useAgentRuns 的 TTS 接线层** | 切会话 cancel 的 effect 一起搬 |
| `bootstrapCompleted/observedModeRef/reactSessionSwitchChainRef/sessionSelectionGeneration/refreshSessionsRef` | ref/state | **useChatSessions** | bootstrap 时序是会话域核心不变量 |

### 5.3 发送链的归属（sendMessage / dispatchUserMessage / submitTextToSession）

这是现状里耦合最重的一条链，因为它横跨会话（ensureSession）、Composer（清 draft/附件）、消息（append 落盘）、Run（runModel）。建议的切法（跨域步骤全部由组合根串联，见 §5.1 依赖方向规则）：

- `useComposerScope.sendMessage(content)`：解析（parseComposerMessage）→ 上报 ChatPage；由 ChatPage 依次调 `sessions.ensureSession()` → 忙则 `composer.enqueue()`，闲则 `runs.dispatch(input)`。
- `dispatchUserMessage` 落到 **useAgentRuns**：它是"往某会话派发一条用户消息并启动 run"的过程，含消息落盘、占位消息插入、controller 启动。占位消息插入通过 useSessionMessages 的 append 通道（由 ChatPage 注入该通道，Runs 域不 import Messages 域）。
- `submitTextToSession`（语音外部提交）：**内部逻辑**（rendererTargetId 校验、会话存在性/模式校验、忙时入队、keepComposer 语义）不是胶水，跟随 dispatch 链进 useAgentRuns；但**IPC 订阅本身**（onSpeechInputCommitRequest 监听 + 结果回执）是外部集成入口，作为薄胶水留在 ChatPage 组合根。
- `restartLastChatTurn/editLastChatUserMessage/regenerateLastChatResponse` 跟着 dispatch 走（本质是"截断+重发"）。

**备选**：把 dispatch 链整体放进 useComposerScope。缺点是 Composer 域会知道太多 Run 细节，且语音提交路径根本不经过 Composer UI。不采用。

**备选**：run 结束后的 refreshSessions + 队列消费放进 useAgentRuns（本文档初稿方案）。不采用：这会让 Runs 域反向依赖 Sessions 域，形成生命周期循环。改为 controller 经 onRunFinished 只上报终态，ChatPage 薄协调层调 `sessions.refresh()` + `composer.consumePending()`——这段协调代码留在 ChatPage 是合理的组合根职责。

### 5.4 关键方案抉择（已拍板，决策记录见 §10）

#### 抉择 A：Run 编排放哪里【已采纳 A1】

| 方案 | 描述 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A1【已采纳】React-independent Controller 类（`AgentRunController`）+ 注入 host 接口 | 每 run 一个实例；事件归约/落盘/渐显全在类里；通过构造注入 `patchMessage/setInteraction/...` 回调集合 | 彻底摆脱渲染周期；可用假桥做全流程单测；ref 双记账自然收敛；runModel 的闭包变量变成实例字段，语义不变 | 需要定义 host 接口（一次性成本）；类和 React 的接线层要写仔细 |
| A2 `useAgentRun` 大 Hook | 把 runModel 原样搬进自定义 hook | 改动最小 | **正是要避免的 God Hook**：hook 内部依然是闭包状态机，不可测试性问题原样保留，只是换了个文件 |
| A3 纯 reducer（事件→状态）+ 薄 hook | 把 handleEvent 改造成 `(state, event) => {state, patches}` 纯函数 | 归约逻辑可单测到极致 | handleEvent 目前直接产生副作用（patch、checkpoint、TTS append、reveal enqueue），改造为纯函数意味着重写副作用编排，**行为变更风险高**，违反渐进原则 |

采纳 A1 的深层理由：`runModel` 里的 `streamContent/reasoningBlocks/checkpointChain/revealChain/terminalStatus/toolExecutions...` 本质上就是**一个对象的生命周期状态**，只是以前用函数闭包模拟。业务天然是"创建 Run → Run 拥有状态 → 接受事件 → 改变状态 → 结束/dispose"，适合实例承载。已纯函数化的映射部分（run-presentation、agent-rounds、task-delegations）继续纯函数化；handleEvent 主体作为 controller 的私有方法逐行搬迁，不做 reducer 化。若未来想进一步纯化，在 controller 稳定后再做第二步（届时有测试保护）。

**术语澄清（重要）**：`AgentRunController` 是 **React-independent（不依赖 React）的 Controller**，不是"纯函数式"组件——它**就是专门编排副作用的层**：checkpoint 落盘、调 host、调 TTS、接收 IPC 事件、report persisted、管异步链，全部是合法职责。不要因为"纯"字误以为这层不该有副作用。

**controller 的 host 接口草案**（最终形态以实现时收敛为准，关键是"窄"）：

```ts
// Run 宿主：controller 与宿主世界（React + 组合根）的全部依赖收敛于此
interface AgentRunHost {
  patchMessage(sessionId: string, messageId: string, patch: Partial<ChatMessageItem>): void;
  setInteraction(sessionId: string, interaction: ComposerInteraction | null): void;
  updateTodos(sessionId: string, todos: TodoItem[], runId?: string): void;
  updateContextUsage(sessionId: string, snapshot: ContextUsageSnapshot): void;
  // 带 sessionId：多会话并发 run 时宿主可按当前活跃会话决定 UI 映射。
  // 现状 isCompressingContext 是全局单值且只在 RUN_STARTED 复位——本次保持该行为，
  // Host API 先把语义留全，避免接口反向锁死未来。
  setCompressingContext(sessionId: string, value: boolean): void;
  earlyTts: {
    start(mode: ConversationMode, sessionId: string, messageId: string): EarlyTtsPlaybackQueue;
    finish(queue: EarlyTtsPlaybackQueue, fullText: string): void;
    cancel(): void;
  };
  // 只上报终态事实；refreshSessions / 队列消费等跨域后续由组合根协调（见 §5.3），
  // 避免 Runs 域反向依赖 Sessions/Composer 域
  onRunFinished(input: RunFinishedContext): void;
  requestTakeover(sessionId: string, activeRunId: string, retry: () => Promise<void>): void;
}
```

**Host 端口警告**：Host 是 controller 与宿主之间的 **port（端口）**，不是 controller 内部状态的镜像——**不要求把 controller 每一次内部状态变化都暴露成一个 Host 方法**。当前 8 个成员已接近合理上限；若再增长，优先检查是不是该合并语义相近的通知，而不是无脑加方法。防止 God Component 演化成 God Controller + God Host。目前**不**按 MessagePort/TodoPort/TtsPort 拆多端口（过度设计），保持一个 Host。

#### 抉择 B：消灭 ref+state 双记账的方式【已采纳 B1】

现状 `activeSessionIds` + `activeSessionIdsRef` 的双份，有三个去法：

| 方案 | 描述 | 评估 |
| --- | --- | --- |
| B1【已采纳】hook 内保留 ref 为唯一真源，对外暴露 getter + 订阅 | `useChatSessions` 内部 ref 为真源，state 只用于驱动渲染；对外暴露 `getActiveSessionId(mode)` 供非 React 回调使用 | 与现状语义完全一致，迁移零风险；缺点是 hook 消费方有两套读法 |
| B2 useSyncExternalStore 外部小 store | 每域一个 store | 概念干净，但要重写所有读写路径，一次性变更面大，且引入第二种状态范式（项目目前全是 useState） |
| B3 引入 zustand | 全局 store | 项目无状态库依赖；为一个页面引入全局库不划算，且 zustand 的非 React 订阅会诱使域之间互相直接读写，破坏 §5.1 的边界 |

采纳 B1：**保持 useState + ref 镜像的写法，只是把双记账封装进各 hook 内部**，让 ChatPage 和跨域调用方只见单一 API。注意：B1 并**不消灭**双记账，只是把它**内聚到正确的边界内**——这是可接受的终态，不作为待清除的债务（不要为了"归零"去引入外部 store）。B2 作为二期选项，仅当未来出现"多个组件需要订阅同一域"的真实需求再评估。

#### 抉择 C：附件是否独立成 useAttachments【已采纳 C1：并入】

- C1【已采纳】：并入 `useComposerScope`。理由：附件的 scopeKey 语义、清空时机（发送后）、objectURL 生命周期与 draft 完全同步，拆开反而要共享 5+ 个状态。一个 hook 两个内聚子域（草稿、附件）可接受，不违反反 God Hook 约束。
- C2：独立 `useAttachments` + 由 Composer hook 组合。文件多一个，接口多一层，现阶段收益不明显。如果未来附件要支持"会话内重发/历史附件管理"再拆。

#### 抉择 D：目录结构（问题 5）

```
src/renderer/react/features/chat/
├─ pages/
│  ├─ ChatPage.tsx              # 壳 + 组装（目标 500–700 行）
│  ├─ chat-page-bridge.ts       # 保留
│  ├─ chat-page-normalizers.ts  # 保留
│  ├─ openSessionByDeps.ts      # 保留
│  ├─ conversation-run-policy.ts# 保留
│  ├─ run-event-gate.ts         # 保留
│  ├─ message-reveal.ts         # 保留
│  └─ session-runtime-state.ts  # 保留（可被 hooks 复用）
├─ run/                          # 新增：Run 域
│  ├─ AgentRunController.ts     # 每 run 生命周期（自 runModel）
│  └─ agent-run-controller.test.ts
├─ hooks/                        # 新增：React 接线层
│  ├─ useChatSessions.ts
│  ├─ useSessionMessages.ts
│  ├─ useAgentRuns.ts
│  ├─ useComposerScope.ts
│  ├─ useInteractionCards.ts
│  └─ usePlanReview.ts
├─ components/                   # 不动
└─ tts/                          # 不动
```

设计说明：

- `run/` 与 `hooks/` 分开，是因为 Controller 不 import React（React-independent）——这是边界可测试性的物理保证，值得用目录表达。注意这不代表它"纯净无副作用"，它是副作用编排层（见 §5.4 术语澄清）。
- `run-checkpoint.ts` 是否独立（checkpoint 构造器 + 串行链从 controller 再拆出）取决于 controller 拆完后是否还臃肿（>500 行），**先不拆**，等搬完看。这是"不为看起来漂亮而拆小文件"原则的直接应用。
- 不建立 `services/`、`store/`、`controllers/` 等多级目录——当前规模撑不起。
- 备选：hooks 就近放 `pages/hooks/`。不推荐，hooks 是 feature 级资产不是 page 私有。

---

## 6. 重构风险分析（问题 7）

按危险程度排序。每条附"现状语义"（必须保留）与"风险"（搬迁时容易破坏的点）。

### R1. runModel 的隐式顺序契约（最高风险）

现状有多个串行链交织，顺序就是正确性：

1. `await terminal` → `await revealChain` → 终态 patch → `checkpointRun("terminal", true)` → `reportRunPersisted()` → TTS finish。**reportRunPersisted 必须发生在 terminal checkpoint 真正落盘之后**（它是插件 turn:finished 的双条件之一）。
2. `checkpointChain` 串行 + 350ms debounce：running 快照可被后续事件合并，但顺序不可乱。**搬迁时如果用普通异步队列或丢掉 `.catch(() => null)` 的错误隔离，一次 upsert 失败会永久卡死链条。**
3. `revealChain`：TEXT_MESSAGE_END 的 `finalMessageCompleted = true` 必须排在所有渐显帧之后（现状靠链尾追加实现）。
4. takeover 路径在 catch 里 `return` 之前仍要 `checkpointRun("terminal", true)`，且**不调用** reportRunPersisted（runId 是别人的）。
5. finally 里的清理顺序：清 runCheckpoint 回调 → off() 事件订阅 → 清 activeRuns/modelBusy → refreshSessions → 队列消费。

**缓解**：Phase 1 搬迁时逐行搬运这五段，不做"顺手优化"；搬迁前先为 controller 写事件序列单测（见 §7 Phase 1）。

### R2. 非渲染周期的回调读最新值（闭包陷阱）

现状大量使用 ref 就是为了这个：IPC 监听（审批、语音提交、会话切换）、runModel 闭包都跨渲染周期。搬迁到 hook 后，**hook 每次渲染返回新的闭包，如果监听器注册仍在 empty-deps effect 里，闭包会过期**——这正是现在 `refreshSessionsRef`、`activeModeRef` 存在的原因。

**缓解**：各 hook 必须延续"empty-deps 注册 + ref 读值"或"最新引用容器"模式；三个 `eslint-disable exhaustive-deps` 注释连同原因注释一起搬。code review 时把"每个 IPC 订阅闭包里读的每个值"过一遍。

### R3. 会话切换与 run 的竞态

- `selectSession` 的 generation guard（`sessionSelectionGeneration`）防止旧异步结果覆盖新选中会话。搬进 useChatSessions 时 guard ref 必须跟着走。
- `hydrateSessionMessages` 的 `hasActiveRun` 保护：正在跑 run 的会话切换回来时**不**用存储快照覆盖内存态。useChatSessions 需要能查询 useAgentRuns 的忙闲——两个 hook 之间出现了一个真实的读依赖。**方案**：ChatPage 组装时把 `isSessionBusy` 传入 useChatSessions（依赖注入），而不是让两个 hook 互相 import（避免域间隐式耦合）。这是组装层少数几行胶水代码，合理。
- `activeEarlyTtsRef` 的"切会话即取消"effect（L397–L403）依赖 mode+sessionId 双条件，搬迁时注意 effect 依赖数组保持一致。

### R4. 队列消费时机

现状队列消费在 runModel 的 **finally** 里（run 结束、错误、takeover、取消都会走到），消费时同步更新 ref + state 双份。拆分后消费触发经 controller 的 onRunFinished 上报，由 ChatPage 组合根调 composer 的消费入口（见 §5.3）。风险点：

- takeover 路径 finally 也会消费队列（现状 finally 无条件执行）。**注意这意味着 takeover 挂卡期间队列会被立即消费并 dispatch，而 dispatch 又会因守卫再次冲突。** 这是现状真实行为（可能本身是个待确认的边角），迁移时**保持原样**并在测试里固化，不顺手"修复"。
- 消费时的 `keepComposer` 语义（语音消息不清用户草稿）必须保留。

### R5. updateMessage 的 mode-fallback 扫描

L498–L506：targetScope 是 mode 时扫描所有会话找消息。这是历史遗留的含糊接口，主要剩 cancel 路径在用（cancelCurrentRun 用 `activeRun.mode` 调用）。**方案**：改为显式 sessionId（cancel 处已有 sessionId），行为等价、性能更好。【已拍板：要改，但**必须与纯迁移分开 commit**（Phase 2.x），保证迁移 commit 的 before/after 行为完全一致；出问题时可二分定位。】

### R6. takeover retry 闭包

`sessionTakeover.retry` 捕获了整个 `input`（含 session 快照）。用户点击"接管"时可能已经切换会话甚至删除会话。现状 retry 直接重跑 runModel（带 takeoverFromRunId），session 是旧的快照。搬进 controller/useAgentRuns 时 retry 闭包必须原样携带，不重新读 store（重读会引入新的竞态——session 可能已被 replaceTail）。

### R7. React 生命周期

- **渲染期间写 ref**：L261–L263（activeModeRef 等）和 L663（`refreshSessionsRef.current = refreshSessions`）。这是有意的模式（保证 mount effect 不观察到 no-op），React 官方不推荐但当前安全（无并发特性使用）。搬迁时**保持**，不要"修正"成 effect 写入——那会引入 mount 顺序 bug。
- **卸载语义**：L274–L281 卸载时退订事件 + cancel TTS + revoke objectURL。注意：**若真发生卸载，`await terminal` 永远不 resolve（事件已退订），runModel 悬挂、busy 永不清除**。现状因为 ChatPage 是唯一路由页面、永不卸载而无害。搬迁后 controller 生命周期由 useAgentRuns 管理，加一个 `dispose()`（触发 resolveTerminal + 清理）作为纯加固。【已拍板：赞成加，但**放在 Phase 1 之后的独立加固 commit（Phase 1.1）**，不进 Phase 1 纯迁移 commit——保持"迁移前后行为完全一致"这一判断依据的可信度。】
- **StrictMode**：main.tsx 未启用。若未来启用，empty-deps effect 会双执行（bootstrap 双跑、订阅双份）。这超出本次范围，但在 hooks 里把订阅/清理写成严格对称，是低成本的未来保险。

### R8. i18n 与 preferredAddress 的闭包冻结

runModel 捕获渲染时的 `t` 和 `preferredAddress`：run 中途切语言，后续错误文案用旧语言；preferredAddress 变更不影响进行中 run 的 TTS。**现状即如此，属于可接受的轻微不一致。** 搬迁时通过 host 接口注入 `t` 反而给了未来解冻的机会，但本次不做中途切换支持。

### R9. 类型归属

`ChatMessageItem` 定义在 ChatMessageList.tsx（组件文件）里，却被 pages、session-runtime-state、未来的 controller/hooks 共同引用。**建议**（低成本顺手项）：Phase 2 时把它挪到 `features/chat/types.ts` 或 shared 侧，组件文件 re-export 保持兼容。也可以不动——标记为可选项。

### R10. 渐显与 TTS 的交织

TEXT_MESSAGE_CONTENT 的每个 delta 同时喂给渐显（视觉）和 earlyTtsQueue.append（听觉），两者节奏不同步是**有意的**（TTS 按句播放，渐显按帧）。搬迁时保持"同一份内容双喂"的结构，不要试图统一成单一 pipeline。

### R11. 行为面回归清单（高风险功能点）

以下功能在对应 Phase 后必须人工回归（也是测试重点来源）：

- 发送→流式→工具调用→终态（chat/work/code/learn 四模式）
- run 进行中发消息入队 + run 结束自动消费 + 队列删除
- 取消：runId 已知 / ack 未返回（cancel-before-ack）/ 取消后无残留
- 审批卡：出现→点允许/拒绝→清卡；主进程结算广播清卡（僵尸卡根治点）；runId 路由不到会话时丢弃（10s 重播兜底）
- ask 选择卡 + 老版 dismiss 超时补发
- 会话守卫冲突（SESSION_RUN_ACTIVE）→ takeover 卡 → 接管重开
- F5 刷新后 interruptedRun 恢复提示 + resume
- 语音外部提交（含过期 rendererTargetId 回绝、目标会话忙入队、不清草稿）
- 计划模式全流程（review→approved 自动发消息→supplement→completed）
- 附件：拖拽多文件、粘贴大图拒绝、截图失败提示、caption 失败态、直接发送策略
- TTS：early queue 打断（切会话/发新消息）、终态后才 finish、缓存 key 落盘
- 编辑/重生成最后一轮（chat 模式）
- bootstrap：URL 带 sessionId / 不带 / 切换失败 fallback；IPC 连续切换串行链
- 多会话并发 run（语音提交 B 会话 + 手动 A 会话）

---

## 7. 渐进式重构方案与各阶段验证（问题 6、8）

原则：**每个 Phase 结束后代码可发布、行为与上一阶段不可区分**；每 Phase 一个（或几个）独立 PR；全程不新增运行时依赖。

### Phase 0：基线固化（不改产品代码）

- 跑通全量现有测试（session-runtime-state、run-presentation、openSessionByDeps、run-event-gate、message-reveal、agent-rounds、task-delegations、chat-page-normalizers、各组件测试）。
- 基于本文档 §6 R11 展开为独立的手动回归 checklist 文件：`docs/design/2026-09-03-chatpage-refactor-regression-checklist.md`（与本文档同级；独立成文件的原因：每个 Phase 完成后都要执行，不应埋在设计文档正文中）。
- 确认 tsconfig、lint 基线干净。
- **验证**：CI 全绿；checklist 评审通过。这一步是为了让后续每个 Phase 有统一的验收口径。

### Phase 1：抽取 `AgentRunController`（核心阶段）【已拍板：一次完整迁移，不拆 1a/1b】

TTS、渐显、checkpoint 本来就和 Run 生命周期深度纠缠，拆一半会出现"半个生命周期在 Controller、半个在 ChatPage"的更难理解的中间状态。因此保持 runModel → AgentRunController **一次完整搬迁**；但**一个 Phase ≠ 一个 commit**，PR 内按可 review 粒度分 commit：

```
1. Controller 骨架 + host 接口定义（无行为变化）
2. 事件状态机迁移（handleEvent 逐行搬运）
3. checkpoint 链迁移
4. 渐显链迁移
5. TTS 接线迁移
6. 终态/错误/takeover 分支迁移
7. ChatPage 装配 + 删除旧 runModel + controller 单测
```

- 约束：**Phase 1 是纯迁移，禁止顺手修任何 bug / 优化任何行为**（含 R5 显式 sessionId、R7 dispose 加固——分别放到 Phase 2.x / Phase 1.1 独立 commit）。Phase 1 唯一目标是建立"before/after 行为完全一致"这个强判断，掺入行为变更会破坏出问题时的二分定位能力。
- 新建 `run/AgentRunController.ts`：把 runModel 的函数体（闭包变量→实例字段，`setXxx` React 调用→host 回调）整体搬入。`handleEvent`、`checkpointRun`、`enqueuePublicTextReveal`、终态/错误/takeover 分支**逐行搬运**。
- ChatPage 内新增装配代码：构造 host 实现（把原来的 setState 调用接上），`runModel` 变成"new controller + start"的薄壳。此时 ChatPage 行数几乎不减（约 -550/+100），**这是预期的，不要用行数考核本阶段**。
- 队列消费、refreshSessions 留在 ChatPage（controller 的 onRunFinished 上报后，由组合根薄协调层触发，保持现状 finally 的执行时机与无条件性——含 takeover 路径也消费队列的现状边角行为，见 R4）。
- **新测试**（controller 单测，注入假 bridge + 记录型 host）：
  - 事件序列：RUN_STARTED→reasoning→tool→text→RUN_FINISHED(success) 的 patch 序列与 terminal checkpoint 内容
  - terminalStatus = cancelled/timeout/runtime_error 时 formalAnswer 不提交、processMessages 保留
  - RUN_STARTED.runId 与 ack.runId 不一致时保留 ack（不重写）
  - cancel-before-ack：ack 返回后立即 cancel
  - SESSION_RUN_ACTIVE → takeover 上报 + terminal checkpoint 落盘 + 不 reportRunPersisted
  - checkpoint 350ms 合并 + terminal 立即写的调用顺序
  - 早到事件（ack 前）经 RunEventGate 缓冲后按序处理
- **人工回归**：checklist 中 run 相关条目（发送/流式/取消/takeover/恢复/多会话并发）。

### Phase 1.1：dispose 加固（独立小 commit，非纯迁移）

- 按 R7 给 controller 增加 `dispose()`（触发 resolveTerminal + 清理），useAgentRuns 卸载时调用。不改任何可观察行为，只是消除"卸载后 run 悬挂"的潜在问题。

### Phase 2：抽取 `useSessionMessages`

- `messagesBySession`、`updateMessage`、`hydrateSessionMessages` 调用、`patchSessionMessage` 通道收进 hook；controller 的 host.patchMessage 指向 hook 返回的稳定 patch 函数。
- 顺手项（可选，优先级低，单独 commit）：ChatMessageItem 类型挪位（R9）。
- **Phase 2.x（独立 commit，非纯迁移）**：按 R5 把 updateMessage 的 mode-fallback 改为显式 sessionId（cancel 路径人工验证）。
- **测试**：hook 单测（renderHook + act）：patch 幂等、hydrate 在有 activeRun 时不覆盖、按 sessionId 定位。
- **人工回归**：消息渲染、会话切换后消息正确、编辑/重生成、cancel。

### Phase 3：抽取 `useChatSessions`

- 迁入：sessionsByMode、activeSessionIds(+ref)、activeSession、workspaceNames、pendingWorkspaceByMode、pendingModelProfileByMode、selectSession（generation guard）、refreshSessions、ensureSession、createNewTask、handleRename/Delete/Pin、bootstrap effect、IPC 切换链（串行 promise）、URL 同步。
- **明确不迁入（留在 ChatPage）**：
  - **localStorage mode 记忆**：mode 已认定为 ChatPage 纯视图状态，其持久化（六行 effect）跟随 mode 留在 Page 附近，不抽进会话域。
  - **语音提交 IPC 订阅**：外部集成入口，作为薄胶水留在组合根（见 §5.3）；它调用的 `runs.submitTextToSession` 内部逻辑已在 Run 域。
- 依赖注入：接收 `isSessionBusy`（来自 Run 域，由 ChatPage 注入）与 hydrate 回调。
- **测试**：bootstrap 三个分支（URL 有/无/打开失败 fallback）；切换链乱序到达仍串行；selectSession generation 竞态（慢响应不覆盖新选择）；ensureSession 落地 pendingModel/pendingWorkspace。
- **人工回归**：冷启动、四模式切换、新建任务、改名/删除/置顶、工作区绑定、语音提交到指定会话。

### Phase 4：抽取 `useComposerScope`（含附件，按抉择 C1）

- 迁入：drafts、attachmentsByScope、pendingQueueBySession(+ref)、queueCurrentDraft、removeQueuedMessage、chooseFiles、handlePastedImage、handleScreenshot、prepareImageAttachments、removeAttachment、拖拽四件套、objectURL ref、截图插入监听、sendMessage（组装层）。
- **测试**：粘贴超限拒绝、caption 策略 direct/caption 两分支与失败态、附件随发送清空且语音提交（keepComposer）不清、objectURL 卸载 revoke。
- **人工回归**：R11 附件条目 + 队列条目。

### Phase 5：抽取 `useInteractionCards` 与 `usePlanReview`

- 交互卡：interactionsBySession、审批 request/settled 监听（runId 路由 + 10s 重播兜底语义保留）、choice/permission resolve 与 busy、runCheckpoint 联动（通过注入的回调）。
- 计划模式：planReviewBySession、planDrawer/inspectorTab 联动、cyrene.plan.* 监听（含 approved 自动 sendMessage、completed 无 sessionId 分支）。
- **测试**：settled 广播清卡、审批路由不到会话丢弃、plan approved 自动发消息恰好一次、deferred choice（run 外到达）。
- **人工回归**：R11 审批/ask/计划条目。

### Phase 6：收尾

- ChatPage 成为纯组装层：布局 + hook 装配 + 少量纯视图状态 + 事件回调转接。对照 §5.2 总表逐项核对归属。
- 删除搬迁过程中遗留的转发函数/注释；更新本文档标注实际结果。
- 评估是否需要 Phase 7（B2 外部 store / run-checkpoint 再拆）——**默认不做**，只有当出现真实痛点（如第二个消费者需要订阅某域）才立项。

### 阶段排序说明

顺序是"先难后易"（Run 最重，趁上下文最热先拆）。备选是"先易后难"（先 Phase 3/4 热身）。不采用：会话/Composer 域对 run 域有依赖（isSessionBusy、dispatch），先拆它们会做出很快又要改的临时接口。原待决策点"Phase 1 是否拆 1a/1b"已拍板**不拆**（见 Phase 1 说明），风险控制改由"Phase 内多 commit + 纯迁移纪律"承担。

---

## 8. 复用清单（问题 10）

明确"直接复用、不重写"的资产：

| 资产 | 在新架构中的角色 |
| --- | --- |
| `run-presentation.ts` 全部纯函数 | controller 事件状态机直接调用（normalizeChoiceInteraction/resolveRunFinishedStage/isFormalAnswerCommitted/…） |
| `agent-rounds.ts` / `task-delegations.ts` | 同上 |
| `session-runtime-state.ts` | useSessionMessages / useInteractionCards / useAgentRuns 的底层纯函数（patchSessionMessage/hydrateSessionMessages/startSessionTodos/mergeHarnessTodosForSession/buildTodoRecoveryContext/findSessionIdForRun） |
| `run-event-gate.ts` | controller 内部组件，原样 |
| `message-reveal.ts` | controller 渐显链，原样 |
| `chat-page-normalizers.ts` | useChatSessions/useInteractionCards/useAgentRuns 分头 import（permissionInteraction、toUiMessages、parseSessionRunActiveError、stageForStep） |
| `openSessionByDeps.ts` / `bootstrapReactSession` | useChatSessions 直接调用 |
| `tts-playback.ts` / `EarlyTtsPlaybackQueue` | useAgentRuns 的 TTS 接线层直接调用 |
| `chat-page-bridge.ts` | 所有新模块的 IPC 入口 |
| 现有全部 `*.test.ts` | 原地保留继续跑；Phase 1 起为新模块新增同级测试 |

**不需要新造的轮子**：事件归一化（run-presentation 已覆盖）、todo 合并（session-runtime-state 已覆盖）、bootstrap 决策（openSessionByDeps 已覆盖）。新代码基本只有三类：controller 的生命周期壳、各 hook 的接线、host/依赖注入接口。

---

## 9. 预期收益与验收

### 观察指标（不作为验收条件）

以下数字仅用于观察趋势，**明确不作为验收 KPI**——行数/state 数一旦成为硬指标，会诱导"为达标而搬代码"。若某项未达标但职责边界已清晰，视为成功。

| 观察项 | 现状 | 预期区间（观察值） |
| --- | --- | --- |
| ChatPage.tsx | 2213 行、30 useState | 约 500–700 行，其中多数为纯视图 state + 组合根协调 |
| runModel | 656 行闭包函数，0 直接测试 | AgentRunController + 事件序列单测覆盖核心分支 |
| ref 双记账 | 4 组暴露在组件层 | 内聚到各域 hook 内部（按 B1，不追求归零） |
| 新增文件 | — | 7–8 个（1 controller + 6 hook + 可选类型文件） |

### 验收标准（真正的验收条件）

1. **职责边界**：§5.2 归属表逐项核对，无跨域持状态。
2. **依赖方向**：域 hook 之间零互相 import（§5.1 第一不变量）。
3. **行为不变**：回归 checklist 全绿（每个 Phase 执行一轮）。
4. **测试**：现有测试全绿 + 每个 Phase 的新增单测绿。
5. **可理解性**：新人可在不读 ChatPage 的情况下理解单个 Run 的完整生命周期（读 AgentRunController 即可）。

---

## 10. 决策记录（原"待 review 决策点"，已拍板）

| # | 决策项 | 结论 | 备注 |
| --- | --- | --- | --- |
| 1 | 抉择 A：Run 编排载体 | **A1 React-independent Controller** | handleEvent 逐行搬运、不做 reducer 化；它就是副作用编排层（§5.4 术语澄清） |
| 2 | 抉择 B：ref/state 双记账 | **B1 hook 内封装** | 不引入外部 store / zustand；双记账内聚不归零 |
| 3 | 抉择 C：附件归属 | **C1 并入 useComposerScope** | 未来出现"重发/历史附件"需求再拆 |
| 4 | R5：updateMessage mode-fallback | **改为显式 sessionId，独立 commit（Phase 2.x）** | 不与纯迁移混合 |
| 5 | R9：ChatMessageItem 类型挪位 | **可搬，优先级低** | 单独 commit，组件文件 re-export 保持兼容 |
| 6 | Phase 1 是否拆 1a/1b | **不拆，一次完整迁移** | Phase 内按 7 个 commit 分粒度；纯迁移纪律禁止顺手修 bug |
| 7 | 回归 checklist 位置 | **独立文件** | [2026-09-03-chatpage-refactor-regression-checklist.md](./2026-09-03-chatpage-refactor-regression-checklist.md)，与本文档同级（docs/design/，沿用既有设计文档目录约定） |

本轮 review 追加确认的架构修正（已并入正文）：

- **跨域协调归组合根**：run 结束后的 refreshSessions + 队列消费由 ChatPage 协调（§5.1、§5.3），杜绝 Sessions ↔ Runs 生命周期循环。
- **Run 派生状态只宣布临时托管**：todoState / contextUsage / sessionTakeover / isCompressingContext / interruptedRun（§5.2），Controller 稳定后按生命周期复核。
- **Host 是端口不是状态镜像**：8 个成员接近上限，不拆多端口也不放任增长（§5.4）。
- **setCompressingContext 带 sessionId**：本次保持现状全局单值行为，接口留全语义（§5.4）。
- **localStorage mode 记忆与语音提交 IPC 订阅留在组合根**（§5.3、Phase 3）。

---

## 附录 A：runModel 闭包状态 → controller 字段对照（搬迁映射）

| 闭包变量 | controller 字段 | 备注 |
| --- | --- | --- |
| streamContent / reasoningContent / reasoningBlocks / processMessages / agentRounds / taskDelegations / toolExecutions / sticker / currentTodos / contextUsage / runActivity / terminalStatus / persistedFinalContent / finalMessageCompleted | 实例字段（同语义） | 真相源随实例走 |
| revealChain / revealCancelled / processMessageSequence / activeRoundId / currentReasoningId / activeReasoningStarts | 实例字段 | 渐显与计时 |
| checkpointTimer / checkpointChain | 实例字段 | 落盘策略原样 |
| terminal / resolveTerminal | 实例字段 + dispose() 触发 | R7 加固点 |
| eventGate / off（退订函数） | 实例字段，stop() 时退订 | |
| activeRunsBySession / runCheckpointBySessionRef / cancelRequestedSessionsRef / modelBusy* | 留在 useAgentRuns（注册表），controller 通过回调读写 | runId 权威值仍由注册表持有 |
