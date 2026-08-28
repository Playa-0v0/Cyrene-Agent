import * as chatsStore from "../chats/chats-store"
import * as fs from "fs"
import * as path from "path"
import {
  deleteMemoryByMetadata,
  deleteMemoryBySourceKey,
  deleteUserMemoryVectors,
  upsertMemoryBySourceKey,
} from "../rag"
import { ConversationSummaryService, generateConversationSummary } from "./conversation-summary-service"
import { ConversationSummaryStore } from "./conversation-summary-store"
import type { ConversationMemorySummary } from "./conversation-summary-types"
import { memoryStore } from "./memory-store"
import { enqueueLLMTask } from "../llm-queue"

let service: ConversationSummaryService | null = null
let store: ConversationSummaryStore | null = null

function summaryIndexText(summary: ConversationMemorySummary): string {
  return [
    summary.overview,
    summary.topics.length ? `主题：${summary.topics.join("、")}` : "",
    summary.decisions.length ? `决定：${summary.decisions.join("；")}` : "",
    summary.openLoops.length ? `待办：${summary.openLoops.join("；")}` : "",
    summary.currentState.length ? `当前状态：${summary.currentState.join("；")}` : "",
    summary.nextSteps.length ? `下一步：${summary.nextSteps.join("；")}` : "",
    summary.keywords.length ? `关键词：${summary.keywords.join("、")}` : "",
  ].filter(Boolean).join("\n")
}

export function getConversationSummaryStore(): ConversationSummaryStore {
  if (!store) store = new ConversationSummaryStore(chatsStore.getRootDir())
  return store
}

export function getConversationSummaryService(): ConversationSummaryService {
  if (!service) {
    service = new ConversationSummaryService({
      store: getConversationSummaryStore(),
      getSession: chatsStore.getSession,
      generateSummary: (input) => enqueueLLMTask(
        "ConversationSummary",
        () => generateConversationSummary(input),
      ),
      indexSummary: async (summary) => upsertMemoryBySourceKey(
        summaryIndexText(summary),
        "conversation_summary",
        summary.sessionId,
        {
          sessionId: summary.sessionId,
          revision: summary.revision,
          mode: summary.mode,
          updatedAt: summary.updatedAt,
        },
      ),
    })
  }
  return service
}

export function scheduleConversationSummary(sessionId: string, options?: { force?: boolean }): void {
  void getConversationSummaryService().schedule(sessionId, options).catch((error) => {
    console.warn("[ConversationSummary] 后台任务失败，不影响聊天:", sessionId, error)
  })
}

export async function deleteConversationMemoryArtifacts(sessionId: string): Promise<{
  deletedSummary: boolean
  deletedHistoryVectors: number
  deletedSummaryVectors: number
  deletedEvidenceCount: number
  deletedL2Count: number
}> {
  addPendingCleanup(sessionId)
  try {
    const deletedSummary = getConversationSummaryStore().delete(sessionId)
    const deletedHistoryVectors = deleteMemoryByMetadata("chat_history", { sessionId })
    const deletedSummaryVectors = deleteMemoryBySourceKey("conversation_summary", sessionId)
    const evidence = await memoryStore.deleteConversationEvidence(sessionId)
    deleteUserMemoryVectors(evidence.deletedRagIds)
    removePendingCleanup(sessionId)
    return {
      deletedSummary,
      deletedHistoryVectors,
      deletedSummaryVectors,
      deletedEvidenceCount: evidence.deletedEvidenceCount,
      deletedL2Count: evidence.deletedL2Ids.length,
    }
  } catch (error) {
    console.warn("[ConversationMemory] cleanup pending for retry:", sessionId, error)
    throw error
  }
}

export async function retryPendingConversationMemoryCleanups(): Promise<number> {
  const pending = readPendingCleanups()
  let completed = 0
  for (const sessionId of pending) {
    try {
      await deleteConversationMemoryArtifacts(sessionId)
      completed++
    } catch {
      // 保留 pending，下一次启动继续。
    }
  }
  return completed
}

function pendingCleanupPath(): string {
  return path.join(chatsStore.getRootDir(), "memory-cleanup-pending.json")
}

function readPendingCleanups(): string[] {
  try {
    const filePath = pendingCleanupPath()
    if (!fs.existsSync(filePath)) return []
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function writePendingCleanups(values: string[]): void {
  const filePath = pendingCleanupPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify([...new Set(values)], null, 2), "utf8")
  fs.renameSync(tmp, filePath)
}

function addPendingCleanup(sessionId: string): void {
  writePendingCleanups([...readPendingCleanups(), sessionId])
}

function removePendingCleanup(sessionId: string): void {
  writePendingCleanups(readPendingCleanups().filter((item) => item !== sessionId))
}

/** 测试和 userData 切换后重建惰性单例。 */
export function resetConversationMemoryRuntime(): void {
  service = null
  store = null
}
