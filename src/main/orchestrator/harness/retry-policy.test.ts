import { afterEach, describe, expect, it, vi } from "vitest";
import { sleepWithJitter } from "./retry-policy";

describe("sleepWithJitter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves the existing jittered delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let settled = false;
    void sleepWithJitter(1_000).then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(1_149);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it("rejects immediately with AbortError without waiting for the jittered timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let outcome: unknown;
    void sleepWithJitter(1_000, controller.signal).then(
      () => { outcome = { status: "resolved" }; },
      (error) => { outcome = { status: "rejected", name: (error as Error).name }; },
    );

    controller.abort();
    await Promise.resolve();
    expect(outcome).toEqual({ status: "rejected", name: "AbortError" });
  });
});
