# Harness 并行调度已知问题（2026-08-25 调研）

> 范围：`src/main/orchestrator/harness/tool-call-scheduler.ts` 及其调用方 `tool-round.ts` / `cyrene-harness.ts`。
> 所有结论均通过临时复现测试验证（测试已删除，未入库）；现有 7 个调度器测试全部通过，未覆盖下述场景。

## 修复状态（2026-08-25 施工完成）

| 问题 | 状态 | 修复 commit |
| --- | --- | --- |
| 1 halt 后已执行结果消失 | 已修复 | fa22ab8 / 1bdc849 |
| 2 execute 抛错穿透、绕过 finishRun | 已修复 | 1bdc849 / 88cc508 |
| 3 取消路径丢未提交 tool result | 已修复 | fa22ab8 |
| 4 同会话并发无守卫 | 已修复（SESSION_RUN_ACTIVE + takeover） | 88215b3 |
| 5 checkpoint 深拷贝 + 写放大 | 已修复（活引用契约 / 单行 JSON / index 防抖） | c2c85b5 |

施工方案与批次划分见 `2026-08-25-harness-parallel-scheduling-optimization-plan.md`。

---

## 问题 1（严重）：并行组 halt 后，已执行调用的结果凭空消失

**位置**：`tool-call-scheduler.ts` `runParallelGroup` 的提交循环 + `scheduleToolCalls` 的 halt 分支

**机制**：

- 并行组内严格按原始 tool-call 顺序提交（`commitIndex` 递增）。
- 某次 `commit` 返回 `"halt"`（fatal 错误或 uncertain 副作用）后，提交循环被 `!halted` 条件挡住。
- 但组内排在后面的调用**早已发射并执行完毕**，结果就在 `settled` 数组里。
- `scheduleToolCalls` 的 halt 分支调用 `commitNotStarted(index, ...)` 时，`index` 已越过组尾——只补了**组外**的调用；组内已执行未提交的调用既没有 `commit` 也没有 `notExecuted`。

**后果链**（复现断言失败信息：`b 未获得任何 tool result 归档`）：

1. `run.messages` 中 assistant 消息带 N 个 toolCalls，却只有不足 N 条 tool result 消息。
2. `tool-round.ts` 的 `runToolRound` **完全忽略 `schedule.halted`**，返回 `"completed"`，主循环继续下一轮。
3. 下一轮 LLM 请求携带残缺 transcript → **Anthropic 协议直接 400**（每个 `tool_use` 必须有对应 `tool_result`，见 `anthropic-adapter.ts`）；OpenAI 协议同样要求配对。
4. `checkpoint` 把损坏的 transcript 持久化，恢复链路同样拿到残缺历史。

**可达性**：并行组准入条件是"读操作 + 显式并发安全"，但 fatal 分类（OOM / ENOMEM / FATAL，见 `error-classifier.ts`）对读工具同样成立，路径真实可达。

---

## 问题 2（中危）：execute 抛错直接穿透，兄弟调用变浮空 promise，绕过 finishRun 终态结算

**位置**：`tool-call-scheduler.ts` `runParallelGroup` 的错误分支（`throw next.error`）

**机制**：

- 某个并行调用 `execute` 抛错（真实路径：`persistToolDispatchResult` 的 `ToolOutputPersistenceError`，即工具输出落盘失败），调度器立即 `throw`，不再 drain 剩余在飞调用。
- 复现确认：兄弟调用后台执行完毕，结果无人消费（无 commit / 无 notExecuted / 无 tool result 消息）。

**后果**：

1. 在飞调用继续执行、继续往输出 store 写记录，但 transcript 同样残缺（问题 1 的协议后果在此复现）。
2. 错误穿透 `runToolRound`（其 catch 只识别取消错误）→ 主循环对工具轮**没有 try/catch** → 直接冲出 `runCyreneHarness`。
3. **绕过 `finishRun` 统一终态结算**：无 terminal 上下文快照、无 checkpoint、无终态事件——违反项目硬约束 "All terminal states must go through the unified finishRun"。

---

## 问题 3（轻危，观察）：取消路径同样丢已发射未提交的 tool result

**位置**：`tool-call-scheduler.ts` `scheduleToolCalls` 的取消分支

**机制**：取消后 `commitNotStarted(groupStart + groupResult.started, ...)` 只补未发射的调用；已发射未提交的调用结果被丢弃。

**现状评估**：取消后本轮不再发 LLM 请求，当下无害；且 `run-recovery.ts` 的 `prepareHarnessRecovery` 会按 `session.toolCalls` 补 `not_executed_after_interruption`，有兜底——**前提是生命周期记录完整**。优先级低，修复问题 1 时可顺带覆盖。

---

## 修复方案对比（问题 1）

| 方案 | 做法 | 评价 |
|---|---|---|
| **A（推荐）** | halt 后**停止发射新调用，但继续按序提交已执行的结果**（执行已发生，结果是事实）；从未发射的才标 `not_executed` | 语义诚实，模型能看到 fatal 后续读操作的真实结果；改动集中在 `runParallelGroup` 的两个循环门 + `commitNotStarted` 起点 |
| B（最小） | halt 后对已执行未提交的调用补 `notExecuted` | diff 最小，但对模型撒谎（明明执行了说没执行），浪费已产生的结果 |

**问题 2 建议两层都做**：

1. 调度器抛错前先 drain 完在飞调用（结果按序提交，错误最后抛出）。
2. 主循环给 `runToolRound` 包 try/catch，非取消错误统一走 `finishRun(run, ..., "error")`，兑现终态结算约束。

---

## 问题 4（中危）：同会话并发第二个 Harness 无主进程守卫，reload 即可触发

**范围**：`agui-bridge.ts`（AGUI_RUN 入口）、`ChatPage.tsx`（渲染端 busy 队列）、`run-store.ts`

**现状——三层检查只有第一层在拦**：

| 层 | 位置 | 防什么 | 防不住什么 |
|---|---|---|---|
| 渲染端软守卫 | `ChatPage.tsx` `isSessionBusy` → 消息进 pendingQueue，run 结束 finally 块 drain | 正常 UI 路径 | 渲染端 reload / 崩溃（ref 丢失） |
| 主进程 bridge | `AGUI_RUN` handler 只校验 session 存在 + 工作区绑定 | — | 完全不拦；`activeRuns` 键是 runId（为取消设计），不是 sessionId |
| run-store | `create` 拒绝同 runId 重复（`HARNESS_RUN_EXISTS`） | 同 runId 冲突 | 不同 runId 的同会话第二个 run 照常放行 |

**可达路径**：run 执行中按 F5 → 渲染端 `activeRunsBySession` ref 清零 → 主进程 run 仍在跑（订阅未清理）→ 用户发消息 → 第二个 Harness 并发启动。

**并发后果（按严重度）**：

1. 会话存储互相覆盖：两个 run 都往同一 session `upsert` 全量 messages 快照，后写覆盖先写，一个 run 的最终回复可能整体丢失。
2. uncertainEffects 拦截失效：副作用指纹在各自 run 的 state 深拷贝里，run B 看不到 run A 的未确认副作用，可能重复执行危险操作。
3. 工具副作用交错：两个 run 对同一工作区并发写文件，顺序不可预期。
4. 交互卡片竞争：`setInteractionForSession` 按 session 只有一份，后到的权限卡覆盖先到的。
5. 恢复语义混乱：重启后同会话两条 interrupted 记录，`getLatestInterrupted` 只恢复最新，另一条的副作用状态丢失。

**修复方案对比**：

| 方案 | 做法 | 评价 |
|---|---|---|
| A（推荐先做） | 主进程会话级守卫：bridge 维护 sessionId → runId 反向索引，AGUI_RUN 时已有 active run → 报错（照抄 task-session-store 的 `TASK_ALREADY_RUNNING` 模式）；清理时机挂 `endLifecycle`（settlement gate 三出口必调） | 改动小，防住所有数据损坏路径；渲染端排队机制不变 |
| B | 守卫 + 自动接管：abort 旧 run、等 finishRun checkpoint 落盘后再开新 run | "等结算"微妙：不等落盘则新 run 开局 transcript 缺旧 run 尾部；复杂度高 |
| C | reload 重连：渲染端发现 active run 后重新订阅事件流恢复流式显示 | 治本但需 AG-UI 事件 replay/attach 机制，改动大 |
| A+B 折中 | 守卫拦下后提示用户，给"终止旧任务并开始"按钮（显式 abort 语义） | UX 最好，实现 = A + 一个按钮 |

建议：先做 A（兜底防损坏）+ 提示带"终止并重开"选项；B/C 留作演进。

---

## 问题 5（低危，性能债）：checkpoint 全量深拷贝 + run-store 写放大（deepClone / structuredClone 讨论）

**来源**：千问建议"用 structuredClone 替换 `JSON.parse(JSON.stringify(...))`，或 checkpoint 改流式写入"。评估结论：**问题真实但药方错位**——structuredClone 不解决问题，真正的瓶颈是 run-store 的写放大。

**一次 checkpoint 的完整成本链**：

调用链：`cyrene-harness.ts` checkpoint() → `harness-adapter.ts` onCheckpoint → `run-store.ts` checkpoint()

| 步骤 | 位置 | 成本 |
|---|---|---|
| 1. `deepClone` × 3 个字段 | harness 侧 | 序列化 + 反序列化整个 messages |
| 2. `require(runId)` 读盘 | store 侧 | 全量**读磁盘 + JSON.parse** 整个 session 文件 |
| 3. `clone(patch.x)` × 4 个字段 | store 侧 | 又一轮序列化 + 反序列化 |
| 4. `write` 落盘 | store 侧 | `JSON.stringify(session, null, 2)` 全量**写**（pretty-print 翻倍体积） |
| 5. `writeIndex` | store 侧 | **全量重写** index.json（含历史所有 run） |

更严重的是 `recordTool`：一轮 N 个工具调用，每个生命周期事件（started + committed，每调用 2 次）都触发全量读盘 + 全量写盘 + 全量 index 重写。**真正瓶颈不是 harness 的 deepClone，而是 run-store 的同步磁盘 IO 写放大**——"CPU 瓶颈"说轻了。

**为什么 structuredClone 是开错药方**：

1. **契约错位**：项目硬约束是"checkpoint 必须 JSON-serializable"（cyrene-harness.ts deepClone 注释明确）。JSON 往返克隆与磁盘持久化格式天然对齐；structuredClone 会放行 Date/Map，内存克隆正确但落盘 `JSON.stringify` 时静默丢失——恢复路径读的是磁盘，内存正确无用。
2. **性能不占优**：Node 里对纯 JSON 形状数据，structuredClone 相比 JSON 往返无稳定优势（benchmarks 常见还不如）。
3. **不省任何工作**：clone 变快后，全量读盘 / 全量落盘 / index 重写一步没少。

**问题排序**：

| # | 问题 | 增长模式 | 严重度 |
|---|---|---|---|
| 1 | `recordTool` 每工具事件全量读写 session + 全量重写 index | O(工具事件数 × transcript 大小)，含磁盘 IO | 高 |
| 2 | index.json 全量重写，随历史 run 数无限增长 | O(总 run 数) 每次写 | 高（长期最疼） |
| 3 | checkpoint 双重 clone + pretty-print | O(transcript) 纯 CPU，毫秒级 | 低 |
| 4 | 换 structuredClone | 不解决任何上述问题 | — |

**校准**：典型 run（几十轮、几百 KB transcript）每轮几毫秒，当前非用户可感知瓶颈。真疼场景：长 run 工具多、Windows Defender 扫 `.tmp` 文件、index 积累几千条之后。属"越来越疼"型，非"着火"型。

**修复方案（按保守增量排序）**：

| 优先级 | 改法 | 性质 |
|---|---|---|
| P0 | 删掉 harness 侧 `deepClone`（store 侧同步 clone 了，纯冗余——需先确认 task-runtime 的 onCheckpoint 也是同步消费）；去掉 `null, 2` pretty-print；index 写入防抖 | 无语义变化，纯减法 |
| P1 | messages 改 append-only journal（复用 `.events.jsonl` 的 appendFileSync 模式），全量快照只在 compaction / terminal 时落；恢复 = 最近快照 + 重放 journal | 真正治本，改动中等，需迁移兼容 |
| 不做 | structuredClone 替换 | 见上 |

P1 前先加度量（每 run 写盘字节数 / checkpoint 耗时）拿基线数据。

---

## 建议补充的回归测试

- 并行组 halt 后：每个已执行调用必须有 commit（方案 A）或 notExecuted（方案 B）归档。
- `runToolRound` 返回值应区分 `halted`（新增）或调用方显式消费 `schedule.halted`。
- execute 抛错后：在飞调用结果不丢失；`runCyreneHarness` 以 `error` 终态（含 terminal 快照 + checkpoint）结束而非异常冲出。
- 残缺 transcript 防御：下一轮请求前校验 assistant toolCalls 与 tool results 配对数量（可选，兜底性质）。
