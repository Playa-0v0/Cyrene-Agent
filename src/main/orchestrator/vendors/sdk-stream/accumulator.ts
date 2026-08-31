import type { ChatResponse, ToolCall } from "../types";
import {
  ProviderProtocolError,
  type StreamAccumulatorSnapshot,
  type UnifiedStreamDelta,
} from "./types";

interface MutableToolCall {
  index: number;
  id?: string;
  name: string;
  arguments: string;
  ended: boolean;
}

export class CyreneStreamAccumulator {
  private text = "";
  private thinking = "";
  private readonly toolCalls = new Map<number, MutableToolCall>();
  private finishReason: string | undefined;
  private refusal: string | undefined;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private cachedInputTokens: number | undefined;
  private cacheCreationTokens: number | undefined;

  apply(delta: UnifiedStreamDelta): void {
    switch (delta.type) {
      case "reasoning_delta":
        this.thinking += delta.delta;
        return;
      case "text_delta":
        this.text += delta.delta;
        return;
      case "tool_call_start": {
        const toolCall = this.getOrCreateToolCall(delta.index);
        this.assignStableId(toolCall, delta.id);
        toolCall.name += delta.nameDelta ?? "";
        return;
      }
      case "tool_call_arguments_delta": {
        const toolCall = this.getOrCreateToolCall(delta.index);
        this.assignStableId(toolCall, delta.id);
        toolCall.arguments += delta.delta;
        return;
      }
      case "tool_call_end": {
        const toolCall = this.getOrCreateToolCall(delta.index);
        this.assignStableId(toolCall, delta.id);
        toolCall.ended = true;
        return;
      }
      case "usage":
        if (delta.inputTokens !== undefined) this.inputTokens = delta.inputTokens;
        if (delta.outputTokens !== undefined) this.outputTokens = delta.outputTokens;
        if (delta.cachedInputTokens !== undefined) this.cachedInputTokens = delta.cachedInputTokens;
        if (delta.cacheCreationTokens !== undefined) this.cacheCreationTokens = delta.cacheCreationTokens;
        return;
      case "finish":
        this.finishReason = delta.reason;
        return;
      case "refusal":
        this.refusal = delta.reason;
        return;
    }
  }

  snapshot(): StreamAccumulatorSnapshot {
    return {
      text: this.text,
      ...(this.thinking ? { thinking: this.thinking } : {}),
      toolCalls: this.sortedToolCalls().map((toolCall) => ({ ...toolCall })),
      ...(this.finishReason !== undefined ? { finishReason: this.finishReason } : {}),
      ...(this.refusal !== undefined ? { refusal: this.refusal } : {}),
      ...(this.inputTokens !== undefined || this.outputTokens !== undefined || this.cachedInputTokens !== undefined || this.cacheCreationTokens !== undefined
        ? { usage: {
            input: this.inputTokens ?? 0,
            output: this.outputTokens ?? 0,
            ...(this.cachedInputTokens !== undefined ? { cachedInput: this.cachedInputTokens } : {}),
            ...(this.cacheCreationTokens !== undefined ? { cacheCreation: this.cacheCreationTokens } : {}),
          } }
        : {}),
    };
  }

  finalize(raw: unknown): ChatResponse {
    const toolCalls = this.sortedToolCalls().map((toolCall) => this.finalizeToolCall(toolCall));
    const assistantMessage = {
      role: "assistant" as const,
      content: this.text,
      ...(this.thinking ? { thinking: this.thinking } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return {
      assistantMessage,
      text: this.text,
      ...(this.thinking ? { thinking: this.thinking } : {}),
      ...(this.refusal !== undefined ? { refusal: this.refusal } : {}),
      toolCalls,
      finishReason: this.finishReason ?? "unknown",
      raw,
      ...(this.inputTokens !== undefined || this.outputTokens !== undefined || this.cachedInputTokens !== undefined || this.cacheCreationTokens !== undefined
        ? { usage: {
            input: this.inputTokens ?? 0,
            output: this.outputTokens ?? 0,
            ...(this.cachedInputTokens !== undefined ? { cachedInput: this.cachedInputTokens } : {}),
            ...(this.cacheCreationTokens !== undefined ? { cacheCreation: this.cacheCreationTokens } : {}),
          } }
        : {}),
    };
  }

  private getOrCreateToolCall(index: number): MutableToolCall {
    const existing = this.toolCalls.get(index);
    if (existing) return existing;

    const created: MutableToolCall = {
      index,
      name: "",
      arguments: "",
      ended: false,
    };
    this.toolCalls.set(index, created);
    return created;
  }

  private assignStableId(toolCall: MutableToolCall, id: string | undefined): void {
    if (!id) return;
    if (!toolCall.id) {
      toolCall.id = id;
      return;
    }
    if (toolCall.id !== id) {
      throw new ProviderProtocolError(
        "E_TOOL_CALL_ID_CHANGED",
        `Tool call at index ${toolCall.index} changed id from ${toolCall.id} to ${id}`,
      );
    }
  }

  private sortedToolCalls(): MutableToolCall[] {
    return [...this.toolCalls.values()].sort((left, right) => left.index - right.index);
  }

  private finalizeToolCall(toolCall: MutableToolCall): ToolCall {
    if (!toolCall.ended || !toolCall.id || !toolCall.name.trim()) {
      throw new ProviderProtocolError(
        "E_TOOL_CALL_INCOMPLETE",
        `Tool call at index ${toolCall.index} is missing its terminal marker, id, or name`,
      );
    }

    try {
      JSON.parse(toolCall.arguments);
    } catch (error) {
      throw new ProviderProtocolError(
        "E_TOOL_CALL_INCOMPLETE",
        `Tool call at index ${toolCall.index} has incomplete JSON arguments: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    };
  }
}
