/**
 * 结构化 Agent 运行时错误（修订第 3 点）。
 *
 * 用 `code` 字段区分错误类型，避免下游靠 `message.startsWith("E_...")` 解析文本。
 * AgUiBridge 据此把 `code` 透传给 renderer，renderer 据此显示不同文案。
 */
export type AgentErrorCode =
  | "E_AGENT_NO_PROGRESS"
  | "E_AGENT_GRAPH_ITERATION_LIMIT"
  | "E_MODEL_REQUEST_FAILED";

export class AgentRuntimeError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}
