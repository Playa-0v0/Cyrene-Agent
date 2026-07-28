import type { Transport } from "../vendors/types";

export type StructuredOutputStage = "cita" | "action_gate";

export type StructuredOutputMode =
  | "provider_json_schema"
  | "provider_json_object"
  | "prompt_json";

export type StructuredOutputVerification =
  | "official"
  | "contract_verified"
  | "contract_required";

export type StructuredOutputTier = "A" | "B" | "D" | "M";

export interface StructuredOutputProfileContext {
  provider: string;
  model: string;
  transport: Transport;
  endpointKind: "official" | "custom" | "local";
}

export interface StructuredOutputRepairPolicy {
  maxAttempts: number;
  totalBudgetMs: number;
  perAttemptTimeoutMs: number;
  minimumRemainingBudgetMs: number;
}

export interface StructuredOutputProfile {
  id: string;
  provider: string;
  model: string;
  transport?: Transport;
  tier: StructuredOutputTier;
  mode: StructuredOutputMode;
  verification: StructuredOutputVerification;
  allowCapabilityPromotion: false;
  requestHints: {
    sendJsonObject: boolean;
    reasoningSplit: boolean;
  };
  reasoning: "disabled" | "preserve";
  repair: Record<StructuredOutputStage, StructuredOutputRepairPolicy>;
}
