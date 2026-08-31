import { IPC } from "../../shared/ipc-channels";
import type { ImportedDocumentChunk } from "./index";
import type { Attachment } from "./file-ingest";
import type { DocumentIndexJobResult, EnqueueDocumentIndexJobInput } from "./document-index-queue";

type Sender = { send: (channel: string, payload: unknown) => void };

export type DocumentIndexIpcResult = Attachment | {
  kind: "error";
  name: string;
  filePath: string;
  reason: string;
};

export async function processDocumentIndexRequest(input: {
  filePaths: string[];
  query: string;
  sender: Sender;
  enqueue: (input: EnqueueDocumentIndexJobInput) => Promise<DocumentIndexJobResult>;
  retrieve: (result: Extract<DocumentIndexJobResult, { kind: "indexed" }>, query: string) => Promise<ImportedDocumentChunk[] | undefined>;
}): Promise<DocumentIndexIpcResult[]> {
  const results: DocumentIndexIpcResult[] = [];
  for (const filePath of input.filePaths) {
    const result = await input.enqueue({
      filePath,
      query: input.query,
      onProgress: (progress) => input.sender.send(IPC.CHAT_DOCUMENT_INDEX_PROGRESS, progress),
    });
    if (result.kind === "indexed") {
      try {
        const retrievedChunks = await input.retrieve(result, input.query);
        results.push({ ...result, filePath, retrievedChunks });
      } catch (error) {
        results.push({
          kind: "indexed",
          name: result.name,
          chunks: result.chunks,
          importId: result.importId,
          cached: result.cached,
          filePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (result.kind === "unsupported") {
      results.push({ ...result, filePath, status: "error" });
    } else {
      results.push({ ...result, filePath });
    }
  }
  return results;
}
