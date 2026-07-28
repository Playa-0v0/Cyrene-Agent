import { describe, expect, it, vi } from "vitest";
import { resolveNativeToolCall } from "./native-function-calling";
import type { ToolDefinition } from "./tool-registry";
import type { ChatRequest, ChatResponse } from "./vendors/types";

function tool(properties: ToolDefinition["inputSchema"]["properties"] = {}): ToolDefinition {
  return {
    id: "music_search", capability: "music.search", name: "搜索音乐",
    description: "搜索真实歌曲", enabled: true,
    inputSchema: {
      type: "object", properties,
      required: Object.keys(properties),
    },
    execute: async () => "unused",
  };
}

function response(toolCalls: ChatResponse["toolCalls"], text = ""): ChatResponse {
  return {
    assistantMessage: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) },
    text, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", raw: {},
  };
}

describe("resolveNativeToolCall", () => {
  it("passes trusted runtime paths and defaults to native argument generation", async () => {
    const invoke = vi.fn(async (_request: ChatRequest) => response([{
      id: "call-1", name: "music_search", arguments: '{"keyword":"左转灯"}',
    }]));

    await resolveNativeToolCall(({
      model: "m",
      nativeFcSystemPrompt: "test",
      executionBrief: "test",
      runtimeEnvironmentContext: "默认城市：淄博\n桌面：C:\\Users\\13575\\Desktop",
      toolResults: [],
      tool: tool({ keyword: { type: "string" } }),
    } as unknown) as Parameters<typeof resolveNativeToolCall>[0], invoke);

    const system = String(invoke.mock.calls[0]?.[0].messages[0]?.content);
    expect(system).toContain("[TRUSTED_RUNTIME_ENVIRONMENT]");
    expect(system).toContain("C:\\Users\\13575\\Desktop");
  });

  it("executes a zero-argument action without another model request", async () => {
    const invoke = vi.fn<(_: ChatRequest) => Promise<ChatResponse>>();
    const result = await resolveNativeToolCall({
      model: "m", nativeFcSystemPrompt: "test", executionBrief: "test",
      toolResults: [], tool: { ...tool(), id: "music_get_daily_recommendations", capability: "music.daily_recommendations" },
    }, invoke);

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toMatchObject({ name: "music_get_daily_recommendations", arguments: "{}" });
  });

  it("uses one native tool schema and accepts only the Adapter-normalized ToolCall", async () => {
    const invoke = vi.fn(async (request: ChatRequest) => response([{
      id: "call-1", name: "music_search", arguments: '{"keyword":"左转灯"}',
    }]));
    const result = await resolveNativeToolCall({
      model: "m", nativeFcSystemPrompt: "test", executionBrief: "test",
      toolResults: [], tool: tool({ keyword: { type: "string" } }),
    }, invoke);

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      tools: [expect.objectContaining({ name: "music_search" })],
      toolChoiceIntent: { mode: "must_call", toolName: "music_search" },
    }));
    expect(result).toEqual({ id: "call-1", name: "music_search", arguments: '{"keyword":"左转灯"}' });
  });

  it("rejects text pretending to be a function call", async () => {
    const invoke = vi.fn(async () => response([], '{"name":"music_search","arguments":{"keyword":"左转灯"}}'));
    await expect(resolveNativeToolCall({
      model: "m", nativeFcSystemPrompt: "test", executionBrief: "test",
      toolResults: [], tool: tool({ keyword: { type: "string" } }),
    }, invoke)).rejects.toThrow("E_NATIVE_TOOL_PROTOCOL");
  });

  it("accepts first same-name tool call when model returns multiple (MiniMax compatibility)", async () => {
    const invoke = vi.fn(async () => response([
      { id: "call-1", name: "music_search", arguments: '{"keyword":"左转灯"}' },
      { id: "call-2", name: "music_search", arguments: '{"keyword":"右转灯"}' },
    ]));
    const result = await resolveNativeToolCall({
      model: "m", nativeFcSystemPrompt: "test", executionBrief: "test",
      toolResults: [], tool: tool({ keyword: { type: "string" } }),
    }, invoke);

    // 应接受第一个，丢弃第二个
    expect(result).toEqual({ id: "call-1", name: "music_search", arguments: '{"keyword":"左转灯"}' });
  });

  it("rejects when multiple tool calls have different names", async () => {
    const invoke = vi.fn(async () => response([
      { id: "call-1", name: "wrong_tool", arguments: '{}' },
      { id: "call-2", name: "music_search", arguments: '{"keyword":"左转灯"}' },
    ]));
    await expect(resolveNativeToolCall({
      model: "m", nativeFcSystemPrompt: "test", executionBrief: "test",
      toolResults: [], tool: tool({ keyword: { type: "string" } }),
    }, invoke)).rejects.toThrow("E_NATIVE_TOOL_PROTOCOL");
  });
});
