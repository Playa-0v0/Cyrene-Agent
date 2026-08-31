import { describe, expect, it, vi } from "vitest";
import { createWindowLifecycleTracker } from "./electron-window-lifecycle";

function createFakeWindow() {
  const listeners = new Map<string, Array<() => void>>();
  let destroyed = false;
  const webContents = {
    id: 42,
    isDestroyed: vi.fn(() => destroyed),
  };
  return {
    win: {
      webContents,
      isDestroyed: vi.fn(() => destroyed),
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      }),
    },
    close: () => {
      destroyed = true;
      for (const listener of listeners.get("closed") ?? []) listener();
    },
  };
}

describe("electron window lifecycle tracker", () => {
  it("clears BrowserWindow and WebContents diagnostics after closed", () => {
    const onClosed = vi.fn();
    const tracker = createWindowLifecycleTracker("live2d", { onClosed });
    const fake = createFakeWindow();

    tracker.attach(fake.win);

    expect(tracker.getDiagnostics()).toMatchObject({
      name: "live2d",
      attached: true,
      windowDestroyed: false,
      webContentsId: 42,
      webContentsDestroyed: false,
      closedCount: 0,
    });

    fake.close();

    expect(onClosed).toHaveBeenCalledWith(fake.win);
    expect(tracker.getDiagnostics()).toMatchObject({
      name: "live2d",
      attached: false,
      windowDestroyed: null,
      webContentsId: null,
      webContentsDestroyed: null,
      closedCount: 1,
    });
  });
});
