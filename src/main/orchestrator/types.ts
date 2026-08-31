// Orchestrator types

import type { ToolEffectState, ToolErrorCategory } from "./tool-execution-error";

// ToolCallResult: 单次工具调用的结果
export interface ToolCallResult {
  toolId: string;
  args: Record<string, unknown>;
  output: string;
  status: "succeeded" | "failed";
  errorCode?: string;
  category?: ToolErrorCategory;
  effectState?: ToolEffectState;
  // 完成语义：该工具步骤是否已经结束（默认 true，由 normalizer 推导）
  terminal?: boolean;
  // 完成语义：失败后是否值得重试（默认 false，由 normalizer 推导）
  retryable?: boolean;
  // 本次调用未真正执行，是 ExecutionLedger 缓存命中
  deduplicated?: boolean;
  /** false means the failure happened before Tool Runtime was invoked. */
  toolExecuted?: false;
  /** 稳定能力标识（从 ToolDefinition.capability ?? toolId 取值） */
  capabilityId?: string;
  /** 计划模式：所属计划 ID */
  planId?: string;
  /** 计划模式：所属步骤 ID */
  stepId?: string;
  /** 计划模式：步骤执行周期 ID（覆盖整个步骤从开始到完成/失败） */
  stepExecutionId?: string;
  /** 计划模式：单次 act 尝试 ID */
  stepAttemptId?: string;
}

export interface ToolExecutionOutcome {
  output: string;
  status: "succeeded" | "failed";
  errorCode?: string;
  category?: ToolErrorCategory;
  effectState?: ToolEffectState;
  // 完成语义：该工具步骤是否已经结束（默认 true，由 normalizer 推导）
  terminal?: boolean;
  // 完成语义：失败后是否值得重试（默认 false，由 normalizer 推导）
  retryable?: boolean;
}
