// channels/message-log —— JSONL 落盘 + 内存最近 N 条，给 UI 提供消息日志查看。
//
// 数据流：
//   dispatcher 处理完入站/出站后 → appendLog(incoming) / appendLog(outgoing)
//   → 写入 userData/channels/log.jsonl (一行一 JSON)
//   → 同时维护内存 lastN 数组（默认 200 条）
//
// 读：
//   getRecentLog(limit) → 最近 N 条倒序
//   clearLog() → 清磁盘 + 内存
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

const LOG = "[ChannelLog]";

export interface LogEntry {
  /** ISO 时间戳 */
  at: string;
  /** "incoming" | "outgoing" | "error"（agent 调用/发送失败，打包版排障用） */
  dir: "incoming" | "outgoing" | "error";
  channel: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  text: string;
  /** 是否有附件（不进 JSONL，只记布尔） */
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

/** 追加一条日志。失败不影响主流程。 */
export function appendLog(entry: Omit<LogEntry, "at">): void {
  const full: LogEntry = { at: new Date().toISOString(), ...entry };
  inMemory.push(full);
  if (inMemory.length > MAX_INMEM) {
    inMemory.splice(0, inMemory.length - MAX_INMEM);
  }
  try {
    ensureDir();
    fs.appendFileSync(filePath(), JSON.stringify(full) + "\n", "utf8");
    // 简单截断：超过 MAX_FILE_LINES 行就丢掉最老的
    const buf = fs.readFileSync(filePath(), "utf8");
    const lines = buf.split("\n");
    if (lines.length > MAX_FILE_LINES) {
      const trimmed = lines.slice(lines.length - MAX_FILE_LINES).join("\n");
      fs.writeFileSync(filePath(), trimmed + "\n", "utf8");
    }
  } catch (err) {
    console.warn(LOG, "写日志失败:", err instanceof Error ? err.message : err);
  }
}

/** 读最近 N 条（最新在前）。 */
export function getRecentLog(limit = 100): LogEntry[] {
  const n = Math.max(1, Math.min(MAX_INMEM, limit));
  if (inMemory.length > 0) {
    return [...inMemory].slice(-n).reverse();
  }
  // 内存空（刚启动）→ 从磁盘读
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

/** 清空日志（磁盘 + 内存）。 */
export function clearLog(): void {
  inMemory.length = 0;
  try {
    fs.unlinkSync(filePath());
  } catch {
    /* ignore */
  }
}

/** 启动时从磁盘 reload 到内存（避免重启后内存里没有历史）。 */
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
      console.warn(LOG, "从磁盘 reload 失败:", err.message);
    }
  }
}