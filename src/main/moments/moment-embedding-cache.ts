// Moments 官方素材的 embedding 索引缓存（照 sticker-embedding-cache.ts 的 sha256 模式）。
//
// 与贴纸缓存完全独立（独立文件 moment-embedding-cache.json、独立 key 构成）：
// 复用底层模式但不共享领域模型——素材增删或 provider 换代时各自失效互不影响。

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getEmbeddingProviderIdentity, type EmbeddingProvider } from "../rag/embedding";
import { BUILT_IN_MOMENT_ASSET_DESCRIPTIONS } from "./moment-asset-descriptions";
import type { MomentAssetEmbeddingEntry } from "./moment-media-matcher";

type MomentEmbeddingCacheFile = {
  schemaVersion: 1;
  key: string;
  entries: MomentAssetEmbeddingEntry[];
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
  return path.join(cacheDir, "moment-embedding-cache.json");
}

function normalizeAssetDescriptions(
  descriptions: Record<string, { id: string; phrases: string[]; file: string }>,
): Array<{ id: string; phrases: string[]; file: string }> {
  return Object.values(descriptions)
    .map((value) => ({
      id: value.id,
      phrases: Array.isArray(value.phrases) ? value.phrases.map((phrase) => String(phrase)) : [],
      file: String(value.file),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function buildMomentCacheKey(
  descriptions: Record<string, { id: string; phrases: string[]; file: string }>,
): Promise<string> {
  const provider = await getEmbeddingProviderIdentity();
  return sha256(JSON.stringify({
    schemaVersion: 1,
    provider,
    assets: normalizeAssetDescriptions(descriptions),
  }));
}

function isValidCacheFile(value: unknown, expectedKey: string): value is MomentEmbeddingCacheFile {
  if (!value || typeof value !== "object") return false;
  const cache = value as MomentEmbeddingCacheFile;
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

function readCache(cachePath: string, expectedKey: string): MomentAssetEmbeddingEntry[] | null {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as unknown;
    if (!isValidCacheFile(parsed, expectedKey)) return null;
    return parsed.entries;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, key: string, entries: MomentAssetEmbeddingEntry[]): void {
  const data: MomentEmbeddingCacheFile = {
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

/** 构建官方素材描述的 embedding 索引：phrases 拼接后批量转向量。 */
export async function buildMomentAssetEmbeddingIndex(
  provider: EmbeddingProvider,
  descriptions: Record<string, { phrases: string[] }>,
): Promise<MomentAssetEmbeddingEntry[]> {
  const ids = Object.keys(descriptions);
  if (ids.length === 0) return [];
  const embeddings = await provider.embedBatch(ids.map((id) => descriptions[id].phrases.join("，")));
  return ids.map((id, i) => ({ id, embedding: embeddings[i] }));
}

/** 带缓存版：key 不匹配（素材或 provider 变了）时重建并覆盖。 */
export async function buildCachedMomentAssetEmbeddingIndex(
  provider: EmbeddingProvider,
  cacheDir = defaultCacheDir(),
): Promise<MomentAssetEmbeddingEntry[]> {
  const cachePath = cacheFilePath(cacheDir);
  const key = await buildMomentCacheKey(BUILT_IN_MOMENT_ASSET_DESCRIPTIONS);
  const cached = readCache(cachePath, key);
  if (cached) return cached;

  const entries = await buildMomentAssetEmbeddingIndex(provider, BUILT_IN_MOMENT_ASSET_DESCRIPTIONS);
  try {
    writeCache(cachePath, key, entries);
  } catch (error) {
    console.warn("[Moments] embedding cache write failed:", error);
  }
  return entries;
}