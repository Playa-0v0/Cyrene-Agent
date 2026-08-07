// AG-UI IPC 橋：把 CyreneAgent 的事件流透傳給渲染進程。
//
// 架構：
//   渲染進程  ──invoke(AGUI_RUN, input)──>  本橋  ──>  CyreneAgent.runWithEvents()
//     ▲                                        │ 訂閱 Observable<BaseEvent>
//     └── send(AGUI_EVENT, baseEvent) ─────────┘ 每個 AG-UI 事件轉發給渲染進程
//
// Observable 是內存流、跨不過進程邊界，所以必須這層橋：
// 主進程訂閱 agent 的 events$，每個 BaseEvent 通過 webContents.send 推給渲染進程。
//
// 本橋只管"跑 agent + 轉發事件 + 跑完後做副作用"。
// 上下文構建和副作用由調用方（index.ts）注入回調，保持本模塊不依賴 index.ts 內部函數。
import { ipcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { IPC } from "../shared/ipc-channels";
import { Subscription } from "rxjs";
import {
  CyreneAgent,
  type CyreneRunOptions,
  type CyreneRunResult,
} from "./orchestrator/cyrene-agent";
import { indexConversationTurn } from "./orchestrator/history-tools";
import { appendConversationEntry } from "./memory/conversation-archive";
import type { RelationshipChannel } from "./relationship/relationship-log";

/** 渲染進程發起 run 時傳的輸入。 */
export interface AguiRunInput {
  messages: unknown[];   // 原始 {role, content}[]，主進程會 normalize
  style: string;         // 人格 style 文件名
  sessionId?: string;    // 會話 ID，用於歷史召回按會話隔離（可選，默認 "default"）
  /** 外部渠道入口。桌面聊天不傳；微信/飛書用於注入渠道語氣規則。 */
  channel?: RelationshipChannel;
  /** 本輪附件；圖片只在主進程臨時辨識，不存入聊天歷史。 */
  attachments?: Array<{
    name: string;
    kind?: "text" | "image";
    text?: string;
    filePath?: string;
    mime?: string;
  }>;
}

/** 調用方（index.ts）注入：把輸入轉成 agent 需要的 options（含 system prompt 拼接）。 */
export type BuildOptionsFn = (input: AguiRunInput) => Promise<{
  options: CyreneRunOptions;
  /** 跑完後副作用需要的信息。 */
  latestUserText: string;
}>;

/** 調用方注入：agent 跑完後的副作用（記憶/sticker/表情/廣播）。 */
export type OnRunFinishedFn = (result: CyreneRunResult, latestUserText: string) => Promise<void> | void;

/** 調用方注入：拿聊天窗口（廣播副作用用，可空）。 */
export type GetChatWindowFn = () => { webContents: WebContents; isDestroyed(): boolean } | null;

/** 單次對話的活躍訂閱（用於取消）。鍵 = runId。 */
const activeRuns = new Map<string, Subscription>();

let buildOptionsFn: BuildOptionsFn | null = null;
let getChatWindowFn: GetChatWindowFn = () => null;

/**
 * 註冊 AG-UI IPC。由 index.ts 在 app.whenReady() 調一次。
 *
 * @param buildOptions 把渲染進程輸入轉成 agent options（含上下文構建）
 * @param onRunFinished agent 跑完的副作用（記憶/sticker 等）
 * @param getChatWindow 聊天窗口（事件要發到這裡）
 */
export function registerAgUiIpc(
  buildOptions: BuildOptionsFn,
  onRunFinished: OnRunFinishedFn,
  getChatWindow: GetChatWindowFn,
): void {
  buildOptionsFn = buildOptions;
  getChatWindowFn = getChatWindow;

  const onFinished = onRunFinished;
  ipcMain.handle(IPC.AGUI_RUN, async (event: IpcMainInvokeEvent, rawInput: unknown) => {
    if (!buildOptionsFn || !onFinished) {
      throw new Error("AG-UI 橋未初始化");
    }
    const input = rawInput as AguiRunInput;
    const { options, latestUserText } = await buildOptionsFn(input);

    const threadId = `thread-${Date.now()}`;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const archiveTurnId = `desktop:${input.sessionId || "default"}:${runId}`;
    // 先存用戶原話再發模型；即使模型失敗或應用中途關閉，這句也不會消失。
    appendConversationEntry({
      id: `${archiveTurnId}:user`,
      sessionId: input.sessionId || "default",
      channel: input.channel || "desktop",
      role: "user",
      content: latestUserText,
      at: Date.now(),
    });
    const agent = new CyreneAgent({ threadId, description: "Cyrene 主聊天" });

    // 事件轉發目標：優先用 invoke 的 sender（發起 run 的窗口），兜底用聊天窗口
    const sender = event.sender;

    const send = (baseEvent: unknown): void => {
      // 1. 優先發送給觸發的具體子 frame (例如 iframe)
      if (event.senderFrame && !event.senderFrame.isDestroyed()) {
        try {
          event.senderFrame.send(IPC.AGUI_EVENT, baseEvent);
        } catch (err) {
          console.error("[AgUiBridge] send to senderFrame failed:", err);
        }
      }

      // 2. 廣播給所有相關窗口及其子 frame
      const targets: WebContents[] = [];
      if (!sender.isDestroyed()) targets.push(sender);
      const chatWin = getChatWindowFn();
      if (chatWin && !chatWin.isDestroyed() && chatWin.webContents !== sender) {
        targets.push(chatWin.webContents);
      }

      for (const t of targets) {
        try {
          t.send(IPC.AGUI_EVENT, baseEvent);
          // 廣播到所有子 frame (以防 iframe 嵌入，且避免與前面的 senderFrame 重複發送)
          const sendToFrame = (frame: any) => {
            if (!frame.isDestroyed()) {
              if (frame !== event.senderFrame) {
                try { frame.send(IPC.AGUI_EVENT, baseEvent); } catch { /* ignore */ }
              }
              for (const sub of frame.frames) {
                sendToFrame(sub);
              }
            }
          };
          for (const frame of t.mainFrame.frames) {
            sendToFrame(frame);
          }
        } catch (err) {
          console.error("[AgUiBridge] send to webcontents failed:", err);
        }
      }
    };

    let pendingRunFinishedEvent: unknown | null = null;

    // 訂閱 agent 事件流：每個事件透傳渲染端；
    // complete/error 時做副作用，並補發一個終態事件讓渲染端知道這輪結束。
    const sub = agent.runWithEvents(options).subscribe({
      next: (baseEvent) => {
        // sticker / memory 等副作用在 complete 回調裡執行。前端收到 RUN_FINISHED 後會收尾並取消監聽，
        // 所以必須把 RUN_FINISHED 延後到副作用事件之後發送，否則 cyrene.sticker 會晚到而被丟掉。
        if ((baseEvent as { type?: string })?.type === "RUN_FINISHED") {
          pendingRunFinishedEvent = baseEvent;
          return;
        }
        send(baseEvent);
      },
      error: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[AgUiBridge] run 失敗:", message);
        // 補發 RUN_ERROR 事件，渲染端據此收尾（invoke 早已 resolve，靠事件驅動）
        send({ type: "RUN_ERROR", error: message, threadId, runId });
        activeRuns.delete(runId);
      },
      complete: async () => {
        activeRuns.delete(runId);
        try {
          if (agent.lastResult) {
            await onFinished(agent.lastResult, latestUserText);
            // 歷史召回用：把這輪對話存入向量庫（異步，不阻塞，失敗不影響主流程）
            // 放在 onFinished 之後，確保記憶/sticker 等副作用先跑完
            void indexConversationTurn(
              input.sessionId || "default",
              latestUserText,
              agent.lastResult.reply,
              { channel: input.channel || "desktop", turnId: archiveTurnId },
            );
          }
        } catch (err) {
          console.warn("[AgUiBridge] 副作用失敗（不影響結果）:", err);
        }
        if (pendingRunFinishedEvent) {
          send(pendingRunFinishedEvent);
        }
      },
    });
    activeRuns.set(runId, sub);

    // invoke 立刻返回 ack，不等 Observable 結束。
    // 終態（RUN_FINISHED/RUN_ERROR）由事件流承載，渲染端據此 offEvent + 收尾。
    // 這樣避免 invoke reply 與 send 事件的投遞順序競爭導致 offEvent 提前取消監聽。
    return { success: true, runId };
  });

  ipcMain.handle(IPC.AGUI_CANCEL, () => {
    for (const sub of activeRuns.values()) {
      sub.unsubscribe();
    }
    activeRuns.clear();
    return true;
  });
}
