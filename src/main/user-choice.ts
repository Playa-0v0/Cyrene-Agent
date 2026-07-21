// 用户选择往返机制 —— 仿 permission.ts 的 requestApproval 模式。
// 工具执行中调 requestUserChoice()，阻塞等待用户在聊天卡片里选一个选项。
//
// 数据流：
//   工具 execute → requestUserChoice() → 通过回调发 CUSTOM 事件给渲染端
//   → 渲染端显示选项卡片 → 用户点选项 → invoke(IPC.CHOICE_RESOLVE) 回传
//   → main 查 pending map → resolve Promise → 工具拿到用户选择继续执行
//
// 回调注入模式（仿 weatherCardCallback）：main/index.ts 启动时注入一个
// (cardData) => void 回调，user-choice.ts 持有它，工具调用时触发。
// 这样避免直接 import electron/index.ts 造成循环依赖。

import { ipcMain } from "electron";
import { IPC } from "../shared/ipc-channels";
import { getTimeoutSettings } from "./timeout-manager";

const LOG_PREFIX = "[UserChoice]";
const CHOICE_TIMEOUT_MS = 120_000; // 2 分钟超时，给用户足够思考时间

/** 选项结构。 */
export interface ChoiceOption {
  label: string;
  value: string;
  description?: string;
}

/** 发给渲染端的卡片数据。 */
export interface ChoiceCardData {
  id: string;
  question: string;
  options: ChoiceOption[];
  default?: string;
}

interface PendingChoice {
  resolve: (value: string) => void;
  timer: NodeJS.Timeout;
}

const pendingChoices = new Map<string, PendingChoice>();
let choiceCounter = 0;

/** 注入的卡片回调：由 index.ts 启动时设置，把 ChoiceCardData 包成 CUSTOM 事件发给渲染端。 */
let choiceCardSender: ((card: ChoiceCardData) => void) | null = null;

/** index.ts 启动时调用，注入卡片发送回调。 */
export function setChoiceCardSender(sender: (card: ChoiceCardData) => void): void {
  choiceCardSender = sender;
}

/**
 * 发起一次用户选择请求，阻塞等待用户在聊天卡片里选一个选项。
 * 超时（120s）返回 defaultValue 或空串。
 */
export function requestUserChoice(
  question: string,
  options: ChoiceOption[],
  defaultValue?: string,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const id = "choice-" + (++choiceCounter) + "-" + Date.now();
    const choiceTimeout = getTimeoutSettings().userChoiceTimeout;

    const timer = setTimeout(() => {
      pendingChoices.delete(id);
      console.warn(LOG_PREFIX, "选择超时（" + choiceTimeout + "ms），使用默认值:", defaultValue ?? "(空)");
      resolve(defaultValue ?? "");
    }, choiceTimeout);

    pendingChoices.set(id, { resolve, timer });

    const payload: ChoiceCardData = { id, question, options, default: defaultValue };
    console.log(LOG_PREFIX, "发送选择请求:", id, question);

    if (choiceCardSender) {
      choiceCardSender(payload);
    } else {
      // 没注入回调（理论上不会发生），直接返回默认值
      clearTimeout(timer);
      pendingChoices.delete(id);
      console.warn(LOG_PREFIX, "未注入卡片回调，使用默认值");
      resolve(defaultValue ?? "");
    }
  });
}

/** 注册 CHOICE_RESOLVE handler（main 启动时调一次）。 */
export function registerChoiceIpc(): void {
  ipcMain.handle(IPC.CHOICE_RESOLVE, (_event, payload: { id: string; value: string }) => {
    const pending = pendingChoices.get(payload?.id);
    if (!pending) {
      console.warn(LOG_PREFIX, "选择回传未匹配到 pending:", payload?.id);
      return { ok: false };
    }
    clearTimeout(pending.timer);
    pendingChoices.delete(payload.id);
    console.log(LOG_PREFIX, "用户选择:", payload.id, "→", payload.value);
    pending.resolve(payload.value);
    return { ok: true };
  });
}

