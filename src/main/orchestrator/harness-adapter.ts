/**
 * CyreneHarness ↔ CyreneAgent 适配层
 *
 * 把 CyreneRunOptions 转换为 HarnessInput，运行 Harness，
 * 再把 HarnessEvent 转为 AG-UI BaseEvent，HarnessResult 转为 AgentLoopResult。
 *
 * 设计依据：docs/design/2026-08-08-cyreneHarnessloopdesign.md (v3 §11)
 */

import * as fs from "fs";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { ChatMessage, VendorConfig } from "./vendors/types";
import type { ToolDefinition } from "./tool-registry";
import { toolRegistry } from "./tool-registry";
import { checkPermission, type ToolRiskLevel } from "../permission";
import { policyFor } from "../permission-policy";
import {
  completeExecution,
  getPlanPath,
  getPlanState,
  isPlanReadOnly,
  supplementPlan,
} from "./plan-mode";
import { contextRefRegistry, extractLastUserQuery, type ToolContext } from "./tool-context";
import { runCyreneHarness } from "./harness";
import type { HarnessEvent, HarnessInput } from "./harness";
import {
  TODO_WORKING_NOTEBOOK_POLICY,
  buildCurrentTodoNotebookContext,
} from "./harness/todo-working-notebook";
import { appendInternalTranscriptMessage, createInternalTranscriptMessage } from "./harness/internal-transcript";
import type { AgentState, HarnessCacheState } from "./harness/types";
import type { PromptLayers } from "./prompt-layers";
import type { AgentLoopResult } from "./cyrene-agent";
import type { CyreneRunOptions, AgentLoopSettings } from "./cyrene-agent";
import type { ToolCallResult } from "./types";
import type { CyreneRunTerminalResult } from "../../shared/run-terminal";
import { loadPromptFile } from "../prompts/prompt-loader";
import type { ConversationMode } from "../../shared/chat-types";
import { app } from "electron";
import { TaskSessionStore } from "../tasks/task-session-store";
import { createTaskExecutor } from "./task-runtime";
import { FileToolOutputStore } from "./harness/tool-output/file-tool-output-store";
import { getHarnessRunStore, type HarnessRequestSnapshot } from "./harness/run-store";
import { getRunReviewTracker } from "./review/run-review-tracker";
import type { ReviewRunStatus } from "../../shared/review-types";
import { prepareHarnessRecovery } from "./harness/run-recovery";
import type { TaskDelegationPresentation } from "../../shared/task-session";
import { createHash } from "node:crypto";

const LOG_PREFIX = "[HarnessAdapter]";
const CODE_ONLY_GIT_TOOL_IDS = new Set([
  "git_status",
  "git_init",
  "git_commit",
  "git_switch_branch",
  "git_push",
  "git_revert",
]);

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function snapshotHarnessRequest(
  options: CyreneRunOptions,
  promptLayers: PromptLayers,
  tools: ToolDefinition[],
): HarnessRequestSnapshot {
  return {
    provider: options.settings.provider,
    model: options.settings.model,
    contextWindowTokens: options.settings.contextWindowTokens,
    ...(options.settings.reasoning ? { reasoning: JSON.stringify(options.settings.reasoning) } : {}),
    ...(options.conversationMode ? { mode: options.conversationMode } : {}),
    promptFingerprint: fingerprint(promptLayers.stablePrefix),
    toolSchemaFingerprint: fingerprint(tools.map((tool) => ({
      id: tool.id,
      description: tool.description,
      schema: tool.inputSchema,
    })).sort((left, right) => left.id.localeCompare(right.id))),
    enabledToolIds: tools.map((tool) => tool.id).sort(),
    ...(options.resolvedWorkspaceRoot ? { workspaceRoot: options.resolvedWorkspaceRoot } : {}),
  };
}

/**
 * 将启动/恢复时的动态事实一次性写入主 transcript。
 * 这一步必须发生在 Run Store.create 之前，才能让首次 LLM 调用也可恢复。
 */
export function materializeHarnessStartTranscript(input: {
  messages: readonly ChatMessage[];
  runId: string;
  runtimeContext?: string;
  initialState?: AgentState;
  kind: "run_start" | "recovery";
}): ChatMessage[] {
  const parts = [
    input.runtimeContext,
    input.initialState?.todoItems.length
      ? buildCurrentTodoNotebookContext(input.initialState.todoItems)
      : undefined,
  ].filter((part): part is string => Boolean(part?.trim()));
  if (parts.length === 0) return [...input.messages];

  const revision = input.messages.reduce(
    (current, message) => Math.max(current, message.internal?.revision ?? 0),
    0,
  ) + 1;
  return appendInternalTranscriptMessage(input.messages, createInternalTranscriptMessage({
    kind: input.kind,
    revision,
    runId: input.runId,
    content: parts.join("\n\n---\n\n"),
  }));
}

export function filterToolsForConversationMode(
  mode: ConversationMode | undefined,
  tools: ToolDefinition[],
): ToolDefinition[] {
  if (mode === "code") return tools;
  return tools.filter((tool) => !CODE_ONLY_GIT_TOOL_IDS.has(tool.id));
}

/**
 * 运行 CyreneHarness 并返回统一的 AgentLoopResult。
 *
 * @param options CyreneRunOptions（与旧循环相同的输入）
 * @param signal 取消信号
 * @param sendBaseEvent 直接发送 AG-UI BaseEvent 的回调
 */
export async function runHarnessWithAdapter(
  options: CyreneRunOptions,
  signal: AbortSignal,
  sendBaseEvent: (event: BaseEvent) => void,
): Promise<AgentLoopResult> {
  const messageId = `msg-${Date.now()}`;
  // 使用 canonical runId（由 CyreneAgent.runWithEvents 写回 options.runId）。
  // 不再生成 harness-${Date.now()}，避免 ack.runId 与 RUN_STARTED.runId 不一致。
  // CyreneAgent 保证此字段已被填充（fallback 由 createRunId() 在 runWithEvents 入口补齐）。
  const runId = options.runId;
  if (!runId) {
    throw new Error(
      "[HarnessAdapter] options.runId is required. CyreneAgent.runWithEvents must populate it before invoking the adapter.",
    );
  }
  const threadId = options.conversationId ?? "default";

  // ── 计划模式 run 首钩（设计稿 §3 / §7）──
  // PLAN_REVIEW 期间用户直接发新消息：视为对计划的补充讨论，拉回 PLAN_DISCUSSING。
  // code 与 chat（开启工具走 harness）参与计划状态机；work 会话恒为 NORMAL。
  if (
    (options.conversationMode === "code" || options.conversationMode === "chat")
    && getPlanState(threadId) === "PLAN_REVIEW"
  ) {
    supplementPlan(threadId);
    console.log(`${LOG_PREFIX} [Plan] new message during PLAN_REVIEW, back to PLAN_DISCUSSING`);
  }
  // run 组装时的计划状态快照：决定计划工具组的初始注入（builtin-tools §planToolSpecsFor）。
  // chat 模式仅在开启工具走 harness 时才会到达这里，planState 为 undefined 的旧调用方不受影响。
  const planState = options.conversationMode === "code" || options.conversationMode === "chat"
    ? getPlanState(threadId)
    : undefined;

  // EXECUTING：把已批准的计划全文作为 run 级事实注入 wire-only runtime context
  // （与 recoveryContext 同通道，进 transcript，不污染缓存前缀）。
  let planContextBlock: string | undefined;
  if (planState === "EXECUTING") {
    try {
      const planContent = await fs.promises.readFile(getPlanPath(threadId), "utf8");
      planContextBlock = [
        "[PLAN_CONTEXT]",
        "用户已批准以下实施计划。请严格按计划清单顺序执行，用 update_todo 维护任务进度：",
        "",
        planContent.trim(),
      ].join("\n");
    } catch (err) {
      console.warn(`${LOG_PREFIX} [Plan] read plan.md failed:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`${LOG_PREFIX} starting harness run, mode=${options.conversationMode ?? "work"}${planState ? ` plan=${planState}` : ""}`);

  // ── 构建 VendorConfig ──
  const vendorConfig: VendorConfig = {
    provider: options.settings.provider,
    baseUrl: options.settings.baseUrl,
    model: options.settings.model,
    apiKey: options.settings.apiKey,
    explicitTransport: options.settings.explicitTransport,
    reasoning: options.settings.reasoning,
  };

  // ── 构建工具列表 ──
  const tools = [...(options.capabilities?.tools ?? options.tools ?? toolRegistry.getEnabledTools())];
  const runStore = getHarnessRunStore(app.getPath("userData"));
  const recovered = options.resumeFromRunId
    ? (() => {
      const previous = runStore.get(options.resumeFromRunId!);
      if (!previous || previous.conversationId !== threadId) throw new Error("HARNESS_RECOVERY_NOT_FOUND");
      return prepareHarnessRecovery(previous, {
        workspaceRoot: options.resolvedWorkspaceRoot,
        provider: options.settings.provider,
        model: options.settings.model,
        enabledToolIds: tools.map((tool) => tool.id),
      });
    })()
    : undefined;
  // "继续任务"本身也是新的用户意图：恢复旧快照时保留它，避免模型只看到
  // 旧 transcript（对话记录）而不知道用户已明确授权继续。
  const latestIncomingMessage = options.messages.at(-1);
  const baseRunMessages = recovered
    ? [
      ...recovered.messages,
      ...(latestIncomingMessage?.role === "user" ? [{ ...latestIncomingMessage }] : []),
    ]
    : options.messages;
  const recoveryContext = [options.recoveryContext, recovered?.recoveryContext, planContextBlock]
    .filter(Boolean).join("\n\n");
  // 恢复/CITA 等本轮事实放在 wire-only runtime context，不能污染缓存前缀。
  const promptLayers = buildHarnessPromptLayers(
    recoveryContext ? { ...options, recoveryContext } : options,
  );
  const runMessages = materializeHarnessStartTranscript({
    messages: baseRunMessages,
    runId,
    runtimeContext: promptLayers.runtimeContext,
    initialState: recovered?.state,
    kind: recovered ? "recovery" : "run_start",
  });
  // 动态启动事实已经写入 transcript；后续每轮不得重新作为 runtime tail 注入。
  const harnessPromptLayers: PromptLayers = {
    stablePrefix: promptLayers.stablePrefix,
    ...(promptLayers.sessionPrefix ? { sessionPrefix: promptLayers.sessionPrefix } : {}),
    ...(promptLayers.mode ? { mode: promptLayers.mode } : {}),
  };
  const systemPrompt = harnessPromptLayers.stablePrefix;
  runStore.create({
    conversationId: threadId,
    runId,
    messages: runMessages,
    request: snapshotHarnessRequest(options, harnessPromptLayers, tools),
    ...(recovered ? { state: recovered.state, cache: recovered.cache } : {}),
    ...(options.resumeFromRunId ? { resumedFromRunId: options.resumeFromRunId } : {}),
  });

  // ── 构建工具上下文 ──
  const toolContext: ToolContext = {
    userQuery: extractLastUserQuery(options.messages),
    conversationId: options.conversationId ?? "default",
    runId,
    contextRefs: contextRefRegistry,
    signal,
    resolvedWorkspaceRoot: options.resolvedWorkspaceRoot,
    mode: options.conversationMode,
    allowedSkillIds: options.capabilities?.skillIds,
    permissionMode: options.permissionMode,
  };
  const permissionCheck = async (toolId: string, args: Record<string, unknown>): Promise<boolean> => {
    if (options.permissionMode === "allow_all") return true;
    // 计划只读第二层（设计稿 §5）：PLAN_DISCUSSING/PLAN_REVIEW 期间运行时兜底拦截。
    // 第一层在 build-options 组装时已过滤工具列表；此处覆盖恢复 run、
    // 状态中途切换等旁路路径。策略与第一层一致（read-only 档位允许的风险级）。
    if (
      (options.conversationMode === "code" || options.conversationMode === "chat")
      && isPlanReadOnly(threadId)
    ) {
      const planTool = toolRegistry.getById(toolId) as (ToolDefinition & { risk?: ToolRiskLevel }) | undefined;
      const planRisk: ToolRiskLevel = planTool?.risk ?? "safe";
      if (policyFor("read-only", planRisk) !== "allow") {
        console.log(`${LOG_PREFIX} [Plan] read-only enforcement blocked tool=${toolId} risk=${planRisk}`);
        return false;
      }
    }
    const tool = toolRegistry.getById(toolId);
    if (!tool) return false;
    const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk ?? "safe";
    return (await checkPermission({ toolId, toolName: tool.name, toolDescription: tool.description, args, risk, runId, signal })).allowed;
  };
  const toolOutputStore = new FileToolOutputStore(app.getPath("userData"));
  const taskExecutor = options.conversationMode === "work" || options.conversationMode === "code"
    ? createTaskExecutor({
      parent: { parentConversationId: threadId, parentRunId: runId, mode: options.conversationMode,
        capabilities: options.capabilities,
        systemPrompt, vendorConfig, tools, resolvedWorkspaceRoot: options.resolvedWorkspaceRoot, signal,
        checkPermission: permissionCheck, includeInteractiveTools: options.harnessInteractiveTools,
        permissionMode: options.permissionMode, toolOutputStore },
      store: new TaskSessionStore(app.getPath("userData")),
      onLifecycle: (event) => sendTaskLifecycleAsAgui(event, threadId, runId, sendBaseEvent),
    })
    : undefined;

  // ── 构建 HarnessInput ──
  const harnessInput: HarnessInput = {
    systemPrompt,
    promptLayers: harnessPromptLayers,
    usageParts: promptLayers.usageParts,
    messages: runMessages,
    runId,
    ...(recovered ? { initialState: recovered.state } : {}),
    ...(recovered ? { initialCache: recovered.cache } : {}),
    tools,
    vendorConfig,
    config: {
      maxParallelToolCalls: options.maxParallelToolCalls,
      // 0 表示禁用整轮执行时钟；单次模型/工具超时仍由各自策略处理。
      totalTimeoutMs: 0,
      contextWindowTokens: options.settings.contextWindowTokens,
    },
    signal,
    onEvent: (event: HarnessEvent) => {
      if (!signal.aborted) {
        sendHarnessEventAsAgui(event, messageId, threadId, runId, sendBaseEvent);
      }
    },
    onCheckpoint: (checkpoint) => {
      runStore.checkpoint(runId, {
        messages: checkpoint.messages,
        state: checkpoint.state,
        toolOutputs: checkpoint.toolOutputs,
        rounds: checkpoint.rounds,
      });
    },
    onToolLifecycle: (event) => {
      runStore.recordTool(runId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        sideEffect: event.toolSideEffect,
        status: event.status,
      });
    },
    onCompactionLifecycle: (event) => runStore.recordCompaction(runId, event),
    requestUserClarification: options.requestUserClarification
      ? (card) => options.requestUserClarification!(card as never, signal)
      : undefined,
    includeInteractiveTools: options.harnessInteractiveTools,
    planState,
    toolContext,
    toolOutputStore,
    executionLedger: options.executionLedger,
    checkPermission: permissionCheck,
    taskExecutor,
  };

  // ── 运行 Harness ──
  const result = await runCyreneHarness(harnessInput);

  // ── 转换结果 ──
  const completionReason = mapTerminateReason(result.terminateReason);
  // 把 HarnessResult.terminateReason 映射为 canonical terminal，
  // 供 CyreneAgent.runWithEvents 写入 RUN_FINISHED.result。
  // 优先使用 harness 自身填的 result.terminal（如果未来 harness 内部直接写）。
  // P1 修订：success 路径必须消费 Harness 的确定性状态——
  // 若 finalState.uncertainEffects 非空，externalEffectsMayContinue 必须为 true，
  // 即使 status=success 也不能谎报 false（unknown-side-effect 的诚实 final 是允许的）。
  const hasUncertainEffects = result.finalState.uncertainEffects.length > 0;
  const terminal = result.terminal ?? mapTerminateReasonToTerminal(
    result.terminateReason,
    hasUncertainEffects,
  );
  const terminalRunStatus = terminal.status === "success"
    ? "completed"
    : terminal.status === "cancelled" ? "cancelled" : "failed";
  const finalSession = runStore.markTerminal(runId, terminalRunStatus);

  // ── Review 快照：Run 终止时生成不可变 ReviewSnapshot ──
  // 正常终止时主动 finalize；崩溃恢复（interrupted）的 Run 由前端打开 Review 时
  // 通过 finalizeIfPending 按需补生成。
  try {
    const tracker = getRunReviewTracker(app.getPath("userData"));
    const reviewStatus: ReviewRunStatus = terminalRunStatus;
    tracker.finalizeReview(runId, finalSession.createdAt, reviewStatus);
  } catch (err) {
    // Review 生成失败不应阻塞 Run 结果返回
    console.error(`${LOG_PREFIX} finalizeReview failed:`, err);
  }

  // ── 计划模式 run 尾钩（设计稿 §3）──
  // 执行 run 结束（无论成败/取消）自动摘牌回 NORMAL；planPath 供前端"施工已完成"标注。
  // PLAN_DISCUSSING → PLAN_REVIEW 的转换不在 adapter 做：审批流由 agui-bridge 在
  // RUN_FINISHED 之后触发（需要 buildOptions 重开执行 run 的能力）。
  if (options.conversationMode === "code" || options.conversationMode === "chat") {
    const finishedPlanPath = completeExecution(threadId);
    if (finishedPlanPath) {
      console.log(`${LOG_PREFIX} [Plan] execution finished, back to NORMAL, plan=${finishedPlanPath}`);
      if (!signal.aborted) {
        sendBaseEvent({
          type: EventType.CUSTOM,
          name: "cyrene.plan.completed",
          value: { planPath: finishedPlanPath, runStatus: terminalRunStatus },
          threadId,
          runId,
        } as BaseEvent);
      }
    }
  }

  const toolResults: ToolCallResult[] = [];

  console.log(
    `${LOG_PREFIX} harness run complete, rounds=${result.rounds} terminated=${result.terminated} terminal=${terminal.status}`,
  );

  return {
    reply: result.finalAnswer,
    toolResults,
    completionReason,
    terminal,
    totalUsage: undefined,
  };
}

// ── System Prompt 构建 ─────────────────────────────────────

export function buildHarnessPromptLayers(
  options: CyreneRunOptions,
): PromptLayers & { usageParts?: { personaContent: string; toolLayerContent: string; skillLayerContent?: string } } {
  // 人设层（Soul）
  const personaParts: string[] = [];
  if (options.soulSystemBaseContent) {
    personaParts.push(options.soulSystemBaseContent);
  }

  // Harness 专属人设（cyrene_harness.md）
  // 设计稿 §4.3: 整个 Loop 用同一份,不做动态切换
  // 设计稿 §4.5: 这是 Persona 层,不承担 Runtime Policy
  // Chat 工具增强：chat 的 mode prompt 已含完整 soul.md 人设（449 行），
  // harness 精简人设（尾部约 45 行性格描述）与 soul.md 逐字重复，不再叠加；
  // work/learn/code 的 mode 文件不含 soul.md，仍靠精简人设补位。
  const harnessPersona = options.conversationMode === "chat"
    ? ""
    : loadPromptFile("cyrene_harness.md");
  if (harnessPersona) {
    personaParts.push(harnessPersona);
  }

  personaParts.push(TODO_WORKING_NOTEBOOK_POLICY);

  // 工具调度规则 + 使用规范（tool_usage.md），同一份 parts 列表派生，
  // 供上下文容量快照按"系统提示词 / 工具定义与 Skill 目录"分类，避免二次拼串漂移。
  const toolParts: string[] = [];
  if (options.toolSystemContent) {
    toolParts.push(options.toolSystemContent);
  }

  // 工具 / Skill / Task 委托统一使用规范（prompts/tool_usage.md）。
  // 唯一事实源：不在此处或各模式 system 文件里再放一份，避免规则散落与漂移。
  // chat 模式没有工具能力，不注入。
  if (options.conversationMode !== "chat") {
    const toolUsagePolicy = loadPromptFile("tool_usage.md");
    if (toolUsagePolicy) {
      toolParts.push(toolUsagePolicy);
    }
  }

  const runtimeParts: string[] = [];
  if (options.soulRuntimeContext) runtimeParts.push(options.soulRuntimeContext);
  // Plan Mode 指令（可变，不进 stablePrefix——进/出 plan mode 不打断缓存前缀）
  if (options.planSkillContext) runtimeParts.push(options.planSkillContext);
  if (options.runtimeEnvironmentContext) runtimeParts.push(options.runtimeEnvironmentContext);
  if (options.citaContextBlock) runtimeParts.push(options.citaContextBlock);
  if (options.recoveryContext) runtimeParts.push(`[RECOVERY_CONTEXT]\n${options.recoveryContext}`);
  // Response Context (CITA)
  if (options.responseContext) runtimeParts.push(`[RESPONSE_CONTEXT]\n${options.responseContext}`);

  const stablePrefix = [...personaParts, ...toolParts].join("\n\n---\n\n");
  const uniqueRuntimeParts = runtimeParts.filter((part) => !stablePrefix.includes(part));
  return {
    stablePrefix,
    usageParts: {
      personaContent: personaParts.join("\n\n---\n\n"),
      toolLayerContent: toolParts.join("\n\n---\n\n"),
      ...(options.skillLayerContent ? { skillLayerContent: options.skillLayerContent } : {}),
    },
    ...(options.conversationMode ? { mode: options.conversationMode } : {}),
    ...(uniqueRuntimeParts.length ? { runtimeContext: uniqueRuntimeParts.join("\n\n---\n\n") } : {}),
  };
}

/** @deprecated 兼容外部调用；Harness 主路径改用 buildHarnessPromptLayers。 */
export function buildHarnessSystemPrompt(options: CyreneRunOptions): string {
  const layers = buildHarnessPromptLayers(options);
  return [layers.stablePrefix, layers.runtimeContext].filter(Boolean).join("\n\n---\n\n");
}

// ── HarnessEvent → AG-UI BaseEvent ────────────────────────

/** 导出供 harness-adapter.test.ts 验证 runId stamp 不变量。 */
export function sendHarnessEventAsAgui(
  event: HarnessEvent,
  messageId: string,
  threadId: string,
  runId: string,
  send: (event: BaseEvent) => void,
): void {
  switch (event.type) {
    case "round_start":
    case "round_end": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.round",
        value: {
          action: event.type === "round_start" ? "start" : "end",
          roundId: event.roundId,
        },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "progress_text": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.process_text",
        value: { content: event.content },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "final_answer": {
      // 最终回复：发为 TEXT_MESSAGE
      send({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", threadId, runId } as BaseEvent);
      send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: event.content, threadId, runId } as BaseEvent);
      send({ type: EventType.TEXT_MESSAGE_END, messageId, threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_start": {
      send({ type: EventType.REASONING_MESSAGE_START, messageId: event.messageId, role: "assistant", threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_delta": {
      send({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: event.messageId, delta: event.delta, threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_end": {
      send({ type: EventType.REASONING_MESSAGE_END, messageId: event.messageId, threadId, runId } as BaseEvent);
      break;
    }
    case "tool_start": {
      send({
        type: EventType.TOOL_CALL_START,
        toolCallId: event.toolCallId,
        toolCallName: event.toolName,
        threadId,
        runId,
      } as BaseEvent);
      send({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: event.toolCallId,
        delta: JSON.stringify(event.args),
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "tool_end": {
      send({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${messageId}-tool-${event.toolCallId}`,
        toolCallId: event.toolCallId,
        content: event.preview,
        // Diff Review 卡片证据：完整结构化变更，独立于被截断的 preview 文本
        changes: event.changes,
        role: "tool",
        status: event.outcome === "success" ? "success" : "failed",
        threadId,
        runId,
      } as BaseEvent);
      send({
        type: EventType.TOOL_CALL_END,
        toolCallId: event.toolCallId,
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "todo_update": {
      // v3: 发 cyrene.todo 事件（单数），前端订阅此事件更新 todo 卡片
      send({
        type: EventType.CUSTOM,
        name: "cyrene.todo",
        value: { items: event.items },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "context_usage": {
      // 上下文容量快照：preRequest 每轮实时刷新，terminal 随消息持久化。
      send({
        type: EventType.CUSTOM,
        name: "cyrene.context.usage",
        value: event.snapshot,
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "runtime_feedback": {
      // Runtime Feedback 不发给 UI（内部反馈）
      break;
    }
    case "ask_user": {
      // ask_user 通过 requestUserClarification 处理，不需要额外事件
      break;
    }
    case "plan_mode_changed": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.plan",
        value: { action: "state_changed", state: event.state },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "plan_written": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.plan",
        value: { action: "written", planPath: event.planPath },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "error": {
      console.error(`${LOG_PREFIX} harness error: ${event.message}`);
      break;
    }
  }
}

/** TaskRuntime 私有生命周期到父 AG-UI 的唯一净化出口。 */
export function sendTaskLifecycleAsAgui(
  value: TaskDelegationPresentation,
  threadId: string,
  runId: string,
  send: (event: BaseEvent) => void,
): void {
  send({ type: EventType.CUSTOM, name: "cyrene.task", value, threadId, runId } as BaseEvent);
}

// ── 结果转换 ───────────────────────────────────────────────

function mapTerminateReason(
  reason: "max_rounds" | "timeout" | "cancelled" | "error" | undefined,
): "no_tool" | "timeout" | "max_rounds" | "tool_error" {
  switch (reason) {
    case "max_rounds":
      return "max_rounds";
    case "timeout":
      return "timeout";
    case "error":
      return "tool_error";
    default:
      return "no_tool";
  }
}

/**
 * 把 HarnessResult.terminateReason 映射为 canonical CyreneRunTerminalResult。
 *
 * 映射策略：
 * - undefined + hasUncertainEffects=false → success / false（模型自然收尾，无 unresolved uncertainty）
 * - undefined + hasUncertainEffects=true  → success / true（unknown-side-effect 的诚实 final）
 * - "max_rounds" → timeout, reason="max_rounds"
 * - "timeout" → timeout, reason="timeout"
 * - "cancelled" → cancelled, reason="user_cancelled"
 * - "error" → runtime_error, reason="E_HARNESS_FAILURE"
 *
 * P1 修订：success 路径的 externalEffectsMayContinue 由 hasUncertainEffects 决定，
 * 不再固定 false。cancelled / timeout / runtime_error 恒为 true，不受第二参数影响。
 *
 * cancelled / error 不再被 default 吞成 success。
 * runtime_error 必须最终走 RUN_ERROR（由 agui-bridge 在 next 回调里转换），
 * 不能触发成功收尾副作用（bridge complete 回调据 status 判定）。
 *
 * externalEffectsMayContinue 为必填 invariant。
 *
 * 导出供 harness-adapter.test.ts 直接单测映射不变量。
 *
 * @param reason HarnessResult.terminateReason
 * @param hasUncertainEffects result.finalState.uncertainEffects.length > 0；
 *   仅影响 undefined（success）路径，其他终态恒为 true。默认 false 保持向后兼容。
 */
export function mapTerminateReasonToTerminal(
  reason: "max_rounds" | "timeout" | "cancelled" | "error" | undefined,
  hasUncertainEffects: boolean = false,
): CyreneRunTerminalResult {
  switch (reason) {
    case "max_rounds":
      return { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true };
    case "timeout":
      return { status: "timeout", reason: "timeout", externalEffectsMayContinue: true };
    case "cancelled":
      return { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true };
    case "error":
      return { status: "runtime_error", reason: "E_HARNESS_FAILURE", externalEffectsMayContinue: true };
    default:
      // P1 修订：success 路径必须尊重 uncertainEffects，不能谎报 false。
      return { status: "success", externalEffectsMayContinue: hasUncertainEffects };
  }
}
