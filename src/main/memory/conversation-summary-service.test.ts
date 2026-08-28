import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ChatMessage, ChatSession } from "../../shared/chat-types"
import { ConversationSummaryService, effectiveMessages } from "./conversation-summary-service"
import { ConversationSummaryStore } from "./conversation-summary-store"

const roots: string[] = []

function messages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index + 1}`,
    role: index % 2 === 0 ? "user" as const : "model" as const,
    content: `message ${index + 1}`,
    at: index + 1,
  }))
}

function session(allMessages: ChatMessage[]): ChatSession {
  return {
    id: "chat-a",
    title: "test",
    identityId: null,
    messages: allMessages,
    createdAt: 1,
    updatedAt: 2,
    schemaVersion: 1,
    mode: "work",
  }
}

function setup(initialMessages = messages(8)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-summary-service-"))
  roots.push(root)
  const store = new ConversationSummaryStore(root)
  let current = session(initialMessages)
  const generateSummary = vi.fn(async () => ({
    overview: "summary",
    topics: ["memory"],
    decisions: [],
    openLoops: ["continue"],
    entities: ["Cyrene"],
    keywords: ["memory"],
  }))
  const indexSummary = vi.fn(async () => "rag-summary")
  const service = new ConversationSummaryService({
    store,
    getSession: () => current,
    generateSummary,
    indexSummary,
    now: () => 100,
  })
  return { service, store, generateSummary, indexSummary, setMessages: (value: ChatMessage[]) => { current = session(value) } }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("ConversationSummaryService", () => {
  it("creates an indexed summary after eight effective messages", async () => {
    const { service, store, generateSummary, indexSummary } = setup()
    await service.schedule("chat-a")

    expect(generateSummary).toHaveBeenCalledWith(expect.objectContaining({ messages: expect.arrayContaining([
      expect.objectContaining({ id: "m1" }),
      expect.objectContaining({ id: "m8" }),
    ]) }))
    expect(indexSummary).toHaveBeenCalledTimes(1)
    expect(store.get("chat-a")).toMatchObject({
      revision: 1,
      coveredMessageCount: 8,
      ragId: "rag-summary",
      indexStatus: "synced",
    })
  })

  it("updates incrementally and does not summarize a partial interval", async () => {
    const { service, store, generateSummary, setMessages } = setup()
    await service.schedule("chat-a")
    setMessages(messages(12))
    await service.schedule("chat-a")
    expect(generateSummary).toHaveBeenCalledTimes(1)

    setMessages(messages(16))
    await service.schedule("chat-a")
    expect(generateSummary).toHaveBeenCalledTimes(2)
    expect(generateSummary.mock.calls[1][0].messages.map((message) => message.id)).toEqual([
      "m9", "m10", "m11", "m12", "m13", "m14", "m15", "m16",
    ])
    expect(store.get("chat-a")?.revision).toBe(2)
  })

  it("keeps the previous revision when generation fails", async () => {
    const { service, store, generateSummary, setMessages } = setup()
    await service.schedule("chat-a")
    setMessages(messages(16))
    generateSummary.mockRejectedValueOnce(new Error("offline"))
    await service.schedule("chat-a")
    expect(store.get("chat-a")?.revision).toBe(1)
  })

  it("keeps a valid summary pending when embeddings are unavailable", async () => {
    const { service, store, indexSummary } = setup()
    indexSummary.mockRejectedValueOnce(new Error("RAG not initialized"))
    await service.schedule("chat-a")
    expect(store.get("chat-a")).toMatchObject({ revision: 1, indexStatus: "pending" })
  })

  it("filters secrets and explicit forget requests before summarization", () => {
    const filtered = effectiveMessages([
      { id: "a", role: "user", content: "apiKey=abc123", at: 1 },
      { id: "b", role: "user", content: "不要记住刚才这句话", at: 2 },
      { id: "c", role: "model", content: "Bearer secret-token", at: 3 },
    ])
    expect(filtered).toHaveLength(2)
    expect(filtered.map((message) => message.text).join("\n")).not.toContain("abc123")
    expect(filtered.map((message) => message.text).join("\n")).not.toContain("secret-token")
  })
})
