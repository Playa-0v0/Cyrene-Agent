// 工具变更证据（mutation evidence）构建 helper。
//
// 写文件工具（apply_patch / str_replace / ast_grep_replace / write_file）
// 在返回 JSON 里附带 changes: ToolFileChange[]，前端 Diff Review 卡片据此渲染
// "文件 +x/-y" 审查视图。diff 行带上限，防止撑爆消息存储。

import type { ToolDiffLine, ToolFileChange } from "../../shared/chat-types";

const MAX_LINES_PER_FILE = 60;
const MAX_TOTAL_LINES = 200;
const MAX_LINE_CHARS = 200;

function clipLine(text: string): string {
  return text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + "…" : text;
}

/**
 * 从"精确替换区域"构建 diff 行。
 * before/after 是被替换区域的行（上下文不含在内），context 前后各带几行由调用方拼。
 */
export function buildReplacedDiff(
  beforeLines: string[],
  afterLines: string[],
  contextBefore: string[] = [],
  contextAfter: string[] = [],
): ToolDiffLine[] {
  const lines: ToolDiffLine[] = [];
  for (const text of contextBefore) lines.push({ type: "context", text: clipLine(text) });
  for (const text of beforeLines) lines.push({ type: "remove", text: clipLine(text) });
  for (const text of afterLines) lines.push({ type: "add", text: clipLine(text) });
  for (const text of contextAfter) lines.push({ type: "context", text: clipLine(text) });
  return lines;
}

/** 整文件新增/删除的 diff（+ 全部行） */
export function buildFullFileDiff(lines: string[], mode: "add" | "remove"): ToolDiffLine[] {
  return lines.map((text) => ({ type: mode, text: clipLine(text) }));
}

/** 解析 git unified patch 文本为 diff 行（git_diff 工具复用） */
export function parseUnifiedPatch(patch: string): ToolDiffLine[] {
  const lines: ToolDiffLine[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) lines.push({ type: "hunk", text: raw });
    else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    else if (raw.startsWith("+")) lines.push({ type: "add", text: clipLine(raw.slice(1)) });
    else if (raw.startsWith("-")) lines.push({ type: "remove", text: clipLine(raw.slice(1)) });
    else lines.push({ type: "context", text: clipLine(raw.slice(1)) });
  }
  return lines;
}

/**
 * 汇总多个文件的变更并施加总量上限。
 * 超过每文件上限：截断 diff 行并置 truncated（统计数字保留）。
 * 超过总上限：后续文件丢弃 diff 只留统计。
 */
export function finalizeFileChanges(changes: ToolFileChange[]): ToolFileChange[] {
  let total = 0;
  return changes.map((change) => {
    if (!change.diff || change.diff.length === 0) return change;
    if (total >= MAX_TOTAL_LINES) {
      return { ...change, diff: undefined, truncated: true };
    }
    const budget = Math.min(MAX_LINES_PER_FILE, MAX_TOTAL_LINES - total);
    if (change.diff.length > budget) {
      total = MAX_TOTAL_LINES;
      return { ...change, diff: change.diff.slice(0, budget), truncated: true };
    }
    total += change.diff.length;
    return change;
  });
}

/** 计算行数统计（不含空尾行） */
export function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function isValidChange(item: unknown): item is ToolFileChange {
  const c = item as Partial<ToolFileChange> | null;
  return (
    typeof c?.file === "string" && c.file.length > 0 &&
    (c.kind === "added" || c.kind === "modified" || c.kind === "deleted" || c.kind === "renamed") &&
    typeof c.insertions === "number" && typeof c.deletions === "number"
  );
}

/**
 * 从工具完整输出 JSON 提取 changes（Diff Review 卡片证据）。
 * 返回 undefined 表示输出不是带合法 changes 的 JSON；调用方不得据此改变执行事实。
 */
export function extractFileChangesFromOutput(output: string | undefined): ToolFileChange[] | undefined {
  if (!output) return undefined;
  try {
    const parsed = JSON.parse(output) as { changes?: unknown } | null;
    const changes = parsed?.changes;
    if (!Array.isArray(changes) || changes.length === 0) return undefined;
    return changes.every(isValidChange) ? changes : undefined;
  } catch {
    return undefined;
  }
}
