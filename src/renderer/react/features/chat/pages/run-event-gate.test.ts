import { describe, expect, it } from "vitest";
import { RunEventGate } from "./run-event-gate";

describe("RunEventGate", () => {
  it("replays only events for the canonical run after ack binding", () => {
    const gate = new RunEventGate<{ runId?: string; type: string }>();
    gate.accept({ type: "RUN_STARTED", runId: "run-other" });
    gate.accept({ type: "RUN_STARTED", runId: "run-a" });

    expect(gate.bind("run-a")).toEqual([{ type: "RUN_STARTED", runId: "run-a" }]);
  });

  it("ignores another run after binding", () => {
    const gate = new RunEventGate<{ runId?: string; type: string }>();
    gate.bind("run-a");

    expect(gate.accept({ type: "TEXT_MESSAGE_CONTENT", runId: "run-b" })).toEqual([]);
    expect(gate.accept({ type: "TEXT_MESSAGE_CONTENT", runId: "run-a" })).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", runId: "run-a" },
    ]);
  });
});
