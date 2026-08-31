import { describe, expect, it } from "vitest";
import {
  applyUsageToDay,
  clearUsage,
  type TokenUsageDay,
} from "./token-usage-store";

describe("applyUsageToDay", () => {
  it("tracks cache coverage for a model only when the provider reports cached input", () => {
    const day: TokenUsageDay = {
      input: 0,
      output: 0,
      hit: 0,
      miss: 0,
      cacheCreation: 0,
      requests: 0,
    };

    applyUsageToDay(day, 20, 4, 1, 8, "test-model");
    applyUsageToDay(day, 10, 2, 1, undefined, "test-model");

    expect(day.models?.["test-model"]).toEqual({
      input: 30,
      output: 6,
      hit: 8,
      miss: 12,
      cacheCreation: 0,
      requests: 2,
      cacheUsageRequests: 1,
    });
  });
});

describe("clearUsage", () => {
  it("removes every stored day and model record", () => {
    const days: Record<string, TokenUsageDay> = {
      "2026-08-16": {
        input: 20,
        output: 4,
        hit: 8,
        miss: 12,
        cacheCreation: 0,
        requests: 1,
        cacheUsageRequests: 1,
        models: {
          "test-model": { input: 20, output: 4, hit: 8, miss: 12, cacheCreation: 0, requests: 1, cacheUsageRequests: 1 },
        },
      },
    };

    clearUsage(days);

    expect(days).toEqual({});
  });
});
