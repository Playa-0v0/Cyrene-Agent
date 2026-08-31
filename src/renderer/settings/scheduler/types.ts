// Scheduler 面板类型定义
// 从 settings.ts 抽离的纯类型,无运行时依赖。

export type ScheduleConfig =
  | { kind: "once"; runAt: string }
  | { kind: "daily"; timeOfDay: string }
  | { kind: "weekly"; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; timeOfDay: string }
  | { kind: "interval"; every: number; unit: "minutes" | "hours" };

export type SchedulerToolMode = "all-enabled" | "allow-list";

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: ScheduleConfig;
  nextFireAt: string | null;
  lastFiredAt?: string;
  toolMode: SchedulerToolMode;
  allowedToolIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskHistoryEntry {
  id: string;
  taskId: string;
  taskTitle: string;
  firedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: "running" | "success" | "failed" | "skipped";
  reason?: string;
  outputPreview?: string;
  errorMessage?: string;
  effectiveToolIds: string[];
}

export interface SchedulerToolInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  risk: string;
}

export interface SchedulerResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  reason?: string;
}

export interface SchedulerApi {
  list: () => Promise<SchedulerResult<ScheduledTask[]>>;
  add: (input: unknown) => Promise<SchedulerResult<ScheduledTask>>;
  update: (id: string, patch: unknown) => Promise<SchedulerResult<ScheduledTask>>;
  delete: (id: string) => Promise<SchedulerResult<boolean>>;
  toggle: (id: string, enabled: boolean) => Promise<SchedulerResult<ScheduledTask>>;
  fireNow: (id: string) => Promise<SchedulerResult<boolean>>;
  getHistory: (taskId: string, limit?: number) => Promise<SchedulerResult<ScheduledTaskHistoryEntry[]>>;
  getTools: () => Promise<SchedulerResult<SchedulerToolInfo[]>>;
}
