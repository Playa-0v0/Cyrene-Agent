# Cyrene Harness Runtime Boundary P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 A → C → B → D 的顺序修复 Harness 生命周期：模型可以正常结束、用户可以可靠取消、工具结果对模型保持真实、Runtime retry/replay 不会误吞新的模型意图。

**Architecture:** 模型拥有 final intent；Harness 在模型不再调用工具时立即接受 final。Runtime 只负责权限、取消、超时、协议、工具执行安全和终态结算。一个 UI Run 只使用一个 canonical `runId`，由 bridge 创建并向下传递；终态经 exactly-once settlement gate 发出。工具失败统一归一化为结构化 observation；Ledger 按 logical invocation identity 防 Runtime replay，`UncertainEffectGuard` 独立按潜在副作用相关性阻止危险重复。

**Tech Stack:** TypeScript、Electron IPC、RxJS 7、`@ag-ui/core` 0.0.57、Vitest 4、Node/Electron 原生 `AbortController` / `AbortSignal`。

> **实施状态（2026-08-09）**：Task 1–5 已完成并通过自动化回归。Task 6 的分组回归、全量 Vitest 和 main/preload/renderer 构建已完成；桌面端 10 项人工 smoke 场景仍需在可交互应用中执行。未创建提交，保留当前学习分支的 dirty worktree。
>
> 下文 checkbox 保留为冻结时的施工步骤原稿，没有批量改写；实际进度以上述状态和 `runtime-boundary-and-change-plan.md` 的实施记录为准。

## Global Constraints

- [ ] 不清理、不 reset、不覆盖当前 dirty worktree 中与本计划无关的用户改动。
- [ ] 不新增第三方依赖。取消复用原生 `AbortSignal`；流生命周期复用 RxJS；终态复用 AG-UI 事件。
- [ ] `completionObligations` 从 P0 Harness 主路径和状态类型中退出；保留 `ToolDefinition.verificationPolicy*` 给现有 Plan、Shell policy 等其他消费者。
- [ ] 类型中不得出现 `continue_agent` 终态或 finalization 分支。
- [ ] `Run.status = cancelled` 只表示 Harness 不再推进；不得声称已发出的 HTTP、邮件、shell 子进程或其他外部效果已撤销。
- [ ] `Ledger` 只防同一个 logical invocation 的 Runtime retry/replay；相同 `tool + args` 的新 tool call 必须执行。
- [ ] `UncertainEffectGuard` 与 Ledger 分离；它可以拒绝危险工具调用，但不能阻止模型诚实 final。
- [ ] 每个 Task 先写失败测试，再做最小实现，再只跑该 Task 的测试；通过后才进入下一个 Task。
- [ ] 每次提交只包含当前 Task 的文件。若不希望在学习分支生成提交，可跳过 `git commit`，但保留相同的 Task 边界。

## Reuse Decisions

当前项目已经具备足够的通用基础设施，不需要重造以下能力：

| 需求 | 直接复用 | 本计划只补的胶水 | 限制 |
|---|---|---|---|
| 取消传播 | `AbortController` / `AbortSignal` | 把 bridge 的 signal 贯穿 Agent、Harness、工具、审批和提问 | 已发出的外部请求不保证能撤销 |
| 流清理 | RxJS Observable teardown | cancel 时先 abort，不再用 unsubscribe 代替业务取消 | unsubscribe 仍用于窗口销毁等消费端清理 |
| 终态事件 | `@ag-ui/core` 的 `RUN_FINISHED` / `RUN_ERROR` | 在 `RUN_FINISHED.result` 放 Cyrene 本地 status | 当前版本的 `outcome` 不支持 cancelled |
| 工具完成语义 | `normalizeToolExecutionOutcome` | 抽成唯一执行/归一化边界 | 旧工具的字符串错误需短期兼容 |
| 用户确认 | 当前 `requestUserClarification` 卡片链路 | 新增固定文案的 uncertain-effect 确认入口 | 不信任模型自行声称“用户已确认” |
| replay 缓存 | 当前 `ExecutionLedgerStore` | 改 key 语义，不另建缓存框架 | P0 仍是进程内、短生命周期 |

`@ag-ui/core@0.0.57` 当前类型中 `RUN_FINISHED.result` 是可选 `any`，而 `outcome` 只支持 `success` 或 `interrupt`。因此本计划使用：

```ts
{
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
  result: {
    status: "cancelled",
    reason: "user_cancelled",
    externalEffectsMayContinue: true,
  },
}
```

不向标准事件硬塞顶层 `status`，也不把 cancelled 伪装成 AG-UI interrupt。

## Current Baseline

计划编写前已执行：

```powershell
npx vitest run src/main/orchestrator/execution-ledger.test.ts src/main/orchestrator/fs-tools.test.ts src/main/agui-bridge.test.ts src/main/orchestrator/cyrene-agent.test.ts
```

当前结果是 29 个测试通过、1 个测试失败。唯一失败是 `cyrene-agent.test.ts` 仍期待默认 runtime 为 `langgraph`，而当前实现固定返回 `harness`。Task 1 将把这个旧断言改成当前已确定的架构事实。施工过程中不能把这份初始非全绿状态误报成新回归，也不能借此忽略后续新增失败。

---

## Task 1 — A: Remove Runtime-owned completion workflow

**Files:**

- Create: `src/main/orchestrator/harness/uncertain-effect-guard.ts`
- Create: `src/main/orchestrator/harness/cyrene-harness.test.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.ts`
- Modify: `src/main/orchestrator/harness/types.ts`
- Modify: `src/main/orchestrator/harness/tool-dispatcher.ts`
- Modify: `src/main/orchestrator/harness/index.ts`
- Modify: `src/main/orchestrator/cyrene-agent.test.ts`
- Delete: `src/main/orchestrator/harness/completion-policy.ts`

### Step 1: Write the failing Harness completion tests

- [ ] 新建 `cyrene-harness.test.ts`，mock vendor adapter 和 `fetch`，让模型依次返回“调用 mutation 工具”与“不再调用工具的 final”。
- [ ] 断言第二次模型响应后立即返回，不产生 `runtime_feedback`，也不发起第三次模型调用。
- [ ] 断言 `finalState` 不再拥有 `completionObligations`。
- [ ] 再 mock `dispatchToolCall` 返回 `outcome: "unknown"`，随后模型给出诚实 final；断言 final 仍被接受，`uncertainEffects` 仅作为事实保留。

核心测试形状：

```ts
expect(fetchMock).toHaveBeenCalledTimes(2);
expect(events.filter((event) => event.type === "runtime_feedback")).toEqual([]);
expect(result.finalAnswer).toBe("我无法确认刚才的外部操作是否成功。");
expect("completionObligations" in result.finalState).toBe(false);
expect(result.finalState.uncertainEffects).toHaveLength(1);
```

- [ ] 运行并确认失败：

```powershell
npx vitest run src/main/orchestrator/harness/cyrene-harness.test.ts
```

预期：当前 `checkCompletion()` 会要求 Agent 继续，测试失败。

### Step 2: Preserve only the uncertain-effect safety helpers

- [ ] 新建 `uncertain-effect-guard.ts`，先原样迁移 `isBlockedByUncertainEffect()` 和 `resolveUncertainEffect()`。
- [ ] 将 `tool-dispatcher.ts` 的 import 从 `completion-policy.ts` 改到新文件。
- [ ] `index.ts` 只从新文件导出 uncertain-effect API。

```ts
export function isBlockedByUncertainEffect(
  state: AgentState,
  fingerprint: string,
): boolean {
  return state.uncertainEffects.some((effect) => effect.fingerprint === fingerprint);
}
```

此时只做文件解耦，不在 A 阶段扩展 Guard 行为。

### Step 3: Delete completion ownership from the Harness path

- [ ] 从 `AgentState` 删除 `completionObligations`。
- [ ] 删除 `CompletionSemantics*`、`CompletionObligation` 类型和 `index.ts` 导出。
- [ ] 删除 `cyrene-harness.ts` 中 `updateObligations()`、`checkCompletion()` 的 import 与调用。
- [ ] 删除 `runtimeFeedbackMessage()`；保留 `runtime_feedback` 事件类型只做兼容，不再由正常结束路径发出。
- [ ] 模型响应没有 tool call 时直接 commit final：

```ts
const finalAnswer = streamController.commitProgressBuffer();
input.onEvent?.({ type: "final_answer", content: finalAnswer });
clock.stopActive();
return buildResult(finalAnswer, state, false, undefined, rounds);
```

- [ ] 删除 `completion-policy.ts`。
- [ ] 更新 compaction prompt，把“保留未完成的 obligation”改为只保留 todo 与 unresolved uncertain effects。
- [ ] 不删除 `ToolDefinition.verificationPolicy`、`verificationPolicyResolver` 或 `resolveVerificationPolicy()`，因为 `task-plan.ts`、shell policy 和其他工具仍在消费。

### Step 4: Correct the stale runtime-default test

- [ ] 将 `cyrene-agent.test.ts` 中仍期待 `resolveAgentRuntime(undefined) === "langgraph"` 的断言改为 `"harness"`。
- [ ] 不恢复已删除的旧 LangGraph loop 测试。

### Step 5: Verify and commit A

- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/cyrene-agent.test.ts
npm run build:main
```

- [ ] 搜索退出条件残留：

```powershell
rg -n "completionObligations|checkCompletion|updateObligations|continue_agent" src/main/orchestrator/harness
```

预期：无主路径命中；`uncertainEffects` 仍存在。

- [ ] 可选提交：

```powershell
git add src/main/orchestrator/harness/uncertain-effect-guard.ts src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/harness/cyrene-harness.ts src/main/orchestrator/harness/types.ts src/main/orchestrator/harness/tool-dispatcher.ts src/main/orchestrator/harness/index.ts src/main/orchestrator/harness/completion-policy.ts src/main/orchestrator/cyrene-agent.test.ts
git commit -m "refactor(harness): let model final end the run"
```

---

## Task 2 — C1: Establish canonical run identity and exactly-once settlement

**Files:**

- Create: `src/shared/run-terminal.ts`
- Create: `src/main/orchestrator/run-settlement.ts`
- Create: `src/main/orchestrator/run-settlement.test.ts`
- Modify: `src/main/orchestrator/cyrene-agent.ts`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/harness/types.ts`
- Modify: `src/main/agui-bridge.ts`
- Modify: `src/main/agui-bridge.test.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`

### Step 1: Define the terminal vocabulary once

- [ ] 新建共享类型：

```ts
export type CyreneTerminalStatus =
  | "success"
  | "cancelled"
  | "timeout"
  | "runtime_error";

export interface CyreneRunTerminalResult {
  status: CyreneTerminalStatus;
  reason?: "user_cancelled" | "run_timeout" | "call_timeout" | "max_rounds";
  externalEffectsMayContinue: boolean;
}

export interface AguiRunAck {
  success: boolean;
  runId: string;
  error?: string;
}
```

- [ ] `HarnessResult` 不再用模糊的 `terminated: boolean` 表达所有情况；增加明确 `terminal`，或保留旧字段仅作兼容但以 `terminal` 为唯一新消费入口。
- [ ] `TwoPhaseFcResult` 与 `CyreneRunResult` 增加同一个 `terminal` 字段。

### Step 2: Write and implement the exactly-once gate

- [ ] 为 `run-settlement.ts` 先写测试：第一次 `trySettle()` 返回 true，后续任何 success/cancel/error race 均返回 false，并保留第一次结果。

```ts
const gate = new RunSettlementGate();
expect(gate.trySettle({ status: "cancelled", externalEffectsMayContinue: true })).toBe(true);
expect(gate.trySettle({ status: "success", externalEffectsMayContinue: false })).toBe(false);
expect(gate.settlement?.status).toBe("cancelled");
```

- [ ] 实现一个纯状态 gate；它不决定 Agent 是否继续，也不包含业务完成判断。

```ts
export class RunSettlementGate {
  private value?: CyreneRunTerminalResult;

  get settlement(): CyreneRunTerminalResult | undefined {
    return this.value;
  }

  trySettle(value: CyreneRunTerminalResult): boolean {
    if (this.value) return false;
    this.value = value;
    return true;
  }
}
```

### Step 3: Make bridge-created runId canonical

- [ ] 给 `CyreneRunOptions` 增加 `runId?: string`；保留 fallback 供 scheduler/channel 等非 bridge 调用方使用。
- [ ] `CyreneAgent.runWithEvents()` 使用：

```ts
const runId = options.runId ?? createRunId();
```

- [ ] `agui-bridge.ts` 创建 runId 后把它写入 `buildOptionsFn()` 的结果再调用 Agent。
- [ ] `runHarnessWithAdapter()` 删除 `harness-${Date.now()}`，直接使用 `options.runId`；若内部调用方未传，则由 `CyreneAgent` 在进入 adapter 前补齐。
- [ ] `ToolContext.runId`、Harness 事件、AG-UI `RUN_STARTED` / terminal、choice identity 全部使用同一个值。
- [ ] `ExecutionLedgerStore.forScope()` 在 D 阶段改用该 runId；本阶段先确保 runId 可达。

### Step 4: Put terminal facts into the supported AG-UI field

- [ ] success 发：

```ts
{
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
  result: { status: "success", externalEffectsMayContinue: false },
  outcome: { type: "success" },
}
```

- [ ] cancelled / timeout 也发 `RUN_FINISHED`，但只写 `result`，不伪造 `outcome`。
- [ ] runtime error 仍发 `RUN_ERROR`；bridge 的 settlement gate 将其视作 `runtime_error` 终态，防止随后再发 `RUN_FINISHED`。
- [ ] `max_rounds` 映射为 `{ status: "timeout", reason: "max_rounds" }`，不新增第五种顶层终态。
- [ ] bridge 继续把 success 的 `RUN_FINISHED` 延迟到 sticker/memory 等成功后副作用之后；cancelled/timeout 不运行这些“成功收尾副作用”，直接结算。

### Step 5: Make the invoke acknowledgement authoritative in renderer

- [ ] 更新 preload 和 `ChatPage.tsx` 的 `AguiApi.run` 返回类型为 `Promise<AguiRunAck>`。
- [ ] `await api.run()` 后立即保存 `ack.runId`；`RUN_STARTED.runId` 必须与其相同，不能再形成第二个 renderer run identity。
- [ ] 终态仍以事件为准；cancel invoke 成功不等于 Run 已结算，UI 等待 exactly-one `RUN_FINISHED` / `RUN_ERROR` 做最终清理。

### Step 6: Test identity and terminal races

- [ ] 在 `agui-bridge.test.ts` 增加：
  - ack、buildOptions、`RUN_STARTED`、`RUN_FINISHED` 使用同一个 runId；
  - upstream 连续发两个 terminal 时 renderer sender 只收到一个；
  - success 之后的 error 不再产生第二个终态；
  - cancelled result 不触发 `onRunFinished` 的成功副作用。
- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/run-settlement.test.ts src/main/agui-bridge.test.ts src/main/orchestrator/cyrene-agent.test.ts
npm run build:main
npm run build:preload
npm run build:renderer
```

- [ ] 可选提交：

```powershell
git add src/shared/run-terminal.ts src/main/orchestrator/run-settlement.ts src/main/orchestrator/run-settlement.test.ts src/main/orchestrator/cyrene-agent.ts src/main/orchestrator/harness-adapter.ts src/main/orchestrator/harness/types.ts src/main/agui-bridge.ts src/main/agui-bridge.test.ts src/preload/index.ts src/renderer/react/features/chat/pages/ChatPage.tsx
git commit -m "refactor(runtime): canonicalize run settlement"
```

---

## Task 3 — C2: Make user cancellation cooperative and end-to-end

**Files:**

- Create: `src/main/orchestrator/abort-utils.ts`
- Create: `src/main/orchestrator/abort-utils.test.ts`
- Create: `src/main/permission.test.ts`
- Modify: `src/main/agui-bridge.ts`
- Modify: `src/main/agui-bridge.test.ts`
- Modify: `src/main/orchestrator/cyrene-agent.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.test.ts`
- Modify: `src/main/orchestrator/harness/tool-dispatcher.ts`
- Modify: `src/main/orchestrator/harness-adapter.ts`
- Modify: `src/main/orchestrator/harness/retry-policy.ts`
- Modify: `src/main/orchestrator/tool-context.ts`
- Modify: `src/main/permission.ts`
- Modify: `src/main/user-choice.ts`
- Modify: `src/main/user-choice.test.ts`

### Step 1: Write cancellation tests before changing implementation

- [ ] bridge test：`AGUI_CANCEL(runId)` 会 abort 对应 run 的 signal，而不是只 `subscription.unsubscribe()`。
- [ ] Harness test：取消发生在 LLM fetch、retry backoff、普通工具 Promise、permission wait、ask_user wait 的任一阶段时，都能结束为 cancelled。
- [ ] 断言 cancelled 不发 `final_answer`，只发一个 terminal，且 `externalEffectsMayContinue: true`。
- [ ] 断言取消一个 run 不影响另一个 run。
- [ ] 断言 pending approval / choice 被从 map 清理，超时 timer 不会在取消后再次 settle。

### Step 2: Add a small abortable-wait adapter

- [ ] 使用原生 signal 实现最小 `raceWithAbort()`，不要建立自定义事件总线：

```ts
export async function raceWithAbort<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
```

- [ ] 测试必须覆盖 listener 清理、先完成、先取消三个分支。
- [ ] 注释明确：该 helper 只停止等待，不保证底层外部效果撤销。

### Step 3: Change bridge cancel from teardown to abort

- [ ] `activeRuns` 存储 `{ controller, subscription, settlement, endLifecycle }`。
- [ ] bridge 构造 `AbortController`，把 `controller.signal` 与 canonical runId 一起注入 `CyreneRunOptions`。
- [ ] `AGUI_CANCEL` 只调用对应 controller 的 `abort({ source: "user_cancelled" })`；不立即 unsubscribe、不立即 delete、不立即 `endLifecycle()`。
- [ ] terminal callback 负责 exactly-once send、delete 和 lifecycle cleanup。
- [ ] 无 runId 的“取消全部”逐个 abort；每个 run 独立结算。
- [ ] 只有窗口销毁或纯消费端 teardown 才 unsubscribe，并分类为 `window_destroyed` / `upstream_cleanup`。

### Step 4: Link the upstream signal into CyreneAgent

- [ ] 给 `CyreneRunOptions` 增加 `signal?: AbortSignal`。
- [ ] 在 `runWithEvents()` 中把 upstream abort 连接到现有内部 `markAbort()`，保持 first-source-wins：

```ts
const onUpstreamAbort = () => markAbort("user_cancelled");
options.signal?.addEventListener("abort", onUpstreamAbort, { once: true });
```

- [ ] complete/error/teardown 时移除 listener。
- [ ] Observable teardown 不再无条件覆盖成 `user_cancelled`。
- [ ] `classifyRunError()` 的 user cancel / timeout 分支构造结构化 terminal；未知 runtime error 继续走 error channel。

### Step 5: Make Harness cancellation a terminal result, not a fake answer

- [ ] 顶层统一捕获 AbortError；如果 `input.signal.aborted`，返回 cancelled result，`finalAnswer` 为空。
- [ ] 删除“最终回复被取消。”这种模型回复伪装。
- [ ] LLM 调用 catch 先区分取消，再处理真正的模型错误；真正错误向上抛，由 settlement 发 `RUN_ERROR`。
- [ ] 普通工具执行和内置工具等待使用 `raceWithAbort()`；若 signal 已 abort，dispatcher 必须 rethrow AbortError，不能归类成普通工具失败。
- [ ] `sleepWithJitter(ms, signal?)` 支持取消，Harness retry 传入同一 signal。
- [ ] `HarnessEvent.final_answer` 只允许 success 或 timeout fallback；cancelled 不发送。

### Step 6: Propagate signal through tool, permission, and choice boundaries

- [ ] `harness-adapter.ts` 的 `ToolContext` 补上 `signal`（类型已经存在，不再新增第二个字段）。
- [ ] adapter 的 permission closure 把 signal 传入 `checkPermission()`。
- [ ] `requestApproval(request, signal?)` 在 abort 时 clear timer、delete pending，并 reject AbortError。
- [ ] `requestUserClarification(card, sender, onSettled, identity, signal?)` 同样清理 pending；`ChoiceSettlementReason` 增加 `"cancelled"` 并只通知一次。
- [ ] bridge 注入的 `requestUserClarification` closure 将本 run signal 传到现有卡片链路。
- [ ] `executeAskUser()` 遇 AbortError 必须 rethrow；只有真正的用户等待超时才返回 timeout observation。

### Step 7: Verify cancellation invariants

- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/abort-utils.test.ts src/main/orchestrator/harness/cyrene-harness.test.ts src/main/agui-bridge.test.ts src/main/permission.test.ts src/main/user-choice.test.ts src/main/orchestrator/cyrene-agent.test.ts
npm run build:main
npm run build:preload
npm run build:renderer
```

- [ ] 人工 smoke test：启动一次会等待模型的 Work run，点击停止；确认 UI 收到一个 cancelled terminal，不再继续吐字或开启下一轮。
- [ ] 再启动一个已发出长耗时工具的 run 后取消；确认 Harness 立即停止推进，日志明确“external effects may continue”，且不声称底层操作已撤销。

- [ ] 可选提交：

```powershell
git add src/main/agui-bridge.ts src/main/agui-bridge.test.ts src/main/orchestrator/abort-utils.ts src/main/orchestrator/abort-utils.test.ts src/main/orchestrator/cyrene-agent.ts src/main/orchestrator/harness/cyrene-harness.ts src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/harness/tool-dispatcher.ts src/main/orchestrator/harness/retry-policy.ts src/main/orchestrator/harness-adapter.ts src/main/orchestrator/tool-context.ts src/main/permission.ts src/main/permission.test.ts src/main/user-choice.ts src/main/user-choice.test.ts
git commit -m "fix(runtime): propagate cancellation through harness"
```

---

## Task 4 — B: Make tool success and failure truthful

**Files:**

- Create: `src/main/orchestrator/tool-execution-error.ts`
- Create: `src/main/orchestrator/tool-executor.ts`
- Create: `src/main/orchestrator/tool-executor.test.ts`
- Modify: `src/main/orchestrator/tool-outcome-normalizer.ts`
- Modify: `src/main/orchestrator/cyrene-agent.ts`
- Modify: `src/main/orchestrator/harness/types.ts`
- Modify: `src/main/orchestrator/harness/tool-dispatcher.ts`
- Create: `src/main/orchestrator/harness/tool-dispatcher.test.ts`
- Modify: `src/main/orchestrator/harness/error-classifier.ts`
- Modify: `src/main/orchestrator/fs-tools.ts`
- Modify: `src/main/orchestrator/fs-tools.test.ts`

### Step 1: Lock the contract with tests

- [ ] fake tool 正常 return：归一化为 `succeeded`。
- [ ] fake tool 抛 typed error：保留 `code`、`category`、`retryable` 与 `effectState`。
- [ ] legacy JSON `{ success: false }`：兼容为失败。
- [ ] legacy 字符串仅在以 `[错误]` / `[拒绝]` 开头时兼容为失败；普通文本包含单词 `error` 仍是成功。
- [ ] run 已取消产生的 AbortError 必须向上抛，不得转成工具失败 observation。
- [ ] `write_file` 相对路径、建目录失败、写入失败都 reject typed error；成功返回存在性、字节数等真实证据；零字节文件仍可成功。

### Step 2: Add the typed error primitive

- [ ] 将 `ToolErrorCategory` 从 Harness 专属类型文件移到 `tool-execution-error.ts`，再由 `harness/types.ts` import + re-export；通用工具执行层不得反向依赖 Harness。
- [ ] 定义：

```ts
export type ToolErrorCategory =
  | "transient"
  | "timeout"
  | "rate_limited"
  | "not_found"
  | "permission_denied"
  | "invalid_arguments"
  | "semantic_failure"
  | "partial_failure"
  | "fatal"
  | "runtime_safety";

export class ToolExecutionError extends Error {
  readonly name = "ToolExecutionError";

  constructor(
    readonly code: string,
    message: string,
    readonly category: ToolErrorCategory,
    readonly retryable = false,
    readonly effectState: "not_applied" | "unknown" = "not_applied",
  ) {
    super(message);
  }
}
```

- [ ] `classifyToolError()` 优先读取 typed fields；只有 legacy Error 才进入现有文本兼容分类。
- [ ] 不再让 dispatcher 丢失工具抛出的 `code`。

### Step 3: Extract one reusable tool execution boundary

- [ ] 把 `cyrene-agent.ts` 已有的 `{ success:false }` 检测与 `normalizeToolExecutionOutcome()` 合并到 `tool-executor.ts`。
- [ ] `cyrene-agent.ts` 和 Harness dispatcher 都调用该模块，删除两处重复 try/catch。
- [ ] 唯一边界完成：execute、typed throw、legacy compatibility、outcome normalize；权限检查仍在调用方之前。

```ts
const outcome = await executeToolDefinition(tool, args, context);
const normalized = normalizeToolExecutionOutcome(outcome);
```

- [ ] compatibility shim 加醒目注释和测试。P0 不批量修改所有 `Promise<string>` success payload，也不把“包含 error 字段的成功 JSON”误判为失败。

### Step 4: Migrate write_file first

- [ ] 将 `executeWriteFile()` 中所有以 `[错误]` 开头的 return 改为抛出对应的 `ToolExecutionError`。
- [ ] 先完成写入，再用 stat/readback 形成成功 evidence；stat 失败不能返回 success。
- [ ] 成功 payload 至少包含：

```ts
{
  success: true,
  tool: "write_file",
  path: filePath,
  append,
  exists: true,
  sizeBytes: stat.size,
  writtenBytes: Buffer.byteLength(content, "utf8"),
}
```

- [ ] `verificationPolicyResolver` 字段可继续留在工具定义上供其他消费者使用，但 Harness 不读取它决定是否结束。

### Step 5: Normalize Dispatcher observations

- [ ] 成功 observation 只来自 normalized `succeeded`。
- [ ] 失败 observation 使用 typed category/code/retryable；`rawResult.status` 必须是 `failed`。
- [ ] 日志/preview 可以截断，但结构化 outcome 不能因截断丢失。
- [ ] 取消 AbortError 继续向上冒泡。

### Step 6: Verify and inventory remaining legacy tools

- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/tool-executor.test.ts src/main/orchestrator/harness/tool-dispatcher.test.ts src/main/orchestrator/fs-tools.test.ts src/main/orchestrator/cyrene-agent.test.ts
npm run build:main
```

- [ ] 生成后续迁移清单，但不在 P0 顺手重写所有工具：

```powershell
rg -n 'return\s+[`"]\[错误\]|success:\s*false' src/main/orchestrator -g '*.ts'
```

- [ ] 将清单写到本计划末尾的“P1 follow-ups”，每个工具后续单独迁移。兼容 shim 在清单归零前不得删除。

- [ ] 可选提交：

```powershell
git add src/main/orchestrator/tool-execution-error.ts src/main/orchestrator/tool-executor.ts src/main/orchestrator/tool-executor.test.ts src/main/orchestrator/tool-outcome-normalizer.ts src/main/orchestrator/cyrene-agent.ts src/main/orchestrator/harness/types.ts src/main/orchestrator/harness/tool-dispatcher.ts src/main/orchestrator/harness/tool-dispatcher.test.ts src/main/orchestrator/harness/error-classifier.ts src/main/orchestrator/fs-tools.ts src/main/orchestrator/fs-tools.test.ts
git commit -m "fix(tools): normalize typed execution failures"
```

---

## Task 5 — D: Separate logical replay protection from uncertain side-effect safety

**Files:**

- Modify: `src/main/orchestrator/execution-ledger.ts`
- Modify: `src/main/orchestrator/execution-ledger.test.ts`
- Modify: `src/main/orchestrator/cyrene-agent.ts`
- Modify: `src/main/orchestrator/harness/types.ts`
- Modify: `src/main/orchestrator/harness/tool-dispatcher.ts`
- Modify: `src/main/orchestrator/harness/tool-dispatcher.test.ts`
- Modify: `src/main/orchestrator/harness/uncertain-effect-guard.ts`
- Create: `src/main/orchestrator/harness/uncertain-effect-guard.test.ts`
- Modify: `src/main/orchestrator/harness/builtin-tools.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.ts`
- Modify: `src/main/orchestrator/harness/cyrene-harness.test.ts`

### Step 1: Replace args-based Ledger expectations with intent-based tests

- [ ] 删除“same capability + target + args 必然 cache hit”的旧断言。
- [ ] 新增以下不可缺少的四个测试：

```ts
const facts = {
  capability: "send_email",
  targetRefs: ["recipient@example.com"],
  args: { to: "recipient@example.com", subject: "same", body: "same" },
};

// 同一个 logical invocation 被 Runtime replay：只执行一次
await ledger.execute({ logicalInvocationId: "run-1:call-123", ...facts }, execute);
await ledger.execute({ logicalInvocationId: "run-1:call-123", ...facts }, execute);
expect(execute).toHaveBeenCalledTimes(1);

// 模型新的 tool_call：即使 args 完全相同也执行
await ledger.execute({ logicalInvocationId: "run-1:call-456", ...facts }, execute);
expect(execute).toHaveBeenCalledTimes(2);
```

- [ ] 同 ID 但 capability/args 不同属于协议冲突，返回或抛 `E_LOGICAL_INVOCATION_CONFLICT`，不能命中旧结果。
- [ ] failed / unknown 不 short-circuit 后续 Runtime retry；只有 terminal success 可 replay。

### Step 2: Change Ledger identity without replacing its bounded store

- [ ] `ExecutionFingerprintInput` 政名为 `LogicalInvocationInput`，增加必填 `logicalInvocationId`。
- [ ] Map 主 key 使用 logicalInvocationId；另存 request fingerprint 只用于检测“同 ID 不同事实”的协议冲突，不用于跨 ID 去重。
- [ ] 保留 `ExecutionLedgerStore` 的 TTL 和 scope 上限。
- [ ] `CyreneAgent` 使用 canonical runId 建 scope：

```ts
executionLedgers.forScope(runId)
```

- [ ] dispatcher 传：

```ts
logicalInvocationId: `${ctx.toolContext?.runId ?? "unknown-run"}:${call.id}`
```

- [ ] cache hit 的 ToolCallResult 标记 `deduplicated: true`，日志用 `replayed`，避免让模型误以为是新的执行。

### Step 3: Make uncertain effect a separate typed decision

- [ ] 给 `UncertainEffect` 增加稳定 `id` 和可选的一次性用户授权事实：

```ts
export interface UncertainEffect {
  id: string;
  toolCallId: string;
  fingerprint: string;
  toolName: string;
  message: string;
  repeatAuthorization?: { source: "user"; grantedAt: number };
}
```

- [ ] `uncertain-effect-guard.ts` 返回结构化 decision，而不只是 boolean：

```ts
type UncertainEffectDecision =
  | { allowed: true }
  | { allowed: false; effect: UncertainEffect; message: string };
```

- [ ] Guard 仍按“可能重复副作用”的 fingerprint 判断，因为它处理的是副作用相关性，不是 logical identity。
- [ ] 阻止只发生在新的 non-idempotent request 上；read-only / idempotent mutation 不被旧 uncertain effect 无条件挡住。
- [ ] blocked observation 包含 `effectId`、原 tool call id 和固定建议：查证、请求用户明确确认、或诚实结束。
- [ ] Harness 模型无 tool call 时仍直接 final；Guard 不参与 final settlement。

### Step 4: Produce unknown only when Runtime truly cannot know

- [ ] dispatcher 使用 Task 4 的 typed error：
  - `effectState: "unknown"` + non-idempotent → `outcome: "unknown"`；
  - non-idempotent timeout 且 run 本身未取消 → 保守映射 unknown；
  - run signal 已取消 → 向上抛 AbortError，由 cancellation settlement 处理；
  - 明确 `not_applied` → failure。
- [ ] unknown 不自动 retry，不写入 Ledger success cache，写入 `state.uncertainEffects` 并暂停本轮后续危险调用。

### Step 5: Reuse ask_user UI for a trustworthy explicit override

- [ ] 在 Harness built-ins 增加 `confirm_uncertain_effect`，参数只接受 `effectId`。
- [ ] Runtime 根据 state 中的真实 effect 生成固定确认卡，模型不能提供确认文案：

```text
前一次 <toolName> 的结果无法确认。再次执行可能产生重复副作用。
是否仍要允许下一次相同操作？
```

- [ ] 卡片复用现有 `requestUserClarification`，固定选项为 `allow_repeat` / `do_not_repeat`，`allowCustom: false`。
- [ ] 只有真实用户选择 `allow_repeat` 时，Guard 给该 effect 一次性授权；下一次匹配调用消费授权并移除旧 effect。
- [ ] 模型自行声称“用户同意了”、普通 `ask_user` 文本或相同 args 都不能解除 Guard。
- [ ] `confirm_uncertain_effect` 与 `ask_user` 都是排他内置工具；同轮其他调用返回 `not_executed`。
- [ ] 用户拒绝或超时后 effect 保持 unresolved；Agent 仍可 final。

### Step 6: Verify Ledger/Guard separation

- [ ] 测试矩阵：

| 场景 | Ledger | Guard | 是否执行 |
|---|---|---|---|
| Runtime replay 同 call id | hit | 不参与 | 否，返回原成功事实 |
| 新 call id、相同 args、无 uncertainty | miss | allow | 是 |
| 新 call id、相同 args、有 unresolved unknown | miss | block | 否，返回 safety observation |
| 新 call id、不同 args | miss | allow | 是 |
| 用户固定卡片明确授权 | miss | allow once | 是一次 |
| 模型给 final、state 有 unknown | 不参与 | 不参与 | Run 正常结算 |

- [ ] 运行：

```powershell
npx vitest run src/main/orchestrator/execution-ledger.test.ts src/main/orchestrator/harness/uncertain-effect-guard.test.ts src/main/orchestrator/harness/tool-dispatcher.test.ts src/main/orchestrator/harness/cyrene-harness.test.ts
npm run build:main
```

- [ ] 可选提交：

```powershell
git add src/main/orchestrator/execution-ledger.ts src/main/orchestrator/execution-ledger.test.ts src/main/orchestrator/cyrene-agent.ts src/main/orchestrator/harness/types.ts src/main/orchestrator/harness/tool-dispatcher.ts src/main/orchestrator/harness/tool-dispatcher.test.ts src/main/orchestrator/harness/uncertain-effect-guard.ts src/main/orchestrator/harness/uncertain-effect-guard.test.ts src/main/orchestrator/harness/builtin-tools.ts src/main/orchestrator/harness/cyrene-harness.ts src/main/orchestrator/harness/cyrene-harness.test.ts
git commit -m "fix(runtime): separate replay from uncertain effects"
```

---

## Task 6 — Full regression, manual lifecycle audit, and documentation sync

**Files:**

- Modify: `docs/design/2026-08-09-harness-runtime-boundary/runtime-boundary-and-change-plan.md`
- Modify: `docs/design/2026-08-09-harness-runtime-boundary/implementation-plan.md`
- Modify only if tests expose a scoped defect: files changed in Tasks 1–5

### Step 1: Run focused regression in frozen order

- [ ] A completion：

```powershell
npx vitest run src/main/orchestrator/harness/cyrene-harness.test.ts
```

- [ ] C cancellation/settlement：

```powershell
npx vitest run src/main/orchestrator/run-settlement.test.ts src/main/orchestrator/abort-utils.test.ts src/main/agui-bridge.test.ts src/main/permission.test.ts src/main/user-choice.test.ts src/main/orchestrator/cyrene-agent.test.ts
```

- [ ] B tool contract：

```powershell
npx vitest run src/main/orchestrator/tool-executor.test.ts src/main/orchestrator/harness/tool-dispatcher.test.ts src/main/orchestrator/fs-tools.test.ts
```

- [ ] D Ledger/Guard：

```powershell
npx vitest run src/main/orchestrator/execution-ledger.test.ts src/main/orchestrator/harness/uncertain-effect-guard.test.ts
```

### Step 2: Run project-wide verification

- [ ] 运行：

```powershell
npm test
npm run build
```

- [ ] 若全量测试存在本计划前就已存在的失败，记录精确测试名与证据，不把它混成 P0 修复成功；本计划触碰到的测试必须全部通过。
- [ ] 再次搜索边界违规：

```powershell
rg -n "completionObligations|checkCompletion|updateObligations|continue_agent" src/main/orchestrator/harness
rg -n "harness-\$\{Date\.now|subscription\.unsubscribe\(\).*cancel|capability.*targetRefs.*args" src/main
```

### Step 3: Manual acceptance scenarios

- [ ] 场景 1：纯聊天/纯回答，模型 final 后一次结束。
- [ ] 场景 2：`write_file` 成功后模型选择 final；Runtime 不要求额外验证。
- [ ] 场景 3：模型认为需要验证并主动调用 read/test；Runtime如实执行，但不强迫。
- [ ] 场景 4：LLM 等待中点击停止；一个 cancelled terminal，UI 清理完成。
- [ ] 场景 5：ask_user / permission 卡片等待中点击停止；卡片关闭、pending 清理、Run cancelled。
- [ ] 场景 6：已发出的长外部调用中点击停止；Harness 停止推进，UI/日志提示外部效果可能继续。
- [ ] 场景 7：同一个 logical call Runtime replay；工具只执行一次。
- [ ] 场景 8：模型新 call id、相同 args；无 uncertainty 时再次执行。
- [ ] 场景 9：non-idempotent outcome unknown 后，模型再次调用相同操作；Guard 阻止但允许模型 final。
- [ ] 场景 10：用户通过固定确认卡明确授权；只放行一次。

### Step 4: Update the design record

- [ ] 在 `runtime-boundary-and-change-plan.md` 顶部写实施状态，不重写已冻结的不变量。
- [ ] 记录实际 `@ag-ui/core` 表达方式：`RUN_FINISHED.result.status`，runtime error 用 `RUN_ERROR`。
- [ ] 记录实际仍存在的 legacy tool failure 清单和 compatibility shim 移除条件。
- [ ] 记录 P0 的 Ledger 仅为进程内、短生命周期；持久化 replay protection 属于 P1。

- [ ] 可选最终提交：

```powershell
git add docs/design/2026-08-09-harness-runtime-boundary
git commit -m "docs(runtime): record harness p0 verification"
```

---

## Acceptance Invariants

施工完成后，以下断言必须同时成立：

```text
1. Model no-tool response -> final immediately.
2. Runtime has no continue_agent settlement.
3. User cancel -> AbortSignal -> Harness stops advancing -> exactly one cancelled terminal.
4. canonical runId is identical in ack, Agent, Harness, ToolContext, choices and terminal events.
5. cancelled does not claim external side effects were rolled back.
6. Tool success and failure are normalized truthfully at one boundary.
7. Ledger identity is runId + toolCallId, never tool + args.
8. New model tool_call with the same args is a new intent.
9. Unresolved unknown non-idempotent effect can block a related new action.
10. UncertainEffectGuard never blocks honest final.
11. User authorization is proven by a Runtime-owned confirmation card and is consumed once.
12. Every canonical runId has exactly one terminal settlement.
```

## Explicitly Out of P0 Scope

- 持久化 Ledger、跨进程重启恢复 replay protection。
- 对所有历史工具一次性迁移 typed success object。
- 新建 advisory verification planner、completion workflow 或自动追加验证步骤。
- 自动撤销已经发出的 HTTP/email/shell 外部效果。
- 用模型语义判断“任务质量是否足够好”。
- 删除其他模块仍在使用的 `verificationPolicy` 元数据。
- 将 AG-UI 本地 cancelled status 上游化成新的标准事件类型。

## P1 Follow-ups

- [ ] 按 Task 4 inventory 逐工具消除 `[错误]` / `{ success:false }` legacy returns：`document-tools.ts`、`built-in-tools.ts`、`fs-tools.ts`（除 `write_file`）、`email-tools.ts`、`history-tools.ts`、`life-tools.ts`、`search-code-tools.ts`、`travel-tools.ts`。生产清单归零后删除 compatibility shim。
- [ ] 评估 durable Ledger（SQLite 或项目现有持久化层），key 仍保持 canonical runId + logical tool call id。
- [ ] 若业务确有“合并前必须通过测试”等硬规则，设计显式 Stop Hook；它只能拒绝特定受控动作，不能恢复通用 `continue_agent` completion workflow。
- [ ] 评估对可取消的 shell child process 使用现有进程句柄做 best-effort terminate；UI 文案仍保留“不保证副作用未发生”。
