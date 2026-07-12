import { describe, expect, it } from "vitest";
import { chunkText, iterateDocumentChunks } from "./chunk";

describe("document chunking", () => {
  it("keeps the trailing content when a short tail is merged into the previous chunk", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";

    const chunks = chunkText(text, "doc_test", 6, 2);

    expect(chunks.at(-1)?.text).toContain("lambda mu");
  });

  it("iterates chunks with the same public shape as chunkText", () => {
    const text = "# Title\nalpha beta gamma delta epsilon zeta eta theta";

    expect(Array.from(iterateDocumentChunks(text, "doc_test", 6, 2))).toEqual(chunkText(text, "doc_test", 6, 2));
  });
});
