// AG-UI IPC 桥：把 CyreneAgent 的事件流透传给渲染进程。
//
// 架构：
//   渲染进程  ──invoke(AGUI_RUN, input)──>  本桥  ──>  CyreneAgent.runWithEvents()
//     ▲                                        │ 订阅 Observable<BaseEvent>
//     └── send(AGUI_EVENT, baseEvent) ─────────┘ 每个 AG-UI 事件转发给渲染进程
//
// Observable 是内存流、跨不过进程边界，所以必须这层桥：
// 主进程订阅 agent 的 events$，每个 BaseEvent 通过 webContents.send 推给渲染进程。
//
// 本桥只管"跑 agent + 转发事件 + 跑完后做副作用"。
// 上下文构建和副作用由调用方（index.ts）注入回调，保持本模块不依赖 index.ts 内部函数。
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
import { indexConversationTurn } from "./orchestrator/history-tools";
import type { RelationshipChannel } from "./relationship/relationship-log";
import { createThinkFilter, type ThinkStreamFilter, type ThinkFilterMode } from "./chat/think-filter";
import { perf } from "./perf-trace";
import type { StyleId } from "../shared/style-sampling";

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
  sessionId?: string;    // 会话 ID，用于历史召回按会话隔离（可选，默认 "default"）
  /** 外部渠道入口。桌面聊天不传；微信/飞书用于注入渠道语气规则。 */
  channel?: RelationshipChannel;
  /** 显式运行模式；桌面聊天始终显式传入。 */
  executionMode?: AgentExecutionMode | "soul-only" | "collaboration";
  /** 本轮附件（文本内容，临时注入系统上下文，不存历史）。 */
  attachments?: { name: string; text: string }[];
  /** 本轮图片附件。主进程会安全读取并转成 OpenAI-compatible image_url content block。 */
  imageAttachments?: { name: string; filePath: string; mime?: string }[];
}

/** 调用方（index.ts）注入：把输入转成 agent 需要的 options（含 system prompt 拼接）。 */
export type BuildOptionsFn = (input: AguiRunInput) => Promise<{
  options: CyreneRunOptions;
  /** 跑完后副作用需要的信息。 */
  latestUserText: string;
}>;

/** 调用方注入：agent 跑完后的副作用（记忆/sticker/表情/广播）。 */
export type OnRunFinishedFn = (result: CyreneRunResult, latestUserText: string) => Promise<void> | void;

/** 调用方注入：拿聊天窗口（广播副作用用，可空）。 */
export type GetChatWindowFn = () => { webContents: WebContents; isDestroyed(): boolean } | null;

export interface AguiConversationLifecycle {
  onUserMessage(): void;
  onConversationStarted(): void;
  onConversationEnded(): void;
}

/** 单次对话的活跃订阅（用于取消）。键 = runId。 */
const activeRuns = new Map<string, { subscription: Subscription; endLifecycle: () => void }>();

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
    let built;
    try {
      built = await perf.track("build_options", () => buildOptionsFn!(input));
    } catch (error) {
      perf.dump();
      lifecycle?.onConversationEnded();
      throw error;
    }
    const { options, latestUserText } = built;

    const threadId = `thread-${Date.now()}`;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agent = new CyreneAgent({ threadId, description: "Cyrene 主聊天" });

    // 事件转发目标：优先用 invoke 的 sender（发起 run 的窗口），兜底用聊天窗口
    const sender = event.sender;

    const send = (baseEvent: unknown): void => {
      const targets: WebContents[] = [];
      if (!sender.isDestroyed()) targets.push(sender);
      const chatWin = getChatWindowFn();
      if (chatWin && !chatWin.isDestroyed() && chatWin.webContents !== sender) {
        targets.push(chatWin.webContents);
      }
      for (const t of targets) {
        try {
          t.send(IPC.AGUI_EVENT, baseEvent);
        } catch (err) {
          console.error("[AgUiBridge] send 失败:", (err instanceof Error ? err.message : String(err)), "事件类型=", (baseEvent as { type?: string })?.type);
        }
      }
    };

    let pendingRunFinishedEvent: unknown | null = null;
    let lifecycleEnded = false;
    const endLifecycle = (): void => {
      if (lifecycleEnded) return;
      lifecycleEnded = true;
      lifecycle?.onConversationEnded();
    };

    // <think> 标签过滤器：按单条 assistant message 隔离（TEXT_MESSAGE_START ~ END）
    // leading-only 模式：只在消息开头以 <think> 开头时才过滤，避免误删正文中的 <think> 讨论
    let thinkFilter: ThinkStreamFilter | null = null;
    const thinkFilterMode: ThinkFilterMode = "leading-only";

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
          thinkFilter = null;
          pendingRunFinishedEvent = baseEvent;
          return;
        }

        // <think> 过滤：拦截 TEXT_MESSAGE_* 事件
        if (eventType === "TEXT_MESSAGE_START") {
          thinkFilter = createThinkFilter(thinkFilterMode);
          send(baseEvent);
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
          const visibleDelta = thinkFilter.push(rawDelta);
          if (visibleDelta) {
            send({ ...event, delta: visibleDelta });
          }
          // visibleDelta 为空时跳过发送（不产生空 CONTENT 事件）
          return;
        }

        if (eventType === "TEXT_MESSAGE_END") {
          if (thinkFilter) {
            const tail = thinkFilter.flush();
            if (tail) {
              // flush 出的尾部文本作为最后一个 CONTENT 发送，确保在 END 之前到达
              send({ type: "TEXT_MESSAGE_CONTENT", delta: tail, threadId, runId });
            }
            thinkFilter = null;
          }
          send(baseEvent);
          return;
        }

        // 其他事件原样透传
        send(baseEvent);
      },
      error: (err) => {
        thinkFilter = null; // 错误时丢弃残留 filter 状态
        let message = err instanceof Error ? err.message : String(err);
        // 安全兜底：确保不泄漏原始 DOMException / AbortError 文本
        if (!message || message.includes("This operation was aborted") || message.includes("AbortError")) {
          message = "操作已中断，请重试。";
        }
        console.error("[AgUiBridge] run 失败:", message);
        perf.dump();
        const code = err instanceof AgentRuntimeError ? err.code : undefined;
        // 补发 RUN_ERROR 事件，渲染端据此收尾（invoke 早已 resolve，靠事件驱动）
        send({ type: "RUN_ERROR", message, code, threadId, runId });
        activeRuns.delete(runId);
        endLifecycle();
      },
      complete: async () => {
        perf.mark("agent_run_complete");
        activeRuns.delete(runId);
        try {
          if (agent.lastResult) {
            const lastResult = agent.lastResult;
            await perf.track("on_run_finished", async () => { await onFinished(lastResult, latestUserText); });
            // 历史召回用：把这轮对话存入向量库（异步，不阻塞，失败不影响主流程）
            // 放在 onFinished 之后，确保记忆/sticker 等副作用先跑完
            void indexConversationTurn(
              input.sessionId || "default",
              latestUserText,
              lastResult.reply,
            );
          }
        } catch (err) {
          console.warn("[AgUiBridge] 副作用失败（不影响结果）:", err);
        }
        if (pendingRunFinishedEvent) {
          send(pendingRunFinishedEvent);
        }
        endLifecycle();
        perf.dump();
      },
    });
    activeRuns.set(runId, { subscription: sub, endLifecycle });

    // invoke 立刻返回 ack，不等 Observable 结束。
    // 终态（RUN_FINISHED/RUN_ERROR）由事件流承载，渲染端据此 offEvent + 收尾。
    // 这样避免 invoke reply 与 send 事件的投递顺序竞争导致 offEvent 提前取消监听。
    return { success: true, runId };
  });

  ipcMain.handle(IPC.AGUI_CANCEL, () => {
    for (const run of activeRuns.values()) {
      run.subscription.unsubscribe();
      run.endLifecycle();
    }
    activeRuns.clear();
    return true;
  });
}
