# CyreneHarness 施工进度总结

> **日期**:2026-08-09
> **状态**:P0 主体完成,待集成测试

---

## 一、已完成的工作

### 1. 设计文档(v3 架构冻结)

设计文档经过 v1 → v2 → v3 三轮迭代,补入了所有关键逻辑漏洞,已达到"架构冻结,可写施工计划"状态。

- v2:structured-output 保留 runner 强制 legacy / LangChain 6 依赖全删 / ask_user 复用现有澄清链路 / todo 事件定名 `cyrene.todo` / mid-loop compaction + 工具截断提前到 P0
- v3:assistant response 写回 messages / uncertainEffects 状态拦截伪完成与重复副作用 / Harness 内置工具统一 dispatch / 同轮多 tool call 中断规则 / compaction token budget 计入 tool schemas / fullOutputRef 语义明确

### 2. 代码改动

#### 新建的 Harness 模块(12 个文件,~1800 行)

| 文件 | 行数 | 职责 |
|---|---|---|
| `harness/types.ts` | ~210 | 核心类型(AgentState / ToolCallOutcome 四态 / UncertainEffect / TodoItem / HarnessConfig) |
| `harness/side-effect-resolver.ts` | ~35 | effectKind → SideEffectKind 映射 |
| `harness/error-classifier.ts` | ~75 | 工具错误分类(10 个 category) |
| `harness/retry-policy.ts` | ~80 | 重试决策 + 退避参数 |
| `harness/completion-policy.ts` | ~200 | obligation 生命周期 + uncertainEffects 拦截 + checkCompletion |
| `harness/builtin-tools.ts` | ~260 | update_todo(invariant 校验 + 修正回告)+ ask_user(复用 requestUserClarification) |
| `harness/tool-dispatcher.ts` | ~200 | 统一 dispatch + fingerprint 拦截 + 双级截断 |
| `harness/compaction.ts` | ~200 | mid-loop token budget + 配对安全切点 + agent 导向 prompt |
| `harness/stream-controller.ts` | ~55 | progress buffer / flush / discard / commit |
| `harness/timeout-clock.ts` | ~90 | 双时钟(activeExecution + userWait) |
| `harness/cyrene-harness.ts` | ~350 | 核心 while 循环(v3 §3.1 完整实现) |
| `harness/index.ts` | ~40 | 对外入口 |

#### 新建的适配层(1 个文件)

| 文件 | 行数 | 职责 |
|---|---|---|
| `harness-adapter.ts` | ~200 | CyreneRunOptions → HarnessInput, HarnessEvent → AG-UI BaseEvent, HarnessResult → TwoPhaseFcResult |

#### 修改的文件

| 文件 | 改动 |
|---|---|
| `cyrene-agent.ts` | work/daily/learn 路径只走 harness;类型本地定义(TwoPhaseFcResult / TwoPhaseEvent / AgentLoopSettings / SkillRouteInfo) |
| `build-options.ts` | SkillRouteInfo 从 cyrene-agent import |
| `chat-loop.ts` | 类型从 cyrene-agent import |
| `function-calling.ts` | 类型从 cyrene-agent import |
| `context-manager.ts` | 类型从 cyrene-agent import |
| `task-plan.ts` | 内联 TaskRoute 类型(原 task-router 已删) |
| `cyrene-agent.test.ts` | 删除旧循环 mock 和测试用例 |
| `structured-output/backend.ts` | 简化为 legacy-only |
| `structured-output/dispatcher.ts` | 删除 langchain 参数 |
| `structured-output/backend.test.ts` | 更新为 legacy-only 测试 |
| `structured-output/dispatcher.test.ts` | 更新为 legacy-only 测试 |
| `llm-client.ts` | 删除 invokeLangChainStructured import 和 langchain callback |
| `ChatPage.tsx` | 添加 cyrene.todo 事件订阅(与 cyrene.taskPlan 并存) |
| `package.json` | 删除 6 个 LangChain 依赖 |

#### 删除的文件(22 个)

**源文件(7 个)**:`langgraph-agent-loop.ts`、`agent-graph.ts`、`action-gate.ts`、`native-function-calling.ts`、`two-phase-fc-loop.ts`、`ask-soul.ts`、`task-router.ts`

**测试文件(15 个)**:上述 7 个源文件对应的测试 + `task-plan.test.ts`、`verification-matrix.test.ts`、`phase2-link-verification.test.ts`、`soul-execution-context.test.ts`、`subagents/document-agent.test.ts`、`structured-output/langchain-invoker.test.ts`

**依赖(6 个)**:`@langchain/langgraph`、`@langchain/core`、`@langchain/anthropic`、`@langchain/openai`、`@langchain/deepseek`、`langchain`

### 3. 编译状态

- TypeScript 编译:**零错误**
- Lint:**零错误**
- 已有测试:structured-output 80 个测试全绿

---

## 二、原设计中尚未实现的部分

### P0 范围内未完成(需要补)

| # | 项目 | 说明 | 影响 |
|---|---|---|---|
| 1 | **ExecutionLedger 未接入 Harness** | 设计稿 §12 P0 清单明确要求"ExecutionLedger P0 接入并复用,Harness 路径要显式传入"。当前 `cyrene-harness.ts` 和 `harness-adapter.ts` 没有传入 ledger | 工具去重失效,同一参数的只读工具可能重复执行 |
| 2 | **`prompts/cyrene_harness.md` 未注入** | 设计稿 §4.5 要求 System Prompt 分层注入(Persona + Runtime Policy)。当前 `harness-adapter.ts` 的 `buildHarnessSystemPrompt` 只拼接了 soul/tool/runtime context,没有加载 `cyrene_harness.md` | 模型缺少 Harness 专属人设和行为指引 |
| 3 | **`sub-agent.ts` 白名单未更新** | 仍在屏蔽 `ask_user_choice`(已删),应改为屏蔽 `ask_user` | 子代理白名单引用了不存在的工具名 |
| 4 | **Harness 单元测试** | 设计稿 §12 P0 和施工计划要求配单测(配对安全切点、error classifier、retry policy、todo invariant、uncertainEffects 拦截)。当前 `harness/` 目录下无任何 `.test.ts` 文件 | 核心逻辑无测试保护 |
| 5 | **`built-in-tools.ts` 中 `ask_user_choice` 注册未删** | 施工计划要求删除 `built-in-tools.ts:1490-1553` 的 `ask_user_choice` 注册 | 旧工具仍暴露给模型,与新 `ask_user` 冲突 |
| 6 | **`task-plan.ts` 保留为死代码** | 原计划删除,但因 subagents 类型依赖链太深而保留。agent 函数(`runCreatePlan` / `verifyStep` / `runReplan`)已无调用方,但类型(`PlanStep` / `StepVerificationResult`)仍被 subagents 使用 | 死代码残留,不影响编译 |
| 7 | **`cyrene.taskPlan` 前端清理未完成** | `ChatPage.tsx` 添加了 `cyrene.todo` 订阅,但旧的 `cyrene.taskPlan` 订阅代码未删除;`TaskPlanCard.tsx` / `run-presentation.ts` / `ChatMessageList.tsx` 未改 | 前端有两套 todo 逻辑并存 |

### P1 范围(设计稿明确推后)

| # | 项目 | 说明 |
|---|---|---|
| 1 | Session persistence / Checkpoint / resume | 跨进程持久化恢复 |
| 2 | Todo State 持久化 | 跟 Checkpoint 一起 |
| 3 | Context compaction 精细化 | 按用户回合保留(现按消息条数);obligation / todo 注入摘要 |
| 4 | 分工具策略化截断 | `read_file` 头尾保留 / `grep` 限条数 / shell 保留 stderr 尾 |
| 5 | ExecutionLedger 持久化 | idempotency key / crash recovery |
| 6 | `ToolDefinition` 正式扩展 `sideEffect` / `completionSemantics` 字段 | 当前用 effectKind 临时映射,未加新字段 |
| 7 | `fullOutputRef` backing store | 当前 `fullOutputRef` 始终 undefined,未实现 ToolOutputStore |
| 8 | 真正的 durable suspend / resume | ask_user 当前是 pending Promise,不跨进程持久化 |
| 9 | `keepRecent` 按用户回合计 | 当前按消息条数(20 条),agent loop 里一个用户 turn 可有 30+ 条 |

### P2 范围(设计稿明确推后)

- memory.json 原子写入改造
- fs-tools / document-tools 原子写入改造
- Goal mode
- SubAgent 并行

### 不在本设计稿范围内

- 具体工具实现(fs-tools / document-tools 等)的改动
- Code 模式(@cline/sdk)
- memory / CITA / rag / worldbook 长期记忆系统
- `cyrene.todos`(复数,用户待办系统)

---

## 三、当前架构状态

```
用户消息
  ↓
cyrene-agent.ts (入口)
  ├─ chat 模式 → chat-loop.ts (不动)
  ├─ code 模式 → @cline/sdk (不动)
  └─ work/daily/learn 模式 → harness-adapter.ts
                                    ↓
                              cyrene-harness.ts (核心 while 循环)
                                ├─ callLLM (vendor adapter)
                                ├─ assistant response 写回 messages
                                ├─ mid-loop compaction (配对安全切点)
                                ├─ tool dispatch (内置 + 普通)
                                │   ├─ update_todo (内置, 直接改 state)
                                │   ├─ ask_user (内置, requestUserClarification)
                                │   └─ 普通工具 (executeToolCall + 截断)
                                ├─ uncertainEffects 拦截
                                ├─ completion guard (obligations + uncertain)
                                └─ 双时钟超时
```

**旧架构已完全移除**:LangGraph 路径、TwoPhaseFC 路径、Action Gate、Native FC、SOUL 独立阶段、Task Router 全部删除。CyreneHarness 是 work/daily/learn 的唯一执行路径。

---

## 四、下一步建议(按优先级)

1. **补 ExecutionLedger 接入**(5 分钟,改 `harness-adapter.ts`)
2. **补 `cyrene_harness.md` 注入**(5 分钟,改 `harness-adapter.ts`)
3. **删 `built-in-tools.ts` 中 `ask_user_choice` 注册**(2 分钟)
4. **更新 `sub-agent.ts` 白名单**(1 分钟)
5. **清理前端 `cyrene.taskPlan` 残留**(15 分钟)
6. **写 Harness 单元测试**(1-2 小时)
7. **端到端集成测试**(启动应用,跑真实任务)
