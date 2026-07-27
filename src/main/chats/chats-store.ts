// 聊天會話持久化存儲
//
// 佈局：<userData>/cyrene-chats/
//   index.json              — ChatSessionMeta[]，按 updatedAt desc 排序
//   sessions/<id>.json      — 完整 ChatSession（含 messages）
//
// 設計：
// - 列表讀 index.json（輕），進入會話才讀 sessions/<id>.json（重）；
// - 寫時先寫 .tmp 再 rename，避免 crash 中間態損壞文件；
// - index.json 在內存裡有緩存（initialize() 時一次性加載），
//   後續 list 直接返回緩存的 deep clone；任何寫操作後同步刷新緩存；
// - 刪除文件夾整體可移植：用戶拷貝 cyrene-chats/ 到新機器即可恢復。

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
    console.warn("[chats-store] index.json 解析失敗，重置為空:", err);
    return [];
  }
}

function persistIndex(): void {
  // 排序按 updatedAt desc，最近的對話排前面
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
    console.warn("[chats-store] session 文件解析失敗:", id, err);
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

// 從首條用戶消息推導標題（前 30 字 / 單行）。
function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  if (!firstUser) return "新對話";
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
  // 返回深拷貝，避免外部修改影響緩存
  return indexCache.map((m) => ({ ...m }));
}

export function getSession(id: string): ChatSession | null {
  return readSessionFile(id);
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
    title: opts?.title?.trim() || (messages.length > 0 ? deriveTitle(messages) : "新對話"),
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
  // 用戶沒手動改名時，根據最新內容重新派生（清空後也會回到"新對話"）
  if (!session.titleIsCustom) {
    session.title = deriveTitle(session.messages);
  }
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

// 批量覆蓋整個 messages 數組（聊天窗口流式結束/清空/錯誤等場景用）。
// updatedAt 一併刷新；用戶沒手動改名時根據新內容重新派生。
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
      console.warn("[chats-store] 刪除 session 文件失敗:", id, err);
    }
  }
  const inIndex = indexCache.some((m) => m.id === id);
  if (inIndex) removeMetaById(id);
  return fileExisted || inIndex;
}

// 返回最新一條會話的 id（按 updatedAt 排）；列表為空返回 null。
export function getLatestSessionId(): string | null {
  if (indexCache.length === 0) return null;
  // indexCache 已按 updatedAt desc 持久化，但保險起見再排一次
  const sorted = [...indexCache].sort((a, b) => b.updatedAt - a.updatedAt);
  return sorted[0].id;
}

// 一次性遷移：從聊天窗口 localStorage 拿來的舊 Message[] 包成單個 session。
// 已經遷移過（再次調用且數據相同）時返回 null 讓調用方決定是否提示。
export function migrateLegacyMessages(messages: ChatMessage[]): ChatSession | null {
  if (!messages || messages.length === 0) return null;
  // 過濾掉無意義條目（空 content / 佔位）
  const cleaned = messages.filter(
    (m) => m && (m.role === "user" || m.role === "model") && typeof m.content === "string" && m.content.trim(),
  );
  if (cleaned.length === 0) return null;
  return createSession({
    title: "歷史對話",
    identityId: null,
    initialMessages: cleaned,
  });
}

// 在系統文件管理器中打開存儲目錄。
export async function openStorageFolder(): Promise<void> {
  ensureDirs();
  await shell.openPath(rootDir);
}
