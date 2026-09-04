import { describe, expect, it, vi } from "vitest";
import { getInitialMode, LAST_MODE_STORAGE_KEY, normalizeWeatherData, stageForStep } from "./chat-page-normalizers";

describe("chat page normalizers", () => {
  it("normalizes a complete Open-Meteo weather card", () => {
    expect(normalizeWeatherData({
      source: "open-meteo",
      location: { province: "上海", city: "上海" },
      weatherCode: 1,
      temp: 28,
      humidity: 63,
      windDeg: 180,
      windSpeed: 12,
    })).toEqual({
      source: "open-meteo",
      location: { province: "上海", city: "上海" },
      weatherCode: 1,
      temp: 28,
      feelsLike: 28,
      humidity: 63,
      windDeg: 180,
      windSpeed: 12,
      precipitation: 0,
      pressure: 0,
    });
  });

  it("maps tool steps to an executing stage", () => {
    expect(stageForStep("agent-graph-tool-read_file")).toEqual({
      kind: "executing",
      detail: "read_file",
    });
  });
});
describe("getInitialMode", () => {
  it("restores the last mode written under the shared storage key", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    });
    try {
      // ChatPage 的写入方与 getInitialMode 的读取方必须共用同一个键
      localStorage.setItem(LAST_MODE_STORAGE_KEY, "learn");
      expect(getInitialMode()).toBe("learn");
      // 无记录或非法值时回退默认 chat 模式
      storage.clear();
      expect(getInitialMode()).toBe("chat");
      localStorage.setItem(LAST_MODE_STORAGE_KEY, "not-a-mode");
      expect(getInitialMode()).toBe("chat");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});