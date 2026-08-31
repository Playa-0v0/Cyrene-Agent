import type { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { loadGeneralSettings } from "../settings/settings-facade";
import { loadModelSettings, loadVisionConfig, resolveModelSettingsProfile } from "../settings/model-settings";
import { CyreneAgent } from "../orchestrator/cyrene-agent";
import { toolRegistry } from "../orchestrator/tool-registry";
import { decideImageSendStrategy } from "../chat/image-send-strategy";
import {
  IMAGE_CAPTION_PROMPT,
  validateCaptionImagePath,
} from "../chat/image-caption";
import { indexConversationTurn } from "../orchestrator/history-tools";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import type { TtsSynthesisService } from "../services/tts/tts-synthesis-service";
import { buildChannelAttachmentInputs } from "./agent-input";
import { loadChannelsSettings } from "./settings-store";
import { enforceChannelAgentPolicy, resolveChannelAgentPolicy } from "./agent-policy";
import {
  setDispatcherBuildAndRunAgent,
  setDispatcherBroadcastChat,
  setDispatcherLoadGeneralSettings,
  setDispatcherLoadRecentHistory,
  setDispatcherSynthesizeTts,
  formatChannelUserText,
} from "./dispatcher";
import { initChannels, shutdownChannels } from "./init";

export interface ChannelsSubsystem {
  shutdown(): Promise<void>;
}

export interface ChannelsSubsystemDeps {
  agentRuntime: AgentRuntime;
  ttsSynthesisService: TtsSynthesisService;
  getReactChatWindow: () => BrowserWindow | null;
}

export function createChannelsSubsystem(deps: ChannelsSubsystemDeps): ChannelsSubsystem {
  setDispatcherLoadRecentHistory(async (sessionId, limit) => {
    const { loadRecentHistory } = await import("./history-log");
    return loadRecentHistory(sessionId, limit);
  });
  setDispatcherLoadGeneralSettings(loadGeneralSettings);

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

  void initChannels();

  return {
    shutdown: shutdownChannels,
  };
}
