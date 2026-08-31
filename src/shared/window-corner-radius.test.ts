import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_CORNER_RADIUS,
  normalizeWindowCornerRadius,
} from "./window-corner-radius";

describe("normalizeWindowCornerRadius", () => {
  it("normalizes numeric input to an integer within the supported range", () => {
    expect(normalizeWindowCornerRadius(18.6)).toBe(19);
    expect(normalizeWindowCornerRadius(-2)).toBe(0);
    expect(normalizeWindowCornerRadius(99)).toBe(40);
  });

  it("uses the shared default for invalid values", () => {
    expect(normalizeWindowCornerRadius(undefined)).toBe(DEFAULT_WINDOW_CORNER_RADIUS);
    expect(normalizeWindowCornerRadius("invalid")).toBe(DEFAULT_WINDOW_CORNER_RADIUS);
  });
});
