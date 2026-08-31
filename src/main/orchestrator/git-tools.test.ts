import { describe, expect, it, vi } from "vitest";
import type { GitService } from "../code-git/git-service";
import type { ToolContext } from "./tool-context";
import { createCodeGitTools, registerCodeGitTools } from "./git-tools";

function codeContext(workspaceRoot = "C:\\trusted"): ToolContext {
  return {
    userQuery: "提交当前修改",
    conversationId: "session-1",
    resolvedWorkspaceRoot: workspaceRoot,
    mode: "code",
  };
}

function service(): GitService {
  return {
    getStatusForSession: vi.fn(),
  onChanged: vi.fn(() => () => undefined),
  watchSession: vi.fn(async () => undefined),
  unwatchSession: vi.fn(async () => undefined),
  dispose: vi.fn(async () => undefined),
  switchBranchForSession: vi.fn(async () => "已切换到分支 main"),
  commitForSession: vi.fn(async () => "已创建提交"),
  pushForSession: vi.fn(async () => "已推送到 origin"),
    initRepository: vi.fn(async () => "initialized"),
    commit: vi.fn(async () => "committed"),
    switchBranch: vi.fn(async () => "switched"),
    push: vi.fn(async () => "pushed"),
    revert: vi.fn(async () => "reverted"),
    diff: vi.fn(async () => ({ base: "HEAD", staged: false, files: [], insertions: 0, deletions: 0, truncated: false, patch: "", perFile: [] })),
    log: vi.fn(async () => []),
  };
}

describe("createCodeGitTools", () => {
  it("rejects Git mutation outside Code mode", async () => {
    const tools = createCodeGitTools(service());
    const init = tools.find((tool) => tool.id === "git_init");

    await expect(init?.execute({}, { ...codeContext(), mode: "work" })).rejects
      .toThrow("Git 工具只允许在 Code 模式使用");
  });

  it("uses the runtime workspace instead of any model-provided root", async () => {
    const gitService = service();
    const tools = createCodeGitTools(gitService);
    const commit = tools.find((tool) => tool.id === "git_commit");

    await commit?.execute({
      message: "feat: add review",
      paths: ["src/a.ts"],
      workspaceRoot: "C:\\untrusted",
    }, codeContext());

    expect(gitService.commit).toHaveBeenCalledWith(
      { sessionId: "session-1", mode: "code", workspaceRoot: "C:\\trusted" },
      "feat: add review",
      ["src/a.ts"],
    );
  });

  it("registers only the approved Git operations", () => {
    const ids = createCodeGitTools(service()).map((tool) => tool.id);

    expect(ids).toEqual([
      "git_status",
      "git_init",
      "git_commit",
      "git_switch_branch",
      "git_push",
      "git_revert",
      "git_diff",
      "git_log",
    ]);
  });

  it("registers the approved tools into the supplied registry", () => {
    const registered: string[] = [];
    registerCodeGitTools(service(), { register: (tool) => registered.push(tool.id) });

    expect(registered).toEqual([
      "git_status",
      "git_init",
      "git_commit",
      "git_switch_branch",
      "git_push",
      "git_revert",
      "git_diff",
      "git_log",
    ]);
  });
});
