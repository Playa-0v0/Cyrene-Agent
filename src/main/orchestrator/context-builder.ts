// Orchestrator Context Builder — post-chat 副作用（记忆写入 + Reflection）
import { memoryScheduler } from "../memory/memory-scheduler";

export function scheduleMemoryWrite(userInput: string, assistantReply: string, conversationId?: string): void {
  memoryScheduler.scheduleMemoryWrite(userInput, assistantReply, conversationId);
}
