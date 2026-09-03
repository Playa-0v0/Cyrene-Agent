import type { WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { PluginPromptMode, PluginTurnStatus } from "../../plugins/api";
import { AgentRuntimeError } from "../orchestrator/agent-runtime-error";
import { CyreneAgent, type CyreneRunOptions } from "../orchestrator/cyrene-agent";
import type { LifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { filterToolsForTask } from "./tool-filter";
import type { ScheduledRunResult, ScheduledTask, ScheduledTaskHistoryEntry } from "./types";

/**
 * 第一期：scheduler 的 buildOptions 返回"传统"形式（包含 system 消息）。
 * CyreneAgent 暂时通过 fallback 兼容：检测 options.messages[0].role === "system" 时，
 * 用它作为 soulSystemBaseContent（重复一次），toolSystemContent 用同一个串（暂时不拆分）。
 *
 * 第二期：scheduler 同步迁移到 tool_system / soul_system 分阶段，buildOptions 改为返回
 * 带 toolSystemContent / soulSystemBaseContent 的 CyreneRunOptions。
 */
type LegacyRunOptions = Omit<CyreneRunOptions, "toolSystemContent" | "soulSystemBaseContent">;

interface RunnerDeps {
  buildOptions: (task: ScheduledTask) => Promise<LegacyRunOptions>;
  getChatWebContents: () => WebContents | null;
  recordHistory: (entry: ScheduledTaskHistoryEntry) => void;
  id: () => string;
  now: () => Date;
  /** 生命周期事件发布器；缺省不发布（早期装配与纯策略测试场景）。 */
  publishLifecycle?: LifecyclePublisher;
}

/**
 * 定时任务是无人值守的 Work Harness：不询问、不审批，直接执行已分配工具。
 * 会话模式来自任务冻结的 mode 字段（旧任务默认 work）；执行循环沿用现有
 * 映射：chat 走 chat loop，其余模式走 work harness。
 */
export function applyScheduledExecutionPolicy(options: CyreneRunOptions, mode: PluginPromptMode = "work"): CyreneRunOptions {
  return {
    ...options,
    executionMode: mode === "chat" ? "chat" : "work",
    conversationMode: mode,
    harnessInteractiveTools: false,
    permissionMode: "allow_all",
  };
}

export function createSchedulerRunner(deps: RunnerDeps) {
  async function runScheduledTask(task: ScheduledTask, _scheduledFireAt: Date, manual: boolean): Promise<ScheduledRunResult> {
    const historyId = deps.id();
    const startedAt = deps.now();
    const allTools = toolRegistry.getAllTools();
    const effectiveTools = filterToolsForTask(task, allTools);
    const effectiveToolIds = effectiveTools.map(t => t.id);

    deps.recordHistory({
      id: historyId,
      taskId: task.id,
      taskTitle: task.title,
      firedAt: startedAt.toISOString(),
      status: "running",
      reason: manual ? "manual fireNow" : undefined,
      effectiveToolIds,
    });

    const send = (event: unknown): void => {
      const wc = deps.getChatWebContents();
      if (!wc || wc.isDestroyed()) return;
      wc.send(IPC.SCHEDULER_EVENT, event);
    };

    send({
      type: "CUSTOM",
      name: "scheduler.started",
      schedulerRunId: historyId,
      schedulerTaskId: task.id,
      value: { taskId: task.id, title: task.title, manual, firedAt: startedAt.toISOString(), runId: historyId },
    });

    // 调度执行没有桌面会话，事件只携带任务与历史标识，不伪造 conversationId
    deps.publishLifecycle?.publishTurnStarted({
      source: "scheduler",
      runId: historyId,
      mode: task.mode ?? "work",
      taskId: task.id,
      schedulerRunId: historyId,
    });

    try {
      const legacyOptions = await deps.buildOptions(task);
      legacyOptions.tools = effectiveTools;

      // 第一期兼容：把传统 messages 里的 system 消息拆出来作为 soulSystemBaseContent。
      // toolSystemContent 暂用同一份（scheduler 第二期再迁）。
      const sysIdx = legacyOptions.messages.findIndex((m) => m.role === "system");
      let soulSystemBaseContent: string;
      let messages = legacyOptions.messages;
      if (sysIdx >= 0) {
        const sysMsg = legacyOptions.messages[sysIdx];
        soulSystemBaseContent = typeof sysMsg.content === "string" ? sysMsg.content : "";
        messages = legacyOptions.messages.filter((_, i) => i !== sysIdx);
      } else {
        soulSystemBaseContent = "";
      }
      const toolSystemContent = soulSystemBaseContent; // 第一期暂用同一份

      const options = applyScheduledExecutionPolicy({
        ...legacyOptions,
        messages,
        toolSystemContent,
        soulSystemBaseContent,
      }, task.mode ?? "work");

      const agent = new CyreneAgent({ threadId: `scheduler-${task.id}`, description: `Scheduled task: ${task.title}` });

      await new Promise<void>((resolve, reject) => {
        const sub = agent.runWithEvents(options).subscribe({
          next: (event) => send({ ...event, schedulerRunId: historyId, schedulerTaskId: task.id }),
          error: (err) => {
            sub.unsubscribe();
            reject(err instanceof Error ? err : new Error(String(err)));
          },
          complete: () => {
            sub.unsubscribe();
            resolve();
          },
        });
      });

      const finishedAt = deps.now();
      const reply = agent.lastResult?.reply ?? "";
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      // Observable 在超时等非成功终态下也会正常 complete：事件状态以 agent 终态为准
      const status: PluginTurnStatus = agent.lastResult?.terminal?.status ?? "success";
      deps.recordHistory({
        id: historyId,
        taskId: task.id,
        taskTitle: task.title,
        firedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        status: "success",
        outputPreview: reply.slice(0, 160),
        effectiveToolIds,
      });
      deps.publishLifecycle?.publishTurnFinished({
        source: "scheduler",
        runId: historyId,
        mode: task.mode ?? "work",
        taskId: task.id,
        schedulerRunId: historyId,
        status,
        durationMs,
      });
      deps.publishLifecycle?.publishSchedulerFinished({
        taskId: task.id,
        schedulerRunId: historyId,
        status,
        durationMs,
      });
      return { ok: true, historyId, reply, effectiveToolIds };
    } catch (err) {
      const finishedAt = deps.now();
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      deps.publishLifecycle?.publishTurnFinished({
        source: "scheduler",
        runId: historyId,
        mode: task.mode ?? "work",
        taskId: task.id,
        schedulerRunId: historyId,
        status: "runtime_error",
        durationMs,
      });
      deps.publishLifecycle?.publishSchedulerFinished({
        taskId: task.id,
        schedulerRunId: historyId,
        status: "runtime_error",
        durationMs,
      });
      deps.recordHistory({
        id: historyId,
        taskId: task.id,
        taskTitle: task.title,
        firedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        status: "failed",
        errorMessage: message,
        effectiveToolIds,
      });
      send({ type: "RUN_ERROR", message, code: err instanceof AgentRuntimeError ? err.code : undefined, threadId: `scheduler-${task.id}`, runId: historyId, schedulerRunId: historyId, schedulerTaskId: task.id });
      return { ok: false, historyId, error: message, effectiveToolIds };
    }
  }

  return { runScheduledTask };
}
