// 卡片提醒置顶浮窗管理器（通道 C）
// 创建/复用右下角无边框置顶小窗，加载独立渲染页 src/renderer/reminder/。
// 浮窗内「立即查看」→ 聚焦聊天窗口；「稍后」→ 关闭浮窗（卡片仍在聊天窗口内）。
// 60 秒无操作自动关闭，避免常驻遮挡工作区。

import { app, BrowserWindow, ipcMain, screen } from "electron";
import * as path from "path";
import { IPC, type ReminderPopupPayload } from "../../shared/ipc-channels";
import { isDev } from "../env";

// 浮窗自动关闭超时（毫秒）
const POPUP_AUTO_CLOSE_MS = 60_000;
// 浮窗宽高
const POPUP_WIDTH = 340;
const POPUP_HEIGHT = 150;
// 屏幕右下角边距
const POPUP_MARGIN = 16;

export interface ReminderPopupOptions {
  // 「立即查看」回调：聚焦聊天窗口（由 index.ts 注入 manager.createReactChatWindow）
  focusChatWindow: () => void;
}

export interface ReminderPopupManager {
  // 显示一条提醒（标题 + 正文），复用已有浮窗窗口
  show(payload: ReminderPopupPayload): void;
  // 主动关闭浮窗（卡片解决/超时/应用退出时调用）
  hide(): void;
  // 释放 IPC 监听并销毁窗口（应用退出时调用）
  dispose(): void;
}

/**
 * 创建卡片提醒浮窗管理器。
 * 返回 show/hide/dispose 三个方法，供 bootstrap 接线注入 card-reminder。
 */
export function createReminderPopupManager(
  options: ReminderPopupOptions,
): ReminderPopupManager {
  // 当前浮窗窗口（懒创建，show 时才建）
  let popupWindow: BrowserWindow | null = null;
  // 自动关闭定时器
  let autoCloseTimer: NodeJS.Timeout | null = null;
  // 页面尚未加载完成时的待发送负载（did-finish-load 后 flush）
  let pendingPayload: ReminderPopupPayload | null = null;

  // 清理自动关闭定时器
  function clearAutoClose(): void {
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  }

  // 把浮窗放到当前主显示器右下角
  function positionPopup(win: BrowserWindow): void {
    const { workArea } = screen.getPrimaryDisplay();
    const x = workArea.x + workArea.width - POPUP_WIDTH - POPUP_MARGIN;
    const y = workArea.y + workArea.height - POPUP_HEIGHT - POPUP_MARGIN;
    win.setPosition(Math.round(x), Math.round(y));
  }

  // 页面加载完成后 flush 待发送负载
  function flushPending(win: BrowserWindow): void {
    if (!pendingPayload || win.isDestroyed()) return;
    win.webContents.send(IPC.REMINDER_POPUP_SHOW, pendingPayload);
    pendingPayload = null;
    if (!win.isVisible()) win.show();
  }

  // 创建（或复用）浮窗窗口
  function ensureWindow(): BrowserWindow | null {
    if (popupWindow && !popupWindow.isDestroyed()) return popupWindow;

    const win = new BrowserWindow({
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 浮窗需要接收 IPC 并展示动画，关闭后台节流
        backgroundThrottling: false,
      },
    });
    popupWindow = win;

    positionPopup(win);

    if (isDev) {
      void win
        .loadURL("http://localhost:5173/reminder/")
        .catch((error) => console.error("[ReminderPopup] loadURL failed:", error));
    } else {
      void win
        .loadFile(path.join(app.getAppPath(), "dist", "renderer", "reminder", "index.html"))
        .catch((error) => console.error("[ReminderPopup] loadFile failed:", error));
    }

    // 页面加载完成后补发缓存负载，避免 show 早于订阅建立导致丢消息
    win.webContents.once("did-finish-load", () => flushPending(win));

    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.show();
    });

    win.on("closed", () => {
      if (popupWindow === win) popupWindow = null;
      clearAutoClose();
    });

    return win;
  }

  // 注册浮窗动作 IPC（立即查看 / 稍后）
  const handleAction = (_event: Electron.IpcMainEvent, action: "view" | "later"): void => {
    console.log("[ReminderPopup] 用户选择:", action);
    if (action === "view") {
      // 立即查看 → 聚焦聊天窗口后关闭浮窗（卡片仍在聊天窗口内）
      try {
        options.focusChatWindow();
      } catch (err) {
        console.warn("[ReminderPopup] focusChatWindow failed:", err);
      }
    }
    hide();
  };
  ipcMain.on(IPC.REMINDER_POPUP_ACTION, handleAction);

  function hide(): void {
    clearAutoClose();
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.hide();
    }
  }

  return {
    show(payload): void {
      const win = ensureWindow();
      if (!win) return;

      // 复位自动关闭定时器
      clearAutoClose();
      autoCloseTimer = setTimeout(() => {
        console.log("[ReminderPopup] 60 秒超时自动关闭");
        hide();
      }, POPUP_AUTO_CLOSE_MS);

      // 窗口位置始终对齐当前主显示器右下角
      positionPopup(win);

      // 页面仍在加载时缓存负载，did-finish-load 后补发
      if (win.webContents.isLoadingMainFrame() || win.webContents.isLoading()) {
        pendingPayload = payload;
        return;
      }
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.REMINDER_POPUP_SHOW, payload);
        if (!win.isVisible()) win.show();
      }
    },
    hide,
    dispose(): void {
      clearAutoClose();
      ipcMain.removeListener(IPC.REMINDER_POPUP_ACTION, handleAction);
      if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.destroy();
        popupWindow = null;
      }
    },
  };
}
