// 卡片提醒多通道核心 —— 提问卡片（ask_user）与计划书审批卡提交时，
// 根据用户当前是否聚焦聊天窗口，选择提醒通道组合。
//
// 通道设计（本版无 TTS 语音链路）：
//   - 聊天窗口聚焦/全屏   → 仅应用内提示（不弹系统通知）
//   - 未聚焦（其他应用）  → C 置顶浮窗 + B 托盘气泡 + D 桌宠气泡 + 通知兜底
//   - 无聊天窗口          → C 浮窗 + B 托盘 + 通知兜底
// 连续提醒做 8s 节流，避免高频卡片刷屏。
//
// 依赖注入模式（仿 user-choice 的 callback 注入）：createCardReminder 的 deps
// 由 bootstrap-config 在启动时注入，避免直接 import electron/index.ts 造成循环依赖。

import type { BrowserWindow } from "electron";

/** 提醒类型：提问卡片 / 计划书审批卡。 */
export type CardReminderKind = "question" | "plan";

/** 提醒通道依赖（由启动注入）。 */
export interface CardReminderDeps {
  /** 获取当前聊天窗口（可为 null）。 */
  getChatWindow: () => BrowserWindow | null;
  /** 桌宠是否可见（隐藏时跳过 D 通道）。 */
  isPetVisible: () => boolean;
  /** 显示置顶浮窗。 */
  showReminderPopup: (payload: { kind: CardReminderKind; title: string; message: string }) => void;
  /** 隐藏置顶浮窗。 */
  hideReminderPopup: () => void;
  /** 托盘气泡（Windows displayBalloon）。 */
  showTrayBalloon: (title: string, body: string) => void;
  /** 通知兜底（打包模式 toast / dev 模式任务栏闪烁）。 */
  notify: (title: string, body: string) => void;
  /** 桌宠头顶气泡（D 通道）。 */
  showPetBubble: (text: string) => void;
}

/** 连续提醒节流间隔。 */
export const REMINDER_THROTTLE_MS = 8000;

/** 提醒文案。 */
export function reminderCopy(kind: CardReminderKind): { title: string; message: string; bubble: string } {
  if (kind === "plan") {
    return {
      title: "计划书待审批",
      message: "有一份新的实施计划等待你确认♪",
      bubble: "计划书来啦，要看看吗？",
    };
  }
  return {
    title: "提问卡片待处理",
    message: "有人正在等你做出选择哦♪",
    bubble: "有个问题需要你回答～",
  };
}

/** 判断聊天窗口是否聚焦/全屏（用户在看应用）。 */
export function isChatWindowActive(win: BrowserWindow | null): boolean {
  if (!win || win.isDestroyed()) return false;
  return win.isFocused() || win.isFullScreen();
}

/** 创建卡片提醒器。返回 (kind) => void 供 user-choice 注入。 */
export function createCardReminder(deps: CardReminderDeps): (kind: CardReminderKind) => void {
  let lastRemindAt = 0;

  return (kind: CardReminderKind): void => {
    const now = Date.now();
    if (now - lastRemindAt < REMINDER_THROTTLE_MS) {
      console.log("[CardReminder] 节流忽略提醒:", kind);
      return;
    }
    lastRemindAt = now;

    const copy = reminderCopy(kind);
    const win = deps.getChatWindow();

    // 聚焦/全屏 → 仅应用内提示（聊天窗口已可见，卡片本身在聊天窗口内展示）
    if (isChatWindowActive(win)) {
      console.log("[CardReminder] 聊天窗口聚焦，仅应用内提示:", kind);
      return;
    }

    // 未聚焦 → C + B + D + 通知兜底
    try {
      deps.showReminderPopup({ kind, title: copy.title, message: copy.message });
    } catch (error) {
      console.warn("[CardReminder] 浮窗通道失败:", error);
    }

    try {
      deps.showTrayBalloon(copy.title, copy.message);
    } catch (error) {
      console.warn("[CardReminder] 托盘气泡通道失败:", error);
    }

    try {
      if (deps.isPetVisible()) {
        deps.showPetBubble(copy.bubble);
      } else {
        console.log("[CardReminder] 桌宠隐藏，跳过 D 通道");
      }
    } catch (error) {
      console.warn("[CardReminder] 桌宠气泡通道失败:", error);
    }

    try {
      deps.notify(copy.title, copy.message);
    } catch (error) {
      console.warn("[CardReminder] 通知兜底失败:", error);
    }
  };
}
