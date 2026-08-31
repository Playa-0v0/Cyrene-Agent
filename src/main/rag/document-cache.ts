import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { DOCUMENT_CHUNK_OVERLAP, DOCUMENT_CHUNK_SIZE } from "./chunk";
import { getEmbeddingProviderIdentity } from "./embedding";

const CHUNK_STRATEGY_VERSION = "document-chunks-v1";

export type DocumentCacheIdentity = {
  textSha256: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingEndpoint?: string;
  dimensions: number;
  chunkStrategyVersion: string;
  chunkSize: number;
  chunkOverlap: number;
};

export type DocumentCacheRecord = {
  key: string;
  importId: string;
  chunkCount: number;
  fileName: string;
  createdAt: string;
};

type DocumentCacheFile = {
  records: Record<string, unknown>;
};

export function normalizeDocumentTextForCache(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function createDocumentCacheKey(identity: DocumentCacheIdentity): string {
  return sha256(JSON.stringify(identity));
}

export async function buildDocumentCacheIdentity(text: string): Promise<DocumentCacheIdentity> {
  return buildDocumentCacheIdentityFromTextSha(sha256(normalizeDocumentTextForCache(text)));
}

export async function buildDocumentCacheIdentityFromTextSha(textSha256: string): Promise<DocumentCacheIdentity> {
  const provider = await getEmbeddingProviderIdentity();
  return {
    textSha256,
    embeddingProvider: provider.provider,
    embeddingModel: provider.model,
    embeddingEndpoint: provider.endpoint,
    dimensions: provider.dimensions,
    chunkStrategyVersion: CHUNK_STRATEGY_VERSION,
    chunkSize: DOCUMENT_CHUNK_SIZE,
    chunkOverlap: DOCUMENT_CHUNK_OVERLAP,
  };
}

function cachePath(): string {
  return path.join(app.getPath("userData"), "rag-data", "document-cache.json");
}

async function readDocumentCache(): Promise<DocumentCacheFile> {
  try {
    const raw = await fs.readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DocumentCacheFile>;
    if (!parsed.records || typeof parsed.records !== "object" || Array.isArray(parsed.records)) {
      return { records: {} };
    }
    return { records: parsed.records };
  } catch {
    return { records: {} };
  }
}

async function writeDocumentCache(cache: DocumentCacheFile): Promise<void> {
  const target = cachePath();
  const temporary = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(cache, null, 2), "utf8");
  await fs.rename(temporary, target);
}

function isDocumentCacheRecord(value: unknown): value is DocumentCacheRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string"
    && typeof record.importId === "string"
    && typeof record.fileName === "string"
    && typeof record.createdAt === "string"
    && typeof record.chunkCount === "number"
    && Number.isFinite(record.chunkCount)
    && record.chunkCount >= 0;
}

export async function getDocumentCacheRecord(identity: DocumentCacheIdentity): Promise<DocumentCacheRecord | null> {
  return getDocumentCacheRecordByKey(createDocumentCacheKey(identity));
}

export async function getDocumentCacheRecordByKey(key: string): Promise<DocumentCacheRecord | null> {
  const cache = await readDocumentCache();
  const record = cache.records[key];
  return isDocumentCacheRecord(record) && record.key === key ? record : null;
}

export async function putDocumentCacheRecord(record: DocumentCacheRecord): Promise<void> {
  const cache = await readDocumentCache();
  cache.records[record.key] = record;
  await writeDocumentCache(cache);
}

export async function getValidDocumentCacheRecord(
  key: string,
  hasImportId: (importId: string) => boolean,
): Promise<DocumentCacheRecord | null> {
  const record = await getDocumentCacheRecordByKey(key);
  if (!record) return null;
  return hasImportId(record.importId) ? record : null;
}
