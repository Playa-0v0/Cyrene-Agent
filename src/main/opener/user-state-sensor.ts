// 採集用戶狀態向量。用 Electron powerMonitor.getSystemIdleTime() 同時覆蓋鍵+鼠空閒。
// 上次對話時間從 chats-store listSessions 拿。
import { powerMonitor } from "electron";
import { listSessions } from "../chats/chats-store";
import type { UserStateSnapshot } from "./opener-types";

const IDLE_ACTIVE_THRESHOLD_SEC = 60;   // idle < 60s 算"活躍"
const AWAY_THRESHOLD_SEC = 1800;        // idle > 30min 算"離開"

let keyboardAccumMin = 0;               // 非空閒累計分鐘（內存，重啟歸零可接受）
let lastIdleSec = 0;                    // 上次 tick 的 idle，用於檢測"離開→恢復"事件

/**
 * 採集當前狀態快照。每 tick 調一次。
 * mouseResumeEvent=true 表示剛剛發生"空閒>30min 後恢復活動"（事件打斷直通車用）。
 */
export function snapshot(): UserStateSnapshot {
  const idleSec = powerMonitor.getSystemIdleTime();
  const now = Date.now();
  const hour = new Date(now).getHours();

  const mouseResumeEvent = lastIdleSec >= AWAY_THRESHOLD_SEC && idleSec < IDLE_ACTIVE_THRESHOLD_SEC;
  lastIdleSec = idleSec;

  if (idleSec < IDLE_ACTIVE_THRESHOLD_SEC) {
    keyboardAccumMin += 1;
  } else {
    // 離開過久，活躍累計衰減
    keyboardAccumMin = Math.max(0, keyboardAccumMin - 1);
  }

  let lastChatAgoMs = Infinity;
  try {
    const sessions = listSessions();
    if (sessions.length > 0 && typeof sessions[0].updatedAt === "number") {
      lastChatAgoMs = now - sessions[0].updatedAt;
    }
  } catch { /* chats-store 未初始化 */ }

  return {
    hour,
    idleSec,
    mouseResumeEvent,
    lastChatAgoMs,
    keyboardAccumMin,
  };
}

/** 供測試注入的 setter（重置內部累加器）。 */
export function _resetForTest(): void {
  keyboardAccumMin = 0;
  lastIdleSec = 0;
}
