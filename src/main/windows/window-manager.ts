import { BrowserWindow, screen, type NativeImage } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createMainWindow, PET_WINDOW_BASE_HEIGHT, PET_WINDOW_BASE_WIDTH, type MainWindowSettingsSlice } from "../startup/create-main-window";
import {
  createCallWindow,
  createReactChatWindow,
  createSettingsWindow,
  createSidebarWindow,
  createStickerManagerWindow,
  createTasksWindow,
} from "./create-aux-windows";
import { createMusicPlayerWindow } from "./create-music-player-window";
import { broadcastToAllWindows } from "./broadcast";
import { PetWindowMoveController } from "../pet-window-movement";

export interface WindowManagerOptions {
  getCurrentAppIconPath: () => string;
  isDev: boolean;
  loadMainWindowSettingsSlice: () => MainWindowSettingsSlice;
  persistMainWindowPosition: (position: { x: number; y: number }) => void;
}

export interface WindowManager {
  createMainWindow(showOnReady?: boolean): BrowserWindow;
  createReactChatWindow(sessionId?: string): void;
  createSidebarWindow(): void;
  createSettingsWindow(section?: string): void;
  createTasksWindow(): void;
  createStickerManagerWindow(): void;
  createCallWindow(): void;
  createMusicPlayerWindow(): void;

  showMainWindow(): void;
  hideMainWindow(): void;
  toggleMainWindow(): void;
  minimizeMainWindow(): void;
  setMainWindowAlwaysOnTop(alwaysOnTop: boolean): void;
  setMainWindowInteractive(interactive: boolean): void;
  setMainWindowDragging(isDragging: boolean): void;
  moveMainWindowRelative(dx: number, dy: number): void;
  moveMainWindowTo(x: number, y: number): void;
  applyMainWindowZoom(zoom: number): void;
  captureMainWindowFrame(): Promise<string | null>;
  captureMainWindow(): Promise<Electron.NativeImage | null>;
  getCursorScreenPosition(): { x: number; y: number };
  setIconForAllWindows(icon: NativeImage): void;
  sendToMainWindow(channel: string, payload?: unknown): void;
  broadcast(channel: string, payload: unknown): void;

  onMainWindowReady(handler: (win: BrowserWindow) => void): void;
  onMainWindowClosed(handler: () => void): void;
  onMainWindowMoved(handler: (position: { x: number; y: number }) => void): void;

  dispose(): void;
}

export function createWindowManager(options: WindowManagerOptions): WindowManager {
  let mainWindow: BrowserWindow | null = null;
  const readyHandlers: Array<(win: BrowserWindow) => void> = [];
  const closedHandlers: Array<() => void> = [];
  const movedHandlers: Array<(position: { x: number; y: number }) => void> = [];

  const petWindowMoveController = new PetWindowMoveController(
    () => mainWindow,
    (position) => {
      options.persistMainWindowPosition(position);
    },
  );

  function getUsableMainWindow(): BrowserWindow | null {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    return mainWindow;
  }

  function setMainWindow(window: BrowserWindow, showOnReady = true): void {
    mainWindow = window;
    window.once("ready-to-show", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (showOnReady) {
        mainWindow.show();
      }
      for (const handler of readyHandlers) {
        try { handler(mainWindow); } catch (err) { console.error("[WindowManager] ready handler failed:", err); }
      }
    });
    window.on("closed", () => {
      petWindowMoveController.dispose();
      mainWindow = null;
      for (const handler of closedHandlers) {
        try { handler(); } catch (err) { console.error("[WindowManager] closed handler failed:", err); }
      }
    });
    window.on("moved", () => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      try {
        const [x, y] = win.getPosition();
        for (const handler of movedHandlers) {
          try { handler({ x, y }); } catch (err) { console.error("[WindowManager] moved handler failed:", err); }
        }
      } catch {
        // ignore
      }
    });
  }

  return {
    createMainWindow(showOnReady = true): BrowserWindow {
      if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
      const win = createMainWindow(
        {
          getCurrentAppIconPath: options.getCurrentAppIconPath,
          isDev: options.isDev,
          loadGeneralSettings: options.loadMainWindowSettingsSlice,
        },
        { showOnReady },
      );
      setMainWindow(win, showOnReady);
      return win;
    },

    createReactChatWindow,
    createSidebarWindow,
    createSettingsWindow,
    createTasksWindow,
    createStickerManagerWindow,
    createCallWindow,
    createMusicPlayerWindow,

    showMainWindow(): void {
      getUsableMainWindow()?.show();
    },
    hideMainWindow(): void {
      getUsableMainWindow()?.hide();
    },
    toggleMainWindow(): void {
      const win = getUsableMainWindow();
      if (!win) return;
      win.isVisible() ? win.hide() : win.show();
    },
    minimizeMainWindow(): void {
      getUsableMainWindow()?.minimize();
    },
    setMainWindowAlwaysOnTop(alwaysOnTop: boolean): void {
      const win = getUsableMainWindow();
      if (!win) return;
      win.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? "screen-saver" : "normal");
    },
    setMainWindowInteractive(interactive: boolean): void {
      const win = getUsableMainWindow();
      if (!win) return;
      win.setIgnoreMouseEvents(!interactive, { forward: true });
    },
    setMainWindowDragging(isDragging: boolean): void {
      const win = getUsableMainWindow();
      if (!win) return;
      if (!isDragging) petWindowMoveController.finishDragging();
      try {
        win.setOpacity(isDragging ? 0.99 : 1.0);
      } catch (error) {
        console.warn("[WindowManager] Failed to update pet window dragging opacity:", error);
      }
    },
    moveMainWindowRelative(dx: number, dy: number): void {
      petWindowMoveController.moveRelative(dx, dy);
    },
    moveMainWindowTo(x: number, y: number): void {
      petWindowMoveController.queueAbsolute(x, y);
    },
    applyMainWindowZoom(zoom: number): void {
      const win = getUsableMainWindow();
      if (!win) return;
      const width = Math.round(PET_WINDOW_BASE_WIDTH * zoom);
      const height = Math.round(PET_WINDOW_BASE_HEIGHT * zoom);
      win.setSize(width, height);
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.PET_ZOOM, zoom);
      }
    },
    async captureMainWindowFrame(): Promise<string | null> {
      const image = await this.captureMainWindow();
      return image ? image.toDataURL() : null;
    },
    async captureMainWindow(): Promise<Electron.NativeImage | null> {
      const win = getUsableMainWindow();
      if (!win) return null;
      try {
        return await win.webContents.capturePage();
      } catch (err) {
        console.error("[WindowManager] captureMainWindow failed:", err);
        return null;
      }
    },
    getCursorScreenPosition(): { x: number; y: number } {
      return screen.getCursorScreenPoint();
    },
    setIconForAllWindows(icon: NativeImage): void {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setIcon(icon);
      }
    },
    sendToMainWindow(channel: string, payload?: unknown): void {
      const win = getUsableMainWindow();
      if (!win) return;
      if (payload === undefined) win.webContents.send(channel);
      else win.webContents.send(channel, payload);
    },
    broadcast(channel: string, payload: unknown): void {
      broadcastToAllWindows(channel, payload);
    },

    onMainWindowReady(handler: (win: BrowserWindow) => void): void {
      readyHandlers.push(handler);
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        try { handler(mainWindow); } catch (err) { console.error("[WindowManager] ready handler failed:", err); }
      }
    },
    onMainWindowClosed(handler: () => void): void {
      closedHandlers.push(handler);
    },
    onMainWindowMoved(handler: (position: { x: number; y: number }) => void): void {
      movedHandlers.push(handler);
    },

    dispose(): void {
      petWindowMoveController.dispose();
    },
  };
}
