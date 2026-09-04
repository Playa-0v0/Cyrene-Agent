import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import { loadGeneralSettings } from "../settings/settings-facade";
import { loadModelSettings, loadVisionConfig, resolveModelSettingsProfile } from "../settings/model-settings";
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
import { appendMessage, getSession } from "../chats/chats-store";
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
  shutdown(): Promise<void>;
}

export interface ChannelsSubsystemDeps {
  agentRuntime: AgentRuntime;
  ttsSynthesisService: TtsSynthesisService;
  getReactChatWindow: () => BrowserWindow | null;
  /** 共享 IPC scope；传入后 channels IPC 由组合根统一注销。 */
  ipc?: IpcScope;
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
    return conversationId && getSession(conversationId) ? conversationId : null;
  });

  setDispatcherLoadBoundConversationHistory(async (conversationId, limit) => {
    const session = getSession(conversationId);
    if (!session) return [];
    return session.messages
      .filter((message) => (message.role === "user" || message.role === "model") && message.content.trim().length > 0)
      .slice(-limit)
      .map((message) => ({
        role: message.role === "model" ? "assistant" as const : "user" as const,
        content: message.content,
      }));
  });

  setDispatcherAppendBoundConversationMessage((conversationId, role, content) => {
    const session = appendMessage(conversationId, {
      id: randomUUID(),
      role: role === "assistant" ? "model" : "user",
      content,
      at: Date.now(),
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
    const reply = await new Promise<string>((resolve, reject) => {
      agent.runWithEvents(options).subscribe({
        complete: () => {
          resolve(agent.lastResult?.reply ?? "");
        },
        error: (err) => reject(err instanceof Error ? err : new Error(String(err))),
      });
    });
    channelResult.text = reply;
    if (agent.lastResult) {
      const finished = await deps.agentRuntime.onRunFinished(agent.lastResult, agentUserText, msg.channel, sessionId);
      channelResult.sticker = finished.sticker;
    }
    void indexConversationTurn(sessionId, agentUserText, reply);
    return channelResult;
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

  return {
    initialize: () => adapter.initialize(),
    start: (signal?: AbortSignal) => adapter.start(signal),
    shutdown: () => adapter.shutdown(),
  };
}
