import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChatLoop } from "./chat-loop";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatVendorAdapter,
  HttpRequest,
  ProviderCapability,
  ToolExecutionResult,
} from "./vendors/types";

const capability: ProviderCapability = {
  id: "test",
  displayName: "test",
  transport: "openai",
  baseUrl: "https://test/",
  authStyle: "bearer",
  defaultModel: "m",
  supportsTools: true,
  supportsThinking: false,
  thinkingField: null,
  cacheStrategy: "none",
  testStrategy: "text",
  supportsVision: false,
};

class FakeAdapter implements ChatVendorAdapter {
  readonly id = "test";
  readonly transport = "openai" as const;
  capability = capability;
  readonly requests: ChatRequest[] = [];

  buildRequest(req: ChatRequest): HttpRequest {
    this.requests.push(req);
    return { url: "https://fake/", method: "POST", headers: {}, body: "{}" };
  }

  parseResponse(): ChatResponse {
    return {
      assistantMessage: { role: "assistant", content: "只是陪你聊聊。" },
      text: "只是陪你聊聊。",
      toolCalls: [],
      finishReason: "stop",
      raw: {},
      usage: { input: 12, output: 6 },
    };
  }

  appendToolResults(messages: ChatMessage[], _results: ToolExecutionResult[]): ChatMessage[] {
    return messages;
  }

  buildStreamRequest(req: ChatRequest): HttpRequest {
    return this.buildRequest(req);
  }

  parseStreamEvent(): null {
    return null;
  }

  async testConnection() {
    return { ok: true, latency: 0 };
  }
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

describe("runChatLoop", () => {
  it("makes one plain Soul request without tools or structured output", async () => {
    const adapter = new FakeAdapter();
    const onEvent = vi.fn();
    const recordUsage = vi.fn();

    const result = await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      messages: [{ role: "user", content: "陪我聊聊" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      soulSampling: { temperature: 0.82, frequencyPenalty: 0.2 },
      timeoutMs: 30_000,
      onEvent,
      recordUsage,
    });

    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].messages[0]).toEqual({ role: "system", content: "SOUL_SYSTEM" });
    expect(adapter.requests[0].messages[1]).toEqual({ role: "user", content: "陪我聊聊" });
    expect(adapter.requests[0].tools).toBeUndefined();
    expect(adapter.requests[0].structuredOutput).toBeUndefined();
    expect(adapter.requests[0].temperature).toBe(0.82);
    expect(adapter.requests[0].frequencyPenalty).toBe(0.2);
    expect(result.toolResults).toEqual([]);
    expect(result.reply).toBe("只是陪你聊聊。");
    expect(result.totalUsage).toEqual({ input: 12, output: 6 });
    expect(recordUsage).toHaveBeenCalledWith(12, 6, 1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "text_message_start" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "text_message_end" }));
  });
});
