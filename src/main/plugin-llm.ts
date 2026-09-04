import type { PluginLlmGenerateOptions, PluginLlmMessage } from "../plugins/api";
import type { LlmClient } from "./services/llm/llm-client";
import type { ModelSettings } from "./settings/model-settings";

export type EnqueuePluginLlmTask = <T>(
  label: string,
  task: () => Promise<T>,
  options?: { log?: boolean; retryRateLimit?: boolean },
) => Promise<T>;

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} 必须是 ${min}-${max} 的整数`);
  }
  return value;
}

function safePurpose(value: string | undefined): string {
  const normalized = value?.trim().replace(/[^a-zA-Z0-9._:-]+/g, "-");
  return normalized?.slice(0, 80) || "unknown";
}

export async function pluginGenerateText(
  messages: PluginLlmMessage[],
  settings: ModelSettings,
  llmClient: LlmClient,
  enqueueTask: EnqueuePluginLlmTask,
  options: PluginLlmGenerateOptions = {},
): Promise<string> {
  if (!settings.apiKey.trim()) {
    throw new Error("未配置 API Key，请先在设置页配置主聊天模型");
  }
  if (!settings.model.trim()) {
    throw new Error("未配置主聊天模型名称");
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("插件模型请求至少需要一条消息");
  }

  const maxTokens = clampInteger(options.maxTokens, 1024, 1, 8192, "maxTokens");
  const defaultTimeout = Math.min(
    Math.max(settings.chatRequestTimeoutSec * 1000, 1000),
    120_000,
  );
  const timeoutMs = clampInteger(options.timeoutMs, defaultTimeout, 1000, 300_000, "timeoutMs");
  const label = `plugin:${safePurpose(options.purpose)}`;

  return enqueueTask(
    label,
    async () => {
      const result = await llmClient.chatNonStream(
        settings,
        messages,
        undefined,
        timeoutMs,
        label,
        undefined,
        { maxTokens },
        options.signal,
      );
      const text = result.text?.trim();
      if (!text) throw new Error("主聊天模型没有返回文本");
      return text;
    },
    { retryRateLimit: true },
  );
}
