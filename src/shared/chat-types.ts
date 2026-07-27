// 聊天會話相關的持久化數據形狀（main / renderer 共用）。
//
// 設計要點：
// - ChatSession 是「完整體」，含 messages，存到 sessions/<id>.json；
// - ChatSessionMeta 是「索引項」，不含 messages，存到 index.json；
//   列表渲染只讀 index.json，避免一次性把所有會話消息加載到內存。
// - identityId 當前為預留字段——職位面板還未做，新會話默認 null，
//   顯示側 fallback 到 "聊天陪伴"。後續職位面板做好後接入。
// - schemaVersion 用於以後改 schema 時的遷移判斷；當前固定 1。

export type ChatRole = "user" | "model";

export type ChatStickerId =
  | "playful"
  | "love-happy"
  | "confident"
  | "serious"
  | "calm"
  | "peek"
  | "clingy-confused"
  | "love-calm";

/** 任意表情包 ID（內置 + 用戶自定義） */
export type AnyStickerId = string;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  at: number;
  /** 表情包 ID（內置或用戶自定義） */
  sticker?: string | null;
  /** TTS 緩存 key。只存 key，不存絕對路徑，避免 userData 路徑變化後 session JSON 失效。 */
  ttsCacheKey?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  identityId: string | null;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  schemaVersion: 1;
  // 用戶是否手動改過名；true 時不再根據消息內容自動派生 title。
  // 沒有此字段的老數據視為 false（向後兼容）。
  titleIsCustom?: boolean;
}

// index.json 裡的輕量元數據（列表渲染用）。
export interface ChatSessionMeta {
  id: string;
  title: string;
  identityId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export const CHAT_SCHEMA_VERSION = 1 as const;

// 默認 identity 顯示名（職位面板未做，所有會話先用這個）。
export const DEFAULT_IDENTITY_LABEL = "聊天陪伴";
