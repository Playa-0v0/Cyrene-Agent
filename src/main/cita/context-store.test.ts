import { describe, expect, it } from "vitest";
import type { ContextEvent, ModelVisibleContext } from "./contracts";
import { ContextStore } from "./context-store";

const context = (conversationId: string, contextRef: string, expiresAt = 1_000): ModelVisibleContext => ({
  contextRef,
  conversationId,
  domain: "music",
  kind: "candidate",
  label: contextRef,
  lifecycle: "active",
  expiresAt,
  source: "tool_result",
});

const event = (
  conversationId: string,
  eventId: string,
  contextRef = eventId,
): Extract<ContextEvent, { type: "context_upserted" }> => ({
  type: "context_upserted",
  eventId,
  conversationId,
  occurredAt: 100,
  source: "test",
  context: context(conversationId, contextRef),
});

describe("ContextStore", () => {
  it("isolates conversations", () => {
    const store = new ContextStore({ maxEventsPerConversation: 32, now: () => 100 });
    store.append(event("c1", "e1", "ref-1"));
    expect(store.snapshot("c1").contexts.map((item) => item.contextRef)).toEqual(["ref-1"]);
    expect(store.snapshot("c2").contexts).toEqual([]);
  });

  it("bounds runtime events without requiring replay", () => {
    const store = new ContextStore({ maxEventsPerConversation: 2, now: () => 100 });
    store.append(event("c1", "e1"));
    store.append(event("c1", "e2"));
    store.append(event("c1", "e3"));
    expect(store.recentEvents("c1").map((item) => item.eventId)).toEqual(["e2", "e3"]);
  });

  it("bounds active context projections per conversation", () => {
    const store = new ContextStore({ maxContextsPerConversation: 2, now: () => 100 });
    store.append(event("c1", "e1", "ref-1"));
    store.append(event("c1", "e2", "ref-2"));
    store.append(event("c1", "e3", "ref-3"));

    expect(store.snapshot("c1").contexts.map((item) => item.contextRef)).toEqual(["ref-2", "ref-3"]);
  });

  it("marks expired contexts at snapshot time", () => {
    let now = 100;
    const store = new ContextStore({ now: () => now });
    store.append({ ...event("c1", "e1"), context: context("c1", "ref-1", 110) });
    now = 111;
    expect(store.snapshot("c1").contexts[0].lifecycle).toBe("expired");
  });

  it("rejects stale semantic updates", () => {
    const store = new ContextStore({ now: () => 100 });
    store.append(event("c1", "e1", "ref-1"));
    expect(store.applySemanticUpdate("c1", 0, {
      baseRevision: 0,
      activeDomain: "music",
      focusedEntityRefs: ["ref-1"],
    })).toBe(false);
    expect(store.applySemanticUpdate("c1", 1, {
      baseRevision: 1,
      activeDomain: "music",
      focusedEntityRefs: ["ref-1"],
    })).toBe(true);
    expect(store.snapshot("c1").activeDomain).toBe("music");
  });

  it("clears one conversation without touching another", () => {
    const store = new ContextStore({ now: () => 100 });
    store.append(event("c1", "e1"));
    store.append(event("c2", "e2"));
    store.clear("c1");
    expect(store.snapshot("c1").contexts).toEqual([]);
    expect(store.snapshot("c2").contexts).toHaveLength(1);
  });
});
