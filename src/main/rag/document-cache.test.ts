import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DOCUMENT_CHUNK_OVERLAP, DOCUMENT_CHUNK_SIZE } from "./chunk";

const { embeddingIdentity, userDataDir } = vi.hoisted(() => ({
  embeddingIdentity: {
    value: {
      provider: "local",
      model: "Xenova/bge-m3",
      dimensions: 1024,
      endpoint: undefined as string | undefined,
    },
  },
  userDataDir: { value: "" },
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir.value,
  },
}));

vi.mock("./embedding", () => ({
  getEmbeddingProviderIdentity: async () => embeddingIdentity.value,
}));

import {
  buildDocumentCacheIdentity,
  createDocumentCacheKey,
  getValidDocumentCacheRecord,
  putDocumentCacheRecord,
} from "./document-cache";

describe("document cache", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "document-cache-test-"));
    userDataDir.value = tmpDir;
    embeddingIdentity.value = {
      provider: "local",
      model: "Xenova/bge-m3",
      dimensions: 1024,
      endpoint: undefined,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    userDataDir.value = "";
  });

  it("uses normalized text and embedding identity in the cache key", async () => {
    const first = await buildDocumentCacheIdentity("hello\r\nworld");
    const second = await buildDocumentCacheIdentity("hello\nworld");

    expect(first.textSha256).toBe(second.textSha256);
    expect(first.embeddingProvider).toBeTruthy();
    expect(first.embeddingModel).toBeTruthy();
    expect(first.chunkStrategyVersion).toBe("document-chunks-v1");
    expect(first.chunkSize).toBe(DOCUMENT_CHUNK_SIZE);
    expect(first.chunkOverlap).toBe(DOCUMENT_CHUNK_OVERLAP);
  });

  it("invalidates when an OpenAI-compatible embedding endpoint changes", async () => {
    embeddingIdentity.value = {
      provider: "openai-compat",
      model: "text-embedding-3-small",
      dimensions: 1536,
      endpoint: "https://embeddings-one.example/v1",
    };
    const first = await buildDocumentCacheIdentity("hello world");

    embeddingIdentity.value = {
      ...embeddingIdentity.value,
      endpoint: "https://embeddings-two.example/v1",
    };
    const second = await buildDocumentCacheIdentity("hello world");

    expect(createDocumentCacheKey(first)).not.toBe(createDocumentCacheKey(second));
  });

  it("invalidates when the embedding model changes", () => {
    const first = createDocumentCacheKey({
      textSha256: "abc",
      embeddingProvider: "local",
      embeddingModel: "Xenova/bge-m3",
      dimensions: 1024,
      chunkStrategyVersion: "document-chunks-v1",
      chunkSize: 1200,
      chunkOverlap: 200,
    });
    const second = createDocumentCacheKey({
      textSha256: "abc",
      embeddingProvider: "local",
      embeddingModel: "different-model",
      dimensions: 384,
      chunkStrategyVersion: "document-chunks-v1",
      chunkSize: 1200,
      chunkOverlap: 200,
    });

    expect(first).not.toBe(second);
  });

  it("treats a cache record as stale when the importId has no stored chunks", async () => {
    await putDocumentCacheRecord({
      key: "cache-key",
      importId: "import-missing",
      chunkCount: 4,
      fileName: "cached.md",
      createdAt: new Date().toISOString(),
    });

    const result = await getValidDocumentCacheRecord("cache-key", () => false);

    expect(result).toBeNull();
  });

  it("treats malformed cache records as cache misses", async () => {
    const cachePath = path.join(tmpDir, "rag-data", "document-cache.json");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });

    const malformedRecords = [
      { importId: "import-1", chunkCount: 1, fileName: "cached.md", createdAt: new Date().toISOString() },
      { key: "cache-key", importId: 1, chunkCount: 1, fileName: "cached.md", createdAt: new Date().toISOString() },
      { key: "cache-key", importId: "import-1", chunkCount: -1, fileName: "cached.md", createdAt: new Date().toISOString() },
      { key: "cache-key", importId: "import-1", chunkCount: 1, fileName: null, createdAt: new Date().toISOString() },
      { key: "cache-key", importId: "import-1", chunkCount: 1, fileName: "cached.md", createdAt: false },
    ];

    for (const record of malformedRecords) {
      fs.writeFileSync(cachePath, JSON.stringify({ records: { "cache-key": record } }), "utf8");
      await expect(getValidDocumentCacheRecord("cache-key", () => true)).resolves.toBeNull();
    }
  });
});
