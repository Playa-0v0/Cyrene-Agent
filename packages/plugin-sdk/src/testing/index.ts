/**
 * 插件测试工具：脱离 Cyrene 宿主即可验证插件的基本契约。
 *
 * createMockPluginContext 提供可内省的 PluginContext 假实现；
 * assertPluginTool / assertValidManifest 提供发布前契约断言。
 */
import type {
  PluginChannelAdapter,
  PluginCleanup,
  PluginContext,
  PluginDeps,
  PluginEvents,
  PluginPromptProvider,
  PluginStorage,
  PluginTool,
} from "../api";
import { validateManifestData } from "../validate-manifest";

/** 订阅记录：供测试断言插件监听了哪些事件。 */
interface RecordedSubscription {
  event: string;
  listener: (payload: unknown) => void | Promise<void>;
}

export interface MockPluginContext extends PluginContext {
  /** registerTool 登记的工具副本，按注册顺序排列。 */
  readonly tools: PluginTool[];
  /** registerPromptProvider 登记的 Provider 副本。 */
  readonly promptProviders: PluginPromptProvider[];
  /** registerIpc 登记的 channel 名到处理函数的映射。 */
  readonly ipcChannels: Map<string, (...args: unknown[]) => unknown>;
  /** 插件通过 events.emit 发布的事件记录。 */
  readonly emittedEvents: Array<{ event: string; payload: unknown }>;
  /** events.on 订阅记录；测试可向监听器手动派发 payload。 */
  readonly subscriptions: RecordedSubscription[];
  /** onDispose 登记的清理回调，按登记顺序排列。 */
  readonly cleanups: PluginCleanup[];
  /** 模拟宿主停止：触发 signal、按逆序执行清理回调。 */
  dispose(): Promise<void>;
}

export interface MockPluginContextOptions {
  /** 默认 "mock-plugin"；决定工具 id 前缀等命名空间。 */
  pluginId?: string;
  /** 注入的宿主服务；缺省为空对象（所有能力都未提供）。 */
  deps?: PluginDeps;
}

export function createMockPluginContext(
  options: MockPluginContextOptions = {},
): MockPluginContext {
  const id = options.pluginId ?? "mock-plugin";
  const tools: PluginTool[] = [];
  const promptProviders: PluginPromptProvider[] = [];
  const ipcChannels = new Map<string, (...args: unknown[]) => unknown>();
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const subscriptions: RecordedSubscription[] = [];
  const cleanups: PluginCleanup[] = [];
  const storageMap = new Map<string, unknown>();
  const controller = new AbortController();
  let disposed = false;

  function assertAccepting(action: string): void {
    if (disposed) {
      throw new Error(`插件停止后不能再${action}`);
    }
  }

  const storage: PluginStorage = {
    get<T>(key: string): T | undefined {
      return storageMap.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      storageMap.set(key, value);
    },
    rootDir(): string {
      return "/mock/plugin-data";
    },
  };

  const events: PluginEvents = {
    on(event, listener) {
      assertAccepting("订阅事件");
      subscriptions.push({ event, listener: listener as (payload: unknown) => void | Promise<void> });
      return () => {
        const index = subscriptions.findIndex((s) => s.listener === listener && s.event === event);
        if (index >= 0) subscriptions.splice(index, 1);
      };
    },
    async emit(event, payload) {
      emittedEvents.push({ event, payload });
    },
  };

  const ctx: MockPluginContext = {
    id,
    signal: controller.signal,
    onDispose(cleanup) {
      assertAccepting("注册清理回调");
      cleanups.push(cleanup);
    },
    events,
    registerTool(tool) {
      assertAccepting("注册工具");
      tools.push({ ...tool });
    },
    unregisterTool(toolId) {
      const index = tools.findIndex((t) => t.id === toolId);
      if (index < 0) {
        throw new Error(`不能注销不属于当前插件的工具: ${toolId}`);
      }
      tools.splice(index, 1);
    },
    registerPromptProvider(provider) {
      assertAccepting("注册提示词 Provider");
      promptProviders.push(provider);
    },
    unregisterPromptProvider(providerId) {
      const index = promptProviders.findIndex((p) => p.id === providerId);
      if (index < 0) {
        throw new Error(`不能注销不属于当前插件的提示词 Provider: ${providerId}`);
      }
      promptProviders.splice(index, 1);
    },
    registerIpc(channel, handler) {
      assertAccepting("注册 IPC channel");
      if (ipcChannels.has(channel)) {
        throw new Error(`插件 IPC channel 已注册: ${channel}`);
      }
      ipcChannels.set(channel, handler);
    },
    unregisterIpc(channel) {
      if (!ipcChannels.delete(channel)) {
        throw new Error(`不能注销不属于当前插件的 IPC channel: ${channel}`);
      }
    },
    async registerChannelAdapter(adapter) {
      throw new Error(`Mock Context 不支持注册渠道（${adapter.id}）：请使用真实宿主验证渠道插件`);
    },
    async unregisterChannelAdapter(channelId) {
      throw new Error(`Mock Context 未注册任何渠道: ${channelId}`);
    },
    storage,
    deps: options.deps ?? {},
    log() {
      /* 测试环境默认静默；需要观察日志时自行包裹 */
    },
    tools,
    promptProviders,
    ipcChannels,
    emittedEvents,
    subscriptions,
    cleanups,
    async dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      // 与宿主一致：清理按登记逆序执行，单项失败不阻断其余
      const errors: unknown[] = [];
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new Error(`清理回调抛出 ${errors.length} 个错误`);
      }
    },
  };

  return ctx;
}

/**
 * 工具契约断言：校验宿主 registerTool 会拒绝的常见问题。
 * 汇总全部违规后一次性抛出，便于插件作者一次修复。
 */
export function assertPluginTool(tool: PluginTool, pluginId: string): void {
  const problems: string[] = [];
  if (!tool.id.startsWith(`${pluginId}_`)) {
    problems.push(`工具 id 必须以 "${pluginId}_" 开头: ${tool.id}`);
  }
  if (!tool.name) problems.push("工具缺少 name");
  if (!tool.description) problems.push(`工具 ${tool.id} 缺少 description`);
  if (tool.inputSchema?.type !== "object") {
    problems.push(`工具 ${tool.id} 的 inputSchema.type 必须是 "object"`);
  }
  if (typeof tool.execute !== "function") {
    problems.push(`工具 ${tool.id} 的 execute 必须是函数`);
  }
  if (problems.length > 0) {
    throw new Error(`插件工具契约不满足:\n- ${problems.join("\n- ")}`);
  }
}

/** Manifest 契约断言：结构、类型、枚举与必填字段，失败抛出人读错误。 */
export function assertValidManifest(data: unknown): void {
  const result = validateManifestData(data);
  if (!result.ok) {
    throw new Error(result.error ?? "manifest 结构不合法");
  }
}
