// 聊天会话持久化存储
//
// 布局：<userData>/cyrene-chats/
//   index.json              — ChatSessionMeta[]，按 updatedAt desc 排序
//   sessions/<id>.json      — 完整 ChatSession（含 messages）
//
// 设计：
// - 列表读 index.json（轻），进入会话才读 sessions/<id>.json（重）；
// - 写时先写 .tmp 再 rename，避免 crash 中间态损坏文件；
// - index.json 在内存里有缓存（initialize() 时一次性加载），
//   后续 list 直接返回缓存的 deep clone；任何写操作后同步刷新缓存；
// - 删除文件夹整体可移植：用户拷贝 cyrene-chats/ 到新机器即可恢复。

import { app, shell } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  CHAT_SCHEMA_VERSION,
  type ChatMessage,
  type ChatSession,
  type ChatSessionMeta,
  type ChatSessionPurpose,
  type ConversationMode,
} from "../../shared/chat-types";
import type { ContextUsageSnapshot } from "../../shared/context-usage";

const ROOT_DIR_NAME = "cyrene-chats";
const SESSIONS_SUBDIR = "sessions";
const INDEX_FILE = "index.json";
const LEGACY_MIGRATION_PROJECT_NAME = "迁移文件夹";

let rootDir = "";
let sessionsDir = "";
let indexPath = "";
let indexCache: ChatSessionMeta[] = [];
let initialized = false;

function isConversationMode(value: unknown): value is ConversationMode {
  return value === "chat" || value === "work" || value === "code"
    || value === "learn";
}

function normalizePersistedMode(value: unknown, purpose: ChatSessionPurpose | undefined): ConversationMode {
  if (value === "daily") return "work";
  return isConversationMode(value) ? value : inferLegacyMode(purpose);
}

function inferLegacyMode(purpose: ChatSessionPurpose | undefined): ConversationMode {
  return purpose === "proactive-chat" ? "chat" : "work";
}

function legacyMigrationBinding(): ConversationWorkspaceBinding {
  const workspaceRoot = path.join(app.getPath("userData"), LEGACY_MIGRATION_PROJECT_NAME);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return {
    workspaceRoot,
    displayName: LEGACY_MIGRATION_PROJECT_NAME,
    boundAt: Date.now(),
  };
}

function ensureDirs(): void {
  if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function readIndexFromDisk(): ChatSessionMeta[] {
  if (!fs.existsSync(indexPath)) return [];
  try {
    const raw = fs.readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    let migrated = false;
    const normalized: ChatSessionMeta[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const meta = item as Partial<ChatSessionMeta>;
      const valid = (
        typeof meta.id === "string" &&
        typeof meta.title === "string" &&
        typeof meta.createdAt === "number" &&
        typeof meta.updatedAt === "number" &&
        typeof meta.messageCount === "number" &&
        (meta.purpose === undefined || meta.purpose === "proactive-chat")
      );
      if (!valid) continue;
      const session = readSessionFile(meta.id!);
      const indexedMode = meta.mode;
      const mode = normalizePersistedMode(indexedMode ?? session?.mode, meta.purpose ?? session?.purpose);
      const workspaceRoot = typeof meta.workspaceRoot === "string"
        ? meta.workspaceRoot
        : session?.workspaceBinding?.workspaceRoot;
      const workspaceDisplayName = typeof meta.workspaceDisplayName === "string"
        ? meta.workspaceDisplayName
        : session?.workspaceBinding?.displayName;
      const pinned = Boolean(meta.pinned ?? session?.pinned);
      if (
        mode !== indexedMode
        || workspaceRoot !== meta.workspaceRoot
        || workspaceDisplayName !== meta.workspaceDisplayName
        || pinned !== meta.pinned
      ) migrated = true;
      normalized.push({
        id: meta.id!,
        title: meta.title!,
        identityId: meta.identityId ?? null,
        createdAt: meta.createdAt!,
        updatedAt: meta.updatedAt!,
        messageCount: meta.messageCount!,
        purpose: meta.purpose,
        mode,
        workspaceRoot,
        workspaceDisplayName,
        pinned,
      });
    }
    if (migrated) atomicWriteJson(indexPath, normalized);
    return normalized;
  } catch (err) {
    console.warn("[chats-store] index.json 解析失败，重置为空:", err);
    return [];
  }
}

function persistIndex(): void {
  // 排序按 updatedAt desc，最近的对话排前面
  indexCache.sort((a, b) => b.updatedAt - a.updatedAt);
  atomicWriteJson(indexPath, indexCache);
}

function sessionPath(id: string): string {
  return path.join(sessionsDir, id + ".json");
}

function readSessionFile(id: string): ChatSession | null {
  const filePath = sessionPath(id);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as ChatSession;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
      return null;
    }
    parsed.mode = normalizePersistedMode(parsed.mode, parsed.purpose);
    delete (parsed as ChatSession & { codeSession?: unknown }).codeSession;
    return parsed;
  } catch (err) {
    console.warn("[chats-store] session 文件解析失败:", id, err);
    return null;
  }
}

function writeSessionFile(session: ChatSession): void {
  atomicWriteJson(sessionPath(session.id), session);
}

/**
 * 旧版会话没有 mode，也没有项目路径。升级时统一归入 Work，并绑定到
 * userData/迁移文件夹。旧版本曾把无模式会话回填成未绑定路径的 Work，
 * 因此这里同时识别“无合法 mode”和“Work 但无 workspaceBinding”两种形态。
 * 新版 Work 创建流程要求绑定路径，所以有明确项目的会话不会被误迁移。
 */
function migrateLegacySessions(): void {
  if (!fs.existsSync(indexPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return;
    let binding: ConversationWorkspaceBinding | null = null;
    let changed = false;
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const meta = item as Partial<ChatSessionMeta>;
      if (typeof meta.id !== "string" || meta.purpose === "proactive-chat") continue;
      const filePath = sessionPath(meta.id);
      if (!fs.existsSync(filePath)) continue;
      let session: ChatSession;
      try {
        session = JSON.parse(fs.readFileSync(filePath, "utf8")) as ChatSession;
      } catch {
        continue;
      }
      if (!session || !Array.isArray(session.messages)) continue;
      const sourceMode: unknown = session.mode ?? meta.mode;
      const isLegacyDaily = sourceMode === "daily";
      const nextMode = normalizePersistedMode(sourceMode, session.purpose ?? meta.purpose);
      const needsWorkspaceBinding = nextMode === "work" && !session.workspaceBinding
        && (!isConversationMode(sourceMode) || isLegacyDaily || sourceMode === "work");
      const hasCodeSession = "codeSession" in (session as ChatSession & { codeSession?: unknown });
      const needsMigration = sourceMode !== nextMode || needsWorkspaceBinding || hasCodeSession;
      if (!needsMigration) continue;
      if (needsWorkspaceBinding) {
        binding ??= legacyMigrationBinding();
        session.workspaceBinding = { ...binding };
      }
      session.mode = nextMode;
      delete (session as ChatSession & { codeSession?: unknown }).codeSession;
      writeSessionFile(session);
      meta.mode = nextMode;
      meta.workspaceRoot = session.workspaceBinding?.workspaceRoot;
      meta.workspaceDisplayName = session.workspaceBinding?.displayName;
      changed = true;
    }
    if (changed) atomicWriteJson(indexPath, parsed);
  } catch (err) {
    console.warn("[chats-store] 旧会话迁移失败，保留原数据:", err);
  }
}

function metaFromSession(session: ChatSession): ChatSessionMeta {
  return {
    id: session.id,
    title: session.title,
    identityId: session.identityId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    purpose: session.purpose,
    mode: isConversationMode(session.mode) ? session.mode : inferLegacyMode(session.purpose),
    workspaceRoot: session.workspaceBinding?.workspaceRoot,
    workspaceDisplayName: session.workspaceBinding?.displayName,
    pinned: session.pinned,
  };
}

function upsertMeta(meta: ChatSessionMeta): void {
  const idx = indexCache.findIndex((m) => m.id === meta.id);
  if (idx === -1) indexCache.push(meta);
  else indexCache[idx] = meta;
  persistIndex();
}

function removeMetaById(id: string): void {
  indexCache = indexCache.filter((m) => m.id !== id);
  persistIndex();
}

// 从首条用户消息推导标题（前 30 字 / 单行）。
function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  if (!firstUser) return "新对话";
  const cleaned = firstUser.content.replace(/\s+/g, " ").trim();
  return cleaned.length > 30 ? cleaned.slice(0, 30) + "…" : cleaned;
}

// ── public API ──────────────────────────────────────────────

export function initialize(): void {
  if (initialized) return;
  rootDir = path.join(app.getPath("userData"), ROOT_DIR_NAME);
  sessionsDir = path.join(rootDir, SESSIONS_SUBDIR);
  indexPath = path.join(rootDir, INDEX_FILE);
  ensureDirs();
  migrateLegacySessions();
  indexCache = readIndexFromDisk();
  initialized = true;
}

export function getRootDir(): string {
  return rootDir;
}

export function listSessions(options?: { mode?: ConversationMode }): ChatSessionMeta[] {
  // 返回深拷贝，避免外部修改影响缓存；置顶项优先，其余按 updatedAt 倒序
  const sessions = options?.mode
    ? indexCache.filter((session) => session.mode === options.mode)
    : indexCache;
  return [...sessions]
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.updatedAt - a.updatedAt;
    })
    .map((m) => ({ ...m }));
}

export function getSession(id: string): ChatSession | null {
  return readSessionFile(id);
}

export function getSessionPage(id: string, before: number | null, limit: number): {
  session: Omit<ChatSession, "messages"> & { messageCount: number };
  messages: ChatMessage[];
  hasMore: boolean;
} | null {
  const session = readSessionFile(id);
  if (!session) return null;
  const end = Math.max(0, Math.min(before ?? session.messages.length, session.messages.length));
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 1, 200));
  const start = Math.max(0, end - safeLimit);
  const { messages: _messages, ...meta } = session;
  return {
    session: { ...meta, messageCount: session.messages.length },
    messages: session.messages.slice(start, end),
    hasMore: start > 0,
  };
}

export function createSession(opts?: {
  title?: string;
  identityId?: string | null;
  initialMessages?: ChatMessage[];
  purpose?: ChatSessionPurpose;
  mode?: ConversationMode;
  modelProfileId?: string;
}): ChatSession {
  const now = Date.now();
  const messages = opts?.initialMessages ?? [];
  const mode = opts?.mode ?? (opts?.purpose === "proactive-chat" ? "chat" : "work");
  const session: ChatSession = {
    id: randomUUID(),
    title: opts?.title?.trim() || (messages.length > 0 ? deriveTitle(messages) : "新对话"),
    identityId: opts?.identityId ?? null,
    messages,
    createdAt: now,
    updatedAt: now,
    schemaVersion: CHAT_SCHEMA_VERSION,
    purpose: opts?.purpose,
    titleIsCustom: opts?.purpose ? true : undefined,
    mode,
    modelProfileId: opts?.modelProfileId,
  };
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function getSessionByPurpose(purpose: ChatSessionPurpose): ChatSession | null {
  const meta = indexCache.find((session) => session.purpose === purpose);
  return meta ? readSessionFile(meta.id) : null;
}

/**
 * Electron 主进程内的 store API 是同步的：查询与创建之间没有 await，
 * 因此同一事件循环上的并发调用也无法穿插出两个同用途会话。
 */
export function getOrCreateSessionByPurpose(
  purpose: ChatSessionPurpose,
  opts?: { title?: string; identityId?: string | null },
): ChatSession {
  const existing = getSessionByPurpose(purpose);
  if (existing) return existing;
  return createSession({
    title: opts?.title,
    identityId: opts?.identityId ?? null,
    purpose,
  });
}

export function appendMessage(id: string, message: ChatMessage): ChatSession | null {
  const session = readSessionFile(id);
  if (!session) return null;
  session.messages.push(message);
  session.updatedAt = Date.now();
  // 用户没手动改名时，根据最新内容重新派生（清空后也会回到"新对话"）
  if (!session.titleIsCustom) {
    session.title = deriveTitle(session.messages);
  }
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function upsertMessage(id: string, message: ChatMessage): ChatSession | null {
  const session = readSessionFile(id);
  if (!session) return null;
  const index = session.messages.findIndex((item) => item.id === message.id);
  if (index >= 0) session.messages[index] = message;
  else session.messages.push(message);
  session.updatedAt = Date.now();
  if (!session.titleIsCustom) session.title = deriveTitle(session.messages);
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

/** 仅回写模型消息的 TTS 缓存引用，不改变会话的业务修改时间。 */
export function setMessageTtsCacheKey(
  id: string,
  messageId: string,
  cacheKey: string,
  converterVersion: string,
): ChatSession | null {
  if (!/^(minimax|gptsovits|custom-cloud|mimo|mossland)-[a-f0-9]{64}$/.test(cacheKey)) return null;
  if (!/^[a-z\d][a-z\d._-]{0,63}$/i.test(converterVersion)) return null;
  const session = readSessionFile(id);
  if (!session) return null;
  const message = session.messages.find((item) => item.id === messageId && item.role === "model");
  if (!message) return null;
  message.ttsCacheKey = cacheKey;
  message.ttsCacheVersion = converterVersion;
  writeSessionFile(session);
  return session;
}

// 批量覆盖整个 messages 数组（聊天窗口流式结束/清空/错误等场景用）。
// updatedAt 一并刷新；用户没手动改名时根据新内容重新派生。
export function replaceMessages(id: string, messages: ChatMessage[]): ChatSession | null {
  const session = readSessionFile(id);
  if (!session) return null;
  session.messages = messages;
  session.updatedAt = Date.now();
  if (!session.titleIsCustom) {
    session.title = deriveTitle(session.messages);
  }
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function replaceMessagesTail(id: string, startIndex: number, messages: ChatMessage[]): ChatSession | null {
  const session = readSessionFile(id);
  if (!session || !Number.isInteger(startIndex) || startIndex < 0 || startIndex > session.messages.length) return null;
  session.messages = session.messages.slice(0, startIndex).concat(messages);
  session.updatedAt = Date.now();
  if (!session.titleIsCustom) session.title = deriveTitle(session.messages);
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function renameSession(id: string, title: string): ChatSession | null {
  const session = readSessionFile(id);
  if (!session) return null;
  const trimmed = title.trim();
  if (!trimmed) return session;
  session.title = trimmed.slice(0, 80);
  session.titleIsCustom = true;
  session.updatedAt = Date.now();
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function setSessionPinned(id: string, pinned: boolean): ChatSession | null {
  const session = readSessionFile(id);
  if (!session) return null;
  session.pinned = Boolean(pinned);
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function setSessionModelProfile(id: string, modelProfileId: string | undefined): ChatSession | null {
  const session = readSessionFile(id);
  if (!session) return null;
  session.modelProfileId = modelProfileId;
  session.updatedAt = Date.now();
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

/**
 * 会话级最新上下文容量快照写入（上下文环形图的唯一读取点）。
 * 手动压缩等不产生新 assistant 消息但改变上下文构成的操作走这里。
 */
export function setSessionContextUsage(
  id: string,
  snapshot: ContextUsageSnapshot,
): ChatSession | null {
  const session = readSessionFile(id);
  if (!session) return null;
  session.currentContextUsage = snapshot;
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function deleteSession(id: string): boolean {
  const filePath = sessionPath(id);
  let fileExisted = false;
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      fileExisted = true;
    } catch (err) {
      console.warn("[chats-store] 删除 session 文件失败:", id, err);
    }
  }
  const inIndex = indexCache.some((m) => m.id === id);
  if (inIndex) removeMetaById(id);
  return fileExisted || inIndex;
}

// 返回最新一条会话的 id（按 updatedAt 排）；列表为空返回 null。
export function getLatestSessionId(): string | null {
  if (indexCache.length === 0) return null;
  // indexCache 已按 updatedAt desc 持久化，但保险起见再排一次
  const sorted = [...indexCache].sort((a, b) => b.updatedAt - a.updatedAt);
  return sorted[0].id;
}

// 一次性迁移：从聊天窗口 localStorage 拿来的旧 Message[] 包成单个 session。
// 已经迁移过（再次调用且数据相同）时返回 null 让调用方决定是否提示。
export function migrateLegacyMessages(messages: ChatMessage[]): ChatSession | null {
  if (!messages || messages.length === 0) return null;
  // 过滤掉无意义条目（空 content / 占位）
  const cleaned = messages.filter(
    (m) => m && (m.role === "user" || m.role === "model") && typeof m.content === "string" && m.content.trim(),
  );
  if (cleaned.length === 0) return null;
  const session = createSession({
    title: "历史对话",
    identityId: null,
    initialMessages: cleaned,
    mode: "work",
  });
  return setWorkspaceBinding(session.id, legacyMigrationBinding());
}

// 在系统文件管理器中打开存储目录。
export async function openStorageFolder(): Promise<void> {
  ensureDirs();
  await shell.openPath(rootDir);
}

// ── 对话工作区绑定 ────────────────────────────────────────

import type { ConversationWorkspaceBinding } from "../../shared/chat-types";

/**
 * 设置对话的工作区绑定。
 * 返回更新后的 session，失败返回 null。
 */
export function setWorkspaceBinding(
  sessionId: string,
  binding: ConversationWorkspaceBinding,
): ChatSession | null {
  const session = readSessionFile(sessionId);
  if (!session) return null;
  session.workspaceBinding = binding;
  session.updatedAt = Date.now();
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

/**
 * 获取对话的工作区绑定。
 * 未绑定返回 undefined。
 */
export function getWorkspaceBinding(sessionId: string): ConversationWorkspaceBinding | undefined {
  const session = readSessionFile(sessionId);
  return session?.workspaceBinding;
}

/**
 * 清除对话的工作区绑定。
 * 返回更新后的 session，失败返回 null。
 */
export function clearWorkspaceBinding(sessionId: string): ChatSession | null {
  const session = readSessionFile(sessionId);
  if (!session) return null;
  session.workspaceBinding = undefined;
  session.updatedAt = Date.now();
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}
