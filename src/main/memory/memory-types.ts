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
  preferredName:     '用户希望被如何称呼、叫什么名字、昵称。例如："叫我P宝""我叫Playa""以后喊我宝宝"',
  occupation:        '用户的职业、身份、工作。例如："我是前端工程师""我在做设计"',
  longTermInterests: '用户的长期兴趣爱好（稳定的，不是临时的）。例如："我一直喜欢画画""我从小学钢琴"',
  language:          '用户常用的语言或地区习惯。例如："我习惯说中文""我是广东人"',
  permanentNote:     '其他不属于以上四类的稳定个人信息。例如："我有一只猫""我住在上海"',
  // isPinned 和 updatedAt 不在这里，代表不暴露给 AI
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
  /**
   * LLM 生成的精炼标题，用作 Obsidian 文件名与 wikilink 锚点。
   * 缺失时回退到 id（l2_<ts>_<rand>）。
   * id 仍为 PMRS 内部主键，写入 frontmatter，与文件名解耦。
   */
  slug?: string
  /**
   * L2 原文对话片段（Memory Judge 精挑的最有信息量的原话）。
   * L2 被向量召回时附带注入，让 LLM 看到「用户当时说的原话」而非仅浓缩结论。
   * 仅展示用途；evidence.quoteSnippet 仍由 triggerText 自动填充，服务审计/冲突检测。
   */
  sourceQuote?: string
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
  /** 是否为压缩总结条目（由 Reflection 生成） */
  isSummary?: boolean
  /** 被本条压缩的原始条目 id 列表 */
  subEntryIds?: string[]
  /** 冲突标记：与该记忆语义相矛盾的其他条目 ragId 列表 */
  conflictWith?: string[]
  evidenceIds?: string[]
  sourceMessageIds?: string[]
  supersededBy?: string
  mergedInto?: string
  /**
   * V5 DMAE：用于 H_u/H_m 检测的关键词集合。
   * 由 content 分词 + evidence 实体在写入时提取；缺失时 memory-store 会自动补充。
   */
  keywords?: string[]
}

export type L2MemoryStatus = "active" | "aging" | "archived" | "superseded" | "merged"

export function isL2LocallyRecallable(memory: L2Memory): boolean {
  return (
    (memory.status === "active" || memory.status === "aging") &&
    memory.syncStatus === "synced" &&
    typeof memory.ragId === "string" &&
    memory.ragId.length > 0
  )
}

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
  /**
   * L2 候选的精炼标题（≤20 字，仅中文/字母/数字/下划线/连字符）。
   * 仅 L2 候选会消费此字段；缺失时回退到内部 id 作为文件名。
   */
  slug?: string
  /**
   * L2 原文对话片段：挑最有信息量的对话原话（≤500 字）。
   * 仅 L2 候选会消费此字段；L0/L1 的 sourceQuote 一律丢弃。
   */
  sourceQuote?: string
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
  /** 来源会话 ID，由调度层注入（非 LLM 输出），用于 L2 回溯 */
  sourceConversationId?: string
}

export interface MemoryJudgeTurn {
  userInput: string
  assistantReply: string
}

/**
 * L2 热层 DMAE 运行时状态（V5）。
 * 随 memory.json 持久化；archived 条目在 Phase 1 跳过更新。
 */
export interface L2DmaeState {
  l2Id: string
  activation: number
  intrinsicValue: number
  userSilence: number
  modelSilence: number
  recentUserHits: number[]
  state: "active" | "dormant" | "archived"
}

export interface MemoryStore {
  schemaVersion: number
  l0: L0Profile
  l1: L1Profile
  l2: L2Memory[]
  evidence?: MemoryEvidence[]
  reflectionLogs?: ReflectionLog[]
  conflictLogs?: ConflictLog[]
  /** L2 热层 DMAE 运行时状态（V5） */
  l2DmaeStates?: L2DmaeState[]
  /** @deprecated Use schemaVersion for memory.json migrations. */
  version: number
}
