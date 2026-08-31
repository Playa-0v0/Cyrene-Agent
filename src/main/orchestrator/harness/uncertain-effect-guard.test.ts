import { describe, expect, it } from "vitest";
import {
  isBlockedByUncertainEffect,
  resolveUncertainEffect,
} from "./uncertain-effect-guard";
import type { AgentState } from "./types";

function state(): AgentState {
  return {
    todoItems: [],
    uncertainEffects: [{
      id: "effect-1",
      toolCallId: "call-old",
      fingerprint: "same-effect",
      toolName: "send_email",
      message: "outcome unknown",
    }],
  };
}

describe("UncertainEffectGuard", () => {
  it("blocks a matching fingerprint and allows a different one", () => {
    expect(isBlockedByUncertainEffect(state(), "same-effect")).toBe(true);
    expect(isBlockedByUncertainEffect(state(), "different")).toBe(false);
    expect(isBlockedByUncertainEffect({ todoItems: [], uncertainEffects: [] }, "same-effect")).toBe(false);
  });

  it("resolveUncertainEffect removes only the matching toolCallId", () => {
    const current = state();
    current.uncertainEffects.push({
      id: "effect-2",
      toolCallId: "call-other",
      fingerprint: "other-effect",
      toolName: "send_email",
      message: "outcome unknown",
    });

    resolveUncertainEffect(current, "call-old");
    expect(current.uncertainEffects).toHaveLength(1);
    expect(current.uncertainEffects[0].id).toBe("effect-2");

    // 解除后不再被拦截
    expect(isBlockedByUncertainEffect(current, "same-effect")).toBe(false);
    expect(isBlockedByUncertainEffect(current, "other-effect")).toBe(true);
  });
});
