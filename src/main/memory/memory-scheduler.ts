import { enqueueLLMTask } from "../llm-queue"
import { runReflectionAndCompression } from "./memory-compressor"
import { entityGraph } from "./entity-graph"
import type { ExtractedEntity } from "./entity-graph"
import { memoryJudge } from "./memory-judge"
import { memoryManager } from "./memory-manager"
import { runResolverQueueOnce } from "./memory-resolver"
import { memoryStore } from "./memory-store"
import type { MemoryJudgeResult } from "./memory-schemas"
import type { L1Profile, MemoryCandidate, MemoryJudgeTurn } from "./memory-types"

const MEMORY_JUDGE_INTERVAL = 6
const MEMORY_JUDGE_CONTEXT_TURNS = 8

export interface MemorySchedulerDeps {
  enqueueTask: <T>(label: string, task: () => Promise<T>) => Promise<T>
  judgeMemory: (turns: MemoryJudgeTurn[], conversationId: string) => Promise<MemoryJudgeResult>
  writeMemory: (candidates: MemoryCandidate[]) => Promise<void>
  /** 把 judge 顺手抽取的命名实体入库（零额外 LLM 调用） */
  ingestEntities: (entities: ExtractedEntity[]) => void
  getL1: () => Promise<L1Profile>
  replaceL1Field: (field: "roundCount", value: number) => Promise<void>
  runReflectionAndCompression: () => Promise<void>
  runResolverQueueOnce: () => Promise<unknown>
  runDecay: () => Promise<void>
}

export class MemoryScheduler {
  private recentTurns: Array<MemoryJudgeTurn & { seq: number }> = []
  private nextTurnSeq = 0

  constructor(private readonly deps: MemorySchedulerDeps) {}

  scheduleMemoryWrite(userInput: string, assistantReply: string, conversationId?: string): void {
    const seq = ++this.nextTurnSeq
    this.recentTurns.push({ seq, userInput, assistantReply })
    if (this.recentTurns.length > MEMORY_JUDGE_CONTEXT_TURNS * 2) {
      this.recentTurns = this.recentTurns.slice(-MEMORY_JUDGE_CONTEXT_TURNS * 2)
    }

    this.deps.enqueueTask("MemoryMaintenance", async () => {
      await this.runQueuedMemoryWrite(seq, conversationId)
    }).catch((e) => {
      console.error("[PMRS/Scheduler] 记忆写入失败，不影响主流程", e)
    })
  }

  private async runQueuedMemoryWrite(seq: number, conversationId?: string): Promise<void> {
    const l1 = await this.deps.getL1()
    const newCount = (l1.roundCount || 0) + 1

    if (newCount % MEMORY_JUDGE_INTERVAL === 0) {
      try {
        const turns = this.recentTurns
          .filter((turn) => turn.seq <= seq)
          .slice(-MEMORY_JUDGE_CONTEXT_TURNS)
          .map(({ userInput, assistantReply }) => ({ userInput, assistantReply }))
        const { candidates, entities } = await this.deps.judgeMemory(turns, conversationId ?? "default")

        if (candidates.length > 0) {
          await this.deps.writeMemory(candidates)
        }
        // 实体入库：judge 顺手抽取，零额外 LLM 调用，取代旧的正则 ingest
        if (entities.length > 0) {
          this.deps.ingestEntities(entities)
        }
      } catch (err) {
        console.error("[PMRS/Scheduler] Judge/Manager 执行失败，本轮仍会计数", err)
      }
    }

    await this.deps.replaceL1Field("roundCount", newCount)

    if (newCount % 5 === 0) {
      try {
        await this.deps.runResolverQueueOnce()
      } catch (err) {
        console.warn("[PMRS/Scheduler] Resolver 队列处理失败，不影响主流程", err)
      }
    }

    if (newCount % 20 === 0) {
      console.log("[PMRS/Scheduler] 达到 20 轮，触发回顾 + 片段压缩")
      await this.deps.runReflectionAndCompression()
    }

    if (newCount % 50 === 0) {
      try {
        await this.deps.runDecay()
      } catch (err) {
        console.warn("[PMRS/Scheduler] L2 权重衰减失败，不影响主流程", err)
      }
    }
  }
}

export const memoryScheduler = new MemoryScheduler({
  enqueueTask: enqueueLLMTask,
  judgeMemory: (turns, conversationId) => memoryJudge.judgeRecentTurns(turns, conversationId),
  writeMemory: (candidates) => memoryManager.writeMemory(candidates),
  ingestEntities: (entities) => entityGraph.ingestEntities(entities),
  getL1: () => memoryStore.getL1(),
  replaceL1Field: (field, value) => memoryStore.replaceL1Field(field, value),
  runReflectionAndCompression,
  runResolverQueueOnce,
  runDecay: () => memoryManager.runDecay(),
})
