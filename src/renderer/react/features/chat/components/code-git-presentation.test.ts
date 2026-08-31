import { describe, expect, it } from "vitest";
import type { CodeGitStatus } from "../../../../../shared/code-git-types";
import { buildGitActionIntent, buildGitPanelSummary, buildGitStatusCopy } from "./code-git-presentation";

function statusWith(overrides: Partial<CodeGitStatus> = {}): CodeGitStatus {
  return {
    sessionId: "session-1",
    state: "ready",
    executable: { source: "system", version: "2.55.0" },
    branch: { current: "main", detached: false, branches: ["main"] },
    files: [],
    summary: { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 },
    lines: { insertions: 0, deletions: 0 },
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

describe("Code Git panel presentation", () => {
  it("summarizes the actual number of changed files", () => {
    expect(buildGitPanelSummary(statusWith({
      summary: { added: 2, modified: 3, deleted: 1, renamed: 0, conflicted: 0 },
    }))).toBe("6 个变更");
  });

  it("asks Cyrene to commit before pushing when the workspace is dirty", () => {
    expect(buildGitActionIntent(statusWith({
      files: [{ path: "src/a.ts", kind: "modified", staged: false, unstaged: true, insertions: 1, deletions: 0 }],
      summary: { added: 0, modified: 1, deleted: 0, renamed: 0, conflicted: 0 },
      ahead: 2,
    }))).toEqual({
      label: "提交变更",
      prompt: "请检查当前 Git 变更，并在确认合适后提交。",
    });
  });

  it("asks Cyrene to push clean commits that are ahead", () => {
    expect(buildGitActionIntent(statusWith({ ahead: 2 }))).toEqual({
      label: "推送 2 个提交",
      prompt: "请把当前分支尚未推送的 2 个提交推送到远端。",
    });
  });

  it("keeps unavailable repository states explicit", () => {
    expect(buildGitStatusCopy(statusWith({
      state: "not_repository",
      message: "这个目录还不是 Git 仓库",
      executable: null,
      branch: null,
    }))).toBe("这个目录还不是 Git 仓库");
  });
});
