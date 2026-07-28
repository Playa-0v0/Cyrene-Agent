import { describe, expect, it, vi } from "vitest";
import { CyreneAgent, classifyRunError } from "./cyrene-agent";
import { AgentRuntimeError } from "./agent-runtime-error";
import { AgentExecutionError } from "./run-execution-status";
import { runTwoPhaseFcLoop } from "./two-phase-fc-loop";
import { runLangGraphAgentLoop } from "./langgraph-agent-loop";
import { requestUserClarification } from "../user-choice";

vi.mock("./vendors", () => ({
  getAdapterForConfig: vi.fn(() => ({ id: "fake-adapter" })),
}));

vi.mock("./tool-registry", () => ({
  toolRegistry: {
    getEnabledTools: vi.fn(() => []),
    getById: vi.fn(),
  },
}));

vi.mock("../permission", () => ({
  checkPermission: vi.fn(),
}));

vi.mock("./two-phase-fc-loop", () => ({
  runTwoPhaseFcLoop: vi.fn(async () => ({
    reply: "done",
    toolResults: [],
    soulPhaseReason: "no_tool",
  })),
}));

vi.mock("./langgraph-agent-loop", () => ({
  runLangGraphAgentLoop: vi.fn(async () => ({
    reply: "done",
    toolResults: [],
    soulPhaseReason: "no_tool",
  })),
}));

vi.mock("../user-choice", () => ({
  requestUserClarification: vi.fn(),
}));

describe("CyreneAgent", () => {
  it("passes CyreneRunOptions.soulSampling through to runTwoPhaseFcLoop", async () => {
    const agent = new CyreneAgent({ threadId: "test-thread" });
    const soulSampling = { temperature: 0.9, frequencyPenalty: 0.2 };

    await new Promise<void>((resolve, reject) => {
      agent.runWithEvents({
        settings: {
          provider: "test",
          baseUrl: "https://test",
          model: "m",
          apiKey: "k",
        },
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 1000,
        tools: [],
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
        soulSampling,
        executionMode: "work",
        agentRuntime: "legacy",
      }).subscribe({
        complete: resolve,
        error: reject,
      });
    });

    expect(runTwoPhaseFcLoop).toHaveBeenCalledWith(expect.objectContaining({
      soulSampling,
    }));
  });

  it("wires the AG-UI choice-card callback into the LangGraph runtime", async () => {
    const agent = new CyreneAgent({ threadId: "test-thread" });

    await new Promise<void>((resolve, reject) => {
      agent.runWithEvents({
        settings: {
          provider: "test",
          baseUrl: "https://test",
          model: "m",
          apiKey: "k",
        },
        messages: [{ role: "user", content: "播放这首歌" }],
        timeoutMs: 1000,
        tools: [],
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
        executionMode: "work",
        agentRuntime: "langgraph",
      }).subscribe({
        complete: resolve,
        error: reject,
      });
    });

    expect(runLangGraphAgentLoop).toHaveBeenCalledWith(expect.objectContaining({
      requestUserClarification,
    }));
  });
});

describe("classifyRunError", () => {
  it("returns user_cancelled with empty message when source is user_cancelled", () => {
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      "user_cancelled",
      "run-1", "conv-1", "soul", true,
    );
    expect(result.source).toBe("user_cancelled");
    expect(result.userMessage).toBe("");
  });

  it("returns call_timeout with phase-aware message when in soul with tool results", () => {
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",
      "run-2", "conv-2", "soul", true,
    );
    expect(result.source).toBe("call_timeout");
    expect(result.userMessage).toContain("工具结果已获得");
    expect(result.userMessage).toContain("超时");
  });

  it("returns call_timeout with generic message when before soul (no tool results)", () => {
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",
      "run-3", "conv-3", "decide", false,
    );
    expect(result.source).toBe("call_timeout");
    expect(result.userMessage).toBe("请求处理超时，请重试。");
    expect(result.userMessage).not.toContain("工具结果");
  });

  it("returns run_timeout for E_AGENT_GRAPH_TIMEOUT", () => {
    const result = classifyRunError(
      new Error("E_AGENT_GRAPH_TIMEOUT"),
      undefined,
      "run-4", "conv-4", "execute", false,
    );
    expect(result.source).toBe("run_timeout");
    expect(result.userMessage).toBe("请求处理超时，请重试。");
  });

  it("returns run_timeout with tool-result message when in soul phase", () => {
    const result = classifyRunError(
      new Error("E_AGENT_GRAPH_TIMEOUT"),
      undefined,
      "run-5", "conv-5", "soul", true,
    );
    expect(result.source).toBe("run_timeout");
    expect(result.userMessage).toContain("工具结果已获得");
  });

  it("returns unknown_abort when abortSource is undefined and error is AbortError", () => {
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      undefined,
      "run-6", "conv-6", "unknown", false,
    );
    expect(result.source).toBe("unknown_abort");
    expect(result.userMessage).toBe("操作已中断，请重试。");
  });

  it("returns fixed safe message for unknown plain Error (no raw message leak)", () => {
    const result = classifyRunError(
      new Error("模型请求失败：HTTP 529 - {\"error\":{\"message\":\"overloaded\"}}"),
      undefined,
      "run-7", "conv-7", "decide", false,
    );
    expect(result.source).toBe("upstream_cleanup");
    // 白名单策略：未知 plain Error 使用固定安全消息，绝不展示原始 message
    expect(result.userMessage).toBe("请求处理失败，请重试。");
    expect(result.userMessage).not.toContain("HTTP");
    expect(result.userMessage).not.toContain("overloaded");
    // 原始 message 保留在 diagnostics 供内部日志
    expect(result.diagnostics.errorMessage).toContain("HTTP 529");
  });

  it("includes runId, conversationId, phase in diagnostics", () => {
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",
      "run-xyz", "conv-abc", "soul", true,
    );
    expect(result.diagnostics.runId).toBe("run-xyz");
    expect(result.diagnostics.conversationId).toBe("conv-abc");
    expect(result.diagnostics.phase).toBe("soul");
    expect(result.diagnostics.hasToolResults).toBe(true);
  });

  it("never contains raw English AbortError text in userMessage", () => {
    const result = classifyRunError(
      new DOMException("This operation was aborted", "AbortError"),
      "upstream_cleanup",
      "run-8", "conv-8", "soul", true,
    );
    expect(result.userMessage).not.toContain("aborted");
    expect(result.userMessage).not.toContain("AbortError");
    expect(result.userMessage).not.toContain("operation");
  });

  it("call timeout after unsubscribe still classifies as call_timeout (first-source-wins)", () => {
    // 模拟：先 call_timeout，然后 user_cancelled
    // 由于 first-source-wins，abortSource 应该是 call_timeout
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",  // 第一个来源
      "run-9", "conv-9", "soul", true,
    );
    expect(result.source).toBe("call_timeout");
    expect(result.userMessage).toContain("超时");
  });

  it("AgentRuntimeError E_MODEL_REQUEST_FAILED returns safe message, not raw HTTP body", () => {
    const err = new AgentRuntimeError(
      "E_MODEL_REQUEST_FAILED",
      "模型请求失败：HTTP 529 - {\"error\":{\"message\":\"overloaded\",\"type\":\"too_many_requests\"}}",
    );
    const result = classifyRunError(
      err, undefined, "run-10", "conv-10", "soul", false,
    );
    expect(result.userMessage).toBe("模型服务暂时不可用，请稍后重试。");
    expect(result.userMessage).not.toContain("529");
    expect(result.userMessage).not.toContain("overloaded");
    expect(result.userMessage).not.toContain("HTTP");
    expect(result.diagnostics.httpStatus).toBe(529);
    expect(result.diagnostics.errorCode).toBe("E_MODEL_REQUEST_FAILED");
  });

  it("AgentRuntimeError E_AGENT_NO_PROGRESS returns safe message", () => {
    const err = new AgentRuntimeError("E_AGENT_NO_PROGRESS", "no progress after 3 attempts");
    const result = classifyRunError(
      err, undefined, "run-11", "conv-11", "execute", false,
    );
    expect(result.userMessage).toBe("请求处理遇到问题，请重试。");
    expect(result.diagnostics.errorCode).toBe("E_AGENT_NO_PROGRESS");
  });

  it("AgentRuntimeError E_AGENT_GRAPH_ITERATION_LIMIT returns safe message", () => {
    const err = new AgentRuntimeError("E_AGENT_GRAPH_ITERATION_LIMIT", "iteration limit reached");
    const result = classifyRunError(
      err, undefined, "run-12", "conv-12", "decide", false,
    );
    expect(result.userMessage).toBe("请求处理步骤过多，请简化问题后重试。");
    expect(result.diagnostics.errorCode).toBe("E_AGENT_GRAPH_ITERATION_LIMIT");
  });

  it("AgentRuntimeError with HTTP 429 extracts status to diagnostics", () => {
    const err = new AgentRuntimeError(
      "E_MODEL_REQUEST_FAILED",
      "模型请求失败：HTTP 429 - rate limited",
    );
    const result = classifyRunError(
      err, undefined, "run-13", "conv-13", "decide", false,
    );
    expect(result.userMessage).toBe("模型服务暂时不可用，请稍后重试。");
    expect(result.diagnostics.httpStatus).toBe(429);
  });

  it("AgentRuntimeError without HTTP status still returns safe message", () => {
    const err = new AgentRuntimeError(
      "E_MODEL_REQUEST_FAILED",
      "模型请求失败：connection refused",
    );
    const result = classifyRunError(
      err, undefined, "run-14", "conv-14", "soul", true,
    );
    expect(result.userMessage).toBe("模型服务暂时不可用，请稍后重试。");
    expect(result.diagnostics.httpStatus).toBeUndefined();
    expect(result.diagnostics.errorCode).toBe("E_MODEL_REQUEST_FAILED");
  });

  it("unknown plain Error with HTTP body → fixed safe message, no leak", () => {
    const err = new Error(
      '模型请求失败：HTTP 529 - {"error":{"message":"overloaded","request_id":"abc-123"}} Authorization: Bearer xxx',
    );
    const result = classifyRunError(err, undefined, "run-15", "conv-15", "decide", false);
    expect(result.userMessage).toBe("请求处理失败，请重试。");
    expect(result.userMessage).not.toContain("HTTP");
    expect(result.userMessage).not.toContain("overloaded");
    expect(result.userMessage).not.toContain("request_id");
    expect(result.userMessage).not.toContain("Authorization");
    expect(result.userMessage).not.toContain("Bearer");
    // 原始信息保留在 diagnostics
    expect(result.diagnostics.errorMessage).toContain("HTTP 529");
  });

  it("AgentExecutionError passes through cause to diagnostics (cause chain intact)", () => {
    const innerErr = new AgentRuntimeError(
      "E_MODEL_REQUEST_FAILED",
      "模型请求失败：HTTP 500 - internal",
    );
    const execStatus = {
      phase: "soul" as const,
      successfulTools: [],
      createdArtifacts: [],
      taskCompletionConfirmed: false,
    };
    const execErr = new AgentExecutionError("LangGraph execution failed", execStatus, { cause: innerErr });
    const result = classifyRunError(execErr, undefined, "run-16", "conv-16", "soul", false);
    expect(result.userMessage).toBe("模型服务暂时不可用，请稍后重试。");
    expect(result.diagnostics.httpStatus).toBe(500);
    expect(result.diagnostics.errorCode).toBe("E_MODEL_REQUEST_FAILED");
  });
});
