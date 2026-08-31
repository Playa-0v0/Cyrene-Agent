import { describe, expect, test } from "vitest";
import {
  resolveStructuredOutputBackend,
  runStructuredGeneration,
} from "./backend";

describe("structured output backend (legacy-only)", () => {
  test.each([
    "chatgpt",
    "claude",
    "deepseek",
    "minimax",
    "kimi",
    "doubao",
    "qwen",
    "glm",
    "mimo",
    "unknown",
  ] as const)("always resolves %s to legacy", async (provider) => {
    const backend = resolveStructuredOutputBackend({
      provider,
      endpointKind: "official",
    }, {});
    expect(backend).toBe("legacy");
  });

  test("runs legacy callback exclusively", async () => {
    const result = await runStructuredGeneration({
      legacy: async () => "legacy",
    });
    expect(result).toBe("legacy");
  });

  test.each(["custom", "local"] as const)(
    "keeps a ChatGPT-labelled %s endpoint on legacy",
    async (endpointKind) => {
      const backend = resolveStructuredOutputBackend({
        provider: "chatgpt",
        endpointKind,
      }, {});
      expect(backend).toBe("legacy");
    },
  );
});
