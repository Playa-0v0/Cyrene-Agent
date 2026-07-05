import { getAdapterForConfig } from "../orchestrator/vendors"
import type { ChatMessage, VendorConfig } from "../orchestrator/vendors"
import { recordUsage } from "../token-usage-store"
import { appendMemoryTrace } from "./memory-trace"
import { memoryStore } from "./memory-store"
import type { ConflictLog, L2Memory, MemoryEvidence } from "./memory-types"
import * as fs from "fs"
import * as path from "path"
import { app } from "electron"

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
  status: "skip" | "resolved" | "failed"
  conflictLogId?: string
  error?: string
}

const DEFAULT_MODEL_SETTINGS: ResolverModelSettings = {
  provider: "DeepSeek（深度求索）",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: "",
}

function loadResolverModelSettings(): ResolverModelSettings {
  try {
    const filePath = path.join(app.getPath("userData"), "model-settings.json")
    if (!fs.existsSync(filePath)) return DEFAULT_MODEL_SETTINGS
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ResolverModelSettings>
    return {
      provider: typeof parsed.provider === "string" && parsed.provider.trim() ? parsed.provider.trim() : DEFAULT_MODEL_SETTINGS.provider,
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_MODEL_SETTINGS.baseUrl,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_MODEL_SETTINGS.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      explicitTransport: parsed.explicitTransport === "openai" || parsed.explicitTransport === "anthropic" || parsed.explicitTransport === "auto" ? parsed.explicitTransport : undefined,
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

  return [
    { role: "system", content: "你是谨慎的用户记忆冲突 Resolver。你只根据 summary 和 evidence 判断，不要编造事实，只输出 JSON。" },
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
  if (parsed.usage) recordUsage(parsed.usage.input, parsed.usage.output, 1)
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

export async function runResolverQueueOnce(deps?: ResolverDeps): Promise<ResolverRunResult> {
  const [next] = await memoryStore.getResolverQueue(1)
  if (!next) return { status: "skip" }

  try {
    await markResolverProcessing(next.id)
    const payload = await buildResolverPayload(next.id)
    const runner = deps ?? {
      callLLM: (messages: Array<{ role: "system" | "user"; content: string }>, maxTokens: number) => (
        callResolverLLM(loadResolverModelSettings(), messages, maxTokens)
      ),
    }
    const resolution = await resolvePayload(payload, runner)
    await memoryStore.applyResolverResolution(next.id, resolution)
    return { status: "resolved", conflictLogId: next.id }
  } catch (err) {
    await markResolverFailed(next.id, err)
    return {
      status: "failed",
      conflictLogId: next.id,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
