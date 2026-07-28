export type StructuredOutputBackend = "langchain" | "legacy";

export interface StructuredOutputBackendContext {
  provider: string;
  endpointKind: "official" | "custom" | "local";
}

const LANGCHAIN_PROVIDERS = new Set(["chatgpt", "claude"]);

export function resolveStructuredOutputBackend(
  context: StructuredOutputBackendContext,
  environment: Record<string, string | undefined> = process.env,
): StructuredOutputBackend {
  if (environment.CYRENE_LEGACY_STRUCTURED_OUTPUT === "1") return "legacy";
  return context.endpointKind === "official"
    && LANGCHAIN_PROVIDERS.has(context.provider)
    ? "langchain"
    : "legacy";
}

export async function runStructuredGeneration<T>(input: {
  backend: StructuredOutputBackend;
  langchain: () => Promise<T>;
  legacy: () => Promise<T>;
}): Promise<T> {
  return input.backend === "legacy"
    ? input.legacy()
    : input.langchain();
}
