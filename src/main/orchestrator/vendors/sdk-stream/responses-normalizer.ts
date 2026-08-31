import { ProviderProtocolError, type UnifiedStreamDelta } from "./types";

// ── OpenAI Responses API 流式事件 → UnifiedStreamDelta ──
// 事件映射清单（docs/responses-transport-construction-plan.md「responses-normalizer」小节）：
//   response.output_text.delta              → text_delta
//   response.output_text.done               → 忽略（全量快照，delta 已流过）
//   response.reasoning_summary_text.delta   → reasoning_delta
//   response.reasoning_text.delta           → reasoning_delta
//   response.refusal.delta / done           → refusal
//   response.output_item.added(fn_call)     → tool_call_start（call_id/name）
//   response.function_call_arguments.delta  → tool_call_arguments_delta
//   response.function_call_arguments.done   → tool_call_end
//   response.output_item.done(fn_call)      → tool_call_end 兜底（done 阶段 item 才完整）
//   response.completed                      → usage + finish
//   response.incomplete                     → usage + finish（max_output_tokens → length）
//   response.failed / error                 → 抛 ProviderProtocolError（runtime catch 统一处理）
// 未列出的事件静默跳过（对齐 openai-normalizer 防御式写法）。
// 注：completed/incomplete 的 response 本体由 runtime 直接捕获存 finalResponse
// （rawAssistant 补挂的 canonical source），不经 normalizer。

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function indexField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function usageFrom(response: unknown): UnifiedStreamDelta[] {
  if (!isRecord(response) || !isRecord(response.usage)) return [];
  const usage = response.usage;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const cachedInputTokens = details && typeof details.cached_tokens === "number"
    ? details.cached_tokens
    : undefined;
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) return [];
  return [{
    type: "usage",
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  }];
}

export function normalizeResponsesEvent(event: unknown): UnifiedStreamDelta[] {
  if (!isRecord(event) || typeof event.type !== "string") return [];

  switch (event.type) {
    case "response.output_text.delta": {
      const delta = nonEmptyString(event.delta);
      return delta ? [{ type: "text_delta", delta }] : [];
    }

    case "response.output_text.done":
      return [];

    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      const delta = nonEmptyString(event.delta);
      return delta ? [{ type: "reasoning_delta", delta }] : [];
    }

    case "response.refusal.delta": {
      const delta = nonEmptyString(event.delta);
      return delta ? [{ type: "refusal", reason: delta }] : [];
    }

    case "response.refusal.done": {
      const reason = nonEmptyString(event.refusal);
      return reason ? [{ type: "refusal", reason }] : [];
    }

    case "response.output_item.added": {
      const item = isRecord(event.item) ? event.item : undefined;
      const index = indexField(event.output_index);
      if (!item || index === undefined) return [];
      if (item.type !== "function_call") return [];
      const id = nonEmptyString(item.call_id);
      const name = nonEmptyString(item.name);
      return [{
        type: "tool_call_start",
        index,
        ...(id ? { id } : {}),
        ...(name ? { nameDelta: name } : {}),
      }];
    }

    case "response.function_call_arguments.delta": {
      const index = indexField(event.output_index);
      const delta = nonEmptyString(event.delta);
      if (index === undefined || !delta) return [];
      return [{ type: "tool_call_arguments_delta", index, delta }];
    }

    case "response.function_call_arguments.done": {
      // arguments 全量已由 delta 流过；done 只负责闭合，不重放全量
      const index = indexField(event.output_index);
      if (index === undefined) return [];
      return [{ type: "tool_call_end", index }];
    }

    case "response.output_item.done": {
      // function_call 兜底闭合：done 阶段 item 才完整（SDK 注释明确）
      const item = isRecord(event.item) ? event.item : undefined;
      const index = indexField(event.output_index);
      if (!item || index === undefined || item.type !== "function_call") return [];
      const id = nonEmptyString(item.call_id);
      return [{ type: "tool_call_end", index, ...(id ? { id } : {}) }];
    }

    case "response.completed":
      return [...usageFrom(event.response), { type: "finish", reason: "stop" }];

    case "response.incomplete": {
      const response = isRecord(event.response) ? event.response : undefined;
      const reason = response && isRecord(response.incomplete_details)
        ? nonEmptyString(response.incomplete_details.reason)
        : undefined;
      return [
        ...usageFrom(response),
        { type: "finish", reason: reason === "max_output_tokens" ? "length" : reason ?? "incomplete" },
      ];
    }

    case "response.failed": {
      const response = isRecord(event.response) ? event.response : undefined;
      const message = response && isRecord(response.error)
        ? nonEmptyString(response.error.message)
        : undefined;
      throw new ProviderProtocolError(
        "E_UNSUPPORTED_STREAM_EVENT",
        message ?? "Responses stream returned response.failed",
      );
    }

    case "error": {
      const message = nonEmptyString(event.message);
      throw new ProviderProtocolError(
        "E_UNSUPPORTED_STREAM_EVENT",
        message ?? "Responses stream returned an error event",
      );
    }

    default:
      return [];
  }
}
