import { describe, expect, it } from "vitest";
import { isQuietTime, isSceneEnabled } from "./opener-policy";
import type { OpenerRuntimeConfig } from "./opener-types";

const config: OpenerRuntimeConfig = {
  mode: "normal",
  quietStart: "23:00",
  quietEnd: "07:00",
  dailyLimit: 4,
  routineEnabled: true,
  breaksEnabled: false,
  weatherEnabled: true,
  city: "台北",
};

describe("opener policy", () => {
  it("支援跨午夜安靜時段", () => {
    expect(isQuietTime(new Date(2026, 6, 13, 23, 30), "23:00", "07:00")).toBe(true);
    expect(isQuietTime(new Date(2026, 6, 14, 6, 59), "23:00", "07:00")).toBe(true);
    expect(isQuietTime(new Date(2026, 6, 14, 7, 0), "23:00", "07:00")).toBe(false);
  });

  it("開始與結束相同代表不設定安靜時段", () => {
    expect(isQuietTime(new Date(2026, 6, 13, 12, 0), "00:00", "00:00")).toBe(false);
  });

  it("依類別套用場景開關", () => {
    expect(isSceneEnabled("morning", config)).toBe(true);
    expect(isSceneEnabled("work_break", config)).toBe(false);
    expect(isSceneEnabled("back_from_away", config)).toBe(false);
    expect(isSceneEnabled("rainy_day", config)).toBe(true);
  });
});
