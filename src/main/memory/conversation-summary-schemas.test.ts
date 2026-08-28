import { describe, expect, it } from "vitest"
import { CONVERSATION_SUMMARY_JSON_SCHEMA, parseConversationSummaryDraft } from "./conversation-summary-schemas"

describe("conversation summary schema v2", () => {
  it("parses explicit current state and next steps", () => {
    expect(parseConversationSummaryDraft({
      overview: "跨会话记忆召回质量施工",
      topics: ["memory"],
      decisions: ["复用 HybridRetriever"],
      openLoops: ["等待完整回归"],
      currentState: ["MemoryContextBuilder 已接入"],
      nextSteps: ["运行全量测试"],
      entities: ["Cyrene"],
      keywords: ["finalScore"],
    })).toMatchObject({
      currentState: ["MemoryContextBuilder 已接入"],
      nextSteps: ["运行全量测试"],
    })
  })

  it("requires both continuation fields for new summaries", () => {
    expect(() => parseConversationSummaryDraft({
      overview: "旧格式",
      topics: [],
      decisions: [],
      openLoops: [],
      entities: [],
      keywords: [],
    })).toThrow(/currentState/)
    expect(CONVERSATION_SUMMARY_JSON_SCHEMA.required).toEqual(expect.arrayContaining(["currentState", "nextSteps"]))
  })
})
