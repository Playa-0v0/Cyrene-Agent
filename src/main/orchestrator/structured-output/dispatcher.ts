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
  legacy: () => Promise<T>;
}): Promise<T> {
  if (!input.request.structuredOutput) return input.legacy();
  return runStructuredGeneration({
    legacy: input.legacy,
  });
}
