import { describe, expect, it } from "vitest";
import { clampFloatingCardPosition } from "./floating-card";

describe("floating card positioning", () => {
  it("uses the same viewport bounds for Work and Code cards", () => {
    expect(clampFloatingCardPosition({ x: 900, y: -10 }, { width: 240, minVisibleHeight: 48 }, {
      width: 1024,
      height: 768,
    })).toEqual({ x: 784, y: 0 });
  });
});
