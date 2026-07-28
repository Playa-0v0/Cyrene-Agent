import { describe, expect, it, vi } from "vitest";
import { runAgentGraph, type ActionDecision } from "./agent-graph";
import type { ToolCallResult } from "./types";

function succeeded(toolId: string): ToolCallResult {
  return { toolId, args: {}, output: JSON.stringify({ ok: true }), status: "succeeded", terminal: true, retryable: false };
}

function failed(toolId: string, retryable = false): ToolCallResult {
  return {
    toolId, args: {}, output: "fail", status: "failed",
    errorCode: "E_FAIL", terminal: true, retryable,
  };
}

function succeededNonTerminal(toolId: string): ToolCallResult {
  return { toolId, args: {}, output: JSON.stringify({ ok: true }), status: "succeeded", terminal: false, retryable: false };
}

describe("runAgentGraph", () => {
  it("routes a terminal act success directly to Soul without re-consulting decide", async () => {
    const decisions: ActionDecision[] = [
      { decision: "act", capability: "music.play_track", objective: "播放已选择歌曲", targetRefs: ["ctx_song_1"], afterSuccess: "respond" },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn(async () => [succeeded("music_play_track")]);
    const respond = vi.fn(async (state) => {
      expect(state.toolResults).toHaveLength(1);
      return "已处理";
    });

    const result = await runAgentGraph({
      originalQuery: "播放第一首",
      contextualizedQuery: "播放当前日推第一首",
      citaContextBlock: "[CITA_CONTEXT]",
      messages: [{ role: "user", content: "播放第一首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // routeAfterTool 在工具成功后直接路由到 soul，decide 只调 1 次
    expect(decide).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已处理");
    expect(result.toolResults).toHaveLength(1);
    expect(result.iterationCount).toBe(1);
  });

  it("collects an ask_user answer and re-enters decision routing without using Soul", async () => {
    const decisions: ActionDecision[] = [
      {
        decision: "ask_user",
        reason: "存在多个版本",
        missingFields: [{
          field: "version",
          reason: "歌曲版本不明确",
          required: true,
          typeHint: "single_select",
          candidateHints: ["Live 版", "录音室版"],
          allowCustom: true,
        }],
      },
      { decision: "respond", reason: "已获得用户选择" },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn();
    const askUser = vi.fn(async () => ({
      requestId: "choice-1",
      answers: [{ field: "version", selectedValues: ["Live 版"] }],
    }));
    const respond = vi.fn(async (state) => {
      expect(state.clarificationAnswers).toEqual([{
        requestId: "choice-1",
        answers: [{ field: "version", selectedValues: ["Live 版"] }],
      }]);
      expect(state.messages.at(-1)).toEqual({ role: "user", content: "播放左转灯" });
      return "好的，按 Live 版继续。";
    });

    const result = await runAgentGraph({
      originalQuery: "播放左转灯",
      contextualizedQuery: "播放左转灯，但存在多个版本",
      citaContextBlock: "[CITA_CONTEXT]",
      messages: [{ role: "user", content: "播放左转灯" }],
      availableCapabilities: ["music.search", "music.play_track"],
    }, ({
      decide,
      execute,
      askUser,
      respond,
    } as Parameters<typeof runAgentGraph>[1]));

    expect(execute).not.toHaveBeenCalled();
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe("好的，按 Live 版继续。");
  });

  it("stops an endless act loop at the configured iteration limit", async () => {
    await expect(runAgentGraph({
      originalQuery: "继续尝试",
      contextualizedQuery: "继续尝试",
      citaContextBlock: "",
      messages: [{ role: "user", content: "继续尝试" }],
      availableCapabilities: ["music.play_track"],
    }, {
      decide: async () => ({ decision: "act", capability: "music.play_track", objective: "重试", targetRefs: [], afterSuccess: "replan" as const }),
      execute: async () => [succeeded("music_play_track")],
      respond: async () => "不会到这里",
      maxIterations: 2,
    })).rejects.toMatchObject({ code: "E_AGENT_GRAPH_ITERATION_LIMIT" });
  });

  it("uses its own iteration guard before LangGraph's recursion guard", async () => {
    await expect(runAgentGraph({
      originalQuery: "继续尝试",
      contextualizedQuery: "继续尝试",
      citaContextBlock: "",
      messages: [{ role: "user", content: "继续尝试" }],
      availableCapabilities: ["music.play_track"],
    }, {
      decide: async () => ({ decision: "act", capability: "music.play_track", objective: "重试", targetRefs: [], afterSuccess: "replan" as const }),
      execute: async () => [succeeded("music_play_track")],
      respond: async () => "不会到这里",
      maxIterations: 12,
    })).rejects.toMatchObject({ code: "E_AGENT_GRAPH_ITERATION_LIMIT" });
  });

  it("routes to Soul directly when a terminal act succeeds with afterSuccess=respond", async () => {
    const decide = vi.fn(async () => ({
      decision: "act" as const, capability: "music.play_track", objective: "播放",
      targetRefs: ["ctx_song_1"], afterSuccess: "respond" as const,
    }));
    const execute = vi.fn(async () => [succeeded("music_play_track")]);
    const respond = vi.fn(async () => "已发送播放请求。");

    const result = await runAgentGraph({
      originalQuery: "播放第四首",
      contextualizedQuery: "播放第四首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第四首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // 单步任务：工具成功后 routeAfterTool 直接路由到 soul，decide 只调 1 次
    expect(decide).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已发送播放请求。");
  });

  it("routes back to decide when afterSuccess=replan and the tool succeeded terminally", async () => {
    const decisions: ActionDecision[] = [
      { decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "replan" },
      { decision: "respond", reason: "完成" },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn(async () => [succeeded("music_play_track")]);
    const respond = vi.fn(async () => "完成。");

    const result = await runAgentGraph({
      originalQuery: "播放第一首然后搜索",
      contextualizedQuery: "播放第一首然后搜索",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第一首然后搜索" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // 多步任务：第一次 act+replan 成功后回 decide，第二次 decide 决定 respond
    expect(decide).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("完成。");
  });

  it("routes to Soul directly when a failed tool is not retryable", async () => {
    const decide = vi.fn(async () => ({
      decision: "act" as const, capability: "music.play_track", objective: "播放",
      targetRefs: ["ctx_song_1"], afterSuccess: "respond" as const,
    }));
    const execute = vi.fn(async () => [failed("music_play_track", false)]);
    const respond = vi.fn(async () => "播放失败，请稍后再试。");

    const result = await runAgentGraph({
      originalQuery: "播放第四首",
      contextualizedQuery: "播放第四首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第四首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // 不可重试失败：直接进 soul，不回 decide
    expect(decide).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("播放失败，请稍后再试。");
  });

  it("routes back to decide when a failed tool is retryable", async () => {
    const decisions: ActionDecision[] = [
      { decision: "act", capability: "music.play_track", objective: "播放", targetRefs: ["ctx_song_1"], afterSuccess: "respond" },
      { decision: "respond", reason: "放弃重试" },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn(async () => [failed("music_play_track", true)]);
    const respond = vi.fn(async () => "重试失败。");

    const result = await runAgentGraph({
      originalQuery: "播放第四首",
      contextualizedQuery: "播放第四首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第四首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // 可重试失败：回 decide 让 LLM 决定重试还是放弃
    expect(decide).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("重试失败。");
  });

  it("routes back to decide when a succeeded tool is not terminal", async () => {
    const decisions: ActionDecision[] = [
      { decision: "act", capability: "music.play_track", objective: "开始监听", targetRefs: ["ctx_song_1"], afterSuccess: "respond" },
      { decision: "respond", reason: "完成" },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn(async () => [succeededNonTerminal("music_play_track")]);
    const respond = vi.fn(async () => "完成。");

    const result = await runAgentGraph({
      originalQuery: "开始监听",
      contextualizedQuery: "开始监听",
      citaContextBlock: "",
      messages: [{ role: "user", content: "开始监听" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // terminal=false：回 decide，不直接进 soul
    expect(decide).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("完成。");
  });

  it("routes refresh_state failure to refresh, then back to decide for re-decision", async () => {
    const decisions: ActionDecision[] = [
      { decision: "failure", reason: "action_gate_failed", code: "TARGET_REF_INVALID", disposition: "refresh_state", toolExecuted: false },
      { decision: "respond", reason: "recovered" },
    ];
    const decide = vi.fn(async (state) => {
      // 第二次 decide 应该能看到上一次失败信息
      if (decide.mock.calls.length === 2) {
        expect(state.lastGateFailure).toEqual({ code: "TARGET_REF_INVALID", disposition: "refresh_state" });
      }
      return decisions.shift()!;
    });
    const execute = vi.fn();
    const respond = vi.fn(async () => "已恢复");

    const result = await runAgentGraph({
      originalQuery: "播放第三首",
      contextualizedQuery: "播放第三首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第三首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    expect(decide).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已恢复");
    expect(result.refreshCount).toBe(1);
  });

  it("routes refresh_state to soul when refresh budget is exhausted", async () => {
    const decisions: ActionDecision[] = [
      { decision: "failure", reason: "action_gate_failed", code: "TARGET_REF_INVALID", disposition: "refresh_state", toolExecuted: false },
      { decision: "failure", reason: "action_gate_failed", code: "TARGET_REF_INVALID", disposition: "refresh_state", toolExecuted: false },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn();
    const respond = vi.fn(async () => "失败");

    const result = await runAgentGraph({
      originalQuery: "播放第三首",
      contextualizedQuery: "播放第三首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第三首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond, maxRefresh: 1 });

    // 第一次 failure -> refresh；第二次 failure -> refreshCount 已达上限 -> soul
    expect(decide).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("失败");
    expect(result.refreshCount).toBe(1);
  });

  it("routes fail_closed directly to soul without refresh", async () => {
    const decide = vi.fn(async () => ({
      decision: "failure" as const,
      reason: "action_gate_failed" as const,
      code: "REPAIR_EXHAUSTED",
      disposition: "fail_closed" as const,
      toolExecuted: false as const,
    }));
    const execute = vi.fn();
    const respond = vi.fn(async () => "失败");

    const result = await runAgentGraph({
      originalQuery: "测试",
      contextualizedQuery: "测试",
      citaContextBlock: "",
      messages: [{ role: "user", content: "测试" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // fail_closed 不走 refresh，直接进 soul
    expect(decide).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.refreshCount).toBe(0);
  });

  describe("createPlan retry on temporary request errors", () => {
    function makePlanGoal(goal: string) {
      return {
        id: "plan_1",
        conversationId: "c1",
        goal,
        steps: [{ id: "s1", objective: "步骤一", status: "pending" as const, completionPolicy: { allOf: [{ kind: "tool_succeeded" as const, capabilityId: "x" }] }, toolCallCount: 0, retryCount: 0 }],
        status: "running" as const,
        skillIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    const planRoute = async () => ({
      executionMode: "plan" as const,
      skillIds: [],
      reason: "test",
    });

    it("retries once on HTTP 529 then succeeds", async () => {
      let callCount = 0;
      const createPlan = vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("Plan creation failed: code=MODEL_REQUEST_FAILED HTTP 529");
        return makePlanGoal("成功目标");
      });
      const decide = vi.fn(async () => ({ decision: "respond" as const, reason: "done" }));
      const execute = vi.fn(async () => []);
      const respond = vi.fn(async () => "计划已创建");

      const result = await runAgentGraph({
        originalQuery: "搜索新闻整理文档",
        contextualizedQuery: "搜索新闻整理文档",
        citaContextBlock: "",
        messages: [{ role: "user", content: "搜索新闻整理文档" }],
        availableCapabilities: ["web_search"],
      }, { decide, execute, createPlan, route: planRoute, respond });

      expect(createPlan).toHaveBeenCalledTimes(2);
      expect(result.taskPlan).toBeDefined();
      expect(result.taskPlan!.goal).toBe("成功目标");
    });

    it("does not retry on HTTP 401 (auth failure)", async () => {
      const createPlan = vi.fn(async () => {
        throw new Error("Plan creation failed: code=MODEL_REQUEST_FAILED HTTP 401");
      });
      const decide = vi.fn(async () => ({ decision: "respond" as const, reason: "done" }));
      const execute = vi.fn(async () => []);
      const respond = vi.fn(async () => "降级");

      await runAgentGraph({
        originalQuery: "测试",
        contextualizedQuery: "测试",
        citaContextBlock: "",
        messages: [{ role: "user", content: "测试" }],
        availableCapabilities: ["x"],
      }, { decide, execute, createPlan, route: planRoute, respond });

      expect(createPlan).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledTimes(1);
    });

    it("falls back to direct after two consecutive 529s", async () => {
      const createPlan = vi.fn(async () => {
        throw new Error("Plan creation failed: code=MODEL_REQUEST_FAILED HTTP 529");
      });
      const decide = vi.fn(async () => ({ decision: "respond" as const, reason: "done" }));
      const execute = vi.fn(async () => []);
      const respond = vi.fn(async () => "降级");

      const result = await runAgentGraph({
        originalQuery: "测试",
        contextualizedQuery: "测试",
        citaContextBlock: "",
        messages: [{ role: "user", content: "测试" }],
        availableCapabilities: ["x"],
      }, { decide, execute, createPlan, route: planRoute, respond });

      expect(createPlan).toHaveBeenCalledTimes(2);
      expect(result.taskPlan).toBeUndefined();
      expect(result.taskRoute?.executionMode).toBe("direct");
    });

    it("does not retry on user abort", async () => {
      const abortErr = new Error("E_AGENT_GRAPH_CANCELLED");
      abortErr.name = "AbortError";
      const createPlan = vi.fn(async () => { throw abortErr; });
      const decide = vi.fn(async () => ({ decision: "respond" as const, reason: "done" }));
      const execute = vi.fn(async () => []);
      const respond = vi.fn(async () => "取消");

      await runAgentGraph({
        originalQuery: "测试",
        contextualizedQuery: "测试",
        citaContextBlock: "",
        messages: [{ role: "user", content: "测试" }],
        availableCapabilities: ["x"],
      }, { decide, execute, createPlan, route: planRoute, respond });

      expect(createPlan).toHaveBeenCalledTimes(1);
    });

    it("clears taskPlan on failure so delegate_task is not hidden", async () => {
      const createPlan = vi.fn(async () => {
        throw new Error("Plan creation failed: code=MODEL_REQUEST_FAILED HTTP 529");
      });
      const decide = vi.fn(async () => ({ decision: "respond" as const, reason: "done" }));
      const execute = vi.fn(async () => []);
      const respond = vi.fn(async () => "降级");

      const result = await runAgentGraph({
        originalQuery: "测试",
        contextualizedQuery: "测试",
        citaContextBlock: "",
        messages: [{ role: "user", content: "测试" }],
        availableCapabilities: ["x"],
      }, { decide, execute, createPlan, route: planRoute, respond });

      expect(result.taskPlan).toBeUndefined();
      expect(result.taskRoute?.executionMode).toBe("direct");
    });
  });

  describe("full Plan chain: createPlan → execute → planVerify → soul", () => {
    function makePlanResult(steps: Array<{ id: string; objective: string; capabilityId: string }>) {
      return {
        id: "plan_1",
        conversationId: "c1",
        goal: "测试计划",
        steps: steps.map((s) => ({
          id: s.id,
          objective: s.objective,
          status: "pending" as const,
          completionPolicy: { allOf: [{ kind: "tool_succeeded" as const, capabilityId: s.capabilityId }] },
          toolCallCount: 0,
          retryCount: 0,
        })),
        status: "running" as const,
        skillIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    const planRoute = async () => ({
      executionMode: "plan" as const,
      skillIds: [],
      reason: "test",
    });

    it("completes multi-step plan: step1 → step2 → plan completed → soul", async () => {
      const plan = makePlanResult([
        { id: "s1", objective: "搜索", capabilityId: "web_search" },
        { id: "s2", objective: "整理", capabilityId: "write_word" },
      ]);
      // s1 先 pending，s2 先 pending；planVerify 会依次推进
      let currentStep = "s1";
      let step1Done = false;

      const createPlan = vi.fn(async () => plan);
      const execute = vi.fn(async (_state: unknown, _decision: unknown) => {
        if (currentStep === "s1") return [succeeded("web_search")];
        return [succeeded("write_word")];
      });
      const decide = vi.fn(async () => {
        // Plan 模式下 decide 为当前步骤选择工具
        if (currentStep === "s1") {
          return { decision: "act" as const, capability: "web_search", objective: "搜索", targetRefs: [] as string[], afterSuccess: "respond" as const };
        }
        return { decision: "act" as const, capability: "write_word", objective: "整理", targetRefs: [] as string[], afterSuccess: "respond" as const };
      });
      const planVerify = vi.fn(async () => {
        // 模拟 verifyStep：检查当前步骤是否完成
        if (currentStep === "s1") {
          step1Done = true;
          return { status: "completed" as const };
        }
        return { status: "completed" as const };
      });
      const respond = vi.fn(async () => "计划已完成");

      // 重写 execute 以根据 currentStepId 切换
      const originalExecute = execute;
      const wrappedExecute = vi.fn(async (state, _decision) => {
        currentStep = state.currentStepId ?? "s1";
        return originalExecute(state, _decision);
      });

      const result = await runAgentGraph({
        originalQuery: "搜索新闻整理成文档",
        contextualizedQuery: "搜索新闻整理成文档",
        citaContextBlock: "",
        messages: [{ role: "user", content: "搜索新闻整理成文档" }],
        availableCapabilities: ["web_search", "write_word"],
      }, { decide, execute: wrappedExecute, createPlan, route: planRoute, planVerify, respond });

      // createPlan 应被调用
      expect(createPlan).toHaveBeenCalledTimes(1);
      // planVerify 应被调用2次（每个步骤一次）
      expect(planVerify).toHaveBeenCalledTimes(2);
      // plan 应标记为 completed
      expect(result.taskPlan?.status).toBe("completed");
      // 最终应进入 soul 生成回复
      expect(respond).toHaveBeenCalledTimes(1);
    });

    it("handles step failure → replan → continue with replacement steps", async () => {
      const plan = makePlanResult([
        { id: "s1", objective: "搜索", capabilityId: "web_search" },
        { id: "s2", objective: "失败步骤", capabilityId: "failing_tool" },
        { id: "s3", objective: "整理", capabilityId: "write_word" },
      ]);

      let verifyCallCount = 0;
      let currentStep = "s1";

      const createPlan = vi.fn(async () => plan);
      const execute = vi.fn(async (_state: unknown, _decision: unknown) => {
        if (currentStep === "s1") return [succeeded("web_search")];
        if (currentStep === "s2") return [failed("failing_tool")];
        return [succeeded("write_word")];
      });
      const decide = vi.fn(async () => {
        if (currentStep === "s1") return { decision: "act" as const, capability: "web_search", objective: "搜索", targetRefs: [] as string[], afterSuccess: "respond" as const };
        if (currentStep === "s2") return { decision: "act" as const, capability: "failing_tool", objective: "失败步骤", targetRefs: [] as string[], afterSuccess: "respond" as const };
        return { decision: "act" as const, capability: "write_word", objective: "整理", targetRefs: [] as string[], afterSuccess: "respond" as const };
      });
      const planVerify = vi.fn(async () => {
        verifyCallCount++;
        if (verifyCallCount === 1) return { status: "completed" as const }; // s1 completed
        if (verifyCallCount === 2) return { status: "failed" as const, failureReason: "E_FAIL" }; // s2 failed
        return { status: "completed" as const }; // replacement step completed
      });
      const planReplan = vi.fn(async () => {
        // 返回替代步骤
        return [{
          id: "r1",
          objective: "替代步骤",
          status: "pending" as const,
          completionPolicy: { allOf: [{ kind: "tool_succeeded" as const, capabilityId: "write_word" }] },
          toolCallCount: 0,
          retryCount: 0,
        }];
      });
      const respond = vi.fn(async () => "计划已完成（含重规划）");

      const wrappedExecute = vi.fn(async (state, decision) => {
        currentStep = state.currentStepId ?? "s1";
        return execute(state, decision);
      });

      const result = await runAgentGraph({
        originalQuery: "测试",
        contextualizedQuery: "测试",
        citaContextBlock: "",
        messages: [{ role: "user", content: "测试" }],
        availableCapabilities: ["web_search", "write_word"],
      }, { decide, execute: wrappedExecute, createPlan, route: planRoute, planVerify, planReplan, respond });

      // planReplan 应被调用1次（s2 失败后）
      expect(planReplan).toHaveBeenCalledTimes(1);
      // plan 最终应 completed
      expect(result.taskPlan?.status).toBe("completed");
      // replanCount 应为1
      expect(result.replanCount).toBe(1);
    });
  });
});
