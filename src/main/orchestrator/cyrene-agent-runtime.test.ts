import { describe, expect, it } from "vitest";
import { resolveAgentRuntime, resolveExecutionMode } from "./cyrene-agent";

describe("resolveAgentRuntime", () => {
  it("uses LangGraph by default and keeps an explicit legacy rollback", () => {
    expect(resolveAgentRuntime(undefined)).toBe("langgraph");
    expect(resolveAgentRuntime("langgraph")).toBe("langgraph");
    expect(resolveAgentRuntime("legacy")).toBe("legacy");
  });
});

describe("resolveExecutionMode", () => {
  it("uses Work by default and migrates legacy execution mode names", () => {
    expect(resolveExecutionMode(undefined)).toBe("work");
    expect(resolveExecutionMode("work")).toBe("work");
    expect(resolveExecutionMode("chat")).toBe("chat");
    expect(resolveExecutionMode("collaboration")).toBe("work");
    expect(resolveExecutionMode("soul-only")).toBe("chat");
  });
});
