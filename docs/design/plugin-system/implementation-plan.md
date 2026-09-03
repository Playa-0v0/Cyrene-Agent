# Cyrene 插件系统扩展施工文档

> **状态**：阶段 1–7 已全部完成（2026-09-03），详见施工进度文档
> **上游设计**：[architecture.md](./architecture.md)
> **施工进度**：[construction-progress.md](./construction-progress.md)
> **施工范围**：开放架构文档中的能力 1–8；不开放权限决策、Agent Loop（智能体循环）替换、核心热补丁和人格覆盖。
> 实施原则：每个阶段可独立测试、独立提交、独立回滚；未通过阶段验收前不进入下一阶段。

## 1. 施工目标

本施工文档把架构边界落实为可执行的代码改动。完成后，第三方开发者只依赖 SDK（软件开发工具包）`@cyrene/plugin-sdk`，即可开发联网工具、外部服务写操作、本地知识库、代码工具、长期记忆、渠道、自有窗口、后台自动化、观察类扩展和外部 ASR（自动语音识别）输入插件。

宿主只负责稳定 API（应用程序编程接口）、内部适配、生命周期回收和契约测试。模型文件、推理运行时、插件窗口、跨平台兼容、下载器和业务实现均由插件作者维护。

本次不做：

- 插件进程隔离或权限沙箱；
- 宿主 UI（用户界面）插槽；
- 通用 OAuth（开放授权）框架；
- 通用模型下载器；
- TTS（文本转语音）引擎注入；
- 可修改 Harness（智能体执行框架）参数或结果的钩子；
- `src/main/**`、`src/renderer/**` 等内部模块的兼容承诺。

## 2. 当前代码基线

施工前已经核对当前仓库，以下不是假设：

| 位置 | 当前状态 | 本次处理 |
| --- | --- | --- |
| `src/plugins/api.ts` | `apiVersion` 为 1；`deps` 只有 `channels`、`llm` | 在 v1 中兼容新增五项可选能力和公开类型 |
| `src/plugins/loader.ts` | 手写 Manifest（插件清单）校验；依赖白名单只有两项 | 改为 Schema（结构定义）校验加文件系统校验 |
| `src/plugins/context.ts` | 工具、IPC（进程间通信）、渠道、事件和 Provider（提供器）分别维护清理集合 | 收敛为统一资源跟踪器，仍保持逆序、幂等和超时清理 |
| `src/plugins/events.ts` | `emit()` 逐个等待监听器，慢插件会延迟发布方 | 改为同步派发、异步旁路、超时只记日志 |
| `src/main/plugin-runtime.ts` | 只注入渠道、LLM（大语言模型）、工具、提示词和 IPC | 注入宿主服务工厂，不暴露内部 Store（存储对象） |
| `src/main/chats/chats-store.ts` | 已有会话列表、消息和工作区绑定 | 只增加稳定投影适配器，不改公开插件去依赖 Store |
| `src/main/scheduler/**` | 已有 Scheduler（定时调度器）存储、引擎和历史；执行时固定 `permissionMode: "allow_all"` | 增加插件所有权、待用户启用和显式工具白名单约束 |
| `src/main/orchestrator/agent-runtime.ts` | `AgentRuntime`（智能体运行时）只有成功后的 `turn:completed` | 保留兼容事件，新增完整终态事件 |
| `src/renderer/react/features/chat/pages/ChatPage.tsx` | 用户消息和最终消息均由渲染进程持久化 | 增加一个窄的外部文本提交入口和完成落盘确认 |
| `src/main/chats/chat-ui-ipc.ts` | 只记录当前活动会话 ID（标识符） | 改为记录会话 ID、模式和对应渲染进程目标 |
| `src/main/call/call-manager.ts` | ASR、模型和 TTS 串在一个模块状态机中 | 抽出“提交最终文本”路径，并增加外部输入占用状态 |
| `package.json` | 没有 npm（Node.js 包管理器）Workspace（工作区），没有 SDK 包 | 使用 npm 自带工作区管理一个薄 SDK，不引入 monorepo（单仓多包）框架 |

### 2.1 必须先处理的现状差异

现有 Scheduler 不是交互审批模式。它先按任务配置筛选工具，然后以 `allow_all` 执行。因此插件 API 不能直接复用渲染层现有的全部增删改开关能力。

插件调度接口必须执行以下硬规则：

1. 新建任务强制持久化 `enabled: false`，用户授权状态写入插件无法修改的独立字段；
2. 强制 `toolMode: "allow-list"`；
3. 不向插件提供 `toggle` 和 `fireNow`；
4. 用户只能在现有调度页面核对配置后启用；
5. 插件修改计划、提示词、会话模式或工具白名单构成的完整执行规格时自动停用并清除授权指纹；
6. 插件停用后引擎跳过其任务，重新启用插件后不补跑；
7. 插件卸载时删除其任务，历史记录可保留。

这样不需要新建一套权限系统，也不会让插件通过定时任务自行取得无人值守执行权。

## 3. 现成能力复用决定

### 3.1 直接复用

- 使用 Electron（桌面应用框架）`safeStorage` 保存插件密钥，不自行实现密码学；
- 使用现有 `chats-store` 读取会话和工作区绑定，不建立第二份会话数据库；
- 使用现有 Scheduler Engine（调度引擎）、任务 Store 和历史文件，不建立第二套队列；
- 使用现有 `AgentRuntime` 和 `CyreneAgent` 执行任务，不给插件开放 Harness 包装器；
- 使用现有工具注册表和风险字段，不复制一套工具系统；
- 使用现有 `AbortController`（中止控制器）、`AbortSignal`（中止信号）和插件清理超时机制管理取消；
- 使用现有插件私有目录和原子写入方式保存普通数据；
- 使用 npm Workspace 管理 SDK，不引入 Lerna、Nx 或 Turborepo；
- 使用现有 esbuild（JavaScript 打包器）和 TypeScript（类型化 JavaScript 语言）编译 SDK，不新增通用打包框架。

### 3.2 新增成熟依赖

| 依赖 | 用途 | 类型 | 限制 |
| --- | --- | --- | --- |
| `ajv` | 宿主与 SDK 共用 JSON Schema（JSON 结构定义）运行时校验 | 直接依赖 | 仅校验纯数据；入口文件和链接越界仍由 Loader（加载器）检查 |
| `ts-json-schema-generator` | 从 `PluginManifestInput` 生成 Schema | 开发依赖 | 只在构建和 CI（持续集成）运行，不进入应用运行包 |

`ajv` 当前已被间接依赖带入锁文件，但必须声明为直接依赖，不能依靠其他包的内部依赖关系。

### 3.3 明确不复用

`src/main/channels/settings-store.ts` 的弱保护回退不能用于插件密钥。它在 `safeStorage` 不可用时会退回机器指纹混淆，而插件 Secrets（密钥服务）的契约要求明确返回 `E_STORAGE_UNAVAILABLE`，不能把混淆描述为安全加密。

本次也不把音乐模块的专用凭据仓库泛化为插件服务，避免插件 API 反向绑定音乐业务对象。

## 4. 核心施工不变量

以下规则优先于单个阶段的便利实现：

1. Plugin API（插件接口）边界不等于 Security Boundary（安全边界）。同进程可信插件可以绕过公开接口，本次不宣称抵御恶意代码。
2. 所有临时宿主资源必须归属于创建它的 `PluginContext`，并进入同一套停止、回滚和逆序清理路径。
3. 一个 Capability（宿主能力）不得用来绕过另一个 Capability 的限制；例如 Scheduler 不能替插件取得额外审批权，Speech Input 不能构造 Harness 请求。
4. 对外只返回稳定 Projection（投影），不得穿透内部 Store、运行对象、错误对象或渲染组件。
5. Tool Risk（工具风险）由插件作者声明。宿主审批链信任该声明，不能验证 `execute()` 的真实副作用；官方插件仓库另用 Static Analysis（静态分析）和 Code Review（代码审查）发现明显不匹配。
6. 宿主发布路径不得在当前调用栈进入第三方监听器，但同进程插件仍可在后续任务中用同步死循环阻塞 Electron 主进程。
7. `cyrene_harness.md` 继续由提示词文件机制管理，不为人格修改增加插件接口。

任何实现若破坏以上不变量，必须返回架构评审，不能以“仅内部使用”为由直接合入。

## 5. 目标目录与依赖方向

计划新增或调整的核心结构：

```text
src/plugins/
  api.ts                         # 唯一公开类型源
  manifest-validation.ts         # AJV 校验入口
  manifest.schema.json           # 自动生成并提交
  resources.ts                   # PluginContext 资源跟踪器
  context.ts                     # 按 manifest deps 注入服务
  events.ts                      # 异步旁路事件总线
  loader.ts                      # Schema + 文件边界校验

src/main/plugin-host/
  errors.ts                      # 内部异常到公开错误码
  host-services.ts               # 宿主服务装配
  secrets-service.ts             # safeStorage 适配
  workspace-service.ts           # 工作区稳定投影
  conversations-service.ts       # 会话分页和稳定投影
  scheduler-service.ts           # 插件所有权与启用边界
  lifecycle-publisher.ts         # 轮次/工具/调度事件翻译
  speech-input-service.ts        # 独占输入租约
  active-chat-target.ts          # 冻结聊天目标

packages/plugin-sdk/
  package.json
  tsconfig.json
  src/index.ts
  src/testing.ts
  manifest.schema.json           # 构建时从 src/plugins 复制

examples/plugins/
  weather-tool/
  long-term-memory/
  scheduled-automation/
  local-asr-contract/

scripts/plugin-sdk/
  generate-schema.mjs
  build.mjs
  verify-package.mjs
```

依赖方向固定为：

```text
第三方插件
  ↓ 只依赖
@cyrene/plugin-sdk / src/plugins/api.ts
  ↓ 由 Context 注入
src/main/plugin-host/*
  ↓ 只在适配层内部使用
ChatsStore / Scheduler / CallManager / AgentRuntime
```

禁止出现以下反向依赖：

- `src/plugins/api.ts` 导入 `src/main/**` 或 `src/shared/**`；
- SDK 导出宿主内部类型；
- 示例插件导入 Cyrene 仓库内部路径；
- 宿主 Store 返回对象原样穿透给插件；
- 插件服务直接持有渲染层 React（界面组件库）对象。

## 6. 公开契约施工

### 6.1 能力声明

在 `PluginCapability` 中兼容新增：

```ts
"secrets" | "workspace" | "conversations" | "scheduler" | "speech-input"
```

`loader.ts` 先用生成的 Schema 校验字段、枚举和必填项，再执行以下宿主文件校验：

- `entry` 必须是插件目录内的裸文件名；
- 扩展名只能为 `.cjs`、`.js`、`.mjs`；
- 真实路径不能通过符号链接越出插件目录；
- 图标继续沿用当前大小、类型和越界规则；
- `apiVersion` 必须等于当前宿主支持版本；
- `deps` 去重，未知值拒绝加载。

Schema 不能替代文件系统检查，两层必须同时保留。

### 6.2 错误对象

SDK 导出 `PluginHostError` 和 `isPluginHostError()`。公开字段只有：

```ts
interface PluginHostError extends Error {
  code: PluginHostErrorCode;
}
```

内部 `cause` 只进入宿主日志，不进入插件事件和公开对象。所有适配器统一通过 `src/main/plugin-host/errors.ts` 创建错误，禁止每个服务自行拼接不稳定错误类型。

### 6.3 服务注入

`PluginRuntime` 增加宿主服务工厂，不直接保存某个插件的服务实例：

```ts
interface PluginHostServiceFactory {
  createForPlugin(input: {
    pluginId: string;
    signal: AbortSignal;
    trackResource: PluginResourceTracker;
  }): PluginDeps;
}
```

`createContext()` 只把 manifest 已声明且宿主可用的服务放入 `ctx.deps`。硬依赖不可用时，在调用插件 `register()` 前失败并走现有激活回滚。

第一版不增加可选能力探测对象 `ctx.host`。

### 6.4 统一资源跟踪

新增 `PluginResourceTracker`：

- 注册资源时记录 `kind`、稳定标识和清理函数；
- 手动注销时释放对应句柄并从跟踪器移除；
- `dispose()` 按注册逆序执行；
- 每个清理函数最多调用一次；
- 单项超时或失败不会阻止后续清理；
- Context 停止后拒绝登记新资源；
- `ctx.signal.abort()` 先于第三方 `unregister()`；
- 语音租约必须登记；
- 持久化调度任务以 `ownerPluginId` 记录所有权，停用时不删除，因此不作为普通临时句柄释放。

现有工具、渠道、IPC、事件监听、Prompt Provider（提示词提供器）和 `onDispose()` 都迁移到该跟踪器。迁移不改变公开调用方式。

### 6.5 阶段 1 必须冻结的跨能力契约

以下类型不能留到阶段 2–6 再临时补字段。

消息分页入口正式定义为：

```ts
interface PluginMessagePageInput {
  conversationId: string;
  /** 包含式起点。 */
  fromMessageId?: string;
  /** 包含式终点。 */
  throughMessageId?: string;
  cursor?: string;
  limit?: number;
}

interface PluginMessagePage {
  items: PluginConversationMessage[];
  nextCursor?: string;
  range: {
    fromMessageId?: string;
    throughMessageId?: string;
  };
}
```

长期记忆插件的标准调用必须能直接表达：

```ts
if (event.source !== "desktop" || !event.finalMessageId) return;

await ctx.deps.conversations!.getMessages({
  conversationId: event.conversationId,
  fromMessageId: event.inputMessageId,
  throughMessageId: event.finalMessageId,
});
```

后续页的 `cursor` 自带同一组冻结边界。同时提交显式边界时必须完全一致，否则返回 `E_INVALID_ARGUMENT`。

轮次事件正式定义为按 `source` 区分的 Discriminated Union（可辨识联合类型）：

```ts
type PluginTurnFinishedEvent =
  | {
      source: "desktop";
      runId: string;
      conversationId: string;
      inputMessageId: string;
      finalMessageId?: string;
      mode: PluginPromptMode;
      status: PluginTurnStatus;
      eventId: string;
      timestamp: string;
      durationMs?: number;
    }
  | {
      source: "channel";
      runId: string;
      channel: string;
      conversationId?: string;
      mode: PluginPromptMode;
      status: PluginTurnStatus;
      eventId: string;
      timestamp: string;
      durationMs?: number;
    }
  | {
      source: "scheduler";
      runId: string;
      taskId: string;
      schedulerRunId: string;
      mode: PluginPromptMode;
      status: PluginTurnStatus;
      eventId: string;
      timestamp: string;
      durationMs?: number;
    };
```

`PluginTurnStartedEvent` 使用同一来源联合，但不包含 `status`、`durationMs` 和 `finalMessageId`。插件通过 `event.source` 获得 TypeScript 自动类型收窄，不需要猜测一组可选字段是否合法。

桌面非成功终态仍保证 `inputMessageId` 指向已经落盘的用户消息；`finalMessageId` 只有宿主确认某条助手消息已经成为本轮最终持久化边界时才存在。不得使用会话当前最后一条助手消息补齐字段。

调度授权正式围绕 `ExecutionSpec`（执行规格）定义：计划、提示词、会话模式和工具白名单都属于执行规格；标题属于元数据。用户确认时保存规范化执行规格的 SHA-256（安全哈希算法）授权指纹，执行前必须重新计算并匹配。未来增加模型、工作区或执行目标时，必须先把字段加入该规格。

## 7. 分阶段施工

### 阶段 0：冻结基线

目标：在功能扩展前锁定现有行为，避免施工把旧插件弄坏。

改动：

- 补充现有 CJS（CommonJS 模块格式）与 ESM（ECMAScript 模块格式）入口加载测试；
- 固化未声明 `deps` 不注入、未知依赖拒绝、注册失败回滚和停用清理测试；
- 固化用户插件默认不自动启用的行为；
- 记录 `host:turn:completed` 为 v1 兼容事件，后续不删除；
- 运行全量测试并保存基线结果。

主要文件：

- `src/plugins/loader.test.ts`
- `src/plugins/context.test.ts`
- `src/plugins/manager.test.ts`
- `src/main/orchestrator/agent-runtime.test.ts`

建议提交：`test: 冻结插件系统扩展前基线`

退出条件：无生产代码语义变化；相关测试和 `npm run build:main` 通过。

### 阶段 1：公开契约、Schema 与资源跟踪器

目标：先建立后续所有能力共同依赖的稳定底座。

改动：

1. 扩展 `src/plugins/api.ts`：
   - 新能力枚举；
   - Secrets、Workspace（工作区）、Conversations（会话）、Scheduler 和 Speech Input（语音输入）类型；
   - 按来源区分的轮次事件联合类型、统一错误码和错误判断辅助函数；
   - `getMessages()` 的包含式消息边界、游标和返回范围；
   - Scheduler 的完整 `ExecutionSpec` 和授权指纹语义；
   - 调度接口不包含 `toggle`、`fireNow` 和 `all-enabled` 输入；
   - 语音租约只包含 `commit()`、`release()` 和 `signal`。
2. 新增 Manifest Schema 生成与校验：
   - `PluginManifestInput` 作为 Schema 生成目标；
   - 生成结果提交到仓库；
   - CI 重新生成后检查工作区无差异；
   - Loader 使用同一 Schema，不维护第二份字段白名单。
3. 新增 `PluginResourceTracker` 并迁移 `context.ts`。
4. `plugin-runtime.ts` 接受宿主服务工厂，但本阶段可先注入空实现。
5. `apiVersion` 保持 1，因为只增加可选能力和字段。

主要文件：

- `src/plugins/api.ts`
- `src/plugins/types.ts`
- `src/plugins/manifest-validation.ts`
- `src/plugins/manifest.schema.json`
- `src/plugins/resources.ts`
- `src/plugins/context.ts`
- `src/plugins/loader.ts`
- `src/main/plugin-runtime.ts`
- `package.json`
- `package-lock.json`

必须测试：

- Schema 与 Loader 对同一纯数据清单给出一致结果；
- 未声明服务为 `undefined`；
- 声明但宿主未提供时注册前失败；
- 资源逆序释放、幂等释放、超时继续和激活回滚；
- 插件不能发布 `host:*`；
- TypeScript 能按 `event.source` 收窄桌面、渠道和调度事件字段；
- 消息边界能从桌面轮次事件无损传给 `getMessages()`；
- 旧插件无需修改即可加载。

建议提交：`feat: 冻结插件扩展公开契约与资源生命周期`

退出条件：后续服务只能通过新工厂注入，不再向 `PluginContext` 增加临时特例。

### 阶段 2：Secrets、Workspace（工作区）与 Conversations（会话）

目标：先交付低耦合的只读数据和密钥能力。

#### 2.1 Secrets

实现 `src/main/plugin-host/secrets-service.ts`：

- 每个插件固定使用 `plugin-data/<pluginId>/secrets/`；
- 每个 key 使用独立加密文件，文件名取 `sha256(key)`，不把 key 原样当作 Windows 文件名；写入采用临时文件加原子替换；
- Key 复用普通插件存储的正则约束；
- 哈希文件名使大小写不同的 key 保持独立，同时避开 `CON`、`PRN`、`AUX` 等 Windows 保留文件名，并允许未来扩展 key 规则；
- 值只接受字符串；
- `safeStorage.isEncryptionAvailable()` 为假时返回 `E_STORAGE_UNAVAILABLE`；
- 不写明文，不使用 XOR（异或）或自制加密回退；
- `delete()` 幂等；
- 插件停用、替换和普通卸载不自动删除密钥。

#### 2.2 Workspace

实现 `workspace-service.ts`，内部调用 `chatsStore.getWorkspaceBinding()`，对外只投影：

```ts
{ conversationId, root, displayName }
```

找不到会话或未绑定工作区返回 `null`。不提供绑定、解除绑定或目录选择接口。

#### 2.3 Conversations

实现 `conversations-service.ts`：

- `list()` 默认 20 条、最多 100 条；
- `getMessages()` 默认 50 条、最多 100 条；
- 消息按时间正序返回；
- 只返回 `user` 和 `assistant`，内部 `model` 映射为 `assistant`；
- 时间戳统一转 ISO 8601（国际日期时间格式）字符串；
- 不返回推理过程、工具参数、工具输出、缓存字段、文件路径或内部索引；
- 游标使用版本化 Base64URL（网址安全的 Base64 编码）JSON，只作为不透明分页状态，不作为安全令牌；
- 首次读取时把起止消息 ID 冻结进游标；
- 后续分页重新验证起止消息仍属于同一会话；
- 边界消息被删除或替换时返回 `E_NOT_FOUND`，不悄悄扩到最新消息；
- 列表分页不承诺跨并发编辑的完整快照，会话消息边界必须承诺冻结。

新增文件：

- `src/main/plugin-host/secrets-service.ts`
- `src/main/plugin-host/workspace-service.ts`
- `src/main/plugin-host/conversations-service.ts`
- `src/main/plugin-host/errors.ts`
- 对应的 `*.test.ts`

修改文件：

- `src/main/plugin-host/host-services.ts`
- `src/main/plugin-runtime.ts`
- `src/plugins/context.ts`

必须测试：

- 两个插件不能互读密钥；
- 大小写不同、类似 Windows 保留名的 key 均能独立往返；
- 安全存储不可用时不产生弱保护文件；
- 会话不存在、边界不存在、非法游标和超大页均返回稳定错误；
- 第一轮事件边界分页时，第二轮新增消息不会混入；
- Store 新增内部字段不会自动出现在插件对象中；
- 插件停止后的异步调用返回 `E_PLUGIN_STOPPING`。

建议提交：`feat: 开放插件密钥工作区与只读会话服务`

退出条件：长期记忆插件所需的数据读取路径已完整，但尚不依赖生命周期事件。

### 阶段 3：插件调度任务所有权

目标：复用现有调度器，同时阻止插件自行获得无人值守授权。

#### 3.1 数据模型

在内部 `ScheduledTask` 增加可选字段：

```ts
ownerPluginId?: string;
pluginUserEnabled?: boolean;
mode?: PluginPromptMode;
approvalFingerprint?: string;
```

旧任务没有这些字段，继续视为用户任务，缺少 `mode` 时归一化为 `work`。插件任务在磁盘上的 `enabled` 永远保持 `false`，新版本引擎以 `pluginUserEnabled` 表示用户是否授权运行；旧版 Cyrene 不认识新字段时只会看到停用任务，因此自动降级不需要数据迁移脚本。

统一定义 `ExecutionSpec`：

```ts
interface PluginScheduledExecutionSpec {
  schedule: ScheduleConfig;
  prompt: string;
  mode: PluginPromptMode;
  allowedToolIds: string[];
}
```

规范化时固定对象键顺序、归一化计划字段并排序去重工具 ID，再使用 Node.js 内置 `crypto` 计算 SHA-256 授权指纹。标题等展示元数据不属于执行规格。

`pluginUserEnabled`、`approvalFingerprint` 和磁盘上的兼容 `enabled` 都是宿主内部字段，不进入插件可写 Patch（补丁对象）。公开 `PluginScheduledTask.enabled` 只返回宿主计算后的有效启用状态。

插件服务执行规则：

- `createTask()` 自动写入当前 `pluginId`、`enabled: false`、`pluginUserEnabled: false`、空授权指纹和 `toolMode: "allow-list"`；
- `listTasks()` 只返回当前插件拥有的任务；
- `updateTask()` 先校验所有权；
- 标题可直接修改；
- 完整执行规格中的计划、提示词、会话模式或工具白名单发生实际变化时，强制 `pluginUserEnabled: false` 并清除授权指纹；
- 不接受 `nextFireAt`、`lastFiredAt`、`ownerPluginId`、`enabled`、`pluginUserEnabled`、`approvalFingerprint` 或 `toolMode`；
- `deleteTask()` 和 `getHistory()` 只允许访问自己的任务；
- 历史输出只保留现有摘要，不增加完整模型内容。

#### 3.2 运行条件

给 `SchedulerEngine` 注入：

```ts
canRunTask(task: ScheduledTask): boolean
```

同时新增统一的 `isTaskEnabled(task)`：用户任务读取 `enabled`；插件任务要求 `pluginUserEnabled` 为真且当前执行规格的指纹与 `approvalFingerprint` 一致。引擎中现有所有直接判断 `task.enabled` 的位置都改用该函数，不能只修改最终执行入口。

`canRunTask()` 在有效启用状态之上再检查插件是否为 `running`。定时触发和 `fireNow()` 都必须检查，防止用户界面在插件停用时误触发。

`scheduler-runner.ts` 不再把所有任务的会话模式无条件写成 `work`：旧任务和未声明模式的用户任务仍默认为 `work`；新任务把冻结的 `mode` 传给 `conversationMode`，并按现有模式到执行循环的映射生成 `executionMode`。插件不能通过该字段传入任意 Harness 配置。

插件停用不修改持久化的 `pluginUserEnabled`，引擎仅暂停执行。`PluginManager` 增加只读 `isRunning(pluginId)` 和状态变更通知；插件启停后让调度引擎重新归一化逾期时间并安排下一个计时器。重新启用插件后不补跑关闭期间任务。Scheduler IPC 对渲染层投影时，把插件任务的 `pluginUserEnabled` 映射为界面现有的启停状态，避免页面各处复制判断。

#### 3.3 用户确认

修改现有调度页面，不增加新页面：

- 卡片标出“由插件 `<id>` 创建”；
- 插件任务只显示显式工具白名单；
- 用户启用前弹出确认，列出插件 ID、计划、提示词、会话模式和工具；确认后由主进程计算并写入授权指纹；
- 用户编辑并保存插件任务视为同一次明确确认；
- 插件停用时显示“等待插件启用”，禁用立即运行按钮。

#### 3.4 卸载

`PluginManagerOptions` 增加宿主提供的 `cleanupPersistentResources(pluginId)`。只有用户执行真正卸载时调用；热重载、扫描更新、启停和安装替换均不调用。

若任务清理失败，插件保持停用并中止目录删除，避免留下仍可执行的孤儿任务。

主要文件：

- `src/main/scheduler/types.ts`
- `src/main/scheduler/scheduler-store.ts`
- `src/main/scheduler/scheduler-engine.ts`
- `src/main/scheduler/scheduler-ipc.ts`
- `src/main/scheduler/bootstrap.ts`
- `src/main/plugin-host/scheduler-service.ts`
- `src/plugins/manager.ts`
- `src/renderer/settings/scheduler/types.ts`
- `src/renderer/settings/scheduler/panel.ts`

启动顺序调整：

```text
AgentRuntime
→ Channels 装配并预留内置渠道 ID
→ Scheduler 创建并 initialize
→ PluginManager 启动并注入 Scheduler 服务
→ 注册核心 IPC
→ 加载聊天页面
→ 后台阶段启动 Channels 和 Scheduler 计时器
```

必须测试：

- 插件不能读改删其他插件或用户任务；
- 插件不能创建已启用任务；
- 插件不能使用 `all-enabled`；
- 执行规格任一字段变化或授权指纹不匹配都会停用，标题变化不会；
- 旧任务缺少模式时仍按原有 `work` 行为执行；
- 插件任务的 `mode` 会进入实际运行选项，且修改模式必然撤销原授权；
- 插件停用时定时触发和手动触发都被跳过；
- 插件重新启用会重排计时器但不补跑；
- 替换插件保留任务，卸载插件删除任务；
- 旧的用户任务行为不变。

建议提交：`feat: 增加插件调度任务所有权与用户确认`

退出条件：自动化插件可创建待用户确认的任务，但不能自行授权执行。

### 阶段 4：生命周期事件

目标：提供不可拦截、不可修改结果的观察能力。

#### 4.1 事件总线

修改 `src/plugins/events.ts`：

- 普通 `emit()` 使用 Node.js `setImmediate()` 按快照顺序调度监听器，不在发布方当前调用栈直接调用第三方代码，也不等待监听器 Promise（异步结果）；选择宏任务是为了先把当前主进程 I/O（输入输出）阶段交还给事件循环；
- 每个监听器异步结果单独附加超时和错误日志；超时只能忽略迟到结果，不能终止同步死循环；
- 同一会话保证调用顺序，不保证异步完成顺序；
- 插件停止时自动退订；
- 事件不持久化、不重放；
- 宿主每次发布生成唯一 `eventId` 和 ISO 时间戳；
- 插件发出的事件继续自动限制在 `plugin:<pluginId>:*`；
- 单独保留 `emitLifecycleBarrier()` 给已有的 `plugins:ready`、`plugins:stopping`，不得让普通宿主事件误用阻塞入口。

`plugins:ready` 在启动扫描和所有已启用插件激活完成后派发，继续使用 `{ pluginIds: string[] }`；`plugins:stopping` 在任何 Context 调用 `beginStop()` 前派发，继续使用 `undefined`，并沿用现有单监听器五秒有限等待。两者已经写入现有 v1 开发文档，不能在本次兼容新增中删除，也不强行补入新事件的 `eventId` 和 `timestamp`。新文档和 Skill 应将其标记为兼容事件，推荐使用 `onDispose()` 保存插件自身状态。

#### 4.2 桌面轮次

桌面成功事件必须在最终消息落盘后发布。施工方式：

1. AG-UI（智能体用户界面协议）入口接收 run 后，内部协调器记录 `runId`、会话 ID、用户消息 ID、助手消息 ID 和开始时间；
2. 主进程收到终态时记录状态，但不立刻发布 `turn:finished`；
3. `ChatPage.tsx` 在 `checkpointRun("terminal", true)` 成功后，通过新增的内部 IPC 上报“该消息已落盘”；
4. 协调器同时拿到终态和落盘确认后只发布一次；
5. 若落盘确认从未到达，记录诊断并按 best-effort at-most-once（尽力而为、至多一次）语义放弃，不伪造消息边界。

`PendingTurnLifecycle`（待结算轮次）至少保存 `terminal`、`persistenceAck`、`createdAt`、`expiresAt` 和定时器句柄，并通过同一个 `disposeEntry(runId)` 收口。清理条件为：

- 事件已经发布；
- 终态到达后等待落盘确认超过 60 秒；
- 整体期限超过本轮运行超时加 60 秒宽限；
- 对应渲染进程销毁、重新加载或导航；
- 应用关闭。

计时器必须允许注入时钟以便测试，并调用 `unref()`，不能单独阻止主进程退出。

`host:turn:completed` 作为 v1 弃用兼容事件，仅在成功时继续使用当前 payload 和当前成功副作用之后的发布点，不强行绑定新协调器或补入消息边界；新插件使用 `host:turn:finished`。

桌面成功终态只有在最终助手消息落盘后才发布。取消、超时和运行错误中，`inputMessageId` 仍指向已落盘的用户消息；`finalMessageId` 只有收到对应助手消息的落盘确认时才存在，绝不使用会话当前最后一条助手消息代替。

#### 4.3 渠道与调度轮次

- 渠道在开始执行和取得规范终态后发布轮次事件；
- 渠道不写入桌面会话 Store 时不提供消息边界；
- 调度器发布 `turn:started`、`turn:finished`，并额外发布包含任务 ID 和历史 ID 的 `scheduler:finished`；
- 调度事件没有桌面会话时不伪造 `conversationId`。

#### 4.4 工具完成

在 Harness 内部增加只读的 `onToolFinished` 回调，放在工具结果已经确定的位置。生命周期发布器只读取：

- `toolId`；
- `toolCallId`；
- `runId`；
- 归一化状态；
- 工具注册时声明的风险；
- 耗时。

不得读取或发布参数、输出、文件变更正文和内部异常。该回调只观察，不参与权限判断、重试、提交或恢复。

主要文件：

- `src/plugins/events.ts`
- `src/main/plugin-host/lifecycle-publisher.ts`
- `src/main/agui-bridge.ts`
- `src/main/orchestrator/agent-runtime.ts`
- `src/main/orchestrator/harness/types.ts`
- `src/main/orchestrator/harness/tool-round.ts`
- `src/main/channels/bootstrap.ts`
- `src/main/scheduler/scheduler-runner.ts`
- `src/shared/ipc-channels.ts`
- `src/preload/index.ts`
- `src/renderer/react/features/chat/pages/ChatPage.tsx`

必须测试：

- 成功、取消、超时和运行错误各自只产生一个终态；
- 桌面成功事件发生在消息落盘以后；
- 下一轮消息不会进入上一轮冻结边界；
- 返回 Promise 的慢监听器不被普通事件发布路径等待；同步死循环仍可能阻塞同进程宿主，按可信插件边界处理；
- 普通事件发布函数返回时尚未在当前调用栈进入任何第三方监听器；监听器从后续调度任务开始；
- 一个监听器抛错不影响其他监听器；
- 同一会话按产生顺序调用；
- 协调器在发布、超时、渲染进程销毁和应用关闭后均不残留条目或计时器；
- 非成功终态只在真实落盘确认存在时携带 `finalMessageId`；
- 事件没有敏感正文；
- `plugins:ready` 在所有已启用插件激活后使用原有 payload 派发；
- `plugins:stopping` 在任何 `ctx.signal.abort()` 前派发并有限等待；
- `turn:completed` 旧订阅仍工作。

建议提交：`feat: 开放只读插件生命周期事件`

退出条件：长期记忆和观察插件不需要导入内部事件类型。

### 阶段 5：普通聊天语音输入租约

目标：允许插件用自己的麦克风、模型和窗口识别文本，再把最终文本送入 Cyrene 的正常聊天路径。

#### 5.1 活动目标登记

把 `chat-ui-ipc.ts` 的单个 `activeChatSessionId` 替换为 `ActiveChatTargetRegistry`，记录：

- 会话 ID；
- 会话模式；
- 上报它的 `WebContents`（网页内容进程）标识；
- 页面初始化时生成的 `rendererTargetId`（渲染目标标识）；
- 销毁和导航监听。

只有当前聊天窗口可以登记目标。渲染页面每次初始化生成新的 `rendererTargetId` 并随活动会话上报；同一页面内从会话 A 切换到 B 不改变该标识，因此不会迁移或终止已取得的 A 租约。页面重新加载、导航或 `WebContents` 销毁才使旧渲染桥失效。

#### 5.2 独占租约

`speech-input-service.ts` 在主进程维护全局唯一租约：

- `acquire()` 在一次同步临界区内检查占用、冻结目标并登记 Context 资源；
- 没有目标返回 `E_NO_ACTIVE_INPUT_TARGET`；
- 已占用返回 `E_SPEECH_INPUT_BUSY`；
- `commit()` 校验租约、被冻结的 `rendererTargetId`、会话是否仍存在、非空文本和插件状态；不校验当前 UI 是否仍显示被冻结会话；
- 同一租约的多个 `commit()` 串行执行；
- `release()` 幂等；
- 插件停用、注册回滚、目标销毁和应用退出进入同一释放路径。

#### 5.3 文本提交桥

新增一对仅供 Cyrene 自己的主进程与预加载层使用的 IPC：

```text
speech-input:commit-request
speech-input:commit-result
```

插件不能直接拿到该 IPC 名称；它只调用租约的 `commit()`。

请求携带 `requestId`、被冻结的 `rendererTargetId`、会话 ID、模式和文本，响应必须回显 `requestId` 与 `rendererTargetId`。主进程忽略旧页面或错误目标返回的迟到响应。

`ChatPage.tsx` 把现有发送逻辑抽出为“向指定会话提交文本”：

- 使用租约冻结的会话和模式，不重新读取当前页面；
- 复用用户消息落盘、运行队列和 Agent 调用；
- 当前会话忙时进入同一消息队列；
- 外部语音提交不清空用户正在编辑的草稿、附件和输入框状态；
- `commit()` 在用户消息已接受并落盘后返回，不等待模型完整回答；
- 会话已删除或目标窗口已失效时返回稳定错误。

主要文件：

- `src/main/plugin-host/active-chat-target.ts`
- `src/main/plugin-host/speech-input-service.ts`
- `src/main/chats/chat-ui-ipc.ts`
- `src/shared/ipc-channels.ts`
- `src/preload/index.ts`
- `src/renderer/react/features/chat/pages/chat-page-bridge.ts`
- `src/renderer/react/features/chat/pages/ChatPage.tsx`

必须测试：

- 两个插件争抢租约只有一个成功；
- A 会话取得租约后切到 B，文本仍提交到 A；
- A 被删除、页面重新加载、导航或窗口销毁后租约中止；
- 仅切换活动会话不会改变 `rendererTargetId`；
- 重复 `release()` 无副作用；
- 插件停止和注册失败回滚均释放；
- 外部提交不影响现有草稿和附件；
- 会话忙时按现有队列顺序执行。

建议提交：`feat: 增加插件语音输入租约与聊天提交桥`

退出条件：不接通通话窗口时，本地 ASR 插件已经能服务普通聊天。

### 阶段 6：活动通话语音输入

目标：让同一语音租约选择 `active-call`，只替换通话中的 ASR 输入，不替换模型和 TTS。

先重构 `call-manager.ts`，把当前 `endTurn()` 拆为：

```text
停止并收集内置 ASR 文本
→ validateFinalTranscript
→ processFinalTranscript
→ Agent
→ TTS
→ 返回 LISTENING
```

外部插件只进入 `processFinalTranscript` 之前的文本入口。

新增内部状态：

- `inputOwner: "builtin" | "external"`；
- 单调递增的 `callGeneration`；
- 当前外部租约标识；
- 通话目标关闭通知。

行为：

- 取得 `active-call` 租约时停止当前内置 ASR 流并冻结 `callGeneration`；
- 外部持有期间，通话窗口传入的音频帧被忽略；
- `commit()` 只在该通话仍存在且处于可接收文本状态时成功；
- THINKING 或 SPEAKING 状态返回目标繁忙错误，不并发开启第二轮；
- TTS 播放结束后仍保持外部输入所有权，不自动重启内置 ASR；
- 释放租约时，如果同一通话仍有效且此前内置 ASR 开启，则恢复它；
- 通话结束会立即中止租约，之后不允许提交到下一次通话；
- 应用进程崩溃无需持久化恢复，重启后状态自然回到默认值。

主要文件：

- `src/main/call/call-manager.ts`
- `src/main/call/call-manager.test.ts`
- `src/main/plugin-host/speech-input-service.ts`
- `src/main/plugin-host/speech-input-service.test.ts`

必须测试：

- 取得租约会停止内置 ASR；
- 外部文本进入现有 Agent 和 TTS 流程；
- 外部持有期间不会重复启动内置 ASR；
- 通话结束、插件停用和主动释放都能正确收口；
- 新通话不能复用旧租约；
- 错误恢复不会同时存在两个 ASR 输入源。

建议提交：`feat: 接通插件语音输入与活动通话`

退出条件：普通聊天和活动通话两种目标都满足租约契约。

### 阶段 7：SDK、示例、Skill（技能）与发布

目标：让外部开发者不阅读宿主源码也能完成插件。

#### 7.1 SDK 包

建立 `packages/plugin-sdk`：

- 包名 `@cyrene/plugin-sdk`；
- 同时输出 ESM 和 CJS；
- 导出公开类型、版本常量、能力常量、Manifest 校验入口；
- `testing` 子路径导出 `createMockPluginContext()` 和契约断言；
- 不包含 Electron、React、宿主运行时和模型依赖；
- 插件编译时依赖 SDK，最终插件产物不要求终端用户再次安装 SDK。

根 `package.json` 增加：

```text
build:plugin-sdk
check:plugin-sdk
test:plugin-examples
```

`verify-package.mjs` 执行：

- 重新生成 Schema 并检查无漂移；
- `npm pack --dry-run` 检查包内容；
- 从打包产物而不是源码编译示例；
- 检查导出中不存在 `src/main`、`src/renderer` 或内部 Store 路径。

#### 7.2 示例插件

| 示例 | 覆盖能力 | 不包含 |
| --- | --- | --- |
| `weather-tool` | 联网、工具、普通存储、Secrets | 第三方平台真实密钥 |
| `long-term-memory` | 轮次事件、冻结分页、LLM、Prompt Provider | 用户画像业务规则 |
| `scheduled-automation` | 创建、列出、更新、删除自有任务 | 绕过用户启用和全部工具模式 |
| `local-asr-contract` | 自有窗口、IPC、语音租约、提交和释放 | 模型文件、Python、ONNX Runtime（开放神经网络交换格式运行时）和下载器 |

本地 ASR 示例只使用模拟文本验证宿主契约。真正的 FunASR、sherpa-onnx、GPU（图形处理器）适配和模型分发由插件仓库维护，不进入 Cyrene 核心包。

#### 7.3 文档与 Skill

更新：

- `docs/plugins/plugin-dev-guide.md`
- `docs/plugins/plugin-authoring.md`
- `skills/cyrene-plugin-dev/SKILL.md`
- `skills/cyrene-plugin-dev/references/getting-started.md`
- `skills/cyrene-plugin-dev/references/api-spec.md`
- `skills/cyrene-plugin-dev/references/example-walkthrough.md`

Skill 只引用 SDK 公开清单，不复制整份 API。生成插件时必须：

- 选择最小 `deps`；
- 默认 `defaultEnabled: false`；
- 使用 SDK 类型；
- 检查内部路径导入；
- 提醒开发者工具 `risk` 是自我声明，不是宿主验证后的安全结论；
- 对明显的副作用与 `risk` 不匹配进行静态提示，但不宣称能够证明插件真实行为；
- 运行 Mock Context（模拟上下文）测试；
- 输出可安装目录或 ZIP（压缩包）文件。

官方插件仓库的收录流程再通过静态分析和人工代码审查检查风险声明、内部导入及危险安装脚本。该审核属于官方收录标准，不改变任意来源插件由用户自行承担风险的产品边界。

#### 7.4 发布工作流

新增 `.github/workflows/plugin-sdk.yml`：

- Pull Request（合并请求）阶段只构建、打包和测试；
- `plugin-sdk-v*` 标签触发 npm 发布；
- 优先使用 npm Trusted Publishing（可信发布）；仓库未配置时使用最小权限的 `NPM_TOKEN`；
- 版本号由 `packages/plugin-sdk/package.json` 独立维护；
- 发布凭据属于仓库外配置，不写入代码或文档示例。

建议提交：`feat: 发布插件开发包示例与开发 Skill`

退出条件：一个仓库外的空项目只安装打包后的 SDK 即可编译四个示例。

## 8. 测试矩阵

### 8.1 单元测试

| 范围 | 重点 |
| --- | --- |
| Manifest | Schema、版本、依赖、入口和符号链接边界 |
| Context | 依赖注入、资源归属、逆序清理、回滚和超时 |
| Secrets | 加解密、不可用状态、命名空间、原子写和删除 |
| Workspace | 空绑定、稳定投影、停止后调用 |
| Conversations | 分页、冻结边界、角色映射、字段过滤和非法游标 |
| Scheduler | 所有权、待启用、白名单、暂停、卸载和旧数据兼容 |
| Events | 四种终态、顺序、慢监听器、异常隔离和数据最小化 |
| Speech Input | 独占、目标冻结、释放、窗口关闭、通话代次和 ASR 恢复 |
| SDK | 类型、Schema、Mock Context、CJS/ESM 和包内容 |

### 8.2 集成测试

至少增加四条端到端宿主测试：

1. 长期记忆：完成一轮 → 收到边界 → 分页读取 → 下一轮不会串入；
2. 自动化：插件创建任务 → 用户启用 → 执行 → 插件停用后跳过 → 卸载删除；
3. 普通聊天 ASR：租约提交 → 用户消息落盘 → 走现有 Agent 路径；
4. 通话 ASR：暂停内置 ASR → 外部提交 → 走现有 Agent/TTS → 释放恢复。

### 8.3 每阶段验证命令

```powershell
npm run build:main
npx vitest run --maxWorkers=1 src/plugins
npx vitest run --maxWorkers=1 src/main/plugin-host src/main/scheduler src/main/call
npx vitest run --maxWorkers=1 src/main/orchestrator src/main/channels src/main/chats
npm run check:plugin-sdk
npm run test:plugin-examples
npm test
npm run build
git diff --check
```

`check:plugin-sdk` 在阶段 7 之前不存在，前面阶段跳过即可。每个阶段先跑定向测试，合并前再跑全量测试和完整构建。

## 9. 提交与合并顺序

建议保持以下八个可审查提交，不把全部改动压成一个超大提交：

1. `test: 冻结插件系统扩展前基线`
2. `feat: 冻结插件扩展公开契约与资源生命周期`
3. `feat: 开放插件密钥工作区与只读会话服务`
4. `feat: 增加插件调度任务所有权与用户确认`
5. `feat: 开放只读插件生命周期事件`
6. `feat: 增加插件语音输入租约与聊天提交桥`
7. `feat: 接通插件语音输入与活动通话`
8. `feat: 发布插件开发包示例与开发 Skill`

实现中的代码注释使用中文；公开类型中的注释同时考虑外部开发者可读性。提交说明遵守 Conventional Commits（约定式提交）的 ASCII（ASCII 字符）冒号，同时保持中文正文，例如 `fix: 修复插件停用后语音租约未释放`。

阶段 1–4 完成后即可发布不含语音接管的预览版。阶段 5 可单独发布普通聊天 ASR；阶段 6 再开放活动通话目标。这样语音复杂度不会阻塞其他插件能力。

## 10. 兼容与迁移

- `apiVersion` 保持 1；新增能力均为可选依赖；
- `host:turn:completed` 在 v1 内保留，并标记弃用；
- 旧 `scheduled-tasks.json` 没有 `ownerPluginId` 时按用户任务读取；插件任务始终落盘为 `enabled: false`，旧版忽略 `pluginUserEnabled` 后仍保持停用；
- 不迁移、不删除现有插件普通存储；
- Secrets 是新目录，没有旧数据迁移；
- SDK 版本独立于应用版本；
- 应用版本回滚且用户不编辑任务时，旧版本会忽略 `ownerPluginId`、`pluginUserEnabled` 和授权指纹，但仍读取到 `enabled: false`，因此不会自动执行插件任务；
- 旧版界面不认识插件任务边界，用户仍可能手动把它当普通任务启用或改为 `all-enabled`。这是用户在旧版中的主动操作，不属于插件自行绕过；本设计不为该回滚边缘情况另建存储系统；
- 再次升级后，宿主必须把插件任务的旧 `enabled: true` 归一化回 `false`，并在执行规格与授权指纹不匹配时清除 `pluginUserEnabled`，要求用户重新确认。

## 11. 可观测性与故障处理

宿主日志统一使用：

```text
[plugin:<id>]
[plugin-host:events]
[plugin-host:scheduler]
[plugin-host:speech-input]
```

日志允许记录插件 ID、事件 ID、任务 ID、租约 ID、错误码和耗时；不得记录密钥、完整提示词、消息正文、工具参数和工具输出。

事件和语音 IPC 请求都使用唯一请求 ID。诊断信息只用于关联，不提供 exactly-once（严格一次）承诺。

插件抛出未捕获同步异常仍可能影响同进程宿主，这是已接受的信任模型限制。本次施工只确保框架捕获的注册、回调和清理异常不会阻断其他插件的框架流程，不宣称形成安全隔离或崩溃隔离。

## 12. 工作量与维护面

按照当前代码结构，完整实施仍按架构文档估算为 12–18 人日，其中活动通话接入是波动最大的部分。可以拆成：

| 里程碑 | 预计投入 | 可交付能力 |
| --- | ---: | --- |
| 阶段 0–2 | 4–5 人日 | SDK 契约底座、密钥、工作区、会话读取 |
| 阶段 3–4 | 3–5 人日 | 安全的插件调度与观察事件 |
| 阶段 5 | 2–3 人日 | 普通聊天外部 ASR |
| 阶段 6 | 2–3 人日 | 活动通话外部 ASR |
| 阶段 7 | 1–2 人日 | SDK 发布、示例、文档和 Skill |

长期维护面被限制在：

- 一份公开类型源；
- 一份自动生成 Schema；
- 五个宿主服务适配器；
- 一个生命周期发布器；
- 一个语音租约协调器；
- SDK 契约和示例测试。

Cyrene 更新会话 Store、Scheduler、Harness、React 页面或通话状态机时，只需要修对应适配器和契约测试。第三方插件不应随这些内部重构同步修改。只要不继续增加 UI 插槽、可变 Harness 钩子、通用下载器或独立权限组合系统，维护成本不会形成两个并行核心系统。

## 13. 完成定义

全部阶段完成必须同时满足：

1. 外部插件仅依赖 SDK 即可编译；
2. 示例和 Skill 不导入内部路径；
3. 未声明的能力不会注入；
4. 会话读取有稳定投影，桌面轮次事件边界可以直接传给正式分页接口；
5. 插件任务不能自行启用、立即运行或选择全部工具，完整执行规格必须匹配用户确认时的授权指纹；
6. 普通生命周期事件按来源提供可辨识联合类型，发布路径不直接调用或等待第三方监听器，也不能修改结果；已有插件生命周期屏障维持 v1 语义；
7. 桌面成功事件只在最终消息落盘后发布，待结算记录在所有结束路径均被清理；
8. 语音目标在取得租约时冻结；切换会话不使其漂移，原渲染桥失效会中止租约；
9. 普通聊天提交不破坏用户草稿和附件；
10. 通话租约释放后只恢复原先存在的内置 ASR 状态；
11. 插件停用、激活失败和卸载不存在可执行孤儿资源；
12. Secrets 使用哈希文件名并在 Windows 文件名边界下正确工作；
13. SDK Schema、宿主 Loader、文档和 Skill 通过自动漂移检查；
14. 定向测试、全量测试、完整构建和 `git diff --check` 全部通过。

满足以上条件后，才把 `secrets`、`workspace`、`conversations`、`scheduler` 和 `speech-input` 标记为稳定 v1 能力。
