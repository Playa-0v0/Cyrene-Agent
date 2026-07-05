import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}))

function readTraceEvents(): Array<Record<string, unknown>> {
  const tracePath = path.join(electronMock.userDataDir, "memory-trace.log")
  if (!fs.existsSync(tracePath)) return []
  return fs.readFileSync(tracePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("memoryStore", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-"))
    vi.resetModules()
  })

  it("persists L2 conflict markers and status changes", async () => {
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户喜欢香菇",
      triggerText: "我喜欢香菇",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })

    const marked = await memoryStore.markL2Conflict(existing.id, "rag_new")

    expect(marked?.conflictWith).toEqual(["rag_new"])
    expect(marked?.status).toBe("aging")

    const persisted = JSON.parse(
      fs.readFileSync(path.join(electronMock.userDataDir, "memory.json"), "utf8"),
    )
    expect(persisted.l2[0].conflictWith).toEqual(["rag_new"])
    expect(persisted.l2[0].status).toBe("aging")

    const traceEvents = readTraceEvents()
    expect(traceEvents.some((event) => event.op === "l2.add" && event.l2Id === existing.id)).toBe(true)
    expect(traceEvents.some((event) => event.op === "l2.conflict.mark" && event.l2Id === existing.id)).toBe(true)
  })

  it("keeps pinned L2 memories active when marking conflicts", async () => {
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户喜欢平菇",
      triggerText: "我喜欢平菇",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: true,
    })

    const marked = await memoryStore.markL2Conflict(existing.id, "rag_new")

    expect(marked?.conflictWith).toEqual(["rag_new"])
    expect(marked?.status).toBe("active")
  })

  it("decays only unpinned active L2 memories with positive weight", async () => {
    const { memoryStore } = await import("./memory-store")
    const active = await memoryStore.addL2Memory({
      content: "用户正在练琴",
      triggerText: "我最近在练琴",
      sourceConversationId: "test",
      ragId: "rag_active",
      isPinned: false,
    })
    const pinned = await memoryStore.addL2Memory({
      content: "用户固定喜欢中文",
      triggerText: "我一直用中文",
      sourceConversationId: "test",
      ragId: "rag_pinned",
      isPinned: true,
    })

    const store = await memoryStore.load()
    const activeEntry = store.l2.find((m) => m.id === active.id)!
    const pinnedEntry = store.l2.find((m) => m.id === pinned.id)!
    activeEntry.weight = 10
    pinnedEntry.weight = 10
    await memoryStore.save(store)

    const changed = await memoryStore.decayL2Weights()
    const persisted = JSON.parse(
      fs.readFileSync(path.join(electronMock.userDataDir, "memory.json"), "utf8"),
    )

    expect(changed).toBe(1)
    expect(persisted.l2.find((m: { id: string }) => m.id === active.id).weight).toBe(9)
    expect(persisted.l2.find((m: { id: string }) => m.id === active.id).status).toBe("archived")
    expect(persisted.l2.find((m: { id: string }) => m.id === pinned.id).weight).toBe(10)
    expect(persisted.l2.find((m: { id: string }) => m.id === pinned.id).status).toBe("active")
  })

  it("updates L0 and L2 through atomic write APIs", async () => {
    const { memoryStore } = await import("./memory-store")
    await memoryStore.upsertL0Field("preferredName", "伙伴")
    const memory = await memoryStore.addL2Memory({
      content: "用户最近在做记忆系统重构",
      triggerText: "我们重构记忆系统",
      sourceConversationId: "test",
      ragId: "rag_memory_refactor",
      isPinned: false,
    })
    await memoryStore.updateL2RecallStats(memory.id, 12)

    const l0 = await memoryStore.getL0()
    const allL2 = await memoryStore.getAllL2()
    const updated = allL2.find((item) => item.id === memory.id)!
    const traceEvents = readTraceEvents()

    expect(l0.preferredName).toBe("伙伴")
    expect(l0.updatedAt).toBeGreaterThan(0)
    expect(updated.weight).toBe(12)
    expect(updated.accessCount).toBe(1)
    expect(updated.status).toBe("aging")
    expect(traceEvents.some((event) => event.op === "l0.update")).toBe(true)
    expect(traceEvents.some((event) => event.op === "l2.weight.update" && event.l2Id === memory.id)).toBe(true)
  })

  it("marks L2 sync status and persists rag ids", async () => {
    const { memoryStore } = await import("./memory-store")
    const memory = await memoryStore.addL2Memory({
      content: "用户喜欢可靠的长期记忆",
      triggerText: "长期记忆要可靠",
      sourceConversationId: "test",
      isPinned: false,
      syncStatus: "pending_sync",
    })

    const synced = await memoryStore.markL2SyncStatus(memory.id, "synced", "rag_synced")
    const persisted = JSON.parse(
      fs.readFileSync(path.join(electronMock.userDataDir, "memory.json"), "utf8"),
    )
    const traceEvents = readTraceEvents()

    expect(synced?.syncStatus).toBe("synced")
    expect(synced?.ragId).toBe("rag_synced")
    expect(persisted.l2[0].syncStatus).toBe("synced")
    expect(persisted.l2[0].ragId).toBe("rag_synced")
    expect(traceEvents.some((event) => event.op === "l2.sync.success" && event.l2Id === memory.id)).toBe(true)
  })

  it("stores conflict logs separately from reflection logs with a capped history", async () => {
    const { memoryStore } = await import("./memory-store")
    for (let i = 0; i < 101; i++) {
      await memoryStore.appendConflictLog({
        status: "candidate",
        sourceL2Id: `source_${i}`,
        targetL2Id: `target_${i}`,
        sourceRagId: `rag_source_${i}`,
        targetRagId: `rag_target_${i}`,
        reason: "test conflict",
        confidence: 0.7,
        detector: "local",
      })
    }

    const conflictLogs = await memoryStore.getConflictLogs()
    const reflectionLogs = await memoryStore.getReflectionLogs()
    const persisted = JSON.parse(
      fs.readFileSync(path.join(electronMock.userDataDir, "memory.json"), "utf8"),
    )

    expect(conflictLogs).toHaveLength(100)
    expect(conflictLogs[0].sourceL2Id).toBe("source_1")
    expect(reflectionLogs).toHaveLength(0)
    expect(persisted.conflictLogs).toHaveLength(100)
  })

  it("migrates legacy memory files with a backup", async () => {
    const memoryPath = path.join(electronMock.userDataDir, "memory.json")
    fs.writeFileSync(
      memoryPath,
      JSON.stringify({
        l0: { preferredName: "伙伴" },
        l1: { roundCount: 7 },
        l2: [{
          id: "l2_legacy",
          content: "旧记忆",
          triggerText: "旧触发",
          sourceConversationId: "test",
          createdAt: 1,
          lastAccessedAt: 1,
          accessCount: 0,
          weight: 0,
          isPinned: false,
          status: "active",
          ragId: "rag_legacy",
        }],
        reflectionLogs: [],
        version: 1,
      }),
      "utf8",
    )

    const { memoryStore } = await import("./memory-store")
    const store = await memoryStore.load()
    const persisted = JSON.parse(fs.readFileSync(memoryPath, "utf8"))
    const backups = fs.readdirSync(electronMock.userDataDir).filter((name) => name.startsWith("memory.backup."))

    expect(store.schemaVersion).toBe(2)
    expect(persisted.schemaVersion).toBe(2)
    expect(store.l0.preferredName).toBe("伙伴")
    expect(store.l1.roundCount).toBe(7)
    expect(store.l2[0].syncStatus).toBe("synced")
    expect(store.conflictLogs).toEqual([])
    expect(backups).toHaveLength(1)
    expect(readTraceEvents().some((event) => event.op === "migration.upgrade")).toBe(true)
  })
})
