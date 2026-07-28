import { describe, expect, it, vi } from "vitest";
import { ExecutionLedger, ExecutionLedgerStore } from "./execution-ledger";

describe("ExecutionLedger", () => {
  it("reuses a succeeded execution with the same action fingerprint", async () => {
    const ledger = new ExecutionLedger();
    const execute = vi.fn(async () => ({ status: "succeeded" as const, output: "ok" }));
    const input = { capability: "music.play_track", targetRefs: ["ctx_1"], args: { candidateRef: "ctx_1" } };

    const first = await ledger.execute(input, execute);
    const second = await ledger.execute(input, execute);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("allows an explicitly repeated action after a failed execution", async () => {
    const ledger = new ExecutionLedger();
    const execute = vi.fn()
      .mockResolvedValueOnce({ status: "failed" as const, errorCode: "E_FAIL", output: "fail" })
      .mockResolvedValueOnce({ status: "succeeded" as const, output: "ok" });
    const input = { capability: "music.play_track", targetRefs: ["ctx_1"], args: { candidateRef: "ctx_1" } };

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
