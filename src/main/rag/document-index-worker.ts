import * as fs from "fs";
import * as path from "path";
import crypto from "node:crypto";
import { Worker, isMainThread, parentPort } from "worker_threads";
import { iterateDocumentChunks } from "./chunk";
import {
  createLocalEmbeddingProvider,
  createOpenAIEmbeddingProvider,
  type EmbeddingWorkerConfig,
} from "./embedding";
import { isBinary, isTextExt, isUnsupportedExt, SMALL_THRESHOLD } from "./file-ingest";
import type { DocumentIndexJobResult, QueuedDocumentIndexJob } from "./document-index-queue";

export type PreparedDocumentChunk = { text: string; index: number };

export type PreparedDocumentIndexResult =
  | { kind: "prepared-indexed"; name: string; textSha256: string; totalChunks: number }
  | Exclude<DocumentIndexJobResult, { kind: "indexed" }>;

type WorkerPreparedDocument = Extract<PreparedDocumentIndexResult, { kind: "prepared-indexed" }> & {
  text: string;
};
type WorkerPrepareFileResult = WorkerPreparedDocument | Exclude<PreparedDocumentIndexResult, { kind: "prepared-indexed" }>;

type WorkerStartMessage = { type: "start"; filePath: string; cancellationBuffer: SharedArrayBuffer };
type WorkerEmbedMessage = { type: "embed"; embedding: EmbeddingWorkerConfig };
type WorkerCancelMessage = { type: "cancel" };
type WorkerInboundMessage = WorkerStartMessage | WorkerEmbedMessage | WorkerCancelMessage;

export type WorkerOutboundMessage =
  | { type: "stage"; status: "reading" | "chunking"; completedChunks?: number; totalChunks?: number }
  | { type: "prepared"; result: Extract<PreparedDocumentIndexResult, { kind: "prepared-indexed" }> }
  | { type: "result"; result: Exclude<PreparedDocumentIndexResult, { kind: "prepared-indexed" }> }
  | { type: "progress"; completedChunks: number; totalChunks: number }
  | { type: "embedded-batch"; chunks: Array<PreparedDocumentChunk & { embedding: number[] }> }
  | { type: "completed" }
  | { type: "cancelled" }
  | { type: "error"; reason: string };

export interface DocumentIndexWorkerPort {
  postMessage(message: WorkerInboundMessage): void;
  on(event: "message" | "error" | "exit", listener: (...args: any[]) => void): unknown;
  terminate(): Promise<number>;
}

export type DocumentIndexWorkerRunnerDependencies = {
  createWorker: () => DocumentIndexWorkerPort;
  getCachedImport: (textSha256: string) => Promise<{ importId: string; chunkCount: number } | null>;
  getEmbeddingConfig: () => EmbeddingWorkerConfig;
  createImportId: () => string;
  persistPreparedBatch: (input: {
    fileName: string;
    importId: string;
    chunks: Array<PreparedDocumentChunk & { embedding: number[] }>;
  }) => Promise<void>;
  putCache: (input: { textSha256: string; fileName: string; importId: string; chunkCount: number }) => Promise<void>;
};

function cancelledResult(filePath: string): DocumentIndexJobResult {
  return { kind: "error", name: path.basename(filePath), reason: "cancelled" };
}

function errorResult(filePath: string, reason: string): DocumentIndexJobResult {
  return { kind: "error", name: path.basename(filePath), reason };
}

export function createDocumentIndexWorkerRunner(deps: DocumentIndexWorkerRunnerDependencies) {
  return async (job: QueuedDocumentIndexJob): Promise<DocumentIndexJobResult> => new Promise((resolve) => {
    const worker = deps.createWorker();
    const cancellationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const cancellation = new Int32Array(cancellationBuffer);
    let settled = false;
    let prepared: Extract<PreparedDocumentIndexResult, { kind: "prepared-indexed" }> | null = null;
    let importId: string | null = null;
    let persistedChunks = 0;
    let messageChain: Promise<void> = Promise.resolve();

    const finish = (result: DocumentIndexJobResult) => {
      if (settled) return;
      settled = true;
      prepared = null;
      unsubscribeCancellation();
      void worker.terminate();
      resolve(result);
    };
    const cancelWorker = () => {
      Atomics.store(cancellation, 0, 1);
      worker.postMessage({ type: "cancel" });
    };
    const unsubscribeCancellation = job.onCancel(cancelWorker);

    worker.on("message", (message: WorkerOutboundMessage) => {
      messageChain = messageChain.then(async () => {
        if (settled) return;
        if (message.type === "progress") {
          job.reportProgress({
            status: "embedding",
            completedChunks: message.completedChunks,
            totalChunks: message.totalChunks,
          });
          return;
        }
        if (message.type === "stage") {
          job.reportProgress({
            status: message.status,
            completedChunks: message.completedChunks,
            totalChunks: message.totalChunks,
          });
          return;
        }
        if (message.type === "cancelled") {
          finish(cancelledResult(job.input.filePath));
          return;
        }
        if (message.type === "error") {
          job.reportProgress({ status: "failed", reason: message.reason });
          finish(errorResult(job.input.filePath, message.reason));
          return;
        }
        if (message.type === "result") {
          job.reportProgress(message.result.kind === "unsupported"
            ? { status: "failed", reason: message.result.reason }
            : { status: "done" });
          finish(message.result);
          return;
        }
        if (message.type === "prepared") {
          prepared = message.result;
          if (job.cancelled) {
            finish(cancelledResult(job.input.filePath));
            return;
          }
          let cached: { importId: string; chunkCount: number } | null = null;
          try {
            cached = await deps.getCachedImport(prepared.textSha256);
          } catch (error) {
            console.warn("[RAG] document cache lookup failed:", error);
          }
          if (job.cancelled) {
            finish(cancelledResult(job.input.filePath));
            return;
          }
          if (cached) {
            job.reportProgress({ status: "cached", completedChunks: cached.chunkCount, totalChunks: cached.chunkCount });
            job.reportProgress({ status: "done", completedChunks: cached.chunkCount, totalChunks: cached.chunkCount });
            finish({ kind: "indexed", name: prepared.name, chunks: cached.chunkCount, importId: cached.importId, cached: true });
            return;
          }
          job.reportProgress({ status: "embedding", completedChunks: 0, totalChunks: prepared.totalChunks });
          worker.postMessage({ type: "embed", embedding: deps.getEmbeddingConfig() });
          return;
        }
        if (message.type === "embedded-batch") {
          if (!prepared || job.cancelled) {
            finish(cancelledResult(job.input.filePath));
            return;
          }
          importId ??= deps.createImportId();
          await deps.persistPreparedBatch({ fileName: prepared.name, importId, chunks: message.chunks });
          persistedChunks += message.chunks.length;
          if (job.cancelled) {
            finish(cancelledResult(job.input.filePath));
            return;
          }
          return;
        }
        if (message.type === "completed") {
          if (!prepared || !importId || job.cancelled) {
            finish(cancelledResult(job.input.filePath));
            return;
          }
          try {
            await deps.putCache({
              textSha256: prepared.textSha256,
              fileName: prepared.name,
              importId,
              chunkCount: persistedChunks,
            });
          } catch (error) {
            console.warn("[RAG] document cache write failed:", error);
          }
          if (job.cancelled) {
            finish(cancelledResult(job.input.filePath));
            return;
          }
          job.reportProgress({ status: "done", completedChunks: persistedChunks, totalChunks: persistedChunks });
          finish({ kind: "indexed", name: prepared.name, chunks: persistedChunks, importId });
        }
      }).catch((error) => finish(errorResult(job.input.filePath, error instanceof Error ? error.message : String(error))));
    });
    worker.on("error", (error: Error) => finish(errorResult(job.input.filePath, error.message)));
    worker.on("exit", (code: number) => {
      if (!settled && code !== 0) finish(errorResult(job.input.filePath, `document worker exited with code ${code}`));
    });
    worker.postMessage({ type: "start", filePath: job.input.filePath, cancellationBuffer });
  });
}

function createDefaultRunnerDependencies(): DocumentIndexWorkerRunnerDependencies {
  return {
    createWorker: () => new Worker(__filename),
    getCachedImport: async (textSha256) => {
      const cache = require("./document-cache") as typeof import("./document-cache");
      const rag = require("./index") as typeof import("./index");
      const identity = await cache.buildDocumentCacheIdentityFromTextSha(textSha256);
      return cache.getValidDocumentCacheRecord(cache.createDocumentCacheKey(identity), rag.hasImportedDocumentChunks);
    },
    getEmbeddingConfig: () => {
      const embedding = require("./embedding") as typeof import("./embedding");
      return embedding.getEmbeddingWorkerConfig();
    },
    createImportId: () => {
      const id = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2, 8);
      return `import-${Date.now()}-${id}`;
    },
    persistPreparedBatch: async ({ fileName, importId, chunks }) => {
      const rag = require("./index") as typeof import("./index");
      await rag.appendPreparedDocumentBatch(fileName, importId, chunks.map((chunk) => ({
        text: chunk.text,
        chunkIndex: chunk.index,
        embedding: chunk.embedding,
      })));
    },
    putCache: async ({ textSha256, fileName, importId, chunkCount }) => {
      const cache = require("./document-cache") as typeof import("./document-cache");
      const identity = await cache.buildDocumentCacheIdentityFromTextSha(textSha256);
      await cache.putDocumentCacheRecord({
        key: cache.createDocumentCacheKey(identity),
        importId,
        chunkCount,
        fileName,
        createdAt: new Date().toISOString(),
      });
    },
  };
}

export const runDocumentIndexJob = createDocumentIndexWorkerRunner(createDefaultRunnerDependencies());

export async function retrieveQueuedDocumentChunks(
  result: Extract<DocumentIndexJobResult, { kind: "indexed" }>,
  query: string,
): Promise<Awaited<ReturnType<typeof import("./index").searchImportedDocumentChunksForImportIds>> | undefined> {
  if (!query.trim()) return undefined;
  const rag = require("./index") as typeof import("./index");
  return rag.searchImportedDocumentChunksForImportIds(query, [result.importId]);
}

function countDocumentChunks(text: string, source: string): number {
  let count = 0;
  for (const chunk of iterateDocumentChunks(text, source)) {
    count = chunk.index + 1;
  }
  return count;
}

function prepareFile(filePath: string): WorkerPrepareFileResult {
  const name = path.basename(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    return { kind: "unsupported", name, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!stat.isFile()) return { kind: "unsupported", name, reason: "不是文件" };

  const ext = path.extname(filePath).toLowerCase();
  if (isUnsupportedExt(ext)) return { kind: "unsupported", name, reason: `暂不支持的文件格式 ${ext}（MVP-0 仅支持文本）` };

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    return { kind: "unsupported", name, reason: error instanceof Error ? error.message : String(error) };
  }
  if (isBinary(buffer)) return { kind: "unsupported", name, reason: "二进制文件，暂不支持" };
  const text = buffer.toString("utf-8");
  if (!text.trim()) return { kind: "empty", name };
  if (text.length <= SMALL_THRESHOLD) return { kind: "text", name, text };
  return {
    kind: "prepared-indexed",
    name,
    textSha256: crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8").digest("hex"),
    totalChunks: countDocumentChunks(text, "doc_" + name),
    text,
  };
}

function isCancelled(cancellation: Int32Array | null): boolean {
  return cancellation !== null && Atomics.load(cancellation, 0) === 1;
}

function createWorkerEmbeddingProvider(config: EmbeddingWorkerConfig) {
  if (config.provider === "openai-compat") {
    return createOpenAIEmbeddingProvider(config.baseUrl, config.apiKey, config.model);
  }
  return createLocalEmbeddingProvider(config.modelKey);
}

async function runWorkerThread(): Promise<void> {
  const port = parentPort;
  if (!port) return;
  let prepared: WorkerPreparedDocument | null = null;
  let cancellation: Int32Array | null = null;

  port.on("message", (message: WorkerInboundMessage) => {
    void (async () => {
      if (message.type === "cancel") return;
      if (message.type === "start") {
        cancellation = new Int32Array(message.cancellationBuffer);
        port.postMessage({ type: "stage", status: "reading" } satisfies WorkerOutboundMessage);
        const result = prepareFile(message.filePath);
        if (isCancelled(cancellation)) {
          port.postMessage({ type: "cancelled" } satisfies WorkerOutboundMessage);
        } else if (result.kind === "prepared-indexed") {
          prepared = result;
          const preparedResult: Extract<PreparedDocumentIndexResult, { kind: "prepared-indexed" }> = {
            kind: "prepared-indexed",
            name: result.name,
            textSha256: result.textSha256,
            totalChunks: result.totalChunks,
          };
          port.postMessage({
            type: "stage",
            status: "chunking",
            completedChunks: result.totalChunks,
            totalChunks: result.totalChunks,
          } satisfies WorkerOutboundMessage);
          port.postMessage({ type: "prepared", result: preparedResult } satisfies WorkerOutboundMessage);
        } else {
          port.postMessage({ type: "result", result } satisfies WorkerOutboundMessage);
        }
        return;
      }
      if (!prepared) throw new Error("document worker has no prepared document");
      const provider = createWorkerEmbeddingProvider(message.embedding);
      if (!provider) throw new Error("Embedding provider is not available");
      const batchSize = 16;
      let completedChunks = 0;
      let batch: Array<PreparedDocumentChunk & { embedding: number[] }> = [];
      for (const chunk of iterateDocumentChunks(prepared.text, "doc_" + prepared.name)) {
        if (isCancelled(cancellation)) {
          prepared = null;
          port.postMessage({ type: "cancelled" } satisfies WorkerOutboundMessage);
          return;
        }
        const embedding = await provider.embed(chunk.text);
        if (isCancelled(cancellation)) {
          prepared = null;
          port.postMessage({ type: "cancelled" } satisfies WorkerOutboundMessage);
          return;
        }
        batch.push({ text: chunk.text, index: chunk.index, embedding });
        completedChunks += 1;
        if (batch.length === batchSize || completedChunks === prepared.totalChunks) {
          port.postMessage({ type: "embedded-batch", chunks: batch } satisfies WorkerOutboundMessage);
          batch = [];
        }
        port.postMessage({
          type: "progress",
          completedChunks,
          totalChunks: prepared.totalChunks,
        } satisfies WorkerOutboundMessage);
      }
      prepared = null;
      port.postMessage({ type: "completed" } satisfies WorkerOutboundMessage);
    })().catch((error) => {
      port.postMessage({
        type: "error",
        reason: error instanceof Error ? error.message : String(error),
      } satisfies WorkerOutboundMessage);
    });
  });
}

if (!isMainThread) void runWorkerThread();
