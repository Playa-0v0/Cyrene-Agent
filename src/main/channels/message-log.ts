// channels/message-log —— JSONL 落盤 + 內存最近 N 條，給 UI 提供消息日誌查看。
//
// 數據流：
//   dispatcher 處理完入站/出站後 → appendLog(incoming) / appendLog(outgoing)
//   → 寫入 userData/channels/log.jsonl (一行一 JSON)
//   → 同時維護內存 lastN 數組（默認 200 條）
//
// 讀：
//   getRecentLog(limit) → 最近 N 條倒序
//   clearLog() → 清磁盤 + 內存
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

const LOG = "[ChannelLog]";

export interface LogEntry {
  /** ISO 時間戳 */
  at: string;
  /** "incoming" | "outgoing" */
  dir: "incoming" | "outgoing";
  channel: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  text: string;
  /** 是否有附件（不進 JSONL，只記布爾） */
  hasAttachments?: boolean;
}

const MAX_FILE_LINES = 1000;
const MAX_INMEM = 200;

const inMemory: LogEntry[] = [];

function filePath(): string {
  return path.join(app.getPath("userData"), "channels", "log.jsonl");
}

function ensureDir(): void {
  const dir = path.dirname(filePath());
  fs.mkdirSync(dir, { recursive: true });
}

/** 追加一條日誌。失敗不影響主流程。 */
export function appendLog(entry: Omit<LogEntry, "at">): void {
  const full: LogEntry = { at: new Date().toISOString(), ...entry };
  inMemory.push(full);
  if (inMemory.length > MAX_INMEM) {
    inMemory.splice(0, inMemory.length - MAX_INMEM);
  }
  try {
    ensureDir();
    fs.appendFileSync(filePath(), JSON.stringify(full) + "\n", "utf8");
    // 簡單截斷：超過 MAX_FILE_LINES 行就丟掉最老的
    const buf = fs.readFileSync(filePath(), "utf8");
    const lines = buf.split("\n");
    if (lines.length > MAX_FILE_LINES) {
      const trimmed = lines.slice(lines.length - MAX_FILE_LINES).join("\n");
      fs.writeFileSync(filePath(), trimmed + "\n", "utf8");
    }
  } catch (err) {
    console.warn(LOG, "寫日誌失敗:", err instanceof Error ? err.message : err);
  }
}

/** 讀最近 N 條（最新在前）。 */
export function getRecentLog(limit = 100): LogEntry[] {
  const n = Math.max(1, Math.min(MAX_INMEM, limit));
  if (inMemory.length > 0) {
    return [...inMemory].slice(-n).reverse();
  }
  // 內存空（剛啟動）→ 從磁盤讀
  try {
    const buf = fs.readFileSync(filePath(), "utf8");
    const lines = buf.split("\n").filter((l) => l.length > 0);
    const parsed: LogEntry[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as LogEntry);
      } catch {
        /* skip */
      }
    }
    return parsed.slice(-n).reverse();
  } catch {
    return [];
  }
}

/** 清空日誌（磁盤 + 內存）。 */
export function clearLog(): void {
  inMemory.length = 0;
  try {
    fs.unlinkSync(filePath());
  } catch {
    /* ignore */
  }
}

/** 啟動時從磁盤 reload 到內存（避免重啟後內存裡沒有歷史）。 */
export function reloadLogFromDisk(): void {
  try {
    const buf = fs.readFileSync(filePath(), "utf8");
    const lines = buf.split("\n").filter((l) => l.length > 0);
    const parsed: LogEntry[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as LogEntry);
      } catch {
        /* skip */
      }
    }
    inMemory.push(...parsed.slice(-MAX_INMEM));
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(LOG, "從磁盤 reload 失敗:", err.message);
    }
  }
}