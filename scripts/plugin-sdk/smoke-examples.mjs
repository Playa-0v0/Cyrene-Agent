// 示例插件冒烟测试：在临时项目内运行（SDK 已从 tarball 安装到 node_modules）。
// 验证每个示例能 register、工具 id 契约正确、stop 流程无异常。
import { createRequire } from "node:module";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { createMockPluginContext, assertPluginTool, assertValidManifest } = require("@cyrene/plugin-sdk/testing");

const installRoot = process.argv[2];
const pluginDirs = await readdir(installRoot);

/** 按示例声明的 deps 提供最小假服务。 */
function mockDeps(manifest) {
  const deps = {};
  for (const dep of manifest.deps ?? []) {
    if (dep === "secrets") {
      deps.secrets = { get: async () => undefined, set: async () => undefined, delete: async () => false };
    } else if (dep === "scheduler") {
      const task = {
        id: "task-1", title: "t", prompt: "p", mode: "chat",
        schedule: { kind: "daily", timeOfDay: "09:00" }, allowedToolIds: [],
        enabled: false, nextFireAt: null, createdAt: "", updatedAt: "",
      };
      deps.scheduler = {
        createTask: async () => ({ ...task }),
        listTasks: async () => [{ ...task }],
        updateTask: async () => ({ ...task }),
        deleteTask: async () => true,
        getHistory: async () => [],
      };
    } else if (dep === "speech-input") {
      deps.speechInput = {
        acquire: async () => ({
          commit: async () => undefined,
          release: async () => undefined,
          signal: new AbortController().signal,
        }),
      };
    } else if (dep === "llm") {
      deps.llm = { generateText: async () => "摘要" };
    } else if (dep === "conversations") {
      deps.conversations = {
        list: async () => ({ items: [] }),
        getMessages: async () => ({ items: [], range: {} }),
      };
    }
  }
  return deps;
}

let failed = false;
for (const dir of pluginDirs) {
  const pluginDir = path.join(installRoot, dir);
  try {
    const manifest = JSON.parse(await readFile(path.join(pluginDir, "manifest.json"), "utf8"));
    assertValidManifest(manifest);

    // manifest.entry 指向的产物必须存在且可加载
    const plugin = require(path.join(pluginDir, manifest.entry));
    if (typeof plugin?.register !== "function") {
      throw new Error("入口导出缺少 register 函数");
    }

    const ctx = createMockPluginContext({ pluginId: manifest.id, deps: mockDeps(manifest) });
    if (plugin.open) await plugin.open();
    await plugin.register(ctx);
    for (const tool of ctx.tools) {
      assertPluginTool(tool, manifest.id);
    }

    // 停止流程：unregister 与框架清理路径都不抛错
    await ctx.dispose();
    if (plugin.unregister) await plugin.unregister();

    console.log(`[smoke] ${dir}: register ${ctx.tools.length} 个工具, 契约通过`);
  } catch (error) {
    failed = true;
    console.error(`[smoke] ${dir} 失败:`, error);
  }
}
if (failed) process.exit(1);
