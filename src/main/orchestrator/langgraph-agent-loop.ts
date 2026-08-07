import { recordUsage } from "../token-usage-store";
import { loadPromptFile } from "../prompts/prompt-loader";
import { stripLeakedChatTimeContext } from "../chat-time-context";
import {
  runActionGate,
  type ActionCapability,
  type ActionReferencePolicy,
} from "./action-gate";
import { runAgentGraph, type AgentGraphState, detectVerificationWaiver, resolveCompletionStatus } from "./agent-graph";
import { AgentRuntimeError } from "./agent-runtime-error";
import {
  classifyStructuredOutputEndpoint,
  resolveStructuredOutputProfile,
} from "./structured-output/profiles";
import { ExecutionLedger } from "./execution-ledger";
import { resolveNativeToolCall } from "./native-function-calling";
import { normalizeToolExecutionOutcome } from "./tool-outcome-normalizer";
import {
  inspectToolCallArguments,
  parseAndValidateToolCallArguments,
  resolveToolForCapability,
} from "./tool-argument-validator";
import { buildExecutionBrief } from "./tool-execution-context";
import { buildSoulExecutionContext, formatSoulExecutionContext } from "./soul-execution-context";
import { runTaskRouter, ENABLE_TASK_ROUTER, buildRouterCapabilities, type TaskRoute, type SkillRouteInfo } from "./task-router";
import type { AbortSource } from "./cyrene-agent";
import {
  AgentExecutionError,
  snapshotRunExecutionStatus,
  type RunExecutionStatus,
  type RunPhase,
  type SuccessfulToolExecution,
  type CreatedArtifact,
} from "./run-execution-status";
import {
  runCreatePlan, runReplan, verifyStep, computeMaxIterations,
  generateExecutionId, generateAttemptId, findStep, buildPlanSnapshot,
  normalizePlan,
  DEFAULT_MAX_REPLANS, HARD_MAX_ITERATIONS,
  type TaskPlan, type PlanStep,
} from "./task-plan";
import type { ToolDefinition } from "./tool-registry";
import { controlledInputType, controlledInputKind, resolveEffectKind, resolveVerificationPolicy } from "./tool-registry";
import { checkExecutionPolicy } from "./shell-execution-policy";
import type { ToolCallResult, ToolExecutionOutcome } from "./types";
import { runSubAgent } from "./subagents/runner";
import { toSubAgentToolOutcome } from "./subagents/outcome-adapter";
import { parseSubAgentResult } from "./subagents/result-parser";
import {
  WorkStreamEventBridge,
  type TwoPhaseEvent,
  type TwoPhaseFcResult,
  type AgentLoopSettings,
} from "./two-phase-fc-loop";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatVendorAdapter,
  ToolCall,
} from "./vendors/types";
import { streamChatWithSdk, type SdkStreamRunInput } from "./vendors/sdk-stream/runtime";
import type { UnifiedStreamDelta } from "./vendors/sdk-stream/types";
import { perf } from "../perf-trace";
import {
  debugLog,
  debugWarn,
  flowLog,
  summarizeArgumentKeys,
  summarizeObjective,
} from "../agent-log";
import { contextRefRegistry } from "./tool-context";
import { compressConversation } from "./context-manager";
import type { ApprovedStyleSampling } from "./vendors/style-sampling";
import type {
  AskClarificationCard,
  AskUserAnswer,
  TrustedAskUserProfile,
} from "../../shared/ask-clarification";
import {
  detectRecentAddressedUser,
  resolveAskClarification,
} from "./ask-soul";
import { buildAskCard } from "./ask-card";
import {
  buildPendingAskInput,
  createPendingAction,
  resolvePendingActionAnswers,
  type PendingActionContext,
} from "./ask-answer-resolver";

export interface LangGraphAgentLoopOptions {
  settings: AgentLoopSettings;
  adapter: ChatVendorAdapter;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  toolSystemContent: string;
  soulSystemBaseContent: string;
  soulSampling?: ApprovedStyleSampling;
  originalQuery: string;
  contextualizedQuery: string;
  citaContextBlock: string;
  trustedRefs?: string[];
  perCallTimeoutMs: number;
  timeoutMs: number;
  maxIterations?: number;
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  executeTool: (tc: ToolCall, runnableToolIds: Set<string>) => Promise<string | ToolExecutionOutcome>;
  executionLedger?: ExecutionLedger;
  onEvent?: (event: TwoPhaseEvent) => void;
  recordUsage?: (input: number, output: number, calls: number) => void;
  signal?: AbortSignal;
  /** 标记 abort 来源（first-source-wins），由 CyreneAgent 注入 */
  markAbort?: (source: AbortSource) => void;
  cleanMessages?: ChatMessage[];
  actionGateSystemPrompt?: string;
  nativeFcSystemContent?: string;
  responseContext?: string;
  conversationId?: string;
  /** 当前 AG-UI run 的可信 ID；用于防止旧 Ask 恢复到新 run。 */
  runId?: string;
  runtimeEnvironmentContext?: string;
  askSystemContent?: string;
  trustedAskUserProfile?: TrustedAskUserProfile;
  requestUserClarification?: (card: AskClarificationCard) => Promise<AskUserAnswer>;
  /** Task Router 可用 Skill 列表（feature flag 开启时由 build-options 传入） */
  availableSkills?: SkillRouteInfo[];
  /** 当前对话模式，用于上下文压缩保留的最近轮数。 */
  mode?: string;
  /** 测试可注入的协议 transport；生产统一走 OpenAI / Anthropic SDK runtime。 */
  streamChat?: (input: SdkStreamRunInput) => Promise<ChatResponse>;
  /**
   * 可信工作区根目录（来自 Conversation Workspace Binding）。
   * Work 工具和 run_verification 必须使用此目录。
   */
  resolvedWorkspaceRoot?: string;
}

const LOG_PREFIX = "[AgentGraph/Trace]";

async function callAdapter(
  adapter: ChatVendorAdapter,
  request: ChatRequest,
  settings: AgentLoopSettings,
  timeoutMs: number,
  signal?: AbortSignal,
  markAbort?: (source: AbortSource) => void,
  streamChat: (input: SdkStreamRunInput) => Promise<ChatResponse> = streamChatWithSdk,
  onDelta?: (delta: UnifiedStreamDelta) => void,
): Promise<ReturnType<ChatVendorAdapter["parseResponse"]>> {
  if (signal?.aborted) throw new Error("E_AGENT_GRAPH_CANCELLED");
  const effectiveRequest = adapter.applyCacheHints?.(request, settings) ?? request;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    markAbort?.("call_timeout");
    controller.abort();
  }, timeoutMs);
  try {
    return await streamChat({
      adapter,
      request: effectiveRequest,
      config: settings,
      timeoutMs,
      signal: controller.signal,
      onDelta,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export const SOUL_NO_TOOL_DIRECTIVE: string = loadPromptFile("soul_no_tool_directive.md");

function stripToolProtocol(text: string): string {
  // 0. HTML entity decode first (some models leak encoded XML)
  const decoded = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  // MiniMax 内部协议使用 \uffff 作为分隔符；合法回复中不应出现
  const uffffIndex = decoded.indexOf("\uffff");
  if (uffffIndex >= 0) text = decoded.slice(0, uffffIndex);
  else text = decoded;
  // 中文标签协议块：[系统提示]/[工具调用]/[工具结果]
  const labelIndex = text.search(/\[系统提示\]|\[工具调用\]|\[工具结果\]/);
  if (labelIndex >= 0) text = text.slice(0, labelIndex);
  return text
    .split("]<]minimax[>[").join("")
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    // DSML format with full-width pipes (U+FF5C), used by DeepSeek
    .replace(/<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C}>tool_calls[\s\S]*?<\/\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C}>tool_calls>/gu, "")
    .replace(/<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C}>invoke[\s\S]*?<\/\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C}>invoke>/gu, "")
    .replace(/<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C}>parameter[\s\S]*?<\/\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C}>parameter>/gu, "")
    // <tool_calls> wrapper without attributes (some models emit this)
    .replace(/<tool_calls(?:\s[^>]*?)?>[\s\S]*?<\/tool_calls>/gi, "")
    .replace(/<function_call\b[^>]*>[\s\S]*?<\/function_call>/gi, "")
    .trim();
}

function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string") {
    return String((error as { code: string }).code);
  }
  const message = error instanceof Error ? error.message : String(error);
  const token = message.split(" ", 1)[0].split(":", 1)[0];
  return token.startsWith("E_") ? token : "E_TOOL_EXECUTION_FAILED";
}

/**
 * 格式化代码验证上下文注入 Soul 系统提示。
 * Soul 只读取已固化的 FinalizationOutcome，不重新计算完成状态。
 */
function formatCodeVerificationContext(
  cv: import("./agent-graph").CodeVerificationState | undefined,
  outcome: import("./agent-graph").FinalizationOutcome | undefined,
  toolResults: import("./types").ToolCallResult[] = [],
): string {
  if (!cv || cv.mutationRevision === 0) return "";

  // 从工具结果中提取验证详情（闭世界投影）
  const lastVerification = [...toolResults]
    .reverse()
    .find((r) => r.toolId === "run_verification");
  let verificationDetail: Record<string, unknown> | undefined;
  if (lastVerification) {
    try {
      const parsed = JSON.parse(lastVerification.output);
      verificationDetail = {
        command: parsed.command,
        cwd: parsed.actualCwd,
        started: true,
        exitCode: parsed.exitCode,
        passed: parsed.passed,
        errorCode: parsed.errorCode ?? null,
        spawnError: parsed.spawnError ?? null,
        durationMs: parsed.durationMs,
      };
    } catch { /* 非 JSON */ }
  }

  const context: Record<string, unknown> = {
    changedFilesUnion: cv.changedFiles,
    mutationOccurred: cv.mutationRevision > 0,
    mutationRevision: cv.mutationRevision,
    verifiedRevision: cv.verifiedRevision,
    verificationStatus: cv.status,
    completionStatus: outcome?.status ?? "completed",
  };

  if (verificationDetail) {
    context.verification = verificationDetail;
  }

  if (outcome?.reason) {
    context.completionReason = outcome.reason;
  }

  const instructions: string[] = [];

  if (outcome?.status === "completed_unverified") {
    instructions.push("用户选择跳过验证。不得声称代码已通过测试或编译。必须明确说明修改未经验证。");
  }

  if (outcome?.status === "failed") {
    instructions.push("任务失败。不得声称 Bug 已修复或任务已完成。必须汇报失败原因。");
  }

  if (cv.status === "pending" && cv.mutationRevision > cv.verifiedRevision) {
    instructions.push("存在未验证的代码修改。如果要声明代码正确，必须先通过验证。");
  }

  if (cv.status === "failed" && cv.mutationRevision > cv.verifiedRevision) {
    instructions.push("文件修改已完成但验证失败。如实报告：哪些文件被修改了、验证命令是什么、验证结果如何。不要猜测原因。");
  }

  if (instructions.length > 0) {
    context.instructions = instructions;
  }

  return [
    "[CODE_VERIFICATION_CONTEXT]",
    JSON.stringify(context, null, 2),
    "[/CODE_VERIFICATION_CONTEXT]",
  ].join("\n");
}

function referencePolicyFor(tool: ToolDefinition): ActionReferencePolicy {
  const policies = new Set(Object.values(tool.controlledInput ?? {}).map(controlledInputType));
  if (policies.has("context_ref_array")) return "context_ref_array";
  if (policies.has("context_ref")) return "context_ref";
  if (policies.has("tool_result")) return "tool_result";
  return "none";
}

/** 从工具的 controlledInput 中收集所有 context_ref/context_ref_array 条目的 expectedKind */
function expectedRefKindsFor(tool: ToolDefinition): Set<string> | undefined {
  const kinds = new Set<string>();
  for (const policy of Object.values(tool.controlledInput ?? {})) {
    const type = controlledInputType(policy);
    if (type === "context_ref" || type === "context_ref_array") {
      const kind = controlledInputKind(policy);
      if (kind) kinds.add(kind);
    }
  }
  return kinds.size > 0 ? kinds : undefined;
}

/** Soul 失败时的确定性部分成功回复（不调用模型） */
function buildPartialSuccessReply(status: RunExecutionStatus): string {
  const lines: string[] = [];

  if (status.taskCompletionConfirmed && status.createdArtifacts.length > 0) {
    // 任务已确认完成 + 有文件产物
    lines.push("任务步骤已经完成，并生成了以下文件：");
    for (const a of status.createdArtifacts) {
      lines.push(`- ${a.path}`);
    }
    lines.push("");
    lines.push("但最终回复生成失败，你可以先查看上面的文件。");
  } else if (status.successfulTools.length > 0) {
    // 有成功工具但任务未确认完成
    lines.push("部分操作已经完成：");
    for (const t of status.successfulTools) {
      lines.push(`- ${t.actionLabel}`);
    }
    if (status.createdArtifacts.length > 0) {
      lines.push("");
      lines.push("生成的文件：");
      for (const a of status.createdArtifacts) {
        lines.push(`  ${a.path}`);
      }
    }
    lines.push("");
    lines.push("但整个任务尚未确认完成，最终回复生成失败。");
  } else {
    lines.push("部分工具步骤已经执行成功，但最终回复生成失败。");
  }

  return lines.join("\n");
}

/** Soul LLM 返回空白时的确定性 fallback（不调用模型） */
function buildSoulBlankFallback(state: AgentGraphState): string {
  const succeeded = state.toolResults.filter((r) => r.status === "succeeded");
  const failed = state.toolResults.filter((r) => r.status === "failed");
  const lines: string[] = [];

  if (succeeded.length === 0 && failed.length === 0) {
    return "刚才没有生成正常回复，请再试一次。";
  }

  if (succeeded.length > 0) {
    lines.push("操作已完成：");
    for (const r of succeeded) {
      const label = r.capabilityId || r.toolId;
      lines.push(`- ${label}`);
    }
  }
  if (failed.length > 0) {
    lines.push("");
    lines.push("以下操作失败：");
    for (const r of failed) {
      const label = r.capabilityId || r.toolId;
      const reason = r.errorCode || "执行失败";
      lines.push(`- ${label}（${reason}）`);
    }
  }
  lines.push("");
  lines.push("（回复生成异常，以上为工具执行摘要）");
  return lines.join("\n");
}

export async function runLangGraphAgentLoop(options: LangGraphAgentLoopOptions): Promise<TwoPhaseFcResult> {
  const startedAt = Date.now();

  // 入口压缩：把历史消息中超过阈值的部分交给模型摘要，保留最近若干轮
  const initialMessages = await compressConversation({
    messages: options.cleanMessages ?? options.messages,
    adapter: options.adapter,
    settings: options.settings,
    systemContent: [options.toolSystemContent, options.soulSystemBaseContent, options.citaContextBlock].filter(Boolean).join("\n\n"),
    mode: options.mode,
    onEvent: options.onEvent,
    signal: options.signal,
  });

  // 工作区诊断日志
  console.log("[AgentFlow] workspace binding:",
    "conversationId=" + (options.conversationId ?? "default"),
    "resolvedWorkspaceRoot=" + (options.resolvedWorkspaceRoot ?? "(未绑定)"),
  );

  // 路径验证：检查工作区目录是否仍然存在
  if (options.resolvedWorkspaceRoot) {
    const fs = require("fs") as typeof import("fs");
    if (!fs.existsSync(options.resolvedWorkspaceRoot)) {
      console.error("[AgentFlow] WORKSPACE_NOT_FOUND: workspace directory does not exist:", options.resolvedWorkspaceRoot);
      // 不直接拒绝——由具体 Work 工具返回可操作的路径错误
    }
  }

  if (ENABLE_TASK_ROUTER) {
    flowLog(`Task Router enabled: skills=${(options.availableSkills ?? []).length}`);
  } else {
    flowLog("Task Router disabled: feature_flag=false");
  }
  const perCallTimeout = options.perCallTimeoutMs;
  const streamChat = options.streamChat ?? streamChatWithSdk;
  // 过滤掉 deprecated 和 effectKind=unknown 的工具（后者会被 ExecutionPolicyGuard 拒绝，不应暴露给模型）
  const enabledTools = options.tools.filter(
    (tool) => tool.id !== "delegate_coding"
      && tool.enabled
      && !tool.deprecated
      && tool.effectKind !== "unknown",
  );
  // 过滤后的版本（按 inPlanMode 动态切换）
  let enabledToolsFiltered = enabledTools;
  let runnableToolIdsFiltered: Set<string> = new Set(enabledTools.map((t) => t.id));
  const runnableToolIds = new Set(enabledTools.map((tool) => tool.id));
  const capabilities: ActionCapability[] = enabledTools.map((tool) => ({
    capability: tool.capability ?? tool.id,
    toolId: tool.id,
    description: tool.catalogHint?.trim() || tool.description.split("\n")[0]?.trim() || tool.description,
    requiredInputs: tool.inputSchema.required ?? [],
    referencePolicy: referencePolicyFor(tool),
  }));
  let capabilitiesFiltered: ActionCapability[] = capabilities;

  let usageInput = 0;
  let usageOutput = 0;
  let fallbackMessages: ChatMessage[] | undefined;
  let usedImageCaptionFallback = false;
  let duplicateTerminalStreak = 0;
  const executionLedger = options.executionLedger ?? new ExecutionLedger();
  const usageRecorder = options.recordUsage ?? ((input, output, calls) => recordUsage(input, output, calls));

  // ── 执行状态追踪 ────────────────────────
  const executionStatus: RunExecutionStatus = {
    phase: "context",
    successfulTools: [],
    createdArtifacts: [],
    taskCompletionConfirmed: false,
  };
  debugLog(
    `${LOG_PREFIX} runtime=start adapter=${options.adapter.id} transport=${options.adapter.transport} capabilities=${capabilities.length}`,
  );

  const ensureBudget = () => {
    if (options.signal?.aborted) throw new Error("E_AGENT_GRAPH_CANCELLED");
    if (Date.now() - startedAt >= options.timeoutMs) throw new Error("E_AGENT_GRAPH_TIMEOUT");
  };
  const remainingBudget = () => {
    ensureBudget();
    return Math.max(1, options.timeoutMs - (Date.now() - startedAt));
  };
  const trackUsage = (usage?: { input: number; output: number }) => {
    if (!usage) return;
    usageInput += usage.input;
    usageOutput += usage.output;
    usageRecorder(usage.input, usage.output, 1);
  };
  const invokeWithFallback = async (
    buildRequest: (messages: ChatMessage[]) => ChatRequest,
    settingsOverride?: AgentLoopSettings,
    messagesOverride?: ChatMessage[],
    requestSignal?: AbortSignal,
    onDelta?: (delta: UnifiedStreamDelta) => void,
  ) => {
    const activeMessages = messagesOverride ?? fallbackMessages ?? options.messages;
    const effectiveSettings = settingsOverride ?? options.settings;
    const activeSignal = requestSignal ?? options.signal;
    try {
      return await callAdapter(
        options.adapter,
        buildRequest(activeMessages),
        effectiveSettings,
        Math.min(perCallTimeout, remainingBudget()),
        activeSignal,
        options.markAbort,
        streamChat,
        onDelta,
      );
    } catch (error) {
      if (activeSignal?.aborted) throw error;
      if (usedImageCaptionFallback || !options.imageCaptionFallback) throw error;
      usedImageCaptionFallback = true;
      fallbackMessages = await options.imageCaptionFallback();
      debugWarn(`${LOG_PREFIX} image_fallback=true`);
      return await callAdapter(
        options.adapter,
        buildRequest(fallbackMessages),
        effectiveSettings,
        Math.min(perCallTimeout, remainingBudget()),
        activeSignal,
        options.markAbort,
        streamChat,
        onDelta,
      );
    }
  };

  let result: Awaited<ReturnType<typeof runAgentGraph>>;
  try {
    result = await perf.track("agent_graph_invoke", () => runAgentGraph({
      originalQuery: options.originalQuery,
      contextualizedQuery: options.contextualizedQuery,
      citaContextBlock: options.citaContextBlock,
      messages: initialMessages,
      availableCapabilities: capabilities.map((item) => item.capability),
      resolvedWorkspaceRoot: options.resolvedWorkspaceRoot,
    }, {
    maxIterations: ENABLE_TASK_ROUTER ? HARD_MAX_ITERATIONS : (options.maxIterations ?? 12),
    maxReplans: DEFAULT_MAX_REPLANS,
    ...(ENABLE_TASK_ROUTER
      ? {
      route: async (state) => {
        executionStatus.phase = "router";
        const profile = resolveStructuredOutputProfile({
          provider: options.adapter.id,
          transport: options.adapter.transport,
          model: options.settings.model,
          endpointKind: classifyStructuredOutputEndpoint({
            providerId: options.adapter.id,
            configuredBaseUrl: options.settings.baseUrl,
            officialBaseUrl: options.adapter.capability.baseUrl,
          }),
        });
        const route = await runTaskRouter({
          model: options.settings.model,
          originalQuery: state.originalQuery,
          contextualizedQuery: state.contextualizedQuery,
          messages: state.messages,
          availableSkills: options.availableSkills ?? [],
          availableCapabilities: buildRouterCapabilities(options.tools),
          profile,
          generate: (request, signal) => invokeWithFallback(
            (messages) => ({
              ...request,
              messages: [
                request.messages[0],
                ...messages,
                request.messages[request.messages.length - 1],
              ],
            }),
            options.settings,
            state.messages,
            signal,
          ),
          signal: options.signal,
        });
        debugLog(`${LOG_PREFIX} node=route mode=${route.executionMode} skills=${route.skillIds.join(",")} reason=${route.reason}`);
        flowLog(`Router decision: executionMode=${route.executionMode} skillIds=[${route.skillIds.join(", ")}]`);
        return route;
      },
      createPlan: async (state) => {
        executionStatus.phase = "create_plan";
        // UI-only lifecycle marker: the renderer keeps this as one replacing
        // stage indicator, rather than exposing raw structured-output logs.
        options.onEvent?.({ type: "step_started", stepName: "agent-graph-plan" });
        const profile = resolveStructuredOutputProfile({
          provider: options.adapter.id,
          transport: options.adapter.transport,
          model: options.settings.model,
          endpointKind: classifyStructuredOutputEndpoint({
            providerId: options.adapter.id,
            configuredBaseUrl: options.settings.baseUrl,
            officialBaseUrl: options.adapter.capability.baseUrl,
          }),
        });
        // 必须用 enabledTools（已过 acceptance mode 过滤），不能用 options.tools
        const capabilitiesWithEvidence = enabledTools
          .map((t) => ({
            capabilityId: t.capability ?? t.id,
            description: t.catalogHint?.trim() || t.description.split("\n")[0]?.trim() || t.description,
            completionEvidence: t.completionEvidence ?? [],
          }));
        const plan = await runCreatePlan({
          model: options.settings.model,
          userRequest: state.originalQuery,
          contextualizedQuery: state.contextualizedQuery,
          messages: state.messages,
          availableCapabilities: capabilitiesWithEvidence,
          conversationId: options.conversationId ?? "default",
          skillIds: state.taskRoute?.skillIds ?? [],
          profile,
          generate: (request, signal) => invokeWithFallback(
            () => request, options.settings, state.messages, signal,
          ),
          signal: options.signal,
        });

        // Plan 规范化：检测 mutation 步骤，按 verificationPolicy 追加验证步骤
        const capEffectMap = enabledToolsFiltered.map(t => ({
          capabilityId: t.capability ?? t.id,
          effectKind: t.effectKind ?? "unknown" as const,
          verificationPolicy: t.verificationPolicy ?? "none" as const,
        }));
        const { accepted, rejectReason } = normalizePlan(plan, capEffectMap);
        if (!accepted) {
          flowLog(`2.7 计划规范化失败：${rejectReason}`);
          throw new Error(`Plan normalization rejected: ${rejectReason}`);
        }

        // 初始化第一个步骤
        const firstStep = plan.steps.find((s) => s.status === "pending");
        if (firstStep) {
          firstStep.executionId = generateExecutionId();
          firstStep.status = "running";
        }
        flowLog(`2.6 创建计划：${plan.steps.length} 步`);
        flowLog(`   目标：${plan.goal}`);
        plan.steps.forEach((s, i) => flowLog(`   ${i + 1}. ${s.objective}`));
        return plan;
      },
      planVerify: async (state) => {
        executionStatus.phase = "plan_verify";
        if (!state.taskPlan || !state.currentStepId) {
          return { status: "completed" as const };
        }
        const step = findStep(state.taskPlan, state.currentStepId);
        if (!step) return { status: "completed" as const };
        const stepResults = state.toolResults.filter(
          (r) => r.stepExecutionId === step.executionId,
        );
        const result = verifyStep(step, stepResults, options.tools);
        const stepIndex = state.taskPlan.steps.indexOf(step) + 1;
        const totalSteps = state.taskPlan.steps.length;
        if (result.status === "completed") {
          flowLog(`6.5 步骤验证：完成（${stepIndex}/${totalSteps}）`);
        } else if (result.status === "failed") {
          flowLog(`6.5 步骤验证：失败（${result.failureReason ?? "未知"}）`);
        }
        return result;
      },
      planReplan: async (state) => {
        executionStatus.phase = "plan_replan";
        if (!state.taskPlan || !state.currentStepId) return [];
        const step = findStep(state.taskPlan, state.currentStepId);
        if (!step) return [];
        const profile = resolveStructuredOutputProfile({
          provider: options.adapter.id,
          transport: options.adapter.transport,
          model: options.settings.model,
          endpointKind: classifyStructuredOutputEndpoint({
            providerId: options.adapter.id,
            configuredBaseUrl: options.settings.baseUrl,
            officialBaseUrl: options.adapter.capability.baseUrl,
          }),
        });
        const capabilitiesWithEvidence = options.tools
          .filter((t) => t.enabled)
          .map((t) => ({
            capabilityId: t.capability ?? t.id,
            description: t.description,
            completionEvidence: t.completionEvidence ?? [],
          }));
        const replacementSteps = await runReplan({
          model: options.settings.model,
          plan: state.taskPlan,
          failedStep: step,
          errorMessage: step.failure?.message ?? "未知错误",
          messages: state.messages,
          availableCapabilities: capabilitiesWithEvidence,
          profile,
          generate: (request, signal) => invokeWithFallback(
            () => request, options.settings, state.messages, signal,
          ),
          signal: options.signal,
        });
        flowLog(`6.6 重规划：替换 ${replacementSteps.length} 步`);
        replacementSteps.forEach((s, i) => flowLog(`   新步骤 ${i + 1}. ${s.objective}`));
        return replacementSteps;
      },
      onPlanUpdate: (plan, replanCount) => {
        const snapshot = buildPlanSnapshot(plan, replanCount);
        options.onEvent?.({ type: "task_plan_update", snapshot });
      },
    } : {}),
    trace: (node, state) => {
      debugLog(`${LOG_PREFIX} node=${node} iteration=${state.iterationCount} decision=${state.decision?.decision ?? "pending"}`);
      if (node === "routeAfterTool") {
        const lastResult = state.toolResults[state.toolResults.length - 1];
        const action = state.currentAction;
        const afterSuccess = action?.afterSuccess ?? "respond(default)";
        const route = !lastResult
          ? "decide(no-result)"
          : lastResult.status === "failed"
            ? (lastResult.retryable ? "decide(retryable)" : "soul(non-retryable)")
            : !lastResult.terminal
              ? "decide(non-terminal)"
              : afterSuccess === "replan" ? "decide(replan)" : "soul(respond)";
        debugLog(`${LOG_PREFIX} node=routeAfterTool status=${lastResult?.status} terminal=${lastResult?.terminal} retryable=${lastResult?.retryable} afterSuccess=${afterSuccess} -> ${route}`);
        flowLog(`   路由：${route}`);
      }
    },
    getToolById: (id: string) => enabledToolsFiltered.find(t => t.id === id),
    decide: async (state) => {
      executionStatus.phase = "action_gate";
      ensureBudget();

      // ── 确定性强制路由：requiredNextAction 存在时跳过 Action Gate LLM ──
      if (state.requiredNextAction) {
        const rna = state.requiredNextAction;
        flowLog(`3. 强制动作：${rna.capabilityId}（${rna.reason}）`);
        console.log(LOG_PREFIX, `requiredNextAction 强制路由: capability=${rna.capabilityId} args=${JSON.stringify(rna.forcedArgs ?? {})}`);
        return {
          decision: "act" as const,
          capability: rna.capabilityId,
          objective: rna.reason,
          targetRefs: [],
          afterSuccess: "respond" as const,
        };
      }

      // 检测用户是否明确授权跳过验证
      if (!state.verificationWaiver) {
        const waiver = detectVerificationWaiver(state.messages, options.conversationId ?? "default");
        if (waiver) {
          state.verificationWaiver = waiver;
        }
      }

      // 异常兜底：正常路径下 routeAfterTool 已经在工具成功后确定性路由到 soul，
      // 不会走到这里。只有 routeAfterTool 路由回 decide（replan 或可重试失败）后，
      // 模型又重复同一已完成动作时才触发。主路径不依赖此检查。
      const lastResult = state.toolResults[state.toolResults.length - 1];

      // Plan 模式工具过滤：隐藏 hideInPlanMode 工具，确保 Action Gate 和 Native FC 都看不到
      // 包括 Plan 创建失败降级后的 direct 模式（requestedExecutionMode === "plan"）
      const inPlanMode = (state.taskPlan != null
        && !["completed", "failed", "cancelled"].includes(state.taskPlan.status))
        || state.taskRoute?.requestedExecutionMode === "plan";
      if (inPlanMode) {
        const hidden = enabledTools.filter((t) => t.hideInPlanMode).map((t) => t.id);
        if (hidden.length > 0) {
          flowLog(`Plan tool filtering: ${hidden.join(", ")} hidden`);
          enabledToolsFiltered = enabledTools.filter((t) => !t.hideInPlanMode);
          runnableToolIdsFiltered = new Set(enabledToolsFiltered.map((t) => t.id));
          capabilitiesFiltered = enabledToolsFiltered.map((tool) => ({
            capability: tool.capability ?? tool.id,
            toolId: tool.id,
            description: tool.catalogHint?.trim() || tool.description.split("\n")[0]?.trim() || tool.description,
            requiredInputs: tool.inputSchema.required ?? [],
            referencePolicy: referencePolicyFor(tool),
          }));
        } else {
          enabledToolsFiltered = enabledTools;
          runnableToolIdsFiltered = runnableToolIds;
          capabilitiesFiltered = capabilities;
        }
      } else {
        enabledToolsFiltered = enabledTools;
        runnableToolIdsFiltered = runnableToolIds;
        capabilitiesFiltered = capabilities;
      }
      if (lastResult?.deduplicated) {
        debugLog(`${LOG_PREFIX} node=decide forced_respond reason=duplicate_terminal_action`);
        return { decision: "respond", reason: "duplicate_terminal_action" };
      }
      options.onEvent?.({ type: "step_started", stepName: "agent-graph-action-gate" });
      try {
        if (state.lastGateFailure) {
          flowLog(`3. 重新决策（上次失败：${state.lastGateFailure.code}）`);
        }
        const profile = resolveStructuredOutputProfile({
          provider: options.adapter.id,
          transport: options.adapter.transport,
          model: options.settings.model,
          endpointKind: classifyStructuredOutputEndpoint({
            providerId: options.adapter.id,
            configuredBaseUrl: options.settings.baseUrl,
            officialBaseUrl: options.adapter.capability.baseUrl,
          }),
        });
        const actionGateSettings = profile.reasoning === "disabled"
          ? { ...options.settings, reasoning: { mode: "off" as const } }
          : options.settings;
        debugLog(
          `${LOG_PREFIX} node=action-gate provider=${options.adapter.id} transport=${options.adapter.transport} model=${options.settings.model} mode=${profile.mode} profile=${profile.id}`,
        );
        const trustedRefs = new Set(options.trustedRefs ?? []);
        const gate = await perf.track("decide_action_gate_structured", () => runActionGate({
          model: options.settings.model,
          originalQuery: state.originalQuery,
          contextualizedQuery: state.contextualizedQuery,
          citaContextBlock: state.citaContextBlock,
          messages: state.messages,
          availableCapabilities: capabilitiesFiltered,
          runtimeEnvironmentContext: options.runtimeEnvironmentContext,
          clarificationAnswers: state.clarificationAnswers,
          trustedRefs: [...trustedRefs],
          toolResults: state.toolResults,
          profile,
          actionGateSystemPrompt: options.actionGateSystemPrompt,
          lastGateFailure: state.lastGateFailure,
          signal: options.signal,
          generate: (request, signal) => invokeWithFallback(
            (messages) => ({
              ...request,
              messages: [
                request.messages[0],
                ...messages,
                request.messages[request.messages.length - 1],
              ],
            }),
            actionGateSettings,
            state.messages,
            signal,
          ),
          onResponse: (response) => trackUsage(response.usage),
          validateTargetRef: (ref) => {
            if (trustedRefs.has(ref)) return true;
            try {
              contextRefRegistry.resolve(ref, options.conversationId ?? "default");
              return true;
            } catch {
              return false;
            }
          },
          recordMetric: (metric) => {
            debugLog(`[StructuredOutput] ${JSON.stringify({
              provider: options.adapter.id,
              model: options.settings.model,
              profile: profile.id,
              tier: profile.tier,
              ...metric,
            })}`);
          },
        }));
        if (gate.outcome === "failure") {
          debugWarn(
            `${LOG_PREFIX} node=action-gate failure=${gate.failure.code} disposition=${gate.failure.disposition} toolExecuted=false`,
          );
          flowLog(`3. 动作校验失败：${gate.failure.code}`);
          flowLog("   工具未执行；转入失败回复");
          return {
            decision: "failure",
            reason: "action_gate_failed",
            code: gate.failure.code,
            disposition: gate.failure.disposition,
            toolExecuted: false,
          };
        }
        const decision = gate.decision;
        debugLog(
          `${LOG_PREFIX} decision=${decision.decision}${decision.decision === "act" ? ` capability=${decision.capability}` : ""} repairs=${gate.repairCount}`,
        );
        if (decision.decision === "act") {
          const toolId = capabilities.find((item) => item.capability === decision.capability)?.toolId
            ?? decision.capability;
          // plan 模式下显示当前步骤进度
          if (state.taskPlan && state.currentStepId) {
            const step = findStep(state.taskPlan, state.currentStepId);
            if (step) {
              const stepIndex = state.taskPlan.steps.indexOf(step) + 1;
              const totalSteps = state.taskPlan.steps.length;
              flowLog(`3. 执行步骤 ${stepIndex}/${totalSteps}：${step.objective}`);
            }
            flowLog(`   选择动作：调用 ${toolId}`);
          } else {
            flowLog(`3. 选择动作：调用 ${toolId}`);
          }
          flowLog(`   目标：${summarizeObjective(decision.objective)}`);
          flowLog(`   成功后：${decision.afterSuccess ?? "respond(默认)"}`);
        } else if (decision.decision === "ask_user") {
          flowLog("3. 选择动作：向用户确认信息");
        } else {
          flowLog("3. 选择动作：直接回复");
        }
        return decision;
      } finally {
        options.onEvent?.({ type: "step_finished", stepName: "agent-graph-action-gate" });
      }
    },
    ...(options.requestUserClarification
      ? {
          askUser: async (_state: AgentGraphState, decision) => {
            const clarification = await perf.track("ask_soul_llm", () => resolveAskClarification({
              model: options.settings.model,
              askSystemContent: options.askSystemContent ?? "",
              input: {
                userRequest: _state.originalQuery,
                missingFields: decision.missingFields,
                trustedUserProfile: options.trustedAskUserProfile,
                recentAddressedUser: detectRecentAddressedUser(
                  _state.messages,
                  options.trustedAskUserProfile,
                ),
              },
            }, async (request) => {
              const response = await invokeWithFallback(() => ({
                ...request,
                ...(options.soulSampling ?? {}),
              }));
              trackUsage(response.usage);
              return response;
            }));
            try {
              return options.requestUserClarification!(buildAskCard(clarification));
            } catch (error) {
              if (error instanceof Error && error.message === "E_ASK_OPTIONS_INSUFFICIENT") {
                console.warn(`${LOG_PREFIX} Ask suggestions remained insufficient after repair; returning to Soul`);
                return { requestId: `invalid-ask-${Date.now()}`, answers: [] };
              }
              throw error;
            }
          },
        }
      : {}),
    execute: async (state, decision) => {
      executionStatus.phase = "tool_execute";
      ensureBudget();
      const selectedTool = resolveToolForCapability(enabledToolsFiltered, decision.capability);
      options.onEvent?.({ type: "step_started", stepName: `agent-graph-tool-${selectedTool.id}` });
      try {
        // 引用验证：检查需要可信引用的工具的 targetRefs 是否有效（含类型检查）
        const controlledInput = selectedTool.controlledInput;
        const needsRefVerification = controlledInput
          && Object.values(controlledInput).some((v) => {
            const t = controlledInputType(v);
            return t === "context_ref" || t === "context_ref_array";
          });
        let refVerification: { verified: boolean; detail: string } | undefined;
        if (needsRefVerification && decision.targetRefs.length > 0) {
          const expectedKinds = expectedRefKindsFor(selectedTool);
          try {
            for (const ref of decision.targetRefs) {
              if (expectedKinds) {
                // 有 kind 约束：逐个 kind 尝试，全部不匹配才失败
                let resolved = false;
                for (const kind of expectedKinds) {
                  try {
                    contextRefRegistry.resolve(ref, options.conversationId ?? "default", kind);
                    resolved = true;
                    break;
                  } catch { /* continue to next kind */ }
                }
                if (!resolved) {
                  throw new Error(`E_CONTEXT_REF_KIND_MISMATCH (expected: ${[...expectedKinds].join("|")})`);
                }
              } else {
                contextRefRegistry.resolve(ref, options.conversationId ?? "default");
              }
            }
            refVerification = { verified: true, detail: "" };
          } catch (error) {
            refVerification = { verified: false, detail: error instanceof Error ? error.message : String(error) };
            return [{
              toolId: selectedTool.id,
              args: {},
              output: `引用验证失败：${refVerification.detail}。需要重新搜索或获取候选列表。`,
              status: "failed",
              errorCode: "E_TRUSTED_REF_VERIFICATION_FAILED",
              terminal: false,
              retryable: true,
            }];
          }
        }

        const executionBrief = buildExecutionBrief(
          decision.objective,
          decision.targetRefs,
          state.contextualizedQuery,
          refVerification,
        );

        let args: Record<string, unknown> | undefined;
        let toolCall: ToolCall | undefined;
        let partialArguments: { args: Record<string, unknown>; missingFields: string[] } | undefined;
        let unresolvedParameterAnswer: AskUserAnswer | undefined;

        // ── 强制动作：跳过 Native FC，直接构造 tool call ──
        const rna = state.requiredNextAction;
        if (rna && rna.capabilityId === selectedTool.id && rna.forcedArgs) {
          args = { ...rna.forcedArgs };
          toolCall = {
            id: `forced_${Date.now()}`,
            name: selectedTool.id,
            arguments: JSON.stringify(args),
          };
          flowLog(`4. 强制参数：${Object.keys(args).join(", ")}（跳过 Native FC）`);
          console.log(LOG_PREFIX, `forced action: tool=${selectedTool.id} args=${JSON.stringify(args)}`);
        }

        // ── 正常路径：Native FC 参数生成 ──
        if (!args || !toolCall) {
          let lastError: unknown;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const resolved = await resolveNativeToolCall({
                model: options.settings.model,
                nativeFcSystemPrompt: options.nativeFcSystemContent ?? "",
                executionBrief,
                runtimeEnvironmentContext: options.runtimeEnvironmentContext,
                toolResults: state.toolResults,
                tool: selectedTool,
                ...(lastError instanceof Error ? { protocolFeedback: lastError.message } : {}),
              }, async (request) => {
                try {
                  const response = await perf.track("execute_native_tool_llm", () => invokeWithFallback(() => request));
                  trackUsage(response.usage);
                  return response;
                } catch (err) {
                  console.error(`[NativeFC] invoke failed: tool=${selectedTool.id} model=${request.model} tools=${request.tools?.length ?? 0}`);
                  throw err;
                }
              });
              const inspection = inspectToolCallArguments(
                resolved,
                selectedTool,
                decision.targetRefs,
                state.toolResults,
              );
              if (inspection.kind === "missing_required") {
                partialArguments = inspection;
                throw new Error(`E_TOOL_ARGUMENT_SCHEMA: missing required fields: ${inspection.missingFields.join(", ")}`);
              }
              args = inspection.args;
              toolCall = { ...resolved, arguments: JSON.stringify(args) };
              break;
            } catch (error) {
              lastError = error;
              debugWarn(`${LOG_PREFIX} node=native-tool tool=${selectedTool.id} protocol_retry=${attempt} error=${errorCodeOf(error)}`);
            }
          }
          if ((!args || !toolCall) && partialArguments && options.requestUserClarification) {
            try {
              const planStep = state.taskPlan && state.currentStepId
                ? findStep(state.taskPlan, state.currentStepId)
                : undefined;
              const pendingContext: PendingActionContext = {
                runId: options.runId ?? options.conversationId ?? "default",
                ...(state.taskPlan ? { planId: state.taskPlan.id } : {}),
                ...(state.currentStepId ? { stepId: state.currentStepId } : {}),
                ...(planStep?.executionId ? { stepAttemptId: planStep.executionId } : {}),
              };
              const pendingAction = createPendingAction({
                tool: selectedTool,
                capability: decision.capability,
                objective: decision.objective,
                targetRefs: decision.targetRefs,
                afterSuccess: decision.afterSuccess ?? "respond",
                argumentsSnapshot: partialArguments.args,
                missingFields: partialArguments.missingFields,
                context: pendingContext,
              });
              const clarificationInput = buildPendingAskInput(
                pendingAction,
                selectedTool,
                state.originalQuery,
              );
              clarificationInput.trustedUserProfile = options.trustedAskUserProfile;
              clarificationInput.recentAddressedUser = detectRecentAddressedUser(
                state.messages,
                options.trustedAskUserProfile,
              );
              const clarification = await perf.track("ask_soul_llm", () => resolveAskClarification({
                model: options.settings.model,
                askSystemContent: options.askSystemContent ?? "",
                input: clarificationInput,
              }, async (request) => {
                const response = await invokeWithFallback(() => ({
                  ...request,
                  ...(options.soulSampling ?? {}),
                }));
                trackUsage(response.usage);
                return response;
              }));
              const answer = await options.requestUserClarification(
                buildAskCard(clarification, "action_parameters"),
              );
              const currentPlanStep = state.taskPlan && state.currentStepId
                ? findStep(state.taskPlan, state.currentStepId)
                : undefined;
              const currentContext: PendingActionContext = {
                runId: options.runId ?? options.conversationId ?? "default",
                ...(state.taskPlan ? { planId: state.taskPlan.id } : {}),
                ...(state.currentStepId ? { stepId: state.currentStepId } : {}),
                ...(currentPlanStep?.executionId ? { stepAttemptId: currentPlanStep.executionId } : {}),
              };
              const resolution = resolvePendingActionAnswers({
                pendingAction,
                currentTool: enabledToolsFiltered.find((tool) => tool.id === pendingAction.toolId),
                answer,
                currentContext,
                toolResults: state.toolResults,
              });
              if (resolution.kind === "resume_action") {
                args = resolution.action.args;
                toolCall = {
                  id: `resumed_${answer.requestId}`,
                  name: selectedTool.id,
                  arguments: JSON.stringify(args),
                };
                flowLog(`4. 用户补全工具参数：完成（${summarizeArgumentKeys(args)}）`);
              } else {
                unresolvedParameterAnswer = resolution.answers;
              }
            } catch (error) {
              lastError = error;
            }
          }
          if (!args || !toolCall) {
            if (unresolvedParameterAnswer) {
              flowLog("4. 用户答案需要语义理解：返回动作决策");
              return { kind: "return_to_agent" as const, answer: unresolvedParameterAnswer };
            }
            flowLog(`4. 工具参数生成失败：${errorCodeOf(lastError)}`);
            flowLog("   工具未执行；转入失败回复");
            return [{
              toolId: selectedTool.id,
              args: {},
              output: "Native Function Calling did not return one valid tool call after one repair. Tool Runtime was not invoked.",
              status: "failed",
              errorCode: errorCodeOf(lastError),
              terminal: true,
              retryable: false,
              toolExecuted: false,
            }];
          }
          flowLog(`4. 生成工具参数：完成（${summarizeArgumentKeys(args)}）`);
        }

        // ── 执行前策略守卫：在工具实际执行前检查 effectKind 和 verificationPolicy ──
        const effectKind = resolveEffectKind(selectedTool, args);
        const verificationPolicy = resolveVerificationPolicy(selectedTool, args);
        const policyDecision = checkExecutionPolicy(effectKind, verificationPolicy, selectedTool.id);
        if (!policyDecision.allowed) {
          flowLog(`5. 执行工具：${selectedTool.id} → 拒绝（${policyDecision.errorCode}）`);
          return [{
            toolId: selectedTool.id,
            args,
            output: policyDecision.message ?? `[拒绝] ${selectedTool.id} 执行前策略检查失败`,
            status: "failed",
            errorCode: policyDecision.errorCode,
            terminal: true,
            retryable: false,
            toolExecuted: false,
          }];
        }

        flowLog(`5. 执行工具：${selectedTool.id}`);

        const toolCallId = toolCall.id;
        options.onEvent?.({ type: "tool_call_start", toolCallId, toolCallName: selectedTool.name });

        // ── 执行分发：子代理工具走专用 Executor，普通工具走 ExecutionLedger ──
        const isSubAgent = selectedTool.executionKind === "subagent";
        const runExecution = async (): Promise<ToolExecutionOutcome> => {
          if (isSubAgent) {
            const taskId = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const profile = selectedTool.subAgentProfile;
            if (!profile) {
              return {
                status: "failed" as const,
                output: "SUBAGENT_PROFILE_MISSING: executionKind=subagent but subAgentProfile not set",
                errorCode: "SUBAGENT_PROFILE_MISSING",
                terminal: true,
                retryable: false,
              };
            }
            try {
              const outcome = await runSubAgent({
                profile,
                taskId,
                args,
                parentContext: {
                  runId: "default",
                  planId: state.taskPlan?.id,
                  stepId: state.currentStepId,
                  resolvedWorkspaceRoot: options.resolvedWorkspaceRoot,
                },
              });
              return toSubAgentToolOutcome(outcome);
            } catch (error) {
              // AbortError 重新抛出，不包装为工具失败
              if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
                throw error;
              }
              return {
                status: "failed",
                errorCode: errorCodeOf(error),
                output: error instanceof Error ? error.message : String(error),
              };
            }
          }
          try {
            const executed = await perf.track(`execute_tool[${selectedTool.id}]`, () => options.executeTool(toolCall, runnableToolIds));
            return typeof executed === "string" ? { status: "succeeded", output: executed } : executed;
          } catch (error) {
            return {
              status: "failed",
              errorCode: errorCodeOf(error),
              output: error instanceof Error ? error.message : String(error),
            };
          }
        };

        const execution = selectedTool.ledgerPolicy === "bypass" || isSubAgent
          ? { outcome: await runExecution(), cached: false }
          : await executionLedger.execute({
              capability: decision.capability,
              targetRefs: decision.targetRefs,
              args,
            }, runExecution);
        const outcome = normalizeToolExecutionOutcome(execution.outcome);

        // 子代理重复委托保护：比较当前结果与上一次相同子代理的结果
        if (isSubAgent && outcome.status === "succeeded") {
          const lastSubAgentResult = state.toolResults
            .filter(r => r.toolId === selectedTool.id && r.status === "succeeded")
            .pop();
          if (lastSubAgentResult) {
            // 使用稳定序列化比较 args（忽略 key 顺序）
            const stableArgs = (obj: unknown): string => {
              if (Array.isArray(obj)) return `[${obj.map(stableArgs).join(",")}]`;
              if (obj && typeof obj === "object") {
                return `{${Object.keys(obj as Record<string, unknown>).sort().map(k => `${k}:${stableArgs((obj as Record<string, unknown>)[k])}`).join(",")}}`;
              }
              return JSON.stringify(obj);
            };

            // 从输出中提取语义字段（排除 taskId、traceRef、时间戳、随机 ID）
            // 所有数组都进行稳定排序，确保顺序差异不被误判为新进展
            const extractSemanticFingerprint = (output: string): string => {
              try {
                const parsed = parseSubAgentResult(output);
                return JSON.stringify({
                  profile: parsed.profile,
                  status: parsed.status,
                  findingsCount: parsed.findings.length,
                  findingsContent: parsed.findings
                    .map(f => ({ content: f.content?.slice(0, 100), source: f.source }))
                    .sort((a, b) => (a.content ?? "").localeCompare(b.content ?? "")),
                  artifactsCount: parsed.artifacts.length,
                  artifactsPaths: parsed.artifacts.map(a => a.path).filter(Boolean).sort(),
                  completionEvidence: parsed.completionEvidence
                    .map(e => ({ criterion: e.criterion, satisfied: e.satisfied }))
                    .sort((a, b) => a.criterion.localeCompare(b.criterion)),
                  missingInformation: parsed.missingInformation?.slice().sort(),
                  errorCode: parsed.error?.code,
                });
              } catch {
                // 解析失败时使用完整输出的长度+前缀+后缀作为指纹
                // 不使用 slice(0, 200)，因为它无法区分前缀相同但后续不同的结果
                return `len:${output.length}|head:${output.slice(0, 50)}|tail:${output.slice(-50)}`;
              }
            };

            const currentArgsFingerprint = stableArgs(args);
            const lastArgsFingerprint = stableArgs(lastSubAgentResult.args);
            const currentResultFingerprint = extractSemanticFingerprint(outcome.output);
            const lastResultFingerprint = extractSemanticFingerprint(lastSubAgentResult.output);

            if (currentArgsFingerprint === lastArgsFingerprint && currentResultFingerprint === lastResultFingerprint) {
              // 相同参数 + 相同语义结果 → 无进展
              outcome.status = "failed";
              outcome.output = JSON.stringify({
                kind: "subagent_result", version: 1,
                taskId: "no_progress", profile: selectedTool.subAgentProfile ?? "unknown",
                status: "failed", summary: "子代理重复委托：相同参数返回相同结果",
                findings: [], artifacts: [], completionEvidence: [],
                error: { code: "SUBAGENT_NO_PROGRESS", message: "子代理重复委托：相同参数返回相同结果", recoverable: false },
              });
              outcome.errorCode = "SUBAGENT_NO_PROGRESS";
              outcome.terminal = true;
              outcome.retryable = false;
            }
          }
        }

        const deduplicated = execution.cached && outcome.terminal;
        if (deduplicated) {
          duplicateTerminalStreak += 1;
          // 连续 2 次重复同一终态动作，说明模型没有吸收"动作已完成"的事实，提前抛错。
          if (duplicateTerminalStreak >= 2) {
            throw new AgentRuntimeError(
              "E_AGENT_NO_PROGRESS",
              "Agent repeated an already completed terminal action.",
            );
          }
        } else {
          duplicateTerminalStreak = 0;
        }
        const planStep = state.taskPlan && state.currentStepId
          ? findStep(state.taskPlan, state.currentStepId)
          : undefined;
        const attemptId = planStep ? generateAttemptId() : undefined;
        const result: ToolCallResult = {
          toolId: selectedTool.id,
          args,
          output: outcome.output,
          status: outcome.status,
          capabilityId: selectedTool.capability ?? selectedTool.id,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
          terminal: outcome.terminal,
          retryable: outcome.retryable,
          ...(deduplicated ? { deduplicated: true } : {}),
          ...(planStep ? {
            planId: state.taskPlan!.id,
            stepId: state.currentStepId,
            stepExecutionId: planStep.executionId,
            stepAttemptId: attemptId,
          } : {}),
        };
        debugLog(`${LOG_PREFIX} node=tool-result tool=${selectedTool.id} status=${outcome.status} cached=${execution.cached} deduplicated=${deduplicated}${outcome.errorCode ? ` errorCode=${outcome.errorCode}` : ""}`);
        flowLog(
          outcome.status === "succeeded"
            ? `6. 工具结果：成功${execution.cached ? "（使用已有结果）" : ""}`
            : `6. 工具结果：失败${outcome.errorCode ? `（${outcome.errorCode}）` : ""}`,
        );
        const messageId = `tool-result-${Date.now()}`;
        options.onEvent?.({ type: "tool_call_result", toolCallId, messageId, content: outcome.output, status: outcome.status });
        options.onEvent?.({ type: "tool_call_end", toolCallId });

        // ── 记录成功的工具到 executionStatus ──
        if (result.status === "succeeded") {
          const toolExec: SuccessfulToolExecution = {
            capabilityId: result.capabilityId ?? selectedTool.id,
            actionLabel: selectedTool.soulActionLabel ?? selectedTool.name ?? selectedTool.id,
            completionClaims: [],
          };
          // 从 completionEvidence 提取 claims
          if (selectedTool.completionEvidence) {
            for (const ev of selectedTool.completionEvidence) {
              if (ev.kind === "tool_succeeded") {
                toolExec.completionClaims.push("tool_succeeded");
              } else if (ev.kind === "projection_claim" && ev.claimKind) {
                toolExec.completionClaims.push(ev.claimKind);
              }
            }
          }
          executionStatus.successfulTools.push(toolExec);

          // 从可信 completionEvidence 提取文件产物
          if (selectedTool.completionEvidence?.some((e) => e.kind === "tool_succeeded")) {
            const artifactKinds: Record<string, CreatedArtifact["kind"]> = {
              write_word: "docx", write_excel: "xlsx", write_pdf: "pdf", write_markdown: "markdown",
            };
            const kind = artifactKinds[selectedTool.id];
            if (kind) {
              // 从工具输出中提取路径（只接受声明了产物的工具）
              const pathMatch = result.output.match(/已生成[：:]\s*(.+)$/);
              if (pathMatch) {
                executionStatus.createdArtifacts.push({
                  path: pathMatch[1].trim(),
                  kind,
                  capabilityId: result.capabilityId ?? selectedTool.id,
                });
              }
            }
          }
        }

        return [result];
      } finally {
        options.onEvent?.({ type: "step_finished", stepName: `agent-graph-tool-${selectedTool.id}` });
      }
    },
    respond: async (state: AgentGraphState, decision) => {
      executionStatus.phase = "soul";
      ensureBudget();
      options.onEvent?.({ type: "step_started", stepName: "agent-graph-soul" });

      // 固化 FinalizationOutcome（如果 Guard 未设置则防御性计算）
      if (!state.finalizationOutcome) {
        state.finalizationOutcome = resolveCompletionStatus(state, { kind: "allow_success" });
      }

      const streamBridge = new WorkStreamEventBridge(
        "soul",
        options.onEvent,
        options.tools,
        `agent-graph-soul-${Date.now()}`,
        false,
      );
      try {
        flowLog("7. 生成最终回复");
        const localNonExecutionFact = state.toolResults
          .slice()
          .reverse()
          .find((item) => item.toolExecuted === false);
        // 代码已验证通过时，不注入 FAILURE_SOUL_POLICY（避免使用过期的 E_FINALIZATION_BLOCKED）
        const cv = state.codeVerification;
        const codeVerified = cv
          && cv.mutationRevision > 0
          && cv.verifiedRevision === cv.mutationRevision
          && cv.status === "passed";
        const failureInstruction = !codeVerified && (decision.decision === "failure" || localNonExecutionFact)
          ? [
              "[FAILURE_SOUL_POLICY]",
              "A local trusted failure occurred before Tool Runtime execution.",
              "Use only the trusted failure facts below. Be honest and concise.",
              "Never claim that a tool, request, or external action was executed successfully.",
              `TRUSTED_FAILURE_FACT=${JSON.stringify(
                decision.decision === "failure" ? decision : localNonExecutionFact,
              )}`,
              "[/FAILURE_SOUL_POLICY]",
            ].join("\n")
          : "";
        // 闭世界投影：mutation 证据优先于控制信号
        const codeVerificationContext = formatCodeVerificationContext(
          state.codeVerification, state.finalizationOutcome, state.toolResults,
        );
        const system = [
          options.soulSystemBaseContent,
          options.responseContext ?? "",
          // 第一优先：代码验证上下文（mutation 证据 + 验证状态）
          codeVerificationContext,
          // 第二优先：执行上下文（工具执行摘要）
          formatSoulExecutionContext(buildSoulExecutionContext(state.toolResults, options.tools)),
          SOUL_NO_TOOL_DIRECTIVE,
          // 第三优先：失败指令（控制信号，不覆盖 mutation 证据）
          failureInstruction,
          `[ACTION_DECISION]\n${JSON.stringify(decision)}\n[/ACTION_DECISION]`,
          state.clarificationAnswers.length > 0
            ? `[CLARIFICATION_ANSWERS]\n${JSON.stringify(state.clarificationAnswers)}\n[/CLARIFICATION_ANSWERS]`
            : "",
        ].filter(Boolean).join("\n\n");
        const soulMessages = [{ role: "system" as const, content: system }, ...state.messages];
        const soulRequest = {
          model: options.settings.model,
          messages: soulMessages,
          stream: false,
          ...(options.soulSampling ?? {}),
        };
        // 脱敏日志：只记结构，不记内容
        debugLog(`${LOG_PREFIX} node=soul messages=${soulMessages.length} tools=none structuredOutput=none`);
        for (let i = 0; i < soulMessages.length; i++) {
          const m = soulMessages[i] as unknown as Record<string, unknown>;
          const contentType = typeof m.content === "string" ? `string(${(m.content as string).length})` : Array.isArray(m.content) ? `array(${(m.content as unknown[]).length})` : typeof m.content;
          const toolCalls = Array.isArray(m.tool_calls) ? ` tool_calls=${m.tool_calls.length}` : "";
          const toolCallId = typeof m.tool_call_id === "string" ? ` tool_call_id=${m.tool_call_id}` : "";
          debugLog(`${LOG_PREFIX}   msg[${i}] role=${m.role} content=${contentType}${toolCalls}${toolCallId}`);
        }
        const response = await perf.track("respond_soul_llm", () => invokeWithFallback(
          () => soulRequest,
          undefined,
          state.messages,
          undefined,
          streamBridge.onDelta,
        ));
        trackUsage(response.usage);
        const rawText = response.text ?? "";
        const stripped = stripToolProtocol(rawText);
        const visibleText = stripLeakedChatTimeContext(stripped);
        // 诊断日志：追踪空白气泡根因
        if (!visibleText.trim()) {
          console.warn(LOG_PREFIX, "Soul 回复为空",
            "rawText.length=" + rawText.length,
            "afterStripTool=" + stripped.length,
            "afterStripTime=" + visibleText.length,
            "toolResults=" + state.toolResults.length,
            "successful=" + state.toolResults.filter((r) => r.status === "succeeded").length,
          );
        }
        const reply = visibleText.trim() || buildSoulBlankFallback(state);
        streamBridge.finish(response, reply);
        return reply;
      } catch (error) {
        streamBridge.abort();
        throw error;
      } finally {
        options.onEvent?.({ type: "step_finished", stepName: "agent-graph-soul" });
      }
    },
  }));

    // 图执行成功，标记 taskCompletionConfirmed
    executionStatus.taskCompletionConfirmed = true;
  } catch (error) {
    // 不重复包装
    if (error instanceof AgentExecutionError) throw error;

    const snapshot = snapshotRunExecutionStatus(executionStatus);

    // ── Soul 阶段失败 + 有成功工具 → 部分成功 fallback ──
    // 用户取消（E_AGENT_GRAPH_CANCELLED）不触发
    const isUserCancel = error instanceof Error && error.message === "E_AGENT_GRAPH_CANCELLED";
    if (snapshot.phase === "soul" && snapshot.successfulTools.length > 0 && !isUserCancel) {
      const partialReply = buildPartialSuccessReply(snapshot);
      flowLog("7. Soul 失败，降级返回部分成功结果");
      return {
        reply: partialReply,
        toolResults: [],  // 部分成功时不返回完整工具结果（已在 snapshot 中）
        totalUsage: usageInput || usageOutput ? { input: usageInput, output: usageOutput } : undefined,
        soulPhaseReason: "tool_error",
      };
    }

    throw new AgentExecutionError(
      "LangGraph execution failed",
      snapshot,
      { cause: error },
    );
  }

  return {
    reply: result.reply,
    toolResults: result.toolResults,
    totalUsage: usageInput || usageOutput ? { input: usageInput, output: usageOutput } : undefined,
    soulPhaseReason: "no_tool",
  };
}
