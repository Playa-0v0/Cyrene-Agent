// ILink Bot Adapter —— 用 iLinkProtocolClient 包出 ChannelAdapter。
//
// 流程：
//   微信用户发消息
//     └─ ILinkClient.getUpdates() (long-poll 35s)
//           └─ adapter.onMessage() → dispatcher → buildAndRunAgent → OutgoingMessage
//                 └─ ILinkClient.sendText() → POST /sendmessage → 微信
//
// 凭据存盘：<userData>/weixin/<botId>.json
// （首次运行需在 UI 点"扫码登录"生成；之后自动续用）
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
  ILinkClient,
  MediaType,
  pollQrStatus,
  SessionExpiredError,
  type CDNMedia,
  type Credentials,
  type SendMessageItem,
  type WeixinMessage,
} from "./ilink-protocol-client";
import { uploadWechatMediaFile } from "./wechat-media-upload";
import type {
  ChannelCapability,
  ChannelId,
  ChannelStatus,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
} from "../../types";
import type { ChannelAdapter } from "../base";

const LOG_PREFIX = "[WechatBot]";

// ─────────────────────────────────────────────────────────────────────────────
// Capability
// ─────────────────────────────────────────────────────────────────────────────

const CAPABILITY: ChannelCapability = {
  text: true,
  image: true,
  audio: false,    // iLink 支持 voice_item，先不上传，等用到再加
  file: true,
  video: true,
  markdown: false,
  card: false,
  sticker: true,
  maxTextLength: 2048,
};

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export class ILinkBotAdapter implements ChannelAdapter {
  readonly id: ChannelId = "wechat";
  readonly displayName = "微信";
  readonly capability = CAPABILITY;

  /** 由 ChannelManager.setDispatcher 注入 */
  onMessage: MessageHandler | null = null;

  private client: ILinkClient | null = null;
  private pollAbort: AbortController | null = null;
  private pollLoopPromise: Promise<void> | null = null;
  /** 账号是否已登录（凭证存在） */
  isLoggedIn = false;
  /** 当前 credentials（动态加载） */
  currentCredentials: Credentials | null = null;
  private replyContextByTarget = new Map<string, string>();
  private uploadMedia = uploadWechatMediaFile;

  status: ChannelStatus = { enabled: false, phase: "offline" };

  // ── ChannelAdapter ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.status = { enabled: true, phase: "starting" };
    console.log(LOG_PREFIX, "Starting...");

    // 1. 加载已存凭证
    const creds = await loadCredentials();
    if (!creds) {
      this.status = {
        enabled: true,
        phase: "config_missing",
        message: "未登录，请先扫码",
      };
      console.log(LOG_PREFIX, "No credentials, please run /wechat login");
      return;
    }

    this.currentCredentials = creds;
    this.client = new ILinkClient(creds);
    this.isLoggedIn = true;

    // 2. 启动 long-poll 循环
    this.pollAbort = new AbortController();
    this.pollLoopPromise = this.#pollLoop();

    this.status = { enabled: true, phase: "running", message: "微信已连接" };
    console.log(LOG_PREFIX, `Connected as botId=${creds.ilinkBotId}`);
  }

  async stop(): Promise<void> {
    console.log(LOG_PREFIX, "Stopping...");
    this.pollAbort?.abort();
    if (this.pollLoopPromise) {
      try {
        await this.pollLoopPromise;
      } catch {}
      this.pollLoopPromise = null;
    }
    this.pollAbort = null;
    this.client = null;
    this.isLoggedIn = false;
    this.status = { enabled: false, phase: "offline" };
  }

  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: "微信未连接" };
    const contextToken = this.replyContextByTarget.get(msg.targetId);
    if (!contextToken) return { ok: false, error: "缺少微信 context_token，无法回复" };

    const hasMedia = msg.parts.some((p) => p.kind === "image" || p.kind === "sticker" || p.kind === "file" || p.kind === "video");
    if (!hasMedia) {
      const text = msg.parts
        .filter((p) => p.kind === "text")
        .map((p) => p.text)
        .join("")
        .trim();
      if (!text) return { ok: true };
      return this.client.sendText(msg.targetId, text, contextToken);
    }

    const items: SendMessageItem[] = [];
    for (const part of msg.parts) {
      if (part.kind === "text") {
        const text = part.text.trim();
        if (text) items.push({ type: 1, text_item: { text } });
      } else if (part.kind === "image") {
        if (!part.filePath) return { ok: false, error: "微信图片发送需要本地 filePath" };
        const media = await this.uploadMedia(this.client, msg.targetId, part.filePath, MediaType.IMAGE);
        items.push(buildImageItem(media));
      } else if (part.kind === "sticker") {
        const media = await this.uploadMedia(this.client, msg.targetId, part.imagePath, MediaType.IMAGE);
        items.push(buildImageItem(media));
      } else if (part.kind === "file") {
        const media = await this.uploadMedia(this.client, msg.targetId, part.filePath, MediaType.FILE);
        items.push(buildFileItem(media, path.basename(part.name ?? part.filePath)));
      } else if (part.kind === "video") {
        const media = await this.uploadMedia(this.client, msg.targetId, part.filePath, MediaType.VIDEO);
        items.push(buildVideoItem(media));
      }
    }
    if (items.length === 0) return { ok: true };
    return this.client.sendMessage(msg.targetId, items, contextToken);
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  // ── Login UI flow ────────────────────────────────────────────────────────

  /**
   * 扫码登录入口（由 init.ts 调用）。
   * init.ts 已经调用过 fetchQrCode() + createQrDataUrl() 把 PNG 推到 renderer，
   * 这里只负责等扫码结果。
   *
   * @param qrcode  原始 qrcode 字符串（由 init.ts 传入）
   */
  async login(qrcode: string): Promise<Credentials> {
    console.log(LOG_PREFIX, "Waiting for QR scan...");

    while (true) {
      let status: Awaited<ReturnType<typeof pollQrStatus>>;
      try {
        status = await pollQrStatus(qrcode);
      } catch (err) {
        // timeout 是正常的 long-poll，继续
        if ((err as Error).name === "AbortError") throw new Error("login aborted");
        continue;
      }
      console.log(LOG_PREFIX, "QR status:", status.status);
      if (status.status === "confirmed") {
        if (!status.bot_token || !status.ilink_bot_id) {
          throw new Error("confirmed but missing bot_token or ilink_bot_id");
        }
        const creds: Credentials = {
          botToken: status.bot_token,
          ilinkBotId: status.ilink_bot_id,
          baseUrl: status.baseurl ?? "https://ilinkai.weixin.qq.com",
          ilinkUserId: status.ilink_user_id ?? "",
        };
        await saveCredentials(creds);
        return creds;
      }
      if (status.status === "expired") {
        throw new Error("二维码已过期，请重新扫码");
      }
      // pending/scanning — 继续轮询
    }
  }

  /** 注销（删除凭证文件） */
  async logout(): Promise<void> {
    await this.stop();
    await deleteCredentials();
    this.currentCredentials = null;
    this.isLoggedIn = false;
    this.status = { enabled: false, phase: "offline", message: "已登出" };
  }

  // ── Internal: poll loop ──────────────────────────────────────────────────

  async #pollLoop(): Promise<void> {
    if (!this.client || !this.pollAbort) return;
    let buf = "";
    let sessionExpired = false;

    while (!this.pollAbort.signal.aborted && !sessionExpired) {
      try {
        const { messages, buf: newBuf } = await this.client.getUpdates(buf);
        buf = newBuf;
        for (const msg of messages) {
          this.#dispatchInbound(msg);
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          console.warn(LOG_PREFIX, "Session expired — please re-login");
          sessionExpired = true;
          this.status = {
            enabled: true,
            phase: "error",
            message: "会话已过期，请重新扫码登录",
          };
          break;
        }
        if (this.pollAbort?.signal.aborted) break;
        // 网络抖一下 backoff
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  #dispatchInbound(msg: WeixinMessage): void {
    if (!this.onMessage) {
      console.warn(LOG_PREFIX, "onMessage 未注入，跳过消息");
      return;
    }
    console.log(LOG_PREFIX, `inbound from=${msg.fromUserId} text=${(msg.content ?? "").slice(0, 80)}`);
    this.replyContextByTarget.set(msg.fromUserId, msg.contextToken);

    const incoming: IncomingMessage = {
      channel: "wechat",
      senderId: msg.fromUserId,
      chatId: msg.fromUserId,
      text: msg.content ?? "",
      at: new Date(),
      _raw: msg,
    };

    void this.onMessage(incoming).catch((err) => {
      console.error(LOG_PREFIX, "dispatcher error:", err);
    });
  }
}

function buildImageItem(media: CDNMedia): SendMessageItem {
  return {
    type: 2,
    image_item: { media },
  };
}

function buildFileItem(media: CDNMedia, fileName: string): SendMessageItem {
  return {
    type: 4,
    file_item: {
      file_name: fileName,
      media,
    },
  };
}

function buildVideoItem(media: CDNMedia): SendMessageItem {
  return {
    type: 5,
    video_item: {
      media,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Credentials storage
// ─────────────────────────────────────────────────────────────────────────────

function credPath(): string {
  return path.join(app.getPath("userData"), "weixin", "credentials.json");
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(credPath(), "utf8");
    const creds = JSON.parse(raw) as Credentials;
    if (!creds.botToken || !creds.ilinkBotId) return null;
    return creds;
  } catch {
    return null;
  }
}

async function saveCredentials(creds: Credentials): Promise<void> {
  const p = credPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(creds, null, 2), "utf8");
}

async function deleteCredentials(): Promise<void> {
  try {
    await fs.unlink(credPath());
  } catch {}
}
