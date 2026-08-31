import type { ChatResponse, ChatVendorAdapter, ToolCall } from "../types";
import {
  ProviderProtocolError,
  type StreamAccumulatorSnapshot,
  type StreamDiagnostic,
  type UnifiedStreamDelta,
} from "./types";

interface ActiveBlock {
  type: string;
  id?: string;
  name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class AnthropicEventNormalizer {
  private readonly activeBlocks = new Map<number, ActiveBlock>();

  normalize(event: unknown): UnifiedStreamDelta[] {
    if (!isRecord(event) || typeof event.type !== "string") return [];
    switch (event.type) {
      case "message_start":
        return this.normalizeUsage(isRecord(event.message) ? event.message.usage : undefined);
      case "content_block_start":
        return this.startBlock(event);
      case "content_block_delta":
        return this.deltaBlock(event);
      case "content_block_stop":
        return this.stopBlock(event);
      case "message_delta": {
        const output = this.normalizeUsage(event.usage);
        const delta = isRecord(event.delta) ? event.delta : undefined;
        const reason = delta ? nonEmptyString(delta.stop_reason) : undefined;
        if (reason) output.push({ type: "finish", reason });
        return output;
      }
      case "message_stop":
      case "ping":
        return [];
      case "error":
        throw new ProviderProtocolError("E_UNSUPPORTED_STREAM_EVENT", "Anthropic stream returned an error event");
      default:
        return [];
    }
  }

  private startBlock(event: Record<string, unknown>): UnifiedStreamDelta[] {
    if (typeof event.index !== "number" || !Number.isInteger(event.index) || !isRecord(event.content_block)) {
      return [];
    }
    const type = nonEmptyString(event.content_block.type);
    if (!type) return [];

    const block: ActiveBlock = {
      type,
      id: nonEmptyString(event.content_block.id),
      name: nonEmptyString(event.content_block.name),
    };
    this.activeBlocks.set(event.index, block);

    if (type === "tool_use") {
      return [{
        type: "tool_call_start",
        index: event.index,
        ...(block.id ? { id: block.id } : {}),
        ...(block.name ? { nameDelta: block.name } : {}),
      }];
    }

    if (type === "thinking") {
      const thinking = nonEmptyString(event.content_block.thinking);
      return thinking ? [{ type: "reasoning_delta", delta: thinking }] : [];
    }
    if (type === "text") {
      const text = nonEmptyString(event.content_block.text);
      return text ? [{ type: "text_delta", delta: text }] : [];
    }
    return [];
  }

  private deltaBlock(event: Record<string, unknown>): UnifiedStreamDelta[] {
    if (typeof event.index !== "number" || !Number.isInteger(event.index) || !isRecord(event.delta)) return [];
    const deltaType = nonEmptyString(event.delta.type);
    if (deltaType === "thinking_delta") {
      const thinking = nonEmptyString(event.delta.thinking);
      return thinking ? [{ type: "reasoning_delta", delta: thinking }] : [];
    }
    if (deltaType === "text_delta") {
      const text = nonEmptyString(event.delta.text);
      return text ? [{ type: "text_delta", delta: text }] : [];
    }
    if (deltaType === "input_json_delta") {
      const partialJson = nonEmptyString(event.delta.partial_json);
      if (!partialJson) return [];
      const block = this.activeBlocks.get(event.index);
      return [{
        type: "tool_call_arguments_delta",
        index: event.index,
        ...(block?.id ? { id: block.id } : {}),
        delta: partialJson,
      }];
    }
    return [];
  }

  private stopBlock(event: Record<string, unknown>): UnifiedStreamDelta[] {
    if (typeof event.index !== "number" || !Number.isInteger(event.index)) return [];
    const block = this.activeBlocks.get(event.index);
    this.activeBlocks.delete(event.index);
    if (block?.type !== "tool_use") return [];
    return [{
      type: "tool_call_end",
      index: event.index,
      ...(block.id ? { id: block.id } : {}),
    }];
  }

  private normalizeUsage(value: unknown): UnifiedStreamDelta[] {
    if (!isRecord(value)) return [];
    const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : undefined;
    const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : undefined;
    const cachedInputTokens = typeof value.cache_read_input_tokens === "number"
      ? value.cache_read_input_tokens
      : undefined;
    const cacheCreationTokens = typeof value.cache_creation_input_tokens === "number"
      ? value.cache_creation_input_tokens
      : undefined;
    return inputTokens !== undefined || outputTokens !== undefined || cachedInputTokens !== undefined || cacheCreationTokens !== undefined
      ? [{ type: "usage", inputTokens, outputTokens, ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}), ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}) }]
      : [];
  }
}

function canonicalArguments(argumentsText: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(argumentsText));
  } catch {
    return undefined;
  }
}

function validateTerminalToolCalls(toolCalls: ToolCall[]): void {
  for (const toolCall of toolCalls) {
    if (!toolCall.id || !toolCall.name.trim() || canonicalArguments(toolCall.arguments) === undefined) {
      throw new ProviderProtocolError(
        "E_TOOL_CALL_INCOMPLETE",
        "Anthropic terminal message contains an incomplete tool call",
      );
    }
  }
}

function normalizedFinishReason(reason: string | undefined): string | undefined {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "end_turn") return "stop";
  if (reason === "max_tokens") return "length";
  return reason;
}

function terminalMismatch(
  live: StreamAccumulatorSnapshot,
  terminal: ChatResponse,
): { differences: string[]; diagnostic: StreamDiagnostic } | undefined {
  const differences: string[] = [];
  if (live.text !== terminal.text) differences.push("text");
  if ((live.thinking ?? "") !== (terminal.thinking ?? "")) differences.push("reasoning");
  if (normalizedFinishReason(live.finishReason) !== normalizedFinishReason(terminal.finishReason)) {
    differences.push("finish_reason");
  }
  if (live.usage && !terminal.usage) {
    differences.push("usage_missing_in_terminal");
  } else if (
    live.usage && terminal.usage &&
    (live.usage.input !== terminal.usage.input || live.usage.output !== terminal.usage.output)
  ) {
    differences.push("usage");
  }

  const liveTools = live.toolCalls.map((toolCall) => ({
    id: toolCall.id ?? "",
    name: toolCall.name,
    arguments: canonicalArguments(toolCall.arguments),
  }));
  const terminalTools = terminal.toolCalls.map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.name,
    arguments: canonicalArguments(toolCall.arguments),
  }));
  if (JSON.stringify(liveTools) !== JSON.stringify(terminalTools)) differences.push("tool_calls");
  if (differences.length === 0) return undefined;

  return {
    differences,
    diagnostic: {
      code: "E_STREAM_TERMINAL_MISMATCH",
      transport: "anthropic",
      differences,
      live: {
        text_length: live.text.length,
        reasoning_length: live.thinking?.length ?? 0,
        tool_call_ids: live.toolCalls.flatMap((toolCall) => toolCall.id ? [toolCall.id] : []),
      },
      terminal: {
        text_length: terminal.text.length,
        reasoning_length: terminal.thinking?.length ?? 0,
        tool_call_ids: terminal.toolCalls.map((toolCall) => toolCall.id),
      },
    },
  };
}

/**
 * Field-wise merge: terminal 优先，terminal 缺的字段用 live（流式采集）补。
 * 避免 Anthropic 兼容接口 finalMessage 不返回 cachedInput/cacheCreation 时流式结果被丢弃。
 */
function mergeUsage(
  live: { input: number; output: number; cachedInput?: number; cacheCreation?: number } | undefined,
  terminal: { input: number; output: number; cachedInput?: number; cacheCreation?: number } | undefined,
): { input: number; output: number; cachedInput?: number; cacheCreation?: number } | undefined {
  if (!live && !terminal) return undefined;
  if (!live) return terminal;
  if (!terminal) return live;
  const cachedInput = terminal.cachedInput ?? live.cachedInput;
  const cacheCreation = terminal.cacheCreation ?? live.cacheCreation;
  return {
    input: terminal.input,
    output: terminal.output,
    ...(cachedInput !== undefined ? { cachedInput } : {}),
    ...(cacheCreation !== undefined ? { cacheCreation } : {}),
  };
}

export function reconcileAnthropicTerminal(
  live: StreamAccumulatorSnapshot,
  finalMessage: unknown,
  adapter: ChatVendorAdapter,
  onDiagnostic?: (diagnostic: StreamDiagnostic) => void,
): ChatResponse {
  const terminal = adapter.parseResponse(finalMessage);
  validateTerminalToolCalls(terminal.toolCalls);
  const mismatch = terminalMismatch(live, terminal);
  if (mismatch) onDiagnostic?.(mismatch.diagnostic);
  return { ...terminal, usage: mergeUsage(live.usage, terminal.usage) };
}
