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

type RuntimeStatus = "陪伴中" | "思考中" | "工作中" | "聆听中" | "提醒中" | "离线";
type RuntimeFeeling = "平静" | "开心" | "温柔" | "激动" | "撒娇" | "担心" | "难过" | "感动" | "害羞";

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

// 没有 preload 时给浏览器跑留个 no-op，方便 vite 单独打开 sidebar 调试
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

const STATUS_ICON: Record<RuntimeStatus, string> = {
  陪伴中: "../status/陪伴中.png",
  思考中: "../status/思考中.png",
  工作中: "../status/工作中.png",
  聆听中: "../status/聆听中.png",
  提醒中: "../status/提醒.png",
  离线: "../status/离线.png",
};

const FEELING_ICON: Record<RuntimeFeeling, string> = {
  平静: "../feeling/平静.png",
  开心: "../feeling/开心.png",
  温柔: "../feeling/温柔.png",
  激动: "../feeling/激动.png",
  撒娇: "../feeling/撒娇.png",
  担心: "../feeling/担心.png",
  难过: "../feeling/难过.png",
  感动: "../feeling/感动.png",
  害羞: "../feeling/害羞.png",
};

function applyRuntimeDisabled(): void {
	  statusEmojiEl.innerHTML = '<svg width="22" height="22" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="display:block"><title>通用设置</title><path d="M18.2838 43.1713C14.9327 42.1736 11.9498 40.3213 9.58787 37.867C10.469 36.8227 11 35.4734 11 34.0001C11 30.6864 8.31371 28.0001 5 28.0001C4.79955 28.0001 4.60139 28.01 4.40599 28.0292C4.13979 26.7277 4 25.3803 4 24.0001C4 21.9095 4.32077 19.8938 4.91579 17.9995C4.94381 17.9999 4.97188 18.0001 5 18.0001C8.31371 18.0001 11 15.3138 11 12.0001C11 11.0488 10.7786 10.1493 10.3846 9.35011C12.6975 7.1995 15.5205 5.59002 18.6521 4.72314C19.6444 6.66819 21.6667 8.00013 24 8.00013C26.3333 8.00013 28.3556 6.66819 29.3479 4.72314C32.4795 5.59002 35.3025 7.1995 37.6154 9.35011C37.2214 10.1493 37 11.0488 37 12.0001C37 15.3138 39.6863 18.0001 43 18.0001C43.0281 18.0001 43.0562 17.9999 43.0842 17.9995C43.6792 19.8938 44 21.9095 44 24.0001C44 25.3803 43.8602 26.7277 43.594 28.0292C43.3986 28.01 43.2005 28.0001 43 28.0001C39.6863 28.0001 37 30.6864 37 34.0001C37 35.4734 37.531 36.8227 38.4121 37.867C36.0502 40.3213 33.0673 42.1736 29.7162 43.1713C28.9428 40.752 26.676 39.0001 24 39.0001C21.324 39.0001 19.0572 40.752 18.2838 43.1713Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 31C27.866 31 31 27.866 31 24C31 20.134 27.866 17 24 17C20.134 17 17 20.134 17 24C17 27.866 20.134 31 24 31Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>';
	  statusLabelEl.textContent = "请到设置里开启";
	  feelingEmojiEl.innerHTML = '<svg width="22" height="22" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="display:block"><title>通用设置</title><path d="M18.2838 43.1713C14.9327 42.1736 11.9498 40.3213 9.58787 37.867C10.469 36.8227 11 35.4734 11 34.0001C11 30.6864 8.31371 28.0001 5 28.0001C4.79955 28.0001 4.60139 28.01 4.40599 28.0292C4.13979 26.7277 4 25.3803 4 24.0001C4 21.9095 4.32077 19.8938 4.91579 17.9995C4.94381 17.9999 4.97188 18.0001 5 18.0001C8.31371 18.0001 11 15.3138 11 12.0001C11 11.0488 10.7786 10.1493 10.3846 9.35011C12.6975 7.1995 15.5205 5.59002 18.6521 4.72314C19.6444 6.66819 21.6667 8.00013 24 8.00013C26.3333 8.00013 28.3556 6.66819 29.3479 4.72314C32.4795 5.59002 35.3025 7.1995 37.6154 9.35011C37.2214 10.1493 37 11.0488 37 12.0001C37 15.3138 39.6863 18.0001 43 18.0001C43.0281 18.0001 43.0562 17.9999 43.0842 17.9995C43.6792 19.8938 44 21.9095 44 24.0001C44 25.3803 43.8602 26.7277 43.594 28.0292C43.3986 28.01 43.2005 28.0001 43 28.0001C39.6863 28.0001 37 30.6864 37 34.0001C37 35.4734 37.531 36.8227 38.4121 37.867C36.0502 40.3213 33.0673 42.1736 29.7162 43.1713C28.9428 40.752 26.676 39.0001 24 39.0001C21.324 39.0001 19.0572 40.752 18.2838 43.1713Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 31C27.866 31 31 27.866 31 24C31 20.134 27.866 17 24 17C20.134 17 17 20.134 17 24C17 27.866 20.134 31 24 31Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>';

  feelingLabelEl.textContent = "请到设置里开启";
}

function applyRuntimeState(state: RuntimeState | null): void {
  latestRuntimeState = state;
  if (!runtimeSyncEnabled) {
    applyRuntimeDisabled();
    return;
  }
  const status = state?.status ?? "陪伴中";
  const feeling = state?.feeling ?? "平静";
  const statusIcon = STATUS_ICON[status] ?? STATUS_ICON["陪伴中"];
  const feelingIcon = FEELING_ICON[feeling] ?? FEELING_ICON["平静"];
  statusEmojiEl.innerHTML = `<img src="${statusIcon}" alt="${status}" width="48" height="48" />`;
  statusLabelEl.textContent = status;
  feelingEmojiEl.innerHTML = `<img src="${feelingIcon}" alt="${feeling}" width="48" height="48" />`;
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
  onlineStatusLabel.textContent = connected ? "在线" : "离线";
  onlineBadge?.classList.toggle("is-offline", !connected);
  // "正在喂养"显示优先级：用户昵称 > 厂商短名 > model id > 兜底
  feedingModelEl.textContent = config?.displayName || config?.shortName || config?.model || "未选择模型";
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
// 置顶 toggle：点 📌 切换 alwaysOnTop，按钮高亮态反映当前是否已置顶。
pinBtn.addEventListener("click", async () => {
  const pinned = await window.sidebar?.toggleAlwaysOnTop();
  const isPinned = Boolean(pinned);
  pinBtn.classList.toggle("is-active", isPinned);
  pinBtn.setAttribute("aria-label", isPinned ? "取消置顶" : "置顶");
  pinBtn.setAttribute("title", isPinned ? "取消置顶" : "置顶");
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
  // "切换模型"直奔 API 配置标签，而不是默认的通用标签
  window.sidebar?.openSettings("api");
});

callBtn.addEventListener("click", () => {
  window.sidebar?.openCall();
});

// "打开聊天"：拿到最近一条会话 id，让 main 打开聊天窗口并加载它；
// 没有任何会话时先建一个再打开，保证点按钮总能进到一个具体会话。
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
    console.warn("[sidebar] 打开聊天失败:", err);
  }
});

void initModelConfig();
void initRuntimeState();
