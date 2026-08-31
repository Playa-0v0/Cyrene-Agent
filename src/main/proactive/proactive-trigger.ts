// 主动聊天触发器
//
// 设计目标：
// - 60s 周期扫描，调用 `proactiveChatService.evaluateCandidate({sceneId, score, sceneCooldownMs})`
// - 候选生成使用用户时区（避免被机器系统时区干扰）
// - 场景清单：第一版只实现 morning_greeting / evening_checkin / back_from_away / work_break
// - 天气场景仅保留 sceneId 占位 + 可选 getWeatherContext 注入；未实现天气候选生成
//
// 边界：
// - 不修改 proactive-service.ts / proactive-policy.ts / proactive-state-store.ts / ProactiveCandidate
// - 不实现 fallback / Function Calling / MCP / 主动刷新外部信息
// - 不新增 desire-engine / 概率门
// - 不实现天气缓存、TTL、expiresAt、跨日期判断
//
// 未来接入天气缓存时：只需让 deps.getWeatherContext 返回非空 WeatherContext，
// 并在 generateWeatherCandidates 内部加判断。本文件其它结构（定时循环、候选排序、
// evaluateCandidate 接线）无需改动。

import type {
  ProactiveCandidate,
  ProactiveRuntimeSnapshot,
  ProactiveState,
} from "./proactive-types";

/** 天气上下文。当前实现为占位；未来缓存模块接入时由该模块定义实际字段。 */
export interface WeatherContext {
  // 形状由未来缓存模块决定；当前实现不读取任何字段。
  readonly _placeholder?: never;
}

/** 候选生成需要的快照 + 用户时区信息（一次性打包，便于纯函数）。 */
export interface ProactiveTriggerContext {
  now: number;
  timezone: string;
  /** 用户时区下的"当前日期"。 */
  localDate: string;
  /** 用户时区下的当前小时（0-23）。 */
  localHour: number;
  /** 用户时区下的当前分钟（0-59）。 */
  localMinute: number;

  snapshot: ProactiveRuntimeSnapshot;
  state: ProactiveState;

  /** 上一轮 tick 时的 idleSec；首轮为 null（用于判断 back_from_away）。 */
  previousIdleSec: number | null;
  /** 用户活跃会话起始时间；idle > 60 时重置。 */
  activeSessionStartedAt: number | null;

  weather: WeatherContext | null;
}

/** 内部候选类型（额外带 reason 用于日志）。 */
interface ProactiveOpportunity {
  sceneId: string;
  score: number;
  sceneCooldownMs: number;
  reason: string;
}

export interface ProactiveTriggerDependencies {
  evaluateCandidate: (candidate: ProactiveCandidate) => Promise<unknown>;
  getRuntimeSnapshot: () => ProactiveRuntimeSnapshot;
  getProactiveState: () => ProactiveState;
  /** 已 resolver 后的有效用户时区（保证是合法 IANA）。 */
  getTimezone: () => string;
  /**
   * 可选：未来缓存模块接入时填。当前实现：未传 / 传 null / 传空对象都不生成天气候选。
   */
  getWeatherContext?: () => WeatherContext | null;
  /** 触发器内部 backoff Map（由控制器持有），用于测试断言状态。 */
  getLastEvaluatedAtByScene: () => Map<string, number>;
  setLastEvaluatedAtByScene: (next: Map<string, number>) => void;
}

export interface ProactiveTriggerController {
  start(): void;
  stop(): void;
  /** 立即跑一轮（不经过定时器）。 */
  evaluateNow(reason?: string): Promise<void>;
}

// ── 常量 ───────────────────────────────────────────────────────────────
const TRIGGER_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 90_000;
const INTERVAL_JITTER_MS = 10_000;

const EVALUATION_RETRY_MS = 30 * 60 * 1000;
const MIN_EVALUATION_SCORE = 60;

const AWAY_THRESHOLD_SEC = 30 * 60;
const ACTIVE_THRESHOLD_SEC = 60;
const WORK_BREAK_MIN_MS = 90 * 60 * 1000;

const HALF_HOUR_MS = 30 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const LOG_PREFIX = "[ProactiveTrigger]";

/** 评分夹值。 */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * 用 Intl 把日期拆成 {year, month, day, hour, minute}（按 timezone）。
 * 不依赖 toLocaleString 的本地化标点和顺序。
 */
export function getZonedDateParts(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    // 非法 timezone 时降级到 system-local（仅 debug 时出现；resolver 已保证 timezone 合法）
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/** 用户时区下的日期字符串 YYYY-MM-DD（用于跨日判断）。 */
function formatLocalDate(date: Date, timezone: string): string {
  const p = getZonedDateParts(date, timezone);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

// ── 评分组件 ──────────────────────────────────────────────────────────
/**
 * 时间窗口匹配分（0-15）：离窗口中段越近分越高，边缘线性下降，窗口外为 0。
 * 窗口用闭区间 [startMin, endMin]（分钟数 0-1439）；endMin < startMin 表示跨午夜。
 */
function timeWindowFit(
  hour: number,
  minute: number,
  startMin: number,
  endMin: number,
): number {
  const current = hour * 60 + minute;
  let dist: number;
  if (startMin <= endMin) {
    if (current < startMin || current > endMin) return 0;
    const center = (startMin + endMin) / 2;
    const half = (endMin - startMin) / 2;
    dist = Math.abs(current - center);
  } else {
    // 跨午夜：例如 22:00(1320) → 02:00(120) → 跨天窗口
    if (current >= startMin || current <= endMin) {
      // 在窗口内：把 endMin + 1440 便于计算距离
      const center = startMin <= 720
        ? (startMin + (endMin + 1440)) / 2
        : ((startMin + (endMin + 1440)) / 2) - 1440;
      const ref = current >= startMin ? current : current + 1440;
      dist = Math.abs(ref - center);
    } else {
      return 0;
    }
  }
  // 距离 0 → 15；距离 = half → 0
  const half = (endMin >= startMin ? endMin - startMin : (1440 - startMin) + endMin) / 2;
  if (half <= 0) return current >= startMin && current <= (endMin >= startMin ? endMin : endMin + 1440 - 1440) ? 15 : 0;
  return clamp(Math.round((1 - dist / half) * 15), 0, 15);
}

/** 事件紧迫度（0-20）。普通时间问候为 0。 */
function eventUrgency(sceneId: string, ctx: ProactiveTriggerContext): number {
  switch (sceneId) {
    case "back_from_away":
      // 离开越久分越高，但封顶 20
      return clamp(Math.round(ctx.snapshot.idleSec / 60), 0, 20);
    case "work_break":
      // 活跃 90min 起，每多 30min 加 4，封顶 20
      const activeMs = ctx.activeSessionStartedAt !== null ? ctx.now - ctx.activeSessionStartedAt : 0;
      if (activeMs < WORK_BREAK_MIN_MS) return 0;
      return clamp(Math.round((activeMs - WORK_BREAK_MIN_MS) / (30 * 60 * 1000)) * 4, 0, 20);
    default:
      return 0;
  }
}

/** 新鲜度奖励（0-10）。仅缓存事件使用；当前未实现，返回 0。 */
function freshnessBonus(sceneId: string): number {
  // 占位：未来 weather 候选启用时根据 cache.expiresAt - now 计算
  void sceneId;
  return 0;
}

/** 沉默奖励（0-12）：距用户上一次活动越久分越高。
 * 边界：从未活跃过的新用户视为"沉默无穷大"，直接给上限 12，保证首启能触发。 */
function silenceBonus(ctx: ProactiveTriggerContext): number {
  const lastActivity =
    ctx.state.lastNormalConversationEndedAt !== null
      ? ctx.state.lastNormalConversationEndedAt
      : ctx.state.lastProactiveAt;
  if (lastActivity === null) return 12;
  const elapsed = ctx.now - lastActivity;
  if (elapsed < HALF_HOUR_MS) return 0;
  if (elapsed >= TWO_HOURS_MS) return 12;
  const ratio = (elapsed - HALF_HOUR_MS) / (TWO_HOURS_MS - HALF_HOUR_MS);
  return clamp(Math.round(ratio * 12), 0, 12);
}

/** 未回复惩罚。 */
function unansweredPenalty(unansweredCount: 0 | 1 | 2): number {
  if (unansweredCount === 0) return 0;
  if (unansweredCount === 1) return -18;
  return -100;
}

/** 评分总装：baseScore + fit + urgency + freshness + silence - unanswered。 */
function scoreOpportunity(
  baseScore: number,
  fit: number,
  urgency: number,
  sceneId: string,
  ctx: ProactiveTriggerContext,
): number {
  const total =
    baseScore
    + fit
    + urgency
    + freshnessBonus(sceneId)
    + silenceBonus(ctx)
    + unansweredPenalty(ctx.state.unansweredCount);
  return clamp(total, 0, 100);
}

// ── 场景定义 ──────────────────────────────────────────────────────────
interface SceneDefinition {
  sceneId: string;
  baseScore: number;
  sceneCooldownMs: number;
  /** 场景分类（决定 tie-break 优先级；数字越小越优先）。 */
  priority: number;
  /** 该场景的"是否在窗口内"判定 + 时间窗口匹配分。返回 score 增量。 */
  compute(ctx: ProactiveTriggerContext): { fit: number; urgency: number; applicable: boolean };
}

/**
 * 天气场景 ID 占位。
 * 当前实现：deps.getWeatherContext 为空/null 时不生成候选。
 * 未来接入天气缓存时，只需让 getWeatherContext 返回非空，并在下方
 * generateWeatherCandidates 中加判定逻辑。
 */
const WEATHER_SCENE_IDS = ["weather_rain", "weather_temperature_drop", "weather_sunny"] as const;
type WeatherSceneId = (typeof WEATHER_SCENE_IDS)[number];

const SCENES: readonly SceneDefinition[] = [
  {
    sceneId: "morning_greeting",
    baseScore: 52,
    sceneCooldownMs: 23 * 60 * 60 * 1000,
    priority: 4,
    compute(ctx) {
      // 07:00 - 10:30
      const fit = timeWindowFit(ctx.localHour, ctx.localMinute, 7 * 60, 10 * 60 + 30);
      return { fit, urgency: 0, applicable: fit > 0 };
    },
  },
  {
    sceneId: "evening_checkin",
    baseScore: 44,
    sceneCooldownMs: 8 * 60 * 60 * 1000,
    priority: 4,
    compute(ctx) {
      // 18:00 - 22:00
      const fit = timeWindowFit(ctx.localHour, ctx.localMinute, 18 * 60, 22 * 60);
      return { fit, urgency: 0, applicable: fit > 0 };
    },
  },
  {
    sceneId: "back_from_away",
    baseScore: 68,
    sceneCooldownMs: 4 * 60 * 60 * 1000,
    priority: 1, // tie-break 最优先
    compute(ctx) {
      if (ctx.previousIdleSec === null) return { fit: 0, urgency: 0, applicable: false };
      const applicable =
        ctx.previousIdleSec >= AWAY_THRESHOLD_SEC &&
        ctx.snapshot.idleSec < ACTIVE_THRESHOLD_SEC;
      return { fit: 0, urgency: eventUrgency("back_from_away", ctx), applicable };
    },
  },
  {
    sceneId: "work_break",
    baseScore: 56,
    sceneCooldownMs: 3 * 60 * 60 * 1000,
    priority: 2,
    compute(ctx) {
      if (ctx.activeSessionStartedAt === null) return { fit: 0, urgency: 0, applicable: false };
      const activeMs = ctx.now - ctx.activeSessionStartedAt;
      const applicable = activeMs >= WORK_BREAK_MIN_MS;
      return { fit: 0, urgency: eventUrgency("work_break", ctx), applicable };
    },
  },
];

// ── 候选生成 ──────────────────────────────────────────────────────────
function generateTimeOpportunities(ctx: ProactiveTriggerContext): ProactiveOpportunity[] {
  const out: ProactiveOpportunity[] = [];
  for (const scene of SCENES) {
    const { applicable, fit, urgency } = scene.compute(ctx);
    if (!applicable) continue;
    const score = scoreOpportunity(scene.baseScore, fit, urgency, scene.sceneId, ctx);
    if (score < MIN_EVALUATION_SCORE) continue;
    out.push({
      sceneId: scene.sceneId,
      score,
      sceneCooldownMs: scene.sceneCooldownMs,
      reason: `base=${scene.baseScore} fit=${fit} urgency=${urgency}`,
    });
  }
  return out;
}

/**
 * 天气候选生成（占位实现）。
 * 当前：weather 为 null/空时返回 []。
 * 未来接入天气缓存时：让 getWeatherContext 返回非空 WeatherContext，
 * 并在此函数内根据 WeatherContext 字段决定是否生成 weather_rain / weather_temperature_drop / weather_sunny 候选。
 *
 * 注意：本函数签名固定，不要改。变更只发生在函数体内。
 */
function generateWeatherOpportunities(
  ctx: ProactiveTriggerContext,
  weather: WeatherContext | null,
): ProactiveOpportunity[] {
  // 显式过滤：weather 为 null / undefined / 空对象时都不生成候选
  if (!weather || typeof weather !== "object") return [];
  if (Object.keys(weather).length === 0) return [];
  // 占位：未来缓存接入时，在此处实现天气候选生成。
  // 例如：
  //   if (weather.isRaining) opportunities.push({ sceneId: "weather_rain", ... });
  //   if (weather.tempDrop) opportunities.push({ sceneId: "weather_temperature_drop", ... });
  return [];
}

/** 主候选生成入口。 */
function generateProactiveCandidates(ctx: ProactiveTriggerContext): ProactiveOpportunity[] {
  const timeOpps = generateTimeOpportunities(ctx);
  const weatherOpps = generateWeatherOpportunities(ctx, ctx.weather);
  return [...timeOpps, ...weatherOpps];
}

/** Tie-break：场景定义 priority 数字小的优先；同 priority 时按定义顺序稳定排序。 */
function sortCandidates(opps: ProactiveOpportunity[]): ProactiveOpportunity[] {
  const priorityByScene = new Map<string, number>();
  for (const s of SCENES) priorityByScene.set(s.sceneId, s.priority);
  // 天气场景默认 priority 3（在时间问候之前、back_from_away/work_break 之后）
  for (const id of WEATHER_SCENE_IDS) {
    if (!priorityByScene.has(id)) priorityByScene.set(id, 3);
  }
  return [...opps].sort((a, b) => {
    const pa = priorityByScene.get(a.sceneId) ?? 99;
    const pb = priorityByScene.get(b.sceneId) ?? 99;
    if (pa !== pb) return pa - pb;
    // 同 priority：保持生成顺序稳定（stable sort by insertion index）
    return opps.indexOf(a) - opps.indexOf(b);
  });
}

// ── 触发前快速过滤（不替代 policy） ──────────────────────────────────
function shouldSkipFast(snapshot: ProactiveRuntimeSnapshot): boolean {
  if (!snapshot.enabled) return true;
  if (snapshot.screenLocked) return true;
  if (snapshot.conversationBusy) return true;
  if (snapshot.generationBusy) return true;
  return false;
}

// ── 控制器 ────────────────────────────────────────────────────────────
export function createProactiveTrigger(deps: ProactiveTriggerDependencies): ProactiveTriggerController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = true;

  // 闭包状态
  let previousIdleSec: number | null = null;
  let activeSessionStartedAt: number | null = null;

  const log = (event: string, detail?: unknown): void => {
    console.log(`${LOG_PREFIX} ${event}`, detail ?? "");
  };

  function jitter(): number {
    return Math.floor(Math.random() * INTERVAL_JITTER_MS);
  }

  function scheduleNext(): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, TRIGGER_INTERVAL_MS + jitter());
  }

  async function evaluateNow(reason: string): Promise<void> {
    const snapshot = deps.getRuntimeSnapshot();
    if (shouldSkipFast(snapshot)) return;

    const state = deps.getProactiveState();
    const timezone = deps.getTimezone();
    const localDate = formatLocalDate(new Date(snapshot.now), timezone);
    const localParts = getZonedDateParts(new Date(snapshot.now), timezone);
    const weather = deps.getWeatherContext?.() ?? null;

    // 更新 activeSessionStartedAt：用户当前空闲时重置
    if (snapshot.idleSec >= ACTIVE_THRESHOLD_SEC) {
      activeSessionStartedAt = null;
    } else if (activeSessionStartedAt === null) {
      activeSessionStartedAt = snapshot.now;
    }

    const ctx: ProactiveTriggerContext = {
      now: snapshot.now,
      timezone,
      localDate,
      localHour: localParts.hour,
      localMinute: localParts.minute,
      snapshot,
      state,
      previousIdleSec,
      activeSessionStartedAt,
      weather,
    };

    const allOpps = generateProactiveCandidates(ctx);
    const filtered = allOpps.filter((o) => o.score >= MIN_EVALUATION_SCORE);
    const sorted = sortCandidates(filtered);

    if (sorted.length === 0) {
      // log("skipped reason=no_candidate_above_threshold", { reason });
      previousIdleSec = snapshot.idleSec;
      return;
    }

    // Backoff 检查：跳过最近 30 分钟内已评估过的场景
    const backoffMap = deps.getLastEvaluatedAtByScene();
    const candidates = sorted.filter((o) => {
      const last = backoffMap.get(o.sceneId);
      if (typeof last === "number" && snapshot.now - last < EVALUATION_RETRY_MS) {
        log("skipped scene=" + o.sceneId + " reason=evaluation_backoff", { reason });
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      previousIdleSec = snapshot.idleSec;
      return;
    }

    const selected = candidates[0];
    log("selected", { sceneId: selected.sceneId, score: selected.score, reason });

    // 记录评估时间（无论结果：committed / blocked / silent / fallback_unavailable）
    backoffMap.set(selected.sceneId, snapshot.now);
    deps.setLastEvaluatedAtByScene(backoffMap);

    try {
      await deps.evaluateCandidate({
        sceneId: selected.sceneId,
        score: selected.score,
        sceneCooldownMs: selected.sceneCooldownMs,
      });
    } catch (err) {
      log("evaluation_failed", { sceneId: selected.sceneId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      previousIdleSec = snapshot.idleSec;
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (running) {
      // 上一轮未结束，本轮直接跳过（防并发重入）
      scheduleNext();
      return;
    }
    running = true;
    try {
      await evaluateNow("timer");
    } catch (err) {
      log("tick_failed", err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
      scheduleNext();
    }
  }

  function start(): void {
    if (!stopped) return; // 幂等
    stopped = false;
    if (timer) { clearTimeout(timer); timer = null; }
    timer = setTimeout(() => { void tick(); }, INITIAL_DELAY_MS);
  }

  function stop(): void {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return { start, stop, evaluateNow };
}

// ── 导出供测试使用的纯函数 / 常量 ───────────────────────────────────
export const TRIGGER_CONSTANTS = {
  TRIGGER_INTERVAL_MS,
  INITIAL_DELAY_MS,
  INTERVAL_JITTER_MS,
  EVALUATION_RETRY_MS,
  MIN_EVALUATION_SCORE,
  AWAY_THRESHOLD_SEC,
  ACTIVE_THRESHOLD_SEC,
  WORK_BREAK_MIN_MS,
  WEATHER_SCENE_IDS,
} as const;