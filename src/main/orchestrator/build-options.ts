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
import type { ChatMessage, OpenAIContentBlock } from "./vendors/types";
import type { AguiRunInput } from "../agui-bridge";
import { IPC } from "../../shared/ipc-channels";
import type { RelationshipChannel, RelationshipTurnInput } from "../relationship/relationship-log";
import { validateCaptionImagePath } from "../chat/image-caption";
import {
  buildConversationTimeContext,
  resolveChatContextTimezone,
  type ChatContextMessage,
} from "../chat-time-context";

/** index.ts 模块级符号的最小可注入子集。
 *  类型故意用宽签名（unknown / 任意 shape）—— 因为 build-options 是纯消费者，
 *  实际调用时由 index.ts 注入真实的强类型函数。这避免循环类型依赖。 */
export interface BuildOptionsDeps {
  loadModelSettings: () => ModelSettingsLite;
  loadUserProfile: () => UserProfileLite;
  buildEnvironmentContext: (model: { provider: string; model: string }, profile: unknown) => string;
  buildSkillCatalog: (skills: ReadonlyArray<unknown>) => string;
  buildAutoInjectedSkillContext: (skills: ReadonlyArray<unknown>) => string;
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
  buildSystemPrompt: (styleFile: string) => string;
  /** 第一期：工具阶段 system prompt。仅含工具调度规则 + 自动生成的工具目录。 */
  buildToolSystemPrompt: (enabledTools: ReadonlyArray<unknown>, isOptimizedFirstRound?: boolean) => string;
  /** 第一期：Soul 阶段使用的基础 system prompt。工具结果在 FC 循环 Soul 阶段执行前动态追加。 */
  buildSoulSystemBasePrompt: (styleFile: string) => string;
  /** 第一期：注入 toolRegistry（用于 buildToolSystemPrompt 自动生成目录）。 */
  toolRegistry: { getEnabled(): ReadonlyArray<unknown> };
  logWorldbookInjection: (alwaysOnContext: string, systemContent: string) => void;
  normalizeChatMessages: (raw: ReadonlyArray<unknown>) => ChatMessage[];
  chatRequestTimeoutMs: number;
  captionImageForFallback?: (filePath: string) => Promise<{ ok: boolean; caption?: string; error?: string }>;
  buildMusicCompanionContext?: (conversationId: string, userText: string) => string;
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
  explicitTransport?: "openai" | "anthropic" | "auto";
  /** 顶层 reasoning 镜像（来自 perProvider[currentProvider].reasoning）。adapter 直接读。 */
  reasoning?: import("../../shared/reasoning").ReasoningPreference;
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
  return "";
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

export function resolveRequiredMusicTool(
  userText: string,
  availableToolIds: ReadonlySet<string>,
): string | undefined {
  const text = userText.trim();
  if (!text) return undefined;
  if (availableToolIds.has("music_get_daily_recommendations") && /(?:网易云)?(?:今日推荐|每日推荐|日推)/.test(text)) {
    return "music_get_daily_recommendations";
  }
  if (!availableToolIds.has("music_search")) return undefined;
  const explicitSearch = /网易云.{0,12}(?:搜|找)|(?:搜|搜索|找).{0,12}(?:网易云|歌曲?|音乐)/.test(text);
  const explicitTrackPlayback = /^(?:帮我)?(?:播放|放个|放一下)(?!点音乐)/.test(text);
  return explicitSearch || explicitTrackPlayback ? "music_search" : undefined;
}

function stripTurnModelContextForSideEffects(text: string): string {
  const markers = [
    "\n\n【本轮文件】",
    "\n\n【文档内容】",
    "\n\n【图片视觉信息】",
    "\n\n【图片附件】",
    "【本轮文件】",
    "【文档内容】",
    "【图片视觉信息】",
    "【图片附件】",
  ];
  const cut = markers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return (cut === undefined ? text : text.slice(0, cut)).trim();
}

function withDirectImageAttachments(messages: ChatMessage[], input: AguiRunInput): ChatMessage[] {
  const images = input.imageAttachments?.filter((image) =>
    typeof image?.filePath === "string" && typeof image?.name === "string",
  ) ?? [];
  if (images.length === 0) return messages;

  const latestUserIndex = messages.map((message) => message.role).lastIndexOf("user");
  if (latestUserIndex < 0) return messages;

  const current = messages[latestUserIndex];
  const blocks: OpenAIContentBlock[] = [];
  const text = contentToText(current.content);
  blocks.push({ type: "text", text });

  for (const image of images) {
    const validated = validateCaptionImagePath(image.filePath);
    if (!validated.ok) {
      blocks.push({
        type: "text",
        text: `图片 ${image.name} 无法读取：${validated.error}。请诚实说明暂时无法看清这张图，不要编造图片内容。`,
      });
      continue;
    }
    blocks.push({
      type: "image_url",
      image_url: { url: `data:${validated.mime};base64,${validated.buffer.toString("base64")}` },
    });
  }

  const next = messages.slice();
  next[latestUserIndex] = { ...current, content: blocks };
  return next;
}

function buildImageCaptionFallbackMessages(
  systemContent: string,
  messages: ChatMessage[],
  input: AguiRunInput,
  deps: BuildOptionsDeps,
): (() => Promise<ChatMessage[]>) | undefined {
  const images = input.imageAttachments?.filter((image) =>
    typeof image?.filePath === "string" && typeof image?.name === "string",
  ) ?? [];
  if (images.length === 0 || !deps.captionImageForFallback) return undefined;

  return async () => {
    const fallbackMessages = messages.map((message) => ({ ...message }));
    const latestUserIndex = fallbackMessages.map((message) => message.role).lastIndexOf("user");
    if (latestUserIndex < 0) return [{ role: "system", content: systemContent }, ...fallbackMessages];

    const current = fallbackMessages[latestUserIndex];
    const text = contentToText(current.content);
    const imageLines: string[] = [];
    for (const image of images) {
      const result = await deps.captionImageForFallback!(image.filePath);
      if (result.ok && result.caption) {
        imageLines.push(`- ${image.name}：${result.caption}`);
      } else {
        imageLines.push(`- ${image.name}：图片分析失败：${result.error || "图片分析失败"}。请诚实说明暂时无法看清这张图。`);
      }
    }

    const imageContext = "【图片视觉信息】\n以下内容是视觉模型对用户本轮图片的观察结果，请将其视为你已经看到的图片内容；如果某张图分析失败，请不要编造。\n" + imageLines.join("\n");
    fallbackMessages[latestUserIndex] = {
      ...current,
      content: text ? `${text}\n\n${imageContext}` : imageContext,
    };
    return [{ role: "system", content: systemContent }, ...fallbackMessages];
  };
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
  const latestUserText = contentToText(messages.filter((m) => m.role === "user").at(-1)?.content) ?? "";
  const skillActivation = deps.resolveSlashActivation(slimMessages);
  const profile = deps.loadUserProfile();
  const { messages: llmMessages, timeContext: conversationTimeContext } = buildConversationTimeContext(
    messages as unknown as ChatContextMessage[],
    resolveChatContextTimezone(profile.timezone),
  );
  const slimLlmMessages = llmMessages as Array<{ role: string; content?: string }>;

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

  const enabledSkills = deps.skillRegistry.getEnabled();
  const skillCatalog = deps.buildSkillCatalog(enabledSkills);
  const autoInjectedSkillContext = deps.buildAutoInjectedSkillContext(enabledSkills);
  const conversationId = input.sessionId || "default";
  const musicCompanionContext = deps.buildMusicCompanionContext?.(conversationId, latestUserText) ?? "";
  const channelSystem = buildChannelSystem(input.channel);

  let toneInjection = "";
  if (deps.sceneEmbeddingIndex) {
    try {
      toneInjection = await deps.buildToneInjection(
        latestUserText,
        slimLlmMessages,
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
  const styleFile = input.style || "01_default.md";
  const enabledTools = deps.toolRegistry.getEnabled();
  const runTools = isTalkMode
    ? enabledTools.filter((tool) => String((tool as { id?: unknown }).id ?? "").startsWith("music_"))
    : enabledTools;
  const requiredToolName = resolveRequiredMusicTool(
    latestUserText,
    new Set(runTools.map((tool) => String((tool as { id?: unknown }).id ?? ""))),
  );

  // 第一期：保留旧 systemContent 兼容（已不再使用，保留字段是为了 logger 诊断）。
  // 同时新增 toolSystemContent / soulSystemBaseContent 两套。
  const systemContent =
    (environmentContext ? environmentContext + "\n\n" : "") +
    (conversationTimeContext ? conversationTimeContext + "\n\n---\n\n" : "") +
    (channelSystem ? channelSystem + "\n\n" : "") +
    deps.buildSystemPrompt(styleFile) +
    (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
    (autoInjectedSkillContext ? "\n\n---\n\n" + autoInjectedSkillContext : "") +
    skillActivation +
    toneInjection +
    (alwaysOnContext ? "\n\n" + alwaysOnContext + "\n\n" : "") +
    (relationshipContext ? "\n\n" + relationshipContext + "\n\n" : "") +
    attachmentContext;

  // 工具阶段：工具规则 + 运行时工具目录 + 可用 Skill 路由清单。
  const toolSystemContent = deps.buildToolSystemPrompt(runTools)
    + (skillCatalog ? "\n\n---\n\n" + skillCatalog : "")
    + (autoInjectedSkillContext ? "\n\n---\n\n" + autoInjectedSkillContext : "")
    + (musicCompanionContext ? "\n\n" + musicCompanionContext : "");
  const toolSystemContentOptimizedForFirstRound = deps.buildToolSystemPrompt(runTools, true)
    + (skillCatalog ? "\n\n---\n\n" + skillCatalog : "")
    + (autoInjectedSkillContext ? "\n\n---\n\n" + autoInjectedSkillContext : "")
    + (musicCompanionContext ? "\n\n" + musicCompanionContext : "");

  // Soul 阶段基础 system：人设 + 环境/记忆/关系/附件/渠道（这些是"表达"所需）。
  // 工具结果（role: tool 消息）已在 conversation 中携带，本字段不重复注入；
  // FC 循环 Soul 阶段执行前会按需动态追加 soulToolResultsSummary。
  const soulSystemBaseContent =
    (environmentContext ? environmentContext + "\n\n" : "") +
    (conversationTimeContext ? conversationTimeContext + "\n\n---\n\n" : "") +
    (channelSystem ? channelSystem + "\n\n" : "") +
    deps.buildSoulSystemBasePrompt(styleFile) +
    (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
    (autoInjectedSkillContext ? "\n\n---\n\n" + autoInjectedSkillContext : "") +
    skillActivation +
    toneInjection +
    (alwaysOnContext ? "\n\n" + alwaysOnContext + "\n\n" : "") +
    (relationshipContext ? "\n\n" + relationshipContext + "\n\n" : "") +
    (musicCompanionContext ? "\n\n" + musicCompanionContext : "") +
    attachmentContext;

  deps.logWorldbookInjection(alwaysOnContext, systemContent);

  // 第一期：原始 messages 不再携带 system。FC 循环按阶段动态注入。
  const fcMessages: ChatMessage[] = withDirectImageAttachments(llmMessages as unknown as ChatMessage[], input);
  const imageCaptionFallback = buildImageCaptionFallbackMessages(toolSystemContent + "\n\n---\n\n" + soulSystemBaseContent, llmMessages as unknown as ChatMessage[], input, deps);

  return {
    options: {
      settings: {
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey: settings.apiKey,
        explicitTransport: settings.explicitTransport,
      },
      messages: fcMessages,
      conversationId,
      requiredToolName,
      timeoutMs: deps.chatRequestTimeoutMs,
      toolSystemContent,
      toolSystemContentOptimizedForFirstRound,
      soulSystemBaseContent,
      ...(imageCaptionFallback ? { imageCaptionFallback } : {}),
      ...(isTalkMode ? { tools: runTools as ToolDefinition[] } : {}),
      optimizeFirstRound: true,
    },
    latestUserText,
  };
}

/**
 * agent 跑完后的副作用：记忆 + 表情/sticker 推断 + 广播。
 * 与 index.ts 原 AG-UI bridge 的 onRunFinished 行为完全一致。
 *
 * 注意：feeling 字段由 inferRuntimeState 内部副作用更新；本函数只同步 status/expression/updatedAt。
 *
 * 渠道（wechat/feishu/...）的 sticker 走 OutgoingMessage.parts（统一消息模型）；
 * 桌面聊天窗保留 IPC 广播（向后兼容 + 桌面渲染端 sticker 选择器依赖此事件）。
 * 两者从同一份 sticker 决定出发，不会重复。
 */
export async function onAgentRunFinished(
  result: CyreneRunResult,
  latestUserText: string,
  deps: OnRunFinishedDeps,
  channel?: "wechat" | "feishu",
): Promise<{ sticker: string | null }> {
  const chatContent = result.reply;
  const sideEffectUserText = stripTurnModelContextForSideEffects(latestUserText);
  deps.scheduleMemoryWrite(sideEffectUserText, chatContent);

  const settings = deps.loadModelSettings();
  const inferredStatus = deps.inferRuntimeState(sideEffectUserText, chatContent, false);
  deps.setRuntimeState({
    status: inferredStatus.status,
    expression: deps.feelingToExpression[deps.runtimeState.feeling ?? ""] ?? 0,
    updatedAt: Date.now(),
  });

  await deps.recordRelationshipTurn({
    userText: sideEffectUserText,
    assistantText: chatContent,
    cyreneFeeling: deps.runtimeState.feeling ?? "平静",
    channel: channel ?? "desktop",
  });

  const stickerIndex = deps.getStickerEmbeddingIndex?.() ?? deps.stickerEmbeddingIndex;
  const stickerQuery = (chatContent + "\n" + sideEffectUserText).slice(0, 1000);
  const stickerCandidate =
    settings.stickerEnabled && stickerIndex
      ? (
          await deps.matchSticker(
            stickerQuery,
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
    if (channel !== "wechat" && channel !== "feishu") {
      void deps.observeRuntimeState(settings, [], sideEffectUserText, chatContent);
    }
  }

  // 返回 sticker 决定：
  // - 桌面聊天窗的 sticker 由 IPC 广播（上面 chatWin.webContents.send）继续承担
  // - 渠道（wechat/feishu/...）的 sticker 由 dispatcher 收下，纳入 OutgoingMessage.parts
  // - 桌面路径也返回 sticker 以保持签名一致；dispatcher 路径下 channel !== undefined 才会消费它
  return { sticker };
}
