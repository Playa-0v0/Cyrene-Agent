import "../ui/base.css";
import "./tasks.css";
import "../ui/theme";
import { getSchedulePanelItems, type ScheduledTask } from "./task-filter";

// ── 類型（後端契約） ──────────────────────────────────────────
interface TokenDayData {
  date: string;       // "06-24"
  weekday: string;   // "週三"
  input: number;
  output: number;
  hit: number;
  miss: number;
  requests: number;
}

// ── preload 橋接（全部由共享 preload 暴露） ─────────────────
declare global {
  interface Window {
    tasks?: { minimize: () => void; close: () => void };
    tokenUsage?: { get: (days: number) => Promise<TokenDayData[]> };
    cyreneScheduler?: { list: () => Promise<{ ok: boolean; value?: ScheduledTask[]; error?: string }> };
    schedulerEvents?: { onEvent: (cb: (event: unknown) => void) => () => void };
    tasks?: { onSchedulerChanged?: (callback: () => void) => () => void };
    sidebar?: { openSettings: (section?: string) => void };
  }
}

// 安全兜底：preload 未注入時不崩
if (!window.tasks) {
  (window as unknown as { tasks: { minimize: () => void; close: () => void } }).tasks = {
    minimize: () => {},
    close: () => {},
  };
}

// ── 常量 ──────────────────────────────────────────────────────
const WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
const CHART_HEIGHT_PX = 76;          // mini-chart 可用柱高（與 settings 頁一致）
const MIN_BAR_PX = 6;                 // 無數據柱最低高度，避免完全消失
const TASK_REFRESH_MS = 30_000;       // 任務列表輪詢
const TOKEN_REFRESH_MS = 60_000;      // token 用量輪詢

// ── DOM ───────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const minBtn = $("min-btn") as HTMLButtonElement;
const closeBtn = $("close-btn") as HTMLButtonElement;
const settingsBtn = $("settings-btn") as HTMLButtonElement;

minBtn?.addEventListener("click", () => window.tasks?.minimize());
closeBtn?.addEventListener("click", () => window.tasks?.close());
settingsBtn?.addEventListener("click", () => window.sidebar?.openSettings("tasks"));

// ── 工具函數 ──────────────────────────────────────────────────
/** 生成 YYYY-MM-DD（本地時區），用作數據鍵 */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** token 數字短格式：1240 -> 1.2K */
function formatTokenShort(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(Math.round(n));
}

/** 千分位格式：1280 -> 1,280 */
function formatThousands(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// ── 渲染：日期 ────────────────────────────────────────────────
function renderDate(): void {
  const now = new Date();
  const el = $("schedule-date");
  if (!el) return;
  el.textContent = `📅 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · ${WEEKDAYS[now.getDay()]}`;
}

// ── 渲染：今日 Token 用量 + 進度條（拉滿+電流感） ────────────
function renderTodayUsage(data7: TokenDayData[]): void {
  const todayKey = dateKey(new Date()).slice(5); // "06-24"
  const today = data7.find(d => d.date === todayKey);
  const todayTotal = (today?.input ?? 0) + (today?.output ?? 0);

  const numEl = $("usage-number");
  if (numEl) numEl.textContent = formatThousands(todayTotal);

  // 進度條永遠拉滿（無預算概念），電流感由 CSS 動畫驅動
  const fill = $("usage-bar__fill");
  if (fill) fill.style.width = "100%";
}

// ── 渲染：7 天柱狀圖（週日起算，今日之後留空柱） ────────────
function renderWeeklyBars(data7: TokenDayData[]): void {
  const container = $("mini-chart__bars");
  if (!container) return;
  container.innerHTML = "";

  const now = new Date();
  const todayDow = now.getDay(); // 0=週日 ... 6=週六
  const weekSunday = new Date(now);
  weekSunday.setDate(now.getDate() - todayDow); // 本週日

  // 按日期鍵建索引：06-24 -> TokenDayData
  const byDate = new Map<string, TokenDayData>();
  for (const d of data7) byDate.set(d.date, d);

  // 本週 7 天（週日→週六），收集已有數據
  const weekSlots: Array<{ date: string; weekday: string; total: number | null; isToday: boolean; isFuture: boolean }> = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(weekSunday);
    day.setDate(weekSunday.getDate() + i);
    const key = `${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const data = byDate.get(key);
    const isToday = i === todayDow;
    const isFuture = i > todayDow;
    weekSlots.push({
      date: key,
      weekday: WEEKDAYS[day.getDay()],
      total: data && !isFuture ? (data.input + data.output) : (isFuture ? null : 0),
      isToday,
      isFuture,
    });
  }

  // 峰值（僅在已發生的天裡找）
  const pastSlots = weekSlots.filter(s => !s.isFuture);
  const maxVal = Math.max(...pastSlots.map(s => s.total ?? 0), 1);
  // 直接拿到峰值 slot 對象，避免跨數組下標比較出錯
  let peakSlot: typeof weekSlots[number] | null = null;
  for (const s of pastSlots) {
    if (!peakSlot || (s.total ?? 0) > (peakSlot.total ?? 0)) peakSlot = s;
  }

  for (const slot of weekSlots) {
    const bar = document.createElement("div");
    bar.className = "chart-bar";

    if (slot.isFuture) {
      bar.classList.add("chart-bar--future");
    } else {
      bar.classList.add("chart-bar--has");
      const total = slot.total ?? 0;
      const barH = Math.max(MIN_BAR_PX, Math.round((total / maxVal) * CHART_HEIGHT_PX));
      const fill = document.createElement("div");
      fill.className = "chart-bar__fill";
      fill.style.height = barH + "px";
      bar.appendChild(fill);
    }

    const label = document.createElement("span");
    label.textContent = slot.weekday;
    bar.appendChild(label);

    container.appendChild(bar);
  }

  // 日均（僅已發生天）+ 峰值說明
  const avgEl = $("mini-chart__avg");
  const noteEl = $("schedule-note");
  const pastTotals = pastSlots.map(s => s.total ?? 0);
  const sum = pastTotals.reduce((a, b) => a + b, 0);
  const avg = pastSlots.length ? Math.round(sum / pastSlots.length) : 0;
  if (avgEl) {
    const span = avgEl.querySelector("span");
    if (span) span.textContent = `日均 ${formatTokenShort(avg)}`;
  }
  if (noteEl && peakSlot) {
    noteEl.textContent = `📊 本週 Token 消耗趨勢 ｜ 峰值 ${formatTokenShort(peakSlot.total ?? 0)}（${peakSlot.weekday}）`;
  }
}

// ── 渲染：今日定時任務列表 ────────────────────────────────────
function renderTasks(tasks: ScheduledTask[]): void {
  const listEl = $("task-list");
  const countEl = $("schedule-count");
  if (!listEl) return;

  const panelItems = getSchedulePanelItems(tasks);

  if (countEl) countEl.textContent = String(panelItems.totalCount);

  listEl.innerHTML = "";
  if (panelItems.items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "task-empty";
    empty.textContent = "暫無已啟用定時任務";
    listEl.appendChild(empty);
    return;
  }

  for (const task of panelItems.items) {
    const item = document.createElement("div");
    item.className = "task-item";

    const fire = new Date(task.nextFireAt!);
    const hh = String(fire.getHours()).padStart(2, "0");
    const mm = String(fire.getMinutes()).padStart(2, "0");
    const showDate = panelItems.mode === "upcoming" || task.schedule.kind === "once";
    const timeText = showDate
      ? `${String(fire.getMonth() + 1).padStart(2, "0")}-${String(fire.getDate()).padStart(2, "0")} ${hh}:${mm}`
      : `${hh}:${mm}`;

    const time = document.createElement("div");
    time.className = "task-time";
    time.textContent = timeText;

    const desc = document.createElement("div");
    desc.className = "task-desc";
    desc.textContent = task.title;

    item.appendChild(time);
    item.appendChild(desc);
    listEl.appendChild(item);
  }
}

// ── 數據拉取 ──────────────────────────────────────────────────
async function fetchTokenData(): Promise<TokenDayData[]> {
  try {
    return (await window.tokenUsage?.get(7)) ?? [];
  } catch (err) {
    console.warn("[tasks] 拉取 Token 用量失敗:", err);
    return [];
  }
}

async function fetchTasks(): Promise<ScheduledTask[]> {
  try {
    const res = await window.cyreneScheduler?.list();
    if (res?.ok && Array.isArray(res.value)) return res.value;
    return [];
  } catch (err) {
    console.warn("[tasks] 拉取定時任務失敗:", err);
    return [];
  }
}

// ── 刷新（節流合併） ──────────────────────────────────────────
let refreshPending = false;
async function refreshAll(): Promise<void> {
  if (refreshPending) return;
  refreshPending = true;
  try {
    const [data7, tasks] = await Promise.all([fetchTokenData(), fetchTasks()]);
    renderTodayUsage(data7);
    renderWeeklyBars(data7);
    renderTasks(tasks);
  } finally {
    refreshPending = false;
  }
}

// ── 啟動 ──────────────────────────────────────────────────────
function init(): void {
  renderDate();
  void refreshAll();

  // 輪詢：任務列表每 30s，token 每 60s
  setInterval(() => void fetchTasks().then(renderTasks), TASK_REFRESH_MS);
  setInterval(() => {
    void fetchTokenData().then(data => {
      renderTodayUsage(data);
      renderWeeklyBars(data);
    });
  }, TOKEN_REFRESH_MS);

  // 事件驅動：scheduler 觸發後立即刷新（用量和任務都會變）
  window.schedulerEvents?.onEvent((_event) => {
    void refreshAll();
  });

  // 任務增刪改後立即刷新（不再等 30s 輪詢）
  window.tasks?.onSchedulerChanged?.(() => {
    void refreshAll();
  });
}

init();

if (window.self !== window.top) {
  document.body.classList.add("is-embedded");
}
