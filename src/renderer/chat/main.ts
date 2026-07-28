import "../ui/base.css";
import "./chat.css";
import "../ui/theme";
import { initMarkdownRenderer, initCodeBlockController, renderMarkdown, createStreamingMarkdownSession, getMd } from "./markdown/init";
import type { StreamingMarkdownSession } from "./markdown/init";
import {
  formatChatRelativeTime,
  type ChatSessionMetaUI,
} from "../../shared/chat-ui";
import { normalizeDefaultChatMode, type DefaultChatMode } from "../../shared/preferences";
import { normalizeStyleId, type StyleId } from "../../shared/style-sampling";
import type { ScreenshotInsertPayload } from "../../shared/ipc-channels";
import { userAnnotationNotice } from "../../shared/chat-context";
import { canUseMinimaxStreamingEarly, extractEarlyTtsSegment } from "../../shared/tts-early-playback";
import { getStickerSrcForId } from "./sticker-src";
import { formatAttachmentTagDetail, getAttachmentIcon } from "./attachment-labels";
import { resolveAsset } from "../../shared/renderer-base";
import {
  getAssistantReplyBubbleTexts,
  MAX_ASSISTANT_REPLY_BUBBLES,
  shouldBreakStreamingBubbleAfterChar,
  shouldSegmentAssistantReply,
} from "./message-segmentation";
import { buildDocumentContextLines, processDocumentsWithWait, type RetrievedDocumentChunk } from "./document-processing";
import { decideReloadCurrentSession } from "./session-reload-policy";
import {
  canCancelDocumentIndexStatus,
  getDocumentIndexStatusLabel,
  type DocumentIndexCardStatus,
  type DocumentIndexProgress,
} from "./types";
import { normalizeMusicCardData, type MusicCardData } from "../../shared/music-card";
import { requestTrackPlayback } from "../settings/music-playback";
import type {
  AskClarificationCard,
  AskQuestion,
  AskUserAnswer,
} from "../../shared/ask-clarification";

type Role = "user" | "model";

interface Message {
  id: string;
  role: Role;
  content: string;
  at: number;
  modelContext?: string;
  attachments?: MessageAttachment[];
  sticker?: string | null;
  thinking?: boolean;
  transient?: boolean;
  ttsCacheKey?: string;
  musicCard?: MusicCardData;
}

type MessageAttachment = ImageMessageAttachment | DocumentMessageAttachment;

interface ImageMessageAttachment {
  kind: "image";
  name: string;
  filePath: string;
  mime: string;
  previewUrl?: string;
  caption?: string;
  hasAnnotations?: boolean;
  status: "pending" | "done" | "error";
}

interface DocumentMessageAttachment {
  kind: "document";
  name: string;
  filePath: string;
  status: DocumentIndexCardStatus;
  jobId?: string;
  processedKind?: "text" | "indexed" | "empty" | "unsupported";
  chunks?: number;
  importId?: string;
  reason?: string;
}

interface ModelConfig {
  mode: "auto" | "manual";
  provider: string;
  model: string;
  connected: boolean;
  stickerSize: "small" | "standard" | "large";
}

interface ModelConfigApi {
  get: () => Promise<ModelConfig>;
  onChanged: (callback: (config: ModelConfig) => void) => () => void;
}

interface ChatApi {
    minimize: () => void;
    close: () => void;
    toggleMaximize: () => void;
    isMaximized: () => Promise<boolean>;
    ingestDroppedFiles: (files: File[]) => Promise<Attachment[]>;
    processDocuments: (filePaths: string[], query: string) => Promise<Attachment[]>;
    onDocumentIndexProgress?: (callback: (progress: DocumentIndexProgress) => void) => () => void;
    cancelDocumentIndex: (jobId: string) => Promise<boolean>;
    captionImage: (filePath: string, hasAnnotations?: boolean) => Promise<{ ok: boolean; caption?: string; error?: string }>;
    getImageSendStrategy: () => Promise<{ mode: "direct" | "caption" }>;
    getGeneralSettings?: () => Promise<{ defaultChatMode?: DefaultChatMode; segmentedOutputMode?: "all" | "chat" | "off"; currentStyleId?: StyleId }>;
    getEnabledStickers?: () => Promise<Array<{ id: string; src: string; description?: string }>>;
    startScreenshot: () => Promise<{ ok: boolean; reason?: string }>;
    onScreenshotInsert: (callback: (data: ScreenshotInsertPayload) => void) => () => void;
    saveScreenshotTemp: (base64: string, mime: string) => Promise<{ filePath: string }>;
  }

interface ChatSettingsApi {
  saveGeneral?: (config: { currentStyleId?: StyleId }) => Promise<unknown>;
}

/** AG-UI 事件流 API（window.agui）。 */
const BUDGET_CHARS = 60000;

/* ===== TTS 朗读按钮 SVG =====
   静态版用单条弧线表示喇叭外溢，播放版换成三条音波竖线 + CSS 动画做波浪。
   颜色全部 currentColor，主题色变了会跟着变；不依赖 emoji 字体。 */
const SPEAK_ICON_IDLE = `<svg class="msg__speak-icon msg__speak-icon--idle" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <path d="M3 10v4h4l5 4V6L7 10H3z" fill="currentColor"/>
  <path d="M16 8.5a4 4 0 0 1 0 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
</svg>`;
const SPEAK_ICON_ACTIVE = `<svg class="msg__speak-icon msg__speak-icon--active" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <path d="M3 10v4h4l5 4V6L7 10H3z" fill="currentColor"/>
  <path class="msg__speak-wave msg__speak-wave--1" d="M14 9.5v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path class="msg__speak-wave msg__speak-wave--2" d="M17 7.5v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path class="msg__speak-wave msg__speak-wave--3" d="M20 5.5v13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

/* ===== 复制按钮 SVG =====
   静态版两个重叠方框（标准复制图标），复制成功版换成对勾 + 文案"已复制"。 */
const COPY_ICON_IDLE = `<svg class="msg__copy-icon msg__copy-icon--idle" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/>
  <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const COPY_ICON_DONE = `<svg class="msg__copy-icon msg__copy-icon--done" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

interface AguiApi {
  run: (input: {
    messages: unknown[];
    userTurnId?: string;
    assistantTurnId?: string;
    styleId: StyleId;
    executionMode: "work" | "chat";
    sessionId?: string;
    attachments?: { name: string; text: string }[];
    imageAttachments?: { name: string; filePath: string; mime?: string }[];
  }) => Promise<{ success: boolean; error?: string }>;
  onEvent: (callback: (event: unknown) => void) => () => void;
  cancel: () => Promise<boolean>;
}

interface SchedulerEventsApi {
  onEvent: (callback: (event: unknown) => void) => () => void;
}

/** 用户选择卡片 API（window.choice）。卡片展示走 AGUI_EVENT CUSTOM，resolve 走独立 IPC。 */
interface ChoiceApi {
  resolve: (id: string, value: unknown) => Promise<unknown>;
}

interface ChatMusicApi {
  playTrack: (trackId: string) => Promise<{
    ok: boolean;
    data?: { state: "dispatched" | "web_fallback" | "client_unavailable" | "launch_failed" };
    errorCode?: string;
  }>;
}

/** AG-UI BaseEvent 的最小本地类型（只取我们关心的字段）。 */
interface AguiBaseEvent {
  type: string;
  messageId?: string;
  delta?: string;
  role?: string;
  toolCallId?: string;
  toolCallName?: string;
  content?: string;
  error?: string;
  message?: string;  // RUN_ERROR 的规范字段（upstream RunErrorEvent.message）
  code?: string;     // 结构化错误码（AgentRuntimeError.code）
  stepName?: string;
  runId?: string;
  threadId?: string;
  schedulerRunId?: string;
  schedulerTaskId?: string;
  name?: string;   // CUSTOM 事件的 name
  value?: unknown; // CUSTOM 事件的 value
}

/**
 * 渲染端 Agent 错误。携带结构化 code，用于在 failRun reject 和 catch 之间传递。
 * 与主进程的 AgentRuntimeError 对应，但这里是纯 renderer 类。
 */
class AgentRenderError extends Error {
  constructor(
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "AgentRenderError";
  }
}

/** 根据结构化错误码把 Agent 运行时错误翻译成面向用户的文案。 */
function classifyAgentError(code: string | undefined, message: string): string {
  if (code === "E_AGENT_NO_PROGRESS") return "任务执行未能继续，请重试";
  if (code === "E_AGENT_GRAPH_ITERATION_LIMIT") return "Agent 执行达到循环上限";
  if (code === "E_MODEL_REQUEST_FAILED") return "连接模型失败：" + message;
  if (code === "E_ACTION_GATE_PROTOCOL") return "决策协议解析失败，请重试";
  return message; // 兜底：原样显示
}

/** 文件摄入结果（与 main 侧 file-ingest.ts 的 Attachment 对齐）。 */
type AttachmentKind = "text" | "indexed" | "empty" | "unsupported" | "error" | "image" | "document";

interface Attachment {
  name: string;
  kind: AttachmentKind;
  filePath?: string;
  mime?: string;
  previewUrl?: string;
  caption?: string;
  hasAnnotations?: boolean;
  status?: DocumentIndexCardStatus;
  text?: string;
  chunks?: number;
  importId?: string;
  retrievedChunks?: RetrievedDocumentChunk[];
  reason?: string;
}

/** 任务清单状态（todo_write 工具推过来的）。 */
interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}
interface TodoState {
  todos: TodoItem[];
  updatedAt: number;
}

interface UserApi {
  getAvatar: () => Promise<string | null>;
  onAvatarChanged: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    chat?: ChatApi;
    agui?: AguiApi;
    schedulerEvents?: SchedulerEventsApi;
    modelConfig?: ModelConfigApi;
    choice?: ChoiceApi;
    music?: ChatMusicApi;
    user?: UserApi;
    settings?: ChatSettingsApi;
  }
}

const messagesEl = document.getElementById("messages") as HTMLElement;

// 初始化 Markdown 渲染系统（Shiki 异步启动 + 复制按钮事件委托）
initMarkdownRenderer();
initCodeBlockController(messagesEl);

// ── 历史消息渐进渲染队列 ────────────────────────────────────
// render() 先同步创建纯文本占位，标记 data-md-pending，
// 队列用 requestIdleCallback 渐进升级为 Markdown HTML。

/** 存储所有助手 bubble 的原始 markdown 文本（WeakMap 防 DOM 回收后泄漏） */
const bubbleRawText = new WeakMap<HTMLElement, string>();
/** 向后兼容：pendingMarkdownText 指向同一个 WeakMap */
const pendingMarkdownText = bubbleRawText;

/** 队列状态 */
let renderGeneration = 0;
let historyIdleId: number | null = null;

const HISTORY_MAX_BATCH = 3;
const HISTORY_MIN_REMAINING_MS = 4;

/** 取消当前队列，递增 generation */
function cancelHistoryRender(): void {
  renderGeneration++;
  if (historyIdleId !== null) {
    cancelIdleCallback(historyIdleId);
    historyIdleId = null;
  }
}

/** 调度历史消息渐进渲染（在 render() 后调用） */
function scheduleHistoryRender(): void {
  cancelHistoryRender();
  const gen = renderGeneration;

  const processBatch = (deadline?: IdleDeadline): void => {
    historyIdleId = null;
    if (gen !== renderGeneration) return; // 已被取消

    const pendingBubbles = messagesEl.querySelectorAll<HTMLElement>("[data-md-pending='true']");
    if (pendingBubbles.length === 0) return;

    let processed = 0;
    const hasDeadline = !!deadline;

    for (const bubble of pendingBubbles) {
      if (gen !== renderGeneration) return; // 已被取消
      if (!bubble.isConnected) continue;

      const text = pendingMarkdownText.get(bubble);
      if (text === undefined) {
        bubble.removeAttribute("data-md-pending");
        continue;
      }

      const result = renderMarkdown(text);
      if (result.mode === "html") {
        bubble.innerHTML = result.content;
      } else {
        bubble.textContent = result.content;
      }
      bubble.removeAttribute("data-md-pending");
      pendingMarkdownText.delete(bubble);
      processed++;

      // 时间预算：有 deadline 时检查剩余时间，无 deadline 时按数量限制
      if (processed >= HISTORY_MAX_BATCH) break;
      if (hasDeadline && deadline!.timeRemaining() < HISTORY_MIN_REMAINING_MS) break;
    }

    // 还有 pending，继续调度
    if (gen === renderGeneration && messagesEl.querySelector("[data-md-pending='true']")) {
      historyIdleId = requestIdleCallback(processBatch, { timeout: 200 });
    }
  };

  // requestIdleCallback fallback
  if (typeof requestIdleCallback === "function") {
    historyIdleId = requestIdleCallback(processBatch, { timeout: 200 });
  } else {
    historyIdleId = null;
    setTimeout(() => processBatch(undefined), 0);
  }
}

/**
 * 主题切换时刷新已完成助手消息的 Markdown 渲染（Shiki 主题更新）。
 * 不调用全局 render()，避免销毁流式 session DOM。
 * 流式 session 中的已稳定代码块暂保留旧主题（方案 B），终态自动切换。
 */
function refreshMarkdownTheme(): void {
  // 取消旧队列
  cancelHistoryRender();

  // 找到所有助手消息气泡，标记为 pending 重新渲染
  const assistantBubbles = messagesEl.querySelectorAll<HTMLElement>(".msg--model .msg__bubble");
  for (const bubble of assistantBubbles) {
    const text = bubbleRawText.get(bubble);
    if (text !== undefined && text.trim()) {
      bubble.dataset.mdPending = "true";
    }
  }

  scheduleHistoryRender();
}

// 监听主题切换
window.cyreneTheme?.onChanged(() => {
  refreshMarkdownTheme();
});

const formEl = document.getElementById("composer") as HTMLFormElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const stickerPickerBtn = document.getElementById("sticker-picker-btn") as HTMLButtonElement;
const stickerPicker = document.getElementById("sticker-picker") as HTMLElement;
const stickerPickerGrid = document.getElementById("sticker-picker-grid") as HTMLElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const minBtn = document.getElementById("min-btn") as HTMLButtonElement;
const maxBtn = document.getElementById("max-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const chatHintEl = document.getElementById("chat-hint") as HTMLElement;
const chatStatusBtn = document.getElementById("chat-status-btn") as HTMLButtonElement;
const chatRail = document.getElementById("chat-rail") as HTMLElement | null;
const chatRailNew = document.getElementById("chat-rail-new") as HTMLButtonElement | null;
const chatRailList = document.getElementById("chat-rail-list") as HTMLElement | null;
const chatRailEmpty = document.getElementById("chat-rail-empty") as HTMLElement | null;

// 旧版 localStorage key——首次启动时检测到老数据会迁移到主进程 chats 存储再清掉。
const LEGACY_STORAGE_KEY = "cyrene.chat.history.v1";
/**
 * Avatar source per role. Empty string = use the gradient placeholder
 * baked into the CSS background of `.msg--user .msg__avatar`.
 *
 * Model side: 昔涟的 PNG，由 CSS border-radius: 50% 自动裁圆。
 * User side: 暂留空，等设置页里上传用户头像后再把 user 改成 file:// 或 data: URL。
 */
const AVATAR_SRC: Record<Role, string> = {
  model: resolveAsset("avatars/cyrene-avatar.png"),
  user: "",
};

// Load user avatar from profile and keep it in sync when changed in settings.
async function loadUserAvatar(): Promise<boolean> {
  try {
    const dataUrl = await window.user?.getAvatar();
    if (dataUrl) {
      AVATAR_SRC.user = dataUrl;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

(async () => {
  if (await loadUserAvatar()) {
    render();
  }
})();

window.user?.onAvatarChanged(() => {
  void (async () => {
    if (await loadUserAvatar()) {
      render();
    }
  })();
});

const BUILT_IN_STICKER_SRC: Record<string, string> = {
  playful: "/stickers/playful.png",
  "love-happy": "/stickers/love-happy.png",
  confident: "/stickers/confident.png",
  serious: "/stickers/serious.png",
  calm: "/stickers/calm.png",
  peek: "/stickers/peek.gif",
  "clingy-confused": "/stickers/clingy-confused.gif",
  "love-calm": "/stickers/love-calm.png",
  HI: "/stickers/HI.jpg",
  hello: "/stickers/hello.jpg",
  goodmoring1: "/stickers/goodmoring1.jpg",
  goodnight: "/stickers/goodnight.jpg",
  teatime: "/stickers/teatime.jpg",
  eating: "/stickers/eating.jpg",
  Allset: "/stickers/Allset.jpg",
  OK: "/stickers/OK.jpg",
  copythat: "/stickers/copythat.jpg",
  Thumbsup: "/stickers/Thumbsup.jpg",
  awesome: "/stickers/awesome.jpg",
  sogood: "/stickers/sogood.jpg",
  sonice: "/stickers/sonice.jpg",
  fighting: "/stickers/fighting.jpg",
  hellyeah: "/stickers/hellyeah.jpg",
  Thanks: "/stickers/Thanks.jpg",
  foryou: "/stickers/foryou.jpg",
  blushhard: "/stickers/blushhard.jpg",
  shyshort: "/stickers/shyshort.jpg",
  hmph: "/stickers/hmph.jpg",
  hugtight: "/stickers/hugtight.jpg",
  Airkiss: "/stickers/Airkiss.jpg",
  Gigglelots: "/stickers/Gigglelots.jpg",
  thinking: "/stickers/thinking.jpg",
  putmd: "/stickers/putmd.jpg",
  Whatswrong: "/stickers/Whatswrong.jpg",
  midmeh: "/stickers/midmeh.jpg",
  awkward: "/stickers/awkward.jpg",
  Madnow: "/stickers/Madnow.jpg",
  Hurtcry: "/stickers/Hurtcry.jpg",
  Sobbinghard: "/stickers/Sobbinghard.jpg",
  weeploud: "/stickers/weeploud.jpg",
  PanincCrying: "/stickers/PanincCrying.jpg",
  missme: "/stickers/missme.jpg",
  Free: "/stickers/Free.jpg",
  Dreak: "/stickers/Dreak.jpg",
  outfast: "/stickers/outfast.jpg",
  Vcayover: "/stickers/Vcayover.jpg",
  sleepynow: "/stickers/sleepynow.jpg",
  deadtired: "/stickers/deadtired.jpg",
  sotired: "/stickers/sotired.jpg",
  giveup: "/stickers/giveup.jpg",
  poorwallet: "/stickers/poorwallet.jpg",
  please: "/stickers/please.jpg",
};

function getStickerSrc(id: string): string | undefined {
  const raw = getStickerSrcForId(id, BUILT_IN_STICKER_SRC, enabledStickers);
  if (!raw) return undefined;
  // 内置贴纸路径以 /stickers/ 开头（绝对路径），在 file:// 协议下会解析到磁盘根
  // 用 resolveAsset() 转成正确的 file:// 或 http:// URL
  if (raw.startsWith("/stickers/")) {
    return resolveAsset(raw);
  }
  return raw;
}

// 多会话改造：messages 是当前活跃 session 的消息数组（启动时为空，由 bootstrap 填充）。
// currentSessionId 是当前正在显示的会话 id，所有持久化操作都基于它。
// 启动期间 currentSessionId 为 null，发送按钮通过 sending 标志兜底（bootstrap 极快）。
const messages: Message[] = [];
let currentSessionId: string | null = null;
let sessionTailStart = 0;
let segmentedOutputMode: "all" | "chat" | "off" = "off";
const CHAT_WINDOW_SIZE = 100;
let currentModelConfig: ModelConfig | null = null;

function formatModelHint(config: ModelConfig | null): string {
  if (!config || !config.connected) return "模型未连接";
  return `${config.model} 已连接`;
}

function applyModelConfig(config: ModelConfig | null): void {
  currentModelConfig = config;
  chatHintEl.textContent = formatModelHint(config);
  document.documentElement.dataset.stickerSize = config?.stickerSize ?? "standard";
}

async function refreshModelConfig(): Promise<boolean> {
  try {
    const config = await window.modelConfig?.get();
    applyModelConfig(config ?? null);
    return Boolean(config?.connected);
  } catch (err) {
    console.warn("[Cyrene Chat] model config unavailable:", err);
    applyModelConfig(null);
    return false;
  }
}

async function initModelConfig(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await refreshModelConfig()) break;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  window.modelConfig?.onChanged((config) => applyModelConfig(config));
}

// ── 多会话存储桥接 ───────────────────────────────────────────
// 旧版聊天记录从 localStorage 一次性迁移到主进程 chats 存储，之后整窗口
// 所有读写都走 IPC（window.chatStore）。所有 saveHistory 调用点改成
// saveSession，本质是把 messages 全量回写当前 session 文件。
// 会话元数据类型用 shared 的 ChatSessionMetaUI（跟设置面板共用）。

interface ChatStoreSession {
  id: string;
  title: string;
  identityId: string | null;
  messages: Array<{
    id: string;
    role: Role;
    content: string;
    at: number;
    modelContext?: string;
    attachments?: MessageAttachment[];
    sticker?: string | null;
    ttsCacheKey?: string;
    musicCard?: MusicCardData;
  }>;
  createdAt: number;
  updatedAt: number;
  schemaVersion: 1;
  purpose?: "proactive-chat";
}

interface ChatStoreApi {
  list: () => Promise<ChatSessionMetaUI[]>;
  get: (id: string) => Promise<ChatStoreSession | null>;
  getPage: (id: string, before: number | null, limit: number) => Promise<{ session: Omit<ChatStoreSession, "messages">; messages: ChatStoreSession["messages"]; hasMore: boolean } | null>;
  create: (payload?: { title?: string; identityId?: string | null }) => Promise<ChatStoreSession>;
  append: (id: string, message: unknown) => Promise<ChatStoreSession | null>;
  replaceMessages: (id: string, messages: unknown[]) => Promise<ChatStoreSession | null>;
  replaceTail: (id: string, startIndex: number, messages: unknown[]) => Promise<ChatStoreSession | null>;
  rename: (id: string, title: string) => Promise<ChatStoreSession | null>;
  delete: (id: string) => Promise<boolean>;
  openFolder: () => Promise<boolean>;
  migrateLegacy: (messages: unknown[]) => Promise<ChatStoreSession | null>;
  openInChatWindow: (sessionId: string) => Promise<boolean>;
  setActiveSession: (sessionId: string | null) => Promise<boolean>;
  getActiveSession: () => Promise<string | null>;
  onActiveSessionChanged: (callback: (sessionId: string | null) => void) => () => void;
  onChanged: (callback: () => void) => () => void;
  onSwitchSession: (callback: (sessionId: string) => void) => () => void;
}

declare global {
  interface Window {
    chatStore?: ChatStoreApi;
  }
}

// 把渲染端 Message 数组归一化为后端能持久化的形态：
// - 过滤空 content / 渲染中的 thinking 占位（thinking=true 时通常 content 为空，但保险起见双重过滤）
// - 丢弃仅用于本轮模型调用的 modelContext 与 thinking 等瞬态字段
function toPersistableMessages(arr: Message[]): Array<{
  id: string; role: Role; content: string; at: number; attachments?: MessageAttachment[]; sticker?: StickerId | null; ttsCacheKey?: string; musicCard?: MusicCardData;
}> {
  return arr
    .filter((m) => m && (m.role === "user" || m.role === "model") && !m.thinking && !m.transient && (
      typeof m.content === "string" && m.content.trim()
      || ((m.attachments?.length ?? 0) > 0)
      || Boolean(m.sticker)
      || Boolean(m.musicCard)
    ))
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      at: m.at,
      attachments: m.attachments,
      sticker: m.sticker ?? null,
      ttsCacheKey: m.ttsCacheKey,
      musicCard: m.musicCard,
    }));
}

async function saveSession(): Promise<void> {
  if (!currentSessionId || !window.chatStore) return;
  try {
    await window.chatStore.replaceTail(currentSessionId, sessionTailStart, toPersistableMessages(messages));
  } catch (err) {
    console.warn("[Cyrene Chat] saveSession 失败:", err);
  }
}

// 把 store 里的 ChatStoreSession 装载到当前窗口（替换 messages 数组并 render）。
function loadSessionIntoUI(session: ChatStoreSession): void {
  currentSessionId = session.id;
  seenSessionUpdatedAt.set(session.id, session.updatedAt);
  unreadProactiveSessionIds.delete(session.id);
  messages.length = 0;
  for (const m of session.messages) {
    messages.push({
      id: m.id,
      role: m.role,
      content: m.content,
      at: m.at,
      attachments: m.attachments,
      sticker: m.sticker ?? null,
      ttsCacheKey: m.ttsCacheKey,
      musicCard: m.musicCard,
    });
  }
  // 上报活跃 sessionId（设置面板"删除当前会话"差异化提示用）
  void window.chatStore?.setActiveSession(session.id);
  render();
  // 切换会话后刷新侧栏列表的活跃高亮
  void renderRailList();
}

async function loadSessionTailIntoUI(id: string): Promise<boolean> {
  const page = await window.chatStore?.getPage(id, null, CHAT_WINDOW_SIZE);
  if (!page) return false;
  sessionTailStart = Math.max(0, page.session.messageCount - page.messages.length);
  loadSessionIntoUI({ ...page.session, messages: page.messages });
  return true;
}

async function loadEarlierMessages(): Promise<void> {
  if (!currentSessionId || !window.chatStore || sessionTailStart <= 0) return;
  const beforeHeight = messagesEl.scrollHeight;
  const page = await window.chatStore.getPage(currentSessionId, sessionTailStart, CHAT_WINDOW_SIZE);
  if (!page) return;
  sessionTailStart -= page.messages.length;
  messages.unshift(...page.messages);
  render(true);
  messagesEl.scrollTop = messagesEl.scrollHeight - beforeHeight;
}

// ── 会话侧栏（点左上角 loader 展开）──
// 精简版：+新对话 / 列表点击切换 / 活跃高亮。改名删除留设置面板。
// 渲染逻辑跟 settings.ts 的 renderChatSessions 同源（复用 shared 的格式化函数），
// 但点击行为不同：这里是本地 loadSessionIntoUI，不走跨窗口 IPC，更快。

const unreadProactiveSessionIds = new Set<string>();
const seenSessionUpdatedAt = new Map<string, number>();

async function renderRailList(): Promise<void> {
  if (!chatRailList || !window.chatStore) return;

  let sessions: ChatSessionMetaUI[] = [];
  try {
    sessions = await window.chatStore.list();
  } catch (err) {
    console.warn("[Cyrene Chat] 侧栏加载会话列表失败:", err);
  }

  chatRailList.innerHTML = "";
  if (sessions.length === 0) {
    if (chatRailEmpty) chatRailEmpty.classList.remove("is-hidden");
    return;
  }
  if (chatRailEmpty) chatRailEmpty.classList.add("is-hidden");

  for (const session of sessions) {
    const item = buildRailItem(session);
    chatRailList.appendChild(item);
  }
}

function buildRailItem(session: ChatSessionMetaUI): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "chat__rail-item";
  if (session.id === currentSessionId) li.classList.add("is-active");
  li.dataset.sessionId = session.id;

  const titleEl = document.createElement("div");
  titleEl.className = "chat__rail-title";
  titleEl.textContent = session.title || "新对话";
  if (unreadProactiveSessionIds.has(session.id)) titleEl.textContent = `● ${titleEl.textContent}`;

  const metaEl = document.createElement("div");
  metaEl.className = "chat__rail-meta";

  const timeEl = document.createElement("span");
  timeEl.className = "chat__rail-time";
  timeEl.textContent = formatChatRelativeTime(session.updatedAt);


  metaEl.appendChild(timeEl);

  // 点击列表项 = 本地切换会话（不走跨窗口 IPC，比设置面板还快）
  li.addEventListener("click", async () => {
    if (session.id === currentSessionId) return;
    await loadSessionTailIntoUI(session.id);
  });

  li.appendChild(titleEl);
  li.appendChild(metaEl);
  return li;
}

// loader 按钮 toggle 侧栏显隐
chatStatusBtn?.addEventListener("click", () => {
  if (!chatRail) return;
  chatRail.toggleAttribute("hidden");
  // 首次展开时拉一次列表（后续由 onChanged 持续刷新）
  if (!chatRail.hidden) void renderRailList();
});

// +新对话
chatRailNew?.addEventListener("click", async () => {
  if (!window.chatStore) return;
  try {
    const session = await window.chatStore.create({ identityId: null });
    if (session?.id) {
      const full = await window.chatStore.get(session.id);
      if (full) loadSessionIntoUI(full as ChatStoreSession);
    }
  } catch (err) {
    console.warn("[Cyrene Chat] 新建会话失败:", err);
  }
});

// 一次性迁移：检测老 localStorage 数据 → 包成 session → 删 key。
// 失败/没数据时静默 no-op，不影响后续 bootstrap。
async function maybeMigrateLegacy(): Promise<void> {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return;
    }
    const normalized = (parsed as Message[]).filter(
      (m) => m && (m.role === "user" || m.role === "model") && typeof m.content === "string" && m.content.trim(),
    );
    if (normalized.length === 0) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return;
    }
    await window.chatStore?.migrateLegacy(normalized);
  } catch (err) {
    console.warn("[Cyrene Chat] 旧 localStorage 迁移失败:", err);
  } finally {
    // 不管成功失败都清掉，避免每次启动都尝试迁移
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
}

// 启动流程：迁移老数据 → 决定加载哪个 session → render
async function bootstrap(): Promise<void> {
  if (!window.chatStore) {
    console.warn("[Cyrene Chat] chatStore IPC 未就绪——可能是 preload 未加载");
    render();
    return;
  }

  await maybeMigrateLegacy();

  // 优先级：URL ?sessionId= → 列表最新一条 → 自动建新
  const urlSessionId = new URLSearchParams(window.location.search).get("sessionId");
  let sessionId: string | null = null;

  if (urlSessionId) {
    sessionId = urlSessionId;
  }
  if (!sessionId) {
    const list = await window.chatStore.list();
    if (list.length > 0) {
      sessionId = list[0].id;
    }
  }
  if (!sessionId) {
    sessionId = (await window.chatStore.create({ identityId: null })).id;
  }

  if (!await loadSessionTailIntoUI(sessionId)) {
    const session = await window.chatStore.create({ identityId: null });
    sessionTailStart = 0;
    loadSessionIntoUI(session);
  }
}

function formatTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 渲染 Task Plan 进度卡（只读浮动面板，可拖动）。 */
interface PlanStepSnapshot {
  stepId: string;
  objective: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "superseded";
  failureMessage?: string;
}
interface PlanSnapshot {
  planId: string;
  goal: string;
  planStatus: string;
  steps: PlanStepSnapshot[];
  replanCount: number;
  timestamp: number;
}
const PLAN_CARD_KEY = "cyrene_plan_card_position";
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
let planCardFadeTimer: number | null = null;

function clampPlanCardPosition(x: number, y: number, card: HTMLElement): { x: number; y: number } {
  const chatEl = document.querySelector(".chat") as HTMLElement;
  if (!chatEl) return { x, y };
  const bounds = chatEl.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const maxX = bounds.width - cardRect.width;
  const maxY = bounds.height - cardRect.height;
  return {
    x: Math.max(0, Math.min(x, maxX)),
    y: Math.max(0, Math.min(y, maxY)),
  };
}

function renderPlanCard(snapshot: PlanSnapshot): void {
  const chatEl = document.querySelector(".chat") as HTMLElement;
  if (!chatEl) return;

  let card = document.querySelector(".plan-card") as HTMLElement | null;

  // 首次创建
  if (!card) {
    card = document.createElement("div");
    card.className = "plan-card";
    chatEl.appendChild(card);

    // 恢复位置
    let savedPos: { x: number; y: number } | null = null;
    try { savedPos = JSON.parse(localStorage.getItem(PLAN_CARD_KEY) || "null"); } catch { /* ignore */ }
    const defaultX = chatEl.clientWidth - 340;
    const pos = clampPlanCardPosition(savedPos?.x ?? defaultX, savedPos?.y ?? 60, card);
    card.style.left = pos.x + "px";
    card.style.top = pos.y + "px";

    // 拖动逻辑
    let dragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    card.addEventListener("mousedown", (e) => {
      const header = (e.target as HTMLElement).closest(".plan-card__header");
      if (!header) return;
      dragging = true;
      const rect = card!.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging || !card) return;
      const chatBounds = chatEl.getBoundingClientRect();
      const x = e.clientX - chatBounds.left - dragOffsetX;
      const y = e.clientY - chatBounds.top - dragOffsetY;
      const clamped = clampPlanCardPosition(x, y, card);
      card.style.left = clamped.x + "px";
      card.style.top = clamped.y + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!dragging || !card) return;
      dragging = false;
      try {
        localStorage.setItem(PLAN_CARD_KEY, JSON.stringify({
          x: parseInt(card.style.left) || 0,
          y: parseInt(card.style.top) || 0,
        }));
      } catch { /* ignore */ }
    });

    // 悬停暂停淡出
    card.addEventListener("mouseenter", () => {
      if (planCardFadeTimer) { clearTimeout(planCardFadeTimer); planCardFadeTimer = null; }
      card!.classList.remove("plan-card--fading");
    });
    card.addEventListener("mouseleave", () => {
      startPlanCardFadeIfTerminal(card!);
    });

    // 窗口 resize 时纠正越界
    window.addEventListener("resize", () => {
      if (!card || card.classList.contains("plan-card--fading")) return;
      const clamped = clampPlanCardPosition(
        parseInt(card.style.left) || 0,
        parseInt(card.style.top) || 0,
        card,
      );
      card.style.left = clamped.x + "px";
      card.style.top = clamped.y + "px";
    });
  }

  // 更新内容
  card.classList.remove("plan-card--fading");

  const statusLabels: Record<string, string> = {
    running: "执行中", completed: "完成", failed: "失败", cancelled: "已取消",
    awaiting_user: "等待用户", paused: "已暂停",
  };
  const statusLabel = statusLabels[snapshot.planStatus] ?? snapshot.planStatus;
  const badgeClass = snapshot.planStatus === "running" ? "running"
    : snapshot.planStatus === "completed" ? "completed"
    : snapshot.planStatus === "failed" ? "failed"
    : snapshot.planStatus === "cancelled" ? "cancelled"
    : snapshot.planStatus === "awaiting_user" ? "awaiting_user"
    : "paused";

  const stepIcons: Record<string, string> = {
    pending: "⬜", running: "🔄", completed: "✅",
    failed: "❌", skipped: "⏭️", superseded: "──",
  };

  const stepsHtml = snapshot.steps.map((s) => {
    const icon = stepIcons[s.status] ?? "⬜";
    const failureHtml = s.failureMessage
      ? `<div class="plan-card__step-failure">${escapeHtml(s.failureMessage)}</div>`
      : "";
    return `<div class="plan-card__step plan-card__step--${s.status}">
      <span class="plan-card__step-icon">${icon}</span>
      <span class="plan-card__step-text">${escapeHtml(s.objective)}</span>
    </div>${failureHtml}`;
  }).join("");

  const footerHtml = snapshot.replanCount > 0
    ? `<div class="plan-card__footer">重规划 ${snapshot.replanCount} 次</div>`
    : "";

  card.innerHTML = `
    <div class="plan-card__header">
      <span class="plan-card__icon">📋</span>
      <span class="plan-card__goal">${escapeHtml(snapshot.goal)}</span>
      <span class="plan-card__badge plan-card__badge--${badgeClass}">${statusLabel}</span>
    </div>
    <div class="plan-card__steps">${stepsHtml}</div>
    ${footerHtml}
  `;

  // 终态淡出
  if (TERMINAL_STATUSES.includes(snapshot.planStatus)) {
    startPlanCardFadeIfTerminal(card);
  } else {
    if (planCardFadeTimer) { clearTimeout(planCardFadeTimer); planCardFadeTimer = null; }
  }
}

function startPlanCardFadeIfTerminal(card: HTMLElement): void {
  const snapshot = (card.querySelector(".plan-card__badge")?.textContent ?? "");
  if (!TERMINAL_STATUSES.some(s => {
    const labels: Record<string, string> = { completed: "完成", failed: "失败", cancelled: "已取消" };
    return labels[s] === snapshot;
  })) return;
  if (planCardFadeTimer) clearTimeout(planCardFadeTimer);
  planCardFadeTimer = window.setTimeout(() => {
    card.classList.add("plan-card--fading");
    setTimeout(() => {
      if (card.classList.contains("plan-card--fading")) card.remove();
    }, 400);
  }, 5000);
}

/** 渲染左上角任务进度面板。todos 为空时收起并稍后移除。
 *  面板可收缩/展开：点击 header 或 toggle 按钮切换。 */
function renderTodoPanel(state: TodoState | null): void {
  let panel = document.querySelector(".todo-panel") as HTMLElement | null;

  // 空清单：收起动画后移除
  if (!state || !state.todos || state.todos.length === 0) {
    if (panel) {
      panel.classList.add("empty");
      setTimeout(() => panel?.remove(), 300);
    }
    return;
  }

  // 首次出现：建面板
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "todo-panel";
    document.body.appendChild(panel);
  }
  panel.classList.remove("empty");

  const total = state.todos.length;
  const done = state.todos.filter((t) => t.status === "completed").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const checkIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" style="width:0.75rem;height:0.75rem"><path fill-rule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd"/></svg>`;

  const priorityBadge = (p: string): string => {
    if (p === "high") return `<span class="todo-badge todo-badge--high">高优先级</span>`;
    if (p === "medium") return `<span class="todo-badge todo-badge--medium">中优先级</span>`;
    if (p === "low") return `<span class="todo-badge todo-badge--low">低优先级</span>`;
    return "";
  };

  const statusIcon = (s: string): string => {
    if (s === "completed") return checkIcon;
    if (s === "in_progress") return "●";
    return "";
  };

  // 检查当前是否已收缩（保留状态）
  const wasCollapsed = panel.classList.contains("todo-panel--collapsed");

  panel.innerHTML = `
    <div class="todo-panel__header">
      <div>
        <div class="todo-panel__title">📋 任务进度</div>
        <div class="todo-panel__count">${done}/${total} 已完成</div>
      </div>
      <span class="todo-panel__toggle">${wasCollapsed ? "▸" : "▾"}</span>
    </div>
    <div class="todo-panel__body">
      <hr class="todo-panel__divider" />
      <div class="todo-panel__progress">
        <div class="todo-progress__track"><div class="todo-progress__fill" style="width:${pct}%"></div></div>
        <span class="todo-progress__label">${pct}%</span>
      </div>
      <div class="todo-list">
        ${state.todos.map(t => `
          <div class="todo-item ${t.status}">
            <span class="todo-item__icon">${statusIcon(t.status)}</span>
            <span class="todo-item__text">${escapeHtml(t.content)}</span>
            <span class="todo-item__meta">${priorityBadge(t.priority || "")}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  if (wasCollapsed) panel.classList.add("todo-panel--collapsed");

  // 收缩/展开 toggle
  const togglePanel = () => {
    if (!panel) return;
    const collapsed = panel.classList.toggle("todo-panel--collapsed");
    const toggleBtn = panel.querySelector(".todo-panel__toggle");
    if (toggleBtn) toggleBtn.textContent = collapsed ? "▸" : "▾";
  };

  panel.querySelector(".todo-panel__header")?.addEventListener("click", togglePanel);
  panel.querySelector(".todo-panel__toggle")?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]!));
}

/** 构建用户选择卡片 DOM 元素（歧义消解器），插入聊天流让用户选选项。 */
function buildChoiceCardEl(data: {
  id: string;
  question: string;
  options: Array<{ label: string; value: string; description?: string }>;
  default?: string;
}): HTMLElement {
  const card = document.createElement("div");
  card.className = "choice-card";
  card.dataset.choiceId = data.id;

  // 标题
  const title = document.createElement("div");
  title.className = "choice-card__title";
  title.textContent = data.question;
  card.appendChild(title);

  // 选项列表
  const list = document.createElement("div");
  list.className = "choice-card__list";
  for (const opt of data.options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice-card__option";
    btn.dataset.value = opt.value;

    const labelEl = document.createElement("span");
    labelEl.className = "choice-card__option-label";
    labelEl.textContent = opt.label;
    btn.appendChild(labelEl);

    if (opt.description) {
      const descEl = document.createElement("span");
      descEl.className = "choice-card__option-desc";
      descEl.textContent = opt.description;
      btn.appendChild(descEl);
    }

    btn.addEventListener("click", () => {
      // 标记已选，禁用所有按钮
      card.classList.add("choice-card--resolved");
      card.querySelectorAll<HTMLButtonElement>(".choice-card__option").forEach(b => b.disabled = true);
      btn.classList.add("choice-card__option--selected");
      void window.choice?.resolve(data.id, opt.value);
    });
    list.appendChild(btn);
  }
  card.appendChild(list);

  // 自定义输入
  const customWrap = document.createElement("div");
  customWrap.className = "choice-card__custom";
  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.className = "choice-card__custom-input";
  customInput.placeholder = "或输入自定义要求...";
  customWrap.appendChild(customInput);

  const customBtn = document.createElement("button");
  customBtn.type = "button";
  customBtn.className = "choice-card__custom-btn";
  customBtn.textContent = "确认";
  customBtn.addEventListener("click", () => {
    const val = customInput.value.trim();
    if (!val) return;
    card.classList.add("choice-card--resolved");
    card.querySelectorAll<HTMLButtonElement>(".choice-card__option").forEach(b => b.disabled = true);
    customInput.disabled = true;
    customBtn.disabled = true;
    void window.choice?.resolve(data.id, val);
  });
  customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); customBtn.click(); }
  });
  customWrap.appendChild(customBtn);
  card.appendChild(customWrap);

  return card;
}

function isAskClarificationCard(value: unknown): value is AskClarificationCard & { id: string } {
  return Boolean(
    value
    && typeof value === "object"
    && "id" in value
    && "intro" in value
    && "questions" in value
    && Array.isArray((value as { questions?: unknown }).questions),
  );
}

/** Ask Soul 多字段澄清卡片。按钮只负责选择，统一由底部确认按钮结构化提交。 */
function buildAskClarificationCardEl(
  data: AskClarificationCard & { id: string },
): HTMLElement {
  const card = document.createElement("div");
  card.className = "choice-card choice-card--structured";
  card.dataset.choiceId = data.id;

  const intro = document.createElement("div");
  intro.className = "choice-card__title";
  intro.textContent = data.intro;
  card.appendChild(intro);

  const questionStates = new Map<string, {
    question: AskQuestion;
    selected: Set<string>;
    customInput?: HTMLInputElement;
    section: HTMLElement;
  }>();

  for (const question of data.questions.slice(0, 3)) {
    const section = document.createElement("section");
    section.className = "choice-card__question";
    const prompt = document.createElement("div");
    prompt.className = "choice-card__question-title";
    prompt.textContent = question.question;
    section.appendChild(prompt);
    const selected = new Set<string>();
    const state: {
      question: AskQuestion;
      selected: Set<string>;
      customInput?: HTMLInputElement;
      section: HTMLElement;
    } = { question, selected, section };

    if (question.type === "text") {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "choice-card__custom-input";
      input.placeholder = question.freeTextPlaceholder || "请填写你的具体要求";
      state.customInput = input;
      section.appendChild(input);
    } else {
      const list = document.createElement("div");
      list.className = "choice-card__list";
      for (const option of question.options.slice(0, 4)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "choice-card__option";
        button.dataset.value = option.value;
        const label = document.createElement("span");
        label.className = "choice-card__option-label";
        label.textContent = option.label;
        button.appendChild(label);
        if (option.description) {
          const description = document.createElement("span");
          description.className = "choice-card__option-desc";
          description.textContent = option.description;
          button.appendChild(description);
        }
        button.addEventListener("click", () => {
          section.classList.remove("choice-card__question--invalid");
          if (question.type === "single_select") {
            selected.clear();
            list.querySelectorAll(".choice-card__option").forEach((item) => {
              item.classList.remove("choice-card__option--selected");
            });
          }
          if (question.type === "multi_select" && selected.has(option.value)) {
            selected.delete(option.value);
            button.classList.remove("choice-card__option--selected");
          } else {
            selected.add(option.value);
            button.classList.add("choice-card__option--selected");
          }
          if (option.value === "__custom__" && state.customInput) {
            state.customInput.hidden = false;
            state.customInput.focus();
          } else if (question.type === "single_select" && state.customInput) {
            state.customInput.hidden = true;
            state.customInput.value = "";
          }
        });
        list.appendChild(button);
      }
      section.appendChild(list);
      if (question.options.some((option) => option.value === "__custom__")) {
        const input = document.createElement("input");
        input.type = "text";
        input.hidden = true;
        input.className = "choice-card__custom-input choice-card__custom-input--standalone";
        input.placeholder = question.freeTextPlaceholder || "填写其他选择";
        state.customInput = input;
        section.appendChild(input);
      }
    }
    questionStates.set(question.field, state);
    card.appendChild(section);
  }

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "choice-card__custom-btn choice-card__submit";
  submit.textContent = "确认并继续";
  submit.addEventListener("click", () => {
    const answers: AskUserAnswer["answers"] = [];
    let firstInvalid: HTMLElement | undefined;
    for (const [field, state] of questionStates) {
      state.section.classList.remove("choice-card__question--invalid");
      const customText = state.customInput?.value.trim();
      const selectedValues = [...state.selected].filter((value) => value !== "__custom__");
      const usesCustom = state.question.type === "text" || state.selected.has("__custom__");
      if ((usesCustom && !customText) || (!usesCustom && selectedValues.length === 0)) {
        state.section.classList.add("choice-card__question--invalid");
        firstInvalid ??= state.section;
        continue;
      }
      answers.push({
        field,
        ...(selectedValues.length ? { selectedValues } : {}),
        ...(usesCustom && customText ? { customText } : {}),
      });
    }
    if (firstInvalid) {
      firstInvalid.querySelector<HTMLElement>("input,button")?.focus();
      return;
    }
    card.classList.add("choice-card--resolved");
    card.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = true;
    });
    card.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
      input.disabled = true;
    });
    void window.choice?.resolve(data.id, {
      requestId: data.id,
      answers,
    } satisfies AskUserAnswer);
  });
  card.appendChild(submit);
  return card;
}

/** 构建权限审批卡片 DOM 元素（per-action 档位下工具调用前弹出）。 */
function buildApprovalCardEl(req: {
  id: string;
  toolId: string;
  toolName: string;
  toolDescription: string;
  args: Record<string, unknown>;
  risk: string;
  timeoutMs: number;
}): HTMLElement {
  const card = document.createElement("div");
  card.className = "approval-card";
  card.dataset.approvalId = req.id;

  // 标题（带工具名 + 风险标签）
  const title = document.createElement("div");
  title.className = "approval-card__title";
  const toolSpan = document.createElement("span");
  toolSpan.className = "approval-card__tool";
  toolSpan.textContent = req.toolName || req.toolId;
  const riskBadge = document.createElement("span");
  riskBadge.className = `approval-card__risk approval-card__risk--${req.risk}`;
  riskBadge.textContent = req.risk;
  title.appendChild(toolSpan);
  title.appendChild(riskBadge);
  card.appendChild(title);

  // 描述
  if (req.toolDescription) {
    const desc = document.createElement("div");
    desc.className = "approval-card__desc";
    desc.textContent = req.toolDescription;
    card.appendChild(desc);
  }

  // 参数摘要（key: value，每行一个，限 5 行防爆窗）
  const argsEntries = Object.entries(req.args || {});
  if (argsEntries.length > 0) {
    const argsBlock = document.createElement("div");
    argsBlock.className = "approval-card__args";
    const visible = argsEntries.slice(0, 5);
    for (const [k, v] of visible) {
      const row = document.createElement("div");
      row.className = "approval-card__args-row";
      const keySpan = document.createElement("span");
      keySpan.className = "approval-card__args-key";
      keySpan.textContent = k + ":";
      const valSpan = document.createElement("span");
      valSpan.className = "approval-card__args-val";
      valSpan.textContent = JSON.stringify(v);
      row.appendChild(keySpan);
      row.appendChild(valSpan);
      argsBlock.appendChild(row);
    }
    if (argsEntries.length > 5) {
      const more = document.createElement("div");
      more.className = "approval-card__args-more";
      more.textContent = `…还有 ${argsEntries.length - 5} 个参数`;
      argsBlock.appendChild(more);
    }
    card.appendChild(argsBlock);
  }

  // 按钮行
  const actions = document.createElement("div");
  actions.className = "approval-card__actions";
  const denyBtn = document.createElement("button");
  denyBtn.type = "button";
  denyBtn.className = "approval-card__btn approval-card__btn--deny";
  denyBtn.textContent = "拒绝";
  const allowBtn = document.createElement("button");
  allowBtn.type = "button";
  allowBtn.className = "approval-card__btn approval-card__btn--allow";
  allowBtn.textContent = "允许";
  actions.appendChild(denyBtn);
  actions.appendChild(allowBtn);
  card.appendChild(actions);

  // 提示行（timeoutMs/1000 秒超时）
  const timeoutSecond = Math.floor(req.timeoutMs / 1000);
  const note = document.createElement("div");
  note.className = "approval-card__note";
  note.textContent = `${timeoutSecond} 秒未操作自动拒绝`;
  card.appendChild(note);

  // 倒计时更新（每秒刷新）
  let remaining = timeoutSecond;
  const tick = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      note.textContent = "已超时，自动拒绝";
      clearInterval(tick);
      return;
    }
    note.textContent = `${remaining} 秒后自动拒绝`;
  }, 1000);

  const resolve = (allowed: boolean) => {
    clearInterval(tick);
    if (!card.isConnected) return;
    card.classList.add(allowed ? "approval-card--allowed" : "approval-card--denied");
    denyBtn.disabled = true;
    allowBtn.disabled = true;
    note.textContent = allowed ? "已允许" : "已拒绝";
    void window.settings?.resolvePermissionApproval?.(req.id, allowed);
  };

  denyBtn.addEventListener("click", () => resolve(false));
  allowBtn.addEventListener("click", () => resolve(true));

  return card;
}

/** 构建天气卡片 DOM 元素（不插入，由调用方决定位置）。 */
function buildWeatherCardEl(data: Record<string, unknown>): HTMLElement {
  const card = document.createElement("div");
  card.className = "weather-card";

  const now = new Date();
  const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 周${"日一二三四五六"[now.getDay()]}`;
  const timeStr = formatTime(Date.now());

  const temp = Number(data.temp ?? 0);
  const feelsLike = Number(data.feelsLike ?? temp);
  const humidity = Number(data.humidity ?? 0);
  const precip = Number(data.precip ?? 0);
  const pressure = Number(data.pressure ?? 0);
  const icon = escapeHtml(String(data.icon ?? "🌤️"));
  const windDir = escapeHtml(String(data.windDir ?? ""));
  const windScale = escapeHtml(String(data.windScale ?? ""));
  const visibility = data.visibility != null ? `${data.visibility}km` : "-";
  const uv = escapeHtml(String(data.uv ?? "-"));
  const aqi = data.aqi != null ? Number(data.aqi) : null;
  const aqiText = escapeHtml(String(data.aqiText ?? ""));
  const kaomoji = aqi != null ? escapeHtml(aqiKaomojiText(Number(aqi))) : "";
  const city = escapeHtml(String(data.city ?? ""));
  const adm = escapeHtml(String(data.adm ?? ""));
  const desc = escapeHtml(String(data.text ?? ""));
  const source = escapeHtml(String(data.source ?? ""));

  card.innerHTML = `
    <div class="w-header">
      <div class="w-datetime"><span class="w-date">${dateStr}</span><span class="w-time">${timeStr} 更新</span></div>
      <div class="w-loc"><span class="w-city">${city}</span><span class="w-adm">${adm}</span></div>
    </div>
    <div class="w-main">
      <div class="w-icon-box"><span class="w-icon">${icon}</span><span class="w-desc">${desc}</span></div>
      <div class="w-temp-box">
        <div class="w-temp">${temp}<span class="w-deg">°</span></div>
        ${data.hi != null ? `<div class="w-hilo"><span class="w-hi">↑${data.hi}°</span><span class="w-sep">|</span><span class="w-lo">↓${data.lo}°</span></div>` : ""}
      </div>
    </div>
    <div class="w-feels">体感 ${feelsLike}°C</div>
    <div class="w-quick">
      <div class="w-qitem"><div class="w-qicon">💧</div><div class="w-qlabel">湿度</div><div class="w-qvalue">${humidity}%</div></div>
      <div class="w-qitem"><div class="w-qicon">💨</div><div class="w-qlabel">风力</div><div class="w-qvalue">${windScale}</div></div>
      <div class="w-qitem"><div class="w-qicon">🌧️</div><div class="w-qlabel">降水</div><div class="w-qvalue">${precip}mm</div></div>
      <div class="w-qitem"><div class="w-qicon"><svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true"><title>气压</title><path d="M4 42H44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><rect x="8" y="28" width="6" height="14" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><rect x="21" y="18" width="6" height="24" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><rect x="34" y="6" width="6" height="36" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg></div><div class="w-qlabel">气压</div><div class="w-qvalue">${pressure || "-"}</div></div>
    </div>
    <button class="w-expand" type="button">查看更多 <span class="w-arrow">▼</span></button>
    <div class="w-details">
      <div class="w-detail-grid">
        <div class="w-ditem"><span class="w-dicon">🌡️</span><div><div class="w-dlabel">体感温度</div><div class="w-dvalue">${feelsLike}°C</div></div></div>
        <div class="w-ditem"><span class="w-dicon">💨</span><div><div class="w-dlabel">风向风力</div><div class="w-dvalue">${windDir} ${windScale}</div></div></div>
        <div class="w-ditem"><span class="w-dicon">🔆</span><div><div class="w-dlabel">紫外线</div><div class="w-dvalue">${uv}</div></div></div>
        <div class="w-ditem"><span class="w-dicon">👁️</span><div><div class="w-dlabel">能见度</div><div class="w-dvalue">${visibility}</div></div></div>
        ${aqi != null ? `<div class="w-ditem"><span class="w-dicon">🌿</span><div><div class="w-dlabel">空气质量</div><div class="w-dvalue">${aqi} ${aqiText} <span class="w-kaomoji">${kaomoji}</span></div></div></div>` : ""}
      </div>
    </div>
    <div class="w-source"><span>${icon} ${source}</span><span>${timeStr} 更新</span></div>
  `;

  // 展开按钮点击切换
  const expandBtn = card.querySelector(".w-expand") as HTMLButtonElement | null;
  if (expandBtn) {
    expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      card.classList.toggle("expanded");
    });
  }

  return card;
}

function buildMusicCardEl(data: MusicCardData): HTMLElement {
  const card = document.createElement("div");
  card.className = "music-agui-card";

  const header = document.createElement("div");
  header.className = "music-agui-card__header";
  const title = document.createElement("strong");
  title.textContent = data.source === "daily_recommendation" ? "今日推荐" : "歌曲候选";
  const badge = document.createElement("span");
  badge.textContent = "网易云音乐";
  header.append(title, badge);
  card.appendChild(header);

  data.tracks.forEach((track, index) => {
    const row = document.createElement("div");
    row.className = "music-agui-card__track";

    const order = document.createElement("span");
    order.className = "music-agui-card__order";
    order.textContent = String(index + 1);
    const meta = document.createElement("div");
    meta.className = "music-agui-card__meta";
    const name = document.createElement("strong");
    name.textContent = track.name;
    const detail = document.createElement("span");
    detail.textContent = [track.artists.join(" / "), track.album].filter(Boolean).join(" · ");
    meta.append(name, detail);

    const play = document.createElement("button");
    play.type = "button";
    play.className = "music-agui-card__play";
    play.textContent = "播放";
    play.setAttribute("aria-label", `播放 ${track.name}`);
    play.addEventListener("click", async () => {
      if (!window.music) return;
      play.disabled = true;
      const original = play.textContent;
      try {
        const feedback = await requestTrackPlayback(window.music, track);
        play.textContent = feedback.kind === "ok" ? "已发送" : "不可用";
        play.title = feedback.message;
      } catch (err) {
        play.textContent = "失败";
        play.title = err instanceof Error ? err.message : String(err);
      } finally {
        window.setTimeout(() => {
          play.disabled = false;
          play.textContent = original;
        }, 1800);
      }
    });

    row.append(order, meta, play);
    card.appendChild(row);
  });
  return card;
}

/** AQI → 颜文字。 */
function aqiKaomojiText(aqi: number): string {
  if (aqi <= 50) return "(◕‿◕)";
  if (aqi <= 100) return "(´ー`)";
  if (aqi <= 150) return "(´-ω-`)";
  if (aqi <= 200) return "(；´д`)";
  return "(╥﹏╥)";
}

/**
 * Fill the avatar slot for a given role.
 * - model role: insert an <img> with the configured PNG (auto-cropped to
 *   a circle by the .msg__avatar-img CSS rule).
 * - user role (empty src): leave the slot empty so the CSS gradient
 *   placeholder shows through.
 */
function setAvatar(slot: HTMLElement, role: Role): void {
  slot.replaceChildren();
  const src = AVATAR_SRC[role];
  if (!src) return;
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  img.draggable = false;
  img.className = "msg__avatar-img";
  slot.appendChild(img);
}

function createMessageBubble(text?: string): HTMLElement {
  const item = document.createElement("div");
  item.className = "msg__bubble";
  item.hidden = false;
  if (text) item.textContent = text;
  return item;
}

function getLastBubbleForMessage(messageId: string): HTMLElement | null {
  const row = messagesEl.querySelector(`[data-msg-id="${messageId}"]`);
  if (!row) return null;
  const bubbles = row.querySelectorAll<HTMLElement>(".msg__bubble");
  return bubbles.length > 0 ? bubbles[bubbles.length - 1] : null;
}

function appendBubbleForMessage(messageId: string): HTMLElement | null {
  const row = messagesEl.querySelector(`[data-msg-id="${messageId}"]`);
  const body = row?.querySelector(".msg__body");
  if (!body) return null;
  const bubble = createMessageBubble();
  bubble.hidden = true;
  body.appendChild(bubble);
  return bubble;
}

function renderMessageAttachments(body: HTMLElement, attachments: MessageAttachment[] | undefined): void {
  if (!attachments || attachments.length === 0) return;
  const list = document.createElement("div");
  list.className = "msg__attachments";
  for (const att of attachments) {
    if (att.kind === "image") {
      const card = document.createElement("div");
      card.className = "msg__image-card";
      const preview = document.createElement("div");
      preview.className = "msg__image-preview";
      if (att.previewUrl) {
        const img = document.createElement("img");
        img.src = att.previewUrl;
        img.alt = att.name;
        img.draggable = false;
        img.addEventListener("load", () => {
          messagesEl.scrollTop = messagesEl.scrollHeight;
        });
        img.addEventListener("error", () => {
          preview.classList.add("is-error");
          preview.textContent = "图片无法预览";
        });
        preview.appendChild(img);
      } else {
        preview.classList.add("is-error");
        preview.textContent = "图片无法预览";
      }
      const name = document.createElement("div");
      name.className = "msg__image-name";
      name.textContent = att.name;
      card.appendChild(preview);
      card.appendChild(name);
      list.appendChild(card);
    } else if (att.kind === "document") {
      const card = document.createElement("div");
      card.className = `msg__document-card msg__document-card--${att.status}`;
      const icon = document.createElement("div");
      icon.className = "msg__document-icon";
      icon.textContent = "📄";
      const meta = document.createElement("div");
      meta.className = "msg__document-meta";
      const name = document.createElement("div");
      name.className = "msg__document-name";
      name.textContent = att.name;
      const status = document.createElement("div");
      status.className = "msg__document-status";
      status.textContent = att.status === "done"
        ? (att.processedKind === "indexed" ? `已索引 ${att.chunks ?? 0} 段` : "已处理")
        : getDocumentIndexStatusLabel(att.status);
      meta.appendChild(name);
      meta.appendChild(status);
      card.appendChild(icon);
      card.appendChild(meta);
      if (canCancelDocumentIndexStatus(att.status) && att.jobId) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "msg__document-cancel";
        cancel.textContent = "×";
        cancel.title = "取消处理";
        cancel.setAttribute("aria-label", "取消处理");
        cancel.addEventListener("click", () => {
          void window.chat?.cancelDocumentIndex(att.jobId!);
        });
        card.appendChild(cancel);
      }
      list.appendChild(card);
    } else {
      continue;
    }
  }
  if (list.childElementCount > 0) body.appendChild(list);
}

function updateDocumentAttachmentProgress(progress: DocumentIndexProgress): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const attachment = messages[index].attachments?.find((item): item is DocumentMessageAttachment =>
      item.kind === "document"
      && item.filePath === progress.filePath
      && (!item.jobId || item.jobId === progress.jobId)
    );
    if (!attachment) continue;
    attachment.jobId = progress.jobId;
    attachment.status = progress.status;
    attachment.reason = progress.reason;
    if (typeof progress.totalChunks === "number") attachment.chunks = progress.totalChunks;
    return;
  }
}

window.chat?.onDocumentIndexProgress?.((progress) => {
  updateDocumentAttachmentProgress(progress);
  render();
});

let transientStatusEl: HTMLElement | null = null;

function showTransientStatus(text: string): void {
  if (!transientStatusEl) {
    transientStatusEl = document.createElement("div");
    transientStatusEl.className = "chat-transient-status";
    const dots = document.createElement("span");
    dots.className = "chat-transient-status__dots";
    for (let i = 0; i < 3; i += 1) {
      const dot = document.createElement("span");
      dot.className = "thinking-dot";
      dots.appendChild(dot);
    }
    const label = document.createElement("span");
    label.className = "chat-transient-status__text";
    transientStatusEl.appendChild(dots);
    transientStatusEl.appendChild(label);
    messagesEl.appendChild(transientStatusEl);
  }
  const label = transientStatusEl.querySelector(".chat-transient-status__text");
  if (label) label.textContent = text;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideTransientStatus(): void {
  transientStatusEl?.remove();
  transientStatusEl = null;
}

function render(preserveScroll = false): void {
  // 空态：当前会话还没有消息时（新建/全清）显示"昔涟期待与你聊天哦 ✨"占位
  // thinking 状态（昔涟主动开场/流式回复中）也算有消息，胶囊应立即消失
  const emptyEl = document.getElementById("chat-empty");
  const hasMessages = messages.some((m) =>
    m.content.trim()
    || m.thinking
    || ((m.attachments?.length ?? 0) > 0)
    || Boolean(m.sticker)
    || Boolean(m.musicCard)
  );
  if (emptyEl) emptyEl.toggleAttribute("hidden", hasMessages);

  messagesEl.replaceChildren();
  if (sessionTailStart > 0) {
    const loadEarlier = document.createElement("button");
    loadEarlier.type = "button";
    loadEarlier.className = "chat__load-earlier";
    loadEarlier.textContent = "加载更早消息";
    loadEarlier.addEventListener("click", () => void loadEarlierMessages());
    messagesEl.appendChild(loadEarlier);
  }
  for (const m of messages) {
    const row = document.createElement("div");
    row.className = `msg msg--${m.role}`;
    row.dataset.msgId = m.id;

    const avatar = document.createElement("div");
    avatar.className = "msg__avatar";
    avatar.setAttribute("aria-hidden", "true");
    setAvatar(avatar, m.role);

    const body = document.createElement("div");
    body.className = "msg__body";

    const bubbles: HTMLElement[] = [];
    const bubble = createMessageBubble();
    if (m.thinking) {
      bubble.classList.add("msg__bubble--thinking");
      const dot1 = document.createElement("span");
      dot1.className = "thinking-dot";
      const dot2 = document.createElement("span");
      dot2.className = "thinking-dot";
      const dot3 = document.createElement("span");
      dot3.className = "thinking-dot";
      bubble.appendChild(dot1);
      bubble.appendChild(dot2);
      bubble.appendChild(dot3);
      bubbles.push(bubble);
    } else if (m.role === "user") {
      // 用户消息：去掉 [sticker:xxx] 标记后显示纯文字
      const cleanText = m.content.replace(/\[sticker:[^\]]+\]/g, "").trim();
      if (cleanText) bubble.textContent = cleanText;
      else bubble.hidden = true; // 纯表情包消息不显示气泡
      if (!bubble.hidden) bubbles.push(bubble);
    } else {
      const currentMode = isChatMode() ? "chat" : "work";
      const segments = getAssistantReplyBubbleTexts(m.content, currentMode, segmentedOutputMode, {
        preserveEmpty: !!m.transient,
      });
      for (const segment of segments) {
        const text = segment.trim();
        if (text || m.transient) {
          const bubble = createMessageBubble();
          if (m.transient) {
            // 流式期：纯文本，由 StreamingMarkdownSession 管理后续 DOM
            bubble.textContent = text;
          } else {
            // 终态：先放纯文本占位，标记为 pending，由历史渐进队列升级为 Markdown
            bubble.textContent = text;
            bubble.dataset.mdPending = "true";
          }
          bubbleRawText.set(bubble, text);
          bubbles.push(bubble);
        }
      }
    }

    const time = document.createElement("div");
    time.className = "msg__time";
    time.textContent = formatTime(m.at);

    for (const item of bubbles) body.appendChild(item);
    if (m.role === "user") renderMessageAttachments(body, m.attachments);

    if (m.sticker) {
      const stickerSrc = getStickerSrc(m.sticker);
      if (stickerSrc) {
        const sticker = document.createElement("img");
        sticker.className = "msg__sticker";
        sticker.src = stickerSrc;
        sticker.alt = m.role === "user" ? "用户表情" : "昔涟表情";
        sticker.draggable = false;
        // <img> 高度异步加载，render() 末尾的滚动会在图片撑开前就执行，
        // 导致 sticker 底部被输入框挡住。加载完成后再补一次滚到底。
        sticker.addEventListener("load", () => {
          messagesEl.scrollTop = messagesEl.scrollHeight;
        });
        body.appendChild(sticker);
      }
    }

    if (m.musicCard) body.appendChild(buildMusicCardEl(m.musicCard));

    // actions 行：喇叭 / 复制 / 时间三个控件水平排在气泡下方。
    // 流式中的 transient 消息会继续追加新气泡；此时先隐藏 actions，
    // 避免时间戳被夹在第一段气泡和后续气泡之间。
    const actions = document.createElement("div");
    actions.className = "msg__actions";

    let hasActionItem = false;

    // model 消息加 SVG 朗读按钮（thinking 中的不显示）
    if (!m.transient && m.role === "model" && !m.thinking && m.content.trim()) {
      const speakBtn = document.createElement("button");
      speakBtn.type = "button";
      speakBtn.className = "msg__speak";
      speakBtn.title = "朗读";
      speakBtn.setAttribute("aria-label", "朗读这条消息");
      // 用 SVG 而不是 emoji，颜色随主题走，播放时切到波形版
      speakBtn.innerHTML = SPEAK_ICON_IDLE;
      // 点击逻辑：正在播放则停止，否则开始朗读（避免重叠）
      speakBtn.addEventListener("click", () => {
        console.log("[TTS] 喇叭点击, currentTtsAudio=", currentTtsAudio ? "有" : "无");
        if (currentSpeakingMsgId === m.id) {
          // 当前消息正在播放 → 停止并复位 UI
          stopCurrentTts();
          setSpeakingMsgId(null);
        } else {
          void speakMessage(m);
        }
      });
      actions.appendChild(speakBtn);
      hasActionItem = true;
    }

    // 复制按钮：user / model 都有，thinking / 空内容 / 纯表情包跳过
    //   user 复制时去掉 [sticker:xxx] 标记，model 直接复制 content
    if (!m.transient && !m.thinking && m.content.trim()) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "msg__copy";
      copyBtn.title = "复制";
      copyBtn.setAttribute("aria-label", "复制这条消息");
      copyBtn.innerHTML = COPY_ICON_IDLE;
      copyBtn.addEventListener("click", () => {
        const text = m.role === "user"
          ? m.content.replace(/\[sticker:[^\]]+\]/g, "").trim()
          : m.content;
        if (!text) return;
        void copyTextToClipboard(text).then((ok) => {
          if (!ok) return;
          // 视觉反馈：切到对勾 + 文案"已复制"，1.5s 后复原
          copyBtn.classList.add("is-copied");
          copyBtn.innerHTML = COPY_ICON_DONE;
          const label = document.createElement("span");
          label.className = "msg__copy-label";
          label.textContent = "已复制";
          copyBtn.appendChild(label);
          window.setTimeout(() => {
            copyBtn.classList.remove("is-copied");
            copyBtn.innerHTML = COPY_ICON_IDLE;
          }, 1500);
        });
      });
      actions.appendChild(copyBtn);
      hasActionItem = true;
    }

    // 时间戳总是显示；哪怕只有一个时间，也用 actions 行保持视觉一致。
    // 但流式 transient 阶段先不显示，等最终 render 后再出现到整条消息底部。
    if (!m.transient) {
      actions.appendChild(time);
      hasActionItem = true;
    }

    if (hasActionItem) body.appendChild(actions);

    row.appendChild(avatar);
    row.appendChild(body);
    messagesEl.appendChild(row);
  }
  if (!preserveScroll) messagesEl.scrollTop = messagesEl.scrollHeight;

  // 历史消息渐进渲染：纯文本占位 -> Markdown HTML
  scheduleHistoryRender();
}

let schedulerEventsOff: (() => void) | null = null;
const activeAguiOffs = new Set<() => void>();

function registerAguiListener(callback: (event: unknown) => void): () => void {
  const off = window.agui!.onEvent(callback);
  const release = () => {
    if (!activeAguiOffs.delete(release)) return;
    off();
  };
  activeAguiOffs.add(release);
  return release;
}

function installSchedulerEventListener(): void {
  if (!window.schedulerEvents?.onEvent) return;

  interface SchedulerStreamState {
    msgId: string;
    content: string;
    toolLines: string[];
  }

  const streams = new Map<string, SchedulerStreamState>();

  const runKeyOf = (event: AguiBaseEvent): string => {
    if (event.schedulerRunId) return event.schedulerRunId;
    if (event.runId) return event.runId;
    if (event.threadId) return event.threadId;
    return "scheduler-default";
  };

  const renderState = (state: SchedulerStreamState): void => {
    const msg = messages.find(m => m.id === state.msgId);
    if (!msg) return;
    msg.thinking = false;
    msg.content = state.content || state.toolLines.join("\n") || "定时任务运行中…";
    render();
  };

  schedulerEventsOff?.();
  schedulerEventsOff = window.schedulerEvents.onEvent((rawEvent) => {
    const event = rawEvent as AguiBaseEvent;
    if (event.type === "CUSTOM" && event.name === "scheduler.started") {
      const value = event.value as { taskId?: string; title?: string; firedAt?: string; runId?: string } | undefined;
      const runKey = event.schedulerRunId ?? value?.runId ?? `scheduler-${Date.now()}`;
      messages.push({
        id: `scheduler-system-${runKey}`,
        role: "model",
        content: `⏰ 定时任务「${value?.title ?? "未命名任务"}」已触发`,
        at: Date.now(),
      });
      const msgId = `scheduler-model-${runKey}`;
      streams.set(runKey, { msgId, content: "", toolLines: [] });
      messages.push({ id: msgId, role: "model", content: "", at: Date.now(), thinking: true });
      render();
      void saveSession();
      return;
    }

    const runKey = runKeyOf(event);
    const state = streams.get(runKey);
    if (!state) return;
    const msg = messages.find(m => m.id === state.msgId);
    if (!msg) return;

    if (event.type === "TOOL_CALL_START") {
      state.toolLines.push(`🔧 调用中：${event.toolCallName ?? "工具"}`);
      renderState(state);
    } else if (event.type === "TOOL_CALL_RESULT") {
      const preview = (event.content ?? "").slice(0, 240);
      state.toolLines.push(`✅ 工具结果：${preview || "完成"}`);
      renderState(state);
    } else if (event.type === "TOOL_CALL_END") {
      state.toolLines.push("✅ 工具调用完成");
      renderState(state);
    } else if (event.type === "TEXT_MESSAGE_START") {
      msg.thinking = false;
      state.content = "";
      renderState(state);
    } else if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) {
      state.content += event.delta;
      renderState(state);
    } else if (event.type === "RUN_FINISHED") {
      renderState(state);
      void saveSession();
      streams.delete(runKey);
    } else if (event.type === "RUN_ERROR") {
      msg.thinking = false;
      // 优先读 upstream 规范的 `message` 字段，兜底兼容旧的 `error`/`content`
      const rawMessage = event.message ?? event.error ?? event.content ?? "未知错误";
      msg.content = "定时任务执行失败：" + classifyAgentError(event.code, rawMessage);
      render();
      void saveSession();
      streams.delete(runKey);
    }
  });
}

// ── TTS 朗读 ──
// 从主进程加载 TTS 配置，按当前引擎调用合成并播放。
// 自动朗读（回复完成后触发）和手动 🔊 按钮共用此函数。

const TEXT_MODE_MOUTH_DURATION_MS = 8000;
const AUDIO_MOUTH_DELAY_MS = 800;

interface TtsSettings {
  ttsEngine: string;
  ttsAutoRead: boolean;
  ttsSpeed: number;
  ttsVolume: number;
  // MiniMax
  ttsMinimaxKey: string;
  ttsMinimaxVoiceId: string;
  ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  // GPT-SoVITS
  ttsGptsovitsBaseUrl: string;
  ttsGptsovitsRefAudioPath: string;
  ttsGptsovitsPromptText: string;
  ttsGptsovitsFormat: "wav" | "mp3";
  // 自定义云端
  ttsCustomCloudEndpointUrl: string;
  ttsCustomCloudApiKey: string;
  ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3";
  ttsCustomCloudTimeoutMs: number;
  // 小米 MiMo
  ttsMimoKey: string;
  ttsMimoVoiceAudioPath: string;
  ttsMimoStylePrompt: string;
  // Mossland（api.mosi.cn）
  ttsMosslandKey: string;
  ttsMosslandVoiceId: string;
  ttsMosslandModel: string;
  // MiniMax 流式播放
  ttsStreaming: boolean;
}

interface TtsApi {
  synthesize: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; model?: string; format?: "mp3" | "wav" | "pcm";
  }) => Promise<string>;
  synthesizeCached: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean }>;
  // GPT-SoVITS（返回 base64 + cacheKey + cached + format）
  synthesizeCachedGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 自定义云端（返回 base64 + cacheKey + cached + format）
  synthesizeCachedCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 小米 MiMo（返回 base64 + cacheKey + cached + format）
  synthesizeCachedMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" }>;
  // 流式合成（minimax，边推 chunk 边播）
  streamStart: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => Promise<{ started: boolean; cacheKey: string; cached: boolean }>;
  onAudioChunk: (callback: (payload: { base64: string }) => void) => () => void;
  onStreamEnd: (callback: (payload: { cacheKey: string; cached: boolean; format: "mp3" | "wav" | "pcm" }) => void) => () => void;
  onStreamError: (callback: (payload: { message: string }) => void) => () => void;
  loadSettings: () => Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    tts?: TtsApi;
    live2dSpeech?: {
      prepare: () => void;
      startMouth: (durationMs: number) => void;
      stopMouth: () => void;
    };
  }
}

// 当前正在播放的 TTS 音频实例（全局唯一）。点新朗读前先停这个，避免重叠。
let currentTtsAudio: HTMLAudioElement | null = null;
let currentTtsObjectUrl: string | null = null;
// 当前正在朗读的消息 ID，用于给对应消息 row 加 .is-speaking class 并切换喇叭图标。
// null 表示没有正在播放。
let currentSpeakingMsgId: string | null = null;
let speechToken = 0;
let textMouthStarted = false;
let ttsPlaybackSequence = 0;

/** 复制文本到剪贴板，优先用现代 Clipboard API，失败时回落到 textarea+execCommand。 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒或无 clipboard 上下文，回落到下面
  }
  // Fallback：临时 textarea + execCommand('copy')。旧浏览器/无焦点时也能用。
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function nextSpeechToken(): number {
  speechToken += 1;
  return speechToken;
}

/** 把正在播放的喇叭按钮切回静态 SVG，所有其他按钮恢复正常。 */
function syncSpeakingUi(): void {
  const prevId = currentSpeakingMsgId;
  document.querySelectorAll(".msg.is-speaking").forEach((el) => {
    if (prevId === null || (el as HTMLElement).dataset.msgId !== prevId) {
      el.classList.remove("is-speaking");
      const btn = el.querySelector(".msg__speak");
      if (btn) btn.innerHTML = SPEAK_ICON_IDLE;
    }
  });
  if (prevId === null) return;
  const row = document.querySelector(`.msg[data-msg-id="${CSS.escape(prevId)}"]`);
  if (!row) return;
  row.classList.add("is-speaking");
  const btn = row.querySelector(".msg__speak");
  if (btn) btn.innerHTML = SPEAK_ICON_ACTIVE;
}

/** 在开始朗读某条消息前调用：清掉旧的、设上新的，并刷新 UI。 */
function setSpeakingMsgId(id: string | null): void {
  currentSpeakingMsgId = id;
  syncSpeakingUi();
}

function stopLive2dMouth(): void {
  speechToken += 1;
  textMouthStarted = false;
  window.live2dSpeech?.stopMouth();
}

function startTextModeMouth(): void {
  if (textMouthStarted) return;
  textMouthStarted = true;
  window.live2dSpeech?.startMouth(TEXT_MODE_MOUTH_DURATION_MS);
}

/** 停止当前正在播放的 TTS 音频（如果有）。只停 audio，UI 复位由调用方决定。 */
function stopCurrentTts(): void {
  if (currentTtsAudio) {
    releaseCurrentTtsAudio(currentTtsAudio);
  }
  stopLive2dMouth();
}

function releaseCurrentTtsAudio(audio: HTMLAudioElement): void {
  if (currentTtsAudio !== audio) return;
  currentTtsAudio = null;
  const url = currentTtsObjectUrl;
  currentTtsObjectUrl = null;
  audio.pause();
  audio.currentTime = 0;
  audio.removeAttribute("src");
  audio.load();
  if (url) URL.revokeObjectURL(url);
}

async function loadTtsSettings(): Promise<TtsSettings | null> {
  if (!window.tts) return null;
  try {
    const raw = await window.tts.loadSettings();
    return {
      ttsEngine: String(raw.ttsEngine ?? "off"),
      ttsAutoRead: Boolean(raw.ttsAutoRead),
      ttsSpeed: Number(raw.ttsSpeed ?? 1),
      ttsVolume: Number(raw.ttsVolume ?? 1),
      ttsMinimaxKey: String(raw.ttsMinimaxKey ?? ""),
      ttsMinimaxVoiceId: String(raw.ttsMinimaxVoiceId ?? ""),
      ttsMinimaxModel: raw.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo",
      ttsGptsovitsBaseUrl: String(raw.ttsGptsovitsBaseUrl ?? ""),
      ttsGptsovitsRefAudioPath: String(raw.ttsGptsovitsRefAudioPath ?? ""),
      ttsGptsovitsPromptText: String(raw.ttsGptsovitsPromptText ?? ""),
      ttsGptsovitsFormat: raw.ttsGptsovitsFormat === "mp3" ? "mp3" : "wav",
      ttsCustomCloudEndpointUrl: String(raw.ttsCustomCloudEndpointUrl ?? ""),
      ttsCustomCloudApiKey: String(raw.ttsCustomCloudApiKey ?? ""),
      ttsCustomCloudVoiceId: String(raw.ttsCustomCloudVoiceId ?? ""),
      ttsCustomCloudFormat: raw.ttsCustomCloudFormat === "wav" ? "wav" : "mp3",
      ttsCustomCloudTimeoutMs: Number(raw.ttsCustomCloudTimeoutMs ?? 30000),
      ttsMimoKey: String(raw.ttsMimoKey ?? ""),
      ttsMimoVoiceAudioPath: String(raw.ttsMimoVoiceAudioPath ?? ""),
      ttsMimoStylePrompt: String(raw.ttsMimoStylePrompt ?? ""),
      ttsMosslandKey: String(raw.ttsMosslandKey ?? ""),
      ttsMosslandVoiceId: String(raw.ttsMosslandVoiceId ?? ""),
      ttsMosslandModel: String(raw.ttsMosslandModel ?? "moss-tts"),
      ttsStreaming: raw.ttsStreaming !== false,
    };
  } catch {
    return null;
  }
}

// 每次朗读前重新读取设置，确保设置页刚改的模型/音量/自动朗读开关即时生效。
function waitForAudioMetadata(audio: HTMLAudioElement): Promise<number | null> {
  return new Promise((resolve) => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      resolve(audio.duration);
      return;
    }
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, 3000);
    const cleanup = () => {
      window.clearTimeout(timer);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    };
    const onError = () => {
      cleanup();
      resolve(null);
    };
    audio.addEventListener("loadedmetadata", onLoaded, { once: true });
    audio.addEventListener("error", onError, { once: true });
  });
}

function playTtsBase64(
  base64: string,
  format: "wav" | "mp3" = "mp3",
  msgId?: string,
): void {
  stopCurrentTts();
  const token = nextSpeechToken();
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const mime = format === "wav" ? "audio/wav" : "audio/mp3";
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.load();
  currentTtsAudio = audio;
  currentTtsObjectUrl = url;
  // 标记喇叭 UI 进入播放态（即使没传 msgId 也清掉旧的）
  setSpeakingMsgId(msgId ?? null);

  audio.onended = () => {
    releaseCurrentTtsAudio(audio);
    if (speechToken === token) stopLive2dMouth();
    // 复位喇叭 UI：仅当当前记录的就是这条消息才清，避免覆盖后启动的
    if (msgId === undefined || currentSpeakingMsgId === msgId) {
      setSpeakingMsgId(null);
    }
  };

  void (async () => {
    const durationSec = await waitForAudioMetadata(audio);
    try {
      await audio.play();
    } catch (err) {
      console.warn("[TTS] 播放失败:", err);
      releaseCurrentTtsAudio(audio);
      if (speechToken === token) stopLive2dMouth();
      if (msgId === undefined || currentSpeakingMsgId === msgId) {
        setSpeakingMsgId(null);
      }
      return;
    }

    if (speechToken !== token) return;
    window.live2dSpeech?.prepare();
    const durationMs = durationSec === null ? 0 : Math.max(0, durationSec * 1000 - AUDIO_MOUTH_DELAY_MS);
    window.setTimeout(() => {
      if (speechToken !== token) return;
      if (durationMs > 0) window.live2dSpeech?.startMouth(durationMs);
    }, AUDIO_MOUTH_DELAY_MS);
  })();
}

/**
 * 流式播放 MiniMax TTS（MediaSource + SourceBuffer 边收边播）。
 * 返回 cacheKey（供回写消息）。失败时 fallback 到完整合成。
 */
async function streamAndPlayCached(
  settings: TtsSettings,
  text: string,
  existing?: { ttsCacheKey?: string },
  options?: { waitForPlaybackEnd?: boolean },
): Promise<{ cacheKey: string } | null> {
  if (!window.tts) return null;

  stopCurrentTts();  // 先停当前 TTS（含 stopLive2dMouth），再拿 token，否则 token 立刻失效
  const token = nextSpeechToken();
  const t0 = performance.now();  // 诊断时间戳基准（startPolling 闭包要用，必须在 try 外声明）
  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;
  let audioEl: HTMLAudioElement | null = null;
  const chunkQueue: Uint8Array[] = [];
  const maxQueuedAudioBytes = 12 * 1024 * 1024;
  let queuedAudioBytes = 0;
  let ended = false;
  let resolvedCacheKey: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let offChunk: (() => void) | null = null;
  let offEnd: (() => void) | null = null;
  let offErr: (() => void) | null = null;
  let done = false;
  let playbackEnded = false;
  let streamReady = false;
  let streamResult: { cacheKey: string } | null = null;
  let resolveStream: ((v: { cacheKey: string } | null) => void) | null = null;

  const cleanup = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    offChunk?.(); offEnd?.(); offErr?.();
    offChunk = offEnd = offErr = null;
    chunkQueue.length = 0;
    queuedAudioBytes = 0;
  };

  const finishStream = (result: { cacheKey: string } | null) => {
    streamReady = true;
    streamResult = result;
    if (!options?.waitForPlaybackEnd || playbackEnded) {
      resolveStream?.(streamResult);
    }
  };

  const markPlaybackEnded = () => {
    playbackEnded = true;
    if (streamReady) {
      resolveStream?.(streamResult);
    }
  };

  // 轮询 flush：每 30ms 检查一次，能 append 就 append，结束且队列空就 endOfStream + resolve
  const startPolling = (resolve: (v: { cacheKey: string } | null) => void) => {
    let startedPlayback = false;
    pollTimer = setInterval(() => {
      if (speechToken !== token) {
        cleanup();
        try { mediaSource?.endOfStream(); } catch { /* */ }
        finishStream(null);
        return;
      }
      // append 队列里的 chunk（如果 sourceBuffer 空闲）
      if (sourceBuffer && !sourceBuffer.updating && chunkQueue.length > 0) {
        const chunk = chunkQueue.shift()!;
        queuedAudioBytes -= chunk.byteLength;
        try {
          sourceBuffer.appendBuffer(chunk);
        } catch {
          chunkQueue.unshift(chunk);
          queuedAudioBytes += chunk.byteLength;
        }
      }
      // 第一块 append 成功后（buffered 有数据）开始播放
      if (!startedPlayback && sourceBuffer && sourceBuffer.buffered.length > 0 && audioEl && audioEl.paused) {
        startedPlayback = true;
        void audioEl.play().then(() => {
          console.log(`[TTS-Stream] play() 开始 +${Math.round(performance.now() - t0)}ms`);
          if (speechToken !== token) return;
          const estDurationMs = Math.max(2000, Array.from(text).length * 180);
          window.live2dSpeech?.startMouth(estDurationMs);
        }).catch((err) => {
          console.warn("[TTS-Stream] play 失败:", err);
          markPlaybackEnded();
        });
      }
      // 结束且队列空 → endOfStream
      if (ended && chunkQueue.length === 0 && sourceBuffer && !sourceBuffer.updating && !done) {
        done = true;
        try { mediaSource?.endOfStream(); } catch { /* */ }
        cleanup();
        if (options?.waitForPlaybackEnd && !startedPlayback) {
          markPlaybackEnded();
        }
        console.log(`[TTS-Stream] resolve +${Math.round(performance.now() - t0)}ms cacheKey=${resolvedCacheKey?.slice(0,20)}`);
        finishStream(resolvedCacheKey ? { cacheKey: resolvedCacheKey } : null);
      }
    }, 30);
  };

  try {
    // 启动流式合成
    const startResult = await window.tts.streamStart({
      apiKey: settings.ttsMinimaxKey,
      voiceId: settings.ttsMinimaxVoiceId,
      text,
      speed: settings.ttsSpeed,
      volume: settings.ttsVolume,
      model: settings.ttsMinimaxModel,
      format: "mp3",
      expectedCacheKey: existing?.ttsCacheKey,
    });
    console.log(`[TTS-Stream] streamStart 返回 +${Math.round(performance.now() - t0)}ms started=${startResult.started} cached=${startResult.cached}`);

    // 注册监听（只注册一次）
    let firstChunkAt = 0;
    offChunk = window.tts.onAudioChunk((payload) => {
      if (speechToken !== token) return;
      if (!firstChunkAt) {
        firstChunkAt = performance.now();
        console.log(`[TTS-Stream] 第一个 chunk +${Math.round(firstChunkAt - t0)}ms`);
      }
      const bytes = Uint8Array.from(atob(payload.base64), (c) => c.charCodeAt(0));
      if (queuedAudioBytes + bytes.byteLength > maxQueuedAudioBytes) {
        console.warn("[TTS-Stream] 音频队列超过 12MB，停止本轮流式播放");
        cleanup();
        if (audioEl) releaseCurrentTtsAudio(audioEl);
        finishStream(null);
        return;
      }
      chunkQueue.push(bytes);
      queuedAudioBytes += bytes.byteLength;
    });
    offEnd = window.tts.onStreamEnd((payload) => {
      ended = true;
      resolvedCacheKey = payload.cacheKey;
      console.log(`[TTS-Stream] STREAM_END +${Math.round(performance.now() - t0)}ms chunks=${chunkQueue.length}`);
    });
    offErr = window.tts.onStreamError((payload) => {
      console.warn(`[TTS-Stream] ERROR +${Math.round(performance.now() - t0)}ms:`, payload.message);
      ended = true;
      cleanup();
      try { mediaSource?.endOfStream(); } catch { /* */ }
    });

    // 设置 MediaSource + Audio
    mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    audioEl = new Audio(url);
    currentTtsAudio = audioEl;
    currentTtsObjectUrl = url;

    window.live2dSpeech?.prepare();  // stopLive2dMouth 已在开头 stopCurrentTts 里调过

    audioEl.onended = () => {
      releaseCurrentTtsAudio(audioEl!);
      if (speechToken === token) stopLive2dMouth();
      markPlaybackEnded();
    };

    mediaSource.addEventListener("sourceopen", () => {
      console.log(`[TTS-Stream] sourceopen +${Math.round(performance.now() - t0)}ms`);
      try {
        sourceBuffer = mediaSource!.addSourceBuffer("audio/mpeg");
        sourceBuffer.mode = "sequence";
        console.log(`[TTS-Stream] sourceBuffer 创建成功`);
        // 不立即 play——等轮询里第一块 append 成功（buffered.length>0）再 play
      } catch (err) {
        console.warn("[TTS-Stream] SourceBuffer 创建失败:", err);
      }
    });

    // 超时兜底（30s）
    setTimeout(() => {
      if (!done) {
        ended = true;
      }
    }, 30000);

    // 等 STREAM_END + 队列 flush 完
    return await new Promise<{ cacheKey: string } | null>((resolve) => {
      resolveStream = resolve;
      startPolling(resolve);
    });
  } catch (err) {
    console.warn("[TTS] 流式启动失败:", err);
    cleanup();
    return null;  // 调用方 fallback 到完整合成
  }
}

async function synthesizeAndPlayCached(
  text: string,
  existing?: { ttsCacheKey?: string },
  msgId?: string,
): Promise<{ cacheKey: string } | null> {
  if (!window.tts) return null;

  // 回听优先：如果旧消息有 ttsCacheKey，直接尝试读缓存文件播放，不需要任何引擎配置。
  // 只有缓存文件不存在、需要合成新音频时才检查引擎配置。
  const settings = await loadTtsSettings();
  if (!settings || settings.ttsEngine === "off") return null;

  // 缓存回听：按 cacheKey 前缀分发到对应引擎的 _CACHED IPC
  // （minimax 缓存走 TTS_SYNTHESIZE_CACHED，gptsovits 缓存走 TTS_SYNTHESIZE_CACHED_GPTSOVITS）
  if (existing?.ttsCacheKey) {
    const isGptsovitsCache = existing.ttsCacheKey.startsWith("gptsovits-");
    const isCustomCloudCache = existing.ttsCacheKey.startsWith("custom-cloud-");
    const isMimoCache = existing.ttsCacheKey.startsWith("mimo-");
    const isMosslandCache = existing.ttsCacheKey.startsWith("mossland-");
    try {
      if (isGptsovitsCache) {
        const result = await window.tts.synthesizeCachedGptsovits({
          baseUrl: "cache-only",        // 占位，缓存命中不会用到
          refAudioPath: "cache-only",   // 占位
          promptText: "cache-only",     // 占位
          text,
          speed: settings.ttsSpeed,
          format: settings.ttsGptsovitsFormat,
          expectedCacheKey: existing.ttsCacheKey,
        });
        if (result.cached) {
          console.log("[TTS] gptsovits 缓存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      } else if (isCustomCloudCache) {
        const result = await window.tts.synthesizeCachedCustomCloud({
          endpointUrl: "cache-only",    // 占位，缓存命中不会用到
          apiKey: "cache-only",
          voiceId: "cache-only",
          text,
          speed: settings.ttsSpeed,
          volume: settings.ttsVolume,
          format: settings.ttsCustomCloudFormat,
          timeoutMs: settings.ttsCustomCloudTimeoutMs,
          expectedCacheKey: existing.ttsCacheKey,
        });
        if (result.cached) {
          console.log("[TTS] custom-cloud 缓存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      } else if (isMimoCache) {
        const result = await window.tts.synthesizeCachedMimo({
          apiKey: "cache-only",
          voiceAudioPath: "cache-only",
          text,
          stylePrompt: "",
          expectedCacheKey: existing.ttsCacheKey,
        });
        if (result.cached) {
          console.log("[TTS] mimo 缓存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      } else if (isMosslandCache) {
        const result = await window.tts.synthesizeCachedMossland({
          apiKey: "cache-only",
          voiceId: "cache-only",
          text,
          model: "moss-tts",
          format: "mp3",
          expectedCacheKey: existing.ttsCacheKey,
        });
        if (result.cached) {
          console.log("[TTS] mossland 缓存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      } else {
        // minimax 缓存回听（保持原逻辑）
        const result = await window.tts.synthesizeCached({
          apiKey: "cache-only",
          voiceId: "cache-only",
          text,
          speed: settings.ttsSpeed,
          volume: settings.ttsVolume,
          model: settings.ttsMinimaxModel,
          expectedCacheKey: existing.ttsCacheKey,
        });
        if (result.cached) {
          console.log("[TTS] minimax 缓存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      }
    } catch {
      // 缓存读取失败，继续走正常合成流程
    }
  }

  // 需要合成新音频 → 按 engine 分发
  if (settings.ttsEngine === "minimax") {
    if (!settings.ttsMinimaxKey || !settings.ttsMinimaxVoiceId) {
      console.warn("[TTS] 缺少 apiKey 或 voiceId，无法合成新音频");
      return null;
    }
    // 流式优先（默认开）：边合成边播，首字延迟低；失败 fallback 完整合成
    if (settings.ttsStreaming) {
      const stream = await streamAndPlayCached(settings, text, existing);
      if (stream) return stream;
      console.warn("[TTS] 流式失败，fallback 完整合成");
    }
    try {
      const result = await window.tts.synthesizeCached({
        apiKey: settings.ttsMinimaxKey,
        voiceId: settings.ttsMinimaxVoiceId,
        text,
        speed: settings.ttsSpeed,
        volume: settings.ttsVolume,
        model: settings.ttsMinimaxModel,
        expectedCacheKey: existing?.ttsCacheKey,
      });
      playTtsBase64(result.base64, result.format, msgId);
      return { cacheKey: result.cacheKey };
    } catch (err) {
      console.warn("[TTS] 合成失败:", err);
      return null;
    }
  }

  if (settings.ttsEngine === "gptsovits") {
    if (!settings.ttsGptsovitsBaseUrl || !settings.ttsGptsovitsRefAudioPath || !settings.ttsGptsovitsPromptText) {
      console.warn("[TTS] 缺少 GPT-SoVITS 配置（baseUrl/refAudioPath/promptText）");
      return null;
    }
    try {
      const result = await window.tts.synthesizeCachedGptsovits({
        baseUrl: settings.ttsGptsovitsBaseUrl,
        refAudioPath: settings.ttsGptsovitsRefAudioPath,
        promptText: settings.ttsGptsovitsPromptText,
        text,
        speed: settings.ttsSpeed,
        format: settings.ttsGptsovitsFormat,
        expectedCacheKey: existing?.ttsCacheKey,
      });
      playTtsBase64(result.base64, result.format, msgId);
      return { cacheKey: result.cacheKey };
    } catch (err) {
      console.warn("[TTS] GPT-SoVITS 合成失败:", err);
      return null;
    }
  }

  if (settings.ttsEngine === "custom-cloud") {
    if (!settings.ttsCustomCloudEndpointUrl) {
      console.warn("[TTS] 缺少自定义云端 Endpoint URL");
      return null;
    }
    try {
      const result = await window.tts.synthesizeCachedCustomCloud({
        endpointUrl: settings.ttsCustomCloudEndpointUrl,
        apiKey: settings.ttsCustomCloudApiKey,
        voiceId: settings.ttsCustomCloudVoiceId,
        text,
        speed: settings.ttsSpeed,
        volume: settings.ttsVolume,
        format: settings.ttsCustomCloudFormat,
        timeoutMs: settings.ttsCustomCloudTimeoutMs,
        expectedCacheKey: existing?.ttsCacheKey,
      });
      playTtsBase64(result.base64, result.format, msgId);
      return { cacheKey: result.cacheKey };
    } catch (err) {
      console.warn("[TTS] 自定义云端合成失败:", err);
      return null;
    }
  }

  if (settings.ttsEngine === "mimo") {
    if (!settings.ttsMimoKey || !settings.ttsMimoVoiceAudioPath) {
      console.warn("[TTS] 缺少小米 MiMo API Key 或昔涟克隆音频");
      return null;
    }
    try {
      const result = await window.tts.synthesizeCachedMimo({
        apiKey: settings.ttsMimoKey,
        voiceAudioPath: settings.ttsMimoVoiceAudioPath,
        text,
        stylePrompt: settings.ttsMimoStylePrompt,
        expectedCacheKey: existing?.ttsCacheKey,
      });
      playTtsBase64(result.base64, result.format, msgId);
      return { cacheKey: result.cacheKey };
    } catch (err) {
      console.warn("[TTS] 小米 MiMo 合成失败:", err);
      return null;
    }
  }

  if (settings.ttsEngine === "mossland") {
    if (!settings.ttsMosslandKey || !settings.ttsMosslandVoiceId) {
      console.warn("[TTS] 缺少 Mossland API Key 或 voice_id");
      return null;
    }
    try {
      const result = await window.tts.synthesizeCachedMossland({
        apiKey: settings.ttsMosslandKey,
        voiceId: settings.ttsMosslandVoiceId,
        text,
        speed: settings.ttsSpeed,
        volume: settings.ttsVolume,
        model: settings.ttsMosslandModel || "moss-tts",
        format: "mp3",
        expectedCacheKey: existing?.ttsCacheKey,
      });
      playTtsBase64(result.base64, result.format, msgId);
      return { cacheKey: result.cacheKey };
    } catch (err) {
      console.warn("[TTS] Mossland 合成失败:", err);
      return null;
    }
  }

  return null;
}

async function speakMessage(message: Message): Promise<void> {
  ttsPlaybackSequence += 1;
  stopLive2dMouth();
  window.live2dSpeech?.prepare();
  // 立即切 UI：不等合成，让用户能马上看到按钮进入播放态。
  // playTtsBase64 真正开始播时会再次 setSpeakingMsgId（幂等）；如果合成失败下面 catch 里复位。
  setSpeakingMsgId(message.id);
  try {
    const cache = await synthesizeAndPlayCached(message.content, message, message.id);
    if (cache) {
      message.ttsCacheKey = cache.cacheKey;
      void saveSession();
    } else if (currentSpeakingMsgId === message.id) {
      // 合成失败（引擎关 / 配置缺失 / 网络报错）→ 复位 UI
      console.warn("[TTS] 合成失败，复位喇叭按钮");
      setSpeakingMsgId(null);
    }
  } catch (err) {
    console.warn("[TTS] speakMessage 异常:", err);
    if (currentSpeakingMsgId === message.id) setSpeakingMsgId(null);
  }
}

// 自动朗读：检查引擎是否开启 + autoRead 开关，满足条件才朗读
async function autoSpeakIfEnabled(text: string): Promise<{ cacheKey: string } | null> {
  const settings = await loadTtsSettings();
  if (!settings || settings.ttsEngine === "off" || !settings.ttsAutoRead) return null;
  ttsPlaybackSequence += 1;
  return await synthesizeAndPlayCached(text);
}

interface EarlyMinimaxPlayback {
  append(delta: string): void;
  finish(fullText: string): Promise<{ cacheKey: string } | null>;
}

function createEarlyMinimaxPlayback(): EarlyMinimaxPlayback {
  let settingsPromise: Promise<TtsSettings | null> | null = null;
  let settings: TtsSettings | null = null;
  let checked = false;
  let eligible = false;
  let triggered = false;
  let segment = "";
  let playbackPromise: Promise<{ ok: boolean; sequence: number }> | null = null;
  let sequence = 0;

  const ensureSettings = async (): Promise<TtsSettings | null> => {
    if (!settingsPromise) {
      settingsPromise = loadTtsSettings();
    }
    settings = await settingsPromise;
    if (!checked) {
      checked = true;
      eligible = canUseMinimaxStreamingEarly(settings);
    }
    return settings;
  };

  const tryStart = async (text: string): Promise<void> => {
    if (triggered) return;
    const cfg = await ensureSettings();
    if (!cfg || !eligible || triggered) return;
    const early = extractEarlyTtsSegment(text);
    if (!early) return;

    triggered = true;
    segment = early.segment;
    ttsPlaybackSequence += 1;
    sequence = ttsPlaybackSequence;
    playbackPromise = streamAndPlayCached(cfg, segment, undefined, { waitForPlaybackEnd: true })
      .then((result) => ({ ok: Boolean(result), sequence }))
      .catch(() => ({ ok: false, sequence }));
  };

  return {
    append(delta: string): void {
      if (triggered) return;
      void tryStart(delta);
    },
    async finish(fullText: string): Promise<{ cacheKey: string } | null> {
      const cfg = await ensureSettings();
      if (!cfg || !eligible) return autoSpeakIfEnabled(fullText);

      if (!triggered) {
        return autoSpeakIfEnabled(fullText);
      }

      const result = await playbackPromise;
      if (!result?.ok) {
        return autoSpeakIfEnabled(fullText);
      }
      if (result.sequence !== ttsPlaybackSequence) {
        return null;
      }

      const remainder = fullText.slice(segment.length).trim();
      if (!remainder) return null;
      const rest = await streamAndPlayCached(cfg, remainder, undefined, { waitForPlaybackEnd: true });
      return rest ? null : autoSpeakIfEnabled(fullText);
    },
  };
}

function autosize(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}

// ── 表情包选择器 ──

let enabledStickers: Array<{ id: string; src: string; description?: string }> = [];

async function loadEnabledStickers(): Promise<void> {
  try {
    enabledStickers = (await window.chat?.getEnabledStickers?.()) ?? [];
  } catch {
    enabledStickers = [];
  }
}

/** 根据 sticker id 查语义描述 */
function getStickerDescription(id: string): string {
  const found = enabledStickers.find((s) => s.id === id);
  return found?.description ?? id;
}

function renderStickerPicker(): void {
  stickerPickerGrid.replaceChildren();
  if (enabledStickers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sticker-picker__empty";
    empty.textContent = "没有可用的表情包";
    stickerPickerGrid.appendChild(empty);
    return;
  }
  for (const s of enabledStickers) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "sticker-picker__item";
    const img = document.createElement("img");
      // 内置贴纸 src 是 "/stickers/xxx" 绝对路径，file:// 协议下解析到磁盘根目录
      // 走 resolveAsset() 转成正确的 file:// 或 http:// URL（与 sticker-manager 缩略图同模式）
      img.src = s.src.startsWith("/stickers/") ? resolveAsset(s.src) : s.src;
    img.alt = s.id;
    img.draggable = false;
    card.appendChild(img);
    card.addEventListener("click", () => {
      insertSticker(s.id);
      hideStickerPicker();
    });
    stickerPickerGrid.appendChild(card);
  }
}

function insertSticker(id: string): void {
  const marker = `[sticker:${id}]`;
  const cursorPos = inputEl.selectionStart ?? inputEl.value.length;
  const cursorEnd = inputEl.selectionEnd ?? cursorPos;
  inputEl.value = inputEl.value.slice(0, cursorPos) + marker + inputEl.value.slice(cursorEnd);
  inputEl.selectionStart = inputEl.selectionEnd = cursorPos + marker.length;
  autosize();
  inputEl.focus();
}

function showStickerPicker(): void {
  stickerPicker.hidden = false;
  stickerPickerBtn.classList.add("is-active");
  void loadEnabledStickers().then(renderStickerPicker);
}

function hideStickerPicker(): void {
  stickerPicker.hidden = true;
  stickerPickerBtn.classList.remove("is-active");
}

stickerPickerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (stickerPicker.hidden) showStickerPicker();
  else hideStickerPicker();
});

document.addEventListener("click", (e) => {
  if (stickerPicker.hidden) return;
  if (!stickerPicker.contains(e.target as Node) && e.target !== stickerPickerBtn) {
    hideStickerPicker();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !stickerPicker.hidden) hideStickerPicker();
});

function buildModelMessages(): Array<{ role: "user" | "model"; content: string; at?: number }> {
  return messages
    .filter((message) => !message.transient && (message.content.trim() || message.modelContext?.trim() || message.sticker))
    .slice(-16)
    .map((message) => ({
      role: message.role,
      at: Number.isFinite(message.at) ? message.at : undefined,
      content: (message.content + (message.modelContext ? "\n\n" + message.modelContext : "")).replace(/\[sticker:([^\]]+)\]/g, (_match, id) => {
        const desc = getStickerDescription(id);
        return `（用户发送表情包：${desc}）`;
      }),
    }));
}

/** 文档全文、RAG 片段和图片 caption 只服务于当前请求，不能随历史常驻。 */
function clearModelContexts(): boolean {
  let changed = false;
  for (const message of messages) {
    if (message.modelContext !== undefined) {
      message.modelContext = undefined;
      changed = true;
    }
  }
  return changed;
}

function isChatMode(): boolean {
  const active = document.querySelector(".mode-switch__option.is-active") as HTMLElement | null;
  return active?.dataset?.modeValue === "chat";
}

function getCurrentStyleId(): StyleId {
  const active = document.querySelector("#style-dropdown .dm-opt.is-active") as HTMLElement | null;
  return normalizeStyleId(active?.dataset?.value);
}

let sending = false;

// 发送期间到达的 proactive-chat 外部变更（如昔涟又发了一条主动消息）不立刻重载，
// 否则会清掉 transient 思考消息 / 冲掉刚落库的回复。记下 sessionId，等发送结束、
// 最终 saveSession 落盘后再 flush 重载。
let pendingProactiveReloadId: string | null = null;

/**
 * 发送结束后调用：若有排队的外部变更，重载当前会话。
 *
 * 依赖 IPC 有序处理：发送的最终 saveSession（replaceTail）在 finally 之前已同步
 * 发出 IPC，flush 这里的 getPage IPC 一定排在它之后被主进程处理，所以重载读到的
 * 是已落库的回复，不会把它冲掉。
 *
 * 已知限制：若外部主动消息在用户 saveSession 之前 append，replaceMessagesTail
 * 会用本地视图覆盖它（写冲突）。当前无调度器触发 evaluateCandidate，外部主动消息
 * 不会在发送期间产生，此限制暂不构成实际问题；未来接入调度器时需把 saveSession
 * 改成 merge-aware。
 */
async function flushPendingProactiveReload(): Promise<void> {
  const pendingId = pendingProactiveReloadId;
  if (!pendingId) return;
  pendingProactiveReloadId = null;
  // 重载前再确认仍是当前会话；用户可能已手动切走。
  if (pendingId === currentSessionId) {
    await loadSessionTailIntoUI(pendingId);
  }
}

// ── 快捷预设胶囊 ──────────────────────────────────────────
// 空对话时在 empty-state 下方显示的半透明胶囊，点击后：
// - fill 模式：预设提示词填入输入框，用户修改后发送
// - chat 模式：昔涟主动开口（注入隐藏种子消息触发 agent）

interface QuickPreset {
  id: string;
  label: string;
  icon: string;
  mode: "chat" | "fill";
  prompt?: string;
}

const QUICK_PRESETS: QuickPreset[] = [
  { id: "chat",     label: "和昔涟聊天", icon: `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M33 38H22V30H36V22H44V38H39L36 41L33 38Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 6H36V30H17L13 34L9 30H4V6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 18H20" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M26 18H27" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M12 18H13" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`,  mode: "chat" },
  { id: "schedule", label: "设置定时任务", icon: `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M23.9998 44.3332C34.1251 44.3332 42.3332 36.1251 42.3332 25.9999C42.3332 15.8747 34.1251 7.66656 23.9998 7.66656C13.8746 7.66656 5.6665 15.8747 5.6665 25.9999C5.6665 36.1251 13.8746 44.3332 23.9998 44.3332Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M23.7594 15.3536L23.7582 26.3624L31.5305 34.1347" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9.00001L11 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 9.00001L37 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, mode: "fill", prompt: "帮我设置一个定时任务：" },
  { id: "weather",  label: "查看天气",   icon: `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M30.7826 24.5652C34.5285 24.5652 37.5652 21.5285 37.5652 17.7826C37.5652 14.0367 34.5285 11 30.7826 11C27.4338 11 24.6518 13.427 24.0996 16.618" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 7C34.1046 7 35 6.10457 35 5C35 3.89543 34.1046 3 33 3C31.8954 3 31 3.89543 31 5C31 6.10457 31.8954 7 33 7Z" fill="currentColor"/><path d="M42 12C43.1046 12 44 11.1046 44 10C44 8.89543 43.1046 8 42 8C40.8954 8 40 8.89543 40 10C40 11.1046 40.8954 12 42 12Z" fill="currentColor"/><path d="M44 21C45.1046 21 46 20.1046 46 19C46 17.8954 45.1046 17 44 17C42.8954 17 42 17.8954 42 19C42 20.1046 42.8954 21 44 21Z" fill="currentColor"/><path d="M22 10C23.1046 10 24 9.10457 24 8C24 6.89543 23.1046 6 22 6C20.8954 6 20 6.89543 20 8C20 9.10457 20.8954 10 22 10Z" fill="currentColor"/><path d="M9.45455 39.9942C6.14242 37.461 4 33.4278 4 28.8851C4 21.2166 10.1052 15 17.6364 15C23.9334 15 29.2336 19.3462 30.8015 25.2533C32.0353 24.6159 33.431 24.2567 34.9091 24.2567C39.9299 24.2567 44 28.4011 44 33.5135C44 37.3094 41.7562 40.5716 38.5455 42" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M22.2426 24.7574C21.1569 23.6716 19.6569 23 18 23C14.6863 23 12 25.6863 12 29C12 30.6569 12.6716 32.1569 13.7574 33.2426" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, mode: "fill", prompt: "帮我查一下今天的天气" },
  { id: "document", label: "生成文档",   icon: `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="6" y="6" width="36" height="36" rx="3" fill="none" stroke="currentColor" stroke-width="4"/><path d="M14 16L18 32L24 19L30 32L34 16" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, mode: "fill", prompt: "帮我生成一份文档：" },
  { id: "email",    label: "发送邮件",   icon: `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M36 15H44V28V41H4V28V15H12" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 19V5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 11L24 5L18 11" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15L24 30L44 15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, mode: "fill", prompt: "帮我发一封邮件：" },
];

/** 动态生成胶囊 DOM 并绑定点击。bootstrap 末尾调一次。 */
function buildQuickPresets(): void {
  const container = document.getElementById("quick-presets");
  if (!container) return;
  container.replaceChildren();
  for (const preset of QUICK_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat__preset";
    btn.dataset.presetId = preset.id;
    const icon = document.createElement("span");
    icon.className = "chat__preset-icon";
    icon.innerHTML = preset.icon;
    const label = document.createElement("span");
    label.className = "chat__preset-label";
    label.textContent = preset.label;
    btn.appendChild(icon);
    btn.appendChild(label);
    btn.addEventListener("click", () => onPresetClick(preset));
    container.appendChild(btn);
  }
}

function onPresetClick(preset: QuickPreset): void {
  if (preset.mode === "fill") {
    inputEl.value = preset.prompt ?? "";
    inputEl.focus();
    const len = inputEl.value.length;
    inputEl.setSelectionRange(len, len);
    autosize();
  } else {
    void triggerCyreneGreeting();
  }
}

/**
 * 「和昔涟聊天」胶囊：让昔涟主动开口。
 * 注入隐藏种子消息触发 agent（不推入 messages 数组、不渲染），
 * 复用现有 AG-UI 流式回复机制。
 */
async function triggerCyreneGreeting(): Promise<void> {
  if (sending || !currentSessionId) return;

  // 立即隐藏空态（胶囊），不等 refreshModelConfig 异步完成
  const emptyEl = document.getElementById("chat-empty");
  if (emptyEl) emptyEl.setAttribute("hidden", "");

  sending = true;
  sendBtn.disabled = true;
  await refreshModelConfig();
  chatHintEl.textContent = currentModelConfig?.connected ? `${currentModelConfig.model} 思考中…` : "模型未连接";

  let streamMsgId = "";
  try {
    streamMsgId = String(Date.now() + 1);
    const streamMsg = { id: streamMsgId, role: "model" as const, content: "", at: Date.now(), thinking: true, transient: true };
    messages.push(streamMsg);
    render();

    let streamContent = "";
    let ttsContent = "";
    let autoSpeakTriggered = false;
    const earlyMinimaxPlayback = createEarlyMinimaxPlayback();
    textMouthStarted = false;
    let pendingTtsCachePromise: Promise<{ cacheKey: string } | null> | null = null;
    let sticker: string | null = null;
    let pendingWeatherCard: Record<string, unknown> | null = null;
    let pendingMusicCard: MusicCardData | null = null;

    let finishRun!: () => void;
    let failRun!: (err: Error) => void;
    const runDone = new Promise<void>((resolve, reject) => {
      finishRun = resolve;
      failRun = reject;
    });

    const deltaQueue: string[] = [];
    let streamSession: StreamingMarkdownSession | null = null;
    let playbackTimer: number | null = null;
    let runFinishedArrived = false;
    let startNextStreamingBubble = false;
    let streamingBubbleCount = 1;
    const allowStreamingBubbleSplit = shouldSegmentAssistantReply(isChatMode() ? "chat" : "work", segmentedOutputMode);
    const getStreamingBubble = (): HTMLElement | null => {
      return getLastBubbleForMessage(streamMsgId);
    };
    const tryFinish = (): void => {
      if (runFinishedArrived && deltaQueue.length === 0 && playbackTimer === null) {
        finishRun();
      }
    };
    const startPlayback = (): void => {
      if (playbackTimer !== null) return;
      playbackTimer = window.setInterval(() => {
        const next = deltaQueue.shift();
        if (next !== undefined) {
          streamContent += next;
          const bubble = startNextStreamingBubble
            ? (appendBubbleForMessage(streamMsgId) ?? getStreamingBubble())
            : getStreamingBubble();
          startNextStreamingBubble = false;
          if (bubble) {
            if (!streamSession) {
              streamSession = createStreamingMarkdownSession(getMd(), bubble, streamMsgId, messagesEl);
            }
            streamSession.append(next);
          }
          if (
            allowStreamingBubbleSplit
            && streamingBubbleCount < MAX_ASSISTANT_REPLY_BUBBLES
            && shouldBreakStreamingBubbleAfterChar(next)
          ) {
            startNextStreamingBubble = true;
            streamingBubbleCount += 1;
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
          return;
        }
        if (playbackTimer !== null) { clearInterval(playbackTimer); playbackTimer = null; }
        tryFinish();
      }, 40);
    };
    const offEvent = registerAguiListener((rawEvent) => {
      try {
        const event = rawEvent as AguiBaseEvent;
        const msg = messages.find(m => m.id === streamMsgId);
        switch (event.type) {
          case "TOOL_CALL_START": {
            const bubble = getStreamingBubble();
            if (bubble) {
              bubble.classList.remove("msg__bubble--thinking");
              bubble.replaceChildren();
              const tip = document.createElement("div");
              tip.className = "msg__tool-tip";
              tip.dataset.toolCallId = event.toolCallId ?? "";
              const icon = document.createElement("span");
              icon.className = "msg__tool-icon";
              icon.textContent = "🔧";
              const text = document.createElement("span");
              text.className = "msg__tool-text";
              text.textContent = "调用中：" + (event.toolCallName ?? "工具");
              tip.appendChild(icon);
              tip.appendChild(text);
              bubble.appendChild(tip);
            }
            break;
          }
          case "TOOL_CALL_END": {
            const bubble = getStreamingBubble();
            if (bubble) {
              const tip = bubble.querySelector(".msg__tool-tip");
              if (tip) {
                const textEl = tip.querySelector(".msg__tool-text");
                if (textEl) textEl.textContent = "已完成";
                tip.classList.add("msg__tool-tip--done");
              }
            }
            break;
          }
          case "TEXT_MESSAGE_START":
            if (msg) { msg.thinking = false; render(); }
            break;
          case "TEXT_MESSAGE_CONTENT":
            if (event.delta) {
              ttsContent += event.delta;
              earlyMinimaxPlayback.append(ttsContent);
              deltaQueue.push(...Array.from(event.delta));
              if (!textMouthStarted) {
                void loadTtsSettings().then((settings) => {
                  if (settings && !settings.ttsAutoRead) {
                    startTextModeMouth();
                  }
                });
              }
              if (msg) { msg.thinking = false; }
              startPlayback();
            }
            break;
          case "TEXT_MESSAGE_END":
            if (!autoSpeakTriggered && ttsContent.trim()) {
              autoSpeakTriggered = true;
              pendingTtsCachePromise = earlyMinimaxPlayback.finish(ttsContent);
            }
            break;
          case "CUSTOM":
            if (event.name === "cyrene.sticker") {
              sticker = (event.value as StickerId | null) ?? null;
            } else if (event.name === "cyrene.weather") {
              pendingWeatherCard = event.value as Record<string, unknown>;
            } else if (event.name === "cyrene.music") {
              pendingMusicCard = normalizeMusicCardData(event.value);
            } else if (event.name === "cyrene.todos") {
              renderTodoPanel(event.value as TodoState | null);
            } else if (event.name === "cyrene.choice") {
              const choiceData = event.value;
              const card = isAskClarificationCard(choiceData)
                ? buildAskClarificationCardEl(choiceData)
                : buildChoiceCardEl(choiceData as {
                    id: string;
                    question: string;
                    options: Array<{ label: string; value: string; description?: string }>;
                    default?: string;
                  });
              messagesEl.appendChild(card);
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            break;
          case "RUN_FINISHED":
            runFinishedArrived = true;
            tryFinish();
            break;
          case "RUN_ERROR":
            failRun(new AgentRenderError(event.code, event.message ?? "模型请求失败"));
            break;
          default:
            break;
        }
      } catch (err) {
        console.error("[Chat] onEvent回调抛错:", err);
      }
    });

    // 种子消息：不推入 messages 数组、不渲染，只作为 agent 输入触发昔涟主动开口
    const ack = await window.agui!.run({
      messages: [{ role: "user", content: "[internal] 用户点击了「和昔涟聊天」，请你主动开口聊几句，像朋友打招呼一样自然开场。" }],
      styleId: getCurrentStyleId(),
      executionMode: isChatMode() ? "chat" : "work",
      sessionId: currentSessionId || undefined,
    });
    if (!ack.success) {
      offEvent();
      throw new Error(ack.error || "模型请求发起失败");
    }

    await runDone;
    offEvent();

    // flush + dispose 流式 Markdown session（终态 render 会全量重建）
    if (streamSession) {
      streamSession.flush();
      streamSession.dispose();
      streamSession = null;
    }

    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      msg.transient = false;
      msg.content = streamContent;
      msg.sticker = sticker;
      msg.musicCard = pendingMusicCard ?? undefined;
    }
    void saveSession();
    const finishedMsgId = streamMsgId;
    void pendingTtsCachePromise?.then((cache) => {
      if (!cache) return;
      const latestMsg = messages.find(m => m.id === finishedMsgId);
      if (!latestMsg) return;
      latestMsg.ttsCacheKey = cache.cacheKey;
      void saveSession();
    });
    render();
    if (pendingWeatherCard) {
      const card = buildWeatherCardEl(pendingWeatherCard);
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      pendingWeatherCard = null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "模型请求失败";
    const code = err instanceof AgentRenderError ? err.code : undefined;
    const userMessage = classifyAgentError(code, message);
    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      msg.transient = false;
      msg.content = userMessage;
    } else {
      messages.push({
        id: String(Date.now() + 2),
        role: "model",
        content: userMessage,
        at: Date.now(),
      });
    }
    void saveSession();
    render();
  } finally {
    sending = false;
    sendBtn.disabled = false;
    chatHintEl.textContent = formatModelHint(currentModelConfig);
    inputEl.focus();
    void flushPendingProactiveReload();
  }
}

async function send(): Promise<void> {
  const text = inputEl.value.trim();
  if ((!text && attachedFiles.length === 0) || sending) return;
  // bootstrap 极快但理论上仍有竞态：currentSessionId 为 null 时消息无处可存，
  // 直接拦截避免丢失。正常情况下 bootstrap 会在用户首次按键前完成。
  if (!currentSessionId) {
    console.warn("[Cyrene Chat] 会话尚未初始化完成，已忽略此次发送");
    return;
  }

  sending = true;
  sendBtn.disabled = true;
  await refreshModelConfig();
  chatHintEl.textContent = currentModelConfig?.connected ? `${currentModelConfig.model} 思考中…` : "模型未连接";

  const filesForThisTurn = [...attachedFiles];
  const attachmentsForMsg: MessageAttachment[] = filesForThisTurn
    .filter((f) => (f.kind === "image" || f.kind === "document") && typeof f.filePath === "string")
    .map((f) => {
      if (f.kind === "image") {
        return {
          kind: "image",
          name: f.name,
          filePath: f.filePath!,
          mime: f.mime || "application/octet-stream",
          previewUrl: f.previewUrl,
          caption: f.caption,
          hasAnnotations: f.hasAnnotations,
          status: f.status || "pending",
        };
      }
      return {
        kind: "document",
        name: f.name,
        filePath: f.filePath!,
        status: f.status || "pending",
      };
    });

  const stickerMatch = text.match(/\[sticker:([^\]]+)\]/);
  const userStickerId = stickerMatch ? stickerMatch[1] : null;

  const userMsg: Message = {
    id: String(Date.now()),
    role: "user",
    content: text,
    at: Date.now(),
    attachments: attachmentsForMsg.length > 0 ? attachmentsForMsg : undefined,
    modelContext: undefined,
    sticker: userStickerId,
  };
  messages.push(userMsg);
  inputEl.value = "";
  autosize();
  removeAttachedFiles();
  void saveSession();
  render();

  const hintsByKind: string[] = [];
  const modelContextParts: string[] = [];
  let hasDocumentContext = false;
  let hasImageCaptionContext = false;
  let hasDirectImageContext = false;
  let hasUserAnnotationContext = false;
  const appendDocumentContext = (lines: string[]) => {
    if (lines.length === 0) return;
    if (!hasDocumentContext) {
      modelContextParts.push(`【文档内容】\n${lines.join("\n\n")}`);
      hasDocumentContext = true;
      return;
    }
    modelContextParts.push(...lines);
  };
  const appendImageCaptionContext = (line: string) => {
    if (!hasImageCaptionContext) {
      modelContextParts.push("【图片视觉信息】\n以下内容是视觉模型对用户本轮图片的观察结果，请将其视为你已经看到的图片内容；如果某张图分析失败，请不要编造。\n" + line);
      hasImageCaptionContext = true;
      return;
    }
    modelContextParts.push(line);
  };
  const appendDirectImageContext = (line: string) => {
    if (!hasDirectImageContext) {
      modelContextParts.push("【图片附件】\n以下图片已随本轮消息直接发送给主模型，请直接结合图片内容回答。\n" + line);
      hasDirectImageContext = true;
      return;
    }
    modelContextParts.push(line);
  };
  const appendUserAnnotationContext = () => {
    if (hasUserAnnotationContext) return;
    const notice = userAnnotationNotice(true);
    if (notice) modelContextParts.push(`【用户截图标注】\n${notice}`);
    hasUserAnnotationContext = true;
  };
  const directImageAttachments: { name: string; filePath: string; mime?: string }[] = [];
  let budgetUsed = 0;
  const budgetExceeded: string[] = [];
  const documentFilesForThisTurn = filesForThisTurn.filter((f) => f.kind === "document" && typeof f.filePath === "string");
  const imageFilesForThisTurn = filesForThisTurn.filter((f) => f.kind === "image");

  if (documentFilesForThisTurn.length > 0) {
    showTransientStatus("正在分析文档...");
    try {
      let waitMessage: Message | null = null;
      const processedDocs = await processDocumentsWithWait({
        processDocuments: async (filePaths, query) => window.chat?.processDocuments(filePaths, query) ?? [],
        filePaths: documentFilesForThisTurn.map((f) => f.filePath!),
        query: text,
        onWaitStart: (content) => {
          waitMessage = {
            id: `document-wait-${Date.now()}`,
            role: "model",
            content,
            at: Date.now(),
            transient: true,
          };
          messages.push(waitMessage);
          render();
        },
        onWaitEnd: () => {
          if (!waitMessage) return;
          const index = messages.indexOf(waitMessage);
          if (index >= 0) messages.splice(index, 1);
          waitMessage = null;
          render();
        },
      });
      for (const f of documentFilesForThisTurn) {
        const result = processedDocs.find((doc) => doc.filePath === f.filePath)
          ?? processedDocs.find((doc) => doc.name === f.name)
          ?? {
            name: f.name,
            kind: "unsupported" as const,
            filePath: f.filePath,
            reason: "文档处理未返回结果",
          };
        const msgAtt = userMsg.attachments?.find((att): att is DocumentMessageAttachment =>
          att.kind === "document" && att.filePath === f.filePath
        );
        const processedKind = result.kind === "text" || result.kind === "indexed" || result.kind === "empty" || result.kind === "unsupported"
          ? result.kind
          : "unsupported";
        if (msgAtt) {
          msgAtt.processedKind = processedKind;
          msgAtt.chunks = result.chunks;
          msgAtt.importId = result.kind === "indexed" ? result.importId : undefined;
          msgAtt.reason = result.reason;
        }

        if (result.kind === "text") {
          if (msgAtt) msgAtt.status = "done";
          const docText = result.text || "";
          const remaining = BUDGET_CHARS - budgetUsed;
          if (remaining <= 0) {
            budgetExceeded.push(result.name);
            hintsByKind.push(`📝 ${result.name}（附件，内容因一轮预算限制未注入）`);
          } else if (docText.length > remaining) {
            const clipped = docText.slice(0, remaining);
            appendDocumentContext([`文档 ${result.name} 内容节选：\n${clipped}`]);
            budgetExceeded.push(result.name);
            budgetUsed = BUDGET_CHARS;
            hintsByKind.push(`📝 ${result.name}（附件，内容已按预算节选注入本轮上下文）`);
          } else {
            appendDocumentContext([`文档 ${result.name} 内容：\n${docText}`]);
            budgetUsed += docText.length;
            hintsByKind.push(`📝 ${result.name}（附件，内容已注入本轮上下文）`);
          }
        } else if (result.kind === "indexed") {
          if (result.reason && (result.chunks ?? 0) <= 0) {
            if (msgAtt) msgAtt.status = "error";
            hintsByKind.push(`⚠️ ${result.name}（文档处理失败）`);
            appendDocumentContext(buildDocumentContextLines([result]));
          } else {
            if (msgAtt) msgAtt.status = "done";
            hintsByKind.push(`📚 ${result.name}（已索引 ${result.chunks ?? 0} 段）`);
            appendDocumentContext(buildDocumentContextLines([result]));
          }
        } else if (result.kind === "empty") {
          if (msgAtt) msgAtt.status = "done";
          hintsByKind.push(`📄 ${result.name}（为空）`);
          appendDocumentContext(buildDocumentContextLines([result]));
        } else {
          const reason = result.reason || "暂不支持或无法读取";
          if (msgAtt) msgAtt.status = reason === "cancelled" ? "cancelled" : "error";
          hintsByKind.push(`⚠️ ${result.name}（暂不支持或处理失败）`);
          appendDocumentContext(buildDocumentContextLines([{ ...result, reason }]));
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      for (const f of documentFilesForThisTurn) {
        const msgAtt = userMsg.attachments?.find((att): att is DocumentMessageAttachment =>
          att.kind === "document" && att.filePath === f.filePath
        );
        if (msgAtt) {
          msgAtt.status = "error";
          msgAtt.processedKind = "unsupported";
          msgAtt.reason = reason;
        }
        hintsByKind.push(`⚠️ ${f.name}（文档处理失败）`);
        appendDocumentContext(buildDocumentContextLines([{ kind: "error", name: f.name, reason }]));
      }
    } finally {
      hideTransientStatus();
      void saveSession();
      render();
    }
  }

  let imageSendStrategy: { mode: "direct" | "caption" } = { mode: "caption" };
  if (imageFilesForThisTurn.length > 0) {
    try {
      imageSendStrategy = await window.chat.getImageSendStrategy();
    } catch (err) {
      console.warn("[Cyrene Chat] 获取图片发送策略失败，回退 caption:", err);
    }
  }
  const shouldCaptionImages = imageFilesForThisTurn.length > 0 && imageSendStrategy.mode !== "direct";
  if (shouldCaptionImages) showTransientStatus("正在分析图片...");
  try {
    for (const f of filesForThisTurn) {
      switch (f.kind) {
        case "document":
          break;
        case "image": {
          const msgAtt = userMsg.attachments?.find((att) => att.filePath === f.filePath);
          if (f.hasAnnotations) appendUserAnnotationContext();
          if (!f.filePath) {
            f.status = "error";
            f.reason = "缺少图片路径";
            if (msgAtt) msgAtt.status = "error";
            appendImageCaptionContext(`- ${f.name}：图片分析失败：缺少图片路径。请诚实说明暂时无法看清这张图。`);
            break;
          }
          if (imageSendStrategy.mode === "direct") {
            f.status = "done";
            if (msgAtt) msgAtt.status = "done";
            directImageAttachments.push({ name: f.name, filePath: f.filePath, mime: f.mime });
            appendDirectImageContext(`- ${f.name}：图片已随本轮消息直接发送给主模型。`);
            break;
          }
          const result = await window.chat?.captionImage(f.filePath, f.hasAnnotations === true);
          if (result?.ok && result.caption) {
            f.status = "done";
            f.caption = result.caption;
            if (msgAtt) {
              msgAtt.status = "done";
              msgAtt.caption = result.caption;
            }
            appendImageCaptionContext(`- ${f.name}：${result.caption}`);
          } else {
            f.status = "error";
            f.reason = result?.error || "图片分析失败";
            if (msgAtt) msgAtt.status = "error";
            appendImageCaptionContext(`- ${f.name}：图片分析失败：${f.reason}。请诚实说明暂时无法看清这张图。`);
          }
          break;
        }
        case "unsupported":
          hintsByKind.push(`⚠️ ${f.name}（暂不支持：${f.reason || ""}）`);
          break;
      }
    }
  } finally {
    if (shouldCaptionImages) hideTransientStatus();
  }
  if (budgetExceeded.length > 0) {
    hintsByKind.push(`⚠️ ${budgetExceeded.join("、")} 已省略部分内容（超一轮预算）`);
  }
  if (hintsByKind.length > 0) {
    modelContextParts.unshift("【本轮文件】\n" + hintsByKind.join("\n"));
  }
  userMsg.modelContext = modelContextParts.join("\n\n");
  void saveSession();
  render();

  let streamMsgId = "";
  try {
    streamMsgId = String(Date.now() + 1);
    const streamMsg = { id: streamMsgId, role: "model", content: "", at: Date.now(), thinking: true, transient: true };
    messages.push(streamMsg);
    render();

    let streamContent = "";
    let ttsContent = "";
    let autoSpeakTriggered = false;
    const earlyMinimaxPlayback = createEarlyMinimaxPlayback();
    textMouthStarted = false;
    let pendingTtsCachePromise: Promise<{ cacheKey: string } | null> | null = null;
    let sticker: string | null = null;
    let pendingWeatherCard: Record<string, unknown> | null = null;
    let pendingMusicCard: MusicCardData | null = null;

    // 终态信号：由事件流的 RUN_FINISHED/RUN_ERROR 触发 resolve，
    // 不依赖 invoke 的 resolve（invoke 只做 ack，可能与事件投递存在顺序竞争）。
    let finishRun!: () => void;
    let failRun!: (err: Error) => void;
    const runDone = new Promise<void>((resolve, reject) => {
      finishRun = resolve;
      failRun = reject;
    });

    // AG-UI 事件流：订阅 window.agui.onEvent，按事件类型渲染
    // 主进程在 FC 完成后瞬间把所有 delta 发完，渲染端用"回放队列"按固定节奏逐字显示，
    // 营造真流式感。流式中的气泡用增量 span 追加 + CSS 渐显，不调 render() 全量重建。
    const deltaQueue: string[] = [];
    let streamSession: StreamingMarkdownSession | null = null;
    let playbackTimer: number | null = null;
    let runFinishedArrived = false;
    let startNextStreamingBubble = false;
    let streamingBubbleCount = 1;
    const allowStreamingBubbleSplit = shouldSegmentAssistantReply(isChatMode() ? "chat" : "work", segmentedOutputMode);
    /** 找到当前流式消息的气泡 DOM（TEXT_MESSAGE_START 时 render 过一次，带 data-msg-id）。 */
    const getStreamingBubble = (): HTMLElement | null => {
      return getLastBubbleForMessage(streamMsgId);
    };
    // 终态条件：RUN_FINISHED 到达 AND 回放队列空。两者都满足才 finishRun。
    const tryFinish = (): void => {
      if (runFinishedArrived && deltaQueue.length === 0 && playbackTimer === null) {
        finishRun();
      }
    };
    const startPlayback = (): void => {
      if (playbackTimer !== null) return;
      playbackTimer = window.setInterval(() => {
        const next = deltaQueue.shift();
        if (next !== undefined) {
          streamContent += next;
          // 增量追加 span 到气泡，CSS 渐显。不调 render()，避免全量重建卡顿。
          const bubble = startNextStreamingBubble
            ? (appendBubbleForMessage(streamMsgId) ?? getStreamingBubble())
            : getStreamingBubble();
          startNextStreamingBubble = false;
          if (bubble) {
            if (!streamSession) {
              streamSession = createStreamingMarkdownSession(getMd(), bubble, streamMsgId, messagesEl);
            }
            streamSession.append(next);
          }
          if (
            allowStreamingBubbleSplit
            && streamingBubbleCount < MAX_ASSISTANT_REPLY_BUBBLES
            && shouldBreakStreamingBubbleAfterChar(next)
          ) {
            startNextStreamingBubble = true;
            streamingBubbleCount += 1;
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
          return;
        }
        // 队列空了
        if (playbackTimer !== null) { clearInterval(playbackTimer); playbackTimer = null; }
        tryFinish();
      }, 40);
    };
    const offEvent = registerAguiListener((rawEvent) => {
      try {
        const event = rawEvent as AguiBaseEvent;
        const msg = messages.find(m => m.id === streamMsgId);
        switch (event.type) {
          case "TOOL_CALL_START": {
            // 工具调用开始：在 thinking 气泡里显示"🔧 调用中：xxx"，替换三个点
            const bubble = getStreamingBubble();
            if (bubble) {
              bubble.classList.remove("msg__bubble--thinking");
              bubble.replaceChildren();
              const tip = document.createElement("div");
              tip.className = "msg__tool-tip";
              tip.dataset.toolCallId = event.toolCallId ?? "";
              const icon = document.createElement("span");
              icon.className = "msg__tool-icon";
              icon.textContent = "🔧";
              const text = document.createElement("span");
              text.className = "msg__tool-text";
              text.textContent = "调用中：" + (event.toolCallName ?? "工具");
              tip.appendChild(icon);
              tip.appendChild(text);
              bubble.appendChild(tip);
            }
            break;
          }
          case "TOOL_CALL_END": {
            // 工具调用完成：把"调用中"改成"完成"，淡出准备让位给文字
            const bubble = getStreamingBubble();
            if (bubble) {
              const tip = bubble.querySelector(".msg__tool-tip");
              if (tip) {
                const textEl = tip.querySelector(".msg__tool-text");
                if (textEl) textEl.textContent = "已完成";
                tip.classList.add("msg__tool-tip--done");
              }
            }
            break;
          }
          case "TEXT_MESSAGE_START":
            // 切换 thinking 点 → 空气泡，render 一次建立 DOM（带 data-msg-id）
            // 工具提示（若有）会被 render 重建清掉，自然过渡到文字
            if (msg) { msg.thinking = false; render(); }
            break;
          case "TEXT_MESSAGE_CONTENT":
            if (event.delta) {
              ttsContent += event.delta;
              earlyMinimaxPlayback.append(ttsContent);
              deltaQueue.push(...Array.from(event.delta));
              if (!textMouthStarted) {
                void loadTtsSettings().then((settings) => {
                  if (settings && !settings.ttsAutoRead) {
                    startTextModeMouth();
                  }
                });
              }
              if (msg) { msg.thinking = false; }
              startPlayback();
            }
            break;
          case "TEXT_MESSAGE_END":
            // 全文 delta 已收齐时，ttsContent 已经同步累加完整；UI 的 streamContent 仍按 40ms 逐字回放。
            // 这样声音可尽早开始，且不受前端打字动画队列影响。
            if (!autoSpeakTriggered && ttsContent.trim()) {
              autoSpeakTriggered = true;
              pendingTtsCachePromise = earlyMinimaxPlayback.finish(ttsContent);
            }
            break;
          case "CUSTOM":
            // 主进程发的自定义事件：sticker / 天气卡片 / 任务清单 / 选择卡片
            if (event.name === "cyrene.sticker") {
              sticker = (event.value as StickerId | null) ?? null;
            } else if (event.name === "cyrene.weather") {
              // 暂存天气数据，等 runDone 后 render 再插入（避免 render 的 replaceChildren 清掉卡片）
              console.log("[Chat] 收到天气卡片数据:", JSON.stringify(event.value)?.slice(0, 100));
              pendingWeatherCard = event.value as Record<string, unknown>;
            } else if (event.name === "cyrene.music") {
              pendingMusicCard = normalizeMusicCardData(event.value);
            } else if (event.name === "cyrene.todos") {
              renderTodoPanel(event.value as TodoState | null);
            } else if (event.name === "cyrene.choice") {
              // 选择卡片：立即插入聊天流（不等 runDone，因为要即时交互）
              const choiceData = event.value;
              const card = isAskClarificationCard(choiceData)
                ? buildAskClarificationCardEl(choiceData)
                : buildChoiceCardEl(choiceData as {
                    id: string;
                    question: string;
                    options: Array<{ label: string; value: string; description?: string }>;
                    default?: string;
                  });
              messagesEl.appendChild(card);
              messagesEl.scrollTop = messagesEl.scrollHeight;
            } else if (event.name === "cyrene.taskPlan") {
              renderPlanCard(event.value);
            }
            break;
          case "RUN_FINISHED":
            // 终态信号到达，但要等回放队列空才真正 finishRun（保证流式播完）
            runFinishedArrived = true;
            tryFinish();
            break;
          case "RUN_ERROR":
            failRun(new AgentRenderError(event.code, event.message ?? "模型请求失败"));
            break;
          default:
            // TOOL_CALL_* / STEP_* 暂不在 UI 处理（骨架阶段）
            break;
        }
      } catch (err) {
        console.error("[Chat] onEvent回调抛错:", err);
      }
    });

    // invoke 只确认"已发起"，不等 Observable 结束。
    // 真正的完成由事件流 RUN_FINISHED/RUN_ERROR 驱动（await runDone）。
    const modelMessages = buildModelMessages();
    const ack = await window.agui!.run({
      messages: modelMessages,
      userTurnId: userMsg.id,
      assistantTurnId: streamMsgId,
      styleId: getCurrentStyleId(),
      executionMode: isChatMode() ? "chat" : "work",
      sessionId: currentSessionId || undefined,
      imageAttachments: directImageAttachments.length > 0 ? directImageAttachments : undefined,
    });
    if (!ack.success) {
      offEvent();
      throw new Error(ack.error || "模型请求发起失败");
    }
    if (clearModelContexts()) void saveSession();

    // 等事件流终态
    await runDone;
    offEvent();

    // flush + dispose 流式 Markdown session（终态 render 会全量重建）
    if (streamSession) {
      streamSession.flush();
      streamSession.dispose();
      streamSession = null;
    }

    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      msg.transient = false;
      msg.content = streamContent;
      msg.sticker = sticker;
      msg.musicCard = pendingMusicCard ?? undefined;
    }
    void saveSession();
    const finishedMsgId = streamMsgId;
    void pendingTtsCachePromise?.then((cache) => {
      if (!cache) return;
      const latestMsg = messages.find(m => m.id === finishedMsgId);
      if (!latestMsg) return;
      latestMsg.ttsCacheKey = cache.cacheKey;
      void saveSession();
    });
    render();
    // 天气卡片在 render 后追加到末尾（模型回复之后）
    if (pendingWeatherCard) {
      console.log("[Chat] 插入天气卡片");
      const card = buildWeatherCardEl(pendingWeatherCard);
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      pendingWeatherCard = null;
    }
    // TTS 已在 TEXT_MESSAGE_END 时触发，这里不再重复朗读
  } catch (err) {
    const message = err instanceof Error ? err.message : "模型请求失败";
    const code = err instanceof AgentRenderError ? err.code : undefined;
    const userMessage = classifyAgentError(code, message);
    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      msg.transient = false;
      msg.content = userMessage;
    } else {
      messages.push({
        id: String(Date.now() + 2),
        role: "model",
        content: userMessage,
        at: Date.now(),
      });
    }
    void saveSession();
    render();  } finally {
    sending = false;
    sendBtn.disabled = false;
    chatHintEl.textContent = formatModelHint(currentModelConfig);
    inputEl.focus();
    void flushPendingProactiveReload();
  }
}
function clearChat(): void {
  if (sending) return;
  if (messages.length === 0) return;
  const ok = window.confirm("清空当前对话？");
  if (!ok) return;
  messages.length = 0;
  void saveSession();
  render();
}

/* ===== Window controls ===== */
minBtn.addEventListener("click", () => {
  window.chat?.minimize();
});
maxBtn.addEventListener("click", () => {
  window.chat?.toggleMaximize();
});
closeBtn.addEventListener("click", () => {
  window.chat?.close();
});

/* ===== Composer ===== */
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  void send();
});

inputEl.addEventListener("input", autosize);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});


/* ===== File upload ===== */
const fileInput = document.getElementById("file-input") as HTMLInputElement | null;
const attachBtn = document.getElementById("attach-btn") as HTMLButtonElement | null;
const screenshotBtn = document.getElementById("screenshot-btn") as HTMLButtonElement | null;
let attachedFiles: Attachment[] = [];
	
// ── path-based 文件摄入 ──
// 路径提取在 preload（webUtils.getPathForFile），renderer 不碰 Electron API。
async function ingestDroppedFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  attachBtn!.disabled = true;
  try {
    const results = await window.chat!.ingestDroppedFiles(files);
    if (results && results.length > 0) attachedFiles = [...attachedFiles, ...results];
    updateFileTags();
  } catch (err: unknown) {
    window.alert("文件摄入失败：" + ((err as Error)?.message || String(err)));
  } finally {
    attachBtn!.disabled = false;
    fileInput!.value = "";
  }
}
	
	function updateFileTags(): void {
	  const container = document.getElementById("file-tags");
	  if (!container) return;
	  container.innerHTML = "";
	  if (attachedFiles.length === 0) {
	    attachBtn?.classList.remove("has-file");
	    return;
	  }
	  attachBtn?.classList.add("has-file");
	  attachedFiles.forEach((f, i) => {
	    const tag = document.createElement("div");
	    tag.className = "chat__file-tag";
	    if (f.kind === "image" && f.previewUrl) {
	      const preview = document.createElement("img");
	      preview.className = "chat__file-tag-preview";
	      preview.src = f.previewUrl;
	      preview.alt = f.name;
	      tag.appendChild(preview);
	    }
	    const label = document.createElement("span");
	    const icon = getAttachmentIcon(f.kind);
	    const detail = formatAttachmentTagDetail(f);
	    label.textContent = `${icon} ${f.name} ${detail}`;
	    const btn = document.createElement("button");
	    btn.type = "button";
	    btn.className = "file-tag-remove";
	    btn.textContent = "×";
	    btn.addEventListener("click", () => {
	      attachedFiles.splice(i, 1);
	      updateFileTags();
	    });
	    tag.appendChild(label);
	    tag.appendChild(btn);
	    container.appendChild(tag);
	  });
	}
	
	attachBtn?.addEventListener("click", () => {
	  fileInput?.click();
	});
	
	fileInput?.addEventListener("change", () => {
	  if (fileInput.files && fileInput.files.length > 0) {
	    void ingestDroppedFiles(Array.from(fileInput.files));
	  }
	});

/* ===== Screenshot ===== */

/** 统一插入图片附件（粘贴和截图按钮共用） */
async function insertImageAttachment(input: {
  base64?: string;
  mime: string;
  filePath?: string;
  previewUrl?: string;
  name?: string;
  hasAnnotations?: boolean;
}): Promise<void> {
  const filePath = input.filePath
    ?? (input.base64
      ? (await window.chat?.saveScreenshotTemp(input.base64, input.mime))?.filePath
      : undefined);
  if (!filePath) throw new Error("SCREENSHOT_FILE_PATH_REQUIRED");

  attachedFiles.push({
    kind: "image",
    name: input.name ?? `截图_${Date.now()}.png`,
    filePath,
    mime: input.mime,
    previewUrl: input.base64
      ? `data:${input.mime};base64,${input.base64}`
      : input.previewUrl,
    hasAnnotations: input.hasAnnotations,
    status: "pending",
  });
  updateFileTags();
}

// 截图按钮 -> 触发主进程截图流程（按钮模式：选区后直接插入，不需要粘贴）
screenshotBtn?.addEventListener("click", () => {
  void window.chat?.startScreenshot();
});

// 按钮模式回调：主进程裁剪完直接发图片过来
window.chat?.onScreenshotInsert?.((data) => {
  void insertImageAttachment({
    mime: data.mime,
    filePath: data.filePath,
    previewUrl: data.previewUrl,
    hasAnnotations: data.hasAnnotations,
    name: `截图_${Date.now()}.png`,
  });
});

// 粘贴监听：检测剪贴板图片 -> 插入附件（热键模式：Alt+Shift+S 截图后 Ctrl+V）
document.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(",")[1] ?? "";
        if (!base64) return;
        try {
          await insertImageAttachment({ base64, mime: blob.type || "image/png" });
        } catch (err) {
          console.error("[Chat] 粘贴图片失败:", err);
        }
      };
      reader.readAsDataURL(blob);
      break; // 只处理第一张图片
    }
  }
});
	
	function removeAttachedFiles(): void {
	  attachedFiles = [];
	  attachBtn?.classList.remove("has-file");
	  const container = document.getElementById("file-tags");
	  if (container) container.innerHTML = "";
	}

/* ===== Drag & drop ===== */
const chatEl = document.querySelector(".chat") as HTMLElement | null;
let dragCounter = 0;

document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragCounter += 1;
  chatEl?.classList.add("chat--drag-over");
});

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});

document.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragCounter -= 1;
  if (dragCounter <= 0) {
    dragCounter = 0;
    chatEl?.classList.remove("chat--drag-over");
  }
});

document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragCounter = 0;
  chatEl?.classList.remove("chat--drag-over");
  // path-based：直接把 dataTransfer.files 传 ingestDroppedFiles，
  // main 侧 fs.statSync 判断文件/文件夹后递归展开。
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    void ingestDroppedFiles(Array.from(files));
  }
});

clearBtn.addEventListener("click", clearChat);



/* ===== Work / Chat switch + style / reasoning dropdowns ===== */
(function() {
  var triggers = document.querySelectorAll(".dropdown-trigger");
  var modeOptions = document.querySelectorAll(".mode-switch__option");
  var menus = {
    "style-dropdown": document.getElementById("style-dropdown"),
    "reasoning-dropdown": document.getElementById("reasoning-dropdown")
  };
  var values = {
    "style-dropdown": document.getElementById("style-val"),
    "reasoning-dropdown": document.getElementById("reasoning-val")
  };

  function selectModeOption(value) {
    const normalized = normalizeDefaultChatMode(value);
    modeOptions.forEach(function(option) {
      const active = (option as HTMLElement).dataset.modeValue === normalized;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  modeOptions.forEach(function(option) {
    option.addEventListener("click", function() {
      selectModeOption((option as HTMLElement).dataset.modeValue);
    });
  });

  // Close all dropdowns
  function closeAll() {
    triggers.forEach(function(t) { t.classList.remove("is-open"); });
    Object.keys(menus).forEach(function(k) {
      if (menus[k]) menus[k].classList.remove("is-open");
    });
  }

  // Open a specific dropdown
  function openDropdown(id, trigger) {
    var menu = menus[id];
    if (!menu) return;
    var rect = trigger.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + "px";
    menu.style.left = rect.left + "px";
    menu.classList.add("is-open");
    trigger.classList.add("is-open");
  }

  function selectDropdownOption(id, value) {
    var menu = menus[id];
    if (!menu) return;
    var target = menu.querySelector('.dm-opt[data-value="' + value + '"]');
    if (!target) return;
    menu.querySelectorAll(".dm-opt").forEach(function(o) { o.classList.remove("is-active"); });
    target.classList.add("is-active");
    var val = values[id];
    if (val) val.textContent = target.textContent?.trim() || "";
  }

  // Trigger click
  triggers.forEach(function(t) {
    t.addEventListener("click", function(e) {
      e.stopPropagation();
      var id = t.getAttribute("data-dropdown");
      var isOpen = t.classList.contains("is-open");
      closeAll();
      if (!isOpen) openDropdown(id, t);
    });
  });

  // Option click
  Object.keys(menus).forEach(function(id) {
    var menu = menus[id];
    if (!menu) return;
    menu.querySelectorAll(".dm-opt").forEach(function(opt) {
      opt.addEventListener("click", function() {
        selectDropdownOption(id, opt.getAttribute("data-value"));
        if (id === "style-dropdown") {
          const styleId = normalizeStyleId(opt.getAttribute("data-value"));
          void window.settings?.saveGeneral?.({ currentStyleId: styleId });
        }
        closeAll();
      });
    });
  });

  // ── 推理下拉：动态生成 ──────────────────────────────
  let reasoningDropdownActive = false;
  let reasoningProviderKey = "";
  let reasoningDropdownDisabled = false;
  let reasoningActivePreference: unknown = null;

  async function rebuildReasoningDropdown() {
    try {
      const state = await window.chat!.getReasoningState() as {
        providerKey: string; providerId: string; model: string;
        preference?: { mode: string; effort?: string };
      };
      reasoningProviderKey = state.providerKey;
      // 动态 import 纯函数（vite tree-shake 后仍可执行）
      const { computeReasoningDropdown, formatReasoningTriggerLabel } = await import("./reasoning-dropdown");
      const view = computeReasoningDropdown(state.providerId, state.model, state.preference);
      reasoningDropdownDisabled = view.disabled;
      reasoningActivePreference = view.activePreference;

      // 填充下拉项
      const menu = menus["reasoning-dropdown"];
      if (!menu) return;
      // 保留 dm-title，清空后续所有 dm-opt
      const title = menu.querySelector(".dm-title");
      menu.replaceChildren();
      if (title) menu.appendChild(title);

      for (const item of view.items) {
        const opt = document.createElement("div");
        opt.className = "dm-opt";
        opt.dataset.reasoningPreference = JSON.stringify(item.preference);
        opt.textContent = item.label;
        if (item.disabled) {
          opt.classList.add("is-disabled");
          opt.style.opacity = "0.4";
          opt.style.pointerEvents = "none";
        }
        if (item.hint) opt.title = item.hint;
        // 当前选中
        if (JSON.stringify(item.preference) === JSON.stringify(view.activePreference)) {
          opt.classList.add("is-active");
        }
        // disabled item 不绑 click
        if (item.disabled) {
          opt.addEventListener("click", (e) => e.stopPropagation());
        } else {
          opt.addEventListener("click", () => {
            if (!window.chat) return;
            window.chat.setReasoning({
              providerKey: reasoningProviderKey,
              preference: item.preference,
            }).then(() => {
              reasoningActivePreference = item.preference;
              menu.querySelectorAll(".dm-opt").forEach(o => o.classList.remove("is-active"));
              opt.classList.add("is-active");
              const val = values["reasoning-dropdown"];
              if (val) val.textContent = formatReasoningTriggerLabel(item.label);
              closeAll();
            }).catch(() => {});
          });
        }
        menu.appendChild(opt);
      }

      // 更新触发按钮文案
      const val = values["reasoning-dropdown"];
      if (val && view.statusText) {
        val.textContent = formatReasoningTriggerLabel(view.statusText);
        // dm-title hidden when dropdown is active (view controls visualization)
        const title2 = menu.querySelector(".dm-title") as HTMLElement | null;
        if (title2) title2.style.display = "";
      }
      reasoningDropdownActive = true;
    } catch {
      // 失败安全占位（用户修正 #4）：塞入 disabled "跟随模型"
      reasoningDropdownDisabled = true;
      reasoningDropdownActive = false;
      const menu = menus["reasoning-dropdown"];
      if (menu) {
        const title = menu.querySelector(".dm-title");
        menu.replaceChildren();
        if (title) menu.appendChild(title);
        const opt = document.createElement("div");
        opt.className = "dm-opt is-disabled";
        opt.textContent = "跟随模型";
        opt.style.opacity = "0.4";
        opt.style.pointerEvents = "none";
        opt.title = "推理控制暂时不可用";
        menu.appendChild(opt);
      }
      const val = values["reasoning-dropdown"];
      if (val) val.textContent = "推理 · 跟随模型";
    }
  }

  // 初始加载
  void rebuildReasoningDropdown();

  // trigger 点击时先重渲染（model 可能已切换）
  const reasoningTrigger = document.querySelector<HTMLElement>('.dropdown-trigger[data-dropdown="reasoning-dropdown"]');
  if (reasoningTrigger) {
    reasoningTrigger.addEventListener("click", async (e) => {
      if (reasoningDropdownDisabled) {
        e.stopImmediatePropagation(); // 当控件 disabled 时阻止原 handler 打开下拉
        return;
      }
      await rebuildReasoningDropdown();
      // 不阻止原 handler：原 handler 会 closeAll() + openDropdown(id, t)
    }, true); // capture phase: 在原 handler (bubble 注册) 之前执行
  }

  void window.chat?.getGeneralSettings?.()
    .then(function(settings) {
      selectModeOption(settings?.defaultChatMode);
      selectDropdownOption("style-dropdown", normalizeStyleId(settings?.currentStyleId));
      segmentedOutputMode = settings?.segmentedOutputMode === "chat" || settings?.segmentedOutputMode === "off"
        ? settings.segmentedOutputMode
        : settings?.segmentedOutputMode === "all" ? "all" : "off";
      render(true);
    })
    .catch(function() {
      selectModeOption("work");
      segmentedOutputMode = "off";
      render(true);
    });

  // Click outside closes
  document.addEventListener("click", closeAll);
})();


/* ===== Floating particles (dreamy pink motes) =====
   在 .chat 容器底层画一组缓慢上飘的粉紫色光斑，颜色与全站 pink/violet
   主题一致，配 twinkle 闪烁。canvas 在 HTML 里绝对定位、pointer-events:none，
   所以不影响输入/点击/滚动。 */
interface Particle {
  x: number;
  y: number;
  size: number;
  vx: number;
  vy: number;
  hue: number;
  alpha: number;
  twinkle: number;
  twinkleSpeed: number;
}

const PARTICLE_COUNT = 38;
const PARTICLE_HUE_MIN = 305; // pink
const PARTICLE_HUE_MAX = 345; // violet

const particlesCanvas = document.getElementById("particles") as HTMLCanvasElement | null;
const particlesCtx = particlesCanvas ? particlesCanvas.getContext("2d") : null;
let particles: Particle[] = [];
let particlesDpr = 1;
let particlesW = 0;
let particlesH = 0;
let particlesRaf: number | null = null;

function spawnParticle(): Particle {
  return {
    x: Math.random() * particlesW,
    y: Math.random() * particlesH,
    size: 0.6 + Math.random() * 2.4,
    vx: (Math.random() - 0.5) * 0.18,
    vy: -0.05 - Math.random() * 0.22,
    hue: PARTICLE_HUE_MIN + Math.random() * (PARTICLE_HUE_MAX - PARTICLE_HUE_MIN),
    alpha: 0.25 + Math.random() * 0.5,
    twinkle: Math.random() * Math.PI * 2,
    twinkleSpeed: 0.005 + Math.random() * 0.012,
  };
}

function resizeParticles(): void {
  if (!particlesCanvas || !particlesCtx) return;
  const rect = particlesCanvas.getBoundingClientRect();
  particlesDpr = window.devicePixelRatio || 1;
  particlesW = rect.width;
  particlesH = rect.height;
  particlesCanvas.width = Math.max(1, Math.round(rect.width * particlesDpr));
  particlesCanvas.height = Math.max(1, Math.round(rect.height * particlesDpr));
  particlesCtx.setTransform(particlesDpr, 0, 0, particlesDpr, 0, 0);
}

function drawParticles(): void {
  if (!particlesCtx) return;
  particlesCtx.clearRect(0, 0, particlesW, particlesH);
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.twinkle += p.twinkleSpeed;
    if (p.y < -10) {
      p.y = particlesH + 10;
      p.x = Math.random() * particlesW;
    }
    if (p.x < -10) p.x = particlesW + 10;
    if (p.x > particlesW + 10) p.x = -10;

    const flicker = 0.65 + Math.sin(p.twinkle) * 0.35;
    const a = p.alpha * flicker;
    const r = p.size * 3;
    const grad = particlesCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    grad.addColorStop(0, `hsla(${p.hue}, 90%, 80%, ${a})`);
    grad.addColorStop(0.5, `hsla(${p.hue}, 90%, 70%, ${a * 0.4})`);
    grad.addColorStop(1, `hsla(${p.hue}, 90%, 70%, 0)`);
    particlesCtx.fillStyle = grad;
    particlesCtx.beginPath();
    particlesCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
    particlesCtx.fill();
  }
  particlesRaf = requestAnimationFrame(drawParticles);
}

if (particlesCtx) {
  resizeParticles();
  particles = Array.from({ length: PARTICLE_COUNT }, spawnParticle);
  particlesRaf = requestAnimationFrame(drawParticles);
  window.addEventListener("resize", resizeParticles);
}


// 启动：迁移老 localStorage → 选会话 → render
// 先把用户贴纸目录拉到内存，再 bootstrap 渲染历史消息——否则首屏里
// 纯贴纸消息（气泡已隐藏）会因 enabledStickers 还没加载而渲染成空白。
void (async () => {
  await loadEnabledStickers();
  await bootstrap();
  buildQuickPresets();
  installSchedulerEventListener();
  void initModelConfig();
})();

window.addEventListener("beforeunload", () => {
  for (const off of [...activeAguiOffs]) off();
  schedulerEventsOff?.();
  schedulerEventsOff = null;
  stopCurrentTts();
  if (particlesRaf !== null) cancelAnimationFrame(particlesRaf);
  particlesRaf = null;
  window.removeEventListener("resize", resizeParticles);
});

// main → renderer：权限审批请求（per-action 档位下工具调用前）
// 插入一张审批卡片到聊天流；用户点同意/拒绝后回传给主进程。
window.settings?.onPermissionApprovalRequest?.((req) => {
  console.log("[Cyrene/Chat] permission approval request:", req.id, req.toolId);
  const card = buildApprovalCardEl(req);
  messagesEl.appendChild(card);
  // 滚动到底部让用户看到
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

// main → renderer：设置面板点列表/新对话时，让窗口切到指定 session
window.chatStore?.onSwitchSession(async (sessionId) => {
  if (!window.chatStore) return;
  if (sessionId === currentSessionId) return;
  const session = await window.chatStore.get(sessionId);
  if (session) loadSessionIntoUI(session);
});

// 任意会话变动后 main 广播——两种处理：
// 1. 当前活跃会话被外部删了 → fallback 到最新一条 / 自动建新
// 2. 侧栏展开时刷新列表（别的窗口新建/改名/删除都会触发）
window.chatStore?.onChanged(async () => {
  if (!window.chatStore || !currentSessionId) return;
  const sessions = await window.chatStore.list();
  for (const session of sessions) {
    const seenAt = seenSessionUpdatedAt.get(session.id) ?? 0;
    if (session.purpose === "proactive-chat" && session.id !== currentSessionId && session.updatedAt > seenAt) {
      unreadProactiveSessionIds.add(session.id);
    }
  }
  // 标记未读后再刷新，确保红点在本次变更中立即出现。
  if (chatRail && !chatRail.hidden) void renderRailList();
  const stillExists = await window.chatStore.get(currentSessionId);
  if (stillExists) {
    const decision = decideReloadCurrentSession({
      purpose: stillExists.purpose,
      updatedAt: stillExists.updatedAt,
      seenAt: seenSessionUpdatedAt.get(stillExists.id) ?? 0,
      sending,
    });
    if (decision === "reload") {
      await loadSessionTailIntoUI(stillExists.id);
    } else if (decision === "defer") {
      // 发送期间到达的外部变更：排队，等发送结束 flush（见 send/triggerCyreneGreeting 的 finally）。
      pendingProactiveReloadId = stillExists.id;
    }
    return;
  }
  // 当前会话已被外部删除：fallback 到最新一条 / 自动建新
  const list = sessions;
  let next: ChatStoreSession | null = null;
  if (list.length > 0) next = await window.chatStore.get(list[0].id);
  if (!next) next = await window.chatStore.create({ identityId: null });
  if (next) loadSessionIntoUI(next);
});
autosize();
inputEl.focus();
