import { describe, expect, it } from "vitest";
import { normalizeToolExecutionOutcome } from "./tool-outcome-normalizer";
import type { ToolExecutionOutcome } from "./types";

describe("normalizeToolExecutionOutcome", () => {
  it("defaults succeeded to terminal=true, retryable=false", () => {
    const outcome: ToolExecutionOutcome = {
      status: "succeeded",
      output: "ok",
    };
    expect(normalizeToolExecutionOutcome(outcome)).toEqual({
      status: "succeeded",
      output: "ok",
      terminal: true,
      retryable: false,
    });
  });

  it("defaults failed to terminal=true, retryable=false (修订第1点：失败也算已结束)", () => {
    const outcome: ToolExecutionOutcome = {
      status: "failed",
      output: "E_TOOL_ARGS_INVALID",
      errorCode: "E_TOOL_ARGS_INVALID",
    };
    // 参数错误等失败默认不可重试
    const normalized = normalizeToolExecutionOutcome(outcome);
    expect(normalized.terminal).toBe(true);
    expect(normalized.retryable).toBe(false);
  });

  it("preserves explicit terminal=false from the tool", () => {
    const outcome: ToolExecutionOutcome = {
      status: "succeeded",
      output: "listening started",
      terminal: false,
    };
    expect(normalizeToolExecutionOutcome(outcome).terminal).toBe(false);
  });

  it("preserves explicit retryable=true for transient errors", () => {
    const outcome: ToolExecutionOutcome = {
      status: "failed",
      output: "network timeout",
      errorCode: "E_NETWORK_TIMEOUT",
      retryable: true,
    };
    const normalized = normalizeToolExecutionOutcome(outcome);
    expect(normalized.terminal).toBe(true);
    expect(normalized.retryable).toBe(true);
  });

  it("keeps original output/errorCode/status untouched", () => {
    const outcome: ToolExecutionOutcome = {
      status: "failed",
      output: "detail",
      errorCode: "E_X",
    };
    const normalized = normalizeToolExecutionOutcome(outcome);
    expect(normalized.output).toBe("detail");
    expect(normalized.errorCode).toBe("E_X");
    expect(normalized.status).toBe("failed");
  });
});
