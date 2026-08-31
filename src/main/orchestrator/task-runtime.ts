import type { TaskSessionStatus, TaskSubagentType, TaskTranscriptMessage } from "../../shared/task-session";
import { TaskSessionStore } from "../tasks/task-session-store";
import { projectTaskTraceEvent } from "./task-events";
import { getTaskAgentProfile, resolveTaskTools } from "./task-profiles";
import { runCyreneHarness } from "./harness/cyrene-harness";
import type { HarnessInput, HarnessResult } from "./harness/types";
import type { ToolDefinition } from "./tool-registry";
import type { VendorConfig, ChatMessage } from "./vendors/types";
import type { ToolContext } from "./tool-context";
import { taskCharacterLeasePool, type TaskCharacterLeasePool } from "../tasks/task-character-pool";
import type { TaskDelegationPresentation } from "../../shared/task-session";
import type { RunCapabilities } from "./run-capabilities";
import type { PromptLayers } from "./prompt-layers";
import type { ToolOutputStore } from "./harness/tool-output/tool-output-store";

export interface TaskExecuteRequest {
  description: string;
  prompt: string;
  subagentType: TaskSubagentType;
  companionId: string;
  taskId?: string;
}

export interface TaskExecuteResult {
  taskId: string;
  status: TaskSessionStatus;
  text: string;
}

export interface TaskRuntimeParentContext {
  parentConversationId: string;
  parentRunId: string;
  mode: "work" | "code";
  systemPrompt: string;
  vendorConfig: VendorConfig;
  tools: ToolDefinition[];
  capabilities?: RunCapabilities;
  resolvedWorkspaceRoot?: string;
  signal?: AbortSignal;
  checkPermission?: HarnessInput["checkPermission"];
  includeInteractiveTools?: boolean;
  permissionMode?: import("./cyrene-agent").CyreneRunOptions["permissionMode"];
  toolOutputStore?: ToolOutputStore;
}

function taskStatus(result: HarnessResult): { status: Exclude<TaskSessionStatus, "running" | "interrupted">; error?: { code: string; message: string } } {
  const terminal = result.terminal?.status;
  if (terminal === "cancelled" || result.terminateReason === "cancelled") return { status: "cancelled" };
  if (terminal === "timeout" || result.terminateReason === "timeout") {
    return { status: "failed", error: { code: "TASK_TIMEOUT", message: "子任务超过执行时间上限" } };
  }
  if (terminal === "runtime_error" || result.terminateReason === "error") {
    return { status: "failed", error: { code: "TASK_RUNTIME_ERROR", message: result.finalAnswer || "子任务运行失败" } };
  }
  return { status: "completed" };
}

export function buildChildPromptLayers(parent: TaskRuntimeParentContext, profilePrompt: string): PromptLayers {
  const workspace = parent.resolvedWorkspaceRoot
    ? `可信工作目录：${parent.resolvedWorkspaceRoot}`
    : "当前没有绑定工作目录。";
  return {
    stablePrefix: profilePrompt,
    sessionPrefix: `${workspace}\n会话模式：${parent.mode}`,
    mode: parent.mode,
  };
}

export function createTaskExecutor(input: {
  parent: TaskRuntimeParentContext;
  store: TaskSessionStore;
  runHarness?: typeof runCyreneHarness;
  characterPool?: Pick<TaskCharacterLeasePool, "acquire">;
  onLifecycle?: (event: TaskDelegationPresentation) => void;
}): (request: TaskExecuteRequest) => Promise<TaskExecuteResult> {
  const runHarness = input.runHarness ?? runCyreneHarness;
  const characterPool = input.characterPool ?? taskCharacterLeasePool;
  return async (request) => {
    const profile = getTaskAgentProfile(request.subagentType);
    const session = request.taskId
      ? input.store.resume(request.taskId, {
          parentConversationId: input.parent.parentConversationId,
          parentRunId: input.parent.parentRunId,
          subagentType: request.subagentType,
          prompt: request.prompt,
        })
      : input.store.create({
          parentConversationId: input.parent.parentConversationId,
          parentRunId: input.parent.parentRunId,
          description: request.description,
          prompt: request.prompt,
          subagentType: request.subagentType,
          mode: input.parent.mode,
          resolvedWorkspaceRoot: input.parent.resolvedWorkspaceRoot,
        });

    const toolContext: ToolContext = {
      userQuery: request.prompt,
      conversationId: input.parent.parentConversationId,
      runId: session.childRunId,
      signal: input.parent.signal,
      resolvedWorkspaceRoot: input.parent.resolvedWorkspaceRoot,
      mode: input.parent.mode,
      allowedSkillIds: input.parent.capabilities?.skillIds,
      permissionMode: input.parent.permissionMode,
    };

    const lease = characterPool.acquire(input.parent.parentConversationId, request.companionId);
    const presentation = {
      invocationId: session.childRunId,
      taskId: session.id,
      description: request.description,
      nickname: lease.nickname,
      assetFileName: lease.assetFileName,
    };
    input.onLifecycle?.({ ...presentation, status: "running" });

    try {
      const promptLayers = buildChildPromptLayers(input.parent, profile.systemPrompt);
      const result = await runHarness({
        systemPrompt: promptLayers.stablePrefix,
        promptLayers,
        messages: session.messages as ChatMessage[],
        tools: resolveTaskTools(profile, input.parent.tools),
        vendorConfig: input.parent.vendorConfig,
        config: { totalTimeoutMs: profile.timeoutMs },
        initialState: {
          todoItems: session.todoItems,
          uncertainEffects: [],
        },
        signal: input.parent.signal,
        toolContext,
        toolOutputStore: input.parent.toolOutputStore,
        checkPermission: input.parent.checkPermission,
        includeInteractiveTools: input.parent.includeInteractiveTools,
        onEvent: (event) => {
          const trace = projectTaskTraceEvent(event);
          if (trace) {
            const current = input.store.get(session.id);
            if (current) input.store.checkpoint(session.id, { trace: [...current.trace, trace] });
          }
        },
        onCheckpoint: (checkpoint) => {
          input.store.checkpoint(session.id, {
            messages: checkpoint.messages as TaskTranscriptMessage[],
            todoItems: checkpoint.state.todoItems,
          });
        },
      });
      const mapped = taskStatus(result);
      input.store.checkpoint(session.id, {
        status: mapped.status,
        resultText: result.finalAnswer,
        todoItems: result.finalState.todoItems,
        ...(mapped.error ? { error: mapped.error } : {}),
        completedAt: Date.now(),
      });
      input.onLifecycle?.({ ...presentation, status: mapped.status });
      return { taskId: session.id, status: mapped.status, text: result.finalAnswer };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.store.checkpoint(session.id, {
        status: input.parent.signal?.aborted ? "cancelled" : "failed",
        error: { code: input.parent.signal?.aborted ? "TASK_CANCELLED" : "TASK_RUNTIME_ERROR", message },
        completedAt: Date.now(),
      });
      input.onLifecycle?.({ ...presentation, status: input.parent.signal?.aborted ? "cancelled" : "failed" });
      throw error;
    } finally {
      lease.release();
    }
  };
}
