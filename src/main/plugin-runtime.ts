import { app, dialog, safeStorage } from "electron";
import path from "node:path";
import { channelManager } from "./channels/manager";
import type { ChannelId } from "./channels/types";
import * as chatsStore from "./chats/chats-store";
import { toolRegistry } from "./orchestrator/tools/registry/tool-registry";
import { loadGeneralSettings, saveGeneralSettings } from "./settings/settings-facade";
import { loadModelSettings, resolveModelSettingsProfile } from "./settings/model-settings";
import { pluginGenerateText } from "./plugin-llm";
import { createHostServiceFactory } from "./plugin-host/host-services";
import type { PluginSchedulerStore } from "./plugin-host/scheduler-service";
import { PluginManager } from "../plugins/manager";
import { pluginPromptRegistry } from "../plugins/prompts";
import type { LlmClient } from "./services/llm/llm-client";
import { enqueueLLMTask } from "./llm-queue";
import type { IpcScope } from "./application/ipc-scope";

/** 调度存储视图：插件服务读写任务，卸载清理时按归属批量删除插件任务。 */
export type PluginRuntimeSchedulerStore = PluginSchedulerStore & {
  deleteTasksByOwner(pluginId: string): number;
};

export interface PluginRuntimeDeps {
  llmClient: LlmClient;
  ipc: IpcScope;
  /** 调度存储；必须已完成 load()（scheduler.initialize() 先于启动插件）。 */
  schedulerStore: PluginRuntimeSchedulerStore;
  /** 插件启停后回调：宿主让调度引擎重排计时器（不补跑）。 */
  onPluginRunningStateChange?: (pluginId: string, running: boolean) => void;
}

export async function startPluginRuntime(deps: PluginRuntimeDeps): Promise<PluginManager> {
  const userPluginRoot = path.join(app.getPath("userData"), "plugins");
  const pluginDataRoot = path.join(app.getPath("userData"), "plugin-data");
  const manager = new PluginManager({
    scanRoots: [
      { path: path.join(__dirname, "..", "plugins"), source: "builtin" },
      { path: userPluginRoot, source: "user" },
    ],
    storageRoot: pluginDataRoot,
    runtime: {
      toolRegistry,
      channelManager: {
        has: (id) => channelManager.has(id as ChannelId),
        register: (adapter) => channelManager.register(adapter),
        unregister: (id) => channelManager.unregister(id as ChannelId),
        startOne: (id) => channelManager.startOne(id as ChannelId),
      },
      registerIpc: (channel, handler) => {
        deps.ipc.handle(channel, (_event, ...args: unknown[]) => handler(...args));
      },
      unregisterIpc: (channel) => deps.ipc.removeHandler(channel),
      promptRegistry: pluginPromptRegistry,
      // 宿主服务统一从工厂注入：channels、llm、secrets、workspace、
      // conversations 和 scheduler 在 plugin-host/host-services.ts 装配；
      // 后续新服务只扩展装配工厂，不再向 PluginContext 加特例。
      hostServices: createHostServiceFactory({
        pluginDataRoot,
        channelManager: { has: (channelId) => channelManager.has(channelId as ChannelId) },
        llm: {
          generateText: (messages, options) => pluginGenerateText(
            messages,
            resolveModelSettingsProfile(loadModelSettings()),
            deps.llmClient,
            enqueueLLMTask,
            options,
          ),
        },
        storage: safeStorage,
        chatsReader: chatsStore,
        schedulerStore: deps.schedulerStore,
      }),
    },
    loadEnabledMap: () => loadGeneralSettings().plugins,
    saveEnabledMap: (plugins) => saveGeneralSettings({ plugins }),
    // 真正卸载时删除该插件创建的定时任务；清理失败由管理器中止目录删除。
    cleanupPersistentResources: async (pluginId) => {
      deps.schedulerStore.deleteTasksByOwner(pluginId);
    },
    selectPluginZip: async () => {
      const result = await dialog.showOpenDialog({
        title: "导入 Cyrene 插件",
        properties: ["openFile"],
        filters: [{ name: "Cyrene 插件包", extensions: ["zip"] }],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    confirmPluginReplace: async (plugin) => {
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "替换已有插件",
        message: `用户插件 ${plugin.name}（${plugin.id}）已经存在。`,
        detail: `是否用 ZIP 中的 ${plugin.version} 版本替换现有程序？插件私有数据将保留。`,
        buttons: ["取消", "替换"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
  });
  if (deps.onPluginRunningStateChange) {
    manager.onRunningStateChange(deps.onPluginRunningStateChange);
  }
  await manager.start();
  return manager;
}
