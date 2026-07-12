import { describe, expect, it, vi } from "vitest";
import {
  createDocumentIndexQueue,
  type DocumentIndexJobResult,
  type DocumentIndexRunner,
} from "./document-index-queue";

function createControlledDocumentRunner(): {
  runner: DocumentIndexRunner;
  startedJobs: () => string[];
  finishCurrent: (result: DocumentIndexJobResult) => void;
} {
  const started: string[] = [];
  let finish: ((result: DocumentIndexJobResult) => void) | null = null;

  return {
    runner: (job) => new Promise<DocumentIndexJobResult>((resolve) => {
      started.push(job.input.filePath);
      finish = resolve;
    }),
    startedJobs: () => started,
    finishCurrent: (result) => {
      if (!finish) throw new Error("No active document index job");
      const resolve = finish;
      finish = null;
      resolve(result);
    },
  };
}

describe("document index queue", () => {
  it("runs document index jobs one at a time in FIFO order", async () => {
    const controlled = createControlledDocumentRunner();
    const queue = createDocumentIndexQueue({ runner: controlled.runner });

    const first = queue.enqueue({ filePath: "first.md", query: "first", onProgress: vi.fn() });
    const second = queue.enqueue({ filePath: "second.md", query: "second", onProgress: vi.fn() });

    expect(controlled.startedJobs()).toEqual(["first.md"]);
    controlled.finishCurrent({ kind: "indexed", name: "first.md", chunks: 2, importId: "import-first" });
    await first.promise;

    expect(controlled.startedJobs()).toEqual(["first.md", "second.md"]);
    controlled.finishCurrent({ kind: "indexed", name: "second.md", chunks: 3, importId: "import-second" });
    await second.promise;
  });

  it("cancels a queued job before it starts", async () => {
    const controlled = createControlledDocumentRunner();
    const queue = createDocumentIndexQueue({ runner: controlled.runner });

    const first = queue.enqueue({ filePath: "first.md", query: "first", onProgress: vi.fn() });
    const second = queue.enqueue({ filePath: "second.md", query: "second", onProgress: vi.fn() });

    expect(queue.cancel(second.jobId)).toBe(true);
    await expect(second.promise).resolves.toMatchObject({ kind: "error", reason: "cancelled" });

    controlled.finishCurrent({ kind: "indexed", name: "first.md", chunks: 2, importId: "import-first" });
    await first.promise;
    expect(controlled.startedJobs()).toEqual(["first.md"]);
  });

  it("reports active, pending, and listener counts for memory diagnostics", async () => {
    const controlled = createControlledDocumentRunner();
    const queue = createDocumentIndexQueue({ runner: controlled.runner });

    const first = queue.enqueue({ filePath: "first.md", query: "first", onProgress: vi.fn() });
    const second = queue.enqueue({ filePath: "second.md", query: "second", onProgress: vi.fn() });

    expect(queue.getStats()).toMatchObject({
      activeJobId: first.jobId,
      pendingJobs: 1,
      cancellationListeners: 0,
    });

    queue.cancel(first.jobId);
    expect(queue.getStats()).toMatchObject({
      activeJobId: first.jobId,
      pendingJobs: 1,
      cancellationListeners: 0,
    });

    controlled.finishCurrent({ kind: "indexed", name: "first.md", chunks: 2, importId: "import-first" });
    await first.promise;
    expect(queue.getStats()).toMatchObject({
      activeJobId: second.jobId,
      pendingJobs: 0,
    });
  });

  it("marks an active job cancelled after its runner finishes", async () => {
    const controlled = createControlledDocumentRunner();
    const queue = createDocumentIndexQueue({ runner: controlled.runner });

    const job = queue.enqueue({ filePath: "large.md", query: "large", onProgress: vi.fn() });

    expect(queue.cancel(job.jobId)).toBe(true);
    controlled.finishCurrent({ kind: "indexed", name: "large.md", chunks: 4, importId: "import-large" });

    await expect(job.promise).resolves.toMatchObject({ kind: "error", reason: "cancelled" });
  });
});
