// v3: LangChain 后端已删除,所有结构化输出统一走 legacy vendor adapter。
// resolveStructuredOutputBackend 保留为占位(返回 "legacy"),供 dispatcher 调用,
// 待 Phase 4 删除 agent-graph.ts 后可进一步简化。

export type StructuredOutputBackend = "legacy";

export interface StructuredOutputBackendContext {
  provider: string;
  endpointKind: "official" | "custom" | "local";
}

export function resolveStructuredOutputBackend(
  _context: StructuredOutputBackendContext,
  _environment: Record<string, string | undefined> = process.env,
): StructuredOutputBackend {
  return "legacy";
}

export async function runStructuredGeneration<T>(input: {
  legacy: () => Promise<T>;
}): Promise<T> {
  return input.legacy();
}
