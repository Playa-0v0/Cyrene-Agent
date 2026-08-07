import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestMessages, cleanThinkingDrafts, describeImagesForMemory, generateReply, isOpenRouterFreeQuotaError } from "./llm.js";
import type { CloudBotConfig } from "./config.js";
import type { ChatEntry } from "./core.js";

function entry(role: ChatEntry["role"], content: string, at: number): ChatEntry {
  return { sessionId: "session", role, content, at };
}

test("清理思考模型的內部草稿標記與未完結格式符號", () => {
  const raw = `):**\n\n• Draft 1 (Internal thoughts): 這是白\n這是一張幾何數學題目的白板照片。`;
  assert.equal(cleanThinkingDrafts(raw), "這是一張幾何數學題目的白板照片。");
});


test("文字對話維持純字串訊息", () => {
  const messages = buildRequestMessages("system", [entry("user", "你好", 1)]);
  assert.equal(messages[0]?.role, "system");
  assert.equal(typeof messages[0]?.content, "string");
  assert.match(messages[0]?.content as string, /^system\n\n【時間提示】當前時間為 \d{4}年\d{2}月\d{2}日 週[日一二三四五六] \d{2}:\d{2}/);
  assert.deepEqual(messages[1], { role: "user", content: "你好" });
});

test("主動召回內容會以非指令歷史參考注入 system prompt", () => {
  const messages = buildRequestMessages(
    "system",
    [entry("user", "還記得嗎", 1)],
    [],
    "【雲端主動召回】用戶以前說想去冰島",
  );
  assert.match(messages[0]?.content as string, /雲端主動召回/);
  assert.match(messages[0]?.content as string, /冰島/);
  assert.deepEqual(messages[1], { role: "user", content: "還記得嗎" });
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

test("雲端會另外要求視覺模型產生可永久保存的客觀照片描述", async (context) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, any> | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, any>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "圖片 1：一隻戴藍帽的橘貓。" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const description = await describeImagesForMemory(config, [{ url: "https://cdn.discordapp.com/cat.png" }], "這是誰？");
  assert.match(description, /戴藍帽的橘貓/);
  assert.equal(requestBody?.model, config.geminiModel);
  assert.match(requestBody?.messages?.[0]?.content, /照片長期記憶描述器/);
  assert.equal(requestBody?.messages?.[1]?.content?.[1]?.type, "image_url");
});

test("有 Gemini Key 時圖片直接走 Gemini，不先送 OpenRouter", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null; body: Record<string, any> }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, any>,
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: "圖片中是肯德基炸雞午餐。" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const reply = await generateReply(config, "system", [entry("user", "你看我的午餐！", 1)], [
    { url: "https://cdn.discordapp.com/lunch.jpg", mime: "image/jpeg", name: "lunch.jpg" },
  ]);

  assert.equal(reply, "圖片中是肯德基炸雞午餐。");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(calls[0].authorization, "Bearer gemini-key");
  assert.equal(calls[0].body.model, "gemini-3.5-flash-lite");
  assert.equal(calls[0].body.messages.at(-1)?.content?.[1]?.type, "image_url");
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
  assert.deepEqual(calls.map((call) => call.model), ["openrouter/free", "gemini-3.5-flash", "gemini-2.5-flash"]);
});

