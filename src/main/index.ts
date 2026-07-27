import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, shell, dialog, protocol, net, desktopCapturer } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createHash } from "crypto";
import * as zlib from "zlib";
import { pathToFileURL } from "url";
import { IPC } from "../shared/ipc-channels";
import { compactPetReply } from "./pet-chat";
import { STATUS_KEYWORDS } from "./status-keywords";
import { initRAG, buildMemoryContext, addMemory, removeMemory, importDocument, switchEmbeddingModel, deleteImportedDoc } from "./rag";
import { getEmbeddingProvider, getSceneEmbeddingProvider } from "./rag/embedding";
import { ingestPaths } from "./rag/file-ingest";
import { buildAlwaysOnContext, buildMemoryInjection, runFunctionCallingLoop, scheduleMemoryWrite } from "./orchestrator";
import { CyreneAgent } from "./orchestrator/cyrene-agent";
import { indexConversationTurn } from "./orchestrator/history-tools";
import { buildToneInjection } from "./orchestrator/tone-injector";
import { getAdapter, buildVendorUrl, getAdapterForConfig, createSseReader } from "./orchestrator/vendors";
import type { VendorConfig } from "./orchestrator/vendors";
import { getCapability } from "./orchestrator/vendors/capabilities";
import type { VisionConfig } from "./orchestrator/vision-captioner";
import { toolRegistry, type ToolDefinition } from "./orchestrator/tool-registry";
import type { ToolRiskLevel } from "./permission";
import { toTraditionalTaiwan } from "./utils/opencc";
import { loadChannelsSettings } from "./channels/settings-store";
import { channelManager } from "./channels/manager";
// 觸發 built-in-tools 的副作用註冊（fetch_url / run_shell / install_mcp_server）
import "./orchestrator/built-in-tools";
// 觸發 fs-tools 的副作用註冊（read_file / list_dir / write_file / read_image）
import "./orchestrator/fs-tools";
import { initMcpManager, addMcpServer, removeMcpServer, listMcpServers, pruneMcpServersByIds } from "./orchestrator/mcp-manager";
import { syncPlaywrightMcp, PLAYWRIGHT_MCP_ID, REMOVED_BUILTIN_MCP_IDS } from "./sync-mcp-builtin";
import { buildEnvironmentContext } from "./orchestrator/environment";
import { initPermissionFromDisk, registerPermissionIpc, getCurrentLevel } from "./permission";
import { registerChoiceIpc, setChoiceCardSender } from "./user-choice";
import { enqueueLLMTask, getLLMQueueStatus } from "./llm-queue";
import { getEmbeddingStatus, downloadEmbeddingModel, deleteEmbeddingModel } from "./embedding-manager";
import { BUILT_IN_STICKER_DESCRIPTIONS } from "./sticker-descriptions";
import { buildStickerEmbeddingIndex, matchSticker } from "./sticker-embedder";
import type { StickerEmbeddingEntry } from "./sticker-embedder";
import { buildSceneIndex } from "./scene-embedder";
import type { SceneIndex } from "./scene-embedder";
import { loadUserStickerManifest, addUserSticker, deleteUserSticker, getAllStickerConfig, isStickerIdTaken, getStickersDir, resolveStickerImagePath } from "./sticker-storage";
import { parseLocalStickerFileFromUrl, resolveLocalStickerPath } from "./sticker-protocol";
import { normalizeWindowVisibilitySettings } from "./window-visibility-settings";
import type { StickerConfigItem } from "../shared/sticker-types";
import { initReranker, getRerankerInstallStatus } from "./rag/reranker";
import { memoryStore } from "./memory/memory-store"
import type { L0Profile, L1Profile, MemoryEvidence } from "./memory/memory-types";
import { entityGraph } from "./memory/entity-graph";
import { buildMemoryGraphView } from "./memory/memory-views";
import { registerChatsIpc } from "./chats/chats-ipc";
import { recordUsage, getUsage, getUsageByModel, flush as flushTokenUsage } from "./token-usage-store";
import { getCallUsage, flushCallUsage } from "./call-usage-store";
import { uploadFile as ttsUploadFile, cloneVoice as ttsCloneVoice, synthesize as ttsSynthesize } from "./tts/minimax-engine";
import { synthesize as gptsovitsSynthesize } from "./tts/gptsovits-engine";
import { synthesize as customCloudSynthesize } from "./tts/custom-cloud-engine";
import { synthesize as mimoSynthesize } from "./tts/mimo-engine";
import { synthesizeByEngine } from "./tts/tts-dispatcher";
import { startOpener, stopOpener, configureOpener, setLive2dWindow, reloadManifest, handleBubbleClick, handleChatWindowOpened, testFire, showGeneratedBubble, getOpenerStatus } from "./opener/opener-runner";
import type { OpenerRuntimeConfig } from "./opener/opener-types";
import { registerAgUiIpc, type AguiRunInput } from "./agui-bridge";
import { setWeatherConfig, setSearchConfig, loadTodos, onTodosChange, setDelegateSettings, getCurrentTodos } from "./orchestrator/built-in-tools";
import { registerRecallHistoryTool } from "./orchestrator/history-tools";
import { registerDocumentTools } from "./orchestrator/document-tools";
import { registerLifeTools, setTranslateConfig } from "./orchestrator/life-tools";
import { registerTravelTools, setTravelConfig } from "./orchestrator/travel-tools";
import { registerEmailTools, setEmailConfig } from "./orchestrator/email-tools";
import { setAsrConfig } from "./asr/volcano-asr-engine";
import { setCallWindow, registerCallIpc, setCallSettings, stopCall, transcribeCallPcm } from "./call/call-manager";
import { initSkills, skillRegistry, buildSkillCatalog, parseSlashCommand, setSkillEnabled, listSkillsForUi } from "./skills";
import { initGameBot } from "./game-bot";
import { initGameRoom } from "./game-room";
import { initChannels, shutdownChannels } from "./channels/init";
import { setDispatcherBuildAndRunAgent, setDispatcherSynthesizeTts, setDispatcherBroadcastChat, setDispatcherLoadRecentHistory } from "./channels/dispatcher";
import { setDiscordVoiceServices } from "./channels/adapters/discord/voice-call";
import {
  getSharedNotebookPath,
  onSharedNotebookChanged,
  recordDiscordToolActionsInNotebook,
} from "./channels/adapters/discord/notebook-activity";
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
import { getDailyRitualPrompt, isDailyRitualTask, syncDailyRitualTasks } from "./rituals/daily-rituals";
import { BackupManager } from "./security/backup-manager";
import { getVaultStatus, migrateFilesToVault, protectSecrets, redactSecrets, revealSecrets } from "./security/secret-vault";
import { getAgentActivities, getAgentActivitySummary } from "./agent-activity-store";
import { transcribeOfflineWhisper } from "./asr/offline-whisper-engine";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let chatWindow: BrowserWindow | null = null;
let sidebarWindow: BrowserWindow | null = null;
let sidebarRestoreBounds: { x: number; y: number; width: number; height: number } | null = null;
let isSidebarExpanded = false;

onSharedNotebookChanged(() => {
  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    sidebarWindow.webContents.send("shared-notebook:changed");
  }
});
let tasksWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let stickerManagerWindow: BrowserWindow | null = null;
let callWindow: BrowserWindow | null = null;
let schedulerEngine: SchedulerEngine | null = null;
let backupManager: BackupManager | null = null;
// 聊天窗口當前活躍的會話 id（通過 IPC 由聊天窗口上報）；
// 設置面板"刪除當前會話"差異化提示用。聊天窗口關閉時由 closed 事件置 null。
let activeChatSessionId: string | null = null;

const isDev = process.env.VITE_DEV === "1";

function appendMinimaxTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "minimax-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
    if (entry.phase === "request.begin") {
      console.log("[TTS MiniMax] 診斷日誌:", logFile);
    }
  } catch (err) {
    console.warn("[TTS MiniMax] 寫診斷日誌失敗:", err);
  }
}

function appendGptsovitsTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "gptsovits-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
    if (entry.phase === "request.begin") {
      console.log("[TTS GPT-SoVITS] 診斷日誌:", logFile);
    }
  } catch (err) {
    console.warn("[TTS GPT-SoVITS] 寫診斷日誌失敗:", err);
  }
}

function appendCustomCloudTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "custom-cloud-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
    if (entry.phase === "request.begin") {
      console.log("[TTS CustomCloud] 診斷日誌:", logFile);
    }
  } catch (err) {
    console.warn("[TTS CustomCloud] 寫診斷日誌失敗:", err);
  }
}

function appendMimoTtsLog(entry: Record<string, unknown>): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "mimo-tts.log");
    fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
    if (entry.phase === "request.begin") {
      console.log("[TTS MiMo] 診斷日誌:", logFile);
    }
  } catch (err) {
    console.warn("[TTS MiMo] 寫診斷日誌失敗:", err);
  }
}

function getTtsCacheDir(): string {
  return path.join(app.getPath("userData"), "cyrene-tts-cache");
}

function assertTtsCacheKey(cacheKey: string): string {
  if (!/^(minimax|gptsovits|custom-cloud|mimo)-[a-f0-9]{64}$/.test(cacheKey)) {
    throw new Error("非法 TTS 緩存 key");
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

// 單個廠商的可緩存配置：用戶切到別的廠商再切回來，這三個字段從這裡恢復。
interface ProviderProfile {
  baseUrl: string;
  model: string;
  apiKey: string;
  displayName?: string;
  /**
   * 用戶在 settings 顯式指定的 transport；"auto" = 按 baseUrl 啟發式 + capabilities fallback。
   * resolveTransport() 負責把 "auto" 解析為具體 transport。
   * 不存 = 等價於 "auto"。
   */
  explicitTransport?: "openai" | "anthropic" | "auto";
}

/**
 * 廠商名變更映射：舊 providerName → 新 providerName。
 *
 * 觸發時機：UI 上為了對齊"英文名（中文公司名）"格式重命名了 preset 後，
 * 已存盤的 model-settings.json 裡 provider 字段（以及 perProvider 字典的鍵）
 * 仍是舊名；normalize 階段做一次性遷移，把舊名的 perProvider 數據搬到新名下，
 * provider 字段也改寫為新名。遷移後寫盤一次即清除痕跡。
 *
 * 後續如果再次重命名，**只追加鍵值對**，不要刪除老條目，避免迴歸。
 */
const PROVIDER_RENAMES: Record<string, string> = {
  "MiniMax": "MiniMax（稀宇科技）",
  "DeepSeek": "DeepSeek（深度求索）",
  "智譜 GLM": "GLM（智譜）",
  "通義千問（DashScope）": "Qwen（通義千問）",
  "火山 Agent-Plan": "火山 AgentPlan（火山引擎）",
};

/**
 * 把 perProvider 字典 + currentProvider 字段一起套用 PROVIDER_RENAMES。
 * - 舊名 → 新名：直接搬數據；如果新名已存在數據，舊名的不覆蓋（保護"已用新名存過"的情況）。
 * - 不在映射表裡的鍵：原樣保留。
 */
function migrateProviderRenames(
  currentProvider: string,
  perProvider: Record<string, ProviderProfile>,
): { provider: string; perProvider: Record<string, ProviderProfile> } {
  const next: Record<string, ProviderProfile> = {};
  for (const [key, value] of Object.entries(perProvider)) {
    const newKey = PROVIDER_RENAMES[key] ?? key;
    if (next[newKey]) {
      // 新名已經有數據（說明用戶已經在新名下存過），舊名的本地副本保留為最近一次更新優先：
      // 這裡取保守路線 → 不覆蓋 next[newKey]，舊名直接丟棄。
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
  // 用戶給模型起的自定義暱稱，留空時狀態欄用廠商 shortName。
  displayName?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * 當前廠商的 explicitTransport 鏡像（頂層字段是 perProvider[currentProvider] 的視圖）。
   * 詳見 ProviderProfile.explicitTransport。
   */
  explicitTransport?: "openai" | "anthropic" | "auto";
  // 按廠商緩存：currentProvider 之外的廠商配置也保留在這裡，切回來時回填。
  // 真值（source of truth）是 perProvider；頂層 baseUrl/model/apiKey 是當前廠商那一份的展開鏡像，
  // 僅為兼容現有 main 進程裡大量直接讀 settings.baseUrl 等代碼而保留。
  perProvider: Record<string, ProviderProfile>;
  runtimeSync: "off" | "local" | "llm";
  stickerEnabled: boolean;
  stickerSize: StickerSize;
  stickerSimilarityThreshold: number;
  rerankerMode: "light" | "standard" | "none";
  embeddingModel: "minilm" | "bgem3";
  // 視覺模型配置（可選）。undefined 或未啟用 = 不支持看圖，read_image 誠實拒絕。
  vision?: VisionModelConfig;
}

/** 視覺模型配置。syncWithMain=true 時三字段不落盤，運行時強制從主配置讀。 */
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
  /** 默認城市（用於天氣等需要地理定位的工具，沒填則模型會問用戶） */
  defaultCity: string;
}

interface GeneralSettings {
  musicEnabled: boolean;
  musicVolume: number;
  soundEnabled: boolean;
  soundVolume: number;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  /** 桌寵獨立在桌面上時，在下方顯示快速文字輸入列。 */
  petChatInputEnabled: boolean;
  /** 桌寵縮放因子：1.0=默認，0.5~2.0，窗口與模型同步等比縮放。 */
  petZoom: number;
  /** 桌寵窗口 X 座標，未保存時為 undefined */
  petWindowX?: number;
  /** 桌寵窗口 Y 座標，未保存時為 undefined */
  petWindowY?: number;
  sidebarVisible: boolean;
  tasksVisible: boolean;
  launchAtLogin: boolean;
  language: "zh-CN";
  uiTheme: "classic" | "polished-pink" | "pearl-white";
  // TTS 配置
  ttsEngine: "off" | "minimax" | "gptsovits" | "custom-cloud" | "mimo";
  ttsAutoRead: boolean;
  ttsSpeed: number;
  ttsVolume: number;
  // MiniMax
  ttsMinimaxKey: string;
  ttsMinimaxVoiceId: string;
  /** MiniMax 合成模型：speech-2.8-hd(高保真¥3.5/萬字符) | speech-2.8-turbo(極速¥2.0/萬字符) */
  ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  /** MiniMax 流式播放（邊合成邊播，首字延遲低）；false=完整合成收完再播 */
  ttsStreaming: boolean;
  // GPT-SoVITS（本地）
  ttsGptsovitsBaseUrl: string;
  ttsGptsovitsRefAudioPath: string;
  ttsGptsovitsPromptText: string;
  ttsGptsovitsFormat: "wav" | "mp3";
  // 自定義雲端 TTS
  ttsCustomCloudEndpointUrl: string;
  ttsCustomCloudApiKey: string;
  ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3";
  ttsCustomCloudTimeoutMs: number;
  // 小米 MiMo TTS
  ttsMimoKey: string;
  ttsMimoVoiceAudioPath: string;
  ttsMimoStylePrompt: string;
  /** 天氣源：open-meteo(免配置默認) | amap(高德,需填key) */
  weatherSource: "open-meteo" | "amap";
  /** 天氣插件是否啟用（開關） */
  weatherEnabled: boolean;
  /** 高德天氣 key（https://lbs.amap.com 註冊 Web服務 key） */
  amapKey: string;
  /** 🚗出行工具是否啟用 */
  travelEnabled: boolean;
  /** 🖥️ 瀏覽器自動化（Playwright MCP）是否啟用。默認 false，需用戶手動開啟。 */
  playwrightMcpEnabled: boolean;
  // 聯網搜索：選哪個搜索源 + 對應 key
  searchEngine: "off" | "bocha" | "tavily" | "minimax";
  searchBochaKey: string;
  searchTavilyKey: string;
  searchMinimaxKey: string;
  /** ✉️郵件發送插件是否啟用 */
  emailEnabled: boolean;
  /** SMTP 主機，如 smtp.qq.com */
  emailSmtpHost: string;
  /** SMTP 端口，如 465（SSL）/ 587（STARTTLS） */
  emailSmtpPort: number;
  /** 使用 SSL/TLS（465 通常 true，587 通常 false；用戶可覆蓋） */
  emailSmtpSecure: boolean;
  /** 發件郵箱地址 */
  emailSmtpUser: string;
  /** SMTP 授權碼（非郵箱登錄密碼） */
  emailSmtpPass: string;
  /** 發件人顯示名（可選） */
  emailFromName: string;
  /** 🎧ASR 服務商：off(關閉) | aliyun(阿里雲) | local(Groq Whisper) | web-speech(瀏覽器內建) */
  asrEngine: "off" | "aliyun" | "local" | "web-speech";
  /** 阿里雲智能語音交互 AppKey */
  asrAliyunAppKey: string;
  /** 阿里雲 RAM AccessKey ID */
  asrAliyunAccessKeyId: string;
  /** 阿里雲 RAM AccessKey Secret */
  asrAliyunAccessKeySecret: string;
  /** ASR 識別語言：zh(中文) | en(英文) | auto(自動) */
  asrLanguage: "zh" | "en" | "auto";
  /** VAD 靜默檢測閾值（毫秒），500~2000，默認 1000 */
  asrVadSilenceMs: number;
  /** 通話中顯示文字轉寫 */
  asrShowTranscript: boolean;
  /** 雲端辨識失敗時自動改用本機 Whisper */
  asrFallbackToLocal: boolean;
  /** 按住說話模式，避免環境噪音誤觸 */
  asrPushToTalk: boolean;
  /** Opener 主動開口檔位 */
  openerMode: "off" | "quiet" | "normal" | "lively";
  openerQuietStart: string;
  openerQuietEnd: string;
  openerDailyLimit: number;
  openerRoutineEnabled: boolean;
  openerBreaksEnabled: boolean;
  openerWeatherEnabled: boolean;
  /** 每日陪伴儀式總開關與三個時段。 */
  dailyRitualEnabled: boolean;
  dailyRitualVoice: boolean;
  dailyRitualMorningEnabled: boolean;
  dailyRitualMorningTime: string;
  dailyRitualAfternoonEnabled: boolean;
  dailyRitualAfternoonTime: string;
  dailyRitualEveningEnabled: boolean;
  dailyRitualEveningTime: string;
}


interface PublicModelConfig {
  mode: "auto" | "manual";
  provider: string;
  // 用戶自定義暱稱；留空時狀態欄用 shortName
  displayName?: string;
  // 廠商短名（去括號後綴），狀態欄"正在餵養"的兜底顯示
  shortName: string;
  model: string;
  connected: boolean;
  runtimeSync: "off" | "local" | "llm";
  stickerSize: StickerSize;
  rerankerMode: "light" | "standard" | "none";
}

type RuntimeStatus = "陪伴中" | "思考中" | "工作中" | "聆聽中" | "提醒中" | "離線";
type RuntimeFeeling = "平靜" | "開心" | "溫柔" | "激動" | "撒嬌" | "擔心" | "難過" | "感動" | "害羞";
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

const RUNTIME_STATUSES: RuntimeStatus[] = ["陪伴中", "思考中", "工作中", "聆聽中", "提醒中", "離線"];
const RUNTIME_FEELINGS: RuntimeFeeling[] = ["平靜", "開心", "溫柔", "激動", "撒嬌", "擔心", "難過", "感動", "害羞"];
const CHAT_REQUEST_TIMEOUT_MS = 300000; // FC 總預算：20 輪 × 推理模型 ~10-15s 需 300s 餘量

/** 桌寵窗口的基礎尺寸（zoom=1.0 時）。縮放因子改變窗口與模型尺寸，二者同步。 */
const PET_WINDOW_BASE_WIDTH = 400;
const PET_WINDOW_BASE_HEIGHT = 500;

let lastSlotBounds: { x: number; y: number; width: number; height: number } | null = null;
let isPetDocked = true;
let isPetTextInputActive = false;
let isProgrammaticMoving = false;
let isPetDragging = false;
let pendingPetPosition: { x: number; y: number } | null = null;

function applyPetWindowLevel(settings: GeneralSettings): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isPetDocked || isPetTextInputActive || !settings.petAlwaysOnTop) {
    mainWindow.setAlwaysOnTop(false);
    return;
  }
  mainWindow.setAlwaysOnTop(true, "screen-saver");
}

/**
 * Turn the docked pet into an independent desktop window before a drag moves
 * it.  Relying on BrowserWindow's `move` event is too late on macOS: a child
 * window can remain constrained to its parent and never produce the first
 * useful move event.
 */
function undockPet(restoreSize = true): void {
  if (!mainWindow || mainWindow.isDestroyed() || !isPetDocked) return;

  isPetDocked = false;
  isProgrammaticMoving = false;
  const settings = loadGeneralSettings();
  mainWindow.setParentWindow(null);
  // Resizing a BrowserWindow while a pointer is down cancels pointer capture
  // on macOS. During a drag, keep the docked size until pointerup.
  if (restoreSize) applyPetZoom(settings.petZoom || 1.0);
  applyPetWindowLevel(settings);
  syncPetChatInputVisibility(settings);

  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    try {
      sidebarWindow.webContents.send("workspace:pet-dock-changed", false);
    } catch { /* window may be closing */ }
  }
}

function updatePetDockPosition(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!sidebarWindow || sidebarWindow.isDestroyed() || !sidebarWindow.isVisible()) return;
  if (!lastSlotBounds) return;

  const settings = loadGeneralSettings();
  syncPetChatInputVisibility(settings);

  if (isPetDocked) {
    // 停靠時：縮小比例為 0.45 左右，使桌寵完美契合小型卡片邊框
    applyPetZoom(0.45);
    // 建立父子視窗關係：使桌寵視窗永遠位於工作台視窗之上，但會跟隨工作台一起被其他應用（如 Chrome）遮擋
    if (sidebarWindow && !sidebarWindow.isDestroyed()) {
      mainWindow.setParentWindow(sidebarWindow);
    }
    applyPetWindowLevel(settings);
    // The dock slot is an intentional interaction surface. Per-pixel
    // click-through can race with mousedown here (especially after a window
    // resize), causing the drag gesture never to receive pointerdown.
    mainWindow.setIgnoreMouseEvents(false);
  } else {
    // 未停靠時：恢復用戶在設置頁面保存的常規縮放因子
    applyPetZoom(settings.petZoom || 1.0);
    // 解除父子視窗關係，使桌寵成為獨立的桌面小工具
    mainWindow.setParentWindow(null);
    // 拖出時：恢復常規桌寵的置頂狀態
    applyPetWindowLevel(settings);
    return; // 不繼續跟隨工作台移動
  }

  const sidebarBounds = sidebarWindow.getBounds();
  let petWidth = 0;
  let petHeight = 0;

  if (isPetDocked) {
    petWidth = Math.round(PET_WINDOW_BASE_WIDTH * 0.45);
    petHeight = Math.round(PET_WINDOW_BASE_HEIGHT * 0.45);
  } else {
    const petBounds = mainWindow.getBounds();
    petWidth = petBounds.width;
    petHeight = petBounds.height;
  }
  
  const targetX = sidebarBounds.x + lastSlotBounds.x + (lastSlotBounds.width - petWidth) / 2;
  const targetY = sidebarBounds.y + lastSlotBounds.y + lastSlotBounds.height - petHeight + 16;
  
  isProgrammaticMoving = true;
  mainWindow.setBounds({
    x: Math.round(targetX),
    y: Math.round(targetY),
    width: petWidth,
    height: petHeight
  });
  setTimeout(() => {
    isProgrammaticMoving = false;
  }, 150);
}

/** 任務欄 / 托盤圖標路徑（相對於 dist/main/main/）。所有窗口共用同一個 .ico。 */
const APP_ICON_PATH = path.join(__dirname, "..", "..", "..", "assets", "tray-icon.ico");
let runtimeState: RuntimeState = {
    status: "陪伴中",
    feeling: "平靜",
    expression: 0,
    updatedAt: Date.now(),
  };
let feelingScores = createFeelingScores(runtimeState.feeling);
let stickerEmbeddingIndex: StickerEmbeddingEntry[] | null = null;
let sceneEmbeddingIndex: SceneIndex | null = null;
const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  mode: "auto",
  // 默認廠商改為 MiniMax（v1 vendor adapter 第一個落地的），DeepSeek 已從 v1 清單移除。
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
  petChatInputEnabled: false,
  petZoom: 1,
  sidebarVisible: true,
  tasksVisible: true,
  launchAtLogin: false,
  language: "zh-CN",
  uiTheme: "classic",
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
  ttsMimoStylePrompt: "溫柔、自然、略帶親近感，像在輕聲陪用戶聊天。",
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
  asrShowTranscript: false,
  asrFallbackToLocal: true,
  asrPushToTalk: false,
  openerMode: "off",
  openerQuietStart: "23:00",
  openerQuietEnd: "07:00",
  openerDailyLimit: 4,
  openerRoutineEnabled: true,
  openerBreaksEnabled: true,
  openerWeatherEnabled: true,
  dailyRitualEnabled: false,
  dailyRitualVoice: true,
  dailyRitualMorningEnabled: true,
  dailyRitualMorningTime: "08:00",
  dailyRitualAfternoonEnabled: true,
  dailyRitualAfternoonTime: "15:00",
  dailyRitualEveningEnabled: true,
  dailyRitualEveningTime: "22:30",
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
  const store = await memoryStore.load();
  const l0 = store.l0;
  const l1 = store.l1;
  const l2 = [...store.l2];
  const evidenceByMemory = new Map<string, MemoryEvidence[]>();
  for (const evidence of store.evidence ?? []) {
    const group = evidenceByMemory.get(evidence.memoryId) ?? [];
    group.push(evidence);
    evidenceByMemory.set(evidence.memoryId, group);
  }

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
        const fileName = entry.metadata?.fileName || "未命名文檔";
        const importId = entry.metadata?.importId as string | undefined;
        // 新數據按 importId 分組，舊數據按 fileName 分組
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
    l2: l2
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(memory => ({
        id: memory.id,
        content: memory.content,
        triggerText: memory.triggerText,
        status: memory.status,
        weight: memory.weight,
        createdAt: memory.createdAt,
        lastAccessedAt: memory.lastAccessedAt,
        accessCount: memory.accessCount,
        isPinned: memory.isPinned,
        sourceConversationId: memory.sourceConversationId,
        isSummary: Boolean(memory.isSummary),
        conflictCount: memory.conflictWith?.length ?? 0,
        supersededBy: memory.supersededBy,
        mergedInto: memory.mergedInto,
        evidence: (evidenceByMemory.get(memory.id) ?? []).map(evidence => ({
          id: evidence.id,
          quoteSnippet: evidence.quoteSnippet,
          contextBeforeSnippet: evidence.contextBeforeSnippet,
          contextAfterSnippet: evidence.contextAfterSnippet,
          conversationId: evidence.conversationId,
          createdAt: evidence.createdAt,
          sourceStatus: evidence.sourceStatus,
        })),
      })),
    graph: buildMemoryGraphView(entityGraph.snapshot(), l2, l0.preferredName || l0.nickname || "你"),
    importedDocs,
    reflections: (store.reflectionLogs ?? [])
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(log => ({
        id: log.id,
        title: log.type === "compression" ? "記憶整理" : log.type === "l0_update" ? "長期畫像更新" : "近期狀態更新",
        body: log.summary,
        meta: `${formatMemoryPanelDate(log.createdAt)}${log.details ? ` · ${log.details}` : ""}`,
      })) as MemoryPanelItem[],
  };
}

function formatMemoryPanelDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" });
}

function getStickerSettingsPath(): string {
  return path.join(app.getPath("userData"), "sticker-settings.json");
}

/**
 * normalize 流程：
 *   1. 先清洗頂層基礎字段（mode/provider/runtimeSync/...）
 *   2. 再清洗 perProvider 字典：忽略非法鍵、缺失字段補默認值、apiKey 不在這裡強制 trim 留作下一步
 *   3. 舊 schema 兼容：若 perProvider 中沒有 currentProvider 那一份，把頂層 baseUrl/model/apiKey 當作首次遷移塞進去
 *   4. 用 perProvider[currentProvider] 反向展開成頂層 baseUrl/model/apiKey 鏡像
 *      → 真值（source of truth）是 perProvider；頂層只是當前廠商配置的視圖
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
  };
}

/** 清洗視覺模型配置。syncWithMain=true 時三字段不保留（運行時從主配置讀）。 */
function normalizeVisionConfig(input: Partial<VisionModelConfig> | undefined): VisionModelConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const syncWithMain = input.syncWithMain === true;
  if (syncWithMain) {
    // syncWithMain=true：強制忽略三字段（即便手動編輯配置文件寫了也忽略），運行時從主配置讀
    return { syncWithMain: true, baseUrl: "", apiKey: "", model: "" };
  }
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  // 三項全空 = 未啟用
  if (!baseUrl && !apiKey && !model) return undefined;
  return { syncWithMain: false, baseUrl, apiKey, model };
}

function normalizeModelSettings(input: Partial<ModelSettings> | null | undefined): ModelSettings {
  const mode: "auto" | "manual" = input?.mode === "manual" ? "manual" : "auto";
  let provider = typeof input?.provider === "string" && input.provider.trim()
    ? input.provider.trim()
    : DEFAULT_MODEL_SETTINGS.provider;

  // perProvider 清洗：跳過非對象、非法鍵
  const rawPerProvider = (input as ModelSettings | undefined)?.perProvider;
  let perProvider: Record<string, ProviderProfile> = {};
  if (rawPerProvider && typeof rawPerProvider === "object") {
    for (const [key, value] of Object.entries(rawPerProvider)) {
      if (typeof key !== "string" || !key.trim()) continue;
      perProvider[key.trim()] = normalizeProviderProfile(value as Partial<ProviderProfile>);
    }
  }

  // 廠商重命名遷移：把舊 provider 名在字典裡和當前 provider 字段一併改成新名。
  // 必須在"舊 schema 兼容回填"之前做，否則會用舊名先創建一份殭屍數據。
  ({ provider, perProvider } = migrateProviderRenames(provider, perProvider));

  // 舊 schema 兼容：v1 之前的 model-config.json 沒有 perProvider 字段，
  // 但有頂層 baseUrl/model/apiKey 三件套。首次升級時把它們當作 currentProvider 那一份回填。
  if (!perProvider[provider]) {
    perProvider[provider] = normalizeProviderProfile({
      baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl : "",
      model: typeof input?.model === "string" ? input.model : "",
      apiKey: typeof input?.apiKey === "string" ? input.apiKey : "",
    });
    // 如果遷移後這一份完全是空的（用戶從來沒配過），再給個默認 baseUrl/model（便於 UI 第一次顯示）
    if (!perProvider[provider].baseUrl) perProvider[provider].baseUrl = DEFAULT_MODEL_SETTINGS.baseUrl;
    if (!perProvider[provider].model) perProvider[provider].model = DEFAULT_MODEL_SETTINGS.model;
  }

  // 頂層鏡像：用 perProvider[provider] 展開
  const profile = perProvider[provider];

  return {
    mode,
    provider,
    displayName: profile.displayName,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: profile.apiKey,
    explicitTransport: profile.explicitTransport,
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
    return normalizeModelSettings(revealSecrets(JSON.parse(raw)) as Partial<ModelSettings>);
  } catch (err) {
    console.error("[Cyrene] load settings failed:", err);
    return DEFAULT_MODEL_SETTINGS;
  }
}

/**
 * 加載視覺模型配置，解析 syncWithMain 並做 supportsVision 檢查。
 * 返回 null = 未啟用視覺（read_image 據此誠實拒絕）。
 *
 * syncWithMain=true 時：從主配置讀 baseUrl/key/model，並檢查主模型 supportsVision——
 * 若主模型非視覺，返回 null（避免把非視覺模型當視覺模型硬調導致運行時錯誤讓用戶困惑）。
 */
export function loadVisionConfig(): VisionConfig | null {
  const settings = loadModelSettings();
  const v = settings.vision;
  if (!v) return null;

  if (v.syncWithMain) {
    // 從主配置讀
    const cap = getCapability(settings.provider);
    if (!cap?.supportsVision) {
      console.warn("[Vision] syncWithMain=true 但主模型不支持視覺，視為未啟用");
      return null;
    }
    if (!settings.apiKey || !settings.model) return null;
    // 視覺 baseUrl：優先用 visionBaseUrl（主配走 Anthropic 入口時視覺需走 OpenAI 入口），
    // 沒標就用主配置 baseUrl。這樣用戶勾"同步"就能用，不用手動改 URL。
    const visionBaseUrl = cap.visionBaseUrl || settings.baseUrl;
    return { baseUrl: visionBaseUrl, apiKey: settings.apiKey, model: settings.model };
  }

  // 獨立配置
  if (!v.baseUrl || !v.apiKey || !v.model) return null;
  return { baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model };
}

/**
 * 保存邏輯：
 *   - 渲染端發來的 settings 既可能帶頂層 baseUrl/model/apiKey（舊調用方式），
 *     也可能帶 perProvider（新調用方式，未來可擴展）。
 *   - 寫盤前先把"頂層那三件套"摺疊回 perProvider[provider]，保證真值落到字典裡。
 *   - normalizeModelSettings 再把 perProvider[provider] 展開成頂層鏡像，寫盤 = 雙視圖一致。
 */
function saveModelSettings(settings: Partial<ModelSettings>): ModelSettings {
  const existing = loadModelSettings();
  const merged: Partial<ModelSettings> = { ...existing, ...settings };

  // currentProvider 優先取傳入的、再取已有的
  const currentProvider = (typeof settings.provider === "string" && settings.provider.trim())
    ? settings.provider.trim()
    : existing.provider;

  // 起點：複製現有 perProvider，再 merge 傳入的 perProvider
  const perProvider: Record<string, ProviderProfile> = { ...(existing.perProvider ?? {}) };
  if (settings.perProvider && typeof settings.perProvider === "object") {
    for (const [key, value] of Object.entries(settings.perProvider)) {
      perProvider[key] = normalizeProviderProfile(value as Partial<ProviderProfile>);
    }
  }

  // 把傳入的頂層三件套摺疊到 currentProvider 下（這是渲染端目前主要的寫入路徑）
  const incomingProfile = perProvider[currentProvider] ?? normalizeProviderProfile(null);
  // explicitTransport：渲染端新下拉框字段。傳 "openai" | "anthropic" | "auto" 都接受；傳 undefined 視為 "auto"。
  const incomingExplicitTransport: ProviderProfile["explicitTransport"] =
    settings.explicitTransport === "openai" || settings.explicitTransport === "anthropic" || settings.explicitTransport === "auto"
      ? settings.explicitTransport
      : incomingProfile.explicitTransport;
  perProvider[currentProvider] = {
    baseUrl: typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : incomingProfile.baseUrl,
    model: typeof settings.model === "string" ? settings.model.trim() : incomingProfile.model,
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey.trim() : incomingProfile.apiKey,
    displayName: typeof settings.displayName === "string" && settings.displayName.trim()
      ? settings.displayName.trim()
      : incomingProfile.displayName,
    explicitTransport: incomingExplicitTransport,
  };

  merged.provider = currentProvider;
  merged.perProvider = perProvider;

  const final = normalizeModelSettings(merged);
  const filePath = getSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(protectSecrets(final), null, 2), { encoding: "utf8", mode: 0o600 });
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
  const normalizeTime = (value: unknown, fallback: string) => {
    const text = typeof value === "string" ? value.trim() : "";
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
  };
  return {
    musicEnabled: Boolean(input?.musicEnabled),
    musicVolume: clamp(input?.musicVolume, DEFAULT_GENERAL_SETTINGS.musicVolume),
    soundEnabled: input?.soundEnabled === undefined ? DEFAULT_GENERAL_SETTINGS.soundEnabled : Boolean(input.soundEnabled),
    soundVolume: clamp(input?.soundVolume, DEFAULT_GENERAL_SETTINGS.soundVolume),
    petAlwaysOnTop: input?.petAlwaysOnTop === undefined ? DEFAULT_GENERAL_SETTINGS.petAlwaysOnTop : Boolean(input.petAlwaysOnTop),
    petVisible: input?.petVisible === undefined ? DEFAULT_GENERAL_SETTINGS.petVisible : Boolean(input.petVisible),
    petChatInputEnabled: input?.petChatInputEnabled === undefined
      ? DEFAULT_GENERAL_SETTINGS.petChatInputEnabled
      : Boolean(input.petChatInputEnabled),
    petZoom: typeof input?.petZoom === "number" ? Math.max(0.5, Math.min(2, input.petZoom)) : DEFAULT_GENERAL_SETTINGS.petZoom,
    petWindowX: typeof input?.petWindowX === "number" && isFinite(input.petWindowX)
      ? Math.round(input.petWindowX) : undefined,
    petWindowY: typeof input?.petWindowY === "number" && isFinite(input.petWindowY)
      ? Math.round(input.petWindowY) : undefined,
    sidebarVisible: windowVisibility.sidebarVisible,
    tasksVisible: windowVisibility.tasksVisible,
    launchAtLogin: Boolean(input?.launchAtLogin),
    language: "zh-CN",
    uiTheme: input?.uiTheme === "pearl-white" ? "pearl-white" : input?.uiTheme === "polished-pink" ? "polished-pink" : "classic",
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
    // 郵件（SMTP）配置
    emailEnabled: Boolean(input?.emailEnabled),
    emailSmtpHost: typeof input?.emailSmtpHost === "string" ? input.emailSmtpHost : "",
    emailSmtpPort: clampPort(input?.emailSmtpPort, DEFAULT_GENERAL_SETTINGS.emailSmtpPort),
    emailSmtpSecure: input?.emailSmtpSecure === undefined
      ? (clampPort(input?.emailSmtpPort, DEFAULT_GENERAL_SETTINGS.emailSmtpPort) === 465)
      : Boolean(input.emailSmtpSecure),
    emailSmtpUser: typeof input?.emailSmtpUser === "string" ? input.emailSmtpUser : "",
    emailSmtpPass: typeof input?.emailSmtpPass === "string" ? input.emailSmtpPass : "",
    emailFromName: typeof input?.emailFromName === "string" ? input.emailFromName : "",
    // ASR（語音識別）配置
    asrEngine: ["off", "aliyun", "local", "web-speech"].includes(String(input?.asrEngine))
      ? (input!.asrEngine as "off" | "aliyun" | "local" | "web-speech")
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
    asrShowTranscript: Boolean(input?.asrShowTranscript),
    asrFallbackToLocal: input?.asrFallbackToLocal === undefined ? true : Boolean(input.asrFallbackToLocal),
    asrPushToTalk: Boolean(input?.asrPushToTalk),
    openerMode: ["off", "quiet", "normal", "lively"].includes(String(input?.openerMode))
      ? (input!.openerMode as "off" | "quiet" | "normal" | "lively")
      : "off",
    openerQuietStart: normalizeTime(input?.openerQuietStart, DEFAULT_GENERAL_SETTINGS.openerQuietStart),
    openerQuietEnd: normalizeTime(input?.openerQuietEnd, DEFAULT_GENERAL_SETTINGS.openerQuietEnd),
    openerDailyLimit: typeof input?.openerDailyLimit === "number"
      ? Math.max(1, Math.min(12, Math.round(input.openerDailyLimit)))
      : DEFAULT_GENERAL_SETTINGS.openerDailyLimit,
    openerRoutineEnabled: input?.openerRoutineEnabled === undefined ? true : Boolean(input.openerRoutineEnabled),
    openerBreaksEnabled: input?.openerBreaksEnabled === undefined ? true : Boolean(input.openerBreaksEnabled),
    openerWeatherEnabled: input?.openerWeatherEnabled === undefined ? true : Boolean(input.openerWeatherEnabled),
    dailyRitualEnabled: Boolean(input?.dailyRitualEnabled),
    dailyRitualVoice: input?.dailyRitualVoice === undefined ? true : Boolean(input.dailyRitualVoice),
    dailyRitualMorningEnabled: input?.dailyRitualMorningEnabled === undefined ? true : Boolean(input.dailyRitualMorningEnabled),
    dailyRitualMorningTime: normalizeTime(input?.dailyRitualMorningTime, DEFAULT_GENERAL_SETTINGS.dailyRitualMorningTime),
    dailyRitualAfternoonEnabled: input?.dailyRitualAfternoonEnabled === undefined ? true : Boolean(input.dailyRitualAfternoonEnabled),
    dailyRitualAfternoonTime: normalizeTime(input?.dailyRitualAfternoonTime, DEFAULT_GENERAL_SETTINGS.dailyRitualAfternoonTime),
    dailyRitualEveningEnabled: input?.dailyRitualEveningEnabled === undefined ? true : Boolean(input.dailyRitualEveningEnabled),
    dailyRitualEveningTime: normalizeTime(input?.dailyRitualEveningTime, DEFAULT_GENERAL_SETTINGS.dailyRitualEveningTime),
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
    return normalizeGeneralSettings(revealSecrets(JSON.parse(fs.readFileSync(filePath, "utf8"))) as Partial<GeneralSettings>);
  } catch (err) {
    console.error("[Cyrene] load general settings failed:", err);
    return DEFAULT_GENERAL_SETTINGS;
  }
}

function applyGeneralSettings(settings: GeneralSettings): void {
  applyPetWindowLevel(settings);
  if (settings.petVisible) mainWindow?.show();
  else mainWindow?.hide();
  // 未簽名的開發版 Electron 在 macOS 呼叫此 API 會固定被系統拒絕並輸出
  // platform_util_mac 錯誤；正式封裝版才有可註冊的登入項目。
  if (!isDev) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  applyPetZoom(isPetDocked ? 0.45 : settings.petZoom);
  syncPetChatInputVisibility(settings);
}

function syncPetChatInputVisibility(settings = loadGeneralSettings()): void {
  sendToLive2DWindow(IPC.PET_CHAT_INPUT_VISIBILITY, settings.petChatInputEnabled && !isPetDocked);
}

/**
 * 按縮放因子調整桌寵窗口尺寸，並通知渲染進程重算模型 scale。
 * 窗口與模型同步等比縮放，比例不變，故模型始終塞滿窗口、不被裁剪。
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
  fs.writeFileSync(filePath, JSON.stringify(protectSecrets(normalized), null, 2), { encoding: "utf8", mode: 0o600 });
  applyGeneralSettings(normalized);
  syncBuiltInToolToggles(normalized);
  if (before.uiTheme !== normalized.uiTheme) {
    broadcastUiThemeChanged(normalized.uiTheme);
  }
  return normalized;
}

function syncBuiltInToolToggles(settings: GeneralSettings): void {
  toolRegistry.setEnabled("weather", settings.weatherEnabled);
  toolRegistry.setEnabled("plan_trip", settings.travelEnabled);
}

async function synthesizeDailyRitual(text: string, settings: GeneralSettings): Promise<{ base64: string; format: "wav" | "mp3" } | null> {
  if (!settings.dailyRitualVoice || settings.ttsEngine === "off") return null;
  try {
    const result = await synthesizeByEngine(settings.ttsEngine, {
      text: text.slice(0, 500),
      speed: settings.ttsSpeed,
      volume: settings.ttsVolume,
      apiKey: settings.ttsEngine === "mimo"
        ? settings.ttsMimoKey
        : settings.ttsEngine === "custom-cloud"
          ? settings.ttsCustomCloudApiKey
          : settings.ttsMinimaxKey,
      voiceId: settings.ttsEngine === "custom-cloud" ? settings.ttsCustomCloudVoiceId : settings.ttsMinimaxVoiceId,
      model: settings.ttsMinimaxModel,
      baseUrl: settings.ttsGptsovitsBaseUrl,
      refAudioPath: settings.ttsGptsovitsRefAudioPath,
      promptText: settings.ttsGptsovitsPromptText,
      endpointUrl: settings.ttsCustomCloudEndpointUrl,
      timeoutMs: settings.ttsCustomCloudTimeoutMs,
      voiceAudioPath: settings.ttsMimoVoiceAudioPath,
      stylePrompt: settings.ttsMimoStylePrompt,
      format: settings.ttsEngine === "gptsovits" ? settings.ttsGptsovitsFormat : settings.ttsEngine === "custom-cloud" ? settings.ttsCustomCloudFormat : "mp3",
    });
    return { base64: result.audio.toString("base64"), format: result.format };
  } catch (err) {
    console.warn("[DailyRitual] TTS 合成失敗，改用文字氣泡:", err instanceof Error ? err.message : err);
    return null;
  }
}

function toOpenerRuntimeConfig(settings: GeneralSettings): OpenerRuntimeConfig {
  let city = "";
  try { city = loadUserProfile().defaultCity || ""; } catch { /* profile 尚未初始化 */ }
  return {
    mode: settings.openerMode === "off" ? "normal" : settings.openerMode,
    quietStart: settings.openerQuietStart,
    quietEnd: settings.openerQuietEnd,
    dailyLimit: settings.openerDailyLimit,
    routineEnabled: settings.openerRoutineEnabled,
    breaksEnabled: settings.openerBreaksEnabled,
    weatherEnabled: settings.openerWeatherEnabled,
    city,
  };
}

/** MiniMax 搜索 MCP Server 的固定 ID。 */
const MINIMAX_SEARCH_MCP_ID = "minimax-web-search";

/**
 * 同步搜索 MCP Server：選 MiniMax+有key→註冊連接，否則→移除斷開。
 * 在 TTS_SAVE_SETTINGS 檢測到搜索配置變化時調用。
 */
async function syncVolcanoSearchMcp(settings: GeneralSettings): Promise<void> {
  // ── MiniMax（PyPI包，不依賴GitHub，推薦）──
  const minimaxEnable = settings.searchEngine === "minimax" && settings.searchMinimaxKey.trim().length > 0;
  const minimaxExists = listMcpServers().some(s => s.id === MINIMAX_SEARCH_MCP_ID);

  if (minimaxEnable && !minimaxExists) {
    console.log("[Cyrene] 註冊 MiniMax 搜索 MCP Server...");
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
        console.log("[Cyrene] MiniMax 搜索 MCP 註冊成功，工具:", result.toolIds?.join(", "));
      } else {
        console.error("[Cyrene] MiniMax 搜索 MCP 註冊失敗:", result.error);
      }
    } catch (err) {
      console.error("[Cyrene] MiniMax 搜索 MCP 註冊異常:", err);
    }
  } else if (!minimaxEnable && minimaxExists) {
    console.log("[Cyrene] 移除 MiniMax 搜索 MCP Server...");
    try { await removeMcpServer(MINIMAX_SEARCH_MCP_ID); } catch (err) { console.error("[Cyrene] MiniMax 搜索 MCP 移除異常:", err); }
  } else if (minimaxEnable && minimaxExists) {
    console.log("[Cyrene] MiniMax 搜索 key 變化，重新註冊 MCP Server...");
    try {
      await removeMcpServer(MINIMAX_SEARCH_MCP_ID);
      await addMcpServer({
        id: MINIMAX_SEARCH_MCP_ID, name: "MiniMax搜索", transport: "stdio",
        command: "uvx",
        args: ["minimax-coding-plan-mcp", "-y"],
        env: { MINIMAX_API_KEY: settings.searchMinimaxKey.trim(), MINIMAX_API_HOST: "https://api.minimaxi.com" },
      });
    } catch (err) { console.error("[Cyrene] MiniMax 搜索 MCP 重新註冊異常:", err); }
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

  // 把所有 id 歸一化為 boolean（默認 true）
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

// ── 多面板自適應佈局 ──────────────────────────────────────────────

interface PanelLayout { x: number; y: number; }

/**
 * 將窗口位置 clamp 到 workArea 內，保證至少 minVisibleW × minVisibleH 可見。
 * 允許窗口部分超出屏幕（可正可負），但可見區域不少於指定閾值。
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
 * 計算多面板自適應佈局。
 *
 * 策略：
 * - 水平排列：totalWidth <= workArea.width → 三面板水平居中
 * - 階梯排列：totalWidth > workArea.width → sidebar/tasks 貼右邊緣並垂直錯開
 *
 * 所有窗口均 clampWindowToWorkArea 保證至少 120×80 可見。
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

  // 階梯排列：總寬超屏
  // chat: 居中（clamp 後）
  const chatPos = clampWindowToWorkArea(
    { x: workArea.x + Math.floor((workArea.width - panels[0].width) / 2), y: baseY },
    panels[0],
    workArea,
  );

  // sidebar: 優先 chat 右側有 gap；不夠則貼 workArea 右邊緣
  const sidebarMaxX = workArea.x + workArea.width - panels[1].width;
  const sidebarX = Math.min(chatPos.x + panels[0].width + gap, sidebarMaxX);
  const sidebarPos = clampWindowToWorkArea({ x: sidebarX, y: baseY }, panels[1], workArea);

  // tasks: 貼右邊緣，y 與 sidebar 錯開 48px
  const tasksX = Math.min(sidebarPos.x, sidebarMaxX);
  const tasksY = clampWindowToWorkArea(
    { x: tasksX, y: sidebarPos.y + 48 },
    panels[2],
    workArea,
  );

  return [chatPos, sidebarPos, tasksY];
}

// 計算 chat / sidebar / tasks 三個窗口的初始位置。
// 規則：優先鼠標所在 display；窗口自適應 workArea，保證至少 120×80 可見。
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
  "平靜": 0,
  "開心": 6,
  "溫柔": 0,
  "激動": 3,
  "撒嬌": 5,
  "擔心": 2,
  "難過": 0,
  "感動": 4,
  "害羞": 5,
};

function inferRuntimeState(
  userInput: string,
  llmReply: string,
  toolCalled: boolean
): Pick<RuntimeState, "status"> {
  if (toolCalled) return { status: "工作中" };

  const text = userInput + llmReply;

  if (STATUS_KEYWORDS["聆聽中"].test(text)) {
    return { status: "聆聽中" };
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
  const validFeelings = ["平靜","開心","溫柔","激動","撒嬌","擔心","難過","感動","害羞"];
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
      
      // Filter out connection failure system logs from history context
      if (record.content.includes("連接模型失敗：模型請求失敗")) return null;
      
      const role = record.role === "user" || record.role === "system" ? record.role : "assistant";
      let content = stripThinkBlocks(record.content).trim();
      
      // Truncate massive messages (like long game code generated earlier) to save tokens
      if (content.length > 800) {
        if (content.includes("<!DOCTYPE html>") || content.includes("<html") || content.includes("style>")) {
          content = "[此處已為您省略昔漣編寫的網頁/遊戲代碼以節省 Token 空間，棋盤小遊戲運行正常]";
        } else {
          content = content.slice(0, 800) + "... (此處長對話已省略)";
        }
      }
      
      return { role, content };
    })
    .filter((item): item is { role: "system" | "user" | "assistant"; content: string } => item !== null)
    .slice(-12);
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

  // 拼 VendorConfig（settings 頂層三件套 + 鏡像字段都參與）
  const cfg: VendorConfig = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
  };

  try {
    // adapter 三層 transport 解析（explicitTransport → baseUrl 啟發式 → capabilities fallback）
    const adapter = getAdapterForConfig(cfg);
    // adapter 的 buildStreamRequest 內部已寫 stream=true + 拼 transport 相關的 headers/body
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
      throw new Error(errMsg || `模型請求失敗：HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("響應體為空，不支持流式讀取");
    }

    let fullText = "";
    const visibleFilter = createVisibleStreamFilter();

    // Reader 層切分字節流 → StreamEvent；adapter 解析為 StreamChunk
    // 半行拼接、event 塊切分等狀態由 createSseReader 內部維護，adapter 保持純函數無狀態。
    for await (const event of createSseReader(adapter, response.body)) {
      const chunk = adapter.parseStreamEvent(event);
      if (!chunk) continue;
      if (chunk.deltaText) {
        fullText += chunk.deltaText;
        const visibleDelta = visibleFilter.push(chunk.deltaText);
        if (visibleDelta) onChunk(visibleDelta);
      }
      // thinking 累積但不入可見流（stripThinkBlocks 末尾統一剝）
      if (chunk.usage) {
        recordUsage(chunk.usage.input, chunk.usage.output, 1, settings.model);
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
      throw new Error("模型請求超時，請稍後重試。");
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
 * 診斷：確認 WorldBook active entries 是否真正進入最終 system prompt，
 * 以及在什麼位置。不預設結論——先看數據再判斷是 lost-in-middle、
 * 被後續 prompt 覆蓋、還是根本沒拼進去。
 */
function logWorldbookInjection(alwaysOnContext: string, systemContent: string): void {
  const marker = "【已激活的世界知識】";
  if (alwaysOnContext && alwaysOnContext.includes(marker)) {
    const wbStart = systemContent.indexOf(marker);
    console.log("[Worldbook/Diag] ────────────────────────");
    console.log(`[Worldbook/Diag] systemContent total length: ${systemContent.length}`);
    console.log(`[Worldbook/Diag] alwaysOnContext length: ${alwaysOnContext.length}`);
    console.log(`[Worldbook/Diag] ${marker} 在 systemContent 中的偏移: ${wbStart} / ${systemContent.length} (${((wbStart / systemContent.length) * 100).toFixed(1)}%)`);
    console.log(`[Worldbook/Diag] ${marker} 之後剩餘內容: ${systemContent.length - wbStart} 字符`);
    const beforeWb = systemContent.slice(Math.max(0, wbStart - 200), wbStart);
    const wbSlice = systemContent.slice(wbStart, Math.min(wbStart + alwaysOnContext.length + 200, systemContent.length));
    console.log(`[Worldbook/Diag] ── 注入前 200 字 ──\n${beforeWb.slice(-200)}`);
    console.log(`[Worldbook/Diag] ── 注入內容 + 後 200 字 ──\n${wbSlice.slice(0, 800)}`);
    console.log("[Worldbook/Diag] ────────────────────────");
  } else {
    console.log("[Worldbook/Diag] 本輪無世界知識注入（alwaysOnContext 為空或不含標記）");
  }
}

function buildSystemPrompt(styleFile: string): string {
  const parts: string[] = [];

  // styleFile 以 "talk" 開頭時走純聊天模式，以 "study" 開頭時走學習模式，以 "game" 開頭時走遊戲模式
  const isTalkMode = styleFile.startsWith("talk");
  const isStudyMode = styleFile.startsWith("study");
  const isGameMode = styleFile.startsWith("game");
  const system = loadPromptFile(
    isTalkMode
      ? "talk_system.md"
      : isStudyMode
        ? "study_system.md"
        : isGameMode
          ? "game_system.md"
          : "system.md"
  );
  if (system) parts.push(system);
  
  const identity = loadPromptFile("identity.md");
  if (identity) parts.push(identity);
  
  const soul = loadPromptFile("soul.md");
  if (soul) parts.push(soul);
  
  const canon = loadPromptFile("canon_quotes.md");
  if (canon) parts.push(canon);
  
  // 純聊天模式與遊戲模式不加載額外的 styles/ 文件
  if (!isTalkMode && !isGameMode) {
    const style = loadPromptFile("styles/" + styleFile);
    if (style) parts.push(style);
  }
  
  return parts.join("\n\n---\n\n");
}

/**
 * /命令攔截：命中 /skill-id（且 skill 存在+啟用）則返回 system 激活段
 * （正文注入 system，user message 原樣，不汙染 memory，見 spec 6.3）。
 * 命中但 skill 不存在/未啟用 → 改寫該 user 消息為提示，返回 ""。
 * 未命中 → 返回 ""（放行，不誤吞其他 /命令）。
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
  // skill 不存在/未啟用：替換該 user 消息為提示
  const available = skillRegistry.getEnabled().map(s => s.id).join(", ") || "(無)";
  messages[lastUserIdx] = { ...lastUser, content: `[系統提示：skill 未啟用或不存在: ${parsed.skillId}。可用 skill: ${available}]` } as T;
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

  // 入 LLM 後臺隊列：和 MemoryJudge 串行執行，避免併發觸發限流；
  // 限流自動退避 5s 重試 1 次。.catch 吞錯誤，不影響主流程。
  enqueueLLMTask("心情觀察器", async () => {
    const _obsStart = Date.now();
    console.log(`[TIMING] 心情觀察器 SENDING request`);
    const observerContent = await callChatCompletions(settings, [
      {
        role: "system",
        content:
          '你是一個情緒分析器。以下是昔漣的完整人格設定：\n\n' + loadSoulFeelingContext() + '\n\n根據以上人格設定和以下對話，判斷昔漣當前的心情狀態。可選心情值（只能選其中一個）：平靜 / 開心 / 溫柔 / 激動 / 撒嬌 / 擔心 / 難過 / 感動 / 害羞。只返回 JSON，不要任何多餘文字：{"feeling": "心情值"}。判斷規則：以最後一輪對話為主，之前幾輪為輔；判斷的是昔漣的心情，不是用戶的心情；無法判斷時返回 平靜。',
      },
      {
        role: "user",
        content: JSON.stringify({
          recentDialogue,
        }),
      },
    ], undefined, 30000, "心情觀察器");
    console.log(`[TIMING] 心情觀察器 OK in ${Date.now() - _obsStart}ms raw=${observerContent?.slice(0, 100)}`);
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
  // 標註未使用的參數，避免 lint 警告
  void latestUserText;
}

function isEnglishText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  
  const cleanText = trimmed
    .replace(/<@!?\d+>/g, "")
    .replace(/[0-9\s\p{P}\p{S}]/gu, "");
  if (!cleanText) return false;

  const englishChars = (cleanText.match(/[a-zA-Z]/g) || []).length;
  const chineseChars = (cleanText.match(/[\u4e00-\u9fa5]/g) || []).length;

  return englishChars > 0 && englishChars > chineseChars * 2;
}

async function requestModelReply(inputMessages: unknown, styleFile = "01_default.md"): Promise<ChatReplyPayload> {
  const settings = loadModelSettings();
  if (!settings.apiKey) {
    throw new Error("還沒有填寫 API Key，請先在設置裡保存 API 配置。");
  }

  const messages = normalizeChatMessages(inputMessages);
  if (messages.length === 0) {
    throw new Error("沒有可發送的聊天內容。");
  }
  let latestUserText = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";

  // 根據語意動態切換模式：如果用戶稱呼「昔漣老師」切至學習模式；若稱呼「昔漣」且無「昔漣老師」切回一般模式
  let activeStyle = styleFile;
  const isGameQuery = ["攻略", "遊戲", "打法", "配隊"].some(k => latestUserText.includes(k));
  if (latestUserText.includes("昔漣老師")) {
    activeStyle = "study";
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send("chat:update-mode", "study"); } catch { /* ignore */ }
    }
  } else if (latestUserText.includes("昔漣")) {
    activeStyle = "01_default.md";
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send("chat:update-mode", "collab"); } catch { /* ignore */ }
    }
  } else if (isGameQuery) {
    activeStyle = "game";
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send("chat:update-mode", "game"); } catch { /* ignore */ }
    }
  } else if (isEnglishText(latestUserText)) {
    activeStyle = "study";
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send("chat:update-mode", "study"); } catch { /* ignore */ }
    }
  }
  styleFile = activeStyle;

  // 1. 構建 always-on 上下文（世界書 + L0/L1 畫像）
  let alwaysOnContext = "";
  try {
    alwaysOnContext = await buildAlwaysOnContext(latestUserText, messages);
  } catch (err) {
    console.warn("[Cyrene] always-on context build failed:", err);
  }

  // 1.05 遊戲模式專用：自動提前進行聯網小紅書搜尋並注入事實上下文，防止模型工具調用失敗
  if (styleFile === "game" || isGameQuery) {
    try {
      const webSearchTool = toolRegistry.getById("web_search");
      if (webSearchTool) {
        console.log(`[Cyrene] Game mode proactive search for: "${latestUserText}"`);
        const searchResult = await webSearchTool.execute({ query: latestUserText + " site:xiaohongshu.com" });
        if (searchResult) {
          alwaysOnContext += `\n\n【聯網小紅書即時搜尋參考資料】\n${searchResult}\n`;
        }
      }
    } catch (err) {
      console.warn("[Cyrene] Proactive game search failed:", err);
    }
  }

  // 1.1 自動注入相關記憶（L2 + 導入文檔），讓模型無需調 tool 也能感知
  let memoryInjection = "";
  try {
    memoryInjection = await buildMemoryInjection(latestUserText);
  } catch (err) {
    console.warn("[Cyrene] memory injection failed:", err);
  }

  // 1.5 環境上下文（Step 1）：當前日期 / OS / 桌面真實路徑 / 權限檔位 / 工具可用情況 / 模型視覺能力
  // 放在 always-on 之後、system prompt 末尾，讓模型最近讀到的就是機器事實，
  // 降低"桌面在哪"這類低級幻覺。失敗不影響主流程。
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

  // system prompt 拼裝順序：事實層在前，人格層在後，skill 清單 + /命令激活放最後。
  // /命令攔截：命中 /skill-id 則當輪 system 注入 skill 正文（user message 原樣，不汙染 memory）
  const skillCatalog = buildSkillCatalog(skillRegistry.getEnabled());
  const skillActivation = resolveSlashActivation(messages);
  // 語氣硬注入：embedding 匹配場景，強制注入語氣規則 + 場景參考樣本（必須遵守，優先級最高）
  let toneInjection = "";
  const sceneProvider = getSceneEmbeddingProvider();
  if (sceneProvider && sceneEmbeddingIndex) {
    try {
      toneInjection = await buildToneInjection(latestUserText, messages, sceneProvider, sceneEmbeddingIndex);
    } catch (err) {
      console.error("[Cyrene] tone injection failed:", err);
    }
  }
  // 注入順序：環境 → 人格設定 → skill → 記憶 → ★已激活世界知識（放最後、最靠近 user message）
  // 世界知識放最後：LLM 對靠近 user 的信息權重更高；且避免被 system.md 的"不知道不要編"規則覆蓋
  const systemContent =
    (environmentContext ? environmentContext + "\n\n" : "") +
    buildSystemPrompt(styleFile) +
    (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
    skillActivation +
    (memoryInjection ? memoryInjection + "\n\n" : "") +
    (alwaysOnContext ? alwaysOnContext + "\n\n" : "") +
    toneInjection;

  // ── 診斷：WorldBook 注入驗證 ──
  logWorldbookInjection(alwaysOnContext, systemContent);

  // 2. Function Calling 循環：模型自己決定調不調工具、調哪個
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

    // 工具執行日誌
    if (fcResult.toolResults.length > 0) {
      console.log("[Cyrene] Function Calling 使用了 " + fcResult.toolResults.length + " 個工具:",
        fcResult.toolResults.map(tr => tr.toolId).join(", "));
    }
  } catch (err) {
    console.error("[Cyrene] Function Calling 失敗，降級為普通對話", err);
    // 降級：不帶 tools 的普通 LLM 調用
    chatContent = await callChatCompletions(
      settings,
      fcMessages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
      undefined,
      CHAT_REQUEST_TIMEOUT_MS,
      "主聊天（降級）",
    );
  }

  if (chatContent) {
    chatContent = toTraditionalTaiwan(chatContent);
  }

  if (!chatContent) {
    throw new Error("模型沒有返回有效回覆。");
  }

  // 發送流式事件（非流式模式下一次性發送）
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
      const matchResult = await matchSticker(chatContent + "\n" + latestUserText, provider, stickerEmbeddingIndex, settings.stickerSimilarityThreshold);
      sticker = matchResult?.id ?? null;
      if (sticker && loadStickerSettings()[sticker] === false) sticker = null;
    }
  }

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

// 廠商短名映射（與 settings.ts 的 MODEL_PRESETS.shortName 鏡像，需手動同步）。
// 狀態欄"正在餵養"在用戶沒填暱稱時用這個兜底。
const PROVIDER_SHORT_NAMES: Record<string, string> = {
  "MiniMax（稀宇科技）": "MiniMax",
  "DeepSeek（深度求索）": "DeepSeek",
  "火山 AgentPlan（火山引擎）": "火山",
  "GLM（智譜）": "GLM",
  "Kimi（月之暗面）": "Kimi",
  "Qwen（通義千問）": "Qwen",
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

    // 窗口與 workArea 交集至少 80x80 才使用保存的座標
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
        "[Cyrene] 桌寵保存位置已離屏（僅 " +
          interW + "x" + interH + " 可見），使用默認位置",
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
    icon: APP_ICON_PATH,
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

  mainWindow.webContents.on("did-finish-load", () => {
    const settings = loadGeneralSettings();
    const activeZoom = isPetDocked ? 0.45 : settings.petZoom;
    sendToLive2DWindow(IPC.PET_ZOOM, activeZoom);
  });

  if (!isDev) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }

  mainWindow.on("move", () => {
    // OS-level move event listener is kept for general position tracking if needed.
    // Accidental undocking is disabled here to prevent race conditions during parent window moves.
    // Detaching/undocking is handled cleanly by the pointerup event ('WINDOW_SET_DRAGGING') in renderer.
  });

  applyGeneralSettings(loadGeneralSettings());

  // Opener 主動開口：注入桌寵窗口 + 啟動 tick
  setLive2dWindow(mainWindow);
  reloadManifest();
  const initOpener = () => {
    const s = loadGeneralSettings();
    stopOpener();
    configureOpener(toOpenerRuntimeConfig(s));
    if (s.openerMode !== "off") startOpener(toOpenerRuntimeConfig(s));
  };
  initOpener();

  // 注入天氣工具配置獲取器：每次工具執行時實時讀 key/默認城市
  // （用戶改了設置不用重啟就能生效）
  setWeatherConfig(
    () => loadUserProfile().defaultCity,
    () => loadGeneralSettings().weatherSource,
    () => loadGeneralSettings().amapKey,
    // 天氣卡片回調：工具拿到結構化數據後，發 Custom 事件給聊天窗口渲染卡片
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

  // 注入用戶選擇卡片回調：工具調 ask_user_choice 時發 Custom 事件給聊天窗口
  setChoiceCardSender((cardData) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send(IPC.AGUI_EVENT, {
        type: "CUSTOM",
        name: "cyrene.choice",
        value: cardData,
      });
    }
  });

  // 注入搜索配置獲取器
  setSearchConfig(
    () => loadGeneralSettings().searchEngine,
    () => loadGeneralSettings().searchBochaKey,
    () => loadGeneralSettings().searchTavilyKey,
  );

  // 注入出行工具 amapKey 獲取器（複用 GeneralSettings 中的 amapKey）
  setTravelConfig(() => loadGeneralSettings().amapKey, () => loadGeneralSettings().travelEnabled);

  // 注入郵件工具 SMTP 配置獲取器（每次執行實時讀 GeneralSettings）
  setEmailConfig(
    () => loadGeneralSettings().emailEnabled,
    () => loadGeneralSettings().emailSmtpHost,
    () => loadGeneralSettings().emailSmtpPort,
    () => loadGeneralSettings().emailSmtpSecure,
    () => loadGeneralSettings().emailSmtpUser,
    () => loadGeneralSettings().emailSmtpPass,
    () => loadGeneralSettings().emailFromName,
  );

  // 注入 ASR 配置獲取器（通話功能用，實時讀 GeneralSettings）
  setAsrConfig(() => {
    const s = loadGeneralSettings();
    if (s.asrEngine !== "aliyun" && s.asrEngine !== "local" && s.asrEngine !== "web-speech") return null;
    return { appKey: s.asrAliyunAppKey, accessKeyId: s.asrAliyunAccessKeyId, accessKeySecret: s.asrAliyunAccessKeySecret, language: s.asrLanguage, engine: s.asrEngine, fallbackToLocal: s.asrFallbackToLocal };
  });

  // 注入通話模型/TTS 配置獲取器
  setCallSettings(
    () => {
      const s = loadModelSettings();
      return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, perProvider: s.perProvider };
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
    // 通話專用 system prompt 構建器（時間+常駐+記憶+phone人設+skill+語氣，不要環境上下文）
    async (userText: string) => {
      const messages = [{ role: "user" as const, content: userText }];

      // ① 時間日期
      const now = new Date();
      const timeStr = `當前時間：${now.toLocaleDateString("zh-CN")} ${now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;

      // ② 常駐上下文（世界書 + L0/L1 畫像）
      let alwaysOnContext = "";
      try { alwaysOnContext = await buildAlwaysOnContext(userText, messages); } catch { /* ignore */ }

      // ③ 記憶注入
      let memoryInjection = "";
      try { memoryInjection = await buildMemoryInjection(userText); } catch { /* ignore */ }

      // ④ 通話專用人設 prompt
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

      // ⑤ Skill 約束
      const skillCatalog = buildSkillCatalog(skillRegistry.getEnabled());
      const skillActivation = resolveSlashActivation(messages);

      // ⑥ 語氣注入
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
    // 天氣快捷處理：正則匹配到天氣關鍵詞 → 調 weather 工具的 execute
    async (userText: string) => {
      try {
        const weatherTool = toolRegistry.getById("weather");
        if (!weatherTool) return null;
        // 提取城市名（簡單匹配：XX天氣 / XX的天氣）
        const cityMatch = userText.match(/([北京上海廣州深圳成都杭州南京武漢西安重慶天津蘇州長沙鄭州青島大連瀋陽哈爾濱長春濟南太原合肥南昌福州昆明貴陽拉薩烏魯木齊呼和浩特]+)/);
        const city = cityMatch?.[1] ?? "";
        const result = await weatherTool.execute({ city }, undefined);
        return result;
      } catch (err) {
        console.warn("[Call] 天氣查詢失敗:", err);
        return null;
      }
    },
  );

  // 注入子代理 LLM 配置（delegate_task 工具用，複用主模型配置）
  setDelegateSettings(() => {
    const s = loadModelSettings();
    return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}


function createChatWindow(sessionId?: string): void {
  createSidebarWindow();
}

function createSidebarWindow(): void {
  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    sidebarWindow.show();
    sidebarWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const width = 1200;
  const height = 800;

  sidebarWindow = new BrowserWindow({
    x: dx + Math.max(0, Math.floor((dw - width) / 2)),
    y: dy + Math.max(0, Math.floor((dh - height) / 2)),
    width,
    height,
    minWidth: 960,
    minHeight: 600,
    title: "昔漣 · 工作台",
    icon: APP_ICON_PATH,
    backgroundColor: "#130a1c",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      sandbox: false,
    },
  });

  // 統一指針以滿足 TypeScript 類型推斷與現有 IPC 視窗控制
  chatWindow = sidebarWindow;
  tasksWindow = sidebarWindow;
  settingsWindow = sidebarWindow;

  if (isDev) {
    sidebarWindow.loadURL("http://localhost:5173/workspace/");
  } else {
    sidebarWindow.loadFile(
      path.join(__dirname, "..", "..", "renderer", "workspace", "index.html")
    );
  }

  sidebarWindow.once("ready-to-show", () => {
    sidebarWindow?.show();
    // 初始位置同步
    setTimeout(() => {
      updatePetDockPosition();
    }, 500);
  });

  sidebarWindow.on("move", () => {
    updatePetDockPosition();
  });

  sidebarWindow.on("resize", () => {
    updatePetDockPosition();
  });

  sidebarWindow.on("closed", () => {
    sidebarWindow = null;
    sidebarRestoreBounds = null;
    isSidebarExpanded = false;
    chatWindow = null;
    tasksWindow = null;
    settingsWindow = null;
  });
}

function createTasksWindow(): void {
  createSidebarWindow();
}

function createSettingsWindow(section?: string): void {
  createSidebarWindow();
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

/** 創建通話窗口（直式語音通話，支援系統畫面分享選擇器）。 */
function createCallWindow(): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.show();
    callWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { width: dw, height: dh } = display.workArea;
  const CALL_W = 440;
  const CALL_H = 820;
  const cx = Math.max(0, Math.floor((dw - CALL_W) / 2));
  const cy = Math.max(0, Math.floor((dh - CALL_H) / 2));

  callWindow = new BrowserWindow({
    x: display.workArea.x + cx,
    y: display.workArea.y + cy,
    width: CALL_W,
    height: CALL_H,
    minWidth: 420,
    minHeight: 600,
    title: "Cyrene · 語音通話",
    icon: APP_ICON_PATH,
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

  // 優先使用 macOS / Chromium 原生分享選擇器；較舊環境沒有系統選擇器時，
  // Electron 仍會透過 handler 提供主要螢幕，避免 getDisplayMedia 直接失敗。
  callWindow.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
      });
      const source = sources.find((item) => item.id.startsWith("screen:")) ?? sources[0];
      callback(source ? { video: source } : {});
    } catch (error) {
      console.error("[Call] 無法取得畫面分享來源:", error);
      callback({});
    }
  }, { useSystemPicker: true });

  if (isDev) {
    callWindow.loadURL("http://localhost:5173/call/");
  } else {
    callWindow.loadFile(path.join(__dirname, "..", "..", "renderer", "call", "index.html"));
  }

  callWindow.once("ready-to-show", () => {
    if (callWindow && !callWindow.isDestroyed()) {
      callWindow.show();
      if (isDev && process.env.CYRENE_CALL_DEVTOOLS === "1") {
        callWindow.webContents.openDevTools({ mode: "detach" });
      }
    }
  });

  callWindow.webContents.on("console-message", (event, level, message, line, sourceId) => {
    console.log(`[CallRenderer] ${message} (${path.basename(sourceId)}:${line})`);
  });

  callWindow.on("closed", () => {
    callWindow = null;
    stopCall();
    setCallWindow(null);
  });

  // 綁定給 call-manager
  setCallWindow(callWindow);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "打開狀態面板",
      click: () => { createSidebarWindow(); },
    },
    {
      label: "設置",
      click: () => { createSettingsWindow(); },
    },
    {
      label: "顯示/隱藏桌寵",
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

ipcMain.handle(IPC.WINDOW_SET_INTERACTIVE, (_event, interactive: boolean) => {
  if (mainWindow) {
    // While docked, keep the compact pet window interactive across its whole
    // rectangle. Once undocked, transparent pixels may pass through again.
    if (isPetDocked) {
      mainWindow.setIgnoreMouseEvents(false);
      return;
    }
    mainWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  }
});

ipcMain.on(IPC.WINDOW_SET_TEXT_INPUT_ACTIVE, (_event, active: boolean) => {
  isPetTextInputActive = Boolean(active);
  applyPetWindowLevel(loadGeneralSettings());
});

ipcMain.on(IPC.WINDOW_MOVE, (_event, dx: number, dy: number) => {
  if (mainWindow) {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x + dx, y + dy);
  }
});

ipcMain.on(IPC.WINDOW_MOVE_TO, (_event, x: number, y: number) => {
  if (!mainWindow) return;
  const rx = Math.round(x);
  const ry = Math.round(y);
  mainWindow.setPosition(rx, ry, false);
  pendingPetPosition = { x: rx, y: ry };
  // During pointer drag, saving settings would call applyGeneralSettings(),
  // which resizes the window and cancels the active pointer capture.
  if (!isPetDragging) {
    void saveGeneralSettings({ petWindowX: rx, petWindowY: ry });
    pendingPetPosition = null;
  }
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
  // Keep the parent relationship for the entire pointer gesture. On macOS,
  // changing a BrowserWindow's parent while the button is down cancels the
  // renderer's pointer capture, so the pet appears impossible to drag.
  isPetDragging = isDragging;
  if (isDragging) {
    pendingPetPosition = null;
  } else {
    // pointerup has already completed in the renderer; it is now safe to
    // detach, restore the configured size, and promote the pet to topmost.
    if (isPetDocked && pendingPetPosition) undockPet();
    else if (!isPetDocked) {
      const settings = loadGeneralSettings();
      applyPetZoom(settings.petZoom || 1.0);
    }
    if (pendingPetPosition) {
      void saveGeneralSettings({
        petWindowX: pendingPetPosition.x,
        petWindowY: pendingPetPosition.y,
      });
      pendingPetPosition = null;
    }
  }
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
ipcMain.handle(IPC.CHAT_SEND_MESSAGE, async (_event, messages: unknown, style: unknown) => {
  return requestModelReply(messages, typeof style === "string" ? style : undefined);
});

const petChatHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

ipcMain.handle(IPC.PET_CHAT_INPUT_VISIBILITY, () => {
  const settings = loadGeneralSettings();
  return settings.petChatInputEnabled && !isPetDocked;
});

ipcMain.handle(IPC.PET_CHAT_SEND, async (_event, rawText: unknown) => {
  const text = typeof rawText === "string" ? rawText.trim().slice(0, 500) : "";
  if (!text) throw new Error("請先輸入想說的話。");

  const result = await requestModelReply([
    {
      role: "system",
      content: "這是桌寵快捷對話。只回覆一個很短、自然的繁體中文段落，最多兩句、70 個中文字內；直接回答，不要舞台動作、括號描寫、標題、條列、Markdown 或換行。這項限制只適用本次桌寵快捷對話。",
    },
    ...petChatHistory.slice(-10),
    { role: "user", content: text },
  ]);
  const reply = compactPetReply(result.reply);
  petChatHistory.push({ role: "user", content: text }, { role: "assistant", content: reply });
  if (petChatHistory.length > 12) petChatHistory.splice(0, petChatHistory.length - 12);

  const settings = loadGeneralSettings();
  const speech = settings.ttsAutoRead && settings.ttsEngine !== "off"
    ? await synthesizeDailyRitual(reply, { ...settings, dailyRitualVoice: true })
    : null;
  return {
    text: reply,
    audioBase64: speech?.base64 ?? "",
    format: speech?.format ?? "mp3",
    durationMs: Math.max(1800, Math.min(18000, reply.length * 180)),
  };
});

ipcMain.handle(IPC.CHAT_INGEST_FILES, async (_event, paths: unknown) => {
  const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
  if (list.length === 0) return [];
  try {
    const results = await ingestPaths(list, importDocument);
    return results;
  } catch (err: any) {
    console.error("[Cyrene] ingestFiles ERROR:", err?.message || err);
    return [];
  }
});
ipcMain.on(IPC.SIDEBAR_MINIMIZE, () => {
  sidebarWindow?.minimize();
});

ipcMain.on(IPC.SIDEBAR_CLOSE, () => {
  sidebarWindow?.close();
});

ipcMain.on(IPC.SIDEBAR_TOGGLE_MAXIMIZE, () => {
  if (!sidebarWindow || sidebarWindow.isDestroyed()) return;

  if (isSidebarExpanded && sidebarRestoreBounds) {
    sidebarWindow.setBounds(sidebarRestoreBounds, true);
    sidebarRestoreBounds = null;
    isSidebarExpanded = false;
    return;
  }

  sidebarRestoreBounds = sidebarWindow.getBounds();
  const display = screen.getDisplayMatching(sidebarRestoreBounds);
  sidebarWindow.setBounds(display.workArea, true);
  isSidebarExpanded = true;
});

// 狀態欄窗口置頂 toggle：返回切換後的新狀態（true=已置頂）
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

ipcMain.on(IPC.SIDEBAR_SET_PET_DOCK_VISIBLE, (_event, visible: boolean) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const settings = loadGeneralSettings();
  // Only a pet that is still inside the workspace dock follows tab
  // visibility. An undocked desktop pet remains visible independently.
  if (isPetDocked) {
    if (visible && settings.petVisible) {
      mainWindow.showInactive();
      updatePetDockPosition();
    } else {
      mainWindow.hide();
    }
  } else if (settings.petVisible && !mainWindow.isVisible()) {
    mainWindow.showInactive();
  }
});

ipcMain.handle("sidebar:read-shared-notebook", async () => {
  const filePath = getSharedNotebookPath();
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
  } catch (err) {
    console.error("Failed to read shared notebook:", err);
  }
  return "";
});

ipcMain.handle("sidebar:open-shared-notebook", async () => {
  const filePath = getSharedNotebookPath();
  try {
    await shell.openPath(filePath);
    return true;
  } catch (err) {
    console.error("Failed to open shared notebook:", err);
  }
  return false;
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

ipcMain.handle(IPC.UI_THEME_GET, () => {
  return loadGeneralSettings().uiTheme;
});

ipcMain.handle(IPC.SETTINGS_SAVE_GENERAL, (_event, settings: Partial<GeneralSettings>) => {
  return saveGeneralSettings(settings);
});

function vaultFiles(): string[] {
  return [getSettingsPath(), getGeneralSettingsPath()];
}

ipcMain.handle(IPC.SECURITY_GET_STATUS, () => getVaultStatus(vaultFiles()));
ipcMain.handle(IPC.SECURITY_MIGRATE, () => migrateFilesToVault(vaultFiles()));
ipcMain.handle(IPC.BACKUP_GET_CONFIG, () => backupManager?.getConfig());
ipcMain.handle(IPC.BACKUP_SAVE_CONFIG, (_event, patch: { autoEnabled?: boolean; retentionDays?: 7 | 30 }) => {
  if (!backupManager) throw new Error("備份服務尚未啟動");
  const config = backupManager.saveConfig(patch ?? {});
  if (config.autoEnabled) backupManager.runAutoBackupIfDue();
  return config;
});
ipcMain.handle(IPC.BACKUP_CREATE, async (_event, categories: unknown) => {
  if (!backupManager) throw new Error("備份服務尚未啟動");
  const stamp = new Date().toISOString().slice(0, 10);
  const saveOptions: Electron.SaveDialogOptions = {
    title: "建立昔漣時間膠囊",
    defaultPath: path.join(app.getPath("documents"), `昔漣備份-${stamp}.cybackup`),
    filters: [{ name: "昔漣備份", extensions: ["cybackup"] }],
  };
  const result = settingsWindow ? await dialog.showSaveDialog(settingsWindow, saveOptions) : await dialog.showSaveDialog(saveOptions);
  if (result.canceled || !result.filePath) return null;
  return backupManager.create(result.filePath.endsWith(".cybackup") ? result.filePath : `${result.filePath}.cybackup`, categories);
});
ipcMain.handle(IPC.BACKUP_PICK_INSPECT, async () => {
  if (!backupManager) throw new Error("備份服務尚未啟動");
  const openOptions: Electron.OpenDialogOptions = {
    title: "選擇昔漣備份",
    properties: ["openFile"],
    filters: [{ name: "昔漣備份", extensions: ["cybackup"] }],
  };
  const result = settingsWindow ? await dialog.showOpenDialog(settingsWindow, openOptions) : await dialog.showOpenDialog(openOptions);
  if (result.canceled || !result.filePaths[0]) return null;
  return backupManager.inspect(result.filePaths[0]);
});
ipcMain.handle(IPC.BACKUP_RESTORE, (_event, payload: { filePath?: string; categories?: unknown }) => {
  if (!backupManager || !payload?.filePath) throw new Error("請先選擇備份檔");
  return backupManager.restore(payload.filePath, payload.categories);
});
ipcMain.on(IPC.SECURITY_RESTART_APP, () => {
  app.relaunch();
  app.exit(0);
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
  applyPetWindowLevel(saved);
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
 * 測試視覺模型連通性。
 * 用一張 4x4 純紅 PNG（100 字節 base64）做測試圖——純色位圖所有視覺模型都能識別，
 * 比 SVG 兼容性好（SVG 是矢量，部分模型不支持）。
 * 驗連通性（HTTP 2xx + 有內容返回）而非對答案——模型可能只說"一張紅色圖片"也算成功。
 */
const VISION_TEST_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC";

ipcMain.handle(IPC.SETTINGS_TEST_VISION, async (_event, cfg: { baseUrl: string; apiKey: string; model: string }) => {
  const start = Date.now();
  console.log("[Cyrene] test vision: model=" + cfg.model + " url=" + cfg.baseUrl);
  try {
    const { captionImage } = await import("./orchestrator/vision-captioner");
    const result = await captionImage(
      { base64: VISION_TEST_IMAGE_BASE64, mime: "image/png" },
      "這張圖是什麼顏色？用一個詞回答。",
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    );
    const latency = Date.now() - start;
    // 驗連通性：返回不含 [錯誤 即成功（視覺模型返回了內容）
    if (result.startsWith("[錯誤")) {
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
    filters: [{ name: "圖片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
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
    // 重建 embedding 索引
    const provider = getEmbeddingProvider();
    if (provider) {
      stickerEmbeddingIndex = await buildStickerEmbeddingIndex(
        provider,
        BUILT_IN_STICKER_DESCRIPTIONS,
        loadUserStickerManifest(),
      );
    }
  } catch (err) {
    console.error("[stickers] add failed:", err);
    throw err;
  }
  return getStickerManagerConfig();
});

ipcMain.handle(IPC.STICKERS_DELETE, async (_event, id: string) => {
  try {
    await deleteUserSticker(id);
    // 重建 embedding 索引
    const provider = getEmbeddingProvider();
    if (provider) {
      stickerEmbeddingIndex = await buildStickerEmbeddingIndex(
        provider,
        BUILT_IN_STICKER_DESCRIPTIONS,
        loadUserStickerManifest(),
      );
    }
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
ipcMain.handle(IPC.MEMORY_PANEL_PIN_L2, async (_event, payload: { id: string; pinned: boolean }) => {
  if (!payload?.id) return { ok: false, error: "缺少記憶 id" };
  await memoryStore.pinL2(payload.id, Boolean(payload.pinned));
  return { ok: true };
});
ipcMain.handle(IPC.MEMORY_PANEL_DELETE_L2, async (_event, id: string) => {
  if (!id) return { ok: false, error: "缺少記憶 id" };
  const memory = (await memoryStore.getAllL2()).find(item => item.id === id);
  if (memory?.ragId) removeMemory(memory.ragId);
  await memoryStore.deleteL2(id);
  return { ok: true };
});
ipcMain.handle(IPC.USER_GET_PROFILE, () => loadUserProfile());
ipcMain.handle(IPC.USER_SAVE_PROFILE, (_event, profile: Partial<UserProfile>) => {
  const saved = saveUserProfile(profile);
  const settings = loadGeneralSettings();
  stopOpener();
  configureOpener(toOpenerRuntimeConfig(settings));
  if (settings.openerMode !== "off") startOpener(toOpenerRuntimeConfig(settings));
  return saved;
});
ipcMain.handle(IPC.USER_UPLOAD_AVATAR, async () => {
  const { dialog } = await import("electron");
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "圖片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
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

// 註冊 local-sticker:// 協議（用戶添加的表情包圖片）
// 必須在 app.ready 之前調用
protocol.registerSchemesAsPrivileged([
  { scheme: "local-sticker", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.whenReady().then(async () => {
  backupManager = new BackupManager(app.getPath("userData"), app.getVersion());
  migrateFilesToVault(vaultFiles());
  try { backupManager.runAutoBackupIfDue(); } catch (error) { console.warn("[Backup] 自動備份失敗:", error); }
  // 註冊 local-sticker:// 協議處理器：將請求映射到 userData/stickers/ 下的文件
  protocol.handle("local-sticker", (request) => {
    const file = parseLocalStickerFileFromUrl(request.url);
    if (!file) return new Response("Invalid sticker URL", { status: 404 });

    const filePath = resolveLocalStickerPath(getStickersDir(), file);
    if (!filePath) return new Response("Invalid sticker path", { status: 403 });

    return net.fetch(pathToFileURL(filePath).toString());
  });
  // Token 用量查詢 IPC
  ipcMain.handle(IPC.TOKEN_USAGE_GET, (_event, days: number) => {
    return getUsage(Math.max(1, Math.min(90, Number(days) || 7)));
  });
  ipcMain.handle(IPC.CALL_USAGE_GET, (_event, days: number) => {
    return getCallUsage(Math.max(1, Math.min(90, Number(days) || 7)));
  });
  ipcMain.handle(IPC.AGENT_ACTIVITY_GET, (_event, days: number) => {
    const safeDays = Math.max(1, Math.min(90, Number(days) || 7));
    const memory = process.memoryUsage();
    return {
      events: getAgentActivities(200),
      summary: getAgentActivitySummary(),
      models: getUsageByModel(safeDays),
      resources: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        queue: getLLMQueueStatus(),
        activityLimit: 1000,
        callContextTurnLimit: 24,
      },
    };
  });
  ipcMain.handle(IPC.AGENT_DIAGNOSTIC_EXPORT, async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const options: Electron.SaveDialogOptions = {
      title: "匯出昔漣診斷包",
      defaultPath: path.join(app.getPath("documents"), `昔漣診斷-${stamp}.cydiag`),
      filters: [{ name: "昔漣診斷包", extensions: ["cydiag"] }],
    };
    const picked = settingsWindow ? await dialog.showSaveDialog(settingsWindow, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return null;
    const output = picked.filePath.endsWith(".cydiag") ? picked.filePath : `${picked.filePath}.cydiag`;
    const general = redactSecrets(loadGeneralSettings());
    const model = redactSecrets(loadModelSettings());
    const payload = {
      format: "cyrene-diagnostic",
      version: 1,
      createdAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: { os: process.platform, arch: process.arch, node: process.versions.node, electron: process.versions.electron },
      settings: { general, model },
      activities: getAgentActivities(500),
      activitySummary: getAgentActivitySummary(),
      tokenUsage: getUsage(30),
      tokenUsageByModel: getUsageByModel(30),
      resources: { memory: process.memoryUsage(), queue: getLLMQueueStatus() },
    };
    fs.writeFileSync(output, zlib.gzipSync(Buffer.from(JSON.stringify(payload, null, 2))), { mode: 0o600 });
    return { filePath: output };
  });
  ipcMain.handle(IPC.ASR_TEST_LOCAL, async (_event, payload: { pcmBase64?: string; language?: string }) => {
    const pcm = Buffer.from(payload?.pcmBase64 ?? "", "base64");
    if (!pcm.length || pcm.length > 10 * 1024 * 1024) throw new Error("測試音訊為空或超過 10 MB");
    const startedAt = Date.now();
    const text = await transcribeOfflineWhisper(pcm, payload?.language === "en" ? "en" : "zh");
    return { text, latencyMs: Date.now() - startedAt };
  });

  ipcMain.handle(IPC.CONNECTION_STATUS_GET, () => {
    type State = "connected" | "pending" | "error";
    type Item = { id: string; name: string; detail: string; icon: string; state: State; label: string };
    const items: Item[] = [];
    const model = loadModelSettings();
    const general = loadGeneralSettings();
    const add = (item: Item) => items.push(item);

    add({
      id: "model",
      name: "對話模型",
      detail: model.model || model.provider || "尚未設定",
      icon: "AI",
      state: model.apiKey ? "connected" : "error",
      label: model.apiKey ? "已連接" : "缺少設定",
    });

    if (general.ttsEngine !== "off") {
      const configured = general.ttsEngine === "minimax"
        ? Boolean(general.ttsMinimaxKey && general.ttsMinimaxVoiceId)
        : general.ttsEngine === "gptsovits"
          ? Boolean(general.ttsGptsovitsBaseUrl && general.ttsGptsovitsRefAudioPath)
          : general.ttsEngine === "custom-cloud"
            ? Boolean(general.ttsCustomCloudEndpointUrl)
            : Boolean(general.ttsMimoKey && general.ttsMimoVoiceAudioPath);
      add({ id: "tts", name: "語音合成", detail: general.ttsEngine, icon: "TTS", state: configured ? "connected" : "error", label: configured ? "已設定" : "設定不完整" });
    }

    if (general.asrEngine !== "off") {
      const configured = general.asrEngine === "local"
        || general.asrEngine === "web-speech"
        || Boolean(general.asrAliyunAppKey && general.asrAliyunAccessKeyId && general.asrAliyunAccessKeySecret);
      add({ id: "asr", name: "語音辨識", detail: general.asrEngine, icon: "ASR", state: configured ? "connected" : "error", label: configured ? "已設定" : "設定不完整" });
    }

    if (general.weatherEnabled) {
      const configured = general.weatherSource === "open-meteo" || Boolean(general.amapKey);
      add({ id: "weather", name: "天氣服務", detail: general.weatherSource, icon: "天", state: configured ? "connected" : "error", label: configured ? "已啟用" : "缺少金鑰" });
    }

    if (general.searchEngine !== "off") {
      const key = general.searchEngine === "bocha" ? general.searchBochaKey : general.searchEngine === "tavily" ? general.searchTavilyKey : general.searchMinimaxKey;
      add({ id: "search", name: "聯網搜尋", detail: general.searchEngine, icon: "搜", state: key ? "connected" : "error", label: key ? "已啟用" : "缺少金鑰" });
    }

    if (general.emailEnabled) {
      const configured = Boolean(general.emailSmtpHost && general.emailSmtpUser && general.emailSmtpPass);
      add({ id: "email", name: "郵件服務", detail: general.emailSmtpHost || "SMTP", icon: "郵", state: configured ? "connected" : "error", label: configured ? "已設定" : "設定不完整" });
    }

    if (general.travelEnabled) {
      add({ id: "travel", name: "出行服務", detail: "高德地圖", icon: "行", state: general.amapKey ? "connected" : "error", label: general.amapKey ? "已啟用" : "缺少金鑰" });
    }

    const channelNames: Record<string, string> = { wechat: "微信", feishu: "飛書", discord: "Discord" };
    for (const [id, status] of Object.entries(channelManager.getAllStatus())) {
      if (!status.enabled) continue;
      const state: State = status.phase === "running" ? "connected" : status.phase === "starting" ? "pending" : "error";
      add({ id: `channel-${id}`, name: channelNames[id] || id, detail: status.message || status.phase, icon: id.slice(0, 2).toUpperCase(), state, label: status.phase === "running" ? "已連接" : status.phase === "starting" ? "連接中" : "異常" });
    }

    for (const server of listMcpServers()) {
      add({ id: `mcp-${server.id}`, name: server.name, detail: `MCP · ${server.toolCount} 個工具`, icon: "MCP", state: server.connected ? "connected" : "error", label: server.connected ? "已連接" : "未連接" });
    }

    return items;
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
  // 保存/加載 TTS 配置（複用 general settings 存儲）
  ipcMain.handle(IPC.TTS_SAVE_SETTINGS, async (_event, tts: Partial<GeneralSettings>) => {
    const before = loadGeneralSettings();
    const saved = saveGeneralSettings({ ...before, ...tts });

    // 搜索 MCP 自動註冊/移除：選 MiniMax+有key→註冊，否則→移除
    const searchConfigChanged = "searchMinimaxKey" in tts || "searchEngine" in tts;
    if (searchConfigChanged) {
      await syncVolcanoSearchMcp(saved);
    }

    // Playwright MCP：按 settings 字段自動連接/斷開
    if ("playwrightMcpEnabled" in tts) {
      await syncPlaywrightMcp(saved);
    }

    // Opener 主動開口：任一策略變化時重啟
    if (Object.keys(tts).some(key => key.startsWith("opener"))) {
      stopOpener();
      configureOpener(toOpenerRuntimeConfig(saved));
      if (saved.openerMode !== "off") startOpener(toOpenerRuntimeConfig(saved));
    }

    if (Object.keys(tts).some(key => key.startsWith("dailyRitual"))) {
      syncDailyRitualTasks(saved, getSchedulerStore());
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.SCHEDULER_CHANGED);
      }
    }

    // 返回不含密鑰明文的副本（前端展示用）
    return saved;
  });
  ipcMain.handle(IPC.TTS_LOAD_SETTINGS, () => {
    return loadGeneralSettings();
  });

  // Opener 反饋：點氣泡接話
  ipcMain.on(IPC.OPENER_FEEDBACK, (_event, payload: { type: "clicked"; sceneId: string; itemId: string }) => {
    if (payload?.type === "clicked") {
      handleBubbleClick(payload.sceneId, payload.itemId);
    }
  });

  // Opener 手動測試氣泡
  ipcMain.handle(IPC.OPENER_TEST_FIRE, async (_event, sceneId?: string) => testFire(sceneId));
  ipcMain.handle(IPC.OPENER_GET_STATUS, () => getOpenerStatus());
  ipcMain.handle(IPC.OPENER_OPEN_PACK_FOLDER, async () => {
    const dir = getOpenerStatus().packDir;
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    return { ok: !error, error: error || undefined };
  });

  // 上傳音頻文件 → file_id
  ipcMain.handle(IPC.TTS_UPLOAD, async (_event, payload: { apiKey: string; filePath: string; purpose: "voice_clone" | "prompt_audio" }) => {
    if (!payload?.apiKey || !payload?.filePath) {
      throw new Error("缺少 API Key 或文件路徑");
    }
    return await ttsUploadFile(payload.apiKey, payload.filePath, payload.purpose);
  });

  // 選擇音頻文件（Electron dialog）
  ipcMain.handle(IPC.TTS_PICK_AUDIO, async () => {
    const result = await dialog.showOpenDialog({
      title: "選擇音頻文件",
      filters: [{ name: "音頻文件", extensions: ["mp3", "m4a", "wav"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // 音色快速復刻 → voice_id
  ipcMain.handle(IPC.TTS_CLONE, async (_event, payload: {
    apiKey: string; fileId: string; voiceId: string;
    promptAudioId?: string; promptText?: string;
    text: string; model?: string;
  }) => {
    if (!payload?.apiKey || !payload?.fileId || !payload?.voiceId || !payload?.text) {
      throw new Error("缺少必要參數（apiKey/fileId/voiceId/text）");
    }
    return await ttsCloneVoice(payload);
  });

  // 語音合成 → base64 音頻（聊天朗讀 / 測試發音都用這個）
  ipcMain.handle(IPC.TTS_SYNTHESIZE, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
  }) => {
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text) {
      throw new Error("缺少必要參數（apiKey/voiceId/text）");
    }
    const audioBuffer = await ttsSynthesize({
      ...payload,
      debugLog: appendMinimaxTtsLog,
    });
    // Buffer → base64 傳給渲染進程（渲染進程用 atob 解碼再播）
    return audioBuffer.toString("base64");
  });

  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => {
    const format = payload.format ?? "mp3";

    // 回聽優先：如果 expectedCacheKey 對應的緩存文件存在，直接返回，不需要 apiKey/voiceId。
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

    // 緩存未命中 → 需要合成，檢查 apiKey/voiceId
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text || payload.apiKey === "cache-only") {
      throw new Error("緩存未命中且缺少必要參數（apiKey/voiceId/text）");
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

  // 流式語音合成（minimax WS 邊合成邊推 chunk 給渲染端播）
  // 主進程同時攢完整 buffer 落盤緩存，下次同文本走緩存
  ipcMain.handle(IPC.TTS_STREAM_START, async (event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => {
    const format = payload.format ?? "mp3";
    const sender = event.sender;

    // 回聽優先：expectedCacheKey 命中緩存直接發完整 base64（走 STREAM_END，不走 chunk）
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
      // 緩存命中：一次性發完整音頻（渲染端會按 STREAM_END 處理，直接播完整 buffer）
      sender.send(IPC.TTS_AUDIO_CHUNK, { base64: cachedBuf.toString("base64") });
      sender.send(IPC.TTS_STREAM_END, { cacheKey: payload.expectedCacheKey, cached: true, format });
      return { started: false, cacheKey: payload.expectedCacheKey, cached: true };
    }

    if (!payload?.apiKey || !payload?.voiceId || !payload?.text) {
      throw new Error("流式合成缺少必要參數（apiKey/voiceId/text）");
    }

    const cacheKey = buildTtsCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    const fullChunks: Buffer[] = [];

    // 異步合成，不 await（handler 立即返回，chunk 通過 send 推送）
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
        // 落盤緩存（用完整 buffer，不用拼接的 fullChunks——synthesize 返回的更可靠）
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

  // GPT-SoVITS 語音合成 → base64 音頻（測試發音用，不緩存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_GPTSOVITS, async (_event, payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
  }) => {
    if (!payload?.baseUrl || !payload?.refAudioPath || !payload?.promptText || !payload?.text) {
      throw new Error("缺少必要參數（baseUrl/refAudioPath/promptText/text）");
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

  // GPT-SoVITS 語音合成 + 本地緩存（聊天朗讀用）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_GPTSOVITS, async (_event, payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => {
    const format: "wav" | "mp3" = payload.format ?? "wav";

    // 回聽優先：如果 expectedCacheKey 對應的緩存文件存在，直接返回，不需要 baseUrl/refAudioPath。
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

    // 緩存未命中 → 需要合成，檢查必要參數
    if (!payload?.baseUrl || !payload?.refAudioPath || !payload?.promptText || !payload?.text) {
      throw new Error("緩存未命中且缺少必要參數（baseUrl/refAudioPath/promptText/text）");
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

  // 自定義雲端 TTS 合成 → base64 音頻（測試發音用，不緩存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CUSTOM_CLOUD, async (_event, payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
  }) => {
    if (!payload?.endpointUrl || !payload?.text) {
      throw new Error("缺少必要參數（endpointUrl/text）");
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

  // 自定義雲端 TTS 合成 + 本地緩存（聊天朗讀用）
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
      throw new Error("緩存未命中且缺少必要參數（endpointUrl/text）");
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

  // 小米 MiMo TTS 合成 → base64 音頻（測試發音用，不緩存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_MIMO, async (_event, payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
  }) => {
    if (!payload?.apiKey || !payload?.voiceAudioPath || !payload?.text) {
      throw new Error("缺少必要參數（apiKey/voiceAudioPath/text）");
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

  // 小米 MiMo TTS 合成 + 本地緩存（聊天朗讀用）
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
      throw new Error("緩存未命中且缺少必要參數（apiKey/voiceAudioPath/text）");
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

  // 聊天會話存儲 IPC（chats-store.initialize 會建好 cyrene-chats 目錄並加載 index）
  registerChatsIpc();

  // 歷史召回工具（recall_history）——讓模型能回憶滾出窗口的對話
  registerRecallHistoryTool();

  // 文檔生成工具（write_excel/write_word/write_pdf/write_markdown）
  registerDocumentTools();

  // 生活類工具（記賬/匯率/翻譯/代碼補丁）
  // 翻譯需要主模型，注入 loadModelSettings getter
  setTranslateConfig(() => {
    const s = loadModelSettings();
    return s.apiKey ? { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey } : null;
  });
  registerLifeTools();

  // 出行工具（路線規劃——駕車/步行/騎行/公交，複用 amapKey）
  registerTravelTools();

  // 郵件發送工具（SMTP 直髮，需在設置裡配置 SMTP 授權碼）
  registerEmailTools();
  syncBuiltInToolToggles(loadGeneralSettings());

  // 內置 MCP 自動連接：Playwright (默認關閉,選項控制)
  const initialSettings = loadGeneralSettings();

  // 一次性清理已下架的內置 MCP（Firecrawl hosted 等）
  const removed = await pruneMcpServersByIds([...REMOVED_BUILTIN_MCP_IDS]);
  if (removed.length > 0) {
    console.log("[Cyrene] 已清理遺留的已下架內置 MCP:", removed.join(", "));
  }

  void syncPlaywrightMcp(initialSettings).catch((e) =>
    console.error("[Cyrene] playwright MCP sync failed:", e)
  );

  // Skill 系統：掃描雙源 skills + 註冊 meta-tool
  initSkills();

  // 遊戲代肝：IPC + game_bot_start 工具
  initGameBot();

  // 內建遊戲房：比分持久化 + Live2D 回合反應
  initGameRoom(sendToLive2DWindow);

  // 多渠道（微信/飛書/...）：先注入 dispatcher 的 buildAndRunAgent + TTS + 鏡像廣播 + 最近歷史讀取，
  // 讓 channels 模塊拿到真 agent + 出站增強能力 + 對話上下文。
  setDispatcherLoadRecentHistory(async (sessionId, limit) => {
    // 委託給 history-log：讀 userData/channels/history/<sessionId>.jsonl 最新 N 條
    const { loadRecentHistory } = await import("./channels/history-log");
    return loadRecentHistory(sessionId, limit);
  });

  const channelSessionModes = new Map<string, string>();

  setDispatcherBuildAndRunAgent(async (msg, sessionId, priorMessages) => {
    const textTrimmed = msg.text.trim();
    if (textTrimmed === "/study") {
      channelSessionModes.set(sessionId, "study");
      return "昔漣已為你切換至學習模式（英文教學、無語音）！\nCyrene has switched to Study Mode (English, no TTS) for you! ♪";
    }
    if (textTrimmed === "/talk") {
      channelSessionModes.set(sessionId, "talk");
      return "昔漣已為你切換至日常聊天模式！♪";
    }
    if (textTrimmed === "/collab") {
      channelSessionModes.set(sessionId, "collab");
      return "昔漣已為你切換至協作模式！♪";
    }

    // 根據語意動態切換模式（適用於 DC 等多渠道對話）
    const isGameQueryDC = ["攻略", "遊戲", "打法", "配隊"].some(k => msg.text.includes(k));
    if (msg.text.includes("昔漣老師")) {
      channelSessionModes.set(sessionId, "study");
    } else if (msg.text.includes("昔漣")) {
      channelSessionModes.set(sessionId, "collab");
    } else if (isGameQueryDC) {
      channelSessionModes.set(sessionId, "game");
    } else if (isEnglishText(msg.text)) {
      channelSessionModes.set(sessionId, "study");
    }

    const currentMode = channelSessionModes.get(sessionId) || "collab";
    let style = "01_default.md";
    if (currentMode === "study") style = "study";
    else if (currentMode === "talk") style = "talk";
    else if (currentMode === "game") style = "game";

    // Phase 3.3：按 toolSandbox 過濾可用工具
    const sandbox = loadChannelsSettings().toolSandbox;
    const allTools = toolRegistry.getEnabledTools();
    const filteredTools: ToolDefinition[] = sandbox === "safe-only"
      ? allTools.filter((t) => (t.risk ?? "safe") === ("safe" as ToolRiskLevel))
      : allTools;
    console.log(
      "[Channels] bot run:",
      `msg.channel=${msg.channel} sandbox=${sandbox} tools=${filteredTools.length}/${allTools.length} priorMsgs=${priorMessages?.length ?? 0}`,
    );

    // Phase A：拼接歷史 (同桌面端 buildModelMessages 行為: 上滑窗最近 N 條).
    // history-log 統一存 role: "user"|"assistant", 直接用即可.
    const historyMessages = (priorMessages ?? [])
      .filter((m) => typeof m.content === "string" && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));

    // 把 IncomingMessage 轉成 AguiRunInput，調 CyreneAgent
    const { options } = await buildAgentRunOptions(
      {
        messages: [
          ...historyMessages,
          { role: "user", content: msg.text },
        ],
        style,
        sessionId,
        attachments: msg.attachments?.map((a) => ({
          name: a.filePath ?? a.url ?? "attachment",
          text: a.caption ?? "",
        })),
        channel: msg.channel,
      },
      buildOptionsDeps,
    );
    // 把過濾後的 tools 注入 options（覆蓋默認的 getEnabledTools）
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
    if (agent.lastResult) {
      const stickerId = await onAgentRunFinished(agent.lastResult, msg.text, onRunFinishedDeps, msg.channel);
      if (msg.channel === "discord") {
        void recordDiscordToolActionsInNotebook(agent.lastResult.toolResults, {
          companionName: msg.senderName,
        });
      }
      // Dispatcher 會依渠道能力把這個 part 交給 Discord；其他不支援的渠道會自動略過。
      const stickerPath = msg.channel === "discord" && stickerId
        ? resolveStickerImagePath(stickerId)
        : null;
      if (stickerId && !stickerPath) {
        console.warn(`[stickers] 找不到表情包圖片，略過渠道發送: ${stickerId}`);
      }
      void indexConversationTurn(sessionId, msg.text, reply);
      return {
        text: reply,
        ...(stickerId && stickerPath
          ? { sticker: { id: stickerId, imagePath: stickerPath } }
          : {}),
      };
    }
    // 落歷史
    void indexConversationTurn(sessionId, msg.text, reply);
    return reply;
  });

  // Phase 3.1：注入 TTS 合成 —— dispatcher 在 reply 後會用這個生成 mp3
  const synthesizeChannelTts = async (text: string): Promise<{ audio: Buffer; format: "wav" | "mp3" } | null> => {
    const cfg = loadGeneralSettings();
    if (cfg.ttsEngine === "off") return null;
    if (cfg.ttsEngine === "minimax" && (!cfg.ttsMinimaxKey || !cfg.ttsMinimaxVoiceId)) return null;
    if (cfg.ttsEngine === "gptsovits" && (!cfg.ttsGptsovitsBaseUrl || !cfg.ttsGptsovitsRefAudioPath || !cfg.ttsGptsovitsPromptText)) return null;
    if (cfg.ttsEngine === "custom-cloud" && !cfg.ttsCustomCloudEndpointUrl) return null;
    if (cfg.ttsEngine === "mimo" && (!cfg.ttsMimoKey || !cfg.ttsMimoVoiceAudioPath)) return null;
    // 限制 TTS 文本長度（飛書 audio 100M 限制 + 用戶體驗，太長應截斷）
    const ttsText = text.length > 1000 ? text.slice(0, 1000) + "…" : text;
    try {
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
        format: cfg.ttsEngine === "gptsovits"
          ? cfg.ttsGptsovitsFormat
          : cfg.ttsEngine === "custom-cloud"
            ? cfg.ttsCustomCloudFormat
            : "mp3",
      });
      return result;
    } catch (err) {
      console.warn("[Channels] TTS 合成失敗:", err instanceof Error ? err.message : err);
      return null;
    }
  };
  setDispatcherSynthesizeTts(synthesizeChannelTts);
  setDiscordVoiceServices({
    transcribe: transcribeCallPcm,
    synthesize: synthesizeChannelTts,
  });

  // Phase 3.2：注入桌面端鏡像廣播 —— 把 bot 入站/出站消息推到 chatWindow
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
      console.warn("[Channels] botMessage 廣播失敗:", err);
    }
  });

  void initChannels();

  // 任務清單（todo_write 工具的持久化 + 事件廣播）：
  // - loadTodos 從磁盤恢復上次未完成的任務（跨重啟延續）
  // - onTodosChange 訂閱變化，把 TodoState 作為 CUSTOM 事件轉發給所有聊天窗口
  //   渲染端收到 cyrene.todos 後渲染左上角進度面板
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
        console.warn("[Cyrene] todos 廣播失敗:", e);
      }
    }
  });

  const schedulerStore = getSchedulerStore();
  schedulerStore.load();
  syncDailyRitualTasks(loadGeneralSettings(), schedulerStore);
  const schedulerRunner = createSchedulerRunner({
    buildOptions: async (task: ScheduledTask) => {
      const settings = loadModelSettings();
      if (!settings.apiKey) throw new Error("還沒有填寫 API Key，請先在設置裡保存 API 配置。");
      const currentTodos = getCurrentTodos().todos
        .filter(todo => todo.status !== "completed")
        .slice(0, 8)
        .map(todo => `- [${todo.status === "in_progress" ? "進行中" : "待辦"}] ${todo.content}`)
        .join("\n");
      const prompt = getDailyRitualPrompt(task, currentTodos);
      const messages = [{ role: "user" as const, content: prompt }];
      let alwaysOnContext = "";
      try {
        alwaysOnContext = await buildAlwaysOnContext(prompt, messages);
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
        timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
      };
    },
    getChatWebContents: () => (chatWindow && !chatWindow.isDestroyed() ? chatWindow.webContents : null),
    recordHistory: (entry) => schedulerStore.recordHistory(entry),
    id: () => `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    now: () => new Date(),
    onSuccess: async (task, result) => {
      if (!isDailyRitualTask(task) || !result.reply?.trim()) return;
      const cfg = loadGeneralSettings();
      const speech = await synthesizeDailyRitual(result.reply, cfg);
      showGeneratedBubble(
        result.reply,
        speech?.base64 ?? "",
        speech?.format ?? "mp3",
        Math.max(2200, Math.min(20000, result.reply.length * 190)),
        `daily-ritual-${task.ritualId}`,
      );
    },
  });
  schedulerEngine = new SchedulerEngine({
    store: schedulerStore,
    runTask: schedulerRunner.runScheduledTask,
  });
  registerSchedulerIpc(schedulerStore, schedulerEngine, () => toolRegistry.getAllTools());

  // AG-UI 事件流橋：渲染進程 invoke(AGUI_RUN) → CyreneAgent 跑 FC 循環 → 事件透傳
  // buildOptions 複用 requestModelReply 的上下文構建；onRunFinished 複用副作用
  // Phase 0 重構：抽出到 orchestrator/build-options.ts，三處共用（桌面 / scheduler / bot）
  // deps 函數簽名故意寬 (unknown/ReadonlyArray)；這裡做一次包裝把強類型函數適配進去
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildOptionsDeps: BuildOptionsDeps = {
    loadModelSettings: () => loadModelSettings(),
    loadUserProfile: () => loadUserProfile(),
    buildEnvironmentContext: ((model: { provider: string; model: string }, profile: unknown) =>
      buildEnvironmentContext(model as any, profile as any)) as BuildOptionsDeps["buildEnvironmentContext"],
    buildSkillCatalog: ((skills: ReadonlyArray<unknown>) =>
      buildSkillCatalog(skills as any)) as BuildOptionsDeps["buildSkillCatalog"],
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
    logWorldbookInjection,
    normalizeChatMessages: ((raw: ReadonlyArray<unknown>) =>
      normalizeChatMessages(raw as any)) as BuildOptionsDeps["normalizeChatMessages"],
    chatRequestTimeoutMs: CHAT_REQUEST_TIMEOUT_MS,
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
    async (result, latestUserText) => {
      await onAgentRunFinished(result, latestUserText, onRunFinishedDeps);
    },
    () => chatWindow,
  );

  ipcMain.handle(IPC.CHATS_OPEN_IN_CHAT_WINDOW, (_event, sessionId: string) => {
    createChatWindow(sessionId);
    return true;
  });
  // 聊天窗口啟動/切換會話時上報當前活躍 sessionId；main 廣播給所有窗口
  // 用途：設置面板"刪除當前會話"時差異化提示文案
  ipcMain.handle(IPC.CHATS_SET_ACTIVE_SESSION, (_event, sessionId: string | null) => {
    activeChatSessionId = sessionId ?? null;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(IPC.CHATS_ACTIVE_SESSION_CHANGED, activeChatSessionId); } catch { /* ignore */ }
    }
    return true;
  });
  ipcMain.handle(IPC.CHATS_GET_ACTIVE_SESSION, () => activeChatSessionId);

  ipcMain.on("sidebar:report-slot-bounds", (event, bounds) => {
    lastSlotBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    isPetDocked = bounds.isDocked;
    syncPetChatInputVisibility();
    updatePetDockPosition();
  });

  const generalSettings = loadGeneralSettings();
  createWindow();
  createSidebarWindow();
  createTray();
  // 權限模塊初始化：必須在 createWindow 之後但任意工具調用之前
  initPermissionFromDisk();
  registerPermissionIpc();
  registerChoiceIpc();
  registerCallIpc();
  console.log("[Cyrene] 當前 agent 權限檔位:", getCurrentLevel());
  try {
    const modelSettings = loadModelSettings();
    await initRAG("auto", undefined, undefined, modelSettings.embeddingModel);
      // 初始化 MCP Manager；scheduler 啟動前等待一次，避免近即時任務早於 MCP 工具恢復。
      await initMcpManager();
      console.log("[Cyrene] RAG initialized OK");

    await initReranker(modelSettings.rerankerMode);
  } catch (err) {
    console.error("[Cyrene] RAG init FAILED:", err);
  }

  // 初始化表情包 embedding 索引
  try {
    const provider = getEmbeddingProvider();
    if (provider) {
      stickerEmbeddingIndex = await buildStickerEmbeddingIndex(
        provider,
        BUILT_IN_STICKER_DESCRIPTIONS,
        loadUserStickerManifest(),
      );
      console.log(`[StickerEmbedding] index built: ${stickerEmbeddingIndex.length} entries`);
    } else {
      console.warn("[StickerEmbedding] Model not found. Sticker matching disabled.");
    }
  } catch (err) {
    console.error("[StickerEmbedding] Init failed:", (err as Error).message);
  }

  // 初始化場景 embedding 索引（語氣注入用，替代關鍵詞匹配）
  // 用 bge-m3（多語言，中文效果好），和文檔/記憶的 minilm 獨立
  try {
    const sceneProvider = getSceneEmbeddingProvider();
    if (sceneProvider) {
      sceneEmbeddingIndex = await buildSceneIndex(sceneProvider);
      console.log("[SceneEmbedding] index built:", Object.keys(sceneEmbeddingIndex.scenes).length, "scenes");
    } else {
      console.warn("[SceneEmbedding] bge-m3 model not found. Scene embedding disabled.");
    }
  } catch (err) {
    console.error("[SceneEmbedding] Init failed:", (err as Error).message);
  }

  // 昔漣的創作工作台（OpenRouter / Gemini 圖片生成）IPC 處理器
  ipcMain.handle("paint:build-prompt", async (_event, description: string) => {
    try {
      const settings = loadModelSettings();
      if (!settings.apiKey) {
        throw new Error("還沒有填寫 API Key，請先在設置裡保存 API 配置。");
      }
      
      const promptMessages = [
        {
          role: "system" as const,
          content: "You convert Traditional Chinese image briefs into concise, production-ready English prompts for modern image generation models. Preserve the user's requested subject, clothing, pose, camera, lighting, mood, and style. Use natural descriptive English rather than Danbooru keyword spam. Output only the final prompt with no markdown, commentary, headings, or quotation marks. Do not invent nudity or sexual content."
        },
        {
          role: "user" as const,
          content: description
        }
      ];
      
      const result = await callChatCompletions(
        settings,
        promptMessages,
        undefined,
        15000,
        "繪圖提示詞生成"
      );
      return result || "";
    } catch (err: any) {
      console.error("[Paint] build-prompt error:", err?.message || err);
      return "";
    }
  });

  const getPaintCredentials = () => {
    const settings = loadModelSettings();
    const openRouterProfile = settings.perProvider?.Custom;
    const geminiProfile = settings.perProvider?.["Gemini（Google）"];
    return {
      openrouter: {
        apiKey: openRouterProfile?.apiKey || process.env.OPENROUTER_API_KEY || "",
        baseUrl: (openRouterProfile?.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
        model: openRouterProfile?.model || "google/gemini-3.1-flash-image",
      },
      gemini: {
        apiKey: geminiProfile?.apiKey || process.env.GEMINI_API_KEY || "",
        model: geminiProfile?.model || "gemini-3.1-flash-image",
      },
    };
  };

  ipcMain.handle("paint:get-connections", () => {
    const credentials = getPaintCredentials();
    return [
      {
        provider: "openrouter",
        label: "OpenRouter Image API",
        connected: Boolean(credentials.openrouter.apiKey),
        model: credentials.openrouter.model,
      },
      {
        provider: "gemini",
        label: "Gemini 原生圖片 API",
        connected: Boolean(credentials.gemini.apiKey),
        model: credentials.gemini.model,
      },
    ];
  });

  type PaintImagePayload = {
    provider: "openrouter" | "gemini";
    prompt: string;
    model: string;
    aspectRatio: string;
    resolution: "1K" | "2K" | "4K";
    quality: "auto" | "low" | "medium" | "high";
    references?: Array<{ dataUrl: string; mimeType: string }>;
  };

  const parseDataUrl = (dataUrl: string, fallbackMimeType: string) => {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) throw new Error("參考圖格式無效，請重新選擇 PNG、JPEG 或 WebP 圖片。");
    return { mimeType: match[1] || fallbackMimeType, data: match[2] };
  };

  const readErrorResponse = async (response: Response) => {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      if (typeof parsed.error === "string") return parsed.error;
      return parsed.error?.message || parsed.message || body;
    } catch {
      return body || `HTTP ${response.status}`;
    }
  };

  const savePaintImage = (bytes: Uint8Array, mimeType = "image/png") => {
    const extension = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
    const outputDir = path.join(app.getPath("pictures"), "Cyrene Studio");
    fs.mkdirSync(outputDir, { recursive: true });
    const savedPath = path.join(outputDir, `cyrene-${Date.now()}.${extension}`);
    fs.writeFileSync(savedPath, bytes);
    return savedPath;
  };

  const savePaintBase64 = (data: string, mimeType = "image/png") =>
    savePaintImage(Buffer.from(data, "base64"), mimeType);

  const savePaintUrl = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下載生成圖片失敗：HTTP ${response.status}`);
    const mimeType = response.headers.get("content-type") || "image/png";
    return savePaintImage(new Uint8Array(await response.arrayBuffer()), mimeType);
  };

  const findGeminiImage = (value: unknown, depth = 0): { data: string; mimeType: string } | null => {
    if (depth > 7 || value == null) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findGeminiImage(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const data = typeof record.data === "string" ? record.data : undefined;
    const mimeType = typeof record.mime_type === "string"
      ? record.mime_type
      : typeof record.mimeType === "string"
        ? record.mimeType
        : undefined;
    if (data && (!mimeType || mimeType.startsWith("image/"))) {
      return { data, mimeType: mimeType || "image/png" };
    }
    for (const child of Object.values(record)) {
      const found = findGeminiImage(child, depth + 1);
      if (found) return found;
    }
    return null;
  };

  ipcMain.handle("paint:generate-image", async (_event, payload: PaintImagePayload) => {
    try {
      if (!payload?.prompt?.trim()) throw new Error("繪圖 Prompt 不可為空。");
      const credentials = getPaintCredentials();
      const references = (payload.references || []).slice(0, 4);

      if (payload.provider === "openrouter") {
        const apiKey = credentials.openrouter.apiKey;
        if (!apiKey) throw new Error("尚未設定 OpenRouter API Key，請到設定頁完成連接。");
        const inputReferences = references.map((reference) => ({
          type: "image_url",
          image_url: { url: reference.dataUrl },
        }));
        const response = await fetch(`${credentials.openrouter.baseUrl}/images`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://cyrene.local",
            "X-Title": "Cyrene Painting Studio",
          },
          body: JSON.stringify({
            model: payload.model || "google/gemini-3.1-flash-image",
            prompt: payload.prompt,
            n: 1,
            aspect_ratio: payload.aspectRatio || "1:1",
            resolution: payload.resolution || "1K",
            quality: payload.quality || "auto",
            output_format: "png",
            ...(inputReferences.length > 0 ? { input_references: inputReferences } : {}),
          }),
        });
        if (!response.ok) throw new Error(`OpenRouter：${await readErrorResponse(response)}`);
        const result = await response.json() as { data?: Array<{ b64_json?: string; media_type?: string; url?: string }> };
        const image = result.data?.[0];
        if (image?.b64_json) {
          const mimeType = image.media_type || "image/png";
          return {
            dataUrl: `data:${mimeType};base64,${image.b64_json}`,
            savedPath: savePaintBase64(image.b64_json, mimeType),
          };
        }
        if (image?.url) return { dataUrl: image.url, savedPath: await savePaintUrl(image.url) };
        throw new Error("OpenRouter 回應中沒有圖片資料。");
      }

      const apiKey = credentials.gemini.apiKey;
      if (!apiKey) throw new Error("尚未設定 Gemini API Key，請到設定頁完成連接。");
      const model = payload.model || "gemini-3.1-flash-image";
      const imageSize = model.includes("flash-lite-image") ? "1K" : payload.resolution || "1K";
      const input: Array<Record<string, string>> = [{ type: "text", text: payload.prompt }];
      for (const reference of references) {
        const parsed = parseDataUrl(reference.dataUrl, reference.mimeType);
        input.push({ type: "image", mime_type: parsed.mimeType, data: parsed.data });
      }
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input,
          response_format: {
            type: "image",
            mime_type: "image/jpeg",
            aspect_ratio: payload.aspectRatio || "1:1",
            image_size: imageSize,
          },
        }),
      });
      if (!response.ok) throw new Error(`Gemini：${await readErrorResponse(response)}`);
      const result = await response.json() as unknown;
      const image = findGeminiImage(result);
      if (!image) throw new Error("Gemini 回應中沒有圖片資料。");
      return {
        dataUrl: `data:${image.mimeType};base64,${image.data}`,
        savedPath: savePaintBase64(image.data, image.mimeType),
      };
    } catch (err: any) {
      console.error("[Paint] generate-image error:", err?.message || err);
      throw err;
    }
  });

  schedulerEngine.start();
});

// 雲端 Discord Bot 會持續在線；桌面視窗全關閉時也應真正結束本機程序，
// 避免隱藏在背景的 Discord client 與雲端同時搶同一個 interaction。
app.on("window-all-closed", () => {
  app.quit();
});

// 應用退出前把 token 用量緩存落盤（防抖未觸發的最後一次寫）
app.on("before-quit", () => {
  schedulerEngine?.stop();
  stopOpener();
  flushTokenUsage();
  flushCallUsage();
  void shutdownChannels();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
