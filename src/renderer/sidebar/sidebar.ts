import "../ui/base.css";
import "./sidebar.css";
import "../ui/theme";

interface ModelConfig {
  mode: "auto" | "manual";
  provider: string;
  displayName?: string;
  shortName: string;
  model: string;
  connected: boolean;
  runtimeSync: "off" | "local" | "llm";
}

interface ModelConfigApi {
  get: () => Promise<ModelConfig>;
  onChanged: (callback: (config: ModelConfig) => void) => () => void;
}

type RuntimeStatus = "陪伴中" | "思考中" | "工作中" | "聆聽中" | "提醒中" | "離線";
type RuntimeFeeling = "平靜" | "開心" | "溫柔" | "激動" | "撒嬌" | "擔心" | "難過" | "感動" | "害羞";

interface RuntimeState {
  status: RuntimeStatus;
  feeling: RuntimeFeeling;
  expression: number;
}

interface RuntimeStateApi {
  get: () => Promise<RuntimeState>;
  onChanged: (callback: (state: RuntimeState) => void) => () => void;
}

interface SidebarApi {
  minimize: () => void;
  close: () => void;
  toggleAlwaysOnTop: () => Promise<boolean>;
  openTasks: () => void;
  openSettings: (section?: string) => void;
  openCall: () => void;
}

declare global {
  interface Window {
    sidebar?: SidebarApi;
    modelConfig?: ModelConfigApi;
    runtimeState?: RuntimeStateApi;
  }
}

// 沒有 preload 時給瀏覽器跑留個 no-op，方便 vite 單獨打開 sidebar 調試
if (!window.sidebar) {
  (window as unknown as { sidebar: SidebarApi }).sidebar = {
    minimize: () => {},
    close: () => {},
    toggleAlwaysOnTop: () => Promise.resolve(false),
    openTasks: () => {},
    openSettings: (_section?: string) => {},
    openCall: () => {},
  };
}

const root = document.querySelector(".sidebar") as HTMLElement | null;
const minBtn = document.getElementById("min-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const pinBtn = document.getElementById("pin-btn") as HTMLButtonElement;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const modelSwitchBtn = document.getElementById("model-switch-btn") as HTMLButtonElement;
const openChatBtn = document.getElementById("open-chat-btn") as HTMLButtonElement;
const callBtn = document.getElementById("call-btn") as HTMLButtonElement;
const onlineStatusLabel = document.getElementById("online-status-label") as HTMLElement;
const statusEmojiEl = document.getElementById("status-emoji") as HTMLElement;
const statusLabelEl = document.getElementById("status-label") as HTMLElement;
const feelingEmojiEl = document.getElementById("feeling-emoji") as HTMLElement;
const feelingLabelEl = document.getElementById("feeling-label") as HTMLElement;
const feedingModelEl = document.getElementById("feeding-model") as HTMLElement;
const onlineBadge = onlineStatusLabel.closest(".profile__online") as HTMLElement | null;
let runtimeSyncEnabled = false;
let latestRuntimeState: RuntimeState | null = null;

const STATUS_EMOJI: Record<RuntimeStatus, string> = {
  陪伴中: "🌸",
  思考中: "💭",
  工作中: "⚡",
  聆聽中: "🫧",
  提醒中: "🔔",
  離線: "💤",
};

const FEELING_EMOJI: Record<RuntimeFeeling, string> = {
  平靜: "🌿",
  開心: "✨",
  溫柔: "🌸",
  激動: "🎉",
  撒嬌: "🥺",
  擔心: "💙",
  難過: "💧",
  感動: "🥹",
  害羞: "🌹",
};

function applyRuntimeDisabled(): void {
  statusEmojiEl.textContent = "⚙️";
  statusLabelEl.textContent = "請到設置裡開啟";
  feelingEmojiEl.textContent = "⚙️";
  feelingLabelEl.textContent = "請到設置裡開啟";
}

function applyRuntimeState(state: RuntimeState | null): void {
  latestRuntimeState = state;
  if (!runtimeSyncEnabled) {
    applyRuntimeDisabled();
    return;
  }
  const status = state?.status ?? "陪伴中";
  const feeling = state?.feeling ?? "平靜";
  statusEmojiEl.textContent = STATUS_EMOJI[status] ?? "💬";
  statusLabelEl.textContent = status;
  feelingEmojiEl.textContent = FEELING_EMOJI[feeling] ?? "🌿";
  feelingLabelEl.textContent = feeling;
}

async function initRuntimeState(): Promise<void> {
  try {
    const state = await window.runtimeState?.get();
    applyRuntimeState(state ?? null);
  } catch {
    applyRuntimeState(null);
  }
  window.runtimeState?.onChanged((state) => applyRuntimeState(state));
}

function applyModelConfig(config: ModelConfig | null): void {
  const connected = Boolean(config?.connected);
  const wasRuntimeSyncEnabled = runtimeSyncEnabled;
  runtimeSyncEnabled = config?.runtimeSync === "local" || config?.runtimeSync === "llm";
  onlineStatusLabel.textContent = connected ? "在線" : "離線";
  onlineBadge?.classList.toggle("is-offline", !connected);
  // "正在餵養"顯示優先級：用戶暱稱 > 廠商短名 > model id > 兜底
  feedingModelEl.textContent = config?.displayName || config?.shortName || config?.model || "未選擇模型";
  if (!runtimeSyncEnabled) applyRuntimeDisabled();
  else if (!wasRuntimeSyncEnabled) applyRuntimeState(latestRuntimeState);
}

async function initModelConfig(): Promise<void> {
  try {
    const config = await window.modelConfig?.get();
    applyModelConfig(config ?? null);
  } catch {
    applyModelConfig(null);
  }
  window.modelConfig?.onChanged((config) => applyModelConfig(config));
}
// 置頂 toggle：點 📌 切換 alwaysOnTop，按鈕高亮態反映當前是否已置頂。
pinBtn.addEventListener("click", async () => {
  const pinned = await window.sidebar?.toggleAlwaysOnTop();
  const isPinned = Boolean(pinned);
  pinBtn.classList.toggle("is-active", isPinned);
  pinBtn.setAttribute("aria-label", isPinned ? "取消置頂" : "置頂");
  pinBtn.setAttribute("title", isPinned ? "取消置頂" : "置頂");
});

minBtn.addEventListener("click", () => {
  window.sidebar?.minimize();
});

closeBtn.addEventListener("click", () => {
  window.sidebar?.close();
});

settingsBtn.addEventListener("click", () => {
  window.sidebar?.openSettings();
});

modelSwitchBtn.addEventListener("click", () => {
  // "切換模型"直奔 API 配置標籤，而不是默認的通用標籤
  window.sidebar?.openSettings("api");
});

callBtn.addEventListener("click", () => {
  window.sidebar?.openCall();
});

// "打開聊天"：拿到最近一條會話 id，讓 main 打開聊天窗口並加載它；
// 沒有任何會話時先建一個再打開，保證點按鈕總能進到一個具體會話。
openChatBtn.addEventListener("click", async () => {
  const chatStore = (window as unknown as {
    chatStore?: {
      list: () => Promise<Array<{ id: string }>>;
      create: (payload?: { identityId?: string | null }) => Promise<{ id: string } | null>;
      openInChatWindow: (sessionId: string) => Promise<unknown>;
    };
  }).chatStore;
  if (!chatStore) return;
  try {
    const list = await chatStore.list();
    let latestId = list.length > 0 ? list[0].id : "";
    if (!latestId) {
      const created = await chatStore.create({ identityId: null });
      latestId = created?.id ?? "";
    }
    if (latestId) await chatStore.openInChatWindow(latestId);
  } catch (err) {
    console.warn("[sidebar] 打開聊天失敗:", err);
  }
});

void initModelConfig();
void initRuntimeState();
