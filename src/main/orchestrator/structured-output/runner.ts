import { normalizeFinishReason } from "./finish-reason";
import { extractJsonCandidates } from "./json-candidates";
import type {
  StructuredErrorDisposition,
  StructuredValidationError,
} from "./errors";
import type { RecordStructuredOutputMetric } from "./metrics";
import type {
  StructuredOutputMode,
  StructuredOutputProfile,
  StructuredOutputStage,
} from "./types";
import { getTimeoutSettings } from "../../timeout-manager";

export interface StructuredGenerationResponse {
  text: string;
  finishReason?: string;
  refusal?: string;
  /** Already parsed by LangChain; when present, legacy JSON candidate extraction is bypassed. */
  structuredValue?: unknown;
}

export interface StructuredRepairContext {
  attempt: number;
  minimal: boolean;
  errors: StructuredValidationError[];
}

export type BusinessValidationResult<T> =
  | { status: "accepted"; value: T }
  | { status: "rejected"; error: StructuredValidationError };

export interface StructuredOutputRunInput<T, TRequest> {
  stage: StructuredOutputStage;
  profile: StructuredOutputProfile;
  buildRequest: (context: StructuredRepairContext) => TRequest;
  generate: (request: TRequest, signal: AbortSignal) => Promise<StructuredGenerationResponse>;
  parseSchema: (value: unknown) => T;
  validateBusiness: (value: T) => BusinessValidationResult<T>;
  signal?: AbortSignal;
  now?: () => number;
  recordMetric?: RecordStructuredOutputMetric;
}

export type StructuredOutputRunResult<T> =
  | {
      outcome: "success";
      value: T;
      mode: StructuredOutputMode;
      attempts: number;
      repairCount: number;
    }
  | {
      outcome: "failure";
      failure: {
        stage: StructuredOutputStage;
        code: string;
        disposition: StructuredErrorDisposition;
        attempts: number;
        toolExecuted: false;
      };
    };

function validationError(
  layer: StructuredValidationError["layer"],
  code: string,
  disposition: StructuredErrorDisposition,
): StructuredValidationError {
  return { layer, code, disposition };
}

export async function runStructuredOutput<T, TRequest>(
  input: StructuredOutputRunInput<T, TRequest>,
): Promise<StructuredOutputRunResult<T>> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  let policy = input.profile.repair[input.stage];
  let attempts = 0;
  let repairCount = 0;
  let errors: StructuredValidationError[] = [];
  let lastFinishReason = "unknown";
  let candidateCount = 0;
  let validCandidateCount = 0;

  const timeoutSettings = getTimeoutSettings();
  let policyOverride = false;
  const clonePolicyIfNeeded = () => {
    if (!policyOverride) {
      policy = { ...policy };
      policyOverride = true;
    }
  };
  if (timeoutSettings.profileTotalBudgetMs !== -1) {
    clonePolicyIfNeeded();
    policy.totalBudgetMs = timeoutSettings.profileTotalBudgetMs;
  }
  if (timeoutSettings.profilePerAttemptTimeoutMs !== -1) {
    clonePolicyIfNeeded();
    policy.perAttemptTimeoutMs = timeoutSettings.profilePerAttemptTimeoutMs;
  }
  if (timeoutSettings.profileMinimumRemainingBudgetMs !== -1) {
    clonePolicyIfNeeded();
    policy.minimumRemainingBudgetMs = timeoutSettings.profileMinimumRemainingBudgetMs;
  }

  const finish = (
    result: StructuredOutputRunResult<T>,
    failureCode?: string,
  ): StructuredOutputRunResult<T> => {
    input.recordMetric?.({
      stage: input.stage,
      mode: input.profile.mode,
      attempts,
      repairCount,
      finishReason: lastFinishReason,
      candidateCount,
      validCandidateCount,
      finalOutcome: result.outcome,
      ...(failureCode ? { validationFailureCode: failureCode } : {}),
      totalDurationMs: Math.max(0, now() - startedAt),
    });
    return result;
  };

  const fail = (
    code: string,
    disposition: StructuredErrorDisposition,
  ): StructuredOutputRunResult<T> => finish({
    outcome: "failure",
    failure: {
      stage: input.stage,
      code,
      disposition,
      attempts,
      toolExecuted: false,
    },
  }, code);

  while (true) {
    if (input.signal?.aborted) return fail("CANCELLED", "fail_closed");
    const remaining = policy.totalBudgetMs - (now() - startedAt);
    if (remaining < policy.minimumRemainingBudgetMs) {
      return fail("INSUFFICIENT_REPAIR_BUDGET", "fail_closed");
    }

    const request = input.buildRequest({
      attempt: repairCount,
      minimal: repairCount >= 2,
      errors,
    });
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = Math.min(policy.perAttemptTimeoutMs, remaining);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: StructuredGenerationResponse;
    attempts += 1;
    try {
      response = await Promise.race([
        input.generate(request, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("STRUCTURED_OUTPUT_TIMEOUT"));
          }, timeoutMs);
        }),
      ]);
    } catch {
      return fail("MODEL_REQUEST_FAILED", "fail_closed");
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }

    if (response.refusal) return fail("REFUSED", "fail_closed");
    const normalizedFinish = normalizeFinishReason(response.finishReason);
    lastFinishReason = normalizedFinish;
    if (normalizedFinish === "content_filtered") {
      return fail("CONTENT_FILTERED", "fail_closed");
    }
    if (normalizedFinish === "refused") return fail("REFUSED", "fail_closed");
    if (normalizedFinish === "tool_call") {
      return fail("UNEXPECTED_TOOL_CALL", "fail_closed");
    }
    if (normalizedFinish === "unknown") {
      return fail("UNKNOWN_FINISH_REASON", "fail_closed");
    }

    if (normalizedFinish === "truncated") {
      errors = [validationError("format", "TRUNCATED_OUTPUT", "repair")];
    } else {
      const candidateValues = response.structuredValue !== undefined
        ? [response.structuredValue]
        : extractJsonCandidates(response.text).map((candidate) => candidate.value);
      candidateCount = candidateValues.length;
      const valid: T[] = [];
      for (const candidate of candidateValues) {
        try {
          valid.push(input.parseSchema(candidate));
        } catch {
          // Schema error details stay local; raw model output is never returned to repair.
        }
      }
      validCandidateCount = valid.length;
      if (valid.length === 0) {
        errors = [validationError(
          candidateValues.length === 0 ? "format" : "schema",
          candidateValues.length === 0 ? "NO_JSON_OBJECT" : "NO_SCHEMA_VALID_OBJECT",
          "repair",
        )];
      } else if (valid.length > 1) {
        errors = [validationError(
          "schema",
          "AMBIGUOUS_MULTIPLE_VALID_OBJECTS",
          "repair",
        )];
      } else {
        const business = input.validateBusiness(valid[0]);
        if (business.status === "accepted") {
          return finish({
            outcome: "success",
            value: business.value,
            mode: input.profile.mode,
            attempts,
            repairCount,
          });
        }
        if (business.error.disposition !== "repair") {
          return fail(business.error.code, business.error.disposition);
        }
        errors = [business.error];
      }
    }

    if (repairCount >= policy.maxAttempts) {
      return fail("REPAIR_EXHAUSTED", "fail_closed");
    }
    repairCount += 1;
  }
}

