import { beforeEach, describe, expect, it, vi } from "vitest";

const { trace, runHarness, runStore, reviewTracker } = vi.hoisted(() => ({
  trace: [] as string[],
  runHarness: vi.fn(),
  runStore: {
    create: vi.fn(),
    checkpoint: vi.fn(),
    recordTool: vi.fn(),
    recordCompaction: vi.fn(),
    markTerminal: vi.fn(),
  },
  reviewTracker: {
    finalizeReview: vi.fn(),
  },
}));

vi.mock("./harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./harness")>();
  return { ...actual, runCyreneHarness: runHarness };
});

vi.mock("./harness/run-store", () => ({
  getHarnessRunStore: vi.fn(() => runStore),
}));

vi.mock("./review/run-review-tracker", () => ({
  getRunReviewTracker: vi.fn(() => reviewTracker),
}));

vi.mock("./tools/registry/tool-registry", () => ({
  toolRegistry: {
    getEnabledTools: vi.fn(() => []),
    getById: vi.fn(),
  },
}));

vi.mock("../prompts/prompt-loader", () => ({
  loadPromptFile: vi.fn(() => "runtime policy"),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "C:\\cyrene-characterization") },
}));

import { runHarnessWithAdapter } from "./harness-adapter";

describe("harness-adapter characterization", () => {
  beforeEach(() => {
    trace.length = 0;
    runHarness.mockReset();
    runStore.create.mockReset();
    runStore.checkpoint.mockReset();
    runStore.recordTool.mockReset();
    runStore.recordCompaction.mockReset();
    runStore.markTerminal.mockReset();
    reviewTracker.finalizeReview.mockReset();

    runStore.create.mockImplementation(() => trace.push("runStore.create"));
    runStore.markTerminal.mockImplementation(() => {
      trace.push("runStore.markTerminal");
      return { createdAt: 1 };
    });
    reviewTracker.finalizeReview.mockImplementation(() => trace.push("review.finalizeReview"));
    runHarness.mockImplementation(async () => {
      trace.push("runHarness");
      return {
        finalAnswer: "完成",
        finalState: { todoItems: [], uncertainEffects: [] },
        terminated: true,
        rounds: 1,
      };
    });
  });

  it("preserves create, run, terminal, review, and return order", async () => {
    const result = await runHarnessWithAdapter({
      runId: "run-characterization",
      settings: {
        provider: "test",
        baseUrl: "",
        model: "test-model",
        apiKey: "",
        contextWindowTokens: 256_000,
      },
      messages: [{ role: "user", content: "执行" }],
      toolSystemContent: "",
      soulSystemBaseContent: "persona",
      executionMode: "work",
      conversationMode: "work",
    } as never, new AbortController().signal, () => undefined);

    trace.push("return");
    expect(result.reply).toBe("完成");
    expect(trace).toEqual([
      "runStore.create",
      "runHarness",
      "runStore.markTerminal",
      "review.finalizeReview",
      "return",
    ]);
  });
});
