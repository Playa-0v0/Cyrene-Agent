import { enqueueLLMTask } from "../llm-queue"
import { runReflectionAndCompression } from "./memory-compressor"
import { entityGraph } from "./entity-graph"
import { memoryJudge } from "./memory-judge"
import { memoryManager } from "./memory-manager"
import { runResolverQueueOnce } from "./memory-resolver"
import { memoryStore } from "./memory-store"
import type { L1Profile, MemoryCandidate } from "./memory-types"

export interface MemorySchedulerDeps {
  ingestEntity: (text: string) => void
  enqueueTask: <T>(label: string, task: () => Promise<T>) => Promise<T>
  judgeMemory: (userInput: string, assistantReply: string, conversationId: string) => Promise<MemoryCandidate[]>
  writeMemory: (candidates: MemoryCandidate[]) => Promise<void>
  getL1: () => Promise<L1Profile>
  replaceL1Field: (field: "roundCount", value: number) => Promise<void>
  runReflectionAndCompression: () => Promise<void>
  runResolverQueueOnce: () => Promise<unknown>
}

export class MemoryScheduler {
  constructor(private readonly deps: MemorySchedulerDeps) {}

  scheduleMemoryWrite(userInput: string, assistantReply: string): void {
    try {
      this.deps.ingestEntity(userInput)
      this.deps.ingestEntity(assistantReply)
    } catch (err) {
      console.warn("[Memory] 实体图谱提取失败:", err)
    }

    this.deps.enqueueTask("MemoryJudge", async () => {
      await this.runQueuedMemoryWrite(userInput, assistantReply)
    }).catch((e) => {
      console.error("[Memory] 记忆写入失败，不影响主流程", e)
    })
  }

  private async runQueuedMemoryWrite(userInput: string, assistantReply: string): Promise<void> {
    try {
      const candidates = await this.deps.judgeMemory(
        userInput,
        assistantReply,
        "default",
      )

      if (candidates.length > 0) {
        await this.deps.writeMemory(candidates)
      }
    } catch (err) {
      console.error("[Memory] MemoryJudge/Manager 执行失败，本轮仍会计数", err)
    }

    const l1 = await this.deps.getL1()
    const newCount = (l1.roundCount || 0) + 1
    await this.deps.replaceL1Field("roundCount", newCount)

    if (newCount % 5 === 0) {
      try {
        await this.deps.runResolverQueueOnce()
      } catch (err) {
        console.warn("[Memory] Resolver 队列处理失败，不影响主流程", err)
      }
    }

    if (newCount % 20 === 0) {
      console.log("[Memory] 达到 20 轮，触发 Reflection + 记忆压缩")
      await this.deps.runReflectionAndCompression()
    }
  }
}

export const memoryScheduler = new MemoryScheduler({
  ingestEntity: (text) => entityGraph.ingest(text),
  enqueueTask: enqueueLLMTask,
  judgeMemory: (userInput, assistantReply, conversationId) => memoryJudge.judge(userInput, assistantReply, conversationId),
  writeMemory: (candidates) => memoryManager.writeMemory(candidates),
  getL1: () => memoryStore.getL1(),
  replaceL1Field: (field, value) => memoryStore.replaceL1Field(field, value),
  runReflectionAndCompression,
  runResolverQueueOnce,
})
