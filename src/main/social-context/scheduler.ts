import {
  parseAndValidateSocialExtraction,
  type SocialExtractionRepairContext,
} from "./extractor";
import type { SocialAtomStore } from "./store";
import type { SocialExtractionInput } from "./types";

const MAX_EXTRACTION_ATTEMPTS = 3;
const MAX_REPAIR_OUTPUT_CHARS = 6_000;

export interface SocialContextSchedulerDeps {
  store: SocialAtomStore;
  generate: (
    input: SocialExtractionInput,
    repair?: SocialExtractionRepairContext,
  ) => Promise<string>;
  enqueue: (label: string, task: () => Promise<void>) => Promise<unknown>;
  recordMetric?: (metric: {
    outcome: "success" | "failure";
    acceptedCount: number;
    rejectedCount: number;
    attempts: number;
    repairCount: number;
  }) => void;
}

export function createSocialContextScheduler(deps: SocialContextSchedulerDeps): {
  schedule(input: SocialExtractionInput): void;
} {
  return {
    schedule(input) {
      let attempts = 0;
      let repairCount = 0;
      void deps.enqueue("chat-social-context", async () => {
        let repair: SocialExtractionRepairContext | undefined;
        for (let attempt = 0; attempt < MAX_EXTRACTION_ATTEMPTS; attempt += 1) {
          attempts = attempt + 1;
          repairCount = attempt;
          const raw = await deps.generate(input, repair);
          const result = parseAndValidateSocialExtraction(raw, input);
          if (result.rejectedCount === 0) {
            deps.store.applyOperations(input.conversationId, result.operations, input.now);
            deps.recordMetric?.({
              outcome: "success",
              acceptedCount: result.operations.length,
              rejectedCount: 0,
              attempts,
              repairCount,
            });
            return;
          }
          if (attempt === MAX_EXTRACTION_ATTEMPTS - 1) {
            deps.recordMetric?.({
              outcome: "failure",
              acceptedCount: 0,
              rejectedCount: result.rejectedCount,
              attempts: MAX_EXTRACTION_ATTEMPTS,
              repairCount: MAX_EXTRACTION_ATTEMPTS - 1,
            });
            return;
          }
          repair = {
            attempt: (attempt + 1) as 1 | 2,
            previousOutput: raw.slice(0, MAX_REPAIR_OUTPUT_CHARS),
            rejectedCount: result.rejectedCount,
          };
        }
      }).catch(() => {
        deps.recordMetric?.({
          outcome: "failure",
          acceptedCount: 0,
          rejectedCount: 0,
          attempts,
          repairCount,
        });
      });
    },
  };
}
