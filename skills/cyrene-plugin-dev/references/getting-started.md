# 快速上手教程

## 五分钟做一个最小插件

### 1. 建目录

```text
my-first-plugin/
  manifest.json
  index.cjs
  icon.png     # 可选：插件图标（png/jpg/webp/svg，≤2MiB）
```

### 2. manifest.json

```json
{
  "apiVersion": 1,
  "id": "my-first-plugin",
  "name": "我的第一个插件",
  "version": "1.0.0",
  "description": "打个招呼",
  "author": "你的名字",
  "entry": "index.cjs",
  "icon": "icon.png",
  "defaultEnabled": false
}
```

### 3. index.cjs

```js
"use strict";

module.exports = {
  async register(ctx) {
    ctx.registerTool({
      id: "my-first-plugin_hello",   // 必须以 "<插件id>_" 开头！
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
  async unregister() {},
};
```

### 4. 打包安装

把 `my-first-plugin` 文件夹压成 zip（整体一个文件夹，或 manifest + 入口放 zip 根目录都行），然后：**Cyrene 聊天窗口 → 插件 → 右上角添加按钮 → 选 zip**。插件默认停用，点击“启用”才真正加载。

想让插件被更多人看到？提交 PR 到官方收录仓库 [Cyrene-Plugins](https://github.com/Playa-0v0/Cyrene-Plugins)，审核通过后其他用户可直接下载 ZIP 导入；想装别人写的插件也去那里找。

### 5. 验证

对昔涟说“打个招呼”，她会调用工具并转述返回内容；聊天窗口插件卡片状态为 `running` 即成功。

---

## 带参数的工具

```js
ctx.registerTool({
  id: "my-plugin_remind",
  name: "提醒我",
  description: "设置一个提醒，minutes 分钟后提示用户",
  enabled: true,
  risk: "safe",
  effectKind: "write",
  inputSchema: {
    type: "object",
    properties: {
      minutes: { type: "number", description: "多少分钟后提醒" },
      text: { type: "string", description: "提醒内容" },
    },
    required: ["minutes"],
  },
  async execute(args) {
    const { minutes, text = "时间到啦" } = args;
    setTimeout(() => { /* 到点后做事 */ }, minutes * 60_000);
    return `好的，${minutes} 分钟后提醒你：${text}`;
  },
});
```

要点：

- **description 写给 AI 看**，写清"什么场景该用"，直接决定 AI 用不用它
- `execute` 返回字符串（或可序列化对象），进入对话上下文

---

## 弹窗 UI

实现 `open()` 后聊天窗口插件卡片的“打开”按钮会变为可用：

```js
const path = require("node:path");
let win = null;

module.exports = {
  async register(ctx) {
    ctx.registerIpc("ping", () => ({ time: Date.now() }));
  },
  async open() {
    if (win && !win.isDestroyed()) { win.focus(); return; }
    const { BrowserWindow } = require("electron");
    win = new BrowserWindow({
      width: 480, height: 360,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.on("closed", () => { win = null; });
    await win.loadFile(path.join(__dirname, "ui.html"));
  },
  async unregister() {
    if (win && !win.isDestroyed()) win.close();
  },
};
```

`ui.html` 内通过私有 IPC 拉数据（通道名 `plugin:<插件id>:<channel>`）：

```html
<script>
  const { ipcRenderer } = require("electron");
  const data = await ipcRenderer.invoke("plugin:my-plugin:ping");
</script>
```

### 无边框窗口

`frame: false` 去掉系统标题栏，自己在 HTML 画。注意：

- 拖拽区 CSS：`-webkit-app-region: drag`；按钮区必须 `no-drag`，否则点不到
- 窗口控制按钮：渲染进程 `ipcRenderer.send(...)`，主进程 `ipcMain.on(...)` 执行 `win.minimize()/close()`
- `win.on("closed")` 里 `removeListener` 清理监听，不留垃圾

完整范例见 `references/example-walkthrough.md`。

---

## 进阶速览：事件与动态上下文

**事件**——监听宿主/其他插件，或广播自己的消息（发布只能用短名，框架自动加 `plugin:<插件id>:` 前缀，冒充不了别人）：

```js
ctx.events.on("host:plugins:stopping", () => saveState());   // 关机前收尾
ctx.events.on("plugin:weather:updated", (w) => refreshUi(w)); // 听别的插件
await ctx.events.emit("updated", { value: 1 });               // 广播自己的
```

**动态上下文**——让昔涟主动"知道"实时状态，不用用户开口问：

```js
ctx.registerPromptProvider({
  id: "pomodoro-status",
  modes: ["chat"],
  async provide({ userText, signal }) {
    if (signal.aborted) return "";
    return `番茄钟：专注中，剩余 12 分钟`;
  },
});
```

内容要短而精（只写本轮有用的事实），单项配额 2 秒 / 16000 字符。详细规则见 `references/api-spec.md`。

---

## 常见坑速查

| 症状 | 原因 |
|---|---|
| 启用报错“工具 id 必须以 xxx 开头” | 工具 id 没加 `<插件id>_` 前缀 |
| 启用报错“version 不是 SemVer” | 要写 `1.0.0`，不能 `1.0` / `v1.0` |
| 启用报错“deps 含未知值” | `deps` 接受 `channels` / `llm` / `secrets` / `workspace` / `conversations` / `scheduler` / `speech-input` |
| AI 不用我的工具 | description 没写清使用场景 |
| 弹窗图片不显示 | 相对路径 + 文件确实打进包 |
| 改了代码没生效 | 聊天窗口插件面板点“刷新插件”（清模块缓存） |
| 扫描警告“缺少 manifest.json” | zip 解压多套/少套了一层目录 |
| 弹窗白屏 | IPC 通道名拼错或 HTML 路径不对，`openDevTools()` 查 |

---

## 数据采集建议

- 优先 Node 原生（`os.cpus()`、`os.totalmem()`、`fs`）——零依赖、跨机稳
- 不够再用子进程：Windows 下 PowerShell（`Get-CimInstance`）、nvidia-smi（N 卡状态）
- 子进程必须：设超时、失败降级（返回 null 让 UI 显示"—"）、`windowsVerbatimArguments: true`、输出 UTF-8 优先解码 GBK 兜底
- CPU/网络速率这类“差分值”：两次采样做差再除以间隔时间
