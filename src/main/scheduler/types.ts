export type ScheduleKind = "once" | "daily" | "weekly" | "interval";

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
  /** 系統功能建立的任務來源；存在時由該功能管理，不應在通用編輯器修改。 */
  managedBy?: "daily-ritual";
  /** 每日陪伴儀式的時段識別。 */
  ritualId?: "morning" | "afternoon" | "evening";
  createdAt: string;
  updatedAt: string;
}

export interface NewScheduledTaskInput {
  title: string;
  prompt: string;
  enabled?: boolean;
  schedule: ScheduleConfig;
  toolMode?: SchedulerToolMode;
  allowedToolIds?: string[];
  managedBy?: "daily-ritual";
  ritualId?: "morning" | "afternoon" | "evening";
}

export type ScheduledTaskPatch = Partial<Pick<
  ScheduledTask,
  "title" | "prompt" | "enabled" | "schedule" | "nextFireAt" | "lastFiredAt" | "toolMode" | "allowedToolIds"
>>;

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

export interface ScheduledRunResult {
  ok: boolean;
  historyId: string;
  reply?: string;
  error?: string;
  effectiveToolIds: string[];
}

export interface SchedulerIpcResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
  reason?: string;
}
