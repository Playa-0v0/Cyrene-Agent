import { describe, expect, it, vi } from "vitest";
import {
  createDocumentIndexWorkerRunner,
  type DocumentIndexWorkerPort,
} from "./document-index-worker";
import type { QueuedDocumentIndexJob } from "./document-index-queue";

function createControlledWorker(): {
  worker: DocumentIndexWorkerPort;
  emit: (message: unknown) => void;
  posted: unknown[];
} {
  const posted: unknown[] = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    worker: {
      postMessage: (message) => { posted.push(message); },
      on: (event, listener) => {
        const entries = listeners.get(event) ?? [];
        entries.push(listener);
        listeners.set(event, entries);
      },
      terminate: vi.fn().mockResolvedValue(0),
    },
    emit: (message) => listeners.get("message")?.forEach((listener) => listener(message)),
    posted,
  };
}

function createJob(): QueuedDocumentIndexJob & { cancel: () => void } {
  let cancellationListener: (() => void) | undefined;
  const job: QueuedDocumentIndexJob & { cancel: () => void } = {
    id: "job-1",
    input: { filePath: "large.md", query: "summarize", onProgress: vi.fn() },
    cancelled: false,
    reportProgress: vi.fn(),
    onCancel: (listener) => {
      cancellationListener = listener;
      return () => { cancellationListener = undefined; };
    },
    cancel: () => {
      job.cancelled = true;
      cancellationListener?.();
    },
  };
  return job;
}

describe("document index worker runner", () => {
  it("persists embedding batches under one import and caches only after completion", async () => {
    const controlled = createControlledWorker();
    const persistPreparedBatch = vi.fn().mockResolvedValue(undefined);
    const putCache = vi.fn().mockResolvedValue(undefined);
    const runner = createDocumentIndexWorkerRunner({
      createWorker: () => controlled.worker,
      getCachedImport: vi.fn().mockResolvedValue(null),
      getEmbeddingConfig: () => ({ provider: "local", modelKey: "minilm" }),
      createImportId: () => "import-batched",
      persistPreparedBatch,
      putCache,
    });
    const job = createJob();
    const running = runner(job);
    controlled.emit({ type: "prepared", result: {
      kind: "prepared-indexed", name: "large.md", textSha256: "hash",
      totalChunks: 3,
    } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controlled.emit({ type: "embedded-batch", chunks: [{ text: "first", index: 0, embedding: [1, 0] }] });
    controlled.emit({ type: "embedded-batch", chunks: [{ text: "second", index: 1, embedding: [0, 1] }, { text: "third", index: 2, embedding: [1, 1] }] });
    controlled.emit({ type: "completed" });

    await expect(running).resolves.toEqual({ kind: "indexed", name: "large.md", chunks: 3, importId: "import-batched" });
    expect(persistPreparedBatch).toHaveBeenCalledTimes(2);
    expect(persistPreparedBatch).toHaveBeenNthCalledWith(1, expect.objectContaining({ importId: "import-batched", chunks: [{ text: "first", index: 0, embedding: [1, 0] }] }));
    expect(persistPreparedBatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ importId: "import-batched" }));
    expect(putCache).toHaveBeenCalledWith({ textSha256: "hash", fileName: "large.md", importId: "import-batched", chunkCount: 3 });
  });

  it("cancels active preparation before vector or cache persistence", async () => {
    const controlled = createControlledWorker();
    const persistPreparedBatch = vi.fn();
    const putCache = vi.fn();
    const runner = createDocumentIndexWorkerRunner({
      createWorker: () => controlled.worker,
      getCachedImport: vi.fn().mockResolvedValue(null),
      getEmbeddingConfig: () => ({ provider: "local", modelKey: "minilm" }),
      createImportId: () => "import-test",
      persistPreparedBatch,
      putCache,
    });
    const job = createJob();

    const running = runner(job);
    const prepared = {
      kind: "prepared-indexed",
      name: "large.md",
      textSha256: "hash",
      totalChunks: 2,
    };
    controlled.emit({ type: "prepared", result: prepared });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controlled.posted).toContainEqual({ type: "embed", embedding: { provider: "local", modelKey: "minilm" } });

    controlled.emit({ type: "progress", completedChunks: 1, totalChunks: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(job.reportProgress).toHaveBeenCalledWith(expect.objectContaining({
      status: "embedding",
      completedChunks: 1,
      totalChunks: 2,
    }));

    job.cancel();
    expect(controlled.posted).toContainEqual({ type: "cancel" });
    controlled.emit({ type: "cancelled" });

    await expect(running).resolves.toMatchObject({ kind: "error", reason: "cancelled" });
    expect(persistPreparedBatch).not.toHaveBeenCalled();
    expect(putCache).not.toHaveBeenCalled();
  });

  it("does not require prepared worker messages to carry chunk text into main", async () => {
    const controlled = createControlledWorker();
    const runner = createDocumentIndexWorkerRunner({
      createWorker: () => controlled.worker,
      getCachedImport: vi.fn().mockResolvedValue(null),
      getEmbeddingConfig: () => ({ provider: "local", modelKey: "minilm" }),
      createImportId: () => "import-lightweight",
      persistPreparedBatch: vi.fn().mockResolvedValue(undefined),
      putCache: vi.fn().mockResolvedValue(undefined),
    });
    const job = createJob();
    const running = runner(job);

    controlled.emit({ type: "prepared", result: { kind: "prepared-indexed", name: "huge.md", textSha256: "hash", totalChunks: 42 } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(job.reportProgress).toHaveBeenCalledWith({ status: "embedding", completedChunks: 0, totalChunks: 42 });
    expect(controlled.posted).toContainEqual({ type: "embed", embedding: { provider: "local", modelKey: "minilm" } });

    controlled.emit({ type: "embedded-batch", chunks: [{ text: "only batch payload crosses to main", index: 0, embedding: [1] }] });
    controlled.emit({ type: "completed" });

    await expect(running).resolves.toEqual({ kind: "indexed", name: "huge.md", chunks: 1, importId: "import-lightweight" });
  });
});
