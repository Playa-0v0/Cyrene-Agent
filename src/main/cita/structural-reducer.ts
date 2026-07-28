import type { ContextEvent, ContextState } from "./contracts";

export function reduceStructuralEvent(state: ContextState, event: ContextEvent): ContextState {
  if (state.conversationId !== event.conversationId) throw new Error("E_CITA_CONVERSATION_MISMATCH");

  if (event.type === "conversation_reset") {
    return {
      conversationId: state.conversationId,
      revision: state.revision + 1,
      updatedAt: event.occurredAt,
      contexts: [],
      focusedEntityRefs: [],
    };
  }

  let contexts = state.contexts;
  if (event.type === "context_upserted") {
    if (event.context.conversationId !== event.conversationId) throw new Error("E_CITA_CONVERSATION_MISMATCH");
    contexts = [
      ...contexts.filter((item) => item.contextRef !== event.context.contextRef),
      event.context,
    ];
  } else if (event.type === "context_presented") {
    const refs = new Set(event.contextRefs);
    contexts = contexts.map((item) => refs.has(item.contextRef) ? { ...item, presented: true } : item);
  }

  return {
    ...state,
    revision: state.revision + 1,
    updatedAt: event.occurredAt,
    contexts,
  };
}
