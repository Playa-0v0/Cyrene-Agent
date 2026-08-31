import { createHash } from "crypto";
import type { ChatMessage, ChatRequest, ToolSpec } from "./vendors/types";
import { toModelVisibleMessage } from "./harness/internal-transcript";

export interface PromptLayers {
  stablePrefix: string;
  sessionPrefix?: string;
  runtimeContext?: string;
  /** 仅作本地缓存身份的一部分，绝不写入厂商请求体。 */
  mode?: string;
}

export interface PromptLayerMetadata {
  stablePrefix: string;
  sessionPrefix?: string;
  mode?: string;
  promptVersion: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function normalizeToolSpecsForCache(tools: readonly ToolSpec[]): ToolSpec[] {
  return tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: stableValue(tool.parameters) as object,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildStableSystemPrefix(layers: Pick<PromptLayers, "stablePrefix" | "sessionPrefix">): string {
  return [layers.stablePrefix, layers.sessionPrefix].filter(Boolean).join("\n\n---\n\n");
}

export function composePromptLayers(
  layers: PromptLayers,
  persistedMessages: readonly ChatMessage[],
): { messages: ChatMessage[]; metadata: PromptLayerMetadata } {
  const stableSystem = buildStableSystemPrefix(layers);
  const messages: ChatMessage[] = [
    ...(stableSystem ? [{ role: "system" as const, content: stableSystem }] : []),
    ...persistedMessages.map((message) => toModelVisibleMessage(message)),
  ];
  if (layers.runtimeContext?.trim()) {
    messages.push({
      role: "user",
      content: `<runtime_context>\n${layers.runtimeContext.trim()}\n</runtime_context>`,
    });
  }
  return {
    messages,
    metadata: {
      stablePrefix: layers.stablePrefix,
      ...(layers.sessionPrefix ? { sessionPrefix: layers.sessionPrefix } : {}),
      ...(layers.mode ? { mode: layers.mode } : {}),
      promptVersion: "v1",
    },
  };
}

export function buildStableCacheFingerprint(input: {
  provider: string;
  model: string;
  mode?: string;
  promptVersion: string;
  stablePrefix: string;
  sessionPrefix?: string;
  tools: readonly ToolSpec[];
}): string {
  const payload = JSON.stringify({
    provider: input.provider,
    model: input.model,
    mode: input.mode ?? "",
    promptVersion: input.promptVersion,
    stablePrefix: input.stablePrefix,
    sessionPrefix: input.sessionPrefix ?? "",
    tools: normalizeToolSpecsForCache(input.tools),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** 不含 stream、请求 ID 与厂商私有字段的稳定请求投影，供缓存不变量测试和诊断使用。 */
export interface CacheRelevantRequest {
  stableSystem: string;
  tools: ToolSpec[];
  messages: ChatMessage[];
}

export function projectCacheRelevantRequest(input: {
  stableSystem: string;
  tools: readonly ToolSpec[];
  messages: readonly ChatMessage[];
}): CacheRelevantRequest {
  return {
    stableSystem: input.stableSystem,
    tools: normalizeToolSpecsForCache(input.tools),
    messages: input.messages.map((message) => toModelVisibleMessage(message)),
  };
}

/** 从已组装的 ChatRequest 取出可比较的缓存相关字段。 */
export function projectCacheRelevantChatRequest(request: ChatRequest): CacheRelevantRequest {
  const systemMessages = request.messages.filter((message) => message.role === "system");
  return projectCacheRelevantRequest({
    stableSystem: systemMessages.map((message) => String(message.content ?? "")).join("\n\n"),
    tools: request.tools ?? [],
    messages: request.messages.filter((message) => message.role !== "system"),
  });
}
