import { afterEach, describe, expect, it, vi } from "vitest";
import { MouseFocusController } from "./focus";

class FakeCanvas {
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  getBoundingClientRect = () => ({ width: 100, height: 100 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MouseFocusController", () => {
  it("stops cursor IPC polling while paused and restarts it when resumed", async () => {
    vi.useFakeTimers();
    const getCursorPosition = vi.fn(async () => ({ x: 10, y: 10 }));
    const setIntervalSpy = vi.fn(setInterval);
    const clearIntervalSpy = vi.fn(clearInterval);
    vi.stubGlobal("window", {
      setInterval: setIntervalSpy,
      clearInterval: clearIntervalSpy,
      screenX: 0,
      screenY: 0,
      cyrene: { getCursorPosition },
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const controller = new MouseFocusController(new FakeCanvas() as unknown as HTMLCanvasElement, { focus: vi.fn() } as never, { pollIntervalMs: 50 });

    await vi.advanceTimersByTimeAsync(0);
    controller.pause();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    getCursorPosition.mockClear();
    await vi.advanceTimersByTimeAsync(200);
    expect(getCursorPosition).not.toHaveBeenCalled();

    controller.resume();
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(getCursorPosition).toHaveBeenCalled();
    controller.dispose();
  });
});
