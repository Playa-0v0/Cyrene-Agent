import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  afterEach(() => vi.restoreAllMocks());

  it("does not execute weather lookup when the weather plugin is disabled", async () => {
    const weather = toolRegistry.getById("weather");

    await expect(weather?.execute({ city: "北京" })).resolves.toBe("[错误] 天气查询功能未启用，请在设置里开启");
  });

  it("carries the invoking run context into the weather card callback", async () => {
    const weather = toolRegistry.getById("weather");
    const cardCallback = vi.fn();
    setWeatherConfig(
      () => "北京",
      () => "open-meteo",
      () => "",
      cardCallback,
      () => true,
    );
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ name: "北京", latitude: 39.9, longitude: 116.4, country: "中国", admin1: "北京市" }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        current: {
          temperature_2m: 25, apparent_temperature: 26, relative_humidity_2m: 50,
          precipitation: 0, weather_code: 1, wind_speed_10m: 12, wind_direction_10m: 90,
          surface_pressure: 1012, uv_index: 3, visibility: 10_000,
        },
      }), { status: 200 })) as unknown as typeof fetch;

    await weather?.execute({ city: "北京" }, { runId: "run-weather-1", userQuery: "北京天气" });

    expect(cardCallback).toHaveBeenCalledWith(
      expect.objectContaining({ source: "open-meteo" }),
      expect.objectContaining({ runId: "run-weather-1" }),
    );
  });

  it("does not execute travel lookup when the travel plugin is disabled", async () => {
    const travel = toolRegistry.getById("plan_trip");

    await expect(travel?.execute({ origin: "A", destination: "B" })).resolves.toBe("[错误] 出行工具未启用，请在设置里开启");
  });
});
