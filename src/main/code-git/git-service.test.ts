import { describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../shared/chat-types";
import type { ResolvedGitExecutable } from "./git-executable";
import { createGitService, type GitClient, type GitStatusSnapshot } from "./git-service";

const executable: ResolvedGitExecutable = {
  command: "git",
  source: "system",
  version: "2.55.0",
};

function session(mode: ChatSession["mode"], workspaceRoot = "C:\\repo"): ChatSession {
  return {
    id: "session-1",
    title: "Code task",
    identityId: null,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    mode,
    workspaceBinding: { workspaceRoot, displayName: "repo", boundAt: 1 },
  };
}

const cleanStatus: GitStatusSnapshot = {
  current: "main",
  ahead: 0,
  behind: 0,
  files: [],
};

function client(overrides: Partial<GitClient> = {}): GitClient {
  return {
    isRepository: async () => true,
    getStatus: async () => cleanStatus,
    getBranches: async () => ["main"],
    getLineStats: async () => ({ insertions: 0, deletions: 0, byPath: {} }),
    getDiff: async (options = {}) => ({
      base: options.ref ?? "HEAD",
      staged: options.staged ?? false,
      files: [],
      insertions: 0,
      deletions: 0,
      truncated: false,
      patch: "",
      perFile: [],
    }),
    getLog: async () => [],
    getGitDir: async () => "C:\\repo\\.git",
    init: async () => undefined,
    add: async () => undefined,
    commit: async () => "committed",
    checkout: async () => undefined,
    checkoutNewBranch: async () => undefined,
    push: async () => undefined,
    revert: async () => undefined,
    ...overrides,
  };
}

function service(options: {
  mode?: ChatSession["mode"];
  client?: GitClient;
  executable?: ResolvedGitExecutable | null;
}) {
  return createGitService({
    getSession: () => session(options.mode ?? "code"),
    resolveExecutable: async () => options.executable === undefined ? executable : options.executable,
    createClient: () => options.client ?? client(),
  });
}

describe("GitService.getStatusForSession", () => {
  it.each(["work", "chat", "learn"] as const)("does not expose Git state to a %s session", async (mode) => {
    const result = await service({ mode }).getStatusForSession("session-1");

    expect(result).toMatchObject({
      state: "error",
      message: "Git 工作台只在 Code 模式可用",
      files: [],
    });
  });

  it("reports a non-repository instead of a clean repository", async () => {
    const result = await service({ client: client({ isRepository: async () => false }) })
      .getStatusForSession("session-1");

    expect(result).toMatchObject({
      state: "not_repository",
      message: "这个目录还不是 Git 仓库",
      files: [],
    });
  });

  it("normalizes added, modified, deleted, renamed and conflicted files", async () => {
    const result = await service({
      client: client({
        getStatus: async () => ({
          current: "main",
          ahead: 2,
          behind: 1,
          files: [
            { path: "new.ts", index: "?", workingDir: "?" },
            { path: "changed.ts", index: " ", workingDir: "M" },
            { path: "old.ts", index: "D", workingDir: " " },
            { path: "b.ts", fromPath: "a.ts", index: "R", workingDir: " " },
            { path: "conflict.ts", index: "U", workingDir: "U" },
          ],
        }),
        getBranches: async () => ["main", "feature/review"],
        getLineStats: async () => ({ insertions: 100, deletions: 23, byPath: {
          "changed.ts": { insertions: 100, deletions: 23 },
        } }),
      }),
    }).getStatusForSession("session-1");

    expect(result).toMatchObject({
      state: "ready",
      ahead: 2,
      behind: 1,
      branch: { current: "main", detached: false, branches: ["main", "feature/review"] },
      summary: { added: 1, modified: 1, deleted: 1, renamed: 1, conflicted: 1 },
      lines: { insertions: 100, deletions: 23 },
    });
    expect(result.files.map((file) => file.kind)).toEqual([
      "added",
      "modified",
      "deleted",
      "renamed",
      "conflicted",
    ]);
  });
});
describe("GitService workspace subscriptions", () => {
  it("subscribes a Code session using the Git client's real metadata directory", async () => {
    const subscribe = vi.fn(async () => undefined);
    const git = client({ getGitDir: async () => "C:\\worktrees\\repo-meta" });
    const current = createGitService({
      getSession: () => session("code"),
      resolveExecutable: async () => executable,
      createClient: () => git,
      workspaceWatcher: { subscribe, unsubscribe: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) },
    });

    await current.watchSession("session-1");

    expect(subscribe).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspaceRoot: "C:\\repo",
      gitDir: "C:\\worktrees\\repo-meta",
    });
  });
});

describe("GitService.diff", () => {
  const ctx = { sessionId: "session-1", mode: "code" as const, workspaceRoot: "C:\\repo" };

  it("passes through defaults to the client", async () => {
    const getDiff = vi.fn(async (options: { ref?: string; staged?: boolean; maxPatchLines?: number }) => ({
      base: options.ref ?? "HEAD", staged: options.staged ?? false, files: [], insertions: 1, deletions: 2, truncated: false, patch: "", perFile: [],
    }));
    const result = await service({ client: client({ getDiff }) }).diff(ctx);

    expect(getDiff).toHaveBeenCalledWith({ ref: "HEAD", staged: false, paths: [], maxPatchLines: 400 });
    expect(result).toMatchObject({ base: "HEAD", staged: false });
  });

  it("rejects option-injecting refs", async () => {
    const current = service({});
    await expect(current.diff(ctx, { ref: "--exec=evil" })).rejects.toThrow("ref 不合法");
    await expect(current.diff(ctx, { ref: "main..origin" })).rejects.toThrow("ref 不合法");
  });

  it("rejects paths escaping the repository", async () => {
    await expect(
      service({}).diff(ctx, { paths: ["../outside.txt"] }),
    ).rejects.toThrow("仓库内相对路径");
  });

  it("accepts commit hash, branch, tag and refs/... refs", async () => {
    const getDiff = vi.fn(async () => ({ base: "", staged: false, files: [], insertions: 0, deletions: 0, truncated: false, patch: "", perFile: [] }));
    const current = service({ client: client({ getDiff }) });
    await current.diff(ctx, { ref: "0123abcd" });
    await current.diff(ctx, { ref: "feature/review" });
    await current.diff(ctx, { ref: "v1.2.3" });
    await current.diff(ctx, { ref: "refs/heads/main" });
    expect(getDiff).toHaveBeenCalledTimes(4);
  });
});

describe("GitService.log", () => {
  const ctx = { sessionId: "session-1", mode: "code" as const, workspaceRoot: "C:\\repo" };

  it("passes through validated options to the client", async () => {
    const getLog = vi.fn(async () => [{ hash: "abc1234", date: "2026-08-16", author: "Cyrene", message: "feat: x" }]);
    const result = await service({ client: client({ getLog }) }).log(ctx, { maxCount: 5, ref: "main", path: "src/a.ts" });

    expect(getLog).toHaveBeenCalledWith({ maxCount: 5, ref: "main", path: "src/a.ts" });
    expect(result).toEqual([{ hash: "abc1234", date: "2026-08-16", author: "Cyrene", message: "feat: x" }]);
  });

  it("rejects invalid maxCount, ref and path", async () => {
    const current = service({});
    await expect(current.log(ctx, { maxCount: 0 })).rejects.toThrow("maxCount");
    await expect(current.log(ctx, { maxCount: 201 })).rejects.toThrow("maxCount");
    await expect(current.log(ctx, { ref: "--upload-pack=x" })).rejects.toThrow("ref 不合法");
    await expect(current.log(ctx, { path: "../outside" })).rejects.toThrow("仓库内相对路径");
  });
});
