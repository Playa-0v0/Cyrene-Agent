import { describe, expect, it } from "vitest";
import { CapabilityLeaseStore } from "./lease-store";

describe("CapabilityLeaseStore", () => {
  it("matches plugin, conversation, run, capability, and exact scope", () => {
    const store = new CapabilityLeaseStore(() => 1_000);
    store.issue({
      pluginId: "computer-use",
      conversationId: "conversation-1",
      runId: "run-1",
      capability: "computer-use:input-control",
      scope: { sessionId: "s1", windowId: "w1" },
      ttlMs: 10_000,
    });
    const base = {
      pluginId: "computer-use",
      conversationId: "conversation-1",
      runId: "run-1",
      capability: "computer-use:input-control",
      scope: { windowId: "w1", sessionId: "s1" },
    };
    expect(store.allows(base)).toBe(true);
    expect(store.allows({ ...base, runId: "run-2" })).toBe(false);
    expect(store.allows({ ...base, capability: "music:input-control" })).toBe(false);
    expect(store.allows({ ...base, scope: { sessionId: "s1", windowId: "w2" } })).toBe(false);
  });

  it("expires and revokes leases by run or plugin", () => {
    let now = 1_000;
    const store = new CapabilityLeaseStore(() => now);
    const first = store.issue({
      pluginId: "a", conversationId: "c", runId: "r1", capability: "cap", scope: { id: "1" }, ttlMs: 10,
    });
    store.issue({
      pluginId: "b", conversationId: "c", runId: "r2", capability: "cap", scope: { id: "2" }, ttlMs: 100,
    });
    expect(store.size()).toBe(2);
    expect(store.revoke(first.leaseId)).toBe(true);
    expect(store.revokeRun("r2")).toBe(1);
    expect(store.size()).toBe(0);

    store.issue({
      pluginId: "a", conversationId: "c", runId: "r3", capability: "cap", scope: { id: "3" }, ttlMs: 10,
    });
    now = 1_011;
    expect(store.size()).toBe(0);
  });

  it("revokes an issued lease when the owning run signal aborts", () => {
    const store = new CapabilityLeaseStore(() => 1_000);
    const controller = new AbortController();
    store.issue({
      pluginId: "a", conversationId: "c", runId: "r", capability: "cap", scope: { id: "1" }, ttlMs: 100,
      signal: controller.signal,
    });
    expect(store.size()).toBe(1);
    controller.abort();
    expect(store.size()).toBe(0);
  });

  it("does not retain a lease for an already-aborted run", () => {
    const store = new CapabilityLeaseStore(() => 1_000);
    const controller = new AbortController();
    controller.abort();
    store.issue({
      pluginId: "a", conversationId: "c", runId: "r", capability: "cap", scope: { id: "1" }, ttlMs: 100,
      signal: controller.signal,
    });
    expect(store.size()).toBe(0);
  });
});
