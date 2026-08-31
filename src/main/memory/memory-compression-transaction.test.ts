import { describe, expect, it, vi } from "vitest";
import { commitMemoryCompression, type CompressionTransactionDeps } from "./memory-compression-transaction";

function createDeps(events: string[]): CompressionTransactionDeps {
  return {
    createSummary: vi.fn(async () => {
      events.push("create-summary");
      return { id: "l2_summary" };
    }),
    addSummaryVector: vi.fn(async (_text, _l2Id, metadata) => {
      events.push(`add-vector:${String(metadata.isSummary)}`);
      return "rag_summary";
    }),
    markSummarySynced: vi.fn(async () => { events.push("mark-synced"); }),
    archiveSources: vi.fn(async () => { events.push("archive-sources"); }),
    restoreSources: vi.fn(async () => { events.push("restore-sources"); }),
    deactivateSummary: vi.fn(async () => { events.push("deactivate-summary"); }),
    deleteSummary: vi.fn(async () => { events.push("delete-summary"); }),
    deleteVectors: vi.fn(async (ids) => { events.push(`delete-vectors:${ids.join(",")}`); }),
    warn: vi.fn(),
  };
}

const input = {
  content: "用户喜欢菌菇类食物",
  triggerText: "我喜欢香菇",
  sourceConversationId: "conv",
  sources: [
    { id: "l2_a", ragId: "rag_a", status: "active" as const },
    { id: "l2_b", ragId: "rag_b", status: "active" as const },
  ],
};

describe("memory compression transaction", () => {
  it("syncs the summary before archiving sources and cleaning old vectors", async () => {
    const events: string[] = [];
    const deps = createDeps(events);

    const result = await commitMemoryCompression(input, deps);

    expect(result).toEqual({ summaryId: "l2_summary", ragId: "rag_summary" });
    expect(events).toEqual([
      "create-summary",
      "add-vector:true",
      "mark-synced",
      "archive-sources",
      "delete-vectors:rag_a,rag_b",
    ]);
    expect(deps.addSummaryVector).toHaveBeenCalledWith(
      input.content,
      "l2_summary",
      expect.objectContaining({ isSummary: true, subEntryIds: ["l2_a", "l2_b"] }),
    );
  });

  it("keeps source memories active when summary vector creation fails", async () => {
    const events: string[] = [];
    const deps = createDeps(events);
    vi.mocked(deps.addSummaryVector).mockRejectedValue(new Error("embedding failed"));

    await expect(commitMemoryCompression(input, deps)).rejects.toThrow("embedding failed");

    expect(deps.archiveSources).not.toHaveBeenCalled();
    expect(events).toEqual(["create-summary", "deactivate-summary", "delete-summary"]);
  });

  it("rolls back the summary and restores sources when archiving fails", async () => {
    const events: string[] = [];
    const deps = createDeps(events);
    vi.mocked(deps.archiveSources).mockImplementation(async () => {
      events.push("archive-sources");
      throw new Error("archive failed");
    });

    await expect(commitMemoryCompression(input, deps)).rejects.toThrow("archive failed");

    expect(events).toEqual([
      "create-summary",
      "add-vector:true",
      "mark-synced",
      "archive-sources",
      "deactivate-summary",
      "restore-sources",
      "delete-vectors:rag_summary",
      "delete-summary",
    ]);
  });

  it("does not fail a completed compression when stale-vector cleanup fails", async () => {
    const events: string[] = [];
    const deps = createDeps(events);
    vi.mocked(deps.deleteVectors).mockRejectedValue(new Error("cleanup failed"));

    await expect(commitMemoryCompression(input, deps)).resolves.toEqual({
      summaryId: "l2_summary",
      ragId: "rag_summary",
    });
    expect(deps.warn).toHaveBeenCalledWith("Failed to clean archived memory vectors", expect.any(Error));
  });
});
