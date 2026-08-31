import { describe, expect, it } from "vitest";
import { isSkillAllowedForRun } from "./skill-tools";

describe("Skill run allowlist", () => {
  it("rejects a globally known skill outside the current mode snapshot", () => {
    expect(isSkillAllowedForRun("code-only", new Set(["work-only"]))).toBe(false);
  });

  it("allows a skill included in the current mode snapshot", () => {
    expect(isSkillAllowedForRun("work-only", new Set(["work-only"]))).toBe(true);
  });
});
