import { describe, it, expect, beforeEach, vi } from "vitest";

const { handlers, fakeApp } = vi.hoisted(() => {
  const handlers: Array<(e: { preventDefault: () => void }) => void> = [];
  const fakeApp = {
    on: (event: string, fn: (e: { preventDefault: () => void }) => void) => {
      if (event === "before-quit") handlers.push(fn);
    },
    quit: vi.fn(),
  };
  return { handlers, fakeApp };
});

vi.mock("electron", () => ({ app: fakeApp }));

import { installShutdownLatch } from "./shutdown-latch";

beforeEach(() => {
  handlers.length = 0;
  fakeApp.quit.mockReset();
  vi.useRealTimers();
});

describe("installShutdownLatch", () => {
  it("calls preventDefault on first before-quit and prevents immediate exit", () => {
    const bootstrap = {
      isShuttingDown: () => false,
      shutdown: vi.fn().mockResolvedValue({}),
    };
    installShutdownLatch(bootstrap, 1000);
    const event = { preventDefault: vi.fn() };
    handlers[0](event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(fakeApp.quit).not.toHaveBeenCalled();
  });

  it("calls bootstrap.shutdown() and re-quits after it resolves", async () => {
    const shutdown = vi.fn().mockResolvedValue({});
    const bootstrap = { isShuttingDown: () => false, shutdown };
    installShutdownLatch(bootstrap, 1000);
    handlers[0]({ preventDefault: vi.fn() });
    await new Promise((r) => setTimeout(r, 0));
    expect(shutdown).toHaveBeenCalled();
    expect(fakeApp.quit).toHaveBeenCalled();
  });

  it("second before-quit (after latch fired) is idempotent and lets app exit", async () => {
    const shutdown = vi.fn().mockResolvedValue({});
    const bootstrap = { isShuttingDown: () => false, shutdown };
    installShutdownLatch(bootstrap, 1000);
    handlers[0]({ preventDefault: vi.fn() });
    await new Promise((r) => setTimeout(r, 0));
    handlers[0]({ preventDefault: vi.fn() });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("if isShuttingDown() returns true at first call, latch does nothing", () => {
    const bootstrap = {
      isShuttingDown: () => true,
      shutdown: vi.fn().mockResolvedValue({}),
    };
    installShutdownLatch(bootstrap, 1000);
    const event = { preventDefault: vi.fn() };
    handlers[0](event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(bootstrap.shutdown).not.toHaveBeenCalled();
  });

  it("forces app.quit() on timeout if shutdown hangs", () => {
    vi.useFakeTimers();
    const shutdown = vi.fn().mockReturnValue(new Promise(() => {}));
    const bootstrap = { isShuttingDown: () => false, shutdown };
    installShutdownLatch(bootstrap, 500);
    handlers[0]({ preventDefault: vi.fn() });
    vi.advanceTimersByTime(500);
    expect(fakeApp.quit).toHaveBeenCalled();
  });
});
