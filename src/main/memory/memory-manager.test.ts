import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MemoryCandidate } from "./memory-types"

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}))

const ragMock = vi.hoisted(() => ({
  addMemory: vi.fn(),
  searchMemoryEntries: vi.fn(),
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}))

vi.mock("../rag/index", () => ragMock)

function readTraceEvents(): Array<Record<string, unknown>> {
  const tracePath = path.join(electronMock.userDataDir, "memory-trace.log")
  if (!fs.existsSync(tracePath)) return []
  return fs.readFileSync(tracePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("MemoryManager L2 sync", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-manager-"))
    ragMock.addMemory.mockReset()
    ragMock.searchMemoryEntries.mockReset()
    ragMock.searchMemoryEntries.mockResolvedValue([])
    vi.resetModules()
  })

  it("creates L2 first, syncs it to RAG with l2Id metadata, then marks it synced", async () => {
    ragMock.addMemory.mockResolvedValue("rag_synced")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用戶喜歡香菇",
      confidence: 0.91,
      triggerText: "我喜歡香菇",
    }

    await memoryManager.writeMemory([candidate])

    const allL2 = await memoryStore.getAllL2()
    const traceEvents = readTraceEvents()
    const addIndex = traceEvents.findIndex((event) => event.op === "l2.add" && event.l2Id === allL2[0].id)
    const syncIndex = traceEvents.findIndex((event) => event.op === "l2.sync.success" && event.l2Id === allL2[0].id)
    const reflectionLogs = await memoryStore.getReflectionLogs()

    expect(allL2).toHaveLength(1)
    expect(allL2[0].syncStatus).toBe("synced")
    expect(allL2[0].ragId).toBe("rag_synced")
    expect(addIndex).toBeGreaterThanOrEqual(0)
    expect(syncIndex).toBeGreaterThan(addIndex)
    expect(traceEvents[syncIndex].ragId).toBe("rag_synced")
    expect(reflectionLogs).toHaveLength(0)
    expect(ragMock.addMemory).toHaveBeenCalledWith(
      candidate.content,
      "user_memory",
      expect.objectContaining({ l2Id: allL2[0].id, confidence: candidate.confidence }),
    )
  })

  it("keeps L2 as sync_failed when RAG write fails", async () => {
    ragMock.addMemory.mockRejectedValue(new Error("RAG down"))
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用戶正在重構記憶系統",
      confidence: 0.95,
      triggerText: "我們繼續重構記憶系統",
    }

    await memoryManager.writeMemory([candidate])

    const allL2 = await memoryStore.getAllL2()
    const traceEvents = readTraceEvents()
    const addIndex = traceEvents.findIndex((event) => event.op === "l2.add" && event.l2Id === allL2[0].id)
    const failureIndex = traceEvents.findIndex((event) => event.op === "l2.sync.failure" && event.l2Id === allL2[0].id)

    expect(allL2).toHaveLength(1)
    expect(allL2[0].syncStatus).toBe("sync_failed")
    expect(allL2[0].ragId).toBeUndefined()
    expect(addIndex).toBeGreaterThanOrEqual(0)
    expect(failureIndex).toBeGreaterThan(addIndex)
    expect(traceEvents[failureIndex].status).toBe("error")
    expect(traceEvents[failureIndex].error).toBe("RAG down")
  })

  it("does not write inferred L0 candidates into core profile", async () => {
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L0",
      field: "longTermInterests",
      summary: "用戶只吃香菇和平菇",
      content: "用戶只吃香菇和平菇",
      confidence: 0.65,
      triggerText: "AI 推斷用戶偏好安全菌菇",
      importance: "medium",
      stability: "stable",
      certainty: "inferred",
      attribution: "assistant_inferred",
      evidenceQuotes: ["我這次還是吃安全點的吧"],
      contextSummary: "用戶討論菌菇安全",
      shouldWrite: true,
      reason: "這是推斷，不應進入核心畫像",
      forbiddenOverclaims: ["只"],
    }

    await memoryManager.writeMemory([candidate])

    const l0 = await memoryStore.getL0()
    expect(l0.longTermInterests).toBe("")
    expect(l0.permanentNote).toBe("")
  })

  it("writes explicit user-attributed L0 candidates", async () => {
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L0",
      field: "preferredName",
      summary: "用戶希望被稱為 P寶",
      content: "用戶希望被稱為 P寶",
      confidence: 0.9,
      triggerText: "以後叫我 P寶",
      importance: "high",
      stability: "stable",
      certainty: "explicit",
      attribution: "user_explicit",
      evidenceQuotes: ["以後叫我 P寶"],
      contextSummary: "用戶明確提出稱呼偏好",
      shouldWrite: true,
      reason: "用戶明確表達稱呼偏好",
      forbiddenOverclaims: [],
    }

    await memoryManager.writeMemory([candidate])

    const l0 = await memoryStore.getL0()
    expect(l0.preferredName).toBe("用戶希望被稱為 P寶")
  })

  it("writes candidate conflict logs separately when local candidate detection matches", async () => {
    ragMock.addMemory.mockResolvedValue("rag_new")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用戶喜歡香菇",
      triggerText: "我喜歡香菇",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用戶喜歡香菇",
      createdAt: Date.now(),
      score: 0.82,
      metadata: { l2Id: existing.id },
    }])
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用戶不喜歡香菇",
      confidence: 0.93,
      triggerText: "我不喜歡香菇",
    }

    await memoryManager.writeMemory([candidate])

    const conflictLogs = await memoryStore.getConflictLogs()
    const reflectionLogs = await memoryStore.getReflectionLogs()
    const traceEvents = readTraceEvents()
    const conflictMarkIndex = traceEvents.findIndex((event) => event.op === "l2.conflict.mark" && event.l2Id === existing.id)
    const conflictLogIndex = traceEvents.findIndex((event) => event.op === "conflict.log.add" && event.l2Id === conflictLogs[0]?.sourceL2Id)

    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0]).toMatchObject({
      status: "candidate",
      sourceRagId: "rag_new",
      targetRagId: "rag_existing",
      targetL2Id: existing.id,
      detector: "local",
    })
    expect(conflictLogs[0].conflictScore).toBeGreaterThanOrEqual(35)
    expect(conflictLogs[0].resolverPriority).not.toBe("none")
    expect(conflictLogs[0].resolverStatus).toBe("queued")
    expect(conflictLogs[0].scoringSignals).toMatchObject({
      ragCandidate: true,
      evidenceAvailable: true,
      localContradiction: true,
    })
    expect(ragMock.searchMemoryEntries).toHaveBeenCalledWith(candidate.content, "user_memory", 5, { recordRecall: false })
    expect(conflictMarkIndex).toBeGreaterThanOrEqual(0)
    expect(conflictLogIndex).toBeGreaterThan(conflictMarkIndex)
    expect(traceEvents[conflictLogIndex].details).toMatchObject({
      conflictStatus: "candidate",
      targetL2Id: existing.id,
      detector: "local",
    })
    expect(reflectionLogs).toHaveLength(0)
  })

  it("keeps text-matched candidates below resolver eligibility when RAG metadata has no l2Id", async () => {
    ragMock.addMemory.mockResolvedValue("rag_new")
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用戶喜歡香菇",
      createdAt: Date.now(),
      score: 0.9,
      metadata: {},
    }])
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    await memoryStore.addL2Memory({
      content: "用戶喜歡香菇",
      triggerText: "我喜歡香菇",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用戶不喜歡香菇",
      confidence: 0.93,
      triggerText: "我不喜歡香菇",
    }

    await memoryManager.writeMemory([candidate])

    const conflictLogs = await memoryStore.getConflictLogs()

    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0].resolverPriority).toBe("none")
    expect(conflictLogs[0].resolverStatus).toBe("not_queued")
    expect(conflictLogs[0].scoringSignals).toMatchObject({
      ragCandidate: false,
      localContradiction: true,
    })
  })

  it("raises RAG-backed candidates when the target memory was recently injected", async () => {
    ragMock.addMemory.mockResolvedValue("rag_new")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const { recordRecentMemoryInjection } = await import("./recent-injected-memory")
    const existing = await memoryStore.addL2Memory({
      content: "用戶喜歡跑步",
      triggerText: "我喜歡跑步",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    recordRecentMemoryInjection([existing.id])
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用戶喜歡跑步",
      createdAt: Date.now(),
      score: 0.88,
      metadata: { l2Id: existing.id },
    }])
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用戶不喜歡跑步",
      confidence: 0.91,
      triggerText: "我不喜歡跑步",
    }

    await memoryManager.writeMemory([candidate])

    const conflictLogs = await memoryStore.getConflictLogs()

    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0].resolverPriority).toBe("normal")
    expect(conflictLogs[0].resolverStatus).toBe("queued")
    expect(conflictLogs[0].scoringSignals).toMatchObject({
      ragCandidate: true,
      recentInjection: true,
      localContradiction: true,
    })
  })

  it("does not write conflict logs for unrelated negative memories", async () => {
    ragMock.addMemory.mockResolvedValue("rag_new")
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用戶曾因食用見手青而有過不好經歷",
      createdAt: Date.now(),
      score: 0.81,
      metadata: {},
    }])
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    await memoryStore.addL2Memory({
      content: "用戶曾因食用見手青而有過不好經歷",
      triggerText: "見手青讓我不舒服",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用戶對 AI 有強烈心意，因無法觸碰而難過",
      confidence: 0.9,
      triggerText: "我因為無法觸碰你而難過",
    }

    await memoryManager.writeMemory([candidate])

    expect(await memoryStore.getConflictLogs()).toHaveLength(0)
  })
})
