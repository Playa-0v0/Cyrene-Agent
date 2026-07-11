import { describe, expect, it } from "vitest";
import { normalizeWindowCoordinate, normalizeWindowPosition } from "./window-position";

describe("window position normalization", () => {
  it("rounds finite coordinates", () => {
    expect(normalizeWindowPosition(120.4, -30.6)).toEqual({ x: 120, y: -31 });
  });

  it("rejects non-finite or missing coordinates", () => {
    expect(normalizeWindowPosition(Number.NaN, 10)).toBeNull();
    expect(normalizeWindowPosition(10, Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeWindowPosition(undefined, 10)).toBeNull();
  });

  it("clamps absurd values before they reach Electron native bindings", () => {
    expect(normalizeWindowCoordinate(9_999_999)).toBe(1_000_000);
    expect(normalizeWindowCoordinate(-9_999_999)).toBe(-1_000_000);
  });
});
