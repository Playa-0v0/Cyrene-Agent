# Cyrene 插件系统扩展架构设计

> **日期**：2026-09-02
> **状态**：架构草案
> **范围**：可信本地插件的公开能力、宿主适配层、开发包、生命周期与兼容策略
> **结论先行**：继续采用同进程可信插件模型，只开放稳定、强类型的能力适配层；插件可以完成工具、渠道、知识库、长期记忆、自动化和自有界面，但不能接管权限策略、Agent Loop（智能体循环）或 CyreneHarness 内部实现。

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

本轮扩展的核心目标不是建设新的权限系统，而是在不暴露 CyreneHarness 和 `src/main/**` 内部对象的前提下，为第三方插件补齐稳定的宿主能力。

## 2. 已确认的产品边界

### 2.1 对外开放的能力

| 编号 | 插件类型 | 对外能力边界 |
| --- | --- | --- |
| 1 | 天气、汇率、搜索 | 联网、注册只读工具、写入插件私有缓存 |
| 2 | Todoist（任务管理服务）、邮件、智能家居 | 保存第三方密钥，注册具有外部副作用的工具，执行结果仍走宿主工具语义 |
| 3 | 本地知识库 | 读取插件或用户选择的目录、检索文件、向对话追加动态上下文 |
| 4 | Git（分布式版本控制系统）代码助手 | 注册读文件、写文件和命令工具；工具按风险等级进入现有审批链 |
| 5 | 长期记忆 | 只读、分页读取会话；监听轮次完成；记忆存入插件私有存储；通过提示词 Provider（提供器）影响后续回答 |
| 6 | 自定义界面 | 插件自行决定窗口、网页、托盘或其他呈现方式；宿主不提供页面插槽和 React（前端组件框架）组件注入能力 |
| 7 | 自动化 | 通过插件调度接口创建 Cyrene 定时任务，由现有调度器运行完整模型与工具循环 |
| 8 | Harness 观察 | 订阅只读、异步、通知型生命周期事件；不能修改参数、结果、审批或控制流 |

### 2.2 明确不开放的能力

下列能力不进入公开插件接口：

- 修改工具风险等级；
- 自动批准、拒绝或绕过宿主审批；
- 替换 Agent Loop；
- 替换 CyreneHarness；
- 修改重试、压缩、恢复或终态结算语义；
- 获取 Harness 实例、内部 Store（存储对象）或应用依赖容器；
- 通过公开接口覆盖核心函数；
- 修改宿主规则、工具返回值或模型可见的真实执行结果。

第三方代码在同进程运行，技术上仍可能直接使用 Node.js 或导入可解析的内部文件；这类行为不属于稳定 API，不提供兼容保证，也不进入官方插件仓库的收录范围。

### 2.3 人格定制不属于插件权限

人格继续通过 `prompts` 文件完成：

- `soul.md`：聊天完整人格；
- `cyrene_harness.md`：非 Chat（聊天）模式中 Harness 每轮携带的精简运行时人格；
- `chat_identity.md`、`work_identity.md`、`learn_identity.md`、`code_identity.md`：模式身份；
- `styles/**`：表达风格。

安装版优先读取 `userData/prompts/` 下的同名文件。人格文件覆盖不需要新增插件接口，也不要求插件访问 Harness。

## 3. 设计目标

1. 插件只依赖公开类型，不依赖 `src/main/**`。
2. 宿主内部模块可以重构，而不要求第三方插件同步修改。
3. 新能力优先复用现有 Store、调度器、审批链和事件总线。
4. 每项宿主能力具有独立、最小、强类型的接口。
5. 插件只能操作自身注册或创建的资源。
6. 插件监听器失败、超时或退出不能阻塞宿主主流程。
7. SDK（软件开发工具包）、开发 Skill（技能）和运行时接口使用同一份公开契约。
8. 第一阶段不建设界面插槽、权限组合、独立插件进程或通用 OAuth（第三方授权登录协议）框架。

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
            └─ scheduler
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

## 6. Manifest 依赖声明

`PluginCapability` 扩展为：

```ts
type PluginCapability =
  | "channels"
  | "llm"
  | "secrets"
  | "workspace"
  | "conversations"
  | "scheduler";
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
- 不暴露磁盘路径、内部索引、模型请求原文和缓存字段；
- 不开放替换、删除、重命名或追加宿主消息；
- 长期记忆写入插件私有存储；
- 影响后续回答时使用 `registerPromptProvider()`。

### 7.4 Scheduler

```ts
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
- 工具白名单；
- 是否启用。

约束：

- 宿主自动记录 `ownerPluginId`；
- 插件只能查看和修改自己创建的任务；
- 到期后由现有 Scheduler Engine（调度引擎）和 AgentRuntime 执行；
- 插件不能传入 Harness 配置、审批策略或内部恢复状态；
- 插件停用时任务保留但暂停执行；
- 插件重新启用时按现有逾期归一化规则计算下一次时间，不补跑历史任务；
- 插件卸载时删除其定时任务，避免遗留仍会产生外部副作用的孤儿任务；
- 任务历史可以保留为诊断记录，但不得继续关联可执行入口。

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

interface PluginTurnFinishedEvent extends PluginHostEventBase {
  conversationId: string;
  runId?: string;
  source: "desktop" | "channel" | "scheduler";
  mode: PluginPromptMode;
  channel?: string;
  status: PluginTurnStatus;
  durationMs?: number;
}
```

工具完成事件可以包含 `toolId`、`toolCallId`、`status`、`risk` 和 `durationMs`，但不包含：

- 工具参数；
- 工具输出；
- 文件内容；
- 密钥和请求头；
- 完整提示词；
- 内部异常对象。

需要消息正文的插件在轮次完成后调用 `conversations.getMessages()`。

### 8.3 事件执行规则

- 所有监听器属于异步旁路；
- 宿主不等待插件完成后再向用户返回主结果；
- 单个监听器失败只记录插件错误，不影响其他监听器；
- 保留监听器超时保护；
- 插件停止时自动退订；
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

### 12.1 启用

1. 扫描并校验 manifest；
2. 检查 `apiVersion` 和 `deps`；
3. 创建插件专属服务适配器；
4. 创建 `PluginContext`；
5. 加载入口并执行 `register()`；
6. 注册成功后才把插件标记为运行中。

任何步骤失败都必须回滚本次注册的工具、渠道、IPC、Provider 和事件监听。

### 12.2 停用

1. 触发 `ctx.signal.abort()`；
2. 暂停插件拥有的调度任务；
3. 调用 `plugin.unregister()`；
4. 逆序执行 `onDispose()`；
5. 清理事件、工具、渠道、Provider 和 IPC；
6. 保留私有存储、密钥和任务配置。

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
- 把异步旁路事件改为阻塞事件；
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

### 15.2 Context 契约测试

- 未声明的依赖不注入；
- 未知依赖拒绝加载；
- 启用失败完整回滚；
- 停用后所有注册项消失；
- 私有持久化数据保留；
- 调度任务按停用和卸载规则处理。

### 15.3 事件集成测试

- 成功、取消、超时和运行错误均只发布对应终态；
- 事件中不包含消息正文、工具参数和工具输出；
- 慢监听器不延迟宿主结果；
- 监听器失败不影响其他插件；
- 插件停止后不再收到事件。

### 15.4 SDK 契约测试

- 示例插件只依赖发布产物即可编译；
- CommonJS（Node.js 传统模块格式）和 ESM（ECMAScript 模块）示例均可加载；
- Manifest Schema 与运行时校验结果一致；
- SDK 类型不泄漏内部路径；
- `cyrene-plugin-dev` 生成的最小插件通过宿主加载测试。

## 16. 实施顺序

### 阶段一：冻结公开契约

- 整理 `api.ts`；
- 确定新能力类型；
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
- 轮次、工具和调度事件；
- 停用、卸载和失败回滚。

### 阶段四：开发者体验

- 发布 npm SDK；
- 更新插件模板；
- 更新 `cyrene-plugin-dev` Skill；
- 编写天气、长期记忆和自动化三个示例插件。

## 17. 工作量估算

在复用现有模块、不建设 UI 插槽和权限系统的前提下：

| 工作 | 预计投入 |
| --- | ---: |
| SDK、Schema 和契约测试基础 | 2–3 人日 |
| Secrets、Workspace、Conversations | 2–3 人日 |
| Scheduler 适配与所有权 | 1–2 人日 |
| 生命周期事件扩充 | 1–2 人日 |
| 示例、文档和全量验证 | 1–2 人日 |

总量预计为 7–10 人日。若在实现中新增宿主 UI 插槽、独立插件进程、通用 OAuth 或可修改 Harness 的钩子，应单独立项，不计入本设计。

## 18. 验收标准

架构实现完成后应满足：

1. 外部 TypeScript 插件只安装 `@cyrene/plugin-sdk` 即可获得完整类型提示；
2. 插件无需导入 `src/main/**` 即可实现案例 1–8；
3. 长期记忆插件可以监听完成事件、分页读取会话、保存记忆并追加提示词；
4. 自动化插件可以创建宿主定时任务，但无法获得 Harness 控制权；
5. Git 工具插件的工具调用继续经过现有风险审批；
6. 插件界面完全由插件作者维护，不绑定宿主前端结构；
7. 非成功终态不会误报为成功完成事件；
8. 插件停用和卸载不会遗留可执行回调、监听器或孤儿调度任务；
9. 宿主重构聊天存储、调度器或 Harness 时，公开插件接口无需同步变化；
10. 官方插件仓库可以通过自动检查拒绝内部导入和不兼容 API。
