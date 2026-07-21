// CyreneAgent —— 把两阶段 FC 循环包进 AG-UI 的 AbstractAgent。
//
// 第一期重构：
// - 不再持有 FC 状态机，调用 runTwoPhaseFcLoop（src/main/orchestrator/two-phase-fc-loop.ts）。
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
import { Observable } from "rxjs";
import { toolRegistry, type ToolDefinition } from "./tool-registry";
import { type ToolCallResult } from "./types";
import { checkPermission, type ToolRiskLevel } from "../permission";
import { getAdapterForConfig, type ChatMessage } from "./vendors";
import { extractLastUserQuery, type ToolContext } from "./tool-context";
import {
  runTwoPhaseFcLoop,
  type TwoPhaseEvent,
  type TwoPhaseFcResult,
} from "./two-phase-fc-loop";
import { getTimeoutSettings } from "../timeout-manager";

export interface AgentLoopSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
}

/** CyreneAgent.run() 需要的输入——桥层构造好后塞进 input.state 或 forwardedProps。 */
export interface CyreneRunOptions {
  settings: AgentLoopSettings;
  /** 原始消息（不含 system）。FC 循环按阶段动态注入。 */
  messages: ChatMessage[];
  conversationId?: string;
  timeoutMs: number;
  /** 可选：本次 run 的工具集合。未传时使用当前所有已启用工具。 */
  tools?: ToolDefinition[];
  /** 明确意图在首轮必须调用的工具。 */
  requiredToolName?: string;
  /** 直发图片被主模型接口拒绝时，懒加载 caption fallback 消息并重试。 */
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  /** 工具阶段使用的 system prompt（仅含工具调度规则 + 自动生成的工具目录）。 */
  toolSystemContent: string;
  toolSystemContentOptimizedForFirstRound?: string;
  /** Soul 阶段使用的基础 system prompt（人设 + 环境/记忆/关系/附件）。 */
  soulSystemBaseContent: string;
  optimizeFirstRound?: boolean;
}

/** FC 循环最终结果（供桥层做副作用用）。 */
export interface CyreneRunResult {
  reply: string;
  toolResults: ToolCallResult[];
  totalUsage?: { input: number; output: number };
  soulPhaseReason?: "no_tool" | "max_rounds" | "timeout" | "tool_error";
}

const LOG_PREFIX = "[CyreneAgent]";

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
): Promise<string> {
  const displayTool = toolRegistry.getById(tc.name);
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.arguments || "{}");
  } catch {
    return "[错误] 工具参数解析失败";
  }

  if (!runnableToolIds.has(tc.name)) {
    return "[错误] 工具不可用: " + tc.name;
  }
  const tool = displayTool;
  if (!tool || !tool.enabled) {
    return "[错误] 工具不可用: " + tc.name;
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
    return "[已拒绝] " + (perm.reason || "权限不足");
  }

  try {
    return await tool.execute(args, tool.needsContext ? ctx : undefined);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return "[工具执行失败] " + errMsg;
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
    const abortController = new AbortController();

    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;

      (async () => {
        try {
          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });

          const adapter = getAdapterForConfig(options.settings);
          const timeoutSettings = getTimeoutSettings();

          const result: TwoPhaseFcResult = await runTwoPhaseFcLoop({
            settings: options.settings,
            adapter,
            messages: options.messages,
            tools: options.tools ?? toolRegistry.getEnabledTools(),
            requiredToolName: options.requiredToolName,
            toolSystemContent: options.toolSystemContent,
            toolSystemContentOptimizedForFirstRound: options.toolSystemContentOptimizedForFirstRound,
            soulSystemBaseContent: options.soulSystemBaseContent,
            timeoutMs: options.timeoutMs,
            perRoundTimeoutMs: timeoutSettings.perRoundTimeout,
            forceSummaryTimeoutMs: timeoutSettings.forceSummaryTimeout,
            imageCaptionFallback: options.imageCaptionFallback,
            executeTool: (tc, runnableToolIds) => executeToolCall(tc, runnableToolIds, {
              userQuery: extractLastUserQuery(options.messages),
              conversationId: options.conversationId ?? "default",
            }),
            onEvent: (event) => {
              if (cancelled) return;
              subscriber.next(toAguiEvent(event));
            },
            signal: abortController.signal,
            optimizeFirstRound: options.optimizeFirstRound,
          });

          this.lastResult = {
            reply: result.reply,
            toolResults: result.toolResults,
            totalUsage: result.totalUsage,
            soulPhaseReason: result.soulPhaseReason,
          };

          if (cancelled) return;
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
          });
          subscriber.complete();
        } catch (err) {
          if (cancelled) return;
          console.error(LOG_PREFIX, "run 失败:", err);
          subscriber.error(err instanceof Error ? err : new Error(String(err)));
        }
      })();

      return () => {
        cancelled = true;
        abortController.abort();
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
