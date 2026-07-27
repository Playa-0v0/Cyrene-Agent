import "../ui/base.css";
import "./chat.css";
import "../ui/theme";
import {
  CHAT_DEFAULT_IDENTITY_LABEL,
  formatChatRelativeTime,
  type ChatSessionMetaUI,
} from "../../shared/chat-ui";
import { canUseMinimaxStreamingEarly, extractEarlyTtsSegment } from "../../shared/tts-early-playback";
import { getStickerSrcForId } from "./sticker-src";
import { resolveAsset } from "../../shared/renderer-base";

type Role = "user" | "model";

interface Message {
  id: string;
  role: Role;
  content: string;
  at: number;
  sticker?: string | null;
  thinking?: boolean;
  ttsCacheKey?: string;
}

interface ChatReplyPayload {
  reply: string;
  sticker: string | null;
}

function normalizeChatReplyPayload(payload: unknown): ChatReplyPayload {
  if (typeof payload === "string") {
    return { reply: payload.trim(), sticker: null };
  }

  if (payload && typeof payload === "object") {
    const record = payload as Partial<ChatReplyPayload>;
    return {
      reply: typeof record.reply === "string" ? record.reply.trim() : "",
      sticker: record.sticker ?? null,
    };
  }

  return { reply: "", sticker: null };
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
    sendMessage: (messages: Array<{ role: "user" | "model"; content: string }>, style: string) => Promise<ChatReplyPayload>;
    ingestDroppedFiles: (files: File[]) => Promise<Attachment[]>;
    getEnabledStickers?: () => Promise<Array<{ id: string; src: string; description?: string }>>;
  }

/** AG-UI 事件流 API（window.agui）。 */
const BUDGET_CHARS = 60000;

/* ===== TTS 朗讀按鈕 SVG =====
   靜態版用單條弧線表示喇叭外溢，播放版換成三條音波豎線 + CSS 動畫做波浪。
   顏色全部 currentColor，主題色變了會跟著變；不依賴 emoji 字體。 */
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

/* ===== 複製按鈕 SVG =====
   靜態版兩個重疊方框（標準複製圖標），複製成功版換成對勾 + 文案"已複製"。 */
const COPY_ICON_IDLE = `<svg class="msg__copy-icon msg__copy-icon--idle" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/>
  <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const COPY_ICON_DONE = `<svg class="msg__copy-icon msg__copy-icon--done" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

interface AguiApi {
  run: (input: { messages: unknown[]; style: string; sessionId?: string; attachments?: { name: string; text: string }[] }) => Promise<{ success: boolean; error?: string }>;
  onEvent: (callback: (event: unknown) => void) => () => void;
  cancel: () => Promise<boolean>;
}

interface SchedulerEventsApi {
  onEvent: (callback: (event: unknown) => void) => () => void;
}

/** 用戶選擇卡片 API（window.choice）。卡片展示走 AGUI_EVENT CUSTOM，resolve 走獨立 IPC。 */
interface ChoiceApi {
  resolve: (id: string, value: string) => Promise<unknown>;
}

/** AG-UI BaseEvent 的最小本地類型（只取我們關心的字段）。 */
interface AguiBaseEvent {
  type: string;
  messageId?: string;
  delta?: string;
  role?: string;
  toolCallId?: string;
  toolCallName?: string;
  content?: string;
  error?: string;
  stepName?: string;
  runId?: string;
  threadId?: string;
  schedulerRunId?: string;
  schedulerTaskId?: string;
  name?: string;   // CUSTOM 事件的 name
  value?: unknown; // CUSTOM 事件的 value
}

/** 文件攝入結果（與 main 側 file-ingest.ts 的 Attachment 對齊）。 */
type AttachmentKind = "text" | "indexed" | "empty" | "unsupported";

interface Attachment {
  name: string;
  kind: AttachmentKind;
  text?: string;
  chunks?: number;
  reason?: string;
}

/** 任務清單狀態（todo_write 工具推過來的）。 */
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

declare global {
  interface Window {
    chat?: ChatApi;
    agui?: AguiApi;
    schedulerEvents?: SchedulerEventsApi;
    modelConfig?: ModelConfigApi;
    choice?: ChoiceApi;
  }
}

const messagesEl = document.getElementById("messages") as HTMLElement;
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

// 舊版 localStorage key——首次啟動時檢測到老數據會遷移到主進程 chats 存儲再清掉。
const LEGACY_STORAGE_KEY = "cyrene.chat.history.v1";
const FRONTEND_REPLY_TIMEOUT_MS = 35000;

/**
 * Avatar source per role. Empty string = use the gradient placeholder
 * baked into the CSS background of `.msg--user .msg__avatar`.
 *
 * Model side: 昔漣的 PNG，由 CSS border-radius: 50% 自動裁圓。
 * User side: 暫留空，等設置頁裡上傳用戶頭像後再把 user 改成 file:// 或 data: URL。
 */
const AVATAR_SRC: Record<Role, string> = {
  model: resolveAsset("avatars/cyrene-avatar.png"),
  user: "",
};

// Load user avatar from profile
(async () => {
  try {
    const dataUrl = await (window as any).user?.getAvatar();
    if (dataUrl) {
      AVATAR_SRC.user = dataUrl;
      render();
    }
  } catch { /* ignore */ }
})();

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
  // 內置貼紙路徑以 /stickers/ 開頭（絕對路徑），在 file:// 協議下會解析到磁盤根
  // 用 resolveAsset() 轉成正確的 file:// 或 http:// URL
  if (raw.startsWith("/stickers/")) {
    return resolveAsset(raw);
  }
  return raw;
}

// 多會話改造：messages 是當前活躍 session 的消息數組（啟動時為空，由 bootstrap 填充）。
// currentSessionId 是當前正在顯示的會話 id，所有持久化操作都基於它。
// 啟動期間 currentSessionId 為 null，發送按鈕通過 sending 標誌兜底（bootstrap 極快）。
const messages: Message[] = [];
let currentSessionId: string | null = null;
let currentModelConfig: ModelConfig | null = null;

function formatModelHint(config: ModelConfig | null): string {
  if (!config || !config.connected) return "模型未連接";
  return `${config.model} 已連接`;
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

// ── 多會話存儲橋接 ───────────────────────────────────────────
// 舊版聊天記錄從 localStorage 一次性遷移到主進程 chats 存儲，之後整窗口
// 所有讀寫都走 IPC（window.chatStore）。所有 saveHistory 調用點改成
// saveSession，本質是把 messages 全量回寫當前 session 文件。
// 會話元數據類型用 shared 的 ChatSessionMetaUI（跟設置面板共用）。

interface ChatStoreSession {
  id: string;
  title: string;
  identityId: string | null;
  messages: Array<{
    id: string;
    role: Role;
    content: string;
    at: number;
    sticker?: string | null;
    ttsCacheKey?: string;
  }>;
  createdAt: number;
  updatedAt: number;
  schemaVersion: 1;
}

interface ChatStoreApi {
  list: () => Promise<ChatSessionMetaUI[]>;
  get: (id: string) => Promise<ChatStoreSession | null>;
  create: (payload?: { title?: string; identityId?: string | null }) => Promise<ChatStoreSession>;
  append: (id: string, message: unknown) => Promise<ChatStoreSession | null>;
  replaceMessages: (id: string, messages: unknown[]) => Promise<ChatStoreSession | null>;
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

// 把渲染端 Message 數組歸一化為後端能持久化的形態：
// - 過濾空 content / 渲染中的 thinking 佔位（thinking=true 時通常 content 為空，但保險起見雙重過濾）
// - 丟棄 thinking 字段（持久化層不存這種瞬態狀態）
function toPersistableMessages(arr: Message[]): Array<{
  id: string; role: Role; content: string; at: number; sticker?: StickerId | null; ttsCacheKey?: string;
}> {
  return arr
    .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.content === "string" && m.content.trim() && !m.thinking)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      at: m.at,
      sticker: m.sticker ?? null,
      ttsCacheKey: m.ttsCacheKey,
    }));
}

async function saveSession(): Promise<void> {
  if (!currentSessionId || !window.chatStore) return;
  try {
    await window.chatStore.replaceMessages(currentSessionId, toPersistableMessages(messages));
  } catch (err) {
    console.warn("[Cyrene Chat] saveSession 失敗:", err);
  }
}

// 把 store 裡的 ChatStoreSession 裝載到當前窗口（替換 messages 數組並 render）。
function loadSessionIntoUI(session: ChatStoreSession): void {
  currentSessionId = session.id;
  messages.length = 0;
  for (const m of session.messages) {
    messages.push({
      id: m.id,
      role: m.role,
      content: m.content,
      at: m.at,
      sticker: m.sticker ?? null,
      ttsCacheKey: m.ttsCacheKey,
    });
  }
  // 上報活躍 sessionId（設置面板"刪除當前會話"差異化提示用）
  void window.chatStore?.setActiveSession(session.id);
  render();
  // 切換會話後刷新側欄列表的活躍高亮
  void renderRailList();
  
  // 通知父窗口活躍會話發生變化，以同步工作台的側欄列表高亮
  try {
    window.parent.postMessage({ type: "active-session-changed", sessionId: session.id }, "*");
  } catch (err) { /* ignore */ }
}

// ── 會話側欄（點左上角 loader 展開）──
// 精簡版：+新對話 / 列表點擊切換 / 活躍高亮。改名刪除留設置面板。
// 渲染邏輯跟 settings.ts 的 renderChatSessions 同源（複用 shared 的格式化函數），
// 但點擊行為不同：這裡是本地 loadSessionIntoUI，不走跨窗口 IPC，更快。

async function renderRailList(): Promise<void> {
  if (!chatRailList || !window.chatStore) return;

  let sessions: ChatSessionMetaUI[] = [];
  try {
    sessions = await window.chatStore.list();
  } catch (err) {
    console.warn("[Cyrene Chat] 側欄加載會話列表失敗:", err);
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
  titleEl.textContent = session.title || "新對話";

  const metaEl = document.createElement("div");
  metaEl.className = "chat__rail-meta";

  const timeEl = document.createElement("span");
  timeEl.className = "chat__rail-time";
  timeEl.textContent = formatChatRelativeTime(session.updatedAt);

  const identityEl = document.createElement("span");
  identityEl.className = "chat__rail-identity";
  identityEl.textContent = "💼 " + (session.identityId ? session.identityId : CHAT_DEFAULT_IDENTITY_LABEL);

  metaEl.appendChild(timeEl);
  metaEl.appendChild(identityEl);

  // 點擊列表項 = 本地切換會話（不走跨窗口 IPC，比設置面板還快）
  li.addEventListener("click", async () => {
    if (session.id === currentSessionId) return;
    const full = await window.chatStore?.get(session.id);
    if (full) loadSessionIntoUI(full as ChatStoreSession);
  });

  li.appendChild(titleEl);
  li.appendChild(metaEl);
  return li;
}

// loader 按鈕 toggle 側欄顯隱
chatStatusBtn?.addEventListener("click", () => {
  if (!chatRail) return;
  chatRail.toggleAttribute("hidden");
  // 首次展開時拉一次列表（後續由 onChanged 持續刷新）
  if (!chatRail.hidden) void renderRailList();
});

// +新對話
chatRailNew?.addEventListener("click", async () => {
  if (!window.chatStore) return;
  try {
    const session = await window.chatStore.create({ identityId: null });
    if (session?.id) {
      const full = await window.chatStore.get(session.id);
      if (full) loadSessionIntoUI(full as ChatStoreSession);
    }
  } catch (err) {
    console.warn("[Cyrene Chat] 新建會話失敗:", err);
  }
});

// 一次性遷移：檢測老 localStorage 數據 → 包成 session → 刪 key。
// 失敗/沒數據時靜默 no-op，不影響後續 bootstrap。
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
    console.warn("[Cyrene Chat] 舊 localStorage 遷移失敗:", err);
  } finally {
    // 不管成功失敗都清掉，避免每次啟動都嘗試遷移
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
}

// 啟動流程：遷移老數據 → 決定加載哪個 session → render
async function bootstrap(): Promise<void> {
  if (!window.chatStore) {
    console.warn("[Cyrene Chat] chatStore IPC 未就緒——可能是 preload 未加載");
    render();
    return;
  }

  await maybeMigrateLegacy();

  // 優先級：URL ?sessionId= → 列表最新一條 → 自動建新
  const urlSessionId = new URLSearchParams(window.location.search).get("sessionId");
  let session: ChatStoreSession | null = null;

  if (urlSessionId) {
    session = await window.chatStore.get(urlSessionId);
  }
  if (!session) {
    const list = await window.chatStore.list();
    if (list.length > 0) {
      session = await window.chatStore.get(list[0].id);
    }
  }
  if (!session) {
    session = await window.chatStore.create({ identityId: null });
  }

  loadSessionIntoUI(session);
}

function formatTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 渲染左上角任務進度面板。todos 為空時收起並稍後移除。
 *  面板可收縮/展開：點擊 header 或 toggle 按鈕切換。 */
function renderTodoPanel(state: TodoState | null): void {
  let panel = document.querySelector(".todo-panel") as HTMLElement | null;

  // 空清單：收起動畫後移除
  if (!state || !state.todos || state.todos.length === 0) {
    if (panel) {
      panel.classList.add("empty");
      setTimeout(() => panel?.remove(), 300);
    }
    return;
  }

  // 首次出現：建面板
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
    if (p === "high") return `<span class="todo-badge todo-badge--high">高優先級</span>`;
    if (p === "medium") return `<span class="todo-badge todo-badge--medium">中優先級</span>`;
    if (p === "low") return `<span class="todo-badge todo-badge--low">低優先級</span>`;
    return "";
  };

  const statusIcon = (s: string): string => {
    if (s === "completed") return checkIcon;
    if (s === "in_progress") return "●";
    return "";
  };

  // 檢查當前是否已收縮（保留狀態）
  const wasCollapsed = panel.classList.contains("todo-panel--collapsed");

  panel.innerHTML = `
    <div class="todo-panel__header">
      <div>
        <div class="todo-panel__title">📋 任務進度</div>
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

  // 收縮/展開 toggle
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

/** 構建用戶選擇卡片 DOM 元素（歧義消解器），插入聊天流讓用戶選選項。 */
function buildChoiceCardEl(data: {
  id: string;
  question: string;
  options: Array<{ label: string; value: string; description?: string }>;
  default?: string;
}): HTMLElement {
  const card = document.createElement("div");
  card.className = "choice-card";
  card.dataset.choiceId = data.id;

  // 標題
  const title = document.createElement("div");
  title.className = "choice-card__title";
  title.textContent = data.question;
  card.appendChild(title);

  // 選項列表
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
      // 標記已選，禁用所有按鈕
      card.classList.add("choice-card--resolved");
      card.querySelectorAll<HTMLButtonElement>(".choice-card__option").forEach(b => b.disabled = true);
      btn.classList.add("choice-card__option--selected");
      void window.choice?.resolve(data.id, opt.value);
    });
    list.appendChild(btn);
  }
  card.appendChild(list);

  // 自定義輸入
  const customWrap = document.createElement("div");
  customWrap.className = "choice-card__custom";
  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.className = "choice-card__custom-input";
  customInput.placeholder = "或輸入自定義要求...";
  customWrap.appendChild(customInput);

  const customBtn = document.createElement("button");
  customBtn.type = "button";
  customBtn.className = "choice-card__custom-btn";
  customBtn.textContent = "確認";
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

/** 構建權限審批卡片 DOM 元素（per-action 檔位下工具調用前彈出）。 */
function buildApprovalCardEl(req: {
  id: string;
  toolId: string;
  toolName: string;
  toolDescription: string;
  args: Record<string, unknown>;
  risk: string;
}): HTMLElement {
  const card = document.createElement("div");
  card.className = "approval-card";
  card.dataset.approvalId = req.id;

  // 標題（帶工具名 + 風險標籤）
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

  // 參數摘要（key: value，每行一個，限 5 行防爆窗）
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
      more.textContent = `…還有 ${argsEntries.length - 5} 個參數`;
      argsBlock.appendChild(more);
    }
    card.appendChild(argsBlock);
  }

  // 按鈕行
  const actions = document.createElement("div");
  actions.className = "approval-card__actions";
  const denyBtn = document.createElement("button");
  denyBtn.type = "button";
  denyBtn.className = "approval-card__btn approval-card__btn--deny";
  denyBtn.textContent = "拒絕";
  const allowBtn = document.createElement("button");
  allowBtn.type = "button";
  allowBtn.className = "approval-card__btn approval-card__btn--allow";
  allowBtn.textContent = "允許";
  actions.appendChild(denyBtn);
  actions.appendChild(allowBtn);
  card.appendChild(actions);

  // 提示行（60 秒超時）
  const note = document.createElement("div");
  note.className = "approval-card__note";
  note.textContent = "60 秒未操作自動拒絕";
  card.appendChild(note);

  // 倒計時更新（每秒刷新）
  let remaining = 60;
  const tick = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      note.textContent = "已超時，自動拒絕";
      clearInterval(tick);
      return;
    }
    note.textContent = `${remaining} 秒後自動拒絕`;
  }, 1000);

  const resolve = (allowed: boolean) => {
    clearInterval(tick);
    if (!card.isConnected) return;
    card.classList.add(allowed ? "approval-card--allowed" : "approval-card--denied");
    denyBtn.disabled = true;
    allowBtn.disabled = true;
    note.textContent = allowed ? "已允許" : "已拒絕";
    void window.settings?.resolvePermissionApproval?.(req.id, allowed);
  };

  denyBtn.addEventListener("click", () => resolve(false));
  allowBtn.addEventListener("click", () => resolve(true));

  return card;
}

/** 構建天氣卡片 DOM 元素（不插入，由調用方決定位置）。 */
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
  const icon = String(data.icon ?? "🌤️");
  const windDir = String(data.windDir ?? "");
  const windScale = String(data.windScale ?? "");
  const visibility = data.visibility != null ? `${data.visibility}km` : "—";
  const uv = String(data.uv ?? "—");
  const aqi = data.aqi != null ? Number(data.aqi) : null;
  const aqiText = String(data.aqiText ?? "");
  const kaomoji = aqi != null ? aqiKaomojiText(Number(aqi)) : "";

  card.innerHTML = `
    <div class="w-header">
      <div class="w-datetime"><span class="w-date">${dateStr}</span><span class="w-time">${timeStr} 更新</span></div>
      <div class="w-loc"><span class="w-city">${String(data.city ?? "")}</span><span class="w-adm">${String(data.adm ?? "")}</span></div>
    </div>
    <div class="w-main">
      <div class="w-icon-box"><span class="w-icon">${icon}</span><span class="w-desc">${String(data.text ?? "")}</span></div>
      <div class="w-temp-box">
        <div class="w-temp">${temp}<span class="w-deg">°</span></div>
        ${data.hi != null ? `<div class="w-hilo"><span class="w-hi">↑${data.hi}°</span><span class="w-sep">|</span><span class="w-lo">↓${data.lo}°</span></div>` : ""}
      </div>
    </div>
    <div class="w-feels">體感 ${feelsLike}°C</div>
    <div class="w-quick">
      <div class="w-qitem"><div class="w-qicon">💧</div><div class="w-qlabel">溼度</div><div class="w-qvalue">${humidity}%</div></div>
      <div class="w-qitem"><div class="w-qicon">💨</div><div class="w-qlabel">風力</div><div class="w-qvalue">${windScale}</div></div>
      <div class="w-qitem"><div class="w-qicon">🌧️</div><div class="w-qlabel">降水</div><div class="w-qvalue">${precip}mm</div></div>
      <div class="w-qitem"><div class="w-qicon">📊</div><div class="w-qlabel">氣壓</div><div class="w-qvalue">${pressure || "—"}</div></div>
    </div>
    <button class="w-expand" type="button">查看更多 <span class="w-arrow">▼</span></button>
    <div class="w-details">
      <div class="w-detail-grid">
        <div class="w-ditem"><span class="w-dicon">🌡️</span><div><div class="w-dlabel">體感溫度</div><div class="w-dvalue">${feelsLike}°C</div></div></div>
        <div class="w-ditem"><span class="w-dicon">💨</span><div><div class="w-dlabel">風向風力</div><div class="w-dvalue">${windDir} ${windScale}</div></div></div>
        <div class="w-ditem"><span class="w-dicon">🔆</span><div><div class="w-dlabel">紫外線</div><div class="w-dvalue">${uv}</div></div></div>
        <div class="w-ditem"><span class="w-dicon">👁️</span><div><div class="w-dlabel">能見度</div><div class="w-dvalue">${visibility}</div></div></div>
        ${aqi != null ? `<div class="w-ditem"><span class="w-dicon">🌿</span><div><div class="w-dlabel">空氣質量</div><div class="w-dvalue">${aqi} ${aqiText} <span class="w-kaomoji">${kaomoji}</span></div></div></div>` : ""}
      </div>
    </div>
    <div class="w-source"><span>${icon} ${String(data.source ?? "")}</span><span>${timeStr} 更新</span></div>
  `;

  // 展開按鈕點擊切換
  const expandBtn = card.querySelector(".w-expand") as HTMLButtonElement | null;
  if (expandBtn) {
    expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      card.classList.toggle("expanded");
    });
  }

  return card;
}

/** AQI → 顏文字。 */
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

function buildCodexImageHandoff(request: string): string | null {
  const cleanRequest = request.replace(/\[sticker:[^\]]+\]/g, "").trim();
  if (!cleanRequest) return null;

  const actionPattern = /(幫我|請|想要|可以|能不能|替我|給我|來一張|做一張|生成|產生|畫|繪製|製作)/i;
  const imagePattern = /(圖片|照片|插畫|圖像|繪圖|桌布|壁紙|頭像|立繪|角色圖|anime|image|photo|illustration)/i;
  if (!actionPattern.test(cleanRequest) || !imagePattern.test(cleanRequest)) return null;

  return [
    "請使用 imagegen 技能直接生成圖片。",
    "",
    `原始要求：${cleanRequest}`,
    "",
    "請保留使用者指定的人物、服裝、姿勢、場景、風格與畫面比例；未指定的細節可合理補全。",
    "若要求涉及既有角色，請以使用者在對話中提供的參考圖為準；如參考圖未隨訊息帶入，提醒使用者重新附上。",
    "生成完成後直接顯示圖片，並提供可下載的檔案連結。",
  ].join("\n");
}

function createCodexImageHandoffCard(request: string): HTMLElement | null {
  const handoffPrompt = buildCodexImageHandoff(request);
  if (!handoffPrompt) return null;

  const card = document.createElement("section");
  card.className = "codex-handoff";
  card.setAttribute("aria-label", "交給 Codex 生成圖片");

  const orbit = document.createElement("div");
  orbit.className = "codex-handoff__orbit";
  orbit.setAttribute("aria-hidden", "true");
  orbit.innerHTML = "<span>CY</span><i></i><b>✦</b>";

  const copy = document.createElement("div");
  copy.className = "codex-handoff__copy";
  const eyebrow = document.createElement("span");
  eyebrow.className = "codex-handoff__eyebrow";
  eyebrow.textContent = "IMAGE HANDOFF";
  const title = document.createElement("strong");
  title.textContent = "交給 Codex 繪製";
  const description = document.createElement("small");
  description.textContent = "複製完整委託後，貼到目前的 Codex 對話即可生成。";
  copy.append(eyebrow, title, description);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "codex-handoff__button";
  button.textContent = "複製給 Codex";
  button.addEventListener("click", () => {
    void copyTextToClipboard(handoffPrompt).then((ok) => {
      if (!ok) {
        button.textContent = "複製失敗，請重試";
        button.classList.add("is-error");
        return;
      }
      button.textContent = "已複製 · 到 Codex 貼上";
      button.classList.remove("is-error");
      button.classList.add("is-copied");
      window.setTimeout(() => {
        button.textContent = "複製給 Codex";
        button.classList.remove("is-copied");
      }, 3200);
    });
  });

  card.append(orbit, copy, button);
  return card;
}

function render(): void {
  // 空態：當前會話還沒有消息時（新建/全清）顯示"昔漣期待與你聊天哦 ✨"佔位
  // thinking 狀態（昔漣主動開場/流式回覆中）也算有消息，膠囊應立即消失
  const emptyEl = document.getElementById("chat-empty");
  const hasMessages = messages.some((m) => m.content.trim() || m.thinking);
  if (emptyEl) emptyEl.toggleAttribute("hidden", hasMessages);

  messagesEl.replaceChildren();
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

    const bubble = document.createElement("div");
    bubble.className = "msg__bubble";
    bubble.hidden = false;
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
    } else if (m.role === "user") {
      // 用戶消息：去掉 [sticker:xxx] 標記後顯示純文字
      const cleanText = m.content.replace(/\[sticker:[^\]]+\]/g, "").trim();
      if (cleanText) bubble.textContent = cleanText;
      else bubble.hidden = true; // 純表情包消息不顯示氣泡
    } else {
      // 昔漣消息：檢測是否包含 HTML 互動網頁或小遊戲
      let textContent = m.content;
      let htmlCode = "";
      
      const blockMatch = m.content.match(/```html\s*([\s\S]*?)```/i);
      if (blockMatch) {
        htmlCode = blockMatch[1];
        textContent = m.content.replace(blockMatch[0], "\n\n*(昔漣已為您編寫並加載了以下互動小遊戲，可在下方直接運行遊玩哦 🎮)*\n\n");
      } else {
        const rawHtmlStart = m.content.indexOf("<!DOCTYPE html>");
        if (rawHtmlStart !== -1) {
          htmlCode = m.content.slice(rawHtmlStart);
          textContent = m.content.slice(0, rawHtmlStart) + "\n\n*(昔漣已為您編寫並加載了以下互動小遊戲，可在下方直接運行遊玩哦 🎮)*\n\n";
        }
      }
      
      bubble.textContent = textContent;
      if (htmlCode) {
        (m as any).htmlCodeForSandbox = htmlCode;
      }
    }

    const time = document.createElement("div");
    time.className = "msg__time";
    time.textContent = formatTime(m.at);

    if (!bubble.hidden) body.appendChild(bubble);

    if (m.role === "user" && !m.thinking) {
      const handoffCard = createCodexImageHandoffCard(m.content);
      if (handoffCard) body.appendChild(handoffCard);
    }

    // 如果消息帶有互動網頁或小遊戲，在氣泡下方渲染沙盒卡片
    if ((m as any).htmlCodeForSandbox) {
      const htmlCode = (m as any).htmlCodeForSandbox;
      const sandboxCard = document.createElement("div");
      sandboxCard.className = "sandbox-card";
      
      const header = document.createElement("div");
      header.className = "sandbox-card__header";
      header.innerHTML = `
        <div class="sandbox-card__title">
          <span class="sandbox-card__icon">🎮</span>
          <span>昔漣的互動沙盒</span>
        </div>
        <div class="sandbox-card__actions">
          <button type="button" class="sandbox-tab-btn is-active" data-tab="play">運行</button>
          <button type="button" class="sandbox-tab-btn" data-tab="code">代碼</button>
        </div>
      `;
      
      const contentArea = document.createElement("div");
      contentArea.className = "sandbox-card__content";
      
      const iframeContainer = document.createElement("div");
      iframeContainer.className = "sandbox-play-container";
      const sandboxIframe = document.createElement("iframe");
      sandboxIframe.className = "sandbox-iframe";
      sandboxIframe.sandbox.add("allow-scripts");
      sandboxIframe.srcdoc = htmlCode;
      iframeContainer.appendChild(sandboxIframe);
      
      const codeContainer = document.createElement("div");
      codeContainer.className = "sandbox-code-container is-hidden";
      const pre = document.createElement("pre");
      const codeEl = document.createElement("code");
      codeEl.textContent = htmlCode;
      pre.appendChild(codeEl);
      codeContainer.appendChild(pre);
      
      contentArea.appendChild(iframeContainer);
      contentArea.appendChild(codeContainer);
      
      sandboxCard.appendChild(header);
      sandboxCard.appendChild(contentArea);
      
      const tabs = header.querySelectorAll(".sandbox-tab-btn");
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          tabs.forEach(t => t.classList.remove("is-active"));
          tab.classList.add("is-active");
          
          const tabType = (tab as HTMLElement).dataset.tab;
          if (tabType === "play") {
            iframeContainer.classList.remove("is-hidden");
            codeContainer.classList.add("is-hidden");
          } else {
            iframeContainer.classList.add("is-hidden");
            codeContainer.classList.remove("is-hidden");
          }
        });
      });
      
      body.appendChild(sandboxCard);
    }

    if (m.sticker) {
      const stickerSrc = getStickerSrc(m.sticker);
      if (stickerSrc) {
        const sticker = document.createElement("img");
        sticker.className = "msg__sticker";
        sticker.src = stickerSrc;
        sticker.alt = m.role === "user" ? "用戶表情" : "昔漣表情";
        sticker.draggable = false;
        // <img> 高度異步加載，render() 末尾的滾動會在圖片撐開前就執行，
        // 導致 sticker 底部被輸入框擋住。加載完成後再補一次滾到底。
        sticker.addEventListener("load", () => {
          messagesEl.scrollTop = messagesEl.scrollHeight;
        });
        body.appendChild(sticker);
      }
    }

    // actions 行：喇叭 / 複製 / 時間三個控件水平排在氣泡下方。
    // 沒有可顯示控件的消息（純表情包 / thinking 空內容）跳過整行。
    const actions = document.createElement("div");
    actions.className = "msg__actions";

    let hasActionItem = false;

    // model 消息加 SVG 朗讀按鈕（thinking 中的不顯示）
    if (m.role === "model" && !m.thinking && m.content.trim()) {
      const speakBtn = document.createElement("button");
      speakBtn.type = "button";
      speakBtn.className = "msg__speak";
      speakBtn.title = "朗讀";
      speakBtn.setAttribute("aria-label", "朗讀這條消息");
      // 用 SVG 而不是 emoji，顏色隨主題走，播放時切到波形版
      speakBtn.innerHTML = SPEAK_ICON_IDLE;
      // 點擊邏輯：正在播放則停止，否則開始朗讀（避免重疊）
      speakBtn.addEventListener("click", () => {
        console.log("[TTS] 喇叭點擊, currentTtsAudio=", currentTtsAudio ? "有" : "無");
        if (currentSpeakingMsgId === m.id) {
          // 當前消息正在播放 → 停止並復位 UI
          stopCurrentTts();
          setSpeakingMsgId(null);
        } else {
          void speakMessage(m);
        }
      });
      actions.appendChild(speakBtn);
      hasActionItem = true;
    }

    // 複製按鈕：user / model 都有，thinking / 空內容 / 純表情包跳過
    //   user 複製時去掉 [sticker:xxx] 標記，model 直接複製 content
    if (!m.thinking && m.content.trim()) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "msg__copy";
      copyBtn.title = "複製";
      copyBtn.setAttribute("aria-label", "複製這條消息");
      copyBtn.innerHTML = COPY_ICON_IDLE;
      copyBtn.addEventListener("click", () => {
        const text = m.role === "user"
          ? m.content.replace(/\[sticker:[^\]]+\]/g, "").trim()
          : m.content;
        if (!text) return;
        void copyTextToClipboard(text).then((ok) => {
          if (!ok) return;
          // 視覺反饋：切到對勾 + 文案"已複製"，1.5s 後復原
          copyBtn.classList.add("is-copied");
          copyBtn.innerHTML = COPY_ICON_DONE;
          const label = document.createElement("span");
          label.className = "msg__copy-label";
          label.textContent = "已複製";
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

    // 時間戳總是顯示；哪怕只有一個時間，也用 actions 行保持視覺一致
    actions.appendChild(time);
    hasActionItem = true;

    if (hasActionItem) body.appendChild(actions);

    row.appendChild(avatar);
    row.appendChild(body);
    messagesEl.appendChild(row);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
    msg.content = state.content || state.toolLines.join("\n") || "定時任務運行中…";
    render();
  };

  window.schedulerEvents.onEvent((rawEvent) => {
    const event = rawEvent as AguiBaseEvent;
    if (event.type === "CUSTOM" && event.name === "scheduler.started") {
      const value = event.value as { taskId?: string; title?: string; firedAt?: string; runId?: string } | undefined;
      const runKey = event.schedulerRunId ?? value?.runId ?? `scheduler-${Date.now()}`;
      messages.push({
        id: `scheduler-system-${runKey}`,
        role: "model",
        content: `⏰ 定時任務「${value?.title ?? "未命名任務"}」已觸發`,
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
      state.toolLines.push(`🔧 調用中：${event.toolCallName ?? "工具"}`);
      renderState(state);
    } else if (event.type === "TOOL_CALL_RESULT") {
      const preview = (event.content ?? "").slice(0, 240);
      state.toolLines.push(`✅ 工具結果：${preview || "完成"}`);
      renderState(state);
    } else if (event.type === "TOOL_CALL_END") {
      state.toolLines.push("✅ 工具調用完成");
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
      msg.content = "定時任務執行失敗：" + (event.error ?? event.content ?? "未知錯誤");
      render();
      void saveSession();
      streams.delete(runKey);
    }
  });
}

// ── TTS 朗讀 ──
// 從主進程加載 TTS 配置，按當前引擎調用合成並播放。
// 自動朗讀（回覆完成後觸發）和手動 🔊 按鈕共用此函數。

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
  // 自定義雲端
  ttsCustomCloudEndpointUrl: string;
  ttsCustomCloudApiKey: string;
  ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3";
  ttsCustomCloudTimeoutMs: number;
  // 小米 MiMo
  ttsMimoKey: string;
  ttsMimoVoiceAudioPath: string;
  ttsMimoStylePrompt: string;
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
  // 自定義雲端（返回 base64 + cacheKey + cached + format）
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
  // 流式合成（minimax，邊推 chunk 邊播）
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

// 當前正在播放的 TTS 音頻實例（全局唯一）。點新朗讀前先停這個，避免重疊。
let currentTtsAudio: HTMLAudioElement | null = null;
// 當前正在朗讀的消息 ID，用於給對應消息 row 加 .is-speaking class 並切換喇叭圖標。
// null 表示沒有正在播放。
let currentSpeakingMsgId: string | null = null;
let speechToken = 0;
let textMouthStarted = false;
let ttsPlaybackSequence = 0;

/** 複製文本到剪貼板，優先用現代 Clipboard API，失敗時回落到 textarea+execCommand。 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 權限被拒或無 clipboard 上下文，回落到下面
  }
  // Fallback：臨時 textarea + execCommand('copy')。舊瀏覽器/無焦點時也能用。
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

/** 把正在播放的喇叭按鈕切回靜態 SVG，所有其他按鈕恢復正常。 */
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

/** 在開始朗讀某條消息前調用：清掉舊的、設上新的，並刷新 UI。 */
function setSpeakingMsgId(id: string | null): void {
  currentSpeakingMsgId = id;
  syncSpeakingUi();
  const stopBtn = document.getElementById("stop-speaking-btn");
  if (stopBtn) {
    stopBtn.style.display = id ? "flex" : "none";
  }
}

function stopLive2dMouth(): void {
  speechToken += 1;
  textMouthStarted = false;
  window.live2dSpeech?.stopMouth();
}

function startTextModeMouth(): void {
  if (textMouthStarted || isStudyMode() || isGameMode()) return;
  textMouthStarted = true;
  window.live2dSpeech?.startMouth(TEXT_MODE_MOUTH_DURATION_MS);
}

/** 停止當前正在播放的 TTS 音頻（如果有）。只停 audio，UI 復位由調用方決定。 */
function stopCurrentTts(): void {
  if (currentTtsAudio) {
    currentTtsAudio.pause();
    currentTtsAudio.currentTime = 0;
    currentTtsAudio = null;
  }
  stopLive2dMouth();
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
      ttsStreaming: raw.ttsStreaming !== false,
    };
  } catch {
    return null;
  }
}

// 每次朗讀前重新讀取設置，確保設置頁剛改的模型/音量/自動朗讀開關即時生效。
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
  // 標記喇叭 UI 進入播放態（即使沒傳 msgId 也清掉舊的）
  setSpeakingMsgId(msgId ?? null);

  audio.onended = () => {
    URL.revokeObjectURL(url);
    if (currentTtsAudio === audio) currentTtsAudio = null;
    if (speechToken === token) stopLive2dMouth();
    // 復位喇叭 UI：僅噹噹前記錄的就是這條消息才清，避免覆蓋後啟動的
    if (msgId === undefined || currentSpeakingMsgId === msgId) {
      setSpeakingMsgId(null);
    }
  };

  void (async () => {
    const durationSec = await waitForAudioMetadata(audio);
    try {
      await audio.play();
    } catch (err) {
      console.warn("[TTS] 播放失敗:", err);
      URL.revokeObjectURL(url);
      if (currentTtsAudio === audio) currentTtsAudio = null;
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
 * 流式播放 MiniMax TTS（MediaSource + SourceBuffer 邊收邊播）。
 * 返回 cacheKey（供回寫消息）。失敗時 fallback 到完整合成。
 */
async function streamAndPlayCached(
  settings: TtsSettings,
  text: string,
  existing?: { ttsCacheKey?: string },
  options?: { waitForPlaybackEnd?: boolean },
): Promise<{ cacheKey: string } | null> {
  if (!window.tts) return null;

  stopCurrentTts();  // 先停當前 TTS（含 stopLive2dMouth），再拿 token，否則 token 立刻失效
  const token = nextSpeechToken();
  const t0 = performance.now();  // 診斷時間戳基準（startPolling 閉包要用，必須在 try 外聲明）
  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;
  let audioEl: HTMLAudioElement | null = null;
  const chunkQueue: Uint8Array[] = [];
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

  // 輪詢 flush：每 30ms 檢查一次，能 append 就 append，結束且隊列空就 endOfStream + resolve
  const startPolling = (resolve: (v: { cacheKey: string } | null) => void) => {
    let startedPlayback = false;
    pollTimer = setInterval(() => {
      if (speechToken !== token) {
        cleanup();
        try { mediaSource?.endOfStream(); } catch { /* */ }
        finishStream(null);
        return;
      }
      // append 隊列裡的 chunk（如果 sourceBuffer 空閒）
      if (sourceBuffer && !sourceBuffer.updating && chunkQueue.length > 0) {
        const chunk = chunkQueue.shift()!;
        try {
          sourceBuffer.appendBuffer(chunk);
        } catch {
          chunkQueue.unshift(chunk);
        }
      }
      // 第一塊 append 成功後（buffered 有數據）開始播放
      if (!startedPlayback && sourceBuffer && sourceBuffer.buffered.length > 0 && audioEl && audioEl.paused) {
        startedPlayback = true;
        void audioEl.play().then(() => {
          console.log(`[TTS-Stream] play() 開始 +${Math.round(performance.now() - t0)}ms`);
          if (speechToken !== token) return;
          const estDurationMs = Math.max(2000, Array.from(text).length * 180);
          window.live2dSpeech?.startMouth(estDurationMs);
        }).catch((err) => {
          console.warn("[TTS-Stream] play 失敗:", err);
          markPlaybackEnded();
        });
      }
      // 結束且隊列空 → endOfStream
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
    // 啟動流式合成
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

    // 註冊監聽（只註冊一次）
    let firstChunkAt = 0;
    offChunk = window.tts.onAudioChunk((payload) => {
      if (speechToken !== token) return;
      if (!firstChunkAt) {
        firstChunkAt = performance.now();
        console.log(`[TTS-Stream] 第一個 chunk +${Math.round(firstChunkAt - t0)}ms`);
      }
      const bytes = Uint8Array.from(atob(payload.base64), (c) => c.charCodeAt(0));
      chunkQueue.push(bytes);
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

    // 設置 MediaSource + Audio
    mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    audioEl = new Audio(url);
    currentTtsAudio = audioEl;

    window.live2dSpeech?.prepare();  // stopLive2dMouth 已在開頭 stopCurrentTts 裡調過

    audioEl.onended = () => {
      URL.revokeObjectURL(url);
      if (currentTtsAudio === audioEl) currentTtsAudio = null;
      if (speechToken === token) stopLive2dMouth();
      markPlaybackEnded();
    };

    mediaSource.addEventListener("sourceopen", () => {
      console.log(`[TTS-Stream] sourceopen +${Math.round(performance.now() - t0)}ms`);
      try {
        sourceBuffer = mediaSource!.addSourceBuffer("audio/mpeg");
        sourceBuffer.mode = "sequence";
        console.log(`[TTS-Stream] sourceBuffer 創建成功`);
        // 不立即 play——等輪詢裡第一塊 append 成功（buffered.length>0）再 play
      } catch (err) {
        console.warn("[TTS-Stream] SourceBuffer 創建失敗:", err);
      }
    });

    // 超時兜底（30s）
    setTimeout(() => {
      if (!done) {
        ended = true;
      }
    }, 30000);

    // 等 STREAM_END + 隊列 flush 完
    return await new Promise<{ cacheKey: string } | null>((resolve) => {
      resolveStream = resolve;
      startPolling(resolve);
    });
  } catch (err) {
    console.warn("[TTS] 流式啟動失敗:", err);
    cleanup();
    return null;  // 調用方 fallback 到完整合成
  }
}

async function synthesizeAndPlayCached(
  text: string,
  existing?: { ttsCacheKey?: string },
  msgId?: string,
): Promise<{ cacheKey: string } | null> {
  if (!window.tts) return null;

  // 回聽優先：如果舊消息有 ttsCacheKey，直接嘗試讀緩存文件播放，不需要任何引擎配置。
  // 只有緩存文件不存在、需要合成新音頻時才檢查引擎配置。
  const settings = await loadTtsSettings();
  if (!settings || settings.ttsEngine === "off") return null;

  // 緩存回聽：按 cacheKey 前綴分發到對應引擎的 _CACHED IPC
  // （minimax 緩存走 TTS_SYNTHESIZE_CACHED，gptsovits 緩存走 TTS_SYNTHESIZE_CACHED_GPTSOVITS）
  if (existing?.ttsCacheKey) {
    const isGptsovitsCache = existing.ttsCacheKey.startsWith("gptsovits-");
    const isCustomCloudCache = existing.ttsCacheKey.startsWith("custom-cloud-");
    const isMimoCache = existing.ttsCacheKey.startsWith("mimo-");
    try {
      if (isGptsovitsCache) {
        const result = await window.tts.synthesizeCachedGptsovits({
          baseUrl: "cache-only",        // 佔位，緩存命中不會用到
          refAudioPath: "cache-only",   // 佔位
          promptText: "cache-only",     // 佔位
          text,
          speed: settings.ttsSpeed,
          format: settings.ttsGptsovitsFormat,
          expectedCacheKey: existing.ttsCacheKey,
        });
        if (result.cached) {
          console.log("[TTS] gptsovits 緩存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      } else if (isCustomCloudCache) {
        const result = await window.tts.synthesizeCachedCustomCloud({
          endpointUrl: "cache-only",    // 佔位，緩存命中不會用到
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
          console.log("[TTS] custom-cloud 緩存命中，直接播放");
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
          console.log("[TTS] mimo 緩存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      } else {
        // minimax 緩存回聽（保持原邏輯）
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
          console.log("[TTS] minimax 緩存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      }
    } catch {
      // 緩存讀取失敗，繼續走正常合成流程
    }
  }

  // 需要合成新音頻 → 按 engine 分發
  if (settings.ttsEngine === "minimax") {
    if (!settings.ttsMinimaxKey || !settings.ttsMinimaxVoiceId) {
      console.warn("[TTS] 缺少 apiKey 或 voiceId，無法合成新音頻");
      return null;
    }
    // 流式優先（默認開）：邊合成邊播，首字延遲低；失敗 fallback 完整合成
    if (settings.ttsStreaming) {
      const stream = await streamAndPlayCached(settings, text, existing);
      if (stream) return stream;
      console.warn("[TTS] 流式失敗，fallback 完整合成");
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
      console.warn("[TTS] 合成失敗:", err);
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
      console.warn("[TTS] GPT-SoVITS 合成失敗:", err);
      return null;
    }
  }

  if (settings.ttsEngine === "custom-cloud") {
    if (!settings.ttsCustomCloudEndpointUrl) {
      console.warn("[TTS] 缺少自定義雲端 Endpoint URL");
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
      console.warn("[TTS] 自定義雲端合成失敗:", err);
      return null;
    }
  }

  if (settings.ttsEngine === "mimo") {
    if (!settings.ttsMimoKey || !settings.ttsMimoVoiceAudioPath) {
      console.warn("[TTS] 缺少小米 MiMo API Key 或昔漣克隆音頻");
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
      console.warn("[TTS] 小米 MiMo 合成失敗:", err);
      return null;
    }
  }

  return null;
}

async function speakMessage(message: Message): Promise<void> {
  ttsPlaybackSequence += 1;
  stopLive2dMouth();
  window.live2dSpeech?.prepare();
  // 立即切 UI：不等合成，讓用戶能馬上看到按鈕進入播放態。
  // playTtsBase64 真正開始播時會再次 setSpeakingMsgId（冪等）；如果合成失敗下面 catch 裡復位。
  setSpeakingMsgId(message.id);
  try {
    const cache = await synthesizeAndPlayCached(message.content, message, message.id);
    if (cache) {
      message.ttsCacheKey = cache.cacheKey;
      void saveSession();
    } else if (currentSpeakingMsgId === message.id) {
      // 合成失敗（引擎關 / 配置缺失 / 網絡報錯）→ 復位 UI
      console.warn("[TTS] 合成失敗，復位喇叭按鈕");
      setSpeakingMsgId(null);
    }
  } catch (err) {
    console.warn("[TTS] speakMessage 異常:", err);
    if (currentSpeakingMsgId === message.id) setSpeakingMsgId(null);
  }
}

// 自動朗讀：檢查引擎是否開啟 + autoRead 開關，滿足條件才朗讀
async function autoSpeakIfEnabled(text: string, msgId?: string): Promise<{ cacheKey: string } | null> {
  if (isStudyMode() || isGameMode()) return null;
  const settings = await loadTtsSettings();
  if (!settings || settings.ttsEngine === "off" || !settings.ttsAutoRead) return null;
  ttsPlaybackSequence += 1;
  return await synthesizeAndPlayCached(text, undefined, msgId);
}

interface EarlyMinimaxPlayback {
  append(delta: string): void;
  finish(fullText: string, msgId?: string): Promise<{ cacheKey: string } | null>;
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
    if (triggered || isStudyMode() || isGameMode()) return;
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
      if (triggered || isStudyMode() || isGameMode()) return;
      void tryStart(delta);
    },
    async finish(fullText: string, msgId?: string): Promise<{ cacheKey: string } | null> {
      if (isStudyMode() || isGameMode()) return null;
      const cfg = await ensureSettings();
      if (!cfg || !eligible) return autoSpeakIfEnabled(fullText, msgId);

      if (!triggered) {
        return autoSpeakIfEnabled(fullText, msgId);
      }

      const result = await playbackPromise;
      if (!result?.ok) {
        return autoSpeakIfEnabled(fullText, msgId);
      }
      if (result.sequence !== ttsPlaybackSequence) {
        return null;
      }

      const remainder = fullText.slice(segment.length).trim();
      if (!remainder) return null;
      const rest = await streamAndPlayCached(cfg, remainder, undefined, { waitForPlaybackEnd: true });
      return rest ? null : autoSpeakIfEnabled(fullText, msgId);
    },
  };
}

function autosize(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}

// ── 表情包選擇器 ──

let enabledStickers: Array<{ id: string; src: string; description?: string }> = [];

async function loadEnabledStickers(): Promise<void> {
  try {
    enabledStickers = (await window.chat?.getEnabledStickers?.()) ?? [];
  } catch {
    enabledStickers = [];
  }
}

/** 根據 sticker id 查語義描述 */
function getStickerDescription(id: string): string {
  const found = enabledStickers.find((s) => s.id === id);
  return found?.description ?? id;
}

function renderStickerPicker(): void {
  stickerPickerGrid.replaceChildren();
  if (enabledStickers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sticker-picker__empty";
    empty.textContent = "沒有可用的表情包";
    stickerPickerGrid.appendChild(empty);
    return;
  }
  for (const s of enabledStickers) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "sticker-picker__item";
    const img = document.createElement("img");
      // 內置貼紙 src 是 "/stickers/xxx" 絕對路徑，file:// 協議下解析到磁盤根目錄
      // 走 resolveAsset() 轉成正確的 file:// 或 http:// URL（與 sticker-manager 縮略圖同模式）
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

function buildModelMessages(): Array<{ role: "user" | "model"; content: string }> {
  return messages
    .filter((message) => message.content.trim())
    .slice(-16)
    .map((message) => ({
      role: message.role,
      content: message.content.replace(/\[sticker:([^\]]+)\]/g, (_match, id) => {
        const desc = getStickerDescription(id);
        return `（用戶發送表情包：${desc}）`;
      }),
    }));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then(resolve, reject)
      .finally(() => window.clearTimeout(timer));
  });
}


let currentWorkspaceStyle = "01_default.md";
let currentWorkspaceMode = "chat";

window.addEventListener("message", (e) => {
  if (!e.data) return;
  
  if (e.data.type === "set-style") {
    currentWorkspaceStyle = e.data.value;
  }
  if (e.data.type === "set-mode") {
    currentWorkspaceMode = e.data.value;
  }
  if (e.data.type === "switch-session") {
    const sessionId = e.data.sessionId;
    if (sessionId && window.chatStore && sessionId !== currentSessionId) {
      window.chatStore.get(sessionId).then((full) => {
        if (full) loadSessionIntoUI(full as ChatStoreSession);
      });
    }
  }
  if (e.data.type === "create-session") {
    if (window.chatStore) {
      window.chatStore.create({ identityId: null }).then(async (session) => {
        if (session?.id) {
          const full = await window.chatStore.get(session.id);
          if (full) loadSessionIntoUI(full as ChatStoreSession);
        }
      }).catch(err => console.error("[Chat] Failed to create session from workspace:", err));
    }
  }
});

if (window.chat?.onUpdateMode) {
  window.chat.onUpdateMode((mode) => {
    currentWorkspaceMode = mode;
    if (window.self !== window.top) {
      window.top.postMessage({ type: "mode-updated-by-text", value: mode }, "*");
    } else {
      const opts = document.querySelectorAll("#mode-dropdown .dm-opt");
      opts.forEach((opt) => {
        const o = opt as HTMLElement;
        if (o.dataset.value === mode) {
          opts.forEach((el) => el.classList.remove("is-active"));
          o.classList.add("is-active");
          const valEl = document.querySelector("#mode-val");
          if (valEl) valEl.textContent = o.textContent?.trim() || "";
        }
      });
    }
  });
}

function isTalkMode(): boolean {
  if (window.self !== window.top) {
    return currentWorkspaceMode === "talk";
  }
  const active = document.querySelector("#mode-dropdown .dm-opt.is-active") as HTMLElement | null;
  return active?.dataset?.value === "talk";
}

function isStudyMode(): boolean {
  if (window.self !== window.top) {
    return currentWorkspaceMode === "study";
  }
  const active = document.querySelector("#mode-dropdown .dm-opt.is-active") as HTMLElement | null;
  return active?.dataset?.value === "study";
}

function isGameMode(): boolean {
  if (window.self !== window.top) {
    return currentWorkspaceMode === "game";
  }
  const active = document.querySelector("#mode-dropdown .dm-opt.is-active") as HTMLElement | null;
  return active?.dataset?.value === "game";
}

function getCurrentStyle(): string {
  if (window.self !== window.top) {
    if (currentWorkspaceMode === "talk") return "talk";
    if (currentWorkspaceMode === "study") return "study";
    if (currentWorkspaceMode === "game") return "game";
    return currentWorkspaceStyle;
  }
  const active = document.querySelector("#style-dropdown .dm-opt.is-active") as HTMLElement | null;
  const style = (active && active.dataset && active.dataset.value) || "01_default.md";
  if (isTalkMode()) return "talk";
  if (isStudyMode()) return "study";
  if (isGameMode()) return "game";
  return style;
}
async function getModelReply(): Promise<ChatReplyPayload> {
  if (!window.chat?.sendMessage) {
    throw new Error("聊天 IPC 尚未就緒，請重啟應用後再試。");
  }
  const payload = await withTimeout(
    window.chat.sendMessage(buildModelMessages(), getCurrentStyle()),
    FRONTEND_REPLY_TIMEOUT_MS,
    "模型響應超時，請稍後重試。",
  );
  return normalizeChatReplyPayload(payload);
}

let sending = false;

// ── 快捷預設膠囊 ──────────────────────────────────────────
// 空對話時在 empty-state 下方顯示的半透明膠囊，點擊後：
// - fill 模式：預設提示詞填入輸入框，用戶修改後發送
// - chat 模式：昔漣主動開口（注入隱藏種子消息觸發 agent）

interface QuickPreset {
  id: string;
  label: string;
  icon: string;
  mode: "chat" | "fill";
  prompt?: string;
}

const QUICK_PRESETS: QuickPreset[] = [
  { id: "chat",     label: "和昔漣聊天", icon: "💬",  mode: "chat" },
  { id: "schedule", label: "設置定時任務", icon: "⏰", mode: "fill", prompt: "幫我設置一個定時任務：" },
  { id: "weather",  label: "查看天氣",   icon: "🌤️", mode: "fill", prompt: "幫我查一下今天的天氣" },
  { id: "document", label: "生成文檔",   icon: "📄", mode: "fill", prompt: "幫我生成一份文檔：" },
  { id: "email",    label: "發送郵件",   icon: "✉️", mode: "fill", prompt: "幫我發一封郵件：" },
];

/** 動態生成膠囊 DOM 並綁定點擊。bootstrap 末尾調一次。 */
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
    icon.textContent = preset.icon;
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
 * 「和昔漣聊天」膠囊：讓昔漣主動開口。
 * 注入隱藏種子消息觸發 agent（不推入 messages 數組、不渲染），
 * 複用現有 AG-UI 流式回覆機制。
 */
async function triggerCyreneGreeting(): Promise<void> {
  if (sending || !currentSessionId) return;

  // 立即隱藏空態（膠囊），不等 refreshModelConfig 異步完成
  const emptyEl = document.getElementById("chat-empty");
  if (emptyEl) emptyEl.setAttribute("hidden", "");

  sending = true;
  sendBtn.disabled = true;
  await refreshModelConfig();
  chatHintEl.textContent = currentModelConfig?.connected ? `${currentModelConfig.model} 思考中…` : "模型未連接";

  let streamMsgId = "";
  try {
    streamMsgId = String(Date.now() + 1);
    const streamMsg = { id: streamMsgId, role: "model" as const, content: "", at: Date.now(), thinking: true };
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

    let finishRun!: () => void;
    let failRun!: (err: Error) => void;
    const runDone = new Promise<void>((resolve, reject) => {
      finishRun = resolve;
      failRun = reject;
    });

    const deltaQueue: string[] = [];
    let playbackTimer: number | null = null;
    let runFinishedArrived = false;
    const getStreamingBubble = (): HTMLElement | null => {
      const row = messagesEl.querySelector(`[data-msg-id="${streamMsgId}"]`);
      return row ? row.querySelector(".msg__bubble") as HTMLElement : null;
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
          const bubble = getStreamingBubble();
          if (bubble) {
            const span = document.createElement("span");
            span.className = "msg__char";
            span.textContent = next;
            bubble.appendChild(span);
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
          return;
        }
        if (playbackTimer !== null) { clearInterval(playbackTimer); playbackTimer = null; }
        tryFinish();
      }, 40);
    };
    const offEvent = window.agui!.onEvent((rawEvent) => {
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
              text.textContent = "調用中：" + (event.toolCallName ?? "工具");
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
              deltaQueue.push(event.delta);
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
              pendingTtsCachePromise = earlyMinimaxPlayback.finish(ttsContent, streamMsgId);
            }
            break;
          case "CUSTOM":
            if (event.name === "cyrene.sticker") {
              sticker = (event.value as StickerId | null) ?? null;
            } else if (event.name === "cyrene.weather") {
              pendingWeatherCard = event.value as Record<string, unknown>;
            } else if (event.name === "cyrene.todos") {
              renderTodoPanel(event.value as TodoState | null);
            } else if (event.name === "cyrene.choice") {
              const choiceData = event.value as { id: string; question: string; options: Array<{ label: string; value: string; description?: string }>; default?: string };
              const card = buildChoiceCardEl(choiceData);
              messagesEl.appendChild(card);
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            break;
          case "RUN_FINISHED":
            runFinishedArrived = true;
            tryFinish();
            break;
          case "RUN_ERROR":
            failRun(new Error(event.content || "模型請求失敗"));
            break;
          default:
            break;
        }
      } catch (err) {
        console.error("[Chat] onEvent回調拋錯:", err);
      }
    });

    // 種子消息：不推入 messages 數組、不渲染，只作為 agent 輸入觸發昔漣主動開口
    const ack = await window.agui!.run({
      messages: [{ role: "user", content: "[internal] 用戶點擊了「和昔漣聊天」，請你主動開口聊幾句，像朋友打招呼一樣自然開場。" }],
      style: getCurrentStyle(),
      sessionId: currentSessionId || undefined,
    });
    if (!ack.success) {
      offEvent();
      throw new Error(ack.error || "模型請求發起失敗");
    }

    await runDone;
    offEvent();

    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      msg.content = streamContent;
      msg.sticker = sticker;
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
    const message = err instanceof Error ? err.message : "模型請求失敗";
    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      msg.content = "連接模型失敗：" + message;
    } else {
      messages.push({
        id: String(Date.now() + 2),
        role: "model",
        content: "連接模型失敗：" + message,
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
  }
}

async function send(): Promise<void> {
  const text = inputEl.value.trim();
  if ((!text && attachedFiles.length === 0) || sending) return;
  // bootstrap 極快但理論上仍有競態：currentSessionId 為 null 時消息無處可存，
  // 直接攔截避免丟失。正常情況下 bootstrap 會在用戶首次按鍵前完成。
  if (!currentSessionId) {
    console.warn("[Cyrene Chat] 會話尚未初始化完成，已忽略此次發送");
    return;
  }

    // Option C（臨時注入）：內容不進 messages 歷史，只附在 agui.run payload 傳給本輪。
    // fullUserText 只放精簡 hint 進 history，不堆內容。
    const hintsByKind: string[] = [];
    const turnTextAttachments: { name: string; text: string }[] = [];
    let budgetUsed = 0;
    const budgetExceeded: string[] = [];
    for (const f of attachedFiles) {
      switch (f.kind) {
        case "text":
          if (f.text) {
            const remaining = BUDGET_CHARS - budgetUsed;
            if (f.text.length > remaining) {
              turnTextAttachments.push({ name: f.name, text: f.text.slice(0, remaining) });
              budgetExceeded.push(f.name);
              budgetUsed = BUDGET_CHARS;
            } else {
              turnTextAttachments.push({ name: f.name, text: f.text });
              budgetUsed += f.text.length;
            }
          }
          hintsByKind.push(`📝 ${f.name}（附件，內容已注入本輪上下文）`);
          break;
        case "indexed":
          hintsByKind.push(`📚 ${f.name}（已索引 ${f.chunks ?? 0} 段，可用 imported_docs 工具檢索）`);
          break;
        case "empty":
          hintsByKind.push(`📄 ${f.name}（為空）`);
          break;
        case "unsupported":
          hintsByKind.push(`⚠️ ${f.name}（暫不支持：${f.reason || ""}）`);
          break;
      }
    }
    if (budgetExceeded.length > 0) {
      hintsByKind.push(`⚠️ ${budgetExceeded.join("、")} 已省略部分內容（超一輪預算）`);
    }
    const fileHint = hintsByKind.length > 0
      ? "\n\n【本輪文件】\n" + hintsByKind.join("\n")
      : "";
    const fullUserText = (text || (attachedFiles.length > 0 ? "請幫我看看這些文件" : "")) + fileHint;

  sending = true;
  sendBtn.disabled = true;
  await refreshModelConfig();
  chatHintEl.textContent = currentModelConfig?.connected ? `${currentModelConfig.model} 思考中…` : "模型未連接";

  const stickerMatch = fullUserText.match(/\[sticker:([^\]]+)\]/);
  const userStickerId = stickerMatch ? stickerMatch[1] : null;

  const userMsg: Message = {
    id: String(Date.now()),
    role: "user",
    content: fullUserText,
    at: Date.now(),
    sticker: userStickerId,
  };
  messages.push(userMsg);
  inputEl.value = "";
  autosize();
  removeAttachedFiles();
  void saveSession();
  render();

  let streamMsgId = "";
  try {
    streamMsgId = String(Date.now() + 1);
    const streamMsg = { id: streamMsgId, role: "model", content: "", at: Date.now(), thinking: true };
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

    // 終態信號：由事件流的 RUN_FINISHED/RUN_ERROR 觸發 resolve，
    // 不依賴 invoke 的 resolve（invoke 只做 ack，可能與事件投遞存在順序競爭）。
    let finishRun!: () => void;
    let failRun!: (err: Error) => void;
    const runDone = new Promise<void>((resolve, reject) => {
      finishRun = resolve;
      failRun = reject;
    });

    // AG-UI 事件流：訂閱 window.agui.onEvent，按事件類型渲染
    // 主進程在 FC 完成後瞬間把所有 delta 發完，渲染端用"回放隊列"按固定節奏逐字顯示，
    // 營造真流式感。流式中的氣泡用增量 span 追加 + CSS 漸顯，不調 render() 全量重建。
    const deltaQueue: string[] = [];
    let playbackTimer: number | null = null;
    let runFinishedArrived = false;
    /** 找到當前流式消息的氣泡 DOM（TEXT_MESSAGE_START 時 render 過一次，帶 data-msg-id）。 */
    const getStreamingBubble = (): HTMLElement | null => {
      const row = messagesEl.querySelector(`[data-msg-id="${streamMsgId}"]`);
      return row ? row.querySelector(".msg__bubble") as HTMLElement : null;
    };
    // 終態條件：RUN_FINISHED 到達 AND 回放隊列空。兩者都滿足才 finishRun。
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
          // 增量追加 span 到氣泡，CSS 漸顯。不調 render()，避免全量重建卡頓。
          const bubble = getStreamingBubble();
          if (bubble) {
            const span = document.createElement("span");
            span.className = "msg__char";
            span.textContent = next;
            bubble.appendChild(span);
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
          return;
        }
        // 隊列空了
        if (playbackTimer !== null) { clearInterval(playbackTimer); playbackTimer = null; }
        tryFinish();
      }, 40);
    };
    const offEvent = window.agui!.onEvent((rawEvent) => {
      try {
        const event = rawEvent as AguiBaseEvent;
        const msg = messages.find(m => m.id === streamMsgId);
        switch (event.type) {
          case "TOOL_CALL_START": {
            // 工具調用開始：在 thinking 氣泡裡顯示"🔧 調用中：xxx"，替換三個點
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
              text.textContent = "調用中：" + (event.toolCallName ?? "工具");
              tip.appendChild(icon);
              tip.appendChild(text);
              bubble.appendChild(tip);
            }
            break;
          }
          case "TOOL_CALL_END": {
            // 工具調用完成：把"調用中"改成"完成"，淡出準備讓位給文字
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
            // 切換 thinking 點 → 空氣泡，render 一次建立 DOM（帶 data-msg-id）
            // 工具提示（若有）會被 render 重建清掉，自然過渡到文字
            if (msg) { msg.thinking = false; render(); }
            break;
          case "TEXT_MESSAGE_CONTENT":
            if (event.delta) {
              ttsContent += event.delta;
              earlyMinimaxPlayback.append(ttsContent);
              deltaQueue.push(event.delta);
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
            // 全文 delta 已收齊時，ttsContent 已經同步累加完整；UI 的 streamContent 仍按 40ms 逐字回放。
            // 這樣聲音可儘早開始，且不受前端打字動畫隊列影響。
            if (!autoSpeakTriggered && ttsContent.trim()) {
              autoSpeakTriggered = true;
              pendingTtsCachePromise = earlyMinimaxPlayback.finish(ttsContent, streamMsgId);
            }
            break;
          case "CUSTOM":
            // 主進程發的自定義事件：sticker / 天氣卡片 / 任務清單 / 選擇卡片
            if (event.name === "cyrene.sticker") {
              sticker = (event.value as StickerId | null) ?? null;
            } else if (event.name === "cyrene.weather") {
              // 暫存天氣數據，等 runDone 後 render 再插入（避免 render 的 replaceChildren 清掉卡片）
              console.log("[Chat] 收到天氣卡片數據:", JSON.stringify(event.value)?.slice(0, 100));
              pendingWeatherCard = event.value as Record<string, unknown>;
            } else if (event.name === "cyrene.todos") {
              renderTodoPanel(event.value as TodoState | null);
            } else if (event.name === "cyrene.choice") {
              // 選擇卡片：立即插入聊天流（不等 runDone，因為要即時交互）
              const choiceData = event.value as { id: string; question: string; options: Array<{ label: string; value: string; description?: string }>; default?: string };
              const card = buildChoiceCardEl(choiceData);
              messagesEl.appendChild(card);
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            break;
          case "RUN_FINISHED":
            // 終態信號到達，但要等回放隊列空才真正 finishRun（保證流式播完）
            runFinishedArrived = true;
            tryFinish();
            break;
          case "RUN_ERROR":
            failRun(new Error(event.content || "模型請求失敗"));
            break;
          default:
            // TOOL_CALL_* / STEP_* 暫不在 UI 處理（骨架階段）
            break;
        }
      } catch (err) {
        console.error("[Chat] onEvent回調拋錯:", err);
      }
    });

    // invoke 只確認"已發起"，不等 Observable 結束。
    // 真正的完成由事件流 RUN_FINISHED/RUN_ERROR 驅動（await runDone）。
    const ack = await window.agui!.run({
      messages: buildModelMessages(),
      style: getCurrentStyle(),
      sessionId: currentSessionId || undefined,
      attachments: turnTextAttachments,
    });
    if (!ack.success) {
      offEvent();
      throw new Error(ack.error || "模型請求發起失敗");
    }

    // 等事件流終態
    await runDone;
    offEvent();

    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      msg.content = streamContent;
      msg.sticker = sticker;
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
    // 天氣卡片在 render 後追加到末尾（模型回覆之後）
    if (pendingWeatherCard) {
      console.log("[Chat] 插入天氣卡片");
      const card = buildWeatherCardEl(pendingWeatherCard);
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      pendingWeatherCard = null;
    }
    // TTS 已在 TEXT_MESSAGE_END 時觸發，這裡不再重複朗讀
  } catch (err) {
    const message = err instanceof Error ? err.message : "模型請求失敗";
    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      msg.content = "連接模型失敗：" + message;
    } else {
      messages.push({
        id: String(Date.now() + 2),
        role: "model",
        content: "連接模型失敗：" + message,
        at: Date.now(),
      });
    }
    void saveSession();
    render();  } finally {
    sending = false;
    sendBtn.disabled = false;
    chatHintEl.textContent = formatModelHint(currentModelConfig);
    inputEl.focus();
  }
}
function clearChat(): void {
  if (sending) return;
  if (messages.length === 0) return;
  const ok = window.confirm("清空當前對話？");
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
    if (e.isComposing) return;
    e.preventDefault();
    void send();
  }
});


/* ===== File upload ===== */
const fileInput = document.getElementById("file-input") as HTMLInputElement | null;
const attachBtn = document.getElementById("attach-btn") as HTMLButtonElement | null;
let attachedFiles: Attachment[] = [];
	
// ── path-based 文件攝入 ──
// 路徑提取在 preload（webUtils.getPathForFile），renderer 不碰 Electron API。
async function ingestDroppedFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  attachBtn!.disabled = true;
  try {
    const results = await window.chat!.ingestDroppedFiles(files);
    if (results && results.length > 0) attachedFiles = [...attachedFiles, ...results];
    updateFileTags();
  } catch (err: unknown) {
    window.alert("文件攝入失敗：" + ((err as Error)?.message || String(err)));
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
	  const kindLabel: Record<AttachmentKind, string> = {
	    text: "📝",
	    indexed: "📚",
	    empty: "📄",
	    unsupported: "⚠️",
	  };
	  attachedFiles.forEach((f, i) => {
	    const tag = document.createElement("div");
	    tag.className = "chat__file-tag";
	    const label = document.createElement("span");
	    const icon = kindLabel[f.kind] || "📄";
	    const detail = f.kind === "text" ? "（附件）" :
	      f.kind === "indexed" ? `（${f.chunks ?? 0} 段）` :
	      f.kind === "empty" ? "（空）" :
	      "（暫不支持）";
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
  // path-based：直接把 dataTransfer.files 傳 ingestDroppedFiles，
  // main 側 fs.statSync 判斷文件/文件夾後遞歸展開。
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    void ingestDroppedFiles(Array.from(files));
  }
});

clearBtn.addEventListener("click", clearChat);



/* ===== Dropdown: mode + style + reasoning (body-level menus) ===== */
(function() {
  var triggers = document.querySelectorAll(".dropdown-trigger");
  var menus = {
    "mode-dropdown": document.getElementById("mode-dropdown"),
    "style-dropdown": document.getElementById("style-dropdown"),
    "reasoning-dropdown": document.getElementById("reasoning-dropdown")
  };
  var values = {
    "mode-dropdown": document.getElementById("mode-val"),
    "style-dropdown": document.getElementById("style-val"),
    "reasoning-dropdown": document.getElementById("reasoning-val")
  };

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
        menu.querySelectorAll(".dm-opt").forEach(function(o) { o.classList.remove("is-active"); });
        opt.classList.add("is-active");
        var val = values[id];
        if (val) val.textContent = opt.textContent?.trim() || "";
        closeAll();
      });
    });
  });

  // Click outside closes
  document.addEventListener("click", closeAll);
})();


/* ===== Floating particles (dreamy pink motes) =====
   在 .chat 容器底層畫一組緩慢上飄的粉紫色光斑，顏色與全站 pink/violet
   主題一致，配 twinkle 閃爍。canvas 在 HTML 裡絕對定位、pointer-events:none，
   所以不影響輸入/點擊/滾動。 */
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
  requestAnimationFrame(drawParticles);
}

if (particlesCtx) {
  resizeParticles();
  particles = Array.from({ length: PARTICLE_COUNT }, spawnParticle);
  requestAnimationFrame(drawParticles);
  window.addEventListener("resize", resizeParticles);
}


// 啟動：遷移老 localStorage → 選會話 → render
// 先把用戶貼紙目錄拉到內存，再 bootstrap 渲染歷史消息——否則首屏裡
// 純貼紙消息（氣泡已隱藏）會因 enabledStickers 還沒加載而渲染成空白。
void (async () => {
  await loadEnabledStickers();
  await bootstrap();
  buildQuickPresets();
  installSchedulerEventListener();
  void initModelConfig();
})();

// main → renderer：權限審批請求（per-action 檔位下工具調用前）
// 插入一張審批卡片到聊天流；用戶點同意/拒絕後回傳給主進程。
window.settings?.onPermissionApprovalRequest?.((req) => {
  console.log("[Cyrene/Chat] permission approval request:", req.id, req.toolId);
  const card = buildApprovalCardEl(req);
  messagesEl.appendChild(card);
  // 滾動到底部讓用戶看到
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

// main → renderer：設置面板點列表/新對話時，讓窗口切到指定 session
window.chatStore?.onSwitchSession(async (sessionId) => {
  if (!window.chatStore) return;
  if (sessionId === currentSessionId) return;
  const session = await window.chatStore.get(sessionId);
  if (session) loadSessionIntoUI(session);
});

// 任意會話變動後 main 廣播——兩種處理：
// 1. 當前活躍會話被外部刪了 → fallback 到最新一條 / 自動建新
// 2. 側欄展開時刷新列表（別的窗口新建/改名/刪除都會觸發）
window.chatStore?.onChanged(async () => {
  // 側欄展開時刷新列表（收起時不浪費 DOM 寫入）
  if (chatRail && !chatRail.hidden) void renderRailList();

  if (!window.chatStore || !currentSessionId) return;
  const stillExists = await window.chatStore.get(currentSessionId);
  if (stillExists) return;
  // 當前會話已被外部刪除：fallback 到最新一條 / 自動建新
  const list = await window.chatStore.list();
  let next: ChatStoreSession | null = null;
  if (list.length > 0) next = await window.chatStore.get(list[0].id);
  if (!next) next = await window.chatStore.create({ identityId: null });
  if (next) loadSessionIntoUI(next);
});
autosize();
inputEl.focus();

if (window.self !== window.top) {
  document.body.classList.add("is-embedded");
}
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "clear-chat") {
    clearChat();
  }
});

// ── 停止播放熱鍵與按鈕監聽 ──
document.getElementById("stop-speaking-btn-inner")?.addEventListener("click", () => {
  stopCurrentTts();
  setSpeakingMsgId(null);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (currentSpeakingMsgId) {
      stopCurrentTts();
      setSpeakingMsgId(null);
    }
  }
});
