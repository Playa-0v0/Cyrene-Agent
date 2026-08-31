import "../ui/base.css";
import "./tasks.css";
import "../ui/theme";
import { getSchedulePanelItems, type ScheduledTask } from "./task-filter";

// ── 类型（后端契约） ──────────────────────────────────────────
interface TokenDayData {
  date: string;       // "06-24"
  weekday: string;   // "周三"
  input: number;
  output: number;
  hit: number;
  miss: number;
  requests: number;
  cacheUsageRequests: number;
}

// ── preload 桥接（全部由共享 preload 暴露） ─────────────────
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

// 安全兜底：preload 未注入时不崩
if (!window.tasks) {
  (window as unknown as { tasks: { minimize: () => void; close: () => void } }).tasks = {
    minimize: () => {},
    close: () => {},
  };
}

// ── 常量 ──────────────────────────────────────────────────────
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const CHART_HEIGHT_PX = 76;          // mini-chart 可用柱高（与 settings 页一致）
const MIN_BAR_PX = 6;                 // 无数据柱最低高度，避免完全消失
const TASK_REFRESH_MS = 30_000;       // 任务列表轮询
const TOKEN_REFRESH_MS = 60_000;      // token 用量轮询

// ── DOM ───────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const minBtn = $("min-btn") as HTMLButtonElement;
const closeBtn = $("close-btn") as HTMLButtonElement;
const settingsBtn = $("settings-btn") as HTMLButtonElement;

minBtn?.addEventListener("click", () => window.tasks?.minimize());
closeBtn?.addEventListener("click", () => window.tasks?.close());
settingsBtn?.addEventListener("click", () => window.sidebar?.openSettings("tasks"));

// ── 工具函数 ──────────────────────────────────────────────────
/** 生成 YYYY-MM-DD（本地时区），用作数据键 */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** token 数字短格式：1240 -> 1.2K */
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
  el.innerHTML = `<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-2px; margin-right:2px"><path d="M5 19H43V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V19Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M5 9C5 7.89543 5.89543 7 7 7H41C42.1046 7 43 7.89543 43 9V19H5V9Z" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M16 4V12" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 4V12" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M28 34H34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 34H20" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M28 26H34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 26H20" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · ${WEEKDAYS[now.getDay()]}`;
}

// ── 渲染：今日 Token 用量 + 进度条（拉满+电流感） ────────────
function renderTodayUsage(data7: TokenDayData[]): void {
  const todayKey = dateKey(new Date()).slice(5); // "06-24"
  const today = data7.find(d => d.date === todayKey);
  const todayTotal = (today?.input ?? 0) + (today?.output ?? 0);

  const numEl = $("usage-number");
  if (numEl) numEl.textContent = formatThousands(todayTotal);

  // 缓存命中 = hit / (hit + miss)。仅当厂商返回过缓存明细（cacheUsageRequests > 0）才展示，
  // 避免对不支持缓存的厂商显示误导性的 0%。
  const cacheEl = $("usage-cache");
  if (cacheEl) {
    const hit = today?.hit ?? 0;
    const cacheTotal = hit + (today?.miss ?? 0);
    if (cacheTotal > 0 && (today?.cacheUsageRequests ?? 0) > 0) {
      const rate = Math.round((hit / cacheTotal) * 100);
      cacheEl.textContent = `缓存命中 ${rate}% · ${formatTokenShort(hit)} tokens`;
      cacheEl.hidden = false;
    } else {
      cacheEl.hidden = true;
    }
  }
}

// ── 渲染：7 天柱状图（周日起算，今日之后留空柱） ────────────
function renderWeeklyBars(data7: TokenDayData[]): void {
  const container = $("mini-chart__bars");
  if (!container) return;
  container.innerHTML = "";

  const now = new Date();
  const todayDow = now.getDay(); // 0=周日 ... 6=周六
  const weekSunday = new Date(now);
  weekSunday.setDate(now.getDate() - todayDow); // 本周日

  // 按日期键建索引：06-24 -> TokenDayData
  const byDate = new Map<string, TokenDayData>();
  for (const d of data7) byDate.set(d.date, d);

  // 本周 7 天（周日→周六），收集已有数据
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

  // 峰值（仅在已发生的天里找）
  const pastSlots = weekSlots.filter(s => !s.isFuture);
  const maxVal = Math.max(...pastSlots.map(s => s.total ?? 0), 1);
  // 直接拿到峰值 slot 对象，避免跨数组下标比较出错
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

  // 日均（仅已发生天）+ 峰值说明
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
    noteEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-2px"><title>Token</title><path d="M4 42H44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><rect x="8" y="28" width="6" height="14" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><rect x="21" y="18" width="6" height="24" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><rect x="34" y="6" width="6" height="36" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg> 本周 Token 消耗趋势 ｜ 峰值 ${formatTokenShort(peakSlot.total ?? 0)}（${peakSlot.weekday}）`;
  }
}

// ── 渲染：今日定时任务列表 ────────────────────────────────────
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
    empty.textContent = "暂无已启用定时任务";
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

// ── 数据拉取 ──────────────────────────────────────────────────
async function fetchTokenData(): Promise<TokenDayData[]> {
  try {
    // IPC 返回 { days, models } 报表对象；tasks 页只用 days 数组
    const report = await window.tokenUsage?.get(7);
    return Array.isArray(report?.days) ? report.days : [];
  } catch (err) {
    console.warn("[tasks] 拉取 Token 用量失败:", err);
    return [];
  }
}

async function fetchTasks(): Promise<ScheduledTask[]> {
  try {
    const res = await window.cyreneScheduler?.list();
    if (res?.ok && Array.isArray(res.value)) return res.value;
    return [];
  } catch (err) {
    console.warn("[tasks] 拉取定时任务失败:", err);
    return [];
  }
}

// ── 刷新（节流合并） ──────────────────────────────────────────
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

// ── 启动 ──────────────────────────────────────────────────────
function init(): void {
  renderDate();
  void refreshAll();

  // 轮询：任务列表每 30s，token 每 60s
  setInterval(() => void fetchTasks().then(renderTasks), TASK_REFRESH_MS);
  setInterval(() => {
    void fetchTokenData().then(data => {
      renderTodayUsage(data);
      renderWeeklyBars(data);
    });
  }, TOKEN_REFRESH_MS);

  // 事件驱动：scheduler 触发后立即刷新（用量和任务都会变）
  window.schedulerEvents?.onEvent((_event) => {
    void refreshAll();
  });

  // 任务增删改后立即刷新（不再等 30s 轮询）
  window.tasks?.onSchedulerChanged?.(() => {
    void refreshAll();
  });
}

init();
