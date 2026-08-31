import { describe, expect, it } from "vitest";
import { normalizeOpenAIChunk } from "./openai-normalizer";

describe("normalizeOpenAIChunk", () => {
  it("maps standard text, refusal, usage, and finish fields", () => {
    expect(
      normalizeOpenAIChunk({
        choices: [
          {
            delta: { role: "assistant", content: "hello", refusal: "policy" },
            finish_reason: "content_filter",
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 4,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 7 },
        },
      }),
    ).toEqual([
      { type: "text_delta", delta: "hello" },
      { type: "refusal", reason: "policy" },
      { type: "usage", inputTokens: 11, outputTokens: 4, cachedInputTokens: 7 },
      { type: "finish", reason: "content_filter" },
    ]);
  });

  it.each([
    ["reasoning_content", { reasoning_content: "deepseek" }, "deepseek"],
    ["reasoning", { reasoning: "kimi" }, "kimi"],
    ["thinking", { thinking: "glm" }, "glm"],
    [
      "reasoning_details",
      { reasoning_details: [{ type: "reasoning.text", text: "mini" }, { type: "encrypted", data: "secret" }] },
      "mini",
    ],
  ])("maps the %s extension to reasoning deltas", (_name, delta, expected) => {
    expect(normalizeOpenAIChunk({ choices: [{ delta, finish_reason: null }] })).toEqual([
      { type: "reasoning_delta", delta: expected },
    ]);
  });

  it("preserves tool-call indexes and emits only name and argument fragments", () => {
    expect(
      normalizeOpenAIChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call-1",
                  type: "function",
                  function: { name: "read_", arguments: "{\"path\":" },
                },
                {
                  index: 0,
                  id: "call-0",
                  type: "function",
                  function: { name: "search", arguments: "{\"q\":" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    ).toEqual([
      { type: "tool_call_start", index: 1, id: "call-1", nameDelta: "read_" },
      { type: "tool_call_arguments_delta", index: 1, id: "call-1", delta: "{\"path\":" },
      { type: "tool_call_start", index: 0, id: "call-0", nameDelta: "search" },
      { type: "tool_call_arguments_delta", index: 0, id: "call-0", delta: "{\"q\":" },
    ]);
  });

  it("keeps repeated ids intact and accepts split function names", () => {
    expect(
      normalizeOpenAIChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call-0", function: { name: "code_", arguments: "" } },
                { index: 1, function: { name: "read", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      { type: "tool_call_start", index: 0, id: "call-0", nameDelta: "code_" },
      { type: "tool_call_start", index: 1, nameDelta: "read" },
      { type: "tool_call_arguments_delta", index: 1, delta: "{}" },
    ]);
  });

  it("emits no deltas for role-only and malformed chunks", () => {
    expect(normalizeOpenAIChunk({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })).toEqual([]);
    expect(normalizeOpenAIChunk(null)).toEqual([]);
    expect(normalizeOpenAIChunk({ choices: "not-an-array" })).toEqual([]);
  });

  it("retains usage from the terminal usage-only chunk emitted by OpenAI-compatible APIs", () => {
    expect(
      normalizeOpenAIChunk({
        choices: [],
        usage: { prompt_tokens: 21, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 13 } },
      }),
    ).toEqual([{ type: "usage", inputTokens: 21, outputTokens: 8, cachedInputTokens: 13 }]);
  });
});
