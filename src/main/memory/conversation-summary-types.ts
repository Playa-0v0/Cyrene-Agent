import type { ConversationMode } from "../../shared/chat-types"

export type ConversationSummaryIndexStatus = "pending" | "synced" | "failed"

export interface ConversationSummaryDraft {
  overview: string
  topics: string[]
  decisions: string[]
  openLoops: string[]
  currentState: string[]
  nextSteps: string[]
  entities: string[]
  keywords: string[]
}

export interface ConversationMemorySummary extends ConversationSummaryDraft {
  schemaVersion: 2
  sessionId: string
  mode: ConversationMode
  revision: number
  coveredMessageCount: number
  coveredUntilMessageId?: string
  sourceMessageIds: string[]
  generatedAt: number
  updatedAt: number
  ragId?: string
  indexStatus: ConversationSummaryIndexStatus
}

export interface ConversationSummaryMessage {
  id: string
  role: "user" | "assistant"
  text: string
  at: number
}
