import { describe, it, expect } from "vitest";
import { scoreScene } from "./scene-scorer";
import type { OpenerState, UserStateSnapshot, WeatherSnapshot } from "./opener-types";

const state: OpenerState = {
  globalDesire: 0,
  affinity: { morning:1, late_night:1, idle_daze:1, work_break:1, back_from_away:1, rainy_day:1, cold_drop:1, sunny_day:1 },
  todayFired: {}, lastFiredAt: {}, recentItems: {},
  lastTriggeredScene: null, lastTriggeredAt: null, desireRateMultiplier: 1, lastDateStr: "x", dailyFireCount: 0,
};
const emptyWeather: WeatherSnapshot = { isRaining:false, precip:0, temp:0, tempDropFromYesterday:0, isSunny:false, tempComfortable:false };

describe("scoreScene", () => {
  it("morning: 上午窗口 + 今日未觸發 = 100", () => {
    const snap: UserStateSnapshot = { hour: 8, idleSec: 5, mouseResumeEvent: false, lastChatAgoMs: 0, keyboardAccumMin: 0 };
    expect(scoreScene("morning", snap, emptyWeather, state, Date.now())).toBe(100);
  });
  it("morning: 下午 = 0", () => {
    const snap: UserStateSnapshot = { hour: 14, idleSec: 5, mouseResumeEvent: false, lastChatAgoMs: 0, keyboardAccumMin: 0 };
    expect(scoreScene("morning", snap, emptyWeather, state, Date.now())).toBe(0);
  });
  it("late_night: 23點 + 1h 活躍 = 100（50+50）", () => {
    const snap: UserStateSnapshot = { hour: 23, idleSec: 5, mouseResumeEvent: false, lastChatAgoMs: 0, keyboardAccumMin: 60 };
    expect(scoreScene("late_night", snap, emptyWeather, state, Date.now())).toBe(100);
  });
  it("late_night: 22點 = 0（未到 23）", () => {
    const snap: UserStateSnapshot = { hour: 22, idleSec: 5, mouseResumeEvent: false, lastChatAgoMs: 0, keyboardAccumMin: 60 };
    expect(scoreScene("late_night", snap, emptyWeather, state, Date.now())).toBe(0);
  });
  it("idle_daze: 白天 + 空閒 10min = 80", () => {
    const snap: UserStateSnapshot = { hour: 14, idleSec: 600, mouseResumeEvent: false, lastChatAgoMs: 0, keyboardAccumMin: 0 };
    expect(scoreScene("idle_daze", snap, emptyWeather, state, Date.now())).toBe(80);
  });
  it("work_break: 累計 2h = 100", () => {
    const snap: UserStateSnapshot = { hour: 14, idleSec: 5, mouseResumeEvent: false, lastChatAgoMs: 0, keyboardAccumMin: 120 };
    expect(scoreScene("work_break", snap, emptyWeather, state, Date.now())).toBe(100);
  });
  it("rainy_day: 下雨 + weather 未觸發 = 70", () => {
    const snap: UserStateSnapshot = { hour: 14, idleSec: 5, mouseResumeEvent: false, lastChatAgoMs: 0, keyboardAccumMin: 0 };
    const w: WeatherSnapshot = { ...emptyWeather, isRaining: true, precip: 0 };
    expect(scoreScene("rainy_day", snap, w, state, Date.now())).toBe(70);
  });
  it("rainy_day: weather 已觸發 = 0（互斥）", () => {
    const snap: UserStateSnapshot = { hour: 14, idleSec: 5, mouseResumeEvent: false, lastChatAgoMs: 0, keyboardAccumMin: 0 };
    const w: WeatherSnapshot = { ...emptyWeather, isRaining: true };
    const s2 = { ...state, todayFired: { weather: true } };
    expect(scoreScene("rainy_day", snap, w, s2, Date.now())).toBe(0);
  });
  it("affinity 影響 finalScore", () => {
    const snap: UserStateSnapshot = { hour: 8, idleSec: 5, mouseResumeEvent: false, lastChatAgoMs: 0, keyboardAccumMin: 0 };
    const s2 = { ...state, affinity: { ...state.affinity, morning: 1.5 } };
    expect(scoreScene("morning", snap, emptyWeather, s2, Date.now())).toBe(150);
  });
});
