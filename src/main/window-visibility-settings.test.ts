import { describe, expect, it } from "vitest";
import { normalizeWindowVisibilitySettings } from "./window-visibility-settings";

describe("normalizeWindowVisibilitySettings", () => {
  it("defaults sidebar and tasks windows to visible", () => {
    expect(normalizeWindowVisibilitySettings({})).toEqual({
      sidebarVisible: true,
      tasksVisible: true,
    });
  });

  it("preserves explicit false values", () => {
    expect(normalizeWindowVisibilitySettings({ sidebarVisible: false, tasksVisible: false })).toEqual({
      sidebarVisible: false,
      tasksVisible: false,
    });
  });
});
