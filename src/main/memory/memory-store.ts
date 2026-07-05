import * as fs from "fs"
import * as path from "path"
import { app } from "electron"
import { L0Profile, L1Profile, L2Memory, MemoryStore, ReflectionLog } from "./memory-types"
import { appendMemoryTrace } from "./memory-trace"

const CURRENT_SCHEMA_VERSION = 2

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
  reflectionLogs: [],
  version: 1,
}

function getMemoryPath(): string {
  return path.join(app.getPath("userData"), "memory.json")
}

function cloneDefaultStore(): MemoryStore {
  return {
    ...DEFAULT_STORE,
    l0: { ...DEFAULT_L0 },
    l1: { ...DEFAULT_L1 },
    l2: [],
    reflectionLogs: [],
  }
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
    l2: Array.isArray(store.l2) ? store.l2 : [],
    reflectionLogs: Array.isArray(store.reflectionLogs) ? store.reflectionLogs : [],
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

  async updateL0(patch: Partial<L0Profile>): Promise<void> {
    const store = await this.load()
    store.l0 = { ...store.l0, ...patch, updatedAt: Date.now() }
    await this.save(store)
    appendMemoryTrace({
      op: "l0.update",
      layer: "L0",
      status: "ok",
      details: { fields: Object.keys(patch) },
    })
  }

  async getL1(): Promise<L1Profile> {
    const store = await this.load()
    return store.l1
  }

  async updateL1(patch: Partial<L1Profile>): Promise<void> {
    const store = await this.load()
    store.l1 = { ...store.l1, ...patch }
    await this.save(store)
    appendMemoryTrace({
      op: "l1.update",
      layer: "L1",
      status: "ok",
      details: { fields: Object.keys(patch) },
    })
  }

  async addL2(input: Omit<L2Memory, "id" | "createdAt" | "lastAccessedAt" | "accessCount" | "weight" | "status">): Promise<L2Memory> {
    const store = await this.load()
    const memory: L2Memory = {
      ...input,
      id: `l2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      weight: 0,
      status: "active",
    }
    store.l2.push(memory)
    await this.save(store)
    appendMemoryTrace({
      op: "l2.add",
      layer: "L2",
      status: "ok",
      l2Id: memory.id,
      ragId: memory.ragId,
      details: { isSummary: memory.isSummary === true },
    })
    return memory
  }

  async updateL2Weight(id: string, delta: number): Promise<void> {
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

  async addReflectionLog(log: Omit<ReflectionLog, "id" | "createdAt">): Promise<void> {
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

  async getReflectionLogs(): Promise<ReflectionLog[]> {
    const store = await this.load()
    return store.reflectionLogs ?? []
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
  async addL2Batch(inputs: Array<Omit<L2Memory, "id" | "createdAt" | "lastAccessedAt" | "accessCount" | "weight" | "status">>): Promise<L2Memory[]> {
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
      }
      store.l2.push(memory)
      results.push(memory)
    }
    await this.save(store)
    appendMemoryTrace({
      op: "l2.add.batch",
      layer: "L2",
      status: "ok",
      details: { ids: results.map((item) => item.id), count: results.length },
    })
    return results
  }
}

export const memoryStore = new MemoryStoreManager()
