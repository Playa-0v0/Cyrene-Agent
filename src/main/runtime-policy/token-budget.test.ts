import { describe, expect, it } from "vitest";
import { resolveMaxOutputTokens, getStageTokenPolicy } from "./token-budget";

describe("resolveMaxOutputTokens", () => {
  it("returns stage default when no override", () => {
    expect(resolveMaxOutputTokens({ stage: "task-plan" })).toBe(1200);
    expect(resolveMaxOutputTokens({ stage: "ask-soul" })).toBe(1600);
    expect(resolveMaxOutputTokens({ stage: "memory-judge" })).toBe(800);
    expect(resolveMaxOutputTokens({ stage: "memory-compressor" })).toBe(500);
    expect(resolveMaxOutputTokens({ stage: "memory-reflect" })).toBe(500);
    expect(resolveMaxOutputTokens({ stage: "memory-resolver" })).toBe(700);
  });

  it("override takes precedence over stage default", () => {
    expect(resolveMaxOutputTokens({ stage: "task-plan", override: 2400 })).toBe(2400);
  });

  it("override of 0 or negative falls back to stage default", () => {
    expect(resolveMaxOutputTokens({ stage: "task-plan", override: 0 })).toBe(1200);
    expect(resolveMaxOutputTokens({ stage: "task-plan", override: -100 })).toBe(1200);
  });

  it("override of NaN or Infinity falls back to stage default", () => {
    expect(resolveMaxOutputTokens({ stage: "task-plan", override: NaN })).toBe(1200);
    expect(resolveMaxOutputTokens({ stage: "task-plan", override: Infinity })).toBe(1200);
  });

  it("override rounds fractional values", () => {
    expect(resolveMaxOutputTokens({ stage: "task-plan", override: 1500.7 })).toBe(1501);
  });
});

describe("getStageTokenPolicy", () => {
  it("returns policy with defaultMaxOutputTokens for all stages", () => {
    const stages = ["task-plan", "ask-soul", "memory-judge", "memory-compressor", "memory-reflect", "memory-resolver"] as const;
    for (const stage of stages) {
      const policy = getStageTokenPolicy(stage);
      expect(policy.defaultMaxOutputTokens).toBeGreaterThan(0);
    }
  });

  it("returns a frozen-like object (read-only intent)", () => {
    const policy = getStageTokenPolicy("task-plan");
    expect(policy.defaultMaxOutputTokens).toBe(1200);
  });
});
