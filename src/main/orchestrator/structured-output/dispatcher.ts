import type { ChatRequest } from "../vendors/types";
import {
  resolveStructuredOutputBackend,
  runStructuredGeneration,
} from "./backend";

export async function dispatchChatGeneration<T>(input: {
  request: ChatRequest;
  provider: string;
  endpointKind: "official" | "custom" | "local";
  environment?: Record<string, string | undefined>;
  langchain: () => Promise<T>;
  legacy: () => Promise<T>;
}): Promise<T> {
  if (!input.request.structuredOutput) return input.legacy();
  return runStructuredGeneration({
    backend: resolveStructuredOutputBackend({
      provider: input.provider,
      endpointKind: input.endpointKind,
    }, input.environment),
    langchain: input.langchain,
    legacy: input.legacy,
  });
}
