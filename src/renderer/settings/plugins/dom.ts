// Plugins 面板 DOM 引用（天气/出行/Playwright/权限等插件子区）
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const weatherEnabledCheckbox = document.getElementById("plugin-weather-enabled") as HTMLInputElement | null;
export const weatherConfig = document.getElementById("plugin-weather-config") as HTMLElement | null;
export const weatherSourceSelect = document.getElementById("weather-source") as HTMLSelectElement | null;
export const amapFields = document.getElementById("amap-fields");
export const amapKeyInput = document.getElementById("amap-key") as HTMLInputElement | null;
export const travelEnabledCheckbox = document.getElementById("plugin-travel-enabled") as HTMLInputElement | null;
export const travelConfig = document.getElementById("plugin-travel-config") as HTMLElement | null;
export const travelAmapKeyInput = document.getElementById("travel-amap-key") as HTMLInputElement | null;
export const playwrightMcpCheckbox = document.getElementById("plugin-playwright-mcp-enabled") as HTMLInputElement | null;
export const pluginAddBtn = document.querySelector(".plugin-add-btn") as HTMLButtonElement | null;
export const neteaseDetailView = document.getElementById("netease-detail-view");
export const permissionBlocksWrap = document.getElementById("plugin-file-permission") as HTMLElement | null;
export const permissionNote = document.getElementById("plugin-file-note") as HTMLElement | null;
