# 官方示例插件走读：system-status

一个完整的真实插件，覆盖全部知识点：多工具注册、带参数 schema、子进程数据采集、无边框自绘标题栏弹窗、私有 IPC 轮询刷新。写自己的插件前建议通读。

源码位置：仓库 `examples/system-status/`（开发版）。结构：

```text
system-status/
  manifest.json
  index.cjs      # 入口：工具注册 + IPC + 弹窗管理
  ui.html        # 弹窗界面（自绘标题栏 + 数据面板）
  avatar.png     # 随包分发的静态资源（同时充当插件图标）
```

## manifest.json

```json
{
  "apiVersion": 1,
  "id": "system-status",
  "name": "系统状态",
  "version": "0.1.0",
  "description": "查询系统状态：CPU/内存/GPU/磁盘/网络/电池",
  "author": "Cyrene",
  "entry": "index.cjs",
  "icon": "avatar.png",
  "defaultEnabled": false
}
```

`icon` 指向的图片会显示在聊天窗口插件卡片左侧；文件缺失或超限会被静默忽略，插件照常加载。

## 要点 1：两个工具，一个带参数

```js
ctx.registerTool({
  id: "system-status_status",
  name: "系统状态查询",
  description: "查询当前系统状态：CPU 占用与型号、内存使用、GPU 占用与温度、开机时长。用户询问电脑状态、剩余内存、显卡温度等时使用。",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  inputSchema: { type: "object", properties: {}, required: [] },
  async execute() { return buildStatusText(await collect()); },
});

ctx.registerTool({
  id: "system-status_disk",
  name: "磁盘占用查询",
  description: "查询磁盘分区占用。drive 参数为盘符（如 C、D），不传则返回全部分区。",
  inputSchema: {
    type: "object",
    properties: { drive: { type: "string", description: "盘符，如 C 或 D" } },
    required: [],
  },
  async execute(args) { /* ... */ },
});
```

- 两个 id 都以 `system-status_` 开头（插件 id 前缀铁律）
- description 把"用户会怎么问"写进去，AI 命中率高

## 要点 2：数据采集——原生优先，子进程兜底

- CPU 占用：`os.cpus()` 两次采样差分，零开销
- GPU 占用/温度/显存：优先 `nvidia-smi --query-gpu=... --format=csv`（有 N 卡驱动就有）；失败降级 WMI 性能计数器 `\GPU Engine(*)\Utilization Percentage`（只有占用）
- 磁盘/电池：一次 PowerShell `Get-CimInstance` 拿全
- 所有子进程：设超时；拿不到的数据返回 null，UI 显示"—"，绝不让面板崩

## 要点 3：无边框弹窗 + 自绘标题栏

```js
async open() {
  if (win && !win.isDestroyed()) { win.focus(); return; }  // 已开就聚焦
  const { BrowserWindow } = require("electron");
  win = new BrowserWindow({
    width: 860, height: 600,
    minWidth: 380, minHeight: 420,
    frame: false,                    // 无系统标题栏
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  // 窗口控制按钮：渲染进程 send，主进程 on
  const { ipcMain } = require("electron");
  const onMin = () => win?.minimize();
  const onClose = () => win?.close();
  ipcMain.on("plugin:system-status:win-minimize", onMin);
  ipcMain.on("plugin:system-status:win-close", onClose);
  win.on("closed", () => {
    win = null;
    ipcMain.removeListener("plugin:system-status:win-minimize", onMin);
    ipcMain.removeListener("plugin:system-status:win-close", onClose);
  });
  await win.loadFile(path.join(__dirname, "ui.html"));
}
```

ui.html 标题栏的关键 CSS：

```css
.titlebar { -webkit-app-region: drag; }       /* 整条可拖动窗口 */
.titlebar button { -webkit-app-region: no-drag; }  /* 按钮必须豁免，否则点不到 */
```

## 要点 4：私有 IPC + 前端轮询

```js
ctx.registerIpc("snapshot", async () => collect());  // 主进程注册
```

```js
// ui.html：每 3 秒拉一次，单次失败静默重试
async function tick() {
  try { render(await ipcRenderer.invoke("plugin:system-status:snapshot")); }
  catch { /* 静默，下轮再试 */ }
}
setInterval(tick, 3000);
```

## 要点 5：彻底清理

```js
async unregister() {
  if (pollTimer) clearInterval(pollTimer);
  if (win && !win.isDestroyed()) win.close();   // 不留孤儿窗口
}
```

## 拿它当模板改

1. 复制目录，改 manifest 的 `id`/`name`/`description`
2. 全文搜索旧 id（工具前缀、IPC 通道名都要跟着改）
3. 替换 `collect()` 数据源和 ui.html 面板内容
4. 版本号从 `0.1.0` 起步，每改一版递增

## TypeScript + SDK 示例索引

需要数据服务（Secrets、对话分页、调度任务）或语音输入租约时，参考 `examples/` 下四个 TypeScript 示例（`weather-tool`、`long-term-memory`、`scheduled-automation`、`local-asr-contract`）：它们用 `@playa0v0/cyrene-plugin-sdk` 的类型与测试工具编写，`npm run test:plugin-examples` 可从打包后的 SDK 编译并冒烟验证。
