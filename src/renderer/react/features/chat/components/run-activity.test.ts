import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  resolveRunActivityExpanded,
  resolveRunActivitySnapshot,
  shouldAutoCollapseRunActivity,
} from "./run-activity";

describe("run activity presentation", () => {
  it("accumulates completed reasoning with the active reasoning segment", () => {
    expect(resolveRunActivitySnapshot({
      startedAt: 1_000,
      reasoningMs: 3_000,
      activeReasoningStartedAt: 8_000,
    }, 10_000)).toEqual({
      processingMs: 9_000,
      reasoningMs: 5_000,
      processing: true,
    });
  });

  it("freezes the completed duration and defaults the panel to collapsed", () => {
    const activity = {
      startedAt: 1_000,
      completedAt: 13_000,
      reasoningMs: 5_000,
    };
    expect(resolveRunActivitySnapshot(activity, 30_000)).toEqual({
      processingMs: 12_000,
      reasoningMs: 5_000,
      processing: false,
    });
    expect(resolveRunActivityExpanded({}, "run-1", activity)).toBe(false);
  });

  it("defaults a live run to expanded but preserves a user's explicit choice", () => {
    const activity = { startedAt: 1_000, reasoningMs: 0 };
    expect(resolveRunActivityExpanded({}, "run-1", activity)).toBe(true);
    expect(resolveRunActivityExpanded({ "run-1": false }, "run-1", activity)).toBe(false);
  });

  it("auto-collapses only at the processing-to-complete transition", () => {
    expect(shouldAutoCollapseRunActivity(true, false)).toBe(true);
    expect(shouldAutoCollapseRunActivity(true, false, true)).toBe(false);
    expect(shouldAutoCollapseRunActivity(false, false)).toBe(false);
    expect(shouldAutoCollapseRunActivity(true, true)).toBe(false);
  });

  it("keeps an abnormal run expanded after settlement", () => {
    const activity = { startedAt: 1_000, completedAt: 2_000, reasoningMs: 0, keepExpanded: true };
    expect(resolveRunActivityExpanded({}, "run-1", activity)).toBe(true);
  });

  it("formats elapsed time in minutes and seconds", () => {
    expect(formatElapsed(62_300)).toBe("1分2秒");
    expect(formatElapsed(700)).toBe("0秒");
  });
});
