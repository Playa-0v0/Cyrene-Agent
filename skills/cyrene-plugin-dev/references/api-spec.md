# manifest.json 规范

## 完整示例

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

## 字段表

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `apiVersion` | number | 是 | 当前必须为 `1` |
| `id` | string | 是 | 匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`，全小写连字符 |
| `name` | string | 是 | 非空显示名 |
| `version` | string | 是 | 严格 SemVer，如 `1.2.0`、`2.0.0-beta.1`（不能写 `1.0` 或 `v1.0`） |
| `description` | string | 是 | 非空简介 |
| `author` | string | 是 | 非空开发者或团队名称；展示在插件卡片中 |
| `entry` | string | 是 | 插件目录内裸文件名；支持 `.cjs`、`.js`、`.mjs`；不能含子目录或 `..` |
| `icon` | string | 否 | 插件目录内裸文件名；支持 `.png`/`.jpg`/`.jpeg`/`.webp`/`.svg`；≤2MiB；聊天窗口插件卡片左侧展示；不合法时静默忽略，不影响加载 |
| `defaultEnabled` | boolean | 否 | 缺省 true，**只对内置插件生效**；用户插件首次发现一律停用 |
| `deps` | string[] | 否 | 可选值仅 `channels`、`llm`；未知值（含拼写错误）会让整个 manifest 失败 |

## 拒绝加载的情况

- `apiVersion` 缺失或不兼容
- version 不是 SemVer
- `deps` 含未知值或不是数组
- `defaultEnabled` 不是布尔值
- entry 含子目录、`..`、扩展名不受支持
- entry 不存在、不是普通文件，或经符号链接指向插件目录外

## id 的作用

`id` 决定三件事，必须保持一致：

1. 安装目录名：`userData/plugins/<id>/`
2. 工具 id 前缀：所有工具必须叫 `<id>_xxx`
3. IPC 通道前缀：`plugin:<id>:<channel>`

---

# 入口契约

CommonJS（推荐，`.cjs`）：

```js
"use strict";

module.exports = {
  async register(ctx) {
    // 启用时调用；在这里注册工具、IPC、渠道
    ctx.log("enabled");
  },
  async unregister() {
    // 停用/刷新/退出时调用；关窗口、清定时器和子进程；必须可重复调用
  },
  async open() {
    // 可选；实现了它，聊天窗口插件卡片的“打开”按钮会变为可用
  },
};
```

ESM 可用默认导出或命名导出。必须提供 `register(ctx)`，其余可选。

## 取消与资源清理（推荐托管）

每个 context 提供只读 `ctx.signal`（AbortSignal）。插件停用、刷新、卸载、应用退出或启动失败回滚时，框架会在调用 `unregister()` **之前**取消它。定时器、后台任务等资源推荐交给框架托管：

```js
async register(ctx) {
  const timer = setInterval(refresh, 30_000);
  ctx.onDispose(() => clearInterval(timer));   // 兜底清理，逆序执行

  void watchExternalService({ signal: ctx.signal }).catch((error) => {
    if (!ctx.signal.aborted) ctx.log("后台任务失败", error);
  });
}
```

- `ctx.onDispose(callback)`：回调按登记逆序执行，每个最多执行一次，单次等待上限 5 秒；单个失败或超时不阻止其余清理
- 插件进入停止阶段后不能再登记新的清理回调
- `unregister()` 仍可使用（同样 5 秒上限，需可重复调用不崩），适合显式编排或兼容旧写法

## ctx API 一览

| 方法 | 说明 |
|---|---|
| `ctx.registerTool(spec)` | 注册 AI 工具，id 必须 `<插件id>_` 前缀 |
| `ctx.unregisterTool(id)` | 只能注销本插件注册过的工具 |
| `ctx.registerPromptProvider(spec)` | 注册每轮动态提示词贡献；id 在当前插件内唯一，可按 chat/work/learn/code 过滤 |
| `ctx.unregisterPromptProvider(id)` | 只能注销本插件注册过的提示词 Provider |
| `ctx.events.on(event, listener)` | 订阅 `host:*` 或 `plugin:<id>:*` 事件；停用时自动退订 |
| `ctx.events.emit(event, payload)` | 发布当前插件自有事件；框架自动添加 `plugin:<id>:` 前缀 |
| `ctx.registerIpc(channel, handler)` | 注册私有 IPC，实际通道名 `plugin:<id>:<channel>`；channel 只允许字母数字 `.` `_` `-`，≤64 字符 |
| `ctx.signal` | 只读 AbortSignal；停止流程开始时先于 `unregister()` 被取消 |
| `ctx.onDispose(callback)` | 登记兜底清理回调（逆序执行，单个最多 5 秒） |
| `ctx.storage.set(key, value)` / `ctx.storage.get(key)` | 私有 JSON 存储，key 匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` |
| `ctx.registerChannelAdapter(adapter)` | 注册渠道适配器（需声明 `deps: ["channels"]`） |
| `ctx.deps.llm.generateText(messages, opts)` | 调用宿主 LLM（需声明 `deps: ["llm"]`） |
| `ctx.deps.channels.has(id)` | 只读查询渠道是否已存在 |
| `ctx.log(msg)` | 打日志 |

---

# 事件通信

订阅宿主或其他插件的事件：

```js
// 宿主生命周期事件
ctx.events.on("host:plugins:ready", ({ pluginIds }) => {
  ctx.log("插件系统就绪", pluginIds);
});
ctx.events.on("host:plugins:stopping", () => {
  ctx.log("应用要关机了，提前收尾");   // 在任何插件被注销之前发出
});

// 其他插件的事件（完整名 = plugin:<插件id>:<短名>）
ctx.events.on("plugin:weather:updated", (payload) => {
  ctx.log("天气更新了", payload);
});
```

发布自己的事件只用短名，框架自动补全 `plugin:<插件id>:` 前缀，**不能伪造宿主或其他插件的事件**：

```js
await ctx.events.emit("updated", { value: 1 });
// 订阅方收到：plugin:my-plugin:updated
```

规则速记：

- `on()` 返回幂等退订函数；插件停用/刷新/卸载时自动退订，进入停止阶段后不能再新增订阅
- 监听器按订阅顺序执行并等待异步结果；单个失败或超过 5 秒只跳过自己，不影响其他监听器
- 事件名 segment 只允许字母数字 `.` `_` `-`，≤64 字符
- 当前内置宿主事件：`host:plugins:ready`（payload `{ pluginIds: string[] }`）、`host:plugins:stopping`（无 payload）、`host:turn:completed`（详见下文）

---

# 动态提示词 Provider

```js
ctx.registerPromptProvider({
  id: "status",
  modes: ["chat", "work"],
  provide({ source, mode, userText, conversationId, channel, signal }) {
    if (signal.aborted) return "";
    return `插件运行状态：online；当前模式：${mode}`;
  },
});
```

- 框架自动命名为 `plugin:<插件id>:<provider-id>`，不同插件可复用相同短 id。
- `modes` 缺省覆盖 chat/work/learn/code；定时任务以 `source: "scheduler"`、`mode: "work"` 调用。
- 内容进入每轮 runtime context，不修改核心提示词文件或稳定缓存前缀。
- 多个 Provider 并行生成、按注册顺序拼接；单个最多等待 2 秒、16000 字符，总计最多 32000 字符。
- 失败、超时或返回空字符串只跳过当前 Provider；插件停止时自动注销。

---

# 宿主对话轮次完成事件

```js
ctx.events.on("host:turn:completed", ({
  source, mode, conversationId, channel, runId,
}) => {
  // 旁路通知不会阻塞主回复；耗时处理应自行排队，并响应 ctx.signal。
});
```

- 仅在桌面或外部渠道的一轮对话成功完成并执行宿主收尾后发布。
- `source` 为 `desktop` 或 `channel`；`channel` 仅渠道来源提供，`runId` 仅可取得时提供。
- 首版 payload 只含轮次元数据，不向插件广播用户或助手的对话原文。
- 不含完整历史、模型配置或工具内部状态；如需文本字段，应另行评审权限与兼容边界。

---

# 工具 spec 详解

```js
ctx.registerTool({
  id: "my-plugin_hello",        // 铁律：<插件id>_ 前缀
  name: "打招呼",
  description: "用户让你打招呼时使用",  // 写给 AI 看，决定 AI 是否调用
  enabled: true,
  risk: "safe",
  effectKind: "read",           // read（只读）/ write（有副作用）
  inputSchema: {
    type: "object",
    properties: {
      minutes: { type: "number", description: "多少分钟后" },
      text: { type: "string", description: "提醒内容" },
    },
    required: ["minutes"],
  },
  async execute(args) {
    // args 由 AI 按 schema 填好传入
    return "返回字符串进入对话上下文";
  },
});
```

---

# LLM 依赖

manifest：`"deps": ["llm"]`

```js
const text = await ctx.deps.llm.generateText(
  [{ role: "user", content: "把这段话翻译成英文：……" }],
  {
    purpose: "summary",    // 仅诊断标签，不影响模型选择
    maxTokens: 1024,       // 1-8192，缺省 1024
    timeoutMs: 30000,      // 1000-300000，缺省封顶 120 秒
  }
);
```

走宿主的模型配置、队列、限流、重试和用量统计，无需自带 key。

---

# 生命周期与状态

```text
scan -> disabled（用户插件首次发现默认停用）
  -> 用户开启 -> starting -> running
  -> 用户停用 -> stopping -> disabled
  -> 启动报错 -> failed（插件面板显示错误，卡片有“重试”）
```

- 所有 enable/disable/open/rescan/install/uninstall 操作走同一串行队列，不会并发重复注册
- 插件面板区分 `configuredEnabled`（用户想不想开）与 `status`（实际运行状态）

---

# 目录与 zip 导入限制

## 插件目录

```text
userData/plugins/<plugin-id>/      # 用户插件（打包版 = %APPDATA%\live2d-cyrene\plugins\）
src/plugins/<plugin-id>/           # 内置插件（随应用构建）
userData/plugin-data/<plugin-id>/  # 插件私有数据，卸载不删
```

## zip 结构（两种都行）

```text
my-plugin.zip
└── my-plugin/
    ├── manifest.json
    └── index.cjs
```

或 manifest + 入口直接放 zip 根目录。

## 导入校验限制

- zip ≤ 50 MiB；条目 ≤ 2000；单文件解压后 ≤ 50 MiB；总解压量 ≤ 200 MiB
- 拒绝：加密 zip、绝对路径、`..` 路径、符号链接、Windows 保留路径、大小写冲突路径、异常压缩比
- 新导入一律停用；替换已有插件会先确认、备份旧目录、失败自动回滚，且保留 `plugin-data/` 与启用状态
- 导入走 staging 临时目录 + 原子 rename，不会出现装了一半的插件

## 刷新与更新

聊天窗口插件面板的“刷新插件”会重扫目录、清 CommonJS 模块缓存、以 cache-busting 重新导入 ESM、重新激活。改了代码不生效就点它。
