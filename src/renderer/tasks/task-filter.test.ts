import { describe, expect, it } from "vitest";
import { getSchedulePanelItems, type ScheduledTask } from "./task-filter";

function task(id: string, nextFireAt: string | null, enabled = true): ScheduledTask {
  return {
    id,
    title: id,
    prompt: "Run",
    enabled,
    schedule: { kind: "daily", timeOfDay: "08:00" },
    nextFireAt,
  };
}

describe("getSchedulePanelItems", () => {
  it("shows today's remaining tasks first", () => {
    const now = new Date(2026, 6, 6, 10, 0, 0);
    const result = getSchedulePanelItems([
      task("tomorrow", new Date(2026, 6, 7, 1, 0, 0).toISOString()),
      task("today", new Date(2026, 6, 6, 12, 0, 0).toISOString()),
    ], now);

    expect(result.mode).toBe("today");
    expect(result.totalCount).toBe(1);
    expect(result.items.map(item => item.id)).toEqual(["today"]);
  });

  it("falls back to upcoming tasks when nothing remains today", () => {
    const now = new Date(2026, 6, 6, 10, 0, 0);
    const result = getSchedulePanelItems([
      task("past-today", new Date(2026, 6, 6, 8, 0, 0).toISOString()),
      task("tomorrow", new Date(2026, 6, 7, 8, 0, 0).toISOString()),
    ], now);

    expect(result.mode).toBe("upcoming");
    expect(result.totalCount).toBe(1);
    expect(result.items.map(item => item.id)).toEqual(["tomorrow"]);
  });

  it("ignores disabled tasks and invalid dates", () => {
    const now = new Date(2026, 6, 6, 10, 0, 0);
    const result = getSchedulePanelItems([
      task("disabled", new Date(2026, 6, 6, 12, 0, 0).toISOString(), false),
      task("invalid", "not-a-date"),
    ], now);

    expect(result.mode).toBe("empty");
    expect(result.totalCount).toBe(0);
    expect(result.items).toEqual([]);
  });
});
