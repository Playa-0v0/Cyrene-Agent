import type { ContextEvent, ContextState, StateUpdateProposal } from "./contracts";
import { reduceStructuralEvent } from "./structural-reducer";

interface ContextStoreOptions {
  maxEventsPerConversation?: number;
  maxContextsPerConversation?: number;
  now?: () => number;
}

export class ContextStore {
  private readonly states = new Map<string, ContextState>();
  private readonly events = new Map<string, ContextEvent[]>();
  private readonly maxEvents: number;
  private readonly maxContexts: number;
  private readonly now: () => number;

  constructor(options: ContextStoreOptions = {}) {
    this.maxEvents = Math.max(1, options.maxEventsPerConversation ?? 64);
    this.maxContexts = Math.max(1, options.maxContextsPerConversation ?? 256);
    this.now = options.now ?? Date.now;
  }

  append(event: ContextEvent): ContextState {
    const next = reduceStructuralEvent(this.getState(event.conversationId), event);
    next.contexts = next.contexts
      .filter((context) => context.expiresAt === undefined || context.expiresAt > this.now())
      .slice(-this.maxContexts);
    this.states.set(event.conversationId, next);
    const events = [...(this.events.get(event.conversationId) ?? []), event].slice(-this.maxEvents);
    this.events.set(event.conversationId, events);
    return this.snapshot(event.conversationId);
  }

  snapshot(conversationId: string): ContextState {
    const state = structuredClone(this.getState(conversationId));
    const now = this.now();
    state.contexts = state.contexts.map((context) => (
      context.expiresAt !== undefined && now >= context.expiresAt
        ? { ...context, lifecycle: "expired" as const }
        : context
    ));
    return state;
  }

  recentEvents(conversationId: string): ContextEvent[] {
    return structuredClone(this.events.get(conversationId) ?? []);
  }

  applySemanticUpdate(
    conversationId: string,
    baseRevision: number,
    update: StateUpdateProposal,
  ): boolean {
    const current = this.getState(conversationId);
    if (current.revision !== baseRevision || update.baseRevision !== baseRevision) return false;
    this.states.set(conversationId, {
      ...current,
      revision: current.revision + 1,
      updatedAt: this.now(),
      activeDomain: update.activeDomain,
      activeTopic: update.activeTopic,
      focusedEntityRefs: [...update.focusedEntityRefs],
    });
    return true;
  }

  clear(conversationId?: string): void {
    if (conversationId === undefined) {
      this.states.clear();
      this.events.clear();
      return;
    }
    this.states.delete(conversationId);
    this.events.delete(conversationId);
  }

  private getState(conversationId: string): ContextState {
    return this.states.get(conversationId) ?? {
      conversationId,
      revision: 0,
      updatedAt: this.now(),
      contexts: [],
      focusedEntityRefs: [],
    };
  }
}
