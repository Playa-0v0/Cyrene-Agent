import { describe, expect, it } from "vitest";
import { applyScheduledExecutionPolicy } from "./scheduler-runner";

describe("scheduled Cyrene execution policy", () => {
  it("runs unattended Work Harness with no interactive tools or approval", () => {
    const options = applyScheduledExecutionPolicy({
      settings: {
        provider: "test",
        baseUrl: "",
        model: "test-model",
        apiKey: "",
        contextWindowTokens: 256_000,
      },
      messages: [{ role: "user", content: "整理今天的资料" }],
      timeoutMs: 60_000,
      toolSystemContent: "work tools",
      soulSystemBaseContent: "work persona",
    });

    expect(options).toMatchObject({
      executionMode: "work",
      conversationMode: "work",
      harnessInteractiveTools: false,
      permissionMode: "allow_all",
    });
    expect(options.messages).toEqual([{ role: "user", content: "整理今天的资料" }]);
  });
});
