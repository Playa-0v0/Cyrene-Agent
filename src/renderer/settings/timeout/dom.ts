// Timeout 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const timeoutUserChoiceInput = document.getElementById("timeout-user-choice") as HTMLInputElement;
export const timeoutUserChoiceReset = document.getElementById("timeout-user-choice-reset-btn") as HTMLButtonElement;
export const timeoutTestInput = document.getElementById("timeout-test") as HTMLInputElement;
export const timeoutTestReset = document.getElementById("timeout-test-reset-btn") as HTMLButtonElement;
export const maxParallelToolCallsInput = document.getElementById("max-parallel-tool-calls") as HTMLInputElement;
