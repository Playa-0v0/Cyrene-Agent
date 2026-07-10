// buildAgentRunOptions —— 把 AG-UI 桥的 buildOptions 闭包抽成纯函数。
//
// 设计原则：
//   - 函数无模块级状态；所有 index.ts 模块级符号（runtimeState, stickerEmbeddingIndex 等）
//     通过 deps 参数注入。
//   - 函数无副作用（不算 console.warn）；副作用（记忆写入/sticker 广播）由 onRunFinished
//     单独做，注入到同一个 deps 里。
//   - index.ts / dispatcher / scheduler 共用同一个 factory。
//   - 默认 style 写死 '01_default.md'，与原行为一致。
//
// 字段依赖梳理（按 index.ts:3175-3281）：
//   loadModelSettings / loadUserProfile / buildEnvironmentContext
//   buildSkillCatalog / skillRegistry / resolveSlashActivation
//   buildToneInjection / sceneEmbeddingIndex / getSceneEmbeddingProvider
//   buildSystemPrompt / logWorldbookInjection / CHAT_REQUEST_TIMEOUT_MS
//   normalizeChatMessages / buildAlwaysOnContext / ToolDefinition
//   scheduleMemoryWrite / inferRuntimeState / runtimeState / feelingToExpression
//   matchSticker / stickerEmbeddingIndex / getEmbeddingProvider / loadStickerSettings
//   broadcastRuntimeStateChanged / observeRuntimeState
//   IPC.AGUI_EVENT / chatWindow（用于推 sticker）
//
// 这些全部塞到 BuildOptionsDeps 里。dispatcher 在 Phase 1 注入同样的 deps 即可。
import type { CyreneRunOptions, CyreneRunResult } from "./cyrene-agent";
import type { ToolDefinition } from "./tool-registry";
import type { ChatMessage } from "./vendors/types";
import type { AguiRunInput } from "../agui-bridge";
import { IPC } from "../../shared/ipc-channels";
import type { RelationshipChannel, RelationshipTurnInput } from "../relationship/relationship-log";

/** index.ts 模块级符号的最小可注入子集。
 *  类型故意用宽签名（unknown / 任意 shape）—— 因为 build-options 是纯消费者，
 *  实际调用时由 index.ts 注入真实的强类型函数。这避免循环类型依赖。 */
export interface BuildOptionsDeps {
  loadModelSettings: () => ModelSettingsLite;
  loadUserProfile: () => UserProfileLite;
  buildEnvironmentContext: (model: { provider: string; model: string }, profile: unknown) => string;
  buildSkillCatalog: (skills: ReadonlyArray<unknown>) => string;
  skillRegistry: { getEnabled(): ReadonlyArray<unknown> };
  resolveSlashActivation: (messages: ReadonlyArray<{ role: string; content?: string }>) => string;
  buildToneInjection: (
    userText: string,
    messages: ReadonlyArray<{ role: string; content?: string }>,
    provider: unknown,
    index: unknown,
  ) => Promise<string>;
  sceneEmbeddingIndex: unknown;
  getSceneEmbeddingProvider: () => unknown;
  buildAlwaysOnContext: (
    userText: string,
    messages: ReadonlyArray<{ role: string; content?: string }>,
  ) => Promise<string>;
  buildRelationshipContext: () => Promise<string>;
  buildExternalChannelContext?: () => string;
  buildSystemPrompt: (styleFile: string) => string;
  logWorldbookInjection: (alwaysOnContext: string, systemContent: string) => void;
  normalizeChatMessages: (raw: ReadonlyArray<unknown>) => ChatMessage[];
  chatRequestTimeoutMs: number;
}

/** onRunFinished 副作用所需的 deps（与 BuildOptionsDeps 部分重叠） */
export interface OnRunFinishedDeps {
  loadModelSettings: () => ModelSettingsLite;
  scheduleMemoryWrite: (userText: string, reply: string) => void;
  inferRuntimeState: (userText: string, reply: string, flag: boolean) => { status: string };
  runtimeState: {
    status: string;
    expression: number;
    updatedAt: number;
    feeling?: string;
  };
  feelingToExpression: Record<string, number>;
  setRuntimeState: (next: { status?: string; expression?: number; updatedAt?: number; feeling?: string }) => void;
  stickerEmbeddingIndex: unknown;
  getStickerEmbeddingIndex?: () => unknown;
  getEmbeddingProvider: () => unknown;
  matchSticker: (
    text: string,
    provider: unknown,
    index: unknown,
    threshold: number,
  ) => Promise<{ id: string } | null | undefined>;
  loadStickerSettings: () => Record<string, boolean>;
  broadcastRuntimeStateChanged: () => void;
  observeRuntimeState: (
    settings: ModelSettingsLite,
    history: ReadonlyArray<unknown>,
    userText: string,
    reply: string,
  ) => Promise<void>;
  recordRelationshipTurn: (input: RelationshipTurnInput) => Promise<unknown> | unknown;
  getChatWindow: () => { webContents: { isDestroyed(): boolean; send: (channel: string, ...args: unknown[]) => void }; isDestroyed(): boolean } | null;
}

export interface ModelSettingsLite {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  runtimeSync?: string;
  stickerEnabled?: boolean;
  stickerSimilarityThreshold?: number;
}

export interface UserProfileLite {
  nickname?: string;
  callPreference?: string;
  birthday?: string;
  defaultCity?: string;
  timezone?: string;
}

export function buildChannelSystem(channel?: RelationshipChannel): string {
  if (channel === "wechat") {
    return [
      "【渠道回复方式】",
      "你正在通过微信回复用户。",
      "回复要像微信聊天消息：短、自然、有来有回。",
      "不要写长段说明，不要提桌面端、工具调用或系统。",
      "任务复杂时先简短确认，再安静执行。",
    ].join("\n");
  }
  if (channel === "feishu") {
    return [
      "【渠道回复方式】",
      "你正在通过飞书回复用户。",
      "语气仍是昔涟，但要适合工作上下文：清楚、省时间、结论靠前。",
      "必要时可以简短列步骤，不要过度撒娇，不要发太长情绪化回复。",
    ].join("\n");
  }
  if (channel === "qq") {
    return [
      "【渠道回复方式】",
      "你正在通过 QQ 回复用户。",
      "回复要像 QQ 聊天消息：短、自然、轻一点，避免长篇说明。",
      "群聊里只回答当前被触发的问题，不要主动扩散话题或暴露系统/工具细节。",
    ].join("\n");
  }
  return "";
}

/**
 * 构造 CyreneAgent.runWithEvents 所需的 options + 提取 latestUserText。
 * 与 index.ts 原 AG-UI bridge 的 buildOptions 行为完全一致。
 */
export async function buildAgentRunOptions(
  input: AguiRunInput,
  deps: BuildOptionsDeps,
): Promise<{ options: CyreneRunOptions; latestUserText: string }> {
  const settings = deps.loadModelSettings();
  if (!settings.apiKey) {
    throw new Error("还没有填写 API Key，请先在设置里保存 API 配置。");
  }
  const messages = deps.normalizeChatMessages(input.messages);
  if (messages.length === 0) {
    throw new Error("没有可发送的聊天内容。");
  }
  // slim view for downstream helpers that only need { role, content }
  const slimMessages = messages as unknown as Array<{ role: string; content?: string }>;
  const latestUserText = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";

  let alwaysOnContext = "";
  try {
    alwaysOnContext = await deps.buildAlwaysOnContext(latestUserText, slimMessages);
  } catch (err) {
    console.warn("[Cyrene] always-on context build failed:", err);
  }

  let relationshipContext = "";
  try {
    relationshipContext = await deps.buildRelationshipContext();
  } catch (err) {
    console.warn("[Cyrene] relationship context build failed:", err);
  }

  let environmentContext = "";
  try {
    const profile = deps.loadUserProfile();
    environmentContext = deps.buildEnvironmentContext(
      { provider: settings.provider, model: settings.model },
      {
        nickname: profile.nickname,
        callPreference: profile.callPreference,
        birthday: profile.birthday,
        defaultCity: profile.defaultCity,
        timezone: profile.timezone,
      },
    );
  } catch (err) {
    console.warn("[Cyrene] environment context build failed:", err);
  }

  const skillCatalog = deps.buildSkillCatalog(deps.skillRegistry.getEnabled());
  const skillActivation = deps.resolveSlashActivation(slimMessages);
  const channelSystem = buildChannelSystem(input.channel);
  const externalChannelContext = deps.buildExternalChannelContext?.() ?? "";

  let toneInjection = "";
  if (deps.sceneEmbeddingIndex) {
    try {
      toneInjection = await deps.buildToneInjection(
        latestUserText,
        slimMessages,
        deps.getSceneEmbeddingProvider(),
        deps.sceneEmbeddingIndex,
      );
    } catch (err) {
      console.warn("[Cyrene] tone injection failed:", err);
    }
  }

  let attachmentContext = "";
  const atts = input.attachments;
  if (atts && atts.length > 0) {
    const parts = atts.map((a) => `--- ${a.name} ---\n${a.text}`);
    attachmentContext = `\n\n【本轮附件内容】\n${parts.join("\n\n")}`;
  }

  const isTalkMode = (input.style || "").startsWith("talk");
  const systemContent =
    (environmentContext ? environmentContext + "\n\n" : "") +
    (externalChannelContext ? externalChannelContext + "\n\n" : "") +
    (channelSystem ? channelSystem + "\n\n" : "") +
    deps.buildSystemPrompt(input.style || "01_default.md") +
    (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
    skillActivation +
    toneInjection +
    (alwaysOnContext ? "\n\n" + alwaysOnContext + "\n\n" : "") +
    (relationshipContext ? "\n\n" + relationshipContext + "\n\n" : "") +
    attachmentContext;

  deps.logWorldbookInjection(alwaysOnContext, systemContent);

  const fcMessages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...messages,
  ];

  return {
    options: {
      settings: {
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey: settings.apiKey,
      },
      messages: fcMessages,
      timeoutMs: deps.chatRequestTimeoutMs,
      ...(isTalkMode ? { tools: [] as ToolDefinition[] } : {}),
    },
    latestUserText,
  };
}

/**
 * agent 跑完后的副作用：记忆 + 表情/sticker 推断 + 广播。
 * 与 index.ts 原 AG-UI bridge 的 onRunFinished 行为完全一致。
 *
 * 注意：feeling 字段由 inferRuntimeState 内部副作用更新；本函数只同步 status/expression/updatedAt。
 */
export async function onAgentRunFinished(
  result: CyreneRunResult,
  latestUserText: string,
  deps: OnRunFinishedDeps,
  channel?: "wechat" | "feishu" | "qq",
): Promise<void> {
  const chatContent = result.reply;
  deps.scheduleMemoryWrite(latestUserText, chatContent);

  const settings = deps.loadModelSettings();
  const inferredStatus = deps.inferRuntimeState(latestUserText, chatContent, false);
  deps.setRuntimeState({
    status: inferredStatus.status,
    expression: deps.feelingToExpression[deps.runtimeState.feeling ?? ""] ?? 0,
    updatedAt: Date.now(),
  });

  await deps.recordRelationshipTurn({
    userText: latestUserText,
    assistantText: chatContent,
    cyreneFeeling: deps.runtimeState.feeling ?? "平静",
    channel: channel ?? "desktop",
  });

  const stickerIndex = deps.getStickerEmbeddingIndex?.() ?? deps.stickerEmbeddingIndex;
  const stickerCandidate =
    settings.stickerEnabled && stickerIndex
      ? (
          await deps.matchSticker(
            chatContent + "\n" + latestUserText,
            deps.getEmbeddingProvider(),
            stickerIndex,
            settings.stickerSimilarityThreshold ?? 0.55,
          )
        )?.id ?? null
      : null;
  const stickerSettings = deps.loadStickerSettings();
  const sticker = stickerCandidate && stickerSettings[stickerCandidate] !== false ? stickerCandidate : null;

  const chatWin = deps.getChatWindow();
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.send(IPC.AGUI_EVENT, {
      type: "CUSTOM",
      name: "cyrene.sticker",
      value: sticker,
    });
  }
  if (settings.runtimeSync === "local") {
    deps.broadcastRuntimeStateChanged();
  } else if (settings.runtimeSync === "llm") {
    deps.broadcastRuntimeStateChanged();
    // 心情观察器在 channels bot (wechat/feishu) 上跳过：节省一次 LLM 调用、加快首条回复
    // 桌面聊天（channel === undefined）照常跑，保持 Live2D 表情/心情跟随对话变化
    if (channel !== "wechat" && channel !== "feishu" && channel !== "qq") {
      void deps.observeRuntimeState(settings, [], latestUserText, chatContent);
    }
  }
}
