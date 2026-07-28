import { stripLeakedChatTimeContext } from "../chat-time-context";
import { recordUsage } from "../token-usage-store";
import { AgentRuntimeError } from "./agent-runtime-error";
import type {
  AgentLoopSettings,
  TwoPhaseEvent,
  TwoPhaseFcResult,
} from "./two-phase-fc-loop";
import type {
  ChatMessage,
  ChatRequest,
  ChatVendorAdapter,
} from "./vendors/types";
import type { ApprovedStyleSampling } from "./vendors/style-sampling";
import { getTimeoutSettings } from "../timeout-manager";

export interface ChatLoopOptions {
  settings: AgentLoopSettings;
  adapter: ChatVendorAdapter;
  messages: ChatMessage[];
  soulSystemBaseContent: string;
  soulSampling?: ApprovedStyleSampling;
  timeoutMs: number;
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  onEvent?: (event: TwoPhaseEvent) => void;
  recordUsage?: (input: number, output: number, calls: number) => void;
  signal?: AbortSignal;
}

function emitText(onEvent: ChatLoopOptions["onEvent"], text: string): void {
  const messageId = `msg-${Date.now()}`;
  onEvent?.({ type: "text_message_start", messageId, role: "assistant" });
  for (const char of Array.from(text)) {
    onEvent?.({ type: "text_message_content", messageId, delta: char });
  }
  onEvent?.({ type: "text_message_end", messageId });
}

function stripToolProtocol(text: string): string {
  return text
    .split("]<]minimax[>[").join("")
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .trim();
}

function withSoulSystem(messages: ChatMessage[], system: string): ChatMessage[] {
  if (messages[0]?.role === "system") return messages;
  return [{ role: "system", content: system }, ...messages];
}

export async function runChatLoop(options: ChatLoopOptions): Promise<TwoPhaseFcResult> {
  const startedAt = Date.now();
  const usageRecorder = options.recordUsage ?? ((input, output, calls) => recordUsage(input, output, calls));
  let usedImageCaptionFallback = false;

  const timeout = getTimeoutSettings().chatRequestTimeout;

  const remainingBudget = (): number => {
    if (options.signal?.aborted) throw new Error("E_SOUL_ONLY_CANCELLED");
    const remaining = options.timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("E_SOUL_ONLY_TIMEOUT");
    return Math.max(1, Math.min(timeout, remaining));
  };

  const invoke = async (messages: ChatMessage[]) => {
    const request: ChatRequest = {
      model: options.settings.model,
      messages: withSoulSystem(messages, options.soulSystemBaseContent),
      stream: false,
      ...(options.soulSampling ?? {}),
    };
    const effectiveRequest = options.adapter.applyCacheHints?.(request, options.settings) ?? request;
    const http = options.adapter.buildRequest(effectiveRequest, options.settings);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, remainingBudget());
    try {
      const response = await fetch(http.url, {
        method: "POST",
        headers: http.headers,
        body: http.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AgentRuntimeError(
          "E_MODEL_REQUEST_FAILED",
          `模型请求失败：HTTP ${response.status}${body ? ` - ${body.slice(0, 200)}` : ""}`,
        );
      }
      return options.adapter.parseResponse(await response.json());
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };

  options.onEvent?.({ type: "step_started", stepName: "chat" });
  try {
    let response;
    try {
      response = await invoke(options.messages);
    } catch (error) {
      if (options.signal?.aborted || !options.imageCaptionFallback || usedImageCaptionFallback) {
        throw error;
      }
      usedImageCaptionFallback = true;
      response = await invoke(await options.imageCaptionFallback());
    }

    if (response.usage) {
      usageRecorder(response.usage.input, response.usage.output, 1);
    }
    const reply = stripLeakedChatTimeContext(stripToolProtocol(response.text))
      || "刚才没有生成正常回复，请再试一次。";
    emitText(options.onEvent, reply);
    return {
      reply,
      toolResults: [],
      totalUsage: response.usage,
      soulPhaseReason: "no_tool",
    };
  } finally {
    options.onEvent?.({ type: "step_finished", stepName: "chat" });
  }
}
