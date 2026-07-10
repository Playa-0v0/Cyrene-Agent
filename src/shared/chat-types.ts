// 聊天会话相关的持久化数据形状（main / renderer 共用）。
//
// 设计要点：
// - ChatSession 是「完整体」，含 messages，存到 sessions/<id>.json；
// - ChatSessionMeta 是「索引项」，不含 messages，存到 index.json；
//   列表渲染只读 index.json，避免一次性把所有会话消息加载到内存。
// - identityId 当前为预留字段——职位面板还未做，新会话默认 null，
//   显示侧 fallback 到 "聊天陪伴"。后续职位面板做好后接入。
// - schemaVersion 用于以后改 schema 时的迁移判断；当前固定 1。

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

/** 任意表情包 ID（内置 + 用户自定义） */
export type AnyStickerId = string;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  at: number;
  /** 不直接显示在聊天气泡里，但会拼入模型上下文。 */
  modelContext?: string;
  attachments?: MessageAttachment[];
  /** 表情包 ID（内置或用户自定义） */
  sticker?: string | null;
  /** TTS 缓存 key。只存 key，不存绝对路径，避免 userData 路径变化后 session JSON 失效。 */
  ttsCacheKey?: string;
}

export type MessageAttachment = ImageMessageAttachment | DocumentMessageAttachment;

export interface ImageMessageAttachment {
  kind: "image";
  name: string;
  filePath: string;
  mime: string;
  previewUrl?: string;
  caption?: string;
  status: "pending" | "done" | "error";
}

export interface DocumentMessageAttachment {
  kind: "document";
  name: string;
  filePath: string;
  status: "pending" | "done" | "error";
  processedKind?: "text" | "indexed" | "empty" | "unsupported";
  chunks?: number;
  reason?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  identityId: string | null;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  schemaVersion: 1;
  // 用户是否手动改过名；true 时不再根据消息内容自动派生 title。
  // 没有此字段的老数据视为 false（向后兼容）。
  titleIsCustom?: boolean;
}

// index.json 里的轻量元数据（列表渲染用）。
export interface ChatSessionMeta {
  id: string;
  title: string;
  identityId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export const CHAT_SCHEMA_VERSION = 1 as const;

// 默认 identity 显示名（职位面板未做，所有会话先用这个）。
export const DEFAULT_IDENTITY_LABEL = "聊天陪伴";
