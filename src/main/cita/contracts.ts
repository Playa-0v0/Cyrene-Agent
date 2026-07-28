export type ContextRef = string;

export type DialogueActType =
  | "affirm"
  | "cancel"
  | "select"
  | "request"
  | "request_explanation"
  | "inform"
  | "correct"
  | "continue"
  | "compare"
  | "comment"
  | "greet"
  | "unclear";

export interface ModelVisibleContext {
  contextRef: ContextRef;
  conversationId: string;
  domain: string;
  kind: string;
  label: string;
  attributes?: Record<string, string | string[]>;
  position?: number;
  presented?: boolean;
  lifecycle: "active" | "expired";
  expiresAt?: number;
  source: "tool_result" | "ui_event" | "runtime_event";
}

export interface ContextEventBase {
  eventId: string;
  conversationId: string;
  occurredAt: number;
  source: string;
}

export type ContextEvent = ContextEventBase & (
  | { type: "context_upserted"; context: ModelVisibleContext }
  | { type: "context_presented"; contextRefs: ContextRef[] }
  | { type: "tool_failed"; toolId: string; errorCode: string }
  | { type: "conversation_reset" }
);

export interface ContextState {
  conversationId: string;
  revision: number;
  updatedAt: number;
  contexts: ModelVisibleContext[];
  focusedEntityRefs: ContextRef[];
  activeDomain?: string;
  activeTopic?: string;
}

export interface StateUpdateProposal {
  baseRevision: number;
  activeDomain?: string;
  activeTopic?: string;
  focusedEntityRefs: ContextRef[];
}

export interface TurnObservationInput {
  conversationId: string;
  baseRevision: number;
  recentDialogue: Array<{ role: "user" | "assistant"; text: string }>;
  recentEvents: ContextEvent[];
}

export interface TurnUnderstandingInput {
  conversationId: string;
  turnId: string;
  stateRevision: number;
  originalQuery: string;
  availableContexts: ModelVisibleContext[];
  recentDialogue: Array<{ role: "user" | "assistant"; text: string }>;
  recentEvents: ContextEvent[];
}

export interface TurnUnderstanding {
  resolvedReferences: Array<{
    surface: string;
    targetRef: ContextRef;
    relation: "direct" | "candidate_position" | "previous" | "focused" | "comparison_item";
  }>;
  focusedEntityRefs: ContextRef[];
  contextualizedQuery: string;
  rewriteStatus: "unchanged" | "rewritten" | "insufficient_context";
}

export interface ContextPackage {
  originalQuery: string;
  contextualizedQuery: string;
  rewriteStatus: TurnUnderstanding["rewriteStatus"];
  resolvedReferences: TurnUnderstanding["resolvedReferences"];
  focusedContexts: ModelVisibleContext[];
  /** 当前仍可引用的已展示上下文。它是证据，不代表 CITA 替 Agent 做了决定。 */
  supportingContexts?: ModelVisibleContext[];
  semanticStatus: "ready" | "degraded" | "unavailable";
  stateRevision: number;
}

export type UnderstandingValidationResult =
  | { status: "accepted"; understanding: TurnUnderstanding }
  | { status: "degraded"; understanding: TurnUnderstanding; reasons: string[] }
  | { status: "rejected"; reasons: string[] };

export interface CitaSettings {
  enabled: boolean;
  semanticEngine: "remote" | "local";
}
