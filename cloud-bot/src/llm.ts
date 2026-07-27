import type { CloudBotConfig } from "./config.js";
import type { ChatEntry } from "./core.js";

export async function generateReply(config: CloudBotConfig, systemPrompt: string, history: ChatEntry[]): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.llmApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map(({ role, content }) => ({ role, content })),
        ],
        temperature: 0.85,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`LLM HTTP ${response.status}: ${detail}`);
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("模型沒有返回文字");
    return content.trim();
  } finally {
    clearTimeout(timeout);
  }
}
