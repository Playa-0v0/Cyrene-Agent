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
} from "../../shared/chat-types";

const ROOT_DIR_NAME = "cyrene-chats";
const SESSIONS_SUBDIR = "sessions";
const INDEX_FILE = "index.json";

let rootDir = "";
let sessionsDir = "";
let indexPath = "";
let indexCache: ChatSessionMeta[] = [];
let initialized = false;

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
    return parsed.filter((item): item is ChatSessionMeta => {
      if (!item || typeof item !== "object") return false;
      const meta = item as Partial<ChatSessionMeta>;
      return (
        typeof meta.id === "string" &&
        typeof meta.title === "string" &&
        typeof meta.createdAt === "number" &&
        typeof meta.updatedAt === "number" &&
        typeof meta.messageCount === "number"
      );
    });
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
    return parsed;
  } catch (err) {
    console.warn("[chats-store] session 文件解析失败:", id, err);
    return null;
  }
}

function writeSessionFile(session: ChatSession): void {
  atomicWriteJson(sessionPath(session.id), session);
}

function metaFromSession(session: ChatSession): ChatSessionMeta {
  return {
    id: session.id,
    title: session.title,
    identityId: session.identityId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
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
  indexCache = readIndexFromDisk();
  initialized = true;
}

export function getRootDir(): string {
  return rootDir;
}

export function listSessions(): ChatSessionMeta[] {
  // 返回深拷贝，避免外部修改影响缓存
  return indexCache.map((m) => ({ ...m }));
}

export function getSession(id: string): ChatSession | null {
  return readSessionFile(id);
}

export function getSessionPage(id: string, before: number | null, limit: number): {
  session: Omit<ChatSession, "messages">;
  messages: ChatMessage[];
  hasMore: boolean;
} | null {
  const session = readSessionFile(id);
  if (!session) return null;
  const end = Math.max(0, Math.min(before ?? session.messages.length, session.messages.length));
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 1, 200));
  const start = Math.max(0, end - safeLimit);
  const { messages: _messages, ...meta } = session;
  return { session: meta, messages: session.messages.slice(start, end), hasMore: start > 0 };
}

export function createSession(opts?: {
  title?: string;
  identityId?: string | null;
  initialMessages?: ChatMessage[];
}): ChatSession {
  const now = Date.now();
  const messages = opts?.initialMessages ?? [];
  const session: ChatSession = {
    id: randomUUID(),
    title: opts?.title?.trim() || (messages.length > 0 ? deriveTitle(messages) : "新对话"),
    identityId: opts?.identityId ?? null,
    messages,
    createdAt: now,
    updatedAt: now,
    schemaVersion: CHAT_SCHEMA_VERSION,
  };
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
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
  return createSession({
    title: "历史对话",
    identityId: null,
    initialMessages: cleaned,
  });
}

// 在系统文件管理器中打开存储目录。
export async function openStorageFolder(): Promise<void> {
  ensureDirs();
  await shell.openPath(rootDir);
}
