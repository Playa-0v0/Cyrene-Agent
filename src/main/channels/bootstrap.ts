import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import type { PluginPromptMode, PluginTurnStatus } from "../../plugins/api";
import { loadGeneralSettings } from "../settings/settings-facade";
import { loadModelSettings, loadVisionConfig, resolveModelSettingsProfile } from "../settings/model-settings";
import type { LifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import { CyreneAgent } from "../orchestrator/cyrene-agent";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { decideImageSendStrategy } from "../chat/image-send-strategy";
import {
  IMAGE_CAPTION_PROMPT,
  validateCaptionImagePath,
} from "../chat/image-caption";
import { indexConversationTurn } from "../orchestrator/tools/history-tools";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import type { TtsSynthesisService } from "../services/tts/tts-synthesis-service";
import { buildChannelAttachmentInputs } from "./agent-input";
import { loadChannelsSettings } from "./settings-store";
import { enforceChannelAgentPolicy, resolveChannelAgentPolicy } from "./agent-policy";
import { appendMessage, getSession, listSessions } from "../chats/chats-store";
import { getChannelConversationBindingStore } from "./conversation-binding-store";
import {
  setDispatcherBuildAndRunAgent,
  setDispatcherBroadcastChat,
  setDispatcherLoadGeneralSettings,
  setDispatcherLoadRecentHistory,
  setDispatcherObserveExternalChat,
  setDispatcherResolveBoundConversation,
  setDispatcherLoadBoundConversationHistory,
  setDispatcherAppendBoundConversationMessage,
  setDispatcherSynthesizeTts,
  formatChannelUserText,
} from "./dispatcher";
import {
  initializeChannels,
  startChannels,
  shutdownChannels,
} from "./init";

export interface ChannelsLifecycleAdapter {
  initialize(): void;
  start(signal?: AbortSignal): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ChannelsSubsystem {
  initialize(): void;
  start(signal?: AbortSignal): Promise<void>;
  /** initialize() 同步注册全部内置 adapter 后解析，插件必须等待该边界。 */
  adaptersRegistered: Promise<void>;
  shutdown(): Promise<void>;
}

export interface ChannelsSubsystemDeps {
  agentRuntime: AgentRuntime;
  ttsSynthesisService: TtsSynthesisService;
  getReactChatWindow: () => BrowserWindow | null;
  /** 共享 IPC scope；传入后 channels IPC 由组合根统一注销。 */
  ipc?: IpcScope;
  /** 生命周期事件发布器：渠道轮次事件由此发布。 */
  publishLifecycle?: LifecyclePublisher;
}

/**
 * 组装 channels 子系统。构造期只注入 dispatcher 依赖（纯 setter 赋值），
 * 不做任何初始化/启动 —— initialize / start / shutdown 必须显式调用。
 */
export function createChannelsSubsystem(
  deps: ChannelsSubsystemDeps,
  lifecycle?: ChannelsLifecycleAdapter,
): ChannelsSubsystem {
  setDispatcherLoadRecentHistory(async (sessionId, limit) => {
    const { loadRecentHistory } = await import("./history-log");
    return loadRecentHistory(sessionId, limit);
  });
  setDispatcherLoadGeneralSettings(loadGeneralSettings);

  setDispatcherObserveExternalChat((sessionId, msg) => {
    getChannelConversationBindingStore().observe({
      sessionId,
      channel: msg.channel,
      chatId: msg.chatId,
      chatType: msg.chatType ?? "private",
      ...(msg.senderName ? { senderName: msg.senderName } : {}),
      lastAt: msg.at.getTime(),
    });
  });

  setDispatcherResolveBoundConversation((sessionId) => {
    const conversationId = getChannelConversationBindingStore().resolve(sessionId);
    return conversationId && listSessions().some((session) => session.id === conversationId) ? conversationId : null;
  });

  setDispatcherLoadBoundConversationHistory(async (conversationId, limit) => {
    const session = getSession(conversationId);
    if (!session) return [];
    return session.messages
      .filter((message) => (message.role === "user" || message.role === "model") && message.content.trim().length > 0)
      .slice(-limit)
      .map((message) => ({
        role: message.role === "model" ? "assistant" as const : "user" as const,
        content: message.modelContext?.trim() || message.content,
      }));
  });

  setDispatcherAppendBoundConversationMessage((conversationId, role, content, metadata) => {
    const session = appendMessage(conversationId, {
      id: randomUUID(),
      role: role === "assistant" ? "model" : "user",
      content,
      at: Date.now(),
      modelContext: metadata.modelContext,
      sticker: metadata.sticker,
      channelSource: {
        channel: metadata.channel,
        chatType: metadata.chatType,
        senderName: metadata.senderName,
      },
    });
    if (!session) throw new Error("Bound conversation no longer exists");
    const win = deps.getReactChatWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send(IPC.CHATS_CHANGED);
      } catch (err) {
        console.warn("[Channels] bound conversation refresh failed:", err);
      }
    }
  });

  setDispatcherBuildAndRunAgent(async (msg, sessionId, priorMessages) => {
    const channelResult: { text: string; sticker: string | null } = { text: "", sticker: null };

    const sandbox = loadChannelsSettings().toolSandbox;
    const policy = resolveChannelAgentPolicy(sandbox, {
      channel: msg.channel,
      chatType: msg.chatType,
    });
    const allTools = toolRegistry.getEnabledTools();
    const exposedTools = policy.exposeTools ? allTools : [];
    console.log(
      "[Channels] bot run:",
      `msg.channel=${msg.channel} sandbox=${sandbox} tools=${exposedTools.length}/${allTools.length} priorMsgs=${priorMessages?.length ?? 0}`,
    );

    const historyMessages = (priorMessages ?? [])
      .filter((m) => typeof m.content === "string" && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));

    // 图片发送策略也基于解析后的配置（默认档案）——顶层镜像可能是全空的空壳
    const channelModelSettings = resolveModelSettingsProfile(loadModelSettings());
    const imageSendStrategy = decideImageSendStrategy({
      multimodal: channelModelSettings.multimodal,
      vision: loadVisionConfig(),
    });
    const attachmentInputs = await buildChannelAttachmentInputs(msg, {
      imageMode: imageSendStrategy.mode,
      captionImage: async (filePath: string) => {
        const validated = validateCaptionImagePath(filePath);
        if (!validated.ok) return { ok: false, error: validated.error };
        const visionCfg = loadVisionConfig();
        if (!visionCfg) return { ok: false, error: "未配置视觉模型，无法分析图片" };
        try {
          const { captionImage } = await import("../orchestrator/vision-captioner");
          const caption = await captionImage(
            { base64: validated.buffer.toString("base64"), mime: validated.mime },
            IMAGE_CAPTION_PROMPT,
            visionCfg,
          );
          if (caption.startsWith("[错误")) return { ok: false, error: caption };
          return { ok: true, caption };
        } catch (err: any) {
          return { ok: false, error: err?.message || String(err) };
        }
      },
    });
    const agentUserText = formatChannelUserText(msg);
    const { options } = await deps.agentRuntime.buildOptions({
      messages: [
        ...historyMessages,
        { role: "user", content: agentUserText },
      ],
      style: "01_default.md",
      sessionId,
      // 渠道绑定只共享文字上下文，不继承桌面对话的工作区权限。
      workspaceBindingSessionId: null,
      attachments: attachmentInputs.attachments,
      imageAttachments: attachmentInputs.imageAttachments,
      channel: msg.channel,
      executionMode: policy.executionMode,
      ...(policy.executionMode === "chat" ? {
        userTurnId: `${msg.channel}:${msg.senderId}:${msg.at.toISOString()}:user`,
        assistantTurnId: `${msg.channel}:${msg.senderId}:${msg.at.toISOString()}:assistant`,
      } : {}),
    });
    options.tools = policy.exposeTools
      ? [...(options.capabilities?.tools ?? exposedTools)]
      : [];
    enforceChannelAgentPolicy(options, policy);

    const threadId = `thread-${sessionId}-${Date.now()}`;
    const agent = new CyreneAgent({ threadId, description: `bot:${msg.channel}:${msg.senderId}` });
    // 轮次事件只带渠道会话标识，不提供桌面消息边界；绑定消息由 dispatcher 镜像写入。
    const mode: PluginPromptMode = options.conversationMode
      ?? (options.executionMode === "chat" ? "chat" : "work");
    const runId = randomUUID();
    const runStartedAt = Date.now();
    deps.publishLifecycle?.publishTurnStarted({
      source: "channel",
      channel: msg.channel,
      conversationId: sessionId,
      runId,
      mode,
    });
    let lifecycleStatus: PluginTurnStatus = "runtime_error";
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        agent.runWithEvents(options).subscribe({
          complete: () => {
            resolve(agent.lastResult?.reply ?? "");
          },
          error: (err) => reject(err instanceof Error ? err : new Error(String(err))),
        });
      });
      lifecycleStatus = agent.lastResult?.terminal?.status ?? "success";
      channelResult.text = reply;
      // Observable 在超时终态下也会正常 complete；只有成功终态才能进入记忆、表情等成功收尾。
      const terminalStatus = agent.lastResult?.terminal?.status;
      if (agent.lastResult && (terminalStatus === undefined || terminalStatus === "success")) {
        const finished = await deps.agentRuntime.onRunFinished(agent.lastResult, agentUserText, {
          source: "channel",
          mode,
          conversationId: sessionId,
          channel: msg.channel,
        });
        channelResult.sticker = finished.sticker;
      }
      void indexConversationTurn(sessionId, agentUserText, reply);
      return channelResult;
    } finally {
      // 无论成功、超时还是异常退出，轮次结束事件都要发布一次
      deps.publishLifecycle?.publishTurnFinished({
        source: "channel",
        channel: msg.channel,
        conversationId: sessionId,
        runId,
        mode,
        status: lifecycleStatus,
        durationMs: Date.now() - runStartedAt,
      });
    }
  });

  setDispatcherSynthesizeTts(async (text: string, context) => {
    const cfg = loadGeneralSettings();
    return await deps.ttsSynthesisService.synthesizeChannelTts(text, cfg, context.channel);
  });

  setDispatcherBroadcastChat((event) => {
    const win = deps.getReactChatWindow();
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(IPC.AGUI_EVENT, {
        type: "CUSTOM",
        name: "cyrene.botMessage",
        value: event,
      });
    } catch (err) {
      console.warn("[Channels] botMessage 广播失败:", err);
    }
  });

  // 默认生命周期：委托到 init.ts 的显式操作（幂等）
  const defaultLifecycle: ChannelsLifecycleAdapter = {
    initialize: () => initializeChannels(deps.ipc),
    start: (signal?: AbortSignal) => startChannels(signal),
    shutdown: () => shutdownChannels(),
  };
  const adapter = lifecycle ?? defaultLifecycle;

  let resolveAdaptersRegistered!: () => void;
  let rejectAdaptersRegistered!: (error: unknown) => void;
  const adaptersRegistered = new Promise<void>((resolve, reject) => {
    resolveAdaptersRegistered = resolve;
    rejectAdaptersRegistered = reject;
  });

  return {
    initialize: () => {
      try {
        adapter.initialize();
        resolveAdaptersRegistered();
      } catch (error) {
        rejectAdaptersRegistered(error);
        throw error;
      }
    },
    start: (signal?: AbortSignal) => adapter.start(signal),
    adaptersRegistered,
    shutdown: async () => {
      try {
        await adapter.shutdown();
      } finally {
        getChannelConversationBindingStore().flush();
      }
    },
  };
}
