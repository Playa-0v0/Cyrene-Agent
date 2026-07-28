import { describe, expect, it } from "vitest";
import {
  verifyStep,
  computeMaxIterations,
  findNextPendingStep,
  isPlanComplete,
  applyReplan,
  generateStepId,
  type TaskPlan,
  type PlanStep,
  type StepCompletionPolicy,
} from "./task-plan";
import type { ToolCallResult } from "./types";
import type { ToolDefinition } from "./tool-registry";

// ── 测试辅助 ──────────────────────────────

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: generateStepId(),
    objective: "测试步骤",
    status: "running",
    completionPolicy: {},
    toolCallCount: 0,
    retryCount: 0,
    executionId: "exec_test_1",
    ...overrides,
  };
}

function makePlan(steps: PlanStep[]): TaskPlan {
  return {
    id: "plan_test",
    conversationId: "c1",
    goal: "测试目标",
    steps,
    status: "running",
    skillIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function succeededResult(
  toolId: string,
  capabilityId: string,
  stepExecutionId = "exec_test_1",
): ToolCallResult {
  return {
    toolId,
    args: {},
    output: '{"kind":"search","context":{"candidates":[]}}',
    status: "succeeded",
    terminal: true,
    capabilityId,
    stepExecutionId,
  };
}

function failedResult(
  toolId: string,
  capabilityId: string,
  stepExecutionId = "exec_test_1",
): ToolCallResult {
  return {
    toolId,
    args: {},
    output: "error",
    status: "failed",
    terminal: true,
    errorCode: "E_FAIL",
    capabilityId,
    stepExecutionId,
  };
}

function playbackDispatchedResult(stepExecutionId = "exec_test_1"): ToolCallResult {
  return {
    toolId: "music_play_track",
    args: {},
    output: '{"kind":"playback","dispatch":{"state":"dispatched","resourceType":"song","resourceId":"123"}}',
    status: "succeeded",
    terminal: true,
    capabilityId: "music.play_track",
    stepExecutionId,
  };
}

const musicTools: ToolDefinition[] = [
  {
    id: "music_search",
    capability: "music.search",
    name: "搜索",
    description: "搜索歌曲",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "",
    soulProjection: {
      projector: "entity_list",
      source: "trusted_internal",
      itemsPath: "context.candidates",
      fields: { title: "name", artists: "artists" },
    },
  },
  {
    id: "music_play_track",
    capability: "music.play_track",
    name: "播放",
    description: "播放歌曲",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "",
    soulProjection: {
      projector: "action_dispatch",
      source: "trusted_internal",
      statePath: "dispatch.state",
      stateClaims: {
        dispatched: { kind: "request_dispatched" },
        web_fallback: { kind: "browser_opened" },
      },
    },
  },
];

// ── verifyStep 测试 ───────────────────────

describe("verifyStep", () => {
  it("returns completed when allOf tool_succeeded is met", () => {
    const step = makeStep({
      completionPolicy: {
        allOf: [{ kind: "tool_succeeded", capabilityId: "music.search" }],
      },
    });
    const results = [succeededResult("music_search", "music.search")];
    expect(verifyStep(step, results, musicTools)).toEqual({ status: "completed" });
  });

  it("returns running when allOf not yet met", () => {
    const step = makeStep({
      completionPolicy: {
        allOf: [{ kind: "tool_succeeded", capabilityId: "music.search" }],
      },
    });
    expect(verifyStep(step, [], musicTools)).toEqual({ status: "running" });
  });

  it("returns completed when anyOf group has one match (dispatched OR web_fallback)", () => {
    const step = makeStep({
      completionPolicy: {
        anyOf: [[
          { kind: "projection_claim", capabilityId: "music.play_track", claimKind: "request_dispatched" },
          { kind: "projection_claim", capabilityId: "music.play_track", claimKind: "browser_opened" },
        ]],
      },
    });
    const results = [playbackDispatchedResult()];
    expect(verifyStep(step, results, musicTools)).toEqual({ status: "completed" });
  });

  it("returns running when anyOf group has no match", () => {
    const step = makeStep({
      completionPolicy: {
        anyOf: [[
          { kind: "projection_claim", capabilityId: "music.play_track", claimKind: "request_dispatched" },
          { kind: "projection_claim", capabilityId: "music.play_track", claimKind: "browser_opened" },
        ]],
      },
    });
    const results = [succeededResult("music_search", "music.search")];
    expect(verifyStep(step, results, musicTools)).toEqual({ status: "running" });
  });

  it("returns completed when allOf AND anyOf both satisfied", () => {
    const step = makeStep({
      completionPolicy: {
        allOf: [{ kind: "tool_succeeded", capabilityId: "music.search" }],
        anyOf: [[
          { kind: "projection_claim", capabilityId: "music.play_track", claimKind: "request_dispatched" },
          { kind: "projection_claim", capabilityId: "music.play_track", claimKind: "browser_opened" },
        ]],
      },
    });
    const results = [
      succeededResult("music_search", "music.search"),
      playbackDispatchedResult(),
    ];
    expect(verifyStep(step, results, musicTools)).toEqual({ status: "completed" });
  });

  it("returns running when allOf met but anyOf not met", () => {
    const step = makeStep({
      completionPolicy: {
        allOf: [{ kind: "tool_succeeded", capabilityId: "music.search" }],
        anyOf: [[
          { kind: "projection_claim", capabilityId: "music.play_track", claimKind: "request_dispatched" },
        ]],
      },
    });
    const results = [succeededResult("music_search", "music.search")];
    expect(verifyStep(step, results, musicTools)).toEqual({ status: "running" });
  });

  it("returns failed when non-retryable failure exists", () => {
    const step = makeStep({
      completionPolicy: {
        allOf: [{ kind: "tool_succeeded", capabilityId: "music.search" }],
      },
    });
    const results = [failedResult("music_search", "music.search")];
    const result = verifyStep(step, results, musicTools);
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("E_FAIL");
  });

  it("returns completed with no completionPolicy when tool succeeded terminal", () => {
    const step = makeStep({ completionPolicy: {} });
    const results = [succeededResult("music_search", "music.search")];
    expect(verifyStep(step, results, musicTools)).toEqual({ status: "completed" });
  });

  it("only checks results provided by caller (filtering is caller's responsibility)", () => {
    const step = makeStep({
      executionId: "exec_current",
      completionPolicy: {
        allOf: [{ kind: "tool_succeeded", capabilityId: "music.search" }],
      },
    });
    // 调用方过滤掉了旧步骤的结果 -> 空列表 -> running
    expect(verifyStep(step, [], musicTools)).toEqual({ status: "running" });

    // 调用方传入了当前步骤的结果 -> completed
    const currentResults = [succeededResult("music_search", "music.search", "exec_current")];
    expect(verifyStep(step, currentResults, musicTools)).toEqual({ status: "completed" });
  });
});

// ── computeMaxIterations 测试 ─────────────

describe("computeMaxIterations", () => {
  it("returns base iterations when no plan", () => {
    expect(computeMaxIterations(undefined)).toBe(12);
  });

  it("increases with plan steps", () => {
    const plan = makePlan([
      makeStep({ status: "pending" }),
      makeStep({ status: "pending" }),
      makeStep({ status: "pending" }),
      makeStep({ status: "pending" }),
    ]);
    const result = computeMaxIterations(plan);
    expect(result).toBe(12 + 4 * 3); // 24
  });

  it("caps at hard max", () => {
    const plan = makePlan(
      Array.from({ length: 20 }, () => makeStep({ status: "pending" })),
    );
    expect(computeMaxIterations(plan)).toBe(30); // HARD_MAX_ITERATIONS
  });
});

// ── findNextPendingStep 测试 ──────────────

describe("findNextPendingStep", () => {
  it("finds first pending step", () => {
    const plan = makePlan([
      makeStep({ id: "s1", status: "completed" }),
      makeStep({ id: "s2", status: "pending" }),
      makeStep({ id: "s3", status: "pending" }),
    ]);
    expect(findNextPendingStep(plan)?.id).toBe("s2");
  });

  it("finds pending step after specified step", () => {
    const plan = makePlan([
      makeStep({ id: "s1", status: "completed" }),
      makeStep({ id: "s2", status: "completed" }),
      makeStep({ id: "s3", status: "pending" }),
    ]);
    expect(findNextPendingStep(plan, "s2")?.id).toBe("s3");
  });

  it("returns undefined when no pending steps", () => {
    const plan = makePlan([
      makeStep({ id: "s1", status: "completed" }),
    ]);
    expect(findNextPendingStep(plan)).toBeUndefined();
  });
});

// ── isPlanComplete 测试 ───────────────────

describe("isPlanComplete", () => {
  it("returns true when all steps completed", () => {
    const plan = makePlan([
      makeStep({ status: "completed" }),
      makeStep({ status: "completed" }),
    ]);
    expect(isPlanComplete(plan)).toBe(true);
  });

  it("returns true when steps are completed or skipped", () => {
    const plan = makePlan([
      makeStep({ status: "completed" }),
      makeStep({ status: "skipped" }),
    ]);
    expect(isPlanComplete(plan)).toBe(true);
  });

  it("returns false when a step is still running", () => {
    const plan = makePlan([
      makeStep({ status: "completed" }),
      makeStep({ status: "running" }),
    ]);
    expect(isPlanComplete(plan)).toBe(false);
  });

  it("returns true when failed steps are superseded", () => {
    const plan = makePlan([
      makeStep({ status: "completed" }),
      makeStep({ status: "superseded" }),
      makeStep({ status: "completed" }),
    ]);
    expect(isPlanComplete(plan)).toBe(true);
  });
});

// ── applyReplan 测试 ──────────────────────

describe("applyReplan", () => {
  it("marks failed step as superseded and inserts replacements", () => {
    const s1 = makeStep({ id: "s1", status: "completed" });
    const s2 = makeStep({ id: "s2", status: "failed", failure: { message: "创建失败", failedAt: Date.now() } });
    const s3 = makeStep({ id: "s3", status: "pending" });
    const s4 = makeStep({ id: "s4", status: "pending" });
    const plan = makePlan([s1, s2, s3, s4]);

    const r1 = makeStep({ id: "r1", status: "pending", objective: "替代步骤1" });
    const r2 = makeStep({ id: "r2", status: "pending", objective: "替代步骤2" });

    applyReplan(plan, s2, [r1, r2]);

    // s2 应标记为 superseded
    expect(s2.status).toBe("superseded");
    expect(s2.supersededBy).toEqual(["r1", "r2"]);

    // s3, s4 也应标记为 superseded（在 failed 之后）
    expect(s3.status).toBe("superseded");
    expect(s4.status).toBe("superseded");

    // s1 不应被修改
    expect(s1.status).toBe("completed");

    // 替代步骤应插入在 s2 之后
    const stepIds = plan.steps.map((s) => s.id);
    expect(stepIds).toEqual(["s1", "s2", "r1", "r2", "s3", "s4"]);
  });

  it("preserves failure info on superseded step", () => {
    const s1 = makeStep({ id: "s1", status: "failed", failure: { message: "测试失败", failedAt: 12345 } });
    const plan = makePlan([s1]);

    const r1 = makeStep({ id: "r1", status: "pending" });
    applyReplan(plan, s1, [r1]);

    expect(s1.status).toBe("superseded");
    expect(s1.failure?.message).toBe("测试失败");
    expect(s1.failure?.failedAt).toBe(12345);
  });
});
