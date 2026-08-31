// Music 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const musicHomeView = document.getElementById("music-home-view");
export const musicReturnBtn = document.getElementById("music-return-btn");
export const musicSearchForm = document.getElementById("music-search-form");
export const musicSearchHint = document.getElementById("music-search-hint");
export const musicQrStatus = document.getElementById("music-qr-status");
export const musicProfileAvatar = document.getElementById("music-profile-avatar") as HTMLImageElement | null;
export const musicLoginBtn = document.getElementById("music-login-btn") as HTMLButtonElement | null;
export const musicCancelBtn = document.createElement("button");
export const musicDisconnectBtn = document.createElement("button");
export const musicQrImg = document.getElementById("music-qr-img") as HTMLImageElement | null;
export const musicQrTip = document.getElementById("music-qr-tip");
export const musicQrBox = document.getElementById("music-qr") as HTMLElement | null;
export const musicFeedbackEl = document.getElementById("music-feedback");
export const musicAccountStatusText = document.getElementById("music-account-status-text");
export const musicSearchInput = document.getElementById("music-search-input") as HTMLInputElement | null;
export const musicSearchBtn = document.getElementById("music-search-btn") as HTMLButtonElement | null;
export const musicSearchResults = document.getElementById("music-search-results");
export const musicToggle = document.getElementById("plugin-music-toggle") as HTMLButtonElement | null;
export const musicAccordionCard = document.getElementById("plugin-music-card");
export const musicAccordionBody = document.getElementById("plugin-music-body");
// OpenAPI credential config form (appId + privateKey)
export const musicOpenapiCard = document.getElementById("music-openapi-card");
export const musicAppIdInput = document.getElementById("music-openapi-appid") as HTMLInputElement | null;
export const musicPrivateKeyInput = document.getElementById("music-openapi-private-key") as HTMLTextAreaElement | null;
export const musicSaveConfigBtn = document.getElementById("music-save-openapi-config") as HTMLButtonElement | null;
export const musicOpenPlayerBtn = document.getElementById("music-open-player-btn") as HTMLButtonElement | null;
