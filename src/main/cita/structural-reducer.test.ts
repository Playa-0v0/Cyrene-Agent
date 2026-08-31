import { describe, expect, it } from "vitest";
import type { ContextState, ModelVisibleContext } from "./contracts";
import { reduceStructuralEvent } from "./structural-reducer";

const context = (contextRef = "ref-1"): ModelVisibleContext => ({
  contextRef,
  conversationId: "c1",
  domain: "music",
  kind: "candidate",
  label: "胆小鬼",
  position: 1,
  lifecycle: "active",
  expiresAt: 200,
  source: "tool_result",
});

const state = (): ContextState => ({
  conversationId: "c1",
  revision: 0,
  updatedAt: 0,
  contexts: [],
  focusedEntityRefs: [],
});

describe("reduceStructuralEvent", () => {
  it("upserts a Runtime-owned context without semantic inference", () => {
    const next = reduceStructuralEvent(state(), {
      type: "context_upserted",
      eventId: "e1",
      conversationId: "c1",
      occurredAt: 100,
      source: "music-runtime",
      context: context(),
    });
    expect(next.contexts).toEqual([context()]);
    expect(next.revision).toBe(1);
  });

  it("marks only known contexts as presented", () => {
    const existing = { ...state(), contexts: [context("ref-1"), context("ref-2")] };
    const next = reduceStructuralEvent(existing, {
      type: "context_presented",
      eventId: "e2",
      conversationId: "c1",
      occurredAt: 110,
      source: "ag-ui",
      contextRefs: ["ref-2"],
    });
    expect(next.contexts.map((item) => [item.contextRef, item.presented])).toEqual([
      ["ref-1", undefined],
      ["ref-2", true],
    ]);
  });

  it("rejects a context from another conversation", () => {
    expect(() => reduceStructuralEvent(state(), {
      type: "context_upserted",
      eventId: "e3",
      conversationId: "c1",
      occurredAt: 100,
      source: "music-runtime",
      context: { ...context(), conversationId: "c2" },
    })).toThrow("E_CITA_CONVERSATION_MISMATCH");
  });
});
