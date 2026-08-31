// Scheduler 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const schedulerNewBtn = document.getElementById("scheduler-new-btn") as HTMLButtonElement | null;
export const schedulerEmpty = document.getElementById("scheduler-empty") as HTMLDivElement | null;
export const schedulerList = document.getElementById("scheduler-list") as HTMLDivElement | null;
export const schedulerEditor = document.getElementById("scheduler-editor") as HTMLDivElement | null;
export const schedulerEditorTitle = document.getElementById("scheduler-editor-title") as HTMLHeadingElement | null;
export const schedulerEditorClose = document.getElementById("scheduler-editor-close") as HTMLButtonElement | null;
export const schedulerTitleInput = document.getElementById("scheduler-title") as HTMLInputElement | null;
export const schedulerPromptInput = document.getElementById("scheduler-prompt") as HTMLTextAreaElement | null;
export const schedulerEnabledInput = document.getElementById("scheduler-enabled") as HTMLInputElement | null;
export const schedulerKindInput = document.getElementById("scheduler-kind") as HTMLSelectElement | null;
export const schedulerOnceRunAtInput = document.getElementById("scheduler-once-run-at") as HTMLInputElement | null;
export const schedulerTimeOfDayInput = document.getElementById("scheduler-time-of-day") as HTMLInputElement | null;
export const schedulerDayOfWeekInput = document.getElementById("scheduler-day-of-week") as HTMLSelectElement | null;
export const schedulerIntervalEveryInput = document.getElementById("scheduler-interval-every") as HTMLInputElement | null;
export const schedulerIntervalUnitInput = document.getElementById("scheduler-interval-unit") as HTMLSelectElement | null;
export const schedulerToolLimitInput = document.getElementById("scheduler-tool-limit") as HTMLInputElement | null;
export const schedulerToolPicker = document.getElementById("scheduler-tool-picker") as HTMLDivElement | null;
export const schedulerToolEmptyHint = document.getElementById("scheduler-tool-empty-hint") as HTMLDivElement | null;
export const schedulerSaveStatus = document.getElementById("scheduler-save-status") as HTMLDivElement | null;
export const schedulerCancelBtn = document.getElementById("scheduler-cancel-btn") as HTMLButtonElement | null;
export const schedulerSaveBtn = document.getElementById("scheduler-save-btn") as HTMLButtonElement | null;
