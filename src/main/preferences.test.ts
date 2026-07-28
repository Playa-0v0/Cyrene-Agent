import { describe, expect, it } from "vitest";
import {
  normalizeChatSocialContextEnabled,
  normalizeProactiveChatMode,
  normalizeProactiveDeliveryTarget,
  normalizeDefaultChatMode,
  normalizeSegmentedOutputMode,
} from "../shared/preferences";

describe("preferences", () => {
  it("keeps chat social context opt-in and accepts only an explicit boolean true", () => {
    expect(normalizeChatSocialContextEnabled(undefined)).toBe(false);
    expect(normalizeChatSocialContextEnabled("true")).toBe(false);
    expect(normalizeChatSocialContextEnabled(false)).toBe(false);
    expect(normalizeChatSocialContextEnabled(true)).toBe(true);
  });

  it("defaults to work and migrates legacy collab/talk values", () => {
    expect(normalizeDefaultChatMode(undefined)).toBe("work");
    expect(normalizeDefaultChatMode("bad")).toBe("work");
    expect(normalizeDefaultChatMode("work")).toBe("work");
    expect(normalizeDefaultChatMode("chat")).toBe("chat");
    expect(normalizeDefaultChatMode("collab")).toBe("work");
    expect(normalizeDefaultChatMode("talk")).toBe("chat");
  });

  it("normalizes segmented output placeholder mode", () => {
    expect(normalizeSegmentedOutputMode(undefined)).toBe("off");
    expect(normalizeSegmentedOutputMode("bad")).toBe("off");
    expect(normalizeSegmentedOutputMode("all")).toBe("all");
    expect(normalizeSegmentedOutputMode("chat")).toBe("chat");
    expect(normalizeSegmentedOutputMode("off")).toBe("off");
  });

  it("normalizes proactive chat placeholder mode", () => {
    expect(normalizeProactiveChatMode(undefined)).toBe("off");
    expect(normalizeProactiveChatMode("bad")).toBe("off");
    expect(normalizeProactiveChatMode("on")).toBe("on");
    expect(normalizeProactiveChatMode("off")).toBe("off");
  });

  it("normalizes proactive delivery target to local by default", () => {
    expect(normalizeProactiveDeliveryTarget("local")).toBe("local");
    expect(normalizeProactiveDeliveryTarget("wechat")).toBe("wechat");
    expect(normalizeProactiveDeliveryTarget("feishu")).toBe("feishu");
    expect(normalizeProactiveDeliveryTarget(undefined)).toBe("local");
    expect(normalizeProactiveDeliveryTarget("")).toBe("local");
    expect(normalizeProactiveDeliveryTarget("unknown")).toBe("local");
  });
});
