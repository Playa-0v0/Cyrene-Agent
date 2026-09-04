import { t } from "../../../i18n";
import type { CodeGitStatus } from "../../../../../shared/code-git-types";

export interface GitActionIntent {
  label: string;
  prompt: string;
}

export function buildGitPanelSummary(status: CodeGitStatus): string {
  const total = Object.values(status.summary).reduce((sum, count) => sum + count, 0);
  return total === 0 ? t("codeGit.workspaceClean") : t("codeGit.changeCount", { count: total });
}

export function buildGitStatusCopy(status: CodeGitStatus): string {
  if (status.state === "ready") return buildGitPanelSummary(status);
  return status.message ?? t("codeGit.statusUnavailable");
}

export function buildGitActionIntent(status: CodeGitStatus): GitActionIntent | null {
  if (status.state !== "ready") return null;
  if (status.files.length > 0) {
    return {
      label: t("codeGit.commitChanges"),
      prompt: t("codeGit.intentCommitPrompt"),
    };
  }
  if (status.ahead > 0) {
    return {
      label: t("codeGit.pushCommits", { count: status.ahead }),
      prompt: t("codeGit.intentPushPrompt", { count: status.ahead }),
    };
  }
  return null;
}

// 只存 i18n key（t() 不能出现在模块顶层常量里），展示文案在调用时求值。
const CHANGE_KIND_LABEL_KEYS: Record<CodeGitStatus["files"][number]["kind"], string> = {
  added: "codeGit.kindAdded",
  modified: "codeGit.kindModified",
  deleted: "codeGit.kindDeleted",
  renamed: "codeGit.kindRenamed",
  conflicted: "codeGit.kindConflicted",
};

export function changeKindLabel(kind: CodeGitStatus["files"][number]["kind"]): string {
  return t(CHANGE_KIND_LABEL_KEYS[kind]);
}
