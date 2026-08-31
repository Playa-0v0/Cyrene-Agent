import { describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  getAdapterForConfig,
  resolveTransport,
  type ChatRequest,
  type ProviderCapability,
  type VendorConfig,
} from "../index";
import { deriveAnthropicClientConfig, deriveOpenAIClientConfig } from "./client-config";
import { AnthropicEventNormalizer } from "./anthropic-normalizer";
import { normalizeOpenAIChunk } from "./openai-normalizer";

function configFor(capability: ProviderCapability, explicitTransport?: "openai" | "anthropic"): VendorConfig {
  return {
    provider: capability.displayName,
    baseUrl: capability.baseUrl,
    model: capability.defaultModel || "configured-model",
    apiKey: "test-key",
    explicitTransport,
  };
}

const request: ChatRequest = {
  model: "configured-model",
  messages: [{ role: "user", content: "hello" }],
  tools: [{ name: "weather", description: "weather", parameters: { type: "object" } }],
};

describe("built-in provider SDK stream contracts", () => {
  it.each(PROVIDER_CAPABILITIES)("preserves $displayName request body and configured default transport", (capability) => {
    const config = configFor(capability);
    const adapter = getAdapterForConfig(config);
    const http = adapter.buildStreamRequest(request, config);
    const body = JSON.parse(http.body) as Record<string, unknown>;

    expect(resolveTransport(config)).toBe(capability.transport);
    expect(adapter.transport).toBe(capability.transport);
    expect(body).toMatchObject({ model: "configured-model", stream: true });
    expect(http.url).toMatch(
      capability.transport === "openai"
        ? /\/chat\/completions$/
        : capability.transport === "responses"
          ? /\/responses$/
          : /\/v1\/messages$/,
    );
    expect(body.tools).toBeDefined();
  });

  it.each(PROVIDER_CAPABILITIES.filter((capability) => capability.transport === "openai"))(
    "normalizes $displayName OpenAI-compatible text/reasoning/tool finish fields",
    (capability) => {
      const reasoningField = capability.thinkingField === "thinking" ? "thinking" : "reasoning_content";
      const deltas = normalizeOpenAIChunk({
        choices: [{
          delta: {
            content: `${capability.id}-text`,
            [reasoningField]: `${capability.id}-reasoning`,
            tool_calls: [{
              index: 0,
              id: `${capability.id}-tool`,
              function: { name: "weather", arguments: "{\"city\":\"北京\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });

      expect(deltas).toContainEqual({ type: "text_delta", delta: `${capability.id}-text` });
      expect(deltas).toContainEqual({ type: "reasoning_delta", delta: `${capability.id}-reasoning` });
      expect(deltas).toContainEqual({ type: "tool_call_start", index: 0, id: `${capability.id}-tool`, nameDelta: "weather" });
      expect(deltas).toContainEqual({ type: "tool_call_arguments_delta", index: 0, id: `${capability.id}-tool`, delta: "{\"city\":\"北京\"}" });
      expect(deltas).toContainEqual({ type: "usage", inputTokens: 3, outputTokens: 2 });
      expect(deltas).toContainEqual({ type: "finish", reason: "tool_calls" });
    },
  );

  it("normalizes Claude text, thinking, fragmented tool JSON, and finish", () => {
    const normalizer = new AnthropicEventNormalizer();
    const deltas = [
      ...normalizer.normalize({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      ...normalizer.normalize({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } }),
      ...normalizer.normalize({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      ...normalizer.normalize({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
      ...normalizer.normalize({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "claude-tool", name: "weather" } }),
      ...normalizer.normalize({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"city\":" } }),
      ...normalizer.normalize({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"北京\"}" } }),
      ...normalizer.normalize({ type: "content_block_stop", index: 2 }),
      ...normalizer.normalize({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }),
    ];

    expect(deltas).toContainEqual({ type: "reasoning_delta", delta: "reason" });
    expect(deltas).toContainEqual({ type: "text_delta", delta: "answer" });
    expect(deltas).toContainEqual({ type: "tool_call_start", index: 2, id: "claude-tool", nameDelta: "weather" });
    expect(deltas.filter((delta) => delta.type === "tool_call_arguments_delta")).toHaveLength(2);
    expect(deltas).toContainEqual({ type: "tool_call_end", index: 2, id: "claude-tool" });
    expect(deltas).toContainEqual({ type: "finish", reason: "tool_use" });
  });

  it("uses Anthropic by default for MiniMax while keeping MiMo opt-in", () => {
    const miniMax = PROVIDER_CAPABILITIES.find((capability) => capability.id === "minimax")!;
    const mimo = PROVIDER_CAPABILITIES.find((capability) => capability.id === "mimo")!;
    const miniMaxConfig = { ...configFor(miniMax, "anthropic"), baseUrl: "https://api.minimaxi.com/anthropic" };
    const mimoConfig = { ...configFor(mimo, "anthropic"), baseUrl: "https://api.xiaomimimo.com/anthropic" };

    expect(getAdapterForConfig({ ...configFor(miniMax), explicitTransport: undefined }).transport).toBe("anthropic");
    expect(getAdapterForConfig(miniMaxConfig).transport).toBe("anthropic");
    expect(getAdapterForConfig(mimoConfig).transport).toBe("anthropic");
    expect(deriveAnthropicClientConfig("https://api.minimaxi.com/anthropic/v1/messages", "key", "x-api-key"))
      .toMatchObject({ apiKey: "key", maxRetries: 0 });
    expect(deriveAnthropicClientConfig("https://api.xiaomimimo.com/anthropic/v1/messages", "key", "bearer"))
      .toMatchObject({ authToken: "key", maxRetries: 0 });
    expect(deriveOpenAIClientConfig("https://api.minimaxi.com/v1/chat/completions", "key"))
      .toMatchObject({ baseURL: "https://api.minimaxi.com/v1", maxRetries: 0 });
  });
});
