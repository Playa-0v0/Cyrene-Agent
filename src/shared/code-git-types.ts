export type CodeGitState =
  | "ready"
  | "no_workspace"
  | "git_unavailable"
  | "not_repository"
  | "error";

export type CodeGitExecutableSource = "system" | "bundled";
export type CodeGitChangeKind = "added" | "modified" | "deleted" | "renamed" | "conflicted";

export interface CodeGitFileChange {
  path: string;
  fromPath?: string;
  kind: CodeGitChangeKind;
  staged: boolean;
  unstaged: boolean;
  insertions: number;
  deletions: number;
}

export interface CodeGitStatus {
  sessionId: string;
  state: CodeGitState;
  message?: string;
  executable: { source: CodeGitExecutableSource; version: string } | null;
  branch: { current: string | null; detached: boolean; branches: string[] } | null;
  files: CodeGitFileChange[];
  summary: Record<CodeGitChangeKind, number>;
  lines: { insertions: number; deletions: number };
  ahead: number;
  behind: number;
}

export interface CodeGitChangedPayload {
  sessionId: string;
}

export function emptyCodeGitStatus(
  sessionId: string,
  state: Exclude<CodeGitState, "ready">,
  message: string,
): CodeGitStatus {
  return {
    sessionId,
    state,
    message,
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
  };
}
