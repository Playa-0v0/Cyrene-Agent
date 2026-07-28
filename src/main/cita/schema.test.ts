import { describe, expect, it } from "vitest";
import { parseTurnUnderstanding } from "./schema";

const valid = {
  resolvedReferences: [
    {
      surface: "第一首",
      targetRef: "music-candidate-1",
      relation: "candidate_position",
    },
  ],
  focusedEntityRefs: ["music-candidate-1"],
  contextualizedQuery: "用户选择当前候选中的第一首《胆小鬼》。",
  rewriteStatus: "rewritten",
};

describe("parseTurnUnderstanding", () => {
  it("accepts the bounded cognition schema", () => {
    expect(parseTurnUnderstanding(valid)).toEqual(valid);
  });

  it("ignores legacy fields (dialogueAct, topicTransition, uncertainties)", () => {
    const withLegacy = {
      ...valid,
      dialogueAct: { type: "select" },
      topicTransition: "continue",
      uncertainties: [],
    };
    expect(parseTurnUnderstanding(withLegacy)).toEqual(valid);
  });

  it.each(["toolName", "toolCall", "execute", "requiredToolArgs", "trackId", "provider"])(
    "ignores extra execution field %s",
    (field) => {
      expect(parseTurnUnderstanding({ ...valid, [field]: "forbidden" })).toEqual(valid);
    },
  );

  it("ignores unknown nested fields in legacy dialogueAct", () => {
    expect(parseTurnUnderstanding({
      ...valid,
      dialogueAct: { type: "select", tool: "music_play_track" },
    })).toEqual(valid);
  });

  it("allows reference existence to be checked by the validation layer", () => {
    const parsed = parseTurnUnderstanding({
      ...valid,
      resolvedReferences: [{ surface: "那个", targetRef: "unknown-ref", relation: "focused" }],
    });
    expect(parsed.resolvedReferences[0].targetRef).toBe("unknown-ref");
  });

  it("rejects oversized arrays and queries", () => {
    expect(() => parseTurnUnderstanding({
      ...valid,
      focusedEntityRefs: Array.from({ length: 17 }, (_, index) => `ref-${index}`),
    })).toThrow(/focusedEntityRefs/i);
    expect(() => parseTurnUnderstanding({
      ...valid,
      contextualizedQuery: "x".repeat(2_001),
    })).toThrow(/contextualizedQuery/i);
  });

  it("normalizes legacy rewriteStatus values", () => {
    expect(parseTurnUnderstanding({ ...valid, rewriteStatus: "contextualized" }).rewriteStatus).toBe("rewritten");
    expect(parseTurnUnderstanding({ ...valid, rewriteStatus: "ambiguous" }).rewriteStatus).toBe("insufficient_context");
  });

  it("rejects invalid rewriteStatus values", () => {
    expect(() => parseTurnUnderstanding({ ...valid, rewriteStatus: "invalid" })).toThrow(/rewriteStatus/i);
  });
});
