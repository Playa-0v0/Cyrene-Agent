import type { ConversationMode } from "../../../../../shared/chat-types";

export function shouldRunModelForMode(
  mode: ConversationMode,
  hasDemoResponse: boolean,
  hasDemoSticker: boolean,
): boolean {
  return (mode === "chat" || mode === "work" || mode === "code" || mode === "learn")
    && !hasDemoResponse
    && !hasDemoSticker;
}

/** Plan review events are emitted after the originating run has finished. */
export function shouldListenForDeferredPlanEvents(mode: ConversationMode): boolean {
  return mode === "code" || mode === "chat";
}
