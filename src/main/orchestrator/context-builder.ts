// Orchestrator Context Builder — post-chat 副作用（记忆写入 + Reflection）
import { memoryScheduler } from "../memory/memory-scheduler";
import type { MemoryJudgeTurn } from "../memory/memory-types";

export function scheduleMemoryWrite(
  userInput: string,
  assistantReply: string,
  conversationId: string,
  source?: Pick<MemoryJudgeTurn, "userMessageId" | "assistantMessageId">,
): void {
  memoryScheduler.scheduleMemoryWrite(userInput, assistantReply, conversationId, source);
}
