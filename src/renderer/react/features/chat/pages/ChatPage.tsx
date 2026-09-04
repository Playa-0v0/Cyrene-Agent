import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../../i18n";
import { DownOutlined } from "@ant-design/icons";
import { ChatComposer, parseComposerMessage, type ComposerAttachment } from "../components/ChatComposer";
import { ComposerSlot } from "../components/ComposerSlot";
import { TodoPanel } from "../components/TodoPanel";
import { CodeGitPanel } from "../components/CodeGitPanel";
import type { PlanReviewPhase } from "../components/PlanReviewPanel";
import { ChatPageInspector, type ChatPageInspectorTabId } from "../components/ChatPageInspector";
import {
  normalizeDeferredPlanChoice,
  normalizePopQuizCard,
  shouldDismissAsk,
  type ComposerInteraction,
} from "../components/run-presentation";
import { ChatMessageList } from "../components/ChatMessageList";
import { ChatPageNavigation, type ChatPagePanel } from "../components/ChatPageNavigation";
import {
  ContextCompressionNotice,
  FileDropOverlay,
  RunRecoveryNotices,
} from "../components/ChatWorkspaceNotices";
import { getTtsPlaybackSnapshot, playTtsToCompletion, stopTtsPlayback } from "../components/tts-playback";
import { EarlyTtsPlaybackQueue } from "../tts/early-tts-queue";

import type { ChatMessage, ChatSession, ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import { type ContextUsageSnapshot } from "../../../../../shared/context-usage";
import { ChatPagePanelHost } from "../components/ChatPagePanelHost";
import { useUserCallPreference } from "../../../hooks/useUserNickname";
import { resolveRevisableLastTurn } from "../components/last-turn-actions";
import { shouldListenForDeferredPlanEvents } from "./conversation-run-policy";

import {
  aguiApi,
  chatStore,
  choiceApi,
  settingsApprovalApi,
  sidebarApi,
  type ModelConfigApi,
  type PublicModelConfig,
} from "./chat-page-bridge";
import {
  getInitialMode,
  isConversationMode,
  LAST_MODE_STORAGE_KEY,
  permissionInteraction,
  toUiMessages,
} from "./chat-page-normalizers";
import {
  bootstrapReactSession,
  normalizeSessionMode,
  openSessionByIdWithDeps,
  type OpenSessionArgs,
  type ReactSessionMode,
} from "./openSessionByDeps";
import { useComposerAttachments } from "../hooks/useComposerAttachments";
import { useSessionMessages } from "../hooks/useSessionMessages";
import { AgentRunController, type AgentRunInput } from "./run/AgentRunController";
import {
  appendPendingQueueEntry,
  clearSessionInteraction,
  bindWorkspaceName,
  findSessionIdForRun,
  hasActiveRunForSession,
  removePendingQueueEntry,
  sessionInteraction,
  setSessionInteraction,
  setSessionInteractionBusy,
  type PendingQueueBySession,
  type SessionInteractionState,
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
import "../components/ChatMessageList.css";
import "../components/ConversationSidebar.css";
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

export function ChatPage() {
  const { t } = useTranslation();
  const preferredAddress = useUserCallPreference();
  const [collapsed, setCollapsed] = useState(false);
  const [activePanel, setActivePanel] = useState<ChatPagePanel | null>(null);
  /** 右侧 Review 检查面板：打开时把白色工作区挤窄 */
  const [reviewInspector, setReviewInspector] = useState<{ runId: string; fileIndex: number } | null>(null);
  /** 右侧面板当前激活的 tab（diff / plan），由打开动作自动切换 */
  const [inspectorTab, setInspectorTab] = useState<"diff" | "plan">("plan");
  const [mode, setMode] = useState<ConversationMode>(getInitialMode);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const [workspaceNames, setWorkspaceNames] = useState<Partial<Record<ConversationMode, string>>>({});
  const [pendingWorkspaceByMode, setPendingWorkspaceByMode] = useState<
    Partial<Record<ConversationMode, { path: string; displayName?: string }>>
  >({});
  // 欢迎页（无会话）暂存的模型选择：ensureSession 建会话后落地（与 pendingWorkspaceByMode 同构）。
  const [pendingModelProfileByMode, setPendingModelProfileByMode] = useState<
    Partial<Record<ConversationMode, string>>
  >({});
  const [sessionsByMode, setSessionsByMode] = useState<Partial<Record<ConversationMode, ChatSessionMeta[]>>>({});
  const [activeSessionIds, setActiveSessionIds] = useState<Partial<Record<ConversationMode, string>>>({});

  const [modelBusyByMode, setModelBusyByMode] = useState<Partial<Record<ConversationMode, boolean>>>({});
  const [isCompressingContext, setIsCompressingContext] = useState(false);
  const [interactionsBySession, setInteractionsBySession] = useState<SessionInteractionState>({});
  const [lastTurnRevisionStarting, setLastTurnRevisionStarting] = useState(false);
  const [stickerSize, setStickerSize] = useState<"small" | "standard" | "large">("standard");

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

  // 消息域：渲染态消息按会话存储；补丁通道供 run 事件流、TTS、取消与附件预处理共用
  const {
    messagesBySession,
    patchMessage: updateMessage,
    hydrateMessages,
    replaceSessionMessages,
    appendMessages,
    patchMessageAttachments: updateMessageAttachments,
  } = useSessionMessages((targetMode) => activeSessionIdsRef.current[targetMode]);

  useEffect(() => {
    const settings = settingsApprovalApi();
    if (!settings) return;
    const offRequest = settings.onPermissionApprovalRequest((request) => {
      const currentMode = activeModeRef.current;
      const currentSessionId = activeSessionIdsRef.current[currentMode];
      const ownerSessionId = findSessionIdForRun(activeRunsBySession.current, request.runId)
        ?? currentSessionId;
      // 路由不到会话时先丢弃：主进程每 10s 幂等重播，会话就绪后卡片自然出现。
      if (!ownerSessionId) return;
      setInteractionForSession(ownerSessionId, permissionInteraction(request));
      const activeRun = activeRunsBySession.current[ownerSessionId];
      if (activeRun) {
        updateMessage(ownerSessionId, activeRun.assistantId, { runStage: { kind: "waiting_permission" } });
        runCheckpointBySessionRef.current[ownerSessionId]?.("waiting_user");
      }
    });
    // 结算广播：pending 已在主进程被结算（用户已答 / run 取消），
    // 渲染端据此立即清卡——这是「僵尸审批卡（点了没反应）」的根治点。
    const offSettled = settings.onPermissionApprovalSettled((settlement) => {
      setInteractionsBySession((current) => {
        for (const [sessionId, entry] of Object.entries(current)) {
          if (entry.interaction.kind === "permission" && entry.interaction.id === settlement.id) {
            const next = { ...current };
            delete next[sessionId];
            return next;
          }
        }
        return current;
      });
    });
    return () => {
      offRequest();
      offSettled();
    };
  }, []);

  // pop_quiz 抽查卡片（learn 模式）：与审批流同构的持久监听。
  // 请求按 runId 路由到所属会话；结算广播只清 skipped/cancelled——
  // submitted 时卡片要留在原地切展示态（判分结果 + 解析），等 run 结束统一收卡。
  useEffect(() => {
    const settings = settingsApprovalApi();
    if (!settings) return;
    const offRequest = settings.onPopQuizRequest((card) => {
      const interaction = normalizePopQuizCard(card);
      if (!interaction) return;
      const currentMode = activeModeRef.current;
      const currentSessionId = activeSessionIdsRef.current[currentMode];
      const ownerSessionId = findSessionIdForRun(activeRunsBySession.current, card.runId)
        ?? currentSessionId;
      // 路由不到会话时先丢弃：主进程每 10s 幂等重播，会话就绪后卡片自然出现。
      if (!ownerSessionId) return;
      setInteractionForSession(ownerSessionId, interaction);
      const activeRun = activeRunsBySession.current[ownerSessionId];
      if (activeRun) {
        updateMessage(ownerSessionId, activeRun.assistantId, { runStage: { kind: "waiting_user" } });
        runCheckpointBySessionRef.current[ownerSessionId]?.("waiting_user");
      }
    });
    const offSettled = settings.onPopQuizSettled((settlement) => {
      if (settlement.reason === "submitted") return;
      setInteractionsBySession((current) => {
        for (const [sessionId, entry] of Object.entries(current)) {
          if (entry.interaction.kind === "quiz" && entry.interaction.id === settlement.quizId) {
            const next = { ...current };
            delete next[sessionId];
            return next;
          }
        }
        return current;
      });
    });
    return () => {
      offRequest();
      offSettled();
    };
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
  // 外部提交（语音输入）入队的消息带 keepComposer，消费时不触碰用户草稿
  const [pendingQueueBySession, setPendingQueueBySession] = useState<PendingQueueBySession>({});
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
  const {
    attachments,
    attachmentBusy,
    isDraggingFiles,
    chooseFiles,
    handlePastedImage,
    handleScreenshot,
    removeAttachment,
    prepareImageAttachments,
    clearScopeAttachments,
    deleteScopeAttachments,
    dragHandlers,
  } = useComposerAttachments({
    scopeKey,
    getActiveScope: () => activeScopeRef.current,
    patchMessageAttachments: updateMessageAttachments,
  });
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
    for (const off of activeAguiOffsRef.current) off();
    activeAguiOffsRef.current.clear();
    activeEarlyTtsRef.current?.queue.cancel();
    activeEarlyTtsRef.current = null;
  }, []);

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

  // 外部语音文本提交：主进程经 IPC 要求把文本提交到租约冻结的会话。
  // 页面重新加载后 rendererTargetId 变化，旧目标的迟到请求直接回绝。
  useEffect(() => {
    const store = chatStore();
    if (!store?.onSpeechInputCommitRequest) return;
    const unsubscribe = store.onSpeechInputCommitRequest((request) => {
      void (async () => {
        let result: { ok: true } | { ok: false; error: { code: string; message: string } };
        if (request.rendererTargetId !== store.getRendererTargetId()) {
          result = {
            ok: false,
            error: { code: "E_NO_ACTIVE_INPUT_TARGET", message: "渲染目标已过期" },
          };
        } else {
          result = await submitTextToSession({
            sessionId: request.sessionId,
            mode: request.mode,
            text: request.text,
          });
        }
        store.sendSpeechInputCommitResult({
          requestId: request.requestId,
          rendererTargetId: request.rendererTargetId,
          ...(result.ok ? { ok: true } : { ok: false, error: result.error }),
        });
      })();
    });
    return unsubscribe;
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
      if (event.name === "cyrene.choice.dismiss") {
        // run 事件闸之外的 dismiss（老版选择卡超时 / run 结束后发出的结算）：
        // 匹配当前 ask 卡时清掉，避免留下点不出结果的僵尸卡。
        setInteractionsBySession((current) => {
          const entry = current[activeSessionId];
          if (!entry || entry.interaction.kind !== "ask" || !shouldDismissAsk(entry.interaction, event.value)) return current;
          return clearSessionInteraction(current, activeSessionId);
        });
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
            void sendMessage(t("chatPage.planApprovedAutoMessage"));
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


  function handleTtsCacheKey(
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
    hydrateMessages(sessionId, uiMessages, hasActiveRunForSession(activeRunsBySession.current, sessionId));
    setWorkspaceNames((current) => ({
      ...current,
      [targetMode]: session.workspaceBinding?.displayName,
    }));
    if (targetMode === activeModeRef.current) void store.setActiveSession(sessionId, targetMode);
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
    if (targetMode === activeModeRef.current) void store.setActiveSession(null, targetMode);
  }

  // 渲染期间同步安装真实实现，保证 mount effect 不会先观察到默认 no-op。
  refreshSessionsRef.current = refreshSessions;

  /**
   * 模型运行入口：组装运行宿主与共享注册表，交给运行控制器执行。
   * run 结束后的会话列表刷新与待发队列消费在 onRunFinished 中协调。
   */
  async function runModel(input: AgentRunInput) {
    const controller = new AgentRunController(input, {
      api: aguiApi(),
      store: chatStore(),
      host: {
        patchMessage: updateMessage,
        setInteraction: setInteractionForSession,
        clearInteraction: clearInteractionForSession,
        dismissAskIfMatched: (sessionId, value) => {
          setInteractionsBySession((current) => {
            const interaction = sessionInteraction(current, sessionId)?.interaction;
            if (interaction?.kind !== "ask" || !shouldDismissAsk(interaction, value)) return current;
            return clearSessionInteraction(current, sessionId);
          });
        },
        updateTodos: (_sessionId, updater) => setTodoStateBySession((current) => updater(current)),
        updateContextUsage: (sessionId, snapshot) => setSessionContextUsageBySession((current) => ({
          ...current,
          [sessionId]: snapshot,
        })),
        setCompressingContext: (_sessionId, value) => setIsCompressingContext(value),
        setModeBusy: (targetMode, busy) => {
          if (busy) {
            modelBusyByModeRef.current = { ...modelBusyByModeRef.current, [targetMode]: true };
            setModelBusyByMode((current) => ({ ...current, [targetMode]: true }));
          } else {
            const nextBusy = { ...modelBusyByModeRef.current };
            delete nextBusy[targetMode];
            modelBusyByModeRef.current = nextBusy;
            setModelBusyByMode((current) => {
              const next = { ...current };
              delete next[targetMode];
              return next;
            });
          }
        },
        requestTakeover: (sessionId, activeRunId, retry) => setSessionTakeover({ sessionId, activeRunId, retry }),
        clearTakeover: (sessionId) => setSessionTakeover((current) => (current && current.sessionId === sessionId ? null : current)),
        earlyTts: {
          start: createEarlyTtsQueue,
          finish: finishEarlyTtsQueue,
        },
        onRunFinished: ({ mode, sessionId }) => {
          void refreshSessions(mode, false);
          // 当前 session 队列中的下一条消息自动消费
          const queue = pendingQueueBySessionRef.current[sessionId] ?? [];
          if (queue.length === 0) return;
          const [next, ...rest] = queue;
          pendingQueueBySessionRef.current = { ...pendingQueueBySessionRef.current, [sessionId]: rest };
          setPendingQueueBySession(pendingQueueBySessionRef.current);
          void dispatchUserMessage({
            targetMode: mode,
            sessionId,
            rawContent: next.rawContent,
            visibleContent: next.visibleContent,
            attachments: next.attachments,
            userSticker: next.userSticker,
            assistantId: crypto.randomUUID(),
            userMessageId: next.id,
            keepComposer: next.keepComposer,
          });
        },
      },
      registries: {
        activeRuns: activeRunsBySession,
        checkpointTriggers: runCheckpointBySessionRef,
        cancelRequestedSessions: cancelRequestedSessionsRef,
        eventUnsubscribers: activeAguiOffsRef,
      },
      startRun: runModel,
    });
    await controller.start();
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
      replaceSessionMessages(sessionId, [
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
      ]);
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
    if (!store) throw new Error(t("chatPage.errorChatStoreUnavailable"));
    const hasPendingWorkspace = !!pendingWorkspaceByMode[targetMode];
    const session = await store.create({
      identityId: null,
      mode: targetMode,
      title:
        targetMode === "work" || targetMode === "code" || hasPendingWorkspace
          ? t("chatPage.newTaskTitle")
          : t("chatPage.newChatTitle"),
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
      t("chatPage.learnStructureConfirm")
    );
    if (!confirmed) return;
    const result = await store.initLearnWorkspace(sessionId);
    if (!result.ok) {
      window.alert(t("chatPage.learnStructureFailed", { error: result.error ?? t("chatPage.unknownError") }));
    } else {
      const created = result.created?.length ?? 0;
      const skipped = result.skipped?.length ?? 0;
      window.alert(skipped > 0
        ? t("chatPage.learnStructureCreatedWithSkipped", { created, skipped })
        : t("chatPage.learnStructureCreated", { created }));
    }
  }

  async function chooseWorkspace() {
    const targetMode = mode;
    if (targetMode === "chat") return;
    const store = chatStore();
    if (!store) return;
    const picked = await store.pickWorkspaceFolder();
    if (!picked.ok || !picked.path) return;

    const workspace = { path: picked.path, displayName: picked.displayName ?? t("chatPage.defaultWorkspaceName") };
    setWorkspaceNames((current) => ({ ...current, [targetMode]: workspace.displayName }));

    const activeId = activeSessionIdsRef.current[targetMode];
    if (activeId) {
      const result = await store.setWorkspace(activeId, workspace.path);
      if (!result.ok) {
        window.alert(t("chatPage.setWorkspaceFailed", { error: result.error ?? t("chatPage.unknownError") }));
        return;
      }
      // Learn 模式：空目录询问是否初始化通用学习结构
      if (targetMode === "learn" && result.isEmpty) {
        const confirmed = window.confirm(
          t("chatPage.emptyDirLearnStructureConfirm")
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
    deleteScopeAttachments(`mode:${targetMode}`);
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
    setActivePanel(null);
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


  async function sendMessage(content: string, resumeFromRunId?: string) {
    const parsedMessage = parseComposerMessage(mode, content);
    const message = parsedMessage.rawContent;
    if (!message) return;
    activeEarlyTtsRef.current?.queue.cancel();
    activeEarlyTtsRef.current = null;
    const userSticker = parsedMessage.userSticker;
    const visibleMessage = parsedMessage.visibleContent;
    const assistantId = crypto.randomUUID();
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
          pendingWorkspace.displayName ?? t("chatPage.defaultWorkspaceName"),
        ));
      }
      if (workspaceResult?.ok && targetMode === "learn" && workspaceResult.isEmpty) {
        const confirmed = window.confirm(
          t("chatPage.emptyDirLearnStructureConfirm")
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
    if (isSessionBusy(sessionId)) {
      const nextQueue = appendPendingQueueEntry(pendingQueueBySessionRef.current, sessionId, {
        id: userMessageId,
        rawContent: message,
        visibleContent: visibleMessage,
        attachments: attachmentsForMessage,
        userSticker,
      });
      pendingQueueBySessionRef.current = nextQueue;
      setPendingQueueBySession(nextQueue);
      setDrafts((current) => ({ ...current, [scopeKey]: "" }));
      clearScopeAttachments();
      return;
    }
    await dispatchUserMessage({
      targetMode,
      sessionId,
      rawContent: message,
      visibleContent: visibleMessage,
      attachments: attachmentsForMessage,
      userSticker,
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
    assistantId: string;
    userMessageId: string;
    resumeFromRunId?: string;
    /** 外部提交（语音输入）为 true：不清空用户正在编辑的草稿与附件。 */
    keepComposer?: boolean;
    /** 为 false 时用户消息落盘后立即返回，模型运行转入后台继续。 */
    waitForRun?: boolean;
  }): Promise<{ persisted: boolean }> {
    const { targetMode, sessionId, rawContent, visibleContent, attachments, userSticker, assistantId, userMessageId, resumeFromRunId, keepComposer } = input;
    appendMessages(sessionId, [
      {
        id: userMessageId,
        role: "user",
        content: visibleContent,
        sticker: userSticker,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      {
        id: assistantId,
        role: "assistant" as const,
        content: "",
        loading: true,
        waitingForFirstEvent: true,
        streaming: false,
        responseStarted: false,
      },
    ]);
    if (!keepComposer) {
      setDrafts((current) => ({ ...current, [scopeKey]: "" }));
      clearScopeAttachments();
    }
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
    if (!updatedSession) {
      updateMessage(targetMode, assistantId, {
        content: t("chatPage.errorUserMessageNotPersisted"),
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        responseStarted: true,
      });
      return { persisted: false };
    }
    if (input.waitForRun === false) {
      // 外部提交：用户消息已接受并落盘，模型运行在后台继续
      void runModel({
        targetMode,
        sessionId,
        userMessageId,
        assistantId,
        session: updatedSession,
        attachments,
        resumeFromRunId,
      });
    } else {
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
    return { persisted: true };
  }

  /**
   * 外部（语音输入租约）向指定会话提交文本：
   * - 使用提交请求冻结的会话与模式，不读取当前页面状态；
   * - 不清空用户正在编辑的草稿、附件和输入框；
   * - 会话忙时进入与手动发送相同的消息队列；
   * - 用户消息被接受并落盘后即返回，不等待模型完整回答。
   */
  async function submitTextToSession(input: {
    sessionId: string;
    mode: ConversationMode;
    text: string;
  }): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
    const text = input.text.trim();
    if (!text) {
      return { ok: false, error: { code: "E_INVALID_ARGUMENT", message: "提交文本不能为空" } };
    }
    const store = chatStore();
    if (!store) {
      return { ok: false, error: { code: "E_INTERNAL", message: "会话存储不可用" } };
    }
    const session = await store.get(input.sessionId);
    if (!session) {
      return { ok: false, error: { code: "E_NOT_FOUND", message: "会话已删除" } };
    }
    if (session.mode !== input.mode) {
      return { ok: false, error: { code: "E_INVALID_ARGUMENT", message: "会话模式不匹配" } };
    }
    // 会话忙时进入同一消息队列，当前 run 结束后自动发送（视为已接受）
    if (isSessionBusy(input.sessionId)) {
      const nextQueue = appendPendingQueueEntry(pendingQueueBySessionRef.current, input.sessionId, {
        id: crypto.randomUUID(),
        rawContent: text,
        visibleContent: text,
        attachments: [],
        keepComposer: true,
      });
      pendingQueueBySessionRef.current = nextQueue;
      setPendingQueueBySession(nextQueue);
      return { ok: true };
    }
    const dispatched = await dispatchUserMessage({
      targetMode: input.mode,
      sessionId: input.sessionId,
      rawContent: text,
      visibleContent: text,
      attachments: [],
      assistantId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(),
      keepComposer: true,
      waitForRun: false,
    });
    if (!dispatched.persisted) {
      return { ok: false, error: { code: "E_INTERNAL", message: "用户消息落盘失败" } };
    }
    return { ok: true };
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
    const next = removePendingQueueEntry(pendingQueueBySessionRef.current, sessionId, id);
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
    const nextQueue = appendPendingQueueEntry(pendingQueueBySessionRef.current, sessionId, {
      id: userMessageId,
      rawContent: parsedMessage.rawContent,
      visibleContent,
      attachments: attachmentsForMessage,
      userSticker,
    });
    pendingQueueBySessionRef.current = nextQueue;
    setPendingQueueBySession(nextQueue);
    setDrafts((current) => ({ ...current, [scopeKey]: "" }));
    clearScopeAttachments();
  }

  const isCurrentScopeRunning = Boolean(activeSessionId && activeRunsBySession.current[activeSessionId]);
  const currentPendingQueue = activeSessionId
    ? (pendingQueueBySession[activeSessionId] ?? []).map((item) => ({ id: item.id, content: item.visibleContent }))
    : [];
  // 上下文容量圆环：session 级快照优先（手动压缩等不产生新消息的操作也即时刷新），
  // 消息级快照兜底兼容旧数据；无快照不渲染。
  const latestContextUsage = (activeSessionId ? sessionContextUsageBySession[activeSessionId] : undefined)
    ?? messages.findLast((message) => message.contextUsage)?.contextUsage;
  const activePlan = mode === "code" && activeSessionId ? planReviewBySession[activeSessionId] : null;

  return (
    <div className={`cy-page ${collapsed ? "is-collapsed" : ""}`}>
      <ChatPageNavigation
        collapsed={collapsed}
        activePanel={activePanel}
        mode={mode}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        onModeChange={(nextMode) => {
          if (isConversationMode(nextMode)) setMode(nextMode);
        }}
        onNewTask={() => void createNewTask()}
        onTogglePanel={(panel: ChatPagePanel) => {
          setActivePanel((current) => current === panel ? null : panel);
        }}
        onSelectSession={(sessionId) => {
          setActivePanel(null);
          void selectSession(sessionId);
        }}
        onOpenProject={(workspaceRoot) => {
          void chatStore()?.openWorkspace(workspaceRoot).then((result) => {
            if (!result.ok) window.alert(t("chatPage.openProjectFolderFailed", { error: result.error ?? t("chatPage.unknownError") }));
          });
        }}
        onRenameSession={(sessionId, newTitle) => void handleRenameSession(sessionId, newTitle)}
        onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
        onTogglePinSession={(sessionId, pinned) => void handleTogglePinSession(sessionId, pinned)}
        onMinimize={() => window.chat?.minimize()}
        onMaximize={() => window.chat?.toggleMaximize()}
        onCloseWindow={() => window.chat?.close()}
        onOpenSettings={() => sidebarApi()?.openSettings("appearance")}
      />
      <main
        className={`cy-page-main cy-workspace ${hasMessages ? "has-messages" : "is-empty"} ${isDraggingFiles ? "is-dragging-files" : ""}`}
        onDragEnter={dragHandlers.onDragEnter}
        onDragOver={dragHandlers.onDragOver}
        onDragLeave={dragHandlers.onDragLeave}
        onDrop={dragHandlers.onDrop}
      >
        <FileDropOverlay visible={isDraggingFiles} />
        {activePanel ? (
          <ChatPagePanelHost panel={activePanel} />
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
        <RunRecoveryNotices
          interruptedRun={interruptedRun}
          sessionTakeover={sessionTakeover}
          activeSessionId={activeSessionId}
          isRunning={isCurrentScopeRunning}
          onResume={(runId) => void sendMessage(t("chatPage.resumeLastTaskMessage"), runId)}
          onTakeover={() => {
            const takeover = sessionTakeover;
            if (!takeover) return;
            setSessionTakeover(null);
            void takeover.retry();
          }}
        />
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
        <ContextCompressionNotice visible={isCompressingContext} />
        <div className="cy-workspace-composer">
          {scrollToBottomVisible && (
            <button
              type="button"
              className="cy-workspace-composer__scroll-to-bottom"
              onClick={() => scrollToBottomRef.current()}
              aria-label={t("chatPage.scrollToBottom")}
              title={t("chatPage.scrollToBottom")}
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
                // ok:false = pending 已在主进程被结算（run 取消等）：卡片不可能再提交成功，直接清掉，
                // 避免留下一张点多少次都没反应的僵尸卡。
                if (result.ok) {
                  runCheckpointBySessionRef.current[activeSessionId]?.("running");
                }
                clearInteractionForSession(activeSessionId);
                setInteractionBusyForSession(activeSessionId, false);
              }).catch(() => setInteractionBusyForSession(activeSessionId, false));
            }}
            onQuizSubmit={(submission) => {
              const settings = settingsApprovalApi();
              if (!settings) return Promise.resolve({ ok: false, error: "E_QUIZ_NO_BRIDGE" });
              // 展示态切换由卡片组件处理，这里只透传判分结果
              return settings.resolvePopQuiz(submission);
            }}
            onQuizSkip={(quizId) => {
              const settings = settingsApprovalApi();
              if (!settings) return Promise.resolve({ ok: false, error: "E_QUIZ_NO_BRIDGE" });
              return settings.skipPopQuiz(quizId);
            }}
          />
        </div>
        </>
        )}
      </main>
      <ChatPageInspector
        reviewInspector={reviewInspector}
        activePlan={activePlan}
        planDrawerOpen={planDrawerOpen}
        activeTabId={inspectorTab}
        onTabChange={setInspectorTab}
        onCloseTab={(tabId: ChatPageInspectorTabId) => {
          if (tabId === "diff") {
            setReviewInspector(null);
            if (activePlan && planDrawerOpen) setInspectorTab("plan");
          } else {
            setPlanDrawerOpen(false);
            if (reviewInspector) setInspectorTab("diff");
          }
        }}
      />
    </div>
  );
}
