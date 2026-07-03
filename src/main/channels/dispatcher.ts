// channels/dispatcher —— 入站消息处理核心。
//
// 设计原则：
//   - 不知道任何具体平台。platform 信息只用于查找 adapter / 落日志 / 写 sessionId。
//   - 完全无副作用：UI 广播、记忆写入、sticker 推断都在外部注入的回调里完成。
//   - Phase 0 只搭骨架 + sessionId hash + 限速 + capability 降级工具函数。
//     Phase 1 填入完整的 agent 调用（handleIncoming → CyreneAgent）。
//
// sessionId 生成规则：
//   `channel:<channel>:<sha256(channel:senderId).slice(0,16)>`
//   加 channel 前缀防止跨平台 ID 冲突；hash 截断 16 字符节约空间且日志脱敏。
//
// capability 降级：
//   把 OutgoingMessage 按目标渠道的 cap 翻译 —— image→text 描述 / card→markdown / sticker 跳过。
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
import { loadChannelsSettings, type ChannelsSettings } from "./settings-store";
import { appendLog, reloadLogFromDisk } from "./message-log";

const LOG = "[ChannelDispatcher]";

/** sessionId 缓存（用于查重 / 调试 / 上限管理） */
const sessionIndex = new Map<string, { channel: ChannelId; senderId: string; lastAt: number }>();

/** 限速：单用户每分钟最多 N 条 */
class RateLimiter {
  private buckets = new Map<string, number[]>(); // key = channel:senderId → timestamp[]
  constructor(private settings: ChannelsSettings) {}

  /** 检查并记录一次命中。返回 true = 通过；false = 超限。 */
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

    // 渠道级全局限速
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

  /** 测试用：重置所有桶 */
  reset(): void {
    this.buckets.clear();
  }
}

/** 计算一个稳定、匿名的 sessionId。 */
export function makeSessionId(channel: ChannelId, senderId: string): string {
  const hash = createHash("sha256")
    .update(`${channel}:${senderId}`)
    .digest("hex")
    .slice(0, 16);
  return `channel:${channel}:${hash}`;
}

/** 记录 sessionId → 原始 senderId（用于调试 / 反查；不影响正常运行） */
function recordSession(channel: ChannelId, senderId: string, sessionId: string): void {
  sessionIndex.set(sessionId, { channel, senderId, lastAt: Date.now() });
  // 上限管理：超过 5000 个 sessionId 就丢弃最老的（LRU 近似）
  if (sessionIndex.size > 5000) {
    const oldest = [...sessionIndex.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
    if (oldest) sessionIndex.delete(oldest[0]);
  }
}

/** 把原始 senderId 反查回 sessionId。调试用，不依赖也能跑。 */
export function lookupOriginalSender(sessionId: string): { channel: ChannelId; senderId: string } | null {
  const entry = sessionIndex.get(sessionId);
  return entry ? { channel: entry.channel, senderId: entry.senderId } : null;
}

/** Dispatcher 配置（依赖注入）。 */
export interface DispatcherDeps {
  manager: ChannelManager;
  /** 渲染端 chatWindow 用于镜像显示（可选） */
  getChatWindow?: () => { webContents: { isDestroyed(): boolean; send: (channel: string, ...args: unknown[]) => void }; isDestroyed(): boolean } | null;
  /** Phase 1+：完整 agent 调用。Phase 0 留空，返回纯 echo。 */
  buildAndRunAgent?: (msg: IncomingMessage, sessionId: string) => Promise<string>;
  /** Phase 3：可选 — 把文本合成成音频 (mp3 buffer)。失败返回 null，dispatcher 会跳过 audio。 */
  synthesizeTts?: (text: string) => Promise<Buffer | null>;
  /** Phase 3：可选 — 桌面端镜像广播：bot 入站/出站消息通知给 chatWindow。 */
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
    this.settings = loadChannelsSettings();
    this.limiter = new RateLimiter(this.settings);
    reloadLogFromDisk();
  }

  /** 重新加载 settings（UI 改了限速配置时调） */
  reloadSettings(): void {
    this.settings = loadChannelsSettings();
    this.limiter = new RateLimiter(this.settings);
  }

  /**
   * 处理一条入站消息。这是 manager 注入到 adapter.onMessage 的回调。
   *
   * Phase 0 行为：限速 → 计算 sessionId → 调 buildAndRunAgent（如果有）→ 构造 OutgoingMessage。
   * 如果没注入 buildAndRunAgent，返回 echo 作为占位（仅 Phase 0 用于联调）。
   */
  async handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage | null> {
    if (!this.limiter.hit(msg.channel, msg.senderId)) {
      console.warn(LOG, `限速: ${msg.channel}:${msg.senderId}`);
      return null;
    }

    const sessionId = makeSessionId(msg.channel, msg.senderId);
    recordSession(msg.channel, msg.senderId, sessionId);

    // Phase 3：入站消息广播到桌面端 chatWindow（让用户看到 bot 在和谁聊天）
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
        console.warn(LOG, "broadcastChat (incoming) 失败:", err);
      }
    }

    // Phase 3.4：入站消息写日志
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
      console.warn(LOG, "appendLog (incoming) 失败:", err);
    }

    // Phase 1 实装的 agent 调用；Phase 0 没有 → echo
    let replyText: string;
    if (this.deps.buildAndRunAgent) {
      try {
        replyText = await this.deps.buildAndRunAgent(msg, sessionId);
      } catch (err) {
        console.error(LOG, "agent 调用失败:", err instanceof Error ? err.message : err);
        return null;
      }
    } else {
      replyText = `[echo][${msg.channel}][${msg.senderId}] ${msg.text}`;
      console.log(LOG, "Phase 0 echo (无 buildAndRunAgent):", replyText);
    }

    // 构造 OutgoingMessage parts
    const parts: OutgoingPart[] = [{ kind: "text", text: replyText }];

    // Phase 3：TTS 音频自动追加（如果启用且适配器支持 audio）
    console.log(LOG, `TTS 决策: ttsEnabled=${this.settings.ttsEnabled} hasFn=${!!this.deps.synthesizeTts}`);
    if (this.settings.ttsEnabled && this.deps.synthesizeTts) {
      const adapterCap = this.deps.manager.getAdapter(msg.channel)?.capability;
      console.log(LOG, `TTS 决策: adapterCap.audio=${adapterCap?.audio}`);
      if (adapterCap?.audio) {
        try {
          const audioBuf = await this.deps.synthesizeTts(replyText);
          console.log(LOG, `TTS 决策: 合成结果 length=${audioBuf?.length ?? "null"}`);
          if (audioBuf && audioBuf.length > 0) {
            // 写到 userData/channels/audio/<messageId>.mp3 缓存
            const audioDir = path.join(app.getPath("userData"), "channels", "audio");
            fs.mkdirSync(audioDir, { recursive: true });
            const audioPath = path.join(audioDir, `${msg.channel}-${Date.now()}.mp3`);
            fs.writeFileSync(audioPath, audioBuf);
            parts.push({ kind: "audio", filePath: audioPath, mime: "audio/mpeg" });
            console.log(LOG, `TTS 合成完成: ${audioBuf.length} bytes → ${audioPath}`);
          }
        } catch (err) {
          console.warn(LOG, "TTS 合成失败（跳过音频）:", err instanceof Error ? err.message : err);
        }
      }
    }

    // Phase 3：出站消息广播到桌面端
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
        console.warn(LOG, "broadcastChat (outgoing) 失败:", err);
    }
    }

    // Phase 3.4：出站消息写日志（仅文本 part，附件路径不写进 JSONL）
    try {
      appendLog({
        dir: "outgoing",
        channel: msg.channel,
        senderId: msg.senderId,
        senderName: msg.senderName,
        chatId: msg.chatId,
        text: replyText,
        hasAttachments: parts.some((p) => p.kind === "audio"),
      });
    } catch (err) {
      console.warn(LOG, "appendLog (outgoing) 失败:", err);
    }

    // 构造 OutgoingMessage，capability 降级
    const outgoing: OutgoingMessage = {
      channel: msg.channel,
      targetId: msg.chatId,
      threadId: msg.threadId,
      parts,
    };
    return this.downgradeToCapability(outgoing, this.deps.manager.getAdapter(msg.channel)?.capability);
  }

  /** 按目标渠道 cap 做降级。返回新对象不修改原对象。 */
  downgradeToCapability(msg: OutgoingMessage, cap: ChannelCapability | undefined): OutgoingMessage {
    if (!cap) return msg;
    const parts: OutgoingPart[] = [];
    for (const p of msg.parts) {
      if (p.kind === "text") {
        if (cap.maxTextLength > 0 && p.text.length > cap.maxTextLength) {
          parts.push({
            kind: "text",
            text: p.text.slice(0, Math.max(0, cap.maxTextLength - 20)) + "\n...(过长已截断)",
          });
        } else {
          parts.push(p);
        }
      } else if (p.kind === "image" && !cap.image) {
        parts.push({ kind: "text", text: `[图片] ${p.caption ?? p.url ?? p.filePath ?? ""}` });
      } else if (p.kind === "audio" && !cap.audio) {
        parts.push({ kind: "text", text: `[语音消息 ${p.mime}, 见桌面端]` });
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

/** 进程级单例 —— Phase 1 注入 buildAndRunAgent 后才会真正干活。 */
export const channelDispatcher = new ChannelDispatcher({
  manager: channelManager,
});

/** 给 index.ts 调：注入 buildAndRunAgent（让 dispatcher 真正跑 agent） */
export function setDispatcherBuildAndRunAgent(
  fn: (msg: IncomingMessage, sessionId: string) => Promise<string>,
): void {
  channelDispatcher.deps.buildAndRunAgent = fn;
}

/** Phase 3.1：注入 TTS 合成（返回 mp3 Buffer 或 null） */
export function setDispatcherSynthesizeTts(fn: (text: string) => Promise<Buffer | null>): void {
  channelDispatcher.deps.synthesizeTts = fn;
}

/** Phase 3.2：注入桌面端镜像广播（chatWindow 推送 bot 入站/出站消息） */
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