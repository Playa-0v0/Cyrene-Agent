import type { ConversationMode } from "../../../../../shared/chat-types";

interface RevisableMessage {
  id: string;
  role: "user" | "assistant" | "model" | "system";
  loading?: boolean;
  streaming?: boolean;
  reasoningStreaming?: boolean;
}

export interface RevisableLastTurn {
  userMessageId: string;
  assistantMessageId: string;
}

export function resolveRevisableLastTurn(
  messages: readonly RevisableMessage[],
  mode: ConversationMode,
): RevisableLastTurn | null {
  if (mode !== "chat" || messages.length < 2) return null;
  const user = messages[messages.length - 2];
  const assistant = messages[messages.length - 1];
  if (user.role !== "user" || (assistant.role !== "assistant" && assistant.role !== "model")) return null;
  if (assistant.loading || assistant.streaming || assistant.reasoningStreaming) return null;
  return {
    userMessageId: user.id,
    assistantMessageId: assistant.id,
  };
}
