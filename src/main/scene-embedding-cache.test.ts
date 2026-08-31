import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./rag/embedding";
import { buildCachedSceneIndex } from "./scene-embedding-cache";

const { identity } = vi.hoisted(() => ({
  identity: {
    value: {
      provider: "local",
      model: "Xenova/bge-m3",
      dimensions: 1024,
    },
  },
}));

vi.mock("./rag/embedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rag/embedding")>()),
  getEmbeddingProviderIdentity: async () => identity.value,
}));

function provider(): EmbeddingProvider {
  return {
    name: "scene-provider",
    dims: 2,
    embed: vi.fn(),
    embedBatch: vi.fn(async (texts: string[]) => texts.map((_text, index) => [index + 1, index + 2])),
  };
}

describe("scene embedding cache", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-scene-cache-"));
    identity.value = {
      provider: "local",
      model: "Xenova/bge-m3",
      dimensions: 1024,
    };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reuses a completed scene index without embedding examples again", async () => {
    const firstProvider = provider();
    const first = await buildCachedSceneIndex(firstProvider, dir);

    expect(Object.keys(first.scenes).length).toBeGreaterThan(0);
    expect(firstProvider.embedBatch).toHaveBeenCalled();

    const secondProvider = provider();
    const second = await buildCachedSceneIndex(secondProvider, dir);

    expect(second).toEqual(first);
    expect(secondProvider.embedBatch).not.toHaveBeenCalled();
  });

  it("invalidates the scene index cache when the embedding model changes", async () => {
    await buildCachedSceneIndex(provider(), dir);

    identity.value = {
      ...identity.value,
      model: "Xenova/different-model",
      dimensions: 768,
    };
    const changedProvider = provider();
    await buildCachedSceneIndex(changedProvider, dir);

    expect(changedProvider.embedBatch).toHaveBeenCalled();
  });
});
