// Token 用量持久化存儲
//
// 存儲位置：<userData>/token-usage.json
// 數據結構：按天 ISO 日期聚合，方便查詢任意時間段。
//
// 寫入策略：record() 立即更新內存緩存，1 秒防抖落盤（避免高頻寫）。
// 讀取策略：首次訪問時從磁盤加載到內存，後續直接讀緩存。

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface TokenUsageDay {
  input: number;
  output: number;
  hit: number;   // 緩存命中（當前佔位 0，接緩存後填）
  miss: number;  // 緩存未命中（當前佔位 0）
  requests: number;
  models?: Record<string, { input: number; output: number; requests: number }>;
}

interface TokenUsageStore {
  schemaVersion: 1;
  days: Record<string, TokenUsageDay>; // key = "2026-06-19"
}

const DEFAULT_STORE: TokenUsageStore = { schemaVersion: 1, days: {} };
const DEBOUNCE_MS = 1000;

function getFilePath(): string {
  return path.join(app.getPath("userData"), "token-usage.json");
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let cache: TokenUsageStore | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function loadFromDisk(): TokenUsageStore {
  const filePath = getFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TokenUsageStore>;
      return {
        schemaVersion: 1,
        days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
      };
    }
  } catch (err) {
    console.warn("[token-usage] 加載失敗，重置為空:", err);
  }
  return { ...DEFAULT_STORE, days: {} };
}

function ensureLoaded(): TokenUsageStore {
  if (!cache) cache = loadFromDisk();
  return cache;
}

function scheduleFlush(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushNow();
  }, DEBOUNCE_MS);
}

function flushNow(): void {
  if (!cache) return;
  const filePath = getFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 原子寫：先寫 .tmp 再 rename
  const tmpPath = filePath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.warn("[token-usage] 落盤失敗:", err);
  }
}

// ── public API ──

/** 記錄一次 API 調用的 token 用量（異步累加到當天）。 */
export function recordUsage(input: number, output: number, requests = 1, model = "未標記模型"): void {
  const store = ensureLoaded();
  const key = todayKey();
  const day = store.days[key] ?? { input: 0, output: 0, hit: 0, miss: 0, requests: 0 };
  day.input += Math.max(0, Math.round(input || 0));
  day.output += Math.max(0, Math.round(output || 0));
  day.requests += Math.max(0, requests);
  day.models ??= {};
  const modelUsage = day.models[model] ?? { input: 0, output: 0, requests: 0 };
  modelUsage.input += Math.max(0, Math.round(input || 0));
  modelUsage.output += Math.max(0, Math.round(output || 0));
  modelUsage.requests += Math.max(0, requests);
  day.models[model] = modelUsage;
  store.days[key] = day;
  scheduleFlush();
}

export function getUsageByModel(days: number): Array<{ model: string; input: number; output: number; requests: number }> {
  const store = ensureLoaded();
  const totals = new Map<string, { input: number; output: number; requests: number }>();
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - Math.max(1, days) + 1);
  for (const [date, day] of Object.entries(store.days)) {
    if (new Date(`${date}T00:00:00`).getTime() < cutoff.getTime()) continue;
    for (const [model, usage] of Object.entries(day.models ?? {})) {
      const total = totals.get(model) ?? { input: 0, output: 0, requests: 0 };
      total.input += usage.input;
      total.output += usage.output;
      total.requests += usage.requests;
      totals.set(model, total);
    }
  }
  return [...totals.entries()].map(([model, usage]) => ({ model, ...usage })).sort((a, b) => (b.input + b.output) - (a.input + a.output));
}

/** 查詢最近 N 天的用量數據，按日期升序返回（無數據的天填 0）。 */
export function getUsage(days: number): Array<{ date: string; weekday: string; input: number; output: number; hit: number; miss: number; requests: number }> {
  const store = ensureLoaded();
  const result: Array<{ date: string; weekday: string; input: number; output: number; hit: number; miss: number; requests: number }> = [];
  const weekdays = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const day = store.days[key];
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    result.push({
      date: `${mm}-${dd}`,
      weekday: weekdays[d.getDay()],
      input: day?.input ?? 0,
      output: day?.output ?? 0,
      hit: day?.hit ?? 0,
      miss: day?.miss ?? 0,
      requests: day?.requests ?? 0,
    });
  }
  return result;
}

/** 立即落盤（應用退出時調用）。 */
export function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  flushNow();
}
