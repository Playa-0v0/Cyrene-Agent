import { describe, expect, it, vi } from "vitest";
import { createCodeGitIgnoredPredicate, createGitWorkspaceWatcher, type WorkspaceFsWatcher } from "./git-workspace-watcher";

function createWatcherHarness() {
  const listeners = new Map<string, (value?: unknown) => void>();
  const watcher: WorkspaceFsWatcher = {
    on: vi.fn((event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener);
      return watcher;
    }),
    close: vi.fn(async () => undefined),
  };
  return { watcher, emit: (event: string, value?: unknown) => listeners.get(event)?.(value) };
}

describe("GitWorkspaceWatcher", () => {
  it("shares one watcher and broadcasts one debounced change to every session in a workspace", async () => {
    vi.useFakeTimers();
    const harness = createWatcherHarness();
    const createWatcher = vi.fn(() => harness.watcher);
    const changed = vi.fn();
    const watcher = createGitWorkspaceWatcher({ createWatcher, onWorkspaceChanged: changed, onError: vi.fn() });

    await watcher.subscribe({ sessionId: "s1", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    await watcher.subscribe({ sessionId: "s2", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    harness.emit("change", "C:\\repo\\src\\a.ts");
    harness.emit("change", "C:\\repo\\.git\\index");

    expect(createWatcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledWith(["s1", "s2"]);
    vi.useRealTimers();
  });

  it("keeps the shared watcher until the last session leaves", async () => {
    const harness = createWatcherHarness();
    const watcher = createGitWorkspaceWatcher({ createWatcher: () => harness.watcher, onWorkspaceChanged: vi.fn(), onError: vi.fn() });

    await watcher.subscribe({ sessionId: "s1", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    await watcher.subscribe({ sessionId: "s2", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    await watcher.unsubscribe("s1");
    expect(harness.watcher.close).not.toHaveBeenCalled();
    await watcher.unsubscribe("s2");
    expect(harness.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a session watched until every consumer releases its subscription", async () => {
    const harness = createWatcherHarness();
    const watcher = createGitWorkspaceWatcher({ createWatcher: () => harness.watcher, onWorkspaceChanged: vi.fn(), onError: vi.fn() });

    await watcher.subscribe({ sessionId: "s1", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    await watcher.subscribe({ sessionId: "s1", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    await watcher.unsubscribe("s1");
    expect(harness.watcher.close).not.toHaveBeenCalled();
    await watcher.unsubscribe("s1");
    expect(harness.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("keeps HEAD, index and refs while ignoring noisy git object paths", () => {
    const ignored = createCodeGitIgnoredPredicate({ workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });

    expect(ignored("C:\\repo\\node_modules\\x.js")).toBe(true);
    expect(ignored("C:\\repo\\.git\\objects\\aa\\hash")).toBe(true);
    expect(ignored("C:\\repo\\.git\\HEAD")).toBe(false);
    expect(ignored("C:\\repo\\.git\\index")).toBe(false);
    expect(ignored("C:\\repo\\.git\\refs\\heads\\main")).toBe(false);
  });
});
