// iLink Protocol Client —— 直接打微信 iLink Bot API 的 HTTP 協議客戶端。
// 零依賴（只用 Node 22 內置 fetch + crypto.randomUUID），不走任何 ESM SDK。
//
// 參考實現：
//   - weclaw (Go): github.com/fastclaw-ai/weclaw
//   - 協議文檔:    https://www.wechatbot.dev/zh/protocol
//
// Base URL: https://ilinkai.weixin.qq.com + /ilink/bot/...
// weclaw (Go): github.com/fastclaw-ai/weclaw
// 協議文檔:    https://www.wechatbot.dev/zh/protocol
import { randomUUID } from "node:crypto";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const LONG_POLL_TIMEOUT_MS = 35_000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ItemType = 1 | 2 | 3 | 4 | 5;  // text|image|voice|file|video
export type MessageType = 1;               // 摘要只描述了 user→bot 類型

export interface Credentials {
  botToken: string;
  ilinkBotId: string;
  baseUrl: string;            // 一般就是 BASE_URL
  ilinkUserId: string;
  /** 顯示用的賬號 id（用 ilinkBotId @ 之前的一段，或完整） */
  accountId?: string;
}

/** 入站消息（已展開成單一形狀） */
export interface WeixinMessage {
  msgId: string;
  fromUserId: string;
  toUserId: string;
  msgType: number;            // 1=user, 2=bot echo
  content: string;            // 從 item_list[].text_item.text 提取
  contextToken: string;       // ⚠️ 回覆時原樣帶回
  createTimeMs?: number;
  raw: unknown;
}

/** iLink item 形狀（與 SDK WireMessageItem 一致） */
export interface WeixinItem {
  type: ItemType;             // 1=text 2=image 3=voice 4=file 5=video
  text_item?: { text: string };
  image_item?: any;
  voice_item?: any;
  file_item?: any;
  video_item?: any;
}

/** iLink 原始 WireMessage 形狀（snake_case） */
export interface WireMessage {
  message_id?: number;
  from_user_id: string;
  to_user_id: string;
  message_type: number;
  message_state?: number;
  context_token: string;
  create_time_ms?: number;
  item_list: WeixinItem[];
  [k: string]: unknown;
}

/** getupdates 響應（iLink 真實字段名：snake_case + msgs） */
interface GetUpdatesResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WireMessage[];                // ← 真實字段是 msgs，不是 messages
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface SendMessageItem {
  type: ItemType;
  text_item?: { text: string };
  image_item?: any;
  voice_item?: any;
  file_item?: any;
  video_item?: any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

export interface ILinkClientOptions {
  /** 注入的隨機 wechat-uin 生成器（測試時可固定） */
  wechatUin?: string;
}

export class ILinkClient {
  private baseUrl: string;
  private botToken: string;
  private botId: string;
  private wechatUin: string;

  constructor(creds: Credentials, opts: ILinkClientOptions = {}) {
    this.baseUrl = creds.baseUrl || BASE_URL;
    this.botToken = creds.botToken;
    this.botId = creds.ilinkBotId;
    this.wechatUin = opts.wechatUin ?? randomWechatUin();
  }

  botUserId(): string {
    return this.botId;
  }

  // ── Long poll loop ────────────────────────────────────────────────────────

  /**
   * Long-poll for new messages.
   * 後端最長掛 35 秒；如果返回就立刻拿新 get_updates_buf 再次請求。
   * 收到會話過期（ret=-14）拋 SessionExpired。
   */
  async getUpdates(buf = ""): Promise<{ messages: WeixinMessage[]; buf: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LONG_POLL_TIMEOUT_MS + 5_000);

    try {
      const resp = await this.doJson<unknown>("POST", "/ilink/bot/getupdates", {
        get_updates_buf: buf,
        base_info: { channel_version: "2.0.0" },
      }, { signal: ctrl.signal });

      const data = resp as GetUpdatesResponse;
      if (data.ret === -14) {
        throw new SessionExpiredError("iLink session expired (ret=-14)");
      }
      // 注意：成功響應裡通常沒有 ret 字段（只有 msgs/sync_buf/get_updates_buf），
      // 所以 "ret !== 0" 會因為 undefined !== 0 誤判為錯誤。這裡只對顯式非 0 才報錯。
      if (data.ret !== undefined && data.ret !== 0) {
        throw new Error(`iLink getupdates failed: ret=${data.ret} ${data.errmsg ?? ""}`);
      }

      // 跳過 bot 自己發出去的消息（message_type=2）
      const wires = (data.msgs ?? []).filter((m) => m.message_type === 1);
      return {
        messages: wires.map((m) => this.#wireToMessage(m)),
        buf: data.get_updates_buf ?? "",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 把 iLink WireMessage（snake_case + item_list）轉成我們用的 WeixinMessage */
  #wireToMessage(w: WireMessage): WeixinMessage {
    // 提取文本：遍歷 item_list 找 text_item.text
    const text = (w.item_list ?? [])
      .filter((it) => it.type === 1 && it.text_item?.text)
      .map((it) => it.text_item!.text)
      .join("");
    return {
      msgId: String(w.message_id ?? ""),
      fromUserId: w.from_user_id,
      toUserId: w.to_user_id,
      msgType: w.message_type,
      content: text,
      contextToken: w.context_token,
      createTimeMs: w.create_time_ms,
      raw: w,
    };
  }

  // ── Send ────────────────────────────────────────────────────────────────

  /** 發文本消息（最常用） */
  async sendText(toUserId: string, text: string, contextToken: string): Promise<{ ok: boolean; error?: string }> {
    return this.sendMessage(toUserId, [{ type: 1, text_item: { text } }], contextToken);
  }

  /**
   * 通用 sendmessage。
   * @param toUserId 收信人 user id（從入站消息的 from_user_id 拿）
   * @param itemList 包含 1 個或多個 item（text/image/voice/file/video）
   * @param contextToken 從入站消息原樣帶回
   */
  async sendMessage(
    toUserId: string,
    itemList: SendMessageItem[],
    contextToken: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      // iLink 真實協議（與 corespeed-io/wechatbot SDK 完全一致）：
      //   - from_user_id: "" 空字符串（出站消息不攜帶 from，服務端用 token 鑑權）
      //   - client_id: 隨機 UUID（消息唯一 ID，服務端用來去重/排序）
      //   - to_user_id: 真實接收者
      //   - message_type: 2=bot
      //   - message_state: 2=finish
      //   - item_list: [{ type: 1, text_item: { text } }]
      const resp = await this.doJson<unknown>("POST", "/ilink/bot/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: itemList,
        },
        base_info: { channel_version: "2.0.0" },
      });
      const data = resp as { ret?: number; errmsg?: string };
      if (data.ret === -14) throw new SessionExpiredError("session expired on send");
      if (data.ret !== 0 && data.ret !== undefined) {
        return { ok: false, error: data.errmsg ?? `ret=${data.ret}` };
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      return { ok: false, error: String(err) };
    }
  }

  // ── Typing ──────────────────────────────────────────────────────────────

  /** 拉 typing_ticket（per-user） */
  async getConfig(userId: string, contextToken: string): Promise<{ typingTicket?: string }> {
    try {
      const resp = await this.doJson<unknown>("POST", "/ilink/bot/getconfig", {
        ilink_user_id: userId,
        context_token: contextToken,
      });
      const data = resp as { ret?: number; typing_ticket?: string; errmsg?: string };
      if (data.ret === 0) {
        return { typingTicket: data.typing_ticket };
      }
      return {};
    } catch {
      return {};
    }
  }

  /** 發送"正在輸入" */
  async sendTyping(userId: string, typingTicket: string, status: 1 | 2 = 1): Promise<void> {
      await this.doJson<unknown>("POST", "/ilink/bot/sendtyping", {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
    });
  }

  // ── Low level ───────────────────────────────────────────────────────────

  private async doJson<T>(method: string, path: string, body: unknown, init?: RequestInit): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: this.headers(),
      body: JSON.stringify(body),
      ...init,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${method} ${path}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Non-JSON response from ${method} ${path}: ${text.slice(0, 200)}`);
    }
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "Authorization": `Bearer ${this.botToken}`,
      "X-WECHAT-UIN": this.wechatUin,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Login flow (anonymous client)
// ─────────────────────────────────────────────────────────────────────────────

export interface QrCodeResp {
  qrcode: string;
  qrcode_img_content: string;   // base64 PNG
}

export interface QrStatusResp {
  status: "init" | "scanned" | "confirmed" | "expired" | string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

/** 拿登錄二維碼 */
export async function fetchQrCode(): Promise<QrCodeResp> {
  const uin = randomWechatUin();
  const url = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetch(url, { headers: { "X-WECHAT-UIN": uin } });
  const text = await res.text();
  if (!res.ok) throw new Error(`qrcode fetch failed: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as QrCodeResp;
}

/** 輪詢掃碼狀態（long-poll 40s） */
export async function pollQrStatus(qrcode: string, signal?: AbortSignal): Promise<QrStatusResp> {
  const uin = randomWechatUin();
  const url = `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await fetch(url, {
    headers: { "X-WECHAT-UIN": uin },
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`qrcode status failed: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as QrStatusResp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export class SessionExpiredError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SessionExpiredError";
  }
}

function randomWechatUin(): string {
  // weclaw 實現：隨 uint32 → 字符串 → base64
  const n = (Math.random() * 0xffffffff) >>> 0;
  const s = String(n);
  return Buffer.from(s, "utf8").toString("base64");
}
