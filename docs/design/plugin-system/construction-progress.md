# Cyrene 插件系统扩展施工进度

> **更新时间**：2026-09-03
> **当前状态**：阶段 1（公开契约 + Schema + 资源跟踪器）、阶段 2（Secrets/Workspace/Conversations）、阶段 3（插件调度任务所有权）、阶段 4 全部四个大步（事件总线旁路与生命周期屏障、生命周期发布器与渠道/调度轮次、桌面轮次、工具完成事件）已完成；下一步从阶段 5（语音输入接管）开始，见第 5 节。
> **架构设计**：[architecture.md](./architecture.md)
> **施工方案**：[implementation-plan.md](./implementation-plan.md)

本文档是插件系统扩展施工期间的交接入口。每完成一个可独立验证的小步骤，都应同步更新完成项、未完成项、验证结果和当前工作区状态，避免切换智能体后重复施工或遗漏约束。

## 1. 施工约束

- 一次只处理一个边界清楚、可以独立验证的小步骤；当前步骤验证通过后再进入下一步。
- 新增注释使用中文，只解释不容易从代码本身看出的设计意图、边界或失败处理原因。
- 注释中不写“第一阶段”“设计稿 v1”“按照文档实现”等施工过程标记。
- 不为简单代码堆砌注释，也不要求每处修改都有注释。
- 优先复用现有宿主能力和成熟依赖，不重复实现通用基础设施。
- 不使用 Superpowers 插件提供的技能。
- 提交标题使用英文半角冒号和中文说明，例如 `fix: 修复插件动态导入`。
- 未经用户明确要求，不提交或推送当前改动。

## 2. 已完成项

### 2.1 设计与施工方案

- 已确定插件系统只开放案例 1–8 所需能力。
- 已明确不开放权限决策、Agent Loop（智能体循环）替换、核心热补丁和通过插件覆盖运行时人格。
- 已完成架构设计和施工方案，并吸收两轮外部审阅意见。
- 已补充本地 ASR（自动语音识别）插件边界：插件自行维护模型、运行时、麦克风采集和窗口，Cyrene 只提供受控的最终文本提交入口。
- 已明确同进程插件接口是稳定 API（应用程序编程接口）边界，不是针对恶意代码的安全边界。
- 已明确调度任务授权、会话消息冻结边界、生命周期事件和语音输入租约的核心语义。

### 2.2 插件入口加载基线

- 原有 CJS（CommonJS 模块格式）入口加载测试保持通过。
- 已新增 ESM（ECMAScript 模块格式）默认导出入口测试。
- 已新增 ESM 命名导出入口测试。
- 测试发现原先通过 `new Function()` 发起动态导入的方式无法在测试运行器的模块沙箱中执行。
- 已把原生动态导入移动到独立的 `native-import.cjs`，既避免 TypeScript（类型脚本编译器）把 `import()` 改写成 `require()`，也能让测试通过 Node.js（JavaScript 运行时）的模块加载器执行真实动态导入。
- 主进程构建会把 `native-import.cjs` 复制到最终插件运行目录。

涉及文件：

- `src/plugins/loader.test.ts`
- `src/plugins/loader.ts`
- `src/plugins/native-import.cjs`
- `package.json`

### 2.3 现有行为基线核对

已逐项核对并确认以下行为均有测试覆盖，未改动任何生产逻辑：

- 未声明依赖不注入（channels、llm）：`context.test.ts`。
- 未知依赖拒绝、entry 路径穿越、apiVersion、SemVer、icon 边界：`loader.test.ts`。
- 注册失败回滚（先 unregister 再 dispose、资源不泄漏）：`manager.test.ts`。
- 停用清理（工具、IPC、提示词 Provider、onDispose、超时、并发 dispose）：`context.test.ts` 与 `manager.test.ts`。
- 用户插件首次发现默认停用（忽略作者 `defaultEnabled`）：`manager.test.ts`。
- `host:turn:completed` 兼容行为（仅成功终态发布、不等待插件监听器、真实 PluginManager 链路到达、宿主收尾失败不发布、发布失败不影响收尾）：`agent-runtime.test.ts`。

核对后发现三个真实缺口，已补最小测试固化：

- `loader.test.ts`：`deps` 数组重复项去重后仍合法。
- `context.test.ts`：manifest 声明 `llm` 但宿主未提供该服务时不注入（当前降级行为；后续阶段引入服务工厂后将改为注册前失败，届时此测试需同步调整）。
- `agent-runtime.test.ts`：渠道来源的成功轮次事件携带 `channel` 字段。

### 2.4 公开契约第一小步：能力枚举与统一错误码

- `src/plugins/api.ts` 的 `PluginCapability` 扩展为七项：新增 `secrets`、`workspace`、`conversations`、`scheduler`、`speech-input`，均为兼容性新增，`apiVersion` 保持 1。
- `api.ts` 新增 `PluginHostErrorCode` 联合类型（九个稳定错误码）、`PluginHostError` 接口和 `isPluginHostError()` 判断辅助；判断函数校验 `code` 必须是已知错误码集合内的值，不接受任意 `E_` 前缀字符串。
- 新增 `src/plugins/api.test.ts`：覆盖合法错误码识别和普通 Error、非 Error 值、未知错误码的拒绝。
- loader 的依赖白名单保持 `channels`/`llm` 不变：manifest 提前声明新依赖仍会被拒绝加载，待 Manifest Schema 接入时再同步放开。

涉及文件：

- `src/plugins/api.ts`
- `src/plugins/api.test.ts`

### 2.5 公开契约第二小步：轮次事件联合类型

- `api.ts` 新增统一终态 `PluginTurnStatus`（success / cancelled / timeout / runtime_error）和事件公共元数据 `PluginHostEventBase`（eventId + timestamp）。
- 新增按 `source` 区分的可辨识联合类型 `PluginTurnStartedEvent` 与 `PluginTurnFinishedEvent`，各有 desktop / channel / scheduler 三个分支；桌面分支含 `inputMessageId`（必填）和 `finalMessageId`（仅宿主确认落盘后存在），调度分支含 `taskId` 与 `schedulerRunId`。
- 现有 `PluginTurnCompletedEvent` 保持不变，继续作为 v1 兼容事件的 payload 类型。
- `api.test.ts` 增加编译期收窄验证：分支内访问各来源必填字段，字段写错或缺失时测试文件无法通过类型检查。
- 本步骤只动纯类型，未改动事件总线、AgentRuntime 或事件发布代码。

涉及文件：

- `src/plugins/api.ts`
- `src/plugins/api.test.ts`

### 2.6 公开契约第三小步：会话只读服务类型

- `api.ts` 新增 `PluginConversationsService`（`list()` / `getMessages()`）、`PluginMessagePageInput` / `PluginMessagePage`（包含式冻结边界 `fromMessageId` / `throughMessageId` 与返回的 `range`）、`PluginConversationListInput` / `PluginConversationPage`，以及稳定投影 `PluginConversationSummary` / `PluginConversationMessage`（只含 user/assistant 角色和纯文本）。
- `PluginDeps` 新增可选 `conversations` 字段；现有宿主不注入，行为不变。
- `api.test.ts` 增加编译期验证：桌面轮次结束事件的 `inputMessageId` / `finalMessageId` 能无损传给 `getMessages()` 作为冻结边界（长期记忆插件的标准调用路径）；会话投影字段集合断言。
- 本步骤只动纯类型，未实现 conversations 适配器，未触碰 chatsStore。

涉及文件：

- `src/plugins/api.ts`
- `src/plugins/api.test.ts`

### 2.7 公开契约第四小步：Secrets 与 Workspace 服务类型

- `api.ts` 新增 `PluginSecretsService`（get / set / delete，字符串值，插件命名空间内解析 key）和 `PluginWorkspaceService` / `PluginWorkspaceBinding`（只读工作区绑定投影，`getBinding()` 返回 null 表示未绑定）。
- `PluginDeps` 新增可选 `secrets` / `workspace` 字段；现有宿主不注入，行为不变。
- 本步骤只动纯类型，未实现适配器，未触碰 safeStorage 和 chats workspace binding。

涉及文件：

- `src/plugins/api.ts`

### 2.8 公开契约第五小步：Scheduler 服务类型

- `api.ts` 新增 `PluginScheduleConfig`（once / daily / weekly / interval 四种计划）、`PluginScheduledExecutionSpec`（计划 + 提示词 + 会话模式 + 显式工具白名单，授权指纹的计算输入）、`PluginScheduledTaskInput` / `PluginScheduledTaskPatch` / `PluginScheduledTask`（`enabled` 为宿主计算的只读有效状态）、`PluginSchedulerService`（create / list / update / delete / getHistory）和 `PluginScheduledTaskHistory`（诊断摘要，不含完整模型输出）。
- 接口刻意不含 toggle、fireNow 和 all-enabled 输入；注释说明执行规格变化会撤销用户授权。
- `PluginDeps` 新增可选 `scheduler` 字段；现有宿主不注入，行为不变。
- 本步骤只动纯类型，未实现 scheduler 适配器，未触碰调度存储。

涉及文件：

- `src/plugins/api.ts`

### 2.9 公开契约第六小步：Speech Input 租约类型

- `api.ts` 新增 `PluginSpeechInputTarget`（active-chat / active-call）、`PluginSpeechInputAcquireOptions`、`PluginSpeechInputLease`（commit / release / signal，注释说明目标冻结与幂等语义）和 `PluginSpeechInputService.acquire()`。
- `PluginDeps` 新增可选 `speechInput` 字段。至此公开契约类型全部冻结。

涉及文件：

- `src/plugins/api.ts`

### 2.10 大步：Manifest Schema、统一资源跟踪器与服务工厂（阶段 1 收尾）

本步完成施工方案阶段 1 的剩余全部改动，是一次可独立提交的大步。

Manifest Schema 与校验：

- `api.ts` 新增 `PluginManifestInput` 作为 Schema 生成目标（defaultEnabled 可选；格式约束仍归加载器）。
- 新增 `scripts/plugin-sdk/generate-schema.mjs`：用 ts-json-schema-generator 从 `PluginManifestInput` 生成 `src/plugins/manifest.schema.json`（已提交进仓库）；`--check` 模式用于防漂移校验。npm 脚本：`generate:plugin-schema`、`check:plugin-schema`。
- 新增 `src/plugins/manifest-validation.ts`：AJV（已声明为直接依赖 8.20.0）加载生成的 Schema，做结构、类型、枚举（deps 七项能力白名单）和必填字段校验；`additionalProperties: false` 承担顶层字段白名单。
- `loader.ts` 删除手写 `DEPS_ALLOWED` 白名单：纯数据校验交给 Schema，加载器保留格式（id 连字符、SemVer、entry 裸文件名与扩展名）和文件系统（存在性、符号链接越界、icon）校验，两层同时保留。deps 去重归一化不变。未知顶层字段从"忽略"变为"拒绝"（Schema 字段白名单语义）。

统一资源跟踪器：

- 新增 `src/plugins/resources.ts`：`PluginResourceTracker` 提供 track / release / forget / has / dispose；dispose 按注册逆序执行、每个清理函数最多一次、单项超时或失败只上报不阻断、停止后拒绝登记。
- 单项清理超时逻辑抽出为 `src/plugins/cleanup.ts`（`runPluginCleanup`），context.ts 原位再导出，manager.ts 无需改动。
- `context.ts` 全面迁移：工具、IPC、渠道、事件订阅、提示词 Provider 和 onDispose 回调全部登记到跟踪器；dispose 变为"abort signal → tracker.dispose()"两步；并发 dispose 共享同一任务；停止后所有登记入口统一拒绝（原先工具/IPC/渠道不检查，现按不变量收紧）。
- 手动注销（unregisterTool 等）保留同步语义：先校验归属，执行注销后 `forget` 移除登记，不重复执行清理。

服务工厂：

- `context.ts` 新增 `PluginHostServiceFactory`（createForPlugin({ pluginId, signal, trackResource })）；`PluginRuntime` 新增 `hostServices` 可选字段。
- 注入语义变化：manifest 声明但宿主未提供的能力现在是硬依赖缺失，`createContext()` 直接抛错走激活回滚（原先静默不注入）。context.test.ts 对应基线测试已同步改为断言抛错。
- `llm` 的 purpose 前缀包装收敛到 context 一处（工厂提供基础服务，框架统一加 `pluginId:` 前缀），避免双重包装。
- `plugin-runtime.ts` 迁移到 hostServices 工厂（channels + llm），`runtime.llm` 保留为无工厂时的兼容入口。后续新宿主服务只允许扩展工厂，不再向 PluginContext 增加特例。

构建与依赖：

- `build:main` 的拷贝过滤器新增 `manifest.schema.json`。
- `ajv` 声明为直接依赖（8.20.0），`ts-json-schema-generator` 为开发依赖（1.5.1，仅构建期使用）。

涉及文件：

- `src/plugins/api.ts`、`src/plugins/context.ts`、`src/plugins/loader.ts`
- 新增：`src/plugins/resources.ts`、`src/plugins/cleanup.ts`、`src/plugins/manifest-validation.ts`、`src/plugins/manifest.schema.json`
- 新增测试：`src/plugins/resources.test.ts`（8 项）、`src/plugins/manifest-validation.test.ts`（8 项，含 Schema/Loader 一致性矩阵）
- 修改：`src/plugins/context.test.ts`（llm 缺失语义改抛错 + 工厂注入测试）、`src/plugins/loader.test.ts`（新能力 deps、未知字段）
- `src/main/plugin-runtime.ts`、`package.json`、`package-lock.json`、`scripts/plugin-sdk/generate-schema.mjs`

### 2.11 大步：Secrets、Workspace 与 Conversations 宿主数据服务（阶段 2）

本步完成施工方案阶段 2 的全部改动，长期记忆插件所需的数据读取路径已完整。

统一错误入口：

- 新增 `src/main/plugin-host/errors.ts`：`pluginHostError(code, message, options)` 是所有适配器创建公开错误的唯一入口；内部 cause 只进宿主日志（带 `plugin:<id>:*` 前缀），不挂到错误对象上。

Secrets 密钥服务：

- 新增 `src/main/plugin-host/secrets-service.ts`：`createPluginSecretsService({ pluginId, secretsRoot, storage, signal })`。
- 每个 key 一个独立加密文件，文件名取 `sha256(key)` 十六进制（`.enc`），key 原文不进文件系统：大小写不同的 key 天然独立，也避开 CON/PRN 等 Windows 保留名。
- key 复用普通插件存储的正则约束（`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`）；值只接受字符串。
- 写入采用临时文件加原子替换；`safeStorage.isEncryptionAvailable()` 为假时 get/set 均返回 `E_STORAGE_UNAVAILABLE` 且不落任何弱保护文件；`delete()` 幂等（不存在返回 false）。
- `SafeStorageLike` 最小接口由宿主装配注入真实现，测试注入假件，服务本身不依赖 Electron 运行时。
- 插件停用、替换和普通卸载不自动删除密钥（密钥目录是普通插件数据目录的子目录，随插件数据保留）。

Workspace 工作区服务：

- 新增 `src/main/plugin-host/workspace-service.ts`：只读投影 `{ conversationId, root, displayName }`；会话不存在和未绑定工作区都返回 null；不提供绑定/解绑写接口；投影不含 boundAt 等内部字段。

Conversations 只读会话服务：

- 新增 `src/main/plugin-host/conversations-service.ts`：
  - `list()` 默认 20 条、最多 100 条，游标为版本化 Base64URL JSON（`v:1, kind:"list", offset`）；列表分页不承诺跨并发编辑的快照。
  - `getMessages()` 默认 50 条、最多 100 条；包含式边界 `fromMessageId`/`throughMessageId` 首次调用即冻结进游标，后续页重新验证边界消息仍存在，被删除或替换返回 `E_NOT_FOUND`，不悄悄扩到最新消息。
  - 游标携带 conversationId，换会话提交游标返回 `E_INVALID_ARGUMENT`；显式边界与冻结边界同时提交时必须完全一致。
  - 角色映射：内部 `model` 映射为 `assistant`，只投影 user/assistant 两种角色；时间戳统一 ISO 8601；消息投影是白名单字段（id/role/text/at），内部字段（reasoning、工具执行、附件、缓存等）不会透出。
  - 两个服务（list 与 messages 的游标）kind 互斥，混用返回 `E_INVALID_ARGUMENT`。
- 所有服务方法在插件 signal 中止后统一返回 `E_PLUGIN_STOPPING`。

装配工厂与接入：

- 新增 `src/main/plugin-host/host-services.ts`：`createHostServiceFactory({ pluginDataRoot, channelManager, llm, storage, chatsReader })` 统一装配 channels、llm、secrets、workspace、conversations；密钥目录固定为 `plugin-data/<pluginId>/secrets/`。
- `src/main/plugin-runtime.ts` 改用 `createHostServiceFactory`（注入 `safeStorage` 与 `chats-store` 模块作为只读视图），不再手写内联工厂。
- 会话存储依赖通过 `PluginChatsStoreReader` / `PluginWorkspaceStoreReader` 最小接口注入，适配层不持有渲染层对象，内部 Store 对象不穿透给插件。

涉及文件：

- 新增：`src/main/plugin-host/errors.ts`、`secrets-service.ts`、`workspace-service.ts`、`conversations-service.ts`、`host-services.ts`
- 新增测试：`secrets-service.test.ts`（11 项）、`workspace-service.test.ts`（4 项）、`conversations-service.test.ts`（14 项）、`host-services.test.ts`（2 项）
- 修改：`src/main/plugin-runtime.ts`、`docs/design/plugin-system/construction-progress.md`

### 2.12 大步：调度数据模型 + 授权指纹 + scheduler-service（阶段 3 大步 1）

本步只做纯主进程逻辑，未接入 plugin-runtime 工厂（插件服务接线与启动顺序调整在大步 2，避免插件在 store `load()` 之前写任务覆盖磁盘数据）。

数据模型扩展（`src/main/scheduler/types.ts`）：

- `ScheduledTask` 增加可选字段 `ownerPluginId`、`pluginUserEnabled`、`mode`（`PluginPromptMode`）、`approvalFingerprint`；`NewScheduledTaskInput` 同步扩展；`ScheduledTaskPatch` 增加 `pluginUserEnabled`/`approvalFingerprint`/`mode`（不含 `ownerPluginId`，所有权不可转移）。

Store 不变量（`src/main/scheduler/scheduler-store.ts`）：

- `validateSchedule` 改为导出，供插件调度服务在调用 store 前做同样的结构校验。
- `addTask`：插件任务无视 `enabled: true` / `toolMode: "all-enabled"` 输入，永远以 `enabled: false` + `toolMode: "allow-list"` 落盘。
- `updateTask`：插件任务的 `enabled` 与 `toolMode` 是宿主不变量，任何 patch 都改不掉；`pluginUserEnabled: false → true` 视为启用，与用户任务启用一样重排过期的 `nextFireAt`；`mode` 输入校验（chat/work/learn/code）。
- `normalizeLoadedTask`：旧版宿主可能把插件任务当普通任务启用过（磁盘 `enabled: true`），加载时归一化回 `false`；`pluginUserEnabled`/`approvalFingerprint`/`mode` 保留，`toolMode` 归一化为 `allow-list`；用户任务完全不受影响。

执行规格指纹（新增 `src/main/scheduler/execution-spec.ts`）：

- `canonicalExecutionSpec`：固定键序重建规格对象、计划按 kind 固定字段顺序、工具 ID 排序去重；标题不属于执行规格。
- `computeExecutionSpecFingerprint`：规范化规格的 SHA-256 十六进制指纹。
- `taskExecutionSpec`：任务当前生效的执行规格；旧任务缺 `mode` 归一化为 `work`。
- `isPluginTaskEffectivelyEnabled`：插件任务有效启用 = `pluginUserEnabled === true` 且当前规格指纹与授权指纹一致；规格被插件改过立即失去授权。该函数是大步 2 引擎统一 `isTaskEnabled()` 的基础。

插件调度服务（新增 `src/main/plugin-host/scheduler-service.ts`）：

- `createPluginSchedulerService({ pluginId, store, signal, now })`；store 通过最小接口 `PluginSchedulerStore` 注入（真实实现是 scheduler-store，测试直接用真 store 跑全链路）。
- `createTask`：宿主内部字段（enabled/toolMode/pluginUserEnabled/approvalFingerprint）全部由服务固定写入，不来自插件输入；新提交的 once 计划必须晚于当前时间。
- `updateTask`：先合并出更新后规格并与当前规格比指纹；规格实际变化 → `pluginUserEnabled: false` + `approvalFingerprint: ""`（撤销授权），只改标题不撤销；patch 只挑插件可写字段（title/schedule/prompt/mode/allowedToolIds），运行时混入的内部字段直接丢弃；更新保留的旧 once 计划已过期不阻止元数据修改。
- `deleteTask`/`getHistory`/`updateTask`：非自己的任务一律 `E_NOT_OWNER`（不区分其他插件的和用户的，避免探测）；不存在返回 `E_NOT_FOUND`。
- `listTasks` 只返回 `ownerPluginId` 匹配的任务；历史投影只含 id/taskId/status/startedAt(firedAt)/finishedAt/summary(outputPreview)。
- 插件 signal 中止后所有方法返回 `E_PLUGIN_STOPPING`。

涉及文件：

- 修改：`src/main/scheduler/types.ts`、`src/main/scheduler/scheduler-store.ts`、`src/main/scheduler/scheduler-store.test.ts`
- 新增：`src/main/scheduler/execution-spec.ts`、`src/main/scheduler/execution-spec.test.ts`、`src/main/plugin-host/scheduler-service.ts`、`src/main/plugin-host/scheduler-service.test.ts`
- 安全前提：插件任务落盘永远 `enabled: false`，现有引擎天然跳过，本步可独立合入不会误执行。

### 2.13 大步：引擎运行条件 + 插件启停联动（阶段 3 大步 2）

本步把大步 1 的数据模型与授权判定接入真实引擎运行路径，并完成插件生命周期与调度引擎的联动。

统一启用判断（`src/main/scheduler/execution-spec.ts`）：

- 新增 `isTaskEnabled(task)`：用户任务看磁盘 `enabled`；插件任务看 `isPluginTaskEffectivelyEnabled`（用户已授权且指纹一致）。引擎内所有"是否可运行/是否排计时器/是否归一化"判断统一改走本函数，不再直接读 `task.enabled`。
- 停关任务的 disable patch 区分两类：用户任务清 `enabled`，插件任务清 `pluginUserEnabled`（授权）。

引擎运行条件（`src/main/scheduler/scheduler-engine.ts` 与 `bootstrap.ts`）：

- `SchedulerEngineDeps` 新增可选 `canRunTask(task)`：宿主注入"插件是否正在运行"，缺省视为无条件可运行。
- `fireNow()` 手动触发先过 `isTaskEnabled` 再过 `canRunTask`；插件停用时返回 `{ ok: false, reason: "plugin not running" }`。
- 定时触发遇到 `canRunTask` 为假：写入 skipped 历史（reason `plugin not running`）并照常推进 `nextFireAt`——既不补跑，也避免逾期任务让计时器进入零延迟循环；once 任务按停用收尾。
- 新增 `refreshPluginTasks()`：插件启停后重新归一化逾期任务并重排计时器，只推进不补跑。

执行模式传递（`src/main/scheduler/scheduler-runner.ts`）：

- `applyScheduledExecutionPolicy(options, mode)` 接收任务冻结的 `mode`（旧任务默认 work）：`executionMode` 按 chat/其余 映射，`conversationMode` 直接透传。

插件运行状态（`src/plugins/manager.ts`）：

- 新增只读 `isRunning(pluginId)`（实例表存在即运行中）。
- 新增 `onRunningStateChange(listener)` 订阅接口：插件激活完成通知 `running: true`，停用完成通知 `running: false`；单个监听器抛错只告警不中断。

启动顺序与装配（`src/main/application/core-bootstrap.ts`、`default-dependencies.ts`、`src/main/plugin-runtime.ts`、`src/main/plugin-host/host-services.ts`）：

- `scheduler.initialize()`（store load + IPC 注册）严格先于 `startPlugins`：插件调度服务写入的是已加载的 store，不会覆盖磁盘任务。
- `startPlugins` 接收 scheduler 子系统：注入 `scheduler.store` 给 host-services 工厂，注入 `onPluginRunningStateChange` 联动 `engine.refreshPluginTasks()`。
- `createScheduler` 注入 `canRunTask`：插件任务只有所属插件运行中才允许触发，用户任务不受影响。
- host-services 工厂新增必填 `schedulerStore`，`createForPlugin` 装配 `scheduler` 服务（即大步 1 的 `createPluginSchedulerService`）。

渲染层投影（`src/main/scheduler/scheduler-ipc.ts`）：

- 新增 `RendererScheduledTask` 类型（Omit 掉 `approvalFingerprint`/`pluginUserEnabled` 宿主内部字段）与 `projectTaskForRenderer()`：插件任务的界面启停状态映射为 `isPluginTaskEffectivelyEnabled` 结果，与引擎实际运行判断同一口径。
- `SCHEDULER_LIST` 返回投影后的任务。渲染层类型 `src/renderer/settings/scheduler/types.ts` 补充 `ownerPluginId` 可选字段。

定时任务模式化提示词（`src/main/orchestrator/agent-runtime.ts`）：

- `buildSchedulerOptions` 按任务冻结 `mode` 过滤 skill 并尊重 skill-模式覆盖层；与聊天路径同约定，chat 模式不暴露 skill；模式提示词与插件提示词上下文跟随该模式。

涉及文件：

- 修改：`src/main/scheduler/execution-spec.ts`、`scheduler-engine.ts`、`scheduler-runner.ts`、`scheduler-ipc.ts`、`bootstrap.ts`、`src/main/application/core-bootstrap.ts`、`default-dependencies.ts`、`src/main/plugin-runtime.ts`、`src/main/plugin-host/host-services.ts`、`src/main/orchestrator/agent-runtime.ts`、`src/plugins/manager.ts`、`src/renderer/settings/scheduler/types.ts`
- 测试补充：`execution-spec.test.ts`（`isTaskEnabled` 用户/插件双口径）、`scheduler-engine.test.ts`（`canRunTask` 手动/定时跳过、未授权任务不排计时器、`refreshPluginTasks` 归一化重排）、`host-services.test.ts`（工厂装配 scheduler 服务、停止信号传导、补必填 `schedulerStore` 假件）、`core-bootstrap.test.ts`（scheduler-initialize 先于 plugins-start 顺序断言）

### 2.14 大步：用户确认 UI + 卸载清理（阶段 3 大步 3）

本步补齐插件调度任务的用户授权闭环：渲染层确认入口、主进程授权指纹写入、卸载时的任务清理。

主进程授权写入（`src/main/scheduler/execution-spec.ts`、`scheduler-ipc.ts`）：

- 新增 `pluginTaskTogglePatch(task, enable)`：停用清 `pluginUserEnabled`；启用时置 `pluginUserEnabled: true` 并按当前规格写入 `approvalFingerprint`。开关 IPC 对插件任务改用该 patch，用户任务路径不变。
- 新增 `authorizePluginTaskUpdatePatch(current, patch)`：编辑保存视为同一次授权。patch 中的 `enabled`/`toolMode` 宿主内部字段直接丢弃；合并新旧规格后重算指纹，插件任务任何有效规格写入都伴随 `pluginUserEnabled: true` + 指纹刷新。更新 IPC 对插件任务走该入口。

渲染层确认 UI（`src/renderer/settings/scheduler/panel.ts`、`state.ts`）：

- 插件任务显示"由插件创建"标注（插件 id）；启用前弹确认框，完整披露插件 id、计划、提示词（超 120 字截断）、会话模式与工具白名单，用户确认后才发起启用。
- 插件未运行时任务显示"等待插件启用"状态并禁用立即运行按钮；运行状态来自插件列表 IPC。
- 插件任务的启用开关不再直接透传 `enabled`，改走带授权语义的开关 IPC。

卸载清理（`src/plugins/manager.ts`、`src/main/plugin-runtime.ts`、`src/main/scheduler/scheduler-store.ts`）：

- `PluginManagerOptions` 新增 `cleanupPersistentResources(pluginId)`，仅真正卸载（uninstall）时调用；热重载、扫描更新、启停和安装替换都不调用。
- 钩子内调用 `schedulerStore.deleteTasksByOwner(pluginId)` 删除插件名下全部任务；清理抛错时卸载中止、目录保留，插件保持停用，避免出现"程序已删、任务还在跑"的孤儿状态。
- `deleteTasksByOwner` 返回删除条数并持久化、广播变更。

涉及文件：

- 修改：`src/main/scheduler/execution-spec.ts`、`execution-spec.test.ts`、`scheduler-ipc.ts`、`scheduler-store.ts`、`scheduler-store.test.ts`、`src/plugins/manager.ts`、`src/main/plugin-runtime.ts`、`src/renderer/settings/scheduler/panel.ts`、`state.ts`
- 测试补充：`manager.test.ts`（卸载调用清理钩子、清理失败中止卸载并保留目录）

### 2.15 大步：事件总线旁路发布与生命周期屏障（阶段 4 大步 1）

普通发布改为宏任务旁路（`src/plugins/events.ts`）：

- `emit()` 内部用 `setImmediate` 调度派发：发布函数返回时不在当前调用栈进入任何第三方监听器；返回的 Promise 在全部监听器已被调用后兑现。事件名校验失败仍以 Promise 拒绝返回，保持既有调用方错误约定。
- 派发循环对每个监听器同步调用：同步抛错立即隔离并记录；返回 Promise 的监听器不被派发路径等待，异步结果单独附加 5 秒超时（`unref`，不阻止进程退出）与错误日志，超时只忽略迟到结果。
- 快照发布语义不变：回调中退订不影响本轮派发顺序。

生命周期屏障（`src/plugins/events.ts`、`src/plugins/manager.ts`）：

- 新增 `emitLifecycleBarrier()`：顺序等待每个监听器完成（含单个 5 秒超时与错误隔离），专供 `plugins:ready` / `plugins:stopping`。
- `PluginManager` 新增 `publishHostLifecycleBarrier()`；start/stop 的两处屏障事件改走该入口，payload 与等待语义不变。普通宿主事件（runtime:ready、turn:completed 等）继续走 `publishHostEvent` 旁路，不等待监听器。

涉及文件：

- 修改：`src/plugins/events.ts`、`src/plugins/manager.ts`
- 测试重写：`src/plugins/events.test.ts`（旁路不进当前调用栈、快照顺序、慢监听器不阻塞、异步超时/拒绝日志、屏障顺序等待与超时、事件名校验双入口）
- 测试补充：`src/plugins/manager.test.ts`（真实插件链路上普通宿主事件不被未决监听器阻塞）、`src/plugins/context.test.ts`（mock 总线补齐新接口）

### 2.16 大步：生命周期发布器 + 渠道与调度轮次（阶段 4 大步 2）

生命周期发布器（新增 `src/main/plugin-host/lifecycle-publisher.ts`）：

- `createLifecyclePublisher({ publish, eventId?, now? })` 统一盖章 `eventId` 与 ISO 时间戳后走旁路发布（接 `PluginManager.publishHostEvent`，不等待监听器）。
- 元数据放在 payload 最后展开，调用方输入无法覆盖 `eventId`/`timestamp`；发布失败只记录告警，不影响宿主主流程。
- `TurnStartedInput` / `TurnFinishedInput` 用分布 Omit 从 `api.ts` 的可辨识联合派生（直接 `Omit<联合, K>` 只剩公共字段，会丢失各来源分支的必填字段）；时钟与事件 id 可注入以便测试。

渠道轮次事件（`src/main/channels/bootstrap.ts`）：

- 渠道消息执行前发布 `turn:started`（source=channel，携带 channel、conversationId、runId、mode）；runId 为本轮生成的随机 UUID。
- finally 路径发布 `turn:finished`：成功、超时、异常退出都各发布一次，status 取 agent 真实终态（异常退出为 runtime_error）。
- 渠道不写桌面会话 Store，事件不提供 inputMessageId/finalMessageId 消息边界。

调度轮次事件（`src/main/scheduler/scheduler-runner.ts`）：

- 任务开跑前发布 `turn:started`（source=scheduler，携带 taskId、schedulerRunId、任务冻结的 mode）；runId 复用历史记录 ID。
- 成功/异常路径都发布 `turn:finished` 与 `scheduler:finished`；成功路径的 status 以 agent 终态为准（Observable 在超时等非成功终态下也会正常 complete），异常路径为 runtime_error。
- 调度执行没有桌面会话，事件负载不伪造 conversationId。

装配（`src/main/application/default-dependencies.ts`、`src/main/scheduler/bootstrap.ts`）：

- 组合根创建单一 lifecyclePublisher（无插件管理器时发布为 no-op），注入 channels 与 scheduler 子系统；两个子系统的发布器依赖均为可选，早期装配与纯策略测试不受影响。

涉及文件：

- 新增：`src/main/plugin-host/lifecycle-publisher.ts`、`lifecycle-publisher.test.ts`（4 项）
- 修改：`src/main/channels/bootstrap.ts`、`bootstrap.test.ts`（成功/超时/异常三路径的事件断言）
- 修改：`src/main/scheduler/scheduler-runner.ts`、`scheduler-runner.test.ts`（新增 runScheduledTask 生命周期测试 5 项）
- 修改：`src/main/scheduler/bootstrap.ts`、`src/main/application/default-dependencies.ts`、`src/plugins/api.ts`（`PluginSchedulerFinishedEvent` 类型）

### 2.17 大步：桌面轮次（阶段 4 大步 3）

桌面轮次协调器（新增 `src/main/plugin-host/pending-turn-lifecycle.ts`）：

- `createPendingTurnLifecycle({ publisher, now?, ackTimeoutMs?, graceMs?, onAbandon? })`：`beginTurn` 在 run 开始时立即发布 `turn:started`（desktop 分支必填 inputMessageId）；`settleTerminal` 只登记终态不发布；`confirmPersistence` 登记渲染端落盘确认；"终态 + 落盘确认"双条件满足才发布一次 `turn:finished`（best-effort at-most-once）。
- `finalMessageId` 只在落盘确认携带时存在；确认缺失（如纯终态快照确认）不补齐，绝不用会话当前最后一条消息代替。
- 清理全部经同一 `disposeEntry(runId)` 收口：发布后清理、终态后 60 秒无落盘确认（诊断 + 放弃）、整体期限（runTimeoutMs + 60 秒宽限）到期、渲染进程销毁/导航、应用关闭（`disposeAll`）。
- 所有计时器 `unref()` 不阻止主进程退出；时钟可注入（`now`），测试用 fake timers。终态登记幂等：complete/error 双路径重复调用只认首个终态。
- 缺失 inputMessageId 时整轮跳过并输出诊断（无法构造事件边界）。

agui-bridge 接入（`src/main/agui-bridge.ts`）：

- `registerAgUiIpc` 新增可选参数 `pendingTurns`（第 6 位）；缺省不发布轮次事件，既有测试与早期装配不受影响。
- run 真正开跑前 `beginTurn`（userTurnId/assistantTurnId 来自渲染端已落库的稳定 turn ID，runTimeoutMs 取 options.timeoutMs）；发起 run 的 sender 上监听 `destroyed` / `did-start-navigation`，渲染进程失效即清理条目；`cleanupRunState` 统一摘除监听。
- complete 与 error 双路径都调用 `settleTerminal`（含 error 路径中 gate 已被 next(RUN_FINISHED) 结算的分支——此时 complete 可能不再被调用）；status 以 settlement gate 为准，durationMs 自 run 开始计时。

落盘确认 IPC：

- `src/shared/ipc-channels.ts` 新增 `AGUI_RUN_PERSISTED`（渲染端→主进程单向通知）。
- `src/preload/index.ts` 的 aguiApi 新增 `reportRunPersisted({ runId, finalMessageId? })`；主进程在注册桥时用 `ipc.on` 监听并转发给协调器（payload 做 runId/finalMessageId 字符串校验）。
- `ChatPage.tsx` 最小侵入：`checkpointRun("terminal", true)` 成功后的成功路径与错误路径各上报一次落盘确认（runId 未知时静默跳过，如会话守卫冲突路径）；守卫冲突卡路径不上报（run 从未被主进程接受）。
- `host:turn:completed` v1 兼容事件保持原发布点不动（agent-runtime 成功收尾后），不绑定新协调器。

装配（`src/main/application/default-dependencies.ts`）：

- 组合根创建单一 pendingTurnLifecycle（复用大步 2 的 lifecyclePublisher，放弃发布走 console.warn 诊断），作为第 6 参传给 `registerAgUiIpc`；`app.on("will-quit")` 时 `disposeAll()`。

涉及文件：

- 新增：`src/main/plugin-host/pending-turn-lifecycle.ts`、`pending-turn-lifecycle.test.ts`（11 项）
- 修改：`src/main/agui-bridge.ts`（协调器接线 + 落盘确认监听）、`agui-bridge.test.ts`（electron mock 补 `ipcMain.on`；新增全链路集成测试：开始登记 → 终态结算 → 落盘确认后发布一次）
- 修改：`src/shared/ipc-channels.ts`、`src/preload/index.ts`、`src/renderer/react/features/chat/pages/chat-page-bridge.ts`、`ChatPage.tsx`、`src/main/application/default-dependencies.ts`

### 2.18 大步：工具完成事件（阶段 4 大步 4）

本步完成阶段 4 的最后一块：Harness 工具执行的只读观察事件。桌面、渠道和调度三个来源的工具轮全部覆盖。

公开契约（`src/plugins/api.ts`）：

- 新增 `PluginToolStatus`（success / failure / unknown / not_executed，与宿主执行层四态 outcome 一致）、`PluginToolRisk`（safe / fs-read / fs-write / shell / network / input-control，与宿主工具注册表风险级一致）和 `PluginToolFinishedEvent`（runId、toolId、toolCallId、status、risk、durationMs?）。
- 事件不携带工具参数、输出、文件变更正文与内部异常；`durationMs` 只在工具真正执行过时存在（not_executed 无耗时）。

Harness 只读回调（`src/main/orchestrator/harness/types.ts`、`tool-round.ts`、`cyrene-harness.ts`）：

- `HarnessInput` 新增可选 `onToolFinished`；`HarnessToolFinishedEvent` 只含稳定元数据（risk 类型来自 permission-policy 的 `ToolRiskLevel`）。
- 发布点放在工具结果已确定的位置：普通工具在 `commitToolResult`（execute 收敛、notExecuted 合成、execution_error 合成三条路都经此提交）；ask_user 排他轮单独处理（被挤掉的调用发 not_executed，primaryAsk 按真实 outcome + 耗时）。
- 耗时经 `HarnessRun.toolCallStartedAt` Map 跟踪（execute 开始记录、提交后即删）；risk 取工具注册表声明（未注册的 harness 内置工具视为 safe）；runId 取 `input.runId`，缺失时回退 `toolContext.runId`。
- 回调只观察，不参与权限判断、重试、提交或恢复；未注入回调时零开销。

接线与装配：

- `CyreneRunOptions` 新增可选 `onToolFinished`；`harness-adapter.ts` 透传给 harnessInput。
- `AgentRuntimeDeps` 新增可选 `publishToolFinished`；agent-runtime 在 `buildOptions`（桌面 + 渠道共用）与 `buildSchedulerOptions`（调度）统一注入，三来源全覆盖。
- `lifecycle-publisher.ts` 新增 `publishToolFinished`（事件名 `tool:finished`，统一盖章 eventId/timestamp 走旁路发布）；组合根把 lifecyclePublisher 方法注入 agent-runtime。

涉及文件：

- 修改：`src/plugins/api.ts`、`src/main/orchestrator/harness/types.ts`、`tool-round.ts`、`cyrene-harness.ts`、`src/main/orchestrator/cyrene-agent.ts`、`harness-adapter.ts`、`agent-runtime.ts`、`src/main/plugin-host/lifecycle-publisher.ts`、`src/main/application/default-dependencies.ts`
- 测试补充：`cyrene-harness.test.ts`（成功提交后的字段白名单断言、ask_user 排他轮 not_executed/耗时语义 2 项）、`lifecycle-publisher.test.ts`（tool:finished 盖章断言）、`agent-runtime.test.ts`（buildOptions 注入转发与未配置不注入）

## 3. 已完成验证

| 验证项 | 结果 |
| --- | --- |
| `npx vitest run --maxWorkers=1 src/plugins src/main/orchestrator/agent-runtime.test.ts`（基线核对时） | 8 个文件 87 项测试全部通过 |
| `npx vitest run --maxWorkers=1 src/plugins`（能力枚举与错误码步骤） | 8 个文件 81 项测试全部通过 |
| `npx vitest run --maxWorkers=1 src/plugins`（轮次事件类型步骤） | 8 个文件 82 项测试全部通过 |
| `npx vitest run --maxWorkers=1 src/plugins`（会话服务类型步骤） | 8 个文件 84 项测试全部通过 |
| `npx vitest run --maxWorkers=1 src/plugins`（Secrets/Workspace 类型步骤） | 8 个文件 84 项测试全部通过 |
| `npx vitest run --maxWorkers=1 src/plugins`（Scheduler 类型步骤） | 8 个文件 84 项测试全部通过 |
| `npx vitest run --maxWorkers=1 src/plugins`（Schema/跟踪器/工厂大步） | 10 个文件 103 项测试全部通过 |
| `npm run build:main` | 通过 |
| `npm run check:plugin-schema`（Schema 与类型无漂移） | 通过 |
| `dist/main/plugins/manifest.schema.json` 构建产物检查 | 文件存在 |
| `npm test`（扩展施工前全量基线） | 391 个文件 3037 项测试全部通过 |
| `npm test`（Schema/跟踪器/工厂大步后） | 394 个文件 3061 项测试全部通过 |
| `npx vitest run --maxWorkers=1 src/main/plugin-host src/plugins`（Secrets/Workspace/Conversations 大步） | 14 个文件 134 项测试全部通过 |
| `npm run build:main`（Secrets/Workspace/Conversations 大步后） | 通过 |
| `npm test`（Secrets/Workspace/Conversations 大步后） | 398 个文件 3092 项测试全部通过 |
| `npx vitest run --maxWorkers=1 src/main/scheduler src/main/plugin-host src/plugins`（调度大步 1 后） | 22 个文件 183 项测试全部通过 |
| `npm run build:main`（调度大步 1 后） | 通过 |
| `npm test`（调度大步 1 后） | 400 个文件 3114 项测试全部通过 |
| `npx vitest run src/main/scheduler src/main/plugin-host src/plugins/manager.test.ts src/main/application/core-bootstrap.test.ts`（调度大步 2 后定向） | 14 个文件 111 项 + 4 个文件 31 项测试全部通过 |
| `npx vitest run src/main/orchestrator/agent-runtime.test.ts src/main/scheduler/scheduler-runner.test.ts`（调度大步 2 后补充） | 2 个文件 9 项测试全部通过 |
| `npm run build:main`（调度大步 2 后） | 通过（过程中修复 `agent-runtime.ts` 将 `PluginPromptMode` 直传 `getEnabledForMode` 的类型错误，chat 模式归一为空 skill 列表） |
| `npx vitest run src/plugins/manager.test.ts src/main/scheduler/execution-spec.test.ts src/main/scheduler/scheduler-store.test.ts src/main/scheduler/scheduler-engine.test.ts`（调度大步 3 后定向） | 4 个文件 66 项测试全部通过 |
| `npm run build:main`（调度大步 3 后） | 通过 |
| `npm test`（调度大步 3 后） | 400 个文件 3130 项测试全部通过 |
| `npx vitest run src/plugins/events.test.ts src/plugins/context.test.ts src/plugins/manager.test.ts src/main/orchestrator/agent-runtime.test.ts`（阶段 4 大步 1 后定向） | 4 个文件 65 项测试全部通过 |
| `npm run build:main`（阶段 4 大步 1 后） | 通过 |
| `npm test`（阶段 4 大步 1 后） | 400 个文件 3136 项测试全部通过 |
| `npx vitest run --maxWorkers=1 src/main/plugin-host src/main/scheduler src/main/channels src/plugins`（阶段 4 大步 2 后定向） | 49 个文件 381 项测试全部通过 |
| `npm run build:main`（阶段 4 大步 2 后） | 通过（过程中修复 `Omit` 联合类型不分布导致渠道/调度分支字段丢失的类型错误） |
| `npx vitest run --maxWorkers=1 src/main/plugin-host/pending-turn-lifecycle.test.ts src/main/agui-bridge.test.ts`（阶段 4 大步 3 后定向） | 2 个文件 42 项测试全部通过 |
| `npm run build:main`（阶段 4 大步 3 后） | 通过 |
| `npm test`（阶段 4 大步 3 后） | 402 个文件 3157 项测试全部通过 |
| `npx vitest run --maxWorkers=1 src/main/orchestrator/harness src/main/orchestrator/agent-runtime.test.ts src/main/plugin-host src/plugins src/main/scheduler src/main/channels src/main/agui-bridge.test.ts`（阶段 4 大步 4 后定向） | 77 个文件 609 项测试全部通过 |
| `npm run build:main`（阶段 4 大步 4 后） | 通过 |
| `npm test`（阶段 4 大步 4 后） | 402 个文件 3160 项测试全部通过 |
| `git diff --check` | 通过，仅有 Git 换行符提示 |

## 4. 未完成项

以下项目均未开始实现，不能因为设计文档已经写好而标记为完成。

（公开契约、Manifest Schema、统一资源跟踪器和宿主服务工厂已在 2.4–2.10 完成；Secrets、Workspace、Conversations 宿主数据服务已在 2.11 完成；调度数据模型、授权指纹与 scheduler-service 已在 2.12 完成；引擎运行条件、插件启停联动、渲染层投影已在 2.13 完成；用户确认 UI 与卸载清理已在 2.14 完成；事件总线旁路与生命周期屏障已在 2.15 完成；生命周期发布器与渠道/调度轮次事件已在 2.16 完成；桌面轮次协调与落盘确认已在 2.17 完成；工具完成事件已在 2.18 完成，阶段 4 至此全部完成。）

### 4.1 语音输入接管

- 普通聊天语音输入目标登记。
- 独占租约、内置 ASR 暂停和自动恢复。
- 冻结会话及渲染目标后的文本提交桥。
- 页面重载、导航、目标删除、插件停用和异常回收。
- 活动通话的语音输入接入。
- 最小本地 ASR 契约示例；不把模型和推理运行时放入 Cyrene 安装包。

### 4.2 开发者交付物

- `@cyrene/plugin-sdk` 开发包。
- 插件清单结构定义及校验命令。
- 天气、长期记忆、自动化和本地 ASR 契约示例。
- 插件开发文档和 `cyrene-plugin-dev` Skill（技能）同步更新。
- 官方插件仓库所需的基础静态检查规则。

## 5. 下一步起点

阶段 3（插件调度任务所有权）已全部完成（见 2.12–2.14）。阶段 4（生命周期观察事件）四个大步已全部完成（见 2.15–2.18）。下一步从阶段 5（普通聊天语音输入租约）开始，见 implementation-plan.md 第 5 节。

### 大步 1：事件总线升级（4.1）——已完成（见 2.15）

- `emit()` 改为 `setImmediate` 宏任务旁路：发布函数返回时不在当前调用栈进入任何第三方监听器；快照顺序派发，不等待监听器 Promise（fire-and-forget），每个监听器异步结果独立超时与错误日志。
- 单独保留 `emitLifecycleBarrier()` 给 `plugins:ready` / `plugins:stopping`（沿用现有顺序等待 + 5 秒超时语义），普通宿主事件不得误用阻塞入口。
- 宿主发布生成唯一 `eventId` 与 ISO 时间戳（落到新事件 payload，兼容事件不强行补入）。
- 涉及：`src/plugins/events.ts`、`src/plugins/manager.ts`。

### 大步 2：生命周期发布器 + 渠道与调度轮次（4.3）——已完成（见 2.16）

- 新增 `src/main/plugin-host/lifecycle-publisher.ts` 统一盖章 `eventId`/时间戳并发布。
- 渠道在开始执行与规范终态后发布 `turn:started` / `turn:finished`；不写桌面会话 Store 时不提供消息边界。
- 调度器发布 `turn:started` / `turn:finished` 与含任务 ID、历史 ID 的 `scheduler:finished`；无桌面会话时不伪造 `conversationId`。
- 涉及：`src/main/channels/bootstrap.ts`、`src/main/scheduler/scheduler-runner.ts`。

### 大步 3：桌面轮次（4.2）——已完成（见 2.17）

- `PendingTurnLifecycle` 协调器：runId + 终态 + 落盘确认双条件才发布一次；落盘确认 60 秒超时放弃（best-effort at-most-once）；计时器可注入时钟且 `unref()`；渲染进程销毁/重载/导航与应用关闭时清理。
- 新增渲染端→主进程落盘确认内部 IPC（`ChatPage.tsx` 在 `checkpointRun("terminal", true)` 成功后上报）。
- `host:turn:completed` 原样保留为 v1 兼容事件；新插件用 `host:turn:finished`；非成功终态只在真实落盘确认存在时携带 `finalMessageId`。
- 涉及：`src/main/agui-bridge.ts`、`src/shared/ipc-channels.ts`、`src/preload/index.ts`、`src/renderer/react/features/chat/pages/ChatPage.tsx`（最小侵入）。

### 大步 4：工具完成事件（4.4）——已完成（见 2.18）

- Harness 内部只读 `onToolFinished` 回调，放在工具结果已确定的位置；只读 toolId、toolCallId、runId、归一化状态、注册时声明的风险、耗时；不发布参数、输出、文件变更正文与内部异常；不参与权限判断、重试、提交或恢复。
- 涉及：`src/main/orchestrator/harness/tool-round.ts`、`src/main/orchestrator/harness/types.ts`、`lifecycle-publisher.ts`。

验证命令：`npx vitest run --maxWorkers=1 src/plugins src/main/plugin-host src/main/scheduler`、`npm run build:main`，每个大步合并前全量 `npm test`。

不要在本阶段实现语音输入。

## 6. 当前工作区状态

当前改动尚未提交。交接时应先运行 `git status --short` 复核，因为用户可能在其他智能体或本地继续修改。

本次记录时包含以下改动：

- `docs/design/plugin-system/`：`architecture.md` 已修改（含 active-conversation → active-chat 命名统一）；`implementation-plan.md`、`construction-progress.md` 新增；
- `src/plugins/`：`api.ts`、`api.test.ts`、`context.ts`、`context.test.ts`、`loader.ts`、`loader.test.ts`、`types.ts`、`manager.ts` 已修改；新增 `cleanup.ts`、`resources.ts`、`resources.test.ts`、`manifest-validation.ts`、`manifest-validation.test.ts`、`manifest.schema.json`、`native-import.cjs`；
- `src/main/plugin-runtime.ts`、`src/main/orchestrator/agent-runtime.ts`、`agent-runtime.test.ts`：已修改；
- `src/main/application/`：`core-bootstrap.ts`、`core-bootstrap.test.ts`、`default-dependencies.ts` 已修改（scheduler 先于插件初始化、`canRunTask` 注入、启停联动接线）；
- `src/main/plugin-host/`：新增 `errors.ts`、`secrets-service.ts`、`secrets-service.test.ts`、`workspace-service.ts`、`workspace-service.test.ts`、`conversations-service.ts`、`conversations-service.test.ts`、`host-services.ts`、`host-services.test.ts`、`scheduler-service.ts`、`scheduler-service.test.ts`；`host-services.ts`/`host-services.test.ts` 含大步 2 的 `schedulerStore` 接入；
- `src/main/scheduler/`：`types.ts`、`scheduler-store.ts`、`scheduler-store.test.ts`、`scheduler-engine.ts`、`scheduler-engine.test.ts`、`scheduler-ipc.ts`、`scheduler-runner.ts`、`scheduler-runner.test.ts`、`bootstrap.ts` 已修改；新增 `execution-spec.ts`、`execution-spec.test.ts`（含 `isTaskEnabled`、授权 patch 与引擎运行条件测试）；
- `src/main/plugin-host/`：新增 `lifecycle-publisher.ts`、`lifecycle-publisher.test.ts`（阶段 4 大步 2）；新增 `pending-turn-lifecycle.ts`、`pending-turn-lifecycle.test.ts`（阶段 4 大步 3）；
- `src/main/channels/`：`bootstrap.ts`、`bootstrap.test.ts` 已修改（渠道轮次事件发布与断言）；
- `src/plugins/api.ts`：已修改（`PluginSchedulerFinishedEvent` 类型）；
- `src/main/agui-bridge.ts`、`agui-bridge.test.ts`：已修改（阶段 4 大步 3：协调器接线 + 落盘确认监听 + 全链路集成测试）；
- `src/shared/ipc-channels.ts`、`src/preload/index.ts`、`src/renderer/react/features/chat/pages/chat-page-bridge.ts`、`ChatPage.tsx`：已修改（阶段 4 大步 3：落盘确认 IPC 与渲染端上报）；
- 阶段 4 大步 4（本次）：`src/plugins/api.ts`、`src/main/orchestrator/harness/types.ts`、`tool-round.ts`、`cyrene-harness.ts`、`cyrene-harness.test.ts`、`src/main/orchestrator/cyrene-agent.ts`、`harness-adapter.ts`、`agent-runtime.ts`、`agent-runtime.test.ts`、`src/main/plugin-host/lifecycle-publisher.ts`、`lifecycle-publisher.test.ts`、`src/main/application/default-dependencies.ts` 已修改；
- `src/renderer/settings/scheduler/`：`types.ts` 已修改（补充 `ownerPluginId`）；`panel.ts`、`state.ts` 已修改（大步 3 的插件任务标注、启用确认弹窗与"等待插件启用"状态）；
- `scripts/plugin-sdk/generate-schema.mjs`：新增；
- `package.json`、`package-lock.json`：已修改（ajv 直接依赖、Schema 生成脚本、构建拷贝过滤器）。

后续智能体不得覆盖不属于当前小步骤的用户改动；发现工作区状态与本节不同，应以实时状态为准并先判断差异来源。
