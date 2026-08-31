import { describe, expect, it } from "vitest";
import { TimeoutClock } from "./timeout-clock";

describe("TimeoutClock", () => {
  it("does not expire a run when total execution timeout is disabled", () => {
    const clock = new TimeoutClock(0, 60_000);
    clock.startActive();
    expect(clock.isExecutionTimeout()).toBe(false);
    expect(clock.remainingExecutionMs()).toBe(Number.POSITIVE_INFINITY);
  });
});
