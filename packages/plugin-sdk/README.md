# @cyrene/plugin-sdk

Cyrene 插件开发工具包。外部开发者不需要阅读 Cyrene 宿主源码即可完成插件开发。

## 安装

```bash
npm install @cyrene/plugin-sdk
```

## 用途

- **类型**：`import type { PluginContext, PluginTool, ... } from "@cyrene/plugin-sdk"` —— 全部公开契约类型。
- **常量**：`CURRENT_PLUGIN_API_VERSION`、`PLUGIN_CAPABILITIES`、`PLUGIN_HOST_ERROR_CODES`。
- **Manifest 校验**：`validateManifestData(data)` —— 用与宿主同一份 JSON Schema 校验 manifest.json。
- **测试工具**：`import { createMockPluginContext, assertPluginTool, assertValidManifest } from "@cyrene/plugin-sdk/testing"` —— 脱离宿主的 Mock Context 与契约断言。

SDK 只包含类型、常量与测试工具，不包含 Electron、React 或 Cyrene 宿主运行时；插件编译期依赖 SDK，打包后的插件目录不需要终端用户安装 SDK。

完整开发指南见 Cyrene 仓库 `docs/plugins/plugin-dev-guide.md`。
