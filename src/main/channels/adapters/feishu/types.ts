// 飛書事件訂閱的原始 payload 與回包類型。
// 參考飛書官方文檔：
//   - 事件訂閱概述：https://open.feishu.cn/document/server-docs/event-subscription-guide/overview
//   - 接收消息 v1：https://open.feishu.cn/document/server-docs/im-v1/message-events/receive
//
// 字段命名嚴格按 snake_case，因為它們來自飛書服務器，不能改。

/** 飛書事件訂閱的頂層 envelope。可能是加密（encrypt）或明文。 */
export interface FeishuEventEnvelope {
  /** "url_verification" | "event_callback" | "challenge" (舊版) */
  type?: string;
  /** challenge 校驗時回包用 */
  challenge?: string;
  /** 加密字段。存在時需要用 Encrypt Key 解密 */
  encrypt?: string;
  /** 明文 payload（未加密時存在） */
  header?: FeishuEventHeader;
  event?: unknown;
}

/** 事件頭（v2 新協議） */
export interface FeishuEventHeader {
  event_id?: string;
  event_type?: string;
  app_id?: string;
  tenant_key?: string;
  create_time?: string;
  token?: string;
}

/** 解密後的明文 envelope（v2） */
export interface FeishuDecryptedEnvelope {
  schema?: string;
  header?: FeishuEventHeader;
  event?: FeishuImMessageEvent | Record<string, unknown>;
}

/** im.message.receive_v1 事件內容 */
export interface FeishuImMessageEvent {
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
    tenant_key?: string;
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    chat_id?: string;
    chat_type?: "p2p" | "group" | "channel" | string;
    message_type?: "text" | "image" | "file" | "audio" | "video" | "post" | "interactive" | string;
    content?: string; // JSON 字符串（飛書把文本/富文本都塞這裡）
    mentions?: Array<{ key: string; id: { open_id?: string; user_id?: string } }>;
  };
  timestamp?: string;
}

/** 解密後的文本消息 content（message_type === "text"） */
export interface FeishuTextContent {
  text?: string;
}

/** 解密後的圖片消息 content（message_type === "image"） */
export interface FeishuImageContent {
  image_key?: string;
}

/** 解密後的文件消息 content */
export interface FeishuFileContent {
  file_key?: string;
  file_name?: string;
}

/** 解密後的語音消息 content（message_type === "audio"） */
export interface FeishuAudioContent {
  file_key?: string;
  duration?: number;
}

/** tenant_access_token 響應 */
export interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number; // 秒
}

/** 發送消息響應 */
export interface FeishuSendMessageResponse {
  code: number;
  msg: string;
  data?: {
    message_id?: string;
    chat_id?: string;
    create_time?: string;
  };
}

/** 飛書 IM v1 消息內容聯合類型（發消息用） */
export type FeishuOutboundContent =
  | { text: string }
  | { image_key: string }
  | { file_key: string; file_name?: string }
  | { file_key: string; duration?: number }
  | FeishuInteractiveCard;

export interface FeishuInteractiveCard {
  /** 飛書 interactive 卡片 schema，通常是 2.0 */
  schema?: string;
  header?: { title?: { tag?: string; content?: string }; template?: string };
  elements?: unknown[];
}