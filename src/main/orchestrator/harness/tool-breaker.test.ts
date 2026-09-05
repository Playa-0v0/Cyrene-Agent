/**
 * 同工具连续失败熔断纯函数单测。
 *
 * 核心不变量：
 * - failure 递增、success 清零、not_executed / unknown 不动；
 * - 达到阈值（5）后 isToolBreakerTripped 为 true；
 * - 熔断自我解除陷阱：连续 failure 触发熔断后，穿插任意次 not_executed / unknown
 *   都不能让计数下降，只有 success 才能解除。
 */

import { describe, expect, it } from "vitest";
import {
  isToolBreakerTripped,
  nextToolFailureStreak,
  toolBreakerMessage,
  TOOL_FAILURE_STREAK_THRESHOLD,
} from "./tool-breaker";
import type { ToolCallOutcome } from "./types";

describe("nextToolFailureStreak", () => {
  it("failure 递增", () => {
    expect(nextToolFailureStreak(undefined, "failure")).toBe(1);
    expect(nextToolFailureStreak(1, "failure")).toBe(2);
    expect(nextToolFailureStreak(4, "failure")).toBe(5);
  });

  it("success 清零（含已触发熔断的高计数）", () => {
    expect(nextToolFailureStreak(undefined, "success")).toBe(0);
    expect(nextToolFailureStreak(3, "success")).toBe(0);
    expect(nextToolFailureStreak(5, "success")).toBe(0);
    expect(nextToolFailureStreak(30, "success")).toBe(0);
  });

  it("not_executed 不动（熔断自我解除陷阱）", () => {
    expect(nextToolFailureStreak(undefined, "not_executed")).toBe(0);
    expect(nextToolFailureStreak(0, "not_executed")).toBe(0);
    expect(nextToolFailureStreak(3, "not_executed")).toBe(3);
    expect(nextToolFailureStreak(5, "not_executed")).toBe(5);
  });

  it("unknown 不动", () => {
    expect(nextToolFailureStreak(undefined, "unknown")).toBe(0);
    expect(nextToolFailureStreak(2, "unknown")).toBe(2);
    expect(nextToolFailureStreak(5, "unknown")).toBe(5);
  });

  it("undefined 起点按 0 处理", () => {
    const outcomes: ToolCallOutcome[] = ["success", "not_executed", "unknown"];
    for (const outcome of outcomes) {
      expect(nextToolFailureStreak(undefined, outcome)).toBe(0);
    }
  });

  it("failure → not_executed 穿插序列:计数只增不降", () => {
    let streak: number | undefined;
    streak = nextToolFailureStreak(streak, "failure"); // 1
    streak = nextToolFailureStreak(streak, "not_executed"); // 1
    streak = nextToolFailureStreak(streak, "failure"); // 2
    streak = nextToolFailureStreak(streak, "unknown"); // 2
    streak = nextToolFailureStreak(streak, "failure"); // 3
    streak = nextToolFailureStreak(streak, "not_executed"); // 3
    streak = nextToolFailureStreak(streak, "failure"); // 4
    streak = nextToolFailureStreak(streak, "failure"); // 5 → 触发熔断
    expect(streak).toBe(TOOL_FAILURE_STREAK_THRESHOLD);
    expect(isToolBreakerTripped(streak)).toBe(true);
  });
});

describe("isToolBreakerTripped", () => {
  it("undefined（从未失败）不触发", () => {
    expect(isToolBreakerTripped(undefined)).toBe(false);
  });

  it("阈值前不触发", () => {
    expect(isToolBreakerTripped(0)).toBe(false);
    expect(isToolBreakerTripped(1)).toBe(false);
    expect(isToolBreakerTripped(4)).toBe(false);
  });

  it("达到阈值触发（≥ 阈值即拦截,含超过）", () => {
    expect(isToolBreakerTripped(5)).toBe(true);
    expect(isToolBreakerTripped(17)).toBe(true);
  });
});

describe("toolBreakerMessage", () => {
  it("包含工具名、失败次数与换方案指引", () => {
    const message = toolBreakerMessage("write_markdown", 5);
    expect(message).toContain("write_markdown");
    expect(message).toContain("5");
    expect(message).toContain("熔断");
    expect(message.length).toBeGreaterThan(20);
  });
});
