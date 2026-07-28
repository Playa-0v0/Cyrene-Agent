import type { TurnUnderstanding } from "./contracts";

const RELATIONS = new Set(["direct", "candidate_position", "previous", "focused", "comparison_item"]);
const REWRITE_STATUSES = new Set(["unchanged", "rewritten", "insufficient_context"]);

/** 旧值兼容映射：contextualized -> rewritten, ambiguous -> insufficient_context */
function normalizeRewriteStatus(value: unknown): TurnUnderstanding["rewriteStatus"] {
  if (typeof value !== "string" || !value) throw new Error("rewriteStatus is invalid");
  if (value === "contextualized") return "rewritten";
  if (value === "ambiguous") return "insufficient_context";
  if (!REWRITE_STATUSES.has(value)) throw new Error("rewriteStatus is invalid");
  return value as TurnUnderstanding["rewriteStatus"];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, max = 2_000): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

export function parseTurnUnderstanding(value: unknown): TurnUnderstanding {
  const root = object(value, "TurnUnderstanding");

  // 先提取需要的 4 个字段，忽略多余的旧字段（dialogueAct / topicTransition / uncertainties）
  const resolvedReferences = array(root.resolvedReferences, "resolvedReferences", 32).map((item, index) => {
    const ref = object(item, `resolvedReferences[${index}]`);
    if (!RELATIONS.has(ref.relation as string)) throw new Error(`resolvedReferences[${index}].relation is invalid`);
    return {
      surface: string(ref.surface, `resolvedReferences[${index}].surface`, 200),
      targetRef: string(ref.targetRef, `resolvedReferences[${index}].targetRef`, 240),
      relation: ref.relation as TurnUnderstanding["resolvedReferences"][number]["relation"],
    };
  });

  const focusedEntityRefs = array(root.focusedEntityRefs, "focusedEntityRefs", 16)
    .map((item, index) => string(item, `focusedEntityRefs[${index}]`, 240));
  const contextualizedQuery = string(root.contextualizedQuery, "contextualizedQuery");
  const rewriteStatus = normalizeRewriteStatus(root.rewriteStatus);

  return {
    resolvedReferences,
    focusedEntityRefs,
    contextualizedQuery,
    rewriteStatus,
  };
}
