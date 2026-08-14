// AG-UI IPC 桥：按会话模式选择执行链并把事件透传给渲染进程。
//
// 架构：
//   Chat  ──> CyreneAgent ──> 无工具 ChatLoop
//   Work / Learn / Code ──> CyreneAgent ──> CyreneHarness
//   各链路事件都由本桥通过 AGUI_EVENT 转发给渲染进程。
//
// Agent 的 Observable 是内存流、跨不过进程边界。
// 因此主进程统一持有运行并仅把事件发送给 Renderer。
import { ipcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { IPC } from "../shared/ipc-channels";
import { Subscription } from "rxjs";
import { AgentRuntimeError } from "./orchestrator/agent-runtime-error";
import {
  CyreneAgent,
  type AgentExecutionMode,
  type CyreneRunOptions,
  type CyreneRunResult,
} from "./orchestrator/cyrene-agent";
import { RunSettlementGate } from "./orchestrator/run-settlement";
import type { AguiRunAck, CyreneRunTerminalResult } from "../shared/run-terminal";
import { indexConversationTurn } from "./orchestrator/history-tools";
import type { RelationshipChannel } from "./relationship/relationship-log";
import { createThinkFilter, type ThinkStreamFilter, type ThinkFilterMode } from "./chat/think-filter";
import { ChatTimeStreamPrefixFilter } from "./chat-time-stream-filter";
import { runLearnPostTurnHook } from "./learn/progress/learn-post-turn";
import { obsidianWorkspace } from "./learn/obsidian/obsidian-workspace-service";
import { registerObsidianTools, unregisterObsidianTools } from "./learn/obsidian/obsidian-tools";
import { getAdapterForConfig } from "./orchestrator/vendors";
import { perf } from "./perf-trace";
import type { StyleId } from "../shared/style-sampling";
import * as chatsStore from "./chats/chats-store";
import type { ConversationMode } from "../shared/chat-types";
import { requestUserClarification, cancelPendingChoicesForRun } from "./user-choice";
import { cancelPendingApprovalsForRun } from "./permission";
/**
 * Task 2 / C1：从 RUN_FINISHED 事件中提取 canonical terminal。
 *
 * CyreneAgent.runWithEvents 在 success / cancelled / timeout / runtime_error 路径都会发出
 * RUN_FINISHED 并附带 `result: CyreneRunTerminalResult`。下游（bridge / settlement gate）据此决定：
 *  - 是否跑成功收尾副作用（仅 status="success"）
 *  - runtime_error 是否转走 RUN_ERROR（Issue 2）
 *
 * 缺失 result 字段时按 success 兜底，兼容尚未升级的 upstream。
 */
function extractTerminalFromRunFinished(baseEvent: unknown): CyreneRunTerminalResult {
  const result = (baseEvent as { result?: unknown })?.result;
  if (
    result
    && typeof result === "object"
    && "status" in result
    && typeof (result as { status: unknown }).status === "string"
  ) {
    const status = (result as { status: string }).status;
    // Issue 1：gate 内部状态名用 runtime_error（冻结边界），AG-UI 事件名仍是 RUN_ERROR。
    if (status === "success" || status === "cancelled" || status === "timeout" || status === "runtime_error") {
      const reason = (result as { reason?: unknown }).reason;
      // Issue 3：externalEffectsMayContinue 是必填 invariant；
      // upstream 缺省时按保守规则补齐（success → false，其余三态 → true）。
      const rawFlag = (result as { externalEffectsMayContinue?: unknown }).externalEffectsMayContinue;
      const externalEffectsMayContinue = typeof rawFlag === "boolean"
        ? rawFlag
        : status !== "success";
      const terminal: CyreneRunTerminalResult = { status, externalEffectsMayContinue };
      if (typeof reason === "string") terminal.reason = reason;
      return terminal;
    }
  }
  // 兼容旧 upstream：未带 result 字段时按 success 处理（无 unresolved uncertainty）。
  return { status: "success", externalEffectsMayContinue: false };
}

/** 渲染进程发起 run 时传的输入。 */
export interface AguiRunInput {
  messages: unknown[];   // 原始 {role, content}[]，主进程会 normalize
  /** Renderer 已落库的稳定 turn ID；用于 Chat 社交原子的证据锚点。 */
  userTurnId?: string;
  /** 本轮 assistant 占位消息的稳定 turn ID。 */
  assistantTurnId?: string;
  /** 旧版人格 style 文件名；仅保留兼容，不再承担运行模式语义。 */
  style?: string;
  /** 本轮表达风格，与 executionMode 正交。 */
  styleId?: StyleId | string;
  sessionId?: string;    // 会话 ID；桌面运行模式只信任该会话持久化的 mode
  /** 外部渠道入口。桌面聊天不传；微信/飞书用于注入渠道语气规则。 */
  channel?: RelationshipChannel;
  /** @deprecated 仅保留 Renderer 兼容；主进程按 ChatSession.mode 分流并忽略该值。 */
  executionMode?: ConversationMode | "soul-only" | "collaboration";
  /** 主进程内部使用：由 ChatSession.mode 注入，用于选择对应模式的 system prompt。 */
  mode?: ConversationMode;
  /** 本轮附件（文本内容，临时注入系统上下文，不存历史）。 */
  attachments?: { name: string; text: string }[];
  /** 本轮图片附件。主进程会安全读取并转成 OpenAI-compatible image_url content block。 */
  imageAttachments?: { name: string; filePath: string; mime?: string }[];
  /** 同一会话上一次异常中断的只读恢复检查点。 */
  recoveryContext?: string;
  /** 只由主进程根据会话持久化字段注入，渲染端传值不可信。 */
  modelProfileId?: string;
}

/** 调用方（index.ts）注入：把输入转成 agent 需要的 options（含 system prompt 拼接）。 */
export type BuildOptionsFn = (input: AguiRunInput) => Promise<{
  options: CyreneRunOptions;
  /** 跑完后副作用需要的信息。 */
  latestUserText: string;
}>;

/** 调用方注入：agent 跑完后的副作用（记忆/sticker/表情/广播）。 */
export interface RunFinishedEffects {
  /** 由 bridge 发给本次 AG-UI run 的发起窗口，保证不会落到旧 chatWindow。 */
  sticker?: string | null;
}
export type OnRunFinishedFn = (
  result: CyreneRunResult,
  latestUserText: string,
  conversationId?: string,
) => Promise<void | RunFinishedEffects> | void | RunFinishedEffects;

/** 调用方注入：拿聊天窗口（广播副作用用，可空）。 */
export type GetChatWindowFn = () => { webContents: WebContents; isDestroyed(): boolean } | null;

export interface AguiConversationLifecycle {
  onUserMessage(): void;
  onConversationStarted(): void;
  onConversationEnded(): void;
}

/**
 * 单次对话的活跃订阅（用于取消）。键 = runId。
 * Task 3 / C2：每个 run 持有独立 AbortController，AGUI_CANCEL 调用 abort() 触发
 * harness 的 cancelled 流程，而非粗暴 unsubscribe()。
 */
const activeRuns = new Map<string, {
  subscription: Subscription;
  endLifecycle: () => void;
  abortController: AbortController;
}>();

/**
 * Issue 7：测试专用——验证同步 complete 后没有幽灵 active run。
 * 仅在测试环境使用；生产代码不要调用。
 */
export function __hasActiveRunForTest(runId: string): boolean {
  return activeRuns.has(runId);
}

let buildOptionsFn: BuildOptionsFn | null = null;
let getChatWindowFn: GetChatWindowFn = () => null;

/**
 * 注册 AG-UI IPC。由 index.ts 在 app.whenReady() 调一次。
 *
 * @param buildOptions 把渲染进程输入转成 agent options（含上下文构建）
 * @param onRunFinished agent 跑完的副作用（记忆/sticker 等）
 * @param getChatWindow 聊天窗口（事件要发到这里）
 */
export function registerAgUiIpc(
  buildOptions: BuildOptionsFn,
  onRunFinished: OnRunFinishedFn,
  getChatWindow: GetChatWindowFn,
  lifecycle?: AguiConversationLifecycle,
): void {
  buildOptionsFn = buildOptions;
  getChatWindowFn = getChatWindow;

  const onFinished = onRunFinished;
  ipcMain.handle(IPC.AGUI_RUN, async (event: IpcMainInvokeEvent, rawInput: unknown) => {
    if (!buildOptionsFn || !onFinished) {
      throw new Error("AG-UI 桥未初始化");
    }
    lifecycle?.onUserMessage();
    lifecycle?.onConversationStarted();
    perf.beginTurn("desktop");
    const input = rawInput as AguiRunInput;

    // 事件转发目标：优先用 invoke 的 sender（发起 run 的窗口），兜底用聊天窗口
    const sender = event.sender;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const send = (baseEvent: unknown): void => {
      // CyreneAgent 的 RUN_STARTED / RUN_FINISHED 自带 runId，但 ChatLoop 等内部
      // AgentLoopEvent 经 toAguiEvent 转换后没有。渲染端用 runId 隔离并发会话，
      // 因此所有桥层发出的事件都必须带 canonical runId，不能只给终态事件补上。
      const eventWithRunId = baseEvent && typeof baseEvent === "object"
        ? { ...(baseEvent as Record<string, unknown>), runId: (baseEvent as { runId?: unknown }).runId ?? runId }
        : baseEvent;
      const targets: WebContents[] = [];
      if (!sender.isDestroyed()) targets.push(sender);
      const chatWin = getChatWindowFn();
      if (chatWin && !chatWin.isDestroyed() && chatWin.webContents !== sender) {
        targets.push(chatWin.webContents);
      }
      for (const t of targets) {
        try {
          t.send(IPC.AGUI_EVENT, eventWithRunId);
        } catch (err) {
          console.error("[AgUiBridge] send 失败:", (err instanceof Error ? err.message : String(err)), "事件类型=", (baseEvent as { type?: string })?.type);
        }
      }
    };

    // ── 顶层模式分流：读取 ChatSession.mode（唯一可信来源） ──
    const sessionId = input.sessionId;
    if (!sessionId) {
      lifecycle?.onConversationEnded();
      throw new Error("AGUI_RUN 缺少 sessionId");
    }
    const session = chatsStore.getSession(sessionId);
    if (!session) {
      lifecycle?.onConversationEnded();
      throw new Error(`AGUI_RUN 会话不存在: ${sessionId}`);
    }
    const mode = session.mode ?? (session.purpose === "proactive-chat" || session.purpose === "discord-chat" ? "chat" : "work");
    if ((mode === "work" || mode === "code" || mode === "learn") && !session.workspaceBinding?.workspaceRoot) {
      lifecycle?.onConversationEnded();
      throw new Error(`${mode} 模式需要先绑定项目工作区`);
    }

    // ── Chat / Work / Learn / Code：共用 CyreneAgent 外壳 ──
    const agentExecutionMode: AgentExecutionMode = mode === "chat" ? "chat" : "work";
    let built;
    try {
    built = await perf.track("build_options", () => buildOptionsFn!({
      ...input,
      mode,
      modelProfileId: session.modelProfileId,
      executionMode: agentExecutionMode,
    }));
    } catch (error) {
      perf.dump();
      lifecycle?.onConversationEnded();
      throw error;
    }
    const { options, latestUserText } = built;
    options.executionMode = agentExecutionMode;
    options.recoveryContext = input.recoveryContext;
    options.conversationMode = mode;
    // Task 2 / C1：把 bridge 创建的 canonical runId 注入 CyreneRunOptions，
    // 一路传到 Agent / Harness adapter / ToolContext / 所有 AG-UI 事件。
    // ack.runId 与 RUN_STARTED.runId 必须一致（Step 5 测试断言）。
    options.runId = runId;
    // Task 3 / C2：为本次 run 创建 AbortController，signal 一路传到 Agent / harness。
    // AGUI_CANCEL 调用 abortController.abort()，触发 harness 返回 cancelled，
    // CyreneAgent 发出 RUN_FINISHED(result.status="cancelled")，complete 回调自然清理。
    const runAbortController = new AbortController();
    options.signal = runAbortController.signal;
    options.requestUserClarification = (card) => requestUserClarification(card, (cardData) => {
      send({ type: "CUSTOM", name: "cyrene.choice", value: cardData, threadId, runId });
    }, (settlement) => {
      send({ type: "CUSTOM", name: "cyrene.choice.dismiss", value: settlement, threadId, runId });
    }, { runId, revision: 1 });

    // Learn 模式：配置 Obsidian Vault 并注册工具
    if (mode === "learn" && session.workspaceBinding?.workspaceRoot) {
      obsidianWorkspace.configure({
        enabled: true,
        vaultPath: session.workspaceBinding.workspaceRoot,
      });
      try {
        registerObsidianTools();
      } catch (err) {
        console.warn("[Learn] Obsidian 工具注册失败：", err);
      }
    }

    const threadId = `thread-${Date.now()}`;
    const agent = new CyreneAgent({ threadId, description: "Cyrene 主聊天" });

    let pendingRunFinishedEvent: unknown | null = null;
    // Task 2 / C1：exactly-once settlement gate。
    // complete / error 两条 RxJS 回调都会先 trySettle，只有第一次进入的那条会真正发出终态事件。
    // 这覆盖：upstream 连续发两个 terminal、success 后 error、error 后 success 等竞态。
    const settlementGate = new RunSettlementGate();
    let lifecycleEnded = false;
    const endLifecycle = (): void => {
      if (lifecycleEnded) return;
      lifecycleEnded = true;
      // Learn 模式：注销 Obsidian 工具
      if (mode === "learn") {
        try { unregisterObsidianTools(); } catch { /* ignore */ }
      }
      lifecycle?.onConversationEnded();
    };

    // <think> 标签过滤器：按单条 assistant message 隔离（TEXT_MESSAGE_START ~ END）
    // leading-only 模式：只在消息开头以 <think> 开头时才过滤，避免误删正文中的 <think> 讨论
    let thinkFilter: ThinkStreamFilter | null = null;
    let timePrefixFilter: ChatTimeStreamPrefixFilter | null = null;
    const thinkFilterMode: ThinkFilterMode = "leading-only";
    let pendingTextStart: { type: string; messageId?: string; [key: string]: unknown } | null = null;
    let textStartForwarded = false;
    let embeddedReasoningStarted = false;
    let embeddedReasoningMessageId = "";
    const forwardTextStart = (): void => {
      if (!pendingTextStart || textStartForwarded) return;
      textStartForwarded = true;
      send(pendingTextStart);
    };
    const forwardEmbeddedReasoning = (delta: string): void => {
      if (!delta) return;
      if (!embeddedReasoningStarted) {
        embeddedReasoningStarted = true;
        embeddedReasoningMessageId = `${pendingTextStart?.messageId ?? runId}-reasoning`;
        send({
          type: "REASONING_MESSAGE_START",
          messageId: embeddedReasoningMessageId,
          role: "reasoning",
          threadId,
          runId,
        });
      }
      send({
        type: "REASONING_MESSAGE_CONTENT",
        messageId: embeddedReasoningMessageId,
        delta,
        threadId,
        runId,
      });
    };
    const endEmbeddedReasoning = (): void => {
      if (!embeddedReasoningStarted) return;
      send({ type: "REASONING_MESSAGE_END", messageId: embeddedReasoningMessageId, threadId, runId });
      embeddedReasoningStarted = false;
    };

    // 订阅 agent 事件流：每个事件透传渲染端；
    // TEXT_MESSAGE_CONTENT 经 <think> 过滤后再转发；
    // complete/error 时做副作用，并补发一个终态事件让渲染端知道这轮结束。
    perf.mark("agent_run_start");
    const sub = agent.runWithEvents(options).subscribe({
      next: (baseEvent) => {
        const eventType = (baseEvent as { type?: string })?.type;

        // sticker / memory 等副作用在 complete 回调里执行。前端收到 RUN_FINISHED 后会收尾并取消监听，
        // 所以必须把 RUN_FINISHED 延后到副作用事件之后发送，否则 cyrene.sticker 会晚到而被丢掉。
        if (eventType === "RUN_FINISHED") {
          // 兜底清理：如果 filter 仍存在（TEXT_MESSAGE_END 缺失），销毁
          endEmbeddedReasoning();
          thinkFilter = null;
          timePrefixFilter = null;
          pendingTextStart = null;
          textStartForwarded = false;
          // Task 2 / C1：通过 settlement gate 保证 only-once terminal。
          // 如果 upstream 已经发过 RUN_FINISHED / RUN_ERROR（gate 已结算），丢弃后续重复事件。
          const terminal = extractTerminalFromRunFinished(baseEvent);
          if (!settlementGate.trySettle(terminal)) {
            return;
          }
          // Issue 2：runtime_error 必须走 RUN_ERROR，不缓存为 RUN_FINISHED。
          // complete 回调据此跳过成功收尾副作用；渲染端只收到 RUN_ERROR 作为终态。
          if (terminal.status === "runtime_error") {
            const reason = terminal.reason ?? "E_RUN_FAILURE";
            send({ type: "RUN_ERROR", message: reason, code: reason, threadId, runId });
            pendingRunFinishedEvent = null;
            return;
          }
          pendingRunFinishedEvent = baseEvent;
          return;
        }

        // <think> 过滤：拦截 TEXT_MESSAGE_* 事件
        if (eventType === "TEXT_MESSAGE_START") {
          thinkFilter = createThinkFilter(thinkFilterMode);
          timePrefixFilter = new ChatTimeStreamPrefixFilter();
          pendingTextStart = baseEvent as typeof pendingTextStart;
          textStartForwarded = false;
          embeddedReasoningStarted = false;
          embeddedReasoningMessageId = "";
          return;
        }

        if (eventType === "TEXT_MESSAGE_CONTENT") {
          if (!thinkFilter) {
            // 没有 START 边界（异常），原样转发
            send(baseEvent);
            return;
          }
          const event = baseEvent as { type: string; delta?: string };
          const rawDelta = typeof event.delta === "string" ? event.delta : "";
          const visibleDelta = timePrefixFilter?.push(thinkFilter.push(rawDelta)) ?? thinkFilter.push(rawDelta);
          forwardEmbeddedReasoning(thinkFilter.takeThinking());
          if (visibleDelta) {
            endEmbeddedReasoning();
            forwardTextStart();
            send({ ...event, delta: visibleDelta });
          }
          // visibleDelta 为空时跳过发送（不产生空 CONTENT 事件）
          return;
        }

        if (eventType === "TEXT_MESSAGE_END") {
          if (thinkFilter) {
            const tail = timePrefixFilter?.push(thinkFilter.flush()) ?? thinkFilter.flush();
            const timeTail = timePrefixFilter?.finish() ?? "";
            forwardEmbeddedReasoning(thinkFilter.takeThinking());
            if (tail || timeTail) {
              endEmbeddedReasoning();
              forwardTextStart();
              // flush 出的尾部文本作为最后一个 CONTENT 发送，确保在 END 之前到达
              send({ type: "TEXT_MESSAGE_CONTENT", delta: `${tail}${timeTail}`, threadId, runId });
            }
            thinkFilter = null;
            timePrefixFilter = null;
          }
          endEmbeddedReasoning();
          if (textStartForwarded) send(baseEvent);
          pendingTextStart = null;
          textStartForwarded = false;
          return;
        }

        // 其他事件原样透传
        send(baseEvent);
      },
      error: (err) => {
        endEmbeddedReasoning();
        thinkFilter = null; // 错误时丢弃残留 filter 状态
        pendingTextStart = null;
        textStartForwarded = false;
        let message = err instanceof Error ? err.message : String(err);
        // 安全兜底：确保不泄漏原始 DOMException / AbortError 文本
        if (!message || message.includes("This operation was aborted") || message.includes("AbortError")) {
          message = "操作已中断，请重试。";
        }
        console.error("[AgUiBridge] run 失败:", message);
        perf.dump();
        const code = err instanceof AgentRuntimeError ? err.code : undefined;
        // Task 2 / C1：runtime error 必须经过同一个 settlement gate。
        // 如果 upstream 已经发过 RUN_FINISHED（gate 已结算为 success / cancelled / timeout），
        // 这里直接丢弃 RUN_ERROR，避免渲染端收到第二终态。
        // pendingRunFinishedEvent 仍会在 complete 回调里发出（如果 complete 被调用）；
        // 若 complete 不会被调用（error 后 RxJS 不再调 complete），则下面兜底直接发 RUN_FINISHED。
        const errorTerminal: CyreneRunTerminalResult = {
          status: "runtime_error",
          reason: code ?? "E_RUN_FAILURE",
          externalEffectsMayContinue: true,
        };
        if (!settlementGate.trySettle(errorTerminal)) {
          // 已结算：检查是否需要补发缓存的 RUN_FINISHED。
          // 仅当 RUN_FINISHED 被 next 缓存但尚未发出（complete 未触发）时才补发。
          if (pendingRunFinishedEvent) {
            send(pendingRunFinishedEvent);
            pendingRunFinishedEvent = null;
          }
          activeRuns.delete(runId);
          endLifecycle();
          return;
        }
        // 补发 RUN_ERROR 事件，渲染端据此收尾（invoke 早已 resolve，靠事件驱动）
        send({ type: "RUN_ERROR", message, code, threadId, runId });
        activeRuns.delete(runId);
        endLifecycle();
      },
      complete: async () => {
        perf.mark("agent_run_complete");
        activeRuns.delete(runId);
        // Task 2 / C1：complete 路径下 settlement 应已由 next(RUN_FINISHED) 写入。
        // Issue 4：若 upstream 走裸 complete（没有 RUN_FINISHED），必须补发一个合成的 RUN_FINISHED，
        // 否则 renderer 收到零个终态事件，exactly-once 退化为 at-most-once。
        // 若已被 error 路径或 runtime_error RUN_FINISHED 结算，则保持该终态，不再补发。
        if (!settlementGate.isSettled()) {
          const synthesizedTerminal: CyreneRunTerminalResult = {
            status: "success",
            externalEffectsMayContinue: false,
          };
          settlementGate.trySettle(synthesizedTerminal);
          pendingRunFinishedEvent = {
            type: "RUN_FINISHED",
            threadId,
            runId,
            result: synthesizedTerminal,
          };
        }
        const settlement = settlementGate.get();
        const isSuccessfulCompletion = settlement?.status === "success";
        try {
          // Task 2 / C1：cancelled / timeout / runtime_error 不跑成功收尾副作用
          // （sticker / memory / learn-progress / 历史召回）。
          // 这些副作用假定 run 已经成功产出回复；其他终态不能保证有可用 finalAnswer。
          if (agent.lastResult && isSuccessfulCompletion) {
            const lastResult = agent.lastResult;
            const effects = await perf.track("on_run_finished", async () => onFinished(lastResult, latestUserText, sessionId));
            if (mode !== "code" && effects?.sticker !== undefined) {
              send({
                type: "CUSTOM",
                name: "cyrene.sticker",
                value: effects.sticker,
                threadId,
                runId,
              });
            }
            // 历史召回用：把这轮对话存入向量库（异步，不阻塞，失败不影响主流程）
            // 放在 onFinished 之后，确保记忆/sticker 等副作用先跑完
            void indexConversationTurn(
              input.sessionId || "default",
              latestUserText,
              lastResult.reply,
            );

            // Learn 模式：静默更新学习进度（异步，不阻塞，失败不影响主流程）
            if (mode === "learn" && obsidianWorkspace.isReady()) {
              const adapter = getAdapterForConfig({
                provider: options.settings.provider,
                baseUrl: options.settings.baseUrl,
                model: options.settings.model,
                apiKey: options.settings.apiKey,
              });
              void runLearnPostTurnHook({
                adapter,
                cfg: {
                  provider: options.settings.provider,
                  baseUrl: options.settings.baseUrl,
                  model: options.settings.model,
                  apiKey: options.settings.apiKey,
                },
                systemPrompt: options.soulSystemBaseContent ?? "",
                userMessage: latestUserText,
                assistantMessage: lastResult.reply,
              });
            }
          }
        } catch (err) {
          console.warn("[AgUiBridge] 副作用失败（不影响结果）:", err);
        }
        // Issue 2：runtime_error 已在 next 回调发过 RUN_ERROR，complete 不再补发终态事件。
        if (settlement?.status === "runtime_error") {
          pendingRunFinishedEvent = null;
        } else if (pendingRunFinishedEvent) {
          send(pendingRunFinishedEvent);
          pendingRunFinishedEvent = null;
        }
        endLifecycle();
        perf.dump();
      },
    });
    // Issue 7：同步 Observable 在 subscribe() 返回前可能已 complete 并 delete(runId)。
    // 若此时再无条件 set，会把已结算的 run 重新加入 map，留下幽灵 active run。
    // 仅在未结算（async、仍在运行）时才登记，供 cancel 取消用。
    if (!settlementGate.isSettled()) {
      activeRuns.set(runId, { subscription: sub, endLifecycle, abortController: runAbortController });
    }

    // invoke 立刻返回 ack，不等 Observable 结束。
    // 终态（RUN_FINISHED/RUN_ERROR）由事件流承载，渲染端据此 offEvent + 收尾。
    // 这样避免 invoke reply 与 send 事件的投递顺序竞争导致 offEvent 提前取消监听。
    return { success: true, runId };
  });

  ipcMain.handle(IPC.AGUI_CANCEL, (_event, runId?: string) => {
    // Task 3 / C2：通过 abort signal 触发 harness 的 cancelled 流程，
    // 而非粗暴 unsubscribe()。后者会阻止 RUN_FINISHED(result.status="cancelled")
    // 送达渲染端。abort() 让 harness 自然返回 cancelled → CyreneAgent 发出
    // RUN_FINISHED → complete 回调清理 activeRuns + endLifecycle。
    // 每个 run 持有独立 AbortController，cancel 一个 runId 绝不影响其他 run。
    const abortRun = (id: string): void => {
      const run = activeRuns.get(id);
      if (run && !run.abortController.signal.aborted) {
        run.abortController.abort();
      }
      // Task 3 / C2：清理该 run 关联的 pending permission / ask_user 卡片。
      // 渲染端通过 RUN_FINISHED(result.status="cancelled") 自然收到卡片关闭信号。
      cancelPendingChoicesForRun(id);
      cancelPendingApprovalsForRun(id);
    };
    if (runId) {
      abortRun(runId);
    } else {
      for (const id of [...activeRuns.keys()]) {
        abortRun(id);
      }
    }
    return true;
  });
}
