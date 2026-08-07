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
//        - role:tool 保留协议消息；另注入结构化 ToolExecutionContext 供 Soul 核对本轮事实
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
import { loadPromptFile } from "../prompts/prompt-loader";
import { stripLeakedChatTimeContext } from "../chat-time-context";
import { AgentRuntimeError } from "./agent-runtime-error";
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
import { buildSoulExecutionContext, formatSoulExecutionContext } from "./soul-execution-context";
import type { TaskPlanSnapshot } from "./task-plan";
import type { ToolCallResult, ToolExecutionOutcome } from "./types";
import type { ApprovedStyleSampling } from "./vendors/style-sampling";
import { streamChatWithSdk, type SdkStreamRunInput } from "./vendors/sdk-stream/runtime";
import type { UnifiedStreamDelta } from "./vendors/sdk-stream/types";

export interface AgentLoopSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
  reasoning?: import("../../shared/reasoning").ReasoningPreference;
  /** 用户设置的模型上下文窗口（Token）。用于非 code 模式的对话压缩触发阈值。 */
  contextWindowTokens: number;
}

/** FC 循环中性事件。CyreneAgent 把它包成 AG-UI BaseEvent。 */
export type TwoPhaseEvent =
  | { type: "step_started"; stepName: string }
  | { type: "step_finished"; stepName: string }
  | { type: "tool_call_start"; toolCallId: string; toolCallName: string }
  | { type: "tool_call_args"; toolCallId: string; delta: string }
  | { type: "tool_call_result"; toolCallId: string; messageId: string; content: string; status: "succeeded" | "failed" }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "text_message_start"; messageId: string; role: "assistant" }
  | { type: "text_message_content"; messageId: string; delta: string }
  | { type: "text_message_end"; messageId: string }
  | { type: "reasoning_message_start"; messageId: string; role: "reasoning" }
  | { type: "reasoning_message_content"; messageId: string; delta: string }
  | { type: "reasoning_message_end"; messageId: string }
  | { type: "task_plan_update"; snapshot: TaskPlanSnapshot }
  | { type: "compressing_context" };

export type SoulPhaseReason = "no_tool" | "max_rounds" | "timeout" | "tool_error" | "no_progress";

export interface TwoPhaseFcOptions {
  settings: AgentLoopSettings;
  adapter: ChatVendorAdapter;
  /** 原始消息（不含 system）。FC 循环按阶段动态注入 system。 */
  messages: ChatMessage[];
  /** 工具列表（含未启用时调度层负责过滤；这里传已过滤的）。 */
  tools: ToolDefinition[];
  /** 工具阶段使用的 system prompt（仅含工具调度规则 + 自动生成的工具目录）。 */
  toolSystemContent: string;
  /** Soul 阶段使用的基础 system prompt（人设 + 环境/记忆/关系/附件）。
   *  工具结果（role: tool 消息）已在 conversation 中携带，本字段不重复注入。 */
  /** Soul 阶段使用的基础 system prompt（人设 + 环境/记忆/关系/附件）。 */
  soulSystemBaseContent: string;
  /** 只应用到 Soul 阶段最终自然语言回复。 */
  soulSampling?: ApprovedStyleSampling;
  timeoutMs: number;
  maxToolRounds?: number;
  perRoundTimeoutMs?: number;
  maxConsecutiveTimeouts?: number;
  forceSummaryTimeoutMs?: number;
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  /** 工具执行器（封装权限检查 + execute + 异常转 output 字符串）。
   *  由调用方（CyreneAgent）注入。 */
  executeTool: (tc: ToolCall, runnableToolIds: Set<string>) => Promise<string | ToolExecutionOutcome>;
  /** 可选：构建额外的业务摘要；权威执行事实始终由 ToolExecutionContext 注入。 */
  buildSoulToolResultsSummary?: (results: ToolCallResult[]) => string;
  /** 事件回调。 */
  onEvent?: (event: TwoPhaseEvent) => void;
  /** 记录 token 用量的回调（默认走 recordUsage）。 */
  recordUsage?: (input: number, output: number, calls: number) => void;
  /** 用户取消信号。 */
  signal?: AbortSignal;
  /** 测试可注入的模型流；生产默认使用官方 SDK runtime。 */
  streamChat?: (input: SdkStreamRunInput) => Promise<import("./vendors/types").ChatResponse>;
  /** 当前对话模式，用于决定上下文压缩时保留的最近轮数。 */
  mode?: string;
}

export interface TwoPhaseFcResult {
  reply: string;
  toolResults: ToolCallResult[];
  totalUsage?: { input: number; output: number };
  soulPhaseReason: SoulPhaseReason;
}

const LOG_PREFIX = "[TwoPhaseFcLoop]";
const DEFAULT_MAX_TOOL_ROUNDS = 100;
const DEFAULT_PER_ROUND_TIMEOUT_MS = 75_000;
const DEFAULT_MAX_CONSECUTIVE_TIMEOUTS = 2;
const DEFAULT_NO_PROGRESS_ROUNDS = 10;
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

const STREAM_BLOCK_MARKERS = [
  "\uffff",
  "]<]minimax[>[",
  "[系统提示]",
  "[工具调用]",
  "[工具结果]",
  "<tool_call",
  "[tool_call]",
  "<invoke",
];

class SafeSoulTextEmitter {
  private pending = "";
  private emitted = "";
  private opened = false;
  private stopped = false;
  private leadingMetadataResolved = false;

  constructor(
    private readonly onEvent: ((event: TwoPhaseEvent) => void) | undefined,
    private readonly messageId: string,
  ) {}

  push(delta: string): void {
    if (!delta || this.stopped) return;
    this.pending += delta;
    if (!this.resolveLeadingMetadata()) return;
    this.flushSafePrefix(false);
  }

  finish(authoritativeText: string): void {
    if (!this.stopped) {
      this.resolveLeadingMetadata(true);
      this.flushSafePrefix(true);
    }
    if (authoritativeText.startsWith(this.emitted)) {
      this.emit(authoritativeText.slice(this.emitted.length));
    } else if (!this.opened) {
      this.emit(authoritativeText);
    }
    if (this.opened) this.onEvent?.({ type: "text_message_end", messageId: this.messageId });
  }

  abort(): void {
    if (this.opened) this.onEvent?.({ type: "text_message_end", messageId: this.messageId });
  }

  private resolveLeadingMetadata(force = false): boolean {
    if (this.leadingMetadataResolved) return true;
    if (!this.pending.startsWith("[")) {
      this.leadingMetadataResolved = true;
      return true;
    }
    // 时间戳很可能被拆成 `[`、日期、时区、换行四个 chunk。只有确认不是时间戳后才允许首个
    // 方括号透传，避免 Renderer 已经展示系统元数据而终态无法回滚。
    if (!force && (this.pending === "[" || (/^\[\d/.test(this.pending) && !this.pending.includes("\n")))) {
      return false;
    }
    if (/^\[\d{4}-\d{2}-\d{2} /.test(this.pending)) {
      this.pending = stripLeakedChatTimeContext(this.pending);
    }
    this.leadingMetadataResolved = true;
    return true;
  }

  private flushSafePrefix(force: boolean): void {
    const lower = this.pending.toLowerCase();
    let markerIndex = -1;
    for (const marker of STREAM_BLOCK_MARKERS) {
      const index = lower.indexOf(marker.toLowerCase());
      if (index >= 0 && (markerIndex < 0 || index < markerIndex)) markerIndex = index;
    }
    if (markerIndex >= 0) {
      this.emit(this.pending.slice(0, markerIndex));
      this.pending = "";
      this.stopped = true;
      return;
    }
    if (force) {
      this.emit(this.pending);
      this.pending = "";
      return;
    }

    let heldSuffix = 0;
    for (const marker of STREAM_BLOCK_MARKERS) {
      const normalizedMarker = marker.toLowerCase();
      const max = Math.min(lower.length, normalizedMarker.length - 1);
      for (let length = max; length > heldSuffix; length -= 1) {
        if (lower.endsWith(normalizedMarker.slice(0, length))) {
          heldSuffix = length;
          break;
        }
      }
    }
    const safeLength = this.pending.length - heldSuffix;
    if (safeLength > 0) {
      this.emit(this.pending.slice(0, safeLength));
      this.pending = this.pending.slice(safeLength);
    }
  }

  private emit(delta: string): void {
    if (!delta) return;
    if (!this.opened) {
      this.opened = true;
      this.onEvent?.({ type: "text_message_start", messageId: this.messageId, role: "assistant" });
    }
    this.emitted += delta;
    this.onEvent?.({ type: "text_message_content", messageId: this.messageId, delta });
  }
}

interface StreamedToolUiState {
  id?: string;
  name: string;
  arguments: string;
  emittedArgumentLength: number;
  opened: boolean;
  ended: boolean;
}

export class WorkStreamEventBridge {
  private reasoningOpened = false;
  private reasoningEnded = false;
  private readonly reasoningMessageId: string;
  private readonly textEmitter: SafeSoulTextEmitter | undefined;
  private readonly toolStates = new Map<number, StreamedToolUiState>();

  constructor(
    phase: "tool" | "soul",
    private readonly onEvent: ((event: TwoPhaseEvent) => void) | undefined,
    private readonly tools: ReadonlyArray<ToolDefinition>,
    callId: string,
    private readonly streamToolCalls = true,
  ) {
    this.reasoningMessageId = `${callId}-reasoning`;
    this.textEmitter = phase === "soul" ? new SafeSoulTextEmitter(onEvent, `${callId}-text`) : undefined;
  }

  onDelta = (delta: UnifiedStreamDelta): void => {
    switch (delta.type) {
      case "reasoning_delta":
        if (!delta.delta) return;
        if (!this.reasoningOpened) {
          this.reasoningOpened = true;
          this.onEvent?.({ type: "reasoning_message_start", messageId: this.reasoningMessageId, role: "reasoning" });
        }
        this.onEvent?.({ type: "reasoning_message_content", messageId: this.reasoningMessageId, delta: delta.delta });
        return;
      case "text_delta":
        this.textEmitter?.push(delta.delta);
        return;
      case "tool_call_start": {
        if (!this.streamToolCalls) return;
        const state = this.toolState(delta.index);
        if (delta.id) state.id ??= delta.id;
        state.name += delta.nameDelta ?? "";
        return;
      }
      case "tool_call_arguments_delta": {
        if (!this.streamToolCalls) return;
        const state = this.toolState(delta.index);
        if (delta.id) state.id ??= delta.id;
        state.arguments += delta.delta;
        this.openTool(state);
        this.emitPendingArguments(state);
        return;
      }
      case "tool_call_end": {
        if (!this.streamToolCalls) return;
        const state = this.toolState(delta.index);
        if (delta.id) state.id ??= delta.id;
        this.openTool(state);
        this.emitPendingArguments(state);
        this.endTool(state);
        return;
      }
      case "usage":
      case "finish":
      case "refusal":
        return;
    }
  };

  finish(response: import("./vendors/types").ChatResponse, authoritativeText = response.text): void {
    if (!this.reasoningOpened && response.thinking?.trim()) {
      this.onDelta({ type: "reasoning_delta", delta: response.thinking });
    }
    this.endReasoning();

    if (this.streamToolCalls) {
      response.toolCalls.forEach((toolCall, index) => {
        const state = this.toolState(index);
        state.id ??= toolCall.id;
        if (!state.name) state.name = toolCall.name;
        if (!state.arguments) state.arguments = toolCall.arguments;
        this.openTool(state);
        this.emitPendingArguments(state);
        this.endTool(state);
      });
    }
    this.textEmitter?.finish(authoritativeText);
  }

  abort(): void {
    this.endReasoning();
    for (const state of this.toolStates.values()) this.endTool(state);
    this.textEmitter?.abort();
  }

  private toolState(index: number): StreamedToolUiState {
    const existing = this.toolStates.get(index);
    if (existing) return existing;
    const created: StreamedToolUiState = {
      name: "",
      arguments: "",
      emittedArgumentLength: 0,
      opened: false,
      ended: false,
    };
    this.toolStates.set(index, created);
    return created;
  }

  private openTool(state: StreamedToolUiState): void {
    if (state.opened || !state.id || !state.name) return;
    state.opened = true;
    const displayTool = this.tools.find((tool) => tool.id === state.name);
    this.onEvent?.({
      type: "tool_call_start",
      toolCallId: state.id,
      toolCallName: displayTool?.name ?? state.name,
    });
  }

  private emitPendingArguments(state: StreamedToolUiState): void {
    if (!state.opened || !state.id || state.emittedArgumentLength >= state.arguments.length) return;
    const delta = state.arguments.slice(state.emittedArgumentLength);
    state.emittedArgumentLength = state.arguments.length;
    this.onEvent?.({ type: "tool_call_args", toolCallId: state.id, delta });
  }

  private endTool(state: StreamedToolUiState): void {
    if (!state.opened || state.ended || !state.id) return;
    state.ended = true;
    this.onEvent?.({ type: "tool_call_end", toolCallId: state.id });
  }

  private endReasoning(): void {
    if (!this.reasoningOpened || this.reasoningEnded) return;
    this.reasoningEnded = true;
    this.onEvent?.({ type: "reasoning_message_end", messageId: this.reasoningMessageId });
  }
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

const SOUL_NO_TOOL_DIRECTIVE: string = loadPromptFile("soul_no_tool_directive.md");

function stripTextualToolProtocol(text: string): string {
  // MiniMax 内部协议使用 \uffff 作为分隔符；合法回复中不应出现
  const uffffIndex = text.indexOf("\uffff");
  if (uffffIndex >= 0) text = text.slice(0, uffffIndex);
  // 中文标签协议块：[系统提示]/[工具调用]/[工具结果]
  const labelIndex = text.search(/\[系统提示\]|\[工具调用\]|\[工具结果\]/);
  if (labelIndex >= 0) text = text.slice(0, labelIndex);
  return text
    .split("]<]minimax[>[").join("")
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .trim();
}

function buildTextualToolProtocolFallback(toolResults: ToolCallResult[]): string {
  return "刚才的操作没有生成正常回复，请再试一次。";
}

function buildToolSpecs(tools: ReadonlyArray<ToolDefinition>): Array<{ name: string; description: string; parameters: object }> {
  return tools
    .filter((t) => t.enabled && !t.deprecated && t.effectKind !== "unknown")
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
  const streamChat = options.streamChat ?? streamChatWithSdk;

  const toolSpecs = buildToolSpecs(tools);
  const runnableToolIds = new Set(tools.filter((t) => t.enabled && !t.deprecated && t.effectKind !== "unknown").map((t) => t.id));
  const allToolResults: ToolCallResult[] = [];

  console.log(LOG_PREFIX, `可用工具: ${toolSpecs.map((t) => t.name).join(", ") || "(无)"}`);
  console.log(LOG_PREFIX, "原始消息数:", messages.length, "最后一角色:", messages[messages.length - 1]?.role);

  // conversation 不含 system，FC 循环按阶段动态注入
  let conversation: ChatMessage[] = messages.map((m) => ({ ...m }));
  const startTime = Date.now();
  let accInput = 0;
  let accOutput = 0;
  let consecutiveTimeouts = 0;
  let consecutiveNoProgressRounds = 0;
  let usedImageCaptionFallback = false;
  let isFirstRound = true;
  let loopExitReason: SoulPhaseReason = "max_rounds";

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
      loopExitReason = "timeout";
      break;
    }
    const realIsFirstRound = isFirstRound;

    onEvent?.({ type: "step_started", stepName: `tool-round-${round + 1}` });
    console.log(LOG_PREFIX, "第 " + (round + 1) + " 轮 LLM 调用（TOOL_PHASE）...");

    const systemContent = toolSystemContent;

    let req: ChatRequest = {
      model: options.settings.model,
      messages: withSystem(conversation, systemContent),
      stream: true,
    };
    if (toolSpecs.length > 0) req = { ...req, tools: toolSpecs };
    if (adapter.applyCacheHints) req = adapter.applyCacheHints(req, options.settings);

    const bridge = new WorkStreamEventBridge("tool", onEvent, tools, `tool-round-${round + 1}-${Date.now()}`);
    let chat: import("./vendors/types").ChatResponse;
    try {
      chat = await streamChat({
        adapter,
        request: req,
        config: options.settings,
        timeoutMs: perRoundTimeoutMs,
        signal,
        onDelta: bridge.onDelta,
        onDiagnostic: (diagnostic) => console.warn(LOG_PREFIX, "流终态核对告警:", diagnostic),
      });
      bridge.finish(chat);
    } catch (err) {
      bridge.abort();
      if (signal?.aborted) throw err;
      if (err instanceof AgentRuntimeError && err.code === "E_MODEL_REQUEST_TIMEOUT") {
        consecutiveTimeouts++;
        console.warn(LOG_PREFIX, "第 " + (round + 1) + " 轮 LLM 请求超时，连续第 " + consecutiveTimeouts + " 次");
        onEvent?.({ type: "step_finished", stepName: `tool-round-${round + 1}` });
        if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
          console.warn(LOG_PREFIX, "连续 " + maxConsecutiveTimeouts + " 次超时，触发 SOUL_PHASE");
          loopExitReason = "timeout";
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

    // 请求成功，重置连续超时和无效轮次计数
    consecutiveTimeouts = 0;
    isFirstRound = false;

    // 情况 1：模型要调工具 → 把 assistant 消息加入 conversation（带 tool_calls）
    if (chat.toolCalls.length > 0) {
      conversation.push(chat.assistantMessage);
      console.log(LOG_PREFIX, "模型请求调用 " + chat.toolCalls.length + " 个工具:", chat.toolCalls.map((tc) => tc.name).join(", "));

      const execResults: ToolExecutionResult[] = [];
      for (const tc of chat.toolCalls) {
        const toolCallId = tc.id;

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          console.warn(LOG_PREFIX, "工具参数 JSON 解析失败:", tc.arguments?.slice(0, 100));
        }

        console.log(LOG_PREFIX, "执行工具:", tc.name, JSON.stringify(args).slice(0, 200));

        let outcome: ToolExecutionOutcome;
        try {
          const executed = await executeTool(tc, runnableToolIds);
          outcome = typeof executed === "string"
            ? { output: executed, status: "succeeded" }
            : executed;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          outcome = { output: errMsg, status: "failed", errorCode: "E_TOOL_EXECUTION_FAILED" };
          console.error(LOG_PREFIX, "工具执行失败 [" + tc.name + "]:", errMsg);
        }
        const output = outcome.output;
        console.log(
          `[ToolExecution/Trace] tool=${tc.name} status=${outcome.status}`
          + (outcome.errorCode ? ` errorCode=${outcome.errorCode}` : ""),
        );
        const resultLog = tc.name.startsWith("music_")
          ? truncateToolResult(output).slice(0, 500)
          : `length=${output.length}`;
        console.log(LOG_PREFIX, "工具结果:", tc.name, resultLog);

        allToolResults.push({
          toolId: tc.name,
          args,
          output,
          status: outcome.status,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        });
        execResults.push({ toolCall: tc, output: truncateToolResult(output) });

        onEvent?.({
          type: "tool_call_result",
          toolCallId,
          messageId: `${toolCallId}-result`,
          content: output,
          status: outcome.status,
        });
      }

      conversation = adapter.appendToolResults(conversation, execResults);
      conversation = await compressConversation({
        messages: conversation,
        adapter,
        settings: options.settings,
        systemContent: options.toolSystemContent,
        mode: options.mode,
        onEvent,
        signal: options.signal,
      });

      onEvent?.({ type: "step_finished", stepName: `tool-round-${round + 1}` });

      // 无进展检测：所有工具输出为空/短/报错 → 无进展
      const allEmpty = execResults.every(r =>
        !r.output || r.output.trim().length < 5
      );
      if (allEmpty) {
        consecutiveNoProgressRounds++;
        console.warn(LOG_PREFIX, `第 ${round + 1} 轮无进展（连续 ${consecutiveNoProgressRounds}/${DEFAULT_NO_PROGRESS_ROUNDS} 轮）`);
        if (consecutiveNoProgressRounds >= DEFAULT_NO_PROGRESS_ROUNDS) {
          console.warn(LOG_PREFIX, `连续 ${DEFAULT_NO_PROGRESS_ROUNDS} 轮无进展，切 SOUL_PHASE`);
          loopExitReason = "no_progress";
          break;
        }
      } else {
        consecutiveNoProgressRounds = 0;
      }

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
      soulSampling: options.soulSampling,
      buildSoulToolResultsSummary,
      allToolResults,
      tools,
      accInput,
      accOutput,
      reason: "no_tool",
      forceSummaryTimeoutMs,
      signal,
      onEvent,
      recordUsageFn,
      streamChat,
    });
  }

  // 达到 maxToolRounds，触发 SOUL_PHASE 强制总结
  if (signal?.aborted) {
    throw new Error("run cancelled");
  }
  if (loopExitReason === "max_rounds") {
    console.warn(LOG_PREFIX, "达到最大轮数 " + maxToolRounds + "，触发 SOUL_PHASE 强制总结");
  }
  return await runSoulPhase({
    adapter,
    cfg: options.settings,
    conversation,
    soulSystemBaseContent,
    soulSampling: options.soulSampling,
    buildSoulToolResultsSummary,
    allToolResults,
    tools,
    accInput,
    accOutput,
    reason: loopExitReason,
    forceSummaryTimeoutMs,
    signal,
    onEvent,
    recordUsageFn,
    streamChat,
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
  soulSampling: ApprovedStyleSampling | undefined;
  buildSoulToolResultsSummary: (results: ToolCallResult[]) => string;
  allToolResults: ToolCallResult[];
  tools: ToolDefinition[];
  accInput: number;
  accOutput: number;
  reason: SoulPhaseReason;
  forceSummaryTimeoutMs: number;
  signal: AbortSignal | undefined;
  onEvent: ((e: TwoPhaseEvent) => void) | undefined;
  recordUsageFn: (input: number, output: number, calls: number) => void;
  streamChat: (input: SdkStreamRunInput) => Promise<import("./vendors/types").ChatResponse>;
}): Promise<TwoPhaseFcResult> {
  const {
    adapter,
    cfg,
    conversation,
    soulSystemBaseContent,
    soulSampling,
    buildSoulToolResultsSummary,
    allToolResults,
    tools,
    accInput,
    accOutput,
    reason,
    forceSummaryTimeoutMs,
    signal,
    onEvent,
    recordUsageFn,
    streamChat,
  } = args;

  onEvent?.({ type: "step_started", stepName: `soul-phase-${reason}` });
  console.log(LOG_PREFIX, "进入 SOUL_PHASE, reason=" + reason);

  // Soul 接收清洗后的投影上下文，不再接收原始 [TOOL_EXECUTION_CONTEXT]。
  const soulResultsSummary = buildSoulToolResultsSummary(allToolResults);
  const soulExecutionContext = formatSoulExecutionContext(buildSoulExecutionContext(allToolResults, tools));
  const finalSystemContent = [soulSystemBaseContent, soulResultsSummary, SOUL_NO_TOOL_DIRECTIVE, soulExecutionContext]
    .filter(Boolean)
    .join("\n\n");

  // Soul 请求**不带 tools** 字段
  let req: ChatRequest = {
    model: cfg.model,
    messages: withSystem(conversation, finalSystemContent),
    stream: true,
    ...(soulSampling ?? {}),
  };
  if (adapter.applyCacheHints) req = adapter.applyCacheHints(req, cfg);

  const bridge = new WorkStreamEventBridge("soul", onEvent, tools, `soul-${reason}-${Date.now()}`);

  try {
    const chat = await streamChat({
      adapter,
      request: req,
      config: cfg,
      timeoutMs: forceSummaryTimeoutMs,
      signal,
      onDelta: bridge.onDelta,
      onDiagnostic: (diagnostic) => console.warn(LOG_PREFIX, "流终态核对告警:", diagnostic),
    });
    const withoutProtocol = stripTextualToolProtocol(chat.text);
    const reply = stripLeakedChatTimeContext(
      withoutProtocol || buildTextualToolProtocolFallback(allToolResults),
    );
    bridge.finish(chat, reply);
    if (chat.usage) {
      const finalInput = accInput + chat.usage.input;
      const finalOutput = accOutput + chat.usage.output;
      recordUsageFn(chat.usage.input, chat.usage.output, 1);

      onEvent?.({ type: "step_finished", stepName: `soul-phase-${reason}` });

      return {
        reply,
        toolResults: allToolResults,
        totalUsage: { input: finalInput, output: finalOutput },
        soulPhaseReason: reason,
      };
    }

    onEvent?.({ type: "step_finished", stepName: `soul-phase-${reason}` });

    return {
      reply,
      toolResults: allToolResults,
      totalUsage: accInput > 0 || accOutput > 0 ? { input: accInput, output: accOutput } : undefined,
      soulPhaseReason: reason,
    };
  } catch (err) {
    bridge.abort();
    if (signal?.aborted) throw err;
    // 兜底再失败也别让整个 run 崩掉。用已收集的工具结果拼一个"任务中断"文案降级返回。
    const errReason = err instanceof AgentRuntimeError && err.code === "E_MODEL_REQUEST_TIMEOUT"
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
    };
  }
}
