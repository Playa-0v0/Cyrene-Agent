import { describe, expect, it, vi } from "vitest";
import { CapabilityLeaseStore } from "./lease-store";
import { createPluginPermissionService } from "./plugin-permission-service";

vi.mock("../timeout-manager", () => ({
  getTimeoutSettings: () => ({ userChoiceTimeout: 30_000 }),
}));

vi.mock("../permission", () => ({
  requestApproval: vi.fn(),
}));

describe("plugin permission service", () => {
  it("asks once and issues a bounded, plugin-owned lease", async () => {
    const store = new CapabilityLeaseStore(() => 1_000);
    const approve = vi.fn(async () => true);
    const service = createPluginPermissionService("computer-use", store, approve);
    const lease = await service.requestLease({
      capability: " computer-use ",
      risk: "screen-read",
      reason: "capture the active screen",
      scope: { sessionId: "session-1" },
      ttlMs: 60 * 60_000,
    }, {
      conversationId: "conversation-1",
      runId: "run-1",
      signal: new AbortController().signal,
      userQuery: "observe",
    });

    expect(approve).toHaveBeenCalledWith(expect.objectContaining({
      toolId: "plugin:computer-use:capability-lease",
      risk: "screen-read",
      runId: "run-1",
      args: expect.objectContaining({ capability: "computer-use", ttlMs: 30 * 60_000 }),
    }));
    expect(lease).toMatchObject({ capability: "computer-use", scope: { sessionId: "session-1" } });
    expect(lease!.expiresAt).toBe(1_000 + 30 * 60_000);
    expect(store.allows({
      pluginId: "computer-use",
      conversationId: "conversation-1",
      runId: "run-1",
      capability: "computer-use",
      scope: { sessionId: "session-1" },
    })).toBe(true);
  });

  it("does not issue a lease after denial and rejects incomplete scope", async () => {
    const store = new CapabilityLeaseStore();
    const service = createPluginPermissionService("computer-use", store, vi.fn(async () => false));
    await expect(service.requestLease({
      capability: "computer-use",
      risk: "input-control",
      reason: "click",
      scope: { sessionId: "session-1" },
    }, { conversationId: "c", runId: "r", userQuery: "click" })).resolves.toBeNull();
    expect(store.size()).toBe(0);

    await expect(service.requestLease({
      capability: "computer-use",
      risk: "screen-read",
      reason: "observe",
      scope: { sessionId: "" },
    }, { conversationId: "c", runId: "r", userQuery: "observe" })).rejects.toThrow(/scope/);
  });
});
