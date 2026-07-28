/**
 * Task Plan -- 执行计划数据结构与逻辑。
 *
 * 包含 TaskPlan / PlanStep / StepCompletionPolicy 类型定义，
 * 以及 createPlan（计划创建）、verifyStep（步骤验证）、replan（重规划）的核心逻辑。
 *
 * 标识层级：
 *   planId -> stepId -> stepExecutionId -> stepAttemptId
 *
 * 预算体系：
 *   toolCallCount (≤ maxStepToolCalls) -> retryCount (≤ maxStepRetries) -> replanCount (≤ maxReplans) -> maxIterations
 */

import { runStructuredOutput } from "./structured-output/runner";
import type { StructuredOutputProfile } from "./structured-output/types";
import type { ChatMessage, ChatRequest, ChatResponse } from "./vendors/types";
import type { ToolCallResult } from "./types";
import type { ToolDefinition } from "./tool-registry";
import type { SoulClaimKind } from "./soul-execution-context";
import { projectToolResult } from "./soul-execution-context";

// ── 预算默认值 ────────────────────────────

export const DEFAULT_MAX_STEP_TOOL_CALLS = 4;
export const DEFAULT_MAX_STEP_RETRIES = 2;
export const DEFAULT_MAX_REPLANS = 2;
export const HARD_MAX_ITERATIONS = 30;
export const BASE_ITERATIONS = 12;
export const ITERATIONS_PER_STEP = 3;

// ── 数据结构 ──────────────────────────────

export type CompletionCriterion =
  | { kind: "tool_succeeded"; capabilityId: string }
  | { kind: "projection_claim"; capabilityId?: string; claimKind: SoulClaimKind };

export interface StepCompletionPolicy {
  /** 必须全部满足 */
  allOf?: CompletionCriterion[];
  /** 每个分组至少满足一项 */
  anyOf?: CompletionCriterion[][];
}

export interface StepFailure {
  errorCode?: string;
  message: string;
  failedAt: number;
}

export interface PlanStep {
  id: string;
  objective: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "superseded";
  completionPolicy: StepCompletionPolicy;
  /** 步骤执行周期 ID（从开始到完成/失败） */
  executionId?: string;
  /** 实际工具调用次数 */
  toolCallCount: number;
  /** 失败后重试次数 */
  retryCount: number;
  /** 失败信息（superseded 后保留） */
  failure?: StepFailure;
  /** 被哪些替代步骤取代 */
  supersededBy?: string[];
}

export interface TaskPlan {
  id: string;
  conversationId: string;
  goal: string;
  steps: PlanStep[];
  status: "running" | "awaiting_user" | "paused" | "completed" | "failed" | "cancelled";
  skillIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PendingTaskSwitch {
  userRequest: string;
  contextualizedRequest?: string;
  proposedRoute?: import("./task-router").TaskRoute;
  createdAt: number;
}

// ── 前端进度卡快照 ────────────────────────

export interface TaskPlanSnapshot {
  planId: string;
  goal: string;
  planStatus: TaskPlan["status"];
  steps: Array<{
    stepId: string;
    objective: string;
    status: PlanStep["status"];
    failureMessage?: string;
  }>;
  replanCount: number;
  timestamp: number;
}

export function buildPlanSnapshot(
  plan: TaskPlan,
  replanCount: number,
): TaskPlanSnapshot {
  return {
    planId: plan.id,
    goal: plan.goal,
    planStatus: plan.status,
    steps: plan.steps.map((s) => ({
      stepId: s.id,
      objective: s.objective,
      status: s.status,
      ...(s.failure?.message ? { failureMessage: s.failure.message } : {}),
    })),
    replanCount,
    timestamp: Date.now(),
  };
}

// ── 动态 maxIterations ────────────────────

export function computeMaxIterations(plan: TaskPlan | undefined): number {
  if (!plan) return BASE_ITERATIONS;
  return Math.min(
    HARD_MAX_ITERATIONS,
    BASE_ITERATIONS + plan.steps.length * ITERATIONS_PER_STEP,
  );
}

// ── 步骤 ID 生成 ──────────────────────────

let stepIdCounter = 0;
export function generateStepId(): string {
  return `s${++stepIdCounter}`;
}

let executionIdCounter = 0;
export function generateExecutionId(): string {
  return `exec_${++executionIdCounter}_${Date.now()}`;
}

let attemptIdCounter = 0;
export function generateAttemptId(): string {
  return `att_${++attemptIdCounter}_${Date.now()}`;
}

let planIdCounter = 0;
export function generatePlanId(): string {
  return `plan_${++planIdCounter}_${Date.now()}`;
}

// ── 步骤查找 ──────────────────────────────

export function findStep(plan: TaskPlan, stepId: string | undefined): PlanStep | undefined {
  if (!stepId) return undefined;
  return plan.steps.find((s) => s.id === stepId);
}

export function findCurrentStep(plan: TaskPlan, currentStepId: string | undefined): PlanStep | undefined {
  return findStep(plan, currentStepId);
}

export function findNextPendingStep(plan: TaskPlan, afterStepId?: string): PlanStep | undefined {
  let foundAfter = !afterStepId;
  for (const step of plan.steps) {
    if (!foundAfter) {
      if (step.id === afterStepId) foundAfter = true;
      continue;
    }
    if (step.status === "pending") return step;
  }
  return undefined;
}

// ── planVerify：完成条件检查 ──────────────

export interface StepVerificationResult {
  status: "completed" | "failed" | "running";
  failureReason?: string;
}

export function verifyStep(
  step: PlanStep,
  stepResults: ToolCallResult[],
  tools: ToolDefinition[],
): StepVerificationResult {
  const toolMap = new Map(tools.map((t) => [t.id, t]));

  // 检查是否有不可重试的失败
  const hasNonRetryableFailure = stepResults.some(
    (r) => r.status === "failed" && !r.retryable,
  );
  if (hasNonRetryableFailure) {
    const failed = stepResults.find((r) => r.status === "failed" && !r.retryable);
    return {
      status: "failed",
      failureReason: failed?.errorCode ?? "工具执行失败",
    };
  }

  // 检查完成条件
  const policy = step.completionPolicy;
  if (!policy.allOf && !policy.anyOf) {
    // 没有完成条件：工具成功且终态即完成
    const hasSuccess = stepResults.some((r) => r.status === "succeeded" && r.terminal !== false);
    return hasSuccess ? { status: "completed" } : { status: "running" };
  }

  // allOf: 所有条件必须满足
  if (policy.allOf) {
    for (const criterion of policy.allOf) {
      if (!checkCriterion(criterion, stepResults, toolMap)) {
        return { status: "running" };
      }
    }
  }

  // anyOf: 每个分组至少满足一项
  if (policy.anyOf) {
    for (const group of policy.anyOf) {
      const anySatisfied = group.some((c) => checkCriterion(c, stepResults, toolMap));
      if (!anySatisfied) {
        return { status: "running" };
      }
    }
  }

  return { status: "completed" };
}

function checkCriterion(
  criterion: CompletionCriterion,
  results: ToolCallResult[],
  toolMap: Map<string, ToolDefinition>,
): boolean {
  if (criterion.kind === "tool_succeeded") {
    return results.some(
      (r) => r.status === "succeeded" && (r.capabilityId === criterion.capabilityId || r.toolId === criterion.capabilityId),
    );
  }
  // projection_claim: 用共享投影函数检查
  for (const result of results) {
    if (result.status !== "succeeded") continue;
    const tool = toolMap.get(result.toolId);
    const projection = projectToolResult(result, tool);
    if (!projection) continue;
    if (projection.kind === "action_dispatch" || projection.kind === "action_completed") {
      if (projection.claim.kind === criterion.claimKind) {
        if (!criterion.capabilityId) return true;
        if (result.capabilityId === criterion.capabilityId || result.toolId === criterion.capabilityId) {
          return true;
        }
      }
    }
  }
  return false;
}

// ── createPlan：计划创建 LLM 调用 ─────────

export interface RunCreatePlanInput {
  model: string;
  userRequest: string;
  contextualizedQuery: string;
  messages: ChatMessage[];
  availableCapabilities: Array<{
    capabilityId: string;
    description: string;
    completionEvidence: Array<{ kind: string; claimKind?: string }>;
  }>;
  loadedSkillInstructions?: string;
  conversationId: string;
  skillIds: string[];
  profile: StructuredOutputProfile;
  generate: (request: ChatRequest, signal: AbortSignal) => Promise<ChatResponse>;
  signal?: AbortSignal;
}

const PLANNER_SYSTEM_PROMPT = `你是 Planner，负责为当前任务创建执行计划。

## 规则
- 每个步骤必须能够映射到工具动作或产生明确 projection claim。
- 不允许生成纯思考步骤（如"分析结果""比较来源"），纯分析被包含在产物生成动作中。
- 3-7 步为宜，不过度拆分。
- 每个步骤的 objective 要具体、可验证。
- completionPolicy 使用 allOf（全部满足）和 anyOf（每组至少满足一项）。
- 互斥证据（如 dispatched 和 web_fallback）放在同一个 anyOf 分组中。

## 输出格式
返回 JSON：
{
  "goal": "任务最终目标",
  "steps": [
    {
      "objective": "步骤目标",
      "completionPolicy": {
        "allOf": [{ "kind": "tool_succeeded", "capabilityId": "..." }],
        "anyOf": [[{ "kind": "projection_claim", "capabilityId": "...", "claimKind": "..." }]]
      }
    }
  ]
}`;

function planSchema(): object {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      goal: { type: "string", minLength: 1, maxLength: 500 },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            objective: { type: "string", minLength: 1, maxLength: 300 },
            completionPolicy: {
              type: "object",
              properties: {
                allOf: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      kind: { type: "string", enum: ["tool_succeeded", "projection_claim"] },
                      capabilityId: { type: "string" },
                      claimKind: { type: "string" },
                    },
                    required: ["kind"],
                  },
                },
                anyOf: {
                  type: "array",
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        kind: { type: "string", enum: ["tool_succeeded", "projection_claim"] },
                        capabilityId: { type: "string" },
                        claimKind: { type: "string" },
                      },
                      required: ["kind"],
                    },
                  },
                },
              },
            },
          },
          required: ["objective", "completionPolicy"],
        },
      },
    },
    required: ["goal", "steps"],
  };
}

function parsePlan(value: unknown, skillIds: string[], conversationId: string): TaskPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TaskPlan must be an object");
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.goal !== "string" || obj.goal.trim().length === 0) {
    throw new Error("goal is invalid");
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0 || obj.steps.length > 10) {
    throw new Error("steps is invalid");
  }

  const steps: PlanStep[] = obj.steps.map((raw, index) => {
    const s = raw as Record<string, unknown>;
    if (typeof s.objective !== "string" || s.objective.trim().length === 0) {
      throw new Error(`step ${index} objective is invalid`);
    }
    const policy = parseCompletionPolicy(s.completionPolicy);
    return {
      id: generateStepId(),
      objective: s.objective.trim(),
      status: "pending" as const,
      completionPolicy: policy,
      toolCallCount: 0,
      retryCount: 0,
    };
  });

  const now = Date.now();
  return {
    id: generatePlanId(),
    conversationId,
    goal: obj.goal.trim(),
    steps,
    status: "running",
    skillIds,
    createdAt: now,
    updatedAt: now,
  };
}

function parseCompletionPolicy(value: unknown): StepCompletionPolicy {
  if (!value || typeof value !== "object") {
    throw new Error("completionPolicy is invalid");
  }
  const obj = value as Record<string, unknown>;
  const policy: StepCompletionPolicy = {};

  if (Array.isArray(obj.allOf)) {
    policy.allOf = obj.allOf.map(parseCriterion);
  }
  if (Array.isArray(obj.anyOf)) {
    policy.anyOf = obj.anyOf.map((group) =>
      Array.isArray(group) ? group.map(parseCriterion) : [],
    ).filter((g) => g.length > 0);
  }

  if (!policy.allOf && !policy.anyOf) {
    throw new Error("completionPolicy must have allOf or anyOf");
  }
  return policy;
}

function parseCriterion(value: unknown): CompletionCriterion {
  if (!value || typeof value !== "object") {
    throw new Error("criterion is invalid");
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind === "tool_succeeded") {
    if (typeof obj.capabilityId !== "string") throw new Error("tool_succeeded requires capabilityId");
    return { kind: "tool_succeeded", capabilityId: obj.capabilityId };
  }
  if (obj.kind === "projection_claim") {
    if (typeof obj.claimKind !== "string") throw new Error("projection_claim requires claimKind");
    return {
      kind: "projection_claim",
      ...(typeof obj.capabilityId === "string" ? { capabilityId: obj.capabilityId } : {}),
      claimKind: obj.claimKind as SoulClaimKind,
    };
  }
  throw new Error("criterion kind is invalid");
}

export async function runCreatePlan(input: RunCreatePlanInput): Promise<TaskPlan> {
  const evidenceCatalog = input.availableCapabilities
    .filter((c) => c.completionEvidence.length > 0)
    .map((c) => ({
      capabilityId: c.capabilityId,
      description: c.description,
      availableEvidence: c.completionEvidence,
    }));

  const userContent = JSON.stringify({
    userRequest: input.userRequest.slice(0, 500),
    contextualizedQuery: input.contextualizedQuery.slice(0, 500),
    availableCapabilities: evidenceCatalog,
    loadedSkills: input.loadedSkillInstructions?.slice(0, 6000) ?? "（无）",
  });

  const structuredOutput = input.profile.mode === "provider_json_schema"
    ? { mode: "json_schema" as const, name: "task_plan", schema: planSchema(), strict: true }
    : input.profile.mode === "provider_json_object"
      ? { mode: "json_object" as const }
      : { mode: "prompt_json" as const, sendJsonObjectHint: input.profile.requestHints.sendJsonObject };

  const request: ChatRequest = {
    model: input.model,
    messages: [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      ...input.messages.slice(-6),
      { role: "user", content: userContent },
    ],
    stream: false,
    maxTokens: 1200,
    structuredOutput,
  };

  const result = await runStructuredOutput<TaskPlan, ChatRequest>({
    stage: "action_gate",
    profile: input.profile,
    signal: input.signal,
    buildRequest: () => request,
    generate: async (req, signal) => {
      const response = await input.generate(req, signal);
      return { text: response.text, finishReason: response.finishReason, refusal: response.refusal };
    },
    parseSchema: (value) => parsePlan(value, input.skillIds, input.conversationId),
    validateBusiness: (plan) => ({ status: "accepted", value: plan }),
  });

  if (result.outcome === "success") return result.value;
  const failCode = result.failure.code;
  const failDisp = result.failure.disposition;
  throw new Error(`Plan creation failed: code=${failCode} disposition=${failDisp} attempts=${result.failure.attempts}`);
}

// ── replan：重规划 ────────────────────────

export interface RunReplanInput {
  model: string;
  plan: TaskPlan;
  failedStep: PlanStep;
  errorMessage: string;
  messages: ChatMessage[];
  availableCapabilities: Array<{
    capabilityId: string;
    description: string;
    completionEvidence: Array<{ kind: string; claimKind?: string }>;
  }>;
  profile: StructuredOutputProfile;
  generate: (request: ChatRequest, signal: AbortSignal) => Promise<ChatResponse>;
  signal?: AbortSignal;
}

const REPLANNER_SYSTEM_PROMPT = `你是 Replanner，负责在步骤失败后调整执行计划。

## 规则
- 已完成的步骤不可撤销。
- 失败步骤及其后的所有未完成步骤可以被替换。
- 替代步骤必须有明确的 completionPolicy。
- 不允许生成纯思考步骤。

## 输出格式
返回 JSON：
{
  "replacementSteps": [
    {
      "objective": "...",
      "completionPolicy": { "allOf": [...], "anyOf": [[...]] }
    }
  ]
}`;

export async function runReplan(input: RunReplanInput): Promise<PlanStep[]> {
  const completedSteps = input.plan.steps
    .filter((s) => s.status === "completed")
    .map((s) => ({ objective: s.objective }));

  const userContent = JSON.stringify({
    taskGoal: input.plan.goal,
    completedSteps,
    failedStep: { objective: input.failedStep.objective, error: input.errorMessage },
    availableCapabilities: input.availableCapabilities
      .filter((c) => c.completionEvidence.length > 0)
      .map((c) => ({ capabilityId: c.capabilityId, description: c.description, evidence: c.completionEvidence })),
  });

  const request: ChatRequest = {
    model: input.model,
    messages: [
      { role: "system", content: REPLANNER_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    stream: false,
    maxTokens: 800,
  };

  const result = await runStructuredOutput<{ replacementSteps: PlanStep[] }, ChatRequest>({
    stage: "action_gate",
    profile: input.profile,
    signal: input.signal,
    buildRequest: () => request,
    generate: async (req, signal) => {
      const response = await input.generate(req, signal);
      return { text: response.text, finishReason: response.finishReason, refusal: response.refusal };
    },
    parseSchema: (value) => {
      if (!value || typeof value !== "object") throw new Error("invalid");
      const obj = value as Record<string, unknown>;
      if (!Array.isArray(obj.replacementSteps) || obj.replacementSteps.length === 0) {
        throw new Error("replacementSteps is invalid");
      }
      const steps: PlanStep[] = obj.replacementSteps.map((raw: unknown) => {
        const r = raw as Record<string, unknown>;
        if (typeof r.objective !== "string") throw new Error("objective is invalid");
        return {
          id: generateStepId(),
          objective: r.objective,
          status: "pending" as const,
          completionPolicy: parseCompletionPolicy(r.completionPolicy),
          toolCallCount: 0,
          retryCount: 0,
        };
      });
      return { replacementSteps: steps };
    },
    validateBusiness: (val) => ({ status: "accepted", value: val }),
  });

  if (result.outcome === "success") return result.value.replacementSteps;
  throw new Error("Replan failed");
}

// ── 计划状态更新工具 ──────────────────────

export function markStepSuperseded(step: PlanStep, failure: StepFailure, supersededBy: string[]): void {
  step.status = "superseded";
  step.failure = failure;
  step.supersededBy = supersededBy;
}

export function applyReplan(
  plan: TaskPlan,
  failedStep: PlanStep,
  replacementSteps: PlanStep[],
): void {
  const failedIndex = plan.steps.indexOf(failedStep);
  if (failedIndex < 0) return;

  const replacementIds = replacementSteps.map((s) => s.id);
  markStepSuperseded(failedStep, failedStep.failure ?? { message: "unknown", failedAt: Date.now() }, replacementIds);

  // 将 failed 步骤之后的所有 pending 步骤也标记为 superseded
  for (let i = failedIndex + 1; i < plan.steps.length; i++) {
    if (plan.steps[i].status === "pending") {
      markStepSuperseded(plan.steps[i], { message: "前置步骤失败", failedAt: Date.now() }, replacementIds);
    }
  }

  // 插入替代步骤
  plan.steps.splice(failedIndex + 1, 0, ...replacementSteps);
  plan.updatedAt = Date.now();
}

export function isPlanComplete(plan: TaskPlan): boolean {
  return plan.steps.every((s) =>
    s.status === "completed" || s.status === "skipped" || s.status === "superseded",
  );
}
