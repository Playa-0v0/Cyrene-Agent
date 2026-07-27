import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({
  sendToLive2DWindow: vi.fn(),
}));
import { setWeatherConfig } from "./built-in-tools";
import { setTravelConfig, registerTravelTools } from "./travel-tools";
import { toolRegistry } from "./tool-registry";

registerTravelTools();

describe("plugin enabled gates", () => {
  beforeEach(() => {
    setWeatherConfig(
      () => "北京",
      () => "amap",
      () => "",
      undefined,
      () => false,
    );
    setTravelConfig(
      () => "fake-amap-key",
      () => false,
    );
  });

  it("does not execute weather lookup when the weather plugin is disabled", async () => {
    const weather = toolRegistry.getById("weather");

    await expect(weather?.execute({ city: "北京" })).resolves.toBe("[錯誤] 天氣查詢功能未啟用，請在設置裡開啟");
  });

  it("does not execute travel lookup when the travel plugin is disabled", async () => {
    const travel = toolRegistry.getById("plan_trip");

    await expect(travel?.execute({ origin: "A", destination: "B" })).resolves.toBe("[錯誤] 出行工具未啟用，請在設置裡開啟");
  });
});
