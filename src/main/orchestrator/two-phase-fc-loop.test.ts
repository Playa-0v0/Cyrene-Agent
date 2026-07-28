import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult } from "./types";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatVendorAdapter,
  HttpRequest,
  ProviderCapability,
  ToolCall,
  ToolExecutionResult,
} from "./vendors/types";
import { runTwoPhaseFcLoop } from "./two-phase-fc-loop";

const TEST_CAPABILITY: ProviderCapability = {
  id: "test",
  displayName: "test",
  transport: "openai",
  baseUrl: "https://test/",
  authStyle: "bearer",
  defaultModel: "m",
  supportsTools: true,
  supportsThinking: false,
  thinkingField: null,
  cacheStrategy: "none",
  testStrategy: "text",
  supportsVision: false,
};

/**
 * 极简 fake adapter —— 不发真 HTTP 请求，按 sequence 里的脚本返回响应。
 */
class FakeAdapter implements ChatVendorAdapter {
  readonly id = "fake";
  readonly transport = "openai" as const;
  capability: ProviderCapability = TEST_CAPABILITY;

  /** 控制台返回的脚本：每次 fetch 调用消耗一个 script 元素。 */
  private scripts: Array<
    | { kind: "text"; text: string }
    | { kind: "tool"; toolCalls: ToolCall[] }
    | { kind: "error"; message: string }
  > = [];
  private callIndex = 0;
  /** 记录所有发出的请求体，便于断言。 */
  readonly requests: ChatRequest[] = [];

  enqueueText(text: string) {
    this.scripts.push({ kind: "text", text });
  }
  enqueueToolCalls(toolCalls: ToolCall[]) {
    this.scripts.push({ kind: "tool", toolCalls });
  }
  enqueueError(message: string) {
    this.scripts.push({ kind: "error", message });
  }

  buildRequest(req: ChatRequest): HttpRequest {
    this.requests.push(req);
    return {
      url: "https://fake/",
      method: "POST",
      headers: {},
      body: JSON.stringify({}),
    };
  }
  parseResponse(raw: unknown): ChatResponse {
    const script = this.scripts[this.callIndex++];
    if (!script) throw new Error("FakeAdapter: no script enqueued for call " + this.callIndex);
    if (script.kind === "error") throw new Error(script.message);

    const text = script.kind === "text" ? script.text : "";
    const toolCalls = script.kind === "tool" ? script.toolCalls : [];

    return {
      assistantMessage: {
        role: "assistant",
        ...(text ? { content: text } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      raw: {},
    };
  }
  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    const next = messages.slice();
    for (const r of results) {
      next.push({
        role: "tool",
        toolCallId: r.toolCall.id,
        name: r.toolCall.name,
        content: r.output,
      });
    }
    return next;
  }
  buildStreamRequest(req: ChatRequest): HttpRequest {
    return this.buildRequest({ ...req, stream: true });
  }
  parseStreamEvent(): null {
    return null;
  }
  async testConnection() {
    return { ok: true, latency: 0 };
  }
}

function makeTool(id: string, enabled = true): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    enabled,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "ok",
  };
}

const baseMessages: ChatMessage[] = [
  { role: "user", content: "你好" },
];

const baseOptions = {
  messages: baseMessages,
  tools: [makeTool("weather")],
  toolSystemContent: "TOOL_SYSTEM",
  soulSystemBaseContent: "SOUL_SYSTEM_BASE",
  timeoutMs: 30_000,
};

beforeEach(() => {
  // 默认 fetch stub：如果 fake adapter 返回了正常响应，这里不会真发请求
  // （adapter 的 buildRequest 不真发请求）。但 runTwoPhaseFcLoop 内部仍走 fetch。
  globalThis.fetch = vi.fn(async () => {
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runTwoPhaseFcLoop", () => {
  it("executes only model-authored tool calls", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([{ id: "call-1", name: "music_search", arguments: JSON.stringify({ keyword: "左转灯" }) }]);
    adapter.enqueueText("工具阶段结束");
    adapter.enqueueText("已经找到真实结果");
    const executed: ToolCall[] = [];

    await runTwoPhaseFcLoop({
      ...baseOptions,
      tools: [makeTool("music_search")],
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async (toolCall) => {
        executed.push(toolCall);
        return JSON.stringify({ kind: "search", set: { tracks: [{ id: "1", name: "左转灯" }] } });
      },
    });

    expect(JSON.parse(executed[0].arguments)).toEqual({ keyword: "左转灯" });
    expect(adapter.requests[0].messages.some((message) => message.role === "tool")).toBe(false);
    expect(adapter.requests[1].messages.some((message) => message.role === "tool")).toBe(true);
    expect(adapter.requests[0].toolChoiceIntent).toBeUndefined();
  });

  it("never forces a tool choice before the model decides", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("模型仍未调用工具");
    adapter.enqueueText("最终回复");

    await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async () => "ok",
    });

    expect(adapter.requests[0].toolChoiceIntent).toBeUndefined();
    expect(adapter.requests[1].toolChoiceIntent).toBeUndefined();
  });

  it("模型无 tool_calls → 切 SOUL_PHASE，工具阶段自由文本不写入 conversation", async () => {
    const adapter = new FakeAdapter();
    // TOOL_PHASE: 模型生成自由文本（这个文本不应进入 soul 的 conversation）
    adapter.enqueueText("UNSEEN_TOOL_TEXT");
    // SOUL_PHASE: 模型返回最终回复
    adapter.enqueueText("最终面向用户的回复");

    const executeToolCalls: ToolCall[] = [];
    const events: string[] = [];

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async (tc) => {
        executeToolCalls.push(tc);
        return "tool output";
      },
      onEvent: (e) => events.push(e.type),
    });

    expect(result.reply).toBe("最终面向用户的回复");
    expect(result.soulPhaseReason).toBe("no_tool");
    expect(executeToolCalls).toHaveLength(0);

    // 第一个请求用 tool_system，第二个请求用 soul_systemBase
    expect(adapter.requests).toHaveLength(2);
    const toolReq = adapter.requests[0];
    const soulReq = adapter.requests[1];

    // tool 阶段 system
    expect(toolReq.messages[0].role).toBe("system");
    expect(toolReq.messages[0].content).toBe("TOOL_SYSTEM");
    expect(toolReq.tools).toBeDefined();
    expect(toolReq.tools!.length).toBeGreaterThan(0);

    // soul 阶段 system
    expect(soulReq.messages[0].role).toBe("system");
    expect(String(soulReq.messages[0].content)).toContain("SOUL_SYSTEM_BASE");
    expect(String(soulReq.messages[0].content)).toContain('"actions":[]');
    // soul 阶段不携带 tools
    expect(soulReq.tools).toBeUndefined();

    // 关键：工具阶段的 UNSEEN_TOOL_TEXT 不进入 soul 的 conversation
    // soul request 的所有 messages 拼接起来不应该出现 UNSEEN_TOOL_TEXT
    const allSoulContent = soulReq.messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(allSoulContent).not.toContain("UNSEEN_TOOL_TEXT");
  });

  it("工具阶段：模型调用工具 → 执行 → 继续 TOOL_PHASE", async () => {
    const adapter = new FakeAdapter();
    // 第 1 轮：模型调工具
    adapter.enqueueToolCalls([
      { id: "tc-1", name: "weather", arguments: '{"city":"北京"}' },
    ]);
    // 第 2 轮：模型不调工具（自由文本）→ 切 SOUL_PHASE
    adapter.enqueueText("");
    // SOUL_PHASE
    adapter.enqueueText("北京今天 25 度");

    const executeResults: string[] = [];

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async (tc) => {
        executeResults.push(tc.name);
        return "北京：晴 25°C";
      },
    });

    expect(executeResults).toEqual(["weather"]);
    expect(result.reply).toBe("北京今天 25 度");
    expect(result.soulPhaseReason).toBe("no_tool");

    // 3 个请求：2 个 tool 阶段 + 1 个 soul 阶段
    expect(adapter.requests.length).toBeGreaterThanOrEqual(3);
    // soul 阶段不带 tools
    const soulReq = adapter.requests[adapter.requests.length - 1];
    expect(soulReq.tools).toBeUndefined();
    // soul 阶段 system 同时包含 soul base 与本轮执行事实
    expect(String(soulReq.messages[0].content)).toContain("SOUL_SYSTEM_BASE");
    expect(String(soulReq.messages[0].content)).toContain('"executionStatus":"succeeded"');
  });

  it("纯聊天场景：tool 阶段 no_tool → soul 阶段回复", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText(""); // tool 阶段：模型没调工具（自由文本忽略）
    adapter.enqueueText("hi 朋友～");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => {
        throw new Error("executeTool 不应在纯聊天时被调用");
      },
    });

    expect(result.reply).toBe("hi 朋友～");
    expect(result.soulPhaseReason).toBe("no_tool");
    expect(result.toolResults).toHaveLength(0);
  });

  it("达到 maxToolRounds → SOUL_PHASE 强制总结", async () => {
    const adapter = new FakeAdapter();
    // 永远调工具，直到达到上限
    for (let i = 0; i < 3; i++) {
      adapter.enqueueToolCalls([
        { id: `tc-${i}`, name: "weather", arguments: "{}" },
      ]);
    }
    // soul 阶段
    adapter.enqueueText("抱歉，已经循环太多次了");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      maxToolRounds: 3,
      executeTool: async () => "tool output",
    });

    expect(result.soulPhaseReason).toBe("max_rounds");
    expect(result.reply).toBe("抱歉，已经循环太多次了");
  });

  it("工具执行异常不影响主流程，并记录结构化失败状态", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([
      { id: "tc-1", name: "weather", arguments: "{}" },
    ]);
    adapter.enqueueText(""); // tool 阶段：不再调
    adapter.enqueueText("出错了但我继续");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => {
        throw new Error("boom");
      },
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      output: "boom",
      status: "failed",
      errorCode: "E_TOOL_EXECUTION_FAILED",
    });
    expect(result.reply).toBe("出错了但我继续");
  });

  it("preserves a structured runtime failure for the final Soul call", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([{ id: "play-1", name: "music_play_track", arguments: "{\"candidateRef\":\"ctx_missing\"}" }]);
    adapter.enqueueText("");
    adapter.enqueueText("这次请求没有成功，我再确认一下目标。");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      tools: [makeTool("music_play_track")],
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async () => ({
        status: "failed" as const,
        output: "E_CONTEXT_REF_NOT_FOUND",
        errorCode: "E_CONTEXT_REF_NOT_FOUND",
      }),
    });

    expect(result.toolResults[0]).toMatchObject({
      toolId: "music_play_track",
      status: "failed",
      errorCode: "E_CONTEXT_REF_NOT_FOUND",
    });
    const sysContent = String(adapter.requests.at(-1)!.messages[0].content);
    expect(sysContent).toContain('"executionStatus":"failed"');
    expect(sysContent).toContain('"errorCode":"E_CONTEXT_REF_NOT_FOUND"');
  });

  it("emits a concise structured tool execution trace", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const adapter = new FakeAdapter();
      adapter.enqueueToolCalls([{ id: "play-1", name: "music_play_track", arguments: "{}" }]);
      adapter.enqueueText("");
      adapter.enqueueText("没有执行成功。");

      await runTwoPhaseFcLoop({
        ...baseOptions,
        tools: [makeTool("music_play_track")],
        settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
        adapter,
        executeTool: async () => ({
          status: "failed",
          output: "E_CONTEXT_REF_NOT_FOUND",
          errorCode: "E_CONTEXT_REF_NOT_FOUND",
        }),
      });

      const lines = log.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(lines).toContain("[ToolExecution/Trace] tool=music_play_track status=failed errorCode=E_CONTEXT_REF_NOT_FOUND");
    } finally {
      log.mockRestore();
    }
  });

  it("Soul 阶段同时保留 tool 消息并注入本轮权威执行上下文", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([
      { id: "tc-1", name: "weather", arguments: "{}" },
    ]);
    adapter.enqueueText("");
    adapter.enqueueText("北京 25 度");

    await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => "北京：晴 25°C",
    });

    const soulReq = adapter.requests[adapter.requests.length - 1];
    const sysContent = String(soulReq.messages[0].content);
    expect(sysContent).toContain("SOUL_SYSTEM_BASE");
    expect(sysContent).toContain("[SOUL_EXECUTION_CONTEXT]");
    expect(sysContent).toContain('"executionStatus":"succeeded"');
    expect(sysContent).not.toContain('"toolId"');
    expect(soulReq.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", name: "weather", content: "北京：晴 25°C" }),
    ]));
  });

  it("buildSoulToolResultsSummary 非空时，会追加到 soul system 末尾", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([
      { id: "tc-1", name: "weather", arguments: "{}" },
    ]);
    adapter.enqueueText("");
    adapter.enqueueText("北京 25 度");

    await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => "北京：晴 25°C",
      buildSoulToolResultsSummary: () => "工具摘要：天气查询成功",
    });

    const soulReq = adapter.requests[adapter.requests.length - 1];
    const sysContent = String(soulReq.messages[0].content);
    expect(sysContent).toContain("SOUL_SYSTEM_BASE");
    expect(sysContent).toContain("工具摘要：天气查询成功");
  });

  it("tool 阶段自由文本绝不能发给用户（不进入 reply）", async () => {
    const adapter = new FakeAdapter();
    // 工具阶段模型返回了一段看起来很完整的文本
    adapter.enqueueText("这是工具阶段的文本，绝对不能泄露给用户");
    adapter.enqueueText("这是 soul 阶段的正式回复");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => {
        throw new Error("不应调用");
      },
    });

    expect(result.reply).not.toContain("工具阶段的文本");
    expect(result.reply).toBe("这是 soul 阶段的正式回复");
  });

  it("strips leaked leading chat timestamp metadata before emitting and returning reply", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("");
    adapter.enqueueText("[2026-07-13 13:36, Asia/Shanghai]\n怎么啦，看起来不太高兴的样子…");

    let streamed = "";
    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: {
        provider: "test",
        baseUrl: "https://test",
        model: "m",
        apiKey: "k",
      },
      adapter,
      executeTool: async () => {
        throw new Error("不应调用");
      },
      onEvent: (event) => {
        if (event.type === "text_message_content") streamed += event.delta;
      },
    });

    expect(result.reply).toBe("怎么啦，看起来不太高兴的样子…");
    expect(streamed).toBe("怎么啦，看起来不太高兴的样子…");
  });

  it("never emits MiniMax textual tool-call protocol from the Soul phase", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("");
    adapter.enqueueText("]<]minimax[>[<tool_call>\n]<]minimax[>[<invoke name=\"music_get_daily_recommendations\">]<]minimax[>[</invoke>\n]<]minimax[>[</tool_call>");

    let streamed = "";
    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async () => "ok",
      onEvent: (event) => {
        if (event.type === "text_message_content") streamed += event.delta;
      },
    });

    expect(result.reply).not.toContain("tool_call");
    expect(result.reply).not.toContain("minimax");
    expect(result.reply.trim().length).toBeGreaterThan(0);
    expect(streamed).toBe(result.reply);
  });

  it("replaces a leaked textual tool protocol with a generic retry message", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([{ id: "daily-1", name: "music_get_daily_recommendations", arguments: "{}" }]);
    adapter.enqueueText("");
    adapter.enqueueText("[tool_call]\nmusic_get_daily_recommendations\n[/tool_call]");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      tools: [makeTool("music_get_daily_recommendations")],
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async () => JSON.stringify({
        kind: "recommendations",
        set: { tracks: [{ id: "1", name: "真实歌曲" }] },
        presentation: { cardRef: "cyrene:music:daily-1" },
      }),
    });

    expect(result.reply).toContain("没有生成正常回复")
    expect(result.reply).not.toContain("tool_call")
  });

  it("lets Soul generate the natural card reply from structured tool facts without fixed replacement", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([{ id: "daily-1", name: "music_get_daily_recommendations", arguments: "{}" }]);
    adapter.enqueueText("");
    adapter.enqueueText("今天的推荐已经整理好啦，看看卡片里有没有喜欢的♪");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      tools: [makeTool("music_get_daily_recommendations")],
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async () => JSON.stringify({
        kind: "recommendations",
        context: {
          setRef: "ctx_set",
          source: "daily_recommendation",
          candidates: [{
            candidateRef: "ctx_song_1",
            position: 1,
            name: "最初的记忆",
            artists: ["徐佳莹"],
          }],
        },
        presentation: { presented: true },
      }),
    });

    expect(result.reply).toBe("今天的推荐已经整理好啦，看看卡片里有没有喜欢的♪");
    const soulReq = adapter.requests.at(-1)!;
    const sysContent = String(soulReq.messages[0].content);
    expect(sysContent).toContain('[SOUL_EXECUTION_CONTEXT]');
    expect(sysContent).toContain('"executionStatus":"succeeded"');
    expect(sysContent).not.toContain('"kind":"recommendations"');
  });

  it("tells Soul explicitly when no tool ran instead of using a reply regex", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("");
    adapter.enqueueText("正在为你播放♪");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async () => "ok",
    });

    expect(result.reply).toBe("正在为你播放♪");
    const sysContent = String(adapter.requests.at(-1)!.messages[0].content);
    expect(sysContent).toContain('"actions":[]');
  });

  it("provides dispatched playback as a runtime fact and leaves wording to Soul", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueToolCalls([{
      id: "play-1",
      name: "music_play_track",
      arguments: JSON.stringify({ provider: "netease-cloud-music", setId: "s1", trackId: "1" }),
    }]);
    adapter.enqueueText("");
    adapter.enqueueText("已经开始播放了♪");

    const result = await runTwoPhaseFcLoop({
      ...baseOptions,
      tools: [makeTool("music_play_track")],
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      executeTool: async () => JSON.stringify({
        kind: "playback",
        dispatch: { state: "dispatched", resourceType: "song", resourceId: "1" },
      }),
    });

    expect(result.reply).toBe("已经开始播放了♪");
    const sysContent = String(adapter.requests.at(-1)!.messages[0].content);
    expect(sysContent).toContain('"executionStatus":"succeeded"');
    expect(sysContent).not.toContain('"toolId"');
    expect(sysContent).not.toContain('effect.state');
  });

  it("keeps style sampling out of tool requests and applies it to Soul only", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("");
    adapter.enqueueText("done");

    await runTwoPhaseFcLoop({
      ...baseOptions,
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
      adapter,
      soulSampling: { temperature: 0.9, frequencyPenalty: 0.2 },
      executeTool: async () => {
        throw new Error("不应调用");
      },
    });

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]).not.toHaveProperty("temperature");
    expect(adapter.requests[0]).not.toHaveProperty("frequencyPenalty");
    expect(adapter.requests[1]).toMatchObject({ temperature: 0.9, frequencyPenalty: 0.2 });
    expect(adapter.requests[1].tools).toBeUndefined();
  });
});
