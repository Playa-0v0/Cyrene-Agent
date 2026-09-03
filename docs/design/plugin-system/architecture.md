# Cyrene 插件系统扩展架构设计

> **日期**：2026-09-02
> **状态**：架构草案
> **范围**：可信本地插件的公开能力、宿主适配层、开发包、生命周期与兼容策略
> **结论先行**：继续采用同进程可信插件模型，只开放稳定、强类型的能力适配层；插件可以完成工具、渠道、知识库、长期记忆、自动化、自有界面和受控的语音输入接管，但不能接管权限策略、Agent Loop（智能体循环）或 CyreneHarness 内部实现。

---

## 1. 背景

Cyrene 当前已经具备 Plugin API（插件应用程序编程接口）v1，插件可以：

- 注册工具；
- 注册渠道适配器；
- 注册动态提示词贡献；
- 使用插件私有存储；
- 注册私有 IPC（进程间通信）；
- 订阅和发布插件事件；
- 调用宿主 LLM（大语言模型）；
- 通过可选的 `open()` 入口打开插件自有界面。

插件运行在 Electron Main Process（Electron 主进程），拥有完整 Node.js（JavaScript 服务端运行时）能力。当前 manifest（插件清单）中的 `deps` 是宿主服务依赖声明，不是操作系统权限或安全沙箱。

> **边界声明**：本设计中的“不能”“只允许”“隔离”除特别说明外，均指公开 Plugin API 的稳定契约约束，而非针对恶意代码的安全隔离。可信同进程插件可以直接使用 Node.js 绕过公开 API；宿主不试图在本设计中阻止这种行为。若未来需要建立不可绕过的权限边界，必须另行采用独立进程或 Sandbox（沙箱）模型。

本轮扩展的核心目标不是建设新的权限系统，而是在不暴露 CyreneHarness 和 `src/main/**` 内部对象的前提下，为第三方插件补齐稳定的宿主能力。

## 2. 已确认的产品边界

### 2.1 对外开放的能力

| 编号 | 插件类型 | 对外能力边界 |
| --- | --- | --- |
| 1 | 天气、汇率、搜索 | 联网、注册只读工具、写入插件私有缓存 |
| 2 | Todoist（任务管理服务）、邮件、智能家居 | 保存第三方密钥，注册具有外部副作用的工具，执行结果仍走宿主工具语义 |
| 3 | 本地知识库 | 读取插件或用户选择的目录、检索文件、向对话追加动态上下文 |
| 4 | Git（分布式版本控制系统）代码助手 | 注册读文件、写文件和命令工具；通过公开工具接口发起的调用按插件声明的风险等级进入现有审批链 |
| 5 | 长期记忆 | 只读、分页读取会话；监听轮次完成；记忆存入插件私有存储；通过提示词 Provider（提供器）影响后续回答 |
| 6 | 自定义界面 | 插件自行决定窗口、网页、托盘或其他呈现方式；宿主不提供页面插槽和 React（前端组件框架）组件注入能力 |
| 7 | 自动化 | 通过插件调度接口创建 Cyrene 定时任务，由现有调度器运行完整模型与工具循环 |
| 8 | Harness 观察 | 订阅只读、异步、通知型生命周期事件；不能修改参数、结果、审批或控制流 |

### 2.2 公开 API 明确不开放的能力

下列能力不进入公开插件接口：

- 修改工具风险等级；
- 自动批准、拒绝或绕过宿主审批；
- 替换 Agent Loop；
- 替换 CyreneHarness；
- 修改重试、压缩、恢复或终态结算语义；
- 获取 Harness 实例、内部 Store（存储对象）或应用依赖容器；
- 通过公开接口覆盖核心函数；
- 修改宿主规则、工具返回值或模型可见的真实执行结果。

第三方代码在同进程运行，技术上仍可能直接使用 Node.js 或导入可解析的内部文件；这类行为不属于稳定 API，不提供兼容保证，也不进入官方插件仓库的收录范围。这里描述的是公开接口边界，不构成对恶意插件的技术阻断保证。

### 2.3 人格定制不属于插件权限

人格继续通过 `prompts` 文件完成：

- `soul.md`：聊天完整人格；
- `cyrene_harness.md`：非 Chat（聊天）模式中 Harness 每轮携带的精简运行时人格；
- `chat_identity.md`、`work_identity.md`、`learn_identity.md`、`code_identity.md`：模式身份；
- `styles/**`：表达风格。

安装版优先读取 `userData/prompts/` 下的同名文件。人格文件覆盖不需要新增插件接口，也不要求插件访问 Harness。

### 2.4 语音输入插件的补充边界

本地 ASR（自动语音识别）以及第三方语音输入服务采用“插件完全自管、宿主只接收文本”的模式：

- 插件自行负责模型、推理运行时、后台服务、麦克风采集、配置和窗口；
- Cyrene 不托管插件的设置页，不把插件专用字段写入通用设置结构；
- 插件通过 `speechInput` 服务临时接管语音输入，并提交最终文本；
- 接管期间仅暂停当前内置 ASR 会话，不修改用户保存的 ASR 配置；
- 最终文本通过正常用户输入入口进入会话或通话流程，插件不得直接写入聊天 Store（存储对象）；
- 插件释放、停用、逻辑异常、加载回滚或被宿主回收时，宿主自动恢复原有语音输入能力；
- 同一时刻只允许一个插件持有语音输入权。

该能力是受控的输入入口，不是 Harness 钩子。第一阶段不向插件提供 Cyrene 采集到的原始音频帧，也不建设通用 TTS（文本转语音）提供器系统；插件若需要本地 ASR，应自行采集麦克风并管理相关资源。

## 3. 设计目标

1. 公开 API 的能力边界与恶意代码安全边界明确分离；本阶段只承诺前者。
2. 插件只依赖公开类型，不依赖 `src/main/**`。
3. 宿主内部模块可以重构，而不要求第三方插件同步修改。
4. 新能力优先复用现有 Store、调度器、审批链和事件总线。
5. 每项宿主能力具有独立、最小、强类型的接口。
6. 插件只能通过公开 API 操作自身注册或创建的资源。
7. 插件监听器失败、超时或退出不能阻塞宿主主流程。
8. SDK（软件开发工具包）、开发 Skill（技能）和运行时接口使用同一份公开契约。
9. 第一阶段不建设界面插槽、权限组合、独立插件进程或通用 OAuth（第三方授权登录协议）框架。

## 4. 非目标

本设计不负责：

- 提供安全沙箱；
- 隔离恶意插件；
- 审核第三方插件代码；
- 托管插件界面；
- 为每个第三方服务实现登录流程；
- 让插件修改宿主会话、审批策略和 Harness 流程；
- 保证直接导入内部文件的插件跨版本可用。

## 5. 总体架构

```text
第三方插件
  │
  │ 开发期依赖 @cyrene/plugin-sdk
  ▼
PluginManager
  ├─ 校验 manifest / apiVersion / deps
  ├─ 加载插件入口
  ├─ 创建插件专属 PluginContext
  ├─ 管理启动、停止、刷新和卸载
  └─ 统一回收插件注册资源
        │
        ├─ 贡献型接口
        │   ├─ registerTool
        │   ├─ registerChannelAdapter
        │   ├─ registerPromptProvider
        │   ├─ events
        │   ├─ storage
        │   ├─ IPC
        │   └─ open
        │
        └─ 宿主服务 ctx.deps
            ├─ llm
            ├─ channels
            ├─ secrets
            ├─ workspace
            ├─ conversations
            ├─ scheduler
            └─ speechInput
                    │
                    ▼
              插件宿主适配层
                    │
          ┌─────────┼──────────┬────────────┐
          ▼         ▼          ▼            ▼
      chatsStore  scheduler  safeStorage  workspace binding
                    │
                    ▼
             AgentRuntime / CyreneHarness
```

### 5.1 公开接口层

`src/plugins/api.ts` 继续作为公开类型的唯一来源。该文件不得导入 `src/main/**` 或 `src/shared/**` 中不稳定的内部类型。

公开接口只描述：

- 插件能够做什么；
- 输入和输出的稳定数据结构；
- 错误语义；
- 资源归属和生命周期。

公开接口不描述宿主如何存储、调度或执行这些能力。

### 5.2 Context 工厂

`createContext()` 仍是 PluginContext（插件上下文）与宿主之间的唯一装配边界。它负责：

- 根据 `manifest.deps` 注入服务；
- 自动绑定 `pluginId`；
- 检查资源归属；
- 登记清理动作；
- 在插件停用时触发取消；
- 将公开 DTO（数据传输对象）转换为内部类型。

### 5.3 宿主适配层

每个新宿主服务对应一个小型适配器。适配器只调用现有成熟模块，不重复实现底层能力：

| 公开服务 | 复用模块 | 适配器职责 |
| --- | --- | --- |
| `secrets` | Electron `safeStorage`、现有 TokenVault 思路 | 插件命名空间、字符串加解密、错误归一化 |
| `workspace` | chats workspace binding | 返回稳定的只读工作区描述 |
| `conversations` | `chatsStore` 分页接口 | 只读投影、分页、字段裁剪 |
| `scheduler` | scheduler store、engine、AgentRuntime | 插件任务归属、输入转换、生命周期联动 |
| `events` | plugin event bus、AgentRuntime、工具执行边界 | 事件投影、异步旁路、稳定元数据 |
| `speechInput` | 现有聊天提交入口、call manager、ASR 会话生命周期 | 独占接管、文本提交、异常释放、恢复原 ASR |

### 5.4 公开能力分类

每项新增插件接口必须归入以下三类之一：

| 类别 | 含义 | 当前例子 |
| --- | --- | --- |
| Contribution（贡献） | 插件向宿主注册可调用或可发现的扩展 | Tool、Prompt Provider、Channel Adapter、`open()` |
| Capability（宿主能力） | 宿主向插件提供的窄接口服务 | LLM、Conversations、Scheduler、Secrets、Workspace、Speech Input |
| Observation（观察） | 插件异步接收只读的宿主状态通知 | `host:*` 生命周期事件 |

若一项能力不属于以上任何类别，或者要求修改审批结果、Harness 参数、工具结果或 Agent Loop，原则上不进入公开 Plugin API。

## 6. Manifest 依赖声明

`PluginCapability` 扩展为：

```ts
type PluginCapability =
  | "channels"
  | "llm"
  | "secrets"
  | "workspace"
  | "conversations"
  | "scheduler"
  | "speech-input";
```

示例：

```json
{
  "apiVersion": 1,
  "id": "memory-assistant",
  "name": "Memory Assistant",
  "version": "1.0.0",
  "description": "从历史会话提取长期记忆",
  "author": "example",
  "entry": "index.cjs",
  "defaultEnabled": false,
  "deps": ["conversations", "scheduler", "llm"]
}
```

规则：

- `deps` 表示宿主必须注入的服务，不表示安全权限；
- 未声明的服务不出现在 `ctx.deps`；
- 宿主不支持声明的服务时，插件在执行 `register()` 前失败；
- 未知依赖继续视为 manifest 错误，不静默忽略；
- 新增可选依赖属于兼容性新增，不要求立即升级 `apiVersion`。
- `speech-input` 只表示插件需要向宿主提交语音识别文本，不表示宿主向插件提供麦克风音频。

第一阶段不增加 `ctx.host` 能力查询。插件的硬依赖继续通过 `deps` 在注册前校验；未来确有可选能力探测需求时，可以兼容性新增只读的 `ctx.host.apiVersion` 和 `ctx.host.capabilities`，但不作为 v1 实施前置条件。

## 7. 宿主服务接口

以下接口用于确定职责和数据边界，最终字段名可在实现计划中做机械性调整。

### 7.1 Secrets

```ts
interface PluginSecretsService {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}
```

约束：

- Key 复用插件私有存储的命名规则；
- 磁盘文件名使用 `sha256(key)`，不直接使用 key，避免 Windows 大小写折叠和保留文件名问题；
- 磁盘键自动包含 `pluginId`，插件不能读取其他插件密钥；
- 第一阶段只保存字符串，不设计复杂凭据对象；
- 优先复用 Electron `safeStorage`；
- 安全存储不可用时必须返回明确状态，不把降级后的弱保护描述成安全加密；
- 插件卸载默认保留密钥，彻底清理需要用户明确操作。

### 7.2 Workspace

```ts
interface PluginWorkspaceService {
  getBinding(conversationId: string): Promise<PluginWorkspaceBinding | null>;
}

interface PluginWorkspaceBinding {
  conversationId: string;
  root: string;
  displayName: string;
}
```

约束：

- 仅暴露会话已绑定的工作区；
- 不开放宿主绑定写接口；
- 插件需要其他目录时，自行通过 Electron 或自有界面让用户选择；
- 工具执行时仍使用 `PluginToolContext.resolvedWorkspaceRoot` 作为当前轮冻结值。

### 7.3 Conversations

```ts
interface PluginConversationsService {
  list(input?: PluginConversationListInput): Promise<PluginConversationPage>;
  getMessages(input: PluginMessagePageInput): Promise<PluginMessagePage>;
}

interface PluginMessagePageInput {
  conversationId: string;
  cursor?: string;
  limit?: number;
  /** 可选的包含式起点；与 throughMessageId 一起冻结读取范围。 */
  fromMessageId?: string;
  /** 可选的包含式终点；分页过程中不得越过该消息。 */
  throughMessageId?: string;
}

interface PluginMessagePage {
  items: PluginConversationMessage[];
  nextCursor?: string;
  /** 本次分页实际冻结的包含式边界。 */
  range: {
    fromMessageId?: string;
    throughMessageId?: string;
  };
}
```

稳定投影只包含插件真正需要的字段：

```ts
interface PluginConversationSummary {
  id: string;
  title: string;
  mode: PluginPromptMode;
  createdAt: string;
  updatedAt: string;
}

interface PluginConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}
```

约束：

- 只读；
- 所有列表必须分页并设置最大页大小；
- `fromMessageId` 和 `throughMessageId` 都是包含式边界；长期记忆插件应直接把桌面 `turn:finished` 事件中的 `inputMessageId`、`finalMessageId` 传入这两个字段；
- 第一次调用未指定边界时，宿主把调用当时的首尾消息冻结到返回的 `range` 和后续游标；
- 后续页使用 `cursor` 自带的冻结边界；同时传入显式边界时必须与游标完全一致，否则返回 `E_INVALID_ARGUMENT`；
- 消息边界不存在或不属于指定会话时返回明确错误，不回退到读取当前最新消息；
- 不暴露磁盘路径、内部索引、模型请求原文和缓存字段；
- 不开放替换、删除、重命名或追加宿主消息；
- 长期记忆写入插件私有存储；
- 影响后续回答时使用 `registerPromptProvider()`。

### 7.4 Scheduler

```ts
type PluginScheduleConfig =
  | { kind: "once"; runAt: string }
  | { kind: "daily"; timeOfDay: string }
  | { kind: "weekly"; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; timeOfDay: string }
  | { kind: "interval"; every: number; unit: "minutes" | "hours" };

interface PluginScheduledExecutionSpec {
  schedule: PluginScheduleConfig;
  prompt: string;
  mode: PluginPromptMode;
  allowedToolIds: string[];
}

interface PluginScheduledTaskInput extends PluginScheduledExecutionSpec {
  title: string;
}

interface PluginScheduledTaskPatch {
  title?: string;
  schedule?: PluginScheduleConfig;
  prompt?: string;
  mode?: PluginPromptMode;
  allowedToolIds?: string[];
}

interface PluginScheduledTask extends PluginScheduledTaskInput {
  id: string;
  /** 宿主计算后的有效启用状态；插件不能写入。 */
  enabled: boolean;
  nextFireAt: string | null;
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface PluginSchedulerService {
  createTask(input: PluginScheduledTaskInput): Promise<PluginScheduledTask>;
  listTasks(): Promise<PluginScheduledTask[]>;
  updateTask(id: string, patch: PluginScheduledTaskPatch): Promise<PluginScheduledTask>;
  deleteTask(id: string): Promise<boolean>;
  getHistory(id: string, limit?: number): Promise<PluginScheduledTaskHistory[]>;
}
```

任务输入复用现有调度语义：

- 一次性、每日、每周和间隔计划；
- 提示词；
- Conversation Mode（会话模式）；
- 工具白名单。

约束：

- 宿主自动记录 `ownerPluginId`；
- 插件只能查看和修改自己创建的任务；
- 到期后由现有 Scheduler Engine（调度引擎）和 AgentRuntime 执行；
- 插件不能传入 Harness 配置、审批策略或内部恢复状态；
- 现有 Scheduler 在工具白名单过滤后以 `permissionMode: "allow_all"` 无人值守执行，因此插件新建的任务必须固定为停用状态，且只能使用显式工具白名单；内部持久化时保留 `enabled: false`，另用只允许宿主界面写入的用户授权字段表示插件任务是否启用，确保旧版 Cyrene 降级默认读取时不会自动执行；旧版界面中的用户主动编辑不受新版本插件边界保证；
- 插件接口不提供启用、立即运行或切换到 `all-enabled` 的能力；用户必须在宿主现有调度页面核对完整 `ExecutionSpec`（执行规格）后主动启用，启用动作即表示对该执行规格的一次明确授权；
- 宿主对规范化后的 `ExecutionSpec` 计算 `approvalFingerprint`（授权指纹）；执行前指纹必须仍与用户确认时一致，否则拒绝运行；
- 插件修改已启用任务的计划、提示词、会话模式或工具白名单时，必须清除授权指纹并自动停用，等待用户重新核对；只有标题等不影响执行的元数据可以直接更新；
- 未来新增模型、工作区或执行目标等会影响行为的字段时，必须先加入 `ExecutionSpec`，不能在各调用点继续手写零散字段比较；
- 插件不得通过创建或更新调度任务，把原本需要用户确认的配置转换为自行授权；若宿主未来改变无人值守审批语义，也必须由用户通过宿主配置明确授予，而不是由插件声明；
- 插件停用时任务保留但暂停执行；
- 插件重新启用时按现有逾期归一化规则计算下一次时间，不补跑历史任务；
- 插件卸载时删除其定时任务，避免遗留仍会产生外部副作用的孤儿任务；
- 任务历史可以保留为诊断记录，但不得继续关联可执行入口。

### 7.5 Speech Input

语音输入使用 Lease（租约）表示临时且独占的输入所有权。插件不能直接切换全局 ASR 开关：

```ts
type PluginSpeechInputTarget = "active-chat" | "active-call";

interface PluginSpeechInputAcquireOptions {
  /** 插件内稳定的来源标识，例如 funasr-local。 */
  source: string;
  target: PluginSpeechInputTarget;
}

interface PluginSpeechInputLease {
  readonly id: string;
  /** 插件停止、目标关闭或宿主回收租约时触发。 */
  readonly signal: AbortSignal;

  /** 作为一次正常用户输入提交最终识别文本。 */
  commit(text: string): Promise<void>;

  /** 幂等释放；释放后恢复接管前的内置 ASR 状态。 */
  release(): Promise<void>;
}

interface PluginSpeechInputService {
  acquire(options: PluginSpeechInputAcquireOptions): Promise<PluginSpeechInputLease>;
}
```

约束：

- `acquire()`、暂停内置 ASR 和建立租约必须是一个原子操作；
- `acquire()` 时把 `active-chat` 或 `active-call` 解析为内部固定目标，`commit()` 不重新读取当前活动目标；
- 普通聊天租约冻结会话 ID、模式、承载它的渲染进程和 `rendererTargetId`（渲染目标标识）；该标识在聊天页面每次初始化时生成，表示原渲染桥实例是否仍存在，不表示当前 UI 正在显示哪个会话；
- 用户从会话 A 切换到 B 不会迁移或终止租约，后续 `commit()` 仍提交到 A；渲染进程销毁、页面重新加载或导航、A 会话被删除时才使租约失效；
- 被冻结的会话、渲染桥或通话关闭时触发 `lease.signal.abort()`，后续 `commit()` 返回 `E_NO_ACTIVE_INPUT_TARGET`；
- 同一时间只有一个有效租约，后续申请返回 `E_SPEECH_INPUT_BUSY`；
- `commit()` 复用现有聊天或通话输入入口，不允许插件构造 Harness 请求；
- 空文本、租约失效或目标已关闭时拒绝提交；
- `release()`、`ctx.signal.abort()`、插件停用和加载回滚都进入同一清理路径；
- 插件不得通过该接口修改 TTS、审批、工具或 Agent Loop；
- 插件持有租约时，模型推理、本地服务、端口、日志和 CPU（中央处理器）/GPU（图形处理器）兼容均由插件负责。

第一阶段不提供临时字幕投影接口。识别中的部分文本由插件显示在自有窗口；Cyrene 不为此新增输入框、通话字幕或 Overlay（覆盖层）接口。

对于本地模型，优先复用 FunASR、sherpa-onnx 或 ONNX Runtime（开放神经网络交换格式运行时）等成熟实现。Cyrene 不自行实现推理运行时，也不为单个插件建设通用模型下载器；插件可以使用自己的私有数据目录完成下载、校验、更新和删除。

## 8. 生命周期事件

### 8.1 事件范围

第一阶段开放：

```text
host:turn:started
host:turn:finished
host:tool:finished
host:scheduler:finished
host:plugins:ready
host:plugins:stopping
```

现有 `host:turn:completed` 在 v1 内作为弃用兼容别名保留，只在成功终态并完成既有成功副作用后发布；新插件使用 `host:turn:finished`。其旧 payload 不强行增加新字段。

`host:plugins:ready` 和 `host:plugins:stopping` 已存在于 v1 开发文档，继续作为兼容性生命周期屏障事件保留：`ready` 在启动扫描及所有启用插件激活完成后触发，payload 维持 `{ pluginIds: string[] }`；`stopping` 在任何插件执行 `ctx.signal.abort()` 之前触发，payload 维持 `undefined`，并沿用有限等待语义。它们不强行补入新事件的 `eventId` 和 `timestamp`，避免改变旧插件判断。新插件不应依赖 `stopping` 保存关键状态，应优先使用 `onDispose()`；这两个事件可在未来 v2 移除或统一。

其中 `turn:finished` 使用统一终态：

```ts
type PluginTurnStatus = "success" | "cancelled" | "timeout" | "runtime_error";
```

### 8.2 事件载荷

事件只携带稳定元数据：

```ts
interface PluginHostEventBase {
  eventId: string;
  timestamp: string;
}

interface PluginTurnEventBase extends PluginHostEventBase {
  runId: string;
  mode: PluginPromptMode;
}

type PluginTurnStartedEvent = PluginTurnEventBase & (
  | { source: "desktop"; conversationId: string; inputMessageId: string }
  | { source: "channel"; channel: string; conversationId?: string }
  | { source: "scheduler"; taskId: string; schedulerRunId: string }
);

interface PluginTurnFinishedBase extends PluginTurnEventBase {
  status: PluginTurnStatus;
  durationMs?: number;
}

interface PluginDesktopTurnFinishedEvent extends PluginTurnFinishedBase {
  source: "desktop";
  conversationId: string;
  inputMessageId: string;
  /** 只有宿主确认本轮 assistant 消息已作为最终边界持久化后才存在。 */
  finalMessageId?: string;
}

interface PluginChannelTurnFinishedEvent extends PluginTurnFinishedBase {
  source: "channel";
  channel: string;
  conversationId?: string;
}

interface PluginSchedulerTurnFinishedEvent extends PluginTurnFinishedBase {
  source: "scheduler";
  taskId: string;
  schedulerRunId: string;
}

type PluginTurnFinishedEvent =
  | PluginDesktopTurnFinishedEvent
  | PluginChannelTurnFinishedEvent
  | PluginSchedulerTurnFinishedEvent;
```

轮次事件必须使用以 `source` 为判别字段的 Discriminated Union（可辨识联合类型），让 TypeScript 在分支中自动收窄必填字段。禁止把三种来源压成一个全部可选字段的宽对象。

工具完成事件可以包含 `toolId`、`toolCallId`、`status`、`risk` 和 `durationMs`，但不包含：

- 工具参数；
- 工具输出；
- 文件内容；
- 密钥和请求头；
- 完整提示词；
- 内部异常对象。

需要消息正文的插件只处理 `source === "desktop"` 且存在所需消息边界的轮次事件，再调用 `conversations.getMessages()`，并把事件中的 `inputMessageId` 和 `finalMessageId` 作为冻结的包含式读取边界。长期记忆插件不得在没有上界的情况下把“当前最新消息”当作本轮终点。渠道和 Scheduler 不保证把消息写入桌面会话存储。

非成功终态中，`inputMessageId` 指向已经持久化的用户消息；`finalMessageId` 只有在宿主确认某条 assistant 消息已作为本轮最终持久化边界时才存在。不得为了字段完整而查找“当前最后一条 assistant 消息”代替本轮边界。桌面成功终态只有在最终消息落盘后才发布；落盘失败时按尽力而为语义放弃事件，不伪造边界。

### 8.3 事件执行规则

- `turn:*`、`tool:*`、`scheduler:*` 和插件自有事件属于异步旁路；发布路径只调度监听器，不在当前调用栈直接进入第三方代码；
- 宿主不等待上述异步旁路监听器完成后再向用户返回主结果；实现使用微任务或宏任务逐个调度同一事件的监听器；
- 为兼容已有 v1 行为，`plugins:ready` 与 `plugins:stopping` 使用单独的生命周期屏障派发；`stopping` 在任何 Context 中止前调用并有限等待监听器，不能复用普通异步旁路入口；
- Host Event（宿主事件）采用 best-effort at-most-once（尽力而为、至多一次）投递，不持久化、不重放，也不作为可靠任务队列；
- 同一 `conversationId` 的事件按宿主产生顺序调用监听器，但不保证插件异步处理的完成顺序；需要严格串行的插件必须自行按会话排队；
- 不保证不同会话之间的全局事件顺序；
- `host:*` 是宿主保留命名空间，只能由宿主发布；插件发布的事件始终归入 `plugin:<pluginId>:*`；
- 单个监听器失败只记录插件错误，不影响其他监听器；
- 保留监听器超时保护，但超时只能用于诊断和忽略迟到结果，不能强制终止正在执行的第三方 JavaScript；同进程插件仍可通过同步死循环阻塞 Electron 主进程；
- 插件停止时自动退订；
- 桌面轮次协调器的待结算记录必须在发布、终态后等待落盘超时、渲染目标销毁或应用退出时清理，不能无限保留；
- 不提供可修改参数或返回值的 `before*` 拦截事件；
- 事件不能改变权限结果、工具结果和终态。

## 9. 插件界面边界

宿主不新增通用 `ctx.ui`，也不提供设置页、侧边栏或聊天区插槽。

稳定边界保持为：

- 插件可选实现 `open()`；
- 宿主插件面板负责触发 `open()`；
- 插件使用自己的 `BrowserWindow`（浏览器窗口）、HTML（超文本标记语言）、路由和状态管理；
- 插件可使用已有私有 IPC 与主进程插件代码通信；
- 插件应通过 `onDispose()` 或 `unregister()` 关闭自有窗口和计时器。
- 语音输入插件的模型选择、下载进度、服务状态和识别字幕均可放在插件自有窗口中，Cyrene 设置页不增加插件专用控件。

插件直接操作宿主 DOM（文档对象模型）、导入宿主 React 组件或修改宿主路由属于不受支持行为。

## 10. 典型数据流

### 10.1 长期记忆插件

```text
host:turn:finished
  ↓
插件读取 conversationId
  ↓
conversations.getMessages()
  ↓
调用 ctx.deps.llm 提取记忆
  ↓
写入 ctx.storage
  ↓
registerPromptProvider 在后续轮次追加相关记忆
```

宿主会话保持只读，插件不需要接触聊天文件和 Memory Store（记忆存储对象）。

### 10.2 自动化插件

```text
插件调用 scheduler.createTask()
  ↓
适配器写入 ownerPluginId
  ↓
现有 scheduler store 持久化
  ↓
到期后现有 scheduler engine 触发
  ↓
AgentRuntime 构造运行参数
  ↓
CyreneHarness 执行模型与工具循环
  ↓
记录任务历史并发布 host:scheduler:finished
```

插件只描述任务，不获得 AgentRuntime 或 CyreneHarness 控制权。

### 10.3 Git 工具插件

```text
插件 registerTool({ risk: "fs-read" | "fs-write" | "shell" })
  ↓
工具进入现有 Tool Registry（工具注册表）
  ↓
模型选择工具
  ↓
现有权限链按 risk 审批
  ↓
插件 execute() 获得冻结的 PluginToolContext
  ↓
执行 Git / 文件 / 测试操作
```

不新增插件专用审批系统，也不允许插件修改审批结果。

`risk` 是插件作者声明的行为元数据，现有审批链只能根据声明值决策，不能验证 `execute()` 的实际行为与声明完全一致。因此：

- 该机制属于 Trust-on-declaration（信任自我声明），不是对插件代码的强制安全控制；
- 插件直接使用 Node.js 文件或进程接口的行为不会自动进入工具审批链；
- 官方插件仓库应通过 Lint（静态检查）、代码审查和明显风险等级错配检查进行生态治理；
- 第三方插件的风险声明不准确时，由插件作者和安装者承担相应风险。

### 10.4 本地 ASR 插件

```text
用户从 Cyrene 插件面板调用插件 open()
  ↓
插件打开自有窗口并加载本地模型或后台服务
  ↓
插件调用 speechInput.acquire()
  ↓
宿主暂停当前内置 ASR，并返回独占租约
  ↓
插件自行采集麦克风并完成识别
  ↓
插件在自有窗口显示临时字幕
  ↓
插件 commit() 提交最终文本
  ↓
宿主按正常用户输入运行对话或通话流程
  ↓
现有 Agent、工具审批和 TTS 链路继续工作
  ↓
插件 release()、停止、逻辑异常或被宿主回收
  ↓
宿主自动释放租约并恢复原有 ASR
```

插件安装包可以只包含业务代码和启动逻辑；模型与平台运行文件由插件首次运行时按需下载。下载过程可以在插件窗口中表现为一次引导式安装，但下载、校验、断点续传和平台差异不进入 Cyrene 核心维护范围。

如果插件导致 Electron 主进程整体退出，宿主无法在当前进程中执行租约清理。应用重启后不得恢复任何旧语音输入租约，并应按用户已保存的 ASR 配置进入默认状态。

## 11. SDK 与开发体验

### 11.1 包定位

发布薄型 `@cyrene/plugin-sdk`，作为插件项目的开发依赖。插件构建产物不应要求用户另行安装 SDK。

SDK 第一阶段只提供：

- 公开 TypeScript（类型化 JavaScript 语言）类型；
- `apiVersion` 与能力常量；
- `manifest.schema.json`；
- Manifest 校验入口；
- `createMockPluginContext()`；
- 示例数据和契约测试辅助函数。

SDK 不提供：

- 宿主运行时客户端；
- Harness 包装器；
- UI 框架；
- OAuth 框架；
- 开发服务器；
- 自定义打包器；
- 内部模块类型。

### 11.2 单一来源

```text
src/plugins/api.ts
  ├─ 构建 @cyrene/plugin-sdk 类型产物
  ├─ 生成或校验 manifest schema
  ├─ 生成 API 字段清单
  └─ 供宿主自身编译使用

API 字段清单
  ├─ cyrene-plugin-dev Skill
  ├─ 插件模板
  └─ 开发文档
```

手写文档负责解释用法，自动校验负责防止类型、Schema（结构定义）和 Skill 引用发生漂移。

### 11.3 发布策略

- SDK 位于 Cyrene 主仓库；
- 通过 CI（持续集成）自动发布到 npm（Node.js 包仓库）；
- SDK 使用 SemVer（语义化版本规范）；
- SDK 版本不跟随 Cyrene 应用版本；
- `apiVersion: 1` 的兼容新增发布 SDK 次版本；
- 不兼容修改要求新的 API 主版本；
- 主仓库测试必须使用即将发布的 SDK 产物验证示例插件。

### 11.4 Cyrene Coding 与 Skill

现有 `cyrene-plugin-dev` Skill 负责：

- 根据用户需求选择最小 `deps`；
- 生成 manifest；
- 使用 SDK 类型编写插件；
- 使用 Mock Context（模拟上下文）运行测试；
- 检查是否导入宿主内部文件；
- 生成可安装目录或 ZIP（压缩包格式）包。

Skill 不复制一整份手写 API 定义；接口细节应来自 SDK 和机器可校验的 API 清单。

## 12. 生命周期与资源归属

“资源归属于 PluginContext”是插件生命周期的核心不变量。工具、渠道、事件监听器、IPC、Prompt Provider、调度任务所有权和语音输入租约都必须在创建时登记到当前 `PluginContext`，由 PluginManager 使用同一套回滚和逆序清理机制管理，不允许各模块形成互不关联的孤立清理流程。

### 12.1 启用

1. 扫描并校验 manifest；
2. 检查 `apiVersion` 和 `deps`；
3. 创建插件专属服务适配器；
4. 创建 `PluginContext`；
5. 加载入口并执行 `register()`；
6. 注册成功后才把插件标记为运行中。

任何步骤失败都必须回滚本次注册的工具、渠道、IPC、Provider、事件监听和已取得的语音输入租约。

### 12.2 停用

1. 触发 `ctx.signal.abort()`；
2. 暂停插件拥有的调度任务；
3. 调用 `plugin.unregister()`；
4. 逆序执行 `onDispose()`；
5. 清理事件、工具、渠道、Provider、IPC，并释放仍持有的语音输入租约；
6. 恢复租约建立前的内置 ASR 状态；
7. 保留私有存储、密钥和任务配置。

### 12.3 卸载

1. 完成停用流程；
2. 删除插件拥有的可执行调度任务；
3. 删除插件程序目录；
4. 默认保留插件私有数据和密钥；
5. 用户明确选择“彻底清理”时才删除数据和密钥。

## 13. 错误模型

公开服务错误使用稳定错误码，不向插件透传内部异常类型：

```ts
type PluginHostErrorCode =
  | "E_CAPABILITY_UNAVAILABLE"
  | "E_INVALID_ARGUMENT"
  | "E_NOT_FOUND"
  | "E_NOT_OWNER"
  | "E_STORAGE_UNAVAILABLE"
  | "E_SPEECH_INPUT_BUSY"
  | "E_NO_ACTIVE_INPUT_TARGET"
  | "E_PLUGIN_STOPPING"
  | "E_INTERNAL";
```

规则：

- 错误消息用于开发者诊断；
- 插件不得依赖完整错误文案；
- 内部错误记录在宿主日志中；
- 密钥、完整工具输出和用户文件内容不得写入公共事件错误；
- 插件监听器异常不能改变宿主操作结果。

## 14. 兼容策略

### 14.1 稳定范围

承诺兼容：

- `src/plugins/api.ts` 导出的公开结构；
- `manifest` 字段和已声明语义；
- SDK 中标记为 public 的类型和测试辅助函数；
- 文档列出的 Host Event（宿主事件）名称和字段；
- 服务的资源归属和只读约束。

不承诺兼容：

- `src/main/**`；
- `src/renderer/**`；
- Electron 窗口结构；
- 内部 Store；
- Harness 类型和事件；
- DOM、CSS（层叠样式表）类名和 React 组件；
- 未写入公开文档的对象字段。

### 14.2 API 版本升级

以下修改可以留在 v1：

- 新增可选 `deps`；
- 新增可选字段；
- 新增事件；
- 新增错误码；
- 修复实现但保持既有语义。

以下修改要求 v2：

- 删除或重命名公开字段；
- 改变字段含义；
- 改变资源所有权；
- 把已声明为异步旁路的事件改为阻塞事件；
- 扩大插件对宿主状态的写权限；
- 改变调度任务停用、卸载语义。

## 15. 测试策略

### 15.1 适配器单元测试

每个宿主服务必须验证：

- 正常输入输出；
- 参数边界；
- 插件命名空间；
- 不能访问其他插件资源；
- 插件停止后的行为；
- 内部错误到公开错误码的映射。
- Secrets 的哈希文件名在 Windows 大小写和保留名称场景下正确往返。

### 15.2 Context 契约测试

- 未声明的依赖不注入；
- 未知依赖拒绝加载；
- 启用失败完整回滚；
- 停用后所有注册项消失；
- 所有资源句柄均绑定到创建它的 `PluginContext`，不能由其他插件释放或复用；
- 私有持久化数据保留；
- 调度任务按停用和卸载规则处理。
- 调度任务完整执行规格的授权指纹匹配，任何模式、提示词、计划或工具白名单变化都会撤销授权。

### 15.3 事件集成测试

- 成功、取消、超时和运行错误均只发布对应终态；
- TypeScript 能按 `source` 收窄桌面、渠道和 Scheduler 事件字段；
- `turn:finished` 的消息边界固定指向对应轮次，异步读取不会包含后续轮次；
- 非成功终态只在真实助手消息落盘时携带 `finalMessageId`；
- 同一会话按产生顺序调用监听器，但不等待前一个异步处理完成；
- 事件不持久化、不重放，同一 `eventId` 不重复投递；
- 插件不能发布 `host:*` 事件；
- 事件中不包含消息正文、工具参数和工具输出；
- 返回 Promise 的慢监听器不被普通事件发布路径等待；同步死循环仍可能阻塞同进程宿主，按可信插件边界处理；
- 普通事件不会在发布方当前调用栈进入第三方代码；
- 监听器失败不影响其他插件；
- 插件停止后不再收到事件；
- 桌面待结算轮次在发布、超时、渲染目标销毁和应用退出后完整清理；
- `plugins:ready` 在所有已启用插件激活后使用原有 payload 派发；
- `plugins:stopping` 在任何 Context 中止前有限等待，维持现有 v1 行为。

### 15.4 SDK 契约测试

- 示例插件只依赖发布产物即可编译；
- CommonJS（Node.js 传统模块格式）和 ESM（ECMAScript 模块）示例均可加载；
- Manifest Schema 与运行时校验结果一致；
- SDK 类型不泄漏内部路径；
- `cyrene-plugin-dev` 生成的最小插件通过宿主加载测试。

## 16. 实施顺序

### 阶段一：冻结公开契约

- 整理 `api.ts`；
- 确定新能力类型、按来源区分的轮次事件联合类型和消息分页正式边界；
- 建立 SDK 包和 Manifest Schema；
- 为现有工具、渠道、LLM、事件和存储补齐契约测试。

### 阶段二：只读数据能力

- `secrets`；
- `workspace`；
- `conversations`；
- 对应适配器和测试。

### 阶段三：自动化与观察能力

- `scheduler`；
- 插件任务归属；
- 插件任务创建后保持停用并限定显式工具白名单，由用户在宿主调度页面核对完整执行规格后启用；
- 计划、提示词、会话模式和工具白名单共同计算授权指纹；
- 轮次、工具和调度事件；
- 停用、卸载和失败回滚。

### 阶段四：语音输入接管

- `speechInput` 宿主适配器；
- 内置 ASR 暂停与自动恢复；
- 正常聊天输入和通话输入接入；
- `acquire()` 时冻结会话和渲染桥实例；切换活动会话不迁移租约，页面重载、导航或目标销毁才使其失效；
- 独占租约、目标关闭、逻辑异常、停用回收和应用重启默认状态测试；
- 本地 ASR 示例插件只实现最小验证，不把模型或推理运行时放入核心安装包。

### 阶段五：开发者体验

- 发布 npm SDK；
- 更新插件模板；
- 更新 `cyrene-plugin-dev` Skill；
- 编写天气、长期记忆、自动化和本地 ASR 契约四个示例插件。

## 17. 工作量估算

在复用现有模块、不建设 UI 插槽和权限系统的前提下：

| 工作 | 预计投入 |
| --- | ---: |
| SDK、Schema 和契约测试基础 | 2–3 人日 |
| Secrets、Workspace、Conversations | 2–3 人日 |
| Scheduler 适配与所有权 | 1–2 人日 |
| 生命周期事件扩充 | 1–2 人日 |
| 语音输入租约与普通聊天接入 | 3–5 人日 |
| 示例、文档和全量验证 | 1–2 人日 |

总量预计为 10–15 人日。若要求首版完整接入通话状态和 TTS 播放互斥，语音输入部分预计增加到 5–8 人日，总量相应为 12–18 人日。临时字幕继续由插件窗口维护，不计入宿主工作量。

上述估算只计算 Cyrene 侧公开接口、适配和契约测试。本地模型下载、Python 或原生运行时封装、跨平台发布、GPU 兼容及插件窗口由插件开发者承担，不计入 Cyrene 的持续维护成本。若在实现中新增宿主 UI 插槽、独立插件进程、通用 OAuth 或可修改 Harness 的钩子，应单独立项，不计入本设计。

## 18. 验收标准

架构实现完成后应满足：

1. 外部 TypeScript 插件只安装 `@cyrene/plugin-sdk` 即可获得完整类型提示；
2. 插件无需导入 `src/main/**` 即可实现案例 1–8；
3. 长期记忆插件可以监听完成事件、分页读取会话、保存记忆并追加提示词；
4. 长期记忆插件可以把桌面轮次事件边界直接传给 `getMessages()`，且不会误读后续轮次；
5. 自动化插件可以创建宿主定时任务，但只能创建停用且使用显式工具白名单的任务，无法自行启用、立即运行或获得 Harness 控制权；任何执行规格变化或授权指纹不匹配都会拒绝运行；
6. Git 工具插件通过公开工具接口发起的调用按其声明风险进入现有审批链，文档不把该声明描述成不可绕过的安全保证；
7. 插件界面完全由插件作者维护，不绑定宿主前端结构；
8. 非成功终态不会误报为成功完成事件；
9. 生命周期事件按来源提供可辨识联合类型，普通事件符合异步调度、至多一次、不持久化、不重放及宿主保留命名空间语义；既有插件生命周期屏障事件保持 v1 行为；
10. 插件停用和卸载不会遗留可执行回调、监听器、资源句柄或孤儿调度任务；
11. 宿主重构聊天存储、调度器或 Harness 时，公开插件接口无需同步变化；
12. 语音输入插件可以在不修改 Cyrene 设置页和 ASR 配置的情况下接管输入并提交最终文本；
13. 语音输入目标在取得租约时冻结，切换活动会话不会改变提交目标；页面重载、导航或原渲染目标销毁会使租约失效；
14. 语音输入插件停用、逻辑异常、被回收或目标关闭后，租约自动释放且原有 ASR 恢复；主进程整体退出后由应用重启默认状态恢复；
15. 官方插件仓库可以通过自动检查拒绝内部导入、不兼容 API 和明显错误的工具风险声明。
