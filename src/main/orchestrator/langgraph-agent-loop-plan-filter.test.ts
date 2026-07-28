/**
 * Plan 模式下 hideInPlanMode 工具过滤测试。
 *
 * 独立文件：因为需要 ENABLE_TASK_ROUTER=true，而主测试文件固定为 false。
 * 测试场景：
 *   1. Plan 创建失败降级后 delegate_task 被隐藏（Action Gate + Native FC）
 *   2. 下一轮正常 direct 请求恢复 delegate_task 可见
 *   3. 工具过滤使用局部数组，不原地修改共享 enabledTools
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Router 启用
vi.mock("./task-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./task-router")>();
  return { ...actual, ENABLE_TASK_ROUTER: true };
});

import { runLangGraphAgentLoop } from "./langgraph-agent-loop";
import { contextRefRegistry } from "./tool-context";
import type { ToolDefinition } from "./tool-registry";
import type {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter, HttpRequest,
  ProviderCapability, ToolCall, ToolExecutionResult,
} from "./vendors/types";

const capability: ProviderCapability = {
  id: "test", displayName: "test", transport: "openai", baseUrl: "https://test/",
  authStyle: "bearer", defaultModel: "m", supportsTools: true, supportsThinking: false,
  thinkingField: null, cacheStrategy: "none", testStrategy: "text", supportsVision: false,
};

class FakeAdapter implements ChatVendorAdapter {
  readonly id = "chatgpt";
  readonly transport = "openai" as const;
  capability = capability;
  readonly requests: ChatRequest[] = [];
  private scripts: Array<{ text: string; toolCalls?: never } | { text?: never; toolCalls: ToolCall[] }> = [];
  private index = 0;

  enqueueText(text: string) { this.scripts.push({ text }); }
  enqueueJson(value: unknown) { this.enqueueText(JSON.stringify(value)); }
  enqueueToolCall(name: string, args: Record<string, unknown>, id = `call-${this.scripts.length + 1}`) {
    this.scripts.push({ toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
  }
  buildRequest(req: ChatRequest): HttpRequest {
    this.requests.push(req);
    return { url: "https://fake/", method: "POST", headers: {}, body: "{}" };
  }
  parseResponse(): ChatResponse {
    const script = this.scripts[this.index++];
    if (script === undefined) throw new Error("missing fake response");
    const text = script.text ?? "";
    const toolCalls = script.toolCalls ?? [];
    return {
      assistantMessage: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) },
      text, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", raw: {},
    };
  }
  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    return [...messages, ...results.map((result): ChatMessage => ({
      role: "tool", name: result.toolCall.name, toolCallId: result.toolCall.id, content: result.output,
    }))];
  }
  buildStreamRequest(req: ChatRequest) { return this.buildRequest(req); }
  parseStreamEvent(): null { return null; }
  async testConnection() { return { ok: true, latency: 0 }; }
}

// ── 工具定义 ──────────────────────────────

function delegateTaskTool(): ToolDefinition {
  return {
    id: "delegate_task", capability: "delegate_task", name: "委托子任务",
    description: "委托子任务给子代理", enabled: true,
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    hideInPlanMode: true,
    execute: async () => "unused",
  };
}

function webSearchTool(): ToolDefinition {
  return {
    id: "web_search", capability: "web.search", name: "搜索",
    description: "搜索网页", enabled: true,
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async () => "unused",
  };
}

function writeWordTool(): ToolDefinition {
  return {
    id: "write_word", capability: "write_word", name: "写 Word",
    description: "生成 Word 文档", enabled: true,
    inputSchema: {
      type: "object",
      properties: { filename: { type: "string" }, title: { type: "string" }, paragraphs: { type: "array" } },
      required: ["filename", "title", "paragraphs"],
    },
    execute: async () => "unused",
  };
}

const allTools = [delegateTaskTool(), webSearchTool(), writeWordTool()];

// ── 测试辅助 ──────────────────────────────

function defaultOptions(adapter: FakeAdapter, tools = allTools) {
  return {
    settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
    adapter,
    messages: [{ role: "user" as const, content: "搜索AI新闻" }],
    tools,
    toolSystemContent: "TOOL_SYSTEM",
    soulSystemBaseContent: "SOUL_SYSTEM",
    originalQuery: "搜索AI新闻",
    contextualizedQuery: "搜索AI新闻",
    citaContextBlock: "",
    trustedRefs: [],
    timeoutMs: 30_000,
    executeTool: vi.fn(async () => ({
      status: "succeeded" as const,
      output: JSON.stringify({ ok: true }),
    })),
    perCallTimeoutMs: 75000,
  };
}

/** 从 adapter 请求中提取 Action Gate 的 availableCapabilities */
function extractCapabilities(adapter: FakeAdapter): string[] {
  for (const req of adapter.requests) {
    const lastMsg = req.messages.at(-1);
    if (!lastMsg || typeof lastMsg.content !== "string") continue;
    try {
      const parsed = JSON.parse(lastMsg.content);
      if (parsed?.machineInput?.availableCapabilities) {
        return parsed.machineInput.availableCapabilities.map(
          (c: { capability: string }) => c.capability,
        );
      }
    } catch { /* not JSON, skip */ }
  }
  return [];
}

/** 从 adapter 请求中提取 Native FC 的 tools 列表 */
function extractNativeFcTools(adapter: FakeAdapter): string[] {
  // Native FC 请求：messages 中包含 tools 字段的请求
  for (const req of adapter.requests) {
    if (req.tools && req.tools.length > 0) {
      return req.tools.map((t) => t.name);
    }
  }
  return [];
}

beforeEach(() => {
  vi.spyOn(contextRefRegistry, "resolve").mockImplementation((() => ({})) as never);
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

// ── 测试 ──────────────────────────────────

describe("Plan 模式 delegate_task 过滤", () => {
  it("Plan 创建失败降级后：delegate_task 从 Action Gate capabilities 中隐藏", async () => {
    const adapter = new FakeAdapter();
    // Router 返回 plan
    adapter.enqueueJson({ executionMode: "plan", skillIds: [], reason: "多步任务" });
    // createPlan 第一次失败（HTTP 529）
    adapter.enqueueText("ERROR_SIMULATE_529");
    // createPlan 第二次失败（重试也失败）-> fallback to direct
    adapter.enqueueText("ERROR_SIMULATE_529");
    // fallback 后 Action Gate 决策 -> respond
    adapter.enqueueJson({ decision: "respond", reason: "done" });
    // Soul 回复
    adapter.enqueueText("已完成搜索。");

    // fetch 调用顺序：
    // 1. Router LLM（应成功，返回200，消耗 enqueueJson）
    // 2. createPlan 第一次 LLM（529）
    // 3. createPlan 第二次 LLM（529，重试）
    // 4. Action Gate LLM（应成功，返回200，消耗 enqueueJson）
    // 5. Soul LLM（应成功，返回200，消耗 enqueueText）
    let fetchCallCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCallCount++;
      if (fetchCallCount === 2 || fetchCallCount === 3) {
        return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 529,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await runLangGraphAgentLoop(defaultOptions(adapter));

    // 从 Action Gate 请求中提取 capabilities
    const caps = extractCapabilities(adapter);
    // delegate_task 不应在 capabilities 中
    expect(caps).not.toContain("delegate_task");
    // 但 web_search 和 write_word 应该在
    expect(caps).toContain("web.search");
    expect(caps).toContain("write_word");
  });

  it("Plan 创建失败降级后：delegate_task 从 Native FC tools 中隐藏", async () => {
    const adapter = new FakeAdapter();
    // Router 返回 plan
    adapter.enqueueJson({ executionMode: "plan", skillIds: [], reason: "多步任务" });
    // createPlan 两次失败
    adapter.enqueueText("FAIL_1");
    adapter.enqueueText("FAIL_2");
    // fallback 后 Action Gate 决策 -> act（触发 Native FC）
    adapter.enqueueJson({
      decision: "act", capability: "web.search", objective: "搜索",
      targetRefs: [], afterSuccess: "respond",
    });
    // Native FC 生成工具调用
    adapter.enqueueToolCall("web_search", { query: "AI新闻" });
    // Soul 回复
    adapter.enqueueText("搜索完成。");

    // fetch 调用顺序：
    // 1. Router LLM（200）
    // 2. createPlan 第一次（529）
    // 3. createPlan 第二次（529）
    // 4. Action Gate LLM（200）
    // 5. Native FC LLM（200）
    // 6. Soul LLM（200）
    let fetchCallCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCallCount++;
      if (fetchCallCount === 2 || fetchCallCount === 3) {
        return new Response("overloaded", { status: 529 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await runLangGraphAgentLoop(defaultOptions(adapter));

    // 从 Native FC 请求中提取 tools
    const nativeTools = extractNativeFcTools(adapter);
    // delegate_task 不应在 Native FC tools 中
    expect(nativeTools).not.toContain("delegate_task");
    // web_search 应该在
    expect(nativeTools).toContain("web_search");
  });

  it("正常 direct 请求：delegate_task 可见（恢复测试）", async () => {
    const adapter = new FakeAdapter();
    // Router 返回 direct
    adapter.enqueueJson({ executionMode: "direct", skillIds: [], reason: "简单查询" });
    // Action Gate 决策 -> respond
    adapter.enqueueJson({ decision: "respond", reason: "done" });
    // Soul 回复
    adapter.enqueueText("今天天气不错。");

    await runLangGraphAgentLoop({
      ...defaultOptions(adapter),
      originalQuery: "查天气",
      contextualizedQuery: "查天气",
      messages: [{ role: "user", content: "查天气" }],
    });

    const caps = extractCapabilities(adapter);
    // delegate_task 应该在 capabilities 中（direct 模式不隐藏）
    expect(caps).toContain("delegate_task");
    expect(caps).toContain("web.search");
    expect(caps).toContain("write_word");
  });

  it("Plan 降级后第二轮 direct：delegate_task 恢复可见（跨轮无污染）", async () => {
    // ── 第一轮：Plan 失败降级 ──
    const adapter1 = new FakeAdapter();
    adapter1.enqueueJson({ executionMode: "plan", skillIds: [], reason: "多步" });
    adapter1.enqueueText("FAIL");
    adapter1.enqueueText("FAIL");
    adapter1.enqueueJson({ decision: "respond", reason: "done" });
    adapter1.enqueueText("降级完成。");

    let fetchCount1 = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount1++;
      // Router(1) 成功, createPlan(2,3) 失败, Action Gate(4) 成功, Soul(5) 成功
      if (fetchCount1 === 2 || fetchCount1 === 3) return new Response("overloaded", { status: 529 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await runLangGraphAgentLoop(defaultOptions(adapter1));

    // 第一轮：delegate_task 应被隐藏
    const caps1 = extractCapabilities(adapter1);
    expect(caps1).not.toContain("delegate_task");

    // ── 第二轮：正常 direct ──
    const adapter2 = new FakeAdapter();
    adapter2.enqueueJson({ executionMode: "direct", skillIds: [], reason: "简单" });
    adapter2.enqueueJson({ decision: "respond", reason: "done" });
    adapter2.enqueueText("第二轮完成。");

    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    await runLangGraphAgentLoop({
      ...defaultOptions(adapter2),
      originalQuery: "查天气",
      contextualizedQuery: "查天气",
      messages: [{ role: "user", content: "查天气" }],
    });

    // 第二轮：delegate_task 应恢复可见
    const caps2 = extractCapabilities(adapter2);
    expect(caps2).toContain("delegate_task");
  });

  it("工具过滤不原地修改共享 enabledTools 数组", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueJson({ executionMode: "plan", skillIds: [], reason: "多步" });
    adapter.enqueueText("FAIL");
    adapter.enqueueText("FAIL");
    adapter.enqueueJson({ decision: "respond", reason: "done" });
    adapter.enqueueText("完成。");

    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount++;
      // Router(1) 成功, createPlan(2,3) 失败, Action Gate(4) 成功, Soul(5) 成功
      if (fetchCount === 2 || fetchCount === 3) return new Response("overloaded", { status: 529 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // 传入工具数组的引用
    const toolsCopy = [...allTools];
    await runLangGraphAgentLoop({
      ...defaultOptions(adapter),
      tools: toolsCopy,
    });

    // 原始数组不应被修改（filter 创建新数组，不改原数组）
    // 检查 toolsCopy 中每个工具对象的 hideInPlanMode 属性未被删除或修改
    expect(toolsCopy.find((t) => t.id === "delegate_task")?.hideInPlanMode).toBe(true);
    // 数组长度不变
    expect(toolsCopy).toHaveLength(3);
  });
});
