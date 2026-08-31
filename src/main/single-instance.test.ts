import { describe, expect, it, vi } from "vitest";
import { installSingleInstanceGuard } from "./single-instance";

describe("installSingleInstanceGuard", () => {
  it("quits a duplicate process before it can create another pet window", () => {
    const quit = vi.fn();
    const on = vi.fn();

    expect(installSingleInstanceGuard({ requestSingleInstanceLock: () => false, quit, on }, vi.fn())).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(on).not.toHaveBeenCalled();
  });

  it("focuses the existing Cyrene window when launched again", () => {
    let onSecondInstance: (() => void) | undefined;
    const focusExistingWindow = vi.fn();
    const on = vi.fn((_event: "second-instance", listener: () => void) => { onSecondInstance = listener; });

    expect(installSingleInstanceGuard({ requestSingleInstanceLock: () => true, quit: vi.fn(), on }, focusExistingWindow)).toBe(true);
    onSecondInstance?.();
    expect(focusExistingWindow).toHaveBeenCalledOnce();
  });
});
