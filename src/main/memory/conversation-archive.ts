// 跨渠道逐字對話檔案。
//
// 這份 JSONL 是記憶系統的 source of truth：只追加、不截斷、不做語義去重。
// 向量庫可以重建，這裡的原話不能丟。Electron、外部渠道與通話都寫入同一份檔案。
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

export type ConversationRole = "user" | "assistant";
export type ConversationKind = "message" | "image_memory";

export interface ConversationArchiveEntry {
  id: string;
  sessionId: string;
  channel: string;
  role: ConversationRole;
  kind: ConversationKind;
  content: string;
  at: number;
  sourceMessageId?: string;
}

export interface AppendArchiveEntryInput {
  id?: string;
  sessionId: string;
  channel?: string;
  role: ConversationRole;
  kind?: ConversationKind;
  content: string;
  at?: number;
  sourceMessageId?: string;
}

const ARCHIVE_DIR = "conversation-archive";
const ARCHIVE_FILE = "turns.jsonl";
const INDEXED_FILE = "rag-indexed-ids.json";
let knownIds: Set<string> | null = null;
let indexedIds: Set<string> | null = null;

function archiveDir(): string {
  return path.join(app.getPath("userData"), ARCHIVE_DIR);
}

export function getConversationArchivePath(): string {
  return path.join(archiveDir(), ARCHIVE_FILE);
}

function indexedPath(): string {
  return path.join(archiveDir(), INDEXED_FILE);
}

function inferChannel(sessionId: string): string {
  if (sessionId.startsWith("channel:")) return sessionId.split(":")[1] || "channel";
  if (sessionId.startsWith("call:")) return sessionId.split(":")[1] || "call";
  return "desktop";
}

function stableId(input: AppendArchiveEntryInput): string {
  if (input.id) return input.id;
  const basis = [
    input.sessionId,
    input.role,
    String(input.at ?? ""),
    input.sourceMessageId ?? "",
    input.content,
  ].join("\u0000");
  return createHash("sha256").update(basis).digest("hex");
}

function parseLine(line: string): ConversationArchiveEntry | null {
  try {
    const entry = JSON.parse(line) as Partial<ConversationArchiveEntry>;
    if (!entry || typeof entry.id !== "string" || typeof entry.sessionId !== "string") return null;
    if (entry.role !== "user" && entry.role !== "assistant") return null;
    if (typeof entry.content !== "string" || typeof entry.at !== "number") return null;
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      channel: typeof entry.channel === "string" ? entry.channel : inferChannel(entry.sessionId),
      role: entry.role,
      kind: entry.kind === "image_memory" ? "image_memory" : "message",
      content: entry.content,
      at: entry.at,
      ...(typeof entry.sourceMessageId === "string" ? { sourceMessageId: entry.sourceMessageId } : {}),
    };
  } catch {
    return null;
  }
}

export function loadConversationArchive(): ConversationArchiveEntry[] {
  const file = getConversationArchivePath();
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(parseLine)
      .filter((entry): entry is ConversationArchiveEntry => entry !== null);
  } catch (error) {
    console.warn("[ConversationArchive] 讀取失敗:", error);
    return [];
  }
}

function getKnownIds(): Set<string> {
  if (!knownIds) knownIds = new Set(loadConversationArchive().map((entry) => entry.id));
  return knownIds;
}

/** 同步追加，確保模型回覆流程之後即使崩潰，原話也已經落盤。 */
export function appendConversationEntry(input: AppendArchiveEntryInput): ConversationArchiveEntry | null {
  const content = input.content;
  if (!input.sessionId || !content.trim()) return null;
  const id = stableId(input);
  if (getKnownIds().has(id)) {
    return loadConversationArchive().find((entry) => entry.id === id) ?? null;
  }
  const entry: ConversationArchiveEntry = {
    id,
    sessionId: input.sessionId,
    channel: input.channel || inferChannel(input.sessionId),
    role: input.role,
    kind: input.kind === "image_memory" ? "image_memory" : "message",
    content,
    at: input.at ?? Date.now(),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
  };
  try {
    fs.mkdirSync(archiveDir(), { recursive: true });
    fs.appendFileSync(getConversationArchivePath(), JSON.stringify(entry) + "\n", "utf8");
    getKnownIds().add(id);
    return entry;
  } catch (error) {
    console.error("[ConversationArchive] 寫入失敗:", error);
    return null;
  }
}

export function appendConversationTurn(input: {
  sessionId: string;
  channel?: string;
  userText: string;
  assistantText: string;
  at?: number;
  turnId?: string;
}): ConversationArchiveEntry[] {
  const at = input.at ?? Date.now();
  const turnId = input.turnId ?? randomUUID();
  return [
    appendConversationEntry({
      id: `${turnId}:user`, sessionId: input.sessionId, channel: input.channel,
      role: "user", content: input.userText, at,
    }),
    appendConversationEntry({
      id: `${turnId}:assistant`, sessionId: input.sessionId, channel: input.channel,
      role: "assistant", content: input.assistantText, at: at + 1,
    }),
  ].filter((entry): entry is ConversationArchiveEntry => entry !== null);
}

function queryTerms(query: string): string[] {
  const normalized = query.toLocaleLowerCase().replace(/\s+/g, "").trim();
  if (!normalized) return [];
  const terms = new Set<string>();
  for (const token of query.toLocaleLowerCase().match(/[a-z0-9_\-]{2,}|[\u3400-\u9fff]+/g) ?? []) {
    if (/^[\u3400-\u9fff]+$/.test(token)) {
      if (token.length <= 3) terms.add(token);
      for (let i = 0; i < token.length - 1; i++) terms.add(token.slice(i, i + 2));
      for (let i = 0; i < token.length - 2; i++) terms.add(token.slice(i, i + 3));
    } else {
      terms.add(token);
    }
  }
  return [...terms].filter((term) => !/^(還記|記得|之前|以前|上次|我說|什麼|那個)$/.test(term));
}

/** 無 embedding 時仍可從永久檔案精確/詞彙召回。 */
export function searchConversationArchive(
  query: string,
  topK = 8,
  options?: { sessionId?: string; role?: ConversationRole },
): Array<ConversationArchiveEntry & { score: number }> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const full = query.toLocaleLowerCase().replace(/\s+/g, "").trim();
  const now = Date.now();
  return loadConversationArchive()
    .filter((entry) => !options?.role || entry.role === options.role)
    .map((entry) => {
      const text = entry.content.toLocaleLowerCase().replace(/\s+/g, "");
      let score = full.length >= 2 && text.includes(full) ? 20 : 0;
      for (const term of terms) {
        if (text.includes(term)) score += term.length >= 3 ? 3 : 1;
      }
      if (options?.sessionId && entry.sessionId === options.sessionId) score += 2;
      const ageDays = Math.max(0, (now - entry.at) / 86_400_000);
      score += Math.max(0, 1 - ageDays / 365);
      return { ...entry, score };
    })
    .filter((entry) => entry.score > 1)
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, Math.max(1, topK));
}

function getIndexedIds(): Set<string> {
  if (indexedIds) return indexedIds;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexedPath(), "utf8"));
    indexedIds = new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    indexedIds = new Set();
  }
  return indexedIds;
}

export function getUnindexedConversationEntries(): ConversationArchiveEntry[] {
  const indexed = getIndexedIds();
  return loadConversationArchive().filter((entry) => !indexed.has(entry.id));
}

export function markConversationEntriesIndexed(ids: string[]): void {
  if (ids.length === 0) return;
  const indexed = getIndexedIds();
  for (const id of ids) indexed.add(id);
  try {
    fs.mkdirSync(archiveDir(), { recursive: true });
    const tmp = indexedPath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify([...indexed]), "utf8");
    fs.renameSync(tmp, indexedPath());
  } catch (error) {
    console.warn("[ConversationArchive] 索引狀態寫入失敗:", error);
  }
}

/** 測試/資料目錄切換時清掉模組快取。 */
export function resetConversationArchiveCache(): void {
  knownIds = null;
  indexedIds = null;
}
