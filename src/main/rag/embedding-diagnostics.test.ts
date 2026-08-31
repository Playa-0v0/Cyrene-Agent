import { describe, expect, it } from "vitest";
import { getEmbeddingDiagnostics, resetEmbeddingProvider } from "./embedding";

describe("embedding diagnostics", () => {
  it("reports model and pipeline init counters without loading a model", () => {
    resetEmbeddingProvider();

    expect(getEmbeddingDiagnostics()).toMatchObject({
      currentModelKey: "bgem3",
      cachedPipelineKeys: [],
      loadingPipelineKeys: [],
      localPipelineInitCount: 0,
    });
  });
});
