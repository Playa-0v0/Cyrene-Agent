// 聊天会话相关的持久化数据形状（main / renderer 共用）。
//
// 设计要点：
// - ChatSession 是「完整体」，含 messages，存到 sessions/<id>.json；
// - ChatSessionMeta 是「索引项」，不含 messages，存到 index.json；
//   列表渲染只读 index.json，避免一次性把所有会话消息加载到内存。
// - identityId 当前为预留字段——职位面板还未做，新会话默认 null，
import type { MusicCardData } from "./music-card";
import type { TodoItem } from "./todo-types";
import type { TaskDelegationPresentation } from "./task-session";
import type { ContextUsageSnapshot } from "./context-usage";

// - schemaVersion 用于以后改 schema 时的迁移判断；当前固定 1。

export type ChatRole = "user" | "model";

export type ChatSessionPurpose = "proactive-chat";

/** 会话模式：创建时绑定，整个会话生命周期不变 */
export type ConversationMode = "chat" | "work" | "code" | "learn";

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

/** 一次模型回复中已展示的工具执行记录，供 React Harness 会话恢复执行过程。 */
export interface ToolExecutionRecord {
  id: string;
  name: string;
  status: "running" | "success" | "error";
  result?: string;
  argsText?: string;
  roundId?: string;
  /** 结构化文件变更证据（Diff Review 卡片）；由 tool_end 事件独立携带，不依赖被截断的 result 文本。 */
  changes?: ToolFileChange[];
}

/** Diff Review 卡片：单行展示（hunk=@@ 头，context=未变行）。 */
export type ToolDiffLineType = "context" | "add" | "remove" | "hunk";

export interface ToolDiffLine {
  type: ToolDiffLineType;
  text: string;
}

/** 写文件工具返回 JSON 中的结构化变更证据，前端渲染成"文件 +x/-y"审查卡片。 */
export interface ToolFileChange {
  /** 相对工作区路径（或工具给定的展示路径） */
  file: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
  /** 展示用红绿 diff 行；变更过大时省略并置 truncated */
  diff?: ToolDiffLine[];
  truncated?: boolean;
}

/** 一次 assistant run 的可恢复展示指标。 */
export interface RunActivityRecord {
  /** Renderer 收到 RUN_STARTED 时的时间戳。 */
  startedAt: number;
  /** RUN_FINISHED 或终态错误到达后写入；缺失表示仍在处理。 */
  completedAt?: number;
  /** 已完成 reasoning 段的累计时长，不包含工具执行等待。 */
  reasoningMs: number;
  /** 当前仍在流式输出的 reasoning 段起点；终态时必须清除。 */
  activeReasoningStartedAt?: number;
  /** 取消、超时或失败时保持过程面板展开，避免隐藏唯一可见的执行证据。 */
  keepExpanded?: boolean;
}

export interface ProcessMessageRecord {
  id: string;
  content: string;
  /** 该过程消息出现前已完成的工具数，用于恢复大致执行顺序。 */
  afterToolCount?: number;
  roundId?: string;
}

export interface ReasoningBlock {
  id: string;
  content: string;
  streaming?: boolean;
  /** 已完成的工具数，用于恢复 Think 与工具链的真实顺序。 */
  afterToolCount?: number;
  roundId?: string;
}

export interface AgentRoundRecord {
  id: string;
  status: "running" | "completed";
  startedAt: number;
  completedAt?: number;
}

export interface TaskDelegationDisplayRecord extends TaskDelegationPresentation {
  roundId?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** 模型公开返回的推理过程；不包含隐藏或加密思考。 */
  reasoning?: string;
  reasoningBlocks?: ReasoningBlock[];
  /** 工具轮次中模型给用户的过程说明；不属于正式回答，也不冒充 reasoning。 */
  processMessages?: ProcessMessageRecord[];
  /** Harness 模型调用回合；用于把公开文本、reasoning 与工具执行折叠为一个单元。 */
  agentRounds?: AgentRoundRecord[];
  /** 父流程中的趣味子任务委托行；不包含子任务私有上下文。 */
  taskDelegations?: TaskDelegationDisplayRecord[];
  at: number;
  /** 不直接显示在聊天气泡里，但会拼入模型上下文。 */
  modelContext?: string;
  attachments?: MessageAttachment[];
  /** 表情包 ID（内置或用户自定义） */
  sticker?: string | null;
  /** 工具调用过程；与模型推理 reasoning 分开保存和展示。 */
  toolExecutions?: ToolExecutionRecord[];
  /** 本轮处理与公开推理的展示指标。 */
  runActivity?: RunActivityRecord;
  /** 活跃 Agent run 的可恢复检查点；非终态快照在重启后只能恢复为 interrupted。 */
  runSnapshot?: {
    runId?: string;
    status: "running" | "waiting_user" | "interrupted" | "terminal";
    terminalStatus?: "success" | "cancelled" | "timeout" | "runtime_error";
    todos?: TodoItem[];
    updatedAt: number;
  };
  /** TTS 缓存 key。只存 key，不存绝对路径，避免 userData 路径变化后 session JSON 失效。 */
  ttsCacheKey?: string;
  /** 生成缓存时使用的朗读文本转换器版本；版本变化时旧缓存自然失效。 */
  ttsCacheVersion?: string;
  /** 已实际展示的音乐候选卡片；持久化展示不延长 Skill 候选状态 TTL。 */
  musicCard?: MusicCardData;
  /** 上下文容量快照（run 终态落盘）；运行中被每轮 preRequest 快照实时覆盖（纯内存）。 */
  contextUsage?: ContextUsageSnapshot;
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

/** 对话工作区绑定：将一个可信目录绑定到对话 */
export interface ConversationWorkspaceBinding {
  /** 规范化后的绝对路径（realpath + Windows 标准化） */
  workspaceRoot: string;
  /** 用户可见的显示名（通常是文件夹名或缩短路径） */
  displayName: string;
  /** 绑定时间戳 */
  boundAt: number;
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
  /** 对话工作区绑定（Coding Agent 使用的可信目录） */
  workspaceBinding?: ConversationWorkspaceBinding;
  /** 会话模式：创建时绑定，整个会话生命周期不变。旧会话无此字段时默认 "work"。 */
  mode?: ConversationMode;
  /** 用户是否置顶该会话；置顶项在列表中优先展示。 */
  pinned?: boolean;
  /** 当前会话选择的已保存模型；缺失时使用默认模型。 */
  modelProfileId?: string;
  /**
   * 会话级最新上下文容量快照：上下文环形图的唯一读取点（消息级 contextUsage 仅作历史兜底）。
   * 手动压缩等「不产生新 assistant 消息但改变上下文构成」的操作写这里，
   * 避免 UI 显示过期数据（known-issues 问题 3）。
   */
  currentContextUsage?: ContextUsageSnapshot;
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
  mode: ConversationMode;
  /** 列表分组所需的轻量工作区信息，避免为每一项读取完整 session 文件。 */
  workspaceRoot?: string;
  workspaceDisplayName?: string;
  /** 用户是否置顶该会话；与 ChatSession.pinned 同步。 */
  pinned?: boolean;
}

export const CHAT_SCHEMA_VERSION = 1 as const;

// 默认 identity 显示名（职位面板未做，所有会话先用这个）。
