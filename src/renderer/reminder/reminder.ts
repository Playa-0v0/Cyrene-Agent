// 卡片提醒浮窗渲染端（通道 C）
// 订阅主进程 REMINDER_POPUP_SHOW 显示标题/正文；
// 「立即查看/稍后」通过 REMINDER_POPUP_ACTION 回传主进程（preload contextBridge 暴露）。
import type { ReminderPopupPayload } from "../../shared/ipc-channels";

// preload 暴露的 reminder API（contextBridge.exposeInMainWorld("reminder", ...)）
declare global {
  interface Window {
    reminder?: {
      onShow: (callback: (payload: ReminderPopupPayload) => void) => () => void;
      onHide: (callback: () => void) => () => void;
      action: (action: "view" | "later") => void;
    };
  }
}

// 获取页面元素（不存在时直接抛错，尽早暴露接线问题）
function getEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

// 标题 / 正文 / 两个按钮
const titleEl = getEl("reminder-title");
const bodyEl = getEl("reminder-body");
const viewBtn = getEl("reminder-view") as HTMLButtonElement;
const laterBtn = getEl("reminder-later") as HTMLButtonElement;

// 渲染提醒内容
function render(payload: ReminderPopupPayload): void {
  titleEl.textContent = payload.title;
  bodyEl.textContent = payload.message;
}

// 按钮点击 → 回传主进程（主进程决定聚焦聊天窗口或仅关闭浮窗）
viewBtn.addEventListener("click", () => window.reminder?.action("view"));
laterBtn.addEventListener("click", () => window.reminder?.action("later"));

// 订阅主进程的显示/关闭事件
window.reminder?.onShow(render);
window.reminder?.onHide(() => {
  // 主进程主动关闭浮窗（窗口隐藏即可，无需额外处理）
});
