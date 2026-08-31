// Memory 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const memoryL0NameInput = document.getElementById("memory-l0-name") as HTMLInputElement | null;
export const memoryL0OccupationInput = document.getElementById("memory-l0-occupation") as HTMLInputElement | null;
export const memoryL0InterestsInput = document.getElementById("memory-l0-interests") as HTMLInputElement | null;
export const memoryL0LanguageInput = document.getElementById("memory-l0-language") as HTMLInputElement | null;
export const memoryL0NoteInput = document.getElementById("memory-l0-note") as HTMLTextAreaElement | null;
export const memoryL1GoalsInput = document.getElementById("memory-l1-goals") as HTMLTextAreaElement | null;
export const memoryL1PreferencesInput = document.getElementById("memory-l1-preferences") as HTMLTextAreaElement | null;
export const memoryL1ProjectInput = document.getElementById("memory-l1-project") as HTMLTextAreaElement | null;
export const memoryL2SearchInput = document.getElementById("memory-l2-search") as HTMLInputElement | null;
export const memoryL2List = document.getElementById("memory-l2-list") as HTMLElement | null;
export const memoryImportedList = document.getElementById("memory-imported-list") as HTMLElement | null;
export const memoryReflectionList = document.getElementById("memory-reflection-list") as HTMLElement | null;
export const memoryL0EditBtn = document.getElementById("memory-l0-edit-btn") as HTMLButtonElement | null;
export const memoryL0CancelBtn = document.getElementById("memory-l0-cancel-btn") as HTMLButtonElement | null;
export const memoryL1EditBtn = document.getElementById("memory-l1-edit-btn") as HTMLButtonElement | null;
export const memoryL1CancelBtn = document.getElementById("memory-l1-cancel-btn") as HTMLButtonElement | null;
export const obsidianVaultBindBtn = document.getElementById("obsidian-vault-bind-btn") as HTMLButtonElement | null;
export const obsidianVaultUnbound = document.getElementById("obsidian-vault-unbound") as HTMLElement | null;
export const obsidianVaultBound = document.getElementById("obsidian-vault-bound") as HTMLElement | null;
export const obsidianVaultPath = document.getElementById("obsidian-vault-path") as HTMLElement | null;
export const obsidianVaultSyncBtn = document.getElementById("obsidian-vault-sync-btn") as HTMLButtonElement | null;
export const obsidianVaultUnbindBtn = document.getElementById("obsidian-vault-unbind-btn") as HTMLButtonElement | null;
export const obsidianVaultAutoSync = document.getElementById("obsidian-vault-auto-sync") as HTMLInputElement | null;
export const obsidianVaultHint = document.getElementById("obsidian-vault-hint") as HTMLParagraphElement | null;
