// channels/dispatcher —— 入站消息處理核心。
//
// 設計原則：
//   - 不知道任何具體平臺。platform 信息只用於查找 adapter / 落日誌 / 寫 sessionId。
//   - 完全無副作用：UI 廣播、記憶寫入、sticker 推斷都在外部注入的回調裡完成。
//   - Phase 0 只搭骨架 + sessionId hash + 限速 + capability 降級工具函數。
//     Phase 1 填入完整的 agent 調用（handleIncoming → CyreneAgent）。
//
// sessionId 生成規則：
//   `channel:<channel>:<sha256(channel:senderId).slice(0,16)>`
//   加 channel 前綴防止跨平臺 ID 衝突；hash 截斷 16 字符節約空間且日誌脫敏。
//
// capability 降級：
//   把 OutgoingMessage 按目標渠道的 cap 翻譯 —— image→text 描述 / card→markdown / sticker 跳過。
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type {
  ChannelCapability,
  ChannelId,
  IncomingMessage,
  OutgoingMessage,
  OutgoingPart,
} from "./types";
import { channelManager, type ChannelManager } from "./manager";
import { getDefaultChannelsSettings, loadChannelsSettings, type ChannelsSettings } from "./settings-store";
import { appendLog, reloadLogFromDisk } from "./message-log";
import { appendHistory as appendChannelHistory } from "./history-log";
import { toTraditionalTaiwan } from "../utils/opencc";

/** Phase A：用於拼接歷史對話的輕量 ChatMessage 形狀（與 orchestrator ChatMessage 兼容）。 */
interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
}

/** Agent 可以在文字之外附帶一張已匹配完成的表情包。 */
export interface ChannelAgentReply {
  text: string;
  sticker?: {
    id: string;
    imagePath: string;
  };
}

export interface SynthesizedChannelAudio {
  audio: Buffer;
  format: "wav" | "mp3";
}

/**
 * 使用者在 Discord 文字頻道明確要求一段語音。
 * 支援「能傳一段晚安的語音嗎」以及不帶主題的「能傳一段語音嗎」。
 */
export function extractDiscordVoiceRequestTopic(text: string): string | null {
  const cleaned = text.replace(/<@!?\d+>/g, " ").replace(/\s+/g, " ").trim();
  const match = cleaned.match(/能傳一段(?:(.+?)的)?語音(?:嗎)?[？?]?\s*$/u);
  if (!match) return null;
  return match[1]?.trim() || "自由發揮一段自然、親切的內容";
}

export function isDiscordTextVoiceRequest(msg: IncomingMessage): boolean {
  return msg.channel === "discord" && extractDiscordVoiceRequestTopic(msg.text) !== null;
}

/** 把能力詢問改寫成朗讀稿任務，避免模型誤以為平台不能附加音訊。 */
export function prepareDiscordVoiceAgentMessage(msg: IncomingMessage): IncomingMessage {
  if (msg.channel !== "discord") return msg;
  const topic = extractDiscordVoiceRequestTopic(msg.text);
  if (topic === null) return msg;
  return {
    ...msg,
    text: [
      `請直接寫出一段關於「${topic}」、適合用昔漣口吻朗讀的自然口語內容。`,
      "本次回答會由 Discord 語音附件功能自動合成並成功發送。",
      "只輸出要被朗讀的內容，不要解釋傳送方式，也不要討論是否能傳語音。",
    ].join("\n"),
  };
}

/** Discord 一般文字聊天只回文字；語音輪次或明確語音請求才合成音訊。 */
export function shouldSynthesizeChannelTts(msg: IncomingMessage, ttsEnabled: boolean): boolean {
  if (!ttsEnabled) return false;
  if (msg.channel !== "discord") return true;
  if (isDiscordTextVoiceRequest(msg)) return true;
  const raw = msg._raw;
  return !!raw && typeof raw === "object"
    && (raw as { source?: unknown }).source === "discord-voice";
}

/** 所有外部渠道的 AI 顯示文字都統一為台灣繁體；不改動使用者的原始輸入。 */
export function normalizeChannelReplyText(text: string): string {
  return toTraditionalTaiwan(text);
}

const LOG = "[ChannelDispatcher]";

/** sessionId 緩存（用於查重 / 調試 / 上限管理） */
const sessionIndex = new Map<string, { channel: ChannelId; senderId: string; lastAt: number }>();

/** 限速：單用戶每分鐘最多 N 條 */
class RateLimiter {
  private buckets = new Map<string, number[]>(); // key = channel:senderId → timestamp[]
  constructor(private settings: ChannelsSettings) {}

  /** 檢查並記錄一次命中。返回 true = 通過；false = 超限。 */
  hit(channel: ChannelId, senderId: string): boolean {
    const key = `${channel}:${senderId}`;
    const now = Date.now();
    const arr = this.buckets.get(key) ?? [];
    // 砍掉 60s 之外的
    const fresh = arr.filter((t) => now - t < 60_000);
    if (fresh.length >= this.settings.rateLimitPerUser) {
      this.buckets.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.buckets.set(key, fresh);

    // 渠道級全侷限速
    const chKey = `__channel__:${channel}`;
    const chArr = this.buckets.get(chKey) ?? [];
    const chFresh = chArr.filter((t) => now - t < 60_000);
    if (chFresh.length >= this.settings.rateLimitPerChannel) {
      this.buckets.set(chKey, chFresh);
      return false;
    }
    chFresh.push(now);
    this.buckets.set(chKey, chFresh);

    return true;
  }

  /** 測試用：重置所有桶 */
  reset(): void {
    this.buckets.clear();
  }
}

/** 計算一個穩定、匿名的 sessionId。 */
export function makeSessionId(channel: ChannelId, senderId: string): string {
  const hash = createHash("sha256")
    .update(`${channel}:${senderId}`)
    .digest("hex")
    .slice(0, 16);
  return `channel:${channel}:${hash}`;
}

/** 記錄 sessionId → 原始 senderId（用於調試 / 反查；不影響正常運行） */
function recordSession(channel: ChannelId, senderId: string, sessionId: string): void {
  sessionIndex.set(sessionId, { channel, senderId, lastAt: Date.now() });
  // 上限管理：超過 5000 個 sessionId 就丟棄最老的（LRU 近似）
  if (sessionIndex.size > 5000) {
    const oldest = [...sessionIndex.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
    if (oldest) sessionIndex.delete(oldest[0]);
  }
}

/** 把原始 senderId 反查回 sessionId。調試用，不依賴也能跑。 */
export function lookupOriginalSender(sessionId: string): { channel: ChannelId; senderId: string } | null {
  const entry = sessionIndex.get(sessionId);
  return entry ? { channel: entry.channel, senderId: entry.senderId } : null;
}

/** Dispatcher 配置（依賴注入）。 */
export interface DispatcherDeps {
  manager: ChannelManager;
  /** 渲染端 chatWindow 用於鏡像顯示（可選） */
  getChatWindow?: () => { webContents: { isDestroyed(): boolean; send: (channel: string, ...args: unknown[]) => void }; isDestroyed(): boolean } | null;
  /** Phase 1+：完整 agent 調用。Phase 0 留空，返回純 echo。 */
  buildAndRunAgent?: (
    msg: IncomingMessage,
    sessionId: string,
    priorMessages?: ChatMessage[],
  ) => Promise<string | ChannelAgentReply>;
  /** Phase A：讀這個 sessionId 最近 N 條對話歷史（按時間順序）。不提供時不拼歷史，行為同 Phase 0。 */
  loadRecentChannelHistory?: (sessionId: string, limit: number) => Promise<ChatMessage[]>;
  /** Phase 3：可選 — 把文本合成成音頻。失敗返回 null，dispatcher 會跳過 audio。 */
  synthesizeTts?: (text: string) => Promise<SynthesizedChannelAudio | null>;
  /** Phase 3：可選 — 桌面端鏡像廣播：bot 入站/出站消息通知給 chatWindow。 */
  broadcastChat?: (event: {
    type: "bot:incoming" | "bot:outgoing";
    channel: string;
    senderId: string;
    senderName?: string;
    chatId: string;
    text: string;
    at: number;
  }) => void;
}

export class ChannelDispatcher {
  private settings: ChannelsSettings;
  private limiter: RateLimiter;
  deps: DispatcherDeps;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    // 這個 singleton 可能早於 app.whenReady() 建立，此時不可讀 safeStorage。
    // initChannels() 會在 Electron ready 後呼叫 reloadSettings()。
    this.settings = getDefaultChannelsSettings();
    this.limiter = new RateLimiter(this.settings);
    reloadLogFromDisk();
  }

  /** 重新加載 settings（UI 改了限速配置時調） */
  reloadSettings(): void {
    this.settings = loadChannelsSettings();
    this.limiter = new RateLimiter(this.settings);
  }

  /**
   * 處理一條入站消息。這是 manager 注入到 adapter.onMessage 的回調。
   *
   * Phase 0 行為：限速 → 計算 sessionId → 調 buildAndRunAgent（如果有）→ 構造 OutgoingMessage。
   * 如果沒注入 buildAndRunAgent，返回 echo 作為佔位（僅 Phase 0 用於聯調）。
   */
  async handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage | null> {
    if (!this.limiter.hit(msg.channel, msg.senderId)) {
      console.warn(LOG, `限速: ${msg.channel}:${msg.senderId}`);
      return null;
    }

    const sessionId = makeSessionId(msg.channel, msg.senderId);
    recordSession(msg.channel, msg.senderId, sessionId);

    // Phase 3：入站消息廣播到桌面端 chatWindow（讓用戶看到 bot 在和誰聊天）
    if (this.settings.mirrorToDesktop) {
      try {
        this.deps.broadcastChat?.({
          type: "bot:incoming",
          channel: msg.channel,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
          text: msg.text,
          at: msg.at.getTime(),
        });
      } catch (err) {
        console.warn(LOG, "broadcastChat (incoming) 失敗:", err);
      }
    }

    // Phase 3.4：入站消息寫日誌
    try {
      appendLog({
        dir: "incoming",
        channel: msg.channel,
        senderId: msg.senderId,
        senderName: msg.senderName,
        chatId: msg.chatId,
        text: msg.text,
        hasAttachments: (msg.attachments?.length ?? 0) > 0,
      });
    } catch (err) {
      console.warn(LOG, "appendLog (incoming) 失敗:", err);
    }

    // Phase A2：入站消息落對話歷史（下一步 LLM 取的滑窗數據源）
    try {
      appendChannelHistory(sessionId, "user", msg.text);
    } catch (err) {
      console.warn(LOG, "appendHistory (incoming) 失敗:", err);
    }

    // Phase 1 實裝的 agent 調用；Phase 0 沒有 → echo
    let replyText: string;
    let sticker: ChannelAgentReply["sticker"];
    if (this.deps.buildAndRunAgent) {
      // Phase A：拼接最近 16 條歷史 (同桌面端 buildModelMessages 行為).
      // 加載失敗/未注入 → 不拼歷史 (兼容舊實現).
      let priorMessages: ChatMessage[] | undefined;
      if (this.deps.loadRecentChannelHistory) {
        try {
          priorMessages = await this.deps.loadRecentChannelHistory(sessionId, 16);
        } catch (err) {
          console.warn(LOG, "loadRecentChannelHistory 失敗 (繼續不帶歷史):", err);
          priorMessages = undefined;
        }
      }
      try {
        const agentReply = await this.deps.buildAndRunAgent(prepareDiscordVoiceAgentMessage(msg), sessionId, priorMessages);
        if (typeof agentReply === "string") {
          replyText = agentReply;
        } else {
          replyText = agentReply.text;
          sticker = agentReply.sticker;
        }
      } catch (err) {
        console.error(LOG, "agent 調用失敗:", err instanceof Error ? err.message : err);
        return null;
      }
    } else {
      replyText = `[echo][${msg.channel}][${msg.senderId}] ${msg.text}`;
      console.log(LOG, "Phase 0 echo (無 buildAndRunAgent):", replyText);
    }

    replyText = normalizeChannelReplyText(replyText);

    // 構造 OutgoingMessage parts
    const parts: OutgoingPart[] = [{ kind: "text", text: replyText }];
    if (sticker) {
      parts.push({
        kind: "sticker",
        stickerId: sticker.id,
        imagePath: sticker.imagePath,
      });
    }

    // Phase 3：TTS 音頻自動追加（如果啟用且適配器支持 audio）
    const shouldSynthesizeTts = shouldSynthesizeChannelTts(msg, this.settings.ttsEnabled);
    const audioOnlyRequested = isDiscordTextVoiceRequest(msg);
    console.log(LOG, `TTS 決策: enabled=${shouldSynthesizeTts} hasFn=${!!this.deps.synthesizeTts}`);
    if (shouldSynthesizeTts && this.deps.synthesizeTts) {
      const adapterCap = this.deps.manager.getAdapter(msg.channel)?.capability;
      console.log(LOG, `TTS 決策: adapterCap.audio=${adapterCap?.audio}`);
      if (adapterCap?.audio) {
        try {
          const synthesized = await this.deps.synthesizeTts(replyText);
          console.log(LOG, `TTS 決策: 合成結果 length=${synthesized?.audio.length ?? "null"}`);
          if (synthesized && synthesized.audio.length > 0) {
            // 按引擎真實格式寫入，避免 WAV 內容被錯標成 MP3。
            const audioDir = path.join(app.getPath("userData"), "channels", "audio");
            fs.mkdirSync(audioDir, { recursive: true });
            const audioPath = path.join(audioDir, `${msg.channel}-${Date.now()}.${synthesized.format}`);
            fs.writeFileSync(audioPath, synthesized.audio);
            const audioPart: OutgoingPart = { kind: "audio", filePath: audioPath, mime: synthesized.format === "wav" ? "audio/wav" : "audio/mpeg" };
            if (audioOnlyRequested) parts.splice(0, parts.length, audioPart);
            else parts.push(audioPart);
            console.log(LOG, `TTS 合成完成: ${synthesized.audio.length} bytes → ${audioPath}`);
          }
        } catch (err) {
          console.warn(LOG, "TTS 合成失敗（跳過音頻）:", err instanceof Error ? err.message : err);
        }
      }
    }

    // Phase 3：出站消息廣播到桌面端
    if (this.settings.mirrorToDesktop) {
      try {
        this.deps.broadcastChat?.({
          type: "bot:outgoing",
          channel: msg.channel,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
          text: replyText,
          at: Date.now(),
        });
      } catch (err) {
        console.warn(LOG, "broadcastChat (outgoing) 失敗:", err);
    }
    }

    // Phase 3.4：出站消息寫日誌（僅文本 part，附件路徑不寫進 JSONL）
    try {
      appendLog({
        dir: "outgoing",
        channel: msg.channel,
        senderId: msg.senderId,
        senderName: msg.senderName,
        chatId: msg.chatId,
        text: replyText,
        hasAttachments: parts.some((p) => p.kind !== "text"),
      });
    } catch (err) {
      console.warn(LOG, "appendLog (outgoing) 失敗:", err);
    }

    // Phase A2：出站消息落對話歷史（assistant 角色）
    try {
      appendChannelHistory(sessionId, "assistant", replyText);
    } catch (err) {
      console.warn(LOG, "appendHistory (outgoing) 失敗:", err);
    }

    // 構造 OutgoingMessage，capability 降級
    const outgoing: OutgoingMessage = {
      channel: msg.channel,
      targetId: msg.chatId,
      threadId: msg.threadId,
      parts,
    };
    return this.downgradeToCapability(outgoing, this.deps.manager.getAdapter(msg.channel)?.capability);
  }

  /** 按目標渠道 cap 做降級。返回新對象不修改原對象。 */
  downgradeToCapability(msg: OutgoingMessage, cap: ChannelCapability | undefined): OutgoingMessage {
    if (!cap) return msg;
    const parts: OutgoingPart[] = [];
    for (const p of msg.parts) {
      if (p.kind === "text") {
        if (cap.maxTextLength > 0 && p.text.length > cap.maxTextLength) {
          parts.push({
            kind: "text",
            text: p.text.slice(0, Math.max(0, cap.maxTextLength - 20)) + "\n...(過長已截斷)",
          });
        } else {
          parts.push(p);
        }
      } else if (p.kind === "image" && !cap.image) {
        parts.push({ kind: "text", text: `[圖片] ${p.caption ?? p.url ?? p.filePath ?? ""}` });
      } else if (p.kind === "audio" && !cap.audio) {
        parts.push({ kind: "text", text: `[語音消息 ${p.mime}, 見桌面端]` });
      } else if (p.kind === "card" && !cap.card) {
        const lines: string[] = [p.title];
        if (p.markdown) lines.push(p.markdown);
        if (p.fields && p.fields.length > 0) {
          lines.push(...p.fields.map((f) => `${f.key}: ${f.value}`));
        }
        parts.push({ kind: "text", text: lines.join(cap.markdown ? "\n" : "\n") });
      } else if (p.kind === "sticker" && !cap.sticker) {
        // skip
      } else {
        parts.push(p);
      }
    }
    return { ...msg, parts };
  }
}

/** 進程級單例 —— Phase 1 注入 buildAndRunAgent 後才會真正幹活。 */
export const channelDispatcher = new ChannelDispatcher({
  manager: channelManager,
});

/** 給 index.ts 調：注入 buildAndRunAgent（讓 dispatcher 真正跑 agent） */
export function setDispatcherBuildAndRunAgent(
  fn: (
    msg: IncomingMessage,
    sessionId: string,
    priorMessages?: { role: "user" | "assistant" | "system"; content?: string }[],
  ) => Promise<string | ChannelAgentReply>,
): void {
  channelDispatcher.deps.buildAndRunAgent = fn as never;
}

/** Phase 3.1：注入 TTS 合成（返回 mp3 Buffer 或 null） */
export function setDispatcherSynthesizeTts(fn: (text: string) => Promise<SynthesizedChannelAudio | null>): void {
  channelDispatcher.deps.synthesizeTts = fn;
}

/** Phase A：注入最近對話歷史讀取（index.ts 注入一個用 history-log 實現的閉包） */
export function setDispatcherLoadRecentHistory(
  fn: (sessionId: string, limit: number) => Promise<{ role: "user" | "assistant"; content?: string }[]>,
): void {
  channelDispatcher.deps.loadRecentChannelHistory = fn;
}

/** Phase 3.2：注入桌面端鏡像廣播（chatWindow 推送 bot 入站/出站消息） */
export function setDispatcherBroadcastChat(
  fn: (event: {
    type: "bot:incoming" | "bot:outgoing";
    channel: string;
    senderId: string;
    senderName?: string;
    chatId: string;
    text: string;
    at: number;
  }) => void,
): void {
  channelDispatcher.deps.broadcastChat = fn;
}
