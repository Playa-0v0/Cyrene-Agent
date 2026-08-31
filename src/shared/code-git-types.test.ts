import { describe, expect, it } from "vitest";
import { emptyCodeGitStatus } from "./code-git-types";

describe("emptyCodeGitStatus", () => {
  it("keeps an unavailable repository state truthful and empty", () => {
    expect(
      emptyCodeGitStatus("session-1", "not_repository", "尚未初始化 Git 仓库"),
    ).toEqual({
      sessionId: "session-1",
      state: "not_repository",
      message: "尚未初始化 Git 仓库",
      executable: null,
      branch: null,
      files: [],
      summary: {
        added: 0,
        modified: 0,
        deleted: 0,
        renamed: 0,
        conflicted: 0,
      },
      lines: { insertions: 0, deletions: 0 },
      ahead: 0,
      behind: 0,
    });
  });
});
