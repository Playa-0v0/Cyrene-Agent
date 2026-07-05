import * as fs from "fs"
import * as path from "path"
import { app } from "electron"
import { ConflictLog, L0Profile, L1Profile, L2Memory, L2SyncStatus, MemoryConflictResolution, MemoryEvidence, MemoryStore, ReflectionLog } from "./memory-types"
import { appendMemoryTrace } from "./memory-trace"

const CURRENT_SCHEMA_VERSION = 2
const QUOTE_SNIPPET_MAX = 300
const RESOLVER_PRIORITY_RANK: Record<string, number> = {
  high: 3,
  normal: 2,
  idle: 1,
  none: 0,
}

const DEFAULT_L0: L0Profile = {
  nickname: "",
  preferredName: "",
  occupation: "",
  longTermInterests: "",
  language: "zh-CN",
  permanentNote: "",
  isPinned: false,
  updatedAt: 0,
}

const DEFAULT_L1: L1Profile = {
  recentGoals: "",
  recentPreferences: "",
  currentProject: "",
  generatedAt: 0,
  roundCount: 0,
}

const DEFAULT_STORE: MemoryStore = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  l0: { ...DEFAULT_L0 },
  l1: { ...DEFAULT_L1 },
  l2: [],
  evidence: [],
  reflectionLogs: [],
  conflictLogs: [],
  version: 1,
}

export type L0WritableField = Exclude<keyof L0Profile, "updatedAt">
export type L1WritableField = keyof L1Profile
export type L2Input = Omit<L2Memory, "id" | "createdAt" | "lastAccessedAt" | "accessCount" | "weight" | "status">

function getMemoryPath(): string {
  return path.join(app.getPath("userData"), "memory.json")
}

function cloneDefaultStore(): MemoryStore {
  return {
    ...DEFAULT_STORE,
    l0: { ...DEFAULT_L0 },
    l1: { ...DEFAULT_L1 },
    l2: [],
    evidence: [],
    reflectionLogs: [],
    conflictLogs: [],
  }
}

function snippet(text: string | undefined, maxLength: number): string | undefined {
  if (!text) return undefined
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

function backupMemoryFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return
  const dir = path.dirname(filePath)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = path.join(dir, `memory.backup.${timestamp}.json`)
  fs.copyFileSync(filePath, backupPath)
}

export function repairMigrations(store: Partial<MemoryStore>): MemoryStore {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    l0: { ...DEFAULT_L0, ...store.l0 },
    l1: { ...DEFAULT_L1, ...store.l1 },
    l2: Array.isArray(store.l2) ? store.l2.map((memory) => ({
      ...memory,
      syncStatus: memory.syncStatus ?? (memory.ragId ? "synced" : "pending_sync"),
      evidenceIds: Array.isArray(memory.evidenceIds) ? memory.evidenceIds : [],
    })) : [],
    evidence: Array.isArray(store.evidence) ? store.evidence : [],
    reflectionLogs: Array.isArray(store.reflectionLogs) ? store.reflectionLogs : [],
    conflictLogs: Array.isArray(store.conflictLogs) ? store.conflictLogs.map((log) => ({
      ...log,
      resolverStatus: log.resolverStatus ?? (log.resolverPriority && log.resolverPriority !== "none" ? "queued" : "not_queued"),
      resolverAttemptCount: typeof log.resolverAttemptCount === "number" ? log.resolverAttemptCount : 0,
    })) : [],
    version: typeof store.version === "number" ? store.version : 1,
  }
}

class MemoryStoreManager {
  private cache: MemoryStore | null = null

  async load(): Promise<MemoryStore> {
    if (this.cache) return this.cache
    const filePath = getMemoryPath()
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8")
        const parsed = JSON.parse(raw) as Partial<MemoryStore>
        const needsMigration = parsed.schemaVersion !== CURRENT_SCHEMA_VERSION
        this.cache = repairMigrations(parsed)
        if (needsMigration) {
          backupMemoryFile(filePath)
          await this.save(this.cache)
          appendMemoryTrace({
            op: "migration.upgrade",
            layer: "migration",
            status: "ok",
            details: { schemaVersion: CURRENT_SCHEMA_VERSION },
          })
        }
      } else {
        this.cache = cloneDefaultStore()
        await this.save(this.cache)
        appendMemoryTrace({
          op: "store.init",
          layer: "store",
          status: "ok",
          details: { schemaVersion: CURRENT_SCHEMA_VERSION },
        })
      }
    } catch (err) {
      try {
        backupMemoryFile(filePath)
      } catch {
        // 如果连备份也失败，仍然生成干净默认文件，避免主流程被记忆文件阻塞。
      }
      this.cache = cloneDefaultStore()
      await this.save(this.cache)
      appendMemoryTrace({
        op: "migration.recoverDefault",
        layer: "migration",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return this.cache
  }

  async save(store: MemoryStore): Promise<void> {
    const filePath = getMemoryPath()
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf8")
    this.cache = store
  }

  async getL0(): Promise<L0Profile> {
    const store = await this.load()
    return store.l0
  }

  async upsertL0Field(field: L0WritableField, value: L0Profile[L0WritableField]): Promise<void> {
    const store = await this.load()
    store.l0 = { ...store.l0, [field]: value, updatedAt: Date.now() }
    await this.save(store)
    appendMemoryTrace({
      op: "l0.update",
      layer: "L0",
      status: "ok",
      details: { fields: [field] },
    })
  }

  async updateL0(patch: Partial<L0Profile>): Promise<void> {
    for (const [field, value] of Object.entries(patch) as Array<[keyof L0Profile, L0Profile[keyof L0Profile]]>) {
      if (field === "updatedAt") continue
      await this.upsertL0Field(field, value as L0Profile[L0WritableField])
    }
  }

  async getL1(): Promise<L1Profile> {
    const store = await this.load()
    return store.l1
  }

  async replaceL1Field(field: L1WritableField, value: L1Profile[L1WritableField]): Promise<void> {
    const store = await this.load()
    store.l1 = { ...store.l1, [field]: value }
    await this.save(store)
    appendMemoryTrace({
      op: "l1.update",
      layer: "L1",
      status: "ok",
      details: { fields: [field] },
    })
  }

  async updateL1(patch: Partial<L1Profile>): Promise<void> {
    for (const [field, value] of Object.entries(patch) as Array<[L1WritableField, L1Profile[L1WritableField]]>) {
      await this.replaceL1Field(field, value)
    }
  }

  async addL2Memory(input: L2Input): Promise<L2Memory> {
    const store = await this.load()
    const memory: L2Memory = {
      ...input,
      id: `l2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      weight: 0,
      status: "active",
      syncStatus: input.syncStatus ?? (input.ragId ? "synced" : "pending_sync"),
      evidenceIds: Array.isArray(input.evidenceIds) ? input.evidenceIds : [],
    }
    const evidence = this.createEvidence(memory, input)
    memory.evidenceIds = [...(memory.evidenceIds ?? []), evidence.id]
    store.l2.push(memory)
    if (!store.evidence) store.evidence = []
    store.evidence.push(evidence)
    await this.save(store)
    appendMemoryTrace({
      op: "l2.add",
      layer: "L2",
      status: "ok",
      l2Id: memory.id,
      ragId: memory.ragId,
      details: { isSummary: memory.isSummary === true, syncStatus: memory.syncStatus },
    })
    appendMemoryTrace({
      op: "evidence.add",
      layer: "L2",
      status: "ok",
      l2Id: memory.id,
      details: { evidenceId: evidence.id, sourceStatus: evidence.sourceStatus },
    })
    return memory
  }

  private createEvidence(memory: L2Memory, input: L2Input): MemoryEvidence {
    return {
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      memoryId: memory.id,
      quoteSnippet: snippet(input.triggerText || input.content, QUOTE_SNIPPET_MAX) ?? "",
      conversationId: input.sourceConversationId || undefined,
      messageIds: input.sourceMessageIds,
      createdAt: Date.now(),
      sourceStatus: "active",
    }
  }

  async addL2(input: L2Input): Promise<L2Memory> {
    return this.addL2Memory(input)
  }

  async updateL2RecallStats(id: string, delta = 1): Promise<void> {
    const store = await this.load()
    const mem = store.l2.find((m) => m.id === id)
    if (!mem) return
    mem.weight = Math.max(0, Math.min(100, mem.weight + delta))
    mem.lastAccessedAt = Date.now()
    mem.accessCount += 1
    if (mem.isPinned) {
      mem.status = "active"
    } else if (mem.weight > 60) {
      mem.status = "active"
    } else if (mem.weight >= 30) {
      mem.status = "active"
    } else if (mem.weight >= 10) {
      mem.status = "aging"
    } else {
      mem.status = "archived"
    }
    await this.save(store)
    appendMemoryTrace({
      op: "l2.weight.update",
      layer: "L2",
      status: "ok",
      l2Id: mem.id,
      ragId: mem.ragId,
      details: { delta, weight: mem.weight, accessCount: mem.accessCount, memoryStatus: mem.status },
    })
  }

  async pinL2(id: string, pinned: boolean): Promise<void> {
    const store = await this.load()
    const mem = store.l2.find((m) => m.id === id)
    if (!mem) return
    mem.isPinned = pinned
    if (pinned) {
      mem.status = "active"
    } else if (mem.weight > 60) {
      mem.status = "active"
    } else if (mem.weight >= 30) {
      mem.status = "active"
    } else if (mem.weight >= 10) {
      mem.status = "aging"
    } else {
      mem.status = "archived"
    }
    await this.save(store)
    appendMemoryTrace({
      op: "l2.pin",
      layer: "L2",
      status: "ok",
      l2Id: mem.id,
      ragId: mem.ragId,
      details: { pinned, memoryStatus: mem.status },
    })
  }

  async deleteL2(id: string): Promise<void> {
    const store = await this.load()
    store.l2 = store.l2.filter((m) => m.id !== id)
    await this.save(store)
    appendMemoryTrace({
      op: "l2.delete",
      layer: "L2",
      status: "ok",
      l2Id: id,
    })
  }

  async updateL2Weight(id: string, delta: number): Promise<void> {
    await this.updateL2RecallStats(id, delta)
  }

  async markL2SyncStatus(id: string, syncStatus: L2SyncStatus, ragId?: string, error?: unknown): Promise<L2Memory | null> {
    const store = await this.load()
    const mem = store.l2.find((m) => m.id === id)
    if (!mem) return null
    mem.syncStatus = syncStatus
    if (ragId) mem.ragId = ragId
    await this.save(store)
    appendMemoryTrace({
      op: syncStatus === "synced" ? "l2.sync.success" : syncStatus === "sync_failed" ? "l2.sync.failure" : "l2.sync.pending",
      layer: "L2",
      status: syncStatus === "sync_failed" ? "error" : "ok",
      l2Id: mem.id,
      ragId: mem.ragId,
      details: { syncStatus },
      error: error instanceof Error ? error.message : error ? String(error) : null,
    })
    return mem
  }

  async markL2Conflict(id: string, conflictRagId: string): Promise<L2Memory | null> {
    const store = await this.load()
    const mem = store.l2.find((m) => m.id === id)
    if (!mem) return null
    const conflicts = mem.conflictWith ?? []
    if (conflicts.includes(conflictRagId)) return null

    mem.conflictWith = [...conflicts, conflictRagId]
    if (!mem.isPinned && mem.status === "active") {
      mem.status = "aging"
    }

    await this.save(store)
    appendMemoryTrace({
      op: "l2.conflict.mark",
      layer: "L2",
      status: "ok",
      l2Id: mem.id,
      ragId: mem.ragId,
      details: { conflictRagId, memoryStatus: mem.status },
    })
    return mem
  }

  async getAllL2(): Promise<L2Memory[]> {
    const store = await this.load()
    return store.l2
  }

  async getEvidenceByMemoryId(memoryId: string): Promise<MemoryEvidence[]> {
    const store = await this.load()
    return (store.evidence ?? []).filter((evidence) => evidence.memoryId === memoryId)
  }

  async appendReflectionLog(log: Omit<ReflectionLog, "id" | "createdAt">): Promise<void> {
    const store = await this.load()
    const entry: ReflectionLog = {
      ...log,
      id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    }
    if (!store.reflectionLogs) store.reflectionLogs = []
    store.reflectionLogs.push(entry)
    // 最多保留 50 条日志，防止文件膨胀
    if (store.reflectionLogs.length > 50) {
      store.reflectionLogs = store.reflectionLogs.slice(-50)
    }
    await this.save(store)
    appendMemoryTrace({
      op: "reflection.log.add",
      layer: "reflection",
      status: "ok",
      details: { type: entry.type, id: entry.id },
    })
  }

  async addReflectionLog(log: Omit<ReflectionLog, "id" | "createdAt">): Promise<void> {
    await this.appendReflectionLog(log)
  }

  async getReflectionLogs(): Promise<ReflectionLog[]> {
    const store = await this.load()
    return store.reflectionLogs ?? []
  }

  async appendConflictLog(log: Omit<ConflictLog, "id" | "createdAt">): Promise<ConflictLog> {
    const store = await this.load()
    const entry: ConflictLog = {
      ...log,
      id: `conf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    }
    if (!store.conflictLogs) store.conflictLogs = []
    store.conflictLogs.push(entry)
    if (store.conflictLogs.length > 100) {
      store.conflictLogs = store.conflictLogs.slice(-100)
    }
    await this.save(store)
    appendMemoryTrace({
      op: "conflict.log.add",
      layer: "L2",
      status: "ok",
      l2Id: entry.sourceL2Id,
      ragId: entry.sourceRagId,
      details: {
        conflictLogId: entry.id,
        targetL2Id: entry.targetL2Id,
        detector: entry.detector,
        conflictStatus: entry.status,
      },
    })
    return entry
  }

  async getConflictLogs(): Promise<ConflictLog[]> {
    const store = await this.load()
    return store.conflictLogs ?? []
  }

  async scoreConflictLog(
    id: string,
    score: Pick<ConflictLog, "conflictScore" | "resolverPriority" | "scoringSignals">,
  ): Promise<ConflictLog | null> {
    const store = await this.load()
    const log = (store.conflictLogs ?? []).find((entry) => entry.id === id)
    if (!log) return null

    log.conflictScore = score.conflictScore
    log.resolverPriority = score.resolverPriority
    log.scoringSignals = score.scoringSignals
    const shouldQueue = log.status === "candidate" && score.resolverPriority !== "none"
    const didQueue = shouldQueue && log.resolverStatus !== "queued"
    if (shouldQueue) {
      log.resolverStatus = "queued"
      log.resolverQueuedAt = log.resolverQueuedAt ?? Date.now()
      log.resolverAttemptCount = log.resolverAttemptCount ?? 0
    } else {
      log.resolverStatus = "not_queued"
      log.resolverQueuedAt = undefined
      log.resolverAttemptCount = log.resolverAttemptCount ?? 0
    }

    await this.save(store)
    appendMemoryTrace({
      op: "conflict.score",
      layer: "L2",
      status: "ok",
      l2Id: log.sourceL2Id,
      ragId: log.sourceRagId,
      details: {
        conflictLogId: log.id,
        targetL2Id: log.targetL2Id,
        conflictScore: log.conflictScore,
        resolverPriority: log.resolverPriority,
        scoringSignals: log.scoringSignals,
      },
    })
    if (didQueue) {
      appendMemoryTrace({
        op: "resolver.queue.add",
        layer: "L2",
        status: "ok",
        l2Id: log.sourceL2Id,
        ragId: log.sourceRagId,
        details: {
          conflictLogId: log.id,
          targetL2Id: log.targetL2Id,
          resolverPriority: log.resolverPriority,
          conflictScore: log.conflictScore,
        },
      })
    }
    return log
  }

  async getResolverQueue(limit = 20): Promise<ConflictLog[]> {
    const store = await this.load()
    return (store.conflictLogs ?? [])
      .filter((log) => (
        log.status === "candidate" &&
        log.resolverStatus === "queued" &&
        log.resolverPriority !== undefined &&
        log.resolverPriority !== "none"
      ))
      .sort((a, b) => {
        const priorityDiff = RESOLVER_PRIORITY_RANK[b.resolverPriority ?? "none"] - RESOLVER_PRIORITY_RANK[a.resolverPriority ?? "none"]
        if (priorityDiff !== 0) return priorityDiff
        return (a.resolverQueuedAt ?? a.createdAt) - (b.resolverQueuedAt ?? b.createdAt)
      })
      .slice(0, limit)
  }

  async applyResolverResolution(conflictLogId: string, resolution: MemoryConflictResolution): Promise<ConflictLog | null> {
    const store = await this.load()
    const log = (store.conflictLogs ?? []).find((entry) => entry.id === conflictLogId)
    if (!log) return null
    const newMemory = store.l2.find((memory) => memory.id === log.sourceL2Id)
    const oldMemory = store.l2.find((memory) => memory.id === log.targetL2Id)
    if (!newMemory || !oldMemory) return null

    let resolutionMemoryId: string | undefined
    const shouldCreateResolved = resolution.actions.createResolvedMemory && Boolean(resolution.resolvedSummary?.trim())
    if (shouldCreateResolved) {
      const resolved: L2Memory = {
        content: resolution.resolvedSummary!.trim(),
        triggerText: resolution.reason,
        sourceConversationId: newMemory.sourceConversationId || oldMemory.sourceConversationId,
        sourceMessageIds: [
          ...(oldMemory.sourceMessageIds ?? []),
          ...(newMemory.sourceMessageIds ?? []),
        ],
        isPinned: false,
        syncStatus: "pending_sync",
        evidenceIds: [
          ...(oldMemory.evidenceIds ?? []),
          ...(newMemory.evidenceIds ?? []),
        ],
        id: `l2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
        weight: 0,
        status: "active",
      }
      store.l2.push(resolved)
      resolutionMemoryId = resolved.id
    }

    if (resolution.actions.oldMemoryStatus) {
      oldMemory.status = resolution.actions.oldMemoryStatus
      if (resolution.actions.oldMemoryStatus === "superseded" && resolutionMemoryId) {
        oldMemory.supersededBy = resolutionMemoryId
      }
      if (resolution.actions.oldMemoryStatus === "merged" && resolutionMemoryId) {
        oldMemory.mergedInto = resolutionMemoryId
      }
    }
    if (resolution.actions.newMemoryStatus) {
      newMemory.status = resolution.actions.newMemoryStatus
      if (resolution.actions.newMemoryStatus === "superseded" && resolutionMemoryId) {
        newMemory.supersededBy = resolutionMemoryId
      }
      if (resolution.actions.newMemoryStatus === "merged" && resolutionMemoryId) {
        newMemory.mergedInto = resolutionMemoryId
      }
    }

    log.resolverStatus = "resolved"
    log.resolverFinishedAt = Date.now()
    log.resolutionType = resolution.resolutionType
    log.resolutionMemoryId = resolutionMemoryId
    log.resolutionReason = resolution.reason
    log.resolutionConfidence = resolution.confidence
    log.shouldAskUser = resolution.actions.shouldAskUser === true
    log.clarificationNeeded = resolution.actions.clarificationNeeded === true

    if (resolution.resolutionType === "unrelated") {
      log.status = "dismissed"
    } else if (resolution.actions.clarificationNeeded || resolution.actions.shouldAskUser) {
      log.status = "clarification_needed"
    } else {
      log.status = "resolved"
    }

    await this.save(store)
    appendMemoryTrace({
      op: "resolver.resolution.apply",
      layer: "L2",
      status: "ok",
      l2Id: log.sourceL2Id,
      ragId: log.sourceRagId,
      details: {
        conflictLogId: log.id,
        targetL2Id: log.targetL2Id,
        resolutionType: log.resolutionType,
        resolutionMemoryId,
        conflictStatus: log.status,
      },
    })
    return log
  }

  /** 批量更新 L2 条目的 status */
  async updateL2Status(ids: string[], status: L2Memory["status"]): Promise<void> {
    const store = await this.load()
    for (const mem of store.l2) {
      if (ids.includes(mem.id)) {
        mem.status = status
      }
    }
    await this.save(store)
    appendMemoryTrace({
      op: "l2.status.batch",
      layer: "L2",
      status: "ok",
      details: { ids, memoryStatus: status },
    })
  }

  async archiveL2Batch(ids: string[]): Promise<void> {
    await this.updateL2Status(ids, "archived")
  }

  async decayL2Weights(delta = 1): Promise<number> {
    const store = await this.load()
    let changed = 0

    for (const mem of store.l2) {
      if (mem.isPinned || mem.status === "archived" || mem.weight <= 0) continue

      mem.weight = Math.max(0, mem.weight - delta)
      if (mem.weight >= 30) {
        mem.status = "active"
      } else if (mem.weight >= 10) {
        mem.status = "aging"
      } else {
        mem.status = "archived"
      }
      changed += 1
    }

    if (changed > 0) {
      await this.save(store)
    }
    appendMemoryTrace({
      op: "l2.decay",
      layer: "L2",
      status: changed > 0 ? "ok" : "skip",
      details: { delta, changed },
    })
    return changed
  }

  /** 批量插入新的 L2 条目（压缩总结用） */
  async addL2Batch(inputs: L2Input[]): Promise<L2Memory[]> {
    const store = await this.load()
    const results: L2Memory[] = []
    for (const input of inputs) {
      const memory: L2Memory = {
        ...input,
        id: `l2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
        weight: 0,
        status: "active",
        syncStatus: input.syncStatus ?? (input.ragId ? "synced" : "pending_sync"),
        evidenceIds: Array.isArray(input.evidenceIds) ? input.evidenceIds : [],
      }
      const evidence = this.createEvidence(memory, input)
      memory.evidenceIds = [...(memory.evidenceIds ?? []), evidence.id]
      store.l2.push(memory)
      if (!store.evidence) store.evidence = []
      store.evidence.push(evidence)
      results.push(memory)
    }
    await this.save(store)
    appendMemoryTrace({
      op: "l2.add.batch",
      layer: "L2",
      status: "ok",
      details: { ids: results.map((item) => item.id), count: results.length },
    })
    for (const memory of results) {
      const evidenceId = memory.evidenceIds?.[memory.evidenceIds.length - 1]
      appendMemoryTrace({
        op: "evidence.add",
        layer: "L2",
        status: "ok",
        l2Id: memory.id,
        details: { evidenceId, sourceStatus: "active" },
      })
    }
    return results
  }
}

export const memoryStore = new MemoryStoreManager()
