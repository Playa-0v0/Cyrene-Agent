import { useEffect, useRef, useState, type DragEvent } from "react";
import { DownOutlined } from "@ant-design/icons";
import { ChatComposer, parseComposerMessage, type ComposerAttachment } from "../components/ChatComposer";
import { ComposerSlot } from "../components/ComposerSlot";
import { TodoPanel } from "../components/TodoPanel";
import { CodeGitPanel } from "../components/CodeGitPanel";
import { PlanContent, planTabLabel, planTabDotClass, type PlanReviewPhase } from "../components/PlanReviewPanel";
import { ReviewDiffContent } from "../components/ReviewInspector";
import { RightInspector, type InspectorTab } from "../components/RightInspector";
import type { TodoItem } from "../../../../../shared/todo-types";
import {
  describePermissionRequest,
  normalizeChoiceInteraction,
  normalizeDeferredPlanChoice,
  normalizeTaskPlanPresentation,
  isFormalAnswerCommitted,
  resolveRunFinishedStage,
  resolveTerminalContent,
  shouldClearComposerInteractionForTerminal,
  shouldDismissAsk,
  type AgentRunStage,
  type ComposerInteraction,
} from "../components/run-presentation";
import { ChatMessageList, type ChatMessageItem } from "../components/ChatMessageList";
import { applyAgentRoundBoundary, createRoundProcessMessage } from "../components/agent-rounds";
import { applyTaskDelegationEvent, normalizeTaskDelegationEvent } from "../components/task-delegations";
import type { WeatherData } from "../components/weather/weather-types";
import { getTtsPlaybackSnapshot, playTtsToCompletion, stopTtsPlayback } from "../components/tts-playback";
import { EarlyTtsPlaybackQueue } from "../tts/early-tts-queue";
import { ConversationSidebar } from "../components/ConversationSidebar";

import type { AgentRoundRecord, ChatMessage, ChatSession, ChatSessionMeta, ConversationMode, ProcessMessageRecord, ReasoningBlock, RunActivityRecord, TaskDelegationDisplayRecord, ToolExecutionRecord, ToolFileChange } from "../../../../../shared/chat-types";
import { isContextUsageSnapshot, type ContextUsageSnapshot } from "../../../../../shared/context-usage";
import { SidebarToggle } from "../../../components/ui/SidebarToggle";
import { ModeSwitch } from "../../../components/ui/ModeSwitch";
import { ToolModeButton } from "../../../components/ui/ToolModeButton";
import { ToolModePanel } from "../components/ToolModePanel";
import { SkillModeButton } from "../../../components/ui/SkillModeButton";
import { ModelModeButton } from "../../../components/ui/ModelModeButton";
import { SkillModePanel } from "../components/SkillModePanel";
import { ModelModePanel } from "../components/ModelModePanel";
import { WindowControls } from "../../../components/ui/WindowControls";
import { SettingsButton } from "../../../components/ui/SettingsButton";
import { UserAvatar } from "../../../components/ui/UserAvatar";
import { AppUpdateEntry } from "../components/AppUpdateEntry";
import { useUserCallPreference } from "../../../hooks/useUserNickname";
import { resolveRevisableLastTurn } from "../components/last-turn-actions";
import { NewTaskButton } from "../../../components/ui/NewTaskButton";
import { shouldListenForDeferredPlanEvents, shouldRunModelForMode } from "./conversation-run-policy";
import {
  bootstrapReactSession,
  normalizeSessionMode,
  openSessionByIdWithDeps,
  type OpenSessionArgs,
  type ReactSessionMode,
} from "./openSessionByDeps";
import { RunEventGate } from "./run-event-gate";
import { splitTextForReveal } from "./message-reveal";
import {
  clearSessionInteraction,
  buildTodoRecoveryContext,
  bindWorkspaceName,
  findSessionIdForRun,
  hasActiveRunForSession,
  hydrateSessionMessages,
  mergeHarnessTodosForSession,
  patchSessionMessage,
  recoverInterruptedMessage,
  sessionInteraction,
  setSessionInteraction,
  setSessionInteractionBusy,
  type SessionInteractionState,
  startSessionTodos,
  type TodoStateBySession,
} from "./session-runtime-state";
import "../../../components/ui/SidebarToggle.css";
import "../../../components/ui/ModeSwitch.css";
import "../../../components/ui/WindowControls.css";
import "../../../components/ui/SettingsButton.css";
import "../../../components/ui/UserAvatar.css";
import "../../../components/ui/NewTaskButton.css";
import "../../../components/ui/ToolModeButton.css";
import "../components/ChatComposer.css";
import "../components/ReasoningControl.css";
import "../components/StyleControl.css";
import "../components/PermissionControl.css";
import "../components/ModelModePanel.css";
import "../components/ChatMessageList.css";
import "../components/ConversationSidebar.css";


import compressingPng from "../../../assets/compressing.png";

const CONVERSATION_MODES: readonly ConversationMode[] = ["chat", "work", "code", "learn"];

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

/** 主进程会话守卫拒绝（agui-bridge `SESSION_RUN_ACTIVE:<runId>`）时解析出 active runId。 */
function parseSessionRunActiveError(message: string): string | undefined {
  const prefix = "SESSION_RUN_ACTIVE:";
  return message.startsWith(prefix) ? message.slice(prefix.length) || undefined : undefined;
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
    "type CyreneMode = \"work\" | \"chat\" | \"code\" | \"learn\";",
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
  upsert: (id: string, message: ChatMessage) => Promise<ChatSession | null>;
  replaceTail: (id: string, startIndex: number, messages: ChatMessage[]) => Promise<ChatSession | null>;
  setMessageTtsCacheKey: (id: string, messageId: string, cacheKey: string, converterVersion: string) => Promise<ChatSession | null>;
  rename: (id: string, title: string) => Promise<ChatSession | null>;
  delete: (id: string) => Promise<boolean>;
  setPinned: (id: string, pinned: boolean) => Promise<ChatSession | null>;
  setModelProfile: (id: string, modelProfileId?: string) => Promise<ChatSession | null>;
  pickWorkspaceFolder: () => Promise<{ ok: boolean; path?: string; displayName?: string; error?: string }>;
  setWorkspace: (sessionId: string, workspaceRoot: string) => Promise<{ ok: boolean; error?: string; isEmpty?: boolean }>;
  initLearnWorkspace: (sessionId: string) => Promise<{ ok: boolean; error?: string; created?: string[]; skipped?: string[] }>;
  openWorkspace: (workspaceRoot: string) => Promise<{ ok: boolean; error?: string }>;
  setActiveSession: (sessionId: string | null) => Promise<unknown>;
  onChanged: (callback: () => void) => () => void;
  // main → reactChatWindow：通知 ChatPage 切换到指定 sessionId
  onReactSwitchSession: (callback: (sessionId: string) => void) => () => void;
  // reactChatWindow → main：ChatPage 已挂好 IPC 监听，允许 flush pending sessionId
  notifyReactReady: () => void;
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
  /** Diff Review 卡片证据；由 tool_end 事件独立携带（主进程 harness-adapter 透传）。 */
  changes?: ToolFileChange[];
}

interface AguiApi {
  // 返回 AguiRunAck（含 canonical runId），与 RUN_STARTED.runId 强一致。
  run: (input: {
    messages: Array<{ role: "user" | "model"; content: string; at?: number }>;
    userTurnId: string;
    assistantTurnId: string;
    styleId?: string;
    sessionId: string;
    imageAttachments?: Array<{ name: string; filePath: string; mime?: string }>;
    recoveryContext?: string;
    resumeFromRunId?: string;
  }) => Promise<{ success: boolean; runId: string; error?: string }>;
  onEvent: (callback: (event: AguiEvent) => void) => () => void;
  cancel: (runId?: string) => Promise<unknown>;
  getInterruptedRun?: (sessionId: string) => Promise<{ runId: string; rounds: number; todoCount: number; updatedAt: number } | null>;
}

interface ChoiceApi {
  resolve: (id: string, value: unknown) => Promise<{ ok: boolean }>;
}

interface PermissionApprovalRequest {
  id: string;
  runId?: string;
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
  return session.messages.map((message) => {
    const item: ChatMessageItem = {
      id: message.id,
      role: message.role === "model" ? "assistant" : "user",
      content: message.content,
      reasoning: message.reasoning,
      reasoningBlocks: message.reasoningBlocks,
      processMessages: message.processMessages,
      agentRounds: message.agentRounds,
      runActivity: message.runActivity,
      ttsCacheKey: message.ttsCacheKey,
      ttsCacheVersion: message.ttsCacheVersion,
      responseStarted: message.role === "model" && Boolean(message.content.trim() || message.sticker),
      sticker: message.sticker,
      toolExecutions: message.toolExecutions,
      attachments: message.attachments,
      contextUsage: message.contextUsage,
      runId: message.runSnapshot?.runId,
    };
    return message.runSnapshot ? recoverInterruptedMessage(item, message.runSnapshot) : item;
  });
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
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [skillPanelOpen, setSkillPanelOpen] = useState(false);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  /** 右侧 Review 检查面板：打开时把白色工作区挤窄 */
  const [reviewInspector, setReviewInspector] = useState<{ runId: string; fileIndex: number } | null>(null);
  /** 右侧面板当前激活的 tab（diff / plan），由打开动作自动切换 */
  const [inspectorTab, setInspectorTab] = useState<"diff" | "plan">("plan");
  const [mode, setMode] = useState<ConversationMode>(getInitialMode);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessageItem[]>>({});
  const [workspaceNames, setWorkspaceNames] = useState<Partial<Record<ConversationMode, string>>>({});
  const [pendingWorkspaceByMode, setPendingWorkspaceByMode] = useState<
    Partial<Record<ConversationMode, { path: string; displayName?: string }>>
  >({});
  // 欢迎页（无会话）暂存的模型选择：ensureSession 建会话后落地（与 pendingWorkspaceByMode 同构）。
  const [pendingModelProfileByMode, setPendingModelProfileByMode] = useState<
    Partial<Record<ConversationMode, string>>
  >({});
  const [attachmentsByScope, setAttachmentsByScope] = useState<Record<string, ComposerAttachment[]>>({});
  const [sessionsByMode, setSessionsByMode] = useState<Partial<Record<ConversationMode, ChatSessionMeta[]>>>({});
  const [activeSessionIds, setActiveSessionIds] = useState<Partial<Record<ConversationMode, string>>>({});
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [modelBusyByMode, setModelBusyByMode] = useState<Partial<Record<ConversationMode, boolean>>>({});
  const [isCompressingContext, setIsCompressingContext] = useState(false);
  const [interactionsBySession, setInteractionsBySession] = useState<SessionInteractionState>({});
  const [lastTurnRevisionStarting, setLastTurnRevisionStarting] = useState(false);
  const [stickerSize, setStickerSize] = useState<"small" | "standard" | "large">("standard");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [todoStateBySession, setTodoStateBySession] = useState<TodoStateBySession>({});
  // 计划模式（Plan Mode 二期）：会话级计划面板内容与阶段（review → executing → completed）。
  const [planReviewBySession, setPlanReviewBySession] = useState<
    Record<string, { content: string; planPath: string; phase: PlanReviewPhase }>
  >({});
  const [planDrawerOpen, setPlanDrawerOpen] = useState(false);
  const [interruptedRun, setInterruptedRun] = useState<{ runId: string; rounds: number; todoCount: number } | null>(null);
  // 会话守卫冲突（SESSION_RUN_ACTIVE）：主进程拒绝了并发 run，
  // 等用户决定是否终止旧 run 并接管重开本轮。仅 UX 层；正确性由主进程守卫保证。
  const [sessionTakeover, setSessionTakeover] = useState<{
    sessionId: string;
    activeRunId: string;
    retry: () => Promise<void>;
  } | null>(null);
  const activeModeRef = useRef(mode);
  const activeSessionIdsRef = useRef(activeSessionIds);
  const activeScopeRef = useRef(`mode:${mode}`);
  const sessionSelectionGeneration = useRef(0);
  const dragDepthRef = useRef(0);
  const localPreviewUrlsRef = useRef(new Set<string>());
  const demoTimers = useRef(new Set<number>());
  const activeRunsBySession = useRef<Record<string, { assistantId: string; runId?: string; mode: ConversationMode }>>({});
  const runCheckpointBySessionRef = useRef<Record<string, (status: "running" | "waiting_user") => void>>({});
  // bootstrap 标志：只由 cold-start finally 写入；模式切换 effect 仅检查
  const [bootstrapCompleted, setBootstrapCompleted] = useState(false);
  const observedModeRef = useRef(mode);
  // 长期持有的刷新操作 ref：供 IPC 回调读取当前实现
  const refreshSessionsRef = useRef<
    (targetMode: ConversationMode, selectCurrent: boolean) => Promise<void>
  >(async () => {});
  // IPC 切换串行链：保证 Ready 后连续切换按顺序完成
  const reactSessionSwitchChainRef = useRef<Promise<void>>(Promise.resolve());
  // 滚动到底部按钮状态
  const [scrollToBottomVisible, setScrollToBottomVisible] = useState(false);
  const scrollToBottomRef = useRef<() => void>(() => {});

  useEffect(() => {
    const settings = settingsApprovalApi();
    if (!settings) return;
    return settings.onPermissionApprovalRequest((request) => {
      const currentMode = activeModeRef.current;
      const currentSessionId = activeSessionIdsRef.current[currentMode];
      const ownerSessionId = findSessionIdForRun(activeRunsBySession.current, request.runId)
        ?? currentSessionId;
      if (!ownerSessionId) return;
      setInteractionForSession(ownerSessionId, permissionInteraction(request));
      const activeRun = activeRunsBySession.current[ownerSessionId];
      if (activeRun) {
        updateMessage(ownerSessionId, activeRun.assistantId, { runStage: { kind: "waiting_permission" } });
        runCheckpointBySessionRef.current[ownerSessionId]?.("waiting_user");
      }
    });
  }, []);

  useEffect(() => {
    const modelConfig = (window as typeof window & { modelConfig?: ModelConfigApi }).modelConfig;
    if (!modelConfig) return;
    let active = true;
    const apply = (config: PublicModelConfig) => {
      if (!active) return;
      setStickerSize(config.stickerSize === "small" || config.stickerSize === "large" ? config.stickerSize : "standard");
    };
    void modelConfig.get().then(apply).catch(() => {
      if (active) setStickerSize("standard");
    });
    const off = modelConfig.onChanged(apply);
    return () => {
      active = false;
      off();
    };
  }, []);
  const modelBusyByModeRef = useRef<Partial<Record<ConversationMode, boolean>>>({});
  const lastTurnRevisionStartingRef = useRef(false);
  const activeAguiOffsRef = useRef(new Set<() => void>());
  const cancelRequestedSessionsRef = useRef(new Set<string>());
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

  const activeSessionId = activeSessionIds[mode];
  const scopeKey = activeSessionId ?? `mode:${mode}`;
  const draft = drafts[scopeKey] ?? "";
  const messages = activeSessionId ? (messagesBySession[activeSessionId] ?? []) : [];
  const activeInteraction = sessionInteraction(interactionsBySession, activeSessionId);
  const composerInteraction = activeInteraction?.interaction;
  const interactionBusy = activeInteraction?.busy ?? false;
  const hasMessages = messages.length > 0;
  const attachments = attachmentsByScope[scopeKey] ?? [];
  const sessions = sessionsByMode[mode] ?? [];
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  // 会话级最新上下文快照（环形图优先读取点）：run 事件实时写入；
  // 手动压缩后随会话重载从 session.currentContextUsage 初始化（known-issues 问题 3）。
  const [sessionContextUsageBySession, setSessionContextUsageBySession] = useState<Record<string, ContextUsageSnapshot>>({});

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
    for (const off of activeAguiOffsRef.current) off();
    activeAguiOffsRef.current.clear();
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
    const previousMode = observedModeRef.current;
    observedModeRef.current = mode;
    if (!bootstrapCompleted || previousMode === mode) return;
    void refreshSessionsRef.current(mode, true).catch((error) => {
      console.error("[ChatPage] Failed to refresh sessions after mode change:", error);
    });
  }, [bootstrapCompleted, mode]);

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

    void bootstrapReactSession({
      urlSessionId: new URLSearchParams(window.location.search).get("sessionId"),
      currentMode: activeModeRef.current as ReactSessionMode,
      openSession: openSessionById,
      refreshSessions: async (targetMode, selectCurrent) => {
        await refreshSessions(targetMode as ConversationMode, selectCurrent);
      },
    }).catch((error) => {
      console.error("[ChatPage] Failed to bootstrap React session:", error);
    }).finally(() => {
        // cold-start 全程完成才标记 bootstrap 完成；只有该标志置位后
        // mode 切换 effect 才会触发 refreshSessions
        setBootstrapCompleted(true);
        if (!disposed) store.notifyReactReady?.();
    });

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

  useEffect(() => {
    const sessionId = activeSessionId;
    const api = aguiApi();
    if (!sessionId || !api?.getInterruptedRun || mode === "chat") {
      setInterruptedRun(null);
      return;
    }
    let active = true;
    void api.getInterruptedRun(sessionId).then((run) => {
      if (active) setInterruptedRun(run ? { runId: run.runId, rounds: run.rounds, todoCount: run.todoCount } : null);
    }).catch(() => { if (active) setInterruptedRun(null); });
    return () => { active = false; };
  }, [activeSessionId, mode]);

  // 计划模式事件（Plan Mode）：review/approved/exited 在 run 结束后由主进程发出
  // （run 订阅已解除），必须持久监听；completed 在 run 内发出，run 订阅无此分支，
  // 也统一在这里处理。批准后自动发送执行消息（sendMessage 自带 busy 排队机制）。
  useEffect(() => {
    const api = aguiApi();
    if (!api?.onEvent || !shouldListenForDeferredPlanEvents(mode) || !activeSessionId) return;
    const off = api.onEvent((event) => {
      if (event.type !== "CUSTOM" || typeof event.name !== "string") return;
      if (event.name === "cyrene.choice") {
        const interaction = normalizeDeferredPlanChoice(event.value, activeSessionId);
        if (interaction) setInteractionForSession(activeSessionId, interaction);
        return;
      }
      if (!event.name.startsWith("cyrene.plan.")) return;
      const value = (event.value ?? null) as { sessionId?: string; planPath?: string; planContent?: string; text?: string } | null;
      if (value?.sessionId && value.sessionId !== activeSessionId) return;
      switch (event.name) {
        case "cyrene.plan.review":
          if (value?.sessionId && typeof value.planContent === "string" && value.planContent.trim()) {
            setPlanReviewBySession((current) => ({
              ...current,
              [value.sessionId!]: {
                content: value.planContent!,
                planPath: value.planPath ?? "",
                phase: "review",
              },
            }));
            setPlanDrawerOpen(true);
            setInspectorTab("plan");
          }
          break;
        case "cyrene.plan.approved":
          if (value?.sessionId) {
            setPlanReviewBySession((current) => current[value.sessionId!]
              ? { ...current, [value.sessionId!]: { ...current[value.sessionId!], phase: "executing" } }
              : current);
            void sendMessage("已批准计划，请开始执行。");
          }
          break;
        case "cyrene.plan.supplement":
          // 第二段补充卡提交的文本：作为用户消息发给模型修改计划，改完会重新走审批
          if (value?.sessionId && typeof value.text === "string" && value.text.trim()) {
            void sendMessage(value.text);
          }
          break;
        case "cyrene.plan.completed":
          // adapter 发出时不带 sessionId；按当前计划会话处理
          setPlanReviewBySession((current) => current[activeSessionId]
            ? { ...current, [activeSessionId]: { ...current[activeSessionId], phase: "completed" } }
            : current);
          break;
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeSessionId]);

  function setInteractionForSession(sessionId: string, interaction: ComposerInteraction): void {
    setInteractionsBySession((current) => setSessionInteraction(current, sessionId, interaction));
  }

  function clearInteractionForSession(sessionId: string): void {
    setInteractionsBySession((current) => clearSessionInteraction(current, sessionId));
  }

  function setInteractionBusyForSession(sessionId: string, busy: boolean): void {
    setInteractionsBySession((current) => setSessionInteractionBusy(current, sessionId, busy));
  }

  function updateMessage(targetScope: ConversationMode | string, id: string, patch: Partial<ChatMessageItem>) {
    setMessagesBySession((current) => {
      const ownerSessionId = isConversationMode(targetScope)
        ? Object.entries(current).find(([, items]) => items.some((item) => item.id === id))?.[0]
          ?? activeSessionIdsRef.current[targetScope]
        : targetScope;
      return ownerSessionId ? patchSessionMessage(current, ownerSessionId, id, patch) : current;
    });
  }

  function handleTtsCacheKey(
    targetMode: ConversationMode,
    sessionId: string,
    messageId: string,
    cacheKey: string,
    converterVersion: string,
  ) {
    updateMessage(sessionId, messageId, { ttsCacheKey: cacheKey, ttsCacheVersion: converterVersion });
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
    setActiveSession(session);
    // 环形图快照初始化：session 级（压缩后写入）与消息级（最近 run 留下）取最新。
    setSessionContextUsageBySession((current) => {
      const messageLevel = session.messages.findLast((message) => message.contextUsage)?.contextUsage;
      const sessionLevel = session.currentContextUsage;
      const best = sessionLevel && (!messageLevel || sessionLevel.updatedAt >= messageLevel.updatedAt)
        ? sessionLevel
        : messageLevel;
      if (!best || current[sessionId]?.updatedAt === best.updatedAt) return current;
      return { ...current, [sessionId]: best };
    });
    setActiveSessionIds((current) => {
      const next = { ...current, [targetMode]: sessionId };
      activeSessionIdsRef.current = next;
      return next;
    });
    const uiMessages = toUiMessages(session);
    const latestRunSnapshot = session.messages.findLast((message) => message.runSnapshot)?.runSnapshot;
    if (latestRunSnapshot?.todos) {
      setTodoStateBySession((current) => {
        if (hasActiveRunForSession(activeRunsBySession.current, sessionId) && current[sessionId]) return current;
        return {
          ...current,
          [sessionId]: {
            runId: latestRunSnapshot.runId,
            todos: latestRunSnapshot.todos ?? [],
            updatedAt: latestRunSnapshot.updatedAt,
          },
        };
      });
    }
    setMessagesBySession((current) => hydrateSessionMessages(
      current,
      sessionId,
      uiMessages,
      hasActiveRunForSession(activeRunsBySession.current, sessionId),
    ));
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
    const opened = await openSessionByIdWithDeps({
      sessionId,
      getSession: async (id) => {
        const store = chatStore();
        if (!store) return null;
        const result = await store.get(id);
        return (result ?? null) as { mode?: string } | null;
      },
      selectSession: async (id, targetMode) => {
        await selectSession(id, targetMode as ConversationMode);
      },
    });
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
    setWorkspaceNames((current) => ({ ...current, [targetMode]: undefined }));
    if (targetMode === activeModeRef.current) void store.setActiveSession(null);
  }

  // 渲染期间同步安装真实实现，保证 mount effect 不会先观察到默认 no-op。
  refreshSessionsRef.current = refreshSessions;

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
    targetMode: "chat" | "work" | "code";
    sessionId: string;
    userMessageId: string;
    assistantId: string;
    session: ChatSession;
    attachments: ComposerAttachment[];
    resumeFromRunId?: string;
    takeoverFromRunId?: string;
  }) {
    const api = aguiApi();
    const store = chatStore();
    if (!api || !store) {
      const visibleError = "模型请求失败：AG-UI 模型服务尚未就绪";
      updateMessage(input.sessionId, input.assistantId, {
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
    setModelBusyByMode((current) => ({ ...current, [input.targetMode]: true }));
    const earlyTtsQueue = createEarlyTtsQueue(input.targetMode, input.sessionId, input.assistantId);
    let streamContent = "";
    // RUN_FINISHED.result.status，用于区分 success / cancelled / timeout / runtime_error
    let terminalStatus: string | undefined;
    let reasoningContent = "";
    let reasoningBlocks: ReasoningBlock[] = [];
    let processMessages: ProcessMessageRecord[] = [];
    let agentRounds: AgentRoundRecord[] = [];
    let taskDelegations: TaskDelegationDisplayRecord[] = [];
    let activeRoundId: string | undefined;
    let processMessageSequence = 0;
    let finalMessageCompleted = false;
    let revealCancelled = false;
    let revealChain: Promise<void> = Promise.resolve();
    let sticker: string | null = null;
    let toolExecutions: ToolExecutionRecord[] = [];
    let runStarted = false;
    let runActivity: RunActivityRecord | undefined;
    let currentTodos: TodoItem[] = [];
    let persistedFinalContent = "";
    // 上下文容量快照：preRequest 每轮实时覆盖（纯内存），terminal 随 checkpoint 落盘。
    let contextUsage: ContextUsageSnapshot | undefined;
    const assistantAt = Date.now();
    let checkpointTimer: number | undefined;
    let checkpointChain = Promise.resolve<ChatSession | null>(null);
    const activeReasoningStarts = new Map<string, number>();
    let currentReasoningId: string | undefined;
    let resolveTerminal!: (error?: Error) => void;
    const terminal = new Promise<Error | undefined>((resolve) => {
      resolveTerminal = resolve;
    });
    const buildCheckpoint = (
      status: "running" | "waiting_user" | "terminal",
    ): ChatMessage => ({
      id: input.assistantId,
      role: "model",
      content: status === "terminal" ? persistedFinalContent : "",
      reasoning: reasoningContent || undefined,
      reasoningBlocks,
      processMessages,
      agentRounds,
      taskDelegations,
      runActivity,
      at: assistantAt,
      sticker,
      toolExecutions,
      contextUsage,
      runSnapshot: {
        runId: activeRunsBySession.current[input.sessionId]?.runId,
        status,
        terminalStatus: status === "terminal"
          ? (terminalStatus as "success" | "cancelled" | "timeout" | "runtime_error" | undefined)
          : undefined,
        todos: currentTodos,
        updatedAt: Date.now(),
      },
    });
    const writeCheckpoint = (
      status: "running" | "waiting_user" | "terminal",
    ): Promise<ChatSession | null> => {
      const snapshot = buildCheckpoint(status);
      checkpointChain = checkpointChain
        .catch(() => null)
        .then(() => store.upsert(input.sessionId, snapshot));
      return checkpointChain;
    };
    const checkpointRun = (
      status: "running" | "waiting_user" | "terminal",
      immediate = false,
    ): Promise<ChatSession | null> => {
      if (checkpointTimer !== undefined) {
        window.clearTimeout(checkpointTimer);
        checkpointTimer = undefined;
      }
      if (immediate) return writeCheckpoint(status);
      checkpointTimer = window.setTimeout(() => {
        checkpointTimer = undefined;
        void writeCheckpoint(status);
      }, 350);
      return checkpointChain;
    };
    runCheckpointBySessionRef.current = {
      ...runCheckpointBySessionRef.current,
      [input.sessionId]: (status) => {
        void checkpointRun(status, true);
      },
    };
    await checkpointRun("running", true);
    const updateRunTool = (toolId: string, patch: Partial<ToolExecutionRecord>) => {
      const index = toolExecutions.findIndex((tool) => tool.id === toolId);
      toolExecutions = index === -1
        ? [...toolExecutions, {
            id: toolId,
            name: patch.name ?? "工具调用",
            status: patch.status ?? "running",
            result: patch.result,
            argsText: patch.argsText,
            changes: patch.changes,
            roundId: patch.roundId ?? activeRoundId,
          }]
        : toolExecutions.map((tool, toolIndex) => toolIndex === index ? { ...tool, ...patch } : tool);
      updateMessage(input.sessionId, input.assistantId, { toolExecutions });
    };
    const enqueuePublicTextReveal = (content: string, publish: (chunk: string) => void) => {
      if (input.targetMode === "chat") {
        publish(content);
        return;
      }
      revealChain = revealChain.then(async () => {
        for (const chunk of splitTextForReveal(content)) {
          if (revealCancelled) break;
          publish(chunk);
          await new Promise<void>((resolve) => window.setTimeout(resolve, 14));
        }
      });
    };
    const publishRunActivity = () => {
      if (!runActivity) return;
      updateMessage(input.sessionId, input.assistantId, { runActivity: { ...runActivity } });
    };
    const updateActiveReasoningStart = () => {
      const starts = [...activeReasoningStarts.values()];
      if (!runActivity) return;
      runActivity = {
        ...runActivity,
        activeReasoningStartedAt: starts.length ? Math.min(...starts) : undefined,
      };
    };
    const completeRunActivity = (keepExpanded = false) => {
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
          keepExpanded,
        };
        publishRunActivity();
      }
    };
    const markFirstResponse = () => {
      updateMessage(input.sessionId, input.assistantId, { waitingForFirstEvent: false });
    };
    const updateReasoningBlock = (id: string, patch: Partial<ReasoningBlock>) => {
      const index = reasoningBlocks.findIndex((block) => block.id === id);
      reasoningBlocks = index < 0
        ? [...reasoningBlocks, { id, content: "", afterToolCount: toolExecutions.length, roundId: activeRoundId, ...patch }]
        : reasoningBlocks.map((block, blockIndex) => blockIndex === index ? { ...block, ...patch } : block);
      reasoningContent = reasoningBlocks.map((block) => block.content).filter(Boolean).join("\n\n");
      updateMessage(input.sessionId, input.assistantId, { reasoning: reasoningContent || undefined, reasoningBlocks });
      void checkpointRun("running");
    };

    const handleEvent = (event: AguiEvent) => {
      if (event.type === "CUSTOM" && event.name === "cyrene.round") {
        const value = event.value as { action?: unknown; roundId?: unknown } | null | undefined;
        if ((value?.action === "start" || value?.action === "end") && typeof value.roundId === "string") {
          const next = applyAgentRoundBoundary(
            { rounds: agentRounds, activeRoundId },
            value.action,
            value.roundId,
          );
          agentRounds = next.rounds;
          activeRoundId = next.activeRoundId;
          updateMessage(input.sessionId, input.assistantId, { agentRounds });
          void checkpointRun("running", true);
        }
      } else if (event.type === "RUN_STARTED") {
        runStarted = true;
        runActivity = { startedAt: Date.now(), reasoningMs: 0 };
        setIsCompressingContext(false);
        if (event.runId) {
          // RUN_STARTED.runId 必须与 ack.runId 一致（由 bridge 注入 options.runId 保证）。
          // 不一致时只 warn 不重写，避免渲染端拿到错误 runId 后无法 cancel。
          const existing = activeRunsBySession.current[input.sessionId];
          if (existing?.runId && existing.runId !== event.runId) {
            console.warn(
              `[ChatPage] RUN_STARTED.runId (${event.runId}) 与 ack.runId (${existing.runId}) 不一致，` +
              `请检查 bridge 是否正确注入 options.runId。保留 ack.runId 作为权威值。`,
            );
          } else {
            activeRunsBySession.current = {
              ...activeRunsBySession.current,
              [input.sessionId]: { ...(existing ?? { assistantId: input.assistantId, mode: input.targetMode }), runId: event.runId },
            };
          }
        }
        currentTodos = [];
        setTodoStateBySession((current) => startSessionTodos(
          current,
          input.sessionId,
          event.runId ?? activeRunsBySession.current[input.sessionId]?.runId,
        ));
        updateMessage(input.sessionId, input.assistantId, {
          waitingForFirstEvent: false,
          runActivity: { ...runActivity },
          runStage: { kind: "understanding" },
          runId: event.runId ?? activeRunsBySession.current[input.sessionId]?.runId,
        });
        void checkpointRun("running", true);
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
        updateMessage(input.sessionId, input.assistantId, {
          loading: false,
          reasoningStreaming: true,
          runStage: { kind: "responding" },
        });
      } else if (event.type === "REASONING_MESSAGE_CONTENT" && event.delta) {
        const reasoningId = event.messageId ?? currentReasoningId ?? crypto.randomUUID();
        currentReasoningId = reasoningId;
        const current = reasoningBlocks.find((block) => block.id === reasoningId)?.content ?? "";
        updateReasoningBlock(reasoningId, { content: current + event.delta, streaming: true });
        updateMessage(input.sessionId, input.assistantId, {
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
        updateMessage(input.sessionId, input.assistantId, { reasoningStreaming: false, loading: false });
        } else if (event.type === "STEP_STARTED") {
          const stage = stageForStep(event.stepName);
          if (stage) updateMessage(input.sessionId, input.assistantId, { runStage: stage });
        } else if (event.type === "TOOL_CALL_START" && event.toolCallId) {
          updateRunTool(event.toolCallId, {
            name: event.toolCallName ?? "工具调用",
            status: "running",
            roundId: activeRoundId,
          });
          updateMessage(input.sessionId, input.assistantId, {
            runStage: { kind: "executing", detail: event.toolCallName ?? "工具调用" },
          });
      } else if (event.type === "TOOL_CALL_ARGS" && event.toolCallId && event.delta) {
        const currentArgs = toolExecutions.find((tool) => tool.id === event.toolCallId)?.argsText ?? "";
        updateRunTool(event.toolCallId, { argsText: currentArgs + event.delta, roundId: activeRoundId });
      } else if (event.type === "TOOL_CALL_RESULT" && event.toolCallId) {
        updateRunTool(event.toolCallId, {
          status: event.status === "failed" ? "error" : "success",
          result: (event.content ?? "").slice(0, 4000),
          changes: event.changes,
        });
        void checkpointRun("running", true);
      } else if (event.type === "TOOL_CALL_END" && event.toolCallId) {
        updateRunTool(event.toolCallId, {});
      } else if (event.type === "TEXT_MESSAGE_START") {
        updateMessage(input.sessionId, input.assistantId, {
          loading: false,
          reasoningStreaming: false,
          responseStarted: true,
          streaming: true,
          runStage: { kind: "responding" },
        });
      } else if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) {
        enqueuePublicTextReveal(event.delta, (chunk) => {
          streamContent += chunk;
          earlyTtsQueue.append(chunk);
          updateMessage(input.sessionId, input.assistantId, {
            content: streamContent,
            loading: false,
            streaming: true,
            responseStarted: true,
          });
          void checkpointRun("running");
        });
      } else if (event.type === "TEXT_MESSAGE_END") {
        revealChain = revealChain.then(() => {
          finalMessageCompleted = true;
          updateMessage(input.sessionId, input.assistantId, { streaming: false });
        });
      } else if (event.type === "CUSTOM" && event.name === "cyrene.process_text") {
        const content = (event.value as { content?: unknown } | null | undefined)?.content;
        if (typeof content === "string" && content.trim()) {
          const processId = `process-${processMessageSequence++}`;
          processMessages = [...processMessages, createRoundProcessMessage(
            processId,
            "",
            toolExecutions.length,
            activeRoundId,
          )];
          updateMessage(input.sessionId, input.assistantId, { processMessages });
          enqueuePublicTextReveal(content, (chunk) => {
            processMessages = processMessages.map((message) => message.id === processId
              ? { ...message, content: message.content + chunk }
              : message);
            updateMessage(input.sessionId, input.assistantId, { processMessages });
            void checkpointRun("running");
          });
        }
      } else if (event.type === "CUSTOM" && event.name === "cyrene.task") {
        const delegation = normalizeTaskDelegationEvent(event.value);
        if (delegation) {
          taskDelegations = applyTaskDelegationEvent(taskDelegations, delegation, activeRoundId);
          updateMessage(input.sessionId, input.assistantId, {
            taskDelegations,
            runStage: { kind: "executing", detail: delegation.nickname },
          });
          void checkpointRun("running", true);
        }
      } else if (event.type === "CUSTOM" && event.name === "cyrene.choice") {
        const interaction = normalizeChoiceInteraction(event.value);
        if (interaction) {
          setInteractionForSession(input.sessionId, interaction);
          updateMessage(input.sessionId, input.assistantId, { runStage: { kind: "waiting_user" } });
          void checkpointRun("waiting_user", true);
        }
      } else if (event.type === "CUSTOM" && event.name === "cyrene.choice.dismiss") {
        setInteractionsBySession((current) => {
          const interaction = sessionInteraction(current, input.sessionId)?.interaction;
          if (interaction?.kind !== "ask" || !shouldDismissAsk(interaction, event.value)) return current;
          return clearSessionInteraction(current, input.sessionId);
        });
        void checkpointRun("running", true);
      } else if (event.type === "CUSTOM" && event.name === "cyrene.taskPlan") {
        const taskPlan = normalizeTaskPlanPresentation(event.value);
        if (taskPlan) {
          updateMessage(input.sessionId, input.assistantId, {
            taskPlan,
            runStage: { kind: "executing" },
          });
        }
      } else if (event.type === "CUSTOM" && event.name === "cyrene.todo") {
        // Harness 的 Todo 复用右侧现有 TodoPanel，不再复制成消息内 TaskPlanCard。
        const items = (event.value as { items?: Array<{ id: string; content: string; status: string }> } | null | undefined)?.items;
        if (Array.isArray(items)) {
          const ownerRunId = event.runId ?? activeRunsBySession.current[input.sessionId]?.runId;
          const normalized = mergeHarnessTodosForSession({
            [input.sessionId]: {
              runId: ownerRunId,
              todos: currentTodos,
              updatedAt: Date.now(),
            },
          }, input.sessionId, ownerRunId, items);
          currentTodos = normalized[input.sessionId]?.todos ?? currentTodos;
          setTodoStateBySession((current) => mergeHarnessTodosForSession(
            current,
            input.sessionId,
            ownerRunId,
            items,
          ));
          void checkpointRun("running", true);
        }
      } else if (event.type === "CUSTOM" && event.name === "cyrene.compressingContext") {
        setIsCompressingContext(true);
      } else if (event.type === "CUSTOM" && event.name === "cyrene.context.usage") {
        // 上下文容量快照：preRequest 纯内存实时刷新（零 I/O）；
        // terminal 用 debounce 版 checkpointRun，合并进紧随其后的 RUN_FINISHED terminal checkpoint，一次落盘。
        const snapshot = isContextUsageSnapshot(event.value) ? event.value : undefined;
        if (snapshot) {
          contextUsage = snapshot;
          updateMessage(input.sessionId, input.assistantId, { contextUsage: snapshot });
          // session 级状态同步刷新：环形图优先读取点，手动压缩等场景不再依赖消息级兜底。
          setSessionContextUsageBySession((current) => ({ ...current, [input.sessionId]: snapshot }));
          if (snapshot.phase === "terminal") void checkpointRun("running");
        }
      } else if (event.type === "CUSTOM" && event.name === "cyrene.sticker") {
        sticker = typeof event.value === "string" ? event.value : null;
        updateMessage(input.sessionId, input.assistantId, { sticker });
      } else if (event.type === "CUSTOM" && event.name === "cyrene.weather") {
        const weather = normalizeWeatherData(event.value);
        if (weather) {
          updateMessage(input.sessionId, input.assistantId, { weather });
        }
      } else if (event.type === "RUN_FINISHED") {
        // 读取 result.status 区分终态（success / cancelled / timeout / runtime_error）
        const result = (event as { result?: { status?: string } }).result;
        terminalStatus = result?.status;
        if (terminalStatus !== "success") revealCancelled = true;
        const stage = resolveRunFinishedStage(result);
        updateMessage(input.sessionId, input.assistantId, { runStage: stage });
        const activeRunId = activeRunsBySession.current[input.sessionId]?.runId;
        if (shouldClearComposerInteractionForTerminal(activeRunId, event.runId)) {
          clearInteractionForSession(input.sessionId);
        }
        resolveTerminal();
      } else if (event.type === "RUN_ERROR") {
        revealCancelled = true;
        completeRunActivity(true);
        updateMessage(input.sessionId, input.assistantId, { runStage: { kind: "failed" } });
        const activeRunId = activeRunsBySession.current[input.sessionId]?.runId;
        if (shouldClearComposerInteractionForTerminal(activeRunId, event.runId)) {
          clearInteractionForSession(input.sessionId);
        }
        resolveTerminal(new Error(event.message ?? event.error ?? event.content ?? "模型请求失败"));
      }
    };
    const eventGate = new RunEventGate<AguiEvent>();
    const off = api.onEvent((event) => {
      for (const accepted of eventGate.accept(event)) handleEvent(accepted);
    });
    activeAguiOffsRef.current.add(off);

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
        recoveryContext: buildTodoRecoveryContext(input.session.messages, input.assistantId),
        ...(input.resumeFromRunId ? { resumeFromRunId: input.resumeFromRunId } : {}),
        ...(input.takeoverFromRunId ? { takeoverFromRunId: input.takeoverFromRunId } : {}),
        imageAttachments: input.attachments
          .filter((attachment) => attachment.kind === "image" && attachment.filePath)
          .map((attachment) => ({
            name: attachment.name,
            filePath: attachment.filePath!,
            mime: attachment.mime,
          })),
      });
      if (!ack.success) throw new Error(ack.error ?? "模型请求发起失败");
      // 新 run 已被主进程接受：同会话旧的守卫冲突操作卡（若有）不再有效
      setSessionTakeover((current) => (current && current.sessionId === input.sessionId ? null : current));
      // 立即把 ack.runId 写入 activeRunsBySession，
      // 让 cancel 在 RUN_STARTED 事件到达前也能找到正确的 runId。
      // RUN_STARTED.runId 必须与 ack.runId 一致（由 bridge 注入 options.runId 保证）。
      if (ack.runId) {
        const existing = activeRunsBySession.current[input.sessionId];
        activeRunsBySession.current = {
          ...activeRunsBySession.current,
          [input.sessionId]: {
            ...(existing ?? { assistantId: input.assistantId, mode: input.targetMode }),
            runId: ack.runId,
          },
        };
        for (const accepted of eventGate.bind(ack.runId)) handleEvent(accepted);
        await checkpointRun("running", true);
        if (cancelRequestedSessionsRef.current.delete(input.sessionId)) {
          await api.cancel(ack.runId);
        }
      }
      const terminalError = await terminal;
      if (terminalError) throw terminalError;
      await revealChain;

      // 只有 success + 完整 TEXT_MESSAGE_END + 非空正文才提交正式回答。
      // cancelled / timeout / runtime_error 与半截流都只保留在展开的过程区。
      const formalAnswerCommitted = isFormalAnswerCommitted(streamContent, terminalStatus, finalMessageCompleted);
      completeRunActivity(!formalAnswerCommitted);
      const finalContent = formalAnswerCommitted ? resolveTerminalContent(streamContent, terminalStatus) : "";
      persistedFinalContent = finalContent;
      updateMessage(input.sessionId, input.assistantId, {
        content: finalContent,
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        reasoning: reasoningContent || undefined,
        reasoningBlocks,
        processMessages,
        agentRounds,
        reasoningStreaming: false,
        runActivity,
        responseStarted: formalAnswerCommitted,
        sticker,
        toolExecutions,
      });
      const savedAssistant = await checkpointRun("terminal", true);
      if (savedAssistant && formalAnswerCommitted) {
        finishEarlyTtsQueue(earlyTtsQueue, finalContent);
      } else earlyTtsQueue.cancel();
    } catch (error) {
      earlyTtsQueue.cancel();
      terminalStatus = terminalStatus ?? "runtime_error";
      completeRunActivity(true);
      const errorMessage = error instanceof Error ? error.message : String(error);
      // 会话守卫冲突：主进程拒绝了并发 run（典型场景：F5 后立即发消息）。
      // 不走通用错误文案，改为挂起操作卡等用户决定是否终止旧 run 并重开本轮。
      const conflictRunId = parseSessionRunActiveError(errorMessage);
      if (conflictRunId) {
        processMessages = [...processMessages, createRoundProcessMessage(
          `process-${processMessageSequence++}`,
          "当前会话已有正在运行的任务（可能来自刷新前的旧运行），本轮未执行。",
          toolExecutions.length,
          activeRoundId,
        )];
        updateMessage(input.sessionId, input.assistantId, {
          content: "",
          processMessages,
          loading: false,
          waitingForFirstEvent: false,
          streaming: false,
          reasoningStreaming: false,
          runActivity,
          responseStarted: false,
        });
        persistedFinalContent = "";
        setSessionTakeover({
          sessionId: input.sessionId,
          activeRunId: conflictRunId,
          retry: async () => {
            // 重开本轮：assistant 占位消息回到 loading，带 takeoverFromRunId 重发
            updateMessage(input.sessionId, input.assistantId, {
              loading: true,
              waitingForFirstEvent: true,
              streaming: false,
              responseStarted: false,
            });
            await runModel({ ...input, takeoverFromRunId: conflictRunId });
          },
        });
        await checkpointRun("terminal", true);
        return;
      }
      const visibleError = `模型请求失败：${errorMessage}`;
      processMessages = [...processMessages, createRoundProcessMessage(
        `process-${processMessageSequence++}`,
        visibleError,
        toolExecutions.length,
        activeRoundId,
      )];
      updateMessage(input.sessionId, input.assistantId, {
        content: "",
        processMessages,
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        reasoningStreaming: false,
        runActivity,
        responseStarted: false,
      });
      persistedFinalContent = "";
      await checkpointRun("terminal", true);
    } finally {
      if (checkpointTimer !== undefined) window.clearTimeout(checkpointTimer);
      const checkpointCallbacks = { ...runCheckpointBySessionRef.current };
      delete checkpointCallbacks[input.sessionId];
      runCheckpointBySessionRef.current = checkpointCallbacks;
      off();
      activeAguiOffsRef.current.delete(off);
      const currentActive = activeRunsBySession.current[input.sessionId];
      cancelRequestedSessionsRef.current.delete(input.sessionId);
      if (currentActive?.assistantId === input.assistantId) {
        const nextActive = { ...activeRunsBySession.current };
        delete nextActive[input.sessionId];
        activeRunsBySession.current = nextActive;
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
    return hasActiveRunForSession(activeRunsBySession.current, sessionId);
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
      setMessagesBySession((current) => ({
        ...current,
        [sessionId]: [
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
    const sessionId = activeSessionIdsRef.current.chat;
    const lastTurn = resolveRevisableLastTurn(sessionId ? (messagesBySession[sessionId] ?? []) : [], "chat");
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
    const hasPendingWorkspace = !!pendingWorkspaceByMode[targetMode];
    const session = await store.create({
      identityId: null,
      mode: targetMode,
      title:
        targetMode === "work" || targetMode === "code" || hasPendingWorkspace
          ? "新任务"
          : "新对话",
    });
    // 欢迎页暂存的模型选择在此落地（问题 2：无会话时选择器曾被静默丢弃）。
    const pendingModelProfileId = pendingModelProfileByMode[targetMode];
    if (pendingModelProfileId) {
      await store.setModelProfile(session.id, pendingModelProfileId);
      setPendingModelProfileByMode((current) => {
        const next = { ...current };
        delete next[targetMode];
        return next;
      });
    }
    await refreshSessions(targetMode, false);
    await selectSession(session.id, targetMode);
    return session.id;
  }



  async function initVaultStructure(sessionId: string, options?: { confirm?: boolean }) {
    const store = chatStore();
    if (!store) return;
    const confirmed = options?.confirm === false || window.confirm(
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

    const workspace = { path: picked.path, displayName: picked.displayName ?? "工作文件夹" };
    setWorkspaceNames((current) => ({ ...current, [targetMode]: workspace.displayName }));

    const activeId = activeSessionIdsRef.current[targetMode];
    if (activeId) {
      const result = await store.setWorkspace(activeId, workspace.path);
      if (!result.ok) {
        window.alert(`设置工作区失败：${result.error ?? "未知错误"}`);
        return;
      }
      // Learn 模式：空目录询问是否初始化通用学习结构
      if (targetMode === "learn" && result.isEmpty) {
        const confirmed = window.confirm(
          "这是一个空目录。Cyrene 可以在这里创建通用学习工作区结构（materials/、notes/、exercises/、templates/、learn/progress.md），方便你之后和 Cyrene 一起学习。\n\n是否创建？"
        );
        if (confirmed) {
          await initVaultStructure(activeId, { confirm: false });
        }
      }
      await refreshSessions(targetMode, false);
    } else {
      // 还没有发送第一条消息、未创建 session，先暂存工作区，发消息时一起绑定。
      setPendingWorkspaceByMode((current) => ({ ...current, [targetMode]: workspace }));
    }
  }

  async function createNewTask() {
    const targetMode = mode;
    const store = chatStore();
    if (!store) return;

    // 点“新建”不真正创建 session，只清空当前模式的状态并回到欢迎页。
    // 工作区保留：如果当前 session 已绑定项目，新任务继续在该项目下创建；
    // 否则沿用之前通过 chooseWorkspace 选好的待绑定目录。
    const activeId = activeSessionIdsRef.current[targetMode];
    const activeSession = activeId ? await store.get(activeId) : null;
    const inheritedWorkspace = activeSession?.workspaceBinding?.workspaceRoot
      ? {
          path: activeSession.workspaceBinding.workspaceRoot,
          displayName: activeSession.workspaceBinding.displayName,
        }
      : pendingWorkspaceByMode[targetMode];

    setActiveSessionIds((current) => {
      const next = { ...current };
      delete next[targetMode];
      activeSessionIdsRef.current = next;
      return next;
    });
    setDrafts((current) => {
      const next = { ...current };
      delete next[`mode:${targetMode}`];
      return next;
    });
    setAttachmentsByScope((current) => {
      const next = { ...current };
      delete next[`mode:${targetMode}`];
      return next;
    });
    setPendingWorkspaceByMode((current) => {
      const next = { ...current };
      if (inheritedWorkspace) {
        next[targetMode] = inheritedWorkspace;
      } else {
        delete next[targetMode];
      }
      return next;
    });
    setWorkspaceNames((current) => {
      const next = { ...current };
      if (!inheritedWorkspace) {
        delete next[targetMode];
      }
      return next;
    });
    setToolPanelOpen(false);
    setSkillPanelOpen(false);
    setModelPanelOpen(false);
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

  /** 粘贴/截图临时图片大小上限：与主进程 MAX_SCREENSHOT_BYTES（20MB）一致，前端提前拦截。 */
  const PASTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  /**
   * Ctrl+V 粘贴图片：落主进程 screenshots/ 临时文件（复用截图链路），
   * 构造与按钮截图相同的 ComposerAttachment 追加进当前 scope。
   */
  async function handlePastedImage(file: File) {
    const targetScope = scopeKey;
    if (!window.chat?.saveScreenshotTemp) return;
    if (file.size > PASTE_IMAGE_MAX_BYTES) {
      window.alert("粘贴的图片超过 20MB，已跳过。");
      return;
    }
    setAttachmentBusy(true);
    try {
      const base64 = arrayBufferToBase64(await file.arrayBuffer());
      const { filePath } = await window.chat.saveScreenshotTemp(base64, file.type);
      const previewUrl = URL.createObjectURL(file);
      localPreviewUrlsRef.current.add(previewUrl);
      const attachment: ComposerAttachment = {
        kind: "image",
        name: file.name && file.name !== "image.png" ? file.name : `粘贴图片_${Date.now()}.png`,
        filePath,
        mime: file.type,
        previewUrl,
      };
      setAttachmentsByScope((current) => ({
        ...current,
        [targetScope]: [...(current[targetScope] ?? []), attachment],
      }));
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const text = raw === "SCREENSHOT_TOO_LARGE"
        ? "粘贴的图片超过 20MB。"
        : raw === "INVALID_SCREENSHOT_IMAGE"
          ? "粘贴的内容不是有效图片。"
          : `粘贴图片失败：${raw}`;
      window.alert(text);
    } finally {
      setAttachmentBusy(false);
    }
  }

  /** 截图按钮：失败不再静默，按 reason 给可读提示（known-issues 问题 4）。 */
  async function handleScreenshot() {
    const result = await window.chat?.startScreenshot();
    if (!result || result.ok) return;
    const reason = typeof result.reason === "string" ? result.reason : "";
    let text: string;
    if (reason.startsWith("HELPER_")) {
      text = "截图组件未就绪，请稍后重试。";
    } else if (reason.startsWith("SCREENSHOT_CANCELLED")) {
      text = "已取消截图。";
    } else if (reason === "SCREENSHOT_FILE_PATH_REQUIRED") {
      text = "截图失败：未生成截图文件。";
    } else {
      text = `截图失败：${reason || "未知错误"}`;
    }
    window.alert(text);
  }

  function updateMessageAttachments(
    sessionId: string,
    messageId: string,
    updater: (attachments: ComposerAttachment[]) => ComposerAttachment[],
  ) {
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((item) => (
        item.id === messageId
          ? { ...item, attachments: updater(item.attachments ?? []) }
          : item
      )),
    }));
  }

  async function prepareImageAttachments(
    sessionId: string,
    messageId: string,
    attachments: ComposerAttachment[],
  ) {
    const images = attachments.filter((attachment) => attachment.kind === "image" && attachment.filePath);
    if (images.length === 0 || !window.chat) return;

    let strategy: { mode: "direct" | "caption" } = { mode: "caption" };
    try {
      // 传 sessionId：会话绑定的档案若声明 multimodal 则按档案裁决，否则回退全局
      strategy = await window.chat.getImageSendStrategy(sessionId);
    } catch (error) {
      console.warn("[Cyrene React] 获取图片发送策略失败，回退视觉描述:", error);
    }

    if (strategy.mode === "direct") {
      const paths = new Set(images.map((image) => image.filePath));
      updateMessageAttachments(sessionId, messageId, (current) => current.map((attachment) => (
        paths.has(attachment.filePath)
          ? { ...attachment, imageSendMode: "direct", status: "done" }
          : attachment
      )));
      return;
    }

    for (const image of images) {
      updateMessageAttachments(sessionId, messageId, (current) => current.map((attachment) => (
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
      updateMessageAttachments(sessionId, messageId, (current) => current.map((attachment) => (
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

  async function sendMessage(content: string, resumeFromRunId?: string) {
    const parsedMessage = parseComposerMessage(mode, content);
    const message = parsedMessage.rawContent;
    if (!message) return;
    activeEarlyTtsRef.current?.queue.cancel();
    activeEarlyTtsRef.current = null;
    const userSticker = parsedMessage.userSticker;
    const visibleMessage = parsedMessage.visibleContent;
    const demoResponse = DEMO_RESPONSES[message];
    const demoSticker = DEMO_STICKERS[message];
    const shouldRunModel = shouldRunModelForMode(mode, Boolean(demoResponse), Boolean(demoSticker));
    const assistantId = demoResponse || demoSticker || shouldRunModel ? crypto.randomUUID() : undefined;
    const userMessageId = crypto.randomUUID();
    const attachmentsForMessage = attachments.map((attachment) => ({ ...attachment }));
    const targetMode = mode;
    const sessionId = await ensureSession(targetMode);

    // 如果新建任务时已选好工作区但尚未创建 session，在这里一并绑定。
    const pendingWorkspace = pendingWorkspaceByMode[targetMode];
    if (pendingWorkspace) {
      const workspaceResult = await chatStore()?.setWorkspace(sessionId, pendingWorkspace.path);
      if (workspaceResult?.ok) {
        setWorkspaceNames((current) => bindWorkspaceName(
          current,
          targetMode,
          pendingWorkspace.displayName ?? "工作文件夹",
        ));
      }
      if (workspaceResult?.ok && targetMode === "learn" && workspaceResult.isEmpty) {
        const confirmed = window.confirm(
          "这是一个空目录。Cyrene 可以在这里创建通用学习工作区结构（materials/、notes/、exercises/、templates/、learn/progress.md），方便你之后和 Cyrene 一起学习。\n\n是否创建？"
        );
        if (confirmed) {
          await initVaultStructure(sessionId, { confirm: false });
        }
      }
      setPendingWorkspaceByMode((current) => {
        const next = { ...current };
        delete next[targetMode];
        return next;
      });
    }

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
      resumeFromRunId,
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
    resumeFromRunId?: string;
  }) {
    const { targetMode, sessionId, rawContent, visibleContent, attachments, userSticker, shouldRunModel, demoResponse, demoSticker, assistantId, userMessageId, resumeFromRunId } = input;
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
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
      void prepareImageAttachments(sessionId, userMessageId, attachments);
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
        resumeFromRunId,
      });
    }
  }

  async function cancelCurrentRun() {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    const activeRun = activeRunsBySession.current[sessionId];
    if (!activeRun) return;
    updateMessage(activeRun.mode, activeRun.assistantId, {
      streaming: false,
      loading: false,
      waitingForFirstEvent: false,
      responseStarted: false,
    });
    if (!activeRun.runId) {
      cancelRequestedSessionsRef.current.add(sessionId);
      // 首次模型请求尚未返回 ack.runId 时，仍要立即通知主进程。
      // 该窗口内当前窗口只有这一条 active run，桥层会取消它；ack 返回后
      // 仍保留 cancelRequestedSessionsRef 以处理跨进程投递顺序。
      await aguiApi()?.cancel();
      return;
    }
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
    const parsedMessage = parseComposerMessage(mode, value);
    if (!parsedMessage.rawContent) return;
    const userSticker = parsedMessage.userSticker;
    const visibleContent = parsedMessage.visibleContent;
    const attachmentsForMessage = attachments.map((attachment) => ({ ...attachment }));
    const userMessageId = crypto.randomUUID();
    const nextQueue = {
      ...pendingQueueBySessionRef.current,
      [sessionId]: [
        ...(pendingQueueBySessionRef.current[sessionId] ?? []),
        { id: userMessageId, rawContent: parsedMessage.rawContent, visibleContent, attachments: attachmentsForMessage, userSticker },
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
  // 上下文容量圆环：session 级快照优先（手动压缩等不产生新消息的操作也即时刷新），
  // 消息级快照兜底兼容旧数据；无快照不渲染。
  const latestContextUsage = (activeSessionId ? sessionContextUsageBySession[activeSessionId] : undefined)
    ?? messages.findLast((message) => message.contextUsage)?.contextUsage;

  return (
    <div className={`cy-page ${collapsed ? "is-collapsed" : ""}`}>
      <div className="cy-page-toggle">
        <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      </div>
      <div className="cy-page-top-center">
        {!toolPanelOpen && !skillPanelOpen && !modelPanelOpen && (
          <ModeSwitch value={mode} onChange={(nextMode) => {
            if (isConversationMode(nextMode)) setMode(nextMode);
          }} />
        )}
      </div>
      <div className="cy-page-windows">
        <WindowControls
          onMinimize={() => window.chat?.minimize()}
          onMaximize={() => window.chat?.toggleMaximize()}
          onClose={() => window.chat?.close()}
        />
      </div>
      <div className="cy-page-sidebar">
        <div className="cy-page-newtask">
          <NewTaskButton onClick={() => void createNewTask()} />
          <ToolModeButton active={toolPanelOpen} onClick={() => { setToolPanelOpen((v) => !v); setSkillPanelOpen(false); setModelPanelOpen(false); }} />
          <SkillModeButton active={skillPanelOpen} onClick={() => { setSkillPanelOpen((v) => !v); setToolPanelOpen(false); setModelPanelOpen(false); }} />
          <ModelModeButton active={modelPanelOpen} onClick={() => { setModelPanelOpen((v) => !v); setToolPanelOpen(false); setSkillPanelOpen(false); }} />
        </div>
        <div className="cy-page-conversations">
          <ConversationSidebar
            mode={mode}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={(sessionId) => {
              setToolPanelOpen(false);
              setSkillPanelOpen(false);
              setModelPanelOpen(false);
              void selectSession(sessionId);
            }}
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
        <AppUpdateEntry />
        <div className="cy-page-sidebar-bottom">
          <UserAvatar />
          <SettingsButton onClick={() => sidebarApi()?.openSettings("appearance")} />
        </div>
      </div>
      <main
        className={`cy-page-main cy-workspace ${hasMessages ? "has-messages" : "is-empty"} ${isDraggingFiles ? "is-dragging-files" : ""}`}
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
        {modelPanelOpen ? (
          <ModelModePanel />
        ) : skillPanelOpen ? (
          <SkillModePanel />
        ) : toolPanelOpen ? (
          <ToolModePanel />
        ) : (
        <>
        {(mode === "work" || mode === "learn") && (
          <TodoPanel
            state={activeSessionId ? todoStateBySession[activeSessionId] : null}
            mode={mode}
          />
        )}
        {mode === "code" && activeSessionId && (
          <CodeGitPanel
            sessionId={activeSessionId}
            projectName={workspaceNames.code}
            todoState={todoStateBySession[activeSessionId] ?? null}
            planPhase={planReviewBySession[activeSessionId]?.phase}
            onOpenPlan={() => {
              setPlanDrawerOpen(true);
              setInspectorTab("plan");
            }}
          />
        )}
        {interruptedRun && !isCurrentScopeRunning && (
          <div className="cy-harness-recovery">
            <span>昔涟上次任务意外中断（已进行 {interruptedRun.rounds} 轮）。</span>
            <button type="button" onClick={() => void sendMessage("继续上次任务", interruptedRun.runId)}>继续任务</button>
          </div>
        )}
        {sessionTakeover && sessionTakeover.sessionId === activeSessionId && !isCurrentScopeRunning && (
          <div className="cy-harness-recovery">
            <span>当前会话有正在运行的任务（可能来自刷新前），本轮消息尚未执行。</span>
            <button type="button" onClick={() => {
              const takeover = sessionTakeover;
              setSessionTakeover(null);
              void takeover.retry();
            }}>终止并重开</button>
          </div>
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
            onOpenReviewInspector={(runId, fileIndex) => {
              setReviewInspector({ runId, fileIndex });
              setInspectorTab("diff");
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
            conversationId={activeSessionId ?? undefined}
            workspaceName={workspaceNames[mode]}
            workspaceRoot={activeSession?.workspaceBinding?.workspaceRoot}
            attachments={attachments}
            attachmentBusy={attachmentBusy}
            modelBusy={isCurrentScopeRunning}
            pendingQueue={currentPendingQueue}
            onChange={(value) => setDrafts((current) => ({ ...current, [scopeKey]: value }))}
            onSubmit={(value) => void sendMessage(value)}
            onCancel={() => void cancelCurrentRun()}
            onQueueMessage={(value) => queueCurrentDraft(value)}
            onRemoveQueuedMessage={(id) => activeSessionId && removeQueuedMessage(activeSessionId, id)}
            onChooseWorkspace={() => void chooseWorkspace()}
            onChooseFiles={(files) => void chooseFiles(files)}
            onRemoveAttachment={removeAttachment}
            onScreenshot={() => void handleScreenshot()}
            onPasteImage={(file) => void handlePastedImage(file)}
            onChooseSticker={(id) => {
              const separator = draft && !draft.endsWith(" ") ? " " : "";
              setDrafts((current) => ({ ...current, [scopeKey]: `${draft}${separator}[sticker:${id}]` }));
            }}
            activeModelProfileId={
              activeSession?.id === activeSessionId && activeSession
                ? activeSession.modelProfileId
                : pendingModelProfileByMode[mode]
            }
            contextUsage={latestContextUsage}
            onSelectModelProfile={(modelProfileId) => {
              // 欢迎页（无会话）：暂存选择，ensureSession 建会话后落地；不再静默丢弃。
              if (!activeSessionId) {
                setPendingModelProfileByMode((current) => ({ ...current, [mode]: modelProfileId }));
                return;
              }
              const store = chatStore();
              if (!store) return;
              void store.setModelProfile(activeSessionId, modelProfileId).then((session) => setActiveSession(session));
            }}
            />}
            interaction={composerInteraction}
            interactionBusy={interactionBusy}
            onAnswer={(id, answer) => {
              if (!activeSessionId) return;
              const choice = choiceApi();
              if (!choice) return;
              setInteractionBusyForSession(activeSessionId, true);
              void choice.resolve(id, answer).then((result) => {
                if (result.ok) {
                  clearInteractionForSession(activeSessionId);
                  runCheckpointBySessionRef.current[activeSessionId]?.("running");
                }
                setInteractionBusyForSession(activeSessionId, false);
              }).catch(() => setInteractionBusyForSession(activeSessionId, false));
            }}
            onIgnore={(id) => {
              if (!activeSessionId) return;
              const choice = choiceApi();
              if (!choice) return;
              setInteractionBusyForSession(activeSessionId, true);
              void choice.resolve(id, "").then((result) => {
                if (result.ok) {
                  clearInteractionForSession(activeSessionId);
                  runCheckpointBySessionRef.current[activeSessionId]?.("running");
                }
                setInteractionBusyForSession(activeSessionId, false);
              }).catch(() => setInteractionBusyForSession(activeSessionId, false));
            }}
            onPermissionDecision={(id, allowed) => {
              if (!activeSessionId) return;
              const settings = settingsApprovalApi();
              if (!settings) return;
              setInteractionBusyForSession(activeSessionId, true);
              void settings.resolvePermissionApproval(id, allowed).then((result) => {
                if (result.ok) {
                  clearInteractionForSession(activeSessionId);
                  runCheckpointBySessionRef.current[activeSessionId]?.("running");
                }
                setInteractionBusyForSession(activeSessionId, false);
              }).catch(() => setInteractionBusyForSession(activeSessionId, false));
            }}
          />
        </div>
        </>
        )}
      </main>
      {(() => {
        const tabs: InspectorTab[] = [];
        const activePlan = mode === "code" && activeSessionId ? planReviewBySession[activeSessionId] : null;
        if (reviewInspector) {
          tabs.push({
            id: "diff",
            label: "Diff",
            content: <ReviewDiffContent runId={reviewInspector.runId} fileIndex={reviewInspector.fileIndex} />,
          });
        }
        if (activePlan && planDrawerOpen) {
          tabs.push({
            id: "plan",
            label: planTabLabel(activePlan.phase),
            dotClass: planTabDotClass(activePlan.phase),
            content: <PlanContent content={activePlan.content} phase={activePlan.phase} />,
          });
        }
        if (tabs.length === 0) return null;
        return (
          <RightInspector
            tabs={tabs}
            activeTabId={inspectorTab}
            onTabChange={(id) => setInspectorTab(id as "diff" | "plan")}
            onClose={() => {
              // 关当前 tab，若还有另一个 tab 则自动切过去
              if (inspectorTab === "diff") {
                setReviewInspector(null);
                if (activePlan && planDrawerOpen) setInspectorTab("plan");
              } else {
                setPlanDrawerOpen(false);
                if (reviewInspector) setInspectorTab("diff");
              }
            }}
          />
        );
      })()}
    </div>
  );
}
