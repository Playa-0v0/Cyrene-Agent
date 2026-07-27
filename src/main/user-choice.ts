// 用戶選擇往返機制 —— 仿 permission.ts 的 requestApproval 模式。
// 工具執行中調 requestUserChoice()，阻塞等待用戶在聊天卡片裡選一個選項。
//
// 數據流：
//   工具 execute → requestUserChoice() → 通過回調發 CUSTOM 事件給渲染端
//   → 渲染端顯示選項卡片 → 用戶點選項 → invoke(IPC.CHOICE_RESOLVE) 回傳
//   → main 查 pending map → resolve Promise → 工具拿到用戶選擇繼續執行
//
// 回調注入模式（仿 weatherCardCallback）：main/index.ts 啟動時注入一個
// (cardData) => void 回調，user-choice.ts 持有它，工具調用時觸發。
// 這樣避免直接 import electron/index.ts 造成循環依賴。

import { ipcMain } from "electron";
import { IPC } from "../shared/ipc-channels";

const LOG_PREFIX = "[UserChoice]";
const CHOICE_TIMEOUT_MS = 120_000; // 2 分鐘超時，給用戶足夠思考時間

/** 選項結構。 */
export interface ChoiceOption {
  label: string;
  value: string;
  description?: string;
}

/** 發給渲染端的卡片數據。 */
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

/** 注入的卡片回調：由 index.ts 啟動時設置，把 ChoiceCardData 包成 CUSTOM 事件發給渲染端。 */
let choiceCardSender: ((card: ChoiceCardData) => void) | null = null;

/** index.ts 啟動時調用，注入卡片發送回調。 */
export function setChoiceCardSender(sender: (card: ChoiceCardData) => void): void {
  choiceCardSender = sender;
}

/**
 * 發起一次用戶選擇請求，阻塞等待用戶在聊天卡片裡選一個選項。
 * 超時（120s）返回 defaultValue 或空串。
 */
export function requestUserChoice(
  question: string,
  options: ChoiceOption[],
  defaultValue?: string,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const id = "choice-" + (++choiceCounter) + "-" + Date.now();

    const timer = setTimeout(() => {
      pendingChoices.delete(id);
      console.warn(LOG_PREFIX, "選擇超時（" + CHOICE_TIMEOUT_MS + "ms），使用默認值:", defaultValue ?? "(空)");
      resolve(defaultValue ?? "");
    }, CHOICE_TIMEOUT_MS);

    pendingChoices.set(id, { resolve, timer });

    const payload: ChoiceCardData = { id, question, options, default: defaultValue };
    console.log(LOG_PREFIX, "發送選擇請求:", id, question);

    if (choiceCardSender) {
      choiceCardSender(payload);
    } else {
      // 沒注入回調（理論上不會發生），直接返回默認值
      clearTimeout(timer);
      pendingChoices.delete(id);
      console.warn(LOG_PREFIX, "未注入卡片回調，使用默認值");
      resolve(defaultValue ?? "");
    }
  });
}

/** 註冊 CHOICE_RESOLVE handler（main 啟動時調一次）。 */
export function registerChoiceIpc(): void {
  ipcMain.handle(IPC.CHOICE_RESOLVE, (_event, payload: { id: string; value: string }) => {
    const pending = pendingChoices.get(payload?.id);
    if (!pending) {
      console.warn(LOG_PREFIX, "選擇回傳未匹配到 pending:", payload?.id);
      return { ok: false };
    }
    clearTimeout(pending.timer);
    pendingChoices.delete(payload.id);
    console.log(LOG_PREFIX, "用戶選擇:", payload.id, "→", payload.value);
    pending.resolve(payload.value);
    return { ok: true };
  });
}

