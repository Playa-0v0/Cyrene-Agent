import { describe, expect, test } from "vitest";
import type { ChatRequest } from "../vendors/types";
import { dispatchChatGeneration } from "./dispatcher";

const structuredRequest: ChatRequest = {
  model: "MiniMax-M3",
  messages: [{ role: "user", content: "decide" }],
  structuredOutput: {
    mode: "json_schema",
    name: "decision",
    schema: {
      type: "object",
      properties: { decision: { type: "string" } },
      required: ["decision"],
    },
    strict: true,
  },
};

describe("structured generation dispatcher (legacy-only)", () => {
  test("routes a structured official provider to legacy", async () => {
    const result = await dispatchChatGeneration({
      request: structuredRequest,
      provider: "chatgpt",
      endpointKind: "official",
      environment: {},
      legacy: async () => "legacy",
    });
    expect(result).toBe("legacy");
  });

  test("keeps ordinary requests on the existing adapter", async () => {
    const result = await dispatchChatGeneration({
      request: {
        model: "MiniMax-M3",
        messages: [{ role: "user", content: "hello" }],
      },
      provider: "chatgpt",
      endpointKind: "official",
      environment: {},
      legacy: async () => "legacy",
    });
    expect(result).toBe("legacy");
  });

  test("routes a non-official provider to legacy", async () => {
    const result = await dispatchChatGeneration({
      request: structuredRequest,
      provider: "minimax",
      endpointKind: "official",
      environment: {},
      legacy: async () => "legacy",
    });
    expect(result).toBe("legacy");
  });
});
