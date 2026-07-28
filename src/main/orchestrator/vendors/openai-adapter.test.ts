import { describe, expect, test } from "vitest";
import { OpenAICompatAdapter } from "./openai-adapter";
import type { ProviderCapability } from "./types";

const capability: ProviderCapability = {
  id: "test-openai",
  displayName: "Test OpenAI",
  transport: "openai",
  baseUrl: "https://example.test/v1",
  authStyle: "bearer",
  defaultModel: "test-model",
  supportsTools: true,
  supportsThinking: false,
  thinkingField: null,
  cacheStrategy: "none",
  testStrategy: "text",
  supportsVision: true,
};

describe("OpenAICompatAdapter", () => {
  test("maps structured json_schema requests to response_format", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const schema = {
      type: "object",
      properties: { decision: { type: "string", enum: ["respond"] } },
      required: ["decision"],
      additionalProperties: false,
    };
    const req = adapter.buildRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      structuredOutput: { mode: "json_schema", name: "action_decision", schema, strict: true },
    }, { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k" });

    expect(JSON.parse(req.body).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "action_decision", strict: true, schema },
    });
  });

  test("maps json_object and prompt-json hints without tools", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const config = { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k" };
    const makeBody = (structuredOutput: {
      mode: "json_object";
    } | {
      mode: "prompt_json";
      sendJsonObjectHint: true;
    }) => JSON.parse(adapter.buildRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      structuredOutput,
    }, config).body);

    expect(makeBody({ mode: "json_object" }).response_format).toEqual({ type: "json_object" });
    expect(makeBody({ mode: "prompt_json", sendJsonObjectHint: true }).response_format)
      .toEqual({ type: "json_object" });
  });

  test("preserves refusal even when finish_reason is stop", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    expect(adapter.parseResponse({
      choices: [{
        message: { role: "assistant", content: null, refusal: "blocked" },
        finish_reason: "stop",
      }],
    })).toMatchObject({
      text: "",
      refusal: "blocked",
      finishReason: "stop",
    });
  });

  test("keeps ordinary native Function Calling on auto", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const req = adapter.buildRequest({
      model: "m", messages: [{ role: "user", content: "搜歌" }],
      tools: [{ name: "music_search", description: "搜索", parameters: { type: "object" } }],
    }, { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k" });
    expect(JSON.parse(req.body).tool_choice).toBe("auto");
  });

  test("maps a must-call intent to named OpenAI tool_choice when reasoning is off", () => {
    const adapter = new OpenAICompatAdapter("qwen", { ...capability, id: "qwen" });
    const req = adapter.buildRequest({
      model: "qwen3-7b",
      messages: [{ role: "user", content: "搜歌" }],
      tools: [{ name: "music_search", description: "搜索", parameters: { type: "object" } }],
      toolChoiceIntent: { mode: "must_call", toolName: "music_search" },
    }, { provider: "qwen", baseUrl: "https://e.test/v1", model: "qwen3-7b", apiKey: "sk-test", reasoning: { mode: "off" } });

    expect(JSON.parse(req.body).tool_choice).toEqual({
      type: "function",
      function: { name: "music_search" },
    });
  });

  test("maps must-call intent through the active provider and thinking policy", () => {
    const toolRequest = {
      model: "m",
      messages: [{ role: "user" as const, content: "搜歌" }],
      tools: [{ name: "music_search", description: "搜索", parameters: { type: "object" } }],
      toolChoiceIntent: { mode: "must_call" as const, toolName: "music_search" },
    };
    const deepseek = new OpenAICompatAdapter("deepseek", { ...capability, id: "deepseek" });
    const deepseekBody = JSON.parse(deepseek.buildRequest(toolRequest, {
      provider: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro",
      apiKey: "k", reasoning: { mode: "on", effort: "high" },
    }).body);
    expect(deepseekBody.tools).toHaveLength(1);
    expect(deepseekBody.tool_choice).toBeUndefined();

    const minimax = new OpenAICompatAdapter("minimax", { ...capability, id: "minimax" });
    const minimaxBody = JSON.parse(minimax.buildRequest(toolRequest, {
      provider: "MiniMax（稀宇科技）", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3",
      apiKey: "k", reasoning: { mode: "on" },
    }).body);
    expect(minimaxBody.tool_choice).toBe("auto");
  });

  test("maps a required-only provider policy to OpenAI required", () => {
    const adapter = new OpenAICompatAdapter("required-only", {
      ...capability,
      id: "required-only",
      toolChoiceModes: ["required"],
    });
    const req = adapter.buildRequest({
      model: "m", messages: [{ role: "user", content: "搜歌" }],
      tools: [{ name: "music_search", description: "搜索", parameters: { type: "object" } }],
      toolChoiceIntent: { mode: "must_call", toolName: "music_search" },
    }, { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k", reasoning: { mode: "off" } });
    expect(JSON.parse(req.body).tool_choice).toBe("required");
  });

  test("preserves user content blocks for direct image attachments", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const request = adapter.buildRequest(
      {
        model: "test-model",
        messages: [
          { role: "system", content: "system" },
          {
            role: "user",
            content: [
              { type: "text", text: "请看图" },
              { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            ],
          },
        ],
      },
      {
        provider: "Test OpenAI",
        baseUrl: "https://example.test/v1",
        model: "test-model",
        apiKey: "key",
      },
    );

    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "请看图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });
  });

  test("buildRequest uses Authorization Bearer when authStyle=bearer", () => {
    const adapter = new OpenAICompatAdapter("test-openai", { ...capability, authStyle: "bearer" });
    const req = adapter.buildRequest(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "sk-test" },
    );
    expect(req.headers.Authorization).toBe("Bearer sk-test");
    expect(req.headers["x-api-key"]).toBeUndefined();
  });

  test("buildRequest uses x-api-key when authStyle=x-api-key (transport=openai decoupled)", () => {
    const adapter = new OpenAICompatAdapter("test-openai", { ...capability, authStyle: "x-api-key" });
    const req = adapter.buildRequest(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "sk-test" },
    );
    expect(req.headers["x-api-key"]).toBe("sk-test");
    expect(req.headers.Authorization).toBeUndefined();
  });

  // ─── 流式 / 非流式 reasoning_content 解析（覆盖 DeepSeek / Qwen / GLM / MiMo / Doubao） ───

  test("parseStreamEvent: delta.reasoning_content → chunk.deltaThinking（DeepSeek/Qwen/GLM/MiMo 流式）", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const chunk = adapter.parseStreamEvent({
      eventType: "data",
      data: JSON.stringify({ choices: [{ delta: { reasoning_content: "我在思考" } }] }),
    });
    expect(chunk?.deltaThinking).toBe("我在思考");
    expect(chunk?.deltaText).toBeUndefined();
  });

  test("parseStreamEvent: delta.content → chunk.deltaText（不影响 reasoning_content）", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const chunk = adapter.parseStreamEvent({
      eventType: "data",
      data: JSON.stringify({ choices: [{ delta: { content: "你好" } }] }),
    });
    expect(chunk?.deltaText).toBe("你好");
    expect(chunk?.deltaThinking).toBeUndefined();
  });

  test("parseStreamEvent: [DONE] 哨兵 → chunk.done=true", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const chunk = adapter.parseStreamEvent({ eventType: "data", data: "[DONE]" });
    expect(chunk?.done).toBe(true);
  });

  test("parseStreamEvent: usage 块（choices 为空但有 usage）→ chunk.usage", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const chunk = adapter.parseStreamEvent({
      eventType: "data",
      data: JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 20 } }),
    });
    expect(chunk?.usage).toEqual({ input: 10, output: 20 });
  });

  test("parseResponse: 同时返回 reasoning_content 与 content → assistantMessage 双字段", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const resp = adapter.parseResponse({
      choices: [{
        message: {
          role: "assistant",
          content: "最终答案",
          reasoning_content: "思考过程",
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    });
    expect(resp.text).toBe("最终答案");
    expect(resp.thinking).toBe("思考过程");
    expect(resp.assistantMessage.thinking).toBe("思考过程");
    expect(resp.assistantMessage.content).toBe("最终答案");
    expect(resp.usage).toEqual({ input: 5, output: 10 });
    expect(resp.finishReason).toBe("stop");
  });

  test("parseResponse: tool_calls 多轮字段映射正确", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const resp = adapter.parseResponse({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "tc1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"北京"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    });
    expect(resp.toolCalls).toEqual([
      { id: "tc1", name: "get_weather", arguments: '{"city":"北京"}' },
    ]);
    expect(resp.finishReason).toBe("tool_calls");
    expect(resp.assistantMessage.toolCalls).toEqual(resp.toolCalls);
  });

  // ─── 多轮工具调用：appendToolResults + buildRequest 端到端 ───

  test("多轮工具调用：assistant 带 toolCalls → appendToolResults → buildRequest 的 wire messages 顺序与字段完整", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const messages = [
      { role: "user" as const, content: "北京天气如何" },
      {
        role: "assistant" as const,
        content: undefined,
        toolCalls: [{ id: "tc1", name: "get_weather", arguments: '{"city":"北京"}' }],
      },
      { role: "tool" as const, toolCallId: "tc1", name: "get_weather", content: "晴 25°C" },
      { role: "user" as const, content: "那上海呢" },
    ];
    const req = adapter.buildRequest(
      { model: "test-model", messages },
      { provider: "Test", baseUrl: "https://e.test/v1", model: "test-model", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { messages: Array<Record<string, unknown>> };
    expect(body.messages).toHaveLength(4);
    // 第 1 条 user
    expect(body.messages[0]).toEqual({ role: "user", content: "北京天气如何" });
    // 第 2 条 assistant 带 tool_calls（adapter: m.content || null → wire 上是 null）
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "tc1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"北京"}' },
      }],
    });
    // 第 3 条 tool 带 tool_call_id 与 name（OpenAI 多轮必须）
    expect(body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "tc1",
      content: "晴 25°C",
      name: "get_weather",
    });
    // 第 4 条 user 顺序在最后
    expect(body.messages[3]).toEqual({ role: "user", content: "那上海呢" });
  });
});
