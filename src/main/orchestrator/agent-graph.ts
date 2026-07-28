import { Annotation, Command, END, START, StateGraph } from "@langchain/langgraph";
import { AgentRuntimeError } from "./agent-runtime-error";
import { perf } from "../perf-trace";
import type { ToolCallResult } from "./types";
import type { ChatMessage } from "./vendors/types";
import type {
  AskMissingField,
  AskUserAnswer,
} from "../../shared/ask-clarification";

export type ActionDecision =
  | {
      decision: "act";
      capability: string;
      objective: string;
      targetRefs: string[];
      /** 本次工具成功后的继续策略。未声明时默认 respond。 */
      afterSuccess?: "respond" | "replan";
    }
  | {
      decision: "respond";
      reason: string;
    }
  | {
      decision: "ask_user";
      reason: string;
      missingFields: AskMissingField[];
    }
  | {
      /** Local trusted failure fact. It is never produced by a model. */
      decision: "failure";
      reason: "action_gate_failed";
      code: string;
      disposition: "repair" | "ask_user" | "refresh_state" | "execution_policy" | "fail_closed";
      toolExecuted: false;
    };

export type ActDecision = Extract<ActionDecision, { decision: "act" }>;
export type AskUserDecision = Extract<ActionDecision, { decision: "ask_user" }>;
export type FailureDecision = Extract<ActionDecision, { decision: "failure" }>;

export interface GateFailureInfo {
  code: string;
  disposition: string;
}

export interface AgentGraphInput {
  originalQuery: string;
  contextualizedQuery: string;
  citaContextBlock: string;
  messages: ChatMessage[];
  availableCapabilities: string[];
  clarificationAnswers?: AskUserAnswer[];
}

export interface AgentGraphState extends AgentGraphInput {
  decision?: ActionDecision;
  /** 当前正在执行的 act 决策（含 afterSuccess），供 routeAfterTool 读取。 */
  currentAction?: ActDecision;
  toolResults: ToolCallResult[];
  iterationCount: number;
  reply: string;
  clarificationAnswers: AskUserAnswer[];
  /** refresh_state 重新决策次数，防止无限循环。 */
  refreshCount: number;
  /** 上一次 Action Gate 失败信息，供下一次 decide 读取并传给模型。 */
  lastGateFailure?: GateFailureInfo;
  /** Task Router 路由结果（feature flag 开启时使用） */
  taskRoute?: import("./task-router").TaskRoute;
  /** 执行计划（plan 模式） */
  taskPlan?: import("./task-plan").TaskPlan;
  /** 当前执行的步骤 ID */
  currentStepId?: string;
  /** 重规划次数 */
  replanCount: number;
  /** 临时 direct 完成后恢复旧 Plan */
  resumePlanAfterDirect?: boolean;
}

export interface AgentGraphDeps {
  decide: (state: AgentGraphState) => Promise<ActionDecision>;
  execute: (state: AgentGraphState, decision: ActDecision) => Promise<ToolCallResult[]>;
  askUser?: (state: AgentGraphState, decision: AskUserDecision) => Promise<AskUserAnswer>;
  respond: (state: AgentGraphState, decision: Exclude<ActionDecision, { decision: "act" }>) => Promise<string>;
  /** Task Router 回调（feature flag 开启时提供） */
  route?: (state: AgentGraphState) => Promise<import("./task-router").TaskRoute>;
  /** 计划创建回调（plan 模式） */
  createPlan?: (state: AgentGraphState) => Promise<import("./task-plan").TaskPlan>;
  /** 步骤验证回调（plan 模式） */
  planVerify?: (state: AgentGraphState) => Promise<import("./task-plan").StepVerificationResult>;
  /** 重规划回调（plan 模式） */
  planReplan?: (state: AgentGraphState) => Promise<import("./task-plan").PlanStep[]>;
  maxIterations?: number;
  /** refresh_state 最多重新决策次数，默认 1。 */
  maxRefresh?: number;
  /** 最大重规划次数，默认 2 */
  maxReplans?: number;
  /** Plan 状态变化时调用，发送快照给前端 */
  onPlanUpdate?: (plan: import("./task-plan").TaskPlan, replanCount: number) => void;
  trace?: (node: string, state: AgentGraphState) => void;
}

const GraphState = Annotation.Root({
  originalQuery: Annotation<string>,
  contextualizedQuery: Annotation<string>,
  citaContextBlock: Annotation<string>,
  messages: Annotation<ChatMessage[]>,
  availableCapabilities: Annotation<string[]>,
  decision: Annotation<ActionDecision | undefined>,
  currentAction: Annotation<ActDecision | undefined>,
  toolResults: Annotation<ToolCallResult[]>,
  iterationCount: Annotation<number>,
  reply: Annotation<string>,
  clarificationAnswers: Annotation<AskUserAnswer[]>,
  refreshCount: Annotation<number>,
  lastGateFailure: Annotation<GateFailureInfo | undefined>,
  taskRoute: Annotation<import("./task-router").TaskRoute | undefined>,
  taskPlan: Annotation<import("./task-plan").TaskPlan | undefined>,
  currentStepId: Annotation<string | undefined>,
  replanCount: Annotation<number>,
  resumePlanAfterDirect: Annotation<boolean | undefined>,
});

// ── createPlan 错误分类 ──────────────────────

function extractHttpStatus(message: string): number | undefined {
  const match = message.match(/HTTP\s+(\d{3})/);
  return match ? parseInt(match[1], 10) : undefined;
}

function classifyCreatePlanError(error: unknown): { errorType: string; retryable: boolean } {
  const errStr = error instanceof Error ? error.message : String(error);
  const errName = error instanceof Error ? error.name : "Unknown";
  const httpStatus = extractHttpStatus(errStr);

  // 用户主动取消
  if (errName === "AbortError" || errStr.includes("aborted") || errStr.includes("E_AGENT_GRAPH_CANCELLED")) {
    return { errorType: "abort", retryable: false };
  }
  // 鉴权失败
  if (errStr.includes("401") || errStr.includes("403") || errStr.includes("AUTH") || errStr.includes("API key")) {
    return { errorType: "auth_failed", retryable: false };
  }
  // 内容拒绝
  if (errStr.includes("REFUSED") || errStr.includes("CONTENT_FILTERED")) {
    return { errorType: "model_refused", retryable: false };
  }
  // schema 错误（结构化输出 repair 预算已用完）
  if (errStr.includes("REPAIR_EXHAUSTED") || errStr.includes("NO_JSON_OBJECT") || errStr.includes("NO_SCHEMA_VALID_OBJECT")) {
    return { errorType: "structured_output_failed", retryable: false };
  }
  // 可重试的临时错误
  if (httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504 || httpStatus === 529) {
    return { errorType: "temporary_server_error", retryable: true };
  }
  if (errStr.includes("overloaded") || errStr.includes("timeout") || errStr.includes("TIMEOUT")) {
    return { errorType: "temporary_server_error", retryable: true };
  }
  if (errStr.includes("MODEL_REQUEST_FAILED") && !httpStatus) {
    // 无 HTTP 状态码的请求失败，可能是网络问题
    return { errorType: "request_failed", retryable: true };
  }
  return { errorType: "unknown", retryable: false };
}

export async function runAgentGraph(input: AgentGraphInput, deps: AgentGraphDeps): Promise<AgentGraphState> {
  const maxIterations = Math.max(1, deps.maxIterations ?? 12);
  const maxRefresh = Math.max(0, deps.maxRefresh ?? 1);
  const maxReplans = Math.max(0, deps.maxReplans ?? 2);

  const compileTimer = perf.begin("graph_build_compile");
  const graph = new StateGraph(GraphState)
    .addNode("route", async (state) => {
      deps.trace?.("route", state);
      if (!deps.route) return {};  // feature flag 关闭时 no-op
      const taskRoute = await deps.route(state);
      return { taskRoute };
    })
    .addNode("decide", async (state) => {
      deps.trace?.("decide", state);
      const decision = await deps.decide(state);
      // act decision 同步写入 currentAction，供 routeAfterTool 读取 afterSuccess
      // lastGateFailure 在 decide 回调读取后清空，避免跨轮残留
      return {
        decision,
        lastGateFailure: undefined,
        ...(decision.decision === "act" ? { currentAction: decision } : {}),
      };
    })
    .addNode("execute", async (state) => {
      deps.trace?.("execute", state);
      if (state.iterationCount >= maxIterations) {
        throw new AgentRuntimeError(
          "E_AGENT_GRAPH_ITERATION_LIMIT",
          `Agent graph exceeded ${maxIterations} iterations.`,
        );
      }
      if (state.decision?.decision !== "act") {
        throw new Error("E_AGENT_GRAPH_INVALID_ACT_STATE");
      }
      const results = await deps.execute(state, state.decision);
      return {
        toolResults: [...state.toolResults, ...results],
        iterationCount: state.iterationCount + 1,
      };
    })
    .addNode("routeAfterTool", async (state) => {
      deps.trace?.("routeAfterTool", state);
      const result = state.toolResults[state.toolResults.length - 1];
      const action = state.currentAction;
      if (!result || !action) {
        return new Command({ goto: "decide" });
      }

      // 路由逻辑（纯代码，不调 LLM）
      let goto: "decide" | "soul" | "planVerify";
      if (result.status === "failed") {
        goto = result.retryable ? "decide" : "soul";
      } else if (!result.terminal) {
        goto = "decide";
      } else {
        goto = action.afterSuccess === "replan" ? "decide" : "soul";
      }

      // plan 模式下，终态路由到 planVerify 而非 soul
      // 只有真正进入 plan 模式（taskPlan 存在且 running）才走 planVerify
      const inPlanMode = state.taskRoute?.executionMode === "plan"
        && state.taskPlan?.status === "running";
      if (goto === "soul" && inPlanMode) {
        goto = "planVerify";
      }

      // 去 soul 时把 decision 改写成 respond
      const update = goto === "soul"
        ? { decision: { decision: "respond" as const, reason: "tool_complete" } }
        : {};
      return new Command({ update, goto });
    })
    .addNode("askUser", async (state) => {
      deps.trace?.("askUser", state);
      if (state.decision?.decision !== "ask_user" || !deps.askUser) {
        return new Command({ goto: "soul" });
      }
      if (state.iterationCount >= maxIterations) {
        throw new AgentRuntimeError(
          "E_AGENT_GRAPH_ITERATION_LIMIT",
          `Agent graph exceeded ${maxIterations} iterations.`,
        );
      }
      const answer = await deps.askUser(state, state.decision);
      if (answer.answers.length === 0) {
        return new Command({ goto: "soul" });
      }
      return new Command({
        update: {
          clarificationAnswers: [...state.clarificationAnswers, answer],
          decision: undefined,
          iterationCount: state.iterationCount + 1,
        },
        goto: "decide",
      });
    })
    .addNode("refresh", async (state) => {
      deps.trace?.("refresh", state);
      const failure = state.decision as FailureDecision;
      return {
        refreshCount: state.refreshCount + 1,
        lastGateFailure: { code: failure.code, disposition: failure.disposition } as GateFailureInfo,
        decision: undefined,
      };
    })
    .addNode("createPlan", async (state) => {
      deps.trace?.("createPlan", state);
      if (!deps.createPlan) {
        console.warn("[AgentGraph] CreatePlan: dep missing, skipping");
        return new Command({ goto: "decide" });
      }
      console.log("[AgentGraph] CreatePlan entered");

      const MAX_REQUEST_RETRIES = 1;
      let lastError: unknown;

      for (let attempt = 1; attempt <= 1 + MAX_REQUEST_RETRIES; attempt++) {
        try {
          const plan = await deps.createPlan(state);
          const firstStep = plan.steps.find((s) => s.status === "pending");
          if (firstStep) {
            firstStep.executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            firstStep.status = "running";
          }
          if (attempt > 1) {
            console.log(`[AgentGraph] CreatePlan retry succeeded: attempt=${attempt} steps=${plan.steps.length}`);
          } else {
            console.log(`[AgentGraph] CreatePlan succeeded: steps=${plan.steps.length} goal=${plan.goal.slice(0, 80)}`);
          }
          deps.onPlanUpdate?.(plan, 0);
          return {
            taskPlan: plan,
            currentStepId: firstStep?.id,
          };
        } catch (error) {
          lastError = error;
          const errStr = error instanceof Error ? error.message : String(error);
          const errName = error instanceof Error ? error.name : "Unknown";
          const { errorType, retryable } = classifyCreatePlanError(error);
          const httpStatus = extractHttpStatus(errStr);

          if (retryable && attempt <= MAX_REQUEST_RETRIES) {
            // 短退避后重试
            console.log(`[AgentGraph] CreatePlan request failed: attempt=${attempt}/${1 + MAX_REQUEST_RETRIES} type=${errorType} httpStatus=${httpStatus ?? "n/a"} retryable=true next=retry`);
            await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
            continue;
          }

          // 最终失败
          console.error(`[AgentGraph] CreatePlan failed: attempts=${attempt} type=${errorType} httpStatus=${httpStatus ?? "n/a"} retryable=${retryable} fallback=direct`);
          break;
        }
      }

      // 降级：清理 plan 状态，但保留原始路由意图
      return new Command({
        update: {
          taskRoute: {
            executionMode: "direct" as const,
            requestedExecutionMode: "plan" as const,
            fallbackReason: "create_plan_failed",
            skillIds: state.taskRoute?.skillIds ?? [],
            reason: "Plan creation failed, fallback to direct",
          },
          taskPlan: undefined,
          currentStepId: undefined,
        },
        goto: "decide",
      });
    })
    .addNode("planVerify", async (state) => {
      deps.trace?.("planVerify", state);
      if (!deps.planVerify || !state.taskPlan || !state.currentStepId) {
        return new Command({ goto: "soul" });
      }
      const result = await deps.planVerify(state);
      const plan = state.taskPlan;
      const step = plan.steps.find((s) => s.id === state.currentStepId);
      if (!step) return new Command({ goto: "soul" });

      if (result.status === "completed") {
        step.status = "completed";
        plan.updatedAt = Date.now();
        // 查找下一个 pending 步骤
        const nextStep = plan.steps.find((s) => s.status === "pending");
        if (nextStep) {
          nextStep.executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          nextStep.status = "running";
          deps.onPlanUpdate?.(plan, state.replanCount);
          return new Command({
            update: { taskPlan: plan, currentStepId: nextStep.id },
            goto: "decide",
          });
        }
        // 全部完成
        plan.status = "completed";
        deps.onPlanUpdate?.(plan, state.replanCount);
        return new Command({
          update: { taskPlan: plan, decision: { decision: "respond" as const, reason: "plan_completed" } },
          goto: "soul",
        });
      }
      if (result.status === "failed") {
        step.status = "failed";
        step.failure = { message: result.failureReason ?? "步骤失败", failedAt: Date.now() };
        plan.updatedAt = Date.now();
        deps.onPlanUpdate?.(plan, state.replanCount);
        return new Command({
          update: { taskPlan: plan },
          goto: "planReplan",
        });
      }
      // running：继续当前步骤
      return new Command({ goto: "decide" });
    })
    .addNode("planReplan", async (state) => {
      deps.trace?.("planReplan", state);
      if (!deps.planReplan || !state.taskPlan || state.replanCount >= maxReplans) {
        // 重规划预算耗尽
        const plan = state.taskPlan;
        if (plan) {
          plan.status = "failed";
          plan.updatedAt = Date.now();
          deps.onPlanUpdate?.(plan, state.replanCount);
        }
        return new Command({
          update: { taskPlan: plan, decision: { decision: "respond" as const, reason: "plan_failed" } },
          goto: "soul",
        });
      }
      try {
        const replacementSteps = await deps.planReplan(state);
        const plan = state.taskPlan;
        const failedStep = plan.steps.find((s) => s.id === state.currentStepId && s.status === "failed");
        if (!failedStep) return new Command({ goto: "soul" });

        // 标记 failed 及其后 pending 步骤为 superseded
        const replacementIds = replacementSteps.map((s) => s.id);
        const failedIndex = plan.steps.indexOf(failedStep);
        failedStep.status = "superseded";
        failedStep.supersededBy = replacementIds;
        for (let i = failedIndex + 1; i < plan.steps.length; i++) {
          if (plan.steps[i].status === "pending") {
            plan.steps[i].status = "superseded";
            plan.steps[i].supersededBy = replacementIds;
          }
        }
        // 插入替代步骤
        plan.steps.splice(failedIndex + 1, 0, ...replacementSteps);
        plan.updatedAt = Date.now();

        const nextStep = replacementSteps[0];
        if (nextStep) {
          nextStep.executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          nextStep.status = "running";
        }
        deps.onPlanUpdate?.(plan, state.replanCount + 1);
        return new Command({
          update: {
            taskPlan: plan,
            currentStepId: nextStep?.id,
            replanCount: state.replanCount + 1,
          },
          goto: "decide",
        });
      } catch {
        // 重规划失败
        const plan = state.taskPlan;
        if (plan) {
          plan.status = "failed";
          plan.updatedAt = Date.now();
        }
        return new Command({
          update: { taskPlan: plan, decision: { decision: "respond" as const, reason: "replan_failed" } },
          goto: "soul",
        });
      }
    })
    .addNode("soul", async (state) => {
      deps.trace?.("soul", state);
      if (!state.decision || state.decision.decision === "act") {
        throw new Error("E_AGENT_GRAPH_INVALID_SOUL_STATE");
      }
      return { reply: await deps.respond(state, state.decision) };
    })
    .addEdge(START, "route")
    .addConditionalEdges("route", (state) => {
      const mode = state.taskRoute?.executionMode;
      const hasCreatePlan = !!deps.createPlan;
      if (mode === "plan" && hasCreatePlan) {
        console.log("[AgentGraph] Route transition: executionMode=plan next=createPlan");
        return "createPlan";
      }
      if (mode === "plan" && !hasCreatePlan) {
        console.warn("[AgentGraph] Route transition: executionMode=plan but createPlan dep missing, falling back to decide");
      }
      return "decide";
    })
    .addEdge("createPlan", "decide")
    .addConditionalEdges("decide", (state) => {
      if (state.decision?.decision === "act") return "execute";
      if (state.decision?.decision === "ask_user" && deps.askUser) return "askUser";
      if (state.decision?.decision === "failure"
        && state.decision.disposition === "refresh_state"
        && state.refreshCount < maxRefresh) {
        return "refresh";
      }
      return "soul";
    })
    .addEdge("execute", "routeAfterTool")
    .addEdge("refresh", "decide")
    .addEdge("soul", END)
    .compile();
  compileTimer.end();

  const invokeTimer = perf.begin("graph_invoke");
  const result = await graph.invoke({
    ...input,
    decision: undefined,
    currentAction: undefined,
    toolResults: [],
    clarificationAnswers: input.clarificationAnswers ?? [],
    iterationCount: 0,
    refreshCount: 0,
    lastGateFailure: undefined,
    taskRoute: undefined,
    taskPlan: undefined,
    currentStepId: undefined,
    replanCount: 0,
    resumePlanAfterDirect: undefined,
    reply: "",
  }, {
    // route + decide + execute + routeAfterTool + planVerify/planReplan 消耗多个 superstep。
    recursionLimit: maxIterations * 4 + 12,
  });
  invokeTimer.end();
  return result;
}
