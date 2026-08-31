# CyreneHarness 当前状态(已实测)

> **状态**:P0 代码主干已实装;工具执行主路径接通;已做过一次 e2e 实测,暴露真实问题
> **性质**:这次测试揭露的边界比预期更深,**不写代码先存档**
> **日期**:2026-08-09

---

## 一、架构层确认(代码事实)

### 1.1 已经实装

- `CyreneHarness` 主循环 + 工具 dispatch + obligation 数组 + uncertainEffects 拦截 + 双时钟(13 个文件 ~2050 行,见 `docs/design/2026-08-09-cyrene-harness-construction-status.md`)
- Work / Daily / Learn 模式统一走 Harness(legacy LangGraph + TwoPhaseFC + Action Gate + Native FC + SOUL 独立阶段 + Task Router **全部删除**)
- LangChain 6 依赖从 `package.json` 移除
- `harness-adapter.ts` 把 `CyreneRunOptions` 翻译成 `HarnessInput`,运行 Harness,把 `HarnessEvent` 翻译回 AG-UI 事件
- TypeScript 编译零错误

### 1.2 已修的接缝

| # | 修复 | 文件 |
|---|---|---|
| A | `ask_user` 工具:`question.id` ↔ `AskClarificationCard.field` 翻译,接受完整 schema | `harness/builtin-tools.ts:298-336` |
| B | 删 legacy `ask_user_choice` 注册 + `sub-agent.ts` 白名单改成 `ask_user` | `built-in-tools.ts:1490-1555`, `sub-agent.ts:31` |
| C | `cyrene_harness.md` 注入 system prompt(Harness Persona 层,不动 voice / runtime policy) | `harness-adapter.ts:128-133` |
| D | 删 `cyrene-agent.ts:225` 死 case `task_plan_update`(发送方已不存在) | `cyrene-agent.ts` |
| E | ExecutionLedger 5 步全部连上 | `types.ts` `cyrene-harness.ts` `tool-dispatcher.ts` `harness-adapter.ts` `cyrene-agent.ts` |

---

## 二、已经连上但**实际无效**的链路

### 2.1 ExecutionLedger scope key 是 bug

**当前代码**(`cyrene-agent.ts:421`):

```ts
executionLedgers.forScope(`${options.conversationId ?? "default"}:messages-${options.messages.length}`)
```

**Bug**:每轮 LLM 调用后 `messages.length` 都增长,scope key 每轮变一次 → 整个 ledger namespace 每轮重建,缓存从不命中。

**实际 e2e 表现**:同一 `read_file` 调了 4 次都走了 `checkPermission → executeTool`,**没有 `[cached]` 标记**(因为根本没接上,scope 不断重置)。

**待修**(已与 GPT 达成共识,标注**已确认待做**):scope key 改成 `${conversationId}:${runId}`,`runId` 稳定到一次 `CyreneHarness.run()` 结束。

### 2.2 Ledger 不该粗暴缓存 `read_file`

**GPT 反驳了 ZCode 的"read_file ×4 是 Ledger 失效证据"**:

> `read_file` 后接 `write_file` 再 `read_file`,第二次必须重读(文件状态变了)。粗暴 dedupe 会拿到 stale observation。

**确定方向**:ledger 默认只保护:
- `non_idempotent_side_effect`(send_email / delete / publish / 支付)
- `idempotent_mutation`(重试安全)
- **不保护** `read_only`,由模型自觉避免无意义重复

**已确认待做**:`tool-dispatcher.ts` 里加 `if (resolveSideEffect(tool, args) !== 'read_only')` 决定是否进 ledger。

---

## 三、这次实测试出来的真问题(核心)

### 3.1 Completion Guard 给 `write_file` 挂错完成义务

**现象**:任务"新建 `test-harness.txt`",模型:
```
write_file → ...
→ Runtime: 还差 verification → Models 自觉 read / test / typecheck / verify / verify / read
最后她自己抱怨"系统标准让我停不下来"
```

**根因**:`fs-tools.ts` 的 `write_file` **没有显式声明 `completionSemantics`**,fallback 落到了 `require_post_verification`(推测),导致 Runtime 不让结束,模型自己死磕。

### 3.2 GPT 给的两条更彻底的修法(已确认方向)

**修法 A:Tool 自检完成(Runtime 内 stat)**

```ts
async executeWriteFile(path, content) {
  await writeFile(path, content)
  const stat = await fs.stat(path)
  return {
    outcome: "success",
    path,
    bytesWritten,
    exists: stat.isFile(),
    size: stat.size
  }
}
```

Tool 输出 `success` + evidence,Ruby 自检完成,**模型根本不用再跑一轮 read_file 验证**。

**修法 B:Runtime artifact 判定按 content 长度自适应**

```ts
if (content.length === 0) {
  artifactCheck = "file_exists"        // 允许 0 字节
} else {
  artifactCheck = "file_exists_nonempty"
}
```

不能写死 `file_exists_nonempty` —— 用户本来就要 0 字节空文件就完蛋。

### 3.3 已确认待做的修复路径

1. **修 ExecutionLedger scope key**(5 分钟,一个字符串模板)
2. **Ledger 只对 non-read_only 工具生效**(`tool-dispatcher.ts` 加 1 行判断)
3. **`write_file` ToolDefinition 加 `completionSemantics: require_artifact_persistence`**,artifactCheck 根据 content 长度自适应
4. **`write_file` execute 函数内部自检**(stat + 路径验证)
5. **不强制 Todo**(prompts/cyrene_harness.md 不加 "3+ 步必须 Todo")
6. **不动 Permission**(`fs-read` per-action 先不改,等 Loop 行为稳了再调 UX)

---

## 四、GPT 反驳 ZCode 的地方 + 我的承认

| # | ZCode 原判断 | GPT 反驳 | ZCode 现在态度 |
|---|---|---|---|
| 1 | ExecutionLedger 该缓存 read_file 的重复调用 | read_file 后接 write_file 时缓存会 stale,read_file 不该粗暴缓存 | ✅ 接受 |
| 2 | write_file 需要 verification | 写完自己 stat,无需 verification | ✅ 完全接受 |
| 3 | artifact existence 检查用 file_exists_nonempty | 空文件需求要支持 | ✅ 接受 |
| 4 | 模型没调 update_todo 是 bug | 简单任务不用 Todo,符合设计 | ✅ 撤回原判断 |
| 5 | permission per-action 问题先改 UX | 先修 Loop 行为,UX 先不动 | ✅ 接受 |
| 6 | scope key 用 `conversationId + TTL` | TTL 不是语义边界,要用 `${conversationId}:${runId}` | ✅ 完全接受 |

---

## 五、我仍坚持 / 仍打算做的事

### ExecutionLedger 接入这件事不改方向

**理由**:P0 设计明确说"接入并复用"。哪怕 `read_file` 不粗暴缓存,ledger 仍要服务 `send_email` / `delete` / idempotent mutation 这些真正需要保护的工具。

所以 "E. ExecutionLedger 接入 Harness (5 步全部连上)"这条**留作已完成**。但**内部行为**(scope key + 哪些工具进 ledger)需要在下次动手时按上面 3.3 修。

### 仍然待做(P0 范围内,但本次没做)

- ✅ vs ❌ 的对照见第三节"已确认待做"
- 这些**都在 P0 范围内**,但你现在说"额度快光先存现状",**今天不动手**
- 下次回来先做 ① + ② + ③ + ④,跑同一个"新建 test-harness.txt"测试
- 期望:**2 次 LLM**(`write → final`),不再纠缠

---

## 六、仍然待做(P0 之外)

### P1 范围(设计稿已明确推后)

- Session persistence / Checkpoint / Resume
- Todo State 持久化
- Context compaction 精细化(按用户回合而非消息条数)
- 分工具策略化截断
- ExecutionLedger 持久化(idempotency key / crash recovery)
- `ToolDefinition` 正式扩展 `sideEffect` / `completionSemantics` 字段
- `fullOutputRef` backing store
- 真正的 durable suspend / resume(ask_user 当前是 pending Promise)
- `keepRecent` 按用户回合计

### P2 范围

- memory.json / fs-tools / document-tools 原子写入改造
- Goal mode
- SubAgent 并行

### 仍待清理的 dead code / 设计清尾

- `task-plan.ts` 796 行 —— `subagents/{document,graph,search,types}.ts` 4 个文件**真依赖** `PlanStep` / `StepVerificationResult` / `verifyStep` / `generatePlanId` / `generateStepId`
- 全删需要连带清理 `delegate_document` / `delegate_search` 工具注册(在 `built-in-tools.ts:1488` 和 `:1564`)
- 这些是 P1 清理范围,不是 P0 bug

---

## 七、当前项目状态一句话

**P0 主干跑通,核心 Loop 自由性验证通过,工具执行主路径正常。** **暴露的问题是 Harness policy 配置错了**(写文件后不给 artifact 自检,逼模型跑 verification),加上 ExecutionLedger scope bug 让缓存永远不命中。**不是 Loop 设计问题,是 Loop 周边 policy 细节需要收紧。**

---

## 八、下次回来时按这个清单动手

按优先级:

1. `cyrene-agent.ts:421` scope key 改为 `${conversationId}:${runId}`,用现有 `runId`
2. `tool-dispatcher.ts` 加 `read_only` 不进 ledger 的判断(L98 附近)
3. `fs-tools.ts:write_file` ToolDefinition 加 `completionSemantics` 字段,artifactCheck 按 content.length 选 `file_exists` / `file_exists_nonempty`
4. `fs-tools.ts:write_file` execute 函数内部 `fs.stat()` 自检
5. `prompts/cyrene_harness.md` 内容由你写,**不加 Todo 强制指引**

跑同一测试,期望日志:

```text
User: 创建 test-harness.txt
Harness: permission → write → stat self-check → success
MODEL: final
END
```

2 次 LLM 就完事。
