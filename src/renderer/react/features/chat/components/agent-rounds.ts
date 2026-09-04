import { t } from "../../../i18n";
import type { AgentRoundRecord, ProcessMessageRecord, ToolExecutionRecord } from "../../../../../shared/chat-types";

// 以下映射只存 i18n key（非译文，可安全放模块顶层）；展示文案统一在函数调用时经 t() 求值，
// 以响应运行时语言切换（t() 不能出现在模块顶层常量里）。

const LIVE_TOOL_LABEL_KEYS: Record<string, string> = {
  list_dir: "agentRounds.liveListDir",
  read_file: "agentRounds.liveReadFile",
  write_file: "agentRounds.liveWriteFile",
  edit_file: "agentRounds.liveEditFile",
  search_code: "agentRounds.liveSearchCode",
  search_text: "agentRounds.liveSearchText",
  run_shell: "agentRounds.liveRunShell",
};

const TOOL_LABEL_KEYS: Record<string, string> = {
  list_dir: "agentRounds.toolListDir",
  read_file: "agentRounds.toolReadFile",
  write_file: "agentRounds.toolWriteFile",
  edit_file: "agentRounds.toolEditFile",
  str_replace: "agentRounds.toolStrReplace",
  apply_patch: "agentRounds.toolApplyPatch",
  search_code: "agentRounds.toolSearchCode",
  search_text: "agentRounds.toolSearchText",
  run_shell: "agentRounds.toolRunShell",
};

const SUMMARY_TOOL_KEYS: Record<string, string> = {
  list_dir: "agentRounds.summaryListDir",
  read_file: "agentRounds.summaryReadFile",
  write_file: "agentRounds.summaryWriteFile",
  edit_file: "agentRounds.summaryEditFile",
  search_code: "agentRounds.summarySearchCode",
  search_text: "agentRounds.summarySearchText",
  run_shell: "agentRounds.summaryRunShell",
};

/** 实时执行中的工具动作名（"昔涟正在{{action}}"用）；未知名原样返回。 */
function liveToolLabel(name: string): string {
  const key = LIVE_TOOL_LABEL_KEYS[name];
  return key ? t(key) : name;
}

/** 工具执行卡片的标签；未知名原样返回。 */
function toolDisplayLabel(name: string): string {
  const key = TOOL_LABEL_KEYS[name];
  return key ? t(key) : name;
}

/** 工具执行状态文案里的动作名；未知名回退"执行操作"。 */
function toolActionLabel(name: string): string {
  const key = TOOL_LABEL_KEYS[name];
  return key ? t(key) : t("agentRounds.fallbackAction");
}

export interface ToolExecutionPresentation {
  label: string;
  statusText: string;
  detail?: string;
}

function parseToolArgs(argsText?: string): Record<string, unknown> | undefined {
  if (!argsText) return undefined;
  try {
    const parsed: unknown = JSON.parse(argsText);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function firstStringArg(args: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** 将底层工具调用转换为对用户有用且不泄露写入正文的执行摘要。 */
export function describeToolExecution(tool: ToolExecutionRecord): ToolExecutionPresentation {
  const args = parseToolArgs(tool.argsText);
  const result = parseToolArgs(tool.result);
  const detail = tool.name === "run_shell"
    ? firstStringArg(args, ["command"])
    : firstStringArg(args, ["path", "filePath", "file_path", "directory", "dir"]);
  const label = toolDisplayLabel(tool.name);
  const action = toolActionLabel(tool.name);
  const statusText = tool.name === "run_shell" && tool.status === "error" && result?.timedOut === true
    ? t("agentRounds.commandTimeout")
    : tool.status === "running"
    ? t("agentRounds.statusRunning", { action })
    : tool.status === "error"
      ? t("agentRounds.statusFailed", { action })
      : t("agentRounds.statusDone", { action });
  return { label, statusText, detail };
}

export function createRoundProcessMessage(
  id: string,
  content: string,
  afterToolCount: number,
  roundId?: string,
): ProcessMessageRecord {
  return { id, content, afterToolCount, roundId };
}

export function startAgentRound(
  rounds: readonly AgentRoundRecord[],
  roundId: string,
  startedAt = Date.now(),
): AgentRoundRecord[] {
  if (rounds.some((round) => round.id === roundId)) return [...rounds];
  return [...rounds, { id: roundId, status: "running", startedAt }];
}

export function finishAgentRound(
  rounds: readonly AgentRoundRecord[],
  roundId: string,
  completedAt = Date.now(),
): AgentRoundRecord[] {
  return rounds.map((round) => round.id === roundId
    ? { ...round, status: "completed", completedAt }
    : round);
}

export interface AgentRoundBoundaryState {
  rounds: AgentRoundRecord[];
  activeRoundId?: string;
}

export function applyAgentRoundBoundary(
  state: AgentRoundBoundaryState,
  action: "start" | "end",
  roundId: string,
  now = Date.now(),
): AgentRoundBoundaryState {
  if (action === "start") {
    return { rounds: startAgentRound(state.rounds, roundId, now), activeRoundId: roundId };
  }
  return {
    rounds: finishAgentRound(state.rounds, roundId, now),
    activeRoundId: state.activeRoundId === roundId ? undefined : state.activeRoundId,
  };
}

function completedSummary(tools: readonly ToolExecutionRecord[]): string[] {
  const successful = tools.filter((tool) => tool.status === "success");
  const counts = new Map<string, number>();
  for (const tool of successful) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);

  const facts = Object.entries(SUMMARY_TOOL_KEYS).flatMap(([name, key]) => {
    const count = counts.get(name) ?? 0;
    if (count === 0) return [];
    return [t(key, { count })];
  });
  if (facts.length === 0 && successful.length > 0) facts.push(t("agentRounds.summaryFallback", { count: successful.length }));
  return facts;
}

/** 本轮被改动的文件数（按路径去重）；用于完成态标题的粉色高亮提示。 */
export function countRoundChangedFiles(tools: readonly ToolExecutionRecord[]): number {
  const files = new Set<string>();
  for (const tool of tools) {
    for (const change of tool.changes ?? []) files.add(change.file);
  }
  return files.size;
}

export function resolveAgentRoundTitle(
  round: AgentRoundRecord,
  tools: readonly ToolExecutionRecord[],
  interrupted = false,
): string {
  const failures = tools.filter((tool) => tool.status === "error").length;
  if (interrupted) {
    return [t("agentRounds.interruptedTitle"), ...(failures ? [t("agentRounds.failureCount", { count: failures })] : [])].join(" · ");
  }
  if (round.status === "running") {
    const current = [...tools].reverse().find((tool) => tool.status === "running");
    return current
      ? t("agentRounds.runningLive", { action: liveToolLabel(current.name) })
      : t("agentRounds.runningThinking");
  }
  const facts = completedSummary(tools);
  if (failures) facts.push(t("agentRounds.failureCount", { count: failures }));
  return [t("agentRounds.completedTitle"), ...facts].join(" · ");
}
