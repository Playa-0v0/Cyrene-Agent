import "../ui/base.css";
import "./chat.css";

type Role = "user" | "model";

interface Message {
  id: string;
  role: Role;
  content: string;
  at: number;
  sticker?: StickerId | null;
  thinking?: boolean;
}

type StickerId = "playful" | "love-happy" | "confident" | "serious" | "calm" | "peek" | "clingy-confused" | "tired" | "love-calm" | "love" | "applause";

interface ChatReplyPayload {
  reply: string;
  sticker: StickerId | null;
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
  importDocument: (fileName: string, content: string) => Promise<{ chunks: number; error?: string }>;
}

declare global {
  interface Window {
    chat?: ChatApi;
    modelConfig?: ModelConfigApi;
  }
}

const messagesEl = document.getElementById("messages") as HTMLElement;
const formEl = document.getElementById("composer") as HTMLFormElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const minBtn = document.getElementById("min-btn") as HTMLButtonElement;
const maxBtn = document.getElementById("max-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const chatHintEl = document.getElementById("chat-hint") as HTMLElement;

// 旧版 localStorage key——首次启动时检测到老数据会迁移到主进程 chats 存储再清掉。
const LEGACY_STORAGE_KEY = "cyrene.chat.history.v1";
const FRONTEND_REPLY_TIMEOUT_MS = 35000;

/**
 * Avatar source per role. Empty string = use the gradient placeholder
 * baked into the CSS background of `.msg--user .msg__avatar`.
 *
 * Model side: 昔涟的 PNG，由 CSS border-radius: 50% 自动裁圆。
 * User side: 暂留空，等设置页里上传用户头像后再把 user 改成 file:// 或 data: URL。
 */
const AVATAR_SRC: Record<Role, string> = {
  model: "/avatars/cyrene-avatar.png",
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

const STICKER_SRC: Record<StickerId, string> = {
  playful: "/stickers/playful.png",
  "love-happy": "/stickers/love-happy.png",
  confident: "/stickers/confident.png",
  serious: "/stickers/serious.png",
  calm: "/stickers/calm.png",
  peek: "/stickers/peek.gif",
  "clingy-confused": "/stickers/clingy-confused.gif",
  tired: "/stickers/tired.png",
  "love-calm": "/stickers/love-calm.png",
  love: "/stickers/love.webp",
  applause: "/stickers/applause.webp",
};

// 多会话改造：messages 是当前活跃 session 的消息数组（启动时为空，由 bootstrap 填充）。
// currentSessionId 是当前正在显示的会话 id，所有持久化操作都基于它。
// 启动期间 currentSessionId 为 null，发送按钮通过 sending 标志兜底（bootstrap 极快）。
const messages: Message[] = [];
let currentSessionId: string | null = null;
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

interface ChatStoreSessionMeta {
  id: string;
  title: string;
  identityId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

interface ChatStoreSession {
  id: string;
  title: string;
  identityId: string | null;
  messages: Array<{ id: string; role: Role; content: string; at: number; sticker?: StickerId | null }>;
  createdAt: number;
  updatedAt: number;
  schemaVersion: 1;
}

interface ChatStoreApi {
  list: () => Promise<ChatStoreSessionMeta[]>;
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

// 把渲染端 Message 数组归一化为后端能持久化的形态：
// - 过滤空 content / 渲染中的 thinking 占位（thinking=true 时通常 content 为空，但保险起见双重过滤）
// - 丢弃 thinking 字段（持久化层不存这种瞬态状态）
function toPersistableMessages(arr: Message[]): Array<{
  id: string; role: Role; content: string; at: number; sticker?: StickerId | null;
}> {
  return arr
    .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.content === "string" && m.content.trim() && !m.thinking)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      at: m.at,
      sticker: m.sticker ?? null,
    }));
}

async function saveSession(): Promise<void> {
  if (!currentSessionId || !window.chatStore) return;
  try {
    await window.chatStore.replaceMessages(currentSessionId, toPersistableMessages(messages));
  } catch (err) {
    console.warn("[Cyrene Chat] saveSession 失败:", err);
  }
}

// 把 store 里的 ChatStoreSession 装载到当前窗口（替换 messages 数组并 render）。
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
    });
  }
  // 上报活跃 sessionId（设置面板"删除当前会话"差异化提示用）
  void window.chatStore?.setActiveSession(session.id);
  render();
}

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

function render(): void {
  // 空态：当前会话还没有消息时（新建/全清）显示"昔涟期待与你聊天哦 ✨"占位
  const emptyEl = document.getElementById("chat-empty");
  const hasMessages = messages.some((m) => m.content.trim());
  if (emptyEl) emptyEl.toggleAttribute("hidden", hasMessages);

  messagesEl.replaceChildren();
  for (const m of messages) {
    const row = document.createElement("div");
    row.className = `msg msg--${m.role}`;

    const avatar = document.createElement("div");
    avatar.className = "msg__avatar";
    avatar.setAttribute("aria-hidden", "true");
    setAvatar(avatar, m.role);

    const body = document.createElement("div");
    body.className = "msg__body";

    const bubble = document.createElement("div");
    bubble.className = "msg__bubble";
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
    } else {
      bubble.textContent = m.content;
    }

    const time = document.createElement("div");
    time.className = "msg__time";
    time.textContent = formatTime(m.at);

    body.appendChild(bubble);

    if (m.role === "model" && m.sticker) {
      const stickerSrc = STICKER_SRC[m.sticker];
      if (stickerSrc) {
        const sticker = document.createElement("img");
        sticker.className = "msg__sticker";
        sticker.src = stickerSrc;
        sticker.alt = "昔涟表情";
        sticker.draggable = false;
        body.appendChild(sticker);
      }
    }

    body.appendChild(time);

    row.appendChild(avatar);
    row.appendChild(body);
    messagesEl.appendChild(row);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function autosize(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}

function buildModelMessages(): Array<{ role: "user" | "model"; content: string }> {
  return messages
    .filter((message) => message.content.trim())
    .slice(-16)
    .map((message) => ({
      role: message.role,
      content: message.content,
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


function getCurrentStyle(): string {
  const active = document.querySelector("#style-dropdown .dm-opt.is-active") as HTMLElement | null;
  return (active && active.dataset && active.dataset.value) || "01_default.md";
}
async function getModelReply(): Promise<ChatReplyPayload> {
  if (!window.chat?.sendMessage) {
    throw new Error("聊天 IPC 尚未就绪，请重启应用后再试。");
  }
  const payload = await withTimeout(
    window.chat.sendMessage(buildModelMessages(), getCurrentStyle()),
    FRONTEND_REPLY_TIMEOUT_MS,
    "模型响应超时，请稍后重试。",
  );
  return normalizeChatReplyPayload(payload);
}

let sending = false;

async function send(): Promise<void> {
  const text = inputEl.value.trim();
  if ((!text && attachedFiles.length === 0) || sending) return;
  // bootstrap 极快但理论上仍有竞态：currentSessionId 为 null 时消息无处可存，
  // 直接拦截避免丢失。正常情况下 bootstrap 会在用户首次按键前完成。
  if (!currentSessionId) {
    console.warn("[Cyrene Chat] 会话尚未初始化完成，已忽略此次发送");
    return;
  }

    const fileHint = attachedFiles.length > 0
    ? "\n\n【已上传文件：" + attachedFiles.map(f => f.name).join("、") + "，已导入 RAG，请结合相关文件片段回答。】"
    : "";
  const fullUserText = (text || (attachedFiles.length > 0 ? "请帮我看看这些文件" : "")) + fileHint;

  sending = true;
  sendBtn.disabled = true;
  await refreshModelConfig();
  chatHintEl.textContent = currentModelConfig?.connected ? `${currentModelConfig.model} 思考中…` : "模型未连接";

  const userMsg: Message = {
    id: String(Date.now()),
    role: "user",
    content: fullUserText,
    at: Date.now(),
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
    let firstChunkReceived = false;
    window.chat.onStreamChunk((chunk) => {
      streamContent += chunk;
      const msg = messages.find(m => m.id === streamMsgId);
      if (msg) {
        if (!firstChunkReceived) {
          firstChunkReceived = true;
          // Keep dots for 150ms for smooth transition
          setTimeout(() => {
            const m2 = messages.find(x => x.id === streamMsgId);
            if (m2) { m2.thinking = false; m2.content = streamContent; render(); }
          }, 150);
        } else {
          msg.content = streamContent;
          render();
        }
      }
    });

    const replyPayload = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.chat.removeStreamListeners();
        reject(new Error("模型响应超时，请稍后重试。"));
      }, 60000);
      window.chat.onStreamDone((payload) => {
        clearTimeout(timeout);
        window.chat.removeStreamListeners();
        resolve(normalizeChatReplyPayload(payload));
      });
      window.chat.sendMessage(buildModelMessages(), getCurrentStyle()).catch((err) => {
        clearTimeout(timeout);
        window.chat.removeStreamListeners();
        reject(err);
      });
    });

    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      msg.content = replyPayload.reply || streamContent;
      msg.sticker = replyPayload.sticker;
    }
    void saveSession();
    render();
  } catch (err) {
    window.chat?.removeStreamListeners();
    const message = err instanceof Error ? err.message : "模型请求失败";
    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      msg.content = "连接模型失败：" + message;
    } else {
      messages.push({
        id: String(Date.now() + 2),
        role: "model",
        content: "连接模型失败：" + message,
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
let attachedFiles: Array<{ name: string; chunks: number }> = [];

attachBtn?.addEventListener("click", () => {
  fileInput?.click();
});

async function importFiles(fileList: FileList): Promise<void> {
  if (fileList.length === 0) return;
  attachBtn!.disabled = true;
  const imported: Array<{ name: string; chunks: number }> = [];
  let errors: string[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    try {
      const text = await file.text();
      const result = await window.chat?.importDocument(file.name, text);
      if (result?.error) throw new Error(result.error);
      imported.push({ name: file.name, chunks: result?.chunks ?? 0 });
    } catch (err: any) {
      errors.push(file.name + ": " + (err?.message || String(err)));
    }
  }
  attachedFiles = [...attachedFiles, ...imported];
  attachBtn!.disabled = false;
  fileInput.value = "";
  updateFileTags();
  if (errors.length > 0) {
    window.alert("部分文件导入失败：\n" + errors.join("\n"));
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
    const label = document.createElement("span");
    label.textContent = "📄 " + f.name;
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

fileInput?.addEventListener("change", () => {
  if (fileInput.files) importFiles(fileInput.files);
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

document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragCounter = 0;
  chatEl?.classList.remove("chat--drag-over");
  if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
    void importFiles(e.dataTransfer.files);
  }
});

clearBtn.addEventListener("click", clearChat);



/* ===== Dropdown: style + reasoning (body-level menus) ===== */
(function() {
  var triggers = document.querySelectorAll(".dropdown-trigger");
  var menus = {
    "style-dropdown": document.getElementById("style-dropdown"),
    "reasoning-dropdown": document.getElementById("reasoning-dropdown")
  };
  var values = {
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


// 启动：迁移老 localStorage → 选会话 → render
void bootstrap();
void initModelConfig();

// main → renderer：设置面板点列表/新对话时，让窗口切到指定 session
window.chatStore?.onSwitchSession(async (sessionId) => {
  if (!window.chatStore) return;
  if (sessionId === currentSessionId) return;
  const session = await window.chatStore.get(sessionId);
  if (session) loadSessionIntoUI(session);
});

// 任意会话变动后 main 广播——主要关心两种情况：
// 1. 当前活跃会话被设置面板删了 → 跳到最新一条 / 自动建新
// 2. 当前会话标题被改名 → 暂时不在窗口 UI 显示，无需处理
window.chatStore?.onChanged(async () => {
  if (!window.chatStore || !currentSessionId) return;
  const stillExists = await window.chatStore.get(currentSessionId);
  if (stillExists) return;
  // 当前会话已被外部删除：fallback 到最新一条 / 自动建新
  const list = await window.chatStore.list();
  let next: ChatStoreSession | null = null;
  if (list.length > 0) next = await window.chatStore.get(list[0].id);
  if (!next) next = await window.chatStore.create({ identityId: null });
  if (next) loadSessionIntoUI(next);
});
autosize();
inputEl.focus();
