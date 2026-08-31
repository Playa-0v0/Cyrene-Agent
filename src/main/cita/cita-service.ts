import type {
  CitaSettings,
  ContextEvent,
  ContextPackage,
  ModelVisibleContext,
  TurnUnderstanding,
} from "./contracts";
import { buildCitaContextBlock } from "./context-package";
import type { ContextStore } from "./context-store";
import type { CitaSemanticEngine } from "./semantic-engine";
import { validateUnderstanding } from "./understanding-validator";
import { perf } from "../perf-trace";
import { debugLog } from "../agent-log";

export interface CitaPrepareTurnInput {
  conversationId: string;
  turnId: string;
  originalQuery: string;
  recentDialogue: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface CitaPrepareTurnResult {
  contextPackage?: ContextPackage;
  contextBlock: string;
}

interface CitaServiceInput {
  store: ContextStore;
  engine: CitaSemanticEngine;
  getSettings: () => CitaSettings;
  now?: () => number;
}

const SENSITIVE_ATTRIBUTE_KEY = /cookie|authorization|api.?key|secret|token|csrf|music_u/i;
const SENSITIVE_VALUE = /MUSIC_U=|__csrf=|csrf_token=|Authorization\s*:\s*Bearer\s+/i;

function isSafeProjection(event: ContextEvent): boolean {
  if (event.type !== "context_upserted") return true;
  const attributes = event.context.attributes ?? {};
  if (Object.keys(attributes).some((key) => SENSITIVE_ATTRIBUTE_KEY.test(key))) return false;
  return !SENSITIVE_VALUE.test(JSON.stringify({ label: event.context.label, attributes }));
}

export class CitaService {
  private readonly store: ContextStore;
  private readonly engine: CitaSemanticEngine;
  private readonly getSettings: () => CitaSettings;
  private readonly now: () => number;

  constructor(input: CitaServiceInput) {
    this.store = input.store;
    this.engine = input.engine;
    this.getSettings = input.getSettings;
    this.now = input.now ?? Date.now;
  }

  ingest(event: ContextEvent): void {
    if (!isSafeProjection(event)) {
      console.warn("[CITA] rejected unsafe context projection");
      return;
    }
    this.store.append(event);
  }

  async prepareTurn(input: CitaPrepareTurnInput, signal?: AbortSignal): Promise<CitaPrepareTurnResult> {
    const settings = this.getSettings();
    if (!settings.enabled) {
      debugLog(`[CITA/Trace] bypass conversation=${input.conversationId} reason=disabled`);
      return { contextBlock: "" };
    }

    const state = this.store.snapshot(input.conversationId);
    const recentEvents = this.store.recentEvents(input.conversationId);
    debugLog(
      `[CITA/Trace] prepare conversation=${input.conversationId} turn=${input.turnId} revision=${state.revision} contexts=${state.contexts.length} events=${recentEvents.length} queryChars=${input.originalQuery.length}`,
    );
    if (settings.semanticEngine === "local") {
      debugLog(`[CITA/Trace] unavailable conversation=${input.conversationId} reason=local_engine_deferred`);
      return this.buildUnavailablePackage(input, state.revision);
    }

    const understandingInput = {
      ...input,
      stateRevision: state.revision,
      availableContexts: state.contexts,
      recentEvents,
    };

    try {
      const candidate = await perf.track("cita_engine_understand", () => this.engine.understandTurn(understandingInput, signal));
      const validateTimer = perf.begin("cita_validate");
      const validation = validateUnderstanding(understandingInput, candidate, this.now());
      validateTimer.end();
      if (validation.status === "rejected") {
        console.warn("[CITA] understandTurn status=rejected");
        return this.buildUnavailablePackage(input, state.revision);
      }
      const contextPackage = this.toContextPackage(
        input.originalQuery,
        validation.understanding,
        state.contexts,
        state.revision,
        validation.status === "accepted" ? "ready" : "degraded",
      );
      const blockTimer = perf.begin("cita_build_context_block");
      const contextBlock = buildCitaContextBlock(contextPackage);
      blockTimer.end();
      debugLog(
        `[CITA/Trace] result conversation=${input.conversationId} status=${validation.status} rewrite=${validation.understanding.rewriteStatus} refs=${this.formatRefs(validation.understanding.resolvedReferences.map((reference) => reference.targetRef))} focused=${validation.understanding.focusedEntityRefs.length} supporting=${contextPackage.supportingContexts?.length ?? 0} blockChars=${contextBlock.length}`,
      );
      return { contextPackage, contextBlock };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error || "unknown_error");
      console.warn(`[CITA] unavailable conversation=${input.conversationId} reason=${reason}`);
      return this.buildUnavailablePackage(input, state.revision);
    }
  }

  clear(conversationId?: string): void {
    this.store.clear(conversationId);
  }

  private buildUnavailablePackage(
    input: CitaPrepareTurnInput,
    stateRevision: number,
  ): CitaPrepareTurnResult {
    const supportingContexts = this.collectSupportingContexts(
      this.store.snapshot(input.conversationId).contexts,
    );
    const contextPackage: ContextPackage = {
      originalQuery: input.originalQuery,
      contextualizedQuery: input.originalQuery,
      rewriteStatus: "unchanged",
      resolvedReferences: [],
      focusedContexts: [],
      supportingContexts,
      semanticStatus: "unavailable",
      stateRevision,
    };
    return { contextPackage, contextBlock: buildCitaContextBlock(contextPackage) };
  }

  private toContextPackage(
    originalQuery: string,
    understanding: TurnUnderstanding,
    contexts: ModelVisibleContext[],
    stateRevision: number,
    semanticStatus: ContextPackage["semanticStatus"],
  ): ContextPackage {
    const focusedRefs = new Set([
      ...understanding.focusedEntityRefs,
      ...understanding.resolvedReferences.map((reference) => reference.targetRef),
    ]);
    return {
      originalQuery,
      contextualizedQuery: understanding.contextualizedQuery,
      rewriteStatus: understanding.rewriteStatus,
      resolvedReferences: understanding.resolvedReferences,
      focusedContexts: contexts.filter((context) => focusedRefs.has(context.contextRef)),
      supportingContexts: this.collectSupportingContexts(contexts),
      semanticStatus,
      stateRevision,
    };
  }

  private collectSupportingContexts(contexts: ModelVisibleContext[]): ModelVisibleContext[] {
    return contexts
      .filter((context) => context.lifecycle === "active" && context.presented === true)
      .slice(-20);
  }

  private formatRefs(refs: string[]): string {
    if (refs.length === 0) return "[]";
    const visible = refs.slice(0, 5);
    return `[${visible.join(",")}${refs.length > visible.length ? `,+${refs.length - visible.length}` : ""}]`;
  }
}
