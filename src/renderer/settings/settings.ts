import "../ui/base.css";
import "./settings.css";
import "../ui/theme";
import {
  CHAT_DEFAULT_IDENTITY_LABEL,
  formatChatRelativeTime,
  type ChatSessionMetaUI,
} from "../../shared/chat-ui";

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
    '  <p class="cy-modal__body" id="cy-modal-message">確認執行此操作嗎？</p>',
    '  <div class="cy-modal__actions">',
    '    <button type="button" class="ghost-btn" id="cy-modal-cancel">取消</button>',
    '    <button type="button" class="btn-primary" id="cy-modal-confirm">確定</button>',
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
  confirmBtn.textContent = options.confirmText || "確定";
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

// Inline input modal (Electron 禁用了 window.prompt，所以自己實現)
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
    '    <h3 class="cy-modal__title" id="cy-input-title">請輸入</h3>',
    '  </div>',
    '  <hr class="cy-modal__divider">',
    '  <p class="cy-modal__body" id="cy-input-message"></p>',
    '  <input type="text" id="cy-input-field" autocomplete="off" spellcheck="false"',
    '    style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(0,0,0,0.32);color:var(--rb-text-strong,#fff);font-family:inherit;font-size:13px;outline:none;margin-bottom:12px;" />',
    '  <div class="cy-modal__actions">',
    '    <button type="button" class="ghost-btn" id="cy-input-cancel">取消</button>',
    '    <button type="button" class="btn-primary" id="cy-input-confirm">確定</button>',
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
  confirmBtn.textContent = options.confirmText || "確定";
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
      if (e.key === "Enter") {
        if (e.isComposing) return;
        e.preventDefault();
        onConfirm();
      }
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
  displayName?: string;
  /**
   * 用戶在 settings 顯式指定的 transport；"auto" = 按 baseUrl 啟發式 + capabilities fallback。
   * main 進程的 resolveTransport() 負責把 "auto" 解析為具體 transport。
   */
  explicitTransport?: "openai" | "anthropic" | "auto";
}

interface ModelSettings {
  mode: "auto" | "manual";
  provider: string;
  // 用戶給模型起的自定義暱稱，留空時用廠商 shortName。狀態欄"正在餵養"顯示它。
  displayName?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * 當前廠商的 explicitTransport 鏡像（頂層字段是 main 進程 perProvider[currentProvider] 的視圖）。
   * UI 改動 transport-select 時，saveConfig 把這個值帶給 main 進程摺疊回 perProvider。
   */
  explicitTransport?: "openai" | "anthropic" | "auto";
  // 按廠商緩存：切回該廠商時，從這裡恢復 baseUrl / model / apiKey
  perProvider?: Record<string, ProviderProfile>;
  runtimeSync: "off" | "local" | "llm";
  stickerEnabled: boolean;
  stickerSize: "small" | "standard" | "large";
  stickerSimilarityThreshold: number;
  vision?: {
    syncWithMain: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

type ScheduleConfig =
  | { kind: "once"; runAt: string }
  | { kind: "daily"; timeOfDay: string }
  | { kind: "weekly"; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; timeOfDay: string }
  | { kind: "interval"; every: number; unit: "minutes" | "hours" };

type SchedulerToolMode = "all-enabled" | "allow-list";

interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: ScheduleConfig;
  nextFireAt: string | null;
  lastFiredAt?: string;
  toolMode: SchedulerToolMode;
  allowedToolIds: string[];
  managedBy?: "daily-ritual";
  ritualId?: "morning" | "afternoon" | "evening";
  createdAt: string;
  updatedAt: string;
}

interface ScheduledTaskHistoryEntry {
  id: string;
  taskId: string;
  taskTitle: string;
  firedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: "running" | "success" | "failed" | "skipped";
  reason?: string;
  outputPreview?: string;
  errorMessage?: string;
  effectiveToolIds: string[];
}

interface SchedulerToolInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  risk: string;
}

interface SchedulerResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  reason?: string;
}

interface SchedulerApi {
  list: () => Promise<SchedulerResult<ScheduledTask[]>>;
  add: (input: unknown) => Promise<SchedulerResult<ScheduledTask>>;
  update: (id: string, patch: unknown) => Promise<SchedulerResult<ScheduledTask>>;
  delete: (id: string) => Promise<SchedulerResult<boolean>>;
  toggle: (id: string, enabled: boolean) => Promise<SchedulerResult<ScheduledTask>>;
  fireNow: (id: string) => Promise<SchedulerResult<boolean>>;
  getHistory: (taskId: string, limit?: number) => Promise<SchedulerResult<ScheduledTaskHistoryEntry[]>>;
  getTools: () => Promise<SchedulerResult<SchedulerToolInfo[]>>;
}

interface ModelPreset {
  providerName: string;
  // 下拉選單顯示名；保留 providerName 可兼容既有配置鍵（例如 Custom）。
  selectLabel?: string;
  // 廠商短名（去括號後綴），用於狀態欄"正在餵養"顯示和暱稱默認值。
  // 如 "MiniMax（稀宇科技）" → shortName "MiniMax"。
  shortName: string;
  baseUrl: string;
  mainModels: string[];
  iconUrl: string;
  // 不需要真實密鑰的本機 OpenAI 兼容服務可提供一個佔位值。
  defaultApiKey?: string;
  // 廠商官網鏈接，顯示在預設下拉框旁邊，方便用戶直接跳轉註冊/查看文檔。
  websiteUrl?: string;
  // 視覺模型的 OpenAI 兼容 baseUrl。僅當主配走 Anthropic 入口、視覺要走 OpenAI 入口時才標
  // （如 MiniMax 主配 /anthropic，視覺走 /v1）。勾選"同步主模型"時 UI 用它填視覺框。
  visionBaseUrl?: string;
  // 該廠商默認主模型是否支持視覺。true 時設置頁加載默認勾選"同步主模型"，
  // 多模態用戶開箱即用。與 capabilities.ts 的 supportsVision 鏡像，需手動同步。
  supportsVision?: boolean;
  // 標記為 true 時，該項在 <select> 裡顯示但不可選；
  // 用於"已列出但 vendor adapter 還沒接好"的情況，避免用戶選到後調用直接報錯。
  disabled?: boolean;
}

interface GeneralSettings {
  musicEnabled: boolean;
  musicVolume: number;
  soundEnabled: boolean;
  soundVolume: number;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  petChatInputEnabled: boolean;
  petZoom: number;
  sidebarVisible: boolean;
  tasksVisible: boolean;
  launchAtLogin: boolean;
  language: "zh-CN";
  uiTheme: "classic" | "polished-pink" | "pearl-white";
}

interface UserApi {
  getProfile: () => Promise<{ nickname: string; callPreference: string; birthday: string; timezone: string; avatarPath: string; defaultCity: string }>;
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
    status: "active" | "aging" | "archived" | "superseded" | "merged";
    weight: number;
    createdAt: number;
    lastAccessedAt: number;
    accessCount: number;
    isPinned: boolean;
    sourceConversationId: string;
    isSummary: boolean;
    conflictCount: number;
    supersededBy?: string;
    mergedInto?: string;
    evidence: Array<{
      id: string;
      quoteSnippet: string;
      contextBeforeSnippet?: string;
      contextAfterSnippet?: string;
      conversationId?: string;
      createdAt: number;
      sourceStatus: "active" | "archived" | "deleted";
    }>;
  }>;
  graph: {
    nodes: Array<{
      id: string;
      name: string;
      type: "user" | "person" | "place" | "concept" | "preference" | "organization";
      mentionCount: number;
      firstMentionedAt: number;
      lastMentionedAt: number;
    }>;
    edges: Array<{
      id: string;
      sourceId: string;
      targetId: string;
      relation: string;
      strength: number;
      confidence: number;
      inferred: boolean;
    }>;
  };
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
  pinL2: (id: string, pinned: boolean) => Promise<{ ok: boolean; error?: string }>;
  deleteL2: (id: string) => Promise<{ ok: boolean; error?: string }>;
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
  setPetZoom: (value: number) => void;
  previewRuntimeSync: (value: "off" | "local" | "llm") => void;
  openStickerManager: () => Promise<{ ok: boolean; error?: string }>;
  securityGetStatus: () => Promise<{ available: boolean; backend: string; protectedCount: number; plaintextCount: number; lockedCount: number }>;
  securityMigrate: () => Promise<{ available: boolean; backend: string; protectedCount: number; plaintextCount: number; lockedCount: number }>;
  securityRestartApp: () => void;
  backupGetConfig: () => Promise<{ autoEnabled: boolean; retentionDays: 7 | 30; lastAutoBackupAt?: string }>;
  backupSaveConfig: (patch: { autoEnabled?: boolean; retentionDays?: 7 | 30 }) => Promise<{ autoEnabled: boolean; retentionDays: 7 | 30; lastAutoBackupAt?: string }>;
  backupCreate: (categories: string[]) => Promise<BackupSummary | null>;
  backupPickInspect: () => Promise<BackupSummary | null>;
  backupRestore: (payload: { filePath: string; categories: string[] }) => Promise<{ restoredFiles: number; safetyBackupPath: string }>;
  stickerPickFile?: () => Promise<string | null>;
  stickerAdd?: (payload: { sourcePath: string; id: string; description: string; phrases: string[] }) => Promise<unknown>;
  getEmbeddingStatus?: () => Promise<Record<string, { installed: boolean; sizeBytes: number }>>;
  downloadEmbeddingModel?: (model: string, mirror: string) => Promise<{ ok: boolean; error?: string }>;
  deleteEmbeddingModel?: (model: string) => Promise<{ ok: boolean; error?: string }>;
  embeddingSetModel?: (model: string) => Promise<{ ok: boolean; clearedEntries?: number; error?: string }>;
  rerankerSetMode?: (mode: string) => Promise<boolean>;
  setToolEnabled?: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  getToolEnabled?: () => Promise<Record<string, boolean>>;
  listSkills?: () => Promise<Array<{ id: string; name: string; description: string; tools: string[]; enabled: boolean; source: string; version?: string; references: string[] }>>;
  setSkillEnabled?: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  addMcpServer?: (config: unknown) => Promise<{ ok: boolean; toolIds?: string[]; error?: string }>;
  removeMcpServer?: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
  listMcpServers?: () => Promise<Array<{ id: string; name: string; connected: boolean; toolCount: number; toolIds: string[] }>>;
  getPermissionLevel?: () => Promise<{ level: "read-only" | "scoped" | "per-action" | "full" }>;
  setPermissionLevel?: (level: string) => Promise<{ ok: boolean; level?: string; error?: string }>;
  testConnection?: (config: { provider: string; baseUrl: string; model: string; apiKey: string }) => Promise<{ ok: boolean; latency: number; sample?: string; error?: string }>;
  testVision?: (config: { baseUrl: string; apiKey: string; model: string }) => Promise<{ ok: boolean; latency: number; sample?: string; error?: string }>;
  channelsDiscordGetProfile: () => Promise<DiscordBotProfile>;
  channelsDiscordGetMusicState: () => Promise<DiscordMusicState>;
  channelsDiscordGetMusicHistory: () => Promise<DiscordMusicHistoryEntry[]>;
  channelsDiscordGetMusicFavorites: () => Promise<DiscordMusicFavoriteEntry[]>;
  channelsDiscordControlMusic: (input: DiscordMusicControlInput) => Promise<{ ok: boolean; message: string; state?: DiscordMusicState }>;
  channelsDiscordUpdateProfile: (profile: { username: string; activityText: string; status: string; avatarPath?: string; bannerPath?: string }) => Promise<{ ok: boolean; profile?: DiscordBotProfile; error?: string }>;
  channelsDiscordPickAvatar: () => Promise<string | null>;
  channelsDiscordPickBanner: () => Promise<string | null>;
  channelsSpotifyAuthorize: (input: { clientId?: string; clientSecret?: string }) => Promise<ChannelConnectionResult>;
  channelsSpotifyGetStatus: () => Promise<SpotifyPlaybackStatus>;
  channelsSpotifyControl: (input: { command: string; value?: number; deviceId?: string; query?: string }) => Promise<{ ok: boolean; message: string }>;
  channelsSpotifyDisconnect: () => Promise<ChannelConnectionResult>;
  channelsBilibiliConnect: () => Promise<ChannelConnectionResult & { profilePath?: string; title?: string }>;
  channelsBilibiliGetStatus: () => Promise<BilibiliConnectionStatus>;
  channelsBilibiliDisconnect: () => Promise<ChannelConnectionResult>;
  channelsGetConfig: () => Promise<ChannelsPreviewConfig>;
  channelsSaveConfig: (patch: unknown) => Promise<unknown>;
  channelsList: () => Promise<unknown[]>;
  channelsGetStatus: () => Promise<Record<string, { phase: string; message?: string }>>;
  channelsRestart: () => Promise<ChannelConnectionResult>;
  channelsWechatInstall: () => Promise<ChannelConnectionResult>;
  channelsWechatLoginStart: () => Promise<ChannelConnectionResult>;
  channelsWechatLoginCancel: () => Promise<ChannelConnectionResult>;
  channelsWechatPairingList: () => Promise<unknown[]>;
  channelsWechatPairingApprove: (code: string) => Promise<ChannelConnectionResult>;
  channelsWechatLogout: () => Promise<ChannelConnectionResult>;
  channelsWechatRuntimeDetect: () => Promise<unknown>;
  channelsWechatRuntimeInstall: () => Promise<ChannelConnectionResult>;
  channelsWechatRuntimeUpdate: () => Promise<ChannelConnectionResult>;
  channelsFeishuTestConnection: () => Promise<ChannelConnectionResult>;
  channelsFeishuTestWebhookReachable: () => Promise<ChannelConnectionResult>;
  channelsDiscordTestConnection: () => Promise<ChannelConnectionResult>;
  channelsLogGet: (limit?: number) => Promise<unknown[]>;
  channelsLogClear: () => Promise<unknown>;
  onChannelsInstallProgress: (callback: (progress: { channel: string; phase: string; pct: number }) => void) => (() => void) | void;
  onChannelsStatusChanged: (callback: (status: unknown) => void) => (() => void) | void;
  onChannelsWechatQrcode: (callback: (dataUrl: string) => void) => (() => void) | void;
  onChannelsWechatLoginDone: (callback: (payload: { ok: boolean; botId?: string; error?: string }) => void) => (() => void) | void;
  // main → settings：要求切到指定標籤（窗口已打開時由 main 發這個事件）
  onSwitchSection?: (callback: (section: string) => void) => (() => void) | void;
}

interface BackupSummary {
  filePath: string;
  createdAt: string;
  appVersion: string;
  categories: Array<{ id: string; label: string; fileCount: number; sizeBytes: number }>;
  fileCount: number;
  sizeBytes: number;
}

interface DiscordBotProfile {
  connected: boolean;
  id?: string;
  username?: string;
  tag?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  applicationId?: string;
  guildCount: number;
  guilds: Array<{ id: string; name: string }>;
  presenceStatus?: string;
  activityText?: string;
  voiceActive: boolean;
}

interface DiscordMusicTrack {
  id: string;
  title: string;
  url: string;
  thumbnail?: string;
  playlistTitle?: string;
  duration?: number;
  index: number;
  total: number;
}

interface DiscordMusicState {
  active: boolean;
  paused: boolean;
  current: DiscordMusicTrack | null;
  queue: DiscordMusicTrack[];
  volume: number;
  repeat: "off" | "track" | "queue";
  shuffle: boolean;
  autoplay: boolean;
  elapsed: number;
}

interface DiscordMusicControlInput {
  command: "previous" | "pause" | "resume" | "skip" | "stop" | "repeat-track" | "repeat-queue" | "repeat-off" | "shuffle" | "ordered" | "clear" | "remove" | "volume" | "autoplay-on" | "autoplay-off";
  value?: number;
}

interface DiscordMusicHistoryEntry {
  id: string;
  title: string;
  url: string;
  thumbnail?: string;
  playlistTitle?: string;
  playedAt: string;
}

interface DiscordMusicFavoriteEntry {
  id: string;
  title: string;
  url: string;
  thumbnail?: string;
  playlistTitle?: string;
  duration?: number;
  savedAt: string;
}

interface SpotifyPlaybackStatus {
  configured: boolean;
  connected: boolean;
  accountName?: string;
  product?: string;
  error?: string;
  playback?: { active: boolean; paused: boolean; progressMs: number; durationMs: number; title?: string; artists?: string; album?: string; imageUrl?: string; deviceName?: string; volume?: number };
  devices: Array<{ id: string; name: string; type: string; active: boolean; volume?: number }>;
}

interface BilibiliConnectionStatus {
  connected: boolean;
  browser: string;
  profilePath: string;
}

interface ChannelsPreviewConfig {
  wechat: { enabled: boolean };
  feishu: { enabled: boolean; appId?: string; appSecret?: string };
  discord: {
    enabled: boolean;
    botToken?: string;
    allowedGuildIds?: string[];
    allowedChannelIds?: string[];
    allowedUserIds?: string[];
    codexImageOwnerId?: string;
    requireMention?: boolean;
    voiceEnabled?: boolean;
  };
  spotify: { enabled: boolean; clientId?: string; clientSecret?: string; refreshToken?: string; accountName?: string };
  bilibili: { enabled: boolean; browser?: "opera-gx" };
  rateLimitPerUser: number;
  rateLimitPerChannel: number;
  ttsEnabled: boolean;
  stickerEnabled: boolean;
  mirrorToDesktop: boolean;
  toolSandbox: "safe-only" | "all";
}

interface ChannelConnectionResult {
  ok: boolean;
  message?: string;
  error?: string;
}

declare global {
  interface Window {
    settings?: SettingsApi;
    cyreneScheduler?: SchedulerApi;
    user?: UserApi;
    memoryPanel?: MemoryPanelApi;
  }
}

const MODEL_PRESETS: ModelPreset[] = [
  {
    // 沿用既有的 Custom profile key，讓已保存的 OpenRouter API Key 無需遷移即可復用。
    providerName: "Custom",
    selectLabel: "OpenRouter（免費路由）",
    shortName: "OpenRouter Free",
    baseUrl: "https://openrouter.ai/api/v1",
    mainModels: ["openrouter/free"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openrouter.svg",
    websiteUrl: "https://openrouter.ai/",
  },
  {
    providerName: "Gemini（Google）",
    shortName: "Gemini 3.5 Flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    mainModels: ["gemini-3.5-flash"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/gemini.svg",
    websiteUrl: "https://aistudio.google.com/apikey",
    supportsVision: true,
  },
  {
    providerName: "Ollama（本機）",
    shortName: "Llama Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    mainModels: ["llama3.1:8b"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/ollama.svg",
    websiteUrl: "https://ollama.com/library/llama3.1",
    defaultApiKey: "ollama",
  },
  // 當前 v1 計劃適配的 7 家：MiniMax / 火山 Agent-Plan / 智譜 GLM / Kimi / Qwen / ChatGPT / Claude
  // 順序按使用頻率 + 適配優先級；未在此清單內的廠商已硬刪，需要時再補回。
  {
    providerName: "MiniMax（稀宇科技）",
    shortName: "MiniMax",
    baseUrl: "https://api.minimaxi.com/anthropic",
    mainModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/minimax.svg",
    websiteUrl: "https://platform.minimaxi.com/",
    // 主配走 /anthropic，但視覺要走 OpenAI 入口 /v1。勾"同步"時 UI 自動用這個，用戶不用手改。
    visionBaseUrl: "https://api.minimaxi.com/v1",
    supportsVision: true,
  },
  {
    // DeepSeek：v1 vendor adapter 不為它做協議層強制，僅作為 OpenAI 兼容廠商列出。
    // 已確認（來自官方定價文檔）：支持 Tool Calls / JSON Output；後端原生緩存（命中後輸入價跌至 1/50~1/120）。
    // 緩存能力等 v2 vendor adapter 接入時再利用，v1 不動。
    providerName: "DeepSeek（深度求索）",
    shortName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    mainModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/deepseek.svg",
    websiteUrl: "https://platform.deepseek.com/",
  },
  {
    providerName: "火山 AgentPlan（火山引擎）",
    shortName: "火山",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    mainModels: ["ark-code-latest"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/doubao.svg",
    websiteUrl: "https://www.volcengine.com/product/agent-plan",
    // 火山方舟是聚合平臺，路由到 doubao-seed 等多模態子模型時支持視覺
    supportsVision: true,
  },
  {
    providerName: "GLM（智譜）",
    shortName: "GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    mainModels: ["glm-5.1", "glm-5-turbo", "glm-4.7"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/zhipu.svg",
    websiteUrl: "https://open.bigmodel.cn/",
  },
  {
    providerName: "Kimi（月之暗面）",
    shortName: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    mainModels: ["kimi-k2.6", "kimi-k2.5", "kimi-k2-thinking"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/moonshot.svg",
    websiteUrl: "https://platform.moonshot.cn/",
    // k2.6 / k2.7-code 支持 image_url 多模態
    supportsVision: true,
  },
  {
    providerName: "Qwen（通義千問）",
    shortName: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    mainModels: ["qwen-max", "qwen-plus", "qwen-turbo"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/qwen.svg",
    websiteUrl: "https://bailian.console.aliyun.com/",
  },
  {
    providerName: "ChatGPT（OpenAI）",
    shortName: "ChatGPT",
    baseUrl: "https://api.openai.com/v1",
    // 國內多數用戶走中轉站，型號命名各家不一；預設留空，由用戶在型號輸入框裡自行填寫。
    mainModels: [],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openai.svg",
    websiteUrl: "https://platform.openai.com/",
  },
  {
    providerName: "Claude（Anthropic）",
    shortName: "Claude",
    baseUrl: "https://api.anthropic.com/v1",
    // 同上，且 Anthropic 協議尚未接入，暫禁選。
    mainModels: [],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/claude.svg",
    websiteUrl: "https://console.anthropic.com/",
    // Anthropic 的請求體不是 OpenAI 兼容格式（messages / system / 流式都不一樣），
    // 在專屬 vendor adapter 接好之前先 disabled，避免用戶選到後調用直接報 4xx。
    disabled: true,
  },
];

if (!window.settings) {
  (window as unknown as { settings: SettingsApi }).settings = {
    minimize: () => {},
    close: () => {},
    getConfig: () =>
      Promise.resolve({
        mode: "manual",
        provider: "Custom",
        displayName: "OpenRouter Free",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openrouter/free",
        apiKey: "",
        runtimeSync: "off",
        stickerEnabled: true,
        stickerSize: "standard",
      }),
    saveConfig: (c) => Promise.resolve(c as ModelSettings),
    getGeneral: () => Promise.resolve({ musicEnabled: false, musicVolume: 60, soundEnabled: true, soundVolume: 70, petAlwaysOnTop: true, petVisible: true, petChatInputEnabled: false, petZoom: 1, sidebarVisible: true, tasksVisible: true, launchAtLogin: false, language: "zh-CN", uiTheme: "classic" }),
    saveGeneral: (c) => Promise.resolve(c as GeneralSettings),
    openSidebar: () => {},
    closeSidebar: () => {},
    openTasks: () => {},
    closeTasks: () => {},
    setPetAlwaysOnTop: () => {},
    setPetVisible: () => {},
    setPetZoom: () => {},
    openStickerManager: async () => ({ ok: false, error: "settings api unavailable" }),
    securityGetStatus: async () => ({ available: false, backend: "不可用", protectedCount: 0, plaintextCount: 0, lockedCount: 0 }),
    securityMigrate: async () => ({ available: false, backend: "不可用", protectedCount: 0, plaintextCount: 0, lockedCount: 0 }),
    securityRestartApp: () => {},
    backupGetConfig: async () => ({ autoEnabled: false, retentionDays: 7 }),
    backupSaveConfig: async (patch) => ({ autoEnabled: patch.autoEnabled ?? false, retentionDays: patch.retentionDays ?? 7 }),
    backupCreate: async () => null,
    backupPickInspect: async () => null,
    backupRestore: async () => ({ restoredFiles: 0, safetyBackupPath: "" }),
    stickerPickFile: async () => null,
    stickerAdd: async () => { throw new Error("settings api unavailable"); },
    setToolEnabled: async () => ({ ok: false, error: "settings api unavailable" }),
    getToolEnabled: async () => ({}),
    listSkills: async () => [],
    setSkillEnabled: async () => ({ ok: false, error: "settings api unavailable" }),
    addMcpServer: async () => ({ ok: false, error: "settings api unavailable" }),
    removeMcpServer: async () => ({ ok: false, error: "settings api unavailable" }),
    listMcpServers: async () => [],
    channelsDiscordGetProfile: async () => ({ connected: false, guildCount: 0, guilds: [], voiceActive: false }),
    channelsDiscordGetMusicState: async () => ({ active: false, paused: false, current: null, queue: [], volume: 100, repeat: "off", shuffle: false, autoplay: false, elapsed: 0 }),
    channelsDiscordGetMusicHistory: async () => [],
    channelsDiscordGetMusicFavorites: async () => [],
    channelsDiscordControlMusic: async () => ({ ok: false, message: "settings api unavailable" }),
    channelsDiscordUpdateProfile: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsDiscordPickAvatar: async () => null,
    channelsDiscordPickBanner: async () => null,
    channelsSpotifyAuthorize: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsSpotifyGetStatus: async () => ({ configured: false, connected: false, devices: [] }),
    channelsSpotifyControl: async () => ({ ok: false, message: "settings api unavailable" }),
    channelsSpotifyDisconnect: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsBilibiliConnect: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsBilibiliGetStatus: async () => ({ connected: false, browser: "Opera GX", profilePath: "" }),
    channelsBilibiliDisconnect: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsGetConfig: async () => ({
      wechat: { enabled: false },
      feishu: { enabled: false },
      discord: { enabled: false, requireMention: true, voiceEnabled: true },
      spotify: { enabled: false },
      bilibili: { enabled: false, browser: "opera-gx" },
      rateLimitPerUser: 10,
      rateLimitPerChannel: 100,
      ttsEnabled: true,
      stickerEnabled: true,
      mirrorToDesktop: true,
      toolSandbox: "safe-only",
    }),
    channelsSaveConfig: async () => ({}),
    channelsList: async () => [],
    channelsGetStatus: async () => ({
      wechat: { phase: "offline", message: "預覽模式" },
      feishu: { phase: "offline", message: "預覽模式" },
      discord: { phase: "offline", message: "預覽模式" },
    }),
    channelsRestart: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsWechatInstall: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsWechatLoginStart: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsWechatLoginCancel: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsWechatPairingList: async () => [],
    channelsWechatPairingApprove: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsWechatLogout: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsWechatRuntimeDetect: async () => ({ available: false }),
    channelsWechatRuntimeInstall: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsWechatRuntimeUpdate: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsFeishuTestConnection: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsFeishuTestWebhookReachable: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsDiscordTestConnection: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsLogGet: async () => [],
    channelsLogClear: async () => ({}),
    onChannelsInstallProgress: () => () => {},
    onChannelsStatusChanged: () => () => {},
    onChannelsWechatQrcode: () => () => {},
    onChannelsWechatLoginDone: () => () => {},
  };
}

if (!window.cyreneScheduler) {
  (window as unknown as { cyreneScheduler: SchedulerApi }).cyreneScheduler = {
    list: async () => ({ ok: true, value: [] }),
    add: async () => ({ ok: false, error: "scheduler api unavailable" }),
    update: async () => ({ ok: false, error: "scheduler api unavailable" }),
    delete: async () => ({ ok: false, error: "scheduler api unavailable" }),
    toggle: async () => ({ ok: false, error: "scheduler api unavailable" }),
    fireNow: async () => ({ ok: false, reason: "scheduler api unavailable" }),
    getHistory: async () => ({ ok: true, value: [] }),
    getTools: async () => ({ ok: true, value: [] }),
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

const schedulerNewBtn = document.getElementById("scheduler-new-btn") as HTMLButtonElement | null;
const schedulerEmpty = document.getElementById("scheduler-empty") as HTMLDivElement | null;
const schedulerList = document.getElementById("scheduler-list") as HTMLDivElement | null;
const schedulerEditor = document.getElementById("scheduler-editor") as HTMLDivElement | null;
const schedulerEditorTitle = document.getElementById("scheduler-editor-title") as HTMLHeadingElement | null;
const schedulerEditorClose = document.getElementById("scheduler-editor-close") as HTMLButtonElement | null;
const schedulerTitleInput = document.getElementById("scheduler-title") as HTMLInputElement | null;
const schedulerPromptInput = document.getElementById("scheduler-prompt") as HTMLTextAreaElement | null;
const schedulerEnabledInput = document.getElementById("scheduler-enabled") as HTMLInputElement | null;
const schedulerKindInput = document.getElementById("scheduler-kind") as HTMLSelectElement | null;
const schedulerOnceRunAtInput = document.getElementById("scheduler-once-run-at") as HTMLInputElement | null;
const schedulerTimeOfDayInput = document.getElementById("scheduler-time-of-day") as HTMLInputElement | null;
const schedulerDayOfWeekInput = document.getElementById("scheduler-day-of-week") as HTMLSelectElement | null;
const schedulerIntervalEveryInput = document.getElementById("scheduler-interval-every") as HTMLInputElement | null;
const schedulerIntervalUnitInput = document.getElementById("scheduler-interval-unit") as HTMLSelectElement | null;
const schedulerToolLimitInput = document.getElementById("scheduler-tool-limit") as HTMLInputElement | null;
const schedulerToolPicker = document.getElementById("scheduler-tool-picker") as HTMLDivElement | null;
const schedulerToolEmptyHint = document.getElementById("scheduler-tool-empty-hint") as HTMLDivElement | null;
const schedulerSaveStatus = document.getElementById("scheduler-save-status") as HTMLDivElement | null;
const schedulerCancelBtn = document.getElementById("scheduler-cancel-btn") as HTMLButtonElement | null;
const schedulerSaveBtn = document.getElementById("scheduler-save-btn") as HTMLButtonElement | null;

let schedulerTasks: ScheduledTask[] = [];
let schedulerTools: SchedulerToolInfo[] = [];
let editingSchedulerTaskId: string | null = null;

const presetSelect = document.getElementById("preset-select") as HTMLSelectElement;
const presetWebsiteLink = document.getElementById("preset-website-link") as HTMLAnchorElement;
// 模式按鈕已刪除——baseUrl 永遠可改、模型名永遠可手填（datalist 出預設建議）
// provider 不再暴露給用戶（從預設內部拿，保證 capabilities 匹配不出錯）。
// 用戶看到的是"暱稱"框——給模型起自定義名字，狀態欄"正在餵養"顯示它。
const displayNameInput = document.getElementById("display-name") as HTMLInputElement;
const baseUrlInput = document.getElementById("base-url") as HTMLInputElement;
const baseUrlResetBtn = document.getElementById("base-url-reset-btn") as HTMLButtonElement;
const modelInput = document.getElementById("model-input") as HTMLInputElement;
const modelInputSuggestions = document.getElementById("model-input-suggestions") as HTMLDataListElement;
const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
const testConnectionBtn = document.getElementById("test-connection-btn") as HTMLButtonElement | null;
const quickApiButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-api-source]"));
// API 協議下拉（auto / openai / anthropic）—— 用戶顯式 override transport
const transportSelect = document.getElementById("transport-select") as HTMLSelectElement;

// 視覺模型配置區元素
// 同步主模型改為膠囊按鈕組：[與主聊天模型相同] / [獨立配置]
const visionSyncBlocks = document.getElementById("vision-sync-blocks") as HTMLElement;
const visionSyncMainBtn = visionSyncBlocks.querySelector('[data-vision-sync="main"]') as HTMLButtonElement;
const visionSyncIndepBtn = visionSyncBlocks.querySelector('[data-vision-sync="independent"]') as HTMLButtonElement;
const visionBaseUrlInput = document.getElementById("vision-base-url") as HTMLInputElement;
const visionApiKeyInput = document.getElementById("vision-api-key") as HTMLInputElement;
const visionModelInput = document.getElementById("vision-model") as HTMLInputElement;
const visionFieldsWrap = document.querySelector(".vision-fields") as HTMLElement;
const testVisionBtn = document.getElementById("test-vision-btn") as HTMLButtonElement;
const visionTestStatus = document.getElementById("vision-test-status") as HTMLElement;

// 渲染端內存緩存：保存每個廠商上一次填寫的 baseUrl / model / apiKey
// 切廠商時從這裡讀，保存時同步進去；持久化由 main 進程的 saveModelSettings 負責（perProvider 字段）。
const providerProfileCache: Record<string, ProviderProfile> = {};

// 當前激活的廠商：每次 applyPreset 後更新；用於"切到下一家廠商前先把當前那家的輸入框值緩存住"
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
const petChatInputEnabledInput = document.getElementById("pet-chat-input-enabled") as HTMLInputElement;
const petZoomInput = document.getElementById("pet-zoom") as HTMLInputElement;
const petZoomVal = document.getElementById("pet-zoom-val") as HTMLElement;
const launchAtLoginInput = document.getElementById("launch-at-login") as HTMLInputElement;
const uiThemeSelect = document.getElementById("ui-theme-select") as HTMLElement;
const languageSelect = document.getElementById("language-select") as HTMLElement;
const sidebarVisibleInput = document.getElementById("sidebar-visible") as HTMLInputElement;
const tasksVisibleInput = document.getElementById("tasks-visible") as HTMLInputElement;
const clearChatHistoryBtn = document.getElementById("clear-chat-history-btn") as HTMLButtonElement;
const openStickerManagerBtn = document.getElementById("open-sticker-manager-btn") as HTMLButtonElement;
const addStickerBtn = document.getElementById("add-sticker-btn") as HTMLButtonElement;
const stickerThresholdInput = document.getElementById("sticker-threshold") as HTMLInputElement;
const stickerThresholdVal = document.getElementById("sticker-threshold-val") as HTMLElement;

const NAV_LABELS: Record<string, { emoji: string; title: string; hint: string }> = {
  memory: { emoji: "🧠", title: "記憶", hint: "管理長期記憶與畫像" },
  chat: { emoji: "💬", title: "聊天", hint: "管理聊天窗口與會話" },
  user: { emoji: "👤", title: "用戶信息", hint: "編輯你的個人資料" },
  tasks: { emoji: "⏰", title: "定時任務", hint: "管理定時提醒與日程" },
  identity: { emoji: "💼", title: "職位", hint: "自定義昔漣的身份定位與工作職責" },
  skills: { emoji: "✨", title: "Skill", hint: "管理 agent 的 skill 指令（約束如何用工具）" },
  plugins: { emoji: "🔌", title: "插件", hint: "擴展功能與第三方集成" },
  general: { emoji: "⚙️", title: "設置", hint: "通用偏好與外觀" },
  api: { emoji: "🔑", title: "API 設置", hint: "選擇預設後只需要填寫 API Key。" },
  cyrene: { emoji: "🌸", title: "昔漣設置", hint: "管理 Agent 行為、記憶、RAG 與權限" },
  channels: { emoji: "📱", title: "連接手機", hint: "管理 Discord、Spotify、飛書與微信連線" },
  tts: { emoji: "🎙️", title: "TTS 設置", hint: "語音合成與朗讀偏好" },
  asr: { emoji: "🎧", title: "ASR 設置", hint: "語音識別與通話配置" },
  tokens: { emoji: "📊", title: "Token 用量", hint: "查看 API 調用統計與消耗" },
  security: { emoji: "🛡️", title: "資料安全", hint: "備份回憶並保護本機密鑰" },
  disclaimer: { emoji: "📜", title: "免責聲明", hint: "使用條款與隱私說明" },
  "channels-discord": { emoji: "💬", title: "Discord", hint: "管理 Bot 身分、連線與回覆規則" },
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

function normalizeUiTheme(theme: unknown): GeneralSettings["uiTheme"] {
  if (theme === "polished-pink" || theme === "pearl-white") return theme;
  return "classic";
}

function getUiThemeValue(): GeneralSettings["uiTheme"] {
  const value = uiThemeSelect.querySelector<HTMLButtonElement>(".option-block.is-active")?.dataset.theme;
  return normalizeUiTheme(value);
}

function applyUiThemeSelection(theme: GeneralSettings["uiTheme"]): void {
  uiThemeSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const active = button.dataset.theme === theme;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.documentElement.dataset.uiTheme = theme;
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
      option.textContent = (preset.selectLabel ?? preset.providerName) + "（暫未適配）";
      option.disabled = true;
    } else {
      option.textContent = preset.selectLabel ?? preset.providerName;
    }
    presetSelect.appendChild(option);
  }
}

function findPreset(providerName: string): ModelPreset {
  // fallback：找不到匹配的預設時，回退到列表第一個可用項（當前是 OpenRouter）。
  // 不直接返回 MODEL_PRESETS[0] 是為了未來若把首項改成 disabled 也仍然合法。
  const fallback = MODEL_PRESETS.find((preset) => !preset.disabled) ?? MODEL_PRESETS[0];
  return MODEL_PRESETS.find((preset) => preset.providerName === providerName) ?? fallback;
}

/**
 * 填充模型名輸入框 + datalist 聯想建議。
 * 模式按鈕已刪除——只有一個輸入框，可手填，按方向鍵也能從廠商預設裡選。
 */
function fillModelOptions(preset: ModelPreset, preferredModel?: string): void {
  // datalist 聯想建議
  modelInputSuggestions.replaceChildren();
  for (const model of preset.mainModels) {
    const option = document.createElement("option");
    option.value = model;
    modelInputSuggestions.appendChild(option);
  }

  // 選中值：preferredModel 命中預設則用之；否則用預設首項；
  // preferredModel 不在預設裡（用戶自填型號）也保留顯示，不強行清空。
  const fallback = preset.mainModels[0] ?? "";
  modelInput.value = preferredModel ?? fallback;
}

/**
 * 把"當前輸入框裡的值"快照到內存緩存裡（perProvider）。
 * 切廠商前調用一次，避免覆蓋丟失。
 */
function captureActiveProviderProfile(): void {
  if (!activeProvider) return;
  providerProfileCache[activeProvider] = {
    baseUrl: baseUrlInput.value.trim(),
    model: getCurrentModelValue().trim(),
    apiKey: apiKeyInput.value.trim(),
    displayName: displayNameInput.value.trim(),
    explicitTransport: transportSelect.value as ProviderProfile["explicitTransport"],
  };
}

function syncQuickApiSelection(): void {
  for (const button of quickApiButtons) {
    const active = button.dataset.apiSource === activeProvider;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    const state = button.querySelector<HTMLElement>(".api-source-card__state");
    if (state) state.textContent = active ? "使用中" : "選擇";
  }
}

/** 模式按鈕已刪除——模型名永遠從 input 讀取。保留函數名供舊調用點用，語義不變。 */
function getCurrentModelValue(): string {
  return modelInput.value;
}

/**
 * 視覺同步 UI（膠囊按鈕組）：
 * - 選"與主聊天模型相同"：三框變只讀 + 值隨主配置
 * - 選"獨立配置"：三框可編輯
 * baseUrl 特殊處理：若當前廠商標了 visionBaseUrl（主配走 Anthropic 入口、視覺要走 OpenAI 入口），
 * 用 visionBaseUrl 填視覺框，讓用戶看到的就是正確的視覺入口，不用手動改。
 */
function applyVisionSyncUI(): void {
  const synced = visionSyncMainBtn.classList.contains("is-active");
  if (synced) {
    visionFieldsWrap.classList.add("is-locked");
    // 找當前廠商 preset，看有沒有 visionBaseUrl
    const preset = findPreset(activeProvider);
    const visionBaseUrl = preset?.visionBaseUrl || baseUrlInput.value;
    visionBaseUrlInput.value = visionBaseUrl;
    visionApiKeyInput.value = apiKeyInput.value;
    visionModelInput.value = getCurrentModelValue();
  } else {
    visionFieldsWrap.classList.remove("is-locked");
  }
}

/** 切換視覺同步膠囊按鈕的激活態。synced=true 激活"與主相同"，false 激活"獨立配置"。 */
function setVisionSyncState(synced: boolean): void {
  visionSyncMainBtn.classList.toggle("is-active", synced);
  visionSyncMainBtn.setAttribute("aria-pressed", String(synced));
  visionSyncIndepBtn.classList.toggle("is-active", !synced);
  visionSyncIndepBtn.setAttribute("aria-pressed", String(!synced));
}

function applyPreset(providerName: string, preferredModel?: string, preferredApiKey?: string, preferredBaseUrl?: string, preferredDisplayName?: string, preferredExplicitTransport?: "openai" | "anthropic" | "auto"): void {
  const preset = findPreset(providerName);

  // 模式按鈕已刪除——ChatGPT / Claude 這種沒預設型號的廠商，input 框空著讓用戶手填，
  // datalist 沒建議也不影響（用戶知道自己型號）。

  presetSelect.value = preset.providerName;

  // 暱稱：優先用傳入的（用戶自定義過）；否則用廠商 shortName 作默認。
  // 留空顯示廠商短名——但這裡主動填 shortName 讓用戶看到默認值，可改可清。
  displayNameInput.value = preferredDisplayName ?? preset.shortName;

  // baseUrl：優先用緩存（用戶自定義過），其次用 preset 默認
  baseUrlInput.value = preferredBaseUrl ?? preset.baseUrl;

  fillModelOptions(preset, preferredModel);

  // apiKey：優先用緩存；否則**顯式清空**——避免上一家廠商的 key 殘留在輸入框裡被用戶誤點保存。
  // 這是 v1 切廠商行為裡的關鍵不變量：apiKey 永遠只跟當前廠商綁定。
  apiKeyInput.value = preferredApiKey ?? preset.defaultApiKey ?? "";

  // explicitTransport：優先用緩存（用戶自定義過），其次默認 "auto"
  // （切廠商時上一家的 explicitTransport 不應該延續，preset 自帶 capabilities transport 兜底）
  transportSelect.value = preferredExplicitTransport ?? "auto";

  // 官網鏈接：有 websiteUrl 就顯示並指向，沒有就隱藏。
  if (preset.websiteUrl) {
    presetWebsiteLink.href = preset.websiteUrl;
    presetWebsiteLink.title = `前往 ${preset.shortName} 官網`;
    presetWebsiteLink.style.display = "";
  } else {
    presetWebsiteLink.style.display = "none";
  }

  activeProvider = preset.providerName;
  syncQuickApiSelection();
}

async function loadConfig(): Promise<void> {
  try {
    fillPresetOptions();
    const cfg = await window.settings!.getConfig();
    // 模式按鈕已刪除——mode 字段不再用 UI 控制，直接忽略 cfg.mode
    // 把 main 進程返回的 perProvider 灌進渲染端內存緩存，切廠商時用到
    if (cfg.perProvider && typeof cfg.perProvider === "object") {
      for (const [key, value] of Object.entries(cfg.perProvider)) {
        if (value && typeof value === "object") {
          providerProfileCache[key] = {
            baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
            model: typeof value.model === "string" ? value.model : "",
            apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
            displayName: typeof (value as { displayName?: unknown }).displayName === "string"
              ? (value as { displayName: string }).displayName
              : undefined,
            explicitTransport: (value as { explicitTransport?: "openai" | "anthropic" | "auto" }).explicitTransport,
          };
        }
      }
    }
    // 舊版把 Google Gemini 存在 ChatGPT profile 下。保留原資料並映射到新的專屬 Gemini 卡，
    // 讓用戶無需重新輸入已加密保存的 API Key。
    const legacyGemini = providerProfileCache["ChatGPT（OpenAI）"];
    if (
      !providerProfileCache["Gemini（Google）"]
      && legacyGemini?.baseUrl.includes("generativelanguage.googleapis.com")
    ) {
      providerProfileCache["Gemini（Google）"] = {
        ...legacyGemini,
        displayName: legacyGemini.displayName || "Gemini 3.5 Flash",
      };
    }
    const loadedProvider = cfg.provider === "ChatGPT（OpenAI）"
      && cfg.baseUrl.includes("generativelanguage.googleapis.com")
      ? "Gemini（Google）"
      : cfg.provider;
    applyPreset(loadedProvider, cfg.model, cfg.apiKey, cfg.baseUrl, cfg.displayName, cfg.explicitTransport);
    applyRuntimeSyncSelection(cfg.runtimeSync);
    stickerEnabledInput.checked = cfg.stickerEnabled !== false;
    applyStickerSizeSelection(cfg.stickerSize);
    const threshold = cfg.stickerSimilarityThreshold ?? 0.55;
    stickerThresholdInput.value = String(threshold);
    stickerThresholdVal.textContent = threshold.toFixed(2);

    // 視覺模型配置
    const vision = cfg.vision;
    if (vision) {
      setVisionSyncState(vision.syncWithMain);
      visionBaseUrlInput.value = vision.baseUrl || "";
      visionApiKeyInput.value = vision.apiKey || "";
      visionModelInput.value = vision.model || "";
    } else {
      // 用戶從未配過視覺。按當前主模型 supportsVision 決定默認——
      // 多模態主模型用戶開箱即用（默認"與主相同"），非視覺主模型則默認"獨立配置"。
      const preset = findPreset(cfg.provider);
      setVisionSyncState(preset?.supportsVision === true);
      visionBaseUrlInput.value = "";
      visionApiKeyInput.value = "";
      visionModelInput.value = "";
    }
    applyVisionSyncUI();

    setSaveStatus("等待保存");
    setCyreneSaveStatus("等待保存");
  } catch {
    fillPresetOptions();
    applyPreset("Custom");
    setSaveStatus("讀取配置失敗", "is-error");
    setCyreneSaveStatus("讀取配置失敗", "is-error");
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
    petChatInputEnabledInput.checked = cfg.petChatInputEnabled ?? false;
    petZoomInput.value = String(cfg.petZoom ?? 1);
    petZoomVal.textContent = Math.round((cfg.petZoom ?? 1) * 100) + "%";
    sidebarVisibleInput.checked = cfg.sidebarVisible ?? true;
    tasksVisibleInput.checked = cfg.tasksVisible ?? true;
    launchAtLoginInput.checked = cfg.launchAtLogin;
    applyUiThemeSelection(normalizeUiTheme(cfg.uiTheme));
    applyLanguageSelection("zh-CN");
    setGeneralSaveStatus("等待保存");
  } catch {
    setGeneralSaveStatus("讀取設置失敗", "is-error");
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

stickerThresholdInput.addEventListener("input", () => {
  stickerThresholdVal.textContent = parseFloat(stickerThresholdInput.value).toFixed(2);
  setCyreneSaveStatus("有未保存的更改");
});

sidebarVisibleInput.addEventListener("change", () => {
  if (sidebarVisibleInput.checked) window.settings?.openSidebar();
  else window.settings?.closeSidebar();
  void window.settings?.saveGeneral({ sidebarVisible: sidebarVisibleInput.checked });
});

tasksVisibleInput.addEventListener("change", () => {
  if (tasksVisibleInput.checked) window.settings?.openTasks();
  else window.settings?.closeTasks();
  void window.settings?.saveGeneral({ tasksVisible: tasksVisibleInput.checked });
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
petChatInputEnabledInput.addEventListener("change", () => {
  void window.settings?.saveGeneral({ petChatInputEnabled: petChatInputEnabledInput.checked });
});
petZoomInput.addEventListener("input", () => {
  petZoomVal.textContent = Math.round(Number(petZoomInput.value) * 100) + "%";
});
petZoomInput.addEventListener("change", () => {
  window.settings?.setPetZoom(Number(petZoomInput.value));
});

uiThemeSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    const theme = normalizeUiTheme(button.dataset.theme);
    applyUiThemeSelection(theme);
    setGeneralSaveStatus("有未保存的更改");
  });
});

openStickerManagerBtn.addEventListener("click", async () => {
  console.log("[settings] open sticker manager clicked");
  try {
    const result = await window.settings?.openStickerManager();
    if (!result?.ok) {
      console.error("[settings] open sticker manager failed", result?.error);
      window.alert("表情包管理窗口打開失敗，請查看終端日誌。" + (result?.error ? `\n${result.error}` : ""));
    }
  } catch (error) {
    console.error("[settings] open sticker manager error", error);
    window.alert("表情包管理窗口打開失敗，請查看終端日誌。");
  }
});

// ── 添加表情包彈窗 ──
const stickerAddOverlay = document.getElementById("sticker-add-overlay") as HTMLElement;
const stickerAddPickBtn = document.getElementById("sticker-add-pick-btn") as HTMLButtonElement;
const stickerAddFileName = document.getElementById("sticker-add-file-name") as HTMLElement;
const stickerAddId = document.getElementById("sticker-add-id") as HTMLInputElement;
const stickerAddDesc = document.getElementById("sticker-add-desc") as HTMLInputElement;
const stickerAddPhrases = document.getElementById("sticker-add-phrases") as HTMLTextAreaElement;
const stickerAddError = document.getElementById("sticker-add-error") as HTMLElement;
const stickerAddConfirm = document.getElementById("sticker-add-confirm") as HTMLButtonElement;
const stickerAddCancel = document.getElementById("sticker-add-cancel") as HTMLButtonElement;

let stickerAddPickedPath: string | null = null;

function openStickerAddModal(): void {
  stickerAddPickedPath = null;
  stickerAddFileName.textContent = "未選擇";
  stickerAddId.value = "";
  stickerAddDesc.value = "";
  stickerAddPhrases.value = "";
  stickerAddError.classList.add("is-hidden");
  stickerAddOverlay.classList.remove("is-hidden");
}

function closeStickerAddModal(): void {
  stickerAddOverlay.classList.add("is-hidden");
}

addStickerBtn.addEventListener("click", openStickerAddModal);
stickerAddCancel.addEventListener("click", closeStickerAddModal);

stickerAddPickBtn.addEventListener("click", async () => {
  const filePath = await window.settings?.stickerPickFile?.();
  if (filePath) {
    stickerAddPickedPath = filePath;
    const name = filePath.split(/[\\/]/).pop() || filePath;
    stickerAddFileName.textContent = name;
    if (!stickerAddId.value) {
      const baseName = name.replace(/\.[^.]+$/, "");
      stickerAddId.value = baseName.replace(/[^a-zA-Z0-9_-]/g, "");
    }
  }
});

stickerAddConfirm.addEventListener("click", async () => {
  stickerAddError.classList.add("is-hidden");

  if (!stickerAddPickedPath) {
    stickerAddError.textContent = "請先選擇圖片文件";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const id = stickerAddId.value.trim();
  if (!id) {
    stickerAddError.textContent = "請填寫英文名稱";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    stickerAddError.textContent = "名稱只能用英文字母、數字、下劃線和連字符";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const description = stickerAddDesc.value.trim();
  if (!description) {
    stickerAddError.textContent = "請填寫圖片描述";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const phrases = stickerAddPhrases.value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (phrases.length === 0) {
    stickerAddError.textContent = "請至少寫一行相近語義";
    stickerAddError.classList.remove("is-hidden");
    return;
  }

  try {
    await window.settings?.stickerAdd?.({ sourcePath: stickerAddPickedPath, id, description, phrases });
    closeStickerAddModal();
  } catch (err) {
    stickerAddError.textContent = "添加失敗：" + (err as Error).message;
    stickerAddError.classList.remove("is-hidden");
  }
});

// ── 插件開關事件 ──────────────────────────────────────────
// 文檔檢索/用戶記憶/世界書/聯網搜索為常駐工具，無開關，顯示綠燈。
// 天氣查詢/聯網搜索有獨立配置卡片（下方）。

// ── 天氣插件（Open-Meteo / 高德天氣）──
const weatherEnabledCheckbox = document.getElementById("plugin-weather-enabled") as HTMLInputElement | null;
const weatherConfig = document.getElementById("plugin-weather-config") as HTMLElement | null;
const weatherSourceSelect = document.getElementById("weather-source") as HTMLSelectElement | null;
const amapFields = document.getElementById("amap-fields");
const amapKeyInput = document.getElementById("amap-key") as HTMLInputElement | null;

// 啟用開關：勾上才展開配置區
function syncWeatherConfigVisibility(): void {
  if (weatherConfig) weatherConfig.style.display = weatherEnabledCheckbox?.checked ? "block" : "none";
  syncWeatherFieldsVisibility();
}
function syncWeatherFieldsVisibility(): void {
  const src = weatherSourceSelect?.value ?? "open-meteo";
  // 選高德才顯示高德 Key 輸入框
  if (amapFields) amapFields.style.display = src === "amap" ? "block" : "none";
}
weatherEnabledCheckbox?.addEventListener("change", () => {
  syncWeatherConfigVisibility();
  void saveWeatherField("weatherEnabled", weatherEnabledCheckbox.checked);
});
weatherSourceSelect?.addEventListener("change", () => {
  syncWeatherFieldsVisibility();
  void saveWeatherField("weatherSource", weatherSourceSelect.value);
});
amapKeyInput?.addEventListener("change", () => {
  void saveWeatherField("amapKey", amapKeyInput.value.trim());
});
// 防抖保存：粘貼後 800ms 自動保存
amapKeyInput?.addEventListener("input", () => {
  clearTimeout(amapKeyDebounceTimer);
  amapKeyDebounceTimer = setTimeout(() => {
    void saveWeatherField("amapKey", amapKeyInput.value.trim());
  }, 800);
});
let amapKeyDebounceTimer: ReturnType<typeof setTimeout> | undefined;

async function saveWeatherField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[plugins] 保存天氣配置失敗:", field, err);
  }
}

async function loadWeatherConfig(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg && weatherEnabledCheckbox) {
      weatherEnabledCheckbox.checked = Boolean(cfg.weatherEnabled);
    }
    if (cfg && weatherSourceSelect) {
      weatherSourceSelect.value = cfg.weatherSource === "amap" ? "amap" : "open-meteo";
    }
    if (cfg && amapKeyInput) {
      amapKeyInput.value = String(cfg.amapKey ?? "");
    }
    syncWeatherConfigVisibility();
  } catch (err) {
    console.warn("[plugins] 加載天氣配置失敗", err);
  }
}
void loadWeatherConfig();

// ── 🚗出行工具 ──
const travelEnabledCheckbox = document.getElementById("plugin-travel-enabled") as HTMLInputElement | null;
const travelConfig = document.getElementById("plugin-travel-config") as HTMLElement | null;
const travelAmapKeyInput = document.getElementById("travel-amap-key") as HTMLInputElement | null;

function syncTravelConfigVisibility(): void {
  if (travelConfig) travelConfig.style.display = travelEnabledCheckbox?.checked ? "block" : "none";
}
travelEnabledCheckbox?.addEventListener("change", () => {
  syncTravelConfigVisibility();
  void saveTravelField("travelEnabled", travelEnabledCheckbox.checked);
});
travelAmapKeyInput?.addEventListener("change", () => {
  // 存到同一個 amapKey 字段（與天氣查詢共用）
  void saveTravelField("amapKey", travelAmapKeyInput.value.trim());
});
// 防抖保存：粘貼後 800ms 自動保存
let travelAmapKeyDebounceTimer: ReturnType<typeof setTimeout> | undefined;
travelAmapKeyInput?.addEventListener("input", () => {
  clearTimeout(travelAmapKeyDebounceTimer);
  travelAmapKeyDebounceTimer = setTimeout(() => {
    void saveTravelField("amapKey", travelAmapKeyInput.value.trim());
  }, 800);
});

async function saveTravelField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[plugins] 保存出行配置失敗:", field, err);
  }
}

async function loadTravelConfig(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg && travelEnabledCheckbox) {
      travelEnabledCheckbox.checked = Boolean(cfg.travelEnabled);
    }
    if (cfg && travelAmapKeyInput) {
      travelAmapKeyInput.value = String(cfg.amapKey ?? "");
    }
    syncTravelConfigVisibility();
  } catch (err) {
    console.warn("[plugins] 加載出行配置失敗", err);
  }
}
void loadTravelConfig();

// ── ✉️郵件發送插件 ──
const emailEnabledCheckbox = document.getElementById("plugin-email-enabled") as HTMLInputElement | null;
const emailConfig = document.getElementById("plugin-email-config") as HTMLElement | null;
const emailSmtpHostInput = document.getElementById("email-smtp-host") as HTMLInputElement | null;
const emailSmtpPortInput = document.getElementById("email-smtp-port") as HTMLInputElement | null;
const emailSmtpSecureInput = document.getElementById("email-smtp-secure") as HTMLInputElement | null;
const emailSmtpUserInput = document.getElementById("email-smtp-user") as HTMLInputElement | null;
const emailSmtpPassInput = document.getElementById("email-smtp-pass") as HTMLInputElement | null;
const emailFromNameInput = document.getElementById("email-from-name") as HTMLInputElement | null;

function syncEmailConfigVisibility(): void {
  if (emailConfig) emailConfig.style.display = emailEnabledCheckbox?.checked ? "block" : "none";
}
emailEnabledCheckbox?.addEventListener("change", () => {
  syncEmailConfigVisibility();
  void saveEmailField("emailEnabled", emailEnabledCheckbox.checked);
});

// 防抖保存：每個字段獨立 timer，避免連續填寫多個字段時只有最後一個被保存
let emailSmtpHostTimer: ReturnType<typeof setTimeout> | undefined;
let emailSmtpPortTimer: ReturnType<typeof setTimeout> | undefined;
let emailSmtpUserTimer: ReturnType<typeof setTimeout> | undefined;
let emailSmtpPassTimer: ReturnType<typeof setTimeout> | undefined;
let emailFromNameTimer: ReturnType<typeof setTimeout> | undefined;

emailSmtpHostInput?.addEventListener("input", () => { clearTimeout(emailSmtpHostTimer); emailSmtpHostTimer = setTimeout(() => void saveEmailField("emailSmtpHost", emailSmtpHostInput.value.trim()), 800); });
emailSmtpPortInput?.addEventListener("input", () => { clearTimeout(emailSmtpPortTimer); emailSmtpPortTimer = setTimeout(() => void saveEmailField("emailSmtpPort", Number(emailSmtpPortInput.value) || 465), 800); });
emailSmtpSecureInput?.addEventListener("change", () => void saveEmailField("emailSmtpSecure", emailSmtpSecureInput.checked));
emailSmtpUserInput?.addEventListener("input", () => { clearTimeout(emailSmtpUserTimer); emailSmtpUserTimer = setTimeout(() => void saveEmailField("emailSmtpUser", emailSmtpUserInput.value.trim()), 800); });
emailSmtpPassInput?.addEventListener("input", () => { clearTimeout(emailSmtpPassTimer); emailSmtpPassTimer = setTimeout(() => void saveEmailField("emailSmtpPass", emailSmtpPassInput.value.trim()), 800); });
emailFromNameInput?.addEventListener("input", () => { clearTimeout(emailFromNameTimer); emailFromNameTimer = setTimeout(() => void saveEmailField("emailFromName", emailFromNameInput.value.trim()), 800); });

async function saveEmailField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[plugins] 保存郵件配置失敗:", field, err);
  }
}

async function loadEmailConfig(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg && emailEnabledCheckbox) {
      emailEnabledCheckbox.checked = Boolean(cfg.emailEnabled);
    }
    if (cfg && emailSmtpHostInput) {
      emailSmtpHostInput.value = String(cfg.emailSmtpHost ?? "");
    }
    if (cfg && emailSmtpPortInput) {
      emailSmtpPortInput.value = String(cfg.emailSmtpPort ?? 465);
    }
    if (cfg && emailSmtpSecureInput) {
      emailSmtpSecureInput.checked = Boolean(cfg.emailSmtpSecure);
    }
    if (cfg && emailSmtpUserInput) {
      emailSmtpUserInput.value = String(cfg.emailSmtpUser ?? "");
    }
    if (cfg && emailSmtpPassInput) {
      emailSmtpPassInput.value = String(cfg.emailSmtpPass ?? "");
    }
    if (cfg && emailFromNameInput) {
      emailFromNameInput.value = String(cfg.emailFromName ?? "");
    }
    syncEmailConfigVisibility();
  } catch (err) {
    console.warn("[plugins] 加載郵件配置失敗", err);
  }
}
void loadEmailConfig();

// ── 🎧ASR 設置 ──
const asrEngineSelect = document.getElementById("asr-engine") as HTMLSelectElement | null;
const asrAliyunConfig = document.getElementById("asr-aliyun-config");
const asrAliyunAppKeyInput = document.getElementById("asr-aliyun-app-key") as HTMLInputElement | null;
const asrAliyunAccessKeyIdInput = document.getElementById("asr-aliyun-access-key-id") as HTMLInputElement | null;
const asrAliyunAccessKeySecretInput = document.getElementById("asr-aliyun-access-key-secret") as HTMLInputElement | null;
const asrLanguageSelect = document.getElementById("asr-language") as HTMLSelectElement | null;
const asrVadSilenceInput = document.getElementById("asr-vad-silence") as HTMLInputElement | null;
const asrShowTranscriptCheckbox = document.getElementById("asr-show-transcript") as HTMLInputElement | null;
const asrFallbackLocalCheckbox = document.getElementById("asr-fallback-local") as HTMLInputElement | null;
const asrPushToTalkCheckbox = document.getElementById("asr-push-to-talk") as HTMLInputElement | null;

function syncAsrVisibility(): void {
  if (asrAliyunConfig) {
    (asrAliyunConfig as HTMLElement).style.display = asrEngineSelect?.value === "aliyun" ? "block" : "none";
  }
}

asrEngineSelect?.addEventListener("change", () => {
  syncAsrVisibility();
  void saveAsrField("asrEngine", asrEngineSelect.value);
});
// 防抖保存：每個字段獨立 timer，避免連續填寫多個字段時只有最後一個被保存
let asrAliyunAppKeyTimer: ReturnType<typeof setTimeout> | undefined;
let asrAliyunAccessKeyIdTimer: ReturnType<typeof setTimeout> | undefined;
let asrAliyunAccessKeySecretTimer: ReturnType<typeof setTimeout> | undefined;

asrAliyunAppKeyInput?.addEventListener("input", () => { clearTimeout(asrAliyunAppKeyTimer); asrAliyunAppKeyTimer = setTimeout(() => void saveAsrField("asrAliyunAppKey", asrAliyunAppKeyInput.value.trim()), 800); });
asrAliyunAccessKeyIdInput?.addEventListener("input", () => { clearTimeout(asrAliyunAccessKeyIdTimer); asrAliyunAccessKeyIdTimer = setTimeout(() => void saveAsrField("asrAliyunAccessKeyId", asrAliyunAccessKeyIdInput.value.trim()), 800); });
asrAliyunAccessKeySecretInput?.addEventListener("input", () => { clearTimeout(asrAliyunAccessKeySecretTimer); asrAliyunAccessKeySecretTimer = setTimeout(() => void saveAsrField("asrAliyunAccessKeySecret", asrAliyunAccessKeySecretInput.value.trim()), 800); });
asrLanguageSelect?.addEventListener("change", () => void saveAsrField("asrLanguage", asrLanguageSelect.value));
asrVadSilenceInput?.addEventListener("input", () => {
  void saveAsrField("asrVadSilenceMs", Number(asrVadSilenceInput.value) || 1000);
});
asrShowTranscriptCheckbox?.addEventListener("change", () => void saveAsrField("asrShowTranscript", asrShowTranscriptCheckbox.checked));
asrFallbackLocalCheckbox?.addEventListener("change", () => void saveAsrField("asrFallbackToLocal", asrFallbackLocalCheckbox.checked));
asrPushToTalkCheckbox?.addEventListener("change", () => void saveAsrField("asrPushToTalk", asrPushToTalkCheckbox.checked));

async function saveAsrField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[asr] 保存 ASR 配置失敗:", field, err);
  }
}

async function loadAsrConfig(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg) {
      if (asrEngineSelect) asrEngineSelect.value = String(cfg.asrEngine ?? "off");
      if (asrAliyunAppKeyInput) asrAliyunAppKeyInput.value = String(cfg.asrAliyunAppKey ?? "");
      if (asrAliyunAccessKeyIdInput) asrAliyunAccessKeyIdInput.value = String(cfg.asrAliyunAccessKeyId ?? "");
      if (asrAliyunAccessKeySecretInput) asrAliyunAccessKeySecretInput.value = String(cfg.asrAliyunAccessKeySecret ?? "");
      if (asrLanguageSelect) asrLanguageSelect.value = String(cfg.asrLanguage ?? "zh");
      if (asrVadSilenceInput) asrVadSilenceInput.value = String(cfg.asrVadSilenceMs ?? 1000);
      if (asrShowTranscriptCheckbox) asrShowTranscriptCheckbox.checked = Boolean(cfg.asrShowTranscript);
      if (asrFallbackLocalCheckbox) asrFallbackLocalCheckbox.checked = cfg.asrFallbackToLocal !== false;
      if (asrPushToTalkCheckbox) asrPushToTalkCheckbox.checked = Boolean(cfg.asrPushToTalk);
    }
    syncAsrVisibility();
  } catch (err) {
    console.warn("[asr] 加載 ASR 配置失敗", err);
  }
}
void loadAsrConfig();

function downsampleToPcm16(chunks: Float32Array[], sourceRate: number): Uint8Array {
  const samples = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let cursor = 0;
  chunks.forEach((chunk) => { samples.set(chunk, cursor); cursor += chunk.length; });
  const ratio = sourceRate / 16000;
  const output = new Int16Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let source = start; source < end && source < samples.length; source += 1) sum += samples[source];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    output[index] = value < 0 ? value * 32768 : value * 32767;
  }
  return new Uint8Array(output.buffer);
}

document.getElementById("asr-test-btn")?.addEventListener("click", async () => {
  const button = document.getElementById("asr-test-btn") as HTMLButtonElement;
  const status = document.getElementById("asr-test-status");
  const meter = document.getElementById("asr-test-meter");
  const fill = document.getElementById("asr-meter-fill") as HTMLElement | null;
  const transcript = document.getElementById("asr-test-transcript");
  button.disabled = true;
  setSecurityStatus(status, "準備麥克風…");
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    const processor = context.createScriptProcessor(4096, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;
    const chunks: Float32Array[] = [];
    processor.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      let sum = 0;
      for (const sample of data) sum += sample * sample;
      const rms = Math.sqrt(sum / data.length);
      const db = Math.max(-60, 20 * Math.log10(rms || 0.001));
      if (meter) meter.textContent = `${Math.round(db)} dB`;
      if (fill) fill.style.width = `${Math.max(2, Math.min(100, (db + 60) / 60 * 100))}%`;
    };
    source.connect(analyser);
    analyser.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    setSecurityStatus(status, "正在錄音，請說一句話…");
    await new Promise((resolve) => window.setTimeout(resolve, 3000));
    processor.disconnect();
    const pcm = downsampleToPcm16(chunks, context.sampleRate);
    let binary = "";
    for (let offset = 0; offset < pcm.length; offset += 0x8000) binary += String.fromCharCode(...pcm.subarray(offset, offset + 0x8000));
    setSecurityStatus(status, "本機 Whisper 辨識中…");
    const result = await window.agentActivity?.testLocalAsr({ pcmBase64: btoa(binary), language: asrLanguageSelect?.value ?? "zh" });
    if (!result) throw new Error("本機辨識服務未載入");
    setSecurityStatus(status, `完成，延遲 ${(result.latencyMs / 1000).toFixed(1)} 秒`, "is-ok");
    if (transcript) { transcript.textContent = result.text || "（沒有辨識到文字）"; transcript.classList.remove("is-hidden"); }
  } catch (error) {
    setSecurityStatus(status, error instanceof Error ? error.message : String(error), "is-error");
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    await context?.close().catch(() => {});
    button.disabled = false;
  }
});

// ── 聯網搜索插件（博查/Tavily/火山/MiniMax）──
const searchEnabledCheckbox = document.getElementById("plugin-search-enabled") as HTMLInputElement | null;
const searchConfig = document.getElementById("plugin-search-config") as HTMLElement | null;
const searchEngineSelect = document.getElementById("search-engine") as HTMLSelectElement | null;
const searchBochaKeyInput = document.getElementById("search-bocha-key") as HTMLInputElement | null;
const searchTavilyKeyInput = document.getElementById("search-tavily-key") as HTMLInputElement | null;
const searchMinimaxKeyInput = document.getElementById("search-minimax-key") as HTMLInputElement | null;
const searchBochaRow = document.getElementById("search-bocha-row");
const searchTavilyRow = document.getElementById("search-tavily-row");
const searchMinimaxRow = document.getElementById("search-minimax-row");

const SEARCH_ROW_MAP: Record<string, HTMLElement | null> = {
  bocha: searchBochaRow,
  tavily: searchTavilyRow,
  minimax: searchMinimaxRow,
};

const SEARCH_KEY_INPUT_MAP: Record<string, HTMLInputElement | null> = {
  bocha: searchBochaKeyInput,
  tavily: searchTavilyKeyInput,
  minimax: searchMinimaxKeyInput,
};

const SEARCH_KEY_FIELD_MAP: Record<string, string> = {
  bocha: "searchBochaKey",
  tavily: "searchTavilyKey",
  minimax: "searchMinimaxKey",
};

function syncSearchConfigVisibility(): void {
  if (searchConfig) searchConfig.style.display = searchEnabledCheckbox?.checked ? "block" : "none";
  syncSearchEngineRows();
}

function syncSearchEngineRows(): void {
  const engine = searchEngineSelect?.value ?? "off";
  for (const [key, row] of Object.entries(SEARCH_ROW_MAP)) {
    if (row) row.style.display = key === engine ? "flex" : "none";
  }
}

searchEnabledCheckbox?.addEventListener("change", () => {
  syncSearchConfigVisibility();
  // 開關變化時，若開啟則把 searchEngine 從 off 改成第一個有 key 的源（或 bocha）
  if (searchEnabledCheckbox.checked && searchEngineSelect?.value === "off") {
    searchEngineSelect.value = "bocha";
    syncSearchEngineRows();
    void saveSearchField("searchEngine", "bocha");
  } else {
    void saveSearchField("searchEngine", searchEngineSelect?.value ?? "off");
  }
});

searchEngineSelect?.addEventListener("change", () => {
  syncSearchEngineRows();
  void saveSearchField("searchEngine", searchEngineSelect.value);
});

// 各源 key 輸入：失焦保存 + 輸入時防抖保存（防粘貼後未失焦就丟失）
const searchKeyDebounceTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
for (const [engine, input] of Object.entries(SEARCH_KEY_INPUT_MAP)) {
  if (!input) continue;
  const field = SEARCH_KEY_FIELD_MAP[engine];
  input.addEventListener("change", () => { void saveSearchField(field, input.value.trim()); });
  input.addEventListener("blur", () => { void saveSearchField(field, input.value.trim()); });
  // 輸入時防抖保存：粘貼或打字後 800ms 自動保存，不依賴失焦
  input.addEventListener("input", () => {
    clearTimeout(searchKeyDebounceTimers[engine]);
    searchKeyDebounceTimers[engine] = setTimeout(() => {
      void saveSearchField(field, input.value.trim());
    }, 800);
  });
}

async function saveSearchField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[plugins] 保存搜索配置失敗:", field, err);
  }
}

async function loadSearchConfig(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (!cfg) return;
    const engine = String(cfg.searchEngine ?? "off");
    if (searchEngineSelect) searchEngineSelect.value = engine;
    if (searchBochaKeyInput) searchBochaKeyInput.value = String(cfg.searchBochaKey ?? "");
    if (searchTavilyKeyInput) searchTavilyKeyInput.value = String(cfg.searchTavilyKey ?? "");
    if (searchMinimaxKeyInput) searchMinimaxKeyInput.value = String(cfg.searchMinimaxKey ?? "");
    // 開關狀態：engine 不是 off 就算啟用
    if (searchEnabledCheckbox) searchEnabledCheckbox.checked = engine !== "off";
    syncSearchConfigVisibility();
  } catch (err) {
    console.warn("[plugins] 加載搜索配置失敗", err);
  }
}
void loadSearchConfig();

// ── 🌐 內置 MCP 工具開關 ──────────────────────────────────────
// Playwright MCP（瀏覽器自動化）通過 playwrightMcpEnabled 控制，
// main 端的 syncPlaywrightMcp() 會監聽字段變化自動註冊 / 移除 MCP server。
const playwrightMcpCheckbox = document.getElementById("plugin-playwright-mcp-enabled") as HTMLInputElement | null;

async function saveBuiltinMcpField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn(`[settings] 保存 ${field} 失敗:`, err);
  }
}

playwrightMcpCheckbox?.addEventListener("change", () => {
  void saveBuiltinMcpField("playwrightMcpEnabled", playwrightMcpCheckbox.checked);
});

async function loadBuiltinMcpToggles(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg && playwrightMcpCheckbox) {
      // 默認關閉 —— 啟用會下載 Chromium，約 150MB
      playwrightMcpCheckbox.checked = Boolean(cfg.playwrightMcpEnabled);
    }
  } catch (err) {
    console.warn("[settings] 加載內置 MCP 開關失敗:", err);
  }
}
void loadBuiltinMcpToggles();

// ── MCP Server 管理 UI ──────────────────────────────────────
const pluginAddBtn = document.querySelector(".plugin-add-btn") as HTMLButtonElement | null;
console.log("[settings] plugin-add-btn 查詢結果:", pluginAddBtn ? "找到" : "未找到");


// 簡易命令行解析：支持引號包裹的參數
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
  console.log("[settings] ＋ 按鈕被點擊，彈出輸入框…");
  const command = await showInputModal({
    title: "添加 MCP Server",
    message: "輸入啟動命令，例如：node C:\\my-mcp-server\\index.js",
    placeholder: "node path\\to\\server.js --flag",
    icon: "🧩",
  });
  if (!command || !command.trim()) {
    console.log("[settings] 用戶取消或命令為空");
    return;
  }

  const nameInput = await showInputModal({
    title: "MCP Server 名稱",
    message: "給這個 MCP server 起個名字（僅用於展示）",
    placeholder: "例如：天氣工具",
    icon: "🏷️",
  });
  const name = (nameInput && nameInput.trim()) || "未命名 MCP";
  const serverId = "mcp-" + Date.now();
  const parsed = parseCommandLine(command.trim());
  if (!parsed.command) {
    await showModal({ title: "添加失敗", message: "請輸入有效的啟動命令", icon: "⚠️" });
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
      console.log("[settings] MCP server 添加成功，工具數:", result.toolIds?.length);
      await showModal({
        title: "添加成功",
        message: '"' + name + '" 已連接，發現 ' + (result.toolIds?.length || 0) + " 個工具。詳情見終端日誌。",
        icon: "✅",
      });
    } else {
      console.error("[settings] MCP server 添加失敗:", result?.error);
      await showModal({
        title: "添加失敗",
        message: (result?.error || "未知錯誤") + "（詳情見終端日誌）",
        icon: "⚠️",
      });
    }
  } catch (err) {
    console.error("[settings] MCP server 添加異常:", err);
    await showModal({
      title: "添加異常",
      message: "調用過程中發生錯誤，詳情見終端日誌。",
      icon: "⚠️",
    });
  }
});

clearChatHistoryBtn.addEventListener("click", async () => {
  if (!window.confirm("清空所有聊天會話？\n此操作會刪除全部歷史對話，無法恢復。")) return;
  try {
    const sessions = await window.chatStore?.list();
    if (sessions && sessions.length > 0) {
      // 串行刪除（store 不支持批量刪除；會話數量不會大，可接受）
      for (const s of sessions) {
        await window.chatStore?.delete(s.id);
      }
    }
    setGeneralSaveStatus("所有聊天會話已清空", "is-ok");
  } catch (err) {
    console.warn("[settings] 清空聊天會話失敗:", err);
    setGeneralSaveStatus("清空失敗，請查看終端日誌", "is-error");
  }
});

presetSelect.addEventListener("change", () => {
  // 切廠商前先把當前廠商的輸入值快照進緩存，避免覆蓋丟失
  captureActiveProviderProfile();

  // 從緩存裡取目標廠商的舊配置；沒有緩存就用 preset 默認值
  const cached = providerProfileCache[presetSelect.value];
  applyPreset(
    presetSelect.value,
    cached?.model,
    cached?.apiKey,
    cached?.baseUrl,
    cached?.displayName,
    cached?.explicitTransport,
  );
  setSaveStatus(cached ? "已切回上次配置" : "已應用預設，填寫 API Key 後保存");
});

for (const button of quickApiButtons) {
  button.addEventListener("click", async () => {
    const providerName = button.dataset.apiSource;
    if (!providerName) return;
    if (providerName === activeProvider) {
      setSaveStatus("目前已在使用這個 API", "is-ok");
      return;
    }

    captureActiveProviderProfile();
    const cached = providerProfileCache[providerName];
    applyPreset(
      providerName,
      cached?.model,
      cached?.apiKey,
      cached?.baseUrl,
      cached?.displayName,
      cached?.explicitTransport,
    );
    applyVisionSyncUI();

    quickApiButtons.forEach((item) => { item.disabled = true; });
    button.classList.add("is-switching");
    setSaveStatus(`正在切換至 ${findPreset(providerName).shortName}…`);
    try {
      await persistApiSettings();
      setSaveStatus(`已切換至 ${findPreset(providerName).shortName}`, "is-ok");
    } catch {
      setSaveStatus("切換失敗，請檢查配置後再試", "is-error");
    } finally {
      button.classList.remove("is-switching");
      quickApiButtons.forEach((item) => { item.disabled = false; });
    }
  });
}

// 測試連接按鈕：調用廠商 adapter 的真實連接測試
if (testConnectionBtn) {
  testConnectionBtn.addEventListener("click", async () => {
    const provider = activeProvider;
    const baseUrl = baseUrlInput.value;
    const model = getCurrentModelValue().trim();
    const apiKey = apiKeyInput.value;
    if (!apiKey) { setSaveStatus("請先填寫 API Key 再測試", "is-error"); return; }
    if (!model) { setSaveStatus("請先選擇/填寫模型再測試", "is-error"); return; }
    setSaveStatus("測試連接中…");
    testConnectionBtn.disabled = true;
    try {
      const result = await window.settings!.testConnection({ provider, baseUrl, model, apiKey });
      if (result.ok) setSaveStatus("連接成功 " + result.latency + "ms · " + (result.sample ?? ""), "is-ok");
      else setSaveStatus("連接失敗：" + (result.error ?? "未知錯誤"), "is-error");
    } catch (e) {
      setSaveStatus("連接失敗：" + (e instanceof Error ? e.message : String(e)), "is-error");
    } finally {
      testConnectionBtn.disabled = false;
    }
  });
}

// ── 視覺模型配置事件 ──────────────────────────────────────
// 膠囊按鈕組：[與主聊天模型相同] / [獨立配置]
function isVisionSynced(): boolean {
  return visionSyncMainBtn.classList.contains("is-active");
}

visionSyncMainBtn.addEventListener("click", () => {
  setVisionSyncState(true);
  applyVisionSyncUI();
  setSaveStatus("有未保存的更改");
});
visionSyncIndepBtn.addEventListener("click", () => {
  setVisionSyncState(false);
  applyVisionSyncUI();
  setSaveStatus("有未保存的更改");
});

// 主配置變化時，若處於"與主相同"，聯動更新視覺三框。
// baseUrl 用 visionBaseUrl（若有），其他直接複製。
baseUrlInput.addEventListener("input", () => {
  if (!isVisionSynced()) return;
  const preset = findPreset(presetSelect.value);
  visionBaseUrlInput.value = preset?.visionBaseUrl || baseUrlInput.value;
});
apiKeyInput.addEventListener("input", () => { if (isVisionSynced()) visionApiKeyInput.value = apiKeyInput.value; });
modelInput.addEventListener("input", () => { if (isVisionSynced()) visionModelInput.value = modelInput.value; });

// Base URL 重置按鈕：一鍵復原廠商默認 baseUrl
baseUrlResetBtn.addEventListener("click", () => {
  const preset = findPreset(presetSelect.value);
  if (preset) {
    baseUrlInput.value = preset.baseUrl;
    setSaveStatus("已重置為廠商默認 URL");
  }
});

// 測試視覺模型按鈕
testVisionBtn.addEventListener("click", async () => {
  const synced = isVisionSynced();
  const baseUrl = synced ? baseUrlInput.value : visionBaseUrlInput.value;
  const apiKey = synced ? apiKeyInput.value : visionApiKeyInput.value;
  const model = synced ? getCurrentModelValue() : visionModelInput.value;
  if (!apiKey) { visionTestStatus.textContent = "請先填寫 API Key"; return; }
  if (!model) { visionTestStatus.textContent = "請先填寫視覺型號"; return; }
  visionTestStatus.textContent = "測試中…";
  testVisionBtn.disabled = true;
  try {
    const result = await window.settings!.testVision?.({ baseUrl, apiKey, model });
    if (result?.ok) visionTestStatus.textContent = "✅ 連接成功 " + result.latency + "ms · " + (result.sample ?? "");
    else visionTestStatus.textContent = "❌ " + (result?.error ?? "未知錯誤");
  } catch (e) {
    visionTestStatus.textContent = "❌ " + (e instanceof Error ? e.message : String(e));
  } finally {
    testVisionBtn.disabled = false;
  }
});

function toLocalDateTimeInputValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isValidTimeOfDay(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function formatSchedulerDate(value: string | null | undefined): string {
  if (!value) return "未安排";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "時間無效";
  return date.toLocaleString();
}

function describeSchedule(schedule: ScheduleConfig): string {
  if (schedule.kind === "once") return "僅一次 " + formatSchedulerDate(schedule.runAt);
  if (schedule.kind === "daily") return "每天 " + schedule.timeOfDay;
  if (schedule.kind === "weekly") {
    const names = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
    return `${names[schedule.dayOfWeek]} ${schedule.timeOfDay}`;
  }
  return `每隔 ${schedule.every} ${schedule.unit === "minutes" ? "分鐘" : "小時"}`;
}

function setSchedulerStatus(text: string, className = ""): void {
  if (!schedulerSaveStatus) return;
  schedulerSaveStatus.textContent = text;
  schedulerSaveStatus.className = "save-status" + (className ? " " + className : "");
}

function renderSchedulerTools(selectedIds: string[] = []): void {
  if (!schedulerToolPicker) return;
  schedulerToolPicker.replaceChildren();
  const selected = new Set(selectedIds);
  for (const tool of schedulerTools) {
    const label = document.createElement("label");
    label.className = "scheduler-tool-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = tool.id;
    checkbox.checked = selected.has(tool.id);
    checkbox.addEventListener("change", updateSchedulerConditionalFields);
    const copy = document.createElement("span");
    copy.textContent = `${tool.name} (${tool.id}) · ${tool.risk}${tool.enabled ? "" : " · 已全局禁用"}`;
    label.appendChild(checkbox);
    label.appendChild(copy);
    schedulerToolPicker.appendChild(label);
  }
}

async function renderSchedulerList(): Promise<void> {
  if (!schedulerList || !schedulerEmpty) return;
  schedulerList.replaceChildren();
  schedulerEmpty.classList.toggle("is-hidden", schedulerTasks.length > 0);
  for (const task of schedulerTasks) {
    const card = document.createElement("article");
    card.className = "scheduler-card";
    card.innerHTML = `
      <div class="scheduler-card__head">
        <div class="scheduler-card__title"><span>⏰</span><strong></strong><span class="scheduler-badge"></span></div>
      </div>
      <div class="scheduler-card__meta"></div>
      <div class="scheduler-card__actions"></div>
      <div class="scheduler-history is-hidden"></div>
    `;
    const strong = card.querySelector("strong");
    if (strong) strong.textContent = task.title;
    const badge = card.querySelector(".scheduler-badge") as HTMLSpanElement | null;
    if (badge) {
      badge.textContent = task.managedBy === "daily-ritual"
        ? `每日儀式 · ${task.enabled ? "已啟用" : "已停用"}`
        : task.enabled ? "已啟用" : "已停用";
      badge.classList.toggle("is-disabled", !task.enabled);
    }
    const meta = card.querySelector(".scheduler-card__meta");
    if (meta) meta.textContent = `${describeSchedule(task.schedule)} · 下次運行：${formatSchedulerDate(task.nextFireAt)} · 工具：${task.toolMode === "all-enabled" ? "全部已啟用工具" : task.allowedToolIds.join(", ") || "無"}`;
    const actions = card.querySelector(".scheduler-card__actions") as HTMLDivElement | null;
    if (actions) {
      const fireBtn = document.createElement("button");
      fireBtn.type = "button";
      fireBtn.className = "ghost-btn";
      fireBtn.textContent = "立即運行";
      fireBtn.addEventListener("click", () => void fireSchedulerTask(task.id));
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "ghost-btn";
      editBtn.textContent = "編輯";
      editBtn.addEventListener("click", () => void openSchedulerEditor(task));
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "ghost-btn";
      toggleBtn.textContent = task.enabled ? "停用" : "啟用";
      toggleBtn.addEventListener("click", () => void toggleSchedulerTask(task.id, !task.enabled));
      const historyBtn = document.createElement("button");
      historyBtn.type = "button";
      historyBtn.className = "ghost-btn";
      historyBtn.textContent = "歷史";
      historyBtn.addEventListener("click", () => void toggleSchedulerHistory(task.id, card));
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "ghost-btn";
      deleteBtn.textContent = "刪除";
      deleteBtn.addEventListener("click", () => void deleteSchedulerTask(task.id));
      if (task.managedBy === "daily-ritual") {
        actions.append(fireBtn, historyBtn);
      } else {
        actions.append(fireBtn, editBtn, toggleBtn, historyBtn, deleteBtn);
      }
    }
    schedulerList.appendChild(card);
  }
}

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
      petChatInputEnabled: petChatInputEnabledInput.checked,
      petZoom: Number(petZoomInput.value),
      sidebarVisible: sidebarVisibleInput.checked,
      tasksVisible: tasksVisibleInput.checked,
      launchAtLogin: launchAtLoginInput.checked,
      language: "zh-CN",
      uiTheme: getUiThemeValue(),
    });
    setGeneralSaveStatus("已保存", "is-ok");
  } catch {
    setGeneralSaveStatus("保存失敗", "is-error");
  }
});

cyrenePanel.addEventListener("submit", async (e) => {
  e.preventDefault();
  setCyreneSaveStatus("保存中…");
  try {
    await window.settings!.saveConfig({ runtimeSync: getRuntimeSyncValue(), stickerEnabled: stickerEnabledInput.checked, stickerSize: getStickerSizeValue(), stickerSimilarityThreshold: parseFloat(stickerThresholdInput.value) });
    setCyreneSaveStatus("已保存", "is-ok");
  } catch {
    setCyreneSaveStatus("保存失敗", "is-error");
  }
});

async function persistApiSettings(): Promise<void> {
  // 保存前把當前輸入快照進 perProvider 緩存（main 進程也會做一次，但渲染端先做一遍，
  // 是為了下一次切廠商再切回來不依賴磁盤往返）
  captureActiveProviderProfile();
  // mode 字段在 UI 層已刪除，但仍傳給 main 進程保留向後兼容（舊配置文件可能有該字段）。
  // 默認 "manual"（baseUrl 永遠可改、模型名永遠可填，行為等同原 Manual）。
  await window.settings!.saveConfig({
    mode: "manual",
    provider: activeProvider,
    displayName: displayNameInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
    model: getCurrentModelValue().trim(),
    apiKey: apiKeyInput.value.trim(),
    explicitTransport: transportSelect.value as "openai" | "anthropic" | "auto",
    vision: {
      syncWithMain: isVisionSynced(),
      // syncWithMain=true 時三字段傳空（main 進程不落盤，運行時從主配置讀）
      baseUrl: isVisionSynced() ? "" : visionBaseUrlInput.value.trim(),
      apiKey: isVisionSynced() ? "" : visionApiKeyInput.value.trim(),
      model: isVisionSynced() ? "" : visionModelInput.value.trim(),
    },
  });
}

apiForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setSaveStatus("保存中…");
  try {
    await persistApiSettings();
    setSaveStatus("已保存", "is-ok");
  } catch {
    setSaveStatus("保存失敗", "is-error");
  }
});

async function loadSchedulerPanel(): Promise<void> {
  const [tasksResult, toolsResult] = await Promise.all([
    window.cyreneScheduler!.list(),
    window.cyreneScheduler!.getTools(),
  ]);
  if (tasksResult.ok) schedulerTasks = tasksResult.value ?? [];
  if (toolsResult.ok) schedulerTools = toolsResult.value ?? [];
  renderSchedulerTools();
  await renderSchedulerList();
}

async function openSchedulerEditor(task?: ScheduledTask): Promise<void> {
  editingSchedulerTaskId = task?.id ?? null;
  schedulerEditor?.classList.remove("is-hidden");
  // 確保工具列表已加載
  if (schedulerTools.length === 0) {
    const toolsResult = await window.cyreneScheduler!.getTools();
    if (toolsResult.ok) schedulerTools = toolsResult.value ?? [];
  }
  if (schedulerEditorTitle) schedulerEditorTitle.textContent = task ? "編輯定時任務" : "新建定時任務";
  if (schedulerTitleInput) schedulerTitleInput.value = task?.title ?? "";
  if (schedulerPromptInput) schedulerPromptInput.value = task?.prompt ?? "";
  if (schedulerEnabledInput) schedulerEnabledInput.checked = task?.enabled ?? true;
  if (schedulerKindInput) schedulerKindInput.value = task?.schedule.kind ?? "daily";
  if (schedulerOnceRunAtInput) schedulerOnceRunAtInput.value = "";
  if (schedulerTimeOfDayInput) schedulerTimeOfDayInput.value = "08:00";
  if (schedulerDayOfWeekInput) schedulerDayOfWeekInput.value = "1";
  if (schedulerIntervalEveryInput) schedulerIntervalEveryInput.value = "1";
  if (schedulerIntervalUnitInput) schedulerIntervalUnitInput.value = "minutes";
  if (task?.schedule.kind === "once" && schedulerOnceRunAtInput) schedulerOnceRunAtInput.value = toLocalDateTimeInputValue(task.schedule.runAt);
  if ((task?.schedule.kind === "daily" || task?.schedule.kind === "weekly") && schedulerTimeOfDayInput) schedulerTimeOfDayInput.value = task.schedule.timeOfDay;
  if (task?.schedule.kind === "weekly" && schedulerDayOfWeekInput) schedulerDayOfWeekInput.value = String(task.schedule.dayOfWeek);
  if (task?.schedule.kind === "interval") {
    if (schedulerIntervalEveryInput) schedulerIntervalEveryInput.value = String(task.schedule.every);
    if (schedulerIntervalUnitInput) schedulerIntervalUnitInput.value = task.schedule.unit;
  }
  if (schedulerToolLimitInput) schedulerToolLimitInput.checked = task?.toolMode === "allow-list";
  renderSchedulerTools(task?.allowedToolIds ?? []);
  updateSchedulerConditionalFields();
  setSchedulerStatus("等待操作");
}

function closeSchedulerEditor(): void {
  editingSchedulerTaskId = null;
  schedulerEditor?.classList.add("is-hidden");
}

function updateSchedulerConditionalFields(): void {
  const kind = schedulerKindInput?.value ?? "daily";
  document.querySelectorAll(".scheduler-once-field").forEach(el => el.classList.toggle("is-hidden", kind !== "once"));
  document.querySelectorAll(".scheduler-time-field").forEach(el => el.classList.toggle("is-hidden", kind !== "daily" && kind !== "weekly"));
  document.querySelectorAll(".scheduler-weekly-field").forEach(el => el.classList.toggle("is-hidden", kind !== "weekly"));
  document.querySelectorAll(".scheduler-interval-field").forEach(el => el.classList.toggle("is-hidden", kind !== "interval"));
  const allowListEnabled = Boolean(schedulerToolLimitInput?.checked);
  schedulerToolPicker?.classList.toggle("is-hidden", !allowListEnabled);
  const selectedCount = collectAllowedToolIds().length;
  schedulerToolEmptyHint?.classList.toggle("is-hidden", !allowListEnabled || selectedCount > 0);
}

function collectSchedule(): ScheduleConfig {
  const kind = schedulerKindInput?.value ?? "daily";
  if (kind === "once") {
    const value = schedulerOnceRunAtInput?.value;
    if (!value) throw new Error("請選擇一次性運行時間");
    const runAt = new Date(value);
    if (Number.isNaN(runAt.getTime())) throw new Error("一次性運行時間無效");
    if (runAt.getTime() <= Date.now()) throw new Error("一次性任務時間必須晚於當前時間");
    return { kind: "once", runAt: runAt.toISOString() };
  }
  if (kind === "weekly") {
    const timeOfDay = schedulerTimeOfDayInput?.value || "08:00";
    if (!isValidTimeOfDay(timeOfDay)) throw new Error("每週時間格式必須是 HH:mm");
    const dayOfWeek = Number(schedulerDayOfWeekInput?.value ?? 1);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new Error("星期必須是週一到週日");
    return { kind: "weekly", dayOfWeek: dayOfWeek as 0 | 1 | 2 | 3 | 4 | 5 | 6, timeOfDay };
  }
  if (kind === "interval") {
    const every = Number(schedulerIntervalEveryInput?.value ?? 1);
    const unit = schedulerIntervalUnitInput?.value === "hours" ? "hours" : "minutes";
    if (!Number.isInteger(every) || every <= 0) throw new Error("間隔必須是正整數");
    if (unit === "minutes" && every > 1440) throw new Error("分鐘間隔不能超過 1440");
    if (unit === "hours" && every > 168) throw new Error("小時間隔不能超過 168");
    return { kind: "interval", every, unit };
  }
  const timeOfDay = schedulerTimeOfDayInput?.value || "08:00";
  if (!isValidTimeOfDay(timeOfDay)) throw new Error("每日時間格式必須是 HH:mm");
  return { kind: "daily", timeOfDay };
}

function collectAllowedToolIds(): string[] {
  if (!schedulerToolPicker) return [];
  return Array.from(schedulerToolPicker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(input => input.value);
}

async function saveSchedulerTask(): Promise<void> {
  try {
    setSchedulerStatus("保存中…");
    const title = (schedulerTitleInput?.value ?? "").trim();
    const prompt = (schedulerPromptInput?.value ?? "").trim();
    if (!title) throw new Error("標題不能為空");
    if (!prompt) throw new Error("提示詞不能為空");
    const input = {
      title,
      prompt,
      enabled: schedulerEnabledInput?.checked ?? true,
      schedule: collectSchedule(),
      toolMode: schedulerToolLimitInput?.checked ? "allow-list" : "all-enabled",
      allowedToolIds: collectAllowedToolIds(),
    };
    const result = editingSchedulerTaskId
      ? await window.cyreneScheduler!.update(editingSchedulerTaskId, input)
      : await window.cyreneScheduler!.add(input);
    if (!result.ok) throw new Error(result.error ?? "保存失敗");
    await loadSchedulerPanel();
    closeSchedulerEditor();
  } catch (err) {
    setSchedulerStatus(err instanceof Error ? err.message : String(err), "is-error");
  }
}

async function toggleSchedulerTask(id: string, enabled: boolean): Promise<void> {
  const result = await window.cyreneScheduler!.toggle(id, enabled);
  if (!result.ok) window.alert(result.error ?? "切換失敗");
  await loadSchedulerPanel();
}

async function fireSchedulerTask(id: string): Promise<void> {
  const result = await window.cyreneScheduler!.fireNow(id);
  if (!result.ok) window.alert(result.reason === "task already running" ? "該任務正在運行中" : (result.error ?? result.reason ?? "立即運行失敗"));
}

async function deleteSchedulerTask(id: string): Promise<void> {
  const ok = await showModal({ title: "刪除定時任務", message: "確定刪除這個定時任務嗎？", icon: "🗑️", confirmText: "刪除" });
  if (!ok) return;
  const result = await window.cyreneScheduler!.delete(id);
  if (!result.ok) window.alert(result.error ?? "刪除失敗");
  await loadSchedulerPanel();
}

async function toggleSchedulerHistory(taskId: string, card: Element): Promise<void> {
  const box = card.querySelector(".scheduler-history") as HTMLDivElement | null;
  if (!box) return;
  if (!box.classList.contains("is-hidden")) {
    box.classList.add("is-hidden");
    return;
  }
  const result = await window.cyreneScheduler!.getHistory(taskId, 10);
  const rows = result.value ?? [];
  box.replaceChildren();
  if (!result.ok || rows.length === 0) {
    box.textContent = result.ok ? "暫無運行歷史" : (result.error ?? "讀取歷史失敗");
  } else {
    for (const row of rows) {
      const div = document.createElement("div");
      div.textContent = `${formatSchedulerDate(row.firedAt)} ${row.status}${row.durationMs ? ` ${Math.round(row.durationMs / 100) / 10}s` : ""}：${row.outputPreview ?? row.errorMessage ?? row.reason ?? ""}`;
      box.appendChild(div);
    }
  }
  box.classList.remove("is-hidden");
}

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
  const isChat = section === "chat";
  const isTasks = section === "tasks";
  const isIdentity = section === "identity";
  const isPlugins = section === "plugins";
  const isSkills = section === "skills";
  const isTokens = section === "tokens";
  const isSecurity = section === "security";
  const isDiscordChannel = section === "channels-discord";
  const isChannels = section === "channels" || isDiscordChannel;
  const isTts = section === "tts";
  const isAsr = section === "asr";
  apiForm.classList.toggle("is-hidden", !isApi);
  generalForm.classList.toggle("is-hidden", !isGeneral);
  cyrenePanel.classList.toggle("is-hidden", !isCyrene);
  disclaimerPanel.classList.toggle("is-hidden", !isDisclaimer);
  const memoryPanel = document.getElementById("memory-panel");
  if (memoryPanel) memoryPanel.classList.toggle("is-hidden", !isMemory);
  const userPanel = document.getElementById("user-panel");
  if (userPanel) userPanel.classList.toggle("is-hidden", !isUser);
  const chatPanel = document.getElementById("chat-panel");
  if (chatPanel) chatPanel.classList.toggle("is-hidden", !isChat);
  // 切到 💬 聊天面板時拉一次列表（cross-window 變化由 onChanged 監聽器自己刷新）
  if (isChat) void renderChatSessions();
  const tasksPanel = document.getElementById("tasks-panel");
  if (tasksPanel) tasksPanel.classList.toggle("is-hidden", !isTasks);
  if (isTasks) void loadSchedulerPanel();
  const identityPanel = document.getElementById("identity-panel");
  if (identityPanel) identityPanel.classList.toggle("is-hidden", !isIdentity);
  pluginsPanel.classList.toggle("is-hidden", !isPlugins);
  const skillsPanel = document.getElementById("skills-panel");
  if (skillsPanel) skillsPanel.classList.toggle("is-hidden", !isSkills);
  if (isSkills) void renderSkills();
  const tokenPanel = document.getElementById("token-panel");
  if (tokenPanel) tokenPanel.classList.toggle("is-hidden", !isTokens);
  if (isTokens) void refreshAgentActivity(7);
  const securityPanel = document.getElementById("security-panel");
  if (securityPanel) securityPanel.classList.toggle("is-hidden", !isSecurity);
  if (isSecurity) void loadSecurityPanel();
  const channelsPanel = document.getElementById("channels-panel");
  if (channelsPanel) channelsPanel.classList.toggle("is-hidden", !isChannels);
  if (isChannels) {
    void loadChannelsPanel().then(() => {
      if (!isDiscordChannel) return;
      window.setTimeout(() => document.getElementById("channels-discord-card")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    });
  }
  const ttsPanel = document.getElementById("tts-panel");
  if (ttsPanel) ttsPanel.classList.toggle("is-hidden", !isTts);
  const asrPanel = document.getElementById("asr-panel");
  if (asrPanel) asrPanel.classList.toggle("is-hidden", !isAsr);
  placeholderPanel.classList.toggle(
    "is-hidden",
    isApi || isGeneral || isCyrene || isDisclaimer || isMemory || isUser || isChat || isTasks || isIdentity || isPlugins || isSkills || isTokens || isSecurity || isChannels || isTts || isAsr,
  );

  if (
    !isApi &&
    !isGeneral &&
    !isCyrene &&
    !isDisclaimer &&
    !isMemory &&
    !isUser &&
    !isChat &&
    !isTasks &&
    !isIdentity &&
    !isPlugins &&
    !isSkills &&
    !isTokens &&
    !isSecurity &&
    !isChannels &&
    !isTts &&
    !isAsr
  ) {
    placeholderIcon.textContent = label.emoji;
    placeholderTitle.textContent = label.title;
    placeholderCopy.textContent = "這個模塊先佔位，等核心聊天與 API 接通後再繼續擴展。";
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

schedulerNewBtn?.addEventListener("click", () => void openSchedulerEditor());
schedulerEditorClose?.addEventListener("click", closeSchedulerEditor);
schedulerCancelBtn?.addEventListener("click", closeSchedulerEditor);
schedulerSaveBtn?.addEventListener("click", () => void saveSchedulerTask());
schedulerKindInput?.addEventListener("change", updateSchedulerConditionalFields);
schedulerToolLimitInput?.addEventListener("change", updateSchedulerConditionalFields);
updateSchedulerConditionalFields();

// ===== 遊戲代肝插件卡（在 plugins 面板裡，MCP 下、生活工具上）=====
function initGameBotPluginCard(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gb = (window as any).gameBot as {
    getConfig: () => Promise<{ enabled: boolean; exePath: string; activeRecipe: string; vlm: { baseUrl: string; apiKey: string; model: string } }>;
    saveConfig: (c: unknown) => Promise<unknown>;
    listRecipes: () => Promise<{ id: string; name: string }[]>;
    listRefs: (r: string) => Promise<string[]>;
    refsDir: (r: string) => Promise<string>;
    start: () => Promise<{ ok: boolean; error?: string }>;
    stop: () => Promise<unknown>;
    onProgress: (cb: (i: unknown) => void) => (() => void) | void;
  } | undefined;
  if (!gb) return;

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const enabledCb = $<HTMLInputElement>("plugin-gamebot-enabled");
  const configEl = $("plugin-gamebot-config");
  const exe = $<HTMLInputElement>("gamebot-exe");
  const url = $<HTMLInputElement>("gamebot-vlm-url");
  const key = $<HTMLInputElement>("gamebot-vlm-key");
  const model = $<HTMLInputElement>("gamebot-vlm-model");
  const recipeSel = $<HTMLSelectElement>("gamebot-recipe");
  const refsDirEl = $("gamebot-refs-dir");
  const refsListEl = $("gamebot-refs-list");
  const startBtn = $<HTMLButtonElement>("gamebot-start-btn");
  const stopBtn = $<HTMLButtonElement>("gamebot-stop-btn");
  const logEl = $("gamebot-log");
  if (!enabledCb || !configEl || !exe || !url || !key || !model || !recipeSel) return;

  let currentRecipe = "star-rail-daily";

  function appendLog(line: string): void {
    if (!logEl) return;
    logEl.textContent = new Date().toLocaleTimeString() + " " + line + "\n" + (logEl.textContent ?? "");
  }

  async function refreshRefs(): Promise<void> {
    if (refsDirEl) refsDirEl.textContent = await gb!.refsDir(currentRecipe);
    const refs = await gb!.listRefs(currentRecipe);
    if (refsListEl) {
      refsListEl.innerHTML = refs.length
        ? "已就位參考圖：" + refs.map((r) => "<code>" + r + "</code>").join(" ")
        : "（目錄還沒有參考圖，把裁好的小圖按命名放進上方目錄）";
    }
  }

  async function refresh(): Promise<void> {
    const cfg = await gb!.getConfig();
    enabledCb!.checked = cfg.enabled;
    configEl!.style.display = cfg.enabled ? "block" : "none";
    exe.value = cfg.exePath;
    url.value = cfg.vlm.baseUrl;
    key.value = cfg.vlm.apiKey;
    model.value = cfg.vlm.model;
    currentRecipe = cfg.activeRecipe;
    const recipes = await gb!.listRecipes();
    recipeSel.innerHTML = "";
    for (const r of recipes) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name + " (" + r.id + ")";
      if (r.id === currentRecipe) opt.selected = true;
      recipeSel.appendChild(opt);
    }
    await refreshRefs();
  }

  // 膠囊開關：開/關時保存 enabled 並顯隱配置區
  enabledCb.addEventListener("change", async () => {
    configEl.style.display = enabledCb.checked ? "block" : "none";
    await gb.saveConfig({ enabled: enabledCb.checked });
  });

  // 配置項失焦即存
  const saveFields = () => gb.saveConfig({
    exePath: exe.value.trim(),
    activeRecipe: recipeSel.value,
    vlm: { baseUrl: url.value.trim(), apiKey: key.value.trim(), model: model.value.trim() },
  });
  for (const el of [exe, url, key, model]) el.addEventListener("change", () => void saveFields());
  recipeSel.addEventListener("change", () => { currentRecipe = recipeSel.value; void saveFields().then(refreshRefs); });

  startBtn?.addEventListener("click", async () => {
    const r = await gb.start();
    appendLog(r.ok ? "代肝已啟動" : "啟動失敗: " + (r.error ?? ""));
  });
  stopBtn?.addEventListener("click", () => { void gb.stop(); appendLog("已請求停止"); });

  gb.onProgress((info) => {
    const i = info as { index: number; total: number; desc: string };
    appendLog(i.desc + (i.index >= 0 ? " (" + (i.index + 1) + "/" + i.total + ")" : ""));
  });

  void refresh();
}

initGameBotPluginCard();

// ===== 資料安全：時間膠囊與系統保管庫 =====
let selectedBackup: BackupSummary | null = null;

function formatBackupBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function selectedCategories(containerId: string): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(`#${containerId} input[type="checkbox"]:checked`)).map((input) => input.value);
}

function setSecurityStatus(element: HTMLElement | null, text: string, kind?: "is-ok" | "is-error"): void {
  if (!element) return;
  element.textContent = text;
  element.className = "security-status";
  if (kind) element.classList.add(kind);
}

async function renderVaultStatus(): Promise<void> {
  const title = document.getElementById("vault-title");
  const detail = document.getElementById("vault-detail");
  if (!title || !detail || !window.settings) return;
  try {
    const status = await window.settings.securityGetStatus();
    if (!status.available) {
      title.textContent = "系統保管庫目前不可用";
      detail.textContent = `密鑰尚未加密；請確認 ${status.backend} 可用後再試。`;
    } else if (status.lockedCount) {
      title.textContent = `${status.lockedCount} 個密鑰暫時無法解鎖`;
      detail.textContent = `由 ${status.backend} 保護，請在原本的系統帳號中開啟。`;
    } else {
      title.textContent = status.protectedCount ? `${status.protectedCount} 個密鑰已安全封存` : "系統保管庫已就緒";
      detail.textContent = `由 ${status.backend} 加密；${status.plaintextCount ? `另有 ${status.plaintextCount} 個等待保護。` : "備份不會帶走任何密鑰。"}`;
    }
  } catch (error) {
    title.textContent = "無法讀取保管庫狀態";
    detail.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function loadSecurityPanel(): Promise<void> {
  await renderVaultStatus();
  try {
    const config = await window.settings!.backupGetConfig();
    const enabled = document.getElementById("backup-auto-enabled") as HTMLInputElement | null;
    const retention = document.getElementById("backup-retention") as HTMLSelectElement | null;
    const last = document.getElementById("backup-last-auto");
    if (enabled) enabled.checked = config.autoEnabled;
    if (retention) retention.value = String(config.retentionDays);
    if (last) last.textContent = config.lastAutoBackupAt ? `上次 ${new Date(config.lastAutoBackupAt).toLocaleDateString("zh-TW")}` : "尚未執行";
  } catch { /* service may still be starting */ }
}

document.getElementById("vault-protect-btn")?.addEventListener("click", async () => {
  await window.settings?.securityMigrate();
  await renderVaultStatus();
});

document.getElementById("backup-create-btn")?.addEventListener("click", async () => {
  const status = document.getElementById("backup-create-status");
  const categories = selectedCategories("backup-create-categories");
  if (!categories.length) return setSecurityStatus(status, "請至少選擇一種資料", "is-error");
  setSecurityStatus(status, "正在封存…");
  try {
    const summary = await window.settings!.backupCreate(categories);
    if (!summary) return setSecurityStatus(status, "已取消建立備份");
    setSecurityStatus(status, `完成：${summary.fileCount} 個檔案，${formatBackupBytes(summary.sizeBytes)}`, "is-ok");
  } catch (error) {
    setSecurityStatus(status, error instanceof Error ? error.message : String(error), "is-error");
  }
});

for (const id of ["backup-auto-enabled", "backup-retention"]) {
  document.getElementById(id)?.addEventListener("change", async () => {
    const enabled = document.getElementById("backup-auto-enabled") as HTMLInputElement;
    const retention = document.getElementById("backup-retention") as HTMLSelectElement;
    await window.settings?.backupSaveConfig({ autoEnabled: enabled.checked, retentionDays: retention.value === "30" ? 30 : 7 });
    await loadSecurityPanel();
  });
}

document.getElementById("backup-pick-btn")?.addEventListener("click", async () => {
  const restoreStatus = document.getElementById("backup-restore-status");
  try {
    selectedBackup = await window.settings!.backupPickInspect();
    if (!selectedBackup) return;
    const preview = document.getElementById("backup-preview");
    const date = document.getElementById("backup-preview-date");
    const summary = document.getElementById("backup-preview-summary");
    const categories = document.getElementById("backup-restore-categories");
    preview?.classList.remove("is-hidden");
    if (date) date.textContent = new Date(selectedBackup.createdAt).toLocaleString("zh-TW");
    if (summary) summary.textContent = `${selectedBackup.fileCount} 個檔案 · ${formatBackupBytes(selectedBackup.sizeBytes)} · v${selectedBackup.appVersion}`;
    categories?.replaceChildren(...selectedBackup.categories.map((category) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = category.id;
      input.checked = true;
      label.append(input, `${category.label} · ${category.fileCount}`);
      return label;
    }));
    setSecurityStatus(restoreStatus, "請確認要還原的分類");
  } catch (error) {
    setSecurityStatus(restoreStatus, error instanceof Error ? error.message : String(error), "is-error");
  }
});

document.getElementById("backup-restore-btn")?.addEventListener("click", async () => {
  const status = document.getElementById("backup-restore-status");
  if (!selectedBackup) return;
  const categories = selectedCategories("backup-restore-categories");
  if (!categories.length) return setSecurityStatus(status, "請至少選擇一種資料", "is-error");
  const confirmed = await showModal({ title: "回到這個時間點？", message: "還原前會先自動備份目前資料。完成後需要重新啟動昔漣。", icon: "⏳", confirmText: "安全還原" });
  if (!confirmed) return;
  setSecurityStatus(status, "正在建立安全快照並還原…");
  try {
    const result = await window.settings!.backupRestore({ filePath: selectedBackup.filePath, categories });
    setSecurityStatus(status, `已還原 ${result.restoredFiles} 個檔案`, "is-ok");
    document.getElementById("backup-restart-callout")?.classList.remove("is-hidden");
  } catch (error) {
    setSecurityStatus(status, error instanceof Error ? error.message : String(error), "is-error");
  }
});

document.getElementById("security-restart-btn")?.addEventListener("click", () => window.settings?.securityRestartApp());

void loadConfig();
void loadGeneralSettings();

// ===== channels panel (連接手機) =====
const channelsWechatEnabledEl = document.getElementById("channels-wechat-enabled") as HTMLInputElement | null;
const channelsFeishuEnabledEl = document.getElementById("channels-feishu-enabled") as HTMLInputElement | null;
const channelsDiscordEnabledEl = document.getElementById("channels-discord-enabled") as HTMLInputElement | null;
const channelsWechatStatusEl = document.getElementById("channels-wechat-status");
const channelsFeishuStatusEl = document.getElementById("channels-feishu-status");
const channelsDiscordStatusEl = document.getElementById("channels-discord-status");
const channelsRateUserEl = document.getElementById("channels-rate-user") as HTMLInputElement | null;
const channelsRateChannelEl = document.getElementById("channels-rate-channel") as HTMLInputElement | null;
const channelsTtsEl = document.getElementById("channels-tts-enabled") as HTMLInputElement | null;
const channelsStickerEl = document.getElementById("channels-sticker-enabled") as HTMLInputElement | null;
const channelsMirrorEl = document.getElementById("channels-mirror-desktop") as HTMLInputElement | null;
const channelsSandboxEl = document.getElementById("channels-tool-sandbox") as HTMLInputElement | null;
// 飛書配置輸入框（Phase 2 長連接版：只需 App ID + App Secret）
const channelsFeishuAppIdEl = document.getElementById("channels-feishu-app-id") as HTMLInputElement | null;
const channelsFeishuAppSecretEl = document.getElementById("channels-feishu-app-secret") as HTMLInputElement | null;
const channelsFeishuAppSecretRevealBtn = document.getElementById("channels-feishu-app-secret-reveal");
const channelsFeishuSaveBtn = document.getElementById("channels-feishu-save");
const channelsDiscordTokenEl = document.getElementById("channels-discord-token") as HTMLInputElement | null;
const channelsDiscordTokenRevealBtn = document.getElementById("channels-discord-token-reveal");
const channelsDiscordGuildIdsEl = document.getElementById("channels-discord-guild-ids") as HTMLInputElement | null;
const channelsDiscordChannelIdsEl = document.getElementById("channels-discord-channel-ids") as HTMLInputElement | null;
const channelsDiscordUserIdsEl = document.getElementById("channels-discord-user-ids") as HTMLInputElement | null;
const channelsDiscordCodexOwnerIdEl = document.getElementById("channels-discord-codex-owner-id") as HTMLInputElement | null;
const channelsDiscordRequireMentionEl = document.getElementById("channels-discord-require-mention") as HTMLInputElement | null;
const channelsDiscordVoiceEnabledEl = document.getElementById("channels-discord-voice-enabled") as HTMLInputElement | null;
const channelsDiscordSaveBtn = document.getElementById("channels-discord-save");
const channelsDiscordAvatarEl = document.getElementById("channels-discord-avatar") as HTMLImageElement | null;
const channelsDiscordAvatarFallbackEl = document.getElementById("channels-discord-avatar-fallback");
const channelsDiscordAvatarPresenceEl = document.getElementById("channels-discord-avatar-presence");
const channelsDiscordDisplayNameEl = document.getElementById("channels-discord-display-name");
const channelsDiscordTagEl = document.getElementById("channels-discord-tag");
const channelsDiscordApplicationIdEl = document.getElementById("channels-discord-application-id");
const channelsDiscordGuildCountEl = document.getElementById("channels-discord-guild-count");
const channelsDiscordVoiceStatusEl = document.getElementById("channels-discord-voice-status");
const channelsDiscordGuildsEl = document.getElementById("channels-discord-guilds");
const channelsDiscordUsernameEl = document.getElementById("channels-discord-username") as HTMLInputElement | null;
const channelsDiscordActivityEl = document.getElementById("channels-discord-activity") as HTMLInputElement | null;
const channelsDiscordPresenceEl = document.getElementById("channels-discord-presence") as HTMLSelectElement | null;
const channelsDiscordAvatarPickBtn = document.getElementById("channels-discord-avatar-pick") as HTMLButtonElement | null;
const channelsDiscordMediaMenuEl = document.getElementById("channels-discord-media-menu");
const channelsDiscordAvatarOptionBtn = document.getElementById("channels-discord-avatar-option") as HTMLButtonElement | null;
const channelsDiscordBannerOptionBtn = document.getElementById("channels-discord-banner-option") as HTMLButtonElement | null;
const channelsDiscordProfileSaveBtn = document.getElementById("channels-discord-profile-save") as HTMLButtonElement | null;
const channelsDiscordProfileFeedbackEl = document.getElementById("channels-discord-profile-feedback");
const channelsDiscordEmojiPickerEl = document.getElementById("channels-discord-emoji-picker");
const channelsDiscordMusicStatusEl = document.getElementById("channels-discord-music-status");
const channelsDiscordMusicRecordEl = document.getElementById("channels-discord-music-record");
const channelsDiscordMusicCoverEl = document.getElementById("channels-discord-music-cover") as HTMLImageElement | null;
const channelsDiscordMusicTitleEl = document.getElementById("channels-discord-music-title");
const channelsDiscordMusicProgressEl = document.getElementById("channels-discord-music-progress") as HTMLElement | null;
const channelsDiscordMusicElapsedEl = document.getElementById("channels-discord-music-elapsed");
const channelsDiscordMusicDurationEl = document.getElementById("channels-discord-music-duration");
const channelsDiscordMusicToggleBtn = document.getElementById("channels-discord-music-toggle") as HTMLButtonElement | null;
const channelsDiscordMusicPreviousBtn = document.getElementById("channels-discord-music-previous") as HTMLButtonElement | null;
const channelsDiscordMusicNextBtn = document.getElementById("channels-discord-music-next") as HTMLButtonElement | null;
const channelsDiscordMusicStopBtn = document.getElementById("channels-discord-music-stop") as HTMLButtonElement | null;
const channelsDiscordMusicRepeatBtn = document.getElementById("channels-discord-music-repeat") as HTMLButtonElement | null;
const channelsDiscordMusicShuffleBtn = document.getElementById("channels-discord-music-shuffle") as HTMLButtonElement | null;
const channelsDiscordMusicAutoplayBtn = document.getElementById("channels-discord-music-autoplay") as HTMLButtonElement | null;
const channelsDiscordMusicClearBtn = document.getElementById("channels-discord-music-clear") as HTMLButtonElement | null;
const channelsDiscordMusicVolumeEl = document.getElementById("channels-discord-music-volume") as HTMLInputElement | null;
const channelsDiscordMusicVolumeValueEl = document.getElementById("channels-discord-music-volume-value") as HTMLOutputElement | null;
const channelsDiscordMusicQueueEl = document.getElementById("channels-discord-music-queue");
const channelsDiscordMusicPlaylistTitleEl = document.getElementById("channels-discord-music-playlist-title");
const channelsDiscordMusicLibraryKindEl = document.getElementById("channels-discord-music-library-kind");
const channelsDiscordMusicQueueToggleBtn = document.getElementById("channels-discord-music-queue-toggle") as HTMLButtonElement | null;
const channelsDiscordMusicFavoritesToggleBtn = document.getElementById("channels-discord-music-favorites-toggle") as HTMLButtonElement | null;
const channelsDiscordMusicHistoryToggleBtn = document.getElementById("channels-discord-music-history-toggle") as HTMLButtonElement | null;
const channelsDiscordMusicFavoritesEl = document.getElementById("channels-discord-music-favorites");
const channelsDiscordMusicHistoryEl = document.getElementById("channels-discord-music-history");
const channelsDiscordMusicFeedbackEl = document.getElementById("channels-discord-music-feedback");
const channelsSpotifyPlanEl = document.getElementById("channels-spotify-plan");
const channelsSpotifyCoverEl = document.getElementById("channels-spotify-cover") as HTMLImageElement | null;
const channelsSpotifyDeviceEl = document.getElementById("channels-spotify-device");
const channelsSpotifyTitleEl = document.getElementById("channels-spotify-title");
const channelsSpotifyArtistEl = document.getElementById("channels-spotify-artist");
const channelsSpotifyProgressEl = document.getElementById("channels-spotify-progress") as HTMLElement | null;
const channelsSpotifyPreviousBtn = document.getElementById("channels-spotify-previous") as HTMLButtonElement | null;
const channelsSpotifyToggleBtn = document.getElementById("channels-spotify-toggle") as HTMLButtonElement | null;
const channelsSpotifyNextBtn = document.getElementById("channels-spotify-next") as HTMLButtonElement | null;
const channelsSpotifyDeviceSelectEl = document.getElementById("channels-spotify-device-select") as HTMLSelectElement | null;
const channelsSpotifyVolumeEl = document.getElementById("channels-spotify-volume") as HTMLInputElement | null;
const channelsSpotifyVolumeValueEl = document.getElementById("channels-spotify-volume-value") as HTMLOutputElement | null;
const channelsSpotifyQueryEl = document.getElementById("channels-spotify-query") as HTMLInputElement | null;
const channelsSpotifyPlayQueryBtn = document.getElementById("channels-spotify-play-query") as HTMLButtonElement | null;
const channelsSpotifyClientIdEl = document.getElementById("channels-spotify-client-id") as HTMLInputElement | null;
const channelsSpotifyClientSecretEl = document.getElementById("channels-spotify-client-secret") as HTMLInputElement | null;
const channelsSpotifySecretRevealBtn = document.getElementById("channels-spotify-secret-reveal") as HTMLButtonElement | null;
const channelsSpotifyConnectBtn = document.getElementById("channels-spotify-connect") as HTMLButtonElement | null;
const channelsSpotifyDisconnectBtn = document.getElementById("channels-spotify-disconnect") as HTMLButtonElement | null;
const channelsSpotifyFeedbackEl = document.getElementById("channels-spotify-feedback");
const channelsBilibiliCardEl = document.getElementById("channels-bilibili-card");
const channelsBilibiliStatusEl = document.getElementById("channels-bilibili-status");
const channelsBilibiliSessionTitleEl = document.getElementById("channels-bilibili-session-title");
const channelsBilibiliSessionDetailEl = document.getElementById("channels-bilibili-session-detail");
const channelsBilibiliConnectBtn = document.getElementById("channels-bilibili-connect") as HTMLButtonElement | null;
const channelsBilibiliDisconnectBtn = document.getElementById("channels-bilibili-disconnect") as HTMLButtonElement | null;
const channelsBilibiliFeedbackEl = document.getElementById("channels-bilibili-feedback");
// 微信按鈕
const channelsWechatLoginBtn = document.getElementById("channels-wechat-login");
const channelsWechatRestartBtn = document.getElementById("channels-wechat-restart");
const channelsWechatFeedbackEl = document.getElementById("channels-wechat-feedback");
const channelsFeishuFeedbackEl = document.getElementById("channels-feishu-feedback");
const channelsDiscordFeedbackEl = document.getElementById("channels-discord-feedback");

let channelsInitialized = false;
let channelsSaveTimer: number | null = null;
let pendingDiscordAvatarPath: string | undefined;
let pendingDiscordBannerPath: string | undefined;
let discordMusicState: DiscordMusicState = { active: false, paused: false, current: null, queue: [], volume: 100, repeat: "off", shuffle: false, autoplay: false, elapsed: 0 };
let discordMusicLibraryView: "queue" | "favorites" | "history" = "queue";
let discordMusicRefreshTimer: number | null = null;
let discordMusicVolumeTimer: number | null = null;
let spotifyStatus: SpotifyPlaybackStatus = { configured: false, connected: false, devices: [] };
let spotifyRefreshTimer: number | null = null;
let spotifyVolumeTimer: number | null = null;

function setDiscordProfileFeedback(kind: "info" | "ok" | "err", message: string): void {
  if (!channelsDiscordProfileFeedbackEl) return;
  channelsDiscordProfileFeedbackEl.textContent = message;
  channelsDiscordProfileFeedbackEl.className = "channels-feedback";
  channelsDiscordProfileFeedbackEl.classList.add(kind === "ok" ? "channels-feedback--ok" : kind === "err" ? "channels-feedback--err" : "channels-feedback--info");
}

function renderDiscordProfile(profile: DiscordBotProfile): void {
  const connected = profile.connected;
  if (channelsDiscordDisplayNameEl) channelsDiscordDisplayNameEl.textContent = profile.username ?? "尚未連接";
  if (channelsDiscordTagEl) channelsDiscordTagEl.textContent = profile.tag ?? "連接 Gateway 後顯示即時資訊";
  if (channelsDiscordApplicationIdEl) channelsDiscordApplicationIdEl.textContent = profile.applicationId ?? "—";
  if (channelsDiscordGuildCountEl) channelsDiscordGuildCountEl.textContent = String(profile.guildCount ?? 0);
  if (channelsDiscordVoiceStatusEl) channelsDiscordVoiceStatusEl.textContent = profile.voiceActive ? "通話中" : "未通話";
  if (channelsDiscordAvatarPresenceEl) channelsDiscordAvatarPresenceEl.classList.toggle("is-online", connected);
  if (channelsDiscordAvatarEl) {
    if (profile.avatarUrl) {
      channelsDiscordAvatarEl.src = profile.avatarUrl;
      channelsDiscordAvatarEl.hidden = false;
      if (channelsDiscordAvatarFallbackEl) channelsDiscordAvatarFallbackEl.hidden = true;
    } else {
      channelsDiscordAvatarEl.hidden = true;
      if (channelsDiscordAvatarFallbackEl) channelsDiscordAvatarFallbackEl.hidden = false;
    }
  }
  if (channelsDiscordGuildsEl) {
    channelsDiscordGuildsEl.replaceChildren();
    if (!profile.guilds?.length) {
      const empty = document.createElement("span");
      empty.textContent = connected ? "尚未加入任何伺服器" : "連接後顯示 Bot 所在的伺服器";
      channelsDiscordGuildsEl.appendChild(empty);
    } else {
      for (const guild of profile.guilds) {
        const chip = document.createElement("span");
        chip.className = "discord-guild-chip";
        chip.textContent = guild.name;
        chip.title = `Server ID: ${guild.id}`;
        channelsDiscordGuildsEl.appendChild(chip);
      }
    }
  }
  if (channelsDiscordUsernameEl) {
    channelsDiscordUsernameEl.value = profile.username ?? "";
    channelsDiscordUsernameEl.disabled = !connected;
  }
  if (channelsDiscordActivityEl) {
    channelsDiscordActivityEl.value = profile.activityText ?? "";
    channelsDiscordActivityEl.disabled = !connected;
  }
  if (channelsDiscordPresenceEl) {
    const presence = profile.presenceStatus === "offline" ? "invisible" : profile.presenceStatus;
    channelsDiscordPresenceEl.value = ["online", "idle", "dnd", "invisible"].includes(presence ?? "") ? presence! : "online";
    channelsDiscordPresenceEl.disabled = !connected;
  }
  if (channelsDiscordAvatarPickBtn) channelsDiscordAvatarPickBtn.disabled = !connected;
  if (channelsDiscordAvatarOptionBtn) channelsDiscordAvatarOptionBtn.disabled = !connected;
  if (channelsDiscordBannerOptionBtn) channelsDiscordBannerOptionBtn.disabled = !connected;
  if (channelsDiscordProfileSaveBtn) channelsDiscordProfileSaveBtn.disabled = !connected;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".discord-emoji-button")) button.disabled = !connected;
}

async function refreshDiscordProfile(): Promise<void> {
  try {
    renderDiscordProfile(await window.settings.channelsDiscordGetProfile());
  } catch (err) {
    console.warn("[Channels] 讀取 Discord Bot 資訊失敗:", err);
    renderDiscordProfile({ connected: false, guildCount: 0, guilds: [], voiceActive: false });
  }
}

function formatDiscordMusicTime(seconds?: number): string {
  if (!Number.isFinite(seconds) || (seconds ?? 0) < 0) return "—";
  const total = Math.floor(seconds ?? 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function setDiscordMusicFeedback(kind: "info" | "ok" | "err", message: string): void {
  if (!channelsDiscordMusicFeedbackEl) return;
  channelsDiscordMusicFeedbackEl.textContent = message;
  channelsDiscordMusicFeedbackEl.className = "channels-feedback";
  channelsDiscordMusicFeedbackEl.classList.add(kind === "ok" ? "channels-feedback--ok" : kind === "err" ? "channels-feedback--err" : "channels-feedback--info");
}

function renderDiscordMusic(state: DiscordMusicState): void {
  discordMusicState = state;
  const current = state.current;
  const controls = [channelsDiscordMusicPreviousBtn, channelsDiscordMusicToggleBtn, channelsDiscordMusicNextBtn, channelsDiscordMusicStopBtn, channelsDiscordMusicRepeatBtn, channelsDiscordMusicShuffleBtn, channelsDiscordMusicAutoplayBtn];
  for (const control of controls) if (control) control.disabled = !state.active;
  if (channelsDiscordMusicClearBtn) channelsDiscordMusicClearBtn.disabled = !state.queue.length;
  if (channelsDiscordMusicVolumeEl) {
    if (document.activeElement !== channelsDiscordMusicVolumeEl) channelsDiscordMusicVolumeEl.value = String(state.volume);
    channelsDiscordMusicVolumeEl.disabled = !state.active;
  }
  if (channelsDiscordMusicVolumeValueEl && document.activeElement !== channelsDiscordMusicVolumeEl) channelsDiscordMusicVolumeValueEl.value = `${state.volume}%`;
  if (channelsDiscordMusicStatusEl) {
    channelsDiscordMusicStatusEl.textContent = state.active ? (state.paused ? "已暫停" : "正在播放") : "尚未播放";
    channelsDiscordMusicStatusEl.classList.toggle("is-active", state.active);
  }
  if (channelsDiscordMusicRecordEl) {
    channelsDiscordMusicRecordEl.classList.toggle("is-playing", state.active);
    channelsDiscordMusicRecordEl.classList.toggle("is-paused", state.paused);
  }
  if (channelsDiscordMusicCoverEl && channelsDiscordMusicRecordEl) {
    const thumbnail = current?.thumbnail;
    if (thumbnail) {
      if (channelsDiscordMusicCoverEl.src !== thumbnail) channelsDiscordMusicCoverEl.src = thumbnail;
      channelsDiscordMusicCoverEl.hidden = false;
      channelsDiscordMusicRecordEl.classList.add("has-cover");
    } else {
      channelsDiscordMusicCoverEl.removeAttribute("src");
      channelsDiscordMusicCoverEl.hidden = true;
      channelsDiscordMusicRecordEl.classList.remove("has-cover");
    }
  }
  if (channelsDiscordMusicTitleEl) channelsDiscordMusicTitleEl.textContent = current?.title ?? "等待你在 Discord 使用 /play";
  if (channelsDiscordMusicPlaylistTitleEl) {
    channelsDiscordMusicPlaylistTitleEl.textContent = discordMusicLibraryView === "history"
      ? "播放歷史"
      : discordMusicLibraryView === "favorites"
        ? "我喜歡的歌"
        : current?.playlistTitle ?? state.queue[0]?.playlistTitle ?? "播放清單";
    channelsDiscordMusicPlaylistTitleEl.title = channelsDiscordMusicPlaylistTitleEl.textContent;
  }
  if (channelsDiscordMusicToggleBtn) {
    channelsDiscordMusicToggleBtn.textContent = state.paused ? "▶" : "Ⅱ";
    channelsDiscordMusicToggleBtn.title = state.paused ? "繼續播放" : "暫停播放";
  }
  if (channelsDiscordMusicRepeatBtn) {
    channelsDiscordMusicRepeatBtn.textContent = state.repeat === "track" ? "↻¹" : state.repeat === "queue" ? "↻∞" : "↻";
    channelsDiscordMusicRepeatBtn.setAttribute("aria-pressed", String(state.repeat !== "off"));
    channelsDiscordMusicRepeatBtn.title = state.repeat === "track" ? "單曲循環（點擊切換清單循環）" : state.repeat === "queue" ? "清單循環（點擊關閉）" : "開啟單曲循環";
  }
  if (channelsDiscordMusicShuffleBtn) channelsDiscordMusicShuffleBtn.setAttribute("aria-pressed", String(state.shuffle));
  if (channelsDiscordMusicAutoplayBtn) {
    channelsDiscordMusicAutoplayBtn.setAttribute("aria-pressed", String(state.autoplay));
    channelsDiscordMusicAutoplayBtn.title = state.autoplay ? "自動推薦已開啟（點擊關閉）" : "佇列結束後自動推薦相近歌曲";
  }
  const duration = current?.duration;
  if (channelsDiscordMusicElapsedEl) channelsDiscordMusicElapsedEl.textContent = formatDiscordMusicTime(state.elapsed);
  if (channelsDiscordMusicDurationEl) channelsDiscordMusicDurationEl.textContent = formatDiscordMusicTime(duration);
  if (channelsDiscordMusicProgressEl) channelsDiscordMusicProgressEl.style.width = duration ? `${Math.min(100, state.elapsed / duration * 100)}%` : "0%";

  if (channelsDiscordMusicQueueEl) {
    channelsDiscordMusicQueueEl.replaceChildren();
    const activePlaylist = current?.playlistTitle ?? state.queue[0]?.playlistTitle;
    const categoryQueue = activePlaylist
      ? state.queue.filter((track) => track.playlistTitle === activePlaylist)
      : state.queue;
    const tracks = current ? [current, ...categoryQueue] : categoryQueue;
    if (!tracks.length) {
      const empty = document.createElement("li");
      empty.className = "is-empty";
      empty.textContent = "用 Discord 的 /play 加入歌曲後，播放清單會顯示在這裡";
      channelsDiscordMusicQueueEl.appendChild(empty);
    } else {
      tracks.forEach((track, index) => {
        const item = document.createElement("li");
        if (index === 0 && current) item.className = "is-current";
        const number = document.createElement("span");
        number.textContent = index === 0 && current ? "♪" : String(current ? index : index + 1);
        const title = document.createElement("strong");
        title.textContent = track.title;
        title.title = track.title;
        const time = document.createElement("small");
        time.textContent = formatDiscordMusicTime(track.duration);
        item.append(number, title, time);
        if (!(index === 0 && current)) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "×";
          remove.title = `從播放清單移除 ${track.title}`;
          remove.dataset.queuePosition = String(current ? index : index + 1);
          item.appendChild(remove);
        } else {
          item.appendChild(document.createElement("span"));
        }
        channelsDiscordMusicQueueEl.appendChild(item);
      });
    }
  }
}

async function refreshDiscordMusic(): Promise<void> {
  try {
    renderDiscordMusic(await window.settings.channelsDiscordGetMusicState());
  } catch (err) {
    console.warn("[Channels] 讀取 Discord 音樂狀態失敗:", err);
  }
}

async function renderDiscordMusicHistory(): Promise<void> {
  if (!channelsDiscordMusicHistoryEl) return;
  channelsDiscordMusicHistoryEl.replaceChildren();
  const history = await window.settings.channelsDiscordGetMusicHistory();
  if (!history.length) {
    const empty = document.createElement("li");
    empty.className = "is-empty";
    empty.textContent = "歌曲或影片開始播放後會記錄在這裡";
    channelsDiscordMusicHistoryEl.appendChild(empty);
    return;
  }
  for (const entry of history) {
    const item = document.createElement("li");
    const icon = document.createElement("span");
    icon.textContent = "♪";
    const title = document.createElement("strong");
    title.textContent = entry.title;
    title.title = entry.url;
    const time = document.createElement("small");
    time.textContent = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(entry.playedAt));
    item.append(icon, title, time);
    channelsDiscordMusicHistoryEl.appendChild(item);
  }
}

function discordFavoriteSource(url: string): { label: string; className: string } {
  if (/open\.spotify\.com/i.test(url)) return { label: "Spotify", className: "is-spotify" };
  if (/(?:bilibili\.com|b23\.tv)/i.test(url)) return { label: "Bilibili", className: "is-bilibili" };
  if (/(?:youtube\.com|youtu\.be)/i.test(url)) return { label: "YouTube", className: "is-youtube" };
  return { label: "Music", className: "is-music" };
}

async function renderDiscordMusicFavorites(): Promise<void> {
  if (!channelsDiscordMusicFavoritesEl) return;
  channelsDiscordMusicFavoritesEl.replaceChildren();
  const favorites = await window.settings.channelsDiscordGetMusicFavorites();
  if (!favorites.length) {
    const empty = document.createElement("li");
    empty.className = "is-empty discord-player__favorites-empty";
    empty.textContent = "還沒有收藏歌曲。在 Discord 播放器按 ❤️ Save，或使用 /favorite。";
    channelsDiscordMusicFavoritesEl.appendChild(empty);
    return;
  }
  for (const entry of favorites) {
    const source = discordFavoriteSource(entry.url);
    const item = document.createElement("li");
    item.className = `discord-player__favorite ${source.className}`;

    const cover = document.createElement("div");
    cover.className = "discord-player__favorite-cover";
    cover.textContent = "♪";
    if (entry.thumbnail) {
      const image = document.createElement("img");
      image.src = entry.thumbnail;
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => image.remove(), { once: true });
      cover.appendChild(image);
    }

    const copy = document.createElement("div");
    copy.className = "discord-player__favorite-copy";
    const meta = document.createElement("div");
    meta.className = "discord-player__favorite-meta";
    const badge = document.createElement("span");
    badge.textContent = source.label;
    const saved = document.createElement("time");
    saved.dateTime = entry.savedAt;
    saved.textContent = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" }).format(new Date(entry.savedAt));
    meta.append(badge, saved);
    const title = document.createElement("a");
    title.href = entry.url;
    title.target = "_blank";
    title.rel = "noopener";
    title.textContent = entry.title;
    title.title = `開啟 ${entry.title}`;
    const detail = document.createElement("small");
    detail.textContent = [entry.playlistTitle, entry.duration ? formatDiscordMusicTime(entry.duration) : ""].filter(Boolean).join(" · ") || "單曲收藏";
    copy.append(meta, title, detail);

    const open = document.createElement("a");
    open.className = "discord-player__favorite-open";
    open.href = entry.url;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "↗";
    open.title = "開啟原始連結";
    item.append(cover, copy, open);
    channelsDiscordMusicFavoritesEl.appendChild(item);
  }
}

async function showDiscordMusicLibrary(view: "queue" | "favorites" | "history"): Promise<void> {
  discordMusicLibraryView = view;
  if (channelsDiscordMusicQueueEl) channelsDiscordMusicQueueEl.hidden = view !== "queue";
  if (channelsDiscordMusicFavoritesEl) channelsDiscordMusicFavoritesEl.hidden = view !== "favorites";
  if (channelsDiscordMusicHistoryEl) channelsDiscordMusicHistoryEl.hidden = view !== "history";
  const tabs = [
    [channelsDiscordMusicQueueToggleBtn, "queue"],
    [channelsDiscordMusicFavoritesToggleBtn, "favorites"],
    [channelsDiscordMusicHistoryToggleBtn, "history"],
  ] as const;
  for (const [button, name] of tabs) {
    button?.setAttribute("aria-selected", String(name === view));
    button?.setAttribute("aria-pressed", String(name === view));
  }
  if (channelsDiscordMusicClearBtn) channelsDiscordMusicClearBtn.hidden = view !== "queue";
  if (channelsDiscordMusicLibraryKindEl) channelsDiscordMusicLibraryKindEl.textContent = view === "queue" ? "PLAYLIST" : view === "favorites" ? "FAVORITES" : "HISTORY";
  if (view === "favorites") await renderDiscordMusicFavorites();
  else if (view === "history") await renderDiscordMusicHistory();
  renderDiscordMusic(discordMusicState);
}

async function controlDiscordMusic(input: DiscordMusicControlInput, quiet = false): Promise<void> {
  try {
    const result = await window.settings.channelsDiscordControlMusic(input);
    if (result.state) renderDiscordMusic(result.state);
    if (!quiet || !result.ok) setDiscordMusicFeedback(result.ok ? "ok" : "err", result.message);
  } catch (err) {
    setDiscordMusicFeedback("err", err instanceof Error ? err.message : String(err));
  }
}

function setSpotifyFeedback(kind: "info" | "ok" | "err", message: string): void {
  if (!channelsSpotifyFeedbackEl) return;
  channelsSpotifyFeedbackEl.textContent = message;
  channelsSpotifyFeedbackEl.className = "channels-feedback";
  channelsSpotifyFeedbackEl.classList.add(kind === "ok" ? "channels-feedback--ok" : kind === "err" ? "channels-feedback--err" : "channels-feedback--info");
}

function renderSpotify(status: SpotifyPlaybackStatus): void {
  spotifyStatus = status;
  const playback = status.playback;
  const usable = status.connected && status.devices.length > 0;
  if (channelsSpotifyPlanEl) {
    channelsSpotifyPlanEl.textContent = status.connected ? `${status.accountName ?? "已連線"}${status.product ? ` · ${status.product}` : ""}` : "尚未連線";
    channelsSpotifyPlanEl.classList.toggle("is-connected", status.connected);
  }
  if (channelsSpotifyConnectBtn) channelsSpotifyConnectBtn.textContent = status.connected ? "重新授權" : "連接 Spotify";
  if (channelsSpotifyDisconnectBtn) channelsSpotifyDisconnectBtn.disabled = !status.connected;
  if (channelsSpotifyQueryEl) channelsSpotifyQueryEl.disabled = !status.connected || !status.devices.length;
  if (channelsSpotifyPlayQueryBtn) channelsSpotifyPlayQueryBtn.disabled = !status.connected || !status.devices.length;
  for (const button of [channelsSpotifyPreviousBtn, channelsSpotifyToggleBtn, channelsSpotifyNextBtn]) if (button) button.disabled = !usable;
  if (channelsSpotifyVolumeEl) channelsSpotifyVolumeEl.disabled = !usable;
  if (channelsSpotifyDeviceSelectEl) {
    const selected = channelsSpotifyDeviceSelectEl.value;
    channelsSpotifyDeviceSelectEl.replaceChildren();
    if (!status.devices.length) channelsSpotifyDeviceSelectEl.add(new Option("請先開啟 Spotify 播放器", ""));
    else for (const device of status.devices) channelsSpotifyDeviceSelectEl.add(new Option(`${device.active ? "● " : ""}${device.name} · ${device.type}`, device.id));
    channelsSpotifyDeviceSelectEl.disabled = !status.connected || !status.devices.length;
    const active = status.devices.find((device) => device.active)?.id;
    channelsSpotifyDeviceSelectEl.value = status.devices.some((device) => device.id === selected) ? selected : (active ?? status.devices[0]?.id ?? "");
  }
  if (channelsSpotifyTitleEl) channelsSpotifyTitleEl.textContent = playback?.title ?? (status.connected ? "Spotify 已連線，請先在任一裝置開始播放" : "連線後即可控制手機或電腦上的 Spotify");
  if (channelsSpotifyArtistEl) channelsSpotifyArtistEl.textContent = playback?.artists ? `${playback.artists}${playback.album ? ` · ${playback.album}` : ""}` : "Premium 播放控制";
  if (channelsSpotifyDeviceEl) channelsSpotifyDeviceEl.textContent = playback?.deviceName ?? (status.connected ? "目前沒有作用中的播放器" : "等待 Spotify 裝置");
  if (channelsSpotifyToggleBtn) channelsSpotifyToggleBtn.textContent = playback?.active && !playback.paused ? "Ⅱ" : "▶";
  if (channelsSpotifyProgressEl) channelsSpotifyProgressEl.style.width = playback?.durationMs ? `${Math.min(100, playback.progressMs / playback.durationMs * 100)}%` : "0%";
  if (channelsSpotifyCoverEl) {
    if (playback?.imageUrl) { if (channelsSpotifyCoverEl.src !== playback.imageUrl) channelsSpotifyCoverEl.src = playback.imageUrl; channelsSpotifyCoverEl.hidden = false; }
    else { channelsSpotifyCoverEl.hidden = true; channelsSpotifyCoverEl.removeAttribute("src"); }
  }
  if (channelsSpotifyVolumeEl && document.activeElement !== channelsSpotifyVolumeEl && playback?.volume != null) channelsSpotifyVolumeEl.value = String(playback.volume);
  if (channelsSpotifyVolumeValueEl && document.activeElement !== channelsSpotifyVolumeEl) channelsSpotifyVolumeValueEl.value = `${playback?.volume ?? Number(channelsSpotifyVolumeEl?.value ?? 50)}%`;
  if (status.error) setSpotifyFeedback("err", status.error);
}

let spotifyRefreshInFlight = false;
async function refreshSpotify(): Promise<void> {
  if (spotifyRefreshInFlight) return;
  spotifyRefreshInFlight = true;
  try { renderSpotify(await window.settings.channelsSpotifyGetStatus()); }
  catch (err) { setSpotifyFeedback("err", err instanceof Error ? err.message : String(err)); }
  finally { spotifyRefreshInFlight = false; }
}

async function controlSpotifyUi(command: string, value?: number, query?: string): Promise<void> {
  const result = await window.settings.channelsSpotifyControl({ command, value, query, deviceId: channelsSpotifyDeviceSelectEl?.value || undefined });
  if (!result.ok) setSpotifyFeedback("err", result.message);
  await refreshSpotify();
}

function setBilibiliFeedback(kind: "info" | "ok" | "err", message: string): void {
  if (!channelsBilibiliFeedbackEl) return;
  channelsBilibiliFeedbackEl.textContent = message;
  channelsBilibiliFeedbackEl.className = "channels-feedback";
  channelsBilibiliFeedbackEl.classList.add(kind === "ok" ? "channels-feedback--ok" : kind === "err" ? "channels-feedback--err" : "channels-feedback--info");
}

function renderBilibili(status: BilibiliConnectionStatus): void {
  channelsBilibiliCardEl?.classList.toggle("is-connected", status.connected);
  if (channelsBilibiliStatusEl) {
    channelsBilibiliStatusEl.textContent = status.connected ? "已連接 · Opera GX" : "尚未連接";
    channelsBilibiliStatusEl.classList.toggle("is-connected", status.connected);
  }
  if (channelsBilibiliSessionTitleEl) channelsBilibiliSessionTitleEl.textContent = status.connected ? "Opera GX 登入狀態已連接" : "連接你的 Opera GX 登入狀態";
  if (channelsBilibiliSessionDetailEl) channelsBilibiliSessionDetailEl.textContent = status.connected
    ? "Discord 收到 Bilibili 連結時，會自動使用這台 Mac 的瀏覽器登入狀態。"
    : "連接後，Discord 播放 Bilibili 連結時會自動讀取你的本機登入狀態。";
  if (channelsBilibiliConnectBtn) channelsBilibiliConnectBtn.textContent = status.connected ? "重新驗證" : "連接 Bilibili";
  if (channelsBilibiliDisconnectBtn) channelsBilibiliDisconnectBtn.disabled = !status.connected;
}

async function refreshBilibili(): Promise<void> {
  try { renderBilibili(await window.settings.channelsBilibiliGetStatus()); }
  catch (err) { setBilibiliFeedback("err", err instanceof Error ? err.message : String(err)); }
}

function renderChannelStatus(el: HTMLElement | null, phase: string, message?: string): void {
  if (!el) return;
  const dot = el.querySelector(".channels-status__dot");
  const text = el.querySelector(".channels-status__text");
  if (dot) {
    dot.className = "channels-status__dot";
    if (phase === "running") dot.classList.add("channels-status__dot--running");
    else if (phase === "starting") dot.classList.add("channels-status__dot--starting");
    else if (phase === "error") dot.classList.add("channels-status__dot--error");
    else if (phase === "config_missing") dot.classList.add("channels-status__dot--config_missing");
    else dot.classList.add("channels-status__dot--offline");
  }
  if (text) text.textContent = message ?? (phase === "running" ? "運行中" : phase === "starting" ? "啟動中" : phase === "config_missing" ? "配置缺失" : phase === "error" ? "錯誤" : "未啟用");
}

async function loadChannelsPanel(): Promise<void> {
  if (channelsInitialized) {
    await Promise.all([refreshDiscordProfile(), refreshDiscordMusic(), refreshSpotify(), refreshBilibili()]);
    return;
  }
  channelsInitialized = true;
  try {
    const cfg = await window.settings.channelsGetConfig();
    if (channelsWechatEnabledEl) channelsWechatEnabledEl.checked = !!cfg.wechat.enabled;
    if (channelsFeishuEnabledEl) channelsFeishuEnabledEl.checked = !!cfg.feishu.enabled;
    if (channelsDiscordEnabledEl) channelsDiscordEnabledEl.checked = !!cfg.discord.enabled;
    if (channelsRateUserEl) channelsRateUserEl.value = String(cfg.rateLimitPerUser ?? 10);
    if (channelsRateChannelEl) channelsRateChannelEl.value = String(cfg.rateLimitPerChannel ?? 100);
    if (channelsTtsEl) channelsTtsEl.checked = cfg.ttsEnabled !== false;
    if (channelsStickerEl) channelsStickerEl.checked = cfg.stickerEnabled !== false;
    if (channelsMirrorEl) channelsMirrorEl.checked = cfg.mirrorToDesktop !== false;
    if (channelsSandboxEl) channelsSandboxEl.checked = cfg.toolSandbox === "safe-only";

    // 飛書字段填充（長連接模式只需要 App ID；secret 加密存盤，UI 不回填明文）
    if (channelsFeishuAppIdEl) channelsFeishuAppIdEl.value = cfg.feishu.appId ?? "";
    if (channelsFeishuAppSecretEl) {
      channelsFeishuAppSecretEl.value = "";
      channelsFeishuAppSecretEl.placeholder = cfg.feishu.appSecret
        ? "已保存（輸入新值會覆蓋）"
        : "點擊保存配置時加密保存";
    }
    if (channelsDiscordTokenEl) {
      channelsDiscordTokenEl.value = "";
      channelsDiscordTokenEl.placeholder = cfg.discord.botToken ? "已保存（輸入新值會覆蓋）" : "保存時會加密";
    }
    if (channelsDiscordGuildIdsEl) channelsDiscordGuildIdsEl.value = (cfg.discord.allowedGuildIds ?? []).join(", ");
    if (channelsDiscordChannelIdsEl) channelsDiscordChannelIdsEl.value = (cfg.discord.allowedChannelIds ?? []).join(", ");
    if (channelsDiscordUserIdsEl) channelsDiscordUserIdsEl.value = (cfg.discord.allowedUserIds ?? []).join(", ");
    if (channelsDiscordCodexOwnerIdEl) channelsDiscordCodexOwnerIdEl.value = cfg.discord.codexImageOwnerId ?? "";
    if (channelsDiscordRequireMentionEl) channelsDiscordRequireMentionEl.checked = cfg.discord.requireMention !== false;
    if (channelsDiscordVoiceEnabledEl) channelsDiscordVoiceEnabledEl.checked = cfg.discord.voiceEnabled !== false;
    if (channelsSpotifyClientIdEl) channelsSpotifyClientIdEl.value = cfg.spotify.clientId ?? "";
    if (channelsSpotifyClientSecretEl) {
      channelsSpotifyClientSecretEl.value = "";
      channelsSpotifyClientSecretEl.placeholder = cfg.spotify.clientSecret ? "已加密保存（輸入新值會覆蓋）" : "從 Spotify Developer Dashboard 複製";
    }

    // 拉一次渠道狀態
    const status = (await window.settings.channelsGetStatus()) as Record<string, { phase: string; message?: string }>;
    renderChannelStatus(channelsWechatStatusEl, status.wechat?.phase ?? "offline", status.wechat?.message);
    renderChannelStatus(channelsFeishuStatusEl, status.feishu?.phase ?? "offline", status.feishu?.message);
    renderChannelStatus(channelsDiscordStatusEl, status.discord?.phase ?? "offline", status.discord?.message);
    await Promise.all([refreshDiscordProfile(), refreshDiscordMusic(), refreshSpotify(), refreshBilibili()]);
    if (discordMusicRefreshTimer == null) {
      discordMusicRefreshTimer = window.setInterval(() => void refreshDiscordMusic(), 1000);
    }
    if (spotifyRefreshTimer == null) spotifyRefreshTimer = window.setInterval(() => void refreshSpotify(), 3000);
    // Phase 3.4：拉一次消息日誌
    void refreshChannelsLog();
  } catch (err) {
    console.warn("[Channels] loadChannelsPanel 失敗:", err);
  }

  // 自動保存（debounce 200ms）
  const scheduleSave = () => {
    if (channelsSaveTimer != null) window.clearTimeout(channelsSaveTimer);
    channelsSaveTimer = window.setTimeout(() => {
      void window.settings.channelsSaveConfig({
        wechat: { enabled: channelsWechatEnabledEl?.checked ?? false },
        feishu: { enabled: channelsFeishuEnabledEl?.checked ?? false },
        rateLimitPerUser: Number(channelsRateUserEl?.value) || 10,
        rateLimitPerChannel: Number(channelsRateChannelEl?.value) || 100,
        ttsEnabled: channelsTtsEl?.checked ?? true,
        stickerEnabled: channelsStickerEl?.checked ?? true,
        mirrorToDesktop: channelsMirrorEl?.checked ?? true,
        toolSandbox: channelsSandboxEl?.checked ? "safe-only" : "all",
      });
    }, 200);
  };
  for (const el of [
    channelsWechatEnabledEl,
    channelsFeishuEnabledEl,
    channelsRateUserEl,
    channelsRateChannelEl,
    channelsTtsEl,
    channelsStickerEl,
    channelsMirrorEl,
    channelsSandboxEl,
  ]) {
    el?.addEventListener("change", scheduleSave);
  }

  // 監聽安裝進度（Phase 1+ 才會收到）
  window.settings.onChannelsInstallProgress((progress) => {
    const target = progress.channel === "wechat" ? channelsWechatStatusEl : progress.channel === "feishu" ? channelsFeishuStatusEl : progress.channel === "discord" ? channelsDiscordStatusEl : null;
    if (target) renderChannelStatus(target, "starting", `${progress.phase} ${progress.pct}%`);
  });
  window.settings.onChannelsStatusChanged((status) => {
    const s = status as Record<string, { phase: string; message?: string }>;
    renderChannelStatus(channelsWechatStatusEl, s.wechat?.phase ?? "offline", s.wechat?.message);
    renderChannelStatus(channelsFeishuStatusEl, s.feishu?.phase ?? "offline", s.feishu?.message);
    renderChannelStatus(channelsDiscordStatusEl, s.discord?.phase ?? "offline", s.discord?.message);
    void refreshDiscordProfile();
  });

  // ===== 飛書交互（Phase 2 長連接版） =====

  // 顯示/隱藏 App Secret
  channelsFeishuAppSecretRevealBtn?.addEventListener("click", () => {
    if (!channelsFeishuAppSecretEl) return;
    channelsFeishuAppSecretEl.type =
      channelsFeishuAppSecretEl.type === "password" ? "text" : "password";
  });

  // 保存配置（secret 用 safeStorage 加密後落盤 + 觸發長連接重連）
  channelsFeishuSaveBtn?.addEventListener("click", async () => {
    setFeishuFeedback("info", "保存並連接中...");
    const patch: Record<string, unknown> = {
      feishu: {
        enabled: channelsFeishuEnabledEl?.checked ?? false,
        appId: channelsFeishuAppIdEl?.value.trim() || undefined,
      },
    };
    // 僅在用戶輸入了新值時才覆蓋 secret（避免誤清空）
    if (channelsFeishuAppSecretEl?.value) {
      (patch.feishu as Record<string, unknown>).appSecret = channelsFeishuAppSecretEl.value;
    }
    try {
      await window.settings.channelsSaveConfig(patch);
      // 保存後立即觸發飛書 adapter 重建 + 重連長連接
      await window.settings.channelsRestart();
      setFeishuFeedback("ok", "已保存，飛書長連接正在建立…");
      // 清空輸入框（已落盤），並把 placeholder 切到"已保存"
      if (channelsFeishuAppSecretEl) {
        channelsFeishuAppSecretEl.value = "";
        channelsFeishuAppSecretEl.placeholder = "已保存（輸入新值會覆蓋）";
      }
    } catch (err) {
      setFeishuFeedback("err", err instanceof Error ? err.message : String(err));
    }
  });

  // ===== Spotify Premium / Connect =====
  channelsSpotifySecretRevealBtn?.addEventListener("click", () => {
    if (channelsSpotifyClientSecretEl) channelsSpotifyClientSecretEl.type = channelsSpotifyClientSecretEl.type === "password" ? "text" : "password";
  });
  channelsSpotifyConnectBtn?.addEventListener("click", async () => {
    const clientId = channelsSpotifyClientIdEl?.value.trim() ?? "";
    if (!clientId) return setSpotifyFeedback("err", "請輸入 Spotify Client ID");
    channelsSpotifyConnectBtn.disabled = true;
    setSpotifyFeedback("info", "正在開啟 Spotify 授權頁…");
    try {
      const result = await window.settings.channelsSpotifyAuthorize({ clientId, clientSecret: channelsSpotifyClientSecretEl?.value || undefined });
      if (!result.ok) throw new Error(result.error || "Spotify 授權無法啟動");
      if (channelsSpotifyClientSecretEl?.value) { channelsSpotifyClientSecretEl.value = ""; channelsSpotifyClientSecretEl.placeholder = "已加密保存（輸入新值會覆蓋）"; }
      setSpotifyFeedback("info", result.message || "請在瀏覽器完成 Spotify 授權");
    } catch (err) { setSpotifyFeedback("err", err instanceof Error ? err.message : String(err)); }
    finally { channelsSpotifyConnectBtn.disabled = false; }
  });
  channelsSpotifyDisconnectBtn?.addEventListener("click", async () => {
    const confirmed = await showModal({ title: "解除 Spotify 連線？", message: "Cyrene 會刪除本機保存的 Spotify 授權；之後可隨時重新連線。", icon: "🎧", confirmText: "解除連線" });
    if (!confirmed) return;
    const result = await window.settings.channelsSpotifyDisconnect();
    setSpotifyFeedback(result.ok ? "ok" : "err", result.message || result.error || "Spotify 已解除連線");
    await refreshSpotify();
  });
  channelsSpotifyPreviousBtn?.addEventListener("click", () => void controlSpotifyUi("previous"));
  channelsSpotifyNextBtn?.addEventListener("click", () => void controlSpotifyUi("next"));
  channelsSpotifyToggleBtn?.addEventListener("click", () => void controlSpotifyUi(spotifyStatus.playback?.active && !spotifyStatus.playback.paused ? "pause" : "resume"));
  channelsSpotifyDeviceSelectEl?.addEventListener("change", () => void controlSpotifyUi("transfer"));
  const playSpotifyQuery = async () => {
    const query = channelsSpotifyQueryEl?.value.trim() ?? "";
    if (!query) { setSpotifyFeedback("err", "請輸入歌曲名稱或 Spotify 連結"); return; }
    if (channelsSpotifyPlayQueryBtn) channelsSpotifyPlayQueryBtn.disabled = true;
    try {
      await controlSpotifyUi("play", undefined, query);
      if (channelsSpotifyQueryEl) channelsSpotifyQueryEl.value = "";
    } finally {
      if (channelsSpotifyPlayQueryBtn) channelsSpotifyPlayQueryBtn.disabled = false;
    }
  };
  channelsSpotifyPlayQueryBtn?.addEventListener("click", () => void playSpotifyQuery());
  channelsSpotifyQueryEl?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void playSpotifyQuery(); } });
  channelsSpotifyVolumeEl?.addEventListener("input", () => {
    const volume = Number(channelsSpotifyVolumeEl.value);
    if (channelsSpotifyVolumeValueEl) channelsSpotifyVolumeValueEl.value = `${volume}%`;
    if (spotifyVolumeTimer != null) window.clearTimeout(spotifyVolumeTimer);
    spotifyVolumeTimer = window.setTimeout(() => void controlSpotifyUi("volume", volume), 160);
  });

  // ===== Bilibili / Opera GX browser session =====
  channelsBilibiliConnectBtn?.addEventListener("click", async () => {
    channelsBilibiliConnectBtn.disabled = true;
    setBilibiliFeedback("info", "正在驗證 Opera GX 的 Bilibili 登入狀態…");
    try {
      const result = await window.settings.channelsBilibiliConnect();
      if (!result.ok) throw new Error(result.error || "Bilibili 連接失敗");
      setBilibiliFeedback("ok", result.message || "Bilibili 已連接");
      await refreshBilibili();
    } catch (err) {
      setBilibiliFeedback("err", err instanceof Error ? err.message : String(err));
    } finally {
      channelsBilibiliConnectBtn.disabled = false;
    }
  });
  channelsBilibiliDisconnectBtn?.addEventListener("click", async () => {
    const result = await window.settings.channelsBilibiliDisconnect();
    setBilibiliFeedback(result.ok ? "ok" : "err", result.message || result.error || "Bilibili 已解除連接");
    await refreshBilibili();
  });

  // ===== Discord Gateway =====
  const parseIds = (value: string | undefined): string[] => [...new Set((value ?? "").split(/[\s,]+/).map((v) => v.trim()).filter(Boolean))];
  const setDiscordFeedback = (kind: "info" | "ok" | "err", msg: string): void => {
    if (!channelsDiscordFeedbackEl) return;
    channelsDiscordFeedbackEl.textContent = msg;
    channelsDiscordFeedbackEl.className = "channels-feedback";
    channelsDiscordFeedbackEl.classList.add(kind === "ok" ? "channels-feedback--ok" : kind === "err" ? "channels-feedback--err" : "channels-feedback--info");
  };
  channelsDiscordTokenRevealBtn?.addEventListener("click", () => {
    if (channelsDiscordTokenEl) channelsDiscordTokenEl.type = channelsDiscordTokenEl.type === "password" ? "text" : "password";
  });
  channelsDiscordEnabledEl?.addEventListener("change", async () => {
    const enabled = channelsDiscordEnabledEl.checked;
    channelsDiscordEnabledEl.disabled = true;
    setDiscordFeedback("info", enabled ? "正在連接 Discord…" : "正在停止 Discord 連線…");
    const discord: Record<string, unknown> = { enabled };
    if (channelsDiscordTokenEl?.value.trim()) discord.botToken = channelsDiscordTokenEl.value.trim();
    try {
      await window.settings.channelsSaveConfig({ discord });
      const result = await window.settings.channelsDiscordTestConnection();
      if (!result.ok) throw new Error(result.error || (enabled ? "Discord 連接失敗" : "停止連線失敗"));
      setDiscordFeedback("ok", result.message || (enabled ? "Discord Gateway 已連接" : "Discord 已停止連線"));
      if (channelsDiscordTokenEl?.value.trim()) {
        channelsDiscordTokenEl.value = "";
        channelsDiscordTokenEl.placeholder = "已保存（輸入新值會覆蓋）";
      }
      const status = (await window.settings.channelsGetStatus()) as Record<string, { phase: string; message?: string }>;
      renderChannelStatus(channelsDiscordStatusEl, status.discord?.phase ?? "offline", status.discord?.message);
      await refreshDiscordProfile();
    } catch (err) {
      setDiscordFeedback("err", err instanceof Error ? err.message : String(err));
      const status = (await window.settings.channelsGetStatus().catch(() => null)) as Record<string, { phase: string; message?: string }> | null;
      if (status) renderChannelStatus(channelsDiscordStatusEl, status.discord?.phase ?? "offline", status.discord?.message);
      await refreshDiscordProfile();
    } finally {
      channelsDiscordEnabledEl.disabled = false;
    }
  });
  const closeDiscordMediaMenu = (): void => {
    channelsDiscordMediaMenuEl?.setAttribute("hidden", "");
    channelsDiscordAvatarPickBtn?.setAttribute("aria-expanded", "false");
  };
  channelsDiscordAvatarPickBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!channelsDiscordMediaMenuEl) return;
    const willOpen = channelsDiscordMediaMenuEl.hasAttribute("hidden");
    if (willOpen) channelsDiscordMediaMenuEl.removeAttribute("hidden");
    else channelsDiscordMediaMenuEl.setAttribute("hidden", "");
    channelsDiscordAvatarPickBtn.setAttribute("aria-expanded", String(willOpen));
  });
  channelsDiscordMediaMenuEl?.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", closeDiscordMediaMenu);
  channelsDiscordAvatarOptionBtn?.addEventListener("click", async () => {
    closeDiscordMediaMenu();
    const avatarPath = await window.settings.channelsDiscordPickAvatar();
    if (!avatarPath) return;
    pendingDiscordAvatarPath = avatarPath;
    setDiscordProfileFeedback("info", `已選擇 ${avatarPath.split(/[\\/]/).pop() ?? "新頭像"}，按「更新 Discord 身分」套用。`);
  });
  channelsDiscordBannerOptionBtn?.addEventListener("click", async () => {
    closeDiscordMediaMenu();
    const bannerPath = await window.settings.channelsDiscordPickBanner();
    if (!bannerPath) return;
    pendingDiscordBannerPath = bannerPath;
    setDiscordProfileFeedback("info", `已選擇 ${bannerPath.split(/[\\/]/).pop() ?? "新 Banner"}，按「更新 Discord 身分」套用。`);
  });

  const discordEmojis = [
    "😀", "😊", "🥰", "😍", "😌", "😉", "🥺",
    "✨", "💫", "🌸", "🌙", "⭐", "💜", "🩷",
    "🎀", "🪽", "🦋", "🌷", "🍀", "🍓", "🍰",
    "🎵", "🎧", "🎮", "📖", "💬", "🤍", "🔥",
  ];
  if (channelsDiscordEmojiPickerEl) {
    channelsDiscordEmojiPickerEl.replaceChildren(...discordEmojis.map((emoji) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = emoji;
      button.title = emoji;
      button.setAttribute("aria-label", `插入 ${emoji}`);
      return button;
    }));
  }
  let discordEmojiTarget: HTMLInputElement | null = null;
  const closeDiscordEmojiPicker = (): void => {
    channelsDiscordEmojiPickerEl?.setAttribute("hidden", "");
    discordEmojiTarget = null;
  };
  for (const trigger of document.querySelectorAll<HTMLButtonElement>(".discord-emoji-button")) {
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const input = document.getElementById(trigger.dataset.emojiTarget ?? "") as HTMLInputElement | null;
      if (!input || !channelsDiscordEmojiPickerEl) return;
      if (!channelsDiscordEmojiPickerEl.hasAttribute("hidden") && discordEmojiTarget === input) {
        closeDiscordEmojiPicker();
        return;
      }
      discordEmojiTarget = input;
      const rect = trigger.getBoundingClientRect();
      const pickerWidth = 270;
      channelsDiscordEmojiPickerEl.style.left = `${Math.max(10, Math.min(rect.right - pickerWidth, window.innerWidth - pickerWidth - 10))}px`;
      channelsDiscordEmojiPickerEl.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 190)}px`;
      channelsDiscordEmojiPickerEl.removeAttribute("hidden");
    });
  }
  channelsDiscordEmojiPickerEl?.addEventListener("click", (event) => {
    event.stopPropagation();
    const button = (event.target as HTMLElement).closest("button");
    if (!button || !discordEmojiTarget) return;
    const start = discordEmojiTarget.selectionStart ?? discordEmojiTarget.value.length;
    const end = discordEmojiTarget.selectionEnd ?? start;
    discordEmojiTarget.setRangeText(button.textContent ?? "", start, end, "end");
    discordEmojiTarget.focus();
    closeDiscordEmojiPicker();
  });
  document.addEventListener("click", closeDiscordEmojiPicker);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDiscordEmojiPicker();
      closeDiscordMediaMenu();
    }
  });
  channelsDiscordProfileSaveBtn?.addEventListener("click", async () => {
    if (!channelsDiscordUsernameEl?.value.trim()) {
      setDiscordProfileFeedback("err", "請輸入 Bot 顯示名稱。");
      return;
    }
    channelsDiscordProfileSaveBtn.disabled = true;
    setDiscordProfileFeedback("info", "正在更新 Discord 身分…");
    try {
      const result = await window.settings.channelsDiscordUpdateProfile({
        username: channelsDiscordUsernameEl.value.trim(),
        activityText: channelsDiscordActivityEl?.value ?? "",
        status: channelsDiscordPresenceEl?.value ?? "online",
        avatarPath: pendingDiscordAvatarPath,
        bannerPath: pendingDiscordBannerPath,
      });
      if (!result.ok || !result.profile) throw new Error(result.error || "更新失敗");
      pendingDiscordAvatarPath = undefined;
      pendingDiscordBannerPath = undefined;
      renderDiscordProfile(result.profile);
      setDiscordProfileFeedback("ok", "Discord 身分已更新。名稱修改受到 Discord 頻率限制，短時間內請勿重複變更。 ");
    } catch (err) {
      setDiscordProfileFeedback("err", err instanceof Error ? err.message : String(err));
    } finally {
      channelsDiscordProfileSaveBtn.disabled = false;
    }
  });
  channelsDiscordMusicToggleBtn?.addEventListener("click", () => {
    void controlDiscordMusic({ command: discordMusicState.paused ? "resume" : "pause" }, true);
  });
  channelsDiscordMusicPreviousBtn?.addEventListener("click", () => void controlDiscordMusic({ command: "previous" }, true));
  channelsDiscordMusicCoverEl?.addEventListener("error", () => {
    channelsDiscordMusicCoverEl.hidden = true;
    channelsDiscordMusicRecordEl?.classList.remove("has-cover");
  });
  channelsDiscordMusicNextBtn?.addEventListener("click", () => void controlDiscordMusic({ command: "skip" }, true));
  channelsDiscordMusicStopBtn?.addEventListener("click", () => void controlDiscordMusic({ command: "stop" }, true));
  channelsDiscordMusicRepeatBtn?.addEventListener("click", () => {
    const command = discordMusicState.repeat === "off" ? "repeat-track" : discordMusicState.repeat === "track" ? "repeat-queue" : "repeat-off";
    void controlDiscordMusic({ command }, true);
  });
  channelsDiscordMusicShuffleBtn?.addEventListener("click", () => {
    void controlDiscordMusic({ command: discordMusicState.shuffle ? "ordered" : "shuffle" }, true);
  });
  channelsDiscordMusicAutoplayBtn?.addEventListener("click", () => {
    void controlDiscordMusic({ command: discordMusicState.autoplay ? "autoplay-off" : "autoplay-on" }, true);
  });
  channelsDiscordMusicClearBtn?.addEventListener("click", () => void controlDiscordMusic({ command: "clear" }));
  channelsDiscordMusicQueueToggleBtn?.addEventListener("click", () => void showDiscordMusicLibrary("queue"));
  channelsDiscordMusicFavoritesToggleBtn?.addEventListener("click", () => void showDiscordMusicLibrary("favorites"));
  channelsDiscordMusicHistoryToggleBtn?.addEventListener("click", () => void showDiscordMusicLibrary("history"));
  channelsDiscordMusicQueueEl?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-queue-position]");
    const position = Number(button?.dataset.queuePosition);
    if (Number.isInteger(position) && position > 0) void controlDiscordMusic({ command: "remove", value: position }, true);
  });
  channelsDiscordMusicVolumeEl?.addEventListener("input", () => {
    const value = Number(channelsDiscordMusicVolumeEl.value);
    if (channelsDiscordMusicVolumeValueEl) channelsDiscordMusicVolumeValueEl.value = `${value}%`;
    if (discordMusicVolumeTimer != null) window.clearTimeout(discordMusicVolumeTimer);
    discordMusicVolumeTimer = window.setTimeout(() => void controlDiscordMusic({ command: "volume", value }, true), 120);
  });
  channelsDiscordSaveBtn?.addEventListener("click", async () => {
    setDiscordFeedback("info", "保存並連接中…");
    const discord: Record<string, unknown> = {
      enabled: channelsDiscordEnabledEl?.checked ?? false,
      allowedGuildIds: parseIds(channelsDiscordGuildIdsEl?.value),
      allowedChannelIds: parseIds(channelsDiscordChannelIdsEl?.value),
      allowedUserIds: parseIds(channelsDiscordUserIdsEl?.value),
      codexImageOwnerId: channelsDiscordCodexOwnerIdEl?.value.trim() || undefined,
      requireMention: channelsDiscordRequireMentionEl?.checked ?? true,
      voiceEnabled: channelsDiscordVoiceEnabledEl?.checked ?? true,
    };
    if (channelsDiscordTokenEl?.value.trim()) discord.botToken = channelsDiscordTokenEl.value.trim();
    try {
      await window.settings.channelsSaveConfig({ discord });
      const result = await window.settings.channelsDiscordTestConnection();
      if (!result.ok) throw new Error(result.error || "Discord 連接失敗");
      setDiscordFeedback("ok", result.message || "Discord Gateway 已連接");
      if (channelsDiscordTokenEl) {
        channelsDiscordTokenEl.value = "";
        channelsDiscordTokenEl.placeholder = "已保存（輸入新值會覆蓋）";
      }
      await refreshDiscordProfile();
    } catch (err) {
      setDiscordFeedback("err", err instanceof Error ? err.message : String(err));
    }
  });

  // ===== 微信交互（掃碼登錄走 iLink HTTP API，詳見 src/main/channels/adapters/wechat/） =====

  function setWechatFeedback(kind: "info" | "ok" | "err", msg: string): void {
    if (!channelsWechatFeedbackEl) return;
    channelsWechatFeedbackEl.textContent = msg;
    channelsWechatFeedbackEl.className = "channels-feedback";
    if (kind === "ok") channelsWechatFeedbackEl.classList.add("channels-feedback--ok");
    else if (kind === "err") channelsWechatFeedbackEl.classList.add("channels-feedback--err");
    else channelsWechatFeedbackEl.classList.add("channels-feedback--info");
  }

  // 掃碼登錄：Main Process 生成 PNG → 推到 Renderer → modal 彈窗
  const channelsWechatQrEl = document.getElementById("channels-wechat-qr");
  const channelsWechatQrImgEl = document.getElementById("channels-wechat-qr-img") as HTMLImageElement | null;
  const channelsWechatQrCloseBtn = document.getElementById("channels-wechat-qr-close");
  const channelsWechatQrBackdrop = document.getElementById("channels-wechat-qr-backdrop");

  function showWechatQr(dataUrl: string): void {
    if (channelsWechatQrImgEl) {
      channelsWechatQrImgEl.src = dataUrl;
      channelsWechatQrImgEl.classList.remove("is-empty");
    }
    channelsWechatQrEl?.removeAttribute("hidden");
  }
  function hideWechatQr(): void {
    channelsWechatQrEl?.setAttribute("hidden", "");
    if (channelsWechatQrImgEl) {
      channelsWechatQrImgEl.src = "";
      channelsWechatQrImgEl.classList.add("is-empty");
    }
  }

  // 關閉交互：點按鈕 / 點背景 / 按 ESC
  channelsWechatQrCloseBtn?.addEventListener("click", hideWechatQr);
  channelsWechatQrBackdrop?.addEventListener("click", hideWechatQr);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && channelsWechatQrEl && !channelsWechatQrEl.hasAttribute("hidden")) {
      hideWechatQr();
    }
  });

  // 訂閱 Main 推送的二維碼（每次登錄會推一次）
  window.settings.onChannelsWechatQrcode((dataUrl) => {
    console.log("[WechatSettings] QR event received, dataUrl prefix:", dataUrl?.slice(0, 40), "len:", dataUrl?.length);
    showWechatQr(dataUrl);
    setWechatFeedback("info", "請用微信掃描二維碼");
  });
  // 訂閱 Main 推送的登錄結果（成功 / 失敗 / 二維碼過期）
  window.settings.onChannelsWechatLoginDone((payload) => {
    hideWechatQr();
    if (payload.ok) {
      setWechatFeedback("ok", `已登錄（botId=${payload.botId ?? "?"}）`);
    } else {
      setWechatFeedback("err", `登錄失敗：${payload.error ?? "未知錯誤"}`);
    }
  });

  channelsWechatLoginBtn?.addEventListener("click", async () => {
    hideWechatQr();
    setWechatFeedback("info", "正在啟動掃碼…");
    try {
      const result = await window.settings.channelsWechatLoginStart();
      if (result.ok) {
        // 二維碼由 onChannelsWechatQrcode 推過來並顯示；這裡只刷個輕提示
        setWechatFeedback("info", "等待二維碼推送…");
      } else {
        setWechatFeedback("err", result.error ?? "啟動失敗");
      }
    } catch (err) {
      setWechatFeedback("err", err instanceof Error ? err.message : String(err));
    }
  });

  // 重啟連接
  channelsWechatRestartBtn?.addEventListener("click", async () => {
    setWechatFeedback("info", "重啟連接中…");
    try {
      await window.settings.channelsRestart();
      setWechatFeedback("ok", "已重啟");
    } catch (err) {
      setWechatFeedback("err", err instanceof Error ? err.message : String(err));
    }
  });
}

function setFeishuFeedback(kind: "info" | "ok" | "err", msg: string): void {
  if (!channelsFeishuFeedbackEl) return;
  channelsFeishuFeedbackEl.textContent = msg;
  channelsFeishuFeedbackEl.className = "channels-feedback";
  if (kind === "ok") channelsFeishuFeedbackEl.classList.add("channels-feedback--ok");
  else if (kind === "err") channelsFeishuFeedbackEl.classList.add("channels-feedback--err");
  else channelsFeishuFeedbackEl.classList.add("channels-feedback--info");
}

// ===== Phase 3.4：消息日誌 =====
const channelsLogListEl = document.getElementById("channels-log-list");
const channelsLogRefreshBtn = document.getElementById("channels-log-refresh");
const channelsLogClearBtn = document.getElementById("channels-log-clear");

interface LogEntry {
  at: string;
  dir: "incoming" | "outgoing";
  channel: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  text: string;
  hasAttachments?: boolean;
}

function renderChannelsLog(entries: LogEntry[]): void {
  if (!channelsLogListEl) return;
  if (entries.length === 0) {
    channelsLogListEl.innerHTML = '<p class="empty-hint">暫無消息。</p>';
    return;
  }
  const html = entries
    .map((e) => {
      const t = new Date(e.at);
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      const ss = String(t.getSeconds()).padStart(2, "0");
      const dir = e.dir === "incoming" ? "← 收到" : "→ 回覆";
      const who = e.senderName ? `${e.senderName} (${e.senderId})` : e.senderId;
      const safe = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const text = e.text.length > 280 ? safe(e.text.slice(0, 280)) + "…" : safe(e.text);
      return `<div class="channels-log__entry channels-log__entry--${e.dir}">
        <div class="channels-log__meta">${hh}:${mm}:${ss} · ${dir} · ${safe(e.channel)} · ${safe(who)}</div>
        <div class="channels-log__text">${text}</div>
      </div>`;
    })
    .join("");
  channelsLogListEl.innerHTML = html;
}

async function refreshChannelsLog(): Promise<void> {
  try {
    const entries = (await window.settings.channelsLogGet(100)) as LogEntry[];
    renderChannelsLog(entries);
  } catch (err) {
    console.warn("[Channels] refreshChannelsLog 失敗:", err);
  }
}

channelsLogRefreshBtn?.addEventListener("click", () => void refreshChannelsLog());
channelsLogClearBtn?.addEventListener("click", async () => {
  if (!confirm("確認清空所有 bot 消息日誌？")) return;
  await window.settings.channelsLogClear();
  await refreshChannelsLog();
});

// 首次進入 channels panel 時拉一次日誌
// （也可以在用戶展開 details 時再拉，但保持簡單直接拉）
void loadChannelsPanel();
// 啟動時讀 URL hash 決定初始標籤（main 通過 loadURL 帶 #api 實現"切換模型按鈕跳 API"）。
// 無 hash 默認 general。
const initialSection = (window.location.hash || "#general").slice(1);
switchSection(initialSection);
window.addEventListener("hashchange", () => {
  switchSection((window.location.hash || "#general").slice(1));
});
// 監聽 main 發來的切標籤事件（窗口已打開時，main 不重新 loadURL，改發事件）
window.settings?.onSwitchSection?.((section) => {
  switchSection(section);
});
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
            window.alert("已切換至 " + (value === "bgem3" ? "BGE-M3" : "MiniLM") + "。由於向量維度不同，已清除 " + result.clearedEntries + " 條舊向量記憶。");
          }
        } else {
          // Rollback on failure
          cards.forEach((c) => c.classList.remove("is-active"));
          if (previousValue) {
            const prevCard = document.querySelector('.rag-model-card[data-value="' + previousValue + '"]:not([data-reranker])');
            prevCard?.classList.add("is-active");
            localStorage.setItem(KEY, previousValue);
          }
          window.alert("切換失敗：" + (result?.error || "未知錯誤"));
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

/* ===== Reranker install status (real on-disk check via IPC) ===== */
(async () => {
  const lightEl = document.getElementById("reranker-light-status");
  const standardEl = document.getElementById("reranker-standard-status");
  try {
    const status = await (window as any).settings?.getRerankerStatus?.();
    if (!status) return;
    if (lightEl) lightEl.textContent = status.light ? "已下載 · 約 23MB" : "未下載 · 可選";
    if (standardEl) standardEl.textContent = status.standard ? "已下載 · 約 279MB" : "未下載 · 可選";
  } catch (err) {
    console.warn("[Reranker] status check failed:", err);
    if (lightEl) lightEl.textContent = "狀態未知";
    if (standardEl) standardEl.textContent = "狀態未知";
  }
})();

/* ===== Embedding model status ===== */
(async () => {
  const bgem3El = document.getElementById("embedding-bgem3-status");
  const minilmEl = document.getElementById("embedding-minilm-status");
  try {
    const status = await window.modelConfig?.getModelInstallStatus?.();
    if (!status) {
      if (bgem3El) bgem3El.textContent = "狀態未知";
      if (minilmEl) minilmEl.textContent = "狀態未知";
      return;
    }
    if (bgem3El) bgem3El.textContent = status.embedding?.bgem3 ? "已下載 · 約 570MB" : "未下載";
    if (minilmEl) minilmEl.textContent = status.embedding?.minilm ? "已下載 · 約 23MB" : "未下載";
  } catch (err) {
    console.warn("[Embedding] status check failed:", err);
    if (bgem3El) bgem3El.textContent = "狀態未知";
    if (minilmEl) minilmEl.textContent = "狀態未知";
  }
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
    // 打開模型安裝說明文檔
    await window.system?.openExternal(
      "https://github.com/Playa-0v0/Cyrene-Agent/blob/master/docs/local-models.md"
    );
  });


  // Inline modal helper
  function _showModal(opts: { title: string; message: string; icon?: string; confirmText?: string; cancelText?: string }): Promise<boolean> {
    var ov = document.getElementById("cy-modal-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "cy-modal-overlay";
      ov.className = "cy-modal-overlay is-hidden";
      ov.innerHTML = '<div class="cy-modal" role="alertdialog" aria-modal="true"><div class="cy-modal__head"><span class="cy-modal__icon" id="cy-modal-icon">📌</span><h3 class="cy-modal__title" id="cy-modal-title">提示</h3></div><hr class="cy-modal__divider"><p class="cy-modal__body" id="cy-modal-message">確認執行此操作嗎？</p><div class="cy-modal__actions"><button type="button" class="ghost-btn" id="cy-modal-cancel">取消</button><button type="button" class="btn-primary" id="cy-modal-confirm">確定</button></div></div>';
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
    confirmBtn.textContent = opts.confirmText || "確定";
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
    var confirmed = await _showModal({ title: "刪 除 模 型", message: "確 定 刪 除 " + name + " 模 型 緩 存？下 次 使 用 需 重 新 下 載。", icon: "⚠️", confirmText: "刪 除", cancelText: "取 消" });
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
      updateBtn.textContent = "檢查更新";
      updateBtn.disabled = false;
    }, 2000);
  });
})();
// ── 用戶信息面板 ──
const avatarEl = document.getElementById("user-avatar-el") as HTMLElement | null;
const avatarImg = avatarEl?.querySelector("img") as HTMLImageElement | null;
const avatarPlaceholder = avatarEl?.querySelector("span") as HTMLElement | null;
const uploadAvatarBtn = document.getElementById("upload-avatar-btn") as HTMLButtonElement | null;
const userDefaultCityInput = document.getElementById("user-default-city") as HTMLInputElement | null;
const userNicknameInput = document.getElementById("user-nickname") as HTMLInputElement | null;
const userCallPrefInput = document.getElementById("user-call-pref") as HTMLInputElement | null;
const userBirthdayInput = document.getElementById("user-birthday") as HTMLInputElement | null;
const memoryL0NameInput = document.getElementById("memory-l0-name") as HTMLInputElement | null;
const memoryL0OccupationInput = document.getElementById("memory-l0-occupation") as HTMLInputElement | null;
const memoryL0InterestsInput = document.getElementById("memory-l0-interests") as HTMLInputElement | null;
const memoryL0LanguageInput = document.getElementById("memory-l0-language") as HTMLInputElement | null;
const memoryL0NoteInput = document.getElementById("memory-l0-note") as HTMLTextAreaElement | null;
const memoryL1GoalsInput = document.getElementById("memory-l1-goals") as HTMLTextAreaElement | null;
const memoryL1PreferencesInput = document.getElementById("memory-l1-preferences") as HTMLTextAreaElement | null;
const memoryL1ProjectInput = document.getElementById("memory-l1-project") as HTMLTextAreaElement | null;
const memoryL2SearchInput = document.getElementById("memory-l2-search") as HTMLInputElement | null;
const memoryL2StatusFilter = document.getElementById("memory-l2-status-filter") as HTMLSelectElement | null;
const memoryL2List = document.getElementById("memory-l2-list") as HTMLElement | null;
const memoryTimelineToolbar = document.getElementById("memory-timeline-toolbar") as HTMLElement | null;
const memoryTimelineView = document.getElementById("memory-timeline-view") as HTMLElement | null;
const memoryGraphView = document.getElementById("memory-graph-view") as HTMLElement | null;
const memoryGraphNodes = document.getElementById("memory-graph-nodes") as HTMLElement | null;
const memoryGraphLines = document.getElementById("memory-graph-lines") as SVGSVGElement | null;
const memoryGraphDetail = document.getElementById("memory-graph-detail") as HTMLElement | null;
const memoryGraphEmpty = document.getElementById("memory-graph-empty") as HTMLElement | null;
const memoryViewCount = document.getElementById("memory-view-count") as HTMLElement | null;
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
  if (!timestamp) return "暫無時間";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "暫無時間";
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
  const statusFilter = memoryL2StatusFilter?.value ?? "all";
  const filtered = list.filter(item => {
    if (statusFilter === "pinned" && !item.isPinned) return false;
    if (statusFilter === "conflict" && item.conflictCount === 0) return false;
    if (!["all", "pinned", "conflict"].includes(statusFilter) && item.status !== statusFilter) return false;
    if (!normalized) return true;
    const evidenceText = item.evidence.map(evidence => evidence.quoteSnippet).join(" ");
    return [item.content, item.triggerText, item.status, evidenceText, item.sourceConversationId]
      .join(" ").toLowerCase().includes(normalized);
  });

  if (memoryViewCount) memoryViewCount.textContent = `${filtered.length} 段記憶`;
  if (!memoryL2List) return;
  if (filtered.length === 0) {
    renderEmptyState(
      memoryL2List,
      normalized || statusFilter !== "all" ? "沒有符合條件的記憶" : "暫無事件記憶",
      normalized || statusFilter !== "all" ? "調整搜尋文字或狀態篩選" : "聊天後昔漣會自動提煉重要資訊",
    );
    return;
  }

  const groups = new Map<string, typeof filtered>();
  for (const item of filtered) {
    const date = new Date(item.createdAt);
    const key = Number.isNaN(date.getTime()) ? "時間未知" : date.toLocaleDateString("zh-TW", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const statusLabels: Record<string, string> = {
    active: "活躍", aging: "淡化中", archived: "已封存", superseded: "已更新", merged: "已合併",
  };
  memoryL2List.innerHTML = [...groups.entries()].map(([date, items]) => [
    '<section class="memory-day">',
    `  <div class="memory-day__label"><span></span><strong>${escapeHtml(date)}</strong><small>${items.length} 段</small></div>`,
    '  <div class="memory-day__events">',
    items.map(item => {
      const evidence = item.evidence.find(entry => entry.sourceStatus === "active") ?? item.evidence[0];
      const badges = [
        `<span class="memory-event__status" data-status="${escapeHtml(item.status)}">${escapeHtml(statusLabels[item.status] ?? item.status)}</span>`,
        item.isPinned ? '<span class="memory-event__badge">已固定</span>' : "",
        item.isSummary ? '<span class="memory-event__badge">階段摘要</span>' : "",
        item.conflictCount > 0 ? `<span class="memory-event__badge memory-event__badge--warning">${item.conflictCount} 個衝突</span>` : "",
      ].filter(Boolean).join("");
      const quote = evidence?.quoteSnippet || item.triggerText;
      return [
        `<article class="memory-event" data-memory-id="${escapeHtml(item.id)}">`,
        '  <span class="memory-event__dot"></span>',
        '  <div class="memory-event__card">',
        `    <div class="memory-event__top"><time>${escapeHtml(new Date(item.createdAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" }))}</time><div>${badges}</div></div>`,
        `    <p class="memory-event__content">${escapeHtml(item.content)}</p>`,
        quote ? `    <blockquote class="memory-event__evidence"><span>證據</span>${escapeHtml(quote)}</blockquote>` : "",
        `    <div class="memory-event__meta"><span>權重 ${item.weight.toFixed(1)}</span><span>想起 ${item.accessCount} 次</span><span>最近取用 ${escapeHtml(formatDateTime(item.lastAccessedAt))}</span></div>`,
        '    <div class="memory-event__actions">',
        `      <button type="button" data-memory-action="pin">${item.isPinned ? "取消固定" : "固定記憶"}</button>`,
        item.sourceConversationId ? '      <button type="button" data-memory-action="source">開啟來源對話</button>' : "",
        '      <button type="button" class="is-danger" data-memory-action="delete">忘記這段</button>',
        '    </div>',
        '  </div>',
        '</article>',
      ].join("\n");
    }).join("\n"),
    '  </div>',
    '</section>',
  ].join("\n")).join("\n");
}

function renderMemoryGraph(): void {
  const graph = memoryPanelCache?.graph;
  if (!graph || !memoryGraphNodes || !memoryGraphLines || !memoryGraphEmpty) return;
  memoryGraphNodes.replaceChildren();
  memoryGraphLines.replaceChildren();
  const entityNodes = graph.nodes.filter(node => node.type !== "user");
  memoryGraphEmpty.classList.toggle("is-hidden", entityNodes.length > 0);
  if (entityNodes.length === 0) return;

  const positions = new Map<string, { x: number; y: number }>();
  const root = graph.nodes.find(node => node.type === "user") ?? graph.nodes[0];
  positions.set(root.id, { x: 50, y: 50 });
  entityNodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / entityNodes.length;
    const radiusX = index % 2 === 0 ? 39 : 31;
    const radiusY = index % 2 === 0 ? 39 : 31;
    positions.set(node.id, { x: 50 + Math.cos(angle) * radiusX, y: 50 + Math.sin(angle) * radiusY });
  });

  memoryGraphLines.setAttribute("viewBox", "0 0 1000 600");
  for (const edge of graph.edges) {
    const source = positions.get(edge.sourceId);
    const target = positions.get(edge.targetId);
    if (!source || !target) continue;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(source.x * 10));
    line.setAttribute("y1", String(source.y * 6));
    line.setAttribute("x2", String(target.x * 10));
    line.setAttribute("y2", String(target.y * 6));
    line.setAttribute("class", edge.inferred ? "is-inferred" : "is-explicit");
    line.setAttribute("stroke-width", String(Math.min(5, 1 + Math.log2(Math.max(1, edge.strength)))));
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${edge.relation} · 強度 ${edge.strength}`;
    line.appendChild(title);
    memoryGraphLines.appendChild(line);
  }

  for (const node of graph.nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memory-graph-node";
    button.dataset.nodeId = node.id;
    button.dataset.type = node.type;
    button.style.setProperty("--node-x", `${position.x}%`);
    button.style.setProperty("--node-y", `${position.y}%`);
    button.style.setProperty("--node-scale", String(Math.min(1.22, .88 + Math.log2(Math.max(1, node.mentionCount)) * .08)));
    const name = document.createElement("strong");
    name.textContent = node.name;
    const count = document.createElement("small");
    count.textContent = node.type === "user" ? "記憶中心" : `${node.mentionCount} 次`;
    button.append(name, count);
    button.addEventListener("click", () => showMemoryGraphNode(node.id));
    memoryGraphNodes.appendChild(button);
  }
}

function showMemoryGraphNode(nodeId: string): void {
  const graph = memoryPanelCache?.graph;
  if (!graph || !memoryGraphDetail) return;
  const node = graph.nodes.find(item => item.id === nodeId);
  if (!node) return;
  memoryGraphNodes?.querySelectorAll(".memory-graph-node").forEach(element => {
    element.classList.toggle("is-active", (element as HTMLElement).dataset.nodeId === nodeId);
  });
  const edges = graph.edges.filter(edge => edge.sourceId === nodeId || edge.targetId === nodeId);
  const related = edges.map(edge => {
    const otherId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
    return { edge, other: graph.nodes.find(item => item.id === otherId) };
  }).filter(item => item.other);
  const typeNames: Record<string, string> = { user: "記憶中心", person: "人物", place: "地點", preference: "偏好", organization: "組織", concept: "概念" };
  memoryGraphDetail.replaceChildren();
  const eyebrow = document.createElement("span");
  eyebrow.className = "memory-graph-detail__eyebrow";
  eyebrow.textContent = typeNames[node.type] ?? node.type;
  const title = document.createElement("h3");
  title.textContent = node.name;
  const meta = document.createElement("p");
  meta.textContent = node.type === "user"
    ? `目前連著 ${related.length} 個記憶實體。`
    : `提及 ${node.mentionCount} 次 · 最近出現 ${formatDateTime(node.lastMentionedAt)}`;
  const list = document.createElement("div");
  list.className = "memory-graph-relations";
  for (const item of related.slice(0, 12)) {
    const row = document.createElement("button");
    row.type = "button";
    const relation = document.createElement("span");
    relation.textContent = item.edge.relation;
    const other = document.createElement("strong");
    other.textContent = item.other?.name ?? "未知";
    row.append(relation, other);
    row.addEventListener("click", () => showMemoryGraphNode(item.other!.id));
    list.appendChild(row);
  }
  memoryGraphDetail.append(eyebrow, title, meta, list);
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
    renderMemoryGraph();
    renderImportedDocs();

    renderInfoList(
      memoryReflectionList,
      payload.reflections,
      "暫無階段總結",
      "持續聊天後，昔漣會在整理記憶時留下階段回顧",
    );

    if (memoryL0EditBtn) memoryL0EditBtn.disabled = false;
    if (memoryL1EditBtn) memoryL1EditBtn.disabled = false;
  } catch (err) {
    console.error("[settings] load memory panel failed", err);
    renderEmptyState(memoryL2List, "記憶讀取失敗", "請查看終端日誌");
    renderEmptyState(memoryImportedList, "導入知識讀取失敗", "請查看終端日誌");
    renderEmptyState(memoryReflectionList, "階段總結讀取失敗", "請查看終端日誌");
  }
}

memoryL2SearchInput?.addEventListener("input", () => renderL2List(memoryL2SearchInput.value));
memoryL2StatusFilter?.addEventListener("change", () => renderL2List(memoryL2SearchInput?.value ?? ""));

document.querySelectorAll<HTMLButtonElement>("[data-memory-view]").forEach(button => {
  button.addEventListener("click", () => {
    const view = button.dataset.memoryView === "graph" ? "graph" : "timeline";
    document.querySelectorAll<HTMLButtonElement>("[data-memory-view]").forEach(tab => {
      const active = tab === button;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    memoryTimelineView?.classList.toggle("is-hidden", view !== "timeline");
    memoryTimelineToolbar?.classList.toggle("is-hidden", view !== "timeline");
    memoryGraphView?.classList.toggle("is-hidden", view !== "graph");
    if (memoryViewCount) {
      memoryViewCount.textContent = view === "graph"
        ? `${Math.max(0, (memoryPanelCache?.graph.nodes.length ?? 1) - 1)} 個實體`
        : `${memoryPanelCache?.l2.length ?? 0} 段記憶`;
    }
    if (view === "graph") renderMemoryGraph();
  });
});

memoryL2List?.addEventListener("click", async event => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-memory-action]");
  const article = button?.closest<HTMLElement>("[data-memory-id]");
  const id = article?.dataset.memoryId;
  const item = memoryPanelCache?.l2.find(memory => memory.id === id);
  if (!button || !item) return;
  const action = button.dataset.memoryAction;
  button.disabled = true;
  try {
    if (action === "pin") {
      const result = await window.memoryPanel?.pinL2(item.id, !item.isPinned);
      if (!result?.ok) throw new Error(result?.error || "無法更新固定狀態");
      await loadMemoryPanel();
    } else if (action === "source" && item.sourceConversationId) {
      const chatStore = (window as unknown as { chatStore?: { openInChatWindow: (id: string) => Promise<unknown> } }).chatStore;
      await chatStore?.openInChatWindow(item.sourceConversationId);
    } else if (action === "delete") {
      const confirmed = await showModal({
        title: "忘記這段記憶",
        message: `確定要讓昔漣忘記這段嗎？\n\n${item.content}\n\n這個動作無法復原。`,
        icon: "🫧",
        confirmText: "忘記",
        cancelText: "保留",
      });
      if (!confirmed) return;
      const result = await window.memoryPanel?.deleteL2(item.id);
      if (!result?.ok) throw new Error(result?.error || "無法刪除記憶");
      await loadMemoryPanel();
    }
  } catch (err) {
    console.error("[settings] memory action failed", err);
    await showModal({
      title: "記憶操作未完成",
      message: err instanceof Error ? err.message : String(err),
      icon: "⚠️",
      confirmText: "知道了",
      cancelText: "關閉",
    });
  } finally {
    button.disabled = false;
  }
});

async function loadUserProfile(): Promise<void> {
  try {
    const avatarDataUrl = await window.user?.getAvatar();
    if (avatarDataUrl) showAvatar(avatarDataUrl);
    if (uploadAvatarBtn) uploadAvatarBtn.disabled = false;
    // 加載用戶字段（暱稱/稱呼偏好/生日/默認城市）
    const profile = await window.user?.getProfile();
    if (profile) {
      if (userNicknameInput) userNicknameInput.value = String(profile.nickname ?? "");
      if (userCallPrefInput) userCallPrefInput.value = String(profile.callPreference ?? "");
      if (userBirthdayInput) userBirthdayInput.value = String(profile.birthday ?? "");
      if (userDefaultCityInput) userDefaultCityInput.value = String(profile.defaultCity ?? "");
    }
  } catch {
    console.warn("[settings] load user profile failed");
  }
}

// 用戶字段：失焦/回車保存（每個字段獨立原子保存）
function bindUserProfileSave(input: HTMLInputElement | null, field: string): void {
  if (!input) return;
  const save = (): void => { void window.user?.saveProfile({ [field]: input.value.trim() }); };
  input.addEventListener("change", save);
  input.addEventListener("blur", save);
}
bindUserProfileSave(userNicknameInput, "nickname");
bindUserProfileSave(userCallPrefInput, "callPreference");
bindUserProfileSave(userBirthdayInput, "birthday");
// 默認城市複用上面的 saveCity（保持原邏輯）
if (userDefaultCityInput) {
  const saveCity = (): void => {
    const value = userDefaultCityInput.value.trim();
    void window.user?.saveProfile({ defaultCity: value });
  };
  userDefaultCityInput.addEventListener("change", saveCity);
  userDefaultCityInput.addEventListener("blur", saveCity);
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
  if (memoryL0EditBtn) memoryL0EditBtn.textContent = "✏️ 編輯";
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
      setTimeout(() => { if (memoryL0EditBtn && !l0Editing) memoryL0EditBtn.textContent = "✏️ 編輯"; }, 2000);
    }
  } catch (err) {
    console.error("[settings] save L0 failed", err);
    alert("保存失敗，請重試");
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
  if (memoryL1EditBtn) memoryL1EditBtn.textContent = "✏️ 編輯";
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
      setTimeout(() => { if (memoryL1EditBtn && !l1Editing) memoryL1EditBtn.textContent = "✏️ 編輯"; }, 2000);
    }
  } catch (err) {
    console.error("[settings] save L1 failed", err);
    alert("保存失敗，請重試");
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
    renderEmptyState(memoryImportedList, "暫無導入文檔", "在聊天窗口上傳文件後會自動索引");
    return;
  }

  memoryImportedList.innerHTML = list
    .map((item) => {
      const importId = item.importId || "";
      const fileName = escapeHtml(item.fileName);
      const chunkInfo = "已索引 " + item.chunkCount + " 個片段";
      const timeInfo = "最近導入：" + formatDateTime(item.lastImportedAt);
      return [
        '<article class="memory-record memory-record--doc">',
        '  <div class="memory-record__main">',
        '    <h3 class="memory-record__title">' + fileName + '</h3>',
        '    <p class="memory-record__body">' + escapeHtml(chunkInfo) + '</p>',
        '    <p class="memory-record__meta">' + escapeHtml(timeInfo) + '</p>',
        '  </div>',
        '  <button type="button" class="memory-record__delete" data-import-id="' + escapeHtml(importId) + '" data-file-name="' + fileName + '" title="刪除此導入文檔">🗑️</button>',
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
  const fileName = deleteBtn.dataset.fileName || "未命名文檔";

  const confirmed = await showModal({
    title: "刪除導入知識",
    message: "確定刪除導入知識？\n\n文件：\n《" + fileName + "》\n\n刪除後不可恢復，如需使用請重新導入。",
    icon: "⚠️",
    confirmText: "刪除",
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

// ── 權限檔位 UI ───────────────────────────────────────────
type PermissionLevel = "read-only" | "scoped" | "per-action" | "full";

const permissionBlocksWrap = document.getElementById("plugin-file-permission") as HTMLElement | null;
const permissionNote = document.getElementById("plugin-file-note") as HTMLElement | null;

const PERMISSION_NOTES: Record<PermissionLevel, string> = {
  "read-only": "只讀：昔漣不會修改本地任何文件，也不能為你安裝新工具。",
  "scoped": "指定目錄：昔漣只能在你授權的目錄裡讀寫文件（白名單後續在此面板配置）。",
  "per-action": "每次審批：每次涉及文件或安裝的操作，昔漣都會在聊天裡彈卡片讓你確認。",
  "full": "完全訪問：昔漣可以自由調用本地命令（含 git/npm/pip）。請只在你完全信任的情況下使用。",
};

function paintPermissionUI(level: PermissionLevel): void {
  if (!permissionBlocksWrap) return;
  // scoped 檔已從插件面板移除，回退顯示只讀
  const display = level === "scoped" ? "read-only" : level;
  const blocks = permissionBlocksWrap.querySelectorAll<HTMLButtonElement>("button[data-level]");
  blocks.forEach((b) => {
    const isActive = b.dataset.level === display;
    b.classList.toggle("is-active", isActive);
    b.setAttribute("aria-pressed", String(isActive));
  });
  if (permissionNote) {
    permissionNote.textContent = PERMISSION_NOTES[level];
  }
}

async function confirmFullAccess(): Promise<boolean> {
  // 完全訪問需要延遲確認 + 風險提示
  _initModalOverlay();
  if (!_cyModalOverlay) return false;
  const iconEl = _cyModalOverlay.querySelector("#cy-modal-icon") as HTMLElement;
  const titleEl = _cyModalOverlay.querySelector("#cy-modal-title") as HTMLElement;
  const msgEl = _cyModalOverlay.querySelector("#cy-modal-message") as HTMLElement;
  const cancelBtn = _cyModalOverlay.querySelector("#cy-modal-cancel") as HTMLButtonElement;
  const confirmBtn = _cyModalOverlay.querySelector("#cy-modal-confirm") as HTMLButtonElement;
  iconEl.textContent = "⚠️";
  titleEl.textContent = "切換到完全訪問？";
  msgEl.textContent = "這意味著昔漣可以在你的電腦上自由執行命令，包括 git clone、npm install、刪除文件等。請只在你完全信任她的判斷時啟用。";
  cancelBtn.textContent = "再想想";
  _cyModalOverlay.classList.remove("is-hidden");

  // 倒計時 5 秒強制等待
  let remain = 5;
  confirmBtn.disabled = true;
  confirmBtn.textContent = "我瞭解風險（" + remain + "）";
  const tick = setInterval(() => {
    remain -= 1;
    if (remain <= 0) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "我瞭解風險，啟用";
      clearInterval(tick);
    } else {
      confirmBtn.textContent = "我瞭解風險（" + remain + "）";
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
      console.log("[settings] 檔位未變，不動作");
      return;
    }

    if (target === "full") {
      const ok = await confirmFullAccess();
      if (!ok) {
        console.log("[settings] 用戶取消了完全訪問");
        return;
      }
    }

    console.log("[settings] 切換權限檔位 →", target);
    try {
      const result = await window.settings?.setPermissionLevel?.(target);
      if (result?.ok) {
        paintPermissionUI((result.level || target) as PermissionLevel);
      } else {
        console.warn("[settings] 切換檔位失敗:", result?.error);
      }
    } catch (err) {
      console.error("[settings] 切換檔位異常:", err);
    }
  });

  // 初始化：從後端拿當前檔位
  void (async () => {
    try {
      const result = await window.settings?.getPermissionLevel?.();
      const level = (result?.level || "read-only") as PermissionLevel;
      console.log("[settings] 當前權限檔位:", level);
      paintPermissionUI(level);
    } catch (err) {
      console.warn("[settings] 加載權限檔位失敗:", err);
      paintPermissionUI("read-only");
    }
  })();
}

// ── 生活工具手風琴 ─────────────────────────────────────────
const lifeToggle = document.getElementById("plugin-life-toggle") as HTMLButtonElement | null;
const lifeCard = document.getElementById("plugin-life-card");
const lifeBody = document.getElementById("plugin-life-body");
lifeToggle?.addEventListener("click", () => {
  const expanded = lifeToggle.getAttribute("aria-expanded") === "true";
  lifeToggle.setAttribute("aria-expanded", String(!expanded));
  lifeCard?.classList.toggle("is-expanded", !expanded);
  lifeBody?.classList.toggle("is-collapsed", expanded);
});

// ── Skill 面板：列 skill 開關 ──────────────────────────────
async function renderSkills(): Promise<void> {
  const listEl = document.getElementById("skills-list");
  const emptyEl = document.getElementById("skills-empty");
  if (!listEl || !window.settings?.listSkills) return;

  let skills: Array<{ id: string; name: string; description: string; tools: string[]; enabled: boolean; source: string; version?: string; references: string[] }> = [];
  try {
    skills = await window.settings.listSkills();
  } catch (err) {
    console.warn("[settings] 加載 skill 列表失敗:", err);
  }

  listEl.innerHTML = "";
  if (skills.length === 0) {
    if (emptyEl) emptyEl.classList.remove("is-hidden");
    return;
  }
  if (emptyEl) emptyEl.classList.add("is-hidden");

  // MiniMax 辦公合集 id 列表
  const officeGroupIds = new Set(["docx", "pdf", "pptx-generator", "xlsx"]);
  const officeSkills = skills.filter((s) => officeGroupIds.has(s.id));
  const otherSkills = skills.filter((s) => !officeGroupIds.has(s.id));

  // 渲染單條 skill
  function renderSkillRow(s: typeof skills[number]): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "skill-row";
    const label = document.createElement("div");
    label.className = "skill-row__info";
    const title = document.createElement("div");
    title.className = "skill-row__title";
    title.textContent = s.name + (s.source === "user" ? " （用戶）" : "");
    const desc = document.createElement("div");
    desc.className = "skill-row__desc";
    const short = s.description.length > 120 ? s.description.slice(0, 120) + "…" : s.description;
    const toolsStr = s.tools.length > 0 ? ` [tools: ${s.tools.join(", ")}]` : "";
    desc.textContent = short + toolsStr;
    label.appendChild(title);
    label.appendChild(desc);

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "skill-toggle";
    toggle.checked = s.enabled;
    toggle.addEventListener("change", async () => {
      try {
        await window.settings?.setSkillEnabled?.(s.id, toggle.checked);
      } catch (err) {
        console.warn("[settings] 切換 skill 失敗:", err);
        toggle.checked = !toggle.checked;
      }
    });

    row.appendChild(label);
    row.appendChild(toggle);
    return row;
  }

  // 渲染其他（非合集）skill
  for (const s of otherSkills) {
    listEl.appendChild(renderSkillRow(s));
  }

  // MiniMax 辦公合集摺疊組
  if (officeSkills.length > 0) {
    const group = document.createElement("div");
    group.className = "skill-group";

    const header = document.createElement("div");
    header.className = "skill-group__header";
    const arrow = document.createElement("span");
    arrow.className = "skill-group__arrow";
    arrow.textContent = "▶";
    const gTitle = document.createElement("span");
    gTitle.className = "skill-group__title";
    gTitle.textContent = "MiniMAX-office-skills";
    const gDesc = document.createElement("span");
    gDesc.className = "skill-group__desc";
    gDesc.textContent = "MiniMax開源的辦公文檔Skills合集";
    header.appendChild(arrow);
    header.appendChild(gTitle);
    header.appendChild(gDesc);
    header.addEventListener("click", () => {
      body.classList.toggle("is-open");
      arrow.textContent = body.classList.contains("is-open") ? "▼" : "▶";
    });

    const body = document.createElement("div");
    body.className = "skill-group__body";
    for (const s of officeSkills) {
      body.appendChild(renderSkillRow(s));
    }

    group.appendChild(header);
    group.appendChild(body);
    listEl.appendChild(group);
  }
}








/* ============================================================
   💬 聊天面板：會話列表
   - 渲染 chatStore.list 返回的會話元數據，按 updatedAt desc 排序（store 已排）
   - 微信式時間：剛剛 / N 分鐘前 / 今天 HH:mm / 昨天 HH:mm / N 天前 / MM-DD
   - 點擊列表項 = 在聊天窗口裡打開（窗口未開則開窗）
   - 雙擊標題 = 改名（contentEditable + Enter/Esc/blur 提交）
   - 點🗑️ = 刪除（活躍會話給出"正在閱讀這個會話"差異化提示）
   - 跨窗口同步：onChanged 觸發重渲；onActiveSessionChanged 更新高亮態
   - HTML/CSS 已在 index.html / settings.css 裡就位（見 chat-sessions__*）
   ============================================================ */

declare global {
  interface Window {
    chatStore?: {
      list: () => Promise<ChatSessionMetaUI[]>;
      get: (id: string) => Promise<unknown>;
      create: (payload?: { title?: string; identityId?: string | null }) => Promise<{ id: string } | null>;
      delete: (id: string) => Promise<boolean>;
      rename: (id: string, title: string) => Promise<unknown>;
      openFolder: () => Promise<boolean>;
      openInChatWindow: (sessionId: string) => Promise<boolean>;
      getActiveSession: () => Promise<string | null>;
      onChanged: (cb: () => void) => () => void;
      onActiveSessionChanged: (cb: (sessionId: string | null) => void) => () => void;
    };
  }
}

let chatSessionsActiveId: string | null = null;

async function renderChatSessions(): Promise<void> {
  const listEl = document.getElementById("chat-sessions-list");
  const emptyEl = document.getElementById("chat-sessions-empty");
  if (!listEl || !window.chatStore) return;

  // 第一次渲染前如果還不知道活躍 sessionId，主動拉一次
  if (chatSessionsActiveId === null) {
    try { chatSessionsActiveId = (await window.chatStore.getActiveSession()) ?? null; } catch { /* ignore */ }
  }

  let sessions: ChatSessionMetaUI[] = [];
  try {
    sessions = await window.chatStore.list();
  } catch (err) {
    console.warn("[settings] 加載聊天會話列表失敗:", err);
  }

  listEl.innerHTML = "";
  if (sessions.length === 0) {
    if (emptyEl) emptyEl.classList.remove("is-hidden");
    return;
  }
  if (emptyEl) emptyEl.classList.add("is-hidden");

  for (const session of sessions) {
    const item = buildChatSessionItem(session);
    listEl.appendChild(item);
  }
}

function buildChatSessionItem(session: ChatSessionMetaUI): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "chat-sessions__item";
  if (session.id === chatSessionsActiveId) li.classList.add("is-active");
  li.dataset.sessionId = session.id;

  const titleEl = document.createElement("div");
  titleEl.className = "chat-sessions__title";
  titleEl.textContent = session.title || "新對話";

  const metaEl = document.createElement("div");
  metaEl.className = "chat-sessions__meta";

  const timeEl = document.createElement("span");
  timeEl.className = "chat-sessions__time";
  timeEl.textContent = formatChatRelativeTime(session.updatedAt);

  const identityEl = document.createElement("span");
  identityEl.className = "chat-sessions__identity";
  // 職位面板未做，所有 identityId == null 的會話先 fallback 到"聊天陪伴"
  // 後續職位面板做好後這裡改成用 identity 註冊表查實際名稱
  identityEl.textContent = "💼 " + (session.identityId ? session.identityId : CHAT_DEFAULT_IDENTITY_LABEL);

  metaEl.appendChild(timeEl);
  metaEl.appendChild(identityEl);

  // 左側主區：標題 + meta
  const mainEl = document.createElement("div");
  mainEl.className = "chat-sessions__main";
  mainEl.appendChild(titleEl);
  mainEl.appendChild(metaEl);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "chat-sessions__delete";
  deleteBtn.title = "刪除會話";
  deleteBtn.setAttribute("aria-label", "刪除會話");
  deleteBtn.textContent = "🗑️";

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "chat-sessions__rename";
  renameBtn.title = "重命名";
  renameBtn.setAttribute("aria-label", "重命名會話");
  renameBtn.textContent = "✏️";

  // 編輯態確認/取消按鈕（默認隱藏，進入編輯態時顯示，替換 ✏️/🗑️ 的位置）
  const confirmRenameBtn = document.createElement("button");
  confirmRenameBtn.type = "button";
  confirmRenameBtn.className = "chat-sessions__confirm-rename is-hidden";
  confirmRenameBtn.title = "確認（Enter）";
  confirmRenameBtn.setAttribute("aria-label", "確認重命名");
  confirmRenameBtn.textContent = "✓";

  const cancelRenameBtn = document.createElement("button");
  cancelRenameBtn.type = "button";
  cancelRenameBtn.className = "chat-sessions__cancel-rename is-hidden";
  cancelRenameBtn.title = "取消（Esc）";
  cancelRenameBtn.setAttribute("aria-label", "取消重命名");
  cancelRenameBtn.textContent = "✕";

  // 右側操作區：✏️ 🗑️（常規）/ ✓ ✕（編輯態）
  const actionsEl = document.createElement("div");
  actionsEl.className = "chat-sessions__actions";
  actionsEl.appendChild(renameBtn);
  actionsEl.appendChild(confirmRenameBtn);
  actionsEl.appendChild(cancelRenameBtn);
  actionsEl.appendChild(deleteBtn);

  // —— 交互綁定 ——
  // 點列表項 = 在聊天窗口裡打開（編輯態時禁用，避免切走會話）
  li.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".chat-sessions__actions")) return;
    if (titleEl.isContentEditable) return;
    void window.chatStore?.openInChatWindow(session.id);
  });

  // ✏️ 按鈕進入改名態
  renameBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    enterRenameMode(titleEl, session, { renameBtn, deleteBtn, confirmRenameBtn, cancelRenameBtn });
  });

  // 🗑️ 刪除（含活躍會話差異化提示）
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void deleteChatSession(session);
  });

  li.appendChild(mainEl);
  li.appendChild(actionsEl);
  return li;
}

// 進入改名態：把 ✏️/🗑️ 隱藏，顯示 ✓/✕；title 變 contentEditable 並聚焦全選。
// 提交走 ✓ 按鈕 / Enter；取消走 ✕ 按鈕 / Esc / 失焦。失焦=取消（避免點別處誤提交）。
function enterRenameMode(
  titleEl: HTMLElement,
  session: ChatSessionMetaUI,
  btns: {
    renameBtn: HTMLButtonElement;
    deleteBtn: HTMLButtonElement;
    confirmRenameBtn: HTMLButtonElement;
    cancelRenameBtn: HTMLButtonElement;
  },
): void {
  const original = titleEl.textContent || "";

  // 切換按鈕可見性
  btns.renameBtn.classList.add("is-hidden");
  btns.deleteBtn.classList.add("is-hidden");
  btns.confirmRenameBtn.classList.remove("is-hidden");
  btns.cancelRenameBtn.classList.remove("is-hidden");

  titleEl.contentEditable = "true";
  titleEl.classList.add("is-editing");
  // 用 requestAnimationFrame 等按鈕 click 冒泡完再聚焦，避免焦點搶奪導致 blur 誤觸發
  requestAnimationFrame(() => {
    titleEl.focus();
    // 全選當前文本，方便用戶直接覆蓋
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  });

  const cleanup = () => {
    titleEl.contentEditable = "false";
    titleEl.classList.remove("is-editing");
    btns.renameBtn.classList.remove("is-hidden");
    btns.deleteBtn.classList.remove("is-hidden");
    btns.confirmRenameBtn.classList.add("is-hidden");
    btns.cancelRenameBtn.classList.add("is-hidden");
    titleEl.removeEventListener("keydown", onKey);
    titleEl.removeEventListener("blur", onBlur);
    btns.confirmRenameBtn.removeEventListener("mousedown", suppressFocus);
    btns.cancelRenameBtn.removeEventListener("mousedown", suppressFocus);
    btns.confirmRenameBtn.removeEventListener("click", onConfirm);
    btns.cancelRenameBtn.removeEventListener("click", onCancel);
  };

  const commit = () => {
    const newTitle = (titleEl.textContent || "").trim();
    cleanup();
    if (newTitle && newTitle !== original) {
      void window.chatStore?.rename(session.id, newTitle);
      // rename 成功後 main 廣播 chats:changed → 列表重渲，無需手動改 DOM
    } else {
      titleEl.textContent = original; // 空內容或未變：還原
    }
  };

  const cancel = () => {
    cleanup();
    titleEl.textContent = original;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };
  // 失焦=取消（點別處想放棄編輯的心智模型）
  const onBlur = () => cancel();
  const onConfirm = (e: MouseEvent) => { e.stopPropagation(); commit(); };
  const onCancel = (e: MouseEvent) => { e.stopPropagation(); cancel(); };
  // 關鍵：mousedown 時 preventDefault，阻止 ✓/✕ 按鈕搶焦點，
  // 否則順序是 mousedown→titleEl blur(cancel 還原內容)→click(commit 讀到原值)→改不了名。
  // 阻止焦點轉移後，titleEl 保持聚焦，blur 不觸發，click 正常執行 commit/cancel。
  const suppressFocus = (e: MouseEvent) => e.preventDefault();

  titleEl.addEventListener("keydown", onKey);
  titleEl.addEventListener("blur", onBlur);
  btns.confirmRenameBtn.addEventListener("mousedown", suppressFocus);
  btns.cancelRenameBtn.addEventListener("mousedown", suppressFocus);
  btns.confirmRenameBtn.addEventListener("click", onConfirm);
  btns.cancelRenameBtn.addEventListener("click", onCancel);
}

async function deleteChatSession(session: ChatSessionMetaUI): Promise<void> {
  const isActive = session.id === chatSessionsActiveId;
  const prompt = isActive
    ? `「${session.title || "新對話"}」正在聊天窗口裡打開，確定刪除？\n刪除後聊天窗口會跳到最新一條會話或自動新建。`
    : `確定刪除「${session.title || "新對話"}」？\n刪除後無法恢復。`;
  if (!window.confirm(prompt)) return;
  try {
    await window.chatStore?.delete(session.id);
    // 刪除成功後 main 廣播 chats:changed → 列表重渲；
    // 聊天窗口若在顯示該會話也會通過 onChanged 自動 fallback。
  } catch (err) {
    console.warn("[settings] 刪除會話失敗:", err);
    window.alert("刪除失敗，請查看終端日誌。");
  }
}

// —— 頂部"+新對話"按鈕 ——
const chatNewBtn = document.getElementById("chat-new-btn") as HTMLButtonElement | null;
chatNewBtn?.addEventListener("click", async () => {
  if (!window.chatStore) return;
  try {
    const session = await window.chatStore.create({ identityId: null });
    if (session?.id) await window.chatStore.openInChatWindow(session.id);
  } catch (err) {
    console.warn("[settings] 新建會話失敗:", err);
    window.alert("新建會話失敗，請查看終端日誌。");
  }
});

// —— 底部"打開存儲位置"按鈕 ——
const chatOpenFolderBtn = document.getElementById("chat-open-folder-btn") as HTMLButtonElement | null;
chatOpenFolderBtn?.addEventListener("click", () => {
  void window.chatStore?.openFolder();
});

// —— 跨窗口同步 ——
// 任意會話變動（創建/追加/改名/刪除）：重渲列表
// 僅在面板可見時刷新，節省 DOM 寫入；不可見時下次切到面板會重新拉
window.chatStore?.onChanged(() => {
  const panel = document.getElementById("chat-panel");
  if (panel && !panel.classList.contains("is-hidden")) {
    void renderChatSessions();
  }
});

// 活躍 sessionId 變化：僅更新 is-active 高亮，不重新拉列表（輕量）
window.chatStore?.onActiveSessionChanged((sessionId) => {
  chatSessionsActiveId = sessionId;
  const listEl = document.getElementById("chat-sessions-list");
  if (!listEl) return;
  listEl.querySelectorAll<HTMLElement>(".chat-sessions__item").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.sessionId === sessionId);
  });
});

/* ============================================================
   📊 Token 用量面板：指標卡片 + 柱狀圖 + Chart.js 波浪圖
   - 時間範圍 7d/14d/30d 切換，切換後調 IPC 拉真實數據並重渲
   - hover 柱子/波浪節點 → tooltip 顯示當天 輸入/輸出/命中/未命中
   - 全空時顯示空態（暫無用量數據）
   ============================================================ */

import { Chart, registerables, type ChartConfiguration } from "chart.js";

Chart.register(...registerables);

interface TokenDayData {
  date: string;       // ISO 日期 "06-15"
  weekday: string;    // "週日"
  input: number;
  output: number;
  hit: number;        // 緩存命中（佔位 0）
  miss: number;       // 緩存未命中（佔位 0）
  requests: number;
}

interface AgentActivityPayload {
  events: Array<{ id: string; at: string; kind: "tool" | "permission" | "system"; name: string; status: "success" | "failed" | "denied" | "running"; durationMs: number; argsSummary?: string; resultSummary?: string; error?: string }>;
  summary: { total: number; success: number; failed: number; denied: number; avgDurationMs: number };
  models: Array<{ model: string; input: number; output: number; requests: number }>;
  resources: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; queue: { pending: number; running: number; limit: number }; activityLimit: number; callContextTurnLimit: number };
}

declare global {
  interface Window {
    tokenUsage?: {
      get: (days: number) => Promise<TokenDayData[]>;
    };
    agentActivity?: {
      get: (days: number) => Promise<AgentActivityPayload>;
      exportDiagnostic: () => Promise<{ filePath: string } | null>;
      testLocalAsr: (payload: { pcmBase64: string; language: string }) => Promise<{ text: string; latencyMs: number }>;
    };
  }
}

// 根據天數生成假數據（帶隨機波動，模擬真實趨勢）
// 柱狀圖：根據數據動態生成柱子（複用 chart.css 的 .chart-bar 樣式）
function renderTokenBarChart(data: TokenDayData[]): void {
  const container = document.getElementById("token-bar-chart");
  if (!container) return;
  container.innerHTML = "";

  const maxVal = Math.max(...data.map((d) => d.input + d.output), 1);
  const peakIdx = data.reduce((peak, d, i, arr) =>
    (d.input + d.output) > (arr[peak].input + arr[peak].output) ? i : peak, 0);

  // 柱狀圖最多顯示 14 根（30d 時隔天顯示），避免太擠
  const displayData = data.length > 14
    ? data.filter((_, i) => i % 2 === 0)
    : data;

  // 容器實際可用高度（mini-chart 高度 112px - padding-top 18px - 底部 label 區 18px ≈ 76px）
  // 用固定像素高度，避免 flex 百分比高度在 padding 容器裡不可靠
  const chartHeight = 76;

  for (let i = 0; i < displayData.length; i++) {
    const d = displayData[i];
    const total = d.input + d.output;
    const barH = Math.max(6, Math.round((total / maxVal) * chartHeight));
    const bar = document.createElement("div");
    bar.className = "token-bar";
    // 峰值柱加標記
    const origIdx = data.indexOf(d);
    if (origIdx === peakIdx) bar.classList.add("token-bar--peak");

    // 真實 fill div（不用偽元素，直接控制像素高度）
    const fill = document.createElement("div");
    fill.className = "token-bar__fill";
    fill.style.height = barH + "px";

    const label = document.createElement("span");
    label.className = "token-bar__label";
    label.textContent = d.date.split("-")[1]; // 只顯示日
    bar.appendChild(fill);
    bar.appendChild(label);

    // hover tooltip
    bar.addEventListener("mouseenter", (e) => showTokenTooltip(e, d));
    bar.addEventListener("mousemove", (e) => moveTokenTooltip(e));
    bar.addEventListener("mouseleave", hideTokenTooltip);

    container.appendChild(bar);
  }

  // 日均標籤
  const avgEl = document.getElementById("token-avg-label");
  if (avgEl) {
    const avg = Math.round(data.reduce((s, d) => s + d.input + d.output, 0) / data.length);
    avgEl.textContent = `日均 ${formatTokenShort(avg)}`;
  }
}

function formatTokenShort(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

// tooltip 顯示/移動/隱藏
function showTokenTooltip(e: MouseEvent, d: TokenDayData): void {
  const tip = document.getElementById("token-tooltip");
  if (!tip) return;
  tip.innerHTML = `
    <div class="token-tooltip__date">${d.date} ${d.weekday}</div>
    <div class="token-tooltip__row"><span>📥 輸入</span><span>${d.input.toLocaleString()}</span></div>
    <div class="token-tooltip__row"><span>📤 輸出</span><span>${d.output.toLocaleString()}</span></div>
    <div class="token-tooltip__row"><span>🎯 命中</span><span>${d.hit > 0 ? d.hit.toLocaleString() : "N/A"}</span></div>
    <div class="token-tooltip__row"><span>❌ 未命中</span><span>${d.miss > 0 ? d.miss.toLocaleString() : "N/A"}</span></div>
  `;
  tip.hidden = false;
  moveTokenTooltip(e);
}

function moveTokenTooltip(e: MouseEvent): void {
  const tip = document.getElementById("token-tooltip");
  if (!tip || tip.hidden) return;
  const offset = 14;
  let x = e.clientX + offset;
  let y = e.clientY + offset;
  // 防止超出視口右邊
  const tipW = tip.offsetWidth;
  if (x + tipW > window.innerWidth) x = e.clientX - tipW - offset;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}

function hideTokenTooltip(): void {
  const tip = document.getElementById("token-tooltip");
  if (tip) tip.hidden = true;
}

// Chart.js 波浪面積圖
let tokenTrendChart: Chart | null = null;
let tokenRangeDays = 7;

function renderTokenTrendChart(data: TokenDayData[]): void {
  const canvas = document.getElementById("token-trend-chart") as HTMLCanvasElement | null;
  if (!canvas) return;

  // 銷燬舊實例避免重疊
  if (tokenTrendChart) { tokenTrendChart.destroy(); tokenTrendChart = null; }

  const labels = data.map((d) => d.date);
  const inputData = data.map((d) => d.input);
  const outputData = data.map((d) => d.output);

  const config: ChartConfiguration = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "📥 輸入",
          data: inputData,
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59, 130, 246, 0.15)",
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: "#3b82f6",
        },
        {
          label: "📤 輸出",
          data: outputData,
          borderColor: "#ff8ccc",
          backgroundColor: "rgba(255, 140, 204, 0.15)",
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: "#ff8ccc",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: { color: "rgba(235, 229, 245, 0.7)", font: { size: 11 }, boxWidth: 12, boxHeight: 12 },
        },
        tooltip: {
          // 用 Chart.js 自帶 tooltip，顯示輸入/輸出/命中/未命中
          backgroundColor: "rgba(30, 20, 45, 0.95)",
          borderColor: "rgba(255, 182, 220, 0.3)",
          borderWidth: 1,
          titleColor: "rgba(254, 247, 255, 0.95)",
          bodyColor: "rgba(235, 229, 245, 0.85)",
          padding: 10,
          cornerRadius: 10,
          displayColors: true,
          callbacks: {
            title: (items) => {
              const idx = items[0].dataIndex;
              const d = data[idx];
              return `${d.date} ${d.weekday}`;
            },
            label: (item) => {
              const idx = item.dataIndex;
              const d = data[idx];
              const which = item.datasetIndex === 0 ? "input" : "output";
              const val = which === "input" ? d.input : d.output;
              return `${which === "input" ? "📥 輸入" : "📤 輸出"}: ${val.toLocaleString()}`;
            },
            afterBody: (items) => {
              const idx = items[0].dataIndex;
              const d = data[idx];
              return [
                `🎯 命中: ${d.hit > 0 ? d.hit.toLocaleString() : "N/A"}`,
                `❌ 未命中: ${d.miss > 0 ? d.miss.toLocaleString() : "N/A"}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: "rgba(235, 229, 245, 0.45)", font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
        },
        y: {
          grid: { color: "rgba(255, 182, 220, 0.08)" },
          ticks: {
            color: "rgba(235, 229, 245, 0.45)",
            font: { size: 10 },
            callback: (v) => formatTokenShort(Number(v)),
          },
          beginAtZero: true,
        },
      },
    },
  };

  tokenTrendChart = new Chart(canvas, config);
}

// 更新指標卡片
function updateTokenStats(data: TokenDayData[]): void {
  const totalInput = data.reduce((s, d) => s + d.input, 0);
  const totalOutput = data.reduce((s, d) => s + d.output, 0);
  const total = totalInput + totalOutput;
  const requests = data.reduce((s, d) => s + d.requests, 0);

  const set = (id: string, val: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  set("token-total", total.toLocaleString());
  set("token-requests", requests.toLocaleString());
  set("token-input", totalInput.toLocaleString());
  set("token-output", totalOutput.toLocaleString());
  set("token-hit", "N/A");
}

// 刷新整個面板：調 IPC 拉真實數據 → 有數據渲染圖表，無數據顯示空態
async function refreshTokenPanel(days: number): Promise<void> {
  let data: TokenDayData[] = [];
  try {
    data = await window.tokenUsage?.get(days) ?? [];
  } catch (err) {
    console.warn("[settings] 拉取 Token 用量失敗:", err);
  }

  const hasData = data.some((d) => d.input > 0 || d.output > 0 || d.requests > 0);
  const emptyEl = document.getElementById("token-empty");
  const chartsEl = document.getElementById("token-charts");

  if (!hasData) {
    // 空態：隱藏圖表區，顯示空態提示，指標卡片歸零
    if (emptyEl) emptyEl.classList.remove("is-hidden");
    if (chartsEl) chartsEl.classList.add("is-hidden");
    const set = (id: string, val: string) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set("token-total", "0");
    set("token-requests", "0");
    set("token-input", "0");
    set("token-output", "0");
    set("token-hit", "N/A");
    return;
  }

  // 有數據：顯示圖表區，隱藏空態
  if (emptyEl) emptyEl.classList.add("is-hidden");
  if (chartsEl) chartsEl.classList.remove("is-hidden");
  updateTokenStats(data);
  renderTokenBarChart(data);
  renderTokenTrendChart(data);
}

// 時間範圍按鈕交互
document.querySelectorAll<HTMLButtonElement>(".token-range__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".token-range__btn").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-selected", "true");
    const days = Number(btn.dataset.range) || 7;
    tokenRangeDays = days;
    void refreshTokenPanel(days);
    void refreshAgentActivity(days);
  });
});

function formatResourceBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

async function refreshAgentActivity(days: number): Promise<void> {
  const payload = await window.agentActivity?.get(days).catch(() => null);
  if (!payload) return;
  const set = (id: string, value: string) => { const element = document.getElementById(id); if (element) element.textContent = value; };
  set("activity-total", String(payload.summary.total));
  set("activity-success-rate", payload.summary.total ? `${Math.round(payload.summary.success / payload.summary.total * 100)}%` : "—");
  set("activity-avg", payload.summary.total ? `${payload.summary.avgDurationMs} ms` : "—");
  set("activity-problems", String(payload.summary.failed + payload.summary.denied));
  set("activity-rss", formatResourceBytes(payload.resources.rssBytes));
  set("activity-heap", `${formatResourceBytes(payload.resources.heapUsedBytes)} / ${formatResourceBytes(payload.resources.heapTotalBytes)}`);
  set("activity-queue", `${payload.resources.queue.running} 執行 · ${payload.resources.queue.pending}/${payload.resources.queue.limit} 等待`);
  set("activity-context", `${payload.resources.callContextTurnLimit} 輪`);

  const events = document.getElementById("activity-events");
  if (events) {
    events.replaceChildren();
    if (!payload.events.length) events.innerHTML = '<p class="activity-empty">尚未有工具活動</p>';
    for (const event of payload.events) {
      const article = document.createElement("article");
      article.className = "activity-event";
      article.dataset.status = event.status;
      const strong = document.createElement("strong");
      strong.textContent = event.name;
      const badge = document.createElement("em");
      badge.textContent = event.status === "success" ? "成功" : event.status === "denied" ? "已拒絕" : "失敗";
      strong.appendChild(badge);
      const time = document.createElement("time");
      time.textContent = `${new Date(event.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })} · ${event.durationMs} ms`;
      const detail = document.createElement("p");
      detail.textContent = event.error ?? event.resultSummary ?? event.argsSummary ?? "沒有額外摘要";
      article.append(strong, time, detail);
      events.appendChild(article);
    }
  }

  const models = document.getElementById("activity-models");
  if (models) {
    models.replaceChildren();
    const max = Math.max(1, ...payload.models.map((model) => model.input + model.output));
    if (!payload.models.length) models.innerHTML = '<p class="activity-empty">尚無模型資料</p>';
    for (const model of payload.models.slice(0, 6)) {
      const row = document.createElement("div");
      row.className = "activity-model";
      const total = model.input + model.output;
      const label = document.createElement("div");
      label.className = "activity-model__row";
      const name = document.createElement("strong"); name.textContent = model.model;
      const count = document.createElement("span"); count.textContent = `${total.toLocaleString()} · ${model.requests} 次`;
      label.append(name, count);
      const bar = document.createElement("div"); bar.className = "activity-model__bar";
      const fill = document.createElement("i"); fill.style.width = `${Math.max(3, total / max * 100)}%`; bar.appendChild(fill);
      row.append(label, bar); models.appendChild(row);
    }
  }
}

document.getElementById("diagnostic-export-btn")?.addEventListener("click", async () => {
  const status = document.getElementById("activity-export-status");
  if (status) status.textContent = "正在整理…";
  try {
    const result = await window.agentActivity?.exportDiagnostic();
    if (status) status.textContent = result ? "已匯出" : "已取消";
  } catch (error) {
    if (status) status.textContent = error instanceof Error ? error.message : String(error);
  }
});

// 初始渲染
void refreshTokenPanel(7);
void refreshAgentActivity(tokenRangeDays);

/* ============================================================
   🎙️ TTS 設置面板交互
   - 配置加載/保存（存 general settings，跟其他設置一起）
   - 引擎選擇卡片切換：選中哪個展開哪個配置表單
   - 語速/音量滑塊實時顯示數值 + 自動保存
   - MiniMax 測試發音：調 synthesize 合成固定文本並播放
   - 音色快速復刻：選文件→上傳→訓練→自動填入 voice_id
   ============================================================ */

interface TtsApi {
  upload: (apiKey: string, filePath: string, purpose: "voice_clone" | "prompt_audio") => Promise<{ file_id: string }>;
  pickAudio: () => Promise<string | null>;
  clone: (payload: {
    apiKey: string; fileId: string; voiceId: string;
    promptAudioId?: string; promptText?: string;
    text: string; model?: string;
  }) => Promise<{ voiceId: string; audioDemo?: string }>;
  synthesize: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
  }) => Promise<string>; // base64 音頻
  // GPT-SoVITS（返回 base64 + cacheKey + cached + format）
  synthesizeGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  synthesizeCachedGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 自定義雲端（返回 base64 + cacheKey + cached + format）
  synthesizeCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  synthesizeCachedCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 小米 MiMo（返回 base64 + cacheKey + cached + format）
  synthesizeMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" }>;
  synthesizeCachedMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" }>;
  pickAudioFile: () => Promise<string | null>;
  saveSettings: (tts: Record<string, unknown>) => Promise<unknown>;
  loadSettings: () => Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    tts?: TtsApi;
  }
}

const TTS_TEST_TEXT = "你好，我是昔漣，很高興見到你。";

// 獲取 DOM 元素的輔助函數
function ttsEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

// 當前加載的 TTS 配置（內存緩存，改一個字段就存一次）
let ttsConfig: Record<string, unknown> = {};

// 加載配置並填充表單
async function loadTtsConfig(): Promise<void> {
  if (!window.tts) return;
  try {
    ttsConfig = await window.tts.loadSettings() as Record<string, unknown>;
  } catch (err) {
    console.warn("[TTS] 加載配置失敗:", err);
    return;
  }

  // 引擎選擇
  const engine = String(ttsConfig.ttsEngine || "off");
  document.querySelectorAll<HTMLButtonElement>(".tts-engine").forEach((btn) => {
    const isActive = btn.dataset.engine === engine;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-checked", isActive ? "true" : "false");
  });
  document.querySelectorAll<HTMLElement>(".tts-config").forEach((el) => { el.hidden = true; });
  if (engine !== "off") {
    const config = document.getElementById("tts-config-" + engine);
    if (config) config.hidden = false;
  }

  // 播放交互
  ttsEl("tts-auto-read").checked = Boolean(ttsConfig.ttsAutoRead);
  ttsEl("tts-speed").value = String(ttsConfig.ttsSpeed ?? 1);
  ttsEl("tts-volume").value = String(ttsConfig.ttsVolume ?? 1);
  updateTtsSliderLabels();

  // MiniMax
  ttsEl("tts-minimax-key").value = String(ttsConfig.ttsMinimaxKey ?? "");
  ttsEl("tts-minimax-voice").value = String(ttsConfig.ttsMinimaxVoiceId ?? "");
  (ttsEl("tts-minimax-model") as HTMLSelectElement).value =
    ttsConfig.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo";
  ttsEl("tts-streaming").checked = ttsConfig.ttsStreaming !== false;

  // GPT-SoVITS
  ttsEl("tts-gptsovits-url").value = String(ttsConfig.ttsGptsovitsBaseUrl ?? "http://localhost:9880");
  ttsEl("tts-gptsovits-ref-audio").value = String(ttsConfig.ttsGptsovitsRefAudioPath ?? "");
  ttsEl("tts-gptsovits-prompt-text").value = String(ttsConfig.ttsGptsovitsPromptText ?? "");
  (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value =
    ttsConfig.ttsGptsovitsFormat === "mp3" ? "mp3" : "wav";

  // 自定義雲端
  ttsEl("tts-custom-cloud-url").value = String(ttsConfig.ttsCustomCloudEndpointUrl ?? "");
  ttsEl("tts-custom-cloud-key").value = String(ttsConfig.ttsCustomCloudApiKey ?? "");
  ttsEl("tts-custom-cloud-voice").value = String(ttsConfig.ttsCustomCloudVoiceId ?? "");
  (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value =
    ttsConfig.ttsCustomCloudFormat === "wav" ? "wav" : "mp3";
  ttsEl("tts-custom-cloud-timeout").value = String(ttsConfig.ttsCustomCloudTimeoutMs ?? 30000);

  // 小米 MiMo
  ttsEl("tts-mimo-key").value = String(ttsConfig.ttsMimoKey ?? "");
  ttsEl("tts-mimo-voice-audio").value = String(ttsConfig.ttsMimoVoiceAudioPath ?? "");
  ttsEl("tts-mimo-style").value = String(ttsConfig.ttsMimoStylePrompt ?? "溫柔、自然、略帶親近感，像在輕聲陪用戶聊天。");

  // Opener 主動開口檔位
  const openerMode = String(ttsConfig.openerMode ?? "off");
  document.querySelectorAll<HTMLButtonElement>(".opener-mode").forEach((btn) => {
    const isActive = btn.dataset.mode === openerMode;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-checked", isActive ? "true" : "false");
  });
  openerEl("opener-quiet-start").value = String(ttsConfig.openerQuietStart ?? "23:00");
  openerEl("opener-quiet-end").value = String(ttsConfig.openerQuietEnd ?? "07:00");
  openerEl("opener-daily-limit").value = String(ttsConfig.openerDailyLimit ?? 4);
  openerEl("opener-routine-enabled").checked = ttsConfig.openerRoutineEnabled !== false;
  openerEl("opener-breaks-enabled").checked = ttsConfig.openerBreaksEnabled !== false;
  openerEl("opener-weather-enabled").checked = ttsConfig.openerWeatherEnabled !== false;
  updateOpenerUi();
  void refreshOpenerStatus();

  // 每日陪伴儀式
  ritualEl("daily-ritual-enabled").checked = Boolean(ttsConfig.dailyRitualEnabled);
  ritualEl("daily-ritual-voice").checked = ttsConfig.dailyRitualVoice !== false;
  ritualEl("daily-ritual-morning-enabled").checked = ttsConfig.dailyRitualMorningEnabled !== false;
  ritualEl("daily-ritual-morning-time").value = String(ttsConfig.dailyRitualMorningTime ?? "08:00");
  ritualEl("daily-ritual-afternoon-enabled").checked = ttsConfig.dailyRitualAfternoonEnabled !== false;
  ritualEl("daily-ritual-afternoon-time").value = String(ttsConfig.dailyRitualAfternoonTime ?? "15:00");
  ritualEl("daily-ritual-evening-enabled").checked = ttsConfig.dailyRitualEveningEnabled !== false;
  ritualEl("daily-ritual-evening-time").value = String(ttsConfig.dailyRitualEveningTime ?? "22:30");
  updateRitualEnabledState();
}

function ritualEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function setRitualStatus(text: string): void {
  const el = document.getElementById("daily-ritual-status");
  if (el) el.textContent = text;
}

function updateRitualEnabledState(): void {
  document.getElementById("daily-ritual-timeline")?.classList.toggle(
    "is-disabled",
    !ritualEl("daily-ritual-enabled").checked,
  );
}

async function saveRitualField(field: string, value: unknown): Promise<void> {
  setRitualStatus("正在保存…");
  await saveTtsField(field, value);
  setRitualStatus("已保存");
  window.setTimeout(() => setRitualStatus("設定會立即保存"), 1600);
}

function bindDailyRitualControls(): void {
  const master = document.getElementById("daily-ritual-enabled") as HTMLInputElement | null;
  if (!master) return;
  master.addEventListener("change", () => {
    updateRitualEnabledState();
    void saveRitualField("dailyRitualEnabled", master.checked);
  });
  ritualEl("daily-ritual-voice").addEventListener("change", event => {
    void saveRitualField("dailyRitualVoice", (event.currentTarget as HTMLInputElement).checked);
  });

  for (const period of ["morning", "afternoon", "evening"] as const) {
    const enabled = ritualEl(`daily-ritual-${period}-enabled`);
    const time = ritualEl(`daily-ritual-${period}-time`);
    const key = period[0].toUpperCase() + period.slice(1);
    enabled.addEventListener("change", () => void saveRitualField(`dailyRitual${key}Enabled`, enabled.checked));
    time.addEventListener("change", () => void saveRitualField(`dailyRitual${key}Time`, time.value));
  }

  document.querySelectorAll<HTMLButtonElement>("[data-ritual-test]").forEach(button => {
    button.addEventListener("click", async () => {
      const ritualId = button.dataset.ritualTest;
      button.disabled = true;
      setRitualStatus("昔漣正在準備…");
      try {
        const list = await window.cyreneScheduler?.list();
        const task = list?.value?.find(item => item.managedBy === "daily-ritual" && item.ritualId === ritualId);
        if (!task) throw new Error("儀式任務尚未建立，請先切換一次啟用開關");
        const fired = await window.cyreneScheduler?.fireNow(task.id);
        if (!fired?.ok) throw new Error(fired?.error || fired?.reason || "無法立即運行");
        const history = await window.cyreneScheduler?.getHistory(task.id, 1);
        const latest = history?.value?.[0];
        if (latest?.status === "failed") throw new Error(latest.errorMessage || "生成失敗");
        setRitualStatus("已送到桌寵");
      } catch (err) {
        setRitualStatus(err instanceof Error ? err.message : String(err));
      } finally {
        button.disabled = false;
      }
    });
  });
}

function updateTtsSliderLabels(): void {
  const speedVal = document.getElementById("tts-speed-val");
  const volVal = document.getElementById("tts-volume-val");
  if (speedVal) speedVal.textContent = Number(ttsEl("tts-speed").value).toFixed(1) + "x";
  if (volVal) volVal.textContent = Math.round(Number(ttsEl("tts-volume").value) * 100) + "%";
}

interface OpenerUiStatus {
  running: boolean;
  packSource: "voice-pack" | "built-in-text";
  sceneCount: number;
  audioItemCount: number;
  textItemCount: number;
  dailyFireCount: number;
  dailyLimit: number;
  desire: number;
  lastScene: string | null;
  lastTriggeredAt: number | null;
  city: string;
}

interface OpenerBridgeApi {
  testFire: (sceneId?: string) => Promise<{ ok: boolean; message: string }>;
  getStatus: () => Promise<OpenerUiStatus>;
  openPackFolder: () => Promise<{ ok: boolean; error?: string }>;
}

function openerBridge(): OpenerBridgeApi | undefined {
  return (window as unknown as { openerBridge?: OpenerBridgeApi }).openerBridge;
}

function openerEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function updateOpenerUi(): void {
  const mode = String(ttsConfig.openerMode ?? "off");
  document.querySelector(".opener-console")?.classList.toggle("is-off", mode === "off");
  const limit = Number(openerEl("opener-daily-limit").value || 4);
  const label = document.getElementById("opener-daily-limit-value");
  if (label) label.textContent = `${limit} 次`;
}

function setOpenerTestStatus(text: string): void {
  const status = document.getElementById("opener-test-status");
  if (status) status.textContent = text;
}

async function refreshOpenerStatus(): Promise<void> {
  const api = openerBridge();
  if (!api) return;
  try {
    const status = await api.getStatus();
    const health = document.getElementById("opener-health");
    health?.classList.toggle("is-running", status.running);
    if (health) health.title = status.city ? `天氣位置：${status.city}` : "尚未設定默認城市，天氣場景不會觸發";
    const title = document.getElementById("opener-health-title");
    const detail = document.getElementById("opener-health-detail");
    if (title) title.textContent = status.running ? "感知中" : "目前已關閉";
    if (detail) {
      const source = status.packSource === "voice-pack"
        ? `語音包 · ${status.audioItemCount} 句`
        : `內建文字 · ${status.textItemCount} 句`;
      detail.textContent = `${source} · 今日 ${status.dailyFireCount}/${status.dailyLimit}`;
    }
  } catch (err) {
    const title = document.getElementById("opener-health-title");
    const detail = document.getElementById("opener-health-detail");
    if (title) title.textContent = "狀態讀取失敗";
    if (detail) detail.textContent = err instanceof Error ? err.message : String(err);
  }
}

function bindOpenerControls(): void {
  for (const [id, field] of [
    ["opener-quiet-start", "openerQuietStart"],
    ["opener-quiet-end", "openerQuietEnd"],
  ] as const) {
    openerEl(id).addEventListener("change", () => void saveTtsField(field, openerEl(id).value).then(refreshOpenerStatus));
  }
  const limit = openerEl("opener-daily-limit");
  limit.addEventListener("input", updateOpenerUi);
  limit.addEventListener("change", () => void saveTtsField("openerDailyLimit", Number(limit.value)).then(refreshOpenerStatus));
  for (const [id, field] of [
    ["opener-routine-enabled", "openerRoutineEnabled"],
    ["opener-breaks-enabled", "openerBreaksEnabled"],
    ["opener-weather-enabled", "openerWeatherEnabled"],
  ] as const) {
    openerEl(id).addEventListener("change", () => void saveTtsField(field, openerEl(id).checked).then(refreshOpenerStatus));
  }

  document.getElementById("opener-open-pack-folder")?.addEventListener("click", async () => {
    const result = await openerBridge()?.openPackFolder();
    setOpenerTestStatus(result?.ok ? "已打開語音包資料夾；放入 manifest.json 與 wav 後重新讀取即可。" : result?.error || "無法打開資料夾");
  });
}

// 保存單個 TTS 配置字段
async function saveTtsField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  ttsConfig[field] = value;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[TTS] 保存配置失敗:", field, err);
  }
}

// 播放 base64 音頻。format 決定 Blob MIME（minimax 默認 mp3，gptsovits 默認 wav）
function playTtsAudio(base64: string, format: "wav" | "mp3" = "mp3"): void {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const mime = format === "wav" ? "audio/wav" : "audio/mp3";
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play().catch((err) => console.warn("[TTS] 播放失敗:", err));
    audio.onended = () => URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("[TTS] 音頻解碼失敗:", err);
  }
}

// 引擎選擇切換
// 只匹配帶 data-engine 的按鈕（即 TTS 廠商按鈕）——主動開口檔位按鈕雖然
// 共用 .tts-engine 視覺 class，但只有 data-mode 沒有 data-engine，
// 用屬性選擇器避免誤觸把它們當作 TTS 廠商處理。
document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const engine = btn.dataset.engine || "off";
    document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-checked", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-checked", "true");
    document.querySelectorAll<HTMLElement>(".tts-config").forEach((el) => { el.hidden = true; });
    if (engine !== "off") {
      const config = document.getElementById("tts-config-" + engine);
      if (config) config.hidden = false;
    }
    void saveTtsField("ttsEngine", engine);
  });
});

// Opener 主動開口檔位切換
document.querySelectorAll<HTMLButtonElement>(".opener-mode").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode || "off";
    document.querySelectorAll<HTMLButtonElement>(".opener-mode").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-checked", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-checked", "true");
    ttsConfig.openerMode = mode;
    updateOpenerUi();
    void saveTtsField("openerMode", mode).then(refreshOpenerStatus);
  });
});

// Opener 測試氣泡：可選場景，並把缺少桌寵/語音包等原因直接顯示給使用者。
document.getElementById("opener-test-fire")?.addEventListener("click", async () => {
  const button = document.getElementById("opener-test-fire") as HTMLButtonElement;
  const scene = (document.getElementById("opener-test-scene") as HTMLSelectElement | null)?.value;
  button.disabled = true;
  setOpenerTestStatus("正在送出測試氣泡…");
  try {
    const result = await openerBridge()?.testFire(scene);
    setOpenerTestStatus(result?.message ?? "主動開口橋接尚未就緒。");
    await refreshOpenerStatus();
  } catch (err) {
    setOpenerTestStatus(err instanceof Error ? err.message : String(err));
  } finally {
    button.disabled = false;
  }
});

// 自動朗讀開關
ttsEl("tts-auto-read").addEventListener("change", () => {
  void saveTtsField("ttsAutoRead", ttsEl("tts-auto-read").checked);
});

// 語速/音量滑塊（change 時保存，input 時實時顯示）
ttsEl("tts-speed").addEventListener("input", updateTtsSliderLabels);
ttsEl("tts-speed").addEventListener("change", () => saveTtsField("ttsSpeed", Number(ttsEl("tts-speed").value)));
ttsEl("tts-volume").addEventListener("input", updateTtsSliderLabels);
ttsEl("tts-volume").addEventListener("change", () => saveTtsField("ttsVolume", Number(ttsEl("tts-volume").value)));

// 配置輸入框 change 時保存 + input 時防抖保存（防粘貼後未失焦就丟失）
const ttsSaveFields: Array<[string, string]> = [
  ["tts-minimax-key", "ttsMinimaxKey"],
  ["tts-minimax-voice", "ttsMinimaxVoiceId"],
  ["tts-minimax-model", "ttsMinimaxModel"],
  ["tts-gptsovits-url", "ttsGptsovitsBaseUrl"],
  ["tts-gptsovits-ref-audio", "ttsGptsovitsRefAudioPath"],
  ["tts-gptsovits-prompt-text", "ttsGptsovitsPromptText"],
  ["tts-custom-cloud-url", "ttsCustomCloudEndpointUrl"],
  ["tts-custom-cloud-key", "ttsCustomCloudApiKey"],
  ["tts-custom-cloud-voice", "ttsCustomCloudVoiceId"],
  ["tts-custom-cloud-timeout", "ttsCustomCloudTimeoutMs"],
  ["tts-mimo-key", "ttsMimoKey"],
  ["tts-mimo-voice-audio", "ttsMimoVoiceAudioPath"],
  ["tts-mimo-style", "ttsMimoStylePrompt"],
];
const ttsDebounceTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
for (const [elId, field] of ttsSaveFields) {
  ttsEl(elId).addEventListener("change", () => saveTtsField(field, ttsEl(elId).value));
  // 防抖保存：輸入或粘貼後 800ms 自動保存，不依賴失焦
  ttsEl(elId).addEventListener("input", () => {
    clearTimeout(ttsDebounceTimers[field]);
    ttsDebounceTimers[field] = setTimeout(() => {
      void saveTtsField(field, ttsEl(elId).value);
    }, 800);
  });
}

// GPT-SoVITS 格式選擇（select，change 時直接保存）
(ttsEl("tts-gptsovits-format") as HTMLSelectElement).addEventListener("change", () => {
  void saveTtsField("ttsGptsovitsFormat", (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value as "wav" | "mp3");
});

// 自定義雲端格式選擇
(ttsEl("tts-custom-cloud-format") as HTMLSelectElement).addEventListener("change", () => {
  void saveTtsField("ttsCustomCloudFormat", (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value as "wav" | "mp3");
});

// MiniMax 流式播放開關
ttsEl("tts-streaming").addEventListener("change", () => {
  void saveTtsField("ttsStreaming", ttsEl("tts-streaming").checked);
});

// GPT-SoVITS 選擇參考音頻
document.getElementById("tts-gptsovits-ref-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudioFile();
  if (filePath) {
    ttsEl("tts-gptsovits-ref-audio").value = filePath;
    void saveTtsField("ttsGptsovitsRefAudioPath", filePath);
  }
});

// GPT-SoVITS 測試發音
document.getElementById("tts-gptsovits-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const baseUrl = ttsEl("tts-gptsovits-url").value.trim();
  const refAudioPath = ttsEl("tts-gptsovits-ref-audio").value.trim();
  const promptText = ttsEl("tts-gptsovits-prompt-text").value.trim();
  const format = (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value as "wav" | "mp3";
  if (!baseUrl) { window.alert("請先填寫 GPT-SoVITS API 地址"); return; }
  if (!refAudioPath) { window.alert("請先選擇參考音頻文件"); return; }
  if (!promptText) { window.alert("請先填寫參考音頻對應的文本"); return; }

  const btn = document.getElementById("tts-gptsovits-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const result = await window.tts.synthesizeGptsovits({
      baseUrl, refAudioPath, promptText, text: TTS_TEST_TEXT, format,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    window.alert("測試失敗: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 測試發音";
  }
});

// 小米 MiMo 選擇昔漣克隆參考音頻
document.getElementById("tts-mimo-voice-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudioFile();
  if (filePath) {
    ttsEl("tts-mimo-voice-audio").value = filePath;
    void saveTtsField("ttsMimoVoiceAudioPath", filePath);
  }
});

// 自定義雲端測試發音
document.getElementById("tts-custom-cloud-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const endpointUrl = ttsEl("tts-custom-cloud-url").value.trim();
  const apiKey = ttsEl("tts-custom-cloud-key").value.trim();
  const voiceId = ttsEl("tts-custom-cloud-voice").value.trim();
  const format = (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value as "wav" | "mp3";
  const timeoutMs = Number(ttsEl("tts-custom-cloud-timeout").value) || 30000;
  if (!endpointUrl) { window.alert("請先填寫自定義雲端 Endpoint URL"); return; }

  const btn = document.getElementById("tts-custom-cloud-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const result = await window.tts.synthesizeCustomCloud({
      endpointUrl, apiKey, voiceId, text: TTS_TEST_TEXT,
      speed: Number(ttsEl("tts-speed").value),
      volume: Number(ttsEl("tts-volume").value),
      format,
      timeoutMs,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    window.alert("測試失敗: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 測試發音";
  }
});

// 小米 MiMo 測試發音
document.getElementById("tts-mimo-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mimo-key").value.trim();
  const voiceAudioPath = ttsEl("tts-mimo-voice-audio").value.trim();
  const stylePrompt = ttsEl("tts-mimo-style").value.trim();
  if (!apiKey) { window.alert("請先填寫小米 MiMo API Key"); return; }
  if (!voiceAudioPath) { window.alert("請先選擇昔漣克隆參考音頻"); return; }

  const btn = document.getElementById("tts-mimo-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const result = await window.tts.synthesizeMimo({
      apiKey, voiceAudioPath, stylePrompt, text: TTS_TEST_TEXT,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    window.alert("測試失敗: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 測試發音";
  }
});

// MiniMax 測試發音
document.getElementById("tts-minimax-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-minimax-key").value.trim();
  const voiceId = ttsEl("tts-minimax-voice").value.trim();
  const modelSelect = ttsEl("tts-minimax-model") as HTMLSelectElement;
  const model = modelSelect.value === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo";
  if (!apiKey) { window.alert("請先填寫 MiniMax API Key"); return; }
  if (!voiceId) { window.alert("請先填寫音色 ID（或下方復刻訓練）"); return; }

  const btn = document.getElementById("tts-minimax-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const base64 = await window.tts.synthesize({ apiKey, voiceId, text: TTS_TEST_TEXT, model });
    playTtsAudio(base64);
  } catch (err) {
    window.alert("測試失敗: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 測試發音";
  }
});

// ── 音色快速復刻 ──
// 選擇配音文件
document.getElementById("tts-clone-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-clone-file").value = filePath;
});

// 選擇示例音頻
document.getElementById("tts-clone-prompt-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-clone-prompt-file").value = filePath;
});

// 設置復刻狀態文案
function setCloneStatus(text: string, type: "ok" | "error" | "loading"): void {
  const el = document.getElementById("tts-clone-status");
  if (!el) return;
  el.textContent = text;
  el.className = "tts-clone-status" + (type ? " is-" + type : "");
}

// 開始復刻
document.getElementById("tts-clone-start")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-minimax-key").value.trim();
  const cloneFile = ttsEl("tts-clone-file").value.trim();
  const promptFile = ttsEl("tts-clone-prompt-file").value.trim();
  const promptText = ttsEl("tts-clone-prompt-text").value.trim();
  const cloneText = ttsEl("tts-clone-text").value.trim();
  const voiceId = ttsEl("tts-clone-voice-id").value.trim();

  if (!apiKey) { window.alert("請先填寫 MiniMax API Key"); return; }
  if (!cloneFile) { window.alert("請選擇配音文件"); return; }
  if (!cloneText) { window.alert("請填寫復刻文本"); return; }
  if (!voiceId) { window.alert("請填寫音色命名"); return; }

  const btn = document.getElementById("tts-clone-start") as HTMLButtonElement;
  btn.disabled = true;
  setCloneStatus("正在上傳配音文件…", "loading");

  try {
    // 步驟1: 上傳配音文件
    const cloneUpload = await window.tts.upload(apiKey, cloneFile, "voice_clone");
    setCloneStatus("配音文件上傳完成 (file_id: " + cloneUpload.file_id + ")，正在上傳示例音頻…", "loading");

    // 步驟2: 上傳示例音頻（可選）
    let promptFileId: string | undefined;
    if (promptFile) {
      const promptUpload = await window.tts.upload(apiKey, promptFile, "prompt_audio");
      promptFileId = promptUpload.file_id;
      setCloneStatus("示例音頻上傳完成，正在訓練音色…", "loading");
    } else {
      setCloneStatus("正在訓練音色…", "loading");
    }

    // 步驟3: 音色克隆
    const result = await window.tts.clone({
      apiKey, fileId: cloneUpload.file_id, voiceId,
      promptAudioId: promptFileId, promptText: promptText || undefined,
      text: cloneText,
    });

    // 自動填入音色 ID
    ttsEl("tts-minimax-voice").value = result.voiceId;
    void saveTtsField("ttsMinimaxVoiceId", result.voiceId);

    setCloneStatus("✅ 復刻成功！音色 ID「" + result.voiceId + "」已自動填入。", "ok");

    // 如果有試聽音頻，播放
    if (result.audioDemo) {
      try {
        const resp = await fetch(result.audioDemo);
        const buf = await resp.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        playTtsAudio(base64);
      } catch { /* 試聽音頻播放失敗不影響主流程 */ }
    }
  } catch (err) {
    setCloneStatus("❌ " + (err instanceof Error ? err.message : String(err)), "error");
  } finally {
    btn.disabled = false;
  }
});

// 初始加載配置
bindDailyRitualControls();
bindOpenerControls();
void loadTtsConfig();

if (window.self !== window.top) {
  document.body.classList.add("is-embedded");
}
