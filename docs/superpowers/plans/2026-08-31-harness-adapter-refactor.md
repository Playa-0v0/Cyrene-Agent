# Harness Adapter 渐进式重构施工计划

> **执行者提示：** 本文只描述施工步骤。实现时逐项勾选；若由智能体执行，先加载 `superpowers:test-driven-development` 与 `superpowers:verification-before-completion`。

**目标：** 把 `src/main/orchestrator/harness-adapter.ts` 拆成运行准备、工具运行时、prompt（提示词）、事件映射、纯终态映射和计划生命周期模块；原文件继续作为 Harness（智能体执行循环）与 CyreneAgent 之间的兼容门面及副作用编排器。

**架构：** 叶子模块负责计算或构造对象，`runHarnessWithAdapter` 保留关键时序。`terminal-mapper.ts` 只做 terminate reason（终止原因）到 completion/canonical terminal（完成原因/标准终态）的纯映射；`runStore.markTerminal` 和 `reviewTracker.finalizeReview` 必须留在门面编排层，且顺序不变。

**技术栈：** TypeScript、Electron 主进程、AG-UI（智能体图形交互协议）、Vitest。复用现有 `run-store`、`run-recovery`、`TaskSessionStore`、`FileToolOutputStore`、permission policy（权限策略）和 plan-mode（计划模式）模块；不创建新的状态机、事件总线或存储层。

**总设计：** `docs/superpowers/specs/2026-08-30-god-file-refactor-design.md`

## 全局约束

- 保留 `runHarnessWithAdapter`、`materializeHarnessStartTranscript`、`filterToolsForConversationMode`、`buildHarnessPromptLayers`、`buildHarnessSystemPrompt`、`sendHarnessEventAsAgui`、`sendTaskLifecycleAsAgui` 和 `mapTerminateReasonToTerminal` 的旧导入路径与签名。
- canonical runId（标准运行标识）必须来自 `options.runId`，缺失仍抛同一错误；不得生成 adapter 私有 runId。
- 恢复校验、最新用户消息追加、runtime context 入 transcript、`runStore.create` 和首轮模型调用的先后关系不变。
- checkpoint（检查点）、tool lifecycle（工具生命周期）和 compaction lifecycle（上下文压缩生命周期）的写入时机与字段不变。
- plan read-only（计划只读）继续由 build-options 过滤和本适配器 permission check 双层防守。
- 同一个 `AbortSignal` 必须传给 ToolContext、权限、用户澄清、task executor 和 HarnessInput。
- `externalEffectsMayContinue` 对 uncertain effects（不确定副作用）的映射不变。
- 终止后必须先 `markTerminal`，再尝试 `finalizeReview`；review 失败只记录错误，不阻断结果。
- `cyrene.plan.completed` 的模式、状态、取消条件、payload（载荷）和发送时机不变。
- 新模块不得反向导入 `orchestrator/harness-adapter.ts`。

## 文件地图

- 新建 `src/main/orchestrator/harness/adapter/run-preparation.ts`：计划开局、VendorConfig（厂商配置）、工具、恢复、prompt 物化和 run store 创建。
- 新建 `src/main/orchestrator/harness/adapter/tool-runtime.ts`：ToolContext、权限检查、输出存储和任务委托执行器。
- 新建 `src/main/orchestrator/harness/adapter/prompt-builder.ts`：启动 transcript、prompt layers 和 system prompt。
- 新建 `src/main/orchestrator/harness/adapter/event-mapper.ts`：HarnessEvent 与 task lifecycle 到 AG-UI 事件。
- 新建 `src/main/orchestrator/harness/adapter/terminal-mapper.ts`：纯终态与完成原因映射。
- 新建 `src/main/orchestrator/harness/adapter/plan-lifecycle.ts`：计划开局/收尾钩和完成事件。
- 修改 `src/main/orchestrator/harness-adapter.ts`：保留公开 API（应用程序编程接口）和副作用顺序。
- 新建 `src/main/orchestrator/harness-adapter-characterization.test.ts`：锁定 create/checkpoint/terminal/review/plan 的调用轨迹。
- 为叶子模块新增同名测试；保留现有 adapter、Git 工具和 cancel 测试。

## 目标接口

```ts
// prompt-builder.ts
export function materializeHarnessStartTranscript(input: {
  messages: readonly ChatMessage[]
  runId: string
  runtimeContext?: string
  initialState?: AgentState
  kind: "run_start" | "recovery"
}): ChatMessage[]
export function buildHarnessPromptLayers(options: CyreneRunOptions): PromptLayers & {
  usageParts?: {
    personaContent: string
    toolLayerContent: string
    skillLayerContent?: string
  }
}
export function buildHarnessSystemPrompt(options: CyreneRunOptions): string

// terminal-mapper.ts
export type HarnessTerminateReason = "max_rounds" | "timeout" | "cancelled" | "error" | undefined
export function mapTerminateReason(
  reason: HarnessTerminateReason,
): "no_tool" | "timeout" | "max_rounds" | "tool_error"
export function mapTerminateReasonToTerminal(
  reason: HarnessTerminateReason,
  hasUncertainEffects?: boolean,
): CyreneRunTerminalResult

// event-mapper.ts
export function sendHarnessEventAsAgui(
  event: HarnessEvent,
  messageId: string,
  threadId: string,
  runId: string,
  send: (event: BaseEvent) => void,
): void
export function sendTaskLifecycleAsAgui(
  value: TaskDelegationPresentation,
  threadId: string,
  runId: string,
  send: (event: BaseEvent) => void,
): void
```

运行准备与工具运行时使用显式结果对象，避免隐藏副作用：

```ts
// run-preparation.ts
export interface PreparedHarnessRun {
  threadId: string
  runId: string
  messageId: string
  planState: ReturnType<typeof getPlanState> | undefined
  vendorConfig: VendorConfig
  tools: ToolDefinition[]
  promptLayers: ReturnType<typeof buildHarnessPromptLayers>
  harnessPromptLayers: PromptLayers
  systemPrompt: string
  runMessages: ChatMessage[]
  recovered?: ReturnType<typeof prepareHarnessRecovery>
  runStore: ReturnType<typeof getHarnessRunStore>
}
export async function prepareHarnessRun(
  options: CyreneRunOptions,
  signal: AbortSignal,
): Promise<PreparedHarnessRun>

// tool-runtime.ts
export interface PreparedToolRuntime {
  toolContext: ToolContext
  checkPermission: HarnessInput["checkPermission"]
  toolOutputStore: FileToolOutputStore
  taskExecutor: HarnessInput["taskExecutor"]
}
export function prepareToolRuntime(input: {
  options: CyreneRunOptions
  signal: AbortSignal
  prepared: PreparedHarnessRun
  sendBaseEvent: (event: BaseEvent) => void
}): PreparedToolRuntime
```

`prepareHarnessRun` 必须保留当前的异步边界：计划执行上下文通过 `fs.promises.readFile` 读取；run store 创建、恢复校验和其他同步操作仍保持同步，不得改成另一套 IO 策略。

---

### 任务 1：锁定适配器副作用轨迹

**文件：**

- 新建 `src/main/orchestrator/harness-adapter-characterization.test.ts`
- 不改生产代码

- [ ] mock `runCyreneHarness`、run store、review tracker、plan-mode 和事件发送器，各阶段向同一 `trace` 写语义名称。
- [ ] 成功路径断言：

```text
runStore.create
runHarness
runStore.markTerminal
review.finalizeReview
plan.completeExecution
return
```

- [ ] 在 Harness 回调内触发 checkpoint、tool lifecycle 和 compaction，断言分别调用正确的 run store 方法，且 runId 始终为 canonical runId。
- [ ] review finalize 抛错时仍返回同一 `AgentLoopResult`；`markTerminal` 抛错时不得继续 finalize 或伪造成功结果。
- [ ] 覆盖 success/cancelled/timeout/runtime_error，以及 success + uncertain effects。
- [ ] 覆盖恢复顺序：读取旧 run → 校验恢复 → 追加“继续任务”用户消息 → 物化 runtime context → `runStore.create` → Harness。
- [ ] 覆盖计划执行完成事件：只在 code/chat、`completeExecution` 返回路径、且 signal 未 aborted 时发送。
- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness-adapter-cancel.test.ts src/main/orchestrator/harness-adapter-git-tools.test.ts src/main/orchestrator/harness-adapter-characterization.test.ts
npm run build:main
```

---

### 任务 2：先提取纯终态映射

**文件：**

- 新建 `src/main/orchestrator/harness/adapter/terminal-mapper.ts`
- 新建 `src/main/orchestrator/harness/adapter/terminal-mapper.test.ts`
- 修改 `src/main/orchestrator/harness-adapter.ts`

- [ ] 原样迁移 `mapTerminateReason` 和 `mapTerminateReasonToTerminal`，导出前者供门面使用，门面重导出后者保持旧 API。
- [ ] 测试完整映射表：undefined、max_rounds、timeout、cancelled、error；undefined 分别覆盖 uncertain true/false。
- [ ] 纯度约束：该模块只能 import 类型，不得 import Electron、run store、review tracker、plan-mode、文件系统或 logger（日志器）。
- [ ] 搜索验证：

```powershell
rg -n "electron|run-store|review|plan-mode|console\.|markTerminal|finalizeReview" src/main/orchestrator/harness/adapter/terminal-mapper.ts
```

预期：无匹配。

- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/harness/adapter/terminal-mapper.test.ts src/main/orchestrator/harness-adapter.test.ts
npm run build:main
```

---

### 任务 3：提取 prompt 构造

**文件：**

- 新建 `src/main/orchestrator/harness/adapter/prompt-builder.ts`
- 新建 `src/main/orchestrator/harness/adapter/prompt-builder.test.ts`
- 修改 `src/main/orchestrator/harness-adapter.ts`

- [ ] 迁移 `materializeHarnessStartTranscript`、`buildHarnessPromptLayers`、`buildHarnessSystemPrompt` 和只为它们服务的辅助函数。
- [ ] 保持 internal transcript（内部对话记录）的 revision 算法、kind、runId、分隔符和空上下文快速返回。
- [ ] 保持 stablePrefix/sessionPrefix/mode/runtimeContext/usageParts 的字段有无、内容和顺序。
- [ ] Chat 的 tool layer 为空、Work/Code 的 persona 组成、recovery/todo 只进入 runtime transcript 等现有断言全部继续通过。
- [ ] 门面显式重导出三个公开函数。
- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/harness/adapter/prompt-builder.test.ts src/main/orchestrator/harness-adapter.test.ts
npm run build:main
```

---

### 任务 4：提取 AG-UI 事件映射

**文件：**

- 新建 `src/main/orchestrator/harness/adapter/event-mapper.ts`
- 新建 `src/main/orchestrator/harness/adapter/event-mapper.test.ts`
- 修改 `src/main/orchestrator/harness-adapter.ts`

- [ ] 整体迁移 `sendHarnessEventAsAgui` 与 `sendTaskLifecycleAsAgui`，不要改变 switch 分支顺序或事件对象字段。
- [ ] 保持 progress_text、round boundary（轮次边界）、reasoning、tool start/result/end、todo、context usage、final answer 和 task lifecycle 的事件名与顺序。
- [ ] 每个发出的事件仍显式携带传入的 threadId/runId；结构化 file changes 不受 preview 截断影响。
- [ ] `TOOL_CALL_RESULT` 必须先于 `TOOL_CALL_END`，非成功 Harness outcome（结果）仍标记 failed。
- [ ] 将现有 `harness-adapter.test.ts` 中事件映射用例移动或复用到新模块测试；门面保留至少一条重导出集成断言。
- [ ] 运行针对性测试与构建。

---

### 任务 5：提取计划生命周期钩子

**文件：**

- 新建 `src/main/orchestrator/harness/adapter/plan-lifecycle.ts`
- 新建 `src/main/orchestrator/harness/adapter/plan-lifecycle.test.ts`
- 修改 `src/main/orchestrator/harness-adapter.ts`

- [ ] 提取“PLAN_REVIEW 收到新消息回 PLAN_DISCUSSING”“读取 EXECUTING 计划正文并形成 runtime block”“执行结束 completeExecution + CUSTOM 事件”。
- [ ] 使用三段窄接口，不让模块拥有 run store 或 review tracker：

```ts
export async function preparePlanRunContext(input: {
  mode?: ConversationMode
  threadId: string
}): Promise<{ planState: ReturnType<typeof getPlanState> | undefined; planContextBlock?: string }>

export function completePlanRun(input: {
  mode?: ConversationMode
  threadId: string
  runId: string
  runStatus: ReviewRunStatus
  signal: AbortSignal
  send: (event: BaseEvent) => void
}): void
```

- [ ] 保持计划文件异步读取、错误日志、`[PLAN_CONTEXT]` 文本和换行不变。
- [ ] `completeExecution` 在执行 run 任意终态都调用；只有返回 planPath 且未取消时发事件。
- [ ] 运行新模块测试、characterization test 和构建。

---

### 任务 6：提取运行准备

**文件：**

- 新建 `src/main/orchestrator/harness/adapter/run-preparation.ts`
- 新建 `src/main/orchestrator/harness/adapter/run-preparation.test.ts`
- 修改 `src/main/orchestrator/harness-adapter.ts`

- [ ] 验证 `options.runId` 后才进入准备；缺失错误仍由门面原位置抛出。
- [ ] 迁移 VendorConfig、工具选择、run store 获取、恢复校验、消息合并、prompt 物化、request fingerprint（请求指纹）和 `runStore.create`。
- [ ] `filterToolsForConversationMode` 若仍被外部使用，放在此模块并由门面重导出；CODE_ONLY_GIT_TOOL_IDS 状态只留一份。
- [ ] 保持恢复错误 `HARNESS_RECOVERY_NOT_FOUND`、conversationId 比对、工作区/provider/model/tool ID 校验和 resume 字段。
- [ ] `materializeHarnessStartTranscript` 必须在 `runStore.create` 前；`runtimeContext` 物化后从实际 Harness prompt layers 中移除，避免每轮重复注入。
- [ ] request snapshot 的 prompt/tool schema 指纹、排序和 workspace 字段保持完全一致。
- [ ] 使用临时 run store 验证 create payload 的深度相等。
- [ ] 运行针对性测试、恢复相关测试和构建。

---

### 任务 7：提取工具运行时

**文件：**

- 新建 `src/main/orchestrator/harness/adapter/tool-runtime.ts`
- 新建 `src/main/orchestrator/harness/adapter/tool-runtime.test.ts`
- 修改 `src/main/orchestrator/harness-adapter.ts`

- [ ] 迁移 ToolContext 构造、permissionCheck、FileToolOutputStore 和条件化 task executor。
- [ ] `permissionMode === "allow_all"` 仍最先短路；plan read-only 检查仍早于普通权限对话框。
- [ ] 保持未知工具拒绝、默认风险级 safe、`checkPermission` 参数和 `.allowed` 读取。
- [ ] task executor 仍只在 Work/Code 创建，parent payload、TaskSessionStore 路径和 lifecycle event mapping 不变。
- [ ] 增加 identity（对象同一性）断言，证明同一个 signal 进入 ToolContext、permission、clarification 和 executor parent。
- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/harness/adapter/tool-runtime.test.ts src/main/orchestrator/harness-adapter-cancel.test.ts src/main/orchestrator/harness-adapter-git-tools.test.ts
npm run build:main
```

---

### 任务 8：重组 HarnessInput，保留终态副作用编排

**文件：**

- 修改 `src/main/orchestrator/harness-adapter.ts`
- 修改 `src/main/orchestrator/harness-adapter-characterization.test.ts`

- [ ] 门面用 `PreparedHarnessRun` 与 `PreparedToolRuntime` 构造 `HarnessInput`，回调仍直接写同一个 run store。
- [ ] `onEvent` 继续在 `!signal.aborted` 时发送；`onCheckpoint/onToolLifecycle/onCompactionLifecycle` 字段逐项保持。
- [ ] 调用 `runCyreneHarness` 后在门面执行以下不可拆散顺序：

```text
compute completion reason + canonical terminal
→ compute terminalRunStatus
→ runStore.markTerminal
→ try reviewTracker.finalizeReview
→ completePlanRun
→ build AgentLoopResult
```

- [ ] 不要创建名为 `terminal-finalization.ts` 的模块把 store/review 副作用藏进去；这里的显式顺序就是审查边界。
- [ ] review tracker 获取或 finalize 失败仍 `console.error` 后继续；保留 `finalSession.createdAt` 作为 review 时间锚点。
- [ ] toolResults 仍为空数组、`totalUsage` 仍为 undefined、日志字段不变。
- [ ] 运行 characterization 与全部 adapter 测试。

---

### 任务 9：收瘦门面并做阶段验收

**文件：**

- 修改 `src/main/orchestrator/harness-adapter.ts`
- 修改必要测试 import，不迁移仓库调用方

- [ ] 门面只保留公开重导出、`runHarnessWithAdapter` 的生命周期编排和终态副作用。
- [ ] 使用显式重导出；不要用 `export *` 扩大接口。
- [ ] 搜索反向导入与副作用泄漏：

```powershell
rg -n 'from "\.\.\/\.\.\/harness-adapter"|from "\.\.\/\.\.\/\.\.\/harness-adapter"' src/main/orchestrator/harness/adapter
rg -n "markTerminal|finalizeReview" src/main/orchestrator/harness/adapter
```

预期：第一条无匹配；第二条无匹配，二者只出现在门面。

- [ ] 运行完整阶段验证：

```powershell
npx vitest run src/main/orchestrator/harness-adapter.test.ts src/main/orchestrator/harness-adapter-cancel.test.ts src/main/orchestrator/harness-adapter-git-tools.test.ts src/main/orchestrator/harness-adapter-characterization.test.ts src/main/orchestrator/harness/adapter/*.test.ts
npm run build:main
npm test
git diff --check
```

## 完成定义

- 原 `harness-adapter.ts` 的所有公开入口仍可用。
- `terminal-mapper.ts` 是无状态纯函数模块，不写 run store、不 finalize review。
- 恢复、prompt 物化、run store create、Harness 运行、terminal store、review 和计划收尾顺序被测试锁定。
- 取消 signal、计划只读双防线、checkpoint 和事件字段均未漂移。
- 针对性测试、`npm run build:main` 与 `npm test` 全部通过。
