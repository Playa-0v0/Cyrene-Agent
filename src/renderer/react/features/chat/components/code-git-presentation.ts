import type { CodeGitStatus } from "../../../../../shared/code-git-types";

export interface GitActionIntent {
  label: string;
  prompt: string;
}

export function buildGitPanelSummary(status: CodeGitStatus): string {
  const total = Object.values(status.summary).reduce((sum, count) => sum + count, 0);
  return total === 0 ? "工作区干净" : `${total} 个变更`;
}

export function buildGitStatusCopy(status: CodeGitStatus): string {
  if (status.state === "ready") return buildGitPanelSummary(status);
  return status.message ?? "Git 状态暂时不可用";
}

export function buildGitActionIntent(status: CodeGitStatus): GitActionIntent | null {
  if (status.state !== "ready") return null;
  if (status.files.length > 0) {
    return {
      label: "提交变更",
      prompt: "请检查当前 Git 变更，并在确认合适后提交。",
    };
  }
  if (status.ahead > 0) {
    return {
      label: `推送 ${status.ahead} 个提交`,
      prompt: `请把当前分支尚未推送的 ${status.ahead} 个提交推送到远端。`,
    };
  }
  return null;
}

export function changeKindLabel(kind: CodeGitStatus["files"][number]["kind"]): string {
  return {
    added: "新增",
    modified: "修改",
    deleted: "删除",
    renamed: "重命名",
    conflicted: "冲突",
  }[kind];
}
