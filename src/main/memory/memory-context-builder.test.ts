import { describe, expect, it, vi } from "vitest"
import { MemoryContextBuilder, scoreMemoryCandidate } from "./memory-context-builder"

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
    expect(search.mock.calls.some(([, source]) => source === "chat_history")).toBe(false)
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
    expect(search.mock.calls.some(([, source]) => source === "chat_history")).toBe(true)
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

  it("rewrites ambiguous Chat memory queries with L1 and recent dialogue only", async () => {
    const search = vi.fn(async () => [])
    const builder = new MemoryContextBuilder({
      getL0: async () => ({ preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "", nickname: "", isPinned: false, updatedAt: 0 }),
      getL1: async () => ({ recentGoals: "补统一召回评分", recentPreferences: "", currentProject: "Cyrene 跨会话记忆", generatedAt: 0, roundCount: 0 }),
      search: search as never,
      listSource: () => [],
    })

    const result = await builder.build({
      conversationId: "chat-b",
      query: "继续上次那个方案",
      recentMessages: [
        { role: "assistant", text: "我们已经完成了 MemoryContextBuilder" },
        { role: "user", text: "继续上次那个方案" },
      ],
      mode: "chat",
    })

    expect(result.rewrittenQuery).toContain("Cyrene 跨会话记忆")
    expect(result.rewrittenQuery).toContain("补统一召回评分")
    expect(result.rewrittenQuery).toContain("MemoryContextBuilder")
    expect(search).toHaveBeenCalledWith(expect.stringContaining("记忆检索上下文"), "user_memory", 12, expect.any(Object))
  })

  it("keeps explicit Chat queries unchanged", async () => {
    const builder = new MemoryContextBuilder({
      getL0: async () => ({ preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "", nickname: "", isPinned: false, updatedAt: 0 }),
      getL1: async () => ({ recentGoals: "补统一召回评分", recentPreferences: "", currentProject: "Cyrene", generatedAt: 0, roundCount: 0 }),
      search: vi.fn(async () => []) as never,
      listSource: () => [],
    })
    const result = await builder.build({ conversationId: "chat-b", query: "Cyrene 的 finalScore 怎么设计", recentMessages: [], mode: "chat" })
    expect(result.rewrittenQuery).toBe("Cyrene 的 finalScore 怎么设计")
  })

  it("does not rewrite Work queries that CITA already contextualized", async () => {
    const builder = new MemoryContextBuilder({
      getL0: async () => ({ preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "", nickname: "", isPinned: false, updatedAt: 0 }),
      getL1: async () => ({ recentGoals: "不应再次拼接", recentPreferences: "", currentProject: "不应再次拼接", generatedAt: 0, roundCount: 0 }),
      search: vi.fn(async () => []) as never,
      listSource: () => [],
    })
    const result = await builder.build({ conversationId: "chat-b", query: "继续 Cyrene 的跨会话记忆方案", recentMessages: [], mode: "work" })
    expect(result.rewrittenQuery).toBe("继续 Cyrene 的跨会话记忆方案")
  })

  it("combines retrieval, recency, continuity and penalties into finalScore", () => {
    const base = {
      id: "l2-a",
      source: "l2" as const,
      text: "Cyrene 跨会话记忆",
      score: 0.7,
      semanticScore: 0.7,
      bm25Score: 0.5,
      rerankerScore: 0.8,
      importanceScore: 0.9,
      confidenceScore: 0.95,
      createdAt: 9_000,
      sessionId: "chat-a",
    }
    const stable = scoreMemoryCandidate(base, "继续之前的记忆方案", "chat-b", 10_000)
    const conflicting = scoreMemoryCandidate({ ...base, id: "l2-b", uncertain: true, sessionId: "chat-b" }, "继续之前的记忆方案", "chat-b", 10_000)
    expect(stable.finalScore).toBeGreaterThan(conflicting.finalScore ?? 0)
    expect(stable).toMatchObject({ semanticScore: 0.7, bm25Score: 0.5, rerankerScore: 0.8, continuityScore: 0.85 })
  })

  it("deduplicates one fact across L2, summary and raw history with L2 priority", async () => {
    const search = vi.fn(async (_query: string, source?: string) => {
      if (source === "user_memory") return [entry("l2-a", "用户正在开发 Cyrene 跨会话记忆系统", source, "chat-a")]
      if (source === "conversation_summary") return [entry("s-a", "本会话讨论了 Cyrene 跨会话记忆系统的开发", source, "chat-a")]
      if (source === "chat_history") return [entry("h-a", "我正在开发 Cyrene 跨会话记忆系统", source, "chat-a")]
      return []
    })
    const builder = new MemoryContextBuilder({
      getL0: async () => ({ preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "", nickname: "", isPinned: false, updatedAt: 0 }),
      getL1: async () => ({ recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount: 0 }),
      search: search as never,
      listSource: () => [],
      isSessionActive: () => true,
    })
    const result = await builder.build({ conversationId: "chat-b", query: "我之前具体说了什么", recentMessages: [], mode: "chat" })
    expect(result.candidates.filter((candidate) => candidate.source === "l2")).toHaveLength(1)
    expect(result.candidates.some((candidate) => candidate.source === "conversation_summary")).toBe(false)
    expect(result.candidates.some((candidate) => candidate.source === "chat_history")).toBe(false)
    expect(result.droppedCandidateCount).toBeGreaterThanOrEqual(2)
  })

  it("fills the L2 source limit after removing an earlier duplicate", async () => {
    const l2Entries = [
      entry("l2-a", "用户正在开发 Cyrene 跨会话记忆系统", "user_memory", "chat-a"),
      entry("l2-a-copy", "用户正在开发 Cyrene 跨会话记忆系统", "user_memory", "chat-a"),
      entry("l2-b", "用户采用稳定 sourceKey 更新摘要向量", "user_memory", "chat-a"),
      entry("l2-c", "用户要求删除会话时级联清理证据", "user_memory", "chat-a"),
      entry("l2-d", "用户要求旧聊天在后台分批回填", "user_memory", "chat-a"),
      entry("l2-e", "用户要求召回上下文限制 token 预算", "user_memory", "chat-a"),
    ]
    const builder = new MemoryContextBuilder({
      getL0: async () => ({ preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "", nickname: "", isPinned: false, updatedAt: 0 }),
      getL1: async () => ({ recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount: 0 }),
      search: vi.fn(async (_query: string, source?: string) => source === "user_memory" ? l2Entries : []) as never,
      listSource: () => [],
      isSessionActive: () => true,
    })
    const result = await builder.build({ conversationId: "chat-b", query: "Cyrene 记忆系统", recentMessages: [], mode: "work" })
    expect(result.candidates.filter((candidate) => candidate.source === "l2")).toHaveLength(4)
  })
})
