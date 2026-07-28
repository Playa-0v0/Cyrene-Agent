import { describe, expect, test } from "vitest";
import type { ChatRequest, VendorConfig } from "../vendors/types";
import { invokeLangChainStructured } from "./langchain-invoker";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["respond"] },
  },
  required: ["decision"],
};

const request: ChatRequest = {
  model: "MiniMax-M3",
  messages: [
    { role: "system", content: "Return a decision." },
    { role: "user", content: "Say hello." },
  ],
  stream: false,
  structuredOutput: {
    mode: "json_schema",
    name: "action_decision",
    schema,
    strict: true,
  },
};

const config: VendorConfig = {
  provider: "minimax",
  model: "MiniMax-M3",
  baseUrl: "https://api.minimaxi.com/v1",
  apiKey: "test-key",
};

describe("LangChain structured invoker", () => {
  test("uses LangChain's dedicated DeepSeek model for DeepSeek V4", async () => {
    let modelClassName = "";
    await invokeLangChainStructured({
      ...request,
      model: "deepseek-v4-flash",
    }, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
    }, undefined, {
      createAgent: (options) => {
        modelClassName = options.model.constructor.name;
        return {
          invoke: async () => ({
            structuredResponse: { decision: "respond" },
          }),
        };
      },
    });

    expect(modelClassName).toBe("ChatDeepSeek");
  });

  test("returns the structuredResponse through the existing generation contract", async () => {
    const result = await invokeLangChainStructured(request, config, undefined, {
      createModel: () => ({}) as never,
      createAgent: (options) => {
        expect(options.tools).toEqual([]);
        expect(options.responseFormat).toBe(schema);
        expect(options.systemPrompt).toBe("Return a decision.");
        return {
          invoke: async (input) => {
            expect(input.messages).toEqual([
              { role: "user", content: "Say hello." },
            ]);
            return {
              structuredResponse: { decision: "respond" },
            };
          },
        };
      },
    });

    expect(result).toEqual({
      text: "{\"decision\":\"respond\"}",
      finishReason: "stop",
      structuredValue: { decision: "respond" },
    });
  });

  test("fails instead of inventing text when LangChain has no structured response", async () => {
    await expect(invokeLangChainStructured(request, config, undefined, {
      createModel: () => ({}) as never,
      createAgent: () => ({
        invoke: async () => ({ messages: [] }),
      }),
    })).rejects.toThrow("LANGCHAIN_STRUCTURED_RESPONSE_MISSING");
  });
});
