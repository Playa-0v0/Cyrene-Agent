// ILink Bot Adapter —— 用 iLinkProtocolClient 包出 ChannelAdapter。
//
// 流程：
//   微信用戶發消息
//     └─ ILinkClient.getUpdates() (long-poll 35s)
//           └─ adapter.onMessage() → dispatcher → buildAndRunAgent → OutgoingMessage
//                 └─ ILinkClient.sendText() → POST /sendmessage → 微信
//
// 憑據存盤：<userData>/weixin/<botId>.json
// （首次運行需在 UI 點"掃碼登錄"生成；之後自動續用）
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
  ILinkClient,
  pollQrStatus,
  SessionExpiredError,
  type Credentials,
  type WeixinMessage,
} from "./ilink-protocol-client";
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
  audio: false,    // iLink 支持 voice_item，先不上傳，等用到再加
  file: false,
  video: false,
  markdown: false,
  card: false,
  sticker: false,
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
  /** 賬號是否已登錄（憑證存在） */
  isLoggedIn = false;
  /** 當前 credentials（動態加載） */
  currentCredentials: Credentials | null = null;

  status: ChannelStatus = { enabled: false, phase: "offline" };

  // ── ChannelAdapter ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.status = { enabled: true, phase: "starting" };
    console.log(LOG_PREFIX, "Starting...");

    // 1. 加載已存憑證
    const creds = await loadCredentials();
    if (!creds) {
      this.status = {
        enabled: true,
        phase: "config_missing",
        message: "未登錄，請先掃碼",
      };
      console.log(LOG_PREFIX, "No credentials, please run /wechat login");
      return;
    }

    this.currentCredentials = creds;
    this.client = new ILinkClient(creds);
    this.isLoggedIn = true;

    // 2. 啟動 long-poll 循環
    this.pollAbort = new AbortController();
    this.pollLoopPromise = this.#pollLoop();

    this.status = { enabled: true, phase: "running", message: "微信已連接" };
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
    // adapter.send() 由 dispatcher 通過 manager 的鏡像路徑調用；不走主回覆鏈。
    // 主回覆在 #dispatchInbound() 內 await onMessage → 直接拿 contextToken 發。
    return { ok: false, error: "請使用 adapter 主回覆鏈 (dispatchInbound→onMessage→client.sendText)" };
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  // ── Login UI flow ────────────────────────────────────────────────────────

  /**
   * 掃碼登錄入口（由 init.ts 調用）。
   * init.ts 已經調用過 fetchQrCode() + createQrDataUrl() 把 PNG 推到 renderer，
   * 這裡只負責等掃碼結果。
   *
   * @param qrcode  原始 qrcode 字符串（由 init.ts 傳入）
   */
  async login(qrcode: string): Promise<Credentials> {
    console.log(LOG_PREFIX, "Waiting for QR scan...");

    while (true) {
      let status: Awaited<ReturnType<typeof pollQrStatus>>;
      try {
        status = await pollQrStatus(qrcode);
      } catch (err) {
        // timeout 是正常的 long-poll，繼續
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
        throw new Error("二維碼已過期，請重新掃碼");
      }
      // pending/scanning — 繼續輪詢
    }
  }

  /** 註銷（刪除憑證文件） */
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
            message: "會話已過期，請重新掃碼登錄",
          };
          break;
        }
        if (this.pollAbort?.signal.aborted) break;
        // 網絡抖一下 backoff
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  #dispatchInbound(msg: WeixinMessage): void {
    if (!this.onMessage) {
      console.warn(LOG_PREFIX, "onMessage 未注入，跳過消息");
      return;
    }
    console.log(LOG_PREFIX, `inbound from=${msg.fromUserId} text=${(msg.content ?? "").slice(0, 80)}`);

    const incoming: IncomingMessage = {
      channel: "wechat",
      senderId: msg.fromUserId,
      chatId: msg.fromUserId,
      text: msg.content ?? "",
      at: new Date(),
      _raw: msg,
    };

    // 主回覆鏈：await onMessage 拿到 OutgoingMessage，直接用 contextToken 調 sendText
    void this.onMessage(incoming).then(async (outgoing) => {
      if (!outgoing || !this.client) return;
      const text = outgoing.parts
        .filter((p) => p.kind === "text")
        .map((p) => p.text)
        .join("")
        .trim();
      if (!text) return;
      try {
        const result = await this.client.sendText(msg.fromUserId, text, msg.contextToken);
        if (!result.ok) {
          console.error(LOG_PREFIX, "sendText failed:", result.error);
        }
      } catch (err) {
        console.error(LOG_PREFIX, "sendText error:", err);
      }
    }).catch((err) => {
      console.error(LOG_PREFIX, "dispatcher error:", err);
    });
  }
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
