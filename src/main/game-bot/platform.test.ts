import { describe, expect, it, vi } from "vitest";
import { DEFAULT_YAAGL_HSR_APP, detectGameRuntime, inspectGameRuntime, launchGameTarget, yaaglStartPoint } from "./platform";

describe("game-bot platform", () => {
  it("辨識 macOS YAAGL app bundle", () => {
    expect(detectGameRuntime(DEFAULT_YAAGL_HSR_APP, "darwin")).toBe("macos-yaagl");
    expect(inspectGameRuntime(DEFAULT_YAAGL_HSR_APP, "darwin", () => true)).toMatchObject({
      runtime: "macos-yaagl",
      exists: true,
      label: "macOS · YAAGL",
    });
  });

  it("辨識 Windows StarRail.exe", () => {
    expect(detectGameRuntime("C:/Games/StarRail.exe", "win32")).toBe("windows-native");
  });

  it("macOS 透過 open -a 啟動 app bundle", async () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));
    await launchGameTarget(DEFAULT_YAAGL_HSR_APP, "darwin", spawn);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", DEFAULT_YAAGL_HSR_APP],
      { detached: true, shell: false, stdio: "ignore" },
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it("依 YAAGL 視窗邊界計算開始按鈕位置", () => {
    expect(yaaglStartPoint({ x: 95, y: 80, width: 1280, height: 730 })).toEqual({ x: 1132, y: 730 });
  });
});
