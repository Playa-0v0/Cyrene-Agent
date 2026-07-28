import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestMessages, generateReply, isOpenRouterFreeQuotaError } from "./llm.js";
import type { CloudBotConfig } from "./config.js";
import type { ChatEntry } from "./core.js";

function entry(role: ChatEntry["role"], content: string, at: number): ChatEntry {
  return { sessionId: "session", role, content, at };
}

test("文字對話維持純字串訊息", () => {
  const messages = buildRequestMessages("system", [entry("user", "你好", 1)]);
  assert.deepEqual(messages, [
    { role: "system", content: "system" },
    { role: "user", content: "你好" },
  ]);
});

test("圖片只附到最後一則 user message，並使用 OpenRouter image_url 格式", () => {
  const messages = buildRequestMessages("system", [
    entry("user", "上一題", 1),
    entry("assistant", "上一答", 2),
    entry("user", "這張圖有什麼？", 3),
  ], [
    { url: "https://cdn.discordapp.com/a.png", mime: "image/png", name: "a.png" },
    { url: "https://cdn.discordapp.com/b.webp", mime: "image/webp", name: "b.webp" },
  ]);

  assert.equal(messages[1].content, "上一題");
  assert.deepEqual(messages[3].content, [
    { type: "text", text: "這張圖有什麼？" },
    { type: "image_url", image_url: { url: "https://cdn.discordapp.com/a.png" } },
    { type: "image_url", image_url: { url: "https://cdn.discordapp.com/b.webp" } },
  ]);
});

const config: CloudBotConfig = {
  discordToken: "token",
  llmApiKey: "openrouter-key",
  llmBaseUrl: "https://openrouter.ai/api/v1",
  llmModel: "openrouter/free",
  llmVisionModel: "openrouter/free",
  geminiApiKey: "gemini-key",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  geminiModel: "gemini-3.5-flash-lite",
  allowedUserIds: new Set(["owner"]),
  allowedGuildIds: new Set(),
  allowedChannelIds: new Set(),
  requireMention: true,
  dataDir: "./data",
  port: 3000,
  historyMessages: 8,
  maxOutputTokens: 500,
  musicMonthlyMinutes: 300,
  activity: "test",
};

test("辨識 OpenRouter 的 402、429 與額度錯誤文字", () => {
  assert.equal(isOpenRouterFreeQuotaError(new Error("LLM HTTP 402: insufficient credits"), config), true);
  assert.equal(isOpenRouterFreeQuotaError(new Error("LLM HTTP 429: Too Many Requests"), config), true);
  assert.equal(isOpenRouterFreeQuotaError(new Error("No free models available"), config), true);
  assert.equal(isOpenRouterFreeQuotaError(new Error("LLM HTTP 500"), config), false);
});

test("OpenRouter 無額度時自動改用 Gemini", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    if (calls.length === 1) return new Response('{"error":"insufficient credits"}', { status: 402 });
    return new Response(JSON.stringify({ model: "gemini-3.5-flash-lite", choices: [{ message: { content: "備援成功" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const reply = await generateReply(config, "system", [entry("user", "你好", 1)]);
  assert.equal(reply, "備援成功");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[1].url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(calls[1].authorization, "Bearer gemini-key");
  assert.equal(calls[1].body.model, "gemini-3.5-flash-lite");
});

test("Gemini 設定模型不可用時改用已驗證的 Flash-Lite", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    if (calls.length === 1) return new Response('{"error":"quota"}', { status: 429 });
    if (calls.length === 2) return new Response('[{"error":{"message":"high demand"}}]', { status: 503 });
    return new Response(JSON.stringify({
      model: "gemini-3.5-flash-lite",
      choices: [{ message: { content: "Flash-Lite 正常" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const reply = await generateReply({ ...config, geminiModel: "gemini-3.5-flash" }, "system", [entry("user", "你好", 1)]);
  assert.equal(reply, "Flash-Lite 正常");
  assert.deepEqual(calls.map((call) => call.model), ["openrouter/free", "gemini-3.5-flash", "gemini-3.5-flash-lite"]);
});
