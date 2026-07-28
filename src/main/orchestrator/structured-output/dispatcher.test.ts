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

describe("structured generation dispatcher", () => {
  test("routes a supported official provider to LangChain", async () => {
    const result = await dispatchChatGeneration({
      request: structuredRequest,
      provider: "chatgpt",
      endpointKind: "official",
      environment: {},
      langchain: async () => "langchain",
      legacy: async () => "legacy",
    });

    expect(result).toBe("langchain");
  });

  test("keeps ordinary Soul and Native FC requests on the existing adapter", async () => {
    const result = await dispatchChatGeneration({
      request: {
        model: "MiniMax-M3",
        messages: [{ role: "user", content: "hello" }],
      },
      provider: "chatgpt",
      endpointKind: "official",
      environment: {},
      langchain: async () => "langchain",
      legacy: async () => "legacy",
    });

    expect(result).toBe("legacy");
  });

  test("routes a profiled non-LangChain provider to the legacy structured pipeline", async () => {
    const result = await dispatchChatGeneration({
      request: structuredRequest,
      provider: "minimax",
      endpointKind: "official",
      environment: {},
      langchain: async () => "langchain",
      legacy: async () => "legacy",
    });

    expect(result).toBe("legacy");
  });
});
