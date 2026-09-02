# Cyrene 插件开发指南

> 面向想给 Cyrene（昔涟）写插件的社群朋友。不需要读过源码，只要会一点 JavaScript 就能跟着做完。
>
> 完整的接口规范见同目录的 [plugin-authoring.md](./plugin-authoring.md)，本文是它的教程版。

---

## 插件是什么，能做什么

一个插件就是一个文件夹，里面放一个清单文件和一个 JS 入口文件。装进 Cyrene 后，它能：

| 能力 | 举例 |
|---|---|
| **注册 AI 工具** | 昔涟在对话里能查系统状态、查天气、操作你的番茄钟 |
| **弹自己的窗口** | 一个独立界面，想画什么都行（HTML/CSS 随便写） |
| **调用宿主的 AI** | 插件自己也能调 LLM，不用配 API key（复用 Cyrene 的模型配置） |
| **接入新聊天渠道** | 把昔涟接到 Telegram、Discord 等平台（进阶） |
| **事件通信** | 监听宿主生命周期事件、和其他插件互通消息（收到"要关机了"提前收尾、天气更新通知别的插件） |
| **注入动态上下文** | 让昔涟主动"知道"实时状态——天气、日程、番茄钟，不用用户开口问 |
| **私有存储** | 自己的配置和数据，卸载插件也不丢 |

**重要认知**：插件和 Cyrene 本体运行在同一个进程里，拥有完整的 Node.js 权限（能读写文件、开进程、联网）。所以 Cyrene 只运行你信任的插件——这也意味着**你写的插件什么都能干**，不用被权限卡住。

---

## 五分钟做一个最小插件

### 1. 建目录

```text
my-first-plugin/
  manifest.json
  index.cjs
```

### 2. 写 manifest.json

```json
{
  "apiVersion": 1,
  "id": "my-first-plugin",
  "name": "我的第一个插件",
  "version": "1.0.0",
  "description": "打个招呼",
  "author": "你的名字",
  "entry": "index.cjs",
  "defaultEnabled": false
}
```

字段规则速记：

- `id`：全小写，可用连字符，如 `my-first-plugin`。它决定工具名前缀和安装目录名
- `version`：必须是标准 SemVer（`1.0.0` 这种三段式）
- `author`：插件开发者或团队名称，会作为“开发者”信息展示在插件卡片中
- `entry`：入口文件名，支持 `.cjs` / `.js` / `.mjs`
- `icon`（可选）：插件图标文件名，支持 `.png` / `.jpg` / `.webp` / `.svg`（≤2MiB），会在聊天窗口插件卡片左侧展示；不写不影响任何功能，写了但文件有问题会被静默忽略（插件照常加载）

### 3. 写 index.cjs

```js
"use strict";

module.exports = {
  async register(ctx) {
    // 注册一个 AI 工具：昔涟被问到时自动调用
    ctx.registerTool({
      id: "my-first-plugin_hello",   // 必须以 "<plugin-id>_" 开头！
      name: "打招呼",
      description: "用户让你打招呼时使用这个工具",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        return "你好呀！这是来自插件的问候 ♪";
      },
    });

    ctx.log("插件已注册");
  },

  async unregister() {
    // 停用/卸载时被调用，在这里关窗口、清定时器
  },
};
```

### 4. 打包安装

把 `my-first-plugin` 文件夹压成 zip（两种结构都行）：

```text
my-first-plugin.zip
└── my-first-plugin/
    ├── manifest.json
    └── index.cjs
```

或者直接把 manifest 和入口放 zip 根目录也可以。

然后：**Cyrene 聊天窗口 → 插件 → 右上角添加按钮 → 选 zip**。插件出现在列表且默认停用——这是刻意的安全设计，装进来不等于运行，点击“启用”才真正加载。

### 5. 验证

对昔涟说“打个招呼”，她会调用你注册的工具并转述返回内容。去聊天窗口的插件面板看状态是 `running` 就说明成功。

---

## 工具（Tool）写法详解

工具是插件最常用的形态——给昔涟的能力清单加一行。

### 带参数的工具

```js
ctx.registerTool({
  id: "my-plugin_remind",
  name: "提醒我",
  description: "设置一个提醒，minutes 分钟后提示用户",
  enabled: true,
  risk: "safe",
  effectKind: "write",   // 有副作用时用 write
  inputSchema: {
    type: "object",
    properties: {
      minutes: { type: "number", description: "多少分钟后提醒" },
      text: { type: "string", description: "提醒内容" },
    },
    required: ["minutes"],
  },
  async execute(args) {
    // args 由 AI 按上面的 schema 填好传进来
    const { minutes, text = "时间到啦" } = args;
    setTimeout(() => { /* 到点后做事 */ }, minutes * 60_000);
    return `好的，${minutes} 分钟后提醒你：${text}`;
  },
});
```

### 关键规则

- **id 必须以 `<插件id>_` 开头**（如插件 id 是 `my-plugin`，工具就得叫 `my-plugin_xxx`），否则启用直接报错——这是防抢名机制
- **description 写给 AI 看**，写清楚“什么场景该用这个工具”，直接决定 AI 用不用它
- `execute` 返回**字符串**（或可序列化对象），这段文字会进入对话上下文
- 常用风险标注：只读查询 `risk: "safe"` + `effectKind: "read"`；有副作用（写文件、发消息）用 `effectKind: "write"`

---

## 弹窗 UI 写法

实现 `open()` 后，聊天窗口插件卡片的“打开”按钮会变为可用。最省事的做法：`ui.html` 随插件打包，用 `BrowserWindow` 加载。

```js
const path = require("node:path");
let win = null;

module.exports = {
  async register(ctx) {
    ctx.registerIpc("ping", () => ({ time: Date.now() })); // 插件私有数据通道
  },

  async open() {
    if (win && !win.isDestroyed()) { win.focus(); return; } // 已开就聚焦
    const { BrowserWindow } = require("electron");
    win = new BrowserWindow({
      width: 480,
      height: 360,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.on("closed", () => { win = null; });
    await win.loadFile(path.join(__dirname, "ui.html"));
  },

  async unregister() {
    if (win && !win.isDestroyed()) win.close(); // 不留孤儿窗口
  },
};
```

`ui.html` 里通过插件私有 IPC 拉数据：

```html
<script>
  const { ipcRenderer } = require("electron");
  // 通道名规则：plugin:<插件id>:<你注册的channel名>
  const data = await ipcRenderer.invoke("plugin:my-plugin:ping");
</script>
```

**无边框窗口**：加 `frame: false` 可去掉系统标题栏，自己在 HTML 里画一条（记得放最小化/关闭按钮——拖拽区用 CSS `-webkit-app-region: drag`，按钮区 `no-drag`，不然按钮点不到）。完整范例见仓库 `examples/system-status/`。

窗口控制按钮在渲染进程发消息、主进程执行：

```js
// index.cjs 里（open() 内）
const { ipcMain } = require("electron");
const onMin = () => win?.minimize();
const onClose = () => win?.close();
ipcMain.on("plugin:my-plugin:win-minimize", onMin);
ipcMain.on("plugin:my-plugin:win-close", onClose);
win.on("closed", () => {
  ipcMain.removeListener("plugin:my-plugin:win-minimize", onMin);
  ipcMain.removeListener("plugin:my-plugin:win-close", onClose);
});
```

```js
// ui.html 里
btnMin.addEventListener("click", () => ipcRenderer.send("plugin:my-plugin:win-minimize"));
btnClose.addEventListener("click", () => ipcRenderer.send("plugin:my-plugin:win-close"));
```

---

## 调用宿主的 LLM

manifest 声明 `"deps": ["llm"]` 后，插件可以复用 Cyrene 里配好的模型（排队、限流、重试、用量统计都走宿主，不用自己管）：

```json
{ "deps": ["llm"] }
```

```js
const text = await ctx.deps.llm.generateText(
  [{ role: "user", content: "把这段话翻译成英文：……" }],
  { purpose: "translate", maxTokens: 1024, timeoutMs: 30000 }
);
```

---

## 给每轮对话补充动态上下文

需要让昔涟知道插件的实时状态时，不必修改主程序的 `soul.md`。注册一个提示词 Provider 即可：

```js
ctx.registerPromptProvider({
  id: "status",
  modes: ["chat"],
  async provide({ userText, signal }) {
    if (signal.aborted) return "";
    return `番茄钟状态：专注中；用户本轮问题：${userText}`;
  },
});
```

- `id` 只需在当前插件内唯一，框架会自动加插件命名空间
- `modes` 可选：`chat` / `work` / `learn` / `code`；不写表示全部模式
- 返回空字符串表示本轮不注入
- 单个 Provider 最多等待 2 秒、最多 16000 字符；失败或超时不会打断对话
- 所有插件合计最多注入 32000 字符
- 停用插件时会自动注销；也可调用 `ctx.unregisterPromptProvider("status")`

这些内容只进入每轮动态上下文，不会改写核心提示词文件，也不会进入稳定提示词缓存前缀。

---

## 私有存储

```js
ctx.storage.set("config", { endpoint: "https://example.com" }); // 写
const config = ctx.storage.get("config");                        // 读
```

每个 key 是一个 JSON 文件，存在 `plugin-data/<你的插件id>/` 下，**卸载重装都在**（卸载只删程序目录）。

---

## 事件订阅与发布

监听宿主事件：

```js
ctx.events.on("host:plugins:ready", ({ pluginIds }) => {
  ctx.log("插件系统已就绪", pluginIds);
});
```

监听其他插件事件：

```js
ctx.events.on("plugin:weather:updated", (payload) => {
  ctx.log("天气已更新", payload);
});
```

发布自己的事件时只写短名称，Cyrene 会自动添加当前插件 id，防止伪造宿主或其他插件事件：

```js
await ctx.events.emit("updated", { value: 1 });
// 完整事件名：plugin:<你的插件id>:updated
```

`ctx.events.on()` 返回退订函数；即使不手动调用，停用或刷新插件时也会自动清理，进入停止
阶段后不能再新增订阅。异步监听器会被等待，某个监听器报错或执行超过 5 秒不会影响其他
监听器。当前宿主内置事件为：

- `host:plugins:ready`：插件系统启动完成；
- `host:plugins:stopping`：插件系统开始停止；
- `host:turn:completed`：桌面或外部渠道的一轮对话成功完成。首版 payload 仅含
  `source`、`mode`、`conversationId` 和可选 `channel` / `runId`，不广播对话原文，
  也不含完整历史、模型配置或工具内部状态。

```js
ctx.events.on("host:turn:completed", ({ conversationId, source, mode }) => {
  // 宿主不会等待这里的异步工作；耗时任务应自行排队，并响应 ctx.signal。
  ctx.log(`${source} 的会话 ${conversationId} 已完成一轮 ${mode} 对话`);
});
```

---

## 生命周期速查

```text
扫描发现 → disabled（默认停用）
  → 用户开启 → starting → running
  → 用户停用 → stopping → disabled
  → 启动失败 → failed（卡片上有"重试"按钮）
```

- `register(ctx)`：启用时调用，报错则进入 failed
- `unregister()`：停用/刷新/退出时调用，**必须在这里清理窗口、定时器、子进程**，且要能被重复调用而不崩；单次等待上限为 5 秒
- `ctx.signal`：停用、刷新、卸载、退出或启动回滚时会先被取消，适合传给支持 `AbortSignal` 的后台工作
- `ctx.onDispose(callback)`：登记兜底清理回调；框架会按登记的逆序等待执行，每个回调最多等待 5 秒，单个回调失败或超时不会阻止其他资源释放
- 所有操作走串行队列，用户连点按钮也不会并发炸

推荐让框架托管插件资源的停止时机：

```js
async register(ctx) {
  const timer = setInterval(() => { /* background work */ }, 30_000);
  ctx.onDispose(() => clearInterval(timer));

  void runBackgroundWork({ signal: ctx.signal }).catch((error) => {
    if (!ctx.signal.aborted) ctx.log("后台任务失败", error);
  });
}
```

`unregister()` 仍可用于兼容已有插件或需要显式编排的清理；不要在收到停止信号后继续注册新的清理回调。

---

## 打包与分发注意事项

- zip 限制：≤50 MiB、≤2000 个条目、解压总量 ≤200 MiB；加密 zip、符号链接、`..` 路径都会被拒
- 图片等资源直接放插件目录里随包分发，HTML 里用相对路径引用
- **更新插件**：直接导入同名新版本 zip，Cyrene 会确认替换、自动备份旧版、保留你的私有数据和启用状态
- 版本号记得改 manifest 的 `version`，方便用户区分

## 常见坑

| 症状 | 原因 |
|---|---|
| 启用报错“工具 id 必须以 xxx 开头” | 工具 id 没加 `<插件id>_` 前缀 |
| 启用报错“version 不是 SemVer” | 版本号要写 `1.0.0`，不能是 `1.0` 或 `v1.0` |
| 启用报错“deps 含未知值” | `deps` 只接受 `channels` / `llm`，检查拼写 |
| AI 不用我的工具 | description 没写清楚使用场景，AI 不知道何时该调 |
| 弹窗图片不显示 | 用相对路径且文件确实打进了包里 |
| 改了代码没生效 | 聊天窗口插件面板点“刷新插件”（会清模块缓存重新加载） |
| 重复注册渠道失败 | 渠道 id 不能用 `feishu` 等内置名 |

## 参考实现

仓库 `examples/system-status/` 是一个完整的官方示例插件，覆盖了本指南全部知识点：多工具注册、带参数 schema、nvidia-smi 子进程调用、PowerShell 数据采集、无边框自绘标题栏窗口、私有 IPC 轮询刷新。写自己的插件前建议通读一遍。
