import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonVectorStore } from "./vectorstore";
import type { EmbeddingProvider } from "./embedding";

describe("chat history vector persistence", () => {
  it("does not collapse repeated verbatim utterances into one event", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-vector-"));
    const provider = {
      name: "test",
      dims: 2,
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    } as unknown as EmbeddingProvider;
    const store = new JsonVectorStore(dir);

    await store.add("晚安", "chat_history", provider, { sessionId: "a" });
    await store.add("晚安", "chat_history", provider, { sessionId: "b" });

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "memory-store.json"), "utf8"));
    expect(saved).toHaveLength(2);
    expect(saved.map((entry: { metadata: { sessionId: string } }) => entry.metadata.sessionId)).toEqual(["a", "b"]);
  });
});
