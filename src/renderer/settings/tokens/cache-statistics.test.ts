import { describe, expect, it } from "vitest";
import { formatCacheRate } from "./cache-statistics";

describe("formatCacheRate", () => {
  it("calculates the rate from provider-reported cache tokens only", () => {
    expect(formatCacheRate({ hit: 8, miss: 12, requests: 3, cacheUsageRequests: 1 }))
      .toBe("40.0%（已统计 1 / 3 次请求）");
  });

  it("does not present unavailable provider data as a zero-percent cache hit", () => {
    expect(formatCacheRate({ hit: 0, miss: 0, requests: 3, cacheUsageRequests: 0 }))
      .toBe("模型未提供缓存统计");
  });
});
