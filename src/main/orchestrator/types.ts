// Orchestrator types

// ToolCallResult: 单次工具调用的结果
export interface ToolCallResult {
  toolId: string;
  args: Record<string, unknown>;
  output: string;
}

/** 单轮 LLM 交互的调试记录。 */
export interface LlmInteraction {
  phase: string;
  /** 请求概要（不含敏感字段）。 */
  request: {
    model: string;
    messageCount: number;
    toolCount: number;
    /** system prompt 前 500 字符。 */
    systemPreview: string;
  };
  /** 响应概要。 */
  response: {
    finishReason: string;
    toolCallCount: number;
    /** 响应文本前 500 字符。 */
    textPreview: string;
  };
}
