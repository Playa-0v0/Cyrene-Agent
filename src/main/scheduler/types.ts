import type { PluginPromptMode } from "../../plugins/api";

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
  createdAt: string;
  updatedAt: string;
  /** 创建该任务的插件 id；缺失表示用户任务。插件任务的磁盘 enabled 永远为 false。 */
  ownerPluginId?: string;
  /** 插件任务的用户授权状态：用户在宿主界面确认后才允许运行，插件无法写入。 */
  pluginUserEnabled?: boolean;
  /** 插件任务冻结的会话模式；缺失时按 work 执行。 */
  mode?: PluginPromptMode;
  /** 用户确认执行规格时写入的 SHA-256 授权指纹；执行前必须重新计算并匹配。 */
  approvalFingerprint?: string;
}

export interface NewScheduledTaskInput {
  title: string;
  prompt: string;
  enabled?: boolean;
  schedule: ScheduleConfig;
  toolMode?: SchedulerToolMode;
  allowedToolIds?: string[];
  ownerPluginId?: string;
  pluginUserEnabled?: boolean;
  mode?: PluginPromptMode;
  approvalFingerprint?: string;
}

export type ScheduledTaskPatch = Partial<Pick<
  ScheduledTask,
  "title" | "prompt" | "enabled" | "schedule" | "nextFireAt" | "lastFiredAt" | "toolMode" | "allowedToolIds" | "pluginUserEnabled" | "approvalFingerprint" | "mode"
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
