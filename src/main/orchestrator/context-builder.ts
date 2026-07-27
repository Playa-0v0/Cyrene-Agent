// Orchestrator Context Builder — post-chat 副作用（記憶寫入 + Reflection）
import { memoryScheduler } from "../memory/memory-scheduler";

export function scheduleMemoryWrite(userInput: string, assistantReply: string): void {
  memoryScheduler.scheduleMemoryWrite(userInput, assistantReply);
}
