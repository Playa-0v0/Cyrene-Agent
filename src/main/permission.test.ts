import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAllWindows, handle } = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
  handle: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "C:/tmp/cyrene-test") },
  BrowserWindow: { getAllWindows },
  ipcMain: { handle },
}));

vi.mock("./timeout-manager", () => ({
  getTimeoutSettings: vi.fn(() => ({ userChoiceTimeout: 60_000 })),
}));

import { cancelPendingApprovalsForRun, requestApproval } from "./permission";

function approval(runId: string) {
  return {
    toolId: "write_file",
    toolName: "Write File",
    toolDescription: "writes a file",
    args: { path: "C:/tmp/x" },
    risk: "fs-write" as const,
    timeoutMs: 60_000,
    runId,
  };
}

describe("permission cancellation", () => {
  beforeEach(() => {
    getAllWindows.mockReset();
    getAllWindows.mockReturnValue([{ webContents: { send: vi.fn() } }]);
  });

  it("rejects a pending approval with AbortError when its run is cancelled", async () => {
    let outcome: unknown;
    void requestApproval(approval("run-signal")).then(
      (value) => { outcome = { status: "resolved", value }; },
      (error) => { outcome = { status: "rejected", name: (error as Error).name }; },
    );

    cancelPendingApprovalsForRun("run-signal");
    await Promise.resolve();

    expect(outcome).toEqual({ status: "rejected", name: "AbortError" });
  });

  it("settles only approvals belonging to the cancelled run", async () => {
    let firstOutcome: unknown;
    let secondOutcome: unknown;
    void requestApproval(approval("run-first")).then(
      (value) => { firstOutcome = { status: "resolved", value }; },
      (error) => { firstOutcome = { status: "rejected", name: (error as Error).name }; },
    );
    void requestApproval(approval("run-second")).then(
      (value) => { secondOutcome = { status: "resolved", value }; },
      (error) => { secondOutcome = { status: "rejected", name: (error as Error).name }; },
    );

    cancelPendingApprovalsForRun("run-first");
    await Promise.resolve();

    expect(firstOutcome).toEqual({ status: "rejected", name: "AbortError" });
    expect(secondOutcome).toBeUndefined();

    cancelPendingApprovalsForRun("run-second");
  });
});
