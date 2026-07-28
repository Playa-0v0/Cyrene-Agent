import { describe, expect, it, vi } from "vitest";
import {
  matchSkillByName,
  runTaskRouter,
  buildRouterCapabilities,
  ENABLE_TASK_ROUTER,
  type TaskRoute,
  type SkillRouteInfo,
  type RunTaskRouterInput,
} from "./task-router";
import { resolveStructuredOutputProfile } from "./structured-output/profiles";
import type { ToolDefinition } from "./tool-registry";
import type { ChatResponse } from "./vendors/types";

// ── 测试辅助 ──────────────────────────────

const skills: SkillRouteInfo[] = [
  { id: "xlsx", description: "Excel 文档生成" },
  { id: "cyrene-music-companion", description: "音乐搜索与播放", defaultExecutionMode: "direct" },
  { id: "docx", description: "Word 文档生成", defaultExecutionMode: "plan" },
];

const profile = resolveStructuredOutputProfile({
  provider: "chatgpt",
  model: "gpt-5.2",
  transport: "openai",
  endpointKind: "official",
});

function response(value: unknown): ChatResponse {
  const text = JSON.stringify(value);
  return {
    assistantMessage: { role: "assistant", content: text },
    text,
    toolCalls: [],
    finishReason: "stop",
    raw: {},
  };
}

function makeInput(overrides: Partial<RunTaskRouterInput> = {}): RunTaskRouterInput {
  return {
    model: "gpt-5.2",
    originalQuery: "查杭州天气",
    contextualizedQuery: "查询杭州当前天气",
    messages: [{ role: "user", content: "查杭州天气" }],
    availableSkills: skills,
    availableCapabilities: [
      { capabilityId: "weather.lookup", description: "查询天气", hasCompletionEvidence: false },
      { capabilityId: "music.search", description: "搜索歌曲", hasCompletionEvidence: true },
    ],
    profile,
    generate: async () => response({ executionMode: "direct", skillIds: [], reason: "单次查询" }),
    ...overrides,
  };
}

// ── matchSkillByName 测试 ─────────────────

describe("matchSkillByName", () => {
  it("matches '使用 xlsx skill'", () => {
    expect(matchSkillByName("使用 xlsx skill 帮我生成报表", skills)).toBe("xlsx");
  });

  it("matches '调用 docx 技能'", () => {
    expect(matchSkillByName("调用 docx 技能", skills)).toBe("docx");
  });

  it("matches 'cyrene-music-companion skill'", () => {
    expect(matchSkillByName("用 cyrene-music-companion skill", skills)).toBe("cyrene-music-companion");
  });

  it("does not match natural language mentioning Excel", () => {
    expect(matchSkillByName("帮我做个 Excel 报表", skills)).toBeUndefined();
  });

  it("does not match unrelated text", () => {
    expect(matchSkillByName("查杭州天气", skills)).toBeUndefined();
  });
});

// ── buildRouterCapabilities 测试 ──────────

describe("buildRouterCapabilities", () => {
  it("builds capability list with completionEvidence flag", () => {
    const tools: ToolDefinition[] = [
      {
        id: "music_search",
        capability: "music.search",
        name: "搜索",
        description: "搜索歌曲",
        enabled: true,
        inputSchema: { type: "object", properties: {} },
        execute: async () => "",
        completionEvidence: [{ kind: "tool_succeeded" }],
      },
      {
        id: "weather",
        capability: "weather.lookup",
        name: "天气",
        description: "查询天气",
        enabled: true,
        inputSchema: { type: "object", properties: {} },
        execute: async () => "",
      },
    ];
    const caps = buildRouterCapabilities(tools);
    expect(caps).toHaveLength(2);
    expect(caps[0].hasCompletionEvidence).toBe(true);
    expect(caps[1].hasCompletionEvidence).toBe(false);
  });

  it("filters out disabled tools", () => {
    const tools: ToolDefinition[] = [
      { id: "t1", name: "t1", description: "t1", enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => "" },
      { id: "t2", name: "t2", description: "t2", enabled: false, inputSchema: { type: "object", properties: {} }, execute: async () => "" },
    ];
    expect(buildRouterCapabilities(tools)).toHaveLength(1);
  });
});

// ── runTaskRouter 测试 ────────────────────

describe("runTaskRouter", () => {
  it("has feature flag enabled", () => {
    expect(ENABLE_TASK_ROUTER).toBe(true);
  });

  it("uses shortcut path with defaultExecutionMode from metadata", async () => {
    // cyrene-music-companion has defaultExecutionMode: "direct"
    const result = await runTaskRouter(makeInput({
      originalQuery: "使用 cyrene-music-companion skill 播放歌曲",
    }));
    expect(result.executionMode).toBe("direct");
    expect(result.skillIds).toContain("cyrene-music-companion");
    expect(result.reason).toContain("metadata");
  });

  it("uses shortcut path with plan mode from metadata", async () => {
    // docx has defaultExecutionMode: "plan"
    const result = await runTaskRouter(makeInput({
      originalQuery: "使用 docx 技能生成文档",
    }));
    expect(result.executionMode).toBe("plan");
    expect(result.skillIds).toContain("docx");
  });

  it("calls Router LLM when skill matched but no defaultExecutionMode", async () => {
    // xlsx has no defaultExecutionMode
    const generate = vi.fn(async () => response({
      executionMode: "plan",
      skillIds: [],
      reason: "多步文档生成",
    }));
    const result = await runTaskRouter(makeInput({
      originalQuery: "使用 xlsx skill 生成报表",
      generate,
    }));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.executionMode).toBe("plan");
    // preselectedSkillIds should be merged in
    expect(result.skillIds).toContain("xlsx");
  });

  it("calls Router LLM when no skill match", async () => {
    const generate = vi.fn(async () => response({
      executionMode: "direct",
      skillIds: [],
      reason: "单次查询",
    }));
    const result = await runTaskRouter(makeInput({
      originalQuery: "查杭州天气",
      generate,
    }));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.executionMode).toBe("direct");
  });

  it("filters out invalid skillIds from LLM output", async () => {
    const generate = vi.fn(async () => response({
      executionMode: "direct",
      skillIds: ["xlsx", "nonexistent_skill"],
      reason: "test",
    }));
    const result = await runTaskRouter(makeInput({
      originalQuery: "查天气",
      generate,
    }));
    expect(result.skillIds).toContain("xlsx");
    expect(result.skillIds).not.toContain("nonexistent_skill");
  });

  it("falls back to direct on Router LLM failure", async () => {
    const generate = vi.fn(async () => {
      throw new Error("network error");
    });
    const result = await runTaskRouter(makeInput({
      originalQuery: "查天气",
      generate,
    }));
    expect(result.executionMode).toBe("direct");
    expect(result.reason).toContain("fallback");
  });

  it("falls back to direct on invalid LLM output", async () => {
    const generate = vi.fn(async () => response("not an object"));
    const result = await runTaskRouter(makeInput({
      originalQuery: "查天气",
      generate,
    }));
    expect(result.executionMode).toBe("direct");
    expect(result.reason).toContain("fallback");
  });
});
