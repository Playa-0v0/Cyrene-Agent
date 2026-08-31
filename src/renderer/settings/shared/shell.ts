// 窗口壳 / 导航 / 布局 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。
// 这些是设置页全局壳元素（窗口控制、导航标题、占位面板、各面板 form 容器等）。

export const minBtn = document.getElementById("min-btn") as HTMLButtonElement;
export const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
export const preferencesForm = document.getElementById("preferences-form") as HTMLFormElement;
export const sectionTitle = document.getElementById("section-title") as HTMLElement;
export const sectionHint = document.getElementById("section-hint") as HTMLElement;
export const placeholderPanel = document.getElementById("placeholder-panel") as HTMLElement;
export const cyrenePanel = document.getElementById("cyrene-panel") as HTMLFormElement;
export const disclaimerPanel = document.getElementById("disclaimer-panel") as HTMLElement;
export const pluginsPanel = document.getElementById("plugins-panel") as HTMLElement;
export const placeholderIcon = document.getElementById("placeholder-icon") as HTMLElement;
export const placeholderTitle = document.getElementById("placeholder-title") as HTMLElement;
export const placeholderCopy = document.getElementById("placeholder-copy") as HTMLElement;
export const saveStatus = document.getElementById("save-status") as HTMLElement;
export const runtimeSaveStatus = document.getElementById("runtime-save-status") as HTMLElement;
export const preferencesSaveStatus = document.getElementById("preferences-save-status") as HTMLElement;
export const cyreneSaveStatus = document.getElementById("cyrene-save-status") as HTMLElement;
export const openStickerManagerBtn = document.getElementById("open-sticker-manager-btn") as HTMLButtonElement;
export const addStickerBtn = document.getElementById("add-sticker-btn") as HTMLButtonElement;
