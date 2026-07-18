// 聊天会话相关的持久化数据形状（main / renderer 共用）。
//
// 设计要点：
// - ChatSession 是「完整体」，含 messages，存到 sessions/<id>.json；
// - ChatSessionMeta 是「索引项」，不含 messages，存到 index.json；
//   列表渲染只读 index.json，避免一次性把所有会话消息加载到内存。
// - identityId 当前为预留字段——职位面板还未做，新会话默认 null，
//   显示侧 fallback 到 "聊天陪伴"。后续职位面板做好后接入。
import type { MusicCardData } from "./music-card";

// - schemaVersion 用于以后改 schema 时的迁移判断；当前固定 1。

export type ChatRole = "user" | "model";

export type ChatSessionPurpose = "proactive-chat";

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
  /** 已实际展示的音乐候选卡片；持久化展示不延长 Skill 候选状态 TTL。 */
  musicCard?: MusicCardData;
  /** 本轮模型回复前的工具调用记录（用于调试复盘）。 */
  toolCalls?: RecordedToolCall[];
  /** 本轮 LLM 请求/响应原始记录（用于调试复盘）。 */
  llmRequests?: RecordedLlmRequest[];
}

/** 单次工具调用的持久化记录。 */
export interface RecordedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  output: string;
  /** 工具输出的截断字节数（0 = 未截断）。 */
  outputTruncated: number;
}

/** 单次 LLM 请求/响应的持久化记录。 */
export interface RecordedLlmRequest {
  phase: string;
  /** 请求体（不含 apiKey 等敏感字段）。 */
  request: {
    model: string;
    messageCount: number;
    toolCount: number;
    /** 请求的 system prompt 前 500 字符。 */
    systemPreview: string;
  };
  /** 响应摘要。 */
  response: {
    finishReason: string;
    toolCallCount: number;
    /** 响应文本前 500 字符。 */
    textPreview: string;
  };
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
  /** 系统用途会话的稳定标识；普通用户会话不设置。 */
  purpose?: ChatSessionPurpose;
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
  purpose?: ChatSessionPurpose;
}

export const CHAT_SCHEMA_VERSION = 1 as const;

// 默认 identity 显示名（职位面板未做，所有会话先用这个）。
export const DEFAULT_IDENTITY_LABEL = "聊天陪伴";
