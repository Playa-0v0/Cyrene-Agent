// General 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const generalForm = document.getElementById("general-form") as HTMLFormElement;
export const generalSaveStatus = document.getElementById("general-save-status") as HTMLElement;
export const languageSelect = document.getElementById("language-select") as HTMLElement;
export const defaultChatModeSelect = document.getElementById("default-chat-mode-select") as HTMLElement;
export const segmentedOutputSelect = document.getElementById("segmented-output-select") as HTMLElement;
export const mobileMessageSegmentationSelect = document.getElementById("mobile-message-segmentation-select") as HTMLElement;
export const proactiveChatSelect = document.getElementById("proactive-chat-select") as HTMLElement;
export const proactiveDeliveryRow = document.getElementById("proactive-delivery-row") as HTMLElement;
export const proactiveDeliverySelect = document.getElementById("proactive-delivery-select") as HTMLElement;
export const chatSocialContextEnabledInput = document.getElementById("chat-social-context-enabled") as HTMLInputElement;
export const citaEnabledInput = document.getElementById("cita-enabled") as HTMLInputElement;
export const citaEngineSelect = document.getElementById("cita-engine-select") as HTMLElement;
export const clearChatHistoryBtn = document.getElementById("clear-chat-history-btn") as HTMLButtonElement;
export const customStyleSamplingBtn = document.getElementById("custom-style-sampling-btn") as HTMLButtonElement | null;
export const customStylePromptBtn = document.getElementById("custom-style-prompt-btn") as HTMLButtonElement | null;
