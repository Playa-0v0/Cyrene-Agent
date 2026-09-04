import type { ChatMessage } from "../../vendors/types";
import {
  TODO_WORKING_NOTEBOOK_POLICY,
  buildCurrentTodoNotebookContext,
} from "../todo-working-notebook";
import { appendInternalTranscriptMessage, createInternalTranscriptMessage } from "../internal-transcript";
import type { AgentState } from "../types";
import type { PromptLayers } from "../../prompt-layers";
import type { CyreneRunOptions } from "../../cyrene-agent";
import { loadPromptFile } from "../../../prompts/prompt-loader";

/**
 * 组装 Harness 的提示词层。
 * stablePrefix 只放可复用的 persona/tool 内容；runtimeContext 是当前运行的动态尾部，
 * 两者分开后才能保持提示词缓存稳定，并避免把一次运行的状态污染到下一次运行。
 */
export function materializeHarnessStartTranscript(input: {
  messages: readonly ChatMessage[];
  runId: string;
  runtimeContext?: string;
  initialState?: AgentState;
  kind: "run_start" | "recovery";
}): ChatMessage[] {
  // 动态上下文在 run_start/recovery 时物化为内部消息，确保 Harness 与恢复流程看到同一份事实。
  const parts = [
    input.runtimeContext,
    input.initialState?.todoItems.length
      ? buildCurrentTodoNotebookContext(input.initialState.todoItems)
      : undefined,
  ].filter((part): part is string => Boolean(part?.trim()));
  if (parts.length === 0) return [...input.messages];

  const revision = input.messages.reduce(
    (current, message) => Math.max(current, message.internal?.revision ?? 0),
    0,
  ) + 1;
  return appendInternalTranscriptMessage(input.messages, createInternalTranscriptMessage({
    kind: input.kind,
    revision,
    runId: input.runId,
    content: parts.join("\n\n---\n\n"),
  }));
}

export function buildHarnessPromptLayers(
  options: CyreneRunOptions,
): PromptLayers & { usageParts?: { personaContent: string; toolLayerContent: string; skillLayerContent?: string } } {
  const personaParts: string[] = [];
  if (options.soulSystemBaseContent) {
    personaParts.push(options.soulSystemBaseContent);
  }

  const harnessPersona = options.conversationMode === "chat"
    ? ""
    : loadPromptFile("cyrene_harness.md");
  if (harnessPersona) {
    personaParts.push(harnessPersona);
  }

  personaParts.push(TODO_WORKING_NOTEBOOK_POLICY);

  const toolParts: string[] = [];
  if (options.toolSystemContent) {
    toolParts.push(options.toolSystemContent);
  }
  if (options.conversationMode !== "chat") {
    const toolUsagePolicy = loadPromptFile("tool_usage.md");
    if (toolUsagePolicy) {
      toolParts.push(toolUsagePolicy);
    }
  }

  // 这里只收集语义上下文块；最终 prompt 的消息顺序由准备阶段/Harness 统一决定。
  const runtimeParts: string[] = [];
  if (options.soulRuntimeContext) runtimeParts.push(options.soulRuntimeContext);
  if (options.planSkillContext) runtimeParts.push(options.planSkillContext);
  if (options.runtimeEnvironmentContext) runtimeParts.push(options.runtimeEnvironmentContext);
  if (options.citaContextBlock) runtimeParts.push(options.citaContextBlock);
  if (options.recoveryContext) runtimeParts.push(`[RECOVERY_CONTEXT]\n${options.recoveryContext}`);
  if (options.responseContext) runtimeParts.push(`[RESPONSE_CONTEXT]\n${options.responseContext}`);

  const stablePrefix = [...personaParts, ...toolParts].join("\n\n---\n\n");
  // 调用方可能把同一段内容同时放进静态层和运行时层；这里去重，避免模型收到重复上下文。
  const uniqueRuntimeParts = runtimeParts.filter((part) => !stablePrefix.includes(part));
  return {
    stablePrefix,
    usageParts: {
      personaContent: personaParts.join("\n\n---\n\n"),
      toolLayerContent: toolParts.join("\n\n---\n\n"),
      ...(options.skillLayerContent ? { skillLayerContent: options.skillLayerContent } : {}),
    },
    ...(options.conversationMode ? { mode: options.conversationMode } : {}),
    ...(uniqueRuntimeParts.length ? { runtimeContext: uniqueRuntimeParts.join("\n\n---\n\n") } : {}),
  };
}

/** @deprecated 兼容外部调用；Harness 主路径改用 buildHarnessPromptLayers。 */
export function buildHarnessSystemPrompt(options: CyreneRunOptions): string {
  // 旧 API 仍返回单字符串；新路径消费分层结果，不要在这里反向改变层的职责。
  const layers = buildHarnessPromptLayers(options);
  return [layers.stablePrefix, layers.runtimeContext].filter(Boolean).join("\n\n---\n\n");
}
