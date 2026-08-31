import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ChatMessage, ConversationMode } from "../../../../../shared/chat-types";
import type { ComposerInteraction } from "../components/run-presentation";
import type { TodoItem } from "../../../../../shared/todo-types";

export interface SessionInteractionEntry {
  interaction: ComposerInteraction;
  busy: boolean;
}

export type SessionInteractionState = Record<string, SessionInteractionEntry>;

export function bindWorkspaceName(
  state: Partial<Record<ConversationMode, string>>,
  mode: ConversationMode,
  displayName: string | undefined,
): Partial<Record<ConversationMode, string>> {
  return { ...state, [mode]: displayName };
}

export function sessionInteraction(
  state: SessionInteractionState,
  sessionId: string | undefined,
): SessionInteractionEntry | undefined {
  return sessionId ? state[sessionId] : undefined;
}

export function setSessionInteraction(
  state: SessionInteractionState,
  sessionId: string,
  interaction: ComposerInteraction,
  busy = false,
): SessionInteractionState {
  return { ...state, [sessionId]: { interaction, busy } };
}

export function clearSessionInteraction(
  state: SessionInteractionState,
  sessionId: string,
): SessionInteractionState {
  if (!state[sessionId]) return state;
  const next = { ...state };
  delete next[sessionId];
  return next;
}

export function setSessionInteractionBusy(
  state: SessionInteractionState,
  sessionId: string,
  busy: boolean,
): SessionInteractionState {
  const current = state[sessionId];
  return current ? { ...state, [sessionId]: { ...current, busy } } : state;
}

export function patchSessionMessage(
  state: Record<string, ChatMessageItem[]>,
  sessionId: string,
  messageId: string,
  patch: Partial<ChatMessageItem>,
): Record<string, ChatMessageItem[]> {
  return {
    ...state,
    [sessionId]: (state[sessionId] ?? []).map((item) => (
      item.id === messageId ? { ...item, ...patch } : item
    )),
  };
}

export function hydrateSessionMessages(
  state: Record<string, ChatMessageItem[]>,
  sessionId: string,
  storedMessages: ChatMessageItem[],
  hasActiveRun: boolean,
): Record<string, ChatMessageItem[]> {
  if (hasActiveRun && state[sessionId]) return state;
  return { ...state, [sessionId]: storedMessages };
}

export function recoverInterruptedMessage(
  message: ChatMessageItem,
  snapshot: NonNullable<ChatMessage["runSnapshot"]>,
): ChatMessageItem {
  if (snapshot.status === "terminal" || snapshot.status === "interrupted") return message;
  return {
    ...message,
    streaming: false,
    reasoningStreaming: false,
    loading: false,
    waitingForFirstEvent: false,
    runStage: { kind: "failed", detail: "上次运行已中断" },
    runActivity: {
      ...(message.runActivity ?? { startedAt: snapshot.updatedAt, reasoningMs: 0 }),
      activeReasoningStartedAt: undefined,
      completedAt: snapshot.updatedAt,
      keepExpanded: true,
    },
  };
}

export function findSessionIdForRun(
  activeRuns: Record<string, { runId?: string }>,
  runId: string | undefined,
): string | undefined {
  if (!runId) return undefined;
  return Object.entries(activeRuns).find(([, run]) => run.runId === runId)?.[0];
}

export function hasActiveRunForSession(
  activeRuns: Record<string, unknown>,
  sessionId: string,
): boolean {
  return Boolean(activeRuns[sessionId]);
}

interface HarnessTodoPresentation {
  id: string;
  content: string;
  status: string;
}

export interface SessionTodoState {
  runId?: string;
  todos: TodoItem[];
  updatedAt: number;
}

export type TodoStateBySession = Record<string, SessionTodoState>;

export function buildTodoRecoveryContext(
  messages: readonly ChatMessage[],
  excludedMessageId?: string,
): string | undefined {
  const message = [...messages].reverse().find((candidate) => {
    if (candidate.id === excludedMessageId) return false;
    const snapshot = candidate.runSnapshot;
    if (!snapshot?.todos?.some((todo) => todo.status === "pending" || todo.status === "in_progress")) return false;
    if (snapshot.status !== "terminal") return true;
    return snapshot.terminalStatus !== undefined && snapshot.terminalStatus !== "success";
  });
  if (!message?.runSnapshot?.todos) return undefined;

  const successes = message.toolExecutions?.filter((tool) => tool.status === "success").length ?? 0;
  const failures = message.toolExecutions?.filter((tool) => tool.status === "error").length ?? 0;
  return [
    "上一次任务在完整回答提交前中断。以下内容来自同一会话的本地检查点，仅用于恢复方向：",
    "Todo：",
    ...message.runSnapshot.todos.map((todo) => `- [${todo.status}] ${todo.content}`),
    `工具执行事实：成功 ${successes} 项，失败 ${failures} 项。`,
    "Todo 和本地记录不能证明外部副作用已经成功；继续前请根据现有证据查证，不要自动重放危险操作。",
  ].join("\n");
}

export function startSessionTodos(
  state: TodoStateBySession,
  sessionId: string,
  runId: string | undefined,
  updatedAt = Date.now(),
): TodoStateBySession {
  return {
    ...state,
    [sessionId]: { runId, todos: [], updatedAt },
  };
}

export function mergeHarnessTodosForSession(
  state: TodoStateBySession,
  sessionId: string,
  runId: string | undefined,
  items: readonly HarnessTodoPresentation[],
  updatedAt = Date.now(),
): TodoStateBySession {
  const current = state[sessionId];
  if (current?.runId && runId && current.runId !== runId) return state;

  const todos = items.flatMap<TodoItem>((item) => {
    if (!item.id || !item.content) return [];
    if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") return [];
    return [{ id: item.id, content: item.content, status: item.status }];
  });

  return {
    ...state,
    [sessionId]: { runId: current?.runId ?? runId, todos, updatedAt },
  };
}
