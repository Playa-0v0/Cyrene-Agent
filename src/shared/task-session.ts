/** 私有子任务会话的跨进程可序列化契约。 */

export type TaskSessionStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type TaskSubagentType = "general" | "document" | "search";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

/**
 * 保留 Harness 协议消息所需的可序列化字段，但不把 Main 的 vendor 类型反向引入 shared。
 */
export interface TaskTranscriptMessage {
  role: string;
  content: string;
  toolCalls?: unknown[];
  toolCallId?: string;
  name?: string;
  [key: string]: unknown;
}

export interface TaskTraceRecord {
  id: string;
  at: number;
  kind: "round" | "progress" | "reasoning" | "tool" | "todo" | "terminal";
  phase?: "start" | "delta" | "end";
  label?: string;
  content?: string;
  status?: string;
}

export interface TaskSession {
  schemaVersion: 1;
  id: string;
  parentConversationId: string;
  parentRunId: string;
  childRunId: string;
  description: string;
  subagentType: TaskSubagentType;
  mode: "work" | "code";
  resolvedWorkspaceRoot?: string;
  status: TaskSessionStatus;
  messages: TaskTranscriptMessage[];
  trace: TaskTraceRecord[];
  todoItems: TodoItem[];
  resultText?: string;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** 存在于父助手消息中的最小公开记录；不包含子任务提示词或轨迹。 */
export interface TaskDelegationRecord {
  taskId: string;
  description: string;
  subagentType: TaskSubagentType;
  status: TaskSessionStatus;
  delegatedAt: number;
  updatedAt: number;
}

export type TaskDelegationPresentationStatus = "running" | "completed" | "failed" | "cancelled";

/** 父流程可见的最小委托信息，不包含子任务 prompt 或私有轨迹。 */
export interface TaskDelegationPresentation {
  invocationId: string;
  taskId: string;
  description: string;
  nickname: string;
  assetFileName: string;
  status: TaskDelegationPresentationStatus;
}
