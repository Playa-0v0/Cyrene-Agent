import "../ui/base.css";
import "./settings.css";
import "../ui/theme";
import neteaseLogoUrl from "./assets/netease-logo.svg?url";
import {
  CHAT_DEFAULT_IDENTITY_LABEL,
  formatChatRelativeTime,
  type ChatSessionMetaUI,
} from "../../shared/chat-ui";
import {
  normalizeDefaultChatMode,
  normalizeMobileMessageSegmentationMode,
  normalizeProactiveChatMode,
  normalizeProactiveDeliveryTarget,
  normalizeSegmentedOutputMode,
  type DefaultChatMode,
  type MobileMessageSegmentationMode,
  type ProactiveChatMode,
  type ProactiveDeliveryTarget,
  type SegmentedOutputMode,
} from "../../shared/preferences";
import { isProactiveDeliveryTargetSelectable } from "../../shared/proactive-delivery";
import { normalizeUiTheme, type UiTheme } from "../../shared/ui-theme";
import { DEFAULT_UI_FONT, normalizeUiFont, type UiFont } from "../../shared/ui-font";
import { normalizeUiIcon, type UiIcon } from "../../shared/ui-icon";
import { buildAppearanceSettingsPatch } from "./appearance-settings-state";
import { requestTrackPlayback } from "./music-playback";
import { type ReasoningPreference } from "../../shared/reasoning";
import { type LoginFlowState } from "../../shared/music-types";
import {
  deriveNeteaseViewState,
  type MusicStatusSnapshot,
  type NeteaseViewState,
} from "../../shared/music-view-state";
export {
  deriveNeteaseViewState,
  type MusicStatusSnapshot,
  type NeteaseViewState,
} from "../../shared/music-view-state";

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
  displayName?: string;
  /**
   * 用户在 settings 显式指定的 transport；"auto" = 按 baseUrl 启发式 + capabilities fallback。
   * main 进程的 resolveTransport() 负责把 "auto" 解析为具体 transport。
   */
  explicitTransport?: "openai" | "anthropic" | "auto";
  reasoning?: ReasoningPreference;
}

interface ModelSettings {
  mode: "auto" | "manual";
  provider: string;
  // 用户给模型起的自定义昵称，留空时用厂商 shortName。状态栏"正在喂养"显示它。
  displayName?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * 当前厂商的 explicitTransport 镜像（顶层字段是 main 进程 perProvider[currentProvider] 的视图）。
   * UI 改动 transport-select 时，saveConfig 把这个值带给 main 进程折叠回 perProvider。
   */
  explicitTransport?: "openai" | "anthropic" | "auto";
  /** 当前厂商 reasoning 偏好的顶层镜像。 */
  reasoning?: ReasoningPreference;
  // 按厂商缓存：切回该厂商时，从这里恢复 baseUrl / model / apiKey
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
  // 厂商短名（去括号后缀），用于状态栏"正在喂养"显示和昵称默认值。
  // 如 "MiniMax（稀宇科技）" → shortName "MiniMax"。
  shortName: string;
  baseUrl: string;
  mainModels: string[];
  iconUrl: string;
  // 厂商官网链接，显示在预设下拉框旁边，方便用户直接跳转注册/查看文档。
  websiteUrl?: string;
  // 视觉模型的 OpenAI 兼容 baseUrl。仅当主配走 Anthropic 入口、视觉要走 OpenAI 入口时才标
  // （如 MiniMax 主配 /anthropic，视觉走 /v1）。勾选"同步主模型"时 UI 用它填视觉框。
  visionBaseUrl?: string;
  // 该厂商默认主模型是否支持视觉。true 时设置页加载默认勾选"同步主模型"，
  // 多模态用户开箱即用。与 capabilities.ts 的 supportsVision 镜像，需手动同步。
  supportsVision?: boolean;
  // 标记为 true 时，该项在 <select> 里显示但不可选；
  // 用于"已列出但 vendor adapter 还没接好"的情况，避免用户选到后调用直接报错。
  disabled?: boolean;
  // 视觉模型与主模型本质不同（如 MiMo 主 mimo-v2.5-pro、视觉 mimo-v2.5），
  // 强制独立配置，无法"与主聊天模型相同"。与 supportsVision 正交。
  independentVision?: boolean;
  // 独立视觉模型的默认值（applyPreset 在没有保存值时使用）。
  defaultVisionModel?: string;
  // 独立视觉模型的候选列表（用于视觉模型输入框的 datalist）。
  visionModels?: string[];
}

interface GeneralSettings {
  musicEnabled: boolean;
  musicVolume: number;
  soundEnabled: boolean;
  soundVolume: number;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  petZoom: number;
  disableGpuElectron?: boolean;
  sidebarVisible: boolean;
  tasksVisible: boolean;
  launchAtLogin: boolean;
  language: "zh-CN";
  uiTheme: UiTheme;
  uiFont: UiFont;
  uiIcon: UiIcon;
  defaultChatMode: DefaultChatMode;
  segmentedOutputMode: SegmentedOutputMode;
  mobileMessageSegmentation: MobileMessageSegmentationMode;
  proactiveChatMode: ProactiveChatMode;
  proactiveDeliveryTarget: ProactiveDeliveryTarget;
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
  getTimeoutSettings: () => Promise<TimeoutSettings>;
  saveTimeoutSettings: (config: Partial<TimeoutSettings>) => Promise<TimeoutSettings>;
  pickUiFont: () => Promise<string | null>;
  importUiFont: (sourcePath: string) => Promise<UiFont>;
  resetUiFont: () => Promise<UiFont>;
  openSidebar: () => void;
  closeSidebar: () => void;
  openTasks: () => void;
  closeTasks: () => void;
  openChromeGpu: () => void;
  setPetAlwaysOnTop: (value: boolean) => void;
  setPetVisible: (value: boolean) => void;
  setPetZoom: (value: number) => void;
  previewRuntimeSync: (value: "off" | "local" | "llm") => void;
  openStickerManager: () => Promise<{ ok: boolean; error?: string }>;
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
  // main → settings：要求切到指定标签（窗口已打开时由 main 发这个事件）
  onSwitchSection?: (callback: (section: string) => void) => (() => void) | void;
  channelsGetStatus: () => Promise<Record<string, { phase?: string; message?: string }>>;
  onChannelsStatusChanged: (callback: (status: unknown) => void) => (() => void) | void;
}

declare global {
  interface Window {
    settings?: SettingsApi;
    cyreneScheduler?: SchedulerApi;
    user?: UserApi;
    memoryPanel?: MemoryPanelApi;
  }
}

// MiMo 的 icon 是 lobehub-icons 仓库的 PNG（不在 icons-static-svg 包里）。
// 单独声明，与 8 家 npmmirror SVG 常量解耦（feat/chore 两个 commit 真正独立）。
// 实施时若图片加载失败，可考虑：1) 锁定 commit hash；2) 下载到本地 assets/icons/mimo.png
const MIMO_ICON_URL =
  "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/xiaomimimo.png";

const MODEL_PRESETS: ModelPreset[] = [
  // 当前已适配 9 家：MiniMax / DeepSeek / 火山 AgentPlan / 智谱 GLM / Kimi / Qwen / ChatGPT / Claude / MiMo
  // 顺序按使用频率 + 适配优先级；未在此清单内的厂商已硬删，需要时再补回。
  {
    providerName: "MiniMax（稀宇科技）",
    shortName: "MiniMax",
    baseUrl: "https://api.minimaxi.com/anthropic",
    mainModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/minimax.svg",
    websiteUrl: "https://platform.minimaxi.com/",
    // 主配走 /anthropic，但视觉要走 OpenAI 入口 /v1。勾"同步"时 UI 自动用这个，用户不用手改。
    visionBaseUrl: "https://api.minimaxi.com/v1",
    supportsVision: true,
  },
  {
    // DeepSeek：v1 vendor adapter 不为它做协议层强制，仅作为 OpenAI 兼容厂商列出。
    // 已确认（来自官方定价文档）：支持 Tool Calls / JSON Output；后端原生缓存（命中后输入价跌至 1/50~1/120）。
    // 缓存能力等 v2 vendor adapter 接入时再利用，v1 不动。
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
    // 火山方舟是聚合平台，路由到 doubao-seed 等多模态子模型时支持视觉
    supportsVision: true,
  },
  {
    providerName: "GLM（智谱）",
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
    // k2.6 / k2.7-code 支持 image_url 多模态
    supportsVision: true,
  },
  {
    providerName: "Qwen（通义千问）",
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
    // 国内多数用户走中转站，型号命名各家不一；预设留空，由用户在型号输入框里自行填写。
    mainModels: [],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openai.svg",
    websiteUrl: "https://platform.openai.com/",
  },
  {
    providerName: "Claude（Anthropic）",
    shortName: "Claude",
    baseUrl: "https://api.anthropic.com/v1",
    mainModels: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"],
    iconUrl: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/claude.svg",
    websiteUrl: "https://console.anthropic.com/",
  },
  {
    providerName: "MiMo（小米）",
    shortName: "MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    mainModels: ["mimo-v2.5-pro"],
    iconUrl: MIMO_ICON_URL,
    websiteUrl: "https://mimo.mi.com/",
    visionBaseUrl: "https://api.xiaomimimo.com/v1",
    supportsVision: true,
    // 主模型 mimo-v2.5-pro 不适合做视觉（视觉模型是 mimo-v2.5），强制独立配置
    independentVision: true,
    defaultVisionModel: "mimo-v2.5",
    visionModels: ["mimo-v2.5"],
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
    getGeneral: () => Promise.resolve({
      musicEnabled: false,
      musicVolume: 60,
      soundEnabled: true,
      soundVolume: 70,
      petAlwaysOnTop: true,
      petVisible: true,
      petZoom: 1,
      sidebarVisible: true,
      tasksVisible: true,
      launchAtLogin: false,
      language: "zh-CN",
      uiTheme: "classic",
      defaultChatMode: "collab",
      segmentedOutputMode: "off",
      mobileMessageSegmentation: "off",
      proactiveChatMode: "off",
      proactiveDeliveryTarget: "local",
    }),
    saveGeneral: (c) => Promise.resolve(c as GeneralSettings),
    channelsGetStatus: () => Promise.resolve({}),
    onChannelsStatusChanged: () => () => {},
    openSidebar: () => {},
    closeSidebar: () => {},
    openTasks: () => {},
    closeTasks: () => {},
    openChromeGpu: () => {},
    setPetAlwaysOnTop: () => {},
    setPetVisible: () => {},
    setPetZoom: () => {},
    openStickerManager: async () => ({ ok: false, error: "settings api unavailable" }),
    stickerPickFile: async () => null,
    stickerAdd: async () => { throw new Error("settings api unavailable"); },
    setToolEnabled: async () => ({ ok: false, error: "settings api unavailable" }),
    getToolEnabled: async () => ({}),
    listSkills: async () => [],
    setSkillEnabled: async () => ({ ok: false, error: "settings api unavailable" }),
    addMcpServer: async () => ({ ok: false, error: "settings api unavailable" }),
    removeMcpServer: async () => ({ ok: false, error: "settings api unavailable" }),
    listMcpServers: async () => [],
    getTimeoutSettings: async () => DEFAULT_TIMEOUT_SETTINGS,
    saveTimeoutSettings: async c => (c as TimeoutSettings),
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
const apiTimeoutForm = document.getElementById("api-timeout-form") as HTMLFormElement;
const appearanceForm = document.getElementById("appearance-form") as HTMLFormElement;
const generalForm = document.getElementById("general-form") as HTMLFormElement;
const preferencesForm = document.getElementById("preferences-form") as HTMLFormElement;
const sectionTitle = document.getElementById("section-title") as HTMLElement;
const sectionHint = document.getElementById("section-hint") as HTMLElement;
const placeholderPanel = document.getElementById("placeholder-panel") as HTMLElement;
const cyrenePanel = document.getElementById("cyrene-panel") as HTMLFormElement;
const disclaimerPanel = document.getElementById("disclaimer-panel") as HTMLElement;
const pluginsPanel = document.getElementById("plugins-panel") as HTMLElement;
document.querySelectorAll<HTMLImageElement>("[data-music-logo]").forEach((image) => {
  image.src = neteaseLogoUrl;
});
const placeholderIcon = document.getElementById("placeholder-icon") as HTMLElement;
const placeholderTitle = document.getElementById("placeholder-title") as HTMLElement;
const placeholderCopy = document.getElementById("placeholder-copy") as HTMLElement;
const saveStatus = document.getElementById("save-status") as HTMLElement;
const appearanceSaveStatus = document.getElementById("appearance-save-status") as HTMLElement;
const generalSaveStatus = document.getElementById("general-save-status") as HTMLElement;
const timeoutSaveStatus = document.getElementById("timeout-save-status") as HTMLElement;
const preferencesSaveStatus = document.getElementById("preferences-save-status") as HTMLElement;
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
// 模式按钮已删除——baseUrl 永远可改、模型名永远可手填（datalist 出预设建议）
// provider 不再暴露给用户（从预设内部拿，保证 capabilities 匹配不出错）。
// 用户看到的是"昵称"框——给模型起自定义名字，状态栏"正在喂养"显示它。
const displayNameInput = document.getElementById("display-name") as HTMLInputElement;
const baseUrlInput = document.getElementById("base-url") as HTMLInputElement;
const baseUrlResetBtn = document.getElementById("base-url-reset-btn") as HTMLButtonElement;
const modelInput = document.getElementById("model-input") as HTMLInputElement;
const modelInputSuggestions = document.getElementById("model-input-suggestions") as HTMLDataListElement;
const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
const testConnectionBtn = document.getElementById("test-connection-btn") as HTMLButtonElement | null;
// API 协议下拉（auto / openai / anthropic）—— 用户显式 override transport
const transportSelect = document.getElementById("transport-select") as HTMLSelectElement;

// 视觉模型配置区元素
// 同步主模型改为胶囊按钮组：[与主聊天模型相同] / [独立配置]
const visionSyncBlocks = document.getElementById("vision-sync-blocks") as HTMLElement;
const visionSyncMainBtn = visionSyncBlocks.querySelector('[data-vision-sync="main"]') as HTMLButtonElement;
const visionSyncIndepBtn = visionSyncBlocks.querySelector('[data-vision-sync="independent"]') as HTMLButtonElement;
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
const petZoomInput = document.getElementById("pet-zoom") as HTMLInputElement;
const petZoomVal = document.getElementById("pet-zoom-val") as HTMLElement;
const launchAtLoginInput = document.getElementById("launch-at-login") as HTMLInputElement;
const uiThemeSelect = document.getElementById("ui-theme-select") as HTMLElement;
const uiFontCurrent = document.getElementById("ui-font-current") as HTMLElement;
const uiFontImportButton = document.getElementById("ui-font-import") as HTMLButtonElement;
const uiFontResetButton = document.getElementById("ui-font-reset") as HTMLButtonElement;
const uiIconSelect = document.getElementById("ui-icon-select") as HTMLElement;
const languageSelect = document.getElementById("language-select") as HTMLElement;
const defaultChatModeSelect = document.getElementById("default-chat-mode-select") as HTMLElement;
const segmentedOutputSelect = document.getElementById("segmented-output-select") as HTMLElement;
const mobileMessageSegmentationSelect = document.getElementById("mobile-message-segmentation-select") as HTMLElement;
const proactiveChatSelect = document.getElementById("proactive-chat-select") as HTMLElement;
const proactiveDeliveryRow = document.getElementById("proactive-delivery-row") as HTMLElement;
const proactiveDeliverySelect = document.getElementById("proactive-delivery-select") as HTMLElement;
const openChromeGpu = document.getElementById("open-chrome-gpu") as HTMLElement;
const disableGpuInput = document.getElementById("disable-gpu-electron") as HTMLInputElement;
const sidebarVisibleInput = document.getElementById("sidebar-visible") as HTMLInputElement;
const tasksVisibleInput = document.getElementById("tasks-visible") as HTMLInputElement;
const clearChatHistoryBtn = document.getElementById("clear-chat-history-btn") as HTMLButtonElement;
const openStickerManagerBtn = document.getElementById("open-sticker-manager-btn") as HTMLButtonElement;
const addStickerBtn = document.getElementById("add-sticker-btn") as HTMLButtonElement;
const stickerThresholdInput = document.getElementById("sticker-threshold") as HTMLInputElement;
const stickerThresholdVal = document.getElementById("sticker-threshold-val") as HTMLElement;
const timeoutChatRequestInput = document.getElementById("timeout-chat-request") as HTMLInputElement;
const timeoutChatRequestReset = document.getElementById("timeout-chat-request-reset-btn") as HTMLButtonElement;
const timeoutPerRoundInput = document.getElementById("timeout-per-round") as HTMLInputElement;
const timeoutPerRoundReset = document.getElementById("timeout-per-round-reset-btn") as HTMLButtonElement;
const timeoutSummaryInput = document.getElementById("timeout-summary") as HTMLInputElement;
const timeoutSummaryReset = document.getElementById("timeout-summary-reset-btn") as HTMLButtonElement;
const timeoutVisionInput = document.getElementById("timeout-vision") as HTMLInputElement;
const timeoutVisionReset = document.getElementById("timeout-vision-reset-btn") as HTMLButtonElement;
const timeoutUserChoiceInput = document.getElementById("timeout-user-choice") as HTMLInputElement;
const timeoutUserChoiceReset = document.getElementById("timeout-user-choice-reset-btn") as HTMLButtonElement;
const timeoutTestInput = document.getElementById("timeout-test") as HTMLInputElement;
const timeoutTestReset = document.getElementById("timeout-test-reset-btn") as HTMLButtonElement;

const NAV_LABELS: Record<string, { emoji: string; title: string; hint: string }> = {
  memory: { emoji: "🧠", title: "记忆", hint: "管理长期记忆与画像" },
  chat: { emoji: "💬", title: "聊天", hint: "管理聊天窗口与会话" },
  user: { emoji: "👤", title: "用户信息", hint: "编辑你的个人资料" },
  tasks: { emoji: "⏰", title: "定时任务", hint: "管理定时提醒与日程" },
  identity: { emoji: "💼", title: "职位", hint: "自定义昔涟的身份定位与工作职责" },
  skills: { emoji: "✨", title: "Skill", hint: "管理 agent 的 skill 指令（约束如何用工具）" },
  plugins: { emoji: "🔌", title: "插件", hint: "扩展功能与第三方集成" },
  preferences: { emoji: "🫧", title: "偏好设置", hint: "设置聊天窗口和输出行为的默认偏好" },
  appearance: { emoji: "🎨", title: "外观设置", hint: "调整窗口布局、界面主题与昔涟桌宠" },
  general: { emoji: "⚙️", title: "通用设置", hint: "管理窗口、音频和系统行为" },
  api: { emoji: "🔑", title: "API 设置", hint: "选择预设后只需要填写 API Key。" },
  "api-timeout": { emoji: "⌛", title: "API 超时设置", hint: "配置 API 超时时间" },
  cyrene: { emoji: "🌸", title: "昔涟设置", hint: "管理 Agent 行为、记忆、RAG 与权限" },
  tts: { emoji: "🎙️", title: "TTS 设置", hint: "语音合成与朗读偏好" },
  asr: { emoji: "🎧", title: "ASR 设置", hint: "语音识别与通话配置" },
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

function setPreferencesSaveStatus(text: string, cls?: string): void {
  preferencesSaveStatus.textContent = text;
  preferencesSaveStatus.className = "save-status";
  if (cls) preferencesSaveStatus.classList.add(cls);
}

function setAppearanceSaveStatus(text: string, cls?: string): void {
  appearanceSaveStatus.textContent = text;
  appearanceSaveStatus.className = "save-status";
  if (cls) appearanceSaveStatus.classList.add(cls);
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

function getUiThemeValue(): GeneralSettings["uiTheme"] {
  const value = uiThemeSelect.querySelector<HTMLButtonElement>(".option-block.is-active")?.dataset.theme;
  return normalizeUiTheme(value);
}

function applyOptionGroupValue(group: HTMLElement, value: string): void {
  group.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const active = button.dataset.value === value;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function getOptionGroupValue(group: HTMLElement, fallback: string): string {
  return group.querySelector<HTMLButtonElement>(".option-block.is-active")?.dataset.value ?? fallback;
}

function applyDefaultChatModeSelection(mode: DefaultChatMode): void {
  applyOptionGroupValue(defaultChatModeSelect, mode);
}

function getDefaultChatModeValue(): DefaultChatMode {
  return normalizeDefaultChatMode(getOptionGroupValue(defaultChatModeSelect, "collab"));
}

function applySegmentedOutputSelection(mode: SegmentedOutputMode): void {
  applyOptionGroupValue(segmentedOutputSelect, mode);
}

function getSegmentedOutputValue(): SegmentedOutputMode {
  return normalizeSegmentedOutputMode(getOptionGroupValue(segmentedOutputSelect, "off"));
}

function applyMobileMessageSegmentationSelection(mode: MobileMessageSegmentationMode): void {
  applyOptionGroupValue(mobileMessageSegmentationSelect, mode);
}

function getMobileMessageSegmentationValue(): MobileMessageSegmentationMode {
  return normalizeMobileMessageSegmentationMode(getOptionGroupValue(mobileMessageSegmentationSelect, "off"));
}

function applyProactiveChatSelection(mode: ProactiveChatMode): void {
  applyOptionGroupValue(proactiveChatSelect, mode);
}

function getProactiveChatValue(): ProactiveChatMode {
  return normalizeProactiveChatMode(getOptionGroupValue(proactiveChatSelect, "off"));
}

function applyProactiveDeliverySelection(target: ProactiveDeliveryTarget): void {
  applyOptionGroupValue(proactiveDeliverySelect, target);
}

function getProactiveDeliveryValue(): ProactiveDeliveryTarget {
  return normalizeProactiveDeliveryTarget(getOptionGroupValue(proactiveDeliverySelect, "local"));
}

function renderProactiveDeliveryVisibility(): void {
  proactiveDeliveryRow.hidden = getProactiveChatValue() !== "on";
}

function renderProactiveDeliveryAvailability(statuses: Record<string, { phase?: string }>): void {
  proactiveDeliverySelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const target = normalizeProactiveDeliveryTarget(button.dataset.value);
    const status = target === "local" ? undefined : statuses[target];
    button.disabled = !isProactiveDeliveryTargetSelectable(target, status);
  });
}

function applyUiThemeSelection(theme: GeneralSettings["uiTheme"]): void {
  uiThemeSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const active = button.dataset.theme === theme;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.documentElement.dataset.uiTheme = theme;
}

function renderUiFont(font: UiFont): void {
  uiFontCurrent.textContent = font.kind === "custom" ? font.displayName : "思源黑体（默认）";
  uiFontResetButton.hidden = font.kind !== "custom";
}

function getUiIconValue(): UiIcon {
  return normalizeUiIcon(uiIconSelect.querySelector<HTMLButtonElement>(".is-active")?.dataset.icon);
}

function renderUiIcon(icon: UiIcon): void {
  uiIconSelect.querySelectorAll<HTMLButtonElement>(".appearance-icon-option").forEach((button) => {
    const active = button.dataset.icon === icon;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setGeneralSaveStatus(text: string, cls?: string): void {
  generalSaveStatus.textContent = text;
  generalSaveStatus.className = "save-status";
  if (cls) generalSaveStatus.classList.add(cls);
}

function setTimeoutSaveStatus(text: string, cls?: string): void {
  timeoutSaveStatus.textContent = text;
  timeoutSaveStatus.className = "save-status";
  if (cls) timeoutSaveStatus.classList.add(cls);
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
 * 填充模型名输入框 + datalist 联想建议。
 * 模式按钮已删除——只有一个输入框，可手填，按方向键也能从厂商预设里选。
 */
function fillModelOptions(preset: ModelPreset, preferredModel?: string): void {
  // datalist 联想建议
  modelInputSuggestions.replaceChildren();
  for (const model of preset.mainModels) {
    const option = document.createElement("option");
    option.value = model;
    modelInputSuggestions.appendChild(option);
  }

  // 选中值：preferredModel 命中预设则用之；否则用预设首项；
  // preferredModel 不在预设里（用户自填型号）也保留显示，不强行清空。
  const fallback = preset.mainModels[0] ?? "";
  modelInput.value = preferredModel ?? fallback;
}

/**
 * 把"当前输入框里的值"快照到内存缓存里（perProvider）。
 * 切厂商前调用一次，避免覆盖丢失。
 */
function captureActiveProviderProfile(): void {
  if (!activeProvider) return;
  const cached = providerProfileCache[activeProvider];
  // reasoning 仍由 renderReasoningControls 写入 cache；这里只保留它（不动 mode/effort）
  providerProfileCache[activeProvider] = {
    baseUrl: baseUrlInput.value.trim(),
    model: getCurrentModelValue().trim(),
    apiKey: apiKeyInput.value.trim(),
    displayName: displayNameInput.value.trim(),
    explicitTransport: transportSelect.value as ProviderProfile["explicitTransport"],
    reasoning: cached?.reasoning,
  };
}

/** 模式按钮已删除——模型名永远从 input 读取。保留函数名供旧调用点用，语义不变。 */
function getCurrentModelValue(): string {
  return modelInput.value;
}

/**
 * 视觉同步 UI（胶囊按钮组）—— 纯 UI 状态控制，不修改输入框值。
 *
 * 三种情况：
 * 1. independentVision=true（preset 强制独立配置）：
 *    用真实 disabled 属性禁用"与主聊天模型相同"按钮；视觉框不锁（独立 = 可编辑）。
 *    直接 return，不读分支前缓存的 synced，避免重新给视觉框加 is-locked。
 * 2. 普通 provider，synced=true：视觉框加 is-locked 样式（仅 UI，不动 input.value）
 * 3. 普通 provider，synced=false：视觉框解锁
 *
 * 输入框的初值由 applyPreset 在切厂商时一次性写入，本函数不再覆盖。
 */
function applyVisionSyncUI(): void {
  const preset = findPreset(activeProvider);

  if (preset?.independentVision) {
    visionSyncMainBtn.disabled = true;
    setVisionSyncState(false);
    visionFieldsWrap.classList.remove("is-locked");
    return;
  }

  visionSyncMainBtn.disabled = false;
  const synced = visionSyncMainBtn.classList.contains("is-active");
  if (synced) {
    visionFieldsWrap.classList.add("is-locked");
  } else {
    visionFieldsWrap.classList.remove("is-locked");
  }
}

/** 填充视觉模型输入框的 datalist 候选。仅渲染候选，不修改 visionModelInput.value。 */
function fillVisionModelOptions(preset: ModelPreset): void {
  const datalist = document.getElementById("vision-model-suggestions") as HTMLDataListElement | null;
  if (!datalist) return;
  datalist.replaceChildren();
  for (const m of preset.visionModels ?? []) {
    const option = document.createElement("option");
    option.value = m;
    datalist.appendChild(option);
  }
}

/** 切换视觉同步胶囊按钮的激活态。synced=true 激活"与主相同"，false 激活"独立配置"。 */
function setVisionSyncState(synced: boolean): void {
  visionSyncMainBtn.classList.toggle("is-active", synced);
  visionSyncMainBtn.setAttribute("aria-pressed", String(synced));
  visionSyncIndepBtn.classList.toggle("is-active", !synced);
  visionSyncIndepBtn.setAttribute("aria-pressed", String(!synced));
}

function applyPreset(
  providerName: string,
  preferredModel?: string,
  preferredApiKey?: string,
  preferredBaseUrl?: string,
  preferredDisplayName?: string,
  preferredExplicitTransport?: "openai" | "anthropic" | "auto",
  preferredVision?: { baseUrl: string; apiKey: string; model: string; syncWithMain: boolean },
): void {
  const preset = findPreset(providerName);

  // 模式按钮已删除——ChatGPT / Claude 这种没预设型号的厂商，input 框空着让用户手填，
  // datalist 没建议也不影响（用户知道自己型号）。

  presetSelect.value = preset.providerName;

  // 昵称：优先用传入的（用户自定义过）；否则用厂商 shortName 作默认。
  // 留空显示厂商短名——但这里主动填 shortName 让用户看到默认值，可改可清。
  displayNameInput.value = preferredDisplayName ?? preset.shortName;

  // baseUrl：优先用缓存（用户自定义过），其次用 preset 默认
  baseUrlInput.value = preferredBaseUrl ?? preset.baseUrl;

  fillModelOptions(preset, preferredModel);

  // apiKey：优先用缓存；否则**显式清空**——避免上一家厂商的 key 残留在输入框里被用户误点保存。
  // 这是 v1 切厂商行为里的关键不变量：apiKey 永远只跟当前厂商绑定。
  apiKeyInput.value = preferredApiKey ?? "";

  // explicitTransport：优先用缓存（用户自定义过），其次默认 "auto"
  // （切厂商时上一家的 explicitTransport 不应该延续，preset 自带 capabilities transport 兜底）
  transportSelect.value = preferredExplicitTransport ?? "auto";

  // —— 视觉字段初始化（一次性写入，避免反复覆盖用户编辑）——
  // 优先级：preferredVision（已保存） > preset 默认
  // 关键：independentVision=true 时，即使旧配置保存了 syncWithMain=true，
  // 也统一归一化为 false（与 applyVisionSyncUI 的"独立配置态"一致）。
  if (preferredVision) {
    const synced = preset.independentVision === true ? false : preferredVision.syncWithMain;
    setVisionSyncState(synced);
    visionBaseUrlInput.value = preferredVision.baseUrl;
    visionApiKeyInput.value = preferredVision.apiKey;
    visionModelInput.value = preferredVision.model;
  } else if (preset.independentVision === true) {
    // 强制独立配置态
    setVisionSyncState(false);
    visionBaseUrlInput.value = preset.visionBaseUrl ?? preset.baseUrl;
    visionApiKeyInput.value = apiKeyInput.value;
    visionModelInput.value = preset.defaultVisionModel ?? "";
  } else {
    // 默认同步主模型
    setVisionSyncState(preset.supportsVision === true);
    visionBaseUrlInput.value = preset.visionBaseUrl ?? baseUrlInput.value;
    visionApiKeyInput.value = apiKeyInput.value;
    visionModelInput.value = modelInput.value;
  }

  fillVisionModelOptions(preset);

  // 官网链接：有 websiteUrl 就显示并指向，没有就隐藏。
  if (preset.websiteUrl) {
    presetWebsiteLink.href = preset.websiteUrl;
    presetWebsiteLink.title = `前往 ${preset.shortName} 官网`;
    presetWebsiteLink.style.display = "";
  } else {
    presetWebsiteLink.style.display = "none";
  }

  activeProvider = preset.providerName;
  applyVisionSyncUI();
}

async function loadConfig(): Promise<void> {
  try {
    fillPresetOptions();
    const cfg = await window.settings!.getConfig();
    // 模式按钮已删除——mode 字段不再用 UI 控制，直接忽略 cfg.mode
    // 把 main 进程返回的 perProvider 灌进渲染端内存缓存，切厂商时用到
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
            reasoning: (value as { reasoning?: ReasoningPreference }).reasoning,
          };
        }
      }
    }
    const vision = cfg.vision;
    applyPreset(
      cfg.provider,
      cfg.model,
      cfg.apiKey,
      cfg.baseUrl,
      cfg.displayName,
      cfg.explicitTransport,
      vision
        ? {
            baseUrl: vision.baseUrl,
            apiKey: vision.apiKey,
            model: vision.model,
            syncWithMain: vision.syncWithMain,
          }
        : undefined,
    );
    applyRuntimeSyncSelection(cfg.runtimeSync);
    stickerEnabledInput.checked = cfg.stickerEnabled !== false;
    applyStickerSizeSelection(cfg.stickerSize);
    const threshold = cfg.stickerSimilarityThreshold ?? 0.55;
    stickerThresholdInput.value = String(threshold);
    stickerThresholdVal.textContent = threshold.toFixed(2);

    // 视觉模型配置已并入 applyPreset（preferredVision 参数）。

    setSaveStatus("等待保存");
    setCyreneSaveStatus("等待保存");
  } catch {
    fillPresetOptions();
    // 默认厂商已从 DeepSeek 改为 MiniMax（v1 vendor adapter 第一家落地的）
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
    petZoomInput.value = String(cfg.petZoom ?? 1);
    petZoomVal.textContent = Math.round((cfg.petZoom ?? 1) * 100) + "%";
    disableGpuInput.checked = cfg.disableGpuElectron ?? false;
    sidebarVisibleInput.checked = cfg.sidebarVisible ?? true;
    tasksVisibleInput.checked = cfg.tasksVisible ?? true;
    launchAtLoginInput.checked = cfg.launchAtLogin;
    applyUiThemeSelection(normalizeUiTheme(cfg.uiTheme));
    renderUiFont(normalizeUiFont(cfg.uiFont));
    renderUiIcon(normalizeUiIcon(cfg.uiIcon));
    applyDefaultChatModeSelection(normalizeDefaultChatMode(cfg.defaultChatMode));
    applySegmentedOutputSelection(normalizeSegmentedOutputMode(cfg.segmentedOutputMode));
    applyMobileMessageSegmentationSelection(normalizeMobileMessageSegmentationMode(cfg.mobileMessageSegmentation));
    applyProactiveChatSelection(normalizeProactiveChatMode(cfg.proactiveChatMode));
    applyProactiveDeliverySelection(normalizeProactiveDeliveryTarget(cfg.proactiveDeliveryTarget));
    renderProactiveDeliveryVisibility();
    void window.settings!.channelsGetStatus()
      .then((status: unknown) => renderProactiveDeliveryAvailability(status as Record<string, { phase?: string }>))
      .catch(() => renderProactiveDeliveryAvailability({}));
    applyLanguageSelection("zh-CN");
    setPreferencesSaveStatus("等待保存");
    setAppearanceSaveStatus("等待保存");
    setGeneralSaveStatus("等待保存");
  } catch {
    setPreferencesSaveStatus("读取偏好失败", "is-error");
    setAppearanceSaveStatus("读取外观失败", "is-error");
    setGeneralSaveStatus("读取设置失败", "is-error");
  }
}

async function loadTimeoutSettings() {
  try {
    const cfg = await window.settings!.getTimeoutSettings();
    timeoutChatRequestInput.value = String(cfg.chatRequestTimeout);
    timeoutPerRoundInput.value = String(cfg.perRoundTimeout);
    timeoutSummaryInput.value = String(cfg.forceSummaryTimeout);
    timeoutVisionInput.value = String(cfg.visionTimeout);
    timeoutUserChoiceInput.value = String(cfg.userChoiceTimeout);
    timeoutTestInput.value = String(cfg.testTimeout);
    setTimeoutSaveStatus("此页需要保存才可生效．");
  } catch {
    setTimeoutSaveStatus("读取偏好失败", "is-error");
  }
}

function parsePositiveIntOrThrow(input: string, th: any) {
  if (!/^[0-9]+$/.test(input)){
    throw th;
  }
  if (isNaN(input as any)){
    throw th;
  }
  const result = parseInt(input);
  if (Number.isNaN(result) || result <= 0) {
    throw th;
  }
  return result;
}

async function saveTimeoutSettings(saveTestTimeout: boolean) {
  let settings: Partial<TimeoutSettings>;
  try {
    if (!saveTestTimeout) {
      settings = {
        perRoundTimeout: parsePositiveIntOrThrow(timeoutPerRoundInput.value, "工具阶段单次 API 超时"),
        forceSummaryTimeout: parsePositiveIntOrThrow(timeoutSummaryInput.value, "总结阶段单次 API 超时"),
        chatRequestTimeout: parsePositiveIntOrThrow(timeoutChatRequestInput.value, "单次回复总时间限制"),
        visionTimeout: parsePositiveIntOrThrow(timeoutVisionInput.value, "视觉模型单次 API 超时"),
        userChoiceTimeout: parsePositiveIntOrThrow(timeoutUserChoiceInput.value, "工具请求确认时间限制"),
      };
    } else {
      settings = {
        testTimeout: parsePositiveIntOrThrow(timeoutTestInput.value, "测试超时"),
      };
    }
  } catch (e) {
    if (saveTestTimeout) {
      setSaveStatus("无效输入：" + e, "is-error");
    } else {
      setTimeoutSaveStatus("无效输入：" + e, "is-error");
    }
    return false;
  }
  try {
    await window.settings!.saveTimeoutSettings(settings);
    if (saveTestTimeout) {
      setSaveStatus("已保存", "is-ok");
    } else {
      setTimeoutSaveStatus("已保存", "is-ok");
    }
    return true;
  } catch {
    if (saveTestTimeout) {
      setSaveStatus("保存失败", "is-error");
    } else {
      setTimeoutSaveStatus("保存失败", "is-error");
    }
  }
  return false;
}

timeoutTestReset.addEventListener("click", () => { timeoutTestInput.value = "15000" });
timeoutChatRequestReset.addEventListener("click", () => { timeoutChatRequestInput.value = String(DEFAULT_CHAT_REQUEST_TIMEOUT_MS) });
timeoutPerRoundReset.addEventListener("click", () => { timeoutPerRoundInput.value = String(DEFAULT_PER_ROUND_TIMEOUT_MS) });
timeoutSummaryReset.addEventListener("click", () => { timeoutSummaryInput.value = String(DEFAULT_FORCE_SUMMARY_TIMEOUT_MS) });
timeoutVisionReset.addEventListener("click", () => { timeoutVisionInput.value = String(DEFAULT_VISION_TIMEOUT_MS) });
timeoutUserChoiceReset.addEventListener("click", () => { timeoutUserChoiceInput.value = "60000" });

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

openChromeGpu.addEventListener("click", () => {
  window.settings?.openChromeGpu();
});

disableGpuInput.addEventListener("change", () => {
  void window.settings?.saveGeneral({ disableGpuElectron: disableGpuInput.checked });
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

petAlwaysOnTopInput.addEventListener("change", () => {
  window.settings?.setPetAlwaysOnTop(petAlwaysOnTopInput.checked);
  setAppearanceSaveStatus("已应用", "is-ok");
});

uiFontImportButton.addEventListener("click", async () => {
  try {
    const sourcePath = await window.settings?.pickUiFont();
    if (!sourcePath) return;
    uiFontImportButton.disabled = true;
    setAppearanceSaveStatus("正在导入字体…");
    const font = await window.settings!.importUiFont(sourcePath);
    renderUiFont(font);
    setAppearanceSaveStatus("字体已应用", "is-ok");
  } catch (error) {
    console.error("导入字体失败:", error);
    setAppearanceSaveStatus("导入字体失败", "is-error");
  } finally {
    uiFontImportButton.disabled = false;
  }
});

uiFontResetButton.addEventListener("click", async () => {
  try {
    uiFontResetButton.disabled = true;
    const font = await window.settings!.resetUiFont();
    renderUiFont(font);
    setAppearanceSaveStatus("已恢复思源黑体", "is-ok");
  } catch (error) {
    console.error("恢复默认字体失败:", error);
    setAppearanceSaveStatus("恢复默认字体失败", "is-error");
  } finally {
    uiFontResetButton.disabled = false;
  }
});

uiIconSelect.querySelectorAll<HTMLButtonElement>(".appearance-icon-option").forEach((button) => {
  button.addEventListener("click", async () => {
    const icon = normalizeUiIcon(button.dataset.icon);
    try {
      await window.settings!.saveGeneral({ uiIcon: icon });
      renderUiIcon(icon);
      setAppearanceSaveStatus("图标已应用", "is-ok");
    } catch (error) {
      console.error("应用图标失败:", error);
      setAppearanceSaveStatus("应用图标失败", "is-error");
    }
  });
});

petVisibleInput.addEventListener("change", () => {
  window.settings?.setPetVisible(petVisibleInput.checked);
  setAppearanceSaveStatus("已应用", "is-ok");
});
petZoomInput.addEventListener("input", () => {
  petZoomVal.textContent = Math.round(Number(petZoomInput.value) * 100) + "%";
});
petZoomInput.addEventListener("change", () => {
  window.settings?.setPetZoom(Number(petZoomInput.value));
  setAppearanceSaveStatus("已应用", "is-ok");
});

uiThemeSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    const theme = normalizeUiTheme(button.dataset.theme);
    applyUiThemeSelection(theme);
    setAppearanceSaveStatus("有未保存的更改");
  });
});

defaultChatModeSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    applyDefaultChatModeSelection(normalizeDefaultChatMode(button.dataset.value));
    setPreferencesSaveStatus("有未保存的更改");
  });
});

segmentedOutputSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    applySegmentedOutputSelection(normalizeSegmentedOutputMode(button.dataset.value));
    setPreferencesSaveStatus("有未保存的更改");
  });
});

mobileMessageSegmentationSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    applyMobileMessageSegmentationSelection(normalizeMobileMessageSegmentationMode(button.dataset.value));
    setPreferencesSaveStatus("有未保存的更改");
  });
});

proactiveChatSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    applyProactiveChatSelection(normalizeProactiveChatMode(button.dataset.value));
    renderProactiveDeliveryVisibility();
    setPreferencesSaveStatus("有未保存的更改");
  });
});

proactiveDeliverySelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    applyProactiveDeliverySelection(normalizeProactiveDeliveryTarget(button.dataset.value));
    setPreferencesSaveStatus("有未保存的更改");
  });
});

preferencesForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setPreferencesSaveStatus("保存中…");
  try {
    await window.settings!.saveGeneral({
      defaultChatMode: getDefaultChatModeValue(),
      segmentedOutputMode: getSegmentedOutputValue(),
      mobileMessageSegmentation: getMobileMessageSegmentationValue(),
      proactiveChatMode: getProactiveChatValue(),
      proactiveDeliveryTarget: getProactiveDeliveryValue(),
    });
    setPreferencesSaveStatus("已保存", "is-ok");
  } catch {
    setPreferencesSaveStatus("保存失败", "is-error");
  }
});

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

// ── 添加表情包弹窗 ──
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
  stickerAddFileName.textContent = "未选择";
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
    stickerAddError.textContent = "请先选择图片文件";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const id = stickerAddId.value.trim();
  if (!id) {
    stickerAddError.textContent = "请填写英文名称";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    stickerAddError.textContent = "名称只能用英文字母、数字、下划线和连字符";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const description = stickerAddDesc.value.trim();
  if (!description) {
    stickerAddError.textContent = "请填写图片描述";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const phrases = stickerAddPhrases.value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (phrases.length === 0) {
    stickerAddError.textContent = "请至少写一行相近语义";
    stickerAddError.classList.remove("is-hidden");
    return;
  }

  try {
    await window.settings?.stickerAdd?.({ sourcePath: stickerAddPickedPath, id, description, phrases });
    closeStickerAddModal();
  } catch (err) {
    stickerAddError.textContent = "添加失败：" + (err as Error).message;
    stickerAddError.classList.remove("is-hidden");
  }
});

// ── 插件开关事件 ──────────────────────────────────────────
// 文档检索/用户记忆/世界书/联网搜索为常驻工具，无开关，显示绿灯。
// 天气查询/联网搜索有独立配置卡片（下方）。

// ── 天气插件（Open-Meteo / 高德天气）──
const weatherEnabledCheckbox = document.getElementById("plugin-weather-enabled") as HTMLInputElement | null;
const weatherConfig = document.getElementById("plugin-weather-config") as HTMLElement | null;
const weatherSourceSelect = document.getElementById("weather-source") as HTMLSelectElement | null;
const amapFields = document.getElementById("amap-fields");
const amapKeyInput = document.getElementById("amap-key") as HTMLInputElement | null;

// 启用开关：勾上才展开配置区
function syncWeatherConfigVisibility(): void {
  if (weatherConfig) weatherConfig.style.display = weatherEnabledCheckbox?.checked ? "block" : "none";
  syncWeatherFieldsVisibility();
}
function syncWeatherFieldsVisibility(): void {
  const src = weatherSourceSelect?.value ?? "open-meteo";
  // 选高德才显示高德 Key 输入框
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
// 防抖保存：粘贴后 800ms 自动保存
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
    console.warn("[plugins] 保存天气配置失败:", field, err);
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
    console.warn("[plugins] 加载天气配置失败", err);
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
  // 存到同一个 amapKey 字段（与天气查询共用）
  void saveTravelField("amapKey", travelAmapKeyInput.value.trim());
});
// 防抖保存：粘贴后 800ms 自动保存
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
    console.warn("[plugins] 保存出行配置失败:", field, err);
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
    console.warn("[plugins] 加载出行配置失败", err);
  }
}
void loadTravelConfig();

// ── ✉️邮件发送插件 ──
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

// 防抖保存：每个字段独立 timer，避免连续填写多个字段时只有最后一个被保存
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
    console.warn("[plugins] 保存邮件配置失败:", field, err);
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
    console.warn("[plugins] 加载邮件配置失败", err);
  }
}
void loadEmailConfig();

// ── 🎧ASR 设置 ──
const asrEngineSelect = document.getElementById("asr-engine") as HTMLSelectElement | null;
const asrAliyunConfig = document.getElementById("asr-aliyun-config");
const asrAliyunAppKeyInput = document.getElementById("asr-aliyun-app-key") as HTMLInputElement | null;
const asrAliyunAccessKeyIdInput = document.getElementById("asr-aliyun-access-key-id") as HTMLInputElement | null;
const asrAliyunAccessKeySecretInput = document.getElementById("asr-aliyun-access-key-secret") as HTMLInputElement | null;
const asrLanguageSelect = document.getElementById("asr-language") as HTMLSelectElement | null;
const asrVadSilenceInput = document.getElementById("asr-vad-silence") as HTMLInputElement | null;
const asrVadThresholdInput = document.getElementById("asr-vad-threshold") as HTMLInputElement | null;
const asrVadThresholdValue = document.getElementById("asr-vad-threshold-value");
const asrShowTranscriptCheckbox = document.getElementById("asr-show-transcript") as HTMLInputElement | null;

function syncAsrVisibility(): void {
  if (asrAliyunConfig) {
    (asrAliyunConfig as HTMLElement).style.display = asrEngineSelect?.value === "aliyun" ? "block" : "none";
  }
}

asrEngineSelect?.addEventListener("change", () => {
  syncAsrVisibility();
  void saveAsrField("asrEngine", asrEngineSelect.value);
});
// 防抖保存：每个字段独立 timer，避免连续填写多个字段时只有最后一个被保存
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
asrVadThresholdInput?.addEventListener("input", () => {
  const v = Number(asrVadThresholdInput.value) || 0.01;
  if (asrVadThresholdValue) asrVadThresholdValue.textContent = String(v);
  void saveAsrField("asrVadThreshold", v);
});
asrShowTranscriptCheckbox?.addEventListener("change", () => void saveAsrField("asrShowTranscript", asrShowTranscriptCheckbox.checked));

async function saveAsrField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[asr] 保存 ASR 配置失败:", field, err);
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
      if (asrVadThresholdInput) {
        const v = Number(cfg.asrVadThreshold) || 0.01;
        asrVadThresholdInput.value = String(v);
        if (asrVadThresholdValue) asrVadThresholdValue.textContent = String(v);
      }
      if (asrShowTranscriptCheckbox) asrShowTranscriptCheckbox.checked = Boolean(cfg.asrShowTranscript);
    }
    syncAsrVisibility();
  } catch (err) {
    console.warn("[asr] 加载 ASR 配置失败", err);
  }
}
void loadAsrConfig();

// ── 联网搜索插件（博查/Tavily/火山/MiniMax）──
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
  // 开关变化时，若开启则把 searchEngine 从 off 改成第一个有 key 的源（或 bocha）
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

// 各源 key 输入：失焦保存 + 输入时防抖保存（防粘贴后未失焦就丢失）
const searchKeyDebounceTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
for (const [engine, input] of Object.entries(SEARCH_KEY_INPUT_MAP)) {
  if (!input) continue;
  const field = SEARCH_KEY_FIELD_MAP[engine];
  input.addEventListener("change", () => { void saveSearchField(field, input.value.trim()); });
  input.addEventListener("blur", () => { void saveSearchField(field, input.value.trim()); });
  // 输入时防抖保存：粘贴或打字后 800ms 自动保存，不依赖失焦
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
    console.warn("[plugins] 保存搜索配置失败:", field, err);
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
    // 开关状态：engine 不是 off 就算启用
    if (searchEnabledCheckbox) searchEnabledCheckbox.checked = engine !== "off";
    syncSearchConfigVisibility();
  } catch (err) {
    console.warn("[plugins] 加载搜索配置失败", err);
  }
}
void loadSearchConfig();

// ── 🌐 内置 MCP 工具开关 ──────────────────────────────────────
// Playwright MCP（浏览器自动化）通过 playwrightMcpEnabled 控制，
// main 端的 syncPlaywrightMcp() 会监听字段变化自动注册 / 移除 MCP server。
const playwrightMcpCheckbox = document.getElementById("plugin-playwright-mcp-enabled") as HTMLInputElement | null;

async function saveBuiltinMcpField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn(`[settings] 保存 ${field} 失败:`, err);
  }
}

playwrightMcpCheckbox?.addEventListener("change", () => {
  void saveBuiltinMcpField("playwrightMcpEnabled", playwrightMcpCheckbox.checked);
});

async function loadBuiltinMcpToggles(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg && playwrightMcpCheckbox) {
      // 默认关闭 —— 启用会下载 Chromium，约 150MB
      playwrightMcpCheckbox.checked = Boolean(cfg.playwrightMcpEnabled);
    }
  } catch (err) {
    console.warn("[settings] 加载内置 MCP 开关失败:", err);
  }
}
void loadBuiltinMcpToggles();

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

clearChatHistoryBtn.addEventListener("click", async () => {
  if (!window.confirm("清空所有聊天会话？\n此操作会删除全部历史对话，无法恢复。")) return;
  try {
    const sessions = await window.chatStore?.list();
    if (sessions && sessions.length > 0) {
      // 串行删除（store 不支持批量删除；会话数量不会大，可接受）
      for (const s of sessions) {
        await window.chatStore?.delete(s.id);
      }
    }
    setGeneralSaveStatus("所有聊天会话已清空", "is-ok");
  } catch (err) {
    console.warn("[settings] 清空聊天会话失败:", err);
    setGeneralSaveStatus("清空失败，请查看终端日志", "is-error");
  }
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
    cached?.displayName,
    cached?.explicitTransport,
  );
  setSaveStatus(cached ? "已切回上次配置" : "已应用预设，填写 API Key 后保存");
});

// 测试连接按钮：调用厂商 adapter 的真实连接测试
if (testConnectionBtn) {
  testConnectionBtn.addEventListener("click", async () => {
    const provider = activeProvider;
    const baseUrl = baseUrlInput.value;
    const model = getCurrentModelValue().trim();
    const apiKey = apiKeyInput.value;
    if (!model) { setSaveStatus("请先选择/填写模型再测试", "is-error"); return; }
    if (!await saveTimeoutSettings(true)) {
      return;
    }
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
// 胶囊按钮组：[与主聊天模型相同] / [独立配置]
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

// 主配置变化时，若处于"与主相同"，联动更新视觉三框。
// baseUrl 用 visionBaseUrl（若有），其他直接复制。
baseUrlInput.addEventListener("input", () => {
  if (!isVisionSynced()) return;
  const preset = findPreset(presetSelect.value);
  visionBaseUrlInput.value = preset?.visionBaseUrl || baseUrlInput.value;
});
apiKeyInput.addEventListener("input", () => { if (isVisionSynced()) visionApiKeyInput.value = apiKeyInput.value; });
modelInput.addEventListener("input", () => {
  if (isVisionSynced()) visionModelInput.value = modelInput.value;
});

// Base URL 重置按钮：一键复原厂商默认 baseUrl
baseUrlResetBtn.addEventListener("click", () => {
  const preset = findPreset(presetSelect.value);
  if (preset) {
    baseUrlInput.value = preset.baseUrl;
    setSaveStatus("已重置为厂商默认 URL");
  }
});

// 测试视觉模型按钮
testVisionBtn.addEventListener("click", async () => {
  const synced = isVisionSynced();
  const baseUrl = synced ? baseUrlInput.value : visionBaseUrlInput.value;
  const apiKey = synced ? apiKeyInput.value : visionApiKeyInput.value;
  const model = synced ? getCurrentModelValue() : visionModelInput.value;
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
  if (Number.isNaN(date.getTime())) return "时间无效";
  return date.toLocaleString();
}

function describeSchedule(schedule: ScheduleConfig): string {
  if (schedule.kind === "once") return "仅一次 " + formatSchedulerDate(schedule.runAt);
  if (schedule.kind === "daily") return "每天 " + schedule.timeOfDay;
  if (schedule.kind === "weekly") {
    const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return `${names[schedule.dayOfWeek]} ${schedule.timeOfDay}`;
  }
  return `每隔 ${schedule.every} ${schedule.unit === "minutes" ? "分钟" : "小时"}`;
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
      badge.textContent = task.enabled ? "已启用" : "已停用";
      badge.classList.toggle("is-disabled", !task.enabled);
    }
    const meta = card.querySelector(".scheduler-card__meta");
    if (meta) meta.textContent = `${describeSchedule(task.schedule)} · 下次运行：${formatSchedulerDate(task.nextFireAt)} · 工具：${task.toolMode === "all-enabled" ? "全部已启用工具" : task.allowedToolIds.join(", ") || "无"}`;
    const actions = card.querySelector(".scheduler-card__actions") as HTMLDivElement | null;
    if (actions) {
      const fireBtn = document.createElement("button");
      fireBtn.type = "button";
      fireBtn.className = "ghost-btn";
      fireBtn.textContent = "立即运行";
      fireBtn.addEventListener("click", () => void fireSchedulerTask(task.id));
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "ghost-btn";
      editBtn.textContent = "编辑";
      editBtn.addEventListener("click", () => void openSchedulerEditor(task));
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "ghost-btn";
      toggleBtn.textContent = task.enabled ? "停用" : "启用";
      toggleBtn.addEventListener("click", () => void toggleSchedulerTask(task.id, !task.enabled));
      const historyBtn = document.createElement("button");
      historyBtn.type = "button";
      historyBtn.className = "ghost-btn";
      historyBtn.textContent = "历史";
      historyBtn.addEventListener("click", () => void toggleSchedulerHistory(task.id, card));
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "ghost-btn";
      deleteBtn.textContent = "删除";
      deleteBtn.addEventListener("click", () => void deleteSchedulerTask(task.id));
      actions.append(fireBtn, editBtn, toggleBtn, historyBtn, deleteBtn);
    }
    schedulerList.appendChild(card);
  }
}

apiTimeoutForm.addEventListener("submit", (e) => {
  e.preventDefault();
  setTimeoutSaveStatus("保存中…");
  saveTimeoutSettings(false);
});

appearanceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setAppearanceSaveStatus("保存中…");
  try {
    await window.settings!.saveGeneral(buildAppearanceSettingsPatch({
      uiTheme: getUiThemeValue(),
      uiIcon: getUiIconValue(),
      petAlwaysOnTop: petAlwaysOnTopInput.checked,
      petVisible: petVisibleInput.checked,
      petZoom: Number(petZoomInput.value),
    }));
    setAppearanceSaveStatus("已保存", "is-ok");
  } catch {
    setAppearanceSaveStatus("保存失败", "is-error");
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
      disableGpuElectron: disableGpuInput.checked,
      sidebarVisible: sidebarVisibleInput.checked,
      tasksVisible: tasksVisibleInput.checked,
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
    await window.settings!.saveConfig({ runtimeSync: getRuntimeSyncValue(), stickerEnabled: stickerEnabledInput.checked, stickerSize: getStickerSizeValue(), stickerSimilarityThreshold: parseFloat(stickerThresholdInput.value) });
    setCyreneSaveStatus("已保存", "is-ok");
  } catch {
    setCyreneSaveStatus("保存失败", "is-error");
  }
});

apiForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setSaveStatus("保存中…");
  try {
    if (!await saveTimeoutSettings(true)) {
      return;
    }
    // 保存前把当前输入快照进 perProvider 缓存（main 进程也会做一次，但渲染端先做一遍，
    // 是为了下一次切厂商再切回来不依赖磁盘往返）
    captureActiveProviderProfile();
    // mode 字段在 UI 层已删除，但仍传给 main 进程保留向后兼容（旧配置文件可能有该字段）。
    // 默认 "manual"（baseUrl 永远可改、模型名永远可填，行为等同原 Manual）。
    await window.settings!.saveConfig({
      mode: "manual",
      provider: activeProvider,
      displayName: displayNameInput.value.trim(),
      baseUrl: baseUrlInput.value.trim(),
      model: getCurrentModelValue().trim(),
      apiKey: apiKeyInput.value.trim(),
      explicitTransport: transportSelect.value as "openai" | "anthropic" | "auto",
      reasoning: providerProfileCache[activeProvider]?.reasoning,
      vision: {
        syncWithMain: isVisionSynced(),
        // syncWithMain=true 时三字段传空（main 进程不落盘，运行时从主配置读）
        baseUrl: isVisionSynced() ? "" : visionBaseUrlInput.value.trim(),
        apiKey: isVisionSynced() ? "" : visionApiKeyInput.value.trim(),
        model: isVisionSynced() ? "" : visionModelInput.value.trim(),
      },
    });
    setSaveStatus("已保存", "is-ok");
  } catch {
    setSaveStatus("保存失败", "is-error");
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
  // 确保工具列表已加载
  if (schedulerTools.length === 0) {
    const toolsResult = await window.cyreneScheduler!.getTools();
    if (toolsResult.ok) schedulerTools = toolsResult.value ?? [];
  }
  if (schedulerEditorTitle) schedulerEditorTitle.textContent = task ? "编辑定时任务" : "新建定时任务";
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
    if (!value) throw new Error("请选择一次性运行时间");
    const runAt = new Date(value);
    if (Number.isNaN(runAt.getTime())) throw new Error("一次性运行时间无效");
    if (runAt.getTime() <= Date.now()) throw new Error("一次性任务时间必须晚于当前时间");
    return { kind: "once", runAt: runAt.toISOString() };
  }
  if (kind === "weekly") {
    const timeOfDay = schedulerTimeOfDayInput?.value || "08:00";
    if (!isValidTimeOfDay(timeOfDay)) throw new Error("每周时间格式必须是 HH:mm");
    const dayOfWeek = Number(schedulerDayOfWeekInput?.value ?? 1);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new Error("星期必须是周一到周日");
    return { kind: "weekly", dayOfWeek: dayOfWeek as 0 | 1 | 2 | 3 | 4 | 5 | 6, timeOfDay };
  }
  if (kind === "interval") {
    const every = Number(schedulerIntervalEveryInput?.value ?? 1);
    const unit = schedulerIntervalUnitInput?.value === "hours" ? "hours" : "minutes";
    if (!Number.isInteger(every) || every <= 0) throw new Error("间隔必须是正整数");
    if (unit === "minutes" && every > 1440) throw new Error("分钟间隔不能超过 1440");
    if (unit === "hours" && every > 168) throw new Error("小时间隔不能超过 168");
    return { kind: "interval", every, unit };
  }
  const timeOfDay = schedulerTimeOfDayInput?.value || "08:00";
  if (!isValidTimeOfDay(timeOfDay)) throw new Error("每日时间格式必须是 HH:mm");
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
    if (!title) throw new Error("标题不能为空");
    if (!prompt) throw new Error("提示词不能为空");
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
    if (!result.ok) throw new Error(result.error ?? "保存失败");
    await loadSchedulerPanel();
    closeSchedulerEditor();
  } catch (err) {
    setSchedulerStatus(err instanceof Error ? err.message : String(err), "is-error");
  }
}

async function toggleSchedulerTask(id: string, enabled: boolean): Promise<void> {
  const result = await window.cyreneScheduler!.toggle(id, enabled);
  if (!result.ok) window.alert(result.error ?? "切换失败");
  await loadSchedulerPanel();
}

async function fireSchedulerTask(id: string): Promise<void> {
  const result = await window.cyreneScheduler!.fireNow(id);
  if (!result.ok) window.alert(result.reason === "task already running" ? "该任务正在运行中" : (result.error ?? result.reason ?? "立即运行失败"));
}

async function deleteSchedulerTask(id: string): Promise<void> {
  const ok = await showModal({ title: "删除定时任务", message: "确定删除这个定时任务吗？", icon: "🗑️", confirmText: "删除" });
  if (!ok) return;
  const result = await window.cyreneScheduler!.delete(id);
  if (!result.ok) window.alert(result.error ?? "删除失败");
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
    box.textContent = result.ok ? "暂无运行历史" : (result.error ?? "读取历史失败");
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
  const isApiTimeout = section === "api-timeout";
  const isAppearance = section === "appearance";
  const isGeneral = section === "general";
  const isPreferences = section === "preferences";
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
  const isChannels = section === "channels";
  const isTts = section === "tts";
  const isAsr = section === "asr";
  const isMusic = section === "music";
  apiForm.classList.toggle("is-hidden", !isApi);
  apiTimeoutForm.classList.toggle("is-hidden", !isApiTimeout);
  appearanceForm.classList.toggle("is-hidden", !isAppearance);
  generalForm.classList.toggle("is-hidden", !isGeneral);
  preferencesForm.classList.toggle("is-hidden", !isPreferences);
  cyrenePanel.classList.toggle("is-hidden", !isCyrene);
  disclaimerPanel.classList.toggle("is-hidden", !isDisclaimer);
  const memoryPanel = document.getElementById("memory-panel");
  if (memoryPanel) memoryPanel.classList.toggle("is-hidden", !isMemory);
  const userPanel = document.getElementById("user-panel");
  if (userPanel) userPanel.classList.toggle("is-hidden", !isUser);
  const chatPanel = document.getElementById("chat-panel");
  if (chatPanel) chatPanel.classList.toggle("is-hidden", !isChat);
  // 切到 💬 聊天面板时拉一次列表（cross-window 变化由 onChanged 监听器自己刷新）
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
  const channelsPanel = document.getElementById("channels-panel");
  if (channelsPanel) channelsPanel.classList.toggle("is-hidden", !isChannels);
  if (isChannels) void loadChannelsPanel();
  const ttsPanel = document.getElementById("tts-panel");
  if (ttsPanel) ttsPanel.classList.toggle("is-hidden", !isTts);
  const asrPanel = document.getElementById("asr-panel");
  if (asrPanel) asrPanel.classList.toggle("is-hidden", !isAsr);
  const musicPanel = document.getElementById("music-panel");
  if (musicPanel) musicPanel.classList.toggle("is-hidden", !isMusic);
  if (isMusic) void loadMusicPanel();
  else disposeMusicPanel();
  placeholderPanel.classList.toggle(
    "is-hidden",
    isApi || isApiTimeout || isAppearance || isGeneral || isPreferences || isCyrene || isDisclaimer || isMemory || isUser || isChat || isTasks || isIdentity || isPlugins || isSkills || isTokens || isChannels || isTts || isAsr || isMusic,
  );

  if (
    !isApi &&
    !isApiTimeout &&
    !isAppearance &&
    !isGeneral &&
    !isPreferences &&
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
    !isChannels &&
    !isTts &&
    !isAsr &&
    !isMusic
  ) {
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

schedulerNewBtn?.addEventListener("click", () => void openSchedulerEditor());
schedulerEditorClose?.addEventListener("click", closeSchedulerEditor);
schedulerCancelBtn?.addEventListener("click", closeSchedulerEditor);
schedulerSaveBtn?.addEventListener("click", () => void saveSchedulerTask());
schedulerKindInput?.addEventListener("change", updateSchedulerConditionalFields);
schedulerToolLimitInput?.addEventListener("change", updateSchedulerConditionalFields);
updateSchedulerConditionalFields();

// ===== 游戏代肝插件卡（在 plugins 面板里，MCP 下、生活工具上）=====
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
        ? "已就位参考图：" + refs.map((r) => "<code>" + r + "</code>").join(" ")
        : "（目录还没有参考图，把裁好的小图按命名放进上方目录）";
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

  // 胶囊开关：开/关时保存 enabled 并显隐配置区
  enabledCb.addEventListener("change", async () => {
    configEl.style.display = enabledCb.checked ? "block" : "none";
    await gb.saveConfig({ enabled: enabledCb.checked });
  });

  // 配置项失焦即存
  const saveFields = () => gb.saveConfig({
    exePath: exe.value.trim(),
    activeRecipe: recipeSel.value,
    vlm: { baseUrl: url.value.trim(), apiKey: key.value.trim(), model: model.value.trim() },
  });
  for (const el of [exe, url, key, model]) el.addEventListener("change", () => void saveFields());
  recipeSel.addEventListener("change", () => { currentRecipe = recipeSel.value; void saveFields().then(refreshRefs); });

  startBtn?.addEventListener("click", async () => {
    const r = await gb.start();
    appendLog(r.ok ? "代肝已启动" : "启动失败: " + (r.error ?? ""));
  });
  stopBtn?.addEventListener("click", () => { void gb.stop(); appendLog("已请求停止"); });

  gb.onProgress((info) => {
    const i = info as { index: number; total: number; desc: string };
    appendLog(i.desc + (i.index >= 0 ? " (" + (i.index + 1) + "/" + i.total + ")" : ""));
  });

  void refresh();
}

initGameBotPluginCard();
void loadConfig();
void loadGeneralSettings();
void loadTimeoutSettings();
window.settings?.onChannelsStatusChanged((status) => {
  renderProactiveDeliveryAvailability(status as Record<string, { phase?: string }>);
});

// ===== channels panel (连接手机) =====
const channelsWechatEnabledEl = document.getElementById("channels-wechat-enabled") as HTMLInputElement | null;
const channelsFeishuEnabledEl = document.getElementById("channels-feishu-enabled") as HTMLInputElement | null;
const channelsWechatStatusEl = document.getElementById("channels-wechat-status");
const channelsFeishuStatusEl = document.getElementById("channels-feishu-status");
const channelsRateUserEl = document.getElementById("channels-rate-user") as HTMLInputElement | null;
const channelsRateChannelEl = document.getElementById("channels-rate-channel") as HTMLInputElement | null;
const channelsTtsEl = document.getElementById("channels-tts-enabled") as HTMLInputElement | null;
const channelsStickerEl = document.getElementById("channels-sticker-enabled") as HTMLInputElement | null;
const channelsMirrorEl = document.getElementById("channels-mirror-desktop") as HTMLInputElement | null;
const channelsToolSandboxAllEl = document.getElementById("channels-tool-sandbox-all") as HTMLInputElement | null;
const channelsToolSandboxSafeEl = document.getElementById("channels-tool-sandbox-safe") as HTMLInputElement | null;
// 飞书配置输入框（Phase 2 长连接版：只需 App ID + App Secret）
const channelsFeishuAppIdEl = document.getElementById("channels-feishu-app-id") as HTMLInputElement | null;
const channelsFeishuAppSecretEl = document.getElementById("channels-feishu-app-secret") as HTMLInputElement | null;
const channelsFeishuAppSecretRevealBtn = document.getElementById("channels-feishu-app-secret-reveal");
const channelsFeishuSaveBtn = document.getElementById("channels-feishu-save");
// 微信按钮
const channelsWechatLoginBtn = document.getElementById("channels-wechat-login");
const channelsWechatRestartBtn = document.getElementById("channels-wechat-restart");
const channelsWechatFeedbackEl = document.getElementById("channels-wechat-feedback");
const channelsFeishuFeedbackEl = document.getElementById("channels-feishu-feedback");

let channelsInitialized = false;
let channelsSaveTimer: number | null = null;

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
  if (text) text.textContent = message ?? (phase === "running" ? "运行中" : phase === "starting" ? "启动中" : phase === "config_missing" ? "配置缺失" : phase === "error" ? "错误" : "未启用");
}

async function loadChannelsPanel(): Promise<void> {
  if (channelsInitialized) return;
  channelsInitialized = true;
  try {
    const cfg = await window.settings.channelsGetConfig();
    if (channelsWechatEnabledEl) channelsWechatEnabledEl.checked = !!cfg.wechat.enabled;
    if (channelsFeishuEnabledEl) channelsFeishuEnabledEl.checked = !!cfg.feishu.enabled;
    if (channelsRateUserEl) channelsRateUserEl.value = String(cfg.rateLimitPerUser ?? 10);
    if (channelsRateChannelEl) channelsRateChannelEl.value = String(cfg.rateLimitPerChannel ?? 100);
    if (channelsTtsEl) channelsTtsEl.checked = cfg.ttsEnabled !== false;
    if (channelsStickerEl) channelsStickerEl.checked = cfg.stickerEnabled !== false;
    if (channelsMirrorEl) channelsMirrorEl.checked = cfg.mirrorToDesktop !== false;
    if (channelsToolSandboxAllEl) channelsToolSandboxAllEl.checked = cfg.toolSandbox === "all";
    if (channelsToolSandboxSafeEl) channelsToolSandboxSafeEl.checked = cfg.toolSandbox === "safe-only";

    // 飞书字段填充（长连接模式只需要 App ID；secret 加密存盘，UI 不回填明文）
    if (channelsFeishuAppIdEl) channelsFeishuAppIdEl.value = cfg.feishu.appId ?? "";
    if (channelsFeishuAppSecretEl) {
      channelsFeishuAppSecretEl.value = "";
      channelsFeishuAppSecretEl.placeholder = cfg.feishu.appSecret
        ? "已保存（输入新值会覆盖）"
        : "点击保存配置时加密保存";
    }

    // 拉一次渠道状态
    const status = (await window.settings.channelsGetStatus()) as Record<string, { phase: string; message?: string }>;
    renderProactiveDeliveryAvailability(status);
    renderChannelStatus(channelsWechatStatusEl, status.wechat?.phase ?? "offline", status.wechat?.message);
    renderChannelStatus(channelsFeishuStatusEl, status.feishu?.phase ?? "offline", status.feishu?.message);
    // Phase 3.4：拉一次消息日志
    void refreshChannelsLog();
  } catch (err) {
    console.warn("[Channels] loadChannelsPanel 失败:", err);
  }

  // 自动保存（debounce 200ms）
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
        toolSandbox: channelsToolSandboxSafeEl?.checked ? "safe-only" : "all",
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
    channelsToolSandboxAllEl,
    channelsToolSandboxSafeEl,
  ]) {
    el?.addEventListener("change", scheduleSave);
  }

  // 监听安装进度（Phase 1+ 才会收到）
  window.settings.onChannelsInstallProgress((progress) => {
    const target = progress.channel === "wechat" ? channelsWechatStatusEl : progress.channel === "feishu" ? channelsFeishuStatusEl : null;
    if (target) renderChannelStatus(target, "starting", `${progress.phase} ${progress.pct}%`);
  });
  window.settings.onChannelsStatusChanged((status) => {
    const s = status as Record<string, { phase: string; message?: string }>;
    renderProactiveDeliveryAvailability(s);
    renderChannelStatus(channelsWechatStatusEl, s.wechat?.phase ?? "offline", s.wechat?.message);
    renderChannelStatus(channelsFeishuStatusEl, s.feishu?.phase ?? "offline", s.feishu?.message);
  });

  // ===== 飞书交互（Phase 2 长连接版） =====

  // 显示/隐藏 App Secret
  channelsFeishuAppSecretRevealBtn?.addEventListener("click", () => {
    if (!channelsFeishuAppSecretEl) return;
    channelsFeishuAppSecretEl.type =
      channelsFeishuAppSecretEl.type === "password" ? "text" : "password";
  });

  // 保存配置（secret 用 safeStorage 加密后落盘 + 触发长连接重连）
  channelsFeishuSaveBtn?.addEventListener("click", async () => {
    setFeishuFeedback("info", "保存并连接中...");
    const patch: Record<string, unknown> = {
      feishu: {
        enabled: channelsFeishuEnabledEl?.checked ?? false,
        appId: channelsFeishuAppIdEl?.value.trim() || undefined,
      },
    };
    // 仅在用户输入了新值时才覆盖 secret（避免误清空）
    if (channelsFeishuAppSecretEl?.value) {
      (patch.feishu as Record<string, unknown>).appSecret = channelsFeishuAppSecretEl.value;
    }
    try {
      await window.settings.channelsSaveConfig(patch);
      // 保存后立即触发飞书 adapter 重建 + 重连长连接
      await window.settings.channelsRestart();
      setFeishuFeedback("ok", "已保存，飞书长连接正在建立…");
      // 清空输入框（已落盘），并把 placeholder 切到"已保存"
      if (channelsFeishuAppSecretEl) {
        channelsFeishuAppSecretEl.value = "";
        channelsFeishuAppSecretEl.placeholder = "已保存（输入新值会覆盖）";
      }
    } catch (err) {
      setFeishuFeedback("err", err instanceof Error ? err.message : String(err));
    }
  });

  // ===== 微信交互（扫码登录走 iLink HTTP API，详见 src/main/channels/adapters/wechat/） =====

  function setWechatFeedback(kind: "info" | "ok" | "err", msg: string): void {
    if (!channelsWechatFeedbackEl) return;
    channelsWechatFeedbackEl.textContent = msg;
    channelsWechatFeedbackEl.className = "channels-feedback";
    if (kind === "ok") channelsWechatFeedbackEl.classList.add("channels-feedback--ok");
    else if (kind === "err") channelsWechatFeedbackEl.classList.add("channels-feedback--err");
    else channelsWechatFeedbackEl.classList.add("channels-feedback--info");
  }

  // 扫码登录：Main Process 生成 PNG → 推到 Renderer → modal 弹窗
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

  // 关闭交互：点按钮 / 点背景 / 按 ESC
  channelsWechatQrCloseBtn?.addEventListener("click", hideWechatQr);
  channelsWechatQrBackdrop?.addEventListener("click", hideWechatQr);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && channelsWechatQrEl && !channelsWechatQrEl.hasAttribute("hidden")) {
      hideWechatQr();
    }
  });

  // 订阅 Main 推送的二维码（每次登录会推一次）
  window.settings.onChannelsWechatQrcode((dataUrl) => {
    console.log("[WechatSettings] QR event received, dataUrl prefix:", dataUrl?.slice(0, 40), "len:", dataUrl?.length);
    showWechatQr(dataUrl);
    setWechatFeedback("info", "请用微信扫描二维码");
  });
  // 订阅 Main 推送的登录结果（成功 / 失败 / 二维码过期）
  window.settings.onChannelsWechatLoginDone((payload) => {
    hideWechatQr();
    if (payload.ok) {
      setWechatFeedback("ok", `已登录（botId=${payload.botId ?? "?"}）`);
    } else {
      setWechatFeedback("err", `登录失败：${payload.error ?? "未知错误"}`);
    }
  });

  channelsWechatLoginBtn?.addEventListener("click", async () => {
    hideWechatQr();
    setWechatFeedback("info", "正在启动扫码…");
    try {
      const result = await window.settings.channelsWechatLoginStart();
      if (result.ok) {
        // 二维码由 onChannelsWechatQrcode 推过来并显示；这里只刷个轻提示
        setWechatFeedback("info", "等待二维码推送…");
      } else {
        setWechatFeedback("err", result.error ?? "启动失败");
      }
    } catch (err) {
      setWechatFeedback("err", err instanceof Error ? err.message : String(err));
    }
  });

  // 重启连接
  channelsWechatRestartBtn?.addEventListener("click", async () => {
    setWechatFeedback("info", "重启连接中…");
    try {
      await window.settings.channelsRestart();
      setWechatFeedback("ok", "已重启");
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

// ===== Phase 3.4：消息日志 =====
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
    channelsLogListEl.innerHTML = '<p class="empty-hint">暂无消息。</p>';
    return;
  }
  const html = entries
    .map((e) => {
      const t = new Date(e.at);
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      const ss = String(t.getSeconds()).padStart(2, "0");
      const dir = e.dir === "incoming" ? "← 收到" : "→ 回复";
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
    console.warn("[Channels] refreshChannelsLog 失败:", err);
  }
}

channelsLogRefreshBtn?.addEventListener("click", () => void refreshChannelsLog());
channelsLogClearBtn?.addEventListener("click", async () => {
  if (!confirm("确认清空所有 bot 消息日志？")) return;
  await window.settings.channelsLogClear();
  await refreshChannelsLog();
});

// 首次进入 channels panel 时拉一次日志
// （也可以在用户展开 details 时再拉，但保持简单直接拉）
void loadChannelsPanel();

// ===== Phase 2: 音乐工具面板 =====
// 备注：window.music.* 已在 preload 中通过 contextBridge 暴露。
// 由于 renderer 走 Vite 打包、main/preload 走 esbuild，两端类型不互通，
// 这里直接用 (window as any).music 做弱类型化调用，避免给 global.d.ts 加一堆 cross-bundle 类型。

interface MusicSelectionTrack {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
}

interface MusicSelectionResult {
  setId: string;
  source: string;
  query?: string;
  tracks: MusicSelectionTrack[];
}

type MusicIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: string; backendState?: string; accountState?: string; playerState?: string };

interface MusicApi {
  getStatus: () => Promise<MusicIpcResult<MusicStatusSnapshot>>;
  beginLogin: () => Promise<MusicIpcResult<{ loginSessionId: string; qrContent: string; expiresAt: number; pollIntervalMs: number }>>;
  cancelLogin: () => Promise<MusicIpcResult<unknown>>;
  logout: () => Promise<MusicIpcResult<unknown>>;
  search: (keyword: string, limit?: number) => Promise<MusicIpcResult<MusicSelectionResult>>;
  playTrack: (trackId: string) => Promise<MusicIpcResult<{ state: "dispatched" | "client_unavailable" | "launch_failed" }>>;
  onStateChanged: (h: (s: MusicStatusSnapshot) => void) => (() => void) | void;
}

function getMusicApi(): MusicApi | null {
  const w = window as unknown as { music?: MusicApi };
  return w.music ?? null;
}

const musicHomeView = document.getElementById("music-home-view");
const neteaseDetailView = document.getElementById("netease-detail-view");
const musicReturnBtn = document.getElementById("music-return-btn");
const musicSearchForm = document.getElementById("music-search-form");
const musicSearchHint = document.getElementById("music-search-hint");
const musicQrStatus = document.getElementById("music-qr-status");
const musicProfileAvatar = document.getElementById("music-profile-avatar") as HTMLImageElement | null;
const musicLoginBtn = document.getElementById("music-login-btn") as HTMLButtonElement | null;
const musicCancelBtn = document.createElement("button");
const musicDisconnectBtn = document.createElement("button");

const musicQrImg = document.getElementById("music-qr-img") as HTMLImageElement | null;
const musicQrTip = document.getElementById("music-qr-tip");
const musicQrBox = document.getElementById("music-qr") as HTMLElement | null;
const musicProfileBox = document.getElementById("music-profile");
const musicProfileName = document.getElementById("music-profile-name");
const musicFeedbackEl = document.getElementById("music-feedback");
const musicAccountStatusText = document.getElementById("music-account-status-text");
const musicStateRowEls = {
  backend: document.querySelector('.music-state-row[data-row="backend"]'),
  account: document.querySelector('.music-state-row[data-row="account"]'),
  player: document.querySelector('.music-state-row[data-row="player"]'),
};
const musicSearchInput = document.getElementById("music-search-input") as HTMLInputElement | null;
const musicSearchBtn = document.getElementById("music-search-btn") as HTMLButtonElement | null;
const musicSearchResults = document.getElementById("music-search-results");

let musicPanelInitialized = false;
let musicStateUnsub: (() => void) | null = null;
let musicLoginPollTimer: number | null = null;
let musicLastQrDataUrl: string | null = null;

function setMusicFeedback(kind: "info" | "ok" | "err", msg: string): void {
  if (!musicFeedbackEl) return;
  musicFeedbackEl.textContent = msg;
  musicFeedbackEl.className = "music-feedback";
  if (kind === "ok") musicFeedbackEl.classList.add("music-feedback--ok");
  else if (kind === "err") musicFeedbackEl.classList.add("music-feedback--err");
  else musicFeedbackEl.classList.add("music-feedback--info");
}

function dotColorFor(state: string, axis: "backend" | "account" | "player"): "green" | "yellow" | "red" | "gray" {
  if (state === "unknown") return "gray";
  if (axis === "backend") {
    if (state === "ready") return "green";
    if (state === "degraded") return "yellow";
    if (state === "failed" || state === "incompatible") return "red";
    return "yellow"; // starting / stopped
  }
  if (axis === "account") {
    if (state === "signed_in") return "green";
    if (state === "validating") return "yellow";
    if (state === "signed_out" || state === "expired") return "yellow";
    if (state === "temporarily_unavailable") return "red";
    return "gray";
  }
  // player
  if (state === "available") return "green";
  if (state === "unavailable") return "red";
  return "gray";
}

function renderMusicStateRow(axis: "backend" | "account" | "player", value: string): void {
  const row = musicStateRowEls[axis];
  if (!row) return;
  const dot = row.querySelector(".music-state-row__dot") as HTMLElement | null;
  const val = row.querySelector(".music-state-row__value") as HTMLElement | null;
  if (dot) dot.setAttribute("data-color", dotColorFor(value, axis));
  if (val) val.textContent = value;
}

function renderMusicStatus(snapshot: MusicStatusSnapshot): void {
  const state = deriveNeteaseViewState(snapshot);
  renderMusicStateRow("backend", snapshot.backend);
  renderMusicStateRow("account", snapshot.account);
  renderMusicStateRow("player", snapshot.player);
  const labels: Record<NeteaseViewState, string> = {
    backend_starting: "音乐服务暂不可用", backend_error: "音乐服务暂不可用", signed_out: "尚未连接",
    creating_qr: "正在等待扫码", waiting_scan: "正在等待扫码", waiting_confirm: "已扫码，请在手机确认",
    login_expired: "二维码已过期", login_failed: "登录失败", connected: "网易云音乐已连接", connected_without_client: "已登录，但未检测到桌面客户端",
  };
  if (musicAccountStatusText) musicAccountStatusText.textContent = labels[state];
  const actionHost = document.getElementById("music-actions");
  if (actionHost) {
    actionHost.innerHTML = "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = state === "signed_out" || state === "backend_error" ? "btn-primary" : "btn-secondary";
    const actions: Partial<Record<NeteaseViewState, string>> = { signed_out: "连接网易云", creating_qr: "取消登录", waiting_scan: "取消登录", waiting_confirm: "取消登录", login_expired: "重新生成二维码", login_failed: "重新登录", connected: "断开连接", connected_without_client: "断开连接", backend_error: "重新启动音乐服务" };
    if (actions[state]) { button.textContent = actions[state]!; button.addEventListener("click", () => void handleMusicAction(state)); actionHost.appendChild(button); }
  }
  const loggedIn = state === "connected" || state === "connected_without_client";
  musicProfileBox?.classList.toggle("is-hidden", !loggedIn);
  musicSearchForm?.classList.toggle("is-hidden", !loggedIn);
  if (musicSearchHint) musicSearchHint.textContent = loggedIn ? "搜索网易云曲库。" : "连接网易云后即可搜索歌曲和获取每日推荐。";
  if (snapshot.profile?.nickname && musicProfileName) musicProfileName.textContent = snapshot.profile.nickname;
  if (snapshot.profile?.avatarUrl && musicProfileAvatar) musicProfileAvatar.src = snapshot.profile.avatarUrl;
  musicQrBox?.classList.toggle("is-hidden", !(state === "creating_qr" || state === "waiting_scan" || state === "waiting_confirm" || state === "login_expired"));
  if (musicQrStatus) musicQrStatus.textContent = state === "waiting_confirm" ? "当前状态：等待手机确认" : state === "login_expired" ? "当前状态：二维码过期" : "当前状态：等待扫码";
}

async function handleMusicAction(state: NeteaseViewState): Promise<void> {
  const api = getMusicApi(); if (!api) return;
  if (state === "signed_out" || state === "login_expired" || state === "login_failed") return void startMusicLogin();
  if (state === "connected" || state === "connected_without_client") { await api.logout(); return; }
  if (state === "creating_qr" || state === "waiting_scan" || state === "waiting_confirm") { await api.cancelLogin?.(); clearMusicQr(); }
}

function updateMusicActionsForAccount(account: string): void {
  // Login-in-progress 状态：暂时还没有 IPC 通道告诉我们 creating_qr / waiting_scan / waiting_confirm，
  // 所以这里只能根据"是否显示了二维码 + account 状态"来推断。
  // 显示规则：
  //   - account === "signed_in"      → 显示 断开连接
  //   - account === "temporarily_unavailable" → 显示 连接网易云（让用户重试）
  //   - 二维码显示中 → 显示 取消登录
  //   - 其他 → 显示 连接网易云
  const qrVisible = !!musicQrBox && !musicQrBox.classList.contains("is-hidden");
  if (musicLoginBtn) musicLoginBtn.classList.toggle("is-hidden", qrVisible || account === "signed_in");
  if (musicCancelBtn) musicCancelBtn.classList.toggle("is-hidden", !qrVisible);
  if (musicDisconnectBtn) musicDisconnectBtn.classList.toggle("is-hidden", account !== "signed_in");
  if (musicProfileBox) musicProfileBox.classList.toggle("is-hidden", account !== "signed_in");
}

function clearMusicQr(): void {
  if (musicQrImg) musicQrImg.src = "";
  if (musicQrBox) musicQrBox.classList.add("is-hidden");
  if (musicQrTip) musicQrTip.textContent = "请用网易云音乐 App 扫描二维码完成登录";
  musicLastQrDataUrl = null;
}

function showMusicQr(dataUrl: string, tip: string): void {
  if (musicQrImg) musicQrImg.src = dataUrl;
  if (musicQrTip) musicQrTip.textContent = tip;
  if (musicQrBox) musicQrBox.classList.remove("is-hidden");
  musicLastQrDataUrl = dataUrl;
}

function stopMusicLoginPolling(): void {
  if (musicLoginPollTimer != null) {
    window.clearInterval(musicLoginPollTimer);
    musicLoginPollTimer = null;
  }
}

function startMusicLoginPolling(pollIntervalMs = 2000): void {
  stopMusicLoginPolling();
  const api = getMusicApi();
  if (!api) return;
  musicLoginPollTimer = window.setInterval(async () => {
    try {
      const r = await api.getStatus();
      if (r.ok) {
        renderMusicStatus(r.data);
        if (r.data.account === "signed_in") {
          // 登录成功 → 关闭 QR 面板、停止轮询
          clearMusicQr();
          stopMusicLoginPolling();
          setMusicFeedback("ok", "已连接到网易云音乐");
        } else if (r.data.flow === "expired" || r.data.flow === "failed" || r.data.flow === "cancelled") {
          stopMusicLoginPolling();
          if (r.data.flow !== "expired") clearMusicQr();
          setMusicFeedback("err", r.data.flow === "expired" ? "二维码已过期，请重新生成" : "登录未完成，请重试");
        } else if (r.data.account === "temporarily_unavailable" || r.data.account === "expired") {
          stopMusicLoginPolling();
          clearMusicQr();
          setMusicFeedback("err", "登录失败：账户状态 " + r.data.account);
        }
      }
    } catch (err) {
      console.warn("[music] login poll failed", err);
    }
  }, Math.max(1000, pollIntervalMs));
}

async function startMusicLogin(): Promise<void> {
  const api = getMusicApi();
  if (!api) {
    setMusicFeedback("err", "window.music 未就绪，请确认 music plugin 已注册");
    return;
  }
  setMusicFeedback("info", "正在生成二维码…");
  try {
    const r = await api.beginLogin();
    if (!r.ok) {
      setMusicFeedback("err", "启动登录失败：" + r.errorCode);
      // 把错误状态同步渲染出来
      const snapshot: MusicStatusSnapshot = {
        backend: r.backendState ?? "unknown",
        account: r.accountState ?? "unknown",
        player: r.playerState ?? "unknown",
      };
      renderMusicStatus(snapshot);
      return;
    }
    // 用 qrcode 包把 qrContent 渲染成 PNG dataURL
    let dataUrl = "";
    try {
      // qrcode 包没有官方 d.ts；用 require 形式确保 esbuild 能解析
      // （renderer 走 Vite，import 形式也 OK；下面用动态 import 兼容两种打包器）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qrcodeMod: any = await import(/* @vite-ignore */ "qrcode");
      dataUrl = await qrcodeMod.toDataURL(r.data.qrContent, { width: 240, margin: 1 });
    } catch (qrErr) {
      console.error("[music] QR 渲染失败", qrErr);
      setMusicFeedback("err", "二维码渲染失败");
      return;
    }
    showMusicQr(dataUrl, "请用网易云音乐 App 扫描二维码完成登录");
    setMusicFeedback("info", "等待扫码…");
    updateMusicActionsForAccount("signed_out"); // 切到"取消登录"显示
    startMusicLoginPolling(r.data.pollIntervalMs);
  } catch (err) {
    console.error("[music] beginLogin threw", err);
    setMusicFeedback("err", "启动登录异常：" + (err instanceof Error ? err.message : String(err)));
  }
}

async function cancelMusicLogin(): Promise<void> {
  const api = getMusicApi();
  if (!api) return;
  stopMusicLoginPolling();
  clearMusicQr();
  setMusicFeedback("info", "已取消登录");
  try {
    await api.cancelLogin();
  } catch (err) {
    console.warn("[music] cancelLogin threw", err);
  }
  // 重新拉一次 status 让 UI 回到初始态
  try {
    const r = await api.getStatus();
    if (r.ok) renderMusicStatus(r.data);
  } catch (err) {
    console.warn("[music] getStatus after cancel failed", err);
  }
}

async function disconnectMusic(): Promise<void> {
  // 暂时没有正式的 disconnect API；先用 cancelLogin 作为近似（它会清掉 loginSession），
  // 并把 UI 切回"未连接"。后续会接 music.disconnect。
  setMusicFeedback("info", "正在断开…");
  await cancelMusicLogin();
  setMusicFeedback("ok", "已断开（当前仅清空登录会话，详见说明）");
}

function renderMusicSearchResults(r: MusicIpcResult<MusicSelectionResult>, kw: string): void {
  if (!musicSearchResults) return;
  musicSearchResults.innerHTML = "";
  if (!r.ok) {
    const div = document.createElement("div");
    div.className = "music-feedback music-feedback--err";
    div.textContent = "搜索失败：" + r.errorCode;
    musicSearchResults.appendChild(div);
    return;
  }
  const tracks = r.data.tracks ?? [];
  if (tracks.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-hint";
    // 安全转义
    const safeKw = kw.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    p.textContent = `暂无结果，关键词 '${safeKw}' 未匹配到歌曲`;
    musicSearchResults.appendChild(p);
    return;
  }
  for (const t of tracks) {
    const row = document.createElement("div");
    row.className = "music-search-row";

    const main = document.createElement("div");
    main.className = "music-search-row__main";
    const name = document.createElement("div");
    name.className = "music-search-row__name";
    name.textContent = t.name;
    const meta = document.createElement("div");
    meta.className = "music-search-row__meta";
    const artistStr = (t.artists ?? []).join(" / ");
    meta.textContent = [artistStr, t.album].filter(Boolean).join(" · ");
    main.appendChild(name);
    main.appendChild(meta);

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "btn-secondary music-search-row__play";
    playBtn.textContent = "▶ 播放";
    playBtn.addEventListener("click", async () => {
      const api = getMusicApi();
      if (!api) {
        setMusicFeedback("err", "window.music 未就绪");
        return;
      }
      playBtn.disabled = true;
      try {
        const feedback = await requestTrackPlayback(api, t);
        setMusicFeedback(feedback.kind, feedback.message);
      } catch (err) {
        setMusicFeedback("err", "播放请求异常：" + (err instanceof Error ? err.message : String(err)));
      } finally {
        playBtn.disabled = false;
      }
    });

    row.appendChild(main);
    row.appendChild(playBtn);
    musicSearchResults.appendChild(row);
  }
}

async function runMusicSearch(): Promise<void> {
  const api = getMusicApi();
  if (!api) {
    setMusicFeedback("err", "window.music 未就绪");
    return;
  }
  const kw = (musicSearchInput?.value ?? "").trim();
  if (!kw) {
    setMusicFeedback("info", "请输入搜索关键词");
    return;
  }
  if (musicSearchResults) musicSearchResults.innerHTML = '<p class="empty-hint">搜索中…</p>';
  try {
    const r = await api.search(kw, 20);
    renderMusicSearchResults(r, kw);
  } catch (err) {
    console.error("[music] search threw", err);
    if (musicSearchResults) musicSearchResults.innerHTML = "";
    setMusicFeedback("err", "搜索异常：" + (err instanceof Error ? err.message : String(err)));
  }
}

async function loadMusicPanel(): Promise<void> {
  if (musicPanelInitialized) return;
  musicPanelInitialized = true;

  // 平台按钮（网易云 → 切到 music panel）的点击处理在文件下方模块初始化时已绑定，
  // 这里不再重复 attach，避免多次进入面板造成重复监听。

  musicLoginBtn?.addEventListener("click", () => void startMusicLogin());
  musicCancelBtn?.addEventListener("click", () => void cancelMusicLogin());
  musicDisconnectBtn?.addEventListener("click", () => void disconnectMusic());

  // 搜索
  musicSearchBtn?.addEventListener("click", () => void runMusicSearch());
  musicSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runMusicSearch();
  });

  // 订阅状态推送
  const api = getMusicApi();
  if (api && typeof api.onStateChanged === "function") {
    const unsub = api.onStateChanged((s) => renderMusicStatus(s));
    if (typeof unsub === "function") musicStateUnsub = unsub;
  }

  // 首次拉一次状态
  if (api) {
    try {
      const r = await api.getStatus();
      if (r.ok) renderMusicStatus(r.data);
      else setMusicFeedback("err", "读取状态失败：" + r.errorCode);
    } catch (err) {
      console.warn("[music] getStatus failed", err);
    }
  } else {
    setMusicFeedback("err", "window.music 未就绪");
  }
}

function disposeMusicPanel(): void {
  // 离开面板时：停止轮询、取消订阅、清掉 QR dataURL 释放内存
  stopMusicLoginPolling();
  if (musicStateUnsub) {
    try { musicStateUnsub(); } catch { /* ignore */ }
    musicStateUnsub = null;
  }
  clearMusicQr();
  setMusicFeedback("info", "");
}
// 启动时读 URL hash 决定初始标签（main 通过 loadURL 带 #api 实现"切换模型按钮跳 API"）。
// 无 hash 默认 general。
const initialSection = (window.location.hash || "#general").slice(1);
switchSection(initialSection);
// 监听 main 发来的切标签事件（窗口已打开时，main 不重新 loadURL，改发事件）
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

/* ===== Reranker install status (real on-disk check via IPC) ===== */
(async () => {
  const lightEl = document.getElementById("reranker-light-status");
  const standardEl = document.getElementById("reranker-standard-status");
  try {
    const status = await (window as any).settings?.getRerankerStatus?.();
    if (!status) return;
    if (lightEl) lightEl.textContent = status.light ? "已下载 · 约 23MB" : "未下载 · 可选";
    if (standardEl) standardEl.textContent = status.standard ? "已下载 · 约 279MB" : "未下载 · 可选";
  } catch (err) {
    console.warn("[Reranker] status check failed:", err);
    if (lightEl) lightEl.textContent = "状态未知";
    if (standardEl) standardEl.textContent = "状态未知";
  }
})();

/* ===== Embedding model status ===== */
(async () => {
  const bgem3El = document.getElementById("embedding-bgem3-status");
  const minilmEl = document.getElementById("embedding-minilm-status");
  try {
    const status = await window.modelConfig?.getModelInstallStatus?.();
    if (!status) {
      if (bgem3El) bgem3El.textContent = "状态未知";
      if (minilmEl) minilmEl.textContent = "状态未知";
      return;
    }
    if (bgem3El) bgem3El.textContent = status.embedding?.bgem3 ? "已下载 · 约 570MB" : "未下载";
    if (minilmEl) minilmEl.textContent = status.embedding?.minilm ? "已下载 · 约 23MB" : "未下载";
  } catch (err) {
    console.warn("[Embedding] status check failed:", err);
    if (bgem3El) bgem3El.textContent = "状态未知";
    if (minilmEl) minilmEl.textContent = "状态未知";
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
    // 打开模型安装说明文档
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
    // 加载用户字段（昵称/称呼偏好/生日/默认城市）
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

// 用户字段：失焦/回车保存（每个字段独立原子保存）
function bindUserProfileSave(input: HTMLInputElement | null, field: string): void {
  if (!input) return;
  const save = (): void => { void window.user?.saveProfile({ [field]: input.value.trim() }); };
  input.addEventListener("change", save);
  input.addEventListener("blur", save);
}
bindUserProfileSave(userNicknameInput, "nickname");
bindUserProfileSave(userCallPrefInput, "callPreference");
bindUserProfileSave(userBirthdayInput, "birthday");
// 默认城市复用上面的 saveCity（保持原逻辑）
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

const permissionBlocksWrap = document.getElementById("plugin-file-permission") as HTMLElement | null;
const permissionNote = document.getElementById("plugin-file-note") as HTMLElement | null;

const PERMISSION_NOTES: Record<PermissionLevel, string> = {
  "read-only": "只读：昔涟不会修改本地任何文件，也不能为你安装新工具。",
  "scoped": "指定目录：昔涟只能在你授权的目录里读写文件（白名单后续在此面板配置）。",
  "per-action": "每次审批：每次涉及文件或安装的操作，昔涟都会在聊天里弹卡片让你确认。",
  "full": "完全访问：昔涟可以自由调用本地命令（含 git/npm/pip）。请只在你完全信任的情况下使用。",
};

function paintPermissionUI(level: PermissionLevel): void {
  if (!permissionBlocksWrap) return;
  // scoped 档已从插件面板移除，回退显示只读
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

// ── 生活工具手风琴 ─────────────────────────────────────────
const lifeToggle = document.getElementById("plugin-life-toggle") as HTMLButtonElement | null;
const lifeCard = document.getElementById("plugin-life-card");
const lifeBody = document.getElementById("plugin-life-body");
lifeToggle?.addEventListener("click", () => {
  const expanded = lifeToggle.getAttribute("aria-expanded") === "true";
  lifeToggle.setAttribute("aria-expanded", String(!expanded));
  lifeCard?.classList.toggle("is-expanded", !expanded);
  lifeBody?.classList.toggle("is-collapsed", expanded);
});

// ── 音乐工具路由 ──────────────────────────────────────────────
const musicToggle = null;
const musicAccordionCard = null;
const musicAccordionBody = null;
document.getElementById("music-platform-netease")?.addEventListener("click", () => {
  switchSection("music");
  musicHomeView?.classList.add("is-hidden");
  neteaseDetailView?.classList.remove("is-hidden");
});
musicReturnBtn?.addEventListener("click", () => {
  neteaseDetailView?.classList.add("is-hidden");
  musicHomeView?.classList.remove("is-hidden");
});


// ── Skill 面板：列 skill 开关 ──────────────────────────────
async function renderSkills(): Promise<void> {
  const listEl = document.getElementById("skills-list");
  const emptyEl = document.getElementById("skills-empty");
  if (!listEl || !window.settings?.listSkills) return;

  let skills: Array<{ id: string; name: string; description: string; tools: string[]; enabled: boolean; source: string; version?: string; references: string[] }> = [];
  try {
    skills = await window.settings.listSkills();
  } catch (err) {
    console.warn("[settings] 加载 skill 列表失败:", err);
  }

  listEl.innerHTML = "";
  if (skills.length === 0) {
    if (emptyEl) emptyEl.classList.remove("is-hidden");
    return;
  }
  if (emptyEl) emptyEl.classList.add("is-hidden");

  // MiniMax 办公合集 id 列表
  const officeGroupIds = new Set(["docx", "pdf", "pptx-generator", "xlsx"]);
  const officeSkills = skills.filter((s) => officeGroupIds.has(s.id));
  const otherSkills = skills.filter((s) => !officeGroupIds.has(s.id));

  // 渲染单条 skill
  function renderSkillRow(s: typeof skills[number]): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "skill-row";
    const label = document.createElement("div");
    label.className = "skill-row__info";
    const title = document.createElement("div");
    title.className = "skill-row__title";
    title.textContent = s.name + (s.source === "user" ? " （用户）" : "");
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
        console.warn("[settings] 切换 skill 失败:", err);
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

  // MiniMax 办公合集折叠组
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
    gDesc.textContent = "MiniMax开源的办公文档Skills合集";
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
   💬 聊天面板：会话列表
   - 渲染 chatStore.list 返回的会话元数据，按 updatedAt desc 排序（store 已排）
   - 微信式时间：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 HH:mm / N 天前 / MM-DD
   - 点击列表项 = 在聊天窗口里打开（窗口未开则开窗）
   - 双击标题 = 改名（contentEditable + Enter/Esc/blur 提交）
   - 点🗑️ = 删除（活跃会话给出"正在阅读这个会话"差异化提示）
   - 跨窗口同步：onChanged 触发重渲；onActiveSessionChanged 更新高亮态
   - HTML/CSS 已在 index.html / settings.css 里就位（见 chat-sessions__*）
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

  // 第一次渲染前如果还不知道活跃 sessionId，主动拉一次
  if (chatSessionsActiveId === null) {
    try { chatSessionsActiveId = (await window.chatStore.getActiveSession()) ?? null; } catch { /* ignore */ }
  }

  let sessions: ChatSessionMetaUI[] = [];
  try {
    sessions = await window.chatStore.list();
  } catch (err) {
    console.warn("[settings] 加载聊天会话列表失败:", err);
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
  titleEl.textContent = session.title || "新对话";

  const metaEl = document.createElement("div");
  metaEl.className = "chat-sessions__meta";

  const timeEl = document.createElement("span");
  timeEl.className = "chat-sessions__time";
  timeEl.textContent = formatChatRelativeTime(session.updatedAt);

  const identityEl = document.createElement("span");
  identityEl.className = "chat-sessions__identity";
  // 职位面板未做，所有 identityId == null 的会话先 fallback 到"聊天陪伴"
  // 后续职位面板做好后这里改成用 identity 注册表查实际名称
  identityEl.textContent = "💼 " + (session.identityId ? session.identityId : CHAT_DEFAULT_IDENTITY_LABEL);

  metaEl.appendChild(timeEl);
  metaEl.appendChild(identityEl);

  // 左侧主区：标题 + meta
  const mainEl = document.createElement("div");
  mainEl.className = "chat-sessions__main";
  mainEl.appendChild(titleEl);
  mainEl.appendChild(metaEl);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "chat-sessions__delete";
  deleteBtn.title = "删除会话";
  deleteBtn.setAttribute("aria-label", "删除会话");
  deleteBtn.textContent = "🗑️";

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "chat-sessions__rename";
  renameBtn.title = "重命名";
  renameBtn.setAttribute("aria-label", "重命名会话");
  renameBtn.textContent = "✏️";

  // 编辑态确认/取消按钮（默认隐藏，进入编辑态时显示，替换 ✏️/🗑️ 的位置）
  const confirmRenameBtn = document.createElement("button");
  confirmRenameBtn.type = "button";
  confirmRenameBtn.className = "chat-sessions__confirm-rename is-hidden";
  confirmRenameBtn.title = "确认（Enter）";
  confirmRenameBtn.setAttribute("aria-label", "确认重命名");
  confirmRenameBtn.textContent = "✓";

  const cancelRenameBtn = document.createElement("button");
  cancelRenameBtn.type = "button";
  cancelRenameBtn.className = "chat-sessions__cancel-rename is-hidden";
  cancelRenameBtn.title = "取消（Esc）";
  cancelRenameBtn.setAttribute("aria-label", "取消重命名");
  cancelRenameBtn.textContent = "✕";

  // 右侧操作区：✏️ 🗑️（常规）/ ✓ ✕（编辑态）
  const actionsEl = document.createElement("div");
  actionsEl.className = "chat-sessions__actions";
  actionsEl.appendChild(renameBtn);
  actionsEl.appendChild(confirmRenameBtn);
  actionsEl.appendChild(cancelRenameBtn);
  actionsEl.appendChild(deleteBtn);

  // —— 交互绑定 ——
  // 点列表项 = 在聊天窗口里打开（编辑态时禁用，避免切走会话）
  li.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".chat-sessions__actions")) return;
    if (titleEl.isContentEditable) return;
    void window.chatStore?.openInChatWindow(session.id);
  });

  // ✏️ 按钮进入改名态
  renameBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    enterRenameMode(titleEl, session, { renameBtn, deleteBtn, confirmRenameBtn, cancelRenameBtn });
  });

  // 🗑️ 删除（含活跃会话差异化提示）
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void deleteChatSession(session);
  });

  li.appendChild(mainEl);
  li.appendChild(actionsEl);
  return li;
}

// 进入改名态：把 ✏️/🗑️ 隐藏，显示 ✓/✕；title 变 contentEditable 并聚焦全选。
// 提交走 ✓ 按钮 / Enter；取消走 ✕ 按钮 / Esc / 失焦。失焦=取消（避免点别处误提交）。
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

  // 切换按钮可见性
  btns.renameBtn.classList.add("is-hidden");
  btns.deleteBtn.classList.add("is-hidden");
  btns.confirmRenameBtn.classList.remove("is-hidden");
  btns.cancelRenameBtn.classList.remove("is-hidden");

  titleEl.contentEditable = "true";
  titleEl.classList.add("is-editing");
  // 用 requestAnimationFrame 等按钮 click 冒泡完再聚焦，避免焦点抢夺导致 blur 误触发
  requestAnimationFrame(() => {
    titleEl.focus();
    // 全选当前文本，方便用户直接覆盖
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
      // rename 成功后 main 广播 chats:changed → 列表重渲，无需手动改 DOM
    } else {
      titleEl.textContent = original; // 空内容或未变：还原
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
  // 失焦=取消（点别处想放弃编辑的心智模型）
  const onBlur = () => cancel();
  const onConfirm = (e: MouseEvent) => { e.stopPropagation(); commit(); };
  const onCancel = (e: MouseEvent) => { e.stopPropagation(); cancel(); };
  // 关键：mousedown 时 preventDefault，阻止 ✓/✕ 按钮抢焦点，
  // 否则顺序是 mousedown→titleEl blur(cancel 还原内容)→click(commit 读到原值)→改不了名。
  // 阻止焦点转移后，titleEl 保持聚焦，blur 不触发，click 正常执行 commit/cancel。
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
    ? `「${session.title || "新对话"}」正在聊天窗口里打开，确定删除？\n删除后聊天窗口会跳到最新一条会话或自动新建。`
    : `确定删除「${session.title || "新对话"}」？\n删除后无法恢复。`;
  if (!window.confirm(prompt)) return;
  try {
    await window.chatStore?.delete(session.id);
    // 删除成功后 main 广播 chats:changed → 列表重渲；
    // 聊天窗口若在显示该会话也会通过 onChanged 自动 fallback。
  } catch (err) {
    console.warn("[settings] 删除会话失败:", err);
    window.alert("删除失败，请查看终端日志。");
  }
}

// —— 顶部"+新对话"按钮 ——
const chatNewBtn = document.getElementById("chat-new-btn") as HTMLButtonElement | null;
chatNewBtn?.addEventListener("click", async () => {
  if (!window.chatStore) return;
  try {
    const session = await window.chatStore.create({ identityId: null });
    if (session?.id) await window.chatStore.openInChatWindow(session.id);
  } catch (err) {
    console.warn("[settings] 新建会话失败:", err);
    window.alert("新建会话失败，请查看终端日志。");
  }
});

// —— 底部"打开存储位置"按钮 ——
const chatOpenFolderBtn = document.getElementById("chat-open-folder-btn") as HTMLButtonElement | null;
chatOpenFolderBtn?.addEventListener("click", () => {
  void window.chatStore?.openFolder();
});

// —— 跨窗口同步 ——
// 任意会话变动（创建/追加/改名/删除）：重渲列表
// 仅在面板可见时刷新，节省 DOM 写入；不可见时下次切到面板会重新拉
window.chatStore?.onChanged(() => {
  const panel = document.getElementById("chat-panel");
  if (panel && !panel.classList.contains("is-hidden")) {
    void renderChatSessions();
  }
});

// 活跃 sessionId 变化：仅更新 is-active 高亮，不重新拉列表（轻量）
window.chatStore?.onActiveSessionChanged((sessionId) => {
  chatSessionsActiveId = sessionId;
  const listEl = document.getElementById("chat-sessions-list");
  if (!listEl) return;
  listEl.querySelectorAll<HTMLElement>(".chat-sessions__item").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.sessionId === sessionId);
  });
});

/* ============================================================
   📊 Token 用量面板：指标卡片 + 柱状图 + Chart.js 波浪图
   - 时间范围 7d/14d/30d 切换，切换后调 IPC 拉真实数据并重渲
   - hover 柱子/波浪节点 → tooltip 显示当天 输入/输出/命中/未命中
   - 全空时显示空态（暂无用量数据）
   ============================================================ */

import { Chart, registerables, type ChartConfiguration } from "chart.js";
import { DEFAULT_CHAT_REQUEST_TIMEOUT_MS, DEFAULT_FORCE_SUMMARY_TIMEOUT_MS, DEFAULT_PER_ROUND_TIMEOUT_MS, DEFAULT_TIMEOUT_SETTINGS, DEFAULT_VISION_TIMEOUT_MS, TimeoutSettings } from "../../shared/timeout-types";

Chart.register(...registerables);

interface TokenDayData {
  date: string;       // ISO 日期 "06-15"
  weekday: string;    // "周日"
  input: number;
  output: number;
  hit: number;        // 缓存命中（占位 0）
  miss: number;       // 缓存未命中（占位 0）
  requests: number;
}

declare global {
  interface Window {
    tokenUsage?: {
      get: (days: number) => Promise<TokenDayData[]>;
    };
  }
}

// 根据天数生成假数据（带随机波动，模拟真实趋势）
// 柱状图：根据数据动态生成柱子（复用 chart.css 的 .chart-bar 样式）
function renderTokenBarChart(data: TokenDayData[]): void {
  const container = document.getElementById("token-bar-chart");
  if (!container) return;
  container.innerHTML = "";

  const maxVal = Math.max(...data.map((d) => d.input + d.output), 1);
  const peakIdx = data.reduce((peak, d, i, arr) =>
    (d.input + d.output) > (arr[peak].input + arr[peak].output) ? i : peak, 0);

  // 柱状图最多显示 14 根（30d 时隔天显示），避免太挤
  const displayData = data.length > 14
    ? data.filter((_, i) => i % 2 === 0)
    : data;

  // 容器实际可用高度（mini-chart 高度 112px - padding-top 18px - 底部 label 区 18px ≈ 76px）
  // 用固定像素高度，避免 flex 百分比高度在 padding 容器里不可靠
  const chartHeight = 76;

  for (let i = 0; i < displayData.length; i++) {
    const d = displayData[i];
    const total = d.input + d.output;
    const barH = Math.max(6, Math.round((total / maxVal) * chartHeight));
    const bar = document.createElement("div");
    bar.className = "token-bar";
    // 峰值柱加标记
    const origIdx = data.indexOf(d);
    if (origIdx === peakIdx) bar.classList.add("token-bar--peak");

    // 真实 fill div（不用伪元素，直接控制像素高度）
    const fill = document.createElement("div");
    fill.className = "token-bar__fill";
    fill.style.height = barH + "px";

    const label = document.createElement("span");
    label.className = "token-bar__label";
    label.textContent = d.date.split("-")[1]; // 只显示日
    bar.appendChild(fill);
    bar.appendChild(label);

    // hover tooltip
    bar.addEventListener("mouseenter", (e) => showTokenTooltip(e, d));
    bar.addEventListener("mousemove", (e) => moveTokenTooltip(e));
    bar.addEventListener("mouseleave", hideTokenTooltip);

    container.appendChild(bar);
  }

  // 日均标签
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

// tooltip 显示/移动/隐藏
function showTokenTooltip(e: MouseEvent, d: TokenDayData): void {
  const tip = document.getElementById("token-tooltip");
  if (!tip) return;
  tip.innerHTML = `
    <div class="token-tooltip__date">${d.date} ${d.weekday}</div>
    <div class="token-tooltip__row"><span>📥 输入</span><span>${d.input.toLocaleString()}</span></div>
    <div class="token-tooltip__row"><span>📤 输出</span><span>${d.output.toLocaleString()}</span></div>
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
  // 防止超出视口右边
  const tipW = tip.offsetWidth;
  if (x + tipW > window.innerWidth) x = e.clientX - tipW - offset;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}

function hideTokenTooltip(): void {
  const tip = document.getElementById("token-tooltip");
  if (tip) tip.hidden = true;
}

// Chart.js 波浪面积图
let tokenTrendChart: Chart | null = null;

function renderTokenTrendChart(data: TokenDayData[]): void {
  const canvas = document.getElementById("token-trend-chart") as HTMLCanvasElement | null;
  if (!canvas) return;

  // 销毁旧实例避免重叠
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
          label: "📥 输入",
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
          label: "📤 输出",
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
          // 用 Chart.js 自带 tooltip，显示输入/输出/命中/未命中
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
              return `${which === "input" ? "📥 输入" : "📤 输出"}: ${val.toLocaleString()}`;
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

// 更新指标卡片
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

// 刷新整个面板：调 IPC 拉真实数据 → 有数据渲染图表，无数据显示空态
async function refreshTokenPanel(days: number): Promise<void> {
  let data: TokenDayData[] = [];
  try {
    data = await window.tokenUsage?.get(days) ?? [];
  } catch (err) {
    console.warn("[settings] 拉取 Token 用量失败:", err);
  }

  const hasData = data.some((d) => d.input > 0 || d.output > 0 || d.requests > 0);
  const emptyEl = document.getElementById("token-empty");
  const chartsEl = document.getElementById("token-charts");

  if (!hasData) {
    // 空态：隐藏图表区，显示空态提示，指标卡片归零
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

  // 有数据：显示图表区，隐藏空态
  if (emptyEl) emptyEl.classList.add("is-hidden");
  if (chartsEl) chartsEl.classList.remove("is-hidden");
  updateTokenStats(data);
  renderTokenBarChart(data);
  renderTokenTrendChart(data);
}

// 时间范围按钮交互
document.querySelectorAll<HTMLButtonElement>(".token-range__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".token-range__btn").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-selected", "true");
    const days = Number(btn.dataset.range) || 7;
    void refreshTokenPanel(days);
  });
});

// 初始渲染
void refreshTokenPanel(7);

/* ============================================================
   🎙️ TTS 设置面板交互
   - 配置加载/保存（存 general settings，跟其他设置一起）
   - 引擎选择卡片切换：选中哪个展开哪个配置表单
   - 语速/音量滑块实时显示数值 + 自动保存
   - MiniMax 测试发音：调 synthesize 合成固定文本并播放
   - 音色快速复刻：选文件→上传→训练→自动填入 voice_id
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
  }) => Promise<string>; // base64 音频
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
  // 自定义云端（返回 base64 + cacheKey + cached + format）
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

const TTS_TEST_TEXT = "你好，我是昔涟，很高兴见到你。";

// 获取 DOM 元素的辅助函数
function ttsEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

// 当前加载的 TTS 配置（内存缓存，改一个字段就存一次）
let ttsConfig: Record<string, unknown> = {};

// 加载配置并填充表单
async function loadTtsConfig(): Promise<void> {
  if (!window.tts) return;
  try {
    ttsConfig = await window.tts.loadSettings() as Record<string, unknown>;
  } catch (err) {
    console.warn("[TTS] 加载配置失败:", err);
    return;
  }

  // 引擎选择
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

  // 自定义云端
  ttsEl("tts-custom-cloud-url").value = String(ttsConfig.ttsCustomCloudEndpointUrl ?? "");
  ttsEl("tts-custom-cloud-key").value = String(ttsConfig.ttsCustomCloudApiKey ?? "");
  ttsEl("tts-custom-cloud-voice").value = String(ttsConfig.ttsCustomCloudVoiceId ?? "");
  (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value =
    ttsConfig.ttsCustomCloudFormat === "wav" ? "wav" : "mp3";
  ttsEl("tts-custom-cloud-timeout").value = String(ttsConfig.ttsCustomCloudTimeoutMs ?? 30000);

  // 小米 MiMo
  ttsEl("tts-mimo-key").value = String(ttsConfig.ttsMimoKey ?? "");
  ttsEl("tts-mimo-voice-audio").value = String(ttsConfig.ttsMimoVoiceAudioPath ?? "");
  ttsEl("tts-mimo-style").value = String(ttsConfig.ttsMimoStylePrompt ?? "温柔、自然、略带亲近感，像在轻声陪用户聊天。");

  // Opener 主动开口档位
  const openerMode = String(ttsConfig.openerMode ?? "off");
  document.querySelectorAll<HTMLButtonElement>(".opener-mode").forEach((btn) => {
    const isActive = btn.dataset.mode === openerMode;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-checked", isActive ? "true" : "false");
  });

  // 加载完成后清掉所有 Provider 的脏态（按钮隐藏，status 清空）
  for (const provider of Object.keys(TTS_PROVIDER_FIELDS)) {
    const ui = ttsProviderUi[provider];
    if (!ui) continue;
    ui.btn.classList.add("is-hidden");
    ui.status.textContent = "";
  }
}

function updateTtsSliderLabels(): void {
  const speedVal = document.getElementById("tts-speed-val");
  const volVal = document.getElementById("tts-volume-val");
  if (speedVal) speedVal.textContent = Number(ttsEl("tts-speed").value).toFixed(1) + "x";
  if (volVal) volVal.textContent = Math.round(Number(ttsEl("tts-volume").value) * 100) + "%";
}

// 保存单个 TTS 配置字段
async function saveTtsField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  ttsConfig[field] = value;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[TTS] 保存配置失败:", field, err);
  }
}

// 播放 base64 音频。format 决定 Blob MIME（minimax 默认 mp3，gptsovits 默认 wav）
function playTtsAudio(base64: string, format: "wav" | "mp3" = "mp3"): void {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const mime = format === "wav" ? "audio/wav" : "audio/mp3";
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play().catch((err) => console.warn("[TTS] 播放失败:", err));
    audio.onended = () => URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("[TTS] 音频解码失败:", err);
  }
}

// 引擎选择切换
// 只匹配带 data-engine 的按钮（即 TTS 厂商按钮）——主动开口档位按钮虽然
// 共用 .tts-engine 视觉 class，但只有 data-mode 没有 data-engine，
// 用属性选择器避免误触把它们当作 TTS 厂商处理。
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

// Opener 主动开口档位切换
document.querySelectorAll<HTMLButtonElement>(".opener-mode").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode || "off";
    document.querySelectorAll<HTMLButtonElement>(".opener-mode").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-checked", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-checked", "true");
    void saveTtsField("openerMode", mode);
  });
});

interface OpenerPackStatus {
  manifestInstalled: boolean;
  packDir: string;
  manifestPath: string;
}

interface OpenerBridgeApi {
  testFire?: () => Promise<void>;
  getStatus?: () => Promise<OpenerPackStatus>;
  openPackDir?: () => Promise<{ ok: boolean; error?: string }>;
  openInstallDocs?: () => Promise<{ ok: boolean; error?: string }>;
}

function getOpenerBridge(): OpenerBridgeApi | undefined {
  return (window as unknown as { openerBridge?: OpenerBridgeApi }).openerBridge;
}

let latestOpenerPackStatus: OpenerPackStatus | null = null;

async function refreshOpenerPackStatus(): Promise<void> {
  const warning = document.getElementById("opener-pack-warning");
  const pathEl = document.getElementById("opener-pack-path");
  const status = await getOpenerBridge()?.getStatus?.();
  if (!warning || !status) return;
  latestOpenerPackStatus = status;
  if (pathEl) pathEl.textContent = status.packDir;
  warning.toggleAttribute("hidden", status.manifestInstalled);
}

document.getElementById("opener-open-pack-dir")?.addEventListener("click", async () => {
  const result = await getOpenerBridge()?.openPackDir?.();
  if (result && !result.ok) {
    window.alert("打开语音包目录失败：" + (result.error || "未知错误"));
  }
  await refreshOpenerPackStatus();
});

document.getElementById("opener-show-install-help")?.addEventListener("click", async () => {
  const result = await getOpenerBridge()?.openInstallDocs?.();
  if (result && !result.ok) {
    window.alert("打开安装说明失败：" + (result.error || "未知错误"));
  }
});

// Opener 测试气泡（手动触发一次，看样式）
document.getElementById("opener-test-fire")?.addEventListener("click", () => {
  void getOpenerBridge()?.testFire?.();
});

void refreshOpenerPackStatus();

// 自动朗读开关
ttsEl("tts-auto-read").addEventListener("change", () => {
  void saveTtsField("ttsAutoRead", ttsEl("tts-auto-read").checked);
});

// 语速/音量滑块（change 时保存，input 时实时显示）
ttsEl("tts-speed").addEventListener("input", updateTtsSliderLabels);
ttsEl("tts-speed").addEventListener("change", () => saveTtsField("ttsSpeed", Number(ttsEl("tts-speed").value)));
ttsEl("tts-volume").addEventListener("input", updateTtsSliderLabels);
ttsEl("tts-volume").addEventListener("change", () => saveTtsField("ttsVolume", Number(ttsEl("tts-volume").value)));

// ── TTS 文本输入框：按 Provider 分组 + 手动保存 ──
// 之前这里有 input/change 自动 saveTtsField（settings.ts:4270–4295），
// 但每次 input 都会触发 IPC，IME 组字过程会被打断，用户反馈"打着打着输入法被打断"。
// 现在改为：文本框只 mark dirty，真正保存只发生在用户点击 Provider 自己的"保存配置"按钮。
// switch / slider / select / 引擎选择 / Opener 档位仍然走立即保存（保持即时反馈）。
const TTS_FIELD_MAP: Record<string, string> = {
  "tts-minimax-key":          "ttsMinimaxKey",
  "tts-minimax-voice":        "ttsMinimaxVoiceId",
  "tts-minimax-model":        "ttsMinimaxModel",
  "tts-gptsovits-url":        "ttsGptsovitsBaseUrl",
  "tts-gptsovits-ref-audio":  "ttsGptsovitsRefAudioPath",
  "tts-gptsovits-prompt-text":"ttsGptsovitsPromptText",
  "tts-custom-cloud-url":     "ttsCustomCloudEndpointUrl",
  "tts-custom-cloud-key":     "ttsCustomCloudApiKey",
  "tts-custom-cloud-voice":   "ttsCustomCloudVoiceId",
  "tts-custom-cloud-timeout": "ttsCustomCloudTimeoutMs",
  "tts-mimo-key":             "ttsMimoKey",
  "tts-mimo-voice-audio":     "ttsMimoVoiceAudioPath",
  "tts-mimo-style":           "ttsMimoStylePrompt",
};

// 每个 Provider 自己负责的文本输入框列表（不含 switch/slider/select，复刻子区块也不在此）
const TTS_PROVIDER_FIELDS: Record<string, string[]> = {
  minimax:        ["tts-minimax-key", "tts-minimax-voice"],
  gptsovits:      ["tts-gptsovits-url", "tts-gptsovits-ref-audio", "tts-gptsovits-prompt-text"],
  "custom-cloud": ["tts-custom-cloud-url", "tts-custom-cloud-key", "tts-custom-cloud-voice", "tts-custom-cloud-timeout"],
  mimo:           ["tts-mimo-key", "tts-mimo-voice-audio", "tts-mimo-style"],
};

// Provider ID → { 保存按钮, 状态 div }
// 用 ttsEl() 安全获取：拿不到时返回 null，不让整个 settings.ts 初始化崩。
function safeGet(id: string): HTMLElement | null {
  return document.getElementById(id);
}
const ttsProviderUi: Record<string, { btn: HTMLButtonElement; status: HTMLElement } | null> = {
  minimax:        ttsEl("tts-minimax-save-btn") && safeGet("tts-minimax-save-status")
                    ? { btn: ttsEl("tts-minimax-save-btn"), status: safeGet("tts-minimax-save-status") as HTMLElement }
                    : null,
  gptsovits:      ttsEl("tts-gptsovits-save-btn") && safeGet("tts-gptsovits-save-status")
                    ? { btn: ttsEl("tts-gptsovits-save-btn"), status: safeGet("tts-gptsovits-save-status") as HTMLElement }
                    : null,
  "custom-cloud": ttsEl("tts-custom-cloud-save-btn") && safeGet("tts-custom-cloud-save-status")
                    ? { btn: ttsEl("tts-custom-cloud-save-btn"), status: safeGet("tts-custom-cloud-save-status") as HTMLElement }
                    : null,
  mimo:           ttsEl("tts-mimo-save-btn") && safeGet("tts-mimo-save-status")
                    ? { btn: ttsEl("tts-mimo-save-btn"), status: safeGet("tts-mimo-save-status") as HTMLElement }
                    : null,
};

// 输入框触发脏态：只显示按钮和"有未保存的更改"，不发 IPC
function markTtsProviderDirty(provider: string): void {
  const ui = ttsProviderUi[provider];
  if (!ui) return;
  ui.btn.classList.remove("is-hidden");
  ui.status.textContent = "有未保存的更改";
  ui.status.className = "save-status";
}

for (const [provider, elIds] of Object.entries(TTS_PROVIDER_FIELDS)) {
  for (const elId of elIds) {
    const el = ttsEl(elId);
    el.addEventListener("input", () => markTtsProviderDirty(provider));
  }
}

// 保存某个 Provider 的所有文本配置
async function saveTtsProvider(provider: string): Promise<void> {
  const ui = ttsProviderUi[provider];
  if (!ui) return;
  const fields = TTS_PROVIDER_FIELDS[provider] ?? [];
  ui.btn.disabled = true;
  ui.status.textContent = "保存中…";
  ui.status.className = "save-status";
  try {
    const payload: Record<string, unknown> = {};
    for (const elId of fields) {
      const field = TTS_FIELD_MAP[elId];
      if (!field) continue;
      const el = ttsEl(elId);
      // 数字字段（timeout）转 Number；无效则跳过该字段但继续保存其他字段
      let value: unknown = el.value;
      if (elId === "tts-custom-cloud-timeout") {
        const num = Number(el.value);
        if (!Number.isFinite(num) || num <= 0) continue;
        value = num;
      }
      payload[field] = value;
      ttsConfig[field] = value;   // 同步内存中的 ttsConfig 缓存
    }
    if (Object.keys(payload).length === 0) {
      ui.status.textContent = "没有可保存的更改";
      ui.status.className = "save-status";
      return;
    }
    await window.tts!.saveSettings(payload);
    ui.status.textContent = "已保存";
    ui.status.className = "save-status is-ok";
    ui.btn.classList.add("is-hidden");
    setTimeout(() => { ui.status.textContent = ""; }, 2000);
  } catch (e) {
    ui.status.textContent = "保存失败：" + (e instanceof Error ? e.message : String(e));
    ui.status.className = "save-status is-error";
  } finally {
    ui.btn.disabled = false;
  }
}

// 注册点击 handler
for (const [provider, ui] of Object.entries(ttsProviderUi)) {
  ui?.btn.addEventListener("click", () => void saveTtsProvider(provider));
}

// GPT-SoVITS 格式选择（select，change 时直接保存）
(ttsEl("tts-gptsovits-format") as HTMLSelectElement).addEventListener("change", () => {
  void saveTtsField("ttsGptsovitsFormat", (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value as "wav" | "mp3");
});

// 自定义云端格式选择
(ttsEl("tts-custom-cloud-format") as HTMLSelectElement).addEventListener("change", () => {
  void saveTtsField("ttsCustomCloudFormat", (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value as "wav" | "mp3");
});

// MiniMax 流式播放开关
ttsEl("tts-streaming").addEventListener("change", () => {
  void saveTtsField("ttsStreaming", ttsEl("tts-streaming").checked);
});

// GPT-SoVITS 选择参考音频
document.getElementById("tts-gptsovits-ref-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudioFile();
  if (filePath) {
    ttsEl("tts-gptsovits-ref-audio").value = filePath;
    void saveTtsField("ttsGptsovitsRefAudioPath", filePath);
  }
});

// GPT-SoVITS 测试发音
document.getElementById("tts-gptsovits-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const baseUrl = ttsEl("tts-gptsovits-url").value.trim();
  const refAudioPath = ttsEl("tts-gptsovits-ref-audio").value.trim();
  const promptText = ttsEl("tts-gptsovits-prompt-text").value.trim();
  const format = (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value as "wav" | "mp3";
  if (!baseUrl) { window.alert("请先填写 GPT-SoVITS API 地址"); return; }
  if (!refAudioPath) { window.alert("请先选择参考音频文件"); return; }
  if (!promptText) { window.alert("请先填写参考音频对应的文本"); return; }

  const btn = document.getElementById("tts-gptsovits-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const result = await window.tts.synthesizeGptsovits({
      baseUrl, refAudioPath, promptText, text: TTS_TEST_TEXT, format,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    window.alert("测试失败: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// 小米 MiMo 选择昔涟克隆参考音频
document.getElementById("tts-mimo-voice-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudioFile();
  if (filePath) {
    ttsEl("tts-mimo-voice-audio").value = filePath;
    void saveTtsField("ttsMimoVoiceAudioPath", filePath);
  }
});

// 自定义云端测试发音
document.getElementById("tts-custom-cloud-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const endpointUrl = ttsEl("tts-custom-cloud-url").value.trim();
  const apiKey = ttsEl("tts-custom-cloud-key").value.trim();
  const voiceId = ttsEl("tts-custom-cloud-voice").value.trim();
  const format = (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value as "wav" | "mp3";
  const timeoutMs = Number(ttsEl("tts-custom-cloud-timeout").value) || 30000;
  if (!endpointUrl) { window.alert("请先填写自定义云端 Endpoint URL"); return; }

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
    window.alert("测试失败: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// 小米 MiMo 测试发音
document.getElementById("tts-mimo-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mimo-key").value.trim();
  const voiceAudioPath = ttsEl("tts-mimo-voice-audio").value.trim();
  const stylePrompt = ttsEl("tts-mimo-style").value.trim();
  if (!apiKey) { window.alert("请先填写小米 MiMo API Key"); return; }
  if (!voiceAudioPath) { window.alert("请先选择昔涟克隆参考音频"); return; }

  const btn = document.getElementById("tts-mimo-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const result = await window.tts.synthesizeMimo({
      apiKey, voiceAudioPath, stylePrompt, text: TTS_TEST_TEXT,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    window.alert("测试失败: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// MiniMax 测试发音
document.getElementById("tts-minimax-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-minimax-key").value.trim();
  const voiceId = ttsEl("tts-minimax-voice").value.trim();
  const modelSelect = ttsEl("tts-minimax-model") as HTMLSelectElement;
  const model = modelSelect.value === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo";
  if (!apiKey) { window.alert("请先填写 MiniMax API Key"); return; }
  if (!voiceId) { window.alert("请先填写音色 ID（或下方复刻训练）"); return; }

  const btn = document.getElementById("tts-minimax-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const base64 = await window.tts.synthesize({ apiKey, voiceId, text: TTS_TEST_TEXT, model });
    playTtsAudio(base64);
  } catch (err) {
    window.alert("测试失败: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// ── 音色快速复刻 ──
// 选择配音文件
document.getElementById("tts-clone-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-clone-file").value = filePath;
});

// 选择示例音频
document.getElementById("tts-clone-prompt-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-clone-prompt-file").value = filePath;
});

// 设置复刻状态文案
function setCloneStatus(text: string, type: "ok" | "error" | "loading"): void {
  const el = document.getElementById("tts-clone-status");
  if (!el) return;
  el.textContent = text;
  el.className = "tts-clone-status" + (type ? " is-" + type : "");
}

// 开始复刻
document.getElementById("tts-clone-start")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-minimax-key").value.trim();
  const cloneFile = ttsEl("tts-clone-file").value.trim();
  const promptFile = ttsEl("tts-clone-prompt-file").value.trim();
  const promptText = ttsEl("tts-clone-prompt-text").value.trim();
  const cloneText = ttsEl("tts-clone-text").value.trim();
  const voiceId = ttsEl("tts-clone-voice-id").value.trim();

  if (!apiKey) { window.alert("请先填写 MiniMax API Key"); return; }
  if (!cloneFile) { window.alert("请选择配音文件"); return; }
  if (!cloneText) { window.alert("请填写复刻文本"); return; }
  if (!voiceId) { window.alert("请填写音色命名"); return; }

  const btn = document.getElementById("tts-clone-start") as HTMLButtonElement;
  btn.disabled = true;
  setCloneStatus("正在上传配音文件…", "loading");

  try {
    // 步骤1: 上传配音文件
    const cloneUpload = await window.tts.upload(apiKey, cloneFile, "voice_clone");
    setCloneStatus("配音文件上传完成 (file_id: " + cloneUpload.file_id + ")，正在上传示例音频…", "loading");

    // 步骤2: 上传示例音频（可选）
    let promptFileId: string | undefined;
    if (promptFile) {
      const promptUpload = await window.tts.upload(apiKey, promptFile, "prompt_audio");
      promptFileId = promptUpload.file_id;
      setCloneStatus("示例音频上传完成，正在训练音色…", "loading");
    } else {
      setCloneStatus("正在训练音色…", "loading");
    }

    // 步骤3: 音色克隆
    const result = await window.tts.clone({
      apiKey, fileId: cloneUpload.file_id, voiceId,
      promptAudioId: promptFileId, promptText: promptText || undefined,
      text: cloneText,
    });

    // 自动填入音色 ID
    ttsEl("tts-minimax-voice").value = result.voiceId;
    void saveTtsField("ttsMinimaxVoiceId", result.voiceId);

    setCloneStatus("✅ 复刻成功！音色 ID「" + result.voiceId + "」已自动填入。", "ok");

    // 如果有试听音频，播放
    if (result.audioDemo) {
      try {
        const resp = await fetch(result.audioDemo);
        const buf = await resp.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        playTtsAudio(base64);
      } catch { /* 试听音频播放失败不影响主流程 */ }
    }
  } catch (err) {
    setCloneStatus("❌ " + (err instanceof Error ? err.message : String(err)), "error");
  } finally {
    btn.disabled = false;
  }
});

// 初始加载配置
void loadTtsConfig();
