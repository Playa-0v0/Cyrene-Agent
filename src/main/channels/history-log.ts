// channels/history-log —— 渠道側每個 sender 的對話歷史 (滑窗用).
//
// 每個 sessionId 對應 userData/channels/history/<sessionId>.jsonl
// 啟動時把整個文件讀進內存, append 時只追加. 文件按 MAX_LINES 截斷防膨脹.
//
// 數據流:
//   dispatcher.handleIncoming 入站/出站 → appendHistory(senderSessionId, role, content)
//   dispatcher.handleIncoming 下一輪進 → loadRecentHistory(senderSessionId, 16) 拉最近 16 條
//
// 跟 message-log 的區別:
//   message-log 是"運營可見"的人類可讀日誌 (UI 顯示給人看)
//   history-log 是 agent 喂的"對話上下文", LLM 需要, 機器格式
//
// 跟 RAG 索引 (indexConversationTurn) 的區別:
//   RAG 是語義檢索 (cosine similarity), 長期持久
//   history-log 是精確窗口 (sliding window), 短期明確
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

const LOG = "[ChannelHistory]";

/** 一條消息: 誰說的 + 內容 + 時間戳 ISO */
export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  at: string;
}

const MAX_FILE_LINES = 200; // 最近 200 條, 遠大於滑動窗口 16

function dir(): string {
  return path.join(app.getPath("userData"), "channels", "history");
}

/** sessionId 可能不安全做文件名, 用 sha256 hex 兜底. dispatcher 給的已是 hash+prefix 形式也 OK. */
function safeName(sessionId: string): string {
  // dispatcher 的 sessionId 形如 "channel:feishu:e72a9d...", 替換 : 為 _ 即可
  return sessionId.replace(/[:/\\<>:"|?*]/g, "_");
}

function filePath(sessionId: string): string {
  return path.join(dir(), `${safeName(sessionId)}.jsonl`);
}

/** 追加一條. role 只能是 user/assistant (dispatcher 內部強制). */
export function appendHistory(sessionId: string, role: "user" | "assistant", content: string): void {
  if (!sessionId || !content) return;
  const entry: HistoryEntry = { role, content, at: new Date().toISOString() };
  const fp = filePath(sessionId);
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(fp, JSON.stringify(entry) + "\n", "utf8");
    // 文件過大時截斷 (只留最後 MAX_FILE_LINES 行)
    const buf = fs.readFileSync(fp, "utf8");
    const lines = buf.split("\n");
    if (lines.length > MAX_FILE_LINES + 1) {
      const trimmed = lines.slice(lines.length - MAX_FILE_LINES).join("\n");
      fs.writeFileSync(fp, trimmed.endsWith("\n") ? trimmed : trimmed + "\n", "utf8");
    }
  } catch (err) {
    console.warn(LOG, "appendHistory 失敗:", sessionId, err instanceof Error ? err.message : err);
  }
}

/** 讀最近 N 條歷史, 按時間順序 (舊 → 新). */
export function loadRecentHistory(sessionId: string, limit: number): HistoryEntry[] {
  if (!sessionId || limit <= 0) return [];
  const fp = filePath(sessionId);
  if (!fs.existsSync(fp)) return [];
  try {
    const buf = fs.readFileSync(fp, "utf8");
    const lines = buf.split("\n").filter((l) => l.length > 0);
    const parsed: HistoryEntry[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as HistoryEntry;
        if (e && (e.role === "user" || e.role === "assistant") && typeof e.content === "string") {
          parsed.push(e);
        }
      } catch {
        /* skip bad line */
      }
    }
    // 取尾部 limit 條
    const sliced = parsed.slice(-limit);
    return sliced;
  } catch (err) {
    console.warn(LOG, "loadRecentHistory 失敗:", sessionId, err instanceof Error ? err.message : err);
    return [];
  }
}

/** 啟動時所有 session 文件預讀 (可選, dispatcher 用不到, 給將來 Phase 4 調試 UI 留接口). */
export function reloadAllHistory(): Map<string, HistoryEntry[]> {
  const out = new Map<string, HistoryEntry[]>();
  try {
    fs.mkdirSync(dir(), { recursive: true });
    for (const name of fs.readdirSync(dir())) {
      if (!name.endsWith(".jsonl")) continue;
      const sid = name.replace(/\.jsonl$/, "").replace(/_/g, ":");
      // 不嘗試反推回原 sessionId, 這裡只是佔位接口, Phase 4 可優化
      out.set(sid, loadRecentHistory(sid, MAX_FILE_LINES));
    }
  } catch {
    /* ignore */
  }
  return out;
}