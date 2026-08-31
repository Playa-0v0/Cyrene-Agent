import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyChatAppearance } from "./useChatAppearance";

describe("applyChatAppearance", () => {
  const setProperty = vi.fn();
  const dataset: Record<string, string> = {};

  beforeEach(() => {
    setProperty.mockReset();
    for (const key of Object.keys(dataset)) delete dataset[key];
    vi.stubGlobal("document", {
      documentElement: {
        dataset,
        style: { setProperty },
      },
    });
  });

  it("applies the global bubble-off state without changing message data", () => {
    applyChatAppearance({
      chatLineHeight: 1.6,
      assistantBubbleEnabled: false,
    });

    expect(setProperty).toHaveBeenCalledWith("--cy-chat-line-height", "1.6");
    expect(dataset.assistantBubble).toBe("off");
  });

  it("defaults existing settings to bubbles on", () => {
    applyChatAppearance({ chatLineHeight: 1.75 });

    expect(dataset.assistantBubble).toBe("on");
  });
});
