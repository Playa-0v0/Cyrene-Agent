import type { ChatMessageChannelSource, ConversationMode } from "../../../../../shared/chat-types";

interface RevisableMessage {
  id: string;
  role: "user" | "assistant" | "model" | "system";
  loading?: boolean;
  streaming?: boolean;
  reasoningStreaming?: boolean;
  channelSource?: ChatMessageChannelSource;
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
  // 渠道镜像轮次只能展示。桌面端编辑/重新生成会改用桌面会话身份执行，
  // 既不会回发原渠道，也可能让可见正文与渠道模型上下文失配。
  if (user.channelSource || assistant.channelSource) return null;
  if (assistant.loading || assistant.streaming || assistant.reasoningStreaming) return null;
  return {
    userMessageId: user.id,
    assistantMessageId: assistant.id,
  };
}
