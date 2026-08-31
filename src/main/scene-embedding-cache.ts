import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getEmbeddingProviderIdentity, type EmbeddingProvider } from "./rag/embedding";
import { buildSceneIndex, SCENE_EXAMPLES, type SceneIndex } from "./scene-embedder";

type SceneEmbeddingCacheFile = {
  schemaVersion: 1;
  key: string;
  index: SceneIndex;
  createdAt: string;
};

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function defaultCacheDir(): string {
  const { app } = require("electron") as typeof import("electron");
  return app.getPath("userData");
}

function cacheFilePath(cacheDir: string): string {
  return path.join(cacheDir, "scene-embedding-cache.json");
}

async function buildSceneEmbeddingCacheKey(): Promise<string> {
  const provider = await getEmbeddingProviderIdentity();
  return sha256(JSON.stringify({
    schemaVersion: 1,
    provider,
    scenes: Object.entries(SCENE_EXAMPLES)
      .map(([scene, examples]) => ({ scene, examples }))
      .sort((a, b) => a.scene.localeCompare(b.scene)),
  }));
}

function isSceneIndex(value: unknown): value is SceneIndex {
  if (!value || typeof value !== "object") return false;
  const scenes = (value as SceneIndex).scenes;
  return Boolean(scenes)
    && typeof scenes === "object"
    && Object.values(scenes).every((vectors) =>
      Array.isArray(vectors)
      && vectors.every((vector) =>
        Array.isArray(vector)
        && vector.every((n) => typeof n === "number" && Number.isFinite(n))
      )
    );
}

function isValidCacheFile(value: unknown, expectedKey: string): value is SceneEmbeddingCacheFile {
  if (!value || typeof value !== "object") return false;
  const cache = value as SceneEmbeddingCacheFile;
  return cache.schemaVersion === 1
    && cache.key === expectedKey
    && typeof cache.createdAt === "string"
    && isSceneIndex(cache.index);
}

function readCache(cachePath: string, expectedKey: string): SceneIndex | null {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as unknown;
    if (!isValidCacheFile(parsed, expectedKey)) return null;
    return parsed.index;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, key: string, index: SceneIndex): void {
  const data: SceneEmbeddingCacheFile = {
    schemaVersion: 1,
    key,
    index,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, cachePath);
}

export async function buildCachedSceneIndex(
  provider: EmbeddingProvider,
  cacheDir = defaultCacheDir(),
): Promise<SceneIndex> {
  const cachePath = cacheFilePath(cacheDir);
  const key = await buildSceneEmbeddingCacheKey();
  const cached = readCache(cachePath, key);
  if (cached) return cached;

  const index = await buildSceneIndex(provider);
  try {
    writeCache(cachePath, key, index);
  } catch (error) {
    console.warn("[SceneEmbedding] cache write failed:", error);
  }
  return index;
}
