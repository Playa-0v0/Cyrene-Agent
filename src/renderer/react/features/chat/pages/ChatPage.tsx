import { useEffect, useRef, useState, type DragEvent } from "react";
import { DownOutlined } from "@ant-design/icons";
import { ChatComposer, type ComposerAttachment } from "../components/ChatComposer";
import { ComposerSlot } from "../components/ComposerSlot";
import { TodoPanel } from "../components/TodoPanel";
import type { TodoState } from "../../../../../shared/todo-types";
import {
  describePermissionRequest,
  normalizeCodeAskInteraction,
  normalizeCodeVerificationInteraction,
  normalizeChoiceInteraction,
  normalizeTaskPlanPresentation,
  shouldDismissAsk,
  type AgentRunStage,
  type ComposerInteraction,
} from "../components/run-presentation";
import { ChatMessageList, type ChatMessageItem } from "../components/ChatMessageList";
import type { WeatherData } from "../components/weather/weather-types";
import { getTtsPlaybackSnapshot, playTtsToCompletion, stopTtsPlayback } from "../components/tts-playback";
import { EarlyTtsPlaybackQueue } from "../tts/early-tts-queue";
import { ConversationSidebar } from "../components/ConversationSidebar";
import { StatusFloat } from "../components/StatusFloat";
import type { ChatMessage, ChatSession, ChatSessionMeta, ConversationMode, ReasoningBlock, RunActivityRecord, ToolExecutionRecord } from "../../../../../shared/chat-types";
import { SidebarToggle } from "../../../components/ui/SidebarToggle";
import { ModeSwitch } from "../../../components/ui/ModeSwitch";
import { CharacterStatusPill } from "../../../components/ui/CharacterStatusPill";
import { WindowControls } from "../../../components/ui/WindowControls";
import { SettingsButton } from "../../../components/ui/SettingsButton";
import { UserAvatar } from "../../../components/ui/UserAvatar";
import { useUserCallPreference } from "../../../hooks/useUserNickname";
import { resolveRevisableLastTurn } from "../components/last-turn-actions";
import { NewTaskButton } from "../../../components/ui/NewTaskButton";
import { shouldRunModelForMode } from "./conversation-run-policy";
import {
  applyCodeRunEvent,
  createCodeRunViewModel,
  restoreCodeRunViewModel,
  type CodeRunApi,
  type CodeRunViewModel,
} from "../../../../lib/code-run-view-model";
import {
  normalizeSessionMode,
  openSessionByIdWithDeps,
  type OpenSessionArgs,
  type ReactSessionMode,
} from "./openSessionByDeps";
import "../../../components/ui/SidebarToggle.css";
import "../../../components/ui/ModeSwitch.css";
import "../../../components/ui/CharacterStatusPill.css";
import "../../../components/ui/WindowControls.css";
import "../../../components/ui/SettingsButton.css";
import "../../../components/ui/UserAvatar.css";
import "../../../components/ui/NewTaskButton.css";
import "../components/ChatComposer.css";
import "../components/ReasoningControl.css";
import "../components/StyleControl.css";
import "../components/PermissionControl.css";
import "../components/ChatMessageList.css";
import "../components/ConversationSidebar.css";
import "../components/StatusFloat.css";

import avatarLight from "../../../assets/avatars/avatar-light.png";
import compressingPng from "../../../assets/compressing.png";

const CONVERSATION_MODES: readonly ConversationMode[] = ["chat", "work", "code", "learn", "daily"];

function isConversationMode(value: string): value is ConversationMode {
  return CONVERSATION_MODES.includes(value as ConversationMode);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 校验后端发来的 cyrene.weather 卡片数据，返回 renderer 侧 WeatherData。 */
function normalizeWeatherData(value: unknown): WeatherData | undefined {
  const card = asRecord(value);
  if (!card) return undefined;

  const source = asNonEmptyString(card.source);
  const location = asRecord(card.location);
  const province = asNonEmptyString(location?.province);
  const city = asNonEmptyString(location?.city);
  const temp = typeof card.temp === "number" ? card.temp : undefined;
  const humidity = typeof card.humidity === "number" ? card.humidity : undefined;

  if (!source || !province || !city || temp === undefined || humidity === undefined) {
    return undefined;
  }

  if (source === "open-meteo") {
    const weatherCode = typeof card.weatherCode === "number" ? card.weatherCode : undefined;
    const windDeg = typeof card.windDeg === "number" ? card.windDeg : undefined;
    const windSpeed = typeof card.windSpeed === "number" ? card.windSpeed : undefined;
    if (weatherCode === undefined || windDeg === undefined || windSpeed === undefined) return undefined;
    return {
      source: "open-meteo",
      location: { province, city },
      weatherCode,
      temp,
      feelsLike: typeof card.feelsLike === "number" ? card.feelsLike : temp,
      humidity,
      windDeg,
      windSpeed,
      precipitation: typeof card.precipitation === "number" ? card.precipitation : 0,
      pressure: typeof card.pressure === "number" ? card.pressure : 0,
    };
  }

  if (source === "amap") {
    const weather = asNonEmptyString(card.weather);
    const windDirection = asNonEmptyString(card.windDirection);
    const windPower = asNonEmptyString(card.windPower);
    const reporttime = asNonEmptyString(card.reporttime);
    if (!weather || !windDirection || !windPower || !reporttime) return undefined;
    return {
      source: "amap",
      location: { province, city },
      weather,
      temp,
      humidity,
      windDirection,
      windPower,
      reporttime,
    };
  }

  return undefined;
}

const DEMO_RESPONSES: Readonly<Record<string, string>> = {
  "1": "收到啦♪ 这是一条普通会话消息。今天也一起把界面慢慢打磨得更舒服吧。",
  "2": [
    "## Markdown 渲染测试",
    "",
    "这是一段包含 **粗体**、*斜体* 和 `行内代码` 的内容。",
    "",
    "- 第一项：消息列表使用 Bubble",
    "- 第二项：正文使用 XMarkdown",
    "- 第三项：样式仍由昔涟主题控制",
    "",
    "> 这是一段引用，用来观察间距、颜色和左侧边线。",
    "",
    "| 功能 | 状态 |",
    "| --- | --- |",
    "| Markdown | 正常 |",
    "| 表格 | 正常 |",
  ].join("\n"),
  "3": String.raw`数学公式测试开始♪

行内公式：$E = mc^2$

块级公式：

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

再来一个二次方程：

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$`,
  "4": [
    "下面是一段 TypeScript 代码，用来测试语法高亮和复制功能：",
    "",
    "```ts",
    "type CyreneMode = \"work\" | \"chat\" | \"code\" | \"learn\" | \"daily\";",
    "",
    "function greeting(mode: CyreneMode): string {",
    "  return mode === \"chat\"",
    "    ? \"昔涟期待和你一起聊天♪\"",
    "    : `当前模式：${mode}`;",
    "}",
    "",
    "console.log(greeting(\"chat\"));",
    "```",
  ].join("\n"),
};

const DEMO_STICKERS: Readonly<Record<string, string>> = {
  "5": "playful",
};

interface ChatStoreApi {
  list: (options?: { mode?: ConversationMode }) => Promise<ChatSessionMeta[]>;
  get: (id: string) => Promise<ChatSession | null>;
  create: (input: { identityId: null; mode: ConversationMode; title?: string }) => Promise<ChatSession>;
  append: (id: string, message: ChatMessage) => Promise<ChatSession | null>;
  replaceTail: (id: string, startIndex: number, messages: ChatMessage[]) => Promise<ChatSession | null>;
  setMessageTtsCacheKey: (id: string, messageId: string, cacheKey: string, converterVersion: string) => Promise<ChatSession | null>;
  rename: (id: string, title: string) => Promise<ChatSession | null>;
  delete: (id: string) => Promise<boolean>;
  setPinned: (id: string, pinned: boolean) => Promise<ChatSession | null>;
  pickWorkspaceFolder: () => Promise<{ ok: boolean; path?: string; displayName?: string; error?: string }>;
  setWorkspace: (sessionId: string, workspaceRoot: string) => Promise<{ ok: boolean; error?: string; isEmpty?: boolean }>;
  initLearnWorkspace: (sessionId: string) => Promise<{ ok: boolean; error?: string; created?: string[]; skipped?: string[] }>;
  openWorkspace: (workspaceRoot: string) => Promise<{ ok: boolean; error?: string }>;
  setActiveSession: (sessionId: string | null) => Promise<unknown>;
  onChanged: (callback: () => void) => () => void;
  setCodeMode: (sessionId: string, clineMode: "plan" | "act") => Promise<{
    ok: boolean;
    error?: string;
    session?: ChatSession;
  }>;
  // main → reactChatWindow：通知 ChatPage 切换到指定 sessionId
  onReactSwitchSession: (callback: (sessionId: string) => void) => () => void;
  // reactChatWindow → main：ChatPage 已挂好 IPC 监听，允许 flush pending sessionId
  notifyReactReady: () => void;
  // 初始加载 TODO 状态，保证卡片常驻
  getCurrentTodos: () => Promise<Record<"work" | "daily" | "learn", TodoState>>;
}

interface SidebarApi {
  openSettings: (section?: string) => void;
}

interface AguiEvent {
  type?: string;
  runId?: string;
  messageId?: string;
  delta?: string;
  message?: string;
  error?: string;
  content?: string;
  name?: string;
  value?: unknown;
  toolCallId?: string;
  toolCallName?: string;
  stepName?: string;
  status?: string;
}

interface AguiApi {
  run: (input: {
    messages: Array<{ role: "user" | "model"; content: string; at?: number }>;
    userTurnId: string;
    assistantTurnId: string;
    styleId?: string;
    sessionId: string;
    imageAttachments?: Array<{ name: string; filePath: string; mime?: string }>;
  }) => Promise<{ success: boolean; error?: string }>;
  onEvent: (callback: (event: AguiEvent) => void) => () => void;
  cancel: (runId?: string) => Promise<unknown>;
}

interface ChoiceApi {
  resolve: (id: string, value: unknown) => Promise<{ ok: boolean }>;
}

interface PermissionApprovalRequest {
  id: string;
  toolId: string;
  toolName: string;
  toolDescription: string;
  args: Record<string, unknown>;
  risk: string;
}

interface SettingsApprovalApi {
  onPermissionApprovalRequest: (callback: (request: PermissionApprovalRequest) => void) => () => void;
  resolvePermissionApproval: (id: string, allowed: boolean) => Promise<{ ok: boolean }>;
}

interface PublicModelConfig {
  model?: unknown;
  displayName?: string;
  stickerSize?: "small" | "standard" | "large";
}

interface ModelConfigApi {
  get: () => Promise<PublicModelConfig>;
  onChanged: (callback: (config: PublicModelConfig) => void) => () => void;
}

function chatStore(): ChatStoreApi | undefined {
  return (window as typeof window & { chatStore?: ChatStoreApi }).chatStore;
}

function sidebarApi(): SidebarApi | undefined {
  return (window as typeof window & { sidebar?: SidebarApi }).sidebar;
}

function aguiApi(): AguiApi | undefined {
  return (window as typeof window & { agui?: AguiApi }).agui;
}

function choiceApi(): ChoiceApi | undefined {
  return (window as typeof window & { choice?: ChoiceApi }).choice;
}

function settingsApprovalApi(): SettingsApprovalApi | undefined {
  return (window as typeof window & { settings?: SettingsApprovalApi }).settings;
}

function codeRunApi(): CodeRunApi | undefined {
  return (window as typeof window & { codeRun?: CodeRunApi }).codeRun;
}

function permissionInteraction(request: PermissionApprovalRequest): ComposerInteraction {
  const target = [request.args.path, request.args.filePath]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    kind: "permission",
    id: request.id,
    toolName: request.toolName || request.toolId,
    summary: describePermissionRequest(request),
    targetPath: target,
  };
}

function stageForStep(stepName: string | undefined): AgentRunStage | undefined {
  if (stepName === "agent-graph-action-gate") return { kind: "understanding" };
  if (stepName === "agent-graph-plan") return { kind: "planning" };
  if (stepName === "agent-graph-soul") return { kind: "responding" };
  if (stepName?.startsWith("agent-graph-tool-")) {
    return { kind: "executing", detail: stepName.slice("agent-graph-tool-".length) };
  }
  return undefined;
}

function toUiMessages(session: ChatSession): ChatMessageItem[] {
  return session.messages.map((message) => ({
    id: message.id,
    role: message.role === "model" ? "assistant" : "user",
    content: message.content,
    reasoning: message.reasoning,
    reasoningBlocks: message.reasoningBlocks,
    runActivity: message.runActivity,
    ttsCacheKey: message.ttsCacheKey,
    ttsCacheVersion: message.ttsCacheVersion,
    responseStarted: message.role === "model",
    sticker: message.sticker,
    toolExecutions: message.toolExecutions,
    attachments: message.attachments,
  }));
}

/**
 * React 窗口会话打开的纯函数 helper：
 * 从同目录的 openSessionByDeps 模块 re-export 出来，便于 ChatPage 内部组件与
 * 独立测试文件共享同一份实现。
 */
export {
  normalizeSessionMode,
  openSessionByIdWithDeps,
  type ReactSessionMode,
  type OpenSessionArgs,
};

const LAST_MODE_STORAGE_KEY = "cyrene-react-last-mode";

function getInitialMode(): ConversationMode {
  try {
    const saved = localStorage.getItem(LAST_MODE_STORAGE_KEY);
    if (saved && isConversationMode(saved)) return saved;
  } catch {
    // localStorage 不可用或数据异常时回退到默认值
  }
  return "chat";
}

export function ChatPage() {
  const preferredAddress = useUserCallPreference();
  const [collapsed, setCollapsed] = useState(false);
  const [mode, setMode] = useState<ConversationMode>(getInitialMode);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messagesByMode, setMessagesByMode] = useState<Partial<Record<ConversationMode, ChatMessageItem[]>>>({});
  const [workspaceNames, setWorkspaceNames] = useState<Partial<Record<ConversationMode, string>>>({});
  const [attachmentsByScope, setAttachmentsByScope] = useState<Record<string, ComposerAttachment[]>>({});
  const [sessionsByMode, setSessionsByMode] = useState<Partial<Record<ConversationMode, ChatSessionMeta[]>>>({});
  const [activeSessionIds, setActiveSessionIds] = useState<Partial<Record<ConversationMode, string>>>({});
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [modelBusyByMode, setModelBusyByMode] = useState<Partial<Record<ConversationMode, boolean>>>({});
  const [isCompressingContext, setIsCompressingContext] = useState(false);
  const [composerInteraction, setComposerInteraction] = useState<ComposerInteraction>();
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [lastTurnRevisionStarting, setLastTurnRevisionStarting] = useState(false);
  const [modelName, setModelName] = useState("模型未连接");
  const [modelDisplayName, setModelDisplayName] = useState("");
  const [selectedClineMode, setSelectedClineMode] = useState<"plan" | "act">("act");
  const [stickerSize, setStickerSize] = useState<"small" | "standard" | "large">("standard");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [todoStateByMode, setTodoStateByMode] = useState<Partial<Record<"work" | "daily" | "learn", TodoState>>>({});
  const activeModeRef = useRef(mode);
  const activeSessionIdsRef = useRef(activeSessionIds);
  const activeScopeRef = useRef(`mode:${mode}`);
  const sessionSelectionGeneration = useRef(0);
  const dragDepthRef = useRef(0);
  const localPreviewUrlsRef = useRef(new Set<string>());
  const demoTimers = useRef(new Set<number>());
  const activeRunsBySession = useRef<Record<string, { assistantId: string; runId?: string; mode: ConversationMode }>>({});
  // bootstrap 标志：只由 cold-start finally 写入；模式切换 effect 仅检查
  const bootstrapCompletedRef = useRef(false);
  // 长期持有的会话操作 ref：避免 IPC 回调捕获陈旧闭包
  const openSessionByIdRef = useRef<(id: string) => Promise<boolean>>(async () => false);
  const refreshSessionsRef = useRef<
    (targetMode: ConversationMode, selectCurrent: boolean) => Promise<void>
  >(async () => {});
  // IPC 切换串行链：保证 Ready 后连续切换按顺序完成
  const reactSessionSwitchChainRef = useRef<Promise<void>>(Promise.resolve());
  // 滚动到底部按钮状态
  const [scrollToBottomVisible, setScrollToBottomVisible] = useState(false);
  const scrollToBottomRef = useRef<() => void>(() => {});

  useEffect(() => {
    const api = aguiApi();
    if (!api) return;

    // 初始同步：从 main 加载各模式 TODO，保证卡片常驻显示
    const store = chatStore();
    if (store?.getCurrentTodos) {
      store
        .getCurrentTodos()
        .then((state) => {
          if (state) {
            setTodoStateByMode(state);
          }
        })
        .catch(() => {});
    }

    return api.onEvent((event) => {
      if (event.type === "CUSTOM" && event.name === "cyrene.todos") {
        const incoming = (event.value as TodoState) ?? { todos: [] };
        const mode = incoming.mode;
        if (mode === "work" || mode === "daily" || mode === "learn") {
          setTodoStateByMode((prev) => ({ ...prev, [mode]: incoming }));
        }
      }
    });
  }, []);

  useEffect(() => {
    const settings = settingsApprovalApi();
    if (!settings) return;
    return settings.onPermissionApprovalRequest((request) => {
      setInteractionBusy(false);
      setComposerInteraction(permissionInteraction(request));
      const currentMode = activeModeRef.current;
      const currentSessionId = activeSessionIdsRef.current[currentMode];
      const activeRun = currentSessionId ? activeRunsBySessionRef.current[currentSessionId] : undefined;
      if (activeRun) {
        updateMessage(currentMode, activeRun.assistantId, { runStage: { kind: "waiting_permission" } });
      }
    });
  }, []);

  useEffect(() => {
    const modelConfig = (window as typeof window & { modelConfig?: ModelConfigApi }).modelConfig;
    if (!modelConfig) return;
    let active = true;
    const apply = (config: PublicModelConfig) => {
      if (!active) return;
      setModelName(typeof config.model === "string" && config.model.trim() ? config.model.trim() : "模型未连接");
      setModelDisplayName(typeof config.displayName === "string" ? config.displayName.trim() : "");
      setStickerSize(config.stickerSize === "small" || config.stickerSize === "large" ? config.stickerSize : "standard");
    };
    void modelConfig.get().then(apply).catch(() => {
      if (active) setModelName("模型未连接");
    });
    const off = modelConfig.onChanged(apply);
    return () => {
      active = false;
      off();
    };
  }, []);
  const modelBusyByModeRef = useRef<Partial<Record<ConversationMode, boolean>>>({});
  const lastTurnRevisionStartingRef = useRef(false);
  const activeAguiOffRef = useRef<(() => void) | null>(null);
  const activeRunsBySessionRef = useRef(activeRunsBySession);
  const [pendingQueueBySession, setPendingQueueBySession] = useState<Record<string, { id: string; rawContent: string; visibleContent: string; attachments: ComposerAttachment[]; userSticker?: string }[]>>({});
  const pendingQueueBySessionRef = useRef(pendingQueueBySession);
  useEffect(() => {
    pendingQueueBySessionRef.current = pendingQueueBySession;
  }, [pendingQueueBySession]);
  const activeEarlyTtsRef = useRef<{
    queue: EarlyTtsPlaybackQueue;
    mode: ConversationMode;
    sessionId: string;
    messageId: string;
  } | null>(null);

  const taskLabel = ["work", "daily", "code"].includes(mode) ? "新建任务" : "新建对话";
  const activeSessionId = activeSessionIds[mode];
  const scopeKey = activeSessionId ?? `mode:${mode}`;
  const draft = drafts[scopeKey] ?? "";
  const messages = messagesByMode[mode] ?? [];
  const hasMessages = messages.length > 0;
  const attachments = attachmentsByScope[scopeKey] ?? [];
  const sessions = sessionsByMode[mode] ?? [];

  activeModeRef.current = mode;
  activeSessionIdsRef.current = activeSessionIds;
  activeScopeRef.current = scopeKey;

  // 缓存用户最后停留的模式，下次打开窗口时恢复
  useEffect(() => {
    try {
      localStorage.setItem(LAST_MODE_STORAGE_KEY, mode);
    } catch {
      // 忽略写入失败
    }
  }, [mode]);

  useEffect(() => () => {
    for (const timer of demoTimers.current) {
      window.clearTimeout(timer);
      window.clearInterval(timer);
    }
    demoTimers.current.clear();
    activeAguiOffRef.current?.();
    activeAguiOffRef.current = null;
    activeEarlyTtsRef.current?.queue.cancel();
    activeEarlyTtsRef.current = null;
    for (const url of localPreviewUrlsRef.current) URL.revokeObjectURL(url);
    localPreviewUrlsRef.current.clear();
  }, []);

  useEffect(() => window.chat?.onScreenshotInsert?.((data) => {
    const targetScope = activeScopeRef.current;
    const attachment: ComposerAttachment = {
      kind: "image",
      name: `截图_${Date.now()}.png`,
      filePath: data.filePath,
      mime: data.mime,
      previewUrl: data.previewUrl,
      hasAnnotations: data.hasAnnotations,
    };
    setAttachmentsByScope((current) => ({
      ...current,
      [targetScope]: [...(current[targetScope] ?? []), attachment],
    }));
  }), []);

  useEffect(() => {
    const store = chatStore();
    if (!store) return;
    const refresh = () => void refreshSessions(activeModeRef.current, true);
    const off = store.onChanged(refresh);
    return off;
  }, []);

  // 模式 effect：bootstrap 完成后才刷新；bootstrap 自身由下方合并 effect 接管
  useEffect(() => {
    if (!bootstrapCompletedRef.current) return;
    void refreshSessionsRef.current(mode, true).catch((error) => {
      console.error("[ChatPage] Failed to refresh sessions after mode change:", error);
    });
  }, [mode]);

  // 合并 effect：注册 IPC → cold-start → finally 置 bootstrap + 通知 ready
  useEffect(() => {
    const store = chatStore();
    if (!store?.onReactSwitchSession) return;

    let disposed = false;

    const unsubscribe = store.onReactSwitchSession((sessionId) => {
      if (!sessionId) return;
      reactSessionSwitchChainRef.current = reactSessionSwitchChainRef.current
        .then(async () => {
          const opened = await openSessionById(sessionId);
          if (!opened) {
            await refreshSessionsRef.current(activeModeRef.current, true);
          }
        })
        .catch(async (error) => {
          console.error("[ChatPage] Failed to switch React session:", error);
          try {
            await refreshSessionsRef.current(activeModeRef.current, true);
          } catch (fallbackError) {
            console.error("[ChatPage] Switch fallback failed:", fallbackError);
          }
        });
    });

    void (async () => {
      try {
        // 等待 200ms 确保 IPC 桥接完全就绪
        await new Promise(r => setTimeout(r, 200));
        const urlSessionId = new URLSearchParams(window.location.search).get("sessionId");
        if (urlSessionId) {
          const opened = await openSessionById(urlSessionId);
          if (!opened) {
            await refreshSessionsRef.current(activeModeRef.current, true);
          }
        } else {
          await refreshSessionsRef.current(activeModeRef.current, true);
        }
      } catch (error) {
        console.error("[ChatPage] Failed to bootstrap React session:", error);
        // 再等 300ms 重试
        await new Promise(r => setTimeout(r, 300));
        try {
          await refreshSessionsRef.current(activeModeRef.current, true);
        } catch (fallbackError) {
          console.error("[ChatPage] Bootstrap retry also failed:", fallbackError);
        }
      } finally {
        // cold-start 全程完成才标记 bootstrap 完成；只有该标志置位后
        // mode 切换 effect 才会触发 refreshSessions
        bootstrapCompletedRef.current = true;
        if (!disposed) store.notifyReactReady?.();
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const active = activeEarlyTtsRef.current;
    if (active && (active.mode !== mode || active.sessionId !== activeSessionId)) {
      active.queue.cancel();
      activeEarlyTtsRef.current = null;
    }
  }, [activeSessionId, mode]);

  function updateMessage(targetMode: ConversationMode, id: string, patch: Partial<ChatMessageItem>) {
    setMessagesByMode((current) => ({
      ...current,
      [targetMode]: (current[targetMode] ?? []).map((item) => (
        item.id === id ? { ...item, ...patch } : item
      )),
    }));
  }

  function handleTtsCacheKey(
    targetMode: ConversationMode,
    sessionId: string,
    messageId: string,
    cacheKey: string,
    converterVersion: string,
  ) {
    updateMessage(targetMode, messageId, { ttsCacheKey: cacheKey, ttsCacheVersion: converterVersion });
    void chatStore()?.setMessageTtsCacheKey(sessionId, messageId, cacheKey, converterVersion);
  }

  function createEarlyTtsQueue(
    targetMode: ConversationMode,
    sessionId: string,
    messageId: string,
  ): EarlyTtsPlaybackQueue {
    activeEarlyTtsRef.current?.queue.cancel();
    const queue = new EarlyTtsPlaybackQueue(
      async (segment) => {
        if (
          activeModeRef.current !== targetMode
          || activeSessionIdsRef.current[targetMode] !== sessionId
          || activeEarlyTtsRef.current?.queue !== queue
        ) return "interrupted";
        return await playTtsToCompletion({
          conversationId: sessionId,
          messageId,
          text: segment,
          speechMode: targetMode === "learn" ? "learn" : "default",
          preferredAddress,
          automatic: true,
        });
      },
      stopTtsPlayback,
    );
    activeEarlyTtsRef.current = { queue, mode: targetMode, sessionId, messageId };
    return queue;
  }

  function finishEarlyTtsQueue(queue: EarlyTtsPlaybackQueue, fullText: string): void {
    void queue.finish(fullText).finally(() => {
      const active = activeEarlyTtsRef.current;
      if (active?.queue !== queue) return;
      const playback = getTtsPlaybackSnapshot();
      if (playback.messageId === active.messageId && playback.status === "completed") stopTtsPlayback();
      activeEarlyTtsRef.current = null;
    });
  }

  async function selectSession(sessionId: string, targetMode: ConversationMode = mode) {
    const store = chatStore();
    if (!store) return;
    const generation = ++sessionSelectionGeneration.current;
    const session = await store.get(sessionId);
    if (!session || generation !== sessionSelectionGeneration.current) return;
    setActiveSessionIds((current) => {
      const next = { ...current, [targetMode]: sessionId };
      activeSessionIdsRef.current = next;
      return next;
    });
    const uiMessages = toUiMessages(session);
    if (targetMode === "code") {
      setSelectedClineMode(session.codeSession?.clineMode ?? "act");
      const api = codeRunApi();
      if (api) {
        try {
          const restored = await restoreCodeRunViewModel(createCodeRunViewModel(), api, sessionId);
          if (generation !== sessionSelectionGeneration.current) return;
          if (restored.run || restored.card) {
            const assistantIndex = uiMessages.findLastIndex((message) => message.role === "assistant");
            if (assistantIndex >= 0) uiMessages[assistantIndex] = { ...uiMessages[assistantIndex], codeRun: restored };
            else uiMessages.push({
              id: `code-run-${restored.run?.runId ?? sessionId}`,
              role: "assistant",
              content: "",
              responseStarted: false,
              codeRun: restored,
            });
          }
          const verificationInteraction = normalizeCodeVerificationInteraction(restored.approval);
          if (verificationInteraction) {
            setComposerInteraction(verificationInteraction);
          } else {
            const pendingAsks = await api.getPendingAsks(sessionId);
            const askInteraction = normalizeCodeAskInteraction(pendingAsks[0]);
            setComposerInteraction(askInteraction);
          }
        } catch (error) {
          console.warn("[Cyrene React] 恢复 Code 运行状态失败:", error);
        }
      }
    }
    setMessagesByMode((current) => ({ ...current, [targetMode]: uiMessages }));
    setWorkspaceNames((current) => ({
      ...current,
      [targetMode]: session.workspaceBinding?.displayName,
    }));
    if (targetMode === activeModeRef.current) void store.setActiveSession(sessionId);
  }

  /**
   * 通过 ref 暴露给 IPC 切换链和初始化 effect；成功切换后同步写回 URL，
   * 不触发页面重新加载。
   */
  async function openSessionById(sessionId: string): Promise<boolean> {
    const opened = await openSessionByIdRef.current(sessionId);
    if (opened && typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("sessionId", sessionId);
        window.history.replaceState(
          null,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
      } catch {
        // 忽略 URL 同步失败，不影响会话切换
      }
    }
    return opened;
  }

  // 同步 openSessionByIdRef：每次 chatStore / selectSession 变更时重新打包
  useEffect(() => {
    openSessionByIdRef.current = (sessionId: string) =>
      openSessionByIdWithDeps({
        sessionId,
        getSession: async (id) => {
          const store = chatStore();
          if (!store) return null;
          const result = await store.get(id);
          return (result ?? null) as { mode?: string } | null;
        },
        selectSession: async (id, mode) => {
          // ReactSessionMode ⊂ ConversationMode，可直接传
          await selectSession(id, mode as ConversationMode);
        },
      });
  }, [chatStore, selectSession]);

  // 同步 refreshSessionsRef
  useEffect(() => {
    refreshSessionsRef.current = refreshSessions;
  }, [refreshSessions]);

  async function refreshSessions(targetMode: ConversationMode, selectCurrent: boolean) {
    const store = chatStore();
    if (!store) return;
    const listed = await store.list({ mode: targetMode });
    setSessionsByMode((current) => ({ ...current, [targetMode]: listed }));
    if (!selectCurrent) return;
    const currentId = activeSessionIdsRef.current[targetMode];
    const nextId = listed.some((session) => session.id === currentId) ? currentId : listed[0]?.id;
    if (nextId) {
      await selectSession(nextId, targetMode);
      return;
    }
    setActiveSessionIds((current) => {
      const next = { ...current };
      delete next[targetMode];
      activeSessionIdsRef.current = next;
      return next;
    });
    setMessagesByMode((current) => ({ ...current, [targetMode]: [] }));
    setWorkspaceNames((current) => ({ ...current, [targetMode]: undefined }));
    if (targetMode === activeModeRef.current) void store.setActiveSession(null);
  }

  function streamDemoResponse(targetMode: ConversationMode, id: string, response: string, sessionId?: string) {
    const earlyTtsQueue = sessionId ? createEarlyTtsQueue(targetMode, sessionId, id) : null;
    const loadingTimer = window.setTimeout(() => {
      demoTimers.current.delete(loadingTimer);
      updateMessage(targetMode, id, { loading: false, streaming: true, responseStarted: true });

      const characters = Array.from(response);
      const chunkSize = Math.max(1, Math.min(4, Math.ceil(characters.length / 120)));
      let cursor = 0;
      let spokenCursor = 0;
      const streamTimer = window.setInterval(() => {
        cursor = Math.min(characters.length, cursor + chunkSize);
        const finished = cursor >= characters.length;
        earlyTtsQueue?.append(characters.slice(spokenCursor, cursor).join(""));
        spokenCursor = cursor;
        updateMessage(targetMode, id, {
          content: characters.slice(0, cursor).join(""),
          streaming: !finished,
        });
        if (finished) {
          window.clearInterval(streamTimer);
          demoTimers.current.delete(streamTimer);
          if (sessionId) {
            void chatStore()?.append(sessionId, {
              id,
              role: "model",
              content: response,
              at: Date.now(),
            }).then((saved) => {
              void refreshSessions(targetMode, false);
              if (saved) finishEarlyTtsQueue(earlyTtsQueue!, response);
              else earlyTtsQueue?.cancel();
            });
          } else {
            earlyTtsQueue?.cancel();
          }
        }
      }, 30);
      demoTimers.current.add(streamTimer);
    }, 450);
    demoTimers.current.add(loadingTimer);
  }

  async function runModel(input: {
    targetMode: "chat" | "work" | "daily" | "code";
    sessionId: string;
    userMessageId: string;
    assistantId: string;
    session: ChatSession;
    attachments: ComposerAttachment[];
  }) {
    const api = aguiApi();
    const store = chatStore();
    if (!api || !store) {
      const visibleError = "模型请求失败：AG-UI 模型服务尚未就绪";
      updateMessage(input.targetMode, input.assistantId, {
        content: visibleError,
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        responseStarted: true,
      });
      await store?.append(input.sessionId, {
        id: input.assistantId,
        role: "model",
        content: visibleError,
        at: Date.now(),
      });
      return;
    }

    modelBusyByModeRef.current = { ...modelBusyByModeRef.current, [input.targetMode]: true };
    activeRunsBySession.current = {
      ...activeRunsBySession.current,
      [input.sessionId]: { assistantId: input.assistantId, mode: input.targetMode },
    };
    activeRunsBySessionRef.current = activeRunsBySession;
    setModelBusyByMode((current) => ({ ...current, [input.targetMode]: true }));
    const earlyTtsQueue = createEarlyTtsQueue(input.targetMode, input.sessionId, input.assistantId);
    let streamContent = "";
    let reasoningContent = "";
    let reasoningBlocks: ReasoningBlock[] = [];
    let sticker: string | null = null;
    let toolExecutions: ToolExecutionRecord[] = [];
    let runStarted = false;
    let runActivity: RunActivityRecord | undefined;
    let codeRunViewModel: CodeRunViewModel = createCodeRunViewModel();
    const activeReasoningStarts = new Map<string, number>();
    let currentReasoningId: string | undefined;
    let resolveTerminal!: (error?: Error) => void;
    const terminal = new Promise<Error | undefined>((resolve) => {
      resolveTerminal = resolve;
    });
    const updateRunTool = (toolId: string, patch: Partial<ToolExecutionRecord>) => {
      const index = toolExecutions.findIndex((tool) => tool.id === toolId);
      toolExecutions = index === -1
        ? [...toolExecutions, { id: toolId, name: patch.name ?? "工具调用", status: patch.status ?? "running", result: patch.result }]
        : toolExecutions.map((tool, toolIndex) => toolIndex === index ? { ...tool, ...patch } : tool);
      updateMessage(input.targetMode, input.assistantId, { toolExecutions });
    };
    const publishRunActivity = () => {
      if (!runActivity) return;
      updateMessage(input.targetMode, input.assistantId, { runActivity: { ...runActivity } });
    };
    const publishCodeRun = () => {
      if (input.targetMode !== "code") return;
      updateMessage(input.targetMode, input.assistantId, { codeRun: { ...codeRunViewModel } });
    };
    const updateActiveReasoningStart = () => {
      const starts = [...activeReasoningStarts.values()];
      if (!runActivity) return;
      runActivity = {
        ...runActivity,
        activeReasoningStartedAt: starts.length ? Math.min(...starts) : undefined,
      };
    };
    const completeRunActivity = () => {
      if (!runActivity || runActivity.completedAt === undefined) {
        const completedAt = Date.now();
        for (const startedAt of activeReasoningStarts.values()) {
          runActivity = {
            ...(runActivity ?? { startedAt: completedAt, reasoningMs: 0 }),
            reasoningMs: (runActivity?.reasoningMs ?? 0) + Math.max(0, completedAt - startedAt),
          };
        }
        activeReasoningStarts.clear();
        runActivity = {
          ...(runActivity ?? { startedAt: completedAt, reasoningMs: 0 }),
          completedAt,
          activeReasoningStartedAt: undefined,
        };
        publishRunActivity();
      }
    };
    const markFirstResponse = () => {
      updateMessage(input.targetMode, input.assistantId, { waitingForFirstEvent: false });
    };
    const updateReasoningBlock = (id: string, patch: Partial<ReasoningBlock>) => {
      const index = reasoningBlocks.findIndex((block) => block.id === id);
      reasoningBlocks = index < 0
        ? [...reasoningBlocks, { id, content: "", afterToolCount: toolExecutions.length, ...patch }]
        : reasoningBlocks.map((block, blockIndex) => blockIndex === index ? { ...block, ...patch } : block);
      reasoningContent = reasoningBlocks.map((block) => block.content).filter(Boolean).join("\n\n");
      updateMessage(input.targetMode, input.assistantId, { reasoning: reasoningContent || undefined, reasoningBlocks });
    };

    const off = api.onEvent((event) => {
      if (event.type === "RUN_STARTED") {
        runStarted = true;
        runActivity = { startedAt: Date.now(), reasoningMs: 0 };
        setIsCompressingContext(false);
        if (event.runId) {
          const existing = activeRunsBySession.current[input.sessionId];
          activeRunsBySession.current = {
            ...activeRunsBySession.current,
            [input.sessionId]: { ...(existing ?? { assistantId: input.assistantId, mode: input.targetMode }), runId: event.runId },
          };
          activeRunsBySessionRef.current = activeRunsBySession;
        }
        if (input.targetMode === "code" && event.runId) {
          codeRunViewModel = {
            ...codeRunViewModel,
            run: {
              runId: event.runId,
              chatSessionId: input.sessionId,
              clineSessionId: "",
              status: "running",
              startedAt: Date.now(),
            },
          };
          publishCodeRun();
        }
        updateMessage(input.targetMode, input.assistantId, {
          waitingForFirstEvent: false,
          runActivity: { ...runActivity },
          runStage: { kind: "understanding" },
        });
        return;
      }
      if (!runStarted) return;
      if (
        event.type === "REASONING_MESSAGE_START"
        || event.type === "REASONING_MESSAGE_CONTENT"
        || event.type === "REASONING_MESSAGE_END"
        || event.type === "TOOL_CALL_START"
        || event.type === "TOOL_CALL_RESULT"
        || event.type === "TOOL_CALL_END"
        || event.type === "TEXT_MESSAGE_START"
        || event.type === "TEXT_MESSAGE_CONTENT"
        || event.type === "TEXT_MESSAGE_END"
        || event.type === "CUSTOM"
      ) markFirstResponse();
      if (event.type === "REASONING_MESSAGE_START") {
        const reasoningId = event.messageId ?? crypto.randomUUID();
        currentReasoningId = reasoningId;
        activeReasoningStarts.set(reasoningId, Date.now());
        updateActiveReasoningStart();
        publishRunActivity();
        updateReasoningBlock(reasoningId, { streaming: true });
        updateMessage(input.targetMode, input.assistantId, {
          loading: false,
          reasoningStreaming: true,
          runStage: { kind: "responding" },
        });
      } else if (event.type === "REASONING_MESSAGE_CONTENT" && event.delta) {
        const reasoningId = event.messageId ?? currentReasoningId ?? crypto.randomUUID();
        currentReasoningId = reasoningId;
        const current = reasoningBlocks.find((block) => block.id === reasoningId)?.content ?? "";
        updateReasoningBlock(reasoningId, { content: current + event.delta, streaming: true });
        updateMessage(input.targetMode, input.assistantId, {
          reasoning: reasoningContent,
          loading: false,
          reasoningStreaming: true,
        });
      } else if (event.type === "REASONING_MESSAGE_END") {
        const reasoningId = event.messageId ?? currentReasoningId;
        if (reasoningId) {
          const startedAt = activeReasoningStarts.get(reasoningId);
          if (startedAt && runActivity) {
            runActivity = {
              ...runActivity,
              reasoningMs: runActivity.reasoningMs + Math.max(0, Date.now() - startedAt),
            };
          }
          activeReasoningStarts.delete(reasoningId);
          updateActiveReasoningStart();
          publishRunActivity();
          updateReasoningBlock(reasoningId, { streaming: false });
        }
        currentReasoningId = undefined;
        updateMessage(input.targetMode, input.assistantId, { reasoningStreaming: false, loading: false });
        } else if (event.type === "STEP_STARTED") {
          const stage = stageForStep(event.stepName);
          if (stage) updateMessage(input.targetMode, input.assistantId, { runStage: stage });
        } else if (event.type === "TOOL_CALL_START" && event.toolCallId) {
          updateRunTool(event.toolCallId, {
            name: event.toolCallName ?? "工具调用",
            status: "running",
          });
          updateMessage(input.targetMode, input.assistantId, {
            runStage: { kind: "executing", detail: event.toolCallName ?? "工具调用" },
          });
        } else if (event.type === "TOOL_CALL_RESULT" && event.toolCallId) {
        updateRunTool(event.toolCallId, {
          status: event.status === "failed" ? "error" : "success",
          result: (event.content ?? "").slice(0, 4000),
        });
      } else if (event.type === "TOOL_CALL_END" && event.toolCallId) {
        updateRunTool(event.toolCallId, {});
      } else if (event.type === "TEXT_MESSAGE_START") {
        updateMessage(input.targetMode, input.assistantId, {
          loading: false,
          reasoningStreaming: false,
          responseStarted: true,
          streaming: true,
          runStage: { kind: "responding" },
        });
      } else if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) {
        streamContent += event.delta;
        earlyTtsQueue.append(event.delta);
        updateMessage(input.targetMode, input.assistantId, {
          content: streamContent,
          loading: false,
          streaming: true,
          responseStarted: true,
        });
      } else if (event.type === "TEXT_MESSAGE_END") {
        updateMessage(input.targetMode, input.assistantId, { streaming: false });
      } else if (event.type === "CUSTOM" && event.name === "cyrene.choice") {
        const interaction = normalizeChoiceInteraction(event.value);
        if (interaction) {
          setInteractionBusy(false);
          setComposerInteraction(interaction);
          updateMessage(input.targetMode, input.assistantId, { runStage: { kind: "waiting_user" } });
        }
      } else if (event.type === "CUSTOM" && event.name === "cyrene.choice.dismiss") {
        setComposerInteraction((current) => {
          if (current?.kind !== "ask" || !shouldDismissAsk(current, event.value)) return current;
          return undefined;
        });
      } else if (event.type === "CUSTOM" && event.name === "cyrene.taskPlan") {
        const taskPlan = normalizeTaskPlanPresentation(event.value);
        if (taskPlan) {
          updateMessage(input.targetMode, input.assistantId, {
            taskPlan,
            runStage: { kind: "executing" },
          });
        }
      } else if (event.type === "CUSTOM" && event.name === "cyrene.compressingContext") {
        setIsCompressingContext(true);
      } else if (event.type === "CUSTOM" && event.name === "cyrene.sticker") {
        sticker = typeof event.value === "string" ? event.value : null;
        updateMessage(input.targetMode, input.assistantId, { sticker });
      } else if (event.type === "CUSTOM" && event.name === "cyrene.weather") {
        const weather = normalizeWeatherData(event.value);
        if (weather) {
          updateMessage(input.targetMode, input.assistantId, { weather });
        }
      } else if (event.type === "CUSTOM" && event.name === "code_ask") {
        const interaction = normalizeCodeAskInteraction(event.value);
        if (interaction) {
          setInteractionBusy(false);
          setComposerInteraction(interaction);
          updateMessage(input.targetMode, input.assistantId, { runStage: { kind: "waiting_user" } });
        }
      } else if (event.type === "CUSTOM" && (
        event.name === "code_verification_approval"
        || event.name === "code_verification_card"
      )) {
        const next = applyCodeRunEvent(codeRunViewModel, event);
        if (next !== codeRunViewModel) {
          codeRunViewModel = next;
          publishCodeRun();
        }
        if (event.name === "code_verification_approval") {
          const interaction = normalizeCodeVerificationInteraction(codeRunViewModel.approval);
          if (interaction) {
            setInteractionBusy(false);
            setComposerInteraction(interaction);
            updateMessage(input.targetMode, input.assistantId, { runStage: { kind: "waiting_permission" } });
          } else {
            setComposerInteraction((current) => (
              current?.kind === "permission"
              && current.source === "code_verification"
              && current.id === codeRunViewModel.approval?.approvalId
                ? undefined
                : current
            ));
          }
        }
      } else if (event.type === "RUN_FINISHED") {
        completeRunActivity();
        updateMessage(input.targetMode, input.assistantId, { runStage: { kind: "completed" } });
        resolveTerminal();
      } else if (event.type === "RUN_ERROR") {
        completeRunActivity();
        updateMessage(input.targetMode, input.assistantId, { runStage: { kind: "failed" } });
        resolveTerminal(new Error(event.message ?? event.error ?? event.content ?? "模型请求失败"));
      }
    });
    activeAguiOffRef.current?.();
    activeAguiOffRef.current = off;

    try {
      const general = await window.chat?.getGeneralSettings?.();
      const ack = await api.run({
        messages: input.session.messages.slice(-16).map((item) => ({
          role: item.role,
          content: item.content,
          at: item.at,
        })),
        userTurnId: input.userMessageId,
        assistantTurnId: input.assistantId,
        styleId: general?.currentStyleId,
        sessionId: input.sessionId,
        imageAttachments: input.attachments
          .filter((attachment) => attachment.kind === "image" && attachment.filePath)
          .map((attachment) => ({
            name: attachment.name,
            filePath: attachment.filePath!,
            mime: attachment.mime,
          })),
      });
      if (!ack.success) throw new Error(ack.error ?? "模型请求发起失败");
      const terminalError = await terminal;
      if (terminalError) throw terminalError;

      const finalContent = streamContent.trim() ? streamContent : "任务已完成。";
      updateMessage(input.targetMode, input.assistantId, {
        content: finalContent,
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        reasoning: reasoningContent || undefined,
        reasoningBlocks,
        reasoningStreaming: false,
        runActivity,
        responseStarted: true,
        sticker,
        toolExecutions,
      });
      const savedAssistant = await store.append(input.sessionId, {
        id: input.assistantId,
        role: "model",
        content: finalContent,
        reasoning: reasoningContent || undefined,
        reasoningBlocks,
        runActivity,
        at: Date.now(),
        sticker,
        toolExecutions,
      });
      if (savedAssistant) {
        finishEarlyTtsQueue(earlyTtsQueue, finalContent);
      } else earlyTtsQueue.cancel();
    } catch (error) {
      earlyTtsQueue.cancel();
      completeRunActivity();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const visibleError = `模型请求失败：${errorMessage}`;
      updateMessage(input.targetMode, input.assistantId, {
        content: visibleError,
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        reasoningStreaming: false,
        runActivity,
        responseStarted: true,
      });
      await store.append(input.sessionId, {
        id: input.assistantId,
        role: "model",
        content: visibleError,
        runActivity,
        at: Date.now(),
      });
    } finally {
      off();
      if (activeAguiOffRef.current === off) activeAguiOffRef.current = null;
      const currentActive = activeRunsBySession.current[input.sessionId];
      if (currentActive?.assistantId === input.assistantId) {
        const nextActive = { ...activeRunsBySession.current };
        delete nextActive[input.sessionId];
        activeRunsBySession.current = nextActive;
        activeRunsBySessionRef.current = activeRunsBySession;
      }
      const nextBusy = { ...modelBusyByModeRef.current };
      delete nextBusy[input.targetMode];
      modelBusyByModeRef.current = nextBusy;
      setModelBusyByMode((current) => {
        const next = { ...current };
        delete next[input.targetMode];
        return next;
      });
      void refreshSessions(input.targetMode, false);
      // 当前 session 队列中的下一条消息自动消费
      const queue = pendingQueueBySessionRef.current[input.sessionId] ?? [];
      if (queue.length > 0) {
        const [next, ...rest] = queue;
        pendingQueueBySessionRef.current = { ...pendingQueueBySessionRef.current, [input.sessionId]: rest };
        setPendingQueueBySession(pendingQueueBySessionRef.current);
        const assistantId = crypto.randomUUID();
        void dispatchUserMessage({
          targetMode: input.targetMode,
          sessionId: input.sessionId,
          rawContent: next.rawContent,
          visibleContent: next.visibleContent,
          attachments: next.attachments,
          userSticker: next.userSticker,
          shouldRunModel: true,
          assistantId,
          userMessageId: next.id,
        });
      }
    }
  }

  function isSessionBusy(sessionId: string): boolean {
    return Boolean(activeRunsBySessionRef.current[sessionId]);
  }

  async function restartLastChatTurn(
    expectedUserMessageId: string,
    expectedAssistantMessageId: string,
    editedContent?: string,
  ): Promise<boolean> {
    if (
      activeModeRef.current !== "chat"
      || modelBusyByModeRef.current.chat
      || lastTurnRevisionStartingRef.current
    ) return false;
    const store = chatStore();
    const sessionId = activeSessionIdsRef.current.chat;
    if (!store || !sessionId) return false;
    lastTurnRevisionStartingRef.current = true;
    setLastTurnRevisionStarting(true);
    try {
      const session = await store.get(sessionId);
      if (!session || session.mode !== "chat") return false;
      const lastTurn = resolveRevisableLastTurn(session.messages, "chat");
      if (
        !lastTurn
        || lastTurn.userMessageId !== expectedUserMessageId
        || lastTurn.assistantMessageId !== expectedAssistantMessageId
      ) return false;

      const nextContent = editedContent === undefined ? undefined : editedContent.trim();
      if (editedContent !== undefined && !nextContent) return false;
      const userIndex = session.messages.length - 2;
      const previousUserMessage = session.messages[userIndex];
      const nextUserMessage: ChatMessage = nextContent === undefined
        ? previousUserMessage
        : {
            ...previousUserMessage,
            content: nextContent,
            at: Date.now(),
          };
      const truncatedSession = await store.replaceTail(sessionId, userIndex, [nextUserMessage]);
      if (!truncatedSession) return false;

      activeEarlyTtsRef.current?.queue.cancel();
      activeEarlyTtsRef.current = null;
      stopTtsPlayback();
      const assistantId = crypto.randomUUID();
      setMessagesByMode((current) => ({
        ...current,
        chat: [
          ...toUiMessages(truncatedSession),
          {
            id: assistantId,
            role: "assistant",
            content: "",
            loading: true,
            waitingForFirstEvent: true,
            streaming: false,
            responseStarted: false,
          },
        ],
      }));
      void runModel({
        targetMode: "chat",
        sessionId,
        userMessageId: nextUserMessage.id,
        assistantId,
        session: truncatedSession,
        attachments: (nextUserMessage.attachments ?? []).map((attachment) => ({ ...attachment })),
      });
      return true;
    } catch (error) {
      console.error("[Cyrene React] 重建最后一轮对话失败:", error);
      return false;
    } finally {
      lastTurnRevisionStartingRef.current = false;
      setLastTurnRevisionStarting(false);
    }
  }

  async function editLastChatUserMessage(messageId: string, content: string): Promise<boolean> {
    const lastTurn = resolveRevisableLastTurn(messagesByMode.chat ?? [], "chat");
    if (!lastTurn || lastTurn.userMessageId !== messageId) return false;
    return restartLastChatTurn(lastTurn.userMessageId, lastTurn.assistantMessageId, content);
  }

  async function regenerateLastChatResponse(
    userMessageId: string,
    assistantMessageId: string,
  ): Promise<boolean> {
    return restartLastChatTurn(userMessageId, assistantMessageId);
  }

  async function ensureSession(targetMode: ConversationMode): Promise<string> {
    const existing = activeSessionIdsRef.current[targetMode];
    if (existing) return existing;
    const store = chatStore();
    if (!store) throw new Error("聊天会话服务尚未就绪");
    const session = await store.create({
      identityId: null,
      mode: targetMode,
      title: targetMode === "work" || targetMode === "code" || targetMode === "daily" ? "新任务" : "新对话",
    });
    await refreshSessions(targetMode, false);
    await selectSession(session.id, targetMode);
    return session.id;
  }



  async function initVaultStructure(sessionId: string) {
    const store = chatStore();
    if (!store) return;
    const confirmed = window.confirm(
      "要在当前 Obsidian Vault 中添加 Cyrene 通用学习结构吗？只会创建缺失的文件，不会覆盖已有内容。"
    );
    if (!confirmed) return;
    const result = await store.initLearnWorkspace(sessionId);
    if (!result.ok) {
      window.alert(`添加学习结构失败：${result.error ?? "未知错误"}`);
    } else {
      const created = result.created?.length ?? 0;
      const skipped = result.skipped?.length ?? 0;
      window.alert(`已创建 ${created} 个文件/目录${skipped > 0 ? `，跳过 ${skipped} 个已存在项` : ""}。`);
    }
  }

  async function chooseWorkspace() {
    const targetMode = mode;
    if (targetMode === "chat") return;
    const store = chatStore();
    if (!store) return;
    const picked = await store.pickWorkspaceFolder();
    if (!picked.ok || !picked.path) return;
    const sessionId = await ensureSession(targetMode);
    const result = await store.setWorkspace(sessionId, picked.path);
    if (!result.ok) {
      window.alert(`设置工作区失败：${result.error ?? "未知错误"}`);
      return;
    }
    setWorkspaceNames((current) => ({ ...current, [targetMode]: picked.displayName ?? "工作文件夹" }));

    // Learn 模式：空目录询问是否初始化通用学习结构
    if (targetMode === "learn" && result.isEmpty) {
      const confirmed = window.confirm(
        "这是一个空目录。Cyrene 可以在这里创建通用学习工作区结构（materials/、notes/、exercises/、templates/、learn/progress.md），方便你之后和 Cyrene 一起学习。\n\n是否创建？"
      );
      if (confirmed) {
        await initVaultStructure(sessionId);
      }
    }

    await refreshSessions(targetMode, false);
  }

  async function createNewTask() {
    const targetMode = mode;
    const store = chatStore();
    if (!store) return;
    let workspace: { path: string; displayName?: string } | undefined;
    if (targetMode === "work" || targetMode === "code" || targetMode === "daily" || targetMode === "learn") {
      // 同一项目下的新任务应继承当前会话的可信工作区；只有还未选择
      // 任何项目时才打开目录选择器，避免用户为每个任务重复选一次。
      const activeId = activeSessionIdsRef.current[targetMode];
      const activeSession = activeId ? await store.get(activeId) : null;
      if (activeSession?.workspaceBinding?.workspaceRoot) {
        workspace = {
          path: activeSession.workspaceBinding.workspaceRoot,
          displayName: activeSession.workspaceBinding.displayName,
        };
      } else {
        const picked = await store.pickWorkspaceFolder();
        if (!picked.ok || !picked.path) return;
        workspace = { path: picked.path, displayName: picked.displayName };
      }
    }
    const session = await store.create({
      identityId: null,
      mode: targetMode,
      title: workspace ? "新任务" : "新对话",
    });
    if (workspace) {
      const result = await store.setWorkspace(session.id, workspace.path);
      if (!result.ok) {
        await store.delete(session.id);
        window.alert(`设置工作区失败：${result.error ?? "未知错误"}`);
        return;
      }
      // Learn 模式：空目录询问是否初始化通用学习结构
      if (targetMode === "learn" && result.isEmpty) {
        const confirmed = window.confirm(
          "这是一个空目录。Cyrene 可以在这里创建通用学习工作区结构（materials/、notes/、exercises/、templates/、learn/progress.md），方便你之后和 Cyrene 一起学习。\n\n是否创建？"
        );
        if (confirmed) {
          await initVaultStructure(session.id);
        }
      }
    }
    await refreshSessions(targetMode, false);
    await selectSession(session.id, targetMode);
  }

  async function handleRenameSession(sessionId: string, newTitle: string) {
    const store = chatStore();
    if (!store?.rename) return;
    const title = newTitle.trim();
    if (!title) return;
    await store.rename(sessionId, title);
    await refreshSessionsRef.current(mode, false);
  }

  async function handleDeleteSession(sessionId: string) {
    const store = chatStore();
    if (!store) return;
    const ok = await store.delete(sessionId);
    if (!ok) return;
    await refreshSessionsRef.current(mode, true);
  }

  async function handleTogglePinSession(sessionId: string, pinned: boolean) {
    const store = chatStore();
    if (!store?.setPinned) return;
    await store.setPinned(sessionId, pinned);
    await refreshSessionsRef.current(mode, false);
  }

  async function changeClineMode(clineMode: "plan" | "act") {
    const store = chatStore();
    if (!store) return;
    const sessionId = await ensureSession("code");
    const previous = selectedClineMode;
    setSelectedClineMode(clineMode);
    try {
      const result = await store.setCodeMode(sessionId, clineMode);
      if (!result.ok) {
        setSelectedClineMode(previous);
        window.alert(`切换 Cline 模式失败：${result.error ?? "未知错误"}`);
      }
    } catch (error) {
      setSelectedClineMode(previous);
      console.warn("[Cyrene React] 切换 Cline 模式失败:", error);
    }
  }

  async function createNewClineTask() {
    const api = codeRunApi();
    const sessionId = activeSessionIdsRef.current.code;
    if (!api || !sessionId) return;
    try {
      const result = await api.createNewTask(sessionId);
      if (!result.ok) window.alert(`创建 Cline Task 失败：${result.error ?? "未知错误"}`);
    } catch (error) {
      console.warn("[Cyrene React] 创建 Cline Task 失败:", error);
    }
  }

  async function chooseFiles(files: File[]) {
    const targetScope = scopeKey;
    if (!window.chat || files.length === 0) return;
    setAttachmentBusy(true);
    const previewsByName = new Map<string, string[]>();
    for (const file of files) {
      if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) continue;
      const previewUrl = URL.createObjectURL(file);
      localPreviewUrlsRef.current.add(previewUrl);
      previewsByName.set(file.name, [...(previewsByName.get(file.name) ?? []), previewUrl]);
    }
    try {
      const results = await window.chat.ingestDroppedFiles(files);
      if (results.length > 0) {
        const hydratedResults = results.map((attachment) => {
          if (attachment.kind !== "image") return attachment;
          const previews = previewsByName.get(attachment.name);
          const localPreview = previews?.shift();
          return localPreview ? { ...attachment, previewUrl: localPreview } : attachment;
        });
        setAttachmentsByScope((current) => ({
          ...current,
          [targetScope]: [...(current[targetScope] ?? []), ...hydratedResults],
        }));
      }
    } catch (error) {
      window.alert(`文件摄入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAttachmentBusy(false);
    }
  }

  function updateMessageAttachments(
    targetMode: ConversationMode,
    messageId: string,
    updater: (attachments: ComposerAttachment[]) => ComposerAttachment[],
  ) {
    setMessagesByMode((current) => ({
      ...current,
      [targetMode]: (current[targetMode] ?? []).map((item) => (
        item.id === messageId
          ? { ...item, attachments: updater(item.attachments ?? []) }
          : item
      )),
    }));
  }

  async function prepareImageAttachments(
    targetMode: ConversationMode,
    messageId: string,
    attachments: ComposerAttachment[],
  ) {
    const images = attachments.filter((attachment) => attachment.kind === "image" && attachment.filePath);
    if (images.length === 0 || !window.chat) return;

    let strategy: { mode: "direct" | "caption" } = { mode: "caption" };
    try {
      strategy = await window.chat.getImageSendStrategy();
    } catch (error) {
      console.warn("[Cyrene React] 获取图片发送策略失败，回退视觉描述:", error);
    }

    if (strategy.mode === "direct") {
      const paths = new Set(images.map((image) => image.filePath));
      updateMessageAttachments(targetMode, messageId, (current) => current.map((attachment) => (
        paths.has(attachment.filePath)
          ? { ...attachment, imageSendMode: "direct", status: "done" }
          : attachment
      )));
      return;
    }

    for (const image of images) {
      updateMessageAttachments(targetMode, messageId, (current) => current.map((attachment) => (
        attachment.filePath === image.filePath
          ? { ...attachment, imageSendMode: "caption", status: "processing" }
          : attachment
      )));
      let result: { ok: boolean; caption?: string; error?: string };
      try {
        result = await window.chat.captionImage(image.filePath!, image.hasAnnotations === true);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      updateMessageAttachments(targetMode, messageId, (current) => current.map((attachment) => (
        attachment.filePath === image.filePath
          ? result.ok && result.caption
            ? { ...attachment, imageSendMode: "caption", status: "done", caption: result.caption, reason: undefined }
            : { ...attachment, imageSendMode: "caption", status: "error", reason: result.error ?? "图片分析失败" }
          : attachment
      )));
    }
  }

  function removeAttachment(index: number) {
    const targetScope = scopeKey;
    setAttachmentsByScope((current) => ({
      ...current,
      [targetScope]: (current[targetScope] ?? []).filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function containsFiles(dataTransfer: DataTransfer): boolean {
    return Array.from(dataTransfer.types).includes("Files");
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void chooseFiles(files);
  }

  async function sendMessage(content: string) {
    const message = content.trim();
    if (!message) return;
    activeEarlyTtsRef.current?.queue.cancel();
    activeEarlyTtsRef.current = null;
    const stickerMatch = message.match(/\[sticker:([^\]]+)\]/);
    const userSticker = stickerMatch?.[1];
    const visibleMessage = message.replace(/\[sticker:[^\]]+\]/g, "").trim();
    const demoResponse = DEMO_RESPONSES[message];
    const demoSticker = DEMO_STICKERS[message];
    const shouldRunModel = shouldRunModelForMode(mode, Boolean(demoResponse), Boolean(demoSticker));
    const assistantId = demoResponse || demoSticker || shouldRunModel ? crypto.randomUUID() : undefined;
    const userMessageId = crypto.randomUUID();
    const attachmentsForMessage = attachments.map((attachment) => ({ ...attachment }));
    const targetMode = mode;
    const sessionId = await ensureSession(targetMode);
    // 如果当前 session 正在跑模型，新消息进入 composer 上方队列，等当前 run 结束后自动发送
    if (shouldRunModel && isSessionBusy(sessionId)) {
      const nextQueue = {
        ...pendingQueueBySessionRef.current,
        [sessionId]: [
          ...(pendingQueueBySessionRef.current[sessionId] ?? []),
          { id: userMessageId, rawContent: message, visibleContent, attachments: attachmentsForMessage, userSticker },
        ],
      };
      pendingQueueBySessionRef.current = nextQueue;
      setPendingQueueBySession(nextQueue);
      setDrafts((current) => ({ ...current, [scopeKey]: "" }));
      setAttachmentsByScope((current) => ({ ...current, [scopeKey]: [] }));
      return;
    }
    await dispatchUserMessage({
      targetMode,
      sessionId,
      rawContent: message,
      visibleContent: visibleMessage,
      attachments: attachmentsForMessage,
      userSticker,
      shouldRunModel,
      demoResponse,
      demoSticker,
      assistantId,
      userMessageId,
    });
  }

  async function dispatchUserMessage(input: {
    targetMode: ConversationMode;
    sessionId: string;
    rawContent: string;
    visibleContent: string;
    attachments: ComposerAttachment[];
    userSticker?: string;
    shouldRunModel: boolean;
    demoResponse?: string;
    demoSticker?: string;
    assistantId?: string;
    userMessageId: string;
  }) {
    const { targetMode, sessionId, rawContent, visibleContent, attachments, userSticker, shouldRunModel, demoResponse, demoSticker, assistantId, userMessageId } = input;
    setMessagesByMode((current) => ({
      ...current,
      [targetMode]: [
        ...(current[targetMode] ?? []),
        {
          id: userMessageId,
          role: "user",
          content: visibleContent,
          sticker: userSticker,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        ...(assistantId ? [{
          id: assistantId!,
          role: "assistant" as const,
          content: "",
          loading: Boolean(demoResponse || shouldRunModel),
          waitingForFirstEvent: Boolean(shouldRunModel),
          streaming: false,
          responseStarted: Boolean(demoSticker),
          sticker: demoSticker,
        }] : []),
      ],
    }));
    setDrafts((current) => ({ ...current, [scopeKey]: "" }));
    setAttachmentsByScope((current) => ({ ...current, [scopeKey]: [] }));
    const updatedSession = await chatStore()?.append(sessionId, {
      id: userMessageId,
      role: "user",
      content: rawContent,
      at: Date.now(),
      sticker: userSticker,
      attachments: attachments
        .filter((attachment) => (attachment.kind === "image" || attachment.kind === "document") && attachment.filePath)
        .map((attachment) => attachment.kind === "image" ? {
          kind: "image" as const,
          name: attachment.name,
          filePath: attachment.filePath!,
          mime: attachment.mime ?? "application/octet-stream",
          caption: attachment.caption,
          status: "pending" as const,
        } : {
          kind: "document" as const,
          name: attachment.name,
          filePath: attachment.filePath!,
          status: "pending" as const,
        }),
    });
    void refreshSessions(targetMode, false);
    if (attachments.length > 0) {
      void prepareImageAttachments(targetMode, userMessageId, attachments);
    }
    if (demoResponse && assistantId) streamDemoResponse(targetMode, assistantId, demoResponse, sessionId);
    if (shouldRunModel && assistantId && !updatedSession) {
      updateMessage(targetMode, assistantId, {
        content: "模型请求失败：用户消息未能写入当前会话",
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        responseStarted: true,
      });
    } else if (shouldRunModel && assistantId && updatedSession) {
      await runModel({
        targetMode,
        sessionId,
        userMessageId,
        assistantId,
        session: updatedSession,
        attachments,
      });
    }
  }

  async function cancelCurrentRun() {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    const activeRun = activeRunsBySession.current[sessionId];
    if (!activeRun?.runId) return;
    updateMessage(activeRun.mode, activeRun.assistantId, {
      streaming: false,
      loading: false,
      waitingForFirstEvent: false,
      responseStarted: true,
    });
    await aguiApi()?.cancel(activeRun.runId);
  }

  function removeQueuedMessage(sessionId: string, id: string) {
    const next = {
      ...pendingQueueBySessionRef.current,
      [sessionId]: (pendingQueueBySessionRef.current[sessionId] ?? []).filter((item) => item.id !== id),
    };
    pendingQueueBySessionRef.current = next;
    setPendingQueueBySession(next);
  }

  function queueCurrentDraft(value: string) {
    if (!activeSessionId || !value.trim()) return;
    const sessionId = activeSessionId;
    const stickerMatch = value.match(/\[sticker:([^\]]+)\]/);
    const userSticker = stickerMatch?.[1];
    const visibleContent = value.replace(/\[sticker:[^\]]+\]/g, "").trim();
    const attachmentsForMessage = attachments.map((attachment) => ({ ...attachment }));
    const userMessageId = crypto.randomUUID();
    const nextQueue = {
      ...pendingQueueBySessionRef.current,
      [sessionId]: [
        ...(pendingQueueBySessionRef.current[sessionId] ?? []),
        { id: userMessageId, rawContent: value, visibleContent, attachments: attachmentsForMessage, userSticker },
      ],
    };
    pendingQueueBySessionRef.current = nextQueue;
    setPendingQueueBySession(nextQueue);
    setDrafts((current) => ({ ...current, [scopeKey]: "" }));
    setAttachmentsByScope((current) => ({ ...current, [scopeKey]: [] }));
  }

  const isCurrentScopeRunning = Boolean(activeSessionId && activeRunsBySession.current[activeSessionId]);
  const currentPendingQueue = activeSessionId
    ? (pendingQueueBySession[activeSessionId] ?? []).map((item) => ({ id: item.id, content: item.visibleContent }))
    : [];

  return (
    <div className={`cy-page ${collapsed ? "is-collapsed" : ""}`}>
      <div className="cy-page-toggle">
        <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      </div>
      <div className="cy-page-top-center">
        <CharacterStatusPill avatarPath={avatarLight} status={modelDisplayName || modelName} />
        <ModeSwitch value={mode} onChange={(nextMode) => {
          if (isConversationMode(nextMode)) setMode(nextMode);
        }} />
      </div>
      <div className="cy-page-windows">
        <WindowControls
          onMinimize={() => window.chat?.minimize()}
          onMaximize={() => window.chat?.toggleMaximize()}
          onClose={() => window.chat?.close()}
        />
      </div>
      <div className="cy-page-settings">
        <SettingsButton onClick={() => sidebarApi()?.openSettings("appearance")} />
      </div>
      <div className="cy-page-user">
        <UserAvatar />
      </div>
      <div className="cy-page-newtask">
        <NewTaskButton label={taskLabel} onClick={() => void createNewTask()} />
      </div>
      <div className="cy-page-conversations">
        <StatusFloat />
        <ConversationSidebar
          mode={mode}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={(sessionId) => void selectSession(sessionId)}
          onOpenProject={(workspaceRoot) => {
            void chatStore()?.openWorkspace(workspaceRoot).then((result) => {
              if (!result.ok) window.alert(`无法打开项目文件夹：${result.error ?? "未知错误"}`);
            });
          }}
          onRename={(sessionId, newTitle) => void handleRenameSession(sessionId, newTitle)}
          onDelete={(sessionId) => void handleDeleteSession(sessionId)}
          onTogglePin={(sessionId, pinned) => void handleTogglePinSession(sessionId, pinned)}
        />
      </div>
      <main
        className={`cy-workspace ${hasMessages ? "has-messages" : "is-empty"} ${isDraggingFiles ? "is-dragging-files" : ""}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDraggingFiles && (
          <div className="cy-file-drop-overlay" aria-hidden="true">
            <span>松开即可添加到当前对话</span>
          </div>
        )}
        {(mode === "work" || mode === "daily" || mode === "learn") && (
          <TodoPanel state={todoStateByMode[mode]} mode={mode} workspaceName={workspaceNames[mode]} />
        )}
        {hasMessages && (
          <ChatMessageList
            messages={messages}
            conversationId={activeSessionId}
            mode={mode}
            preferredAddress={preferredAddress}
            stickerSize={stickerSize}
            revisionBusy={Boolean(modelBusyByMode[mode]) || lastTurnRevisionStarting}
            onEditLastUserMessage={mode === "chat" ? editLastChatUserMessage : undefined}
            onRegenerateLastResponse={mode === "chat" ? regenerateLastChatResponse : undefined}
            onTtsCacheKey={activeSessionId
              ? (messageId, cacheKey, converterVersion) => handleTtsCacheKey(
                mode,
                activeSessionId,
                messageId,
                cacheKey,
                converterVersion,
              )
              : undefined}
            onScrollToBottomVisibilityChange={setScrollToBottomVisible}
            onRegisterScrollToBottom={(scroll) => {
              scrollToBottomRef.current = scroll;
            }}
          />
        )}
        {isCompressingContext && (
          <div className="cy-compressing-context" aria-live="polite" aria-busy="true">
            <img src={compressingPng} className="cy-compressing-context-icon" alt="" aria-hidden="true" />
            <span>昔涟正在压缩上下文…</span>
          </div>
        )}
        <div className="cy-workspace-composer">
          {scrollToBottomVisible && (
            <button
              type="button"
              className="cy-workspace-composer__scroll-to-bottom"
              onClick={() => scrollToBottomRef.current()}
              aria-label="滚动到底部"
              title="滚动到底部"
            >
              <DownOutlined />
            </button>
          )}
          <ComposerSlot
            composer={<ChatComposer
            value={draft}
            mode={mode}
            docked={hasMessages}
            workspaceName={workspaceNames[mode]}
            attachments={attachments}
            attachmentBusy={attachmentBusy}
            modelBusy={isCurrentScopeRunning}
            pendingQueue={currentPendingQueue}
            clineMode={selectedClineMode}
            onChange={(value) => setDrafts((current) => ({ ...current, [scopeKey]: value }))}
            onSubmit={(value) => void sendMessage(value)}
            onCancel={() => void cancelCurrentRun()}
            onQueueMessage={(value) => queueCurrentDraft(value)}
            onRemoveQueuedMessage={(id) => removeQueuedMessage(activeSessionId, id)}
            onChooseWorkspace={() => void chooseWorkspace()}
            onInitVaultStructure={mode === "learn" ? () => {
              const sessionId = activeSessionIdsRef.current[mode];
              if (sessionId) void initVaultStructure(sessionId);
            } : undefined}
            onChooseFiles={(files) => void chooseFiles(files)}
            onRemoveAttachment={removeAttachment}
            onScreenshot={() => void window.chat?.startScreenshot()}
            onChooseSticker={(id) => {
              const separator = draft && !draft.endsWith(" ") ? " " : "";
              setDrafts((current) => ({ ...current, [scopeKey]: `${draft}${separator}[sticker:${id}]` }));
            }}
            onClineModeChange={(nextMode) => void changeClineMode(nextMode)}
            onNewClineTask={() => void createNewClineTask()}
            />}
            interaction={composerInteraction}
            interactionBusy={interactionBusy}
            onAnswer={(id, answer) => {
              if (composerInteraction?.kind === "ask" && composerInteraction.source === "code") {
                const api = codeRunApi();
                if (!api || typeof answer !== "string" || !answer.trim()) return;
                setInteractionBusy(true);
                void api.respondAsk(id, answer).then((result) => {
                  if (result.ok) setComposerInteraction(undefined);
                  setInteractionBusy(false);
                }).catch(() => setInteractionBusy(false));
                return;
              }
              const choice = choiceApi();
              if (!choice) return;
              setInteractionBusy(true);
              void choice.resolve(id, answer).then((result) => {
                if (result.ok) setComposerInteraction(undefined);
                setInteractionBusy(false);
              }).catch(() => setInteractionBusy(false));
            }}
            onIgnore={(id) => {
              if (composerInteraction?.kind === "ask" && composerInteraction.source === "code") {
                const api = codeRunApi();
                if (!api) return;
                setInteractionBusy(true);
                void api.cancelAsk(id).then((result) => {
                  if (result.ok) setComposerInteraction(undefined);
                  setInteractionBusy(false);
                }).catch(() => setInteractionBusy(false));
                return;
              }
              const choice = choiceApi();
              if (!choice) return;
              setInteractionBusy(true);
              void choice.resolve(id, "").then((result) => {
                if (result.ok) setComposerInteraction(undefined);
                setInteractionBusy(false);
              }).catch(() => setInteractionBusy(false));
            }}
            onPermissionDecision={(id, allowed) => {
              if (composerInteraction?.kind === "permission" && composerInteraction.source === "code_verification") {
                const api = codeRunApi();
                if (!api) return;
                setInteractionBusy(true);
                const request = allowed ? api.approveVerification(id) : api.rejectVerification(id);
                void request.then((result) => {
                  if (result.ok) setComposerInteraction(undefined);
                  setInteractionBusy(false);
                }).catch(() => setInteractionBusy(false));
                return;
              }
              const settings = settingsApprovalApi();
              if (!settings) return;
              setInteractionBusy(true);
              void settings.resolvePermissionApproval(id, allowed).then((result) => {
                if (result.ok) setComposerInteraction(undefined);
                setInteractionBusy(false);
              }).catch(() => setInteractionBusy(false));
            }}
          />
        </div>
      </main>
    </div>
  );
}
