import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ChatSession, ChatSessionMeta } from "../../shared/chat-types"
import { ConversationMemoryBackfill } from "./conversation-memory-backfill"

const roots: string[] = []

function makeSession(id: string, updatedAt: number): ChatSession {
  return {
    id,
    title: id,
    identityId: null,
    mode: "work",
    schemaVersion: 1,
    createdAt: updatedAt,
    updatedAt,
    messages: Array.from({ length: 4 }, (_, index) => ({
      id: `${id}-m${index}`,
      role: index % 2 === 0 ? "user" as const : "model" as const,
      content: `${id} message ${index}`,
      at: index,
    })),
  }
}

function meta(session: ChatSession): ChatSessionMeta {
  return {
    id: session.id,
    title: session.title,
    identityId: null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    mode: "work",
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("ConversationMemoryBackfill", () => {
  it("persists a cursor, resumes in small batches, and becomes a no-op after completion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-backfill-"))
    roots.push(root)
    const sessions = [makeSession("a", 1), makeSession("b", 2)]
    const indexMessage = vi.fn(async () => {})
    const updateSummary = vi.fn(async () => {})
    const deps = {
      statePath: path.join(root, "state.json"),
      listSessions: () => sessions.map(meta),
      getSession: (id: string) => sessions.find((session) => session.id === id) ?? null,
      indexMessage,
      updateSummary,
      now: () => 10,
    }

    const first = await new ConversationMemoryBackfill(deps).runBatch(1)
    expect(first).toMatchObject({ processed: 1, done: false })
    expect(indexMessage).toHaveBeenCalledTimes(4)

    const second = await new ConversationMemoryBackfill(deps).runBatch(1)
    expect(second).toMatchObject({ processed: 1, done: true })
    expect(indexMessage).toHaveBeenCalledTimes(8)
    expect(updateSummary).toHaveBeenCalledTimes(2)

    const third = await new ConversationMemoryBackfill(deps).runBatch(1)
    expect(third).toMatchObject({ processed: 0, done: true })
    expect(indexMessage).toHaveBeenCalledTimes(8)
  })

  it("records only safe failure codes and continues other sessions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-backfill-failure-"))
    roots.push(root)
    const sessions = [makeSession("a", 1), makeSession("b", 2)]
    const result = await new ConversationMemoryBackfill({
      statePath: path.join(root, "state.json"),
      listSessions: () => sessions.map(meta),
      getSession: (id) => sessions.find((session) => session.id === id) ?? null,
      indexMessage: async (sessionId) => {
        if (sessionId === "a") throw new Error("RAG not initialized: apiKey=secret")
      },
      updateSummary: async () => {},
    }).runBatch(2)

    expect(result).toMatchObject({ processed: 2, done: true, failures: 1 })
    const stateText = fs.readFileSync(path.join(root, "state.json"), "utf8")
    expect(stateText).toContain("RAG_UNAVAILABLE")
    expect(stateText).not.toContain("secret")
  })
})
