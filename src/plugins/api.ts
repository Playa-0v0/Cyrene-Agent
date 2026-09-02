/**
 * Cyrene Plugin API v1.
 *
 * This file is the stable, plugin-facing contract. It deliberately does not
 * import from src/main or src/shared so internal application refactors do not
 * leak into third-party plugin types.
 */

export const CURRENT_PLUGIN_API_VERSION = 1 as const;

export type PluginCapability = "channels" | "llm";

export interface PluginManifest {
  /** Plugin API major version required by this plugin. */
  apiVersion: number;
  /** Unique lowercase id, for example "my-plugin". */
  id: string;
  name: string;
  /** Strict SemVer plugin version. */
  version: string;
  description: string;
  author: string;
  /** Bare file name inside the plugin directory. */
  entry: string;
  /** Optional bare icon file name inside the plugin directory (png/jpg/webp/svg). */
  icon?: string;
  /** Honored only for bundled plugins. User plugins always require opt-in. */
  defaultEnabled: boolean;
  /** Host services requested from Cyrene. This is not a security sandbox. */
  deps?: PluginCapability[];
}

export type PluginJsonSchema = {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  properties?: Record<string, PluginJsonSchema>;
  items?: PluginJsonSchema;
  required?: string[];
};

export interface PluginToolContext {
  userQuery: string;
  conversationId?: string;
  runId?: string;
  signal?: AbortSignal;
  resolvedWorkspaceRoot?: string;
  mode?: "chat" | "learn" | "code" | "work";
  permissionMode?: "normal" | "allow_all";
  metadata?: Record<string, unknown>;
}

export interface PluginTool {
  id: string;
  name: string;
  description: string;
  catalogHint?: string;
  category?: string;
  capability?: string;
  enabled: boolean;
  risk?: "safe" | "fs-read" | "fs-write" | "shell" | "network" | "input-control";
  modes?: Array<"learn" | "code" | "work">;
  inputSchema: {
    type: "object";
    properties: Record<string, PluginJsonSchema>;
    required?: string[];
  };
  needsContext?: boolean;
  ledgerPolicy?: "success_terminal" | "bypass";
  deprecated?: boolean;
  effectKind?: "read" | "mutation" | "verification" | "external_side_effect" | "unknown";
  verificationPolicy?: "none" | "artifact" | "code" | "unknown";
  execute(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<string>;
}

export interface PluginChannelCapability {
  text: boolean;
  image: boolean;
  audio: boolean;
  file: boolean;
  video: boolean;
  markdown: boolean;
  card: boolean;
  sticker: boolean;
  maxTextLength: number;
}

export interface PluginChannelStatus {
  enabled: boolean;
  phase: "running" | "offline" | "starting" | "config_missing" | "error";
  message?: string;
}

export interface PluginIncomingMessage {
  channel: string;
  chatType?: "private" | "group";
  messageId?: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  threadId?: string;
  text: string;
  attachments?: Array<{
    kind: "image" | "audio" | "file" | "video";
    url?: string;
    filePath?: string;
    mime?: string;
    caption?: string;
  }>;
  at: Date;
  _raw?: unknown;
}

export interface PluginOutgoingMessage {
  channel: string;
  chatType?: "private" | "group";
  targetId: string;
  threadId?: string;
  parts: Array<Record<string, unknown> & { kind: string }>;
}

export type PluginMessageHandler = (
  message: PluginIncomingMessage,
) => Promise<PluginOutgoingMessage | null>;

export interface PluginChannelAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capability: PluginChannelCapability;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: PluginMessageHandler | null;
  send(message: PluginOutgoingMessage): Promise<{ ok: boolean; error?: string }>;
  getStatus(): PluginChannelStatus;
}

export interface PluginLlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PluginLlmGenerateOptions {
  /** 1-8192; defaults to 1024. */
  maxTokens?: number;
  /** 1000-300000 ms; defaults to the current chat timeout capped at 120s. */
  timeoutMs?: number;
  /** Optional cancellation signal owned by the plugin. */
  signal?: AbortSignal;
  /** Short diagnostic label appended to plugin:<id>. */
  purpose?: string;
}

export interface PluginLlmService {
  generateText(
    messages: PluginLlmMessage[],
    options?: PluginLlmGenerateOptions,
  ): Promise<string>;
}

export interface PluginStorage {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  rootDir(): string;
}

export type PluginEventListener<T = unknown> = (payload: T) => void | Promise<void>;

export interface PluginEvents {
  /** 订阅带完整命名空间的 host:* 或 plugin:<id>:* 事件。 */
  on<T = unknown>(event: string, listener: PluginEventListener<T>): () => void;
  /** 发布当前插件自有事件；框架自动补全为 plugin:<id>:<event>。 */
  emit<T = unknown>(event: string, payload: T): Promise<void>;
}

/** host:turn:completed 的公开 payload；首版只暴露稳定元数据，不包含对话原文。 */
export interface PluginTurnCompletedEvent {
  source: "desktop" | "channel";
  mode: PluginPromptMode;
  conversationId: string;
  channel?: string;
  runId?: string;
}

export interface PluginDeps {
  /** Read-only channel discovery. Registration must use PluginContext methods. */
  channels?: { has(id: string): boolean };
  llm?: PluginLlmService;
}

export type PluginCleanup = () => void | Promise<void>;

export type PluginPromptMode = "chat" | "work" | "learn" | "code";

export interface PluginPromptBuildInput {
  /** conversation 表示用户会话，scheduler 表示定时任务。 */
  source: "conversation" | "scheduler";
  mode: PluginPromptMode;
  userText: string;
  conversationId?: string;
  channel?: string;
}

export interface PluginPromptProviderInput extends PluginPromptBuildInput {
  /** 插件停止时触发；Provider 应尽快结束仍在进行的异步工作。 */
  readonly signal: AbortSignal;
}

export interface PluginPromptProvider {
  /** 当前插件内唯一；框架会自动补全 plugin:<插件id>: 前缀。 */
  id: string;
  /** 缺省表示全部会话模式。 */
  modes?: PluginPromptMode[];
  provide(input: PluginPromptProviderInput): string | Promise<string>;
}

export interface PluginContext {
  id: string;
  /** 插件停止或激活回滚开始前会先触发取消。 */
  readonly signal: AbortSignal;
  /** 登记插件自有资源的清理回调；回调按逆序且最多执行一次。 */
  onDispose(cleanup: PluginCleanup): void;
  events: PluginEvents;
  registerTool(tool: PluginTool): void;
  unregisterTool(toolId: string): void;
  /** 注册每轮动态提示词贡献；内容进入 runtime context，不改变核心提示词文件。 */
  registerPromptProvider(provider: PluginPromptProvider): void;
  unregisterPromptProvider(providerId: string): void;
  /** Automatically namespaced as plugin:<id>:<channel>. */
  registerIpc(channel: string, handler: (...args: unknown[]) => unknown): void;
  unregisterIpc(channel: string): void;
  registerChannelAdapter(adapter: PluginChannelAdapter): Promise<void>;
  unregisterChannelAdapter(channelId: string): Promise<void>;
  storage: PluginStorage;
  deps: PluginDeps;
  log(...args: unknown[]): void;
}

export interface CyrenePlugin {
  open?(): void | Promise<void>;
  register(ctx: PluginContext): void | Promise<void>;
  unregister?(): void | Promise<void>;
}
