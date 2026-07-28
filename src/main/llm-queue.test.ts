import { describe, expect, it, vi } from "vitest";
import { enqueueLLMTask } from "./llm-queue";

describe("enqueueLLMTask", () => {
  it("can run a background observer without adding terminal noise", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await enqueueLLMTask("心情观察器", async () => "ok", { log: false });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("can disable the automatic rate-limit retry for one-shot extractors", async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockRejectedValue(new Error("HTTP 429 rate limit"));
    try {
      const result = enqueueLLMTask("one-shot", task, {
        log: false,
        retryRateLimit: false,
      });
      await vi.runAllTimersAsync();
      await expect(result).rejects.toThrow("429");
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
