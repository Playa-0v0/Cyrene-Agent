import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("tools_system music contract", () => {
  it("uses opaque candidateRef instead of obsolete provider ids", () => {
    const prompt = readFileSync(join(process.cwd(), "prompts", "tools_system.md"), "utf8");

    expect(prompt).toContain("candidateRef");
    expect(prompt).not.toContain("必须同时使用真实候选返回的 `provider`、`setId`、`trackId`");
  });
});
