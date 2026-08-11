import { app, BrowserWindow, screen } from "electron";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { isDev } from "../env";
import { computeLayout } from "../window-layout";
import { stopCall, setCallWindow } from "../call/call-manager";
import { attachExternalLinkHandler } from "./external-link";
import {
  callWindow,
  getCurrentAppIconPath,
  reactChatSession,
  reactChatWindow,
  setCallWindowLocal,
  setReactChatWindow,
  setSettingsWindow,
  setSidebarWindow,
  setStickerManagerWindow,
  setTasksWindow,
  settingsWindow,
  sidebarWindow,
  stickerManagerWindow,
  tasksWindow,
} from "./window-state";

/**
 * 创建/复用 React 聊天窗口。
 */
export function createReactChatWindow(sessionId?: string): void {
  // 已有窗口 → 复用；dispatcher 决定立即 send 还是等 ready 后 flush
  if (reactChatWindow && !reactChatWindow.isDestroyed()) {
    reactChatWindow.show();
    reactChatWindow.focus();
    if (sessionId) dispatchOrQueueReactSession(sessionId);
    return;
  }

  // 新建窗口：dispatcher 重置；URL 负责 cold start，pending 仅服务于"未 ready 期间又收到请求"
  reactChatSession.reset();

  const layout = computeLayout();
  const window = new BrowserWindow({
    x: layout.chat.x,
    y: layout.chat.y,
    width: 1280,
    height: 760,
    minWidth: 960,
    minHeight: 540,
    title: "Cyrene · 聊天",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setReactChatWindow(window);

  window.webContents.on("did-start-loading", () => {
    reactChatSession.markLoading();
  });

  // search 字段必须含前导 "?"（Electron url.format() 要求）
  const search = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : undefined;
  const indexPath = path.join(app.getAppPath(), "dist", "renderer", "react", "index.html");

  if (isDev) {
    void window
      .loadURL(`http://localhost:5173/react/${search ?? ""}`)
      .catch((error) => console.error("[ReactChatWindow] loadURL failed:", error));
  } else {
    void window
      .loadFile(indexPath, search ? { search } : undefined)
      .catch((error) => console.error("[ReactChatWindow] loadFile failed:", error));
  }

  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });

  window.on("closed", () => {
    // 闭包引用 + 仅当当前全局仍指向自己时才清理，避免旧窗口 closed 误清新窗口
    if (reactChatWindow === window) {
      setReactChatWindow(null);
      reactChatSession.reset();
    }
  });
}

export function dispatchOrQueueReactSession(sessionId: string): void {
  const win = reactChatWindow;
  if (!win?.webContents) return;
  const immediate = reactChatSession.queueOrTake(sessionId);
  if (immediate) {
    win.webContents.send(IPC.CHATS_REACT_SWITCH_SESSION, immediate);
  }
}

/**
 * 创建/复用侧边状态面板窗口。
 */
export function createSidebarWindow(): void {
  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    sidebarWindow.show();
    sidebarWindow.focus();
    return;
  }

  const layout = computeLayout();
  const window = new BrowserWindow({
    x: layout.sidebar.x,
    y: layout.sidebar.y,
    width: 320,
    height: 760,
    minWidth: 56,
    minHeight: 540,
    title: "昔涟 · 状态",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setSidebarWindow(window);

  if (isDev) {
    window.loadURL("http://localhost:5173/sidebar/");
  } else {
    window.loadFile(
      path.join(app.getAppPath(), "dist", "renderer", "sidebar", "index.html")
    );
  }

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("closed", () => {
    setSidebarWindow(null);
  });
}

/**
 * 创建/复用今日日程窗口。
 */
export function createTasksWindow(): void {
  if (tasksWindow && !tasksWindow.isDestroyed()) {
    tasksWindow.show();
    tasksWindow.focus();
    return;
  }

  const layout = computeLayout();
  const window = new BrowserWindow({
    x: layout.tasks.x,
    y: layout.tasks.y,
    width: 320,
    height: 760,
    minHeight: 540,
    title: "昔涟 · 今日日程",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setTasksWindow(window);

  if (isDev) {
    window.loadURL("http://localhost:5173/tasks/");
  } else {
    window.loadFile(
      path.join(app.getAppPath(), "dist", "renderer", "tasks", "index.html")
    );
  }

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("closed", () => {
    setTasksWindow(null);
  });
}

/**
 * 创建/复用设置窗口。
 */
export function createSettingsWindow(section?: string): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    // 窗口已存在：发事件让 settings 页切标签（loadURL 不会重新触发）
    if (section) {
      settingsWindow.webContents.send(IPC.SETTINGS_SWITCH_SECTION, section);
    }
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const width = 1060;
  const height = 920;
  const window = new BrowserWindow({
    x: dx + Math.max(0, Math.floor((dw - width) / 2)),
    y: dy + Math.max(0, Math.floor((dh - height) / 2)),
    width,
    height,
    minWidth: 920,
    minHeight: 580,
    title: "昔涟 · 设置",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setSettingsWindow(window);

  attachExternalLinkHandler(window);

  const hash = section ? `#${section}` : "";
  if (isDev) {
    window.loadURL("http://localhost:5173/settings/" + hash);
  } else {
    window.loadFile(
      path.join(app.getAppPath(), "dist", "renderer", "settings", "index.html"),
      { hash: section || "" }
    );
  }

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("closed", () => {
    setSettingsWindow(null);
  });
}

/**
 * 创建/复用表情包管理窗口。
 */
export async function createStickerManagerWindow(): Promise<{ ok: boolean; error?: string }> {
  if (stickerManagerWindow && !stickerManagerWindow.isDestroyed()) {
    stickerManagerWindow.show();
    stickerManagerWindow.focus();
    stickerManagerWindow.moveTop();
    return { ok: true };
  }

  const parentBounds = settingsWindow?.getBounds();
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const width = 520;
  const height = 420;
  const window = new BrowserWindow({
    x: parentBounds ? parentBounds.x + Math.max(24, Math.floor((parentBounds.width - width) / 2)) : dx + Math.max(0, Math.floor((dw - width) / 2)),
    y: parentBounds ? parentBounds.y + 64 : dy + Math.max(0, Math.floor((dh - height) / 2)),
    width,
    height,
    minWidth: 460,
    minHeight: 360,
    title: "表情包管理",
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    parent: settingsWindow ?? undefined,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setStickerManagerWindow(window);

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[stickers] did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  try {
    if (isDev) {
      await window.loadURL("http://localhost:5173/sticker-manager/");
    } else {
      await window.loadFile(
        path.join(app.getAppPath(), "dist", "renderer", "sticker-manager", "index.html")
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[stickers] failed to load sticker manager window", error);
    window.close();
    return { ok: false, error: message };
  }

  window.once("ready-to-show", () => {
    window.show();
    window.focus();
    window.moveTop();
  });

  window.on("closed", () => {
    setStickerManagerWindow(null);
  });

  return { ok: true };
}

/**
 * 创建/复用语音通话窗口（450×800 竖屏，语音通话）。
 */
export function createCallWindow(): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.show();
    callWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { width: dw, height: dh } = display.workArea;
  const CALL_W = 420;
  const CALL_H = 800;
  const cx = Math.max(0, Math.floor((dw - CALL_W) / 2));
  const cy = Math.max(0, Math.floor((dh - CALL_H) / 2));

  const window = new BrowserWindow({
    x: display.workArea.x + cx,
    y: display.workArea.y + cy,
    width: CALL_W,
    height: CALL_H,
    minWidth: 420,
    minHeight: 600,
    title: "Cyrene · 语音通话",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setCallWindowLocal(window);

  if (isDev) {
    window.loadURL("http://localhost:5173/call/");
  } else {
    window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "call", "index.html"));
  }

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("closed", () => {
    setCallWindowLocal(null);
    stopCall();
    setCallWindow(null);
  });

  // 绑定给 call-manager
  setCallWindow(window);
}

