// buildAgentRunOptions —— 把 AG-UI 橋的 buildOptions 閉包抽成純函數。
//
// 設計原則：
//   - 函數無模塊級狀態；所有 index.ts 模塊級符號（runtimeState, stickerEmbeddingIndex 等）
//     通過 deps 參數注入。
//   - 函數無副作用（不算 console.warn）；副作用（記憶寫入/sticker 廣播）由 onRunFinished
//     單獨做，注入到同一個 deps 裡。
//   - index.ts / dispatcher / scheduler 共用同一個 factory。
//   - 默認 style 寫死 '01_default.md'，與原行為一致。
//
// 字段依賴梳理（按 index.ts:3175-3281）：
//   loadModelSettings / loadUserProfile / buildEnvironmentContext
//   buildSkillCatalog / skillRegistry / resolveSlashActivation
//   buildToneInjection / sceneEmbeddingIndex / getSceneEmbeddingProvider
//   buildSystemPrompt / logWorldbookInjection / CHAT_REQUEST_TIMEOUT_MS
//   normalizeChatMessages / buildAlwaysOnContext / ToolDefinition
//   scheduleMemoryWrite / inferRuntimeState / runtimeState / feelingToExpression
//   matchSticker / stickerEmbeddingIndex / getEmbeddingProvider / loadStickerSettings
//   broadcastRuntimeStateChanged / observeRuntimeState
//   IPC.AGUI_EVENT / chatWindow（用於推 sticker）
//
// 這些全部塞到 BuildOptionsDeps 裡。dispatcher 在 Phase 1 注入同樣的 deps 即可。
import type { CyreneRunOptions, CyreneRunResult } from "./cyrene-agent";
import type { ToolDefinition } from "./tool-registry";
import type { ChatMessage } from "./vendors/types";
import type { AguiRunInput } from "../agui-bridge";
import { IPC } from "../../shared/ipc-channels";
import type { RelationshipChannel, RelationshipTurnInput } from "../relationship/relationship-log";

/** index.ts 模塊級符號的最小可注入子集。
 *  類型故意用寬簽名（unknown / 任意 shape）—— 因為 build-options 是純消費者，
 *  實際調用時由 index.ts 注入真實的強類型函數。這避免循環類型依賴。 */
export interface BuildOptionsDeps {
  loadModelSettings: () => ModelSettingsLite;
  loadUserProfile: () => UserProfileLite;
  buildEnvironmentContext: (model: { provider: string; model: string; baseUrl?: string }, profile: unknown) => string;
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
  buildSystemPrompt: (styleFile: string) => string;
  logWorldbookInjection: (alwaysOnContext: string, systemContent: string) => void;
  normalizeChatMessages: (raw: ReadonlyArray<unknown>) => ChatMessage[];
  chatRequestTimeoutMs: number;
}

/** onRunFinished 副作用所需的 deps（與 BuildOptionsDeps 部分重疊） */
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
      "【渠道回覆方式】",
      "你正在通過微信回覆用戶。",
      "回覆要像微信聊天消息：短、自然、有來有回。",
      "不要寫長段說明，不要提桌面端、工具調用或系統。",
      "任務複雜時先簡短確認，再安靜執行。",
    ].join("\n");
  }
  if (channel === "feishu") {
    return [
      "【渠道回覆方式】",
      "你正在通過飛書回覆用戶。",
      "語氣仍是昔漣，但要適合工作上下文：清楚、省時間、結論靠前。",
      "必要時可以簡短列步驟，不要過度撒嬌，不要發太長情緒化回覆。",
    ].join("\n");
  }
  if (channel === "discord") {
    return [
      "【Discord 聊天模式特別規範】",
      "你正在通過 Discord 回覆用戶。",
      "1. **偏好訊息化對話**：你目前在 Discord 上與夥伴聊天，請像「正常朋友在 Discord 傳簡訊」一樣交談。",
      "2. **極簡短回覆**：回覆應非常簡短、隨性且口語化。每次回覆通常只有 1 到 2 句話（最多不超過 3 句話），絕對禁止長篇大論、多個段落或大段文字。",
      "3. **嚴禁旁白與動作描寫**：回覆中絕對不可以出現任何括號（如「（摸頭）」、「（垂下眼睫）」）、星號（如「*抱抱*」）或任何旁白動作描寫。請只輸出你親口說的台詞。",
      "4. **自然交談**：不要使用生硬的格式，不要分點，不要主動總結。像真人一樣，一句話說完就停下來，等待對方回覆。",
    ].join("\n");
  }
  return "";
}

/**
 * 構造 CyreneAgent.runWithEvents 所需的 options + 提取 latestUserText。
 * 與 index.ts 原 AG-UI bridge 的 buildOptions 行為完全一致。
 */
export async function buildAgentRunOptions(
  input: AguiRunInput,
  deps: BuildOptionsDeps,
): Promise<{ options: CyreneRunOptions; latestUserText: string }> {
  const settings = deps.loadModelSettings();
  if (!settings.apiKey) {
    throw new Error("還沒有填寫 API Key，請先在設置裡保存 API 配置。");
  }
  const messages = deps.normalizeChatMessages(input.messages);
  if (messages.length === 0) {
    throw new Error("沒有可發送的聊天內容。");
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
      { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl },
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
    attachmentContext = `\n\n【本輪附件內容】\n${parts.join("\n\n")}`;
  }

  const isTalkMode = (input.style || "").startsWith("talk");
  const systemContent =
    (environmentContext ? environmentContext + "\n\n" : "") +
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
 * agent 跑完後的副作用：記憶 + 表情/sticker 推斷 + 廣播。
 * 與 index.ts 原 AG-UI bridge 的 onRunFinished 行為完全一致。
 *
 * 注意：feeling 字段由 inferRuntimeState 內部副作用更新；本函數只同步 status/expression/updatedAt。
 */
export async function onAgentRunFinished(
  result: CyreneRunResult,
  latestUserText: string,
  deps: OnRunFinishedDeps,
  channel?: "wechat" | "feishu" | "discord",
): Promise<string | null> {
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
    cyreneFeeling: deps.runtimeState.feeling ?? "平靜",
    channel: channel ?? "desktop",
  });

  const stickerIndex = deps.getStickerEmbeddingIndex?.() ?? deps.stickerEmbeddingIndex;
  const stickerProvider = deps.getEmbeddingProvider();
  const stickerCandidate =
    settings.stickerEnabled && stickerIndex && stickerProvider
      ? (
          await deps.matchSticker(
            chatContent + "\n" + latestUserText,
            stickerProvider,
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
    // 心情觀察器在 channels bot (wechat/feishu) 上跳過：節省一次 LLM 調用、加快首條回覆
    // 桌面聊天（channel === undefined）照常跑，保持 Live2D 表情/心情跟隨對話變化
    if (channel !== "wechat" && channel !== "feishu" && channel !== "discord") {
      void deps.observeRuntimeState(settings, [], latestUserText, chatContent);
    }
  }
  return sticker;
}
