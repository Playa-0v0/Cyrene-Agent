import { describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { CodeGitChangedPayload, CodeGitStatus } from "../../shared/code-git-types";
import { registerCodeGitIpc } from "./code-git-ipc";

function createHarness() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const sent = vi.fn();
  let onChanged: ((payload: CodeGitChangedPayload) => void) | undefined;
  const service = {
    getStatusForSession: vi.fn(async (sessionId: string): Promise<CodeGitStatus> => ({
      sessionId,
      state: "ready",
      executable: { source: "system", version: "2.55.0" },
      branch: { current: "main", detached: false, branches: ["main"] },
      files: [],
      summary: { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 },
      lines: { insertions: 0, deletions: 0 },
      ahead: 0,
      behind: 0,
    })),
    watchSession: vi.fn(async () => undefined),
    unwatchSession: vi.fn(async () => undefined),
    switchBranchForSession: vi.fn(async () => "已切换到分支 feature/x"),
    commitForSession: vi.fn(async () => "已创建提交 abc1234"),
    pushForSession: vi.fn(async () => "已推送到 origin"),
    onChanged: vi.fn((listener: (payload: CodeGitChangedPayload) => void) => {
      onChanged = listener;
      return () => undefined;
    }),
  };
  registerCodeGitIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWindows: () => [{ isDestroyed: () => false, webContents: { send: sent } }],
    service,
  });
  return { handlers, sent, service, emitChanged: (payload: CodeGitChangedPayload) => onChanged?.(payload) };
}

describe("registerCodeGitIpc", () => {
  it("passes only a session identity to the Git status service", async () => {
    const harness = createHarness();

    await harness.handlers.get(IPC.CODE_GIT_STATUS)?.({}, "session-1");

    expect(harness.service.getStatusForSession).toHaveBeenCalledWith("session-1");
  });

  it("broadcasts only the changed session identity", () => {
    const harness = createHarness();

    harness.emitChanged({ sessionId: "session-1" });

    expect(harness.sent).toHaveBeenCalledWith(IPC.CODE_GIT_CHANGED, { sessionId: "session-1" });
  });

  it("subscribes and unsubscribes only a non-empty session identity", async () => {
    const harness = createHarness();

    await harness.handlers.get(IPC.CODE_GIT_WATCH)?.({}, "session-1");
    await harness.handlers.get(IPC.CODE_GIT_UNWATCH)?.({}, "session-1");

    expect(harness.service.watchSession).toHaveBeenCalledWith("session-1");
    expect(harness.service.unwatchSession).toHaveBeenCalledWith("session-1");
  });

  it("performs a direct branch switch and commit without accepting a workspace path", async () => {
    const harness = createHarness();

    await harness.handlers.get(IPC.CODE_GIT_SWITCH_BRANCH)?.({}, { sessionId: "session-1", branch: "feature/x", create: false });
    await harness.handlers.get(IPC.CODE_GIT_COMMIT)?.({}, { sessionId: "session-1", message: "feat: x", paths: ["src/a.ts"] });

    expect(harness.service.switchBranchForSession).toHaveBeenCalledWith("session-1", "feature/x", false);
    expect(harness.service.commitForSession).toHaveBeenCalledWith("session-1", "feat: x", ["src/a.ts"]);
  });
});
