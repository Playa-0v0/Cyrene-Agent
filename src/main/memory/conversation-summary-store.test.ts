import { afterEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { ConversationSummaryStore } from "./conversation-summary-store"
import type { ConversationMemorySummary } from "./conversation-summary-types"

const roots: string[] = []

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-summary-store-"))
  roots.push(root)
  return new ConversationSummaryStore(root)
}

function summary(sessionId: string, revision = 1): ConversationMemorySummary {
  return {
    schemaVersion: 2,
    sessionId,
    mode: "work",
    revision,
    overview: "跨会话记忆施工",
    topics: ["记忆"],
    decisions: [],
    openLoops: ["继续施工"],
    currentState: ["摘要存储已完成"],
    nextSteps: ["继续施工"],
    entities: ["Cyrene"],
    keywords: ["memory"],
    coveredMessageCount: 8,
    coveredUntilMessageId: "m8",
    sourceMessageIds: ["m1", "m8"],
    generatedAt: 1,
    updatedAt: revision,
    indexStatus: "pending",
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("ConversationSummaryStore", () => {
  it("atomically persists and replaces one summary per conversation", () => {
    const store = createStore()
    store.put(summary("chat-a"))
    store.put(summary("chat-a", 2))

    expect(store.get("chat-a")?.revision).toBe(2)
    expect(store.list()).toHaveLength(1)
  })

  it("deletes the persisted summary", () => {
    const store = createStore()
    store.put(summary("chat-a"))
    expect(store.delete("chat-a")).toBe(true)
    expect(store.get("chat-a")).toBeNull()
  })

  it("loads schema v1 summaries with empty continuation fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-summary-store-legacy-"))
    roots.push(root)
    const dir = path.join(root, "summaries")
    fs.mkdirSync(dir, { recursive: true })
    const legacy = { ...summary("chat-old"), schemaVersion: 1 }
    delete (legacy as Partial<typeof legacy>).currentState
    delete (legacy as Partial<typeof legacy>).nextSteps
    fs.writeFileSync(path.join(dir, "chat-old.json"), JSON.stringify(legacy), "utf8")

    expect(new ConversationSummaryStore(root).get("chat-old")).toMatchObject({
      schemaVersion: 2,
      currentState: [],
      nextSteps: [],
    })
  })

  it("rejects path traversal session ids", () => {
    const store = createStore()
    expect(() => store.put(summary("../escape"))).toThrow("invalid conversation summary sessionId")
  })
})
