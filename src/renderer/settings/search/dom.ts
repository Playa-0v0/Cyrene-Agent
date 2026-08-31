// Search 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const searchEnabledCheckbox = document.getElementById("plugin-search-enabled") as HTMLInputElement | null;
export const searchConfig = document.getElementById("plugin-search-config") as HTMLElement | null;
export const searchEngineSelect = document.getElementById("search-engine") as HTMLSelectElement | null;
export const searchBochaKeyInput = document.getElementById("search-bocha-key") as HTMLInputElement | null;
export const searchTavilyKeyInput = document.getElementById("search-tavily-key") as HTMLInputElement | null;
export const searchMinimaxKeyInput = document.getElementById("search-minimax-key") as HTMLInputElement | null;
export const searchAnySearchKeyInput = document.getElementById("search-anysearch-key") as HTMLInputElement | null;
export const searchBochaRow = document.getElementById("search-bocha-row");
export const searchTavilyRow = document.getElementById("search-tavily-row");
export const searchMinimaxRow = document.getElementById("search-minimax-row");
export const searchAnySearchRow = document.getElementById("search-anysearch-row");
