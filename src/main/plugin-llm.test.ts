import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "./services/llm/llm-client";
import type { ModelSettings } from "./settings/model-settings";
import { pluginGenerateText, type EnqueuePluginLlmTask } from "./plugin-llm";

function settings(patch: Partial<ModelSettings> = {}): ModelSettings {
  return {
    mode: "auto",
    provider: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-mini",
    apiKey: "secret",
    explicitTransport: "openai",
    perProvider: {},
    runtimeSync: "off",
    stickerEnabled: true,
    stickerSize: "standard",
    stickerSimilarityThreshold: 0.55,
    chatRequestTimeoutSec: 300,
    citaRepairBudgetSec: 8,
    rerankerMode: "none",
    embeddingModel: "bgem3",
    multimodal: false,
    contextWindowTokens: 128000,
    ...patch,
  };
}

function harness() {
  const chatNonStream = vi.fn(async () => ({
    text: "generated text",
    finishReason: "stop",
  }));
  const llmClient = { chatNonStream } as unknown as LlmClient;
  const labels: string[] = [];
  const enqueueTask: EnqueuePluginLlmTask = async (label, task) => {
    labels.push(label);
    return task();
  };
  return { chatNonStream, llmClient, enqueueTask, labels };
}

describe("pluginGenerateText", () => {
  it("通过统一 LlmClient 和后台队列发送非流式请求", async () => {
    const h = harness();
    const result = await pluginGenerateText(
      [{ role: "user", content: "Write a short greeting" }],
      settings(),
      h.llmClient,
      h.enqueueTask,
      { maxTokens: 2048, timeoutMs: 5000, purpose: "demo:summary" },
    );

    expect(result).toBe("generated text");
    expect(h.labels).toEqual(["plugin:demo:summary"]);
    expect(h.chatNonStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5-mini" }),
      [{ role: "user", content: "Write a short greeting" }],
      undefined,
      5000,
      "plugin:demo:summary",
      undefined,
      { maxTokens: 2048 },
      undefined,
    );
  });

  it("没有 API Key 时拒绝请求", async () => {
    const h = harness();
    await expect(
      pluginGenerateText(
        [{ role: "user", content: "你好" }],
        settings({ apiKey: "" }),
        h.llmClient,
        h.enqueueTask,
      ),
    ).rejects.toThrow(/API Key/);
  });

  it("限制 maxTokens 和 timeoutMs，避免插件制造无界请求", async () => {
    const h = harness();
    await expect(
      pluginGenerateText(
        [{ role: "user", content: "你好" }],
        settings(),
        h.llmClient,
        h.enqueueTask,
        { maxTokens: 9000 },
      ),
    ).rejects.toThrow(/maxTokens/);
  });
});
