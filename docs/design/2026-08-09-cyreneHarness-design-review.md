# CyreneHarness 设计文档评估报告

> 评估对象:`docs/design/2026-08-08-cyreneHarnessloopdesign.md`
> 评估日期:2026-08-09
> 评估方式:对设计文档引用的全部代码证据逐一取证(两路并行代码探索,~100 次文件检查)

---

## 1. 总体结论

**方向正确,架构判断成熟,代码事实约 90% 属实。可以进入施工稿阶段,但必须先把 §3 列出的 3 个依赖盲区修进设计文档。**

设计哲学("Loop 简单,Harness 成熟"、"模型自主,Runtime 兜底")与 Claude Code / Codex 的实际架构一致。技术前提成立:LangGraph 在本项目确实只被当路由 DSL 用(无 checkpointer / stream / interrupt / parallel,全 src 零命中),彻底删除的代价可控。

---

## 2. 代码事实核验结果

### 2.1 完全属实的引用

| 设计文档声明 | 取证结果 |
|---|---|
| `agent-graph.ts:1067` `.compile()` 无 checkpointer | ✓ 精确命中;全 src 搜 checkpointer/MemorySaver 0 结果 |
| `action-gate.ts` schema 逼模型填表 | ✓ L94-179 为 schema 定义,L169-177 required 字段 |
| `native-function-calling.ts:58` `must_call` | ✓ 精确命中 `toolChoiceIntent: { mode: "must_call" }` |
| `langgraph-agent-loop.ts:1398-1412` SOUL system 拼接 | ✓ 精确命中 |
| `tool-outcome-normalizer.ts:14-19` retryable 默认 false | ✓ L17-18 `terminal ?? true` / `retryable ?? false` |
| `system-prompt-builder.ts:88-96` 工具 prompt 不加载人设 | ✓ buildToolSystemPrompt 明确不含 soul/identity |
| `subagents/graph.ts` 已是 plain TS while 循环 | ✓ L225 `while(true)`,零 LangChain import |
| Chat 模式单次 LLM 调用 | ✓ `chat-loop.ts:102-368`,一次 invokeWithStreamFallback |
| Code 模式外包 @cline/sdk | ✓ `code-request.ts` + `cline-esm-bridge.mjs`,@cline/sdk 0.0.66 |
| 80% 压缩机制可复用 | ✓ `context-manager.ts:93` `contextWindow * 0.8` |
| `agui-bridge.ts:241` session.mode 分流 | ✓ 精确命中 |
| ExecutionLedger 存在可复用 | ✓ `execution-ledger.ts` 79 行,终态成功缓存 + 10min TTL LRU |

### 2.2 需要修正的引用(小勘误)

| 设计文档 | 实际情况 |
|---|---|
| Action Gate 结构化输出在 L94-179 | schema 定义在 L94-179,**实际调用 `runStructuredOutput` 在 L485** |
| `SOUL_NO_TOOL_DIRECTIVE` 在 soul-execution-context.ts | 实际定义于 `langgraph-agent-loop.ts:175`,two-phase-fc-loop.ts:435 有一份局部副本 |
| WorkStreamEventBridge 在 two-phase-fc-loop.ts(暗示 legacy 独占) | 定义确在 L283,但 **langgraph-agent-loop.ts:50 也 import 它**(Soul 流式桥接);chat-loop.ts / context-manager.ts / function-calling.ts 还引用其类型 |

### 2.3 文件规模实测

| 文件 | 行数 |
|---|---|
| langgraph-agent-loop.ts | 1497 |
| agent-graph.ts | 1093 |
| two-phase-fc-loop.ts | 842 |
| action-gate.ts | 521 |
| native-function-calling.ts | 120 |
| structured-output/ 全目录 | ~1000+(17 文件,含 7 测试) |

**待删核心 5 文件合计约 4073 行**,设计文档说 "~2000 行" 低估了约一半。

---

## 3. 三个必须修正的依赖盲区(施工翻车风险)

### 3.1 `structured-output/` 不能整目录删除 ⚠️ 最严重

设计文档 §2.2 写"structured-output/ 整目录删除,CyreneHarness 不用"。但取证发现 `runner.ts` 的生产调用方包括:

- `memory/memory-llm-client.ts:18`(记忆系统 LLM 调用)
- `memory/memory-schemas.ts:9`(类型)
- `cita/remote-semantic-engine.ts:6`(CITA 远程语义引擎)
- `task-router.ts:11`
- `action-gate.ts:16`、`task-plan.ts:14`(这两个确实该删)

而 §2.4 明确说 memory 和 CITA "**完全不动**"——直接矛盾。

**连带问题**:`@langchain/anthropic` / `@langchain/openai` / `langchain` 等包只被 `structured-output/langchain-invoker.ts` import,而 langchain-invoker 的唯一生产调用方是 `services/llm/llm-client.ts:10`——**这是主 LLM 客户端**。backend.ts 里 anthropic/openai 走 langchain 后端,其他 provider 走 legacy。直接删 6 个 langchain 依赖会炸掉主聊天链路。

**建议修正**:删除清单改为"structured-output/ 中仅供 Action Gate/task-plan 使用的部分";langchain 依赖保留(或单独评估 llm-client 重构,列入 P1)。

### 3.2 `task-plan.ts` 被保留模块 subagents 引用

设计文档:task-plan 的 agent 部分整个删,subagents/ 完全不动。

实际:`subagents/types.ts`、`subagents/graph.ts`、`subagents/search-agent.ts`、`subagents/document-agent.ts` 都 import task-plan。

**建议修正**:施工前先确认 subagents 引用的是类型还是函数;若是类型,把共享类型迁移到独立文件(如 `subagents/types.ts` 本地),再删 task-plan。

### 3.3 `ask_user` 命名与事件名冲突

- 项目已存在注册工具 **`ask_user_choice`**(`built-in-tools.ts:1490-1553`,歧义消解器)。新 `ask_user` 工具需要明确与它的关系(替代/共存/改名),且子代理白名单(`sub-agent.ts:31`)当前屏蔽 ask_user_choice,新工具也要考虑子代理可见性。
- 事件名:`cyrene.taskPlan`(cyrene-agent.ts:197 产生,ChatPage.tsx:1085 消费)和 **`cyrene.todos` 复数**(todos/bootstrap.ts:18 产生,ChatPage.tsx:430 消费,仅 work/daily/learn)均已被占用。§16 开放问题 #1 提的 `cyrene.todo`(单数)目前空闲,可用,但需知会前端 `cyrene.todos` 是另一套待办系统,避免混淆。

---

## 4. 其他需要校准的点

### 4.1 代码量预期

- 删除面:~4073 行核心 + structured-output 部分,不是 ~2000 行。
- 新建面:"300-500 行"偏乐观。装入流式桥接(WorkStreamEventBridge 搬迁)、错误分类器(10 category × 3 sideEffect 矩阵)、obligation 生命周期、ask_user pending registry、双时钟、Provider Adapter(runtimeFeedback 映射)、Todo invariant 校验后,**现实估计 800-1500 行**。仍然远好于现状,但建议在 §13.2 调整预期,避免施工时被认为"膨胀"。

### 4.2 `prompts/cyrene_harness.md` 是空壳

文件存在(468 B,12 行),但内容只有"待你填写"占位说明。**§4 整个人设策略的基石尚未落地**,且当前无任何代码加载它。建议在 P0 任务清单里显式加入"撰写 cyrene_harness.md + 接线加载"两项,而不是假设它已就绪。

### 4.3 离 codex / Claude Code 级 loop 还差的两个未提及点

1. **Mid-loop compaction**:现有压缩只在 4 个 loop 入口前置触发(chat-loop:107、langgraph-agent-loop:370、two-phase-fc-loop:660、function-calling:270)。连续 Agent Loop 里上下文在循环中途膨胀,需要在 while 循环内每轮判断。设计文档把 compaction 整体推到 P1,但"循环内检查时机"这个接缝应该在 P0 架构里预留(否则 P1 要改循环主体)。
2. **工具输出截断 / token 预算**:codex/Claude Code 的 harness 都有工具结果大小管控(大文件读取截断、grep 结果限量)。设计文档完全没提,这是连续 loop 上下文爆炸的最常见来源,建议至少列入 P1 并注明。

### 4.4 现有 ToolDefinition 与设计 §6.1 的关系

`tool-registry.ts` 的 ToolDefinition **已有**:`effectKind`(read/mutation/verification/external_side_effect/unknown,5 值)+ `effectResolver` + `verificationPolicy` + `completionEvidence` + `ledgerPolicy`。

设计 §6.1 说"不再保留 effectKind 字段"——文档是知道它存在的(写了"原来 read/mutation/external_side_effect 三分"),但实际是 5 值且带 resolver 函数。这意味着:
- sideEffect/completionSemantics 不是从零新增,而是**对现有字段的语义升级**,迁移成本比想象低;
- §16 开放问题 #3(老工具没声明时默认什么)需要盘点现有工具的 effectKind 声明覆盖率,大概率可以写机械迁移映射(read→read_only+always_satisfied 等)。

### 4.5 ExecutionLedger 当前只接了 LangGraph 路径

cyrene-agent.ts:391-400:ledger 按 scope 创建后**只传给 LangGraph 路径**,legacy 路径没有。P0 "接入并复用"是正确判断,施工时注意 Harness 路径要显式传 ledger(现状不是全局自动生效)。

---

## 5. 设计亮点(建议原样保留)

以下设计决策对标了成熟 harness(Claude Code / Codex)的实际做法,是这份文档最有价值的部分:

1. **Obligation 数组替代扫历史**(§6.3):失败/supersede 的旧调用不永久 block 完成,这解决了 plan-and-execute 架构的经典腐化点。
2. **outcome 三态(success/failure/unknown)**(§5.5.1):显式承认"非幂等副作用超时后结果不可知",不伪装成 failure 误导重试——很多生产级 agent 都没做这一点。
3. **Error Category × Side-effect 二维决策 + fail-safe 默认**(§5.2/5.3):shell 命令默认 non_idempotent,拒绝"智能语义分析器",工程上正确。
4. **Progress buffer vs Final commit**(§7.1):Final Answer 不逐 token 流,Completion Guard 通过后才 commit——"正确性优先于实时性"的论证(先撒谎再撤回问题)成立。
5. **Runtime Feedback 不伪装 role:user**(§6.5.1):对 crash 恢复和模型行为都重要,Provider Adapter 映射是正确抽象。
6. **双时钟**(§10):用户等待不计入 execution timeout,细节但关键。
7. **Completion Guard 边界声明**(§6.4.1):"禁止膨胀成第二套 Workflow"——作者清楚自己在防什么,这是避免重蹈 LangGraph 覆辙的自律条款。

---

## 6. 与 codex / Claude Code / ZCode 级 loop 的差距评估

| 维度 | 设计文档覆盖 | 差距 |
|---|---|---|
| 单 loop + tool_choice:auto | ✓ §3 | 已对齐 |
| 确定性重试 | ✓ §5 | 已对齐(甚至超过,codex 没有 outcome 三态) |
| 完成守卫 | ✓ §6 obligation | 已对齐(Claude Code 靠 prompt + hook,obligation 数组更显式) |
| Todo 状态 | ✓ §8 | 已对齐(Claude Code 的 TodoWrite 同构) |
| Ask user | ✓ §9 排他工具 | 已对齐 |
| 人设连续性 | ✓ §4 两套独立 persona | 这是 Cyrene 特有需求,方案合理 |
| Context compaction | P1,但未留循环内接缝 | **小差距**,见 §4.3 |
| 工具输出预算 | 未提及 | **小差距**,见 §4.3 |
| 并行只读工具 | P0 串行 | 可接受,P1 再加 |
| Checkpoint/resume | P1 | 合理分期 |

**结论:P0 交付后,核心 loop 体验可达到 codex/Claude Code 同构水平;差距在工程细节(上下文管理)而非架构。**

---

## 7. 建议的下一步

1. **修设计文档**:把 §3 的三个盲区(structured-output 调用方、task-plan 被 subagents 引用、ask_user_choice 冲突)写进 §2.2/§16。
2. **补盘点**:施工稿前盘点(a)现有工具的 effectKind 声明覆盖率 → 机械迁移映射表;(b)structured-output/runner.ts 的全部调用方 → 精确删除面;(c)llm-client.ts 对 langchain-invoker 的依赖形态 → langchain 依赖去留。
3. **填写 `prompts/cyrene_harness.md`**:这是 §4 的基石,目前是空模板。
4. **预留两个 P1 接缝**:mid-loop compaction 检查点、工具输出截断策略,在 P0 循环主体里留好挂载位置。
5. 之后再进施工稿。
