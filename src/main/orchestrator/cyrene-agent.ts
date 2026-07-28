// CyreneAgent —— 把两阶段 FC 循环包进 AG-UI 的 AbstractAgent。
//
// 第一期重构：
// - 持有 runWithEvents 入口，按 agentRuntime 选择 runLangGraphAgentLoop 或 runTwoPhaseFcLoop。
// - 工具阶段只携带 tool_system + tools schema；Soul 阶段只携带 soul_systemBase + 工具结果摘要，不携带 tools。
// - runWithEvents 把 TwoPhaseEvent 包装成 AG-UI BaseEvent 转发给渲染端。
//
// 设计要点：
// - FC 循环仍是 stream:false 一次性拿全文（不碰 LLM 层），拿到全文后切成 delta 逐个发
//   TEXT_MESSAGE_CONTENT，这就是"流式感"的来源——标准 AG-UI 做法。
// - run() 不做副作用（不写记忆、不推断表情）。那些在桥层 runAgent 完成后做，
//   保持 agent 纯粹只管"产出事件流"。
// - 错误用 observer.error() 抛，桥层捕获。
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { AgentRuntimeError } from "./agent-runtime-error";
import { AgentExecutionError, type RunPhase } from "./run-execution-status";
import { Observable } from "rxjs";
import { toolRegistry, type ToolDefinition } from "./tool-registry";
import type { ToolCallResult, ToolExecutionOutcome } from "./types";
import { checkPermission, type ToolRiskLevel } from "../permission";
import { getAdapterForConfig, type ChatMessage } from "./vendors";
import { contextRefRegistry, extractLastUserQuery, type ToolContext } from "./tool-context";
import {
  runTwoPhaseFcLoop,
  type TwoPhaseEvent,
  type TwoPhaseFcResult,
} from "./two-phase-fc-loop";
import { getTimeoutSettings } from "../timeout-manager";
import { runLangGraphAgentLoop } from "./langgraph-agent-loop";
import { runChatLoop } from "./chat-loop";
import type { SocialAtom } from "../social-context/types";
import { ExecutionLedgerStore } from "./execution-ledger";
import { perf } from "../perf-trace";
import { debugLog, flowLog } from "../agent-log";
import type { ApprovedStyleSampling } from "./vendors/style-sampling";
import { requestUserClarification } from "../user-choice";
import type { TrustedAskUserProfile } from "../../shared/ask-clarification";
import type { SkillRouteInfo } from "./task-router";

const executionLedgers = new ExecutionLedgerStore();

export interface AgentLoopSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
  reasoning?: import("../../shared/reasoning").ReasoningPreference;
}

export type AgentExecutionMode = "work" | "chat";

/** CyreneAgent.run() 需要的输入——桥层构造好后塞进 input.state 或 forwardedProps。 */
export interface CyreneRunOptions {
  settings: AgentLoopSettings;
  /** 原始消息（不含 system）。FC 循环按阶段动态注入。 */
  messages: ChatMessage[];
  conversationId?: string;
  /** CITA 保留的用户原始 Query；旧调用方未传时从最后一条 user 消息读取。 */
  originalQuery?: string;
  /** CITA 生成的上下文化理解，供 Action Gate 显式使用。 */
  contextualizedQuery?: string;
  /** 独立 CITA 证据块；原始 user 消息不会被替换。 */
  citaContextBlock?: string;
  /** CITA 本地校验后允许 Action Gate 引用的不透明引用集合。 */
  trustedRefs?: string[];
  /** 临时回退开关；默认使用 LangGraph Runtime。 */
  agentRuntime?: "langgraph" | "legacy";
  /** Chat 跳过 CITA/Action Gate/Native FC；默认 Work。 */
  executionMode?: AgentExecutionMode;
  timeoutMs: number;
  /** 可选：本次 run 的工具集合。未传时使用当前所有已启用工具。 */
  tools?: ToolDefinition[];
  /** 直发图片被主模型接口拒绝时，懒加载 caption fallback 消息并重试。 */
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  /** 工具阶段使用的 system prompt（仅含工具调度规则 + 自动生成的工具目录）。 */
  toolSystemContent: string;
  toolSystemContentOptimizedForFirstRound?: string;
  /** Soul 阶段使用的基础 system prompt（人设 + 环境/记忆/关系/附件）。 */
  soulSystemBaseContent: string;
  disableLangGraph?: boolean;
  optimizeFirstRound?: boolean;
  /** 只应用到 Soul 最终自然语言回复，禁止影响 CITA、Action Gate 与 Native FC。 */
  soulSampling?: ApprovedStyleSampling;
  /** 不带时间戳前缀的 messages，给 Action Gate 用。未传时回退到 messages。 */
  cleanMessages?: ChatMessage[];
  /** Native FC 专用 system prompt（从 native_fc_system.md 读取）。 */
  nativeFcSystemContent?: string;
  /** Action Gate 专用 system prompt（从 action_gate_system.md 读取）。 */
  actionGateSystemPrompt?: string;
  /** [RESPONSE_CONTEXT] 文本，从 CITA 结果生成，给 Soul 动态追加。 */
  responseContext?: string;
  /** 本地主进程生成的可信默认城市、桌面等运行环境信息。 */
  runtimeEnvironmentContext?: string;
  /** Ask Soul 专用轻量提示词。 */
  askSystemContent?: string;
  /** Ask Soul 只使用称呼、昵称和性别约束。 */
  trustedAskUserProfile?: TrustedAskUserProfile;
  /** 仅 Chat：异步社交原子抽取所需的已校验证据元数据。 */
  socialContext?: {
    enabled: true;
    conversationId: string;
    userTurnId: string;
    assistantTurnId: string;
    retrievedAtoms: SocialAtom[];
    now: number;
  };
  /** Task Router 可用 Skill 列表（feature flag 开启时使用）。Router 不依赖该字段是否存在。 */
  availableSkills?: SkillRouteInfo[];
}

/** FC 循环最终结果（供桥层做副作用用）。 */
export interface CyreneRunResult {
  reply: string;
  toolResults: ToolCallResult[];
  totalUsage?: { input: number; output: number };
  soulPhaseReason?: "no_tool" | "max_rounds" | "timeout" | "tool_error";
  executionMode?: AgentExecutionMode;
  socialContext?: CyreneRunOptions["socialContext"];
}

const LOG_PREFIX = "[CyreneAgent]";

export function resolveAgentRuntime(runtime: CyreneRunOptions["agentRuntime"]): "langgraph" | "legacy" {
  return runtime === "legacy" ? "legacy" : "langgraph";
}

export function resolveExecutionMode(mode: unknown): AgentExecutionMode {
  // 兼容尚未重启的旧 renderer 与历史内部调用。
  return mode === "chat" || mode === "soul-only" ? "chat" : "work";
}

/**
 * 把 TwoPhaseEvent 包装成 AG-UI BaseEvent。
 */
function toAguiEvent(event: TwoPhaseEvent): BaseEvent {
  switch (event.type) {
    case "step_started":
      return { type: EventType.STEP_STARTED, stepName: event.stepName };
    case "step_finished":
      return { type: EventType.STEP_FINISHED, stepName: event.stepName };
    case "tool_call_start":
      return {
        type: EventType.TOOL_CALL_START,
        toolCallId: event.toolCallId,
        toolCallName: event.toolCallName,
      };
    case "tool_call_result":
      return {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: event.toolCallId,
        messageId: event.messageId,
        content: event.content,
      };
    case "tool_call_end":
      return { type: EventType.TOOL_CALL_END, toolCallId: event.toolCallId };
    case "text_message_start":
      return {
        type: EventType.TEXT_MESSAGE_START,
        messageId: event.messageId,
        role: event.role,
      };
    case "text_message_content":
      return {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: event.messageId,
        delta: event.delta,
      };
    case "text_message_end":
      return { type: EventType.TEXT_MESSAGE_END, messageId: event.messageId };
    case "task_plan_update":
      return { type: EventType.CUSTOM, name: "cyrene.taskPlan", value: event.snapshot };
  }
}

/**
 * 执行一个工具调用，封装权限检查 + toolRegistry 调用 + 异常转 output。
 * 由 runTwoPhaseFcLoop 通过 executeTool 注入回调调用。
 */
async function executeToolCall(
  tc: { id: string; name: string; arguments: string },
  runnableToolIds: Set<string>,
  ctx?: ToolContext,
): Promise<ToolExecutionOutcome> {
  const failed = (errorCode: string, output: string): ToolExecutionOutcome => ({
    status: "failed",
    errorCode,
    output,
  });
  const displayTool = toolRegistry.getById(tc.name);
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.arguments || "{}");
  } catch {
    return failed("E_TOOL_ARGS_INVALID", "工具参数解析失败");
  }

  if (!runnableToolIds.has(tc.name)) {
    return failed("E_TOOL_UNAVAILABLE", "工具不可用: " + tc.name);
  }
  const tool = displayTool;
  if (!tool || !tool.enabled) {
    return failed("E_TOOL_UNAVAILABLE", "工具不可用: " + tc.name);
  }

  const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk || "safe";
  const perm = await checkPermission({
    toolId: tc.name,
    toolName: tool.name,
    toolDescription: tool.description,
    args,
    risk,
  });
  if (!perm.allowed) {
    return failed("E_PERMISSION_DENIED", perm.reason || "权限不足");
  }

  try {
    return {
      status: "succeeded",
      output: await tool.execute(args, tool.needsContext ? ctx : undefined),
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const explicitCode = typeof err === "object" && err !== null && "code" in err
      && typeof (err as { code?: unknown }).code === "string"
      ? String((err as { code: string }).code)
      : undefined;
    const messageToken = errMsg.split(" ", 1)[0].split(":", 1)[0];
    const errorCode = explicitCode ?? (messageToken.startsWith("E_") ? messageToken : "E_TOOL_EXECUTION_FAILED");
    return failed(errorCode, errMsg);
  }
}

/**
 * CyreneAgent —— 单次对话一个实例。
 *
 * 用法：
 *   const agent = new CyreneAgent({ threadId });
 *   const result = await agent.runAgentWith(options);  // 跑循环 + 事件流
 */
export class CyreneAgent extends AbstractAgent {
  /** 跑循环结果，run() 完成后可取（供桥层做副作用）。 */
  lastResult?: CyreneRunResult;

  /**
   * 跑 FC 循环并返回事件流。桥层订阅这个流转发给渲染进程。
   * 传入的 options 会原样跑——settings/messages/timeout 都在这里。
   */
  runWithEvents(options: CyreneRunOptions): Observable<BaseEvent> {
    const threadId = this.threadId;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conversationId = options.conversationId ?? "default";
    const abortController = new AbortController();
    const timeoutSettings = getTimeoutSettings();

    // first-source-wins：谁先触发 abort，谁就是最终分类
    let abortSource: AbortSource | undefined;
    const markAbort = (source: AbortSource) => {
      if (abortSource) return; // 已有来源，不覆盖
      abortSource = source;
      abortController.abort({ source });
    };

    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;

      (async () => {
        try {
          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });

          const adapterTimer = perf.begin("get_adapter");
          const adapter = getAdapterForConfig(options.settings);
          adapterTimer.end();

          const onEvent = (event: TwoPhaseEvent) => {
            if (cancelled) return;
            subscriber.next(toAguiEvent(event));
          };
          const executionMode = resolveExecutionMode(options.executionMode);
          const runtime = resolveAgentRuntime(options.agentRuntime);
          debugLog(
            `${LOG_PREFIX} executionMode=${executionMode} agentRuntime=${runtime} provider=${options.settings.provider} model=${options.settings.model}`,
          );
          const enabledToolCount = executionMode === "chat"
            ? 0
            : (options.tools ?? toolRegistry.getEnabledTools()).filter((tool) => tool.enabled).length;
          flowLog("── 新请求 ─────────────────────────");
          flowLog(`1. 准备上下文：${executionMode === "chat" ? "Chat" : "Work"} 模式，模型 ${options.settings.model}，${enabledToolCount} 个工具可用`);
          flowLog(`2. 理解用户请求：${executionMode === "chat" ? "Chat 模式无需工具上下文" : `完成，可信引用 ${(options.trustedRefs ?? []).length} 个`}`);

          let result: TwoPhaseFcResult;
          if (executionMode === "chat") {
            flowLog("3. Chat 模式：生成回复");
            result = await perf.track("chat_loop", () => runChatLoop({
              settings: options.settings,
              adapter,
              messages: options.messages,
              soulSystemBaseContent: options.soulSystemBaseContent,
              soulSampling: options.soulSampling,
              timeoutMs: options.timeoutMs,
              imageCaptionFallback: options.imageCaptionFallback,
              onEvent,
              signal: abortController.signal,
            }));
          } else {
            const executeTool = (tc: Parameters<typeof executeToolCall>[0], runnableToolIds: Set<string>) => executeToolCall(tc, runnableToolIds, {
              userQuery: extractLastUserQuery(options.messages),
              conversationId: options.conversationId ?? "default",
              runId,
              contextRefs: contextRefRegistry,
            });
            const commonOptions = {
              settings: options.settings,
              adapter,
              messages: options.messages,
              tools: options.tools ?? toolRegistry.getEnabledTools(),
              toolSystemContent: options.toolSystemContent,
              soulSystemBaseContent: options.soulSystemBaseContent,
              soulSampling: options.soulSampling,
              cleanMessages: options.cleanMessages,
              nativeFcSystemContent: options.nativeFcSystemContent,
              actionGateSystemPrompt: options.actionGateSystemPrompt,
              responseContext: options.responseContext,
              runtimeEnvironmentContext: options.runtimeEnvironmentContext,
              askSystemContent: options.askSystemContent,
              trustedAskUserProfile: options.trustedAskUserProfile,
              conversationId: options.conversationId ?? "default",
              requestUserClarification,
              timeoutMs: options.timeoutMs,
              executeTool,
              onEvent,
              signal: abortController.signal,
              markAbort,
              availableSkills: options.availableSkills ?? [],
            };
            const conversationId = options.conversationId ?? "default";
            const executionLedger = executionLedgers.forScope(`${conversationId}:messages-${options.messages.length}`);
            result = runtime === "langgraph"
              ? await perf.track("langgraph_agent_loop", () => runLangGraphAgentLoop({
                ...commonOptions,
                originalQuery: options.originalQuery ?? extractLastUserQuery(options.messages),
                contextualizedQuery: options.contextualizedQuery ?? options.originalQuery ?? extractLastUserQuery(options.messages),
                citaContextBlock: options.citaContextBlock ?? "",
                trustedRefs: options.trustedRefs ?? [],
                imageCaptionFallback: options.imageCaptionFallback,
                executionLedger,
                perCallTimeoutMs: timeoutSettings.perRoundTimeout,
              }))
              : await perf.track("legacy_agent_loop", () => runTwoPhaseFcLoop({
                ...commonOptions,
                imageCaptionFallback: options.imageCaptionFallback,
                perRoundTimeoutMs: timeoutSettings.perRoundTimeout,
                forceSummaryTimeoutMs: timeoutSettings.forceSummaryTimeout,
              }));
          }

          this.lastResult = {
            reply: result.reply,
            toolResults: result.toolResults,
            totalUsage: result.totalUsage,
            soulPhaseReason: result.soulPhaseReason,
            executionMode,
            socialContext: options.socialContext,
          };
          flowLog("── 本轮完成 ────────────────────────");

          if (cancelled) return;
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
          });
          subscriber.complete();
        } catch (err) {
          if (cancelled) return;
          // 从 AgentExecutionError 提取真实执行状态
          const execStatus = err instanceof AgentExecutionError ? err.executionStatus : undefined;
          const hasToolResults = (execStatus?.successfulTools.length ?? 0) > 0;
          const phase = execStatus?.phase ?? "unknown";
          const classification = classifyRunError(
            err, abortSource, runId, conversationId, phase, hasToolResults,
          );
          console.error(LOG_PREFIX, `run 失败 [${classification.source}]:`, classification.diagnostics);
          if (classification.source === "user_cancelled") {
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId,
              runId,
            });
            subscriber.complete();
            return;
          }
          const safeErr = new Error(classification.userMessage);
          subscriber.error(safeErr);
        }
      })();

      return () => {
        cancelled = true;
        markAbort("user_cancelled");
      };
    });
  }

  // AbstractAgent 要求实现 run(input)，但我们用 runWithEvents 更直接。
  // 保留 run 作为一个薄封装，供标准 AG-UI 调用路径（暂不用）。
  protected _runOptions?: CyreneRunOptions;
  run(input: RunAgentInput): Observable<BaseEvent> {
    if (!this._runOptions) {
      return new Observable<BaseEvent>((s) => {
        s.error(new Error("CyreneAgent.run 被直接调用，但未设置 _runOptions。请用 runWithEvents。"));
      });
    }
    void input;
    return this.runWithEvents(this._runOptions);
  }
}

/** Abort 来源分类 */
export type AbortSource =
  | "user_cancelled"
  | "call_timeout"
  | "run_timeout"
  | "window_destroyed"
  | "upstream_cleanup";

/** 执行阶段（Abort 诊断用，引用 RunPhase + 旧节点名） */
export type AbortPhase = RunPhase | "decide" | "execute";

export interface AbortDiagnostic {
  source: AbortSource;
  phase: AbortPhase;
  userMessage: string;
  diagnostics: Record<string, unknown>;
}

/** 分类 abort/error 来源，返回用户安全消息和诊断信息 */
export function classifyRunError(
  err: unknown,
  abortSource: AbortSource | undefined,
  runId: string,
  conversationId: string,
  phase: AbortPhase,
  hasToolResults: boolean,
): AbortDiagnostic {
  const diagnostics: Record<string, unknown> = {
    runId,
    conversationId,
    abortSource,
    phase,
    hasToolResults,
    errorName: err instanceof Error ? err.name : undefined,
    errorMessage: err instanceof Error ? err.message : String(err),
  };

  // 图级超时（ensureBudget 抛 E_AGENT_GRAPH_TIMEOUT，不是 AbortError）
  if (err instanceof Error && err.message === "E_AGENT_GRAPH_TIMEOUT") {
    const userMessage = phase === "soul" && hasToolResults
      ? "工具结果已获得，但最终回复生成超时，请重试。"
      : "请求处理超时，请重试。";
    return { source: "run_timeout", phase, userMessage, diagnostics };
  }

  // 图级取消（ensureBudget 抛 E_AGENT_GRAPH_CANCELLED）
  if (err instanceof Error && err.message === "E_AGENT_GRAPH_CANCELLED") {
    if (abortSource === "user_cancelled") {
      return { source: "user_cancelled", phase, userMessage: "", diagnostics };
    }
    return { source: abortSource ?? "upstream_cleanup", phase, userMessage: "操作已中断，请重试。", diagnostics };
  }

  // 判断是否是 AbortError
  const isAbort =
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" && err !== null && "name" in err && (err as { name: string }).name === "AbortError");

  // AgentExecutionError：解包 cause 找真实错误类型（保留 diagnostics 中的 status 和 cause 链）
  if (err instanceof AgentExecutionError) {
    if (err.cause instanceof Error) {
      return classifyRunError(
        err.cause, abortSource, runId, conversationId, phase, hasToolResults,
      );
    }
  }

  // AgentRuntimeError（E_MODEL_REQUEST_FAILED 等）：映射为用户安全消息，避免泄露 HTTP 原始响应
  if (err instanceof AgentRuntimeError) {
    const safeMessages: Record<string, string> = {
      E_MODEL_REQUEST_FAILED: "模型服务暂时不可用，请稍后重试。",
      E_AGENT_NO_PROGRESS: "请求处理遇到问题，请重试。",
      E_AGENT_GRAPH_ITERATION_LIMIT: "请求处理步骤过多，请简化问题后重试。",
    };
    const userMessage = safeMessages[err.code] ?? "请求处理出错，请重试。";
    // 从消息中提取 HTTP 状态码供诊断（不暴露给用户）
    const httpMatch = err.message.match(/HTTP\s+(\d{3})/);
    if (httpMatch) diagnostics.httpStatus = Number(httpMatch[1]);
    diagnostics.errorCode = err.code;
    return {
      source: abortSource ?? "upstream_cleanup",
      phase,
      userMessage,
      diagnostics,
    };
  }

  if (!isAbort) {
    // 未知 plain Error：使用白名单固定安全消息，绝不展示原始 message
    // （message 可能含 HTTP body、request_id、Authorization 等内部信息）
    return {
      source: abortSource ?? "upstream_cleanup",
      phase,
      userMessage: "请求处理失败，请重试。",
      diagnostics,
    };
  }

  // AbortError：使用触发时记录的 abortSource
  const source = abortSource ?? "unknown_abort" as AbortSource;

  if (source === "user_cancelled") {
    return { source, phase, userMessage: "", diagnostics };
  }
  if (source === "call_timeout") {
    const userMessage = phase === "soul" && hasToolResults
      ? "工具结果已获得，但最终回复生成超时，请重试。"
      : "请求处理超时，请重试。";
    return { source, phase, userMessage, diagnostics };
  }
  return { source, phase, userMessage: "操作已中断，请重试。", diagnostics };
}
