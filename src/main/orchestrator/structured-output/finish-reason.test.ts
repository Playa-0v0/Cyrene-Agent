import { describe, expect, test } from "vitest";
import { normalizeFinishReason } from "./finish-reason";

describe("normalizeFinishReason", () => {
  test.each([
    ["stop", "complete"],
    ["end_turn", "complete"],
    ["stop_sequence", "complete"],
    ["length", "truncated"],
    ["max_tokens", "truncated"],
    ["tool_calls", "tool_call"],
    ["tool_use", "tool_call"],
    ["content_filter", "content_filtered"],
    ["refusal", "refused"],
    ["pause_turn", "unknown"],
    [undefined, "unknown"],
    ["provider_new_value", "unknown"],
  ] as const)("%s -> %s", (input, expected) => {
    expect(normalizeFinishReason(input)).toBe(expected);
  });
});

