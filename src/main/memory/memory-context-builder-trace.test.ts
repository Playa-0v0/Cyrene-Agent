import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const electronMock = vi.hoisted(() => ({ userDataDir: "" }))

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}))

describe("MemoryContextBuilder recall trace", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-recall-trace-"))
    vi.resetModules()
  })

  afterEach(() => {
    fs.rmSync(electronMock.userDataDir, { recursive: true, force: true })
  })

  it("records rewritten query, score components, selections and drop reasons", async () => {
    const { MemoryContextBuilder } = await import("./memory-context-builder")
    const search = vi.fn(async (_query: string, source?: string) => {
      if (source === "user_memory") return [{
        id: "l2-a",
        text: "用户正在完善 Cyrene 跨会话记忆",
        createdAt: Date.now(),
        score: 0.9,
        scoreDetails: { vectorScore: 0.8, bm25Score: 0.6, hybridScore: 0.74, rerankerScore: 0.9 },
        metadata: { l2Id: "memory-a", sessionId: "chat-a", confidence: 0.95 },
      }]
      if (source === "conversation_summary") return [{
        id: "summary-a",
        text: "本会话讨论了 Cyrene 跨会话记忆的完善",
        createdAt: Date.now(),
        score: 0.8,
        scoreDetails: { vectorScore: 0.75, bm25Score: 0.5, hybridScore: 0.675 },
        metadata: { sessionId: "chat-a" },
      }]
      return []
    })
    const builder = new MemoryContextBuilder({
      getL0: async () => ({ preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "", nickname: "", isPinned: false, updatedAt: 0 }),
      getL1: async () => ({ recentGoals: "完善召回质量", recentPreferences: "", currentProject: "Cyrene", generatedAt: 0, roundCount: 0 }),
      search: search as never,
      listSource: () => [],
      isSessionActive: () => true,
      getAllL2: async () => [],
    })

    await builder.build({ conversationId: "chat-b", query: "继续上次那个方案 token=secret-token", recentMessages: [], mode: "chat" })

    const traceText = fs.readFileSync(path.join(electronMock.userDataDir, "memory-trace.log"), "utf8")
    expect(traceText).not.toContain("secret-token")
    expect(traceText).toContain("[REDACTED_SECRET]")
    const trace = traceText
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { op: string; details: Record<string, unknown> })
      .find((event) => event.op === "recall.build")
    expect(trace?.details).toMatchObject({ rewritten: true, selectedCount: 2, droppedCount: 1 })
    expect(trace?.details.rewrittenQuery).toContain("Cyrene")
    expect(trace?.details.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "l2", finalScore: expect.any(Number), selected: true }),
      expect.objectContaining({ source: "conversation_summary", selected: false, dropReason: "duplicate_fact" }),
    ]))
  })
})
