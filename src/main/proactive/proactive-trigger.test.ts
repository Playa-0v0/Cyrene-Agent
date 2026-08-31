import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProactiveTrigger,
  getZonedDateParts,
  type ProactiveTriggerDependencies,
  TRIGGER_CONSTANTS,
} from "./proactive-trigger";
import { createDefaultProactiveState } from "./proactive-policy";
import type {
  ProactiveCandidate,
  ProactiveRuntimeSnapshot,
  ProactiveState,
} from "./proactive-types";

const TIMEZONE = "Asia/Shanghai";
const FIXED_NOW = Date.UTC(2026, 6, 21, 12, 0, 0); // 2026-07-21 12:00 UTC = 20:00 Asia/Shanghai

function makeSnapshot(overrides: Partial<ProactiveRuntimeSnapshot> = {}): ProactiveRuntimeSnapshot {
  return {
    now: FIXED_NOW,
    localHour: 20,
    idleSec: 30,
    enabled: true,
    conversationBusy: false,
    generationBusy: false,
    screenLocked: false,
    ...overrides,
  };
}

interface SetupResult {
  trigger: ReturnType<typeof createProactiveTrigger>;
  evaluateCandidate: ReturnType<typeof vi.fn>;
  snapshot: ProactiveRuntimeSnapshot;
  state: ProactiveState;
  backoffMap: Map<string, number>;
  setSnapshot: (next: Partial<ProactiveRuntimeSnapshot>) => void;
  setState: (next: Partial<ProactiveState>) => void;
}

function setup(overrides: Partial<ProactiveTriggerDependencies> = {}): SetupResult {
  const snapshot: ProactiveRuntimeSnapshot = makeSnapshot();
  const state: ProactiveRuntimeState extends never ? ProactiveState : ProactiveState = createDefaultProactiveState();
  const backoffMap = new Map<string, number>();
  const evaluateCandidate = vi.fn(async (_c: ProactiveCandidate) => undefined);

  // 当前 state 必然为 ProactiveState；上面那行 ts 类型干扰是 fallback 写法
  const typedState = state as ProactiveState;
  const trigger = createProactiveTrigger({
    evaluateCandidate,
    getRuntimeSnapshot: () => ({ ...snapshot }),
    getProactiveState: () => ({ ...typedState }),
    getTimezone: () => TIMEZONE,
    getLastEvaluatedAtByScene: () => new Map(backoffMap),
    setLastEvaluatedAtByScene: (next) => {
      backoffMap.clear();
      for (const [k, v] of next) backoffMap.set(k, v);
    },
    ...overrides,
  });

  return {
    trigger,
    evaluateCandidate,
    snapshot,
    state: typedState,
    backoffMap,
    setSnapshot: (next) => {
      Object.assign(snapshot, next);
    },
    setState: (next) => {
      Object.assign(typedState, next);
    },
  };
}

// ts 占位
type ProactiveRuntimeState = never;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createProactiveTrigger lifecycle", () => {
  it("start() 是幂等的：调用两次只创建一个循环", () => {
    const ctx = setup();
    ctx.trigger.start();
    ctx.trigger.start();
    expect(vi.getTimerCount()).toBe(1);
    ctx.trigger.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() 后不再触发", async () => {
    const ctx = setup();
    ctx.trigger.start();
    // 推进 INITIAL_DELAY → 第一轮 tick 跑
    await vi.advanceTimersByTimeAsync(
      TRIGGER_CONSTANTS.INITIAL_DELAY_MS + TRIGGER_CONSTANTS.INTERVAL_JITTER_MS + 10,
    );
    expect(ctx.evaluateCandidate.mock.calls.length).toBeGreaterThanOrEqual(1);
    const callsAfterFirst = ctx.evaluateCandidate.mock.calls.length;
    // 立刻 stop
    ctx.trigger.stop();
    expect(vi.getTimerCount()).toBe(0);
    // 后续推进时间不再产生调用
    await vi.advanceTimersByTimeAsync(TRIGGER_CONSTANTS.TRIGGER_INTERVAL_MS * 5);
    expect(ctx.evaluateCandidate.mock.calls.length).toBe(callsAfterFirst);
  });

  it("evaluateCandidate 抛错后循环继续", async () => {
    const ctx = setup();
    ctx.evaluateCandidate.mockRejectedValueOnce(new Error("boom"));
    ctx.trigger.start();
    // 跑完两轮
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(
        TRIGGER_CONSTANTS.INITIAL_DELAY_MS + TRIGGER_CONSTANTS.TRIGGER_INTERVAL_MS * i + TRIGGER_CONSTANTS.INTERVAL_JITTER_MS + 100,
      );
    }
    // 至少调用了一次（取决于时机），循环没有永久死掉
    expect(ctx.evaluateCandidate.mock.calls.length).toBeGreaterThanOrEqual(1);
    // 关键断言：还有下一次定时器被安排
    expect(vi.getTimerCount()).toBe(1);
    ctx.trigger.stop();
  });

  it("上一轮尚未结束时不会并发重入", async () => {
    let resolveEvaluation: ((v: unknown) => void) | null = null;
    const ctx = setup();
    ctx.evaluateCandidate.mockImplementationOnce(() => new Promise((resolve) => { resolveEvaluation = resolve; }));
    ctx.trigger.start();
    // 第一轮 tick 触发 evaluateCandidate 但没 resolve
    await vi.advanceTimersByTimeAsync(TRIGGER_CONSTANTS.INITIAL_DELAY_MS + TRIGGER_CONSTANTS.INTERVAL_JITTER_MS + 10);
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(1);

    // 推进一个完整的 tick 间隔，但第一轮还在跑
    await vi.advanceTimersByTimeAsync(TRIGGER_CONSTANTS.TRIGGER_INTERVAL_MS);
    // 没有并发重入
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(1);

    // resolve 第一轮
    resolveEvaluation!(undefined);
    // 等微任务清空
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe("candidate selection and evaluation", () => {
  it("无候选达到 60 分时不调 service", async () => {
    const ctx = setup();
    // 2026-07-21 06:00 UTC = 14:00 Asia/Shanghai（morning/evening 窗口外）
    // idleSec=0 让 activeSessionStartedAt 被设，但 14:00 不是 evening 窗口
    // work_break 需要 activeMs ≥ 90min；首次 evaluateNow 内部 activeMs=0 → 不触发
    // 没有 idle 边缘（previousIdleSec=null）
    const noonNow = Date.UTC(2026, 6, 21, 6, 0, 0);
    ctx.setSnapshot({ now: noonNow, idleSec: 0 });
    await ctx.trigger.evaluateNow("test");
    expect(ctx.evaluateCandidate).not.toHaveBeenCalled();
  });

  it("morning 窗口中心生成 morning_greeting 候选并调 evaluateCandidate", async () => {
    const ctx = setup();
    // 2026-07-22 00:30 UTC = 08:30 Asia/Shanghai（morning 窗口 07:00-10:30 中段）
    const morningNow = Date.UTC(2026, 6, 22, 0, 30, 0);
    ctx.setSnapshot({ now: morningNow, idleSec: 0 });
    await ctx.trigger.evaluateNow("test");
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(1);
    const arg = ctx.evaluateCandidate.mock.calls[0][0] as ProactiveCandidate;
    expect(arg.sceneId).toBe("morning_greeting");
    expect(arg.sceneCooldownMs).toBe(23 * 60 * 60 * 1000);
  });

  it("多个候选只取最高分", async () => {
    const ctx = setup();
    // 2026-07-21 12:00 UTC = 20:00 Asia/Shanghai（evening 窗口 18:00-22:00 中段）
    const eveningNow = Date.UTC(2026, 6, 21, 12, 0, 0);
    ctx.setSnapshot({
      now: eveningNow,
      idleSec: 30,
    });
    ctx.setState({
      lastNormalConversationEndedAt: eveningNow - 3 * 60 * 60 * 1000,
    });
    // 第一轮：previousIdleSec=null → back_from_away 不触发；会触发 evening（baseScore 44 + fit 15 + silenceBonus 12 = 71）
    await ctx.trigger.evaluateNow("round1");
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(1);
    expect(ctx.evaluateCandidate.mock.calls[0][0].sceneId).toBe("evening_checkin");

    // 第二轮：previousIdleSec=0，模拟"上一轮 idle=30min 然后现在 <60s"
    ctx.setSnapshot({ now: eveningNow + 60_000, idleSec: 30 * 60 }); // 现在 idle=30min
    await ctx.trigger.evaluateNow("round2");
    // previousIdleSec 现在 = 30*60，current=30*60 → 不触发 back_from_away
    // 跳过第二轮，calls 仍是 1
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(1);

    ctx.setSnapshot({ now: eveningNow + 120_000, idleSec: 10 });
    ctx.backoffMap.clear();
    await ctx.trigger.evaluateNow("round3");
    // previousIdleSec=1800, current=10 → 触发 back_from_away
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(2);
    expect(ctx.evaluateCandidate.mock.calls[1][0].sceneId).toBe("back_from_away");
  });

  it("同场景 30min evaluation backoff 内不重复调用", async () => {
    const ctx = setup();
    // 2026-07-21 12:00 UTC = 20:00 Asia/Shanghai（evening 中段）
    const eveningNow = Date.UTC(2026, 6, 21, 12, 0, 0);
    ctx.setSnapshot({ now: eveningNow, idleSec: 0 });
    await ctx.trigger.evaluateNow("first");
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(1);
    // 立即再来：仍处于 30min backoff 内，应跳过
    ctx.setSnapshot({ now: eveningNow + 60_000, idleSec: 0 });
    await ctx.trigger.evaluateNow("second");
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(1);
    // 推进到 31 分钟后：backoff 解禁
    ctx.setSnapshot({ now: eveningNow + 31 * 60 * 1000, idleSec: 0 });
    await ctx.trigger.evaluateNow("third");
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(2);
  });
});

describe("back_from_away edge detection", () => {
  it("previousIdleSec=null（首次）不生成 back_from_away", async () => {
    const ctx = setup();
    // 2026-07-21 12:00 UTC = 20:00 Asia/Shanghai（evening 中段）
    const eveningNow = Date.UTC(2026, 6, 21, 12, 0, 0);
    ctx.setSnapshot({ now: eveningNow, idleSec: 0 });
    await ctx.trigger.evaluateNow("first");
    // evening_checkin 应触发，back_from_away 不应触发
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(1);
    expect(ctx.evaluateCandidate.mock.calls[0][0].sceneId).toBe("evening_checkin");
  });

  it("previousIdleSec >= 30min 且 current < 60s 时生成 back_from_away", async () => {
    const ctx = setup();
    const eveningNow = Date.UTC(2026, 6, 21, 12, 0, 0);
    // 第一轮：previousIdleSec=null → 不生成 back_from_away；只生成 evening
    ctx.setSnapshot({ now: eveningNow, idleSec: 0 });
    await ctx.trigger.evaluateNow("first");
    // previousIdleSec 现在 = 0（idle<60）
    // 第二轮：previousIdleSec=0，模拟"上一轮 idle=30min 然后现在 <60s" → 手动设 snapshot now 和 idleSec 后跑
    // 简化：直接验证 evaluateNow 内部更新 previousIdleSec
    ctx.setSnapshot({ now: eveningNow + 60_000, idleSec: 30 * 60 }); // 现在 idle=30min
    await ctx.trigger.evaluateNow("second"); // 这一轮 previousIdleSec=0（来自第一轮），current=30min → 不触发 back_from_away
    // previousIdleSec 现在 = 30*60
    ctx.setSnapshot({ now: eveningNow + 120_000, idleSec: 10 }); // 现在 idle<60
    ctx.backoffMap.clear(); // 避免 evening backoff
    await ctx.trigger.evaluateNow("third"); // previousIdleSec=1800, current=10 → 触发 back_from_away
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(2); // 跳过第二轮（只 back_from_away 条件不满足）
    expect(ctx.evaluateCandidate.mock.calls[1][0].sceneId).toBe("back_from_away");
  });
});

describe("weather context gating (placeholder)", () => {
  it("未传 getWeatherContext 时，4 个核心场景正常工作", async () => {
    const ctx = setup(); // 没有 getWeatherContext
    const eveningNow = Date.UTC(2026, 6, 21, 12, 0, 0);
    ctx.setSnapshot({ now: eveningNow, idleSec: 0 });
    await ctx.trigger.evaluateNow("test");
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(1);
    expect(ctx.evaluateCandidate.mock.calls[0][0].sceneId).toBe("evening_checkin");
  });

  it("getWeatherContext 返回 null 不影响 4 个核心场景", async () => {
    const ctx = setup({ getWeatherContext: () => null });
    const eveningNow = Date.UTC(2026, 6, 21, 12, 0, 0);
    ctx.setSnapshot({ now: eveningNow, idleSec: 0 });
    await ctx.trigger.evaluateNow("test");
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(1);
    expect(ctx.evaluateCandidate.mock.calls[0][0].sceneId).toBe("evening_checkin");
  });

  it("getWeatherContext 返回空对象时仍不生成天气候选（当前实现）", async () => {
    const ctx = setup({ getWeatherContext: () => ({}) });
    const eveningNow = Date.UTC(2026, 6, 21, 12, 0, 0);
    ctx.setSnapshot({ now: eveningNow, idleSec: 0 });
    await ctx.trigger.evaluateNow("test");
    // 4 个核心场景中只有 evening 在窗口
    expect(ctx.evaluateCandidate).toHaveBeenCalledTimes(1);
    expect(ctx.evaluateCandidate.mock.calls[0][0].sceneId).toBe("evening_checkin");
    // 没有 weather_* 场景被调用
    for (const call of ctx.evaluateCandidate.mock.calls) {
      const id = (call[0] as ProactiveCandidate).sceneId;
      expect(id).not.toMatch(/^weather_/);
    }
  });
});

describe("fast filters (not a substitute for policy)", () => {
  it("proactiveChatMode=off 时不评估", async () => {
    const ctx = setup();
    ctx.setSnapshot({ enabled: false });
    const eveningNow = Date.UTC(2026, 6, 21, 12, 0, 0);
    ctx.setSnapshot({ now: eveningNow, idleSec: 0 });
    await ctx.trigger.evaluateNow("test");
    expect(ctx.evaluateCandidate).not.toHaveBeenCalled();
  });

  it("conversationBusy 时不评估", async () => {
    const ctx = setup();
    ctx.setSnapshot({ conversationBusy: true });
    await ctx.trigger.evaluateNow("test");
    expect(ctx.evaluateCandidate).not.toHaveBeenCalled();
  });

  it("generationBusy 时不评估", async () => {
    const ctx = setup();
    ctx.setSnapshot({ generationBusy: true });
    await ctx.trigger.evaluateNow("test");
    expect(ctx.evaluateCandidate).not.toHaveBeenCalled();
  });

  it("screenLocked 时不评估", async () => {
    const ctx = setup();
    ctx.setSnapshot({ screenLocked: true });
    await ctx.trigger.evaluateNow("test");
    expect(ctx.evaluateCandidate).not.toHaveBeenCalled();
  });
});

describe("getZonedDateParts", () => {
  // 2026-07-21T15:30:00.000Z
  const FIXED_UTC = Date.UTC(2026, 6, 21, 15, 30, 0);

  it("Asia/Taipei (UTC+8) → 23:30 同日", () => {
    const p = getZonedDateParts(new Date(FIXED_UTC), "Asia/Taipei");
    expect(p).toEqual({ year: 2026, month: 7, day: 21, hour: 23, minute: 30 });
  });

  it("UTC → 15:30 同日", () => {
    const p = getZonedDateParts(new Date(FIXED_UTC), "UTC");
    expect(p).toEqual({ year: 2026, month: 7, day: 21, hour: 15, minute: 30 });
  });

  it("America/Los_Angeles (PDT, UTC-7) → 08:30 同日", () => {
    const p = getZonedDateParts(new Date(FIXED_UTC), "America/Los_Angeles");
    expect(p).toEqual({ year: 2026, month: 7, day: 21, hour: 8, minute: 30 });
  });

  it("非法 timezone 降级到 system-local", () => {
    const p = getZonedDateParts(new Date(FIXED_UTC), "Foo/Bar");
    // 不抛错，返回数字对象
    expect(typeof p.year).toBe("number");
    expect(typeof p.hour).toBe("number");
  });
});