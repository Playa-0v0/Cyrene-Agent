import { describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../anthropic-adapter";
import type { ProviderCapability } from "../types";
import { AnthropicEventNormalizer, reconcileAnthropicTerminal } from "./anthropic-normalizer";
import type { StreamAccumulatorSnapshot } from "./types";

const capability: ProviderCapability = {
  id: "claude",
  displayName: "Claude",
  transport: "anthropic",
  baseUrl: "https://api.anthropic.com",
  authStyle: "x-api-key",
  defaultModel: "claude-test",
  supportsTools: true,
  supportsThinking: true,
  thinkingField: "thinking",
  cacheStrategy: "cache_control",
  testStrategy: "text",
  supportsVision: true,
};

describe("AnthropicEventNormalizer", () => {
  it("maps thinking, text, and signature events without leaking the signature", () => {
    const normalizer = new AnthropicEventNormalizer();

    expect(
      normalizer.normalize({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
    ).toEqual([]);
    expect(
      normalizer.normalize({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "分析中" },
      }),
    ).toEqual([{ type: "reasoning_delta", delta: "分析中" }]);
    expect(
      normalizer.normalize({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "secret-signature" },
      }),
    ).toEqual([]);
    expect(
      normalizer.normalize({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      }),
    ).toEqual([]);
    expect(
      normalizer.normalize({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "结果" },
      }),
    ).toEqual([{ type: "text_delta", delta: "结果" }]);
  });

  it("forwards partial tool JSON while leaving final assembly to the SDK", () => {
    const normalizer = new AnthropicEventNormalizer();

    expect(
      normalizer.normalize({
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "tool-1", name: "read_file", input: {} },
      }),
    ).toEqual([{ type: "tool_call_start", index: 2, id: "tool-1", nameDelta: "read_file" }]);
    expect(
      normalizer.normalize({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "{\"path\":" },
      }),
    ).toEqual([{ type: "tool_call_arguments_delta", index: 2, id: "tool-1", delta: "{\"path\":" }]);
    expect(
      normalizer.normalize({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "\"a.ts\"}" },
      }),
    ).toEqual([{ type: "tool_call_arguments_delta", index: 2, id: "tool-1", delta: "\"a.ts\"}" }]);
    expect(normalizer.normalize({ type: "content_block_stop", index: 2 })).toEqual([
      { type: "tool_call_end", index: 2, id: "tool-1" },
    ]);
  });

  it("maps split usage and terminal reason without inventing zero values", () => {
    const normalizer = new AnthropicEventNormalizer();

    expect(
      normalizer.normalize({
        type: "message_start",
        message: { usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 12 } },
      }),
    ).toEqual([{ type: "usage", inputTokens: 20, outputTokens: 0, cachedInputTokens: 12 }]);
    expect(
      normalizer.normalize({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 9 },
      }),
    ).toEqual([
      { type: "usage", outputTokens: 9 },
      { type: "finish", reason: "end_turn" },
    ]);
    expect(normalizer.normalize({ type: "message_stop" })).toEqual([]);
  });
});

describe("reconcileAnthropicTerminal", () => {
  it("uses the SDK final message as authority and preserves raw thinking signatures", () => {
    const adapter = new AnthropicAdapter("claude", capability);
    const finalMessage = {
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 9 },
      content: [
        { type: "thinking", thinking: "分析中", signature: "sig-1" },
        { type: "text", text: "我来读取" },
        { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.ts" } },
      ],
    };
    const live: StreamAccumulatorSnapshot = {
      text: "我来读取",
      thinking: "分析中",
      toolCalls: [
        { index: 2, id: "tool-1", name: "read_file", arguments: "{\"path\": \"a.ts\"}", ended: true },
      ],
      finishReason: "tool_use",
      usage: { input: 20, output: 9 },
    };
    const diagnostic = vi.fn();

    const response = reconcileAnthropicTerminal(live, finalMessage, adapter, diagnostic);

    expect(response.assistantMessage.rawAssistant).toEqual(finalMessage.content);
    expect(response.toolCalls).toEqual([
      { id: "tool-1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
    ]);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("reports content-safe mismatch diagnostics while retaining the SDK terminal result", () => {
    const adapter = new AnthropicAdapter("claude", capability);
    const diagnostic = vi.fn();
    const live: StreamAccumulatorSnapshot = {
      text: "live-secret-text",
      thinking: "live-secret-reasoning",
      toolCalls: [],
    };

    const response = reconcileAnthropicTerminal(
      live,
      {
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "terminal-reasoning", signature: "sig" },
          { type: "text", text: "terminal-text" },
        ],
      },
      adapter,
      diagnostic,
    );

    expect(response.text).toBe("terminal-text");
    expect(diagnostic).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(diagnostic.mock.calls[0][0]);
    expect(serialized).toContain("E_STREAM_TERMINAL_MISMATCH");
    expect(serialized).toContain("text_length");
    expect(serialized).not.toContain("live-secret");
    expect(serialized).not.toContain("terminal-text");
  });

  it("rejects malformed terminal tool blocks before execution", () => {
    const adapter = new AnthropicAdapter("claude", capability);

    expect(() =>
      reconcileAnthropicTerminal(
        { text: "", toolCalls: [] },
        {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "", name: "read_file", input: { path: "a.ts" } }],
        },
        adapter,
      ),
    ).toThrowError(expect.objectContaining({ code: "E_TOOL_CALL_INCOMPLETE" }));
  });
});
