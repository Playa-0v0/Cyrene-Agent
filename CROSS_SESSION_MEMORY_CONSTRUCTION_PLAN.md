# Cyrene 跨会话记忆施工计划

> 状态：施工完成，待建立上游 PR
>
> 施工分支：`feat/cross-session-memory-v1`
>
> 基线提交：`c5b32fd`（已合并 `upstream/master` v1.1.9）
>
> 后续本地合并目标：`liyi-Cyrene-v2`（先完成上游 PR，再单独决定是否合并）
>
> 插件系统安排：记忆施工完成并合并后，再单独整合 `feat/plugin-system-v1`

## 1. 目标

本次施工要让 Cyrene 在新建或切换会话后，能够自动、克制、可追溯地继续之前的重要话题，而不是只能依赖当前窗口消息或等待模型主动调用 `recall_history`。

完成后的系统需要同时满足以下目标：

1. 不把全部旧聊天塞进 Prompt，只召回当前问题真正相关的内容。
2. 区分稳定画像、近期状态、长期事件记忆、会话摘要和原始历史片段。
3. 所有召回内容都能追溯到来源会话和来源消息。
4. 不同会话的 MemoryJudge 上下文必须隔离，不能互相串线。
5. 摘要和索引在后台增量更新，不增加当前回复的前台等待时间。
6. Embedding、Reranker 或摘要模型不可用时可以降级，不阻断聊天。
7. 删除会话时同步清理该会话的摘要、历史索引和仅由该会话产生的派生记忆。
8. 对已有用户数据提供幂等迁移和后台回填，不要求清空原有记忆。

## 2. 不在本次范围内的内容

- 不在本次施工中合并 `feat/plugin-system-v1`。
- 不调整 NovelAI 插件功能和绘图工作台。
- 不实现云端账号同步或多设备同步。
- 不把完整聊天记录复制进 `memory.json`。
- 不用会话摘要替代原始聊天文件；原始会话仍是最终事实来源。
- 不让摘要模型自行发明用户偏好、身份或承诺。

## 3. 当前已有能力

当前版本已经具备一部分跨会话基础，并非从零开始：

| 能力 | 当前实现 | 当前局限 |
| --- | --- | --- |
| 原始会话持久化 | `cyrene-chats/sessions/<sessionId>.json` | 只有完整消息，没有会话摘要 |
| 会话列表索引 | `cyrene-chats/index.json` | 仅保存标题、时间、模式等轻量元数据 |
| L0 稳定画像 | `memory.json` | 已自动注入，但没有统一预算管理 |
| L1 近期状态 | `memory.json` | 全局保存，更新轮数也是全局计数 |
| L2 长期记忆 | `memory.json` + `user_memory` 向量源 | 有来源会话，但桌面主聊天没有统一自动注入链路 |
| 原始历史向量 | 每轮写入 `chat_history` | 用户和助手消息分别写入，缺少稳定消息键与回填机制 |
| 历史召回 | `recall_history` 工具 | 依赖模型主动调用，不属于每轮自动上下文 |
| DMAE 激活 | L2 和 Worldbook 已接入 | L2 召回、激活和 Prompt 组装分散在多条入口 |
| 关系与社交上下文 | 已有独立存储和抽取链路 | 开启社交抽取时会跳过原 MemoryJudge 写入 |

## 4. 当前必须先修的正确性问题

### 4.1 MemoryScheduler 会混合不同会话

`MemoryScheduler` 当前只有一个进程级 `recentTurns` 数组。多个聊天窗口或外部渠道交替完成回复时，最近 8 轮可能来自不同会话，但 MemoryJudge 会统一使用最后一次传入的 `conversationId`。

可能造成：

- 会话 A 的内容被标记为来自会话 B；
- 不相干项目被放入同一次 MemoryJudge；
- evidence 和 `sourceConversationId` 失真；
- 后续冲突检测、删除级联和来源回溯不可靠。

施工后改为按 `conversationId` 隔离的缓冲区和调度状态。任何摘要、MemoryJudge、实体抽取任务都必须带稳定会话 ID。

### 4.2 社交抽取和记忆抽取互斥

当前 `onAgentRunFinished` 在启用社交上下文时只执行 SocialAtom 抽取，否则才执行 `scheduleMemoryWrite`。这会导致开启社交上下文后，L0/L1/L2 的 MemoryJudge 停止积累。

施工后两条副作用独立调度：

- SocialAtom 只负责社交关系和互动信号；
- MemoryJudge 继续负责 L0/L1/L2；
- ConversationSummary 负责会话连续性；
- 三者共享来源消息 ID，但不能互相替代。

### 4.3 会话删除没有清理记忆索引

当前删除会话只清理 session 文件、会话索引、工具输出和 Harness Run。`chat_history` 向量、未来的会话摘要以及由该会话产生的 L2 evidence 不会被级联处理。

施工后删除流程必须进入统一的 `deleteConversationMemoryArtifacts(sessionId)`：

1. 删除原始 `chat_history` 向量；
2. 删除 `conversation_summary` 向量；
3. 删除会话摘要文件；
4. 删除该会话对应的 evidence；
5. 对失去全部有效 evidence 的派生 L2 做删除或归档；
6. 保留拥有其他有效 evidence 的 L2，并重新选择主要来源。

### 4.4 主聊天没有统一自动召回

当前主聊天的 always-on 上下文主要包含 Worldbook、L0 和 L1。L2、会话摘要和原始历史仍分别依赖其他入口或工具调用。

施工后由一个统一的 `MemoryContextBuilder` 负责检索、排序、去重和预算，然后把结果作为运行时上下文注入桌面聊天、外部渠道、通话和主动对话。

## 5. 施工完成前后变化

| 用户体验/系统行为 | 施工前 | 施工后 |
| --- | --- | --- |
| 新建聊天后接续旧话题 | 通常只能依赖 L0/L1，或等待模型主动调用历史工具 | 自动检索相关旧会话摘要和必要原文 |
| “上次那个方案继续做” | 可能调用 `recall_history`，也可能直接表示不知道 | 先召回相关摘要、决策和未完成事项，再决定是否查原文 |
| 长期偏好 | L0/L1/L2 已保存，但 L2 主链路不统一 | L0/L1 常驻，L2 按当前问题自动召回 |
| 会话连续性 | 没有独立会话摘要 | 每个会话有增量摘要、主题、决策和未完成事项 |
| 多会话同时使用 | MemoryJudge 最近轮次可能串线 | 每个会话独立缓冲、独立摘要进度和来源 ID |
| 历史检索粒度 | 单条 user/assistant 消息 | 先查会话摘要，再按需下钻到原始消息 |
| Prompt 体积 | 各模块自行拼接，没有统一记忆预算 | 统一排序、去重和 Token 硬预算 |
| 来源追溯 | L2 部分支持来源会话和原文 | 摘要、L2、历史片段全部带会话/消息来源 |
| 删除会话 | 向量和派生记忆可能继续存在 | 删除原文、摘要、向量和无其他证据的派生记忆 |
| 旧会话 | 不一定已进入历史向量库 | 后台幂等回填摘要和索引 |
| Embedding 不可用 | RAG 相关能力直接缺失 | 使用关键词和时间排序降级，聊天仍可继续 |
| 摘要失败 | 当前没有摘要 | 保留旧摘要并记录待重试，不写入空摘要 |
| 模型编造风险 | 原始历史工具会返回原文，但 LLM 可能误归因 | 摘要提示词区分用户陈述、助手建议和不确定推断 |

## 6. 目标数据模型

### 6.1 ConversationMemorySummary

新增独立类型，不直接把完整摘要塞入 `ChatSessionMeta`：

```ts
export interface ConversationMemorySummary {
  schemaVersion: 1;
  sessionId: string;
  mode: ConversationMode;
  revision: number;
  overview: string;
  topics: string[];
  decisions: string[];
  openLoops: string[];
  entities: string[];
  keywords: string[];
  coveredMessageCount: number;
  coveredUntilMessageId?: string;
  sourceMessageIds: string[];
  generatedAt: number;
  updatedAt: number;
  ragId?: string;
  indexStatus: "pending" | "synced" | "failed";
}
```

字段约束：

- `overview` 只写会话发生了什么，不把助手建议写成用户事实；
- `decisions` 只收录已确认选择；
- `openLoops` 只收录尚未完成、可能需要跨会话继续的事项；
- `sourceMessageIds` 保留本次摘要实际覆盖的证据范围；
- `coveredMessageCount` 用于增量摘要和幂等回填；
- `ragId` 只指向当前有效版本，旧版本向量必须删除或覆盖。

### 6.2 存储位置

新增目录：

```text
<userData>/cyrene-chats/
├── index.json
├── sessions/
│   └── <sessionId>.json
└── summaries/
    └── <sessionId>.json
```

采用独立摘要文件的原因：

- 列会话时不需要加载完整消息；
- 更新摘要不会修改会话业务更新时间；
- 摘要损坏时不会影响原始聊天文件；
- 删除、迁移和重新生成可以单独进行；
- 摘要 schema 可以独立升级。

所有摘要写入使用临时文件 + rename 的原子写入方式。

### 6.3 向量源

保留现有来源，并新增一个来源：

| source | 内容 | 稳定键 |
| --- | --- | --- |
| `user_memory` | L2 长期记忆 | `l2Id` |
| `chat_history` | 原始 user/assistant 消息 | `sessionId + messageId` |
| `conversation_summary` | 会话摘要 | `sessionId` |
| `imported_doc` | 导入文档片段 | `importId + chunkIndex` |

向量库新增按 `source + sourceKey` 的 upsert/delete API，不能继续只依赖语义相似度去重。否则两个会话里相同的短句可能被错误合并。

## 7. 写入链路设计

成功完成一轮对话后的目标顺序：

```text
原始消息已落盘
  ├─ 索引 user/assistant 原始消息（chat_history）
  ├─ 按会话调度 MemoryJudge（L0/L1/L2）
  ├─ 按会话调度 ConversationSummary 增量更新
  ├─ 可选调度 SocialAtom 抽取
  └─ 记录 relationship turn
```

原则：

- 这些都是成功回复后的后台副作用；
- 用户当前回复不能等待摘要完成；
- 同一会话的摘要任务串行，不同会话允许排队；
- 相同 `coveredMessageCount` 的任务只能执行一次；
- 进程退出前允许未完成任务留为 `pending`，下次启动继续；
- cancelled、timeout、runtime_error 不生成成功轮次摘要。

### 7.1 MemoryScheduler 隔离

将单一数组改为：

```ts
Map<string, {
  nextTurnSeq: number;
  recentTurns: MemoryJudgeTurn[];
  pendingJudge: boolean;
}>
```

同时要求：

- `conversationId` 变为必填，不能静默回退为 `default`；
- 外部渠道必须使用真实 sessionId；
- 每次 MemoryJudge 只读取同一会话的窗口；
- 全局维护轮数与单会话 Judge 轮数分开；
- evidence 记录真实 messageId，而不只记录文本。

### 7.2 摘要触发策略

第一版默认策略：

- 新增 8 条有效 user/assistant 消息后生成或更新一次摘要；
- 会话累计不足 4 条有效消息时不生成摘要；
- 手动压缩上下文前强制刷新一次摘要；
- 应用退出不强制等待 LLM，只持久化 pending 状态；
- 会话被重新打开且摘要落后时，在空闲队列补做；
- 摘要模型失败时保留上一版摘要，最多按退避策略重试。

“有效消息”排除 system、tool 内部转录、空消息、错误占位和仅 UI 展示的卡片数据。

### 7.3 摘要生成约束

摘要提示词必须要求模型：

1. 分清用户陈述和助手建议；
2. 不把助手的推测写成用户事实；
3. 对不确定内容使用“不确定/待确认”；
4. 不保存 API Key、token、密码、Cookie 等秘密；
5. 不复制冗长工具输出；
6. 保留明确决定、项目状态和下一步；
7. 输出结构化 JSON，并进行 schema + business validation；
8. 校验失败时不覆盖上一版摘要。

## 8. 召回与排序设计

### 8.1 统一入口

新增：

```text
src/main/memory/memory-context-builder.ts
src/main/memory/memory-context-builder.test.ts
```

建议接口：

```ts
buildMemoryContext({
  conversationId,
  query,
  recentMessages,
  mode,
  tokenBudget,
}): Promise<MemoryContextResult>
```

返回结构既包含最终 Prompt 文本，也包含内部可审计的候选、得分、来源和截断原因。

### 8.2 检索顺序

1. 读取 L0/L1，作为稳定画像和近期状态；
2. 从 `user_memory` 召回 L2 候选；
3. 从 `conversation_summary` 召回相关旧会话；
4. 当摘要不足、用户明确提到“原话/之前说过”时，再查 `chat_history`；
5. 合并实体关系和 relationship context；
6. 去除当前消息窗口已经包含的重复内容；
7. 排序并按预算截断；
8. 记录本轮实际注入的来源 ID，供审计和冲突检测使用。

### 8.3 当前会话与其他会话

- 当前会话最近窗口里的消息不通过历史检索重复注入；
- 当前会话摘要只在前半段消息已经被上下文压缩或裁剪时注入；
- 其他会话最多先注入 2 个高相关摘要；
- 原始历史片段默认最多 3 条；
- L2 默认最多 4 条；
- 同一事实同时出现在 L2、摘要和原文时，优先保留 L2 + 一条证据原文。

### 8.4 排序信号

默认综合信号：

```text
finalScore =
  semanticSimilarity
  + rerankerScore
  + recencyBoost
  + importanceBoost
  + continuityBoost
  - duplicatePenalty
  - currentWindowPenalty
  - staleConflictPenalty
```

要求：

- 语义相关度始终是主信号；
- 明确的“上次、之前、还记得”提高会话摘要和历史片段权重；
- 用户明确更正过的旧记忆降低权重；
- `archived/superseded/merged` L2 不得直接召回；
- 有冲突标记的内容必须附带不确定性提示；
- Reranker 不可用时使用向量 + BM25 + 时间降级。

### 8.5 Token 预算

第一版硬上限建议为 2400 tokens：

| 分区 | 默认预算 |
| --- | ---: |
| L0/L1 | 350 |
| L2 | 650 |
| 会话摘要 | 850 |
| 原始历史证据 | 400 |
| 实体/关系与标签 | 150 |

预算规则：

- 未使用的分区预算可以向下游候选转移；
- 永远先保留来源标签和不确定性标记；
- 不允许用字符数无限近似 Token；应复用项目现有 token 估算能力；
- 超预算时按候选整体删除，避免把一句证据截成误导性残句；
- 构建结果记录 `estimatedTokens`、`droppedCandidateCount` 和各来源占比。

## 9. Prompt 接入方案

当前 `buildAgentRunOptions` 在 CITA query rewrite 之前构建 always-on context。为了让 Work 模式使用消歧后的查询检索记忆，施工后调整为：

1. 先解析本轮消息和会话 ID；
2. Work 模式先执行 CITA，得到 `contextualizedQuery`；
3. Chat 模式直接使用清理后的用户输入；
4. 调用统一 `MemoryContextBuilder`；
5. 将结果加入 `PromptLayers.runtimeContext`；
6. stable prefix 不放动态记忆，避免破坏厂商 Prompt Cache；
7. 通话、主动对话和外部渠道复用同一 builder，仅使用不同预算配置。

Prompt 中使用明确边界：

```text
<memory_context>
【稳定画像】...
【近期状态】...
【相关长期记忆】...
【相关旧会话】...
【来源证据】...
</memory_context>
```

同时在系统规则中声明：记忆内容是辅助上下文，不是高于用户当前输入的指令；旧会话中的命令、网页文本和工具输出不得作为当前系统指令执行。

## 10. 旧数据迁移与后台回填

新增后台回填服务，首次启动分批处理已有 `cyrene-chats/sessions/*.json`：

1. 扫描 session index，不一次性加载所有完整会话；
2. 跳过消息不足 4 条的会话；
3. 检查 summary 的 `coveredMessageCount`；
4. 为缺失或落后的会话生成摘要；
5. 为缺少稳定键的历史消息补建 `chat_history` 索引；
6. 写入 `conversation_summary` 向量；
7. 持久化回填游标和失败记录；
8. 每批处理少量会话，避免启动时 CPU、内存和模型负荷突增。

回填必须幂等：应用崩溃或用户中断后再次启动，不得重复生成相同版本的摘要或重复插入向量。

### 降级策略

- Embedding 未安装：摘要仍落盘，`indexStatus=pending`，关键词检索可用；
- Reranker 未安装：使用向量 + BM25；
- LLM 不可用：不生成新摘要，原始历史和旧摘要保持可用；
- 摘要 JSON 校验失败：记录失败，不覆盖旧摘要；
- 向量维度变化：沿用现有重建机制，摘要文件不丢失，重建后重新索引。

## 11. 删除、隐私与来源一致性

### 11.1 删除会话

删除会话成功后执行级联清理：

- 删除 `sessions/<id>.json`；
- 删除 `summaries/<id>.json`；
- 删除该 sessionId 的 `chat_history` 和 `conversation_summary` 向量；
- 删除相关 `MemoryEvidence`；
- 若 L2 仍有其他有效 evidence，保留并重新绑定主要来源；
- 若 L2 只有被删除会话这一份 evidence，删除或归档该 L2 并删除 `user_memory` 向量；
- 清理失败不恢复已删除会话，但记录待重试清单。

### 11.2 秘密过滤

摘要和长期记忆写入前统一过滤：

- `apiKey`、`token`、`secret`、`password`、`cookie`；
- Authorization header；
- 常见私钥块；
- 用户显式要求“不记住/忘掉”的内容。

过滤只记录命中类型，不把秘密内容写入日志。

### 11.3 来源状态

所有可召回条目至少能追溯到：

- `sessionId`；
- `messageId` 或摘要覆盖范围；
- 创建/更新时间；
- 当前来源状态：`active | archived | deleted`。

来源失效后，召回层必须立即停止返回对应内容，即使后台物理清理还在重试。

## 12. 分阶段施工

### Phase 0：基线与隔离（已完成）

- 合并上游 v1.1.9；
- 建立合并前备份分支；
- 完整构建和测试；
- 创建 `feat/cross-session-memory-v1`。

### Phase 1：修复写入正确性（已完成）

主要文件：

- `src/main/memory/memory-scheduler.ts`
- `src/main/memory/memory-scheduler.test.ts`
- `src/main/orchestrator/context-builder.ts`
- `src/main/orchestrator/build-options.ts`
- `src/main/orchestrator/build-options.test.ts`

工作项：

- MemoryScheduler 按 conversationId 隔离；
- conversationId 改为必填；
- MemoryJudge turn 增加来源消息 ID；
- SocialAtom 与 MemoryJudge 不再互斥；
- 增加多会话交错完成的回归测试。

完成门槛：两个会话交错 20 轮，任何 Judge 输入和 evidence 都不得串会话。

### Phase 2：会话摘要存储与生成（已完成）

新增文件建议：

- `src/main/memory/conversation-summary-types.ts`
- `src/main/memory/conversation-summary-store.ts`
- `src/main/memory/conversation-summary-store.test.ts`
- `src/main/memory/conversation-summary-service.ts`
- `src/main/memory/conversation-summary-service.test.ts`
- `src/main/memory/conversation-summary-schemas.ts`

工作项：

- 摘要 schema、解析与业务校验；
- 原子持久化和独立迁移；
- 增量摘要任务；
- pending/failed/synced 状态；
- 防止助手推断被写成用户事实。

完成门槛：同一会话追加消息后只摘要新增区间，失败不会覆盖上一版。

### Phase 3：稳定索引和历史回填（已完成）

主要文件：

- `src/main/rag/vectorstore.ts`
- `src/main/rag/vectorstore.test.ts`
- `src/main/rag/index.ts`
- `src/main/orchestrator/history-tools.ts`
- 新增 `src/main/memory/conversation-memory-backfill.ts`

工作项：

- 增加 `sourceKey` upsert；
- 原始消息使用 sessionId + messageId；
- 摘要写入 `conversation_summary`；
- 添加按 sessionId/sourceKey 删除接口；
- 旧会话后台幂等回填；
- 无 Embedding 时的 pending 和关键词降级。

完成门槛：重复启动和重复回填不会增加重复向量；更新摘要后只保留一个有效版本。

### Phase 4：统一 MemoryContextBuilder（已完成）

主要文件：

- 新增 `src/main/memory/memory-context-builder.ts`
- 新增 `src/main/memory/memory-context-builder.test.ts`
- `src/main/orchestrator/index.ts`
- `src/main/orchestrator/build-options.ts`
- `src/main/orchestrator/prompt-layers.ts`
- `src/main/call/call-prompt-builder.ts`
- `src/main/proactive/proactive-lifecycle.ts`

工作项：

- 聚合 L0/L1/L2/摘要/历史/关系；
- 统一检索、排序、去重和 Token 预算；
- Work 模式复用 CITA contextualized query；
- 接入桌面、外部渠道、通话和主动对话；
- 保留 `recall_history` 作为主动下钻工具。

完成门槛：新会话能够自动召回相关旧会话，同时不重复当前窗口内容。

### Phase 5：删除级联、迁移与可观测性（已完成）

主要文件：

- `src/main/chats/chats-ipc.ts`
- `src/main/chats/chats-store.ts`
- `src/main/memory/memory-store.ts`
- `src/main/memory/memory-audit.ts`
- `src/main/memory/panel.ts`

工作项：

- 会话删除级联；
- evidence 重绑或清理；
- 召回审计信息；
- 摘要/索引状态诊断；
- 后台重试与失败统计。

完成门槛：删除会话后，任何自动召回和 `recall_history` 都不能再返回该会话内容。

## 13. 测试计划

### 单元测试

- 两个 conversationId 的 scheduler 缓冲完全隔离；
- 全局轮数和单会话 Judge 轮数互不混淆；
- 摘要增量范围和 revision 正确；
- 摘要 schema 拒绝缺字段、超长内容和错误类型；
- sourceKey upsert 不产生重复向量；
- 当前消息窗口去重；
- L2/摘要/历史竞争同一预算时排序稳定；
- 超预算时按完整候选丢弃；
- 删除会话级联清理；
- Embedding、Reranker、LLM 不可用时正确降级；
- 秘密字段不进入摘要、记忆和日志。

### 集成测试

1. 会话 A 讨论项目方案并结束；
2. 会话 B 输入“继续上次的跨会话记忆方案”；
3. 断言 Prompt 注入 A 的相关摘要、决策和未完成事项；
4. 断言不注入无关会话；
5. 删除会话 A；
6. 再次查询时不得召回 A；
7. 重启应用后重复验证；
8. 关闭 Embedding 后验证关键词降级。

### 回归验证

- `npm run build`
- 全量 Vitest
- 记忆模块专项测试
- RAG/向量库专项测试
- chats-store/chats-ipc 专项测试
- AG-UI 和 channel 成功/取消/超时路径
- 插件系统与 NovelAI 基础回归，确保记忆改动没有破坏现有功能

## 14. 性能与质量门槛

- 摘要生成不阻塞当前回复；
- 热索引状态下，自动记忆上下文构建目标 P95 不超过 300 ms；
- 单轮记忆注入默认不超过 2400 tokens；
- 每个会话最多一个摘要任务在运行；
- 空闲回填采用小批次，不能在启动时一次加载所有会话；
- 任何失败都不能阻断普通聊天；
- 同一来源不得出现多个有效摘要向量；
- 不允许跨会话错误归因；
- 不允许删除后的来源继续被召回。

## 15. 建议提交拆分

为方便审查和回滚，按以下提交拆分：

1. `fix(memory): isolate scheduler state by conversation`
2. `feat(memory): add persistent conversation summaries`
3. `feat(rag): add stable source-key upsert and summary index`
4. `feat(memory): add cross-session memory context builder`
5. `feat(memory): backfill existing conversations`
6. `fix(memory): cascade conversation deletion into memory artifacts`
7. `test(memory): cover cross-session recall and fallback paths`
8. `docs(memory): document cross-session memory architecture`

每个提交独立通过相关测试，避免把 schema、检索、UI 和迁移全部揉进一个不可审查的大提交。

## 16. 最终合并流程

记忆施工期间只在 `feat/cross-session-memory-v1` 上提交。由于该分支基于包含本地插件与 NovelAI 的
`liyi-Cyrene-v2`，不能直接作为上游 PR head；上游 PR 必须从 `upstream/master` 建立干净分支，
只移植本次记忆系统提交。

完成后：

1. 再次 fetch `upstream/master`，确认施工期间上游是否变化；
2. 从最新 `upstream/master` 建立干净 PR 分支；
3. 只移植跨会话记忆代码、测试和本计划，不携带插件、NovelAI 或其他本地定制；
4. 在干净分支执行完整构建和全量测试；
5. 推送到 fork 并向 `upstream/master` 建立 PR；
6. PR 建立并确认范围后，再单独决定是否将施工分支合并到 `liyi-Cyrene-v2`；
7. 未经后续明确决定，不在本阶段执行 `liyi-Cyrene-v2` 合并；
8. 插件系统仍保持独立，不与记忆 PR 混合。

本次上游 PR 只包含跨会话记忆，不修改已经提交的插件系统 PR，也不上传 NovelAI 绘图插件。

## 17. 完成定义

满足以下全部条件，才算跨会话记忆施工完成：

- 新会话能自动召回相关旧会话摘要；
- 模型可以按需下钻到带时间和来源的原始历史；
- L0/L1/L2、摘要和历史统一经过一个 builder；
- 多会话交错运行不串记忆；
- SocialAtom 开启后 MemoryJudge 仍正常运行；
- 摘要增量更新、重启恢复和旧数据回填均幂等；
- 删除会话后相关内容不再被召回；
- Embedding/Reranker/LLM 不可用时聊天仍可用；
- Token 预算和去重测试通过；
- 完整构建、全量测试和关键人工场景验收通过；
- 已建立只含记忆系统的上游 PR；之后再根据审查结果决定是否合并 `liyi-Cyrene-v2`。
