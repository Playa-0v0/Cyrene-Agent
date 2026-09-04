import { describe, expect, it, vi } from "vitest";

vi.mock("../../../prompts/prompt-loader", () => ({
  loadPromptFile: vi.fn(() => "## 工具使用\n主动调用"),
}));

import {
  buildHarnessPromptLayers,
  buildHarnessSystemPrompt,
  materializeHarnessStartTranscript,
} from "./prompt-builder";

describe("harness prompt builder", () => {
  it("keeps recovery context outside the stable prefix", () => {
    const layers = buildHarnessPromptLayers({
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
      recoveryContext: "恢复证据",
      responseContext: "响应引用",
    } as never);

    expect(layers.stablePrefix).not.toContain("RECOVERY_CONTEXT");
    expect(layers.stablePrefix).not.toContain("RESPONSE_CONTEXT");
    expect(layers.runtimeContext).toContain("恢复证据");
    expect(layers.runtimeContext).toContain("响应引用");
  });

  it("does not inject tool usage policy into chat mode", () => {
    const prompt = buildHarnessSystemPrompt({
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
      conversationMode: "chat",
    } as never);

    expect(prompt).not.toContain("工具使用");
  });

  it("materializes runtime context as one internal transcript message", () => {
    const messages = materializeHarnessStartTranscript({
      messages: [{ role: "user", content: "继续" }],
      runId: "run-prompt",
      runtimeContext: "[RECOVERY_CONTEXT]\n恢复证据",
      kind: "recovery",
    } as never);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "user",
      content: "[RECOVERY_CONTEXT]\n恢复证据",
      internal: {
        kind: "recovery",
        revision: 1,
        runId: "run-prompt",
      },
    });
  });
});
