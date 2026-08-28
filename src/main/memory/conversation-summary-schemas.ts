import type { BusinessValidationResult } from "../orchestrator/structured-output/runner"
import type { ConversationSummaryDraft } from "./conversation-summary-types"

const FIELD_LIMITS = {
  overview: 1600,
  listItem: 300,
  listCount: 20,
} as const

function requiredObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("conversation summary must be an object")
  }
  return value as Record<string, unknown>
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`)
  return normalized
}

function boundedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > FIELD_LIMITS.listCount) throw new Error(`${label} has too many items`)
  return [...new Set(value.map((item, index) => boundedString(
    item,
    `${label}[${index}]`,
    FIELD_LIMITS.listItem,
  )))]
}

export function parseConversationSummaryDraft(value: unknown): ConversationSummaryDraft {
  const object = requiredObject(value)
  return {
    overview: boundedString(object.overview, "overview", FIELD_LIMITS.overview),
    topics: boundedStringArray(object.topics, "topics"),
    decisions: boundedStringArray(object.decisions, "decisions"),
    openLoops: boundedStringArray(object.openLoops, "openLoops"),
    entities: boundedStringArray(object.entities, "entities"),
    keywords: boundedStringArray(object.keywords, "keywords"),
  }
}

export function validateConversationSummaryDraft(
  value: ConversationSummaryDraft,
): BusinessValidationResult<ConversationSummaryDraft> {
  if (!value.overview.trim()) {
    return {
      status: "rejected",
      error: {
        layer: "business",
        code: "EMPTY_CONVERSATION_SUMMARY",
        disposition: "repair",
      },
    }
  }
  return { status: "accepted", value }
}

export const CONVERSATION_SUMMARY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    overview: { type: "string" },
    topics: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    openLoops: { type: "array", items: { type: "string" } },
    entities: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
  },
  required: ["overview", "topics", "decisions", "openLoops", "entities", "keywords"],
  additionalProperties: false,
}
