import { app } from "electron";
import type { BaseEvent } from "@ag-ui/core";
import type { ToolDefinition } from "../../tools/registry/tool-registry";
import { toolRegistry } from "../../tools/registry/tool-registry";
import { checkPermission, type ToolRiskLevel } from "../../../permission";
import { policyFor } from "../../../permission-policy";
import { isPlanReadOnly } from "../../plan-mode";
import { contextRefRegistry, extractLastUserQuery, type ToolContext } from "../../tools/registry/tool-context";
import type { HarnessInput } from "../index";
import { TaskSessionStore } from "../../../tasks/task-session-store";
import { createTaskExecutor } from "../../task-runtime";
import { FileToolOutputStore } from "../tool-output/file-tool-output-store";
import { sendTaskLifecycleAsAgui } from "./event-mapper";
import type { PreparedHarnessRun } from "./run-preparation";
import type { CyreneRunOptions } from "../../cyrene-agent";

/**
 * 为一次 Harness run 构造工具运行时（tool runtime）。
 * signal、runId 和 permissionCheck 从父 run 原样下传，避免子任务或权限检查产生第二套生命周期。
 */
export interface PreparedToolRuntime {
  toolContext: ToolContext;
  checkPermission: NonNullable<HarnessInput["checkPermission"]>;
  toolOutputStore: FileToolOutputStore;
  taskExecutor: HarnessInput["taskExecutor"];
}

export function prepareToolRuntime(input: {
  options: CyreneRunOptions;
  signal: AbortSignal;
  prepared: PreparedHarnessRun;
  sendBaseEvent: (event: BaseEvent) => void;
}): PreparedToolRuntime {
  const { options, signal, prepared } = input;
  const { threadId, runId, systemPrompt, vendorConfig, tools } = prepared;
  const permissionCheck: NonNullable<HarnessInput["checkPermission"]> = async (
    toolId: string,
    args: Record<string, unknown>,
  ): Promise<boolean> => {
    // allow_all 是显式总开关，会跳过后续权限检查；普通权限模式下才先执行计划只读拦截。
    if (options.permissionMode === "allow_all") return true;
    if (
      (options.conversationMode === "code" || options.conversationMode === "chat")
      && isPlanReadOnly(threadId)
    ) {
      const planTool = toolRegistry.getById(toolId) as (ToolDefinition & { risk?: ToolRiskLevel }) | undefined;
      const planRisk: ToolRiskLevel = planTool?.risk ?? "safe";
      if (policyFor("read-only", planRisk) !== "allow") {
        console.log(`[HarnessAdapter] [Plan] read-only enforcement blocked tool=${toolId} risk=${planRisk}`);
        return false;
      }
    }
    const tool = toolRegistry.getById(toolId);
    if (!tool) return false;
    const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk ?? "safe";
    return (await checkPermission({
      toolId,
      toolName: tool.name,
      toolDescription: tool.description,
      args,
      risk,
      runId,
      signal,
    })).allowed;
  };

  const toolContext: ToolContext = {
    userQuery: extractLastUserQuery(options.messages),
    conversationId: options.conversationId ?? "default",
    runId,
    contextRefs: contextRefRegistry,
    signal,
    resolvedWorkspaceRoot: options.resolvedWorkspaceRoot,
    mode: options.conversationMode,
    allowedSkillIds: options.capabilities?.skillIds,
    permissionMode: options.permissionMode,
  };
  const toolOutputStore = new FileToolOutputStore(app.getPath("userData"));
  // 只有 work/code 模式允许派生任务；chat 模式不创建 TaskSession，避免出现不可见的后台执行。
  const taskExecutor = options.conversationMode === "work" || options.conversationMode === "code"
    ? createTaskExecutor({
      parent: {
        parentConversationId: threadId,
        parentRunId: runId,
        mode: options.conversationMode,
        capabilities: options.capabilities,
        systemPrompt,
        vendorConfig,
        tools,
        resolvedWorkspaceRoot: options.resolvedWorkspaceRoot,
        signal,
        checkPermission: permissionCheck,
        includeInteractiveTools: options.harnessInteractiveTools,
        permissionMode: options.permissionMode,
        toolOutputStore,
      },
      store: new TaskSessionStore(app.getPath("userData")),
      onLifecycle: (event) => sendTaskLifecycleAsAgui(event, threadId, runId, input.sendBaseEvent),
    })
    : undefined;

  return { toolContext, checkPermission: permissionCheck, toolOutputStore, taskExecutor };
}
