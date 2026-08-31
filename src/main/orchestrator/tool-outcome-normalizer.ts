import type { ToolExecutionOutcome } from "./types";

/**
 * 唯一的完成语义推导入口。所有消费 ToolExecutionOutcome 的地方都应先调用此函数。
 *
 * 默认值（修订第 1 点）：
 * - 任何工具调用（无论成功/失败）都视为已结束：terminal 默认 true。
 *   参数错误、权限拒绝、ContextRef 过期等都不应自动重试。
 * - 失败默认不可重试：retryable 默认 false。
 *   只有工具明确判断为临时错误（网络超时、限流）时才显式返回 retryable=true。
 */
export function normalizeToolExecutionOutcome(
  outcome: ToolExecutionOutcome,
): ToolExecutionOutcome & { terminal: boolean; retryable: boolean } {
  return {
    ...outcome,
    terminal: outcome.terminal ?? true,
    retryable: outcome.retryable ?? false,
  };
}
