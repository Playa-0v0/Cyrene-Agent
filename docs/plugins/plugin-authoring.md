# Cyrene Runtime Plugin API v1

本文描述 Cyrene-Agent 的可信本地运行时插件系统。插件以“目录 + `manifest.json` +
JavaScript 入口”交付，可注册工具、插件私有 IPC、渠道 adapter，并按声明使用 Cyrene
提供的 LLM 服务。

## 安全与信任边界

> 插件入口在 Electron Main Process 中执行，拥有与 Cyrene 相同的本机权限。它不是
> 沙箱、Web 扩展或权限隔离进程。只安装你能审查且信任其来源的插件。

`manifest.deps` 表示“希望 Cyrene 注入哪些主程序服务”，不是操作系统权限清单。
插件代码仍可直接使用 Node.js 能力，因此：

- 用户插件首次发现后一律保持停用，即使 manifest 声明 `defaultEnabled: true`。
- 聊天窗口插件面板显示开发者、版本、运行状态和最后一次错误。
- 只有用户明确点击“启用”后，用户插件入口才会被加载。
- 内置插件可使用 `defaultEnabled`，因为它与应用一起构建和发布。

## 目录与扫描来源

用户插件：

```text
userData/plugins/<plugin-id>/
  manifest.json
  index.cjs
```

打包版 Windows 默认对应：

```text
%APPDATA%\live2d-cyrene\plugins\<plugin-id>\
```

运行时始终以 Electron `app.getPath("userData")` 的实际返回值为准；如果开发者或测试显式
覆盖了 `userData`，插件根目录也会随之变化。

聊天窗口的插件面板支持直接选择 `.zip` 插件包。压缩包可以把 `manifest.json` 和入口文件放在 ZIP 根目录，
也可以统一放在唯一的顶层目录中：

```text
my-plugin.zip
└── my-plugin/
    ├── manifest.json
    └── index.cjs
```

导入流程不会直接在正式插件目录中解压，而是：

1. 在 `userData/plugin-install-staging/` 创建随机临时目录；
2. 逐条检查 ZIP 路径、加密标志、符号链接、数量和解压尺寸；
3. 解压后再次遍历文件类型并按正常插件规则校验 manifest 与入口；
4. 以 manifest 的 `id` 作为最终目录名，使用同卷 rename 提交；
5. 新插件清除可能残留的启用记录，重扫后保持停用；
6. 替换已有用户插件前显示确认，先备份旧目录，提交失败时恢复；
7. 安装完成后自动重扫，插件私有数据目录不会被替换。

当前限制为：ZIP 文件最多 50 MiB、最多 2000 个条目、单文件解压后最多 50 MiB、总解压量
最多 200 MiB，异常压缩比会被拒绝。加密 ZIP、绝对路径、`..` 路径、符号链接、Windows
保留路径和大小写冲突路径也会被拒绝。这些检查用于降低路径穿越和 ZIP bomb 风险，但插件代码
本身仍属于可信本地原生代码，导入校验不等同于运行时沙箱。

内置插件：

```text
src/plugins/<plugin-id>/
  manifest.json
  index.ts
```

内置插件由构建流程复制/编译到 `dist/main/plugins`。插件私有数据位于：

```text
userData/plugin-data/<plugin-id>/
```

扫描只读取每个根目录的一级子目录。单个无效插件、不可读目录或错误 manifest 会记录为
扫描问题并展示在聊天窗口的插件面板，不会阻止 Cyrene 启动。重复 ID 保留先扫描到的插件；内置目录
优先于用户目录，因此用户插件不能覆盖内置插件。

## manifest.json

完整示例：

```json
{
  "apiVersion": 1,
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "An example Cyrene plugin",
  "author": "Your Name",
  "entry": "index.cjs",
  "defaultEnabled": false,
  "deps": ["llm"]
}
```

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `apiVersion` | number | 是 | 当前必须为 `1` |
| `id` | string | 是 | 匹配 `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `name` | string | 是 | 非空显示名 |
| `version` | string | 是 | 严格 SemVer，例如 `1.2.0`、`2.0.0-beta.1` |
| `description` | string | 是 | 非空简介 |
| `author` | string | 是 | 非空开发者或团队名称；展示在插件卡片中 |
| `entry` | string | 是 | 插件目录内裸文件名；支持 `.cjs`、`.js`、`.mjs` |
| `icon` | string | 否 | 插件目录内裸文件名；支持 `.png`、`.jpg`、`.jpeg`、`.webp`、`.svg`；≤2MiB。在聊天窗口插件卡片左侧展示；不合法时静默忽略，不影响加载 |
| `defaultEnabled` | boolean | 否 | 缺省 true，但只对内置插件生效 |
| `deps` | string[] | 否 | 可选 `channels`、`llm`、`secrets`、`workspace`、`conversations`、`scheduler`、`speech-input` |

以下情况会拒绝加载：

- 缺少或不兼容的 `apiVersion`；
- version 不是 SemVer；
- `deps` 含未知值或不是数组；
- `defaultEnabled` 不是布尔值；
- entry 包含子目录、`..`、扩展名不受支持；
- entry 不存在、不是普通文件，或通过符号链接指向插件目录外。

未知依赖会使 manifest 整体失败，不会静默过滤。这样可以尽早暴露 `lllm` 一类拼写错误。

## 入口契约

CommonJS：

```js
module.exports = {
  async register(ctx) {
    ctx.log("enabled");
  },
  async unregister() {
    // Close plugin-owned windows, timers and background work.
  },
  async open() {
    // Optional controlled entry called from Settings.
  },
};
```

ESM 可使用默认导出或命名导出。必须提供 `register(ctx)`；`unregister()` 与
`open()` 可选。

### 取消与资源清理

每个 context 提供只读 `ctx.signal`。插件停用、刷新、卸载、应用退出或启动失败回滚时，
框架会在调用 `unregister()` 前取消该信号。支持 `AbortSignal` 的后台工作应直接使用它。

```js
async register(ctx) {
  const timer = setInterval(refresh, 30_000);
  ctx.onDispose(() => clearInterval(timer));
  void watchExternalService({ signal: ctx.signal }).catch((error) => {
    if (!ctx.signal.aborted) ctx.log("后台任务失败", error);
  });
}
```

`ctx.onDispose(callback)` 登记的回调按逆序执行，并会等待异步回调结束。每个回调最多执行
一次，且单次等待上限为 5 秒；单个回调失败或超时会被记录，但不会阻止其余回调以及工具、
IPC、渠道等框架资源释放。`unregister()` 使用相同的 5 秒上限。插件进入停止阶段后不能继续
登记新的清理回调。

## 稳定 Plugin API

插件面向的类型统一定义在 `src/plugins/api.ts`。该文件不导入 `src/main/**` 或
`src/shared/**`；Cyrene 内部类型只在 context adapter 边界转换。第三方插件不应直接
导入应用内部模块。

### 工具

```js
ctx.registerTool({
  id: "my-plugin_hello",
  name: "Hello",
  description: "Return a greeting",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  verificationPolicy: "none",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  },
  execute: async () => "Hello from my plugin"
});
```

工具 ID 必须以 `<plugin-id>_` 开头。Context 会拒绝重复 ID，也拒绝插件注销核心工具或
其他插件的工具：

```js
ctx.unregisterTool("my-plugin_hello"); // allowed
ctx.unregisterTool("read_file");       // rejected
```

### IPC

```js
ctx.registerIpc("ping", () => "pong");
```

实际 Electron IPC 名称为 `plugin:<plugin-id>:ping`。channel 只允许字母、数字、
`.`、`_`、`-`，长度不超过 64。插件只能注销当前 context 注册过的 IPC。

### 事件

插件可订阅宿主或其他插件发布的事件：

```js
const unsubscribe = ctx.events.on("host:plugins:ready", ({ pluginIds }) => {
  ctx.log("已启动插件", pluginIds);
});

ctx.events.on("plugin:weather:updated", (weather) => {
  ctx.log("天气插件已更新", weather);
});
```

`ctx.events.on()` 返回幂等的退订函数；插件停用、刷新、卸载或启动失败回滚时，Context
也会自动退订仍然有效的监听器，进入停止阶段后不能再新增订阅。监听器按订阅顺序执行并
等待异步结果；单个监听器失败或执行超过 5 秒会被记录，但不会阻止同一事件的其余监听器。

插件只能用短事件名发布自己的事件，框架会自动添加所有者命名空间：

```js
await ctx.events.emit("status", { online: true });
// 订阅方收到：plugin:my-plugin:status
```

插件不能伪造 `host:*` 或其他插件的事件。宿主通过
`PluginManager.publishHostEvent("chat:message", payload)` 发布的完整名称为
`host:chat:message`。目前内置事件：

- `host:plugins:ready`：启动扫描和自动启用完成，payload 为 `{ pluginIds: string[] }`；
- `host:plugins:stopping`：全局插件停止开始、任何活动插件被注销之前，payload 为 `undefined`；
- `host:turn:started`：一轮对话开始，payload 含 `eventId`、`timestamp`、`runId`、`mode` 和 `source`（desktop / channel / scheduler）及各来源的判别字段（desktop 携带 `conversationId` 与 `inputMessageId`；channel 携带 `channel`；scheduler 携带 `taskId` 与 `schedulerRunId`）；
- `host:turn:finished`：一轮对话进入终态（success / cancelled / timeout / runtime_error），字段同上；desktop 分支在成功终态且 assistant 消息确认落盘后额外携带 `finalMessageId`。非成功终态不得用「当前最后一条消息」补齐该字段；
- `host:tool:finished`：工具执行结果已确定后的只读观察通知，payload 含 `runId`、`toolId`、`toolCallId`、`status`（success / failure / unknown / not_executed）、`risk` 与可选 `durationMs`；不携带工具参数、输出正文与内部异常；
- `host:scheduler:finished`：调度任务执行完成，payload 含 `taskId`、`schedulerRunId`、`status`、`durationMs` 与事件公共元数据，不含任务提示词与模型输出正文；
- `host:turn:completed`：v1 兼容事件，仅成功终态发布；新代码请改用 `host:turn:started` / `host:turn:finished`。

轮次完成事件属于旁路通知。宿主不会等待插件监听器，插件应自行排队处理持久化或网络同步，
并在 `ctx.signal` 取消后尽快停止。若未来确需对话文本，应先单独评审权限和兼容边界。

### 动态提示词上下文

插件可以为每轮 Agent 请求提供动态 system context，而无需修改 `soul.md` 等核心提示词文件：

```js
ctx.registerPromptProvider({
  id: "local-status",
  modes: ["chat", "work"],
  async provide({ source, mode, userText, conversationId, channel, signal }) {
    if (signal.aborted) return "";
    return `当前插件状态：online；请求来源：${source}；模式：${mode}`;
  },
});
```

Provider id 在当前插件内唯一，框架会补全为 `plugin:<插件id>:<provider-id>`。`modes` 可选，
缺省覆盖 `chat`、`work`、`learn`、`code`。Provider 会收到当前用户文本、可选会话 id、
可选渠道及插件停止信号；不会收到完整对话历史。

贡献内容进入每轮变化的 runtime context，不写入稳定提示词前缀，因此不会因动态内容破坏基础提示词
缓存。多个 Provider 并行生成、按注册顺序拼接；单个 Provider 最多等待 2 秒，失败或超时只跳过
自身。单项最多 16000 字符，全部插件合计最多 32000 字符。插件停用、刷新、卸载或启动失败
回滚时自动移除其 Provider，也可调用 `ctx.unregisterPromptProvider(id)` 主动注销。

### 私有存储

```js
ctx.storage.set("config", { endpoint: "https://example.com" });
const config = ctx.storage.get("config");
```

每个 key 对应一个 JSON 文件。key 必须匹配
`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`。写入使用临时文件和 rename，避免进程崩溃留下
半份 JSON。

### Channels

渠道注册必须通过 Context：

```js
await ctx.registerChannelAdapter(adapter);
await ctx.unregisterChannelAdapter(adapter.id);
```

Context 会跟踪 adapter 所有权并在插件停用时兜底清理。插件不能注销内置渠道或其他插件
注册的渠道。

当 manifest 声明 `"deps": ["channels"]` 时，仅额外提供只读发现能力：

```js
ctx.deps.channels.has("feishu");
```

内置 adapter 会在插件激活前完成注册。ChannelManager 对重复 ID 直接报错，不再覆盖已经
启动的实例。

### LLM

manifest：

```json
{
  "deps": ["llm"]
}
```

调用：

```js
const text = await ctx.deps.llm.generateText(
  [{ role: "user", content: "Summarize this text" }],
  {
    purpose: "summary",
    maxTokens: 1024,
    timeoutMs: 30000,
    signal: abortController.signal
  }
);
```

LLM 请求使用当前默认模型档案，并统一经过 Cyrene 的 `LlmClient`、后台 FIFO 队列、
限流重试、timeout、取消、token usage 与请求日志。限制：

- `maxTokens`：1-8192，缺省 1024；
- `timeoutMs`：1000-300000；缺省使用聊天超时并封顶 120 秒；
- `purpose`：只用于诊断标签，不影响模型选择。

### Secrets（插件私有密钥）

manifest 声明 `"deps": ["secrets"]` 后可用。密钥保存在宿主安全存储中，按插件命名空间隔离——插件无法读写其他插件的密钥；插件卸载后密钥默认保留。

```js
await ctx.deps.secrets.set("openweathermap_key", "...");
const key = await ctx.deps.secrets.get("openweathermap_key"); // 不存在时 undefined
const deleted = await ctx.deps.secrets.delete("openweathermap_key");
```

安全存储不可用（如系统钥匙串访问失败）时读写抛 `E_STORAGE_UNAVAILABLE`，插件应提供无密钥的降级路径或向用户提示配置问题。

### Workspace（会话工作区只读绑定）

manifest 声明 `"deps": ["workspace"]` 后可用。只读取会话已绑定的工作区描述，不提供绑定、解绑或选择目录的写接口。

```js
const binding = await ctx.deps.workspace.getBinding(conversationId);
if (binding) {
  ctx.log(`会话工作区: ${binding.root} (${binding.displayName})`);
}
```

会话没有绑定工作区时返回 `null`，不是错误。

### Conversations（会话只读服务）

manifest 声明 `"deps": ["conversations"]` 后可用。只暴露插件需要的稳定投影：会话列表和消息分页，只含 user / assistant 角色和纯文本内容。

```js
const page = await ctx.deps.conversations.list({ cursor, limit: 20 });

// 冻结边界分页：把桌面轮次事件的 inputMessageId / finalMessageId
// 直接作为 fromMessageId / throughMessageId，翻页不会混入后续轮次的消息
const messages = await ctx.deps.conversations.getMessages({
  conversationId,
  fromMessageId: turnEvent.inputMessageId,
  throughMessageId: turnEvent.finalMessageId,
  limit: 50,
});
```

`getMessages()` 返回的 `range` 字段是本次分页实际冻结的包含式边界；后续页的游标携带同一组边界。非法游标（已删除的消息、越过终点的游标）抛 `E_INVALID_ARGUMENT`，会话不存在抛 `E_NOT_FOUND`。

### Scheduler（插件调度任务）

manifest 声明 `"deps": ["scheduler"]` 后可用。插件只能查看和修改自己创建的任务；接口不提供启用、立即运行或切换到全部工具模式的能力。

```js
const task = await ctx.deps.scheduler.createTask({
  title: "每日站会提醒",
  prompt: "提醒我写今日站会",
  schedule: { kind: "daily", timeOfDay: "09:30" },
  mode: "chat",
  allowedToolIds: [], // 插件任务必须显式白名单，不允许 all-enabled
});
```

宿主不变量：

- 插件创建的任务一律以停用 + 白名单模式落盘，必须用户在宿主界面确认启用；
- 计划、提示词、模式或工具白名单的任何变更都会撤销用户已有的授权并回到停用状态；仅改标题不影响授权；
- 试图访问其他插件的任务统一返回 `E_NOT_OWNER`，不泄露任务存在性。

### Speech-input（独占语音输入租约）

manifest 声明 `"deps": ["speech-input"]` 后可用。适用于自带 ASR 模型的本地语音插件：Cyrene 只提供受控的最终文本提交入口，模型、运行时、麦克风采集和窗口都由插件自行维护。

```js
// target 二选一："active-chat"（普通聊天窗口）或 "active-call"（活动通话）
const lease = await ctx.deps.speechInput.acquire({ target: "active-chat" });

// 租约被宿主中止（页面重载、会话删除、通话结束、插件停止、应用退出）
// 时 signal 触发，必须立即停止识别
lease.signal.addEventListener("abort", stopRecognition, { once: true });

// 提交最终识别文本：复用宿主正常用户输入路径，消息落盘后即返回，
// 不等待模型回答；同一租约的多次 commit 串行执行
await lease.commit("识别出的最终文本");

// 幂等释放：把输入权还给宿主；释放后不得再 commit
await lease.release();
```

租约语义：

- 全局同一时刻只允许一个插件持有租约，占用中再 acquire 抛 `E_SPEECH_INPUT_BUSY`；
- 取得租约时目标即被冻结：页面内切换会话不迁移租约；冻结目标失效时租约自动中止；
- `active-chat` 目标要求有活动的聊天窗口，`active-call` 目标要求有进行中的通话，否则抛 `E_NO_ACTIVE_INPUT_TARGET`；`active-call` 会接管通话输入（停止内置 ASR），释放时归还；
- commit 的失败按稳定错误码分支处理（如会话删除 `E_NOT_FOUND`、通话忙 `E_SPEECH_INPUT_BUSY`）。

### 统一错误码

宿主服务失败时抛出带稳定错误码的异常；插件只应依赖错误码做分支处理，不要匹配错误消息文案：

```js
import { isPluginHostError } from "@playa0v0/cyrene-plugin-sdk";

try {
  await lease.commit(text);
} catch (error) {
  if (isPluginHostError(error)) {
    // error.code 是稳定错误码，error.message 仅供日志
  }
}
```

| 错误码 | 含义 |
|---|---|
| `E_CAPABILITY_UNAVAILABLE` | 声明的宿主服务不可用 |
| `E_INVALID_ARGUMENT` | 参数非法（空文本、非法游标等） |
| `E_NOT_FOUND` | 目标不存在（会话/任务已删除、通话已结束） |
| `E_NOT_OWNER` | 试图访问其他插件拥有的资源 |
| `E_STORAGE_UNAVAILABLE` | 安全存储不可用 |
| `E_SPEECH_INPUT_BUSY` | 语音输入租约被占用或通话轮次进行中 |
| `E_NO_ACTIVE_INPUT_TARGET` | 无可用的聊天窗口或活动通话 |
| `E_PLUGIN_STOPPING` | 插件正在停止 |
| `E_INTERNAL` | 宿主内部错误 |

### SDK（@playa0v0/cyrene-plugin-sdk）

外部开发者不需要阅读 Cyrene 宿主源码即可完成插件开发：

```bash
npm install @playa0v0/cyrene-plugin-sdk
```

```ts
// TypeScript 插件：类型 + 常量 + Manifest 校验
import type { CyrenePlugin, PluginTool } from "@playa0v0/cyrene-plugin-sdk";
import { CURRENT_PLUGIN_API_VERSION, validateManifestData } from "@playa0v0/cyrene-plugin-sdk";

// 测试工具（子路径导出）：脱离宿主验证插件契约
import { createMockPluginContext, assertPluginTool } from "@playa0v0/cyrene-plugin-sdk/testing";
```

SDK 同时输出 ESM 和 CJS，不含 Electron、React 或宿主运行时依赖；插件编译期依赖 SDK，打包后的插件目录不要求终端用户安装 SDK。SDK 中带 Mock Context 的完整示例见仓库 `examples/` 下的四个示例插件。
## 生命周期和状态

```text
scan
  -> disabled
  -> starting
  -> running
  -> stopping
  -> disabled

starting --error--> failed
failed --retry--> starting
```

聊天窗口插件面板区分：

- `configuredEnabled`：用户希望插件启用；
- `status`：`disabled | starting | running | stopping | failed`；
- `error`：最后一次激活失败原因。

因此“配置为启用但 register 失败”不会伪装成普通停用。用户可以重试，也可以关闭 desired
state，避免每次启动重复尝试。

所有 enable、disable、open、rescan、install、uninstall、stop 操作经过同一生命周期队列串行执行，
避免并发点击或多个 renderer 请求造成重复注册和 context 泄漏。

## 刷新、更新与模块缓存

聊天窗口插件面板的“刷新插件”会：

1. 重新扫描内置和用户目录；
2. 停止并移除已删除插件；
3. 清理活动插件资源；
4. 清除该插件目录下的 CommonJS `require.cache`；
5. 使用 cache-busting URL 重新导入 ESM 入口；
6. 重新激活仍配置为启用的插件；
7. 展示 manifest、重复 ID 和目录读取问题。

活动插件会在手动刷新时重新加载，即使 manifest 没变。新增用户插件仍保持停用。

## 卸载用户插件

聊天窗口插件面板只允许删除用户插件。卸载事务按以下顺序执行：

1. 确认目标来自用户插件扫描源；内置插件拒绝卸载；
2. 确认目标是用户插件根目录中的一级普通目录，并通过真实路径再次验证没有越界；
3. 停止插件并释放工具、IPC、渠道适配器等运行资源；
4. 清除该插件的持久启停记录，确保删除失败时也不会在下次扫描自动重启；
5. 清理模块缓存并递归删除插件程序目录；
6. 执行一次不重启其他活动插件的增量重扫。

卸载只删除 `userData/plugins/<plugin-id>/` 中的插件程序。默认保留
`userData/plugin-data/<plugin-id>/` 中的插件私有数据，避免卸载误删用户内容；如需彻底清除，
应由用户另行确认后手动删除对应数据目录。

## 应用退出

插件清理加入新版应用退出协调器的固定阶段。Cyrene 会依次等待：

1. 插件 `unregister()`；
2. Context 工具、IPC、渠道资源回收；
3. 插件在 `stopActiveWork` 阶段完成后，再在 `stopExternalConsumers` 阶段关闭内置 Channels；
4. 截图服务、LSP、Git 与音乐等本地资源关闭。

受控退出总等待上限为 10 秒，超时后中止继续等待并执行最终退出动作。插件仍应让
`unregister()` 有界且可重复调用。

## 从最初 v1 草案迁移

旧 manifest：

```json
{
  "id": "my-plugin",
  "version": "1.0.0"
}
```

必须增加：

```json
{
  "apiVersion": 1
}
```

其他行为变化：

- 用户插件不再自动启用；
- `deps.channels.channelManager` 已移除，改用 Context 注册方法和
  `deps.channels.has()`；
- 非法 deps 不再过滤，而是拒绝 manifest；
- version 必须为 SemVer；
- 注销非本插件资源会抛错；
- 插件列表 IPC 返回 `{ plugins, issues }`，不再只返回数组。

## 验证

```bash
npx vitest run src/plugins src/main/plugin-llm.test.ts src/main/channels/manager.test.ts
npm run build
```

建议人工验收：

1. 新用户插件出现但不会自动执行；
2. 启用/停用后工具、IPC 和 adapter 对称增减；
3. register 失败后插件面板显示 `failed` 和具体错误；
4. 修改入口后点击刷新，运行行为切换到新版本；
5. 用户插件点击卸载并确认后，程序目录、资源和启停记录消失，私有数据目录保留；
6. 重复使用 `feishu` 等内置渠道 ID 时启用失败，内置渠道仍正常；
7. 退出时异步 `unregister()` 在退出协调器内完成，并严格早于内置 Channels 关闭。
8. 从 ZIP 导入新插件后保持停用；替换已有插件必须确认且保留 `plugin-data`；
9. 路径穿越、符号链接、异常尺寸和大小写冲突 ZIP 被拒绝，临时目录被清理。
