// Scheduler 面板内部状态
// 从 settings.ts 顶层 let 抽离，收进单一对象。

import type { ScheduledTask, SchedulerToolInfo } from "./types";

export const schedulerState = {
  tasks: [] as ScheduledTask[],
  tools: [] as SchedulerToolInfo[],
  editingTaskId: null as string | null,
  /** 插件 id → 是否运行中；插件停用时其任务显示"等待插件启用"并禁用立即运行。 */
  pluginRunning: {} as Record<string, boolean>,
};
