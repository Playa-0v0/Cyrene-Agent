import type { WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { CyreneAgent, type CyreneRunOptions } from "../orchestrator/cyrene-agent";
import { toolRegistry } from "../orchestrator/tool-registry";
import { filterToolsForTask } from "./tool-filter";
import type { ScheduledRunResult, ScheduledTask, ScheduledTaskHistoryEntry } from "./types";

interface RunnerDeps {
  buildOptions: (task: ScheduledTask) => Promise<CyreneRunOptions>;
  getChatWebContents: () => WebContents | null;
  recordHistory: (entry: ScheduledTaskHistoryEntry) => void;
  id: () => string;
  now: () => Date;
  onSuccess?: (task: ScheduledTask, result: ScheduledRunResult) => Promise<void> | void;
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

    try {
      const options = await deps.buildOptions(task);
      options.tools = effectiveTools;
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
      deps.recordHistory({
        id: historyId,
        taskId: task.id,
        taskTitle: task.title,
        firedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        status: "success",
        outputPreview: reply.slice(0, 160),
        effectiveToolIds,
      });
      const result: ScheduledRunResult = { ok: true, historyId, reply, effectiveToolIds };
      try {
        await deps.onSuccess?.(task, result);
      } catch (err) {
        // 呈現層（例如每日儀式的氣泡/TTS）失敗，不應把已完成的 Agent 任務改判失敗。
        console.warn("[Scheduler] success callback failed:", err instanceof Error ? err.message : err);
      }
      return result;
    } catch (err) {
      const finishedAt = deps.now();
      const message = err instanceof Error ? err.message : String(err);
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
      send({ type: "RUN_ERROR", error: message, threadId: `scheduler-${task.id}`, runId: historyId, schedulerRunId: historyId, schedulerTaskId: task.id });
      return { ok: false, historyId, error: message, effectiveToolIds };
    }
  }

  return { runScheduledTask };
}
