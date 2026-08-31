export type ToolErrorCategory =
  | "transient"
  | "timeout"
  | "rate_limited"
  | "not_found"
  | "permission_denied"
  | "invalid_arguments"
  | "semantic_failure"
  | "partial_failure"
  | "fatal"
  | "runtime_safety";

export type ToolEffectState = "not_applied" | "unknown";

export class ToolExecutionError extends Error {
  readonly name = "ToolExecutionError";

  constructor(
    readonly code: string,
    message: string,
    readonly category: ToolErrorCategory,
    readonly retryable = false,
    readonly effectState: ToolEffectState = "not_applied",
  ) {
    super(message);
  }
}
