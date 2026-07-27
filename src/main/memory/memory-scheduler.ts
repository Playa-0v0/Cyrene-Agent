import { enqueueLLMTask } from "../llm-queue"
import { runReflectionAndCompression } from "./memory-compressor"
import { entityGraph } from "./entity-graph"
import { memoryJudge } from "./memory-judge"
import { memoryManager } from "./memory-manager"
import { runResolverQueueOnce } from "./memory-resolver"
import { memoryStore } from "./memory-store"
import type { L1Profile, MemoryCandidate, MemoryJudgeTurn } from "./memory-types"

const MEMORY_JUDGE_INTERVAL = 6
const MEMORY_JUDGE_CONTEXT_TURNS = 8

export interface MemorySchedulerDeps {
  ingestEntity: (text: string) => void
  enqueueTask: <T>(label: string, task: () => Promise<T>) => Promise<T>
  judgeMemory: (turns: MemoryJudgeTurn[], conversationId: string) => Promise<MemoryCandidate[]>
  writeMemory: (candidates: MemoryCandidate[]) => Promise<void>
  getL1: () => Promise<L1Profile>
  replaceL1Field: (field: "roundCount", value: number) => Promise<void>
  runReflectionAndCompression: () => Promise<void>
  runResolverQueueOnce: () => Promise<unknown>
}

export class MemoryScheduler {
  private recentTurns: Array<MemoryJudgeTurn & { seq: number }> = []
  private nextTurnSeq = 0

  constructor(private readonly deps: MemorySchedulerDeps) {}

  scheduleMemoryWrite(userInput: string, assistantReply: string): void {
    const seq = ++this.nextTurnSeq
    this.recentTurns.push({ seq, userInput, assistantReply })
    if (this.recentTurns.length > MEMORY_JUDGE_CONTEXT_TURNS * 2) {
      this.recentTurns = this.recentTurns.slice(-MEMORY_JUDGE_CONTEXT_TURNS * 2)
    }

    try {
      this.deps.ingestEntity(userInput)
      this.deps.ingestEntity(assistantReply)
    } catch (err) {
      console.warn("[Memory] 實體圖譜提取失敗:", err)
    }

    this.deps.enqueueTask("MemoryMaintenance", async () => {
      await this.runQueuedMemoryWrite(seq)
    }).catch((e) => {
      console.error("[Memory] 記憶寫入失敗，不影響主流程", e)
    })
  }

  private async runQueuedMemoryWrite(seq: number): Promise<void> {
    const l1 = await this.deps.getL1()
    const newCount = (l1.roundCount || 0) + 1

    if (newCount % MEMORY_JUDGE_INTERVAL === 0) {
      try {
        const turns = this.recentTurns
          .filter((turn) => turn.seq <= seq)
          .slice(-MEMORY_JUDGE_CONTEXT_TURNS)
          .map(({ userInput, assistantReply }) => ({ userInput, assistantReply }))
        const candidates = await this.deps.judgeMemory(turns, "default")

        if (candidates.length > 0) {
          await this.deps.writeMemory(candidates)
        }
      } catch (err) {
        console.error("[Memory] MemoryJudge/Manager 執行失敗，本輪仍會計數", err)
      }
    }

    await this.deps.replaceL1Field("roundCount", newCount)

    if (newCount % 5 === 0) {
      try {
        await this.deps.runResolverQueueOnce()
      } catch (err) {
        console.warn("[Memory] Resolver 隊列處理失敗，不影響主流程", err)
      }
    }

    if (newCount % 20 === 0) {
      console.log("[Memory] 達到 20 輪，觸發 Reflection + 記憶壓縮")
      await this.deps.runReflectionAndCompression()
    }
  }
}

export const memoryScheduler = new MemoryScheduler({
  ingestEntity: (text) => entityGraph.ingest(text),
  enqueueTask: enqueueLLMTask,
  judgeMemory: (turns, conversationId) => memoryJudge.judgeRecentTurns(turns, conversationId),
  writeMemory: (candidates) => memoryManager.writeMemory(candidates),
  getL1: () => memoryStore.getL1(),
  replaceL1Field: (field, value) => memoryStore.replaceL1Field(field, value),
  runReflectionAndCompression,
  runResolverQueueOnce,
})
