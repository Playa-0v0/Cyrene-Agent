import { describe, expect, it } from "vitest";
import { versionTtsCacheKey } from "./tts-cache-key";

describe("versionTtsCacheKey", () => {
  it.each(["minimax", "gptsovits", "custom-cloud", "mimo", "mossland"])(
    "preserves the %s provider prefix",
    (provider) => {
      expect(versionTtsCacheKey(`${provider}-original`, "raw-v1")).toMatch(
        new RegExp(`^${provider}-[a-f0-9]{64}$`),
      );
    },
  );

  it("changes when the converter version changes", () => {
    const source = "minimax-original";
    expect(versionTtsCacheKey(source, "raw-v1")).not.toBe(versionTtsCacheKey(source, "markdown-v1"));
  });
});
