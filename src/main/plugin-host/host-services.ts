import path from "node:path";
import type { PluginLlmService } from "../../plugins/api";
import type { PluginHostServiceFactory } from "../../plugins/context";
import type { ChatSession, ChatSessionMeta } from "../../shared/chat-types";
import {
  createPluginConversationsService,
  type PluginChatsStoreReader,
} from "./conversations-service";
import { createPluginSchedulerService, type PluginSchedulerStore } from "./scheduler-service";
import { createPluginSecretsService, type SafeStorageLike } from "./secrets-service";
import {
  createPluginWorkspaceService,
  type PluginWorkspaceStoreReader,
} from "./workspace-service";

/** 宿主服务装配所需的会话存储只读视图（列表 + 会话 + 工作区绑定）。 */
export interface PluginHostChatsReader
  extends PluginChatsStoreReader, PluginWorkspaceStoreReader {}

export interface PluginHostServicesOptions {
  /** plugin-data 根目录；密钥目录为 plugin-data/<pluginId>/secrets/。 */
  pluginDataRoot: string;
  channelManager: { has(channelId: string): boolean };
  /** 基础 LLM 服务；purpose 前缀由框架按 pluginId 统一包装。 */
  llm: PluginLlmService;
  storage: SafeStorageLike;
  chatsReader: PluginHostChatsReader;
  /** 调度存储；必须在 store.load() 完成后再创建工厂，否则插件写入会覆盖磁盘数据。 */
  schedulerStore: PluginSchedulerStore;
}

/**
 * 宿主服务装配：所有插件可用的宿主能力都在这里拼装成工厂。
 * 后续新服务（scheduler、speechInput 等）只扩展本工厂，
 * 不再向 PluginContext 增加特例。
 */
export function createHostServiceFactory(options: PluginHostServicesOptions): PluginHostServiceFactory {
  return {
    createForPlugin({ pluginId, signal }) {
      return {
        channels: { has: (channelId) => options.channelManager.has(channelId) },
        llm: options.llm,
        secrets: createPluginSecretsService({
          pluginId,
          secretsRoot: path.join(options.pluginDataRoot, pluginId, "secrets"),
          storage: options.storage,
          signal,
        }),
        workspace: createPluginWorkspaceService({
          reader: options.chatsReader,
          signal,
        }),
        conversations: createPluginConversationsService({
          reader: options.chatsReader,
          signal,
        }),
        scheduler: createPluginSchedulerService({
          pluginId,
          store: options.schedulerStore,
          signal,
        }),
      };
    },
  };
}
