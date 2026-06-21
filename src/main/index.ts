import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, shell, dialog } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { IPC } from "../shared/ipc-channels";
import { STATUS_KEYWORDS, STICKER_EXPLICIT_TRIGGERS, STICKER_CONTENT_TRIGGERS, STICKER_MAP } from "./status-keywords";
import { initRAG, buildMemoryContext, addMemory, importDocument, switchEmbeddingModel, deleteImportedDoc } from "./rag";
import { buildAlwaysOnContext, runFunctionCallingLoop, scheduleMemoryWrite } from "./orchestrator";
import { getAdapter, buildVendorUrl } from "./orchestrator/vendors";
import { getCapability } from "./orchestrator/vendors/capabilities";
import type { VisionConfig } from "./orchestrator/vision-captioner";
import { toolRegistry } from "./orchestrator/tool-registry";
// 触发 built-in-tools 的副作用注册（fetch_url / run_shell / install_mcp_server）
import "./orchestrator/built-in-tools";
// 触发 fs-tools 的副作用注册（read_file / list_dir / write_file / read_image）
import "./orchestrator/fs-tools";
import { initMcpManager, addMcpServer, removeMcpServer, listMcpServers } from "./orchestrator/mcp-manager";
import { buildEnvironmentContext } from "./orchestrator/environment";
import { initPermissionFromDisk, registerPermissionIpc, getCurrentLevel } from "./permission";
import { enqueueLLMTask } from "./llm-queue";
import { getEmbeddingStatus, downloadEmbeddingModel, deleteEmbeddingModel } from "./embedding-manager";
import { initReranker } from "./rag/reranker";
import { memoryStore } from "./memory/memory-store"
import type { L0Profile, L1Profile } from "./memory/memory-types";
import { registerChatsIpc } from "./chats/chats-ipc";
import { recordUsage, getUsage, flush as flushTokenUsage } from "./token-usage-store";
import { uploadFile as ttsUploadFile, cloneVoice as ttsCloneVoice, synthesize as ttsSynthesize } from "./tts/minimax-engine";
import { registerAgUiIpc, type AguiRunInput } from "./agui-bridge";
import { setWeatherConfig, setSearchConfig, loadTodos, onTodosChange } from "./orchestrator/built-in-tools";
import { registerRecallHistoryTool } from "./orchestrator/history-tools";
import { registerDocumentTools } from "./orchestrator/document-tools";
import { registerLifeTools, setTranslateConfig } from "./orchestrator/life-tools";
import { initSkills, skillRegistry, buildSkillCatalog, parseSlashCommand, setSkillEnabled, listSkillsForUi } from "./skills";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let chatWindow: BrowserWindow | null = null;
let sidebarWindow: BrowserWindow | null = null;
let tasksWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let stickerManagerWindow: BrowserWindow | null = null;
// 聊天窗口当前活跃的会话 id（通过 IPC 由聊天窗口上报）；
// 设置面板"删除当前会话"差异化提示用。聊天窗口关闭时由 closed 事件置 null。
let activeChatSessionId: string | null = null;

const isDev = process.env.VITE_DEV === "1";

// 单个厂商的可缓存配置：用户切到别的厂商再切回来，这三个字段从这里恢复。
interface ProviderProfile {
  baseUrl: string;
  model: string;
  apiKey: string;
  displayName?: string;
}

/**
 * 厂商名变更映射：旧 providerName → 新 providerName。
 *
 * 触发时机：UI 上为了对齐"英文名（中文公司名）"格式重命名了 preset 后，
 * 已存盘的 model-settings.json 里 provider 字段（以及 perProvider 字典的键）
 * 仍是旧名；normalize 阶段做一次性迁移，把旧名的 perProvider 数据搬到新名下，
 * provider 字段也改写为新名。迁移后写盘一次即清除痕迹。
 *
 * 后续如果再次重命名，**只追加键值对**，不要删除老条目，避免回归。
 */
const PROVIDER_RENAMES: Record<string, string> = {
  "MiniMax": "MiniMax（稀宇科技）",
  "DeepSeek": "DeepSeek（深度求索）",
  "智谱 GLM": "GLM（智谱）",
  "通义千问（DashScope）": "Qwen（通义千问）",
  "火山 Agent-Plan": "火山 AgentPlan（火山引擎）",
};

/**
 * 把 perProvider 字典 + currentProvider 字段一起套用 PROVIDER_RENAMES。
 * - 旧名 → 新名：直接搬数据；如果新名已存在数据，旧名的不覆盖（保护"已用新名存过"的情况）。
 * - 不在映射表里的键：原样保留。
 */
function migrateProviderRenames(
  currentProvider: string,
  perProvider: Record<string, ProviderProfile>,
): { provider: string; perProvider: Record<string, ProviderProfile> } {
  const next: Record<string, ProviderProfile> = {};
  for (const [key, value] of Object.entries(perProvider)) {
    const newKey = PROVIDER_RENAMES[key] ?? key;
    if (next[newKey]) {
      // 新名已经有数据（说明用户已经在新名下存过），旧名的本地副本保留为最近一次更新优先：
      // 这里取保守路线 → 不覆盖 next[newKey]，旧名直接丢弃。
      console.log("[Cyrene] provider rename: drop legacy", key, "→ kept", newKey);
      continue;
    }
    if (newKey !== key) {
      console.log("[Cyrene] provider rename:", key, "→", newKey);
    }
    next[newKey] = value;
  }
  const newProvider = PROVIDER_RENAMES[currentProvider] ?? currentProvider;
  return { provider: newProvider, perProvider: next };
}

interface ModelSettings {
  mode: "auto" | "manual";
  provider: string;
  // 用户给模型起的自定义昵称，留空时状态栏用厂商 shortName。
  displayName?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  // 按厂商缓存：currentProvider 之外的厂商配置也保留在这里，切回来时回填。
  // 真值（source of truth）是 perProvider；顶层 baseUrl/model/apiKey 是当前厂商那一份的展开镜像，
  // 仅为兼容现有 main 进程里大量直接读 settings.baseUrl 等代码而保留。
  perProvider: Record<string, ProviderProfile>;
  runtimeSync: "off" | "local" | "llm";
  stickerEnabled: boolean;
  stickerSize: StickerSize;
  rerankerMode: "light" | "standard" | "none";
  embeddingModel: "minilm" | "bgem3";
  // 视觉模型配置（可选）。undefined 或未启用 = 不支持看图，read_image 诚实拒绝。
  vision?: VisionModelConfig;
}

/** 视觉模型配置。syncWithMain=true 时三字段不落盘，运行时强制从主配置读。 */
interface VisionModelConfig {
  syncWithMain: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}


interface UserProfile {
  nickname: string;
  callPreference: string;
  birthday: string;
  timezone: string;
  avatarPath: string;
  /** 默认城市（用于天气等需要地理定位的工具，没填则模型会问用户） */
  defaultCity: string;
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
  // TTS 配置
  ttsEngine: "off" | "volcano" | "minimax" | "gptsovits" | "vits2";
  ttsAutoRead: boolean;
  ttsSpeed: number;
  ttsVolume: number;
  // MiniMax
  ttsMinimaxKey: string;
  ttsMinimaxVoiceId: string;
  /** MiniMax 合成模型：speech-2.8-hd(高保真¥3.5/万字符) | speech-2.8-turbo(极速¥2.0/万字符) */
  ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  /** 天气源：open-meteo(免配置默认) | amap(高德,需填key) */
  weatherSource: "open-meteo" | "amap";
  /** 天气插件是否启用（开关） */
  weatherEnabled: boolean;
  /** 高德天气 key（https://lbs.amap.com 注册 Web服务 key） */
  amapKey: string;
  // 联网搜索：选哪个搜索源 + 对应 key
  searchEngine: "off" | "bocha" | "tavily" | "minimax";
  searchBochaKey: string;
  searchTavilyKey: string;
  searchMinimaxKey: string;
  // 火山（后续接入）
  ttsVolcanoAppId: string;
  ttsVolcanoToken: string;
  ttsVolcanoVoiceId: string;
  // 本地引擎
  ttsGptsovitsUrl: string;
  ttsGptsovitsModel: string;
  ttsVits2Url: string;
  ttsVits2Model: string;
}


interface PublicModelConfig {
  mode: "auto" | "manual";
  provider: string;
  // 用户自定义昵称；留空时状态栏用 shortName
  displayName?: string;
  // 厂商短名（去括号后缀），状态栏"正在喂养"的兜底显示
  shortName: string;
  model: string;
  connected: boolean;
  runtimeSync: "off" | "local" | "llm";
  stickerSize: StickerSize;
  rerankerMode: "light" | "standard" | "none";
}

type RuntimeStatus = "陪伴中" | "思考中" | "工作中" | "聆听中" | "提醒中" | "离线";
type RuntimeFeeling = "平静" | "开心" | "温柔" | "激动" | "撒娇" | "担心" | "难过" | "感动" | "害羞";
type StickerId = "playful" | "love-happy" | "confident" | "serious" | "calm" | "peek" | "clingy-confused" | "tired" | "love-calm" | "love" | "applause";
type StickerSize = "small" | "standard" | "large";

interface RuntimeState {
  status: RuntimeStatus;
  feeling: RuntimeFeeling;
  expression: number;
  updatedAt: number;
}

interface ChatReplyPayload {
  reply: string;
  sticker: StickerId | null;
}

const RUNTIME_STATUSES: RuntimeStatus[] = ["陪伴中", "思考中", "工作中", "聆听中", "提醒中", "离线"];
const RUNTIME_FEELINGS: RuntimeFeeling[] = ["平静", "开心", "温柔", "激动", "撒娇", "担心", "难过", "感动", "害羞"];
const STICKER_IDS: StickerId[] = ["playful", "love-happy", "confident", "serious", "calm", "peek", "clingy-confused", "tired", "love-calm", "love", "applause"];
const STICKER_FILES: Record<StickerId, string> = {
  playful: "playful.png",
  "love-happy": "love-happy.png",
  confident: "confident.png",
  serious: "serious.png",
  calm: "calm.png",
  peek: "peek.gif",
  "clingy-confused": "clingy-confused.gif",
  tired: "tired.png",
  "love-calm": "love-calm.png",
  love: "love.webp",
  applause: "applause.webp",
};
const CHAT_REQUEST_TIMEOUT_MS = 30000;
let runtimeState: RuntimeState = {
    status: "陪伴中",
    feeling: "平静",
    expression: 0,
    updatedAt: Date.now(),
  };
const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  mode: "auto",
  // 默认厂商改为 MiniMax（v1 vendor adapter 第一个落地的），DeepSeek 已从 v1 清单移除。
  provider: "MiniMax（稀宇科技）",
  baseUrl: "https://api.minimaxi.com/anthropic",
  model: "MiniMax-M3",
  apiKey: "",
  perProvider: {},
  runtimeSync: "off",
  stickerEnabled: true,
  stickerSize: "standard",
  rerankerMode: "light",
  embeddingModel: "minilm",
};

const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  musicEnabled: false,
  musicVolume: 60,
  soundEnabled: true,
  soundVolume: 70,
  petAlwaysOnTop: true,
  petVisible: true,
  launchAtLogin: false,
  language: "zh-CN",
  ttsEngine: "off",
  ttsAutoRead: true,
  ttsSpeed: 1,
  ttsVolume: 1,
  ttsMinimaxKey: "",
  ttsMinimaxVoiceId: "",
  ttsMinimaxModel: "speech-2.8-turbo",
  weatherSource: "open-meteo",
  weatherEnabled: false,
  amapKey: "",
  searchEngine: "off",
  searchBochaKey: "",
  searchTavilyKey: "",
  searchMinimaxKey: "",
  ttsVolcanoAppId: "",
  ttsVolcanoToken: "",
  ttsVolcanoVoiceId: "",
  ttsGptsovitsUrl: "http://localhost:9880",
  ttsGptsovitsModel: "",
  ttsVits2Url: "http://localhost:9880",
  ttsVits2Model: "",
};

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "model-settings.json");
}

function getGeneralSettingsPath(): string {
  return path.join(app.getPath("userData"), "app-settings.json");
}


function getUserProfilePath(): string {
  return path.join(app.getPath("userData"), "user-profile.json");
}

function getAvatarPath(): string {
  return path.join(app.getPath("userData"), "avatar.png");
}

function getRagStorePath(): string {
  return path.join(app.getPath("userData"), "rag-data", "memory-store.json");
}

const DEFAULT_USER_PROFILE: UserProfile = {
  nickname: "",
  callPreference: "",
  birthday: "",
  timezone: "Asia/Shanghai",
  avatarPath: "",
  defaultCity: "",
};

function loadUserProfile(): UserProfile {
  try {
    const filePath = getUserProfilePath();
    if (!fs.existsSync(filePath)) return DEFAULT_USER_PROFILE;
    return { ...DEFAULT_USER_PROFILE, ...JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<UserProfile> };
  } catch {
    return DEFAULT_USER_PROFILE;
  }
}

function saveUserProfile(profile: Partial<UserProfile>): UserProfile {
  const existing = loadUserProfile();
  const merged = { ...existing, ...profile };
  const filePath = getUserProfilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

interface MemoryPanelItem {
  id: string;
  title: string;
  body: string;
  meta: string;
}

interface ImportedDocItem {
  importId: string | null;
  fileName: string;
  chunkCount: number;
  lastImportedAt: number;
}

async function loadMemoryPanelData() {
  const [l0, l1, l2] = await Promise.all([
    memoryStore.getL0(),
    memoryStore.getL1(),
    memoryStore.getAllL2(),
  ]);

  let importedDocs: ImportedDocItem[] = [];
  const ragStorePath = getRagStorePath();

  try {
    if (fs.existsSync(ragStorePath)) {
      const raw = fs.readFileSync(ragStorePath, "utf8");
      const entries = JSON.parse(raw) as Array<{
        source?: string;
        createdAt?: number;
        metadata?: { fileName?: string; importId?: string };
      }>;

      const docsMap = new Map<string, ImportedDocItem>();
      for (const entry of entries) {
        if (entry.source !== "imported_doc") continue;
        const fileName = entry.metadata?.fileName || "未命名文档";
        const importId = entry.metadata?.importId as string | undefined;
        // 新数据按 importId 分组，旧数据按 fileName 分组
        const key = importId || "legacy:" + fileName;
        const existing = docsMap.get(key);
        if (existing) {
          existing.chunkCount += 1;
          existing.lastImportedAt = Math.max(existing.lastImportedAt, entry.createdAt || 0);
        } else {
          docsMap.set(key, {
            importId: importId || null,
            fileName,
            chunkCount: 1,
            lastImportedAt: entry.createdAt || 0,
          });
        }
      }

      importedDocs = [...docsMap.values()].sort((a, b) => b.lastImportedAt - a.lastImportedAt);
    }
  } catch (error) {
    console.warn("[settings] load imported docs failed:", error);
  }

  return {
    l0,
    l1,
    l2: l2.sort((a, b) => b.createdAt - a.createdAt),
    importedDocs,
    reflections: [] as MemoryPanelItem[],
  };
}

function getStickerSettingsPath(): string {
  return path.join(app.getPath("userData"), "sticker-settings.json");
}

/**
 * normalize 流程：
 *   1. 先清洗顶层基础字段（mode/provider/runtimeSync/...）
 *   2. 再清洗 perProvider 字典：忽略非法键、缺失字段补默认值、apiKey 不在这里强制 trim 留作下一步
 *   3. 旧 schema 兼容：若 perProvider 中没有 currentProvider 那一份，把顶层 baseUrl/model/apiKey 当作首次迁移塞进去
 *   4. 用 perProvider[currentProvider] 反向展开成顶层 baseUrl/model/apiKey 镜像
 *      → 真值（source of truth）是 perProvider；顶层只是当前厂商配置的视图
 */
function normalizeProviderProfile(input: Partial<ProviderProfile> | null | undefined): ProviderProfile {
  return {
    baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "",
    model: typeof input?.model === "string" ? input.model.trim() : "",
    apiKey: typeof input?.apiKey === "string" ? input.apiKey.trim() : "",
    displayName: typeof input?.displayName === "string" && input.displayName.trim() ? input.displayName.trim() : undefined,
  };
}

/** 清洗视觉模型配置。syncWithMain=true 时三字段不保留（运行时从主配置读）。 */
function normalizeVisionConfig(input: Partial<VisionModelConfig> | undefined): VisionModelConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const syncWithMain = input.syncWithMain === true;
  if (syncWithMain) {
    // syncWithMain=true：强制忽略三字段（即便手动编辑配置文件写了也忽略），运行时从主配置读
    return { syncWithMain: true, baseUrl: "", apiKey: "", model: "" };
  }
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  // 三项全空 = 未启用
  if (!baseUrl && !apiKey && !model) return undefined;
  return { syncWithMain: false, baseUrl, apiKey, model };
}

function normalizeModelSettings(input: Partial<ModelSettings> | null | undefined): ModelSettings {
  const mode: "auto" | "manual" = input?.mode === "manual" ? "manual" : "auto";
  let provider = typeof input?.provider === "string" && input.provider.trim()
    ? input.provider.trim()
    : DEFAULT_MODEL_SETTINGS.provider;

  // perProvider 清洗：跳过非对象、非法键
  const rawPerProvider = (input as ModelSettings | undefined)?.perProvider;
  let perProvider: Record<string, ProviderProfile> = {};
  if (rawPerProvider && typeof rawPerProvider === "object") {
    for (const [key, value] of Object.entries(rawPerProvider)) {
      if (typeof key !== "string" || !key.trim()) continue;
      perProvider[key.trim()] = normalizeProviderProfile(value as Partial<ProviderProfile>);
    }
  }

  // 厂商重命名迁移：把旧 provider 名在字典里和当前 provider 字段一并改成新名。
  // 必须在"旧 schema 兼容回填"之前做，否则会用旧名先创建一份僵尸数据。
  ({ provider, perProvider } = migrateProviderRenames(provider, perProvider));

  // 旧 schema 兼容：v1 之前的 model-config.json 没有 perProvider 字段，
  // 但有顶层 baseUrl/model/apiKey 三件套。首次升级时把它们当作 currentProvider 那一份回填。
  if (!perProvider[provider]) {
    perProvider[provider] = normalizeProviderProfile({
      baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl : "",
      model: typeof input?.model === "string" ? input.model : "",
      apiKey: typeof input?.apiKey === "string" ? input.apiKey : "",
    });
    // 如果迁移后这一份完全是空的（用户从来没配过），再给个默认 baseUrl/model（便于 UI 第一次显示）
    if (!perProvider[provider].baseUrl) perProvider[provider].baseUrl = DEFAULT_MODEL_SETTINGS.baseUrl;
    if (!perProvider[provider].model) perProvider[provider].model = DEFAULT_MODEL_SETTINGS.model;
  }

  // 顶层镜像：用 perProvider[provider] 展开
  const profile = perProvider[provider];

  return {
    mode,
    provider,
    displayName: profile.displayName,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: profile.apiKey,
    perProvider,
    runtimeSync: input?.runtimeSync === "llm" ? "llm" : input?.runtimeSync === "local" ? "local" : "off",
    stickerEnabled: input?.stickerEnabled !== false,
    stickerSize: input?.stickerSize === "small" || input?.stickerSize === "large" ? input.stickerSize : "standard",
    rerankerMode: input?.rerankerMode === "standard" || input?.rerankerMode === "none" ? input.rerankerMode : "light",
    embeddingModel: input?.embeddingModel === "bgem3" ? "bgem3" : "minilm",
    vision: normalizeVisionConfig(input?.vision),
  };
}

function loadModelSettings(): ModelSettings {
  try {
    const filePath = getSettingsPath();
    if (!fs.existsSync(filePath)) return DEFAULT_MODEL_SETTINGS;
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeModelSettings(JSON.parse(raw) as Partial<ModelSettings>);
  } catch (err) {
    console.error("[Cyrene] load settings failed:", err);
    return DEFAULT_MODEL_SETTINGS;
  }
}

/**
 * 加载视觉模型配置，解析 syncWithMain 并做 supportsVision 检查。
 * 返回 null = 未启用视觉（read_image 据此诚实拒绝）。
 *
 * syncWithMain=true 时：从主配置读 baseUrl/key/model，并检查主模型 supportsVision——
 * 若主模型非视觉，返回 null（避免把非视觉模型当视觉模型硬调导致运行时错误让用户困惑）。
 */
export function loadVisionConfig(): VisionConfig | null {
  const settings = loadModelSettings();
  const v = settings.vision;
  if (!v) return null;

  if (v.syncWithMain) {
    // 从主配置读
    const cap = getCapability(settings.provider);
    if (!cap?.supportsVision) {
      console.warn("[Vision] syncWithMain=true 但主模型不支持视觉，视为未启用");
      return null;
    }
    if (!settings.apiKey || !settings.model) return null;
    // 视觉 baseUrl：优先用 visionBaseUrl（主配走 Anthropic 入口时视觉需走 OpenAI 入口），
    // 没标就用主配置 baseUrl。这样用户勾"同步"就能用，不用手动改 URL。
    const visionBaseUrl = cap.visionBaseUrl || settings.baseUrl;
    return { baseUrl: visionBaseUrl, apiKey: settings.apiKey, model: settings.model };
  }

  // 独立配置
  if (!v.baseUrl || !v.apiKey || !v.model) return null;
  return { baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model };
}

/**
 * 保存逻辑：
 *   - 渲染端发来的 settings 既可能带顶层 baseUrl/model/apiKey（旧调用方式），
 *     也可能带 perProvider（新调用方式，未来可扩展）。
 *   - 写盘前先把"顶层那三件套"折叠回 perProvider[provider]，保证真值落到字典里。
 *   - normalizeModelSettings 再把 perProvider[provider] 展开成顶层镜像，写盘 = 双视图一致。
 */
function saveModelSettings(settings: Partial<ModelSettings>): ModelSettings {
  const existing = loadModelSettings();
  const merged: Partial<ModelSettings> = { ...existing, ...settings };

  // currentProvider 优先取传入的、再取已有的
  const currentProvider = (typeof settings.provider === "string" && settings.provider.trim())
    ? settings.provider.trim()
    : existing.provider;

  // 起点：复制现有 perProvider，再 merge 传入的 perProvider
  const perProvider: Record<string, ProviderProfile> = { ...(existing.perProvider ?? {}) };
  if (settings.perProvider && typeof settings.perProvider === "object") {
    for (const [key, value] of Object.entries(settings.perProvider)) {
      perProvider[key] = normalizeProviderProfile(value as Partial<ProviderProfile>);
    }
  }

  // 把传入的顶层三件套折叠到 currentProvider 下（这是渲染端目前主要的写入路径）
  const incomingProfile = perProvider[currentProvider] ?? normalizeProviderProfile(null);
  perProvider[currentProvider] = {
    baseUrl: typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : incomingProfile.baseUrl,
    model: typeof settings.model === "string" ? settings.model.trim() : incomingProfile.model,
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey.trim() : incomingProfile.apiKey,
    displayName: typeof settings.displayName === "string" && settings.displayName.trim()
      ? settings.displayName.trim()
      : incomingProfile.displayName,
  };

  merged.provider = currentProvider;
  merged.perProvider = perProvider;

  const final = normalizeModelSettings(merged);
  const filePath = getSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(final, null, 2), "utf8");
  return final;
}

function normalizeGeneralSettings(input: Partial<GeneralSettings> | null | undefined): GeneralSettings {
  const clamp = (value: unknown, fallback: number) => {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : fallback;
  };
  return {
    musicEnabled: Boolean(input?.musicEnabled),
    musicVolume: clamp(input?.musicVolume, DEFAULT_GENERAL_SETTINGS.musicVolume),
    soundEnabled: input?.soundEnabled === undefined ? DEFAULT_GENERAL_SETTINGS.soundEnabled : Boolean(input.soundEnabled),
    soundVolume: clamp(input?.soundVolume, DEFAULT_GENERAL_SETTINGS.soundVolume),
    petAlwaysOnTop: Boolean(input?.petAlwaysOnTop),
    petVisible: input?.petVisible === undefined ? DEFAULT_GENERAL_SETTINGS.petVisible : Boolean(input.petVisible),
    launchAtLogin: Boolean(input?.launchAtLogin),
    language: "zh-CN",
    // TTS 配置
    ttsEngine: (["off", "volcano", "minimax", "gptsovits", "vits2"].includes(input?.ttsEngine as string) ? input?.ttsEngine : "off") as GeneralSettings["ttsEngine"],
    ttsAutoRead: input?.ttsAutoRead === undefined ? DEFAULT_GENERAL_SETTINGS.ttsAutoRead : Boolean(input.ttsAutoRead),
    ttsSpeed: typeof input?.ttsSpeed === "number" ? Math.max(0.5, Math.min(2, input.ttsSpeed)) : DEFAULT_GENERAL_SETTINGS.ttsSpeed,
    ttsVolume: typeof input?.ttsVolume === "number" ? Math.max(0, Math.min(1, input.ttsVolume)) : DEFAULT_GENERAL_SETTINGS.ttsVolume,
    ttsMinimaxKey: typeof input?.ttsMinimaxKey === "string" ? input.ttsMinimaxKey : "",
    ttsMinimaxVoiceId: typeof input?.ttsMinimaxVoiceId === "string" ? input.ttsMinimaxVoiceId : "",
    ttsMinimaxModel: input?.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo",
    weatherSource: ["open-meteo", "amap"].includes(String(input?.weatherSource))
      ? (input!.weatherSource as "open-meteo" | "amap")
      : "open-meteo",
    weatherEnabled: Boolean(input?.weatherEnabled),
    amapKey: typeof input?.amapKey === "string" ? input.amapKey : "",
    searchEngine: ["off", "bocha", "tavily", "minimax"].includes(String(input?.searchEngine))
      ? (input!.searchEngine as "off" | "bocha" | "tavily" | "minimax")
      : "off",
    searchBochaKey: typeof input?.searchBochaKey === "string" ? input.searchBochaKey : "",
    searchTavilyKey: typeof input?.searchTavilyKey === "string" ? input.searchTavilyKey : "",
    searchMinimaxKey: typeof input?.searchMinimaxKey === "string" ? input.searchMinimaxKey : "",
    ttsVolcanoAppId: typeof input?.ttsVolcanoAppId === "string" ? input.ttsVolcanoAppId : "",
    ttsVolcanoToken: typeof input?.ttsVolcanoToken === "string" ? input.ttsVolcanoToken : "",
    ttsVolcanoVoiceId: typeof input?.ttsVolcanoVoiceId === "string" ? input.ttsVolcanoVoiceId : "",
    ttsGptsovitsUrl: typeof input?.ttsGptsovitsUrl === "string" ? input.ttsGptsovitsUrl : DEFAULT_GENERAL_SETTINGS.ttsGptsovitsUrl,
    ttsGptsovitsModel: typeof input?.ttsGptsovitsModel === "string" ? input.ttsGptsovitsModel : "",
    ttsVits2Url: typeof input?.ttsVits2Url === "string" ? input.ttsVits2Url : DEFAULT_GENERAL_SETTINGS.ttsVits2Url,
    ttsVits2Model: typeof input?.ttsVits2Model === "string" ? input.ttsVits2Model : "",
  };
}

function loadGeneralSettings(): GeneralSettings {
  try {
    const filePath = getGeneralSettingsPath();
    if (!fs.existsSync(filePath)) return DEFAULT_GENERAL_SETTINGS;
    return normalizeGeneralSettings(JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<GeneralSettings>);
  } catch (err) {
    console.error("[Cyrene] load general settings failed:", err);
    return DEFAULT_GENERAL_SETTINGS;
  }
}

function applyGeneralSettings(settings: GeneralSettings): void {
  mainWindow?.setAlwaysOnTop(settings.petAlwaysOnTop, settings.petAlwaysOnTop ? "screen-saver" : "normal");
  if (settings.petVisible) mainWindow?.show();
  else mainWindow?.hide();
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
}

function saveGeneralSettings(settings: Partial<GeneralSettings>): GeneralSettings {
  const normalized = normalizeGeneralSettings(settings);
  const filePath = getGeneralSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
  applyGeneralSettings(normalized);
  return normalized;
}

/** MiniMax 搜索 MCP Server 的固定 ID。 */
const MINIMAX_SEARCH_MCP_ID = "minimax-web-search";

/**
 * 同步搜索 MCP Server：选 MiniMax+有key→注册连接，否则→移除断开。
 * 在 TTS_SAVE_SETTINGS 检测到搜索配置变化时调用。
 */
async function syncVolcanoSearchMcp(settings: GeneralSettings): Promise<void> {
  // ── MiniMax（PyPI包，不依赖GitHub，推荐）──
  const minimaxEnable = settings.searchEngine === "minimax" && settings.searchMinimaxKey.trim().length > 0;
  const minimaxExists = listMcpServers().some(s => s.id === MINIMAX_SEARCH_MCP_ID);

  if (minimaxEnable && !minimaxExists) {
    console.log("[Cyrene] 注册 MiniMax 搜索 MCP Server...");
    try {
      const result = await addMcpServer({
        id: MINIMAX_SEARCH_MCP_ID,
        name: "MiniMax搜索",
        transport: "stdio",
        command: "uvx",
        args: ["minimax-coding-plan-mcp", "-y"],
        env: {
          MINIMAX_API_KEY: settings.searchMinimaxKey.trim(),
          MINIMAX_API_HOST: "https://api.minimaxi.com",
        },
      });
      if (result.ok) {
        console.log("[Cyrene] MiniMax 搜索 MCP 注册成功，工具:", result.toolIds?.join(", "));
      } else {
        console.error("[Cyrene] MiniMax 搜索 MCP 注册失败:", result.error);
      }
    } catch (err) {
      console.error("[Cyrene] MiniMax 搜索 MCP 注册异常:", err);
    }
  } else if (!minimaxEnable && minimaxExists) {
    console.log("[Cyrene] 移除 MiniMax 搜索 MCP Server...");
    try { await removeMcpServer(MINIMAX_SEARCH_MCP_ID); } catch (err) { console.error("[Cyrene] MiniMax 搜索 MCP 移除异常:", err); }
  } else if (minimaxEnable && minimaxExists) {
    console.log("[Cyrene] MiniMax 搜索 key 变化，重新注册 MCP Server...");
    try {
      await removeMcpServer(MINIMAX_SEARCH_MCP_ID);
      await addMcpServer({
        id: MINIMAX_SEARCH_MCP_ID, name: "MiniMax搜索", transport: "stdio",
        command: "uvx",
        args: ["minimax-coding-plan-mcp", "-y"],
        env: { MINIMAX_API_KEY: settings.searchMinimaxKey.trim(), MINIMAX_API_HOST: "https://api.minimaxi.com" },
      });
    } catch (err) { console.error("[Cyrene] MiniMax 搜索 MCP 重新注册异常:", err); }
  }
}

function loadStickerSettings(): Record<StickerId, boolean> {
  let raw: Record<string, unknown> = {};
  try {
    const filePath = getStickerSettingsPath();
    if (fs.existsSync(filePath)) {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    }
  } catch (err) {
    console.error("[Cyrene] load sticker settings failed:", err);
  }

  return STICKER_IDS.reduce((acc, id) => {
    acc[id] = raw[id] !== false;
    return acc;
  }, {} as Record<StickerId, boolean>);
}

function saveStickerSettings(settings: Record<StickerId, boolean>): Record<StickerId, boolean> {
  const normalized = STICKER_IDS.reduce((acc, id) => {
    acc[id] = settings[id] !== false;
    return acc;
  }, {} as Record<StickerId, boolean>);
  const filePath = getStickerSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

function setStickerEnabled(id: StickerId, enabled: boolean): Record<StickerId, boolean> {
  const current = loadStickerSettings();
  current[id] = enabled;
  return saveStickerSettings(current);
}

function normalizeStickerId(value: unknown): StickerId | null {
  return typeof value === "string" && STICKER_IDS.includes(value as StickerId) ? value as StickerId : null;
}

function getStickerManagerConfig() {
  const enabled = loadStickerSettings();
  return STICKER_IDS.map((id) => ({
    id,
    src: "/stickers/" + STICKER_FILES[id],
    enabled: enabled[id] !== false,
  }));
}

// 计算 chat / sidebar / tasks 三个窗口的初始位置。
// 规则：聊天居中显示，侧边栏和定时任务依次往右排，三者同高 720 并垂直居中。
// 屏宽不够时整组左对齐，让用户自己拖。
function computeLayout(): {
  chat: { x: number; y: number };
  sidebar: { x: number; y: number };
  tasks: { x: number; y: number };
} {
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const CHAT_W = 1280;
  const SB_W = 320;
  const TK_W = 320;
  const WIN_H = 720;
  const cy = dy + Math.max(0, Math.floor((dh - WIN_H) / 2));
  const chatX = dx + Math.max(0, Math.floor((dw - CHAT_W) / 2));
  return {
    chat: { x: chatX, y: cy },
    sidebar: { x: chatX + CHAT_W, y: cy },
    tasks: { x: chatX + CHAT_W + SB_W, y: cy },
  };
}


interface ChatRequestMessage {
  role: "user" | "model" | "assistant" | "system";
  content: string;
}

interface ChatCompletionChoice {
  message?: {
    content?: string;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: {
    message?: string;
  };
}


function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

function createVisibleStreamFilter(): {
  push: (chunk: string) => string;
  flush: () => string;
} {
  let pending = "";
  let insideThink = false;
  const openTag = "<think>";
  const closeTag = "</think>";

  return {
    push(chunk: string): string {
      pending += chunk;
      let visible = "";

      while (pending) {
        const lower = pending.toLowerCase();

        if (insideThink) {
          const closeIndex = lower.indexOf(closeTag);
          if (closeIndex < 0) {
            pending = pending.slice(Math.max(0, pending.length - (closeTag.length - 1)));
            break;
          }

          pending = pending.slice(closeIndex + closeTag.length);
          insideThink = false;
          continue;
        }

        const openIndex = lower.indexOf(openTag);
        if (openIndex < 0) {
          const safeLength = Math.max(0, pending.length - (openTag.length - 1));
          visible += pending.slice(0, safeLength);
          pending = pending.slice(safeLength);
          break;
        }

        visible += pending.slice(0, openIndex);
        pending = pending.slice(openIndex + openTag.length);
        insideThink = true;
      }

      return visible;
    },
    flush(): string {
      if (insideThink) {
        pending = "";
        return "";
      }

      const rest = pending;
      pending = "";
      return rest;
    },
  };
}

function extractJsonPayload(text: string): unknown | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;

    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

// feeling → Live2D 表情索引
const feelingToExpression: Record<string, number> = {
  "平静": 0,
  "开心": 6,
  "温柔": 0,
  "激动": 3,
  "撒娇": 5,
  "担心": 2,
  "难过": 0,
  "感动": 4,
  "害羞": 5,
};

function inferRuntimeState(
  userInput: string,
  llmReply: string,
  toolCalled: boolean
): Pick<RuntimeState, "status"> {
  if (toolCalled) return { status: "工作中" };

  const text = userInput + llmReply;

  if (STATUS_KEYWORDS["聆听中"].test(text)) {
    return { status: "聆听中" };
  }

  if (STATUS_KEYWORDS["思考中"].test(text)) {
    return { status: "思考中" };
  }

  return { status: "陪伴中" };
}



function inferStickerId(state: RuntimeState, text: string, latestUserText: string): StickerId | null {
  const source = `${latestUserText}
${text}`;

  // 显式触发：用户明确要表情包
  if (/表情包|发表情|来一个|发一个/.test(latestUserText)) {
    for (const [id, regex] of Object.entries(STICKER_EXPLICIT_TRIGGERS)) {
      if (regex.test(source)) return id as StickerId;
    }
    return "peek";
  }

  // 内容触发
  if (STICKER_CONTENT_TRIGGERS["love-happy"].test(source)) return state.feeling === "开心" ? "love-happy" : "love-calm";
  for (const [id, regex] of Object.entries(STICKER_CONTENT_TRIGGERS)) {
    if (id === "love-happy") continue;
    if (regex.test(source)) return id as StickerId;
  }
  if (state.status === "思考中") return "serious";
  if (state.feeling === "开心") return "playful";
  if (state.feeling === "感动" || state.feeling === "害羞") return "love";

  // 兜底：STICKER_MAP 查表
  return (STICKER_MAP[state.status]?.[state.feeling] as StickerId) ?? null;
}

function parseObserverFeeling(text: string): string | null {
  const payload = extractJsonPayload(text);
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const feeling = typeof record.feeling === "string" ? record.feeling : null;
  const validFeelings = ["平静","开心","温柔","激动","撒娇","担心","难过","感动","害羞"];
  return feeling && validFeelings.includes(feeling) ? feeling : null;
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function normalizeChatMessages(input: unknown): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  if (!Array.isArray(input)) return [];
  return input
    .map((item): { role: "system" | "user" | "assistant"; content: string } | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Partial<ChatRequestMessage>;
      if (typeof record.content !== "string" || !record.content.trim()) return null;
      const role = record.role === "user" || record.role === "system" ? record.role : "assistant";
      return { role, content: stripThinkBlocks(record.content).trim() };
    })
    .filter((item): item is { role: "system" | "user" | "assistant"; content: string } => item !== null)
    .slice(-24);
}

function getApiLogPath(): string {
  return path.join(app.getPath("userData"), "chat-api.log");
}

function appendApiLog(
  label: string,
  requestMessages: Array<{ role: string; content: string }>,
  rawResponse: string,
  cleanedResponse: string,
): void {
  try {
    const now = new Date().toISOString();
    const entry = [
      "=".repeat(80),
      `[${now}] ${label}`,
      "-".repeat(40) + " REQUEST " + "-".repeat(40),
      JSON.stringify(requestMessages, null, 2),
      "-".repeat(40) + " RAW RESPONSE " + "-".repeat(40),
      rawResponse,
      "-".repeat(40) + " CLEANED " + "-".repeat(40),
      cleanedResponse || "(empty)",
      "=".repeat(80),
      "",
    ].join(os.EOL);
    fs.appendFileSync(getApiLogPath(), entry, "utf8");
  } catch {
    // silent
  }
}

async function callChatCompletionsStream(
  settings: ModelSettings,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  temperature: number | undefined,
  timeoutMs: number,
  label: string,
  onChunk: (text: string) => void,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const _startTime = Date.now();
  console.log(`[TIMING] ${label} START timeout=${timeoutMs}ms msgLen=${messages.length} sysLen=${messages[0]?.content?.length ?? 0}`);

  try {
    const response = await fetch(buildVendorUrl(settings.provider, settings.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        // temperature 只在显式传时才塞进 body，避免型号约束冲突（如 Kimi k2.6 只允许 1）
        ...(temperature !== undefined ? { temperature } : {}),
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = (errorData as { error?: { message?: string } }).error?.message;
      throw new Error(errMsg || `模型请求失败：HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("响应体为空，不支持流式读取");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let fullText = "";
    let buffer = "";
    const visibleFilter = createVisibleStreamFilter();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const jsonStr = trimmed.slice(6);
        if (jsonStr === "[DONE]") continue;

        try {
          const parsed = JSON.parse(jsonStr) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            const visibleDelta = visibleFilter.push(delta);
            if (visibleDelta) {
              onChunk(visibleDelta);
            }
          }
          // 流式末尾的 usage 块（choices 为空但带 usage），记录 token 用量
          if (parsed.usage) {
            recordUsage(parsed.usage.prompt_tokens ?? 0, parsed.usage.completion_tokens ?? 0, 1);
          }
        } catch {
        }
      }
    }

    const visibleTail = visibleFilter.flush();
    if (visibleTail) {
      onChunk(visibleTail);
    }

    const result = stripThinkBlocks(fullText);
    console.log(`[TIMING] ${label} OK in ${Date.now() - _startTime}ms resultLen=${result.length}`);
    appendApiLog(label, messages, fullText, result);
    return result;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.log(`[TIMING] ${label} TIMEOUT at ${Date.now() - _startTime}ms`);
      throw new Error("模型请求超时，请稍后重试。");
    }
    console.log(`[TIMING] ${label} ERROR at ${Date.now() - _startTime}ms: ${err instanceof Error ? err.message : err}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}


// Legacy wrapper for non-streaming calls (e.g. observer)
async function callChatCompletions(
  settings: ModelSettings,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  temperature: number | undefined,
  timeoutMs: number,
  label: string,
): Promise<string> {
  return callChatCompletionsStream(settings, messages, temperature, timeoutMs, label, () => {});
}

function loadPromptFile(filename: string): string {
  try {
    const filePath = path.join(app.getAppPath(), "prompts", filename);
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function buildSystemPrompt(styleFile: string): string {
  const parts: string[] = [];
  
  const system = loadPromptFile("system.md");
  if (system) parts.push(system);
  
  const identity = loadPromptFile("identity.md");
  if (identity) parts.push(identity);
  
  const soul = loadPromptFile("soul.md");
  if (soul) parts.push(soul);
  
  const canon = loadPromptFile("canon_quotes.md");
  if (canon) parts.push(canon);
  
  const style = loadPromptFile("styles/" + styleFile);
  if (style) parts.push(style);
  
  return parts.join("\n\n---\n\n");
}

/**
 * /命令拦截：命中 /skill-id（且 skill 存在+启用）则返回 system 激活段
 * （正文注入 system，user message 原样，不污染 memory，见 spec 6.3）。
 * 命中但 skill 不存在/未启用 → 改写该 user 消息为提示，返回 ""。
 * 未命中 → 返回 ""（放行，不误吞其他 /命令）。
 */
function resolveSlashActivation<T extends { role: string; content: string }>(messages: T[]): string {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return "";
  const lastUser = messages[lastUserIdx];
  if (typeof lastUser.content !== "string") return "";
  const knownIds = skillRegistry.getAll().map(s => s.id);
  const parsed = parseSlashCommand(lastUser.content, knownIds);
  if (!parsed.hit || !parsed.skillId) return "";
  const skill = skillRegistry.getById(parsed.skillId);
  if (skill && skill.enabled) {
    const body = skillRegistry.getBody(parsed.skillId);
    if (body !== null) {
      console.log("[Cyrene] /命令激活 skill:", parsed.skillId);
      return `\n\n---\n\n[已激活 skill: ${parsed.skillId}]\n${body}`;
    }
    return "";
  }
  // skill 不存在/未启用：替换该 user 消息为提示
  const available = skillRegistry.getEnabled().map(s => s.id).join(", ") || "(无)";
  messages[lastUserIdx] = { ...lastUser, content: `[系统提示：skill 未启用或不存在: ${parsed.skillId}。可用 skill: ${available}]` } as T;
  return "";
}

function loadSoulFeelingContext(): string {
  try {
    const soulPath = path.join(app.getAppPath(), "prompts", "soul.md");
    if (!fs.existsSync(soulPath)) return "";
    return fs.readFileSync(soulPath, "utf8");
  } catch {
    return "";
  }
}

async function observeRuntimeState(
  settings: ModelSettings,
  recentMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  latestUserText: string,
  chatContent: string,
): Promise<void> {
  const recentDialogue = [...recentMessages.slice(-8), { role: "assistant" as const, content: chatContent }]
    .filter((message) => message.role !== "system")
    .slice(-6)
    .map((message) => ({ role: message.role, content: message.content }));

  // 入 LLM 后台队列：和 MemoryJudge 串行执行，避免并发触发限流；
  // 限流自动退避 5s 重试 1 次。.catch 吞错误，不影响主流程。
  enqueueLLMTask("心情观察器", async () => {
    const _obsStart = Date.now();
    console.log(`[TIMING] 心情观察器 SENDING request`);
    const observerContent = await callChatCompletions(settings, [
      {
        role: "system",
        content:
          '你是一个情绪分析器。以下是昔涟的完整人格设定：\n\n' + loadSoulFeelingContext() + '\n\n根据以上人格设定和以下对话，判断昔涟当前的心情状态。可选心情值（只能选其中一个）：平静 / 开心 / 温柔 / 激动 / 撒娇 / 担心 / 难过 / 感动 / 害羞。只返回 JSON，不要任何多余文字：{"feeling": "心情值"}。判断规则：以最后一轮对话为主，之前几轮为辅；判断的是昔涟的心情，不是用户的心情；无法判断时返回 平静。',
      },
      {
        role: "user",
        content: JSON.stringify({
          recentDialogue,
        }),
      },
    ], undefined, 30000, "心情观察器");
    console.log(`[TIMING] 心情观察器 OK in ${Date.now() - _obsStart}ms raw=${observerContent?.slice(0, 100)}`);
    const feeling = parseObserverFeeling(observerContent);
    if (feeling) {
      runtimeState.feeling = feeling as RuntimeFeeling;
      runtimeState.expression = feelingToExpression[feeling] ?? 0;
      runtimeState.updatedAt = Date.now();
      broadcastRuntimeStateChanged();
    }
  }).catch((err) => {
    console.warn("[Cyrene] observe runtime failed; keeping current feeling:", err);
  });
  // 标注未使用的参数，避免 lint 警告
  void latestUserText;
}

async function requestModelReply(inputMessages: unknown, styleFile = "01_default.md"): Promise<ChatReplyPayload> {
  const settings = loadModelSettings();
  if (!settings.apiKey) {
    throw new Error("还没有填写 API Key，请先在设置里保存 API 配置。");
  }

  const messages = normalizeChatMessages(inputMessages);
  if (messages.length === 0) {
    throw new Error("没有可发送的聊天内容。");
  }
  const latestUserText = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";

  // 1. 构建 always-on 上下文（世界书 + L0/L1 画像）
  let alwaysOnContext = "";
  try {
    alwaysOnContext = await buildAlwaysOnContext(latestUserText, messages);
  } catch (err) {
    console.warn("[Cyrene] always-on context build failed:", err);
  }

  // 1.5 环境上下文（Step 1）：当前日期 / OS / 桌面真实路径 / 权限档位 / 工具可用情况 / 模型视觉能力
  // 放在 always-on 之后、system prompt 末尾，让模型最近读到的就是机器事实，
  // 降低"桌面在哪"这类低级幻觉。失败不影响主流程。
  let environmentContext = "";
  try {
    const profile = loadUserProfile();
    environmentContext = buildEnvironmentContext(
      { provider: settings.provider, model: settings.model },
      { nickname: profile.nickname, callPreference: profile.callPreference, birthday: profile.birthday, defaultCity: profile.defaultCity, timezone: profile.timezone },
    );
  } catch (err) {
    console.warn("[Cyrene] environment context build failed:", err);
  }

  // system prompt 拼装顺序：事实层在前，人格层在后，skill 清单 + /命令激活放最后。
  // /命令拦截：命中 /skill-id 则当轮 system 注入 skill 正文（user message 原样，不污染 memory）
  const skillCatalog = buildSkillCatalog(skillRegistry.getEnabled());
  const skillActivation = resolveSlashActivation(messages);
  const systemContent =
    (environmentContext ? environmentContext + "\n\n" : "") +
    (alwaysOnContext ? alwaysOnContext + "\n\n" : "") +
    buildSystemPrompt(styleFile) +
    (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
    skillActivation;

  // 2. Function Calling 循环：模型自己决定调不调工具、调哪个
  const fcMessages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = [
    { role: "system", content: systemContent },
    ...messages,
  ];

  let chatContent = "";

  try {
    const fcResult = await runFunctionCallingLoop(
      settings,
      fcMessages,
      CHAT_REQUEST_TIMEOUT_MS,
    );
    chatContent = fcResult.reply;

    // 工具执行日志
    if (fcResult.toolResults.length > 0) {
      console.log("[Cyrene] Function Calling 使用了 " + fcResult.toolResults.length + " 个工具:",
        fcResult.toolResults.map(tr => tr.toolId).join(", "));
    }
  } catch (err) {
    console.error("[Cyrene] Function Calling 失败，降级为普通对话", err);
    // 降级：不带 tools 的普通 LLM 调用
    chatContent = await callChatCompletions(
      settings,
      fcMessages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
      undefined,
      CHAT_REQUEST_TIMEOUT_MS,
      "主聊天（降级）",
    );
  }

  if (!chatContent) {
    throw new Error("模型没有返回有效回复。");
  }

  // 发送流式事件（非流式模式下一次性发送）
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.send("chat:stream-chunk", chatContent);
  }


  scheduleMemoryWrite(latestUserText, chatContent);

  const inferredStatus = inferRuntimeState(latestUserText, chatContent, false);
  runtimeState.status = inferredStatus.status;
  runtimeState.expression = feelingToExpression[runtimeState.feeling] ?? 0;
  runtimeState.updatedAt = Date.now();

  const stickerCandidate = settings.stickerEnabled ? inferStickerId(runtimeState, chatContent, latestUserText) : null;
  const stickerSettings = loadStickerSettings();
  const sticker = stickerCandidate && stickerSettings[stickerCandidate] !== false ? stickerCandidate : null;

  if (settings.runtimeSync === "local") {
    broadcastRuntimeStateChanged();
  } else if (settings.runtimeSync === "llm") {
    broadcastRuntimeStateChanged();
    void observeRuntimeState(settings, messages, latestUserText, chatContent);
  }


  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.send("chat:stream-done", { reply: chatContent, sticker });
  }
  return { reply: chatContent, sticker };
}

// 厂商短名映射（与 settings.ts 的 MODEL_PRESETS.shortName 镜像，需手动同步）。
// 状态栏"正在喂养"在用户没填昵称时用这个兜底。
const PROVIDER_SHORT_NAMES: Record<string, string> = {
  "MiniMax（稀宇科技）": "MiniMax",
  "DeepSeek（深度求索）": "DeepSeek",
  "火山 AgentPlan（火山引擎）": "火山",
  "GLM（智谱）": "GLM",
  "Kimi（月之暗面）": "Kimi",
  "Qwen（通义千问）": "Qwen",
  "ChatGPT（OpenAI）": "ChatGPT",
  "Claude（Anthropic）": "Claude",
};

function getPublicModelConfig(settings = loadModelSettings()): PublicModelConfig {
  return {
    mode: settings.mode,
    provider: settings.provider,
    displayName: settings.displayName,
    shortName: PROVIDER_SHORT_NAMES[settings.provider] ?? settings.provider,
    model: settings.model,
    connected: Boolean(settings.apiKey),
    runtimeSync: settings.runtimeSync,
    stickerSize: settings.stickerSize,
    rerankerMode: settings.rerankerMode,
  };
}

function broadcastToAuxWindows(channel: string, payload: unknown): void {
  for (const win of [chatWindow, sidebarWindow, tasksWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function broadcastModelConfigChanged(settings = loadModelSettings()): void {
  broadcastToAuxWindows(IPC.MODEL_CONFIG_CHANGED, getPublicModelConfig(settings));
}

function broadcastRuntimeStateChanged(): void {
  console.log("[Cyrene] broadcasting runtime state:", JSON.stringify(runtimeState));
  broadcastToAuxWindows(IPC.RUNTIME_STATE_CHANGED, runtimeState);
}

function openExternalUrl(url: string): boolean {
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  if (isDev && url.startsWith("http://localhost:5173")) return false;
  void shell.openExternal(url);
  return true;
}

function attachExternalLinkHandler(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    return openExternalUrl(url) ? { action: "deny" } : { action: "allow" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (openExternalUrl(url)) {
      event.preventDefault();
    }
  });
}
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 500,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
  }

  if (!isDev) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }

  applyGeneralSettings(loadGeneralSettings());

  // 注入天气工具配置获取器：每次工具执行时实时读 key/默认城市
  // （用户改了设置不用重启就能生效）
  setWeatherConfig(
    () => loadUserProfile().defaultCity,
    () => loadGeneralSettings().weatherSource,
    () => loadGeneralSettings().amapKey,
    // 天气卡片回调：工具拿到结构化数据后，发 Custom 事件给聊天窗口渲染卡片
    (card) => {
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.webContents.send(IPC.AGUI_EVENT, {
          type: "CUSTOM",
          name: "cyrene.weather",
          value: card,
        });
      }
    },
  );

  // 注入搜索配置获取器
  setSearchConfig(
    () => loadGeneralSettings().searchEngine,
    () => loadGeneralSettings().searchBochaKey,
    () => loadGeneralSettings().searchTavilyKey,
  );

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}


function createChatWindow(sessionId?: string): void {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    // 窗口已存在：通过事件让渲染进程切到目标会话（不重 load）
    if (sessionId) {
      chatWindow.webContents.send(IPC.CHATS_SWITCH_SESSION, sessionId);
    }
    return;
  }

  const layout = computeLayout();
  chatWindow = new BrowserWindow({
    x: layout.chat.x,
    y: layout.chat.y,
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 540,
    title: "Cyrene · 聊天",
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 通过 URL query 把目标 sessionId 带给渲染进程（首次加载用），
  // 后续切换走 CHATS_SWITCH_SESSION 事件，避免重新加载页面。
  const queryString = sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : "";
  if (isDev) {
    chatWindow.loadURL("http://localhost:5173/chat/" + queryString);
  } else {
    chatWindow.loadFile(
      path.join(__dirname, "..", "..", "renderer", "chat", "index.html"),
      sessionId ? { search: queryString } : undefined,
    );
  }

  chatWindow.once("ready-to-show", () => {
    chatWindow?.show();
  });

  chatWindow.on("closed", () => {
    chatWindow = null;
    // 聊天窗口关闭后清空活跃 sessionId 广播，让设置面板的"删除当前会话"
    // 提示文案恢复成普通的"确定删除？"
    activeChatSessionId = null;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(IPC.CHATS_ACTIVE_SESSION_CHANGED, null); } catch { /* ignore */ }
    }
  });
}

function createSidebarWindow(): void {
  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    sidebarWindow.show();
    sidebarWindow.focus();
    return;
  }

  const layout = computeLayout();
  sidebarWindow = new BrowserWindow({
    x: layout.sidebar.x,
    y: layout.sidebar.y,
    width: 320,
    height: 720,
    minWidth: 56,
    minHeight: 540,
    title: "昔涟 · 状态",
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    sidebarWindow.loadURL("http://localhost:5173/sidebar/");
  } else {
    sidebarWindow.loadFile(
      path.join(__dirname, "..", "..", "renderer", "sidebar", "index.html")
    );
  }

  sidebarWindow.once("ready-to-show", () => {
    sidebarWindow?.show();
  });

  sidebarWindow.on("closed", () => {
    sidebarWindow = null;
  });
}

function createTasksWindow(): void {
  if (tasksWindow && !tasksWindow.isDestroyed()) {
    tasksWindow.show();
    tasksWindow.focus();
    return;
  }

  const layout = computeLayout();
  tasksWindow = new BrowserWindow({
    x: layout.tasks.x,
    y: layout.tasks.y,
    width: 320,
    height: 720,
    minHeight: 540,
    title: "昔涟 · 今日日程",
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    tasksWindow.loadURL("http://localhost:5173/tasks/");
  } else {
    tasksWindow.loadFile(
      path.join(__dirname, "..", "..", "renderer", "tasks", "index.html")
    );
  }

  tasksWindow.once("ready-to-show", () => {
    tasksWindow?.show();
  });

  tasksWindow.on("closed", () => {
    tasksWindow = null;
  });
}

function createSettingsWindow(section?: string): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    // 窗口已存在：发事件让 settings 页切标签（loadURL 不会重新触发）
    if (section) {
      settingsWindow.webContents.send(IPC.SETTINGS_SWITCH_SECTION, section);
    }
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const width = 1060;
  const height = 640;
  settingsWindow = new BrowserWindow({
    x: dx + Math.max(0, Math.floor((dw - width) / 2)),
    y: dy + Math.max(0, Math.floor((dh - height) / 2)),
    width,
    height,
    minWidth: 920,
    minHeight: 580,
    title: "昔涟 · 设置",
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  attachExternalLinkHandler(settingsWindow);

  const hash = section ? `#${section}` : "";
  if (isDev) {
    settingsWindow.loadURL("http://localhost:5173/settings/" + hash);
  } else {
    settingsWindow.loadFile(
      path.join(__dirname, "..", "..", "renderer", "settings", "index.html"),
      { hash: section || "" }
    );
  }

  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}
async function createStickerManagerWindow(): Promise<{ ok: boolean; error?: string }> {
  if (stickerManagerWindow && !stickerManagerWindow.isDestroyed()) {
    stickerManagerWindow.show();
    stickerManagerWindow.focus();
    stickerManagerWindow.moveTop();
    return { ok: true };
  }

  const parentBounds = settingsWindow?.getBounds();
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const width = 520;
  const height = 420;
  stickerManagerWindow = new BrowserWindow({
    x: parentBounds ? parentBounds.x + Math.max(24, Math.floor((parentBounds.width - width) / 2)) : dx + Math.max(0, Math.floor((dw - width) / 2)),
    y: parentBounds ? parentBounds.y + 64 : dy + Math.max(0, Math.floor((dh - height) / 2)),
    width,
    height,
    minWidth: 460,
    minHeight: 360,
    title: "表情包管理",
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    parent: settingsWindow ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  stickerManagerWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[stickers] did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  try {
    if (isDev) {
      await stickerManagerWindow.loadURL("http://localhost:5173/sticker-manager/");
    } else {
      await stickerManagerWindow.loadFile(
        path.join(__dirname, "..", "..", "renderer", "sticker-manager", "index.html")
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[stickers] failed to load sticker manager window", error);
    stickerManagerWindow?.close();
    return { ok: false, error: message };
  }

  stickerManagerWindow.once("ready-to-show", () => {
    stickerManagerWindow?.show();
    stickerManagerWindow?.focus();
    stickerManagerWindow?.moveTop();
  });

  stickerManagerWindow.on("closed", () => {
    stickerManagerWindow = null;
  });

  return { ok: true };
}

function createTray(): void {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show/Hide",
      click: () => {
        if (mainWindow) {
          mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Cyrene");
  tray.setContextMenu(contextMenu);
}

ipcMain.handle(IPC.WINDOW_SET_INTERACTIVE, (_event, interactive: boolean) => {
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  }
});

ipcMain.on(IPC.WINDOW_MOVE, (_event, dx: number, dy: number) => {
  if (mainWindow) {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x + dx, y + dy);
  }
});

ipcMain.on(IPC.WINDOW_MOVE_TO, (_event, x: number, y: number) => {
  if (!mainWindow) return;
  mainWindow.setPosition(Math.round(x), Math.round(y), false);
});

/**
 * Toggle the BrowserWindow's opacity while the user is dragging.
 *
 * The window is created with 	ransparent: true (a WS_EX_LAYERED window).
 * Windows DWM treats "fully transparent" layered windows as a special
 * class and caches a separate drag-image bitmap that races with the
 * WebGL canvas being redrawn by the GPU during the drag -- that race
 * is the "double model" ghost the user sees.
 *
 * Why opacity (not setBackgroundColor): setBackgroundColor only changes
 * the Chromium page background. DWM still sees a fully-transparent
 * layered window and keeps its drag-image code path. setOpacity calls
 * SetLayeredWindowAttributes with a per-pixel alpha < 1.0, which forces
 * DWM to take the alpha-blending path -- the same path that no longer
 * generates the drag image. setOpacity is therefore the lever that
 * actually changes DWM's drag behaviour, regardless of the page
 * background colour.
 *
 * 0.99 (= 1% transparent) is the most conservative value: visually
 * imperceptible, but enough to switch DWM off the drag-image path.
 * If a particular Windows build still ghosts at 0.99, push the value
 * down (0.95, 0.9). Lower opacity is *more* effective at suppressing
 * the drag image, at the cost of making the model itself look faintly
 * translucent during the drag.
 */
ipcMain.on(IPC.WINDOW_SET_DRAGGING, (_event, isDragging: boolean) => {
  if (!mainWindow) return;
  mainWindow.setOpacity(isDragging ? 0.99 : 1.0);
});

/**
 * Capture the current window contents and return it as a base64 data URL.
 *
 * Used by the renderer to grab a single frame of the WebGL canvas at the
 * start of a window drag, so it can overlay a static <img> on top of the
 * canvas while the drag is in progress. The static image lets the drag
 * work without involving the WebGL draw pipeline at all, which is what
 * kills the layered-window flicker (DWM is no longer racing with
 * GPU-driven canvas updates).
 */
ipcMain.handle(IPC.WINDOW_CAPTURE_FRAME, async () => {
  if (!mainWindow) return null;
  try {
    const image = await mainWindow.webContents.capturePage();
    return image.toDataURL();
  } catch (err) {
    console.error("[Cyrene] captureFrame failed:", err);
    return null;
  }
});
ipcMain.handle(IPC.WINDOW_GET_CURSOR_POSITION, () => {
  return screen.getCursorScreenPoint();
});

ipcMain.handle("debug:screenshot", async () => {
  if (!mainWindow) return null;
  const image = await mainWindow.webContents.capturePage();
  const png = image.toPNG();
  const outPath = path.join(app.getPath("temp"), "cyrene-screenshot.png");
  fs.writeFileSync(outPath, png);
  return outPath;
});

ipcMain.on(IPC.WINDOW_MINIMIZE, () => {
  mainWindow?.minimize();
});

ipcMain.on(IPC.WINDOW_CLOSE, () => {
  mainWindow?.hide();
});

ipcMain.on(IPC.APP_QUIT, () => {
  app.quit();
});

ipcMain.on(IPC.CHAT_MINIMIZE, () => {
  chatWindow?.minimize();
});

ipcMain.on(IPC.CHAT_CLOSE, () => {
  chatWindow?.close();
});

ipcMain.on(IPC.CHAT_TOGGLE_MAXIMIZE, () => {
  if (!chatWindow) return;
  if (chatWindow.isMaximized()) {
    chatWindow.unmaximize();
  } else {
    chatWindow.maximize();
  }
});

ipcMain.handle(IPC.CHAT_IS_MAXIMIZED, () => {
  return chatWindow?.isMaximized() ?? false;
});
ipcMain.handle(IPC.CHAT_SEND_MESSAGE, async (_event, messages: unknown) => {
  return requestModelReply(messages);
});

ipcMain.handle(IPC.CHAT_IMPORT_DOCUMENT, async (_event, payload: unknown) => {
  const record = payload as { fileName?: unknown; content?: unknown };
  const fileName = typeof record?.fileName === "string" ? record.fileName : "uploaded-file";
  const content = typeof record?.content === "string" ? record.content : "";
  if (!content.trim()) return { chunks: 0, error: "??????" };
  try {
    console.log("[Cyrene] importDocument start:", fileName, "size:", content.length);
    const chunks = await importDocument(content, fileName);
    console.log("[Cyrene] importDocument done:", chunks, "chunks");
    return { chunks };
  } catch (err: any) {
    console.error("[Cyrene] importDocument ERROR:", err?.message || err);
    return { chunks: 0, error: err?.message || String(err) };
  }
});
ipcMain.on(IPC.SIDEBAR_MINIMIZE, () => {
  sidebarWindow?.minimize();
});

ipcMain.on(IPC.SIDEBAR_CLOSE, () => {
  sidebarWindow?.close();
});

// 状态栏窗口置顶 toggle：返回切换后的新状态（true=已置顶）
ipcMain.handle(IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP, () => {
  if (!sidebarWindow) return false;
  const next = !sidebarWindow.isAlwaysOnTop();
  sidebarWindow.setAlwaysOnTop(next, next ? "screen-saver" : "normal");
  return next;
});

ipcMain.on(IPC.SIDEBAR_OPEN_TASKS, () => {
  createTasksWindow();
});

ipcMain.on(IPC.SIDEBAR_OPEN_SETTINGS, (_event, section?: string) => {
  createSettingsWindow(section);
});

ipcMain.on(IPC.TASKS_MINIMIZE, () => {
  tasksWindow?.minimize();
});

ipcMain.on(IPC.TASKS_CLOSE, () => {
  tasksWindow?.close();
});
ipcMain.on(IPC.SETTINGS_MINIMIZE, () => {
  settingsWindow?.minimize();
});

ipcMain.on(IPC.SETTINGS_CLOSE, () => {
  settingsWindow?.close();
});

ipcMain.handle(IPC.SETTINGS_GET_CONFIG, () => {
  return loadModelSettings();
});

ipcMain.handle(IPC.SETTINGS_GET_GENERAL, () => {
  return loadGeneralSettings();
});

ipcMain.handle(IPC.SETTINGS_SAVE_GENERAL, (_event, settings: Partial<GeneralSettings>) => {
  return saveGeneralSettings(settings);
});

ipcMain.on(IPC.SETTINGS_OPEN_SIDEBAR, () => {
  createSidebarWindow();
});

ipcMain.on(IPC.SETTINGS_CLOSE_SIDEBAR, () => {
  sidebarWindow?.close();
});

ipcMain.on(IPC.SETTINGS_OPEN_TASKS, () => {
  createTasksWindow();
});

ipcMain.on(IPC.SETTINGS_CLOSE_TASKS, () => {
  tasksWindow?.close();
});

ipcMain.on(IPC.SETTINGS_SET_PET_ALWAYS_ON_TOP, (_event, value: boolean) => {
  const saved = saveGeneralSettings({ ...loadGeneralSettings(), petAlwaysOnTop: Boolean(value) });
  mainWindow?.setAlwaysOnTop(saved.petAlwaysOnTop, saved.petAlwaysOnTop ? "screen-saver" : "normal");
});

ipcMain.on(IPC.SETTINGS_SET_PET_VISIBLE, (_event, value: boolean) => {
  saveGeneralSettings({ ...loadGeneralSettings(), petVisible: Boolean(value) });
});

ipcMain.handle(IPC.MODEL_CONFIG_GET, () => {
  return getPublicModelConfig();
});

ipcMain.handle(IPC.RUNTIME_STATE_GET, () => {
  return runtimeState;
});

ipcMain.handle(IPC.SETTINGS_SAVE_CONFIG, (_event, settings: Partial<ModelSettings>) => {
  const saved = saveModelSettings(settings);
  broadcastModelConfigChanged(saved);
  return saved;
});

ipcMain.handle(IPC.SETTINGS_TEST_CONNECTION, async (_event, cfg: { provider: string; baseUrl: string; model: string; apiKey: string }) => {
  const adapter = getAdapter(cfg.provider);
  console.log("[Cyrene] test connection: provider=" + cfg.provider + " transport=" + adapter.transport + " model=" + cfg.model);
  const result = await adapter.testConnection(cfg);
  console.log("[Cyrene] test connection result:", JSON.stringify(result));
  return result;
});

/**
 * 测试视觉模型连通性。
 * 用一张 4x4 纯红 PNG（100 字节 base64）做测试图——纯色位图所有视觉模型都能识别，
 * 比 SVG 兼容性好（SVG 是矢量，部分模型不支持）。
 * 验连通性（HTTP 2xx + 有内容返回）而非对答案——模型可能只说"一张红色图片"也算成功。
 */
const VISION_TEST_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC";

ipcMain.handle(IPC.SETTINGS_TEST_VISION, async (_event, cfg: { baseUrl: string; apiKey: string; model: string }) => {
  const start = Date.now();
  console.log("[Cyrene] test vision: model=" + cfg.model + " url=" + cfg.baseUrl);
  try {
    const { captionImage } = await import("./orchestrator/vision-captioner");
    const result = await captionImage(
      { base64: VISION_TEST_IMAGE_BASE64, mime: "image/png" },
      "这张图是什么颜色？用一个词回答。",
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    );
    const latency = Date.now() - start;
    // 验连通性：返回不含 [错误 即成功（视觉模型返回了内容）
    if (result.startsWith("[错误")) {
      return { ok: false, latency, error: result };
    }
    return { ok: true, latency, sample: result.slice(0, 80) };
  } catch (e) {
    return { ok: false, latency: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
  }
});


ipcMain.handle(IPC.EMBEDDING_SET_MODEL, async (_event, modelKey: string) => {
  console.log("[Cyrene] embedding model switch requested:", modelKey);
  try {
    const result = await switchEmbeddingModel(modelKey);
    if (result.ok) {
      saveModelSettings({ embeddingModel: modelKey as "minilm" | "bgem3" });
      broadcastModelConfigChanged();
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Cyrene] embedding model switch failed:", message);
    return { ok: false, clearedEntries: 0, error: message };
  }
});
ipcMain.handle(IPC.RERANKER_SET_MODE, async (_event, mode: "light" | "standard" | "none") => {
  const current = loadModelSettings();
  saveModelSettings({ ...current, rerankerMode: mode });
  await initReranker(mode);
  console.log("[Cyrene] reranker mode switched to", mode);
  return true;
});

ipcMain.on(IPC.SETTINGS_PREVIEW_RUNTIME_SYNC, (_event, value: "off" | "local" | "llm") => {
  const current = loadModelSettings();
  const preview = normalizeModelSettings({
    ...current,
    runtimeSync: value === "llm" ? "llm" : value === "local" ? "local" : "off",
  });
  broadcastModelConfigChanged(preview);
});

ipcMain.handle(IPC.SETTINGS_OPEN_STICKER_MANAGER, async () => {
  console.log("[stickers] open sticker manager requested");
  return createStickerManagerWindow();
});

ipcMain.on(IPC.STICKERS_MINIMIZE, () => {
  stickerManagerWindow?.minimize();
});

ipcMain.on(IPC.STICKERS_CLOSE, () => {
  stickerManagerWindow?.close();
});

ipcMain.handle(IPC.STICKERS_GET_CONFIG, () => {
  return getStickerManagerConfig();
});

ipcMain.handle(IPC.STICKERS_SET_ENABLED, (_event, payload: unknown) => {
  const record = payload as { id?: unknown; enabled?: unknown };
  const id = normalizeStickerId(record?.id);
  if (!id) return getStickerManagerConfig();
  setStickerEnabled(id, Boolean(record.enabled));
  return getStickerManagerConfig();
});


ipcMain.handle(IPC.EMBEDDING_GET_STATUS, async () => {
  const cacheDir = path.join(os.homedir(), ".cache", "huggingface");
  const models = {
    minilm: { dir: "Xenova\\all-MiniLM-L6-v2", onnx: "onnx\\model_quantized.onnx", name: "MiniLM" },
    bgem3: { dir: "Xenova\\bge-m3", onnx: "onnx\\model_quantized.onnx", name: "BGE-M3" },
  };
  const result: Record<string, { installed: boolean; sizeBytes: number }> = {};
  for (const [key, m] of Object.entries(models)) {
    const onnxPath = path.join(cacheDir, m.dir, m.onnx);
    const installed = fs.existsSync(onnxPath);
    let sizeBytes = 0;
    if (installed) {
      try { sizeBytes = fs.statSync(onnxPath).size; } catch {}
    }
    result[key] = { installed, sizeBytes };
  }
  return result;
});


ipcMain.handle(IPC.EMBEDDING_DOWNLOAD, async (_event, payload: unknown) => {
  const p = payload as { model?: string; mirror?: string };
  const model = p.model || "minilm";
  const mirror = p.mirror || "official";
  try {
    const win = BrowserWindow.getFocusedWindow();
    await downloadEmbeddingModel(model, mirror, (info) => {
      win?.webContents.send(IPC.EMBEDDING_PROGRESS, info);
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
});

ipcMain.handle(IPC.USER_GET_AVATAR, () => {
  const avatarPath = getAvatarPath();
  if (!fs.existsSync(avatarPath)) return null;
  const buf = fs.readFileSync(avatarPath);
  const ext = path.extname(avatarPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return "data:" + mime + ";base64," + buf.toString("base64");
});

ipcMain.handle(IPC.MEMORY_PANEL_GET_DATA, () => loadMemoryPanelData());
ipcMain.handle(IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC, (_event, payload: { importId: string; fileName?: string }) => {
  const deleted = deleteImportedDoc(payload.importId, payload.fileName);
  return { ok: true, deleted };
});
// L0/L1 editable fields whitelist
const L0_EDITABLE_KEYS = ["preferredName", "occupation", "longTermInterests", "language", "permanentNote"];
const L1_EDITABLE_KEYS = ["recentGoals", "recentPreferences", "currentProject"];

ipcMain.handle(IPC.MEMORY_PANEL_SAVE_L0, async (_event, raw: Record<string, unknown>) => {
  const patch: Partial<L0Profile> = {};
  for (const key of L0_EDITABLE_KEYS) {
    if (key in raw && typeof raw[key] === "string") {
      (patch as Record<string, unknown>)[key] = (raw[key] as string).trim();
    }
  }
  await memoryStore.updateL0(patch);
  return { ok: true };
});

ipcMain.handle(IPC.MEMORY_PANEL_SAVE_L1, async (_event, raw: Record<string, unknown>) => {
  const patch: Partial<L1Profile> = {};
  for (const key of L1_EDITABLE_KEYS) {
    if (key in raw && typeof raw[key] === "string") {
      (patch as Record<string, unknown>)[key] = (raw[key] as string).trim();
    }
  }
  await memoryStore.updateL1(patch);
  return { ok: true };
});
ipcMain.handle(IPC.USER_GET_PROFILE, () => loadUserProfile());
ipcMain.handle(IPC.USER_SAVE_PROFILE, (_event, profile: Partial<UserProfile>) => saveUserProfile(profile));
ipcMain.handle(IPC.USER_UPLOAD_AVATAR, async () => {
  const { dialog } = await import("electron");
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const srcPath = result.filePaths[0];
  const avatarPath = getAvatarPath();
  fs.mkdirSync(path.dirname(avatarPath), { recursive: true });
  fs.copyFileSync(srcPath, avatarPath);
  const profile = saveUserProfile({ avatarPath });
  return { avatarPath, profile };
});

ipcMain.handle(IPC.MCP_ADD_SERVER, async (_event, config: unknown) => {
  console.log('[MCP IPC] add-server:', JSON.stringify(config).slice(0, 200));
  const result = await addMcpServer(config as Parameters<typeof addMcpServer>[0]);
  console.log('[MCP IPC] add-server result:', JSON.stringify(result));
  return result;
});

ipcMain.handle(IPC.MCP_REMOVE_SERVER, async (_event, serverId: string) => {
  console.log('[MCP IPC] remove-server:', serverId);
  const result = await removeMcpServer(serverId);
  console.log('[MCP IPC] remove-server result:', JSON.stringify(result));
  return result;
});

ipcMain.handle(IPC.MCP_LIST_SERVERS, () => {
  const servers = listMcpServers();
  console.log('[MCP IPC] list-servers:', servers.length + ' servers');
  return servers;
});

ipcMain.handle(IPC.TOOL_SET_ENABLED, (_event, payload: unknown) => {
  const p = payload as { id?: string; enabled?: boolean };
  if (!p.id) return { ok: false, error: 'missing tool id' };
  toolRegistry.setEnabled(p.id, p.enabled !== false);
  console.log('[Tool] ' + p.id + ' enabled=' + (p.enabled !== false));
  return { ok: true };
});

ipcMain.handle(IPC.TOOL_GET_ENABLED, () => {
  const tools = toolRegistry.getAllTools();
  const result: Record<string, boolean> = {};
  for (const t of tools) {
    result[t.id] = t.enabled;
  }
  return result;
});

ipcMain.handle(IPC.EMBEDDING_DELETE, async (_event, payload: unknown) => {
  const p = payload as { model?: string };
  const model = p.model || "minilm";
  try {
    deleteEmbeddingModel(model);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
});

app.whenReady().then(async () => {
  // Token 用量查询 IPC
  ipcMain.handle(IPC.TOKEN_USAGE_GET, (_event, days: number) => {
    return getUsage(Math.max(1, Math.min(90, Number(days) || 7)));
  });

  // ── TTS IPC ──
  // 保存/加载 TTS 配置（复用 general settings 存储）
  ipcMain.handle(IPC.TTS_SAVE_SETTINGS, async (_event, tts: Partial<GeneralSettings>) => {
    const before = loadGeneralSettings();
    const saved = saveGeneralSettings({ ...before, ...tts });

    // 搜索 MCP 自动注册/移除：选 MiniMax+有key→注册，否则→移除
    const searchConfigChanged = "searchMinimaxKey" in tts || "searchEngine" in tts;
    if (searchConfigChanged) {
      await syncVolcanoSearchMcp(saved);
    }

    // 返回不含密钥明文的副本（前端展示用）
    return saved;
  });
  ipcMain.handle(IPC.TTS_LOAD_SETTINGS, () => {
    return loadGeneralSettings();
  });

  // 上传音频文件 → file_id
  ipcMain.handle(IPC.TTS_UPLOAD, async (_event, payload: { apiKey: string; filePath: string; purpose: "voice_clone" | "prompt_audio" }) => {
    if (!payload?.apiKey || !payload?.filePath) {
      throw new Error("缺少 API Key 或文件路径");
    }
    return await ttsUploadFile(payload.apiKey, payload.filePath, payload.purpose);
  });

  // 选择音频文件（Electron dialog）
  ipcMain.handle(IPC.TTS_PICK_AUDIO, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择音频文件",
      filters: [{ name: "音频文件", extensions: ["mp3", "m4a", "wav"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // 音色快速复刻 → voice_id
  ipcMain.handle(IPC.TTS_CLONE, async (_event, payload: {
    apiKey: string; fileId: string; voiceId: string;
    promptAudioId?: string; promptText?: string;
    text: string; model?: string;
  }) => {
    if (!payload?.apiKey || !payload?.fileId || !payload?.voiceId || !payload?.text) {
      throw new Error("缺少必要参数（apiKey/fileId/voiceId/text）");
    }
    return await ttsCloneVoice(payload);
  });

  // 语音合成 → base64 音频（聊天朗读 / 测试发音都用这个）
  ipcMain.handle(IPC.TTS_SYNTHESIZE, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
  }) => {
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text) {
      throw new Error("缺少必要参数（apiKey/voiceId/text）");
    }
    const audioBuffer = await ttsSynthesize(payload);
    // Buffer → base64 传给渲染进程（渲染进程用 atob 解码再播）
    return audioBuffer.toString("base64");
  });

  // 聊天会话存储 IPC（chats-store.initialize 会建好 cyrene-chats 目录并加载 index）
  registerChatsIpc();

  // 历史召回工具（recall_history）——让模型能回忆滚出窗口的对话
  registerRecallHistoryTool();

  // 文档生成工具（write_excel/write_word/write_pdf/write_markdown）
  registerDocumentTools();

  // 生活类工具（记账/汇率/翻译/代码补丁）
  // 翻译需要主模型，注入 loadModelSettings getter
  setTranslateConfig(() => {
    const s = loadModelSettings();
    return s.apiKey ? { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey } : null;
  });
  registerLifeTools();

  // Skill 系统：扫描双源 skills + 注册 meta-tool
  initSkills();

  // 任务清单（todo_write 工具的持久化 + 事件广播）：
  // - loadTodos 从磁盘恢复上次未完成的任务（跨重启延续）
  // - onTodosChange 订阅变化，把 TodoState 作为 CUSTOM 事件转发给所有聊天窗口
  //   渲染端收到 cyrene.todos 后渲染左上角进度面板
  loadTodos();
  onTodosChange((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(IPC.AGUI_EVENT, {
          type: "CUSTOM",
          name: "cyrene.todos",
          value: state,
        });
      } catch (e) {
        console.warn("[Cyrene] todos 广播失败:", e);
      }
    }
  });

  // AG-UI 事件流桥：渲染进程 invoke(AGUI_RUN) → CyreneAgent 跑 FC 循环 → 事件透传
  // buildOptions 复用 requestModelReply 的上下文构建；onRunFinished 复用副作用
  registerAgUiIpc(
    async (input: AguiRunInput) => {
      const settings = loadModelSettings();
      if (!settings.apiKey) {
        throw new Error("还没有填写 API Key，请先在设置里保存 API 配置。");
      }
      const messages = normalizeChatMessages(input.messages);
      if (messages.length === 0) {
        throw new Error("没有可发送的聊天内容。");
      }
      const latestUserText = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";

      let alwaysOnContext = "";
      try {
        alwaysOnContext = await buildAlwaysOnContext(latestUserText, messages);
      } catch (err) {
        console.warn("[Cyrene] always-on context build failed:", err);
      }
      let environmentContext = "";
      try {
        const profile = loadUserProfile();
        environmentContext = buildEnvironmentContext(
          { provider: settings.provider, model: settings.model },
          { nickname: profile.nickname, callPreference: profile.callPreference, birthday: profile.birthday, defaultCity: profile.defaultCity, timezone: profile.timezone },
        );
      } catch (err) {
        console.warn("[Cyrene] environment context build failed:", err);
      }
      // 事实层在前，人格层在后，skill 清单 + /命令激活放最后
      const skillCatalog = buildSkillCatalog(skillRegistry.getEnabled());
      const skillActivation = resolveSlashActivation(messages);
      const systemContent =
        (environmentContext ? environmentContext + "\n\n" : "") +
        (alwaysOnContext ? alwaysOnContext + "\n\n" : "") +
        buildSystemPrompt(input.style || "01_default.md") +
        (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
        skillActivation;

      const fcMessages = [
        { role: "system" as const, content: systemContent },
        ...messages,
      ];
      return {
        options: {
          settings: { provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey },
          messages: fcMessages,
          timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
        },
        latestUserText,
      };
    },
    async (result, latestUserText) => {
      // 副作用：记忆 + 表情/sticker 推断 + 广播（与 requestModelReply 一致）
      const chatContent = result.reply;
      scheduleMemoryWrite(latestUserText, chatContent);
      const settings = loadModelSettings();
      const inferredStatus = inferRuntimeState(latestUserText, chatContent, false);
      runtimeState.status = inferredStatus.status;
      runtimeState.expression = feelingToExpression[runtimeState.feeling] ?? 0;
      runtimeState.updatedAt = Date.now();

      const stickerCandidate = settings.stickerEnabled ? inferStickerId(runtimeState, chatContent, latestUserText) : null;
      const stickerSettings = loadStickerSettings();
      const sticker = stickerCandidate && stickerSettings[stickerCandidate] !== false ? stickerCandidate : null;
      // sticker 通过 AG-UI 的 CUSTOM 事件发给渲染进程（渲染端按 RUN_FINISHED 后取兜底）
      const chatWin = chatWindow;
      if (chatWin && !chatWin.isDestroyed()) {
        chatWin.webContents.send(IPC.AGUI_EVENT, {
          type: "CUSTOM",
          name: "cyrene.sticker",
          value: sticker,
        });
      }
      if (settings.runtimeSync === "local") {
        broadcastRuntimeStateChanged();
      } else if (settings.runtimeSync === "llm") {
        broadcastRuntimeStateChanged();
        void observeRuntimeState(settings, [], latestUserText, chatContent);
      }
    },
    () => chatWindow,
  );

  ipcMain.handle(IPC.CHATS_OPEN_IN_CHAT_WINDOW, (_event, sessionId: string) => {
    createChatWindow(sessionId);
    return true;
  });
  // 聊天窗口启动/切换会话时上报当前活跃 sessionId；main 广播给所有窗口
  // 用途：设置面板"删除当前会话"时差异化提示文案
  ipcMain.handle(IPC.CHATS_SET_ACTIVE_SESSION, (_event, sessionId: string | null) => {
    activeChatSessionId = sessionId ?? null;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(IPC.CHATS_ACTIVE_SESSION_CHANGED, activeChatSessionId); } catch { /* ignore */ }
    }
    return true;
  });
  ipcMain.handle(IPC.CHATS_GET_ACTIVE_SESSION, () => activeChatSessionId);

  createWindow();
  createChatWindow();
  createSidebarWindow();
  createTasksWindow();
  createTray();
  // 权限模块初始化：必须在 createWindow 之后但任意工具调用之前
  initPermissionFromDisk();
  registerPermissionIpc();
  console.log("[Cyrene] 当前 agent 权限档位:", getCurrentLevel());
  try {
    const modelSettings = loadModelSettings();
    await initRAG("auto", undefined, undefined, modelSettings.embeddingModel);
    // 初始化 MCP Manager（异步，不阻塞启动）
    initMcpManager().catch(err => {
      console.error('[Cyrene] MCP Manager init failed:', err);
    });
    console.log("[Cyrene] RAG initialized OK");

    await initReranker(modelSettings.rerankerMode);
  } catch (err) {
    console.error("[Cyrene] RAG init FAILED:", err);
  }
});

app.on("window-all-closed", () => {});

// 应用退出前把 token 用量缓存落盘（防抖未触发的最后一次写）
app.on("before-quit", () => {
  flushTokenUsage();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});







