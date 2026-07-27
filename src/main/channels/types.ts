// channels 模塊的統一數據類型。
//
// 設計原則：所有外部入口（微信/飛書/Discord/...）都必須先把消息歸一化成
// IncomingMessage / OutgoingMessage 兩種格式再交給 dispatcher。
// 這樣 dispatcher 完全不知道任何具體平臺 —— 加新渠道零改動 dispatcher。
//
// 命名規範：所有字段小駝峰、可空字段加 ?；時間戳統一 Date。
import type { WebContents } from "electron";

/** 渠道 id 聯合類型。新增渠道時在此擴展。 */
export type ChannelId = "wechat" | "feishu" | "discord";

/** 渠道能力聲明。Dispatcher 按 cap 做降級。 */
export interface ChannelCapability {
  /** 純文本消息 */
  text: boolean;
  /** 圖片消息 */
  image: boolean;
  /** TTS 音頻消息 */
  audio: boolean;
  /** 文件附件 */
  file: boolean;
  /** 視頻消息 */
  video: boolean;
  /** Markdown 富文本（部分渠道支持） */
  markdown: boolean;
  /** 富卡片（飛書 interactive / Discord embed） */
  card: boolean;
  /** 自定義表情包 */
  sticker: boolean;
  /** 單條文本最大長度。超出按 cap 截斷 + 提示。 */
  maxTextLength: number;
}

/** 入站附件。adapters 負責下載到本地後填 filePath。 */
export interface ChannelAttachment {
  kind: "image" | "audio" | "file" | "video";
  /** 遠程 URL（adapter 已下載到本地時為空） */
  url?: string;
  /** 本地路徑（adapter 已下載時填這個） */
  filePath?: string;
  mime?: string;
  caption?: string;
}

/** 入站消息。adapters → dispatcher。 */
export interface IncomingMessage {
  channel: ChannelId;
  /** 平臺原始 sender id。dispatcher 會 sha256 截斷成 16 字符作為 sessionId。 */
  senderId: string;
  /** 顯示名（暱稱/open_id alias），用於日誌/UI。 */
  senderName?: string;
  /** 會話 id。私聊時通常 = senderId。 */
  chatId: string;
  /** 群聊/話題 id。私聊時 undefined。 */
  threadId?: string;
  text: string;
  attachments?: ChannelAttachment[];
  at: Date;
  /** 原始 payload，調試用，不序列化。 */
  _raw?: unknown;
}

/** 出站消息的單個片段。多模態按 parts 數組，capability 降級在 dispatcher 做。 */
export type OutgoingPart =
  | { kind: "text"; text: string }
  | { kind: "image"; url?: string; filePath?: string; caption?: string }
  | { kind: "audio"; filePath: string; mime: string }
  | {
      kind: "card";
      title: string;
      markdown?: string;
      fields?: Array<{ key: string; value: string }>;
    }
  | { kind: "sticker"; stickerId: string; imagePath: string };

/** 出站消息。dispatcher → adapters。 */
export interface OutgoingMessage {
  channel: ChannelId;
  /** 回覆給誰（私聊 = senderId；群聊 = chatId） */
  targetId: string;
  threadId?: string;
  parts: OutgoingPart[];
}

/** 渠道狀態（UI 展示用） */
export interface ChannelStatus {
  enabled: boolean;
  /** "running" / "offline" / "starting" / "config_missing" / "error" */
  phase: "running" | "offline" | "starting" | "config_missing" | "error";
  message?: string;
  /** 渠道專屬的額外狀態字段（如微信賬號暱稱、飛書 token 是否過期） */
  detail?: Record<string, unknown>;
}

/** ChannelAdapter 內部 onMessage handler 的簽名。
 *  返回 null 表示該消息被忽略（權限/限速/不在 allow list），adapter 不會再回信。 */
export type MessageHandler = (
  msg: IncomingMessage,
) => Promise<OutgoingMessage | null>;

/** inbound-server 拿到入站請求後轉交給 manager 路由時的回調簽名 */
export interface InboundRouteContext {
  /** 用於推送 AG-UI 事件到桌面端 chatWindow（可選）。 */
  chatWindow?: WebContents | null;
  /** 用於把出站消息廣播回桌面端鏡像顯示（可選）。 */
  broadcastChat?: (event: { type: "bot:message"; payload: unknown }) => void;
}
