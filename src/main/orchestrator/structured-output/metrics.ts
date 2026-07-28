import type { StructuredOutputMode, StructuredOutputStage } from "./types";

export interface StructuredOutputMetric {
  stage: StructuredOutputStage;
  mode: StructuredOutputMode;
  attempts: number;
  repairCount: number;
  finishReason: string;
  candidateCount: number;
  validCandidateCount: number;
  finalOutcome: "success" | "failure";
  validationFailureCode?: string;
  totalDurationMs: number;
}

export type RecordStructuredOutputMetric = (metric: StructuredOutputMetric) => void;

