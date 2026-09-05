/**
 * 同工具连续失败熔断（纯函数模块）。
 *
 * 背景：模型侧参数生成缺失（如 MiniMax-M3 连续 30 次丢 filename）时，
 * 同一工具会无限失败下去，烧大量 token 与时间。runtime 层在 run 内
 * 记录每个工具的连续失败次数，达到阈值后拦截后续调用（合成 not_executed），
 * 提示模型换方案或求助用户。
 *
 * 计数规则（防自我解除陷阱）：failure 递增、success 清零、
 * not_executed / unknown 不动——熔断后合成的 not_executed 结果会流回
 * 计数点，若按"非 failure 即清零"实现，熔断会被自己合成的结果解除。
 */

import type { ToolCallOutcome } from "./types";

/** 熔断阈值：同一工具连续失败达到此次数后，后续调用直接拦截 */
export const TOOL_FAILURE_STREAK_THRESHOLD = 5;

/**
 * 判定某工具的连续失败计数是否已触发熔断。
 * @param streak 当前连续失败次数（未计数过的工具传 undefined）
 */
export function isToolBreakerTripped(streak: number | undefined): boolean {
  return (streak ?? 0) >= TOOL_FAILURE_STREAK_THRESHOLD;
}

/**
 * 按结果更新连续失败计数：
 * - failure → 递增
 * - success → 清零（回到 0）
 * - not_executed / unknown → 保持不变
 *
 * @param streak   当前连续失败次数（未计数过的工具传 undefined）
 * @param outcome  本次工具调用的结果四态
 * @returns 更新后的连续失败次数
 */
export function nextToolFailureStreak(
  streak: number | undefined,
  outcome: ToolCallOutcome,
): number {
  const current = streak ?? 0;
  if (outcome === "failure") return current + 1;
  if (outcome === "success") return 0;
  return current;
}

/**
 * 熔断拦截时合成 not_executed 的模型可见提示：
 * 引导模型换方案或求助用户，而不是继续重试同一工具。
 */
export function toolBreakerMessage(toolName: string, streak: number): string {
  return (
    `工具 ${toolName} 在本次运行中已连续失败 ${streak} 次，已被熔断停用。` +
    "请停止调用该工具，改用其他方案（换用别的工具、分步或调整参数），或向用户说明情况并求助。"
  );
}
