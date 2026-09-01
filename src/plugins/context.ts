import type { ChannelAdapter } from "../main/channels/adapters/base";
import type { ToolDefinition } from "../main/orchestrator/tools/registry/tool-registry";
import type { PluginEventBus } from "./events";
import { qualifyPluginEvent } from "./events";
import { createPluginStorage } from "./storage";
import type {
  PluginChannelAdapter,
  PluginCleanup,
  PluginContext,
  PluginDeps,
  PluginLlmService,
  PluginManifest,
  PluginPermissionService,
  PluginPromptProvider,
  PluginSubprocessService,
  PluginTool,
} from "./types";
import type { PluginPromptRegistry } from "./prompts";

const IPC_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const PLUGIN_CLEANUP_TIMEOUT_MS = 5_000;

/** 等待单次第三方清理钩子；超时后抛错，让框架继续回收其余资源。 */
export async function runPluginCleanup(
  cleanup: () => void | Promise<void>,
  label: string,
): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    // 保持既有语义：清理函数在调用 dispose/unregister 的当前轮同步开始执行。
    const cleanupPromise = Promise.resolve(cleanup());
    await Promise.race([
      cleanupPromise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} 清理超时（${PLUGIN_CLEANUP_TIMEOUT_MS}ms）`));
        }, PLUGIN_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export interface PluginRuntime {
  toolRegistry: {
    register(tool: ToolDefinition): void;
    unregister(id: string): boolean;
    /** 供冲突告警使用；不存在时跳过 */
    getById?(id: string): ToolDefinition | undefined;
  };
  channelManager: {
    has(id: string): boolean;
    register(adapter: ChannelAdapter): void;
    unregister(id: string): Promise<boolean>;
    startOne(id: string): Promise<void>;
  };
  registerIpc: (channel: string, handler: (...args: unknown[]) => unknown) => void;
  unregisterIpc: (channel: string) => void;
  promptRegistry: Pick<PluginPromptRegistry, "register" | "unregister">;
  llm?: PluginLlmService;
  permissions?: {
    forPlugin(id: string): PluginPermissionService;
    revokePlugin(id: string): void;
  };
  subprocess?: {
    forPlugin(id: string, signal: AbortSignal): PluginSubprocessService;
    stopPlugin(id: string): Promise<void>;
  };
}

interface DisposableContext extends PluginContext {
  /** 框架内部：在调用 plugin.unregister() 前进入停止阶段并触发取消。 */
  beginStop(): void;
  /** 框架内部：卸载插件时统一清理已注册资源 */
  dispose(): Promise<void>;
}

export function createContext(
  id: string,
  storageRoot: string,
  runtime: PluginRuntime,
  eventBus: Pick<PluginEventBus, "on" | "emit">,
  declaredDeps?: PluginManifest["deps"],
): DisposableContext {
  const registeredTools = new Set<string>();
  const registeredIpc = new Set<string>();
  const registeredAdapters = new Set<string>();
  const registeredPromptProviders = new Set<string>();
  const cleanupCallbacks: PluginCleanup[] = [];
  const abortController = new AbortController();
  let stopping = false;
  let disposed = false;
  // 缓存同一次释放任务，避免异步清理让出事件循环时发生并发重入。
  let disposePromise: Promise<void> | undefined;
  const eventUnsubscribers = new Set<() => void>();

  // deps 白名单生效：只有 manifest.deps 声明的依赖才会注入
  const deps: PluginDeps = {};
  if (declaredDeps?.includes("channels")) {
    deps.channels = { has: (channelId) => runtime.channelManager.has(channelId) };
  }
  if (declaredDeps?.includes("llm") && runtime.llm) {
    deps.llm = {
      generateText: (messages, options) => runtime.llm!.generateText(messages, {
        ...options,
        purpose: options?.purpose ? `${id}:${options.purpose}` : id,
      }),
    };
  }
  if (declaredDeps?.includes("permissions") && runtime.permissions) {
    deps.permissions = runtime.permissions.forPlugin(id);
  }
  if (declaredDeps?.includes("subprocess") && runtime.subprocess) {
    deps.subprocess = runtime.subprocess.forPlugin(id, abortController.signal);
  }

  const ctx: PluginContext = {
    id,
    signal: abortController.signal,
    onDispose(cleanup: PluginCleanup) {
      if (typeof cleanup !== "function") {
        throw new Error("插件清理回调必须是函数");
      }
      if (stopping || disposed) {
        throw new Error("插件停止后不能再注册清理回调");
      }
      cleanupCallbacks.push(cleanup);
    },
    events: {
      on(event, listener) {
        if (stopping || disposed) {
          throw new Error("插件停止后不能再订阅事件");
        }
        // Context 同时跟踪退订函数，确保插件停用时不会遗留跨生命周期监听器。
        const unsubscribeFromBus = eventBus.on(
          event,
          listener as (payload: unknown) => void | Promise<void>,
        );
        const unsubscribe = () => {
          unsubscribeFromBus();
          eventUnsubscribers.delete(unsubscribe);
        };
        eventUnsubscribers.add(unsubscribe);
        return unsubscribe;
      },
      emit(event, payload) {
        // 插件只能发布自己的命名空间，不能伪造宿主或其他插件事件。
        return eventBus.emit(qualifyPluginEvent(id, event), payload);
      },
    },
    registerTool(tool: PluginTool) {
      const expectedPrefix = `${id}_`;
      if (!tool.id.startsWith(expectedPrefix)) {
        throw new Error(`插件工具 id 必须以 "${expectedPrefix}" 开头: ${tool.id}`);
      }
      if (registeredTools.has(tool.id)) {
        throw new Error(`插件工具 id 已由当前插件注册: ${tool.id}`);
      }
      const existing = runtime.toolRegistry.getById?.(tool.id);
      if (existing) {
        throw new Error(`插件工具 id 已被占用: ${tool.id}`);
      }
      runtime.toolRegistry.register({ ...tool, ownerPluginId: id } as ToolDefinition);
      registeredTools.add(tool.id);
    },
    unregisterTool(toolId: string) {
      if (!registeredTools.has(toolId)) {
        throw new Error(`不能注销不属于当前插件的工具: ${toolId}`);
      }
      runtime.toolRegistry.unregister(toolId);
      registeredTools.delete(toolId);
    },
    registerPromptProvider(provider: PluginPromptProvider) {
      if (stopping || disposed) {
        throw new Error("插件停止后不能再注册提示词 Provider");
      }
      runtime.promptRegistry.register(id, provider, abortController.signal);
      registeredPromptProviders.add(provider.id);
    },
    unregisterPromptProvider(providerId: string) {
      if (!registeredPromptProviders.has(providerId)) {
        throw new Error(`不能注销不属于当前插件的提示词 Provider: ${providerId}`);
      }
      runtime.promptRegistry.unregister(id, providerId);
      registeredPromptProviders.delete(providerId);
    },
    registerIpc(channel: string, handler: (...args: unknown[]) => unknown) {
      if (!IPC_SEGMENT_RE.test(channel)) {
        throw new Error(`非法插件 IPC channel: ${channel}`);
      }
      const full = `plugin:${id}:${channel}`;
      if (registeredIpc.has(full)) {
        throw new Error(`插件 IPC channel 已注册: ${channel}`);
      }
      runtime.registerIpc(full, handler);
      registeredIpc.add(full);
    },
    unregisterIpc(channel: string) {
      const full = `plugin:${id}:${channel}`;
      if (!registeredIpc.has(full)) {
        throw new Error(`不能注销不属于当前插件的 IPC channel: ${channel}`);
      }
      runtime.unregisterIpc(full);
      registeredIpc.delete(full);
    },
    async registerChannelAdapter(adapter: PluginChannelAdapter) {
      if (registeredAdapters.has(adapter.id)) {
        throw new Error(`插件渠道 id 已由当前插件注册: ${adapter.id}`);
      }
      if (runtime.channelManager.has(adapter.id)) {
        throw new Error(`插件渠道 id 已被占用: ${adapter.id}`);
      }
      runtime.channelManager.register(adapter as unknown as ChannelAdapter);
      try {
        await runtime.channelManager.startOne(adapter.id);
      } catch (err) {
        // 半成功回滚：start 失败时撤销已注册的 adapter，避免 dispose 遗漏
        await runtime.channelManager.unregister(adapter.id);
        throw err;
      }
      registeredAdapters.add(adapter.id);
    },
    async unregisterChannelAdapter(channelId: string) {
      if (!registeredAdapters.has(channelId)) {
        throw new Error(`不能注销不属于当前插件的渠道: ${channelId}`);
      }
      await runtime.channelManager.unregister(channelId);
      registeredAdapters.delete(channelId);
    },
    storage: createPluginStorage(storageRoot),
    deps,
    log(...args: unknown[]) {
      console.log(`[plugin:${id}]`, ...args);
    },
  };

  return Object.assign(ctx, {
    beginStop() {
      if (stopping || disposed) return;
      stopping = true;
      abortController.abort();
    },
    dispose() {
      if (!disposePromise) {
        disposePromise = (async () => {
          if (!stopping) {
            stopping = true;
            abortController.abort();
          }
          const cleanupErrors: unknown[] = [];
          for (const unsubscribe of eventUnsubscribers) {
            try {
              unsubscribe();
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          runtime.permissions?.revokePlugin(id);
          if (runtime.subprocess) {
            try {
              await runPluginCleanup(() => runtime.subprocess!.stopPlugin(id), `插件 ${id} subprocess`);
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          eventUnsubscribers.clear();
          for (const cleanup of cleanupCallbacks.splice(0).reverse()) {
            try {
              await runPluginCleanup(cleanup, `插件 ${id} onDispose`);
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          for (const toolId of registeredTools) {
            try {
              runtime.toolRegistry.unregister(toolId);
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          registeredTools.clear();
          for (const providerId of registeredPromptProviders) {
            try {
              runtime.promptRegistry.unregister(id, providerId);
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          registeredPromptProviders.clear();
          for (const channel of registeredIpc) {
            try {
              runtime.unregisterIpc(channel);
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          registeredIpc.clear();
          const adapterIds = Array.from(registeredAdapters);
          registeredAdapters.clear();
          const adapterResults = await Promise.allSettled(
            adapterIds.map((adapterId) => runtime.channelManager.unregister(adapterId)),
          );
          for (const result of adapterResults) {
            if (result.status === "rejected") cleanupErrors.push(result.reason);
          }
          disposed = true;
          if (cleanupErrors.length > 0) {
            console.warn(`[plugin:${id}] 清理资源时发生 ${cleanupErrors.length} 个错误`, cleanupErrors);
          }
        })();
      }
      return disposePromise;
    },
  });
}
