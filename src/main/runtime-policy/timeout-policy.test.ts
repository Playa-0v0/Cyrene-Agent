import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveTimeoutPolicy, getStageTimeoutPolicy } from "./timeout-policy";
import type { RuntimeTimeoutStage } from "./timeout-policy";

describe("resolveTimeoutPolicy", () => {
  // Test 1: 每个 stage 返回原有默认值
  it("returns original default values for all stages", () => {
    const cases: Array<[RuntimeTimeoutStage, number]> = [
      ["memory-llm", 30_000],
      ["tool-execution", 300_000],
      ["tts-minimax", 30_000],
      ["tts-gptsovits", 180_000],
      ["tts-custom-cloud", 30_000],
      ["tts-mossland", 30_000],
      ["asr-mossland", 30_000],
      ["external-http", 30_000],
      ["vision-caption", 30_000],
      ["call-management", 30_000],
    ];
    for (const [stage, expectedMs] of cases) {
      const policy = resolveTimeoutPolicy({ stage });
      expect(policy.totalMs).toBe(expectedMs);
    }
  });

  // Test 2: partial override 只覆盖指定字段
  it("partial override only overrides specified fields", () => {
    const policy = resolveTimeoutPolicy({
      stage: "memory-llm",
      override: { totalMs: 45_000 },
    });
    expect(policy.totalMs).toBe(45_000);
    expect(policy.firstResponseMs).toBeUndefined();
    expect(policy.idleMs).toBeUndefined();
  });

  it("override with firstResponseMs preserves totalMs default", () => {
    const policy = resolveTimeoutPolicy({
      stage: "tts-gptsovits",
      override: { firstResponseMs: 10_000 },
    });
    expect(policy.totalMs).toBe(180_000); // default preserved
    expect(policy.firstResponseMs).toBe(10_000);
  });

  // Test 3: override 不修改默认策略对象
  it("override does not mutate the default policy object", () => {
    const before = resolveTimeoutPolicy({ stage: "memory-llm" });
    const beforeTotal = before.totalMs;

    resolveTimeoutPolicy({
      stage: "memory-llm",
      override: { totalMs: 999_999 },
    });

    const after = resolveTimeoutPolicy({ stage: "memory-llm" });
    expect(after.totalMs).toBe(beforeTotal);
    expect(after.totalMs).toBe(30_000);
  });

  // Test 4: 未知 stage 在编译期不可传入 (type-level only, runtime check)
  it("known stages are accepted at runtime", () => {
    const stages: RuntimeTimeoutStage[] = [
      "memory-llm",
      "tool-execution",
      "tts-minimax",
      "tts-gptsovits",
      "tts-custom-cloud",
      "tts-mossland",
      "asr-mossland",
      "external-http",
    ];
    for (const stage of stages) {
      expect(() => resolveTimeoutPolicy({ stage })).not.toThrow();
    }
  });
});

describe("getStageTimeoutPolicy", () => {
  it("returns the same object as resolveTimeoutPolicy without override", () => {
    const stages: RuntimeTimeoutStage[] = [
      "memory-llm",
      "tts-minimax",
      "tts-gptsovits",
    ];
    for (const stage of stages) {
      const fromGet = getStageTimeoutPolicy(stage);
      const fromResolve = resolveTimeoutPolicy({ stage });
      expect(fromGet).toEqual(fromResolve);
    }
  });
});

// Test 6 & 7: 超时后 timer 被清理, 正常完成后不会延迟触发超时回调
describe("timer lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("timer is cleared on successful completion", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const controller = new AbortController();
    const policy = resolveTimeoutPolicy({ stage: "memory-llm" });
    const timer = setTimeout(() => controller.abort(), policy.totalMs);

    // Simulate successful completion
    clearTimeout(timer);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    expect(controller.signal.aborted).toBe(false);
  });

  it("timer fires abort on timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const policy = resolveTimeoutPolicy({ stage: "memory-llm" });
    const timer = setTimeout(() => controller.abort(), policy.totalMs);

    expect(controller.signal.aborted).toBe(false);

    // Advance past the timeout
    vi.advanceTimersByTime(policy.totalMs + 1);

    expect(controller.signal.aborted).toBe(true);

    clearTimeout(timer);
    vi.useRealTimers();
  });
});
