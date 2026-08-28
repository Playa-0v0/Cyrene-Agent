import * as fs from "fs"
import * as path from "path"
import type { ChatMessage, ChatSession, ChatSessionMeta } from "../../shared/chat-types"
import * as chatsStore from "../chats/chats-store"
import { upsertMemoryBySourceKey } from "../rag"
import { getConversationSummaryService, getConversationSummaryStore } from "./conversation-memory-runtime"

interface BackfillState {
  schemaVersion: 1
  cursor: number
  sessionCount: number
  latestUpdatedAt: number
  failures: Record<string, string>
  completedAt?: number
}

export interface ConversationMemoryBackfillDeps {
  statePath: string
  listSessions: () => ChatSessionMeta[]
  getSession: (sessionId: string) => ChatSession | null
  indexMessage: (sessionId: string, message: ChatMessage) => Promise<void>
  updateSummary: (sessionId: string) => Promise<void>
  now?: () => number
}

export class ConversationMemoryBackfill {
  constructor(private readonly deps: ConversationMemoryBackfillDeps) {}

  async runBatch(batchSize = 3): Promise<{ processed: number; done: boolean; failures: number }> {
    const sessions = this.deps.listSessions().sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    const latestUpdatedAt = sessions.reduce((latest, session) => Math.max(latest, session.updatedAt), 0)
    let state = this.loadState()
    if (state.completedAt && (state.sessionCount !== sessions.length || state.latestUpdatedAt !== latestUpdatedAt)) {
      state = freshState(sessions.length, latestUpdatedAt)
    }
    if (state.completedAt) return { processed: 0, done: true, failures: Object.keys(state.failures).length }

    const batch = sessions.slice(state.cursor, state.cursor + Math.max(1, batchSize))
    for (const meta of batch) {
      try {
        const session = this.deps.getSession(meta.id)
        if (!session) continue
        let failureCode: string | undefined
        for (const message of session.messages) {
          if ((message.role !== "user" && message.role !== "model") || !message.content.trim()) continue
          try {
            await this.deps.indexMessage(session.id, message)
          } catch (error) {
            failureCode ??= safeErrorCode(error)
          }
        }
        const effectiveCount = session.messages.filter((message) => (
          (message.role === "user" || message.role === "model") && message.content.trim()
        )).length
        if (effectiveCount >= 4) {
          try {
            await this.deps.updateSummary(session.id)
          } catch (error) {
            failureCode ??= safeErrorCode(error)
          }
        }
        if (failureCode) state.failures[session.id] = failureCode
        else delete state.failures[session.id]
      } catch (error) {
        state.failures[meta.id] = safeErrorCode(error)
      }
    }

    state.cursor += batch.length
    state.sessionCount = sessions.length
    state.latestUpdatedAt = latestUpdatedAt
    const done = state.cursor >= sessions.length
    if (done && Object.keys(state.failures).length === 0) {
      state.completedAt = this.deps.now?.() ?? Date.now()
    } else if (done) {
      // 本轮停止，避免在线忙循环；下次启动从头幂等重试失败项。
      state.cursor = 0
      state.completedAt = undefined
    }
    this.saveState(state)
    return { processed: batch.length, done, failures: Object.keys(state.failures).length }
  }

  private loadState(): BackfillState {
    try {
      if (!fs.existsSync(this.deps.statePath)) return freshState(0, 0)
      const value = JSON.parse(fs.readFileSync(this.deps.statePath, "utf8")) as BackfillState
      if (value?.schemaVersion === 1 && Number.isInteger(value.cursor)) return value
    } catch (error) {
      console.warn("[ConversationMemoryBackfill] state load failed, restarting idempotently:", error)
    }
    return freshState(0, 0)
  }

  private saveState(state: BackfillState): void {
    fs.mkdirSync(path.dirname(this.deps.statePath), { recursive: true })
    const tmp = `${this.deps.statePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8")
    fs.renameSync(tmp, this.deps.statePath)
  }
}

function freshState(sessionCount: number, latestUpdatedAt: number): BackfillState {
  return { schemaVersion: 1, cursor: 0, sessionCount, latestUpdatedAt, failures: {} }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /RAG not initialized/i.test(error.message)) return "RAG_UNAVAILABLE"
  return error instanceof Error ? error.name || "ERROR" : "ERROR"
}

let running = false

export function startConversationMemoryBackfill(): void {
  if (running) return
  running = true
  const backfill = new ConversationMemoryBackfill({
    statePath: path.join(chatsStore.getRootDir(), "summaries", "backfill-state.json"),
    listSessions: chatsStore.listSessions,
    getSession: chatsStore.getSession,
    indexMessage: async (sessionId, message) => {
      const role = message.role === "user" ? "user" : "assistant"
      await upsertMemoryBySourceKey(message.content, "chat_history", `${sessionId}:${message.id}`, {
        sessionId,
        messageId: message.id,
        role,
        ts: message.at,
      })
    },
    updateSummary: async (sessionId) => {
      const session = chatsStore.getSession(sessionId)
      const existing = getConversationSummaryStore().get(sessionId)
      if (!session) return
      const effectiveCount = session.messages.filter((message) => (
        (message.role === "user" || message.role === "model") && message.content.trim()
      )).length
      if (existing?.coveredMessageCount === effectiveCount) return
      await getConversationSummaryService().schedule(sessionId, { force: true })
      const updated = getConversationSummaryStore().get(sessionId)
      if (!updated || updated.coveredMessageCount < effectiveCount) {
        throw new Error("conversation summary remains pending")
      }
    },
  })

  const runNext = async () => {
    try {
      const result = await backfill.runBatch(3)
      if (!result.done) {
        setTimeout(() => void runNext(), 250)
        return
      }
      console.log(`[ConversationMemoryBackfill] complete, failures=${result.failures}`)
    } catch (error) {
      console.warn("[ConversationMemoryBackfill] batch failed; retrying later:", error)
      setTimeout(() => void runNext(), 5_000)
      return
    }
    running = false
  }
  void runNext()
}
