import { addL2MemoryVector } from "../rag/index"
import { appendMemoryTrace } from "./memory-trace"
import { memoryStore } from "./memory-store"
import type { ConflictLog, L2Memory, MemoryEvidence } from "./memory-types"
import { invokeMemoryStructuredOutput, getDefaultMaxOutputTokens } from "./memory-llm-client"
import { parseMemoryResolveResult, validateMemoryResolveBusiness } from "./memory-schemas"

export type MemoryConflictResolutionType =
  | "unrelated"
  | "context_difference"
  | "preference_evolution"
  | "direct_conflict"
  | "uncertain"

export interface MemoryConflictResolution {
  resolutionType: MemoryConflictResolutionType
  resolvedSummary?: string
  currentSummary?: string
  historicalSummary?: string
  reason: string
  confidence: number
  actions: {
    createResolvedMemory: boolean
    oldMemoryStatus?: "active" | "aging" | "archived" | "superseded" | "merged"
    newMemoryStatus?: "active" | "aging" | "archived" | "superseded" | "merged"
    shouldUpdateCoreMemory?: boolean
    shouldAskUser?: boolean
    clarificationNeeded?: boolean
  }
}

export interface ResolverPayload {
  conflictLog: ConflictLog
  newMemory: L2Memory
  oldMemory: L2Memory
  newEvidence: MemoryEvidence[]
  oldEvidence: MemoryEvidence[]
  conflictScore: number
  scoringSignals: ConflictLog["scoringSignals"]
}

export interface ResolverRunResult {
  status: "skip" | "resolved" | "failed" | "rate_limited"
  conflictLogId?: string
  error?: string
}

export interface ResolverRunOptions {
  now?: number
  minIntervalMs?: number
}

const DEFAULT_RESOLVER_MIN_INTERVAL_MS = 60_000
let lastResolverRunAt: number | null = null

export async function buildResolverPayload(conflictLogId: string): Promise<ResolverPayload> {
  const store = await memoryStore.load()
  const conflictLog = (store.conflictLogs ?? []).find((log) => log.id === conflictLogId)
  if (!conflictLog) throw new Error(`conflict log not found: ${conflictLogId}`)

  const newMemory = store.l2.find((memory) => memory.id === conflictLog.sourceL2Id)
  const oldMemory = store.l2.find((memory) => memory.id === conflictLog.targetL2Id)
  if (!newMemory) throw new Error(`source memory not found: ${conflictLog.sourceL2Id}`)
  if (!oldMemory) throw new Error(`target memory not found: ${conflictLog.targetL2Id}`)

  return {
    conflictLog,
    newMemory,
    oldMemory,
    newEvidence: await memoryStore.getEvidenceByMemoryId(newMemory.id),
    oldEvidence: await memoryStore.getEvidenceByMemoryId(oldMemory.id),
    conflictScore: conflictLog.conflictScore ?? 0,
    scoringSignals: conflictLog.scoringSignals,
  }
}

export function buildResolverMessages(payload: ResolverPayload): { systemPrompt: string; userPrompt: string } {
  const evidenceLines = (items: MemoryEvidence[]) => items.map((item) => (
    `- quote: ${item.quoteSnippet}\n  conversationId: ${item.conversationId ?? "unknown"}\n  sourceStatus: ${item.sourceStatus}`
  )).join("\n")
  const userPrompt = [
    "请判断以下两条用户记忆的关系，并只输出 JSON。",
    "",
    "旧记忆：",
    `summary: ${payload.oldMemory.content}`,
    "evidence:",
    evidenceLines(payload.oldEvidence) || "- none",
    "",
    "新记忆：",
    `summary: ${payload.newMemory.content}`,
    "evidence:",
    evidenceLines(payload.newEvidence) || "- none",
    "",
    `conflictScore: ${payload.conflictScore}`,
    `scoringSignals: ${JSON.stringify(payload.scoringSignals ?? {})}`,
    "",
    "JSON 格式：",
    '{"resolutionType":"unrelated|context_difference|preference_evolution|direct_conflict|uncertain","resolvedSummary":"可选","currentSummary":"可选","historicalSummary":"可选","reason":"原因","confidence":0.0,"actions":{"createResolvedMemory":false,"oldMemoryStatus":"active|aging|archived|superseded|merged","newMemoryStatus":"active|aging|archived|superseded|merged","shouldUpdateCoreMemory":false,"shouldAskUser":false,"clarificationNeeded":false}}',
  ].join("\n")

  return {
    systemPrompt: "你是谨慎的用户记忆冲突 Resolver。你只根据 summary 和 evidence 判断，不要编造事实，只输出 JSON。",
    userPrompt,
  }
}

/**
 * 兼容旧签名：将 buildResolverMessages 的新格式转为数组格式。
 */
export function buildResolverMessagesAsArray(payload: ResolverPayload): Array<{ role: "system" | "user"; content: string }> {
  const { systemPrompt, userPrompt } = buildResolverMessages(payload)
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]
}

export async function resolvePayload(
  payload: ResolverPayload,
): Promise<MemoryConflictResolution> {
  const { systemPrompt, userPrompt } = buildResolverMessages(payload)
  return invokeMemoryStructuredOutput<MemoryConflictResolution>({
    operation: "resolve",
    systemPrompt,
    userPrompt,
    maxOutputTokens: getDefaultMaxOutputTokens("resolve"),
    parseSchema: parseMemoryResolveResult,
    validateBusiness: validateMemoryResolveBusiness,
  })
}

async function markResolverProcessing(conflictLogId: string): Promise<void> {
  const store = await memoryStore.load()
  const log = (store.conflictLogs ?? []).find((entry) => entry.id === conflictLogId)
  if (!log) return
  log.resolverStatus = "processing"
  log.resolverStartedAt = Date.now()
  log.resolverAttemptCount = (log.resolverAttemptCount ?? 0) + 1
  await memoryStore.save(store)
  appendMemoryTrace({
    op: "resolver.queue.processing",
    layer: "L2",
    status: "ok",
    l2Id: log.sourceL2Id,
    ragId: log.sourceRagId,
    details: { conflictLogId: log.id, resolverAttemptCount: log.resolverAttemptCount },
  })
}

async function markResolverFailed(conflictLogId: string, error: unknown): Promise<void> {
  const store = await memoryStore.load()
  const log = (store.conflictLogs ?? []).find((entry) => entry.id === conflictLogId)
  if (!log) return
  log.resolverStatus = "failed"
  log.resolverFinishedAt = Date.now()
  await memoryStore.save(store)
  appendMemoryTrace({
    op: "resolver.queue.failed",
    layer: "L2",
    status: "error",
    l2Id: log.sourceL2Id,
    ragId: log.sourceRagId,
    details: { conflictLogId: log.id, resolverAttemptCount: log.resolverAttemptCount ?? 0 },
    error: error instanceof Error ? error.message : String(error),
  })
}

async function syncResolvedMemoryToRag(log: ConflictLog): Promise<void> {
  if (!log.resolutionMemoryId || !log.resolutionType) return
  const store = await memoryStore.load()
  const resolvedMemory = store.l2.find((memory) => memory.id === log.resolutionMemoryId)
  if (!resolvedMemory || resolvedMemory.syncStatus === "synced") return

  try {
    const ragId = await addL2MemoryVector(resolvedMemory.content, resolvedMemory.id, {
      source: "memory_resolver",
      conflictLogId: log.id,
      resolutionType: log.resolutionType,
      sourceL2Id: log.sourceL2Id,
      targetL2Id: log.targetL2Id,
    })
    await memoryStore.markL2SyncStatus(resolvedMemory.id, "synced", ragId)
  } catch (err) {
    console.warn("[PMRS/Resolver] sync resolved memory to RAG failed:", err)
    await memoryStore.markL2SyncStatus(resolvedMemory.id, "sync_failed", undefined, err instanceof Error ? err : new Error(String(err)))
  }
}

export async function resolveNextConflict(
  options?: ResolverRunOptions,
): Promise<ResolverRunResult> {
  const now = options?.now ?? Date.now()
  const minInterval = options?.minIntervalMs ?? DEFAULT_RESOLVER_MIN_INTERVAL_MS

  if (lastResolverRunAt !== null && now - lastResolverRunAt < minInterval) {
    appendMemoryTrace({
      op: "resolver.queue.rate_limited",
      layer: "L2",
      status: "ok",
      l2Id: "",
      ragId: "",
      details: { lastRunAt: lastResolverRunAt, now, minInterval },
    })
    return { status: "rate_limited" }
  }

  const store = await memoryStore.load()
  const pending = (store.conflictLogs ?? [])
    .filter((log) => log.resolverStatus === "queued")
    .sort((a, b) => (b.conflictScore ?? 0) - (a.conflictScore ?? 0))

  const next = pending[0]
  if (!next) return { status: "skip" }

  lastResolverRunAt = now

  try {
    await markResolverProcessing(next.id)
    const payload = await buildResolverPayload(next.id)
    const resolution = await resolvePayload(payload)
    const appliedLog = await memoryStore.applyResolverResolution(next.id, resolution)
    if (appliedLog) await syncResolvedMemoryToRag(appliedLog)
    appendMemoryTrace({
      op: "resolver.run.success",
      layer: "L2",
      status: "ok",
      l2Id: next.sourceL2Id,
      ragId: next.sourceRagId,
      details: {
        conflictLogId: next.id,
        resolutionType: resolution.resolutionType,
        createdResolvedMemory: resolution.actions.createResolvedMemory === true,
      },
    })
    return { status: "resolved", conflictLogId: next.id }
  } catch (err) {
    await markResolverFailed(next.id, err)
    appendMemoryTrace({
      op: "resolver.run.failed",
      layer: "L2",
      status: "error",
      l2Id: next.sourceL2Id,
      ragId: next.sourceRagId,
      details: { conflictLogId: next.id },
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      status: "failed",
      conflictLogId: next.id,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** @deprecated Use resolveNextConflict instead. */
export const runResolverQueueOnce = resolveNextConflict;
