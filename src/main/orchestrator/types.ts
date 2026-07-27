// Orchestrator types

// ToolCallResult: 單次工具調用的結果
export interface ToolCallResult {
  toolId: string;
  args: Record<string, unknown>;
  output: string;
}
