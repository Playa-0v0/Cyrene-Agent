import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, shell, dialog, protocol, net, powerMonitor } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createHash, randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { IPC } from "../shared/ipc-channels";
import { normalizeUiTheme, type UiTheme } from "../shared/ui-theme";
import { DEFAULT_UI_FONT, isSupportedFontFileName, normalizeUiFont, type UiFont } from "../shared/ui-font";
import { normalizeUiIcon, UI_ICON_PRESETS, type UiIcon } from "../shared/ui-icon";
import { foldReasoning, normalizeReasoningPreference, type ReasoningPreference } from "../shared/reasoning";
import { getUiFontResponseHeaders, isSafeUiFontRequest } from "./ui-font-protocol";
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
} from "../shared/preferences";
import { STATUS_KEYWORDS } from "./status-keywords";
import {
  addL2MemoryVector,
  addMemory,
  buildMemoryContext,
  deleteImportedDoc,
  deleteUserMemoryVectors,
  getEntriesBySource,
  initRAG,
  isUserMemoryVectorStoreReady,
  switchEmbeddingModel,
} from "./rag";
import { getEmbeddingProvider, getSceneEmbeddingProvider } from "./rag/embedding";
import { describePendingAttachment } from "./rag/file-ingest";
import { cancelDocumentIndexJob, configureDocumentIndexQueue, enqueueDocumentIndexJob } from "./rag/document-index-queue";
import { retrieveQueuedDocumentChunks, runDocumentIndexJob } from "./rag/document-index-worker";
import { processDocumentIndexRequest } from "./rag/document-index-ipc";
import { IMAGE_CAPTION_PROMPT, validateCaptionImagePath } from "./chat/image-caption";
import { decideImageSendStrategy } from "./chat/image-send-strategy";
import { buildAlwaysOnContext, buildMemoryInjection, runFunctionCallingLoop, scheduleMemoryWrite } from "./orchestrator";
import { CyreneAgent } from "./orchestrator/cyrene-agent";
import { indexConversationTurn } from "./orchestrator/history-tools";
import { buildToneInjection } from "./orchestrator/tone-injector";
import { getAdapter, buildVendorUrl, getAdapterForConfig, createSseReader } from "./orchestrator/vendors";
import type { VendorConfig } from "./orchestrator/vendors";
import { getCapability, getCapabilityOrOpenAI } from "./orchestrator/vendors/capabilities";
import type { VisionConfig } from "./orchestrator/vision-captioner";
import { toolRegistry, type ToolDefinition } from "./orchestrator/tool-registry";
import { buildToolCatalog } from "./orchestrator/tool-catalog";
import type { ToolRiskLevel } from "./permission";
import { loadChannelsSettings } from "./channels/settings-store";
import { channelManager } from "./channels/manager";
import { canStartProactiveChannelDelivery, sendProactiveChannelMessage } from "./channels/proactive-delivery";
// 触发 built-in-tools 的副作用注册（fetch_url / run_shell / install_mcp_server）
import "./orchestrator/built-in-tools";
// 触发 fs-tools 的副作用注册（read_file / list_dir / write_file / read_image）
import "./orchestrator/fs-tools";
import { initMcpManager, addMcpServer, removeMcpServer, listMcpServers, pruneMcpServersByIds } from "./orchestrator/mcp-manager";
import { syncPlaywrightMcp, PLAYWRIGHT_MCP_ID, REMOVED_BUILTIN_MCP_IDS } from "./sync-mcp-builtin";
import { buildEnvironmentContext } from "./orchestrator/environment";
import { initPermissionFromDisk, registerPermissionIpc, getCurrentLevel } from "./permission";
import { registerChoiceIpc, setChoiceCardSender } from "./user-choice";
import { enqueueLLMTask } from "./llm-queue";
import { getEmbeddingStatus, downloadEmbeddingModel, deleteEmbeddingModel } from "./embedding-manager";
import { BUILT_IN_STICKER_DESCRIPTIONS } from "./sticker-descriptions";
import { buildCachedStickerEmbeddingIndex } from "./sticker-embedding-cache";
import { matchSticker } from "./sticker-embedder";
import type { StickerEmbeddingEntry } from "./sticker-embedder";
import { buildCachedSceneIndex } from "./scene-embedding-cache";
import type { SceneIndex } from "./scene-embedder";
import { loadUserStickerManifest, addUserSticker, deleteUserSticker, getAllStickerConfig, isStickerIdTaken, getStickersDir } from "./sticker-storage";
import { parseLocalStickerFileFromUrl, resolveLocalStickerPath } from "./sticker-protocol";
import { normalizeWindowVisibilitySettings } from "./window-visibility-settings";
import { PetWindowMoveController } from "./pet-window-movement";
import type { StickerConfigItem } from "../shared/sticker-types";
import { initReranker, getRerankerInstallStatus } from "./rag/reranker";
import { memoryStore } from "./memory/memory-store"
import { backupMemoryRagFiles, reconcileMemoryRag } from "./memory/memory-rag-reconciliation";
import type { L0Profile, L1Profile } from "./memory/memory-types";
import { broadcastChatsChanged, registerChatsIpc } from "./chats/chats-ipc";
import * as chatsStore from "./chats/chats-store";
import { recordUsage, getUsage, flush as flushTokenUsage } from "./token-usage-store";
import { uploadFile as ttsUploadFile, cloneVoice as ttsCloneVoice, synthesize as ttsSynthesize } from "./tts/minimax-engine";
import { synthesize as gptsovitsSynthesize } from "./tts/gptsovits-engine";
import { synthesize as customCloudSynthesize } from "./tts/custom-cloud-engine";
import { synthesize as mimoSynthesize } from "./tts/mimo-engine";
import { synthesizeByEngine } from "./tts/tts-dispatcher";
import { startOpener, stopOpener, setLive2dWindow, reloadManifest, handleBubbleClick, handleChatWindowOpened, testFire, setProactiveCandidateHandler, getPresetFallback } from "./opener/opener-runner";
import { loadState as loadOpenerState, saveState as saveOpenerState } from "./opener/desire-engine";
import type { ShowBubblePayload } from "./opener/opener-types";
import { SCENE_CONFIGS } from "./opener/scenes-config";
import { getManifestPath, getOpenerPackDir } from "./opener/opener-pack-store";
import { registerAgUiIpc, type AguiRunInput } from "./agui-bridge";
import { setWeatherConfig, setSearchConfig, loadTodos, onTodosChange, setDelegateSettings } from "./orchestrator/built-in-tools";
import { registerRecallHistoryTool } from "./orchestrator/history-tools";
import { registerDocumentTools } from "./orchestrator/document-tools";
import { registerLifeTools, setTranslateConfig } from "./orchestrator/life-tools";
import { registerTravelTools, setTravelConfig } from "./orchestrator/travel-tools";
import { registerEmailTools, setEmailConfig } from "./orchestrator/email-tools";
import { resolveMusicPaths } from "./music/paths";
import { bootstrapMusicService } from "./music/bootstrap";
import { installShutdownLatch } from "./music/shutdown-latch";
import {
  buildConversationTimeContext,
  normalizeChatMessagesWithTime,
  resolveChatContextTimezone,
  type ChatContextMessage,
} from "./chat-time-context";
import { setAsrConfig } from "./asr/volcano-asr-engine";
import { setCallWindow, registerCallIpc, setCallSettings, stopCall } from "./call/call-manager";
import { initSkills, skillRegistry, buildAutoInjectedSkillContext, buildSkillCatalog, parseSlashCommand, setSkillEnabled, listSkillsForUi } from "./skills";
import {
  buildMusicCompanionContext,
  isMusicCompanionAvailable,
  loadMusicCompanionHost,
  recordMusicCompanionPresentation,
} from "./skills/music-companion-host";
import { initGameBot } from "./game-bot";
import { initChannels, shutdownChannels, setChannelsConversationLifecycle } from "./channels/init";
import { buildChannelAttachmentInputs } from "./channels/agent-input";
import { setDispatcherBuildAndRunAgent, setDispatcherSynthesizeTts, setDispatcherBroadcastChat, setDispatcherLoadGeneralSettings, setDispatcherLoadRecentHistory } from "./channels/dispatcher";
import { createWindowLifecycleTracker } from "./electron-window-lifecycle";
import {
  buildAgentRunOptions,
  onAgentRunFinished,
  type BuildOptionsDeps,
  type OnRunFinishedDeps,
} from "./orchestrator/build-options";
import { buildRelationshipContext, recordRelationshipTurn } from "./relationship/relationship-log";
import { createFeelingScores, smoothFeeling } from "./orchestrator/runtime-state-smoother";
import { getSchedulerStore } from "./scheduler/scheduler-store";
import { SchedulerEngine } from "./scheduler/scheduler-engine";
import { createSchedulerRunner } from "./scheduler/scheduler-runner";
import { registerSchedulerIpc } from "./scheduler/scheduler-ipc";
import type { ScheduledTask } from "./scheduler/types";
import {
  createProactiveChatService,
  type ProactiveChatService,
  type ProactiveCommitInput,
  type ProactiveCommitResult,
} from "./proactive/proactive-service";
import { routeProactiveDelivery } from "./proactive/proactive-delivery-routing";
import { buildProactiveMessages, type ProactiveHistoryTurn } from "./proactive/proactive-prompt";
import { runProactiveModel } from "./proactive/proactive-model";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot } from "./proactive/proactive-types";
import { canCommitProactiveMessage } from "./proactive/proactive-policy";
import { getTimeoutSettings, saveTimeoutSettings } from "./timeout-manager";
import { TimeoutSettings } from "../shared/timeout-types";

configureDocumentIndexQueue(runDocumentIndexJob);

async function reconcileUserMemoryIndex(): Promise<void> {
  if (!isUserMemoryVectorStoreReady()) {
    console.warn("[Memory/RAG] reconciliation skipped: vector store is not writable");
    return;
  }
  const report = await reconcileMemoryRag({
    getMemories: () => memoryStore.getAllL2(),
    getVectors: () => getEntriesBySource("user_memory"),
    backup: async () => backupMemoryRagFiles(app.getPath("userData")),
    addVector: addL2MemoryVector,
    markSynced: (l2Id, ragId) => memoryStore.markL2SyncStatus(l2Id, "synced", ragId),
    markSyncFailed: (l2Id, error) => memoryStore.markL2SyncStatus(l2Id, "sync_failed", undefined, error),
    deleteVectors: (ids) => deleteUserMemoryVectors(ids),
    warn: (message, error) => console.warn(`[Memory/RAG] ${message}:`, error),
  });
  console.log("[Memory/RAG] reconciliation:", report);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let chatWindow: BrowserWindow | null = null;
let sidebarWindow: BrowserWindow | null = null;
let tasksWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let stickerManagerWindow: BrowserWindow | null = null;
let callWindow: BrowserWindow | null = null;
let schedulerEngine: SchedulerEngine | null = null;
let proactiveChatService: ProactiveChatService | null = null;
let normalConversationBusyCount = 0;
let proactiveScreenLocked = false;
const petWindowMoveController = new PetWindowMoveController(
  () => mainWindow,
  ({ x, y }) => {
    saveGeneralSettings({ petWindowX: x, petWindowY: y });
  },
);
const live2dWindowLifecycle = createWindowLifecycleTracker<BrowserWindow>("live2d-main", {
  onClosed: () => setLive2dWindow(null),
});
// 聊天窗口当前活跃的会话 id（通过 IPC 由聊天窗口上报）；
// 设置面板"删除当前会话"差异化提示用。聊天窗口关闭时由 closed 事件置 null。
let activeChatSessionId: string | null = null;

const isDev = process.env.VITE_DEV === "1";

function appendMinimaxTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "minimax-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
    if (entry.phase === "request.begin") {
      console.log("[TTS MiniMax] 诊断日志:", logFile);
    }
  } catch (err) {
    console.warn("[TTS MiniMax] 写诊断日志失败:", err);
  }
}

function appendGptsovitsTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "gptsovits-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
    if (entry.phase === "request.begin") {
      console.log("[TTS GPT-SoVITS] 诊断日志:", logFile);
    }
  } catch (err) {
    console.warn("[TTS GPT-SoVITS] 写诊断日志失败:", err);
  }
}

function appendCustomCloudTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "custom-cloud-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
    if (entry.phase === "request.begin") {
      console.log("[TTS CustomCloud] 诊断日志:", logFile);
    }
  } catch (err) {
    console.warn("[TTS CustomCloud] 写诊断日志失败:", err);
  }
}

function appendMimoTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "mimo-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
    if (entry.phase === "request.begin") {
      console.log("[TTS MiMo] 诊断日志:", logFile);
    }
  } catch (err) {
    console.warn("[TTS MiMo] 写诊断日志失败:", err);
  }
}

function getTtsCacheDir(): string {
  return path.join(app.getPath("userData"), "cyrene-tts-cache");
}

function assertTtsCacheKey(cacheKey: string): string {
  if (!/^(minimax|gptsovits|custom-cloud|mimo)-[a-f0-9]{64}$/.test(cacheKey)) {
    throw new Error("非法 TTS 缓存 key");
  }
  return cacheKey;
}

function buildTtsCacheKey(payload: {
  voiceId: string;
  text: string;
  speed?: number;
  volume?: number;
  pitch?: number;
  model?: string;
  format?: "mp3" | "wav" | "pcm";
}): string {
  const source = JSON.stringify({
    version: 1,
    engine: "minimax",
    model: payload.model ?? "speech-2.8-hd",
    voiceId: payload.voiceId,
    speed: payload.speed ?? 1,
    volume: payload.volume ?? 1,
    pitch: payload.pitch ?? 0,
    format: payload.format ?? "mp3",
    text: payload.text,
  });
  return "minimax-" + createHash("sha256").update(source, "utf8").digest("hex");
}

function buildGptsovitsCacheKey(payload: {
  baseUrl: string;
  refAudioPath: string;
  promptText: string;
  text: string;
  speed?: number;
  format?: "wav" | "mp3";
}): string {
  const source = JSON.stringify({
    version: 1,
    engine: "gptsovits",
    baseUrl: payload.baseUrl,
    refAudioPath: payload.refAudioPath,
    promptText: payload.promptText,
    speed: payload.speed ?? 1,
    format: payload.format ?? "wav",
    text: payload.text,
  });
  return "gptsovits-" + createHash("sha256").update(source, "utf8").digest("hex");
}

function buildCustomCloudCacheKey(payload: {
  endpointUrl: string;
  voiceId?: string;
  text: string;
  speed?: number;
  volume?: number;
  format?: "wav" | "mp3";
}): string {
  const source = JSON.stringify({
    version: 1,
    engine: "custom-cloud",
    endpointUrl: payload.endpointUrl,
    voiceId: payload.voiceId ?? "",
    speed: payload.speed ?? 1,
    volume: payload.volume ?? 1,
    format: payload.format ?? "mp3",
    text: payload.text,
  });
  return "custom-cloud-" + createHash("sha256").update(source, "utf8").digest("hex");
}

function buildMimoCacheKey(payload: {
  voiceAudioPath?: string;
  text: string;
  stylePrompt?: string;
}): string {
  const source = JSON.stringify({
    version: 1,
    engine: "mimo",
    model: "mimo-v2.5-tts-voiceclone",
    voiceAudioPath: payload.voiceAudioPath ?? "",
    stylePrompt: payload.stylePrompt ?? "",
    format: "wav",
    text: payload.text,
  });
  return "mimo-" + createHash("sha256").update(source, "utf8").digest("hex");
}

function getTtsCachePath(cacheKey: string, format: "mp3" | "wav" | "pcm" = "mp3"): string {
  const safeKey = assertTtsCacheKey(cacheKey);
  const ext = format === "wav" ? "wav" : format === "pcm" ? "pcm" : "mp3";
  return path.join(getTtsCacheDir(), `${safeKey}.${ext}`);
}

// 单个厂商的可缓存配置：用户切到别的厂商再切回来，这三个字段从这里恢复。
interface ProviderProfile {
  baseUrl: string;
  model: string;
  apiKey: string;
  displayName?: string;
  /**
   * 用户在 settings 显式指定的 transport；"auto" = 按 baseUrl 启发式 + capabilities fallback。
   * resolveTransport() 负责把 "auto" 解析为具体 transport。
   * 不存 = 等价于 "auto"。
   */
  explicitTransport?: "openai" | "anthropic" | "auto";
  /**
   * 用户保存的推理偏好（source of truth）。顶层 ModelSettings.reasoning 是当前厂商镜像。
   * 当前模型不支持某个 effort 时仍保留 user preference，
   * 实际请求时由 resolveEffectiveReasoning 决定 effective config。
   */
  reasoning?: ReasoningPreference;
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
  /**
   * 当前厂商的 explicitTransport 镜像（顶层字段是 perProvider[currentProvider] 的视图）。
   * 详见 ProviderProfile.explicitTransport。
   */
  explicitTransport?: "openai" | "anthropic" | "auto";
  /**
   * 当前厂商 reasoning 偏好的顶层镜像（与 explicitTransport 同思路）。
   * 真值在 perProvider[currentProvider].reasoning；顶层字段是 view。
   * 保存的是用户 preference（不覆盖）；effective config 由 capability 决定。
   */
  reasoning?: ReasoningPreference;
  // 按厂商缓存：currentProvider 之外的厂商配置也保留在这里，切回来时回填。
  // 真值（source of truth）是 perProvider；顶层 baseUrl/model/apiKey 是当前厂商那一份的展开镜像，
  // 仅为兼容现有 main 进程里大量直接读 settings.baseUrl 等代码而保留。
  perProvider: Record<string, ProviderProfile>;
  runtimeSync: "off" | "local" | "llm";
  stickerEnabled: boolean;
  stickerSize: StickerSize;
  stickerSimilarityThreshold: number;
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
  /** 桌宠缩放因子：1.0=默认，0.5~2.0，窗口与模型同步等比缩放。 */
  petZoom: number;
  /** 桌宠窗口 X 坐标，未保存时为 undefined */
  petWindowX?: number;
  /** 桌宠窗口 Y 坐标，未保存时为 undefined */
  petWindowY?: number;
  disableGpuElectron?: boolean;
  sidebarVisible: boolean;
  tasksVisible: boolean;
  launchAtLogin: boolean;
  language: "zh-CN";
  uiTheme: UiTheme;
  uiFont: UiFont;
  uiIcon: UiIcon;
  /** 聊天窗口打开时默认选中的模式。 */
  defaultChatMode: DefaultChatMode;
  /** 聊天气泡分段输出偏好。 */
  segmentedOutputMode: SegmentedOutputMode;
  /** 手机渠道文本消息分段发送偏好。 */
  mobileMessageSegmentation: MobileMessageSegmentationMode;
  /** 主动聊天功能开关占位；当前不接实际逻辑。 */
  proactiveChatMode: ProactiveChatMode;
  /** 主动消息最终投递到本地、微信或飞书。 */
  proactiveDeliveryTarget: ProactiveDeliveryTarget;
  // TTS 配置
  ttsEngine: "off" | "minimax" | "gptsovits" | "custom-cloud" | "mimo";
  ttsAutoRead: boolean;
  ttsSpeed: number;
  ttsVolume: number;
  // MiniMax
  ttsMinimaxKey: string;
  ttsMinimaxVoiceId: string;
  /** MiniMax 合成模型：speech-2.8-hd(高保真¥3.5/万字符) | speech-2.8-turbo(极速¥2.0/万字符) */
  ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  /** MiniMax 流式播放（边合成边播，首字延迟低）；false=完整合成收完再播 */
  ttsStreaming: boolean;
  // GPT-SoVITS（本地）
  ttsGptsovitsBaseUrl: string;
  ttsGptsovitsRefAudioPath: string;
  ttsGptsovitsPromptText: string;
  ttsGptsovitsFormat: "wav" | "mp3";
  // 自定义云端 TTS
  ttsCustomCloudEndpointUrl: string;
  ttsCustomCloudApiKey: string;
  ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3";
  ttsCustomCloudTimeoutMs: number;
  // 小米 MiMo TTS
  ttsMimoKey: string;
  ttsMimoVoiceAudioPath: string;
  ttsMimoStylePrompt: string;
  /** 天气源：open-meteo(免配置默认) | amap(高德,需填key) */
  weatherSource: "open-meteo" | "amap";
  /** 天气插件是否启用（开关） */
  weatherEnabled: boolean;
  /** 高德天气 key（https://lbs.amap.com 注册 Web服务 key） */
  amapKey: string;
  /** 🚗出行工具是否启用 */
  travelEnabled: boolean;
  /** 🖥️ 浏览器自动化（Playwright MCP）是否启用。默认 false，需用户手动开启。 */
  playwrightMcpEnabled: boolean;
  // 联网搜索：选哪个搜索源 + 对应 key
  searchEngine: "off" | "bocha" | "tavily" | "minimax";
  searchBochaKey: string;
  searchTavilyKey: string;
  searchMinimaxKey: string;
  /** ✉️邮件发送插件是否启用 */
  emailEnabled: boolean;
  /** SMTP 主机，如 smtp.qq.com */
  emailSmtpHost: string;
  /** SMTP 端口，如 465（SSL）/ 587（STARTTLS） */
  emailSmtpPort: number;
  /** 使用 SSL/TLS（465 通常 true，587 通常 false；用户可覆盖） */
  emailSmtpSecure: boolean;
  /** 发件邮箱地址 */
  emailSmtpUser: string;
  /** SMTP 授权码（非邮箱登录密码） */
  emailSmtpPass: string;
  /** 发件人显示名（可选） */
  emailFromName: string;
  /** 🎧ASR 服务商：off(关闭) | aliyun(阿里云) | local(本地,占位) */
  asrEngine: "off" | "aliyun" | "local";
  /** 阿里云智能语音交互 AppKey */
  asrAliyunAppKey: string;
  /** 阿里云 RAM AccessKey ID */
  asrAliyunAccessKeyId: string;
  /** 阿里云 RAM AccessKey Secret */
  asrAliyunAccessKeySecret: string;
  /** ASR 识别语言：zh(中文) | en(英文) | auto(自动) */
  asrLanguage: "zh" | "en" | "auto";
  /** VAD 静默检测阈值（毫秒），500~2000，默认 1000 */
  asrVadSilenceMs: number;
  /** VAD 音量阈值（0~1），默认 0.01。环境吵或麦克风音量低时可调 */
  asrVadThreshold: number;
  /** 通话中显示文字转写 */
  asrShowTranscript: boolean;
  /** Opener 主动开口档位 */
  openerMode: "off" | "quiet" | "normal" | "lively";
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
type StickerSize = "small" | "standard" | "large";

interface RuntimeState {
  status: RuntimeStatus;
  feeling: RuntimeFeeling;
  expression: number;
  updatedAt: number;
}

interface ChatReplyPayload {
  reply: string;
  sticker: string | null;
}

const RUNTIME_STATUSES: RuntimeStatus[] = ["陪伴中", "思考中", "工作中", "聆听中", "提醒中", "离线"];
const RUNTIME_FEELINGS: RuntimeFeeling[] = ["平静", "开心", "温柔", "激动", "撒娇", "担心", "难过", "感动", "害羞"];
const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 300000; // FC 总预算：20 轮 × 推理模型 ~10-15s 需 300s 余量

/** 桌宠窗口的基础尺寸（zoom=1.0 时）。缩放因子改变窗口与模型尺寸，二者同步。 */
const PET_WINDOW_BASE_WIDTH = 400;
const PET_WINDOW_BASE_HEIGHT = 500;
const STARTUP_EMBEDDING_REFRESH_DELAY_MS = 1500;

function getAppIconPath(icon: UiIcon): string {
  const preset = UI_ICON_PRESETS.find((item) => item.id === icon);
  return path.join(__dirname, "..", "..", "..", "assets", "icon-presets", preset?.fileName ?? "cyrene-sun.png");
}

function getCurrentAppIconPath(): string {
  return getAppIconPath(loadGeneralSettings().uiIcon);
}
let runtimeState: RuntimeState = {
    status: "陪伴中",
    feeling: "平静",
    expression: 0,
    updatedAt: Date.now(),
  };
let feelingScores = createFeelingScores(runtimeState.feeling);
let stickerEmbeddingIndex: StickerEmbeddingEntry[] | null = null;
let stickerEmbeddingRefreshSeq = 0;
let sceneEmbeddingIndex: SceneIndex | null = null;
let sceneEmbeddingRefreshSeq = 0;

function refreshStickerEmbeddingIndexInBackground(reason: string): void {
  const seq = ++stickerEmbeddingRefreshSeq;
  void (async () => {
    try {
      const provider = getEmbeddingProvider();
      if (!provider) {
        if (seq === stickerEmbeddingRefreshSeq) stickerEmbeddingIndex = null;
        console.warn("[StickerEmbedding] Model not found. Sticker matching disabled.");
        return;
      }

      const index = await buildCachedStickerEmbeddingIndex(
        provider,
        BUILT_IN_STICKER_DESCRIPTIONS,
        loadUserStickerManifest(),
      );
      if (seq !== stickerEmbeddingRefreshSeq) return;
      stickerEmbeddingIndex = index;
      console.log(`[StickerEmbedding] index ready (${reason}): ${index.length} entries`);
    } catch (err) {
      if (seq === stickerEmbeddingRefreshSeq) stickerEmbeddingIndex = null;
      console.error("[StickerEmbedding] refresh failed:", err instanceof Error ? err.message : String(err));
    }
  })();
}

function refreshSceneEmbeddingIndexInBackground(reason: string): void {
  const seq = ++sceneEmbeddingRefreshSeq;
  void (async () => {
    try {
      const sceneProvider = getSceneEmbeddingProvider();
      if (!sceneProvider) {
        if (seq === sceneEmbeddingRefreshSeq) sceneEmbeddingIndex = null;
        console.warn("[SceneEmbedding] bge-m3 model not found. Scene embedding disabled.");
        return;
      }

      const index = await buildCachedSceneIndex(sceneProvider);
      if (seq !== sceneEmbeddingRefreshSeq) return;
      sceneEmbeddingIndex = index;
      console.log("[SceneEmbedding] index ready:", Object.keys(index.scenes).length, "scenes", `(${reason})`);
    } catch (err) {
      if (seq === sceneEmbeddingRefreshSeq) sceneEmbeddingIndex = null;
      console.error("[SceneEmbedding] refresh failed:", err instanceof Error ? err.message : String(err));
    }
  })();
}

function scheduleStartupEmbeddingRefreshes(): void {
  setTimeout(() => {
    refreshStickerEmbeddingIndexInBackground("startup");
    refreshSceneEmbeddingIndexInBackground("startup");
  }, STARTUP_EMBEDDING_REFRESH_DELAY_MS);
}

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
  stickerSimilarityThreshold: 0.55,
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
  petZoom: 1,
  sidebarVisible: true,
  tasksVisible: true,
  launchAtLogin: false,
  language: "zh-CN",
  uiTheme: "classic",
  uiFont: DEFAULT_UI_FONT,
  uiIcon: "cyrene-sun",
  defaultChatMode: "collab",
  segmentedOutputMode: "off",
  mobileMessageSegmentation: "off",
  proactiveChatMode: "off",
  proactiveDeliveryTarget: "local",
  ttsEngine: "off",
  ttsAutoRead: true,
  ttsSpeed: 1,
  ttsVolume: 1,
  ttsMinimaxKey: "",
  ttsMinimaxVoiceId: "",
  ttsMinimaxModel: "speech-2.8-turbo",
  ttsStreaming: true,
  ttsGptsovitsBaseUrl: "http://localhost:9880",
  ttsGptsovitsRefAudioPath: "",
  ttsGptsovitsPromptText: "",
  ttsGptsovitsFormat: "wav",
  ttsCustomCloudEndpointUrl: "",
  ttsCustomCloudApiKey: "",
  ttsCustomCloudVoiceId: "",
  ttsCustomCloudFormat: "mp3",
  ttsCustomCloudTimeoutMs: 30000,
  ttsMimoKey: "",
  ttsMimoVoiceAudioPath: "",
  ttsMimoStylePrompt: "温柔、自然、略带亲近感，像在轻声陪用户聊天。",
  weatherSource: "open-meteo",
  weatherEnabled: false,
  amapKey: "",
  travelEnabled: false,
  playwrightMcpEnabled: false,
  searchEngine: "off",
  searchBochaKey: "",
  searchTavilyKey: "",
  searchMinimaxKey: "",
  emailEnabled: false,
  emailSmtpHost: "",
  emailSmtpPort: 465,
  emailSmtpSecure: true,
  emailSmtpUser: "",
  emailSmtpPass: "",
  emailFromName: "",
  asrEngine: "off",
  asrAliyunAppKey: "",
  asrAliyunAccessKeyId: "",
  asrAliyunAccessKeySecret: "",
  asrLanguage: "zh",
  asrVadSilenceMs: 1000,
  asrVadThreshold: 0.01,
  asrShowTranscript: false,
  openerMode: "off",
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
  const explicitTransport: ProviderProfile["explicitTransport"] =
    input?.explicitTransport === "openai" || input?.explicitTransport === "anthropic" || input?.explicitTransport === "auto"
      ? input.explicitTransport
      : undefined;
  return {
    baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "",
    model: typeof input?.model === "string" ? input.model.trim() : "",
    apiKey: typeof input?.apiKey === "string" ? input.apiKey.trim() : "",
    displayName: typeof input?.displayName === "string" && input?.displayName.trim() ? input.displayName.trim() : undefined,
    explicitTransport,
    reasoning: normalizeReasoningPreference((input as { reasoning?: unknown })?.reasoning),
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
    explicitTransport: profile.explicitTransport,
    reasoning: profile.reasoning,  // 顶层镜像：与 explicitTransport 同源（perProvider[currentProvider].reasoning）
    perProvider,
    runtimeSync: input?.runtimeSync === "llm" ? "llm" : input?.runtimeSync === "local" ? "local" : "off",
    stickerEnabled: input?.stickerEnabled !== false,
    stickerSize: input?.stickerSize === "small" || input?.stickerSize === "large" ? input.stickerSize : "standard",
    stickerSimilarityThreshold: typeof input?.stickerSimilarityThreshold === "number"
      ? Math.max(0.3, Math.min(0.9, input.stickerSimilarityThreshold))
      : 0.55,
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
  // explicitTransport：渲染端新下拉框字段。传 "openai" | "anthropic" | "auto" 都接受；传 undefined 视为 "auto"。
  const incomingExplicitTransport: ProviderProfile["explicitTransport"] =
    settings.explicitTransport === "openai" || settings.explicitTransport === "anthropic" || settings.explicitTransport === "auto"
      ? settings.explicitTransport
      : incomingProfile.explicitTransport;
  // reasoning 折叠（用户第三轮修订 #4）：优先级 perProvider > 顶层 > existing
  const incomingProfileForReasoning = (settings.perProvider ?? {})[currentProvider];
  const hasProfileReasoning = incomingProfileForReasoning
    && Object.prototype.hasOwnProperty.call(incomingProfileForReasoning, "reasoning");
  const hasTopLevelReasoning = Object.prototype.hasOwnProperty.call(settings, "reasoning");
  let chosenReasoningRaw: unknown;
  let chosenReasoningHasKey: boolean;
  if (hasProfileReasoning) {
    chosenReasoningRaw = (incomingProfileForReasoning as { reasoning?: unknown }).reasoning;
    chosenReasoningHasKey = true;
  } else if (hasTopLevelReasoning) {
    chosenReasoningRaw = settings.reasoning;
    chosenReasoningHasKey = true;
  } else {
    chosenReasoningRaw = undefined;
    chosenReasoningHasKey = false;
  }
  const foldedReasoning = foldReasoning(chosenReasoningRaw, incomingProfile.reasoning, chosenReasoningHasKey);

  perProvider[currentProvider] = {
    baseUrl: typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : incomingProfile.baseUrl,
    model: typeof settings.model === "string" ? settings.model.trim() : incomingProfile.model,
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey.trim() : incomingProfile.apiKey,
    displayName: typeof settings.displayName === "string" && settings.displayName.trim()
      ? settings.displayName.trim()
      : incomingProfile.displayName,
    explicitTransport: incomingExplicitTransport,
    reasoning: foldedReasoning,
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
  const windowVisibility = normalizeWindowVisibilitySettings(input);
  const clamp = (value: unknown, fallback: number) => {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : fallback;
  };
  const clampPort = (value: unknown, fallback: number) => {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? Math.max(1, Math.min(65535, Math.round(num))) : fallback;
  };
  const clampMs = (value: unknown, fallback: number) => {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? Math.max(1000, Math.min(120000, Math.round(num))) : fallback;
  };
  return {
    musicEnabled: Boolean(input?.musicEnabled),
    musicVolume: clamp(input?.musicVolume, DEFAULT_GENERAL_SETTINGS.musicVolume),
    soundEnabled: input?.soundEnabled === undefined ? DEFAULT_GENERAL_SETTINGS.soundEnabled : Boolean(input.soundEnabled),
    soundVolume: clamp(input?.soundVolume, DEFAULT_GENERAL_SETTINGS.soundVolume),
    petAlwaysOnTop: input?.petAlwaysOnTop === undefined ? DEFAULT_GENERAL_SETTINGS.petAlwaysOnTop : Boolean(input.petAlwaysOnTop),
    petVisible: input?.petVisible === undefined ? DEFAULT_GENERAL_SETTINGS.petVisible : Boolean(input.petVisible),
    petZoom: typeof input?.petZoom === "number" ? Math.max(0.5, Math.min(2, input.petZoom)) : DEFAULT_GENERAL_SETTINGS.petZoom,
    petWindowX: typeof input?.petWindowX === "number" && isFinite(input.petWindowX)
      ? Math.round(input.petWindowX) : undefined,
    petWindowY: typeof input?.petWindowY === "number" && isFinite(input.petWindowY)
      ? Math.round(input.petWindowY) : undefined,
    disableGpuElectron: input?.disableGpuElectron,
    sidebarVisible: windowVisibility.sidebarVisible,
    tasksVisible: windowVisibility.tasksVisible,
    launchAtLogin: Boolean(input?.launchAtLogin),
    language: "zh-CN",
    uiTheme: normalizeUiTheme(input?.uiTheme),
    uiFont: normalizeUiFont(input?.uiFont),
    uiIcon: normalizeUiIcon(input?.uiIcon),
    defaultChatMode: normalizeDefaultChatMode(input?.defaultChatMode),
    segmentedOutputMode: normalizeSegmentedOutputMode(input?.segmentedOutputMode),
    mobileMessageSegmentation: normalizeMobileMessageSegmentationMode(input?.mobileMessageSegmentation),
    proactiveChatMode: normalizeProactiveChatMode(input?.proactiveChatMode),
    proactiveDeliveryTarget: normalizeProactiveDeliveryTarget(input?.proactiveDeliveryTarget),
    // TTS 配置
    ttsEngine: (["off", "minimax", "gptsovits", "custom-cloud", "mimo"].includes(input?.ttsEngine as string) ? input?.ttsEngine : "off") as GeneralSettings["ttsEngine"],
    ttsAutoRead: input?.ttsAutoRead === undefined ? DEFAULT_GENERAL_SETTINGS.ttsAutoRead : Boolean(input.ttsAutoRead),
    ttsSpeed: typeof input?.ttsSpeed === "number" ? Math.max(0.5, Math.min(2, input.ttsSpeed)) : DEFAULT_GENERAL_SETTINGS.ttsSpeed,
    ttsVolume: typeof input?.ttsVolume === "number" ? Math.max(0, Math.min(1, input.ttsVolume)) : DEFAULT_GENERAL_SETTINGS.ttsVolume,
    ttsMinimaxKey: typeof input?.ttsMinimaxKey === "string" ? input.ttsMinimaxKey : "",
    ttsMinimaxVoiceId: typeof input?.ttsMinimaxVoiceId === "string" ? input.ttsMinimaxVoiceId : "",
    ttsMinimaxModel: input?.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo",
    ttsStreaming: input?.ttsStreaming === undefined ? true : Boolean(input.ttsStreaming),
    weatherSource: ["open-meteo", "amap"].includes(String(input?.weatherSource))
      ? (input!.weatherSource as "open-meteo" | "amap")
      : "open-meteo",
    weatherEnabled: Boolean(input?.weatherEnabled),
    amapKey: typeof input?.amapKey === "string" ? input.amapKey : "",
    travelEnabled: Boolean(input?.travelEnabled),
    playwrightMcpEnabled: Boolean(input?.playwrightMcpEnabled),
    searchEngine: ["off", "bocha", "tavily", "minimax"].includes(String(input?.searchEngine))
      ? (input!.searchEngine as "off" | "bocha" | "tavily" | "minimax")
      : "off",
    searchBochaKey: typeof input?.searchBochaKey === "string" ? input.searchBochaKey : "",
    searchTavilyKey: typeof input?.searchTavilyKey === "string" ? input.searchTavilyKey : "",
    searchMinimaxKey: typeof input?.searchMinimaxKey === "string" ? input.searchMinimaxKey : "",
    // 邮件（SMTP）配置
    emailEnabled: Boolean(input?.emailEnabled),
    emailSmtpHost: typeof input?.emailSmtpHost === "string" ? input.emailSmtpHost : "",
    emailSmtpPort: clampPort(input?.emailSmtpPort, DEFAULT_GENERAL_SETTINGS.emailSmtpPort),
    emailSmtpSecure: input?.emailSmtpSecure === undefined
      ? (clampPort(input?.emailSmtpPort, DEFAULT_GENERAL_SETTINGS.emailSmtpPort) === 465)
      : Boolean(input.emailSmtpSecure),
    emailSmtpUser: typeof input?.emailSmtpUser === "string" ? input.emailSmtpUser : "",
    emailSmtpPass: typeof input?.emailSmtpPass === "string" ? input.emailSmtpPass : "",
    emailFromName: typeof input?.emailFromName === "string" ? input.emailFromName : "",
    // ASR（语音识别）配置
    asrEngine: ["off", "aliyun", "local"].includes(String(input?.asrEngine))
      ? (input!.asrEngine as "off" | "aliyun" | "local")
      : "off",
    asrAliyunAppKey: typeof input?.asrAliyunAppKey === "string" ? input.asrAliyunAppKey : "",
    asrAliyunAccessKeyId: typeof input?.asrAliyunAccessKeyId === "string" ? input.asrAliyunAccessKeyId : "",
    asrAliyunAccessKeySecret: typeof input?.asrAliyunAccessKeySecret === "string" ? input.asrAliyunAccessKeySecret : "",
    asrLanguage: ["zh", "en", "auto"].includes(String(input?.asrLanguage))
      ? (input!.asrLanguage as "zh" | "en" | "auto")
      : "zh",
    asrVadSilenceMs: typeof input?.asrVadSilenceMs === "number"
      ? Math.max(300, Math.min(30000, Math.round(input.asrVadSilenceMs)))
      : DEFAULT_GENERAL_SETTINGS.asrVadSilenceMs,
    asrVadThreshold: typeof input?.asrVadThreshold === "number"
      ? Math.max(0.001, Math.min(0.5, Number(input.asrVadThreshold)))
      : DEFAULT_GENERAL_SETTINGS.asrVadThreshold,
    asrShowTranscript: Boolean(input?.asrShowTranscript),
    openerMode: ["off", "quiet", "normal", "lively"].includes(String(input?.openerMode))
      ? (input!.openerMode as "off" | "quiet" | "normal" | "lively")
      : "off",
    ttsGptsovitsBaseUrl: typeof input?.ttsGptsovitsBaseUrl === "string" ? input.ttsGptsovitsBaseUrl : DEFAULT_GENERAL_SETTINGS.ttsGptsovitsBaseUrl,
    ttsGptsovitsRefAudioPath: typeof input?.ttsGptsovitsRefAudioPath === "string" ? input.ttsGptsovitsRefAudioPath : "",
    ttsGptsovitsPromptText: typeof input?.ttsGptsovitsPromptText === "string" ? input.ttsGptsovitsPromptText : "",
    ttsGptsovitsFormat: input?.ttsGptsovitsFormat === "mp3" ? "mp3" : "wav",
    ttsCustomCloudEndpointUrl: typeof input?.ttsCustomCloudEndpointUrl === "string" ? input.ttsCustomCloudEndpointUrl : "",
    ttsCustomCloudApiKey: typeof input?.ttsCustomCloudApiKey === "string" ? input.ttsCustomCloudApiKey : "",
    ttsCustomCloudVoiceId: typeof input?.ttsCustomCloudVoiceId === "string" ? input.ttsCustomCloudVoiceId : "",
    ttsCustomCloudFormat: input?.ttsCustomCloudFormat === "wav" ? "wav" : "mp3",
    ttsCustomCloudTimeoutMs: clampMs(input?.ttsCustomCloudTimeoutMs, DEFAULT_GENERAL_SETTINGS.ttsCustomCloudTimeoutMs),
    ttsMimoKey: typeof input?.ttsMimoKey === "string" ? input.ttsMimoKey : "",
    ttsMimoVoiceAudioPath: typeof input?.ttsMimoVoiceAudioPath === "string" ? input.ttsMimoVoiceAudioPath : "",
    ttsMimoStylePrompt: typeof input?.ttsMimoStylePrompt === "string" ? input.ttsMimoStylePrompt : DEFAULT_GENERAL_SETTINGS.ttsMimoStylePrompt,
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
  applyPetZoom(settings.petZoom);
}

/**
 * 按缩放因子调整桌宠窗口尺寸，并通知渲染进程重算模型 scale。
 * 窗口与模型同步等比缩放，比例不变，故模型始终塞满窗口、不被裁剪。
 */
function applyPetZoom(zoom: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const width = Math.round(PET_WINDOW_BASE_WIDTH * zoom);
  const height = Math.round(PET_WINDOW_BASE_HEIGHT * zoom);
  mainWindow.setSize(width, height);
  sendToLive2DWindow(IPC.PET_ZOOM, zoom);
}

function saveGeneralSettings(settings: Partial<GeneralSettings>): GeneralSettings {
  const before = loadGeneralSettings();
  const normalized = normalizeGeneralSettings({ ...before, ...settings });
  const filePath = getGeneralSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
  applyGeneralSettings(normalized);
  syncBuiltInToolToggles(normalized);
  if (before.uiTheme !== normalized.uiTheme) {
    broadcastUiThemeChanged(normalized.uiTheme);
  }
  if (JSON.stringify(before.uiFont) !== JSON.stringify(normalized.uiFont)) {
    broadcastUiFontChanged(normalized.uiFont);
  }
  if (before.uiIcon !== normalized.uiIcon) {
    applyUiIcon(normalized.uiIcon);
  }
  return normalized;
}

function syncBuiltInToolToggles(settings: GeneralSettings): void {
  toolRegistry.setEnabled("weather", settings.weatherEnabled);
  toolRegistry.setEnabled("plan_trip", settings.travelEnabled);
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

function loadStickerSettings(): Record<string, boolean> {
  let raw: Record<string, unknown> = {};
  try {
    const filePath = getStickerSettingsPath();
    if (fs.existsSync(filePath)) {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    }
  } catch (err) {
    console.error("[Cyrene] load sticker settings failed:", err);
  }

  // 把所有 id 归一化为 boolean（默认 true）
  const result: Record<string, boolean> = {};
  for (const id of Object.keys(raw)) {
    result[id] = raw[id] !== false;
  }
  return result;
}

function saveStickerSettings(settings: Record<string, boolean>): Record<string, boolean> {
  const filePath = getStickerSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf8");
  return settings;
}

function setStickerEnabled(id: string, enabled: boolean): Record<string, boolean> {
  const current = loadStickerSettings();
  current[id] = enabled;
  return saveStickerSettings(current);
}

function getStickerManagerConfig(): StickerConfigItem[] {
  const stickerSettings = loadStickerSettings();
  return getAllStickerConfig(stickerSettings);
}

// ── 多面板自适应布局 ──────────────────────────────────────────────

interface PanelLayout { x: number; y: number; }

/**
 * 将窗口位置 clamp 到 workArea 内，保证至少 minVisibleW × minVisibleH 可见。
 * 允许窗口部分超出屏幕（可正可负），但可见区域不少于指定阈值。
 */
function clampWindowToWorkArea(
  pos: PanelLayout,
  size: { width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
  minVisibleW = 120,
  minVisibleH = 80,
): PanelLayout {
  const minX = workArea.x - size.width + minVisibleW;
  const maxX = workArea.x + workArea.width - minVisibleW;
  const minY = workArea.y - size.height + minVisibleH;
  const maxY = workArea.y + workArea.height - minVisibleH;

  function clamp(value: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, value));
  }

  return {
    x: clamp(pos.x, minX, maxX),
    y: clamp(pos.y, minY, maxY),
  };
}

/**
 * 计算多面板自适应布局。
 *
 * 策略：
 * - 水平排列：totalWidth <= workArea.width → 三面板水平居中
 * - 阶梯排列：totalWidth > workArea.width → sidebar/tasks 贴右边缘并垂直错开
 *
 * 所有窗口均 clampWindowToWorkArea 保证至少 120×80 可见。
 */
function computePanelLayout(
  workArea: { x: number; y: number; width: number; height: number },
  panels: Array<{ width: number; height: number }>,
  gap = 8,
): PanelLayout[] {
  const totalWidth = panels.reduce((sum, p, i) => sum + p.width + (i > 0 ? gap : 0), 0);
  const maxPanelHeight = Math.max(...panels.map(p => p.height));
  const baseY =
    workArea.height >= maxPanelHeight
      ? workArea.y + Math.floor((workArea.height - maxPanelHeight) / 2)
      : workArea.y;

  if (totalWidth <= workArea.width) {
    // 水平居中排列
    const startX = workArea.x + Math.floor((workArea.width - totalWidth) / 2);
    const positions: PanelLayout[] = [];
    let curX = startX;
    for (let i = 0; i < panels.length; i++) {
      const pos = clampWindowToWorkArea({ x: curX, y: baseY }, panels[i], workArea);
      positions.push(pos);
      curX += panels[i].width + gap;
    }
    return positions;
  }

  // 阶梯排列：总宽超屏
  // chat: 居中（clamp 后）
  const chatPos = clampWindowToWorkArea(
    { x: workArea.x + Math.floor((workArea.width - panels[0].width) / 2), y: baseY },
    panels[0],
    workArea,
  );

  // sidebar: 优先 chat 右侧有 gap；不够则贴 workArea 右边缘
  const sidebarMaxX = workArea.x + workArea.width - panels[1].width;
  const sidebarX = Math.min(chatPos.x + panels[0].width + gap, sidebarMaxX);
  const sidebarPos = clampWindowToWorkArea({ x: sidebarX, y: baseY }, panels[1], workArea);

  // tasks: 贴右边缘，y 与 sidebar 错开 48px
  const tasksX = Math.min(sidebarPos.x, sidebarMaxX);
  const tasksY = clampWindowToWorkArea(
    { x: tasksX, y: sidebarPos.y + 48 },
    panels[2],
    workArea,
  );

  return [chatPos, sidebarPos, tasksY];
}

// 计算 chat / sidebar / tasks 三个窗口的初始位置。
// 规则：优先鼠标所在 display；窗口自适应 workArea，保证至少 120×80 可见。
function computeLayout(): {
  chat: PanelLayout;
  sidebar: PanelLayout;
  tasks: PanelLayout;
} {
  const cursor = screen.getCursorScreenPoint();
  const displays = screen.getAllDisplays();
  const display =
    displays.find(d => {
      const { x, y, width, height } = d.workArea;
      return cursor.x >= x && cursor.x < x + width && cursor.y >= y && cursor.y < y + height;
    }) ?? screen.getPrimaryDisplay();

  const { workArea } = display;
  const panels = [
    { width: 1280, height: 760 }, // chat
    { width: 320, height: 760 },  // sidebar
    { width: 320, height: 760 },  // tasks
  ];
  const [chatPos, sidebarPos, tasksPos] = computePanelLayout(workArea, panels, 8);
  return { chat: chatPos, sidebar: sidebarPos, tasks: tasksPos };
}


interface ChatRequestMessage {
  role: "user" | "model" | "assistant" | "system";
  content: string;
  at?: number;
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

function normalizeChatMessages(input: unknown): ChatContextMessage[] {
  return normalizeChatMessagesWithTime(input);
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

  // 拼 VendorConfig（settings 顶层三件套 + 镜像字段都参与）
  const cfg: VendorConfig = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    reasoning: settings.reasoning,
  };

  try {
    // adapter 三层 transport 解析（explicitTransport → baseUrl 启发式 → capabilities fallback）
    const adapter = getAdapterForConfig(cfg);
    // adapter 的 buildStreamRequest 内部已写 stream=true + 拼 transport 相关的 headers/body
    const http = adapter.buildStreamRequest({
      model: cfg.model,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
      stream: true,
    }, cfg);

    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = (errorData as { error?: { message?: string } }).error?.message;
      throw new Error(errMsg || `模型请求失败：HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("响应体为空，不支持流式读取");
    }

    let fullText = "";
    const visibleFilter = createVisibleStreamFilter();

    // Reader 层切分字节流 → StreamEvent；adapter 解析为 StreamChunk
    // 半行拼接、event 块切分等状态由 createSseReader 内部维护，adapter 保持纯函数无状态。
    for await (const event of createSseReader(adapter, response.body)) {
      const chunk = adapter.parseStreamEvent(event);
      if (!chunk) continue;
      if (chunk.deltaText) {
        fullText += chunk.deltaText;
        const visibleDelta = visibleFilter.push(chunk.deltaText);
        if (visibleDelta) onChunk(visibleDelta);
      }
      // thinking 累积但不入可见流（stripThinkBlocks 末尾统一剥）
      if (chunk.usage) {
        recordUsage(chunk.usage.input, chunk.usage.output, 1);
      }
      if (chunk.done) break;
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

/**
 * 诊断：确认 WorldBook active entries 是否真正进入最终 system prompt，
 * 以及在什么位置。不预设结论——先看数据再判断是 lost-in-middle、
 * 被后续 prompt 覆盖、还是根本没拼进去。
 */
function logWorldbookInjection(alwaysOnContext: string, systemContent: string): void {
  const marker = "【已激活的世界知识】";
  if (alwaysOnContext && alwaysOnContext.includes(marker)) {
    const wbStart = systemContent.indexOf(marker);
    console.log("[Worldbook/Diag] ────────────────────────");
    console.log(`[Worldbook/Diag] systemContent total length: ${systemContent.length}`);
    console.log(`[Worldbook/Diag] alwaysOnContext length: ${alwaysOnContext.length}`);
    console.log(`[Worldbook/Diag] ${marker} 在 systemContent 中的偏移: ${wbStart} / ${systemContent.length} (${((wbStart / systemContent.length) * 100).toFixed(1)}%)`);
    console.log(`[Worldbook/Diag] ${marker} 之后剩余内容: ${systemContent.length - wbStart} 字符`);
    const beforeWb = systemContent.slice(Math.max(0, wbStart - 200), wbStart);
    const wbSlice = systemContent.slice(wbStart, Math.min(wbStart + alwaysOnContext.length + 200, systemContent.length));
    console.log(`[Worldbook/Diag] ── 注入前 200 字 ──\n${beforeWb.slice(-200)}`);
    console.log(`[Worldbook/Diag] ── 注入内容 + 后 200 字 ──\n${wbSlice.slice(0, 800)}`);
    console.log("[Worldbook/Diag] ────────────────────────");
  } else {
    console.log("[Worldbook/Diag] 本轮无世界知识注入（alwaysOnContext 为空或不含标记）");
  }
}

function buildSystemPrompt(styleFile: string): string {
  const parts: string[] = [];

  // styleFile 以 "talk" 开头时走纯聊天模式：用 talk_system.md 替换 system.md（不调工具）
  const isTalkMode = styleFile.startsWith("talk");
  const system = loadPromptFile(isTalkMode ? "talk_system.md" : "system.md");
  if (system) parts.push(system);

  const identity = loadPromptFile("identity.md");
  if (identity) parts.push(identity);

  const soul = loadPromptFile("soul.md");
  if (soul) parts.push(soul);

  const canon = loadPromptFile("canon_quotes.md");
  if (canon) parts.push(canon);

  // 纯聊天模式不加载 style 文件（talk_system.md 已包含完整规则）
  if (!isTalkMode) {
    const style = loadPromptFile("styles/" + styleFile);
    if (style) parts.push(style);
  }

  return parts.join("\n\n---\n\n");
}

function buildProactivePersonaPrompt(): string {
  const parts: string[] = [];
  const talkSystem = loadPromptFile("talk_system.md");
  if (talkSystem) parts.push(talkSystem);
  const soul = loadPromptFile("soul.md");
  if (soul) {
    // 主动轮完全不携带工具说明；Soul 尾部的 Live2D/联网章节由正常聊天使用。
    parts.push(soul.split("\n## Live2D 与聊天文字的分工")[0].trim());
  }
  const canon = loadPromptFile("canon_quotes.md");
  if (canon) parts.push(canon);
  const style = loadPromptFile("styles/01_default.md");
  if (style) parts.push(style);
  return parts.join("\n\n---\n\n");
}

function toProactiveHistory(messages: Array<{ role: "user" | "model"; content: string; at: number }>): ProactiveHistoryTurn[] {
  return messages
    .filter((message) => message.content.trim())
    .slice(-16)
    .map((message) => ({ role: message.role, content: message.content, at: message.at }));
}

function getProactiveHistories(): { ordinary: ProactiveHistoryTurn[]; proactive: ProactiveHistoryTurn[] } {
  const ordinaryMeta = chatsStore.listSessions().find((session) => session.purpose !== "proactive-chat");
  const ordinarySession = ordinaryMeta ? chatsStore.getSession(ordinaryMeta.id) : null;
  const proactiveSession = chatsStore.getSessionByPurpose("proactive-chat");
  return {
    ordinary: toProactiveHistory(ordinarySession?.messages ?? []),
    proactive: toProactiveHistory(proactiveSession?.messages ?? []),
  };
}

function getProactiveRuntimeSnapshot(): ProactiveRuntimeSnapshot {
  const now = Date.now();
  let idleSec = Number.POSITIVE_INFINITY;
  try { idleSec = powerMonitor.getSystemIdleTime(); } catch { /* app 尚未 ready */ }
  return {
    now,
    localHour: new Date(now).getHours(),
    idleSec,
    enabled: loadGeneralSettings().proactiveChatMode === "on",
    conversationBusy: normalConversationBusyCount > 0,
    generationBusy: false,
    screenLocked: proactiveScreenLocked,
  };
}

async function buildProactiveAgentMessages(candidate: ProactiveCandidate) {
  const histories = getProactiveHistories();
  const recentTopic = histories.ordinary.slice(-4).map((turn) => turn.content).join("\n");
  const retrievalQuery = `${candidate.sceneId}\n${recentTopic}`.trim();
  const [profileContext, memoryContext] = await Promise.all([
    buildAlwaysOnContext(retrievalQuery, histories.ordinary.map((turn) => ({ role: turn.role, content: turn.content }))).catch(() => ""),
    buildMemoryInjection(retrievalQuery).catch(() => ""),
  ]);
  const state = loadOpenerState();
  const snapshot = getProactiveRuntimeSnapshot();
  return buildProactiveMessages({
    basePersona: buildProactivePersonaPrompt(),
    userProfile: profileContext,
    relevantMemory: memoryContext,
    ordinaryHistory: histories.ordinary,
    proactiveHistory: histories.proactive,
    sceneId: candidate.sceneId,
    localNow: new Date(snapshot.now),
    idleSec: snapshot.idleSec,
    unansweredCount: state.unansweredCount,
  });
}

async function synthesizeProactiveSpeech(text: string): Promise<{ audioBase64: string; format: "wav" | "mp3"; durationMs: number } | null> {
  const cfg = loadGeneralSettings();
  if (!cfg.ttsAutoRead || cfg.ttsEngine === "off") return null;
  try {
    const result = await synthesizeByEngine(cfg.ttsEngine, {
      text,
      speed: cfg.ttsSpeed,
      volume: cfg.ttsVolume,
      apiKey: cfg.ttsEngine === "mimo" ? cfg.ttsMimoKey : (cfg.ttsEngine === "custom-cloud" ? cfg.ttsCustomCloudApiKey : cfg.ttsMinimaxKey),
      voiceId: cfg.ttsEngine === "custom-cloud" ? cfg.ttsCustomCloudVoiceId : cfg.ttsMinimaxVoiceId,
      model: cfg.ttsMinimaxModel,
      baseUrl: cfg.ttsGptsovitsBaseUrl,
      refAudioPath: cfg.ttsGptsovitsRefAudioPath,
      promptText: cfg.ttsGptsovitsPromptText,
      endpointUrl: cfg.ttsCustomCloudEndpointUrl,
      timeoutMs: cfg.ttsCustomCloudTimeoutMs,
      voiceAudioPath: cfg.ttsMimoVoiceAudioPath,
      stylePrompt: cfg.ttsMimoStylePrompt,
      format: cfg.ttsEngine === "gptsovits" ? cfg.ttsGptsovitsFormat : (cfg.ttsEngine === "custom-cloud" ? cfg.ttsCustomCloudFormat : "mp3"),
    });
    return {
      audioBase64: result.audio.toString("base64"),
      format: result.format,
      durationMs: Math.max(1_500, Math.min(30_000, text.length * 180)),
    };
  } catch (error) {
    console.warn("[Proactive] TTS 合成失败，保留文本消息:", error instanceof Error ? error.message : error);
    return null;
  }
}

function updateNormalConversationBusy(delta: 1 | -1): void {
  normalConversationBusyCount = Math.max(0, normalConversationBusyCount + delta);
}

const proactiveConversationLifecycle = {
  onUserMessage: () => proactiveChatService?.invalidateForUserMessage(),
  onConversationStarted: () => {
    updateNormalConversationBusy(1);
    proactiveChatService?.normalConversationStarted();
  },
  onConversationEnded: () => {
    updateNormalConversationBusy(-1);
    if (normalConversationBusyCount === 0) proactiveChatService?.normalConversationEnded();
  },
};

function getProactiveCommitDecision(candidate: ProactiveCandidate, generationEpoch: number) {
  return canCommitProactiveMessage(
    getProactiveRuntimeSnapshot(),
    loadOpenerState(),
    candidate,
    generationEpoch,
  );
}

function recordProactiveDeliveryMetadata(input: ProactiveCommitInput): void {
  const openerState = loadOpenerState();
  const sceneConfig = SCENE_CONFIGS.find((config) => config.id === input.candidate.sceneId);
  if (sceneConfig?.todayFiredFlag) openerState.todayFired[sceneConfig.todayFiredFlag] = true;
  if (input.source === "fallback" && input.fallbackPayload) {
    const itemId = (input.fallbackPayload as ShowBubblePayload).itemId;
    if (itemId) {
      const recent = openerState.recentItems[input.candidate.sceneId] ?? [];
      openerState.recentItems[input.candidate.sceneId] = [itemId, ...recent.filter((id) => id !== itemId)].slice(0, 4);
    }
  }
  saveOpenerState(openerState);
}

async function commitLocalProactiveMessage(input: ProactiveCommitInput): Promise<ProactiveCommitResult> {
  const initialDecision = getProactiveCommitDecision(input.candidate, input.generationEpoch);
  if (!initialDecision.allowed) return { kind: "cancelled", reason: initialDecision.reason };

  const session = chatsStore.getOrCreateSessionByPurpose("proactive-chat", {
    title: "昔涟的主动消息",
    identityId: null,
  });
  const at = Date.now();
  const appended = chatsStore.appendMessage(session.id, {
    id: randomUUID(),
    role: "model",
    content: input.text,
    at,
  });
  if (!appended) throw new Error("主动聊天会话写入失败");
  broadcastChatsChanged();

  let payload: ShowBubblePayload = input.source === "fallback" && input.fallbackPayload
    ? { ...(input.fallbackPayload as ShowBubblePayload), text: input.text, sessionId: session.id }
    : {
        text: input.text,
        sceneId: input.candidate.sceneId,
        itemId: `proactive-${at}`,
        sessionId: session.id,
      };

  if (input.source === "model") {
    const speech = await synthesizeProactiveSpeech(input.text);
    if (speech) payload = { ...payload, ...speech };
  }

  // 文本已落库；气泡/TTS 前再次执行完整检查，失败时只取消展示和语音。
  const displayDecision = getProactiveCommitDecision(input.candidate, input.generationEpoch);
  if (displayDecision.allowed && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.LIVE2D_SHOW_BUBBLE, payload);
  }
  return { kind: "committed" };
}

async function commitSelectedProactiveMessage(input: ProactiveCommitInput): Promise<ProactiveCommitResult> {
  const settings = loadGeneralSettings();
  const target = settings.proactiveDeliveryTarget;
  const result = await routeProactiveDelivery(target, {
    commitLocal: () => commitLocalProactiveMessage(input),
    commitChannel: async (channel) => {
      const channelResult = await sendProactiveChannelMessage({
        channel,
        text: input.text,
        mobileMessageSegmentation: settings.mobileMessageSegmentation,
        manager: channelManager,
        canContinue: () => {
          if (loadGeneralSettings().proactiveDeliveryTarget !== channel) return false;
          return getProactiveCommitDecision(input.candidate, input.generationEpoch).allowed;
        },
      });
      return channelResult.kind === "committed"
        ? { kind: "committed" }
        : { kind: "cancelled", reason: channelResult.reason };
    },
  });

  if (result.kind === "committed") recordProactiveDeliveryMetadata(input);
  return result;
}

function initializeProactiveChatService(): void {
  proactiveChatService = createProactiveChatService({
    loadState: loadOpenerState,
    saveState: (state) => {
      const openerState = loadOpenerState();
      Object.assign(openerState, state);
      saveOpenerState(openerState);
    },
    getSnapshot: getProactiveRuntimeSnapshot,
    buildMessages: async (candidate) => buildProactiveAgentMessages(candidate),
    runModel: async (messages) => {
      const settings = loadModelSettings();
      if (!settings.apiKey) return { kind: "error", reason: "missing_api_key" };
      return runProactiveModel({
        settings: {
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          explicitTransport: settings.explicitTransport,
          reasoning: settings.reasoning,
        },
        messages,
        timeoutMs: 45_000,
      });
    },
    getFallback: async (candidate) => getPresetFallback(candidate.sceneId, new Date().getHours()),
    canStartDelivery: () => {
      const target = loadGeneralSettings().proactiveDeliveryTarget;
      return target === "local" || canStartProactiveChannelDelivery(target, channelManager);
    },
    commitMessage: commitSelectedProactiveMessage,
    log: (event, detail) => console.log(`[Proactive] ${event}`, detail ?? ""),
  });

  setProactiveCandidateHandler(async (candidate) => {
    await proactiveChatService?.evaluateCandidate(candidate);
  });

  setChannelsConversationLifecycle(proactiveConversationLifecycle);

  powerMonitor.on("lock-screen", () => {
    proactiveScreenLocked = true;
    proactiveChatService?.invalidate();
  });
  powerMonitor.on("unlock-screen", () => { proactiveScreenLocked = false; });
  powerMonitor.on("suspend", () => {
    proactiveScreenLocked = true;
    proactiveChatService?.invalidate();
  });
  powerMonitor.on("resume", () => { proactiveScreenLocked = false; });
}

/**
 * 工具阶段使用的 system prompt。
 * 第一期：固定 tools_system.md 规则 + 运行时生成的工具目录。
 * 不放任何人格 / 环境 / 记忆，避免人设污染工具决策。
 */
function buildToolSystemPrompt(enabledTools: ReadonlyArray<ToolDefinition>, isOptimizedFirstRound?: boolean): string {
  const base = loadPromptFile(isOptimizedFirstRound ? "tools_system_optimized_first.md" : "tools_system.md");
  const catalog = buildToolCatalog(enabledTools as ToolDefinition[]);
  return [
    base,
    "## 当前可用工具",
    catalog,
  ].filter(Boolean).join("\n\n");
}

/**
 * Soul 阶段使用的基础 system prompt。
 * 包含：人设（system.md + identity.md + soul.md + canon + style）+ 后续可追加的环境/记忆等。
 * 注意：工具结果（`role: "tool"` 消息）在 conversation 中已携带，本函数不重复注入。
 * 第一期：build-options 会把 environmentContext / skillCatalog / toneInjection /
 * alwaysOnContext / relationshipContext / attachmentContext 等都拼到 baseContent 末尾，
 * 后续第二期再拆分为 toolEnvironmentContext / soulEnvironmentContext。
 */
function buildSoulSystemBasePrompt(styleFile: string): string {
  return buildSystemPrompt(styleFile);
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
  if (skill && skill.enabled && skillRegistry.isAvailable(parsed.skillId)) {
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
      const smoothed = smoothFeeling(feelingScores, feeling);
      feelingScores = smoothed.scores;
      runtimeState.feeling = smoothed.feeling as RuntimeFeeling;
      runtimeState.expression = feelingToExpression[smoothed.feeling] ?? 0;
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
  const profile = loadUserProfile();
  const chatContextTimezone = resolveChatContextTimezone(profile.timezone);
  const skillActivation = resolveSlashActivation(messages);
  const { messages: llmMessages, timeContext: conversationTimeContext } = buildConversationTimeContext(messages, chatContextTimezone);
  const latestUserText = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";

  // 1. 构建 always-on 上下文（世界书 + L0/L1 画像）
  let alwaysOnContext = "";
  try {
    alwaysOnContext = await buildAlwaysOnContext(latestUserText, messages);
  } catch (err) {
    console.warn("[Cyrene] always-on context build failed:", err);
  }

  // 1.1 自动注入相关记忆（L2 + 导入文档），让模型无需调 tool 也能感知
  let memoryInjection = "";
  try {
    memoryInjection = await buildMemoryInjection(latestUserText);
  } catch (err) {
    console.warn("[Cyrene] memory injection failed:", err);
  }

  // 1.5 环境上下文（Step 1）：当前日期 / OS / 桌面真实路径 / 权限档位 / 工具可用情况 / 模型视觉能力
  // 放在 always-on 之后、system prompt 末尾，让模型最近读到的就是机器事实，
  // 降低"桌面在哪"这类低级幻觉。失败不影响主流程。
  let environmentContext = "";
  try {
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
  // 语气硬注入：embedding 匹配场景，强制注入语气规则 + 场景参考样本（必须遵守，优先级最高）
  let toneInjection = "";
  const sceneProvider = getSceneEmbeddingProvider();
  if (sceneProvider && sceneEmbeddingIndex) {
    try {
      toneInjection = await buildToneInjection(latestUserText, llmMessages, sceneProvider, sceneEmbeddingIndex);
    } catch (err) {
      console.error("[Cyrene] tone injection failed:", err);
    }
  }
  // 注入顺序：环境 → 人格设定 → skill → 记忆 → ★已激活世界知识（放最后、最靠近 user message）
  // 世界知识放最后：LLM 对靠近 user 的信息权重更高；且避免被 system.md 的"不知道不要编"规则覆盖
  const systemContent =
    (environmentContext ? environmentContext + "\n\n" : "") +
    (conversationTimeContext ? conversationTimeContext + "\n\n---\n\n" : "") +
    buildSystemPrompt(styleFile) +
    (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
    skillActivation +
    (memoryInjection ? memoryInjection + "\n\n" : "") +
    (alwaysOnContext ? alwaysOnContext + "\n\n" : "") +
    toneInjection;

  // ── 诊断：WorldBook 注入验证 ──
  logWorldbookInjection(alwaysOnContext, systemContent);

  // 2. Function Calling 循环：模型自己决定调不调工具、调哪个
  const fcMessages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = [
    { role: "system", content: systemContent },
    ...llmMessages,
  ];

  let chatContent = "";

  try {
    const fcResult = await runFunctionCallingLoop(
      settings,
      fcMessages,
      getTimeoutSettings().chatRequestTimeout,
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
      getTimeoutSettings().chatRequestTimeout,
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

  let sticker: string | null = null;
  if (settings.stickerEnabled && stickerEmbeddingIndex) {
    const provider = getEmbeddingProvider();
    if (provider) {
      const stickerQuery = (chatContent + "\n" + latestUserText).slice(0, 1000);
      const matchResult = await matchSticker(stickerQuery, provider, stickerEmbeddingIndex, settings.stickerSimilarityThreshold);
      sticker = matchResult?.id ?? null;
    }
  }

  if (settings.runtimeSync === "local") {
    broadcastRuntimeStateChanged();
  } else if (settings.runtimeSync === "llm") {
    broadcastRuntimeStateChanged();
    void observeRuntimeState(settings, llmMessages, latestUserText, chatContent);
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

function broadcastUiThemeChanged(theme: GeneralSettings["uiTheme"]): void {
  for (const win of [mainWindow, chatWindow, sidebarWindow, tasksWindow, settingsWindow, stickerManagerWindow, callWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.UI_THEME_CHANGED, theme);
    }
  }
}

function broadcastUiFontChanged(font: GeneralSettings["uiFont"]): void {
  for (const win of [mainWindow, chatWindow, sidebarWindow, tasksWindow, settingsWindow, stickerManagerWindow, callWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.UI_FONT_CHANGED, font);
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

export function sendToLive2DWindow(channel: string, payload?: unknown): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (payload === undefined) win.webContents.send(channel);
  else win.webContents.send(channel, payload);
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
  const settings = loadGeneralSettings();
  let restoreX: number | undefined;
  let restoreY: number | undefined;

  if (settings.petWindowX !== undefined && settings.petWindowY !== undefined) {
    const PET_W = PET_WINDOW_BASE_WIDTH;
    const PET_H = PET_WINDOW_BASE_HEIGHT;
    const targetBounds = {
      x: settings.petWindowX,
      y: settings.petWindowY,
      width: PET_W,
      height: PET_H,
    };
    const display = screen.getDisplayMatching(targetBounds);
    const wa = display.workArea;

    // 窗口与 workArea 交集至少 80x80 才使用保存的坐标
    const interW =
      Math.min(targetBounds.x + PET_W, wa.x + wa.width) -
      Math.max(targetBounds.x, wa.x);
    const interH =
      Math.min(targetBounds.y + PET_H, wa.y + wa.height) -
      Math.max(targetBounds.y, wa.y);

    if (interW >= 80 && interH >= 80) {
      restoreX = settings.petWindowX;
      restoreY = settings.petWindowY;
    } else {
      console.log(
        "[Cyrene] 桌宠保存位置已离屏（仅 " +
          interW + "x" + interH + " 可见），使用默认位置",
      );
    }
  }

  mainWindow = new BrowserWindow({
    x: restoreX,
    y: restoreY,
    width: PET_WINDOW_BASE_WIDTH,
    height: PET_WINDOW_BASE_HEIGHT,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    icon: getCurrentAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  live2dWindowLifecycle.attach(mainWindow);

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
  }

  if (!isDev) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }

  mainWindow.on("hide", () => {
    mainWindow?.webContents.send(IPC.PET_VISIBILITY_CHANGED, false);
  });
  mainWindow.on("show", () => {
    mainWindow?.webContents.send(IPC.PET_VISIBILITY_CHANGED, true);
  });

  applyGeneralSettings(loadGeneralSettings());

  // Opener 主动开口：注入桌宠窗口 + 启动 tick
  setLive2dWindow(mainWindow);
  reloadManifest();
  const initOpener = () => {
    const s = loadGeneralSettings();
    stopOpener();
    if (s.proactiveChatMode === "on") {
      startOpener(s.openerMode === "off" ? "normal" : s.openerMode);
    }
  };
  initOpener();

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
    () => loadGeneralSettings().weatherEnabled,
  );

  // 注入用户选择卡片回调：工具调 ask_user_choice 时发 Custom 事件给聊天窗口
  setChoiceCardSender((cardData) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send(IPC.AGUI_EVENT, {
        type: "CUSTOM",
        name: "cyrene.choice",
        value: cardData,
      });
    }
  });

  // 注入搜索配置获取器
  setSearchConfig(
    () => loadGeneralSettings().searchEngine,
    () => loadGeneralSettings().searchBochaKey,
    () => loadGeneralSettings().searchTavilyKey,
  );

  // 注入出行工具 amapKey 获取器（复用 GeneralSettings 中的 amapKey）
  setTravelConfig(() => loadGeneralSettings().amapKey, () => loadGeneralSettings().travelEnabled);

  // 注入邮件工具 SMTP 配置获取器（每次执行实时读 GeneralSettings）
  setEmailConfig(
    () => loadGeneralSettings().emailEnabled,
    () => loadGeneralSettings().emailSmtpHost,
    () => loadGeneralSettings().emailSmtpPort,
    () => loadGeneralSettings().emailSmtpSecure,
    () => loadGeneralSettings().emailSmtpUser,
    () => loadGeneralSettings().emailSmtpPass,
    () => loadGeneralSettings().emailFromName,
  );

  // 注入 ASR 配置获取器（通话功能用，实时读 GeneralSettings）
  setAsrConfig(() => {
    const s = loadGeneralSettings();
    if (s.asrEngine !== "aliyun") return null;
    return { appKey: s.asrAliyunAppKey, accessKeyId: s.asrAliyunAccessKeyId, accessKeySecret: s.asrAliyunAccessKeySecret, language: s.asrLanguage, engine: s.asrEngine };
  });

  // 注入通话模型/TTS 配置获取器
  setCallSettings(
    () => {
      const s = loadModelSettings();
      return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey };
    },
    () => {
      const s = loadGeneralSettings();
      return {
        ttsEngine: s.ttsEngine,
        ttsMinimaxKey: s.ttsMinimaxKey, ttsMinimaxVoiceId: s.ttsMinimaxVoiceId,
        ttsMinimaxModel: s.ttsMinimaxModel,
        ttsSpeed: s.ttsSpeed, ttsVolume: s.ttsVolume,
        ttsGptsovitsBaseUrl: s.ttsGptsovitsBaseUrl,
        ttsGptsovitsRefAudioPath: s.ttsGptsovitsRefAudioPath,
        ttsGptsovitsPromptText: s.ttsGptsovitsPromptText,
        ttsGptsovitsFormat: s.ttsGptsovitsFormat,
        ttsCustomCloudEndpointUrl: s.ttsCustomCloudEndpointUrl,
        ttsCustomCloudApiKey: s.ttsCustomCloudApiKey,
        ttsCustomCloudVoiceId: s.ttsCustomCloudVoiceId,
        ttsCustomCloudFormat: s.ttsCustomCloudFormat,
        ttsCustomCloudTimeoutMs: s.ttsCustomCloudTimeoutMs,
        ttsMimoKey: s.ttsMimoKey,
        ttsMimoVoiceAudioPath: s.ttsMimoVoiceAudioPath,
        ttsMimoStylePrompt: s.ttsMimoStylePrompt,
      };
    },
    // 通话专用 system prompt 构建器（时间+常驻+记忆+phone人设+skill+语气，不要环境上下文）
    async (userText: string) => {
      const messages = [{ role: "user" as const, content: userText }];

      // ① 时间日期
      const now = new Date();
      const timeStr = `当前时间：${now.toLocaleDateString("zh-CN")} ${now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;

      // ② 常驻上下文（世界书 + L0/L1 画像）
      let alwaysOnContext = "";
      try { alwaysOnContext = await buildAlwaysOnContext(userText, messages); } catch { /* ignore */ }

      // ③ 记忆注入
      let memoryInjection = "";
      try { memoryInjection = await buildMemoryInjection(userText); } catch { /* ignore */ }

      // ④ 通话专用人设 prompt
      const phoneParts: string[] = [];
      const phoneSystem = loadPromptFile("phone_system.md");
      if (phoneSystem) phoneParts.push(phoneSystem);
      const phoneIdentity = loadPromptFile("phone_identity.md");
      if (phoneIdentity) phoneParts.push(phoneIdentity);
      const soul = loadPromptFile("soul.md");
      if (soul) phoneParts.push(soul);
      const canon = loadPromptFile("canon_quotes.md");
      if (canon) phoneParts.push(canon);
      const phoneStyle = loadPromptFile("phone_style.md");
      if (phoneStyle) phoneParts.push(phoneStyle);
      const phonePrompt = phoneParts.join("\n\n---\n\n");

      // ⑤ Skill 约束
      const skillCatalog = buildSkillCatalog(skillRegistry.getEnabled());
      const skillActivation = resolveSlashActivation(messages);

      // ⑥ 语气注入
      let toneInjection = "";
      const sceneProvider = getSceneEmbeddingProvider();
      if (sceneProvider && sceneEmbeddingIndex) {
        try { toneInjection = await buildToneInjection(userText, messages, sceneProvider, sceneEmbeddingIndex); } catch { /* ignore */ }
      }

      return timeStr + "\n\n" +
        (alwaysOnContext ? alwaysOnContext + "\n\n" : "") +
        (memoryInjection ? memoryInjection + "\n\n" : "") +
        phonePrompt +
        (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
        skillActivation +
        toneInjection;
    },
    // 天气快捷处理：正则匹配到天气关键词 → 调 weather 工具的 execute
    async (userText: string) => {
      try {
        const weatherTool = toolRegistry.getById("weather");
        if (!weatherTool) return null;
        // 提取城市名（简单匹配：XX天气 / XX的天气）
        const cityMatch = userText.match(/([北京上海广州深圳成都杭州南京武汉西安重庆天津苏州长沙郑州青岛大连沈阳哈尔滨长春济南太原合肥南昌福州昆明贵阳拉萨乌鲁木齐呼和浩特]+)/);
        const city = cityMatch?.[1] ?? "";
        const result = await weatherTool.execute({ city }, undefined);
        return result;
      } catch (err) {
        console.warn("[Call] 天气查询失败:", err);
        return null;
      }
    },
  );

  // 注入子代理 LLM 配置（delegate_task 工具用，复用主模型配置）
  setDelegateSettings(() => {
    const s = loadModelSettings();
    return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey };
  });

  mainWindow.on("closed", () => {
    petWindowMoveController.dispose();
    live2dWindowLifecycle.clear(mainWindow ?? undefined);
    mainWindow = null;
  });
}


function createChatWindow(sessionId?: string): void {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    handleChatWindowOpened();  // Opener 响应窗口内打开 chat = 接话
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
    height: 760,
    minWidth: 960,
    minHeight: 540,
    title: "Cyrene · 聊天",
    icon: getCurrentAppIconPath(),
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
    handleChatWindowOpened();  // Opener 响应窗口内打开 chat = 接话
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
    height: 760,
    minWidth: 56,
    minHeight: 540,
    title: "昔涟 · 状态",
    icon: getCurrentAppIconPath(),
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
    height: 760,
    minHeight: 540,
    title: "昔涟 · 今日日程",
    icon: getCurrentAppIconPath(),
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
  const height = 920;
  settingsWindow = new BrowserWindow({
    x: dx + Math.max(0, Math.floor((dw - width) / 2)),
    y: dy + Math.max(0, Math.floor((dh - height) / 2)),
    width,
    height,
    minWidth: 920,
    minHeight: 580,
    title: "昔涟 · 设置",
    icon: getCurrentAppIconPath(),
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

/** 创建通话窗口（450×800 竖屏，语音通话）。 */
function createCallWindow(): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.show();
    callWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { width: dw, height: dh } = display.workArea;
  const CALL_W = 420;
  const CALL_H = 800;
  const cx = Math.max(0, Math.floor((dw - CALL_W) / 2));
  const cy = Math.max(0, Math.floor((dh - CALL_H) / 2));

  callWindow = new BrowserWindow({
    x: display.workArea.x + cx,
    y: display.workArea.y + cy,
    width: CALL_W,
    height: CALL_H,
    minWidth: 420,
    minHeight: 600,
    title: "Cyrene · 语音通话",
    icon: getCurrentAppIconPath(),
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
    callWindow.loadURL("http://localhost:5173/call/");
  } else {
    callWindow.loadFile(path.join(__dirname, "..", "..", "renderer", "call", "index.html"));
  }

  callWindow.once("ready-to-show", () => {
    callWindow?.show();
  });

  callWindow.on("closed", () => {
    callWindow = null;
    stopCall();
    setCallWindow(null);
  });

  // 绑定给 call-manager
  setCallWindow(callWindow);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(getCurrentAppIconPath());
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "打开状态面板",
      click: () => { createSidebarWindow(); },
    },
    {
      label: "设置",
      click: () => { createSettingsWindow(); },
    },
    {
      label: "显示/隐藏桌宠",
      click: () => {
        if (mainWindow) {
          mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        }
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => { app.quit(); },
    },
  ]);

  tray.setToolTip("Cyrene");
  tray.setContextMenu(contextMenu);
}

function applyUiIcon(iconSetting: UiIcon): void {
  const icon = nativeImage.createFromPath(getAppIconPath(iconSetting));
  if (icon.isEmpty()) {
    console.warn("[Cyrene] failed to load selected app icon:", iconSetting);
    return;
  }
  tray?.setImage(icon);
  for (const win of [mainWindow, chatWindow, sidebarWindow, tasksWindow, settingsWindow, stickerManagerWindow, callWindow]) {
    if (win && !win.isDestroyed()) win.setIcon(icon);
  }
}

ipcMain.handle(IPC.WINDOW_SET_INTERACTIVE, (_event, interactive: boolean) => {
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  }
});

ipcMain.on(IPC.WINDOW_MOVE, (_event, dx: number, dy: number) => {
  petWindowMoveController.moveRelative(dx, dy);
});

ipcMain.on(IPC.WINDOW_MOVE_TO, (_event, x: number, y: number) => {
  petWindowMoveController.queueAbsolute(x, y);
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
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (!isDragging) petWindowMoveController.finishDragging();
  try {
    window.setOpacity(isDragging ? 0.99 : 1.0);
  } catch (error) {
    console.warn("[Cyrene] Failed to update pet window dragging opacity:", error);
  }
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

ipcMain.handle(IPC.LIVE2D_GET_MAIN_DIAGNOSTICS, () => ({
  window: live2dWindowLifecycle.getDiagnostics(),
}));

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

// 推理下拉原子读：{ providerKey, providerId, model, preference }
// providerKey = settings.provider（displayName），用来防竞态；chat:setReasoning 需携带同 providerKey。
ipcMain.handle(IPC.CHAT_GET_REASONING_STATE, () => {
  const settings = loadModelSettings();
  const cap = getCapabilityOrOpenAI(settings.provider);
  return {
    providerKey: settings.provider,
    providerId: cap.id,
    model: settings.model,
    preference: settings.perProvider?.[settings.provider]?.reasoning,
  };
});

// 推理下拉写：原子。payload 形如 { providerKey, preference }，providerKey 防竞态。
ipcMain.handle(IPC.CHAT_SET_REASONING, (_event, payload: unknown) => {
  if (!payload || typeof payload !== "object") return;
  const p = payload as { providerKey?: unknown; preference?: unknown };
  if (typeof p.providerKey !== "string" || typeof p.preference !== "object" || !p.preference) return;
  const current = loadModelSettings();
  if (current.provider !== p.providerKey) {
    // 竞态：用户拿到 state 后、点选项前，provider 已切换。丢弃旧 providerKey 的写。
    return;
  }
  const normalized = normalizeReasoningPreference(p.preference);
  if (!normalized) return;
  saveModelSettings({ reasoning: normalized });
});
ipcMain.handle(IPC.CHAT_SEND_MESSAGE, async (_event, messages: unknown) => {
  proactiveConversationLifecycle.onUserMessage();
  proactiveConversationLifecycle.onConversationStarted();
  try {
    return await requestModelReply(messages);
  } finally {
    proactiveConversationLifecycle.onConversationEnded();
  }
});

ipcMain.handle(IPC.CHAT_INGEST_FILES, async (_event, paths: unknown) => {
  const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
  if (list.length === 0) return [];
  try {
    return list.map((filePath) => describePendingAttachment(filePath));
  } catch (err: any) {
    console.error("[Cyrene] ingestFiles ERROR:", err?.message || err);
    return [];
  }
});

ipcMain.handle(IPC.CHAT_PROCESS_DOCUMENTS, async (event, payload: unknown) => {
  const filePaths = payload && typeof payload === "object" && Array.isArray((payload as { filePaths?: unknown }).filePaths)
    ? (payload as { filePaths: unknown[] }).filePaths.filter((p): p is string => typeof p === "string")
    : [];
  if (filePaths.length === 0) return [];
  const query = typeof (payload as { query?: unknown }).query === "string"
    ? (payload as { query: string }).query
    : "";
  return processDocumentIndexRequest({
    filePaths,
    query,
    sender: event.sender,
    enqueue: enqueueDocumentIndexJob,
    retrieve: retrieveQueuedDocumentChunks,
  });
});

ipcMain.handle(IPC.CHAT_CANCEL_DOCUMENT_INDEX, (_event, payload: unknown) => {
  const jobId = payload && typeof payload === "object" ? (payload as { jobId?: unknown }).jobId : undefined;
  return typeof jobId === "string" && cancelDocumentIndexJob(jobId);
});

ipcMain.handle(IPC.CHAT_CAPTION_IMAGE, async (_event, payload: unknown) => {
  const filePath = payload && typeof payload === "object"
    ? (payload as { filePath?: unknown }).filePath
    : undefined;
  const validated = validateCaptionImagePath(filePath);
  if (!validated.ok) return { ok: false, error: validated.error };

  const visionCfg = loadVisionConfig();
  if (!visionCfg) {
    return { ok: false, error: "未配置视觉模型，无法分析图片" };
  }

  try {
    const { captionImage } = await import("./orchestrator/vision-captioner");
    const caption = await captionImage(
      { base64: validated.buffer.toString("base64"), mime: validated.mime },
      IMAGE_CAPTION_PROMPT,
      visionCfg,
    );
    if (caption.startsWith("[错误")) {
      return { ok: false, error: caption };
    }
    return { ok: true, caption };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle(IPC.CHAT_GET_IMAGE_SEND_STRATEGY, () => {
  const settings = loadModelSettings();
  return decideImageSendStrategy({
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    vision: loadVisionConfig(),
  });
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

ipcMain.on(IPC.SIDEBAR_OPEN_CALL, () => {
  createCallWindow();
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

ipcMain.handle(IPC.SETTINGS_GET_TIMEOUT_SETTINGS, () => {
  return getTimeoutSettings();
});

ipcMain.handle(IPC.SETTINGS_SAVE_TIMEOUT_SETTINGS, (_event, settings: Partial<TimeoutSettings>) => {
  return saveTimeoutSettings(settings);
});

ipcMain.handle(IPC.UI_THEME_GET, () => {
  return loadGeneralSettings().uiTheme;
});

ipcMain.handle(IPC.UI_FONT_GET, () => {
  return loadGeneralSettings().uiFont;
});

function getUiFontsDir(): string {
  return path.join(app.getPath("userData"), "ui-fonts");
}

function getCustomFontDisplayName(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, " ").trim().slice(0, 80) || "自定义字体";
}

ipcMain.handle(IPC.SETTINGS_PICK_UI_FONT, async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "字体文件", extensions: ["ttf", "otf"] }],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle(IPC.SETTINGS_IMPORT_UI_FONT, (_event, sourcePath: unknown) => {
  if (typeof sourcePath !== "string" || !sourcePath) throw new Error("未选择字体文件");
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension !== ".ttf" && extension !== ".otf") throw new Error("仅支持 .ttf 或 .otf 字体文件");
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 50 * 1024 * 1024) throw new Error("字体文件无效或超过 50 MB");

  const fileName = `custom-${randomUUID()}${extension}`;
  if (!isSupportedFontFileName(fileName)) throw new Error("字体文件名无效");
  const fontsDir = getUiFontsDir();
  fs.mkdirSync(fontsDir, { recursive: true });
  const targetPath = path.join(fontsDir, fileName);
  fs.copyFileSync(sourcePath, targetPath);

  const before = loadGeneralSettings().uiFont;
  const saved = saveGeneralSettings({ uiFont: { kind: "custom", fileName, displayName: getCustomFontDisplayName(sourcePath) } });
  if (before.kind === "custom" && before.fileName !== fileName) {
    const oldPath = path.join(fontsDir, before.fileName);
    if (isSupportedFontFileName(before.fileName)) fs.rmSync(oldPath, { force: true });
  }
  return saved.uiFont;
});

ipcMain.handle(IPC.SETTINGS_RESET_UI_FONT, () => {
  const before = loadGeneralSettings().uiFont;
  const saved = saveGeneralSettings({ uiFont: DEFAULT_UI_FONT });
  if (before.kind === "custom" && isSupportedFontFileName(before.fileName)) {
    fs.rmSync(path.join(getUiFontsDir(), before.fileName), { force: true });
  }
  return saved.uiFont;
});

ipcMain.handle(IPC.SETTINGS_SAVE_GENERAL, (_event, settings: Partial<GeneralSettings>) => {
  const saved = saveGeneralSettings(settings);
  if ("proactiveChatMode" in settings || "proactiveDeliveryTarget" in settings || "openerMode" in settings) {
    stopOpener();
    proactiveChatService?.invalidate();
    if (saved.proactiveChatMode === "on") {
      startOpener(saved.openerMode === "off" ? "normal" : saved.openerMode);
    }
  }
  return saved;
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

ipcMain.on(IPC.SETTINGS_SET_PET_ZOOM, (_event, value: number) => {
  const saved = saveGeneralSettings({ ...loadGeneralSettings(), petZoom: Number(value) });
  applyPetZoom(saved.petZoom);
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
      await reconcileUserMemoryIndex();
      saveModelSettings({ embeddingModel: modelKey as "minilm" | "bgem3" });
      broadcastModelConfigChanged();
      stickerEmbeddingIndex = null;
      refreshStickerEmbeddingIndexInBackground("embedding-model-switch");
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

ipcMain.handle(IPC.RERANKER_GET_STATUS, () => {
  return getRerankerInstallStatus();
});

ipcMain.handle(IPC.MODEL_GET_INSTALL_STATUS, () => {
  const { getModelInstallStatus } = require("./rag/model-status");
  return getModelInstallStatus();
});

ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { ok: false, error: "Invalid URL" };
  }
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
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
  const id = typeof record?.id === "string" ? record.id : null;
  if (!id) return getStickerManagerConfig();
  setStickerEnabled(id, Boolean(record.enabled));
  return getStickerManagerConfig();
});

ipcMain.handle(IPC.STICKERS_PICK_FILE, async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle(IPC.STICKERS_ADD, async (_event, payload: unknown) => {
  const { sourcePath, id, description, phrases } = payload as {
    sourcePath: string;
    id: string;
    description: string;
    phrases: string[];
  };
  try {
    await addUserSticker(sourcePath, id, description, phrases);
    stickerEmbeddingIndex = null;
    refreshStickerEmbeddingIndexInBackground("user-sticker-add");
  } catch (err) {
    console.error("[stickers] add failed:", err);
    throw err;
  }
  return getStickerManagerConfig();
});

ipcMain.handle(IPC.STICKERS_DELETE, async (_event, id: string) => {
  try {
    await deleteUserSticker(id);
    stickerEmbeddingIndex = null;
    refreshStickerEmbeddingIndexInBackground("user-sticker-delete");
  } catch (err) {
    console.error("[stickers] delete failed:", err);
    throw err;
  }
  return getStickerManagerConfig();
});

ipcMain.handle(IPC.STICKERS_GET_ENABLED, () => {
  const stickerSettings = loadStickerSettings();
  return getAllStickerConfig(stickerSettings).filter((s) => s.enabled);
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

ipcMain.handle(IPC.SKILL_LIST, () => {
  return listSkillsForUi();
});

ipcMain.handle(IPC.SKILL_SET_ENABLED, (_event, payload: unknown) => {
  const p = payload as { id?: string; enabled?: boolean };
  if (!p.id) return { ok: false, error: "missing skill id" };
  setSkillEnabled(p.id, p.enabled !== false);
  console.log("[Skill] " + p.id + " enabled=" + (p.enabled !== false));
  return { ok: true };
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

ipcMain.on(IPC.SETTINGS_OPEN_CHROME_GPU, async () => {
  const win = new BrowserWindow({ width: 1024, height: 768 });
  win.loadURL("chrome://gpu");
  win.show();
});

// 注册本地用户资源协议（表情包图片与用户导入的字体）
// 必须在 app.ready 之前调用
protocol.registerSchemesAsPrivileged([
  { scheme: "local-sticker", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: "local-font", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (loadGeneralSettings().disableGpuElectron) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}

app.whenReady().then(async () => {
  // 注册 local-sticker:// 协议处理器：将请求映射到 userData/stickers/ 下的文件
  protocol.handle("local-sticker", (request) => {
    const file = parseLocalStickerFileFromUrl(request.url);
    if (!file) return new Response("Invalid sticker URL", { status: 404 });

    const filePath = resolveLocalStickerPath(getStickersDir(), file);
    if (!filePath) return new Response("Invalid sticker path", { status: 403 });

    return net.fetch(pathToFileURL(filePath).toString());
  });
  protocol.handle("local-font", (request) => {
    let fileName: string;
    try {
      fileName = decodeURIComponent(new URL(request.url).hostname);
    } catch {
      return new Response("Invalid font URL", { status: 404 });
    }
    if (!isSafeUiFontRequest(fileName)) return new Response("Invalid font URL", { status: 404 });
    const filePath = path.join(getUiFontsDir(), fileName);
    if (path.dirname(filePath) !== getUiFontsDir() || !fs.existsSync(filePath)) return new Response("Font not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString()).then((response) => new Response(response.body, {
      headers: getUiFontResponseHeaders(fileName),
    }));
  });
  // Token 用量查询 IPC
  ipcMain.handle(IPC.TOKEN_USAGE_GET, (_event, days: number) => {
    return getUsage(Math.max(1, Math.min(90, Number(days) || 7)));
  });

  ipcMain.on(IPC.LIVE2D_SPEECH_PREPARE, () => {
    sendToLive2DWindow(IPC.LIVE2D_SPEECH_PREPARE);
  });
  ipcMain.on(IPC.LIVE2D_MOUTH_START, (_event, payload: { durationMs?: number }) => {
    sendToLive2DWindow(IPC.LIVE2D_MOUTH_START, { durationMs: Number(payload?.durationMs ?? 0) });
  });
  ipcMain.on(IPC.LIVE2D_MOUTH_STOP, () => {
    sendToLive2DWindow(IPC.LIVE2D_MOUTH_STOP);
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

    // Playwright MCP：按 settings 字段自动连接/断开
    if ("playwrightMcpEnabled" in tts) {
      await syncPlaywrightMcp(saved);
    }

    // 主动聊天总开关或频率变化时重启。
    if ("openerMode" in tts || "proactiveChatMode" in tts) {
      stopOpener();
      proactiveChatService?.invalidate();
      if (saved.proactiveChatMode === "on") {
        startOpener(saved.openerMode === "off" ? "normal" : saved.openerMode);
      }
    }

    // 返回不含密钥明文的副本（前端展示用）
    return saved;
  });
  ipcMain.handle(IPC.TTS_LOAD_SETTINGS, () => {
    return loadGeneralSettings();
  });

  // Opener 反馈：点气泡接话
  ipcMain.on(IPC.OPENER_FEEDBACK, (_event, payload: { type: "clicked"; sceneId: string; itemId: string }) => {
    if (payload?.type === "clicked") {
      handleBubbleClick(payload.sceneId, payload.itemId);
    }
  });

  // Opener 手动测试气泡
  ipcMain.handle(IPC.OPENER_TEST_FIRE, async () => { await testFire(); });

  ipcMain.handle(IPC.OPENER_GET_STATUS, () => {
    const packDir = getOpenerPackDir();
    const manifestPath = getManifestPath();
    return {
      manifestInstalled: fs.existsSync(manifestPath),
      packDir,
      manifestPath,
    };
  });

  ipcMain.handle(IPC.OPENER_OPEN_PACK_DIR, async () => {
    const packDir = getOpenerPackDir();
    try {
      fs.mkdirSync(packDir, { recursive: true });
      const error = await shell.openPath(packDir);
      return error ? { ok: false, error } : { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.OPENER_OPEN_INSTALL_DOCS, async () => {
    const docPath = path.join(app.getAppPath(), "docs", "opener-pack.md");
    try {
      if (!fs.existsSync(docPath)) return { ok: false, error: "安装说明文档不存在：" + docPath };
      const error = await shell.openPath(docPath);
      return error ? { ok: false, error } : { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
    const audioBuffer = await ttsSynthesize({
      ...payload,
      debugLog: appendMinimaxTtsLog,
    });
    // Buffer → base64 传给渲染进程（渲染进程用 atob 解码再播）
    return audioBuffer.toString("base64");
  });

  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => {
    const format = payload.format ?? "mp3";

    // 回听优先：如果 expectedCacheKey 对应的缓存文件存在，直接返回，不需要 apiKey/voiceId。
    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendMinimaxTtsLog({
        requestId: `tts-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
      };
    }

    // 缓存未命中 → 需要合成，检查 apiKey/voiceId
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text || payload.apiKey === "cache-only") {
      throw new Error("缓存未命中且缺少必要参数（apiKey/voiceId/text）");
    }

    const cacheKey = buildTtsCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const audioBuffer = await ttsSynthesize({
      ...payload,
      format,
      debugLog: appendMinimaxTtsLog,
    });
    fs.writeFileSync(audioPath, audioBuffer);
    appendMinimaxTtsLog({
      requestId: `tts-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: audioBuffer.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: audioBuffer.toString("base64"),
      cacheKey,
      cached: false,
    };
  });

  // 流式语音合成（minimax WS 边合成边推 chunk 给渲染端播）
  // 主进程同时攒完整 buffer 落盘缓存，下次同文本走缓存
  ipcMain.handle(IPC.TTS_STREAM_START, async (event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => {
    const format = payload.format ?? "mp3";
    const sender = event.sender;

    // 回听优先：expectedCacheKey 命中缓存直接发完整 base64（走 STREAM_END，不走 chunk）
    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try { expectedPath = getTtsCachePath(payload.expectedCacheKey, format); } catch { /* */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuf = fs.readFileSync(expectedPath);
      appendMinimaxTtsLog({
        requestId: `tts-stream-cache-${Date.now()}`,
        ts: new Date().toISOString(),
        phase: "stream.cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuf.length,
      });
      // 缓存命中：一次性发完整音频（渲染端会按 STREAM_END 处理，直接播完整 buffer）
      sender.send(IPC.TTS_AUDIO_CHUNK, { base64: cachedBuf.toString("base64") });
      sender.send(IPC.TTS_STREAM_END, { cacheKey: payload.expectedCacheKey, cached: true, format });
      return { started: false, cacheKey: payload.expectedCacheKey, cached: true };
    }

    if (!payload?.apiKey || !payload?.voiceId || !payload?.text) {
      throw new Error("流式合成缺少必要参数（apiKey/voiceId/text）");
    }

    const cacheKey = buildTtsCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    const fullChunks: Buffer[] = [];

    // 异步合成，不 await（handler 立即返回，chunk 通过 send 推送）
    void (async () => {
      try {
        const audioBuffer = await ttsSynthesize({
          apiKey: payload.apiKey,
          voiceId: payload.voiceId,
          text: payload.text,
          speed: payload.speed,
          volume: payload.volume,
          pitch: payload.pitch,
          model: payload.model,
          format,
          debugLog: appendMinimaxTtsLog,
          onChunk: (chunkBase64) => {
            fullChunks.push(Buffer.from(chunkBase64, "base64"));
            if (!sender.isDestroyed()) sender.send(IPC.TTS_AUDIO_CHUNK, { base64: chunkBase64 });
          },
        });
        // 落盘缓存（用完整 buffer，不用拼接的 fullChunks——synthesize 返回的更可靠）
        fs.writeFileSync(audioPath, audioBuffer);
        appendMinimaxTtsLog({
          requestId: `tts-stream-${Date.now()}`,
          ts: new Date().toISOString(),
          phase: "stream.cache.write",
          cacheKey,
          audioBytes: audioBuffer.length,
        });
        if (!sender.isDestroyed()) sender.send(IPC.TTS_STREAM_END, { cacheKey, cached: false, format });
      } catch (err) {
        if (!sender.isDestroyed()) {
          sender.send(IPC.TTS_STREAM_ERROR, { message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();

    return { started: true, cacheKey, cached: false };
  });

  // GPT-SoVITS 语音合成 → base64 音频（测试发音用，不缓存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_GPTSOVITS, async (_event, payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
  }) => {
    if (!payload?.baseUrl || !payload?.refAudioPath || !payload?.promptText || !payload?.text) {
      throw new Error("缺少必要参数（baseUrl/refAudioPath/promptText/text）");
    }
    const result = await gptsovitsSynthesize({
      ...payload,
      debugLog: appendGptsovitsTtsLog,
    });
    const cacheKey = buildGptsovitsCacheKey(payload);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // GPT-SoVITS 语音合成 + 本地缓存（聊天朗读用）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_GPTSOVITS, async (_event, payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => {
    const format: "wav" | "mp3" = payload.format ?? "wav";

    // 回听优先：如果 expectedCacheKey 对应的缓存文件存在，直接返回，不需要 baseUrl/refAudioPath。
    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendGptsovitsTtsLog({
        requestId: `gptsovits-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
        format,
      };
    }

    // 缓存未命中 → 需要合成，检查必要参数
    if (!payload?.baseUrl || !payload?.refAudioPath || !payload?.promptText || !payload?.text) {
      throw new Error("缓存未命中且缺少必要参数（baseUrl/refAudioPath/promptText/text）");
    }

    const cacheKey = buildGptsovitsCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const result = await gptsovitsSynthesize({
      baseUrl: payload.baseUrl,
      refAudioPath: payload.refAudioPath,
      promptText: payload.promptText,
      text: payload.text,
      speed: payload.speed,
      format,
      debugLog: appendGptsovitsTtsLog,
    });
    fs.writeFileSync(audioPath, result.audio);
    appendGptsovitsTtsLog({
      requestId: `gptsovits-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: result.audio.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 自定义云端 TTS 合成 → base64 音频（测试发音用，不缓存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CUSTOM_CLOUD, async (_event, payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
  }) => {
    if (!payload?.endpointUrl || !payload?.text) {
      throw new Error("缺少必要参数（endpointUrl/text）");
    }
    const result = await customCloudSynthesize({
      ...payload,
      debugLog: appendCustomCloudTtsLog,
    });
    const cacheKey = buildCustomCloudCacheKey(payload);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 自定义云端 TTS 合成 + 本地缓存（聊天朗读用）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_CUSTOM_CLOUD, async (_event, payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
    expectedCacheKey?: string;
  }) => {
    const format: "wav" | "mp3" = payload.format ?? "mp3";

    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendCustomCloudTtsLog({
        requestId: `custom-cloud-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
        format,
      };
    }

    if (!payload?.endpointUrl || !payload?.text) {
      throw new Error("缓存未命中且缺少必要参数（endpointUrl/text）");
    }

    const cacheKey = buildCustomCloudCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const result = await customCloudSynthesize({
      endpointUrl: payload.endpointUrl,
      apiKey: payload.apiKey,
      voiceId: payload.voiceId,
      text: payload.text,
      speed: payload.speed,
      volume: payload.volume,
      format,
      timeoutMs: payload.timeoutMs,
      debugLog: appendCustomCloudTtsLog,
    });
    fs.writeFileSync(audioPath, result.audio);
    appendCustomCloudTtsLog({
      requestId: `custom-cloud-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: result.audio.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 小米 MiMo TTS 合成 → base64 音频（测试发音用，不缓存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_MIMO, async (_event, payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
  }) => {
    if (!payload?.apiKey || !payload?.voiceAudioPath || !payload?.text) {
      throw new Error("缺少必要参数（apiKey/voiceAudioPath/text）");
    }
    const result = await mimoSynthesize({
      apiKey: payload.apiKey,
      voiceAudioPath: payload.voiceAudioPath,
      text: payload.text,
      stylePrompt: payload.stylePrompt,
      debugLog: appendMimoTtsLog,
    });
    const cacheKey = buildMimoCacheKey(payload);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 小米 MiMo TTS 合成 + 本地缓存（聊天朗读用）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_MIMO, async (_event, payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
    expectedCacheKey?: string;
  }) => {
    const format: "wav" = "wav";

    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendMimoTtsLog({
        requestId: `mimo-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
        format,
      };
    }

    if (!payload?.apiKey || !payload?.voiceAudioPath || !payload?.text || payload.apiKey === "cache-only") {
      throw new Error("缓存未命中且缺少必要参数（apiKey/voiceAudioPath/text）");
    }

    const cacheKey = buildMimoCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const result = await mimoSynthesize({
      apiKey: payload.apiKey,
      voiceAudioPath: payload.voiceAudioPath,
      text: payload.text,
      stylePrompt: payload.stylePrompt,
      debugLog: appendMimoTtsLog,
    });
    fs.writeFileSync(audioPath, result.audio);
    appendMimoTtsLog({
      requestId: `mimo-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: result.audio.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 聊天会话存储 IPC（chats-store.initialize 会建好 cyrene-chats 目录并加载 index）
  registerChatsIpc();
  initializeProactiveChatService();

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

  // 出行工具（路线规划——驾车/步行/骑行/公交，复用 amapKey）
  registerTravelTools();

  // 邮件发送工具（SMTP 直发，需在设置里配置 SMTP 授权码）
  registerEmailTools();
  syncBuiltInToolToggles(loadGeneralSettings());

  // 内置 MCP 自动连接：Playwright (默认关闭,选项控制)
  const initialSettings = loadGeneralSettings();

  // 一次性清理已下架的内置 MCP（Firecrawl hosted 等）
  const removed = await pruneMcpServersByIds([...REMOVED_BUILTIN_MCP_IDS]);
  if (removed.length > 0) {
    console.log("[Cyrene] 已清理遗留的已下架内置 MCP:", removed.join(", "));
  }

  void syncPlaywrightMcp(initialSettings).catch((e) =>
    console.error("[Cyrene] playwright MCP sync failed:", e)
  );

  // Cloud Music MCP wiring (MusicService + IPC + 5 Agent tools + shutdown latch)
  const musicPaths = resolveMusicPaths();
  const musicBootstrap = bootstrapMusicService(musicPaths, {
    onPresented: recordMusicCompanionPresentation,
    sendCard: (card) => {
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.webContents.send(IPC.AGUI_EVENT, {
          type: "CUSTOM",
          name: "cyrene.music",
          value: card,
        });
      }
    },
  });
  installShutdownLatch(musicBootstrap);

  // Skill 系统：扫描双源 skills + 注册 meta-tool
  initSkills();
  try {
    loadMusicCompanionHost(
      path.join(app.getAppPath(), "dist", "skills", "cyrene-music-companion", "index.js"),
      () => ({
        skillEnabled: skillRegistry.getById("cyrene-music-companion")?.enabled === true,
        backendAvailable: ["ready", "degraded"].includes(musicBootstrap.service.getBackendState()),
        enabledTools: toolRegistry.getEnabledTools().map((tool) => tool.id),
      }),
    );
    skillRegistry.setAvailability("cyrene-music-companion", isMusicCompanionAvailable);
  } catch (err) {
    console.error("[MusicCompanion] 复合 Skill 加载失败:", err);
    skillRegistry.setAvailability("cyrene-music-companion", () => false);
  }

  // 游戏代肝：IPC + game_bot_start 工具
  initGameBot();

  // 多渠道（微信/飞书/...）：先注入 dispatcher 的 buildAndRunAgent + TTS + 镜像广播 + 最近历史读取，
  // 让 channels 模块拿到真 agent + 出站增强能力 + 对话上下文。
  setDispatcherLoadRecentHistory(async (sessionId, limit) => {
    // 委托给 history-log：读 userData/channels/history/<sessionId>.jsonl 最新 N 条
    const { loadRecentHistory } = await import("./channels/history-log");
    return loadRecentHistory(sessionId, limit);
  });
  setDispatcherLoadGeneralSettings(loadGeneralSettings);

  setDispatcherBuildAndRunAgent(async (msg, sessionId, priorMessages) => {
    // 渠道响应结果：统一由 dispatcher 按 cap 降级到 OutgoingMessage.parts。
    // 包含 sticker 决定（从 onAgentRunFinished 返回，避免在 dispatcher 端重新算一遍 embedding）。
    const channelResult: { text: string; sticker: string | null } = { text: "", sticker: null };

    // Phase 3.3：按 toolSandbox 过滤可用工具
    const sandbox = loadChannelsSettings().toolSandbox;
    const allTools = toolRegistry.getEnabledTools();
    const filteredTools: ToolDefinition[] = sandbox === "safe-only"
      ? allTools.filter((t) => (t.risk ?? "safe") === ("safe" as ToolRiskLevel))
      : allTools;
    console.log(
      "[Channels] bot run:",
      `msg.channel=${msg.channel} sandbox=${sandbox} tools=${filteredTools.length}/${allTools.length} priorMsgs=${priorMessages?.length ?? 0}`,
    );

    // Phase A：拼接历史 (同桌面端 buildModelMessages 行为: 上滑窗最近 N 条).
    // history-log 统一存 role: "user"|"assistant", 直接用即可.
    const historyMessages = (priorMessages ?? [])
      .filter((m) => typeof m.content === "string" && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));

    // 把 IncomingMessage 转成 AguiRunInput，调 CyreneAgent
    const channelModelSettings = loadModelSettings();
    const imageSendStrategy = decideImageSendStrategy({
      provider: channelModelSettings.provider,
      baseUrl: channelModelSettings.baseUrl,
      model: channelModelSettings.model,
      apiKey: channelModelSettings.apiKey,
      explicitTransport: channelModelSettings.explicitTransport,
      vision: loadVisionConfig(),
    });
    const attachmentInputs = await buildChannelAttachmentInputs(msg, {
      imageMode: imageSendStrategy.mode,
      captionImage: async (filePath: string) => {
        const validated = validateCaptionImagePath(filePath);
        if (!validated.ok) return { ok: false, error: validated.error };
        const visionCfg = loadVisionConfig();
        if (!visionCfg) return { ok: false, error: "未配置视觉模型，无法分析图片" };
        try {
          const { captionImage } = await import("./orchestrator/vision-captioner");
          const caption = await captionImage(
            { base64: validated.buffer.toString("base64"), mime: validated.mime },
            IMAGE_CAPTION_PROMPT,
            visionCfg,
          );
          if (caption.startsWith("[错误")) return { ok: false, error: caption };
          return { ok: true, caption };
        } catch (err: any) {
          return { ok: false, error: err?.message || String(err) };
        }
      },
    });
    const { options } = await buildAgentRunOptions(
      {
        messages: [
          ...historyMessages,
          { role: "user", content: msg.text },
        ],
        style: "01_default.md",
        sessionId,
        attachments: attachmentInputs.attachments,
        imageAttachments: attachmentInputs.imageAttachments,
        channel: msg.channel,
      },
      buildOptionsDeps,
    );
    // 把过滤后的 tools 注入 options（覆盖默认的 getEnabledTools）
    options.tools = filteredTools;

    const threadId = `thread-${sessionId}-${Date.now()}`;
    const agent = new CyreneAgent({ threadId, description: `bot:${msg.channel}:${msg.senderId}` });
    const reply = await new Promise<string>((resolve, reject) => {
      agent.runWithEvents(options).subscribe({
        complete: () => {
          resolve(agent.lastResult?.reply ?? "");
        },
        error: (err) => reject(err instanceof Error ? err : new Error(String(err))),
      });
    });
    channelResult.text = reply;
    if (agent.lastResult) {
      const finished = await onAgentRunFinished(agent.lastResult, msg.text, onRunFinishedDeps, msg.channel);
      // 把 sticker 决定透出给 dispatcher，让它纳入 OutgoingMessage.parts；
      // 桌面聊天窗的 sticker 仍由 onAgentRunFinished 内部 IPC 广播承担，此处不重复。
      channelResult.sticker = finished.sticker;
    }
    // 落历史
    void indexConversationTurn(sessionId, msg.text, reply);
    return channelResult;
  });

  // Phase 3.1：注入 TTS 合成 —— dispatcher 在 reply 后会用这个生成渠道音频
  setDispatcherSynthesizeTts(async (text: string, context) => {
    const cfg = loadGeneralSettings();
    if (cfg.ttsEngine === "off") return null;
    if (cfg.ttsEngine === "minimax" && (!cfg.ttsMinimaxKey || !cfg.ttsMinimaxVoiceId)) return null;
    if (cfg.ttsEngine === "gptsovits" && (!cfg.ttsGptsovitsBaseUrl || !cfg.ttsGptsovitsRefAudioPath || !cfg.ttsGptsovitsPromptText)) return null;
    if (cfg.ttsEngine === "custom-cloud" && !cfg.ttsCustomCloudEndpointUrl) return null;
    if (cfg.ttsEngine === "mimo" && (!cfg.ttsMimoKey || !cfg.ttsMimoVoiceAudioPath)) return null;
    // 限制 TTS 文本长度（飞书 audio 100M 限制 + 用户体验，太长应截断）
    const ttsText = text.length > 1000 ? text.slice(0, 1000) + "…" : text;
    try {
      const requestedFormat = context.channel === "wechat" ? "wav" : "mp3";
      const result = await synthesizeByEngine(cfg.ttsEngine, {
        text: ttsText,
        speed: cfg.ttsSpeed,
        volume: cfg.ttsVolume,
        // minimax
        apiKey: cfg.ttsEngine === "mimo"
          ? cfg.ttsMimoKey
          : cfg.ttsEngine === "custom-cloud"
            ? cfg.ttsCustomCloudApiKey
            : cfg.ttsMinimaxKey,
        voiceId: cfg.ttsEngine === "mimo"
          ? ""
          : cfg.ttsEngine === "custom-cloud"
            ? cfg.ttsCustomCloudVoiceId
            : cfg.ttsMinimaxVoiceId,
        model: cfg.ttsMinimaxModel,
        // gptsovits
        baseUrl: cfg.ttsGptsovitsBaseUrl,
        refAudioPath: cfg.ttsGptsovitsRefAudioPath,
        promptText: cfg.ttsGptsovitsPromptText,
        // custom-cloud
        endpointUrl: cfg.ttsCustomCloudEndpointUrl,
        timeoutMs: cfg.ttsCustomCloudTimeoutMs,
        // mimo
        voiceAudioPath: cfg.ttsMimoVoiceAudioPath,
        stylePrompt: cfg.ttsMimoStylePrompt,
        format: requestedFormat,
      });
      const headerHex = result.audio.subarray(0, 4).toString("hex");
      console.log("[TTS verify] engine=", cfg.ttsEngine, "format=", result.format, "header=", headerHex, "size=", result.audio.length);
      return {
        audio: result.audio,
        format: result.format,
        mime: result.format === "wav" ? "audio/wav" : "audio/mpeg",
        extension: result.format === "wav" ? ".wav" : ".mp3",
      };
    } catch (err) {
      console.warn("[Channels] TTS 合成失败:", err instanceof Error ? err.message : err);
      return null;
    }
  });

  // Phase 3.2：注入桌面端镜像广播 —— 把 bot 入站/出站消息推到 chatWindow
  setDispatcherBroadcastChat((event) => {
    const win = chatWindow;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(IPC.AGUI_EVENT, {
        type: "CUSTOM",
        name: "cyrene.botMessage",
        value: event,
      });
    } catch (err) {
      console.warn("[Channels] botMessage 广播失败:", err);
    }
  });

  void initChannels();

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

  const schedulerStore = getSchedulerStore();
  schedulerStore.load();
  const schedulerRunner = createSchedulerRunner({
    buildOptions: async (task: ScheduledTask) => {
      const settings = loadModelSettings();
      if (!settings.apiKey) throw new Error("还没有填写 API Key，请先在设置里保存 API 配置。");
      const messages = [{ role: "user" as const, content: task.prompt }];
      let alwaysOnContext = "";
      try {
        alwaysOnContext = await buildAlwaysOnContext(task.prompt, messages);
      } catch (err) {
        console.warn("[Scheduler] always-on context build failed:", err);
      }
      let environmentContext = "";
      try {
        const profile = loadUserProfile();
        environmentContext = buildEnvironmentContext(
          { provider: settings.provider, model: settings.model },
          { nickname: profile.nickname, callPreference: profile.callPreference, birthday: profile.birthday, defaultCity: profile.defaultCity, timezone: profile.timezone },
        );
      } catch (err) {
        console.warn("[Scheduler] environment context build failed:", err);
      }
      const skillCatalog = buildSkillCatalog(skillRegistry.getEnabled());
      const systemContent =
        (environmentContext ? environmentContext + "\n\n" : "") +
        (alwaysOnContext ? alwaysOnContext + "\n\n" : "") +
        buildSystemPrompt("01_default.md") +
        (skillCatalog ? "\n\n---\n\n" + skillCatalog : "");
      return {
        settings: { provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey },
        messages: [{ role: "system", content: systemContent }, ...messages],
        timeoutMs: getTimeoutSettings().chatRequestTimeout,
      };
    },
    getChatWebContents: () => (chatWindow && !chatWindow.isDestroyed() ? chatWindow.webContents : null),
    recordHistory: (entry) => schedulerStore.recordHistory(entry),
    id: () => `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    now: () => new Date(),
  });
  schedulerEngine = new SchedulerEngine({
    store: schedulerStore,
    runTask: schedulerRunner.runScheduledTask,
  });
  registerSchedulerIpc(schedulerStore, schedulerEngine, () => toolRegistry.getAllTools());

  // AG-UI 事件流桥：渲染进程 invoke(AGUI_RUN) → CyreneAgent 跑 FC 循环 → 事件透传
  // buildOptions 复用 requestModelReply 的上下文构建；onRunFinished 复用副作用
  // Phase 0 重构：抽出到 orchestrator/build-options.ts，三处共用（桌面 / scheduler / bot）
  // deps 函数签名故意宽 (unknown/ReadonlyArray)；这里做一次包装把强类型函数适配进去
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildOptionsDeps: BuildOptionsDeps = {
    loadModelSettings: () => loadModelSettings(),
    loadUserProfile: () => loadUserProfile(),
    buildEnvironmentContext: ((model: { provider: string; model: string }, profile: unknown) =>
      buildEnvironmentContext(model as any, profile as any)) as BuildOptionsDeps["buildEnvironmentContext"],
    buildSkillCatalog: ((skills: ReadonlyArray<unknown>) =>
      buildSkillCatalog(skills as any)) as BuildOptionsDeps["buildSkillCatalog"],
    buildAutoInjectedSkillContext: ((skills: ReadonlyArray<unknown>) =>
      buildAutoInjectedSkillContext(skills as any, (id) => skillRegistry.getBody(id))) as BuildOptionsDeps["buildAutoInjectedSkillContext"],
    skillRegistry: skillRegistry as unknown as BuildOptionsDeps["skillRegistry"],
    resolveSlashActivation: ((messages: ReadonlyArray<{ role: string; content?: string }>) =>
      resolveSlashActivation(messages as any)) as BuildOptionsDeps["resolveSlashActivation"],
    buildToneInjection: (async (userText, messages, provider, index) =>
      buildToneInjection(userText, messages as any, provider as any, index as any)) as BuildOptionsDeps["buildToneInjection"],
    sceneEmbeddingIndex: sceneEmbeddingIndex as unknown,
    getSceneEmbeddingProvider: () => getSceneEmbeddingProvider() as unknown,
    buildAlwaysOnContext: (async (userText, messages) =>
      buildAlwaysOnContext(userText, messages as any)) as BuildOptionsDeps["buildAlwaysOnContext"],
    buildRelationshipContext,
    buildSystemPrompt,
    buildToolSystemPrompt: (enabledTools, isOptimizedFirstRound) => buildToolSystemPrompt(enabledTools as ToolDefinition[], isOptimizedFirstRound),
    buildSoulSystemBasePrompt,
    toolRegistry: { getEnabled: () => toolRegistry.getEnabledTools() },
    logWorldbookInjection,
    normalizeChatMessages: ((raw: ReadonlyArray<unknown>) =>
      normalizeChatMessages(raw as any)) as BuildOptionsDeps["normalizeChatMessages"],
    chatRequestTimeoutMs: getTimeoutSettings().chatRequestTimeout,
    captionImageForFallback: async (filePath: string) => {
      const validated = validateCaptionImagePath(filePath);
      if (!validated.ok) return { ok: false, error: validated.error };
      const visionCfg = loadVisionConfig();
      if (!visionCfg) return { ok: false, error: "未配置视觉模型，无法分析图片" };
      try {
        const { captionImage } = await import("./orchestrator/vision-captioner");
        const caption = await captionImage(
          { base64: validated.buffer.toString("base64"), mime: validated.mime },
          IMAGE_CAPTION_PROMPT,
          visionCfg,
        );
        if (caption.startsWith("[错误")) return { ok: false, error: caption };
        return { ok: true, caption };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    buildMusicCompanionContext,
  };
  const onRunFinishedDeps: OnRunFinishedDeps = {
    loadModelSettings: () => loadModelSettings(),
    scheduleMemoryWrite,
    inferRuntimeState,
    runtimeState,
    feelingToExpression,
    setRuntimeState: (next) => {
      if (next.status !== undefined) runtimeState.status = next.status as RuntimeStatus;
      if (next.expression !== undefined) runtimeState.expression = next.expression;
      if (next.updatedAt !== undefined) runtimeState.updatedAt = next.updatedAt;
      if (next.feeling !== undefined) {
        runtimeState.feeling = next.feeling as RuntimeFeeling;
        feelingScores = createFeelingScores(runtimeState.feeling);
      }
    },
    stickerEmbeddingIndex: stickerEmbeddingIndex as unknown,
    getStickerEmbeddingIndex: () => stickerEmbeddingIndex as unknown,
    getEmbeddingProvider: () => getEmbeddingProvider() as unknown,
    matchSticker: (async (text, provider, index, threshold) =>
      matchSticker(text, provider as any, index as any, threshold) as Promise<{ id: string } | null | undefined>) as OnRunFinishedDeps["matchSticker"],
    loadStickerSettings,
    broadcastRuntimeStateChanged,
    observeRuntimeState: (async (settings, history, userText, reply) =>
      observeRuntimeState(settings as any, history as any, userText, reply)) as OnRunFinishedDeps["observeRuntimeState"],
    recordRelationshipTurn,
    getChatWindow: () => chatWindow,
  };
  registerAgUiIpc(
    async (input: AguiRunInput) => buildAgentRunOptions(input, buildOptionsDeps),
    // 桌面 IPC 路径不消费 sticker（sticker 由 onAgentRunFinished 内部 IPC 广播承担）
    async (result, latestUserText) => { await onAgentRunFinished(result, latestUserText, onRunFinishedDeps); },
    () => chatWindow,
    proactiveConversationLifecycle,
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

  const generalSettings = loadGeneralSettings();
  createWindow();
  createChatWindow();
  if (generalSettings.sidebarVisible) createSidebarWindow();
  if (generalSettings.tasksVisible) createTasksWindow();
  createTray();
  // 权限模块初始化：必须在 createWindow 之后但任意工具调用之前
  initPermissionFromDisk();
  registerPermissionIpc();
  registerChoiceIpc();
  registerCallIpc();
  console.log("[Cyrene] 当前 agent 权限档位:", getCurrentLevel());
  try {
    const modelSettings = loadModelSettings();
    await initRAG("auto", undefined, undefined, modelSettings.embeddingModel);
    try {
      await reconcileUserMemoryIndex();
    } catch (err) {
      console.warn("[Memory/RAG] startup reconciliation failed:", err);
    }
    // 初始化 MCP Manager；scheduler 启动前等待一次，避免近即时任务早于 MCP 工具恢复。
    await initMcpManager();
    console.log("[Cyrene] RAG initialized OK");

    console.log("[Reranker] startup preload skipped; reranker initializes when changed in settings.");
  } catch (err) {
    console.error("[Cyrene] RAG init FAILED:", err);
  }

  scheduleStartupEmbeddingRefreshes();

  schedulerEngine.start();
});

app.on("window-all-closed", () => {});

// 应用退出前把 token 用量缓存落盘（防抖未触发的最后一次写）
app.on("before-quit", () => {
  petWindowMoveController.dispose();
  schedulerEngine?.stop();
  stopOpener();
  flushTokenUsage();
  void shutdownChannels();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});







