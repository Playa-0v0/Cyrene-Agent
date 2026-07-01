// 采集用户状态向量。用 Electron powerMonitor.getSystemIdleTime() 同时覆盖键+鼠空闲。
// 上次对话时间从 chats-store listSessions 拿。
import { powerMonitor } from "electron";
import { listSessions } from "../chats/chats-store";
import type { UserStateSnapshot } from "./opener-types";

const IDLE_ACTIVE_THRESHOLD_SEC = 60;   // idle < 60s 算"活跃"
const AWAY_THRESHOLD_SEC = 1800;        // idle > 30min 算"离开"

let keyboardAccumMin = 0;               // 非空闲累计分钟（内存，重启归零可接受）
let lastIdleSec = 0;                    // 上次 tick 的 idle，用于检测"离开→恢复"事件

/**
 * 采集当前状态快照。每 tick 调一次。
 * mouseResumeEvent=true 表示刚刚发生"空闲>30min 后恢复活动"（事件打断直通车用）。
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
    // 离开过久，活跃累计衰减
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

/** 供测试注入的 setter（重置内部累加器）。 */
export function _resetForTest(): void {
  keyboardAccumMin = 0;
  lastIdleSec = 0;
}
