/**
 * CyreneHarness 对外入口
 *
 * 用法：
 *   import { runCyreneHarness } from "./harness";
 *   const result = await runCyreneHarness(input);
 */

export { runCyreneHarness } from "./cyrene-harness";
export type {
  AgentState,
  HarnessConfig,
  HarnessEvent,
  HarnessInput,
  HarnessResult,
  SideEffectKind,
  TodoItem,
  TodoStatus,
  ToolCallOutcome,
  ToolErrorCategory,
  ToolObservation,
  UncertainEffect,
} from "./types";
export { DEFAULT_HARNESS_CONFIG } from "./types";
export { isHarnessBuiltin, getHarnessBuiltinToolSpecs } from "./builtin-tools";
export { resolveSideEffect } from "./side-effect-resolver";
export { classifyToolError, classifyToolResultError } from "./error-classifier";
export { decideRetry, getRetryParams, sleepWithJitter } from "./retry-policy";
export {
  isBlockedByUncertainEffect,
  resolveUncertainEffect,
} from "./uncertain-effect-guard";
export { computeTokenBudget, findSafeCutPoint, compressForAgentLoop } from "./compaction";
export { StreamController } from "./stream-controller";
export { TimeoutClock } from "./timeout-clock";
export { dispatchToolCall, truncateOutput } from "./tool-dispatcher";
