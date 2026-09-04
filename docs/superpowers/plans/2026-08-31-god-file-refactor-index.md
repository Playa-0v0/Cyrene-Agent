# 五个上帝文件重构施工索引

这份索引把总设计和五份可独立执行的施工计划串起来。当前文档只定义重构边界与施工步骤，不代表生产代码已经完成重构。

## 文档入口

| 阶段 | 模块 | 施工文档 | 核心风险 |
|---|---|---|---|
| 总设计 | 全局 | `docs/superpowers/specs/2026-08-30-god-file-refactor-design.md` | facade（兼容门面）、状态所有权、调用顺序 |
| 1 | Memory Store（记忆存储） | `docs/superpowers/plans/2026-08-31-memory-store-refactor.md` | load/save/通知顺序、迁移、唯一 cache（缓存） |
| 2 | Channel Dispatcher（渠道分发器） | `docs/superpowers/plans/2026-08-31-channel-dispatcher-refactor.md` | 历史顺序、TTS（文本转语音）、贴纸、能力降级 |
| 3 | Build Options（运行选项构建器） | `docs/superpowers/plans/2026-08-31-build-options-refactor.md` | prompt（提示词）分层、能力双路径、图片降级 |
| 4 | Harness Adapter（执行循环适配器） | `docs/superpowers/plans/2026-08-31-harness-adapter-refactor.md` | 恢复、检查点、权限、终态落库与审批 |
| 5 | AG-UI Bridge（交互协议桥） | `docs/superpowers/plans/2026-08-31-agui-bridge-refactor.md` | exactly-once（只结算一次）、取消、接管、事件顺序 |

## 原始依赖顺序

```text
memory-store
→ dispatcher
→ build-options
→ harness-adapter
→ agui-bridge
```

这个顺序从相对独立的持久化和渠道模块开始，逐步进入运行选项、执行循环，最后处理状态和竞态最复杂的 AG-UI。每个阶段独立提交，前一阶段完全验证后再进入下一阶段。

## 当前实际施工顺序

本轮先施工 `harness-adapter`，再根据验证结果决定是否回到前置模块：

```text
harness-adapter
→ build-options
→ dispatcher
→ memory-store
→ agui-bridge
```

这不会改变模块边界；只改变实施起点。`harness-adapter` 计划中的第一任务仍然是先锁定 `runStore.create → runHarness → markTerminal → finalizeReview → completePlan` 调用轨迹，再开始提取代码。

## 每阶段固定节奏

1. 在旧实现仍完整存在时补 characterization test（特征测试），先锁返回值、错误和调用轨迹。
2. 提取纯函数或类型，原门面通过显式重导出保持 import（导入）路径。
3. 提取无状态副作用步骤，不改变 `try/catch` 和 `await`（等待异步完成）边界。
4. 最后迁移唯一状态所有者；禁止复制 `Map`、cache、`AbortController` 或单例。
5. 收瘦门面，只保留兼容导出、状态所有权和关键顺序编排。
6. 运行模块测试、直接相关测试、主进程构建和全量测试。
7. 单独提交本阶段；不要混入下一阶段或顺手修复业务逻辑。

## 五条关键调用轨迹

```text
Memory:
load → transform → save → notifyObsidian

Dispatcher:
readHistory → writeUser → runAgent → writeAssistant

Build Options:
derive input → collect contexts → resolve style/capabilities → assemble prompt → build options

Harness:
runStore.create → runHarness → markTerminal → finalizeReview → completePlan

AG-UI success:
successEffect → sticker → RUN_FINISHED
```

测试应断言这些语义步骤，不要绑定新模块内部的临时函数名。

## 跨阶段硬约束

- 原五个文件路径和公开 API（应用程序编程接口）保持可用。
- 不引入新的运行时或开发依赖。
- 不改变 IPC（进程间通信）channel、事件名、错误码、数据结构和用户可见文本。
- 不改变同步/异步边界、fire-and-forget（发出后不等待）行为或异常容错范围。
- 新叶子模块不得通过原门面反向导入，避免循环依赖。
- 行数是结构告警，不是唯一目标：职责边界与行为兼容优先。
- 发现现有真实缺陷时，先单独记录并补失败测试；不要混进纯重构提交。

## 每阶段验收命令

各施工文档包含更精确的针对性命令。阶段结束至少执行：

```powershell
npm run build:main
npm test
git diff --check
```

再执行结构检查：

```powershell
rg -n "TODO|TBD|implement later|待实现" src/main/agui src/main/channels/dispatcher src/main/orchestrator/run-options src/main/orchestrator/harness/adapter
```

预期：没有本次拆分留下的占位实现。

## 提交边界

建议每阶段使用三类小提交：

1. `test: characterize <module> behavior`
2. `refactor: extract <focused responsibility>`，可按叶子模块拆成多个提交
3. `refactor: slim <module> facade`

每个提交都应能构建，阶段最后一个提交必须通过全量测试。不要把五个阶段压成一个不可独立回滚的大提交。

## 最终完成定义

- 五个原文件成为短编排器或兼容门面，不再承载多个独立领域实现。
- 每份运行时状态有且只有一个所有者。
- prompt、历史、持久化、终态和副作用顺序均有特征测试。
- 新模块职责与目录边界一致，没有通过原门面形成循环依赖。
- 所有针对性测试、`npm run build:main` 和 `npm test` 通过。
