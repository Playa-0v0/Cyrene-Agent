import { describe, expect, it } from "vitest";
import {
  LIVE2D_ACTIONS,
  findAction,
  type Live2DTarget,
} from "../shared/live2d-actions";

describe("live2d-actions catalog", () => {
  it("contains at least one motion and one expression", () => {
    const motions = LIVE2D_ACTIONS.filter((a) => a.target.kind === "motion");
    const expressions = LIVE2D_ACTIONS.filter((a) => a.target.kind === "expression");
    expect(motions.length).toBeGreaterThan(0);
    expect(expressions.length).toBeGreaterThan(0);
  });

  it("has no duplicate aliases (case-insensitive)", () => {
    const seen = new Set<string>();
    for (const a of LIVE2D_ACTIONS) {
      const key = a.alias.toLowerCase();
      expect(seen.has(key), `duplicate alias: ${a.alias}`).toBe(false);
      seen.add(key);
    }
  });

  it("every alias has a non-empty description", () => {
    for (const a of LIVE2D_ACTIONS) {
      expect(a.description.length, `alias ${a.alias} has empty description`).toBeGreaterThan(0);
    }
  });

  it("motion targets carry both group and motionName", () => {
    for (const a of LIVE2D_ACTIONS) {
      if (a.target.kind === "motion") {
        expect(a.target.group.length).toBeGreaterThan(0);
        expect(a.target.motionName.length).toBeGreaterThan(0);
      }
    }
  });

  it("expression targets carry a name", () => {
    for (const a of LIVE2D_ACTIONS) {
      if (a.target.kind === "expression") {
        expect(a.target.name.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("findAction", () => {
  it("returns the matching action for an exact alias", () => {
    const found = findAction("眨眨眼");
    expect(found?.target.kind).toBe("motion");
    if (found?.target.kind === "motion") {
      expect(found.target.motionName).toBe("Wink~");
    }
  });

  it("is case-insensitive", () => {
    const lower = findAction("眨眨眼");
    expect(lower).toBeDefined();
  });

  it("returns undefined for an unknown alias", () => {
    expect(findAction("挥手")).toBeUndefined();
    expect(findAction("definitely-not-an-alias")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(findAction("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only input", () => {
    expect(findAction("   ")).toBeUndefined();
    expect(findAction("\t\n")).toBeUndefined();
  });

  it("every alias resolves via findAction", () => {
    for (const a of LIVE2D_ACTIONS) {
      expect(findAction(a.alias)?.alias).toBe(a.alias);
    }
  });
});