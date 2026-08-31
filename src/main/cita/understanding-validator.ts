import type {
  ContextRef,
  ModelVisibleContext,
  TurnUnderstanding,
  TurnUnderstandingInput,
  UnderstandingValidationResult,
} from "./contracts";

type RefState = "valid" | "unknown" | "cross_conversation" | "expired" | "unpresented";

function classifyRef(
  ref: ContextRef,
  contexts: Map<ContextRef, ModelVisibleContext>,
  conversationId: string,
  now: number,
): RefState {
  const context = contexts.get(ref);
  if (!context) return "unknown";
  if (context.conversationId !== conversationId) return "cross_conversation";
  if (context.kind === "candidate" && context.presented !== true) return "unpresented";
  if (context.lifecycle === "expired" || (context.expiresAt !== undefined && now >= context.expiresAt)) {
    return "expired";
  }
  return "valid";
}

export function validateUnderstanding(
  input: TurnUnderstandingInput,
  candidate: TurnUnderstanding,
  now: number,
): UnderstandingValidationResult {
  const contexts = new Map(input.availableContexts.map((context) => [context.contextRef, context]));
  const reasons = new Set<string>();

  const validateRef = (ref: ContextRef): boolean => {
    const state = classifyRef(ref, contexts, input.conversationId, now);
    if (state === "valid") return true;
    reasons.add(`${state}_ref:${ref}`);
    return false;
  };

  const resolvedReferences = candidate.resolvedReferences.filter((reference) => validateRef(reference.targetRef));
  const focusedEntityRefs = candidate.focusedEntityRefs.filter(validateRef);
  const rewriteDiffers = candidate.contextualizedQuery !== input.originalQuery;
  const lacksTrustedGrounding = resolvedReferences.length === 0 && focusedEntityRefs.length === 0;
  const rewriteIsUnsupported = rewriteDiffers && (
    candidate.rewriteStatus === "unchanged"
    || candidate.rewriteStatus === "rewritten" && lacksTrustedGrounding
  );

  if (rewriteIsUnsupported) reasons.add("unsupported_contextualized_query");
  const mustFallback = reasons.size > 0;
  const understanding: TurnUnderstanding = {
    ...candidate,
    resolvedReferences,
    focusedEntityRefs,
    contextualizedQuery: mustFallback ? input.originalQuery : candidate.contextualizedQuery,
    rewriteStatus: mustFallback ? "insufficient_context" : candidate.rewriteStatus,
  };

  if (!mustFallback) return { status: "accepted", understanding };
  return { status: "degraded", understanding, reasons: [...reasons] };
}
