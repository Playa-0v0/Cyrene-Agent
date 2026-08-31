import { computeNextFireAtAfter, normalizeOverdueNextFireAt } from "./schedule-calculator";
import type { ScheduledRunResult, ScheduledTask, ScheduledTaskHistoryEntry } from "./types";

const MAX_TIMER_DELAY_MS = 60 * 60 * 1000;

interface SchedulerStoreLike {
  getTasks(): ScheduledTask[];
  updateTask(id: string, patch: Partial<ScheduledTask>): ScheduledTask;
  recordHistory(entry: ScheduledTaskHistoryEntry): void;
  onChange(listener: (tasks: ScheduledTask[]) => void): () => void;
}

export interface SchedulerEngineDeps {
  store: SchedulerStoreLike;
  runTask: (task: ScheduledTask, scheduledFireAt: Date, manual: boolean) => Promise<ScheduledRunResult>;
  now?: () => Date;
  id?: () => string;
}

export class SchedulerEngine {
  private timer: NodeJS.Timeout | null = null;
  private runningTaskIds = new Set<string>();
  private readonly now: () => Date;
  private readonly id: () => string;
  private unsubscribeStore?: () => void;

  constructor(private readonly deps: SchedulerEngineDeps) {
    this.now = deps.now ?? (() => new Date());
    this.id = deps.id ?? (() => `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }

  start(): void {
    this.normalizeOverdueTasks();
    this.unsubscribeStore?.();
    this.unsubscribeStore = this.deps.store.onChange(() => this.scheduleNextTimer());
    this.scheduleNextTimer();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
  }

  async fireNow(taskId: string): Promise<{ ok: boolean; reason?: string }> {
    const task = this.deps.store.getTasks().find(t => t.id === taskId);
    if (!task) return { ok: false, reason: "task not found" };
    if (this.runningTaskIds.has(task.id)) return { ok: false, reason: "task already running" };
    await this.runOne(task, this.now(), true);
    return { ok: true };
  }

  private normalizeOverdueTasks(): void {
    const now = this.now();
    for (const task of this.deps.store.getTasks()) {
      if (!task.enabled || !task.nextFireAt) continue;
      const next = new Date(task.nextFireAt);
      if (Number.isNaN(next.getTime())) {
        this.deps.store.updateTask(task.id, { enabled: false, nextFireAt: null });
        continue;
      }
      if (next.getTime() > now.getTime()) continue;
      if (task.schedule.kind === "once") {
        this.deps.store.recordHistory({
          id: this.id(),
          taskId: task.id,
          taskTitle: task.title,
          firedAt: now.toISOString(),
          status: "skipped",
          reason: "missed while app was closed",
          effectiveToolIds: [],
        });
        this.deps.store.updateTask(task.id, { enabled: false, nextFireAt: null });
        continue;
      }
      const normalized = normalizeOverdueNextFireAt(task.schedule, next, now);
      this.deps.store.updateTask(task.id, { nextFireAt: normalized ? normalized.toISOString() : null });
    }
  }

  private scheduleNextTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();
    const nextTask = this.deps.store.getTasks()
      .filter(t => {
        if (!t.enabled || !t.nextFireAt) return false;
        return !Number.isNaN(new Date(t.nextFireAt).getTime());
      })
      .sort((a, b) => String(a.nextFireAt).localeCompare(String(b.nextFireAt)))[0];
    if (!nextTask?.nextFireAt) return;
    const delay = Math.max(0, new Date(nextTask.nextFireAt).getTime() - now.getTime());
    this.timer = setTimeout(() => void this.fireDueTasks(), Math.min(delay, MAX_TIMER_DELAY_MS));
  }

  private async fireDueTasks(): Promise<void> {
    const now = this.now();
    const due = this.deps.store.getTasks().filter(task => {
      if (!task.enabled || !task.nextFireAt) return false;
      return new Date(task.nextFireAt).getTime() <= now.getTime();
    });
    for (const task of due) {
      const scheduledFireAt = task.nextFireAt ? new Date(task.nextFireAt) : now;
      void this.runOne(task, scheduledFireAt, false);
      const rawNext = computeNextFireAtAfter(task.schedule, scheduledFireAt);
      const next = rawNext && rawNext.getTime() <= now.getTime()
        ? normalizeOverdueNextFireAt(task.schedule, rawNext, now)
        : rawNext;
      if (task.schedule.kind === "once") {
        this.deps.store.updateTask(task.id, { enabled: false, nextFireAt: null, lastFiredAt: scheduledFireAt.toISOString() });
      } else {
        this.deps.store.updateTask(task.id, { nextFireAt: next ? next.toISOString() : null, lastFiredAt: scheduledFireAt.toISOString() });
      }
    }
    this.scheduleNextTimer();
  }

  private async runOne(task: ScheduledTask, scheduledFireAt: Date, manual: boolean): Promise<void> {
    if (this.runningTaskIds.has(task.id)) {
      if (!manual) {
        this.deps.store.recordHistory({
          id: this.id(),
          taskId: task.id,
          taskTitle: task.title,
          firedAt: scheduledFireAt.toISOString(),
          status: "skipped",
          reason: "previous run still active",
          effectiveToolIds: [],
        });
      }
      return;
    }
    this.runningTaskIds.add(task.id);
    try {
      await this.deps.runTask(task, scheduledFireAt, manual);
    } finally {
      this.runningTaskIds.delete(task.id);
    }
  }
}
