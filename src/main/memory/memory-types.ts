export interface L0Profile {
  nickname: string
  preferredName: string
  occupation: string
  longTermInterests: string
  language: string
  permanentNote: string
  isPinned: boolean
  updatedAt: number
}
export const L0_FIELD_DESCRIPTIONS: Partial<Record<keyof L0Profile, string>> = {
  preferredName:     '用戶希望被如何稱呼、叫什麼名字、暱稱。例如："叫我P寶""我叫Playa""以後喊我寶寶"',
  occupation:        '用戶的職業、身份、工作。例如："我是前端工程師""我在做設計"',
  longTermInterests: '用戶的長期興趣愛好（穩定的，不是臨時的）。例如："我一直喜歡畫畫""我從小學鋼琴"',
  language:          '用戶常用的語言或地區習慣。例如："我習慣說中文""我是廣東人"',
  permanentNote:     '其他不屬於以上四類的穩定個人信息。例如："我有一隻貓""我住在上海"',
  // isPinned 和 updatedAt 不在這裡，代表不暴露給 AI
}


export interface L1Profile {
  recentGoals: string
  recentPreferences: string
  currentProject: string
  generatedAt: number
  roundCount: number
}

export type L2SyncStatus = "pending_sync" | "synced" | "sync_failed"

export interface L2Memory {
  id: string
  content: string
  triggerText: string
  sourceConversationId: string
  createdAt: number
  lastAccessedAt: number
  accessCount: number
  weight: number
  isPinned: boolean
  status: L2MemoryStatus
  syncStatus?: L2SyncStatus
  embedding?: number[]
  ragId?: string
  /** 是否為壓縮總結條目（由 Reflection 生成） */
  isSummary?: boolean
  /** 被本條壓縮的原始條目 id 列表 */
  subEntryIds?: string[]
  /** 衝突標記：與該記憶語義相矛盾的其他條目 ragId 列表 */
  conflictWith?: string[]
  evidenceIds?: string[]
  sourceMessageIds?: string[]
  supersededBy?: string
  mergedInto?: string
}

export type L2MemoryStatus = "active" | "aging" | "archived" | "superseded" | "merged"

export interface ReflectionLog {
  id: string
  createdAt: number
  type: "compression" | "l0_update" | "l1_update"
  summary: string
  details?: string
}

export interface ConflictLog {
  id: string
  createdAt: number
  status: "candidate" | "pending" | "confirmed" | "dismissed" | "resolved" | "clarification_needed"
  sourceL2Id: string
  targetL2Id: string
  sourceRagId?: string
  targetRagId?: string
  reason: string
  confidence: number
  detector: "local" | "llm" | "manual"
  conflictScore?: number
  resolverPriority?: ConflictResolverPriority
  scoringSignals?: ConflictScoringSignals
  resolverStatus?: ConflictResolverStatus
  resolverQueuedAt?: number
  resolverAttemptCount?: number
  resolverStartedAt?: number
  resolverFinishedAt?: number
  resolutionType?: MemoryConflictResolutionType
  resolutionMemoryId?: string
  resolutionReason?: string
  resolutionConfidence?: number
  shouldAskUser?: boolean
  clarificationNeeded?: boolean
}

export type ConflictResolverPriority = "none" | "idle" | "normal" | "high"
export type ConflictResolverStatus = "not_queued" | "queued" | "processing" | "resolved" | "failed"
export type MemoryConflictResolutionType = "unrelated" | "context_difference" | "preference_evolution" | "direct_conflict" | "uncertain"

export interface MemoryConflictResolution {
  resolutionType: MemoryConflictResolutionType
  resolvedSummary?: string
  currentSummary?: string
  historicalSummary?: string
  reason: string
  confidence: number
  actions: {
    createResolvedMemory: boolean
    oldMemoryStatus?: L2MemoryStatus
    newMemoryStatus?: L2MemoryStatus
    shouldUpdateCoreMemory?: boolean
    shouldAskUser?: boolean
    clarificationNeeded?: boolean
  }
}

export interface ConflictScoringSignals {
  correctionIntent?: boolean
  ragCandidate?: boolean
  recentInjection?: boolean
  evidenceAvailable?: boolean
  localContradiction?: boolean
  impactScope?: "low" | "medium" | "high"
  penalties?: string[]
}

export interface MemoryEvidence {
  id: string
  memoryId: string
  quoteSnippet: string
  contextBeforeSnippet?: string
  contextAfterSnippet?: string
  conversationId?: string
  messageIds?: string[]
  createdAt: number
  sourceStatus: "active" | "archived" | "deleted"
}

export interface MemoryCandidate {
  layer: "L0" | "L1" | "L2"
  field?: string
  summary?: string
  content: string
  confidence: number
  triggerText: string
  importance?: "low" | "medium" | "high"
  stability?: "one_off" | "situational" | "stable"
  certainty?: "explicit" | "inferred" | "uncertain"
  attribution?: "user_explicit" | "assistant_inferred" | "mixed"
  evidenceQuotes?: string[]
  contextSummary?: string
  shouldWrite?: boolean
  reason?: string
  forbiddenOverclaims?: string[]
}

export interface MemoryJudgeTurn {
  userInput: string
  assistantReply: string
}

export interface MemoryStore {
  schemaVersion: number
  l0: L0Profile
  l1: L1Profile
  l2: L2Memory[]
  evidence?: MemoryEvidence[]
  reflectionLogs?: ReflectionLog[]
  conflictLogs?: ConflictLog[]
  /** @deprecated Use schemaVersion for memory.json migrations. */
  version: number
}
