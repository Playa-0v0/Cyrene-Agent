import { afterEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { EmbeddingProvider } from "./embedding"
import { JsonVectorStore } from "./vectorstore"

const roots: string[] = []
const provider: EmbeddingProvider = {
  name: "test",
  dims: 2,
  embed: async (text) => text.includes("new") ? [0, 1] : [1, 0],
  embedBatch: async (texts) => Promise.all(texts.map((text) => provider.embed(text))),
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("JsonVectorStore source keys", () => {
  it("upserts exactly one active entry for a stable source key", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-source-key-"))
    roots.push(root)
    const store = new JsonVectorStore(root)
    const first = await store.upsertBySourceKey("old summary", "conversation_summary", "chat-a", provider)
    const second = await store.upsertBySourceKey("new summary", "conversation_summary", "chat-a", provider)

    expect(second.id).toBe(first.id)
    expect(store.stats.sources.conversation_summary).toBe(1)
    expect(store.deleteEntriesBySourceKey("conversation_summary", "chat-a")).toBe(1)
    expect(store.stats.sources.conversation_summary).toBeUndefined()
  })
})
