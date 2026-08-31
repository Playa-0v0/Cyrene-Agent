import { describe, expect, it } from "vitest";
import {
  appendInternalTranscriptMessage,
  createInternalTranscriptMessage,
  toModelVisibleMessage,
} from "./internal-transcript";

describe("internal transcript messages", () => {
  it("projects an internal message without persistence metadata", () => {
    const message = createInternalTranscriptMessage({
      kind: "run_start",
      revision: 1,
      runId: "run-1",
      now: 10,
      content: "<internal_context type=\"run_start\">workspace</internal_context>",
    });

    expect(toModelVisibleMessage(message)).toEqual({
      role: "user",
      content: "<internal_context type=\"run_start\">workspace</internal_context>",
    });
  });

  it("does not append an identical internal fact twice", () => {
    const first = createInternalTranscriptMessage({
      kind: "state_delta",
      revision: 1,
      runId: "run-1",
      content: "fact",
    });
    const duplicate = createInternalTranscriptMessage({
      kind: "state_delta",
      revision: 2,
      runId: "run-1",
      content: "fact",
    });

    expect(appendInternalTranscriptMessage([first], duplicate)).toEqual([first]);
  });

  it("appends a changed internal fact at the transcript tail", () => {
    const first = createInternalTranscriptMessage({
      kind: "state_delta",
      revision: 1,
      runId: "run-1",
      content: "current: inspect",
    });
    const changed = createInternalTranscriptMessage({
      kind: "state_delta",
      revision: 2,
      runId: "run-1",
      content: "current: test",
    });

    expect(appendInternalTranscriptMessage([first], changed)).toEqual([first, changed]);
  });
});
