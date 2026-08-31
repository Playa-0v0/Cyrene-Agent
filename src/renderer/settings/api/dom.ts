// API 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const apiForm = document.getElementById("api-form") as HTMLFormElement;
export const apiRuntimeForm = document.getElementById("api-runtime-form") as HTMLFormElement;
export const presetCards = document.getElementById("preset-cards") as HTMLElement;
export const profileList = document.getElementById("model-profile-list") as HTMLElement;
export const profileListCount = document.getElementById("profile-list-count") as HTMLElement;
export const profileEditorTitle = document.getElementById("profile-editor-title") as HTMLElement;
export const deleteProfileBtn = document.getElementById("delete-profile-btn") as HTMLButtonElement;
export const presetWebsiteLink = document.getElementById("preset-website-link") as HTMLAnchorElement;
export const displayNameInput = document.getElementById("display-name") as HTMLInputElement;
export const baseUrlInput = document.getElementById("base-url") as HTMLInputElement;
export const baseUrlResetBtn = document.getElementById("base-url-reset-btn") as HTMLButtonElement;
export const modelInput = document.getElementById("model-input") as HTMLInputElement;
export const modelInputSuggestions = document.getElementById("model-input-suggestions") as HTMLDataListElement;
export const contextWindowInput = document.getElementById("context-window-input") as HTMLInputElement;
export const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
export const apiKeyLabel = document.getElementById("api-key-label") as HTMLElement;
export const apiKeyHint = document.getElementById("api-key-hint") as HTMLElement;
export const testConnectionBtn = document.getElementById("test-connection-btn") as HTMLButtonElement | null;
// API 协议卡片组（transport-cards，复用 preset-card 视觉）：对外保持 <select> 的
// value/disabled/change 语义，settings.ts 的既有调用点（读值、程序赋值、change 监听）
// 无需感知 DOM 形态变化。
const transportRoot = document.getElementById("transport-select");
const transportButtons = Array.from(
  transportRoot?.querySelectorAll<HTMLButtonElement>("button[data-value]") ?? [],
);
let transportValue = transportButtons[0]?.dataset.value ?? "openai";
const transportChangeListeners = new Set<() => void>();

function renderTransportState(): void {
  for (const button of transportButtons) {
    const active = button.dataset.value === transportValue;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

for (const button of transportButtons) {
  button.addEventListener("click", () => {
    if (button.disabled || button.dataset.value === transportValue) return;
    transportValue = button.dataset.value ?? transportValue;
    renderTransportState();
    transportChangeListeners.forEach((listener) => listener());
  });
}
renderTransportState();

export const transportSelect = {
  get value(): string {
    return transportValue;
  },
  set value(next: string) {
    if (transportValue === next) return;
    transportValue = next;
    renderTransportState();
  },
  get disabled(): boolean {
    return transportButtons.length > 0 && transportButtons.every((button) => button.disabled);
  },
  set disabled(next: boolean) {
    for (const button of transportButtons) button.disabled = next;
  },
  addEventListener(type: "change", listener: () => void): void {
    if (type === "change") transportChangeListeners.add(listener);
  },
};
export const transportHint = document.getElementById("transport-hint") as HTMLElement;
export const endpointPreview = document.getElementById("endpoint-preview") as HTMLElement;
export const customEndpointControls = document.getElementById("custom-endpoint-controls") as HTMLElement;
export const customEndpointOverrides = document.getElementById("custom-endpoint-overrides") as HTMLElement;
export const customEndpointSummary = document.getElementById("custom-endpoint-summary") as HTMLElement;
export const customEndpointGuideBtn = document.getElementById("custom-endpoint-guide-btn") as HTMLButtonElement;
export const workFlowAdaptBtn = document.getElementById("work-flow-adapt-btn") as HTMLButtonElement | null;
export const apiNoteText = document.getElementById("api-note-text") as HTMLElement;
export const multimodalToggle = document.getElementById("multimodal-toggle") as HTMLInputElement;
export const embeddingDimensionsInput = document.getElementById("embedding-dimensions-input") as HTMLInputElement | null;
export const modelRequestTimeoutSecInput = document.getElementById("model-request-timeout-sec") as HTMLInputElement;
export const modelRequestTimeoutSecReset = document.getElementById("model-request-timeout-sec-reset-btn") as HTMLButtonElement;
export const toggleEnableThinking = document.getElementById("toggle-enable-thinking") as HTMLInputElement;
export const toggleDisableThinking = document.getElementById("toggle-disable-thinking") as HTMLInputElement;
export const toggleDisableMaxToken = document.getElementById("toggle-disable-max-token") as HTMLInputElement;
