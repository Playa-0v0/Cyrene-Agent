import { describe, expect, it } from "vitest";
import { AgentRuntimeError } from "./agent-runtime-error";

describe("AgentRuntimeError", () => {
  it("carries a structured code separate from the message", () => {
    const err = new AgentRuntimeError("E_AGENT_NO_PROGRESS", "repeated action");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("E_AGENT_NO_PROGRESS");
    expect(err.message).toBe("repeated action");
    expect(err.name).toBe("AgentRuntimeError");
  });

  it("preserves the cause option", () => {
    const root = new Error("http 500");
    const err = new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "upstream failed", { cause: root });
    expect(err.cause).toBe(root);
  });

  it("supports all declared error codes", () => {
    for (const code of ["E_AGENT_NO_PROGRESS", "E_AGENT_GRAPH_ITERATION_LIMIT", "E_MODEL_REQUEST_FAILED"] as const) {
      const err = new AgentRuntimeError(code, "msg");
      expect(err.code).toBe(code);
    }
  });
});
