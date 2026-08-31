import { describe, expect, it, vi } from "vitest";
import { ExecutionLedger, ExecutionLedgerStore } from "./execution-ledger";

describe("ExecutionLedger", () => {
  it("replays a succeeded execution for the same logical invocation", async () => {
    const ledger = new ExecutionLedger();
    const execute = vi.fn(async () => ({ status: "succeeded" as const, output: "ok" }));
    const input = { logicalInvocationId: "run-1:call-123", capability: "music.play_track", targetRefs: ["ctx_1"], args: { candidateRef: "ctx_1" } };

    const first = await ledger.execute(input, execute);
    const second = await ledger.execute(input, execute);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("executes a new model tool_call even when all request facts are identical", async () => {
    const ledger = new ExecutionLedger();
    const execute = vi.fn(async () => ({ status: "succeeded" as const, output: "ok" }));
    const facts = { capability: "send_email", targetRefs: ["a@example.com"], args: { to: "a@example.com", body: "same" } };

    await ledger.execute({ logicalInvocationId: "run-1:call-123", ...facts }, execute);
    await ledger.execute({ logicalInvocationId: "run-1:call-456", ...facts }, execute);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects the same logical invocation id with conflicting request facts", async () => {
    const ledger = new ExecutionLedger();
    const execute = vi.fn(async () => ({ status: "succeeded" as const, output: "ok" }));
    await ledger.execute({ logicalInvocationId: "run-1:call-123", capability: "send_email", targetRefs: [], args: { body: "one" } }, execute);

    await expect(ledger.execute(
      { logicalInvocationId: "run-1:call-123", capability: "send_email", targetRefs: [], args: { body: "two" } },
      execute,
    )).rejects.toMatchObject({ code: "E_LOGICAL_INVOCATION_CONFLICT" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("allows an explicitly repeated action after a failed execution", async () => {
    const ledger = new ExecutionLedger();
    const execute = vi.fn()
      .mockResolvedValueOnce({ status: "failed" as const, errorCode: "E_FAIL", output: "fail" })
      .mockResolvedValueOnce({ status: "succeeded" as const, output: "ok" });
    const input = { logicalInvocationId: "run-1:call-1", capability: "music.play_track", targetRefs: ["ctx_1"], args: { candidateRef: "ctx_1" } };

    expect((await ledger.execute(input, execute)).outcome.status).toBe("failed");
    expect((await ledger.execute(input, execute)).outcome.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("ExecutionLedgerStore", () => {
  it("reuses a ledger for the same conversation turn scope", () => {
    const store = new ExecutionLedgerStore();
    expect(store.forScope("conversation-1:turn-4")).toBe(store.forScope("conversation-1:turn-4"));
    expect(store.forScope("conversation-1:turn-5")).not.toBe(store.forScope("conversation-1:turn-4"));
  });
});

describe("ExecutionLedger terminal-aware caching", () => {
  const input = { logicalInvocationId: "run-1:call-1", capability: "cap", targetRefs: [], args: {} };

  it("caches succeeded + terminal:true", async () => {
    const ledger = new ExecutionLedger();
    const run = vi.fn(async () => ({ status: "succeeded" as const, output: "ok", terminal: true }));
    await ledger.execute(input, run);
    await ledger.execute(input, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("caches succeeded + terminal:undefined (default terminal semantics)", async () => {
    const ledger = new ExecutionLedger();
    const run = vi.fn(async () => ({ status: "succeeded" as const, output: "ok" }));
    await ledger.execute(input, run);
    await ledger.execute(input, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not cache succeeded + terminal:false, second call re-executes", async () => {
    const ledger = new ExecutionLedger();
    const run = vi.fn(async () => ({ status: "succeeded" as const, output: "partial", terminal: false }));
    const first = await ledger.execute(input, run);
    const second = await ledger.execute(input, run);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed outcomes", async () => {
    const ledger = new ExecutionLedger();
    const run = vi.fn(async () => ({ status: "failed" as const, output: "err", errorCode: "E_FAIL" }));
    await ledger.execute(input, run);
    await ledger.execute(input, run);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
