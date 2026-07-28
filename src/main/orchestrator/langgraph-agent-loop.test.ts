import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./task-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./task-router")>();
  return { ...actual, ENABLE_TASK_ROUTER: false };
});
import { runLangGraphAgentLoop } from "./langgraph-agent-loop";
import { AgentExecutionError } from "./run-execution-status";
import { ExecutionLedger } from "./execution-ledger";
import { contextRefRegistry } from "./tool-context";
import type { ToolDefinition } from "./tool-registry";
import type { TwoPhaseEvent } from "./two-phase-fc-loop";
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
  // id="chatgpt"；测试模型不在已验证 A 档清单，因此固定走 prompt_json。
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
  /** 模拟 Action Gate 的结构化 JSON 文本响应。 */
  enqueueDecision(value: Record<string, unknown>) {
    this.enqueueJson(value);
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

function musicPlayTool(): ToolDefinition {
  return {
    id: "music_play_track", capability: "music.play_track", name: "播放歌曲",
    description: "播放可信歌曲候选", enabled: true,
    inputSchema: {
      type: "object", properties: { candidateRef: { type: "string" } }, required: ["candidateRef"],
    },
    controlledInput: { candidateRef: "context_ref" },
    execute: async () => "unused",
  };
}

function weatherTool(): ToolDefinition {
  return {
    id: "weather", capability: "weather.lookup", name: "查询天气",
    description: "查询指定城市的天气", enabled: true,
    inputSchema: {
      type: "object", properties: { city: { type: "string" } }, required: [],
    },
    execute: async () => "unused",
  };
}

function options(adapter: FakeAdapter, executeTool = vi.fn(async () => ({
  status: "succeeded" as const,
  output: JSON.stringify({ kind: "playback", dispatch: { state: "dispatched" } }),
}))) {
  return {
    settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k" },
    adapter,
    messages: [{ role: "user" as const, content: "播放第一首" }],
    tools: [musicPlayTool()],
    toolSystemContent: "TOOL_SYSTEM",
    soulSystemBaseContent: "SOUL_SYSTEM",
    originalQuery: "播放第一首",
    contextualizedQuery: "播放当前网易云日推第一首",
    citaContextBlock: "ctx_song_1",
    trustedRefs: ["ctx_song_1", "ctx_song_2"],
    timeoutMs: 30_000,
    executeTool,
  };
}

beforeEach(() => {
  // 测试用的 context ref（ctx_song_1 等）未在全局 registry 注册，
  // mock resolve 使引用验证始终通过，让测试聚焦于 agent loop 流程。
  vi.spyOn(contextRefRegistry, "resolve").mockImplementation((() => ({})) as never);
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

describe("runLangGraphAgentLoop native Function Calling runtime", () => {
  it("executes a non-reference tool after discarding an invented target ref", async () => {
    vi.mocked(contextRefRegistry.resolve).mockImplementation(() => {
      throw new Error("unknown ref");
    });
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({
      decision: "act",
      capability: "weather.lookup",
      objective: "查询杭州天气",
      targetRefs: ["杭州"],
      afterSuccess: "respond",
    });
    adapter.enqueueToolCall("weather", { city: "杭州" });
    adapter.enqueueText("杭州今天晴。");
    const executeTool = vi.fn(async () => ({
      status: "succeeded" as const,
      output: JSON.stringify({ city: "杭州", condition: "晴" }),
    }));

    const result = await runLangGraphAgentLoop({
      ...options(adapter, executeTool),
      messages: [{ role: "user", content: "查一下杭州天气" }],
      tools: [weatherTool()],
      originalQuery: "查一下杭州天气",
      contextualizedQuery: "查询杭州当前天气",
      citaContextBlock: "",
      trustedRefs: [],
      runtimeEnvironmentContext: "默认城市：淄博\n桌面：C:\\Users\\13575\\Desktop",
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "weather", arguments: '{"city":"杭州"}' }),
      expect.any(Set),
    );
    const actionGatePayload = JSON.parse(
      String(adapter.requests[0].messages.at(-1)?.content),
    ) as {
      machineInput: {
        availableCapabilities: Array<{
          capability: string;
          referencePolicy: string;
          requiredInputs: string[];
        }>;
        runtimeEnvironmentContext: string;
      };
    };
    expect(actionGatePayload.machineInput.availableCapabilities).toEqual([
      expect.objectContaining({
        capability: "weather.lookup",
        referencePolicy: "none",
        requiredInputs: [],
      }),
    ]);
    expect(actionGatePayload.machineInput.runtimeEnvironmentContext).toContain("默认城市：淄博");
    const nativeRequest = adapter.requests.find(
      (request) => request.toolChoiceIntent?.toolName === "weather",
    );
    expect(nativeRequest?.messages[0]?.content).toContain("C:\\Users\\13575\\Desktop");
    expect(result.reply).toBe("杭州今天晴。");
  });

  it("decides an action, resolves one native ToolCall, then Runtime executes it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // routeAfterTool 在工具成功后直接路由到 soul，不再调 Action Gate
    adapter.enqueueText("已向网易云发送播放请求。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"kind\":\"playback\"}" }));

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "music_play_track", arguments: '{"candidateRef":"ctx_song_1"}' }),
      expect.any(Set),
    );
    // Action Gate 不再带虚拟 tools；这里只筛真实 Native FC 请求。
    const nativeRequests = adapter.requests.filter(
      (request) => request.toolChoiceIntent?.toolName === "music_play_track",
    );
    expect(nativeRequests).toHaveLength(1);
    expect(nativeRequests[0]).toMatchObject({
      toolChoiceIntent: { mode: "must_call", toolName: "music_play_track" },
    });
    expect(result.reply).toBe("已向网易云发送播放请求。");
    const lines = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(lines).toContain("[AgentFlow] 3. 选择动作：调用 music_play_track");
    expect(lines).toContain("[AgentFlow] 4. 生成工具参数：完成（candidateRef）");
    expect(lines).toContain("[AgentFlow] 5. 执行工具：music_play_track");
    expect(lines).toContain("[AgentFlow] 6. 工具结果：成功");
    expect(lines).toContain("[AgentFlow] 7. 生成最终回复");
    expect(lines).not.toContain("[AgentGraph/Trace]");
    expect(lines).not.toContain("[StructuredOutput]");
  });

  it("shows an Action Gate validation failure and that no tool ran", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(contextRefRegistry.resolve).mockImplementation(() => {
      throw new Error("stale ref");
    });
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({
      decision: "act",
      capability: "music.play_track",
      objective: "播放第一首",
      targetRefs: ["stale-ref"],
      afterSuccess: "respond",
    });
    // 重新决策：模型仍选同一过期引用，refresh 预算用尽后转入失败回复
    adapter.enqueueDecision({
      decision: "act",
      capability: "music.play_track",
      objective: "播放第一首",
      targetRefs: ["stale-ref"],
      afterSuccess: "respond",
    });
    adapter.enqueueText("工具没有执行。");
    const executeTool = vi.fn();

    await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).not.toHaveBeenCalled();
    const lines = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(lines).toContain("[AgentFlow] 3. 动作校验失败：TARGET_REF_INVALID");
    expect(lines).toContain("[AgentFlow]    工具未执行；转入失败回复");
  });

  it("recovers from a stale target ref via refresh re-decision", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(contextRefRegistry.resolve).mockImplementation(() => {
      throw new Error("stale ref");
    });
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({
      decision: "act",
      capability: "music.play_track",
      objective: "播放第一首",
      targetRefs: ["stale-ref"],
      afterSuccess: "respond",
    });
    // 重新决策：模型看到 previousGateFailure，改为直接回复
    adapter.enqueueDecision({ decision: "respond", reason: "引用已失效，请重新搜索" });
    adapter.enqueueText("引用已过期了，我帮你重新搜一下好不好？");
    const executeTool = vi.fn();

    await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).not.toHaveBeenCalled();
    const lines = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(lines).toContain("[AgentFlow] 3. 重新决策（上次失败：TARGET_REF_INVALID）");
    expect(lines).toContain("[AgentFlow] 3. 选择动作：直接回复");
  });

  it("uses the choice-card answer to continue from ask_user to tool execution", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({
      decision: "ask_user",
      reason: "版本不明确",
      missingFields: [{
        field: "version",
        reason: "歌曲版本不明确",
        required: true,
        questionHint: "希望播放哪个版本？",
        typeHint: "single_select",
        allowedOptions: [],
        candidateHints: ["Live 版", "录音室版"],
        allowCustom: true,
      }],
    });
    adapter.enqueueJson({
      intro: "伙伴，想播放得更合你心意，还需要选一下版本呀。",
      questions: [{
        field: "version",
        question: "希望播放哪个版本？",
        type: "single_select",
        options: [{ value: "Live 版", label: "Live 版" }],
        allowCustom: true,
        freeTextPlaceholder: "填写其他版本",
      }],
      deferredFields: [],
    });
    adapter.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "播放用户选择的版本", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueText("已按你的选择播放。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "playing" }));
    const requestUserClarification = vi.fn(async () => ({
      requestId: "choice-1",
      answers: [{ field: "version", selectedValues: ["Live 版"] }],
    }));

    const result = await runLangGraphAgentLoop(({
      ...options(adapter, executeTool),
      askSystemContent: "ASK_SYSTEM\n\nASK_PERSONA\n\nASK_QUOTES",
      trustedAskUserProfile: { callPreference: "伙伴", gender: "male" },
      requestUserClarification,
    } as Parameters<typeof runLangGraphAgentLoop>[0]));

    expect(requestUserClarification).toHaveBeenCalledWith(expect.objectContaining({
      intro: "伙伴，想播放得更合你心意，还需要选一下版本呀。",
      questions: [expect.objectContaining({ field: "version" })],
    }));
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已按你的选择播放。");
  });

  it("applies style sampling only to the final Soul request", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "respond", reason: "直接回复" });
    adapter.enqueueText("陪着你呢。");

    await runLangGraphAgentLoop({
      ...options(adapter),
      soulSampling: { temperature: 0.82, frequencyPenalty: 0.2 },
    });

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0].temperature).toBeUndefined();
    expect(adapter.requests[0].frequencyPenalty).toBeUndefined();
    expect(adapter.requests[1].temperature).toBe(0.82);
    expect(adapter.requests[1].frequencyPenalty).toBe(0.2);
  });

  it("repairs a malformed Action Gate JSON once", async () => {
    const adapter = new FakeAdapter();
    // 第一次返回非 JSON，第二次按结构化错误码修复。
    adapter.enqueueText("我直接回复用户");
    adapter.enqueueDecision({ decision: "respond", reason: "ready" });
    adapter.enqueueText("好的。");

    const result = await runLangGraphAgentLoop(options(adapter));

    expect(String(adapter.requests[1].messages.at(-1)?.content)).toContain("repair");
    expect(String(adapter.requests[1].messages.at(-1)?.content)).toContain("NO_JSON_OBJECT");
    expect(result.reply).toBe("好的。");
  });

  it("routes exhausted Action Gate failures to Failure Soul without executing tools", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueText("not json");
    adapter.enqueueText("still not json");
    adapter.enqueueText("again not json");
    adapter.enqueueText("这次没有执行任何操作，请稍后重试。");
    const executeTool = vi.fn();

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.reply).toBe("这次没有执行任何操作，请稍后重试。");
    expect(String(adapter.requests[3].messages[0].content)).toContain("FAILURE_SOUL_POLICY");
    expect(String(adapter.requests[3].messages[0].content)).toContain('"toolExecuted":false');
  });

  it("repairs a native ToolCall whose arguments fail Runtime validation", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_invented" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // routeAfterTool 在工具成功后直接路由到 soul
    adapter.enqueueText("请求已发送。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "ok" }));

    await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(String(adapter.requests[2].messages[0].content)).toContain("E_TOOL_ARGUMENT_SOURCE");
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("stops Native FC after one repair and sends a local non-execution fact to Soul", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({
      decision: "act",
      capability: "music.play_track",
      objective: "播放第一首",
      targetRefs: ["ctx_song_1"],
      afterSuccess: "respond",
    });
    adapter.enqueueText("pretend tool call");
    adapter.enqueueText("still no real tool call");
    adapter.enqueueText("工具参数没有可靠生成，所以没有执行播放。");
    const executeTool = vi.fn();

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.toolResults).toContainEqual(expect.objectContaining({
      status: "failed",
      errorCode: "E_NATIVE_TOOL_PROTOCOL",
      toolExecuted: false,
      retryable: false,
    }));
    expect(String(adapter.requests[3].messages[0].content)).toContain("FAILURE_SOUL_POLICY");
    expect(String(adapter.requests[3].messages[0].content)).toContain('"toolExecuted":false');
  });

  it("feeds failed execution facts back so the model can explicitly retry", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "重试播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // routeAfterTool 在第二次（succeeded）后直接路由到 soul
    adapter.enqueueText("第二次请求成功发送。");
    const executeTool = vi.fn()
      .mockResolvedValueOnce({ status: "failed" as const, errorCode: "E_LAUNCH_FAILED", output: "启动失败", retryable: true })
      .mockResolvedValueOnce({ status: "succeeded" as const, output: "{\"ok\":true}" });

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.toolResults.map((item) => item.status)).toEqual(["failed", "succeeded"]);
    expect(String(adapter.requests[2].messages.at(-1)?.content)).toContain("E_LAUNCH_FAILED");
  });

  it("does not repeat a successful side effect because routeAfterTool routes directly to Soul", async () => {
    // 新主路径：act 成功后 routeAfterTool 直接路由到 soul，模型没有机会再次输出相同 act。
    // ExecutionLedger 的去重 / forced_respond 不再承担正常终止职责。
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueText("请求已发送。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"ok\":true}" }));

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("请求已发送。");
  });

  it("forces respond on a deduplicated terminal action as a fallback (routeAfterTool -> decide -> duplicate)", async () => {
    // 异常兜底路径：routeAfterTool 因为 afterSuccess=replan 回到 decide，
    // 模型又重复同一动作 -> execute 命中缓存 deduplicated=true -> forced_respond 不调 LLM。
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "播放", targetRefs: ["ctx_song_1"], afterSuccess: "replan" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // replan 后模型重复同一动作（相同 capability+targetRefs+args）
    adapter.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "再播放", targetRefs: ["ctx_song_1"], afterSuccess: "replan" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // execute 命中缓存 deduplicated=true -> routeAfterTool 看到 succeeded+terminal+respond(默认) -> soul
    // （注意：replan 只在第一次 act 声明；第二次 act 也声明 replan，但 routeAfterTool 仍会路由到 soul，
    //  因为 deduplicated=true 时 forced_respond 在 decide 里已经触发，不会到 routeAfterTool。
    //  实际上：第二次 execute 返回 deduplicated=true，streak=1，routeAfterTool 看到 succeeded+terminal+replan -> decide，
    //  decide 看到 deduplicated -> forced_respond -> soul）
    adapter.enqueueText("已发送播放请求。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"ok\":true}" }));

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已发送播放请求。");
  });

  it("still allows a different action after a successful terminal action with afterSuccess=replan", async () => {
    // 多步任务：第 1 次 play(ctx_song_1) 成功 + afterSuccess=replan -> routeAfterTool 回 decide
    // -> 第 2 次 play(ctx_song_2) 指纹不同，cached=false，正常执行 -> respond
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "replan" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    adapter.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "播放第二首", targetRefs: ["ctx_song_2"], afterSuccess: "respond" });
    adapter.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_2" });
    adapter.enqueueText("完成。");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"ok\":true}" }));

    const result = await runLangGraphAgentLoop(options(adapter, executeTool));

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe("完成。");
  });

  it("does not repeat a successful side effect when Soul fails and the same turn is retried", async () => {
    const ledger = new ExecutionLedger();
    const first = new FakeAdapter();
    first.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    first.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // routeAfterTool 在工具成功后直接路由到 soul，不调 Action Gate
    first.enqueueText("不会送达的 Soul 回复");
    const executeTool = vi.fn(async () => ({ status: "succeeded" as const, output: "{\"ok\":true}" }));
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("soul failed", { status: 500 })) as unknown as typeof fetch;

    // Soul 失败但工具成功 → 部分成功 fallback（不抛错）
    const firstResult = await runLangGraphAgentLoop({ ...options(first, executeTool), executionLedger: ledger });
    expect(firstResult.reply).toContain("部分操作已经完成");
    expect(firstResult.soulPhaseReason).toBe("tool_error");

    const retry = new FakeAdapter();
    retry.enqueueDecision({ decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "respond" });
    retry.enqueueToolCall("music_play_track", { candidateRef: "ctx_song_1" });
    // 重试时 execute 命中 ledger 缓存 -> deduplicated=true -> forced_respond 不调 LLM -> soul
    retry.enqueueText("已向网易云发送播放请求。");
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const result = await runLangGraphAgentLoop({ ...options(retry, executeTool), executionLedger: ledger });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已向网易云发送播放请求。");
  });

  it("preserves image-caption fallback for the first JSON decision request", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({
      decision: "ask_user",
      reason: "图片信息不足",
      missingFields: [{
        field: "image_detail",
        reason: "图片细节不足",
        required: true,
        questionHint: "可以再描述一下图片吗？",
        typeHint: "text",
        allowedOptions: [],
        candidateHints: [],
        allowCustom: false,
      }],
    });
    adapter.enqueueText("你可以再描述一下图片吗？");
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("unsupported image", { status: 400 }))
      .mockImplementation(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const imageCaptionFallback = vi.fn(async (): Promise<ChatMessage[]> => [
      { role: "user", content: "[图片描述] 一张夜景照片" },
    ]);

    await runLangGraphAgentLoop({ ...options(adapter), imageCaptionFallback });

    expect(imageCaptionFallback).toHaveBeenCalledTimes(1);
    expect(adapter.requests[1].messages).toContainEqual({ role: "user", content: "[图片描述] 一张夜景照片" });
  });

  it("strips MiniMax uffff-delimited tool protocol leak from Soul reply", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "respond", reason: "done" });
    // Soul 回复中泄漏了 MiniMax 工具协议文本（\uffff 分隔 + 中文标签）
    adapter.enqueueText("\uffff\uffff[系统提示] 请按以下 JSON 格式输出工具调用：\n{\"action\":\"music_play_track\"}\uffff[工具调用]\uffff[{\"type\":\"function\"}]\uffff[工具结果]\uffff{\"error\":\"不可用\"}");
    const executeTool = vi.fn();
    const events: TwoPhaseEvent[] = [];
    await runLangGraphAgentLoop({ ...options(adapter, executeTool), onEvent: (e) => events.push(e) });

    // 泄漏文本被清空后应触发兜底回复，不应包含协议原文
    const textEvents = events.filter((e) => e.type === "text_message_content");
    const reply = textEvents.map((e) => (e as { delta?: string }).delta).join("");
    expect(reply).not.toContain("\uffff");
    expect(reply).not.toContain("[系统提示]");
    expect(reply).not.toContain("[工具调用]");
  });

  it("AgentExecutionError preserves cause and executionStatus on Soul failure", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "respond", reason: "done" });
    // Soul LLM 返回 500
    globalThis.fetch = vi.fn(async () => new Response("soul failed", { status: 500 })) as unknown as typeof fetch;

    try {
      await runLangGraphAgentLoop(options(adapter));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentExecutionError);
      const execErr = err as AgentExecutionError;
      expect(execErr.executionStatus.phase).toBe("soul");
      // cause 应保留原始错误
      expect(execErr.cause).toBeDefined();
    }
  });

  it("AgentExecutionError does not double-wrap", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "respond", reason: "done" });
    globalThis.fetch = vi.fn(async () => new Response("soul failed", { status: 500 })) as unknown as typeof fetch;

    try {
      await runLangGraphAgentLoop(options(adapter));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentExecutionError);
      // cause 不应该是另一个 AgentExecutionError
      const execErr = err as AgentExecutionError;
      expect(execErr.cause).not.toBeInstanceOf(AgentExecutionError);
    }
  });

  it("Soul failure + successful tool → partial success fallback (not throw)", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "act", capability: "weather.lookup", objective: "查天气", targetRefs: [], afterSuccess: "respond" });
    adapter.enqueueToolCall("weather", { city: "杭州" });
    adapter.enqueueText("Soul 会失败");
    const executeTool = vi.fn(async () => ({
      status: "succeeded" as const,
      output: JSON.stringify({ city: "杭州", weather: "晴", temperature: "25°C" }),
    }));
    // Action Gate(1) 成功, Native FC(2) 成功, Soul(3) 失败
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount++;
      if (fetchCount === 3) return new Response("soul failed", { status: 529 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runLangGraphAgentLoop({
      ...options(adapter, executeTool),
      tools: [weatherTool()],
    });

    // 应返回部分成功回复，不抛错
    expect(result.reply).toContain("部分操作已经完成");
    expect(result.reply).toContain("查询天气");
    expect(result.soulPhaseReason).toBe("tool_error");
  });

  it("Soul failure + file artifact → partial success mentions file path", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "act", capability: "write_word", objective: "写文档", targetRefs: [], afterSuccess: "respond" });
    adapter.enqueueToolCall("write_word", { filename: "test.docx", title: "测试", paragraphs: ["内容"] });
    adapter.enqueueText("Soul 会失败");
    const writeWordTool: ToolDefinition = {
      id: "write_word", capability: "write_word", name: "写 Word",
      description: "生成文档", enabled: true,
      inputSchema: { type: "object", properties: { filename: { type: "string" }, title: { type: "string" }, paragraphs: { type: "array" } }, required: ["filename", "title", "paragraphs"] },
      completionEvidence: [{ kind: "tool_succeeded" }],
      execute: async () => "unused",
    };
    const executeTool = vi.fn(async () => ({
      status: "succeeded" as const,
      output: "[write_word] 已生成：C:\\Users\\test\\Desktop\\test.docx",
    }));
    // Action Gate(1) 成功, Native FC(2) 成功, Soul(3) 失败
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount++;
      if (fetchCount === 3) return new Response("soul failed", { status: 529 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runLangGraphAgentLoop({
      ...options(adapter, executeTool),
      tools: [writeWordTool],
    });

    expect(result.reply).toContain("部分操作已经完成");
    expect(result.reply).toContain("test.docx");
  });

  it("Soul failure + no successful tools → throws AgentExecutionError (no fallback)", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "respond", reason: "done" });
    // Soul 直接失败，没有工具执行
    globalThis.fetch = vi.fn(async () => new Response("soul failed", { status: 529 })) as unknown as typeof fetch;

    await expect(runLangGraphAgentLoop(options(adapter))).rejects.toThrow("LangGraph execution failed");
  });

  it("user cancel → does not trigger partial fallback", async () => {
    const adapter = new FakeAdapter();
    adapter.enqueueDecision({ decision: "act", capability: "weather.lookup", objective: "查天气", targetRefs: [], afterSuccess: "respond" });
    adapter.enqueueToolCall("weather", { city: "杭州" });
    adapter.enqueueText("Soul 会失败");
    const executeTool = vi.fn(async () => ({
      status: "succeeded" as const,
      output: JSON.stringify({ city: "杭州", weather: "晴" }),
    }));
    // 模拟用户取消：signal 在 Soul 调用前已 abort → ensureBudget 抛 E_AGENT_GRAPH_CANCELLED
    const abortController = new AbortController();
    abortController.abort();
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    await expect(runLangGraphAgentLoop({
      ...options(adapter, executeTool),
      tools: [weatherTool()],
      signal: abortController.signal,
    })).rejects.toThrow();
  });
});
