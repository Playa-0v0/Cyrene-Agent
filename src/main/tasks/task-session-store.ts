import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  TaskSession,
  TaskSessionStatus,
  TaskSubagentType,
  TodoItem,
  TodoStatus,
  TaskTraceRecord,
  TaskTranscriptMessage,
} from "../../shared/task-session";

const ROOT_DIR_NAME = "cyrene-tasks";
const SESSIONS_DIR_NAME = "sessions";
const INDEX_FILE_NAME = "index.json";
const TRACE_LIMIT = 2_000;

export interface CreateTaskSessionInput {
  parentConversationId: string;
  parentRunId: string;
  description: string;
  prompt: string;
  subagentType: TaskSubagentType;
  mode: "work" | "code";
  resolvedWorkspaceRoot?: string;
}

export interface ResumeTaskSessionInput {
  parentConversationId: string;
  parentRunId: string;
  subagentType: TaskSubagentType;
  prompt: string;
}

export interface TaskSessionCheckpoint {
  parentRunId?: string;
  childRunId?: string;
  status?: TaskSessionStatus;
  messages?: TaskTranscriptMessage[];
  trace?: TaskTraceRecord[];
  todoItems?: TodoItem[];
  resultText?: string;
  error?: { code: string; message: string };
  completedAt?: number;
}

export interface TaskSessionStoreOptions {
  now?: () => number;
  createId?: () => string;
  createChildRunId?: () => string;
}

interface TaskSessionIndexRow {
  id: string;
  parentConversationId: string;
  status: TaskSessionStatus;
  updatedAt: number;
}

function isTaskStatus(value: unknown): value is TaskSessionStatus {
  return value === "running" || value === "completed" || value === "failed"
    || value === "cancelled" || value === "interrupted";
}

function isTaskType(value: unknown): value is TaskSubagentType {
  return value === "general" || value === "document" || value === "search";
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function cloneTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<TodoItem>;
    if (typeof candidate.id !== "string" || candidate.id.trim().length === 0
      || typeof candidate.content !== "string" || candidate.content.trim().length === 0
      || !isTodoStatus(candidate.status)) return [];
    return [{
      id: candidate.id,
      content: candidate.content,
      status: candidate.status,
      ...(typeof candidate.activeForm === "string" ? { activeForm: candidate.activeForm } : {}),
    }];
  });
}

function isTaskSession(value: unknown): value is TaskSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<TaskSession>;
  return session.schemaVersion === 1
    && typeof session.id === "string"
    && typeof session.parentConversationId === "string"
    && typeof session.parentRunId === "string"
    && typeof session.childRunId === "string"
    && typeof session.description === "string"
    && isTaskType(session.subagentType)
    && (session.mode === "work" || session.mode === "code")
    && isTaskStatus(session.status)
    && Array.isArray(session.messages)
    && Array.isArray(session.trace)
    && typeof session.createdAt === "number"
    && typeof session.updatedAt === "number";
}

function cloneSession(session: TaskSession): TaskSession {
  return JSON.parse(JSON.stringify(session)) as TaskSession;
}

/**
 * Task 私有会话存储。它不依赖 Electron，方便测试；生产启动时传入 app.getPath("userData")。
 */
export class TaskSessionStore {
  private readonly taskRoot: string;
  private readonly sessionsDir: string;
  private readonly indexPath: string;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createChildRunId: () => string;
  private index = new Map<string, TaskSessionIndexRow>();

  constructor(root: string, options: TaskSessionStoreOptions = {}) {
    this.taskRoot = path.join(root, ROOT_DIR_NAME);
    this.sessionsDir = path.join(this.taskRoot, SESSIONS_DIR_NAME);
    this.indexPath = path.join(this.taskRoot, INDEX_FILE_NAME);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.createChildRunId = options.createChildRunId ?? randomUUID;
    this.initialize();
  }

  create(input: CreateTaskSessionInput): TaskSession {
    const now = this.now();
    const session: TaskSession = {
      schemaVersion: 1,
      id: this.createId(),
      parentConversationId: input.parentConversationId,
      parentRunId: input.parentRunId,
      childRunId: this.createChildRunId(),
      description: input.description,
      subagentType: input.subagentType,
      mode: input.mode,
      ...(input.resolvedWorkspaceRoot ? { resolvedWorkspaceRoot: input.resolvedWorkspaceRoot } : {}),
      status: "running",
      messages: [{ role: "user", content: input.prompt }],
      trace: [],
      todoItems: [],
      createdAt: now,
      updatedAt: now,
    };
    this.write(session);
    return cloneSession(session);
  }

  get(taskId: string): TaskSession | null {
    const session = this.read(taskId);
    return session ? cloneSession(session) : null;
  }

  listForParent(parentConversationId: string): TaskSession[] {
    return [...this.index.values()]
      .filter((row) => row.parentConversationId === parentConversationId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .flatMap((row) => {
        const session = this.read(row.id);
        return session ? [cloneSession(session)] : [];
      });
  }

  resume(taskId: string, input: ResumeTaskSessionInput): TaskSession {
    const session = this.require(taskId);
    if (session.parentConversationId !== input.parentConversationId) {
      throw new Error("TASK_PARENT_MISMATCH");
    }
    if (session.subagentType !== input.subagentType) {
      throw new Error("TASK_PROFILE_MISMATCH");
    }
    if (session.status === "running") {
      throw new Error("TASK_ALREADY_RUNNING");
    }

    session.parentRunId = input.parentRunId;
    session.childRunId = this.createChildRunId();
    session.status = "running";
    session.resultText = undefined;
    session.error = undefined;
    session.completedAt = undefined;
    session.messages.push({ role: "user", content: input.prompt });
    session.updatedAt = this.now();
    this.write(session);
    return cloneSession(session);
  }

  checkpoint(taskId: string, patch: TaskSessionCheckpoint): TaskSession {
    const session = this.require(taskId);
    if (patch.parentRunId !== undefined) session.parentRunId = patch.parentRunId;
    if (patch.childRunId !== undefined) session.childRunId = patch.childRunId;
    if (patch.status !== undefined) session.status = patch.status;
    if (patch.messages !== undefined) session.messages = cloneSession({ ...session, messages: patch.messages }).messages;
    if (patch.trace !== undefined) session.trace = patch.trace.slice(-TRACE_LIMIT);
    if (patch.todoItems !== undefined) session.todoItems = cloneTodoItems(patch.todoItems);
    if (patch.resultText !== undefined) session.resultText = patch.resultText;
    if (patch.error !== undefined) session.error = { ...patch.error };
    if (patch.completedAt !== undefined) session.completedAt = patch.completedAt;
    session.updatedAt = this.now();
    this.write(session);
    return cloneSession(session);
  }

  private initialize(): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.readIndex();

    let changed = false;
    for (const row of this.index.values()) {
      const session = this.read(row.id);
      if (!session) continue;
      if (session.status === "running") {
        session.status = "interrupted";
        session.updatedAt = this.now();
        this.writeSession(session);
        this.index.set(session.id, this.indexRow(session));
        changed = true;
      }
    }
    if (changed) this.writeIndex();
  }

  private require(taskId: string): TaskSession {
    const session = this.read(taskId);
    if (!session) throw new Error("TASK_NOT_FOUND");
    return session;
  }

  private read(taskId: string): TaskSession | null {
    const file = path.join(this.sessionsDir, `${taskId}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return isTaskSession(parsed)
        ? { ...parsed, todoItems: cloneTodoItems((parsed as Partial<TaskSession>).todoItems) }
        : null;
    } catch {
      return null;
    }
  }

  private write(session: TaskSession): void {
    this.writeSession(session);
    this.index.set(session.id, this.indexRow(session));
    this.writeIndex();
  }

  private writeSession(session: TaskSession): void {
    this.atomicWrite(path.join(this.sessionsDir, `${session.id}.json`), session);
  }

  private writeIndex(): void {
    this.atomicWrite(this.indexPath, [...this.index.values()]);
  }

  private readIndex(): void {
    if (!fs.existsSync(this.indexPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const row of parsed) {
        if (!row || typeof row !== "object") continue;
        const candidate = row as Partial<TaskSessionIndexRow>;
        if (typeof candidate.id !== "string"
          || typeof candidate.parentConversationId !== "string"
          || !isTaskStatus(candidate.status)
          || typeof candidate.updatedAt !== "number") continue;
        this.index.set(candidate.id, candidate as TaskSessionIndexRow);
      }
    } catch {
      this.index.clear();
    }
  }

  private indexRow(session: TaskSession): TaskSessionIndexRow {
    return {
      id: session.id,
      parentConversationId: session.parentConversationId,
      status: session.status,
      updatedAt: session.updatedAt,
    };
  }

  private atomicWrite(filePath: string, value: unknown): void {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  }
}
