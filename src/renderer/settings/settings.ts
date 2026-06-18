import "../ui/base.css";
import "./settings.css";

// Inline modal (to avoid Vite tree-shaking)
let _cyModalOverlay: HTMLElement | null = null;
function _initModalOverlay(): void {
  if (_cyModalOverlay) return;
  _cyModalOverlay = document.createElement("div");
  _cyModalOverlay.id = "cy-modal-overlay";
  _cyModalOverlay.className = "cy-modal-overlay is-hidden";
  _cyModalOverlay.innerHTML = [
    '<div class="cy-modal" role="alertdialog" aria-modal="true">',
    '  <div class="cy-modal__head">',
    '    <span class="cy-modal__icon" id="cy-modal-icon">📌</span>',
    '    <h3 class="cy-modal__title" id="cy-modal-title">提示</h3>',
    '  </div>',
    '  <hr class="cy-modal__divider">',
    '  <p class="cy-modal__body" id="cy-modal-message">确认执行此操作吗？</p>',
    '  <div class="cy-modal__actions">',
    '    <button type="button" class="ghost-btn" id="cy-modal-cancel">取消</button>',
    '    <button type="button" class="btn-primary" id="cy-modal-confirm">确定</button>',
    '  </div>',
    '</div>',
  ].join("\n");
  document.body.appendChild(_cyModalOverlay);
}

function showModal (options: { title: string; message: string; icon?: string; confirmText?: string; cancelText?: string }): Promise<boolean> {
  _initModalOverlay();
  if (!_cyModalOverlay) return Promise.resolve(false);
  var iconEl = _cyModalOverlay.querySelector("#cy-modal-icon") as HTMLElement;
  var titleEl = _cyModalOverlay.querySelector("#cy-modal-title") as HTMLElement;
  var msgEl = _cyModalOverlay.querySelector("#cy-modal-message") as HTMLElement;
  var cancelBtn = _cyModalOverlay.querySelector("#cy-modal-cancel") as HTMLButtonElement;
  var confirmBtn = _cyModalOverlay.querySelector("#cy-modal-confirm") as HTMLButtonElement;
  iconEl.textContent = options.icon || "📌";
  titleEl.textContent = options.title;
  msgEl.textContent = options.message;
  cancelBtn.textContent = options.cancelText || "取消";
  confirmBtn.textContent = options.confirmText || "确定";
  _cyModalOverlay.classList.remove("is-hidden");
  return new Promise(function (resolve) {
    var cleanup = function (result: boolean) {
      _cyModalOverlay?.classList.add("is-hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      resolve(result);
    };
    var onCancel = function () { cleanup(false); };
    var onConfirm = function () { cleanup(true); };
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}

// Inline input modal (Electron 禁用了 window.prompt，所以自己实现)
let _cyInputOverlay: HTMLElement | null = null;
function _initInputOverlay(): void {
  if (_cyInputOverlay) return;
  _cyInputOverlay = document.createElement("div");
  _cyInputOverlay.id = "cy-input-overlay";
  _cyInputOverlay.className = "cy-modal-overlay is-hidden";
  _cyInputOverlay.innerHTML = [
    '<div class="cy-modal" role="dialog" aria-modal="true" style="width:min(420px,90vw);">',
    '  <div class="cy-modal__head">',
    '    <span class="cy-modal__icon" id="cy-input-icon">✏️</span>',
    '    <h3 class="cy-modal__title" id="cy-input-title">请输入</h3>',
    '  </div>',
    '  <hr class="cy-modal__divider">',
    '  <p class="cy-modal__body" id="cy-input-message"></p>',
    '  <input type="text" id="cy-input-field" autocomplete="off" spellcheck="false"',
    '    style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(0,0,0,0.32);color:var(--rb-text-strong,#fff);font-family:inherit;font-size:13px;outline:none;margin-bottom:12px;" />',
    '  <div class="cy-modal__actions">',
    '    <button type="button" class="ghost-btn" id="cy-input-cancel">取消</button>',
    '    <button type="button" class="btn-primary" id="cy-input-confirm">确定</button>',
    '  </div>',
    '</div>',
  ].join("\n");
  document.body.appendChild(_cyInputOverlay);
}

function showInputModal(options: {
  title: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<string | null> {
  _initInputOverlay();
  if (!_cyInputOverlay) return Promise.resolve(null);
  const iconEl = _cyInputOverlay.querySelector("#cy-input-icon") as HTMLElement;
  const titleEl = _cyInputOverlay.querySelector("#cy-input-title") as HTMLElement;
  const msgEl = _cyInputOverlay.querySelector("#cy-input-message") as HTMLElement;
  const inputEl = _cyInputOverlay.querySelector("#cy-input-field") as HTMLInputElement;
  const cancelBtn = _cyInputOverlay.querySelector("#cy-input-cancel") as HTMLButtonElement;
  const confirmBtn = _cyInputOverlay.querySelector("#cy-input-confirm") as HTMLButtonElement;
  iconEl.textContent = options.icon || "✏️";
  titleEl.textContent = options.title;
  msgEl.textContent = options.message;
  inputEl.value = options.defaultValue || "";
  inputEl.placeholder = options.placeholder || "";
  cancelBtn.textContent = options.cancelText || "取消";
  confirmBtn.textContent = options.confirmText || "确定";
  _cyInputOverlay.classList.remove("is-hidden");
  setTimeout(() => inputEl.focus(), 30);
  return new Promise((resolve) => {
    const cleanup = (result: string | null) => {
      _cyInputOverlay?.classList.add("is-hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      inputEl.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onCancel = () => cleanup(null);
    const onConfirm = () => cleanup(inputEl.value);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    inputEl.addEventListener("keydown", onKey);
  });
}


interface ProviderProfile {
  baseUrl: string;
  model: string;
  apiKey: string;
}

interface ModelSettings {
  mode: "auto" | "manual";
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  // 按厂商缓存：切回该厂商时，从这里恢复 baseUrl / model / apiKey
  perProvider?: Record<string, ProviderProfile>;
  runtimeSync: "off" | "local" | "llm";
  stickerEnabled: boolean;
  stickerSize: "small" | "standard" | "large";
  vision?: {
    syncWithMain: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

interface ModelPreset {
  providerName: string;
  baseUrl: string;
  mainModels: string[];
  iconUrl: string;
  // 视觉模型的 OpenAI 兼容 baseUrl。仅当主配走 Anthropic 入口、视觉要走 OpenAI 入口时才标
  // （如 MiniMax 主配 /anthropic，视觉走 /v1）。勾选"同步主模型"时 UI 用它填视觉框。
  visionBaseUrl?: string;
  // 标记为 true 时，该项在 <select> 里显示但不可选；
  // 用于"已列出但 vendor adapter 还没接好"的情况，避免用户选到后调用直接报错。
  disabled?: boolean;
}

interface GeneralSettings {
  musicEnabled: boolean;
  musicVolume: number;
  soundEnabled: boolean;
  soundVolume: number;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  launchAtLogin: boolean;
  language: "zh-CN";
}

interface UserApi {
  getProfile: () => Promise<{ nickname: string; callPreference: string; birthday: string; timezone: string; avatarPath: string }>;
  saveProfile: (profile: Record<string, unknown>) => Promise<unknown>;
  uploadAvatar: () => Promise<{ avatarPath: string } | null>;
  getAvatar: () => Promise<string | null>;
}

interface MemoryPanelPayload {
  l0: {
    preferredName: string;
    occupation: string;
    longTermInterests: string;
    language: string;
    permanentNote: string;
  };
  l1: {
    recentGoals: string;
    recentPreferences: string;
    currentProject: string;
  };
  l2: Array<{
    id: string;
    content: string;
    triggerText: string;
    status: "active" | "aging" | "archived";
    weight: number;
    createdAt: number;
  }>;
  importedDocs: Array<{
    importId: string | null;
    fileName: string;
    chunkCount: number;
    lastImportedAt: number;
  }>;
  reflections: Array<{
    id: string;
    title: string;
    body: string;
    meta: string;
  }>;
}

interface MemoryPanelApi {
  getData: () => Promise<MemoryPanelPayload>;
  deleteImportedDoc: (importId: string, fileName?: string) => Promise<{ ok: boolean; deleted: number }>;
  saveL0: (patch: Record<string, unknown>) => Promise<{ ok: boolean }>;
  saveL1: (patch: Record<string, unknown>) => Promise<{ ok: boolean }>;
}

interface SettingsApi {
  minimize: () => void;
  close: () => void;
  getConfig: () => Promise<ModelSettings>;
  saveConfig: (config: Partial<ModelSettings>) => Promise<ModelSettings>;
  getGeneral: () => Promise<GeneralSettings>;
  saveGeneral: (config: Partial<GeneralSettings>) => Promise<GeneralSettings>;
  openSidebar: () => void;
  closeSidebar: () => void;
  openTasks: () => void;
  closeTasks: () => void;
  setPetAlwaysOnTop: (value: boolean) => void;
  setPetVisible: (value: boolean) => void;
  previewRuntimeSync: (value: "off" | "local" | "llm") => void;
  openStickerManager: () => Promise<{ ok: boolean; error?: string }>;
  getEmbeddingStatus?: () => Promise<Record<string, { installed: boolean; sizeBytes: number }>>;
  downloadEmbeddingModel?: (model: string, mirror: string) => Promise<{ ok: boolean; error?: string }>;
  deleteEmbeddingModel?: (model: string) => Promise<{ ok: boolean; error?: string }>;
  embeddingSetModel?: (model: string) => Promise<{ ok: boolean; clearedEntries?: number; error?: string }>;
  rerankerSetMode?: (mode: string) => Promise<boolean>;
  setToolEnabled?: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  getToolEnabled?: () => Promise<Record<string, boolean>>;
  addMcpServer?: (config: unknown) => Promise<{ ok: boolean; toolIds?: string[]; error?: string }>;
  removeMcpServer?: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
  listMcpServers?: () => Promise<Array<{ id: string; name: string; connected: boolean; toolCount: number; toolIds: string[] }>>;
  getPermissionLevel?: () => Promise<{ level: "read-only" | "scoped" | "per-action" | "full" }>;
  setPermissionLevel?: (level: string) => Promise<{ ok: boolean; level?: string; error?: string }>;
  testConnection?: (config: { provider: string; baseUrl: string; model: string; apiKey: string }) => Promise<{ ok: boolean; latency: number; sample?: string; error?: string }>;
  testVision?: (config: { baseUrl: string; apiKey: string; model: string }) => Promise<{ ok: boolean; latency: number; sample?: string; error?: string }>;
}

declare global {
  interface Window {
    settings?: SettingsApi;
    user?: UserApi;
    memoryPanel?: MemoryPanelApi;
  }
}

const MODEL_PRESETS: ModelPreset[] = [
  // 当前 v1 计划适配的 7 家：MiniMax / 火山 Agent-Plan / 智谱 GLM / Kimi / Qwen / ChatGPT / Claude
  // 顺序按使用频率 + 适配优先级；未在此清单内的厂商已硬删，需要时再补回。
  {
    providerName: "MiniMax（稀宇科技）",
    baseUrl: "https://api.minimaxi.com/anthropic",
    mainModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/minimax.svg",
    // 主配走 /anthropic，但视觉要走 OpenAI 入口 /v1。勾"同步"时 UI 自动用这个，用户不用手改。
    visionBaseUrl: "https://api.minimaxi.com/v1",
  },
  {
    // DeepSeek：v1 vendor adapter 不为它做协议层强制，仅作为 OpenAI 兼容厂商列出。
    // 已确认（来自官方定价文档）：支持 Tool Calls / JSON Output；后端原生缓存（命中后输入价跌至 1/50~1/120）。
    // 缓存能力等 v2 vendor adapter 接入时再利用，v1 不动。
    providerName: "DeepSeek（深度求索）",
    baseUrl: "https://api.deepseek.com",
    mainModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/deepseek.svg",
  },
  {
    providerName: "火山 AgentPlan（火山引擎）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    mainModels: ["ark-code-latest"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/doubao.svg",
  },
  {
    providerName: "GLM（智谱）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    mainModels: ["glm-5.1", "glm-5-turbo", "glm-4.7"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/zhipu.svg",
  },
  {
    providerName: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    mainModels: ["kimi-k2.6", "kimi-k2.5", "kimi-k2-thinking"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/moonshot.svg",
  },
  {
    providerName: "Qwen（通义千问）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    mainModels: ["qwen-max", "qwen-plus", "qwen-turbo"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/qwen.svg",
  },
  {
    providerName: "ChatGPT（OpenAI）",
    baseUrl: "https://api.openai.com/v1",
    // 国内多数用户走中转站，型号命名各家不一；预设留空，由用户在型号输入框里自行填写。
    mainModels: [],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openai.svg",
  },
  {
    providerName: "Claude（Anthropic）",
    baseUrl: "https://api.anthropic.com/v1",
    // 同上，且 Anthropic 协议尚未接入，暂禁选。
    mainModels: [],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/claude.svg",
    // Anthropic 的请求体不是 OpenAI 兼容格式（messages / system / 流式都不一样），
    // 在专属 vendor adapter 接好之前先 disabled，避免用户选到后调用直接报 4xx。
    disabled: true,
  },
];

if (!window.settings) {
  (window as unknown as { settings: SettingsApi }).settings = {
    minimize: () => {},
    close: () => {},
    getConfig: () =>
      Promise.resolve({
        mode: "auto",
        provider: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        apiKey: "",
        runtimeSync: "off",
        stickerEnabled: true,
        stickerSize: "standard",
      }),
    saveConfig: (c) => Promise.resolve(c as ModelSettings),
    getGeneral: () => Promise.resolve({ musicEnabled: false, musicVolume: 60, soundEnabled: true, soundVolume: 70, petAlwaysOnTop: true, petVisible: true, launchAtLogin: false, language: "zh-CN" }),
    saveGeneral: (c) => Promise.resolve(c as GeneralSettings),
    openSidebar: () => {},
    closeSidebar: () => {},
    openTasks: () => {},
    closeTasks: () => {},
    setPetAlwaysOnTop: () => {},
    setPetVisible: () => {},
    openStickerManager: async () => ({ ok: false, error: "settings api unavailable" }),
    setToolEnabled: async () => ({ ok: false, error: "settings api unavailable" }),
    getToolEnabled: async () => ({}),
    addMcpServer: async () => ({ ok: false, error: "settings api unavailable" }),
    removeMcpServer: async () => ({ ok: false, error: "settings api unavailable" }),
    listMcpServers: async () => [],
  };
}

const minBtn = document.getElementById("min-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const clickSound = new Audio("/audio/click.mp3");
clickSound.preload = "auto";

const bgmAudio = new Audio("/audio/bgm.mp3");
bgmAudio.preload = "auto";
bgmAudio.loop = true;
const apiForm = document.getElementById("api-form") as HTMLFormElement;
const generalForm = document.getElementById("general-form") as HTMLFormElement;
const sectionTitle = document.getElementById("section-title") as HTMLElement;
const sectionHint = document.getElementById("section-hint") as HTMLElement;
const placeholderPanel = document.getElementById("placeholder-panel") as HTMLElement;
const cyrenePanel = document.getElementById("cyrene-panel") as HTMLFormElement;
const disclaimerPanel = document.getElementById("disclaimer-panel") as HTMLElement;
const pluginsPanel = document.getElementById("plugins-panel") as HTMLElement;
const placeholderIcon = document.getElementById("placeholder-icon") as HTMLElement;
const placeholderTitle = document.getElementById("placeholder-title") as HTMLElement;
const placeholderCopy = document.getElementById("placeholder-copy") as HTMLElement;
const saveStatus = document.getElementById("save-status") as HTMLElement;
const generalSaveStatus = document.getElementById("general-save-status") as HTMLElement;
const cyreneSaveStatus = document.getElementById("cyrene-save-status") as HTMLElement;

const presetSelect = document.getElementById("preset-select") as HTMLSelectElement;
const modeSelect = document.getElementById("mode") as HTMLSelectElement;
const providerInput = document.getElementById("provider") as HTMLInputElement;
const baseUrlInput = document.getElementById("base-url") as HTMLInputElement;
// 模型名两套控件：Auto 模式显示 modelSelect（预设下拉），Manual 模式显示 modelInput（自由输入 + datalist 联想）
const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
const modelInput = document.getElementById("model-input") as HTMLInputElement;
const modelInputSuggestions = document.getElementById("model-input-suggestions") as HTMLDataListElement;
const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
const testConnectionBtn = document.getElementById("test-connection-btn") as HTMLButtonElement | null;

// 视觉模型配置区元素
const visionSyncCheckbox = document.getElementById("vision-sync-main") as HTMLInputElement;
const visionBaseUrlInput = document.getElementById("vision-base-url") as HTMLInputElement;
const visionApiKeyInput = document.getElementById("vision-api-key") as HTMLInputElement;
const visionModelInput = document.getElementById("vision-model") as HTMLInputElement;
const visionFieldsWrap = document.querySelector(".vision-fields") as HTMLElement;
const testVisionBtn = document.getElementById("test-vision-btn") as HTMLButtonElement;
const visionTestStatus = document.getElementById("vision-test-status") as HTMLElement;

// 渲染端内存缓存：保存每个厂商上一次填写的 baseUrl / model / apiKey
// 切厂商时从这里读，保存时同步进去；持久化由 main 进程的 saveModelSettings 负责（perProvider 字段）。
const providerProfileCache: Record<string, ProviderProfile> = {};

// 当前激活的厂商：每次 applyPreset 后更新；用于"切到下一家厂商前先把当前那家的输入框值缓存住"
let activeProvider: string = "";
const runtimeSyncSelect = document.getElementById("runtime-sync") as HTMLElement;
const runtimeSyncNote = document.getElementById("runtime-sync-note") as HTMLElement;
const stickerEnabledInput = document.getElementById("sticker-enabled") as HTMLInputElement;
const stickerSizeSelect = document.getElementById("sticker-size") as HTMLElement;
const musicEnabledInput = document.getElementById("music-enabled") as HTMLInputElement;
const musicVolumeInput = document.getElementById("music-volume") as HTMLInputElement;
const soundEnabledInput = document.getElementById("sound-enabled") as HTMLInputElement;
const soundVolumeInput = document.getElementById("sound-volume") as HTMLInputElement;
const petAlwaysOnTopInput = document.getElementById("pet-always-on-top") as HTMLInputElement;
const petVisibleInput = document.getElementById("pet-visible") as HTMLInputElement;
const launchAtLoginInput = document.getElementById("launch-at-login") as HTMLInputElement;
const languageSelect = document.getElementById("language-select") as HTMLElement;
const sidebarVisibleInput = document.getElementById("sidebar-visible") as HTMLInputElement;
const tasksVisibleInput = document.getElementById("tasks-visible") as HTMLInputElement;
const clearChatHistoryBtn = document.getElementById("clear-chat-history-btn") as HTMLButtonElement;
const openStickerManagerBtn = document.getElementById("open-sticker-manager-btn") as HTMLButtonElement;

const NAV_LABELS: Record<string, { emoji: string; title: string; hint: string }> = {
  memory: { emoji: "🧠", title: "记忆", hint: "管理长期记忆与画像" },
  gallery: { emoji: "🖼️", title: "图库", hint: "管理角色表情与素材" },
  user: { emoji: "👤", title: "用户信息", hint: "编辑你的个人资料" },
  tasks: { emoji: "⏰", title: "定时任务", hint: "管理定时提醒与日程" },
  skills: { emoji: "✨", title: "技能 Skill", hint: "管理昔涟的能力插件" },
  plugins: { emoji: "🔌", title: "插件", hint: "扩展功能与第三方集成" },
  general: { emoji: "⚙️", title: "设置", hint: "通用偏好与外观" },
  api: { emoji: "🔑", title: "API 设置", hint: "选择预设后只需要填写 API Key。" },
  cyrene: { emoji: "🌸", title: "昔涟设置", hint: "管理 Agent 行为、记忆、RAG 与权限" },
  tts: { emoji: "🎙️", title: "TTS 设置", hint: "语音合成与朗读偏好" },
  tokens: { emoji: "📊", title: "Token 用量", hint: "查看 API 调用统计与消耗" },
  disclaimer: { emoji: "📜", title: "免责声明", hint: "使用条款与隐私说明" },
};

minBtn.addEventListener("click", () => window.settings?.minimize());
closeBtn.addEventListener("click", () => window.settings?.close());

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (target.closest("button, input, select, .switch, .option-block, .language-option, .nav-item")) {
    playSettingsClickSound();
  }
}, true);

function setSaveStatus(text: string, cls?: string): void {
  saveStatus.textContent = text;
  saveStatus.className = "save-status";
  if (cls) saveStatus.classList.add(cls);
}

function setCyreneSaveStatus(text: string, cls?: string): void {
  cyreneSaveStatus.textContent = text;
  cyreneSaveStatus.className = "save-status";
  if (cls) cyreneSaveStatus.classList.add(cls);
}

function playSettingsClickSound(): void {
  if (!soundEnabledInput.checked) return;
  clickSound.pause();
  clickSound.currentTime = 0;
  clickSound.volume = Math.max(0, Math.min(1, Number(soundVolumeInput.value) / 100));
  void clickSound.play().catch(() => {});
}

function syncMusicPlayback(): void {
  bgmAudio.volume = Math.max(0, Math.min(1, Number(musicVolumeInput.value) / 100));
  if (musicEnabledInput.checked) {
    void bgmAudio.play().catch(() => {});
  } else {
    bgmAudio.pause();
  }
}

function getRuntimeSyncValue(): "off" | "local" | "llm" {
  const v = runtimeSyncSelect.querySelector<HTMLButtonElement>(".option-block.is-active")?.dataset.value; return v === "llm" ? "llm" : v === "local" ? "local" : "off";
}

function applyRuntimeSyncSelection(value: "off" | "local" | "llm"): void {
  runtimeSyncSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const active = button.dataset.value === value;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  syncRuntimeNote();
}

function syncRuntimeNote(): void {
  runtimeSyncNote.classList.toggle("is-hidden", getRuntimeSyncValue() !== "llm");
}

function getStickerSizeValue(): "small" | "standard" | "large" {
  const value = stickerSizeSelect.querySelector<HTMLButtonElement>(".option-block.is-active")?.dataset.value;
  return value === "small" || value === "large" ? value : "standard";
}

function applyStickerSizeSelection(value: "small" | "standard" | "large"): void {
  stickerSizeSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const active = button.dataset.value === value;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function applyLanguageSelection(language: "zh-CN"): void {
  languageSelect.querySelectorAll<HTMLButtonElement>(".language-option").forEach((button) => {
    const active = button.dataset.lang === language;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setGeneralSaveStatus(text: string, cls?: string): void {
  generalSaveStatus.textContent = text;
  generalSaveStatus.className = "save-status";
  if (cls) generalSaveStatus.classList.add(cls);
}

function fillPresetOptions(): void {
  presetSelect.replaceChildren();
  for (const preset of MODEL_PRESETS) {
    const option = document.createElement("option");
    option.value = preset.providerName;
    if (preset.disabled) {
      option.textContent = preset.providerName + "（暂未适配）";
      option.disabled = true;
    } else {
      option.textContent = preset.providerName;
    }
    presetSelect.appendChild(option);
  }
}

function findPreset(providerName: string): ModelPreset {
  // fallback：找不到匹配的预设时，回退到列表第一个可用项（当前是 MiniMax）。
  // 不直接返回 MODEL_PRESETS[0] 是为了未来若把首项改成 disabled 也仍然合法。
  const fallback = MODEL_PRESETS.find((preset) => !preset.disabled) ?? MODEL_PRESETS[0];
  return MODEL_PRESETS.find((preset) => preset.providerName === providerName) ?? fallback;
}

/**
 * Auto 模式：modelSelect 渲染 preset.mainModels；
 * Manual 模式：modelInput 配套的 datalist 也用相同清单做联想。
 * 两个控件 value 同时设置，模式切换时不需要重算。
 */
function fillModelOptions(preset: ModelPreset, preferredModel?: string): void {
  // 1) Auto 下拉
  modelSelect.replaceChildren();
  for (const model of preset.mainModels) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    modelSelect.appendChild(option);
  }
  // 2) Manual 输入联想（datalist）
  modelInputSuggestions.replaceChildren();
  for (const model of preset.mainModels) {
    const option = document.createElement("option");
    option.value = model;
    modelInputSuggestions.appendChild(option);
  }

  // 选中值：preferredModel 命中则用之；否则 select 退到首项 / input 退到空串
  const valueForSelect = preset.mainModels.includes(preferredModel ?? "")
    ? preferredModel!
    : (preset.mainModels[0] ?? "");
  modelSelect.value = valueForSelect;
  // input 比 select 更宽容：如果 preferredModel 存在但不在 mainModels 里（厂商更新过型号 / 用户自填型号），
  // 也保留显示，不强行清空。
  modelInput.value = preferredModel ?? valueForSelect;
}

/**
 * 把"当前输入框里的值"快照到内存缓存里（perProvider）。
 * 切厂商前调用一次，避免覆盖丢失。
 */
function captureActiveProviderProfile(): void {
  if (!activeProvider) return;
  providerProfileCache[activeProvider] = {
    baseUrl: baseUrlInput.value.trim(),
    model: getCurrentModelValue().trim(),
    apiKey: apiKeyInput.value.trim(),
  };
}

/**
 * 根据当前 mode，从对应控件读取模型名。
 * - auto: modelSelect.value
 * - manual: modelInput.value
 */
function getCurrentModelValue(): string {
  return modeSelect.value === "manual" ? modelInput.value : modelSelect.value;
}

/**
 * 应用 mode 的视觉切换：
 * - auto   → 显示 modelSelect，隐藏 modelInput；baseUrl 锁定（厂商默认）
 * - manual → 显示 modelInput，隐藏 modelSelect；baseUrl 可改（中转站等）
 */
function applyModeUI(): void {
  const isManual = modeSelect.value === "manual";
  modelSelect.hidden = isManual;
  modelInput.hidden = !isManual;
  // Auto 模式：baseUrl 锁死为厂商默认（用户自由切厂商即可），避免误触；
  // Manual 模式：baseUrl 可改（用户填中转站 URL）。
  baseUrlInput.readOnly = !isManual;
  // 切到 manual 时把 select 当前值同步给 input（避免 mode 切换后值消失）
  if (isManual && !modelInput.value) modelInput.value = modelSelect.value;
  // 切到 auto 时如果 input 值在 select 选项里，回填 select；否则保留为首项
  if (!isManual && modelInput.value) {
    const exists = Array.from(modelSelect.options).some((opt) => opt.value === modelInput.value);
    if (exists) modelSelect.value = modelInput.value;
  }
}

/**
 * 视觉同步 UI：勾选"与主聊天模型相同"时，三框变只读 + 值随主配置。
 * 主配置改了它跟着改（通过事件监听联动）。
 * baseUrl 特殊处理：若当前厂商标了 visionBaseUrl（主配走 Anthropic 入口、视觉要走 OpenAI 入口），
 * 用 visionBaseUrl 填视觉框，让用户看到的就是正确的视觉入口，不用手动改。
 */
function applyVisionSyncUI(): void {
  const synced = visionSyncCheckbox.checked;
  if (synced) {
    visionFieldsWrap.classList.add("is-locked");
    // 找当前厂商 preset，看有没有 visionBaseUrl
    const preset = findPreset(providerInput.value);
    const visionBaseUrl = preset?.visionBaseUrl || baseUrlInput.value;
    visionBaseUrlInput.value = visionBaseUrl;
    visionApiKeyInput.value = apiKeyInput.value;
    visionModelInput.value = getCurrentModelValue();
  } else {
    visionFieldsWrap.classList.remove("is-locked");
  }
}

function applyPreset(providerName: string, preferredModel?: string, preferredApiKey?: string, preferredBaseUrl?: string): void {
  const preset = findPreset(providerName);

  // ChatGPT / Claude 这类没有 mainModels 预设的厂商（国内大多走中转站），强制切到 Manual 模式。
  // 用户在 Manual 下自由填型号名 + baseUrl，比 Auto 模式空下拉更合适。
  if (preset.mainModels.length === 0 && modeSelect.value !== "manual") {
    modeSelect.value = "manual";
    applyModeUI();
  }

  presetSelect.value = preset.providerName;
  providerInput.value = preset.providerName;

  // baseUrl：优先用缓存（用户自定义过），其次用 preset 默认
  baseUrlInput.value = preferredBaseUrl ?? preset.baseUrl;

  fillModelOptions(preset, preferredModel);

  // apiKey：优先用缓存；否则**显式清空**——避免上一家厂商的 key 残留在输入框里被用户误点保存。
  // 这是 v1 切厂商行为里的关键不变量：apiKey 永远只跟当前厂商绑定。
  apiKeyInput.value = preferredApiKey ?? "";

  activeProvider = preset.providerName;
}

async function loadConfig(): Promise<void> {
  try {
    fillPresetOptions();
    const cfg = await window.settings!.getConfig();
    modeSelect.value = cfg.mode;
    // 把 main 进程返回的 perProvider 灌进渲染端内存缓存，切厂商时用到
    if (cfg.perProvider && typeof cfg.perProvider === "object") {
      for (const [key, value] of Object.entries(cfg.perProvider)) {
        if (value && typeof value === "object") {
          providerProfileCache[key] = {
            baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
            model: typeof value.model === "string" ? value.model : "",
            apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
          };
        }
      }
    }
    applyModeUI();
    applyPreset(cfg.provider, cfg.model, cfg.apiKey, cfg.baseUrl);
    applyRuntimeSyncSelection(cfg.runtimeSync);
    stickerEnabledInput.checked = cfg.stickerEnabled !== false;
    applyStickerSizeSelection(cfg.stickerSize);

    // 视觉模型配置
    const vision = cfg.vision;
    if (vision) {
      visionSyncCheckbox.checked = vision.syncWithMain;
      visionBaseUrlInput.value = vision.baseUrl || "";
      visionApiKeyInput.value = vision.apiKey || "";
      visionModelInput.value = vision.model || "";
    } else {
      visionSyncCheckbox.checked = false;
      visionBaseUrlInput.value = "";
      visionApiKeyInput.value = "";
      visionModelInput.value = "";
    }
    applyVisionSyncUI();

    setSaveStatus("等待保存");
    setCyreneSaveStatus("等待保存");
  } catch {
    fillPresetOptions();
    // 默认厂商已从 DeepSeek 改为 MiniMax（v1 vendor adapter 第一家落地的）
    applyModeUI();
    applyPreset("MiniMax（稀宇科技）");
    setSaveStatus("读取配置失败", "is-error");
    setCyreneSaveStatus("读取配置失败", "is-error");
  }
}

async function loadGeneralSettings(): Promise<void> {
  try {
    const cfg = await window.settings!.getGeneral();
    musicEnabledInput.checked = cfg.musicEnabled;
    musicVolumeInput.value = String(cfg.musicVolume);
    syncMusicPlayback();
    soundEnabledInput.checked = cfg.soundEnabled;
    soundVolumeInput.value = String(cfg.soundVolume);
    petAlwaysOnTopInput.checked = cfg.petAlwaysOnTop;
    petVisibleInput.checked = cfg.petVisible;
    launchAtLoginInput.checked = cfg.launchAtLogin;
    applyLanguageSelection("zh-CN");
    setGeneralSaveStatus("等待保存");
  } catch {
    setGeneralSaveStatus("读取设置失败", "is-error");
  }
}

runtimeSyncSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    const value = button.dataset.value as "off" | "local" | "llm";
    applyRuntimeSyncSelection(value);
    window.settings?.previewRuntimeSync(value);
    setCyreneSaveStatus("有未保存的更改");
  });
});

stickerEnabledInput.addEventListener("change", () => {
  setCyreneSaveStatus("有未保存的更改");
});

stickerSizeSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    const value = button.dataset.value;
    applyStickerSizeSelection(value === "small" || value === "large" ? value : "standard");
    setCyreneSaveStatus("有未保存的更改");
  });
});

sidebarVisibleInput.addEventListener("change", () => {
  if (sidebarVisibleInput.checked) window.settings?.openSidebar();
  else window.settings?.closeSidebar();
});

tasksVisibleInput.addEventListener("change", () => {
  if (tasksVisibleInput.checked) window.settings?.openTasks();
  else window.settings?.closeTasks();
});

musicEnabledInput.addEventListener("change", () => {
  syncMusicPlayback();
  setGeneralSaveStatus("有未保存的更改");
});

musicVolumeInput.addEventListener("input", () => {
  syncMusicPlayback();
  setGeneralSaveStatus("有未保存的更改");
});

soundEnabledInput.addEventListener("change", () => setGeneralSaveStatus("有未保存的更改"));
soundVolumeInput.addEventListener("input", () => setGeneralSaveStatus("有未保存的更改"));

petAlwaysOnTopInput.addEventListener("change", () => window.settings?.setPetAlwaysOnTop(petAlwaysOnTopInput.checked));
petVisibleInput.addEventListener("change", () => window.settings?.setPetVisible(petVisibleInput.checked));

openStickerManagerBtn.addEventListener("click", async () => {
  console.log("[settings] open sticker manager clicked");
  try {
    const result = await window.settings?.openStickerManager();
    if (!result?.ok) {
      console.error("[settings] open sticker manager failed", result?.error);
      window.alert("表情包管理窗口打开失败，请查看终端日志。" + (result?.error ? `\n${result.error}` : ""));
    }
  } catch (error) {
    console.error("[settings] open sticker manager error", error);
    window.alert("表情包管理窗口打开失败，请查看终端日志。");
  }
});

// ── 插件开关事件 ──────────────────────────────────────────
const pluginDocsCheckbox = document.getElementById("plugin-docs-enabled") as HTMLInputElement | null;
const pluginMemoryCheckbox = document.getElementById("plugin-memory-enabled") as HTMLInputElement | null;
const pluginWorldbookCheckbox = document.getElementById("plugin-worldbook-enabled") as HTMLInputElement | null;

function syncPluginSwitch(toolId: string, enabled: boolean): void {
  window.settings?.setToolEnabled?.(toolId, enabled).then((result) => {
    if (!result?.ok) {
      console.warn("[settings] 工具开关同步失败: " + toolId, result?.error);
    }
  }).catch((err) => {
    console.error("[settings] 工具开关同步异常: " + toolId, err);
  });
}

pluginDocsCheckbox?.addEventListener("change", () => {
  syncPluginSwitch("imported_docs", pluginDocsCheckbox.checked);
});

pluginMemoryCheckbox?.addEventListener("change", () => {
  syncPluginSwitch("user_memory", pluginMemoryCheckbox.checked);
});

pluginWorldbookCheckbox?.addEventListener("change", () => {
  // 世界书不走 ToolRegistry，这里仅做 UI 状态记录
  localStorage.setItem("cyrene.plugin.worldbook", String(pluginWorldbookCheckbox.checked));
});

// 初始化：从后端同步开关状态
async function loadPluginStates(): Promise<void> {
  try {
    const states = await window.settings?.getToolEnabled?.();
    if (states) {
      if (pluginDocsCheckbox && "imported_docs" in states) {
        pluginDocsCheckbox.checked = states["imported_docs"];
      }
      if (pluginMemoryCheckbox && "user_memory" in states) {
        pluginMemoryCheckbox.checked = states["user_memory"];
      }
    }
    // 世界书从 localStorage 恢复
    const wbState = localStorage.getItem("cyrene.plugin.worldbook");
    if (pluginWorldbookCheckbox && wbState !== null) {
      pluginWorldbookCheckbox.checked = wbState === "true";
    }
  } catch (err) {
    console.warn("[settings] 加载插件状态失败", err);
  }
}
void loadPluginStates();
// ── MCP Server 管理 UI ──────────────────────────────────────
const pluginAddBtn = document.querySelector(".plugin-add-btn") as HTMLButtonElement | null;
console.log("[settings] plugin-add-btn 查询结果:", pluginAddBtn ? "找到" : "未找到");


// 简易命令行解析：支持引号包裹的参数
function parseCommandLine(input: string): { command: string; args: string[] } {
  const trimmed = input.trim();
  if (!trimmed) return { command: "", args: [] };
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (const ch of trimmed) {
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " ") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return { command: parts[0] || "", args: parts.slice(1) };
}
pluginAddBtn?.addEventListener("click", async () => {
  console.log("[settings] ＋ 按钮被点击，弹出输入框…");
  const command = await showInputModal({
    title: "添加 MCP Server",
    message: "输入启动命令，例如：node C:\\my-mcp-server\\index.js",
    placeholder: "node path\\to\\server.js --flag",
    icon: "🧩",
  });
  if (!command || !command.trim()) {
    console.log("[settings] 用户取消或命令为空");
    return;
  }

  const nameInput = await showInputModal({
    title: "MCP Server 名称",
    message: "给这个 MCP server 起个名字（仅用于展示）",
    placeholder: "例如：天气工具",
    icon: "🏷️",
  });
  const name = (nameInput && nameInput.trim()) || "未命名 MCP";
  const serverId = "mcp-" + Date.now();
  const parsed = parseCommandLine(command.trim());
  if (!parsed.command) {
    await showModal({ title: "添加失败", message: "请输入有效的启动命令", icon: "⚠️" });
    return;
  }

  console.log("[settings] 添加 MCP server:", name, serverId, command.trim());

  try {
    const result = await window.settings?.addMcpServer?.({
      id: serverId,
      name: name,
      transport: "stdio",
      command: parsed.command,
      args: parsed.args,
    });

    if (result?.ok) {
      console.log("[settings] MCP server 添加成功，工具数:", result.toolIds?.length);
      await showModal({
        title: "添加成功",
        message: '"' + name + '" 已连接，发现 ' + (result.toolIds?.length || 0) + " 个工具。详情见终端日志。",
        icon: "✅",
      });
    } else {
      console.error("[settings] MCP server 添加失败:", result?.error);
      await showModal({
        title: "添加失败",
        message: (result?.error || "未知错误") + "（详情见终端日志）",
        icon: "⚠️",
      });
    }
  } catch (err) {
    console.error("[settings] MCP server 添加异常:", err);
    await showModal({
      title: "添加异常",
      message: "调用过程中发生错误，详情见终端日志。",
      icon: "⚠️",
    });
  }
});

clearChatHistoryBtn.addEventListener("click", () => {
  if (!window.confirm("清空当前聊天记录？")) return;
  localStorage.removeItem("cyrene.chat.history.v1");
  setGeneralSaveStatus("聊天记录已清空", "is-ok");
});

presetSelect.addEventListener("change", () => {
  // 切厂商前先把当前厂商的输入值快照进缓存，避免覆盖丢失
  captureActiveProviderProfile();

  // 从缓存里取目标厂商的旧配置；没有缓存就用 preset 默认值
  const cached = providerProfileCache[presetSelect.value];
  applyPreset(
    presetSelect.value,
    cached?.model,
    cached?.apiKey,
    cached?.baseUrl,
  );
  setSaveStatus(cached ? "已切回上次配置" : "已应用预设，填写 API Key 后保存");
});

// mode 切换：联动模型名控件与 baseUrl 锁定
modeSelect.addEventListener("change", () => {
  applyModeUI();
  setSaveStatus("已切换模式");
});

// 测试连接按钮：调用厂商 adapter 的真实连接测试
if (testConnectionBtn) {
  testConnectionBtn.addEventListener("click", async () => {
    const provider = providerInput.value;
    const baseUrl = baseUrlInput.value;
    const model = getCurrentModelValue().trim();
    const apiKey = apiKeyInput.value;
    if (!apiKey) { setSaveStatus("请先填写 API Key 再测试", "is-error"); return; }
    if (!model) { setSaveStatus("请先选择/填写模型再测试", "is-error"); return; }
    setSaveStatus("测试连接中…");
    testConnectionBtn.disabled = true;
    try {
      const result = await window.settings!.testConnection({ provider, baseUrl, model, apiKey });
      if (result.ok) setSaveStatus("连接成功 " + result.latency + "ms · " + (result.sample ?? ""), "is-ok");
      else setSaveStatus("连接失败：" + (result.error ?? "未知错误"), "is-error");
    } catch (e) {
      setSaveStatus("连接失败：" + (e instanceof Error ? e.message : String(e)), "is-error");
    } finally {
      testConnectionBtn.disabled = false;
    }
  });
}

// ── 视觉模型配置事件 ──────────────────────────────────────
visionSyncCheckbox.addEventListener("change", () => {
  applyVisionSyncUI();
  setSaveStatus("有未保存的更改");
});

// 主配置变化时，若同步勾选，联动更新视觉三框。
// baseUrl 用 visionBaseUrl（若有），其他直接复制。
baseUrlInput.addEventListener("input", () => {
  if (!visionSyncCheckbox.checked) return;
  const preset = findPreset(providerInput.value);
  visionBaseUrlInput.value = preset?.visionBaseUrl || baseUrlInput.value;
});
apiKeyInput.addEventListener("input", () => { if (visionSyncCheckbox.checked) visionApiKeyInput.value = apiKeyInput.value; });
modelInput.addEventListener("input", () => { if (visionSyncCheckbox.checked) visionModelInput.value = modelInput.value; });
modelSelect.addEventListener("change", () => { if (visionSyncCheckbox.checked) visionModelInput.value = modelSelect.value; });

// 测试视觉模型按钮
testVisionBtn.addEventListener("click", async () => {
  const baseUrl = visionSyncCheckbox.checked ? baseUrlInput.value : visionBaseUrlInput.value;
  const apiKey = visionSyncCheckbox.checked ? apiKeyInput.value : visionApiKeyInput.value;
  const model = visionSyncCheckbox.checked ? getCurrentModelValue() : visionModelInput.value;
  if (!apiKey) { visionTestStatus.textContent = "请先填写 API Key"; return; }
  if (!model) { visionTestStatus.textContent = "请先填写视觉型号"; return; }
  visionTestStatus.textContent = "测试中…";
  testVisionBtn.disabled = true;
  try {
    const result = await window.settings!.testVision?.({ baseUrl, apiKey, model });
    if (result?.ok) visionTestStatus.textContent = "✅ 连接成功 " + result.latency + "ms · " + (result.sample ?? "");
    else visionTestStatus.textContent = "❌ " + (result?.error ?? "未知错误");
  } catch (e) {
    visionTestStatus.textContent = "❌ " + (e instanceof Error ? e.message : String(e));
  } finally {
    testVisionBtn.disabled = false;
  }
});

generalForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setGeneralSaveStatus("保存中…");
  try {
    await window.settings!.saveGeneral({
      musicEnabled: musicEnabledInput.checked,
      musicVolume: Number(musicVolumeInput.value),
      soundEnabled: soundEnabledInput.checked,
      soundVolume: Number(soundVolumeInput.value),
      petAlwaysOnTop: petAlwaysOnTopInput.checked,
      petVisible: petVisibleInput.checked,
      launchAtLogin: launchAtLoginInput.checked,
      language: "zh-CN",
    });
    setGeneralSaveStatus("已保存", "is-ok");
  } catch {
    setGeneralSaveStatus("保存失败", "is-error");
  }
});

cyrenePanel.addEventListener("submit", async (e) => {
  e.preventDefault();
  setCyreneSaveStatus("保存中…");
  try {
    await window.settings!.saveConfig({ runtimeSync: getRuntimeSyncValue(), stickerEnabled: stickerEnabledInput.checked, stickerSize: getStickerSizeValue() });
    setCyreneSaveStatus("已保存", "is-ok");
  } catch {
    setCyreneSaveStatus("保存失败", "is-error");
  }
});

apiForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setSaveStatus("保存中…");
  try {
    // 保存前把当前输入快照进 perProvider 缓存（main 进程也会做一次，但渲染端先做一遍，
    // 是为了下一次切厂商再切回来不依赖磁盘往返）
    captureActiveProviderProfile();
    await window.settings!.saveConfig({
      mode: modeSelect.value as "auto" | "manual",
      provider: providerInput.value.trim(),
      baseUrl: baseUrlInput.value.trim(),
      // mode 决定从哪个控件读模型名
      model: getCurrentModelValue().trim(),
      apiKey: apiKeyInput.value.trim(),
      vision: {
        syncWithMain: visionSyncCheckbox.checked,
        // syncWithMain=true 时三字段传空（main 进程不落盘，运行时从主配置读）
        baseUrl: visionSyncCheckbox.checked ? "" : visionBaseUrlInput.value.trim(),
        apiKey: visionSyncCheckbox.checked ? "" : visionApiKeyInput.value.trim(),
        model: visionSyncCheckbox.checked ? "" : visionModelInput.value.trim(),
      },
    });
    setSaveStatus("已保存", "is-ok");
  } catch {
    setSaveStatus("保存失败", "is-error");
  }
});

function switchSection(section: string): void {
  const label = NAV_LABELS[section] ?? NAV_LABELS.api;
  sectionTitle.textContent = label.title;
  sectionHint.textContent = label.hint;

  const isApi = section === "api";
  const isGeneral = section === "general";
  const isCyrene = section === "cyrene";
  const isDisclaimer = section === "disclaimer";
  const isMemory = section === "memory";
  const isUser = section === "user";
  const isIdentity = section === "identity";
  const isPlugins = section === "plugins";
  apiForm.classList.toggle("is-hidden", !isApi);
  generalForm.classList.toggle("is-hidden", !isGeneral);
  cyrenePanel.classList.toggle("is-hidden", !isCyrene);
  disclaimerPanel.classList.toggle("is-hidden", !isDisclaimer);
  const memoryPanel = document.getElementById("memory-panel");
  if (memoryPanel) memoryPanel.classList.toggle("is-hidden", !isMemory);
  const userPanel = document.getElementById("user-panel");
  if (userPanel) userPanel.classList.toggle("is-hidden", !isUser);
  const identityPanel = document.getElementById("identity-panel");
  if (identityPanel) identityPanel.classList.toggle("is-hidden", !isIdentity);
  pluginsPanel.classList.toggle("is-hidden", !isPlugins);
  placeholderPanel.classList.toggle("is-hidden", isApi || isGeneral || isCyrene || isDisclaimer || isMemory || isUser || isIdentity || isPlugins);

  if (!isApi && !isGeneral && !isCyrene && !isDisclaimer && !isMemory && !isUser && !isIdentity && !isPlugins) {
    placeholderIcon.textContent = label.emoji;
    placeholderTitle.textContent = label.title;
    placeholderCopy.textContent = "这个模块先占位，等核心聊天与 API 接通后再继续扩展。";
  }

  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("is-active", (el as HTMLElement).dataset.section === section);
  });
}

document.querySelectorAll(".nav-item").forEach((el) => {
  el.addEventListener("click", () => {
    const section = (el as HTMLElement).dataset.section;
    if (section) switchSection(section);
  });
});

void loadConfig();
switchSection("general");
/* ===== RAG model card toggle (embedding only) ===== */
(function () {
  const cards = document.querySelectorAll<HTMLButtonElement>(".rag-model-card:not([data-reranker])");
  const KEY = "cyrene.rag.model";
  const saved = localStorage.getItem(KEY) || "minilm";
  cards.forEach((card) => {
    const value = card.dataset.value;
    if (!value) return;
    card.classList.toggle("is-active", value === saved);
    card.addEventListener("click", async () => {
      const previousActive = document.querySelector(".rag-model-card.is-active:not([data-reranker])") as HTMLElement | null;
      const previousValue = previousActive?.dataset.value;

      // Optimistic UI update
      cards.forEach((c) => c.classList.remove("is-active"));
      card.classList.add("is-active");
      localStorage.setItem(KEY, value);

      // Call IPC to hot-switch the embedding model
      try {
        const result = await (window as any).settings?.embeddingSetModel?.(value);
        if (result?.ok) {
          console.log("[settings] embedding switched to", value, "cleared:", result.clearedEntries);
          if (result.clearedEntries && result.clearedEntries > 0) {
            window.alert("已切换至 " + (value === "bgem3" ? "BGE-M3" : "MiniLM") + "。由于向量维度不同，已清除 " + result.clearedEntries + " 条旧向量记忆。");
          }
        } else {
          // Rollback on failure
          cards.forEach((c) => c.classList.remove("is-active"));
          if (previousValue) {
            const prevCard = document.querySelector('.rag-model-card[data-value="' + previousValue + '"]:not([data-reranker])');
            prevCard?.classList.add("is-active");
            localStorage.setItem(KEY, previousValue);
          }
          window.alert("切换失败：" + (result?.error || "未知错误"));
        }
      } catch (err) {
        // Rollback on error
        cards.forEach((c) => c.classList.remove("is-active"));
        if (previousValue) {
          const prevCard = document.querySelector('.rag-model-card[data-value="' + previousValue + '"]:not([data-reranker])');
          prevCard?.classList.add("is-active");
          localStorage.setItem(KEY, previousValue);
        }
        console.error("[settings] embedding switch error:", err);
      }
    });
  });
})();
/* ===== Reranker mode toggle ===== */
(function () {
  const cards = document.querySelectorAll<HTMLButtonElement>(".rag-model-card[data-reranker]");
  const KEY = "cyrene.reranker.mode";
  const saved = localStorage.getItem(KEY) || "light";
  cards.forEach((card) => {
    const value = card.dataset.value;
    if (!value) return;
    card.classList.toggle("is-active", value === saved);
    card.addEventListener("click", async () => {
      const previousActive = document.querySelector(".rag-model-card.is-active[data-reranker]") as HTMLElement | null;
      const previousValue = previousActive?.dataset.value;

      cards.forEach((c) => c.classList.remove("is-active"));
      card.classList.add("is-active");
      localStorage.setItem(KEY, value);
      try {
        await (window as any).settings?.rerankerSetMode?.(value);
      } catch (err) {
        // Rollback on failure
        cards.forEach((c) => c.classList.remove("is-active"));
        if (previousValue) {
          const prevCard = document.querySelector('.rag-model-card[data-value="' + previousValue + '"][data-reranker]');
          prevCard?.classList.add("is-active");
          localStorage.setItem(KEY, previousValue);
        }
        console.warn("[Reranker] set mode failed:", err);
      }
    });
  });
})();

/* ===== Embedding download / delete ===== */
(function () {
  const downloadBtn = document.getElementById("embedding-download-btn") as HTMLButtonElement | null;
  const deleteBtn = document.getElementById("embedding-delete-btn") as HTMLButtonElement | null;
  const mirrorGroup = document.getElementById("embedding-mirror") as HTMLElement | null;

  function getSelectedMirror(): string {
    const active = mirrorGroup?.querySelector(".option-block.is-active") as HTMLElement | null;
    return active?.dataset.value || "official";
  }

  function getSelectedModel(): string {
    const active = document.querySelector(".rag-model-card.is-active:not([data-reranker])") as HTMLElement | null;
    return active?.dataset.value || "minilm";
  }

  downloadBtn?.addEventListener("click", async () => {
    const model = getSelectedModel();
    const mirror = getSelectedMirror();
    downloadBtn.disabled = true;
    downloadBtn.textContent = "\u4E0B\u8F7D\u4E2D\u2026";
    try {
      const result = await window.settings?.downloadEmbeddingModel?.(model, mirror);
      if (result?.ok) {
        downloadBtn.textContent = "\u2705 \u5B8C\u6210";
        setTimeout(() => location.reload(), 800);
      } else {
        downloadBtn.textContent = "\u274C \u5931\u8D25";
        downloadBtn.disabled = false;
        window.alert("\u4E0B\u8F7D\u5931\u8D25\uFF1A" + (result?.error || "\u672A\u77E5\u9519\u8BEF"));
      }
    } catch (err) {
      downloadBtn.textContent = "\u274C \u5931\u8D25";
      downloadBtn.disabled = false;
    }
  });


  // Inline modal helper
  function _showModal(opts: { title: string; message: string; icon?: string; confirmText?: string; cancelText?: string }): Promise<boolean> {
    var ov = document.getElementById("cy-modal-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "cy-modal-overlay";
      ov.className = "cy-modal-overlay is-hidden";
      ov.innerHTML = '<div class="cy-modal" role="alertdialog" aria-modal="true"><div class="cy-modal__head"><span class="cy-modal__icon" id="cy-modal-icon">📌</span><h3 class="cy-modal__title" id="cy-modal-title">提示</h3></div><hr class="cy-modal__divider"><p class="cy-modal__body" id="cy-modal-message">确认执行此操作吗？</p><div class="cy-modal__actions"><button type="button" class="ghost-btn" id="cy-modal-cancel">取消</button><button type="button" class="btn-primary" id="cy-modal-confirm">确定</button></div></div>';
      document.body.appendChild(ov);
    }
    var iconEl = ov.querySelector("#cy-modal-icon") as HTMLElement;
    var titleEl = ov.querySelector("#cy-modal-title") as HTMLElement;
    var msgEl = ov.querySelector("#cy-modal-message") as HTMLElement;
    var cancelBtn = ov.querySelector("#cy-modal-cancel") as HTMLButtonElement;
    var confirmBtn = ov.querySelector("#cy-modal-confirm") as HTMLButtonElement;
    iconEl.textContent = opts.icon || "📌";
    titleEl.textContent = opts.title;
    msgEl.textContent = opts.message;
    cancelBtn.textContent = opts.cancelText || "取消";
    confirmBtn.textContent = opts.confirmText || "确定";
    ov.classList.remove("is-hidden");
    return new Promise(function (resolve) {
      var cleanup = function (result: boolean) {
        ov?.classList.add("is-hidden");
        cancelBtn.removeEventListener("click", onCancel);
        confirmBtn.removeEventListener("click", onConfirm);
        resolve(result);
      };
      var onCancel = function () { cleanup(false); };
      var onConfirm = function () { cleanup(true); };
      cancelBtn.addEventListener("click", onCancel);
      confirmBtn.addEventListener("click", onConfirm);
    });
  }
  deleteBtn?.addEventListener("click", async () => {
    const model = getSelectedModel();
    const name = model === "minilm" ? "MiniLM" : "BGE-M3";
    var confirmed = await _showModal({ title: "删 除 模 型", message: "确 定 删 除 " + name + " 模 型 缓 存？下 次 使 用 需 重 新 下 载。", icon: "⚠️", confirmText: "删 除", cancelText: "取 消" });
    if (!confirmed) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = "\u5220\u9664\u4E2D\u2026";
    try {
      const result = await window.settings?.deleteEmbeddingModel?.(model);
      if (result?.ok) {
        deleteBtn.textContent = "\u2705 \u5DF2\u5220\u9664";
        setTimeout(() => location.reload(), 800);
      } else {
        deleteBtn.textContent = "\u274C \u5931\u8D25";
        deleteBtn.disabled = false;
      }
    } catch (err) {
      deleteBtn.textContent = "\u274C \u5931\u8D25";
      deleteBtn.disabled = false;
    }
  });

  // Mirror source toggle
  mirrorGroup?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-value]") as HTMLElement | null;
    if (!btn) return;
    const value = btn.dataset.value;
    if (!value) return;
    mirrorGroup.querySelectorAll(".option-block").forEach((b) => {
      const v = b.getAttribute("data-value");
      b.classList.toggle("is-active", v === value);
      b.setAttribute("aria-pressed", v === value ? "true" : "false");
    });
    localStorage.setItem("cyrene.rag.mirror", value);
  });

  // Restore saved mirror on load
  const savedMirror = localStorage.getItem("cyrene.rag.mirror") || "official";
  mirrorGroup?.querySelectorAll(".option-block").forEach((b) => {
    const v = b.getAttribute("data-value");
    b.classList.toggle("is-active", v === savedMirror);
    b.setAttribute("aria-pressed", v === savedMirror ? "true" : "false");
  });
})();
(function () {
  const updateBtn = document.getElementById("embedding-update-btn") as HTMLButtonElement | null;
  updateBtn?.addEventListener("click", () => {
    updateBtn.textContent = "已是最新版本";
    updateBtn.disabled = true;
    setTimeout(() => {
      updateBtn.textContent = "检查更新";
      updateBtn.disabled = false;
    }, 2000);
  });
})();
// ── 用户信息面板 ──
const avatarEl = document.getElementById("user-avatar-el") as HTMLElement | null;
const avatarImg = avatarEl?.querySelector("img") as HTMLImageElement | null;
const avatarPlaceholder = avatarEl?.querySelector("span") as HTMLElement | null;
const uploadAvatarBtn = document.getElementById("upload-avatar-btn") as HTMLButtonElement | null;
const memoryL0NameInput = document.getElementById("memory-l0-name") as HTMLInputElement | null;
const memoryL0OccupationInput = document.getElementById("memory-l0-occupation") as HTMLInputElement | null;
const memoryL0InterestsInput = document.getElementById("memory-l0-interests") as HTMLInputElement | null;
const memoryL0LanguageInput = document.getElementById("memory-l0-language") as HTMLInputElement | null;
const memoryL0NoteInput = document.getElementById("memory-l0-note") as HTMLTextAreaElement | null;
const memoryL1GoalsInput = document.getElementById("memory-l1-goals") as HTMLTextAreaElement | null;
const memoryL1PreferencesInput = document.getElementById("memory-l1-preferences") as HTMLTextAreaElement | null;
const memoryL1ProjectInput = document.getElementById("memory-l1-project") as HTMLTextAreaElement | null;
const memoryL2SearchInput = document.getElementById("memory-l2-search") as HTMLInputElement | null;
const memoryL2List = document.getElementById("memory-l2-list") as HTMLElement | null;
const memoryImportedList = document.getElementById("memory-imported-list") as HTMLElement | null;
const memoryReflectionList = document.getElementById("memory-reflection-list") as HTMLElement | null;
const memoryL0EditBtn = document.getElementById("memory-l0-edit-btn") as HTMLButtonElement | null;
const memoryL0CancelBtn = document.getElementById("memory-l0-cancel-btn") as HTMLButtonElement | null;
const memoryL1EditBtn = document.getElementById("memory-l1-edit-btn") as HTMLButtonElement | null;
const memoryL1CancelBtn = document.getElementById("memory-l1-cancel-btn") as HTMLButtonElement | null;

let memoryPanelCache: MemoryPanelPayload | null = null;
let l0Editing = false;
let l1Editing = false;
let l0Snapshot: Record<string, string> | null = null;
let l1Snapshot: Record<string, string> | null = null;

function showAvatar(dataUrl: string | null): void {
  if (!dataUrl || !avatarEl) return;
  if (!avatarEl) return;
  let img = avatarEl.querySelector("img");
  if (!img) {
    img = document.createElement("img");
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.borderRadius = "50%";
    img.style.objectFit = "cover";
    avatarEl.appendChild(img);
  }
  img.src = dataUrl;
  if (avatarPlaceholder) avatarPlaceholder.style.display = "none";
}

function formatDateTime(timestamp: number): string {
  if (!timestamp) return "暂无时间";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "暂无时间";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEmptyState(container: HTMLElement | null, title: string, hint: string): void {
  if (!container) return;
  container.innerHTML = [
    '<div class="memory-list__empty">',
    '  <span>📭</span>',
    `  <p>${escapeHtml(title)}</p>`,
    `  <p class="memory-list__hint">${escapeHtml(hint)}</p>`,
    '</div>',
  ].join("\n");
}

function renderInfoList(
  container: HTMLElement | null,
  items: Array<{ title: string; body: string; meta?: string }>,
  emptyTitle: string,
  emptyHint: string,
): void {
  if (!container) return;
  if (items.length === 0) {
    renderEmptyState(container, emptyTitle, emptyHint);
    return;
  }

  container.innerHTML = items
    .map((item) => {
      const meta = item.meta ? `<p class="memory-record__meta">${escapeHtml(item.meta)}</p>` : "";
      return [
        '<article class="memory-record">',
        `  <h3 class="memory-record__title">${escapeHtml(item.title)}</h3>`,
        `  <p class="memory-record__body">${escapeHtml(item.body)}</p>`,
        `  ${meta}`,
        '</article>',
      ].join("\n");
    })
    .join("\n");
}

function renderL2List(query = ""): void {
  const list = memoryPanelCache?.l2 ?? [];
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? list.filter((item) => {
        const haystack = [item.content, item.triggerText, item.status].join(" ").toLowerCase();
        return haystack.includes(normalized);
      })
    : list;

  renderInfoList(
    memoryL2List,
    filtered.map((item) => ({
      title: item.content,
      body: item.triggerText ? `触发片段：${item.triggerText}` : "无触发片段",
      meta: `状态：${item.status} · 权重：${item.weight.toFixed(1)} · 创建于：${formatDateTime(item.createdAt)}`,
    })),
    normalized ? "没有匹配的事件记忆" : "暂无事件记忆",
    normalized ? "换个关键词试试" : "聊天后昔涟会自动提炼重要信息",
  );
}

async function loadMemoryPanel(): Promise<void> {
  try {
    const payload = await window.memoryPanel?.getData();
    if (!payload) return;
    memoryPanelCache = payload;

    if (memoryL0NameInput) memoryL0NameInput.value = payload.l0.preferredName || "";
    if (memoryL0OccupationInput) memoryL0OccupationInput.value = payload.l0.occupation || "";
    if (memoryL0InterestsInput) memoryL0InterestsInput.value = payload.l0.longTermInterests || "";
    if (memoryL0LanguageInput) memoryL0LanguageInput.value = payload.l0.language || "";
    if (memoryL0NoteInput) memoryL0NoteInput.value = payload.l0.permanentNote || "";

    if (memoryL1GoalsInput) memoryL1GoalsInput.value = payload.l1.recentGoals || "";
    if (memoryL1PreferencesInput) memoryL1PreferencesInput.value = payload.l1.recentPreferences || "";
    if (memoryL1ProjectInput) memoryL1ProjectInput.value = payload.l1.currentProject || "";

    renderL2List(memoryL2SearchInput?.value || "");

        renderImportedDocs();;

    renderInfoList(
      memoryReflectionList,
      payload.reflections,
      "暂无阶段总结",
      "当前项目里 Reflection 还没真正生成落地",
    );

    if (memoryL0EditBtn) memoryL0EditBtn.disabled = false;
    if (memoryL1EditBtn) memoryL1EditBtn.disabled = false;
  } catch (err) {
    console.error("[settings] load memory panel failed", err);
    renderEmptyState(memoryL2List, "记忆读取失败", "请查看终端日志");
    renderEmptyState(memoryImportedList, "导入知识读取失败", "请查看终端日志");
    renderEmptyState(memoryReflectionList, "阶段总结读取失败", "请查看终端日志");
  }
}

async function loadUserProfile(): Promise<void> {
  try {
    const avatarDataUrl = await window.user?.getAvatar();
    if (avatarDataUrl) showAvatar(avatarDataUrl);
    if (uploadAvatarBtn) uploadAvatarBtn.disabled = false;
  } catch {
    console.warn("[settings] load user profile failed");
  }
}

if (uploadAvatarBtn) {
  uploadAvatarBtn.addEventListener("click", async () => {
    try {
      const result = await window.user?.uploadAvatar();
      if (result?.avatarPath) {
        const avatarDataUrl = await window.user?.getAvatar();
        if (avatarDataUrl) showAvatar(avatarDataUrl);
      }
    } catch (err) {
      console.error("[settings] upload avatar failed", err);
    }
  });
}
// --- L0/L1 editable logic ---

function takeL0Snapshot(): Record<string, string> {
  return {
    preferredName: memoryL0NameInput?.value ?? "",
    occupation: memoryL0OccupationInput?.value ?? "",
    longTermInterests: memoryL0InterestsInput?.value ?? "",
    language: memoryL0LanguageInput?.value ?? "",
    permanentNote: memoryL0NoteInput?.value ?? "",
  };
}

function takeL1Snapshot(): Record<string, string> {
  return {
    recentGoals: memoryL1GoalsInput?.value ?? "",
    recentPreferences: memoryL1PreferencesInput?.value ?? "",
    currentProject: memoryL1ProjectInput?.value ?? "",
  };
}

function shallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function setL0FieldsDisabled(disabled: boolean): void {
  if (memoryL0NameInput) disabled ? memoryL0NameInput.setAttribute("disabled", "") : memoryL0NameInput.removeAttribute("disabled");
  if (memoryL0OccupationInput) disabled ? memoryL0OccupationInput.setAttribute("disabled", "") : memoryL0OccupationInput.removeAttribute("disabled");
  if (memoryL0InterestsInput) disabled ? memoryL0InterestsInput.setAttribute("disabled", "") : memoryL0InterestsInput.removeAttribute("disabled");
  if (memoryL0LanguageInput) disabled ? memoryL0LanguageInput.setAttribute("disabled", "") : memoryL0LanguageInput.removeAttribute("disabled");
  if (memoryL0NoteInput) disabled ? memoryL0NoteInput.setAttribute("disabled", "") : memoryL0NoteInput.removeAttribute("disabled");
}

function setL1FieldsDisabled(disabled: boolean): void {
  if (memoryL1GoalsInput) disabled ? memoryL1GoalsInput.setAttribute("disabled", "") : memoryL1GoalsInput.removeAttribute("disabled");
  if (memoryL1PreferencesInput) disabled ? memoryL1PreferencesInput.setAttribute("disabled", "") : memoryL1PreferencesInput.removeAttribute("disabled");
  if (memoryL1ProjectInput) disabled ? memoryL1ProjectInput.setAttribute("disabled", "") : memoryL1ProjectInput.removeAttribute("disabled");
}

function enterL0EditMode(): void {
  if (l0Editing) return;
  l0Editing = true;
  l0Snapshot = takeL0Snapshot();
  setL0FieldsDisabled(false);
  if (memoryL0EditBtn) memoryL0EditBtn.textContent = "💾 保存";
  if (memoryL0CancelBtn) memoryL0CancelBtn.classList.remove("is-hidden");
}

function exitL0EditMode(): void {
  l0Editing = false;
  l0Snapshot = null;
  setL0FieldsDisabled(true);
  if (memoryL0EditBtn) memoryL0EditBtn.textContent = "✏️ 编辑";
  if (memoryL0CancelBtn) memoryL0CancelBtn.classList.add("is-hidden");
}

async function saveL0(): Promise<void> {
  const current = takeL0Snapshot();
  if (l0Snapshot && shallowEqual(current, l0Snapshot)) {
    exitL0EditMode();
    return;
  }
  try {
    await window.memoryPanel?.saveL0(current);
    await loadMemoryPanel();
    exitL0EditMode();
    if (memoryL0EditBtn) {
      memoryL0EditBtn.textContent = "✅ 已保存";
      setTimeout(() => { if (memoryL0EditBtn && !l0Editing) memoryL0EditBtn.textContent = "✏️ 编辑"; }, 2000);
    }
  } catch (err) {
    console.error("[settings] save L0 failed", err);
    alert("保存失败，请重试");
  }
}

function cancelL0Edit(): void {
  if (l0Snapshot) {
    if (memoryL0NameInput) memoryL0NameInput.value = l0Snapshot.preferredName;
    if (memoryL0OccupationInput) memoryL0OccupationInput.value = l0Snapshot.occupation;
    if (memoryL0InterestsInput) memoryL0InterestsInput.value = l0Snapshot.longTermInterests;
    if (memoryL0LanguageInput) memoryL0LanguageInput.value = l0Snapshot.language;
    if (memoryL0NoteInput) memoryL0NoteInput.value = l0Snapshot.permanentNote;
  }
  exitL0EditMode();
}

function enterL1EditMode(): void {
  if (l1Editing) return;
  l1Editing = true;
  l1Snapshot = takeL1Snapshot();
  setL1FieldsDisabled(false);
  if (memoryL1EditBtn) memoryL1EditBtn.textContent = "💾 保存";
  if (memoryL1CancelBtn) memoryL1CancelBtn.classList.remove("is-hidden");
}

function exitL1EditMode(): void {
  l1Editing = false;
  l1Snapshot = null;
  setL1FieldsDisabled(true);
  if (memoryL1EditBtn) memoryL1EditBtn.textContent = "✏️ 编辑";
  if (memoryL1CancelBtn) memoryL1CancelBtn.classList.add("is-hidden");
}

async function saveL1(): Promise<void> {
  const current = takeL1Snapshot();
  if (l1Snapshot && shallowEqual(current, l1Snapshot)) {
    exitL1EditMode();
    return;
  }
  try {
    await window.memoryPanel?.saveL1(current);
    await loadMemoryPanel();
    exitL1EditMode();
    if (memoryL1EditBtn) {
      memoryL1EditBtn.textContent = "✅ 已保存";
      setTimeout(() => { if (memoryL1EditBtn && !l1Editing) memoryL1EditBtn.textContent = "✏️ 编辑"; }, 2000);
    }
  } catch (err) {
    console.error("[settings] save L1 failed", err);
    alert("保存失败，请重试");
  }
}

function cancelL1Edit(): void {
  if (l1Snapshot) {
    if (memoryL1GoalsInput) memoryL1GoalsInput.value = l1Snapshot.recentGoals;
    if (memoryL1PreferencesInput) memoryL1PreferencesInput.value = l1Snapshot.recentPreferences;
    if (memoryL1ProjectInput) memoryL1ProjectInput.value = l1Snapshot.currentProject;
  }
  exitL1EditMode();
}

// Bind edit button events
memoryL0EditBtn?.addEventListener("click", () => {
  if (l0Editing) { saveL0(); } else { enterL0EditMode(); }
});
memoryL0CancelBtn?.addEventListener("click", cancelL0Edit);

memoryL1EditBtn?.addEventListener("click", () => {
  if (l1Editing) { saveL1(); } else { enterL1EditMode(); }
});
memoryL1CancelBtn?.addEventListener("click", cancelL1Edit);


function renderImportedDocs(): void {
  const list = memoryPanelCache?.importedDocs ?? [];
  if (!memoryImportedList) return;

  if (list.length === 0) {
    renderEmptyState(memoryImportedList, "暂无导入文档", "在聊天窗口上传文件后会自动索引");
    return;
  }

  memoryImportedList.innerHTML = list
    .map((item) => {
      const importId = item.importId || "";
      const fileName = escapeHtml(item.fileName);
      const chunkInfo = "已索引 " + item.chunkCount + " 个片段";
      const timeInfo = "最近导入：" + formatDateTime(item.lastImportedAt);
      return [
        '<article class="memory-record memory-record--doc">',
        '  <div class="memory-record__main">',
        '    <h3 class="memory-record__title">' + fileName + '</h3>',
        '    <p class="memory-record__body">' + escapeHtml(chunkInfo) + '</p>',
        '    <p class="memory-record__meta">' + escapeHtml(timeInfo) + '</p>',
        '  </div>',
        '  <button type="button" class="memory-record__delete" data-import-id="' + escapeHtml(importId) + '" data-file-name="' + fileName + '" title="删除此导入文档">🗑️</button>',
        '</article>',
      ].join("\n");
    })
    .join("\n");
}

memoryImportedList?.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement | null;
  const deleteBtn = target?.closest(".memory-record__delete") as HTMLElement | null;
  if (!deleteBtn) return;

  const importId = deleteBtn.dataset.importId || "";
  const fileName = deleteBtn.dataset.fileName || "未命名文档";

  const confirmed = await showModal({
    title: "删除导入知识",
    message: "确定删除导入知识？\n\n文件：\n《" + fileName + "》\n\n删除后不可恢复，如需使用请重新导入。",
    icon: "⚠️",
    confirmText: "删除",
    cancelText: "取消",
  });

  if (!confirmed) return;

  try {
    const result = await window.memoryPanel?.deleteImportedDoc(importId, fileName);
    if (result?.ok) {
      await loadMemoryPanel();
    }
  } catch (err) {
    console.error("[settings] delete imported doc failed", err);
  }
});


void loadMemoryPanel();
void loadUserProfile();

// ── 权限档位 UI ───────────────────────────────────────────
type PermissionLevel = "read-only" | "scoped" | "per-action" | "full";

const permissionBlocksWrap = document.getElementById("agent-permission-blocks") as HTMLElement | null;
const permissionNote = document.getElementById("agent-permission-note") as HTMLElement | null;

const PERMISSION_NOTES: Record<PermissionLevel, string> = {
  "read-only": "只读：昔涟不会修改本地任何文件，也不能为你安装新工具。",
  "scoped": "指定目录：昔涟只能在你授权的目录里读写文件（白名单后续在此面板配置）。",
  "per-action": "每次审批：每次涉及文件或安装的操作，昔涟都会在聊天里弹卡片让你确认。",
  "full": "完全访问：昔涟可以自由调用本地命令（含 git/npm/pip）。请只在你完全信任的情况下使用。",
};

function paintPermissionUI(level: PermissionLevel): void {
  if (!permissionBlocksWrap) return;
  const blocks = permissionBlocksWrap.querySelectorAll<HTMLButtonElement>("button[data-level]");
  blocks.forEach((b) => {
    const isActive = b.dataset.level === level;
    b.classList.toggle("is-active", isActive);
    b.setAttribute("aria-pressed", String(isActive));
  });
  if (permissionNote) {
    permissionNote.textContent = PERMISSION_NOTES[level];
  }
}

async function confirmFullAccess(): Promise<boolean> {
  // 完全访问需要延迟确认 + 风险提示
  _initModalOverlay();
  if (!_cyModalOverlay) return false;
  const iconEl = _cyModalOverlay.querySelector("#cy-modal-icon") as HTMLElement;
  const titleEl = _cyModalOverlay.querySelector("#cy-modal-title") as HTMLElement;
  const msgEl = _cyModalOverlay.querySelector("#cy-modal-message") as HTMLElement;
  const cancelBtn = _cyModalOverlay.querySelector("#cy-modal-cancel") as HTMLButtonElement;
  const confirmBtn = _cyModalOverlay.querySelector("#cy-modal-confirm") as HTMLButtonElement;
  iconEl.textContent = "⚠️";
  titleEl.textContent = "切换到完全访问？";
  msgEl.textContent = "这意味着昔涟可以在你的电脑上自由执行命令，包括 git clone、npm install、删除文件等。请只在你完全信任她的判断时启用。";
  cancelBtn.textContent = "再想想";
  _cyModalOverlay.classList.remove("is-hidden");

  // 倒计时 5 秒强制等待
  let remain = 5;
  confirmBtn.disabled = true;
  confirmBtn.textContent = "我了解风险（" + remain + "）";
  const tick = setInterval(() => {
    remain -= 1;
    if (remain <= 0) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "我了解风险，启用";
      clearInterval(tick);
    } else {
      confirmBtn.textContent = "我了解风险（" + remain + "）";
    }
  }, 1000);

  return new Promise((resolve) => {
    const cleanup = (result: boolean) => {
      clearInterval(tick);
      confirmBtn.disabled = false;
      _cyModalOverlay?.classList.add("is-hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      resolve(result);
    };
    const onCancel = () => cleanup(false);
    const onConfirm = () => cleanup(true);
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}

if (permissionBlocksWrap) {
  permissionBlocksWrap.addEventListener("click", async (event) => {
    const btn = (event.target as HTMLElement)?.closest("button[data-level]") as HTMLButtonElement | null;
    if (!btn) return;
    const target = (btn.dataset.level || "") as PermissionLevel;
    if (!target) return;
    if (btn.classList.contains("is-active")) {
      console.log("[settings] 档位未变，不动作");
      return;
    }

    if (target === "full") {
      const ok = await confirmFullAccess();
      if (!ok) {
        console.log("[settings] 用户取消了完全访问");
        return;
      }
    }

    console.log("[settings] 切换权限档位 →", target);
    try {
      const result = await window.settings?.setPermissionLevel?.(target);
      if (result?.ok) {
        paintPermissionUI((result.level || target) as PermissionLevel);
      } else {
        console.warn("[settings] 切换档位失败:", result?.error);
      }
    } catch (err) {
      console.error("[settings] 切换档位异常:", err);
    }
  });

  // 初始化：从后端拿当前档位
  void (async () => {
    try {
      const result = await window.settings?.getPermissionLevel?.();
      const level = (result?.level || "read-only") as PermissionLevel;
      console.log("[settings] 当前权限档位:", level);
      paintPermissionUI(level);
    } catch (err) {
      console.warn("[settings] 加载权限档位失败:", err);
      paintPermissionUI("read-only");
    }
  })();
}







