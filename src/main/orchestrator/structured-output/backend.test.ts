import { describe, expect, test } from "vitest";
import {
  resolveStructuredOutputBackend,
  runStructuredGeneration,
} from "./backend";

describe("structured output backend", () => {
  test.each([
    ["chatgpt", "langchain"],
    ["claude", "langchain"],
    ["deepseek", "legacy"],
    ["minimax", "legacy"],
    ["kimi", "legacy"],
    ["doubao", "legacy"],
    ["qwen", "legacy"],
    ["glm", "legacy"],
    ["mimo", "legacy"],
    ["unknown", "legacy"],
  ] as const)("routes official %s structured output to %s", async (provider, expected) => {
    const result = await runStructuredGeneration({
      backend: resolveStructuredOutputBackend({
        provider,
        endpointKind: "official",
      }, {}),
      langchain: async () => "langchain",
      legacy: async () => "legacy",
    });

    expect(result).toBe(expected);
  });

  test("allows the emergency switch to restore legacy for a LangChain provider", async () => {
    const result = await runStructuredGeneration({
      backend: resolveStructuredOutputBackend({
        provider: "chatgpt",
        endpointKind: "official",
      }, {
        CYRENE_LEGACY_STRUCTURED_OUTPUT: "1",
      }),
      langchain: async () => "langchain",
      legacy: async () => "legacy",
    });

    expect(result).toBe("legacy");
  });

  test.each(["custom", "local"] as const)(
    "keeps a ChatGPT-labelled %s endpoint on the legacy D profile path",
    async (endpointKind) => {
      const result = await runStructuredGeneration({
        backend: resolveStructuredOutputBackend({
          provider: "chatgpt",
          endpointKind,
        }, {}),
        langchain: async () => "langchain",
        legacy: async () => "legacy",
      });

      expect(result).toBe("legacy");
    },
  );

  test("does not silently fall back to legacy when LangChain fails", async () => {
    let legacyExecuted = false;

    await expect(runStructuredGeneration({
      backend: resolveStructuredOutputBackend({
        provider: "chatgpt",
        endpointKind: "official",
      }, {}),
      langchain: async () => {
        throw new Error("langchain failed");
      },
      legacy: async () => {
        legacyExecuted = true;
        return "legacy";
      },
    })).rejects.toThrow("langchain failed");

    expect(legacyExecuted).toBe(false);
  });
});
