import type {
  StateUpdateProposal,
  TurnObservationInput,
  TurnUnderstanding,
  TurnUnderstandingInput,
} from "./contracts";
import type { StructuredOutputRequest } from "../orchestrator/vendors/types";

export interface SemanticGenerateRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  structuredOutput: StructuredOutputRequest;
  /** Provider-specific non-secret request hints, such as MiniMax reasoning_split. */
  extraBody?: Record<string, unknown>;
}

export interface SemanticGeneratorResult {
  text: string;
  thinking?: string;
  finishReason?: string;
  refusal?: string;
  /** LangChain responseFormat result; absent on the legacy generator path. */
  structuredValue?: unknown;
}

export type SemanticTextGenerator = (
  request: SemanticGenerateRequest,
  signal?: AbortSignal,
) => Promise<SemanticGeneratorResult>;

export interface CitaSemanticEngine {
  understandTurn(input: TurnUnderstandingInput, signal?: AbortSignal): Promise<TurnUnderstanding>;
  observeTurn?(input: TurnObservationInput, signal?: AbortSignal): Promise<StateUpdateProposal>;
}
