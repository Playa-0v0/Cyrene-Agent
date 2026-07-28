import type { CloudBotConfig } from "./config.js";
import { normalizeCompanionAddress, type ChatEntry } from "./core.js";

export type ImageInput = {
  url: string;
  mime?: string;
  name?: string;
};

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image_url"; image_url: { url: string } };
type RequestMessage = {
  role: "system" | ChatEntry["role"];
  content: string | Array<TextContent | ImageContent>;
};

type CompletionTarget = {
  apiKey: string;
  baseUrl: string;
  model: string;
  label: string;
};

const GEMINI_STABLE_FALLBACK_MODEL = "gemini-3.5-flash-lite";

function isGeminiAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP\s*(?:401|403)\b|API[_\s-]*KEY(?:_INVALID)?|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message);
}

export function isOpenRouterFreeQuotaError(error: unknown, config: Pick<CloudBotConfig, "llmBaseUrl" | "llmModel">): boolean {
  if (!/openrouter\.ai/i.test(config.llmBaseUrl) || config.llmModel !== "openrouter/free") return false;
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP\s*(?:402|429)\b/i.test(message)
    || /(?:free-models-per-day|rate[\s_-]*limit|quota|remaining["']?\s*:\s*["']?0|insufficient[\s_-]*(?:credits?|balance)|(?:credits?|balance).{0,24}(?:exhausted|depleted|used\s*up|too\s*low)|no\s+(?:free\s+)?models?\s+(?:available|remaining))/i.test(message);
}

async function requestCompletion(
  target: CompletionTarget,
  messages: RequestMessage[],
  maxOutputTokens: number,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: target.model,
      messages,
      temperature: 0.85,
      max_tokens: maxOutputTokens,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`${target.label} HTTP ${response.status}: ${detail}`);
  }
  const data = await response.json() as { model?: string; choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error(`${target.label} 沒有返回文字`);
  console.log(`[LLM] provider=${target.label} requested=${target.model} selected=${data.model || "unknown"}`);
  return normalizeCompanionAddress(content.trim());
}

/**
 * OpenRouter 使用 OpenAI 相容的 image_url content block。
 * 圖片只掛在本輪最後一則 user message，不寫入持久化聊天歷史。
 */
export function buildRequestMessages(systemPrompt: string, history: ChatEntry[], images: ImageInput[] = []): RequestMessage[] {
  const messages: RequestMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map(({ role, content }) => ({ role, content })),
  ];
  if (!images.length) return messages;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || typeof message.content !== "string") continue;
    message.content = [
      { type: "text", text: message.content || "請看看我附上的圖片。" },
      ...images.map((image): ImageContent => ({ type: "image_url", image_url: { url: image.url } })),
    ];
    break;
  }
  return messages;
}

export async function generateReply(
  config: CloudBotConfig,
  systemPrompt: string,
  history: ChatEntry[],
  images: ImageInput[] = [],
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const model = images.length ? config.llmVisionModel : config.llmModel;
    const messages = buildRequestMessages(systemPrompt, history, images);
    try {
      return await requestCompletion({
        apiKey: config.llmApiKey,
        baseUrl: config.llmBaseUrl,
        model,
        label: "LLM",
      }, messages, config.maxOutputTokens, controller.signal);
    } catch (error) {
      if (!config.geminiApiKey || !isOpenRouterFreeQuotaError(error, config)) throw error;
      console.warn("[LLM] OpenRouter 免費額度用盡，切換至 Gemini 備援。");
      const models = [...new Set([config.geminiModel, GEMINI_STABLE_FALLBACK_MODEL])];
      let lastError: unknown = new Error("Gemini 沒有可用模型");
      for (const geminiModel of models) {
        try {
          return await requestCompletion({
            apiKey: config.geminiApiKey,
            baseUrl: config.geminiBaseUrl,
            model: geminiModel,
            label: "Gemini fallback",
          }, messages, config.maxOutputTokens, controller.signal);
        } catch (geminiError) {
          lastError = geminiError;
          console.warn(`[LLM] Gemini ${geminiModel} 失敗，嘗試下一個備援模型。`);
          if (isGeminiAuthenticationError(geminiError)) throw geminiError;
        }
      }
      throw lastError;
    }
  } finally {
    clearTimeout(timeout);
  }
}
