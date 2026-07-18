// two-phase-fc-loop —— 两阶段 FC 循环的核心状态机。
//
// 第一期（system 分阶段）：
//   TOOL_PHASE（每轮）
//     1. req.messages = [{ role: "system", content: toolSystemContent }, ...conversation]
//     2. req.tools = tools
//     3. 发送 → 解析
//     4. 若 chat.toolCalls.length > 0：
//        - conversation.push(chat.assistantMessage) （带 tool_calls 的 assistant 必须保留）
//        - 遍历执行工具 → appendToolResults
//        - 继续 TOOL_PHASE
//     5. 否则（无 tool_calls）：
//        - 工具阶段自由文本 **不写入 conversation**，不发给用户
//        - 切 SOUL_PHASE
//
//   边界：
//     - 达到 maxToolRounds → SOUL_PHASE（强制总结）
//     - 连续 maxConsecutiveTimeouts 次超时 → SOUL_PHASE（异常兜底）
//     - 工具执行异常且无法继续 → SOUL_PHASE
//
//   SOUL_PHASE
//     1. 构造 soulMessages：[{ role: "system", content: soulSystemBaseContent + 动态 soulToolResultsSummary }, ...conversation]
//        - 工具结果（role: tool 消息）已在 conversation 中携带，本字段不重复注入
//        - conversation 不含工具阶段自由文本
//     2. req.messages = soulMessages
//     3. req.tools 不携带（避免再次进入工具决策）
//     4. 发送 → 解析 → emit TEXT_MESSAGE 流
//     5. 返回结果
//
// 约束：
//   - 这是第一期唯一的 FC 状态机实现。
//   - CyreneAgent / Scheduler / Legacy 都应调用它（第一期先迁移 CyreneAgent，其他后续）。
//   - 不再持有 fcMessages 注入 system，原始 messages 由调用方传进来（不含 system）。
//   - 不输出任何 AG-UI 事件，只输出 TwoPhaseEvent（中性事件），由 CyreneAgent 包装成 AG-UI。

import { recordUsage } from "../token-usage-store";
import { stripLeakedChatTimeContext } from "../chat-time-context";
import { compressConversation } from "./context-manager";
import { truncateToolResult } from "./context-manager";
import type {
  ChatMessage,
  ChatRequest,
  ChatVendorAdapter,
  ToolCall,
  ToolExecutionResult,
} from "./vendors/types";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult } from "./types";
import type { LlmInteraction } from "./types";

export interface AgentLoopSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
}

/** FC 循环中性事件。CyreneAgent 把它包成 AG-UI BaseEvent。 */
export type TwoPhaseEvent =
  | { type: "step_started"; stepName: string }
  | { type: "step_finished"; stepName: string }
  | { type: "tool_call_start"; toolCallId: string; toolCallName: string }
  | { type: "tool_call_result"; toolCallId: string; messageId: string; content: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "text_message_start"; messageId: string; role: "assistant" }
  | { type: "text_message_content"; messageId: string; delta: string }
  | { type: "text_message_end"; messageId: string };

export type SoulPhaseReason = "no_tool" | "max_rounds" | "timeout" | "tool_error";

export interface TwoPhaseFcOptions {
  settings: AgentLoopSettings;
  adapter: ChatVendorAdapter;
  /** 原始消息（不含 system）。FC 循环按阶段动态注入 system。 */
  messages: ChatMessage[];
  /** 工具列表（含未启用时调度层负责过滤；这里传已过滤的）。 */
  tools: ToolDefinition[];
  /** 明确外部操作意图需要首轮强制选择的工具。 */
  requiredToolName?: string;
  /** 工具阶段使用的 system prompt（仅含工具调度规则 + 自动生成的工具目录）。 */
  toolSystemContent: string;
  /** Soul 阶段使用的基础 system prompt（人设 + 环境/记忆/关系/附件）。
   *  工具结果（role: tool 消息）已在 conversation 中携带，本字段不重复注入。 */
  soulSystemBaseContent: string;
  timeoutMs: number;
  maxToolRounds?: number;
  perRoundTimeoutMs?: number;
  maxConsecutiveTimeouts?: number;
  forceSummaryTimeoutMs?: number;
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  /** 工具执行器（封装权限检查 + execute + 异常转 output 字符串）。
   *  由调用方（CyreneAgent）注入。 */
  executeTool: (tc: ToolCall, runnableToolIds: Set<string>) => Promise<string>;
  /** 可选：构建 Soul 阶段动态追加的工具结果摘要。
   *  第一期默认实现是空字符串（依赖 conversation 里的 role: tool 消息）。 */
  buildSoulToolResultsSummary?: (results: ToolCallResult[]) => string;
  /** 事件回调。 */
  onEvent?: (event: TwoPhaseEvent) => void;
  /** 记录 token 用量的回调（默认走 recordUsage）。 */
  recordUsage?: (input: number, output: number, calls: number) => void;
  /** 用户取消信号。 */
  signal?: AbortSignal;
}

export interface TwoPhaseFcResult {
  reply: string;
  toolResults: ToolCallResult[];
  totalUsage?: { input: number; output: number };
  soulPhaseReason: SoulPhaseReason;
  /** 所有轮次的 LLM 交互记录（调试复盘用）。 */
  llmInteractions: LlmInteraction[];
}

const LOG_PREFIX = "[TwoPhaseFcLoop]";
const DEFAULT_MAX_TOOL_ROUNDS = 20;
const DEFAULT_PER_ROUND_TIMEOUT_MS = 75_000;
const DEFAULT_MAX_CONSECUTIVE_TIMEOUTS = 2;
const DEFAULT_FORCE_SUMMARY_TIMEOUT_MS = 90_000;


function sliceToDeltas(text: string, chunkSize = 1): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += chunkSize) {
    out.push(chars.slice(i, i + chunkSize).join(""));
  }
  return out.length > 0 ? out : [text];
}

function emitTextMessage(
  onEvent: ((e: TwoPhaseEvent) => void) | undefined,
  messageId: string,
  text: string,
): void {
  const send = onEvent ?? (() => {});
  send({ type: "text_message_start", messageId, role: "assistant" });
  for (const delta of sliceToDeltas(text)) {
    send({ type: "text_message_content", messageId, delta });
  }
  send({ type: "text_message_end", messageId });
}

function buildFallbackReply(toolResults: ToolCallResult[], reason: string): string {
  const lines: string[] = [
    "抱歉，任务执行到一半被中断了。",
    "",
    "中断原因：" + reason,
  ];
  if (toolResults.length > 0) {
    lines.push("", "以下是中断前已经完成的步骤：");
    for (const r of toolResults) {
      const preview = r.output.length > 200 ? r.output.slice(0, 200) + "…" : r.output;
      lines.push("- 「" + r.toolId + "」：" + preview);
    }
  } else {
    lines.push("", "（暂无已完成的步骤信息）");
  }
  return lines.join("\n");
}

function buildToolSpecs(tools: ReadonlyArray<ToolDefinition>): Array<{ name: string; description: string; parameters: object }> {
  return tools
    .filter((t) => t.enabled)
    .map((t) => ({
      name: t.id,
      description: t.description,
      parameters: {
        type: "object" as const,
        properties: t.inputSchema.properties,
        ...(t.inputSchema.required ? { required: t.inputSchema.required } : {}),
      },
    }));
}

/**
 * 在 conversation 前注入 system message。
 */
function withSystem(conv: ChatMessage[], systemContent: string): ChatMessage[] {
  return [{ role: "system", content: systemContent }, ...conv];
}

/**
 * 执行一轮 LLM 调用，返回解析后的 ChatResponse。处理 abort / 超时 / HTTP 错误。
 */
async function callOnce(
  adapter: ChatVendorAdapter,
  req: ChatRequest,
  cfg: AgentLoopSettings,
  timeoutMs: number,
): Promise<{ response: Response; abort: () => void }> {
  const http = adapter.buildRequest(req, cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    });
    clearTimeout(timer);
    return { response, abort: () => controller.abort() };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * 把 ChatVendorAdapter + VendorConfig 包成可调用的 fetch helper。
 */
async function callAdapter(
  adapter: ChatVendorAdapter,
  req: ChatRequest,
  cfg: AgentLoopSettings,
  perRoundTimeoutMs: number,
): Promise<unknown> {
  const http = adapter.buildRequest(req, cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), perRoundTimeoutMs);
  try {
    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error("模型请求失败：HTTP " + response.status + (errorText ? " — " + errorText.slice(0, 200) : ""));
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 主入口：两阶段 FC 循环。
 */
export async function runTwoPhaseFcLoop(options: TwoPhaseFcOptions): Promise<TwoPhaseFcResult> {
  const {
    adapter,
    messages,
    tools,
    toolSystemContent,
    soulSystemBaseContent,
    timeoutMs,
    imageCaptionFallback,
    executeTool,
    onEvent,
    signal,
  } = options;

  const maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const perRoundTimeoutMs = options.perRoundTimeoutMs ?? DEFAULT_PER_ROUND_TIMEOUT_MS;
  const maxConsecutiveTimeouts = options.maxConsecutiveTimeouts ?? DEFAULT_MAX_CONSECUTIVE_TIMEOUTS;
  const forceSummaryTimeoutMs = options.forceSummaryTimeoutMs ?? DEFAULT_FORCE_SUMMARY_TIMEOUT_MS;
  const buildSoulToolResultsSummary = options.buildSoulToolResultsSummary ?? (() => "");
  const recordUsageFn = options.recordUsage ?? ((input, output, calls) => recordUsage(input, output, calls));

  const toolSpecs = buildToolSpecs(tools);
  const runnableToolIds = new Set(tools.filter((t) => t.enabled).map((t) => t.id));
  const allToolResults: ToolCallResult[] = [];
  const llmInteractions: LlmInteraction[] = [];

  console.log(LOG_PREFIX, `可用工具: ${toolSpecs.map((t) => t.name).join(", ") || "(无)"}`);
  console.log(LOG_PREFIX, "原始消息数:", messages.length, "最后一角色:", messages[messages.length - 1]?.role);

  // conversation 不含 system，FC 循环按阶段动态注入
  let conversation: ChatMessage[] = messages.map((m) => ({ ...m }));
  const startTime = Date.now();
  let accInput = 0;
  let accOutput = 0;
  let consecutiveTimeouts = 0;
  let usedImageCaptionFallback = false;

  const switchToImageCaptionFallback = async (reason: string): Promise<boolean> => {
    if (usedImageCaptionFallback || !imageCaptionFallback) return false;
    usedImageCaptionFallback = true;
    console.warn(LOG_PREFIX, "图片直发失败，回退 caption 后重试:", reason);
    conversation = await imageCaptionFallback();
    return true;
  };

  // ── TOOL_PHASE 主循环 ──
  for (let round = 0; round < maxToolRounds; round++) {
    if (signal?.aborted) {
      throw new Error("run cancelled");
    }
    if (Date.now() - startTime > timeoutMs) {
      console.warn(LOG_PREFIX, "Function Calling 超时，在第 " + (round + 1) + " 轮退出");
      break;
    }

    onEvent?.({ type: "step_started", stepName: `tool-round-${round + 1}` });
    console.log(LOG_PREFIX, "第 " + (round + 1) + " 轮 LLM 调用（TOOL_PHASE）...");

    let req: ChatRequest = {
      model: options.settings.model,
      messages: withSystem(conversation, toolSystemContent),
      stream: false,
    };
    if (toolSpecs.length > 0) req = { ...req, tools: toolSpecs };
    if (round === 0 && options.requiredToolName && runnableToolIds.has(options.requiredToolName)) {
      req = { ...req, toolChoice: { name: options.requiredToolName } };
    }
    if (adapter.applyCacheHints) req = adapter.applyCacheHints(req, options.settings);

    let data: unknown;
    try {
      data = await callAdapter(adapter, req, options.settings, perRoundTimeoutMs);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        consecutiveTimeouts++;
        console.warn(LOG_PREFIX, "第 " + (round + 1) + " 轮 LLM 请求超时，连续第 " + consecutiveTimeouts + " 次");
        onEvent?.({ type: "step_finished", stepName: `tool-round-${round + 1}` });
        if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
          console.warn(LOG_PREFIX, "连续 " + maxConsecutiveTimeouts + " 次超时，触发 SOUL_PHASE");
          break;
        }
        continue;
      }
      if (await switchToImageCaptionFallback(err instanceof Error ? err.message : String(err))) {
        onEvent?.({ type: "step_finished", stepName: `tool-round-${round + 1}` });
        continue;
      }
      throw err;
    }

    const chat = adapter.parseResponse(data);
    if (chat.usage) {
      accInput += chat.usage.input;
      accOutput += chat.usage.output;
      recordUsageFn(chat.usage.input, chat.usage.output, 1);
    }

    console.log(
      LOG_PREFIX,
      "第 " + (round + 1) + " 轮完成 finish=" + chat.finishReason +
      " toolCalls=" + chat.toolCalls.length + " 耗时=" + (Date.now() - startTime) + "ms",
    );

    // 请求成功，重置连续超时计数
    consecutiveTimeouts = 0;

    // 记录本轮 LLM 交互（调试复盘用）
    llmInteractions.push({
      phase: `tool-round-${round + 1}`,
      request: {
        model: req.model,
        messageCount: req.messages.length,
        toolCount: (req.tools ?? []).length,
        systemPreview: String(req.messages[0]?.content ?? "").slice(0, 500),
      },
      response: {
        finishReason: chat.finishReason,
        toolCallCount: chat.toolCalls.length,
        textPreview: (chat.text ?? "").slice(0, 500),
      },
    });

    // 情况 1：模型要调工具 → 把 assistant 消息加入 conversation（带 tool_calls）
    if (chat.toolCalls.length > 0) {
      conversation.push(chat.assistantMessage);
      console.log(LOG_PREFIX, "模型请求调用 " + chat.toolCalls.length + " 个工具:", chat.toolCalls.map((tc) => tc.name).join(", "));

      const execResults: ToolExecutionResult[] = [];
      for (const tc of chat.toolCalls) {
        const toolCallId = tc.id || `${tc.name}-${Date.now()}`;
        const displayTool = tools.find((t) => t.id === tc.name);

        onEvent?.({
          type: "tool_call_start",
          toolCallId,
          toolCallName: displayTool?.name ?? tc.name,
        });

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          console.warn(LOG_PREFIX, "工具参数 JSON 解析失败:", tc.arguments?.slice(0, 100));
        }

        console.log(LOG_PREFIX, "执行工具:", tc.name, JSON.stringify(args).slice(0, 200));

        let output: string;
        try {
          output = await executeTool(tc, runnableToolIds);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          output = "[工具执行失败] " + errMsg;
          console.error(LOG_PREFIX, "工具执行失败 [" + tc.name + "]:", errMsg);
        }

        allToolResults.push({ toolId: tc.name, args, output });
        execResults.push({ toolCall: tc, output: truncateToolResult(output) });

        onEvent?.({
          type: "tool_call_result",
          toolCallId,
          messageId: `${toolCallId}-result`,
          content: output,
        });
        onEvent?.({ type: "tool_call_end", toolCallId });
      }

      conversation = adapter.appendToolResults(conversation, execResults);
      conversation = compressConversation(conversation);

      onEvent?.({ type: "step_finished", stepName: `tool-round-${round + 1}` });
      continue;
    }

    // 情况 2：模型没有调工具 → 切 SOUL_PHASE
    // 关键：工具阶段的 chat.text **不写入 conversation**，不发给用户。
    onEvent?.({ type: "step_finished", stepName: `tool-round-${round + 1}` });
    return await runSoulPhase({
      adapter,
      cfg: options.settings,
      conversation,
      soulSystemBaseContent,
      buildSoulToolResultsSummary,
      allToolResults,
      accInput,
      accOutput,
      reason: "no_tool",
      forceSummaryTimeoutMs,
      signal,
      onEvent,
      recordUsageFn,
      llmInteractions,
    });
  }

  // 达到 maxToolRounds，触发 SOUL_PHASE 强制总结
  if (signal?.aborted) {
    throw new Error("run cancelled");
  }
  console.warn(LOG_PREFIX, "达到最大轮数 " + maxToolRounds + "，触发 SOUL_PHASE 强制总结");
  return await runSoulPhase({
    adapter,
    cfg: options.settings,
    conversation,
    soulSystemBaseContent,
    buildSoulToolResultsSummary,
    allToolResults,
    accInput,
    accOutput,
    reason: "max_rounds",
    forceSummaryTimeoutMs,
    signal,
    onEvent,
    recordUsageFn,
    llmInteractions,
  });
}

/**
 * SOUL_PHASE：构造最终 soul 请求，发出 text message，返回结果。
 */
async function runSoulPhase(args: {
  adapter: ChatVendorAdapter;
  cfg: AgentLoopSettings;
  conversation: ChatMessage[];
  soulSystemBaseContent: string;
  buildSoulToolResultsSummary: (results: ToolCallResult[]) => string;
  allToolResults: ToolCallResult[];
  accInput: number;
  accOutput: number;
  reason: SoulPhaseReason;
  forceSummaryTimeoutMs: number;
  signal: AbortSignal | undefined;
  onEvent: ((e: TwoPhaseEvent) => void) | undefined;
  recordUsageFn: (input: number, output: number, calls: number) => void;
  llmInteractions: LlmInteraction[];
}): Promise<TwoPhaseFcResult> {
  const {
    adapter,
    cfg,
    conversation,
    soulSystemBaseContent,
    buildSoulToolResultsSummary,
    allToolResults,
    accInput,
    accOutput,
    reason,
    forceSummaryTimeoutMs,
    signal,
    onEvent,
    recordUsageFn,
    llmInteractions,
  } = args;

  onEvent?.({ type: "step_started", stepName: `soul-phase-${reason}` });
  console.log(LOG_PREFIX, "进入 SOUL_PHASE, reason=" + reason);

  // 动态追加 soulToolResultsSummary（在 baseContent 之后），不重复 conversation 已有的 tool 消息
  const soulResultsSummary = buildSoulToolResultsSummary(allToolResults);
  const finalSystemContent = soulResultsSummary
    ? soulSystemBaseContent + "\n\n" + soulResultsSummary
    : soulSystemBaseContent;

  // 注入明确的"停止调工具"指令（参考 Hermes：role=user 比 system prompt 对 LLM 的约束力更强）
  // 条件：本轮至少调用过一次工具时才注入。纯聊天（0次工具调用）无需注入，
  // 否则模型会误以为"系统通知我已达上限"。
  const injectStopHint = allToolResults.length > 0;
  const soulConversation = injectStopHint
    ? [
        ...conversation,
        {
          role: "user" as const,
          content: "已进入最终回复阶段，请基于以上对话直接回复用户，不要再尝试调用任何工具。",
        },
      ]
    : conversation;

  // Soul 请求**不带 tools** 字段
  let req: ChatRequest = {
    model: cfg.model,
    messages: withSystem(soulConversation, finalSystemContent),
    stream: false,
  };
  if (adapter.applyCacheHints) req = adapter.applyCacheHints(req, cfg);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), forceSummaryTimeoutMs);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort());
  }

  try {
    const data = await callAdapter(adapter, req, cfg, forceSummaryTimeoutMs);
    const chat = adapter.parseResponse(data);

    // 记录 SOUL_PHASE 的 LLM 交互（调试复盘用）
    llmInteractions.push({
      phase: `soul-phase-${reason}`,
      request: {
        model: req.model,
        messageCount: req.messages.length,
        toolCount: 0,
        systemPreview: String(req.messages[0]?.content ?? "").slice(0, 500),
      },
      response: {
        finishReason: chat.finishReason,
        toolCallCount: chat.toolCalls.length,
        textPreview: (chat.text ?? "").slice(0, 500),
      },
    });

    const reply = stripLeakedChatTimeContext(chat.text);
    if (chat.usage) {
      const finalInput = accInput + chat.usage.input;
      const finalOutput = accOutput + chat.usage.output;
      recordUsageFn(chat.usage.input, chat.usage.output, 1);

      const textMessageId = `msg-${Date.now()}`;
      emitTextMessage(onEvent, textMessageId, reply);
      onEvent?.({ type: "step_finished", stepName: `soul-phase-${reason}` });

      return {
        reply,
        toolResults: allToolResults,
        totalUsage: { input: finalInput, output: finalOutput },
        soulPhaseReason: reason,
        llmInteractions,
      };
    }

    const textMessageId = `msg-${Date.now()}`;
    emitTextMessage(onEvent, textMessageId, reply);
    onEvent?.({ type: "step_finished", stepName: `soul-phase-${reason}` });

    return {
      reply,
      toolResults: allToolResults,
      totalUsage: accInput > 0 || accOutput > 0 ? { input: accInput, output: accOutput } : undefined,
      soulPhaseReason: reason,
      llmInteractions,
    };
  } catch (err) {
    // 兜底再失败也别让整个 run 崩掉。用已收集的工具结果拼一个"任务中断"文案降级返回。
    const errReason = err instanceof Error && err.name === "AbortError"
      ? "总结请求超时"
      : (err instanceof Error ? err.message : String(err));
    console.error(LOG_PREFIX, "SOUL_PHASE 也失败，降级返回已有结果:", errReason);
    const fallback = buildFallbackReply(allToolResults, errReason);
    const textMessageId = `msg-${Date.now()}`;
    emitTextMessage(onEvent, textMessageId, fallback);
    onEvent?.({ type: "step_finished", stepName: `soul-phase-${reason}` });
    return {
      reply: fallback,
      toolResults: allToolResults,
      totalUsage: accInput > 0 || accOutput > 0 ? { input: accInput, output: accOutput } : undefined,
      soulPhaseReason: reason,
      llmInteractions,
    };
  } finally {
    clearTimeout(timer);
  }
}
