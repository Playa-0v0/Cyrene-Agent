// 飛書 FeishuAdapter —— implements ChannelAdapter。
//
// 接入方式：**長連接 WebSocket**（飛書官方 SDK 內置支持）。
// 比 HTTP webhook 簡單幾個數量級：
//   - 不需要公網 HTTPS URL（飛書 SDK 主動連出）
//   - 不需要 Verification Token / Encrypt Key（WS 自動鑑權）
//   - 不需要內網穿透
//   - 重連 / 心跳 / ack SDK 全自動處理
//
// 數據流：
//   飛書服務器 ←WSS→ @larksuiteoapi/node-sdk WSClient
//       ↓ onMessage (normalized LarkChannel event)
//       ↓ LarkChannel.on('message')
//   FeishuAdapter.handleLarkMessage → adapter.onMessage (dispatcher)
//       ↓ CyreneAgent runs
//   LarkChannel.send(chatId, { text }) → 飛書服務器
//
// 圖片/文件/音頻消息：通過 SDK 的 messageResource.get 下載到 userData/channels/cache/
// 轉化為本地 filePath 寫入 IncomingMessage.attachments，buildAgentRunOptions 會注入 prompt。
//
// 注意：本 adapter 只在用戶啟用飛書時才創建 LarkChannel 實例。
// 切換 enabled/config 後調 rebuild() 重啟。
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import {
  createLarkChannel,
  Domain,
  LoggerLevel,
  type LarkChannel,
  type NormalizedMessage,
  type SendInput,
  type EventName,
} from "@larksuiteoapi/node-sdk";
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
import { getAudioDurationMs } from "./audio-duration";

const LOG = "[FeishuAdapter]";

/** 飛書 capability 聲明。SDK 已經把消息/圖片/音頻/視頻/卡片/sticker 都內置支持 */
const FEISHU_CAPABILITY: ChannelCapability = {
  text: true,
  image: true,
  audio: true,
  file: true,
  video: true,
  markdown: true,
  card: true,
  sticker: true,
  maxTextLength: 4000,
};

/** 飛書資源類型 → 我們的附件類型 + 擴展名 */
function resourceKindToExt(ktype: string): { ext: string; mime: string } {
  switch (ktype) {
    case "image": return { ext: ".png", mime: "image/png" };
    case "audio": return { ext: ".mp3", mime: "audio/mpeg" };
    case "video": return { ext: ".mp4", mime: "video/mp4" };
    case "file":  return { ext: ".bin", mime: "application/octet-stream" };
    case "sticker": return { ext: ".png", mime: "image/png" };
    default: return { ext: ".bin", mime: "application/octet-stream" };
  }
}

/** 把飛書資源下載到本地緩存目錄。返回本地文件路徑或 null（失敗時）。 */
async function downloadLarkResource(
  channel: LarkChannel,
  messageId: string,
  fileKey: string,
  kind: string,
): Promise<string | null> {
  const cacheDir = path.join(app.getPath("userData"), "channels", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  // 命名: feishu-<messageId>-<fileKey 末 8 位>.<ext>
  const { ext } = resourceKindToExt(kind);
  const shortKey = fileKey.slice(-8);
  const localPath = path.join(cacheDir, `feishu-${messageId}-${shortKey}${ext}`);
  if (fs.existsSync(localPath)) return localPath; // 已下載過
  try {
    // 繞過 LarkChannel.downloadResource() 這個 wrapper 的 bug —— 它對 image 調的是
    // /open-apis/im/v1/image/{image_key}（只能下機器人自己上傳的圖），而我們要的是
    // /open-apis/im/v1/messages/{message_id}/resources/{file_key}（用戶發的圖）。
    // 直接用 channel.rawClient 調正確的 API。
    const typeParam = (kind === "file" || kind === "audio" || kind === "video") ? "file" : "image";
    const res = await channel.rawClient.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: typeParam },
    });
    // SDK 返回帶 writeFile / getReadableStream / headers；用 writeFile 直接落盤
    if (res && typeof res.writeFile === "function") {
      await res.writeFile(localPath);
    } else {
      // 兜底：手動從 readable stream 讀
      const stream = res.getReadableStream();
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => resolve());
        stream.on("error", (e: Error) => reject(e));
      });
      fs.writeFileSync(localPath, Buffer.concat(chunks));
    }
    const stat = fs.statSync(localPath);
    console.log(LOG, `已下載飛書資源 → ${localPath} (${stat.size} bytes, kind=${kind})`);
    return localPath;
  } catch (err) {
    console.warn(LOG, `下載飛書資源失敗: messageId=${messageId} fileKey=${fileKey} err=`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** 把飛書 NormalizedMessage → 我們的 IncomingMessage（異步，會下載附件） */
async function normalizeLarkMessage(
  channel: LarkChannel,
  msg: NormalizedMessage,
): Promise<IncomingMessage> {
  // msg.content 是 JSON 字符串，msg.rawContentType 是消息類型（"text" / "image" / "post" / ...）
  let text = "";
  const rawType = msg.rawContentType ?? "text";
  const attachments: IncomingMessage["attachments"] = [];

  if (rawType === "text") {
    try {
      const c = JSON.parse(msg.content) as { text?: string };
      text = c.text ?? msg.content;
    } catch {
      text = msg.content;
    }
  } else if (rawType === "image" || rawType === "file" || rawType === "audio" || rawType === "video" || rawType === "sticker") {
    // 下載所有 resources 到本地，給 LLM 一個明確的本地路徑
    for (const r of msg.resources ?? []) {
      const localPath = await downloadLarkResource(channel, msg.messageId, r.fileKey, r.type);
      if (localPath) {
        const { mime } = resourceKindToExt(r.type);
        attachments.push({
          kind: r.type === "sticker" ? "image" : (r.type as "image" | "file" | "audio" | "video"),
          filePath: localPath,
          mime,
          caption: r.fileName,
        });
        if (!text) text = `[${rawType}]`;
        // 把"附件路徑"嵌進 text，讓 LLM 一眼看到
        text = (text ? text + "\n" : "") + `[附件: ${localPath}]`;
      }
    }
    if (attachments.length === 0) text = `[${rawType}]`;
  } else {
    // post / interactive / shareChat 等未知類型
    text = `[${rawType}]`;
  }

  return {
    channel: "feishu",
    senderId: msg.senderId ?? "",
    senderName: msg.senderName,
    chatId: msg.chatId,
    threadId: msg.threadId,
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
    at: new Date(msg.createTime ?? Date.now()),
    _raw: msg,
  };
}

/** 把我們 OutgoingMessage.parts 翻譯成飛書 SendInput。飛書 send() 一次只發一個 payload，
 *  所以多 parts 時循環調用 send。 */
async function sendLark(channel: LarkChannel, targetId: string, part: OutgoingPart): Promise<{ messageId: string } | null> {
  let result: { messageId: string } | null = null;
  switch (part.kind) {
    case "text": {
      result = (await channel.send(targetId, { text: part.text } as SendInput)) ?? null;
      break;
    }
    case "image": {
      if (part.filePath) {
        // 飛書 image: { image: { source: path/Buffer } }
        result = (await channel.send(targetId, {
          image: { source: part.filePath },
        } as SendInput)) ?? null;
      } else if (part.url) {
        throw new Error("image URL 需要先下載到本地 filePath");
      } else {
        throw new Error("image part needs filePath or url");
      }
      break;
    }
    case "audio": {
      // 飛書 audio: { audio: { source: path/Buffer, duration } } (duration 是毫秒, 必填)
      // SDK 內部 MediaUploader.resolveDuration 只對 Opus 自動解析;
      // 我們 TTS 輸出 mp3 → 必須先解析 mp3 時長再傳 duration, 否則 SDK 報
      // "duration could not be determined for audio; pass it explicitly"
      const duration = await getAudioDurationMs(part.filePath);
      if (!duration) {
        throw new Error(`無法解析音頻時長: ${part.filePath}`);
      }
      result = (await channel.send(targetId, {
        audio: {
          source: part.filePath,
          duration,
        },
      } as SendInput)) ?? null;
      break;
    }
    case "card": {
      result = (await channel.send(targetId, {
        card: {
          schema: "2.0",
          header: { title: { tag: "plain_text", content: part.title }, template: "blue" },
          elements: [
            { tag: "div", text: { tag: "lark_md", content: part.markdown ?? "" } },
            ...(part.fields && part.fields.length > 0
              ? [
                  {
                    tag: "div",
                    fields: part.fields.map((f) => ({
                      is_short: true,
                      text: { tag: "lark_md", content: `**${f.key}**\n${f.value}` },
                    })),
                  },
                ]
              : []),
          ],
        },
      } as unknown as SendInput)) ?? null;
      break;
    }
    case "sticker": {
      result = (await channel.send(targetId, { file_key: part.imagePath } as unknown as SendInput)) ?? null;
      break;
    }
  }
  return result;
}

export class FeishuAdapter implements ChannelAdapter {
  readonly id = "feishu" as const;
  readonly displayName = "飛書";
  readonly capability = FEISHU_CAPABILITY;
  onMessage: MessageHandler | null = null;

  private channel: LarkChannel | null = null;
  private status: ChannelStatus = { enabled: false, phase: "config_missing" };

  constructor() {
    // start() 時再初始化
  }

  /** 重建 LarkChannel 實例（用戶在 UI 裡改了 AppID/Secret 後調） */
  private async rebuildChannel(): Promise<LarkChannel | null> {
    const settings = loadChannelsSettings().feishu;
    if (!settings.enabled) {
      this.status = { enabled: false, phase: "offline", message: "未啟用" };
      return null;
    }
    if (!settings.appId || !settings.appSecret) {
      this.status = {
        enabled: true,
        phase: "config_missing",
        message: "App ID / App Secret 缺失",
      };
      return null;
    }

    const ch = createLarkChannel({
      appId: settings.appId,
      appSecret: settings.appSecret,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.warn,
      transport: "websocket",
    });

    // 綁定入站消息
    ch.on("message" as EventName, async (msg: NormalizedMessage) => {
      // 私聊 only（方案決策）
      if (msg.chatType !== "p2p") {
        console.log(LOG, `忽略 ${msg.chatType} 消息 (私聊優先)`);
        return;
      }
      try {
        const inMsg = await normalizeLarkMessage(ch, msg);
        if (this.onMessage) {
          await this.onMessage(inMsg);
        }
      } catch (err) {
        console.error(LOG, "處理入站消息失敗:", err);
      }
    });

    // 錯誤/重連事件
    ch.on("error" as EventName, (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(LOG, "channel error:", msg);
      this.status = { enabled: true, phase: "error", message: msg };
    });
    ch.on("reconnecting" as EventName, () => {
      console.log(LOG, "reconnecting…");
      this.status = { enabled: true, phase: "starting", message: "重新連接中" };
    });
    ch.on("reconnected" as EventName, () => {
      console.log(LOG, "reconnected");
      this.status = { enabled: true, phase: "running", message: "已連接" };
    });

    this.channel = ch;
    return ch;
  }

  async start(): Promise<void> {
    const ch = await this.rebuildChannel();
    if (!ch) return;

    try {
      await ch.connect();
      this.status = { enabled: true, phase: "running", message: "長連接已建立" };
      console.log(LOG, "WS 長連接就緒");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(LOG, "connect() failed:", msg);
      this.status = { enabled: true, phase: "error", message: msg };
    }
  }

  async stop(): Promise<void> {
    if (this.channel) {
      try {
        await this.channel.disconnect();
      } catch (err) {
        console.warn(LOG, "disconnect 失敗:", err);
      }
      this.channel = null;
    }
    this.status = { enabled: false, phase: "offline", message: "已停止" };
  }

  getStatus(): ChannelStatus {
    const settings = loadChannelsSettings().feishu;
    if (!settings.enabled) {
      return { enabled: false, phase: "offline", message: "未啟用" };
    }
    if (!settings.appId || !settings.appSecret) {
      return { enabled: true, phase: "config_missing", message: "App ID/Secret 缺失" };
    }
    return this.status;
  }

  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.channel) {
      console.warn(LOG, "send 失敗: 長連接未建立");
      return { ok: false, error: "飛書長連接未建立" };
    }
    if (!msg.parts || msg.parts.length === 0) {
      return { ok: false, error: "沒有可發送的內容" };
    }
    console.log(LOG, `send: targetId=${msg.targetId} parts=${msg.parts.length}`);
    let lastErr: string | undefined;
    let anyOk = false;
    for (const part of msg.parts) {
      try {
        const r = await sendLark(this.channel, msg.targetId, part);
        console.log(LOG, `send ok: messageId=${r?.messageId ?? "?"}`);
        anyOk = true;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        console.error(LOG, `send part failed: targetId=${msg.targetId} part=${part.kind} err=`, lastErr, err);
      }
    }
    if (!anyOk) return { ok: false, error: lastErr ?? "send failed" };
    return { ok: true };
  }

  /** 給外部：觸發重建（用戶改 AppID/Secret 後調用） */
  public async rebuild(): Promise<void> {
    if (this.channel) {
      try {
        await this.channel.disconnect();
      } catch {
        /* ignore */
      }
      this.channel = null;
    }
    await this.start();
  }
}