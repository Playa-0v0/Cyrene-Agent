import type { UnifiedStreamDelta } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function reasoningDeltas(delta: Record<string, unknown>): string[] {
  const output: string[] = [];
  for (const key of ["reasoning_content", "reasoning", "thinking"] as const) {
    const value = nonEmptyString(delta[key]);
    if (value) output.push(value);
  }

  if (Array.isArray(delta.reasoning_details)) {
    for (const detail of delta.reasoning_details) {
      if (!isRecord(detail)) continue;
      const text = nonEmptyString(detail.text) ?? nonEmptyString(detail.content);
      if (text) output.push(text);
    }
  }
  return output;
}

function normalizeToolCalls(value: unknown): UnifiedStreamDelta[] {
  if (!Array.isArray(value)) return [];
  const output: UnifiedStreamDelta[] = [];

  for (const item of value) {
    if (!isRecord(item) || typeof item.index !== "number" || !Number.isInteger(item.index)) continue;
    const id = nonEmptyString(item.id);
    const fn = isRecord(item.function) ? item.function : undefined;
    const nameDelta = fn ? nonEmptyString(fn.name) : undefined;
    const argumentsDelta = fn ? nonEmptyString(fn.arguments) : undefined;

    if (id || nameDelta) {
      output.push({
        type: "tool_call_start",
        index: item.index,
        ...(id ? { id } : {}),
        ...(nameDelta ? { nameDelta } : {}),
      });
    }
    if (argumentsDelta) {
      output.push({
        type: "tool_call_arguments_delta",
        index: item.index,
        ...(id ? { id } : {}),
        delta: argumentsDelta,
      });
    }
  }

  return output;
}

export function normalizeOpenAIChunk(chunk: unknown): UnifiedStreamDelta[] {
  if (!isRecord(chunk)) return [];
  const output: UnifiedStreamDelta[] = [];
  const finishReasons: string[] = [];
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];

  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    if (delta) {
      for (const reasoning of reasoningDeltas(delta)) {
        output.push({ type: "reasoning_delta", delta: reasoning });
      }

      const content = nonEmptyString(delta.content);
      if (content) output.push({ type: "text_delta", delta: content });
      output.push(...normalizeToolCalls(delta.tool_calls));

      const refusal = nonEmptyString(delta.refusal);
      if (refusal) output.push({ type: "refusal", reason: refusal });
    }

    const finishReason = nonEmptyString(choice.finish_reason);
    if (finishReason) finishReasons.push(finishReason);
  }

  if (isRecord(chunk.usage)) {
    const inputTokens = typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : undefined;
    const outputTokens =
      typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : undefined;
    const details = isRecord(chunk.usage.prompt_tokens_details)
      ? chunk.usage.prompt_tokens_details
      : undefined;
    const cachedInputTokens = details && typeof details.cached_tokens === "number"
      ? details.cached_tokens
      : undefined;
    if (inputTokens !== undefined || outputTokens !== undefined) {
      output.push({ type: "usage", inputTokens, outputTokens, ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}) });
    }
  }

  for (const reason of finishReasons) {
    output.push({ type: "finish", reason });
  }
  return output;
}
