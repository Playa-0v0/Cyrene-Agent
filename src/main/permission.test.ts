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

import { IPC } from "../shared/ipc-channels";
import { cancelPendingApprovalsForRun, requestApproval } from "./permission";

function approval(runId: string) {
  return {
    toolId: "write_file",
    toolName: "Write File",
    toolDescription: "writes a file",
    args: { path: "C:/tmp/x" },
    risk: "fs-write" as const,
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

  it("broadcasts PERMISSION_APPROVAL_SETTLED to all windows when cancelled", async () => {
    const send = vi.fn();
    getAllWindows.mockReturnValue([{ webContents: { send } }]);

    void requestApproval(approval("run-broadcast")).catch(() => {});
    cancelPendingApprovalsForRun("run-broadcast");
    await Promise.resolve();

    const channels = send.mock.calls.map((call) => call[0] as string);
    expect(channels).toContain(IPC.PERMISSION_APPROVAL_SETTLED);
    const settlement = send.mock.calls
      .find((call) => call[0] === IPC.PERMISSION_APPROVAL_SETTLED)?.[1] as { id: string; reason: string };
    expect(settlement.reason).toBe("cancelled");
    expect(settlement.id).toMatch(/^approve-/);
  });

  it("keeps waiting without auto-deny when the user never responds", async () => {
    let outcome: unknown;
    void requestApproval(approval("run-patient")).then(
      (value) => { outcome = { status: "resolved", value }; },
      (error) => { outcome = { status: "rejected", name: (error as Error).name }; },
    );

    // 推进若干微任务/宏任务 tick：审批不应自行结算
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(outcome).toBeUndefined();

    cancelPendingApprovalsForRun("run-patient");
  });
});
