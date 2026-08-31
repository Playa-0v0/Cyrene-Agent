import { describe, expect, it } from "vitest";
import {
  validateSearchApiKey,
  shouldExposeSearchTool,
  filterToolsBySearchBackend,
  BUILTIN_SEARCH_TOOL_ID,
  MINIMAX_SEARCH_TOOL_PREFIX,
  type SearchBackend,
} from "./search-backend-filter";

// ── API Key 校验 ──────────────────────────

describe("validateSearchApiKey", () => {
  it("accepts a valid ASCII key", () => {
    const result = validateSearchApiKey("sk-abc123XYZ", "Test Key");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("sk-abc123XYZ");
    expect(result.diagnostics.hasNonAscii).toBe(false);
    expect(result.diagnostics.hasControlChars).toBe(false);
  });

  it("trims whitespace", () => {
    const result = validateSearchApiKey("  sk-abc123  ", "Test Key");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("sk-abc123");
    expect(result.diagnostics.trimmed).toBe(true);
  });

  it("rejects empty key", () => {
    const result = validateSearchApiKey("", "Test Key");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("不能为空");
  });

  it("rejects whitespace-only key", () => {
    const result = validateSearchApiKey("   ", "Test Key");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("不能为空");
    expect(result.diagnostics.trimmed).toBe(true);
  });

  it("rejects non-ASCII characters", () => {
    const result = validateSearchApiKey("sk-abc中文123", "Test Key");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("非 ASCII");
    expect(result.diagnostics.hasNonAscii).toBe(true);
  });

  it("rejects smart quotes", () => {
    const result = validateSearchApiKey("sk-abc\u201C123", "Test Key");
    expect(result.valid).toBe(false);
    expect(result.diagnostics.hasNonAscii).toBe(true);
  });

  it("rejects control characters", () => {
    const result = validateSearchApiKey("sk-abc\x00123", "Test Key");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("控制字符");
    expect(result.diagnostics.hasControlChars).toBe(true);
  });

  it("rejects newline in key", () => {
    const result = validateSearchApiKey("sk-abc\n123", "Test Key");
    expect(result.valid).toBe(false);
    expect(result.diagnostics.hasControlChars).toBe(true);
  });

  it("rejects tab in key", () => {
    const result = validateSearchApiKey("sk-abc\t123", "Test Key");
    expect(result.valid).toBe(false);
    expect(result.diagnostics.hasControlChars).toBe(true);
  });

  it("diagnostics never contain the raw key", () => {
    const result = validateSearchApiKey("sk-supersecretkey123", "Test Key");
    const diagnosticsSerialized = JSON.stringify(result.diagnostics);
    expect(diagnosticsSerialized).not.toContain("supersecretkey123");
    // diagnostics only have metadata, not the key itself
    expect(result.diagnostics.length).toBe(20);
    expect(result.diagnostics.hasNonAscii).toBe(false);
  });

  it("reports correct length after trim", () => {
    const result = validateSearchApiKey("  abc  ", "Test Key");
    expect(result.diagnostics.length).toBe(3);
  });
});

// ── 搜索工具过滤 ──────────────────────────

describe("shouldExposeSearchTool", () => {
  it("exposes built-in web_search for bocha backend", () => {
    expect(shouldExposeSearchTool(BUILTIN_SEARCH_TOOL_ID, "bocha")).toBe(true);
  });

  it("exposes built-in web_search for tavily backend", () => {
    expect(shouldExposeSearchTool(BUILTIN_SEARCH_TOOL_ID, "tavily")).toBe(true);
  });

  it("hides built-in web_search for minimax backend", () => {
    expect(shouldExposeSearchTool(BUILTIN_SEARCH_TOOL_ID, "minimax")).toBe(false);
  });

  it("hides built-in web_search for off backend", () => {
    expect(shouldExposeSearchTool(BUILTIN_SEARCH_TOOL_ID, "off")).toBe(false);
  });

  it("exposes minimax MCP tool for minimax backend", () => {
    expect(shouldExposeSearchTool("minimax-web-search-web_search", "minimax")).toBe(true);
  });

  it("hides minimax MCP tool for bocha backend", () => {
    expect(shouldExposeSearchTool("minimax-web-search-web_search", "bocha")).toBe(false);
  });

  it("hides minimax MCP tool for tavily backend", () => {
    expect(shouldExposeSearchTool("minimax-web-search-web_search", "tavily")).toBe(false);
  });

  it("hides minimax MCP tool for off backend", () => {
    expect(shouldExposeSearchTool("minimax-web-search-web_search", "off")).toBe(false);
  });

  it("always exposes non-search tools", () => {
    expect(shouldExposeSearchTool("weather", "off")).toBe(true);
    expect(shouldExposeSearchTool("music_search", "minimax")).toBe(true);
    expect(shouldExposeSearchTool("file_create", "bocha")).toBe(true);
  });
});

describe("filterToolsBySearchBackend", () => {
  const tools = [
    { id: "weather" },
    { id: "web_search" },
    { id: "minimax-web-search-web_search" },
    { id: "music_search" },
  ];

  it("minimax backend: only exposes minimax search + non-search tools", () => {
    const filtered = filterToolsBySearchBackend(tools, "minimax");
    expect(filtered.map((t) => t.id)).toEqual(["weather", "minimax-web-search-web_search", "music_search"]);
  });

  it("bocha backend: only exposes built-in search + non-search tools", () => {
    const filtered = filterToolsBySearchBackend(tools, "bocha");
    expect(filtered.map((t) => t.id)).toEqual(["weather", "web_search", "music_search"]);
  });

  it("tavily backend: only exposes built-in search + non-search tools", () => {
    const filtered = filterToolsBySearchBackend(tools, "tavily");
    expect(filtered.map((t) => t.id)).toEqual(["weather", "web_search", "music_search"]);
  });

  it("off backend: hides all search tools", () => {
    const filtered = filterToolsBySearchBackend(tools, "off");
    expect(filtered.map((t) => t.id)).toEqual(["weather", "music_search"]);
  });

  it("stale minimax tool in registry is hidden when backend is bocha", () => {
    const toolsWithStale = [
      { id: "web_search" },
      { id: "minimax-web-search-web_search" }, // stale, should be hidden
    ];
    const filtered = filterToolsBySearchBackend(toolsWithStale, "bocha");
    expect(filtered.map((t) => t.id)).toEqual(["web_search"]);
  });

  it("empty tools list returns empty", () => {
    expect(filterToolsBySearchBackend([], "bocha")).toEqual([]);
  });
});
