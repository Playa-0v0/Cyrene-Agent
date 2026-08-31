# Harness 并行调度与运行存储优化施工方案

> **关联文档**：[2026-08-25-harness-parallel-scheduling-known-issues.md](./2026-08-25-harness-parallel-scheduling-known-issues.md)（问题 1–5 的调研与复现结论）
> **施工方式**：按批次执行，每批独立 Git 提交、可单独回滚；每项先写失败测试，再写最小实现，再跑定向验证 + 全量回归。
> **修订记录**：v2（2026-08-25）——按外部 review 收紧 5 处并发边界：①终态统一 settlement（cancelled 复用 settleRun，补发 terminal 快照）；②execute 出错槽位由"接受缺口"升级为合成失败结果（transcript 闭合）；③takeover await 后重新竞争 guard + compare-and-delete 释放 + 防御上限；④commit 抛错也必须 drain 在飞调用（finally 兜底）；⑤测试断言确定性锁死发射进度 + 补并发 takeover 用例；另补 writeIndexNow 取消 pending lazy write、删除 IPC 时序正确性论证。

---

## 1. 目标

修复已知问题文档中的 5 项问题，按风险排序分三个施工批次 + 一个演进方向：

| 批次 | 覆盖问题 | 性质 | 优先级 |
|---|---|---|---|
| 一 | 问题 1 + 2 + 3（调度器正确性） | 正确性：transcript 完整性、终态结算 | P0 |
| 二 | 问题 4（会话级运行守卫） | 防御：堵住 reload 并发漏洞 | P0 |
| 三 | 问题 5 P0（存储写放大减法） | 性能：纯减法，无语义变化 | P1 |
| 四 | 问题 5 P1（journal 化持久层） | 演进：**本轮不施工**，仅记录设计方向 | P2 |

---

## 2. 冻结边界（不变量）

1. **调度器顺序契约**：模型可见结果始终按原始 tool-call 顺序提交，完成顺序不得替代该顺序（现有契约，保持不变）。
2. **事实不丢弃**：已发射并执行完毕的调用，其结果必须 `commit`；只有从未发射的调用才允许 `notExecuted`。execute 抛错的槽位以**合成失败结果**（`outcome:"failure"` + fatal 类别，经 `notExecuted(execution, "execution_error")` 回调构造）提交，保证 transcript 闭合。唯一允许的例外：`commit` 消费方自身抛错的槽位（基础设施故障，run 随即以 error 终态终止，不再发起 LLM 请求，洞不会触发协议 400）。
3. **终态统一结算**：所有终态（error / timeout / cancelled / success / checkpoint_failure）共享同一 settlement helper（停表 → terminal `context_usage` 快照 → checkpoint → checkpointFailure 降级为 error）。`finishRun` 与 `cancelledResult` 均基于该 helper，仅参数差异（cancelled 传空 finalAnswer + `terminal.status="cancelled"` + `externalEffectsMayContinue:true`）；cancelled 同样获得 terminal 快照（上下文环 UI 终态数据）。工具轮异常不得冲出 `runCyreneHarness`。
4. **checkpoint JSON-serializable 契约**：payload 必须严格 JSON 可序列化（不得含 Date / Map / Set / BigInt / class instance）。此契约改由**消费方同步克隆**保证：`onCheckpoint` 消费方（run-store / task-session-store）必须在回调返回前完成克隆或落盘，不得持有跨 await 的活引用。
5. **halt 语义**：halt = 停止本轮后续调度，**不结束 run**。模型在下一轮看到全部已执行结果（含 fatal / unknown 的诚实结果）后自行决策（v3 §5.5.1.1 uncertainEffects 由模型 reconcile 或 ask 用户）。本轮不改变该语义，只修复"结果凭空消失"。
6. **守卫按 session 粒度**：不同会话允许并发 run（多窗口/多模式是既有能力）；同一会话同一时刻最多一个 active run。
7. **渲染端排队机制不变**：`isSessionBusy` → pendingQueue → finally drain 链路保持原样，仅作为 UX 优化；**无论 IPC 时序如何，主进程守卫都是最终一致性边界**（正确性不依赖跨进程调度顺序）。
8. **恢复语义不变**：`prepareHarnessRecovery` 按 `session.toolCalls` 修补残缺 transcript 的兜底机制保留（作为取消/崩溃路径的最后防线）。

---

## 3. 设计

### 3.1 批次一：调度器正确性（问题 1 / 2 / 3）

三个问题同根：`runParallelGroup` 的提交循环和错误路径在"提前终止"（halt / error / cancel）时丢弃已产生的事实结果。一次性修复。

#### 3.1.1 核心修改：`runParallelGroup` 循环门调整

```ts
// 现状问题：
// - 提交循环带 !halted 门 → halt 后已执行结果滞留 settled 数组，凭空消失（问题 1）
// - cancel 分支 continue 跳过提交 → 已结算结果丢弃（问题 3）
// - execute 错误立即 throw → 在飞兄弟调用变浮空 promise（问题 2）
// - commit 抛错直接逃逸 → 同样留下浮空 promise（review 补充）

// 修改后（示意）：
let firstError: unknown;   // execute / commit 错误统一记录，drain 完毕后统一抛出

try {
  while (active.size > 0) {
    const next = await Promise.race(active.values());
    active.delete(next.index);
    if (next.error !== undefined) {
      if (options.signal?.aborted) { cancelled = true; continue; }
      firstError ??= next.error;
      // 出错槽位标记合成：drain 后以合成失败结果提交，让 commitIndex 能推进到底
      settled[next.index] = { ready: true, synthetic: true };
      continue;
    }
    settled[next.index] = { ready: true, synthetic: false, result: next.result };

    // 提交循环：无 halted 门 —— 已执行/已合成的结果一律按序提交
    //（cancel 后同样提交；提交只写 transcript + 发事件，不产生新等待）
    while (commitIndex < calls.length && settled[commitIndex].ready) {
      const execution = calls[commitIndex]!;
      const payload = settled[commitIndex].synthetic
        ? await options.notExecuted(execution, "execution_error")   // 合成失败结果
        : settled[commitIndex].result;
      try {
        const decision = await options.commit(execution, payload);
        halted = halted || decision === "halt";
      } catch (error) {
        firstError ??= error;   // commit 故障：记录、推进槽位、尽力提交后续
      }
      commitIndex++;
    }

    // 发射循环：halted / cancelled / firstError 任一存在即停止发射新调用
    while (!halted && !cancelled && !firstError
      && launchIndex < calls.length && active.size < maxParallel && !options.signal?.aborted) {
      launch(launchIndex++);
    }
  }
} finally {
  // 结构化并发兜底：任何提前退出（含上述代码自身异常）都不留下浮空 promise
  if (active.size > 0) await Promise.allSettled([...active.values()]);
}

if (firstError) throw firstError;   // 此时 transcript 已闭合（合成 + 真实结果全部提交）
return { started: launchIndex, cancelled, halted };
```

`tool-round.ts` 的 `notExecuted` 回调按 reason 区分语义：

```ts
notExecuted: async ({ call }, reason): Promise<ToolDispatchResult> => reason === "execution_error"
  ? { outcome: "failure", category: "fatal", tool: call.name,
      message: "工具执行异常，结果不可用（execution error）" }
  : { outcome: "not_executed", category: "runtime_safety", tool: call.name, message: reason },
```

#### 3.1.2 halt 分支补未发射调用（`scheduleToolCalls`）

```ts
// 现状：commitNotStarted(index, ...)，index 已越过组尾 → 组内未发射调用被漏掉
// 修改：从实际发射进度补起
if (groupResult.halted) {
  await commitNotStarted(groupStart + groupResult.started, "not_executed_after_halt");
  return { cancelled: false, halted: true };
}
```

取消分支已是 `groupStart + groupResult.started`，不动。

#### 3.1.3 终态统一 settlement + 主循环兜底 try/catch（兑现 finishRun 约束）

**统一 settlement helper**（消除 `cancelledResult` 与 `finishRun` 的平行出口——现状 cancelled 不发 terminal `context_usage` 快照，与"所有终态统一结算"约束矛盾）：

```ts
// cyrene-harness.ts
function settleRun(run: HarnessRun): void {
  run.clock.stopActive();
  emitContextUsage(run, "terminal");   // cancelled 同样获得 terminal 快照（上下文环 UI 终态数据）
  checkpoint(run);
}

function cancelledResult(run: HarnessRun): HarnessResult {
  settleRun(run);
  if (run.checkpointFailure) {
    return buildResult(`执行状态保存失败：${run.checkpointFailure}`, run.state, true, "error", run.rounds);
  }
  return {
    finalAnswer: "", finalState: run.state, terminated: true, terminateReason: "cancelled",
    terminal: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true },
    rounds: run.rounds,
  };
}

function finishRun(run, finalAnswer, terminated, terminateReason): HarnessResult {
  settleRun(run);
  if (run.checkpointFailure) {
    return buildResult(`执行状态保存失败：${run.checkpointFailure}`, run.state, true, "error", run.rounds);
  }
  return buildResult(finalAnswer, run.state, terminated, terminateReason, run.rounds);
}
```

**主循环工具轮 try/catch**（调度器 drain 后抛出的 firstError 在此收敛）：

```ts
let outcome: ToolRoundOutcome;
try {
  outcome = await runToolRound(run, toolCalls);
} catch (error) {
  if (input.signal?.aborted) return cancelledResult(run);
  const errorMsg = error instanceof Error ? error.message : String(error);
  // 此时 transcript 已闭合（调度器合成 + 真实结果全部提交），error 终态 checkpoint 是完整历史
  return finishRun(run, `工具执行异常：${errorMsg}`, true, "error");
}
if (outcome === "cancelled") return cancelledResult(run);
```

#### 3.1.4 已明确的残余缺口（接受，不修）

- **cancel 路径**：因 abort 而 reject 的在飞调用无 tool result（槽位永不 ready，commitIndex 停在其前）。接受理由：cancelled 后本轮不再发 LLM 请求；`prepareHarnessRecovery` 按 `session.toolCalls`（status=started 未 committed）补 `not_executed_after_interruption`，既有兜底覆盖。
- **commit 消费方抛错的槽位**：该槽位无 tool result（transcript 洞）。接受理由：`firstError` 抛出后 run 以 error 终态终止，不再发起 LLM 请求，洞不会触发协议 400；commit 故障通常意味着 store 层异常，对同槽位重试大概率同样失败。执行事实仍保留在 execution ledger / toolCalls 生命周期记录中。
- **execute 出错槽位**：~~接受缺口~~ **已修复**（review 后升级为合成失败结果提交，transcript 闭合，见 3.1.1）。
- `runToolRound` 返回值不新增 `halted`：halt 后所有调用已有归档（commit 或 notExecuted），主循环继续下一轮让模型看到诚实结果，无需调用方区分。

### 3.2 批次二：会话级运行守卫（问题 4，方案 A + 折中）

#### 3.2.1 主进程守卫（`agui-bridge.ts`）

```ts
// 新增模块级状态（与 activeRuns 并列）：
// sessionId → { runId, abort(): void, settled: Promise<void> }
const sessionActiveRuns = new Map<string, SessionActiveRun>();
```

注册与释放时机：

| 动作 | 位置 | 说明 |
|---|---|---|
| 检查 + 注册 | session / mode / workspace 校验之后，**同一同步代码块内完成**（JS 单线程，无 await 间隙 = 原子） | 早于 `buildOptions`（它是 async，存在竞态窗口） |
| 释放 | `endLifecycle()`（settlement gate 三出口必调、`lifecycleEnded` 保证恰好一次）+ 早期退出路径（buildOptions catch 等） | 释放 = **compare-and-delete** + resolve settled |
| AbortController / runId 前移 | 创建提前到注册之前 | 注册项需要引用 abort |

拒绝 / takeover 语义（**await 后必须重新竞争 guard**——两个并发 takeover 同时等待旧 run 结算，醒来后若不重检会双双注册成功）：

```ts
let takeovers = 0;
for (;;) {
  const existing = sessionActiveRuns.get(sessionId);

  if (!existing) {
    // get 与 set 之间无 await —— 原子注册；并发 takeover 中只有一个能走到这里
    sessionActiveRuns.set(sessionId, {
      runId,
      abort: () => runAbortController.abort(),
      settled: settlePromise,
    });
    break;
  }

  if (input.takeoverFromRunId !== existing.runId) {
    throw new Error(`SESSION_RUN_ACTIVE:${existing.runId}`);   // 渲染端按稳定前缀识别
  }

  if (++takeovers > 2) {
    // 防御上限：abort 后旧 run 仍未结算（结算链路自身故障）→ 明确报错而非无限等待
    throw new Error(`SESSION_RUN_TAKEOVER_STUCK:${existing.runId}`);
  }

  existing.abort();          // 触发旧 run 的 cancelled 流程
  await existing.settled;    // 等 settlement gate 清理 + checkpoint 落盘
  // 不直接注册 —— 回顶部重新竞争（B 醒来后发现 A 已注册，其 takeoverFromRunId 已不匹配 → 拒绝）
}
```

释放（compare-and-delete，迟到的旧生命周期清理不误删新 run）：

```ts
// endLifecycle / 早期退出路径统一调用
const guard = sessionActiveRuns.get(sessionId);
if (guard?.runId === runId) sessionActiveRuns.delete(sessionId);
```

不变量（写入注释）：

- `settled` 等待保证 takeover 新 run 开局时旧 run 的 checkpoint 已落盘（transcript 完整），兑现已知问题文档中方案 B 的"等结算"前提。
- 渲染端 pendingQueue 仅为 UX 优化；无论 IPC 时序如何，主进程 guard 都是最终一致性边界（不依赖跨进程调度顺序做正确性论证）。

#### 3.2.2 AGUI_RUN 输入扩展

`input.takeoverFromRunId?: string`：显式声明"终止指定 run 并接管"。不传且会话忙 → 拒绝。

#### 3.2.3 渲染端（`ChatPage.tsx`，最小改动）

1. `dispatchUserMessage` 的错误分支识别 `SESSION_RUN_ACTIVE:` 前缀，解析出 `activeRunId`。
2. 识别后不再走通用错误文案，改为渲染一张操作卡："当前会话有正在运行的任务" + 【终止并重开】按钮（复用 interrupted-run 横幅的按钮样式模式）。
3. 按钮动作：`dispatchUserMessage({ ...原参数, takeoverFromRunId: activeRunId })` 重发。原消息内容在 `sendMessage` 调用链闭包内可取，无需新状态。
4. 正常路径（无 reload）完全不经过此逻辑——渲染端 busy 队列先行拦截，守卫零感知。

### 3.3 批次三：存储写放大减法（问题 5 P0）

三项纯减法 + 一项度量，无语义变化：

#### 3.3.1 删除 harness 侧 `deepClone`（`cyrene-harness.ts` checkpoint）

- 两个消费方（run-store `checkpoint`、task-session-store `checkpoint`）均已同步 `clone()`，harness 侧克隆纯冗余。
- `deepClone` 函数随之删除；JSON-serializable 契约注释迁移到 `types.ts` 的 `onCheckpoint` 类型声明处（冻结边界第 4 条）。
- 错误行为不变：循环引用等序列化错误改由消费方 clone 抛出，同样被 checkpoint 的 try/catch 捕获计入 `checkpointFailure`。

#### 3.3.2 去掉 pretty-print（`run-store.ts` atomicWrite）

`JSON.stringify(value, null, 2)` → `JSON.stringify(value)`。session 文件体积约减半；该文件为机器格式（events.jsonl 本就单行），可调试性损失可接受。

#### 3.3.3 index.json 写入防抖（`run-store.ts`）

```ts
// 写路径分类：
// 立即写（writeIndexNow）：create / markTerminal / deleteConversation / initialize
// 防抖写（writeIndexLazy，500ms）：checkpoint / recordTool 中的 write()
// 防抖 + 终态必刷 → 热路径上的 index 重写归零

// 不变量（review 补充）：writeIndexNow() 必须先 cancel 任何 pending 的 lazy 定时器
// 再写入最新 index —— 防止旧 lazy 回调在终态立即写之后触发，
// 把 stale 状态覆盖回去（lazy 回调永远从 this.index 现值构造，不捕获快照）。

// 健壮性（防崩溃丢 index 行）：
// initialize() 时以 session 文件为权威：对 status="running" 的行读文件后，
// 若 session 实际状态非 running（如已是 interrupted），同步校正行状态再落盘。
// 残余风险（initialize 自身中途崩溃）由下一次启动的同逻辑收敛。
```

#### 3.3.4 轻量度量（为 P1 决策拿基线）

run-store 内部计数：实例生命周期累计写盘次数 / 字节数 / checkpoint 次数；`markTerminal` 时输出一行日志。不加配置、不加 IPC，纯 console 观测。

### 3.4 批次四：journal 化持久层（问题 5 P1，本轮不施工）

仅记录方向，作为后续单独施工方案的输入：

- messages 追加走 `.events.jsonl`（appendFileSync 模式已存在），全量快照仅在 compaction / terminal 时落。
- 恢复 = 最近快照 + 重放 journal 尾部。
- `recordTool` 完全退出 session 文件热路径（toolCalls 数组由 journal 派生）。
- 前置条件：批次三的度量基线证明写放大仍是可感知瓶颈。

---

## 4. 文件结构

### 修改（无新增文件）

| 文件 | 批次 | 改动 |
|---|---|---|
| `src/main/orchestrator/harness/tool-call-scheduler.ts` | 一 | `runParallelGroup` 循环门重构；halt 分支起点修正 |
| `src/main/orchestrator/harness/tool-call-scheduler.test.ts` | 一 | 新增 3 组失败测试（halt 保留结果 / error drain / cancel 提交） |
| `src/main/orchestrator/harness/cyrene-harness.ts` | 一、三 | 主循环 try/catch；删除 checkpoint deepClone |
| `src/main/orchestrator/harness/cyrene-harness.test.ts` | 一、三 | 工具轮异常 → error 终态测试；checkpoint 引用传递测试 |
| `src/main/agui-bridge.ts` | 二 | sessionActiveRuns 守卫 + takeover + guard 生命周期 |
| `src/main/agui-bridge.test.ts` | 二 | 并发拒绝 / 跨会话放行 / 释放 / takeover / 早期退出释放测试 |
| `src/renderer/react/features/chat/pages/ChatPage.tsx` | 二 | SESSION_RUN_ACTIVE 识别 + 操作卡 + takeover 重发 |
| `src/main/orchestrator/harness/run-store.ts` | 三 | 去 pretty-print；index 防抖 + 启动校正；度量计数 |
| `src/main/orchestrator/harness/run-store.test.ts` | 三 | 防抖刷盘 / 权威校正 / 契约保持测试 |

---

## 5. 执行步骤

### 批次一（调度器正确性）

1. **测试先行**（tool-call-scheduler.test.ts，全部先失败；**断言必须确定性锁死发射进度，不写"取决于发射进度"这类宽松断言**）：
   - `halt mid-group: commits every executed result and marks only un-launched as not executed` —— **4 调用、maxParallel=2**：0/1 发射，0 完成后 commit(0) 返回 halt。锁死断言：0=commit、1=commit（已发射）、2=notExecuted、3=notExecuted（从未发射），`result.halted === true`。
   - `execute error: synthetic result closes transcript, real siblings committed, then rethrow` —— 0 reject、1 挂起后完成。锁死断言：commit(0) 收到 `notExecuted(execution, "execution_error")` 的合成结果、commit(1) 收到真实结果、最终 reject 原错误；1 无浮空（reject 前 1 已执行完毕）。
   - `commit error: drains in-flight siblings and best-effort commits the rest` —— commit(0) 抛错、1 已完成。断言：无 unhandled rejection、commit(1) 仍被调用、最终 reject commit 错误。
   - `cancel mid-group: commits settled results and skips un-launched` —— abort 信号。断言已结算调用得到 commit、未发射调用得到 notExecuted。
2. **实现**：按 3.1.1 / 3.1.2 修改 scheduler；`tool-round.ts` 的 `notExecuted` 回调按 reason 区分合成语义。
3. **主循环 + settlement 测试**（cyrene-harness.test.ts）：
   - `tool round throws non-cancellation error → run ends with error terminal`——断言不抛异常、`terminateReason === "error"`、terminal `context_usage` 已发、checkpoint 已调。
   - `cancelled run emits terminal context_usage`（settlement 统一的新行为）——断言 cancelled 路径也发 terminal 快照。
4. **实现**：按 3.1.3 抽 `settleRun` + 主循环 try/catch。
5. **验证**：`npx vitest run src/main/orchestrator/harness` → 全量 `npx vitest run`。
6. **提交**：`fix(harness): scheduler preserves executed results on halt/error/cancel and routes tool-round errors to finishRun`。

### 批次二（会话守卫）

1. **测试先行**（agui-bridge.test.ts，先失败）：
   - 同会话第二个 AGUI_RUN（首 run 未结算）→ reject 且错误信息含 `SESSION_RUN_ACTIVE:<runId>`。
   - 不同会话并发 → 两次均成功。
   - 首 run 结算（complete / error / cancel 三出口）→ 守卫释放，新 run 放行。
   - `takeoverFromRunId` 匹配 active run → 旧 run 被 abort、等其 RUN_FINISHED 后新 run 正常启动。
   - **两个并发 takeover 指向同一旧 run**（await 竞态，review 补充）→ 恰一个接管成功，另一个被拒绝（其 `takeoverFromRunId` 已不匹配新 active run）。
   - takeover 防御上限：旧 run abort 后不结算（模拟 settlement 链路故障）→ 第二轮重检后抛 `SESSION_RUN_TAKEOVER_STUCK`。
   - 释放为 compare-and-delete：旧 run 迟到的 endLifecycle 不误删新 run 的 guard（新 run 注册后旧 run 才释放 → guard 仍指向新 runId）。
   - buildOptions 抛错（注册后早期退出）→ 守卫释放。
   - 同步并发竞态：两个 AGUI_RUN 同 tick 进入 → 恰一个成功。
2. **实现**：按 3.2.1 / 3.2.2 修改 agui-bridge.ts。
3. **渲染端**：按 3.2.3 修改 ChatPage.tsx（错误前缀识别 + 操作卡 + takeover 重发）。
4. **手动验证**：开一个长 run → F5 → 立即发消息 → 预期：出现操作卡而非第二个 run；点【终止并重开】→ 旧 run 显示已取消、新消息正常执行。
5. **提交**：`feat(bridge): session-level run guard with explicit takeover`。

### 批次三（存储减法）

1. **测试先行**（run-store.test.ts / cyrene-harness.test.ts，先失败）：
   - harness checkpoint 传活引用：onCheckpoint 收到的 messages 与 run.messages 为同一引用（断言不再克隆）；checkpoint 后继续 push 消息，store 内容不受影响（消费方克隆契约）。
   - index 防抖：连续 recordTool × N（fake timers）→ writeIndex 仅在防抖窗口后执行一次；markTerminal 立即刷盘。
   - **stale overwrite 防御**（review 补充）：lazy 写已调度 → markTerminal 立即写 → 推进 fake timer → 断言 index 仍为终态（旧 lazy 回调不得覆盖回 running）。
   - initialize 权威校正：index 行 status 与 session 文件不一致 → 启动后行状态被校正。
   - 去掉 pretty-print 后读写往返一致（既有测试天然覆盖，补一条单行格式断言即可）。
2. **实现**：按 3.3.1–3.3.4 修改。
3. **验证**：`npx vitest run src/main/orchestrator/harness` → 全量回归。
4. **手动验证**：跑一个多工具 run，观察 markTerminal 日志的写盘计数/字节数基线，记录到已知问题文档问题 5 末尾。
5. **提交**：`perf(run-store): remove redundant clone and pretty-print, debounce index writes`。

---

## 6. 验证命令

```bash
# 定向（每批实现后）
npx vitest run src/main/orchestrator/harness
npx vitest run src/main/agui-bridge.test.ts

# 全量回归（每批提交前）
npx vitest run
```

---

## 7. 回滚策略

- 每批次一个独立提交，出问题 `git revert <commit>` 单批回退，批次间无代码耦合（批次三的 deepClone 删除不依赖批次一/二）。
- 批次二渲染端与主进程改动在同一提交内（守卫拒绝但无 UI 识别 = 用户只见错误文案，功能仍正确，可独立回退主进程部分时保留 UI 识别的死代码无害）。
- 批次三的 index 防抖有崩溃丢行风险，回滚点单独可控：若恢复路径出现找不到 interrupted run，优先怀疑 3.3.3，revert 该提交即可。
