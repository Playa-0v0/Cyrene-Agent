# CyreneHarness 施工计划

> **状态**:施工稿(基于设计稿 v3)
> **日期**:2026-08-09
> **性质**:可执行的实施步骤与验收标准
> **依据**:`docs/design/2026-08-08-cyreneHarnessloopdesign.md`(v3)

---

## 0. 一句话目标

按 v3 设计稿实现 `CyreneHarness`:一个连续 Agent Loop + 确定性 Runtime,替换现有 LangGraph 主循环与 TwoPhaseFC legacy 循环。

---

## 1. 施工边界

### 1.1 本次必须改动的范围

- Work / Daily / Learn 模式统一替换为 CyreneHarness
- 删除 LangGraph 路径:`langgraph-agent-loop.ts`, `agent-graph.ts`, `action-gate.ts`, `native-function-calling.ts`, `ask-soul.ts`
- 删除 TwoPhaseFC 路径:`two-phase-fc-loop.ts`, `task-router.ts`, `ask_user_choice` 工具
- 删除 LangChain 6 依赖,`structured-output` 强制 legacy 后端
- 新建 `CyreneHarness` 模块(while 循环 + 工具 dispatch + 流式 + obligation/todo/uncertainEffects)
- 前端:`cyrene.taskPlan` 事件改 `cyrene.todo`(涉及 `ChatPage.tsx`, `TaskPlanCard.tsx`, `run-presentation.ts`, `ChatMessageList.tsx` 等)
- `WorkStreamEventBridge` 从 `two-phase-fc-loop.ts` 搬迁到 `agent-loop-stream.ts`
- `sub-agent.ts` 白名单:屏蔽新内置工具 `ask_user`(替换原 `ask_user_choice`)

### 1.2 明确不动的范围

- Chat 模式:`runChatLoop`, Chat 人设, Style, sampling parameters
- Code 模式:`runCodeRequest` + `@cline/sdk`
- 具体工具实现:`fs-tools.ts`, `document-tools.ts`, `built-in-tools.ts` 等(只换执行入口)
- memory / CITA / rag / worldbook 长期记忆系统
- 用户待办系统:`cyrene.todos`(复数)不动

---

## 2. 前置准备(第 0 天)

### 2.1 环境检查

- [ ] 确认 `npm run build` / `npm run test` 当前通过(基线)
- [ ] 确认 `docs/design/2026-08-08-cyreneHarnessloopdesign.md` 为 v3
- [ ] 确认 `prompts/cyrene_harness.md` 至少有一份可用初稿(内容可由用户后续微调)

### 2.2 分支与备份

- [ ] 从 `master` 切出功能分支:`feat/cyrene-harness`
- [ ] 物理备份旧文件到 `E:\Cyrene-Harness-Migration-Backup\2026-08-09\`:
  ```powershell
  $dest = "E:\Cyrene-Harness-Migration-Backup\2026-08-09"
  New-Item -ItemType Directory -Force -Path $dest
  Copy-Item -Path "src\main\orchestrator\langgraph-agent-loop.ts" -Destination $dest
  Copy-Item -Path "src\main\orchestrator\agent-graph.ts" -Destination $dest
  Copy-Item -Path "src\main\orchestrator\action-gate.ts" -Destination $dest
  Copy-Item -Path "src\main\orchestrator\native-function-calling.ts" -Destination $dest
  Copy-Item -Path "src\main\orchestrator\two-phase-fc-loop.ts" -Destination $dest
  Copy-Item -Path "src\main\orchestrator\ask-soul.ts" -Destination $dest
  Copy-Item -Path "src\main\orchestrator\task-router.ts" -Destination $dest
  Copy-Item -Path "src\main\orchestrator\structured-output\langchain-invoker.ts" -Destination $dest
  ```

---

## 3. Phase 1: 基础设施改造(先不删文件,改依赖)

**目标**:让 `structured-output` 走 legacy 后端,验证 memory/CITA/social-context 还能工作,然后才能安心删 LangChain。

### 3.1 `structured-output/backend.ts`:删除 langchain 分支

- [ ] 修改 `resolveStructuredOutputBackend`:直接返回 `"legacy"`
- [ ] 删除 `invokeLangChainStructured` 调用分支
- [ ] 保留 legacy 分支的适配逻辑(OpenAI json_schema / Anthropic prompt_json)

### 3.2 `llm-client.ts`:删除 langchain callback

- [ ] 在 `chatNonStream({ structuredOutput })` 中删除 `langchain: () => invokeLangChainStructured(...)`
- [ ] 只保留 `legacy: () => adapter.buildRequest(...) / parseResponse(...)`
- [ ] 删除 `import { invokeLangChainStructured } from ...`

### 3.3 删除 `langchain-invoker.ts`

- [ ] 删除文件 `src/main/orchestrator/structured-output/langchain-invoker.ts`
- [ ] 从 package.json 删除 6 个依赖:`@langchain/langgraph`, `@langchain/core`, `@langchain/anthropic`, `@langchain/openai`, `@langchain/deepseek`, `langchain`
- [ ] 运行 `npm install`

### 3.4 编译与回归验证

- [ ] `npm run build` 通过
- [ ] 跑现有测试,确认 memory / CITA / social-context 相关测试不炸
- [ ] 手动触发一次需要结构化输出的功能(如 memory 抽取),确认 legacy 后端输出质量可接受

### 3.5 输出

- [ ] 提交 commit:`infra: structured-output legacy-only, remove langchain deps`

---

## 4. Phase 2: 子代理类型迁移 + task-plan 删除

**目标**:处理 `task-plan.ts` 被 subagents 引用的前置问题。

### 4.1 盘点 task-plan 被引用的内容

- [ ] 检查 `subagents/{types,graph,search-agent,document-agent}.ts` 从 `task-plan.ts` import 了什么
- [ ] 把只被 subagents 使用的类型/函数迁到 `subagents/types.ts` 或新建 `subagents/plan-types.ts`

### 4.2 删除 task-plan.ts 的 agent 部分

- [ ] 确认没有其它生产代码引用 `runCreatePlan` / `verifyStep` / `runReplan`
- [ ] 删除 `src/main/orchestrator/task-plan.ts`

### 4.3 编译验证

- [ ] `npm run build` 通过

---

## 5. Phase 3: CyreneHarness 主体实现

### 5.1 新建文件结构

建议新建以下文件(位置:`src/main/orchestrator/harness/`):

```
src/main/orchestrator/harness/
  index.ts                 # 对外暴露 runCyreneHarness
  cyrene-harness.ts        # 核心 while 循环
  types.ts                 # AgentState, CompletionObligation, UncertainEffect, TodoItem, HarnessConfig
  builtin-tools.ts         # update_todo / ask_user 的 schema 与执行器
  tool-dispatcher.ts       # isHarnessBuiltin / executeHarnessBuiltin / executeToolCall wrapper
  error-classifier.ts      # classifyToolError
  retry-policy.ts          # decideRetry + 退避参数
  side-effect-resolver.ts  # resolveSideEffect
  completion-policy.ts     # resolveCompletionSemantics + checkCompletion + updateObligations
  compaction.ts            # compressForAgentLoop + findSafeCutPoint
  stream-controller.ts     # progress buffer / flush / discard / commit
  timeout-clock.ts         # activeExecutionTime / userWaitTime 双时钟
```

另需新建(与 harness 同级或 utils 目录):

```
src/main/orchestrator/agent-loop-stream.ts   # WorkStreamEventBridge 搬迁目标
```

**搬迁 `WorkStreamEventBridge`**:
- [ ] 从 `two-phase-fc-loop.ts:283` 把 `WorkStreamEventBridge` 类完整搬到 `agent-loop-stream.ts`
- [ ] 更新 `chat-loop.ts` / `context-manager.ts` / `function-calling.ts` 中对该类型的 import 路径
- [ ] 新 `agent-loop-stream.ts` 不再 import 自 `two-phase-fc-loop.ts`

### 5.2 ToolDefinition 盘点与迁移(前置)

- [ ] 盘点 `tool-registry.ts` 中现有工具的 `effectKind` / `effectResolver` / `verificationPolicy` / `completionEvidence` 声明覆盖率
- [ ] 写机械迁移映射表:
  - `read` → `sideEffect: "read_only"` + `completionSemantics: { type: "read_self_evidence" }`
  - `mutation` → `sideEffect: "idempotent_mutation"` + `completionSemantics: { type: "require_post_verification" }`(默认)
  - `verification` → `sideEffect: "read_only"` + `completionSemantics: { type: "always_satisfied" }`
  - `external_side_effect` → `sideEffect: "non_idempotent_side_effect"` + `completionSemantics: { type: "require_post_verification" }`
  - `unknown` → `sideEffect: "read_only"` + `completionSemantics: { type: "always_satisfied" }`(保守默认)
- [ ] 为未声明的老工具设置默认值:`sideEffect: "read_only"`, `completionSemantics: { type: "always_satisfied" }`

### 5.3 实现顺序

建议按以下顺序实现,每一步都能独立编译:

1. **`types.ts`**:定义所有类型(含 `ToolCallOutcome` 扩展为 `success | failure | unknown | not_executed`)
2. **`builtin-tools.ts`**:实现 `update_todo` 和 `ask_user`
   - `update_todo`:验证 invariants、应用整表替换、emit `cyrene.todo`、**返回修正后的实际列表 + 修正说明**(让模型知道 Runtime 做了什么修正)
   - `ask_user`:把 questions 映射成 `AskClarificationCard`,调用 `requestUserClarification`,返回 `{ outcome: "success", answers: {...} }`
3. **`agent-loop-stream.ts`**:搬迁 `WorkStreamEventBridge`
4. **`side-effect-resolver.ts` + `completion-policy.ts`**:实现工具语义解析与 obligation 生命周期
5. **`error-classifier.ts` + `retry-policy.ts`**:实现错误分类与重试决策
6. **`tool-dispatcher.ts`**:统一 dispatch,集成截断、权限、ExecutionLedger、fingerprint 拦截
7. **`compaction.ts`**:实现配对安全切点 + agent 导向 prompt,**配单测**
8. **`stream-controller.ts` + `timeout-clock.ts`**:进度 buffer 与双时钟
9. **`cyrene-harness.ts`**:核心 while 循环,按 §3.1 v3 伪代码实现
10. **`index.ts`**:对外入口,接收现有调用参数,返回 `Promise<AgentResult>`

### 5.4 核心伪代码必须对齐 v3

实现时重点检查以下 v3 修正:

- [ ] 每轮 `callLLM` 后 `messages.push(normalizeAssistantMessage(response))`
- [ ] `tools = [...toolRegistry.getSchemas(), ...harnessBuiltinTools.getSchemas()]`
- [ ] 内置工具 dispatch:`isHarnessBuiltin(call.name) ? executeHarnessBuiltin(call) : executeToolCall(call)`
- [ ] **fingerprint 拦截**:执行普通工具前检查 `state.uncertainEffects.some(e => e.fingerprint == fingerprint(call))`,命中则返回 `runtime_safety` failure
- [ ] 同轮多 tool call 中断:遇 `fatal` 或 `unknown non_idempotent` 后,halt 后续调用并返回 `not_executed`
- [ ] `uncertainEffects` 写入 AgentState,Completion Guard 同时检查 obligations 和 uncertainEffects
- [ ] 相同 fingerprint 的副作用禁止直接重复执行
- [ ] mid-loop compaction:预算公式计入 toolSchemas + reservedOutputTokens + safetyMargin

### 5.5 工具输出截断接入

- [ ] 在 `executeToolCall` 出口统一截断
- [ ] 软截断 2000 字符,返回 `{ truncated, preview, fullOutputRef? }`
- [ ] 硬熔断 8000 字符
- [ ] 为 `read_file` / `run_shell` 等工具声明 `maxOutputChars` 和 `outputStorage`
- [ ] 副作用工具截断后**不**建议"可重跑"

### 5.6 ExecutionLedger 接入

- [ ] 把 `ExecutionLedger` 实例传入 Harness Loop
- [ ] 在工具执行前调用 ledger 去重/缓存逻辑
- [ ] 注意 ledger 当前接口,只复用不重构

### 5.7 编译验证

- [ ] `npm run build` 通过
- [ ] 新增单测:配对安全切点、error classifier、retry policy、todo invariant、uncertainEffects 拦截

---

## 6. Phase 4: 入口替换与旧代码删除

### 6.1 找到 Work/Daily 入口

- [ ] 搜索 `runWorkRequest` / `runDailyRequest` / 调用 `langgraph-agent-loop` / `two-phase-fc-loop` 的位置
- [ ] 常见入口:`cyrene-agent.ts` 中根据 `session.mode` dispatch 的地方

### 6.2 替换入口

- [ ] 在 mode 为 work/daily/learn 时调用 `runCyreneHarness(input)`
- [ ] 保留 chat/code 入口不变
- [ ] 确保 `requestUserClarification` 函数通过 context 传入 Harness

### 6.3 删除旧文件与残留引用

- [ ] 删除 `src/main/orchestrator/langgraph-agent-loop.ts`
- [ ] 删除 `src/main/orchestrator/agent-graph.ts`
- [ ] 删除 `src/main/orchestrator/action-gate.ts`
- [ ] 删除 `src/main/orchestrator/native-function-calling.ts`
- [ ] 删除 `src/main/orchestrator/two-phase-fc-loop.ts`
- [ ] 删除 `src/main/orchestrator/ask-soul.ts`
- [ ] 删除 `src/main/orchestrator/task-router.ts`(Phase 2 已处理引用)
- [ ] 删除 `built-in-tools.ts` 中 `ask_user_choice` 的注册(两处:1421 注释区 + 1490 定义区)
- [ ] 更新 `sub-agent.ts:31` 白名单:把 `ask_user_choice` 替换为 `ask_user`(新内置工具对子代理同样不可见)
- [ ] 更新 `email-tools.ts` / `document-tools.ts` 中提及 `ask_user_choice` 的注释为 `ask_user`
- [ ] 删除或更新 `native-function-calling.test.ts`(随 `native-function-calling.ts` 一起处理)
- [ ] 删除或更新 `agent-graph.test.ts` / `agent-graph-integration.test.ts` / `task-plan.test.ts` / `verification-matrix.test.ts` 中引用被删模块的测试

### 6.4 清理残留 import

- [ ] 运行 `npm run build`,根据报错清理所有残留 import
- [ ] 搜索 `langgraph` / `LangGraph` / `StateGraph` / `Annotation` / `CompiledStateGraph` 确保无残留

---

## 7. Phase 5: 前端事件调整

### 7.1 事件订阅改名

- [ ] 修改 `src/renderer/react/features/chat/pages/ChatPage.tsx:1085`
  - 把 `cyrene.taskPlan` 订阅改为 `cyrene.todo`
  - payload 形状从 TaskPlan 改为 `TodoItem[]`
- [ ] 确认 `cyrene.todos`(复数)订阅不动

### 7.2 清理 taskPlan 相关代码

- [ ] 删除 ChatPage 中只服务于 `cyrene.taskPlan` 的 TaskPlan 解析/渲染代码
- [ ] 修改 `src/renderer/react/features/chat/components/TaskPlanCard.tsx`:把 TaskPlan 渲染逻辑改为 TodoItem 渲染逻辑
- [ ] 修改 `src/renderer/react/features/chat/components/run-presentation.ts`:
  - 把 `TaskPlanPresentation` / `TaskPlanStep` 类型替换为 `TodoItem` 相关类型
  - 更新 `normalizeTaskPlanPresentation` 为 `normalizeTodoPresentation`
- [ ] 修改 `src/renderer/react/features/chat/components/ChatMessageList.tsx`:把 taskPlan 引用改为 todo
- [ ] 检查并更新 `src/main/orchestrator/run-execution-status.ts:51` 的注释
- [ ] 更新 `run-presentation.test.ts` 中 taskPlan 相关断言
- [ ] 保留 todo 卡片组件,只换数据源

### 7.3 UI 验证

- [ ] 启动应用,触发一次 Harness 任务
- [ ] 观察 `update_todo` 调用后 UI 是否正常更新

---

## 8. Phase 6: 集成测试与验收

### 8.1 单元测试(新增)

| 模块 | 测试点 |
|---|---|
| `compaction.ts` | 配对安全切点:构造 assistant(tool_calls) + tool + assistant + tool 序列,断言切点不会切断配对 |
| `retry-policy.ts` | read_only + transient → retry; non_idempotent + timeout → no_retry |
| `completion-policy.ts` | require_post_verification 产生 obligation;后续调用 verify 工具后 satisfied |
| `builtin-tools.ts` | 多 in_progress 降级;非法状态转移拒绝并回告 |
| `tool-dispatcher.ts` | uncertainEffect 存在时,相同 fingerprint 调用返回 runtime_safety 失败 |
| `cyrene-harness.ts` | assistant message 写回 messages;ask_user 排他;fatal 中断后续 tool call |
| `agent-loop-stream.ts` | WorkStreamEventBridge 搬迁后功能等价,现有 import 方编译通过 |

### 8.2 集成测试(手动)

| 场景 | 期望 |
|---|---|
| "读一个文件并告诉我内容" | 单次 tool call,content 作为 final answer commit |
| "修改 foo.ts 后跑测试" | write_file → run_shell(npm test),生成 verify obligation,测试通过后完成 |
| "发邮件" timeout | outcome=unknown,写入 uncertainEffects,模型不能结束,不能重复 send_email |
| 长任务(30+ 轮) | mid-loop compaction 触发,上下文不爆 |
| 读大文件 | 工具输出被截断,返回 preview + fullOutputRef |
| ask_user | 排他,其他同轮 tool call 返回 not_executed,回答后模型重新决策 |

### 8.3 验收标准

- [ ] `npm run build` 无错误
- [ ] `npm run test` 通过(新增单测 + 现有未删测试)
- [ ] Chat 模式完全可用
- [ ] Code 模式完全可用
- [ ] Work/Daily/Learn 模式能完成至少 3 个不同复杂度的真实任务
- [ ] 应用能正常打包(`npm run dist` 或 `npm run build:electron` 不报错)

---

## 9. 关键施工风险与应对

| 风险 | 应对 |
|---|---|
| 删除 LangChain 后 structured output 质量下降 | 先保留 runner 强制 legacy,用 `CYRENE_LEGACY_STRUCTURED_OUTPUT=1` 提前对比测试;质量下降时强化 adapter prompt,不回引 langchain |
| 新 Loop 引入协议错误(orphan tool_call) | 配对安全切点单测 + 集成测试验证 |
| 工具输出截断导致模型"看不见"关键信息 | 软截断附 preview + fullOutputRef;P1 做策略化截断 |
| uncertainEffects 拦截过严,模型卡住 | 提供 `reconcile` 工具或 `ask_user` 让用户确认,帮助解除 |
| 前端 `cyrene.taskPlan` 改名漏改 | 全局搜索 `taskPlan` / `cyrene.taskPlan`,确保只剩历史引用或已删除 |

---

## 10. 回滚方案

- [ ] 保留物理备份目录 `E:\Cyrene-Harness-Migration-Backup\2026-08-09\`
- [ ] 保留 git 分支 `feat/cyrene-harness`
- [ ] 如验收失败,直接 `git checkout master` 或 `git reset --hard master` 回滚
- [ ] 如部分功能不稳定,可 feature flag 控制:`USE_CYRENE_HARNESS=1` 环境变量走新 Loop,默认走旧代码(但 P0 目标是完全替换,不推荐长期 dual-path)

---

## 11. 文件清单总表

### 新建文件

| 文件 | 说明 |
|---|---|
| `src/main/orchestrator/harness/index.ts` | 对外入口 |
| `src/main/orchestrator/harness/cyrene-harness.ts` | 核心 while 循环 |
| `src/main/orchestrator/harness/types.ts` | 类型定义 |
| `src/main/orchestrator/harness/builtin-tools.ts` | update_todo / ask_user |
| `src/main/orchestrator/harness/tool-dispatcher.ts` | 统一 dispatch |
| `src/main/orchestrator/harness/error-classifier.ts` | classifyToolError |
| `src/main/orchestrator/harness/retry-policy.ts` | decideRetry |
| `src/main/orchestrator/harness/side-effect-resolver.ts` | resolveSideEffect |
| `src/main/orchestrator/harness/completion-policy.ts` | obligation / checkCompletion |
| `src/main/orchestrator/harness/compaction.ts` | mid-loop compaction + 配对切点 |
| `src/main/orchestrator/harness/stream-controller.ts` | progress buffer |
| `src/main/orchestrator/harness/timeout-clock.ts` | 双时钟 |
| `src/main/orchestrator/harness/__tests__/*` | 单测 |
| `src/main/orchestrator/agent-loop-stream.ts` | `WorkStreamEventBridge` 搬迁目标 |

### 修改文件

| 文件 | 修改内容 |
|---|---|
| `src/main/orchestrator/structured-output/backend.ts` | 强制返回 legacy |
| `src/main/services/llm/llm-client.ts` | 删除 langchain 分支 |
| `src/main/orchestrator/cyrene-agent.ts` | Work/Daily/Learn 入口替换;传入 ExecutionLedger / requestUserClarification |
| `src/main/orchestrator/tool-registry.ts` | 扩展 ToolDefinition(可选:sideEffect / completionSemantics / maxOutputChars / outputStorage) |
| `src/main/orchestrator/context-manager.ts` | 新增/复用 agent 导向压缩 prompt(如新增函数可不动原函数) |
| `src/renderer/react/features/chat/pages/ChatPage.tsx` | `cyrene.taskPlan` → `cyrene.todo` |
| `src/renderer/react/features/chat/components/TaskPlanCard.tsx` | TaskPlan 渲染逻辑 → TodoItem 渲染逻辑 |
| `src/renderer/react/features/chat/components/run-presentation.ts` | `TaskPlanPresentation` / `normalizeTaskPlanPresentation` → TodoItem 版本 |
| `src/renderer/react/features/chat/components/ChatMessageList.tsx` | taskPlan 引用 → todo 引用 |
| `src/renderer/react/features/chat/components/run-presentation.test.ts` | 更新 taskPlan 断言 |
| `src/main/orchestrator/run-execution-status.ts` | 更新 taskPlan 相关注释 |
| `src/main/orchestrator/sub-agent.ts` | 白名单 `ask_user_choice` → `ask_user` |
| `src/main/orchestrator/built-in-tools.ts` | 删除 `ask_user_choice` 注册 |
| `src/main/orchestrator/email-tools.ts` | 注释中 `ask_user_choice` → `ask_user` |
| `src/main/orchestrator/document-tools.ts` | 注释中 `ask_user_choice` → `ask_user` |
| `src/main/orchestrator/subagents/types.ts` | 迁入 task-plan 共享类型 |
| `package.json` | 删除 6 个 langchain 依赖 |

### 删除文件

| 文件 | 说明 |
|---|---|
| `src/main/orchestrator/langgraph-agent-loop.ts` | LangGraph 主循环 |
| `src/main/orchestrator/agent-graph.ts` | LangGraph 图定义 |
| `src/main/orchestrator/action-gate.ts` | Action Gate |
| `src/main/orchestrator/native-function-calling.ts` | Native FC |
| `src/main/orchestrator/two-phase-fc-loop.ts` | TwoPhaseFC legacy |
| `src/main/orchestrator/ask-soul.ts` | SOUL 独立阶段 |
| `src/main/orchestrator/task-router.ts` | 任务路由 |
| `src/main/orchestrator/structured-output/langchain-invoker.ts` | LangChain 结构化输出后端 |
| `src/main/orchestrator/agent-graph.test.ts` | 随 agent-graph.ts 删除 |
| `src/main/orchestrator/agent-graph-integration.test.ts` | 随 agent-graph.ts 删除 |
| `src/main/orchestrator/task-plan.test.ts` | 随 task-plan.ts 删除 |
| `src/main/orchestrator/verification-matrix.test.ts` | 引用旧模块,删除或重写 |
| `src/main/orchestrator/native-function-calling.test.ts` | 随 native-function-calling.ts 删除 |

---

## 12. 建议的 commit 序列

1. `infra: structured-output legacy-only, remove langchain deps`
2. `refactor: migrate subagents task-plan types, delete task-plan.ts`
3. `feat(harness): add types, builtin tools, side-effect and completion policy`
4. `feat(harness): add error classifier, retry policy, tool dispatcher`
5. `feat(harness): add mid-loop compaction with pair-safe cut point`
6. `feat(harness): add WorkStreamEventBridge migration to agent-loop-stream.ts`
7. `feat(harness): implement core CyreneHarness loop`
8. `feat(harness): wire CyreneHarness into cyrene-agent entry`
9. `chore: delete LangGraph and TwoPhaseFC files and tests`
10. `feat(ui): rename cyrene.taskPlan to cyrene.todo and update components`
11. `test(harness): add unit and integration tests`

---

## 13. 备注

- 施工顺序很重要:**先改 structured-output 删 LangChain → 再迁 task-plan → 再建 Harness → 最后删旧文件**。倒序会导致编译长期失败。
- `prompts/cyrene_harness.md` 内容由用户自行实测微调,施工时只需保证文件路径和注入逻辑正确。
- 本计划不含 CodeBuddy / HyperFrames / 视频相关改动。
