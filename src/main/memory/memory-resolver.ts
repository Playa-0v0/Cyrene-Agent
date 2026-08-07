import { getAdapterForConfig } from "../orchestrator/vendors"
import type { ChatMessage, VendorConfig } from "../orchestrator/vendors"
import { recordUsage } from "../token-usage-store"
import { addMemory } from "../rag/index"
import { appendMemoryTrace } from "./memory-trace"
import { memoryStore } from "./memory-store"
import type { ConflictLog, L2Memory, MemoryEvidence } from "./memory-types"
import * as fs from "fs"
import * as path from "path"
import { app } from "electron"
import { revealSecrets } from "../security/secret-vault"

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

export interface ResolverModelSettings {
  provider: string
  baseUrl: string
  model: string
  apiKey: string
  explicitTransport?: "openai" | "anthropic" | "auto"
}

export interface ResolverDeps {
  callLLM: (messages: Array<{ role: "system" | "user"; content: string }>, maxTokens: number) => Promise<string>
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

const DEFAULT_MODEL_SETTINGS: ResolverModelSettings = {
  provider: "DeepSeek（深度求索）",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: "",
}

const DEFAULT_RESOLVER_MIN_INTERVAL_MS = 60_000
let lastResolverRunAt: number | null = null

function loadResolverModelSettings(): ResolverModelSettings {
  try {
    const filePath = path.join(app.getPath("userData"), "model-settings.json")
    if (!fs.existsSync(filePath)) return DEFAULT_MODEL_SETTINGS
    const raw = fs.readFileSync(filePath, "utf8")
    const parsed = revealSecrets(JSON.parse(raw)) as any
    const provider = typeof parsed.provider === "string" && parsed.provider.trim() ? parsed.provider.trim() : DEFAULT_MODEL_SETTINGS.provider
    const perProfile = parsed.perProvider && typeof parsed.perProvider === "object" ? parsed.perProvider[provider] : null

    const baseUrl = (perProfile?.baseUrl || parsed.baseUrl || DEFAULT_MODEL_SETTINGS.baseUrl).trim()
    const model = (perProfile?.model || parsed.model || DEFAULT_MODEL_SETTINGS.model).trim()
    const apiKey = (perProfile?.apiKey || parsed.apiKey || "").trim()
    const rawTransport = perProfile?.explicitTransport || parsed.explicitTransport
    const explicitTransport = rawTransport === "openai" || rawTransport === "anthropic" || rawTransport === "auto" ? rawTransport : undefined

    return {
      provider,
      baseUrl,
      model,
      apiKey,
      explicitTransport,
    }
  } catch {
    return DEFAULT_MODEL_SETTINGS
  }
}

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim()
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = stripThinkBlocks(raw)
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/gi, "")
    .trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function normalizeResolution(input: Record<string, unknown>): MemoryConflictResolution | null {
  const resolutionType = input.resolutionType
  const reason = input.reason
  const confidence = input.confidence
  const actions = input.actions
  if (
    resolutionType !== "unrelated" &&
    resolutionType !== "context_difference" &&
    resolutionType !== "preference_evolution" &&
    resolutionType !== "direct_conflict" &&
    resolutionType !== "uncertain"
  ) return null
  if (typeof reason !== "string" || !reason.trim()) return null
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null
  if (!actions || typeof actions !== "object") return null
  const actionRecord = actions as Record<string, unknown>
  return {
    resolutionType,
    resolvedSummary: typeof input.resolvedSummary === "string" ? input.resolvedSummary.trim() : undefined,
    currentSummary: typeof input.currentSummary === "string" ? input.currentSummary.trim() : undefined,
    historicalSummary: typeof input.historicalSummary === "string" ? input.historicalSummary.trim() : undefined,
    reason: reason.trim(),
    confidence,
    actions: {
      createResolvedMemory: actionRecord.createResolvedMemory === true,
      oldMemoryStatus: normalizeMemoryStatus(actionRecord.oldMemoryStatus),
      newMemoryStatus: normalizeMemoryStatus(actionRecord.newMemoryStatus),
      shouldUpdateCoreMemory: actionRecord.shouldUpdateCoreMemory === true,
      shouldAskUser: actionRecord.shouldAskUser === true,
      clarificationNeeded: actionRecord.clarificationNeeded === true,
    },
  }
}

function normalizeMemoryStatus(value: unknown): MemoryConflictResolution["actions"]["oldMemoryStatus"] {
  if (value === "active" || value === "aging" || value === "archived" || value === "superseded" || value === "merged") {
    return value
  }
  return undefined
}

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

export function buildResolverMessages(payload: ResolverPayload): Array<{ role: "system" | "user"; content: string }> {
  const evidenceLines = (items: MemoryEvidence[]) => items.map((item) => (
    `- quote: ${item.quoteSnippet}\n  conversationId: ${item.conversationId ?? "unknown"}\n  sourceStatus: ${item.sourceStatus}`
  )).join("\n")
  const userPrompt = [
    "請判斷以下兩條用戶記憶的關係，並只輸出 JSON。",
    "",
    "舊記憶：",
    `summary: ${payload.oldMemory.content}`,
    "evidence:",
    evidenceLines(payload.oldEvidence) || "- none",
    "",
    "新記憶：",
    `summary: ${payload.newMemory.content}`,
    "evidence:",
    evidenceLines(payload.newEvidence) || "- none",
    "",
    `conflictScore: ${payload.conflictScore}`,
    `scoringSignals: ${JSON.stringify(payload.scoringSignals ?? {})}`,
    "",
    "JSON 格式：",
    '{"resolutionType":"unrelated|context_difference|preference_evolution|direct_conflict|uncertain","resolvedSummary":"可選","currentSummary":"可選","historicalSummary":"可選","reason":"原因","confidence":0.0,"actions":{"createResolvedMemory":false,"oldMemoryStatus":"active|aging|archived|superseded|merged","newMemoryStatus":"active|aging|archived|superseded|merged","shouldUpdateCoreMemory":false,"shouldAskUser":false,"clarificationNeeded":false}}',
  ].join("\n")

  return [
    { role: "system", content: "你是謹慎的用戶記憶衝突 Resolver。你只根據 summary 和 evidence 判斷，不要編造事實，只輸出 JSON。" },
    { role: "user", content: userPrompt },
  ]
}

export async function callResolverLLM(
  settings: ResolverModelSettings,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens = 700,
): Promise<string> {
  if (!settings.apiKey) throw new Error("missing api key")
  const cfg: VendorConfig = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
  }
  const adapter = getAdapterForConfig(cfg)
  const http = adapter.buildRequest({
    model: cfg.model,
    messages: messages as ChatMessage[],
    maxTokens,
    stream: false,
  }, cfg)
  const response = await fetch(http.url, {
    method: "POST",
    headers: http.headers,
    body: http.body,
  })
  if (!response.ok) throw new Error(`resolver request failed: HTTP ${response.status}`)
  const data = await response.json()
  const parsed = adapter.parseResponse(data)
  if (parsed.usage) recordUsage(parsed.usage.input, parsed.usage.output, 1, settings.model)
  return parsed.text ?? ""
}

export async function resolvePayload(
  payload: ResolverPayload,
  deps: ResolverDeps,
): Promise<MemoryConflictResolution> {
  const raw = await deps.callLLM(buildResolverMessages(payload), 700)
  const parsed = extractJsonObject(raw)
  const resolution = parsed ? normalizeResolution(parsed) : null
  if (!resolution) throw new Error("invalid resolver json")
  return resolution
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
    const ragId = await addMemory(resolvedMemory.content, "user_memory", {
      l2Id: resolvedMemory.id,
      source: "memory_resolver",
      conflictLogId: log.id,
      resolutionType: log.resolutionType,
      sourceL2Id: log.sourceL2Id,
      targetL2Id: log.targetL2Id,
    })
    await memoryStore.markL2SyncStatus(resolvedMemory.id, "synced", ragId)
  } catch (err) {
    await memoryStore.markL2SyncStatus(resolvedMemory.id, "sync_failed", undefined, err)
  }
}

export async function runResolverQueueOnce(deps?: ResolverDeps, options: ResolverRunOptions = {}): Promise<ResolverRunResult> {
  const [next] = await memoryStore.getResolverQueue(1)
  if (!next) return { status: "skip" }

  const now = options.now ?? Date.now()
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_RESOLVER_MIN_INTERVAL_MS
  if (lastResolverRunAt !== null && now - lastResolverRunAt < minIntervalMs) {
    appendMemoryTrace({
      op: "resolver.run.rate_limited",
      layer: "L2",
      status: "skip",
      l2Id: next.sourceL2Id,
      ragId: next.sourceRagId,
      details: {
        conflictLogId: next.id,
        elapsedMs: now - lastResolverRunAt,
        minIntervalMs,
      },
    })
    return { status: "rate_limited", conflictLogId: next.id }
  }
  lastResolverRunAt = now

  try {
    appendMemoryTrace({
      op: "resolver.run.start",
      layer: "L2",
      status: "ok",
      l2Id: next.sourceL2Id,
      ragId: next.sourceRagId,
      details: {
        conflictLogId: next.id,
        resolverPriority: next.resolverPriority,
        conflictScore: next.conflictScore,
        resolverAttemptCount: next.resolverAttemptCount ?? 0,
      },
    })
    await markResolverProcessing(next.id)
    const payload = await buildResolverPayload(next.id)
    const runner = deps ?? {
      callLLM: (messages: Array<{ role: "system" | "user"; content: string }>, maxTokens: number) => (
        callResolverLLM(loadResolverModelSettings(), messages, maxTokens)
      ),
    }
    const resolution = await resolvePayload(payload, runner)
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
