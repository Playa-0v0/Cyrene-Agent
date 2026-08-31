import type { ChannelAdapter } from "../base";
import type {
  ChannelCapability,
  ChannelStatus,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  OutgoingPart,
} from "../../types";
import { loadChannelsSettings } from "../../settings-store";
import { OneBotActionClient } from "./onebot-action-client";
import { OneBotMediaManager, versionAtLeast, ONEBOT_STREAM_MIN_VERSION } from "./onebot-media";
import { normalizeOneBotMessage } from "./onebot-normalizer";
import { OneBotReverseWsServer, type OneBotListeningInfo } from "./onebot-reverse-ws";
import {
  isOneBotMessageEvent,
  oneBotId,
  type OneBotEvent,
  type OneBotLoginInfo,
  type OneBotSegment,
  type OneBotVersionInfo,
} from "./onebot-types";
import type { QqChannelConfig } from "../../settings-store";

const CAPABILITY: ChannelCapability = {
  text: true,
  image: true,
  audio: true,
  file: true,
  video: true,
  markdown: false,
  card: false,
  sticker: true,
  maxTextLength: 0,
};

const DEDUPE_TTL_MS = 10 * 60_000;
const MAX_SESSION_QUEUE = 20;
const TEXT_CHUNK_CODEPOINTS = 1500;

interface QueueState {
  tail: Promise<void>;
  pending: number;
}

export function splitQqText(text: string, maxCodepoints = TEXT_CHUNK_CODEPOINTS): string[] {
  const source = text.trim();
  if (!source) return [];
  const result: string[] = [];
  let rest = Array.from(source);
  while (rest.length > maxCodepoints) {
    const window = rest.slice(0, maxCodepoints);
    let splitAt = -1;
    for (let i = window.length - 1; i >= Math.floor(maxCodepoints * 0.55); i--) {
      if (/[。！？!?；;…\n]/u.test(window[i])) {
        splitAt = i + 1;
        break;
      }
    }
    if (splitAt < 0) splitAt = maxCodepoints;
    result.push(window.slice(0, splitAt).join("").trim());
    rest = rest.slice(splitAt);
  }
  const tail = rest.join("").trim();
  if (tail) result.push(tail);
  return result.filter(Boolean);
}

export function isQqEventAllowed(
  event: { message_type: "private" | "group"; user_id: string | number; group_id?: string | number; message: OneBotSegment[] },
  config: QqChannelConfig,
  selfId: string,
): boolean {
  const senderId = oneBotId(event.user_id);
  if (event.message_type === "private") return config.allowedPrivateUserIds.includes(senderId);
  const groupId = oneBotId(event.group_id);
  if (!config.allowedGroupIds.includes(groupId)) return false;
  return !config.groupRequireMention || event.message.some((segment) =>
    segment.type === "at" && oneBotId(segment.data.qq) === selfId,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NapCatAdapter implements ChannelAdapter {
  readonly id = "qq" as const;
  readonly displayName = "QQ（NapCat）";
  readonly capability = CAPABILITY;
  onMessage: MessageHandler | null = null;

  private server: OneBotReverseWsServer | null = null;
  private client: OneBotActionClient | null = null;
  private media = new OneBotMediaManager(() => this.client, undefined, () => {
    this.supportsStream = false;
    this.setStatus({
      enabled: true,
      phase: "running",
      message: `NapCat Stream API 不可用；请升级到 ${ONEBOT_STREAM_MIN_VERSION}+`,
      detail: this.statusDetail(),
    });
  });
  private status: ChannelStatus = { enabled: false, phase: "offline", message: "未启用" };
  private selfId = "";
  private nickname = "";
  private appVersion = "";
  private supportsStream = false;
  private listeningInfo: OneBotListeningInfo | null = null;
  private dedupe = new Map<string, number>();
  private queues = new Map<string, QueueState>();

  constructor(private readonly onStatusChanged?: () => void) {}

  async start(): Promise<void> {
    const config = loadChannelsSettings().qq;
    if (!config.enabled) {
      this.setStatus({ enabled: false, phase: "offline", message: "未启用" });
      return;
    }
    this.setStatus({ enabled: true, phase: "starting", message: "正在启动 OneBot 监听" });
    await this.media.start();
    this.server = new OneBotReverseWsServer({
      listenMode: config.listenMode,
      customHost: config.customHost,
      port: config.port,
      accessToken: config.accessToken,
      onEvent: (event, client) => this.handleEvent(event, client),
      onClientConnected: (client, info) => this.handleConnected(client, info.headerSelfId),
      onClientDisconnected: () => {
        this.client = null;
        this.selfId = "";
        this.setStatus({
          enabled: true,
          phase: "starting",
          message: "监听中，等待 NapCat 重连",
          detail: this.statusDetail(),
        });
      },
      onError: (error) => {
        this.setStatus({
          enabled: true,
          phase: "error",
          message: error.message,
          detail: this.statusDetail(),
        });
      },
    });
    try {
      this.listeningInfo = await this.server.start();
      this.setStatus({
        enabled: true,
        phase: "starting",
        message: "监听中，等待 NapCat 连接",
        detail: this.statusDetail(),
      });
    } catch (error) {
      this.media.stop();
      this.server = null;
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ enabled: true, phase: "error", message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.media.stop();
    await this.server?.stop();
    this.server = null;
    this.client = null;
    this.selfId = "";
    this.nickname = "";
    this.appVersion = "";
    this.supportsStream = false;
    this.listeningInfo = null;
    this.dedupe.clear();
    this.queues.clear();
    this.setStatus({ enabled: false, phase: "offline", message: "已停止" });
  }

  getStatus(): ChannelStatus {
    const config = loadChannelsSettings().qq;
    if (!config.enabled) return { enabled: false, phase: "offline", message: "未启用" };
    return this.status;
  }

  getConnectionInfo(): Record<string, unknown> {
    return this.statusDetail();
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }> {
    if (!this.client || !this.selfId) return { ok: false, error: "NapCat 尚未连接" };
    try {
      const status = await this.client.call<Record<string, unknown>>("get_status");
      return { ok: true, detail: { ...this.statusDetail(), protocolStatus: status } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    const client = this.client;
    if (!client || !this.selfId) return { ok: false, error: "NapCat 未连接" };
    const payloads: OneBotSegment[][] = [];
    let lastError: string | undefined;

    for (const part of msg.parts) {
      try {
        payloads.push(...await this.partToPayloads(part));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (payloads.length === 0) return { ok: false, error: lastError || "没有可发送的 QQ 内容" };

    let sent = 0;
    for (let index = 0; index < payloads.length; index++) {
      const segments = [...payloads[index]];
      if (index === 0 && msg.chatType === "group" && msg.replyContext) {
        const prefix: OneBotSegment[] = [{ type: "reply", data: { id: msg.replyContext.messageId } }];
        if (msg.replyContext.mentionUserId) {
          prefix.push(
            { type: "at", data: { qq: msg.replyContext.mentionUserId } },
            { type: "text", data: { text: " " } },
          );
        }
        segments.unshift(...prefix);
      }
      try {
        if (msg.chatType === "group") {
          await client.call("send_group_msg", { group_id: msg.targetId, message: segments });
        } else {
          await client.call("send_private_msg", { user_id: msg.targetId, message: segments });
        }
        sent++;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (index < payloads.length - 1) await delay(500);
    }
    if (sent > 0 && lastError) {
      console.warn("[NapCatAdapter] QQ 消息部分发送失败:", lastError);
    }
    return sent > 0 ? { ok: true } : { ok: false, error: lastError || "QQ 发送失败" };
  }

  private async handleConnected(client: OneBotActionClient, headerSelfId?: string): Promise<void> {
    const login = await client.call<OneBotLoginInfo>("get_login_info");
    const version = await client.call<OneBotVersionInfo>("get_version_info");
    const selfId = oneBotId(login.user_id);
    if (!selfId) throw new Error("NapCat get_login_info 未返回 user_id");
    if (headerSelfId && headerSelfId !== selfId) throw new Error("NapCat X-Self-ID 与 get_login_info 不一致");
    this.client = client;
    this.selfId = selfId;
    this.nickname = login.nickname ?? "";
    this.appVersion = version.app_version ?? "";
    this.supportsStream = versionAtLeast(this.appVersion, ONEBOT_STREAM_MIN_VERSION);
    this.setStatus({
      enabled: true,
      phase: "running",
      message: this.supportsStream ? "NapCat 已连接" : `NapCat 已连接；媒体流需要 ${ONEBOT_STREAM_MIN_VERSION}+`,
      detail: this.statusDetail(),
    });
  }

  private async handleEvent(event: OneBotEvent, client: OneBotActionClient): Promise<void> {
    if (!isOneBotMessageEvent(event) || event.post_type !== "message") return;
    if (!this.selfId || oneBotId(event.self_id) !== this.selfId || oneBotId(event.user_id) === this.selfId) return;

    const config = loadChannelsSettings().qq;
    const senderId = oneBotId(event.user_id);
    const chatId = event.message_type === "group" ? oneBotId(event.group_id) : senderId;
    if (!chatId) return;
    if (!isQqEventAllowed(event, config, this.selfId)) return;

    const dedupeKey = `${this.selfId}:${oneBotId(event.message_id)}`;
    const now = Date.now();
    for (const [key, expiresAt] of this.dedupe) if (expiresAt <= now) this.dedupe.delete(key);
    if (this.dedupe.has(dedupeKey)) return;
    this.dedupe.set(dedupeKey, now + DEDUPE_TTL_MS);

    this.enqueue(chatId, async () => {
      const incoming = await normalizeOneBotMessage(event, {
        selfId: this.selfId,
        client,
        media: this.media,
        supportsStream: this.supportsStream,
      });
      await this.onMessage?.(incoming);
    });
  }

  private enqueue(chatId: string, task: () => Promise<void>): void {
    const current = this.queues.get(chatId) ?? { tail: Promise.resolve(), pending: 0 };
    if (current.pending >= MAX_SESSION_QUEUE) return;
    current.pending++;
    current.tail = current.tail
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        console.warn("[NapCatAdapter] QQ 会话处理失败:", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        current.pending--;
        if (current.pending === 0) this.queues.delete(chatId);
      });
    this.queues.set(chatId, current);
  }

  private async partToPayloads(part: OutgoingPart): Promise<OneBotSegment[][]> {
    if (part.kind === "text") {
      return splitQqText(part.text).map((text) => [{ type: "text", data: { text } }]);
    }
    if (part.kind === "card") {
      const text = [part.title, part.markdown, ...(part.fields ?? []).map((field) => `${field.key}: ${field.value}`)]
        .filter(Boolean)
        .join("\n");
      return splitQqText(text).map((value) => [{ type: "text", data: { text: value } }]);
    }
    if (part.kind === "image") {
      const file = part.filePath
        ? await this.media.encodeOutbound(part.filePath, "image", this.supportsStream)
        : part.url;
      if (!file) throw new Error("QQ 图片缺少 filePath/url");
      return [[{ type: "image", data: { file } }]];
    }
    if (part.kind === "sticker") {
      const file = await this.media.encodeOutbound(part.imagePath, "image", this.supportsStream);
      return [[{ type: "image", data: { file } }]];
    }
    if (part.kind === "audio") {
      const file = await this.media.encodeOutbound(part.filePath, "audio", this.supportsStream);
      return [[{ type: "record", data: { file } }]];
    }
    if (part.kind === "file") {
      const file = await this.media.encodeOutbound(part.filePath, "file", this.supportsStream);
      return [[{ type: "file", data: { file, name: part.name } }]];
    }
    const file = await this.media.encodeOutbound(part.filePath, "video", this.supportsStream);
    return [[{ type: "video", data: { file } }]];
  }

  private statusDetail(): Record<string, unknown> {
    return {
      listenUrl: this.listeningInfo?.url,
      listenHost: this.listeningInfo?.host,
      listenMode: this.listeningInfo?.mode,
      selfId: this.selfId || undefined,
      nickname: this.nickname || undefined,
      appVersion: this.appVersion || undefined,
      supportsStream: this.supportsStream,
      streamMinimumVersion: ONEBOT_STREAM_MIN_VERSION,
    };
  }

  private setStatus(status: ChannelStatus): void {
    this.status = status;
    this.onStatusChanged?.();
  }
}
