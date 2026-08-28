import { describe, expect, it, vi } from "vitest"
import { MemoryContextBuilder } from "./memory-context-builder"

function entry(id: string, text: string, source: string, sessionId?: string) {
  return {
    id,
    text,
    createdAt: 10,
    score: 0.9,
    metadata: { source, sessionId },
  }
}

describe("MemoryContextBuilder", () => {
  it("automatically recalls another conversation summary with provenance", async () => {
    const search = vi.fn(async (_query: string, source?: string) => {
      if (source === "conversation_summary") return [entry("s-a", "决定使用增量会话摘要，下一步补删除级联", source, "chat-a")]
      return []
    })
    const builder = new MemoryContextBuilder({
      getL0: async () => ({ preferredName: "", occupation: "", longTermInterests: "", language: "中文", permanentNote: "", nickname: "", isPinned: false, updatedAt: 0 }),
      getL1: async () => ({ recentGoals: "完成跨会话记忆", recentPreferences: "", currentProject: "Cyrene", generatedAt: 0, roundCount: 0 }),
      search: search as never,
      listSource: () => [],
    })

    const result = await builder.build({
      conversationId: "chat-b",
      query: "继续上次的记忆方案",
      recentMessages: [{ role: "user", text: "继续上次的记忆方案" }],
      mode: "work",
    })

    expect(result.text).toContain("决定使用增量会话摘要")
    expect(result.text).toContain("来源会话=chat-a")
    expect(result.text).toContain("只读的辅助记忆")
  })

  it("does not reinject the current conversation or recent window text", async () => {
    const search = vi.fn(async (_query: string, source?: string) => {
      if (source === "conversation_summary") return [entry("s-b", "current summary", source, "chat-b")]
      if (source === "chat_history") return [entry("h-a", "already visible", source, "chat-a")]
      return []
    })
    const builder = new MemoryContextBuilder({
      getL0: async () => ({ preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "", nickname: "", isPinned: false, updatedAt: 0 }),
      getL1: async () => ({ recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount: 0 }),
      search: search as never,
      listSource: () => [],
    })
    const result = await builder.build({
      conversationId: "chat-b",
      query: "还记得吗",
      recentMessages: [{ role: "assistant", text: "already visible" }],
      mode: "chat",
    })
    expect(result.text).not.toContain("current summary")
    expect(result.text).not.toContain("already visible")
  })

  it("drops whole candidates to stay within the token budget", async () => {
    const builder = new MemoryContextBuilder({
      getL0: async () => ({ preferredName: "名字".repeat(300), occupation: "", longTermInterests: "", language: "", permanentNote: "", nickname: "", isPinned: false, updatedAt: 0 }),
      getL1: async () => ({ recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount: 0 }),
      search: vi.fn(async () => []) as never,
      listSource: () => [],
    })
    const result = await builder.build({ conversationId: "b", query: "x", recentMessages: [], mode: "work", tokenBudget: 30 })
    expect(result.text).toBe("")
    expect(result.droppedCandidateCount).toBe(1)
  })
})
