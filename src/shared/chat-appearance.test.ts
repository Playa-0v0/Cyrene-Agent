import { describe, expect, it } from "vitest";
import { normalizeChatAppearance } from "./chat-appearance";

describe("normalizeChatAppearance", () => {
  it("keeps Cyrene reply bubbles enabled for existing settings", () => {
    expect(normalizeChatAppearance({ chatLineHeight: 1.6 })).toEqual({
      chatLineHeight: 1.6,
      assistantBubbleEnabled: true,
    });
  });

  it("preserves an explicit global Cyrene reply bubble choice", () => {
    expect(normalizeChatAppearance({
      chatLineHeight: 1.75,
      assistantBubbleEnabled: false,
    })).toEqual({
      chatLineHeight: 1.75,
      assistantBubbleEnabled: false,
    });
  });
});
