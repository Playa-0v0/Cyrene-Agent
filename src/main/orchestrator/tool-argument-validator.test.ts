import { describe, expect, it } from "vitest";
import { parseAndValidateToolCallArguments, resolveToolForCapability } from "./tool-argument-validator";
import { controlledInputType, controlledInputKind } from "./tool-registry";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult } from "./types";

function trackTool(): ToolDefinition {
  return {
    id: "music_play_track", capability: "music.play_track", name: "播放歌曲",
    description: "播放可信歌曲候选", enabled: true,
    inputSchema: {
      type: "object", properties: { candidateRef: { type: "string" } }, required: ["candidateRef"],
    },
    controlledInput: { candidateRef: { type: "context_ref", kind: "candidate" } },
    execute: async () => "ok",
  };
}

function trackToolLegacy(): ToolDefinition {
  return {
    id: "music_play_track", capability: "music.play_track", name: "播放歌曲",
    description: "播放可信歌曲候选", enabled: true,
    inputSchema: {
      type: "object", properties: { candidateRef: { type: "string" } }, required: ["candidateRef"],
    },
    controlledInput: { candidateRef: "context_ref" },
    execute: async () => "ok",
  };
}

describe("tool argument validator", () => {
  it("resolves one enabled tool for a capability", () => {
    expect(resolveToolForCapability([trackTool()], "music.play_track").id).toBe("music_play_track");
  });

  it("accepts Adapter-normalized arguments backed by a trusted ContextRef", () => {
    expect(parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_track", arguments: '{"candidateRef":"ctx_song_1"}' },
      trackTool(), ["ctx_song_1"], [],
    )).toEqual({ candidateRef: "ctx_song_1" });
  });

  it("accepts arguments with legacy string controlledInput format", () => {
    expect(parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_track", arguments: '{"candidateRef":"ctx_song_1"}' },
      trackToolLegacy(), ["ctx_song_1"], [],
    )).toEqual({ candidateRef: "ctx_song_1" });
  });

  it("rejects malformed JSON, schema violations and invented controlled refs", () => {
    expect(() => parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_track", arguments: "not json" }, trackTool(), ["ctx_song_1"], [],
    )).toThrow("E_TOOL_ARGUMENT_PROTOCOL");
    expect(() => parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_track", arguments: "{}" }, trackTool(), ["ctx_song_1"], [],
    )).toThrow("E_TOOL_ARGUMENT_SCHEMA");
    expect(() => parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_track", arguments: '{"candidateRef":"invented"}' },
      trackTool(), ["ctx_song_1"], [],
    )).toThrow("E_TOOL_ARGUMENT_SOURCE");
  });

  it("E_TOOL_ARGUMENT_SCHEMA includes specific missing required fields", () => {
    const tool: ToolDefinition = {
      id: "write_word", capability: "write_word", name: "写 Word", description: "生成文档", enabled: true,
      inputSchema: {
        type: "object",
        properties: { filename: { type: "string" }, title: { type: "string" }, paragraphs: { type: "array" } },
        required: ["filename", "title", "paragraphs"],
      },
      execute: async () => "",
    };
    expect(() => parseAndValidateToolCallArguments(
      { id: "call-1", name: "write_word", arguments: '{}' },
      tool, [], [],
    )).toThrow(/missing required fields: filename, title, paragraphs/);
  });

  it("E_TOOL_ARGUMENT_SCHEMA includes specific unknown fields", () => {
    expect(() => parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_track", arguments: '{"candidateRef":"ctx_song_1","foo":"bar"}' },
      trackTool(), ["ctx_song_1"], [],
    )).toThrow(/unknown fields: foo/);
  });

  it("E_TOOL_ARGUMENT_SCHEMA includes field name and type mismatch", () => {
    const tool: ToolDefinition = {
      id: "test_tool", capability: "test", name: "test", description: "test", enabled: true,
      inputSchema: {
        type: "object",
        properties: { count: { type: "number" }, name: { type: "string" } },
        required: ["count", "name"],
      },
      execute: async () => "",
    };
    expect(() => parseAndValidateToolCallArguments(
      { id: "call-1", name: "test_tool", arguments: '{"count":"not_a_number","name":"ok"}' },
      tool, [], [],
    )).toThrow(/field 'count' expected number, got string/);
  });

  it("accepts controlled ids only from successful prior tool results", () => {
    const playlistTool: ToolDefinition = {
      ...trackTool(), id: "music_play_playlist", capability: "music.play_playlist",
      inputSchema: { type: "object", properties: { playlistId: { type: "string" } }, required: ["playlistId"] },
      controlledInput: { playlistId: "tool_result" },
    };
    const results: ToolCallResult[] = [{
      toolId: "music_get_playlist", args: {}, output: '{"playlistId":"playlist-42"}', status: "succeeded",
    }];
    expect(parseAndValidateToolCallArguments(
      { id: "call-1", name: "music_play_playlist", arguments: '{"playlistId":"playlist-42"}' },
      playlistTool, [], results,
    )).toEqual({ playlistId: "playlist-42" });
  });
});

describe("controlledInput helpers", () => {
  it("controlledInputType extracts type from string policy", () => {
    expect(controlledInputType("context_ref")).toBe("context_ref");
    expect(controlledInputType("context_ref_array")).toBe("context_ref_array");
    expect(controlledInputType("tool_result")).toBe("tool_result");
  });

  it("controlledInputType extracts type from object policy", () => {
    expect(controlledInputType({ type: "context_ref", kind: "candidate" })).toBe("context_ref");
    expect(controlledInputType({ type: "context_ref_array", kind: "candidate" })).toBe("context_ref_array");
    expect(controlledInputType({ type: "tool_result" })).toBe("tool_result");
  });

  it("controlledInputKind returns undefined for string policy", () => {
    expect(controlledInputKind("context_ref")).toBeUndefined();
    expect(controlledInputKind("tool_result")).toBeUndefined();
  });

  it("controlledInputKind extracts kind from object policy", () => {
    expect(controlledInputKind({ type: "context_ref", kind: "candidate" })).toBe("candidate");
    expect(controlledInputKind({ type: "context_ref_array", kind: "selection_set" })).toBe("selection_set");
  });

  it("controlledInputKind returns undefined for tool_result object", () => {
    expect(controlledInputKind({ type: "tool_result" })).toBeUndefined();
  });
});
