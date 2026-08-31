# Cyrene Harness Runtime 重新定界与修改计划

> **日期**：2026-08-09  
> **状态**：P0 已实施；自动化回归通过，桌面端人工 smoke 待执行  
> **范围**：CyreneHarness P0 主循环、工具完成语义、停止/取消、ExecutionLedger  
> **结论先行**：当前 Runtime 已从“安全执行器”部分演化为“隐式工作流引擎”。P0 应把策略、验证选择与结束权归还给模型；Runtime 仅保留协议、安全、资源与生命周期约束。

## 实施记录（2026-08-09）

- Completion workflow 已退出 Harness 主路径；模型 no-tool response 直接 final，settlement 类型没有 `continue_agent`。
- canonical `runId` 由 AG-UI bridge 创建并贯穿 Agent、Harness、ToolContext、交互卡片和终态；每个 run 经 exactly-once gate 结算。
- 取消链路使用原生 `AbortSignal`；`RUN_FINISHED.result.status` 表达 `success` / `cancelled` / `timeout`，runtime error 使用 `RUN_ERROR`。
- 工具执行统一经过 `executeToolDefinition()`；typed failure 保留 code、category、retryable 和 effect state，旧字符串/JSON 失败仅由 compatibility shim 兼容。
- Ledger 仅按 canonical runId + toolCallId replay 同一次 logical invocation；相同参数的新 tool call 不命中缓存。
- UncertainEffectGuard 与 Ledger 分离；它只阻止相关的 unresolved non-idempotent effect，且不能阻止模型 final。用户可通过 Runtime 固定确认卡授权一次。
- P0 Ledger 是进程内、短生命周期的 bounded store；跨进程持久化 replay protection 仍属于 P1。

当前仍依赖 legacy failure compatibility shim 的生产工具文件：

- `document-tools.ts`
- `built-in-tools.ts`
- `fs-tools.ts`（`write_file` 已迁移，其余工具仍有 legacy return）
- `email-tools.ts`
- `history-tools.ts`
- `life-tools.ts`
- `search-code-tools.ts`
- `travel-tools.ts`

只有当上述生产清单中的 `[错误]` / `[拒绝]` / `{ success:false }` 返回全部迁成 typed failure，且 inventory 搜索归零后，才能删除 compatibility shim。

---

## 1. 背景：本轮实测暴露的不是单点 Bug

Harness 主循环和工具主路径已经跑通，但“创建文件”实测出现了以下行为：

```text
模型：write_file 成功
模型：准备给用户最终回复
Runtime：仍有验证义务，不能结束
模型：read_file / test / typecheck / verify
Runtime：仍有验证义务，不能结束
模型：开始描述“系统让我停不下来”
```

这不是模型缺少能力或不够自律。模型已经拥有写入成功及文件状态的证据，却被 Runtime 的高优先级反馈禁止结束。

同时，用户主动停止也存在独立问题：取消链路使用的 `runId` 不一致，导致停止请求通常在桥层查不到活跃运行。

---

## 2. 当前实现事实

### 2.1 Harness 当前承担的职责

当前 Harness/Adapter/Dispatcher 合计承担：

- 模型循环、历史写回、上下文压缩；
- 工具 schema 暴露、参数解析、权限检查、工具执行；
- 超时、重试、输出截断、ExecutionLedger；
- 副作用分类和 uncertain effect 拦截；
- Todo、`ask_user`、AG-UI 事件转换；
- Completion Obligation 的创建、满足判定和终态拦截；
- Run 生命周期与取消信号的一部分传递。

其中前半部分属于 Runtime 的合理职责；“推断任务是否已完成、强制模型额外验证、否决最终回复”不应成为默认主路径能力。

### 2.2 Completion Obligation 的确定性死循环

`write_file` 注册为 `effectKind: "mutation"`，并配置了动态的
`verificationPolicyResolver`。但 `resolveCompletionSemantics()` 只读取静态
`verificationPolicy`，没有调用 resolver：

```text
write_file
  effectKind = mutation
  verificationPolicyResolver = 已配置但未消费
  verificationPolicy = undefined

Completion Policy
  mutation + none
  -> require_post_verification
  -> verify_required(expectedVerifyToolId = undefined)
```

而义务被满足的前提是 `expectedVerifyToolId` 存在，且本次工具 ID 与其相等。
因此这个 obligation 无论调用 `read_file`、测试工具或验证工具都无法满足。

每次模型尝试结束，Harness 都会把未完成义务写成新的 system Runtime Feedback，
迫使模型继续行动。若模型再次 `write_file`，还会再产生一个不可满足义务。

### 2.3 `write_file` 已有部分自证，但 Runtime 没有使用

`fs-tools.ts` 当前在写入后已经执行 `safeStat(filePath)`，并返回 `filePath`、
`sizeBytes` 与 `success: true`。这意味着问题不只是“缺少 stat”，而是：

> 工具产出了持久化证据；Completion Policy 未消费它，却额外创建了一条无法收敛的验证工作流。

另有一个应单独修正的工具契约问题：当前 `write_file` 在部分失败路径返回
`"[错误] ..."` 字符串，而通用 dispatcher 把“Promise 正常 resolve”视为工具成功。
这会把执行失败误报为成功。

### 2.4 停止/取消的三个问题

同一次 Run 目前存在三套 ID：

```text
AG-UI Bridge runId       -> activeRuns Map 的 key
CyreneAgent runId        -> RUN_STARTED 发给 Renderer
Harness Adapter runId    -> ToolContext.runId
```

Renderer 保存 Agent 的 ID，再携带它调用 `AGUI_CANCEL`；Bridge 却用 Bridge 的 ID
查 `activeRuns`，通常无法命中。因此 AbortSignal 根本未到达 Harness。

即使 ID 修复，当前取消也直接 `subscription.unsubscribe()`。这会让 Agent 的 teardown
调用 abort，但同时阻止 `RUN_FINISHED` / `RUN_ERROR` 发送；Renderer 的 terminal Promise
只由这两个事件结算，因此可能遗留 busy 状态和悬挂的 `runModel()`。

最后，Harness 的 signal 目前传给了模型 HTTP 请求和轮次边界检查，但没有完整传给普通
工具及 `ask_user` 的 pending Promise。因此工具执行中、等待权限或等待用户回答时，取消
不能保证立即结束底层工作。

### 2.5 ExecutionLedger 的现状

Ledger 已接入，但 scope key 使用 `${conversationId}:messages-${messages.length}`。消息数
随每轮增长，导致同一次 Run 不断换 namespace、缓存无法命中。

此外，`read_only` 工具不应该被粗暴缓存：写入后再次读取必须看到最新状态。Ledger 的价值
应集中在 non-idempotent side effect 和可安全重试的 mutation，而不是替模型消除所有重复读取。

---

## 3. P0 目标架构

### 3.1 职责边界

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Model | 任务理解、计划、工具选择、是否验证、如何解释失败或不确定性、何时给出 final | 权限绕过、危险副作用去重、资源配额 |
| Tool | 原子操作、领域内自检、真实成功/失败/证据 | 全局任务完成判断 |
| Runtime | 参数与协议、权限、取消、超时、资源上限、安全重试、幂等/副作用保护、上下文和事件生命周期 | 默认判断“任务是否完成”、默认要求所有 mutation 额外验证 |

核心规则：

> Runtime 只能对它能机械确定的事实拥有强制权；需要任务语义判断的事情由 Model 决定。

### 3.2 主循环的默认终止条件

```text
检查 cancel / timeout / budget
    ↓
调用模型
    ↓
有 tool calls？
├─ 有：Runtime 安全执行，返回真实 observation，继续循环
└─ 无：模型产生 assistant final，完成协议收尾后结束当前 turn
```

`no tool calls -> final` 不代表“用户目标一定成功”，而代表模型已选择结束当前 turn。
final 可以是成功、部分完成、失败、需要用户决定，或对未知副作用的诚实说明。

### 3.3 Runtime 仍可 Hard Block 的最小集合

仅保留机械生命周期约束：

- 尚有正在运行且未结算的 tool execution；
- 工具调用与 tool result 的协议配对损坏；
- 正在等待 permission 或 `ask_user`，且该等待尚未被取消/结算；
- Runtime 自身状态损坏，无法产生可信终态；
- 取消、超时或资源上限触发后，必须进入对应终态。

以下全部降为 observation，不能默认阻止 final：

- 工具失败；
- 测试失败；
- 文件不存在；
- 产物验证不足；
- non-idempotent side effect 的结果 unknown；
- 模型没有按 Runtime 预想的方式验证。

对 unknown side effect，Runtime 应禁止相同危险操作的盲目重复；但必须允许模型给出：

> 请求已发起，但结果目前无法确认。为避免重复副作用，我没有重试。

---

## 4. 修改计划（不在本次文档阶段实施）

### P0-A：移除默认 Completion Obligation 的终态否决权

**目标**：Runtime 不再因为一般 mutation、失败、未知结果或“验证不足”拒绝模型 final。

1. 将 `checkCompletion()` 的职责缩小为 `Termination Safety` / `Run Finalization Guard`。
2. 从 final gate 移除 `completionObligations` 与 `uncertainEffects` 的硬拦截。
3. 删除“你还有未完成验证义务，必须继续调用工具”的通用 system Runtime Feedback。
4. `uncertainEffects` 保留为执行期安全状态：阻止相同 non-idempotent effect 自动重放；不阻止 final。
5. 工具失败、测试失败与验证不足只作为结构化 observation 返回给模型。
6. 如果未来确有项目显式的 release/CI 规则，采用 opt-in、有限次数、有失败着陆出口的 Hook；不从 `effectKind: mutation` 自动推导。

**验收**：简单文件创建应收敛为：

```text
LLM: write_file
Runtime: permission -> write -> tool evidence
LLM: assistant final
END
```

模型可自行选择额外读取，但 Runtime 不要求它读取。

### P0-B：收紧工具的真实结果契约

**目标**：把“原子事实”放回 Tool，而不是靠全局 Guard 猜测。

1. `write_file` 成功时必须返回可消费的持久化证据：规范化绝对路径、字节数、存在性；若 `stat` 失败则不得报告 `success: true`。
2. 失败必须进入 dispatcher 可识别的失败路径；不能把错误文本作为成功的普通输出。
3. `verificationPolicyResolver` 如继续保留，仅用于模型提示、展示或选择性 advisory，不参与默认终态拦截。
4. 代码测试、格式检查、文档检查等验证行为由模型根据任务、用户要求和工具 observation 决定。

**验收**：写入失败时，模型获得 `failure` observation，可以重试、换方案或诚实 final；不会生成不可消除的验证义务。

### P0-C：重建可取消的 Run 生命周期

**目标**：一个 Run 只有一个 canonical `runId`，取消有可观察终态。

1. Bridge 生成唯一 canonical `runId`，传入 Agent、Harness、ToolContext 和所有 AG-UI 事件。
2. Renderer 使用 AGUI_RUN acknowledgement 的 `runId`，不再用另一个 `RUN_STARTED` ID 覆盖。
3. `AGUI_CANCEL` 先发出该 Run 的 cancellation request，而不是把 subscription 当作唯一控制手段。
4. Run 最终必须向 Renderer 发出一次明确终态（例如 `RUN_FINISHED` + cancelled reason，或规范化 `RUN_ERROR`），使 terminal Promise 和 busy 状态可靠清理。
5. 将 signal 传播进 ToolContext；`ask_user`、permission 与长工具需能通过 abort race 解除等待。不可中断的外部副作用则标注为“已请求取消，底层结果可能未知”。

**验收**：在模型请求、普通工具执行、权限等待、`ask_user` 等阶段点击停止，UI 都在有限时间内收到终态；后续消息不再被卡进旧 Run 的队列。

### P0-D：收紧 ExecutionLedger

**目标**：保留真正的副作用保护，不把 Ledger 变成陈旧读取缓存。

1. scope key 改为 `${conversationId}:${runId}`，稳定到一次 Harness Run 结束。
2. 仅让 `idempotent_mutation` 与 `non_idempotent_side_effect` 进入 Ledger。
3. `read_only` 每次直接执行；模型负责避免无意义重复读取。
4. Ledger 命中记录可见 diagnostics，便于验证“防重复副作用”实际发生。

---

## 5. 建议实施顺序

1. **先 P0-A**：移除不可收敛的终态拦截，恢复模型结束权；这是当前死循环的根因。
2. **再 P0-B**：收紧 `write_file` 成功/失败证据，避免 Runtime 基于模糊结果推断。
3. **再 P0-C**：修复取消链路，确保人类拥有最终停止权。
4. **最后 P0-D**：修 Ledger scope 与分类；这不是当前无限循环的前置条件。

每个阶段单独测试、单独 review，避免把 Runtime 边界变化、工具契约变化和 UI 生命周期变化混为一个难以定位的大改动。

---

## 6. 验收矩阵

| 场景 | 模型可选行为 | Runtime 必须行为 | 不允许的行为 |
| --- | --- | --- | --- |
| 新建普通文本文件 | 写后直接 final，或自选 read | 真实返回写入证据 | 因未 read 而拒绝 final |
| 写入空文件 | final | 接受 `sizeBytes = 0` 的成功 | 把空文件判为未完成 |
| 文件写入失败 | 重试、换路径、ask、失败 final | 返回 failure observation | 把错误文本当 success |
| 测试失败 | 修复、解释失败、final | 返回测试结果 | 强迫测试成功后才可 final |
| 邮件请求 unknown | 查证或报告不确定性 | 禁止同一危险请求盲目重放 | 因 unknown 禁止 final |
| 用户点击停止 | 无 | abort、结算 Run、发送终态 | 查不到 Run 或 UI 永久 busy |
| 写后再次读 | 可读到最新状态 | 不对 read_only 返回陈旧 Ledger 缓存 | read 结果被 mutation 前缓存替代 |

---

## 7. 明确不在本次 P0 做的事

- Session checkpoint / durable resume；
- Todo 持久化；
- fullOutputRef backing store；
- 任意通用“任务质量验收”框架；
- 强制 Todo、强制测试或强制验证；
- 将 Completion Obligation 扩展成通用工作流/Planner；
- 通过 TTL 修补 Ledger 的 Run 边界；
- 取消后假装外部 non-idempotent operation 一定未发生。

---

## 8. Review 待确认决策

1. P0 是否直接从 final gate 移除 `completionObligations`，而非先做 feature flag？
2. `uncertainEffects` 是否确认只限制“重复执行”，完全允许“诚实 final”？
3. `verificationPolicyResolver` 是否降级为 advisory；未来仅通过显式项目 Hook 引入硬性验证？
4. 取消终态在 AG-UI 层采用 `RUN_FINISHED` + `cancelled` 字段，还是使用单独规范化事件？
5. `write_file` 的错误契约是“executor throw”还是扩展 ToolDefinition 支持结构化结果？

这些确认后，再把 P0 拆成独立实现任务。
