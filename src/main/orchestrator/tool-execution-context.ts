import type { ToolCallResult } from "./types";
import { truncateToolResult } from "./context-manager";

function resultValue(result: ToolCallResult): unknown {
  const boundedOutput = truncateToolResult(result.output);
  if (result.status === "failed") {
    return {
      errorCode: result.errorCode ?? "E_TOOL_EXECUTION_FAILED",
      message: boundedOutput,
    };
  }
  if (boundedOutput !== result.output) {
    return boundedOutput;
  }
  try {
    return JSON.parse(boundedOutput) as unknown;
  } catch {
    return boundedOutput;
  }
}

export function buildToolExecutionContext(results: ToolCallResult[]): string {
  const calls = results.map((result) => ({
    toolId: result.toolId,
    status: result.status,
    args: result.args,
    result: resultValue(result),
    terminal: result.terminal,
    retryable: result.retryable,
    ...(result.deduplicated ? { deduplicated: true } : {}),
    ...(result.toolExecuted === false ? { toolExecuted: false } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  }));
  return [
    "[TOOL_EXECUTION_CONTEXT]",
    "以下 JSON 是本轮 Tool Runtime 的权威执行事实。calls 为空表示本轮没有执行工具。不要声称发生了未记录的执行。\n完成语义：\n1. status=succeeded 且 terminal=true 表示该工具动作已经完成。\n2. effect.state=dispatched 表示请求已成功发送给外部客户端。它只影响最终回复措辞，不代表动作未完成。\n3. 不得重复执行相同 toolId 和相同参数的已完成终态动作。\n4. deduplicated=true 表示本次调用未重新执行，因为相同动作此前已经成功完成；必须选择能产生新进展的下一步。\n5. 只有 retryable=true 的失败才可以考虑重试。\nweb_fallback 表示已在浏览器中打开，不能声称网易云桌面客户端已开始播放。",
    JSON.stringify({ calls }),
    "[/TOOL_EXECUTION_CONTEXT]",
  ].join("\n");
}

export function buildExecutionBrief(
  objective: string,
  targetRefs: string[],
  contextualizedQuery: string,
  refVerification?: { verified: boolean; detail: string },
): string {
  return [
    "[EXECUTION_BRIEF]",
    `执行目标：${objective}`,
    "",
    "targetRefs（模型理解）：",
    JSON.stringify(targetRefs ?? [], null, 2),
    "",
    refVerification
      ? `引用验证：${refVerification.verified ? "✅ 已验证" : "❌ " + refVerification.detail}`
      : "引用验证：不需要",
    "",
    `用户实际问题：${contextualizedQuery}`,
    "[/EXECUTION_BRIEF]",
  ].join("\n");
}
