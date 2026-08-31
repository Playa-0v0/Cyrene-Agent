import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getEmbeddingProviderIdentity, type EmbeddingProvider } from "./rag/embedding";
import { buildStickerEmbeddingIndex, type StickerEmbeddingEntry } from "./sticker-embedder";

type StickerDescriptionInput = Record<string, { phrases: string[] }>;

type StickerEmbeddingCacheFile = {
  schemaVersion: 1;
  key: string;
  entries: StickerEmbeddingEntry[];
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
  return path.join(cacheDir, "sticker-embedding-cache.json");
}

function normalizeStickerDescriptions(
  builtIn: StickerDescriptionInput,
  userStickers: StickerDescriptionInput,
): Array<{ scope: "built-in" | "user"; id: string; phrases: string[] }> {
  const normalize = (scope: "built-in" | "user", values: StickerDescriptionInput) =>
    Object.entries(values)
      .map(([id, value]) => ({
        scope,
        id,
        phrases: Array.isArray(value.phrases) ? value.phrases.map((phrase) => String(phrase)) : [],
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  return [...normalize("built-in", builtIn), ...normalize("user", userStickers)];
}

async function buildStickerEmbeddingCacheKey(
  builtIn: StickerDescriptionInput,
  userStickers: StickerDescriptionInput,
): Promise<string> {
  const provider = await getEmbeddingProviderIdentity();
  return sha256(JSON.stringify({
    schemaVersion: 1,
    provider,
    stickers: normalizeStickerDescriptions(builtIn, userStickers),
  }));
}

function isValidCacheFile(value: unknown, expectedKey: string): value is StickerEmbeddingCacheFile {
  if (!value || typeof value !== "object") return false;
  const cache = value as StickerEmbeddingCacheFile;
  return cache.schemaVersion === 1
    && cache.key === expectedKey
    && typeof cache.createdAt === "string"
    && Array.isArray(cache.entries)
    && cache.entries.every((entry) =>
      entry
      && typeof entry.id === "string"
      && Array.isArray(entry.embedding)
      && entry.embedding.every((n) => typeof n === "number" && Number.isFinite(n))
    );
}

function readCache(cachePath: string, expectedKey: string): StickerEmbeddingEntry[] | null {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as unknown;
    if (!isValidCacheFile(parsed, expectedKey)) return null;
    return parsed.entries;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, key: string, entries: StickerEmbeddingEntry[]): void {
  const data: StickerEmbeddingCacheFile = {
    schemaVersion: 1,
    key,
    entries,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, cachePath);
}

export async function buildCachedStickerEmbeddingIndex(
  provider: EmbeddingProvider,
  builtIn: StickerDescriptionInput,
  userStickers: StickerDescriptionInput,
  cacheDir = defaultCacheDir(),
): Promise<StickerEmbeddingEntry[]> {
  const cachePath = cacheFilePath(cacheDir);
  const key = await buildStickerEmbeddingCacheKey(builtIn, userStickers);
  const cached = readCache(cachePath, key);
  if (cached) return cached;

  const entries = await buildStickerEmbeddingIndex(provider, builtIn, userStickers);
  try {
    writeCache(cachePath, key, entries);
  } catch (error) {
    console.warn("[StickerEmbedding] cache write failed:", error);
  }
  return entries;
}
