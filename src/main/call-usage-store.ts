// 每日通話時間持久化存儲
//
// 存儲位置：<userData>/call-usage.json
// 「totalMs」按實際陪伴通話時間計算；桌面與 Discord 同時通話時不重複計時。
// 活躍通話每 15 秒做一次檢查點，意外退出時不會把離線時間誤算進去。

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export type CallUsageSource = "desktop" | "discord";

export interface CallUsageDay {
  totalMs: number;
  desktopMs: number;
  discordMs: number;
}

interface CallUsageStore {
  schemaVersion: 1;
  days: Record<string, CallUsageDay>;
  activeSources: Partial<Record<CallUsageSource, true>>;
  lastCheckpointAt: number | null;
}

export interface CallUsageEntry extends CallUsageDay {
  date: string;
  weekday: string;
  active: boolean;
}

const CHECKPOINT_MS = 15_000;
let cache: CallUsageStore | null = null;
let checkpointTimer: ReturnType<typeof setInterval> | null = null;

function emptyStore(): CallUsageStore {
  return { schemaVersion: 1, days: {}, activeSources: {}, lastCheckpointAt: null };
}

function getFilePath(): string {
  return path.join(app.getPath("userData"), "call-usage.json");
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 將一段時間依本機午夜切開；日程頁以使用者所在時區顯示每日統計。 */
export function splitCallIntervalByLocalDay(startMs: number, endMs: number): Array<{ date: string; durationMs: number }> {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const result: Array<{ date: string; durationMs: number }> = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const current = new Date(cursor);
    const nextMidnight = new Date(current);
    nextMidnight.setHours(24, 0, 0, 0);
    const segmentEnd = Math.min(endMs, nextMidnight.getTime());
    result.push({ date: localDateKey(current), durationMs: segmentEnd - cursor });
    cursor = segmentEnd;
  }
  return result;
}

function loadFromDisk(): CallUsageStore {
  try {
    const filePath = getFilePath();
    if (!fs.existsSync(filePath)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CallUsageStore>;
    const store: CallUsageStore = {
      schemaVersion: 1,
      days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
      activeSources: {},
      lastCheckpointAt: null,
    };
    // 上次若非正常退出，已落盤的檢查點仍保留；不延伸計算離線時段。
    if (Object.keys(parsed.activeSources ?? {}).length > 0) {
      queueMicrotask(() => flushNow());
    }
    return store;
  } catch (error) {
    console.warn("[call-usage] 加載失敗，重置為空:", error);
    return emptyStore();
  }
}

function ensureLoaded(): CallUsageStore {
  cache ??= loadFromDisk();
  return cache;
}

function flushNow(): void {
  if (!cache) return;
  try {
    const filePath = getFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    console.warn("[call-usage] 落盤失敗:", error);
  }
}

function activeSources(store: CallUsageStore): CallUsageSource[] {
  return (["desktop", "discord"] as const).filter((source) => store.activeSources[source]);
}

function addInterval(store: CallUsageStore, startMs: number, endMs: number, sources: CallUsageSource[]): void {
  if (sources.length === 0) return;
  for (const segment of splitCallIntervalByLocalDay(startMs, endMs)) {
    const day = store.days[segment.date] ?? { totalMs: 0, desktopMs: 0, discordMs: 0 };
    day.totalMs += segment.durationMs;
    if (sources.includes("desktop")) day.desktopMs += segment.durationMs;
    if (sources.includes("discord")) day.discordMs += segment.durationMs;
    store.days[segment.date] = day;
  }
}

function checkpoint(now = Date.now()): void {
  const store = ensureLoaded();
  const sources = activeSources(store);
  if (sources.length === 0 || store.lastCheckpointAt === null) return;
  if (now <= store.lastCheckpointAt) return;
  addInterval(store, store.lastCheckpointAt, now, sources);
  store.lastCheckpointAt = now;
}

function updateCheckpointTimer(): void {
  const store = ensureLoaded();
  if (activeSources(store).length > 0 && !checkpointTimer) {
    checkpointTimer = setInterval(() => {
      checkpoint();
      flushNow();
    }, CHECKPOINT_MS);
    checkpointTimer.unref?.();
  } else if (activeSources(store).length === 0 && checkpointTimer) {
    clearInterval(checkpointTimer);
    checkpointTimer = null;
  }
}

export function startCallUsage(source: CallUsageSource, now = Date.now()): void {
  const store = ensureLoaded();
  if (store.activeSources[source]) return;
  checkpoint(now);
  store.activeSources[source] = true;
  store.lastCheckpointAt ??= now;
  updateCheckpointTimer();
  flushNow();
}

export function stopCallUsage(source: CallUsageSource, now = Date.now()): void {
  const store = ensureLoaded();
  if (!store.activeSources[source]) return;
  checkpoint(now);
  delete store.activeSources[source];
  if (activeSources(store).length === 0) store.lastCheckpointAt = null;
  updateCheckpointTimer();
  flushNow();
}

export function getCallUsage(days: number, now = Date.now()): CallUsageEntry[] {
  checkpoint(now);
  const store = ensureLoaded();
  const count = Math.max(1, Math.min(90, Math.floor(days) || 7));
  const weekdays = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
  const result: CallUsageEntry[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const day = store.days[localDateKey(date)] ?? { totalMs: 0, desktopMs: 0, discordMs: 0 };
    result.push({
      date: `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
      weekday: weekdays[date.getDay()],
      active: i === 0 && activeSources(store).length > 0,
      ...day,
    });
  }
  return result;
}

export function flushCallUsage(now = Date.now()): void {
  checkpoint(now);
  flushNow();
}
